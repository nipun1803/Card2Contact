import { Camera, FileSpreadsheet, PencilLine, ScanText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/shared/components/ui/card";
import { SectionHeader } from "@/shared/components/common/SectionHeader";

const steps: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: Camera, title: "Scan / Upload", description: "Capture or upload the card." },
  { icon: ScanText, title: "Extract", description: "We read the text and fields." },
  { icon: PencilLine, title: "Review", description: "Check and edit the details." },
  { icon: FileSpreadsheet, title: "Save", description: "One new row in your sheet." },
];

/** How-it-works strip: the four visible stages of a scan. Non-interactive. */
export function WorkflowProgress() {
  return (
    <section>
      <SectionHeader title="How it works" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, i) => (
          <Card key={step.title} className="relative p-4">
            <span className="absolute right-3 top-3 text-xs font-semibold text-muted-foreground/50">
              {i + 1}
            </span>
            <span className="mb-3 flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
              <step.icon className="size-5" aria-hidden />
            </span>
            <p className="text-sm font-semibold">{step.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
