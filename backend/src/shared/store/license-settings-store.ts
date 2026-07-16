import { Pool } from "pg";

/**
 * Application-wide license configuration — the single `license_settings` row.
 *
 * These are the global defaults and on/off switches the Admin controls:
 * - default free/paid scan limits inherited by any user without an override,
 * - free/paid pool enable flags ("enable/disable scanning globally"),
 * - the enforcement flag: when false, quotas are still METERED (counters and
 *   ledger keep moving) but never BLOCK — a soft over-limit mode for incident
 *   response. When true (the default), an exhausted user is hard-blocked at OCR.
 *
 * This is the inter-module contract routers/services depend on, not Postgres —
 * so tests inject a fake. See docs/modules/admin/LICENSE_MANAGEMENT.md.
 */
export interface LicenseSettings {
  defaultFreeLimit: number;
  defaultPaidLimit: number;
  freeEnabled: boolean;
  paidEnabled: boolean;
  enforcementEnabled: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * A partial update. Every field is optional so the Admin can toggle one flag
 * without restating the rest; `updatedBy` is the acting admin username, stamped
 * on every write so "who last changed the global config" is queryable.
 */
export interface LicenseSettingsPatch {
  defaultFreeLimit?: number;
  defaultPaidLimit?: number;
  freeEnabled?: boolean;
  paidEnabled?: boolean;
  enforcementEnabled?: boolean;
}

export interface LicenseSettingsStore {
  /** The current global settings. The singleton row is seeded by initSchema. */
  get(): Promise<LicenseSettings>;
  /** Apply a partial update and return the new settings. */
  update(patch: LicenseSettingsPatch, adminUsername: string): Promise<LicenseSettings>;
}

interface LicenseSettingsRow {
  default_free_limit: number;
  default_paid_limit: number;
  free_enabled: boolean;
  paid_enabled: boolean;
  enforcement_enabled: boolean;
  updated_at: Date;
  updated_by: string | null;
}

const LICENSE_SETTINGS_COLUMNS = `default_free_limit, default_paid_limit, free_enabled,
                                  paid_enabled, enforcement_enabled, updated_at, updated_by`;

function toSettings(row: LicenseSettingsRow): LicenseSettings {
  return {
    defaultFreeLimit: row.default_free_limit,
    defaultPaidLimit: row.default_paid_limit,
    freeEnabled: row.free_enabled,
    paidEnabled: row.paid_enabled,
    enforcementEnabled: row.enforcement_enabled,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export class PgLicenseSettingsStore implements LicenseSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<LicenseSettings> {
    const { rows } = await this.pool.query<LicenseSettingsRow>(
      `SELECT ${LICENSE_SETTINGS_COLUMNS} FROM license_settings WHERE id = TRUE`
    );
    // initSchema seeds the row, so this should never be empty in a booted app.
    return toSettings(rows[0]);
  }

  /**
   * COALESCE($n, column) applies only the fields the patch supplied and leaves
   * the rest untouched — one statement, no read-modify-write race. WHERE id=TRUE
   * targets the single row. RETURNING gives the caller the post-update state
   * without a second read.
   */
  async update(patch: LicenseSettingsPatch, adminUsername: string): Promise<LicenseSettings> {
    const { rows } = await this.pool.query<LicenseSettingsRow>(
      `UPDATE license_settings SET
         default_free_limit  = COALESCE($1, default_free_limit),
         default_paid_limit  = COALESCE($2, default_paid_limit),
         free_enabled        = COALESCE($3, free_enabled),
         paid_enabled        = COALESCE($4, paid_enabled),
         enforcement_enabled = COALESCE($5, enforcement_enabled),
         updated_at          = now(),
         updated_by          = $6
       WHERE id = TRUE
       RETURNING ${LICENSE_SETTINGS_COLUMNS}`,
      [
        patch.defaultFreeLimit ?? null,
        patch.defaultPaidLimit ?? null,
        patch.freeEnabled ?? null,
        patch.paidEnabled ?? null,
        patch.enforcementEnabled ?? null,
        adminUsername,
      ]
    );
    return toSettings(rows[0]);
  }
}

/**
 * Test double with real behavior — holds one settings object and mutates it,
 * mirroring the singleton-row semantics so multi-step tests (update then
 * consume) see consistent state.
 */
export class MemoryLicenseSettingsStore implements LicenseSettingsStore {
  private settings: LicenseSettings;

  constructor(initial?: Partial<LicenseSettings>) {
    this.settings = {
      defaultFreeLimit: 10,
      defaultPaidLimit: 0,
      freeEnabled: true,
      paidEnabled: true,
      enforcementEnabled: true,
      updatedAt: new Date(0),
      updatedBy: null,
      ...initial,
    };
  }

  async get(): Promise<LicenseSettings> {
    return { ...this.settings };
  }

  async update(patch: LicenseSettingsPatch, adminUsername: string): Promise<LicenseSettings> {
    this.settings = {
      ...this.settings,
      ...(patch.defaultFreeLimit !== undefined && { defaultFreeLimit: patch.defaultFreeLimit }),
      ...(patch.defaultPaidLimit !== undefined && { defaultPaidLimit: patch.defaultPaidLimit }),
      ...(patch.freeEnabled !== undefined && { freeEnabled: patch.freeEnabled }),
      ...(patch.paidEnabled !== undefined && { paidEnabled: patch.paidEnabled }),
      ...(patch.enforcementEnabled !== undefined && {
        enforcementEnabled: patch.enforcementEnabled,
      }),
      updatedAt: new Date(),
      updatedBy: adminUsername,
    };
    return { ...this.settings };
  }
}
