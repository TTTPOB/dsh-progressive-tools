import { describe, expect, it } from 'vitest'
import { getCurrentTools, resolveTranscriptTools } from '@earendil-works/pi-ai/utils/transcript'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DESCRIBE_TOOLS_NAME, INVOKE_TOOL_NAME, SEARCH_TOOLS_NAME } from '../src/index.ts'
import { installNativeDeferredBridge } from '../src/native-deferred.ts'

interface CapturedContext {
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  messages: Array<{ role: string; [key: string]: unknown }>
}

class FixtureAdapter extends LlmAdapter {
  captured: CapturedContext | undefined
  readonly model: Record<string, unknown>
  readonly models = {
    streamSimple: (_model: unknown, context: CapturedContext): AsyncIterable<StreamChunk> => {
      this.captured = context
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
      })()
    },
  }

  constructor(supportsToolAdditions: boolean) {
    super()
    this.model = {
      api: 'openai-responses',
      provider: 'fixture',
      id: 'fixture-model',
      compat: { supportsMidConvoSystemMessages: supportsToolAdditions, supportsToolSearch: supportsToolAdditions },
    }
  }

  async resolveModel(provider: string, model: string) {
    return { ...await super.resolveModel(provider, model), toolUpdate: 'in-history' as const }
  }

  current() {
    return { models: this.models }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const callNames = new Map<string, string>()
    const messages: Array<{ role: string; [key: string]: unknown }> = []
    for (const message of options.messages) {
      if (message.role === 'assistant') {
        for (const block of message.content) {
          if (block.type === 'tool-call') callNames.set(String(block.id), block.name)
        }
        messages.push({ role: 'assistant', content: message.content })
        continue
      }
      if (message.role === 'developer') {
        messages.push({
          role: 'system', content: '', timestamp: 0,
          toolsAdded: message.content.filter(block => block.type === 'tool-addition')
            .map(block => {
              const tool = options.tools?.find(tool => tool.name === block.toolName)
              if (tool === undefined) throw new Error('undeclared tool addition')
              return { name: tool.name, description: tool.description, parameters: tool.parameters }
            }),
          toolsRemoved: message.content.filter(block => block.type === 'tool-removal')
            .map(block => ({ name: block.toolName })),
        })
        continue
      }
      if (message.role !== 'tool') continue
      messages.push({
        role: 'toolResult',
        toolCallId: String(message.toolCallId),
        toolName: callNames.get(String(message.toolCallId)) ?? 'unknown',
      })
    }
    return this.models.streamSimple(this.model, {
      messages,
      ...options.tools === undefined ? {} : { tools: options.tools.filter(tool => !tool.deferLoading).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) },
    })
  }
}

const discoveryTools = [
  { name: SEARCH_TOOLS_NAME, description: 'search', parameters: {} },
  { name: DESCRIBE_TOOLS_NAME, description: 'describe', parameters: {} },
  { name: INVOKE_TOOL_NAME, description: 'invoke', parameters: {} },
]

function request(tools: GenerateOptions['tools'] = discoveryTools, callId = 'describe-call', description = 'Run PowerShell.'): GenerateOptions {
  return {
    provider: 'fixture',
    model: 'fixture-model',
    tools,
    toolHistory: { tools: tools ?? [], updates: [] },
    messages: [
      {
        id: 'assistant' as never,
        role: 'assistant',
        source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
        content: [{
          type: 'tool-call',
          id: ToolCallId(callId),
          name: DESCRIBE_TOOLS_NAME,
          arguments: '{"names":["pwsh"]}',
        }],
      },
      {
        id: 'result' as never,
        role: 'tool',
        source: { kind: 'tool', callId: ToolCallId(callId) },
        toolCallId: ToolCallId(callId),
        content: [{
            type: 'text',
            text: JSON.stringify({
              tools: [{
                name: 'pwsh',
                description,
                parameters: { type: 'object', properties: { command: { type: 'string' } } },
                output: { type: 'string' },
              }],
            }),
          }],
        isError: false,
      },
    ],
  }
}

