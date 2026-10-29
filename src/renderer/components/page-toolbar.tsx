/**
 * The bar across the top of a main-window page, in the hidden-inset title
 * bar's height: title and status leading, actions trailing. Like a unified
 * macOS toolbar it drags the window; its buttons opt out.
 */
export function PageToolbar({
  leading,
  title,
  meta,
  children
}: {
  /** Before the title (a back button). */
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** Status next to the title (a live badge, a count). */
  meta?: React.ReactNode;
  /** Trailing actions. */
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-5 [-webkit-app-region:drag] [&_button]:[-webkit-app-region:no-drag] [&_input]:[-webkit-app-region:no-drag]">
      {leading && <div className="-ml-2 flex shrink-0 items-center">{leading}</div>}
      <h1 className="min-w-0 truncate font-heading text-title3 font-semibold">{title}</h1>
      {meta}
      {children && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}
