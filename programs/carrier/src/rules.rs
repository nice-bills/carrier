//! Pure arithmetic and checks, kept apart from account handling so they can be
//! unit-tested without a validator.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;

use crate::errors::CarrierError;
use crate::state::HOP_CLOCK_SKEW_SECONDS;

pub const BPS_DENOMINATOR: u64 = 10_000;

/// How one settled note's money leaves the vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Split {
    /// Whole relay fee the note set aside.
    pub relay_fee: u64,
    pub to_recipient: u64,
    pub per_relayer: u64,
    /// `per_relayer` times the number of relayers.
    pub to_relayers: u64,
    /// Relay fee nobody earned. Stays in the vault.
    pub kept: u64,
    /// What actually leaves the vault. This, not the note amount, is what
    /// `settled` grows by, so the kept part stays spendable by the owner.
    pub paid_out: u64,
}

/// Split a note between its recipient and its carriers.
///
/// Relay fee that no carrier earned stays in the vault. It used to go to
/// whoever settled, which paid them to drop hops: with no hops the settler took
/// the whole fee. Now dropping hops gains the settler nothing.
pub fn split_payout(amount: u64, relay_fee_bps: u16, relayers: usize) -> Result<Split> {
    require!(
        u64::from(relay_fee_bps) <= BPS_DENOMINATOR,
        CarrierError::RelayFeeTooHigh
    );
    let relay_fee = (amount as u128)
        .checked_mul(relay_fee_bps as u128)
        .ok_or(CarrierError::MathOverflow)?
        / BPS_DENOMINATOR as u128;
    let relay_fee = u64::try_from(relay_fee).map_err(|_| CarrierError::MathOverflow)?;
    require!(relay_fee <= amount, CarrierError::RelayFeeTooHigh);

    let to_recipient = amount - relay_fee;
    let n = u64::try_from(relayers).map_err(|_| CarrierError::MathOverflow)?;
    let per_relayer = relay_fee.checked_div(n).unwrap_or(0);
    let to_relayers = per_relayer
        .checked_mul(n)
        .ok_or(CarrierError::MathOverflow)?;
    let kept = relay_fee
        .checked_sub(to_relayers)
        .ok_or(CarrierError::MathOverflow)?;
    let paid_out = to_recipient
        .checked_add(to_relayers)
        .ok_or(CarrierError::MathOverflow)?;

    Ok(Split {
        relay_fee,
        to_recipient,
        per_relayer,
        to_relayers,
        kept,
        paid_out,
    })
}

/// How a slashed bond is shared for one losing note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slash {
    pub to_victim: u64,
    pub to_prover: u64,
    pub bond_left: u64,
}

/// The victim is paid first, up to what their note was worth. The prover then
/// gets a tenth of the note's amount, if bond remains. Only what is paid leaves
/// the bond, so what is left covers the next victim.
///
/// The prover's cut follows the loss, not the bond. A cut of a tenth of the
/// whole bond would let each tiny losing note take a tenth of what later
/// victims need.
pub fn split_slash(bond: u64, losing_amount: u64) -> Slash {
    let to_victim = losing_amount.min(bond);
    let rest = bond - to_victim;
    let to_prover = (losing_amount / 10).min(rest);
    Slash {
        to_victim,
        to_prover,
        bond_left: rest - to_prover,
    }
}

/// A hop's signed time must fall near the note's epoch.
///
/// Loose on purpose: phones keep bad time, and hops need not be in order. It
/// only rules out a hop dated before its epoch began, or far in the future.
pub fn check_hop_time(at: i64, epoch_started_at: i64, now: i64) -> Result<()> {
    require!(
        at >= epoch_started_at.saturating_sub(HOP_CLOCK_SKEW_SECONDS)
            && at <= now.saturating_add(HOP_CLOCK_SKEW_SECONDS),
        CarrierError::HopTimeOutOfRange
    );
    Ok(())
}

