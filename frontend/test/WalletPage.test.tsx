import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import WalletPage from "../src/pages/WalletPage";

const ADDRESS = "GA3X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X";
// A valid muxed (M...) address and its known base G... account + numeric ID,
// per SEP-23 test vectors.
const MUXED_ADDRESS = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
const MUXED_BASE_ADDRESS = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const MUXED_ID = "9223372036854775808";

const NATIVE_ONLY_BALANCES = { balances: [{ asset_code: "XLM", asset_issuer: null, balance: "125.5000000", is_native: true }] };

function mockFetch({
  events = { events: [] },
  eventsOk = true,
  balances = NATIVE_ONLY_BALANCES,
  balancesOk = true,
}: {
  events?: unknown;
  eventsOk?: boolean;
  balances?: unknown;
  balancesOk?: boolean;
} = {}) {
  const fn = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/balances")) {
      return Promise.resolve({ ok: balancesOk, status: balancesOk ? 200 : 502, json: async () => balances });
    }
    if (url.includes("/wallet/")) {
      return Promise.resolve({ ok: eventsOk, status: eventsOk ? 200 : 500, json: async () => events });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
  (global as any).fetch = fn;
  return fn;
}

function renderWalletPage(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/wallet/:address" element={<WalletPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WalletPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders with empty-state message when no events", async () => {
    mockFetch();
    renderWalletPage(`/wallet/${ADDRESS}`);
    expect(await screen.findByText("No Soroban interactions found for this address")).toBeDefined();
  });

  it("shows address in page heading even with no events", async () => {
    mockFetch();
    renderWalletPage(`/wallet/${ADDRESS}`);
    expect(await screen.findByText(ADDRESS)).toBeDefined();
  });

  it("shows the XLM balance prominently (issue #529)", async () => {
    mockFetch();
    renderWalletPage(`/wallet/${ADDRESS}`);
    expect(await screen.findByText("125.5")).toBeDefined();
    expect(screen.getByText("XLM Balance")).toBeDefined();
  });

  it("shows a non-fatal error when Horizon is unreachable, but event history still loads (issue #529)", async () => {
    mockFetch({
      balancesOk: false,
      balances: { error: "Account not found on network" },
      events: { events: [] },
    });
    renderWalletPage(`/wallet/${ADDRESS}`);

    expect(await screen.findByRole("alert")).toHaveTextContent(/Unable to load balances/i);
    expect(await screen.findByText("No Soroban interactions found for this address")).toBeDefined();
  });

  it("resolves a muxed M... address to its base G... account for fetching events, while the header keeps showing the muxed address (issue #531)", async () => {
    const fetchMock = mockFetch();
    renderWalletPage(`/wallet/${MUXED_ADDRESS}`);

    await screen.findByText("No Soroban interactions found for this address");

    // Header shows the muxed address, not the base address.
    const heading = await screen.findByText(MUXED_ADDRESS);
    expect(heading.getAttribute("title")).toBe(
      `Showing events for the base account ${MUXED_BASE_ADDRESS} (muxed ID: ${MUXED_ID})`,
    );

    // Events + balances were fetched for the base G... address.
    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(calledUrls.some((u: string) => u === `/api/wallet/${MUXED_BASE_ADDRESS}`)).toBe(true);
    expect(calledUrls.some((u: string) => u === `/api/wallet/${MUXED_BASE_ADDRESS}/balances`)).toBe(true);
  });

  it("passes the selected event-type filter to the API and reflects it in the URL (issue #532)", async () => {
    const fetchMock = mockFetch();
    renderWalletPage(`/wallet/${ADDRESS}`);
    await screen.findByText("No Soroban interactions found for this address");

    fireEvent.click(screen.getByRole("button", { name: "Swap" }));

    await waitFor(() => {
      const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calledUrls).toContain(`/api/wallet/${ADDRESS}?fn=swap`);
    });
  });

  it("reverts to showing all events when every chip is deselected (issue #532)", async () => {
    const fetchMock = mockFetch();
    renderWalletPage(`/wallet/${ADDRESS}`);
    await screen.findByText("No Soroban interactions found for this address");

    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.map((c: unknown[]) => c[0])).toContain(`/api/wallet/${ADDRESS}?fn=swap`);
    });

    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.map((c: unknown[]) => c[0])).toContain(`/api/wallet/${ADDRESS}`);
    });
  });
});
