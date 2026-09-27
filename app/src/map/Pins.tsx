import { StyleSheet, Text, View } from "react-native";
import { C } from "../theme";
import { FONT } from "../ui/fonts";
import type { Pin } from "./geo";

/**
 * One pin of the chosen route, drawn with views so both map components share
 * it: a round face (two letters, "You", or a green tick where it settled) and
 * a small tag with the time, on the side away from the line. The box is
 * centred on the point and wide enough for a tag either side. Decorative: the
 * screen's stats card and the map's label say the same in words.
 */
export const PIN_W = 190;
export const PIN_H = 50;

export function PinView({ pin }: { pin: Pin }) {
  const size = pin.dot === "settled" ? 44 : pin.dot === "me" ? 42 : 38;
  const tag = (
    <View style={[p.tag, pin.dot === "settled" && p.tagSettled]}>
      <Text style={[p.tagText, pin.dot === "settled" && p.tagTextSettled]}>{pin.tag}</Text>
    </View>
  );
  return (
    <View pointerEvents="none" style={p.box} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <View style={[p.side, { alignItems: "flex-end" }]}>{pin.side === "left" ? tag : null}</View>
      <View
        style={[
          p.face,
          { width: size, height: size, borderRadius: size / 2 },
          pin.dot === "me" && { backgroundColor: C.slip },
          pin.dot === "settled" && { backgroundColor: C.green },
        ]}
      >
        {pin.dot === "settled" ? (
          <View style={p.tick} />
        ) : (
          <Text style={[p.faceText, pin.dot === "me" && { color: C.slipInk }]}>{pin.face}</Text>
        )}
      </View>
      <View style={[p.side, { alignItems: "flex-start" }]}>{pin.side === "right" ? tag : null}</View>
    </View>
  );
}

const p = StyleSheet.create({
  box: { width: PIN_W, height: PIN_H, flexDirection: "row", alignItems: "center" },
  side: { flex: 1, paddingHorizontal: 6 },
  face: {
    backgroundColor: C.ink,
    borderWidth: 3,
    borderColor: C.card,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: C.ink,
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  faceText: { fontFamily: FONT.face, fontSize: 12, fontWeight: "700", color: C.onInk },
  tick: { width: 14, height: 8, borderLeftWidth: 3, borderBottomWidth: 3, borderColor: C.onInk, transform: [{ translateY: -2 }, { rotate: "-45deg" }] },
  tag: {
    backgroundColor: C.card,
    borderRadius: 11,
    paddingHorizontal: 9,
    paddingVertical: 3,
    shadowColor: C.ink,
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  tagSettled: { backgroundColor: C.green },
  tagText: { fontFamily: FONT.face, fontSize: 11, fontWeight: "600", color: C.ink2 },
  tagTextSettled: { color: C.onInk },
});
