// ── Core entities ──────────────────────────────────────────────────────────────

/** A decoded on-chain event from the indexer. */
export interface DecodedEvent {
  seq: number;
  ledger: number;
  contract_id: string | null;
  function: string;
  description: string | null;
  tx_hash: string;
  raw_topics: unknown[];
  raw_data: string | null;
  type: "soroban" | "classic";
  cpu_instructions: number | null;
  mem_bytes: number | null;
  fee_charged: number | null;
  is_high_bloat_risk: boolean;
  is_clawback: boolean;
  footprint_contention: boolean;
  upgrade_info: UpgradeInfo | null;
  storage_tiers: StorageTiers | null;
  ttl_extension: unknown | null;
  fee_bump: unknown | null;
  archival_info: unknown | null;
  zk_host_calls: unknown | null;
  abi_version: number;
  slippage_bps: number | null;
  created_at: string;
}

export interface UpgradeInfo {
  oldHash: string | null;
  newHash: string | null;
}

export interface StorageTiers {
  temporary?: number;
  persistent?: number;
  instance?: number;
}

/** A registered contract in the explorer. */
export interface Contract {
  id: string;
  name: string;
  description: string;
  registered_by: string;
  has_circuit_breaker: boolean;
  is_paused: boolean;
  is_rwa: boolean;
  rwa_type: string | null;
  protocol_type: string | null;
  created_at: string;
}

/** Full contract metadata including ABI and dependency advisory. */
export interface ContractMeta extends Contract {
  functions: FunctionAbi[];
  source_files: unknown[];
  version: number;
  abi_version: number;
  min_ledger: number;
  dependency_advisory: DependencyAdvisory;
}

export interface FunctionAbi {
  name: string;
  description: string;
  params: ParamDef[];
}

export interface ParamDef {
  name: string;
  kind: string;
}

export interface DependencyAdvisory {
  crates: CrateAdvisory[];
}

export interface CrateAdvisory {
  name: string;
  version: string;
  advisories: string[];
}

// ── Pagination ─────────────────────────────────────────────────────────────────

/** Cursor-based paginated response (used by /api/events). */
export interface CursorPage<T> {
  data: T[];
  next_cursor: number | null;
}

/** Offset-based paginated response. */
export interface PaginatedResponse<T> {
  contracts: T[];
  pagination: PageInfo;
}

export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

/** Contract events paginated response. */
export interface ContractEventsResponse {
  events: DecodedEvent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
}

// ── Contract sub-resources ─────────────────────────────────────────────────────

export interface ContractStats {
  total_events: number;
  unique_callers: number;
  first_seen_ledger: number | null;
  last_seen_ledger: number | null;
  events_per_day: DailyCount[];
}

export interface DailyCount {
  date: string;
  count: number;
}

export interface AbiHistoryEntry {
  abi_version: number;
  functions: FunctionAbi[];
  min_ledger: number;
  created_at: string;
}

export interface AbiHistoryResponse {
  contract_id: string;
  history: AbiHistoryEntry[];
}

export interface UpgradeEntry {
  ledger: number;
  old_hash: string | null;
  new_hash: string | null;
  tx_hash: string;
  timestamp: string;
}

export interface ContractTtl {
  contract_id: string;
  current_ledger: number;
  instance: { live_until_ledger: number | null };
  code: { live_until_ledger: number | null };
}

export interface CallGraphNode {
  id: string;
  label: string;
  type: string;
}

export interface CallGraphEdge {
  source: string;
  target: string;
  label: string;
  call_count: number;
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}

export interface ContractStorageTiers {
  temporary: number;
  persistent: number;
  instance: number;
}

// ── Wallet ─────────────────────────────────────────────────────────────────────

export interface HorizonAccount {
  sequence: string;
  subentry_count: number;
  home_domain: string | null;
}

export interface WalletResponse {
  events: DecodedEvent[];
  horizon_account: HorizonAccount | null;
}

export interface Balance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

export interface BalancesResponse {
  balances: Balance[];
}

// ── Search ─────────────────────────────────────────────────────────────────────

export interface SearchSuggestion {
  kind: "contract" | "event" | "wallet";
  label: string;
  route: string;
  meta: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  contracts: Contract[];
  events: DecodedEvent[];
  wallets: WalletSearchResult[];
  suggestions: SearchSuggestion[];
}

export interface WalletSearchResult {
  address: string;
  event_count: number;
  first_seen_ledger: number | null;
  last_seen_ledger: number | null;
  contracts: string[];
}

// ── Tokens ─────────────────────────────────────────────────────────────────────

export interface TokenHolder {
  address: string;
  balance_raw: string;
  balance: string;
}

export interface TokenHoldersResponse {
  contract_id: string;
  decimals: number;
  total_holders: number;
  holders: TokenHolder[];
}

export interface TokenVolume {
  contract_id: string;
  window: string;
  volume_raw: string;
  volume_scaled: string;
  decimals: number;
}

// ── Global ─────────────────────────────────────────────────────────────────────

export interface GlobalStats {
  events: number;
  contracts: number;
}

export interface HealthDependency {
  status: string;
  latency_ms?: number;
  error?: string;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  uptime_seconds?: number;
  dependencies?: Record<string, HealthDependency>;
  alerts?: {
    active_count: number;
    conditions: string[];
  };
}

// ── Filter parameters ──────────────────────────────────────────────────────────

export interface EventsFilter {
  /** Filter by contract ID. */
  contract?: string;
  /** Filter by function name (comma-separated for multiple). */
  fn?: string;
  /** Filter by transaction type. */
  type?: "soroban" | "classic";
  /** Cursor from previous page's next_cursor. */
  after_seq?: number;
  /** Max items per page (1–200, default 25). */
  limit?: number;
}

export interface ContractsFilter {
  page?: number;
  limit?: number;
  /** Filter by protocol type. */
  type?: string;
  /** Search query string. */
  q?: string;
}

export interface ContractEventsFilter {
  page?: number;
  limit?: number;
}

export interface WalletEventsFilter {
  /** Comma-separated event-type categories: transfer,swap,mint,burn,stake,other */
  fn?: string;
  /** Start date YYYY-MM-DD */
  from?: string;
  /** End date YYYY-MM-DD */
  to?: string;
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

export type WebSocketMessageType = "connected" | "event" | "vault_ratio" | "contract_link";

export interface WebSocketMessage<T = unknown> {
  type: WebSocketMessageType;
  data?: T;
  message?: string;
}

export interface SubscribeOptions {
  /** API key for authenticated connections. */
  apiKey?: string;
  /** Max reconnect attempts (default: Infinity). */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay in ms (default: 1000). */
  reconnectDelay?: number;
  /** Maximum reconnect delay in ms (default: 30000). */
  maxReconnectDelay?: number;
  /** Called when the WebSocket reconnects after a disconnect. */
  onReconnect?: () => void;
  /** Called when the WebSocket disconnects. */
  onDisconnect?: (event: unknown) => void;
  /** Called on WebSocket errors. */
  onError?: (error: unknown) => void;
}

export interface Subscription {
  /** Close the WebSocket and stop reconnecting. */
  unsubscribe(): void;
}
