import { test, expect, request } from "@playwright/test";

// End-to-end moderator flow (#934): an impersonating registration is held
// out of the registry, a moderator reviews the evidence in the admin UI and
// rejects it, and the action lands in the audit log.
//
// Requires the indexer with VERIFY_ABI=false, API_KEY and ADMIN_SECRET set.

const API_URL = process.env.API_URL || "http://localhost:3001";
const API_KEY = process.env.API_KEY || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

// Unique, schema-valid contract id (^C[A-Z2-7]{55}$) per test run.
function contractId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return "C" + Array.from({ length: 55 }, () => alphabet[Math.floor(Math.random() * 32)]).join("");
}

test.skip(!API_KEY || !ADMIN_SECRET, "API_KEY and ADMIN_SECRET are required");

test("impersonation is held, reviewed and rejected by a moderator", async ({ page }) => {
  const api = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { "x-api-key": API_KEY } });
  const id = contractId();

  const created = await api.post("/api/contracts", {
    data: { id, name: "USDC Official", description: "The official USDC token.", functions: [] },
  });
  expect(created.status()).toBe(201);
  expect((await created.json()).moderation_status).toBe("held");

  // Held registrations are not listed and expose no curated metadata.
  const detail = await (await api.get(`/api/contracts/${id}`)).json();
  expect(detail.name).toBeNull();

  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${ADMIN_SECRET}` });
  await page.goto("/admin/moderation");
  const row = page.getByRole("row", { name: /USDC Official/ });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Review" }).click();

  const panel = page.getByLabel("Moderation detail");
  await expect(panel).toContainText("impersonation_known_token");
  await panel.getByPlaceholder("e.g. impersonates USDC").fill("impersonates USDC");
  await panel.getByRole("button", { name: "reject" }).click();

  await expect(panel).toContainText("status rejected");
  await expect(panel).toContainText("reject by");
  await expect(page.getByRole("row", { name: /USDC Official/ })).toHaveCount(0);
});

test("a legitimate registration is published and can be reported", async () => {
  const api = await request.newContext({ baseURL: API_URL, extraHTTPHeaders: { "x-api-key": API_KEY } });
  const id = contractId();

  const created = await api.post("/api/contracts", {
    data: { id, name: "ExampleToken", description: "A SEP-41 token.", functions: [] },
  });
  expect((await created.json()).moderation_status).toBe("published");

  const report = await api.post(`/api/contracts/${id}/reports`, { data: { reason: "spam" } });
  expect(report.status()).toBe(201);
  const duplicate = await api.post(`/api/contracts/${id}/reports`, { data: { reason: "spam" } });
  expect(duplicate.status()).toBe(409);
});
