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
