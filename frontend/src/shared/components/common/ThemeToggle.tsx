import { Moon, Sun } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import { useTheme } from "@/app/ThemeProvider";
import { cn } from "@/shared/utils/cn";

/** Icon button that flips the current ThemeProvider's light/dark preference. Disabled (not hidden) when the darkMode flag is off. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme, canToggle } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      disabled={!canToggle}
      aria-label={
        !canToggle
          ? "Dark mode is disabled"
          : theme === "dark"
            ? "Switch to light mode"
            : "Switch to dark mode"
      }
      className={cn(className)}
    >
      {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
    </Button>
  );
}
