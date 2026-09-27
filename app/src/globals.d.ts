// `src/polyfills.ts` installs the `buffer` package's Buffer as a global before
// anything else loads; @carrier/protocol relies on it. Declared here rather
// than pulling in @types/node, which would claim the rest of Node exists too.
declare const Buffer: typeof import("buffer").Buffer;
