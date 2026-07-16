import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Users, UserCheck, UserX, Activity, ScanLine } from "lucide-react";
import { useAdminUsersList } from "@/features/admin/useAdminUsers";
import { StatCard } from "@/shared/components/common/StatCard";
import { DataTable, type DataTableColumn } from "@/shared/components/common/DataTable";
import { Pagination } from "@/shared/components/common/Pagination";
import { StatusBadge } from "@/shared/components/common/StatusBadge";
import { EmptyState } from "@/shared/components/common/EmptyState";
import { ErrorState } from "@/shared/components/common/ErrorState";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { Input } from "@/shared/components/ui/input";
import { adminUserDetailPath } from "@/shared/lib/constants";
import type { AdminUserSummary } from "@/shared/types/api";
import type { ListUsersQuery } from "@/shared/services/api";

const SEARCH_DEBOUNCE_MS = 300;

type SortField = NonNullable<ListUsersQuery["sortField"]>;

const COLUMNS: DataTableColumn<AdminUserSummary>[] = [
  { key: "email", header: "Email", sortField: "email", render: (u) => u.email },
  { key: "status", header: "Status", render: (u) => <StatusBadge disabled={u.disabled} /> },
  {
    key: "savedContactsCount",
    header: "Total Scans",
    sortField: "savedContactsCount",
    render: (u) => u.savedContactsCount,
  },
  {
    key: "createdAt",
    header: "Registered",
    sortField: "createdAt",
    render: (u) => new Date(u.createdAt).toLocaleDateString(),
  },
  {
    key: "lastLoginAt",
    header: "Last Login",
    sortField: "lastLoginAt",
    render: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "Never"),
  },
  {
    key: "actions",
    header: "",
    render: (u) => (
      <Link
        to={adminUserDetailPath(u.googleUserId)}
        className="text-sm font-medium text-primary hover:underline"
      >
        View
      </Link>
    ),
  },
];

/** User Directory — the default admin view (see AdminDashboard's shell/Outlet). */
export default function AdminUsers() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ListUsersQuery["status"]>("all");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  // Cursor pagination: a stack of visited cursors so "Previous" can pop back
  // without a backend "page N" concept (see PgUserStore.list's rationale).
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  // Debounce the search box so every keystroke doesn't trigger a fetch.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query: ListUsersQuery = { cursor, limit: 20, search: search || undefined, status, sortField, sortDirection };
  const { data, isLoading, isError, error, refetch } = useAdminUsersList(query);

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

  return (
    <PageContainer width="wide">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">User Directory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            View, search, and manage every card2contact user.
          </p>
        </div>

        {isError ? (
          <ErrorState
            message={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard icon={Users} label="Total Users" value={data?.data.stats.total ?? "—"} />
              <StatCard icon={UserCheck} label="Active Users" value={data?.data.stats.active ?? "—"} />
              <StatCard icon={UserX} label="Revoked Users" value={data?.data.stats.disabled ?? "—"} />
              <StatCard
                icon={Activity}
                label="Recent Logins"
                value={data?.data.stats.recentLogins ?? "—"}
                hint="last 24h"
              />
              <StatCard
                icon={ScanLine}
                label="Total Scans"
                value={data?.data.stats.totalScans ?? "—"}
                hint="app-wide"
              />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Input
                placeholder="Search by email or Google user id…"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  resetPagination();
                }}
                className="sm:max-w-xs"
              />
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as ListUsersQuery["status"]);
                  resetPagination();
                }}
                className="h-11 rounded-md border border-input bg-card px-3 text-sm shadow-sm"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="disabled">Revoked</option>
              </select>
            </div>

            <DataTable
              columns={COLUMNS}
              rows={data?.data.users ?? []}
              rowKey={(u) => u.googleUserId}
              loading={isLoading}
              sortField={sortField}
              sortDirection={sortDirection}
              onSortChange={handleSortChange}
              emptyState={
                <EmptyState
                  icon={Users}
                  title={hasActiveFilter ? "No matching users" : "No users yet"}
                  description={
                    hasActiveFilter
                      ? "Try a different search term or clear the filters."
                      : "Once someone signs in with Google, they'll show up here."
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
