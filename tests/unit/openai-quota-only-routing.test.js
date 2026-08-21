import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getApiKeyByValue: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(async () => []),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));

describe("OpenAI quota-only routing isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first" });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("never selects an imported ChatGPT quota credential for OpenAI inference", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "quota-only",
        provider: "openai",
        authType: "oauth",
        isActive: true,
        accessToken: "chatgpt-token-must-not-route",
        priority: 1,
        providerSpecificData: { usageOnly: true },
      },
      {
        id: "platform-key",
        provider: "openai",
        authType: "apikey",
        isActive: true,
        apiKey: "sk-platform",
        priority: 2,
      },
    ]);

    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const credentials = await getProviderCredentials("openai");

    expect(credentials.connectionId).toBe("platform-key");
    expect(credentials.apiKey).toBe("sk-platform");
    expect(credentials.accessToken).toBeUndefined();
  });

  it("returns no routing credential when OpenAI only has quota-only accounts", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "quota-only",
      provider: "openai",
      authType: "oauth",
      isActive: true,
      accessToken: "chatgpt-token-must-not-route",
      providerSpecificData: { usageOnly: true },
    }]);

    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const credentials = await getProviderCredentials("openai");

    expect(credentials).toBeNull();
  });

  it("does not route an unmarked OpenAI OAuth row", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "unmarked-oauth",
      provider: "openai",
      authType: "oauth",
      isActive: true,
      accessToken: "ambiguous-token",
      priority: 1,
    }]);

    const { getProviderCredentials } = await import("@/sse/services/auth.js");
    const credentials = await getProviderCredentials("openai");

    expect(credentials).toBeNull();
  });
});
