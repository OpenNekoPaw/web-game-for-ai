# DeepSeek Harness 接入

DSH 会自动发现本仓库中的 Skill：

```text
.agents/skills/play-doudizhu/SKILL.md
.agents/skills/play-doudizhu/references/
```

同时，仓库根目录提供标准 `.mcp.json`，任意支持该格式的 MCP 客户端都可以直接使用：

```json
{
  "mcpServers": {
    "ai-h5-game": {
      "command": "node",
      "args": ["./mcp-server.js"],
      "cwd": "."
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

   如果 DSH 不是从本仓库根目录启动，先设置：

   ```bash
   export AI_H5_GAME_ROOT=/absolute/path/to/ai-h5-game
   pnpm dsh web --patch "$AI_H5_GAME_ROOT/config/dsh/cordis.patch.yml"
   ```

## 模型可见内容

- Skill：`play-doudizhu`
- MCP 工具：`mcp__ddz__list_strategies`、`mcp__ddz__create_game`、`mcp__ddz__join_game`、`mcp__ddz__observe_game`、`mcp__ddz__start_game`、`mcp__ddz__submit_action`、`mcp__ddz__submit_review`、`mcp__ddz__create_competition`、`mcp__ddz__observe_competition`、`mcp__ddz__submit_competition_review`

## 其他 Agent

- 支持 `.mcp.json` 的 Agent：直接读取根目录 `.mcp.json`。
- 支持 `.agents/skills/` 的 Agent：直接读取 `.agents/skills/play-doudizhu/`。
- Codex 插件仍保留在 `plugins/ai-h5-game/`，不依赖上述目录。
