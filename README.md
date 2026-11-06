# dsh-progressive-tools

English | [中文](README.zh.md)

A presentation-only progressive tool disclosure layer for DeepSeek Harness Native and PTC (Code) executors. It keeps the model-visible tool prefix stable while the admitted ToolRuntime catalog may register, unregister, restrict, or shadow non-eager tools.


## Release validation

Use `pnpm prepare:release` followed by [Validate and release](.github/workflows/release.yml). Source tests use official DSH `0.2.2-rc.1` and Cordis `4.1.0`; native protocol tests use pi-ai transcript replay. After installing a matching fork PTC executor, run `DSH_FORK_PTC_NATIVE=1 pnpm test` to enable native-exception coverage. These tests are retained but skipped against official packages, which do not implement `ptcNativeTools`. `pnpm release:pack && pnpm verify:consumer` checks packed exports, Host-shared peer resolution and real Loader activation without launching a Host. Schemastery is a plugin-owned runtime dependency; only stateful Cordis/DSH services require Host-shared instances.

## Installation and composition

Follow [INSTALL.md](INSTALL.md) with Node >=24.9 and DSH 0.2.2-rc.1. Mount the main plugin once on the host plane to register discovery tools and shared disclosure configuration. In **each Agent preset**, replace the upstream executor row with `dsh-progressive-tools/native` or `dsh-progressive-tools/ptc`; the host row alone does not change presentation. Do not select both upstream and progressive executors in the same scope. The main plugin requires `tools`, `systemPrompt`, and `llm`; only the PTC executor requires `ptcRuntime`. It never patches the Harness checkout.

```yaml
- id: progressive-tools
  config:
    toolDisclosureRules: []
    eagerTools: []
    maxSearchResults: 10
    maxDescribeTools: 10
    maxSummaryChars: 240
    maxQueryChars: 500
    maxToolNameChars: 200
    maxResultBytes: 1048576
```

The configuration block above shows the defaults and is an optional override of the shared row in `$DSH_HOME/cordis.patch.yml`; do not activate the package bundle alongside that row. `eagerTools` contains exact, genuinely stable tools that remain declared directly. Unknown eager names fail assembly. Every count, grapheme, and rendered UTF-8 result limit is enforced before a successful discovery result returns.

## Disclosure rules

`toolDisclosureRules` is an ordered array. Each rule has exactly one `glob: string` or `regex: string`, plus `disclosure: eager | deferred`; extra rule fields are rejected. Rules match the case-sensitive tool name, not its description. The **last matching rule wins**, with no special priority for exact names.

```yaml
    toolDisclosureRules:
      - glob: "*"
        disclosure: eager
      - glob: "mcp__*"
        disclosure: deferred
      - glob: "mcp__weather__forecast"
        disclosure: eager
      - regex: "^(write|delete)_"
        disclosure: deferred
```

This example declares ordinary tools immediately, defers MCP tools except the exact weather tool, and defers names starting with `write_` or `delete_`. A later broad rule can override an earlier exact rule.

- **Glob:** matches the whole tool name; `*` matches zero or more characters, `?` matches one Unicode character. All other characters are literal, including brackets, braces, slash and backslash. There are no character classes, brace expansion, path semantics, or escaping; use regex for richer patterns. A glob without wildcards is an exact name.
- **Regex:** JavaScript `new RegExp(source)` syntax, without `/pattern/` delimiters or flags. Matching is unanchored unless you add `^` and `$`. Invalid regex and malformed rules fail at configuration load (also for direct `apply` callers).
- **Precedence:** matching rule → legacy `eagerTools` → tool's own `deferLoading: true` → default deferred. With no rules, all non-eager tools remain deferred. Explicit eager rules and `eagerTools` override a tool's own defer marker; a deferred rule overrides `eagerTools`. Unknown legacy eager names still fail assembly, even when a rule would defer them.
- **Control tools:** rules are ignored for `search_tools`, `describe_tools`, `invoke_tool` and `run_code`, including exact matches. They retain their mode/capability-specific presentation; rules cannot hide or force-expose them.
- **Step scopes:** rules may name tools not yet registered. Executors filter only definitions supplied for the current step; discovery and nested calls retain that same `toolSet`. A `when: false` tool is neither declared, discoverable nor executable, even if an earlier describe result contains it. Eager registration/removal changes the prefix; deferred catalog changes do not.

**Migration:** `deferTools` has been removed; any configuration containing it fails with a migration error. Remove `deferTools: all` to retain the default. Replace `deferTools: mcp` with the first two rules above. If you previously used `eagerTools` for MCP exceptions, add exact eager rules **after** the MCP deferred rule, because matching rules now override that legacy list. Broad eager rules also override tools' own defer markers; add deferred exceptions where needed. Update your configuration explicitly; this package does not migrate installations.

## Stable mode surfaces

| Effective mode | Stable model-visible tools | Invocation after describe |
| --- | --- | --- |
| Native, native deferred API | `search_tools`, `describe_tools`, eager tools | ordinary tool call with the returned exact name and arguments |
| Native, other API | `search_tools`, `describe_tools`, `invoke_tool`, eager tools | `invoke_tool({ name, arguments })` |
| Code | `run_code` and core-configured native exceptions; its SDK declares discovery and eager bindings | `tools[exactName](arguments)` inside a later `run_code` |

PTC native exceptions are selected by the fork PTC executor’s `ptcNativeTools: string[]` configuration, not `tools` or disclosure rules. The progressive wrapper preserves every wire schema returned by that executor, including deferred native exceptions, and only compacts its SDK. Official DSH works without exceptions; enabling exceptions requires the matching fork `@deepseek-ai/dsh-tool-executor-ptc`. Native exceptions remain callable through the full SDK subject to step admission and execution policy.

