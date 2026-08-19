# Agent Arena · 游戏智能评测 MVP

这是一个以斗地主为首个场景的通用模型博弈评测平台。项目目标不是训练或内置一个专用斗地主 AI，而是在一致、可回放、信息隔离的游戏环境中，观察不同通用模型和策略能否自行产生可靠的游戏理解、规则遵守、长期规划、竞争与合作能力。

游戏服务只负责牌局状态、信息权限、动作校验、固定回合时限、结算和记录。牌型感知、局势理解、对手推断、队友协作和出牌决策全部由模型完成，平台不向模型提供候选动作分析或策略推荐。

## 评测目标

当前重点探索以下问题：

- **游戏理解**：模型能否从原始手牌、公开出牌和角色状态中正确理解牌型、牌权与胜负目标。
- **规则遵守**：模型能否持续提交合法动作，并在状态变化或动作被拒绝后正确恢复。
- **长期博弈**：模型能否保留牌力、减少无谓拆牌、规划多回合收尾，而不是只选择眼前可出的牌。
- **竞争决策**：模型能否根据对手剩余牌数、公开行为和倍率风险调整进攻与防守。
- **合作能力**：农民模型能否识别队友和相对地主的位置，形成让牌、顶牌、接管与残局封锁，而不是相互压制。
- **策略遵循**：同一模型在替换完整策略方案后，行为是否发生可解释、可复现的变化。
- **受限推理**：固定 60 秒内，模型能否控制分析复杂度并完成有效决策，而不是卡死或依赖快速决策脚本。
- **复盘改进**：模型能否基于真实对局记录发现错误、提出策略调整，并在后续多轮比赛中验证改进。

项目希望借此探索：通用模型在只有规则、状态、工具和高层策略约束的情况下，是否能够涌现出专用脚本没有直接编码的高级博弈能力。

## 实验边界

- 游戏服务是裁判，不是决策引擎；不会分析手牌、排序动作或替 Agent 协调合作。
- Skill 只描述游戏信息、协议字段、工具调用和超时规则，不承载具体出牌策略。
- `strategies/ddz/default.md` 是一套完整、可整体替换的策略方案；每局只绑定一个策略快照。
- Agent 只能看到本席私有手牌和公开信息；全局视角只供观战、回放和人工分析，不能用于 Agent 决策。
- 决策记录只保存公开结论、意图、置信度和服务端统计的耗时，不保存模型思维链或私有工具日志。
- 当前结果属于 MVP 探索性评测。随机发牌和有限局数不能单独证明模型强弱，应优先使用多轮比赛和重复实验比较趋势。

## 可观察指标

每局或多轮比赛可以结合以下信号分析模型表现：

- 胜负、地主身份、单局分差、累计比分和倍率原因。
- 接受动作、拒绝动作、超时次数、平均决策耗时和各席出牌次数。
- 非法牌型、过期状态、错误角色判断、无谓拆牌、牌力浪费和错失直接获胜机会。
- 农民让牌、顶牌、接管、重复拦截以及地主少牌阶段的协作质量。
- 对局绑定的模型名称、策略 `id`、`updatedAt`、内容 `hash`、决策摘要和终局复盘。

这些指标用于比较模型和策略，不应只用单局胜负下结论。

## 运行

需要 Node.js 18+：

```bash
npm start
```

打开 `http://localhost:3000`。

运行测试：

```bash
npm test
```

可通过页面右上角的 `A / B / C` 按钮切换玩家视角，也可以直接使用查询参数：

```text
http://localhost:3000/?seat=0
http://localhost:3000/?seat=1
http://localhost:3000/?seat=2
http://localhost:3000/?seat=0&view=global
http://localhost:3000/?game=<gameId>&seat=0&control=0
```

