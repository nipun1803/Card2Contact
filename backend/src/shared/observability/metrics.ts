/**
 * Security/operational counters.
 *
 * No Prometheus, no /metrics endpoint, no dependency: exposing a scrape target
 * is a monitoring-stack decision, and there is no scraper deployed to consume
 * one. Instead an in-process registry emits a JSON snapshot to stdout — same
 * sink as the audit log, same `docker logs` retrieval, greppable by
 * `"kind":"metrics"`.
 *
 * Kept separate from AuditLogger on purpose: audit entries are per-event,
 * security-relevant, and bound by a strict field policy; metrics are aggregate,
 * label-only, and carry no identifiers at all. Merging them would force one to
 * inherit the other's constraints.
 *
 * Counters reset on restart. Acceptable — these answer "what is happening now?"
 * and `docker logs` retains the emitted history.
 */

/** Closed set, same reasoning as AuditEvent: a typo should not compile. */
export type MetricName =
  | "login_success"
  | "login_failure"
  | "session_created"
  | "session_revoked"
  | "auth_failure"
  | "sheet_recreated"
  | "reconnect_required"
  | "token_refresh_failure"
  | "rate_limit_exceeded"
  /**
   * Admin authentication. Deliberately NOT merged into login_success/
   * login_failure: those feed the Google-login view, and folding an operator
   * login into them would corrupt both readings.
   *
   * A rate-limited admin login needs no name here — it counts as
   * rate_limit_exceeded{endpoint=admin_login} via the shared limiter.
   */
  | "admin_login_success"
  | "admin_login_failure"
  /** Admin User Management (Phase 1). */
  | "admin_user_disabled"
  | "admin_user_restored";

export type MetricLabels = Record<string, string>;

export interface Metrics {
  inc(name: MetricName, labels?: MetricLabels): void;
}

/**
 * Flatten name + labels into one counter key: `sheet_recreated{reason=trashed}`.
 * Labels are sorted so key identity doesn't depend on property order.
 */
export function counterKey(name: MetricName, labels?: MetricLabels): string {
  if (!labels) return name;
  const pairs = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return pairs.length ? `${name}{${pairs.join(",")}}` : name;
}

const SNAPSHOT_INTERVAL_MS = 60 * 1000;

/**
 * Accumulates counters and periodically prints a snapshot. Emits only when a
 * counter changed since the last snapshot, so an idle backend stays silent
 * rather than printing zeros every minute forever.
 */
export class StdoutMetrics implements Metrics {
  private readonly counters = new Map<string, number>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  inc(name: MetricName, labels?: MetricLabels): void {
    const key = counterKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    this.dirty = true;
  }

  /** Start periodic emission. unref()'d so it never holds the process open. */
  start(intervalMs = SNAPSHOT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.emit(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Emit a snapshot if anything changed. Never throws. */
  emit(): void {
    if (!this.dirty) return;
    try {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          kind: "metrics",
          counters: Object.fromEntries(this.counters),
        })
      );
      this.dirty = false;
    } catch {
      // Metrics must never break the process that reports them.
    }
  }
}

/** Test double. */
export class MemoryMetrics implements Metrics {
  readonly counters = new Map<string, number>();

  inc(name: MetricName, labels?: MetricLabels): void {
    const key = counterKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  get(name: MetricName, labels?: MetricLabels): number {
    return this.counters.get(counterKey(name, labels)) ?? 0;
  }
}
