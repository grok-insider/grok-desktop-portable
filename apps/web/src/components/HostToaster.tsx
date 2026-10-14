/**
 * Host feedback toasts on the Fabrials toaster.
 *
 * Ephemeral host refusals use this instead of full-width sticky banners so
 * layout does not shift and the message does not survive Home ↔ session nav.
 */

import { Toaster, toast } from "@fabrials/ui";

/** Short-lived host notice; auto-dismisses without layout shift. */
export function showHostToast(message: string): void {
  toast(message, {
    duration: 4000,
  });
}

/** Fixed region for host toasts; mount once under ThemeProvider. */
export function HostToaster() {
  return <Toaster position="top-center" closeButton />;
}
