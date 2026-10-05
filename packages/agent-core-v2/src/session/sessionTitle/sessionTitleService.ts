import {
  KIMI_CODE_PROVIDER_NAME,
  OAuthError,
  fetchChatTitle,
  kimiCodeToolsUrl,
  parseKimiCodeCustomHeaders,
  resolveKimiCodeRuntimeAuth,
} from '@moonshot-ai/kimi-code-oauth';

import {
  ScopeActivation,
  registerScopedService,
  type IAgentScopeHandle,
} from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import { IConfigService } from '#/app/config/config';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { createUserMessage } from '#/llm-adapter/contract/message';
import { IHostRequestHeaders } from '#/llm-adapter/model/host-request-headers';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { IModelService } from '#/llm-adapter/model/model';
import { IProviderService } from '#/llm-adapter/provider/provider';
import { getProviderDefinition, isOAuthCatalogVendor } from '#/llm-adapter/provider/provider-definition';
import type { ThinkingEffort } from '#human/llm/thinking';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { resolveSubagentModelPool } from '#/session/subagent/configSection';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';

import { IAgentTitlePromptSource } from './agentTitlePromptSource';
import { ISessionTitleService, type SessionTitleSource } from './sessionTitle';
import { TITLE_SYSTEM_PROMPT } from './titlePrompt';

const MAX_GENERATED_TITLE_LENGTH = 200;

const MAX_TITLE_INPUT_LENGTH = 1000;

const MAX_TITLE_PROMPTS = 3;

const MAX_TITLE_USER_SEGMENT = 400;

const MAX_TITLE_FIRST_TURN_ASSISTANT = 300;

const MAX_TITLE_DIGEST_USER_SEGMENT = 200;

const MAX_TITLE_DIGEST_ASSISTANT = 200;

const MAX_TITLE_DIGEST_INPUT_LENGTH = 3000;

const TITLE_FALLBACK_TIMEOUT_MS = 20000;

