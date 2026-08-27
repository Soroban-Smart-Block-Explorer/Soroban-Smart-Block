export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

export interface DecodedEvent {
  seq: number;
  contract_id: string;
  function: string;
  ledger: number;
  description: string;
  raw_topics: string[];
  tx_hash?: string;
  cpu_instructions?: number;
  mem_bytes?: number;
  fee_charged?: number;
  is_high_bloat_risk?: boolean;
  is_clawback?: boolean;
}

export interface EventsPage {
  data: DecodedEvent[];
  next_cursor: number | null;
}

export interface EventsParams {
  contract?: string;
  fn?: string;
  type?: string;
  after_seq?: number;
  limit?: number;
}

export interface SearchResult {
  query: string;
  contracts: Record<string, unknown>[];
  events: DecodedEvent[];
  wallets: Record<string, unknown>[];
  suggestions: Record<string, unknown>[];
}

export interface ContractMeta {
  id: string;
  version: number;
  name: string;
  description: string;
  functions: { name: string; description: string }[];
}

export interface ContractsListResponse {
  contracts: Record<string, unknown>[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export interface WalletResponse {
  events: DecodedEvent[];
}

export interface ExplorerClient {
  events(params?: EventsParams): Promise<EventsPage>;
  event(seq: number): Promise<DecodedEvent>;
  search(query: string, limit?: number): Promise<SearchResult>;
  contract(id: string): Promise<ContractMeta>;
  listContracts(page?: number, limit?: number): Promise<ContractsListResponse>;
  wallet(address: string): Promise<WalletResponse>;
  stats(): Promise<{ events: number; contracts: number }>;
  contractAbi(id: string): Promise<object>;
}

export function createClient(opts?: ClientOptions): ExplorerClient;