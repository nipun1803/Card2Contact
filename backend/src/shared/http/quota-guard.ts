import { RequestHandler } from "express";
import { QuotaExceededError, ScanBlockedError } from "./pipeline-errors";
import { fingerprint } from "./session";
import { QuotaStore } from "../store/quota-store";
import { LicenseSettings, LicenseSettingsStore } from "../store/license-settings-store";
import { AuditLogger } from "../audit/audit-logger";
import { Metrics } from "../observability/metrics";

/**
 * Scan quota enforcement, composed onto the M2 (OCR) route in app.ts AFTER
 * requireAuth. Keeps the module boundary intact: M2 imports nothing quota-
 * related; this guard does the metering and M2 only sees a `next()` or a thrown
 * error, exactly like the M5 save route composes requireAuth + the save limiter.
 *
 * Relies on requireAuth having populated `req.auth` (so `req.auth!` is safe here)
 * and on the route carrying `:cardId` (the exactly-once metering key).
 *
 * Enforcement modes (from license_settings.enforcementEnabled):
 * - ON  (default): an exhausted user is hard-blocked with QuotaExceededError.
 * - OFF: consumption is still recorded (counters/ledger keep moving) but the
 *   user is never blocked — a soft over-limit mode for incident response.
 *
 * Scan-Block is enforced in BOTH modes: a blocked user is always refused. It is
 * an administrative decision, not a quota state, so the enforcement toggle
 * (which is about allowance) does not relax it.
 *
 * See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */

/** Remaining at or below this after a consume emits the quota_low warning. */
const LOW_REMAINING_THRESHOLD = 3;

export function createQuotaGuard(
  quotas: QuotaStore,
  settingsStore: LicenseSettingsStore,
  audit: AuditLogger,
  metrics: Metrics
): RequestHandler {
  return async (req, _res, next) => {
    try {
      const googleUserId = req.auth!.googleUserId;
      const cardId = req.params.cardId;
      const settings = await settingsStore.get();

      const result = await quotas.consume(googleUserId, cardId, settings);

      if (result.ok) {
        // A retry that replayed the prior decision must NOT re-emit a consume
        // event — it was already counted on the original request.
        if (!result.idempotentReplay) {
          metrics.inc("quota_consumed", { pool: result.pool });
          quotas.appendLedger({ googleUserId, kind: "consume", pool: result.pool });
          audit.log({ event: "quota_consumed", googleUserId, cardId, ...fingerprint(req) });
          await emitLowWarning(quotas, settings, googleUserId, metrics);
        }
        next();
        return;
      }

      // Refused. Scan-Block always blocks; quota-exhaustion blocks only when
      // enforcement is on.
      if (result.reason === "blocked") {
        audit.log({ event: "quota_scan_blocked_hit", googleUserId, cardId, ...fingerprint(req) });
        metrics.inc("quota_scan_blocked_hit");
        next(new ScanBlockedError());
        return;
      }

      // reason === "exhausted"
      audit.log({ event: "quota_exceeded", googleUserId, cardId, ...fingerprint(req) });
      metrics.inc("quota_exceeded", { enforced: String(settings.enforcementEnabled) });
      if (settings.enforcementEnabled) {
        next(new QuotaExceededError());
        return;
      }
      // Enforcement OFF: allow the over-limit scan through (overage), already
      // recorded above as quota_exceeded{enforced:false} for visibility.
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * After a successful consume, emit quota_low if the user is running out — an
 * early-warning counter for operators, not an error. Best-effort: a read failure
 * here must never fail the scan that already succeeded.
 */
async function emitLowWarning(
  quotas: QuotaStore,
  settings: LicenseSettings,
  googleUserId: string,
  metrics: Metrics
): Promise<void> {
  try {
    const effective = await quotas.getEffective(googleUserId, settings);
    if (effective.totalRemaining <= LOW_REMAINING_THRESHOLD) {
      metrics.inc("quota_low");
    }
  } catch {
    // Never fail a succeeded scan on a warning read.
  }
}
