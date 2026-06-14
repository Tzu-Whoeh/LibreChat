# 仪表盘数据契约（Dashboard Data Contract）

> PRD Agent ↔ 前端仪表盘之间的接口约定。
> 方案 a：Agent 每轮回复内嵌一段结构化数据块，前端解析后驱动右侧仪表盘。
> 这是前后端必须共同遵守的契约，任何一方变更都需同步更新本文件与对应 schema。

## 1. 传输方式

PRD Agent 在**每轮**回复的正文中，于回复**末尾**追加一个结构化数据块，使用如下显式包裹标记：

```
<!--PRD_STATE
{ ...JSON... }
PRD_STATE-->
```

设计要点：

- 用 HTML 注释形式 `<!-- ... -->` 包裹，确保即使前端未拦截，Markdown 渲染时该块也**不可见**（注释不渲染），不会污染用户阅读。
- 自定义哨兵 `PRD_STATE` 紧跟在注释起始符后，便于前端用稳定正则定位，且极不易与正文内容冲突。
- 前端职责：从消息正文中提取该块 → 解析 JSON → 驱动仪表盘 → **将该块从展示给用户的正文中移除**（仅用于驱动面板，不展示原始 JSON）。
- 一条消息中**最多一个** `PRD_STATE` 块；以最后一个为准（防御性）。
- 前端正则须用**非贪婪**匹配（`.*?` + `DOTALL`），并在多次命中时取最后一个可解析为 JSON 的块——避免贪婪匹配吞掉跨块内容。

## 2. 解析时机（流式）

回复经 SSE 流式到达。前端必须等 `PRD_STATE-->` 闭合标记完整到达后再解析；在闭合前，块内容可能不完整，不可解析。建议：

- 在消息 `isSubmitting` 结束（或检测到闭合哨兵）后再解析渲染。
- 解析失败（JSON 不完整 / 格式错）时，保留上一轮的仪表盘状态，不清空、不报错给用户。

## 3. 数据结构

JSON 顶层字段：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `version` | string | 是 | 契约版本，当前 `"1.0"` |
| `slug` | string | 是 | 本 PRD 的稳定标识，对应仓库文件 `docs/prd/<slug>.md` |
| `title` | string | 是 | PRD 标题（人类可读） |
| `overallPercent` | integer | 是 | 整体完整度百分比 0–100（由 dimensions 计算，见 §4） |
| `dimensions` | array | 是 | 各维度状态，见下 |
| `highlights` | object | 是 | 已整理出的 PRD 要点摘要，见下 |
| `synced` | object | 否 | GitHub 同步状态，见下 |

### 3.1 `dimensions[]`

固定 7 项，顺序固定（与检查表一致）。每项：

| 字段 | 类型 | 含义 |
|---|---|---|
| `key` | string | 维度键，枚举见下 |
| `label` | string | 中文显示名 |
| `status` | string | 枚举：`missing`（缺失）/ `partial`（部分）/ `complete`（完整） |

`key` 枚举（顺序即展示顺序）：

```
background   背景与目标
users        目标用户
scenarios    核心场景
features     功能需求
flow         流程
acceptance   验收标准
nongoals     非目标
```

### 3.2 `highlights`

已采集到的要点摘要，按维度键归类。值为字符串（可为空字符串表示尚未采集）：

```json
{
  "background": "誊写 PRD 耗时、易漏维度",
  "users": "产品经理",
  "scenarios": "",
  "features": "",
  "flow": "",
  "acceptance": "",
  "nongoals": ""
}
```

### 3.3 `synced`

```json
{ "path": "docs/prd/prd-tool.md", "committed": true, "ref": "main" }
```

## 4. 完整度计算约定

- `overallPercent = round(complete 维度数 / 7 * 100)`。
- `partial` 不计入 complete。
- 仅当 7 个维度全部 `complete`（即 `overallPercent == 100`）时，Agent 方可提示定稿。

## 5. 完整示例

```
<!--PRD_STATE
{
  "version": "1.0",
  "slug": "prd-tool",
  "title": "PRD 采集工具",
  "overallPercent": 29,
  "dimensions": [
    { "key": "background",  "label": "背景与目标", "status": "complete" },
    { "key": "users",       "label": "目标用户",   "status": "complete" },
    { "key": "scenarios",   "label": "核心场景",   "status": "partial"  },
    { "key": "features",    "label": "功能需求",   "status": "missing"  },
    { "key": "flow",        "label": "流程",       "status": "missing"  },
    { "key": "acceptance",  "label": "验收标准",   "status": "missing"  },
    { "key": "nongoals",    "label": "非目标",     "status": "missing"  }
  ],
  "highlights": {
    "background": "誊写 PRD 耗时、易漏维度",
    "users": "产品经理",
    "scenarios": "采集中",
    "features": "", "flow": "", "acceptance": "", "nongoals": ""
  },
  "synced": { "path": "docs/prd/prd-tool.md", "committed": true, "ref": "main" }
}
PRD_STATE-->
```

机器可校验的 JSON Schema 见同目录 `dashboard-state.schema.json`。
