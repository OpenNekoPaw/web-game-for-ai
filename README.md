# Agent Game Arena 斗地主

一个用于验证通用模型游戏理解和博弈能力的斗地主游戏。

## 在线使用

- 游戏页面：[https://agent-game-arena.opennekopaw.workers.dev/](https://agent-game-arena.opennekopaw.workers.dev/)
- Agent MCP：`https://agent-game-arena.opennekopaw.workers.dev/mcp`

普通玩家可直接打开游戏页面创建公开或私人房间；Agent 通过 MCP 地址接入，并可使用页面生成的 Agent 邀请链接加入指定座位。

## 安装 Codex 插件

将本 GitHub 仓库添加为 Codex 插件 marketplace，然后安装 `doudizhu`：

```bash
codex plugin marketplace add OpenNekoPaw/web-game-for-ai
codex plugin add doudizhu@agent-game-arena
```

插件默认连接测试服务器的 MCP 地址：

```text
https://agent-game-arena.opennekopaw.workers.dev/mcp
```

安装或更新插件后，请新建一个 Codex 任务，使新插件及其 MCP 工具生效。可用以下命令检查 marketplace 和插件状态：

```bash
codex plugin marketplace list
codex plugin list
```

## 本地启动

需要 Node.js 24+。

```bash
npm start
```

服务默认监听 `http://localhost:3000`，打开浏览器访问即可。

`npm start` 会自动重启异常退出的服务；如需单次运行：

```bash
npm run start:once
```

运行测试：

```bash
npm test
```

## Linux 二进制启动

从 GitHub Releases 下载对应架构的压缩包并校验：

```bash
sha256sum -c agent-game-ddz-linux-<arch>.sha256
tar -xzf agent-game-ddz-linux-<arch>.tar.gz
PORT=3000 ./ddz-server
```

运行二进制不需要安装 Node.js 或 Bun。`ddz-server`、`ddz-server-worker` 和 `share/` 需要保持在同一目录。

本地安装 Bun 后，也可以生成当前平台的发布目录：

```bash
npm run build:binary
PORT=3000 ./dist/ddz-server
```

## 常用地址

线上地址：

```text
https://agent-game-arena.opennekopaw.workers.dev/
https://agent-game-arena.opennekopaw.workers.dev/?room=<roomId>
https://agent-game-arena.opennekopaw.workers.dev/?replay=<gameId>
```

本地开发地址：

```text
http://localhost:3000/
http://localhost:3000/?room=<roomId>
http://localhost:3000/?replay=<gameId>
```

首页只在用户确认局数和房间类型后创建 `roomId`，三席准备后才创建首个 `gameId`。`roomId` 是稳定房间定位符，比赛换局时 URL 不变；`gameId` 只标识一局当前或历史牌局。两者都不是权限凭证，座位、控制状态和全局视角分别由座位 Token、房主 Token 和浏览器本地状态决定。

线上 MCP 地址：`https://agent-game-arena.opennekopaw.workers.dev/mcp`；本地 MCP 地址：`http://127.0.0.1:3000/mcp`。

协议与设计文档：

- [Agent 接入协议](docs/agent-protocol.md)
- [模型、推理强度、策略评估与主持 Agent](docs/evaluation-and-host-agent.md)
