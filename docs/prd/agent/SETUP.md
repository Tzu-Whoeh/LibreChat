# PRD Agent — 落地装配手册（第一阶段：Agent + 工具 + 契约）

> 本阶段交付的是**可版本化的资产 + 装配步骤**。PRD Agent 在 LibreChat v0.8.6 中是运行时实体（存于 MongoDB，经 Agent Builder 创建），不是代码文件，因此需按以下步骤在运行实例上装配。
> 右侧仪表盘（前端改动）是**下一阶段**，本阶段不含；但本阶段定下的 `dashboard-contract.md` 是前端实现的接口依据。

## 本阶段交付物（均在 `docs/prd/agent/`）

| 文件 | 作用 | 验证状态 |
|---|---|---|
| `dashboard-contract.md` | 仪表盘数据契约（前后端接口） | 已用 schema 跑通正/负例 |
| `dashboard-state.schema.json` | 契约的 JSON Schema（机器可校验） | Draft-07 合法 |
| `prd-agent-system-prompt.md` | PRD Agent 的 system prompt 全文 | 内嵌示例过 schema |
| `prd-github-action.openapi.yaml` | GitHub 读写 Action 的 OpenAPI spec | OpenAPI 3.1 合法 |
| `SETUP.md`（本文件） | 装配步骤 | — |

## 装配步骤（在运行的 LibreChat 实例上操作）

### 步骤 1：放行 GitHub 域名（改 `librechat.yaml`）

Action 调用 `api.github.com`，需加入 actions 白名单，否则被 SSRF 防护拦截。在部署目录的 `librechat.yaml` 中：

```yaml
actions:
  allowedDomains:
    - 'api.github.com'   # 新增：PRD Agent 的 GitHub 读写 Action
    # ...保留原有项
```

改完需重启 librechat-api 容器使配置生效（属运维黄区操作，须经审批）。

### 步骤 2：准备 GitHub 凭据

为 Action 准备一个 GitHub PAT，**权限范围最小化**：仅对目标仓库 `Tzu-Whoeh/LibreChat` 的 `contents:write`。该 PAT 通过 Agent Builder 的 Action 认证配置（Bearer Token）填入，不要硬编码进任何文件、不要提交仓库。

### 步骤 3：创建 Agent（Agent Builder UI）

1. 新建 Agent，名称如 “需求采集助手 / PRD Collector”。
2. 选择一个支持工具调用的底层模型。
3. 将 `prd-agent-system-prompt.md` 全文填入 Instructions。
4. 添加 Action：导入 `prd-github-action.openapi.yaml`，配置 Bearer Token 认证（步骤 2 的 PAT）。
5. 保存。记下该 Agent 的 id（前端阶段判定“是否 PRD Agent”时会用到）。

### 步骤 4：冒烟验证（人工对话一轮）

- 向 Agent 描述一个简单需求，确认：
  - 回复末尾出现 `<!--PRD_STATE ... PRD_STATE-->` 块且 JSON 合法（可手动复制出来用 schema 校验）。
  - Agent 调用 putPrdFile 在 `docs/prd/<slug>.md` 写出草稿，frontmatter 含完整度状态。
  - 关闭重开、指定同一 slug，Agent 能读回并复述进度（getPrdFile 生效）。

## 与下一阶段（前端仪表盘）的衔接

- 前端依据 `dashboard-contract.md`：用非贪婪正则提取每条 assistant 消息末尾的 PRD_STATE 块、解析 JSON、渲染三块面板、并从展示正文中移除该块。
- “仅 PRD Agent 会话显示仪表盘”的判定，用步骤 3 记下的 Agent id。
- 复用 LibreChat 现有右侧栏机制（`Presentation.tsx` 经 `SidePanelGroup` 注入右侧元素），把仪表盘作为该右侧栏的一个条件渲染候选。

## 安全边界回顾

- Action 的 OpenAPI 在 path 描述中约束只写 `docs/prd/`；system prompt 亦明确只在该路径读写。PAT 权限限定到 contents:write，进一步收口。
- PAT 绝不入库；本阶段交付物均不含任何凭据。
