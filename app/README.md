# Carrier — Android client

One screen: what this phone is carrying, and who is near enough to hand it to.

## Running it

Nearby Connections needs native code, so Expo Go will not work — this needs a
development build on a real Android device. Two devices, because a mesh with one
node is just a wallet.

```bash
npm install
cd app
npx expo prebuild --platform android --clean
npx expo run:android
```

Grant Bluetooth, Nearby devices and Location when asked. Location is not used for
anything; Android requires it before it will let an app scan for nearby devices.

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

## What is verified and what is not

The mesh logic underneath this app is tested without radios — custody,
co-signed handoffs, chain validation, framing, and the wire format round trip
(`npx vitest run --root packages/mesh`, 17 tests). Settlement is tested against
a real validator (`npx vitest run --root tests`, 9 tests).

**The radio layer itself is unverified.** `NearbyTransport` has never run on a
phone. Discovery timing, payload size limits, permission flows and what happens
when someone walks out of range mid-transfer are all unknown until two Android
devices are in the same room. Expect that to be the day's work, not an evening's.
