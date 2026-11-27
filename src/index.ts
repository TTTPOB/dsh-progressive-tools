/**
 * Direct-first progressive tool disclosure for Native and PTC modes:
 * keep the model-visible prefix stable while scoped ToolRuntime stays live.
 * @module dsh-progressive-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import {
  RUN_CODE_NAME,
  defineTool,
} from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, ToolDefinition, ToolExecutor, ToolPromptSection, ToolBatchInput, ToolBatchResult, ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tool-executor-ptc'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { installNativeDeferredBridge } from './native-deferred.ts'

/** Stable model-facing name of the catalog search tool. */
export const SEARCH_TOOLS_NAME = 'search_tools'
/** Stable model-facing name of the exact-schema lookup tool. */
export const DESCRIBE_TOOLS_NAME = 'describe_tools'
/** Stable fallback transport declared only to non-deferred provider APIs. */
export const INVOKE_TOOL_NAME = 'invoke_tool'

const DISCOVERY_NAMES = new Set([RUN_CODE_NAME, SEARCH_TOOLS_NAME, DESCRIBE_TOOLS_NAME, INVOKE_TOOL_NAME])

/** Ordered presentation override; the last matching rule wins. */
export type ToolDisclosureRule = ({ glob: string; regex?: never } | { regex: string; glob?: never }) & {
  disclosure: 'eager' | 'deferred'
}

/** Plugin config: every catalog bound and eager declaration is deployment-owned. */
export interface Config {
  /** Ordered whole-name glob or JavaScript regex overrides. */
  toolDisclosureRules?: ToolDisclosureRule[]
  /** Stable non-discovery tools declared eagerly on the projected model surface. */
  eagerTools?: string[]
  /** Maximum filtered matches, or explicitly limited catalog entries, one search may return. */
  maxSearchResults?: number
  /** Maximum exact tool definitions one describe call may return. */
  maxDescribeTools?: number
  /** Maximum characters copied from one tool description into search results. */
  maxSummaryChars?: number
  /** Maximum characters accepted in one search query. */
  maxQueryChars?: number
  /** Maximum characters accepted in one exact tool name. */
  maxToolNameChars?: number
  /** Maximum UTF-8 bytes in one exact-schema describe result. */
  maxResultBytes?: number
}

const DEFAULTS = {
  toolDisclosureRules: [] as ToolDisclosureRule[],
  eagerTools: [] as string[],
  maxSearchResults: 10,
  maxDescribeTools: 10,
  maxSummaryChars: 240,
  maxQueryChars: 500,
  maxToolNameChars: 200,
  maxResultBytes: 1_048_576,
} as const

/** Validated Loader schema for Config. */
const configSchema: z<Config> = z.object({
  toolDisclosureRules: z.any<ToolDisclosureRule[]>(),
  eagerTools: z.array(z.string()).default([]),
  maxSearchResults: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxSearchResults),
  maxDescribeTools: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxDescribeTools),
  maxSummaryChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxSummaryChars),
  maxQueryChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxQueryChars),
  maxToolNameChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxToolNameChars),
  maxResultBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULTS.maxResultBytes),
})

export const Config: z<Config> = z.transform(configSchema, (config) => {
  resolveConfig(config)
  return { ...config, toolDisclosureRules: config.toolDisclosureRules ?? [] }
})

/** Cordis plugin name. */
export const name = 'agent-progressive-tools'
/** Always-required services; PTC runtime is resolved only for PTC assembly. */
export const inject = ['tools', 'systemPrompt', 'llm']

interface ResolvedConfig {
  toolDisclosureRules: { pattern: RegExp; disclosure: 'eager' | 'deferred' }[]
  eagerTools: string[]
  maxSearchResults: number
  maxDescribeTools: number
  maxSummaryChars: number
  maxQueryChars: number
  maxToolNameChars: number
  maxResultBytes: number
}

interface CatalogTool extends ToolSchema {
  parameters: Record<string, unknown>
  output: JsonSchemaNode
}

export type PresentationMode = 'native' | 'ptc'

interface SearchMatch {
  name: string
  description: string
  score: number
}

