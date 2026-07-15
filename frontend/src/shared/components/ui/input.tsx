import * as React from "react";
import { cn } from "@/shared/utils/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Applies the destructive error styling and marks the field invalid. */
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, invalid, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex h-11 w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm transition-colors duration-fast placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        invalid && "border-destructive focus-visible:ring-destructive",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
