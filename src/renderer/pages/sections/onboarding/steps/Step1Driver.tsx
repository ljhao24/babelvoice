import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, RefreshIcon, WaveIcon } from '../../../../components/Icons.js';
import { NextButton, StepShell } from '../StepShell.js';
import { ThemedHeroVideo } from '../ThemedHeroVideo.js';
import driverLightUrl from '../../../../assets/videos/onboarding-light.mp4';
import driverDarkUrl from '../../../../assets/videos/onboarding-dark.mp4';

/** Step 1 — install the BabelVoice virtual driver and wait for it to come alive. */
export function Step1Driver({
  onAdvance
}: {
  onAdvance: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [virtualAlive, setVirtualAlive] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    const status = await window.babelVoiceBridge.getVirtualOutputStatus();
    setInstalled(status.installed);
    const devices = await window.babelVoiceBridge.nativeAudioDevices();
    setVirtualAlive(
      devices.some((d) => d.kind === 'output' && d.isVirtual && d.isAlive)
    );
    return status.installed;
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [refresh]);

  const handleInstall = async (): Promise<void> => {
    setError(null);
    setInstalling(true);
    // `installing` stays true only while the poll below owns it; any other
    // exit (not started, IPC threw) must re-enable the button.
    let polling = false;
    try {
      const result = await window.babelVoiceBridge.requestVirtualOutputInstall();
      if (!result.started) {
        setError(result.error ?? t('step1.startFailed'));
        return;
      }
      const startedAt = Date.now();
      const tick = async (): Promise<void> => {
        const ok = await refresh().catch(() => false);
        if (ok || Date.now() - startedAt > 5 * 60 * 1000) {
          if (pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setInstalling(false);
        }
      };
      pollRef.current = window.setInterval(() => void tick(), 2000);
      polling = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('step1.startFailed'));
    } finally {
      if (!polling) setInstalling(false);
    }
  };

  const done = installed === true && virtualAlive;

  return (
    <StepShell
      step={1}
      title={t('step1.title')}
      desc={t('step1.desc')}
      visual={
        <ThemedHeroVideo
          light={driverLightUrl}
          dark={driverDarkUrl}
          done={done}
          badge={t('badges.routingActive')}
        />
      }
      footer={<NextButton enabled={done} onClick={onAdvance} />}
    >
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
            background: done
              ? 'rgb(var(--success) / 0.15)'
              : 'rgb(var(--bg-elev-2))',
            color: done ? 'rgb(var(--success))' : 'rgb(var(--fg-muted))'
          }}
        >
          {done ? <CheckIcon size={20} /> : <WaveIcon size={20} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'rgb(var(--fg))' }}>
            {t('step1.driverName')}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: 'rgb(var(--fg-subtle))',
              marginTop: 4,
              lineHeight: 1.45
            }}
          >
            {installed === null
              ? t('step1.status.checking')
              : installing
                ? t('step1.status.installing')
                : error
                  ? error
                  : installed
                    ? virtualAlive
                      ? t('step1.status.installedAlive')
                      : t('step1.status.installedWaiting')
                    : t('step1.status.notInstalled')}
          </div>
        </div>
        {installed === null ? (
          <button className="btn btn-secondary" disabled>
            {t('step1.buttons.checking')}
          </button>
        ) : installed ? (
          <button
            className="btn btn-ghost"
            title={t('step1.buttons.recheck')}
            onClick={() => void refresh()}
          >
            <RefreshIcon size={13} />
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={installing}
            onClick={() => void handleInstall()}
          >
            {installing
              ? t('step1.buttons.installing')
              : error
                ? t('step1.buttons.retry')
                : t('step1.buttons.install')}
          </button>
        )}
      </div>

      {done && (
        <div
          className="fade-in"
          style={{
            marginTop: 12,
            padding: '10px 14px',
            borderRadius: 10,
            background: 'rgb(var(--success) / 0.08)',
            border: '1px solid rgb(var(--success) / 0.24)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            color: 'rgb(var(--success))'
          }}
        >
          <CheckIcon size={14} />
          {t('step1.doneBanner')}
        </div>
      )}
    </StepShell>
  );
}
