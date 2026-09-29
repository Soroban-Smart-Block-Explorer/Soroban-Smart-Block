import { test, expect } from "@playwright/test";

/**
 * Issue #924: no horizontal page overflow at 360px on any route, and touch
 * targets on detail pages are at least 44×44px.
 */
const ROUTES = [
  "/",
  "/contracts",
  "/contract/does-not-exist",
  "/event/1",
  "/tx/does-not-exist",
  "/wallet/GABC0000000000000000000000000000000000000000000000000000",
  "/search",
  "/graph",
  "/network",
  "/status",
  "/dashboard",
  "/sub-invocations",
];

test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });

for (const route of ROUTES) {
  test(`no horizontal overflow at 360px: ${route}`, async ({ page }) => {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

for (const route of ["/contract/does-not-exist", "/event/1"]) {
  test(`touch targets ≥ 44px: ${route}`, async ({ page }) => {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const small = await page.evaluate(
      () =>
        [...document.querySelectorAll("main button, main select")]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)).length,
    );
    expect(small).toBe(0);
  });
}
