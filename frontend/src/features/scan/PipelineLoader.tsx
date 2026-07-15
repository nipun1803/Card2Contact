import { motion } from "framer-motion";
import { Card, CardContent } from "@/shared/components/ui/card";
import { usePrefersReducedMotion } from "@/shared/hooks/usePrefersReducedMotion";

interface PipelineLoaderProps {
  title: string;
  description?: string;
}

/**
 * Labelled loader for the transient pipeline stages (recognizing, extracting,
 * saving) that have no UI of their own. A soft pulsing ring communicates
 * progress without a fake percentage.
 */
export function PipelineLoader({ title, description }: PipelineLoaderProps) {
  const reduced = usePrefersReducedMotion();

  return (
    <Card className="mx-auto max-w-md">
      <CardContent className="flex flex-col items-center gap-6 p-10 text-center" role="status" aria-live="polite">
        <div className="relative flex size-16 items-center justify-center">
          <span className="absolute inset-0 rounded-full border-2 border-primary/20" />
          <motion.span
            className="absolute inset-0 rounded-full border-2 border-transparent border-t-primary"
            animate={reduced ? undefined : { rotate: 360 }}
            transition={reduced ? undefined : { repeat: Infinity, duration: 0.9, ease: "linear" }}
          />
          <motion.span
            className="size-3 rounded-full bg-primary"
            animate={reduced ? undefined : { scale: [1, 1.4, 1], opacity: [0.6, 1, 0.6] }}
            transition={reduced ? undefined : { repeat: Infinity, duration: 1.4, ease: "easeInOut" }}
          />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-lg font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
