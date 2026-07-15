import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";
import { ImagePlus, Loader2, UploadCloud, X } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/utils/cn";
import { downscaleImage, previewUrl } from "@/shared/utils/files";

interface UploadDropzoneProps {
  /** Emitted with the (downscaled) file once chosen. */
  onFile: (file: File) => void;
  /** Currently selected file, if any (controlled by parent). */
  file: File | null;
  onClear: () => void;
  label?: string;
}

/**
 * Accessible image picker (react-dropzone provides keyboard + role wiring).
 * Downscales large photos before handing them up, and shows a preview thumbnail.
 */
export function UploadDropzone({ onFile, file, onClear, label = "card image" }: UploadDropzoneProps) {
  const [processing, setProcessing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = previewUrl(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onDrop = useCallback(
    async (accepted: File[]) => {
      const picked = accepted[0];
      if (!picked) return;
      setProcessing(true);
      try {
        const optimized = await downscaleImage(picked);
        onFile(optimized);
      } finally {
        setProcessing(false);
      }
    },
    [onFile],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: { "image/*": [] },
    maxFiles: 1,
    multiple: false,
    noClick: !!file,
    noKeyboard: !!file,
  });

  if (file && preview) {
    return (
      <div className="space-y-3">
        <div className="relative overflow-hidden rounded-lg border border-border">
          <img
            src={preview}
            alt={`Selected ${label} preview`}
            className="aspect-[16/10] w-full object-cover"
          />
          <button
            type="button"
            onClick={onClear}
            aria-label={`Remove ${label}`}
            className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={open}>
          <ImagePlus aria-hidden />
          Choose a different image
        </Button>
      </div>
    );
  }

  return (
    <div
      {...getRootProps()}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-card/50 px-6 py-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isDragActive && "border-primary bg-primary/5",
      )}
      aria-label={`Upload ${label}`}
    >
      <input {...getInputProps()} />
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        {processing ? (
          <Loader2 className="size-6 animate-spin" aria-hidden />
        ) : (
          <UploadCloud className="size-6" aria-hidden />
        )}
      </span>
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {processing ? "Preparing image…" : isDragActive ? "Drop the image here" : "Drag & drop or tap to upload"}
        </p>
        <p className="text-xs text-muted-foreground">PNG or JPG · we’ll optimize it for you</p>
      </div>
    </div>
  );
}
