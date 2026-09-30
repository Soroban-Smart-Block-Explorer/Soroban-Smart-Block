/**
 * Developer-account API client (#933): passkey sign-in, step-up, recovery.
 * Session auth is an HttpOnly cookie; every mutation carries the CSRF header.
 */
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { getCsrfToken, initCsrf } from "../hooks/useCsrf";

export interface Passkey {
  id: string;
  name: string | null;
  device_type: string | null;
  backed_up: boolean;
  transports: string[];
  created_at: string;
  last_used_at: string | null;
}

export interface Account {
  id: string;
  email: string;
  stellar_address: string | null;
  passkeys: Passkey[];
  recovery_codes_remaining: number;
}

export interface Me {
  account: Account;
  session: { auth_method: string; elevated: boolean; expires_at: string };
  api_keys: { id: string; name: string; key_prefix: string; tier: string; scopes: string[] | null }[];
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status: number,
    public stepUp = false,
  ) {
    super(message);
  }
}

async function authFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  await initCsrf();
  const method = init.method ?? "GET";
  const res = await fetch(`/api/auth${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": getCsrfToken() } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AuthError(data.error ?? `Request failed (${res.status})`, res.status, Boolean(data.step_up));
  return data as T;
}

export const getMe = () => authFetch<Me>("/me");
export const logout = () => authFetch<void>("/logout", { method: "POST" });

export const startEmail = (email: string, purpose: "signup" | "claim" | "recovery") =>
  authFetch<{ ok: true; token?: string }>("/email/start", { method: "POST", body: { email, purpose } });

export const verifySignup = (token: string) =>
  authFetch<{ account: Account; recovery_codes?: string[]; claimed_api_keys: number }>("/email/verify", {
    method: "POST",
    body: { token },
  });

export const claimKeys = (token: string) =>
  authFetch<{ claimed_api_keys: number }>("/claim", { method: "POST", body: { token } });

export const recover = (token: string, code: string) =>
  authFetch<{ account: Account }>("/recovery", { method: "POST", body: { token, code } });

export async function registerPasskey(name?: string): Promise<Account> {
  const optionsJSON = await authFetch<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/passkeys/register/options",
    { method: "POST" },
  );
  const response = await startRegistration({ optionsJSON });
  const { account } = await authFetch<{ account: Account }>("/passkeys/register/verify", {
    method: "POST",
    body: { response, name },
  });
  return account;
}

export async function signInWithPasskey(): Promise<Account> {
  const optionsJSON = await authFetch<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/passkeys/login/options",
    { method: "POST" },
  );
  const response = await startAuthentication({ optionsJSON });
  const { account } = await authFetch<{ account: Account }>("/passkeys/login/verify", {
    method: "POST",
    body: { response },
  });
  return account;
}

/** Re-authenticate with a passkey to open the step-up window. */
export async function stepUp(): Promise<void> {
  const optionsJSON = await authFetch<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/step-up/options", {
    method: "POST",
  });
  const response = await startAuthentication({ optionsJSON });
  await authFetch("/step-up/verify", { method: "POST", body: { response } });
}

/** Runs a sensitive action, prompting for step-up once if the server asks. */
export async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (e) {
    if (e instanceof AuthError && e.stepUp) {
      await stepUp();
      return action();
    }
    throw e;
  }
}

export const removePasskey = (id: string) =>
  withStepUp(() => authFetch<void>(`/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }));

export const regenerateRecoveryCodes = () =>
  withStepUp(() => authFetch<{ recovery_codes: string[] }>("/recovery-codes", { method: "POST" }));

export const createAccountKey = (body: { name: string; scopes?: string[] }) =>
  withStepUp(() => authFetch<{ key: string }>("/api-keys", { method: "POST", body }));
