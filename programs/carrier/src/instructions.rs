use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, StateWithExtensions},
};
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;

use crate::ed25519::{collect_verified_signatures, require_signed};
use crate::errors::CarrierError;
use crate::rules::{
    check_hop_time, mint_extension_allowed, split_payout, split_slash, BPS_DENOMINATOR,
};
use crate::state::*;

pub const POUCH_SEED: &[u8] = b"pouch";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DRAFT_SEED: &[u8] = b"draft";
pub const CLAIM_SEED: &[u8] = b"claim";

// The pouch is about 2 KB (the per-slot fingerprints), so every instruction
// holds it in a `Box`. On the stack it would crowd the 4 KB SBF frame.

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
    pub pouch: Box<Account<'info, Pouch>>,

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
    check_mint_extensions(&ctx.accounts.mint.to_account_info())?;

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

    let now = Clock::get()?.unix_timestamp;
    let pouch = &mut ctx.accounts.pouch;
    pouch.owner = ctx.accounts.owner.key();
    pouch.mint = ctx.accounts.mint.key();
    pouch.committed = amount;
    pouch.settled = 0;
    pouch.bond = bond;
    // The first epoch is the time of opening, not 0.
    //
    // The pouch address is the same every time an owner reopens it, so if epochs
    // restarted at 0, an old settled note (public onchain) and a new honest note
    // for the same slot would look like a double spend. A pouch can only close
    // after `slashing_ends_at`, which is more than 37 days after its last epoch
    // began, and each `advance_epoch` also needs 37 days. So the epoch goes up
    // by at most one per 37 days, and a reopened pouch starts above any epoch
    // the old one reached. (The settled-note fingerprints, which start empty,
    // also block proofs that mix the two.)
    pouch.epoch = u32::try_from(now).map_err(|_| CarrierError::MathOverflow)?;
    pouch.epoch_started_at = now;
    pouch.clear_slots();
    pouch.bump = ctx.bumps.pouch;
    pouch.vault_bump = ctx.bumps.vault;

    Ok(())
}

/// Refuse Token-2022 mints whose extensions could break the vault's books.
/// See `rules::mint_extension_allowed`.
fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    if *mint.owner != spl_token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)?;
    for extension in state.get_extension_types()? {
        require!(
            mint_extension_allowed(extension),
            CarrierError::UnsupportedMintExtension
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// refill_pouch / add_bond
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct FundPouch<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = pouch.bump,
        has_one = owner,
        has_one = mint,
    )]
    pub pouch: Box<Account<'info, Pouch>>,

    #[account(mut, seeds = [VAULT_SEED, pouch.key().as_ref()], bump = pouch.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = owner)]
    pub funding: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Add spendable funds. The epoch does not change, so notes already handed
/// over stay settleable.
pub fn refill_pouch(ctx: Context<FundPouch>, amount: u64) -> Result<()> {
    fund(&ctx, amount)?;
    let pouch = &mut ctx.accounts.pouch;
    pouch.committed = pouch
        .committed
        .checked_add(amount)
        .ok_or(CarrierError::MathOverflow)?;
    Ok(())
}

/// Add to the bond, for example after a slash paid some of it out.
pub fn add_bond(ctx: Context<FundPouch>, amount: u64) -> Result<()> {
    fund(&ctx, amount)?;
    let pouch = &mut ctx.accounts.pouch;
    pouch.bond = pouch
        .bond
        .checked_add(amount)
        .ok_or(CarrierError::MathOverflow)?;
    emit!(BondAdded {
        pouch: pouch.key(),
        amount,
        bond: pouch.bond,
    });
    Ok(())
}

/// Move `amount` from the owner into the vault.
fn fund(ctx: &Context<FundPouch>, amount: u64) -> Result<()> {
    transfer_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.funding,
        &ctx.accounts.vault,
        &ctx.accounts.mint,
        ctx.accounts.owner.to_account_info(),
        amount,
        None,
    )
}

