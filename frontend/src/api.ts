import { BatchCall } from "./types/batch";

const BASE = "/api";

export interface SpecType {
  kind: "struct" | "enum" | "union" | "error_enum";
  name: string;
  fields?: { name: string; type: string }[];
  cases?: { name: string; value?: number; types?: string[] }[];
}

export interface StorageWrite {
  tier: "instance" | "persistent" | "temporary";
  contractId: string;
  key: string;
  changeType: "created" | "updated";
}

export interface StorageTiers {
  instance: StorageWrite[];
  persistent: StorageWrite[];
  temporary: StorageWrite[];
}

export interface FeeBumpInfo {
  /** Outer fee-bump feeSource — pays the network fee. */
  sponsor: string;
  /** Inner transaction source account (channel account — provides sequence number for parallel execution). */
  inner_source: string;
  /** Actual signing identity from Soroban auth credentials (who authorised the contract logic). */
  actual_caller: string | null;
}

// Factory deployment tracking
export interface FactoryDeploymentContract {
  contractId: string;
  wasmHash: string | null;
  deploymentMethod: string;
  index: number;
}

export interface FactoryDeploymentTree {
  factoryContractId: string | null;
  contracts: FactoryDeploymentContract[];
}

// CAP-0080 ZK host function types
export interface ZkHostCall {
  fn_name: string;
  curve: "BN254" | "BLS12-381";
  kind: "msm" | "pairing" | "scalar_field" | "map_to_curve" | "hash_to_curve" | "other";
  cpu_native: number;
  cpu_legacy: number;
}

export interface ZkCostDelta {
  total_native: number;
  total_legacy: number;
  saved_cpu: number;
  saved_pct: number;
}

export interface HeuristicParam {
  index: number;
  raw: string;
  type: "Address" | "ContractId" | "Amount" | "Hash" | "Symbol" | "Boolean" | "Unknown";
  value: string;
  confidence: "likely" | "possible";
}

export interface DecodedEvent {
  seq: number;
  contract_id: string;
  function: string;
  ledger: number;
  description: string;
  raw_topics: string[];
  tx_hash?: string;
  // Soroban resource gas costs
  cpu_instructions?: number;
  mem_bytes?: number;
  fee_charged?: number;
  // state-bloat risk
  is_high_bloat_risk?: boolean;
  // upgrade lineage
  upgrade_info?: { type: "upgrade"; oldHash: string; newHash: string };
  // storage tier breakdown
  storage_tiers?: StorageTiers;
  // clawback compliance flag
  is_clawback?: boolean;
  // AMM swap path hops ["10 USDC", "9.1 EURC", "5.2 XLM"]
  swap_path?: string[];
  // Protocol 26: TTL extension host function data
  ttl_extension?: {
    fn_name: string | null;
    extend_to: number | null;
    min_extension: number | null;
    max_extension: number | null;
  };
  // fee-bump chain of custody
  fee_bump?: FeeBumpInfo | null;
  // state archival / restoration info (RestoreFootprintOp)
  archival_info?: {
    isRestoreOp: boolean;
    revivedKeys: {
      type: string;
      label: string;
      contractId?: string;
      wasmHash?: string;
      dataKey?: string;
      durability?: string;
    }[];
    keyCount: number;
    feePaid: number | null;
  } | null;
  // CAP-0080 ZK host function telemetry (Protocol 26)
  zk_host_calls?: { calls: ZkHostCall[]; delta: ZkCostDelta | null };
  // Heuristic fallback params: present when no ABI is registered
  heuristic_params?: HeuristicParam[];
  // SAC implicit side-effect (auto-created account or trustline)
  sac_side_effect?: "account_created" | "trustline_opened";
  // Factory deployment trace
  factory_deployment?: FactoryDeploymentTree;
}

export interface SourceFile {
  path: string;
  content: string;
}

export interface MigrationStatus {
  pending: boolean;
  upgradedAtLedger: number | null;
  migratedAtLedger: number | null;
}

export interface DependencyAdvisoryPackage {
  name: string;
  currentVersion: string;
  latestVersion: string;
  upgradeUrl: string;
}

