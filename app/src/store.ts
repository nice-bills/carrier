import * as FileSystem from "expo-file-system";
import type { PocketStore } from "./pocket";

/**
 * The pocket on the phone: one JSON file in the app's private document
 * directory, written to a temp file and then moved over the old one, so a
 * crash mid-write leaves the previous pocket intact rather than half of a new
 * one.
 *
 * Android's move is a rename(2), which replaces the old file atomically. iOS
 * refuses to move onto an existing file, so there the old one is deleted
 * first; a crash in that gap leaves only the complete temp file, which `read`
 * falls back to.
 */
export function fileStore(): PocketStore {
  if (!FileSystem.documentDirectory) throw new Error("no document directory to keep notes in");
  const dir = `${FileSystem.documentDirectory}carrier/`;
  const file = `${dir}pocket.json`;
  const tmp = `${dir}pocket.json.tmp`;
  return {
    async read() {
      if ((await FileSystem.getInfoAsync(file)).exists) return FileSystem.readAsStringAsync(file);
      if ((await FileSystem.getInfoAsync(tmp)).exists) return FileSystem.readAsStringAsync(tmp);
      return null;
    },
    async write(text: string) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
      await FileSystem.writeAsStringAsync(tmp, text);
      try {
        await FileSystem.moveAsync({ from: tmp, to: file });
      } catch {
        await FileSystem.deleteAsync(file, { idempotent: true });
        await FileSystem.moveAsync({ from: tmp, to: file });
      }
    },
  };
}
