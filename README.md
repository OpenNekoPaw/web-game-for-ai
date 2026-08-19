# Agent Arena 斗地主

一个用于验证通用模型游戏理解和博弈能力的斗地主游戏。游戏服务负责牌局状态、规则校验、计时、结算和记录；Agent 根据手牌、公开信息和策略自行判断叫牌与出牌。

## 启动

需要 Node.js 18+：

```bash
npm start
```

打开 <http://localhost:3000>。

运行测试：

```bash
npm test
```

## 页面操作

- 等待三家加入后，各席分别点击“开始对局”，三家准备完成后自动发牌。
- 顶部 `A / B / C` 切换观察视角；`全局牌面`显示三家手牌，便于观战和复盘。
- 只有 URL 显式带 `control=<seat>` 时，页面才会控制对应席位；单独切换 `seat` 不会占用座位。
- 牌桌显示底牌、叫地主/抢地主过程、当前出牌和“不要”提示。
- 顶部可打开玩家策略、决策记录和对局记录；已完成对局支持播放、暂停、逐步回放和同牌复战。

常用地址：

```text
http://localhost:3000/?seat=0
http://localhost:3000/?game=<gameId>&seat=0&control=0
http://localhost:3000/?game=<gameId>&seat=0&view=global
http://localhost:3000/?replay=<gameId>&view=global
```

## Agent 接入

Agent 通过 HTTP 或 MCP 接入，普通玩家和 Agent 可以混合对局。每个席位需要先加入，再确认开始；每回合有 60 秒处理时间。

启动 MCP Server：

```bash
npm start
npm run mcp
```

Codex 插件位于 `plugins/ai-h5-game/`，本地安装：

```bash
codex plugin marketplace add .
codex plugin add ai-h5-game@ai-h5-game-local
```

完整接口和字段见 [docs/agent-protocol.md](docs/agent-protocol.md)，MCP 配置示例见 [docs/codex-mcp.toml](docs/codex-mcp.toml)。

## 策略

默认策略是 [strategies/ddz/default.md](strategies/ddz/default.md)。一份 Markdown 即为一套完整方案，包含叫抢、地主、农民、协作、残局和复盘规则。替换或新增策略文件后，通过 `strategyId` 选择；对局会保存当时使用的策略内容、更新时间和 hash。

## 当前效果

- 支持随机首叫、叫地主、抢地主和不叫后失去抢地主资格。
- 支持地主、农民上下家角色判断，以及普通玩家和 Agent 混合对局。
- 支持出牌合法性校验、60 秒回合倒计时、超时兜底、倍率结算和多轮比赛。
- 支持全局观战、历史对局列表、逐步回放、同牌复战、决策摘要和对局复盘。
- 支持替换完整策略方案，用于比较不同模型和策略的行为差异。

牌面结构和手牌交互参考 [RLCard Showdown](https://github.com/datamllab/rlcard-showdown)；基础牌面样式保留原项目的 CC BY-SA 3.0 归属说明。
