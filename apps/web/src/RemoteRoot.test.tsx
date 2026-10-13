import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, expect, it, vi} from "vitest";
import { RemoteRoot } from "./RemoteRoot";
import { ThemeProvider } from "./theme/ThemeProvider";
import { createDirectTransport } from "./services/directTransport";
import { saveDirectProfile, type DirectProfile } from "./services/directProfiles";

vi.mock("./App", () => ({App: () => <div>Connected conversation</div>}));
vi.mock("./services/directTransport", () => ({createDirectTransport: vi.fn()}));
const profile: DirectProfile = {endpoint: "https://station.example", installationId: "station", hostPublicKey: "a".repeat(64), privateKey: new Uint8Array(32), label: "Station", pair: {sessionId: "browser", installationId: "station", sessionToken: "token", csrfToken: "csrf", protocolVersion: 2}};
const fragment = () => `#directPair=${btoa(JSON.stringify({endpoint: profile.endpoint, installationId: profile.installationId, hostPublicKey: profile.hostPublicKey, nonce: "b".repeat(64)}))}`;
afterEach(() => {vi.clearAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, "", "/");});

it("lists and connects saved hosts while every cloud request fails", async () => {
  await saveDirectProfile(profile);
  const fetch = vi.fn(async () => {throw new Error("cloud unavailable");});
  vi.stubGlobal("fetch", fetch);
  const dispose = vi.fn();
  vi.mocked(createDirectTransport).mockResolvedValue({profile, transport: {request: vi.fn(), openEvents: vi.fn(), dispose}});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  expect(await screen.findByText("Connected conversation")).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: "Computers"}));
  expect(dispose).toHaveBeenCalled();
  expect(await screen.findByRole("button", {name: "Connect"})).toBeInTheDocument();
});

it("requires a user action before connecting a consumed pairing fragment", async () => {
  history.replaceState(null, "", `/${fragment()}`);
  vi.mocked(createDirectTransport).mockImplementation(async () => {await saveDirectProfile(profile); return {profile, transport: {request: vi.fn(), openEvents: vi.fn()}};});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  expect(location.hash).toBe("");
  expect(createDirectTransport).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", {name: "Pair and connect"}));
  expect(await screen.findByText("Connected conversation")).toBeInTheDocument();
});

it("preserves profiles when a protocol mismatch prevents connection", async () => {
  await saveDirectProfile(profile);
  vi.mocked(createDirectTransport).mockRejectedValue(new Error("protocol_mismatch"));
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  expect(await screen.findByRole("status")).toHaveTextContent("pairing and drafts are preserved");
  expect(screen.getByRole("button", {name: "Connect"})).toBeEnabled();
});

it("aborts an old connection when another pairing fragment arrives", async () => {
  await saveDirectProfile(profile);
  vi.mocked(createDirectTransport).mockImplementation(() => new Promise(() => {}));
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  const signal = vi.mocked(createDirectTransport).mock.calls[0][0].signal;
  act(() => {history.replaceState(null, "", `/${fragment()}`); window.dispatchEvent(new HashChangeEvent("hashchange"));});
  await waitFor(() => expect(signal?.aborted).toBe(true));
  expect(screen.getByRole("button", {name: "Pair and connect"})).toBeEnabled();
});

it("requires explicit opt-in on Apple before pairing or connecting", async () => {
  await saveDirectProfile(profile);
  vi.stubGlobal("navigator", {userAgent: "Mozilla Macintosh Mac OS X", platform: "MacIntel", maxTouchPoints: 0});
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  expect(screen.getByText("Apple support is experimental")).toBeInTheDocument();
  expect(screen.queryByRole("button", {name: "Connect"})).toBeNull();
  await userEvent.click(screen.getByRole("button", {name: "Enable experimental Apple support"}));
  expect(await screen.findByRole("button", {name: "Connect"})).toBeInTheDocument();
  expect(createDirectTransport).not.toHaveBeenCalled();
});

it("deletes saved history when the pinned host reports a revoked pairing during connection", async () => {
  const {OfflineHistoryStore} = await import("./services/offlineHistory");
  const {directDraftScope} = await import("./services/directProfiles");
  const {EMPTY_PROJECTION} = await import("./services/sessionProjection");
  await saveDirectProfile(profile);
  const store = new OfflineHistoryStore(directDraftScope(profile));
  await store.enable(); await store.save("s", {...EMPTY_PROJECTION, transcript: [{id: "m", role: "user", text: "private saved copy", seq: 1}]}, (await store.load()).epoch);
  vi.mocked(createDirectTransport).mockRejectedValue(new Error("revoked"));
  render(<ThemeProvider><RemoteRoot /></ThemeProvider>);
  await userEvent.click(await screen.findByRole("button", {name: "Connect"}));
  expect(await screen.findByRole("status")).toHaveTextContent("was revoked");
  expect((await store.load())).toMatchObject({enabled: false, conversations: []});
});
