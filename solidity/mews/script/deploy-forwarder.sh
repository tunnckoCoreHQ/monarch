#!/usr/bin/env bash
# Deploys the forwarder, launches MEWS, then verifies the forwarder with verify-forwarder.sh.
# Needs PRIVATE_KEY and ETHERSCAN_API_KEY in solidity/mews/.env. The token is verified by
# OpenLaunch on its own. Pass a different metadata URI as the first argument to override the
# registered one. A rerun after the launch fails in simulation with SaltUsed and sends nothing;
# rerun only the verification with `vp run --filter mews verify:forwarder <address>`.
set -euo pipefail
cd "$(dirname "$0")/.."

uri=${1:-https://openlaunch.lol/api/launch/meta/0x6c22d03544609db5128736706d90d66fc7f45388/0x88e1dc3a35da1600096d3406a2817ae79c2b65a50ee1f5866a7777e34687e130}

forge script script/DeployForwarder.s.sol:DeployForwarder --rpc-url https://mainnet.base.org \
  --sig "run(string,string,string)" "Mews On Base" "MEWS" "$uri" --broadcast

forwarder=$(jq -r '.transactions[] | select(.contractName == "MewsForwarder") | .contractAddress' \
  broadcast/DeployForwarder.s.sol/8453/run-latest.json)
echo "forwarder $forwarder"
script/verify-forwarder.sh "$forwarder"