async function consume(iterable: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of iterable) { /* consume the lazy adapter path */ }
}

async function setup(supportsToolAdditions: boolean) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const adapter = new FixtureAdapter(supportsToolAdditions)
  ctx.llm.registerAdapter(['fixture'], adapter)
  installNativeDeferredBridge(ctx, {
    describe: DESCRIBE_TOOLS_NAME,
    invoke: INVOKE_TOOL_NAME,
    progressive: new Set([SEARCH_TOOLS_NAME, DESCRIBE_TOOLS_NAME, INVOKE_TOOL_NAME]),
  })
  return { ctx, adapter }
}

describe('native deferred bridge', () => {
  it('loads disclosed schemas at the describe result and removes invoke_tool for capable models', async () => {
    const { ctx, adapter } = await setup(true)
    await consume(ctx.llm.stream(request()))

    expect(adapter.captured?.tools?.map(tool => tool.name)).toEqual([
      SEARCH_TOOLS_NAME,
      DESCRIBE_TOOLS_NAME,
    ])
    expect(adapter.captured?.messages.map(message => message['role'])).toEqual(['assistant', 'toolResult', 'system'])
    expect(adapter.captured?.messages[2]).toMatchObject({
      role: 'system', content: '', timestamp: 0,
      toolsAdded: [{ name: 'pwsh', description: 'Run PowerShell.' }],
    })
    const transcript = [
      { role: 'system', content: '', timestamp: 0, toolsAdded: adapter.captured?.tools ?? [] },
      ...adapter.captured?.messages ?? [],
    ]
    expect(getCurrentTools(transcript).map(tool => tool.name)).toEqual([SEARCH_TOOLS_NAME, DESCRIBE_TOOLS_NAME, 'pwsh'])
    expect(resolveTranscriptTools(transcript, true)).toMatchObject({
      anchorsAdditions: true,
      requestTools: [{ name: SEARCH_TOOLS_NAME }, { name: DESCRIBE_TOOLS_NAME }],
    })
    await ctx.fiber.dispose()
  })

  it.each([
    ['openai-responses', { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true }, true],
    ['azure-openai-responses', { supportsMidConvoSystemMessages: true, supportsToolSearch: true }, true],
    ['openai-codex-responses', { supportsMidConvoSystemMessages: true, supportsToolSearch: true }, true],
    ['openai-completions', { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }, true],
    ['openai-responses', { supportsToolSearch: true }, false],
    ['openai-responses', { supportsMidConvoSystemMessages: true }, false],
  ] as const)('uses explicit %s transcript capabilities %j', async (api, compat, expected) => {
    const { ctx, adapter } = await setup(true)
    Object.assign(adapter.model, { api, compat })
    await consume(ctx.llm.stream(request()))
    expect(adapter.captured?.messages.some(message => message['role'] === 'system')).toBe(expected)
    expect(adapter.captured?.tools?.some(tool => tool.name === INVOKE_TOOL_NAME)).toBe(!expected)
    await ctx.fiber.dispose()
  })

  it('does not confuse deferred schema declarations with loaded tools', async () => {
    const { ctx, adapter } = await setup(true)
    const options = request([...discoveryTools, { name: 'pwsh', description: 'declared only', parameters: {}, deferLoading: true }])
    await consume(ctx.llm.stream(options))
    expect(adapter.captured?.tools?.map(tool => tool.name)).toEqual([SEARCH_TOOLS_NAME, DESCRIBE_TOOLS_NAME])
    expect(adapter.captured?.messages[2]?.['toolsAdded']).toMatchObject([{ name: 'pwsh' }])
    await ctx.fiber.dispose()
  })

  it('replays additions and removals before deciding whether another describe adds tools', async () => {
    const { ctx, adapter } = await setup(true)
    const first = request()
    const again = request(undefined, 'describe-again')
    const messages = [...first.messages, ...again.messages]
    await consume(ctx.llm.stream({ ...first, messages }))
    expect(adapter.captured?.messages.filter(message => message['role'] === 'system')).toHaveLength(1)

    const removal = {
      id: 'remove' as never, role: 'developer' as const,
      source: { kind: 'tool-registry' as const },
      content: [{ type: 'tool-removal' as const, toolName: 'pwsh' }],
    }
    const pwsh = { name: 'pwsh', description: 'Run PowerShell.', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
    const addition = { ...removal, id: 'add' as never, content: [{ type: 'tool-addition' as const, toolName: 'pwsh' }] }
    await consume(ctx.llm.stream({
      ...first,
      tools: [...discoveryTools, { ...pwsh, deferLoading: true }],
      messages: [addition, ...first.messages, removal, ...again.messages],
      toolHistory: { tools: discoveryTools, updates: [
        { messageId: addition.id, additions: [pwsh] },
        { messageId: removal.id, additions: [] },
      ] },
    }))
    const systems = adapter.captured?.messages.filter(message => message['role'] === 'system')
    expect(systems).toHaveLength(3)
    expect(systems?.[1]?.['toolsRemoved']).toEqual([{ name: 'pwsh' }])
    expect(systems?.[2]?.['toolsAdded']).toMatchObject([{ name: 'pwsh' }])
    await ctx.fiber.dispose()
  })

  it('replaces changed schemas at the later describe result', async () => {
    const { ctx, adapter } = await setup(true)
    const first = request()
    await consume(ctx.llm.stream({ ...first, messages: [...first.messages, ...request(undefined, 'changed', 'Updated schema.').messages] }))
    const systems = adapter.captured?.messages.filter(message => message['role'] === 'system')
    expect(systems).toHaveLength(2)
    expect(systems?.[1]).toMatchObject({ toolsAdded: [{ name: 'pwsh', description: 'Updated schema.' }], toolsRemoved: [{ name: 'pwsh' }] })
    await ctx.fiber.dispose()
  })

  it('preserves input objects and restores the Models method on disposal', async () => {
    const { ctx, adapter } = await setup(true)
    const original = adapter.models.streamSimple
    const options = request()
    const before = JSON.stringify(options)
    await consume(ctx.llm.stream(options))
    expect(JSON.stringify(options)).toBe(before)
    expect(adapter.models.streamSimple).not.toBe(original)
    await ctx.fiber.dispose()
    expect(adapter.models.streamSimple).toBe(original)
  })

  it.each(['error', 'malformed', 'unmatched'] as const)('does not load a schema from an %s describe result', async (kind) => {
    const { ctx, adapter } = await setup(true)
    const options = request()
    const messages = options.messages.map(message => message.role !== 'tool' ? message : {
      ...message,
      ...kind === 'error' ? { isError: true } : {},
      ...kind === 'malformed' ? { content: [{ type: 'text' as const, text: 'spilled result' }] } : {},
      ...kind === 'unmatched' ? { toolCallId: ToolCallId('other') } : {},
    })
    await consume(ctx.llm.stream({ ...options, messages }))
    expect(adapter.captured?.messages.some(message => message['role'] === 'system')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('keeps only the stable invoke_tool fallback for models without native loading', async () => {
    const { ctx, adapter } = await setup(false)
    await consume(ctx.llm.stream(request()))

    expect(adapter.captured?.tools?.map(tool => tool.name)).toEqual([
      SEARCH_TOOLS_NAME,
      DESCRIBE_TOOLS_NAME,
      INVOKE_TOOL_NAME,
    ])
    expect(adapter.captured?.messages.some(message => message['role'] === 'system')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('does not inject native tools into a Code-only request', async () => {
    const { ctx, adapter } = await setup(true)
    await consume(ctx.llm.stream(request([{
      name: 'run_code',
      description: 'run code',
      parameters: {},
    }])))

    expect(adapter.captured?.tools?.map(tool => tool.name)).toEqual(['run_code'])
    expect(adapter.captured?.messages.some(message => message['role'] === 'system')).toBe(false)
    await ctx.fiber.dispose()
  })
})
