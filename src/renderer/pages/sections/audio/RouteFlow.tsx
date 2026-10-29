import type { LucideIcon } from 'lucide-react';
import { ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Direction } from '@shared/ipc-types.js';

/** `neutral`: nothing to check (the meeting app's own settings), or still checking. */
export type FlowNodeState = 'ok' | 'attention' | 'neutral';

export interface FlowNode {
  icon: LucideIcon;
  label: string;
  detail: string;
  state: FlowNodeState;
}

const ICON_TONE: Record<Direction, string> = {
  speak: 'bg-speak/12 text-speak',
  listen: 'bg-listen/12 text-listen'
};

/**
 * Where one Direction's sound goes, left to right: each stop with what it
 * is set to, a stop that needs the user in orange. Wraps rather than
 * shrinking text when the window is narrow.
 */
export function RouteFlow({
  direction,
  nodes,
  label
}: {
  direction: Direction;
  nodes: FlowNode[];
  /** Names the list for VoiceOver. */
  label: string;
}): React.JSX.Element {
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-y-2 px-3.5 py-3">
      {nodes.map((node, i) => (
        <li key={node.label} className="flex min-w-0 flex-1 basis-36 items-center">
          {i > 0 && <ChevronRightIcon aria-hidden className="mx-1 size-4 shrink-0 text-muted-foreground/60" />}
          <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg bg-muted px-2.5 py-2">
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-md',
                node.state === 'attention'
                  ? 'bg-caution/12 text-caution'
                  : node.state === 'neutral'
                    ? 'bg-foreground/6 text-muted-foreground'
                    : ICON_TONE[direction]
              )}
            >
              <node.icon className="size-4" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-callout font-medium">{node.label}</span>
              <span
                className={cn(
                  'line-clamp-2 text-subheadline',
                  node.state === 'attention' ? 'text-caution' : 'text-muted-foreground'
                )}
              >
                {node.detail}
              </span>
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
