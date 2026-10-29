import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedCommit } from './debounced-commit.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncedCommit', () => {
  it('commits only the last value after a quiet period', () => {
    const commit = vi.fn();
    const d = createDebouncedCommit<number>(commit, 150);
    d.push(10);
    vi.advanceTimersByTime(100);
    d.push(20);
    vi.advanceTimersByTime(100);
    d.push(30);
    expect(commit).not.toHaveBeenCalled();
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(150);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(30);
    expect(d.pending()).toBe(false);
  });

  it('flush commits immediately and cancels the timer', () => {
    const commit = vi.fn();
    const d = createDebouncedCommit<number>(commit, 150);
    d.push(42);
    d.flush();
    expect(commit).toHaveBeenCalledWith(42);
    vi.advanceTimersByTime(500);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('flush without a pending value is a no-op', () => {
    const commit = vi.fn();
    const d = createDebouncedCommit<number>(commit, 150);
    d.flush();
    d.push(1);
    vi.advanceTimersByTime(150);
    d.flush();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