/** Resolve defaults for direct programmatic callers as well as the Loader. */
function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    toolDisclosureRules: compileRules(config.toolDisclosureRules === undefined ? DEFAULTS.toolDisclosureRules : config.toolDisclosureRules),
    eagerTools: [...config.eagerTools ?? DEFAULTS.eagerTools],
    maxSearchResults: config.maxSearchResults ?? DEFAULTS.maxSearchResults,
    maxDescribeTools: config.maxDescribeTools ?? DEFAULTS.maxDescribeTools,
    maxSummaryChars: config.maxSummaryChars ?? DEFAULTS.maxSummaryChars,
    maxQueryChars: config.maxQueryChars ?? DEFAULTS.maxQueryChars,
    maxToolNameChars: config.maxToolNameChars ?? DEFAULTS.maxToolNameChars,
    maxResultBytes: config.maxResultBytes ?? DEFAULTS.maxResultBytes,
  }
  if ('deferTools' in config) {
    throw new Error('dsh-progressive-tools: deferTools was removed; migrate to toolDisclosureRules')
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (key === 'eagerTools' || key === 'toolDisclosureRules') continue
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new Error(`dsh-progressive-tools: ${key} must be a positive safe integer`)
    }
  }
  const duplicate = resolved.eagerTools.find((tool, index) => resolved.eagerTools.indexOf(tool) !== index)
  if (duplicate !== undefined) {
    throw new Error('dsh-progressive-tools: eagerTools contains duplicate ' + JSON.stringify(duplicate))
  }
  for (const eager of resolved.eagerTools) {
    if (eager.length === 0) throw new Error('dsh-progressive-tools: eagerTools cannot contain an empty name')
    if (DISCOVERY_NAMES.has(eager)) {
      throw new Error('dsh-progressive-tools: eagerTools cannot name reserved disclosure infrastructure ' + JSON.stringify(eager))
    }
  }
  return resolved
}

/** Compile once at load; names need not exist yet. Globs support only * and ?. */
function compileRules(rules: ToolDisclosureRule[]): ResolvedConfig['toolDisclosureRules'] {
  if (!Array.isArray(rules)) throw new Error('toolDisclosureRules must be an ordered array')
  return rules.map((rule, index) => {
    const fail = () => new Error(
      'toolDisclosureRules[' + String(index) + '] must have exactly one glob:string or regex:string and disclosure:eager|deferred',
    )
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) throw fail()
    const keys = Object.keys(rule)
    const hasGlob = 'glob' in rule
    if (hasGlob === ('regex' in rule) || keys.length !== 2
      || (rule.disclosure !== 'eager' && rule.disclosure !== 'deferred')) throw fail()
    const source = hasGlob ? rule.glob : rule.regex
    if (typeof source !== 'string') throw fail()
    // Escape all regex punctuation except the two supported glob wildcards.
    const pattern = hasGlob
      ? new RegExp('^(?:' + Array.from(source, char => char === '*' ? '[\\s\\S]*'
        : char === '?' ? '[\\s\\S]' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + ')(?![\\s\\S])', 'u')
      : new RegExp(source)
    return { pattern, disclosure: rule.disclosure }
  })
}

/** Shared classification for wire declarations, SDK, and all catalog paths. */
function isDeferred(definition: ToolDefinition, config: ResolvedConfig): boolean {
  if (DISCOVERY_NAMES.has(definition.name)) return false
  for (let index = config.toolDisclosureRules.length - 1; index >= 0; index--) {
    const rule = config.toolDisclosureRules[index]!
    if (rule.pattern.test(definition.name)) return rule.disclosure === 'deferred'
  }
  if (config.eagerTools.includes(definition.name)) return false
  // Own deferLoading:true is honored; the default also defers every remaining tool.
  return true
}

/** One scope's deferred catalog, projected from ToolRuntime's authoritative view. */
function catalog(ctx: Context, scope: ScopeKey | undefined, config: ResolvedConfig, toolSet: ResolvedToolSet | undefined): CatalogTool[] {
  const result: CatalogTool[] = []
  for (const definition of ctx.tools.definitions(scope, toolSet).filter(definition => ctx.tools.executable(definition.name, scope, toolSet) === definition)) {
    const schema = sdkSchema(definition)
    if (!isDeferred(definition, config)) continue
    result.push({
      name: schema.name,
      description: schema.description,
      parameters: structuredClone(schema.parameters),
      output: structuredClone(definition.output.schema),
    })
  }
  return result.sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

/** Character-safe summary bound for model-facing search results. */
function graphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text),
    part => part.segment,
  )
}

