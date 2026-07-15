import { cn } from "@/shared/utils/cn";

interface SectionHeaderProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/** Smaller heading for sections within a page. */
export function SectionHeader({ title, description, action, className }: SectionHeaderProps) {
  return (
    <div className={cn("mb-4 flex items-center justify-between gap-3", className)}>
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
