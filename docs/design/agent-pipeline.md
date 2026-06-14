# Agent Pipeline — 设计文档

> **必读约定：开发任何新 agent 前，必须先完整阅读本文档。**
> 本文档描述整条 agent 流水线的架构、已有基础设施、开发约定和关键经验。
> 不读直接动手会踩已知的坑、重复已经解决的问题、或破坏现有的接口契约。

---

## 一、流水线概览

本项目构建一套 AI 辅助产品工程流水线，每个 agent 消费上一个的输出：

```
需求采集 (PRD Agent)
    ↓  docs/prd/<slug>/
架构设计 (Architecture Agent)        [待开发]
    ↓  docs/arch/<slug>/
原型生成 (Prototype Agent)            [待开发]
    ↓  docs/proto/<slug>/
代码实现 (Code Agent)                 [待开发]
```

每个 agent 的输出是一组 Git 文件，存在 `Tzu-Whoeh/LibreChat` 仓库的约定目录下。
上游 agent 的输出文件就是下游 agent 的输入文件——**不要绕过这个文件接口**。

---

## 二、已有基础设施（开发新 agent 直接复用）

### 2.1 通用 git MCP Server

**位置**：`docs/agent-infra/mcp/git-server.mjs`
**部署**：laifu 的 `/srv/librechat/skill/git-mcp/`（stdio，挂载进容器 `/app/skill/git-mcp/`）

这是整条流水线共用的 GitHub 读写工具，**所有 agent 复用同一个 server**，通过环境变量控制每个 agent 的权限范围。

**暴露的工具（通用名，不绑定任何 agent）：**

| 工具 | 说明 |
|---|---|
| `readFile(path, ref?)` | 读文件，返回 content（明文）+ sha |
| `writeFile(path, content, message, sha?, branch?)` | 写单文件（content 传明文，无需 base64） |
| `writeFiles(files[], message, branch?)` | **批量写**，一次 commit 多文件（首选，避免超时） |
| `listFiles(path, ref?)` | 列目录，不存在的路径返回空列表 |
| `createBranch(branch, fromRef?)` | 建分支（需 `GIT_ALLOW_PR=true`） |
| `createPullRequest(title, head, base?, body?)` | 提 PR（需 `GIT_ALLOW_PR=true`） |

**通过 ops 控制平面操作 GitHub**（`ops.xbot.cool/api/v1`），content 传明文，base64 由控制平面处理。不直连 GitHub、不依赖容器内 git。

### 2.2 为新 agent 配置 git MCP Server

在 `librechat.yaml` 的 `mcpServers` 下加一个 server 实例，指向同一个 `server.mjs`，用环境变量配权限：

```yaml
mcpServers:
  git:                                      # 给 PRD agent 的实例
    type: stdio
    command: node
    args: [/app/skill/git-mcp/server.mjs]
    env:
      OPS_API_KEY: "${OPS_API_KEY}"
      GIT_REPO: "Tzu-Whoeh/LibreChat"
      GIT_ALLOWED_PATHS: "docs/prd/"        # 只能操作 docs/prd/ 下的文件
      GIT_ALLOW_PR: "false"                 # 不允许建分支/提 PR
      GIT_DEFAULT_BRANCH: "main"
    timeout: 60000

  git-arch:                                 # 给 Architecture agent 的实例（示例）
    type: stdio
    command: node
    args: [/app/skill/git-mcp/server.mjs]
    env:
      OPS_API_KEY: "${OPS_API_KEY}"
      GIT_REPO: "Tzu-Whoeh/LibreChat"
      GIT_ALLOWED_PATHS: "docs/prd/,docs/arch/"   # 可读 PRD，可写 arch
      GIT_ALLOW_PR: "false"
      GIT_DEFAULT_BRANCH: "main"
    timeout: 60000
```

