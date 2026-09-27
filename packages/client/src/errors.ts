/**
 * Turning chain failures into sentences a person can act on.
 *
 * Copy follows PRODUCT.md: say what literally happened, in short sentences,
 * with no crypto vocabulary.
 */

/**
 * `CarrierError` variants in declaration order. Anchor numbers them from 6000.
 * Checked against the IDL's `errors` in tests.
 */
export const CARRIER_ERROR_NAMES = [
  "MalformedSignatureData",
  "UnsupportedSignatureLayout",
  "SignatureNotVerified",
  "PouchMismatch",
  "EpochMismatch",
  "NoteLifetimeTooLong",
  "NoteExpired",
  "SlotAlreadySpent",
  "InsufficientCommitted",
  "RecipientMismatch",
  "TooManyHops",
  "HopSequenceInvalid",
  "HopNoteMismatch",
  "HopChainBroken",
  "RelayerAccountsMismatch",
  "RelayerMismatch",
  "HopTimeOutOfRange",
  "RelayFeeTooHigh",
  "RepeatedCarrier",
  "SelfDealingCarrier",
  "NotesIdentical",
  "NotesNotConflicting",
  "NothingToSlash",
  "NoteNotSettled",
  "VictimMismatch",
  "VictimIsOwner",
  "PouchNotDrainable",
  "EpochStillOpen",
  "DraftNotExpired",
  "UnsupportedMintExtension",
  "MathOverflow",
] as const;

export type CarrierErrorName = (typeof CARRIER_ERROR_NAMES)[number];

export const CARRIER_ERROR_OFFSET = 6000;

const MESSAGES: Record<CarrierErrorName, string> = {
  MalformedSignatureData: "The signatures on this payment could not be read.",
  UnsupportedSignatureLayout: "The signatures on this payment could not be read.",
  SignatureNotVerified: "A signature on this payment does not match. It cannot be paid.",
  PouchMismatch: "This payment was written for a different pouch.",
  EpochMismatch: "This payment is from an old round of the pouch. It can no longer be paid.",
  NoteLifetimeTooLong: "This payment was set to last too long. It cannot be paid.",
  NoteExpired: "This payment expired before it reached the network.",
  SlotAlreadySpent: "This payment was already settled.",
  InsufficientCommitted: "The sender's pouch does not have enough left to cover this.",
  RecipientMismatch: "The money is going to the wrong account for this payment.",
  TooManyHops: "This payment passed through too many phones to settle at once.",
  HopSequenceInvalid: "The chain of handoffs is out of order.",
  HopNoteMismatch: "A handoff in the chain belongs to a different payment.",
  HopChainBroken: "The chain of handoffs is broken.",
  RelayerAccountsMismatch: "A carrier's account is missing from the settlement.",
  RelayerMismatch: "A carrier is being paid into someone else's account.",
  HopTimeOutOfRange: "A handoff has a time that is too far off. Check the phone's clock.",
  RelayFeeTooHigh: "The carrier share on this payment is more than the payment.",
  RepeatedCarrier: "The same phone carried this payment twice.",
  SelfDealingCarrier: "The sender or the recipient cannot be paid for carrying.",
  NotesIdentical: "Those are the same payment, not two different ones.",
  NotesNotConflicting: "Those two payments do not use the same slot.",
  NothingToSlash: "The sender's bond is already used up.",
  NoteNotSettled: "The first payment has to be the one that was paid.",
  VictimMismatch: "The refund is going to the wrong account.",
  VictimIsOwner: "The sender cannot claim from their own bond.",
  PouchNotDrainable: "The pouch cannot close yet. Payments may still arrive.",
  EpochStillOpen: "The pouch cannot start a new round yet. Payments may still arrive.",
  DraftNotExpired: "This settlement is still in progress and has not expired.",
  UnsupportedMintExtension: "This token type cannot be used with a pouch.",
  MathOverflow: "The amounts are too large.",
};

/** Anchor framework errors a person can plausibly hit. */
const ANCHOR_MESSAGES: Record<number, string> = {
  2003: "A required account is missing.", // ConstraintRaw
  2006: "An account does not belong to this pouch.", // ConstraintSeeds
  2014: "The token account is for a different currency.", // ConstraintTokenMint
  2015: "The token account belongs to someone else.", // ConstraintTokenOwner
  3001: "An account does not belong to this pouch.", // AccountDiscriminatorNotFound
  3002: "An account does not belong to this pouch.", // AccountDiscriminatorMismatch
  3007: "An account does not belong to this pouch.", // AccountOwnedByWrongProgram
  3012: "That pouch does not exist.", // AccountNotInitialized
};

/** Raised by the client itself, before anything is sent. */
export class CarrierClientError extends Error {
  constructor(
    readonly code: CarrierErrorName | "PouchNotFound" | "NotEnoughTokens" | "Expired" | "TooLarge" | "BadBundle",
    message: string,
  ) {
    super(message);
    this.name = "CarrierClientError";
  }
}

