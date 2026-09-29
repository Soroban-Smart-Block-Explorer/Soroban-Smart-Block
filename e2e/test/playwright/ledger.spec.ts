import { test, expect } from "@playwright/test";

const BASE_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// Issue #912: ledger page — normal, empty, gap and future-ledger (404) cases.
const base = {
  hash: "ab".repeat(32),
  indexed_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-01-01T00:00:00Z",
  protocol_version: 22,
  fees: { p10: 100, p50: 120, p90: 300, p99: 900 },
  utilization: { tx_count: 0.2, instructions: 0.95, read_bytes: 0.1, write_bytes: null },
  gap: null,
  prev: 99,
  next: 101,
};

const ledgers: Record<number, unknown> = {
  100: {
    ...base,
    ledger: 100,
    status: "indexed",
    soroban_tx_count: 1,
    event_count: 1,
    transactions: [
      {
        hash: "cd".repeat(32),
        status: "success",
        narratives: [{ contract_id: "CTOKEN", function: "transfer", description: "GA sent 10 USDC to GB" }],
      },
    ],
  },
  101: { ...base, ledger: 101, status: "indexed", soroban_tx_count: 0, event_count: 0, transactions: [], prev: 100, next: null },
  50: {
    ...base,
    ledger: 50,
    status: "gap",
    soroban_tx_count: 0,
    event_count: 0,
    transactions: [],
    gap: { id: 7, from_ledger: 45, to_ledger: 55, status: "open" },
  },
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/ledgers/*", (r) => {
    const seq = Number(new URL(r.request().url()).pathname.split("/").pop());
    const body = ledgers[seq];
    return body ? r.fulfill({ json: body }) : r.fulfill({ status: 404, json: { error: "ledger_not_found", ledger: seq } });
  });
});

test("shows header, utilization and Soroban transactions with narratives", async ({ page }) => {
  await page.goto(`${BASE_URL}/ledger/100`);
  await expect(page.getByRole("heading", { name: "Ledger 100" })).toBeVisible();
  await expect(page.getByText("Protocol version:")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "CPU instructions" })).toHaveAttribute("aria-valuenow", "95");
  await expect(page.getByText("GA sent 10 USDC to GB")).toBeVisible();
});

test("keyboard navigation moves to the next ledger", async ({ page }) => {
  await page.goto(`${BASE_URL}/ledger/100`);
  await expect(page.getByRole("heading", { name: "Ledger 100" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(/\/ledger\/101$/);
});

test("ledger with zero Soroban transactions shows the empty state", async ({ page }) => {
  await page.goto(`${BASE_URL}/ledger/101`);
  await expect(page.getByTestId("ledger-empty")).toBeVisible();
});

test("ledger inside a known gap shows a banner linking to the gap record", async ({ page }) => {
  await page.goto(`${BASE_URL}/ledger/50`);
  const banner = page.getByTestId("ledger-gap-banner");
  await expect(banner).toBeVisible();
  await expect(banner.getByRole("link")).toHaveAttribute("href", "/admin/jobs?gap=7");
});

test("future ledger renders not found", async ({ page }) => {
  await page.goto(`${BASE_URL}/ledger/999999999`);
  await expect(page.getByRole("heading", { name: "Ledger not found" })).toBeVisible();
});
