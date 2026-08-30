import { describe, it, expect } from '@jest/globals';
import { NETWORKS, NETWORK_NAMES, getNetworkConfig, getIndexerNetwork, getAllNetworkConfigs } from '../src/networkConfig.js';
import { networkScope, networkScopeParam, assertNetworkMatch } from '../src/networkAware.js';

describe('Network Configuration', () => {
  it('should define all networks', () => {
    expect(NETWORKS).toEqual({
      testnet: 'testnet',
      mainnet: 'mainnet',
      futurenet: 'futurenet',
    });
    expect(NETWORK_NAMES).toHaveLength(3);
  });

  it('should get network config with defaults', () => {
    const config = getNetworkConfig('testnet');
    expect(config.name).toBe('testnet');
    expect(config.soroban_rpc).toMatch(/soroban-testnet/);
    expect(config.horizon).toMatch(/horizon-testnet/);
    expect(config.network_passphrase).toMatch(/Test SDF Network/);
  });

  it('should get mainnet config', () => {
    const config = getNetworkConfig('mainnet');
    expect(config.name).toBe('mainnet');
    expect(config.soroban_rpc).toMatch(/soroban-mainnet/);
    expect(config.horizon).toMatch(/horizon\.stellar\.org/);
    expect(config.network_passphrase).toMatch(/Public Global Stellar Network/);
  });

  it('should get futurenet config', () => {
    const config = getNetworkConfig('futurenet');
    expect(config.name).toBe('futurenet');
    expect(config.soroban_rpc).toMatch(/soroban-futurenet/);
    expect(config.network_passphrase).toMatch(/Future Network/);
  });

  it('should reject invalid networks', () => {
    expect(() => getNetworkConfig('invalid')).toThrow(/Invalid network/);
  });

  it('should get all network configs', () => {
    const allConfigs = getAllNetworkConfigs();
    expect(Object.keys(allConfigs)).toHaveLength(3);
    expect(allConfigs.testnet).toBeDefined();
    expect(allConfigs.mainnet).toBeDefined();
    expect(allConfigs.futurenet).toBeDefined();
  });

  it('should get indexer network from env or default', () => {
    const network = getIndexerNetwork();
    expect(NETWORK_NAMES).toContain(network);
  });
});

describe('Network Aware Helpers', () => {
  it('should generate SQL scope without alias', () => {
    const scope = networkScope('testnet');
    expect(scope).toBe("network = 'testnet'");
  });

  it('should generate SQL scope with alias', () => {
    const scope = networkScope('mainnet', 'e');
    expect(scope).toBe("e.network = 'mainnet'");
  });

  it('should generate parameterized SQL scope', () => {
    const { sql, params } = networkScopeParam('testnet', []);
    expect(sql).toBe('network = $1');
    expect(params).toEqual(['testnet']);
  });

  it('should generate parameterized SQL scope with existing params', () => {
    const { sql, params } = networkScopeParam('testnet', ['contract1'], 'e');
    expect(sql).toBe('e.network = $2');
    expect(params).toEqual(['contract1', 'testnet']);
  });

  it('should assert network match', () => {
    const obj = { network: 'testnet', id: 1 };
    expect(() => assertNetworkMatch(obj, 'testnet')).not.toThrow();
  });

  it('should throw on network mismatch', () => {
    const obj = { network: 'testnet', id: 1 };
    expect(() => assertNetworkMatch(obj, 'mainnet', 'event')).toThrow(/Network mismatch/);
  });
});

describe('Network Query Building', () => {
  it('should build event query with network filter', () => {
    // Example: SELECT * FROM events WHERE network = 'testnet' AND contract_id = 'C...'
    const network = 'testnet';
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

    const scope = networkScope(network);
    const expected = `SELECT * FROM events WHERE ${scope} AND contract_id = '${contractId}'`;

    expect(scope).toBe("network = 'testnet'");
    expect(expected).toContain("network = 'testnet'");
  });

  it('should escape single quotes in network names', () => {
    // Edge case: network name with quotes (though unlikely in practice)
    const malicious = "testnet'; DROP TABLE events; --";
    const scope = networkScope(malicious);
    expect(scope).not.toContain("'; DROP TABLE events; --");
  });
});
