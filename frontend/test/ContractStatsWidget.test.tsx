/**
 * Issue #799 — ContractStatsWidget renders aggregate event/caller stats plus
 * a daily event-count sparkline for the shared selectable time range, and
 * passes the range through to GET /api/contracts/:id/stats?range=.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/api", () => ({
  api: {
    contractStats: vi.fn(),
  },
}));

import { api } from "../src/api";
import ContractStatsWidget from "../src/components/ContractStatsWidget";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Sequential ISO dates starting 2026-01-01 with a varied daily count. */
function makeSeries(days: number) {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    count: (i % 5) * 2,
  }));
}

function mockStats(range: number) {
  vi.mocked(api.contractStats).mockResolvedValue({
    total_events: 1234,
    unique_callers: 87,
    first_seen_ledger: 1000,
    last_seen_ledger: 2000,
    range,
    events_per_day: makeSeries(range),
  });
}

describe("ContractStatsWidget (#799)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders totals and fetches with the default 30-day range", async () => {
    mockStats(30);
    render(
      <Wrapper>
        <ContractStatsWidget contractId="C1" />
      </Wrapper>,
    );

    expect(await screen.findByText("1,234")).toBeDefined();
    expect(screen.getByText("87")).toBeDefined();
    expect(screen.getByText("Ledger 2,000")).toBeDefined();
    expect(screen.getByText("Events / day (last 30 days)")).toBeDefined();
    expect(screen.getByLabelText("Events per day over the last 30 days")).toBeDefined();
    expect(api.contractStats).toHaveBeenCalledWith("C1", 30);
  });

  it("uses the shared range prop and reflects it in the sparkline label", async () => {
    mockStats(90);
    render(
      <Wrapper>
        <ContractStatsWidget contractId="C1" range={90} />
      </Wrapper>,
    );

    await waitFor(() => expect(api.contractStats).toHaveBeenCalledWith("C1", 90));
    expect(await screen.findByText("Events / day (last 90 days)")).toBeDefined();
    expect(screen.getByLabelText("Events per day over the last 90 days")).toBeDefined();
  });
});
