#!/usr/bin/env node
/**
 * image-mcp — a generic image-generation MCP server for LibreChat.
 *
 * Exposes a single tool `generateImage` that calls an OpenAI-compatible
 * /chat/completions endpoint (the poloai gateway), extracts the base64
 * data-URI the model returns inside its markdown content, decodes it, writes
 * it to IMAGE_OUTPUT_DIR, and returns the saved file path. That path can be
 * dropped straight into pptx-mcp renderDeck's `imagePath`, or shown in chat.
 *
 * In addition to the on-disk path (used by pptx-mcp for slide rendering), the
 * tool also publishes a copy under IMAGE_PUBLIC_DIR (an unauthenticated,
 * browser-reachable directory served by LibreChat's /images route) and returns
 * a fully-qualified `url`. When showing the image to the user in chat, use the
 * `url` field in markdown (`![alt](url)`) — never the `path`, which is a
 * container-internal filesystem path the browser cannot fetch.
 *
 * Why chat/completions (not /images/generations): the configured gateway's
 * image models (e.g. gemini-3-pro-image-preview) return the image as a
 * `data:image/...;base64,...` markdown image in the chat message content, not
 * via the standard images endpoint.
 *
 * Mirrors the git-mcp / pptx-mcp structure: stdio transport, same SDK, same
 * ok()/isError envelope. No external npm deps beyond the MCP SDK; uses only
 * Node built-ins for the HTTP call and file write.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR ?? '';
const API_KEY = process.env.IMAGE_GEN_API_KEY ?? '';
const BASEURL = (process.env.IMAGE_GEN_BASEURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.IMAGE_GEN_MODEL ?? 'gpt-image-1';
const TIMEOUT_MS = Number.parseInt(process.env.IMAGE_GEN_TIMEOUT_MS ?? '120000', 10);

// Public, browser-reachable publishing. PUBLIC_DIR is a directory served
// unauthenticated under LibreChat's /images route; PUBLIC_BASE is the
// fully-qualified origin INCLUDING any reverse-proxy subpath (e.g.
// https://p.xbot.cool/librechat) and PUBLIC_ROUTE is the URL path that maps to
// PUBLIC_DIR (default /images/gen). If PUBLIC_DIR is unset, publishing is
// skipped and only `path` is returned (back-compat with pptx-only use).
const PUBLIC_DIR = process.env.IMAGE_PUBLIC_DIR ?? '';
const PUBLIC_BASE = (process.env.IMAGE_PUBLIC_BASE ?? '').replace(/\/+$/, '');
const PUBLIC_ROUTE = (process.env.IMAGE_PUBLIC_ROUTE ?? '/images/gen').replace(/\/+$/, '');

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function assertConfigured() {
  if (!OUTPUT_DIR) throw new Error('IMAGE_OUTPUT_DIR is not set');
  if (!API_KEY) throw new Error('IMAGE_GEN_API_KEY is not set');
}

/** Only allow a safe, flat filename; never let the caller escape OUTPUT_DIR. */
function sanitiseFileName(name) {
  const base = String(name || 'image')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return base || 'image';
}

/** Pull the first data:image/...;base64,XXXX out of arbitrary text content. */
function extractDataUri(content) {
  if (typeof content !== 'string') {
    // some gateways return content as an array of parts
    if (Array.isArray(content)) {
      content = content
        .map((p) => (typeof p === 'string' ? p : p?.text || p?.image_url?.url || ''))
        .join('\n');
    } else {
      content = '';
    }
  }
  const m = content.match(/data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  return { ext: m[1].toLowerCase().replace('jpeg', 'jpg'), b64: m[2] };
}

/**
 * Copy a generated file into the public directory and return its URL, or null
 * if publishing is not configured. Best-effort: a publish failure must not
 * fail image generation, since the on-disk path is still useful for pptx.
 */
function publish(fileName, srcPath) {
  if (!PUBLIC_DIR || !PUBLIC_BASE) return null;
  try {
    mkdirSync(PUBLIC_DIR, { recursive: true });
    copyFileSync(srcPath, join(PUBLIC_DIR, fileName));
    return `${PUBLIC_BASE}${PUBLIC_ROUTE}/${fileName}`;
  } catch {
    return null;
  }
}

async function callGateway(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASEURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`gateway HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`gateway returned non-JSON: ${text.slice(0, 200)}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    const found = extractDataUri(content);
    if (!found) {
      const preview = (typeof content === 'string' ? content : JSON.stringify(content) || '').slice(0, 200);
      throw new Error(`no image returned by model; content preview: ${preview}`);
    }
    return found;
  } finally {
    clearTimeout(timer);
  }
}

const tools = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt and save it to disk. Returns both a publicly-reachable `url` (use this in markdown when showing the image to the user) and an on-disk `path` (use this as an imagePath for slide rendering). Use a detailed, descriptive prompt (subject, style, colors, composition, background).',
    inputSchema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
        fileName: {
          type: 'string',
          description: 'Optional base file name (no extension); a safe name is derived from it.',
        },
      },
    },
  },
];

const server = new Server({ name: 'image', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'generateImage') {
      assertConfigured();
      const prompt = String(args?.prompt || '').trim();
      if (!prompt) throw new Error('prompt is required');
      const { ext, b64 } = await callGateway(prompt);
      const stamp = Date.now();
      const fileName = `${sanitiseFileName(args?.fileName) || 'image'}_${stamp}.${ext}`;
      mkdirSync(OUTPUT_DIR, { recursive: true });
      const outPath = join(OUTPUT_DIR, fileName);
      writeFileSync(outPath, Buffer.from(b64, 'base64'));
      const url = publish(fileName, outPath);
      return ok({ ok: true, url, path: outPath, model: MODEL });
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err.message || err) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
