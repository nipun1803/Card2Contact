import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Gauge, Ban, ScanLine, CreditCard, AlertTriangle } from "lucide-react";
import { useLicensesList } from "@/features/admin/useAdminLicenses";
import { StatCard } from "@/shared/components/common/StatCard";
import { DataTable, type DataTableColumn } from "@/shared/components/common/DataTable";
import { Pagination } from "@/shared/components/common/Pagination";
import { EmptyState } from "@/shared/components/common/EmptyState";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { PageHeader } from "@/shared/components/common/PageHeader";
import { Input } from "@/shared/components/ui/input";
import { Select } from "@/shared/components/ui/select";
import { Badge } from "@/shared/components/ui/badge";
import { adminLicenseDetailPath } from "@/shared/lib/constants";
import type { EffectiveQuota } from "@/shared/types/api";
import type { ListLicensesQuery } from "@/shared/services/api";

const SEARCH_DEBOUNCE_MS = 300;

type SortField = NonNullable<ListLicensesQuery["sortField"]>;

const COLUMNS: DataTableColumn<EffectiveQuota>[] = [
  { key: "user", header: "User", sortField: "googleUserId", render: (q) => q.email || q.googleUserId },
  {
    key: "tier",
    header: "Active Tier",
    render: (q) =>
      q.unlimited ? (
        <Badge variant="success">Unlimited</Badge>
      ) : (
        <Badge variant="default">{q.activeTier?.name ?? "Free"}</Badge>
      ),
  },
  {
    key: "free",
    header: "Free",
    sortField: "freeUsed",
    render: (q) => `${q.freeUsed}/${q.freeLimit}`,
  },
  { key: "paidRemaining", header: "Paid remaining", render: (q) => q.paidRemaining },
  {
    key: "totalRemaining",
    header: "Total remaining",
    sortField: "totalRemaining",
    render: (q) => (q.unlimited ? "∞" : q.totalRemaining),
  },
  {
    key: "scanBlocked",
    header: "Scan-blocked",
    render: (q) => (q.scanBlocked ? <Badge variant="warning">Blocked</Badge> : "—"),
  },
  {
    key: "actions",
    header: "",
    render: (q) => (
      <Link
        to={adminLicenseDetailPath(q.googleUserId)}
        className="text-sm font-medium text-primary hover:underline"
      >
        Manage
      </Link>
    ),
  },
];

/** Scan License directory — per-user effective quotas across every user. */
export default function AdminLicenses() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ListLicensesQuery["status"]>("all");
  const [sortField, setSortField] = useState<SortField>("googleUserId");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  // Cursor pagination: a stack of visited cursors so "Previous" can pop back.
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  // Debounce the search box so every keystroke doesn't trigger a fetch.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query: ListLicensesQuery = {
    cursor,
    limit: 20,
    search: search || undefined,
    status,
    sortField,
    sortDirection,
  };
  const { data, isLoading, isError, error, refetch } = useLicensesList(query);

  function resetPagination() {
    setCursorStack([undefined]);
  }

  function handleSortChange(field: string) {
    if (field === sortField) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field as SortField);
      setSortDirection("asc");
    }
    resetPagination();
  }

  const hasActiveFilter = search !== "" || status !== "all";

  function toggleStatusFilter(value: NonNullable<ListLicensesQuery["status"]>) {
    setStatus((current) => (current === value ? "all" : value));
    resetPagination();
  }

  return (
    <PageContainer width="wide">
      <div className="space-y-6">
        <PageHeader
          title="Scan Licenses"
          description="Review and adjust every user's scan allowance, tiers, and paid grants."
        />

        {isError ? (
          <ErrorState
            message={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard
                icon={Gauge}
                label="Active Scan Users"
                value={data?.data.stats.usersWithQuota ?? "—"}
                hint="have a quota record"
              />
              <StatCard
                icon={Ban}
                label="Scan-Blocked"
                value={data?.data.stats.scanBlocked ?? "—"}
                onClick={() => toggleStatusFilter("scan_blocked")}
                active={status === "scan_blocked"}
              />
              <StatCard
                icon={ScanLine}
                label="Free Scans Used"
                value={data?.data.stats.totalFreeUsed ?? "—"}
                hint="app-wide"
              />
              <StatCard
                icon={CreditCard}
                label="Paid Scans Used"
                value={data?.data.stats.totalPaidUsed ?? "—"}
                hint="app-wide"
              />
              <StatCard
                icon={AlertTriangle}
                label="Low Remaining"
                value={data?.data.stats.lowRemaining ?? "—"}
                hint="≤3 scans left"
                onClick={() => toggleStatusFilter("low")}
                active={status === "low"}
              />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1.5 sm:max-w-xs sm:flex-1">
                <label htmlFor="license-search" className="text-sm font-medium text-foreground">
                  Search
                </label>
                <Input
                  id="license-search"
                  placeholder="Search by Google user id…"
                  value={searchInput}
                  onChange={(e) => {
                    setSearchInput(e.target.value);
                    resetPagination();
                  }}
                />
              </div>
              <Select
                label="Status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as ListLicensesQuery["status"]);
                  resetPagination();
                }}
                className="sm:w-56"
              >
                <option value="all">All statuses</option>
                <option value="low">Low remaining</option>
                <option value="over">Over limit</option>
                <option value="custom">Custom override</option>
                <option value="scan_blocked">Scan-blocked</option>
              </Select>
            </div>

            <DataTable
              columns={COLUMNS}
              rows={data?.data.quotas ?? []}
              rowKey={(q) => q.googleUserId}
              loading={isLoading}
              sortField={sortField}
              sortDirection={sortDirection}
              onSortChange={handleSortChange}
              emptyState={
                <EmptyState
                  icon={Gauge}
                  title={hasActiveFilter ? "No matching users" : "No quotas yet"}
                  description={
                    hasActiveFilter
                      ? "Try a different search term or clear the filters."
                      : "Once someone signs in and scans, their quota will show up here."
                  }
                />
              }
            />

            {data && (
              <Pagination
                meta={data.meta.page}
                currentPage={cursorStack.length}
                hasPrevious={cursorStack.length > 1}
                onNext={() => {
                  if (data.meta.page.nextCursor) {
                    setCursorStack((s) => [...s, data.meta.page.nextCursor ?? undefined]);
                  }
                }}
                onPrevious={() => setCursorStack((s) => s.slice(0, -1))}
              />
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}