页面会把当前牌局写入 `game` 参数，刷新或复制完整 URL 可继续查看同一局；本地服务重启后会自动创建新局。
使用 `view=global` 可进入全局牌面模式并直接显示三家手牌；普通视角不会返回其他玩家的手牌。
页面默认只观察，不会自动添加 `control` 或占用座位。只有 URL 显式携带 `control=<seat>` 时，H5 才会尝试占用该座位；`seat` 始终只表示观察视角。

每局会自动保存到 `records/<gameId>.json`，用于实验复盘但默认不提交 Git。通过以下 URL 可打开只读回放，支持上一步、播放/暂停、下一步、进度跳转和视角切换：

```text
http://localhost:3000/?replay=<gameId>&view=global
```

记录功能启用前已经存在的内存牌局无法补生成历史回放。

已完成回放顶部提供“同牌复战”。它会创建一个独立 `gameId`，复制来源局首次发牌的三家手牌、底牌和首叫席位，但不复制原玩家、Agent、策略、决策、比分或比赛关系。新局仍需三席重新接入、选择策略并分别确认开始；`sourceGameId` 用于把多次同牌实验关联到同一基线。也可以调用 `POST /api/replays/:sourceGameId/rematch` 创建复战局。

Agent 提交动作时可附带简短的结构化决策摘要。服务端会把摘要连同 `gameId` 和当时绑定的策略 `id/updatedAt/hash` 保存到对局记录。全局牌面和回放通过独立的“玩家策略”侧栏切换查看 A/B/C 本局锁定的完整策略内容；“决策记录”只展示决策摘要。历史对局列表也使用该局的策略快照，不读取当前文件内容。普通玩家视角不会接收其他 Agent 的摘要。只保存公开结论，不保存模型思维链、完整提示词或私有工具日志。

出牌策略独立存放在 `strategies/ddz/*.md`，不写死在 Skill 或服务端中。Skill 只介绍游戏状态、请求接口、规则引用和操作流程；Agent 加入时选择 `strategyId`，由模型按该策略自行理解手牌、角色、公开历史和局势并决策。服务端只校验最终动作是否合法，不分析牌型、不推荐动作、不处理农民协同。策略 Markdown 内容会作为快照保存到对局记录。终局后 Agent 根据 `reviewContext` 提交复盘，在全局视角和回放的“复盘总结”中展示问题、改进动作和策略修改建议；建议不会自动覆盖策略文件。

当前默认方案是 `strategies/ddz/default.md`。一份 Markdown 表示一套可整体替换的完整方案，内部同时包含叫抢、地主、地主上家、地主下家、协作、残局和复盘约束。未来需要 A/B 测试时可以新增另一份同样完整且自包含的 Markdown，并通过 `strategyId` 选择；运行时不继承、拼接或混用多份策略。

创建牌局后先等待三个座位加入，每个座位可以由 H5 普通玩家或 Agent 控制；每个角色需各自确认“开始对局”，第三家确认后自动发牌并启动回合倒计时，不再需要额外的全局开始按钮。每局随机选择首位玩家叫地主。三家都不叫会重新洗牌发牌；有人叫地主后，其他两家依次选择“抢地主 / 不抢”。若后家抢地主，首叫者获得一次最终“抢地主 / 不抢”机会，再确定地主。

每回合固定 60 秒。倒计时只限制模型过度复杂或卡死的思考流程，不提供快速决策模式，也不改变当前策略；超时后服务端仅执行协议规定的兜底动作以继续牌局。

## MVP 协议

- `POST /api/games`：创建牌局，返回 `gameId`
- `GET /api/games/:gameId/state?seat=0`：获取指定座位的脱敏状态
- `GET /api/games/:gameId/state?seat=0&view=global`：获取全局牌面状态，仅用于本地观战界面
- `GET /api/games/:gameId/strategies?view=global`：按对局读取 A/B/C 加入时锁定的完整策略快照
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
- `POST /agent/v1/games/:gameId/join`：使用稳定 `agentId` 占用一个座位，可传最多 40 字符的公开 `displayName` 用于牌桌展示
- `POST /agent/v1/games/:gameId/start`：携带 `seatId` 确认本 Agent 准备，第三席确认后自动发牌
- `GET /agent/v1/games/:gameId/observe?seatId=0`：获取该座位的私有观察
- `POST /agent/v1/games/:gameId/actions`：携带最新 `seq` 提交动作