/** Thrown by `settleBundle` when a transaction fails. `message` is already readable. */
export class SettlementFailedError extends Error {
  constructor(
    message: string,
    /** Signatures of the transactions that did land before the failure. */
    readonly signatures: string[],
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "SettlementFailedError";
  }
}

export interface ProgramErrorInfo {
  code: number;
  /** CarrierError variant, when `code` is one. */
  name?: CarrierErrorName;
  /** Index of the failing instruction, when known. */
  instruction?: number;
}

function customFromObject(err: unknown): ProgramErrorInfo | null {
  // `{ InstructionError: [index, { Custom: code }] }`, as confirmations and
  // simulations report it.
  if (err && typeof err === "object" && "InstructionError" in err) {
    const ie = (err as { InstructionError: unknown }).InstructionError;
    if (Array.isArray(ie) && ie.length === 2) {
      const [index, detail] = ie;
      if (detail && typeof detail === "object" && "Custom" in detail) {
        const code = Number((detail as { Custom: unknown }).Custom);
        if (Number.isInteger(code)) return withName({ code, instruction: Number(index) });
      }
    }
  }
  return null;
}

function withName(info: ProgramErrorInfo): ProgramErrorInfo {
  const name = CARRIER_ERROR_NAMES[info.code - CARRIER_ERROR_OFFSET];
  return name ? { ...info, name } : info;
}

function textOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) {
    const logs = (e as { logs?: unknown }).logs;
    const extra = Array.isArray(logs) ? "\n" + logs.join("\n") : "";
    return e.message + extra;
  }
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/**
 * Find the program error code in anything a send or confirm can throw:
 * web3.js `SendTransactionError` (message plus logs), a confirmation's `err`
 * object, an Anchor log line, or our own `CarrierClientError`.
 */
export function programErrorCode(e: unknown): ProgramErrorInfo | null {
  if (e instanceof CarrierClientError) {
    const i = CARRIER_ERROR_NAMES.indexOf(e.code as CarrierErrorName);
    return i >= 0 ? { code: CARRIER_ERROR_OFFSET + i, name: CARRIER_ERROR_NAMES[i] } : null;
  }
  if (e instanceof SettlementFailedError) return programErrorCode(e.cause);

  const fromObj = customFromObject(e) ?? customFromObject((e as { err?: unknown } | null)?.err);
  if (fromObj) return fromObj;

  const text = textOf(e);
  // Anchor logs: "Error Code: SlotAlreadySpent. Error Number: 6007."
  const anchor = /Error Number: (\d+)/.exec(text);
  if (anchor) return withName({ code: Number(anchor[1]) });
  // Runtime: "Error processing Instruction 1: custom program error: 0x1777"
  const custom = /(?:Instruction (\d+): )?custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (custom) {
    return withName({
      code: parseInt(custom[2]!, 16),
      instruction: custom[1] !== undefined ? Number(custom[1]) : undefined,
    });
  }
  // JSON-serialised confirmation errors inside a message.
  const json = /"Custom"\s*:\s*(\d+)/.exec(text);
  if (json) return withName({ code: Number(json[1]) });
  return null;
}

/**
 * One or two plain sentences saying what went wrong, for showing to a person.
 * Never throws; falls back to a generic sentence.
 */
export function explainError(e: unknown): string {
  if (e instanceof CarrierClientError && !CARRIER_ERROR_NAMES.includes(e.code as CarrierErrorName)) {
    return e.message;
  }
  if (e instanceof SettlementFailedError) return e.message;

  const info = programErrorCode(e);
  if (info?.name) return MESSAGES[info.name];
  if (info && ANCHOR_MESSAGES[info.code]) return ANCHOR_MESSAGES[info.code]!;

  const text = textOf(e);
  if (/already (been )?processed/i.test(text)) return "This was already sent.";
  if (/already in use/i.test(text)) return "This payment is already being settled.";
  if (/Blockhash not found|block height exceeded|expired/i.test(text)) {
    return "The network took too long to answer. Try again.";
  }
  if (/insufficient funds for (fee|rent)|insufficient lamports|no record of a prior credit/i.test(text)) {
    return "This phone needs a little SOL to pay the network fee.";
  }
  if (/insufficient funds/i.test(text) || info?.code === 1) {
    return "There is not enough money in the account.";
  }
  if (/too large|exceeds|encoding overruns/i.test(text)) {
    return "This payment is too big to send in one go.";
  }
  if (/fetch failed|network request failed|ECONNREFUSED|ENOTFOUND|timed? ?out|429/i.test(text)) {
    return "Could not reach the network. Try again when you have signal.";
  }
  if (info && info.code >= 0 && info.code <= 4 && info.instruction === 0) {
    // The ed25519 precompile sits first and reports its failures as small codes.
    return MESSAGES.SignatureNotVerified;
  }
  return "Something went wrong. Try again.";
}
