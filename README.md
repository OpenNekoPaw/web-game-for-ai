# Agent Arena 斗地主

一个用于验证通用模型游戏理解和博弈能力的斗地主游戏。游戏服务负责牌局状态、规则校验、计时、结算和记录；Agent 根据手牌、公开信息和策略自行判断叫牌与出牌。

## 启动

需要 Node.js 24+：

```bash
npm start
```

`npm start` 通过 supervisor 启动服务；worker 意外退出后会自动重启。仅需单次无监督运行时可使用 `npm run start:once`。

打开 <http://localhost:3000>。

运行测试：

```bash
npm test
```

## Linux 二进制

从 GitHub Releases 下载与服务器架构对应的发布包：

- `agent-game-ddz-linux-amd64.tar.gz`
- `agent-game-ddz-linux-arm64.tar.gz`

下载对应的 Release 资产后校验并启动：

```bash
sha256sum -c agent-game-ddz-linux-<arch>.sha256
tar -xzf agent-game-ddz-linux-<arch>.tar.gz
PORT=3000 ./ddz-server
```

运行二进制不需要安装 Node.js 或 Bun。`ddz-server` 是自动重启 worker 的 supervisor，同时提供 H5 页面和远程 MCP Server；`ddz-server-worker` 和 `share/` 必须与其保持在同一目录。Agent 的 MCP Client 直接连接游戏服务端，对局记录默认写入同目录的 `records/`。

本地安装 Bun 后，也可以生成当前平台的发布目录：

```bash
npm run build:binary
PORT=3000 ./dist/ddz-server
```

推送 `v*` 标签后，Linux CI 会在 AMD64 和 ARM64 上运行测试、构建二进制、启动验证，并自动创建 GitHub Release，上传压缩包与 SHA256 校验文件。发布新版本：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Actions 中的临时构建产物只用于发布流程内部传递，用户直接从 Release 下载。

## 页面操作

- 等待三家加入后，各席分别点击“开始对局”，三家准备完成后自动发牌。
- 顶部“邀请”可按空座复制玩家或 Agent 邀请，也可复制可重复使用的全局观战链接。
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

Agent 通过游戏服务端的远程 MCP 接入，普通玩家和 Agent 可以混合对局。每个席位需要先加入，再确认开始；每回合有 60 秒处理时间。页面左上角的 `Agent 接入` 可复制 MCP URL 和当前 Skill。收到牌桌生成的 Agent 邀请链接后，Agent MCP Client 使用 `join_invite` 加入指定服务器和座位。

MCP 地址：`http://127.0.0.1:3000/mcp`。服务端只提供牌局状态、规则校验和动作工具；模型、Agent 配置和本地策略由 Agent 自己管理，不上传游戏服务。

Codex 插件位于 `plugins/ai-h5-game/`，本地安装：

```bash
codex plugin marketplace add .
codex plugin add ai-h5-game@ai-h5-game-local
```

完整接口和字段见 [docs/agent-protocol.md](docs/agent-protocol.md)，MCP 配置示例见 [docs/codex-mcp.toml](docs/codex-mcp.toml)。

## 策略

默认策略是 [strategies/ddz/default.md](strategies/ddz/default.md)。Agent 可以在本地读取并替换完整 Markdown 策略；服务端 MCP 不读取、不展示本地策略。需要比较服务端目录方案时，Agent 可在 `join_game` 中显式使用 `strategyMode=server` 和 `strategyId`。

## 当前效果

- 支持随机首叫、叫地主、抢地主和不叫后失去抢地主资格。
- 支持地主、农民上下家角色判断，以及普通玩家和 Agent 混合对局。
- 支持出牌合法性校验、60 秒回合倒计时、超时兜底、倍率结算和多轮比赛。
- 支持全局观战、历史对局列表、逐步回放、同牌复战、决策摘要和对局复盘。
- 支持替换完整策略方案，用于比较不同模型和策略的行为差异。

牌面结构和手牌交互参考 [RLCard Showdown](https://github.com/datamllab/rlcard-showdown)；基础牌面样式保留原项目的 CC BY-SA 3.0 归属说明。
