#!/usr/bin/env node
/**
 * Generic PPTX rendering MCP server (stdio transport).
 *
 * A thin MCP wrapper over python-pptx. It is deliberately CONTENT-AGNOSTIC:
 * it knows nothing about "masters", storylines, or visual themes — all of
 * that conversational logic lives in the pptx-assistant SKILL.md. This server
 * only turns a structured deck spec (JSON) into a real, editable .pptx file,
 * optionally on top of an uploaded template, and returns the saved path.
 *
 * Design mirrors the sibling git-mcp server: stdio transport, the same ok()/
 * isError envelope, env-var configuration, no compound shell commands.
 *
 * Tools:
 *   renderDeck(spec, templatePath?, fileName?)
 *       spec: { title?, theme?, slides: [ { layout?, title?, bullets?[],
 *               notes?, subtitle?, imagePath? } ] }
 *       templatePath: optional path to an uploaded .pptx/.potx used as the base
 *       fileName: optional output name (sanitised); default derived from title
 *     -> { ok, path, slides }   path is under PPTX_OUTPUT_DIR
 *
 *   inspectTemplate(templatePath)
 *       Report the layouts available in an uploaded template so the assistant
 *       can map slides onto them.
 *     -> { ok, layouts: [ { index, name } ] }
 *
 * Config (env):
 *   PPTX_OUTPUT_DIR   directory to write generated decks (required)
 *   PPTX_PYTHON       python interpreter (default "python3")
 *   PPTX_MAX_SLIDES   safety cap on slide count (default 100)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OUTPUT_DIR = process.env.PPTX_OUTPUT_DIR ?? '';
const PYTHON = process.env.PPTX_PYTHON ?? 'python3';
const MAX_SLIDES = Number.parseInt(process.env.PPTX_MAX_SLIDES ?? '100', 10);
const RENDERER = join(__dirname, 'render_pptx.py');

// Design libraries (styles + font pairings). Loaded once, lazily, with a safe
// fallback to empty so a missing/bad file never crashes the server.
let _styles = null;
let _fonts = null;
function loadJson(file, key) {
  try {
    return JSON.parse(readFileSync(join(__dirname, file), 'utf-8'))[key] ?? [];
  } catch {
    return [];
  }
}
function getStyles() {
  if (_styles === null) _styles = loadJson('styles.json', 'styles');
  return _styles;
}
function getFonts() {
  if (_fonts === null) _fonts = loadJson('fonts.json', 'pairings');
  return _fonts;
}
// Lightweight match: exact id/name first, else keyword/substring overlap score.
function findBest(items, query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  const exact = items.find(
    (it) => (it.id || '').toLowerCase() === q || (it.name || '').toLowerCase() === q,
  );
  if (exact) return exact;
  let best = null;
  let bestScore = 0;
  for (const it of items) {
    const hay = [it.id, it.name, it.essence, it.mood, it.use_when, ...(it.keywords || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 2;
    for (const kw of it.keywords || []) {
      if (q.includes(String(kw).toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return bestScore > 0 ? best : null;
}

function assertConfigured() {
  if (!OUTPUT_DIR) {
    throw new Error('PPTX_OUTPUT_DIR is not set');
  }
}

/** Basic path-traversal safety for any caller-supplied path. */
function assertSafePath(path, label) {
  if (typeof path !== 'string' || !path) {
    throw new Error(`${label} is required`);
  }
  if (path.includes('..')) {
    throw new Error(`${label} must not contain ".."`);
  }
}

function sanitiseFileName(name) {
  const base = basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').trim();
  const cleaned = base.replace(/\s+/g, '_') || 'deck';
  return cleaned.toLowerCase().endsWith('.pptx') ? cleaned : `${cleaned}.pptx`;
}

