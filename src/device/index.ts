/**
 * Device layer facade.
 *
 * Two external CLIs sit behind {@link DeviceDriver}: `mobilecli` for app
 * lifecycle/input/UI/crash/logs, and `xcrun devicectl` for installation
 * identity and pids. Keeping them behind an interface is what makes the
 * Runner testable without a phone.
 */
export { DeviceError } from "./types.js";
export type {
  AppInstallation,
  CrashEntry,
  DeviceDriver,
  DeviceErrorKind,
  DeviceInfo,
  DeviceRecoveryEvent,
  ForegroundApp,
  LogStream,
  UiElement,
} from "./types.js";
export {
  createMobilecliDriver,
  createUnavailableDriver,
  findMobilecliBinary,
  parseMobilecliJson,
} from "./mobilecli.js";
export type { MobilecliDriverOptions } from "./mobilecli.js";
export { createFakeDriver } from "./fake.js";
export type {
  FakeDriver,
  FakeDriverOptions,
  FakeOperation,
} from "./fake.js";