`invoke_tool` is a capability fallback, not a second Code transport. The plugin removes it at the pi-ai request boundary when the resolved model enables mid-conversation system messages and transcript-anchored tool additions. PTC already has `run_code`, so it never exposes `invoke_tool`.

## Discovery protocol

1. Call `search_tools({})` or `search_tools({ query: "*" })` directly in Native, or as a Code binding in Code mode, to list the complete lightweight catalog. Each entry contains only the exact `name` and a bounded `description`, matching Harness Skills' summary-first shape. A text query is an optional ranking filter: terms are matched independently instead of all being required, and a zero-match query falls back to the complete catalog. An explicit `limit` still narrows a response when desired.
2. Call `describe_tools({ names })` for the candidates you intend to use. Each call accepts from 1 through `maxDescribeTools` names; split larger sets across calls. It returns their canonical input/output schemas and full descriptions; PTC also receives the active-runtime SDK excerpt.
3. On a later model step, a natively capable API emits an ordinary tool call using that exact name and arguments. The plugin reconstructs successful `describe_tools` results from durable request history and injects their schemas at the matching tool-result position. A Native API without that capability calls the stable `invoke_tool({ name, arguments })` fallback. Code calls `tools[exactName](arguments)` from a later `run_code`.
4. ToolRuntime resolves the current scoped registry at execution time. Existing visible tools run normally; removed, restricted, shadowed, or misspelled names return the current failure reason.

Search and describe project `ctx.tools.definitions(exec.agent, exec.toolSet)` and check `executable` with the same admission. Search returns only names and bounded descriptions plus count metadata; describe returns exact schemas only for selected names. Neither result exposes internal catalog or presentation metadata.

The protocol keeps no mutable reveal set: search does not unlock a capability. Native disclosure is reconstructed from logged describe call/result pairs on every request, intersected with current-step definitions. Missing step metadata falls back to discovery/invocation rather than replaying unverified schemas.

### Native API injection

Harness request objects stay frozen and read-only. The plugin uses the public `llm/stream` waterfall to carry one request's durable disclosures, then reversibly wraps the resolved pi-ai `Models.streamSimple` instance. For capable models it replays pi-ai `SystemMessage.toolsAdded`/`toolsRemoved` and inserts an empty-content system update immediately after each successful describe result, adding only newly disclosed or changed definitions. Deferred declarations are not treated as loaded tools. Repeated descriptions do not repeat an unchanged definition; a description following a removal adds it again. Unsupported or unrecognized adapters are left untouched and retain `invoke_tool`.

## Model experience

### Native

```markdown
## Progressive tool disclosure

Use tools already declared in this interface or SDK directly; they do not require search_tools or describe_tools.
For deferred tools, start with search_tools({}) or search_tools({ query: "*" }) when you need their complete lightweight catalog of names and summaries. A text query is only an optional ranking filter and falls back to that catalog when nothing matches.
Call describe_tools with 1-10 exact deferred tool names per call; split larger sets across calls.
describe_tools returns the exact input and output schemas; in Code Mode it also returns the active-runtime SDK excerpt.
On a later model step, issue an ordinary tool call with the returned exact name and arguments.
If the interface declares invoke_tool instead, pass it that exact name and arguments.
An unavailable call fails with the current ToolRuntime reason.
```

### Code

The wire remains `run_code`; its compact SDK contains only `search_tools`, `describe_tools`, and eager bindings. Search lists or optionally ranks the lightweight catalog, describe returns exact target schemas and an SDK excerpt, and a later program calls `tools[exactName](arguments)`.

### Token and KV-cache effect

The prefix scales with discovery declarations, the fixed fallback, and the effective eager set, not the complete visible catalog. Native APIs append disclosed schemas at the historical describe result rather than replacing the top-level tool array, so the cached prefix remains stable. Registering or unregistering a non-eager tool changes only later discovery results. This directly addresses dynamic-tool prefix invalidation such as [deepseek-harness discussion #935](https://github.com/deepseek-ai/deepseek-harness/discussions/935).

## Known limitations

- **The native bridge is feature-detected against pi-ai internals** — DSH exposes a read-only stream waterfall but no adapter context-transform hook. The plugin therefore wraps the current pi-ai Models instance without changing Harness source. If that internal shape changes, it fails open to the stable `invoke_tool` fallback; PTC continues to have `run_code`.
- **Native capability metadata must be accurate** — The resolved model must enable `compat.supportsMidConvoSystemMessages`; Responses APIs additionally require `supportsToolSearch` or `supportsAdditionalTools`, while other APIs require `supportsMidConvoToolAdditions`. A gateway that over-claims these capabilities may reject the system updates.
- **Presentation is not authorization** — callers that already know an exact name may try it; ToolRuntime visibility, policy, approval, guards, and scheduling remain authoritative.
- **Independent `tool:*` guidance is not filtered** — a plugin that dynamically changes separate guidance text can still change the system prefix.
- **Complete prompts remain authoritative** — Harness restores a complete prompt after the assembly waterfall, so discovery guidance cannot be injected there even though the stable wire projection remains.
- **Search is relaxed deterministic lexical ranking, not semantic retrieval.** Independent-term matching, identifier splitting, and small English plural normalization improve recall; a query with no lexical candidate returns the complete lightweight catalog instead of an empty dead end.
- **One cooperative presentation owner per scope is assumed** — two plugins that both rewrite the final tool surface have no merge contract.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
