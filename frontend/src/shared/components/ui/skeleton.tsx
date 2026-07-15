import { cn } from "@/shared/utils/cn";

/** A neutral, shimmering placeholder block for content that is loading. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("shimmer rounded-md bg-muted", className)}
      aria-hidden
      {...props}
    />
  );
}

export { Skeleton };
