import { describe, expect, it } from "vite-plus/test";

import { devicePollDecision } from "../../src/scripts/demo-protocol";

describe("demo device polling", () => {
  it("continues pending requests at the current interval", () => {
    expect(devicePollDecision("authorization_pending", 5_000)).toEqual({
      continuePolling: true,
      intervalMs: 5_000,
      message: "Waiting for browser approval.",
    });
  });

  it("adds five seconds when the server asks the device to slow down", () => {
    expect(devicePollDecision("slow_down", 5_000)).toEqual({
      continuePolling: true,
      intervalMs: 10_000,
      message: "The broker asked this device to poll less often.",
    });
  });

  it.each([
    ["access_denied", "Authorization was denied in the browser."],
    ["expired_token", "This device code expired. Start a new device flow."],
    ["invalid_grant", "The device flow could not be completed. Start again."],
  ])("stops polling after %s", (error, message) => {
    expect(devicePollDecision(error, 5_000)).toEqual({
      continuePolling: false,
      intervalMs: 5_000,
      message,
    });
  });
});