// ---------------------------------------------------------------------------
// advance_epoch
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct AdvanceEpoch<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, owner.key().as_ref(), pouch.mint.as_ref()],
        bump = pouch.bump,
        has_one = owner,
    )]
    pub pouch: Box<Account<'info, Pouch>>,
}

/// Start a new epoch and free all 256 slots.
///
/// Only once the current epoch is over: no note from it can settle, and the
/// grace period for double-spend proofs has passed. Before that, bumping the
/// epoch would void every note the owner has already handed over.
pub fn advance_epoch(ctx: Context<AdvanceEpoch>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pouch = &mut ctx.accounts.pouch;
    require!(now > pouch.slashing_ends_at(), CarrierError::EpochStillOpen);

    pouch.epoch = pouch.epoch.checked_add(1).ok_or(CarrierError::MathOverflow)?;
    pouch.epoch_started_at = now;
    pouch.clear_slots();

    emit!(EpochAdvanced {
        pouch: pouch.key(),
        epoch: pouch.epoch,
        started_at: now,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// settle_note
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SettleNote<'info> {
    /// Whoever reconnected first. Pays the transaction fee. Earns nothing from
    /// the note: relay fee nobody earned stays in the vault. Does not need to
    /// be party to the payment.
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, pouch.owner.as_ref(), pouch.mint.as_ref()],
        bump = pouch.bump,
        has_one = mint,
    )]
    pub pouch: Box<Account<'info, Pouch>>,

    #[account(mut, seeds = [VAULT_SEED, pouch.key().as_ref()], bump = pouch.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint)]
    pub recipient: InterfaceAccount<'info, TokenAccount>,

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
    claims: Vec<HopClaim>,
) -> Result<()> {
    let clock = Clock::get()?;

    // --- note validity -----------------------------------------------------
    require_keys_eq!(note.pouch, ctx.accounts.pouch.key(), CarrierError::PouchMismatch);
    require!(note.epoch == ctx.accounts.pouch.epoch, CarrierError::EpochMismatch);
    require!(clock.unix_timestamp <= note.expiry, CarrierError::NoteExpired);
    // Bounding expiry is what makes `close_pouch` safe: past this instant the
    // owner may withdraw knowing nothing else can settle against the epoch.
    require!(
        note.expiry <= ctx.accounts.pouch.epoch_closes_at(),
        CarrierError::NoteLifetimeTooLong
    );
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
    require_signed(&verified, &ctx.accounts.pouch.owner, &note.signing_payload())?;

    // Each handoff was co-signed by both devices, which is what makes a hop a
    // proof of physical proximity rather than a claim.
    let note_hash = note.hash();
    require!(claims.len() <= MAX_HOPS, CarrierError::TooManyHops);
    require!(
        ctx.remaining_accounts.len() == claims.len(),
        CarrierError::RelayerAccountsMismatch
    );

    // Rebuild each hop from its position rather than trusting transmitted
    // values. A chain that disagrees with what was signed cannot be expressed:
    // the reconstructed hop simply produces a different digest, and the
    // signature check below fails.
    let mut relayers: Vec<Pubkey> = Vec::with_capacity(claims.len());
    let mut prev = ctx.accounts.pouch.owner;
    for (i, claim) in claims.iter().enumerate() {
        check_hop_time(claim.at, ctx.accounts.pouch.epoch_started_at, clock.unix_timestamp)?;

        let hop = claim.expand(note_hash, prev, i as u8);
        let payload = hop.signing_payload();
        require_signed(&verified, &hop.relayer, &payload)?;
        require_signed(&verified, &hop.prev, &payload)?;

        check_carrier_eligible(&hop.relayer, &relayers, &note, &ctx.accounts.pouch.owner)?;

        prev = hop.relayer;
        relayers.push(hop.relayer);
    }

    pay_out_and_commit(
        Payout {
            token_program: &ctx.accounts.token_program,
            vault: &ctx.accounts.vault,
            recipient: &ctx.accounts.recipient,
            mint: &ctx.accounts.mint,
            pouch_account: ctx.accounts.pouch.to_account_info(),
            relayer_accounts: ctx.remaining_accounts,
        },
        &mut ctx.accounts.pouch,
        &note,
        note_hash,
        &relayers,
        ctx.accounts.settler.key(),
    )
}

