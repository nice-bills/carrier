import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Map as MapGL, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { C } from "../theme";
import { hhmm } from "../format";
import { FONT } from "../ui/fonts";
import { useReducedMotion } from "../ui/kit";
import { CAMPUS, CAMPUS_BOUNDS, CAMPUS_LABELS, DEMO_CENTRE } from "./demoCampus";
import { boundsOf, pinsFor, shapes } from "./geo";
import { PIN_H, PIN_W, PinView } from "./Pins";
import type { SpreadMapProps } from "./spreadMapProps";

export type { SpreadMapProps } from "./spreadMapProps";

/**
 * The spread map in the browser preview. Same props as the phone's
 * `SpreadMap.tsx`, drawn with maplibre-gl, but on a local style: the demo
 * campus from `demoCampus.ts`, since the preview cannot reach a tile server.
 * There are no glyphs offline either, so place names and pins are views laid
 * over the map at projected positions, redrawn as it moves.
 */

const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const grow = (lo: number, hi: number) => ["interpolate", ["exponential", 2], ["zoom"], 14, lo, 17, hi] as any;

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    campus: { type: "geojson", data: CAMPUS },
    routes: { type: "geojson", data: empty },
    points: { type: "geojson", data: empty },
  },
  layers: [
    { id: "land", type: "background", paint: { "background-color": C.mapLand } },
    { id: "park", type: "fill", source: "campus", filter: ["==", ["get", "kind"], "park"], paint: { "fill-color": C.mapPark } },
    { id: "water", type: "fill", source: "campus", filter: ["==", ["get", "kind"], "water"], paint: { "fill-color": C.mapWater } },
    {
      id: "road-casing",
      type: "line",
      source: "campus",
      filter: ["==", ["get", "kind"], "road"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.mapCasing, "line-width": grow(5, 40) },
    },
    {
      id: "road",
      type: "line",
      source: "campus",
      filter: ["==", ["get", "kind"], "road"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.card, "line-width": grow(4, 33) },
    },
    {
      id: "path",
      type: "line",
      source: "campus",
      filter: ["==", ["get", "kind"], "path"],
      layout: { "line-cap": "round" },
      paint: { "line-color": C.card, "line-width": grow(1.5, 11), "line-opacity": 0.9 },
    },
    { id: "building", type: "fill", source: "campus", filter: ["==", ["get", "kind"], "building"], paint: { "fill-color": C.mapBuilding } },
    {
      id: "route-faint",
      type: "line",
      source: "routes",
      filter: ["==", ["get", "line"], "faint"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.slipDeep, "line-opacity": 0.35, "line-width": 3 },
    },
    {
      id: "route-spread",
      type: "line",
      source: "routes",
      filter: ["==", ["get", "line"], "spread"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.slipDeep, "line-opacity": 0.75, "line-width": 2.5 },
    },
    {
      id: "route-casing",
      type: "line",
      source: "routes",
      filter: ["==", ["get", "line"], "focus"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.card, "line-width": 9 },
    },
    {
      id: "route-focus",
      type: "line",
      source: "routes",
      filter: ["==", ["get", "line"], "focus"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": C.slipDeep, "line-width": 4 },
    },
    {
      id: "points",
      type: "circle",
      source: "points",
      paint: {
        "circle-radius": ["get", "r"],
        "circle-color": ["match", ["get", "dot"], "settled", C.green, "me", C.slip, C.ink],
        "circle-stroke-color": C.card,
        "circle-stroke-width": 2.5,
      },
    },
  ],
};

export function SpreadMap({ routes, focus, me, here, mode, inset, locate, label, onReady }: SpreadMapProps) {
  const reduced = useReducedMotion();
  const box = useRef<View>(null);
  const [map, setMap] = useState<MapGL | null>(null);
  // Bumped on every camera move so the overlaid views follow the map.
  const [, setMoved] = useState(0);

  useEffect(() => {
    const el = box.current as unknown as HTMLElement | null;
    if (!el) return;
    const m = new MapGL({
      container: el,
      style: STYLE,
      center: [DEMO_CENTRE.lon, DEMO_CENTRE.lat],
      zoom: 16,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 0,
    });
    m.touchZoomRotate.disableRotation();
    const moved = () => setMoved((n) => n + 1);
    m.on("move", moved);
    m.on("load", () => {
      setMap(m);
      onReady?.();
    });
    return () => m.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { lines, points } = useMemo(() => shapes(routes, focus, me, mode), [routes, focus, me, mode]);
  const pins = useMemo(() => (mode === "route" && focus ? pinsFor(focus, me, hhmm) : []), [mode, focus, me]);

  useEffect(() => {
    if (!map) return;
    (map.getSource("routes") as GeoJSONSource).setData(lines);
    (map.getSource("points") as GeoJSONSource).setData(points);
  }, [map, lines, points]);

  const fit = () => {
    if (!map) return;
    map.resize();
    // Not laid out yet (or the controls are measured but the map is not): wait.
    if (map.getContainer().clientHeight < inset.top + inset.bottom + 160) return;
    const cells = mode === "route" ? (focus?.points.map((p) => p.cell) ?? []) : routes.flatMap((r) => r.points.map((p) => p.cell));
    const b = boundsOf(cells.length ? cells : here ? [here] : []) ?? [CAMPUS_BOUNDS.slice(0, 2), CAMPUS_BOUNDS.slice(2)];
    map.fitBounds(b as [[number, number], [number, number]], {
      padding: { top: inset.top + 50, bottom: inset.bottom + 40, left: 70, right: 70 },
      duration: reduced ? 0 : 600,
      maxZoom: 17,
    });
  };
  useEffect(fit, [map, mode, focus, routes, here, inset.top, inset.bottom, reduced]);
  useEffect(() => {
    if (!map || !locate) return;
    if (here) map.easeTo({ center: [here.lon, here.lat], zoom: 16.5, duration: reduced ? 0 : 600 });
    else fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate]);

  const xy = (lon: number, lat: number) => (map ? map.project([lon, lat]) : null);

  return (
    <View style={StyleSheet.absoluteFill} accessible accessibilityRole="image" accessibilityLabel={label}>
      {/* maplibre makes its container position: relative, so size it by width and height, not insets. */}
      <View ref={box} style={{ width: "100%", height: "100%" }} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: "hidden" }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {map
          ? CAMPUS_LABELS.map((l) => {
              const p = xy(l.at[0], l.at[1])!;
              return (
                <Text key={l.name} style={[s.place, l.green && s.green, { left: p.x - 60, top: p.y - 8 }]} numberOfLines={1}>
                  {l.name}
                </Text>
              );
            })
          : null}
        {map
          ? pins.map((pin) => {
              const p = xy(pin.cell.lon, pin.cell.lat)!;
              return (
                <View key={pin.key} style={{ position: "absolute", left: p.x - PIN_W / 2, top: p.y - PIN_H / 2 }}>
                  <PinView pin={pin} />
                </View>
              );
            })
          : null}
      </View>
    </View>
  );
}

/** The preview has no tile server to save from. */
export const canSaveOffline = false;

/** The preview draws a made-up campus, not map data, so it credits nobody's tiles. */
export const ATTRIBUTION = { text: "Demo campus, drawn for the preview", url: null as string | null };

export async function saveArea(): Promise<void> {
  throw new Error("Saving the map for offline needs the phone app.");
}

const s = StyleSheet.create({
  place: { position: "absolute", width: 120, textAlign: "center", fontFamily: FONT.face, fontSize: 11, fontWeight: "600", color: C.ink2 },
  green: { color: C.greenInk },
});
