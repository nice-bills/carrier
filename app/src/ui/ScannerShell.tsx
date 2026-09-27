import type { ReactNode } from "react";
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { C, R, S } from "../theme";
import { FONT } from "./fonts";

/** What a scanner is shown for: the camera part is `Scanner`, per platform. */
export interface ScannerProps {
  visible: boolean;
  title: string;
  /** Called with the text of every QR code read (a repeat of the last one is skipped). */
  onCode: (text: string) => void;
  onClose: () => void;
  /** The card at the bottom: what has been read so far, or what went wrong. */
  children: ReactNode;
  /** Preview only: codes a pretend camera reads, in order. */
  feed?: () => Promise<string[]>;
}

/**
 * The full-screen scanner's frame, around whatever shows the camera: a close
 * button, an amber finder, and a card at the bottom for progress.
 */
export function ScannerShell({
  visible,
  title,
  onClose,
  children,
  camera,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  camera: ReactNode;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={sc.fill}>
        {camera}
        <SafeAreaView style={sc.fill} pointerEvents="box-none">
          <View style={sc.top}>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the scanner" style={sc.close} hitSlop={8}>
              <Text style={sc.closeX}>✕</Text>
            </Pressable>
            <Text style={sc.title} accessibilityRole="header">
              {title}
            </Text>
            <View style={{ width: 44 }} />
          </View>
          <View style={sc.finderWrap} pointerEvents="none">
            <View style={sc.finder} />
          </View>
          <View style={sc.card}>{children}</View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const sc = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject, backgroundColor: "transparent" },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: S.gutter, paddingTop: 16 },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.16)", alignItems: "center", justifyContent: "center" },
  closeX: { color: "#FFFFFF", fontSize: 18, fontWeight: "600" },
  title: { color: "#FFFFFF", fontFamily: FONT.face, fontSize: 16, fontWeight: "600" },
  finderWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  finder: { width: 270, height: 270, borderRadius: 36, borderWidth: 3, borderColor: C.slip },
  card: { marginHorizontal: 16, marginBottom: 24, backgroundColor: C.paper, borderRadius: R.sheet - 4, padding: 20 },
});