// ---------------------------------------------------------------------------
// prove_double_spend
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(note_a: Note, note_b: Note)]
pub struct ProveDoubleSpend<'info> {
    /// Anyone. Pays the claim record's rent and gets a tenth of the loss, if
    /// bond is left after the victim.
    #[account(mut)]
    pub prover: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, pouch.owner.as_ref(), pouch.mint.as_ref()],
        bump = pouch.bump,
        has_one = mint,
    )]
    pub pouch: Box<Account<'info, Pouch>>,

    #[account(mut, seeds = [VAULT_SEED, pouch.key().as_ref()], bump = pouch.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// A token account of the losing note's recipient. Checked in the handler.
    #[account(mut, token::mint = mint)]
    pub victim: InterfaceAccount<'info, TokenAccount>,

    /// Where the prover's cut goes. May be the victim's own account, since the
    /// victim is often the one who proves; `dup` lets Anchor accept that.
    #[account(mut, dup, token::mint = mint)]
    pub prover_payout: InterfaceAccount<'info, TokenAccount>,

    /// One per losing note. `init` fails if it exists, so a note is paid once.
    #[account(
        init,
        payer = prover,
        space = 8 + DoubleSpendClaim::INIT_SPACE,
        seeds = [CLAIM_SEED, pouch.key().as_ref(), note_b.hash().as_ref()],
        bump,
    )]
    pub claim: Account<'info, DoubleSpendClaim>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    /// CHECK: address-constrained to the instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Compensate the holder of a note that lost its slot to another note.
///
/// `note_a` is the note that settled. `note_b` is the one that lost. Both must
/// be signed by the owner for the same slot of the current epoch, and the pouch
/// must record `note_a` as the note that took the slot. That last check is what
/// stops anyone from slashing with two notes where neither settled, or with a
/// note from before the pouch was reopened.
///
/// The money goes to `note_b`'s recipient, whoever sends the proof. The
/// cheating owner can no longer take their own bond back by proving first.
///
/// We do not also require `note_b`'s fingerprint to differ from `note_a`'s.
/// Only the owner can make two notes share one, and if they did, that check
/// would let them make the losing note unclaimable.
pub fn prove_double_spend(
    ctx: Context<ProveDoubleSpend>,
    note_a: Note,
    note_b: Note,
) -> Result<()> {
    let pouch_key = ctx.accounts.pouch.key();
    let hash_a = note_a.hash();
    let hash_b = note_b.hash();
    require!(hash_a != hash_b, CarrierError::NotesIdentical);

    require!(
        note_a.pouch == note_b.pouch
            && note_a.epoch == note_b.epoch
            && note_a.slot_index == note_b.slot_index,
        CarrierError::NotesNotConflicting
    );
    require_keys_eq!(note_a.pouch, pouch_key, CarrierError::NotesNotConflicting);
    require!(note_b.epoch == ctx.accounts.pouch.epoch, CarrierError::EpochMismatch);
    require!(
        ctx.accounts.pouch.settled_with(note_a.slot_index, &hash_a),
        CarrierError::NoteNotSettled
    );

    require!(note_b.to != ctx.accounts.pouch.owner, CarrierError::VictimIsOwner);
    require_keys_eq!(
        ctx.accounts.victim.owner,
        note_b.to,
        CarrierError::VictimMismatch
    );

    let verified = collect_verified_signatures(&ctx.accounts.instructions)?;
    require_signed(&verified, &ctx.accounts.pouch.owner, &note_a.signing_payload())?;
    require_signed(&verified, &ctx.accounts.pouch.owner, &note_b.signing_payload())?;

    let bond = ctx.accounts.pouch.bond;
    require!(bond > 0, CarrierError::NothingToSlash);
    let slash = split_slash(bond, note_b.amount);

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
        slash.to_victim,
        Some(signer_seeds),
    )?;
    transfer_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.prover_payout,
        &ctx.accounts.mint,
        ctx.accounts.pouch.to_account_info(),
        slash.to_prover,
        Some(signer_seeds),
    )?;

    ctx.accounts.pouch.bond = slash.bond_left;

    let claim = &mut ctx.accounts.claim;
    claim.victim = note_b.to;
    claim.paid = slash.to_victim;

    emit!(DoubleSpendProven {
        pouch: pouch_key,
        slot_index: note_a.slot_index,
        epoch: note_a.epoch,
        note_a: hash_a,
        note_b: hash_b,
        victim: note_b.to,
        paid_victim: slash.to_victim,
        paid_prover: slash.to_prover,
        bond_left: slash.bond_left,
        prover: ctx.accounts.prover.key(),
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// close_pouch
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClosePouch<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = pouch.bump,
        has_one = owner,
        has_one = mint,
        close = owner,
    )]
    pub pouch: Box<Account<'info, Pouch>>,

    #[account(mut, seeds = [VAULT_SEED, pouch.key().as_ref()], bump = pouch.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = owner)]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Recover everything left in the pouch once the epoch is over.