export interface DependencyAdvisory {
  outdated: boolean;
  summary: string;
  packages: DependencyAdvisoryPackage[];
}

export interface ContractMeta {
  id: string;
  version: number;
  name: string;
  description: string;
  functions: { name: string; description: string }[];
  source?: string;
  source_file?: string;
  source_files?: SourceFile[];
  dependency_advisory?: DependencyAdvisory | null;
}

export interface ContractListItem {
  id: string;
  name: string;
  description: string;
  registered_by: string;
  has_circuit_breaker: boolean;
  is_paused: boolean;
  is_rwa: boolean;
  rwa_type: string | null;
  /** Protocol type — auto-tagged from ABI functions or set explicitly. */
  protocol_type: "token" | "dex" | "lending" | "nft" | "bridge" | "other";
  /** Whether the DB ABI has been verified against the on-chain ContractMeta. */
  is_verified: boolean;
  /** Ledger at which verification was last confirmed (null if never verified). */
  verified_ledger: number | null;
  created_at: string;
}

/** One ABI version snapshot returned by GET /api/contracts/:id/abi-history */
export interface AbiHistoryEntry {
  abi_version: number;
  functions: { name: string; description?: string; params?: { name: string; kind?: string }[] }[];
  registered_by: string;
  min_ledger: number;
  created_at: string;
}

export interface AbiHistoryResponse {
  contract_id: string;
  history: AbiHistoryEntry[];
}

export interface ContractsListResponse {
  contracts: ContractListItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export type SearchKind = "contract" | "event" | "wallet";

export interface SearchContract {
  id: string;
  name: string;
  description?: string | null;
  functions?: { name: string; description?: string }[];
  event_count: number;
}

export interface SearchWallet {
  address: string;
  event_count: number;
  first_seen_ledger: number | null;
  last_seen_ledger: number | null;
  contracts: string[];
}

export interface SearchSuggestion {
  kind: SearchKind;
  label: string;
  route: string;
  meta: Record<string, unknown>;
}

export interface SearchResponse {
  query: string;
  contracts: SearchContract[];
  events: DecodedEvent[];
  wallets: SearchWallet[];
  suggestions: SearchSuggestion[];
}

export interface BurnAlert {
  contractId: string;
  ledger: number;
  burnedPct: number;
  burnedAmount: string;
  flaggedAt: number;
}

// keyset-paginated events list response (GET /api/events)
export interface EventsPage {
  data: DecodedEvent[];
  next_cursor: number | null;
}

// paginated contract transaction response
export interface ContractTransactionsResponse {
  data: DecodedEvent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
    has_next: boolean;
  };
}

// contract dependency graph
export interface GraphNode3D {
  id: string;
  callCount: number;
}

export interface GraphLink3D {
  source: string;
  target: string;
  value: number;
}

