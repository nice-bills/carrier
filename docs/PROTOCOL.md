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
*compensates* the victim from a bond, up to what the bond holds. It answers (1)
by paying relayers out of the note at settlement.

## Model

Three objects. One lives onchain, two live in people's pockets.

### Pouch (onchain)

A pre-funded, pre-committed spending allowance. Think of it as a cashier's cheque
book: the bank has already set the money aside, and each cheque has a number.

```
PDA: ["pouch", owner, mint]
vault: ["vault", pouch], a token account the pouch owns

owner             Pubkey      who can sign notes against it
mint              Pubkey      SPL mint
committed         u64         total moved in for spending
settled           u64         total that has left the vault to pay notes
bond              u64         slashable stake backing honest behaviour
epoch             u32         which notes are valid now (see Epochs)
epoch_started_at  i64         when this epoch began
spent             [u64; 4]    256-bit map of which note slots have settled
settled_fp        [u64; 256]  per slot: first 8 bytes of the note that took it
```

`committed - settled` is the **offline exposure ceiling**. It is chosen by the
user, visible onchain, and is the exact number we quote when someone asks "what
happens if I cheat?"

The mint must be SPL Token, or Token-2022 with no extensions beyond metadata and
group pointers. Transfer fees, permanent delegates, transfer hooks, pausing and
default-frozen accounts are refused when the pouch opens, because each one can
leave the vault unable to pay what it owes.

### Note (offline, signed, never touches the chain until settlement)

