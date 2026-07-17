#![no_std]

//! Explorer contract for registering contract metadata and persisting decoded
//! Soroban events in a compact on-chain ring buffer.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Bytes, BytesN, Env, String, Symbol, Vec,
};

// ── Error codes ──────────────────────────────────────────────────────────────

#[allow(missing_docs)]
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
    Unauthorized = 2,
    AlreadyExists = 3,
    BelowFloor = 4,
    ContractPaused = 5,
    InvalidInput = 6,
}

// ── Storage keys ─────────────────────────────────────────────────────────────

/// Composite key used to store historical ABI versions.
#[allow(missing_docs)]
#[contracttype]
#[derive(Clone)]
pub struct VersionKey {
    pub contract_id: BytesN<32>,
    pub abi_version: u32,
}

#[allow(missing_docs)]
#[contracttype]
pub enum DataKey {
    Admin,
    Contract(BytesN<32>),
    /// Event log entries use persistent storage to ensure they survive ledger archival.
    /// Temporary storage would expire when TTL reaches zero, causing silent data loss.
    EventLog(u64),
    EventSeq,
    MaxEvents,
    Paused,
    ContractVersion(VersionKey),
}

/// Minimum allowed value for `max_events` (prevents accidental data loss).
pub const MIN_MAX_EVENTS: u32 = 1_000;
/// Default ring-buffer capacity used at init when caller passes `0`.
pub const DEFAULT_MAX_EVENTS: u32 = 50_000;

// ── Data types ────────────────────────────────────────────────────────────────

/// ABI-like metadata for a registered contract.
#[allow(missing_docs)]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ContractMeta {
    /// Schema version for forward compatibility.
    pub version: u32,
    /// Monotonic ABI version; incremented on every `update_contract` call.
    pub abi_version: u32,
    /// Ledger sequence at which this ABI version was written.
    pub min_ledger: u32,
    pub name: String,
    pub description: String,
    pub functions: Vec<FunctionAbi>,
    pub registered_by: Address,
}

/// Describes one callable function so the explorer can decode calls.
#[allow(missing_docs)]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct FunctionAbi {
    pub name: Symbol,
    pub description: String,
    pub params: Vec<ParamDef>,
}

/// One parameter definition.
#[allow(missing_docs)]
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ParamDef {
    pub name: Symbol,
    pub kind: Symbol,
}

/// A decoded, human-readable event stored on-chain.
#[allow(missing_docs)]
#[contracttype]
#[derive(Clone)]
pub struct DecodedEvent {
    pub seq: u64,
    pub contract_id: BytesN<32>,
    pub function: Symbol,
    pub ledger: u32,
    pub description: String,
    pub raw_topics: Vec<String>,
    pub raw_data: Bytes,
}

/// Event submission parameters.
#[allow(missing_docs)]
#[contracttype]
#[derive(Clone)]
pub struct EventInput {
    pub contract_id: BytesN<32>,
    pub function: Symbol,
    pub ledger: u32,
    pub description: String,
    pub raw_topics: Vec<String>,
    pub raw_data: Bytes,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[allow(missing_docs)]
#[contract]
pub struct ExplorerContract;

#[contractimpl]
impl ExplorerContract {
    // ── Admin ─────────────────────────────────────────────────────────────────

