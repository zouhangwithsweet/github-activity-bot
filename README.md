# GitHub Activity Bot

通过 Lark 私聊查询自己创建的开放 PR 和 CI 状态。OAR 问答和主动提醒将在此查询层之上接入。

## 本地运行

1. 使用 Node.js 24.11+ LTS 或 26+，运行 `pnpm install`。
2. 将 `.env.example` 复制为 `.env`，配置 GitHub token 和 Lark 自建应用凭据。
3. 运行 `pnpm lark`。在 Lark 开发者后台启用 Bot，订阅 `im.message.receive_v1` 并选用 WebSocket 长连接，开启收取私聊和以 Bot 身份发送消息的权限后发布。
4. 首次私聊 Bot 时，终端会显示你的 `open_id`。填入 `LARK_OWNER_OPEN_ID` 并重启。发送「我的 PR」或「CI 失败」验证。

`pnpm prs --failed` 可以单独检查 GitHub 查询。`pnpm check` 和 `pnpm test` 分别运行静态检查和测试。
