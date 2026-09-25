/**
 * Host feedback toasts (sonner), themed with Portable design tokens.
 *
 * Ephemeral host refusals use this instead of full-width sticky banners so
 * layout does not shift and the message does not survive Home ↔ session nav.
 */

import { Toaster, toast } from "sonner";

/** Short-lived host notice; auto-dismisses without layout shift. */
export function showHostToast(message: string): void {
  toast(message, {
    duration: 4000,
  });
}

/** Fixed region for host toasts; mount once under ThemeProvider. */
export function HostToaster() {
  return (
    <Toaster
      position="top-center"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            "border border-border bg-card text-foreground shadow-overlay font-sans text-body",
          title: "text-body text-foreground font-medium",
          description: "text-body-sm text-muted-foreground",
          closeButton:
            "border border-border bg-card text-muted-foreground hover:bg-muted",
        },
      }}
    />
  );
}
