import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import WalletPage from "../src/pages/WalletPage";

const VALID_ADDR = "GA5ZSEJYB37FRCONJ3LQUMTZHKWZ6BIGZU3U2XHRJHXBVWMGHMV36TJQ";

const mockWallet = vi.fn();

vi.mock("../src/api", () => ({
  api: {
    wallet: (...args: unknown[]) => mockWallet(...args),
  },
}));

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderWalletPage(address: string) {
  const qc = makeQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/wallet/${address}`]}>
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
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

    mockWallet.mockResolvedValue({ events: mockEvents, horizon_account: null });

    renderWalletPage(VALID_ADDR);

    const seqLink = await screen.findByText("#1001");
    expect(seqLink).toBeDefined();
    expect(screen.getByText("#1002")).toBeDefined();
    expect(screen.getByText("2,500,000")).toBeDefined();
    expect(screen.getByText("2,500,005")).toBeDefined();
    expect(screen.getByText("transfer")).toBeDefined();
    expect(screen.getByText("swap")).toBeDefined();
  });

  it("shows 'invalid address' error for GFOO", async () => {
    renderWalletPage("GFOO");

    const errorEl = await screen.findByText("Invalid wallet address format");
    expect(errorEl).toBeDefined();

    expect(mockWallet).not.toHaveBeenCalled();
  });

  it("shows empty state when the events array is empty", async () => {
    mockWallet.mockResolvedValue({ events: [], horizon_account: null });

    renderWalletPage(VALID_ADDR);

    const emptyMsg = await screen.findByText("No Soroban interactions found for this address");
    expect(emptyMsg).toBeDefined();
  });

  it("renders XLM balance when horizon_account is present in the response", async () => {
    mockWallet.mockResolvedValue({
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

  it("restores filter state from the URL (issue #533 permalink)", async () => {
    mockSearchParams = new URLSearchParams({ from: "100", to: "200", fn: "transfer", group: "function" });
    const { api } = await import("../src/api");
    (api.wallet as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      events: [{ seq: 1, ledger: 150, function: "transfer", description: "moved tokens" }],
    });

    const WalletPage = (await import("../src/pages/WalletPage")).default;
    render(
      <Wrapper>
        <WalletPage />
      </Wrapper>
    );
    expect(await screen.findByDisplayValue("100")).toBeDefined();
    expect(screen.getByDisplayValue("200")).toBeDefined();
    expect(screen.getByDisplayValue("transfer")).toBeDefined();
    expect(screen.getByDisplayValue("Function")).toBeDefined();
  });

  it("copies the current URL and shows a transient 'Link copied!' toast on Share click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const WalletPage = (await import("../src/pages/WalletPage")).default;
    render(
      <Wrapper>
        <WalletPage />
      </Wrapper>
    );

    fireEvent.click(await screen.findByText("🔗 Share"));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(await screen.findByText("Link copied!")).toBeDefined();
  });
});