```
pouch          Pubkey
to             Pubkey
amount         u64
slot_index     u8       which bit of the pouch bitmap this note consumes
epoch          u32      must match pouch epoch at settlement
expiry         i64      unix seconds, at most 30 days after the epoch began
relay_fee_bps  u16      what the sender pays carriers, in basis points (≤ 10000)
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

**A slot is used once per epoch, even if its note expires unsettled.** The
onchain bitmap only shows slots that settled. A wallet must remember every slot
it has signed this epoch and never sign another note for one of them. Two notes
for one slot are a double spend, and the bond pays for it.

### Hop (offline, co-signed — this is the contagion)

```
note_hash   [u8; 32]
relayer     Pubkey
prev        Pubkey     previous relayer, or the sender at seq 0
seq         u8         position in the transmission chain
at          i64        when the handoff happened, by the phones' clocks
```

Co-signed by **both** devices in the handoff. That mutual signature is what makes
a hop a proof of physical proximity rather than a claim. We deliberately do not
use GPS: GPS is self-reported and spoofable with commodity hardware. Two
independent keys attesting to the same handoff is a much harder thing to fake.

`at` is checked loosely: no earlier than a day before the epoch began, no later
than a day after settlement. Phones keep bad time, so hops need not be in order.

The accumulated hop chain is the transmission lineage. When a note settles, that
lineage is emitted in an event, and that is what we draw as the spread tree.

## Flows

### Open

`open_pouch(amount, bond)` moves `amount + bond` into the vault. This is the one
step that needs a connection. The first epoch is the current unix time.

`refill_pouch(amount)` adds spendable funds. `add_bond(amount)` adds to the
bond. Neither changes the epoch, so notes already handed over stay good.

### Spend (no connectivity required)

1. Sender picks a slot it has not used this epoch.
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
2. Check `epoch` matches, `expiry` not passed, expiry within the epoch's 30 days.
3. Check bit `slot_index` in `spent` is **clear**. Set it, and record the note's
   fingerprint for that slot.
4. Check `amount <= committed - settled`.
5. Split the relay fee (`amount × relay_fee_bps / 10000`) evenly across the
   relayers in the chain. The recipient gets `amount - relay_fee`.
6. Relay fee nobody earned stays in the vault: all of it when there are no
   hops, and the rounding dust otherwise. `settled` grows only by what left, so
   that part is the owner's again.
7. Emit the lineage.

Whoever submits pays the transaction fee and earns nothing from the note. There
is no submitter bounty. A carrier settles to get paid; a recipient settles to
get their money.

One transaction holds at most **2 hops** (`MAX_HOPS`). Each hop costs two
96-byte signatures, and a transaction is capped at 1232 bytes. Two hops fit at
1179 bytes only if the settler uses a lookup table with the pouch, vault, mint
and fixed program ids in it. The owner should publish one when opening the
pouch.

### Settle a longer chain (the draft path)

Up to 16 hops (`MAX_CHAIN`), across several transactions:

1. `begin_settlement(note)` checks the note and its signature and opens a draft
   at `["draft", pouch, note_hash, settler]`. The settler pays its rent.
2. `extend_settlement(hops)` verifies the next hops against the chain so far.
   Call it as often as needed; two hops fit in each call.
3. `finalize_settlement()` checks again that the slot is free, pays out exactly
   as above, and closes the draft back to the settler.

Only the settler who opened a draft can extend, finalize or abandon it
(`abandon_settlement` returns the rent). Because the settler is in the address,
nobody can squat a note: anyone else holding it opens their own draft, and the
first to finalize takes the slot. Once the note has expired, anyone can call
`close_expired_draft`, and the rent goes back to whoever opened it.

### Epochs, lifetime and closing

A note may not expire more than 30 days after its epoch began
(`MAX_NOTE_LIFETIME_SECONDS`). So 30 days after an epoch starts, nothing from
it can settle. That moment is `epoch_closes_at`.

Then there are 7 more days (`SLASH_GRACE_SECONDS`) for anyone who lost to a
double spend to bring the proof. The proof needs the pouch and this epoch's
record of settled notes.

After both:

- `advance_epoch()` starts a new epoch. It clears the bitmap and the
  fingerprints and frees all 256 slots. It cannot run earlier, so the owner
  cannot void notes that are already out.
- `close_pouch()` sends everything left in the vault, including what is left
  of the bond, back to the owner and closes both accounts.

A pouch therefore gives at most 256 notes per 37 days. A second pouch needs
another key or another mint.

The first epoch is the unix time at `open_pouch`, and each `advance_epoch` adds
one. Since a close needs 37 days after the last epoch began, a reopened pouch
always starts at a higher epoch than the old one reached. Old notes, which are
public once settled, cannot be replayed against the new pouch or used to slash
it.

### Double-spend: bound, detect, compensate

A sender with a rooted device can issue two notes against the same `slot_index`
to two different people. Both are validly signed. Only one will settle; the other
fails at step 3.

- **Bound.** Exposure can never exceed `committed - settled`, and never span more
  than 256 notes per epoch. Both numbers are onchain and quotable.
- **Detect.** `prove_double_spend(note_a, note_b)` takes the note that settled
  (`note_a`) and the one that lost (`note_b`). Both must be signed by the owner
  for the same pouch, slot and current epoch, and the pouch must record `note_a`
  as the note that took the slot. The program verifies both signatures itself —
  no oracle, no trusted reporter.
- **Compensate.** The money goes to a token account owned by `note_b.to`, not
  to whoever sends the proof. The victim gets `min(note_b.amount, bond)`. Then
  the prover gets a tenth of `note_b.amount` if bond is left. Only what is paid
  leaves the bond; the rest stays for the next victim. The owner can top it up
  with `add_bond`.

Each losing note can be claimed once: the proof creates a claim account at
`["claim", pouch, note_b_hash]`, and a second proof for the same note fails. The
owner cannot be the victim of their own note.

On hardware with a secure element (Android StrongBox; the Seeker's seed vault),
the slot bitmap mirror is held inside the enclave and the signing key never
leaves it, so producing the second note requires defeating the hardware rather
than editing a file. That raises the cost of the attack; it does not reduce it to
zero, and we do not claim it does.

### Relay economics

`relay_fee_bps` of the note amount, split evenly across the hop chain at
settlement. Nothing else. Forwarding a stranger's note pays, and settling it
yourself pays nothing extra. This is the reason the mesh has carriers.

## What this does not protect against

Plainly, so nobody finds out the hard way:

- **The bond may not cover everyone.** It pays first come, first served. A
  sender who double-spends many notes, or signs extra losing notes to their own
  second key and claims first, can use it up before a real victim arrives. A
  victim paid part of their note cannot claim the rest later.
- **A carrier can settle a shorter chain.** Any prefix of a valid chain
  verifies. An early carrier who reaches connectivity can leave off the hops
  after theirs and split the fee among fewer people. Only carriers lose; the
  recipient and the sender are unaffected. Fixing it needs the recipient to
  co-sign the end of the chain.
- **One person with two phones** is two keys that really met. Nothing onchain
  can tell. The fee is fixed per note, so extra hops split it rather than add
  to it.
- **A frozen token account blocks payout.** If the mint has a freeze authority
  and it freezes the recipient's or a carrier's account, that settlement fails.
- **Hop times come from phones.** They are bounded, not trusted.
- **Lineage is public.** Every settlement publishes which keys handed the note
  to which. That is a record of who met whom.
- **The 16-hop draft finalize has not been measured.** It needs 16 carrier
  accounts and 17 transfers in one transaction. The tests cover 4.

## What is deliberately not here (yet)

- Hop receipts are currently stored as program events. Moving lineage into
  compressed accounts is the obvious next step and the reason the cost model
  works at scale.
- Notes are single-recipient. Multi-hop change / chained notes are future work.
- iOS. Background BLE on iOS is restrictive enough that it would cost a day and
  return nothing for the demo.
