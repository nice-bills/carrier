// Browser preview stand-in for `expo`: mount the root component with
// react-native-web instead of the native entry.
import type { ComponentType } from "react";
import { AppRegistry } from "react-native";

export function registerRootComponent(component: ComponentType) {
  AppRegistry.registerComponent("main", () => component);
  AppRegistry.runApplication("main", { rootTag: document.getElementById("root") });
}
