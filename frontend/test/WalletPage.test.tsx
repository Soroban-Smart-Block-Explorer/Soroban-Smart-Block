import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let mockSearchParams = new URLSearchParams();
const setSearchParams = vi.fn((next: URLSearchParams) => {
  mockSearchParams = next;
});

vi.mock("react-router-dom", () => ({
  useParams: () => ({ address: "GA3X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X" }),
  useSearchParams: () => [mockSearchParams, setSearchParams],
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("../src/api", () => ({
  api: {
    wallet: vi.fn().mockResolvedValue({ events: [] }),
  },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("WalletPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders with empty-state message when no events", async () => {
    const WalletPage = (await import("../src/pages/WalletPage")).default;
    render(
      <Wrapper>
        <WalletPage />
      </Wrapper>
    );
    expect(await screen.findByText("No Soroban interactions found for this address")).toBeDefined();
  });

  it("shows address in page heading even with no events", async () => {
    const WalletPage = (await import("../src/pages/WalletPage")).default;
    render(
      <Wrapper>
        <WalletPage />
      </Wrapper>
    );
    expect(await screen.findByText("GA3X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X")).toBeDefined();
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
