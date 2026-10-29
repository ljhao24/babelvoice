import { log } from '@core/utils/logger.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let onTimeoutFn: (() => void) | null = null;

export const setIdleTimeoutHandler = (fn: () => void): void => {
  onTimeoutFn = fn;
};

export const resetIdleTimer = (): void => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    log.info('meeting idle timeout fired');
    onTimeoutFn?.();
  }, IDLE_TIMEOUT_MS);
};

export const stopIdleTimer = (): void => {
  if (timer) clearTimeout(timer);
  timer = null;
};
