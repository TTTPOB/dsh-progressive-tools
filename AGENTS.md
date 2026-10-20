# dsh-progressive-tools 开发约定

面向 DeepSeek Harness Native／PTC（Code）模式所有 Agent preset 的渐进式工具披露层。**只改变呈现层**：即使 ToolRuntime 实时注册、注销、限制或遮蔽非 eager 工具，模型可见的工具前缀仍保持稳定。

## 挂载与配置

- 在 host plane 挂载**一次**，由 ToolRuntime 与 SystemPrompt 的作用域视图传递给所有已有和未来的 preset。不需要复制、编辑或选择额外 preset。组合方式见 [INSTALL.md](INSTALL.md)。
- 固定依赖 `tools`、`systemPrompt`、`llm`；只有 Agent 实际呈现 Code Mode 时才需要 `ptcRuntime`。
- **不要同时激活自带 bundle patch**，否则重复插入行。
- `eagerTools` 只放真正稳定、需要直接声明的精确工具名。**未知 eager 名称会让 assembly 失败。**
- `toolDisclosureRules` 是有序 glob/regex 规则，最后命中优先于 `eagerTools`；默认延迟全部非 eager 工具。旧 `deferTools` 配置会报迁移错误。
- 条目数、字素数、`maxSearchResults`／`maxDescribeTools`、`maxSummaryChars`／`maxQueryChars`／`maxToolNameChars`／`maxResultBytes` 都在成功返回前强制执行。

## 权威与边界

- **呈现不是授权。** 已知精确名称的调用方可以尝试调用；ToolRuntime 的可见性、policy、approval、guard 与调度仍是最终权威。
- 协议不维护可变 reveal 集合：搜索不解锁能力，完整实时目录仍是执行权威。每次请求都从已记录的 `describe_tools` 调用/结果对重建 Native 披露。
- 每个作用域**假定只有一个协作式呈现所有者**；两个都改写最终工具表面的插件没有合并契约。

## 已知限制

- Native bridge 按特征探测 pi-ai 内部对象（DSH 提供只读 stream waterfall，但没有 adapter context-transform hook）。内部形态变化时退化为稳定 `invoke_tool`；PTC 仍有 `run_code`。
- Native 能力元数据必须准确：模型必须启用 `compat.supportsMidConvoSystemMessages`；Responses 还需 `supportsToolSearch` 或 `supportsAdditionalTools`，其他 API 需 `supportsMidConvoToolAdditions`。错误宣称能力的 gateway 可能拒绝注入协议。
- 不过滤独立 `tool:*` guidance：其他插件动态改变单独指引文本时，system prefix 仍可能变化。
- 完整提示仍是最终权威——Harness 在 assembly waterfall 之后恢复 complete prompt，无法向其注入发现指引。
- 搜索是宽松、确定性的**词法排序，不是语义检索**；零词法候选时返回完整轻量目录，不留空结果死路。

## 验证

```sh
pnpm check
```

`pnpm check` = typecheck + tsdown + vitest + `test:built`（`DSH_EXAMPLE_MODE=lib` 跑 loader-composition）+ `verify:package`。`pnpm verify:consumer` 检查 tarball exports 与真实 Loader 激活，不启动 Host。

## 分支与发布

- 长期发布分支为 `main`，位于 TTTPOB remote `fork`（github.com/TTTPOB/dsh-progressive-tools）；本地长期分支必须跟踪 `fork/main`，不跟踪第三方上游。 remote `origin` 是第三方上游 Yan-Zero，不是发布目标。
- 开发和测试使用独立分支或 worktree。
- 发布前先合并到长期分支并 push，等待分支 CI（`.github/workflows/release.yml`）通过。
- 仅从长期分支上的提交，通过 GitHub Actions Release workflow（`.github/workflows/release.yml`）发布；tag 和 Release 资产不可变，不上传本地构建。
- 本机约 13 GB 内存，本地只跑本仓库相关的 scoped 检查；重型全仓检查交给 CI。
