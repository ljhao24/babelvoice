import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, InfoIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { usePreferences } from '../../hooks/usePreferences.js';
import { getEngine } from '../../engines/factory.js';
import { createDebouncedCommit } from '../../lib/debounced-commit.js';
import { ListItem } from '../../components/grouped-list.js';

type TabId = 'glossary' | 'hotWords' | 'correctWords';

/** One editable entry: [source, target] for pairs, [word] for hot words. */
type Row = string[];

interface Corpus {
  glossary: Record<string, string>;
  hotWords: string[];
  correctWords: Record<string, string>;
}

const MAX_TOTAL = 100;
const SAVE_DELAY_MS = 600;

const dictToRows = (d: Record<string, string>): Row[] => Object.entries(d);

const rowsToDict = (rows: Row[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of rows) {
    const key = k.trim();
    const val = (v ?? '').trim();
    if (!key || !val) continue;
    // Last-write-wins on duplicate keys, mirroring Object.fromEntries.
    out[key] = val;
  }
  return out;
};

const rowsToWords = (rows: Row[]): string[] => {
  const seen = new Set<string>();
  for (const [w] of rows) {
    const word = w.trim();
    if (word) seen.add(word);
  }
  return Array.from(seen);
};

/**
 * 词库: glossary, hot words and replacements for Doubao. Edits save on
 * their own a moment after typing stops (and when leaving the section), as
 * every other setting does; half-filled entries simply aren't saved yet.
 * Editing needs Doubao — otherwise the lists show read-only with a notice
 * that says why and what to do.
 */
