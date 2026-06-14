---
name: librechat-feature-dev
description: >
  Hard-won practices for developing features in LibreChat (or similar large
  Node/React monorepos) through an ops/dev control plane, where you can read
  source and deploy but CANNOT run the full frontend build or a browser
  locally. Use when adding UI, agents, actions, or build/deploy pipelines to
  LibreChat. Covers what is verifiable vs not, the text-vs-content-parts trap,
  agent/runtime-entity reality, image-build deployment on shared hosts, and
  credential-scope friction.
---

# LibreChat feature development — field notes

These are concrete lessons from shipping a PRD-collector agent + a right-side
dashboard into a forked LibreChat (v0.8.6), deployed on a shared production
host via an ops control plane. Read this before estimating or starting similar
work — several of these cost a full build+deploy round-trip to discover.

## 1. Know what you can and cannot verify — and say so up front

In this environment you can: read any repo file, run `tsc`/`jest` on isolated
pure-logic files, build images in CI, deploy, and run read-only checks on the
host. You CANNOT: run `vite build` or a browser against the real app locally,
so **React integration correctness is not verifiable before deploy**.

Practice:
- Split deliverables into "verifiable now" (pure functions + their unit tests,
  JSON schemas, OpenAPI specs, YAML validity) and "needs real-machine smoke"
  (anything touching the render tree, hooks, stores, routing).
- Actually run the verifiable parts (jest, tsc, schema validation) and show the
  output. Don't claim correctness you didn't test.
- State the unverifiable risk explicitly and budget for ≥1 fix→build→deploy
  round-trip on the integration layer. Don't promise one-shot success.

## 2. The text-vs-content-parts trap (this one bit hard)

Modern LibreChat messages carry text in TWO places depending on the path:
- `message.text` (legacy / simple), and
- `message.content[]` parts (current content-parts model) — see the many
  `components/Chat/Messages/Content/Parts/*` components.

If you read only `msg.text` you may get an empty/partial string and your logic
silently no-ops. Symptom seen: dashboard never rendered because the parser ran
on `msg.text` while the real text was in `content` parts.

Practice: when extracting anything from a message, read BOTH `msg.text` and
`msg.content[].text`. The text part renderer is `Parts/Text.tsx` — for any
"transform what the user sees" need (stripping a control block, etc.), that is
the single correct injection point, not `ChatView`/`Presentation`.

## 3. Two separate jobs: "drive a side panel" vs "transform displayed text"

A right-side panel and hiding a control block from the message body are
INDEPENDENT changes with different injection points:
- Panel: reuse the existing right-panel slot. `Presentation.tsx` feeds an
  `artifacts` ReactNode into `SidePanelGroup`; gate your panel on a condition
  and return it there. Minimal, non-invasive — no need to touch SidePanel.
- Hiding text: must happen in the text renderer (`Parts/Text.tsx`), before the
  string reaches `<Markdown>`. Writing the strip function is not enough — it
  must be WIRED into the render path. (Missing this wiring leaked raw JSON.)

Checklist: for every helper you write, grep for its call site in the actual
render pipeline before declaring done.

## 4. Conditional, inert-by-default features

Gate optional UI on a build-time var (e.g. `VITE_PRD_AGENT_ID`) compared to
runtime state (`conversationAgentIdByIndex`). When unset, the feature is fully
inert and stock deployments are unaffected — this makes merging safe even
before the feature is wired end to end.

## 5. Agents/Actions are RUNTIME entities, not code

In v0.8.6 an agent (its prompt + bound actions + action credentials) lives in
MongoDB, created via Agent Builder UI — not a file you can PR. So:
- Version the *assets* (system prompt text, action OpenAPI spec, the
  front/back data contract + JSON schema, a SETUP.md) in the repo.
- The agent itself is created on the running instance. Hand the UI steps to a
  human, especially because the GitHub Action needs a PAT — credentials must
  not pass through you. Verify afterwards by reading mongo (`db.agents`,
  `db.actions`) that `tools` is non-empty and the action persisted.

## 6. Actions hit SSRF allowlist — set it BEFORE creating the action

LibreChat validates Action target domains against `actions.allowedDomains` in
`librechat.yaml` (SSRF protection). `api.github.com` etc. must be allow-listed
first, or adding/saving the Action silently fails (observed: agent saved but
`tools: []`, `db.actions` count 0). Order: edit yaml + restart api, THEN add
the action in the UI.

## 7. Deploying source-built images on a shared host

The host may run the upstream prebuilt image with no source checkout. To ship
your fork's frontend you must build an image and have the host pull it.
- BUILD IN CI, NOT ON THE HOST. The shared host here had ~375Mi free RAM;
  `npm run frontend` (vite) would OOM and starve co-located production
  (outline/openproject). Build in GitHub Actions → push to GHCR → host pulls.
- Build-time frontend vars (`VITE_*`) must be injected at image build (vite
  inlines them). Add an `ARG/ENV` in the Dockerfile BEFORE `npm run frontend`;
  pass it via `workflow_dispatch` input or repo variable.
- Verify the image actually baked it: `docker exec <api> grep -rl <value>
  /app/client/dist/assets`. Confirms build+deploy without a browser.
- Shared-host safety: only ever target the librechat compose project/services
  by name. Never bare `compose down` in a dir; never restart unnamed. Confirm
  neighbor containers (count + Up) are untouched after every change.
- Always back up `docker-compose.yml` / `librechat.yaml` before editing, with a
  dated suffix. (A printf `\n`-escaping bug corrupted the yaml once; the backup
  made rollback instant — and validate yaml by parsing it after every edit.)

