// Browser preview entry: the whole app on in-memory fakes, with sample slips,
// people and a pouch. See `src/demo/script.ts` for the `?screen=` options.
// No device module is imported on this path.
import "./src/polyfills.web";

import { createElement } from "react";
import { registerRootComponent } from "expo";
import App from "./App";
import { demoServices } from "./src/demo/services";
import { demoFromQuery } from "./src/demo/script";

const query = typeof window !== "undefined" && window.location ? window.location.search : "";
const { options, script } = demoFromQuery(query);
const services = demoServices(options);

registerRootComponent(() => createElement(App, { services, demo: script }));
