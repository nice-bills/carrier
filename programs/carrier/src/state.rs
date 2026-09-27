use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

/// Number of note slots available per pouch epoch. Also the hard cap on how many
/// notes a pouch can have outstanding while offline.
pub const SLOTS_PER_EPOCH: u16 = 256;

/// Longest transmission chain one settlement transaction can verify.
///
/// Measured, not chosen — see the ceiling test in `tests/settle.test.ts`. With
/// a lookup table holding only what every note from one pouch shares (pouch,
/// vault, mint, token program, instructions sysvar, program id), and a distinct
/// token account per carrier outside the table, one hop is 854 bytes and two
/// are 1179 against a 1232-byte limit. A third hop does not fit. Without the
/// pouch and vault in a table, two hops are 1241 bytes and do not fit either,
/// so settlers need that table. The cost is dominated by signatures: 96 bytes
/// each, two per hop, and neither number is reducible.
///
/// This must not be optimistic. The mesh extends a chain up to this length, so a
/// value larger than settlement can verify means devices build bundles nobody
/// can ever redeem, and the failure only surfaces when the money does not
/// arrive. Longer chains go through the draft path (`begin_settlement`), which
/// verifies across several transactions, up to `MAX_CHAIN`.
pub const MAX_HOPS: usize = 2;

/// How long after an epoch starts a note from that epoch may remain settleable.
///
/// This exists so committed funds are recoverable. Without an upper bound on
/// note expiry, the owner could never safely withdraw: any note still in someone's
/// pocket might settle later and the vault has to be able to honour it. Capping
/// expiry gives a moment after which the epoch is provably closed.
pub const MAX_NOTE_LIFETIME_SECONDS: i64 = 30 * 24 * 60 * 60;

/// How long after an epoch closes a double-spend proof can still land.
///
/// Nothing can settle after `epoch_closes_at`, but a victim only learns they
/// lost when they try. They need time to bring the proof, and the proof needs
/// the pouch to still exist with this epoch's record of settled notes. So the
/// owner can neither close the pouch nor advance the epoch until this has
/// passed too.
pub const SLASH_GRACE_SECONDS: i64 = 7 * 24 * 60 * 60;

/// How far a hop's signed `at` may sit outside the epoch.
///
/// Phones keep bad time, so this is loose and the chain need not be in order.
/// It only stops a hop from claiming a moment before its note could exist, or
/// far in the future, so lineage times in events mean something.
pub const HOP_CLOCK_SKEW_SECONDS: i64 = 24 * 60 * 60;

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
    /// Notes are only valid for the epoch they name. Starts at the unix time
    /// the pouch was opened and goes up by one on each `advance_epoch`.
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
    /// For each slot settled this epoch, the fingerprint of the note that took
    /// it (see `note_fingerprint`). This is how `prove_double_spend` tells the
    /// note that was paid from the one that lost.
    pub settled_fp: [u64; SLOTS_PER_EPOCH as usize],
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

    /// When the owner may close the pouch or advance the epoch: after the
    /// last note could settle, plus time for a double-spend proof to land.
    pub fn slashing_ends_at(&self) -> i64 {
        self.epoch_closes_at().saturating_add(SLASH_GRACE_SECONDS)
    }

    /// Record which note took a slot. Called once, when it settles.
    pub fn record_settled(&mut self, slot_index: u8, note_hash: &[u8; 32]) {
        self.mark_slot_spent(slot_index);
        self.settled_fp[slot_index as usize] = note_fingerprint(note_hash);
    }

    /// True if the slot settled and the note that took it has this hash.
    pub fn settled_with(&self, slot_index: u8, note_hash: &[u8; 32]) -> bool {
        self.is_slot_spent(slot_index)
            && self.settled_fp[slot_index as usize] == note_fingerprint(note_hash)
    }

    pub fn clear_slots(&mut self) {
        self.spent = [0u64; 4];
        self.settled_fp = [0u64; SLOTS_PER_EPOCH as usize];
    }

    #[inline]
    fn slot_position(slot_index: u8) -> (usize, u32) {
        // slot_index is u8, so this covers exactly 0..=255 across four u64 words.
        ((slot_index / 64) as usize, (slot_index % 64) as u32)
    }
}

/// First 8 bytes of a note hash, little-endian.
///
/// Eight bytes, not 32, to keep the pouch small. Only the owner signs notes, so
/// only the owner can make two notes with the same fingerprint. That can only
/// make a note of theirs claimable twice from their own bond, which they could
/// do anyway by signing a real double spend to a friend. It cannot block an
/// honest victim's claim. See `prove_double_spend`.
pub fn note_fingerprint(note_hash: &[u8; 32]) -> u64 {
    let mut first = [0u8; 8];
    first.copy_from_slice(&note_hash[..8]);
    u64::from_le_bytes(first)
}

