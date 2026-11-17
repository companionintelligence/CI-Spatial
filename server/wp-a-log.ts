/**
 * Request logging that never writes a query string.
 *
 * Hono's logger prints the full URL, query included. This app sends capability
 * tokens in query strings (`?token=` on share links and the owner link, the
 * Companion session on media and socket URLs), so the stock logger writes live
 * credentials to stdout. This keeps the same logger and drops the query from
 * every line it prints.
 */
import { logger } from 'hono/logger'

/**
 * Remove the query string from one request log line:
 * `--> GET /events?token=abc 101` becomes `--> GET /events 101`.
 */
export function stripQueryFromLogLine(line: string): string {
  return line.replace(/\?\S*/, '')
}

/** Hono's request logger, printing through `sink` with query strings removed. */
export function redactedRequestLogger(sink: (line: string) => void = console.log) {
  return logger((line: string) => sink(stripQueryFromLogLine(line)))
}

/**
 * Client-reported text (a log message or stack trace) with token-like parameters blanked, so a
 * URL pasted into a message cannot carry a credential into the log or the event stream.
 */
export function redactTokens(text: string): string {
  return text.replace(/([?&#](?:access_token|token|code|state|session)=)[^&\s"'<>#),\]}]*/gi, '$1[redacted]')
}

/** A client-reported page URL without its query string or fragment. Non-text input gives undefined. */
export function pageUrlWithoutQuery(url: unknown): string | undefined {
  return typeof url === 'string' ? url.split(/[?#]/, 1)[0] : undefined
}
