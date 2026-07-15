import type { LucideIcon } from "lucide-react";
import { Card } from "@/shared/components/ui/card";
import { cn } from "@/shared/utils/cn";

interface StatCardProps {
  icon?: LucideIcon;
  label: string;
  value: React.ReactNode;
  hint?: string;
  className?: string;
}

/** Compact metric tile: label, prominent value, optional icon + hint. */
export function StatCard({ icon: Icon, label, value, hint, className }: StatCardProps) {
  return (
    <Card className={cn("flex items-center gap-4 p-5", className)}>
      {Icon && (
        <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-5" aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate text-sm text-muted-foreground">{label}</p>
        <p className="truncate text-lg font-semibold">{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </Card>
  );
}
