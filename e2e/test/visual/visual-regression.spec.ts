import { test, expect } from "@playwright/test";

/**
 * Visual regression testing (issue #767) for the highest-traffic pages,
 * using Playwright's built-in screenshot comparison. On first run this
 * generates baseline snapshots (committed to the repo); subsequent runs
 * fail with a diff image attached to the report if the rendered page
 * changes unexpectedly.
 */
test.describe("Visual regression - key pages", () => {
  test("Home", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Smart Block")).toBeVisible();
    await expect(page).toHaveScreenshot("home.png", { fullPage: true });
  });

  test("ContractPage", async ({ page }) => {
    await page.goto("/contract/does-not-exist");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("contract-page.png", { fullPage: true });
  });

  test("WalletPage", async ({ page }) => {
    await page.goto("/wallet/GABC0000000000000000000000000000000000000000000000000000");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("wallet-page.png", { fullPage: true });
  });

  test("EventPage", async ({ page }) => {
    await page.goto("/event/1");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveScreenshot("event-page.png", { fullPage: true });
  });
});
