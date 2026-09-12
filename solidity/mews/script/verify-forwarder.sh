#!/usr/bin/env bash
# Verifies a deployed forwarder on Basescan, Sourcify, and Blockscout. Needs ETHERSCAN_API_KEY
# in solidity/mews/.env. Usage: script/verify-forwarder.sh <forwarder address>
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env
set +a

forwarder=$1
verify() {
  forge verify-contract "$forwarder" src/MewsForwarder.sol:MewsForwarder --chain 8453 \
    --rpc-url https://mainnet.base.org --guess-constructor-args --watch "$@"
}
verify --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY"
verify --verifier sourcify
verify --verifier blockscout --verifier-url https://base.blockscout.com/api/
