/**
 * RegisterContractPage tests — Issue #513
 *
 * Happy path: submitting a valid form calls api.registerContract and navigates to /contract/:id
 * Validation error: submitting with an invalid Contract ID shows an inline error, no API call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RegisterContractPage from "../src/pages/RegisterContractPage";
import { api } from "../src/api";

vi.mock("../src/api", () => ({
  api: {
    registerContract: vi.fn(),
  },
}));

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/contracts/register"]}>
        <Routes>
          <Route path="/contracts/register" element={<RegisterContractPage />} />
          {/* Capture navigation target */}
          <Route path="/contract/:id" element={<div>Contract detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, user };
}

// A valid Stellar contract strkey: 'C' + 55 uppercase base32 chars
const VALID_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RegisterContractPage", () => {
  it("renders the form fields", () => {
    setup();
    expect(screen.getByLabelText(/Contract ID/i)).toBeDefined();
    expect(screen.getByLabelText(/Contract name/i)).toBeDefined();
    expect(screen.getByLabelText(/Contract description/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /Register contract/i })).toBeDefined();
  });

  it("shows an inline validation error for an invalid Contract ID without calling the API", async () => {
    const { user } = setup();

    // Fill in invalid contract ID (too short)
    await user.type(screen.getByLabelText(/Contract ID/i), "CABC123");

    // Fill required name
    await user.type(screen.getByLabelText(/Contract name/i), "My Contract");

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /Register contract/i }));

    // Should show error, not call API
    await waitFor(() => {
      expect(
        screen.getByText(/must be a 56-character Stellar strkey/i),
      ).toBeDefined();
    });
    expect(api.registerContract).not.toHaveBeenCalled();
  });

  it("shows a validation error when name is missing", async () => {
    const { user } = setup();

    await user.type(screen.getByLabelText(/Contract ID/i), VALID_CONTRACT_ID);

    // Do not fill name — submit immediately
    fireEvent.click(screen.getByRole("button", { name: /Register contract/i }));

    await waitFor(() => {
      expect(screen.getByText(/Name is required/i)).toBeDefined();
    });
    expect(api.registerContract).not.toHaveBeenCalled();
  });

  it("happy path: calls registerContract and shows success toast", async () => {
    (api.registerContract as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });

    const { user } = setup();

    // Fill in valid data
    await user.type(screen.getByLabelText(/Contract ID/i), VALID_CONTRACT_ID);
    await user.type(screen.getByLabelText(/Contract name/i), "Test Token");

    // Submit
    fireEvent.click(screen.getByRole("button", { name: /Register contract/i }));

    await waitFor(() => {
      expect(api.registerContract).toHaveBeenCalledWith(
        expect.objectContaining({
          id: VALID_CONTRACT_ID,
          name: "Test Token",
        }),
      );
    });

    // Success toast should appear
    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`registered successfully`, "i")),
      ).toBeDefined();
    });
  }, 10_000);

  it("shows a 409 error inline when the contract is already registered", async () => {
    const err = Object.assign(new Error("Contract already exists"), {
      status: 409,
      data: { error: "Contract already exists" },
    });
    (api.registerContract as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err);

    const { user } = setup();

    await user.type(screen.getByLabelText(/Contract ID/i), VALID_CONTRACT_ID);
    await user.type(screen.getByLabelText(/Contract name/i), "Test Token");

    fireEvent.click(screen.getByRole("button", { name: /Register contract/i }));

    // Both the inline field error and the toast mention "already registered"
    await waitFor(() => {
      const matches = screen.getAllByText(/already registered/i);
      expect(matches.length).toBeGreaterThan(0);
    }, { timeout: 8000 });
  }, 10_000);
});
