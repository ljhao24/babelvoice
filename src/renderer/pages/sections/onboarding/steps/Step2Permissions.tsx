import { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { CheckIcon, MicIcon, SpeakerIcon } from '../../../../components/Icons.js';
import type {
  NativePermissionSnapshot,
  ScreenPermissionStatus
} from '@shared/ipc-types.js';
import { NextButton, StepShell } from '../StepShell.js';
import { ThemedHeroVideo } from '../ThemedHeroVideo.js';
import permissionsLightUrl from '../../../../assets/videos/permissions-light.mp4';
import permissionsDarkUrl from '../../../../assets/videos/permissions-dark.mp4';

function PermissionRow({
  icon,
  title,
  desc,
  status,
  busy,
  hint,
  onAction
}: {
  icon: React.JSX.Element;
  title: string;
  desc: string;
  status: ScreenPermissionStatus;
  busy?: boolean;
  hint?: string | null;
  onAction: () => Promise<void> | void;
}): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const granted = status === 'granted';
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 12,
        border: '1px solid rgb(var(--line))',
        background: 'rgb(var(--bg-elev))',
        display: 'flex',
        alignItems: 'center',
        gap: 14
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          display: 'grid',
          placeItems: 'center',
          background: granted
            ? 'rgb(var(--success) / 0.15)'
            : 'rgb(var(--bg-elev-2))',
          color: granted ? 'rgb(var(--success))' : 'rgb(var(--fg-muted))'
        }}
      >
        {granted ? <CheckIcon size={20} /> : icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'rgb(var(--fg))' }}>
          {title}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: granted ? 'rgb(var(--success))' : 'rgb(var(--fg-subtle))',
            marginTop: 4,
            lineHeight: 1.45
          }}
        >
          {granted ? t('step2.row.granted') : desc}
        </div>
        {hint && !granted && (
          <div
            style={{
              fontSize: 11,
              color: 'rgb(var(--warning))',
              marginTop: 6,
              lineHeight: 1.45
            }}
          >
            {hint}
          </div>
        )}
      </div>
      {!granted && (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void onAction()}
        >
          {busy ? t('step2.row.requesting') : t('step2.row.grant')}
        </button>
      )}
    </div>
  );
}

/** Step 2 — microphone + screen-recording (system audio) permissions. */
export function Step2Permissions({
  onAdvance
}: {
  onAdvance: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const [perms, setPerms] = useState<NativePermissionSnapshot | null>(null);
  const [micBusy, setMicBusy] = useState(false);
  const [screenBusy, setScreenBusy] = useState(false);
  const [screenHint, setScreenHint] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.babelVoiceBridge.nativePermissions();
      setPerms(next);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const requestMic = async (): Promise<void> => {
    setMicBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((tr) => tr.stop());
    } catch {
      /* user denied; refresh will show denied */
    } finally {
      setMicBusy(false);
      void refresh();
    }
  };

  const requestScreen = async (): Promise<void> => {
    setScreenBusy(true);
    setScreenHint(null);
    try {
      const result = await window.babelVoiceBridge.requestScreenPermission();
      if (result.statusAfter !== 'granted') {
        setScreenHint(result.hint ?? t('step2.screen.fallbackHint'));
      }
    } finally {
      setScreenBusy(false);
      void refresh();
    }
  };

  const micGranted = perms?.microphone === 'granted';
  const screenGranted = perms?.screen === 'granted';
  const done = micGranted && screenGranted;

  return (
    <StepShell
      step={2}
      title={t('step2.title')}
      desc={t('step2.desc')}
      visual={
        <ThemedHeroVideo
          light={permissionsLightUrl}
          dark={permissionsDarkUrl}
          done={done}
          badge={t('badges.permissionsGranted')}
        />
      }
      footer={<NextButton enabled={done} onClick={onAdvance} />}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <PermissionRow
          icon={<MicIcon size={20} />}
          title={t('step2.mic.title')}
          desc={t('step2.mic.desc')}
          status={perms?.microphone ?? 'unknown'}
          busy={micBusy}
          onAction={requestMic}
        />
        <PermissionRow
          icon={<SpeakerIcon size={20} />}
          title={t('step2.screen.title')}
          desc={t('step2.screen.desc')}
          status={perms?.screen ?? 'unknown'}
          busy={screenBusy}
          hint={screenHint}
          onAction={requestScreen}
        />
      </div>

      <div
        style={{
          marginTop: 14,
          padding: '10px 14px',
          borderRadius: 10,
          background: 'rgb(var(--bg-elev))',
          border: '1px solid rgb(var(--line))',
          fontSize: 11.5,
          color: 'rgb(var(--fg-subtle))',
          lineHeight: 1.55
        }}
      >
        <Trans i18nKey="step2.tip" ns="onboarding" components={{ bold: <b /> }} />
      </div>
    </StepShell>
  );
}
