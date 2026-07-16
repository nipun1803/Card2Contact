import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import type { PageMeta } from "@/shared/types/api";

interface PaginationProps {
  meta: PageMeta;
  /** Whether a "Previous" step is available (the caller holds the cursor stack). */
  hasPrevious: boolean;
  onNext: () => void;
  onPrevious: () => void;
  /** Which "page number" (1-based) the caller is currently showing, for the "Page X of Y" label. */
  currentPage: number;
}

/**
 * Cursor-shaped pagination control — no page-number input, since the backend
 * is keyset/cursor-paginated (stable under concurrent writes; see
 * PgUserStore.list's rationale). "Next" is enabled while meta.nextCursor is
 * non-null; "Previous" pops the caller's local cursor stack. "Page X of Y" is
 * still shown for orientation, computed from meta.total/meta.totalPages, even
 * though navigation itself is cursor-driven.
 */
export function Pagination({ meta, hasPrevious, onNext, onPrevious, currentPage }: PaginationProps) {
  if (meta.total === 0) return null;

  return (
    <div className="flex items-center justify-between gap-4 pt-2">
      <p className="text-sm text-muted-foreground">
        Page {currentPage} of {Math.max(1, meta.totalPages)} &middot; {meta.total} total
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onPrevious} disabled={!hasPrevious}>
          <ChevronLeft aria-hidden />
          Previous
        </Button>
        <Button variant="secondary" size="sm" onClick={onNext} disabled={!meta.nextCursor}>
          Next
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </div>
  );
}
