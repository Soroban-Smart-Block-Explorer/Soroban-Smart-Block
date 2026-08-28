// ── Public API ─────────────────────────────────────────────────────────────────
//
// Everything re-exported here constitutes the public surface of
// @soroban-explorer/client.

export { SorobanExplorerClient } from "./client.js";
export type { ClientOptions } from "./client.js";

export { subscribeEvents } from "./ws.js";

export {
  SorobanExplorerError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  UnauthorizedError,
} from "./errors.js";

export type {
  // Core entities
  DecodedEvent,
  Contract,
  ContractMeta,
  FunctionAbi,
  ParamDef,
  UpgradeInfo,
  StorageTiers,
  DependencyAdvisory,
  CrateAdvisory,

  // Pagination
  CursorPage,
  PaginatedResponse,
  PageInfo,
  ContractEventsResponse,

  // Contract sub-resources
  ContractStats,
  DailyCount,
  AbiHistoryEntry,
  AbiHistoryResponse,
  UpgradeEntry,
  ContractTtl,
  CallGraphNode,
  CallGraphEdge,
  CallGraph,
  ContractStorageTiers,

  // Wallet
  HorizonAccount,
  WalletResponse,
  Balance,
  BalancesResponse,

  // Search
  SearchSuggestion,
  SearchResponse,
  WalletSearchResult,

  // Tokens
  TokenHolder,
  TokenHoldersResponse,
  TokenVolume,

  // Global
  GlobalStats,
  HealthStatus,
  HealthDependency,

  // Filter parameters
  EventsFilter,
  ContractsFilter,
  ContractEventsFilter,
  WalletEventsFilter,

  // WebSocket
  WebSocketMessage,
  WebSocketMessageType,
  SubscribeOptions,
  Subscription,
} from "./types.js";
