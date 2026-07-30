import { describe, expect, it } from "vitest";
import {
  captureScrollMemory,
  isStuckToBottom,
  restoreScrollTop,
} from "./transcriptScroll";

describe("transcriptScroll", () => {
  it("treats the end and near-end as stuck", () => {
    expect(
      isStuckToBottom({ scrollTop: 952, scrollHeight: 1000, clientHeight: 40 }),
    ).toBe(true);
    expect(
      isStuckToBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 40 }),
    ).toBe(false);
  });

  it("captures stuck state from metrics", () => {
    expect(
      captureScrollMemory({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }),
    ).toEqual({ scrollTop: 0, stuckToBottom: true });
    expect(
      captureScrollMemory({ scrollTop: 10, scrollHeight: 500, clientHeight: 100 }),
    ).toEqual({ scrollTop: 10, stuckToBottom: false });
  });

  it("restores the end on first visit or when the user was stuck", () => {
    expect(restoreScrollTop(undefined, { scrollHeight: 800, clientHeight: 200 })).toEqual({
      scrollTop: 600,
      stuckToBottom: true,
    });
    expect(
      restoreScrollTop(
        { scrollTop: 12, stuckToBottom: true },
        { scrollHeight: 800, clientHeight: 200 },
      ),
    ).toEqual({ scrollTop: 600, stuckToBottom: true });
  });

  it("clamps a saved offset when the transcript shrank", () => {
    expect(
      restoreScrollTop(
        { scrollTop: 900, stuckToBottom: false },
        { scrollHeight: 400, clientHeight: 200 },
      ),
    ).toEqual({ scrollTop: 200, stuckToBottom: false });
  });
});
