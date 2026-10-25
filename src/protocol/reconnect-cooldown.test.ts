import { describe, expect, it } from "vitest";
import { ReconnectCooldown } from "./reconnect-cooldown.js";

describe("ReconnectCooldown", () => {
  it("allows an attempt before any failure was recorded", () => {
    const cooldown = new ReconnectCooldown();
    expect(cooldown.canAttempt()).toBe(true);
  });

  it("blocks further attempts until the cooldown elapses", () => {
    let now = 0;
    const cooldown = new ReconnectCooldown({ cooldownMs: 3000, now: () => now });

    cooldown.recordFailure();
    expect(cooldown.canAttempt()).toBe(false);

    now = 2999;
    expect(cooldown.canAttempt()).toBe(false);

    now = 3000;
    expect(cooldown.canAttempt()).toBe(true);
  });

  it("reset() clears the cooldown immediately", () => {
    const now = 0;
    const cooldown = new ReconnectCooldown({ cooldownMs: 3000, now: () => now });

    cooldown.recordFailure();
    cooldown.reset();
    expect(cooldown.canAttempt()).toBe(true);
  });
});
