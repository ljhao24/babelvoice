/** What idle passthrough does once a bulk stop has released the mic. */
export type BulkStopPassthrough = 'resume' | 'halt';

/**
 * SessionOrchestrator's one seam onto idle mic passthrough. Only a speak
 * session plays TTS into the virtual output, so only speak goes through
 * here. Native already shares one mic capture between passthrough and the
 * session, so this is no longer a mic hand-over: it only keeps the raw
 * voice out of the virtual output while the session's TTS owns it.
 */
export interface MicArbiter {
  /** Stop teeing the raw mic into the virtual output before speak's TTS. */
  suspendForSession(): Promise<void>;
  /** No speak session holds the mic any more; passthrough may re-engage. */
  resumeAfterSession(): Promise<void>;
  /** A bulk stop released every native capture behind passthrough's back. */
  settleAfterBulkStop(passthrough: BulkStopPassthrough): Promise<void>;
}

/** The slice of MicPassthroughCoordinator the arbiter drives. */
interface PassthroughControls {
  suspend(): Promise<void>;
  resume(): Promise<void>;
  halt(): Promise<void>;
  forgetActiveState(): void;
}

export const createPassthroughMicArbiter = (
  passthrough: PassthroughControls
): MicArbiter => ({
  suspendForSession: () => passthrough.suspend(),
  resumeAfterSession: () => passthrough.resume(),
  settleAfterBulkStop: async (mode) => {
    // stopAllNativeAudioServices released the mic behind the coordinator's
    // back. Ending a meeting by hand returns to normal idle (passthrough on
    // if the user wants it); an idle timeout / quit keeps it off until the
    // user acts again.
    passthrough.forgetActiveState();
    if (mode === 'resume') {
      await passthrough.resume();
    } else {
      await passthrough.halt();
    }
  }
});
