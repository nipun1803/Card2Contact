import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Pagination } from "@/shared/components/common/Pagination";
import { EmptyState } from "@/shared/components/common/EmptyState";
import type { PageMeta } from "@/shared/types/api";

interface HistoryListProps<T> {
  entries: T[];
  rowKey: (entry: T) => string | number;
  renderEntry: (entry: T) => ReactNode;
  meta: PageMeta;
  currentPage: number;
  hasPrevious: boolean;
  onNext: () => void;
  onPrevious: () => void;
  emptyIcon?: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
}

/** Cursor-paginated `<ul>` of history rows, with the shared empty state. Used for tier/quota/audit history. */
export function HistoryList<T>({
  entries,
  rowKey,
  renderEntry,
  meta,
  currentPage,
  hasPrevious,
  onNext,
  onPrevious,
  emptyIcon,
  emptyTitle,
  emptyDescription,
}: HistoryListProps<T>) {
  if (entries.length === 0) {
    return <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border">
        {entries.map((entry) => (
          <li key={rowKey(entry)} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            {renderEntry(entry)}
          </li>
        ))}
      </ul>
      <Pagination
        meta={meta}
        currentPage={currentPage}
        hasPrevious={hasPrevious}
        onNext={onNext}
        onPrevious={onPrevious}
      />
    </div>
  );
}
