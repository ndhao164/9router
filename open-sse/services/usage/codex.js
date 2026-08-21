/**
 * Codex (OpenAI) usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { U, fetchWithTimeout, parseResetTime, toFiniteNumber } from "./shared.js";

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: U("codex").url,
  resetCreditsUrl: U("codex").resetCreditsUrl,
  resetCreditsConsumeUrl: U("codex").resetCreditsConsumeUrl,
  usageHeaders: U("codex").headers || {},
  usageTimeoutMs: U("codex").timeoutMs || 20000,
};

function toIsoDate(value) {
  if (!value) return null;
  const date = value instanceof Date
    ? value
    : new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
}

function getResetCreditsPayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { root: {}, nested: {} };
  }
  const nested = data.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data
    : {};
  return { root: data, nested };
}

function getResetCreditStatus(credit) {
  const value = credit?.status ?? credit?.state;
  return typeof value === "string" ? value.trim().toLowerCase() : "available";
}

function isAvailableResetCredit(credit) {
  if (!credit || typeof credit !== "object" || Array.isArray(credit)) return false;
  const status = getResetCreditStatus(credit);
  if (["redeemed", "used", "consumed", "expired"].includes(status)) return false;

  const expiresAt = toIsoDate(credit?.expires_at ?? credit?.expire_at ?? credit?.expiresAt);
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return false;
  return true;
}

function parseResetCreditCount(value) {
  const count = toFiniteNumber(value, Number.NaN);
  return Number.isFinite(count) ? Math.max(0, count) : null;
}

function toOptionalFiniteNumber(value) {
  const number = toFiniteNumber(value, Number.NaN);
  return Number.isFinite(number) ? number : null;
}

function toOptionalString(value) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function toOptionalBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1") return true;
  if (value === 0 || value === "0") return false;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (base64.length % 4)) % 4;
    return JSON.parse(Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function normalizeAccountId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPlatformApiKey(token) {
  return typeof token === "string" && /^sk[-_]/i.test(token.trim());
}

function getCodexAccountId(providerSpecificData, accessToken = null) {
  const stored = normalizeAccountId(
    providerSpecificData?.workspaceId ||
    providerSpecificData?.accountId ||
    providerSpecificData?.chatgptAccountId,
  );
  if (stored) return stored;

  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.["https://api.openai.com/auth"] || {};
  return normalizeAccountId(
    payload?.["https://api.openai.com/auth.chatgpt_account_id"] ||
    payload?.["https://api.openai.com/auth.account_id"] ||
    auth.chatgpt_account_id ||
    auth.account_id ||
    payload?.chatgpt_account_id ||
    payload?.account_id,
  );
}

function getCodexRateLimitBody(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  return snapshot.rate_limit && typeof snapshot.rate_limit === "object"
    ? snapshot.rate_limit
    : snapshot;
}

function getCodexResetAt(window, nowMs = Date.now()) {
  const absolute =
    window?.reset_at ?? window?.resets_at ?? window?.resetAt ?? window?.resetsAt;
  if (absolute !== undefined && absolute !== null && absolute !== "") {
    const parsed = parseResetTime(absolute);
    if (parsed) return parsed;
  }

  const resetAfterSeconds = toFiniteNumber(
    window?.reset_after_seconds ?? window?.resetAfterSeconds,
    Number.NaN,
  );
  if (!Number.isFinite(resetAfterSeconds) || resetAfterSeconds < 0) return null;
  return new Date(nowMs + resetAfterSeconds * 1000).toISOString();
}

/**
 * Codex Business/Enterprise accounts may receive an additional monthly credit
 * allowance in the WHAM usage payload. Keep this separate from
 * `rate_limit_reset_credits`: the former is a spend balance, while the latter
 * is a count of one-shot 5-hour-window resets.
 */
