# image-mcp — 部署说明

通用图像生成 MCP server。暴露一个工具 `generateImage(prompt, fileName?)`,调用 OpenAI 兼容的
`/chat/completions` 接口,从返回的 markdown 里抽出 base64 图片、解码存盘,返回文件路径。

> 为什么走 chat 而非 /images/generations:配置的网关(poloai)的图像模型
> (如 `gemini-3-pro-image-preview`)把图片以 `data:image/...;base64,...` 形式放在 chat 消息内容里返回,
> 不支持标准 images 端点。

## 落地(主机 mount,无需改镜像)

server 只用 Node 内置 `fetch`/`fs`,除 MCP SDK 外无依赖,**不需要改 Dockerfile / 重建镜像**。

1. 建目录:`sudo -n mkdir -p /srv/librechat/skill/image-mcp`
2. base64 落地 `server.mjs` + `package.json`,sha256 校验和比对。
3. 装依赖:`sudo -n npm install --prefix /srv/librechat/skill/image-mcp --omit=dev`
4. 建输出目录并改属主(容器 uid 1000):
   `sudo -n mkdir -p /srv/librechat/uploads/image-output`
   `sudo -n chown 1000:1000 /srv/librechat/uploads/image-output`

## 配置(env,写进 /srv/librechat/.env,不进仓库)

```
IMAGE_GEN_API_KEY=<你的 key>            # 事后轮换
IMAGE_GEN_BASEURL=https://poloai.top/v1
IMAGE_GEN_MODEL=gemini-3-pro-image-preview
IMAGE_OUTPUT_DIR=/app/uploads/image-output
# 可选:IMAGE_GEN_TIMEOUT_MS=120000
```

改 `.env` 后必须 `docker compose -f /srv/librechat/docker-compose.yml up -d api` 重建(restart 不注入新环境)。
`IMAGE_OUTPUT_DIR` 也可放进 librechat.yaml 的 mcpServers.image env(见下),其余三个走 .env 引用。

## 注册(librechat.yaml mcpServers)

```yaml
  image:
    type: stdio
    command: node
    args:
      - /app/skill/image-mcp/server.mjs
    env:
      IMAGE_GEN_API_KEY: ${IMAGE_GEN_API_KEY}
      IMAGE_GEN_BASEURL: ${IMAGE_GEN_BASEURL}
      IMAGE_GEN_MODEL: ${IMAGE_GEN_MODEL}
      IMAGE_OUTPUT_DIR: /app/uploads/image-output
    timeout: 180000
```

改完用 `yaml.safe_load` 校验整文件,再 `docker restart librechat-api`(yaml 是挂载文件)。

> stdio 本地 MCP 自己发 HTTP 出站,**不需要** `actions.allowedDomains`(那是 HTTP Action 用的)。
> 但需确认容器能出站到网关域名。

## 绑定到 agent

工具暴露名为 `generateImage_mcp_image`。在 Agent Builder 里给任意 agent 勾选即可:
- PPT 助手:勾上后,设计阶段可生成配图,把返回 path 填进 renderDeck 的 `imagePath`。
- 通用/其他 agent:勾上后,对话中出现画图意图时模型会自动调用。

## 验证

- 容器内可见:`docker exec librechat-api ls /app/skill/image-mcp`
- 依赖在:`docker exec librechat-api ls /app/skill/image-mcp/node_modules/@modelcontextprotocol`(应有 sdk)
- 端到端:在对话里让绑定该工具的 agent 画一张图,确认返回真实路径且文件生成(输出目录属主须为 uid 1000)。
