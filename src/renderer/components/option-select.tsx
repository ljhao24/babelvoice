import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';

export interface SelectOption<V extends string | number = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

/**
 * A Select over plain `{ value, label }` options, for a ListRow: the Mac
 * pop-up button. `onOpen` refreshes a volatile list (running apps, devices)
 * as it opens.
 */
export function OptionSelect<V extends string | number>({
  id,
  items,
  value,
  onChange,
  onOpen,
  disabled,
  ariaLabel,
  className
}: {
  id?: string;
  items: SelectOption<V>[];
  value: V;
  onChange: (next: V) => void;
  onOpen?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <Select
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next != null) onChange(next);
      }}
      onOpenChange={(open) => {
        if (open) onOpen?.();
      }}
    >
      {/* Base UI reads '' as "nothing chosen" and styles it as a placeholder;
          here '' is a real option (系统默认, 全部系统声音). */}
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className={cn('data-placeholder:text-control-foreground', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} disabled={item.disabled}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