export interface ContractGraphData {
  nodes: GraphNode3D[];
  links: GraphLink3D[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

export interface SimResult {
  success: boolean;
  returnValue?: string;
  cost?: { cpuInsns: string; memBytes: string };
  error?: string;
}

export interface PrivilegedRole {
  role: string;
  address: string;
  ledger: number | null;
  updated_at: string;
}

// // source verification signature
export interface SourceVerification {
  signer: string;
  signature: string;
  compiler_hash: string;
  wasm_hash: string;
  submitted_at: string;
}

// storage state diff entry
export interface StateDiff {
  ledger: number;
  tx_hash: string | null;
  key: string;
  tier?: string;
  old_value: string | null;
  new_value: string | null;
  change_type: "created" | "updated" | "removed";
  created_at: string;
}

// sub-invocation record
export interface SubInvocation {
  id: number;
  parent_tx_hash: string;
  depth: number;
  contract_id: string;
  function: string;
  args: unknown[] | null;
  ledger: number;
}

// transaction status
export interface TxStatusResponse {
  tx_hash: string;
  status: "pending" | "success" | "failed";
  ledger: number | null;
  error?: string | null;
}

// Live TTL status for contract instance and code entries
export interface ContractTTL {
  contract_id: string;
  current_ledger: number;
  instance: { live_until_ledger: number | null };
  code: { live_until_ledger: number | null };
}

export interface CircuitBreakerStatus {
  has_circuit_breaker: boolean;
  is_paused: boolean;
  pause_status_ledger: number | null;
}

export interface RwaMetadata {
  is_rwa: boolean;
  rwa_type: string | null;
}

export interface NetworkStatus {
  network: string;
  deployed: boolean;
  wasmHash?: string;
  balance?: string;
  error?: string;
}

export interface NetworkComparisonResult {
  contractId: string;
  statuses: NetworkStatus[];
  hasVersionMismatch: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  amount?: string;
}

export interface AddressGraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Sub-invocation filter options for the advanced search endpoint
export interface SubInvocationFilter {
  contract?: string;
  function?: string;
  depth_min?: number;
  depth_max?: number;
  gas_min?: number;
  gas_max?: number;
  date_from?: string;
  date_to?: string;
  arg_query?: string;
  has_reentrancy?: boolean;
  tx_hash?: string;
  ledger_min?: number;
  ledger_max?: number;
}

// Extended sub-invocation record with gas and reentrancy metadata
export interface SubInvocationExtended extends SubInvocation {
  cpu_instructions?: number;
  mem_bytes?: number;
  fee_charged?: number;
  has_reentrancy?: boolean;
  contract_type?: string;
}

// Aggregate analytics across all sub-invocations
export interface SubInvocationAnalytics {
  total: number;
  avg_depth: number;
  max_depth: number;
  top_contracts: { contract_id: string; call_count: number }[];
  depth_distribution: { depth: number; count: number }[];
}

// Per-transaction call-path metrics
export interface SubInvocationCallMetrics {
  tx_hash: string;
  total_calls: number;
  max_depth: number;
  unique_contracts: number;
  has_reentrancy: boolean;
  total_cpu?: number;
  total_fee?: number;
}

// Cross-transaction tree diff result
export interface TransactionTreeDiff {
  added: SubInvocationExtended[];
  removed: SubInvocationExtended[];
  changed: { a: SubInvocationExtended; b: SubInvocationExtended }[];
}

export const api = {
  events: (params: { contract?: string; fn?: string; after_seq?: number; limit?: number; type?: string }) => {
    const q = new URLSearchParams();
    if (params.contract) q.set("contract", params.contract);
    if (params.fn) q.set("fn", params.fn);
    if (params.after_seq) q.set("after_seq", String(params.after_seq));
    if (params.limit) q.set("limit", String(params.limit));
    if (params.type) q.set("type", params.type);
    return get<EventsPage>(`/events?${q}`);
  },
  event: (seq: number) => get<DecodedEvent>(`/events/${seq}`),
  search: (q: string, limit = 10) => {
    const params = new URLSearchParams();
    params.set("q", q);
    params.set("limit", String(limit));
    return get<SearchResponse>(`/search?${params}`);
  },
  zkCosts: (seq: number) => get<{ calls: ZkHostCall[]; delta: ZkCostDelta | null }>(`/events/${seq}/zk-costs`),
  contract: (id: string) => get<ContractMeta>(`/contracts/${id}`),
  listContracts: (page = 1, limit = 25, type?: string) => {
    const q = new URLSearchParams();
    q.set("page", String(page));
    q.set("limit", String(limit));
    if (type) q.set("type", type);
    return get<ContractsListResponse>(`/contracts?${q}`);
  },
  /** ABI version history — GET /api/contracts/:id/abi-history */
  abiHistory: (id: string) => get<AbiHistoryResponse>(`/contracts/${id}/abi-history`),
  burnAlerts: (contract: string) => get<BurnAlert[]>(`/burn-alerts?contract=${contract}`),
  migrationStatus: (id: string) => get<MigrationStatus>(`/contracts/${id}/migration-status`),
  wallet: (address: string) => get<DecodedEvent[]>(`/wallet/${address}`),
  roles: (id: string) => get<PrivilegedRole[]>(`/contracts/${id}/roles`),
  networkComparison: (id: string) => get<NetworkComparisonResult>(`/contracts/${id}/network-comparison`),
  addressGraph: (id: string) => get<AddressGraphData>(`/contracts/${id}/address-graph`),

  // sub-invocations for a transaction
  subInvocations: (txHash: string) => get<SubInvocation[]>(`/transactions/${txHash}/sub-invocations`),
  // Events where contract appears directly OR as sub-invocation
  eventsDeep: (contractId: string, page = 1) =>
    get<DecodedEvent[]>(`/v1/contracts/${contractId}/events-deep?page=${page}`),

  // transaction status (polling fallback; SSE via useTxStatus hook)
  txStatus: (txHash: string) => get<TxStatusResponse>(`/transactions/${txHash}/status`),

  // Circuit breaker status
  circuitBreakerStatus: (id: string) => get<CircuitBreakerStatus>(`/contracts/${id}/circuit-breaker`),

  // RWA token metadata
  rwaMetadata: (id: string) => get<RwaMetadata>(`/contracts/${id}/rwa-metadata`),

  downloadAbi: async (id: string) => {
    const res = await fetch(`${BASE}/contracts/${id}/abi`);
    if (!res.ok) throw new Error(`API ${res.status}: /contracts/${id}/abi`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}.abi.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  // multi-sig source verification
  sourceVerifications: (id: string, wasmHash?: string) => {
    const q = wasmHash ? `?wasm_hash=${encodeURIComponent(wasmHash)}` : "";
    return get<SourceVerification[]>(`/contracts/${id}/source-verifications${q}`);
  },
  submitSourceVerification: (
    id: string,
    body: {
      wasm_hash: string;
      signer: string;
      signature: string;
      compiler_hash: string;
    },
  ) =>
    fetch(`${BASE}/contracts/${id}/source-verifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => {
      if (!r.ok) throw new Error(`API ${r.status}`);
      return r.json();
    }),

  // live TTL status (instance + code expiration ledgers)
  contractTTL: (id: string) => get<ContractTTL>(`/contracts/${id}/ttl`),

  // state-diff timeline
  stateDiffs: (id: string, key?: string) => {
    const q = key ? `?key=${encodeURIComponent(key)}` : "";
    return get<StateDiff[]>(`/contracts/${id}/state-diffs${q}`);
  },

  // global contract dependency graph
  contractGraph: (limit = 500) => get<ContractGraphData>(`/contract-graph?limit=${limit}`),

  // CAP-0077 quorum freeze status
  quorumFreeze: (id: string) =>
    get<{
      is_frozen: boolean;
      ledger: number;
      tx_hash: string;
      frozen_ids: string[];
    }>(`/contracts/${id}/quorum-freeze`),

  // Full contract spec (functions + custom types)
  specFull: (id: string) =>
    get<{
      functions: { name: string; outputs?: string[] }[];
      types: SpecType[];
    }>(`/contracts/${id}/spec-full`),

  // Batch Multi-Call endpoints
  batchSimulate: (calls: BatchCall[], sourceAccount?: string) =>
    fetch(`${BASE}/batch/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, sourceAccount }),
    }).then((r) => r.json()),
  batchEstimateGas: (calls: BatchCall[], sourceAccount?: string) =>
    fetch(`${BASE}/batch/estimate-gas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, sourceAccount }),
    }).then((r) => r.json()),
  batchOptimize: (calls: BatchCall[], sourceAccount?: string) =>
    fetch(`${BASE}/batch/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, sourceAccount }),
    }).then((r) => r.json()),
  batchValidate: (calls: BatchCall[], sourceAccount?: string) =>
    fetch(`${BASE}/batch/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calls, sourceAccount }),
    }).then((r) => r.json()),

  // Batch types export
  exportBatchAsHardhat: (calls: BatchCall[]) => {
    const lines = [
      "// Generated Hardhat script for Soroban batch calls",
      "const { Server, Contract, TransactionBuilder, Networks, nativeToScVal } = require('@stellar/stellar-sdk');",
      "",
      "async function main() {",
      "  const server = new Server(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org');",
      "  const source = process.env.SOROBAN_SOURCE || 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';",
      "  const account = await server.getAccount(source);",
      "",
      ...calls.flatMap((call, i) => [
        `  const op${i + 1} = new Contract('${call.contractId}').call(`,
        `    '${call.functionName}'${call.args.length ? "," : ""}`,
        ...(call.args.length
          ? call.args.map(
              (arg) =>
                `    nativeToScVal(${JSON.stringify(arg.value)}${arg.type ? `, { type: '${arg.type}' }` : ""}),`,
            )
          : []),
        "  );",
        "",
      ]),
      "  const tx = new TransactionBuilder(account, {",
      "    fee: '100',",
      "    networkPassphrase: Networks.TESTNET,",
      "  })",
      ...calls.map((_, i) => `    .addOperation(op${i + 1})`),
      "      .setTimeout(30)",
      "      .build();",
      "",
      "  const simulation = await server.simulateTransaction(tx);",
      "  console.log(simulation);",
      "}",
      "",
      "main().catch(console.error);",
    ];
    return lines.join("\n");
  },
  exportBatchAsCurl: (calls: BatchCall[], sourceAccount?: string) =>
    JSON.stringify(
      {
        calls,
        sourceAccount,
      },
      null,
      2,
    ),
  exportBatchAsGraphQL: () =>
    [
      "mutation SimulateBatch($calls: [BatchCallInput!]!, $sourceAccount: String) {",
      "  simulateBatch(calls: $calls, sourceAccount: $sourceAccount) {",
      "    success",
      "    results { callId success returnValue error }",
      "    totalGas { cpuInsns memBytes fee }",
      "  }",
      "}",
    ].join("\n"),
  exportBatchAsJson: (calls: BatchCall[], sourceAccount?: string) =>
    JSON.stringify(
      {
        calls,
        sourceAccount,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),

  // Issue #210: Sub-invocation search with 8+ filter types
  searchSubInvocations: (filter: SubInvocationFilter) => {
    const q = new URLSearchParams();
    if (filter.contract) q.set("contract", filter.contract);
    if (filter.depth_min != null) q.set("depth_min", String(filter.depth_min));
    if (filter.depth_max != null) q.set("depth_max", String(filter.depth_max));
    if (filter.gas_min != null) q.set("gas_min", String(filter.gas_min));
    if (filter.gas_max != null) q.set("gas_max", String(filter.gas_max));
    if (filter.function) q.set("function", filter.function);
    if (filter.date_from) q.set("date_from", filter.date_from);
    if (filter.date_to) q.set("date_to", filter.date_to);
    if (filter.arg_query) q.set("arg_query", filter.arg_query);
    if (filter.has_reentrancy != null) q.set("has_reentrancy", String(filter.has_reentrancy));
    if (filter.tx_hash) q.set("tx_hash", filter.tx_hash);
    if (filter.ledger_min != null) q.set("ledger_min", String(filter.ledger_min));
    if (filter.ledger_max != null) q.set("ledger_max", String(filter.ledger_max));
    return get<SubInvocationExtended[]>(`/sub-invocations/search?${q}`);
  },

  // Issue #210: Global analytics for sub-invocations
  subInvocationAnalytics: () => get<SubInvocationAnalytics>(`/sub-invocations/analytics`),

  // Issue #210: Call-path metrics for a single transaction (6 analytical metrics)
  callPathMetrics: (txHash: string) =>
    get<SubInvocationCallMetrics>(`/transactions/${txHash}/call-path-metrics`),

  // Issue #210: Cross-transaction tree diff
  compareTransactionTrees: (txA: string, txB: string) =>
    get<TransactionTreeDiff>(
      `/transactions/compare?a=${encodeURIComponent(txA)}&b=${encodeURIComponent(txB)}`,
    ),

  // Issue #210: SSE stream URL builder for live sub-invocation feed
  subInvocationStreamUrl: (filter?: Pick<SubInvocationFilter, "contract" | "function">) => {
    const q = new URLSearchParams();
    if (filter?.contract) q.set("contract", filter.contract);
    if (filter?.function) q.set("function", filter.function);
    return `${BASE}/sub-invocations/stream?${q}`;
  },
};