///
/// Without this, committed funds are locked forever — the vault has to stay
/// solvent for any note still in someone's pocket, and nothing ever told it when
/// that stopped being possible. `MAX_NOTE_LIFETIME_SECONDS` is what ends it:
/// `settle_note` refuses notes expiring past `epoch_closes_at`, so once that
/// instant passes the remaining balance is provably unclaimable by anyone else.
///
/// It then waits `SLASH_GRACE_SECONDS` more, so a victim who found out late
/// can still prove a double spend against the bond before it leaves.
///
/// This returns the unspent balance *and* whatever bond is left.
pub fn close_pouch(ctx: Context<ClosePouch>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now > ctx.accounts.pouch.slashing_ends_at(),
        CarrierError::PouchNotDrainable
    );

    let pouch_owner = ctx.accounts.pouch.owner;
    let pouch_mint = ctx.accounts.pouch.mint;
    let pouch_bump = ctx.accounts.pouch.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        POUCH_SEED,
        pouch_owner.as_ref(),
        pouch_mint.as_ref(),
        &[pouch_bump],
    ]];

    // Drain whatever is actually in the vault rather than a computed figure, so
    // relay fee nobody earned leaves with the owner instead of being stranded
    // in a closed account.
    let remaining = ctx.accounts.vault.amount;
    transfer_tokens(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.destination,
        &ctx.accounts.mint,
        ctx.accounts.pouch.to_account_info(),
        remaining,
        Some(signer_seeds),
    )?;

    // Reclaim the vault's rent too; `close = owner` on the pouch handles its own.
    token_interface::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        token_interface::CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: ctx.accounts.pouch.to_account_info(),
        },
        signer_seeds,
    ))?;

    emit!(PouchClosed {
        pouch: ctx.accounts.pouch.key(),
        owner: pouch_owner,
        returned: remaining,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

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

/// Reject a carrier that has no business being paid for this note.
///
/// Two rules, both cheap and both closing a way to take relay fees without
/// carrying anything:
///
/// - **No repeats.** A key may appear once in a chain. Without this, one device
///   can pass a note back and forth with an accomplice to manufacture hops.
/// - **No self-dealing.** The sender and the recipient are parties to the
///   payment, not carriers of it; paying them a relay fee is just the sender
///   discounting their own note at the honest carriers' expense.
///
/// Neither rule stops one person with two phones — nothing at this layer can,
/// because two phones in one pocket are genuinely two keys that genuinely met.
/// What bounds that attack is economic: `relay_fee_bps` fixes the pot before the
/// note ever leaves, and every extra hop divides it further rather than adding
/// to it. Inflating a chain dilutes your own share; it does not mint a new one.
fn check_carrier_eligible(
    relayer: &Pubkey,
    chain_so_far: &[Pubkey],
    note: &Note,
    pouch_owner: &Pubkey,
) -> Result<()> {
    require!(
        !chain_so_far.contains(relayer),
        CarrierError::RepeatedCarrier
    );
    require!(
        relayer != pouch_owner && *relayer != note.to,
        CarrierError::SelfDealingCarrier
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// shared payout
// ---------------------------------------------------------------------------

/// The accounts a payout touches, independent of which instruction is paying.
///
/// Both settlement paths end identically — the difference is only in how the
/// chain got verified — so the money movement lives in one place rather than
/// being written twice and drifting.
struct Payout<'a, 'info> {
    token_program: &'a Interface<'info, TokenInterface>,
    vault: &'a InterfaceAccount<'info, TokenAccount>,
    recipient: &'a InterfaceAccount<'info, TokenAccount>,
    mint: &'a InterfaceAccount<'info, Mint>,
    pouch_account: AccountInfo<'info>,
    /// One token account per relayer, in lineage order. Borrowed for `'info`
    /// rather than `'a` because `InterfaceAccount::try_from` needs a reference
    /// that lives as long as the account data it wraps.
    relayer_accounts: &'info [AccountInfo<'info>],
}

/// Pay the recipient and everyone who carried the note, then mark the slot.
///
/// Relay fee nobody earned (all of it with no hops, plus rounding dust) stays
/// in the vault. `settled` grows only by what left, so that part stays in
/// `available()` for the owner's next notes and returns on `close_pouch`.
fn pay_out_and_commit<'info>(
    accounts: Payout<'_, 'info>,
    pouch: &mut Account<'info, Pouch>,
    note: &Note,
    note_hash: [u8; 32],
    relayers: &[Pubkey],
    settled_by: Pubkey,
) -> Result<()> {
    require!(
        accounts.relayer_accounts.len() == relayers.len(),
        CarrierError::RelayerAccountsMismatch
    );

    let split = split_payout(note.amount, note.relay_fee_bps, relayers.len())?;

    let pouch_key = pouch.key();
    let pouch_owner = pouch.owner;
    let pouch_mint = pouch.mint;
    let pouch_bump = pouch.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        POUCH_SEED,
        pouch_owner.as_ref(),
        pouch_mint.as_ref(),
        &[pouch_bump],
    ]];

    transfer_tokens(
        accounts.token_program,
        accounts.vault,
        accounts.recipient,
        accounts.mint,
        accounts.pouch_account.clone(),
        split.to_recipient,
        Some(signer_seeds),
    )?;

    let mut lineage = Vec::with_capacity(relayers.len() + 1);
    lineage.push(pouch_owner);

    for (relayer, account) in relayers.iter().zip(accounts.relayer_accounts.iter()) {
        let parsed = InterfaceAccount::<TokenAccount>::try_from(account)?;
        require_keys_eq!(parsed.owner, *relayer, CarrierError::RelayerMismatch);
        require_keys_eq!(parsed.mint, pouch_mint, CarrierError::RelayerMismatch);

        transfer_tokens(
            accounts.token_program,
            accounts.vault,
            &parsed,
            accounts.mint,
            accounts.pouch_account.clone(),
            split.per_relayer,
            Some(signer_seeds),
        )?;
        lineage.push(*relayer);
    }

    pouch.record_settled(note.slot_index, &note_hash);
    pouch.settled = pouch
        .settled
        .checked_add(split.paid_out)
        .ok_or(CarrierError::MathOverflow)?;

    emit!(NoteSettled {
        pouch: pouch_key,
        note_hash,
        to: note.to,
        amount: note.amount,
        slot_index: note.slot_index,
        epoch: note.epoch,
        lineage,
        relay_fee_paid: split.to_relayers,
        relay_fee_kept: split.kept,
        settled_by,
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// begin_settlement / extend_settlement / finalize_settlement
// ---------------------------------------------------------------------------
//
// Chains longer than MAX_HOPS cannot be verified in one transaction: each hop
// costs two 96-byte signatures and a transaction is capped at 1232 bytes. These
// three instructions accumulate the same verification across several
// transactions into a draft account, so chain length stops being bounded by
// what fits in a packet.
//
// A draft's address is `["draft", pouch, note_hash, settler]`. The note hash
// means a second note for the same slot cannot take the first one's draft. The
// settler means nobody can sit on a note's only draft: anyone else holding the
// note opens their own, and whichever finalizes first takes the slot.

#[derive(Accounts)]
#[instruction(note: Note)]
pub struct BeginSettlement<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        seeds = [POUCH_SEED, pouch.owner.as_ref(), pouch.mint.as_ref()],
        bump = pouch.bump,
    )]
    pub pouch: Box<Account<'info, Pouch>>,

    #[account(
        init,
        payer = settler,
        space = 8 + SettlementDraft::INIT_SPACE,
        seeds = [
            DRAFT_SEED,
            pouch.key().as_ref(),
            note.hash().as_ref(),
            settler.key().as_ref(),
        ],
        bump,
    )]
    pub draft: Account<'info, SettlementDraft>,

    /// CHECK: address-constrained to the instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Open a draft by proving the sender authorised this note.
