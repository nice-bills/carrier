//! Carrier — value that travels by human movement and settles when anyone
//! reconnects.
//!
//! See `docs/PROTOCOL.md` for the design and, in particular, for what this
//! program does and does not claim about offline double spending.

use anchor_lang::prelude::*;

pub mod ed25519;
pub mod errors;
pub mod instructions;
pub mod rules;
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

    /// Add spendable funds. Does not change the epoch.
    pub fn refill_pouch(ctx: Context<FundPouch>, amount: u64) -> Result<()> {
        instructions::refill_pouch(ctx, amount)
    }

    /// Add to the slashable bond.
    pub fn add_bond(ctx: Context<FundPouch>, amount: u64) -> Result<()> {
        instructions::add_bond(ctx, amount)
    }

    /// Start a new epoch, freeing all 256 note slots. Only after the current
    /// epoch has closed and its slashing grace period has passed.
    pub fn advance_epoch(ctx: Context<AdvanceEpoch>) -> Result<()> {
        instructions::advance_epoch(ctx)
    }

    /// Settle one offline note and pay everyone who carried it.
    pub fn settle_note<'info>(
        ctx: Context<'info, SettleNote<'info>>,
        note: Note,
        hops: Vec<HopClaim>,
    ) -> Result<()> {
        instructions::settle_note(ctx, note, hops)
    }

    /// Open a draft so a long chain can be verified across several transactions.
    pub fn begin_settlement(ctx: Context<BeginSettlement>, note: Note) -> Result<()> {
        instructions::begin_settlement(ctx, note)
    }

    /// Verify the next few hops into an open draft.
    pub fn extend_settlement(
        ctx: Context<ExtendSettlement>,
        claims: Vec<HopClaim>,
    ) -> Result<()> {
        instructions::extend_settlement(ctx, claims)
    }

    /// Pay out a chain whose every hop has been verified.
    pub fn finalize_settlement<'info>(
        ctx: Context<'info, FinalizeSettlement<'info>>,
    ) -> Result<()> {
        instructions::finalize_settlement(ctx)
    }

    /// Give up on a draft and reclaim its rent.
    pub fn abandon_settlement(ctx: Context<AbandonSettlement>) -> Result<()> {
        instructions::abandon_settlement(ctx)
    }

    /// Let anyone close a draft whose note has expired. Rent goes to its settler.
    pub fn close_expired_draft(ctx: Context<CloseExpiredDraft>) -> Result<()> {
        instructions::close_expired_draft(ctx)
    }

    /// Recover the unspent balance and bond once the epoch can no longer settle
    /// and the slashing grace period has passed.
    pub fn close_pouch(ctx: Context<ClosePouch>) -> Result<()> {
        instructions::close_pouch(ctx)
    }

    /// Pay the holder of a note that lost its slot from the sender's bond.
    /// `note_a` settled; `note_b` lost.
    pub fn prove_double_spend(
        ctx: Context<ProveDoubleSpend>,
        note_a: Note,
        note_b: Note,
    ) -> Result<()> {
        instructions::prove_double_spend(ctx, note_a, note_b)
    }
}
