import type { ReportEvidencePaths } from "./json.js";

/**
 * Test whether `path` looks safe to embed in a run-relative evidence
 * reference. Anything that begins with a POSIX `/`, has a Windows drive
 * letter, or contains a parent reference (`..`) is rejected so persisted
 * reports never leak absolute source paths.
 */
export function isSafeRunRelative(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false;
  if (path.includes("..")) return false;
  // Disallow any segment that still carries a backslash — that would
  // indicate the caller forgot to translate Windows separators.
  if (path.includes("\\")) return false;
  return true;
}

/** Drop unsafe entries from an evidence kind → run-relative path map. */
export function sanitizeEvidencePaths(
  map: Record<string, string | undefined>,
): ReportEvidencePaths {
  const out: ReportEvidencePaths = {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string" && isSafeRunRelative(value)) {
      out[key] = value;
    }
  }
  return out;
}
