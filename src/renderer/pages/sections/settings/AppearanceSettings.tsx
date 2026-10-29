import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { usePreferences } from '../../../hooks/usePreferences.js';
import type { AppTheme } from '@shared/config-types.js';
import { LOCALES, type Locale } from '@shared/i18n-types.js';
import { ListGroup, ListRow } from '../../../components/grouped-list.js';

const THEMES: { value: AppTheme; icon: LucideIcon }[] = [
  { value: 'system', icon: MonitorIcon },
  { value: 'light', icon: SunIcon },
  { value: 'dark', icon: MoonIcon }
];

export function AppearanceSettings(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { preferences, set } = usePreferences();

  return (
    <ListGroup>
      <ListRow label={t('appearance.themeLabel')} description={t('appearance.themeHint')}>
        <ToggleGroup
          variant="segmented"
          aria-label={t('appearance.themeLabel')}
          value={[preferences.theme]}
          onValueChange={(next) => {
            // Pressing the selected segment again clears a toggle group;
            // a theme is always set, so ignore that.
            const theme = next[0] as AppTheme | undefined;
            if (theme) void set({ theme });
          }}
        >
          {THEMES.map(({ value, icon: Icon }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              title={t(`appearance.options.${value}.hint`)}
            >
              <Icon data-icon="inline-start" />
              {t(`appearance.options.${value}.label`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ListRow>
      <LanguageRow />
    </ListGroup>
  );
}

function LanguageRow(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const [current, setCurrent] = useState<Locale | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.babelVoiceBridge.getLocale().then((locale) => {
      if (!cancelled) setCurrent(locale);
    });
    const unsubscribe = window.babelVoiceBridge.onLocaleChanged((locale) => {
      setCurrent(locale);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const items = LOCALES.map((loc) => ({
    value: loc,
    label: t(`language.options.${loc}` as const)
  }));

  const handleChange = async (next: Locale | null): Promise<void> => {
    if (!next) return;
    setCurrent(next);
    await window.babelVoiceBridge.setLocale(next);
  };

  return (
    <ListRow
      label={t('language.label')}
      description={t('language.hint')}
      htmlFor="settings-language"
    >
      <Select
        items={items}
        value={current}
        disabled={current == null}
        onValueChange={(next) => void handleChange(next)}
      >
        <SelectTrigger id="settings-language" className="min-w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </ListRow>
  );
}