/** Grapheme-safe summary bound for model-facing search results. */
function summarize(text: string, maxChars: number): string {
  const characters = graphemes(text)
  return characters.length <= maxChars ? text : characters.slice(0, maxChars).join('') + '…'
}

/** Normalize prose and identifiers into one deterministic lexical surface. */
function searchableText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .toLocaleLowerCase('en-US')
}

/** Extract useful query/index terms without making stop words hard requirements. */
function lexicalTerms(text: string): string[] {
  return [...new Set(searchableText(text).split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))]
}

/** Small deterministic English inflection expansion, not a semantic synonym table. */
function termForms(term: string): string[] {
  const forms = new Set([term])
  if (/^[a-z]+$/u.test(term)) {
    if (term.length > 4 && term.endsWith('ies')) forms.add(term.slice(0, -3) + 'y')
    if (term.length > 3 && term.endsWith('es')) forms.add(term.slice(0, -2))
    if (term.length > 3 && term.endsWith('s')) forms.add(term.slice(0, -1))
  }
  return [...forms]
}

/** Deterministic relaxed lexical relevance; any useful term may produce a candidate. */
function relevance(tool: CatalogTool, query: string): number {
  if (query === '*') return 1
  const terms = lexicalTerms(query)
  if (terms.length === 0) return 0
  const name = searchableText(tool.name)
  const description = searchableText(tool.description)
  const schema = searchableText(JSON.stringify(tool.parameters))
  const nameTerms = new Set(lexicalTerms(name))
  const descriptionTerms = new Set(lexicalTerms(description))
  const schemaTerms = new Set(lexicalTerms(schema))
  let score = name === query ? 1_000 : name.startsWith(query) ? 500 : name.includes(query) ? 250 : 0
  let matchedTerms = 0
  for (const term of terms) {
    const forms = termForms(term)
    const exactName = forms.some(form => nameTerms.has(form))
    const partialName = !exactName && forms.some(form => form.length > 2 && name.includes(form))
    const exactDescription = forms.some(form => descriptionTerms.has(form))
    const partialDescription = !exactDescription && forms.some(form => form.length > 2 && description.includes(form))
    const exactSchema = forms.some(form => schemaTerms.has(form))
    const partialSchema = !exactSchema && forms.some(form => form.length > 2 && schema.includes(form))
    if (exactName) score += 100
    else if (partialName) score += 60
    if (exactDescription) score += 30
    else if (partialDescription) score += 15
    if (exactSchema) score += 8
    else if (partialSchema) score += 3
    if (exactName || partialName || exactDescription || partialDescription || exactSchema || partialSchema) {
      matchedTerms += 1
    }
  }
  return matchedTerms === 0 ? 0 : score + Math.round(100 * matchedTerms / terms.length)
}

/** Enforce the configured complete rendered-result byte bound. */
function boundedResult<T>(value: T, maxBytes: number, toolName: string): T {
  const bytes = Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8')
  if (bytes > maxBytes) {
    throw new Error(`${toolName} result is ${String(bytes)} UTF-8 bytes, exceeding the configured ${String(maxBytes)}-byte limit; request fewer or narrower tools`)
  }
  return value
}

/** Validate and normalize one model-written search query; blank means catalog listing. */
function queryText(query: string | undefined, maxChars: number): string {
  const normalized = query?.trim() ?? ''
  if (graphemes(normalized).length > maxChars) {
    throw new Error(`search_tools query exceeds the configured ${String(maxChars)}-character limit`)
  }
  return normalized.length === 0 ? '*' : searchableText(normalized)
}

/** SDK schema shape consumed by both first-party renderers. */
function sdkSchema(definition: ToolDefinition): CatalogTool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: definition.output.schema,
  }
}

