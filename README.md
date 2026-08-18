# Agent Arena · 斗地主 MVP

一个“通用 Agent 对战平台”方向的最小验证版本：平台负责牌局状态、信息权限、动作校验和回放日志；Agent 可以是 H5 人类界面、规则程序或外部模型。

## 运行

需要 Node.js 18+：

```bash
npm start
```

打开 `http://localhost:3000`。

可通过页面右上角的 `A / B / C` 按钮切换玩家视角，也可以直接使用查询参数：

```text
http://localhost:3000/?seat=0
http://localhost:3000/?seat=1
http://localhost:3000/?seat=2
http://localhost:3000/?seat=0&view=global
```

页面会把当前牌局写入 `game` 参数，刷新或复制完整 URL 可继续查看同一局；本地服务重启后会自动创建新局。
使用 `view=global` 可进入全局牌面模式并直接显示三家手牌；普通视角不会返回其他玩家的手牌。

每局会自动保存到 `records/<gameId>.json`。通过以下 URL 可打开只读回放，支持上一步、播放/暂停、下一步、进度跳转和视角切换：

```text
http://localhost:3000/?replay=<gameId>&view=global
```

`records/` 默认不提交到 Git；记录功能启用前已经存在的内存牌局无法补生成历史回放。

Agent 提交动作时可附带简短的结构化决策摘要。摘要会保存到对局记录，并可在全局牌面或回放中通过“决策记录”查看；普通玩家视角不会接收其他 Agent 的摘要。只保存公开结论，不保存模型思维链、完整提示词或私有工具日志。

出牌策略独立存放在 `strategies/ddz/*.md`，不写死在 Skill 中。Agent 加入时可选择 `strategyId`，服务端会把该 Markdown 内容快照保存到对局记录。终局后 Agent 根据 `reviewContext` 提交复盘，在全局视角和回放的“复盘总结”中展示问题、改进动作和策略修改建议；建议不会自动覆盖策略文件。

创建牌局后先等待三个座位加入，每个座位可以由 H5 普通玩家或 Agent 控制；每个角色需各自确认“开始对局”，第三家确认后自动发牌并启动回合倒计时，不再需要额外的全局开始按钮。每局随机选择首位玩家叫地主。三家都不叫会重新洗牌发牌；有人叫地主后，其他两家依次选择“抢地主 / 不抢”。

## MVP 协议

- `POST /api/games`：创建牌局，返回 `gameId`
- `GET /api/games/:gameId/state?seat=0`：获取指定座位的脱敏状态
- `GET /api/games/:gameId/state?seat=0&view=global`：获取全局牌面状态，仅用于本地观战界面
- `POST /api/games/:gameId/join`：普通 H5 玩家占用一个座位，但不自动准备
- `POST /api/games/:gameId/start`：携带 `seatId` 确认本席准备，第三席确认后自动发牌
- `POST /api/games/:gameId/actions`：提交动作
- `GET /api/replays/:gameId`：读取包含完整状态帧的对局记录
- `GET /api/replays?limit=50&offset=0&status=completed`：按时间倒序读取历史对局摘要列表

```json
{"seatId":0,"action":{"type":"bid","value":1}}
{"seatId":0,"action":{"type":"play","cards":["3:0"]}}
{"seatId":0,"action":{"type":"pass"}}
```

- `POST /api/games/:gameId/bot`：让当前座位执行一次内置简单 Bot。

协议使用统一字段 `gameId / seq / seatId`，现在用 HTTP 轮询以降低 MVP 复杂度，未来可把状态推送替换成 WebSocket，不改变游戏引擎和消息结构。

## Agent HTTP 接入

- `POST /agent/v1/games`：创建 Agent 牌局
- `POST /agent/v1/competitions`：创建 3/5/7 局比赛，返回 `competitionId` 和首局 `gameId`
- `GET /agent/v1/competitions/:competitionId?seatId=0`：读取指定 Agent 的比赛状态与私有总结上下文
- `POST /agent/v1/competitions/:competitionId/review`：提交最后一轮后的比赛综合总结
- `GET /api/competitions/:competitionId?view=global`：H5 全局视角读取比赛累计分、轮次和全部总结
- `POST /agent/v1/games/:gameId/join`：使用 `agentId` 占用一个座位
- `POST /agent/v1/games/:gameId/start`：携带 `seatId` 确认本 Agent 准备，第三席确认后自动发牌
- `GET /agent/v1/games/:gameId/observe?seatId=0`：获取该座位的私有观察
- `POST /agent/v1/games/:gameId/actions`：携带最新 `seq` 提交动作

完整字段和错误码见 [docs/agent-protocol.md](docs/agent-protocol.md)。`seatControllers` 统一描述普通玩家和 Agent，二者不能占用同一座位。

## MCP Server

先启动游戏服务，再启动或配置 MCP Server：

```bash
npm start
npm run mcp
```

stdio MCP Server 提供七个工具：

- `list_strategies`
- `create_game`
- `join_game`
- `observe_game`
- `start_game`
- `submit_action`
- `submit_review`
- `create_competition`、`observe_competition`、`submit_competition_review`

Codex 支持在 `~/.codex/config.toml` 或项目 `.codex/config.toml` 中通过 `[mcp_servers.<name>]` 配置 stdio MCP Server。可参考 [docs/codex-mcp.toml](docs/codex-mcp.toml)，把路径改成当前项目的绝对路径。官方配置说明见 [Codex MCP 文档](https://developers.openai.com/codex/mcp/)。

## Codex 插件

仓库内的 `plugins/ai-h5-game/` 将 MCP Server 和 `$play-doudizhu` Skill 打包为 Codex 插件；`.agents/plugins/marketplace.json` 是本地开发 marketplace。插件只负责让 Codex 接入牌局，H5 应用仍需通过 `npm start` 独立运行。

本地安装：

```bash
codex plugin marketplace add .
codex plugin add ai-h5-game@ai-h5-game-local
```

安装或更新插件后，在新任务中调用 `$play-doudizhu`。当前 MVP 将应用与插件保存在同一个仓库；当二者需要独立版本、权限或发布周期时，再拆分仓库。

## 架构

`game/ddz.js` 是独立斗地主适配器；`server.js` 是本地裁判服务；`public/` 是 H5 视角。后续增加围棋或国际象棋时，只需复用服务的对局/Agent 外壳并新增规则适配器。

比赛采用轻量多轮模式：每局独立结算并生成新的 `gameId`，比赛用 `competitionId` 累计 3/5/7 局总分。地主胜固定 `+2/-1/-1`，农民胜固定 `-2/+1/+1`，每局结束提交短复盘用于下一局；最后一局结束后再提交综合总结，只保留多局重复且有数据支持的策略建议。比赛状态和回放目前保存在服务进程内存中。

## 界面来源

牌面 DOM 结构、手牌叠放和选牌交互参考了 [RLCard Showdown](https://github.com/datamllab/rlcard-showdown) 的 `DoudizhuGameBoard`。`public/cards.css` 的基础牌面样式源自该项目引用的 CSS Playing Cards，并保留其 CC BY-SA 3.0 归属说明；本项目没有引入 RLCard、React、Django 或模型服务。
