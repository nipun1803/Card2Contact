import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Textarea } from "@/shared/components/ui/textarea";
import { useCreateUpgradeRequest } from "@/features/plan/useMyPlan";
import { ApiError } from "@/shared/services/api";
import type { CreateRequestInput, PublicTier } from "@/shared/types/api";

/**
 * The shared upgrade-request dialog — used by the Profile "Your Plan" card and
 * the 402 scan-limit panel, so both surfaces file requests through one code
 * path. Two modes: pick a catalog tier, or describe a custom need. On success
 * the mutation invalidates the plan so the pending banner appears at once.
 */

interface UpgradeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tiers: PublicTier[];
  /** Called after a request is filed so the caller can react (e.g. toast). */
  onSubmitted?: () => void;
}

function tierSummary(t: PublicTier): string {
  const limit = t.isUnlimited ? "Unlimited scans" : `${t.scanLimit} scans`;
  const validity = t.validityDays ? ` · ${t.validityDays} days` : " · no expiry";
  return `${limit}${validity}`;
}

export function UpgradeRequestDialog({
  open,
  onOpenChange,
  tiers,
  onSubmitted,
}: UpgradeRequestDialogProps) {
  const create = useCreateUpgradeRequest();
  const [mode, setMode] = useState<"tier" | "custom">("tier");
  const [tierId, setTierId] = useState<number | "">("");
  const [amount, setAmount] = useState("");
  const [days, setDays] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  // Exclude the default (Free) tier — you don't "upgrade" to the fallback.
  const upgradeable = tiers.filter((t) => !t.isDefault);

  function reset() {
    setMode("tier");
    setTierId("");
    setAmount("");
    setDays("");
    setNote("");
    setFormError(null);
    create.reset();
  }

  async function submit() {
    setFormError(null);
    let input: CreateRequestInput;
    if (mode === "tier") {
      if (tierId === "") {
        setFormError("Choose a plan to request.");
        return;
      }
      input = { kind: "tier", tierId, note: note.trim() || null };
    } else {
      if (!note.trim()) {
        setFormError("Please describe what you need — a reason is required for a custom request.");
        return;
      }
      input = {
        kind: "custom",
        amount: amount.trim() ? Number(amount) : null,
        days: days.trim() ? Number(days) : null,
        note: note.trim(),
      };
    }
    try {
      await create.mutateAsync(input);
      onSubmitted?.();
      onOpenChange(false);
      reset();
    } catch (err) {
      // A 409 means one is already open. Surface a clear message; other errors
      // fall through to the mutation's error text.
      if (err instanceof ApiError && err.status === 409) {
        setFormError("You already have a pending request. Please wait for a decision.");
      } else {
        setFormError(err instanceof Error ? err.message : "Could not submit the request.");
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request an upgrade</DialogTitle>
          <DialogDescription>
            Ask an administrator for more scans. Nothing changes until it&apos;s approved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Mode toggle */}
          <div className="flex gap-2" role="tablist" aria-label="Request type">
            <Button
              type="button"
              role="tab"
              aria-selected={mode === "tier"}
              variant={mode === "tier" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setMode("tier")}
            >
              Choose a plan
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={mode === "custom"}
              variant={mode === "custom" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setMode("custom")}
            >
              Custom request
            </Button>
          </div>

          {mode === "tier" ? (
            <div className="space-y-1.5">
              <label htmlFor="upgrade-tier" className="text-sm font-medium">
                Plan
              </label>
              <select
                id="upgrade-tier"
                value={tierId}
                onChange={(e) => setTierId(e.target.value === "" ? "" : Number(e.target.value))}
                className="h-11 w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm"
              >
                <option value="">Select a plan…</option>
                {upgradeable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} — {tierSummary(t)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label htmlFor="upgrade-amount" className="text-sm font-medium">
                  Scans (optional)
                </label>
                <Input
                  id="upgrade-amount"
                  type="number"
                  min={1}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 500"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="upgrade-days" className="text-sm font-medium">
                  Days (optional)
                </label>
                <Input
                  id="upgrade-days"
                  type="number"
                  min={1}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  placeholder="e.g. 30"
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="upgrade-note" className="text-sm font-medium">
              {mode === "custom" ? "Reason (required)" : "Note (optional)"}
            </label>
            <Textarea
              id="upgrade-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Tell the admin why you need this"
              rows={3}
            />
          </div>

          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
