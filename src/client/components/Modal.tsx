import { useEffect, type ReactNode } from "react";

/** Centered plastic dialog over a dimmed page. Esc or a backdrop click closes it. */
export function Modal({
  labelledBy,
  onClose,
  children,
  className = "",
  role = "dialog",
}: {
  labelledBy: string;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
  role?: "dialog" | "alertdialog";
}) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className={`dialog plastic enter ${className}`}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