function getCodexMonthlyCredits(payload) {
  const spendControl = asRecord(payload?.spend_control ?? payload?.spendControl);
  const individualLimit = asRecord(
    spendControl?.individual_limit ?? spendControl?.individualLimit,
  );

  if (individualLimit) {
    const total = toOptionalFiniteNumber(individualLimit.limit ?? individualLimit.total);
    const used = toOptionalFiniteNumber(individualLimit.used);
    const explicitRemaining = toOptionalFiniteNumber(individualLimit.remaining);
    const remaining = explicitRemaining
      ?? (total !== null && used !== null ? Math.max(0, total - used) : null);
    const explicitRemainingPercentage = toOptionalFiniteNumber(
      individualLimit.remaining_percent ?? individualLimit.remainingPercent,
    );
    const remainingPercentage = explicitRemainingPercentage
      ?? (total !== null && total > 0 && remaining !== null
        ? Math.round((remaining / total) * 100)
        : null);

    if (
      total !== null
      || used !== null
      || remaining !== null
      || remainingPercentage !== null
    ) {
      return {
        ...(used !== null ? { used } : {}),
        ...(total !== null ? { total } : {}),
        ...(remaining !== null ? { remaining } : {}),
        ...(remainingPercentage !== null
          ? { remainingPercentage: Math.max(0, Math.min(100, Math.round(remainingPercentage))) }
          : {}),
        resetAt: getCodexResetAt(individualLimit),
      };
    }
  }

  // Compatibility with older WHAM responses that exposed only a balance.
  const credits = asRecord(payload?.credits);
  if (!credits) return null;
  const unlimited = toOptionalBoolean(credits.unlimited) ?? false;
  const balance = toOptionalString(credits.balance);
  const remaining = toOptionalFiniteNumber(credits.remaining ?? credits.balance);
  if (!unlimited && balance === null && remaining === null) return null;

  return {
    ...(balance !== null ? { balance } : {}),
    ...(remaining !== null ? { remaining } : {}),
    unlimited,
    resetAt: getCodexResetAt(credits),
  };
}

function getCodexWindowMinutes(window) {
  const seconds = toFiniteNumber(
    window?.limit_window_seconds ?? window?.limitWindowSeconds,
    Number.NaN,
  );
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null;
}

function formatCodexWindow(window) {
  const used = toFiniteNumber(window?.used_percent ?? window?.percent_used, Number.NaN);
  // WHAM can return a partially populated window while a new limit is being
  // initialized.  Skip that bucket instead of failing the entire quota fetch.
  if (!Number.isFinite(used)) return null;

  const normalizedUsed = Math.max(0, Math.min(100, used));
  return {
    used: normalizedUsed,
    total: 100,
    remaining: 100 - normalizedUsed,
    resetAt: getCodexResetAt(window),
    windowMinutes: getCodexWindowMinutes(window),
    unlimited: false,
  };
}

function appendCodexQuotaWindows(quotas, prefix, snapshot) {
  const rateLimit = getCodexRateLimitBody(snapshot);
  if (!rateLimit) return false;

  const primary = rateLimit.primary_window || rateLimit.primary || snapshot.primary_window || snapshot.primary;
  const secondary = rateLimit.secondary_window || rateLimit.secondary || snapshot.secondary_window || snapshot.secondary;
  let added = false;

  if (primary) {
    const formatted = formatCodexWindow(primary);
    if (formatted) {
      quotas[prefix ? `${prefix}_session` : "session"] = formatted;
      added = true;
    }
  }
  if (secondary) {
    const formatted = formatCodexWindow(secondary);
    if (formatted) {
      quotas[prefix ? `${prefix}_weekly` : "weekly"] = formatted;
      added = true;
    }
  }

  return added;
}

function getCodexReviewRateLimit(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.code_review_rate_limit || data.review_rate_limit) {
    return data.code_review_rate_limit || data.review_rate_limit;
  }

  const byLimitId = data.rate_limits_by_limit_id;
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    return byLimitId.code_review || byLimitId.codex_review || byLimitId.review || null;
  }

  const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
  return additional.find((entry) => {
    const id = String(entry?.limit_name || entry?.metered_feature || entry?.id || "").toLowerCase();
    return id === "code_review" || id === "codex_review" || id === "review" || id.includes("review");
  }) || null;
}

