/**
 * Deadline-bounded subprocess runs for the WorldJob runners.
 *
 * Nothing bounds a runner's child today. The single-flight pump awaits one job
 * at a time, so a stage that awaits `Deno.Command#output()` with no limit holds
 * the only job slot for as long as its child stays alive: one wedged GPU run
 * stops every queued job in every world until the process restarts.
 *
 * This is the deadline form of `runCapture` in capabilities.ts (ADR 0001: reuse,
 * do not duplicate). It has the same shape, a SIGKILL on a timer, but it returns
 * the child's real output and status, so each runner keeps its own success and
 * failure handling and only gains a timeout reason.
 *
 * SIGKILL stops only the process it is sent to. A launcher's own children (a
 * bash script running python, say) keep the stdout pipe open, so `output()` can
 * outlive the kill. The helper stops waiting KILL_GRACE_MS after the kill. If the
 * child's output has arrived by then, it is returned with the timeout reason. If
 * the pipes are still open, the helper returns empty stdout and stderr, exit code
 * 137 and the same timeout reason, so anything the child wrote before the kill is
 * lost. Keeping that partial output would mean reading the pipes as they arrive,
 * which this helper does not do.
 */

/** How long a killed child's pipes get to close before the helper stops waiting for them. */
export const KILL_GRACE_MS = 5_000

/** The longest delay a timer accepts; anything longer fires at once. */
const MAX_TIMER_MS = 2_147_483_647

const EXPIRED = Symbol('deadline-expired')

export interface DeadlineOutput extends Deno.CommandOutput {
  /**
   * `timed out after 3 h` when the deadline fired and the child was killed,
   * null when it finished on its own. Check this before the exit code: a killed
   * child's code and output are whatever the kill left behind.
   */
  timeoutReason: string | null
}

/**
 * Run `bin` with `options` and wait at most `deadlineMs` for it to exit.
 *
 * Throws only when `bin` cannot be spawned, which `output()` does too, so a
 * caller's existing spawn-failure handling still applies.
 */
export async function runWithDeadline(
  bin: string,
  options: Deno.CommandOptions,
  deadlineMs: number,
  killGraceMs: number = KILL_GRACE_MS,
): Promise<DeadlineOutput> {
  const child = new Deno.Command(bin, options).spawn()
  const exited = child.output()

  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), deadlineMs)
  })
  let first: Deno.CommandOutput | typeof EXPIRED
  try {
    first = await Promise.race([exited, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (first !== EXPIRED) return withTimeoutReason(first, null)

  const timeoutReason = `timed out after ${describeBudget(deadlineMs)}`
  try {
    child.kill('SIGKILL')
  } catch {
    // Already exited between the timer firing and this line.
  }
  const late = await within(exited.catch(() => null), killGraceMs, null)
  if (late) return withTimeoutReason(late, timeoutReason)
  // The pipes never closed within the grace period, so there is no output to return.
  return {
    code: 137,
    signal: 'SIGKILL',
    success: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    timeoutReason,
  }
}

/**
 * Copy a finished child's output with the timeout reason added. The fields are
 * copied one by one, not spread: a stream that was not piped has a getter that
 * throws, and a spread calls it. Spreading made a probe with `stdout: 'null'`
 * throw before it reported its exit code.
 */
function withTimeoutReason(out: Deno.CommandOutput, timeoutReason: string | null): DeadlineOutput {
  return {
    code: out.code,
    signal: out.signal,
    success: out.success,
    stdout: streamOrEmpty(() => out.stdout),
    stderr: streamOrEmpty(() => out.stderr),
    timeoutReason,
  }
}

function streamOrEmpty(read: () => Deno.CommandOutput['stdout']): Deno.CommandOutput['stdout'] {
  try {
    return read()
  } catch {
    return new Uint8Array()
  }
}

/**
 * `promise`'s value if it settles within `ms`, otherwise `fallback`. The timer
 * is cleared on either path, so a settled race leaves nothing running.
 */
export async function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cutoff = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise, cutoff])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** A budget in words a reader can act on: "3 h", "30 min", "90 s", "200 ms". */
export function describeBudget(ms: number): string {
  if (ms >= 3_600_000) return `${+(ms / 3_600_000).toFixed(1)} h`
  if (ms >= 60_000) return `${+(ms / 60_000).toFixed(1)} min`
  if (ms >= 1_000) return `${+(ms / 1_000).toFixed(1)} s`
  return `${ms} ms`
}

/**
 * A per-stage budget from the environment, in milliseconds.
 *
 * An unset, unparseable or infinite value takes the default, and so does one
 * below 1 ms once it is rounded down (0.5 counts as 0). A read the process is not
 * allowed to make takes the default too, so a missing permission cannot throw
 * into a job.
 */
export function budgetFromEnv(name: string, fallbackMs: number): number {
  let raw: string | undefined
  try {
    raw = Deno.env.get(name)
  } catch {
    raw = undefined
  }
  const ms = Math.floor(raw ? Number(raw) : Number.NaN)
  // Rounded down before the test: a zero-length timer fires at once, so a budget
  // that floors to 0 would kill its stage immediately. setTimeout also fires at
  // once for a delay past 2^31 - 1 ms, which would turn a very large budget into
  // an immediate kill. Capped at the longest timer.
  return Number.isFinite(ms) && ms >= 1 ? Math.min(ms, MAX_TIMER_MS) : fallbackMs
}
