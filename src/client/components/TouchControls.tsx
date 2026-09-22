import { useRef, type PointerEvent } from "react";
import type { GameBoyButton, GameBoyEmulator } from "../emulator/GameBoyEmulator";

type Props = { emulator: GameBoyEmulator | null };
type Direction = "up" | "down" | "left" | "right";
const DEADZONE = 0.25;

/** On-screen gamepad for touch devices (shown via CSS on coarse pointers). */
export function TouchControls({ emulator }: Props) {
  const held = useRef(new Set<Direction>());

  const setDirections = (next: Set<Direction>) => {
    if (!emulator) return;
    for (const d of held.current) if (!next.has(d)) emulator.buttonUp(d);
    for (const d of next) if (!held.current.has(d)) emulator.buttonDown(d);
    held.current = next;
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
        aria-label="Direction pad"
      >
        <span className="dpad-h" />
        <span className="dpad-v" />
      </div>
      <div className="face-buttons">
        <TouchButton emulator={emulator} button="b" label="B" className="round b" />
        <TouchButton emulator={emulator} button="a" label="A" className="round a" />
      </div>
      <div className="menu-buttons">
        <TouchButton emulator={emulator} button="select" label="SELECT" className="pill" />
        <TouchButton emulator={emulator} button="start" label="START" className="pill" />
      </div>
    </div>
  );
}

function TouchButton({
  emulator,
  button,
  label,
  className,
}: {
  emulator: GameBoyEmulator | null;
  button: GameBoyButton;
  label: string;
  className: string;
}) {
  const down = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add("pressed");
    emulator?.buttonDown(button);
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.classList.remove("pressed");
    emulator?.buttonUp(button);
  };
  return (
    <div className={`touch-btn-wrap ${className}`}>
      <button
        className="touch-btn"
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        aria-label={label}
        tabIndex={-1}
      />
      <span>{label}</span>
    </div>
  );
}
