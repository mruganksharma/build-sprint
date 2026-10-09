import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

// AGENTS.md: at most 100 Claude calls an hour across the whole app.
// Every Claude call checks this first:  const { ok } = await rateLimiter.limit(ctx, "claudeCalls");
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  claudeCalls: { kind: "fixed window", rate: 100, period: HOUR },
});
