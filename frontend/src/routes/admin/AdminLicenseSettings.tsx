import { useEffect, useState } from "react";
import { useLicenseSettings, useUpdateLicenseSettings } from "@/features/admin/useAdminLicenses";
import { AppSplash } from "@/shared/components/common/AppSplash";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { PageHeader } from "@/shared/components/common/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Input } from "@/shared/components/ui/input";
import { Button } from "@/shared/components/ui/button";
import type { LicenseSettingsPatch } from "@/shared/types/api";

interface FormState {
  defaultFreeLimit: string;
  defaultPaidLimit: string;
  freeEnabled: boolean;
  paidEnabled: boolean;
  enforcementEnabled: boolean;
}

/** Global License Settings — defaults and enforcement toggles. */
export default function AdminLicenseSettings() {
  const { data, isLoading, isError, error, refetch } = useLicenseSettings();
  const update = useUpdateLicenseSettings();

  const [form, setForm] = useState<FormState | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the form once settings load; re-seed if the server copy changes.
  useEffect(() => {
    if (data) {
      const s = data.data;
      setForm({
        defaultFreeLimit: String(s.defaultFreeLimit),
        defaultPaidLimit: String(s.defaultPaidLimit),
        freeEnabled: s.freeEnabled,
        paidEnabled: s.paidEnabled,
        enforcementEnabled: s.enforcementEnabled,
      });
    }
  }, [data]);

  if (isLoading || !form) {
    if (isError) {
      return (
        <PageContainer width="default">
          <ErrorState
            message={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
          />
        </PageContainer>
      );
    }
    return <AppSplash message="Loading settings…" />;
  }

  async function handleSave() {
    if (!form) return;
    const patch: LicenseSettingsPatch = {
      defaultFreeLimit: Number(form.defaultFreeLimit),
      defaultPaidLimit: Number(form.defaultPaidLimit),
      freeEnabled: form.freeEnabled,
      paidEnabled: form.paidEnabled,
      enforcementEnabled: form.enforcementEnabled,
    };
    setSaved(false);
    try {
      await update.mutateAsync(patch);
      setSaved(true);
    } catch {
      // Surfaced via the mutation's error state below.
    }
  }

  return (
    <PageContainer width="default">
      <div className="space-y-6">
        <PageHeader
          title="License Settings"
          description="Global defaults applied to users without an explicit override."
        />

        <Card>
          <CardHeader>
            <CardTitle>Defaults & Enforcement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5 text-sm">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="font-medium">Default free limit</label>
                <Input
                  type="number"
                  min={0}
                  value={form.defaultFreeLimit}
                  onChange={(e) => {
                    setForm({ ...form, defaultFreeLimit: e.target.value });
                    setSaved(false);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <label className="font-medium">Default paid limit</label>
                <Input
                  type="number"
                  min={0}
                  value={form.defaultPaidLimit}
                  onChange={(e) => {
                    setForm({ ...form, defaultPaidLimit: e.target.value });
                    setSaved(false);
                  }}
                />
              </div>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <Toggle
                label="Free scans enabled"
                hint="Give every user a recurring free allowance."
                checked={form.freeEnabled}
                onChange={(v) => {
                  setForm({ ...form, freeEnabled: v });
                  setSaved(false);
                }}
              />
              <Toggle
                label="Paid grants enabled"
                hint="Allow admins to grant additional paid scans."
                checked={form.paidEnabled}
                onChange={(v) => {
                  setForm({ ...form, paidEnabled: v });
                  setSaved(false);
                }}
              />
              <Toggle
                label="Enforcement enabled"
                hint="When off, scans are metered but never blocked."
                checked={form.enforcementEnabled}
                onChange={(v) => {
                  setForm({ ...form, enforcementEnabled: v });
                  setSaved(false);
                }}
              />
            </div>

            <div className="flex items-center gap-3 border-t border-border pt-4">
              <Button variant="primary" loading={update.isPending} onClick={() => void handleSave()}>
                Save
              </Button>
              {saved && !update.isPending && (
                <span className="text-sm text-success">Settings saved.</span>
              )}
              {update.error && (
                <span role="alert" className="text-sm text-destructive">
                  {update.error instanceof Error ? update.error.message : "Something went wrong"}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 rounded border-input"
      />
      <span>
        <span className="block font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
