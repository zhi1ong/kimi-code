import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { OAuthConnectionError, OAuthUnauthorizedError } from '@moonshot-ai/kimi-code-oauth';

import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { IOAuthService } from '#/app/auth/auth';
import { IEventService } from '#/app/event/event';
import type { Event2 } from '#/app/event/event2';
import { IConfigService } from '#/app/config/config';
import { IAgentProfileService } from '#/agent/profile/profile';
import { UNKNOWN_CAPABILITY } from '#/llm-adapter/contract/capability';
import { createUserMessage } from '#/llm-adapter/contract/message';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { ModelCatalog } from '#/llm-adapter/model/catalog-service';
import { ProviderCatalogRuntimeService } from '#/llm-adapter/model/catalog-runtime';
import { IModelService, type ModelRecord } from '#/llm-adapter/model/model';
import { ModelService } from '#/llm-adapter/model/model-service';
import type { Protocol } from '#/llm-adapter/protocol/protocol';
import { ProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocolAdapterRegistry';
import {
  type ModelRequestEvent,
  type ModelRequestInput,
  type ModelRequestParams,
} from '#/llm-adapter/model/model-requester';
import { IHostRequestHeaders } from '#/llm-adapter/model/host-request-headers';
import {
  IProviderService,
  type OAuthRef,
  type ProviderConfig,
} from '#/llm-adapter/provider/provider';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { SECONDARY_MODEL_SECTION } from '#/session/subagent/configSection';
import {
  IAgentTitlePromptSource,
  type TitleDigestExcerpt,
  type TitleTurnExcerpt,
} from '#/session/sessionTitle/agentTitlePromptSource';
import { ISessionTitleService } from '#/session/sessionTitle/sessionTitle';
import { SessionTitleService } from '#/session/sessionTitle/sessionTitleService';
import {
  ISessionMetadata,
  type SessionMeta,
  type SessionMetaPatch,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';

import { registerLogServices } from '../../_base/log/stubs';
import { stubProviderService } from '../../app/provider/stubs';
import { StubConfigService, stubModelOAuthTokens } from '../../stubs';

const SESSION_ID = 'sess-1';
const MANAGED_PROVIDER: ProviderConfig = {
  type: 'kimi',
  baseUrl: 'https://api.example.test/coding/v1',
  oauth: { storage: 'file', key: 'kimi-code' },
};

class FakeEventService implements IEventService {
  declare readonly _serviceBrand: undefined;
  private readonly emitter = new Emitter<Event2>();
  readonly onDidPublish = this.emitter.event;
  readonly published: Event2[] = [];

  publish(event: Event2): void {
    this.published.push(event);
    this.emitter.fire(event);
  }

  subscribe(handler: (event: Event2) => void): IDisposable {
    return this.emitter.event(handler);
  }
}

class FakeSessionMetadata implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  private readonly emitter = new Emitter<SessionMetadataChangedEvent>();
  readonly onDidChangeMetadata = this.emitter.event;
  meta: SessionMeta;

  constructor() {
    this.meta = {
      id: SESSION_ID,
      createdAt: 0,
      updatedAt: 0,
      archived: false,
    };
  }

  read(): Promise<SessionMeta> {
    return Promise.resolve(this.meta);
  }

  update(patch: SessionMetaPatch): Promise<void> {
    this.meta = { ...this.meta, ...patch };
    this.emitter.fire({ changed: Object.keys(patch) as (keyof SessionMeta)[] });
    return Promise.resolve();
  }

  setTitle(title: string): Promise<void> {
    return this.update({ title, titleKind: 'custom' });
  }

  async setGeneratedTitleIfUncustomized(
    title: string,
    opts?: { force?: boolean },
  ): Promise<boolean> {
    if (opts?.force !== true && this.meta.titleKind === 'custom') return false;
    await this.update({ title, titleKind: 'generated' });
    return true;
  }

  setArchived(archived: boolean): Promise<void> {
    return this.update({ archived });
  }

  registerAgent(): Promise<void> {
    return Promise.resolve();
  }
}

function createPendingFetch() {
  let markStarted!: () => void;
  let resolveResponse!: (response: Response) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return {
    fetch: async () => {
      markStarted();
      return response;
    },
    started,
    resolve: resolveResponse,
  };
}

function modelTitleEvents(text: string): AsyncIterable<ModelRequestEvent> {
  return (async function* (): AsyncGenerator<ModelRequestEvent> {
    yield { type: 'part', part: { type: 'text', text } };
  })();
}

function streamingTitleResponse(protocol: Protocol, model: string): Response {
  const events: Record<string, unknown>[] = protocol === 'anthropic'
    ? [
      {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', model, content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '生成的标题' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
    : protocol === 'openai'
      ? [
        {
          id: 'cmpl_1', object: 'chat.completion.chunk', created: 0, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: '生成的标题' }, finish_reason: null }],
        },
        {
          id: 'cmpl_1', object: 'chat.completion.chunk', created: 0, model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ]
      : [
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_text.delta', delta: '生成的标题' },
        { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
      ];
  const chunks = events.map((event) => {
    const prefix = typeof event['type'] === 'string' ? `event: ${event['type']}\n` : '';
    return `${prefix}data: ${JSON.stringify(event)}\n\n`;
  });
  if (protocol === 'openai') chunks.push('data: [DONE]\n\n');
  return new Response(chunks.join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

function failingTitleEvents(error: Error): AsyncIterable<ModelRequestEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<ModelRequestEvent>> => {
        throw error;
      },
    }),
  };
}

