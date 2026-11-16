/**
 * Device layer contracts.
 *
 * PerfStage drives a real iPhone through two CLI surfaces:
 *
 * - `mobilecli` — app lifecycle, input synthesis, UI tree, crash list, logs.
 * - `xcrun devicectl` — installed-app container UUIDs and process pids.
 *
 * Neither is an MCP server dependency: they are plain processes. Keeping this
 * behind an interface is what lets the Runner run against a fake device in
 * tests without a plugged-in phone.
 */

export interface ScreenSize {
  /** Width in points, not pixels. */
  width: number;
  /** Height in points, not pixels. */
  height: number;
  /** Device pixels per point, when reported. */
  scale?: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  type: string;
  version: string;
  model?: string;
  state: string;
  /**
   * Physical screen in points.
   *
   * Gesture synthesis needs this: the UI tree can report a scroll view whose
   * frame is taller than the screen, so inferring the viewport from elements
   * produces coordinates below the home indicator. Swiping there sends the app
   * to the background and the next action lands on SpringBoard.
   */
  screenSize?: ScreenSize;
}

export interface AppInstallation {
  bundleId: string;
  /** Display name, as Instruments shows it (e.g. `NN`). */
  name: string;
  /**
   * Executable name used by the OS log stream (e.g. `NNIM`).
   *
   * It is *not* the display name: filtering `mobilecli device logs` by `NN`
   * silently yields zero lines, which would make every Take look like it had
   * no log evidence.
   */
  processName: string;
  version: string;
  /**
   * The container UUID from the install URL. Two builds of the same app share
   * an executable name, so this is the only safe way to find "our" pid.
   */
  containerUuid: string;
}

export interface UiElement {
  ref?: string;
  type?: string;
  label?: string;
  name?: string;
  identifier?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface ForegroundApp {
  bundleId: string;
  appName?: string;
  version?: string;
  activity?: string;
}

export interface LogStream {
  /** Stop capturing and return everything received so far. */
  stop(): Promise<{ text: string; stderr: string }>;
}

export interface DeviceDriver {
  /** Fail early with a clear message when the device is not reachable. */
  requireDevice(deviceId: string): Promise<DeviceInfo>;
  resolveInstallation(deviceId: string, bundleId: string): Promise<AppInstallation>;
  /**
   * Resolve the pid of a specific installation. Returns `null` when the app
   * is not running, which the Runner treats as "launch it".
   */
  resolvePid(deviceId: string, containerUuid: string): Promise<number | null>;
  launch(deviceId: string, bundleId: string): Promise<void>;
  /**
   * Open a URL / deep link on the device.
   *
   * Used for `app.launchUrl`: the scenario declares where the measurement must
   * start, and a deep link is the only way to reach a nested screen without
   * spending recorded actions on navigation.
   */
  openUrl(deviceId: string, url: string): Promise<void>;
  terminate(deviceId: string, bundleId: string): Promise<void>;
  foreground(deviceId: string): Promise<ForegroundApp>;
  dumpElements(deviceId: string): Promise<UiElement[]>;
  tap(deviceId: string, x: number, y: number): Promise<void>;
  swipe(
    deviceId: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void>;
  crashIds(deviceId: string): Promise<string[]>;
  /**
   * Start an app-scoped device log stream. Log capture is best effort: a
   * caller that cannot start it must record `logEvidenceUnavailable` rather
   * than pretend the logs were clean.
   */
  startLogStream(deviceId: string, processName: string): LogStream;
}

export type DeviceErrorKind =
  | "device-unavailable"
  | "app-not-installed"
  | "element-not-found"
  | "duplicate-process"
  | "command-failed"
  | "timeout";

export class DeviceError extends Error {
  override readonly name = "DeviceError";

  constructor(
    message: string,
    readonly kind: DeviceErrorKind,
    readonly details?: string,
  ) {
    super(message);
  }
}