**权限原则（最小权限）：**
- `GIT_ALLOWED_PATHS`：只开放该 agent 需要读写的目录前缀，逗号分隔
- 下游 agent 可以**读**上游目录（如 arch agent 读 `docs/prd/`），但只**写**自己的目录
- `GIT_ALLOW_PR=true` 只给需要提 PR 的 agent（如代码 agent）；PRD/arch/proto 一般不需要

### 2.3 CI 镜像构建流水线

**位置**：`.github/workflows/build-prd-image.yml`
**作用**：从 fork 源码构建 LibreChat API 镜像，推送到 GHCR，laifu 拉取部署。

触发：`workflow_dispatch`（手动，可传 `vite_prd_agent_id` 和 `tag`）。

开发新 agent 若需要修改前端（新仪表盘等），按此流程：
1. 源码改动 → PR → merge
2. 触发 build workflow（传对应 agent id）
3. laifu 拉新镜像 → `docker restart librechat-api`

---

## 三、目录约定

```
docs/
  design/
    agent-pipeline.md          ← 本文档
  agent-infra/
    mcp/
      git-server.mjs           ← 通用 git MCP server（所有 agent 共用）
      package.json
  prd/
    agent/
      prd-agent-system-prompt.md
      dashboard-state.schema.json
      dashboard-contract.md
      templates/               ← PRD 各文件模板
      mcp/                     ← 旧（已迁移到 agent-infra/mcp/）
    <slug>/                    ← 每个项目的 PRD 输出
      <slug>.md                ← 主文件（概述 + 索引）
      user-stories/
        us-001-<name>.md
      features/
        feat-001-<name>.md     ← 含验收标准、UI 占位、数据/权限占位
      ux-notes.md              ← 原型 agent 的输入
      constraints.md           ← 架构 agent 的输入（业务约束，用户语言）
  arch/                        ← Architecture Agent 的输出目录（待创建）
    <slug>/
  proto/                       ← Prototype Agent 的输出目录（待创建）
    <slug>/
skills/
  librechat-feature-dev/
    SKILL.md                   ← LibreChat feature 开发经验（开发前必读）
```

---

## 四、开发新 Agent 的标准步骤

```
1. 读本文档（你正在做）
2. 读 skills/librechat-feature-dev/SKILL.md（LibreChat 开发踩坑集）
3. 确认输入文件格式（读上游 agent 的 schema/contract/模板）
4. 设计 system prompt + 输出文件模板，放在 docs/<agent-type>/agent/
5. 在 librechat.yaml 加一个 git MCP server 实例（配好 scope）
6. 在 Agent Builder UI 里新建 agent，关联 MCP 工具（不要用 action）
7. 本地验证 MCP 工具调用链（见 §五）
8. 如需前端改动，走 PR → build → deploy 流程
9. 更新本文档（新 agent 的目录约定、输入输出接口）
```

---

## 五、关键约定与禁忌

### ✅ 必须这样做

- **多文件写入用 `writeFiles`**（批量，一次 commit），不要循环调 `writeFile`——LibreChat 单回合有时间上限，串行写多文件会超时被 terminated。
- **工具真实成功才能告诉用户**——只有 `writeFile`/`writeFiles` 返回含 commit/sha 的成功结果，才能告知用户写入成功、给出链接。禁止在工具报错时假装成功或编造链接。
- **yaml 改动后用 `docker restart`**——librechat.yaml 是挂载文件，`compose up` 检测不到内容变化，必须 `docker restart librechat-api` 才生效。
- **MCP 工具不在 Agent Builder 里用 action**——action UI 在子路径反代部署下有认证 bug，保存失败。新 agent 一律用 MCP 工具（添加工具，不是添加操作）。
- **新 agent 的 MCP 工具换了之后验证 mongo**——`db.agents.findOne({id:...},{tools:1})` 确认 tools 字段含 `_mcp_<server-name>` 结尾的新工具，不含旧工具名。

### ❌ 禁止这样做

