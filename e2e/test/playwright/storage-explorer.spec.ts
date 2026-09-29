import { test, expect } from "@playwright/test";

const BASE_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const CONTRACT = "CSTORAGEFIXTURE";

// Issue #922: fixture contract with all three durabilities, an archived entry and history.
const diffs = [
  {
    ledger: 100,
    tx_hash: "t1",
    key: "Balance(GA)",
    tier: "persistent",
    old_value: null,
    new_value: "10",
    change_type: "created",
    created_at: "2026-01-01T00:00:00Z",
    live_until_ledger: 150,
  },
  {
    ledger: 200,
    tx_hash: "t2",
    key: "Admin",
    tier: "persistent",
    old_value: null,
    new_value: '"GADMIN"',
    change_type: "created",
    created_at: "2026-01-01T00:10:00Z",
    live_until_ledger: 9000,
  },
  {
    ledger: 210,
    tx_hash: "t3",
    key: "Instance",
    tier: "instance",
    old_value: null,
    new_value: '{"Name":"Tok","Decimals":7}',
    change_type: "created",
    created_at: "2026-01-01T00:11:00Z",
    live_until_ledger: 9000,
  },
  {
    ledger: 220,
    tx_hash: "t4",
    key: "Nonce(GA)",
    tier: "temporary",
    old_value: null,
    new_value: "1",
    change_type: "created",
    created_at: "2026-01-01T00:12:00Z",
    live_until_ledger: 300,
  },
  {
    ledger: 250,
    tx_hash: "t5",
    key: "Admin",
    tier: "persistent",
    old_value: '"GADMIN"',
    new_value: '"GNEW"',
    change_type: "updated",
    created_at: "2026-01-01T00:15:00Z",
    live_until_ledger: 9000,
  },
];

test.beforeEach(async ({ page }) => {
  await page.route(`**/api/contracts/${CONTRACT}/state-diffs**`, (r) => r.fulfill({ json: diffs }));
  await page.route(`**/api/contracts/${CONTRACT}/ttl`, (r) =>
    r.fulfill({
      json: { current_ledger: 260, instance: { live_until_ledger: 9000 }, code: { live_until_ledger: 9000 } },
    }),
  );
  await page.goto(`${BASE_URL}/contract/${CONTRACT}`);
  await page.getByRole("button", { name: "Storage" }).click();
});

test("groups entries by durability and expands instance storage", async ({ page }) => {
  await expect(page.getByTestId("storage-group-persistent")).toContainText("Admin");
  await expect(page.getByTestId("storage-group-persistent")).toContainText("Balance(GA)");
  await expect(page.getByTestId("storage-group-instance")).toContainText("Name");
  await expect(page.getByTestId("storage-group-instance")).toContainText("Decimals");
  await expect(page.getByTestId("storage-group-temporary")).toContainText("Nonce(GA)");
});

test("shows restore guidance for archived entries", async ({ page }) => {
  await page.getByRole("listitem").filter({ hasText: "Balance(GA)" }).click();
  await expect(page.getByTestId("restore-guidance")).toContainText("Estimated restore cost");
});

test("time travel shows storage as of ledger N", async ({ page }) => {
  await page.getByLabel("View as of ledger").fill("205");
  await expect(page.getByTestId("storage-group-instance")).toContainText("No entries.");
  await expect(page.getByTestId("storage-group-temporary")).toContainText("No entries.");
  await page.getByRole("listitem").filter({ hasText: "Admin" }).click();
  await expect(page.getByTestId("storage-entry-detail")).toContainText("GADMIN");
  await expect(page.getByTestId("storage-entry-detail")).not.toContainText("GNEW");
});
