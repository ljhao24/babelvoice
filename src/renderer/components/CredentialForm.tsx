import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { CredentialedEngineId } from '@shared/engine-types.js';
import type { SetCredentialsPayload } from '@shared/ipc-types.js';
import {
  CREDENTIAL_FIELDS,
  isCredentialDraftComplete,
  toCredentialsPayload,
  type CredentialDraft,
  type CredentialFieldName
} from './credential-fields.js';

/**
 * Entry form for one provider's API credentials — the fields come from
 * `CREDENTIAL_FIELDS`, the copy from the caller. Owns the draft and the
 * in-flight state; the caller owns what happens around it (the saved-key
 * summary, a connectivity test, where errors show). Enter in any field
 * submits once the draft is complete.
 *
 * The draft lives only while the form is mounted: callers unmount it once
 * the key is saved (switching to their summary view), which also discards
 * what was typed. Key the form by engine so switching engines starts empty.
 */
export function CredentialForm({
  engineId,
  fieldText,
  initialDraft,
  submitLabel,
  submitBlocked = false,
  onSubmit,
  onCancel,
  onError
}: {
  engineId: CredentialedEngineId;
  /** Per-field copy: the label above the input and its placeholder. */
  fieldText: (name: CredentialFieldName) => { label: string; placeholder: string };
  /** Pre-filled values, e.g. the stored (non-secret) Qwen workspace id. */
  initialDraft?: CredentialDraft;
  submitLabel: string;
  /** Holds the submit button back for a reason outside the form (a test in flight). */
  submitBlocked?: boolean;
  /** Resolves once saved; a rejection keeps the draft and reports its message. */
  onSubmit: (payload: SetCredentialsPayload) => Promise<void>;
  /** Renders a cancel button next to submit (only when there is a saved key to go back to). */
  onCancel?: () => void;
  /** Takes over error display (null clears it); otherwise errors render under the buttons. */
  onError?: (message: string | null) => void;
}): React.JSX.Element {
  const { t: tc } = useTranslation('common');
  const idPrefix = useId();
  const [draft, setDraft] = useState<CredentialDraft>(initialDraft ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const report = (message: string | null): void => {
    if (onError) onError(message);
    else setError(message);
  };

  const canSubmit =
    isCredentialDraftComplete(engineId, draft) && !busy && !submitBlocked;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    report(null);
    try {
      await onSubmit(toCredentialsPayload(engineId, draft));
    } catch (err) {
      report(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FieldGroup className="gap-3">
      {CREDENTIAL_FIELDS[engineId].map((f) => {
        const text = fieldText(f.name);
        const id = `${idPrefix}-${f.name}`;
        return (
          <Field key={f.name} className="gap-1.5">
            <FieldLabel htmlFor={id} className="text-callout text-muted-foreground">
              {text.label}
            </FieldLabel>
            <Input
              id={id}
              type={f.secret ? 'password' : 'text'}
              placeholder={text.placeholder}
              value={draft[f.name] ?? ''}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              onChange={(e) => setDraft((prev) => ({ ...prev, [f.name]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit();
              }}
            />
          </Field>
        );
      })}
      <div className="flex items-center gap-2 pt-1">
        <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            {tc('cancel')}
          </Button>
        )}
      </div>
      {error && <FieldError>{error}</FieldError>}
    </FieldGroup>
  );
}
