import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-router-dom", () => ({
  useParams: () => ({ address: "GA3X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X5X" }),
}));

vi.mock("../src/api", () => ({
  api: {
    wallet: vi.fn().mockResolvedValue([]),
  },
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("WalletPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
