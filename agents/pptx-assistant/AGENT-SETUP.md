# PPT 助手 — Agent 建立步骤 (AGENT-SETUP)

本「PPT 助手」是一个 **Agent(运行时实体)**,不是部署技能。Agent 本体(prompt + 绑定工具 +
凭证)存在 LibreChat 的 **MongoDB(`db.agents`)** 里,通过 **Agent Builder UI** 创建——不是仓库文件。
本仓库只版本化它的**资产**:

- `agents/pptx-assistant/SYSTEM_PROMPT.md` — agent 的系统提示(粘进 Agent Builder)。
- `skill/pptx-mcp/` — agent 依赖的 `pptx` 渲染 MCP server(python-pptx 后端)。

## 前置:先把 `pptx` MCP server 跑起来

Agent 能绑定 `pptx` 工具的前提,是 `pptx` MCP server 已在 `librechat.yaml` 注册并生效。
完整服务端步骤(烘焙 python-pptx 进镜像、落地 `/app/skill/pptx-mcp/`、注册 `mcpServers.pptx`、
`docker restart librechat-api`)见 `skill/pptx-mcp/SETUP.md`。

> SSRF allowlist 提醒(field-note #6):`pptx` 是 **stdio 本地进程**,不做网络出站,因此**不需要**
> 加进 `actions.allowedDomains`。Action(走 HTTP 的)才需要;本 agent 用的是 MCP,不涉及。

注册生效后,确认 `pptx` 的工具已被实例发现(只读校验):重启后,工具会以
`renderDeck_mcp_pptx` / `inspectTemplate_mcp_pptx` 的形式出现在 Agent Builder 的工具列表里。

## 在 Agent Builder UI 建 agent(人工操作)

1. 进入 LibreChat → Agents → **Agent Builder**,新建 agent。
2. **Name**:`PPT助手`。
3. **Provider / Model**:沿用本实例约定(参考既有「PRD助手」:provider `.apimaster`,model 选当前
   可用的 Claude,如 `claude-opus-4-7`;具体以实例当前可用 channel 为准)。
4. **Instructions / System Prompt**:把 `agents/pptx-assistant/SYSTEM_PROMPT.md` 分隔线以下的正文
   **整段粘贴**进去。
5. **Tools / MCP**:从工具列表里勾选 `pptx` server 暴露的两个工具:
   - `renderDeck_mcp_pptx`
   - `inspectTemplate_mcp_pptx`
   (若列表里看不到,说明 `pptx` server 没生效——回到 `skill/pptx-mcp/SETUP.md` 检查注册与重启。)
6. **保存** agent。

> 凭证不经过自动化:任何需要 token/密钥的步骤都由人在 UI 完成,不要把凭证贴给 agent 或写进仓库。

## 建好后验证(只读)

确认 agent 真的带上了工具(避免 field-note #11 的"工具空但看似成功"陷阱):

```
sudo -n docker exec librechat-mongodb mongosh LibreChat --quiet --eval "db.agents.find({name:'PPT助手'}, {name:1, model:1, tools:1}).toArray()"
```

期望:返回一条记录,`tools` 数组**非空**且含 `renderDeck_mcp_pptx`、`inspectTemplate_mcp_pptx`。

然后在对话里选中「PPT助手」走一遍:谈主题 → 两位大师 → 大纲 → 视觉大师 → 调 `renderDeck` 返回真实
路径。只有工具真实返回 `path` 才算成功;agent 在工具失效时若"假装成功/编造路径",回到 prompt 与工具
绑定排查,不要接受伪造结果。
