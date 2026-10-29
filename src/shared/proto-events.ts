/**
 * Mirror of `data.speech.event.Type` from `protos/common/events.proto`.
 * Keep this file dependency-free; both main and renderer (for debugging)
 * may import it.
 */
export const ProtoEvent = {
  None: 0,

  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,

  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,

  UsageResponse: 154,

  TaskRequest: 200,
  UpdateConfig: 201,
  AudioMuted: 250,

  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,

  SourceSubtitleStart: 650,
  SourceSubtitleResponse: 651,
  SourceSubtitleEnd: 652,
  TranslationSubtitleStart: 653,
  TranslationSubtitleResponse: 654,
  TranslationSubtitleEnd: 655
} as const;

export type ProtoEventValue = (typeof ProtoEvent)[keyof typeof ProtoEvent];
