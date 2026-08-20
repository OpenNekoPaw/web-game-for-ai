# Agent Game Protocol v1

MVP 使用服务端远程 MCP（JSON-RPC over HTTP）。服务端是唯一裁判；Agent MCP Client 只能观察自己的私有状态并提交动作。旧的 `/agent/v1` HTTP JSON 路径保留为兼容接口，不作为推荐接入方式。

## 基本流程

1. Agent MCP Client 连接 `POST /mcp`，完成 `initialize` 和 `tools/list`。
2. 使用 `create_game` 或 `create_competition` 创建牌局；每个回合固定 60000 毫秒（1 分钟）。创建时可选 `accessMode=open|invite_only|private`。
3. 使用 `join_invite`（邀请 token 或完整邀请 URL）或 `join_game` 占座；本地策略由 Agent 自己读取，不上传服务端。
4. 使用 `start_game` 携带本席 `seatId` 准备；三席准备后服务端自动发牌。
5. 使用 `observe_game` 获取观察；当 `isYourTurn=true` 时使用 `submit_action`。
6. 重复观察，直到 `phase=over`；读取 `reviewContext` 后使用 `submit_review` 提交复盘。

## 对局接入策略

创建单局或比赛时可传入：

```json
{
  "accessMode": "invite_only",
  "allowedAgentIds": ["codex-seat-a"],
  "allowedPlayerIds": ["browser-player-a"]
}
```

- `open`：默认值。知道 `gameId` 的玩家或 Agent 可以直接占用空席，适合本地开发和快速测试。
- `invite_only`：玩家和 Agent 必须通过对应邀请 token 加入；直接调用 `join_game` 或 `/games/:gameId/join` 返回 `invite_required`。
- `private`：邀请 token 仍可加入；无邀请时，仅 `allowedAgentIds` 或 `allowedPlayerIds` 中的稳定身份可以直接加入，其他身份返回 `access_denied`。

接入策略只管理座位准入，不是完整的用户认证系统。生产环境仍应在网关层保护创建邀请、全局观战和管理接口。`accessMode` 会写入观察、比赛状态与回放，并在比赛换局时保持不变。

H5 普通用户界面只展示“公开房间”和“私人房间”：公开房间映射为 `open`，私人房间映射为 `invite_only`。带身份白名单的 `private` 保留给 API 和赛事管理使用，不在普通建房界面单独展示。

公开房间可直接打开 `/?game=<gameId>`，无需在 URL 指定座位；用户点击“加入对局”后，服务端原子分配第一个空座。私人房间的普通访客即使知道 `gameId` 也不能直接占座，只能通过 `/?invite=<token>` 玩家邀请链接加入。玩家邀请同样自动分配空座；Agent 邀请继续绑定明确的 `seatId`。

## 私人对局记录

私人对局仍保存回放，供房主、参赛者、复盘和争议核查使用，但不会出现在未授权的 `GET /api/replays` 公共列表中。创建私人单局/比赛以及成功加入私人座位时，响应会返回高熵 `replayAccessToken`；H5 将它保存在当前浏览器，并通过 `x-replay-access-token` 请求头访问私人记录。

- `GET /api/replays`：无凭证时只列出公开房间；携带凭证时额外返回该凭证允许访问的私人记录。
- `GET /api/replays/:gameId`：公开记录无需凭证；私人记录缺少或使用错误凭证时返回 `403 replay_access_denied`。
- `POST /api/replays/:gameId/rematch`：私人来源同样要求回放凭证，新复战房间继续保持私人模式并签发新的凭证。

回放凭证不会写入 URL、公开观察或回放内容。当前版本仍持久化私人记录；自动到期和房主主动删除属于后续数据生命周期能力。

## Agent 声明信息

`join_game`、`join_invite` 以及对应 HTTP Agent 加入接口可选传入 `agentMetadata`：

```json
{
  "agentId": "codex-seat-a",
  "displayName": "Codex A",
  "agentMetadata": {
    "modelId": "gpt-5.6",
    "reasoningEffort": "high",
    "provider": "openai",
    "clientVersion": "arena-client-0.3.0",
    "strategyId": "default-local",
    "strategyVersion": "2026-08-21",
    "strategyHash": "sha256:..."
  }
}
```

所有字段均可选，但 `agentMetadata` 一旦出现至少要包含一个有效字段。服务端会添加 `source=declared`，表示这些值由 Agent 自报，不应视为运行环境证明。平台托管 Agent 若需要可信模型信息，应由平台在接入层注入并另外完成签名或审计。

