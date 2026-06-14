#!/usr/bin/env node
/**
 * Generic git/GitHub MCP server (stdio transport).
 *
 * A thin MCP wrapper over the ops control plane (ops.xbot.cool/api/v1). It does
 * NOT touch GitHub directly, use system git, or keep a local clone — every
 * operation maps to a control-plane endpoint, which handles base64, commits,
 * and GitHub auth. Designed to be reused by every agent in the pipeline (PRD,
 * architecture, prototype, code), with per-instance scope set via env vars.
 *
 * Tools (generic names):
 *   readFile(path, ref?)
 *   writeFile(path, content, message, sha?, branch?)
 *   writeFiles(files[], message, branch?)      // single commit
 *   listFiles(path, ref?)
 *   createBranch(branch, fromRef?)             // gated by GIT_ALLOW_PR
 *   createPullRequest(title, head, base?, body?) // gated by GIT_ALLOW_PR
 *
 * Config (env):
 *   OPS_API_KEY        Bearer token for the control plane (required)
 *   GIT_REPO           target repo "owner/name" (required)
 *   GIT_ALLOWED_PATHS  comma-separated path prefixes the instance may touch
 *                      (e.g. "docs/prd/"); empty = no path restriction
 *   GIT_ALLOW_PR       "true" to enable createBranch/createPullRequest;
 *                      anything else disables them
 *   GIT_DEFAULT_BRANCH default branch for reads/writes (default "main")
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const OPS_BASE = 'https://ops.xbot.cool/api/v1';
const OPS_API_KEY = process.env.OPS_API_KEY ?? '';
const REPO = process.env.GIT_REPO ?? '';
const DEFAULT_BRANCH = process.env.GIT_DEFAULT_BRANCH ?? 'main';
const ALLOW_PR = (process.env.GIT_ALLOW_PR ?? '').toLowerCase() === 'true';
const ALLOWED_PATHS = (process.env.GIT_ALLOWED_PATHS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function assertConfigured() {
  if (!OPS_API_KEY) {
    throw new Error('OPS_API_KEY is not set');
  }
  if (!REPO) {
    throw new Error('GIT_REPO is not set');
  }
}

/** Enforce the per-instance path scope (and basic traversal safety). */
function assertPathAllowed(path) {
  if (typeof path !== 'string' || !path) {
    throw new Error('path is required');
  }
  if (path.includes('..')) {
    throw new Error('path must not contain ".."');
  }
  if (ALLOWED_PATHS.length === 0) {
    return; // no restriction configured
  }
  // A path is allowed if it falls under an allowed prefix, OR if it IS an
  // allowed prefix (with or without a trailing slash) — e.g. listing the
  // scope root "docs/prd" when the prefix is "docs/prd/".
  const normalized = path.replace(/\/+$/, '');
  const ok = ALLOWED_PATHS.some((prefix) => {
    const p = prefix.replace(/\/+$/, '');
    return path.startsWith(prefix) || normalized === p || path === p;
  });
  if (!ok) {
    throw new Error(
      `path "${path}" is outside this agent's allowed scope (${ALLOWED_PATHS.join(', ')})`,
    );
  }
}

async function opsCall(endpoint, body) {
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

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const baseTools = [
  {
    name: 'readFile',
    description: 'Read a file from the repository. Returns content (plain text) and sha.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path within the repo' },
        ref: { type: 'string', description: 'Branch or commit, default the repo default branch' },
      },
    },
  },
  {
    name: 'writeFile',
    description:
      'Create or update a SINGLE file. Pass plain-text content (no base64 needed). When updating, pass the current sha (from readFile). For multiple files prefer writeFiles.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content', 'message'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'Plain-text file content' },
        message: { type: 'string', description: 'Commit message' },
        sha: { type: 'string', description: 'Current blob sha when updating; omit when creating' },
        branch: { type: 'string' },
      },
    },
  },
  {
    name: 'writeFiles',
    description:
      'Create or update MULTIPLE files in a SINGLE commit. Strongly preferred for writing several files at once — far faster and avoids per-file round trips. Each file is plain text; omit sha to create, pass sha to update.',
    inputSchema: {
      type: 'object',
      required: ['files', 'message'],
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'content'],
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              sha: { type: 'string' },
            },
          },
        },
        message: { type: 'string' },
        branch: { type: 'string' },
      },
    },
  },
  {
    name: 'listFiles',
    description: 'List entries (files and directories) under a repository path.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Directory path; "" for repo root' },
        ref: { type: 'string' },
      },
    },
  },
];

