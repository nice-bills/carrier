use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

/// Number of note slots available per pouch epoch. Also the hard cap on how many
/// notes a pouch can have outstanding while offline.
pub const SLOTS_PER_EPOCH: u16 = 256;

/// Longest transmission chain we will settle in one instruction. Bounds compute
/// and keeps the ed25519 precompile instruction under the packet limit.
pub const MAX_HOPS: usize = 8;

/// How long after an epoch starts a note from that epoch may remain settleable.
///
/// This exists so committed funds are recoverable. Without an upper bound on
/// note expiry, the owner could never safely withdraw: any note still in someone's
/// pocket might settle later and the vault has to be able to honour it. Capping
/// expiry gives a moment after which the epoch is provably closed.
pub const MAX_NOTE_LIFETIME_SECONDS: i64 = 30 * 24 * 60 * 60;

pub const NOTE_DOMAIN: &[u8] = b"carrier:note:v1";
pub const HOP_DOMAIN: &[u8] = b"carrier:hop:v1";

/// A pre-funded, pre-committed spending allowance that can be spent with no
/// connectivity. See docs/PROTOCOL.md.
#[account]
#[derive(InitSpace)]
pub struct Pouch {
    pub owner: Pubkey,
    pub mint: Pubkey,
    /// Total moved into the pouch across all epochs.
    pub committed: u64,
    /// Total already paid out to recipients.
    pub settled: u64,
    /// Slashable stake backing honest behaviour.
    pub bond: u64,
    /// Increments on refill. Notes are only valid for the epoch they name.
    pub epoch: u32,
    /// When the current epoch began. Notes may not outlive
    /// `epoch_started_at + MAX_NOTE_LIFETIME_SECONDS`, which is what makes the
    /// remaining balance recoverable via `close_pouch`.
    pub epoch_started_at: i64,
    /// 256-bit map of which note slots have settled this epoch.
    ///
    /// A bitmap rather than a monotonic counter because notes in a mesh arrive
    /// out of order — a counter would permanently strand every note below the
    /// high-water mark.
    pub spent: [u64; 4],
    pub bump: u8,
    pub vault_bump: u8,
}

impl Pouch {
    /// Value that can still be spent offline. This is the number we quote as the
    /// offline exposure ceiling.
    pub fn available(&self) -> u64 {
        self.committed.saturating_sub(self.settled)
    }

    /// After this instant no note from the current epoch can settle, so whatever
    /// is left in the vault is safe to withdraw.
    pub fn epoch_closes_at(&self) -> i64 {
        self.epoch_started_at.saturating_add(MAX_NOTE_LIFETIME_SECONDS)
    }

    pub fn is_slot_spent(&self, slot_index: u8) -> bool {
        let (word, bit) = Self::slot_position(slot_index);
        self.spent[word] & (1u64 << bit) != 0
    }

    pub fn mark_slot_spent(&mut self, slot_index: u8) {
        let (word, bit) = Self::slot_position(slot_index);
        self.spent[word] |= 1u64 << bit;
    }

    pub fn clear_slots(&mut self) {
        self.spent = [0u64; 4];
    }

    #[inline]
    fn slot_position(slot_index: u8) -> (usize, u32) {
        // slot_index is u8, so this covers exactly 0..=255 across four u64 words.
        ((slot_index / 64) as usize, (slot_index % 64) as u32)
    }
}

/// An offline payment. Signed by the pouch owner, carried by strangers, settled
/// by whoever reconnects first.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub pouch: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub slot_index: u8,
    pub epoch: u32,
    pub expiry: i64,
    pub relay_fee_bps: u16,
}

impl Note {
    /// Exact bytes the sender signs. Domain-separated so a note can never be
    /// reinterpreted as a hop or as any other protocol's message.
    pub fn message(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(NOTE_DOMAIN.len() + 96);
        buf.extend_from_slice(NOTE_DOMAIN);
        self.serialize(&mut buf).expect("borsh write to Vec is infallible");
        buf
    }

    pub fn hash(&self) -> [u8; 32] {
        hashv(&[&self.message()]).to_bytes()
    }
}

/// One device-to-device handoff, co-signed by both parties. The chain of these
/// is the transmission lineage.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Hop {
    pub note_hash: [u8; 32],
    pub relayer: Pubkey,
    /// Previous relayer, or the sender at seq 0.
    pub prev: Pubkey,
    pub seq: u8,
    pub at: i64,
}