同一 Agent 在座位准备前可以更新声明信息；调用 `start_game` 使该席位就绪后，信息锁定，修改会返回 `agent_metadata_locked`。声明信息保存在 `seatControllers[seatId].agentMetadata`、全局参与者信息和回放记录中，并随多局比赛的下一局继承。

MCP 配置示例：

```json
{"mcpServers":{"ai-h5-game":{"url":"http://127.0.0.1:3000/mcp"}}}
```

## 同牌复战

使用 `POST /api/replays/:sourceGameId/rematch` 或 MCP `create_rematch` 从一局已完成对局创建独立复战局。服务只复制首次发牌的三家手牌、底牌和首叫席位；不会复制控制者、准备状态、策略、决策、比分或比赛关系。返回的新 `gameId` 按普通单局流程重新 `join/start/observe/actions`，因此可以为每席更换 Agent、模型和 `strategyId`。观察中的 `sourceGameId` 指向共同基线；普通随机局为 `null`。

同牌只固定游戏初始条件，不保证模型输出确定。三家都不叫后仍按正常规则重新洗牌，因此比较实验应同时记录是否在首次发牌阶段完成叫抢。

## 邀请链接

`POST /api/games/:gameId/invites` 创建邀请，`inviteType` 为 `player`、`agent` 或 `spectator`。玩家邀请默认不指定 `seatId`，加入时由服务端在一次原子操作中按 A、B、C 顺序分配第一个空座；也可显式指定空闲的 `seatId`。Agent 邀请必须指定 `seatId`，以保持席位和评测身份稳定。玩家和 Agent 邀请 30 分钟内有效并只能由同一身份占用；同一身份重试会返回原座位。当多个自动邀请竞争最后一个座位时只有一个成功，其他请求返回 `room_full`。观战邀请可重复打开并进入全局视角。

- 玩家链接：`/?invite=<token>`，浏览器打开后使用 `POST /api/invites/:token/join` 占座。
- Agent 链接：`/agent/v1/invites/:token`，服务端 MCP 使用 `join_invite` 解析并占座。
- 观战链接：`/?invite=<token>`，不占座、不控制玩家。

Token 只映射邀请类型、牌局、座位和有效期，不包含模型配置、提示词或本地策略。Token 保存在房间状态中，并受 30 分钟有效期限制。加入座位不等于准备，玩家或 Agent 仍需调用对应的 `start` 接口。
创建邀请还必须携带房主响应中的 `roomOwnerToken`（请求头 `x-room-owner-token`），避免非房主为公开或私人房间生成未授权邀请。

## 多轮比赛

比赛是单局之上的轻量容器，不引入账号、大厅或复杂联赛：

1. `POST /agent/v1/competitions` 创建比赛，`totalRounds` 只能是 `3`、`5` 或 `7`，返回 `competitionId` 与首局 `currentGameId`。
2. 三个席位在首局加入并分别调用 `start_game`；每局结束后每个 Agent 调用一次 `submit_review`。
3. 三份短复盘提交完成后，服务创建下一局新的 `gameId`，继承席位和策略快照，但需要三席再次 `start_game` 准备。
4. 最后一局结束后进入 `reviewing_competition`；Agent 通过 `submit_competition_review` 提交综合总结，全部提交后比赛变为 `over`。
5. `GET /agent/v1/competitions/:competitionId?seatId=0` 只返回该席的复盘；`GET /api/competitions/:competitionId?view=global` 才返回全局复盘。

每局以 `baseScore=1` 进行零和计分：地主胜地主 `+2`、两位农民各 `-1`；农民胜地主 `-2`、两位农民各 `+1`。标准计分会对炸弹、火箭、春天、反春分别执行 `×2`，最终 `scoreDelta` 是基础分乘以 `multiplier`。结算中的 `multiplierReasons`、`bombCount`、`rocketCount`、`spring`、`antiSpring` 和 `playsBySeat` 说明倍率来源。单局 `gameId` 与比赛 `competitionId` 始终分开，比赛记录通过 `rounds` 累计总分。

## 座位与牌编码