pub fn begin_settlement(ctx: Context<BeginSettlement>, note: Note) -> Result<()> {
    let clock = Clock::get()?;
    let pouch = &ctx.accounts.pouch;

    require_keys_eq!(note.pouch, pouch.key(), CarrierError::PouchMismatch);
    require!(note.epoch == pouch.epoch, CarrierError::EpochMismatch);
    require!(clock.unix_timestamp <= note.expiry, CarrierError::NoteExpired);
    require!(
        note.expiry <= pouch.epoch_closes_at(),
        CarrierError::NoteLifetimeTooLong
    );
    require!(
        !pouch.is_slot_spent(note.slot_index),
        CarrierError::SlotAlreadySpent
    );
    // Fail now rather than after every hop has been paid for.
    require!(
        u64::from(note.relay_fee_bps) <= BPS_DENOMINATOR,
        CarrierError::RelayFeeTooHigh
    );

    let verified = collect_verified_signatures(&ctx.accounts.instructions)?;
    require_signed(&verified, &pouch.owner, &note.signing_payload())?;

    let note_hash = note.hash();
    let draft = &mut ctx.accounts.draft;
    draft.note = note;
    draft.note_hash = note_hash;
    draft.pouch = pouch.key();
    draft.owner = pouch.owner;
    draft.settler = ctx.accounts.settler.key();
    draft.epoch_started_at = pouch.epoch_started_at;
    draft.next_seq = 0;
    draft.last_carrier = pouch.owner;
    draft.lineage = Vec::new();
    draft.bump = ctx.bumps.draft;

    emit!(SettlementStarted {
        pouch: pouch.key(),
        note_hash,
        settler: ctx.accounts.settler.key(),
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExtendSettlement<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [
            DRAFT_SEED,
            draft.pouch.as_ref(),
            draft.note_hash.as_ref(),
            draft.settler.as_ref(),
        ],
        bump = draft.bump,
        has_one = settler,
    )]
    pub draft: Account<'info, SettlementDraft>,

    /// CHECK: address-constrained to the instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Verify the next few hops and append them to the draft.
///
/// Called as many times as the chain needs. Each call takes whatever fits in one
/// transaction; the draft remembers where the chain had got to, so a hop can
/// only ever extend the one already verified.
pub fn extend_settlement(
    ctx: Context<ExtendSettlement>,
    claims: Vec<HopClaim>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let verified = collect_verified_signatures(&ctx.accounts.instructions)?;
    let draft = &mut ctx.accounts.draft;

    require!(
        draft.lineage.len() + claims.len() <= MAX_CHAIN,
        CarrierError::TooManyHops
    );

    for claim in claims.iter() {
        check_hop_time(claim.at, draft.epoch_started_at, now)?;

        let hop = claim.expand(draft.note_hash, draft.last_carrier, draft.next_seq);
        let payload = hop.signing_payload();
        require_signed(&verified, &hop.relayer, &payload)?;
        require_signed(&verified, &hop.prev, &payload)?;

        check_carrier_eligible(&hop.relayer, &draft.lineage, &draft.note, &draft.owner)?;

        draft.lineage.push(hop.relayer);
        draft.last_carrier = hop.relayer;
        draft.next_seq = draft
            .next_seq
            .checked_add(1)
            .ok_or(CarrierError::MathOverflow)?;
    }

    emit!(SettlementExtended {
        note_hash: draft.note_hash,
        hops_verified: draft.lineage.len() as u8,
        last_carrier: draft.last_carrier,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeSettlement<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [POUCH_SEED, pouch.owner.as_ref(), pouch.mint.as_ref()],
        bump = pouch.bump,
        has_one = mint,
    )]
    pub pouch: Box<Account<'info, Pouch>>,

    #[account(
        mut,
        seeds = [
            DRAFT_SEED,
            draft.pouch.as_ref(),
            draft.note_hash.as_ref(),
            draft.settler.as_ref(),
        ],
        bump = draft.bump,
        has_one = settler,
        // Rent returns to whoever fronted it once the draft has done its job.
        close = settler,
    )]
    pub draft: Account<'info, SettlementDraft>,

    #[account(mut, seeds = [VAULT_SEED, pouch.key().as_ref()], bump = pouch.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, token::mint = mint)]
    pub recipient: InterfaceAccount<'info, TokenAccount>,

    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: one token account per relayer, in lineage order.
}

