# Carrier — phone client (Android and iPhone)

A pocket for payments that travel by hand. First run ends in a real handoff;
after that there are three tabs:

- **Carry** — what is in your pocket, drawn as amber slips with a red stamp
  for everyone who carried each one, and the people in range. Drag a slip onto
  a person (or tap them and use the button, or the slip's screen-reader
  actions) to hand it on. Tap someone holding a payment to take it. Pay
  someone from here. Slips paid to you, or that you carry, can be settled
  from here when the phone has signal.
- **Around** — who is in range, and a logbook of everything this phone has
  seen: handoffs, arrivals, settlements.
- **You** — rank (distinct people met), what this phone has done, its pouch
  (committed, available, what you can still sign offline, bond, when the
  period closes), "Set up pouch", and the device key.

Design tokens (paper, ink, slip, stamp, denim, kraft, receipt) are in
`src/theme.ts`, ported from `docs/pocket.html`. The mockup's fonts are not
bundled; Android uses Roboto at heavy weights, the system monospace, and
"casual" for the handwriting (`src/ui/fonts.ts`).

## Running it

Nearby Connections needs native code, so Expo Go will not work — this needs a
native build on real phones. Two of them, because a mesh with one node is just
a wallet, and **two of the same kind**: Android phones pass to Android phones
(Google Nearby Connections) and iPhones to iPhones (Apple Multipeer
Connectivity). The two stacks cannot hear each other, so a mixed room splits in
two.

### Android

```bash
npm ci
cd app
npx expo prebuild --platform android --clean
npx expo run:android
```

### iPhone

Everything iOS needs is in `app.json` and runs at prebuild: bundle id
`xyz.carrier.mesh`, the Local Network and Bluetooth prompts (Multipeer asks for
both itself the first time the radio starts; there is no runtime call), the
`_carrier._tcp` and `_carrier._udp` Bonjour services (`plugins/with-multipeer-udp.js`
adds the UDP one), and the location prompt, which only the map uses. Haptics
use the Taptic Engine (`expo-haptics`), since iOS ignores vibration lengths.

`patches/expo-nearby-connections+1.1.1.patch` (applied by `npm ci`) fixes the
library's iOS side: it gave advertising and discovery separate peer ids and
sessions, so the id a phone discovered was not the id that connected. The
transport also never asks Multipeer to drop a single peer, because on iOS that
ends every connection and stops the radio; a peer it refuses is ignored
instead (`src/transport/nearby.ts`).

**With a Mac** (free): install Xcode, plug the iPhone in, turn on Developer
Mode (Settings › Privacy & Security), then

```bash
npm ci
cd app
npx expo prebuild --platform ios --clean
npx expo run:ios --device --configuration Release
```

