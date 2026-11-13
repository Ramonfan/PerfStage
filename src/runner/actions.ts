import type { TestAction } from "../model/test-plan.js";
import type { ActionRecord } from "../model/test-run.js";
import type { DeviceDriver, UiElement } from "../device/types.js";

/**
 * Execute one plan action and return a verifiable ActionRecord.
 *
 * The record is the evidence: `outcome` says whether the interaction actually
 * happened, and the timestamps bracket the recorded window. A Skill can no
 * longer claim a step ran without producing one of these.
 */

export interface ActionExecutorDependencies {
  device: DeviceDriver;
  deviceId: string;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long to poll for a target element before giving up. */
  elementTimeoutMs?: number;
  /** Poll interval while waiting for an element. */
  pollIntervalMs?: number;
  /**
   * Real screen size in points, from the device layer.
   *
   * Swipes refuse to run without it: guessing the viewport from the UI tree is
   * how a gesture ended up below the home indicator, backgrounding the app and
   * letting the next action score system UI instead of the scenario.
   */
  screenSize?: { width: number; height: number };
  log?: (message: string) => void;
}

const DEFAULT_ELEMENT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 500;

/**
 * Fraction of the screen a synthesized gesture may touch.
 *
 * Both endpoints stay inside 20%–80% of the axis: the bottom 20% holds the
 * home indicator (an upward swipe there leaves the app), the top 20% holds the
 * status bar / Dynamic Island, and the left edge holds the back gesture.
 */
const GESTURE_BAND = 0.8;

function elementText(element: UiElement): string[] {
  return [element.label, element.name, element.identifier].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

export function findElement(
  elements: readonly UiElement[],
  target: string,
): UiElement | undefined {
  return elements.find((element) => elementText(element).includes(target));
}

/**
 * Convert a direction+distance into a swipe gesture that stays inside the
 * safe band of the screen. Distance is clamped so a request larger than the
 * band still produces a valid, full-length gesture.
 */
export type SwipeDirection = "up" | "down" | "left" | "right";

export function swipeCoordinates(
  direction: SwipeDirection,
  distance: number,
  screen: { width: number; height: number },
): {
  from: { x: number; y: number };
  to: { x: number; y: number };
} {
  if (
    !Number.isFinite(screen.width) ||
    !Number.isFinite(screen.height) ||
    screen.width <= 0 ||
    screen.height <= 0
  ) {
    throw new Error(
      `screen size ${screen.width}x${screen.height} cannot be used for gesture math`,
    );
  }
  const horizontal = direction === "left" || direction === "right";
  const axisLength = horizontal ? screen.width : screen.height;
  const nearEdge = Math.round(axisLength * GESTURE_BAND);
  const farEdge = Math.round(axisLength * (1 - GESTURE_BAND));
  const maxDistance = Math.max(1, nearEdge - farEdge);
  const span = Math.min(Math.max(1, Math.round(distance)), maxDistance);

  if (horizontal) {
    const y = Math.round(screen.height / 2);
    const startX = direction === "right" ? farEdge : nearEdge;
    return {
      from: { x: startX, y },
      to: { x: startX + (direction === "right" ? span : -span), y },
    };
  }

  const x = Math.round(screen.width / 2);
  const startY = direction === "down" ? farEdge : nearEdge;
  return {
    from: { x, y: startY },
    to: { x, y: startY + (direction === "down" ? span : -span) },
  };
}

async function pollForElement(
  deps: ActionExecutorDependencies,
  target: string,
  timeoutMs: number,
): Promise<UiElement | null> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const elements = await deps.device.dumpElements(deps.deviceId);
    const found = findElement(elements, target);
    if (found !== undefined) {
      return found;
    }
    await sleep(deps.pollIntervalMs ?? DEFAULT_POLL_MS);
  }
  return null;
}

function centerOf(element: UiElement): { x: number; y: number } | null {
  const rect = element.rect;
  if (rect === undefined) return null;
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

export async function executeAction(
  action: TestAction,
  deps: ActionExecutorDependencies,
): Promise<ActionRecord> {
  const startedAt = deps.now().toISOString();
  const start = Date.now();
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));

  const base = {
    actionId: action.id,
    attempts: 1,
    startedAt,
    endedAt: null as string | null,
    outcome: "executed" as const,
  };

  const finish = (extra: Partial<ActionRecord> = {}): ActionRecord => ({
    ...base,
    endedAt: deps.now().toISOString(),
    durationMs: Date.now() - start,
    ...extra,
  });

  try {
    let actionNotes: string | undefined;
    switch (action.type) {
      case "wait":
        await sleep(action.durationMs);
        break;

      case "swipe": {
        const screen = deps.screenSize;
        if (screen === undefined || screen.width <= 0 || screen.height <= 0) {
          throw new Error(
            "swipe needs the real device screen size, but the device layer reported none; refusing to guess coordinates that could leave the app",
          );
        }
        const coords = swipeCoordinates(action.direction, action.distance, screen);
        await deps.device.swipe(
          deps.deviceId,
          coords.from,
          coords.to,
          action.durationMs ?? 400,
        );
        // Coordinates are evidence: an action logged only as "executed" hid a
        // gesture that started below the home indicator and backgrounded the
        // app. Anyone reading the report can now see where it swiped.
        actionNotes = `swipe ${coords.from.x},${coords.from.y} -> ${coords.to.x},${coords.to.y} on ${screen.width}x${screen.height}`;
        break;
      }

      case "tap": {
        const element = await pollForElement(
          deps,
          action.target,
          deps.elementTimeoutMs ?? DEFAULT_ELEMENT_TIMEOUT_MS,
        );
        if (element === null) {
          throw new Error(`element "${action.target}" was not found`);
        }
        const center = centerOf(element);
        if (center === null) {
          throw new Error(`element "${action.target}" has no frame`);
        }
        await deps.device.tap(deps.deviceId, center.x, center.y);
        break;
      }

      case "wait_for": {
        const element = await pollForElement(
          deps,
          action.target,
          action.timeoutMs ?? deps.elementTimeoutMs ?? DEFAULT_ELEMENT_TIMEOUT_MS,
        );
        if (element === null) {
          throw new Error(
            `element "${action.target}" never appeared within ${action.timeoutMs}ms`,
          );
        }
        break;
      }
    }

    const waitAfter = "waitAfterMs" in action ? action.waitAfterMs : 0;
    if (waitAfter > 0) {
      await sleep(waitAfter);
    }
    return finish(
      actionNotes !== undefined ? { notes: actionNotes } : {},
    );
  } catch (error) {
    return finish({
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
