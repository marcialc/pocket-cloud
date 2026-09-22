import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

type Props = {
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Controls handles Escape itself (it cancels rebinding first). */
  handleEscape?: boolean;
};

/** Plastic panel sliding in from the right (a bottom sheet on phones). */
export function SidePanel({ id, title, onClose, children, footer, handleEscape = true }: Props) {
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    if (!handleEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleEscape, onClose]);

  return (
    <div className="backdrop side" onClick={onClose}>
      <aside
        ref={panel}
        className="side-panel plastic"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="side-head">
          <h2 id={id} className="px">
            {title}
          </h2>
          <button type="button" className="ibtn" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="side-body">{children}</div>
        {footer && <div className="side-foot">{footer}</div>}
      </aside>
    </div>
  );
}