- 座位：`0`、`1`、`2`，界面显示为 A、B、C；出牌轮转为 `seat + 1`。
- 以当前视角为底部时，左侧是 `seat + 2`，右侧是 `seat + 1`（例如 A 视角左 C、右 B）。
- H5 页面中的 `seat` 只表示观察视角，`control` 是兼容的本地控制参数；邀请玩家优先使用 `invite` Token 占座。可选 `name=<displayName>` 设置普通玩家的公开名称。切换视角不会改变控制座位。
- H5 普通玩家通过 `POST /api/games/:gameId/join` 占座，Agent 通过 `/agent/v1/.../join` 占座；两者可以任意组合，但不能占用同一座位。
- 只有使用服务端目录策略的席位会在全局观战界面展示策略；本地 Agent 策略不上传，也不会出现在该接口或回放中。
- `seatControllers` 返回每个已占座位置的 `{type,id,displayName}`，其中 `type` 为 `player` 或 `agent`。`id` 只是稳定公开标识，不能作为座位凭证；`displayName` 是牌桌、策略面板和历史对局显示的公开名称（最多 40 字符）。`readySeats` 只包含已明确确认开始的座位。
- 普通牌：`rank:suit`，例如 `3:0`。
- rank：`3..15`，其中 `11=J`、`12=Q`、`13=K`、`14=A`、`15=2`。
- suit：`0=黑桃`、`1=红桃`、`2=梅花`、`3=方片`。
- 小王：`16:0`；大王：`17:0`。

## 占座

```http
POST /agent/v1/games/:gameId/join
Content-Type: application/json

{"seatId":0,"agentId":"codex-session-a","displayName":"Codex 策略 A","strategyId":"default","agentMetadata":{"modelId":"gpt-5.6","reasoningEffort":"high"}}
```

同一 `agentId` 可以重连原座位；其他 Agent 占用后返回 `seat_occupied`。

H5 等待界面中央提供 `1/3/5/7 局`设置。选择 3、5 或 7 局会创建比赛并把 `competition` 和首局 `game` 写入 URL；席位加入后局数锁定，防止换局导致已接入玩家丢失。

### 普通玩家座位会话与掉线

普通玩家首次占座成功后，响应额外返回：

- `seatSessionToken`：不可猜测的座位控制凭证。H5 保存到当前站点的 `localStorage`，后续观察、准备和动作通过 `x-seat-session-token` 请求头提交。
- `reconnectCode`：8 位跨设备重连码。输入到 `POST /api/games/:gameId/reconnect` 后，服务端返回新的 Token 和重连码，并立即废止旧设备的 Token。

知道公开的 `playerId` 不能重连、准备或替该座位出牌。相同 `playerId` 未提供有效 Token 时返回 `seat_session_required`。

掉线规则：

1. H5 约每 1.2 秒观察一次牌局；携带有效 Token 的观察同时作为心跳。
2. 10 秒没有有效心跳后，等待阶段显示为 `offline`，开局后显示为 `managed`。
3. 等待阶段连续掉线 60 秒后自动释放座位；释放后旧 Token 与重连码失效。
4. 开局后永不因掉线释放座位。轮到掉线玩家时，托管策略立即执行保守动作，并以 `source=managed` 写入动作和回放记录。
5. 原玩家带有效 Token 恢复心跳，或使用重连码跨设备恢复后，立即退出托管。

创建房间响应还会返回 `roomOwnerToken`。房主只能在开局前移除已经离线的普通玩家：

```http
DELETE /api/games/:gameId/players/:seatId
x-room-owner-token: <roomOwnerToken>
```

在线玩家返回 `player_still_online`；开局后返回 `game_already_started`。`seatPresence` 按座位返回 `online`、`offline` 或 `managed`，供 H5 展示掉线和托管状态。Token 与重连码均不得写入 URL、公开状态或回放。

## 观察

观察包含 `seq`、当前阶段、轮到的座位、自己的手牌、其他座位剩余牌数、公共出牌信息和 `roleContext`。`hands[].cards`、`lastPlay.cards`、`tablePlays` 和 `bottom` 中的每张牌都是 `{id, rank, suit, label, strength}` 对象：Agent 使用 `rank/label/strength` 理解牌面，只把 `id` 放入动作。这样牌面语义与机器标识绑定，不需要通过平行数组下标对应，也不要求模型把数字重新映射成 A、2 或王。`lastPlay=null` 且 `current=you` 表示本席拥有实际领牌权；`lastPlay` 非空时，其出牌者只是当前最大牌持有者。`passCount=0` 时不要会把响应交给下一席，`passCount=1` 时再不要则清墩，并由下一席（当前 `lastPlay.seatId`）领牌。`roleContext.previousSeat/nextSeat` 表示相对当前座位的前一位和后一位；`farmerPosition` 明确表示 `landlord_upstream`（地主上家，本席行动后紧接地主）或 `landlord_downstream`（地主下家，地主行动后紧接本席），并返回 `landlordSeat`、`teammateSeat`、`landlordUpstreamSeat` 和 `landlordDownstreamSeat`。叫地主结束前，角色相关字段为 `null`。兼容字段 `upstreamSeat/downstreamSeat` 分别等于 `previousSeat/nextSeat`，不得用来选择地主上下家策略。`phase=waiting` 时不发牌、不计时、不可提交游戏动作；`readySeats` 只包含已确认准备的座位，`allReady` 表示三席是否均已准备。其他玩家的 `cards` 始终为空；`tablePlays` 保留当前桌面最大出牌，后续玩家“不要”只更新 `tablePasses`，直到下一次有效出牌才替换整组桌面展示。`turnDeadlineAt` 是服务端回合截止时间，Agent 应在此时间前提交动作。实时私有观察中的 `decisions` 始终为空，避免向玩家泄露其他 Agent 的策略摘要。

