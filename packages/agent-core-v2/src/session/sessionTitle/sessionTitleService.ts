import {
  KIMI_CODE_PROVIDER_NAME,
  OAuthError,
  fetchChatTitle,
  kimiCodeToolsUrl,
  parseKimiCodeCustomHeaders,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';

import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { SessionTitleGenerationFinishedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { createUserMessage } from '#human/llm/message';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { generateModel, type ModelRequestParams } from '#/llm-adapter/model/generate';
import type { ThinkingEffort } from '#human/llm-requester/thinking';
import { IHostRequestHeaders } from '#/llm-adapter/model/host-request-headers';
import { IProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocol';
import { IProviderService } from '#/llm-adapter/provider/provider';
import { isOAuthCatalogVendor } from '#/llm-adapter/provider/provider-definition';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { ISessionTitleService, type SessionTitleSource } from './sessionTitle';
import { TITLE_SYSTEM_PROMPT } from './titlePrompt';

const MAX_GENERATED_TITLE_LENGTH = 200;

const TITLE_FALLBACK_TIMEOUT_MS = 20000;

const TITLE_MAX_COMPLETION_TOKENS = 1024;

const TITLE_RESPONSE_FORMAT = {
  type: 'json_schema',
  jsonSchema: {
    name: 'session_title',
    schema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
} as const;

const MAX_TITLE_INPUT_LENGTH = 1000;

const MAX_TITLE_PROMPTS = 3;

const MAX_TITLE_USER_SEGMENT = 400;

const MAX_TITLE_FIRST_TURN_ASSISTANT = 300;

const MAX_TITLE_DIGEST_USER_SEGMENT = 200;

const MAX_TITLE_DIGEST_ASSISTANT = 200;

const MAX_TITLE_DIGEST_INPUT_LENGTH = 3000;

type TitleGenerationResult =
  | { title: string; outcome: 'ok' | 'truncated' }
  | { title?: undefined; reason: NonNullable<SessionTitleGenerationFinishedEvent['reason']> };

export class SessionTitleService implements ISessionTitleService {
  declare readonly _serviceBrand: undefined;

  private _shared: Promise<string | undefined> | undefined;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IAgentLifecycleService private readonly agentLifecycle: IAgentLifecycleService,
    @IEventService private readonly eventService: IEventService,
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IHostRequestHeaders private readonly hostHeaders: IHostRequestHeaders,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IProtocolAdapterRegistry private readonly protocolRegistry: IProtocolAdapterRegistry,
    @ILogService private readonly log: ILogService,
  ) {}

  async generateTitle(opts?: {
    force?: boolean;
    source?: SessionTitleSource;
  }): Promise<string | undefined> {
    const force = opts?.force === true;
    const source = opts?.source ?? 'user_prompts';
    if (force) return this.trackGeneration(true, source);
    if (this._shared !== undefined) return this._shared;
    const tracked = this.trackGeneration(false, source).finally(() => {
      if (this._shared === tracked) this._shared = undefined;
    });
    this._shared = tracked;
    return tracked;
  }

  private async trackGeneration(
    force: boolean,
    source: SessionTitleSource,
  ): Promise<string | undefined> {
    const startedAt = Date.now();
    const trigger = force ? 'manual' : 'auto';
    const track = (
      result: Omit<SessionTitleGenerationFinishedEvent, 'duration_ms' | 'trigger' | 'source'>,
    ): void => {
      this.telemetry.track2('session_title_generation_finished', {
        ...result,
        trigger,
        source,
        duration_ms: Date.now() - startedAt,
      });
    };
    try {
      const result = await this.generateTitleOnce(force, source);
      if (result?.title !== undefined) {
        track({
          outcome: 'success',
          title_chars: result.title.length,
          title_outcome: result.outcome,
        });
      } else if (result !== undefined) {
        track({ outcome: 'unavailable', reason: result.reason });
      }
      return result?.title;
    } catch (error) {
      track({
        outcome: 'error',
        reason: 'unexpected',
        error_type: error instanceof Error ? error.name : 'Unknown',
      });
      throw error;
    }
  }

  private async generateTitleOnce(
    force: boolean,
    source: SessionTitleSource,
  ): Promise<TitleGenerationResult | undefined> {
    const current = await this.metadata.read();
    if (!force) {
      if (current.titleKind === 'custom' || current.titleKind === 'generated') return undefined;
    }
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) return { reason: 'no_agent' };
    const promptSource = main.accessor.get(IAgentTitlePromptSource);
    const input = await composeTitleInput(promptSource, source);
    if (input === undefined) return { reason: 'no_input' };
    return this.generateAndApply(input, force, main);
  }

  private async generateAndApply(
    chatContent: string,
    force: boolean,
    main: IAgentScopeHandle,
  ): Promise<TitleGenerationResult> {
    const current = await this.metadata.read();
    if (!force && current.titleKind === 'custom') return { reason: 'custom_title' };
    const requested = await this.requestTitle(chatContent, main);
    if ('reason' in requested) return requested;
    const title = requested.rawTitle.slice(0, MAX_GENERATED_TITLE_LENGTH);
    const applied = await this.metadata.setGeneratedTitleIfUncustomized(title, { force });
    if (!applied) return { reason: 'custom_title' };
    this.eventService.publish(
      new SessionMetaUpdated({
        payload: {
          agentId: 'main',
          sessionId: this.ctx.sessionId,
          title,
          patch: { title, isCustomTitle: false },
        },
      }),
    );
    return {
      title,
      outcome: requested.rawTitle.length > MAX_GENERATED_TITLE_LENGTH ? 'truncated' : 'ok',
    };
  }

  private async requestTitle(
    chatContent: string,
    main: IAgentScopeHandle,
  ): Promise<
    | { rawTitle: string }
    | { reason: NonNullable<SessionTitleGenerationFinishedEvent['reason']> }
  > {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (
      provider === undefined ||
      !isOAuthCatalogVendor(provider.type) ||
      provider.oauth === undefined
    ) {
      return this.generateTitleViaModel(chatContent, main, 'provider_unavailable');
    }
    const runtimeAuth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider.baseUrl,
      configuredOAuthRef: provider.oauth,
    });
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      runtimeAuth.oauthRef,
    );
    if (tokenProvider === undefined) {
      return this.generateTitleViaModel(chatContent, main, 'token_unavailable');
    }
    let token: string;
    try {
      token = await tokenProvider.getAccessToken();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      this.log.debug(`chat_title request unavailable: ${error.message}`);
      return this.generateTitleViaModel(chatContent, main, 'oauth_unavailable');
    }
    const requestTitle = (accessToken: string) =>
      fetchChatTitle(kimiCodeToolsUrl(runtimeAuth.baseUrl), accessToken, chatContent, {
        headers: {
          ...parseKimiCodeCustomHeaders(),
          ...this.hostHeaders.headers,
          ...provider.customHeaders,
        },
      });
    let result = await requestTitle(token);
    if (result.kind === 'error' && result.status === 401) {
      try {
        token = await tokenProvider.getAccessToken({ force: true });
      } catch (error) {
        if (!(error instanceof OAuthError)) throw error;
        this.log.debug(`chat_title request unavailable: ${error.message}`);
        return this.generateTitleViaModel(chatContent, main, 'oauth_unavailable');
      }
      result = await requestTitle(token);
    }
    if (result.kind !== 'ok') {
      this.log.debug(`chat_title request failed: ${result.message}`);
      return { reason: 'request_failed' };
    }
    return { rawTitle: result.title };
  }

  private async generateTitleViaModel(
    chatContent: string,
    main: IAgentScopeHandle,
    unavailableReason: NonNullable<SessionTitleGenerationFinishedEvent['reason']>,
  ): Promise<
    | { rawTitle: string }
    | { reason: NonNullable<SessionTitleGenerationFinishedEvent['reason']> }
  > {
    const modelId = main.accessor.get(IAgentProfileService).getModel();
    if (modelId.length === 0) return { reason: unavailableReason };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TITLE_FALLBACK_TIMEOUT_MS);
    try {
      const model = this.modelCatalog.get(modelId);
      const params: ModelRequestParams = {
        stream: false,
        thinkingEffort: titleThinkingEffort(model),
        maxCompletionTokens: TITLE_MAX_COMPLETION_TOKENS,
      };
      let text = '';
      for await (const event of generateModel(
        this.protocolRegistry.request(model, params),
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          tools: [],
          messages: [createUserMessage(`<session>\n${chatContent}\n</session>`)],
          responseFormat:
            model.protocol === 'anthropic' ? TITLE_RESPONSE_FORMAT : { type: 'json_object' },
        },
        controller.signal,
        params,
      )) {
        if (event.type === 'part' && event.part.type === 'text') text += event.part.text;
      }
      const rawTitle = normalizeModelTitle(text);
      if (rawTitle === undefined) return { reason: 'request_failed' };
      return { rawTitle };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug(`session title model request failed: ${message}`);
      return { reason: 'request_failed' };
    } finally {
      clearTimeout(timer);
    }
  }
}