/// An offline payment. Signed by the pouch owner, carried by strangers, settled
/// by whoever reconnects first.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq, InitSpace)]
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

    /// What the sender's device actually signed.
    ///
    /// The digest rather than the encoding: every signature the ed25519
    /// precompile verifies carries its message inline, and a transaction is
    /// capped at 1232 bytes. Signing full encodings put a two-hop settlement at
    /// 1443 bytes — it simply would not fit. The domain prefix is inside the
    /// hashed bytes, so separation survives.
    pub fn signing_payload(&self) -> [u8; 32] {
        self.hash()
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

/// A hop as it travels in instruction data.
///
/// Only the two fields that cannot be derived. `note_hash`, `prev` and `seq` are
/// all implied by the note and the position in the chain, so transmitting them
/// wastes 65 bytes per hop against a 1232-byte transaction limit — and worse,
/// makes it possible to send values that disagree with the chain, which the
/// program then has to check for. Rebuilding them here means they cannot
/// disagree.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct HopClaim {
    pub relayer: Pubkey,
    pub at: i64,
}

impl HopClaim {
    /// Rebuild the hop that both devices actually signed.
    pub fn expand(&self, note_hash: [u8; 32], prev: Pubkey, seq: u8) -> Hop {
        Hop {
            note_hash,
            relayer: self.relayer,
            prev,
            seq,
            at: self.at,
        }
    }
}

impl Hop {
    pub fn message(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(HOP_DOMAIN.len() + 96);
        buf.extend_from_slice(HOP_DOMAIN);
        self.serialize(&mut buf).expect("borsh write to Vec is infallible");
        buf
    }

    /// What both devices in the handoff signed. See `Note::signing_payload`.
    pub fn signing_payload(&self) -> [u8; 32] {
        hashv(&[&self.message()]).to_bytes()
    }
}

/// Longest chain settleable by accumulating verification across transactions.
///
/// `MAX_HOPS` is what fits in a *single* transaction. This is the ceiling for
/// the multi-transaction path, and it is bounded by the payout instead: every
/// relayer needs a token account in the finalising transaction and a transfer
/// CPI, so the limit is compute and account count rather than signature bytes.
pub const MAX_CHAIN: usize = 16;

/// Verification-in-progress for one note.
///
/// Signature checking is the expensive part and it does not all fit in one
/// transaction, so it is accumulated here across several. The draft only ever
/// holds state the program itself verified: each `extend_settlement` checks the
/// next hops against the chain recorded so far, so a draft can never describe a
/// chain nobody signed.
#[account]
#[derive(InitSpace)]
pub struct SettlementDraft {
    /// The note being settled, stored whole so finalising needs no re-supply
    /// (and so the amount cannot change between begin and finalize).
    pub note: Note,
    pub note_hash: [u8; 32],
    pub pouch: Pubkey,
    /// The pouch owner, kept here so carrier-eligibility can be checked while
    /// extending without having to pass the pouch account to every call.
    pub owner: Pubkey,
    /// Who opened the draft, pays its rent, and is refunded when it closes.
    /// Part of the seeds, so two settlers of one note never share a draft.
    pub settler: Pubkey,
    /// When the note's epoch began, for bounding hop times while extending.
    pub epoch_started_at: i64,
    /// Position the next hop must occupy.
    pub next_seq: u8,
    /// Who the next hop must name as its predecessor.
    pub last_carrier: Pubkey,
    #[max_len(MAX_CHAIN)]
    pub lineage: Vec<Pubkey>,
    pub bump: u8,
}

impl SettlementDraft {
    pub fn hops_verified(&self) -> usize {
        self.lineage.len()
    }
}

#[event]
pub struct SettlementStarted {
    pub pouch: Pubkey,
    pub note_hash: [u8; 32],
    pub settler: Pubkey,
}

