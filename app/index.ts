// Must stay the first import: web3.js, tweetnacl and the protocol codec touch
// crypto, Buffer and TextEncoder while their modules load.
import "./src/polyfills";

import { createElement } from "react";
import { registerRootComponent } from "expo";
import App from "./App";
import { nativeServices } from "./src/services/native";

// The real device: keystore, private files, Nearby Connections, Solana RPC.
// For the browser preview with sample data, see `demo.ts`.
const services = nativeServices();

registerRootComponent(() => createElement(App, { services }));
