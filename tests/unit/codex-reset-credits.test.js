import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  getProviderConnectionById: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  getCodexRateLimitResetCredits: vi.fn(),
  consumeCodexRateLimitResetCredit: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getCodexRateLimitResetCredits: mocks.getCodexRateLimitResetCredits,
  consumeCodexRateLimitResetCredit: mocks.consumeCodexRateLimitResetCredit,
}));

describe("Codex reset credits", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("returns normalized reset credit expiry details", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        available_count: 2,
        credits: [
          {
            status: "available",
            granted_at: "2026-06-18T00:25:18Z",
            expires_at: "2026-07-18T00:25:18Z",
          },
          {
            status: "redeemed",
            granted_at: "bad-date",
            expires_at: null,
          },
        ],
      }),
    });

    const { getCodexRateLimitResetCredits } = await import("../../open-sse/services/usage/codex.js");
    const result = await getCodexRateLimitResetCredits("token", { strictProxy: false }, { workspaceId: "acct_123" });

    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/rate-limit-reset-credits"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "ChatGPT-Account-ID": "acct_123",
        }),
      }),
      { strictProxy: false },
    );
    expect(result).toEqual({
      availableCount: 2,
      credits: [
        {
          status: "available",
          grantedAt: "2026-06-18T00:25:18.000Z",
          expiresAt: "2026-07-18T00:25:18.000Z",
        },
        {
          status: "redeemed",
          grantedAt: null,
          expiresAt: null,
        },
      ],
    });
  });

  it("accepts the nested WHAM reset-credit envelope", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          available_count: "3",
          credits: [
            {
              state: "available",
              granted_at: "2099-06-18T00:25:18Z",
              expires_at: "2099-07-18T00:25:18Z",
            },
          ],
        },
      }),
    });

    const { getCodexRateLimitResetCredits } = await import("../../open-sse/services/usage/codex.js");
    const result = await getCodexRateLimitResetCredits("token");

    expect(result).toEqual({
      availableCount: 3,
      credits: [{
        status: "available",
        grantedAt: "2099-06-18T00:25:18.000Z",
        expiresAt: "2099-07-18T00:25:18.000Z",
      }],
    });
  });

  it("derives available count from unredeemed, non-expired credit details", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          credits: [
            { status: "available", expires_at: "2099-07-18T00:25:18Z" },
            { state: "used", expires_at: "2099-07-18T00:25:18Z" },
            { status: "expired", expires_at: "2000-07-18T00:25:18Z" },
          ],
        },
      }),
    });

    const { getCodexRateLimitResetCredits } = await import("../../open-sse/services/usage/codex.js");
    const result = await getCodexRateLimitResetCredits("token");

    expect(result.availableCount).toBe(1);
  });

  it("GET refreshes OAuth credentials before returning reset credit details", async () => {
    const connection = {
      id: "conn_1",
      provider: "codex",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: { workspaceId: "acct_123" },
    };
    const refreshedConnection = { ...connection, accessToken: "new-token" };
    const resetCredits = {
      availableCount: 1,
      credits: [{ status: "available", grantedAt: "2026-06-18T00:25:18.000Z", expiresAt: "2026-07-18T00:25:18.000Z" }],
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local" });
    mocks.refreshAndUpdateCredentials.mockResolvedValue({ connection: refreshedConnection });
    mocks.getCodexRateLimitResetCredits.mockResolvedValue(resetCredits);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_1/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resetCredits);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledWith(
      connection,
      false,
      expect.objectContaining({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local", strictProxy: false }),
    );
    expect(mocks.getCodexRateLimitResetCredits).toHaveBeenCalledWith(
      "new-token",
      expect.objectContaining({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.local", strictProxy: false }),
      { workspaceId: "acct_123" },
    );
  });

  it("GET force-refreshes OAuth credentials when reset credit fetch reports expired auth", async () => {
    const connection = {
      id: "conn_1",
      provider: "codex",
      authType: "oauth",
      accessToken: "old-token",
      refreshToken: "refresh-token",
      providerSpecificData: {},
    };
    const refreshedConnection = { ...connection, accessToken: "new-token" };
    const forcedConnection = { ...connection, accessToken: "forced-token" };
    const resetCredits = { availableCount: 0, credits: [] };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.refreshAndUpdateCredentials
      .mockResolvedValueOnce({ connection: refreshedConnection })
      .mockResolvedValueOnce({ connection: forcedConnection });
    mocks.getCodexRateLimitResetCredits
      .mockRejectedValueOnce(new Error("Unauthorized 401"))
      .mockResolvedValueOnce(resetCredits);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/conn_1/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resetCredits);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenNthCalledWith(1, connection, false, expect.any(Object));
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenNthCalledWith(2, refreshedConnection, true, expect.any(Object));
    expect(mocks.getCodexRateLimitResetCredits).toHaveBeenNthCalledWith(2, "forced-token", expect.any(Object), {});
  });

  it("POST returns 409 when there are no reset credits to consume", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "conn_1",
      provider: "codex",
      authType: "access_token",
      accessToken: "token",
      providerSpecificData: {},
    });
    mocks.consumeCodexRateLimitResetCredit.mockResolvedValue({
      ok: false,
      noCredit: true,
      status: 200,
      code: "no_credit",
      windowsReset: 0,
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/conn_1/codex-reset-credits", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn_1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "no_credit",
      reset: false,
      windows_reset: 0,
      message: "No Codex reset credits available.",
    });
    expect(mocks.consumeCodexRateLimitResetCredit).toHaveBeenCalledWith(
      "token",
      expect.any(String),
      expect.objectContaining({ strictProxy: false }),
    );
  });

  it("GET accepts an OpenAI connection marked as Codex quota-only", async () => {
    const connection = {
      id: "openai-quota-1",
      provider: "openai",
      authType: "oauth",
      accessToken: "chatgpt-token",
      refreshToken: "chatgpt-refresh-token",
      providerSpecificData: {
        usageOnly: true,
        authMethod: "codex_oauth",
        chatgptAccountId: "acct_123",
      },
    };
    const refreshedConnection = { ...connection, accessToken: "refreshed-chatgpt-token" };
    const resetCredits = { availableCount: 2, credits: [] };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.refreshAndUpdateCredentials.mockResolvedValue({ connection: refreshedConnection });
    mocks.getCodexRateLimitResetCredits.mockResolvedValue(resetCredits);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/openai-quota-1/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "openai-quota-1" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(resetCredits);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledWith(
      connection,
      false,
      expect.objectContaining({ strictProxy: false }),
    );
    expect(mocks.getCodexRateLimitResetCredits).toHaveBeenCalledWith(
      "refreshed-chatgpt-token",
      expect.objectContaining({ strictProxy: false }),
      connection.providerSpecificData,
    );
  });

  it("POST accepts an OpenAI access-token connection marked as Codex quota-only", async () => {
    const connection = {
      id: "openai-quota-2",
      provider: "openai",
      authType: "access_token",
      accessToken: "chatgpt-token",
      providerSpecificData: { usageOnly: true, chatgptAccountId: "acct_456" },
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.consumeCodexRateLimitResetCredit.mockResolvedValue({
      ok: true,
      noCredit: false,
      status: 200,
      code: "reset",
      windowsReset: 1,
      raw: { credit: { status: "redeemed" } },
    });

    const { POST } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await POST(new Request("http://localhost/api/usage/openai-quota-2/codex-reset-credits", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "openai-quota-2" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: "reset", reset: true, windows_reset: 1 });
    expect(mocks.refreshAndUpdateCredentials).not.toHaveBeenCalled();
    expect(mocks.consumeCodexRateLimitResetCredit).toHaveBeenCalledWith(
      "chatgpt-token",
      expect.any(String),
      expect.objectContaining({ strictProxy: false }),
    );
  });

  it.each([
    {
      label: "an ordinary OpenAI OAuth connection",
      authType: "oauth",
      providerSpecificData: {},
    },
    {
      label: "an OpenAI Platform API-key connection",
      authType: "apikey",
      apiKey: "sk-platform",
      providerSpecificData: {},
    },
  ])("rejects $label", async ({ authType, apiKey, providerSpecificData }) => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "openai-non-codex",
      provider: "openai",
      authType,
      accessToken: authType === "oauth" ? "ordinary-oauth-token" : undefined,
      apiKey,
      providerSpecificData,
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/codex-reset-credits/route.js");
    const response = await GET(new Request("http://localhost/api/usage/openai-non-codex/codex-reset-credits"), {
      params: Promise.resolve({ connectionId: "openai-non-codex" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(mocks.getCodexRateLimitResetCredits).not.toHaveBeenCalled();
  });
});
