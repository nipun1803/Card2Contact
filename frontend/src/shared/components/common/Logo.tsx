import { cn } from "@/shared/utils/cn";

interface LogoProps {
  className?: string;
  /** Show the wordmark next to the mark. */
  withWordmark?: boolean;
}

/** Card2Contact brand mark — a business card with an extracted contact line. */
export function Logo({ className, withWordmark = true }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <svg
        viewBox="0 0 32 32"
        className="size-8 shrink-0"
        role="img"
        aria-label="Card2Contact logo"
      >
        <rect x="4" y="7" width="24" height="18" rx="3" className="fill-primary/10" />
        <rect
          x="4"
          y="7"
          width="24"
          height="18"
          rx="3"
          className="fill-none stroke-primary"
          strokeWidth="1.8"
        />
        <circle cx="11" cy="14" r="2.4" className="fill-primary" />
        <line x1="16" y1="13" x2="23" y2="13" className="stroke-primary" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="8" y1="19.5" x2="24" y2="19.5" className="stroke-foreground/60" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {withWordmark && (
        <span className="font-serif text-lg font-semibold tracking-tight text-foreground">
          Card2Contact
        </span>
      )}
    </span>
  );
}
