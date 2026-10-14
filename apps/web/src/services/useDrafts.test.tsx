import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftStore, forgetDraftScope, DRAFT_CHANGED, type DraftSnapshot } from "./drafts";
import { useDrafts } from "./useDrafts";

beforeEach(() => {localStorage.clear(); vi.stubEnv("VITE_REMOTE_EXPERIMENTS", "drafts");});
afterEach(() => {vi.unstubAllEnvs(); vi.restoreAllMocks();});
function deferred<T>() {let resolve!: (value: T) => void;let reject!: (error: Error) => void;const promise = new Promise<T>((yes, no) => {resolve = yes;reject = no;});return {promise, resolve, reject};}
async function ready(hook: ReturnType<typeof renderHook<ReturnType<typeof useDrafts>, unknown>>) {await waitFor(() => expect(hook.result.current.busy).toBe(false));}

describe("draft recovery integration", () => {
  it("requires opt-in and restores after remount", async () => {
    const first = renderHook(() => useDrafts("scope"));
    await ready(first);
    act(() => first.result.current.updateDraft("session", "unsent"));
    expect(await new DraftStore("scope").read()).toEqual({});
    await act(async () => first.result.current.remember(true));
    first.unmount();
    const second = renderHook(() => useDrafts("scope"));
    await ready(second);
    expect(second.result.current.enabled).toBe(true);
    expect(second.result.current.drafts).toEqual({session: "unsent"});
  });
  it("does not put a previous account's state into a changed scope", async () => {
    const first = new DraftStore("account-one"); await first.enable({session: "one"});
    const second = new DraftStore("account-two"); await second.enable({session: "two"});
    const hook = renderHook(({scope}) => useDrafts(scope), {initialProps: {scope: "account-one"}});
    await waitFor(() => expect(hook.result.current.drafts).toEqual({session: "one"}));
    hook.rerender({scope: "account-two"});
    expect(hook.result.current.drafts).toEqual({});
    await waitFor(() => expect(hook.result.current.drafts).toEqual({session: "two"}));
    act(() => hook.result.current.updateDraft("session", "two changed"));
    await waitFor(() => expect(hook.result.current.status).toBe("saved"));
    expect(await first.read()).toEqual({session: "one"});
    expect(await second.read()).toEqual({session: "two changed"});
  });
  it("keeps text typed while recovery is delayed and saves that latest version", async () => {
    const pending = deferred<DraftSnapshot>();
    await new DraftStore("scope").enable({session: "old"});
    vi.spyOn(DraftStore.prototype, "load").mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useDrafts("scope"));
    act(() => hook.result.current.updateDraft("session", "new"));
    const restored = await new DraftStore("scope").load();
    await act(async () => pending.resolve(restored));
    await waitFor(() => expect(hook.result.current.status).toBe("saved"));
    expect(hook.result.current.drafts).toEqual({session: "new"});
    expect(await new DraftStore("scope").read()).toEqual({session: "new"});
  });
  it("ignores obsolete recovery across account A to B to A", async () => {
    const pending = deferred<DraftSnapshot>();
    vi.spyOn(DraftStore.prototype, "load").mockReturnValueOnce(pending.promise);
    const hook = renderHook(({scope}) => useDrafts(scope), {initialProps: {scope: "A"}});
    hook.rerender({scope: "B"});
    hook.rerender({scope: "A"});
    await waitFor(() => expect(hook.result.current.busy).toBe(false));
    act(() => hook.result.current.updateDraft("session", "current"));
    await act(async () => pending.resolve({enabled: true, epoch: "old", drafts: {session: "obsolete"}}));
    expect(hook.result.current.drafts).toEqual({session: "current"});
    expect(hook.result.current.enabled).toBe(false);
  });
  it("deletes durable copies while keeping current unsent text on opt-out", async () => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    await act(async () => hook.result.current.remember(true));
    act(() => hook.result.current.updateDraft("session", "keep in memory"));
    await act(async () => hook.result.current.remember(false));
    expect(hook.result.current.drafts).toEqual({session: "keep in memory"});
    expect(await new DraftStore("scope").read()).toEqual({});
    expect(hook.result.current.enabled).toBe(false);
  });
  it("immediately clears memory on revocation without touching another scope", async () => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    await act(async () => hook.result.current.remember(true));
    act(() => hook.result.current.updateDraft("session", "erase"));
    const other = new DraftStore("other"); await other.enable({session: "keep"});
    let pending!: Promise<void>;
    act(() => {pending = forgetDraftScope("scope");});
    expect(hook.result.current.enabled).toBe(false);
    expect(hook.result.current.drafts).toEqual({});
    await act(async () => pending);
    expect(await other.read()).toEqual({session: "keep"});
    expect(await new DraftStore("scope").read()).toEqual({});
  });
  it("coalesces pending edits and never labels an uncommitted latest edit saved", async () => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    await act(async () => hook.result.current.remember(true));
    const pending = deferred<void>();
    const writes = vi.spyOn(DraftStore.prototype, "write").mockReturnValueOnce(pending.promise);
    act(() => {hook.result.current.updateDraft("session", "first");for (let index = 0;index < 1000;index++) hook.result.current.updateDraft("session", String(index));});
    expect(hook.result.current.status).toBe("saving");
    expect(writes).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    await waitFor(() => expect(hook.result.current.status).toBe("saved"));
    expect(writes).toHaveBeenCalledTimes(2);
    expect(await new DraftStore("scope").read()).toEqual({session: "999"});
  });
  it("does not claim a refused latest edit was saved when an older write finishes", async () => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    await act(async () => hook.result.current.remember(true));
    const pending = deferred<void>();
    vi.spyOn(DraftStore.prototype, "write").mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.updateDraft("session", "old"));
    const latest = "x".repeat(4 * 1024 * 1024 + 1);
    act(() => hook.result.current.updateDraft("session", latest));
    await act(async () => pending.resolve());
    expect(hook.result.current.status).toBe("failed");
    expect(hook.result.current.drafts.session).toBe(latest);
  });
  it("retains unsaved changes on quota failure and clears failure after a successful retry", async () => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    await act(async () => hook.result.current.remember(true));
    vi.spyOn(DraftStore.prototype, "write").mockRejectedValueOnce(new DOMException("Full", "QuotaExceededError"));
    act(() => hook.result.current.updateDraft("session", "not persisted"));
    await waitFor(() => expect(hook.result.current.status).toBe("failed"));
    expect(hook.result.current.drafts).toEqual({session: "not persisted"});
    expect(hook.result.current.notice).toMatch(/could not be saved/);
    act(() => hook.result.current.updateDraft("session", "new persisted"));
    await waitFor(() => expect(hook.result.current.status).toBe("saved"));
    expect(hook.result.current.notice).toBeUndefined();
  });
  it("persists edits made while consent is committing", async () => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    const pending = deferred<DraftSnapshot>();
    const original = DraftStore.prototype.enable;
    vi.spyOn(DraftStore.prototype, "enable").mockReturnValueOnce(pending.promise);
    let enabling!: Promise<void>;
    act(() => {hook.result.current.updateDraft("session", "initial");enabling = hook.result.current.remember(true);});
    act(() => hook.result.current.updateDraft("session", "latest"));
    expect(hook.result.current.status).toBe("saving");
    const snapshot = await original.call(new DraftStore("scope"), {session: "initial"});
    await act(async () => {pending.resolve(snapshot);await enabling;});
    await waitFor(() => expect(hook.result.current.status).toBe("saved"));
    expect(await new DraftStore("scope").read()).toEqual({session: "latest"});
  });
  it.each(["resolve", "reject"] as const)("ignores an obsolete consent %s during a newer consent operation", async outcome => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    const first = deferred<DraftSnapshot>();
    const second = deferred<DraftSnapshot>();
    vi.spyOn(DraftStore.prototype, "enable").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let oldConsent!: Promise<void>;
    act(() => {oldConsent = hook.result.current.remember(true);});
    await act(async () => forgetDraftScope("scope"));
    let nextConsent!: Promise<void>;
    act(() => {nextConsent = hook.result.current.remember(true);});
    await act(async () => {
      if (outcome === "resolve") first.resolve({enabled: true, epoch: "old", drafts: {}});
      else first.reject(new Error("old failed"));
      await oldConsent;
    });
    expect(hook.result.current.busy).toBe(true);
    expect(hook.result.current.status).toBe("saving");
    await act(async () => {second.resolve({enabled: true, epoch: "new", drafts: {}});await nextConsent;});
    expect(hook.result.current.enabled).toBe(true);
    expect(hook.result.current.status).toBe("saved");
  });
  it("ignores an unknown delayed revocation for an older consent epoch", async () => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    await act(async () => hook.result.current.remember(true));
    const old = await new DraftStore("scope").load();
    await act(async () => hook.result.current.remember(false));
    act(() => hook.result.current.updateDraft("session", "new consent"));
    await act(async () => hook.result.current.remember(true));
    act(() => window.dispatchEvent(new CustomEvent(DRAFT_CHANGED, {detail: {scope: "scope", enabled: false, revoked: true, operationId: "previously unseen", epoch: old.epoch}})));
    expect(hook.result.current.enabled).toBe(true);
    expect(hook.result.current.drafts).toEqual({session: "new consent"});
    expect(hook.result.current.status).toBe("saved");
  });
  it("never accepts a late write result after revocation", async () => {
    const hook = renderHook(() => useDrafts("scope"));
    await ready(hook);
    await act(async () => hook.result.current.remember(true));
    const pending = deferred<void>();
    vi.spyOn(DraftStore.prototype, "write").mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.updateDraft("session", "erase"));
    await act(async () => forgetDraftScope("scope"));
    await act(async () => pending.resolve());
    expect(hook.result.current.status).toBe("off");
    expect(hook.result.current.drafts).toEqual({});
  });
});
