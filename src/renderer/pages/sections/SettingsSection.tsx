import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BookTextIcon,
  CaptionsIcon,
  ChartColumnIcon,
  LanguagesIcon,
  Settings2Icon,
  SunMoonIcon,
  XIcon,
  type LucideIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CorpusEditor } from './CorpusEditor.js';
import { AppearanceSettings } from './settings/AppearanceSettings.js';
import { GeneralSettings } from './settings/GeneralSettings.js';
import { PricingSettings } from './settings/PricingSettings.js';
import { SubtitleSettings } from './settings/SubtitleSettings.js';
import { TranslationSettings } from './settings/TranslationSettings.js';

export type SectionId =
  | 'translation'
  | 'corpus'
  | 'pricing'
  | 'subtitle'
  | 'appearance'
  | 'general';

interface NavEntry {
  id: SectionId;
  icon: LucideIcon;
  /** Colours the icon square, as in macOS System Settings. */
  tile: string;
}

/** Sidebar groups, by task: translating, how it looks, the rest. */
const NAV_GROUPS: NavEntry[][] = [
  [
    { id: 'translation', icon: LanguagesIcon, tile: 'bg-chart-2' },
    { id: 'corpus', icon: BookTextIcon, tile: 'bg-chart-4' },
    { id: 'pricing', icon: ChartColumnIcon, tile: 'bg-chart-1' }
  ],
  [
    { id: 'subtitle', icon: CaptionsIcon, tile: 'bg-chart-3' },
    { id: 'appearance', icon: SunMoonIcon, tile: 'bg-chart-5' }
  ],
  [{ id: 'general', icon: Settings2Icon, tile: 'bg-chart-5' }]
];

const navItemClass = (active: boolean): string =>
  cn(
    'flex w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-body outline-none hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/50',
    active && 'bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent'
  );

/**
 * Settings dialog: grouped sections on the left, the selected panel on the
 * right. Dialogs opened from a panel (hotkey capture) stack above it; Esc
 * closes only the topmost one.
 */
export function SettingsModal({
  open,
  onClose,
  onResetOnboarding,
  initialSection
}: {
  open: boolean;
  onClose: () => void;
  onResetOnboarding?: () => void;
  initialSection?: SectionId;
}): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { t: tc } = useTranslation('common');
  const [section, setSection] = useState<SectionId>(
    initialSection ?? 'translation'
  );

  useEffect(() => {
    if (open && initialSection) setSection(initialSection);
  }, [open, initialSection]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="grid h-[min(640px,calc(100vh-64px))] w-[900px] grid-cols-[216px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[900px]"
      >
        <nav
          aria-label={t('header.eyebrow')}
          className="flex flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar p-2.5 text-sidebar-foreground"
        >
          <DialogTitle className="sr-only">{t('header.eyebrow')}</DialogTitle>
          {NAV_GROUPS.map((group, i) => (
            <div key={i} className={cn('flex flex-col gap-0.5', i > 0 && 'mt-3')}>
              {group.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-current={section === s.id ? 'page' : undefined}
                  onClick={() => setSection(s.id)}
                  className={cn('h-7', navItemClass(section === s.id))}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-[5px] text-white',
                      s.tile
                    )}
                  >
                    <s.icon className="size-3" strokeWidth={2.4} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t(`sections.${s.id}`)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="flex min-h-0 flex-col">
          <header className="flex items-start gap-3 border-b border-border px-6 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <h3 className="font-heading text-title3 font-semibold">
                {t(`sections.${section}`)}
              </h3>
              <p className="mt-0.5 text-callout text-muted-foreground">
                {t(`hints.${section}`)}
              </p>
            </div>
            <DialogClose render={<Button variant="ghost" size="icon-sm" />}>
              <XIcon />
              <span className="sr-only">{tc('close')}</span>
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto w-full max-w-[600px]">
              {section === 'translation' && <TranslationSettings />}
              {section === 'corpus' && (
                <CorpusEditor onGoToTranslation={() => setSection('translation')} />
              )}
              {section === 'pricing' && <PricingSettings />}
              {section === 'subtitle' && <SubtitleSettings />}
              {section === 'appearance' && <AppearanceSettings />}
              {section === 'general' && (
                <GeneralSettings onResetOnboarding={onResetOnboarding} />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
