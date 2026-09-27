import { test, expect, Page, BrowserContext, request } from "@playwright/test";

// Passkey sign-in E2E (#933) using a CDP virtual authenticator.
// Requires the indexer with AUTH_EMAIL_ECHO_TOKEN=true (non-production only)
// and WEBAUTHN_ORIGINS / WEBAUTHN_RP_ID matching FRONTEND_URL.

const API_URL = process.env.API_URL || "http://localhost:3001";

test.skip(({ browserName }) => browserName !== "chromium", "virtual authenticators need CDP (Chromium)");

async function addVirtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

async function emailToken(email: string, purpose: "signup" | "recovery"): Promise<string> {
  const api = await request.newContext({ baseURL: API_URL });
  const csrf = await (await api.get("/api/csrf-token")).json();
  const res = await api.post("/api/auth/email/start", {
    data: { email, purpose },
    headers: { "x-csrf-token": csrf.csrfToken },
  });
  expect(res.status()).toBe(202);
  const { token } = await res.json();
  expect(token, "AUTH_EMAIL_ECHO_TOKEN must be enabled").toBeTruthy();
  return token;
}

async function signUp(page: Page, email: string): Promise<string[]> {
  const token = await emailToken(email, "signup");
  await page.goto(`/login?purpose=signup&token=${encodeURIComponent(token)}`);
  const codes = (await page.getByTestId("recovery-codes").innerText()).trim().split("\n");
  expect(codes).toHaveLength(10);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await page.waitForURL("**/dashboard");
  return codes;
}

test("register a passkey, sign out, and sign back in", async ({ context, page }) => {
  await addVirtualAuthenticator(context, page);
  const email = `pk-${Date.now()}@example.com`;
  await signUp(page, email);
  await expect(page.getByLabel("Account security")).toContainText(email);
  await expect(page.getByTestId("passkey-list").locator("li")).toHaveCount(1);

  await page.getByRole("button", { name: "Sign out of account" }).click();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL("**/dashboard");
  await expect(page.getByLabel("Account security")).toContainText(email);
});

test("sensitive action triggers a step-up re-authentication", async ({ context, page }) => {
  const { cdp, authenticatorId } = await addVirtualAuthenticator(context, page);
  await signUp(page, `stepup-${Date.now()}@example.com`);

  // Start a fresh (non-elevated) passkey session.
  await page.getByRole("button", { name: "Sign out of account" }).click();
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.waitForURL("**/dashboard");

  const before = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0].signCount;
  const stepUpVerify = page.waitForResponse((r) => r.url().endsWith("/api/auth/step-up/verify"));
  await page.getByRole("button", { name: "Generate new recovery codes" }).click();
  expect((await stepUpVerify).status()).toBe(200);
  await expect(page.getByTestId("new-recovery-codes")).toBeVisible();
  const after = (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials[0].signCount;
  expect(after).toBeGreaterThan(before);
});

test("recovery needs the email link and a recovery code", async ({ browser }) => {
  const email = `recover-${Date.now()}@example.com`;
  const first = await browser.newContext();
  const firstPage = await first.newPage();
  await addVirtualAuthenticator(first, firstPage);
  const codes = await signUp(firstPage, email);
  await first.close();

  // New device, all passkeys lost.
  const second = await browser.newContext();
  const page = await second.newPage();
  await addVirtualAuthenticator(second, page);

  // Email link alone with a wrong code is rejected.
  let token = await emailToken(email, "recovery");
  await page.goto(`/login?purpose=recovery&token=${encodeURIComponent(token)}`);
  await page.getByLabel("Recovery code").fill("WRONG-CODE0");
  await page.getByRole("button", { name: "Recover account" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid link or recovery code");

  token = await emailToken(email, "recovery");
  await page.goto(`/login?purpose=recovery&token=${encodeURIComponent(token)}`);
  await page.getByLabel("Recovery code").fill(codes[0]);
  await page.getByRole("button", { name: "Recover account" }).click();
  await page.waitForURL("**/dashboard");
  await expect(page.getByLabel("Account security")).toContainText(email);
  await second.close();
});

test("session cookie is HttpOnly/Secure/Lax and CSRF is enforced", async ({ context, page }) => {
  await addVirtualAuthenticator(context, page);
  await signUp(page, `cookie-${Date.now()}@example.com`);
  const sid = (await context.cookies()).find((c) => c.name === "sid");
  expect(sid?.httpOnly).toBe(true);
  expect(sid?.secure).toBe(true);
  expect(sid?.sameSite).toBe("Lax");

  const status = await page.evaluate(async () => {
    const res = await fetch("/api/auth/recovery-codes", { method: "POST", credentials: "include" });
    return res.status;
  });
  expect(status).toBe(403);
});
