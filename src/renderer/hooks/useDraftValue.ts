import { useEffect, useRef, useState } from 'react';
import { createDebouncedCommit } from '../lib/debounced-commit.js';

/**
 * Local draft for a control bound to a persisted preference (range sliders).
 * Every input updates the draft immediately so the control tracks the
 * pointer; the commit is debounced (`delayMs`) and flushed on gesture end via
 * `flush`. External changes to `value` (other window, cloud sync, the commit
 * echoing back) replace the draft only while no local edit is pending.
 */
export const useDraftValue = <T>(
  value: T,
  commit: (next: T) => void,
  delayMs = 150
): { draft: T; change: (next: T) => void; flush: () => void } => {
  const [draft, setDraft] = useState(value);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const [debounced] = useState(() =>
    createDebouncedCommit<T>((v) => commitRef.current(v), delayMs)
  );

  useEffect(() => {
    if (!debounced.pending()) setDraft(value);
  }, [value, debounced]);

  // Closing Settings mid-drag still saves the last position.
  useEffect(() => () => debounced.flush(), [debounced]);

  return {
    draft,
    change: (next) => {
      setDraft(next);
      debounced.push(next);
    },
    flush: debounced.flush
  };
};
