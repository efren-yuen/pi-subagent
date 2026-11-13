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

每个文件用 frontmatter 声明 `name`、`description`，可选 `tools`（字符串或数组）、`model`；正文即该 agent 的 system prompt。`agentScope` 参数控制取用户级、项目级还是两者（`both` 时同名以项目级为准）。

## 行为边界

- 每个子 Agent 是一个独立的 `pi` 子进程，用自己的上下文窗口，不共享主会话历史。
- 子进程继承当前环境变量和 cwd，能读写文件、执行命令；本扩展不做额外的权限校验，实际约束来自 `permission-gate` 和子进程自己的配置。
- prompt 会写到临时目录（`os.tmpdir()/pi-subagent-*`，权限 0600），单任务输出超过 50KB 时截断，完整内容保留在工具 details 里。
- 非 TUI 模式（`-p`、`--mode json`）不会尝试弹交互确认。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run pack:check
```

单元测试只覆盖纯函数，不 spawn 真实子进程；行为验证要靠 `pi -e` 实际调用。

## 上游同步

本包是分叉，Pi 升级后需要手工比对：

```sh
diff -u /usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/subagent/index.ts \
        ~/Workspace/project/pi/pi-subagent/src/index.ts
diff -u /usr/lib/node_modules/pi/packages/coding-agent/examples/extensions/subagent/agents.ts \
        ~/Workspace/project/pi/pi-subagent/src/agents.ts
```

差异里除 `export` 关键字外，其余每一处都要按行为审查，不要按差异行数判断是否过时。

## 许可证

[MIT](LICENSE)
