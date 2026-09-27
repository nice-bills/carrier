import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { QrCode } from "./QrCode";
import { ScannerShell, type ScannerProps } from "./ScannerShell";

/**
 * The browser preview's camera: a dark room with the other phone held up in
 * it, showing the codes the preview's pretend people would show, one after
 * another, as a real camera would read them.
 */
export function Scanner({ visible, title, onCode, onClose, children, feed }: ScannerProps) {
  const [shown, setShown] = useState<string | null>(null);
  const on = useRef(onCode);
  on.current = onCode;
  // Read once per opening: the caller passes a new function every render.
  const fed = useRef(feed);
  fed.current = feed;
  useEffect(() => {
    const feed = fed.current;
    if (!visible || !feed) return;
    let stop = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    feed()
      .then((codes) => {
        codes.forEach((code, i) => {
          timers.push(setTimeout(() => !stop && setShown(code), 400 + i * 1100));
          timers.push(setTimeout(() => !stop && on.current(code), 1000 + i * 1100));
        });
      })
      .catch(() => {});
    return () => {
      stop = true;
      timers.forEach(clearTimeout);
      setShown(null);
    };
  }, [visible]);

  const camera = (
    <View style={[StyleSheet.absoluteFill, w.room]}>
      {shown ? (
        <View style={w.phone}>
          <QrCode value={shown} size={150} label="The other phone's code" />
        </View>
      ) : null}
    </View>
  );
  return (
    <ScannerShell visible={visible} title={title} onClose={onClose} camera={camera}>
      {children}
    </ScannerShell>
  );
}

const w = StyleSheet.create({
  room: { backgroundColor: "#24262C", alignItems: "center", justifyContent: "center" },
  phone: { width: 180, height: 240, borderRadius: 28, backgroundColor: "#F5F4F0", alignItems: "center", justifyContent: "center", transform: [{ rotate: "-7deg" }] },
});
