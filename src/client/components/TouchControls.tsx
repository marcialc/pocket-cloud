import { useEffect, useRef, useState, type PointerEvent } from "react";
import { PLATFORMS, buttonLabel, type Button, type PlatformId } from "../../shared/platforms";
import type { Emulator } from "../emulator/Emulator";
import { dpadDirections, type Direction } from "./dpad";

type Props = { emulator: Emulator | null; platform: PlatformId; haptics: boolean };

function buzz(on: boolean) {
  if (on) navigator.vibrate?.(8);
}

/**
 * On-screen gamepad for phones (shown via CSS on coarse pointers / narrow
 * screens). Every control tracks its own pointer, so presses combine
 * (multi-touch): hold a direction and tap A at the same time.
 */
export function TouchControls({ emulator, platform, haptics }: Props) {
  const buttons = PLATFORMS[platform].buttons;
  const face = (["y", "x", "b", "a", "c"] as const).filter((b) => buttons.includes(b));
  const shoulders = (["l", "l2", "r2", "r"] as const).filter((b) => buttons.includes(b));
  const menu = (["select", "start"] as const).filter((b) => buttons.includes(b));
  const layout = buttons.includes("x") ? " diamond" : buttons.includes("c") ? " trio" : "";
  const touchButton = (button: Button, className: string) => (
    <TouchButton
      key={button}
      emulator={emulator}
      haptics={haptics}
      button={button}
      label={buttonLabel(platform, button).toUpperCase()}
      className={className}
    />
  );
  const held = useRef(new Set<Direction>());
  const [dirs, setDirs] = useState<Set<Direction>>(new Set());
  const root = useRef<HTMLDivElement>(null);

  // iOS Safari still starts a text selection (and its loupe) on a long press
  // even with user-select: none; only cancelling touchstart stops it. React
  // attaches touch listeners as passive, so this needs a native listener.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const stop = (e: TouchEvent) => e.preventDefault();
    el.addEventListener("touchstart", stop, { passive: false });
    return () => el.removeEventListener("touchstart", stop);
  }, []);

  const setDirections = (next: Set<Direction>) => {
    if (!emulator) return;
    let added = false;
    for (const d of held.current) if (!next.has(d)) emulator.buttonUp(d);
    for (const d of next)
      if (!held.current.has(d)) {
        emulator.buttonDown(d);
        added = true;
      }
    if (added) buzz(haptics);
    held.current = next;
    setDirs(next);
  };

  const onDpad = (e: PointerEvent<HTMLDivElement>) => {
    if (e.type === "pointerdown") e.currentTarget.setPointerCapture(e.pointerId);
    if (e.type !== "pointerdown" && !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    // The box is the drawn pad; its invisible hit area (CSS ::before) reaches further.
    const r = e.currentTarget.getBoundingClientRect();
    setDirections(dpadDirections(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2), held.current));
    e.preventDefault();
  };

  const releaseDpad = () => setDirections(new Set());

  return (
    <div ref={root} className={`touch-controls${shoulders.length ? " has-shoulders" : ""}`} onContextMenu={(e) => e.preventDefault()}>
      {shoulders.length > 0 && <div className="shoulder-buttons">{shoulders.map((b) => touchButton(b, `shoulder ${b}`))}</div>}
      <div
        className="dpad"
        onPointerDown={onDpad}
        onPointerMove={onDpad}
        onPointerUp={releaseDpad}
        onPointerCancel={releaseDpad}
        role="group"
        aria-label="Direction pad"
      >
        <span className="dpad-well" aria-hidden />
        {(["up", "down", "left", "right"] as const).map((d) => (
          <span key={d} className={`dpad-arm ${d}${dirs.has(d) ? " on" : ""}`} aria-hidden />
        ))}
        <span className="dpad-hub" aria-hidden />
      </div>
      <div className={`face-buttons${layout}`}>{face.map((b) => touchButton(b, `round ${b}`))}</div>
      <div className="menu-buttons">{menu.map((b) => touchButton(b, "pill"))}</div>
      <div className="grille" aria-hidden>
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function TouchButton({
  emulator,
  haptics,
  button,
  label,
  className,
}: {
  emulator: Emulator | null;
  haptics: boolean;
  button: Button;
  label: string;
  className: string;
}) {
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("pressed");
    buzz(haptics);
    emulator?.buttonDown(button);
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.remove("pressed");
    emulator?.buttonUp(button);
  };
  return (
    <div className={`touch-btn-wrap ${className}`}>
      <button
        type="button"
        className="touch-btn"
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label={label}
        tabIndex={-1}
      />
      <span aria-hidden>{label}</span>
    </div>
  );
}
