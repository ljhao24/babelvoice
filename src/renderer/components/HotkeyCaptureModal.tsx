import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  acceleratorToTokens,
  keyEventToAccelerator,
  validateAccelerator,
  type ValidateResult
} from '../lib/accelerator.js';
import { Modal } from './ui/Modal.js';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';

/**
 * Modal that captures the next valid keyboard combination and hands the
 * resolved Electron-accelerator string back to the parent. Pure UI — the
 * caller persists the value (and handles register failures, since the
 * native bridge is the only authority on whether a combo is registrable).
 *
 * UX rules:
 *  - Esc cancels (so it can never become the configured hotkey).
 *  - Modifier-only presses are previewed but rejected; the app uses a
 *    press-once-to-toggle model rather than push-to-talk.
 *  - Combinations the macOS native parser cannot resolve are accepted as
 *    a captured value but flagged inline; "Save" is disabled. This lets
 *    the user see what they pressed instead of silently swallowing it.
 *  - "Reset to default" surfaces `defaultAccelerator` as a one-click out.
 */
export function HotkeyCaptureModal({
  open,
  initialAccelerator,
  defaultAccelerator,
  onClose,
  onSave
}: {
  open: boolean;
  initialAccelerator: string;
  defaultAccelerator: string;
  onClose: () => void;
  onSave: (accelerator: string) => Promise<void> | void;
}): React.JSX.Element | null {
  const { t } = useTranslation('settings');
  const [captured, setCaptured] = useState<string>(initialAccelerator);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset capture state every time the modal opens — otherwise a previous
  // session's "Alt+T" would resurface and confuse the user.
  useEffect(() => {
    if (open) {
      setCaptured(initialAccelerator);
      setSubmitError(null);
      setBusy(false);
    }
  }, [open, initialAccelerator]);

  // The registered global hotkey is grabbed by the OS before this window
  // sees the keystroke, so pressing the current combo would toggle the
  // speak session instead of being captured. Release it while open; main
  // re-binds it (or the newly saved one) on close.
  useEffect(() => {
    if (!open) return;
    void window.babelVoiceBridge.setHotkeySuspended(true);
    return () => {
      void window.babelVoiceBridge.setHotkeySuspended(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      // Esc closes the modal rather than ever being captured — otherwise a
      // user could lock themselves out of the universal cancel idiom. The
      // Esc stack (via <Modal>) consumes it before this listener runs, so it
      // closes only this dialog, not Settings underneath; the early return
      // keeps that true regardless of listener order.
      if (e.key === 'Escape') return;
      // Block default behaviour for everything else (e.g. Cmd+W closing
      // a window, Tab moving focus away) so the capture experience feels
      // contained. Stopping propagation here, in the window capture phase,
      // also keeps Tab away from the modal focus trap: Tab is a capturable
      // key, not navigation, while this dialog is open.
      e.preventDefault();
      e.stopPropagation();
      const accel = keyEventToAccelerator(e);
      if (accel) {
        setCaptured(accel);
        setSubmitError(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const validation: ValidateResult = validateAccelerator(captured);
  const tokens = acceleratorToTokens(captured);
  const validationMessage =
    validation.ok === false
      ? validation.reason === 'unsupported-key'
        ? t('hotkey.capture.errors.unsupportedKey')
        : t('hotkey.capture.errors.empty')
      : null;

  const handleSave = async (): Promise<void> => {
    if (!validation.ok || busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await onSave(captured);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmitError(t('hotkey.capture.errors.registerFailed', { message }));
    } finally {
      setBusy(false);
    }
  };

  const handleReset = (): void => {
    setCaptured(defaultAccelerator);
    setSubmitError(null);
  };

  return (
    // Still a legacy <Modal>: its Esc layer consumes Esc before the capture
    // listener, so Esc can never be recorded. The look matches Dialog.
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="hotkey-capture-title"
      className="fixed inset-0 z-(--z-overlay) flex animate-in items-center justify-center bg-black/25 p-6 duration-150 fade-in-0"
      panelClassName="flex w-full max-w-[26rem] flex-col gap-4 rounded-xl bg-background p-5 text-body text-foreground shadow-2xl ring-1 ring-foreground/10 dark:bg-popover"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id="hotkey-capture-title" className="font-heading text-title3 font-semibold">
          {t('hotkey.capture.title')}
        </h2>
        <p className="text-muted-foreground">{t('hotkey.capture.instruction')}</p>
      </div>

      <div
        aria-live="polite"
        data-valid={validation.ok}
        className="flex min-h-16 items-center justify-center rounded-lg border border-input bg-card px-4 py-3 data-[valid=true]:border-primary/50 data-[valid=true]:bg-primary/5"
      >
        {tokens.length === 0 ? (
          <span className="text-muted-foreground">{t('hotkey.capture.preview')}</span>
        ) : (
          <KbdGroup className="[&_kbd]:h-7 [&_kbd]:min-w-7 [&_kbd]:px-2 [&_kbd]:text-body">
            {tokens.map((tok, i) => (
              <Kbd key={i}>{tok.display}</Kbd>
            ))}
          </KbdGroup>
        )}
      </div>

      {validationMessage && tokens.length > 0 && (
        <p className="text-callout text-destructive">{validationMessage}</p>
      )}
      <p className="text-callout text-muted-foreground">{t('hotkey.capture.supportedHint')}</p>
      {submitError && (
        <Alert variant="destructive">
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={handleReset} disabled={busy} className="mr-auto">
          {t('hotkey.capture.reset', {
            accelerator: acceleratorToTokens(defaultAccelerator)
              .map((tok) => tok.display)
              .join(' ')
          })}
        </Button>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t('hotkey.capture.cancel')}
        </Button>
        <Button
          onClick={() => void handleSave()}
          disabled={!validation.ok || busy || captured === initialAccelerator}
        >
          {t('hotkey.capture.save')}
        </Button>
      </div>
    </Modal>
  );
}
