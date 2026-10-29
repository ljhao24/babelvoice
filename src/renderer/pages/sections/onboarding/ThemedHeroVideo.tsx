import { ThemedVideo } from '../../../components/ThemedVideo.js';

/**
 * A step's hero clip: the light/dark loop (`ThemedVideo` mounts only the
 * variant for the resolved theme) plus, once the step is satisfied, a
 * status badge over it. Steps without a pass/fail state omit `done`.
 */
export function ThemedHeroVideo({
  light,
  dark,
  done,
  badge
}: {
  light: string;
  dark: string;
  done?: boolean;
  badge?: string;
}): React.JSX.Element {
  return (
    <div
      className="onb-hero-video"
      data-done={done === undefined ? undefined : done ? 'true' : 'false'}
    >
      <ThemedVideo light={light} dark={dark} />
      {done && badge && <div className="onb-hero-video__badge">{badge}</div>}
    </div>
  );
}
