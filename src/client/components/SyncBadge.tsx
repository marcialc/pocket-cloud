import type { SyncStatus } from "../saves/SaveSync";
import { formatIn, formatWhen } from "./format";
import { Icon, type IconName } from "./icons";

/** The four looks from the design. Every one pairs a color with an icon and a word. */
export type BadgeKind = "synced" | "syncing" | "offline" | "conflict";

const LOOK: Record<BadgeKind, { icon: IconName }> = {
  synced: { icon: "check" },
  syncing: { icon: "sync" },
  offline: { icon: "cloudOff" },
  conflict: { icon: "warn" },
};

export function Badge({ kind, label, className = "" }: { kind: BadgeKind; label: string; className?: string }) {
  return (
    <span className={`badge badge-${kind} ${className}`}>
      <Icon name={LOOK[kind].icon} size={13} className={kind === "syncing" ? "spin" : undefined} />
      {label}
    </span>
  );
}

/** Badge look, short label and a sentence (tooltip + screen readers) for a live sync status. */
export function describeStatus(status: SyncStatus): { kind: BadgeKind; label: string; detail: string } {
  switch (status.state) {
    case "idle":
      return { kind: "synced", label: "SYNCED", detail: "Cloud backup is on. Your save backs up after the game saves." };
    case "synced":
      return { kind: "synced", label: "SYNCED", detail: `Last synced ${formatWhen(status.at)}.` };
    case "saved-local":
      return { kind: "syncing", label: "SYNCING", detail: "Saved on this device. Backing up in a few seconds." };
    case "syncing":
      return { kind: "syncing", label: "SYNCING", detail: "Backing up your save…" };
    case "offline":
      return {
        kind: "offline",
        label: "OFFLINE",
        detail: `Can’t reach the cloud. Your save is safe here; retrying ${formatIn(status.retryAt)}.`,
      };
    case "local-only":
      return { kind: "offline", label: "DEVICE ONLY", detail: "Cloud backup is off. Saves stay in this browser." };
    case "conflict":
      return { kind: "conflict", label: "CONFLICT", detail: "This device and the cloud have different saves. Choose one." };
  }
}

/** Live sync badge next to the screen; opens the account panel. */
export function SyncBadge({ status, onClick }: { status: SyncStatus; onClick: () => void }) {
  const { kind, label, detail } = describeStatus(status);
  return (
    <button
      type="button"
      className={`badge badge-${kind} badge-button tip tip-below`}
      data-tip={detail}
      aria-label={`${label.toLowerCase()}. ${detail} Open saves and account.`}
      onClick={onClick}
    >
      <Icon name={LOOK[kind].icon} size={13} className={kind === "syncing" ? "spin" : undefined} />
      {label}
    </button>
  );
}
