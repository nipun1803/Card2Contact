import { useNavigate } from "react-router-dom";
import { Camera, Upload } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { useFeatureFlag } from "@/shared/hooks/useFeatureFlag";
import { ROUTES } from "@/shared/lib/constants";
import { nameFromEmail } from "@/shared/utils/format";

/** Dashboard hero: personal greeting + the two primary CTAs (Scan / Upload). */
export function WelcomeHero({ email }: { email?: string }) {
  const navigate = useNavigate();
  const cameraEnabled = useFeatureFlag("camera");
  const uploadEnabled = useFeatureFlag("upload");

  return (
    <section className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-6 shadow-sm sm:p-8">
      <p className="text-sm font-medium text-primary">👋 Welcome back</p>
      <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">Hi {nameFromEmail(email)}</h1>
      <p className="mt-2 max-w-prose text-muted-foreground">
        Turn a business card into a saved contact in seconds. Scan or upload, review the details,
        and we’ll drop it straight into your Google Sheet.
      </p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        {cameraEnabled && (
          <Button size="lg" onClick={() => navigate(`${ROUTES.scan}?source=camera`)}>
            <Camera aria-hidden />
            Scan business card
          </Button>
        )}
        {uploadEnabled && (
          <Button
            size="lg"
            variant="secondary"
            onClick={() => navigate(`${ROUTES.scan}?source=upload`)}
          >
            <Upload aria-hidden />
            Upload business card
          </Button>
        )}
      </div>
    </section>
  );
}
