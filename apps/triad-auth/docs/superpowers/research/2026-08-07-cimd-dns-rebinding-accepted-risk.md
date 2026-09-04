# CIMD DNS-Rebinding Accepted Risk

`src/better-auth/admission/cimd.ts`'s `allowFetch` resolves a client_id
metadata URL's hostname over DNS-over-HTTPS and rejects it unless every
resolved address is public. `@better-auth/cimd`'s
`fetchAndValidateMetadataDocument` then performs its own, independent fetch
of the same URL, which re-resolves DNS on its own. A host that controls DNS
for its own client_id domain could answer the `allowFetch` check with a
public address and flip to a private address before the real fetch resolves
it — a time-of-check-to-time-of-use gap.

Pinning the validated address onto the real fetch (Cloudflare's `cf:
{ resolveOverride }`) does not apply here: `resolveOverride`
(`@cloudflare/workers-types` `RequestInitCfProperties`) only takes effect
for hostnames proxied on the requester's own Cloudflare zone; for an
arbitrary third-party client_id host it is silently ignored. Workers'
`fetch()` has no other primitive to force a connection to a specific
validated IP while preserving correct TLS SNI/certificate validation for an
arbitrary external HTTPS origin, so the two DNS resolutions cannot be
collapsed into one on this platform.

The residual window is a single `await` tick between `allowFetch`'s DNS
check and CIMD's internal fetch inside the same async function call — there
is no attacker-controlled delay in between. Exploiting it requires an
attacker-controlled DNS record with an extremely short or zero TTL and
precise timing against their own client_id host. Triad accepts this as a
platform limitation rather than adding a partial mitigation.
