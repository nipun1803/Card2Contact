import { RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/shared/components/ui/card";
import { GoogleSignInButton } from "./GoogleSignInButton";

/**
 * Shown when the backend reports needsReconnect (Google tokens revoked/expired)
 * — either proactively from /status or reactively after a REAUTH_REQUIRED save
 * error. Re-runs the same OAuth flow to restore access.
 */
export function ReconnectPanel({ note }: { note?: string }) {
  return (
    <Card className="mx-auto max-w-md text-center">
      <CardContent className="flex flex-col items-center gap-5 p-8">
        <span className="flex size-14 items-center justify-center rounded-full bg-warning/15 text-warning-foreground">
          <RefreshCw className="size-6" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-xl font-semibold">Reconnect Google</h2>
          <p className="text-sm text-muted-foreground">
            {note ??
              "Your Google connection expired. Reconnect to keep saving contacts to your sheet."}
          </p>
        </div>
        <GoogleSignInButton label="Reconnect with Google" className="w-full" />
      </CardContent>
    </Card>
  );
}
