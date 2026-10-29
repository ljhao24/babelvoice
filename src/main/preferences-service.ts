import type { UserPreferences } from '@shared/config-types.js';
import { isEngineId } from '@shared/engine-types.js';
import { log } from '@core/utils/logger.js';

export interface PreferencesServiceDeps {
  getPreferences: () => UserPreferences;
  /** Persist an edit (config-store). */
  setPreferences: (partial: Partial<UserPreferences>) => void;
  /** Engine switches are locked while this is true. */
  hasActiveSessions: () => boolean;
  registerHotkey: (accelerator: string) => Promise<boolean>;
  /** Wake every renderer so the UI mirrors the new values. */
  broadcastChanged: (prefs: UserPreferences) => void;
  micPassthrough: {
    setMicrophoneDeviceUid(uid: string | undefined): void;
    setDesired(desired: boolean): void;
  };
}

/**
 * The one mutation path for UserPreferences (IPC PreferencesSet). Runs the
 * checks in order — known engine, engine lock, then the hotkey — and
 * persists only after a changed hotkey is bound, so the stored combo is
 * always the one that fires. An edit is all-or-nothing: a failed check
 * rejects and nothing is persisted.
 */
export class PreferencesService {
  /** Serializes commits, so two can't interleave across `registerHotkey`. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PreferencesServiceDeps) {}

  get(): UserPreferences {
    return this.deps.getPreferences();
  }

  /** A user edit. Rejects without persisting anything if a check fails. */
  set(partial: Partial<UserPreferences>): Promise<UserPreferences> {
    return this.serialized(async () => {
      const next = await this.commit(partial);
      // Mic passthrough is preference-driven; the coordinator reconciles the
      // native state on each setter call. Update both knobs so a mic-device
      // change while passthrough is active re-binds to the new device.
      this.deps.micPassthrough.setMicrophoneDeviceUid(next.preferredMicrophoneUid);
      this.deps.micPassthrough.setDesired(next.micPassthroughWhenIdle);
      return next;
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Run the checks against the current preferences (throwing on the first
   * failure), then persist the edit and broadcast the result.
   */
  private async commit(
    partial: Partial<UserPreferences>
  ): Promise<UserPreferences> {
    const prev = this.deps.getPreferences();
    // Every check that can reject runs before the hotkey side effect, so a
    // rejected edit never leaves a new hotkey bound but unsaved.
    if (partial.engineId !== undefined && !isEngineId(partial.engineId)) {
      throw new Error(`Unknown engine ${String(partial.engineId)}`);
    }
    // Engine switch is forbidden while any DirectionSession is alive
    // (ADR-0002).
    if (
      partial.engineId &&
      partial.engineId !== prev.engineId &&
      this.deps.hasActiveSessions()
    ) {
      throw new Error(
        'engine_locked: cannot change engine while a translation session is active'
      );
    }
    // A changed hotkey must be (re)registered natively, or the UI shows a
    // combo that doesn't fire. While the capture modal holds the hotkey
    // suspended this only probes availability; hotkey-manager binds it on
    // resume.
    if (partial.hotkey !== undefined && partial.hotkey !== prev.hotkey) {
      const ok = await this.deps.registerHotkey(partial.hotkey);
      if (!ok) {
        const restored = await this.deps.registerHotkey(prev.hotkey);
        if (!restored) {
          log.warn(`Failed to restore previous hotkey ${prev.hotkey}`);
        }
        throw new Error(`Hotkey ${String(partial.hotkey)} unavailable`);
      }
    }
    this.deps.setPreferences(partial);
    const next = this.deps.getPreferences();
    this.deps.broadcastChanged(next);
    return next;
  }
}
