import type { SVGProps } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false
});

export function MicIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export function HeadphonesIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M3 14v-2a9 9 0 0 1 18 0v2" />
      <path d="M3 14h3a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z" />
      <path d="M21 14h-3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-5z" />
    </svg>
  );
}

export function CheckIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <polyline points="4 12 10 18 20 6" />
    </svg>
  );
}

export function AlertIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function RefreshIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M3 12a9 9 0 0 1 15.5-6.36L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.36L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

export function PlayIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

export function StopIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

export function SparkleIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </svg>
  );
}

export function WaveIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0" />
    </svg>
  );
}

export function SpeakerIcon({ size, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
    </svg>
  );
}

