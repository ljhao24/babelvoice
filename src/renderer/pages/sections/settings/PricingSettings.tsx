import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import type { EngineId } from '@shared/engine-types.js';
import {
  PRICE_CURRENCIES,
  TOKEN_CATEGORIES,
  type PriceCurrency,
  type PriceSheet,
  type TokenCategory
} from '@shared/meeting-metrics-types.js';
import { DEFAULT_PRICE_SHEETS, type PricingOverrides } from '@shared/pricing.js';
import { getEngine, resolveEngineId } from '../../../engines/factory.js';
import { usePreferences } from '../../../hooks/usePreferences.js';
import { ListGroup } from '../../../components/grouped-list.js';

/** The billable engines, in the order the translation settings list them. */
const PRICED_ENGINES: readonly EngineId[] = ['doubao', 'qwen', 'gemini', 'openai'];

const CURRENCY_SYMBOL: Record<PriceCurrency, string> = { CNY: '¥', USD: '$' };

type Field = TokenCategory | 'perAudioMinute';
type Draft = { currency: PriceCurrency; values: Partial<Record<Field, string>> };

/** The fields an engine is billed on: whatever its default or override prices. */
const fieldsOf = (engineId: EngineId, sheet: PriceSheet | undefined): Field[] => {
  const priced = new Set<Field>();
  for (const s of [DEFAULT_PRICE_SHEETS[engineId], sheet]) {
    if (!s) continue;
    for (const cat of TOKEN_CATEGORIES) if (s.perMillionTokens[cat] !== undefined) priced.add(cat);
    if (s.perAudioMinute !== undefined) priced.add('perAudioMinute');
  }
  const all: Field[] = [...TOKEN_CATEGORIES, 'perAudioMinute'];
  return priced.size > 0 ? all.filter((f) => priced.has(f)) : [...TOKEN_CATEGORIES];
};

const toDraft = (sheet: PriceSheet | undefined): Draft => {
  const values: Draft['values'] = {};
  for (const cat of TOKEN_CATEGORIES) {
    const v = sheet?.perMillionTokens[cat];
    if (v !== undefined) values[cat] = String(v);
  }
  if (sheet?.perAudioMinute !== undefined) values.perAudioMinute = String(sheet.perAudioMinute);
  return { currency: sheet?.currency ?? 'CNY', values };
};

/** A blank field is unpriced; anything else must be a non-negative number. */
const isValidPrice = (raw: string | undefined): boolean => {
  if (raw === undefined || raw.trim() === '') return true;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0;
};

const fromDraft = (draft: Draft): PriceSheet => {
  const sheet: PriceSheet = { currency: draft.currency, perMillionTokens: {} };
  for (const [field, raw] of Object.entries(draft.values) as [Field, string][]) {
    if (raw.trim() === '') continue;
    const n = Number(raw);
    if (field === 'perAudioMinute') sheet.perAudioMinute = n;
    else sheet.perMillionTokens[field] = n;
  }
  return sheet;
};

const sameDraft = (a: Draft, b: Draft): boolean =>
  a.currency === b.currency &&
  [...TOKEN_CATEGORIES, 'perAudioMinute' as const].every(
    (f) => (a.values[f] ?? '').trim() === (b.values[f] ?? '').trim()
  );

