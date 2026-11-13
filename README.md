# @efrencode/pi-subagent

Pi 的 subagent 工具：把任务委派给独立上下文的子 Agent 进程，支持单次、并行、链式三种模式。上游 `pi` 示例扩展 `subagent` 的本地分叉。

```text
subagent { agent: "scout", task: "..." }                      # 单次
subagent { tasks: [{ agent: "a", task: "..." }, ...] }        # 并行，最多 8 个任务 / 4 并发
subagent { chain: [{ agent: "a", task: "..." }, { agent: "b", task: "{previous}" }] }  # 链式
```

## 安装

```sh
pi install npm:@efrencode/pi-subagent
```

本地开发时直接指向项目目录，配合 `pi -e` 调试：

```sh
pi -e ~/Workspace/project/pi/pi-subagent
```

## Agent 定义不在这个包里

`subagent` 工具只负责调度，具体能调哪些 agent 由下面的目录决定：

| 作用域 | 路径 |
|---|---|
| 用户级 | `~/.pi/agent/agents/*.md` |
| 项目级 | 从 cwd 向上查找到的第一个 `.pi/agents/*.md` |

每个文件用 frontmatter 声明 `name`、`description`，可选 `tools`（字符串或数组）、`model`；正文即该 agent 的 system prompt。`agentScope` 默认 `user`，可选 `project`、`both`（`both` 时同名以项目级为准）。坏 YAML 或不可读文件会被单独跳过，不影响其他合法 Agent。

例如手动创建 `~/.pi/agent/agents/reader.md`：

```markdown
---
name: reader
description: 定位代码并总结事实，不修改文件
tools: [read, grep, find, ls]
---

你是只读代码分析助手。仅阅读本次任务必需的文件，不修改代码、不运行命令。
输出相关文件路径、关键符号及简洁结论；不确定之处明确说明。
```

随后调用：

```text
subagent { agent: "reader", task: "定位 src/index.ts 中的并行任务调度逻辑" }
```

省略 `model` 时继承发起会话的模型与 thinking level；显式指定 `model` 时使用该模型，不传入发起会话的 thinking level。省略 `tools` 时使用子进程默认工具。工具列表和提示词不是权限沙箱。

并行适用于互不依赖的任务；链式任务只有写入字面量 `{previous}` 才会收到上一步完整原始输出，美元符号等字符保持原样。链式返回内容只包含最后一步输出，前面步骤仍保留在 details 中。

## 行为边界

- 每个子 Agent 是一个独立的 `pi` 子进程，用自己的上下文窗口，不共享主会话历史。
- 子进程继承当前环境变量和 cwd，能读写文件、执行命令；本扩展不做额外的权限校验，实际约束来自 `permission-gate` 和子进程自己的配置。
- prompt 会写到临时目录（`os.tmpdir()/pi-subagent-*`，权限 0600），任务结束时清理。
- 项目 Agent 的确认逻辑保持宿主信任上下文行为；非交互模式（`-p`、`--mode json`）不会弹确认。只对可信仓库启用项目 Agent。
- 状态区分 `pending`、`running`、`completed`、`failed`、`aborted`。非零退出、信号退出、启动错误、模型 error/aborted 均作为错误返回；并行部分失败也设置 `isError`。
- 取消会向已启动进程发送 SIGTERM；五秒后仍未退出则发送 SIGKILL，等待全部已启动进程 close 后返回。排队任务不再启动，但每个并行输入都有结果，部分输出、stderr 和 usage 保留。
- 链式在首次失败或取消时停止后续步骤。失败或取消不意味着没有副作用，重试前须检查实际文件/外部状态。

## 输出截断规则

- single、chain、parallel 的模型可见最终 content **整体**最多 50 KiB（51,200 字节）或 2,000 行，先到者生效；截断提示也计入预算。流式 content 同样受限。
- 整体截断使用宿主 `truncateHead`，保留开头完整行；发生截断时为提示预留 256 字节和两行。若首行超出正文预算，可能只返回截断提示。行数沿用宿主规则：末尾换行不额外算一行。
- 并行先对每项摘要施加 50 KiB 字节上限（提示计入，UTF-8 字符边界安全），再对拼接后的整体施加上述限制；**不是**每项各获 50 KiB 的模型上下文预算，后面的摘要可能被整体截掉。
- 完整消息、错误诊断和 stderr 保留在工具 details，UI 展开可查看任务详情；chain 的 `{previous}` 仍使用完整输出，不使用截断文本。details 不自动作为完整正文发送给父模型。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run pack:check
```

已验证版本：Pi **1.5.2**、Node **22.23.5**。测试覆盖纯函数、注册工具 execute 接口、进程生命周期、并行取消、三种模式截断、中文跨块解码和坏 YAML 隔离。使用 mock child_process、假时钟及隔离临时目录，不启动真实 Pi 子进程、不调用真实模型、不修改用户 Agent 配置。

真实模型端到端尚未验证，可在可信测试项目中用 `pi -e` 手工测试。

## 上游同步

本包是分叉，Pi 升级后需要手工比对：

```sh
diff -u /usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/subagent/index.ts \
        ~/Workspace/project/pi/pi-subagent/src/index.ts
diff -u /usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/subagent/agents.ts \
        ~/Workspace/project/pi/pi-subagent/src/agents.ts
```

差异里除 `export` 关键字外，其余每一处都要按行为审查，不要按差异行数判断是否过时。

## 仓库与反馈

- [源码仓库](https://github.com/efren-yuen/pi-subagent)
- [问题反馈](https://github.com/efren-yuen/pi-subagent/issues)

包已声明公开发布配置；本次未执行 npm 发布。

## 许可证

[MIT](LICENSE)。上游版权原文尚待核实，本次未修改 LICENSE。
