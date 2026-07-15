import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/shared/hooks/useOnlineStatus";

/**
 * Fixed banner shown when the browser goes offline. Purely informational —
 * actions that need the network disable themselves independently.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-warning px-4 py-2 text-sm font-medium text-warning-foreground"
    >
      <WifiOff className="size-4" aria-hidden />
      You’re offline — reconnect to scan and save cards.
    </div>
  );
}
