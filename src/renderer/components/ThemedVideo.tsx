import { useResolvedTheme } from '../hooks/useTheme.js';

/**
 * Looping, muted decorative clip with light/dark variants. Mounts only the
 * variant for the resolved theme — mounting both and hiding one with CSS
 * still downloads and decodes both (`preload=auto` + autoplay).
 */
export function ThemedVideo({
  light,
  dark,
  className = 'onb-hero-video__clip'
}: {
  light: string;
  dark: string;
  className?: string;
}): React.JSX.Element {
  const src = useResolvedTheme() === 'dark' ? dark : light;
  return (
    <video
      key={src}
      className={className}
      src={src}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      aria-hidden="true"
    />
  );
}
