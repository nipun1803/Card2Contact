import { Card, CardContent, CardHeader } from "@/shared/components/ui/card";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { cn } from "@/shared/utils/cn";

interface LoadingCardProps {
  /** Number of body lines to show. */
  lines?: number;
  className?: string;
}

/** Skeleton stand-in for a card whose data is still loading. */
export function LoadingCard({ lines = 3, className }: LoadingCardProps) {
  return (
    <Card className={cn(className)} aria-hidden>
      <CardHeader>
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
        ))}
      </CardContent>
    </Card>
  );
}
