import { MAX_IMAGE_EDGE } from "@/shared/lib/constants";

/**
 * Downscale a large card photo before upload: caps the longest edge at
 * MAX_IMAGE_EDGE and re-encodes as JPEG. This speeds OCR and shrinks payloads.
 * Falls back to the original file if anything goes wrong (never blocks a scan).
 */
export async function downscaleImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longest = Math.max(width, height);

    if (longest <= MAX_IMAGE_EDGE) {
      bitmap.close();
      return file;
    }

    const scale = MAX_IMAGE_EDGE / longest;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) return file;

    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/** Create and later revoke a preview object URL for a File. */
export function previewUrl(file: File): string {
  return URL.createObjectURL(file);
}
