# Provider-agnostic translation client: TranslationClient seam, no orchestrator

The DirectionSession state machine is independent of which provider's
transport runs underneath; it should not need to grow knowledge of the
provider catalog as new providers (Qwen) land. We are introducing a
`TranslationClient` interface and a small `client-factory.ts`, and
deliberately **not** introducing the orchestrator pattern proposed in
`docs/qwen-provider-integration.md` (D4).

## Decisions

- **DirectionSession is engine-blind.** Its constructor takes a
  `TranslationClient` instance, not an `engineId`. The state machine
  (Status transitions, cancel-during-connect, TTS-failure-tears-down-
  capture) has no knowledge of which provider runs underneath.
- **`TranslationClient` interface.** Four methods plus a readonly
  `engineId`: `start(params) / sendAudio(pcm) / finish() / cancel()`.
  Events delivered via a constructor-time `onEvent(body)` callback;
  `TranslationClient` does not extend `EventEmitter`.
- **Direction lives at the session, not the transport.** The client
  emits undirected `TranslationEventBody`; `DirectionSession` adds
  `direction` before forwarding to its callbacks. Optional `tag: string`
  on the client constructor for log scoping.
- **Lifecycle invariants are part of the interface contract.**
  - `start()` resolves only after the provider is ready to receive audio
    (Doubao's SessionStarted gate, Qwen's `session.created` /
    `session.updated`).
  - `cancel()` is safe at any state, including mid-`start()`.
    Cancel-during-start MUST cause `start()` to reject.
  - `finish()` and `cancel()` are idempotent.
- **Each client self-imports its credentials.** `config-store.getCredentials()`
  is removed; `DoubaoClient` reads `DOUBAO_CREDENTIALS` from
  `doubao-credentials.ts` directly. Future `QwenClient` mirrors this with
  `qwen-credentials.ts`.
  - **Amendment (per-user keys):** the static `DOUBAO_CREDENTIALS` /
    `QWEN_CREDENTIALS` constants are gone. Credentials are now per-user:
    the user enters them in Settings → 翻译服务, and `credential-vault.ts`
    persists them encrypted-at-rest via Electron's `safeStorage`
    (Keychain on macOS) inside the existing `electron-store` JSON.
    Each client still self-imports its credentials at the top of
    `start()`; the import target moved from a const to
    `getDoubaoCredentials()` / `getQwenCredentials()`. If the vault
    returns `null`, `start()` throws `MissingCredentialsError` and the
    renderer surfaces a "前往设置填入 API 密钥" CTA. Plaintext credentials
    cross IPC only renderer→main on save (`credentials:set`), never
    main→renderer; reads return only a `CredentialStatus` (presence
    flags + last-4-char tail). The `*-credentials.ts` files now only
    export the plaintext shape (no constant) — credential types still
    never appear in `shared/`.
- **Provider selection lives in `client-factory.ts`.** A pure function
  `(engineId, { onEvent }) → TranslationClient`.
  `ipc-handlers.TranslationStart` calls it; nobody else needs to.
- **Engine-switch lock fires at `PreferencesSet`.** If the inbound
  `partial.engineId` would change the active engine and
  `sessionRegistry.size > 0`, reject with `engine_locked`. The renderer's
  dev-only engine selector disables itself by reading
  `speak.active || listen.active` from the existing store — no new IPC.
- **Mock provider lives main-side.** `MockTranslationClient` is a factory
  case alongside `'doubao'` and `'qwen'`. The renderer no longer carries
  a parallel mock path; `engines/factory.ts` collapses to a display-name
  catalog (or is folded into `engine-types.ts`).
- **`engineId` is main-authoritative.** `getActiveEngineId()` is the
  only place that resolves which engine is in effect; everywhere else
  in main calls it directly. Renderer reads of `prefs.engineId` are
  display-only — they MUST NOT flow back into IPC payloads or any
  decision logic. (Why this matters: a stale `prefs.engineId` in a
  packaged build silently diverged meeting metadata from runtime —
  see commit `d2734a3`.)
  - **Amendment (Qwen integration):** the original rule also said
    "production builds force `PRODUCTION_ENGINE`". That gate has been
    lifted now that Settings exposes a user-facing engine switcher
    (Doubao ↔ Qwen). `getActiveEngineId()` reads `prefs.engineId` in
    both dev and packaged builds; `PRODUCTION_ENGINE` survives only
    as the seed value for `DEFAULT_PREFERENCES.engineId`. The
    main-authoritative property still holds: `getActiveEngineId()`
    is still the single source of truth, and renderer reads remain
    display-only.

