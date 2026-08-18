import { describe, expect, it, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }
    : {
        models: {
          "gemini-3.6-flash-high": {
            displayName: "Gemini 3.6 Flash (High)",
            quotaInfo: { remainingFraction: 0.8, resetTime: "2026-07-25T12:00:00Z" },
          },
          "gemini-3.6-flash-medium": {
            displayName: "Gemini 3.6 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.5, resetTime: "2026-07-25T12:00:00Z" },
          },
          "gemini-3.6-flash-low": {
            displayName: "Gemini 3.6 Flash (Low)",
            quotaInfo: { remainingFraction: 0.2, resetTime: "2026-07-25T12:00:00Z" },
          },
          "gemini-3.5-flash-low": {
            displayName: "Gemini 3.5 Flash (Medium)",
            quotaInfo: { remainingFraction: 0.9, resetTime: "2026-07-25T12:00:00Z" },
          },
          "internal-model": {
            displayName: "Internal",
            isInternal: true,
            quotaInfo: { remainingFraction: 0.5 },
          },
          "gemini-3.1-flash-lite": {
            displayName: "Gemini 3.1 Flash Lite",
            maxTokens: 1048576,
            maxOutputTokens: 65535,
            quotaInfo: { resetTime: "2026-07-25T12:00:00Z" },
          },
          "explicitly-depleted-model": {
            displayName: "Explicitly depleted",
            quotaInfo: { remainingFraction: 0, resetTime: "2026-07-25T12:00:00Z" },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity quota tracker: Gemini 3.6 Flash usage bars", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("returns Gemini 3.6 Flash tier quotas so the dashboard can render usage bars", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas["gemini-3.6-flash-high"]).toMatchObject({
      used: 200,
      total: 1000,
      remainingPercentage: 80,
      displayName: "Gemini 3.6 Flash (High)",
    });
    expect(usage.quotas["gemini-3.6-flash-medium"]).toMatchObject({
      used: 500,
      total: 1000,
      remainingPercentage: 50,
    });
    expect(usage.quotas["gemini-3.6-flash-low"]).toMatchObject({
      used: 800,
      total: 1000,
      remainingPercentage: 20,
    });
  });

  it("includes newly discovered public models and filters only internal models", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    expect(usage.quotas).not.toHaveProperty("internal-model");
    expect(usage.quotas["gemini-3.1-flash-lite"]).toMatchObject({
      remainingPercentage: null,
      used: null,
      total: null,
      quotaStatus: "unknown",
      contextLength: 1048576,
      maxOutputTokens: 65535,
    });
    expect(usage.models).toContainEqual(expect.objectContaining({
      id: "gemini-3.1-flash-lite",
      name: "Gemini 3.1 Flash Lite",
      discovered: true,
    }));
    expect(usage.models.some((model) => model.id === "internal-model")).toBe(false);
    expect(usage.quotas["explicitly-depleted-model"]).toMatchObject({
      remainingPercentage: 0,
      used: 1000,
      total: 1000,
      quotaStatus: "reported",
    });
  });
});
