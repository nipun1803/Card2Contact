import { CheckCircle2, ExternalLink, Plus } from "lucide-react";
import { Card, CardContent } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { FadeIn } from "@/shared/components/common/Motion";

interface SaveSuccessProps {
  onScanAnother: () => void;
  sheetUrl?: string | null;
}

/** Confirmation shown after M5 save succeeds. */
export function SaveSuccess({ onScanAnother, sheetUrl }: SaveSuccessProps) {
  return (
    <FadeIn>
      <Card className="mx-auto max-w-md text-center">
        <CardContent className="flex flex-col items-center gap-5 p-10">
          <span className="flex size-16 items-center justify-center rounded-full bg-success/12 text-success">
            <CheckCircle2 className="size-8" aria-hidden />
          </span>
          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold">Contact saved</h2>
            <p className="text-sm text-muted-foreground">
              It’s now a new row in your Google Sheet.
            </p>
          </div>
          <div className="flex w-full flex-col gap-2">
            <Button className="w-full" onClick={onScanAnother}>
              <Plus aria-hidden />
              Scan another card
            </Button>
            {sheetUrl && (
              <Button asChild variant="secondary" className="w-full">
                <a href={sheetUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden />
                  Open Google Sheet
                </a>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </FadeIn>
  );
}
