# GitHub Activity Bot

通过 Lark 私聊查询自己创建的开放 PR 和 CI 状态。自然语言问题由 OAR 交给本机 Codex，并通过只读 GitHub 工具获取实时数据。

## 项目结构

[查看架构图和实现说明](docs/architecture.md)

- `apps/bot` 包含 Node Bot、GitHub 和 Lark 接入、测试以及 Drizzle 迁移。
- `apps/desktop` 包含 MyGo 菜单栏、设置、钥匙串和 Bot 进程管理。
- 在仓库根目录保留 `.env`，运行 `pnpm lark`、`pnpm prs` 或 `pnpm desktop:build`。CLI 和菜单栏都从仓库根目录启动 Bot，所以相对配置路径沿用原来的解析方式。

## macOS 菜单栏

菜单栏应用通过 MyGo 管理本机的 Bot。它显示启动和运行状态，提供启动、暂停、恢复、重启和设置。暂停会让 Node Bot 退出并保留 SQLite 数据，恢复会重新连接 Lark。

使用 Git 工作区启动时，运行状态会显示启动时的提交。启动失败可在菜单栏查看脱敏后的错误，连接超过启动期限时应用会结束本次启动。

1. 在项目根目录运行 `pnpm install`。已有的 Node 24.11+ LTS 或 26+、Codex 和 `.env` 可以继续使用。
2. 安装 Go 1.27.3 或更新版本，在项目根目录运行 `pnpm desktop:build`。从 `apps/desktop/dist/darwin-<架构>/` 打开 `GitHub Activity Bot.app`。
3. 在「设置 → 运行」选择仓库根目录和 Node 可执行文件。运行 `node -p 'process.execPath'` 可查看 Node 的实际路径。如果从 Finder 启动时找不到 Codex，也可以在同一页填入 Codex 的绝对路径。
4. 保存设置。如果原 Bot 还在终端运行，先在那里按 Ctrl+C，再点菜单栏的「启动 Bot」。连接成功后菜单显示「Bot 运行中」。

设置里的非空配置和钥匙串里的密钥优先于应用继承的环境变量。留空则依次沿用继承的环境变量和项目 `.env`。普通设置保存在 `~/Library/Application Support/GitHub Activity Bot/settings.json`，点「存入」的密钥只写入 macOS 钥匙串。关闭主动提醒时也会停用 Webhook，原配置保留。保存后下次启动或重启时生效。应用使用所选的本地 Bot 项目和运行环境。

