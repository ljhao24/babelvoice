import type { Direction } from './ipc-types.js';

export type MeetingEndedBy =
  | 'manual'
  | 'idle-timeout'
  | 'app-quit'
  | 'crashed';

export interface Meeting {
  id: string;
  userId: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  endedBy: MeetingEndedBy | null;
  engineId: string;
  langSrc: string;
  langTgt: string;
  updatedAt: number;
  deletedAt: number | null;
}

export interface MeetingTranscriptLine {
  id: string;
  meetingId: string;
  direction: Direction;
  src: string;
  tgt: string;
  at: number;
  sessionSeq: number;
  /** Who said it (1, 2, …), when the engine told speakers apart. */
  speaker?: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface MeetingSummary extends Meeting {
  lineCount: number;
  lastActivityAt: number;
}

export interface OpenMeetingResult {
  meeting: Meeting;
  /** True if a previously crashed meeting was found and silently closed during this open. */
  recovered?: boolean;
}

export interface AppendLinePayload {
  /** UUID generated in renderer; main trusts it. */
  id: string;
  /**
   * Meeting the line belongs to. The renderer flushes its last stitched
   * sentence *after* main has already ended the meeting, so main can't rely
   * on "the current meeting". Omitted → current meeting.
   */
  meetingId?: string;
  direction: Direction;
  src: string;
  tgt: string;
  at: number;
  sessionSeq: number;
  speaker?: number;
}

/**
 * Meetings with fewer lines than this are left out of the list by default:
 * a mis-click or a quick test, not a conversation worth keeping in view.
 */
export const MIN_LISTED_LINE_COUNT = 3;

export interface ListMeetingsFilter {
  /** When true, include meetings under `MIN_LISTED_LINE_COUNT` lines. Default false. */
  includeEmpty?: boolean;
  /** Substring match on title (case-insensitive). */
  query?: string;
  /** Hard cap on rows. */
  limit?: number;
}

export interface LoadMeetingResult {
  meeting: Meeting;
  lines: MeetingTranscriptLine[];
}

export const MEETING_IPC = {
  Open: 'meetings:open',
  End: 'meetings:end',
  AppendLine: 'meetings:append-line',
  List: 'meetings:list',
  Load: 'meetings:load',
  Rename: 'meetings:rename',
  SoftDelete: 'meetings:soft-delete',
  Current: 'meetings:current',
  AutoEnded: 'meetings:auto-ended'
} as const;
