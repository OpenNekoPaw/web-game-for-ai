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

每局随机选择首位玩家叫地主。三家都不叫会重新洗牌发牌；有人叫地主后，其他两家依次选择“抢地主 / 不抢”。

## MVP 协议

- `POST /api/games`：创建牌局，返回 `gameId`
- `GET /api/games/:gameId/state?seat=0`：获取指定座位的脱敏状态
- `GET /api/games/:gameId/state?seat=0&view=global`：获取全局牌面状态，仅用于本地观战界面
- `POST /api/games/:gameId/actions`：提交动作

```json
{"seatId":0,"action":{"type":"bid","value":1}}
{"seatId":0,"action":{"type":"play","cards":["3:0"]}}
{"seatId":0,"action":{"type":"pass"}}
```

- `POST /api/games/:gameId/bot`：让当前座位执行一次内置简单 Bot。

协议使用统一字段 `gameId / seq / seatId`，现在用 HTTP 轮询以降低 MVP 复杂度，未来可把状态推送替换成 WebSocket，不改变游戏引擎和消息结构。

## Agent HTTP 接入

- `POST /agent/v1/games`：创建 Agent 牌局
- `POST /agent/v1/games/:gameId/join`：使用 `agentId` 占用一个座位
- `GET /agent/v1/games/:gameId/observe?seatId=0`：获取该座位的私有观察
- `POST /agent/v1/games/:gameId/actions`：携带最新 `seq` 提交动作

完整字段和错误码见 [docs/agent-protocol.md](docs/agent-protocol.md)。Agent 占用座位后，网页不会再用内置 Bot 代替该座位行动。

## MCP Server

先启动游戏服务，再启动或配置 MCP Server：

```bash
npm start
npm run mcp
```

stdio MCP Server 提供四个工具：

- `create_game`
- `join_game`
- `observe_game`
- `submit_action`

Codex 支持在 `~/.codex/config.toml` 或项目 `.codex/config.toml` 中通过 `[mcp_servers.<name>]` 配置 stdio MCP Server。可参考 [docs/codex-mcp.toml](docs/codex-mcp.toml)，把路径改成当前项目的绝对路径。官方配置说明见 [Codex MCP 文档](https://developers.openai.com/codex/mcp/)。

## 架构

`game/ddz.js` 是独立斗地主适配器；`server.js` 是本地裁判服务；`public/` 是 H5 视角。后续增加围棋或国际象棋时，只需复用服务的对局/Agent 外壳并新增规则适配器。

## 界面来源

牌面 DOM 结构、手牌叠放和选牌交互参考了 [RLCard Showdown](https://github.com/datamllab/rlcard-showdown) 的 `DoudizhuGameBoard`。`public/cards.css` 的基础牌面样式源自该项目引用的 CSS Playing Cards，并保留其 CC BY-SA 3.0 归属说明；本项目没有引入 RLCard、React、Django 或模型服务。
