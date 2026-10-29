import { describe, expect, it, vi } from 'vitest';
import { createPassthroughMicArbiter } from './mic-arbiter.js';

const makeCoordinator = (calls: string[]) => ({
  suspend: vi.fn(async () => {
    calls.push('suspend');
  }),
  resume: vi.fn(async () => {
    calls.push('resume');
  }),
  halt: vi.fn(async () => {
    calls.push('halt');
  }),
  forgetActiveState: vi.fn(() => {
    calls.push('forget');
  })
});

describe('createPassthroughMicArbiter', () => {
  it('hands the mic over and back with suspend / resume', async () => {
    const calls: string[] = [];
    const arbiter = createPassthroughMicArbiter(makeCoordinator(calls));
    await arbiter.suspendForSession();
    await arbiter.resumeAfterSession();
    expect(calls).toEqual(['suspend', 'resume']);
  });

  it('forgets the native state a bulk stop released before resuming or halting', async () => {
    const calls: string[] = [];
    const arbiter = createPassthroughMicArbiter(makeCoordinator(calls));
    await arbiter.settleAfterBulkStop('resume');
    await arbiter.settleAfterBulkStop('halt');
    expect(calls).toEqual(['forget', 'resume', 'forget', 'halt']);
  });
});
