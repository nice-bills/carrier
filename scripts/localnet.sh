#!/usr/bin/env bash
# Build, deploy and verify Carrier against a local validator.
#
# Exists because `anchor build` is not trustworthy on this toolchain: it exits 0
# when cargo-build-sbf fails to find rustup, and its strip step can hang after a
# successful compile. Both leave you with no .so and a green exit code. This
# script checks for the artifact itself rather than believing the exit status.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

# SBPF v0 rather than Anchor's v3 default: a v3 ELF is valid but the validator
# refuses to load it with "invalid file header".
ARCH="${CARRIER_SBF_ARCH:-v0}"
LEDGER="${CARRIER_LEDGER:-/tmp/carrier-ledger}"
KEYPAIR="$HOME/.config/solana/id.json"
PROGRAM_KEYPAIR="target/deploy/carrier-keypair.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "Building program (sbpf $ARCH)"
cargo-build-sbf --manifest-path programs/carrier/Cargo.toml --arch "$ARCH" || true

# cargo-build-sbf writes to a target dir named for the arch, and only copies to
# target/deploy after the strip step it sometimes hangs in. Find it ourselves.
BUILT="$(find target -path "*sbpf*/release/carrier.so" -not -path "*/deps/*" | head -1)"
if [[ -z "$BUILT" ]]; then
  echo "no carrier.so was produced — the build genuinely failed" >&2
  exit 1
fi
mkdir -p target/deploy
cp "$BUILT" target/deploy/carrier.so
echo "  $BUILT -> target/deploy/carrier.so ($(wc -c < target/deploy/carrier.so) bytes)"

say "Generating IDL"
# anchor idl build writes JSON to stdout but fails when stdout is not a TTY,
# so it runs under a pseudo-terminal and the JSON is cut out of the transcript.
mkdir -p target/idl
script -qec "anchor idl build" /dev/null 2>&1 \
  | tr -d '\r' \
  | sed -n '/^{/,$p' > target/idl/carrier.json
python3 -c "import json,sys; json.load(open('target/idl/carrier.json'))" \
  || { echo "IDL did not parse" >&2; exit 1; }
echo "  target/idl/carrier.json ok"

say "Starting validator"
if ! solana cluster-version -u localhost >/dev/null 2>&1; then
  rm -rf "$LEDGER"
  solana-test-validator --ledger "$LEDGER" --reset --quiet &
  until solana cluster-version -u localhost >/dev/null 2>&1; do sleep 2; done
fi
echo "  $(solana cluster-version -u localhost)"

solana config set -u localhost -k "$KEYPAIR" >/dev/null
solana airdrop 100 >/dev/null 2>&1 || true

say "Deploying"
solana program deploy target/deploy/carrier.so --program-id "$PROGRAM_KEYPAIR"

say "Running settlement tests"
ANCHOR_PROVIDER_URL="http://127.0.0.1:8899" \
ANCHOR_WALLET="$KEYPAIR" \
  npx vitest run --root tests