完整字段和错误码见 [docs/agent-protocol.md](docs/agent-protocol.md)。`seatControllers` 统一描述普通玩家和 Agent，二者不能占用同一座位。H5 等待界面中央可选择 `1/3/5/7 局`；多轮比赛会在 URL 同时保留 `competition` 与当前 `game`。

## MCP Server

先启动游戏服务，再启动或配置 MCP Server：

```bash
npm start
npm run mcp
```

stdio MCP Server 提供十一个工具：

- `list_strategies`
- `create_game`
- `create_rematch`
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

## 通用 Agent 接入

除了 Codex 插件，仓库也提供标准文件方便其他 Agent 接入：

- 根目录 `.mcp.json`：支持该格式的 MCP 客户端可以直接连接 `mcp-server.js`。
- `.agents/skills/play-doudizhu/`：支持该 Skill 目录约定的 Agent 可直接发现 `play-doudizhu`。
- `config/dsh/cordis.patch.yml`：DeepSeek Harness（DSH）的 MCP 接入 patch。

### DeepSeek Harness（DSH）

先启动游戏服务，再从仓库根目录启动 DSH：

```bash
npm start
pnpm dsh web --patch ./config/dsh/cordis.patch.yml
```

DSH 会自动发现 `.agents/skills/play-doudizhu/`，并通过 `@deepseek-ai/dsh-mcp-client` 暴露 `mcp__ddz__*` 工具。详细说明见 [config/dsh/README.md](config/dsh/README.md)。

### 其他 MCP / Skill 客户端

- 支持 `.mcp.json` 的 Agent：直接读取根目录 `.mcp.json`。
- 支持 `.agents/skills/` 的 Agent：直接读取 `.agents/skills/play-doudizhu/`。
- 如果 Agent 需要原始工具名而不是 `mcp__ddz__*` 前缀，可参照 `docs/codex-mcp.toml` 自行配置 MCP Server 路径。

## 架构

`game/ddz.js` 是独立斗地主规则适配器；`server.js` 是本地裁判服务；`public/` 是 H5 观战与人工操作界面；`strategies/` 保存可替换实验策略；Codex 插件负责让模型通过统一协议接入。后续增加围棋或国际象棋时，复用对局、Agent、计时、记录、比赛和复盘外壳，并新增对应规则适配器与策略方案。

比赛采用轻量多轮模式：每局独立结算并生成新的 `gameId`，比赛用 `competitionId` 累计 3/5/7 局总分。地主胜固定 `+2/-1/-1`，农民胜固定 `-2/+1/+1`，每局结束提交短复盘用于下一局；最后一局结束后再提交综合总结，只保留多局重复且有数据支持的策略建议。比赛状态和回放目前保存在服务进程内存中。

Agent 只绑定一个完整策略 Markdown；出牌观察中的 `roleContext` 会动态标识地主/农民、队友以及相对地主的位置。农民通过 `farmerPosition=landlord_upstream|landlord_downstream` 选择“地主上家/地主下家”策略，不按固定座位或含糊的当前视角上下家判断。服务不解释这些状态应该对应什么动作，实际博弈能力仍由模型与策略产生。

## 界面来源

牌面 DOM 结构、手牌叠放和选牌交互参考了 [RLCard Showdown](https://github.com/datamllab/rlcard-showdown) 的 `DoudizhuGameBoard`。`public/cards.css` 的基础牌面样式源自该项目引用的 CSS Playing Cards，并保留其 CC BY-SA 3.0 归属说明；本项目没有引入 RLCard、React、Django 或模型服务。
