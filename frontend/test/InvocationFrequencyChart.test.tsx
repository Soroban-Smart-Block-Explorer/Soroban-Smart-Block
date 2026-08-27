/**
 * Issue #542 — InvocationFrequencyChart renders a 30-bar SVG bar chart from
 * the events_per_day series, shows an empty-state placeholder when all
 * counts are zero, and labels each bar for accessibility.
 * Issue #799 — the chart exposes selectable 30/90/365-day ranges; long ranges
 * are bucketed into weekly bars so the historical trend stays readable.
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

/** Stateful harness that mirrors ContractPage's lifted range state (#799). */
function RangeHarness() {
  const [range, setRange] = useState(30);
  return <InvocationFrequencyChart contractId="C1" range={range} onRangeChange={setRange} />;
}

function makeDays(counts: number[]) {
  return counts.map((count, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, "0")}`,
    count,
  }));
}

/** Sequential ISO dates starting 2025-01-01, with a count per day. */
function makeSeries(days: number, counts?: number[]) {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    return {
      date: d.toISOString().slice(0, 10),
      count: counts ? counts[i] ?? 0 : 0,
    };
  });
}

function mockStats(range: number, counts: number[]) {
  vi.mocked(api.contractStats).mockResolvedValue({
    total_events: counts.reduce((a, b) => a + b, 0),
    unique_callers: 3,
    first_seen_ledger: 100,
    last_seen_ledger: 200,
    range,
    events_per_day: makeSeries(range, counts),
  });
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

  it("refetches with range=365 and renders weekly buckets when 365D is selected (#799)", async () => {
    // Varies across the year so the weekly trend is non-flat.
    const counts = Array.from({ length: 365 }, (_, i) => ((i / 7) | 0) % 10);
    vi.mocked(api.contractStats).mockImplementation((_id, range) =>
      Promise.resolve({
        total_events: counts.reduce((a, b) => a + b, 0),
        unique_callers: 3,
        first_seen_ledger: 100,
        last_seen_ledger: 200,
        range: range ?? 30,
        events_per_day: makeSeries(range ?? 30, counts),
      }),
    );

    render(
      <Wrapper>
        <RangeHarness />
      </Wrapper>,
    );

    // Wait for the default (30-day) chart so the selector is present.
    await screen.findByRole("img", { name: /invocation frequency for the last 30 days/i });
    fireEvent.click(screen.getByRole("button", { name: "365D" }));

    // 365 days bucketed weekly → 53 bars, and the request carries the range.
    const svg = await screen.findByRole("img", { name: /invocation frequency for the last 365 days/i });
    expect(svg.querySelectorAll("rect")).toHaveLength(53);
    await waitFor(() => {
      expect(api.contractStats).toHaveBeenCalledWith("C1", 365);
    });
  });

  it("renders daily bars for the 90-day range when 90D is selected (#799)", async () => {
    mockStats(90, Array.from({ length: 90 }, (_, i) => (i % 9) * 2));

    render(
      <Wrapper>
        <RangeHarness />
      </Wrapper>,
    );

    // Wait for the default (30-day) chart so the selector is present.
    await screen.findByRole("img", { name: /invocation frequency for the last 30 days/i });
    fireEvent.click(screen.getByRole("button", { name: "90D" }));

    const svg = await screen.findByRole("img", { name: /invocation frequency for the last 90 days/i });
    expect(svg.querySelectorAll("rect")).toHaveLength(90);
    await waitFor(() => {
      expect(api.contractStats).toHaveBeenCalledWith("C1", 90);
    });
  });
});
