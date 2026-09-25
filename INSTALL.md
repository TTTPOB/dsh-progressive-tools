# Installation

This package targets official DeepSeek Harness 0.1.7-rc.2. It mounts progressive tool disclosure once on the host plane for every Agent preset; it does not replace the PTC runtime or patch Harness source.

## Install as a shared plugin

Install `dsh-progressive-tools@0.3.0` as an ordinary dependency in the profile that resolves these plugins (`autoInstallPeers: false`). Declare its shared plugin row once in `$DSH_HOME/cordis.patch.yml`:

```yaml
- insert:
    - id: progressive-tools
      name: dsh-progressive-tools
```

Resolve `@deepseek-ai/dsh-ptc-runtime` from the matching official DSH installation. The plugin requires `tools`, `systemPrompt`, and `llm`; `ctx.ptcRuntime` is required only when presenting PTC/Code or Both mode. Do not also activate this package as a bundle in the same composition: its own `cordis.patch.yml` would insert a duplicate row.

The package bundle patch remains available for standalone compositions, but do not add it to daily `dsh.profile.bundles`: with an explicit global row, automatic bundle append would insert a duplicate. Keep daily bundles to the official base and Web app; this shared plugin is not Web-specific.

## Optional configuration

The defaults require no edits. To override the shared row in `$DSH_HOME/cordis.patch.yml`:

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

Inspect the composed configuration for exactly one `progressive-tools` row and verify its module resolves from the installing profile's ordinary dependency tree. In a new session, Native exposes `search_tools` and `describe_tools` plus `invoke_tool` on APIs without native deferred loading. PTC/Code keeps `run_code` on the wire; Both presents both paths. Native schema loading at the historical describe result still requires an adapter using pi-ai `Models.streamSimple` with accurate capability flags; otherwise retain the stable `invoke_tool` fallback.
