use anchor_lang::prelude::*;
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::ed25519::{collect_verified_signatures, require_signed};
use crate::errors::CarrierError;
use crate::state::*;

pub const POUCH_SEED: &[u8] = b"pouch";
pub const VAULT_SEED: &[u8] = b"vault";

const BPS_DENOMINATOR: u64 = 10_000;

// ---------------------------------------------------------------------------
// open_pouch
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct OpenPouch<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Pouch::INIT_SPACE,
        seeds = [POUCH_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub pouch: Account<'info, Pouch>,

    #[account(
        init,
        payer = owner,
        seeds = [VAULT_SEED, pouch.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pouch,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = owner)]
    pub funding: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Commit funds up front so they can be spent with no connectivity.
///
/// `bond` is the slashable stake that backs honest behaviour. It lives in the
/// same vault as the spendable funds but is tracked separately and is never
/// reachable by `settle_note`.
pub fn open_pouch(ctx: Context<OpenPouch>, amount: u64, bond: u64) -> Result<()> {
    let total = amount.checked_add(bond).ok_or(CarrierError::MathOverflow)?;

    transfer_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.funding,
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        ctx.accounts.owner.to_account_info(),
        total,
        None,
    )?;

    let pouch = &mut ctx.accounts.pouch;
    pouch.owner = ctx.accounts.owner.key();
    pouch.mint = ctx.accounts.mint.key();
    pouch.committed = amount;
    pouch.settled = 0;
    pouch.bond = bond;
    pouch.epoch = 0;
    pouch.clear_slots();
    pouch.bump = ctx.bumps.pouch;
    pouch.vault_bump = ctx.bumps.vault;

    Ok(())
}

// ---------------------------------------------------------------------------
// refill_pouch
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RefillPouch<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = pouch.bump,
        has_one = owner,
        has_one = mint,
    )]
    pub pouch: Account<'info, Pouch>,

    #[account(mut, seeds = [VAULT_SEED, pouch.key().as_ref()], bump = pouch.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = owner)]
    pub funding: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Add funds and start a new epoch.
///
/// Advancing the epoch frees all 256 note slots for reuse. Any note from a
/// previous epoch becomes permanently unsettleable, which is why the client
/// must not refill while notes are still in flight. Expiry is the safety net:
/// wait out the longest expiry you have issued before refilling.
pub fn refill_pouch(ctx: Context<RefillPouch>, amount: u64) -> Result<()> {
    transfer_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.funding,
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        ctx.accounts.owner.to_account_info(),
        amount,
        None,
    )?;

    let pouch = &mut ctx.accounts.pouch;
    pouch.committed = pouch
        .committed
        .checked_add(amount)
        .ok_or(CarrierError::MathOverflow)?;
    pouch.epoch = pouch.epoch.checked_add(1).ok_or(CarrierError::MathOverflow)?;
    pouch.clear_slots();

    Ok(())
}

// ---------------------------------------------------------------------------
// settle_note
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SettleNote<'info> {
    /// Whoever reconnected first. Pays the transaction fee, earns the remainder
    /// of the relay fee as a bounty. Does not need to be party to the payment.
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, pouch.owner.as_ref(), pouch.mint.as_ref()],
        bump = pouch.bump,
        has_one = mint,
    )]
    pub pouch: Account<'info, Pouch>,

    #[account(mut, seeds = [VAULT_SEED, pouch.key().as_ref()], bump = pouch.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint)]
    pub recipient: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint)]
    pub settler_payout: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: address-constrained to the instructions sysvar; read only via the
    /// checked `load_instruction_at_checked` helpers.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    // remaining_accounts: one token account per hop, in hop order, each owned by
    // that hop's relayer.
}