function pendingTitleEvents(signal?: AbortSignal): AsyncIterable<ModelRequestEvent> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    }),
  };
}

describe('SessionTitleService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let events: FakeEventService;
  let metadata: FakeSessionMetadata;
  let providers: Record<string, ProviderConfig>;
  let fetchMock: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
  let tokenError: Error | undefined;
  let forceTokenError: Error | undefined;
  let resolvedOAuthRefs: Array<OAuthRef | undefined>;
  let titlePrompts: readonly string[];
  let promptSourceImpl: (limit: number) => Promise<readonly string[]>;
  let turnExcerpt: TitleTurnExcerpt;
  let digestExcerpt: TitleDigestExcerpt;
  let tokenCalls: boolean[];
  let config: StubConfigService;
  let mainModel: string;
  let defaultModel: string | undefined;
  let generateCalls: Array<{ id: string; input: ModelRequestInput; params?: ModelRequestParams }>;
  let getModelImpl: (id: string) => Model;
  let generateImpl: (
    id: string,
    input: ModelRequestInput,
    signal?: AbortSignal,
    params?: ModelRequestParams,
  ) => AsyncIterable<ModelRequestEvent>;

  beforeEach(() => {
    tokenError = undefined;
    forceTokenError = undefined;
    resolvedOAuthRefs = [];
    titlePrompts = [];
    promptSourceImpl = async (limit) => titlePrompts.slice(0, limit);
    turnExcerpt = {};
    digestExcerpt = { turns: [] };
    tokenCalls = [];
    config = new StubConfigService();
    mainModel = '';
    defaultModel = undefined;
    generateCalls = [];
    getModelImpl = (id) => ({
      id,
      name: id,
      aliases: [],
      protocol: 'openai',
      headers: {},
      capabilities: UNKNOWN_CAPABILITY,
      maxContextSize: 8192,
      alwaysThinking: false,
      providerName: 'example',
    });
    generateImpl = () => modelTitleEvents('生成的标题');
    providers = { 'managed:kimi-code': MANAGED_PROVIDER };
    metadata = new FakeSessionMetadata();
    events = new FakeEventService();
    fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ title: '生成的标题' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(
          ISessionContext,
          makeSessionContext({
            sessionId: SESSION_ID,
            workspaceId: 'ws-1',
            sessionDir: '/tmp/sess-1',
            sessionScope: 'sessions/sess-1',
            cwd: '/tmp',
          }),
        );
        reg.defineInstance(ISessionMetadata, metadata);
        const promptSource: IAgentTitlePromptSource = {
          _serviceBrand: undefined,
          firstUserPrompts: (limit) => promptSourceImpl(limit),
          firstTurnExcerpt: async () => turnExcerpt,
          digestExcerpt: async () => digestExcerpt,
        };
        const profileService = {
          getModel: () => mainModel,
          hasModel: () => mainModel.length > 0,
        };
        const mainAgent: IAgentScopeHandle = {
          id: MAIN_AGENT_ID,
          kind: LifecycleScope.Agent,
          accessor: {
            get: <T>(id: ServiceIdentifier<T>) =>
              (id === IAgentProfileService ? (profileService as T) : (promptSource as T)),
          },
          dispose: () => undefined,
        };
        reg.definePartialInstance(IAgentLifecycleService, {
          handleOf: () => mainAgent,
        });
        reg.defineInstance(IEventService, events);
        reg.defineInstance(IProviderService, stubProviderService(providers));
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider: (_provider, oauthRef) => {
            resolvedOAuthRefs.push(oauthRef);
            return {
              getAccessToken: async (options) => {
                tokenCalls.push(options?.force === true);
                if (tokenError !== undefined) throw tokenError;
                if (options?.force === true && forceTokenError !== undefined) {
                  throw forceTokenError;
                }
                return 'test-token';
              },
            };
          },
        });
        reg.defineInstance(IHostRequestHeaders, {
          headers: { 'User-Agent': 'test' },
          thirdPartyHeaders: {},
        });
        reg.defineInstance(IConfigService, config);
        reg.defineInstance(
          IModelCatalog,
          {
            _serviceBrand: undefined,
            get: (id: string) => getModelImpl(id),
            generate: (
              id: string,
              input: ModelRequestInput,
              signal?: AbortSignal,
              params?: ModelRequestParams,
            ) => {
              generateCalls.push({ id, input, params });
              return generateImpl(id, input, signal, params);
            },
          } as unknown as IModelCatalog,
        );
        reg.defineInstance(
          IModelService,
          {
            _serviceBrand: undefined,
            getDefaultModel: () => defaultModel,
          } as unknown as IModelService,
        );
        reg.define(ISessionTitleService, SessionTitleService);
      },
    });
    ix.get(ISessionTitleService);
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function useRealModelCatalog(protocol: Protocol, name: string, overrides?: ModelRecord): void {
    delete providers['managed:kimi-code'];
    providers['example'] = {
      type: protocol,
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'YOUR_API_KEY',
    };
    const providerService = stubProviderService(providers);
    const modelService = disposables.add(new ModelService());
    modelService.loadAll({
      'byok-model': { provider: 'example', model: name, maxContextSize: 200000, ...overrides },
    }, 'byok-model');
    const runtime = disposables.add(new ProviderCatalogRuntimeService(modelService, providerService));
    const catalog = disposables.add(new ModelCatalog(
      runtime,
      providerService,
      modelService,
      stubModelOAuthTokens(),
      new ProtocolAdapterRegistry(),
      { headers: {}, thirdPartyHeaders: {} },
    ));
    getModelImpl = (id) => catalog.get(id);
    generateImpl = (id, input, signal, params) => catalog.generate(id, input, signal, params);
    mainModel = 'byok-model';
    titlePrompts = ['帮我分析组件错误'];
  }

  it('replaces the easy title with the generated one', async () => {
    titlePrompts = ['帮我看一下这个 Go 的 nil pointer 报错'];

    const title = await ix.get(ISessionTitleService).generateTitle();

    expect(title).toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: 帮我看一下这个 Go 的 nil pointer 报错' },
    });
    expect(new Headers(init?.headers as Record<string, string>).get('authorization')).toBe(
      'Bearer test-token',
    );

    const rebroadcast = events.published.find(
      (event): event is SessionMetaUpdated =>
        event.type === 'session.meta.updated' &&
        (event as SessionMetaUpdated).payload.patch.title === '生成的标题',
    );
    expect(rebroadcast).toBeDefined();
  });

  it('composes the title input from the recorded prompts in order', async () => {
    titlePrompts = ['先帮我搭一个 Vite 项目', '加上路由', '现在配一下 ESLint'];

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: {
        chat_content: 'user: 先帮我搭一个 Vite 项目\nuser: 加上路由\nuser: 现在配一下 ESLint',
      },
    });
  });

  it('truncates each prompt to the per-prompt budget, keeping the head', async () => {
    titlePrompts = ['很长的输入'.repeat(400), '第二条'];

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init?.body as string) as { params: { chat_content: string } };
    expect(body.params.chat_content).toBe(`user: ${'很长的输入'.repeat(80)}\nuser: 第二条`);
  });

  it('returns unavailable when only a slash activation updated lastPrompt', async () => {
    await metadata.update({ lastPrompt: '/compact' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unavailable without a managed provider and no fallback model', async () => {
    delete providers['managed:kimi-code'];
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateCalls).toHaveLength(0);
  });

  it('falls back to a one-shot model completion when no managed provider exists', async () => {
    delete providers['managed:kimi-code'];
    mainModel = 'test-model';
    titlePrompts = ['帮我修一个 nil 指针'];

    const title = await ix.get(ISessionTitleService).generateTitle();

    expect(title).toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]!.id).toBe('test-model');
    expect(generateCalls[0]!.input.systemPrompt.length).toBeGreaterThan(0);
    expect(generateCalls[0]!.input.messages).toEqual([
      createUserMessage('<session>\nuser: 帮我修一个 nil 指针\n</session>'),
    ]);
    expect(generateCalls[0]!.params?.maxCompletionTokens).toBe(512);
    expect(generateCalls[0]!.params?.thinkingEffort).toBe('off');

    const rebroadcast = events.published.find(
      (event): event is SessionMetaUpdated =>
        event.type === 'session.meta.updated' &&
        (event as SessionMetaUpdated).payload.patch.title === '生成的标题',
    );
    expect(rebroadcast).toBeDefined();
  });

  it.each(['claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview'])(
    'generates a title through the real Anthropic adapter for %s without disabling thinking',
    async (name) => {
      useRealModelCatalog('anthropic', name);
      fetchMock.mockImplementation(async () => streamingTitleResponse('anthropic', name));

      await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(body.thinking.type).toBe('adaptive');
      expect(body.output_config.effort).toBe('low');
      expect(metadata.meta.titleKind).toBe('generated');
    },
  );

  it.each(['openai', 'openai_responses'] as const)(
    'generates a title through the real %s adapter without an off effort',
    async (protocol) => {
      const name = 'example-reasoner';
      useRealModelCatalog(protocol, name, {
        capabilities: ['thinking'], supportEfforts: ['low', 'medium', 'high'], defaultEffort: 'high',
      });
      fetchMock.mockImplementation(async () => streamingTitleResponse(protocol, name));

      await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(protocol === 'openai' ? body.reasoning_effort : body.reasoning.effort).toBe('low');
      expect(metadata.meta.titleKind).toBe('generated');
    },
  );

  it.each(['openai', 'openai_responses'] as const)(
    'uses the explicit off effort through the real %s adapter for an always-thinking model',
    async (protocol) => {
      const name = 'example-reasoner';
      useRealModelCatalog(protocol, name, {
        capabilities: ['always_thinking'],
        supportEfforts: ['low', 'high'],
        offEffort: 'none',
      });
      fetchMock.mockImplementation(async () => streamingTitleResponse(protocol, name));

      await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');

      const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
      expect(protocol === 'openai' ? body.reasoning_effort : body.reasoning.effort).toBe('none');
      expect(generateCalls[0]!.params?.thinkingEffort).toBe('off');
    },
  );

  it('keeps thinking disabled through the real Anthropic adapter when the model supports it', async () => {
    const name = 'claude-opus-4-7';
    useRealModelCatalog('anthropic', name);
    fetchMock.mockImplementation(async () => streamingTitleResponse('anthropic', name));

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.thinking.type).toBe('disabled');
    expect(body.max_tokens).toBe(512);
  });

  it('keeps thinking disabled through a provider trait even without an off effort', async () => {
    const name = 'example-reasoner';
    useRealModelCatalog('openai', name, {
      capabilities: ['thinking'],
      supportEfforts: ['low', 'high'],
    });
    providers['example']!.type = 'kimi';
    fetchMock.mockImplementation(async () => streamingTitleResponse('openai', name));

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.thinking.type).toBe('disabled');
    expect(body.max_completion_tokens).toBe(512);
    expect(generateCalls[0]!.params?.thinkingEffort).toBe('off');
  });

  it('resolves the fallback model from the secondary model pool default first', async () => {
    delete providers['managed:kimi-code'];
    config.setSilent(SECONDARY_MODEL_SECTION, {
      defaultModel: 'pool-model',
      models: { 'pool-model': '挑选提示' },
    });
    mainModel = 'main-model';
    defaultModel = 'global-default';
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(generateCalls[0]!.id).toBe('pool-model');
  });

  it('falls back to the main agent model when no pool default is set', async () => {
    delete providers['managed:kimi-code'];
    mainModel = 'main-model';
    defaultModel = 'global-default';
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(generateCalls[0]!.id).toBe('main-model');
  });

  it('falls back to the global default model when the main agent has no model', async () => {
    delete providers['managed:kimi-code'];
    mainModel = '';
    defaultModel = 'global-default';
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(generateCalls[0]!.id).toBe('global-default');
  });

  it('prefers the managed chat_title path when it is available', async () => {
    mainModel = 'test-model';
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(generateCalls).toHaveLength(0);
  });

  it('falls back to the model when the managed OAuth token is unavailable', async () => {
    tokenError = new OAuthUnauthorizedError('re-login required');
    mainModel = 'test-model';
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateCalls).toHaveLength(1);
  });

  it('falls back to the model when the token refresh after a 401 fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 401 }));
    forceTokenError = new OAuthUnauthorizedError('refresh rejected');
    mainModel = 'test-model';
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(generateCalls).toHaveLength(1);
  });

  it('returns unavailable when the fallback completion is only wrapping quotes', async () => {
    delete providers['managed:kimi-code'];
    mainModel = 'test-model';
    generateImpl = () => modelTitleEvents('""');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBeUndefined();
    expect(metadata.meta.titleKind).toBeUndefined();
  });

  it.each(['HTTP error', 'network error'])(
    'falls back to the model when the chat_title request fails with a %s',
    async (failure) => {
      fetchMock.mockImplementationOnce(async () => {
        if (failure === 'network error') throw new Error('network unavailable');
        return new Response('', { status: 500 });
      });
      mainModel = 'test-model';
      titlePrompts = ['hello'];

      await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
      expect(metadata.meta.title).toBe('生成的标题');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(generateCalls).toHaveLength(1);
    },
  );

  it('returns unavailable when the fallback completion fails', async () => {
    delete providers['managed:kimi-code'];
    mainModel = 'test-model';
    generateImpl = () => failingTitleEvents(new Error('provider is down'));
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBeUndefined();
  });

  it('returns unavailable when the fallback completion yields no text', async () => {
    delete providers['managed:kimi-code'];
    mainModel = 'test-model';
    generateImpl = () => modelTitleEvents('   ');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
  });

  it('aborts the fallback completion after the timeout', async () => {
    vi.useFakeTimers();
    try {
      delete providers['managed:kimi-code'];
      mainModel = 'test-model';
      generateImpl = (_id, _input, signal) => pendingTitleEvents(signal);
      titlePrompts = ['hello'];

      const generation = ix.get(ISessionTitleService).generateTitle();
      await vi.advanceTimersByTimeAsync(20000);

      await expect(generation).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('normalizes the fallback completion output to the first unquoted line', async () => {
    delete providers['managed:kimi-code'];
    mainModel = 'test-model';
    generateImpl = () => modelTitleEvents('“模型标题”\n多余的输出行');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('模型标题');
  });

  it('truncates a fallback title spanning stream chunks to 200 characters', async () => {
    delete providers['managed:kimi-code'];
    mainModel = 'test-model';
    const longTitle = '前'.repeat(120) + '后'.repeat(180);
    generateImpl = async function* () {
      yield { type: 'part', part: { type: 'text', text: longTitle.slice(0, 120) } };
      yield { type: 'part', part: { type: 'text', text: longTitle.slice(120) } };
    };
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe(longTitle.slice(0, 200));
  });

  it('never overwrites a custom title set while generation is in flight', async () => {
    const pendingFetch = createPendingFetch();
    fetchMock.mockImplementationOnce(pendingFetch.fetch);

    titlePrompts = ['hello'];
    const generation = ix.get(ISessionTitleService).generateTitle();
    await pendingFetch.started;
    await metadata.setTitle('user 取的标题');
    pendingFetch.resolve(
      new Response(JSON.stringify({ title: '生成的标题' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generation).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('user 取的标题');
    expect(metadata.meta.titleKind).toBe('custom');
  });

  it('skips generation when the current title was already generated', async () => {
    await metadata.setGeneratedTitleIfUncustomized('已生成的标题');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metadata.meta.title).toBe('已生成的标题');
  });

  it('force regenerates an already-generated title', async () => {
    await metadata.setGeneratedTitleIfUncustomized('已生成的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');
  });

  it('force overwrites a custom title and drops its custom marking', async () => {
    await metadata.setTitle('user 取的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(metadata.meta.titleKind).toBe('generated');
  });

  it('force still degrades when the backend request fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));
    await metadata.setTitle('user 取的标题');
    titlePrompts = ['hello'];

    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true }),
    ).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('user 取的标题');
    expect(metadata.meta.titleKind).toBe('custom');
  });

  it('first_turn composes the opening prompt with the first reply, within budget', async () => {
    turnExcerpt = { user: '最初的问题', assistant: '第一轮的回答' };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBe('生成的标题');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: 最初的问题\nassistant: 第一轮的回答' },
    });
  });

  it('first_turn is strict: no assistant reply yet means unavailable', async () => {
    turnExcerpt = { user: '只有问题' };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('first_turn truncates each segment to its budget', async () => {
    turnExcerpt = { user: '问'.repeat(500), assistant: '答'.repeat(1000) };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'first_turn' }),
    ).resolves.toBe('生成的标题');

    const [, init] = fetchMock.mock.calls[0]!;
    const content = (JSON.parse(init?.body as string) as { params: { chat_content: string } })
      .params.chat_content;
    expect(content).toBe(`user: ${'问'.repeat(400)}\nassistant: ${'答'.repeat(300)}`);
  });

  it('digest composes every turn as interleaved user/assistant lines', async () => {
    digestExcerpt = {
      turns: [
        { user: '开场', assistant: '开场回答' },
        { user: '最新追问', assistant: '当前进展' },
      ],
    };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBe('生成的标题');

    let [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: {
        chat_content: 'user: 开场\nassistant: 开场回答\nuser: 最新追问\nassistant: 当前进展',
      },
    });

    fetchMock.mockClear();
    digestExcerpt = { turns: [{ user: '开场', assistant: undefined }] };
    await expect(
      ix.get(ISessionTitleService).generateTitle({ force: true, source: 'digest' }),
    ).resolves.toBe('生成的标题');
    [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      method: 'chat_title',
      params: { chat_content: 'user: 开场' },
    });
  });

  it('digest truncates each segment to its budget', async () => {
    digestExcerpt = {
      turns: [{ user: '问'.repeat(300), assistant: '答'.repeat(300) }],
    };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBe('生成的标题');

    const [, init] = fetchMock.mock.calls[0]!;
    const content = (JSON.parse(init?.body as string) as { params: { chat_content: string } })
      .params.chat_content;
    expect(content).toBe(`user: ${'问'.repeat(200)}\nassistant: ${'答'.repeat(200)}`);
  });

  it('digest elides the middle turns when the input exceeds the total budget', async () => {
    digestExcerpt = {
      turns: Array.from({ length: 30 }, (_, i) => ({
        user: `第${i}个${'问'.repeat(180)}`,
        assistant: `第${i}个${'答'.repeat(180)}`,
      })),
    };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBe('生成的标题');

    const [, init] = fetchMock.mock.calls[0]!;
    const content = (JSON.parse(init?.body as string) as { params: { chat_content: string } })
      .params.chat_content;
    expect(content.length).toBeLessThanOrEqual(3000);
    expect(content.startsWith('user: 第0个')).toBe(true);
    expect(content).toContain('\n...\n');
    expect(content.split('\n...\n')[1]?.startsWith('user: ')).toBe(true);
    expect(content.endsWith(`assistant: 第29个${'答'.repeat(180)}`)).toBe(true);
  });

  it('digest is unavailable when the window yields no segments at all', async () => {
    digestExcerpt = { turns: [] };

    await expect(
      ix.get(ISessionTitleService).generateTitle({ source: 'digest' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the current title when the backend request fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 500 }));
    titlePrompts = ['hello'];
    await metadata.update({ title: 'hello', titleKind: 'replaceable' });

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBe('hello');
    expect(tokenCalls).toEqual([false]);
  });

  it('retries once with a force-refreshed token on a 401', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 401 }));
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenCalls).toEqual([false, true]);
  });

  it('falls back to the model when the 401 persists after the force refresh', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 401 }));
    mainModel = 'test-model';
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBe('生成的标题');
    expect(metadata.meta.title).toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenCalls).toEqual([false, true]);
    expect(generateCalls).toHaveLength(1);
  });

  it('degrades when the force refresh after a 401 fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 401 }));
    forceTokenError = new OAuthUnauthorizedError('refresh rejected');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(metadata.meta.title).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tokenCalls).toEqual([false, true]);
  });

  it('returns unavailable when the OAuth token is missing or revoked', async () => {
    tokenError = new OAuthUnauthorizedError('re-login required');
    titlePrompts = ['hello'];

    const svc = ix.get(ISessionTitleService);
    await expect(svc.generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unavailable when OAuth token retrieval has an operational failure', async () => {
    tokenError = new OAuthConnectionError('connection failed');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates unexpected token provider failures', async () => {
    tokenError = new Error('unexpected failure');
    titlePrompts = ['hello'];

    await expect(ix.get(ISessionTitleService).generateTitle()).rejects.toThrow(
      'unexpected failure',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('includes environment custom headers', async () => {
    vi.stubEnv('KIMI_CODE_CUSTOM_HEADERS', 'X-Proxy-Header: from-env\n');
    titlePrompts = ['hello'];

    await ix.get(ISessionTitleService).generateTitle();

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers as Record<string, string>);
    expect(headers.get('x-proxy-header')).toBe('from-env');
    expect(headers.get('user-agent')).toBe('test');
  });

  it('pairs the environment endpoint with its credential slot when it overrides persisted config', async () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://api.env.example.test/coding/v1');
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.env.example.test');
    titlePrompts = ['hello'];

    await ix.get(ISessionTitleService).generateTitle();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.env.example.test/coding/v1/tools');
    expect(resolvedOAuthRefs[0]).toMatchObject({
      storage: 'file',
      oauthHost: 'https://auth.env.example.test',
    });
    expect(resolvedOAuthRefs[0]?.key).not.toBe(MANAGED_PROVIDER.oauth?.key);
  });

  it('shares an in-flight generation between concurrent requests', async () => {
    const pendingFetch = createPendingFetch();
    fetchMock.mockImplementationOnce(pendingFetch.fetch);

    titlePrompts = ['hello'];
    const first = ix.get(ISessionTitleService).generateTitle();
    const second = ix.get(ISessionTitleService).generateTitle();
    await pendingFetch.started;

    pendingFetch.resolve(
      new Response(JSON.stringify({ title: '生成的标题' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(first).resolves.toBe('生成的标题');
    await expect(second).resolves.toBe('生成的标题');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns unavailable without calling the backend when no prompt was seen', async () => {
    await expect(ix.get(ISessionTitleService).generateTitle()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
