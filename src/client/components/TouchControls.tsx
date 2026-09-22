import { useRef, useState, type PointerEvent } from "react";
import type { GameBoyButton, GameBoyEmulator } from "../emulator/GameBoyEmulator";

type Props = { emulator: GameBoyEmulator | null; haptics: boolean };
type Direction = "up" | "down" | "left" | "right";
const DEADZONE = 0.25;

function buzz(on: boolean) {
  if (on) navigator.vibrate?.(8);
}

/**
 * On-screen gamepad for phones (shown via CSS on coarse pointers / narrow
 * screens). Every control tracks its own pointer, so presses combine
 * (multi-touch): hold a direction and tap A at the same time.
 */
export function TouchControls({ emulator, haptics }: Props) {
  const held = useRef(new Set<Direction>());
  const [dirs, setDirs] = useState<Set<Direction>>(new Set());

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
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = ((e.clientY - r.top) / r.height) * 2 - 1;
    const next = new Set<Direction>();
    // Diagonals allowed when both axes are clearly pressed.
    if (Math.abs(x) > DEADZONE && Math.abs(x) > Math.abs(y) * 0.5) next.add(x < 0 ? "left" : "right");
    if (Math.abs(y) > DEADZONE && Math.abs(y) > Math.abs(x) * 0.5) next.add(y < 0 ? "up" : "down");
    setDirections(next);
    e.preventDefault();
  };

  const releaseDpad = () => setDirections(new Set());

  return (
    <div className="touch-controls" onContextMenu={(e) => e.preventDefault()}>
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
      <div className="face-buttons">
        <TouchButton emulator={emulator} haptics={haptics} button="b" label="B" className="round b" />
        <TouchButton emulator={emulator} haptics={haptics} button="a" label="A" className="round a" />
      </div>
      <div className="menu-buttons">
        <TouchButton emulator={emulator} haptics={haptics} button="select" label="SELECT" className="pill" />
        <TouchButton emulator={emulator} haptics={haptics} button="start" label="START" className="pill" />
      </div>
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
  emulator: GameBoyEmulator | null;
  haptics: boolean;
  button: GameBoyButton;
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
