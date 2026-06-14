import { useEffect, useMemo } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import type { TMessage } from 'librechat-data-provider';
import { extractPrdState, type PrdState } from '~/utils/prdState';
import store from '~/store';

/**
 * Configured PRD agent id. Set `VITE_PRD_AGENT_ID` at build time to the id of
 * the agent created via Agent Builder (see docs/prd/agent/SETUP.md). When unset,
 * the dashboard never activates, so this feature is inert on stock deployments.
 */
const PRD_AGENT_ID = (import.meta.env?.VITE_PRD_AGENT_ID as string | undefined) ?? '';

/** Flatten a message tree (depth-first) into an ordered array. */
function flatten(nodes: TMessage[] | null): TMessage[] {
  if (!nodes || nodes.length === 0) {
    return [];
  }
  const out: TMessage[] = [];
  const walk = (list: TMessage[]) => {
    for (const n of list) {
      out.push(n);
      const children = (n as TMessage & { children?: TMessage[] }).children;
      if (children && children.length) {
        walk(children);
      }
    }
  };
  walk(nodes);
  return out;
}

/**
 * Reads the active conversation's agent and message tree, determines whether
 * the PRD dashboard should be visible, extracts the latest PRD_STATE, and
 * writes both into the store for the panel to consume.
 *
 * Returns the current PRD state (or null) for convenience.
 */
export default function usePrdDashboard(
  index: number,
  messagesTree: TMessage[] | null,
): PrdState | null {
  const agentId = useRecoilValue(store.conversationAgentIdByIndex(index));
  const setVisible = useSetRecoilState(store.prdDashboardVisible);
  const setState = useSetRecoilState(store.prdDashboardState);

  const isPrdAgent = !!PRD_AGENT_ID && agentId === PRD_AGENT_ID;

  /** Latest PRD state found by scanning messages newest-first. */
  const latest = useMemo<PrdState | null>(() => {
    if (!isPrdAgent) {
      return null;
    }
    const flat = flatten(messagesTree);
    for (let i = flat.length - 1; i >= 0; i--) {
      const msg = flat[i];
      if (msg.isCreatedByUser) {
        continue;
      }
      const text = typeof msg.text === 'string' ? msg.text : '';
      const parsed = extractPrdState(text);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }, [isPrdAgent, messagesTree]);

  useEffect(() => {
    setVisible(isPrdAgent);
  }, [isPrdAgent, setVisible]);

  useEffect(() => {
    // Keep the last known state while streaming produces an unparseable block:
    // only overwrite when we have a fresh valid parse.
    if (latest) {
      setState(latest);
    } else if (!isPrdAgent) {
      setState(null);
    }
  }, [latest, isPrdAgent, setState]);

  return latest;
}
