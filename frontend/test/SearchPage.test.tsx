import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import SearchPage from "../src/pages/SearchPage";

describe("SearchPage", () => {
  it("renders no results empty state with echoed query", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        query: "nonexistent",
        contracts: [],
        events: [],
        wallets: [],
        suggestions: [],
      }),
    });

    global.fetch = fetchMock as unknown as typeof fetch;
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/search?q=nonexistent"]}>
          <Routes>
            <Route path="/search" element={<SearchPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Text spans multiple nodes: "No results for <code>nonexistent</code>. Try..."
    // Match the deepest element whose textContent contains both phrases
    const resultMessage = await screen.findByText((_, element) => {
      const hasText = (el: Element | null) =>
        Boolean(el?.textContent?.includes("No results for") && el?.textContent?.includes("nonexistent"));
      // Only match if this element has the text but no child element also has it
      return hasText(element) && Array.from(element?.children ?? []).every((child) => !hasText(child));
    });
    expect(resultMessage).toBeDefined();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/search?q=nonexistent&limit=50");
  });
});
