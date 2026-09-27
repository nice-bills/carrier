import { useEffect, useRef } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "./kit";
import { ScannerShell, type ScannerProps } from "./ScannerShell";
import { C } from "../theme";
import { FONT } from "./fonts";

/**
 * The phone's camera, reading QR codes only. Asks for the camera the first
 * time it opens; the app never keeps a picture.
 */
export function Scanner({ visible, title, onCode, onClose, children }: ScannerProps) {
  const [perm, ask] = useCameraPermissions();
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (visible) last.current = null;
    if (visible && perm && !perm.granted && perm.canAskAgain) ask().catch(() => {});
  }, [visible, perm?.granted]);

  const allowed = !!perm?.granted;
  const camera = allowed ? (
    <CameraView
      style={StyleSheet.absoluteFill}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      onBarcodeScanned={
        visible
          ? ({ data }) => {
              if (typeof data !== "string" || data === last.current) return;
              last.current = data;
              onCode(data);
            }
          : undefined
      }
    />
  ) : (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: C.ink }]} />
  );

  return (
    <ScannerShell visible={visible} title={title} onClose={onClose} camera={camera}>
      {allowed || !perm ? (
        children
      ) : (
        <View style={{ gap: 12 }}>
          <Text style={st.text}>Carrier needs the camera to read the other phone's code. It never keeps a picture.</Text>
          <Button label={perm.canAskAgain ? "Allow the camera" : "Open settings"} onPress={() => (perm.canAskAgain ? ask().catch(() => {}) : Linking.openSettings().catch(() => {}))} />
        </View>
      )}
    </ScannerShell>
  );
}

const st = StyleSheet.create({
  text: { fontFamily: FONT.face, fontSize: 15, lineHeight: 22, color: C.ink2 },
});
