/**
 * Identity helpers for ChatGPT/Codex quota credentials stored under OpenAI.
 *
 * A Platform API key is not interchangeable with a ChatGPT OAuth token.  The
 * `usageOnly` marker is written by the server's Codex import flow and is kept
 * as a routing boundary; `authMethod` is accepted as a compatibility marker
 * for records created by an earlier version of the importer.
 */
export function isOpenAICodexQuotaConnection(connection) {
  if (!connection || connection.provider !== "openai") return false;
  const providerSpecificData = connection.providerSpecificData || {};
  return providerSpecificData.usageOnly === true
    || normalizeAuthMarker(providerSpecificData.authMethod) === "codex_oauth";
}

export function isCodexQuotaConnection(connection) {
  return connection?.provider === "codex" || isOpenAICodexQuotaConnection(connection);
}

/**
 * OpenAI normally stores Platform credentials as `apikey`.  OAuth/access-token
 * rows are therefore only safe to use when they carry the explicit Codex
 * provenance marker; this helper lets non-quota routes fail closed for legacy
 * or malformed rows that lack it.
 */
export function isUnmarkedOpenAIOAuthConnection(connection) {
  if (!connection || connection.provider !== "openai") return false;
  const providerSpecificData = connection.providerSpecificData || {};
  const authType = normalizeAuthMarker(connection.authType);
  const authMethod = normalizeAuthMarker(providerSpecificData.authMethod);

  // Older imports used `authMethod: access_token` (and some rows have an
  // `authKind: oauth` marker) without a dedicated Codex marker. Treat these as
  // untrusted OAuth credentials and fail closed. In particular, do not let a
  // stale API key field make us prefer/send the accompanying access token.
  const legacyOAuthMarker = [authMethod, normalizeAuthMarker(providerSpecificData.authKind)]
    .some((marker) => ["oauth", "oauth2", "oauth_token", "access_token", "access-token", "openai_oauth"].includes(marker));
  const hasAccessToken = typeof connection.accessToken === "string" && connection.accessToken.trim() !== "";
  const looksLikeOAuth = ["oauth", "oauth2", "oauth_token", "access_token", "access-token"].includes(authType)
    || legacyOAuthMarker
    || hasAccessToken;
  return looksLikeOAuth && !isOpenAICodexQuotaConnection(connection);
}

function normalizeAuthMarker(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}
