# Cloudflare Astro and landing rhythm design

## Goal

Correct the landing page's upper-page rhythm and device-callout typography while moving Astro onto its official Cloudflare adapter and Vite-plugin build pipeline.

## Landing composition

- Move the provider band directly below the hero. It acts as immediate evidence that the identity promise applies across providers and protocol flows.
- Keep the identity model, privacy scopes, quickstart, and device callout in their current argumentative order after the band.
- Keep the band visually unchanged; this is a composition change, not a new component.

## Device callout

- Keep the example user code `F7KQ-2M9X` on one line at every supported viewport.
- Keep `ANOTHER DEVICE.` on one line at desktop and tablet widths so the heading reads as two intentional lines: `AUTHORIZE` and `ANOTHER DEVICE.`
- Reduce the responsive display size enough to fit the phrase instead of allowing an accidental third line.
- At narrow mobile widths, allow an intentional fallback only if the complete phrase cannot fit without overflow.
- Preserve the two-column desktop composition and one-column mobile composition.

## Cloudflare Astro architecture

Use `@astrojs/cloudflare`, which integrates `@cloudflare/vite-plugin` into Astro's Vite environments. Do not add a second raw `cloudflare()` plugin alongside the adapter.

- Configure the Cloudflare adapter in `astro.config.mjs`.
- Keep all current Astro pages prerendered so their HTML, CSS, JavaScript, and fonts are deployed as hashed Workers Assets and served through Cloudflare's asset network.
- Keep `src/index.ts` as the custom Hono Worker entrypoint for OAuth, OIDC, device, session, and account routes.
- Let Hono retain API precedence, delegate Astro's private prerender control requests to `@astrojs/cloudflare/handler`, and keep ordinary prerendered pages on the direct Workers Assets fallback.
- Preserve the D1 binding, `ASSETS` binding, issuer, provider secrets, security headers, and canonical Workers URL.
- Keep trailing-slash URLs and directory-format output.

## Commands

- Use ordinary package scripts built from explicit Vite+ executables.
- Build with `vp exec astro build`, followed by the existing CSP hash generator.
- Deploy only after the build with `vp exec wrangler deploy`.
- Develop and preview through Astro so the Cloudflare adapter runs requests in `workerd`.
- Keep `vp run check`, `vp test`, and `vp run build` as required verification commands.

## Session duration

The broker browser session remains 30 days. The database expiry and secure cookie `Max-Age` use the same `60 * 60 * 24 * 30` duration. This work does not change it to seven days.

## Testing

- Add a source test proving the provider band appears between the hero and identity model.
- Add CSS assertions for non-wrapping device code and desktop `ANOTHER DEVICE.` composition, including mobile overflow protection.
- Update configuration tests to require `@astrojs/cloudflare`, the adapter, prerendered pages, and the new build/deploy commands.
- Build with the adapter and inspect its generated Worker/assets output before deployment.
- Run the full 257-test baseline plus new tests, Vite+ checks, and a no-cache Astro build.

## Deployment

- Commit and push the landing composition independently.
- Commit and push the Cloudflare build migration independently.
- Deploy only after both commits pass full verification.
- Smoke-test the landing page, static asset delivery, discovery, JWKS, enabled providers, and account signed-out state.
