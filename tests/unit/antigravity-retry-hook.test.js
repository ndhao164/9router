// Guards D3: antigravity 429/503 retry merged into base via computeRetryDelay hook.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import antigravity from "../../open-sse/providers/registry/antigravity.js";
import { formatRetryAfter, resolveRetryAfter } from "../../open-sse/services/accountFallback.js";
import { formatResetTimeSeconds, unavailableResponse } from "../../open-sse/utils/error.js";

const MAX = 10000;
function res(status, headers = {}, body = null) {
  return {
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => (body == null ? "" : JSON.stringify(body)) }),
  };
}

describe("antigravity computeRetryDelay hook (D3)", () => {
  const ag = new AntigravityExecutor();

  it("uses Retry-After header (seconds → ms) when within cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "5" }), 1)).toBe(5000);
  });

  it("vetoes (false) when Retry-After exceeds cap", async () => {
    expect(await ag.computeRetryDelay(res(429, { "retry-after": "60" }), 1)).toBe(false);
  });

  it("parses retry time from error body when no header", async () => {
    const r = res(429, {}, { error: { message: "quota will reset after 3s" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(3000);
  });

  it("extracts Google's precise quota reset timestamp for account cooldown", () => {
    const resetAt = Date.now() + 29 * 60 * 1000;
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You have exhausted your capacity on this model. Your quota will reset after 29m4s.",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            metadata: {
              quotaResetDelay: "29m4.338700336s",
              quotaResetTimeStamp: new Date(resetAt).toISOString(),
            },
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "1744.338700336s",
          },
        ],
      },
    });

    expect(ag.parseError({ status: 429 }, body).resetsAtMs).toBe(resetAt);
  });

  it("parses fractional Google retry durations", () => {
    expect(ag.parseGoogleDuration("29m4.338700336s")).toBe(1_744_339);
    expect(ag.parseGoogleDuration("1744.338700336s")).toBe(1_744_339);
  });

  it("keeps the current 1h31m42s reset instead of another account's 12m lock", () => {
    const now = Date.now();
    const otherAccountReset = new Date(now + 12 * 60 * 1000).toISOString();
    const currentErrorReset = now + (60 + 31) * 60 * 1000 + 42_000;

    expect(resolveRetryAfter(otherAccountReset, currentErrorReset, now))
      .toBe(new Date(currentErrorReset).toISOString());
    expect(formatRetryAfter(new Date(currentErrorReset + 711).toISOString(), now))
      .toBe("reset after 1h 31m 42s");
  });

  it("returns the 429 reset duration as total seconds in error.time", async () => {
    const now = Date.now();
    const retryAfter = new Date(now + 5_502_711).toISOString();
    expect(formatResetTimeSeconds(retryAfter, now)).toBe("5502s");

    const response = unavailableResponse(
      429,
      "[antigravity/gemini-3.1-flash-lite] quota exhausted",
      retryAfter,
      "reset after 1h 31m 42s",
    );

    const body = await response.json();
    expect(body.error.time).toBe("5502s");
    expect(body.error.message).toContain("reset after 1h 31m 42s");
  });

  it("does not add error.time to non-429 unavailable responses", async () => {
    const response = unavailableResponse(
      503,
      "temporarily unavailable",
      new Date(Date.now() + 30_000).toISOString(),
      "reset after 30s",
    );

    expect((await response.json()).error).not.toHaveProperty("time");
  });

  it("exponential backoff for 429 when no retry info", async () => {
    expect(await ag.computeRetryDelay(res(429), 1)).toBe(Math.min(1000 * 2 ** 1, MAX));
    expect(await ag.computeRetryDelay(res(429), 3)).toBe(Math.min(1000 * 2 ** 3, MAX));
  });

  it("503 without retry info → transient backoff", async () => {
    expect(await ag.computeRetryDelay(res(503), 1)).toBe(2000);
  });

  it("retries Antigravity agent terminated body even when status is not 429", async () => {
    const r = res(500, {}, { error: { message: "Agent execution terminated due to error" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(2000);
  });

  it("retries high traffic body", async () => {
    const r = res(500, {}, { error: { message: "Our servers are experiencing high traffic" } });
    expect(await ag.computeRetryDelay(r, 2)).toBe(4000);
  });

  it("does not retry non-transient 400 errors", async () => {
    const r = res(400, {}, { error: { message: "Invalid request" } });
    expect(await ag.computeRetryDelay(r, 1)).toBe(false);
  });

  it("deduplicates sanitized tool names", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [
          { name: "read/file", parameters: { type: "object", properties: {} } },
          { name: "read file", parameters: { type: "object", properties: {} } },
          { name: "read/file", parameters: { type: "object", properties: {} } },
        ] }],
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.request.tools[0].functionDeclarations.map(fn => fn.name)).toEqual(["read_file"]);
  });

  it("registry uses the daily IDE cloudcode host and user agent", () => {
    expect(antigravity.transport.baseUrls).toEqual(["https://daily-cloudcode-pa.googleapis.com"]);
    expect(antigravity.transport.headers["User-Agent"]).toBe("antigravity/ide/2.1.1 darwin/arm64");
  });

  it("buildHeaders matches official IDE stream headers", () => {
    ag._lastSessionId = "sess-123";
    const h = ag.buildHeaders({ accessToken: "tok" }, true);
    expect(h["User-Agent"]).toBe("antigravity/ide/2.1.1 darwin/arm64");
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h).not.toHaveProperty("X-Machine-Session-Id");
    expect(h).not.toHaveProperty("x-request-source");
    expect(h).not.toHaveProperty("Accept");
  });

  it("transforms chat requests with official IDE requestId shape and 64000 token cap", () => {
    const out = ag.transformRequest("claude-opus-4-6-thinking", {
      request: {
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          { role: "model", parts: [{ text: "hello" }] },
        ],
        generationConfig: { maxOutputTokens: 90000 },
        sessionId: "-3750763034362895579",
      },
    }, true, { projectId: "project-1", connectionId: "conn-1" });

    expect(out.requestId).toMatch(/^agent\/[0-9a-f-]{36}\/\d{13}\/[0-9a-f-]{36}\/\d+$/);
    expect(out.request.generationConfig.maxOutputTokens).toBe(64000);
  });
});
