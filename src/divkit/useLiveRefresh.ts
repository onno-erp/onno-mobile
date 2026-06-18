// A data-driven custom (onno-list, onno-widget) fetches its own rows on mount and so
// misses live changes — reloading the content card doesn't remount it. This hook wires
// it to the SSE fan-out: when an event touches its entity, it re-runs `refresh` (debounced,
// to coalesce the burst a single write emits — e.g. posted + register changed).

import { useEffect, useRef } from 'react';
import { eventMatchesEntity, onUiEvent } from '../api/events';

export function useLiveRefresh(kind: string, name: string, refresh: () => void): void {
  // Hold the latest `refresh` in a ref so the subscription survives re-renders without
  // re-subscribing every time the callback identity changes (it usually does).
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!name) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onUiEvent((event) => {
      if (!eventMatchesEntity(event, kind, name)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refreshRef.current(), 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [kind, name]);
}
