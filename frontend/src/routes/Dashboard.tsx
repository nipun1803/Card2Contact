import { Contact } from "lucide-react";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { StatCard } from "@/shared/components/common/StatCard";
import { Skeleton } from "@/shared/components/ui/skeleton";
import { Stagger, StaggerItem } from "@/shared/components/common/Motion";
import { useAuth } from "@/features/auth/useAuth";
import { useSavedContactsCount } from "@/features/sheets/useSheetStatus";
import { WelcomeHero } from "@/features/dashboard/WelcomeHero";
import { QuickActions } from "@/features/dashboard/QuickActions";
import { WorkflowProgress } from "@/features/dashboard/WorkflowProgress";
import { RecentScans } from "@/features/dashboard/RecentScans";
import { TipsCard } from "@/features/dashboard/TipsCard";
import { SheetStatusCard } from "@/features/sheets/SheetStatusCard";

/** Authenticated home. Action hub + Google Sheet status + recent scans. */
export default function Dashboard() {
  const { email } = useAuth();
  const { count, isLoading: countLoading } = useSavedContactsCount();

  return (
    <PageContainer>
      <Stagger className="space-y-10">
        <StaggerItem index={0}>
          <WelcomeHero email={email} />
        </StaggerItem>

        <StaggerItem index={1}>
          {countLoading ? (
            <Skeleton className="h-[4.5rem] w-full max-w-xs" />
          ) : (
            <StatCard
              icon={Contact}
              label="Contacts saved"
              value={count}
              hint="Total, across every device"
              className="max-w-xs"
            />
          )}
        </StaggerItem>

        <StaggerItem index={2}>
          <QuickActions />
        </StaggerItem>

        {/* Two-column on large screens: recent scans + sidebar (sheet + tips). */}
        <StaggerItem index={3}>
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <RecentScans />
            </div>
            <div className="space-y-6">
              <SheetStatusCard />
              <TipsCard />
            </div>
          </div>
        </StaggerItem>

        <StaggerItem index={4}>
          <WorkflowProgress />
        </StaggerItem>
      </Stagger>
    </PageContainer>
  );
}
