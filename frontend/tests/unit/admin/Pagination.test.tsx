import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Pagination } from "@/shared/components/common/Pagination";

describe("Pagination", () => {
  it("renders nothing when there are zero total results", () => {
    const { container } = render(
      <Pagination
        meta={{ total: 0, totalPages: 0, nextCursor: null, limit: 20 }}
        hasPrevious={false}
        currentPage={1}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("disables Previous on the first page", () => {
    render(
      <Pagination
        meta={{ total: 40, totalPages: 2, nextCursor: "abc", limit: 20 }}
        hasPrevious={false}
        currentPage={1}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next/i })).toBeEnabled();
  });

  it("disables Next when there is no next cursor (last page)", () => {
    render(
      <Pagination
        meta={{ total: 40, totalPages: 2, nextCursor: null, limit: 20 }}
        hasPrevious
        currentPage={2}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /previous/i })).toBeEnabled();
  });

  it("calls onNext / onPrevious", async () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const user = userEvent.setup();
    render(
      <Pagination
        meta={{ total: 40, totalPages: 2, nextCursor: "abc", limit: 20 }}
        hasPrevious
        currentPage={2}
        onNext={onNext}
        onPrevious={onPrevious}
      />,
    );

    await user.click(screen.getByRole("button", { name: /next/i }));
    await user.click(screen.getByRole("button", { name: /previous/i }));

    expect(onNext).toHaveBeenCalled();
    expect(onPrevious).toHaveBeenCalled();
  });

  it("shows the page label derived from total/totalPages", () => {
    render(
      <Pagination
        meta={{ total: 40, totalPages: 2, nextCursor: null, limit: 20 }}
        hasPrevious
        currentPage={2}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
      />,
    );
    expect(screen.getByText(/page 2 of 2/i)).toBeInTheDocument();
  });
});
