/**
 * Recording layer facade.
 *
 * Everything the Runner needs to turn a request into a `.trace` file, and
 * nothing about interpreting one (D13: PerfStage parses traces itself).
 */
export {
  RecordingError,
  RECORDING_TEMPLATES,
  HITCHES_PROFILES,
  TEMPLATE_TO_INSTRUMENTS,
  recordingConfigFor,
  resolveRecording,
} from "./types.js";
export type {
  HitchesProfile,
  RecordedTrace,
  RecordRequest,
  RecordingConfig,
  RecordingErrorKind,
  RecordingIssue,
  RecordingIssueLevel,
  RecordingTarget,
  RecordingTemplate,
  ResolvedRecording,
  TraceRecorder,
} from "./types.js";
export {
  buildRecordArgs,
  createXctraceRecorder,
  describeTarget,
  hitchesProfileFromEnv,
  hitchesWindowFromEnv,
  parseRecordingIssues,
  resolveLaunchTrace,
} from "./xctrace.js";
export type { XctraceRecorderOptions } from "./xctrace.js";
export { createFakeRecorder } from "./fake.js";
export type { FakeRecorder, FakeRecorderOptions } from "./fake.js";
