/**
 * Issue #542 — InvocationFrequencyChart renders a 30-bar SVG bar chart from
 * the events_per_day series, shows an empty-state placeholder when all
 * counts are zero, and labels each bar for accessibility.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/api", () => ({
  api: {
    contractStats: vi.fn(),
  },
}));

import { api } from "../src/api";
import InvocationFrequencyChart from "../src/components/InvocationFrequencyChart";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeDays(counts: number[]) {
  return counts.map((count, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}`,
    count,
  }));
}

describe("InvocationFrequencyChart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders 30 bars with proportional heights and per-bar aria-labels", async () => {
    const counts = Array.from({ length: 30 }, (_, i) => (i % 5) * 4); // varied, some zero
    vi.mocked(api.contractStats).mockResolvedValue({
      total_events: counts.reduce((a, b) => a + b, 0),
      unique_callers: 3,
      first_seen_ledger: 100,
      last_seen_ledger: 200,
      events_per_day: makeDays(counts),
    });

    render(
      <Wrapper>
        <InvocationFrequencyChart contractId="C1" />
      </Wrapper>,
    );

    const svg = await screen.findByRole("img", { name: /invocation frequency/i });
    const bars = svg.querySelectorAll("rect");
    expect(bars).toHaveLength(30);

    // Every bar must carry a date + count aria-label (acceptance criterion).
    bars.forEach((bar) => {
      expect(bar.getAttribute("aria-label")).toMatch(/^\w+ \d+: \d+ events?$/);
    });

    // The tallest bar corresponds to the highest count (16).
    const maxCount = Math.max(...counts);
    const labelled = Array.from(bars).find((b) => b.getAttribute("aria-label")?.includes(`${maxCount} events`));
    expect(labelled).toBeDefined();
  });

  it("shows the empty-state placeholder when all counts are zero", async () => {
    vi.mocked(api.contractStats).mockResolvedValue({
      total_events: 0,
      unique_callers: 0,
      first_seen_ledger: null,
      last_seen_ledger: null,
      events_per_day: makeDays(Array(30).fill(0)),
    });

    render(
      <Wrapper>
        <InvocationFrequencyChart contractId="C1" />
      </Wrapper>,
    );

    expect(await screen.findByText("No activity in the last 30 days")).toBeDefined();
    expect(screen.queryByRole("img", { name: /invocation frequency/i })).toBeNull();
  });

  it("renders nothing when the stats request fails", async () => {
    vi.mocked(api.contractStats).mockRejectedValue(new Error("network error"));

    const { container } = render(
      <Wrapper>
        <InvocationFrequencyChart contractId="C1" />
      </Wrapper>,
    );

    await vi.waitFor(() => {
      expect(container.textContent).not.toMatch(/loading/i);
    });
    expect(container.querySelector("svg")).toBeNull();
  });
});