export function CorpusEditor({
  onGoToTranslation
}: {
  onGoToTranslation?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { t: tLang } = useTranslation('languages');
  const { preferences, set } = usePreferences();
  const cfg = preferences.engineConfigs.doubao;
  const editable = preferences.engineId === 'doubao';

  const [tab, setTab] = useState<TabId>('glossary');
  const [glossary, setGlossary] = useState<Row[]>(() => dictToRows(cfg.glossary));
  const [hotWords, setHotWords] = useState<Row[]>(() => cfg.hotWords.map((w) => [w]));
  const [correctWords, setCorrectWords] = useState<Row[]>(() => dictToRows(cfg.correctWords));
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const corpus: Corpus = useMemo(
    () => ({
      glossary: rowsToDict(glossary),
      hotWords: rowsToWords(hotWords),
      correctWords: rowsToDict(correctWords)
    }),
    [glossary, hotWords, correctWords]
  );
  const counts: Record<TabId, number> = {
    glossary: Object.keys(corpus.glossary).length,
    hotWords: corpus.hotWords.length,
    correctWords: Object.keys(corpus.correctWords).length
  };
  const total = counts.glossary + counts.hotWords + counts.correctWords;
  const over = total > MAX_TOTAL;

  // The debounced commit outlives renders; the ref hands it the latest
  // engine configs to merge into.
  const commitRef = useRef<(next: Corpus) => void>(() => {});
  commitRef.current = (next) => {
    setSaveState('saving');
    set({
      engineConfigs: {
        ...preferences.engineConfigs,
        doubao: { ...preferences.engineConfigs.doubao, ...next }
      }
    })
      .then(() => {
        setSaveState('saved');
        setSaveError(null);
      })
      .catch((e: unknown) => {
        setSaveState('idle');
        setSaveError(e instanceof Error ? e.message : String(e));
      });
  };
  const [debounced] = useState(() =>
    createDebouncedCommit<Corpus>((next) => commitRef.current(next), SAVE_DELAY_MS)
  );
  // Leaving the section (or closing Settings) still saves the last edit.
  useEffect(() => () => debounced.flush(), [debounced]);

  const draftKey = JSON.stringify(corpus);
  const savedKey = JSON.stringify({
    glossary: cfg.glossary,
    hotWords: cfg.hotWords,
    correctWords: cfg.correctWords
  });
  useEffect(() => {
    if (!editable || over || draftKey === savedKey) return;
    debounced.push(corpus);
    // Only a change to the entries themselves schedules a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const tabs: { id: TabId; rows: Row[]; setRows: (rows: Row[]) => void; placeholders: string[] }[] = [
    {
      id: 'glossary',
      rows: glossary,
      setRows: setGlossary,
      placeholders: [t('corpus.glossary.sourcePlaceholder'), t('corpus.glossary.targetPlaceholder')]
    },
    {
      id: 'hotWords',
      rows: hotWords,
      setRows: setHotWords,
      placeholders: [t('corpus.hotWords.placeholder')]
    },
    {
      id: 'correctWords',
      rows: correctWords,
      setRows: setCorrectWords,
      placeholders: [
        t('corpus.correctWords.findPlaceholder'),
        t('corpus.correctWords.replacePlaceholder')
      ]
    }
  ];
  const current = tabs.find((x) => x.id === tab)!;

  return (
    <div className="flex flex-col gap-4">
      {!editable && (
        <Alert>
          <InfoIcon />
          <AlertDescription className="flex items-center gap-3 text-foreground">
            <span className="flex-1">
              {t('corpus.engineUnsupported', {
                engine: tLang(getEngine(preferences.engineId).nameKey)
              })}
            </span>
            {onGoToTranslation && (
              <Button size="sm" variant="outline" onClick={onGoToTranslation}>
                {t('corpus.goToTranslation')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          variant="segmented"
          aria-label={t('sections.corpus')}
          value={[tab]}
          onValueChange={(next) => {
            const id = next[0] as TabId | undefined;
            if (id) setTab(id);
          }}
        >
          {tabs.map((x) => (
            <ToggleGroupItem key={x.id} value={x.id}>
              {t(`corpus.tabs.${x.id}`)}
              <span className="text-muted-foreground tabular-nums">{counts[x.id]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-3 text-callout text-muted-foreground">
          {editable && saveState === 'saving' && <span>{t('corpus.saving')}</span>}
          {editable && saveState === 'saved' && !over && <span>{t('corpus.saved')}</span>}
          <span className={cn('tabular-nums', over && 'font-semibold text-destructive')}>
            {t('corpus.usage', { total, max: MAX_TOTAL })}
          </span>
        </div>
      </div>

      <p className="text-callout text-muted-foreground">{t(`corpus.${tab}.hint`)}</p>

      <EntryList
        key={tab}
        rows={current.rows}
        setRows={current.setRows}
        placeholders={current.placeholders}
        emptyText={t(`corpus.${tab}.empty`)}
        addLabel={t(`corpus.${tab}.add`)}
        removeLabel={t('corpus.remove')}
        disabled={!editable}
      />

      {over && (
        <p className="text-callout text-destructive">{t('corpus.tooMany', { max: MAX_TOTAL })}</p>
      )}
      {saveError && (
        <Alert variant="destructive">
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/**
 * The entries of one list as a grouped card: one or two inputs per row,
 * delete at the end, add at the bottom. Enter in the last, filled row adds
 * the next one and moves there.
 */
function EntryList({
  rows,
  setRows,
  placeholders,
  emptyText,
  addLabel,
  removeLabel,
  disabled
}: {
  rows: Row[];
  setRows: (rows: Row[]) => void;
  placeholders: string[];
  emptyText: string;
  addLabel: string;
  removeLabel: string;
  disabled: boolean;
}): React.JSX.Element {
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const add = (): void => {
    setRows([...rows, placeholders.map(() => '')]);
    setFocusRow(rows.length);
  };

  return (
    <div className="rounded-xl border border-border bg-card">
      {rows.length === 0 && (
        <ListItem className="justify-center text-muted-foreground">{emptyText}</ListItem>
      )}
      {rows.map((row, i) => (
        <ListItem key={i} className="gap-2 py-1.5">
          {row.map((cell, j) => (
            <Fragment key={j}>
              {j > 0 && (
                <ArrowRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <Input
                value={cell}
                placeholder={placeholders[j]}
                aria-label={placeholders[j]}
                spellCheck={false}
                disabled={disabled}
                autoFocus={focusRow === i && j === 0}
                onChange={(e) =>
                  setRows(
                    rows.map((r, ri) => (ri === i ? r.map((c, ci) => (ci === j ? e.target.value : c)) : r))
                  )
                }
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || i !== rows.length - 1) return;
                  if (row.every((c) => c.trim() !== '')) {
                    e.preventDefault();
                    add();
                  }
                }}
              />
            </Fragment>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={removeLabel}
            disabled={disabled}
            onClick={() => setRows(rows.filter((_, ri) => ri !== i))}
          >
            <Trash2Icon />
          </Button>
        </ListItem>
      ))}
      <ListItem className="py-1.5">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={add}>
          <PlusIcon data-icon="inline-start" />
          {addLabel}
        </Button>
      </ListItem>
    </div>
  );
}
