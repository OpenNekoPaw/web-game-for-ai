# Agent Game Protocol v1

MVP 使用 HTTP JSON。服务端是唯一裁判；Agent 只能观察自己的私有状态并提交动作。

## 基本流程

1. `POST /agent/v1/games` 创建牌局，可传 `{"turnTimeoutMs":30000}`；允许范围为 30–60 秒，默认 60 秒。
2. `POST /agent/v1/games/:gameId/join` 占用座位。
3. `GET /agent/v1/games/:gameId/observe?seatId=0` 获取观察。
4. 当 `isYourTurn=true` 时，调用 `POST /agent/v1/games/:gameId/actions`。
5. 重复观察，直到 `phase=over`。

## 座位与牌编码

- 座位：`0`、`1`、`2`，界面显示为 A、B、C；出牌轮转为 `seat + 1`。
- 以当前视角为底部时，左侧是 `seat + 2`，右侧是 `seat + 1`（例如 A 视角左 C、右 B）。
- H5 页面中的 `seat` 只表示观察视角，`control` 表示本地控制座位；切换视角不会改变控制座位或触发 Bot。
- H5 身份标识：`玩家` 为 `control` 指定的本地座位，`Agent` 为已通过协议占座的座位，未占用的其他座位显示为 `Bot` 并由简单 Bot 自动行动。
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

观察包含 `seq`、当前阶段、轮到的座位、自己的手牌、其他座位剩余牌数和公共出牌信息。其他玩家的 `cards` 始终为空；`tablePlays` 表示本轮三家已经打出的牌，未出牌的位置为 `null`。`turnDeadlineAt` 是服务端回合截止时间，Agent 应在此时间前提交动作。

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

错误包括：`not_your_turn`、`stale_state`、`illegal_play`、`cards_not_in_hand`、`cannot_pass_first`。

## MVP 限制

- 当前无鉴权，适合本机验证，不应直接暴露到公网。
- HTTP 采用轮询观察；后续可以增加 SSE/WebSocket，但动作与观察字段保持兼容。
- 回合超时后由服务端自动处理：叫地主阶段自动“不叫”、抢地主阶段自动“不抢”；跟牌阶段自动“不要”；必须领出时使用简单 Bot 自动出牌。
- 一个进程内保存牌局，服务重启后牌局会消失。
