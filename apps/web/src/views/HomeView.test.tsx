import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeView, dayStamp, groupSessionsByDay } from "./HomeView";

function renderView(overrides: Partial<Parameters<typeof HomeView>[0]> = {}) {
  const props = {
    workspaces: [],
    sessions: [],
    selectedWorkspaceId: null,
    busy: false,
    onOpenPicker: vi.fn(),
    onRefreshProjects: vi.fn(),
    onRefreshSessions: vi.fn(),
    onSelectProject: vi.fn(),
    onNewSession: vi.fn(),
    onResumeSession: vi.fn(),
    ...overrides,
  };
  render(<HomeView {...props} />);
  return props;
}

describe("HomeView projects rail", () => {
  it("never offers a way to type a filesystem path", () => {
    renderView();
    // Search is allowed; a free-form path field is not.
    expect(screen.getByPlaceholderText(/search projects/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /choose a directory/i }),
    ).toBeInTheDocument();
  });

  it("explains that the host chooses the directory", () => {
    renderView();
    expect(screen.getByText(/cannot read a path you type/i)).toBeInTheDocument();
  });

  it("selects an enrolled project by opaque workspace identifier", async () => {
    const props = renderView({
      workspaces: [{ id: "ws-1", displayName: "project", available: true }],
    });
    await userEvent.click(
      screen.getByRole("button", { name: /open project project/i }),
    );
    expect(props.onSelectProject).toHaveBeenCalledWith("ws-1");
  });

  it("lists only what the host projects, which is only what was enrolled", () => {
    // The rail used to be an inventory of GROK_HOME. The host now filters
    // (light ADR 0014); the rail draws its rows and invents none.
    renderView({
      projects: [
        {
          projectId: "proj-abc",
          displayName: "opensource",
          sessionCount: 3,
          lastActiveAt: "2026-07-29T12:00:00Z",
          available: true,
          workspaceId: "ws-9",
        },
      ],
    });
    expect(
      screen.getAllByRole("button", { name: /open project/i }),
    ).toHaveLength(1);
    expect(screen.getByText("opensource")).toBeInTheDocument();
  });

  it("selects an enrolled project straight from its row", async () => {
    const props = renderView({
      projects: [
        {
          projectId: "proj-abc",
          displayName: "opensource",
          sessionCount: 3,
          lastActiveAt: "2026-07-29T12:00:00Z",
          available: true,
          workspaceId: "ws-9",
        },
      ],
    });
    await userEvent.click(
      screen.getByRole("button", { name: /open project opensource/i }),
    );
    expect(props.onSelectProject).toHaveBeenCalledWith("ws-9");
  });

  it("shows display names, never paths", () => {
    renderView({
      projects: [
        {
          projectId: "proj-1",
          displayName: "project",
          sessionCount: 2,
          lastActiveAt: "2026-07-29T12:00:00Z",
          available: true,
          workspaceId: "ws-1",
        },
      ],
    });
    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.queryByText(/\/home\//)).not.toBeInTheDocument();
  });

  it("draws no chip for an available project", () => {
    renderView({
      workspaces: [{ id: "ws-1", displayName: "project", available: true }],
    });
    // Ready is the resting state. Thirty identical green chips said nothing.
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("refuses to open a project whose directory is unavailable", async () => {
    const props = renderView({
      projects: [
        {
          projectId: "proj-1",
          displayName: "project",
          sessionCount: 1,
          lastActiveAt: "",
          available: false,
          workspaceId: "ws-1",
        },
      ],
    });
    const row = screen.getByRole("button", { name: /open project project/i });
    expect(row).toBeDisabled();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    await userEvent.click(row);
    expect(props.onSelectProject).not.toHaveBeenCalled();
  });

  it("marks the selected project so the two columns stay connected", () => {
    renderView({
      workspaces: [
        { id: "ws-1", displayName: "alpha", available: true },
        { id: "ws-2", displayName: "beta", available: true },
      ],
      selectedWorkspaceId: "ws-2",
    });
    expect(screen.getByRole("button", { name: /open project beta/i })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /open project alpha/i }),
    ).not.toHaveAttribute("aria-current");
  });

  it("filters projects by search", async () => {
    renderView({
      workspaces: [
        { id: "ws-1", displayName: "alpha", available: true },
        { id: "ws-2", displayName: "beta", available: true },
      ],
    });
    await userEvent.type(screen.getByPlaceholderText(/search projects/i), "bet");
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });

  it("surfaces a refusal from the host", () => {
    renderView({ error: "A session is already open." });
    expect(screen.getByRole("alert")).toHaveTextContent(/already open/i);
  });

  it("disables actions while a command is in flight", () => {
    renderView({
      workspaces: [{ id: "ws-1", displayName: "project", available: true }],
      busy: true,
    });
    expect(
      screen.getByRole("button", { name: /open project project/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /add a project/i })).toBeDisabled();
  });

  it("discloses that the agent runs with the user's own authority", () => {
    renderView();
    expect(screen.getByText(/control surface, not a sandbox/i)).toBeInTheDocument();
  });

  it("does not show an integrations strip", () => {
    renderView({
      projects: [
        {
          projectId: "proj-1",
          displayName: "project",
          sessionCount: 1,
          lastActiveAt: "",
          available: true,
          workspaceId: "ws-1",
        },
      ],
    });
    expect(screen.queryByText(/integrations/i)).not.toBeInTheDocument();
  });
});

