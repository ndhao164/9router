import { describe, expect, it } from "vitest";
import {
  filterQuotasByVisibility,
  getRemainingPercentage,
  getHiddenQuotaRows,
  parseQuotaData,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
      },
    },
  };

  it("keeps Antigravity modelKey so hidden settings use stable quota ids", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas.map((q) => q.modelKey)).toEqual([
      "gemini-pro-agent",
      "claude-opus-4-6-thinking",
    ]);
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(filterQuotasByVisibility("antigravity", quotas, {})).toHaveLength(2);

    const visibility = {
      antigravity: { hidden: ["claude-opus-4-6-thinking"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini-pro-agent"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude-opus-4-6-thinking"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini-pro-agent"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(2);
  });

  it("preserves an unknown Cloud Code quota instead of displaying it as zero", () => {
    const [quota] = parseQuotaData("antigravity", {
      quotas: {
        "gemini-3.1-flash-lite": {
          displayName: "Gemini 3.1 Flash Lite",
          used: null,
          total: null,
          remainingPercentage: null,
          quotaStatus: "unknown",
          quotaNote: "Daily inference quota is not reported",
          resetAt: "2026-08-18T11:03:59Z",
        },
      },
    });

    expect(quota).toMatchObject({
      used: null,
      total: null,
      remainingPercentage: null,
      quotaStatus: "unknown",
    });
    expect(getRemainingPercentage(quota)).toBeNull();
  });
});