/** Render the runtime's language while retaining the registry-owned SDK contract. */
function renderSdk(ctx: Context, schemas: CatalogTool[]): { language: string; sdk: string } {
  const runtime = ctx.get('ptcRuntime')
  if (runtime === undefined) {
    throw new Error('dsh-progressive-tools: PTC presentation requires ctx.ptcRuntime')
  }
  switch (runtime.language) {
    case 'typescript': return { language: runtime.language, sdk: renderToolsSdk(schemas, runtime.programFormat) }
    case 'python': return { language: runtime.language, sdk: renderToolsSdkPy(schemas) }
    default: {
      throw new Error('dsh-progressive-tools: unsupported code runtime language '
        + JSON.stringify(runtime.language))
    }
  }
}

const DISCOVERY_SECTION = 'tools:progressive-disclosure'

function discoveryInstructions(mode: PresentationMode): string {
  const invocation = mode === 'ptc'
    ? 'In a later run_code call the returned exact name as tools[exactName](arguments).'
    : 'On a later model step, issue an ordinary tool call using the returned exact name and arguments. If this interface declares invoke_tool instead, call invoke_tool with that exact name and arguments.'
  return [
    '## Progressive tool disclosure',
    '',
    'Use tools already declared in this interface or SDK directly; they do not require search_tools or describe_tools.',
    'For deferred tools, start with search_tools({}) or search_tools({ query: "*" }) when you need their complete lightweight catalog of names and summaries. A text query is only an optional ranking filter and falls back to that catalog when nothing matches.',
    'Call describe_tools with only the exact deferred tool names you intend to use.',
    'describe_tools returns the exact input and output schemas; in Code Mode it also returns the active-runtime SDK excerpt.',
    invocation,
    '',
    'Do not invent tool names or arguments. A standard call to an unavailable, restricted, or removed tool is expected to fail with the current ToolRuntime reason.',
    'Discovery changes presentation only: permission, approval, guards, scheduling, and auditing remain authoritative at execution time.',
  ].join('\n')
}

/** Host-owned disclosure configuration shared by every scoped executor. */
export interface ProgressiveTools {
  /** Wrap a selected executor without changing its execution authority. */
  wrap(executor: ToolExecutor, mode: PresentationMode, scope?: ScopeKey): ToolExecutor
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    progressiveTools: ProgressiveTools
  }
}

/** Compose presentation filtering with the scoped executor's batch implementation. */
export class ProgressiveExecutor implements ToolExecutor {
  readonly sections: readonly ToolPromptSection[]
  private readonly delegate: ToolExecutor

  constructor(ctx: Context, executor: ToolExecutor, mode: PresentationMode) {
    this.delegate = ctx.progressiveTools.wrap(executor, mode, scopeOf(ctx))
    this.sections = this.delegate.sections ?? []
  }

  describe(tools: readonly ToolDefinition[]) { return this.delegate.describe(tools) }
  execute(input: ToolBatchInput): Promise<ToolBatchResult> { return this.delegate.execute(input) }
}

