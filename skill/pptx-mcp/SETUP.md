# PPT 助手 — 部署说明 (SETUP)

本包提供 LibreChat 上的「PPT 助手」，由两部分组成：

1. **部署技能** `skills/pptx-assistant/SKILL.md` — 引导式共创工作流（谈主题 → 两位大师搭故事线 →
   备内容定大纲 → 选视觉大师做设计 → 生成可编辑 .pptx）。随镜像烘焙进 `/app/skills/`。
2. **渲染服务** `skill/pptx-mcp/` — 一个内容无关、可复用的 MCP server，用 `python-pptx`
   生成真实可编辑的 .pptx，并支持用户上传模板。挂载/落地到 `/app/skill/pptx-mcp/`，
   与既有 `git-mcp` 同构。

> 这是会改运行镜像的变更：**python-pptx 需烘焙进镜像**，因此必须走 CI 构建镜像 → 主机拉取，
> 不要在共享主机上现装（主机内存紧张，且现装会在重部署后丢失）。

## 1. 依赖：把 python-pptx 烘焙进镜像

在构建 api 镜像的 Dockerfile（或部署用 Dockerfile）中，确保安装：

```dockerfile
# python-pptx for the pptx-mcp rendering server
RUN pip3 install --no-cache-dir --break-system-packages python-pptx==1.0.2
```

容器内已确认存在 `python3` 与 `pip3`。验证镜像确实带上了依赖（部署后只读检查）：

```
sudo -n docker exec librechat-api python3 -c "import pptx
print(pptx.__version__)"
```

## 2. 落地 pptx-mcp server 文件

`skill/pptx-mcp/` 需出现在容器的 `/app/skill/pptx-mcp/`（与 git-mcp 相同的挂载根 `/srv/librechat/skill`）。
并安装其 Node 依赖（与 git-mcp 同款 `@modelcontextprotocol/sdk`）：

```
# 在 /srv/librechat/skill/pptx-mcp 下
npm install --omit=dev
```

需要写出的输出目录（生成的 .pptx 落点），建议复用已挂载的 uploads 卷：

```
PPTX_OUTPUT_DIR = /app/uploads/pptx-output   # 该路径经 /srv/librechat/uploads 持久化
```

## 3. 在 librechat.yaml 注册 MCP server

在 `mcpServers:` 下，紧随既有 `git:` 之后，加入（**先备份 yaml，改后解析校验**）：

```yaml
  pptx:
    type: stdio
    command: node
    args:
    - /app/skill/pptx-mcp/server.mjs
    env:
      PPTX_OUTPUT_DIR: /app/uploads/pptx-output
      PPTX_PYTHON: python3
      PPTX_MAX_SLIDES: '100'
    timeout: 120000
```

## 4. 让配置生效

`librechat.yaml` 是挂载文件，`compose up` 检测不到其内容变化、不会重启进程。改完必须：

```
sudo -n docker restart librechat-api
```

（python-pptx 进镜像属镜像变更，需重新拉取/重建镜像后再起容器；仅改 yaml 时用上面的 restart 即可。）

## 5. 部署后验证（只读）

- 三个 `librechat-*` 容器 Up，且邻居 `outline-*` / `openproject-*` 数量与状态不变。
- `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/health` == 200。
- `python3 -c "import pptx; ..."` 能打印版本。
- 在 Agents 端进入对话，技能列表出现 `pptx-assistant`；触发后能走完到 `renderDeck` 返回真实路径。

## 自验（构建/落地前可在隔离环境跑）

renderer 可独立验证（无需浏览器/前端）：

```
python3 skill/pptx-mcp/render_pptx.py <<'JOB'
{"action":"render","outPath":"/tmp/demo.pptx","spec":{"title":"Demo","slides":[{"layout":"title_content","title":"Hello","bullets":["one","two"]}]}}
JOB
# 期望 stdout: {"path": "/tmp/demo.pptx", "slides": 2}
```

`server.mjs` 与 git-mcp 同构（stdio transport + 同样的 ok()/isError 信封），其 MCP 接线需在真实
容器内冒烟验证（属"需真机冒烟"项）。