应用图标和菜单栏图标基于 [Kubai Icons 的 Bot 图标](https://icons.kubai.design/icons/bot/)，保留 [MIT 授权声明](apps/desktop/resources/LICENSE-KUBAI-ICONS.txt)。

## 本地运行

1. 使用 Node.js 24.11+ LTS 或 26+，运行 `pnpm install`。
2. 将 `.env.example` 复制为 `.env`，配置 GitHub token 和 Lark 自建应用凭据。
3. 运行 `pnpm lark`。在 Lark 开发者后台启用 Bot，订阅 `im.message.receive_v1` 并选用 WebSocket 长连接，开启收取私聊和以 Bot 身份发送消息的权限后发布。
4. 首次私聊 Bot 时，终端会显示你的 `open_id`。填入 `LARK_OWNER_OPEN_ID` 并重启。发送「我的 PR」或「CI 失败」验证。

`pnpm prs --failed` 可以单独检查 GitHub 查询。`pnpm check` 和 `pnpm test` 分别运行静态检查和测试。

运行 `pnpm lark` 时，终端会按消息记录已授权的私聊问题、Bot 回复、发送结果和耗时。每条 JSON 日志带时间和原始消息 ID。

## OAR 问答

本机 Codex 登录后，可私聊 Bot 问「我有哪些 PR 卡在 CI？」。Codex 不在 PATH 时，在本地 `.env` 配置 `OAR_CODEX_BIN` 为可执行文件路径。同一私聊复用 Codex 会话，重启 Bot 后也可以直接追问「只看最新提交」。`/prs` 和 `/failed` 直接走 GitHub 查询。

纯文本和富文本都可以发 GitHub PR 链接或 `owner/repo#编号`。问具体哪项 CI 失败时，Bot 查询该 PR 最新提交的检查名称、结论和链接。问「这个 PR 改了什么」时，Codex 会按需读取改动文件和 diff 摘录。

也可以在私聊转发一段消息，再引用它问「这个 PR 的 CI 为什么失败？」。Bot 会读取同一私聊里被引用的文本、富文本或合并转发，按附言查询。需要 Lark 的 `im:message:readonly` 权限。引用读不到时，把 PR 链接或 `owner/repo#编号` 放在附言里即可继续查询。

处理较慢时，Bot 在原消息上加 `OnIt` 表情，回复就绪后移除。表情不可用时，Bot 先引用原消息回复「收到，正在处理…」。表情使用 Lark 的 `im:message.reactions:write_only` 权限。

## PR 改动评审

1. 私聊 Bot 发送一个 PR 链接，或发送 `/review PR链接 / /pricing` 指定页面。
2. 前端改动用当前提交的 Vercel 预览截图。Bot 将 1440 × 900 和 390 × 844 的 PNG 逐张发到私聊，并指出明显的横向溢出、遮挡、错位和内容裁切。可依据 App Router 或 Pages Router 文件推断路径，每次最多截三个页面。
3. 后端改动概括接口、数据、后台任务或配置的影响。混合改动同时提供截图与后端摘要。评审列出本次读取和实际截图的范围。

截图需要 GitHub 凭据的部署读取权限、Lark 应用的 `im:resource` 图片权限，以及本机 Chromium。安装浏览器可运行 `pnpm --dir apps/bot exec playwright install chromium`。预览必须关联当前提交的成功部署，且页面可在空白浏览器会话打开。截图隔离外部域名资源。缺少预览或图片时，私聊摘要会写明原因。

## 私聊合并 PR

1. 在 Lark 应用中启用消息读取权限 `im:message:readonly` 并发布。把带 PR 链接或 `owner/repo#编号` 的原消息转发到 Bot 私聊，引用它回复「帮我合并」。也可以直接发「帮我合并」和 PR 链接。
2. 预览会显示唯一 PR 的目标分支、待合并提交、CI、评审和合并方式。原文没有明确 PR 或含多个 PR 时，Bot 会请你提供一个链接。
3. 在 `.env` 设置 `GH_MERGE_REPOSITORIES` 和独立的 `GH_MERGE_TOKEN` 后重启。使用仅限这些仓库、具备 `Contents: write` 且遵循分支规则的 GitHub 凭据。合并方式默认 `squash`，可通过 `GH_MERGE_METHOD` 指定 `merge` 或 `rebase`。
4. 核对预览后，在同一私聊发送它给出的「确认合并」指令，有效期 10 分钟。Bot 在发出请求前复核目标分支与提交。GitHub 合并接口只接受 head SHA 作为写入前置条件，目标分支以请求前的复核为准。合并队列和堆叠 PR 通过 GitHub 操作。若请求结果未知，先在 PR 页面核对状态。

合并确认只接受绑定身份的私聊。确认码和结果保存在同一身份的本地 `merge.sqlite`，重启后仍可识别。同一确认码最多触发一次 GitHub 写入。写入凭据由 Bot 服务持有，Codex 会话只拥有查询工具。

## 测试群

1. 在同一个 Lark 应用启用群内 @ 接收权限 `im:message.group_at_msg:readonly`。读取群内引用和接收不带 @ 的线程追问还需群消息读取权限 `im:message.group_msg` 和消息读取权限 `im:message:readonly`。保存并发布应用。
2. 把 Bot 加到一个测试群，运行新版 `pnpm lark`。用绑定身份在群内发「@Bot /group-id」，把终端里 `lark.group_discovered` 的 `chatId` 写到 `LARK_TEST_GROUP_CHAT_ID`，再重启 Bot。
3. 同事在群里 @ 你后，引用那条消息并 @ Bot。只 @ Bot 时，它会概括对方的请求，能明确识别 PR 时查询当前 CI 和评审，再建议下一步或指出缺少的信息。也可以附言「查一下未解决评论」指定要查的内容，同一线程的追问会沿用上下文。
4. 要准备合并时，引用带 PR 链接的消息并发「@Bot 帮我合并」。Bot 将预览和确认指令发到绑定账号的私聊，在群里告知投递状态。确认和实际合并在私聊完成。

群里只接受绑定身份发起的问题和对已登记话题的追问。Bot 先回复「好的，收到！」。普通问答和公开仓库查询的结果发在群聊原处，主聊天里的消息回主聊天，已有话题中的消息回原话题。涉及个人 PR 列表、私有仓库或可见性未知的仓库时，Bot 在群里提示改用私聊查询。群聊和私聊使用独立会话。群会话空闲 30 分钟后释放本地 Codex 进程，下次追问时恢复会话。

## 会话记忆

SQLite 默认保存在 `~/.local/state/github-activity-bot`，可通过 `LARK_MEMORY_DIR` 修改。数据按 Lark 应用和绑定账号隔离，保存 Codex 会话 ID、最近使用时间、创建原因、群线程路由和群聊可见性依据。Bot 打开会话后立即保存 ID，超时后重试和重启后追问时优先恢复原会话。确认原会话丢失或已归档时，Bot 才会替换它。

在 Codex 会话列表里，可用「GitHub Bot · 私聊」「GitHub Bot · 群话题」「GitHub Bot · PR 评审」区分用途。私聊与每个群话题分别续接，PR 评审使用独立会话。会话正文保存在本机 Codex 历史里。

绑定账号可以在私聊或已有群话题内使用以下命令，Bot 会在本地处理。

- `/session` 查看当前会话状态。私聊还会显示 Codex 会话 ID。
- `/session reset` 在当前范围内排队重置。下一次普通问答开启新会话，旧会话保留在本机 Codex 历史里。

会话记忆通过 Drizzle 读写原有的 `memory.sqlite`。表定义在 `apps/bot/src/db/memory-schema.ts`，改动后运行 `pnpm db:generate --name <变更名>` 生成迁移。Bot 启动时自动应用 `apps/bot/drizzle/memory` 中的新迁移。

验证时，先用自然语言问某个 PR 的 CI，再重启 Bot，在同一私聊或群线程追问「只看最新提交」。Bot 会承接前一轮的 PR，并重新查询 GitHub。在私聊里用 `/session` 对照重启前后的会话 ID。

## GitHub 私聊提醒

1. 在 `.env` 设置 `LARK_GITHUB_ALERTS=1`，使用已有 GitHub 查询凭据和绑定的 `LARK_OWNER_OPEN_ID`。默认每 120 秒轮询自己发起的开放 PR。用 `GH_TRACKED_PRS="owner/repo#123,owner/repo#456"` 可以加上要跟踪的 PR。
2. 重启 `pnpm lark`。第一次观察每个 PR 只记录基线。之后在新提交失败或从非失败变为失败时，Bot 把提交、PR 链接和可读到的失败检查发到绑定账号的私聊。
3. 如需接收 GitHub 的 @、评审请求和相关评论通知，设置同一 GitHub 账号的 `GH_NOTIFICATIONS_TOKEN`，使用带 `notifications` 权限的 classic PAT。第一次读取个人通知也只建立基线，随后按 GitHub 返回的间隔轮询。

提醒与状态变化一起写入本地 SQLite。重启会继续发送已入队且明确待发的提醒。发送前确认断线或 Lark 限流会按退避重试。发送结果无法确认时，队列会保留记录供核对。终端的 `github_alert.delivery` 记录提醒 ID 和发送结果。

### Star 提醒

在 `.env` 选择要跟踪的范围，再重启 Bot。Star 提醒单独启用，通过绑定账号的 Lark 私聊发送。

| 配置 | 跟踪范围 |
| --- | --- |
| `GH_STAR_REPO_SOURCE=watched` | 当前 GitHub 凭据账号 Watch 的仓库。Fine-grained token 需要 Watching 用户权限（Read）。 |
| `GH_STAR_REPO_SOURCE=accessible` | 凭据能列出的自有仓库、协作仓库和组织仓库。 |
| `GH_STAR_REPOSITORIES=owner/repo,owner/another-repo` | 指定仓库。可单独使用，或加到前两种范围中。 |

默认每 5 分钟读取一次，可以用 `GH_STAR_POLL_SECONDS` 调整。每个仓库首次读取时只记录基线。后续发现总数增长时，按仓库私聊发出净增量和当前总数，重启后沿用已有基线。同一轮的加星与取消 Star 会反映在净增量里。

同时配置 Star 轮询和 GitHub App Webhook 时，Star 默认继续走轮询，即使同一个仓库使用 CI Webhook。确认 GitHub App 已订阅 Star 后，设 `GH_STAR_WEBHOOK=1` 可让该 Webhook 仓库改走逐条 Star 事件。切回轮询时重新建立计数基线。仅配置 Webhook 时默认接收 Star 事件，用 `GH_STAR_WEBHOOK=0` 可关闭。

## GitHub App Webhook

1. 为一个测试仓库安装 GitHub App。在 App 后台订阅 Star、Fork、Pull request，以及 Checks、Workflow run 或 Commit status 中需要的事件。权限按订阅事件选择。
2. 在 `.env` 配置 `LARK_GITHUB_ALERTS=1`、`GH_WEBHOOK_REPOSITORY=owner/repo` 和 `GH_WEBHOOK_SECRET`。重启后 Fastify 默认监听本机 `127.0.0.1:8787`，可用 `GH_WEBHOOK_PORT` 改端口。
3. 让已有的 HTTPS 反向代理将 GitHub App 的 Webhook URL 转发到 `POST /webhooks/github`，保留原始请求体和签名头。先在 GitHub 的 Recent Deliveries 检查投递，再重投同一条 delivery 验证去重。

验签后的事件先入 SQLite 再返回成功。新增 star 或 fork 会进入绑定账号的私聊投递队列。PR 和 CI 事件会触发只读刷新，范围沿用当前跟踪的 PR。CI 以最新提交为准，Webhook 与轮询共用状态记录。

## GitHub 组织仓库

如需读取组织仓库，给同一个 GitHub 用户配置仅限对应组织和仓库的只读 `GH_ORG_TOKEN`，以及用逗号分隔的 `GH_EXPECTED_REPOS`。查询合并两个凭据可见的 PR，并提示其中无法访问的仓库。如果组织需要审核，审核通过后才能读取私有仓库。

私有 PR 的 CI 明细取决于凭据能否读取该仓库的 check runs 和 commit statuses。Bot 会提示明细不全或不可用，并尽可能提供可见的 PR 和 CI 状态。
