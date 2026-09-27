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
# Clear previous artifacts first. The build below can exit non-zero (or hang
# in strip) after a successful compile, so its status is not trusted; the
# artifact is. Removing old ones means a failed build cannot fall back to
# deploying yesterday's .so.
BUILD_START="$(mktemp)"
trap 'rm -f "$BUILD_START"' EXIT
find target -path "*sbpf*/release/carrier.so" -not -path "*/deps/*" -delete 2>/dev/null || true
rm -f target/deploy/carrier.so
BUILD_STATUS=0
cargo-build-sbf --manifest-path programs/carrier/Cargo.toml --arch "$ARCH" || BUILD_STATUS=$?

# cargo-build-sbf writes to a target dir named for the arch, and only copies to
# target/deploy after the strip step it sometimes hangs in. Find it ourselves,
# and only accept one written by this build.
BUILT="$(find target -path "*sbpf*/release/carrier.so" -not -path "*/deps/*" -newer "$BUILD_START" | head -1)"
if [[ -z "$BUILT" ]]; then
  echo "no fresh carrier.so was produced (cargo-build-sbf exit $BUILD_STATUS) — the build genuinely failed" >&2
  exit 1
fi
if [[ "$BUILD_STATUS" -ne 0 ]]; then
  echo "  note: cargo-build-sbf exited $BUILD_STATUS but produced a fresh artifact; using it" >&2
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
URL="http://127.0.0.1:8899"
VALIDATOR_PID=""
cleanup() {
  rm -f "$BUILD_START"
  # Stop only a validator this script started; leave one the user had running.
  if [[ -n "$VALIDATOR_PID" ]] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! solana cluster-version -u "$URL" >/dev/null 2>&1; then
  # Refuse to wipe anything that is not plainly a ledger directory we own.
  case "$LEDGER" in
    ""|"/"|"$HOME"|"$HOME/"|"."|"..")
      echo "refusing to reset ledger at '$LEDGER'" >&2
      exit 1
      ;;
  esac
  if [[ -e "$LEDGER" && ! -f "$LEDGER/genesis.bin" && -n "$(ls -A "$LEDGER" 2>/dev/null)" ]]; then
    echo "refusing to delete '$LEDGER': it is not empty and does not look like a validator ledger" >&2
    exit 1
  fi
  rm -rf -- "$LEDGER"
  solana-test-validator --ledger "$LEDGER" --reset --quiet &
  VALIDATOR_PID=$!
  # Bounded wait, and give up at once if the validator process died.
  for _ in $(seq 1 60); do
    if solana cluster-version -u "$URL" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
      echo "solana-test-validator exited before it was ready; see $LEDGER/validator.log" >&2
      exit 1
    fi
    sleep 2
  done
  if ! solana cluster-version -u "$URL" >/dev/null 2>&1; then
    echo "validator did not become ready within 120s" >&2
    exit 1
  fi
fi
echo "  $(solana cluster-version -u "$URL")"

# URL and keypair are passed per command: `solana config set` would rewrite
# the user's global CLI config as a side effect of running this script.
solana airdrop 100 -u "$URL" -k "$KEYPAIR" >/dev/null 2>&1 || true

say "Deploying"
solana program deploy target/deploy/carrier.so \
  --program-id "$PROGRAM_KEYPAIR" \
  --keypair "$KEYPAIR" \
  -u "$URL"

say "Running settlement tests"
ANCHOR_PROVIDER_URL="$URL" \
ANCHOR_WALLET="$KEYPAIR" \
  npx vitest run --root tests
