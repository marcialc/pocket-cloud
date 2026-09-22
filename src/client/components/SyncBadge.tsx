import type { SyncStatus } from "../saves/SaveSync";

const LABELS: Record<SyncStatus["state"], string> = {
  idle: "Cloud ready",
  "local-only": "Saved on device",
  "saved-local": "Saved · syncing soon",
  syncing: "Syncing…",
  synced: "Saved",
  offline: "Offline · will retry",
  conflict: "Save conflict",
};

export function SyncBadge({ status, onClick }: { status: SyncStatus; onClick: () => void }) {
  const icon = status.state === "local-only" ? "▣" : "☁";
  return (
    <button className={`sync-badge state-${status.state}`} onClick={onClick} title="Save & cloud settings">
      <span aria-hidden>{icon}</span> {LABELS[status.state]}
    </button>
  );
}
