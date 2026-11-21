# dsh-progressive-tools

[English](README.md) | 中文

面向 DeepSeek Harness Native 与 PTC（Code）executor 的渐进式工具披露层。它只改变呈现层：即使本步可用的 ToolRuntime 目录注册、注销、限制或遮蔽非 eager 工具，模型可见的工具前缀仍保持稳定。


## 发布验证

本地与 [Validate and release](.github/workflows/release.yml) 共用 `pnpm prepare:release`，使用 DSH `0.2.2-rc.5`、fork PTC executor 与 Cordis `4.1.0`；Native 协议测试使用 Pi AI `1.3.0-fork3` 回放请求记录。安装配套 fork PTC executor 后，运行 `DSH_FORK_PTC_NATIVE=1 pnpm test` 启用原生例外测试；官方包尚无 `ptcNativeTools`，这些测试保留但默认跳过。`pnpm release:pack && pnpm verify:consumer` 验证 tarball exports、正式 Host 包解析器下的共享 peers 和真实 Loader 激活，不启动 Host。Schemastery 作为插件运行依赖安装；仅有状态的 Cordis／DSH 服务需要与 Host 共享实例。

## 安装与组装

按照 [INSTALL.md](INSTALL.md) 组合 Node >=24.9 与 DSH 0.2.2-rc.5。主插件在 host plane 挂载一次，注册发现工具与共用披露配置；**每个 Agent preset** 还必须将上游 executor 行替换为 `dsh-progressive-tools/native` 或 `dsh-progressive-tools/ptc`，仅挂主插件不会接管呈现。同一作用域不得同时选择上游与 progressive executor。主插件依赖 `tools`、`systemPrompt` 和 `llm`；只有 PTC executor 依赖 `ptcRuntime`。它不会修改 Harness checkout。

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

上述配置块展示默认值，也可覆盖 `$DSH_HOME/cordis.patch.yml` 中的共用行；不要同时激活自带 bundle patch，以免重复插入。`eagerTools` 只应包含真正稳定、需要直接声明的精确工具名。未知 eager 名称会让 assembly 失败。条目数、字素数和结果 UTF-8 字节上限都会在成功返回前强制执行。

## 披露规则

`toolDisclosureRules` 是有序数组。每条规则必须恰好包含 `glob: string` 或 `regex: string` 之一，以及 `disclosure: eager | deferred`；多余的规则字段会被拒绝。规则区分大小写，只匹配工具名称，不匹配描述。**最后一条命中的规则生效**，精确名称没有特殊优先级。

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

此例立即声明普通工具，延迟除指定天气工具以外的 MCP 工具，并延迟以 `write_` 或 `delete_` 开头的名称。后面的宽泛规则也能覆盖前面的精确规则。

- **Glob：** 匹配整个工具名；`*` 匹配零个或多个字符，`?` 匹配一个 Unicode 字符。其他字符均按字面匹配，包括方括号、花括号、斜杠和反斜杠。不支持字符类、花括号展开、路径语义或转义；复杂模式请使用 regex。没有通配符的 glob 就是精确名称。
- **Regex：** 使用 JavaScript `new RegExp(source)` 语法，不加 `/pattern/` 分隔符或 flags。默认匹配子串；需要整名匹配时自行添加 `^` 和 `$`。非法正则及错误规则在加载配置时失败，直接调用 `apply` 也会校验。
- **优先级：** 命中的规则 → 旧 `eagerTools` → 工具自身的 `deferLoading: true` → 默认 deferred。无规则时，所有非 eager 工具仍然延迟。显式 eager 规则和 `eagerTools` 可覆盖工具自身延迟标记；deferred 规则可覆盖 `eagerTools`。旧 eager 名称不可见时仍会让 assembly 失败，即使规则将其设为 deferred。
- **控制工具：** 对 `search_tools`、`describe_tools`、`invoke_tool`、`run_code` 忽略所有规则，包括精确匹配。它们维持各模式和能力下的原有呈现；规则既不能隐藏，也不能强制暴露它们。
- **本步作用域：** 规则可以匹配尚未注册的名称。Executor 只过滤本步传入的定义；发现与嵌套调用透传同一 `toolSet`。即使历史 describe 结果包含某工具，`when: false` 时也不能展示、发现或执行。eager 工具注册和移除会改变前缀，deferred 目录变动不会。

**迁移：** 已移除 `deferTools`；配置中只要包含该项就会明确报迁移错误。删除 `deferTools: all` 即保留默认行为；将 `deferTools: mcp` 替换为上例前两条规则。如果原来用 `eagerTools` 设置 MCP 例外，需要在 MCP deferred 规则**之后**添加精确 eager 规则，因为规则现在优先于旧列表。宽泛的 eager 规则也会覆盖工具自身的延迟标记，需要时应另加 deferred 例外。配置需显式更新；本包不会自动迁移已有安装。

## 各模式的稳定表面

| 有效模式 | 模型可见的稳定工具 | 描述后的调用方式 |
| --- | --- | --- |
| Native，原生延迟披露 API | `search_tools`、`describe_tools`、eager 工具 | 使用返回的精确名称与参数发起普通工具调用 |
| Native，其他 API | `search_tools`、`describe_tools`、`invoke_tool`、eager 工具 | `invoke_tool({ name, arguments })` |
| Code | `run_code` 与 core 配置的原生例外，SDK 声明发现与 eager binding | 后续 `run_code` 中调用 `tools[exactName](arguments)` |

