/**
 * PRD Dashboard state extraction.
 *
 * PRD Agent appends a structured state block at the END of each reply:
 *
 *   <!--PRD_STATE
 *   { ...json... }
 *   PRD_STATE-->
 *
 * Contract: docs/prd/agent/dashboard-contract.md
 * Schema:   docs/prd/agent/dashboard-state.schema.json
 *
 * The block is wrapped in an HTML comment so it stays invisible even if not
 * stripped. We extract it for the dashboard and strip it from displayed text.
 */

export type PrdDimensionKey =
  | 'background'
  | 'users'
  | 'scenarios'
  | 'features'
  | 'flow'
  | 'acceptance'
  | 'nongoals';

export type PrdStatus = 'missing' | 'partial' | 'complete';

export interface PrdDimension {
  key: PrdDimensionKey;
  label: string;
  status: PrdStatus;
}

export interface PrdSynced {
  path: string;
  committed: boolean;
  ref?: string;
}

export interface PrdState {
  version: string;
  slug: string;
  title: string;
  overallPercent: number;
  dimensions: PrdDimension[];
  highlights: Record<PrdDimensionKey, string>;
  synced?: PrdSynced;
}

export const PRD_DIMENSION_ORDER: PrdDimensionKey[] = [
  'background',
  'users',
  'scenarios',
  'features',
  'flow',
  'acceptance',
  'nongoals',
];

/** Non-greedy match; capture all blocks so we can take the last valid one. */
const PRD_STATE_RE = /<!--PRD_STATE\s*([\s\S]*?)\s*PRD_STATE-->/g;

/** Remove every closed PRD_STATE block from text shown to the user. */
export function stripPrdState(text: string): string {
  if (!text) {
    return text;
  }
  let out = text.replace(PRD_STATE_RE, '');
  // Defensive: hide an unclosed block that is still streaming in.
  const openIdx = out.indexOf('<!--PRD_STATE');
  if (openIdx !== -1) {
    out = out.slice(0, openIdx);
  }
  return out.trimEnd();
}

function isValidStatus(s: unknown): s is PrdStatus {
  return s === 'missing' || s === 'partial' || s === 'complete';
}

/** Validate the minimal shape we depend on. Returns null if invalid. */
export function validatePrdState(data: unknown): PrdState | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const d = data as Record<string, unknown>;
  if (d.version !== '1.0') {
    return null;
  }
  if (typeof d.slug !== 'string' || typeof d.title !== 'string') {
    return null;
  }
  if (typeof d.overallPercent !== 'number') {
    return null;
  }
  if (!Array.isArray(d.dimensions) || d.dimensions.length !== 7) {
    return null;
  }

  const dims: PrdDimension[] = [];
  for (const raw of d.dimensions) {
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const r = raw as Record<string, unknown>;
    if (!PRD_DIMENSION_ORDER.includes(r.key as PrdDimensionKey)) {
      return null;
    }
    if (typeof r.label !== 'string' || !isValidStatus(r.status)) {
      return null;
    }
    dims.push({ key: r.key as PrdDimensionKey, label: r.label, status: r.status });
  }

  const highlights = (d.highlights ?? {}) as Record<string, unknown>;
  const safeHighlights = {} as Record<PrdDimensionKey, string>;
  for (const k of PRD_DIMENSION_ORDER) {
    const v = highlights[k];
    safeHighlights[k] = typeof v === 'string' ? v : '';
  }

  let synced: PrdSynced | undefined;
  if (d.synced && typeof d.synced === 'object') {
    const s = d.synced as Record<string, unknown>;
    if (typeof s.path === 'string' && typeof s.committed === 'boolean') {
      synced = {
        path: s.path,
        committed: s.committed,
        ref: typeof s.ref === 'string' ? s.ref : undefined,
      };
    }
  }

  return {
    version: '1.0',
    slug: d.slug,
    title: d.title,
    overallPercent: Math.max(0, Math.min(100, Math.round(d.overallPercent))),
    dimensions: dims,
    highlights: safeHighlights,
    synced,
  };
}

/** Extract the last valid PRD_STATE block from a single message's text. */
export function extractPrdState(text: string): PrdState | null {
  if (!text || !text.includes('<!--PRD_STATE')) {
    return null;
  }
  const matches = [...text.matchAll(PRD_STATE_RE)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i][1]);
      const valid = validatePrdState(parsed);
      if (valid) {
        return valid;
      }
    } catch {
      // try the previous block
    }
  }
  return null;
}

/** Recompute percent from dimensions (source of truth for the bar). */
export function computePercent(dims: PrdDimension[]): number {
  if (!dims.length) {
    return 0;
  }
  const complete = dims.filter((d) => d.status === 'complete').length;
  return Math.round((complete / dims.length) * 100);
}

export function isComplete(state: PrdState | null): boolean {
  return !!state && state.dimensions.every((d) => d.status === 'complete');
}
