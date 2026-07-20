/**
 * Issue #430 — Home.tsx: renders without error when API returns an empty events array.
 *
 * Mocks the api module so that api.events resolves to [] and asserts:
 *   1. The empty-state message is visible ("No events yet")
 *   2. No React error-boundary text appears
 *   3. No console.error calls are made during the render cycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import ErrorBoundary from "../src/components/ErrorBoundary";
import Home from "../src/pages/Home";

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
