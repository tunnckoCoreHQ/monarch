#!/usr/bin/env bash
# Deploys the forwarder, launches MEWS, and verifies the forwarder on Basescan, Sourcify, and
# Blockscout. Needs PRIVATE_KEY and ETHERSCAN_API_KEY in solidity/mews/.env. The token is
# verified by OpenLaunch on its own. Pass a different metadata URI as the first argument to
# override the registered one.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a
source .env
set +a

rpc=https://mainnet.base.org
uri=${1:-https://openlaunch.lol/api/launch/meta/0x6c22d03544609db5128736706d90d66fc7f45388/0x88e1dc3a35da1600096d3406a2817ae79c2b65a50ee1f5866a7777e34687e130}

forge script script/DeployForwarder.s.sol:DeployForwarder --rpc-url "$rpc" \
  --sig "run(string,string,string)" "Mews On Base" "MEWS" "$uri" --broadcast

forwarder=$(jq -r '.transactions[] | select(.contractName == "MewsForwarder") | .contractAddress' \
  broadcast/DeployForwarder.s.sol/8453/run-latest.json)
echo "forwarder $forwarder"

verify() {
  forge verify-contract "$forwarder" src/MewsForwarder.sol:MewsForwarder --chain 8453 \
    --rpc-url "$rpc" --guess-constructor-args --watch "$@"
}
verify --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY"
verify --verifier sourcify
verify --verifier blockscout --verifier-url https://base.blockscout.com/api/
