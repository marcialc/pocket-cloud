import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

/**
 * Small single-series charts for the admin page, drawn as SVG at the
 * container's pixel width (so text isn't stretched). One hue (--chart), thin
 * marks with a 4px rounded data end, hairline grid, per-mark hover and
 * keyboard tooltips. The page also has a table of every value.
 */

const number = new Intl.NumberFormat();

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A clean axis maximum (1, 2, 5 × 10ⁿ) at or above `max`. */
function niceMax(max: number): number {
  if (max <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= max) return m * step;
  return 10 * step;
}

/** A bar with 4px rounded ends away from the baseline (top for columns). */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function rowPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

const HEIGHT = 140;
const PAD = { top: 8, right: 4, bottom: 20, left: 32 };

export function ColumnChart({ label, points }: { label: string; points: { day: string; value: number }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const band = points.length ? plotW / points.length : 0;
  // Bars never fill the band: at most 24px, with at least a 2px gap between neighbours.
  const barW = Math.max(1, Math.min(24, band - 2));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(points.length / Math.max(1, Math.floor(plotW / 64)));

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const from = active ?? (e.key === "ArrowLeft" ? points.length : -1);
    setActive(Math.max(0, Math.min(points.length - 1, from + (e.key === "ArrowLeft" ? -1 : 1))));
  };

  const point = active !== null ? points[active] : undefined;
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${label} per day; use the arrow keys to read each day`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="axis-text" x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end">
                {number.format(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const x = PAD.left + i * band;
            const h = (p.value / max) * plotH;
            return (
              <g key={p.day}>
                {h > 0 && (
                  <path className={active === i ? "mark on" : "mark"} d={columnPath(x + (band - barW) / 2, y(p.value), barW, h)} />
                )}
                {/* The whole band is the hit target, not just the painted bar. */}
                <rect x={x} y={PAD.top} width={band} height={plotH} fill="transparent" onPointerMove={() => setActive(i)} />
                {i % labelEvery === (points.length - 1) % labelEvery && (
                  <text className="axis-text" x={x + band / 2} y={HEIGHT - 4} textAnchor="middle">
                    {shortDay(p.day)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {point && active !== null && (
        <div
          className="tooltip"
          role="status"
          style={{
            left: Math.min(Math.max(PAD.left + (active + 0.5) * band, 60), width - 60),
            top: Math.max(0, y(point.value) - 8),
          }}
        >
          <strong>{number.format(point.value)}</strong>
          <span>{shortDay(point.day)}</span>
        </div>
      )}
    </div>
  );
}

const ROW_H = 28;
const BAR_H = 16;

/** Horizontal bars, value at each bar's tip. */
export function HBarChart({ rows }: { rows: { label: string; value: number; detail?: string }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const labelW = Math.min(150, width * 0.4);
  const valueW = 48;
  const plotW = Math.max(0, width - labelW - valueW);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={rows.length * ROW_H} role="img" aria-label="Players by platform">
          {rows.map((r, i) => {
            const w = (r.value / max) * plotW;
            const top = i * ROW_H;
            return (
              <g key={r.label}>
                <title>{`${r.label}: ${number.format(r.value)} players${r.detail ? `, ${r.detail}` : ""}`}</title>
                <text className="bar-label" x={0} y={top + ROW_H / 2} dy="0.32em">
                  {r.label}
                </text>
                {w > 0 && <path className="mark" d={rowPath(labelW, top + (ROW_H - BAR_H) / 2, w, BAR_H)} />}
                <text className="bar-value" x={labelW + w + 6} y={top + ROW_H / 2} dy="0.32em">
                  {number.format(r.value)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
