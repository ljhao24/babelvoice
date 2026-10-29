import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { ProtoEvent } from '@shared/proto-events.js';
import { getProtoTypes, type ProtoTypes } from './proto-loader.js';
import {
  decodeFrame,
  encodeStartSession,
  encodeTaskRequest,
  initDoubaoCodec
} from './doubao-codec.js';

let types: ProtoTypes;

const response = (msg: Record<string, unknown>): Uint8Array =>
  types.TranslateResponse.encode(msg).finish();

// decodeFrame reads fields straight off the decoded Message (no
// toObject per frame); these pin the mapping that used to rely on
// toObject({ defaults: true }).
describe('doubao-codec (sync, cached Types)', () => {
  beforeAll(async () => {
    await initDoubaoCodec();
    types = await getProtoTypes();
  });

  it('maps subtitle fields, with proto3 defaults for unset ones', () => {
    const final = decodeFrame(
      response({
        event: ProtoEvent.SourceSubtitleEnd,
        text: '你好',
        start_time: 120,
        end_time: 980
      })
    );
    expect(final).toMatchObject({
      event: ProtoEvent.SourceSubtitleEnd,
      statusCode: 0,
      message: '',
      isSuccessStatus: true,
      body: { type: 'source-subtitle-final', text: '你好', startMs: 120, endMs: 980 }
    });

    const start = decodeFrame(response({ event: ProtoEvent.TranslationSubtitleStart }));
    expect(start.body).toEqual({
      type: 'translation-subtitle-start',
      startMs: 0,
      speakerChanged: false
    });
  });

  it('copies TTS bytes into a standalone ArrayBuffer', () => {
    const frame = new Uint8Array(
      response({ event: ProtoEvent.TTSResponse, data: Buffer.from([9, 8, 7, 6]) })
    );
    const decoded = decodeFrame(frame);
    expect(decoded.body?.type).toBe('tts-audio');
    const data = (decoded.body as { data: ArrayBuffer }).data;
    expect([...new Uint8Array(data)]).toEqual([9, 8, 7, 6]);
    // Not a view into the frame: mutating the frame doesn't change it.
    frame.fill(0);
    expect([...new Uint8Array(data)]).toEqual([9, 8, 7, 6]);
  });

  it('reads status code/message and Billing (int64) on UsageResponse', () => {
    const failed = decodeFrame(
      response({
        event: ProtoEvent.SessionFailed,
        response_meta: { StatusCode: 45_000_002, Message: 'empty audio' }
      })
    );
    expect(failed).toMatchObject({
      statusCode: 45_000_002,
      message: 'empty audio',
      isSuccessStatus: false
    });

    const usage = decodeFrame(
      response({
        event: ProtoEvent.UsageResponse,
        response_meta: {
          StatusCode: 20_000_000,
          Billing: {
            Items: [
              { Unit: 'output_text_tokens', Quantity: 15 },
              { Unit: 'output_audio_tokens', Quantity: 11 },
              { Unit: 'input_audio_tokens', Quantity: 4 },
              { Unit: 'some_future_unit', Quantity: 7 }
            ],
            DurationMsec: 640
          }
        }
      })
    );
    expect(usage.isSuccessStatus).toBe(true);
    expect(usage.body).toEqual({
      type: 'usage',
      tokens: { outputText: 15, outputAudio: 11, inputAudio: 4 },
      durationMs: 640
    });
  });

  it('encodes requests synchronously (speech_rate is not on the wire)', () => {
    const start = types.TranslateRequest.decode(
      encodeStartSession(
        'sid',
        'cid',
        {
          engineId: 'doubao',
          sourceLanguage: 'zh',
          targetLanguage: 'en',
          mode: 's2s',
          speechRate: 20
        },
        { format: 'pcm', rate: 16_000 }
      )
    );
    const startObj = types.TranslateRequest.toObject(start) as {
      event: number;
      request: Record<string, unknown>;
    };
    expect(startObj.event).toBe(ProtoEvent.StartSession);
    expect(startObj.request).toEqual({
      mode: 's2s',
      source_language: 'zh',
      target_language: 'en'
    });

    const task = types.TranslateRequest.toObject(
      types.TranslateRequest.decode(encodeTaskRequest('sid', new Uint8Array([1, 2])))
    ) as { event: number; source_audio: { binary_data: Uint8Array } };
    expect(task.event).toBe(ProtoEvent.TaskRequest);
    expect([...task.source_audio.binary_data]).toEqual([1, 2]);
  });
});