function buildCodexUsageHeaders(accessToken, providerSpecificData) {
  const headers = {
    ...CODEX_CONFIG.usageHeaders,
    "Authorization": `Bearer ${accessToken}`,
  };
  const accountId = getCodexAccountId(providerSpecificData, accessToken);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

export async function getCodexUsage(accessToken, proxyOptions = null, providerSpecificData = null) {
  if (!accessToken || typeof accessToken !== "string") {
    return { message: "Codex quota requires a ChatGPT OAuth access token. OpenAI Platform API keys are not supported." };
  }
  const token = accessToken.trim();
  if (!token || isPlatformApiKey(token)) {
    return { message: "Codex quota requires a ChatGPT OAuth access token. OpenAI Platform API keys are not supported." };
  }

  try {
    const response = await fetchWithTimeout(CODEX_CONFIG.usageUrl, {
      method: "GET",
      headers: buildCodexUsageHeaders(token, providerSpecificData),
    }, CODEX_CONFIG.usageTimeoutMs, proxyOptions);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { message: `Codex authentication expired or unauthorized (${response.status}). Please re-authorize the connection.` };
      }
      if (response.status === 429) {
        return { message: "Codex usage API is rate-limited (429). Please retry shortly." };
      }
      return { message: `Codex connected. Usage API temporarily unavailable (${response.status}).` };
    }

    const data = await response.json();
    const payload = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    const normalRateLimit = payload.rate_limit || payload.rate_limits || payload.rate_limits_by_limit_id?.codex || {};
    const reviewRateLimit = getCodexReviewRateLimit(payload);
    const availableResetCredits = Math.max(0, toFiniteNumber(payload.rate_limit_reset_credits?.available_count, 0));
    const monthlyCredits = getCodexMonthlyCredits(payload);
    const quotas = {};

    appendCodexQuotaWindows(quotas, "", normalRateLimit);
    appendCodexQuotaWindows(quotas, "review", reviewRateLimit);

    return {
      plan: payload.plan_type || payload.summary?.plan || "unknown",
      limitReached: getCodexRateLimitBody(normalRateLimit)?.limit_reached || false,
      reviewLimitReached: getCodexRateLimitBody(reviewRateLimit)?.limit_reached || false,
      resetCredits: { availableCount: availableResetCredits },
      ...(monthlyCredits ? { monthlyCredits } : {}),
      quotas,
    };
  } catch (error) {
    throw new Error(`Failed to fetch Codex usage: ${error.message}`);
  }
}

export async function getCodexRateLimitResetCredits(accessToken, proxyOptions = null, providerSpecificData = null) {
  if (!accessToken || isPlatformApiKey(accessToken)) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }

  const accountId = getCodexAccountId(providerSpecificData, accessToken);
  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "Accept": "application/json",
    "OpenAI-Beta": "codex-1",
    "originator": "codex_cli_rs",
  };
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;

  const response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsUrl, {
    method: "GET",
    headers,
  }, proxyOptions);

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.message || data?.error || data?.detail || `Codex reset credits API unavailable (${response.status}).`;
    throw new Error(message);
  }

  const { root, nested } = getResetCreditsPayload(data);
  // WHAM has returned both a flat payload and an envelope-shaped
  // `{ data: { available_count, credits } }` payload over time.  Prefer the
  // top-level values when present, then fall back to the nested object.
  const credits = Array.isArray(root.credits)
    ? root.credits
    : Array.isArray(nested.credits)
      ? nested.credits
      : [];
  const explicitAvailableCount = parseResetCreditCount(
    root.available_count
      ?? root.availableCount
      ?? nested.available_count
      ?? nested.availableCount,
  );
  // Older responses omitted available_count.  Derive it only from the
  // normalized credit list, excluding redeemed/used/expired entries.  An
  // explicit zero remains authoritative even when stale credit details are
  // still present in the response.
  const availableCount = explicitAvailableCount ?? credits.filter(isAvailableResetCredit).length;

  return {
    availableCount,
    credits: credits.map((credit) => ({
      status: String(credit?.status ?? credit?.state ?? "unknown"),
      grantedAt: toIsoDate(credit?.granted_at ?? credit?.grantedAt),
      expiresAt: toIsoDate(credit?.expires_at ?? credit?.expire_at ?? credit?.expiresAt),
    })),
  };
}

// Consume one Codex rate-limit reset credit (irreversible, spends 1 credit)
export async function consumeCodexRateLimitResetCredit(accessToken, redeemRequestId, proxyOptions = null) {
  if (!accessToken || isPlatformApiKey(accessToken)) {
    throw new Error("No Codex access token available. Please re-authorize the connection.");
  }
  if (!redeemRequestId || typeof redeemRequestId !== "string") {
    throw new Error("A redeem request id is required to consume a Codex reset credit.");
  }

  let response;
  let data = null;
  try {
    response = await proxyAwareFetch(CODEX_CONFIG.resetCreditsConsumeUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ redeem_request_id: redeemRequestId }),
    }, proxyOptions);

    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Failed to consume Codex reset credit: ${error.message}`);
  }

  const code = data?.code || null;
  const windowsReset = toFiniteNumber(data?.windows_reset, 0);
  const success = response.ok && (code === "reset" || windowsReset > 0);

  return {
    ok: success,
    noCredit: response.ok && code === "no_credit",
    status: response.status,
    code,
    windowsReset,
    message: data?.message || null,
    raw: data,
  };
}
