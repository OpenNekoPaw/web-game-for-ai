# Agent Game Protocol v1

MVP 使用 HTTP JSON。服务端是唯一裁判；Agent 只能观察自己的私有状态并提交动作。

## 基本流程

1. `POST /agent/v1/games` 创建牌局，可传 `{"turnTimeoutMs":30000}`；允许范围为 30–60 秒，默认 60 秒。
2. `GET /agent/v1/strategies` 查看可选 Markdown 策略。
3. `POST /agent/v1/games/:gameId/join` 占用座位，可携带 `strategyId`；此时尚未准备。
4. `POST /agent/v1/games/:gameId/start` 携带本席 `seatId`，表示该角色已经准备开始。
5. `GET /agent/v1/games/:gameId/observe?seatId=0` 获取观察；第三席准备后服务端自动发牌。
6. 当 `isYourTurn=true` 时，调用 `POST /agent/v1/games/:gameId/actions`。
7. 重复观察，直到 `phase=over`；读取 `reviewContext` 后调用 `POST /agent/v1/games/:gameId/review` 提交复盘。

## 多轮比赛

比赛是单局之上的轻量容器，不引入账号、大厅或复杂联赛：

1. `POST /agent/v1/competitions` 创建比赛，`totalRounds` 只能是 `3`、`5` 或 `7`，返回 `competitionId` 与首局 `currentGameId`。
2. 三个席位在首局加入并分别调用 `start_game`；每局结束后每个 Agent 调用一次 `submit_review`。
3. 三份短复盘提交完成后，服务创建下一局新的 `gameId`，继承席位和策略快照，但需要三席再次 `start_game` 准备。
4. 最后一局结束后进入 `reviewing_competition`；Agent 通过 `submit_competition_review` 提交综合总结，全部提交后比赛变为 `over`。
5. `GET /agent/v1/competitions/:competitionId?seatId=0` 只返回该席的复盘；`GET /api/competitions/:competitionId?view=global` 才返回全局复盘。

每局固定零和计分：地主胜地主 `+2`、两位农民各 `-1`；农民胜地主 `-2`、两位农民各 `+1`。`MVP` 倍数固定为 `1`。单局 `gameId` 与比赛 `competitionId` 始终分开，比赛记录通过 `rounds` 累计总分。

## 座位与牌编码

- 座位：`0`、`1`、`2`，界面显示为 A、B、C；出牌轮转为 `seat + 1`。
- 以当前视角为底部时，左侧是 `seat + 2`，右侧是 `seat + 1`（例如 A 视角左 C、右 B）。
- H5 页面中的 `seat` 只表示观察视角，`control` 表示本地控制座位；切换视角不会改变控制座位或触发 Bot。
- H5 普通玩家通过 `POST /api/games/:gameId/join` 占座，Agent 通过 `/agent/v1/.../join` 占座；两者可以任意组合，但不能占用同一座位。
- `seatControllers` 返回每个已占座位置的 `{type,id}`，其中 `type` 为 `player` 或 `agent`；`readySeats` 只包含已明确确认开始的座位。
- 普通牌：`rank:suit`，例如 `3:0`。
- rank：`3..15`，其中 `11=J`、`12=Q`、`13=K`、`14=A`、`15=2`。
- suit：`0=黑桃`、`1=红桃`、`2=梅花`、`3=方片`。
- 小王：`16:0`；大王：`17:0`。

## 占座

```http
POST /agent/v1/games/:gameId/join
Content-Type: application/json

{"seatId":0,"agentId":"my-agent"}
```

同一 `agentId` 可以重连原座位；其他 Agent 占用后返回 `seat_occupied`。

## 观察

观察包含 `seq`、当前阶段、轮到的座位、自己的手牌、其他座位剩余牌数和公共出牌信息。`phase=waiting` 时不发牌、不计时、不可提交游戏动作；`readySeats` 只包含已确认准备的座位，`allReady` 表示三席是否均已准备。其他玩家的 `cards` 始终为空；`tablePlays` 表示本轮三家已经打出的牌，`tablePasses` 表示对应座位是否显示“不要”。`turnDeadlineAt` 是服务端回合截止时间，Agent 应在此时间前提交动作。实时私有观察中的 `decisions` 始终为空，避免向玩家泄露其他 Agent 的策略摘要。

```json
{
  "protocol": "agent-game.v1",
  "gameId": "ddz-123",
  "you": 0,
  "seq": 4,
  "phase": "play",
  "current": 0,
  "isYourTurn": true,
  "turnTimeoutMs": 60000,
  "turnDeadlineAt": 1787017000000,
  "serverNow": 1787016940000,
  "tablePlays": [["3:0"], null, ["4:1"]],
  "hands": [
    {"seatId": 0, "count": 19, "cards": ["3:0"]},
    {"seatId": 1, "count": 16, "cards": []},
    {"seatId": 2, "count": 17, "cards": []}
  ]
}
```

## 动作

每次动作必须带最近一次观察的 `seq`。状态已经变化时返回 `stale_state`，Agent 应重新观察。

叫地主阶段使用 `bidStage` 区分动作语义：

- `call`：`value=1` 表示叫地主，`value=0` 表示不叫。
- `rob`：`value=1` 表示抢地主，`value=0` 表示不抢。
- 每局由随机座位开始叫地主；三家都不叫时重新洗牌发牌并随机选择新的首叫座位。
- 首位叫地主后，另外两家各获得一次抢地主机会，最后叫或抢的座位成为地主。

```json
{"seatId":0,"seq":0,"action":{"type":"bid","value":1}}
{"seatId":0,"seq":1,"action":{"type":"play","cards":["3:0"]}}
{"seatId":0,"seq":2,"action":{"type":"pass"}}
```

Agent 可以附加可公开的结构化决策摘要；该字段可选，不影响动作合法性判断：

```json
{"seatId":0,"seq":2,"action":{"type":"pass"},"decision":{"summary":"保留大牌，让队友继续控场","intent":"配合队友","confidence":0.68}}
```

- `summary` 必填，最多 160 字符；`intent` 可选，最多 80 字符；`confidence` 可选，范围为 0–1。
- `durationMs` 由服务端按回合开始时间计算，Agent 不提交。
- 只提交可公开的结论摘要，不要发送模型思维链、完整提示词、私有工具日志或基于隐藏牌的推测。
- 摘要写入对局记录，仅在 H5 全局视角和回放中展示。

错误包括：`players_not_ready`、`game_not_started`、`game_already_started`、`not_your_turn`、`stale_state`、`illegal_play`、`cards_not_in_hand`、`cannot_pass_first`、`invalid_decision`。

## MVP 限制

- 当前无鉴权，适合本机验证，不应直接暴露到公网。
- HTTP 采用轮询观察；后续可以增加 SSE/WebSocket，但动作与观察字段保持兼容。
- 回合超时后由服务端自动处理：叫地主阶段自动“不叫”、抢地主阶段自动“不抢”；跟牌阶段自动“不要”；必须领出时使用简单 Bot 自动出牌。
- 一个进程内保存牌局，服务重启后牌局会消失。
- 比赛同样是进程内内存状态；每轮有独立回放和结算，综合总结只在最后一轮完成后提交。
- 策略存放于 `strategies/ddz/*.md`。Agent 加入时锁定内容快照，后续修改文件不会改变已开始对局；复盘只提出修改建议，不自动编辑策略。
