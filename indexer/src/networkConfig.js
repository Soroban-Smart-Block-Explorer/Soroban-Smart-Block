/**
 * Multi-network configuration
 *
 * Defines RPC, Horizon, and contract IDs per network (testnet/mainnet/futurenet).
 * Environment variables can override per-network settings:
 *   NETWORK=testnet — indexer instance network (default)
 *   TESTNET_SOROBAN_RPC_URL — override testnet RPC
 *   MAINNET_SOROBAN_RPC_URL — override mainnet RPC
 *   etc.
 */

export const NETWORKS = {
  testnet: "testnet",
  mainnet: "mainnet",
  futurenet: "futurenet",
};

export const NETWORK_NAMES = Object.values(NETWORKS);

/**
 * Default network endpoints — can be overridden via environment
 */
const DEFAULT_ENDPOINTS = {
  testnet: {
    soroban_rpc: "https://soroban-testnet.stellar.org",
    horizon: "https://horizon-testnet.stellar.org",
    network_passphrase: "Test SDF Network ; September 2015",
    explorer_contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  },
  mainnet: {
    soroban_rpc: "https://soroban-mainnet.stellar.org",
    horizon: "https://horizon.stellar.org",
    network_passphrase: "Public Global Stellar Network ; September 2015",
    explorer_contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  },
  futurenet: {
    soroban_rpc: "https://soroban-futurenet.stellar.org",
    horizon: "https://horizon-futurenet.stellar.org",
    network_passphrase: "Test SDF Future Network ; October 2022",
    explorer_contract_id: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  },
};

/**
 * Get configuration for a specific network, with environment overrides.
 * @param {string} network - 'testnet', 'mainnet', or 'futurenet'
 * @returns {object} network configuration
 */
export function getNetworkConfig(network) {
  if (!NETWORK_NAMES.includes(network)) {
    throw new Error(`Invalid network: ${network}. Must be one of: ${NETWORK_NAMES.join(", ")}`);
  }

  const defaults = DEFAULT_ENDPOINTS[network];
  const prefix = network.toUpperCase();

  return {
    name: network,
    soroban_rpc: process.env[`${prefix}_SOROBAN_RPC_URL`] || defaults.soroban_rpc,
    horizon: process.env[`${prefix}_HORIZON_URL`] || defaults.horizon,
    network_passphrase: process.env[`${prefix}_NETWORK_PASSPHRASE`] || defaults.network_passphrase,
    explorer_contract_id: process.env[`${prefix}_EXPLORER_CONTRACT_ID`] || defaults.explorer_contract_id,
  };
}

/**
 * Get the current indexer network (from NETWORK env var, default: testnet)
 * @returns {string} network name
 */
export function getIndexerNetwork() {
  const network = (process.env.NETWORK || "testnet").toLowerCase();
  if (!NETWORK_NAMES.includes(network)) {
    throw new Error(
      `Invalid NETWORK env var: ${network}. Must be one of: ${NETWORK_NAMES.join(", ")}`
    );
  }
  return network;
}

/**
 * Get all network configurations
 * @returns {object} map of network -> config
 */
export function getAllNetworkConfigs() {
  return Object.fromEntries(
    NETWORK_NAMES.map((network) => [network, getNetworkConfig(network)])
  );
}
