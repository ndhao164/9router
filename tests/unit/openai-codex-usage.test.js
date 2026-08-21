import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getCodexUsage } from "../../open-sse/services/usage/codex.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_APIKEY_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
} from "../../src/shared/constants/providers.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unsignedJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function getHeader(headers, name) {
  const match = Object.entries(headers || {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

describe("OpenAI Codex quota registry contract", () => {
  it("enables usage for OAuth/access-token accounts without enabling API-key quota", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("openai");
    expect(USAGE_APIKEY_PROVIDERS).not.toContain("openai");
  });
});

describe("getCodexUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the Codex OAuth token, account id, and proxy options to wham/usage", async () => {
    const proxyOptions = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:8080" };
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ rate_limit: {} }));

    await getCodexUsage("oauth-access-token", proxyOptions, {
      chatgptAccountId: "acct_saved",
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, options, forwardedProxyOptions] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(USAGE_URL);
    expect(options.method).toBe("GET");
    expect(getHeader(options.headers, "Authorization")).toBe("Bearer oauth-access-token");
    expect(getHeader(options.headers, "Accept")).toBe("application/json");
    expect(getHeader(options.headers, "ChatGPT-Account-ID")).toBe("acct_saved");
    expect(getHeader(options.headers, "OpenAI-Beta")).toBe("codex-1");
    expect(getHeader(options.headers, "originator")).toBe("Codex Desktop");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(forwardedProxyOptions).toBe(proxyOptions);
  });

  it("falls back to the ChatGPT account id embedded in the access-token JWT", async () => {
    const accessToken = unsignedJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_from_jwt",
      },
    });
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ rate_limit: {} }));

    await getCodexUsage(accessToken);

    const [, options] = proxyAwareFetch.mock.calls[0];
    expect(getHeader(options.headers, "Authorization")).toBe(`Bearer ${accessToken}`);
    expect(getHeader(options.headers, "ChatGPT-Account-ID")).toBe("acct_from_jwt");
  });

  it("supports the flat auth.chatgpt_account_id JWT claim used by Codex OAuth", async () => {
    const accessToken = unsignedJwt({
      "https://api.openai.com/auth.chatgpt_account_id": "acct_flat_claim",
    });
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ rate_limit: {} }));

    await getCodexUsage(accessToken);

    const [, options] = proxyAwareFetch.mock.calls[0];
    expect(getHeader(options.headers, "ChatGPT-Account-ID")).toBe("acct_flat_claim");
  });

  it("parses primary, secondary, and code-review quota windows", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      plan_type: "plus",
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 35, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 60, reset_at: 1_800_604_800 },
      },
      code_review_rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 10, reset_at: 1_800_010_000 },
        secondary_window: { used_percent: 20, reset_at: 1_800_614_800 },
      },
    }));

    const usage = await getCodexUsage("oauth-token");

    expect(usage).toMatchObject({
      plan: "plus",
      limitReached: false,
      reviewLimitReached: true,
      quotas: {
        session: {
          used: 35,
          total: 100,
          remaining: 65,
          resetAt: "2027-01-15T08:00:00.000Z",
          windowMinutes: 300,
        },
        weekly: {
          used: 60,
          total: 100,
          remaining: 40,
          resetAt: "2027-01-22T08:00:00.000Z",
        },
        review_session: {
          used: 10,
          total: 100,
          remaining: 90,
          resetAt: "2027-01-15T10:46:40.000Z",
        },
        review_weekly: {
          used: 20,
          total: 100,
          remaining: 80,
          resetAt: "2027-01-22T10:46:40.000Z",
        },
      },
    });
  });

  it("uses reset_after_seconds when reset_at is absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      rate_limit: {
        primary_window: { used_percent: 25, reset_after_seconds: 90 },
      },
    }));

    const usage = await getCodexUsage("oauth-token");

    expect(usage.quotas.session.resetAt).toBe("2026-08-21T00:01:30.000Z");
  });

  it("parses Codex Business monthly credits from spend_control", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      plan_type: "business",
      rate_limit: {},
      spend_control: {
        individual_limit: {
          limit: "25000",
          used: "8000",
          remaining: "17000",
          remaining_percent: 68,
          reset_at: 1_790_000_000,
        },
      },
    }));

    const usage = await getCodexUsage("oauth-token");

    expect(usage.monthlyCredits).toEqual({
      used: 8000,
      total: 25000,
      remaining: 17000,
      remainingPercentage: 68,
      resetAt: new Date(1_790_000_000 * 1000).toISOString(),
    });
    expect(usage).not.toHaveProperty("spend_control");
  });

  it("accepts the camelCase resetsAt alias for monthly credits", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      rate_limit: {},
      spendControl: {
        individualLimit: {
          limit: 100,
          remaining: 75,
          remainingPercent: 75,
          resetsAt: "2026-09-20T00:00:00.000Z",
        },
      },
    }));

    const usage = await getCodexUsage("oauth-token");

    expect(usage.monthlyCredits).toEqual({
      total: 100,
      remaining: 75,
      remainingPercentage: 75,
      resetAt: "2026-09-20T00:00:00.000Z",
    });
  });

  it("supports legacy balance-only monthly credits without exposing the raw payload", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      rate_limit: {},
      credits: {
        unlimited: false,
        balance: "42",
      },
    }));

    const usage = await getCodexUsage("oauth-token");

    expect(usage.monthlyCredits).toEqual({
      balance: "42",
      remaining: 42,
      unlimited: false,
      resetAt: null,
    });
    expect(usage).not.toHaveProperty("credits");
  });

  it("derives Business credit balance, clamps percentages, and prefers spend_control", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      rate_limit: {},
      spend_control: {
        individual_limit: {
          limit: 100,
          used: 30,
          remaining_percent: 140,
          reset_after_seconds: 60,
        },
      },
      credits: { balance: "999" },
    }));

    const usage = await getCodexUsage("oauth-token");

    expect(usage.monthlyCredits).toEqual({
      used: 30,
      total: 100,
      remaining: 70,
      remainingPercentage: 100,
      resetAt: "2026-08-21T00:01:00.000Z",
    });
  });

  it("skips a partially populated window without failing the whole quota response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      rate_limit: {
        primary_window: { reset_at: 1_800_000_000 },
      },
    }));

    const usage = await getCodexUsage("oauth-token");
    expect(usage.quotas).toEqual({});
  });

  it("returns an authentication message for a 401 response", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ detail: "unauthorized" }, 401));

    const usage = await getCodexUsage("expired-oauth-token");

    expect(usage.message).toMatch(/auth|unauthorized|re-authorize|401/i);
  });

  it("treats a WHAM 403 as an authentication failure for refresh/re-authorize", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ detail: "forbidden" }, 403));

    const usage = await getCodexUsage("expired-oauth-token");

    expect(usage.message).toMatch(/auth|unauthorized|re-authorize|403/i);
  });

  it("does not call the network without an OAuth access token", async () => {
    const usage = await getCodexUsage(null);

    expect(usage.message).toMatch(/access token|oauth|re-authorize/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("rejects a Platform API key even when passed directly to the Codex handler", async () => {
    const usage = await getCodexUsage("sk-proj-platform-key");

    expect(usage.message).toMatch(/Platform API key|OAuth/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("getUsageForProvider(openai)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses accessToken and never substitutes the OpenAI Platform apiKey", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ rate_limit: {} }));

    await getUsageForProvider({
      provider: "openai",
      accessToken: "codex-oauth-token",
      apiKey: "sk-platform-must-not-be-used",
      providerSpecificData: { chatgptAccountId: "acct_1", usageOnly: true, authMethod: "codex_oauth" },
    });

    const [, options] = proxyAwareFetch.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer codex-oauth-token");
    expect(JSON.stringify(options)).not.toContain("sk-platform-must-not-be-used");
  });

  it("does not call Codex usage with an API key when accessToken is absent", async () => {
    const usage = await getUsageForProvider({
      provider: "openai",
      apiKey: "sk-platform-only",
    });

    expect(usage.message).toMatch(/access token|oauth|re-authorize/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