function EnginePricing({
  engineId,
  override,
  onSave,
  onReset
}: {
  engineId: EngineId;
  override: PriceSheet | undefined;
  onSave: (sheet: PriceSheet) => Promise<void>;
  onReset: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation('settings');
  const builtIn = DEFAULT_PRICE_SHEETS[engineId];
  const inForce = override ?? builtIn;
  const [draft, setDraft] = useState<Draft>(() => toDraft(inForce));
  // Re-seed when the stored price changes (saved here, reset, another window).
  useEffect(() => {
    setDraft(toDraft(override ?? builtIn));
  }, [override, builtIn]);

  const fields = fieldsOf(engineId, override);
  const valid = fields.every((f) => isValidPrice(draft.values[f]));
  const dirty = !sameDraft(draft, toDraft(inForce));
  const currencies = PRICE_CURRENCIES.map((c) => ({ value: c, label: t(`pricing.currencies.${c}`) }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-callout text-muted-foreground">
        {t(`pricing.notes.${engineId}`)}
        {builtIn && (
          <span title={builtIn.source}> {t('pricing.source', { host: new URL(builtIn.source).host })}</span>
        )}
      </p>

      <Field orientation="horizontal" className="items-center">
        <FieldLabel htmlFor={`pricing-${engineId}-currency`} className="flex-auto">
          {t('pricing.currency')}
        </FieldLabel>
        <Select
          items={currencies}
          value={draft.currency}
          onValueChange={(next) => next && setDraft({ ...draft, currency: next })}
        >
          <SelectTrigger id={`pricing-${engineId}-currency`} size="sm" className="min-w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {currencies.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {fields.map((field) => {
          const id = `pricing-${engineId}-${field}`;
          const invalid = !isValidPrice(draft.values[field]);
          return (
            <Field key={field} className="gap-1.5" data-invalid={invalid || undefined}>
              <FieldLabel htmlFor={id} className="text-callout text-muted-foreground">
                {t(`pricing.fields.${field}`)}
              </FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <InputGroupText>{CURRENCY_SYMBOL[draft.currency]}</InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  id={id}
                  inputMode="decimal"
                  className="tabular-nums"
                  placeholder={t('pricing.blank')}
                  aria-invalid={invalid || undefined}
                  value={draft.values[field] ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, values: { ...draft.values, [field]: e.target.value } })
                  }
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>
                    {field === 'perAudioMinute' ? t('pricing.perMinute') : t('pricing.perMillion')}
                  </InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        {!valid && <span className="text-callout text-destructive">{t('pricing.invalid')}</span>}
        <div className="ml-auto flex items-center gap-2">
          {override && builtIn && (
            <Button variant="ghost" size="sm" onClick={() => void onReset()}>
              {t('pricing.reset')}
            </Button>
          )}
          <Button size="sm" disabled={!dirty || !valid} onClick={() => void onSave(fromDraft(draft))}>
            {t('pricing.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Unit prices behind the meeting monitor's cost estimate, one collapsible
 * row per engine; the engine in use comes first and starts open. Each starts
 * on its built-in list price; saving stores a device-local override
 * (`prefs.pricing`), "restore" drops it.
 */
export function PricingSettings(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { t: tLang } = useTranslation('languages');
  const { preferences, set } = usePreferences();
  const overrides = preferences.pricing;
  const activeEngine = resolveEngineId(preferences.engineId);
  const engines = [
    ...PRICED_ENGINES.filter((e) => e === activeEngine),
    ...PRICED_ENGINES.filter((e) => e !== activeEngine)
  ];

  const write = (next: PricingOverrides): Promise<void> =>
    set({ pricing: Object.keys(next).length > 0 ? next : undefined });

  return (
    <div className="flex flex-col gap-4">
      <ListGroup>
        <Accordion defaultValue={PRICED_ENGINES.includes(activeEngine) ? [activeEngine] : []}>
          {engines.map((engineId) => {
            const override = overrides?.[engineId];
            const builtIn = DEFAULT_PRICE_SHEETS[engineId];
            return (
              <AccordionItem
                key={engineId}
                value={engineId}
                className="border-t border-border first:border-t-0 not-last:border-b-0"
              >
                <AccordionTrigger className="items-center gap-2 rounded-none px-3.5 py-3">
                  <span className="flex flex-1 items-center gap-2">
                    {tLang(getEngine(engineId).nameKey)}
                    {engineId === activeEngine && (
                      <Badge variant="secondary">{t('pricing.inUse')}</Badge>
                    )}
                  </span>
                  <span className="text-callout text-muted-foreground">
                    {override
                      ? t('pricing.custom')
                      : builtIn
                        ? t('pricing.official', { date: builtIn.asOf })
                        : t('pricing.unpriced')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="px-3.5 pb-4">
                  <EnginePricing
                    engineId={engineId}
                    override={override}
                    onSave={(sheet) => write({ ...overrides, [engineId]: sheet })}
                    onReset={() => {
                      const { [engineId]: _dropped, ...rest } = overrides ?? {};
                      return write(rest);
                    }}
                  />
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </ListGroup>
      <p className="text-callout text-muted-foreground">{t('pricing.intro')}</p>
    </div>
  );
}
