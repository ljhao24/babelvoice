import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { acceleratorToTokens } from '../lib/accelerator.js';

/** Keycaps for an Electron accelerator ("Alt+Space" → ⌥ Space). */
export function AcceleratorKeys({ accelerator }: { accelerator: string }): React.JSX.Element {
  const tokens = acceleratorToTokens(accelerator);
  return (
    <KbdGroup>
      {tokens.length === 0 ? (
        <Kbd>{accelerator || '—'}</Kbd>
      ) : (
        tokens.map((tok, i) => <Kbd key={i}>{tok.display}</Kbd>)
      )}
    </KbdGroup>
  );
}
