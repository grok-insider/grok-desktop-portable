import {render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe, expect, it, vi} from "vitest";
import {SessionQueueStatus} from "./SessionQueueStatus";
import type {SessionExecution} from "../services/sessionExecution";

const base: SessionExecution = {outcome: "sessionExecution", sessionId: "s1", revision: 4, paused: true, uncertain: false, queue: [{entryId: "q1", text: "waiting", originDeviceId: "phone", state: "pending", images: []}]};

describe("shared queue controls", () => {
  it("confirms clear against the revision the user reviewed, even if another device adds a message", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const view = render(<SessionQueueStatus execution={base} enabled onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", {name: "Clear pending messages"}));
    view.rerender(<SessionQueueStatus execution={{...base, revision: 5, queue: [...base.queue, {...base.queue[0], entryId: "q2"}]}} enabled onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", {name: "Confirm clear"}));
    expect(onAction).toHaveBeenCalledExactlyOnceWith({kind: "clearQueuedPrompts", sessionId: "s1", expectedQueueRevision: 4});
  });

  it("reviews a specific uncertain turn without resuming its queue", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const execution: SessionExecution = {...base, uncertain: true, activeTurn: {turnId: "interrupted", state: "uncertain", originDeviceId: "phone"}};
    render(<SessionQueueStatus execution={execution} enabled={false} reviewEnabled onAction={onAction} />);
    expect(screen.getByRole("button", {name: "Resume queue"})).toBeDisabled();
    await userEvent.click(screen.getByRole("button", {name: "Review interrupted turn"}));
    expect(onAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", {name: "I reviewed the result"}));
    expect(onAction).toHaveBeenCalledExactlyOnceWith({kind: "reviewUncertainTurn", sessionId: "s1", expectedTurnId: "interrupted"});
  });

  it("holds a revoked device's queued messages and disables writes when disconnected", async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<SessionQueueStatus execution={{...base, queue: [{...base.queue[0], state: "originRevoked"}]}} enabled={false} onAction={onAction} />);
    expect(screen.getByRole("status")).toHaveTextContent("revoked device");
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    expect(onAction).not.toHaveBeenCalled();
  });
});
