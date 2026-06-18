// Top-level host for a DivKit card envelope (`{ templates, card }`). Resolves
// templates once, seeds the card's variables (plus any externally-injected ones
// like `active_path`), and renders the active state. Action dispatch, the API
// client, refresh, and image-origin come from the embedding app.

import React, { useMemo, useState } from 'react';
import type { OnnoClient } from '../api/onnoClient';
import { Div } from './Div';
import { applyTemplates } from './templates';
import type { DivCardEnvelope, DivHost, DivVariable } from './types';

export interface DivCardProps {
  envelope: DivCardEnvelope;
  fire: (url: string) => void;
  prefetch?: (url: string) => void;
  linkFor?: (url: string) => string | null;
  client: OnnoClient;
  refresh?: () => void;
  baseUrl?: string;
  theme?: 'light' | 'dark';
  lockScroll?: (locked: boolean) => void;
  /** Forwarded to the host so an embedded create form (reference picker) can report
   *  its saved row instead of navigating to its detail. */
  onCreated?: (row: Record<string, any>) => void;
  /** Variables injected by the app (e.g. `active_path` for nav highlight). */
  vars?: Record<string, unknown>;
  stateId?: number;
}

export function DivCard({
  envelope,
  fire,
  prefetch,
  linkFor,
  client,
  refresh,
  baseUrl,
  theme = 'light',
  lockScroll,
  onCreated,
  vars: externalVars,
  stateId,
}: DivCardProps) {
  const { card, templates = {} } = envelope;
  const [localVars, setLocalVars] = useState<Record<string, unknown>>(() => seedVars(card.variables));

  // External vars (active_path, …) overlay the card's own, and stay live.
  const vars = useMemo(() => ({ ...localVars, ...(externalVars ?? {}) }), [localVars, externalVars]);

  const host: DivHost = useMemo(
    () => ({
      fire,
      prefetch,
      linkFor,
      client,
      refresh: refresh ?? (() => {}),
      baseUrl,
      theme,
      lockScroll,
      onCreated,
      getVar: (name) => vars[name],
      setVar: (name, value) => setLocalVars((v) => ({ ...v, [name]: value })),
    }),
    [fire, prefetch, linkFor, client, refresh, baseUrl, theme, lockScroll, onCreated, vars],
  );

  const state = useMemo(() => {
    const states = card.states ?? [];
    const chosen = stateId != null ? states.find((s) => s.state_id === stateId) : states[0];
    return chosen ? applyTemplates(chosen.div, templates) : null;
  }, [card, templates, stateId]);

  // Stable ctx so the memoized Div can skip subtrees whose block + vars are
  // unchanged (e.g. while a large container reveals its children chunk by chunk).
  const ctx = useMemo(() => ({ vars, host }), [vars, host]);

  if (!state) return null;
  return <Div block={state} ctx={ctx} />;
}

function seedVars(vars?: DivVariable[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of vars ?? []) out[v.name] = v.value;
  return out;
}
