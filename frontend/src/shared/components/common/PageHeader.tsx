import { cn } from "@/shared/utils/cn";

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Optional actions rendered on the right (buttons, etc.). */
  actions?: React.ReactNode;
  className?: string;
}

/** Standard page title block: serif heading + supporting copy + actions. */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="space-y-1.5">
        <h1 className="text-3xl font-semibold sm:text-4xl">{title}</h1>
        {description && <p className="max-w-prose text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
