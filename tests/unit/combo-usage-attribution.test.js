import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let handleComboChat;
let handleFusionChat;
let resolveUsageAttribution;
let saveUsageStats;

const log = {
  info: vi.fn(),
  warn: vi.fn(),
};

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for usage persistence");
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-combo-usage-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ handleComboChat, handleFusionChat } = await import("../../open-sse/services/combo.js"));
  ({ resolveUsageAttribution } = await import("../../open-sse/handlers/chatCore.js"));
  ({ saveUsageStats } = await import("../../open-sse/handlers/chatCore/requestDetail.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("combo usage attribution", () => {
  it("keeps the client model for direct requests and adds comboName only for combos", () => {
    expect(resolveUsageAttribution({
      clientRawRequest: { body: { model: "ag/gemini-3.1-flash-lite" } },
      body: { model: "antigravity/gemini-3.1-flash-lite" },
      provider: "antigravity",
      model: "gemini-3.1-flash-lite",
    })).toEqual({ requestedModel: "ag/gemini-3.1-flash-lite" });

    expect(resolveUsageAttribution({
      requestAttribution: { requestedModel: "dich", comboName: "dich" },
      body: { model: "antigravity/gemini-3.1-flash-lite" },
      provider: "antigravity",
      model: "gemini-3.1-flash-lite",
    })).toEqual({ requestedModel: "dich", comboName: "dich" });
  });

  it("carries attribution to every fallback leaf attempt", async () => {
    const attribution = { requestedModel: "dich", comboName: "dich" };
    const calls = [];

    const response = await handleComboChat({
      body: { model: "dich", messages: [] },
      models: ["ag/first", "gemini/second"],
      handleSingleModel: async (_body, model, isPanel, requestAttribution) => {
        calls.push({ model, isPanel, requestAttribution });
        if (model === "ag/first") {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("ok", { status: 200 });
      },
      log,
      comboName: "dich",
      comboStrategy: "fallback",
      requestAttribution: attribution,
    });

    expect(response.ok).toBe(true);
    expect(calls).toEqual([
      { model: "ag/first", isPanel: undefined, requestAttribution: attribution },
      { model: "gemini/second", isPanel: undefined, requestAttribution: attribution },
    ]);
  });

  it("carries attribution to fusion panel calls and the judge", async () => {
    const attribution = { requestedModel: "fusion-code", comboName: "fusion-code" };
    const calls = [];

    const response = await handleFusionChat({
      body: { model: "fusion-code", messages: [{ role: "user", content: "hello" }], stream: false },
      models: ["ag/panel-a", "gemini/panel-b"],
      handleSingleModel: async (_body, model, isPanel, requestAttribution) => {
        calls.push({ model, isPanel, requestAttribution });
        return new Response(JSON.stringify({
          choices: [{ message: { content: isPanel ? `answer from ${model}` : "judged" } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
      log,
      comboName: "fusion-code",
      judgeModel: "ag/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 10, panelHardTimeoutMs: 1000 },
      requestAttribution: attribution,
    });

    expect(response.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.isPanel)).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({ model: "ag/judge", isPanel: undefined });
    expect(calls.every((call) => call.requestAttribution === attribution)).toBe(true);
  });

  it("persists metadata, exposes byCombo/recent/history, and keeps historical rows null", async () => {
    const timestamp = new Date().toISOString();
    const common = {
      timestamp,
      provider: "antigravity",
      model: "gemini-3.1-flash-lite",
      connectionId: "account-1",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 101, completion_tokens: 23 },
      status: "ok",
    };

    await db.saveRequestUsage({ ...common, requestedModel: "dich", comboName: "dich" });
    // Same leaf/timestamp/tokens is still a distinct request when attribution differs.
    await db.saveRequestUsage({ ...common, requestedModel: "ag/gemini-3.1-flash-lite" });
    await db.saveRequestUsage({
      ...common,
      timestamp: new Date(new Date(timestamp).getTime() + 1).toISOString(),
      tokens: { prompt_tokens: 7, completion_tokens: 3 },
    });

    const history = await db.getUsageHistory({ provider: "antigravity" });
    expect(history).toHaveLength(3);
    expect(history.find((entry) => entry.comboName === "dich")).toMatchObject({
      model: "gemini-3.1-flash-lite",
      requestedModel: "dich",
      comboName: "dich",
    });
    expect(history.find((entry) => entry.requestedModel === "ag/gemini-3.1-flash-lite")?.comboName).toBeNull();
    expect(history.find((entry) => entry.tokens.prompt_tokens === 7)).toMatchObject({
      requestedModel: null,
      comboName: null,
    });

    const stats = await db.getUsageStats("today");
    expect(stats.byCombo.dich).toMatchObject({
      comboName: "dich",
      requestedModel: "dich",
      requests: 1,
      promptTokens: 101,
      completionTokens: 23,
    });
    expect(stats.byCombo.dich.byProvider.antigravity.requests).toBe(1);
    expect(stats.byCombo.dich.byModel["gemini-3.1-flash-lite|antigravity"]).toMatchObject({
      requests: 1,
      rawModel: "gemini-3.1-flash-lite",
      provider: "antigravity",
    });
    expect(stats.recentRequests.some((entry) => entry.comboName === "dich")).toBe(true);
    expect(stats.recentRequests.some((entry) => entry.requestedModel === "ag/gemini-3.1-flash-lite" && entry.comboName === null)).toBe(true);

    // Multi-day periods read usageDaily; old day blobs without byCombo remain
    // valid because the aggregator treats that field as optional.
    const weeklyStats = await db.getUsageStats("7d");
    expect(weeklyStats.byCombo.dich).toMatchObject({
      requests: 1,
      promptTokens: 101,
      completionTokens: 23,
    });
  });

  it("keeps pending requests separate when two combos resolve to the same leaf", async () => {
    const comboA = { requestedModel: "combo-a", comboName: "combo-a" };
    const comboB = { requestedModel: "combo-b", comboName: "combo-b" };

    db.trackPendingRequest("gemini-3.1-flash-lite", "antigravity", "account-1", true, false, comboA);
    db.trackPendingRequest("gemini-3.1-flash-lite", "antigravity", "account-1", true, false, comboB);

    let active = (await db.getActiveRequests()).activeRequests;
    expect(active).toEqual(expect.arrayContaining([
      expect.objectContaining({ comboName: "combo-a", requestedModel: "combo-a", count: 1 }),
      expect.objectContaining({ comboName: "combo-b", requestedModel: "combo-b", count: 1 }),
    ]));

    db.trackPendingRequest("gemini-3.1-flash-lite", "antigravity", "account-1", false, false, comboA);
    active = (await db.getActiveRequests()).activeRequests;
    expect(active.some((entry) => entry.comboName === "combo-a")).toBe(false);
    expect(active.some((entry) => entry.comboName === "combo-b")).toBe(true);

    db.trackPendingRequest("gemini-3.1-flash-lite", "antigravity", "account-1", false, false, comboB);
    expect((await db.getActiveRequests()).activeRequests).toHaveLength(0);
  });

  it("passes handler attribution through saveUsageStats into usageHistory", async () => {
    saveUsageStats({
      provider: "gemini-cli",
      model: "gemini-3-flash",
      connectionId: "account-2",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 41, completion_tokens: 9 },
      requestAttribution: { requestedModel: "fast", comboName: "fast" },
      silent: true,
    });

    const entry = await waitFor(async () => {
      const history = await db.getUsageHistory({ provider: "gemini-cli" });
      return history.find((item) => item.comboName === "fast");
    });
    expect(entry).toMatchObject({
      model: "gemini-3-flash",
      requestedModel: "fast",
      comboName: "fast",
    });
  });
});
