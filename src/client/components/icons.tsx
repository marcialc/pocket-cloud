/** Stroke icons on a 24px grid. Decorative: callers label the control, not the icon. */
const PATHS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  sync: "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4",
  cloudOff: "M3 3l18 18M9.5 5.3A6 6 0 0 1 17.6 9a4 4 0 0 1 2.6 6.6M16 19H7a4 4 0 0 1-1.3-7.8",
  device: "M4 5h16v11H4zM2 19h20",
  cloud: "M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.1 11 3.5 3.5 0 0 0 7 18z",
  warn: "M12 3.5 2.5 20h19L12 3.5zM12 10v4.5M12 17.5v.5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5",
  pause: "M8 5v14M16 5v14",
  play: "M7 4.5l12 7.5-12 7.5z",
  reset: "M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5",
  soundOn: "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13",
  soundOff: "M4 9h4l5-4v14l-5-4H4zM16 9l6 6M22 9l-6 6",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  gamepad: "M7 8h10a5 5 0 0 1 0 10l-2-2H9l-2 2A5 5 0 0 1 7 8zM8 11v4M6 13h4M16 12h.01M18 14h.01",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0",
  close: "M6 6l12 12M18 6 6 18",
  lock: "M5 11h14v10H5zM8 11V8a4 4 0 0 1 8 0v3",
  upload: "M12 19V5M5 12l7-7 7 7",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  menu: "M4 6h16M4 12h16M4 18h16",
  eject: "M5 15h14L12 6zM5 19h14",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  friends: "M9 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18.5 13.5a6.5 6.5 0 0 1 3 6.5",
  trophy: "M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 14v4M8 20h8",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="square"
      aria-hidden
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The power-LED dot plus pixel wordmark. */
export function Brand({ onDark = true }: { onDark?: boolean }) {
  return (
    <span className={`brand${onDark ? "" : " on-shell"}`}>
      <span className="led" aria-hidden />
      <span className="wordmark">POCKET CLOUD</span>
    </span>
  );
}

/** Ridged grip strip, like the molded lines on a cartridge. */
export function Ridges({ className = "" }: { className?: string }) {
  return <span className={`ridges ${className}`} aria-hidden />;
}
