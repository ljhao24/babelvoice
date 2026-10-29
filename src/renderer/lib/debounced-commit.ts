/**
 * Trailing-edge debounce for "persist this value" calls, with an explicit
 * `flush` for gesture ends (pointerup / blur / unmount). Kept framework-free
 * so the timing rules are unit-testable; `useDraftValue` wraps it for React.
 */
export interface DebouncedCommit<T> {
  /** Record the latest value; commits after `delayMs` of quiet. */
  push: (value: T) => void;
  /** Commit the pending value now (no-op when nothing is pending). */
  flush: () => void;
  /** True while a value is waiting to be committed. */
  pending: () => boolean;
}

export const createDebouncedCommit = <T>(
  commit: (value: T) => void,
  delayMs: number
): DebouncedCommit<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hasPending = false;
  let latest: T | undefined;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!hasPending) return;
    hasPending = false;
    commit(latest as T);
  };

  return {
    push: (value) => {
      latest = value;
      hasPending = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    flush,
    pending: () => hasPending
  };
};
