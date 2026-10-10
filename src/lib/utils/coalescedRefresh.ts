/**
 * Group a burst of database events into one refresh. Events received while a
 * refresh is running trigger one follow-up, so the final change is not lost.
 * This deliberately does not cache data or delay explicit user actions.
 */
export function createCoalescedRefresh(
  refresh: () => Promise<void>,
  delayMs = 100,
  onError: (error: unknown) => void = console.error
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let disposed = false;

  const run = async () => {
    timer = undefined;
    if (disposed) return;
    pending = false;
    running = true;
    try {
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (pending && !disposed) schedule();
    }
  };

  const schedule = () => {
    if (disposed) return;
    pending = true;
    // Keep the first timer instead of resetting it on every event. Continuous
    // traffic must not postpone a refresh indefinitely.
    if (!running && timer === undefined) timer = setTimeout(run, delayMs);
  };

  return {
    schedule,
    dispose: () => {
      disposed = true;
      pending = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
