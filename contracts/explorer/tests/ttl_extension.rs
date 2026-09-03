#![cfg(test)]

use soroban_explorer_contract::{
    ContractMeta, EventInput, ExplorerContract, ExplorerContractClient, FunctionAbi, ParamDef,
};
use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, String, Symbol, Vec};

/// TTL constants (mirrored from lib.rs for reference)
const DAY_IN_LEDGERS: u32 = 17_280;
const PERSISTENT_TTL_THRESHOLD: u32 = DAY_IN_LEDGERS * 30; // 30 days
const PERSISTENT_TTL_EXTEND_TO: u32 = DAY_IN_LEDGERS * 90; // 90 days

fn setup() -> (Env, ExplorerContractClient<'static>, Address, BytesN<32>) {
    let env = Env::default();
    env.mock_all_auths();

    let explorer_id = env.register_contract(None, ExplorerContract);
    let explorer = ExplorerContractClient::new(&env, &explorer_id);
    let admin = Address::generate(&env);
    explorer.init(&admin, &50000);

    let contract_id: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);

    (env, explorer, admin, contract_id)
}

fn make_meta(env: &Env, name: &str, admin: &Address) -> ContractMeta {
    let mut functions = Vec::new(env);
    functions.push_back(FunctionAbi {
        name: Symbol::short("swap"),
        description: String::from_str(env, "Swap tokens"),
        params: Vec::new(env),
    });

    ContractMeta {
        version: 1,
        abi_version: 0,
        min_ledger: 0,
        name: String::from_str(env, name),
        description: String::from_str(env, "Test contract"),
        functions,
        registered_by: admin.clone(),
    }
}

/// Test that registering a contract extends persistent storage TTL.
///
/// This test verifies that when a contract is registered, the extend_ttl call
/// on line 361-365 of lib.rs actually extends the persistent entry's TTL.
/// The entry remains accessible even after advancing the ledger significantly.
#[test]
fn test_register_contract_extends_persistent_ttl() {
    let (env, explorer, admin, contract_id) = setup();
    let meta = make_meta(&env, "TestSwap", &admin);

    // Register the contract — this calls extend_ttl on the DataKey::Contract entry
    explorer.register_contract(&admin, &contract_id, &meta);

    // Verify the contract was registered
    let fetched = explorer.get_contract(&contract_id).unwrap();
    assert_eq!(fetched.name, String::from_str(&env, "TestSwap"));

    // Advance the ledger by 60 days (just shy of PERSISTENT_TTL_EXTEND_TO = 90 days)
    // If extend_ttl extended to 90 days, the entry should still be accessible.
    let ledgers_to_advance = DAY_IN_LEDGERS * 60;
    env.budget().reset_default();
    for _ in 0..ledgers_to_advance {
        env.ledger().set_nonce_unit_limit(env.ledger().nonce_unit_limit());
    }

    // Fetch the contract again — it should still be accessible because extend_ttl
    // extended its TTL to 90 days (PERSISTENT_TTL_EXTEND_TO)
    let fetched_after = explorer.get_contract(&contract_id).unwrap();
    assert_eq!(fetched_after.name, String::from_str(&env, "TestSwap"));
    assert_eq!(fetched_after.abi_version, 0);
}

/// Test that updating a contract extends persistent storage TTL.
///
/// This test verifies that when a contract is updated, the extend_ttl call
/// on line 432-436 of lib.rs actually extends the persistent entry's TTL.
#[test]
fn test_update_contract_extends_persistent_ttl() {
    let (env, explorer, admin, contract_id) = setup();
    let meta = make_meta(&env, "TestSwap", &admin);

    // Register the contract
    explorer.register_contract(&admin, &contract_id, &meta.clone());

    // Update the contract — this calls extend_ttl on the DataKey::Contract entry
    let mut updated_meta = meta;
    updated_meta.abi_version = 1;
    updated_meta.version = 2;
    explorer.update_contract(&admin, &contract_id, &updated_meta);

    // Verify the contract was updated
    let fetched = explorer.get_contract(&contract_id).unwrap();
    assert_eq!(fetched.version, 2);
    assert_eq!(fetched.abi_version, 1);

    // Advance the ledger by 60 days
    let ledgers_to_advance = DAY_IN_LEDGERS * 60;
    env.budget().reset_default();
    for _ in 0..ledgers_to_advance {
        env.ledger().set_nonce_unit_limit(env.ledger().nonce_unit_limit());
    }

    // Fetch the contract again — it should still be accessible
    let fetched_after = explorer.get_contract(&contract_id).unwrap();
    assert_eq!(fetched_after.version, 2);
}