/// Pay out a fully verified chain.
pub fn finalize_settlement<'info>(
    ctx: Context<'info, FinalizeSettlement<'info>>,
) -> Result<()> {
    let clock = Clock::get()?;
    let note = ctx.accounts.draft.note.clone();
    let note_hash = ctx.accounts.draft.note_hash;
    let relayers = ctx.accounts.draft.lineage.clone();

    require_keys_eq!(
        ctx.accounts.draft.pouch,
        ctx.accounts.pouch.key(),
        CarrierError::PouchMismatch
    );
    require!(note.epoch == ctx.accounts.pouch.epoch, CarrierError::EpochMismatch);
    require!(clock.unix_timestamp <= note.expiry, CarrierError::NoteExpired);
    // Re-checked here, not just at begin: a draft can sit open across many
    // transactions, and another draft or the single-transaction path could
    // have taken the slot in the meantime.
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

    pay_out_and_commit(
        Payout {
            token_program: &ctx.accounts.token_program,
            vault: &ctx.accounts.vault,
            recipient: &ctx.accounts.recipient,
            mint: &ctx.accounts.mint,
            pouch_account: ctx.accounts.pouch.to_account_info(),
            relayer_accounts: ctx.remaining_accounts,
        },
        &mut ctx.accounts.pouch,
        &note,
        note_hash,
        &relayers,
        ctx.accounts.settler.key(),
    )
}

