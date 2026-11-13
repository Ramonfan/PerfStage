import { promises as fs } from "node:fs";
import {
  RecordingError,
  type RecordedTrace,
  type RecordRequest,
  type TraceRecorder,
} from "./types.js";

/**
 * Scriptable recorder for Runner tests.
 *
 * It writes a marker directory at the requested path so downstream code that
 * stats the trace behaves the same as with a real `.trace` bundle, and it
 * records every request so tests can assert pass ordering, targets and timing.
 */
export interface FakeRecorderOptions {
  /** Throw on the Nth record call (1-based) for the given template. */
  failOn?: Partial<Record<string, number>>;
  /** Simulated failure kind. Defaults to a retryable kperf collision. */
  failureKind?:
    | "kperf-lock"
    | "no-trace"
    | "failed-to-start"
    | "pid-gone"
    | "instruments-wedged"
    | "malformed-trace"
    | "app-exited";
  /**
   * Report this attempt count instead of the local call count. Retries live in
   * the real xctrace recorder, so a fake cannot reproduce them by failing; this
   * lets Runner tests assert how an internal retry is surfaced.
   */
  reportedAttempts?: Partial<Record<string, number>>;
  /** Invoked while the fake "session is live". */
  onLive?: (request: RecordRequest) => Promise<void> | void;
  /**
   * Invoked for `target.kind === "launch"` before the session goes live.
   *
   * `xctrace --launch` starts the app itself, so a fake recorder needs a way
   * to make the fake device reflect that (new pid, app in front) without the
   * Runner calling `device.launch`. Tests wire this to
   * `FakeDriver.simulateExternalLaunch`.
   */
  onLaunch?: (request: RecordRequest) => Promise<void> | void;
}

export interface FakeRecorder extends TraceRecorder {
  readonly requests: RecordRequest[];
  /** Number of `record` invocations per template. */
  readonly attemptsByTemplate: Record<string, number>;
}

export function createFakeRecorder(
  options: FakeRecorderOptions = {},
): FakeRecorder {
  const requests: RecordRequest[] = [];
  const attemptsByTemplate: Record<string, number> = {};

  return {
    get requests() {
      return requests;
    },
    get attemptsByTemplate() {
      return attemptsByTemplate;
    },

    async record(request: RecordRequest): Promise<RecordedTrace> {
      requests.push(request);
      const attempt = (attemptsByTemplate[request.template] ?? 0) + 1;
      attemptsByTemplate[request.template] = attempt;

      const startedAt = Date.now();
      const failAt = options.failOn?.[request.template];
      if (failAt !== undefined && attempt === failAt) {
        const kind = options.failureKind ?? "kperf-lock";
        throw new RecordingError(
          `fake ${kind} failure for ${request.template}`,
          kind,
          kind === "kperf-lock" || kind === "failed-to-start",
        );      }

      if (request.target.kind === "launch" && options.onLaunch) {
        await options.onLaunch(request);
      }
      if (options.onLive) {
        await options.onLive(request);
      }
      if (request.during) {
        await request.during();
      }

      await fs.mkdir(request.outputPath, { recursive: true });
      await fs.writeFile(
        `${request.outputPath}/.fake`,
        JSON.stringify({ template: request.template, attempt }),
      );

      return {
        tracePath: request.outputPath,
        template: request.template,
        attempts: options.reportedAttempts?.[request.template] ?? attempt,
        issues: [],
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
