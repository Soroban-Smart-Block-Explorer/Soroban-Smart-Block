/**
 * Issue #556 — EventTable shows a contract name + protocol-type badge next to
 * each event's contract, using the same coloured badge shown on contract cards.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import EventTable from "../src/components/EventTable";
import type { DecodedEvent } from "../src/api";
import { api } from "../src/api";

vi.mock("../src/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/api")>();
  return {
    ...original,
    api: {
      ...original.api,
      contract: vi.fn(),
    },
  };
});

const DEX_CONTRACT_ID = "CSWAPABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABC";

const swapEvent: DecodedEvent = {
  seq: 1,
  contract_id: DEX_CONTRACT_ID,
  function: "swap",
  ledger: 100,
  description: "Address GA… swapped 50 XLM → 48 USDC on StellarSwap",
  raw_topics: [],
};

function renderTable(events: DecodedEvent[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <EventTable events={events} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EventTable — contract badge (Issue #556)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the contract name linked to the contract page and its protocol badge", async () => {
    vi.mocked(api.contract).mockResolvedValue({
      id: DEX_CONTRACT_ID,
      version: 1,
      name: "StellarSwap",
      description: "AMM DEX router",
      functions: [],
      protocol_type: "dex",
    } as Awaited<ReturnType<typeof api.contract>>);

    renderTable([swapEvent]);

    const nameLink = await screen.findByText("StellarSwap");
    expect(nameLink.tagName).toBe("A");
    expect(nameLink.getAttribute("href")).toBe(`/contract/${DEX_CONTRACT_ID}`);
    expect(screen.getByTitle("Protocol type: DEX")).toBeDefined();
  });

  it("falls back to a truncated address with no badge for an unregistered contract", async () => {
    vi.mocked(api.contract).mockRejectedValue(new Error("not found"));

    renderTable([swapEvent]);

    // truncateAddress renders "CSWAPA…0ABC" style text once the query settles (errors)
    await screen.findByText(/CSWAPA…/);
    expect(screen.queryByTitle(/Protocol type/)).toBeNull();
  });

  it("renders the Contract column header", () => {
    renderTable([swapEvent]);
    expect(screen.getByText("Contract")).toBeDefined();
  });
});
