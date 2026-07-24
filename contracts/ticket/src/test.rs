//! Tests for the Ticket contract.
//!
//! Sections
//! --------
//! 1. Original unit tests (preserved)
//! 2. Property-based tests  (proptest)
//! 3. Snapshot / state-diff tests
//! 4. Gas benchmark tests
//! 5. Stress tests
//! 6. Edge-case / error-path tests

#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Env, String};

// ─── helpers ─────────────────────────────────────────────────────────────────

/// Shared setup: deploy + initialise the contract with default parameters.
fn setup() -> (Env, TicketContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TicketContract);
    let client = TicketContractClient::new(&env, &contract_id);

    let organizer = Address::generate(&env);
    let buyer = Address::generate(&env);

    client.initialize(
        &organizer,
        &String::from_str(&env, "Harvesta Live 2025"),
        &100u64,
        &50_000_000i128, // 5 XLM in stroops
        &75_000_000i128, // max resale 7.5 XLM
    );

    (env, client, organizer, buyer)
}

/// Setup with custom capacity.
fn setup_with_capacity(max: u64) -> (Env, TicketContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TicketContract);
    let client = TicketContractClient::new(&env, &contract_id);
    let organizer = Address::generate(&env);
    client.initialize(
        &organizer,
        &String::from_str(&env, "Test Event"),
        &max,
        &1_000i128,
        &2_000i128,
    );
    (env, client, organizer)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ORIGINAL UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn test_mint_and_get() {
    let (_env, client, organizer, buyer) = setup();
    let id = client.mint_ticket(&organizer, &buyer);
    assert_eq!(id, 0);

    let ticket = client.get_ticket(&0u64);
    assert_eq!(ticket.owner, buyer);
    assert_eq!(ticket.status, TicketStatus::Valid);
}

#[test]
fn test_transfer() {
    let (env, client, organizer, buyer) = setup();
    client.mint_ticket(&organizer, &buyer);

    let new_owner = Address::generate(&env);
    client.transfer_ticket(&buyer, &new_owner, &0u64, &60_000_000i128);

    let ticket = client.get_ticket(&0u64);
    assert_eq!(ticket.owner, new_owner);
    assert_eq!(ticket.status, TicketStatus::Transferred);
}

#[test]
#[should_panic(expected = "price exceeds resale cap")]
fn test_resale_cap_enforced() {
    let (env, client, organizer, buyer) = setup();
    client.mint_ticket(&organizer, &buyer);

    let new_owner = Address::generate(&env);
    client.transfer_ticket(&buyer, &new_owner, &0u64, &100_000_000i128);
}

#[test]
fn test_verify_ticket() {
    let (_env, client, organizer, buyer) = setup();
    client.mint_ticket(&organizer, &buyer);

    let valid = client.verify_ticket(&organizer, &0u64);
    assert!(valid);

    // Second scan must return false (already used).
    let double_scan = client.verify_ticket(&organizer, &0u64);
    assert!(!double_scan);
}

