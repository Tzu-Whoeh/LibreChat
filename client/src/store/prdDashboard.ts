import { atom } from 'recoil';
import type { PrdState } from '~/utils/prdState';

/**
 * Latest PRD dashboard state parsed from the most recent assistant message
 * that carried a PRD_STATE block. Null when no PRD state is available yet.
 *
 * Populated by `usePrdDashboard`; consumed by the `PrdDashboard` panel.
 */
export const prdDashboardState = atom<PrdState | null>({
  key: 'prdDashboardState',
  default: null,
});

/**
 * Whether the PRD dashboard panel should be shown. Driven by whether the
 * active conversation is bound to the configured PRD agent.
 */
export const prdDashboardVisible = atom<boolean>({
  key: 'prdDashboardVisible',
  default: false,
});
