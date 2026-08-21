import { describe, expect, it } from "vitest";

import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("Codex Business monthly credit presentation", () => {
  it.each(["codex", "openai"])(
    "adds a value-only Credits row for %s quota data",
    (provider) => {
      const rows = parseQuotaData(provider, {
        quotas: {
          session: { used: 20, total: 100, remaining: 80, resetAt: null },
        },
        monthlyCredits: {
          used: 8000,
          total: 25000,
          remaining: 17000,
          remainingPercentage: 68,
          resetAt: "2026-09-20T00:00:00.000Z",
        },
      });

      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual({
        name: "Credits",
        used: 8000,
        total: 25000,
        resetAt: "2026-09-20T00:00:00.000Z",
        remainingPercentage: 68,
        showProgress: false,
        neutral: true,
        creditAmount: 17000,
        unlimited: false,
      });
    },
  );

  it("hides an exhausted zero balance and keeps unlimited credit access", () => {
    expect(parseQuotaData("openai", {
      monthlyCredits: { remaining: 0, unlimited: false },
    })).toEqual([]);

    expect(parseQuotaData("openai", {
      monthlyCredits: { unlimited: true },
    })).toEqual([expect.objectContaining({
      name: "Credits",
      creditAmount: "∞",
      remainingPercentage: 100,
      showProgress: false,
    })]);
  });
});
