import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  Camera,
  CircleLayer,
  LineLayer,
  MapView,
  MarkerView,
  OfflineManager,
  ShapeSource,
  type CameraStop,
} from "@maplibre/maplibre-react-native";
import { C } from "../theme";
import { hhmm } from "../format";
import { useReducedMotion } from "../ui/kit";
import { boundsOf, fitCells, fitKey, pinsFor, shapes } from "./geo";
import { PinView } from "./Pins";
import type { SpreadMapProps } from "./spreadMapProps";

export type { SpreadMapProps } from "./spreadMapProps";

/**
 * The spread map on a phone: MapLibre with OpenFreeMap's Positron style (grey
 * and white, the calmest of its styles, so the amber route is the only colour
 * on the page). Routes are GeoJSON lines; in "route" mode the chosen route's
 * points are pins drawn with views (`PinView`), in "today" mode every point is
 * a dot. The camera fits the chosen route, or everything, clear of the
 * floating controls. MapLibre's own logo and attribution button are off; the
 * screen draws the OpenStreetMap credit itself.
 *
 * `SpreadMap.web.tsx` is the browser preview's stand-in with the same props.
 */

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

export function SpreadMap({ routes, focus, me, here, mode, inset, locate, label, onReady }: SpreadMapProps) {
  const reduced = useReducedMotion();
  const { lines, points } = useMemo(() => shapes(routes, focus, me, mode), [routes, focus, me, mode]);
  const pins = useMemo(() => (mode === "route" && focus ? pinsFor(focus, me, hhmm) : []), [mode, focus, me]);

  // What the camera should show: the chosen route (or everything today), else
  // where the phone is. Refit only when that changes (see `fitKey`), not on
  // every pocket refresh, so a pan or zoom stays put.
  const key = fitKey(routes, focus, here, mode);
  const fit = useMemo<CameraStop>(() => {
    const cells = fitCells(routes, focus, mode);
    const b = boundsOf(cells.length ? cells : here ? [here] : []);
    if (!b) return { zoomLevel: 2, centerCoordinate: [0, 20] };
    return {
      bounds: {
        sw: b[0],
        ne: b[1],
        paddingTop: inset.top + 50,
        paddingBottom: inset.bottom + 40,
        paddingLeft: 70,
        paddingRight: 70,
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, inset.top, inset.bottom]);

  // The locate button: centre on this phone if it knows where it is, else refit.
  const [stop, setStop] = useState<CameraStop>(fit);
  useEffect(() => setStop(fit), [fit]);
  useEffect(() => {
    if (!locate) return;
    setStop(here ? { centerCoordinate: [here.lon, here.lat], zoomLevel: 16 } : { ...fit });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate]);

  return (
    <View style={StyleSheet.absoluteFill} accessible accessibilityRole="image" accessibilityLabel={label}>
      <MapView
        style={StyleSheet.absoluteFill}
        mapStyle={STYLE_URL}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled={false}
        pitchEnabled={false}
        rotateEnabled={false}
        onDidFinishLoadingMap={onReady}
      >
        <Camera {...stop} animationMode={reduced ? "moveTo" : "easeTo"} animationDuration={reduced ? 0 : 600} />
        <ShapeSource id="routes" shape={lines}>
          <LineLayer
            id="route-faint"
            filter={["==", ["get", "line"], "faint"]}
            style={{ lineColor: C.slipDeep, lineOpacity: 0.35, lineWidth: 3, lineCap: "round", lineJoin: "round" }}
          />
          <LineLayer
            id="route-spread"
            filter={["==", ["get", "line"], "spread"]}
            style={{ lineColor: C.slipDeep, lineOpacity: 0.75, lineWidth: 2.5, lineCap: "round", lineJoin: "round" }}
          />
          <LineLayer
            id="route-casing"
            filter={["==", ["get", "line"], "focus"]}
            style={{ lineColor: C.card, lineWidth: 9, lineCap: "round", lineJoin: "round" }}
          />
          <LineLayer
            id="route-focus"
            filter={["==", ["get", "line"], "focus"]}
            style={{ lineColor: C.slipDeep, lineWidth: 4, lineCap: "round", lineJoin: "round" }}
          />
        </ShapeSource>
        <ShapeSource id="points" shape={points}>
          <CircleLayer
            id="points"
            style={{
              circleRadius: ["get", "r"],
              circleColor: ["match", ["get", "dot"], "settled", C.green, "me", C.slip, C.ink],
              circleStrokeColor: C.card,
              circleStrokeWidth: 2.5,
            }}
          />
        </ShapeSource>
        {pins.map((p) => (
          <MarkerView key={p.key} coordinate={[p.cell.lon, p.cell.lat]} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
            <PinView pin={p} />
          </MarkerView>
        ))}
      </MapView>
    </View>
  );
}

/** Whether this build can keep map tiles for use without signal. */
export const canSaveOffline = true;

/** Credit the tile licence asks for: OpenFreeMap's tiles, OpenMapTiles' schema, OSM's data. */
export const ATTRIBUTION = { text: "OpenFreeMap © OpenMapTiles © OpenStreetMap", url: "https://www.openstreetmap.org/copyright" };

/**
 * Download the map around `cells` (zooms 13 to 17) so it draws with no
 * signal. Needs signal while it runs. `onProgress` gets 0 to 100; resolves
 * when the pack is complete, rejects on a download error.
 */
export async function saveArea(cells: readonly { lat: number; lon: number }[], onProgress: (pct: number) => void): Promise<void> {
  const b = boundsOf(cells);
  if (!b) throw new Error("Nothing on the map to save yet.");
  // A few blocks of margin round what is on the map.
  const m = 0.004;
  const sw = [b[0][0] - m, b[0][1] - m];
  const ne = [b[1][0] + m, b[1][1] + m];
  const name = `carrier-${sw.map((v) => v.toFixed(3)).join(",")}`;
  const old = await OfflineManager.getPack(name);
  if (old) await OfflineManager.deletePack(name);
  await new Promise<void>((resolve, reject) => {
    OfflineManager.createPack(
      { name, styleURL: STYLE_URL, bounds: [ne, sw], minZoom: 13, maxZoom: 17 },
      (_pack, status) => {
        onProgress(status.percentage);
        if (status.percentage >= 100) {
          OfflineManager.unsubscribe(name);
          resolve();
        }
      },
      (_pack, err) => {
        OfflineManager.unsubscribe(name);
        reject(new Error(err.message));
      },
    ).catch(reject);
  });
}
