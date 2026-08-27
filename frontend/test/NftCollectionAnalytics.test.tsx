/**
 * Issue #810 — NftCollectionAnalytics renders collection-level analytics for an
 * NFT collection: total minted / transfers / unique-holder stats plus mint
 * volume and unique-holder trend charts, with an empty-state placeholder when
 * the collection has no activity.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/api", () => ({
  api: {
    nftAnalytics: vi.fn(),
  },
}));

import { api } from "../src/api";
import NftCollectionAnalytics from "../src/components/NftCollectionAnalytics";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeDays(counts: number[]) {
  return counts.map((count, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    count,
  }));
}

function analyticsFixture() {
  const mint = makeDays(Array.from({ length: 30 }, (_, i) => (i === 29 ? 7 : 0)));
  const holders = makeDays(Array.from({ length: 30 }, (_, i) => (i === 29 ? 9 : 0)));
  return {
    contract_id: "CNFT",
    days: 30,
    totals: { minted: 11, transfers: 3, unique_holders: 9 },
    mint_volume: mint,
    holder_count: holders,
  };
}

describe("NftCollectionAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders stat tiles and both trend charts", async () => {
    vi.mocked(api.nftAnalytics).mockResolvedValue(analyticsFixture());

    render(
      <Wrapper>
        <NftCollectionAnalytics contractId="CNFT" />
      </Wrapper>,
    );

    // Stat tiles
    expect(await screen.findByText("11")).toBeDefined();
    expect(screen.getByText("Total Minted")).toBeDefined();
    expect(screen.getByText("Transfers")).toBeDefined();
    expect(screen.getByText("Unique Holders")).toBeDefined();

    // Both charts render with accessible labels
    expect(screen.getByRole("img", { name: /NFT mint volume for the last 30 days/i })).toBeDefined();
    expect(screen.getByRole("img", { name: /unique holders over the last 30 days/i })).toBeDefined();

    // Mint bars carry per-day aria-labels
    const bars = screen.getByRole("img", { name: /NFT mint volume/i }).querySelectorAll("rect");
    expect(bars.length).toBeGreaterThan(0);
    expect(Array.from(bars).some((b) => b.getAttribute("aria-label")?.includes("7 mints"))).toBe(true);
  });

  it("shows empty-state placeholders when the collection has no activity", async () => {
    vi.mocked(api.nftAnalytics).mockResolvedValue({
      contract_id: "CNFT",
      days: 30,
      totals: { minted: 0, transfers: 0, unique_holders: 0 },
      mint_volume: makeDays(Array(30).fill(0)),
      holder_count: makeDays(Array(30).fill(0)),
    });

    render(
      <Wrapper>
        <NftCollectionAnalytics contractId="CNFT" />
      </Wrapper>,
    );

    expect(await screen.findByText("No mints in the last 30 days")).toBeDefined();
    expect(screen.getByText("No holders recorded in the last 30 days")).toBeDefined();
    expect(screen.queryByRole("img", { name: /NFT mint volume/i })).toBeNull();
  });

  it("renders nothing when the analytics request fails", async () => {
    vi.mocked(api.nftAnalytics).mockRejectedValue(new Error("network error"));

    const { container } = render(
      <Wrapper>
        <NftCollectionAnalytics contractId="CNFT" />
      </Wrapper>,
    );

    await vi.waitFor(() => {
      expect(container.textContent).not.toMatch(/loading/i);
    });
    expect(container.querySelector("svg")).toBeNull();
  });
});
