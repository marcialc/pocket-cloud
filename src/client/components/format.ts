export function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "in 20 s", "in 3 min" for a moment in the near future. */
export function formatIn(ms: number): string {
  const diff = Math.max(0, ms - Date.now());
  if (diff < 5_000) return "now";
  if (diff < 60_000) return `in ${Math.round(diff / 1000)} s`;
  return `in ${Math.round(diff / 60_000)} min`;
}

export function formatPlayTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  return h ? `${h}h ${minutes % 60}m` : `${minutes}m`;
}
