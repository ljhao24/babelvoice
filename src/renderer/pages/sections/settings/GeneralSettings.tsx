import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { usePreferences } from '../../../hooks/usePreferences.js';
import { DEFAULT_PREFERENCES } from '@shared/config-types.js';
import { HotkeyCaptureModal } from '../../../components/HotkeyCaptureModal.js';
import { AcceleratorKeys } from '../../../components/accelerator-keys.js';
import { ListGroup, ListRow } from '../../../components/grouped-list.js';

export function GeneralSettings({
  onResetOnboarding
}: {
  onResetOnboarding?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { preferences, set } = usePreferences();
  const [editing, setEditing] = useState(false);

  const handleResetOnboarding = async (): Promise<void> => {
    await set({ setupCompletedAt: undefined });
    onResetOnboarding?.();
  };

  return (
    <div className="flex flex-col gap-6">
      <ListGroup title={t('general.groups.hotkeys')}>
        <ListRow label={t('hotkey.startStop.label')} description={t('hotkey.startStop.hint')}>
          <div className="flex items-center gap-3">
            <AcceleratorKeys accelerator={preferences.hotkey} />
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              {t('hotkey.startStop.edit')}
            </Button>
          </div>
        </ListRow>
        <ListRow label={t('hotkey.stopCancel.label')} description={t('hotkey.stopCancel.hint')}>
          <Kbd>Esc</Kbd>
        </ListRow>
        <ListRow
          label={t('hotkey.subtitle.label')}
          description={`${t('hotkey.subtitle.hint')} ${t('hotkey.subtitle.notImplemented')}`}
        >
          <AcceleratorKeys accelerator="Alt+Shift+C" />
        </ListRow>
      </ListGroup>

      <ListGroup title={t('general.groups.setup')}>
        <ListRow
          label={t('advanced.rerunOnboarding.label')}
          description={t('advanced.rerunOnboarding.hint')}
        >
          <Button variant="outline" size="sm" onClick={() => void handleResetOnboarding()}>
            <RotateCcwIcon data-icon="inline-start" />
            {t('advanced.rerunOnboarding.cta')}
          </Button>
        </ListRow>
      </ListGroup>

      <HotkeyCaptureModal
        open={editing}
        initialAccelerator={preferences.hotkey}
        defaultAccelerator={DEFAULT_PREFERENCES.hotkey}
        onClose={() => setEditing(false)}
        onSave={(next) => set({ hotkey: next })}
      />
    </div>
  );
}
