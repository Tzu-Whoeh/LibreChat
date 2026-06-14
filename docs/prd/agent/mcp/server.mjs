#!/usr/bin/env node
/**
 * PRD GitHub MCP server (stdio transport).
 *
 * Exposes two tools to the PRD agent:
 *   - readPrdFile(path, ref?)        -> read a file under docs/prd/
 *   - writePrdFile(path, content,    -> create/update a file under docs/prd/
 *                  message, sha?, branch?)
 *
 * Writes go through the ops control plane (ops.xbot.cool/api/v1/repo/put),
 * which accepts PLAIN TEXT content and handles base64 + GitHub commit. This
 * sidesteps both (a) the GitHub-API base64 requirement and (b) the LibreChat
 * action-UI save flow that failed for control-plane-targeted actions.
 *
 * Auth: OPS_API_KEY env var (Bearer). Never hard-coded.
 * Scope guard: refuses any path not under docs/prd/.
 *
 * Config (librechat.yaml):
 *   mcpServers:
 *     prd-github:
 *       type: stdio
 *       command: node
 *       args: ["/app/skill/prd-github-mcp/server.mjs"]
 *       env:
 *         OPS_API_KEY: "${OPS_API_KEY}"
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const OPS_BASE = 'https://ops.xbot.cool/api/v1';
const OPS_API_KEY = process.env.OPS_API_KEY ?? '';
const REPO = 'Tzu-Whoeh/LibreChat';
const PATH_PREFIX = 'docs/prd/';

function assertPrdPath(path) {
  if (typeof path !== 'string' || !path.startsWith(PATH_PREFIX)) {
    throw new Error(`path must start with "${PATH_PREFIX}" (got: ${path})`);
  }
  if (path.includes('..')) {
    throw new Error('path must not contain ".."');
  }
}

async function opsCall(endpoint, body) {
  if (!OPS_API_KEY) {
    throw new Error('OPS_API_KEY is not set in the MCP server environment');
  }
  const res = await fetch(`${OPS_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }
  if (!res.ok || data.error) {
    const msg = data.error?.message || data._raw || `HTTP ${res.status}`;
    throw new Error(`ops ${endpoint} failed: ${msg}`);
  }
  return data;
}

const server = new Server(
  { name: 'prd-github', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'readPrdFile',
      description:
        'Read a PRD file under docs/prd/ (for resuming an existing PRD). Returns content (plain text) and sha.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'File path, must start with docs/prd/' },
          ref: { type: 'string', description: 'Branch, default main' },
        },
      },
    },
    {
      name: 'writePrdFile',
      description:
        'Create or update a PRD file under docs/prd/. Pass plain-text content (no base64 needed). When updating an existing file, pass its current sha (from readPrdFile).',
      inputSchema: {
        type: 'object',
        required: ['path', 'content', 'message'],
        properties: {
          path: { type: 'string', description: 'File path, must start with docs/prd/' },
          content: { type: 'string', description: 'File content as plain text' },
          message: { type: 'string', description: 'Git commit message' },
          sha: { type: 'string', description: 'Current blob sha when updating; omit when creating' },
          branch: { type: 'string', description: 'Target branch, default main' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === 'readPrdFile') {
      assertPrdPath(args.path);
      const data = await opsCall('/repo/get', {
        repo: REPO,
        path: args.path,
        ref: args.ref || 'main',
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ content: data.content, sha: data.sha, path: data.path }),
          },
        ],
      };
    }

    if (name === 'writePrdFile') {
      assertPrdPath(args.path);
      const body = {
        repo: REPO,
        path: args.path,
        content: args.content,
        message: args.message,
        branch: args.branch || 'main',
      };
      if (args.sha) {
        body.sha = args.sha;
      }
      const data = await opsCall('/repo/put', body);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, path: data.path, commit: data.commit, sha: data.sha }),
          },
        ],
      };
    }

    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: String(err.message || err) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
