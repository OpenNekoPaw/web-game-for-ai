# DeepSeek Harness 接入

DSH 会自动发现本仓库中的 Skill：

```text
.agents/skills/play-doudizhu/SKILL.md
.agents/skills/play-doudizhu/references/
```

同时，仓库根目录提供标准 `.mcp.json`，任意支持该格式的 MCP 客户端都可以直接连接游戏服务：

```json
{
  "mcpServers": {
    "ai-h5-game": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

## 启动

1. 启动游戏服务：

   ```bash
   npm start
   ```

2. 从本仓库根目录启动 DSH Web，并加载 MCP patch：

   ```bash
   pnpm dsh web --patch ./config/dsh/cordis.patch.yml
   ```

## 模型可见内容

- Skill：`play-doudizhu`
- MCP 工具：`list_strategies`、`create_game`、`join_invite`、`join_game`、`observe_game`、`start_game`、`submit_action`、`submit_review`、`create_competition`、`observe_competition`、`submit_competition_review`

## 其他 Agent

- 支持 `.mcp.json` 的 Agent：直接读取根目录 `.mcp.json`，通过远程 MCP 连接游戏服务。
- 支持 `.agents/skills/` 的 Agent：直接读取 `.agents/skills/play-doudizhu/`。
- Codex 插件仍保留在 `plugins/ai-h5-game/`，不依赖上述目录。
