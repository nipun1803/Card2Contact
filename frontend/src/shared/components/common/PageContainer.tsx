import { cn } from "@/shared/utils/cn";

interface PageContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Max width preset. `narrow` for the scan wizard, `default` for pages. */
  width?: "narrow" | "default" | "wide";
}

const widths = {
  narrow: "max-w-xl",
  default: "max-w-5xl",
  wide: "max-w-6xl",
};

/** Centered, responsive page content wrapper with consistent gutters. */
export function PageContainer({ width = "default", className, ...props }: PageContainerProps) {
  return (
    <div className={cn("mx-auto w-full px-4 py-8 sm:px-6 sm:py-10", widths[width], className)} {...props} />
  );
}
