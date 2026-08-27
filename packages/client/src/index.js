/**
 * @soroban-explorer/client
 *
 * Lightweight JavaScript client for the Soroban Smart Block Explorer API.
 * Works in Node.js 18+ and modern browsers.
 *
 * @example
 * ```js
 * import { createClient } from "@soroban-explorer/client";
 * const explorer = createClient({ baseUrl: "https://explorer.soroban.org" });
 * const events = await explorer.events({ contract: "CDA2...", limit: 5 });
 * ```
 */

/**
 * @typedef {object} ClientOptions
 * @property {string} [baseUrl="http://localhost:3001"] - Base URL of the explorer API.
 * @property {string} [apiKey] - API key for authenticated endpoints.
 * @property {(url: string, init?: RequestInit) => Promise<Response>} [fetch] -
 *   Custom fetch implementation (e.g. for Node.js where global fetch may not exist).
 */

/**
 * @typedef {object} DecodedEvent
 * @property {number} seq
 * @property {string} contract_id
 * @property {string} function
 * @property {number} ledger
 * @property {string} description
 * @property {string[]} raw_topics
 * @property {string} [tx_hash]
 * @property {number} [cpu_instructions]
 * @property {number} [mem_bytes]
 * @property {number} [fee_charged]
 * @property {boolean} [is_high_bloat_risk]
 * @property {boolean} [is_clawback]
 */

/**
 * @typedef {object} EventsPage
 * @property {DecodedEvent[]} data
 * @property {number|null} next_cursor
 */

/**
 * @typedef {object} EventsParams
 * @property {string} [contract]
 * @property {string} [fn]
 * @property {string} [type]
 * @property {number} [after_seq]
 * @property {number} [limit]
 */

/**
 * @typedef {object} SearchResult
 * @property {string} query
 * @property {object[]} contracts
 * @property {DecodedEvent[]} events
 * @property {object[]} wallets
 * @property {object[]} suggestions
 */

/**
 * @typedef {object} ContractMeta
 * @property {string} id
 * @property {number} version
 * @property {string} name
 * @property {string} description
 * @property {{name: string, description: string}[]} functions
 */

/**
 * @typedef {object} ContractsListResponse
 * @property {object[]} contracts
 * @property {object} pagination
 */

/**
 * @typedef {object} WalletResponse
 * @property {DecodedEvent[]} events
 */

/**
 * Create a Soroban Explorer API client.
 *
 * @param {ClientOptions} [opts]
 * @returns {ExplorerClient}
 */
export function createClient(opts = {}) {
  const baseUrl = opts.baseUrl ?? "http://localhost:3001";
  const apiKey = opts.apiKey;
  const customFetch = opts.fetch ?? fetch;

  /** @param {string} path @param {RequestInit} [init] */
  async function request(path, init = {}) {
    const headers = { ...init.headers };
    if (apiKey) headers["x-api-key"] = apiKey;
    if (!headers["Content-Type"] && init.method && init.method !== "GET") {
      headers["Content-Type"] = "application/json";
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/api${path}`;
    const res = await customFetch(url, { ...init, headers });

    if (!res.ok) {
      const body = await res.text();
      let message;
      try {
        const parsed = JSON.parse(body);
        message = parsed.error || body;
      } catch {
        message = body || `HTTP ${res.status}`;
      }
      throw new Error(message);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    /**
     * Fetch paginated events.
     * @param {EventsParams} [params]
     * @returns {Promise<EventsPage>}
     */
    async events(params = {}) {
      const q = new URLSearchParams();
      if (params.contract) q.set("contract", params.contract);
      if (params.fn) q.set("fn", params.fn);
      if (params.type) q.set("type", params.type);
      if (params.after_seq) q.set("after_seq", String(params.after_seq));
      if (params.limit) q.set("limit", String(params.limit));
      return request(`/events?${q}`);
    },

    /**
     * Fetch a single event by sequence number.
     * @param {number} seq
     * @returns {Promise<DecodedEvent>}
     */
    async event(seq) {
      return request(`/events/${seq}`);
    },

    /**
     * Search across contracts, events, and wallets.
     * @param {string} query
     * @param {number} [limit=10]
     * @returns {Promise<SearchResult>}
     */
    async search(query, limit = 10) {
      const q = new URLSearchParams();
      q.set("q", query);
      q.set("limit", String(limit));
      return request(`/search?${q}`);
    },

    /**
     * Get contract metadata.
     * @param {string} id - Contract ID.
     * @returns {Promise<ContractMeta>}
     */
    async contract(id) {
      return request(`/contracts/${id}`);
    },

    /**
     * List registered contracts.
     * @param {number} [page=1]
     * @param {number} [limit=25]
     * @returns {Promise<ContractsListResponse>}
     */
    async listContracts(page = 1, limit = 25) {
      const q = new URLSearchParams();
      q.set("page", String(page));
      q.set("limit", String(limit));
      return request(`/contracts?${q}`);
    },

    /**
     * Get events for a wallet address.
     * @param {string} address - Stellar public key (starts with G).
     * @returns {Promise<WalletResponse>}
     */
    async wallet(address) {
      return request(`/wallet/${address}`);
    },

    /**
     * Get aggregate stats.
     * @returns {Promise<{events: number, contracts: number}>}
     */
    async stats() {
      return request("/stats");
    },

    /**
     * Get contract ABI JSON.
     * @param {string} id
     * @returns {Promise<object>}
     */
    async contractAbi(id) {
      return request(`/contracts/${id}/abi`);
    },
  };
}