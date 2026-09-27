// `src/polyfills.ts` installs the `buffer` package's Buffer as a global before
// anything else loads; @carrier/protocol and @carrier/client rely on it.
// Declared here (as a value and as a type) rather than pulling in @types/node,
// which would claim the rest of Node exists too.
declare const Buffer: typeof import("buffer").Buffer;
type Buffer = import("buffer").Buffer;
