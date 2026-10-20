import { createStart } from "@tanstack/react-start";

// The Worker renders only the HTML shell. Pages load their data from the same JSON API that the
// CLI and agents use, so a page view costs the Worker almost no CPU.
export const startInstance = createStart(() => ({ defaultSsr: false }));
