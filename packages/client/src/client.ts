import {
  SorobanExplorerError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  UnauthorizedError,
} from "./errors.js";
import { subscribeEvents } from "./ws.js";
import type {
  DecodedEvent,
  Contract,
  ContractMeta,
  ContractStats,
  ContractTtl,
  ContractStorageTiers,
  ContractEventsResponse,
  CursorPage,
  PaginatedResponse,
  AbiHistoryResponse,
  UpgradeEntry,
  CallGraph,
  WalletResponse,
  BalancesResponse,
  SearchResponse,
  TokenHoldersResponse,
  TokenVolume,
  GlobalStats,
  HealthStatus,
  EventsFilter,
  ContractsFilter,
  ContractEventsFilter,
  WalletEventsFilter,
  SubscribeOptions,
  Subscription,
  WebSocketMessage,
} from "./types.js";

// ── Client options ─────────────────────────────────────────────────────────────

export interface ClientOptions {
  /** Base URL of the Soroban Explorer API (e.g. "https://explorer.example.com"). */
  baseUrl: string;
  /** Optional API key sent as the `x-api-key` header. */
  apiKey?: string;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function buildQuery(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

// ── Client class ───────────────────────────────────────────────────────────────

/**
 * Typed client for the Soroban Smart Block Explorer API.
 *
 * @example
 * ```ts
 * import { SorobanExplorerClient } from "@soroban-explorer/client";
 *
 * const client = new SorobanExplorerClient({
 *   baseUrl: "https://explorer-api.example.com",
 *   apiKey: "your-api-key",
 * });
 *
 * const { data, next_cursor } = await client.getEvents({ contract: "C…" });
 * ```
 */
export class SorobanExplorerClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(options: ClientOptions) {
    if (!options.baseUrl) {
      throw new Error("baseUrl is required");
    }
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this._fetch = options.fetch ?? globalThis.fetch;

    if (!this._fetch) {
      throw new Error(
        "No fetch implementation available. Pass a custom fetch function or use Node.js >= 18.",
      );
    }
  }

  // ── Internal request helper ────────────────────────────────────────────────

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    };

    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await this._fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      const message =
        (body as Record<string, unknown>).error ??
        (body as Record<string, unknown>).detail ??
        response.statusText;

