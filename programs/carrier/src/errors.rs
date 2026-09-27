use anchor_lang::prelude::*;

#[error_code]
pub enum CarrierError {
    #[msg("ed25519 precompile instruction data is malformed")]
    MalformedSignatureData,
    #[msg("signature entry references another instruction, which is not supported")]
    UnsupportedSignatureLayout,
    #[msg("required signature was not verified by the ed25519 precompile")]
    SignatureNotVerified,

    #[msg("note was issued against a different pouch")]
    PouchMismatch,
    #[msg("note was issued against a different pouch epoch")]
    EpochMismatch,
    #[msg("note expiry is beyond the maximum lifetime for its epoch")]
    NoteLifetimeTooLong,
    #[msg("note has expired")]
    NoteExpired,
    #[msg("note slot has already settled; this note is a double spend or a replay")]
    SlotAlreadySpent,
    #[msg("pouch has insufficient committed funds remaining")]
    InsufficientCommitted,
    #[msg("recipient token account owner does not match the note recipient")]
    RecipientMismatch,

    #[msg("transmission chain is longer than MAX_HOPS")]
    TooManyHops,
    #[msg("hop sequence numbers must start at zero and increase by one")]
    HopSequenceInvalid,
    #[msg("hop does not reference the note being settled")]
    HopNoteMismatch,
    #[msg("hop chain is broken: this hop's predecessor is not the previous relayer")]
    HopChainBroken,
    #[msg("expected one relayer token account per hop, in hop order")]
    RelayerAccountsMismatch,
    #[msg("relayer token account owner does not match the hop relayer")]
    RelayerMismatch,
    #[msg("hop time is before its epoch began or too far in the future")]
    HopTimeOutOfRange,

    #[msg("relay fee exceeds the note amount (relay_fee_bps over 10000)")]
    RelayFeeTooHigh,

    #[msg("a key appears twice in the transmission chain")]
    RepeatedCarrier,
    #[msg("the sender or the recipient cannot also be paid as a carrier")]
    SelfDealingCarrier,

    #[msg("double spend proof must reference two different notes")]
    NotesIdentical,
    #[msg("double spend proof requires both notes to share pouch, epoch and slot")]
    NotesNotConflicting,
    #[msg("pouch has no bond remaining to slash")]
    NothingToSlash,
    #[msg("the first note must be the one that settled in this slot")]
    NoteNotSettled,
    #[msg("victim token account is not owned by the losing note's recipient")]
    VictimMismatch,
    #[msg("the pouch owner cannot be compensated for their own double spend")]
    VictimIsOwner,

    #[msg("pouch cannot close yet: notes may still settle or a double spend proof may still land")]
    PouchNotDrainable,
    #[msg("epoch cannot advance yet: notes may still settle or a double spend proof may still land")]
    EpochStillOpen,

    #[msg("draft note has not expired yet")]
    DraftNotExpired,

    #[msg("mint has a Token-2022 extension this program does not support")]
    UnsupportedMintExtension,

    #[msg("arithmetic overflow")]
    MathOverflow,
}
