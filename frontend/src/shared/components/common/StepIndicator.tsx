import { Check } from "lucide-react";
import { cn } from "@/shared/utils/cn";

export interface Step {
  key: string;
  label: string;
}

interface StepIndicatorProps {
  steps: readonly Step[];
  /** Index of the currently active step (0-based). -1 = none active. */
  current: number;
  className?: string;
}

/**
 * Horizontal progress strip (Scan → Extract → Review → Save). Steps before
 * `current` render as complete (check), the current one is highlighted, and
 * later ones are muted. Used both on the dashboard (non-interactive) and the
 * scan wizard header.
 */
export function StepIndicator({ steps, current, className }: StepIndicatorProps) {
  return (
    <ol className={cn("flex items-center gap-2", className)} aria-label="Progress">
      {steps.map((step, i) => {
        const complete = i < current;
        const active = i === current;
        return (
          <li key={step.key} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-fast",
                complete && "border-primary bg-primary text-primary-foreground",
                active && "border-primary bg-primary/10 text-primary",
                !complete && !active && "border-border bg-card text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              {complete ? <Check className="size-3.5" aria-hidden /> : i + 1}
            </span>
            <span
              className={cn(
                "hidden text-sm font-medium sm:inline",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {step.label}
            </span>
            {i < steps.length - 1 && (
              <span
                className={cn(
                  "h-px flex-1 transition-colors duration-fast",
                  complete ? "bg-primary" : "bg-border",
                )}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
