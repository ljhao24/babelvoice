import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertIcon, CheckIcon } from '../../../../components/Icons.js';
import { CredentialForm } from '../../../../components/CredentialForm.js';
import type { CredentialFieldName } from '../../../../components/credential-fields.js';
import { usePreferences } from '../../../../hooks/usePreferences.js';
import { useCredentialStatus } from '../../../../hooks/useCredentialStatus.js';
import {
  useConnectivityTest,
  type ConnectivityState
} from '../../../../hooks/useConnectivityTest.js';
import { isEngineCredentialed } from '../../../../engines/factory.js';
import type { CredentialedEngineId } from '@shared/engine-types.js';
import type { SetCredentialsPayload } from '@shared/ipc-types.js';
import { NextButton, StepShell } from '../StepShell.js';
import { ThemedHeroVideo } from '../ThemedHeroVideo.js';
import connectAiLightUrl from '../../../../assets/videos/connect-ai-light.mp4';
import connectAiDarkUrl from '../../../../assets/videos/connect-ai-dark.mp4';

/**
 * Key-format hints shown inside the inputs. Doubao's keys have no telling
 * prefix, so their label doubles as the placeholder.
 */
const KEY_PLACEHOLDERS: Partial<
  Record<CredentialedEngineId, Partial<Record<CredentialFieldName, string>>>
> = {
  qwen: { apiKey: 'sk-...', workspaceId: 'llm-...' },
  gemini: { apiKey: 'AIza...' },
  openai: { apiKey: 'sk-...' }
};

