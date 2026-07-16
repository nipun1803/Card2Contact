import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/services/api", async () => {
  const actual = await vi.importActual<typeof import("@/shared/services/api")>(
    "@/shared/services/api",
  );
  return { ...actual, adminLogin: vi.fn(), adminLogout: vi.fn(), getAdminMe: vi.fn() };
});

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

import AdminLogin from "@/routes/admin/AdminLogin";
import { ApiError, NetworkError, adminLogin } from "@/shared/services/api";

const mockedAdminLogin = vi.mocked(adminLogin);

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminLogin />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Exact labels, not /password/i: a loose regex also matches the toggle's
 * "Show password" aria-label, so getByLabelText would return the BUTTON and
 * every assertion about the input would silently test the wrong element.
 */
const username = () => screen.getByLabelText("Username");
const password = () => screen.getByLabelText("Password");
const submit = () => screen.getByRole("button", { name: /sign in/i });
const toggle = () => screen.getByRole("button", { name: /(show|hide) password/i });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdminLogin — form basics", () => {
  it("F1: renders accessible username and password fields", () => {
    renderPage();

    expect(username()).toBeInTheDocument();
    expect(password()).toBeInTheDocument();
  });

  it("F14: sets the autoComplete hints password managers rely on", () => {
    renderPage();

    expect(username()).toHaveAttribute("autoComplete", "username");
    expect(password()).toHaveAttribute("autoComplete", "current-password");
  });

  it("F7: submits the entered credentials once", async () => {
    mockedAdminLogin.mockResolvedValue({ username: "admin" });
    const user = userEvent.setup();
    renderPage();

    await user.type(username(), "admin");
    await user.type(password(), "s3cret");
    await user.click(submit());

    await waitFor(() => expect(mockedAdminLogin).toHaveBeenCalledTimes(1));
    expect(mockedAdminLogin).toHaveBeenCalledWith("admin", "s3cret");
  });

  it("F6: blocks an empty submit and never calls the API", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(submit());

    expect(await screen.findByText(/username is required/i)).toBeInTheDocument();
    expect(screen.getByText(/password is required/i)).toBeInTheDocument();
    expect(mockedAdminLogin).not.toHaveBeenCalled();
  });
});

describe("AdminLogin — show/hide password", () => {
  it("F2: starts masked", () => {
    renderPage();
    expect(password()).toHaveAttribute("type", "password");
  });

  it("F3/F4: reveals then re-masks, flipping the accessible label", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(toggle());
    expect(password()).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: /hide password/i })).toBeInTheDocument();

    await user.click(toggle());
    expect(password()).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /show password/i })).toBeInTheDocument();
  });

  /**
   * F5. A bare <button> inside a <form> defaults to type="submit" — so without
   * an explicit type="button" the toggle would submit the form. A real bug,
   * easy to reintroduce, invisible without this test.
   */
  it("F5: toggling does not submit the form", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(username(), "admin");
    await user.type(password(), "s3cret");
    await user.click(toggle());

    expect(toggle()).toHaveAttribute("type", "button");
    expect(mockedAdminLogin).not.toHaveBeenCalled();
  });
});

describe("AdminLogin — loading and success", () => {
  it("F8: disables the form and shows a spinner while in flight", async () => {
    let resolve!: (v: { username: string }) => void;
    mockedAdminLogin.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    renderPage();

    await user.type(username(), "admin");
    await user.type(password(), "s3cret");
    await user.click(submit());

    // The button's accessible name flips to "Signing in…" while pending, so
    // match on the busy label rather than the idle one.
    const busyButton = await screen.findByRole("button", { name: /signing in/i });
    expect(busyButton).toBeDisabled();
    expect(username()).toBeDisabled();
    expect(password()).toBeDisabled();

    resolve({ username: "admin" });
  });

  it("F9: redirects to the dashboard, replacing history", async () => {
    mockedAdminLogin.mockResolvedValue({ username: "admin" });
    const user = userEvent.setup();
    renderPage();

    await user.type(username(), "admin");
    await user.type(password(), "s3cret");
    await user.click(submit());

    // replace: Back must not return to a login form already passed.
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/admin/dashboard", { replace: true }),
    );
  });
});

/**
 * The error-classification suite. Conflating these is the real UX bug: a
 * rate-limited operator told "Invalid credentials" retries immediately, digs
 * deeper into the limit, and never learns that waiting is the fix.
 */
describe("AdminLogin — every failure mode says something actionable", () => {
  async function submitWith(error: unknown) {
    mockedAdminLogin.mockRejectedValue(error);
    const user = userEvent.setup();
    renderPage();
    await user.type(username(), "admin");
    await user.type(password(), "s3cret");
    await user.click(submit());
  }

  it("F10: shows the server's generic message on a 401", async () => {
    await submitWith(new ApiError(401, "Invalid credentials"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
  });

  it("F10b: clears the password but keeps the username after a failure", async () => {
    await submitWith(new ApiError(401, "Invalid credentials"));

    await screen.findByRole("alert");
    expect(password()).toHaveValue("");
    expect(username()).toHaveValue("admin");
  });

  it("F10c: re-enables the form after a failure", async () => {
    await submitWith(new ApiError(401, "Invalid credentials"));

    await screen.findByRole("alert");
    expect(submit()).toBeEnabled();
  });

  it("F11: a 429 says to wait — NOT 'Invalid credentials'", async () => {
    await submitWith(new ApiError(429, "Too many requests — please try again later"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/too many attempts/i);
    expect(alert).not.toHaveTextContent(/invalid credentials/i);
  });

  it("F12: a network failure blames the connection, not the password", async () => {
    await submitWith(new NetworkError());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn’t reach the server/i);
    expect(alert).not.toHaveTextContent(/invalid credentials/i);
  });

  it("F13: a 503 explains that admin is not configured", async () => {
    await submitWith(new ApiError(503, "Admin access is not configured"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not configured/i);
  });

  it("F15: clears a stale error while a retry is in flight", async () => {
    mockedAdminLogin.mockRejectedValueOnce(new ApiError(401, "Invalid credentials"));
    const user = userEvent.setup();
    renderPage();

    await user.type(username(), "admin");
    await user.type(password(), "wrong");
    await user.click(submit());
    await screen.findByRole("alert");

    // A slow retry: the old error must not linger while it is in flight.
    let resolve!: (v: { username: string }) => void;
    mockedAdminLogin.mockReturnValue(new Promise((r) => (resolve = r)));
    await user.type(password(), "s3cret");
    await user.click(submit());

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    resolve({ username: "admin" });
  });
});
