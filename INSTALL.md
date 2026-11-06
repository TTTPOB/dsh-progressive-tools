# Installation

This package targets Node >=24.9, DSH 0.2.2-rc.1 and Cordis 4.1.0. It registers discovery tools on the host plane and composes progressive presentation with scoped executors. It does not replace the PTC runtime or patch Harness source.

## Mount discovery once

Install this package as an ordinary dependency of the resolving profile with `autoInstallPeers: false`. Resolve DSH peers from the matching Host installation. Insert the main plugin once in the host composition:

```yaml
- insert:
    - id: progressive-tools
      name: dsh-progressive-tools
```

The bundled `cordis.patch.yml` inserts the same host row. Choose either the explicit row or the bundle, never both. The main plugin requires `tools`, `systemPrompt` and `llm` and provides `progressiveTools`, the shared disclosure configuration used by scoped executors.

## Replace each preset's executor

Within **every Agent preset**, replace the upstream native/PTC executor row rather than adding another executor. Preserve that row's existing id and use the appropriate module name:

```yaml
# Inside a Native preset's entries:
- id: native-executor
  name: dsh-progressive-tools/native

# Inside a PTC preset's entries (not the same scope):
- id: ptc-executor
  name: dsh-progressive-tools/ptc
  config:
    maxParallelSubCalls: 10
    ptcNativeTools: []
```

These modules export `ProgressiveNativeExecutor` and `ProgressivePtcExecutor`; their Cordis plugin names are `progressive-native-executor` and `progressive-ptc-executor`. Native has no configuration. PTC accepts upstream executor limits plus `ptcNativeTools: string[]`. It requires `ptcRuntime` in that scope. Each module injects `progressiveTools`, so the host row must remain available. Select exactly one executor per scope; the host discovery row alone does not modify an upstream executor. `tools.mode` and `DSH_TOOLS_MODE` are not used.

Official DSH supports Native and PTC without native exceptions. Nonempty `ptcNativeTools` requires the matching fork `@deepseek-ai/dsh-tool-executor-ptc`, whose `PtcExecutor` must accept the field, return admitted exceptions from `describe(definitions)`, permit their direct calls, and retain SDK invocation. The progressive wrapper preserves all returned PTC wire declarations and only compacts its SDK. Do not configure exceptions on `tools` or on the host discovery row.

## Optional shared disclosure configuration

Override the host row to configure disclosure once for all progressive executors:

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

See [Disclosure rules](README.md#disclosure-rules) for MCP-only disclosure and migration from `deferTools`. Unknown eager names fail assembly; a registered eager tool disabled by this step's condition is omitted, not restored. Assembly, discovery and dispatch preserve current-step admission.

## Verify

Inspect the composed configuration for one host discovery row and exactly one progressive executor in each intended preset. Native exposes discovery and eager tools, plus `invoke_tool` on adapters without native deferred loading. PTC exposes `run_code` and any admitted fork-native exceptions; its compact SDK declares discovery and eager tools. Native historical schema loading requires pi-ai `Models.streamSimple`, accurate capability flags and current-step metadata; otherwise the stable invocation fallback remains available.

Run `NODE_OPTIONS=--max-old-space-size=4096 pnpm check` and `pnpm release:pack && pnpm verify:consumer` for source, built Loader and tarball checks without launching a Host. After resolving the matching fork PTC package, run `DSH_FORK_PTC_NATIVE=1 pnpm test` to exercise the retained native-exception tests; official packages skip that fork-specific case.
