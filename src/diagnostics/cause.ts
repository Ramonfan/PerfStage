/**
 * Why did the Take fail?
 *
 * A failed Take is written from the orchestrator's point of view ("trace was
 * malformed", "app was not in the foreground"). The device log is the only
 * place that says what actually went wrong inside the app or the OS, and it is
 * already captured in `device.log`. Pulling the first actionable line into the
 * report turns "no frames" into "Database bootstrap failed: disk I/O error".
 */

interface CausePattern {
  pattern: RegExp;
  label: string;
}

/**
 * Ordered by usefulness, not by line number: an app fatal error explains more
 * than the ENOSPC that caused it, and "No space left on device" appears in
 * dozens of unrelated daemons once a device is in trouble.
 */
const CAUSE_PATTERNS: readonly CausePattern[] = [
  { pattern: /Fatal error:\s*(.+)/i, label: "app fatal error" },
  { pattern: /Database bootstrap failed[^"]*/i, label: "app database" },
  { pattern: /No space left on device/i, label: "no space left on device" },
  { pattern: /\bENOSPC\b/i, label: "ENOSPC" },
  { pattern: /Failed starting ktrace session/i, label: "instruments session" },
];

const MAX_CAUSE_LENGTH = 300;

/**
 * First line in a device log that explains a failed launch or recording.
 *
 * Returns `null` when nothing in the log points at a cause; callers must not
 * invent one.
 */
export function extractDeviceFailureCause(
  logText: string | undefined,
  maxLength = MAX_CAUSE_LENGTH,
): string | null {
  if (logText === undefined || logText.length === 0) {
    return null;
  }
  const lines = logText.split(/\r?\n/);

  for (const { pattern, label } of CAUSE_PATTERNS) {
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match === null) continue;
      // Prefer the app's own message: `Fatal error: <text>` carries the most
      // signal, the raw matching line is the fallback.
      const detail =
        match[1] !== undefined && match[1].trim().length > 0
          ? match[1].trim()
          : line.trim();
      const text = `${label}: ${detail}`;
      return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
    }
  }
  return null;
}
