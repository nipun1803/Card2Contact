import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * App toaster, themed to the design system via CSS-variable-backed inline
 * styles so light/dark both look native. Rendered once at the app root.
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="top-center"
      toastOptions={{
        style: {
          background: "hsl(var(--card))",
          color: "hsl(var(--card-foreground))",
          border: "1px solid hsl(var(--border))",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          fontFamily: "inherit",
        },
        className: "text-sm",
      }}
      {...props}
    />
  );
}
