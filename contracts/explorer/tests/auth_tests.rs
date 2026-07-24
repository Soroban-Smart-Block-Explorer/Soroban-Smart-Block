#![cfg(test)]
use soroban_explorer_contract::{
    ContractMeta, EventInput, ExplorerContract, ExplorerContractClient,
};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Bytes, BytesN, Env, IntoVal, String, Vec,
};

fn setup_with_admin() -> (Env, ExplorerContractClient<'static>, Address) {
    let env = Env::default();
    let id = env.register_contract(None, ExplorerContract);
    let client = ExplorerContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.init(&admin, &0u32);
    env.set_auths(&[]); // clear mock_all_auths
    (env, client, admin)
}

fn make_meta(env: &Env, registrant: &Address) -> ContractMeta {
    ContractMeta {
        version: 1,
        abi_version: 0,
        min_ledger: 0,
        name: String::from_str(env, "Test"),
        description: String::from_str(env, "desc"),
        functions: Vec::new(env),
        registered_by: registrant.clone(),
    }
}

fn make_input(env: &Env) -> EventInput {
    EventInput {
        contract_id: BytesN::from_array(env, &[0u8; 32]),
        function: symbol_short!("fn1"),
        ledger: 1u32,
        description: String::from_str(env, "d"),
        raw_topics: Vec::new(env),
        raw_data: Bytes::new(env),
    }
}

