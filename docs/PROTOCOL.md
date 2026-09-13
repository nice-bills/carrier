# Carrier Protocol

> Value that travels by human movement and settles when anyone reconnects.

## The problem

Every Solana payment app assumes a live RPC connection. For a large share of the
people this hackathon is actually reaching — Lagos, Enugu, Uyo, Lomé, Kampala,
Lusaka, Caracas — that assumption is wrong often enough to matter.

Offline payments have been attempted many times and abandoned. Two reasons, every
time:

1. **Nobody relays for free.** A mesh where carrying a stranger's data costs you
   battery and gains you nothing has no carriers. It dies at N=1.
2. **Offline double-spend is unsolvable** in the strict sense. Most designs
   pretend otherwise, get caught, and lose trust.

Carrier does not claim to have solved (2). It *bounds* it, *detects* it, and
*compensates* the victim — and it solves (1) outright by paying relayers at
settlement. Per-hop receipts only became economical with cheap compressed state.

## Model

Three objects. One lives onchain, two live in people's pockets.

### Pouch (onchain)

A pre-funded, pre-committed spending allowance. Think of it as a cashier's cheque
book: the bank has already set the money aside, and each cheque has a number.

```
PDA: ["pouch", owner, mint]

owner        Pubkey      who can sign notes against it
mint         Pubkey      SPL mint
vault        Pubkey      PDA token account holding the committed funds
committed    u64         total moved into the pouch
settled      u64         total already paid out
bond         u64         slashable stake backing honest behaviour
epoch        u32         increments on refill; resets the bitmap
spent        [u64; 4]    256-bit map of which note slots have settled
```

`committed - settled` is the **offline exposure ceiling**. It is chosen by the
user, visible onchain, and is the exact number we quote when someone asks "what
happens if I cheat?"

### Note (offline, signed, never touches the chain until settlement)

```
pouch          Pubkey
to             Pubkey
amount         u64
slot_index     u8       which bit of the pouch bitmap this note consumes
epoch          u32      must match pouch epoch at settlement
expiry         i64      unix seconds
relay_fee_bps  u16      what the sender pays carriers, in basis points
```

Signed by the pouch owner with ed25519. Verified at settlement via the ed25519
precompile and instruction introspection.

**Why a bitmap and not a monotonic counter.** A monotonic `high_nonce` is the
obvious design and it is wrong here. Notes in a mesh arrive *out of order* — a
note handed off on Friday may settle after one handed off on Sunday, because it
travelled through someone who stayed offline longer. A strictly increasing
counter would permanently strand every note with a lower nonce. A 256-bit map
lets notes settle in any order, exactly once each.

256 slots per epoch is also the second half of the offline bound: at most 256
outstanding notes, worth at most `committed - settled` in total.

### Hop (offline, co-signed — this is the contagion)

```
note_hash   [u8; 32]
relayer     Pubkey
prev        Pubkey     previous relayer, or the sender at seq 0
seq         u8         position in the transmission chain
at          i64
```

Co-signed by **both** devices in the handoff. That mutual signature is what makes
a hop a proof of physical proximity rather than a claim. We deliberately do not
use GPS: GPS is self-reported and spoofable with commodity hardware. Two
independent keys attesting to the same handoff is a much harder thing to fake.

The accumulated hop chain is the transmission lineage. When a bundle settles, that
lineage is what we draw as the spread tree.

## Flows

### Spend (no connectivity required)

1. Sender picks an unused `slot_index` from the local mirror of the pouch bitmap.
2. Builds and signs a Note.
3. Hands it to any nearby device over BLE. Both sign a Hop at seq 0.
4. That device now **carries** the note. It will hand it on to other devices it
   meets, each handoff appending a co-signed Hop.

The recipient does not need to be present, online, or known in advance. The note
travels toward settlement by diffusion, not routing.

### Settle (first device in the chain to touch connectivity)

Any carrier holding the bundle submits `settle_note`:

1. ed25519 precompile verifies the sender signature over the Note, and each Hop
   signature pair.
2. Check `epoch` matches, `expiry` not passed.
3. Check bit `slot_index` in `spent` is **clear**. Set it.
4. Check `amount <= committed - settled`.
5. Transfer `amount` from vault to recipient.
6. Split `relay_fee_bps` across the relayers in the hop chain, plus a submitter
   bounty to whoever paid the transaction fee.
7. Emit the lineage.

Everything in a bundle settles in one shot. With Alpenglow's ~150ms finality the
reconnect reads as instantaneous rather than as a sync spinner.

### Double-spend: bound, detect, compensate

A sender with a rooted device can issue two notes against the same `slot_index`
to two different people. Both are validly signed. Only one will settle; the other
fails at step 3.

- **Bound.** Exposure can never exceed `committed - settled`, and never span more
  than 256 notes per epoch. Both numbers are onchain and quotable.
- **Detect.** `prove_double_spend(note_a, note_b)` accepts two validly-signed
  notes sharing a pouch, epoch and slot_index but differing in hash. The program
  verifies both signatures itself — no oracle, no trusted reporter.
- **Compensate.** The bond is slashed. The holder of the losing note is made
  whole from it, and the prover takes a cut for doing the work.

On hardware with a secure element (Android StrongBox; the Seeker's seed vault),
the slot bitmap mirror is held inside the enclave and the signing key never
leaves it, so producing the second note requires defeating the hardware rather
than editing a file. That raises the cost of the attack; it does not reduce it to
zero, and we do not claim it does.

### Relay economics

`relay_fee_bps` of the note amount, split across the hop chain at settlement,
plus a fixed submitter bounty. Forwarding a stranger's note is profitable. This
is the entire reason the mesh has carriers, and it is why per-hop receipts had to
get cheap before this was buildable.

## What is deliberately not here (yet)

- Hop receipts are currently stored as program events. Moving lineage into
  compressed accounts is the obvious next step and the reason the cost model
  works at scale.
- Notes are single-recipient. Multi-hop change / chained notes are future work.
- iOS. Background BLE on iOS is restrictive enough that it would cost a day and
  return nothing for the demo.
