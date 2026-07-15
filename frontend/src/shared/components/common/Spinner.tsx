import { Loader2 } from "lucide-react";
import { cn } from "@/shared/utils/cn";

interface SpinnerProps {
  className?: string;
  label?: string;
}

/** Accessible spinner — announces a loading label to screen readers. */
export function Spinner({ className, label = "Loading" }: SpinnerProps) {
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className={cn("size-5 animate-spin text-primary", className)} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}
