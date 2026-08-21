import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
}));

describe("OpenAI quota-only model discovery guard", () => {
  const originalFetch = global.fetch;
  let fetchSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.fn(() => Promise.reject(new Error("network must not be called")));
    global.fetch = fetchSpy;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the static catalog without sending the ChatGPT token to api.openai.com", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "openai-quota",
      provider: "openai",
      authType: "oauth",
      accessToken: "chatgpt-secret-token",
      providerSpecificData: { usageOnly: true, authMethod: "codex_oauth" },
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(
      new Request("http://localhost/api/providers/openai-quota/models"),
      { params: Promise.resolve({ id: "openai-quota" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.quotaOnly).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.warning).toMatch(/quota-only/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("also guards legacy records carrying only the Codex OAuth marker", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "openai-legacy-codex",
      provider: "openai",
      authType: "access_token",
      accessToken: "chatgpt-secret-token",
      providerSpecificData: { authMethod: "codex_oauth" },
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(
      new Request("http://localhost/api/providers/openai-legacy-codex/models"),
      { params: Promise.resolve({ id: "openai-legacy-codex" }) },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).quotaOnly).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed for an OpenAI OAuth row with no Codex provenance marker", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "openai-unmarked-oauth",
      provider: "openai",
      authType: "oauth",
      accessToken: "ambiguous-token",
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(
      new Request("http://localhost/api/providers/openai-unmarked-oauth/models"),
      { params: Promise.resolve({ id: "openai-unmarked-oauth" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/marker/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed for legacy OAuth markers even when a stale API key is present", async () => {
    mocks.getProviderConnectionById.mockResolvedValue({
      id: "openai-legacy-oauth-dual",
      provider: "openai",
      // Legacy rows can carry an API key-shaped field alongside the token.
      authType: "apikey",
      apiKey: "stale-platform-key",
      accessToken: "chatgpt-secret-token",
      providerSpecificData: { authMethod: "access_token" },
    });

    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    const response = await GET(
      new Request("http://localhost/api/providers/openai-legacy-oauth-dual/models"),
      { params: Promise.resolve({ id: "openai-legacy-oauth-dual" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models).toEqual([]);
    expect(body.warning).toMatch(/marker/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
