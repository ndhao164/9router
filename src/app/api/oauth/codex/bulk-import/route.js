import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { extractCodexAccountInfo } from "@/lib/oauth/providers";

/**
 * POST /api/oauth/codex/bulk-import
 * Bulk import multiple codex (OAuth) account JSON objects in one call.
 *
 * Body accepts any of:
 *   - Array:    [{...}, {...}]
 *   - Single:   {...}
 *   - Wrapped:  { accounts: [{...}, ...] }
 *
 * Each item must contain `accessToken`, or native Codex auth fields under
 * `tokens.access_token`. Missing email / ChatGPT account info is best-effort
 * backfilled from the JWT (idToken or accessToken).
 * Set targetProvider="openai" to create quota-only OpenAI connections.
 *
 * Tokens are NEVER echoed back in the response.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${err.message}` },
      { status: 400 }
    );
  }

  const targetProvider = body?.targetProvider || "codex";
  if (targetProvider !== "codex" && targetProvider !== "openai") {
    return NextResponse.json(
      { error: "targetProvider must be codex or openai" },
      { status: 400 }
    );
  }

  // Normalize to array
  let accounts;
  if (Array.isArray(body)) {
    accounts = body;
  } else if (body && typeof body === "object" && Array.isArray(body.accounts)) {
    accounts = body.accounts;
  } else if (body && typeof body === "object") {
    accounts = [body];
  } else {
    accounts = null;
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json(
      { error: "No accounts provided" },
      { status: 400 }
    );
  }

  const results = [];
  let success = 0;
  let failed = 0;

  // SERIAL loop — createProviderConnection reads max(priority) and reorders
  // inside a transaction. Parallel calls would race on priority assignment.
  for (let i = 0; i < accounts.length; i++) {
    const raw = accounts[i];
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Item is not an object");
      }

      // Strip server-controlled fields
      const {
        id: _id,
        provider: _provider,
        authType: _authType,
        apiKey: _apiKey,
        targetProvider: _targetProvider,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...item
      } = raw;

      // Accept both 9Router's normalized shape and the native
      // ~/.codex/auth.json shape ({ tokens: { access_token, ... } }).
      const nativeTokens = item.tokens && typeof item.tokens === "object" && !Array.isArray(item.tokens)
        ? item.tokens
        : {};
      item.accessToken = item.accessToken || item.access_token || nativeTokens.accessToken || nativeTokens.access_token;
      item.refreshToken = item.refreshToken || item.refresh_token || nativeTokens.refreshToken || nativeTokens.refresh_token;
      item.idToken = item.idToken || item.id_token || nativeTokens.idToken || nativeTokens.id_token;
      item.expiresAt = item.expiresAt || item.expires_at || nativeTokens.expiresAt || nativeTokens.expires_at;
      item.expiresIn = item.expiresIn || item.expires_in || nativeTokens.expiresIn || nativeTokens.expires_in;
      item.lastRefreshAt = item.lastRefreshAt || item.last_refresh || null;

      const importedAccountId =
        item.accountId ||
        item.account_id ||
        item.workspaceId ||
        item.workspace_id ||
        nativeTokens.accountId ||
        nativeTokens.account_id ||
        null;

      delete item.tokens;
      delete item.access_token;
      delete item.refresh_token;
      delete item.id_token;
      delete item.expires_at;
      delete item.expires_in;
      delete item.last_refresh;
      delete item.accountId;
      delete item.account_id;
      delete item.workspaceId;
      delete item.workspace_id;

      if (!item.accessToken || typeof item.accessToken !== "string") {
        throw new Error("Missing accessToken");
      }
      item.accessToken = item.accessToken.trim();
      if (!item.accessToken) throw new Error("Missing accessToken");
      if (typeof item.refreshToken === "string") item.refreshToken = item.refreshToken.trim() || null;
      if (typeof item.idToken === "string") item.idToken = item.idToken.trim() || null;

      // Backfill missing identity fields from JWT claims
      const psd = item.providerSpecificData && typeof item.providerSpecificData === "object"
        && !Array.isArray(item.providerSpecificData)
        ? { ...item.providerSpecificData }
        : {};
      // Credentials belong in the dedicated top-level columns.  Do not copy
      // token-shaped fields into providerSpecificData, where they could be
      // accidentally exposed by a provider metadata response.
      for (const sensitiveField of [
        "accessToken", "refreshToken", "idToken", "apiKey",
        "access_token", "refresh_token", "id_token", "tokens",
      ]) {
        delete psd[sensitiveField];
      }
      delete psd.usageOnly;
      if (!psd.chatgptAccountId && importedAccountId) {
        psd.chatgptAccountId = String(importedAccountId).trim();
      }
      const needsEmail = !item.email;
      const needsAccountId = !psd.chatgptAccountId;
      const needsPlanType = !psd.chatgptPlanType;

      if (needsEmail || needsAccountId || needsPlanType) {
        const info = extractCodexAccountInfo(item.idToken || item.accessToken) || {};
        if (needsEmail && info.email) item.email = info.email;
        if (needsAccountId && info.chatgptAccountId) {
          psd.chatgptAccountId = info.chatgptAccountId;
        }
        if (needsPlanType && info.chatgptPlanType) {
          psd.chatgptPlanType = info.chatgptPlanType;
        }
      }
      if (Object.keys(psd).length > 0) {
        item.providerSpecificData = psd;
      } else {
        delete item.providerSpecificData;
      }

      // OpenAI Platform API keys and ChatGPT OAuth tokens are different
      // credentials. An imported Codex account under `openai` is deliberately
      // quota-only: it can query WHAM usage, but must never enter model routing.
      if (targetProvider === "openai") {
        item.providerSpecificData = {
          ...(item.providerSpecificData || {}),
          authMethod: "codex_oauth",
          usageOnly: true,
        };
        item.isActive = false;
      }

      // Compute expiresAt from expiresIn if absent
      if (!item.expiresAt && typeof item.expiresIn === "number" && item.expiresIn > 0) {
        item.expiresAt = new Date(Date.now() + item.expiresIn * 1000).toISOString();
      }

      // Defaults aligned with OAuth-completed flow
      if (item.testStatus === undefined) item.testStatus = "active";
      if (item.isActive === undefined) item.isActive = true;
      if (!item.lastRefreshAt) item.lastRefreshAt = new Date().toISOString();

      const authType = targetProvider === "openai" && !item.refreshToken
        ? "access_token"
        : "oauth";
      // Keep provider/authType server-controlled even if a future input
      // normalization step adds those keys back to `item`.
      const created = await createProviderConnection({
        ...item,
        provider: targetProvider,
        authType,
      });

      results.push({ index: i, ok: true, id: created.id });
      success++;
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message || "Unknown error" });
      failed++;
    }
  }

  return NextResponse.json({ success, failed, results });
}
