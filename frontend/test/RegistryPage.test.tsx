import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RegistryPage from "../src/pages/RegistryPage";

describe("RegistryPage", () => {
  it("renders empty state when no contracts exist", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contracts: [],
        pagination: { page: 1, limit: 25, total: 0, total_pages: 0 },
      }),
    });

    (global as any).fetch = fetchMock;

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/contracts"]}>
          <Routes>
            <Route path="/contracts" element={<RegistryPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/No contracts registered yet/i)).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/contracts?page=1&limit=25");
  });

  it("renders contract list when contracts exist", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contracts: [
          {
            id: "CABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
            name: "Test Contract",
            description: "A test contract",
            registered_by: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234",
            has_circuit_breaker: false,
            is_paused: false,
            is_rwa: false,
            rwa_type: null,
            created_at: "2026-06-29T00:00:00Z",
          },
        ],
        pagination: { page: 1, limit: 25, total: 1, total_pages: 1 },
      }),
    });

    (global as any).fetch = fetchMock;

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/contracts"]}>
          <Routes>
            <Route path="/contracts" element={<RegistryPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Test Contract")).toBeDefined();
    expect(screen.getByText("A test contract")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/contracts?page=1&limit=25");
  });

  // Issue #556: coloured protocol-type badge on contract cards.
  it("shows a DEX badge on a contract tagged protocol_type=dex", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contracts: [
          {
            id: "CSWAPABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABC",
            name: "StellarSwap",
            description: "AMM DEX router",
            registered_by: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234",
            has_circuit_breaker: false,
            is_paused: false,
            is_rwa: false,
            rwa_type: null,
            protocol_type: "dex",
            created_at: "2026-06-29T00:00:00Z",
          },
        ],
        pagination: { page: 1, limit: 25, total: 1, total_pages: 1 },
      }),
    });

    (global as any).fetch = fetchMock;

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/contracts"]}>
          <Routes>
            <Route path="/contracts" element={<RegistryPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("StellarSwap")).toBeDefined();
    // The "DEX" filter <option> also matches the text "DEX" — target the badge
    // specifically via its title attribute.
    expect(screen.getByTitle("Protocol type: DEX")).toBeDefined();
  });
});
