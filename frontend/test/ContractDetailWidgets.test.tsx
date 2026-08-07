import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import CircuitBreakerStatus from "../src/components/CircuitBreakerStatus";
import WasmBuildMetadataPanel from "../src/components/WasmBuildMetadataPanel";
import UpgradeHistoryTimeline from "../src/components/UpgradeHistoryTimeline";

function renderWithProviders(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockFetchOnce(data: unknown, ok = true, status = 200) {
  (global as any).fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => data,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CircuitBreakerStatus (#539)", () => {
  it("renders nothing when the contract has no circuit breaker metadata", async () => {
    mockFetchOnce({ has_circuit_breaker: false, is_paused: false, status: "CLOSED" });
    const { container } = renderWithProviders(<CircuitBreakerStatus contractId="C1" />);
    await waitFor(() => expect(global.fetch as any).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("shows a red 'Circuit breaker tripped' banner when OPEN and links to the trigger event", async () => {
    mockFetchOnce({
      has_circuit_breaker: true,
      is_paused: true,
      status: "OPEN",
      pause_status_ledger: 500,
      pause_trigger_tx_hash: "deadbeef1234",
      pause_trigger_event_seq: 42,
      trigger_threshold: 1,
      auto_reset_at: null,
    });
    renderWithProviders(<CircuitBreakerStatus contractId="C1" />);
    expect(await screen.findByText("Circuit breaker tripped")).toBeDefined();
    const link = (await screen.findByText(/View trigger event/)).closest("a");
    expect(link?.getAttribute("href")).toBe("/event/42");
  });

  it("shows CLOSED status without a trigger-event link when operational", async () => {
    mockFetchOnce({
      has_circuit_breaker: true,
      is_paused: false,
      status: "CLOSED",
      pause_status_ledger: null,
      pause_trigger_tx_hash: null,
      pause_trigger_event_seq: null,
      trigger_threshold: 1,
      auto_reset_at: null,
    });
    renderWithProviders(<CircuitBreakerStatus contractId="C1" />);
    expect(await screen.findByText("Status: CLOSED")).toBeDefined();
    expect(screen.queryByText(/View trigger event/)).toBeNull();
  });
});

describe("WasmBuildMetadataPanel (#537)", () => {
  it("shows a 'WASM not indexed' placeholder on 404", async () => {
    mockFetchOnce({ error: "WASM not indexed" }, false, 404);
    renderWithProviders(<WasmBuildMetadataPanel contractId="C1" />);
    expect(await screen.findByText("WASM not indexed")).toBeDefined();
  });

  it("renders hash, compiler, SDK version, and size when indexed", async () => {
    mockFetchOnce({
      wasm_hash: "a".repeat(64),
      contract_id: "C1",
      size_bytes: 12345,
      sdk_version: "v21.1.0",
      compiler: "rustc 1.78.0",
      optimizer: null,
      repository: null,
      commit: null,
      producers: {},
      ledger: 100,
      tx_hash: "txhash",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    renderWithProviders(<WasmBuildMetadataPanel contractId="C1" />);
    expect(await screen.findByText("rustc 1.78.0")).toBeDefined();
    expect(await screen.findByText("v21.1.0")).toBeDefined();
    expect(await screen.findByText("12,345 bytes")).toBeDefined();
  });
});

describe("UpgradeHistoryTimeline (#538)", () => {
  it("shows the empty-state message when no upgrades exist", async () => {
    mockFetchOnce([]);
    renderWithProviders(<UpgradeHistoryTimeline contractId="C1" />);
    expect(
      await screen.findByText("No upgrades detected — this contract has not been upgraded since indexing began."),
    ).toBeDefined();
  });

  it("shows two entries in chronological order for a contract upgraded twice", async () => {
    mockFetchOnce([
      { ledger: 100, old_hash: "aaa", new_hash: "bbb", tx_hash: "tx1", timestamp: "2026-01-01T00:00:00.000Z" },
      { ledger: 200, old_hash: "bbb", new_hash: "ccc", tx_hash: "tx2", timestamp: "2026-02-01T00:00:00.000Z" },
    ]);
    renderWithProviders(<UpgradeHistoryTimeline contractId="C1" />);
    const ledgerEntries = await screen.findAllByText(/^Ledger/);
    expect(ledgerEntries).toHaveLength(2);
    expect(ledgerEntries[0].textContent).toContain("100");
    expect(ledgerEntries[1].textContent).toContain("200");
  });
});