const prTools = [
  {
    name: 'createBranch',
    description: 'Create a new branch from a base ref.',
    inputSchema: {
      type: 'object',
      required: ['branch'],
      properties: {
        branch: { type: 'string', description: 'New branch name' },
        fromRef: { type: 'string', description: 'Base ref, default the repo default branch' },
      },
    },
  },
  {
    name: 'createPullRequest',
    description: 'Open a pull request from head into base.',
    inputSchema: {
      type: 'object',
      required: ['title', 'head'],
      properties: {
        title: { type: 'string' },
        head: { type: 'string', description: 'Source branch' },
        base: { type: 'string', description: 'Target branch, default the repo default branch' },
        body: { type: 'string' },
      },
    },
  },
];

const server = new Server(
  { name: 'git', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALLOW_PR ? [...baseTools, ...prTools] : baseTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    assertConfigured();

    if (name === 'readFile') {
      assertPathAllowed(args.path);
      const data = await opsCall('/repo/get', {
        repo: REPO,
        path: args.path,
        ref: args.ref || DEFAULT_BRANCH,
      });
      return ok({ content: data.content, sha: data.sha, path: data.path });
    }

    if (name === 'writeFile') {
      assertPathAllowed(args.path);
      const body = {
        repo: REPO,
        path: args.path,
        content: args.content,
        message: args.message,
        branch: args.branch || DEFAULT_BRANCH,
      };
      if (args.sha) {
        body.sha = args.sha;
      }
      const data = await opsCall('/repo/put', body);
      return ok({ ok: true, path: data.path, commit: data.commit, sha: data.sha });
    }

    if (name === 'writeFiles') {
      if (!Array.isArray(args.files) || args.files.length === 0) {
        throw new Error('files must be a non-empty array');
      }
      const outFiles = args.files.map((f) => {
        assertPathAllowed(f.path);
        const entry = { path: f.path, content: f.content };
        if (f.sha) {
          entry.sha = f.sha;
        }
        return entry;
      });
      const data = await opsCall('/repo/put_many', {
        repo: REPO,
        branch: args.branch || DEFAULT_BRANCH,
        message: args.message,
        files: outFiles,
      });
      return ok({
        ok: true,
        commit: data.commit,
        files: (data.files || []).map((f) => ({ path: f.path, status: f.status })),
      });
    }

    if (name === 'listFiles') {
      assertPathAllowed(args.path === '' ? (ALLOWED_PATHS[0] ?? '') : args.path);
      try {
        const data = await opsCall('/repo/list', {
          repo: REPO,
          path: args.path ?? '',
          ref: args.ref || DEFAULT_BRANCH,
        });
        return ok({
          path: data.path,
          entries: (data.entries || []).map((e) => ({ type: e.type, path: e.path })),
        });
      } catch (err) {
        // A non-existent directory means "no files yet" (e.g. a brand-new
        // project). Treat that as an empty listing rather than an error, so
        // the agent knows to create files instead of getting stuck.
        if (/not found/i.test(String(err.message || err))) {
          return ok({ path: args.path ?? '', entries: [], note: 'path does not exist yet (treated as empty)' });
        }
        throw err;
      }
    }

    if (name === 'createBranch') {
      if (!ALLOW_PR) {
        throw new Error('createBranch is disabled for this agent (GIT_ALLOW_PR is not true)');
      }
      const data = await opsCall('/repo/branch/create', {
        repo: REPO,
        branch: args.branch,
        from_ref: args.fromRef || DEFAULT_BRANCH,
      });
      return ok({ ok: true, branch: data.branch, sha: data.sha });
    }

    if (name === 'createPullRequest') {
      if (!ALLOW_PR) {
        throw new Error('createPullRequest is disabled for this agent (GIT_ALLOW_PR is not true)');
      }
      const data = await opsCall('/repo/pr/create', {
        repo: REPO,
        title: args.title,
        head: args.head,
        base: args.base || DEFAULT_BRANCH,
        body: args.body || '',
        draft: false,
      });
      return ok({ ok: true, number: data.number, html_url: data.html_url });
    }

    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err.message || err) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
