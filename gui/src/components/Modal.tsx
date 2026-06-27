import { type ReactNode } from "react";
import s from "./Modal.module.scss";

// The shared dialog shell: a click-to-dismiss backdrop over a centered box with
// a title, body, and an optional right-aligned actions footer. Used by the
// compose-ticket / new-idea modals and Review's reject-reason modal.
// `dismissOnBackdrop` (default true) can be set false for flows that must be
// closed via an explicit action (e.g. first-run onboarding).
export default function Modal({
  title,
  onClose,
  children,
  actions,
  dismissOnBackdrop = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  dismissOnBackdrop?: boolean;
}) {
  return (
    <div
      className={s.backdrop}
      onClick={dismissOnBackdrop ? onClose : undefined}
    >
      <div className={s.box} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
    </div>
  );
}