impl Hop {
    pub fn message(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(HOP_DOMAIN.len() + 96);
        buf.extend_from_slice(HOP_DOMAIN);
        self.serialize(&mut buf).expect("borsh write to Vec is infallible");
        buf
    }
}

#[event]
pub struct NoteSettled {
    pub pouch: Pubkey,
    pub note_hash: [u8; 32],
    pub to: Pubkey,
    pub amount: u64,
    pub slot_index: u8,
    pub epoch: u32,
    /// Transmission lineage, sender first. This is what the spread map draws.
    pub lineage: Vec<Pubkey>,
    pub relay_fee_paid: u64,
    pub settled_by: Pubkey,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    /// Mirrors the fixture in `packages/protocol/src/codec.test.ts`.
    ///
    /// Phones sign these bytes offline in TypeScript; this program verifies them
    /// in Rust. If the two encoders ever drift, settlement fails with an opaque
    /// `SignatureNotVerified` and the mesh silently stops working — so both
    /// sides assert the same golden vector.
    fn fixture() -> Note {
        Note {
            pouch: Pubkey::from_str("11111111111111111111111111111112").unwrap(),
            to: Pubkey::from_str("11111111111111111111111111111113").unwrap(),
            amount: 1_500_000,
            slot_index: 7,
            epoch: 3,
            expiry: 1_800_000_000,
            relay_fee_bps: 250,
        }
    }

    #[test]
    fn note_encoding_matches_the_typescript_client() {
        let encoded = fixture().message();
        assert_eq!(encoded.len(), 102);
        assert_eq!(&encoded[..15], NOTE_DOMAIN);
        assert_eq!(hex(&fixture().hash()), GOLDEN_NOTE_HASH);
    }

    #[test]
    fn hop_encoding_is_domain_separated() {
        let hop = Hop {
            note_hash: fixture().hash(),
            relayer: Pubkey::from_str("11111111111111111111111111111112").unwrap(),
            prev: Pubkey::from_str("11111111111111111111111111111113").unwrap(),
            seq: 0,
            at: 1_700_000_000,
        };
        let encoded = hop.message();
        assert_eq!(encoded.len(), 119);
        assert_eq!(&encoded[..14], HOP_DOMAIN);
        assert_ne!(&encoded[..14], &fixture().message()[..14]);
    }

    #[test]
    fn hash_changes_with_every_field() {
        let base = fixture().hash();
        let mut other = fixture();
        other.slot_index = 8;
        assert_ne!(other.hash(), base);
        let mut other = fixture();
        other.amount += 1;
        assert_ne!(other.hash(), base);
    }

    #[test]
    fn slot_bitmap_covers_all_256_slots_independently() {
        let mut pouch = Pouch {
            owner: Pubkey::default(),
            mint: Pubkey::default(),
            committed: 0,
            settled: 0,
            bond: 0,
            epoch: 0,
            epoch_started_at: 0,
            spent: [0u64; 4],
            bump: 0,
            vault_bump: 0,
        };

        for slot in 0..=255u8 {
            assert!(!pouch.is_slot_spent(slot), "slot {slot} started spent");
            pouch.mark_slot_spent(slot);
            assert!(pouch.is_slot_spent(slot), "slot {slot} did not set");
        }

        // Every slot set means all four words are saturated — no slot aliased
        // onto another, which would let one note invalidate a different one.
        assert_eq!(pouch.spent, [u64::MAX; 4]);

        pouch.clear_slots();
        assert!((0..=255u8).all(|s| !pouch.is_slot_spent(s)));
    }

    #[test]
    fn available_never_underflows() {
        let mut pouch = Pouch {
            owner: Pubkey::default(),
            mint: Pubkey::default(),
            committed: 100,
            settled: 250,
            bond: 0,
            epoch: 0,
            epoch_started_at: 0,
            spent: [0u64; 4],
            bump: 0,
            vault_bump: 0,
        };
        assert_eq!(pouch.available(), 0);
        pouch.settled = 40;
        assert_eq!(pouch.available(), 60);
    }

    const GOLDEN_NOTE_HASH: &str =
        "ddc5fb01f265fd171be3e351c2daf58b6b75b33da54ef944b3d9e009a1268017";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[event]
pub struct PouchClosed {
    pub pouch: Pubkey,
    pub owner: Pubkey,
    pub returned: u64,
}

#[event]
pub struct DoubleSpendProven {
    pub pouch: Pubkey,
    pub slot_index: u8,
    pub epoch: u32,
    pub note_a: [u8; 32],
    pub note_b: [u8; 32],
    pub slashed: u64,
    pub prover: Pubkey,
}