#[event]
pub struct SettlementExtended {
    pub note_hash: [u8; 32],
    pub hops_verified: u8,
    pub last_carrier: Pubkey,
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
    /// What the relayers actually received, all of them together.
    pub relay_fee_paid: u64,
    /// Relay fee nobody earned (all of it with no hops, else rounding dust).
    /// It stays in the vault and remains the owner's.
    pub relay_fee_kept: u64,
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
        // Mirrors the hop fixture in `packages/protocol/src/codec.test.ts`.
        assert_eq!(hex(&hop.signing_payload()), GOLDEN_HOP_HASH);
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
            settled_fp: [0u64; 256],
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
    fn fingerprint_is_the_first_eight_bytes_little_endian() {
        let mut hash = [0u8; 32];
        hash[0] = 0x01;
        hash[7] = 0x80;
        hash[8] = 0xff; // past the fingerprint, must not matter
        assert_eq!(note_fingerprint(&hash), 0x8000_0000_0000_0001);

        let golden = fixture().hash();
        assert_eq!(note_fingerprint(&golden), u64::from_le_bytes(golden[..8].try_into().unwrap()));
    }

    #[test]
    fn settled_fingerprint_names_the_winning_note_and_clears_on_epoch() {
        let mut pouch = empty_pouch();
        let winner = fixture();
        let mut loser = fixture();
        loser.to = Pubkey::from_str("11111111111111111111111111111114").unwrap();

        assert!(!pouch.settled_with(winner.slot_index, &winner.hash()));
        pouch.record_settled(winner.slot_index, &winner.hash());
        assert!(pouch.is_slot_spent(winner.slot_index));
        assert!(pouch.settled_with(winner.slot_index, &winner.hash()));
        assert!(!pouch.settled_with(winner.slot_index, &loser.hash()));
        // Another slot with the same note hash was never settled.
        assert!(!pouch.settled_with(winner.slot_index + 1, &winner.hash()));

        pouch.clear_slots();
        assert!(!pouch.settled_with(winner.slot_index, &winner.hash()));
        assert_eq!(pouch.settled_fp, [0u64; 256]);
    }

    #[test]
    fn slashing_window_follows_the_epoch() {
        let mut pouch = empty_pouch();
        pouch.epoch_started_at = 1_000;
        assert_eq!(pouch.epoch_closes_at(), 1_000 + MAX_NOTE_LIFETIME_SECONDS);
        assert_eq!(
            pouch.slashing_ends_at(),
            1_000 + MAX_NOTE_LIFETIME_SECONDS + SLASH_GRACE_SECONDS
        );
    }

    #[test]
    fn pouch_account_fits_a_program_created_account() {
        // Accounts a program creates by CPI are capped at 10 KiB.
        const _: () = assert!(8 + Pouch::INIT_SPACE <= 10_240);
        assert_eq!(Pouch::INIT_SPACE, 32 + 32 + 8 + 8 + 8 + 4 + 8 + 32 + 2048 + 1 + 1);
    }

    fn empty_pouch() -> Pouch {
        Pouch {
            owner: Pubkey::default(),
            mint: Pubkey::default(),
            committed: 0,
            settled: 0,
            bond: 0,
            epoch: 0,
            epoch_started_at: 0,
            spent: [0u64; 4],
            settled_fp: [0u64; 256],
            bump: 0,
            vault_bump: 0,
        }
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
            settled_fp: [0u64; 256],
            bump: 0,
            vault_bump: 0,
        };
        assert_eq!(pouch.available(), 0);
        pouch.settled = 40;
        assert_eq!(pouch.available(), 60);
    }

    const GOLDEN_NOTE_HASH: &str =
        "ddc5fb01f265fd171be3e351c2daf58b6b75b33da54ef944b3d9e009a1268017";

    const GOLDEN_HOP_HASH: &str =
        "90b0886742837b2810d0a36d17837bcf552e11f454e017fd5fe86dd6e2b7b2ab";

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

/// Marks one losing note as compensated. Its address is
/// `["claim", pouch, losing_note_hash]`, so each losing note can be claimed
/// once. Never closed: a closed claim could be claimed again.
#[account]
#[derive(InitSpace)]
pub struct DoubleSpendClaim {
    pub victim: Pubkey,
    pub paid: u64,
}

#[event]
pub struct DoubleSpendProven {
    pub pouch: Pubkey,
    pub slot_index: u8,
    pub epoch: u32,
    /// The note that settled.
    pub note_a: [u8; 32],
    /// The note that lost.
    pub note_b: [u8; 32],
    /// Wallet that held the losing note.
    pub victim: Pubkey,
    pub paid_victim: u64,
    pub paid_prover: u64,
    pub bond_left: u64,
    pub prover: Pubkey,
}

#[event]
pub struct BondAdded {
    pub pouch: Pubkey,
    pub amount: u64,
    pub bond: u64,
}

#[event]
pub struct EpochAdvanced {
    pub pouch: Pubkey,
    pub epoch: u32,
    pub started_at: i64,
}
