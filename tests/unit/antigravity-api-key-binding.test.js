import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ag-key-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function addConnection(provider, name) {
  const { createProviderConnection } = await import("@/lib/localDb");
  return createProviderConnection({
    provider,
    authType: "oauth",
    name,
    accessToken: `${name}-token`,
  });
}

describe("Antigravity account API keys", () => {
  it("allows one bound key per Antigravity account", async () => {
    const { createApiKey, getApiKeyByValue } = await import("@/lib/localDb");
    const account = await addConnection("antigravity", "Account A");

    const key = await createApiKey("Account A key", "0123456789abcdef", account.id);
    expect((await getApiKeyByValue(key.key)).providerConnectionId).toBe(account.id);

    await expect(createApiKey("Duplicate", "0123456789abcdef", account.id))
      .rejects.toMatchObject({ code: "ANTIGRAVITY_KEY_EXISTS" });
  });

  it("rejects bindings to non-Antigravity connections", async () => {
    const { createApiKey } = await import("@/lib/localDb");
    const account = await addConnection("codex", "Codex account");

    await expect(createApiKey("Wrong provider", "0123456789abcdef", account.id))
      .rejects.toMatchObject({ code: "INVALID_ANTIGRAVITY_CONNECTION" });
  });

  it("pins credential selection to the account stored on the key", async () => {
    const { createApiKey } = await import("@/lib/localDb");
    const first = await addConnection("antigravity", "Account A");
    const second = await addConnection("antigravity", "Account B");
    const key = await createApiKey("Account B key", "0123456789abcdef", second.id);
    const { getApiKeyContext, getProviderCredentials } = await import("@/sse/services/auth.js");

    const context = await getApiKeyContext(key.key);
    const credentials = await getProviderCredentials("antigravity", null, "gemini-test", {
      requiredConnectionId: context.providerConnectionId,
    });

    expect(credentials.connectionId).toBe(second.id);
    expect(credentials.connectionId).not.toBe(first.id);
  });

  it("reports the bound account's model reset instead of another account's reset", async () => {
    const { updateProviderConnection } = await import("@/lib/localDb");
    const first = await addConnection("antigravity", "Account A");
    const second = await addConnection("antigravity", "Account B");
    const firstReset = new Date(Date.now() + 29 * 60 * 1000).toISOString();
    const secondReset = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    await updateProviderConnection(first.id, { "modelLock_gemini-test": firstReset });
    await updateProviderConnection(second.id, { "modelLock_gemini-test": secondReset });
    const { getProviderCredentials } = await import("@/sse/services/auth.js");

    const credentials = await getProviderCredentials("antigravity", null, "gemini-test", {
      requiredConnectionId: first.id,
    });

    expect(credentials.allRateLimited).toBe(true);
    expect(credentials.retryAfter).toBe(firstReset);
  });

  it("honors Antigravity quota resets longer than the generic 30-minute cap", async () => {
    const account = await addConnection("antigravity", "Account A");
    const resetAt = Date.now() + (3 * 60 + 15) * 60 * 1000 + 9_000;
    const upstreamError = JSON.stringify({
      error: {
        code: 429,
        message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h15m9s.",
        status: "RESOURCE_EXHAUSTED",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "QUOTA_EXHAUSTED",
          metadata: { quotaResetDelay: "3h15m9.163842378s" },
        }],
      },
    });
    const { getProviderConnections } = await import("@/lib/localDb");
    const { markAccountUnavailable } = await import("@/sse/services/auth.js");

    const result = await markAccountUnavailable(
      account.id,
      429,
      upstreamError,
      "antigravity",
      "gemini-3.5-flash-low",
      resetAt,
    );
    const [stored] = await getProviderConnections({ provider: "antigravity" });

    expect(result.cooldownMs).toBeGreaterThan(3 * 60 * 60 * 1000);
    expect(result.cooldownMs).toBeLessThanOrEqual((3 * 60 + 15) * 60 * 1000 + 9_000);
    expect(new Date(stored["modelLock_gemini-3.5-flash-low"]).getTime()).toBe(resetAt);
    expect(stored.lastError).toBe(upstreamError);
    expect(stored.lastError.length).toBeGreaterThan(100);
  });

  it("revokes the bound key when its account is deleted", async () => {
    const { createApiKey, deleteProviderConnection, validateApiKey } = await import("@/lib/localDb");
    const account = await addConnection("antigravity", "Account A");
    const key = await createApiKey("Account A key", "0123456789abcdef", account.id);

    await deleteProviderConnection(account.id);

    expect(await validateApiKey(key.key)).toBe(false);
  });
});
