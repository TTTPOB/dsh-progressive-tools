# Installation

This package targets official DeepSeek Harness 0.1.7-rc.2. It mounts progressive tool disclosure once on the host plane for every Agent preset; it does not replace the PTC runtime or patch Harness source.

## Compose in a Web bundle

Declare `dsh-progressive-tools@0.3.0` as a direct dependency of the Web bundle that owns the composition. Insert its plugin row in that bundle's patch:

```yaml
- insert:
    - id: progressive-tools
      name: dsh-progressive-tools
```

Resolve `@deepseek-ai/dsh-ptc-runtime` from the matching official DSH installation. The plugin requires `tools`, `systemPrompt`, and `llm`; `ctx.ptcRuntime` is required only when presenting PTC/Code or Both mode. Do not also install this package as an active bundle in the same composition: its own `cordis.patch.yml` would insert a duplicate row.

Alternatively, install this standalone bundle with `dsh plugin --profile web add dsh-progressive-tools@0.3.0`; its own bundle patch contributes the row. Use this route only if the Web bundle does not already declare the plugin.

## Optional configuration

The defaults require no edits. To override the row from a profile patch, or set the same config on the composing bundle's row:

```yaml
- id: progressive-tools
  config:
    deferTools: all
    eagerTools: []
    maxSearchResults: 10
    maxDescribeTools: 10
    maxSummaryChars: 240
    maxQueryChars: 500
    maxToolNameChars: 200
    maxResultBytes: 1048576
```

Set `deferTools: mcp` to defer only MCP tools. Patches replace the entire config; include every option that should remain explicit. Unknown eager names fail assembly.

## Verify

Inspect the composed configuration for exactly one `progressive-tools` row and verify its module resolves from the Web bundle's dependency tree. In a new session, Native exposes `search_tools` and `describe_tools` plus `invoke_tool` on APIs without native deferred loading. PTC/Code keeps `run_code` on the wire; Both presents both paths. Native schema loading at the historical describe result still requires an adapter using pi-ai `Models.streamSimple` with accurate capability flags; otherwise retain the stable `invoke_tool` fallback.
