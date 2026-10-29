import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HistoryIcon,
  MicIcon,
  Settings2Icon,
  WaypointsIcon,
  type LucideIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useGlobalHotkey } from '../hooks/useGlobalHotkey.js';
import { usePreferences } from '../hooks/usePreferences.js';
import { useControlPanelWiring } from '../hooks/useRendererWiring.js';
import { useTheme } from '../hooks/useTheme.js';
import { useTtsMonitor } from '../hooks/useTtsMonitor.js';
import { isListenPlaybackActive } from '@shared/config-types.js';
import { useAppStore } from '../store/app-store.js';
import { ControlSection } from './sections/ControlSection.js';
import { AudioSection } from './sections/AudioSection.js';
import {
  SettingsModal,
  type SectionId as SettingsSectionId
} from './sections/SettingsSection.js';
import { TranscriptSection } from './sections/TranscriptSection.js';
import { MeetingReplaySection } from './sections/MeetingReplaySection.js';

// First-run / re-run only, and by far the heaviest page (six hero clips):
// keep it out of the main chunk every cold start parses.
const OnboardingSection = lazy(() =>
  import('./sections/OnboardingSection.js').then((m) => ({
    default: m.OnboardingSection
  }))
);

export type PageId = 'control' | 'transcript' | 'audio' | 'replay';

interface NavItem {
  id: PageId | 'settings';
  /** Translation key under the `nav:items` namespace. */
  labelKey: 'control' | 'transcript' | 'audio' | 'settings';
  icon: LucideIcon;
}

interface NavGroup {
  /** Translation key under the `nav:groups` namespace. */
  labelKey: 'translation' | 'config';
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'translation',
    items: [
      { id: 'control', labelKey: 'control', icon: MicIcon },
      { id: 'transcript', labelKey: 'transcript', icon: HistoryIcon }
    ]
  },
  {
    labelKey: 'config',
    items: [
      { id: 'audio', labelKey: 'audio', icon: WaypointsIcon },
      { id: 'settings', labelKey: 'settings', icon: Settings2Icon }
    ]
  }
];

/**
 * A macOS source list. The whole strip drags the window (the traffic lights
 * sit in its top inset); its buttons opt out so they stay clickable.
 */
function Sidebar({
  page,
  onNav,
  onOpenSettings
}: {
  page: PageId;
  onNav: (p: PageId) => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('nav');
  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag]">
      <div aria-hidden className="h-[52px] shrink-0" />
      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2.5">
        {NAV_GROUPS.map((g) => (
          <div key={g.labelKey} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-subheadline font-semibold text-muted-foreground">
              {t(`groups.${g.labelKey}`)}
            </div>
            {g.items.map((it) => {
              // History stays highlighted while a past meeting is open from it.
              const active =
                it.id === page || (it.id === 'transcript' && page === 'replay');
              return (
                <button
                  key={it.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => (it.id === 'settings' ? onOpenSettings() : onNav(it.id))}
                  className={cn(
                    'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-body outline-none hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50',
                    active && 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent'
                  )}
                >
                  <it.icon className="size-4 text-primary" />
                  {t(`items.${it.labelKey}`)}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

function ToastLayer(): React.JSX.Element | null {
  const toast = useAppStore((s) => s.toast);
  const dismiss = useAppStore((s) => s.dismissToast);
  useEffect(() => {
    if (!toast) return;
    const id = toast.id;
    const timer = setTimeout(() => dismiss(id), 2500);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);
  if (!toast) return null;
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-(--z-overlay) -translate-x-1/2 animate-in rounded-lg bg-popover px-4 py-2.5 text-body text-popover-foreground shadow-lg ring-1 ring-foreground/10 duration-150 fade-in-0 slide-in-from-bottom-2"
    >
      {toast.text}
    </div>
  );
}

export function ControlPanel(): React.JSX.Element {
  // Every main → store mirror for this window is wired here, once; pages and
  // components below only read the store.
  useControlPanelWiring();
  const { preferences, loaded: preferencesLoaded } = usePreferences();
  useTheme();
  useGlobalHotkey();
  const [page, setPage] = useState<PageId>('control');
  const [replayMeetingId, setReplayMeetingId] = useState<string | null>(null);
  // Settings is rendered as a modal dialog rather than a routed page. The
  // initial section lets callers deep-link (the meeting monitor → 费用估算,
  // a missing key → 翻译服务).
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [settingsModalSection, setSettingsModalSection] = useState<
    SettingsSectionId | undefined
  >(undefined);
  // Bumped after the user finishes (or skips) onboarding to force a re-read
  // of preferences. Avoids the brief moment where setupCompletedAt has been
  // written but the store hasn't echoed back.
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const onboardingActive =
    preferencesLoaded && preferences.setupCompletedAt == null && !onboardingDismissed;
  useTtsMonitor({
    allowSpeak: onboardingActive,
    allowListen: isListenPlaybackActive(preferences)
  });

  const navigate = (p: PageId, meetingId?: string): void => {
    if (p === 'replay') {
      setReplayMeetingId(meetingId ?? null);
    }
    setPage(p);
  };

  const openSettings = (section?: SettingsSectionId): void => {
    setSettingsModalSection(section);
    setSettingsModalOpen(true);
  };

  // Wait for prefs to hydrate before deciding — otherwise the wizard would
  // flash on every cold start while we wait for the IPC round-trip.
  if (!preferencesLoaded) {
    return <div className="fixed inset-0 bg-background" />;
  }

  if (preferences.setupCompletedAt == null && !onboardingDismissed) {
    return (
      <Suspense fallback={<div className="fixed inset-0 bg-background" />}>
        <OnboardingSection onFinish={() => setOnboardingDismissed(true)} />
      </Suspense>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background text-body text-foreground">
      <Sidebar
        page={page}
        onNav={(p) => navigate(p)}
        onOpenSettings={() => openSettings()}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {page === 'control' && <ControlSection onOpenSettings={openSettings} onNavigate={navigate} />}
        {page === 'transcript' && <TranscriptSection onNavigate={navigate} />}
        {page === 'replay' && (
          <MeetingReplaySection meetingId={replayMeetingId} onNavigate={navigate} />
        )}
        {page === 'audio' && <AudioSection />}
      </main>
      <SettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        initialSection={settingsModalSection}
        onResetOnboarding={() => {
          setSettingsModalOpen(false);
          setOnboardingDismissed(false);
        }}
      />
      <ToastLayer />
    </div>
  );
}
