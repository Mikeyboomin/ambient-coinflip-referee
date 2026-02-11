#!/usr/bin/env bash
set -euo pipefail

# Configuration
export ANCHOR_PROVIDER_URL="https://rpc.ambient.xyz"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"

echo "--- STARTING COINFLIP DEMO ---"
node scripts/demo.js

echo ""
echo "--- STARTING ORACLE REFEREE ---"
node scripts/referee.js

echo ""
echo "--- VERIFICATION ARTIFACTS ---"
ls -la artifacts/round.json artifacts/referee.json
echo ""
echo "Demo complete."
