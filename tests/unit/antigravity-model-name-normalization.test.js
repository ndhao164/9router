import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } }
    : {
        models: {
          "gemini-2.5-flash": {
            displayName: "Gemini 3.1 Flash Lite",
            quotaInfo: { remainingFraction: 0.75 },
          },
          "gemini-2.5-flash-lite": {
            displayName: "Gemini 3.1 Flash Lite",
            quotaInfo: { remainingFraction: 0.75 },
          },
          "gemini-2.5-flash-thinking": {
            displayName: "Gemini 3.1 Flash Lite",
            quotaInfo: { remainingFraction: 0.75 },
          },
          "gemini-3.1-flash-lite": {
            displayName: "Gemini 3.1 Flash Lite",
            quotaInfo: { remainingFraction: 0.75 },
          },
          "future-model": {
            displayName: "  Future Model  ",
            quotaInfo: { remainingFraction: 0.75 },
          },
        },
      },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity model-name normalization", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("corrects misleading Cloud Code labels for known Flash model IDs", async () => {
    const { resolveAntigravityModelName } = await import("../../open-sse/services/usage/google.js");

    const misleadingName = "Gemini 3.1 Flash Lite";
    expect(resolveAntigravityModelName("gemini-2.5-flash", misleadingName)).toBe("Gemini 2.5 Flash");
    expect(resolveAntigravityModelName("gemini-2.5-flash-lite", misleadingName)).toBe("Gemini 2.5 Flash Lite");
    expect(resolveAntigravityModelName("gemini-2.5-flash-thinking", misleadingName)).toBe("Gemini 2.5 Flash (Thinking)");
    expect(resolveAntigravityModelName("gemini-3.1-flash-lite", misleadingName)).toBe("Gemini 3.1 Flash Lite");
  });

  it("uses canonical names for known aliases", async () => {
    const { resolveAntigravityModelName } = await import("../../open-sse/services/usage/google.js");

    expect(resolveAntigravityModelName("gemini-pro-agent", "Wrong")).toBe("Gemini 3.1 Pro (High)");
    expect(resolveAntigravityModelName("gemini-3.1-pro-high", "Wrong")).toBe("Gemini 3.1 Pro (High)");
    expect(resolveAntigravityModelName("gemini-3-flash-agent", "Wrong")).toBe("Gemini 3.5 Flash (High)");
    expect(resolveAntigravityModelName("gemini-3.5-flash-high", "Wrong")).toBe("Gemini 3.5 Flash (High)");
  });

  it("trims unknown upstream names and falls back to the model ID", async () => {
    const { resolveAntigravityModelName } = await import("../../open-sse/services/usage/google.js");

    expect(resolveAntigravityModelName("future-model", "  Future Model  ")).toBe("Future Model");
    expect(resolveAntigravityModelName("future-model", "   ")).toBe("future-model");
    expect(resolveAntigravityModelName("future-model", null)).toBe("future-model");
  });

  it("uses the same resolved name for discovered models and quota entries", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("access-token", {});

    for (const model of usage.models) {
      expect(usage.quotas[model.id].displayName).toBe(model.name);
    }
    expect(usage.models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
      { id: "gemini-2.5-flash-thinking", name: "Gemini 2.5 Flash (Thinking)" },
      { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
      { id: "future-model", name: "Future Model" },
    ]);
  });
});
