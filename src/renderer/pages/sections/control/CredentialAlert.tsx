import { useTranslation } from 'react-i18next';
import { TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { usePreferences } from '../../../hooks/usePreferences.js';
import { useCredentialStatus } from '../../../hooks/useCredentialStatus.js';
import { getEngine, isEngineCredentialed } from '../../../engines/factory.js';

/** Nothing can translate until the selected engine has a key: say so, link to it. */
export function CredentialAlert({
  onGoToSettings
}: {
  onGoToSettings: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation('control');
  const { t: tLang } = useTranslation('languages');
  const { preferences } = usePreferences();
  const { status, loaded } = useCredentialStatus();
  if (!loaded || isEngineCredentialed(status, preferences.engineId)) return null;
  return (
    <Alert>
      <TriangleAlertIcon className="text-destructive" />
      <AlertDescription className="flex items-center gap-3 text-foreground">
        <span className="flex-1">
          {t('credentialBanner.engineNotConfigured', {
            engine: tLang(getEngine(preferences.engineId).nameKey)
          })}
        </span>
        <Button size="sm" variant="outline" onClick={onGoToSettings}>
          {t('credentialBanner.goToSettings')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
