'use client';

import { useCallback, useEffect, useRef } from 'react';
import { createCoalescedRefresh } from '@/lib/utils/coalescedRefresh';

/** Coalesce automatic refreshes; leave initial loads and manual refreshes immediate. */
export function useCoalescedRefresh(refresh: () => Promise<void>, delayMs = 100) {
  const refreshRef = useRef(refresh);
  const queueRef = useRef<ReturnType<typeof createCoalescedRefresh> | null>(null);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const queue = createCoalescedRefresh(() => refreshRef.current(), delayMs);
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, [delayMs]);

  return useCallback(() => queueRef.current?.schedule(), []);
}
