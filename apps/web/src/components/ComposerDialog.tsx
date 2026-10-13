import { createContext, useContext, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./ui";
import "./composer-dialog.css";

export const OptionalDialogsBlockedContext = createContext(false);

export function ComposerDialog({open, id, title, description, onClose, initialFocus, children}: {
  open: boolean;
  id?: string;
  title: string;
  description?: string;
  onClose: () => void;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const generatedId = useId();
  const dialogId = id ?? generatedId;
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const blocked = useContext(OptionalDialogsBlockedContext);
  const current = useRef({blocked, onClose});
  current.current = {blocked, onClose};
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!open || blocked) {
      if (dialog.open) dialog.close();
      if (!blocked && returnFocus.current?.isConnected) returnFocus.current.focus({preventScroll: true});
      returnFocus.current = null;
      if (open && blocked) current.current.onClose();
      return;
    }
    if (!returnFocus.current && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
    if (!dialog.open) dialog.showModal();
    (initialFocus?.current ?? heading.current)?.focus({preventScroll: true});
    return () => dialog.close();
  }, [open, blocked, initialFocus]);
  return createPortal(<dialog ref={ref} id={dialogId} aria-modal="true" aria-labelledby={`${dialogId}-title`} aria-describedby={description ? `${dialogId}-description` : undefined} className="composer-dialog" onCancel={event => {event.preventDefault();event.stopPropagation();onClose();}}>
    <header className="composer-dialog-header">
      <h2 ref={heading} tabIndex={-1} id={`${dialogId}-title`} className="text-title-sm font-semibold">{title}</h2>
      <IconButton aria-label={`Close ${title.toLowerCase()}`} title="Close" className="size-11" onClick={onClose}><X size={18} aria-hidden="true" /></IconButton>
    </header>
    <div className="composer-dialog-body">
      {description && <p id={`${dialogId}-description`} className="mb-4 text-body-sm text-muted-foreground">{description}</p>}
      {children}
    </div>
  </dialog>, document.body);
}
