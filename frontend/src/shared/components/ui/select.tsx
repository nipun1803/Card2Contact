import * as React from "react";
import { cn } from "@/shared/utils/cn";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Visible label text. Required so every Select stays accessible by construction. */
  label: string;
  /** Hides the label visually while keeping it for screen readers. */
  hideLabel?: boolean;
}

/** Styled native <select>, visually matched to `Input`, with a mandatory accessible label. */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, hideLabel, id, children, ...props }, ref) => {
    const generatedId = React.useId();
    const selectId = id ?? generatedId;
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={selectId} className={cn("text-sm font-medium text-foreground", hideLabel && "sr-only")}>
          {label}
        </label>
        <select
          id={selectId}
          ref={ref}
          className={cn(
            "flex h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        >
          {children}
        </select>
      </div>
    );
  },
);
Select.displayName = "Select";

export { Select };
