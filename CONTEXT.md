# BabelVoice / Translator Electron

Real-time meeting translation via Doubao: a user can run a **Speak** session
(their voice → translated TTS into the meeting via a virtual audio device) and
a **Listen** session (system audio → translated subtitles) concurrently.

## Language

**Direction**:
One of `speak` or `listen`. Names the role a translation session plays —
`speak` captures the user's microphone and emits TTS; `listen` captures system
audio and emits subtitles only.
_Avoid_: mode, channel, side.

**DirectionSession**:
The lifecycle of one translation session in one **Direction**. Owns the
**TranslationClient**, the audio capture, the TTS output (speak only), and a
status state machine. There is at most one DirectionSession per Direction at
a time. The state machine is engine-blind — it does not know which provider
runs underneath.
_Avoid_: client, pipeline, stream.

**TranslationClient**:
Provider-agnostic transport contract for one in-flight translation session.
Four methods (`start` / `sendAudio` / `finish` / `cancel`) plus a readonly
`engineId`; events delivered via a constructor-time `onEvent` callback.
Implementations: `DoubaoClient`, `QwenClient`, `GeminiClient`,
`OpenAiClient`, `MockTranslationClient`. A
**DirectionSession** owns one; the seam keeps the session state machine
decoupled from any one provider's wire format.
_Avoid_: provider, backend, engine.

**SessionRegistry**:
Main-process singleton that holds the current **DirectionSession** for each
**Direction**. The IPC layer is a thin adapter onto the registry.
_Avoid_: manager, controller.

**Status**:
Where a **DirectionSession** is in its lifecycle: `idle`, `connecting`,
`running`, `finishing`, `cancelling`, `failed`. Authoritative in the main
process; broadcast to renderers via `IPC.TranslationStatus`.
_Avoid_: state (too generic), phase.

**TranslationEvent**:
A protocol-shaped event surfaced by a **TranslationClient** — covers
`session-started`, `partial-text`, `final-text`, `tts-audio`,
`session-finished`, `session-failed`. Each provider's adapter maps its own
wire format into this common shape; clients emit undirected event bodies
and the **DirectionSession** tags them with `direction` before forwarding
to all renderers.
_Avoid_: message, frame, packet.

**Native bridge**:
The macOS-only N-API addon (`native/`, one file per subsystem; entry point
`native/macos_audio_bridge.mm`) plus its TypeScript adapter
(`platform-native-bridge.ts`). Owns: virtual-device TTS playback (AudioUnit +
ring buffer + feeder), microphone capture — one shared AudioQueue fanned out
to every consumer (a speak session's PCM, the idle mic → virtual-device
passthrough), resampled per consumer — system audio capture (ScreenCaptureKit,
Process Tap), subtitle window styling. The global hotkey is Electron's
`globalShortcut`, not the bridge. Holds **global** OS-level
state — not per-session.
_Avoid_: native module, audio engine.

**Meeting monitor**:
Main's per-meeting view of every translation session (`MeetingMonitor`):
each Direction's link health (handshake, ready, keepalive RTT, last data,
reconnects) and the usage each engine runs up, priced per engine
(`DEFAULT_PRICE_SHEETS`, overridable in Settings → 用量计费). Clients report
usage and link phases as out-of-band telemetry, never as TranslationEvents.
Totals are stored per meeting × engine × Direction (`meeting_usage`).
_Avoid_: billing, quota.

**Subtitle overlay**:
The frameless, click-through BrowserWindow that displays running subtitles.
Created lazily; readiness is announced from the renderer
(`IPC.SubtitleReady`) so the main process doesn't broadcast events into an
unmounted view. Its content is `SubtitlePanel` (also the Settings preview):
committed sentences as a fading, pause-divided history above a live caption
capped at `subtitleLiveLines`; two Directions either interleave on one
timeline or get a column each (`subtitleLayout`).
_Avoid_: subtitle window, HUD.

## Relationships

- A **DirectionSession** is owned by the **SessionRegistry** and identified
  by its **Direction**.
- A **DirectionSession** drives the **Native bridge** for capture and
  (speak-only) TTS playback, but does not own it — the bridge's resources
  are global and outlive any single session.
- The **TranslationClient** inside a **DirectionSession** emits
  **TranslationEvents**; the session reacts to lifecycle ones (transitions
  **Status**), tags them with its `direction`, and forwards every event to
  renderers.
- A **Speak** session and a **Listen** session can run concurrently; their
  **DirectionSessions** are independent because they touch disjoint native
  bridge resources (mic vs. system audio; TTS is speak-only).

## Example dialogue

> **Dev:** "If the user mashes the hotkey while the **Speak** session is
> still in `connecting`, what happens?"
> **Architect:** "The renderer sends `TranslationCancel` for that
> **Direction**. The **DirectionSession** is mid-`open()`; it sets
> **Status** to `cancelling` at its next checkpoint, tears down whatever it
> already prepared, and `open()` throws. The **SessionRegistry** removes it.
> No renderer-side `stopRequested` flag is needed."
