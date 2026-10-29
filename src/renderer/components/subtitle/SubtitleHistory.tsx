import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatPauseTime,
  historyGrade,
  type TimelineItem
} from '../../lib/subtitle-timeline.js';
import { SpeakerTag, namesSpeaker } from './SpeakerTag.js';

/** After the pointer leaves a scrolled-up list, return to the newest line. */
const RETURN_TO_LATEST_MS = 8_000;
/** Within this distance of the bottom counts as "at the newest line". */
const STICK_SLOP_PX = 24;

/**
 * Committed sentences, oldest first and newest just above the live area.
 * Lines grow fainter and smaller with age and the top edge fades, so a long
 * meeting reads as "recent, then context" rather than a flat wall. Follows
 * new lines while the user is at the bottom; once they scroll up to reread,
 * it stays put and counts what arrived below.
 *
 * Memoised on its items: it re-renders when a sentence is committed, not on
 * every live delta.
 */
export const SubtitleHistory = memo(function SubtitleHistory({
  items,
  fontSize,
  showSource,
  showSpeaker
}: {
  items: TimelineItem[];
  /** The live translation size; history sizes derive from it. */
  fontSize: number;
  showSource: boolean;
  /** Name the speaker at each run (the merged two-Direction timeline). */
  showSpeaker: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('subtitle');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const returnTimer = useRef<number | null>(null);
  const lines = items.filter((i) => i.kind === 'line');
  const newestId = lines.length > 0 ? lines[lines.length - 1].pair.id : null;
  /** Newest line the user has seen at the bottom; the rest are new. */
  const [seenId, setSeenId] = useState<string | null>(newestId);

  const seenIndex = seenId === null ? -1 : lines.findIndex((l) => l.pair.id === seenId);
  // A seen line trimmed off the top by the history limit: all are new.
  const unseen = stickRef.current ? 0 : lines.length - 1 - seenIndex;

  const scrollToLatest = (behavior: ScrollBehavior): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setSeenId(newestId);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setSeenId(newestId);
    }
  }, [newestId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (returnTimer.current !== null) window.clearTimeout(returnTimer.current);
    },
    []
  );

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP_PX;
    if (atBottom && !stickRef.current) setSeenId(newestId);
    stickRef.current = atBottom;
  };

  const cancelReturn = (): void => {
    if (returnTimer.current !== null) window.clearTimeout(returnTimer.current);
    returnTimer.current = null;
  };
  const scheduleReturn = (): void => {
    cancelReturn();
    if (stickRef.current) return;
    returnTimer.current = window.setTimeout(() => {
      returnTimer.current = null;
      scrollToLatest('smooth');
    }, RETURN_TO_LATEST_MS);
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onMouseEnter={cancelReturn}
      onMouseLeave={scheduleReturn}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="app-no-drag subtitle-history-scroll subtitle-history-fade flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {/* mt-auto bottom-aligns a short list without breaking scroll. */}
        <div className="mt-auto flex flex-col gap-2.5 pb-3 pt-6">
          {items.map((item) =>
            item.kind === 'pause' ? (
              <div key={item.id} className="subtitle-pause">
                {formatPauseTime(item.at)}
              </div>
            ) : (
              <HistoryLine
                key={item.pair.id}
                item={item}
                fontSize={fontSize}
                showSource={showSource}
                showSpeaker={showSpeaker}
              />
            )
          )}
        </div>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          className="subtitle-new-pill app-no-drag"
          onClick={() => scrollToLatest('smooth')}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden focusable="false">
            <path
              d="M6 2 V10 M2.5 6.5 L6 10 L9.5 6.5"
              stroke="currentColor"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {t('newLines', { count: unseen })}
        </button>
      )}
    </div>
  );
});

function HistoryLine({
  item,
  fontSize,
  showSource,
  showSpeaker
}: {
  item: Extract<TimelineItem, { kind: 'line' }>;
  fontSize: number;
  showSource: boolean;
  showSpeaker: boolean;
}): React.JSX.Element {
  const { pair } = item;
  const grade = historyGrade(item.age, fontSize);
  return (
    <div
      className="selectable subtitle-line"
      style={{ '--line-opacity': grade.opacity } as React.CSSProperties}
    >
      {item.groupStart && (showSpeaker || namesSpeaker(pair.direction, pair.speaker)) && (
        <div className="mb-0.5">
          <SpeakerTag direction={pair.direction} speaker={pair.speaker} />
        </div>
      )}
      {showSource && pair.src && (
        <div className="subtitle-text subtitle-line-src" style={{ fontSize: grade.sourceSize }}>
          {pair.src}
        </div>
      )}
      <div className="subtitle-text subtitle-line-tgt" style={{ fontSize: grade.fontSize }}>
        {pair.tgt}
      </div>
    </div>
  );
}
