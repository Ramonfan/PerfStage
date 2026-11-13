import { describe, expect, it } from "vitest";
import { createFakeDriver } from "../../device/fake.js";
import { executeAction, findElement, swipeCoordinates } from "../../runner/actions.js";
import type { TestAction } from "../../model/test-plan.js";

const SCREEN = { width: 393, height: 852 };

/** The safe band the gesture must stay inside, as fractions of the screen. */
const BAND_MIN = 0.2;
const BAND_MAX = 0.8;

describe("swipeCoordinates", () => {
  it("swipes up from the bottom of the safe band towards the top", () => {
    const { from, to } = swipeCoordinates("up", 700, SCREEN);
    expect(from.x).toBe(Math.round(SCREEN.width / 2));
    expect(from.y).toBe(Math.round(SCREEN.height * BAND_MAX));
    expect(from.y).toBeGreaterThan(to.y);
    expect(to.y).toBeGreaterThanOrEqual(Math.round(SCREEN.height * BAND_MIN));
  });

  it("clamps a distance larger than the band", () => {
    const { from, to } = swipeCoordinates("down", 10_000, SCREEN);
    expect(from.y).toBe(Math.round(SCREEN.height * BAND_MIN));
    expect(to.y).toBe(Math.round(SCREEN.height * BAND_MAX));
  });

  it("uses the horizontal axis for left/right", () => {
    const { from, to } = swipeCoordinates("left", 200, SCREEN);
    expect(from.y).toBe(Math.round(SCREEN.height / 2));
    expect(from.x).toBeGreaterThan(to.x);
  });

  it("never puts an endpoint on a system edge", () => {
    // 402x874 is the real device: the old 80pt inset started an "up" swipe at
    // y=889, below the screen, so iOS read it as a home gesture and left the app.
    const real = { width: 402, height: 874 };
    for (const direction of ["up", "down", "left", "right"] as const) {
      const { from, to } = swipeCoordinates(direction, 700, real);
      for (const point of [from, to]) {
        expect(point.x).toBeGreaterThanOrEqual(Math.round(real.width * BAND_MIN));
        expect(point.x).toBeLessThanOrEqual(Math.round(real.width * BAND_MAX));
        expect(point.y).toBeGreaterThanOrEqual(Math.round(real.height * BAND_MIN));
        expect(point.y).toBeLessThanOrEqual(Math.round(real.height * BAND_MAX));
      }
    }
  });

  it("rejects a screen size that cannot be used", () => {
    expect(() => swipeCoordinates("up", 500, { width: 0, height: 852 })).toThrow(
      /cannot be used/,
    );
  });
});

describe("findElement", () => {
  it("matches label, name or identifier", () => {
    const elements = [
      { name: "official_community", identifier: "official_community" },
      { label: "社区" },
    ];
    expect(findElement(elements, "社区")).toBe(elements[1]);
    expect(findElement(elements, "official_community")).toBe(elements[0]);
    expect(findElement(elements, "missing")).toBeUndefined();
  });
});

function action(value: Record<string, unknown>): TestAction {
  return value as TestAction;
}

