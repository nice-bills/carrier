# Where Carrier stands

_Last updated: 2026-09-14_

## Everything passes

| Suite | Command | Result |
| --- | --- | --- |
| Program units | `cargo test --manifest-path programs/carrier/Cargo.toml --lib` | 5/5 |
| Protocol codec | `npx vitest run --root packages/protocol` | 8/8 |
| Mesh | `npx vitest run --root packages/mesh` | 14/14 |
| Settlement (e2e, real validator) | `npx vitest run --root tests` | 6/6 |

`./scripts/localnet.sh` does the whole loop: build, extract artifact, generate
IDL, start validator, deploy, run settlement.

The settlement suite is the one that matters. It proves the load-bearing claim:
**signatures made by keypairs that never touched an RPC verify on-chain**, via
the ed25519 precompile and instruction introspection. A note carried by two
strangers with no connectivity settles, the recipient and both carriers are
paid, a slot cannot settle twice, an unverified signature is refused, a forged
hop chain is refused, and a sender who signs two notes against one slot has
their bond slashed and the victim compensated.

## What had to be fixed to get there

**Settlement did not fit in a transaction.** Solana caps a transaction at 1232
bytes; every signature the precompile verifies carries its message inline. A
two-hop settlement came to 1557 bytes. Three changes, each of which also made
the protocol better:

1. **Sign the 32-byte digest, not the encoding.** Domain prefix is inside the
   hashed bytes, so separation survives. Hop message 119 → 32, note 102 → 32.
2. **Deduplicate the shared blob.** Both devices in a handoff sign the identical
   digest; the precompile lets several entries reference one message region.
3. **Stop transmitting derived data.** `HopClaim` carries only `relayer` and
   `at`. `note_hash`, `prev` and `seq` are rebuilt on-chain from the note and
   chain position — 65 bytes per hop saved, and a chain that disagrees with what
   was signed becomes unrepresentable rather than something to validate.

Then **address lookup tables** for the account keys: twelve accounts at 32 bytes
each is 384 bytes of the budget, and an ALT turns each into a one-byte index.
Settlement is sent as a versioned transaction.

1557 → **1087 bytes** for two hops.

## MAX_HOPS is 2, and that is measured

`tests/settle.test.ts` prints the real numbers every run:

```
1 hop(s):  794 bytes ok
2 hop(s): 1087 bytes ok
3 hop(s): >1232 TOO LARGE
=> single-transaction ceiling: 2 hops
```

`MAX_HOPS` was 8. That was a lie the mesh told itself — devices extend a chain
up to that length, so a value above what settlement can verify means building
bundles nobody can ever redeem, discovered only when the money fails to arrive.
It is now 2 in both `state.rs` and `codec.ts`, and the ceiling test fails if
that stops being true.

Each hop costs ~293 bytes, dominated by signatures: 96 bytes each, two per hop,
neither reducible. **Longer chains need a different design** — accumulate
signature verification across several transactions into a PDA, then settle.
That is the single highest-value piece of remaining protocol work, because two
hops is a short mesh.

## Open design question: faking handoffs

A co-signed hop proves **two keys met, not two people**. One person with two
phones can manufacture a chain. Harmless for payments — the sender authorised
the money regardless — but fatal for anything that rewards spreading.

Researched, and it cannot be fixed at the radio layer:

- **Distance bounding does not apply.** It defends against *relay* attacks,
  where distant devices are made to look close. Two phones in one pocket are
  genuinely co-located, so UWB ranging confirms what the attacker wants.
- **Graph-based sybil detection does not apply.** It detects only large,
  densely-clustered sybil regions; two phones is the smallest possible attack
  and is indistinguishable from an ordinary pair of friends.

The defence has to be economic:

> Make the reward a function of **distinct counterparties with independent
> settlement history**, not raw hop count.

Two phones produce a degenerate lineage — the same pair repeatedly, no
independent history behind either key. If repeat encounters pay sharply less and
meeting a history-less key is worth near zero, the attack earns nothing while
still costing fees. The cheat is not detected; it is made not worth doing.
Composes with attestations (SAS, Civic) later without day-one onboarding
friction. **Not yet implemented** — required before anything rewards spreading.

## Toolchain traps (encoded in `scripts/localnet.sh`)

These cost most of a day. Do not rediscover them during the event.

- `anchor build` **exits 0 with no `.so`** when `cargo-build-sbf` cannot find
  rustup. Check `ls target/deploy/*.so`, never the exit code.
- The artifact lands in `target/sbpf*/release/`, copied to `target/deploy/` only
  after a strip step that can hang. Go take it yourself.
- Anchor defaults to **SBPF v3**, a valid ELF the validator refuses with
  `invalid file header`. Build with `--arch v0`.
- **Always pass `--tools-version v1.57`.** A bare `cargo-build-sbf` may pick a
  version that is only half-downloaded in `~/.cache/solana/` and hang silently
  retrying.
- `anchor idl build` writes JSON to stdout but **fails when stdout is not a
  TTY**. Run it under `script -qec`.
- It also **reads any existing `target/idl/carrier.json`** — an empty one makes
  it die with `EOF while parsing a value`. Delete before regenerating.
- Never `pkill -f` a pattern that could match the harness shell.

## Next

1. **Anti-sybil**: diminishing returns on repeat counterparties. Required before
   any reward for spreading.
2. **Expo + BLE client**: the airplane-mode demo. Needs a physical Android
   device to verify; the mesh logic beneath it is already tested without radios.
3. **Contagion surface**: same engine, proximity as the mechanic rather than the
   workaround.
4. **PDA accumulator** if chains longer than two hops matter.

## Positioning

Dorsey's [Bitchat](https://beincrypto.com/learn/bitchat-bluetooth-bitcoin-app/)
already does Bluetooth mesh transfer of pre-signed Bitcoin transactions, up to
seven hops. We are not first to the transport and should not pretend otherwise.
What it does not do:

- **Relayers are paid** from the note at settlement. Bitchat relays for free,
  which is how every previous mesh has died.
- **Hops are co-signed and recorded** as a verifiable lineage, not discarded as
  routing steps.
- **Offline spend is bounded and slashable**, not an unbounded pre-signed
  transaction where first-to-mempool wins.

Bitchat is the pipe. Carrier is the settlement and incentive layer — and
`Transport` in `packages/mesh` is deliberately small enough that Bitchat could
be one.
