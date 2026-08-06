import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AETHER_VISIBLE_KEY } from "../../services/aether/preference";
import { AvatarPresence } from "./AvatarPresence";

vi.mock("@aether/studio", () => ({
  createStage: vi.fn(async () => ({
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    setActivity: vi.fn(),
    setActive: vi.fn(),
    setSize: vi.fn(),
    enableControls: vi.fn(),
    setMaxFps: vi.fn(),
    getModelLabel: vi.fn(() => "test.vrm"),
    getMetrics: vi.fn(() => ({
      fps: 24,
      frameMs: 10,
      tickMs: 2,
      renderMs: 4,
      drawCalls: 1,
      triangles: 100,
      geometries: 1,
      textures: 1,
      bufferW: 480,
      bufferH: 720,
      speaking: false,
      level: 0,
      clip: "idle",
      idleWeight: 1,
      speakWeight: 0,
      heapMb: null,
      webgl: "test",
      engine: "three-vrm",
    })),
    onMetrics: vi.fn(() => () => {}),
  })),
  attachAetherStudioAgent: vi.fn(() => () => {}),
  isAetherStudioAllowed: vi.fn(() => false),
  AETHER_STUDIO_QUERY: "aetherStudio",
}));

vi.mock("@aether/studio/panel", () => ({
  StudioPanel: vi.fn().mockImplementation(() => ({
    mount: vi.fn(),
    unmount: vi.fn(),
  })),
}));

vi.mock("@aether/studio/styles.css", () => ({}));

vi.mock("../../services/aether/load", () => ({
  assetUrl: (rel: string) => `http://test.local/${rel}`,
  loadAetherManifest: vi.fn(async () => ({
    modelPath: "avatar.vrm",
    distributionAllowed: true,
  })),
}));

vi.mock("../../services/aether/studioGate", () => ({
  isAetherStudioAllowed: vi.fn(() => false),
  AETHER_STUDIO_QUERY: "aetherStudio",
}));

describe("AvatarPresence", () => {
  beforeEach(() => {
    localStorage.removeItem(AETHER_VISIBLE_KEY);
  });

  it("renders toggle and canvas by default", () => {
    render(<AvatarPresence phase="idle" />);
    expect(screen.getByTestId("aether-presence")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /hide character/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /assistant character/i }),
    ).toBeInTheDocument();
  });

  it("hides canvas when toggled off", async () => {
    const user = userEvent.setup();
    render(<AvatarPresence phase="idle" />);
    await user.click(screen.getByRole("button", { name: /hide character/i }));
    expect(
      screen.queryByRole("img", { name: /assistant character ani/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show character/i }),
    ).toBeInTheDocument();
    expect(localStorage.getItem(AETHER_VISIBLE_KEY)).toBe("0");
  });
});
