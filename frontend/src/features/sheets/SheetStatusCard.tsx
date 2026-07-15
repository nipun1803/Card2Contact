import { CheckCircle2, ExternalLink, FileSpreadsheet, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Badge } from "@/shared/components/ui/badge";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { GoogleSignInButton } from "@/features/auth/GoogleSignInButton";
import { useSheetStatus, openSheet } from "./useSheetStatus";
import { timeAgo } from "@/shared/utils/format";

/**
 * Dashboard "Google Sheet Status" card. Shows connection state, sheet name and
 * (when the backend exposes them) a link + last-synced time. Falls back
 * gracefully for the fields the current /status endpoint doesn't return yet.
 */
export function SheetStatusCard() {
  const { isLoading, connected, needsReconnect, title, url, lastSyncedAt } = useSheetStatus();

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="size-5 text-primary" aria-hidden />
          Google Sheet
        </CardTitle>
        {!isLoading &&
          (connected ? (
            <Badge variant="success">
              <CheckCircle2 className="size-3.5" aria-hidden />
              Connected
            </Badge>
          ) : (
            <Badge variant="warning">Disconnected</Badge>
          ))}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : needsReconnect ? (
          <>
            <p className="text-sm text-muted-foreground">
              Your Google connection expired. Reconnect to keep saving contacts.
            </p>
            <GoogleSignInButton label="Reconnect Google" size="md" className="w-full" />
          </>
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Saving to</p>
              <p className="truncate font-medium">{title}</p>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <RefreshCw className="size-3.5" aria-hidden />
                {lastSyncedAt ? `Last synced ${timeAgo(lastSyncedAt)}` : "Synced automatically"}
              </span>
            </div>
            <Button
              variant="secondary"
              size="md"
              className="w-full"
              disabled={!url}
              onClick={() => openSheet(url)}
              title={url ? undefined : "Sheet link isn’t available yet"}
            >
              <ExternalLink aria-hidden />
              {url ? "Open sheet" : "Sheet link unavailable"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
