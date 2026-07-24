#![no_std]


// Unit / property / snapshot / stress / gas tests.
#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const ADMIN: Symbol = symbol_short!("ADMIN");
const MAX_TIX: Symbol = symbol_short!("MAX_TIX");
const PRICE: Symbol = symbol_short!("PRICE");
const NEXT_ID: Symbol = symbol_short!("NEXT_ID");

// ── Data types ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum TicketStatus {
    Valid,
    Used,
    Transferred,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Ticket {
    pub id: u64,
    pub owner: Address,
    pub event_name: String,
    pub status: TicketStatus,
    pub original_price: i128,
    pub max_resale_price: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotFound = 1,
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct TicketContract;

#[contractimpl]
impl TicketContract {
    /// Initialize the event. Must be called once by the organizer.
    pub fn initialize(
        env: Env,
        admin: Address,
        event_name: String,
        max_tickets: u64,
        price: i128,
        max_resale_price: i128,
    ) {
        admin.require_auth();
        assert!(!env.storage().instance().has(&ADMIN), "already initialized");

        env.storage().instance().set(&ADMIN, &admin);
        env.storage().instance().set(&MAX_TIX, &max_tickets);
        env.storage().instance().set(&PRICE, &price);
        env.storage()
            .instance()
            .set(&symbol_short!("EVT_NAME"), &event_name);
        env.storage()
            .instance()
            .set(&symbol_short!("MAXRESALE"), &max_resale_price);
        env.storage().instance().set(&NEXT_ID, &0u64);
    }

    /// Mint a ticket to a recipient. Only admin (organizer) can call this.
    pub fn mint_ticket(env: Env, organizer: Address, recipient: Address) -> u64 {
        organizer.require_auth();
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        assert!(organizer == admin, "only organizer can mint");

        let max: u64 = env.storage().instance().get(&MAX_TIX).unwrap();
        let next_id: u64 = env.storage().instance().get(&NEXT_ID).unwrap();
        assert!(next_id < max, "sold out");

        let price: i128 = env.storage().instance().get(&PRICE).unwrap();
        let max_resale: i128 = env
            .storage()
            .instance()
            .get(&symbol_short!("MAXRESALE"))
            .unwrap();
        let event_name: String = env
            .storage()
            .instance()
            .get(&symbol_short!("EVT_NAME"))
            .unwrap();

        let ticket = Ticket {
            id: next_id,
            owner: recipient.clone(),
            event_name,
            status: TicketStatus::Valid,
            original_price: price,
            max_resale_price: max_resale,
        };

        env.storage().persistent().set(&next_id, &ticket);
        env.storage().instance().set(&NEXT_ID, &(next_id + 1));

        env.events()
            .publish((symbol_short!("MINTED"), recipient), next_id);

        next_id
    }

    /// Transfer a ticket from one user to another, enforcing resale price cap.
    pub fn transfer_ticket(env: Env, from: Address, to: Address, ticket_id: u64, sale_price: i128) {
        from.require_auth();

        let mut ticket: Ticket = env
            .storage()
            .persistent()
            .get(&ticket_id)
            .expect("ticket not found");

        assert!(ticket.owner == from, "not the ticket owner");
        assert!(
            ticket.status == TicketStatus::Valid,
            "ticket not transferable"
        );
        assert!(
            sale_price <= ticket.max_resale_price,
            "price exceeds resale cap"
        );

        ticket.owner = to.clone();
        ticket.status = TicketStatus::Transferred;
        env.storage().persistent().set(&ticket_id, &ticket);

        env.events()
            .publish((symbol_short!("TRANSFER"), from, to), ticket_id);
    }

    /// Verify and mark a ticket as used at entry.
    pub fn verify_ticket(env: Env, verifier: Address, ticket_id: u64) -> bool {
        verifier.require_auth();
        let admin: Address = env.storage().instance().get(&ADMIN).unwrap();
        assert!(verifier == admin, "only organizer can verify");

        let mut ticket: Ticket = env
            .storage()
            .persistent()
            .get(&ticket_id)
            .expect("ticket not found");

        if ticket.status == TicketStatus::Valid || ticket.status == TicketStatus::Transferred {
            ticket.status = TicketStatus::Used;
            env.storage().persistent().set(&ticket_id, &ticket);
            env.events()
                .publish((symbol_short!("VERIFIED"),), ticket_id);
            true
        } else {
            false
        }
    }

    /// Fetch ticket metadata.
    pub fn get_ticket(env: Env, ticket_id: u64) -> Result<Ticket, Error> {
        env.storage()
            .persistent()
            .get(&ticket_id)
            .ok_or(Error::NotFound)
    }

    /// Total tickets minted so far.
    pub fn tickets_sold(env: Env) -> u64 {
        env.storage().instance().get(&NEXT_ID).unwrap_or(0)
    }
}
