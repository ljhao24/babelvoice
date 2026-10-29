import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group';
import { hasEscapeLayer } from '../lib/escape-stack.js';

/**
 * A Mac search field: magnifier leading, a clear button once there is text,
 * Esc clears it (and only falls through to "Esc stops speaking" when it is
 * already empty). The magnifier stands in for a visible label; `label`
 * names it for VoiceOver. With `findShortcut`, ⌘F focuses it — give that to
 * one field per page.
 */
export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  findShortcut = false,
  className
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  findShortcut?: boolean;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation('common');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!findShortcut) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      // An open dialog or menu owns the keyboard.
      if (e.key !== 'f' || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || hasEscapeLayer()) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [findShortcut]);

  return (
    <InputGroup className={cn('w-56 bg-card dark:bg-input/30', className)}>
      <InputGroupAddon>
        <SearchIcon className="size-3.5" />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="text"
        role="searchbox"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            className="rounded-full"
            aria-label={t('clear')}
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
          >
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}
