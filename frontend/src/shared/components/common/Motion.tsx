import { cn } from "@/shared/utils/cn";
import { usePrefersReducedMotion } from "@/shared/hooks/usePrefersReducedMotion";

/**
 * Entrance animations use CSS keyframes (see tailwind.config `fade-up`), NOT
 * JS-driven opacity. This is deliberate: a JS wrapper that starts at opacity 0
 * leaves content invisible if the animation library is slow to hydrate or
 * throttled. CSS animations always settle to the visible end state and need no
 * runtime. Reduced-motion (or the `animations` flag off) skips the animation
 * class entirely, so content still renders instantly.
 */

interface MotionProps {
  children: React.ReactNode;
  className?: string;
  /** Stagger delay index (0-based) for sequenced entrances. */
  index?: number;
}

export function FadeIn({ children, className, index = 0 }: MotionProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <div
      className={cn(!reduced && "motion-safe:animate-fade-up", className)}
      style={reduced ? undefined : { animationDelay: `${index * 60}ms`, animationFillMode: "backwards" }}
    >
      {children}
    </div>
  );
}

/** Alias kept for routed pages; behaves identically to FadeIn. */
export function PageTransition({ children, className }: MotionProps) {
  return <FadeIn className={className}>{children}</FadeIn>;
}

/**
 * Stagger container. Children rendered via <StaggerItem index={i}> fade up in
 * sequence. Implemented purely with CSS animation delays.
 */
export function Stagger({ children, className }: MotionProps) {
  return <div className={className}>{children}</div>;
}

export function StaggerItem({ children, className, index = 0 }: MotionProps) {
  return (
    <FadeIn className={className} index={index}>
      {children}
    </FadeIn>
  );
}
