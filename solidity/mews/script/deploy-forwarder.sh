#!/usr/bin/env bash
# Deploys the forwarder, launches MEWS, then verifies the forwarder on Basescan, Sourcify, and
# Blockscout. Needs PRIVATE_KEY and ETHERSCAN_API_KEY in solidity/mews/.env; forge reads both.
# The token is verified by OpenLaunch on its own. Pass a different metadata URI as the first
# argument to override the registered one. A rerun after the launch fails in simulation with
# SaltUsed and sends nothing; rerun verification alone with `vp run verify:forwarder`.
set -euo pipefail
cd "$(dirname "$0")/.."

uri=${1:-https://openlaunch.lol/api/launch/meta/0x6c22d03544609db5128736706d90d66fc7f45388/0x88e1dc3a35da1600096d3406a2817ae79c2b65a50ee1f5866a7777e34687e130}

forge script script/DeployForwarder.s.sol:DeployForwarder --rpc-url https://mainnet.base.org \
  --sig "run(string,string,string)" "Mews On Base" "MEWS" "$uri" --broadcast
vp run verify:forwarder
