/**
 * Direct-first progressive discovery across Native, Code, and Both: stable
 * model surfaces, lightweight search, exact describe, ordinary native calls, unchanged Code
 * dispatch, strict bounds, and effect-owned cleanup.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcRunRequest, PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import ToolRuntime, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  Config,
  DESCRIBE_TOOLS_NAME,
  INVOKE_TOOL_NAME,
  SEARCH_TOOLS_NAME,
  apply,
  inject,
  name,
} from '../src/index.ts'

const signal = new AbortController().signal

/** Scriptable runtime whose bridge functions are real ToolRuntime bindings. */
class FakeRuntime extends PtcRuntime {
  readonly language: string
  readonly isolation = 'fake'
  behavior: (request: PtcRunRequest) => Promise<PtcRunResult> = () => Promise.resolve({ logs: [] })

  constructor(ctx: Context, config: { language?: string } = {}) {
    super(ctx)
    this.language = config.language ?? 'typescript'
  }

  run(request: PtcRunRequest): Promise<PtcRunResult> {
    return this.behavior(request)
  }
}

interface Mounted {
  ctx: Context
  scope: Scope
  agent: Agent
  row: ReturnType<Context['plugin']>
  runtime: FakeRuntime | undefined
}

/** Build one host catalog and mount the plugin inside an agent scope. */
async function mount(config: Config = {}, options: { language?: string; mode?: 'native' | 'ptc' | 'both'; runtime?: boolean } = {}): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: options.mode ?? 'native' })
  if (options.runtime !== false) {
    await ctx.plugin(FakeRuntime, options.language === undefined ? {} : { language: options.language })
  }
  for (const definition of [
    defineTool({
      name: 'read_file',
      description: 'Read one UTF-8 file from disk.',
      parameters: { path: { type: 'string', required: true, description: 'File path.' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: args => Promise.resolve({ text: 'read:' + args.path }),
    }),
    defineTool({
      name: 'web_search',
      description: 'Search current web information with an intentionally long summary.',
      parameters: { query: { type: 'string', required: true, description: 'Search phrase.' } },
      output: { schema: { type: 'array', items: { type: 'string' } }, render: (_args, value) => [{ type: 'text', text: value.join('\n') }] },
      execute: args => Promise.resolve([args.query]),
    }),
    defineTool({
      name: 'write_file',
      description: 'Write one file.',
      parameters: { path: { type: 'string', required: true }, text: { type: 'string', required: true } },
      output: { schema: { type: 'boolean' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => Promise.resolve(true),
    }),
  ]) ctx.tools.register(definition)

  const session = Session.create(SessionId('discovery-agent'))
  const agent = { id: session.id, session } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  scope.ctx.tools.presentAs(options.mode ?? 'ptc')
  const row = scope.ctx.plugin({ name, inject: [...inject], Config, apply }, config)
  await row.await()
  return { ctx, scope, agent, row, runtime: ctx.get('ptcRuntime') as FakeRuntime | undefined }
}

/** Execute one discovery tool as a nested Code Mode call. */
async function nested(mounted: Mounted, toolName: string, args: unknown) {
  if (mounted.runtime === undefined) throw new Error('nested Code Mode test requires a runtime')
  mounted.runtime.behavior = async (request) => {
    const tools = request.bindings.find(binding => binding.global === 'tools')
    if (tools === undefined) throw new Error('missing tools binding')
    return { logs: [], value: await tools.functions[toolName]!(args) }
  }
  return mounted.ctx.tools.execute({
    callId: ToolCallId('outer'),
    name: RUN_CODE_NAME,
    arguments: { code: 'return null', description: 'test discovery' },
    agent: mounted.agent,
    signal,
  })
}

function valueOf(result: Awaited<ReturnType<typeof nested>>) {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  const outer = result.value as { result?: unknown }
  return outer.result
}

/** Execute one ordinary model tool call without the Code transport. */
async function direct(mounted: Mounted, toolName: string, args: unknown) {
  return mounted.ctx.tools.execute({
    callId: ToolCallId('direct-' + toolName),
    name: toolName,
    arguments: args,
    agent: mounted.agent,
    signal,
  })
}

function directValue(result: Awaited<ReturnType<typeof direct>>) {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  return result.value
}

describe('dsh-progressive-tools', () => {
  it('defaults to all tools and rejects an invalid disclosure selection', () => {
    expect(Config({}).deferTools).toBe('all')
    expect(Config({}).maxDescribeTools).toBe(10)
    expect(Config({ deferTools: 'mcp' }).deferTools).toBe('mcp')
    expect(() => Config({ deferTools: 'invalid' as 'mcp' })).toThrow()
    expect(() => apply(new Context(), { deferTools: 'invalid' as 'mcp' })).toThrow(/deferTools/)
  })

  it.each(['native', 'ptc', 'both'] as const)('exposes ordinary tools immediately and discovers only MCP in %s', async (mode) => {
    const mounted = await mount({ deferTools: 'mcp', eagerTools: ['read_file'] }, { mode })
    const { ctx, agent, scope } = mounted
    const register = (target: Context, toolName: string) => target.tools.register(defineTool({
      name: toolName,
      description: 'Echo a message.',
      parameters: { message: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: args => Promise.resolve(args.message),
    }))
    const removeMcp = register(ctx, 'mcp__fixture__echo')
    try {
      const before = await ctx.systemPrompt.assemble({ scope: agent })
      const names = before.tools.map(tool => tool.name)
      const sdk = before.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
      for (const ordinary of ['read_file', 'write_file', 'web_search']) {
        if (mode !== 'ptc') expect(names).toContain(ordinary)
        if (mode !== 'native') expect(sdk).toContain(ordinary)
      }
      expect(names).not.toContain('mcp__fixture__echo')
      expect(sdk).not.toContain('mcp__fixture__echo')
      expect(names.filter(name => name === 'read_file')).toHaveLength(mode === 'ptc' ? 0 : 1)
      const call = async (name: string, args: unknown) => mode === 'ptc'
        ? valueOf(await nested(mounted, name, args)) : directValue(await direct(mounted, name, args))
      expect(await call(SEARCH_TOOLS_NAME, {})).toMatchObject({
        total: 1, matches: [{ name: 'mcp__fixture__echo' }],
      })
      expect(await call(DESCRIBE_TOOLS_NAME, { names: ['mcp__fixture__echo'] })).toMatchObject({
        tools: [{ name: 'mcp__fixture__echo', parameters: { properties: { message: { type: 'string' } } } }],
      })
      expect(await call('read_file', { path: 'visible.txt' })).toEqual({ text: 'read:visible.txt' })
      expect(await call('mcp__fixture__echo', { message: 'discovered' })).toBe('discovered')
      if (mode === 'native') {
        expect(await call(INVOKE_TOOL_NAME, { name: 'mcp__fixture__echo', arguments: { message: 'fallback' } })).toBe('fallback')
      }
      const removeOrdinary = register(scope.ctx, 'local_echo')
      const changed = await ctx.systemPrompt.assemble({ scope: agent })
      expect(JSON.stringify(changed)).toContain('local_echo')
      const other = { id: SessionId('other'), session: Session.create(SessionId('other')) } as Agent
      let otherScope!: Scope
      await ctx.plugin(Object.assign((inner: Context) => { otherScope = createScope(inner, other) }, { inject: ['tools', 'systemPrompt'] }))
      otherScope.ctx.tools.presentAs(mode)
      const [, otherAssembly] = await Promise.all([
        ctx.systemPrompt.assemble({ scope: agent }), ctx.systemPrompt.assemble({ scope: other }),
      ])
      expect(JSON.stringify(otherAssembly)).not.toContain('local_echo')
      removeOrdinary()
      removeMcp()
      expect(await ctx.systemPrompt.assemble({ scope: agent })).toEqual(before)
      expect(await call(SEARCH_TOOLS_NAME, {})).toMatchObject({ total: 0, matches: [] })
      await mounted.row.dispose()
      expect(ctx.tools.get(SEARCH_TOOLS_NAME, agent)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('declares its exact dependencies, validates config, and mounts globally', async () => {
    expect(inject).toEqual(['tools', 'systemPrompt', 'llm'])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, { mode: 'ptc' })
    await ctx.plugin(FakeRuntime)
    expect(() => { apply(ctx, { maxSearchResults: Number.NaN }) }).toThrow(/positive safe integer/)
    expect(() => { apply(ctx, { maxDescribeTools: 1.5 }) }).toThrow(/positive safe integer/)

    const row = ctx.plugin({ name, inject: [...inject], Config, apply }, {})
    await row.await()
    const plainAfter = await ctx.systemPrompt.assemble()
    expect(plainAfter.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    expect(plainAfter.sections.find(section => section.name === 'tools:progressive-disclosure'))
      .toBeUndefined()

    const session = Session.create(SessionId('global-mount'))
    const agent = { id: session.id, session } as unknown as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
      { inject: ['tools', 'systemPrompt'] }))
    scope.ctx.tools.presentAs('native')
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    expect(assembly.tools.map(tool => tool.name).sort())
      .toEqual([DESCRIBE_TOOLS_NAME, INVOKE_TOOL_NAME, SEARCH_TOOLS_NAME].sort())
    await ctx.fiber.dispose()
  })

  it('stabilizes Native wire tools and supports direct-first standard calls without code runtime', async () => {
    const mounted = await mount({}, { mode: 'native', runtime: false })
    const assembly = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([DESCRIBE_TOOLS_NAME, INVOKE_TOOL_NAME, SEARCH_TOOLS_NAME].sort())
    expect(assembly.sections.find(section => section.name === 'tools:progressive-disclosure')?.text)
      .toContain('ordinary tool call')
    expect(mounted.ctx.get('ptcRuntime')).toBeUndefined()

    const search = directValue(await direct(mounted, SEARCH_TOOLS_NAME, { query: 'web' })) as {
      matches: { name: string; description: string }[]
    }
    expect(search.matches).toEqual([{
      name: 'web_search',
      description: 'Search current web information with an intentionally long summary.',
    }])
    expect(directValue(await direct(mounted, 'web_search', { query: 'native' }))).toEqual(['native'])

    const missing = await direct(mounted, 'not_a_real_tool', {})
    expect(missing).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    const described = directValue(await direct(mounted, DESCRIBE_TOOLS_NAME, { names: ['web_search'] })) as Record<string, unknown>
    expect(described).not.toHaveProperty('sdk')
    expect(described).not.toHaveProperty('language')
    expect(directValue(await direct(mounted, INVOKE_TOOL_NAME, {
      name: 'web_search',
      arguments: { query: 'fallback' },
    }))).toEqual(['fallback'])
  })

  it('stabilizes Both wire tools while keeping direct and Code invocation available', async () => {
    const mounted = await mount({}, { mode: 'both' })
    const assembly = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual([
      RUN_CODE_NAME, SEARCH_TOOLS_NAME, DESCRIBE_TOOLS_NAME,
    ].sort())
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toContain('ordinary tool call')
    expect(sdk).toContain(SEARCH_TOOLS_NAME)
    expect(sdk).not.toContain('web_search')
    const search = directValue(await direct(mounted, SEARCH_TOOLS_NAME, { query: 'web' })) as { matches: { name: string }[] }
    expect(search.matches.map(match => match.name)).toEqual(['web_search'])
    expect(directValue(await direct(mounted, 'web_search', { query: 'both' }))).toEqual(['both'])
  })

  it.each(['native', 'ptc', 'both'] as const)('shows configured discovery limits before calls in %s', async (mode) => {
    const mounted = await mount({
      maxSearchResults: 2,
      maxDescribeTools: 4,
      maxSummaryChars: 6,
      maxQueryChars: 3,
      maxToolNameChars: 5,
      maxResultBytes: 512,
    }, { mode })
    const assembly = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    const directSchemas = mode === 'ptc' ? '' : JSON.stringify(assembly.tools)
    const sdk = mode === 'native'
      ? ''
      : assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    const visible = directSchemas + sdk

    expect(visible).toContain('at most 2 matches')
    expect(visible).toContain('Summaries are capped at 6 characters')
    expect(visible).toContain('up to 3 characters')
    expect(visible).toContain('capped at 2')
    expect(visible).toContain('Describe 1-4 named tools per call')
    expect(visible).toMatch(/[Ss]plit larger sets across (?:describe_tools )?calls/u)
    expect(visible).toContain('result limit: 512 UTF-8 bytes')
    expect(visible).toContain('Each name is at most 5 characters')
    if (mode === 'native') expect(visible).toContain('at most 5 characters')
  })

  it('keeps the Native request prefix byte-stable across hidden catalog changes', async () => {
    const mounted = await mount({}, { mode: 'native', runtime: false })
    const before = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    const prefix = JSON.stringify({ sections: before.sections, tools: before.tools })
    const initial = directValue(await direct(mounted, SEARCH_TOOLS_NAME, { query: 'probe' })) as {
      total: number
      matches: { name: string }[]
    }
    expect(initial.total).toBe(3)
    expect(initial.matches.map(match => match.name)).toEqual(['read_file', 'web_search', 'write_file'])

    const dispose = mounted.ctx.tools.register(defineTool({
      name: 'win_terminal_probe',
      description: 'Probe one terminal capability.',
      parameters: { target: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: args => Promise.resolve('probe:' + args.target),
    }))
    const added = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    expect(JSON.stringify({ sections: added.sections, tools: added.tools })).toBe(prefix)
    const found = directValue(await direct(mounted, SEARCH_TOOLS_NAME, { query: 'probe' })) as {
      matches: { name: string; description: string }[]
    }
    expect(found.matches).toEqual([{
      name: 'win_terminal_probe',
      description: 'Probe one terminal capability.',
    }])
    expect(directValue(await direct(mounted, 'win_terminal_probe', { target: 'pwsh' }))).toBe('probe:pwsh')

    dispose()
    const removed = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    expect(JSON.stringify({ sections: removed.sections, tools: removed.tools })).toBe(prefix)
    const unavailable = await direct(mounted, 'win_terminal_probe', { target: 'pwsh' })
    expect(unavailable).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
  })
  it('keeps Code and Both request prefixes stable across hidden catalog changes', async () => {
    for (const mode of ['ptc', 'both'] as const) {
      const mounted = await mount({}, { mode })
      const before = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
      const prefix = JSON.stringify({ sections: before.sections, tools: before.tools })
      const dispose = mounted.ctx.tools.register(defineTool({
        name: 'dynamic_' + mode,
        description: 'One dynamic hidden tool.',
        parameters: {},
        output: { schema: { type: 'boolean' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: () => Promise.resolve(true),
      }))
      const after = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
      expect(JSON.stringify({ sections: after.sections, tools: after.tools })).toBe(prefix)
      dispose()
    }
  })
  it('replaces only the scoped Code Mode SDK and keeps eager tools', async () => {
    const mounted = await mount({ eagerTools: ['read_file'] })
    const eagerSearch = valueOf(await nested(mounted, SEARCH_TOOLS_NAME, { query: '*' })) as { matches: { name: string }[] }
    expect(eagerSearch.matches.map(match => match.name)).not.toContain('read_file')
    const compact: PromptAssembly = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    const sdk = compact.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    const firstPrompt = JSON.stringify(compact.sections)
    const assembledAgain: PromptAssembly = await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    const secondPrompt = JSON.stringify(assembledAgain.sections)

    expect(secondPrompt).toBe(firstPrompt)
    expect(compact.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    expect(sdk).toContain(SEARCH_TOOLS_NAME)
    expect(sdk).toContain(DESCRIBE_TOOLS_NAME)
    expect(sdk).toContain('read_file')
    expect(sdk).not.toContain('web_search')
    expect(sdk).not.toContain('write_file')

    const plain = await mounted.ctx.systemPrompt.assemble()
    expect(plain.sections.find(section => section.name === 'tools:sdk')).toBeUndefined()
    expect(plain.tools.map(tool => tool.name)).toEqual(['read_file', 'web_search', 'write_file'])
  })

  it('requires ptcRuntime only when a Code surface is actually assembled', async () => {
    const native = await mount({}, { mode: 'native', runtime: false })
    await expect(native.ctx.systemPrompt.assemble({ scope: native.agent })).resolves.toBeDefined()
    const code = await mount({}, { mode: 'ptc', runtime: false })
    await expect(code.ctx.systemPrompt.assemble({ scope: code.agent })).rejects.toThrow(/requires (?:ctx\.ptcRuntime|a code runtime)/)
  })

  it('renders the compact SDK in the active runtime language', async () => {
    const mounted = await mount({}, { language: 'python' })
    const sdk = (await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent }))
      .sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toContain('class Tools(Protocol)')
    expect(sdk).toContain('async def search_tools')
    expect(sdk).not.toContain('interface ToolArgsMap')
  })

  it('searches the current scoped catalog deterministically with complete-result bounds', async () => {
    const mounted = await mount({ maxSearchResults: 1, maxSummaryChars: 12 })
    const result = valueOf(await nested(mounted, SEARCH_TOOLS_NAME, { query: '*', limit: 99 })) as {
      total: number
      truncated: boolean
      matches: { name: string; description: string }[]
    }
    expect(result).toEqual({
      total: 3,
      truncated: true,
      matches: [{ name: 'read_file', description: 'Read one UTF…' }],
    })

    const exact = valueOf(await nested(mounted, SEARCH_TOOLS_NAME, { query: 'web current' })) as {
      matches: { name: string }[]
    }
    expect(exact.matches.map(match => match.name)).toEqual(['web_search'])
  })

  it('lists the lightweight catalog by default and makes verbose searches non-blocking', async () => {
    const mounted = await mount({ maxSearchResults: 1 })
    mounted.ctx.tools.register(defineTool({
      name: 'pwsh',
      description: 'Run a PowerShell command in the current working directory and inspect filesystem folders.',
      parameters: { command: { type: 'string', required: true, description: 'PowerShell command such as pwd or listing directories.' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('ok'),
    }))

    const catalog = valueOf(await nested(mounted, SEARCH_TOOLS_NAME, {})) as {
      total: number
      truncated: boolean
      matches: { name: string; description: string }[]
    }
    expect(catalog.total).toBe(4)
    expect(catalog.truncated).toBe(false)
    expect(catalog.matches.map(match => match.name)).toEqual(['pwsh', 'read_file', 'web_search', 'write_file'])
    expect(catalog.matches.every(match => Object.keys(match).join(',') === 'name,description')).toBe(true)

    const verbose = valueOf(await nested(mounted, SEARCH_TOOLS_NAME, {
      query: 'pwd current working directory list directories count folders filesystem',
      limit: 10,
    })) as { matches: { name: string }[] }
    expect(verbose.matches.map(match => match.name)).toEqual(['pwsh'])

    const fallback = valueOf(await nested(mounted, SEARCH_TOOLS_NAME, {
      query: 'quantum-entanglement capability that does not exist',
    })) as { total: number; matches: { name: string }[] }
    expect(fallback.total).toBe(4)
    expect(fallback.matches.map(match => match.name)).toEqual(['pwsh', 'read_file', 'web_search', 'write_file'])
  })

  it('describes exact schemas and the active runtime SDK excerpt', async () => {
    const mounted = await mount({ maxDescribeTools: 2 })
    const result = valueOf(await nested(mounted, DESCRIBE_TOOLS_NAME, { names: ['web_search', 'read_file'] })) as {
      tools: { name: string; parameters: unknown; output: unknown }[]
      language: string
      sdk: string
    }
    expect(result.tools.map(tool => tool.name)).toEqual(['web_search', 'read_file'])
    expect(result.tools[0]?.parameters).toMatchObject({ type: 'object' })
    expect(result.tools[0]?.output).toMatchObject({ type: 'array' })
    expect(result.language).toBe('typescript')
    expect(result.sdk).toContain('web_search')
    expect(result.sdk).not.toContain('async def web_search')
  })

  it('fails closed for invalid queries, unknown tools, configured counts, and complete result bytes', async () => {
    const mounted = await mount({ maxDescribeTools: 1, maxQueryChars: 3, maxToolNameChars: 4 })
    expect((await nested(mounted, SEARCH_TOOLS_NAME, { query: 'long' })).isError).toBe(true)
    expect((await nested(mounted, DESCRIBE_TOOLS_NAME, { names: ['missing'] })).isError).toBe(true)
    expect((await nested(mounted, DESCRIBE_TOOLS_NAME, { names: ['xxxxx'] })).isError).toBe(true)
    expect((await nested(mounted, DESCRIBE_TOOLS_NAME, { names: ['read_file', 'read_file'] })).isError).toBe(true)
    expect((await nested(mounted, DESCRIBE_TOOLS_NAME, { names: ['read_file', 'web_search'] })).isError).toBe(true)
    const byteBounded = await mount({ maxResultBytes: 10 })
    expect((await nested(byteBounded, SEARCH_TOOLS_NAME, { query: '*' })).isError).toBe(false)
    expect((await nested(byteBounded, DESCRIBE_TOOLS_NAME, { names: ['read_file'] })).isError).toBe(true)
  })

  it('keeps hidden tools executable through the ordinary nested policy pipeline', async () => {
    const mounted = await mount()
    await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })
    const directDenied = await direct(mounted, 'web_search', { query: 'direct-code' })
    expect(directDenied).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    const seen: string[] = []
    const dispatchesBefore = mounted.agent.session.ownEvents().filter(event => event.type === 'tool/ptc-dispatch').length
    mounted.scope.ctx.on('tools/pre-execute', async (exec, next) => {
      seen.push(exec.name)
      return next()
    })
    if (mounted.runtime === undefined) throw new Error('nested Code Mode test requires a runtime')
  mounted.runtime.behavior = async (request) => {
      const tools = request.bindings.find(binding => binding.global === 'tools')!
      return { logs: [], value: await tools.functions.web_search!({ query: 'fresh' }) }
    }
    const result = await mounted.ctx.tools.execute({
      callId: ToolCallId('outer-hidden'),
      name: RUN_CODE_NAME,
      arguments: { code: 'return tools.web_search({ query: "fresh" })', description: 'call discovered tool' },
      agent: mounted.agent,
      signal,
    })
    expect(valueOf(result)).toEqual(['fresh'])
    expect(seen).toEqual([RUN_CODE_NAME, 'web_search'])
    const dispatches = mounted.agent.session.ownEvents().filter(event => event.type === 'tool/ptc-dispatch')
    expect(dispatches).toHaveLength(dispatchesBefore + 1)
    expect(dispatches.at(-1)?.data).toMatchObject({ name: 'web_search', arguments: { query: 'fresh' } })
  })

  it('unwinds tools and the SDK transform with its fiber', async () => {
    const mounted = await mount()
    await mounted.row.dispose()
    expect(mounted.ctx.tools.get(SEARCH_TOOLS_NAME, mounted.agent)).toBeUndefined()
    expect(mounted.ctx.tools.get(DESCRIBE_TOOLS_NAME, mounted.agent)).toBeUndefined()
    const sdk = (await mounted.ctx.systemPrompt.assemble({ scope: mounted.agent }))
      .sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toContain('web_search')
    expect(sdk).not.toContain('Progressive tool disclosure')
  })

  it('validates eager tool configuration and current scope visibility', async () => {
    await expect(mount({ eagerTools: ['read_file', 'read_file'] })).rejects.toThrow(/duplicate/)
    const mounted = await mount({ eagerTools: ['missing'] })
    await expect(mounted.ctx.systemPrompt.assemble({ scope: mounted.agent })).rejects.toThrow(/not visible/)
  })
})
