import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/shared/utils/cn";

interface ActionCardProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  description?: string;
}

/**
 * A tappable quick-action tile (button semantics, keyboard-accessible). Used in
 * the dashboard Quick Actions grid. Renders as a real <button> so Enter/Space
 * and focus work for free.
 */
export const ActionCard = React.forwardRef<HTMLButtonElement, ActionCardProps>(
  ({ icon: Icon, label, description, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "group flex min-h-[6rem] flex-col items-start gap-2 rounded-lg border border-border bg-card p-4 text-left shadow-sm transition-all duration-fast ease-smooth hover:-translate-y-0.5 hover:border-primary/40 hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className="text-sm font-semibold">{label}</span>
      {description && <span className="text-xs text-muted-foreground">{description}</span>}
    </button>
  ),
);
ActionCard.displayName = "ActionCard";
