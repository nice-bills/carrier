# Where Carrier stands

_Last updated: 2026-09-27 (after the 2026-09-27 audit fixes)_

## What passes, and what has not been run

Numbers below are filled in from an actual run of each command on the date
above. A cell reading `TBD` has not been run since the audit fixes and claims
nothing.

| Check | Command | Result |
| --- | --- | --- |
| Install from lockfile | `npm ci` | passes |
| Type-check (packages) | `npx tsc -p tsconfig.json` | clean |
| Type-check (app) | `npx tsc -p app` | clean |
| Program units | `cargo test --manifest-path programs/carrier/Cargo.toml --lib` | 18/18 |
| Protocol codec | `npx vitest run --root packages/protocol` | 24/24 |
| Mesh | `npx vitest run --root packages/mesh` | 52/52 |
| Game / scoring | `npx vitest run --root packages/game` | 30/30 |
| Settlement client | `npx vitest run --root packages/client` | 42/42 (devnet e2e skipped without `CARRIER_E2E_RPC`) |
| App logic (incl. QR handoff codec) | `npx vitest run --root app` | 61/61 |
| App contrast | `node --experimental-strip-types app/scripts/contrast.ts` | 38/38 pairs AA |
| Settlement (e2e, local validator) | `./scripts/localnet.sh` | not run since the fixes (no validator in the audit environment); type-checks |
| Settlement (e2e, devnet) | `./scripts/devnet.sh` | not run; the devnet deployment predates the fixes and must be redeployed |
| Scripts lint | `bash -n scripts/*.sh && shellcheck scripts/*.sh` | clean |
| iPhone build (unsigned, for sideloading) | GitHub Actions `ios-sideload.yml` | builds (Xcode, macOS runner); never installed on a phone |
| **App on a phone** | radio: two Androids or two iPhones; QR code: any two phones | **never run** |

Between an iPhone and an Android, or with radios off, a payment can be handed
over by QR code (the receiver shows their key, the giver shows the slip signed
over to it, the receiver shows a receipt back). It runs in the browser preview
and its codec is tested; it has not been used with real cameras.

The app type-checks and its transport was exercised against an in-memory fake
of the radio library, but it has never been built or run on a device. See
`app/README.md` for exactly what that leaves unknown. Settlement from the phone
is not built.

## Live on devnet

**Stale since the 2026-09-27 audit fixes.** The program at this address is the
old build: it still has the bond, relay-fee and refill problems, and its pouch
layout differs from the current code. Redeploy with `./scripts/devnet.sh`
before pointing anyone at it.

```
CJBPBb6WBPWptmpiW4Kdb7SeRC7Cmob5YAaBtKSMXBvt
https://explorer.solana.com/address/CJBPBb6WBPWptmpiW4Kdb7SeRC7Cmob5YAaBtKSMXBvt?cluster=devnet
```

The whole suite passes there, not just on a local validator: a note carried by
two strangers settles, a four-hop chain settles by accumulation, the bond
slashes on a double spend, and every rejection path rejects. That is the
contract address the submission form asks for.

One fix was needed to get there. Anchor's default commitment is `processed`,
which is fine against a local validator and wrong against a real cluster — a
blockhash fetched at that commitment can be newer than the node asked to
simulate against it, and the run dies on `Blockhash not found` before a single
test executes. The suite now builds its provider at `confirmed`.

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
neither reducible.

**This is no longer the ceiling on chain length — only on the fast path.**
`begin_settlement` / `extend_settlement` / `finalize_settlement` accumulate the
same verification across several transactions into a draft account, so chains
run to `MAX_CHAIN` (16), bounded by payout cost rather than signature bytes.
A four-hop chain settling that way is covered by the test suite. The mesh builds
up to `MAX_CHAIN`, so a six-hop chain settles by the slower route instead of
being unredeemable.

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

Two cheaper attacks *are* closed on-chain: a key may appear at most once in a
chain, and neither the sender nor the recipient can be paid as a carrier of
their own payment. Beyond that the defence has to be economic:

> Make the reward a function of **distinct counterparties with independent
> settlement history**, not raw hop count.

Two phones produce a degenerate lineage — the same pair repeatedly, no
independent history behind either key. If repeat encounters pay sharply less and
meeting a history-less key is worth near zero, the attack earns nothing while
still costing fees. The cheat is not detected; it is made not worth doing.
Composes with attestations (SAS, Civic) later without day-one onboarding
friction. `relay_fee_bps` already fixes the pot before the note leaves, so extra
hops divide it rather than adding to it — inflating a chain dilutes your own
share rather than minting a new one. `superspreaders()` ranks by *distinct*
recipients for the same reason: a pocket of your own phones is a very small set.

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

What remains needs hardware and a room full of people:

1. **Build and run the app on two phones of the same kind** (two Androids or
   two iPhones; `app/README.md` has both build paths). The Nearby transport now
   targets the real `expo-nearby-connections` 1.x API, authenticates peers and
   is wired to the mesh, but it has never executed on a device. The native
   build (Expo 52 with a Nitro module the library lists for Expo 51 and 55),
   discovery timing, payload limits, the permission flow, and what happens when
   someone walks out of range mid-transfer are all unknown. Budget a day, not
   an evening.
2. **Settle from the phone**, or decide the demo settles from a laptop. The app
   carries and delivers notes but submits nothing on-chain.
3. **Rehearse the airplane-mode demo** until it is boring. Radio demos fail on
   stage; the only defence is repetition.
4. **Draw the spread map.** `buildSpread`, `reproductionNumber`,
   `superspreaders` and `generations` turn settlement events into the picture —
   the rendering is all that is missing.
5. **Decide payments or contagion for the pitch.** Both run on this engine
   unchanged; the difference is the story and the top screen.

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