describe("HomeView sessions column", () => {
  const workspaces = [{ id: "ws-1", displayName: "test", available: true }];

  it("asks for a project before showing any sessions", () => {
    renderView({ workspaces });
    expect(screen.getByText(/pick a project/i)).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/search sessions/i),
    ).not.toBeInTheDocument();
  });

  it("resumes a session from the row itself, with no per-row button", async () => {
    const props = renderView({
      workspaces,
      selectedWorkspaceId: "ws-1",
      selectedWorkspaceName: "test",
      sessions: [
        {
          id: "ses-1",
          title: "Count to twenty",
          updatedAt: new Date().toISOString(),
          messageCount: 4,
        },
      ],
    });
    // Sixteen sessions used to mean sixteen filled Resume buttons.
    expect(screen.queryByRole("button", { name: /^resume$/i })).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /resume count to twenty/i }),
    );
    expect(props.onResumeSession).toHaveBeenCalledWith("ses-1");
  });

  it("groups sessions by day", () => {
    const now = Date.now();
    renderView({
      workspaces,
      selectedWorkspaceId: "ws-1",
      sessions: [
        {
          id: "a",
          title: "today one",
          updatedAt: new Date(now).toISOString(),
          messageCount: 1,
        },
        {
          id: "b",
          title: "long ago",
          updatedAt: "2020-01-01T00:00:00Z",
          messageCount: 2,
        },
      ],
    });
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Older")).toBeInTheDocument();
    expect(screen.queryByText("Yesterday")).not.toBeInTheDocument();
  });

  it("dates an older session, because its heading cannot", () => {
    renderView({
      workspaces,
      selectedWorkspaceId: "ws-1",
      sessions: [
        {
          id: "b",
          title: "long ago",
          updatedAt: "2020-03-14T22:59:00Z",
          messageCount: 2,
        },
      ],
    });
    // "Older" spans two days to two years; a bare clock said nothing.
    const row = screen.getByRole("button", { name: /resume long ago/i });
    expect(row).toHaveTextContent(/2020/);
  });

  it("leaves today's rows to the clock alone", () => {
    renderView({
      workspaces,
      selectedWorkspaceId: "ws-1",
      sessions: [
        {
          id: "a",
          title: "today one",
          updatedAt: new Date().toISOString(),
          messageCount: 1,
        },
      ],
    });
    // The "Today" heading already carries the date.
    const row = screen.getByRole("button", { name: /resume today one/i });
    expect(row).not.toHaveTextContent(new RegExp(String(new Date().getFullYear())));
  });

  it("filters sessions by search", async () => {
    renderView({
      workspaces,
      selectedWorkspaceId: "ws-1",
      sessions: [
        { id: "a", title: "alpha run", updatedAt: "", messageCount: 1 },
        { id: "b", title: "beta run", updatedAt: "", messageCount: 1 },
      ],
    });
    await userEvent.type(screen.getByPlaceholderText(/search sessions/i), "alpha");
    expect(screen.getByText("alpha run")).toBeInTheDocument();
    expect(screen.queryByText("beta run")).not.toBeInTheDocument();
  });

  it("names an untitled session rather than showing its id", () => {
    renderView({
      workspaces,
      selectedWorkspaceId: "ws-1",
      sessions: [
        { id: "ses-secret", title: "", updatedAt: "", messageCount: 0 },
      ],
    });
    expect(screen.getByText("Untitled session")).toBeInTheDocument();
    expect(screen.queryByText("ses-secret")).not.toBeInTheDocument();
  });

  it("starts a new session for the selected project", async () => {
    const props = renderView({
      workspaces,
      selectedWorkspaceId: "ws-1",
      sessions: [],
    });
    await userEvent.click(
      screen.getAllByRole("button", { name: /new session/i })[0]!,
    );
    expect(props.onNewSession).toHaveBeenCalled();
  });
});

function at(updatedAt: string, id = updatedAt) {
  return { id, title: id, updatedAt, messageCount: 1 };
}

describe("groupSessionsByDay", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("buckets by local day boundary and keeps host order inside a bucket", () => {
    const groups = groupSessionsByDay(
      [
        at("2026-07-29T11:00:00Z", "later-today"),
        at("2026-07-29T01:00:00Z", "earlier-today"),
        at("2026-07-28T10:00:00Z", "yesterday"),
        at("2026-07-01T10:00:00Z", "older"),
      ],
      now,
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      "Yesterday",
      "Older",
    ]);
    expect(groups[0]!.sessions.map((session) => session.id)).toEqual([
      "later-today",
      "earlier-today",
    ]);
  });

  it("drops empty buckets rather than drawing an empty heading", () => {
    const groups = groupSessionsByDay([at("2026-07-29T11:00:00Z")], now);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Today");
  });

  it("treats an undated session as older rather than hiding or promoting it", () => {
    const groups = groupSessionsByDay([at("", "undated")], now);
    expect(groups).toEqual([
      { label: "Older", sessions: [at("", "undated")] },
    ]);
  });
});

describe("dayStamp", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("omits the year inside the current one", () => {
    expect(dayStamp("2026-03-14T10:00:00Z", now)).not.toMatch(/2026/);
    expect(dayStamp("2026-03-14T10:00:00Z", now)).toMatch(/14/);
  });

  it("carries the year across a boundary, where March is ambiguous", () => {
    expect(dayStamp("2025-03-14T10:00:00Z", now)).toMatch(/2025/);
  });

  it("draws nothing for an undated session rather than an epoch", () => {
    expect(dayStamp("", now)).toBe("");
    expect(dayStamp("not a date", now)).toBe("");
  });
});
