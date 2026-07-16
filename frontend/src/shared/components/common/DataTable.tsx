import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { cn } from "@/shared/utils/cn";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  /** Present only on columns the backend can sort by (server-side sort). */
  sortField?: string;
  className?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  sortField?: string;
  sortDirection?: "asc" | "desc";
  onSortChange?: (field: string) => void;
  /** Rendered instead of the table body when rows is empty and not loading. */
  emptyState?: React.ReactNode;
}

const SKELETON_ROWS = 5;

/**
 * Generic sortable, loading-aware table. New in this codebase — no such
 * component existed before Admin User Management, since every other list in
 * the app (recent scans) is a card grid, not a table.
 *
 * Sorting is server-side: clicking a sortable header calls onSortChange, the
 * caller re-fetches with the new sortField/sortDirection, and the rows
 * received are already in the right order — this component never re-sorts a
 * partial page client-side.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  sortField,
  sortDirection,
  onSortChange,
  emptyState,
}: DataTableProps<T>) {
  if (!loading && rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((col) => {
            const sortable = Boolean(col.sortField && onSortChange);
            const active = col.sortField === sortField;
            return (
              <TableHead
                key={col.key}
                className={cn(sortable && "cursor-pointer select-none", col.className)}
                onClick={sortable ? () => onSortChange!(col.sortField!) : undefined}
                aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.header}
                  {sortable &&
                    (active ? (
                      sortDirection === "asc" ? (
                        <ArrowUp className="size-3" aria-hidden />
                      ) : (
                        <ArrowDown className="size-3" aria-hidden />
                      )
                    ) : (
                      <ArrowUpDown className="size-3 opacity-40" aria-hidden />
                    ))}
                </span>
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading
          ? Array.from({ length: SKELETON_ROWS }).map((_, i) => (
              <TableRow key={`skeleton-${i}`}>
                {columns.map((col) => (
                  <TableCell key={col.key}>
                    <Skeleton className="h-4 w-full max-w-32" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : rows.map((row) => (
              <TableRow key={rowKey(row)}>
                {columns.map((col) => (
                  <TableCell key={col.key} className={col.className}>
                    {col.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
      </TableBody>
    </Table>
  );
}
