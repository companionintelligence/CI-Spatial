/**
 * Whether a value is an ISO 8601 date-time, the shape `Date.prototype.toISOString` writes.
 *
 * `Date.parse` alone is not a test of that: V8 reads "1" as the year 2001 and "Nov 1 2026" as a
 * date, and other engines read other strings, so a stored text that merely parses can be a
 * different time on the server and in the editor. A record that says it holds an ISO time (a scan
 * calibration's `calibratedAt`) is checked against the shape first, and then against the calendar.
 *
 * Browser-safe, so the server's sidecar reader (server/calibration_fields.ts) and the editor's scan
 * list (src/viewer/scan-calibration-chip.ts) apply the same test.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

export function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value))
}
