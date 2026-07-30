/**
 * The permission dialog is where a wrong label becomes durable authority, so
 * these assert what the user can and cannot click, not how it looks.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermissionDialog } from "./PermissionDialog";

const FULL_NATIVE_OFFER = [
  "always-allow",
  "allow-once",
  "reject-once",
  "reject-always",
];

describe("PermissionDialog", () => {
  it("renders only the single-use options when the agent also offers persistent ones", () => {
    render(
      <PermissionDialog
        prompt={{ sessionId: "s-1", requestId: "perm-1", options: FULL_NATIVE_OFFER }}
        onDecide={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Allow once" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();

    // The agent offered these; Light must never put them on screen.
    expect(screen.queryByRole("button", { name: /always/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reject always/i })).not.toBeInTheDocument();
  });

  it("shows the session-scoped edit option only when the agent offers it", () => {
    const { rerender } = render(
      <PermissionDialog
        prompt={{ sessionId: "s-1", requestId: "perm-1", options: ["allow-once", "reject-once"] }}
        onDecide={vi.fn()}
        busy={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /allow edits this session/i }),
    ).not.toBeInTheDocument();

    rerender(
      <PermissionDialog
        prompt={{
          sessionId: "s-1",
          requestId: "perm-1",
          options: ["allow-once", "allow-edits-session", "reject-once"],
        }}
        onDecide={vi.fn()}
        busy={false}
      />,
    );
    expect(
      screen.getByRole("button", { name: /allow edits this session/i }),
    ).toBeInTheDocument();
  });

  it("answers with the exact native option identifier", async () => {
    const onDecide = vi.fn();
    render(
      <PermissionDialog
        prompt={{ sessionId: "s-1", requestId: "perm-1", options: FULL_NATIVE_OFFER }}
        onDecide={onDecide}
        busy={false}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).toHaveBeenCalledWith("allow-once");
  });

  it("names the incompatibility instead of showing a deny-only dialog", () => {
    // No single-use option offered: a lone "Deny" would read as a Light bug.
    render(
      <PermissionDialog
        prompt={{ sessionId: "s-1", requestId: "perm-1", options: ["always-allow", "reject-always"] }}
        onDecide={vi.fn()}
        busy={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument();
    expect(screen.getByText(/standing grant/i)).toBeInTheDocument();
    expect(screen.getByText(/always-allow, reject-always/)).toBeInTheDocument();
  });

  it("states that the decision applies once and cannot be made standing", () => {
    render(
      <PermissionDialog
        prompt={{ sessionId: "s-1", requestId: "perm-1", options: FULL_NATIVE_OFFER }}
        onDecide={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText(/this request only/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot grant\s+standing permission/i)).toBeInTheDocument();
  });

  it("is an alert dialog with an accessible name and takes focus", () => {
    render(
      <PermissionDialog
        prompt={{ sessionId: "s-1", requestId: "perm-1", options: FULL_NATIVE_OFFER }}
        onDecide={vi.fn()}
        busy={false}
      />,
    );
    const dialog = screen.getByRole("alertdialog", {
      name: /asking permission/i,
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveFocus();
  });

  it("does not accept a second answer while one is in flight", async () => {
    const onDecide = vi.fn();
    render(
      <PermissionDialog
        prompt={{ sessionId: "s-1", requestId: "perm-1", options: FULL_NATIVE_OFFER }}
        onDecide={onDecide}
        busy
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).not.toHaveBeenCalled();
  });
});
