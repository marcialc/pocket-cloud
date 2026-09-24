export type Direction = "up" | "down" | "left" | "right";

/** Thumb this close to the pad's center (in CSS px) presses nothing. */
export const DEADZONE_PX = 14;
/** Straight directions own ±33° around their axis, leaving diagonals 24°. */
const CARDINAL_HALF_ANGLE = 33;
/** A held press survives this many degrees past its sector's edge. */
const HYSTERESIS = 6;

/**
 * Which d-pad directions a thumb at (dx, dy) px from the pad's center presses.
 * Straight directions get wide sectors so an off-axis thumb doesn't slip into
 * a diagonal, and the current press is sticky so a thumb resting on a sector
 * edge doesn't flicker between two directions.
 */
export function dpadDirections(dx: number, dy: number, current: ReadonlySet<Direction>): Set<Direction> {
  if (Math.hypot(dx, dy) < DEADZONE_PX) return new Set();
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Degrees away from the nearest axis: 0 is straight, 45 is a pure diagonal.
  const offAxis = 45 - Math.abs((Math.abs(angle) % 90) - 45);
  const horizontal: Direction = dx < 0 ? "left" : "right";
  const vertical: Direction = dy < 0 ? "up" : "down";
  const nearest: Direction = Math.abs(dx) >= Math.abs(dy) ? horizontal : vertical;

  const wasCardinal = current.size === 1 && current.has(nearest);
  const wasDiagonal = current.size === 2 && current.has(horizontal) && current.has(vertical);
  const limit = wasCardinal
    ? CARDINAL_HALF_ANGLE + HYSTERESIS
    : wasDiagonal
      ? CARDINAL_HALF_ANGLE - HYSTERESIS
      : CARDINAL_HALF_ANGLE;
  return offAxis < limit ? new Set([nearest]) : new Set([horizontal, vertical]);
}
