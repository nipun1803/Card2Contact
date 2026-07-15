import { useNavigate } from "react-router-dom";
import { Camera, FileSpreadsheet, Settings, Upload } from "lucide-react";
import { toast } from "sonner";
import { ActionCard } from "@/shared/components/common/ActionCard";
import { SectionHeader } from "@/shared/components/common/SectionHeader";
import { ROUTES } from "@/shared/lib/constants";
import { useSheetStatus, openSheet } from "@/features/sheets/useSheetStatus";

/** Dashboard Quick Actions grid: Scan · Upload · Open Sheet · Settings. */
export function QuickActions() {
  const navigate = useNavigate();
  const { url } = useSheetStatus();

  return (
    <section>
      <SectionHeader title="Quick actions" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ActionCard
          icon={Camera}
          label="Scan card"
          onClick={() => navigate(`${ROUTES.scan}?source=camera`)}
        />
        <ActionCard
          icon={Upload}
          label="Upload image"
          onClick={() => navigate(`${ROUTES.scan}?source=upload`)}
        />
        <ActionCard
          icon={FileSpreadsheet}
          label="Open sheet"
          onClick={() =>
            url ? openSheet(url) : toast.info("Your sheet link isn’t available yet.")
          }
        />
        <ActionCard
          icon={Settings}
          label="Settings"
          onClick={() => navigate(ROUTES.profile)}
        />
      </div>
    </section>
  );
}
