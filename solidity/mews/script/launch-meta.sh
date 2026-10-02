#!/usr/bin/env bash
# Registers the MEWS launch metadata with OpenLaunch and prints the returned metadata URI.
# The launcher and salt match DeployForwarder, so the returned token address is the one the
# script will predict. Pass the printed uri as the last argument of `deploy:forwarder`.
set -euo pipefail

curl -sS https://openlaunch.lol/api/launch/meta \
  -H 'content-type: application/json' \
  -d '{
    "chain": "base",
    "launcher": "0x6C22d03544609Db5128736706d90D66fC7f45388",
    "salt": "0x88e1dc3a35da1600096d3406a2817ae79c2b65a50ee1f5866a7777e34687e130",
    "name": "Mews On Base",
    "symbol": "MEWS",
    "description": "Pixel-perfect pastel cats are in control now. The trading fee is sent to forwarder contract that burns the MEWS token side and sends the ETH side to Splits Protocol Mews Treasury, where it gets swapped automatically to Robinhood Stocks and USDC on Base.",
    "image_url": "https://raw2.seadn.io/base/0x41c11fc8169a3051bcab720c7f5e16bae1bd3db8/9ad0f5394be57781c7c8ecd55955d3/ad9ad0f5394be57781c7c8ecd55955d3.svg",
    "website": "https://mews.wgw.lol",
    "x_handle": "wgw_eth"
  }'
echo
