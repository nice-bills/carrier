export {
  NOTE_DOMAIN,
  HOP_DOMAIN,
  SLOTS_PER_EPOCH,
  MAX_HOPS,
  MAX_CHAIN,
  MAX_NOTE_LIFETIME_SECONDS,
  encodeNote,
  encodeHop,
  hashNote,
  hashHop,
  noteSigningPayload,
  hopSigningPayload,
  type Note,
  type Hop,
} from "./codec.js";

export {
  createEd25519Instruction,
  type SignatureEntry,
} from "./ed25519.js";