const TITLE_MAX_COMPLETION_TOKENS = 512;

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
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @ILogService private readonly log: ILogService,
  ) {}

  async generateTitle(opts?: {
    force?: boolean;
    source?: SessionTitleSource;
  }): Promise<string | undefined> {
    const force = opts?.force === true;
    const source = opts?.source ?? 'user_prompts';
    if (force) return this.generateTitleOnce(true, source);
    if (this._shared !== undefined) return this._shared;
    const tracked = this.generateTitleOnce(false, source).finally(() => {
      if (this._shared === tracked) this._shared = undefined;
    });
    this._shared = tracked;
    return tracked;
  }

  private async generateTitleOnce(
    force: boolean,
    source: SessionTitleSource,
  ): Promise<string | undefined> {
    const current = await this.metadata.read();
    if (!force) {
      if (current.titleKind === 'custom') return undefined;
      if (current.titleKind === 'generated') return undefined;
    }
    const main = this.agentLifecycle.handleOf(MAIN_AGENT_ID);
    if (main === undefined) return undefined;
    const promptSource = main.accessor.get(IAgentTitlePromptSource);
    const input = await composeTitleInput(promptSource, source);
    if (input === undefined) return undefined;
    return this.generateAndApply(input, force, main);
  }

  private async generateAndApply(
    chatContent: string,
    force: boolean,
    main: IAgentScopeHandle,
  ): Promise<string | undefined> {
    const current = await this.metadata.read();
    if (!force && current.titleKind === 'custom') return undefined;
    const title =
      (await this.requestManagedTitle(chatContent)) ??
      (await this.generateTitleViaModel(chatContent, main));
    if (title === undefined) return undefined;
    const applied = await this.metadata.setGeneratedTitleIfUncustomized(title, { force });
    if (!applied) return undefined;
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
    return title;
  }

  private async requestManagedTitle(chatContent: string): Promise<string | undefined> {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (
      provider === undefined ||
      !isOAuthCatalogVendor(provider.type) ||
      provider.oauth === undefined
    ) {
      return undefined;
    }
    const runtimeAuth = resolveKimiCodeRuntimeAuth({
      configuredBaseUrl: provider.baseUrl,
      configuredOAuthRef: provider.oauth,
    });
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      runtimeAuth.oauthRef,
    );
    if (tokenProvider === undefined) return undefined;
    let token: string;
    try {
      token = await tokenProvider.getAccessToken();
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      this.log.debug(`chat_title request unavailable: ${error.message}`);
      return undefined;
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
        return undefined;
      }
      result = await requestTitle(token);
    }
    if (result.kind !== 'ok') {
      this.log.debug(`chat_title request failed: ${result.message}`);
      return undefined;
    }
    return result.title.slice(0, MAX_GENERATED_TITLE_LENGTH);
  }

  private async generateTitleViaModel(
    chatContent: string,
    main: IAgentScopeHandle,
  ): Promise<string | undefined> {
    const modelId = this.resolveFallbackModelId(main);
    if (modelId === undefined) {
      this.log.debug('session title fallback unavailable: no model to run it on');
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TITLE_FALLBACK_TIMEOUT_MS);
    try {
      const thinkingEffort = titleThinkingEffort(this.modelCatalog.get(modelId));
      let text = '';
      for await (const event of this.modelCatalog.generate(
        modelId,
        {
          systemPrompt: TITLE_SYSTEM_PROMPT,
          tools: [],
          messages: [createUserMessage(`<session>\n${chatContent}\n</session>`)],
        },
        controller.signal,
        { maxCompletionTokens: TITLE_MAX_COMPLETION_TOKENS, thinkingEffort },
      )) {
        if (event.type === 'part' && event.part.type === 'text') text += event.part.text;
      }
      const title = normalizeFallbackTitle(text);
      if (title === undefined) {
        this.log.debug('session title fallback produced no usable title text');
        return undefined;
      }
      return title;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug(`session title fallback failed: ${message}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveFallbackModelId(main: IAgentScopeHandle): string | undefined {
    const poolDefault = resolveSubagentModelPool(this.config)?.defaultModel;
    if (poolDefault !== undefined && poolDefault.length > 0) return poolDefault;
    const mainModel = main.accessor.get(IAgentProfileService).getModel();
    if (mainModel.length > 0) return mainModel;
    return this.models.getDefaultModel();
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
  const trait =
    model.providerType === undefined
      ? undefined
      : getProviderDefinition(model.providerType, model.protocol)?.trait;
  const usesReasoningEffort =
    (model.protocol === 'openai' || model.protocol === 'openai_responses') &&
    trait?.thinking === undefined;
  if (usesReasoningEffort && model.providerOptions?.offEffort !== undefined) return 'off';
  if (!model.alwaysThinking && (!usesReasoningEffort || model.supportEfforts === undefined)) {
    return 'off';
  }
  return model.supportEfforts?.find((effort) => effort !== 'off') ?? 'on';
}

function normalizeFallbackTitle(text: string): string | undefined {
  const unwrapped = unwrapWrappingQuotes(text.trim().split('\n')[0]?.trim() ?? '');
  if (unwrapped.length === 0) return undefined;
  return unwrapped.slice(0, MAX_GENERATED_TITLE_LENGTH);
}

function unwrapWrappingQuotes(line: string): string {
  const pairs: readonly (readonly [string, string])[] = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
  ];
  for (const [open, close] of pairs) {
    if (line.length >= 2 && line.startsWith(open) && line.endsWith(close)) {
      return unwrapWrappingQuotes(line.slice(1, -1).trim());
    }
  }
  return line;
}

registerScopedService(
  LifecycleScope.Session,
  ISessionTitleService,
  SessionTitleService,
  ScopeActivation.OnScopeCreated,
  'sessionTitle',
);
