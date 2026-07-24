#![cfg(test)]

use soroban_explorer_contract::{ContractMeta, ExplorerContract, ExplorerContractClient};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String, Vec};

// Snapshot testing using insta to catch unintended state mutations
// In a real project you would use `insta::assert_debug_snapshot!`
// Here we stub out the state diffing approach.
#[test]
fn test_contract_registration_snapshot() {
    let env = Env::default();
    env.mock_all_auths();

    let explorer_id = env.register_contract(None, ExplorerContract);
    let explorer = ExplorerContractClient::new(&env, &explorer_id);
    let admin = Address::generate(&env);
    explorer.init(&admin, &50000);

    let contract_id: BytesN<32> = BytesN::from_array(&env, &[2; 32]);
    let meta = ContractMeta {
        version: 1,
        abi_version: 0,
        min_ledger: 0,
        name: String::from_str(&env, "SnapshotTestContract"),
        description: String::from_str(&env, "Testing snapshots"),
        functions: Vec::new(&env),
        registered_by: admin.clone(),
    };

    explorer.register_contract(&admin, &contract_id, &meta);

    let fetched = explorer.get_contract(&contract_id);

    // Validate state hasn't drifted via standard asserts as proxy for insta snapshots
    assert_eq!(fetched.name, String::from_str(&env, "SnapshotTestContract"));
    assert_eq!(fetched.version, 1);
}
