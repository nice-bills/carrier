//! Verification of offline signatures via Solana's ed25519 precompile.
//!
//! Notes and hops are signed on phones that were never online. There is no
//! `Signer` account we can lean on at settlement — the signers are not present
//! in the transaction at all. So the client puts an ed25519 precompile
//! instruction in front of ours, the runtime verifies the signatures, and we
//! introspect the instruction sysvar to learn *what* was verified.
//!
//! The security property we need: never trust a `(pubkey, message)` pair unless
//! the precompile actually checked it in this same transaction.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;

use crate::errors::CarrierError;

/// Layout of one `Ed25519SignatureOffsets` entry in the precompile's data.
const OFFSETS_LEN: usize = 14;
/// `num_signatures: u8` + `padding: u8`
const HEADER_LEN: usize = 2;
/// Sentinel meaning "this same instruction".
const IX_INDEX_CURRENT: u16 = u16::MAX;

/// A `(pubkey, message)` pair the precompile verified in this transaction.
pub struct VerifiedSignature {
    pub pubkey: Pubkey,
    pub message: Vec<u8>,
}

/// Collect every signature the ed25519 precompile verified in this transaction.
///
/// Scans all instructions rather than assuming the precompile sits at index 0,
/// so callers are free to prepend compute-budget instructions.
pub fn collect_verified_signatures(
    instructions_sysvar: &AccountInfo,
) -> Result<Vec<VerifiedSignature>> {
    let current_index =
        load_current_index_checked(instructions_sysvar)? as usize;

    let mut verified = Vec::new();

    for index in 0..current_index {
        let ix = match load_instruction_at_checked(index, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        if ix.program_id != ed25519_program::ID {
            continue;
        }
        parse_precompile_data(&ix.data, index as u16, &mut verified)?;
    }

    Ok(verified)
}

/// Parse one ed25519 precompile instruction's data into verified pairs.
///
/// We only accept entries whose pubkey/message/signature all live inside this
/// same precompile instruction. Cross-instruction references are legal in the
/// precompile but we have no use for them, and refusing them keeps the parser
/// small enough to reason about.
fn parse_precompile_data(
    data: &[u8],
    own_index: u16,
    out: &mut Vec<VerifiedSignature>,
) -> Result<()> {
    if data.len() < HEADER_LEN {
        return err!(CarrierError::MalformedSignatureData);
    }

    let count = data[0] as usize;

    for i in 0..count {
        let start = HEADER_LEN + i * OFFSETS_LEN;
        let end = start + OFFSETS_LEN;
        if end > data.len() {
            return err!(CarrierError::MalformedSignatureData);
        }

        let raw = &data[start..end];
        let sig_ix_index = u16_at(raw, 2);
        let pubkey_offset = u16_at(raw, 4) as usize;
        let pubkey_ix_index = u16_at(raw, 6);
        let message_offset = u16_at(raw, 8) as usize;
        let message_size = u16_at(raw, 10) as usize;
        let message_ix_index = u16_at(raw, 12);

        let refers_to_self = |idx: u16| idx == IX_INDEX_CURRENT || idx == own_index;
        if !refers_to_self(sig_ix_index)
            || !refers_to_self(pubkey_ix_index)
            || !refers_to_self(message_ix_index)
        {
            return err!(CarrierError::UnsupportedSignatureLayout);
        }

        let pubkey_end = pubkey_offset
            .checked_add(32)
            .ok_or(CarrierError::MalformedSignatureData)?;
        let message_end = message_offset
            .checked_add(message_size)
            .ok_or(CarrierError::MalformedSignatureData)?;
        if pubkey_end > data.len() || message_end > data.len() {
            return err!(CarrierError::MalformedSignatureData);
        }

        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(&data[pubkey_offset..pubkey_end]);

        out.push(VerifiedSignature {
            pubkey: Pubkey::from(key_bytes),
            message: data[message_offset..message_end].to_vec(),
        });
    }

    Ok(())
}

#[inline]
fn u16_at(buf: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([buf[offset], buf[offset + 1]])
}

/// Assert that `pubkey` signed exactly `message` in this transaction.
pub fn require_signed(
    verified: &[VerifiedSignature],
    pubkey: &Pubkey,
    message: &[u8],
) -> Result<()> {
    let found = verified
        .iter()
        .any(|v| v.pubkey == *pubkey && v.message.as_slice() == message);

    require!(found, CarrierError::SignatureNotVerified);
    Ok(())
}