## Considered and rejected

- **Orchestrator singleton holding `Map<Direction, Client>` +
  `setEngineId` + lock** (`docs/qwen-provider-integration.md` D4).
  Rejected because:
  - It duplicates SessionRegistry's "track active sessions" job,
    introducing two sources of truth for the same fact.
  - The engine-switch lock has exactly one trigger site
    (`PreferencesSet`) and one condition (`sessionRegistry.size > 0`).
    Putting the rule in a separate module that `PreferencesSet` then
    forwards to is one extra hop with no extra leverage.
  - The factory + interface combo provides the same engine-routing
    capability with no shared mutable state.
- **DirectionSession parameterized on `engineId`**, with a factory it
  calls internally. Rejected because it pulls engine selection into the
  state machine's concerns; the state machine should be a Direction ×
  Lifecycle problem, not Direction × Lifecycle × Engine.
- **`TranslationClient extends EventEmitter`** (mirroring today's
  `DoubaoClient`). Rejected because it leaks
  `.emit / .removeAllListeners / .listenerCount` into the contract —
  caller-visible surface that no caller needs.
- **Constructor-injected `direction` on the client.** Rejected:
  `direction` is a session concern, not a transport concern. Replaced
  with an optional `tag: string` for log scoping.
- **`updateConfig(corpus)` on the interface.** Doubao-only and not wired
  to IPC. Stays as a provider-specific method on `DoubaoClient`.

## Consequences

- `DoubaoClient` no longer extends `EventEmitter` and no longer knows
  its `direction`. Tests can construct it with a synchronous `onEvent`
  spy.
- `DirectionSession`'s state machine is testable against a
  `FakeTranslationClient` — no protobuf mocking needed.
- `config-store.getCredentials()` is removed; `ipc-handlers` no longer
  fetches credentials.
- The renderer's `mockEngine` path is removed; `engines/factory.ts`
  becomes a display-name catalog (or is folded into `engine-types.ts`).
- Adding Qwen is two new files (`qwen-client.ts`, `qwen-credentials.ts`)
  + one case in `client-factory.ts` + one variant in `EngineId`.

## Implementation order

The work splits into two no-behavior-change PRs that land before any
Qwen code:

- **PR α — reshape `DoubaoClient`.** Drop `extends EventEmitter`; switch
  to `onEvent` callback in constructor; drop `direction` field
  (optional `tag` for logs); `DirectionSession` adds `direction` back
  when forwarding. No new modules; no interface yet.
- **PR β — introduce seam + factory.** Add `translation-client.ts`
  interface, `client-factory.ts`, `MockTranslationClient`. Move
  credentials read into `DoubaoClient`. Lock fires at `PreferencesSet`.
  Renderer mock path deleted.

After PR β, adding Qwen is a leaf change: new client + credentials
file + factory case + `EngineId` variant.

## Update — SessionOrchestrator and PreferencesService

`ipc-handlers.ts` had grown session orchestration, preference side
effects and billing into one module, and the engine-switch lock had
gained a second trigger site: a cloud pull from preference sync. Both
moved behind services; the IPC layer (`src/main/ipc/*`) only checks
arguments and forwards.

- **`SessionOrchestrator`** (`sessions/session-orchestrator.ts`) starts,
  stops and routes DirectionSessions for IPC and for the app lifecycle
  (meeting end, idle timeout, quit). It is not the orchestrator rejected
  above: it holds no session state — `SessionRegistry` stays the single
  source of truth for what is running — only a count of in-flight bulk
  cancels. It calls `client-factory` once per start, as the
  `TranslationStart` handler did.
- **The engine-switch lock lives in `PreferencesService`**
  (`preferences-service.ts`), the single mutation path for preferences.
  Both trigger sites — `PreferencesSet` and a cloud pull — run the same
  checks in the same order (known engine, lock, hotkey). A user edit is
  all-or-nothing and rejects with `engine_locked`; a cloud pull drops
  only the field that failed, keeping the local value. An engine switch
  dropped by the lock is pulled again once the last session ends. The
  lock's condition is unchanged: any DirectionSession is alive, read from
  the registry through the orchestrator.