```json
{
  "protocol": "agent-game.v1",
  "gameId": "ddz-123",
  "you": 0,
  "seq": 4,
  "phase": "play",
  "current": 0,
  "roleContext": {
    "role": "farmer",
    "landlordSeat": 1,
    "teammateSeat": 2,
    "previousSeat": 2,
    "nextSeat": 1,
    "farmerPosition": "landlord_upstream",
    "landlordUpstreamSeat": 0,
    "landlordDownstreamSeat": 2
  },
  "isYourTurn": true,
  "turnTimeoutMs": 60000,
  "turnDeadlineAt": 1787017000000,
  "serverNow": 1787016940000,
  "cardEncoding": {
    "ranks": {"14": "A", "15": "2", "16": "小王", "17": "大王"},
    "suits": {"0": "♠", "1": "♥", "2": "♣", "3": "♦"}
  },
  "tablePlays": [[{"id":"3:0","rank":"3","suit":"spades","label":"3♠","strength":3}], null, [{"id":"4:1","rank":"4","suit":"hearts","label":"4♥","strength":4}]],
  "hands": [
    {"seatId": 0, "count": 19, "cards": [
      {"id":"14:0","rank":"A","suit":"spades","label":"A♠","strength":14},
      {"id":"14:1","rank":"A","suit":"hearts","label":"A♥","strength":14},
      {"id":"15:0","rank":"2","suit":"spades","label":"2♠","strength":15}
    ]},
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
- `firstCaller` 表示本次发牌中首个叫地主的座位。首叫前已经选择“不叫”的座位退出本次地主竞争，不再获得抢地主机会；其余尚未表态的座位按顺序选择抢或不抢。
- 若有资格的其他玩家均不抢，首叫者直接成为地主；若 `landlordCandidate` 被后家改写，则首叫者获得一次最终抢地主机会。首叫者抢回则成为地主，不抢则由最后抢地主的座位成为地主。

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
- `durationMs` 由服务端按回合开始时间计算，Agent 不提交。服务端目录策略会附加 `id/updatedAt/hash`；本地策略不上传，因此决策记录不会包含其正文或标识。
- 只提交可公开的结论摘要，不要发送模型思维链、完整提示词、私有工具日志或基于隐藏牌的推测。
- 摘要写入对局记录，仅在 H5 全局视角和回放中展示。

错误包括：`players_not_ready`、`game_not_started`、`game_already_started`、`not_your_turn`、`stale_state`、`illegal_play`、`cards_not_in_hand`、`cannot_pass_first`、`invalid_decision`、`seat_session_required`、`invalid_reconnect_code`、`room_owner_required`、`player_still_online`。

## MVP 限制

- 服务只返回原始牌局信息并校验最终动作，不提供牌型分析、候选动作排序、策略推荐或农民协同字段。模型必须根据私有手牌、公开状态、规则和本局策略自行决策。
- 普通玩家座位和房主管理操作已有局部 Token 鉴权，但当前没有账户、登录、封禁或全平台权限体系；Agent HTTP 接口仍依赖调用方身份约定。
- MCP 通过 HTTP 请求承载 JSON-RPC；旧 HTTP Agent 路径保留兼容，动作与观察字段保持兼容。
- 服务端不替代空座，但会为已占座且掉线的普通玩家托管。在线玩家和 Agent 的回合固定为 60 秒；超时属于裁判兜底。托管和超时均在叫地主阶段自动“不叫”、抢地主阶段自动“不抢”、跟牌阶段自动“不要”，必须领出时选择一个最小合法动作。
- Node 本地服务在进程内保存牌局；Cloudflare 部署通过 Durable Object 持久化并串行处理请求。
- 每轮有独立回放和结算，综合总结只在最后一轮完成后提交。
- 本地策略由 Agent 自己读取并按对局锁定，只提供给本地模型。`strategies/ddz/*.md` 是可选的服务端目录策略；两种方式都要求一份文件是一套完整方案。复盘只提出建议，不自动编辑策略。
