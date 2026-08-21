import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getUsageForProvider: vi.fn(),
  getExecutor: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  backfillCodexEmails: vi.fn(),
  extractCodexAccountInfo: vi.fn(),
  createProviderConnection: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("@/lib/oauth/providers", () => ({
  backfillCodexEmails: mocks.backfillCodexEmails,
  extractCodexAccountInfo: mocks.extractCodexAccountInfo,
}));

vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
}));

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: mocks.getUsageForProvider,
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: mocks.getExecutor,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

describe("OpenAI Codex quota API eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.getExecutor.mockReturnValue({
      needsRefresh: vi.fn(() => false),
      refreshCredentials: vi.fn(),
    });
    mocks.extractCodexAccountInfo.mockReturnValue({});
    mocks.createProviderConnection.mockImplementation(async (connection) => ({
      id: "created-1",
      ...connection,
    }));
  });

  it("fetches quota for an OpenAI connection backed by an imported ChatGPT access token", async () => {
    const connection = {
      id: "openai-oauth-1",
      provider: "openai",
      authType: "access_token",
      accessToken: "chatgpt-oauth-token",
      providerSpecificData: { chatgptAccountId: "acct_1", usageOnly: true, authMethod: "codex_oauth" },
    };
    const expected = {
      plan: "plus",
      quotas: { session: { used: 10, total: 100, remaining: 90 } },
    };
    mocks.getProviderConnectionById.mockResolvedValue(connection);
    mocks.getUsageForProvider.mockResolvedValue(expected);

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(
      new Request("http://localhost/api/usage/openai-oauth-1"),
      { params: Promise.resolve({ connectionId: "openai-oauth-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect(mocks.getUsageForProvider).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({ strictProxy: false }),
      { force: false },
    );
  });

  it("does not expose the quota route for an ordinary OpenAI Platform API-key connection", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "openai-key-1",
      provider: "openai",
      authType: "apikey",
      apiKey: "sk-platform-only",
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(
      new Request("http://localhost/api/usage/openai-key-1"),
      { params: Promise.resolve({ connectionId: "openai-key-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Usage not available for this connection" });
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });

  it("does not treat an unmarked OpenAI OAuth token as a Codex quota credential", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "openai-unmarked-oauth",
      provider: "openai",
      authType: "access_token",
      accessToken: "platform-oauth-token",
    });

    const { GET } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const response = await GET(
      new Request("http://localhost/api/usage/openai-unmarked-oauth"),
      { params: Promise.resolve({ connectionId: "openai-unmarked-oauth" }) },
    );

    expect(await response.json()).toEqual({ message: "Usage not available for this connection" });
    expect(mocks.getUsageForProvider).not.toHaveBeenCalled();
  });

  it("refreshes an OpenAI quota-only OAuth token through the Codex credential flow", async () => {
    const refreshCredentials = vi.fn().mockResolvedValue({
      accessToken: "new-chatgpt-token",
      refreshToken: "rotated-refresh-token",
      expiresIn: 3600,
    });
    mocks.getExecutor.mockReturnValue({
      needsRefresh: vi.fn(() => true),
      refreshCredentials,
    });
    const connection = {
      id: "openai-quota-oauth",
      provider: "openai",
      authType: "oauth",
      accessToken: "old-chatgpt-token",
      refreshToken: "old-refresh-token",
      providerSpecificData: { usageOnly: true, chatgptAccountId: "acct_1" },
    };

    const { refreshAndUpdateCredentials } = await import("../../src/app/api/usage/[connectionId]/route.js");
    const result = await refreshAndUpdateCredentials(connection, false, { strictProxy: false });

    expect(mocks.getExecutor).toHaveBeenCalledWith("codex");
    expect(refreshCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "old-chatgpt-token",
        refreshToken: "old-refresh-token",
        providerSpecificData: connection.providerSpecificData,
      }),
      console,
      { strictProxy: false },
    );
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith(
      "openai-quota-oauth",
      expect.objectContaining({
        accessToken: "new-chatgpt-token",
        refreshToken: "rotated-refresh-token",
      }),
    );
    expect(result.connection.accessToken).toBe("new-chatgpt-token");
  });

  it("lists OpenAI access-token quota cards but filters OpenAI API-key cards", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "openai-oauth-1",
        provider: "openai",
        authType: "access_token",
        accessToken: "secret-token",
        name: "ChatGPT quota",
        priority: 1,
        providerSpecificData: { usageOnly: true, authMethod: "codex_oauth" },
      },
      {
        id: "openai-key-1",
        provider: "openai",
        authType: "apikey",
        apiKey: "sk-secret",
        name: "Platform API",
        priority: 2,
      },
      {
        id: "codex-oauth-1",
        provider: "codex",
        authType: "oauth",
        accessToken: "secret-codex-token",
        name: "Codex OAuth",
        priority: 3,
      },
      {
        id: "codex-access-token-1",
        provider: "codex",
        authType: "access_token",
        accessToken: "secret-codex-access-token",
        name: "Codex pasted token",
        priority: 4,
      },
    ]);

    const { GET } = await import("../../src/app/api/providers/client/route.js");
    const response = await GET(new Request("http://localhost/api/providers/client?pageSize=50"));
    const body = await response.json();

    expect(body.connections.map((connection) => connection.id)).toEqual([
      "openai-oauth-1",
      "codex-oauth-1",
      "codex-access-token-1",
    ]);
    const openaiQuota = body.connections.find((connection) => connection.id === "openai-oauth-1");
    expect(openaiQuota.providerSpecificData).toEqual(expect.objectContaining({
      usageOnly: true,
      authMethod: "codex_oauth",
    }));
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(JSON.stringify(body)).not.toContain("secret-codex-token");
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });

  it("does not list an unmarked OpenAI OAuth row in the quota client feed", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "openai-unmarked-oauth",
      provider: "openai",
      authType: "oauth",
      accessToken: "platform-oauth-token",
      priority: 1,
    }]);

    const { GET } = await import("../../src/app/api/providers/client/route.js");
    const response = await GET(new Request("http://localhost/api/providers/client?pageSize=50"));
    const body = await response.json();

    expect(body.connections).toEqual([]);
    expect(body.totals.eligibleConnections).toBe(0);
  });

  it("imports Codex OAuth credentials under OpenAI as a quota-only connection", async () => {
    mocks.extractCodexAccountInfo.mockReturnValue({
      email: "user@example.com",
      chatgptAccountId: "acct_imported",
      chatgptPlanType: "plus",
    });

    const { POST } = await import("../../src/app/api/oauth/codex/bulk-import/route.js");
    const response = await POST(new Request("http://localhost/api/oauth/codex/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetProvider: "openai",
        accounts: [{
          tokens: {
            access_token: "chatgpt-access-secret",
            refresh_token: "chatgpt-refresh-secret",
            id_token: "chatgpt-id-secret",
            account_id: "acct_native_auth_file",
          },
        }],
      }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      success: 1,
      failed: 0,
      results: [{ index: 0, ok: true, id: "created-1" }],
    });
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      authType: "oauth",
      accessToken: "chatgpt-access-secret",
      refreshToken: "chatgpt-refresh-secret",
      idToken: "chatgpt-id-secret",
      email: "user@example.com",
      isActive: false,
      providerSpecificData: expect.objectContaining({
        chatgptAccountId: "acct_native_auth_file",
        chatgptPlanType: "plus",
        authMethod: "codex_oauth",
        usageOnly: true,
      }),
    }));
    const imported = mocks.createProviderConnection.mock.calls[0][0];
    expect(imported.providerSpecificData.accessToken).toBeUndefined();
    expect(imported.providerSpecificData.refreshToken).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("secret");
  });
});
