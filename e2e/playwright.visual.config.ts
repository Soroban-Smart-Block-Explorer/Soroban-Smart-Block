import { defineConfig, devices } from "@playwright/test";
import baseConfig from "./playwright.config";

/**
 * Visual-regression config. Reuses the base config (web servers, screenshot
 * tolerances, updateSnapshots policy) but points `testDir` at ./test/visual,
 * where visual-regression.spec.ts lives — the base config's testDir is
 * ./test/playwright, so `playwright test test/visual/...` finds nothing.
 */
export default defineConfig({
  ...baseConfig,
  testDir: "./test/visual",
  // Issue #924: mobile device profiles, including 360px phones, landscape phones and small tablets.
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-360", use: { ...devices["Galaxy S9+"], viewport: { width: 360, height: 740 } } },
    { name: "mobile-landscape", use: { ...devices["Pixel 5 landscape"] } },
    { name: "iphone", use: { ...devices["iPhone 14"] } },
    { name: "small-tablet", use: { ...devices["iPad Mini"] } },
  ],
});
