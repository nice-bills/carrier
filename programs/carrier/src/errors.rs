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

    #[msg("relay fee exceeds the note amount")]
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

    #[msg("pouch still has unsettled notes outstanding; wait for expiry before closing")]
    PouchNotDrainable,

    #[msg("arithmetic overflow")]
    MathOverflow,
}
