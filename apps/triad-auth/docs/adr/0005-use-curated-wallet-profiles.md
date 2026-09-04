# Use curated wallet profiles

Clients select a supported Wallet Profile and may select an Account Index, which defaults to zero, instead of supplying a raw derivation path. Each profile fixes the derivation method, path template, address format, and signature format. The EVM profile accepts a Chain ID that defaults to Ethereum mainnet `1` and does not change the derived wallet. Bitcoin profiles require an explicit address type and network, with no generic Bitcoin default.
