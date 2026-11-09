import { performance } from "node:perf_hooks";

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}

export function createRateLimiter({
  limit = 30,
  windowMs = 1000,
  now = () => performance.now(),
}: RateLimitOptions = {}) {
  let windowStartedAt = now();
  let messagesInWindow = 0;
  let lastNotificationAt = -Infinity;

  return function checkMessage() {
    const currentTime = now();

    if (currentTime - windowStartedAt >= windowMs) {
      windowStartedAt = currentTime;
      messagesInWindow = 0;
    }

    if (messagesInWindow < limit) {
      messagesInWindow += 1;
      return { allowed: true, notify: false };
    }

    const notify = currentTime - lastNotificationAt >= 1000;

    if (notify) {
      lastNotificationAt = currentTime;
    }

    return { allowed: false, notify };
  };
}