/** Step 3 — pick an engine, enter its key, and smoke-test the connection. */
export function Step3Engine({
  onAdvance
}: {
  onAdvance: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const { t: tSettings } = useTranslation('settings');
  const { preferences, set: setPref } = usePreferences();
  const { status, save } = useCredentialStatus();
  const test = useConnectivityTest();

  const engineOptions: { id: CredentialedEngineId; label: string; hint: string }[] = [
    {
      id: 'doubao',
      label: tSettings('translation.engines.doubao.label'),
      hint: tSettings('translation.doubao.obtainHint')
    },
    {
      id: 'qwen',
      label: tSettings('translation.engines.qwen.label'),
      hint: tSettings('translation.qwen.obtainHint')
    },
    {
      id: 'gemini',
      label: tSettings('translation.engines.gemini.label'),
      hint: tSettings('translation.gemini.obtainHint')
    },
    {
      id: 'openai',
      label: tSettings('translation.engines.openai.label'),
      hint: tSettings('translation.openai.obtainHint')
    }
  ];

  const fieldLabels: Record<CredentialFieldName, string> = {
    appKey: t('step3.fields.appKey'),
    accessKey: t('step3.fields.accessKey'),
    apiKey: t('step3.fields.apiKey'),
    workspaceId: t('step3.fields.workspaceId')
  };

  // Mock and engines this build doesn't know (synced from a newer install)
  // both show as the default engine here.
  const engineId: CredentialedEngineId =
    engineOptions.find((o) => o.id === preferences.engineId)?.id ?? 'doubao';
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const configured = isEngineCredentialed(status, engineId);
  const testRunning = test.state.kind === 'running';
  // No engine switch while a save/test is in flight: its result belongs to
  // the engine being tested (the hook also drops results that went stale).
  const switchLocked = saving || testRunning;

  // Back to the engine's saved state + no connectivity result on switch
  // (the form is keyed by engine, so its draft resets too).
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
    test.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineId]);

  const switchEngine = async (
    next: CredentialedEngineId
  ): Promise<void> => {
    if (next === engineId || switchLocked) return;
    try {
      await setPref({ engineId: next });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  // A failed save rejects into the form, which reports it via `onError`.
  const saveAndTest = async (payload: SetCredentialsPayload): Promise<void> => {
    setSaving(true);
    try {
      await save(payload);
      setEditing(false);
      await test.run(engineId);
    } finally {
      setSaving(false);
    }
  };

  const retest = (): Promise<void> => test.run(engineId);

  const done = test.state.kind === 'ok';

  return (
    <StepShell
      step={3}
      title={t('step3.title')}
      desc={t('step3.desc')}
      visual={<ThemedHeroVideo light={connectAiLightUrl} dark={connectAiDarkUrl} />}
      footer={<NextButton enabled={done} onClick={onAdvance} />}
    >
      <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
        {engineOptions.map((o) => {
          const active = o.id === engineId;
          return (
            <button
              key={o.id}
              type="button"
              disabled={switchLocked && !active}
              onClick={() => void switchEngine(o.id)}
              style={{
                padding: '14px 16px',
                borderRadius: 12,
                border: `1px solid ${
                  active
                    ? 'rgb(var(--brand) / 0.45)'
                    : 'rgb(var(--line))'
                }`,
                background: active
                  ? 'rgb(var(--brand) / 0.06)'
                  : 'rgb(var(--bg-elev))',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                cursor: switchLocked && !active ? 'not-allowed' : 'pointer',
                opacity: switchLocked && !active ? 0.55 : 1
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  border: `2px solid ${
                    active
                      ? 'rgb(var(--brand))'
                      : 'rgb(var(--line-strong))'
                  }`,
                  background: active ? 'rgb(var(--brand))' : 'transparent',
                  flexShrink: 0
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: 'rgb(var(--fg))'
                  }}
                >
                  {o.label}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'rgb(var(--fg-subtle))',
                    marginTop: 4
                  }}
                >
                  {o.hint}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div
        style={{
          padding: '16px 18px',
          borderRadius: 12,
          background: 'rgb(var(--bg-elev))',
          border: '1px solid rgb(var(--line))',
          display: 'grid',
          gap: 10
        }}
      >
        {!configured || editing ? (
          <CredentialForm
            key={engineId}
            engineId={engineId}
            fieldText={(name) => ({
              label: fieldLabels[name],
              placeholder: KEY_PLACEHOLDERS[engineId]?.[name] ?? fieldLabels[name]
            })}
            submitLabel={
              saving
                ? t('step3.buttons.saving')
                : testRunning
                  ? t('step3.buttons.testing')
                  : t('step3.buttons.saveAndTest')
            }
            submitBlocked={switchLocked}
            onSubmit={saveAndTest}
            onError={setSaveError}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap'
            }}
          >
            <span
              style={{
                fontSize: 12,
                color: 'rgb(var(--fg-muted))'
              }}
            >
              {engineId === 'doubao'
                ? t('step3.savedHintDoubao', { tail: status.doubao.appKeyTail ?? '' })
                : t('step3.savedHintApiKey', { tail: status[engineId]?.apiKeyTail ?? '' })}
            </span>
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              {t('step3.buttons.change')}
            </button>
            <button
              className="btn btn-secondary"
              disabled={testRunning}
              onClick={() => void retest()}
            >
              {testRunning ? t('step3.buttons.testing') : t('step3.buttons.retest')}
            </button>
          </div>
        )}

        <ConnectivityResult state={test.state} />

        {saveError && (
          <div
            style={{
              fontSize: 11.5,
              color: 'rgb(var(--danger))',
              marginTop: 4
            }}
          >
            {saveError}
          </div>
        )}
      </div>
    </StepShell>
  );
}

function ConnectivityResult({
  state
}: {
  state: ConnectivityState;
}): React.JSX.Element | null {
  const { t } = useTranslation('onboarding');
  if (state.kind === 'idle') return null;
  if (state.kind === 'running') {
    return (
      <div
        style={{
          fontSize: 12,
          color: 'rgb(var(--fg-subtle))',
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        <span className="loading-spinner" /> {t('connectivity.running')}
      </div>
    );
  }
  if (state.kind === 'ok') {
    return (
      <div
        style={{
          fontSize: 12,
          color: 'rgb(var(--success))',
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        <CheckIcon size={13} /> {t('connectivity.ok')}
      </div>
    );
  }
  return (
    <div
      style={{
        fontSize: 12,
        color: 'rgb(var(--danger))',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        lineHeight: 1.5
      }}
    >
      <AlertIcon size={13} style={{ marginTop: 1, flexShrink: 0 }} />
      <div>
        {t('connectivity.failed', {
          codeSuffix: state.code !== undefined ? `（${state.code}）` : '',
          message: state.message
        })}
      </div>
    </div>
  );
}
