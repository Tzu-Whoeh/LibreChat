import {
  extractPrdState,
  stripPrdState,
  validatePrdState,
  computePercent,
  isComplete,
  PRD_DIMENSION_ORDER,
  type PrdState,
} from './prdState';

function makeState(overrides: Partial<PrdState> = {}): PrdState {
  return {
    version: '1.0',
    slug: 'prd-tool',
    title: 'PRD 采集工具',
    overallPercent: 29,
    dimensions: [
      { key: 'background', label: '背景与目标', status: 'complete' },
      { key: 'users', label: '目标用户', status: 'complete' },
      { key: 'scenarios', label: '核心场景', status: 'partial' },
      { key: 'features', label: '功能需求', status: 'missing' },
      { key: 'flow', label: '流程', status: 'missing' },
      { key: 'acceptance', label: '验收标准', status: 'missing' },
      { key: 'nongoals', label: '非目标', status: 'missing' },
    ],
    highlights: {
      background: '誊写 PRD 耗时、易漏维度',
      users: '产品经理',
      scenarios: '',
      features: '',
      flow: '',
      acceptance: '',
      nongoals: '',
    },
    synced: { path: 'docs/prd/prd-tool.md', committed: true, ref: 'main' },
    ...overrides,
  };
}

function wrap(state: unknown): string {
  return `好的，我理解了。\n\n<!--PRD_STATE\n${JSON.stringify(state)}\nPRD_STATE-->`;
}

describe('prdState', () => {
  describe('extractPrdState', () => {
    it('extracts a valid block from message text', () => {
      const state = extractPrdState(wrap(makeState()));
      expect(state).not.toBeNull();
      expect(state?.slug).toBe('prd-tool');
      expect(state?.overallPercent).toBe(29);
    });

    it('returns null when there is no block', () => {
      expect(extractPrdState('普通回复，无状态块')).toBeNull();
    });

    it('returns null for an unclosed (streaming) block', () => {
      expect(extractPrdState('分析中…\n<!--PRD_STATE\n{"version":"1.0"')).toBeNull();
    });

    it('takes the last valid block when multiple are present', () => {
      const text = `<!--PRD_STATE\n{"bad":1}\nPRD_STATE-->\n中间\n${wrap(makeState())}`;
      expect(extractPrdState(text)?.slug).toBe('prd-tool');
    });
  });

  describe('stripPrdState', () => {
    it('removes a closed block but keeps prose', () => {
      const out = stripPrdState(wrap(makeState()));
      expect(out).not.toContain('PRD_STATE');
      expect(out).toContain('好的，我理解了');
    });

    it('hides an unclosed block from the opener onward', () => {
      const out = stripPrdState('正在分析…\n<!--PRD_STATE\n{"version":"1.0"');
      expect(out).not.toContain('PRD_STATE');
      expect(out).toContain('正在分析');
    });

    it('leaves text without a block unchanged', () => {
      expect(stripPrdState('普通回复')).toBe('普通回复');
    });
  });

  describe('validatePrdState', () => {
    it('rejects wrong version', () => {
      expect(validatePrdState(makeState({ version: '2.0' }))).toBeNull();
    });

    it('rejects dimension count != 7', () => {
      const s = makeState();
      s.dimensions.pop();
      expect(validatePrdState(s)).toBeNull();
    });

    it('rejects an invalid status', () => {
      const s = makeState();
      // @ts-expect-error intentionally invalid
      s.dimensions[0].status = 'done';
      expect(validatePrdState(s)).toBeNull();
    });

    it('coerces missing highlights to empty strings', () => {
      const s = makeState();
      // @ts-expect-error drop a highlight
      delete s.highlights.users;
      const valid = validatePrdState(s);
      expect(valid?.highlights.users).toBe('');
    });
  });

  describe('computePercent / isComplete', () => {
    it('computes 2/7 => 29', () => {
      expect(computePercent(makeState().dimensions)).toBe(29);
    });

    it('is not complete when any dimension is unfinished', () => {
      expect(isComplete(makeState())).toBe(false);
    });

    it('is complete and 100% when all dimensions complete', () => {
      const s = makeState();
      s.dimensions.forEach((d) => (d.status = 'complete'));
      expect(computePercent(s.dimensions)).toBe(100);
      expect(isComplete(s)).toBe(true);
    });
  });

  it('exposes the 7 dimensions in canonical order', () => {
    expect(PRD_DIMENSION_ORDER).toEqual([
      'background',
      'users',
      'scenarios',
      'features',
      'flow',
      'acceptance',
      'nongoals',
    ]);
  });
});
