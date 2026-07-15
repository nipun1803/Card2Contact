import { useEffect, useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Button } from "@/shared/components/ui/button";

interface Props {
  /** Called with the captured still frame as an image File. */
  onCapture: (file: File) => void;
  /**
   * Called when the camera can't be used (permission denied, no camera, or an
   * insecure context). The parent falls back to file upload so the user is
   * never stuck.
   */
  onUnavailable: (reason: string) => void;
}

/**
 * Live camera capture via getUserMedia. Shows a video preview and captures the
 * current frame to a canvas, producing a PNG File that flows into the same
 * upload path as a picked file.
 *
 * getUserMedia only works in a secure context (https or localhost). On a plain
 * HTTP non-localhost host it rejects — handled via onUnavailable.
 */
export function CameraCapture({ onCapture, onUnavailable }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        onUnavailable("Camera isn’t supported in this browser.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setReady(true);
      } catch (err) {
        onUnavailable(err instanceof Error ? err.message : "Camera unavailable.");
      }
    }

    void start();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // One-shot setup; onUnavailable is stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function capture() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      onCapture(new File([blob], "capture.png", { type: "image/png" }));
      // Release the camera once we have a frame.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setReady(false);
    }, "image/png");
  }

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-lg border border-border bg-foreground/5">
        <video
          ref={videoRef}
          playsInline
          muted
          aria-label="Live camera preview"
          className="aspect-[16/10] w-full object-cover"
        />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" aria-hidden />
            <span className="sr-only">Starting camera…</span>
          </div>
        )}
      </div>
      <Button
        type="button"
        onClick={capture}
        disabled={!ready}
        className="w-full"
        aria-label="Capture photo"
      >
        <Camera aria-hidden />
        Capture photo
      </Button>
    </div>
  );
}
