import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { PageContainer } from "@/shared/components/common/PageContainer";
import { StepIndicator } from "@/shared/components/common/StepIndicator";
import { PageTransition } from "@/shared/components/common/Motion";
import { LoadingCard } from "@/shared/components/common/LoadingCard";
import { WORKFLOW_STEPS } from "@/shared/lib/constants";
import { useCardPipeline, type PipelineStatus } from "@/features/scan/useCardPipeline";
import { PipelineLoader } from "@/features/scan/PipelineLoader";
import { SaveSuccess } from "@/features/review/SaveSuccess";
import { ReconnectPanel } from "@/features/auth/ReconnectPanel";
import { useSheetStatus } from "@/features/sheets/useSheetStatus";

// Heavy sub-flows (camera/dropzone, and the RHF+Zod review form) load on demand.
const CapturePanel = lazy(() =>
  import("@/features/scan/CapturePanel").then((m) => ({ default: m.CapturePanel })),
);
const ContactReviewForm = lazy(() =>
  import("@/features/review/ContactReviewForm").then((m) => ({ default: m.ContactReviewForm })),
);

/** Maps a pipeline status to the active workflow-step index (0..3). */
function stepIndex(status: PipelineStatus): number {
  switch (status) {
    case "capture":
    case "submitting":
      return 0;
    case "recognizing":
    case "extracting":
      return 1;
    case "review":
    case "saving":
      return 2;
    case "done":
      return 3;
    default:
      return 0;
  }
}

/**
 * The scan wizard — a single route holding {cardId, contact} in a state machine.
 * (There's no GET-card endpoint and sessions are RAM-only on the backend, so
 * this flow cannot be a deep-linkable /review/:cardId route.)
 */
export default function ScanApp() {
  const [params] = useSearchParams();
  const initialSource = params.get("source") === "upload" ? "upload" : "camera";
  const { state, submit, confirm, reset } = useCardPipeline();
  const { url: sheetUrl } = useSheetStatus();

  const { status, contact, error } = state;

  return (
    <PageContainer width="narrow">
      {status !== "done" && status !== "reconnect" && (
        <div className="mb-8">
          <StepIndicator steps={WORKFLOW_STEPS} current={stepIndex(status)} />
        </div>
      )}

      <PageTransition>
        {(status === "capture" || status === "submitting") && (
          <Suspense fallback={<LoadingCard lines={4} />}>
            <CapturePanel
              initialSource={initialSource}
              onSubmit={submit}
              submitting={status === "submitting"}
            />
          </Suspense>
        )}

        {status === "recognizing" && (
          <PipelineLoader title="Reading your card…" description="Running OCR on the image." />
        )}

        {status === "extracting" && (
          <PipelineLoader
            title="Extracting contact details…"
            description="Pulling out name, phone, email and more."
          />
        )}

        {status === "review" && contact && (
          <Suspense fallback={<LoadingCard lines={6} />}>
            {/* saving is always false here: the moment onConfirm dispatches, the
                status flips to "saving" (synchronously, same React event) and
                this branch unmounts in favour of the PipelineLoader below — so
                the form is never shown mid-save and can't be double-submitted. */}
            <ContactReviewForm contact={contact} saving={false} error={error} onConfirm={confirm} />
          </Suspense>
        )}

        {status === "saving" && contact && (
          <PipelineLoader title="Saving to Google Sheets…" description="Adding a new row to your sheet." />
        )}

        {status === "done" && <SaveSuccess onScanAnother={reset} sheetUrl={sheetUrl} />}

        {status === "reconnect" && (
          <ReconnectPanel note="Your Google access expired before we could save. Reconnect, then scan the card again." />
        )}
      </PageTransition>
    </PageContainer>
  );
}
