# Design system

## Direction

A black-box identity switchboard: true near-black, hard rectangular structure, oversized compressed headings, and a coral-orange signal color. The landing page is brand-led; consent, device authorization, and account management are product-led versions of the same system.

## Color

All authored colors use OKLCH.

- Background: `oklch(0.08 0 0)`
- Surface: `oklch(0.13 0.006 110)`
- Raised surface: `oklch(0.17 0.008 110)`
- Ink: `oklch(0.97 0 0)`
- Muted ink: `oklch(0.72 0.01 110)`
- Primary signal: `oklch(0.72 0.19 38)`
- Signal ink: `oklch(0.11 0.02 38)`
- Secondary signal: `oklch(0.66 0.16 250)`
- Danger: `oklch(0.66 0.2 25)`
- Rules: `oklch(0.28 0.008 110)`

## Typography

Archivo Variable carries display and interface headings with heavy, slightly compressed weight. JetBrains Mono is reserved for protocol data, identifiers, controls, and supporting copy where technical cadence is meaningful. Display tracking never exceeds `-0.04em`; prose is capped near 70 characters.

## Shape and structure

- Corners are square by default. Small controls may use 2–4px radii for focus clarity.
- Panels use a single solid rule, never soft wide shadows.
- The background uses sparse one-axis rules derived from content alignment; no decorative two-axis grid overlay.
- Landing sections vary in scale and density. Product screens use a centered column and clear transactional hierarchy.

## Motion

The landing hero uses one load sequence: rule, headline, then protocol strip. Product screens use only state transitions and focus feedback. Reduced motion disables transforms and removes sequencing.

## Components

- Buttons: heavy label, rectangular fill or rule-only treatment, 48px minimum height.
- Provider actions: square ruled controls populated from enabled provider capabilities; provider branding never changes the control system.
- Identity rows: label, human-readable value, copyable protocol value.
- Consent disclosure: explicit recipient, selected provider, fixed identity claims, checked disabled switches for mandatory requested profile claims, retention statement, and approve/cancel actions.
- Status: text plus shape/icon treatment; never color alone.
- Error states: plain language, stable layout, recovery action beside the error.