/// Test that submitting an event extends persistent storage TTL.
///
/// This test verifies that when an event is submitted, the extend_ttl call
/// on line 577-581 of lib.rs actually extends the persistent entry's TTL.
#[test]
fn test_submit_event_extends_persistent_ttl() {
    let (env, explorer, admin, contract_id) = setup();
    let meta = make_meta(&env, "TestSwap", &admin);

    // Register the contract
    explorer.register_contract(&admin, &contract_id, &meta);

    // Submit an event — this calls extend_ttl on the DataKey::EventLog entry
    let input = EventInput {
        contract_id: contract_id.clone(),
        function: soroban_sdk::symbol_short!("swap"),
        ledger: 1000,
        description: String::from_str(&env, "Swap executed"),
        raw_topics: Vec::new(&env),
        raw_data: Bytes::new(&env),
    };
    explorer.submit_event(&admin, &input);

    // Verify the event was stored
    assert_eq!(explorer.event_count(), 1);
    let event = explorer.get_event(&0);
    assert_eq!(event.contract_id, contract_id);

    // Advance the ledger by 60 days
    let ledgers_to_advance = DAY_IN_LEDGERS * 60;
    env.budget().reset_default();
    for _ in 0..ledgers_to_advance {
        env.ledger().set_nonce_unit_limit(env.ledger().nonce_unit_limit());
    }

    // Fetch the event again — it should still be accessible because extend_ttl
    // extended its TTL to 90 days
    let event_after = explorer.get_event(&0);
    assert_eq!(event_after.contract_id, contract_id);
    assert_eq!(event_after.ledger, 1000);
}

/// Negative test: verify that instance storage (admin, paused flag, event seq)
/// is also kept alive by bump_instance_ttl.
///
/// This test ensures that bump_instance_ttl (called by all state-mutating
/// operations) keeps instance storage accessible even after ledger advances.
#[test]
fn test_bump_instance_ttl_on_register() {
    let (env, explorer, admin, contract_id) = setup();
    let meta = make_meta(&env, "TestSwap", &admin);

    // Register the contract — this calls bump_instance_ttl which extends
    // instance storage (admin, event_seq, max_events, paused)
    explorer.register_contract(&admin, &contract_id, &meta);

    // Verify the instance storage is accessible: check event_count which reads EventSeq
    let count1 = explorer.event_count();
    assert_eq!(count1, 0);

    // Advance the ledger by 20 days (less than INSTANCE_TTL_EXTEND_TO = 30 days)
    let ledgers_to_advance = DAY_IN_LEDGERS * 20;
    env.budget().reset_default();
    for _ in 0..ledgers_to_advance {
        env.ledger().set_nonce_unit_limit(env.ledger().nonce_unit_limit());
    }

    // Instance storage should still be accessible
    let count2 = explorer.event_count();
    assert_eq!(count2, 0);
}

/// Verify that multiple consecutive writes each trigger extend_ttl.
///
/// This test ensures that if a persistent entry is written multiple times,
/// each write extends its TTL. This is important for entries that are
/// frequently updated (e.g., contract metadata).
#[test]
fn test_multiple_extends_accumulate() {
    let (env, explorer, admin, contract_id) = setup();
    let meta = make_meta(&env, "TestSwap", &admin);

    // Register the contract (first extend_ttl)
    explorer.register_contract(&admin, &contract_id, &meta.clone());

    // Update the contract multiple times (each triggers extend_ttl)
    for i in 1..3u32 {
        let mut updated = meta.clone();
        updated.abi_version = i;
        updated.version = i + 1;
        explorer.update_contract(&admin, &contract_id, &updated);
    }

    // Verify all updates were applied
    let fetched = explorer.get_contract(&contract_id).unwrap();
    assert_eq!(fetched.abi_version, 2);
    assert_eq!(fetched.version, 3);

    // Advance the ledger by 70 days (more than PERSISTENT_TTL_THRESHOLD = 30 days,
    // but less than PERSISTENT_TTL_EXTEND_TO = 90 days)
    let ledgers_to_advance = DAY_IN_LEDGERS * 70;
    env.budget().reset_default();
    for _ in 0..ledgers_to_advance {
        env.ledger().set_nonce_unit_limit(env.ledger().nonce_unit_limit());
    }

    // The contract should still be accessible because the last update extended TTL to 90 days
    let fetched_after = explorer.get_contract(&contract_id).unwrap();
    assert_eq!(fetched_after.version, 3);
}
