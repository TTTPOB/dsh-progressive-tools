# dsh-progressive-tools 开发约定

面向 DeepSeek Harness Native／Code／Both 模式所有 Agent preset 的渐进式工具披露层。**只改变呈现层**：即使 ToolRuntime 实时注册、注销、限制或遮蔽非 eager 工具，模型可见的工具前缀仍保持稳定。

## 挂载与配置

- 在 host plane 挂载**一次**，由 ToolRuntime 与 SystemPrompt 的作用域视图传递给所有已有和未来的 preset。不需要复制、编辑或选择额外 preset。组合方式见 [INSTALL.md](INSTALL.md)。
- 固定依赖 `tools`、`systemPrompt`、`llm`；只有 Agent 实际呈现 Code Mode 时才需要 `ptcRuntime`。
- **不要同时激活自带 bundle patch**，否则重复插入行。
- `eagerTools` 只放真正稳定、需要直接声明的精确工具名。**未知 eager 名称会让 assembly 失败。**
- `deferTools: mcp` 时，eager 集合还包含当前作用域的全部普通工具。
- 条目数、字素数、`maxSearchResults`／`maxDescribeTools`、`maxSummaryChars`／`maxQueryChars`／`maxToolNameChars`／`maxResultBytes` 都在成功返回前强制执行。

## 权威与边界

- **呈现不是授权。** 已知精确名称的调用方可以尝试调用；ToolRuntime 的可见性、policy、approval、guard 与调度仍是最终权威。
- 协议不维护可变 reveal 集合：搜索不解锁能力，完整实时目录仍是执行权威。每次请求都从已记录的 `describe_tools` 调用/结果对重建 Native 披露。
- 每个作用域**假定只有一个协作式呈现所有者**；两个都改写最终工具表面的插件没有合并契约。

## 已知限制

- Native bridge 按特征探测 pi-ai 内部对象（DSH 提供只读 stream waterfall，但没有 adapter context-transform hook）。内部形态变化时退化为稳定 `invoke_tool`；Both 仍有 `run_code`。
- Native 能力元数据必须准确：OpenAI Responses 用 `compat.supportsToolSearch`，Anthropic 用 `supportsToolReferences` 或 pi-ai 第一方模型规则。错误宣称能力的 gateway 可能拒绝注入协议。
- 不过滤独立 `tool:*` guidance：其他插件动态改变单独指引文本时，system prefix 仍可能变化。
- 完整提示仍是最终权威——Harness 在 assembly waterfall 之后恢复 complete prompt，无法向其注入发现指引。
- 搜索是宽松、确定性的**词法排序，不是语义检索**；零词法候选时返回完整轻量目录，不留空结果死路。

## 验证

```sh
pnpm check
```

`pnpm check` = typecheck + tsdown + vitest + `test:built`（`DSH_EXAMPLE_MODE=lib` 跑 loader-composition）+ `verify:package`。`pnpm verify:consumer` 检查 tarball exports 与真实 Loader 激活，不启动 Host。
