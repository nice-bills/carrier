# Carrier

**Value that travels by human movement and settles when anyone reconnects.**

Carrier is a payment network that does not need the internet to move money. A
payment is signed offline, handed phone-to-phone over Bluetooth, carried by
whoever happens to be walking the right way, and settled on Solana by the first
device in the chain that finds connectivity. Everyone who carried it gets paid.

You do not join Carrier by connecting to an RPC. You catch it from someone
standing near you.

---

## Why this doesn't already exist

Offline payment meshes have been built and abandoned repeatedly. Two reasons,
every time:

**Nobody relays for free.** Carrying a stranger's data costs battery and earns
nothing, so no one does it, so the mesh has no carriers and dies at N=1.

**Offline double-spend is unsolvable** in the strict sense, and most designs
quietly pretend otherwise.

Carrier pays relayers out of the note at settlement, which makes forwarding a
stranger's payment profitable — that is the whole reason the mesh has carriers.
And it does not claim to have solved double-spend. It **bounds** the exposure to
a number that is committed onchain in advance, **detects** cheating with a proof
anyone can submit, and **compensates** the victim from a slashable bond.

Per-hop receipts only became economical once compressed state made them cost
approximately nothing. That is what changed, and it is why this is buildable now
and was not two years ago.

## How it works

Three objects. One onchain, two in people's pockets.

| | |
|---|---|
| **Pouch** | A pre-funded allowance committed onchain, with a 256-bit map of which note slots have settled. `committed − settled` is the offline exposure ceiling — chosen by the user, visible to anyone. |
| **Note** | An offline payment signed by the pouch owner. Consumes one slot. Never touches the chain until settlement. |
| **Hop** | One device-to-device handoff, co-signed by **both** phones. The chain of hops is the transmission lineage. |

A note diffuses rather than routes: the recipient need not be present, online, or
known to the carrier. When any carrier reconnects, the whole bundle settles at
once and the lineage is emitted — which is what the spread map draws.

Hops are co-signed rather than GPS-stamped on purpose. GPS is self-reported and
spoofable with commodity hardware; two independent keys attesting to the same
handoff is a much harder thing to fake.

Full design, including the parts that are hard: **[docs/PROTOCOL.md](docs/PROTOCOL.md)**.

### On double-spend, plainly

A sender with a rooted device can sign two notes against the same slot. Both are
valid. One settles; the other fails.

- **Bounded** — exposure can never exceed `committed − settled`, across at most
  256 notes per epoch. Both numbers are onchain.
- **Detected** — `prove_double_spend` takes the two conflicting notes and
  verifies both signatures in-program. No oracle, no trusted reporter.
- **Compensated** — the bond is slashed; the holder of the losing note is made
  whole, and the prover takes a cut for bringing it.

On hardware with a secure element the slot map lives inside the enclave and the
signing key never leaves it, so forging the second note means defeating the
hardware rather than editing a file. That raises the cost of the attack. It does
not eliminate it, and we don't say it does.

## Repository layout

```
programs/carrier/       Anchor program — pouches, settlement, slashing
  src/state.rs          Pouch, Note, Hop; wire format and hashing
  src/ed25519.rs        Precompile introspection for offline signatures
  src/instructions.rs   open_pouch, refill_pouch, settle_note, prove_double_spend
packages/protocol/      Shared TypeScript: wire codec + multi-sig ed25519 builder
app/                    Expo / React Native client with the BLE mesh
docs/PROTOCOL.md        Design document
```

## Status

Early. The program compiles and the protocol is specified; the mesh client is in
progress. Nothing here is audited and it is not handling anyone's real money yet.

## Provenance

Built for the **Dev3pack Global Hackathon** (30 Oct – 1 Nov 2026).

Dev3pack's rules permit and encourage arriving with prior work
(*"Can I start building before the hackathon? Yes, with one condition: the
project must be related to Solana"*), and require transparency about what was
built when. So, precisely:

- **Before the hackathon** — protocol design, the Anchor program, the shared
  wire codec, and the BLE transport layer. Commit history is the record; nothing
  is backdated.
- **During the hackathon** — everything from the kickoff commit onward, tagged
  `hackathon-start`.

## Licence

MIT. Open source is mandatory for this hackathon and is the right call for a
payment primitive regardless.
