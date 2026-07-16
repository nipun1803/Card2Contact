import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "@/shared/components/common/StatusBadge";

describe("StatusBadge", () => {
  it("renders Active for an enabled user", () => {
    render(<StatusBadge disabled={false} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders Revoked for a disabled user", () => {
    render(<StatusBadge disabled />);
    expect(screen.getByText("Revoked")).toBeInTheDocument();
  });
});
