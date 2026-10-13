import { describe, expect, it } from "vitest";
import { asBrowserDevices, asControlTransferRequest, asRemoteCapabilities, asRemoteProjects } from "./remoteControls";

describe("remote control wire projections", () => {
  it("requires advertised boolean capabilities and validates prompt support independently", () => {
    const value = {outcome: "remoteCapabilities", projects: true, controlTransfer: false, devicePanel: true};
    expect(asRemoteCapabilities(value)).toEqual(value);
    expect(asRemoteCapabilities({...value, upstreamPrompt: null})).not.toBeNull();
    expect(asRemoteCapabilities({...value, projects: "true"})).toBeNull();
    expect(asRemoteCapabilities({...value, upstreamPrompt: {image: false, audio: false}})).toBeNull();
    expect(asRemoteCapabilities({...value, upstreamPrompt: {image: false, audio: false, embeddedContext: true}})).not.toBeNull();
  });
  it("accepts bounded directory pages and rejects paths masquerading as identifiers", () => {
    const value = {outcome: "remoteProjects", parentId: "parent-id", entries: [{directoryId: "opaque-id", label: "Project"}], nextCursor: "cursor-id"};
    expect(asRemoteProjects(value)).toEqual(value);
    expect(asRemoteProjects({...value, entries: [{directoryId: "/home/secret", label: "Project"}]})).toBeNull();
    expect(asRemoteProjects({...value, entries: [...value.entries, ...value.entries]})).toBeNull();
    expect(asRemoteProjects({...value, entries: Array.from({length: 101}, (_, index) => ({directoryId: `entry-${index}`, label: "Project"}))})).toBeNull();
    expect(asRemoteProjects({...value, parentId: undefined})).toBeNull();
  });
  it("rejects invalid request identities and time values", () => {
    const request = {requestId: "request", sessionId: "browser", expiresAt: 1000};
    expect(asControlTransferRequest(request)).toEqual(request);
    expect(asControlTransferRequest({...request, expiresAt: Infinity})).toBeNull();
    expect(asControlTransferRequest({...request, expiresAt: "1000"})).toBeNull();
    expect(asControlTransferRequest({...request, requestId: ""})).toBeNull();
  });
  it("does not accept contradictory browser roles or invented last activity", () => {
    const device = {sessionId: "browser", currentBrowser: true, currentController: true, connected: true, connectionCount: 1, lastSeen: null};
    const value = {outcome: "browserDevices", devices: [device], controlTransferRequests: []};
    expect(asBrowserDevices(value)).toEqual(value);
    expect(asBrowserDevices({...value, devices: [device, {...device, sessionId: "other"}]})).toBeNull();
    expect(asBrowserDevices({...value, devices: [{...device, lastSeen: 1234}]})).toBeNull();
    expect(asBrowserDevices({...value, devices: [{...device, connectionCount: -1}]})).toBeNull();
    expect(asBrowserDevices({...value, controlTransferRequests: [{}]})).toBeNull();
  });
});
