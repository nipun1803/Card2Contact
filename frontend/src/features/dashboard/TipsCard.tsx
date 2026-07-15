import { Lightbulb } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";

const tips = [
  "Lay the card flat with even lighting for the sharpest OCR.",
  "Use “Front & back” for cards with details on both sides.",
  "You can edit any field before saving — nothing is final until you hit Save.",
];

/** Small help/tips card for the dashboard sidebar. */
export function TipsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-5 text-primary" aria-hidden />
          Tips for a clean scan
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2.5">
          {tips.map((tip) => (
            <li key={tip} className="flex gap-2 text-sm text-muted-foreground">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
              {tip}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
