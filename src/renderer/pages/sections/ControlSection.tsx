import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store/app-store.js';
import { useMeeting } from '../../hooks/useMeeting.js';
import { PageToolbar } from '../../components/page-toolbar.js';
import type { PageId } from '../ControlPanel.js';
import type { SectionId as SettingsSectionId } from './SettingsSection.js';
import { MeetingSetup } from './control/MeetingSetup.js';
import { MeetingToolbar } from './control/ActiveMeetingHeader.js';
import { ActiveMeetingBody } from './control/ActiveMeetingBody.js';

interface Props {
  /** Opens Settings, optionally at a section (a missing key → 翻译服务, prices → 费用估算). */
  onOpenSettings: (section?: SettingsSectionId) => void;
  onNavigate: (page: PageId, meetingId?: string) => void;
}

/**
 * The 会议 page: setting up and starting a meeting until one is open, then
 * the meeting itself (`./control/`).
 */
export function ControlSection({ onOpenSettings, onNavigate }: Props): React.JSX.Element {
  const { t } = useTranslation('nav');
  const { current, open, end } = useMeeting();
  const lineCount = useAppStore((s) => s.history.length);

  if (!current) {
    return (
      <>
        <PageToolbar title={t('items.control')} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <MeetingSetup
            onStart={async () => {
              await open();
            }}
            onOpenSettings={() => onOpenSettings('translation')}
            onNavigate={onNavigate}
          />
        </div>
      </>
    );
  }

  return (
    <>
      <MeetingToolbar
        title={current.title}
        startedAt={current.startedAt}
        lineCount={lineCount}
        onEnd={end}
      />
      <ActiveMeetingBody
        onOpenSettings={() => onOpenSettings('translation')}
        onOpenPricing={() => onOpenSettings('pricing')}
      />
    </>
  );
}