// 1. register_contract called by A authenticating as B → auth failure
#[test]
#[should_panic]
fn test_register_wrong_auth() {
    let (env, client, _admin) = setup_with_admin();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let cid = BytesN::from_array(&env, &[1u8; 32]);
    let meta = make_meta(&env, &a);
    // authenticate as b but pass a as caller — auth check for `a` will fail
    env.mock_auths(&[MockAuth {
        address: &b,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_contract",
            args: (a.clone(), cid.clone(), meta.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.register_contract(&a, &cid, &meta);
}

// 2. update_contract by stranger → Unauthorized
#[test]
#[should_panic]
fn test_update_by_stranger() {
    let (env, client, admin) = setup_with_admin();
    let registrant = Address::generate(&env);
    let stranger = Address::generate(&env);
    let cid = BytesN::from_array(&env, &[2u8; 32]);
    let meta = make_meta(&env, &registrant);

    // register as admin (but with registrant as registered_by in meta)
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_contract",
            args: (admin.clone(), cid.clone(), meta.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.register_contract(&admin, &cid, &meta);

    // stranger tries to update
    let meta2 = ContractMeta {
        version: 2,
        abi_version: 1,
        ..meta
    };
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "update_contract",
            args: (stranger.clone(), cid.clone(), meta2.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.update_contract(&stranger, &cid, &meta2);
}

// 3. Admin can update any contract regardless of registrant
#[test]
fn test_admin_can_update_any() {
    let (env, client, admin) = setup_with_admin();
    let registrant = Address::generate(&env);
    let cid = BytesN::from_array(&env, &[3u8; 32]);
    let meta = make_meta(&env, &registrant);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_contract",
            args: (admin.clone(), cid.clone(), meta.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.register_contract(&admin, &cid, &meta);

    let meta2 = ContractMeta {
        version: 2,
        abi_version: 1,
        ..meta
    };
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "update_contract",
            args: (admin.clone(), cid.clone(), meta2.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.update_contract(&admin, &cid, &meta2);
    assert_eq!(client.get_contract(&cid).version, 2u32);
}

// 4. Registrant can update their own contract
#[test]
fn test_registrant_can_update_own() {
    let (env, client, admin) = setup_with_admin();
    let registrant = Address::generate(&env);
    let cid = BytesN::from_array(&env, &[4u8; 32]);
    let meta = make_meta(&env, &registrant);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_contract",
            args: (admin.clone(), cid.clone(), meta.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.register_contract(&admin, &cid, &meta);

    let meta2 = ContractMeta {
        version: 2,
        abi_version: 1,
        ..meta
    };
    env.mock_auths(&[MockAuth {
        address: &registrant,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "update_contract",
            args: (registrant.clone(), cid.clone(), meta2.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.update_contract(&registrant, &cid, &meta2);
    assert_eq!(client.get_contract(&cid).version, 2u32);
}

// 5. submit_event called by non-admin → Unauthorized
#[test]
#[should_panic]
fn test_submit_event_non_admin() {
    let (env, client, _admin) = setup_with_admin();
    let stranger = Address::generate(&env);
    let input = make_input(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "submit_event",
            args: (stranger.clone(), input.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.submit_event(&stranger, &input);
}

// 6. init called twice → AlreadyExists error
#[test]
#[should_panic]
fn test_double_init() {
    let env = Env::default();
    let id = env.register_contract(None, ExplorerContract);
    let client = ExplorerContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.init(&admin, &0u32);
    client.init(&admin, &0u32);
}

// 7. set_max_events by non-admin → Unauthorized
#[test]
#[should_panic]
fn test_set_max_events_non_admin() {
    let (env, client, _admin) = setup_with_admin();
    let stranger = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "set_max_events",
            args: (stranger.clone(), 2000u32).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_max_events(&stranger, &2000u32);
}

// ── #258: deregister_contract auth tests ─────────────────────────────────────

// 8. deregister by registrant succeeds
#[test]
fn test_deregister_by_registrant() {
    let (env, client, admin) = setup_with_admin();
    let registrant = Address::generate(&env);
    let cid = BytesN::from_array(&env, &[10u8; 32]);
    let meta = make_meta(&env, &registrant);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_contract",
            args: (admin.clone(), cid.clone(), meta.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.register_contract(&admin, &cid, &meta);

    env.mock_auths(&[MockAuth {
        address: &registrant,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "deregister_contract",
            args: (registrant.clone(), cid.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.deregister_contract(&registrant, &cid);
}

// 9. deregister by admin succeeds
#[test]
fn test_deregister_by_admin() {
    let (env, client, admin) = setup_with_admin();
    let registrant = Address::generate(&env);
    let cid = BytesN::from_array(&env, &[11u8; 32]);
    let meta = make_meta(&env, &registrant);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_contract",
            args: (admin.clone(), cid.clone(), meta.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.register_contract(&admin, &cid, &meta);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "deregister_contract",
            args: (admin.clone(), cid.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.deregister_contract(&admin, &cid);
}

// 10. deregister by stranger → Unauthorized
#[test]
#[should_panic]
fn test_deregister_by_stranger() {
    let (env, client, admin) = setup_with_admin();
    let registrant = Address::generate(&env);
    let stranger = Address::generate(&env);
    let cid = BytesN::from_array(&env, &[12u8; 32]);
    let meta = make_meta(&env, &registrant);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_contract",
            args: (admin.clone(), cid.clone(), meta.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.register_contract(&admin, &cid, &meta);

    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "deregister_contract",
            args: (stranger.clone(), cid.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.deregister_contract(&stranger, &cid);
}

// ── #261: max_events cap auth tests ──────────────────────────────────────────

// 11. init with custom cap is respected
#[test]
fn test_init_custom_cap() {
    let env = Env::default();
    let id = env.register_contract(None, soroban_explorer_contract::ExplorerContract);
    let client = ExplorerContractClient::new(&env, &id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.init(&admin, &1000u32);
    let (_, max) = client.storage_utilisation();
    assert_eq!(max, 1000u32);
}

// ── #264: pause / unpause auth tests ─────────────────────────────────────────

// 12. pause by non-admin → Unauthorized
#[test]
#[should_panic]
fn test_pause_non_admin() {
    let (env, client, _admin) = setup_with_admin();
    let stranger = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "pause",
            args: (stranger.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause(&stranger);
}

// 13. unpause by non-admin → Unauthorized
#[test]
#[should_panic]
fn test_unpause_non_admin() {
    let (env, client, admin) = setup_with_admin();
    // First pause as admin
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "pause",
            args: (admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause(&admin);

    let stranger = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "unpause",
            args: (stranger.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.unpause(&stranger);
}

// 14. admin can pause and unpause
#[test]
fn test_admin_pause_unpause() {
    let (env, client, admin) = setup_with_admin();
    assert!(!client.is_paused());

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "pause",
            args: (admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause(&admin);
    assert!(client.is_paused());

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "unpause",
            args: (admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.unpause(&admin);
    assert!(!client.is_paused());
}

// 15. register_contract while paused → ContractPaused
#[test]
#[should_panic]
fn test_register_while_paused() {
    let (env, client, admin) = setup_with_admin();
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "pause",
            args: (admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.pause(&admin);

    let cid = BytesN::from_array(&env, &[20u8; 32]);
    let meta = make_meta(&env, &admin);
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &client.address,
            fn_name: "register_contract",
            args: (admin.clone(), cid.clone(), meta.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.register_contract(&admin, &cid, &meta);
}
