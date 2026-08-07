import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import WalletPage from "../src/pages/WalletPage";

const VALID_ADDR = "GA5ZSEJYB37FRCONJ3LQUMTZHKWZ6BIGZU3U2XHRJHXBVWMGHMV36TJQ";

const mockWalletHistory = vi.fn();

vi.mock("../src/api", () => ({
  api: {
    // #525 / #527: walletHistory replaces wallet() — accepts optional date params.
    walletHistory: (...args: unknown[]) => mockWalletHistory(...args),
    // contract metadata is fetched in grouped view (#526)
    contract: vi.fn().mockResolvedValue(null),
  },
}));

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWalletPage(address: string, search = "") {
  const qc = makeQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/wallet/${address}${search}`]}>
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

  // ── #525: Basic rendering ─────────────────────────────────────────────────

  it("renders events from a mock API response", async () => {
    const mockEvents = [
      {
        seq: 1001,
        contract_id: "CCEMOFO5TE7FGOAJXR3RDHPC6RWO4FM2GOPUKI5N6KJQ4MOLOFPFJN6B",
        function: "transfer",
        ledger: 2500000,
        description: "Transferred 100.00 USDC to GDQOE2JFBXYKIYLJBNUDRZI2FHLX5TLXHMDNUE7KPK5I2YA5TSB6Z4LD",
        raw_topics: ["transfer"],
        tx_hash: "abc123def456abc123def456abc123def456abc123def456abc123def4561234",
      },
      {
        seq: 1002,
        contract_id: "CDLZFC3SYJYDZT7K67VZ75HRJDTIKI7BF6RQD7MFPK5QERZUTXX7YV7V",
        function: "swap",
        ledger: 2500005,
        description: "Swapped 50.00 XLM to 420.00 USDC",
        raw_topics: ["swap"],
        tx_hash: "def789abc123def789abc123def789abc123def789abc123def789abc1231234",
      },
    ];

    mockWalletHistory.mockResolvedValue({ events: mockEvents, horizon_account: null });

    renderWalletPage(VALID_ADDR);

    const seqLink = await screen.findByText("#1001");
    expect(seqLink).toBeDefined();
    expect(screen.getByText("#1002")).toBeDefined();
    expect(screen.getByText("2,500,000")).toBeDefined();
    expect(screen.getByText("2,500,005")).toBeDefined();
    expect(screen.getByText("transfer")).toBeDefined();
    expect(screen.getByText("swap")).toBeDefined();
  });

  it("shows a friendly error for an invalid address (#525)", async () => {
    renderWalletPage("GFOO");

    // #525: error message must include the bad address
    const errorEl = await screen.findByText(/GFOO is not a valid Stellar address/i);
    expect(errorEl).toBeDefined();
    expect(mockWalletHistory).not.toHaveBeenCalled();
  });

  it("shows empty state with register-contract link when no events found (#525)", async () => {
    mockWalletHistory.mockResolvedValue({ events: [], horizon_account: null });

    renderWalletPage(VALID_ADDR);

    const emptyMsg = await screen.findByText("No Soroban interactions found for this address.");
    expect(emptyMsg).toBeDefined();

    // #525: link to register a contract in empty state
    const registerLink = await screen.findByText(/Register a contract/i);
    expect(registerLink).toBeDefined();
  });

  it("shows summary row with event count and unique contracts (#525)", async () => {
    const mockEvents = [
      {
        seq: 1,
        contract_id: "CCEMOFO5TE7FGOAJXR3RDHPC6RWO4FM2GOPUKI5N6KJQ4MOLOFPFJN6B",
        function: "transfer",
        ledger: 1000,
        description: "Transfer event",
        raw_topics: [],
      },
      {
        seq: 2,
        contract_id: "CDLZFC3SYJYDZT7K67VZ75HRJDTIKI7BF6RQD7MFPK5QERZUTXX7YV7V",
        function: "swap",
        ledger: 1001,
        description: "Swap event",
        raw_topics: [],
      },
    ];
    mockWalletHistory.mockResolvedValue({ events: mockEvents, horizon_account: null });

    renderWalletPage(VALID_ADDR);

    // Summary: 2 total events, 2 unique contracts
    expect(await screen.findByText("2")).toBeDefined();
    expect(screen.getByText(/total event/i)).toBeDefined();
  });

  it("renders XLM balance when horizon_account is present in the response", async () => {
    mockWalletHistory.mockResolvedValue({
      events: [],
      horizon_account: {
        id: VALID_ADDR,
        account_id: VALID_ADDR,
        sequence: "123456789",
        balances: [
          { asset_type: "native", balance: "1250.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: "GDQOE2JFBXYKIYLJBNUDRZI2FHLX5TLXHMDNUE7KPK5I2YA5TSB6Z4LD",
            balance: "500.0000000",
          },
        ],
      },
    });

    renderWalletPage(VALID_ADDR);

    const xlmHeading = await screen.findByText("XLM Balance");
    expect(xlmHeading).toBeDefined();
    expect(screen.getByText("1250.0000000 XLM")).toBeDefined();
  });

  // ── #527: Date range filter ───────────────────────────────────────────────

  it("restores date range filter from URL params (#527)", async () => {
    mockWalletHistory.mockResolvedValue({
      events: [
        {
          seq: 1,
          contract_id: "CCEMOFO5TE7FGOAJXR3RDHPC6RWO4FM2GOPUKI5N6KJQ4MOLOFPFJN6B",
          function: "transfer",
          ledger: 150,
          description: "moved tokens",
          raw_topics: [],
        },
      ],
      horizon_account: null,
    });

    renderWalletPage(VALID_ADDR, "?from=2026-01-01&to=2026-03-31");

    // Date inputs should be pre-filled from URL
    const fromInput = await screen.findByDisplayValue("2026-01-01");
    expect(fromInput).toBeDefined();
    const toInput = screen.getByDisplayValue("2026-03-31");
    expect(toInput).toBeDefined();
  });

  it("passes from/to params to the API on date filter change (#527)", async () => {
    mockWalletHistory.mockResolvedValue({ events: [], horizon_account: null });

    renderWalletPage(VALID_ADDR);

    await screen.findByText("No Soroban interactions found for this address.");

    // walletHistory should have been called
    expect(mockWalletHistory).toHaveBeenCalledWith(
      VALID_ADDR,
      expect.objectContaining({ from: "", to: "" }),
    );
  });

  // ── #526: Group by contract ───────────────────────────────────────────────

  it("renders group-by-contract toggle in the filter bar (#526)", async () => {
    mockWalletHistory.mockResolvedValue({ events: [], horizon_account: null });

    renderWalletPage(VALID_ADDR);

    await screen.findByText("No Soroban interactions found for this address.");

    // Group-by select must exist
    const groupSelect = screen.getByDisplayValue("Flat list");
    expect(groupSelect).toBeDefined();
  });

  it("restores group=contract from the URL (#526)", async () => {
    mockWalletHistory.mockResolvedValue({
      events: [
        {
          seq: 1,
          contract_id: "CCEMOFO5TE7FGOAJXR3RDHPC6RWO4FM2GOPUKI5N6KJQ4MOLOFPFJN6B",
          function: "transfer",
          ledger: 100,
          description: "Transfer",
          raw_topics: [],
        },
      ],
      horizon_account: null,
    });

    renderWalletPage(VALID_ADDR, "?group=contract");

    // The select should show "Contract" when group=contract is in URL
    const groupSelect = await screen.findByDisplayValue("Contract");
    expect(groupSelect).toBeDefined();
  });

  // ── #528: Export CSV ──────────────────────────────────────────────────────

  it("renders Export CSV button (#528)", async () => {
    mockWalletHistory.mockResolvedValue({ events: [], horizon_account: null });

    renderWalletPage(VALID_ADDR);

    const exportBtn = await screen.findByText("↓ Export CSV");
    expect(exportBtn).toBeDefined();
  });

  it("Share button copies URL and shows toast (#525)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    mockWalletHistory.mockResolvedValue({ events: [], horizon_account: null });

    renderWalletPage(VALID_ADDR);

    const shareBtn = await screen.findByTitle("Copy a shareable link with the current filters");
    fireEvent.click(shareBtn);

    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByText("Link copied!")).toBeDefined();
  });
});