/** Register discovery tools and the all-mode stable presentation projection. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const presentationModes = new WeakMap<object, PresentationMode>()
  const modeFor = (agent: object | undefined, nested: boolean): PresentationMode =>
    agent === undefined ? nested ? 'ptc' : 'native' : presentationModes.get(agent) ?? (nested ? 'ptc' : 'native')

  const searchTool = defineTool({
    name: SEARCH_TOOLS_NAME,
    description: `List or search deferred tools by name and summary. Text searches and limited responses return at most ${String(resolved.maxSearchResults)} matches; full listings may be larger. Summaries are capped at ${String(resolved.maxSummaryChars)} characters.`,
    parameters: {
      query: { type: 'string', description: `Optional OR-ranked capability words, up to ${String(resolved.maxQueryChars)} characters; omit or use * to list all.` },
      limit: { type: 'integer', description: `Optional positive page size; capped at ${String(resolved.maxSearchResults)}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const query = queryText(args.query, resolved.maxQueryChars)
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
        throw new Error('search_tools limit must be a positive safe integer')
      }
      const tools = catalog(ctx, exec.agent, resolved, exec.toolSet)
      const catalogMatches: SearchMatch[] = tools.map(tool => ({
        name: tool.name,
        description: summarize(tool.description, resolved.maxSummaryChars),
        score: 1,
      }))
      const ranked: SearchMatch[] = query === '*' ? [] : tools
        .map(tool => ({
          name: tool.name,
          description: summarize(tool.description, resolved.maxSummaryChars),
          score: relevance(tool, query),
        }))
        .filter(match => match.score > 0)
        .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, 'en'))
      const matches = ranked.length > 0 ? ranked : catalogMatches
      const limit = args.limit === undefined
        ? ranked.length > 0 ? resolved.maxSearchResults : matches.length
        : Math.min(args.limit, resolved.maxSearchResults)
      return Promise.resolve({
        total: matches.length,
        truncated: matches.length > limit,
        matches: matches.slice(0, limit).map(({ score: _score, ...match }) => match),
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Search tools', kind: 'read', rawInput: summarize(args.query?.trim() || '*', 100) }),
  })

  const describeTool = defineTool({
    name: DESCRIBE_TOOLS_NAME,
    description: `Describe 1-${String(resolved.maxDescribeTools)} named tools per call with exact schemas; PTC also returns an SDK excerpt. Split larger sets across calls; result limit: ${String(resolved.maxResultBytes)} UTF-8 bytes.`,
    parameters: {
      names: { type: 'array', required: true, items: { type: 'string' }, description: `1-${String(resolved.maxDescribeTools)} exact search_tools names per call; split larger sets across describe_tools calls. Each name is at most ${String(resolved.maxToolNameChars)} characters.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                description: { type: 'string', required: true },
                parameters: { type: 'json', required: true },
                output: { type: 'json', required: true },
              },
            },
          },
          language: { type: 'string' },
          sdk: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      if (args.names.length === 0) throw new Error('describe_tools names must not be empty')
      if (args.names.length > resolved.maxDescribeTools) {
        throw new Error(`describe_tools accepts at most ${String(resolved.maxDescribeTools)} names per call`)
      }
      for (const toolName of args.names) {
        if (toolName.length === 0) throw new Error('describe_tools names cannot contain an empty name')
        if (graphemes(toolName).length > resolved.maxToolNameChars) {
          throw new Error(`describe_tools tool names cannot exceed ${String(resolved.maxToolNameChars)} characters`)
        }
      }
      const names = [...new Set(args.names)]
      const tools = catalog(ctx, exec.agent, resolved, exec.toolSet)
      const byName = new Map(tools.map(tool => [tool.name, tool]))
      const absent = names.filter(toolName => !byName.has(toolName))
      if (absent.length > 0) {
        const eager = absent.filter(toolName => {
          const definition = ctx.tools.executable(toolName, exec.agent, exec.toolSet)
          return definition !== undefined && !isDeferred(definition, resolved)
        })
        const missingCount = absent.length - eager.length
        const messages: string[] = []
        if (missingCount > 0) {
          messages.push('describe_tools received unknown or unavailable tool' + (missingCount === 1 ? '' : 's'))
        }
        if (eager.length > 0) {
          messages.push(eager.join(', ') + (eager.length === 1
            ? ' is already declared directly; call it without describe_tools'
            : ' are already declared directly; call them without describe_tools'))
        }
        throw new Error(messages.join('. '))
      }
      const selected = names.map(toolName => byName.get(toolName) as CatalogTool)
      const result = {
        tools: selected.map(tool => ({
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters) as unknown as JsonValue,
          output: structuredClone(tool.output) as unknown as JsonValue,
        })),
      }
      if (modeFor(exec.agent, exec.parent !== undefined) === 'native') {
        return Promise.resolve(boundedResult(result, resolved.maxResultBytes, DESCRIBE_TOOLS_NAME))
      }
      const rendered = renderSdk(exec.agent?.ctx ?? ctx, selected)
      return Promise.resolve(boundedResult({
        ...result,
        language: rendered.language,
        sdk: rendered.sdk,
      }, resolved.maxResultBytes, DESCRIBE_TOOLS_NAME))
    },
    presentCall: args => ({
      card: 'generic',
      title: `Describe ${String(args.names.length)} tool${args.names.length === 1 ? '' : 's'}`,
      kind: 'read',
      rawInput: String(args.names.length) + ' requested name(s)',
    }),
  })

  const invokeTool = defineTool({
    name: INVOKE_TOOL_NAME,
    description: 'Invoke one exact tool returned by describe_tools when the provider cannot load its schema as a standard tool call.',
    parameters: {
      name: { type: 'string', required: true, description: `Exact describe_tools name, at most ${String(resolved.maxToolNameChars)} characters.` },
      arguments: { type: 'json', required: true, description: 'Arguments matching that tool\'s exact input schema.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (args.name.length === 0) throw new Error('invoke_tool name must not be empty')
      if (graphemes(args.name).length > resolved.maxToolNameChars) {
        throw new Error(`invoke_tool name exceeds the configured ${String(resolved.maxToolNameChars)}-character limit`)
      }
      const available = new Set(catalog(ctx, exec.agent, resolved, exec.toolSet).map(tool => tool.name))
      if (!available.has(args.name)) {
        throw new Error(`invoke_tool received unknown or unavailable tool ${JSON.stringify(args.name)}`)
      }
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: ToolCallId(`${String(exec.callId)}:invoke`), name: args.name, arguments: JSON.stringify(args.arguments) }],
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        ...exec.toolSet === undefined ? {} : { toolSet: exec.toolSet },
        signal: exec.signal,
      })
      for (const context of batch.additionalContexts) exec.deferContext(context)
      const result = batch.results[0]!.result
      if (result.isError) throw new Error(result.error.message)
      if (batch.concluded) exec.concludeTurn()
      return result.value
    },
    presentCall: args => ({ card: 'generic', title: `Invoke ${args.name}`, kind: 'execute', rawInput: args.name }),
  })

  ctx.tools.register(searchTool)
  ctx.tools.register(describeTool)
  ctx.tools.register(invokeTool)
  const definitions = [searchTool, describeTool]
  const stepTools = new Map<string, ReadonlyMap<string, ToolSchema>>()
  ctx.on('system-prompt/assemble', async (_presentation, context, next) => {
    const presentation = await next()
    const scope = context.scope
    if (scope !== undefined && 'id' in scope && typeof scope.id === 'string') {
      stepTools.set(scope.id, new Map(ctx.tools.definitions(scope, context.toolSet)
        .filter(tool => ctx.tools.executable(tool.name, scope, context.toolSet) === tool).map(tool => [tool.name, sdkSchema(tool)])))
    }
    return presentation
  })
  installNativeDeferredBridge(ctx, {
    available: options => options.sessionId === undefined ? undefined : stepTools.get(options.sessionId),
    describe: DESCRIBE_TOOLS_NAME,
    invoke: INVOKE_TOOL_NAME,
    progressive: new Set([SEARCH_TOOLS_NAME, DESCRIBE_TOOLS_NAME, INVOKE_TOOL_NAME]),
  })
  ctx.provide('progressiveTools', {
    wrap(executor, mode, scope) {
      const select = (tools: readonly ToolDefinition[]) => {
        for (const expected of [...definitions, ...mode === 'native' ? [invokeTool] : []]) {
          if (!tools.includes(expected)) throw new Error(`dsh-progressive-tools: ${expected.name} is unavailable or shadowed in this scope`)
        }
        return tools.filter(tool => tool.name !== INVOKE_TOOL_NAME && !isDeferred(tool, resolved)
          || mode === 'native' && tool === invokeTool)
      }
      const sections: ToolPromptSection[] = (executor.sections ?? []).map(section => section.name === 'tools:sdk'
        ? { ...section, text: tools => typeof section.text === 'function' ? section.text(select(tools)) : section.text }
        : section)
      sections.push({ name: DISCOVERY_SECTION, order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'), text: discoveryInstructions(mode), interpolate: false })
      return {
        sections,
        describe(tools) {
          // Validate names without using registered definitions to build the step's surface.
          for (const eagerName of resolved.eagerTools) {
            if (!ctx.tools.definitions(scope).some(tool => tool.name === eagerName)
              && !tools.some(tool => tool.name === eagerName)) {
              throw new Error('dsh-progressive-tools: eager tool ' + JSON.stringify(eagerName) + ' is not visible in this scope')
            }
          }
          const selected = select(tools)
          const modelInput = executor.describe(tools)
          const selectedNames = new Set(selected.map(tool => tool.name))
          return mode === 'ptc' ? modelInput : {
            ...modelInput,
            schemas: modelInput.schemas.filter(schema => selectedNames.has(schema.name)).map(schema => ({ ...schema, deferLoading: false })),
          }
        },
        execute(input) {
          if (input.agent !== undefined) presentationModes.set(input.agent, mode)
          return executor.execute(input)
        },
      }
    },
  })
}
