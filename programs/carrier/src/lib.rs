//! Carrier — value that travels by human movement and settles when anyone
//! reconnects.
//!
//! See `docs/PROTOCOL.md` for the design and, in particular, for what this
//! program does and does not claim about offline double spending.

use anchor_lang::prelude::*;

pub mod ed25519;
pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::{HopClaim, Note};

declare_id!("CJBPBb6WBPWptmpiW4Kdb7SeRC7Cmob5YAaBtKSMXBvt");

#[program]
pub mod carrier {
    use super::*;

    /// Commit funds up front so they can be spent with no connectivity.
    pub fn open_pouch(ctx: Context<OpenPouch>, amount: u64, bond: u64) -> Result<()> {
        instructions::open_pouch(ctx, amount, bond)
    }

    /// Add funds and start a new epoch, freeing all 256 note slots.
    pub fn refill_pouch(ctx: Context<RefillPouch>, amount: u64) -> Result<()> {
        instructions::refill_pouch(ctx, amount)
    }

    /// Settle one offline note and pay everyone who carried it.
    pub fn settle_note<'info>(
        ctx: Context<'info, SettleNote<'info>>,
        note: Note,
        hops: Vec<HopClaim>,
    ) -> Result<()> {
        instructions::settle_note(ctx, note, hops)
    }

    /// Recover the unspent balance and bond once the epoch can no longer settle.
    pub fn close_pouch(ctx: Context<ClosePouch>) -> Result<()> {
        instructions::close_pouch(ctx)
    }

    /// Slash the bond of a sender who signed two notes against the same slot.
    pub fn prove_double_spend(
        ctx: Context<ProveDoubleSpend>,
        note_a: Note,
        note_b: Note,
    ) -> Result<()> {
        instructions::prove_double_spend(ctx, note_a, note_b)
    }
}