/// Settle one offline note and pay everyone who carried it.
///
/// Signatures were produced on devices that were never online, so there is no
/// `Signer` to lean on here — every signature is verified by the ed25519
/// precompile and matched via instruction introspection.
pub fn settle_note<'info>(
    ctx: Context<'info, SettleNote<'info>>,
    note: Note,
    hops: Vec<Hop>,
) -> Result<()> {
    let clock = Clock::get()?;

    // --- note validity -----------------------------------------------------
    require_keys_eq!(note.pouch, ctx.accounts.pouch.key(), CarrierError::EpochMismatch);
    require!(note.epoch == ctx.accounts.pouch.epoch, CarrierError::EpochMismatch);
    require!(clock.unix_timestamp <= note.expiry, CarrierError::NoteExpired);
    require!(
        !ctx.accounts.pouch.is_slot_spent(note.slot_index),
        CarrierError::SlotAlreadySpent
    );
    require!(
        note.amount <= ctx.accounts.pouch.available(),
        CarrierError::InsufficientCommitted
    );
    require_keys_eq!(
        ctx.accounts.recipient.owner,
        note.to,
        CarrierError::RecipientMismatch
    );

    // --- signature verification -------------------------------------------
    let verified = collect_verified_signatures(&ctx.accounts.instructions)?;

    // The sender authorised this exact note.
    require_signed(&verified, &ctx.accounts.pouch.owner, &note.message())?;

    // Each handoff was co-signed by both devices, which is what makes a hop a
    // proof of physical proximity rather than a claim.
    let note_hash = note.hash();
    require!(hops.len() <= MAX_HOPS, CarrierError::TooManyHops);
    require!(
        ctx.remaining_accounts.len() == hops.len(),
        CarrierError::RelayerAccountsMismatch
    );

    let mut expected_prev = ctx.accounts.pouch.owner;
    for (i, hop) in hops.iter().enumerate() {
        require!(hop.seq as usize == i, CarrierError::HopSequenceInvalid);
        require!(hop.note_hash == note_hash, CarrierError::HopNoteMismatch);
        require_keys_eq!(hop.prev, expected_prev, CarrierError::HopChainBroken);

        let message = hop.message();
        require_signed(&verified, &hop.relayer, &message)?;
        require_signed(&verified, &hop.prev, &message)?;

        expected_prev = hop.relayer;
    }

    // --- payouts -----------------------------------------------------------
    let relay_fee = (note.amount as u128)
        .checked_mul(note.relay_fee_bps as u128)
        .ok_or(CarrierError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(CarrierError::MathOverflow)? as u64;
    require!(relay_fee <= note.amount, CarrierError::RelayFeeTooHigh);

    let to_recipient = note.amount.checked_sub(relay_fee).ok_or(CarrierError::MathOverflow)?;
    let per_relayer = if hops.is_empty() {
        0
    } else {
        relay_fee / hops.len() as u64
    };
    let relayers_total = per_relayer
        .checked_mul(hops.len() as u64)
        .ok_or(CarrierError::MathOverflow)?;
    // Rounding dust plus the whole fee when nobody relayed goes to the settler,
    // who paid the transaction fee to bring this onchain.
    let settler_bounty = relay_fee.checked_sub(relayers_total).ok_or(CarrierError::MathOverflow)?;

    // Bind the borrow of pouch fields before taking a mutable borrow below.
    let pouch_key = ctx.accounts.pouch.key();
    let pouch_bump = ctx.accounts.pouch.bump;
    let pouch_owner = ctx.accounts.pouch.owner;
    let pouch_mint = ctx.accounts.pouch.mint;
    let signer_seeds: &[&[&[u8]]] = &[&[
        POUCH_SEED,
        pouch_owner.as_ref(),
        pouch_mint.as_ref(),
        &[pouch_bump],
    ]];

    transfer_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.recipient,
        &ctx.accounts.mint,
        ctx.accounts.pouch.to_account_info(),
        to_recipient,
        Some(signer_seeds),
    )?;

    let mut lineage = Vec::with_capacity(hops.len() + 1);
    lineage.push(pouch_owner);

    for (hop, relayer_account) in hops.iter().zip(ctx.remaining_accounts.iter()) {
        let parsed = InterfaceAccount::<TokenAccount>::try_from(relayer_account)?;
        require_keys_eq!(parsed.owner, hop.relayer, CarrierError::RelayerMismatch);
        require_keys_eq!(parsed.mint, pouch_mint, CarrierError::RelayerMismatch);

        if per_relayer > 0 {
            transfer_tokens(
                &ctx.accounts.token_program,
                &ctx.accounts.vault,
                &parsed,
                &ctx.accounts.mint,
                ctx.accounts.pouch.to_account_info(),
                per_relayer,
                Some(signer_seeds),
            )?;
        }
        lineage.push(hop.relayer);
    }

    if settler_bounty > 0 {
        transfer_tokens(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.settler_payout,
            &ctx.accounts.mint,
            ctx.accounts.pouch.to_account_info(),
            settler_bounty,
            Some(signer_seeds),
        )?;
    }

    // --- commit ------------------------------------------------------------
    let pouch = &mut ctx.accounts.pouch;
    pouch.mark_slot_spent(note.slot_index);
    pouch.settled = pouch
        .settled
        .checked_add(note.amount)
        .ok_or(CarrierError::MathOverflow)?;

    emit!(NoteSettled {
        pouch: pouch_key,
        note_hash,
        to: note.to,
        amount: note.amount,
        slot_index: note.slot_index,
        epoch: note.epoch,
        lineage,
        relay_fee_paid: relay_fee,
        settled_by: ctx.accounts.settler.key(),
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// prove_double_spend
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ProveDoubleSpend<'info> {
    #[account(mut)]
    pub prover: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, pouch.owner.as_ref(), pouch.mint.as_ref()],
        bump = pouch.bump,
        has_one = mint,
    )]
    pub pouch: Account<'info, Pouch>,

    #[account(mut, seeds = [VAULT_SEED, pouch.key().as_ref()], bump = pouch.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Holder of the note that lost the race. Made whole from the bond.
    #[account(mut, token::mint = mint)]
    pub victim: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint)]
    pub prover_payout: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,

    /// CHECK: address-constrained to the instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Two validly-signed notes against the same slot are proof the sender cheated.