function titleInputFromPrompts(prompts: readonly string[]): string | undefined {
  if (prompts.length === 0) return undefined;
  return prompts
    .map((prompt) => `user: ${prompt.slice(0, MAX_TITLE_USER_SEGMENT)}`)
    .join('\n')
    .slice(0, MAX_TITLE_INPUT_LENGTH);
}

async function composeTitleInput(
  promptSource: IAgentTitlePromptSource,
  source: SessionTitleSource,
): Promise<string | undefined> {
  if (source === 'first_turn') {
    const excerpt = await promptSource.firstTurnExcerpt();
    if (excerpt.user === undefined || excerpt.assistant === undefined) return undefined;
    return [
      `user: ${excerpt.user.slice(0, MAX_TITLE_USER_SEGMENT)}`,
      `assistant: ${excerpt.assistant.slice(0, MAX_TITLE_FIRST_TURN_ASSISTANT)}`,
    ].join('\n');
  }
  if (source === 'digest') {
    const excerpt = await promptSource.digestExcerpt();
    const turns: string[][] = [];
    for (const turn of excerpt.turns) {
      const group = [`user: ${turn.user.slice(0, MAX_TITLE_DIGEST_USER_SEGMENT)}`];
      if (turn.assistant !== undefined) {
        group.push(`assistant: ${turn.assistant.slice(0, MAX_TITLE_DIGEST_ASSISTANT)}`);
      }
      turns.push(group);
    }
    return elideTitleDigestTurns(turns);
  }
  return titleInputFromPrompts(await promptSource.firstUserPrompts(MAX_TITLE_PROMPTS));
}

