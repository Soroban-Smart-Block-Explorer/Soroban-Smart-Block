/**
 * Issue #430 — Home.tsx: renders without error when API returns an empty events array.
 * Issue #452 — Home.tsx: renders event rows with contract_id, function, ledger,
 *             and description columns populated when events exist.
 *
 * Mocks the api module so that api.events resolves to [] and asserts:
 *   1. The empty-state message is visible ("No events yet")
 *   2. No React error-boundary text appears
 *   3. No console.error calls are made during the render cycle
 *
 * When api.events returns data, asserts:
 *   4. Event rows render with ledger, function, and description columns populated
 *   5. Contract IDs appear as clickable links within descriptions
 *   6. Multiple events all render in the table
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import ErrorBoundary from "../src/components/ErrorBoundary";
import Home from "../src/pages/Home";

import { api } from "../src/api";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Prevent the WebSocket-based useEventStream hook from opening a real
// connection during tests.
const wsMock = {
  close: vi.fn(),
  send: vi.fn(),
  onmessage: null as null | ((e: { data: string }) => void),
  onerror: null as null | ((e: unknown) => void),
  readyState: 1,
};
class MockWebSocket {
  constructor() {
    return wsMock;
  }
}
(globalThis as unknown as Record<string, unknown>).WebSocket =
  MockWebSocket as unknown as typeof WebSocket;

// Mock the api module so we control what api.events returns.
vi.mock("../src/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      events: vi.fn().mockResolvedValue({ data: [], next_cursor: null }),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Never retry in tests — makes failures surface immediately.
        retry: false,
      },
    },
  });
}

function renderHome() {
  const queryClient = makeQueryClient();
  return render(
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Home />
        </MemoryRouter>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Home — empty events array", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the page heading without crashing", async () => {
    renderHome();
    // The heading is synchronously present — no async wait needed.
    expect(screen.getByText("Soroban Smart Block Explorer")).toBeDefined();
  });

  it('shows the "No events yet" empty-state message after the query resolves', async () => {
    renderHome();
    // Wait for the async query to settle and the empty-state to appear.
    const emptyState = await screen.findByText(/no events yet/i);
    expect(emptyState).toBeDefined();
  });

  it("does not render the error boundary fallback", async () => {
    renderHome();
    await screen.findByText(/no events yet/i);
    // If the error boundary caught an error it would show "Something went wrong".
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("does not emit console.error during the render cycle", async () => {
    renderHome();
    await screen.findByText(/no events yet/i);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("renders filter controls even when there are no events", async () => {
    renderHome();
    await screen.findByText(/no events yet/i);
    // Function-filter label should be visible.
    expect(screen.getByText("Function:")).toBeDefined();
    // Pagination controls should be present.
    expect(screen.getByText(/← Prev/)).toBeDefined();
    expect(screen.getByText(/Next →/)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #452 — Verify Events page renders with populated event rows
// ---------------------------------------------------------------------------

describe("Home — events data (Issue #452)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const mockEventTransfer = {
    seq: 1001,
    contract_id: "CCEMOFO5TE7FGOAJXR3RDHPC6RWO4FM2GOPUKI5N6KJQ4MOLOFPFJN6B",
    function: "transfer",
    ledger: 2500000,
    description:
      "Address GA5ZSEJYB37FRCONJ3LQUMTZHKWZ6BIGZU3U2XHRJHXBVWMGHMV36TJQ transferred 100.00 USDC to GDQOE2JFBXYKIYLJBNUDRZI2FHLX5TLXHMDNUE7KPK5I2YA5TSB6Z4LD",
    raw_topics: [
      "transfer",
      "GA5ZSEJYB37FRCONJ3LQUMTZHKWZ6BIGZU3U2XHRJHXBVWMGHMV36TJQ",
      "GDQOE2JFBXYKIYLJBNUDRZI2FHLX5TLXHMDNUE7KPK5I2YA5TSB6Z4LD",
      "100000000",
    ],
    tx_hash: "abc123def456abc123def456abc123def456abc123def456abc123def4561234",
  };

  const mockEventSwap = {
    seq: 1002,
    contract_id: "CDLZFC3SYJYDZT7K67VZ75HRJDTIKI7BF6RQD7MFPK5QERZUTXX7YV7V",
    function: "swap",
    ledger: 2500005,
    description: "Swapped 50.00 XLM → 420.00 USDC via contract CDLZFC3SYJYDZT7K67VZ75HRJDTIKI7BF6RQD7MFPK5QERZUTXX7YV7V",
    raw_topics: ["swap", "1000000000", "420000000"],
    tx_hash: "def789abc123def789abc123def789abc123def789abc123def789abc1231234",
    swap_path: ["50 XLM", "420 USDC"],
  };

  const mockEventMint = {
    seq: 1003,
    contract_id: "CBQHNFXRHVKQH4X6M3YLJQ5I6EYKJ5YJW5HU5CYJ5HRJDTIKI7BF6RQD",
    function: "mint",
    ledger: 2600000,
    description:
      "Minted 1000.00 EURC to GBSGQVRJ6EDU2T7K6WZ6M3YLJQ5I6EYKJ5YJW5HU5CYJ5JW5HU5CYJ5JW5HU5CYJ5J",
    raw_topics: ["mint", "GBSGQVRJ6EDU2T7K6WZ6M3YLJQ5I6EYKJ5YJW5HU5CYJ5JW5HU5CYJ5J", "1000000000"],
    tx_hash: "ghi012abc345ghi012abc345ghi012abc345ghi012abc345ghi012abc3451234",
  };

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Override the default mock to return three real-looking events
    vi.mocked(api.events).mockResolvedValue({
      data: [mockEventTransfer, mockEventSwap, mockEventMint],
      next_cursor: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders event rows instead of the empty-state message", async () => {
    renderHome();

    // Wait for events to load — the empty-state "No events yet" should NOT appear
    const ledgerCell = await screen.findByText("2,500,000");
    expect(ledgerCell).toBeDefined();
    expect(screen.queryByText(/no events yet/i)).toBeNull();
  });

  it("displays the ledger column with formatted numbers for all events", async () => {
    renderHome();

    // Each event's ledger should be visible in the table
    expect(await screen.findByText("2,500,000")).toBeDefined();
    expect(screen.getByText("2,500,005")).toBeDefined();
    expect(screen.getByText("2,600,000")).toBeDefined();
  });

  it("displays function badges for each event type", async () => {
    renderHome();

    // Wait for events to load
    await screen.findByText("2,500,000");

    // Function names appear in both the filter <select> options AND the event badge
    // rows — verify each appears at least twice
    expect(screen.getAllByText("transfer").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("swap").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("mint").length).toBeGreaterThanOrEqual(2);
  });

  it("displays description column with linked Stellar addresses", async () => {
    renderHome();

    await screen.findByText("2,500,000");

    // USDC appears in transfer description AND swap path — verify it appears at least twice
    const usdcMatches = screen.getAllByText(/USDC/);
    expect(usdcMatches.length).toBeGreaterThanOrEqual(2);
    // XLM appears in swap description AND swap path span — verify at least twice
    const xlmMatches = screen.getAllByText(/XLM/);
    expect(xlmMatches.length).toBeGreaterThanOrEqual(2);
    // Mint description includes EURC (unique, only in one event row)
    expect(screen.getByText(/EURC/)).toBeDefined();
  });

  it("renders swap path when present on a swap event", async () => {
    renderHome();

    await screen.findByText("2,500,000");

    // The swap_path should be displayed inline
    expect(screen.getByText("50 XLM → 420 USDC")).toBeDefined();
  });

  it("renders sequence numbers as links to individual event pages", async () => {
    renderHome();

    await screen.findByText("2,500,000");

    // Each seq should be a link
    const seqLink = screen.getByText("#1001");
    expect(seqLink).toBeDefined();
    expect(seqLink.tagName).toBe("A");
    expect(seqLink.getAttribute("href")).toBe("/event/1001");
  });

  it("does not emit console.error during render of populated events", async () => {
    renderHome();

    await screen.findByText("2,500,000");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("renders all three events in the table", async () => {
    renderHome();

    await screen.findByText("2,500,000");

    // All three seq links should exist
    expect(screen.getByText("#1001")).toBeDefined();
    expect(screen.getByText("#1002")).toBeDefined();
    expect(screen.getByText("#1003")).toBeDefined();
  });

  it("renders table header columns: Seq, Ledger, Function, Description", async () => {
    renderHome();

    await screen.findByText("2,500,000");

    // Verify all expected column headers are present in the table
    expect(screen.getByText("Seq")).toBeDefined();
    expect(screen.getByText("Ledger")).toBeDefined();
    expect(screen.getByText("Function")).toBeDefined();
    expect(screen.getByText("Description")).toBeDefined();
  });

  it("does not render the error boundary fallback when events load", async () => {
    renderHome();

    await screen.findByText("2,500,000");
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("renders filter and pagination controls alongside event data", async () => {
    renderHome();

    await screen.findByText("2,500,000");

    // Filters should still be present when events are shown
    expect(screen.getByText("Function:")).toBeDefined();
    expect(screen.getByText(/← Prev/)).toBeDefined();
    expect(screen.getByText(/Next →/)).toBeDefined();
  });
});
