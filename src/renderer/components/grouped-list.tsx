import { cn } from '@/lib/utils';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle
} from '@/components/ui/field';

/**
 * A Mac grouped list (System Settings style): rows in one rounded card with
 * hairlines between them, an optional caption above.
 */
export function ListGroup({
  title,
  action,
  children
}: {
  title?: string;
  /** A small control at the caption's trailing end ("查看全部", a swap). */
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      {(title || action) && (
        <div className="flex min-h-6 items-center gap-2 px-3.5">
          {title && <h3 className="text-callout font-semibold text-muted-foreground">{title}</h3>}
          {action && <div className="ml-auto">{action}</div>}
        </div>
      )}
      <FieldGroup className="gap-0 rounded-xl border border-border bg-card">
        {children}
      </FieldGroup>
    </section>
  );
}

/** A ListGroup row that is not a labelled control (a list entry, a note). */
export function ListItem({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-h-11 items-center gap-3 border-t border-border px-3.5 py-2 first:border-t-0',
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * One row of a ListGroup: label and description leading, the control
 * trailing. Give `htmlFor` the control's id when it has one, so the label
 * names it and a click on the label reaches it.
 */
export function ListRow({
  label,
  description,
  htmlFor,
  children
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  htmlFor?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <Field
      orientation="horizontal"
      className="min-h-11 gap-4 border-t border-border px-3.5 py-2 first:border-t-0 has-[>[data-slot=field-content]]:items-center"
    >
      <FieldContent>
        {htmlFor ? (
          <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
        ) : (
          <FieldTitle>{label}</FieldTitle>
        )}
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      {children}
    </Field>
  );
}
