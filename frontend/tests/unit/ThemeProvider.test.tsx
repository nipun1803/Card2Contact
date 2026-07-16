import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "@/app/ThemeProvider";

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button onClick={toggleTheme}>{theme}</button>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("ThemeProvider", () => {
  it("defaults to light and stamps .dark on toggle, scoped to its storage key", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider storageKey="test.theme.a">
        <Probe />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    await user.click(screen.getByRole("button"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("test.theme.a")).toBe("dark");
  });

  it("a nested provider hands the shared .dark class back to the outer preference on unmount", async () => {
    const user = userEvent.setup();
    localStorage.setItem("c2c.theme", "light");

    function Wrapper({ showNested }: { showNested: boolean }) {
      return (
        <ThemeProvider>
          <Probe />
          {showNested && (
            <ThemeProvider storageKey="test.theme.nested">
              <Probe />
            </ThemeProvider>
          )}
        </ThemeProvider>
      );
    }

    const { rerender } = render(<Wrapper showNested={true} />);
    const buttons = screen.getAllByRole("button");
    // buttons[1] is the nested provider's toggle.
    await user.click(buttons[1]);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // Unmount the nested provider (simulates navigating out of /admin/*).
    rerender(<Wrapper showNested={false} />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
