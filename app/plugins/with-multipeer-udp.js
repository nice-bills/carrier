const { withInfoPlist } = require("expo/config-plugins");

/**
 * Multipeer Connectivity browses for both the TCP and the UDP Bonjour
 * service, and iOS 14+ only lets an app browse for the ones listed in
 * NSBonjourServices. expo-nearby-connections adds `_carrier._tcp`; this adds
 * `_carrier._udp` next to it. Without it discovery can fail silently. It is
 * listed before the library in app.json because Info.plist mods run in
 * reverse order, so this one runs after the library has written its entry.
 */
module.exports = function withMultipeerUdp(config) {
  return withInfoPlist(config, (c) => {
    const services = new Set(c.modResults.NSBonjourServices ?? []);
    for (const s of [...services]) if (s.endsWith("._tcp")) services.add(s.replace(/\._tcp$/, "._udp"));
    c.modResults.NSBonjourServices = [...services];
    return c;
  });
};
