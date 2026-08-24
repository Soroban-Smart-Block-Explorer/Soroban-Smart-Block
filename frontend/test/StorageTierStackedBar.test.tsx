/**
 * Issue #543 — StorageTierStackedBar renders correct proportions for a
 * horizontal stacked bar of storage writes by durability tier, includes a
 * legend, and degrades gracefully when all counts are zero.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/api", () => ({
  api: {
    contractStorageTiers: vi.fn(),
  },
}));

import { api } from "../src/api";
import StorageTierStackedBar from "../src/components/StorageTierStackedBar";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("StorageTierStackedBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows correct proportions for 50 persistent and 30 temporary writes", async () => {
    vi.mocked(api.contractStorageTiers).mockResolvedValue({
      persistent: 50,
      temporary: 30,
      instance: 20,
    });

    render(
      <Wrapper>
        <StorageTierStackedBar contractId="C1" />
      </Wrapper>,
    );

    const bar = await screen.findByRole("img", { name: /storage writes by tier/i });
    const segments = bar.children;
    expect(segments).toHaveLength(3);

    // Total is 100, so percentages equal raw counts exactly.
    expect((segments[0] as HTMLElement).style.width).toBe("50%"); // persistent
    expect((segments[1] as HTMLElement).style.width).toBe("30%"); // temporary
    expect((segments[2] as HTMLElement).style.width).toBe("20%"); // instance

    // Legend shows each tier's raw count.
    expect(screen.getByText("(50)")).toBeDefined();
    expect(screen.getByText("(30)")).toBeDefined();
    expect(screen.getByText("(20)")).toBeDefined();
  });

  it("includes a per-segment tooltip describing archival durability", async () => {
    vi.mocked(api.contractStorageTiers).mockResolvedValue({
      persistent: 50,
      temporary: 30,
      instance: 0,
    });

    render(
      <Wrapper>
        <StorageTierStackedBar contractId="C1" />
      </Wrapper>,
    );

    const bar = await screen.findByRole("img", { name: /storage writes by tier/i });
    const persistentSegment = bar.children[0] as HTMLElement;
    expect(persistentSegment.title).toBe("50 persistent writes — these survive ledger archival");
  });

  it("renders gracefully when all counts are zero", async () => {
    vi.mocked(api.contractStorageTiers).mockResolvedValue({
      persistent: 0,
      temporary: 0,
      instance: 0,
    });

    render(
      <Wrapper>
        <StorageTierStackedBar contractId="C1" />
      </Wrapper>,
    );

    expect(await screen.findByText("No storage writes recorded yet")).toBeDefined();
    expect(screen.queryByRole("img", { name: /storage writes by tier/i })).toBeNull();
  });
});