- **不要直连 GitHub API**——content 字段必须 base64，LLM 不能可靠编码。走控制平面。
- **不要在共享机维护本地 git clone**——容器内没有 git，共享机上维护大仓库 clone 有空间/冲突风险。走控制平面。
- **不要用 action 而不是 MCP**——见上。
- **不要给新 agent 开超出需要的路径权限**——`GIT_ALLOWED_PATHS` 只开放该 agent 的目录。
- **不要写死 titleModel/summaryModel**——用 `current_model`，天然跟着对话模型走，不会因某个固定模型挂掉而全部失败。

---

## 六、各 Agent 输入输出接口

### PRD Agent（已上线）

- **输入**：用户对话
- **输出**：`docs/prd/<slug>/`
  - `<slug>.md`：主文件（背景、目标、用户、流程、非目标、索引）
  - `user-stories/us-NNN-<name>.md`：每条 user story
  - `features/feat-NNN-<name>.md`：每个 feature（含验收标准、UI 说明、数据/权限占位）
  - `ux-notes.md`：整体 UI 风格、关键页面、交互原则
  - `constraints.md`：业务约束（用户语言：安全、性能、集成、访问范围、业务规则）
- **MCP scope**：`GIT_ALLOWED_PATHS=docs/prd/`，`GIT_ALLOW_PR=false`
- **Dashboard state schema**：`docs/prd/agent/dashboard-state.schema.json`

### Architecture Agent（待开发）

- **输入**：`docs/prd/<slug>/constraints.md` + `docs/prd/<slug>/<slug>.md` + features/
- **输出**：`docs/arch/<slug>/`（技术栈决策、系统设计、数据模型、API 设计、部署方案）
- **MCP scope**：`GIT_ALLOWED_PATHS=docs/prd/,docs/arch/`（读 prd，写 arch），`GIT_ALLOW_PR=false`

### Prototype Agent（待开发）

- **输入**：`docs/prd/<slug>/ux-notes.md` + features/（UI 说明段落）
- **输出**：高保真原型（HTML/React，放 `docs/proto/<slug>/`）
- **MCP scope**：`GIT_ALLOWED_PATHS=docs/prd/,docs/proto/`，`GIT_ALLOW_PR=false`

### Code Agent（待开发）

- **输入**：`docs/arch/<slug>/` + `docs/prd/<slug>/features/`
- **输出**：源码（`api/`/`client/` 等），走分支 + PR
- **MCP scope**：路径放开，`GIT_ALLOW_PR=true`（提 PR → 触发 CI）

---

## 七、基础设施现状（laifu，2026-06-14）

- **LibreChat**：v0.8.6，镜像 `ghcr.io/tzu-whoeh/librechat-api:latest`（从 fork 构建）
- **MCP git server**：`/srv/librechat/skill/git-mcp/`，92 个 npm 包（@modelcontextprotocol/sdk）
- **PRD agent id**：`agent_I0vfFIKsSrxxsyHWhB-2J`（`VITE_PRD_AGENT_ID` 已编入镜像）
- **ops 控制平面**：`https://ops.xbot.cool/api/v1`（`OPS_API_KEY` 在 `.env` 里）
- **已知问题**：PRD助手还有两个残留的旧 action 工具（getPrdFile/putPrdFile），建议在 Agent Builder 里删掉

---

## 八、凭据说明（项目期专用，收尾轮换）

| 凭据 | 用途 | 位置 |
|---|---|---|
| `OPS_API_KEY` | 控制平面认证（ops.xbot.cool） | `/srv/librechat/.env` |
| GitHub PAT | 历史上给 agent action 用，现已不需要 | 已废弃，可撤销 |
| `JWT_REFRESH_SECRET` | LibreChat session 签名 | `/srv/librechat/.env`（曾误泄露，建议轮换） |

---

*本文档由 Claude agent 在项目过程中整理，随流水线发展持续更新。*
*最后更新：2026-06-14*
