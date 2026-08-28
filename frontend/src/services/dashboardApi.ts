/**
 * Client for the self-service developer dashboard endpoints
 * (/api/dashboard/*, /api/webhooks/*), authenticated via an API key the user
 * pastes in once and this stores in localStorage (see also RateLimitDashboard.tsx,
 * which uses the same "paste a secret, gate the page" shape but with an admin
 * bearer token in sessionStorage).
 *
 * These routes are exempt from CSRF checking server-side whenever an
 * x-api-key header is present (indexer/src/csrf.js), so — unlike api.ts's
 * mutationFetch — no CSRF token needs to be attached here.
 */

const BASE = "/api";
const STORAGE_KEY = "sb-dashboard-api-key";

export function getStoredApiKey(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredApiKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // localStorage unavailable — ignore
  }
}

export function clearStoredApiKey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const apiKey = getStoredApiKey();
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body — keep default message
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  email: string | null;
  key_prefix: string;
  tier: string;
  rate_limit: number | null;
  daily_limit: number | null;
  expires_at: string | null;
  revoked: boolean;
  last_used_at: string | null;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface UsageStats {
  today: number;
  this_month: number;
  limit_daily: number;
  events_received: number;
}

export interface WebhookSubscription {
  id: string;
  api_key_id: string;
  url: string;
  contract_id: string | null;
  function_filter: string | null;
  active: boolean;
  failure_count: number;
  created_at: string;
  last_triggered_at: string | null;
}

export interface WebhookDelivery {
  id: number;
  webhook_id: string;
  event_seq: number | null;
  url: string;
  response_status: number | null;
  response_body: string | null;
  duration_ms: number | null;
  delivered_at: string | null;
  created_at: string;
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; total_pages: number };
}

export const dashboardApi = {
  me: () => request<ApiKeyRecord & { usage: UsageStats }>("/dashboard/me"),

  listApiKeys: () => request<{ data: ApiKeyRecord[] }>("/dashboard/api-keys").then((r) => r.data),

  createApiKey: (body: { name: string; tier?: string; rate_limit?: number; expires_at?: string }) =>
    request<{ key: string; record: ApiKeyRecord }>("/dashboard/api-keys", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  rotateApiKey: (id: string) =>
    request<{ key: string; record: ApiKeyRecord }>(`/dashboard/api-keys/${id}/rotate`, { method: "POST" }),

  revokeApiKey: (id: string) => request<void>(`/dashboard/api-keys/${id}`, { method: "DELETE" }),

  apiKeyUsage: (id: string) => request<UsageStats>(`/dashboard/api-keys/${id}/usage`),

  listWebhooks: () => request<{ data: WebhookSubscription[] }>("/webhooks").then((r) => r.data),

  createWebhook: (body: { url: string; contract_id?: string | null; function_filter?: string | null }) =>
    request<WebhookSubscription & { secret: string }>("/webhooks", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteWebhook: (id: string) => request<void>(`/webhooks/${id}`, { method: "DELETE" }),

  testFireWebhook: (id: string) => request<WebhookDelivery>(`/webhooks/${id}/test`, { method: "POST" }),

  listDeliveries: (webhookId: string, page = 1, limit = 25) =>
    request<Paginated<WebhookDelivery>>(`/webhooks/${webhookId}/deliveries?page=${page}&limit=${limit}`),

  retryDelivery: (webhookId: string, deliveryId: number) =>
    request<WebhookDelivery>(`/webhooks/${webhookId}/deliveries/${deliveryId}/retry`, { method: "POST" }),
};
