import { Link } from "react-router-dom";
import { ArrowRight, Camera, FileSpreadsheet, ScanText, ShieldCheck } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { FeatureCard } from "@/shared/components/common/FeatureCard";
import { FadeIn } from "@/shared/components/common/Motion";
import { ROUTES } from "@/shared/lib/constants";

const features = [
  { icon: Camera, title: "Snap or upload", description: "Use your camera or drop in a photo of any business card." },
  { icon: ScanText, title: "Smart extraction", description: "We read the card and pull out name, phone, email, company and more." },
  { icon: FileSpreadsheet, title: "Straight to Sheets", description: "Every confirmed contact becomes a new row in your Google Sheet." },
  { icon: ShieldCheck, title: "Your data, your sheet", description: "Contacts live in your own spreadsheet — we don’t store them." },
];

/** Public marketing landing page. */
export default function Landing() {
  return (
    <div>
      <section className="mx-auto max-w-4xl px-4 pb-16 pt-16 text-center sm:px-6 sm:pt-24">
        <FadeIn>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            Business cards → Google Sheets
          </span>
          <h1 className="mt-6 text-balance font-serif text-3xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
            Turn business cards into contacts, instantly
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            Scan a card, review the details, and save it straight to your Google Sheet. No manual
            typing, no lost connections.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link to={ROUTES.login}>
                Get started
                <ArrowRight aria-hidden />
              </Link>
            </Button>
            <Button asChild variant="ghost" size="lg">
              <a href="#how">See how it works</a>
            </Button>
          </div>
        </FadeIn>
      </section>

      <section id="how" className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </section>
    </div>
  );
}
