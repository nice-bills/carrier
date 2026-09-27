// Must stay the first import: web3.js, tweetnacl and the protocol codec touch
// crypto, Buffer and TextEncoder while their modules load.
import "./src/polyfills";

import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