describe("executeAction", () => {
  it("taps the centre of the matched element", async () => {
    const device = createFakeDriver({
      elements: [{ label: "社区", rect: { x: 300, y: 80, width: 40, height: 20 } }],
    });
    const record = await executeAction(
      action({ id: "open-community", type: "tap", target: "社区", waitAfterMs: 0 }),
      { device, deviceId: "device-1", now: () => new Date(), sleep: async () => undefined },
    );
    expect(record.outcome).toBe("executed");
    expect(device.calls).toContain("tap");
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails the action when the target never appears", async () => {
    const device = createFakeDriver({ elements: [] });
    const record = await executeAction(
      action({ id: "tap-missing", type: "tap", target: "不存在", waitAfterMs: 0 }),
      {
        device,
        deviceId: "device-1",
        now: () => new Date(),
        sleep: async () => undefined,
        elementTimeoutMs: 0,
      },
    );
    expect(record.outcome).toBe("failed");
    expect(record.error).toContain("不存在");
    expect(device.calls).not.toContain("tap");
  });

  it("waits for an element without tapping it", async () => {
    const device = createFakeDriver({
      elements: [{ label: "消息", rect: { x: 0, y: 0, width: 100, height: 40 } }],
    });
    const record = await executeAction(
      action({ id: "wait-messages", type: "wait_for", target: "消息", timeoutMs: 1000 }),
      { device, deviceId: "device-1", now: () => new Date(), sleep: async () => undefined },
    );
    expect(record.outcome).toBe("executed");
    expect(device.calls).toContain("dumpElements");
    expect(device.calls).not.toContain("tap");
  });

  it("records a wait action with its real duration", async () => {
    const sleeps: number[] = [];
    const device = createFakeDriver();
    const record = await executeAction(
      action({ id: "pause", type: "wait", durationMs: 250 }),
      {
        device,
        deviceId: "device-1",
        now: () => new Date(),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(record.outcome).toBe("executed");
    expect(sleeps).toContain(250);
  });

  it("swipes without needing a matching element", async () => {
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 393, height: 852 } }],
    });
    const record = await executeAction(
      action({
        id: "scroll",
        type: "swipe",
        direction: "up",
        distance: 700,
        durationMs: 400,
        waitAfterMs: 0,
      }),
      {
        device,
        deviceId: "device-1",
        now: () => new Date(),
        sleep: async () => undefined,
        screenSize: SCREEN,
      },
    );
    expect(record.outcome).toBe("executed");
    expect(device.calls).toContain("swipe");
    // The coordinates belong to the evidence, not just the device call.
    expect(record.notes).toMatch(/^swipe \d+,\d+ -> \d+,\d+ on 393x852$/);
  });

  it("uses the real screen size even when the UI tree reports a taller frame", async () => {
    // Real device: the app's scroll view reports 402x969, while the screen is
    // 402x874. Gesture math must use the latter, otherwise the swipe starts
    // below the home indicator and backgrounds the app.
    const device = createFakeDriver({
      elements: [{ rect: { x: 0, y: 0, width: 402, height: 969 } }],
    });
    const record = await executeAction(
      action({
        id: "scroll",
        type: "swipe",
        direction: "up",
        distance: 700,
        durationMs: 300,
        waitAfterMs: 0,
      }),
      {
        device,
        deviceId: "device-1",
        now: () => new Date(),
        sleep: async () => undefined,
        screenSize: { width: 402, height: 874 },
      },
    );
    expect(record.outcome).toBe("executed");
    const swipe = device.swipes[0];
    expect(swipe).toBeDefined();
    expect(swipe?.from.y).toBe(Math.round(874 * 0.8));
    expect(swipe?.to.y).toBeGreaterThanOrEqual(Math.round(874 * 0.2));
    expect(swipe?.to.y).toBeLessThanOrEqual(Math.round(874 * 0.8));
  });

  it("applies waitAfterMs after a swipe", async () => {
    const sleeps: number[] = [];
    const device = createFakeDriver();
    const record = await executeAction(
      action({
        id: "scroll",
        type: "swipe",
        direction: "up",
        distance: 700,
        durationMs: 300,
        waitAfterMs: 1_500,
      }),
      {
        device,
        deviceId: "device-1",
        now: () => new Date(),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        screenSize: SCREEN,
      },
    );
    expect(record.outcome).toBe("executed");
    expect(sleeps).toEqual([1_500]);
  });

  it("fails a swipe instead of guessing when the screen size is unknown", async () => {
    const device = createFakeDriver();
    const record = await executeAction(
      action({
        id: "scroll",
        type: "swipe",
        direction: "up",
        distance: 700,
        durationMs: 300,
        waitAfterMs: 0,
      }),
      { device, deviceId: "device-1", now: () => new Date(), sleep: async () => undefined },
    );
    expect(record.outcome).toBe("failed");
    expect(record.error).toContain("screen size");
    expect(device.calls).not.toContain("swipe");
  });
});
