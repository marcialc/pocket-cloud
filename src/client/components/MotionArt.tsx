import { useCallback, useEffect, useRef, useState } from "react";

const DURATION_MS = {
  "game-inserted": 747,
  "sign-in-complete": 595,
  "saved-on-device": 300,
  "cloud-backup-complete": 498,
  "link-connected": 902,
  "waiting-for-friend": 1494,
  "friend-added": 595,
  "resume-game": 400,
} as const;

export type MotionName = keyof typeof DURATION_MS;
type Cue = { name: MotionName; id: number };

/** Run a one-shot decorative cue without delaying the action it celebrates. */
export function useMotionCue() {
  const [cue, setCue] = useState<Cue | null>(null);
  const nextId = useRef(0);
  const timer = useRef<number | null>(null);
  const play = useCallback((name: MotionName) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    const id = ++nextId.current;
    setCue({ name, id });
    timer.current = window.setTimeout(() => {
      setCue((current) => (current?.id === id ? null : current));
      timer.current = null;
    }, DURATION_MS[name] + 250);
  }, []);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return { cue, play };
}

/** Animated WebP, APNG fallback, and a still frame for either reduced-motion setting. */
export function MotionArt({ name, reduceMotion, className = "" }: {
  name: MotionName;
  reduceMotion: boolean;
  className?: string;
}) {
  const base = `/animations/${name}`;
  return (
    <picture className={`motion-art ${className}`} aria-hidden="true">
      <source media="(prefers-reduced-motion: reduce)" srcSet={`${base}-poster.png`} />
      {!reduceMotion && <source type="image/webp" srcSet={`${base}.webp`} />}
      <img src={reduceMotion ? `${base}-poster.png` : `${base}.apng`} width="384" height="256" alt="" />
    </picture>
  );
}

export function MotionCue({ cue, reduceMotion }: { cue: Cue | null; reduceMotion: boolean }) {
  return cue ? (
    <div className="motion-cue" aria-hidden="true">
      <MotionArt key={cue.id} name={cue.name} reduceMotion={reduceMotion} />
    </div>
  ) : null;
}
