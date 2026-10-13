import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LightClient } from "./client";
import { publicationCommand, PublicationUncertain, rememberPublicationAuthorization, takePublicationCallback } from "./publications";

const nonce = "n".repeat(43);
const code = "c".repeat(43);
const request = () => ({ outcome: "publicationAuthorization", url: `https://fabrials.com/account/publications/authorize#publication_nonce=${nonce}`, nonce, expiresAt: Date.now() + 300_000 });
beforeEach(() => { sessionStorage.clear(); history.replaceState(null, "", "/"); });

describe("publication authorization binding", () => {
  it("consumes the callback immediately and preserves the specific host profile binding", () => {
    rememberPublicationAuthorization(request(), "profile-a");
    history.replaceState(null, "", `/#publication_code=${code}&publication_nonce=${nonce}`);
    expect(takePublicationCallback()).toEqual({ code, nonce, profileId: "profile-a", expiresAt: expect.any(Number) });
    expect(location.hash).toBe("");
    expect(sessionStorage.length).toBe(0);
    history.replaceState(null, "", `/#publication_code=${code}&publication_nonce=${nonce}`);
    expect(takePublicationCallback()).toHaveProperty("error");
    expect(location.hash).toBe("");
  });
  it("rejects mismatched, expired, duplicate and unsolicited codes without retaining the fragment", () => {
    for (const fragment of [`#publication_code=${code}&publication_nonce=${"z".repeat(43)}`, `#publication_code=${code}&publication_nonce=${nonce}&publication_code=${code}`]) {
      rememberPublicationAuthorization(request(), "profile-a");
      history.replaceState(null, "", fragment);
      expect(takePublicationCallback()).toHaveProperty("error");
      expect(location.hash).toBe("");
    }
    rememberPublicationAuthorization(request(), "profile-a");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 400_000);
    history.replaceState(null, "", `/#publication_code=${code}&publication_nonce=${nonce}`);
    expect(takePublicationCallback()).toHaveProperty("error");
    vi.restoreAllMocks();
  });
  it("accepts only the exact Fabrials authorization address", () => {
    for (const url of ["https://evil.test/account/publications/authorize", "https://fabrials.com/account/publications/authorize?next=evil", "https://fabrials.com:444/account/publications/authorize", "https://user@fabrials.com/account/publications/authorize"]) expect(() => rememberPublicationAuthorization({ ...request(), url: `${url}#publication_nonce=${nonce}` }, "profile-a")).toThrow();
    expect(sessionStorage.length).toBe(0);
  });
  it("leaves pairing fragments for the pairing handler", () => {
    history.replaceState(null, "", "/#directPair=synthetic");
    expect(takePublicationCallback()).toBeNull();
    expect(location.hash).toBe("#directPair=synthetic");
  });
});

describe("publication command receipts", () => {
  it("queries the receipt after a transport failure and never replays the write", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce({ ok: true, value: { outcome: "publicationCommand", state: "completed", result: { outcome: "publicationStopped", accessRevoked: true } } });
    expect(await publicationCommand({send} as unknown as LightClient, {kind: "stopPublication", publicationId: "id"})).toHaveProperty("accessRevoked", true);
    expect(send.mock.calls.map(call => call[0].kind)).toEqual(["stopPublication", "getPublicationCommandStatus"]);
    expect(send.mock.calls[1][0].idempotencyKey).toBe(send.mock.calls[0][1].idempotencyKey);
  });
  it("keeps an unresolved receipt for explicit status checks", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, value: { outcome: "publicationCommand", state: "needsReview" } });
    await expect(publicationCommand({send} as unknown as LightClient, {kind: "stopPublication", publicationId: "id"})).rejects.toBeInstanceOf(PublicationUncertain);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
