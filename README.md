# GitHub Activity Bot

通过 Lark 私聊查询自己创建的开放 PR 和 CI 状态。自然语言问题由 OAR 交给本机 Codex，并通过只读 GitHub 工具获取实时数据。

## 本地运行

1. 使用 Node.js 24.11+ LTS 或 26+，运行 `pnpm install`。
2. 将 `.env.example` 复制为 `.env`，配置 GitHub token 和 Lark 自建应用凭据。
3. 运行 `pnpm lark`。在 Lark 开发者后台启用 Bot，订阅 `im.message.receive_v1` 并选用 WebSocket 长连接，开启收取私聊和以 Bot 身份发送消息的权限后发布。
4. 首次私聊 Bot 时，终端会显示你的 `open_id`。填入 `LARK_OWNER_OPEN_ID` 并重启。发送「我的 PR」或「CI 失败」验证。

`pnpm prs --failed` 可以单独检查 GitHub 查询。`pnpm check` 和 `pnpm test` 分别运行静态检查和测试。

运行 `pnpm lark` 时，终端会按消息记录已授权的私聊问题、Bot 回复、发送结果和耗时。每条 JSON 日志带时间和原始消息 ID。

## OAR 问答

本机 Codex 登录后，可私聊 Bot 问「我有哪些 PR 卡在 CI？」。Codex 不在 PATH 时，在本地 `.env` 配置 `OAR_CODEX_BIN` 为可执行文件路径。每条自然语言消息启动一个独立的 Codex 会话。`/prs` 和 `/failed` 直接走 GitHub 查询。

发 GitHub PR 链接或 `owner/repo#编号`，可以问单个 PR 的描述、CI、评审和合并状态。问「这个 PR 改了什么」时，Codex 会按需读取改动文件和 diff 摘录。

## GitHub 组织仓库

如需读取组织仓库，给同一个 GitHub 用户配置仅限对应组织和仓库的只读 `GH_ORG_TOKEN`，以及用逗号分隔的 `GH_EXPECTED_REPOS`。查询合并两个凭据可见的 PR，并提示其中无法访问的仓库。如果组织需要审核，审核通过后才能读取私有仓库。
