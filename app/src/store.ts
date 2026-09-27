import * as FileSystem from "expo-file-system";
import type { PocketStore } from "./pocket";

/**
 * The pocket on the phone: one JSON file in the app's private document
 * directory, written to a temp file and then moved over the old one, so a
 * crash mid-write leaves the previous pocket intact rather than half of a new
 * one.
 */
export function fileStore(): PocketStore {
  if (!FileSystem.documentDirectory) throw new Error("no document directory to keep notes in");
  const dir = `${FileSystem.documentDirectory}carrier/`;
  const file = `${dir}pocket.json`;
  const tmp = `${dir}pocket.json.tmp`;
  return {
    async read() {
      const info = await FileSystem.getInfoAsync(file);
      if (!info.exists) return null;
      return FileSystem.readAsStringAsync(file);
    },
    async write(text: string) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
      await FileSystem.writeAsStringAsync(tmp, text);
      await FileSystem.moveAsync({ from: tmp, to: file });
    },
  };
}
