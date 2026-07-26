use proptest::prelude::*;
use soroban_explorer_contract::{
    ContractMeta, ExplorerContract, ExplorerContractClient, FunctionAbi, ParamDef,
    DEFAULT_MAX_EVENTS, MAX_DESCRIPTION_LEN, MAX_FUNCTIONS, MAX_NAME_LEN, MAX_PARAMS_PER_FUNCTION,
    MIN_MAX_EVENTS,
};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String, Symbol, Vec};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn sdk_symbol(env: &Env, s: &str) -> Symbol {
    Symbol::new(env, s)
}

/// Build a soroban_sdk::String of exactly `len` 'a' bytes.
fn ascii_string(env: &Env, len: usize) -> String {
    let raw: std::vec::Vec<u8> = std::vec![b'a'; len];
    String::from_bytes(env, &raw)
}

fn setup() -> (Env, ExplorerContractClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, ExplorerContract);
    let client = ExplorerContractClient::new(&env, &id);
    (env, client)
}

// ── Original invariant test (preserved) ──────────────────────────────────────

proptest! {
    #[test]
    fn test_init_invariants(max_events in 0u32..u32::MAX) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, ExplorerContract);
        let client = ExplorerContractClient::new(&env, &id);

        let admin = Address::generate(&env);
        client.init(&admin, &max_events);

        let (_, stored_max) = client.storage_utilisation();

        if max_events == 0 {
            prop_assert_eq!(stored_max, DEFAULT_MAX_EVENTS);
        } else {
            prop_assert_eq!(stored_max, max_events);
        }
    }
}

// ── Fuzz: valid ContractMeta always succeeds ──────────────────────────────────
//
// For any input that is *within* all size limits, register_contract must
// succeed without panicking. The rejection path is tested by the
// `#[should_panic]` unit tests in lib.rs.
//
// Strategy: generate sizes that are guaranteed to be within bounds, then verify
// the contract accepts them and the stored data matches.

proptest! {
    // 20 cases is enough to catch regressions. Each case can allocate up to
    // MAX_FUNCTIONS × MAX_PARAMS_PER_FUNCTION Soroban objects in debug builds,
    // so a large case count adds significant overhead.
    #![proptest_config(ProptestConfig::with_cases(20))]
    #[test]
    fn fuzz_valid_register_contract_always_succeeds(
        name_len    in 0usize..=(MAX_NAME_LEN as usize),
        desc_len    in 0usize..=(MAX_DESCRIPTION_LEN as usize),
        fn_count    in 0u32..=MAX_FUNCTIONS,
        param_count in 0u32..=MAX_PARAMS_PER_FUNCTION,
        fn_desc_len in 0usize..=(MAX_DESCRIPTION_LEN as usize),
    ) {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &MIN_MAX_EVENTS);

        let mut functions: Vec<FunctionAbi> = Vec::new(&env);
        for _ in 0..fn_count {
            let mut params: Vec<ParamDef> = Vec::new(&env);
            for _ in 0..param_count {
                params.push_back(ParamDef {
                    name: sdk_symbol(&env, "p"),
                    kind: sdk_symbol(&env, "u32"),
                });
            }
            functions.push_back(FunctionAbi {
                name: sdk_symbol(&env, "fn"),
                description: ascii_string(&env, fn_desc_len),
                params,
            });
        }

        let meta = ContractMeta {
            version: 1,
            abi_version: 0,
            min_ledger: 0,
            name: ascii_string(&env, name_len),
            description: ascii_string(&env, desc_len),
            functions,
            registered_by: admin.clone(),
        };

        let cid: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);

        // Must not panic — any panic on a valid payload is a bug.
        client.register_contract(&admin, &cid, &meta);

        // Verify the stored data is intact.
        let stored = client.get_contract(&cid);
        prop_assert_eq!(stored.name, ascii_string(&env, name_len));
        prop_assert_eq!(stored.functions.len(), fn_count);
        prop_assert_eq!(stored.abi_version, 0u32);
    }
}
