# Translation session orchestration: DirectionSession in main

The lifecycle of a translation session was smeared across `ipc-handlers.ts`,
`useSpeakSession.ts`, and `useListenSession.ts` — three shallow modules each
holding part of the state machine, with cross-process races (e.g. cancelling
during `connecting`) leaking into renderer hooks. We are consolidating it
behind a `DirectionSession` module that lives in the main process and is
held by a `SessionRegistry`.

## Decisions

- **Process placement: main.** The state machine, the `DoubaoClient`, and
  the native bridge resources all live in main. Renderer hooks become thin
  command/event adapters. This kills the `stopRequested` cross-process
  race entirely; cancel during `connecting` becomes a local checkpoint
  inside `DirectionSession.open()`.
- **Single capture seam: native only.** The browser-microphone path
  (`useRendererMicrophone`, `audio-capture.ts`, `StreamingPcmPlayer`,
  `IPC.TranslationSendAudio`) is being removed. To preserve the "pick a
  specific input device" UX, the native bridge accepts a device UID
  (Slice 0). This eliminates a cross-process PCM pump and a fork in
  `useSpeakSession`.
- **Status as a first-class signal.** `DirectionSession.status` is
  authoritative in main and broadcast as `IPC.TranslationStatus`. The
  renderer store mirrors it instead of inferring `connecting` / `finishing`
  from `session-started` / `session-finished` events.
- **No premature seams.** `TtsSink` (candidate #5) and `PcmSource`
  (candidate #3) stay deferred — `DirectionSession` calls
  `platformNativeBridge` directly. Each is worth its own focused refactor;
  bundling them inflates blast radius. _Superseded — see Update below._

## Considered and rejected

- **Split state machine across main + renderer.** Today's shape. Rejected
  because every cross-process race so far (recent `stopRequested` fix; TTS
  failure not tearing down capture) traces to ownership being unclear.
- **Renderer-owned session.** Would require running the WebSocket client in
  the renderer and re-routing native bridge access through IPC. The native
  bridge owns OS-global state (TTS unit, mic queue, system audio) and lives
  in main, so this would invert the dependency. Rejected.

## Consequences

- `IPC.TranslationSendAudio` is deleted; renderer no longer pushes PCM.
- `audio-capture.ts`, `audio-player.ts`, `virtual-device.ts` are deleted.
- The "pick microphone" UI must source devices from
  `platformNativeBridge.listAudioDevices()` (UID-based) rather than
  `navigator.mediaDevices.enumerateDevices()` (Chromium hash-based).
- Unit-testing target: the `DirectionSession` state machine, with a fake
  `DoubaoClient` and a fake `NativeBridge`.

## Update — seams landed

The "no premature seams" stance held only for the duration of the main
DirectionSession move. Once that landed and was stable, each deferred
candidate was taken on its own with no observable regressions:

- **`PcmSource`** — `MicrophonePcmSource` (with a CoreAudio device UID) and
  `SystemAudioPcmSource` chosen by a factory; collapsed three
  `direction === 'speak'` branches in `open` / `finish` / `tearDown`.
- **`TtsSink`** — `NativeTtsSink` (speak) and `NoopTtsSink` (listen)
  chosen by a factory; collapsed three more branches and removed
  `DirectionSession`'s last `platformNativeBridge` import.
- **Doubao codec/transport split** — wire-format encode/decode moved to
  `doubao-codec.ts` (pure functions); `DoubaoClient` is now transport +
  lifecycle dispatch only. The codec is the test surface for the wire
  format.
- **`useDirectionSession`** — the renderer's speak/listen hooks are now
  one factory parameterized by `buildStartParams`.
- **`SubtitleOverlayCoordinator`** — the "subtitle renderer mounted"
  handshake moved off `window-manager` module-level state into a class
  with `reset` / `markReady` / `awaitReady` / `abandon`.

`DirectionSession` no longer references `platformNativeBridge` at all —
its native side is fully channelled through `PcmSource`, `TtsSink`, and
the overlay coordinator.
