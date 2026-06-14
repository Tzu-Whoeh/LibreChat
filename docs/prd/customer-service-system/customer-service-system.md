---
title: 内部 AI 客服支持系统
slug: customer-service-system
status: final
created: 2025-01-27
updated: 2025-01-27
---

# 内部 AI 客服支持系统 PRD

## 1. 背景与目标

### 痛点
- 客服在面对用户咨询时，缺乏快速获取信息的支持
- 用户反馈的问题没有被系统化沉淀，难以驱动产品/服务改进

### 目标
1. **AI 辅助答案推荐**：实时给客服推荐答案（人工把关后再发给用户）
2. **问题沉淀与改进闭环**：每周自动汇总热点问题，由客服主管线下分发给相关团队
3. **量化指标**：
   - 客户满意度（CSAT）提升 ≥ 5%
   - 客服响应时长缩短 ≥ 10%
   - AI 答案采纳率（直接发送 + 改后发送）≥ 60%

---

## 2. 目标用户

| 角色 | 人数 | 系统使用方式 |
|---|---|---|
| 一线客服 | ~20 人 | 主要使用者，接收 AI 推荐答案、处理对话与工单 |
| 客服主管 | 少量 | 查看周报、维护知识库、维护敏感规则、分发改进建议 |
| 相关团队（产品/运营/技术） | - | **不登录系统**，通过主管线下传递改进建议 |

**接入渠道：**
- 网页在线聊天（AI 实时辅助）
- 微信（AI 实时辅助）
- 电话（仅通话后录音上传 + AI 摘要工单）

---

## 3. 核心场景

### 场景 A：网页/微信日常应答
用户消息进来 → AI 基于「预设知识库 + 历史对话 + SharePoint 文档库」三源生成推荐答案（附出处）→ 客服直接发送 / 修改后发送 / 忽略 → 自动归档。

### 场景 B：电话工单录入
通话录音上传 → AI 自动转文字 + 生成摘要 → 客服核对补充 → 工单归档进问题库。

### 场景 C：周报与改进闭环
每周一 09:00 自动汇总上周所有渠道问题 → 识别热点话题/重复问题 → 报告通过邮件 + 系统通知推送给客服主管 → 主管导出后线下分发给相关团队。

---

## 4. 用户流程

### 流程 1：会话主流程（网页/微信）
```
用户发消息
  ↓
系统检查【敏感问题规则】
  ├─ 命中 → AI 不出答，标红提示客服人工处理
  └─ 未命中 → AI 三源检索 → 生成推荐答案 + 出处
                ↓
            客服选择：直接发 / 修改后发 / 忽略
                ↓
            记录采纳行为（用于看板）
                ↓
            会话继续，直到客服手动结束或用户超时
                ↓
            邀请用户打分（CSAT）
                ↓
            归档进问题库
                ↓
            CSAT≥4 星自动进入自学索引；或客服手动标记加入
```

### 流程 2：电话工单流程
```
客服线下接听电话
  ↓
通话结束后上传录音
  ↓
系统转文字 + AI 生成摘要（问题/处理结果/分类标签）
  ↓
客服校对补充
  ↓
归档进问题库
```

### 流程 3：周报闭环
```
每周一 09:00 触发
  ↓
拉取上周所有归档问题（三渠道）
  ↓
AI 聚类找热点 + 重复问题
  ↓
生成报告（话题、出现次数、典型案例、趋势）
  ↓
邮件 + 系统通知推送给客服主管
  ↓
主管查看 → 导出 → 线下转给相关团队
```

---

## 5. 功能需求索引

| # | 模块 | 文件 |
|---|---|---|
| 1 | 统一对话工作台 | [feat-001-unified-workbench](features/feat-001-unified-workbench.md) |
| 2 | AI 答案推荐引擎 | [feat-002-ai-recommendation](features/feat-002-ai-recommendation.md) |
| 3 | 知识库管理 | [feat-003-knowledge-base](features/feat-003-knowledge-base.md) |
| 4 | SharePoint 文档库接入 | [feat-004-sharepoint-integration](features/feat-004-sharepoint-integration.md) |
| 5 | 历史对话自学 | [feat-005-conversation-self-learning](features/feat-005-conversation-self-learning.md) |
| 6 | 电话工单录入 | [feat-006-phone-ticket](features/feat-006-phone-ticket.md) |
| 7 | 问题库 | [feat-007-issue-repository](features/feat-007-issue-repository.md) |
| 8 | 周报与热点分析 | [feat-008-weekly-report](features/feat-008-weekly-report.md) |
| 9 | 用户满意度评价 | [feat-009-csat-survey](features/feat-009-csat-survey.md) |
| 10 | 数据看板 | [feat-010-dashboard](features/feat-010-dashboard.md) |
| 11 | 敏感问题拦截 | [feat-011-sensitive-filter](features/feat-011-sensitive-filter.md) |

---

## 6. User Stories 索引

| # | 角色 | 主题 | 文件 |
|---|---|---|---|
| US-001 | 一线客服 | 网页/微信对话中获得 AI 推荐答案 | [us-001-agent-ai-suggestion](user-stories/us-001-agent-ai-suggestion.md) |
| US-002 | 一线客服 | 电话通话后快速生成工单 | [us-002-agent-phone-ticket](user-stories/us-002-agent-phone-ticket.md) |
| US-003 | 客服主管 | 收到每周热点报告并分发 | [us-003-manager-weekly-report](user-stories/us-003-manager-weekly-report.md) |

---

## 7. 验收标准总览

### 业务指标（上线 3 个月后）
- CSAT 较基线 +5%
- 平均响应时长较基线 -10%
- AI 答案采纳率 ≥ 60%

### 功能完成（详见各 Feature 文件）
- 消息延迟 ≤ 3s；AI 推荐响应 ≤ 5s
- 录音转文字准确率 ≥ 85%
- 周报准时率 100%
- 敏感规则修改 5 分钟内生效

---

## 8. 非目标（本期明确不做）

1. 电话渠道的**实时** AI 辅助（仅做事后工单）
2. AI 全自动应答 / 机器人客服（必须人工把关）
3. 相关团队（产品/运营/技术）在系统内的协作登录
4. 多语言支持（仅中文）
5. 客户主动触达 / 外呼营销
6. 工单跨部门转派、SLA 升级、多级审批等复杂流转
7. 客服侧移动端 App（只做 PC 网页端）
8. 与现有 CRM / 订单系统的深度打通

---

## 9. 相关文档

- [UX 说明](ux-notes.md)
- [业务约束](constraints.md)

---

## 10. Open Questions

- 业务指标基线值需上线前由客服主管提供（CSAT 基线、响应时长基线）
- SharePoint 站点的具体地址与权限范围需在实施阶段确认
- 微信渠道是企业微信还是公众号客服？需在实施前确认
- 录音上传的最大时长与文件格式限制需运维侧确认
