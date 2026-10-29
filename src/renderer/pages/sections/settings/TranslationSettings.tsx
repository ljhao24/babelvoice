import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, InfoIcon, KeyRoundIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { CredentialForm } from '../../../components/CredentialForm.js';
import type { CredentialFieldName } from '../../../components/credential-fields.js';
import { usePreferences } from '../../../hooks/usePreferences.js';
import { useCredentialStatus } from '../../../hooks/useCredentialStatus.js';
import { useAppStore } from '../../../store/app-store.js';
import type {
  CredentialStatus,
  CredentialedEngineId,
  EngineId
} from '@shared/engine-types.js';
import type {
  ClearCredentialsPayload,
  SessionStatus,
  SetCredentialsPayload
} from '@shared/ipc-types.js';
import { getEngine, isEngineCredentialed, resolveEngineId } from '../../../engines/factory.js';
import { ListGroup, ListItem, ListRow } from '../../../components/grouped-list.js';

const ENGINES: CredentialedEngineId[] = ['doubao', 'qwen', 'gemini', 'openai'];

const isBusy = (status: SessionStatus): boolean => status !== 'idle' && status !== 'failed';

/**
 * Pick the engine from a list that shows what each one does and whether its
 * key is in, then manage the chosen engine's key below. Switching is locked
 * while either direction is running, rather than failing after the click.
 */
export function TranslationSettings(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { preferences, set } = usePreferences();
  const { status, save, clear } = useCredentialStatus();
  const busy = useAppStore((s) => isBusy(s.speak.status) || isBusy(s.listen.status));
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Display-only: an engine id this build doesn't know shows as the default.
  const engineId = resolveEngineId(preferences.engineId);

  const handleEngineChange = async (next: EngineId): Promise<void> => {
    if (next === engineId) return;
    setSwitchError(null);
    try {
      await set({ engineId: next });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSwitchError(t('translation.switchFailed', { message }));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {busy && (
        <Alert>
          <InfoIcon />
          <AlertDescription>{t('translation.busy')}</AlertDescription>
        </Alert>
      )}
      {switchError && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-line">{switchError}</AlertDescription>
        </Alert>
      )}

      <ListGroup>
        <RadioGroup
          aria-label={t('translation.engineLabel')}
          value={engineId}
          disabled={busy}
          onValueChange={(next) => void handleEngineChange(next as EngineId)}
          className="gap-0"
        >
          {ENGINES.map((id) => {
            const ready = isEngineCredentialed(status, id);
            return (
              <label
                key={id}
                className="flex min-h-11 items-start gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0 has-data-disabled:opacity-60"
              >
                <RadioGroupItem value={id} className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span>{t(`translation.engines.${id}.label`)}</span>
                  <span className="text-callout text-muted-foreground">
                    {t(`translation.engines.${id}.hint`)}
                  </span>
                </span>
                {ready ? (
                  <Badge variant="secondary">
                    <CheckIcon data-icon="inline-start" />
                    {t('translation.ready')}
                  </Badge>
                ) : (
                  <Badge variant="outline">{t('translation.needsKey')}</Badge>
                )}
              </label>
            );
          })}
        </RadioGroup>
      </ListGroup>

      {engineId !== 'mock' && (
        <CredentialsGroup
          key={engineId}
          engineId={engineId}
          status={status}
          onSave={save}
          onClear={clear}
        />
      )}
    </div>
  );
}

/**
 * The selected engine's key: a masked summary with 更换 / 清除 once saved,
 * otherwise the labelled entry form with where to get the key. Copy lives
 * under `translation.<engineId>`; Qwen also takes an optional 业务空间 ID,
 * shown in the summary and pre-filled when changing the key.
 */
function CredentialsGroup({
  engineId,
  status,
  onSave,
  onClear
}: {
  engineId: CredentialedEngineId;
  status: CredentialStatus;
  onSave: (payload: SetCredentialsPayload) => Promise<void>;
  onClear: (payload: ClearCredentialsPayload) => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { t: tc } = useTranslation('common');
  const { t: tOnb } = useTranslation('onboarding');
  const { t: tLang } = useTranslation('languages');
  const [editing, setEditing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const configured = status[engineId]?.configured ?? false;
  const workspaceId = engineId === 'qwen' ? status.qwen.workspaceId : undefined;
  const engineName = tLang(getEngine(engineId).nameKey);

  const handleClear = async (): Promise<void> => {
    setClearing(true);
    try {
      await onClear({ engineId });
      setEditing(true);
    } finally {
      setClearing(false);
    }
  };

  if (configured && !editing) {
    const summary =
      engineId === 'doubao'
        ? t('translation.doubao.appKeyDisplay', { tail: status.doubao.appKeyTail ?? '????' })
        : t(`translation.${engineId}.keyDisplay`, {
            tail: status[engineId]?.apiKeyTail ?? '????'
          });
    return (
      <ListGroup title={t(`translation.${engineId}.label`)}>
        <ListRow
          label={
            <span className="flex items-center gap-2 font-mono text-callout">
              <KeyRoundIcon className="size-3.5 text-muted-foreground" />
              {summary}
              {workspaceId && ` · ${t('translation.qwen.workspaceDisplay', { id: workspaceId })}`}
            </span>
          }
          description={t(`translation.${engineId}.savedHint`)}
        >
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {t(`translation.${engineId}.change`)}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button variant="ghost" size="sm" className="text-destructive" />}
                disabled={clearing}
              >
                {t(`translation.${engineId}.clear`)}
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t('translation.clearConfirm.title', { engine: engineName })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('translation.clearConfirm.description')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void handleClear()}>
                    {t(`translation.${engineId}.clear`)}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </ListRow>
      </ListGroup>
    );
  }

  const fieldText = (name: CredentialFieldName): { label: string; placeholder: string } => {
    const label = tOnb(`step3.fields.${name}`);
    switch (name) {
      // Doubao's keys have no telltale prefix; a placeholder would only repeat the label.
      case 'appKey':
      case 'accessKey':
        return { label, placeholder: '' };
      case 'workspaceId':
        return { label, placeholder: t('translation.qwen.workspacePlaceholder') };
      case 'apiKey':
        return { label, placeholder: t(`translation.${engineId}.keyPlaceholder`) };
    }
  };

  return (
    <ListGroup title={t(`translation.${engineId}.label`)}>
      <ListItem className="flex-col items-stretch gap-3 py-3">
        <p className="text-callout text-muted-foreground">
          {t(`translation.${engineId}.obtainHint`)}
        </p>
        <CredentialForm
          engineId={engineId}
          fieldText={fieldText}
          initialDraft={{ workspaceId: workspaceId ?? '' }}
          submitLabel={tc('save')}
          onSubmit={async (payload) => {
            await onSave(payload);
            setEditing(false);
          }}
          onCancel={configured ? () => setEditing(false) : undefined}
        />
      </ListItem>
    </ListGroup>
  );
}
