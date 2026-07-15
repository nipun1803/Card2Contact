import { useState } from "react";
import { toast } from "sonner";
import { Camera, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { Button } from "@/shared/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/shared/components/ui/tabs";
import { Label } from "@/shared/components/ui/label";
import { useFeatureFlag } from "@/shared/hooks/useFeatureFlag";
import { downscaleImage } from "@/shared/utils/files";
import type { CardMode } from "@/shared/types/api";
import { UploadDropzone } from "./UploadDropzone";
import { CameraCapture } from "./CameraCapture";
import { cn } from "@/shared/utils/cn";

interface CapturePanelProps {
  /** "camera" | "upload" — preferred initial source (from dashboard CTA). */
  initialSource?: "camera" | "upload";
  onSubmit: (mode: CardMode, front: File, back: File | null) => void;
  submitting: boolean;
}

type Source = "upload" | "camera";

/**
 * M1 image acquisition UI. Chooses single vs double-sided, and an image source
 * (upload or live camera). Camera failures fall back to upload automatically.
 */
export function CapturePanel({ initialSource = "camera", onSubmit, submitting }: CapturePanelProps) {
  const cameraEnabled = useFeatureFlag("camera");
  const uploadEnabled = useFeatureFlag("upload");

  const [mode, setMode] = useState<CardMode>("single");
  const [source, setSource] = useState<Source>(
    initialSource === "camera" && cameraEnabled ? "camera" : "upload",
  );
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);

  const canSubmit = !!front && (mode === "single" || !!back) && !submitting;

  async function handleCameraCapture(side: "front" | "back", file: File) {
    const optimized = await downscaleImage(file);
    if (side === "front") setFront(optimized);
    else setBack(optimized);
  }

  function handleCameraUnavailable(reason: string) {
    if (uploadEnabled) {
      toast.info(`${reason} Switched to upload.`);
      setSource("upload");
    } else {
      toast.error(reason);
    }
  }

  function ImageSource({ side }: { side: "front" | "back" }) {
    const file = side === "front" ? front : back;
    const setFile = side === "front" ? setFront : setBack;

    if (source === "camera" && cameraEnabled) {
      // Once a side is captured, show its preview via the dropzone's preview mode.
      if (file) {
        return <UploadDropzone file={file} onFile={setFile} onClear={() => setFile(null)} label={`${side} of card`} />;
      }
      return (
        <CameraCapture
          onCapture={(f) => handleCameraCapture(side, f)}
          onUnavailable={handleCameraUnavailable}
        />
      );
    }
    return (
      <UploadDropzone
        file={file}
        onFile={setFile}
        onClear={() => setFile(null)}
        label={`${side} of card`}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scan a business card</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Sided-ness */}
        <div className="space-y-2">
          <Label>Card sides</Label>
          <div className="grid grid-cols-2 gap-2">
            {(["single", "double"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={cn(
                  "rounded-md border px-4 py-2.5 text-sm font-medium transition-colors focus-ring",
                  mode === m
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {m === "single" ? "Single-sided" : "Front & back"}
              </button>
            ))}
          </div>
        </div>

        {/* Source */}
        {cameraEnabled && uploadEnabled && (
          <Tabs value={source} onValueChange={(v) => setSource(v as Source)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="camera">
                <Camera aria-hidden className="size-4" />
                Camera
              </TabsTrigger>
              <TabsTrigger value="upload">
                <Upload aria-hidden className="size-4" />
                Upload
              </TabsTrigger>
            </TabsList>
            <TabsContent value="camera" className="space-y-4">
              <div className="space-y-2">
                <Label>{mode === "double" ? "Front" : "Card"}</Label>
                <ImageSource side="front" />
              </div>
              {mode === "double" && (
                <div className="space-y-2">
                  <Label>Back</Label>
                  <ImageSource side="back" />
                </div>
              )}
            </TabsContent>
            <TabsContent value="upload" className="space-y-4">
              <div className="space-y-2">
                <Label>{mode === "double" ? "Front" : "Card"}</Label>
                <ImageSource side="front" />
              </div>
              {mode === "double" && (
                <div className="space-y-2">
                  <Label>Back</Label>
                  <ImageSource side="back" />
                </div>
              )}
            </TabsContent>
          </Tabs>
        )}

        {/* Single-source (only one enabled) */}
        {!(cameraEnabled && uploadEnabled) && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{mode === "double" ? "Front" : "Card"}</Label>
              <ImageSource side="front" />
            </div>
            {mode === "double" && (
              <div className="space-y-2">
                <Label>Back</Label>
                <ImageSource side="back" />
              </div>
            )}
          </div>
        )}

        <Button
          className="w-full"
          size="lg"
          disabled={!canSubmit}
          loading={submitting}
          onClick={() => front && onSubmit(mode, front, mode === "double" ? back : null)}
        >
          {submitting ? "Uploading…" : "Scan card"}
        </Button>
      </CardContent>
    </Card>
  );
}
