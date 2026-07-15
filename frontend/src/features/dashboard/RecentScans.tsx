import { useNavigate } from "react-router-dom";
import { ScanLine } from "lucide-react";
import { Card, CardContent } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { EmptyState } from "@/shared/components/common/EmptyState";
import { SectionHeader } from "@/shared/components/common/SectionHeader";
import { Avatar, AvatarFallback } from "@/shared/components/ui/avatar";
import { getRecentScans } from "@/shared/services/recentScans";
import { initials, timeAgo } from "@/shared/utils/format";
import { ROUTES } from "@/shared/lib/constants";

/**
 * Recently saved contacts, read from localStorage (the backend doesn't persist
 * contacts). Best-effort browser-local history.
 */
export function RecentScans() {
  const navigate = useNavigate();
  const scans = getRecentScans();

  return (
    <section>
      <SectionHeader title="Recent scans" description="Saved from this device" />
      {scans.length === 0 ? (
        <EmptyState
          icon={ScanLine}
          title="No scans yet"
          description="Scan your first business card to see it here."
          action={
            <Button onClick={() => navigate(`${ROUTES.scan}?source=camera`)}>Scan a card</Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="divide-y divide-border p-0">
            {scans.map((scan) => (
              <div key={scan.id} className="flex items-center gap-3 p-4">
                <Avatar className="size-9">
                  <AvatarFallback className="text-xs">{initials(scan.name || scan.email)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{scan.name || "Unnamed contact"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {scan.company || scan.email || "—"}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(scan.savedAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