Xcode will ask for a team the first time: a free Apple ID works ("Personal
Team"). The app then runs for 7 days before it needs reinstalling. If the bundle
id is taken, change `ios.bundleIdentifier` in `app.json`.

**Without a Mac**: EAS builds it in the cloud (`eas.json`, profile `preview`),
but installing on a phone needs a paid Apple Developer account ($99 a year) to
sign it:

```bash
npm i -g eas-cli
cd app
eas build --platform ios --profile preview
```

EAS registers the phones and gives an install link. Nothing about this has
been run yet: the iOS bundle builds (`npx expo export --platform ios`) and
prebuild generates the Xcode project, but no one has compiled it.

### Both

`expo-nearby-connections` 1.x is a Nitro module and needs the New Architecture
(`newArchEnabled` is on in `app.json`) and `react-native-nitro-modules`. Its
compatibility table lists Expo 51 and 55; this app is on Expo 52 / RN 0.76, a
combination the library does not list and that has not been built yet.

On Android the app asks for Bluetooth, Nearby devices and Location when it
turns the radio on, and says in one sentence why. Location is not used for the
radio; Android requires it before it will let an app scan for nearby devices.
On iPhone the system asks for Local Network and Bluetooth by itself.

Checks that run without a device:

```bash
npx tsc -p app                                            # types
npx vitest run --root app                                 # pocket, books, messages, demo device
node --experimental-strip-types app/scripts/contrast.ts   # WCAG 2.2 AA for every colour pair
```

## Browser preview (demo mode)

`demo.ts` is a second entry point that boots the same `App` on in-memory fakes
(`src/demo/services.ts`): no keystore, files, radio or network. Every slip in
it is a real signed bundle and the "other phones" are real pockets joined by a
function call. The screen is picked from the query string
(`src/demo/script.ts`): `?screen=onboarding&step=0..4`, `carry`, `around`,
`you`, `pay&step=who|amount|confirm`, `confirm`, `pass`, `settle`, `pouch`,
`terms`, `privacy`; add `&reduced=1`, `&offline=1`, `&nopouch=1`, `&alone=1`.
It needs `react-dom` and `react-native-web` to run in a browser, which are not
dependencies of the app.

Screens never import a device module. They get everything through
`src/services/types.ts`: `src/services/native.ts` is the phone,
`src/demo/services.ts` the preview.

## How money moves

**Handing over.** Each phone advertises a random session id, never its key.
On connecting, each side proves its key by signing a fresh challenge bound to
both session ids (`src/transport/auth.ts`); nothing else is accepted until that
verifies. Then:

1. Your person confirms a pass on the sheet. The pocket records the intent
   (`Pocket.handTo`) and the radio sends a `hand` message naming the note.
2. The other phone asks for exactly that note, re-verifies the whole chain
   (`src/chain.ts`), takes custody (`CarrierNode.acceptHandoff`) and sends
   back its counter-signature.
3. That signature is the receipt. Only when it verifies does the giver let go
   of the note (`Pocket.acknowledged`) and log the handoff.

A note this phone signed is only ever served to the person it was handed to.
A note it carries for someone else can also be *taken* by anyone nearby who
asks. A note paid to this phone is never offered; it waits to be settled.
Every handoff is co-signed by both phones and counts toward rank.

**Paying.** A payment needs this phone's pouch: its address, current epoch
and epoch start, fetched with `@carrier/client` whenever there is signal and
kept on disk. Offline, the phone refuses to sign past that pouch's
`available` minus everything it has signed and not yet seen settle
(`src/ledger.ts`). Notes expire after a week or when the pouch's period closes,
whichever is first.

**Slots are never reused.** Signing the same slot twice is a double spend and
the program takes the bond for it. The slot and the note are written to the
pocket file *before* the note is signed; if that write fails, nothing is
signed. On restart every signed note's slot is re-added to the used set.

**Settling.** With signal, a slip paid to you (or one you carry) has a
Settle button. `settleBundle` from `@carrier/client` builds and sends the
transactions, this phone paying the fees. When it lands the app shows a
receipt with SETTLED stamped on it: who was paid, and how much each carrier
got (mirroring `split_payout` in the program). While online the app also
checks the pouches behind every note it holds or handed on, and when one
settles elsewhere it says so. If a slot turns out to have been taken by a
*different* note (the sender signed it twice), the app says the note can no
longer settle; it cannot yet file the double-spend proof itself.

**Setting up a pouch** (devnet only for now, `src/config.ts`): the sheet says
it needs SOL for fees and USDC to commit, offers a devnet airdrop and a link
to Circle's faucet, and opens the pouch with the chosen allowance plus a bond
of a fifth of it.

## Hardening kept from before

Every inbound payload is shape-checked; frames per message, half-finished
transfers, bytes buffered, digest-list length, handed-list length and frame
rate are capped per peer; requests time out after 10 s; a peer that keeps
breaking the rules is disconnected (`src/transport/messages.ts`,
`src/transport/nearby.ts`). Held notes are re-verified from scratch when the
app starts. The key lives in the Android keystore and is never replaced on a
read error. Polyfills for Hermes are in `src/polyfills.ts`.

## Accessibility

Every control has a role, label and (where it helps) a hint, and is at least
48dp. Every drag has a button equivalent. With reduced motion on, the slip
snaps instead of springing, SETTLED appears instead of slamming, sheets
appear in place and the first-run demo shows its last frame. Arrivals,
handoffs and settlements are announced to screen readers. Colour is never the
only signal (stamps and marks carry words). No text sits on translucency: the
sheet scrim is the only translucent colour and holds nothing. Contrast for
every pair is checked by `scripts/contrast.ts`.

## What is verified and what is not

Verified without a device: types (`npx tsc -p app`); the pocket's pay → hand
over → deliver path, carrier hops, taking, slot bookkeeping across restarts,
refusing to overspend, refusing to sign when the slot cannot be saved, and
noticing settlements and double spends, with real signatures between real
pockets joined in memory (`src/pocket.test.ts`, `src/demo/demo.test.ts`);
colour contrast.

**Not verified without hardware:** anything on a phone. The native build
(Expo 52 + Nitro 0.35 + expo-nearby-connections 1.1.1), the permission flow,
discovery timing, payload limits, walking out of range mid-transfer, the drag
gesture and its hit-testing, TalkBack reading order and announcements, the
system fonts' look, and `@carrier/client` running under Hermes (settlement,
pouch setup and the airdrop against devnet). The screens themselves have been
type-checked, not rendered.

## Browser preview

The whole app runs in a browser on in-memory fakes (sample slips, people and
a pouch), with react-native swapped for react-native-web. Use it for
screenshots and design review; it is not the shipping build and never loads
the radio, keystore or file system.

```
npm run preview -w app          # http://localhost:5199/?screen=carry
node app/preview/shot.mjs "?screen=you" you.png   # with the preview running
node app/preview/phone-run.mjs out/               # whole journey on an emulated Pixel 7, with video
```

To check the real Android bundle builds (Metro, Hermes) without a phone:
`npx expo export --platform android --output-dir /tmp/android-export` from `app/`.

Screens: `?screen=onboarding&step=0..4`, `carry`, `around`, `you`, `pay&step=who|amount|confirm`,
`confirm`, `pass`, `settle`, `pouch`, `terms`, `privacy`. Modifiers: `&reduced=1`,
`&offline=1`, `&nopouch=1`, `&alone=1`. See `src/demo/script.ts`.