/** Run the python renderer, feeding a JSON job on stdin, expecting JSON on stdout. */
function runRenderer(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [RENDERER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString('utf-8');
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf-8');
    });
    child.on('error', (e) => reject(new Error(`failed to start python: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`renderer exited ${code}: ${err.trim() || 'no stderr'}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`renderer produced non-JSON output: ${out.slice(0, 400)}`));
      }
    });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const tools = [
  {
    name: 'renderDeck',
    description:
      'Render a structured deck spec into a real, editable .pptx file and return its saved path. Content-agnostic: pass the finished outline/design as a spec. Prefer ONE call with all slides over many calls.',
    inputSchema: {
      type: 'object',
      required: ['spec'],
      properties: {
        spec: {
          type: 'object',
          required: ['slides'],
          properties: {
            title: { type: 'string', description: 'Deck title (used for the title slide and default filename)' },
            subtitle: { type: 'string' },
            titleSlide: {
              type: 'boolean',
              description:
                'Whether to auto-generate a title slide from title/subtitle. Default true. Set false when rendering a fragment that will be merged into a larger deck (only the first fragment should keep its title slide).',
            },
            theme: {
              type: 'object',
              description: 'Optional visual theme hints applied when NOT using a template',
              properties: {
                accentColor: { type: 'string', description: 'Hex like "1F4E79"' },
                titleFont: { type: 'string' },
                bodyFont: { type: 'string' },
                backgroundColor: { type: 'string', description: 'Hex' },
              },
            },
            slides: {
              type: 'array',
              description: 'Ordered slides',
              items: {
                type: 'object',
                properties: {
                  layout: {
                    type: 'string',
                    description: 'One of: title, title_content, section, blank. Default title_content.',
                  },
                  title: { type: 'string' },
                  subtitle: { type: 'string' },
                  bullets: {
                    type: 'array',
                    description: 'Bullet lines; objects allow nesting via {text, level}',
                    items: {
                      oneOf: [
                        { type: 'string' },
                        {
                          type: 'object',
                          required: ['text'],
                          properties: {
                            text: { type: 'string' },
                            level: { type: 'integer', minimum: 0, maximum: 4 },
                          },
                        },
                      ],
                    },
                  },
                  notes: { type: 'string', description: 'Speaker notes' },
                  imagePath: { type: 'string', description: 'Optional path to an image to place on the slide' },
                },
              },
            },
          },
        },
        templatePath: {
          type: 'string',
          description: 'Optional path to an uploaded .pptx/.potx to use as the base template',
        },
        fileName: { type: 'string', description: 'Optional output filename (.pptx)' },
      },
    },
  },
  {
    name: 'inspectTemplate',
    description:
      'List the slide layouts available in an uploaded template so slides can be mapped onto them.',
    inputSchema: {
      type: 'object',
      required: ['templatePath'],
      properties: {
        templatePath: { type: 'string' },
      },
    },
  },
  {
    name: 'mergeDecks',
    description:
      'Merge several .pptx files (in the given order) into one deck and return its path. Use this for batch/large-deck workflows: render each section as its own small .pptx (first fragment keeps the title slide, the rest set spec.titleSlide=false), then merge them in order. The first input seeds the slide size/theme; subsequent inputs slides are appended. Images are preserved.',
    inputSchema: {
      type: 'object',
      required: ['inputs'],
      properties: {
        inputs: {
          type: 'array',
          description: 'Ordered list of .pptx paths to concatenate (each from a prior renderDeck call).',
          items: { type: 'string' },
          minItems: 1,
        },
        fileName: { type: 'string', description: 'Optional output filename (.pptx)' },
      },
    },
  },
  {
    name: 'listStyles',
    description:
      'List all visual styles in the design library (name, school/master lens, essence, keywords, use_when). Use during the design stage to recommend a visual direction grounded in real options rather than guessing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getStyle',
    description:
      'Get one visual style by id/name, or best-matched by a keyword/theme query. Returns accentColor, backgroundColor, the referenced fontPairing, layoutBias and more — feed these straight into renderDeck theme.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Style id, name, or a theme/keyword to match' },
      },
    },
  },
  {
    name: 'listFonts',
    description:
      'List all font pairings in the library (title/body fonts for en + zh, mood, keywords). Only installed families render; others fall back.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getFont',
    description:
      'Get one font pairing by id/name, or best-matched by a keyword/mood query. Returns the en/zh title and body font family names to use in renderDeck theme.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Pairing id, name, or a mood/keyword to match' },
      },
    },
  },
];

const server = new Server(
  { name: 'pptx', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    // Read-only design-library lookups — no OUTPUT_DIR needed.
    if (name === 'listStyles') {
      const styles = getStyles().map((s) => ({
        id: s.id,
        name: s.name,
        school: s.school,
        essence: s.essence,
        keywords: s.keywords,
        use_when: s.use_when,
      }));
      return ok({ ok: true, count: styles.length, styles });
    }
    if (name === 'getStyle') {
      const s = findBest(getStyles(), args.query);
      if (!s) throw new Error(`no style matched: ${args.query}`);
      const pairing = getFonts().find((p) => p.id === s.fontPairing) || null;
      return ok({ ok: true, style: s, fontPairing: pairing });
    }
    if (name === 'listFonts') {
      return ok({ ok: true, count: getFonts().length, pairings: getFonts() });
    }
    if (name === 'getFont') {
      const p = findBest(getFonts(), args.query);
      if (!p) throw new Error(`no font pairing matched: ${args.query}`);
      return ok({ ok: true, fontPairing: p });
    }

    assertConfigured();

    if (name === 'renderDeck') {
      const spec = args.spec;
      if (!spec || !Array.isArray(spec.slides) || spec.slides.length === 0) {
        throw new Error('spec.slides must be a non-empty array');
      }
      if (spec.slides.length > MAX_SLIDES) {
        throw new Error(`too many slides (${spec.slides.length} > ${MAX_SLIDES})`);
      }
      if (args.templatePath) {
        assertSafePath(args.templatePath, 'templatePath');
      }
      const fileName = sanitiseFileName(args.fileName || spec.title || 'deck');
      const outPath = join(OUTPUT_DIR, fileName);
      const result = await runRenderer({
        action: 'render',
        spec,
        templatePath: args.templatePath || null,
        outPath,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return ok({ ok: true, path: result.path, slides: result.slides });
    }

    if (name === 'inspectTemplate') {
      assertSafePath(args.templatePath, 'templatePath');
      const result = await runRenderer({
        action: 'inspect',
        templatePath: args.templatePath,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return ok({ ok: true, layouts: result.layouts });
    }

    if (name === 'mergeDecks') {
      const inputs = args.inputs;
      if (!Array.isArray(inputs) || inputs.length === 0) {
        throw new Error('inputs must be a non-empty array of .pptx paths');
      }
      for (const p of inputs) {
        assertSafePath(p, 'inputs');
      }
      const fileName = sanitiseFileName(args.fileName || 'deck-merged');
      const outPath = join(OUTPUT_DIR, fileName);
      const result = await runRenderer({
        action: 'merge',
        inputs,
        outPath,
      });
      if (result.error) {
        throw new Error(result.error);
      }
      return ok({ ok: true, path: result.path, slides: result.slides });
    }

    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: String(err.message || err) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