    /// Initialises the explorer and configures the event ring buffer.
    /// Panics with `AlreadyExists` if called more than once.
    /// Pass `max_events = 0` to use the default capacity.
    pub fn init(env: Env, admin: Address, max_events: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyExists);
        }
        let cap = if max_events == 0 {
            DEFAULT_MAX_EVENTS
        } else {
            max_events
        };
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::EventSeq, &0u64);
        env.storage().instance().set(&DataKey::MaxEvents, &cap);
    }

    /// Transfer admin rights to a new address (current admin only).
    pub fn transfer_admin(env: Env, caller: Address, new_admin: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.events()
            .publish((symbol_short!("adm_xfer"), caller), new_admin);
    }

    /// Update the ring-buffer capacity (admin only).
    /// Panics with `BelowFloor` if `new_max < MIN_MAX_EVENTS`.
    pub fn set_max_events(env: Env, caller: Address, new_max: u32) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        if new_max < MIN_MAX_EVENTS {
            panic_with_error!(&env, Error::BelowFloor);
        }
        env.storage().instance().set(&DataKey::MaxEvents, &new_max);
    }

    /// Returns `(current_event_count, max_events)`.
    pub fn storage_utilisation(env: Env) -> (u64, u32) {
        let seq: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EventSeq)
            .unwrap_or(0);
        let max: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvents)
            .unwrap_or(DEFAULT_MAX_EVENTS);
        (seq.min(max as u64), max)
    }

    // ── Pause / unpause ───────────────────────────────────────────────────────

    /// Freeze all state-mutating operations (admin only).
    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish((symbol_short!("paused"),), ());
    }

    /// Unfreeze the contract (admin only).
    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish((symbol_short!("unpaused"),), ());
    }

    /// Returns whether the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ── Contract Registry ─────────────────────────────────────────────────────

    /// Register ABI metadata for a Soroban contract.
    /// Panics with `AlreadyExists` if the contract ID is already registered.
    /// The contract forces `abi_version = 0` and records `min_ledger` on first write.
    pub fn register_contract(
        env: Env,
        caller: Address,
        contract_id: BytesN<32>,
        meta: ContractMeta,
    ) {
        caller.require_auth();
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(&env, Error::ContractPaused);
        }
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }
        let key = DataKey::Contract(contract_id.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, Error::AlreadyExists);
        }
        let mut stored = meta;
        stored.abi_version = 0;
        stored.min_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &stored);

        // Version history entry for abi_version 0.
        let vkey = DataKey::ContractVersion(VersionKey {
            contract_id: contract_id.clone(),
            abi_version: 0,
        });
        env.storage().persistent().set(&vkey, &stored);

        env.events().publish(
            (symbol_short!("c_reg"), contract_id.clone()),
            (
                stored.registered_by.clone(),
                stored.version,
                env.ledger().sequence(),
            ),
        );
        env.events()
            .publish((symbol_short!("register"), contract_id), stored.name);
    }

    /// Update registered metadata.
    /// Caller must be the admin or the original registrant.
    /// `meta.abi_version` must equal `existing.abi_version + 1` (optimistic concurrency guard).
    pub fn update_contract(env: Env, caller: Address, contract_id: BytesN<32>, meta: ContractMeta) {
        caller.require_auth();
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(&env, Error::ContractPaused);
        }
        let key = DataKey::Contract(contract_id.clone());
        let existing: ContractMeta = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != existing.registered_by && caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }

        // Optimistic concurrency: submitted abi_version must be current + 1.
        let expected = existing.abi_version + 1;
        if meta.abi_version != expected {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let old_abi_version = existing.abi_version;
        let old_version = existing.version;
        let new_abi_version = meta.abi_version;
        let min_ledger = env.ledger().sequence();
        let mut updated = meta;
        updated.min_ledger = min_ledger;
        env.storage().persistent().set(&key, &updated);

        let vkey = DataKey::ContractVersion(VersionKey {
            contract_id: contract_id.clone(),
            abi_version: new_abi_version,
        });
        env.storage().persistent().set(&vkey, &updated);

        env.events().publish(
            (symbol_short!("c_abiu"), contract_id.clone()),
            (old_abi_version, new_abi_version, min_ledger),
        );
        env.events().publish(
            (symbol_short!("c_upd"), contract_id),
            (
                caller,
                old_version,
                updated.version,
                env.ledger().sequence(),
            ),
        );
    }

    pub fn get_contract(env: Env, contract_id: BytesN<32>) -> Result<ContractMeta, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Contract(contract_id))
            .ok_or(Error::NotFound)
    }

    /// Fetch a specific historical ABI version.
    /// Returns `None` if that version does not exist.
    pub fn get_contract_version(
        env: Env,
        contract_id: BytesN<32>,
        abi_version: u32,
    ) -> Option<ContractMeta> {
        env.storage()
            .persistent()
            .get(&DataKey::ContractVersion(VersionKey {
                contract_id,
                abi_version,
            }))
    }

    /// Alias for `get_contract` — returns the latest metadata.
    pub fn get_latest_contract(env: Env, contract_id: BytesN<32>) -> Option<ContractMeta> {
        env.storage()
            .persistent()
            .get(&DataKey::Contract(contract_id))
    }

    /// Deregister a contract.
    /// Caller must be the admin or the original registrant.
    pub fn deregister_contract(env: Env, caller: Address, contract_id: BytesN<32>) {
        caller.require_auth();
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(&env, Error::ContractPaused);
        }
        let key = DataKey::Contract(contract_id.clone());
        let existing: ContractMeta = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != existing.registered_by && caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }

        env.storage().persistent().remove(&key);
        env.events().publish(
            (symbol_short!("c_dereg"), contract_id),
            (caller, env.ledger().sequence()),
        );
    }

    // ── Event Decoder ─────────────────────────────────────────────────────────

    /// Submit a decoded event to the on-chain ring buffer.
    /// Only the admin may call this.
    pub fn submit_event(env: Env, caller: Address, input: EventInput) {
        caller.require_auth();
        if input.function == Symbol::new(&env, "") {
            panic_with_error!(&env, Error::InvalidInput);
        }
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            panic_with_error!(&env, Error::ContractPaused);
        }
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        if caller != admin {
            panic_with_error!(&env, Error::Unauthorized);
        }

        let seq: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EventSeq)
            .unwrap_or(0);
        let max: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvents)
            .unwrap_or(DEFAULT_MAX_EVENTS);

        let slot = seq % (max as u64);
        let evicting = seq >= (max as u64);
        let evicted_seq = if evicting { seq - (max as u64) } else { seq };

        let event = DecodedEvent {
            seq,
            contract_id: input.contract_id.clone(),
            function: input.function.clone(),
            ledger: input.ledger,
            description: input.description.clone(),
            raw_topics: input.raw_topics,
            raw_data: input.raw_data,
        };
        env.storage()
            .persistent()
            .set(&DataKey::EventLog(slot), &event);
        env.storage().instance().set(&DataKey::EventSeq, &(seq + 1));

        env.events().publish(
            (
                symbol_short!("ev_sub"),
                input.contract_id.clone(),
                input.function.clone(),
            ),
            (seq, input.ledger),
        );
        if evicting {
            env.events()
                .publish((symbol_short!("cap_hit"),), (evicted_seq, seq));
        }
        env.events().publish(
            (symbol_short!("decoded"), input.contract_id, input.function),
            input.description,
        );
    }

    /// Fetch a single decoded event by sequence number.
    /// Panics with `NotFound` if the sequence is outside the live ring window.
    pub fn get_event(env: Env, seq: u64) -> DecodedEvent {
        let max: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvents)
            .unwrap_or(DEFAULT_MAX_EVENTS);
        let slot = seq % (max as u64);
        let stored: DecodedEvent = env
            .storage()
            .persistent()
            .get(&DataKey::EventLog(slot))
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotFound));
        // Verify the slot still holds the requested seq (not overwritten by ring wrap).
        if stored.seq != seq {
            panic_with_error!(&env, Error::NotFound);
        }
        stored
    }

    /// Returns the number of events currently retained (≤ `max_events`).
    pub fn event_count(env: Env) -> u64 {
        let seq: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EventSeq)
            .unwrap_or(0);
        let max: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvents)
            .unwrap_or(DEFAULT_MAX_EVENTS);
        seq.min(max as u64)
    }

    /// Fetch a page of decoded events starting from `cursor`.
    /// Returns at most `limit` events. Skips events evicted from the ring buffer.
    pub fn get_events(env: Env, cursor: u64, limit: u32) -> Vec<DecodedEvent> {
        let total_seq: u64 = env
            .storage()
            .instance()
            .get(&DataKey::EventSeq)
            .unwrap_or(0);
        let max: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxEvents)
            .unwrap_or(DEFAULT_MAX_EVENTS);
        let oldest = total_seq.saturating_sub(max as u64);
        let start = cursor.max(oldest);
        let mut out: Vec<DecodedEvent> = Vec::new(&env);
        let mut seq = start;
        while out.len() < limit && seq < total_seq {
            let slot = seq % (max as u64);
            if let Some(ev) = env
                .storage()
                .persistent()
                .get::<DataKey, DecodedEvent>(&DataKey::EventLog(slot))
            {
                if ev.seq == seq {
                    out.push_back(ev);
                }
            }
            seq += 1;
        }
        out
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events as _},
        Env,
    };

    fn setup() -> (Env, ExplorerContractClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, ExplorerContract);
        let client = ExplorerContractClient::new(&env, &id);
        (env, client)
    }

    fn make_input(env: &Env, cid: &BytesN<32>) -> EventInput {
        EventInput {
            contract_id: cid.clone(),
            function: symbol_short!("swap"),
            ledger: 100u32,
            description: String::from_str(env, "test"),
            raw_topics: Vec::new(env),
            raw_data: Bytes::new(env),
        }
    }

    fn make_meta(env: &Env, name: &str, registrant: &Address) -> ContractMeta {
        ContractMeta {
            version: 1,
            abi_version: 0,
            min_ledger: 0,
            name: String::from_str(env, name),
            description: String::from_str(env, "desc"),
            functions: Vec::new(env),
            registered_by: registrant.clone(),
        }
    }

    // ── Basic init + register ─────────────────────────────────────────────────

    #[test]
    fn test_init_and_register() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);
        client.register_contract(&admin, &cid, &make_meta(&env, "StellarSwap", &admin));
        let fetched = client.get_contract(&cid);
        assert_eq!(fetched.name, String::from_str(&env, "StellarSwap"));
    }

    #[test]
    #[should_panic]
    fn test_register_unauthorized() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let stranger = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[50u8; 32]);
        client.register_contract(
            &stranger,
            &cid,
            &make_meta(&env, "UnauthorizedReg", &stranger),
        );
    }

    #[test]
    fn test_submit_and_get_event() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[2u8; 32]);
        let input = EventInput {
            contract_id: cid.clone(),
            function: symbol_short!("swap"),
            ledger: 4521983u32,
            description: String::from_str(&env, "Address GABC... swapped 100 USDC"),
            raw_topics: Vec::new(&env),
            raw_data: Bytes::new(&env),
        };
        client.submit_event(&admin, &input);

        assert_eq!(client.event_count(), 1u64);
        let ev = client.get_event(&0u64);
        assert_eq!(ev.ledger, 4521983u32);
    }

    #[test]
    fn test_cursor_pagination() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[3u8; 32]);
        let base = make_input(&env, &cid);

        for _ in 0..5 {
            client.submit_event(&admin, &base);
        }
        assert_eq!(client.event_count(), 5u64);

        let page1 = client.get_events(&0u64, &2u32);
        assert_eq!(page1.len(), 2);
        assert_eq!(page1.get(0).unwrap().seq, 0);
        assert_eq!(page1.get(1).unwrap().seq, 1);

        let page2 = client.get_events(&2u64, &2u32);
        assert_eq!(page2.len(), 2);
        assert_eq!(page2.get(0).unwrap().seq, 2);

        let page3 = client.get_events(&4u64, &2u32);
        assert_eq!(page3.len(), 1);
        assert_eq!(page3.get(0).unwrap().seq, 4);

        let empty = client.get_events(&10u64, &5u32);
        assert_eq!(empty.len(), 0);
    }

    #[test]
    #[should_panic]
    fn test_double_init_panics() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);
        client.init(&admin, &0u32);
    }

    // ── Ring buffer ───────────────────────────────────────────────────────────

    #[test]
    fn test_ring_buffer_wraps_correctly() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &5u32);
        let cid: BytesN<32> = BytesN::from_array(&env, &[10u8; 32]);
        let base = make_input(&env, &cid);

        for _ in 0..5 {
            client.submit_event(&admin, &base);
        }
        assert_eq!(client.event_count(), 5u64);

        for _ in 0..10 {
            client.submit_event(&admin, &base);
        }
        assert_eq!(client.event_count(), 5u64);

        let evs = client.get_events(&0u64, &20u32);
        assert_eq!(evs.len(), 5);
        assert_eq!(evs.get(0).unwrap().seq, 10);
        assert_eq!(evs.get(4).unwrap().seq, 14);
    }

    #[test]
    fn test_storage_utilisation() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &1000u32);
        let (cur, max) = client.storage_utilisation();
        assert_eq!(cur, 0u64);
        assert_eq!(max, 1000u32);
    }

    // ── set_max_events ────────────────────────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_set_max_events_below_floor_rejected() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);
        client.set_max_events(&admin, &999u32);
    }

    #[test]
    fn test_set_max_events_accepted() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);
        client.set_max_events(&admin, &1000u32);
        let (_, max) = client.storage_utilisation();
        assert_eq!(max, 1000u32);
    }

    // ── Diagnostic events (#275) ──────────────────────────────────────────────

    #[test]
    fn test_register_emits_event() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[20u8; 32]);
        client.register_contract(&admin, &cid, &make_meta(&env, "TestDex", &admin));
        assert!(env.events().all().len() >= 2);
    }

    #[test]
    fn test_update_emits_event() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[21u8; 32]);
        let meta_v0 = make_meta(&env, "Dex", &admin);
        client.register_contract(&admin, &cid, &meta_v0);
        let before = env.events().all().len();

        let meta_v1 = ContractMeta {
            version: 2,
            abi_version: 1, // must be existing (0) + 1
            ..meta_v0
        };
        client.update_contract(&admin, &cid, &meta_v1);
        assert!(env.events().all().len() > before);
    }

    #[test]
    fn test_update_contract_by_owner() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let owner = Address::generate(&env);
        let cid: BytesN<32> = BytesN::from_array(&env, &[25u8; 32]);
        // Only the admin can register; meta.registered_by marks the owner for future updates.
        let meta_v0 = make_meta(&env, "MyContract", &owner);
        client.register_contract(&admin, &cid, &meta_v0);

        let meta_v1 = ContractMeta {
            version: 2,
            abi_version: 1, // must be existing (0) + 1
            ..meta_v0
        };
        client.update_contract(&owner, &cid, &meta_v1);

        let updated = client.get_contract(&cid);
        assert_eq!(updated.version, 2);
        assert_eq!(updated.abi_version, 1);
    }

    #[test]
    fn test_submit_emits_ev_sub_event() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[22u8; 32]);
        client.submit_event(&admin, &make_input(&env, &cid));
        assert!(env.events().all().len() >= 2);
    }

    #[test]
    fn test_cap_hit_event_emitted_on_eviction() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &5u32);
        let cid: BytesN<32> = BytesN::from_array(&env, &[23u8; 32]);
        let base = make_input(&env, &cid);

        for _ in 0..5 {
            client.submit_event(&admin, &base);
        }
        let before = env.events().all().len();
        client.submit_event(&admin, &base);
        assert!(env.events().all().len() > before);
    }

    // ── ABI versioning (#272) ─────────────────────────────────────────────────

    #[test]
    fn test_register_sets_version_zero() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[30u8; 32]);
        let meta = ContractMeta {
            abi_version: 99, // contract overwrites to 0
            ..make_meta(&env, "Test", &admin)
        };
        client.register_contract(&admin, &cid, &meta);

        let fetched = client.get_contract(&cid);
        assert_eq!(fetched.abi_version, 0);

        let v0 = client.get_contract_version(&cid, &0u32).unwrap();
        assert_eq!(v0.abi_version, 0);
        assert_eq!(v0.name, String::from_str(&env, "Test"));
    }

    #[test]
    fn test_sequential_updates_increment_abi_version() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[31u8; 32]);
        let meta_v0 = make_meta(&env, "App", &admin);
        client.register_contract(&admin, &cid, &meta_v0);

        let meta_v1 = ContractMeta {
            abi_version: 1,
            ..meta_v0.clone()
        };
        client.update_contract(&admin, &cid, &meta_v1);
        assert_eq!(client.get_contract(&cid).abi_version, 1);

        let meta_v2 = ContractMeta {
            abi_version: 2,
            ..meta_v0
        };
        client.update_contract(&admin, &cid, &meta_v2);
        assert_eq!(client.get_contract(&cid).abi_version, 2);

        assert!(client.get_contract_version(&cid, &0u32).is_some());
        assert!(client.get_contract_version(&cid, &1u32).is_some());
        assert!(client.get_contract_version(&cid, &2u32).is_some());
        assert!(client.get_contract_version(&cid, &3u32).is_none());
    }

    #[test]
    #[should_panic]
    fn test_stale_write_rejected() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[32u8; 32]);
        let meta_v0 = make_meta(&env, "X", &admin);
        client.register_contract(&admin, &cid, &meta_v0);

        let meta_v1 = ContractMeta {
            abi_version: 1,
            ..meta_v0.clone()
        };
        client.update_contract(&admin, &cid, &meta_v1);

        // abi_version 1 again — should panic (expected 2)
        let meta_stale = ContractMeta {
            abi_version: 1,
            ..meta_v0
        };
        client.update_contract(&admin, &cid, &meta_stale);
    }

    #[test]
    fn test_get_contract_not_found() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[33u8; 32]);
        assert!(matches!(
            client.try_get_contract(&cid),
            Err(Ok(crate::Error::NotFound))
        ));
    }

    #[test]
    fn test_get_latest_contract_returns_none_for_missing() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[33u8; 32]);
        assert!(client.get_latest_contract(&cid).is_none());
        assert!(client.get_contract_version(&cid, &0u32).is_none());
    }

    // ── Deregistration (#271) ─────────────────────────────────────────────────

    #[test]
    fn test_admin_deregisters_contract() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[40u8; 32]);
        client.register_contract(&admin, &cid, &make_meta(&env, "ToRemove", &admin));
        assert!(client.try_get_contract(&cid).is_ok());

        client.deregister_contract(&admin, &cid);
        assert!(client.try_get_contract(&cid).is_err());
    }

    #[test]
    fn test_registrant_deregisters_contract() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let registrant = Address::generate(&env);
        let cid: BytesN<32> = BytesN::from_array(&env, &[41u8; 32]);
        client.register_contract(&admin, &cid, &make_meta(&env, "RegOwned", &registrant));
        client.deregister_contract(&registrant, &cid);
        assert!(client.try_get_contract(&cid).is_err());
    }

    #[test]
    #[should_panic]
    fn test_stranger_cannot_deregister() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let registrant = Address::generate(&env);
        let stranger = Address::generate(&env);
        let cid: BytesN<32> = BytesN::from_array(&env, &[42u8; 32]);
        client.register_contract(&admin, &cid, &make_meta(&env, "Secure", &registrant));
        client.deregister_contract(&stranger, &cid);
    }

    #[test]
    #[should_panic]
    fn test_deregister_missing_id_panics() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[99u8; 32]);
        client.deregister_contract(&admin, &cid);
    }

    #[test]
    fn test_deregister_emits_event() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);

        let cid: BytesN<32> = BytesN::from_array(&env, &[43u8; 32]);
        client.register_contract(&admin, &cid, &make_meta(&env, "EventTest", &admin));
        let before = env.events().all().len();
        client.deregister_contract(&admin, &cid);
        assert!(env.events().all().len() > before);
    }

    // ── transfer_admin ────────────────────────────────────────────────────────

    #[test]
    fn test_transfer_admin_success() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.init(&admin, &0u32);
        client.transfer_admin(&admin, &new_admin);

        let cid: BytesN<32> = BytesN::from_array(&env, &[9u8; 32]);
        client.submit_event(
            &new_admin,
            &EventInput {
                contract_id: cid,
                function: symbol_short!("ping"),
                ledger: 1u32,
                description: String::from_str(&env, "new admin test"),
                raw_topics: Vec::new(&env),
                raw_data: Bytes::new(&env),
            },
        );
        assert_eq!(client.event_count(), 1u64);
    }

    #[test]
    #[should_panic]
    fn test_transfer_admin_unauthorized() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.init(&admin, &0u32);
        client.transfer_admin(&attacker, &new_admin);
    }

    #[test]
    #[should_panic]
    fn test_old_admin_loses_access_after_transfer() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        client.init(&admin, &0u32);
        client.transfer_admin(&admin, &new_admin);

        let cid: BytesN<32> = BytesN::from_array(&env, &[10u8; 32]);
        client.submit_event(
            &admin,
            &EventInput {
                contract_id: cid,
                function: symbol_short!("ping"),
                ledger: 1u32,
                description: String::from_str(&env, "stale admin attempt"),
                raw_topics: Vec::new(&env),
                raw_data: Bytes::new(&env),
            },
        );
    }

    #[test]
    fn test_transfer_admin_to_self_is_noop() {
        let (env, client) = setup();
        let admin = Address::generate(&env);
        client.init(&admin, &0u32);
        client.transfer_admin(&admin, &admin);

        let cid: BytesN<32> = BytesN::from_array(&env, &[11u8; 32]);
        client.submit_event(
            &admin,
            &EventInput {
                contract_id: cid,
                function: symbol_short!("ping"),
                ledger: 1u32,
                description: String::from_str(&env, "self transfer test"),
                raw_topics: Vec::new(&env),
                raw_data: Bytes::new(&env),
            },
        );
        assert_eq!(client.event_count(), 1u64);
    }
}
