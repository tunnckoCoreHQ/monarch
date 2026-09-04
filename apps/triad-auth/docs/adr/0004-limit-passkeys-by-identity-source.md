# Limit passkeys by identity source

Status: Superseded by ADR 0006.

Accounts with a Social Provider as their Identity Source may attach multiple PRF-capable Passkeys that can authenticate the same Triad Account and supply wallet seeds without changing its Identity Source. An account with an Identity Passkey may attach PRF-capable or non-PRF Passkeys, but attached Passkeys can only authenticate that account; only its Identity Passkey supplies wallet seeds. An account with EVM as its Identity Source already represents an externally controlled wallet, so it cannot attach Passkeys or derive a PRF wallet.