      switch (response.status) {
        case 401:
          throw new UnauthorizedError(String(message), body);
        case 404:
          throw new NotFoundError(String(message), body);
        case 429: {
          const retryAfter = Number(response.headers.get("Retry-After")) || 60;
          throw new RateLimitError(String(message), body, retryAfter);
        }
        case 400:
        case 422:
          throw new ValidationError(String(message), response.status, body);
        default:
          throw new SorobanExplorerError(String(message), response.status, body);
      }
    }

    return response.json() as Promise<T>;
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
   * List decoded events with cursor-based pagination.
   *
   * @example
   * ```ts
   * const page1 = await client.getEvents({ contract: "C…", limit: 10 });
   * const page2 = await client.getEvents({ after_seq: page1.next_cursor! });
   * ```
   */
  async getEvents(filter?: EventsFilter): Promise<CursorPage<DecodedEvent>> {
    const query = buildQuery({
      contract: filter?.contract,
      fn: filter?.fn,
      type: filter?.type,
      after_seq: filter?.after_seq,
      limit: filter?.limit,
    });
    return this.request<CursorPage<DecodedEvent>>(`/api/events${query}`);
  }

  /** Get a single event by its sequence number. */
  async getEvent(seq: number): Promise<DecodedEvent> {
    return this.request<DecodedEvent>(`/api/events/${seq}`);
  }

  // ── Contracts ──────────────────────────────────────────────────────────────

  /** List registered contracts with offset-based pagination. */
  async getContracts(filter?: ContractsFilter): Promise<PaginatedResponse<Contract>> {
    const query = buildQuery({
      page: filter?.page,
      limit: filter?.limit,
      type: filter?.type,
      q: filter?.q,
    });
    return this.request<PaginatedResponse<Contract>>(`/api/contracts${query}`);
  }

  /** Get full metadata for a single contract, including its dependency advisory. */
  async getContract(id: string): Promise<ContractMeta> {
    return this.request<ContractMeta>(`/api/contracts/${encodeURIComponent(id)}`);
  }

  /** Get events for a specific contract (offset-based pagination). */
  async getContractEvents(
    id: string,
    filter?: ContractEventsFilter,
  ): Promise<ContractEventsResponse> {
    const query = buildQuery({
      page: filter?.page,
      limit: filter?.limit,
    });
    return this.request<ContractEventsResponse>(
      `/api/contracts/${encodeURIComponent(id)}/events${query}`,
    );
  }

  /** Get aggregate statistics for a contract (event counts, callers, 30-day sparkline). */
  async getContractStats(id: string): Promise<ContractStats> {
    return this.request<ContractStats>(`/api/contracts/${encodeURIComponent(id)}/stats`);
  }

  /** Get ABI version history for a contract. */
  async getContractAbiHistory(id: string): Promise<AbiHistoryResponse> {
    return this.request<AbiHistoryResponse>(
      `/api/contracts/${encodeURIComponent(id)}/abi-history`,
    );
  }

  /** Get WASM upgrade lineage for a contract. */
  async getContractUpgrades(id: string): Promise<UpgradeEntry[]> {
    return this.request<UpgradeEntry[]>(`/api/contracts/${encodeURIComponent(id)}/upgrades`);
  }

  /** Get live TTL status for a contract's instance and code entries. */
  async getContractTtl(id: string): Promise<ContractTtl> {
    return this.request<ContractTtl>(`/api/contracts/${encodeURIComponent(id)}/ttl`);
  }

  /** Get the sub-invocation call graph for a contract. */
  async getContractCallGraph(id: string, limit?: number): Promise<CallGraph> {
    const query = buildQuery({ limit });
    return this.request<CallGraph>(
      `/api/contracts/${encodeURIComponent(id)}/call-graph${query}`,
    );
  }

  /** Get storage tier write counts for a contract. */
  async getContractStorageTiers(id: string): Promise<ContractStorageTiers> {
    return this.request<ContractStorageTiers>(
      `/api/contracts/${encodeURIComponent(id)}/storage-tiers`,
    );
  }

  // ── Wallet ─────────────────────────────────────────────────────────────────

  /**
   * Get events involving a wallet address with optional category/date filters.
   *
   * @example
   * ```ts
   * const { events, horizon_account } = await client.getWalletEvents("G…", {
   *   fn: "transfer,mint",
   *   from: "2025-01-01",
   *   to: "2025-12-31",
   * });
   * ```
   */
  async getWalletEvents(
    address: string,
    filter?: WalletEventsFilter,
  ): Promise<WalletResponse> {
    const query = buildQuery({
      fn: filter?.fn,
      from: filter?.from,
      to: filter?.to,
    });
    return this.request<WalletResponse>(
      `/api/wallet/${encodeURIComponent(address)}${query}`,
    );
  }

  /** Get classic XLM + SEP-41/classic asset balances for a wallet. */
  async getWalletBalances(address: string): Promise<BalancesResponse> {
    return this.request<BalancesResponse>(
      `/api/wallet/${encodeURIComponent(address)}/balances`,
    );
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  /** Full-text search across contracts, events, and wallets. */
  async search(query: string, limit?: number): Promise<SearchResponse> {
    const qs = buildQuery({ q: query, limit });
    return this.request<SearchResponse>(`/api/search${qs}`);
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /** Get sorted list of token holders for a contract. */
  async getTokenHolders(contractId: string): Promise<TokenHoldersResponse> {
    return this.request<TokenHoldersResponse>(
      `/api/tokens/${encodeURIComponent(contractId)}/holders`,
    );
  }

  /** Get 24-hour rolling transfer volume for a token contract. */
  async getTokenVolume(contractId: string): Promise<TokenVolume> {
    return this.request<TokenVolume>(
      `/api/tokens/${encodeURIComponent(contractId)}/volume`,
    );
  }

  // ── Global ─────────────────────────────────────────────────────────────────

  /** Get global aggregate statistics (total events and contracts). */
  async getStats(): Promise<GlobalStats> {
    return this.request<GlobalStats>("/api/stats");
  }

  /** Get comprehensive health status of the API and its dependencies. */
  async getHealth(): Promise<HealthStatus> {
    return this.request<HealthStatus>("/api/health");
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  /**
   * Subscribe to live events via WebSocket with automatic reconnection.
   *
   * @example
   * ```ts
   * const sub = client.subscribeEvents(
   *   { onReconnect: () => console.log("reconnected!") },
   *   (msg) => {
   *     if (msg.type === "event") console.log("New event:", msg.data);
   *   },
   * );
   *
   * // Later…
   * sub.unsubscribe();
   * ```
   */
  subscribeEvents(
    options: Omit<SubscribeOptions, "apiKey">,
    callback: (message: WebSocketMessage) => void,
  ): Subscription {
    return subscribeEvents(
      this.baseUrl,
      { ...options, apiKey: this.apiKey },
      callback,
    );
  }
}