const TITLE_DIGEST_ELISION_MARKER = '...';

function elideTitleDigestTurns(turns: readonly (readonly string[])[]): string | undefined {
  if (turns.length === 0) return undefined;
  const joined = turns.flat().join('\n');
  if (joined.length <= MAX_TITLE_DIGEST_INPUT_LENGTH) return joined;
  let budget = MAX_TITLE_DIGEST_INPUT_LENGTH - TITLE_DIGEST_ELISION_MARKER.length - 2;
  const head: string[] = [];
  for (const line of turns[0]!) {
    if (budget < line.length + 1) break;
    head.push(line);
    budget -= line.length + 1;
  }
  const tail: string[] = [];
  for (let index = turns.length - 1; index >= 1; index--) {
    const group = turns[index]!;
    const cost = group.reduce((sum, line) => sum + line.length + 1, 0);
    if (budget < cost) break;
    tail.unshift(...group);
    budget -= cost;
  }
  return [...head, TITLE_DIGEST_ELISION_MARKER, ...tail].join('\n');
}

function titleThinkingEffort(model: Model): ThinkingEffort {
  const reasoningEffort =
    (model.protocol === 'openai' || model.protocol === 'openai_responses') &&
    model.supportEfforts !== undefined &&
    model.providerOptions?.offEffort === undefined;
  if (model.providerOptions?.offEffort !== undefined) return 'off';
  if (model.alwaysThinking || reasoningEffort) {
    return (
      model.supportEfforts?.find((effort) => effort !== 'off') ??
      (model.protocol === 'anthropic' ? 'low' : 'on')
    );
  }
  return 'off';
}

function normalizeModelTitle(text: string): string | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  const payload = fenced ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(payload);
    const title = typeof parsed === 'string'
      ? parsed
      : typeof parsed === 'object' && parsed !== null && 'title' in parsed
        ? parsed.title
        : undefined;
    if (typeof parsed === 'string' && typeof title === 'string' && title.trimStart().startsWith('{')) {
      return normalizeModelTitle(title);
    }
    return normalizeTitleText(title);
  } catch {
    const match = trimmed.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (match?.[1] !== undefined) {
      try {
        return normalizeTitleText(JSON.parse(`"${match[1]}"`));
      } catch {
      }
    }
    return normalizeTitleText(payload);
  }
}

function normalizeTitleText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.trim().split('\n')[0]?.trim();
  if (title === undefined) return undefined;
  for (const [open, close] of [['`', '`'], ['"', '"'], ["'", "'"], ['“', '”']] as const) {
    if (title.startsWith(open) && title.endsWith(close) && title.length > open.length + close.length) {
      return title.slice(open.length, -close.length).trim() || undefined;
    }
  }
  return title || undefined;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTitleService,
  SessionTitleService,
  ScopeActivation.OnScopeCreated,
  'sessionTitle',
);
