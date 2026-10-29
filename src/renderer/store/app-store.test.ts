import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationEvent } from '@shared/ipc-types.js';
import type { Meeting } from '@shared/meeting-types.js';
import { EMPTY_CREDENTIAL_STATUS } from '@shared/engine-types.js';
import {
  MAX_STITCH_CHARS,
  MAX_STITCH_MS,
  enableMeetingPersistence,
  setDirectionTransient,
  setHistoryLimit,
  useAppStore
} from './app-store.js';

const appendMeetingLine = vi.fn(async (_line: unknown) => undefined);

const ev = (e: Record<string, unknown>): TranslationEvent =>
  ({ direction: 'listen', ...e }) as unknown as TranslationEvent;

const meeting = (id: string): Meeting =>
  ({ id, title: id, startedAt: 0 }) as unknown as Meeting;

beforeEach(() => {
  // Every piece of transcript state lives in the store, so replacing it with
  // the initial state isolates each test — no module reload needed.
  useAppStore.setState(useAppStore.getInitialState(), true);
  appendMeetingLine.mockClear();
  (globalThis as Record<string, unknown>).window = {
    babelVoiceBridge: { appendMeetingLine }
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('app-store transcript assembly', () => {
  it('pairs finals FIFO when one side runs ahead', () => {
    const push = useAppStore.getState().pushEvent;
    push(ev({ type: 'source-subtitle-final', text: 'One.' }));
    push(ev({ type: 'source-subtitle-final', text: 'Two.' }));
    push(ev({ type: 'translation-subtitle-final', text: '一。' }));
    push(ev({ type: 'translation-subtitle-final', text: '二。' }));

    const pairs = useAppStore.getState().history.map((p) => [p.src, p.tgt]);
    expect(pairs).toEqual([
      ['One.', '一。'],
      ['Two.', '二。']
    ]);
  });

  it('settles a cancelled session so its text is kept and not glued onto the next', () => {
    enableMeetingPersistence();
    const st = useAppStore.getState();
    st.setCurrentMeeting(meeting('m1'));
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'half a' }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '半句' }));
    st.pushEvent(ev({ type: 'source-subtitle-delta', text: 'sente' }));

    // Cancel: no session-finished event ever arrives, only the status.
    st.setSessionStatus('listen', 'cancelling');
    st.setSessionStatus('listen', 'idle');

    const after = useAppStore.getState();
    expect(after.history.map((p) => p.src)).toEqual(['half a']);
    expect(after.listen.partialSrc).toBe('');
    expect(after.listen.stitchedSrc).toBe('');
    expect(appendMeetingLine).toHaveBeenCalledTimes(1);

    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'Fresh.' }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '新的。' }));
    expect(useAppStore.getState().history.at(-1)?.src).toBe('Fresh.');
  });

  it('persists the in-progress sentence into the meeting that just ended', () => {
    enableMeetingPersistence();
    const st = useAppStore.getState();
    st.setCurrentMeeting(meeting('m1'));
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'no full stop' }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '没有句号' }));

    st.setCurrentMeeting(null);

    expect(appendMeetingLine).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'm1', src: 'no full stop' })
    );
    expect(useAppStore.getState().history).toEqual([]);
  });

  it('caps history at the configured limit', () => {
    setHistoryLimit(3);
    const push = useAppStore.getState().pushEvent;
    for (let i = 0; i < 5; i++) {
      push(ev({ type: 'source-subtitle-final', text: `S${i}.` }));
      push(ev({ type: 'translation-subtitle-final', text: `T${i}.` }));
    }
    expect(useAppStore.getState().history.map((p) => p.src)).toEqual([
      'S2.',
      'S3.',
      'S4.'
    ]);
  });

  it('stitches unpunctuated CJK fragments into one sentence', () => {
    const push = useAppStore.getState().pushEvent;
    push(ev({ type: 'source-subtitle-final', text: '我们今天' }));
    push(ev({ type: 'translation-subtitle-final', text: 'Today we' }));
    expect(useAppStore.getState().listen.stitchedSrc).toBe('我们今天');
    push(ev({ type: 'source-subtitle-final', text: '讨论预算。' }));
    push(ev({ type: 'translation-subtitle-final', text: 'discuss the budget.' }));
    expect(useAppStore.getState().history.map((p) => [p.src, p.tgt])).toEqual([
      ['我们今天讨论预算。', 'Today we discuss the budget.']
    ]);
  });

  it('shows an unpaired final as the live partial until its partner lands', () => {
    const push = useAppStore.getState().pushEvent;
    push(ev({ type: 'source-subtitle-delta', text: 'Hel' }));
    push(ev({ type: 'source-subtitle-final', text: 'Hello' }));
    expect(useAppStore.getState().listen).toMatchObject({
      partialSrc: 'Hello',
      stitchedSrc: ''
    });

    push(ev({ type: 'translation-subtitle-delta', text: '你' }));
    push(ev({ type: 'translation-subtitle-final', text: '你好' }));
    expect(useAppStore.getState().listen).toMatchObject({
      partialSrc: '',
      partialTgt: '',
      stitchedSrc: 'Hello',
      stitchedTgt: '你好'
    });
  });

  it('flushes an unpunctuated sentence once it exceeds the length cap', () => {
    const push = useAppStore.getState().pushEvent;
    const chunk = 'word '.repeat(10).trim();
    let fragments = 0;
    while (useAppStore.getState().history.length === 0) {
      push(ev({ type: 'source-subtitle-final', text: chunk }));
      push(ev({ type: 'translation-subtitle-final', text: chunk }));
      fragments += 1;
      expect(fragments).toBeLessThan(100);
    }
    const [line] = useAppStore.getState().history;
    expect(line.src.length).toBeGreaterThanOrEqual(MAX_STITCH_CHARS);
    expect(line.src.length).toBeLessThan(MAX_STITCH_CHARS + chunk.length + 1);
    expect(useAppStore.getState().listen.stitchedSrc).toBe('');
  });

  it('flushes an unpunctuated sentence once it has been open past the time cap', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const push = useAppStore.getState().pushEvent;
    push(ev({ type: 'source-subtitle-final', text: 'no punctuation here' }));
    push(ev({ type: 'translation-subtitle-final', text: '这里没有标点' }));
    expect(useAppStore.getState().history).toHaveLength(0);

    now.mockReturnValue(1_000 + MAX_STITCH_MS);
    push(ev({ type: 'source-subtitle-final', text: 'still going' }));
    push(ev({ type: 'translation-subtitle-final', text: '还在继续' }));
    expect(useAppStore.getState().history.map((p) => p.src)).toEqual([
      'no punctuation here still going'
    ]);
  });

  it('re-hydrating the same meeting keeps the in-flight sentence and pairing', () => {
    enableMeetingPersistence();
    const st = useAppStore.getState();
    st.setCurrentMeeting(meeting('m1'));
    st.pushEvent(ev({ type: 'session-started' }));
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'first half' }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '前半句' }));
    // One side ran ahead: this final is waiting for its partner.
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'and the rest.' }));

    // Control page remounts → getCurrentMeeting → same meeting again.
    st.setCurrentMeeting({ ...meeting('m1'), title: 'renamed' });
    expect(useAppStore.getState().currentMeeting?.title).toBe('renamed');
    expect(useAppStore.getState().listen.stitchedSrc).toBe('first half');

    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '和后半句。' }));
    const [line] = useAppStore.getState().history;
    expect([line.src, line.tgt]).toEqual(['first half and the rest.', '前半句和后半句。']);
    expect(line.sessionSeq).toBe(1);
  });

  it('opening a different meeting resets in-flight state', () => {
    const st = useAppStore.getState();
    st.setCurrentMeeting(meeting('m1'));
    st.pushEvent(ev({ type: 'session-started' }));
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'stale' }));
    st.setCurrentMeeting(meeting('m2'));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '新的。' }));
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'Fresh.' }));
    const history = useAppStore.getState().history;
    expect(history.map((p) => [p.src, p.tgt])).toEqual([['Fresh.', '新的。']]);
    // The session counter restarts with the meeting.
    expect(history[0].sessionSeq).toBe(0);
  });

  it('numbers lines by the session that produced them', () => {
    const st = useAppStore.getState();
    st.setCurrentMeeting(meeting('m1'));
    for (const text of ['A.', 'B.']) {
      st.pushEvent(ev({ type: 'session-started' }));
      st.pushEvent(ev({ type: 'source-subtitle-final', text }));
      st.pushEvent(ev({ type: 'translation-subtitle-final', text }));
      st.pushEvent(ev({ type: 'session-finished' }));
    }
    expect(useAppStore.getState().history.map((p) => p.sessionSeq)).toEqual([1, 2]);
  });

  it('clearing an already-cleared meeting is a no-op', () => {
    enableMeetingPersistence();
    const listener = vi.fn();
    useAppStore.subscribe(listener);
    useAppStore.getState().setCurrentMeeting(null);
    expect(listener).not.toHaveBeenCalled();
    expect(appendMeetingLine).not.toHaveBeenCalled();
  });

  it('keeps a transient (probe) session out of history and the DB until it settles', () => {
    enableMeetingPersistence();
    const st = useAppStore.getState();
    st.setCurrentMeeting(meeting('m1'));

    setDirectionTransient('listen', true);
    st.setSessionStatus('listen', 'connecting');
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'Probe line.' }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '探针。' }));
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'tail' }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '尾巴' }));
    // The probe's text still renders live.
    expect(useAppStore.getState().listen.stitchedSrc).toBe('tail');
    st.setSessionStatus('listen', 'idle');
    expect(useAppStore.getState().history).toHaveLength(0);
    expect(appendMeetingLine).not.toHaveBeenCalled();

    // The flag cleared itself at idle: the next real session is recorded.
    st.setSessionStatus('listen', 'connecting');
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'Real.' }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '真的。' }));
    expect(useAppStore.getState().history.map((p) => p.src)).toEqual(['Real.']);
    expect(appendMeetingLine).toHaveBeenCalledTimes(1);
  });

  it('keeps the probe flag through session-finished until the direction idles', () => {
    setDirectionTransient('listen', true);
    const st = useAppStore.getState();
    st.setSessionStatus('listen', 'connecting');
    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'probe' }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '探针' }));
    st.pushEvent(ev({ type: 'session-finished' }));
    expect(useAppStore.getState().transcript.listen.transient).toBe(true);
    st.setSessionStatus('listen', 'idle');
    expect(useAppStore.getState().transcript.listen.transient).toBe(false);
    expect(useAppStore.getState().history).toHaveLength(0);
  });

  it('only marks the probe direction transient', () => {
    setDirectionTransient('speak', true);
    const push = useAppStore.getState().pushEvent;
    push(ev({ type: 'source-subtitle-final', text: 'Other side.' }));
    push(ev({ type: 'translation-subtitle-final', text: '对方。' }));
    expect(useAppStore.getState().history.map((p) => p.src)).toEqual(['Other side.']);
  });

  it('does not persist lines unless the window enabled persistence', () => {
    const push = useAppStore.getState().pushEvent;
    push(ev({ type: 'source-subtitle-final', text: 'Overlay only.' }));
    push(ev({ type: 'translation-subtitle-final', text: '仅浮窗。' }));
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(appendMeetingLine).not.toHaveBeenCalled();
  });

  it('persists a line only after the state it belongs to has landed', () => {
    enableMeetingPersistence();
    const seen: string[][] = [];
    appendMeetingLine.mockImplementation(async () => {
      seen.push(useAppStore.getState().history.map((p) => p.src));
      return undefined;
    });
    useAppStore.getState().setCurrentMeeting(meeting('m1'));
    const push = useAppStore.getState().pushEvent;
    push(ev({ type: 'source-subtitle-final', text: 'Landed.' }));
    push(ev({ type: 'translation-subtitle-final', text: '已落地。' }));
    expect(seen).toEqual([['Landed.']]);
    expect(appendMeetingLine).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'm1', src: 'Landed.', tgt: '已落地。' })
    );
  });

  it('swallows appendMeetingLine failures instead of leaking a rejection', async () => {
    enableMeetingPersistence();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    appendMeetingLine.mockRejectedValueOnce(new Error('ipc down'));
    const push = useAppStore.getState().pushEvent;
    push(ev({ type: 'source-subtitle-final', text: 'Saved?' }));
    push(ev({ type: 'translation-subtitle-final', text: '保存了吗？' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(useAppStore.getState().history).toHaveLength(1);
    expect(error).toHaveBeenCalled();
  });

  it('does not notify subscribers for events the UI never renders', () => {
    const listener = vi.fn();
    useAppStore.subscribe(listener);
    useAppStore
      .getState()
      .pushEvent(ev({ type: 'tts-audio', data: new ArrayBuffer(8) }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('tracks the live speaker and persists it with the sentence', () => {
    enableMeetingPersistence();
    const st = useAppStore.getState();
    st.setCurrentMeeting(meeting('m1'));
    st.pushEvent(ev({ type: 'source-subtitle-start', startMs: 0, speakerChanged: false, speaker: 2 }));
    expect(useAppStore.getState().listen.speaker).toBe(2);

    const listener = vi.fn();
    const unsubscribe = useAppStore.subscribe(listener);
    // Same speaker again: nothing for the UI to redraw.
    st.pushEvent(ev({ type: 'source-subtitle-start', startMs: 0, speakerChanged: false, speaker: 2 }));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();

    st.pushEvent(ev({ type: 'source-subtitle-final', text: 'Hi.', speaker: 2 }));
    st.pushEvent(ev({ type: 'translation-subtitle-final', text: '嗨。' }));
    expect(useAppStore.getState().history).toEqual([
      expect.objectContaining({ src: 'Hi.', tgt: '嗨。', speaker: 2 })
    ]);
    expect(appendMeetingLine).toHaveBeenCalledWith(
      expect.objectContaining({ meetingId: 'm1', src: 'Hi.', speaker: 2 })
    );
  });

  it('does not notify subscribers when the probe flag is already set that way', () => {
    const listener = vi.fn();
    useAppStore.subscribe(listener);
    setDirectionTransient('listen', false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('starts every test from a clean store', () => {
    const st = useAppStore.getState();
    expect(st.history).toEqual([]);
    expect(st.historyLimit).toBe(1000);
    expect(st.persistTranscript).toBe(false);
    expect(st.transcript.listen).toMatchObject({
      pendingSrc: [],
      pendingTgt: [],
      stitch: null,
      sessionSeq: 0,
      transient: false
    });
  });
});

describe('app-store IPC mirrors', () => {
  it('marks credential status loaded on the first answer', () => {
    expect(useAppStore.getState().credentialStatusLoaded).toBe(false);
    const status = {
      ...EMPTY_CREDENTIAL_STATUS,
      qwen: { configured: true, apiKeyTail: 'abcd' }
    };
    useAppStore.getState().applyCredentialStatus(status);
    expect(useAppStore.getState()).toMatchObject({
      credentialStatus: status,
      credentialStatusLoaded: true
    });
  });

  it('mirrors subtitle overlay visibility', () => {
    useAppStore.getState().applySubtitleOverlayVisible(true);
    expect(useAppStore.getState().subtitleOverlayVisible).toBe(true);
  });
});