///
/// The program verifies both signatures itself. There is no oracle and no
/// trusted reporter — anyone holding the losing note can bring this, and the
/// bond pays out.
pub fn prove_double_spend(
    ctx: Context<ProveDoubleSpend>,
    note_a: Note,
    note_b: Note,
) -> Result<()> {
    let hash_a = note_a.hash();
    let hash_b = note_b.hash();
    require!(hash_a != hash_b, CarrierError::NotesIdentical);

    require!(
        note_a.pouch == note_b.pouch
            && note_a.epoch == note_b.epoch
            && note_a.slot_index == note_b.slot_index,
        CarrierError::NotesNotConflicting
    );
    require_keys_eq!(note_a.pouch, ctx.accounts.pouch.key(), CarrierError::NotesNotConflicting);

    let verified = collect_verified_signatures(&ctx.accounts.instructions)?;
    require_signed(&verified, &ctx.accounts.pouch.owner, &note_a.message())?;
    require_signed(&verified, &ctx.accounts.pouch.owner, &note_b.message())?;

    let bond = ctx.accounts.pouch.bond;
    require!(bond > 0, CarrierError::NothingToSlash);

    // The victim is made whole first; the prover takes a tenth for doing the
    // work of bringing the proof onchain.
    let prover_cut = bond / 10;
    let victim_cut = bond.checked_sub(prover_cut).ok_or(CarrierError::MathOverflow)?;

    let pouch_owner = ctx.accounts.pouch.owner;
    let pouch_mint = ctx.accounts.pouch.mint;
    let pouch_bump = ctx.accounts.pouch.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        POUCH_SEED,
        pouch_owner.as_ref(),
        pouch_mint.as_ref(),
        &[pouch_bump],
    ]];

    transfer_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.victim,
        &ctx.accounts.mint,
        ctx.accounts.pouch.to_account_info(),
        victim_cut,
        Some(signer_seeds),
    )?;

    if prover_cut > 0 {
        transfer_tokens(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.prover_payout,
            &ctx.accounts.mint,
            ctx.accounts.pouch.to_account_info(),
            prover_cut,
            Some(signer_seeds),
        )?;
    }

    let pouch = &mut ctx.accounts.pouch;
    pouch.bond = 0;

    emit!(DoubleSpendProven {
        pouch: pouch.key(),
        slot_index: note_a.slot_index,
        epoch: note_a.epoch,
        note_a: hash_a,
        note_b: hash_b,
        slashed: bond,
        prover: ctx.accounts.prover.key(),
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn transfer_tokens<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: AccountInfo<'info>,
    amount: u64,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }

    let accounts = TransferChecked {
        from: from.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority,
    };

    let cpi = match signer_seeds {
        Some(seeds) => CpiContext::new_with_signer(token_program.key(), accounts, seeds),
        None => CpiContext::new(token_program.key(), accounts),
    };

    token_interface::transfer_checked(cpi, amount, mint.decimals)
}
