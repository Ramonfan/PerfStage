/**
 * Recording layer facade.
 *
 * Everything the Runner needs to turn a request into a `.trace` file, and
 * nothing about interpreting one (D13: PerfStage parses traces itself).
 */
export {
  RecordingError,
  RECORDING_TEMPLATES,
  TEMPLATE_TO_INSTRUMENTS,
} from "./types.js";
export type {
  RecordedTrace,
  RecordRequest,
  RecordingErrorKind,
  RecordingIssue,
  RecordingIssueLevel,
  RecordingTarget,
  RecordingTemplate,
  TraceRecorder,
} from "./types.js";
export {
  buildRecordArgs,
  createXctraceRecorder,
  describeTarget,
  parseRecordingIssues,
  resolveLaunchTrace,
} from "./xctrace.js";
export type { XctraceRecorderOptions } from "./xctrace.js";
export { createFakeRecorder } from "./fake.js";
export type { FakeRecorder, FakeRecorderOptions } from "./fake.js";
