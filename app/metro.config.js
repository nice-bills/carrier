// The workspace packages are TypeScript that imports siblings as "./x.js"
// (NodeNext style). Metro does not map .js to .ts on its own, so a relative
// ".js" import that does not exist on disk is retried without the extension.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (/^\.{1,2}\/.*\.js$/.test(moduleName)) {
    try {
      return context.resolveRequest(context, moduleName, platform);
    } catch {
      return context.resolveRequest(context, moduleName.slice(0, -3), platform);
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
