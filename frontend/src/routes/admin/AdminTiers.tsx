import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { useTierActions, useTiers } from "@/features/admin/useAdminLicenses";
import { DataTable, type DataTableColumn } from "@/shared/components/common/DataTable";
import { ConfirmDialog } from "@/shared/components/common/ConfirmDialog";
import { EmptyState } from "@/shared/components/common/EmptyState";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { PageHeader } from "@/shared/components/common/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Select } from "@/shared/components/ui/select";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import type { Tier } from "@/shared/types/api";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Editor state. `id` is null for "create" (or a clone, which pre-fills fields
 * from a source tier but still creates a new one) and a number for "update".
 */
interface EditorState {
  id: number | null;
  name: string;
  isUnlimited: boolean;
  scanLimit: string;
  validityDays: string;
  /** Users currently holding the tier being edited — for the impact note. */
  assignedCount: number;
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  name: "",
  isUnlimited: false,
  scanLimit: "",
  validityDays: "",
  assignedCount: 0,
};

/** Tier catalog — create, edit, clone, and archive scan tiers. */
export default function AdminTiers() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [archiving, setArchiving] = useState<Tier | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const { data, isLoading, isError, error, refetch } = useTiers(search || undefined);
  const { create, update, archive } = useTierActions();

  function openCreate() {
    setFormError(null);
    setEditor({ ...EMPTY_EDITOR });
  }

  function openEdit(tier: Tier) {
    setFormError(null);
    setEditor({
      id: tier.id,
      name: tier.name,
      isUnlimited: tier.isUnlimited,
      scanLimit: tier.scanLimit === null ? "" : String(tier.scanLimit),
      validityDays: tier.validityDays === null ? "" : String(tier.validityDays),
      assignedCount: tier.assignedCount ?? 0,
    });
  }

  function openClone(tier: Tier) {
    // A clone always creates a new tier (id: null), pre-filled from the source.
    setFormError(null);
    setEditor({
      id: null,
      name: `${tier.name} (copy)`,
      isUnlimited: tier.isUnlimited,
      scanLimit: tier.scanLimit === null ? "" : String(tier.scanLimit),
      validityDays: tier.validityDays === null ? "" : String(tier.validityDays),
      assignedCount: 0,
    });
  }

  async function handleSave() {
    if (!editor) return;
    // Client-side validation mirroring the backend's validateTierShape, so a
    // limited tier without a positive scan limit is caught here (with a clear
    // field message) instead of round-tripping to a generic server 400. This is
    // the fix for "toggle to Limited, forget the limit, submit anyway".
    const name = editor.name.trim();
    if (!name) {
      setFormError("Tier name is required.");
      return;
    }
    if (!editor.isUnlimited) {
      const limit = Number(editor.scanLimit);
      if (editor.scanLimit === "" || !Number.isInteger(limit) || limit < 1) {
        setFormError("A Limited tier needs a scan limit of at least 1.");
        return;
      }
    }
    if (editor.validityDays !== "") {
      const days = Number(editor.validityDays);
      if (!Number.isInteger(days) || days < 1) {
        setFormError("Validity must be a whole number of days (1 or more), or blank for no expiry.");
        return;
      }
    }
    setFormError(null);
    const input = {
      name,
      isUnlimited: editor.isUnlimited,
      scanLimit: editor.isUnlimited || editor.scanLimit === "" ? null : Number(editor.scanLimit),
      validityDays: editor.validityDays === "" ? null : Number(editor.validityDays),
    };
    try {
      if (editor.id === null) {
        await create.mutateAsync(input);
      } else {
        await update.mutateAsync({ id: editor.id, patch: input });
      }
      setEditor(null);
    } catch {
      // Surfaced via the mutation's error state in the editor dialog below.
    }
  }

  async function handleArchive() {
    if (!archiving) return;
    try {
      await archive.mutateAsync(archiving.id);
      setArchiving(null);
    } catch {
      // Surfaced via ConfirmDialog's errorMessage below (e.g. can't archive default).
    }
  }

  const COLUMNS: DataTableColumn<Tier>[] = [
    { key: "name", header: "Name", render: (t) => t.name },
    {
      key: "type",
      header: "Type",
      render: (t) =>
        t.isUnlimited ? (
          <Badge variant="success">Unlimited</Badge>
        ) : (
          <Badge variant="default">{`${t.scanLimit ?? 0} scans`}</Badge>
        ),
    },
    {
      key: "validity",
      header: "Validity",
      render: (t) => (t.validityDays ? `${t.validityDays} days` : "No expiry"),
    },
    {
      key: "default",
      header: "Default",
      render: (t) => (t.isDefault ? <Badge variant="primary">Default</Badge> : "—"),
    },
    { key: "assignedCount", header: "Assigned", render: (t) => `${t.assignedCount ?? 0} users` },
    {
      key: "actions",
      header: "",
      render: (t) => (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => openEdit(t)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openClone(t)}>
            Clone
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArchiving(t)}>
            Archive
          </Button>
        </div>
      ),
    },
  ];

  const editorError = editor?.id === null ? create.error : update.error;
  const saving = create.isPending || update.isPending;

  return (
    <PageContainer width="wide">
      <div className="space-y-6">
        <PageHeader
          title="Tiers"
          description="Configure scan tiers. Changes apply to future assignments only."
          actions={
            <Button variant="primary" onClick={openCreate}>
              New Tier
            </Button>
          }
        />

        {isError ? (
          <ErrorState
            message={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            <Input
              placeholder="Search tiers by name…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="sm:max-w-xs"
            />

            <DataTable
              columns={COLUMNS}
              rows={data?.data.tiers ?? []}
              rowKey={(t) => String(t.id)}
              loading={isLoading}
              emptyState={
                <EmptyState
                  icon={Layers}
                  title={search ? "No matching tiers" : "No tiers yet"}
                  description={
                    search
                      ? "Try a different search term."
                      : "Create a tier to grant users more than the default free allowance."
                  }
                />
              }
            />
          </>
        )}
      </div>

      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editor?.id === null ? "New Tier" : "Edit Tier"}</DialogTitle>
          </DialogHeader>
          {editor && (
            <div className="space-y-4 text-sm">
              <div className="space-y-1.5">
                <label htmlFor="tier-name" className="font-medium">
                  Name
                </label>
                <Input
                  id="tier-name"
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  placeholder="Tier name"
                />
              </div>

              <Select
                label="Type"
                id="tier-type"
                value={editor.isUnlimited ? "unlimited" : "limited"}
                onChange={(e) => {
                  setFormError(null);
                  setEditor({ ...editor, isUnlimited: e.target.value === "unlimited" });
                }}
              >
                <option value="limited">Limited</option>
                <option value="unlimited">Unlimited</option>
              </Select>

              {!editor.isUnlimited && (
                <div className="space-y-1.5">
                  <label htmlFor="tier-scan-limit" className="font-medium">
                    Scan limit
                  </label>
                  <Input
                    id="tier-scan-limit"
                    type="number"
                    min={1}
                    value={editor.scanLimit}
                    onChange={(e) => setEditor({ ...editor, scanLimit: e.target.value })}
                    placeholder="e.g. 100"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="tier-validity" className="font-medium">
                  Validity (days)
                </label>
                <Input
                  id="tier-validity"
                  type="number"
                  min={0}
                  value={editor.validityDays}
                  onChange={(e) => setEditor({ ...editor, validityDays: e.target.value })}
                  placeholder="Leave blank for no expiry"
                />
              </div>

              <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">Preview</p>
                <p>
                  Scan Limit: {editor.isUnlimited ? "—" : editor.scanLimit || "0"} / Unlimited:{" "}
                  {editor.isUnlimited ? "yes" : "no"} / Validity:{" "}
                  {editor.validityDays ? `${editor.validityDays} days` : "no expiry"}
                </p>
              </div>

              {editor.id !== null && (
                <p className="text-xs text-muted-foreground">
                  {editor.assignedCount} users currently hold this tier. Changes apply to future
                  assignments only.
                </p>
              )}

              {(formError || editorError) && (
                <p role="alert" className="text-sm text-destructive">
                  {formError ??
                    (editorError instanceof Error ? editorError.message : "Something went wrong")}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditor(null)} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              disabled={!editor || editor.name.trim() === ""}
              onClick={() => void handleSave()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title="Archive tier?"
        description={
          archiving
            ? `"${archiving.name}" will be archived and can no longer be assigned. Existing assignments are unaffected.`
            : undefined
        }
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        errorMessage={archive.error ? (archive.error instanceof Error ? archive.error.message : "Something went wrong") : null}
        onConfirm={() => void handleArchive()}
      />
    </PageContainer>
  );
}
