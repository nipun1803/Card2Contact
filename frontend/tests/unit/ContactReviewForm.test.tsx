import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactReviewForm } from "@/features/review/ContactReviewForm";
import { makeContact } from "../fixtures/contacts";

/**
 * ContactReviewForm holds the only real client-side logic in the review step:
 * the toForm/fromForm mapping between the API's string[] arrays and the
 * react-hook-form {value}[] field arrays, plus the name-required rule (the one
 * validation the backend also enforces). Driven through the rendered UI.
 */
describe("ContactReviewForm", () => {
  it("prefills fields from the contact", () => {
    render(<ContactReviewForm contact={makeContact()} saving={false} onConfirm={vi.fn()} />);
    expect(screen.getByDisplayValue("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Chief Analyst")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ada@analyticalengines.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("+1 555 010 1842")).toBeInTheDocument();
  });

  it("submits an edited designation", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ContactReviewForm contact={makeContact()} saving={false} onConfirm={onConfirm} />);

    const designationInput = screen.getByDisplayValue("Chief Analyst");
    await user.clear(designationInput);
    await user.type(designationInput, "Branch Head");
    await user.click(screen.getByRole("button", { name: /save to google sheets/i }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm.mock.calls[0][0].designation).toBe("Branch Head");
  });

  it("submits a Contact with trimmed name and empty array entries dropped", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <ContactReviewForm
        contact={makeContact({ phones: ["+1 111"], addresses: [] })}
        saving={false}
        onConfirm={onConfirm}
      />,
    );

    // Add a second (empty) phone row — it must be filtered out on submit.
    await user.click(screen.getByRole("button", { name: /add phone/i }));
    await user.click(screen.getByRole("button", { name: /save to google sheets/i }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    const submitted = onConfirm.mock.calls[0][0];
    expect(submitted.phones).toEqual(["+1 111"]); // empty second row dropped
    expect(submitted.addresses).toEqual([]);
    expect(submitted.name).toBe("Ada Lovelace");
  });

  it("blocks submission and shows an error when name is cleared", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<ContactReviewForm contact={makeContact()} saving={false} onConfirm={onConfirm} />);

    await user.clear(screen.getByDisplayValue("Ada Lovelace"));
    await user.click(screen.getByRole("button", { name: /save to google sheets/i }));

    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("supports adding and removing phone rows with accessible labels", async () => {
    const user = userEvent.setup();
    render(<ContactReviewForm contact={makeContact({ phones: ["+1 111"] })} saving={false} onConfirm={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /add phone/i }));
    expect(screen.getByLabelText("Phone number 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /remove phone number 2/i }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Phone number 2")).not.toBeInTheDocument(),
    );
  });

  it("shows the saving state on the submit button", () => {
    render(<ContactReviewForm contact={makeContact()} saving={true} onConfirm={vi.fn()} />);
    expect(screen.getByRole("button", { name: /saving/i })).toBeInTheDocument();
  });

  it("renders an inline error alert when the error prop is set", () => {
    render(
      <ContactReviewForm contact={makeContact()} saving={false} error="Save failed" onConfirm={vi.fn()} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
  });
});