## 8. Editing files on the host via exec — escaping pitfalls

`exec` runs one command, no compound (`;`/`&&`). For multi-line file edits,
`printf '...\n...'` does NOT interpret `\n` reliably through the layers here —
it wrote literal `\n`. Use base64: `echo <b64> | base64 -d >> file`. Always
re-read and parse the file afterward to confirm.

## 9. Credential scope friction is incremental

A single PAT accreted scopes across the project: contents:write (PRs) →
workflow (commit `.github/workflows/*`) → actions:write (dispatch a run).
Each missing scope surfaces as a 403 on a specific endpoint. Don't route
around it — identify the exact missing scope, ask the human to add it, retry.
Note the growing blast radius and recommend rotating the key at project end.

## 10. The control-plane API quirks (this fork's ops plane)

- `repo/get` returns file content as PLAIN TEXT, not base64 (don't double-decode).
- `repo/put_many` file `content` is raw text; updates need the current blob `sha`.
- Param names differ per endpoint: `inventory/get` uses `name`, `exec`/`deploy`
  use `server`. The deploy target `p.xbot.cool` is server name `laifu`.
- 403 `forbidden` from a GitHub-backed endpoint = downstream PAT scope, not the
  ops key. 401 `auth_error` on repo endpoints = GitHub creds, not ops key.
- bash may emit "invalid UTF-8" on Chinese output; decode with
  `python3 -c "import sys;print(sys.stdin.buffer.read().decode('utf-8','replace'))"`.

## 11. Generic git MCP server — 设计与坑

把 LibreChat action 换成 MCP server 是正确架构（action UI 在子路径部署下有认证 bug，且 GitHub API 强制 base64 而 LLM 不能可靠编码）。

**为什么走 ops 控制平面而不直连 GitHub：**
content 传明文 → 控制平面处理 base64 + commit → GitHub。agent 永远传明文，base64 100% 可靠。不依赖本地 git（容器内没有 git），天然与 CI（GitHub Actions）兼容。

**通用 git MCP server 的 scope 控制：**
同一个 server 二进制，通过环境变量按 agent 配权限：
- `GIT_REPO`：操作哪个仓库
- `GIT_ALLOWED_PATHS`：路径前缀白名单（逗号分隔），空=不限
- `GIT_ALLOW_PR`：true 才暴露 createBranch/createPullRequest

scope 校验要兼容有无尾斜杠：`docs/prd`（无斜杠）和 `docs/prd/`（有斜杠）都应通过，但 `api/` 不行。用 `path.startsWith(prefix) || normalized === prefixNormalized` 而不是单纯 startsWith。

**listFiles 对不存在目录要容错：**
新项目目录在 GitHub 上不存在，/repo/list 会返回 not_found。应捕获这个错误、返回空列表（语义：新项目，还没有文件），让 agent 知道该创建文件，而不是卡在报错上。

**批量写入是硬性要求，不是优化：**
LibreChat 单回合有时间上限。逐个调用 writeFile 写 17 个文件会超时被 terminated，后续写入全部取消。对多文件写入一律用 writeFiles（底层 put_many，一次 commit）。prompt 里要明确禁止循环写单文件。

**防幻觉约束必须写进 prompt：**
agent 在工具全部失效（旧的 prd-github 工具指向不存在的 server）时，会"假装"写成功、编造 GitHub 链接。真机暴露过一次：survey-system 在 GitHub 根本不存在，但 agent 给了"成功"的链接。
解决：① 工具替换务必验证（mongo 里确认 tools 字段有 _mcp_git 结尾的新工具）；② prompt 明确"只有工具真实返回 commit/sha 才能说写入成功，禁止编造链接"。

**yaml 改动需 docker restart 而非 compose up：**
librechat.yaml 是挂载文件，compose up 检测不到挂载文件内容变化，不会重启进程。改了 yaml 必须用 `sudo -n docker restart librechat-api` 才能让新配置生效。

**titleModel 用 current_model 而非写死某个模型：**
写死 gpt-5.5 等特定模型，一旦上游那个 channel 挂了，所有对话起标题全部超时失败（New Chat）。用 `current_model` 让起标题跟着当前对话模型走，只要能聊就能起标题，天然容错。

## 12. 文件太大无法用单条 exec 命令写入

exec 的 cmd 字段有 8192 字符上限。base64 编码一个 10KB 的文件会超限。解决：分块追加到临时 .b64 文件，再一次性 `base64 -d` 解码成目标文件。

```bash
# 分块写
echo -n {chunk1} >> /tmp/file.b64
echo -n {chunk2} >> /tmp/file.b64
# 解码
base64 -d /tmp/file.b64 > /target/file.mjs
rm /tmp/file.b64
```

## 13. LibreChat action UI 的认证 bug（子路径部署）

在 /librechat 子路径反代部署下，Agent Builder 的 action 保存请求（POST /api/agents/actions/...）在前端发出时不带有效 auth token，后端返回 400/401。根因是前端 token 附加逻辑与子路径部署不兼容。现象：Network 标签无信号（请求根本没发出），Console 有 "Token is not present"。

经多轮排查确认：spec 本身没问题（在容器里用 node 实测 validateAndParseOpenAPISpec / validateActionDomain / isActionDomainAllowed / openapiToFunction 全部通过），问题在 LibreChat 前端代码，无法从服务端修复。

**绕过方案：用 MCP server 代替 action**。MCP 走 librechat.yaml 配置 + 容器内 stdio，完全绕开 action UI 认证问题。
