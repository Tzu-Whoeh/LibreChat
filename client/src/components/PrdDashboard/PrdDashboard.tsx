import { memo } from 'react';
import {
  PRD_DIMENSION_ORDER,
  computePercent,
  type PrdState,
  type PrdStatus,
} from '~/utils/prdState';

const STATUS_LABEL: Record<PrdStatus, string> = {
  complete: '完整',
  partial: '进行中',
  missing: '缺失',
};

/** Tailwind classes per status. Uses theme tokens so dark mode works. */
const STATUS_PILL: Record<PrdStatus, string> = {
  complete: 'bg-green-500/15 text-green-600 dark:text-green-400',
  partial: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  missing: 'bg-surface-tertiary text-text-secondary',
};

const STATUS_DOT: Record<PrdStatus, string> = {
  complete: 'bg-green-500',
  partial: 'bg-amber-500',
  missing: 'bg-text-tertiary/40',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-light bg-surface-primary p-4">
      <h3 className="mb-3 text-sm font-medium text-text-primary">{title}</h3>
      {children}
    </div>
  );
}

function PrdDashboard({ state }: { state: PrdState }) {
  const percent = computePercent(state.dimensions);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex items-baseline justify-between">
        <span className="truncate text-sm font-medium text-text-primary" title={state.title}>
          {state.title || 'PRD 草稿'}
        </span>
        <span className="text-xs text-text-tertiary">{state.slug}</span>
      </div>

      {/* Overall completeness */}
      <Section title="完整度">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-xs text-text-secondary">
            {state.dimensions.filter((d) => d.status === 'complete').length} / {state.dimensions.length} 维度完整
          </span>
          <span className="text-xl font-medium text-text-primary">{percent}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
          <div
            className="h-full rounded-full bg-green-500 transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </Section>

      {/* Coverage by dimension */}
      <Section title="覆盖情况">
        <ul className="flex flex-col gap-2">
          {PRD_DIMENSION_ORDER.map((key) => {
            const dim = state.dimensions.find((d) => d.key === key);
            if (!dim) {
              return null;
            }
            return (
              <li key={key} className="flex items-center gap-2 text-sm">
                <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[dim.status]}`} />
                <span className="flex-1 text-text-primary">{dim.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_PILL[dim.status]}`}>
                  {STATUS_LABEL[dim.status]}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      {/* PRD highlights */}
      <Section title="PRD 要点">
        <dl className="flex flex-col gap-2 text-xs leading-relaxed">
          {PRD_DIMENSION_ORDER.map((key) => {
            const dim = state.dimensions.find((d) => d.key === key);
            const text = state.highlights[key];
            if (!text) {
              return null;
            }
            return (
              <div key={key}>
                <dt className="inline font-medium text-text-primary">{dim?.label}：</dt>
                <dd className="inline text-text-secondary">{text}</dd>
              </div>
            );
          })}
          {PRD_DIMENSION_ORDER.every((k) => !state.highlights[k]) && (
            <span className="text-text-tertiary">尚未采集到要点，开始对话后会逐步填充。</span>
          )}
        </dl>
        {state.synced?.path && (
          <div className="mt-3 border-t border-border-light pt-2 text-xs text-text-tertiary">
            {state.synced.committed ? '已同步 ' : '待同步 '}
            {state.synced.path}
          </div>
        )}
      </Section>
    </div>
  );
}

export default memo(PrdDashboard);
