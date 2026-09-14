#!/usr/bin/env bash
# Deploy Carrier to devnet and prove it works there.
#
# Localnet runs the same runtime, so a green suite there is real evidence — but
# it is your machine, your validator, and a program id nobody else can call.
# Devnet gives an address a judge can open in an explorer, and exercises the
# thing against a network with other people's traffic on it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

KEYPAIR="${CARRIER_KEYPAIR:-$HOME/.config/solana/id.json}"
RPC="${CARRIER_RPC:-https://api.devnet.solana.com}"
PROGRAM_KEYPAIR="target/deploy/carrier-keypair.json"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

ADDRESS="$(solana address -k "$KEYPAIR")"
BALANCE="$(solana balance -k "$KEYPAIR" -u "$RPC" | awk '{print $1}')"
PROGRAM_BYTES="$(stat -c%s target/deploy/carrier.so 2>/dev/null || echo 0)"
# An upgradeable deploy reserves twice the program size, at roughly 6960
# lamports per byte for rent exemption.
NEEDED="$(python3 -c "print(f'{($PROGRAM_BYTES*2)*6960/1e9:.2f}')")"

say "Wallet"
echo "  $ADDRESS"
echo "  balance $BALANCE SOL, deploy needs about $NEEDED SOL"

if python3 -c "import sys; sys.exit(0 if float('$BALANCE') < float('$NEEDED') else 1)"; then
  cat >&2 <<EOF

Not enough SOL on devnet.

The CLI faucet is rate-limited per IP and refuses most requests. Use the web
faucet instead, which has a separate limit and a much higher one once you sign
in with GitHub:

  https://faucet.solana.com

  address: $ADDRESS
  amount:  $NEEDED SOL (or as close as it will give, and run this again)

EOF
  exit 1
fi

if [[ ! -f target/deploy/carrier.so ]]; then
  echo "no target/deploy/carrier.so — run scripts/localnet.sh first" >&2
  exit 1
fi

say "Deploying to devnet"
solana program deploy target/deploy/carrier.so \
  --program-id "$PROGRAM_KEYPAIR" \
  --keypair "$KEYPAIR" \
  -u "$RPC"

PROGRAM_ID="$(solana address -k "$PROGRAM_KEYPAIR")"
say "Deployed"
echo "  program  $PROGRAM_ID"
echo "  explorer https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"

say "Running the settlement suite against devnet"
# Slower than localnet: real slot times, real confirmation. The suite funds its
# own cast by transfer rather than airdrop, because devnet's faucet would refuse.
ANCHOR_PROVIDER_URL="$RPC" \
ANCHOR_WALLET="$KEYPAIR" \
  npx vitest run --root tests --testTimeout=180000
