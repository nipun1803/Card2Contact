import type { LucideIcon } from "lucide-react";
import { Card } from "@/shared/components/ui/card";
import { cn } from "@/shared/utils/cn";

interface StatCardProps {
  icon?: LucideIcon;
  label: string;
  value: React.ReactNode;
  hint?: string;
  className?: string;
  /** When provided, the card becomes a toggle button (e.g. "click to filter the table"). */
  onClick?: () => void;
  /** Visually marks the card as the active filter when onClick is set. */
  active?: boolean;
}

/** Compact metric tile: label, prominent value, optional icon + hint. Optionally clickable. */
export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  className,
  onClick,
  active,
}: StatCardProps) {
  const content = (
    <>
      {Icon && (
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary",
            active && "bg-primary text-primary-foreground"
          )}
        >
          <Icon className="size-5" aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm text-muted-foreground">{label}</p>
        <p className="truncate text-lg font-semibold">{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={cn(
          "focus-ring flex w-full items-center gap-4 rounded-lg border border-border bg-card p-5 text-left text-card-foreground shadow-sm transition-colors hover:bg-accent/50",
          active && "ring-2 ring-primary",
          className
        )}
      >
        {content}
      </button>
    );
  }

  return <Card className={cn("flex items-center gap-4 p-5", className)}>{content}</Card>;
}
