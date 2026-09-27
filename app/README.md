# Carrier — Android client

One screen: what this phone is carrying, and who is near enough to hand it to.

## Running it

Nearby Connections needs native code, so Expo Go will not work — this needs a
development build on a real Android device. Two devices, because a mesh with one
node is just a wallet.

```bash
npm ci
cd app
npx expo prebuild --platform android --clean
npx expo run:android
```

`expo-nearby-connections` 1.x is a Nitro module and needs the New Architecture
(`newArchEnabled` is on in `app.json`) and `react-native-nitro-modules`. Its
compatibility table lists Expo 51 and 55; this app is on Expo 52 / RN 0.76, a
combination the library does not list and that has not been built yet (see below).

The app asks for Bluetooth, Nearby devices and Location when it turns the radio
on, and explains on screen if they are refused. Location is not used for
anything; Android requires it before it will let an app scan for nearby devices.

Type-check without a device: `npm run typecheck -w app` (or `npx tsc -p app`).

## Why Nearby Connections and not BLE

`react-native-ble-plx` is the obvious choice and it cannot do this. It is
central-only — it can connect *to* peripherals but cannot advertise — so two
phones running it never see each other. That has been open since 2018 and is
the library's scope, not a misconfiguration.

Nearby Connections does both roles, and its `P2P_CLUSTER` strategy is
many-to-many, which is the shape of a mesh. It negotiates Bluetooth and Wi-Fi
Direct underneath, so range and throughput beat raw BLE. All of it is local
radio: no internet at any point.

Android only. iOS restricts this enough that supporting it would cost a day and
return nothing for a demo.

## How a handoff works on the phone

1. Each phone advertises a random session id (`c1-` + 16 hex), not its wallet
   key, and rotates it every time the radio is turned on.
2. On connecting, each side sends a random 32-byte challenge. The other signs
   `carrier:peer-auth:v1 | nonce | its session | our session | its key` with its
   wallet key. Nothing else is accepted from, or sent to, a peer until that
   proof verifies (`src/transport/auth.ts`).
3. Once a peer is proven, the phone asks for its digests, requests each note it
   does not hold, re-verifies the whole chain (`src/chain.ts`), hands it to
   `CarrierNode.acceptHandoff`, and sends back its counter-signature
   (`Pocket.exchange` in `src/pocket.ts`). Both phones do this, so notes move
   both ways. A note addressed to this phone is kept, not passed on.
4. Held notes are written to the app's private storage after every change and
   re-verified when the app starts again.

Every inbound payload is shape-checked; frames per message, half-finished
transfers, bytes buffered, digest-list length and frame rate are capped per
peer; requests time out after 10 s; and a peer that keeps breaking the rules is
disconnected (`src/transport/messages.ts`).

**Not built: settlement from the phone.** The app carries, receives and hands
off notes, but it never submits a settlement transaction. A note paid to this
phone is shown as "paid to you" and has to be settled from a computer with
signal (see `tests/` for how). There is also no screen to originate a payment
yet: `CarrierNode.originate` exists, the UI for it does not.

## What is verified and what is not

The mesh logic underneath this app is tested without radios — custody,
co-signed handoffs, chain validation, framing, and the wire format round trip
(`npx vitest run --root packages/mesh`). Settlement is tested against a real
validator (`npx vitest run --root tests`). Current counts are in
[`STATUS.md`](../STATUS.md), not here, so they cannot drift.

The app code type-checks (`npx tsc -p app`). The transport, handshake and
pocket were also exercised in Node against an in-memory fake of
`expo-nearby-connections`: two phones authenticate, exchange a note,
acknowledge it, and reload it after a restart; a peer sending junk frames is
disconnected. That fake is not the real radio.

**The radio layer itself is unverified on hardware.** Nothing here has run on a
phone: the native build (Expo 52 + Nitro 0.35 + expo-nearby-connections 1.1.1),
the permission flow, discovery timing, the payload size limit, and what happens
when someone walks out of range mid-transfer are all unknown until two Android
devices are in the same room.