#[derive(Accounts)]
pub struct AbandonSettlement<'info> {
    #[account(mut)]
    pub settler: Signer<'info>,

    #[account(
        mut,
        seeds = [
            DRAFT_SEED,
            draft.pouch.as_ref(),
            draft.note_hash.as_ref(),
            draft.settler.as_ref(),
        ],
        bump = draft.bump,
        has_one = settler,
        close = settler,
    )]
    pub draft: Account<'info, SettlementDraft>,
}

/// Give up on a draft and reclaim its rent.
pub fn abandon_settlement(_ctx: Context<AbandonSettlement>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct CloseExpiredDraft<'info> {
    #[account(
        mut,
        seeds = [
            DRAFT_SEED,
            draft.pouch.as_ref(),
            draft.note_hash.as_ref(),
            draft.settler.as_ref(),
        ],
        bump = draft.bump,
        has_one = settler,
        close = settler,
    )]
    pub draft: Account<'info, SettlementDraft>,

    /// CHECK: only receives the draft's rent; `has_one` pins it to the draft's
    /// settler.
    #[account(mut)]
    pub settler: UncheckedAccount<'info>,
}

/// Close a draft whose note has expired. Anyone may call it; the rent goes back
/// to the settler who opened it. An expired note can never finalize, so this
/// only clears an account that can no longer do anything.
pub fn close_expired_draft(ctx: Context<CloseExpiredDraft>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now > ctx.accounts.draft.note.expiry,
        CarrierError::DraftNotExpired
    );
    Ok(())
}