/// Token-2022 mint extensions a pouch can live with.
///
/// Only ones that describe the token and never touch a transfer. Transfer
/// fees leave the vault short of what it owes. A permanent delegate can empty
/// it. A transfer hook, pausing or a default frozen state can make every payout
/// fail. So everything not listed here is refused when the pouch opens.
pub fn mint_extension_allowed(extension: ExtensionType) -> bool {
    matches!(
        extension,
        ExtensionType::MetadataPointer
            | ExtensionType::TokenMetadata
            | ExtensionType::GroupPointer
            | ExtensionType::TokenGroup
            | ExtensionType::GroupMemberPointer
            | ExtensionType::TokenGroupMember
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_descriptive_mint_extensions_are_allowed() {
        assert!(mint_extension_allowed(ExtensionType::MetadataPointer));
        assert!(mint_extension_allowed(ExtensionType::TokenMetadata));
        for bad in [
            ExtensionType::TransferFeeConfig,
            ExtensionType::PermanentDelegate,
            ExtensionType::TransferHook,
            ExtensionType::DefaultAccountState,
            ExtensionType::Pausable,
            ExtensionType::NonTransferable,
            ExtensionType::ConfidentialTransferMint,
            ExtensionType::MintCloseAuthority,
            ExtensionType::InterestBearingConfig,
            ExtensionType::ScaledUiAmount,
        ] {
            assert!(!mint_extension_allowed(bad), "{bad:?} should be refused");
        }
    }

    #[test]
    fn zero_hops_pays_nobody_the_fee() {
        let s = split_payout(10_000, 200, 0).unwrap();
        assert_eq!(s.relay_fee, 200);
        assert_eq!(s.to_recipient, 9_800);
        assert_eq!(s.to_relayers, 0);
        assert_eq!(s.kept, 200);
        assert_eq!(s.paid_out, 9_800);
    }

    #[test]
    fn rounding_dust_stays_in_the_vault() {
        let s = split_payout(1_000, 100, 3).unwrap(); // fee 10, 3 carriers
        assert_eq!(s.per_relayer, 3);
        assert_eq!(s.to_relayers, 9);
        assert_eq!(s.kept, 1);
        assert_eq!(s.paid_out + s.kept, 1_000);
    }

    #[test]
    fn full_split_leaves_nothing_behind() {
        let s = split_payout(20_000_000, 400, 4).unwrap();
        assert_eq!(s.per_relayer, 200_000);
        assert_eq!(s.kept, 0);
        assert_eq!(s.paid_out, 20_000_000);
    }

    #[test]
    fn fee_over_the_whole_amount_is_refused() {
        assert!(split_payout(1_000, 10_001, 1).is_err());
        assert!(split_payout(1_000, u16::MAX, 1).is_err());
        let all = split_payout(1_000, 10_000, 2).unwrap();
        assert_eq!(all.to_recipient, 0);
        assert_eq!(all.per_relayer, 500);
    }

    #[test]
    fn huge_amounts_do_not_overflow() {
        let s = split_payout(u64::MAX, 10_000, 1).unwrap();
        assert_eq!(s.relay_fee, u64::MAX);
        assert_eq!(s.paid_out, u64::MAX);
        let s = split_payout(u64::MAX, 9_999, 7).unwrap();
        assert_eq!(s.paid_out + s.kept, u64::MAX);
    }

    #[test]
    fn slash_pays_the_victim_first_and_keeps_the_rest() {
        let s = split_slash(50, 3);
        assert_eq!(
            s,
            Slash {
                to_victim: 3,
                to_prover: 0,
                bond_left: 47
            }
        );

        let s = split_slash(1_000, 300);
        assert_eq!(
            s,
            Slash {
                to_victim: 300,
                to_prover: 30,
                bond_left: 670
            }
        );
    }

    #[test]
    fn slash_never_pays_more_than_the_bond() {
        let s = split_slash(100, 300);
        assert_eq!(
            s,
            Slash {
                to_victim: 100,
                to_prover: 0,
                bond_left: 0
            }
        );

        let s = split_slash(305, 300);
        assert_eq!(
            s,
            Slash {
                to_victim: 300,
                to_prover: 5,
                bond_left: 0
            }
        );

        let s = split_slash(0, 300);
        assert_eq!(
            s,
            Slash {
                to_victim: 0,
                to_prover: 0,
                bond_left: 0
            }
        );
    }

    #[test]
    fn hop_time_allows_skew_but_not_nonsense() {
        let start = 1_000_000;
        let now = start + 5_000;
        assert!(check_hop_time(start, start, now).is_ok());
        assert!(check_hop_time(start - HOP_CLOCK_SKEW_SECONDS, start, now).is_ok());
        assert!(check_hop_time(start - HOP_CLOCK_SKEW_SECONDS - 1, start, now).is_err());
        assert!(check_hop_time(now + HOP_CLOCK_SKEW_SECONDS, start, now).is_ok());
        assert!(check_hop_time(now + HOP_CLOCK_SKEW_SECONDS + 1, start, now).is_err());
        assert!(check_hop_time(i64::MIN, start, now).is_err());
        assert!(check_hop_time(i64::MAX, start, now).is_err());
    }
}
