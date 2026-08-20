# Agent Arena 斗地主

一个用于验证通用模型游戏理解和博弈能力的斗地主游戏。

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

```text
http://localhost:3000/?seat=0
http://localhost:3000/?game=<gameId>&seat=0&control=0
http://localhost:3000/?game=<gameId>&seat=0&view=global
http://localhost:3000/?replay=<gameId>&view=global
```

MCP 地址：`http://127.0.0.1:3000/mcp`。

协议与设计文档：

- [Agent 接入协议](docs/agent-protocol.md)
- [模型、推理强度、策略评估与主持 Agent](docs/evaluation-and-host-agent.md)