PTC 原生例外由 fork PTC executor 的 `ptcNativeTools: string[]` 配置选择，不属于 `tools` 或披露规则。本插件完整保留该 executor 返回的 wire schema，包括被设为 deferred 的原生例外，只裁剪 SDK。官方 DSH 可正常使用无例外模式；启用例外需要配套 fork `@deepseek-ai/dsh-tool-executor-ptc`。例外仍可通过完整 SDK 调用，且受本步 admission 和执行策略约束。

`invoke_tool` 是能力兜底，不是第二套 Code transport。若解析后的模型同时支持会话中途的 system message 与 transcript 工具增量，插件会在 pi-ai 请求边界移除它。PTC 已有 `run_code`，因此不会暴露 `invoke_tool`。

## 发现协议

1. Native 直接调用 `search_tools({})` 或 `search_tools({ query: "*" })`，Code 则把它作为 Code binding 调用，以列出完整轻量目录。与 Harness Skills 的“摘要优先”形态一致，每项只包含精确 `name` 与有界 `description`。文本查询只是可选的排序过滤器：各查询词独立匹配，不再要求全部命中；零命中时自动退回完整目录。需要时仍可显式传入 `limit` 缩小响应。
2. 对准备使用的候选项调用 `describe_tools({ names })`。每次调用接受 1 到 `maxDescribeTools` 个名称；更多名称应拆分为多次调用。它返回完整描述和 canonical 输入/输出 schema；PTC 还会获得当前 runtime 的 SDK 片段。
3. 后续模型步骤中，原生支持的 API 使用该精确名称与参数发起普通工具调用。插件从持久化请求历史重建成功的 `describe_tools` 结果，并把 schema 注入对应 tool-result 位置。不支持该能力的 Native API 使用稳定的 `invoke_tool({ name, arguments })` 兜底。Code 在后续 `run_code` 中调用 `tools[exactName](arguments)`。
4. 执行时 ToolRuntime 重新解析当前作用域目录。仍存在且可见的工具正常运行；已删除、受限、被遮蔽或拼错的名称返回当前失败原因。

搜索与描述使用 `ctx.tools.definitions(exec.agent, exec.toolSet)`，并以同一 admission 检查 `executable`。Search 仅返回名称、有界描述与计数元数据；describe 只返回选中名称的精确 schema，不暴露内部目录或呈现元数据。

协议不维护可变 reveal 集合：搜索不会解锁能力。每次请求都从历史 describe 调用/结果对重建 Native 披露，再与本步定义求交；缺失本步元数据时不恢复未经核实的历史 schema，继续使用发现与兜底调用。

### Native API 注入

Harness 请求对象保持冻结与只读。插件通过公开的 `llm/stream` waterfall 传递当前请求的持久化披露信息，再以可恢复方式包装解析后的 pi-ai `Models.streamSimple` 实例。对支持的模型，它回放 pi-ai `SystemMessage.toolsAdded`/`toolsRemoved`，并在成功的 describe 结果之后立即插入正文为空的 system update，仅添加新披露或已变化的定义。延迟声明不等于已加载工具；重复描述不会重复添加未变化的定义，移除后的再次描述则会重新添加。不支持或无法识别的适配器保持原样并保留 `invoke_tool`。

## 模型体验

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

线路仍只有 `run_code`；紧凑 SDK 只包含 `search_tools`、`describe_tools` 与 eager binding。Search 会列出轻量目录或按需排序，describe 再返回目标精确 schema 与 SDK 片段，后续程序调用 `tools[exactName](arguments)`。

### Token 与 KV Cache 影响

前缀只随发现声明、固定兜底与最终 eager 集合增长，不随完整可见目录增长。Native API 会在历史 describe 结果处追加披露 schema，而不是替换顶层工具数组，因此缓存前缀保持稳定。注册或注销非 eager 工具只改变后续发现结果。这直接针对 [deepseek-harness discussion #935](https://github.com/deepseek-ai/deepseek-harness/discussions/935) 中的动态工具前缀失效问题。

## 已知限制

- **Native bridge 会按特征探测 pi-ai 内部对象** —— DSH 提供只读 stream waterfall，但没有 adapter context-transform hook。因此插件在不改 Harness 源码的前提下包装当前 pi-ai Models 实例。若内部形态变化，它会退化为稳定 `invoke_tool`；PTC 仍有 `run_code`。
- **Native 能力元数据必须准确** —— 解析后的模型必须启用 `compat.supportsMidConvoSystemMessages`；Responses API 还要求 `supportsToolSearch` 或 `supportsAdditionalTools`，其他 API 则要求 `supportsMidConvoToolAdditions`。错误宣称能力的 gateway 可能拒绝 system update。
- **呈现不是授权** —— 已知精确名称的调用方可以尝试调用；ToolRuntime 的可见性、policy、approval、guard 与调度仍是最终权威。
- **不会过滤独立 `tool:*` guidance** —— 若其他插件动态改变单独指引文本，system prefix 仍可能变化。
- **完整提示仍是最终权威** —— Harness 会在 assembly waterfall 后恢复 complete prompt，因此无法向其中注入发现指引，但稳定 wire 投影仍保留。
- **搜索是宽松、确定性的词法排序，不是语义检索。** 独立词匹配、标识符拆分和少量英文复数归一化可以提升召回率；没有任何词法候选时会返回完整轻量目录，而不是留下空结果死路。
- **每个作用域假定只有一个协作式呈现所有者** —— 两个都改写最终工具表面的插件没有合并契约。

## 许可证

Apache License 2.0，参见 [`LICENSE`](LICENSE)。
