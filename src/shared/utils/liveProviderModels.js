const LIVE_CATALOG_STRATEGIES = Object.freeze({
  cursor: "replace",
  antigravity: "merge",
});

/**
 * Return active, unique connections for providers whose usable model catalog is
 * account-specific. Keeping this list in one place prevents selectors from
 * silently falling back to a stale static registry when a provider adds models.
 */
export function getLiveModelCatalogTargets(connections = []) {
  const seen = new Set();

  return connections.filter((connection) => {
    if (!connection?.id || connection.isActive === false) return false;
    if (!LIVE_CATALOG_STRATEGIES[connection.provider]) return false;

    const key = `${connection.provider}:${connection.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Serialize only the fields that affect live-catalog requests. The stable,
 * sorted value is safe to use as a React effect dependency even when callers
 * rebuild an equivalent connections array on every render.
 */
export function serializeLiveModelCatalogTargets(connections = []) {
  const targets = getLiveModelCatalogTargets(connections)
    .map(({ provider, id }) => ({ provider, id }))
    .sort((a, b) => (
      a.provider.localeCompare(b.provider) || String(a.id).localeCompare(String(b.id))
    ));

  return JSON.stringify(targets);
}

/**
 * Fetch live catalogs for every eligible connection and group them by provider.
 * Individual account failures are ignored so another account (or the static
 * registry) can still populate the selector.
 */
export async function fetchLiveProviderModels(
  connections = [],
  { fetchImpl = globalThis.fetch, signal } = {},
) {
  if (typeof fetchImpl !== "function") return {};

  const targets = getLiveModelCatalogTargets(connections);
  const results = await Promise.all(targets.map(async (connection) => {
    try {
      const response = await fetchImpl(
        `/api/providers/${encodeURIComponent(connection.id)}/models`,
        { cache: "no-store", ...(signal ? { signal } : {}) },
      );
      if (!response?.ok) return null;

      const data = await response.json();
      if (!Array.isArray(data?.models)) return null;
      return { provider: connection.provider, models: data.models };
    } catch {
      return null;
    }
  }));

  const byProvider = new Map();
  for (const result of results) {
    if (!result) continue;
    if (!byProvider.has(result.provider)) byProvider.set(result.provider, new Map());

    const byId = byProvider.get(result.provider);
    for (const model of result.models) {
      if (!model?.id) continue;
      const existing = byId.get(model.id);
      byId.set(model.id, {
        ...(existing || {}),
        ...model,
        name: model.name || existing?.name || model.id,
      });
    }
  }

  return Object.fromEntries(
    [...byProvider].map(([provider, models]) => [provider, [...models.values()]]),
  );
}

function normalizeModelName(name) {
  return typeof name === "string"
    ? name.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

/**
 * Preserve distinct model routes that share a display name, but flag them so
 * selectors can show the route ID as a disambiguating secondary label.
 */
export function markDuplicateModelNames(models = []) {
  const idsByName = new Map();

  for (const model of models) {
    const normalizedName = normalizeModelName(model?.name);
    if (!normalizedName || !model?.id) continue;

    if (!idsByName.has(normalizedName)) idsByName.set(normalizedName, new Set());
    idsByName.get(normalizedName).add(String(model.id));
  }

  return models.map((model) => {
    const normalizedName = normalizeModelName(model?.name);
    const showModelId = (idsByName.get(normalizedName)?.size || 0) > 1;

    if (showModelId) return { ...model, showModelId: true };
    if (!model?.showModelId) return model;

    const { showModelId: _staleFlag, ...rest } = model;
    return rest;
  });
}

function finalizeProviderModels(providerId, models) {
  return providerId === "antigravity" ? markDuplicateModelNames(models) : models;
}

/**
 * Resolve the catalog displayed by a model selector.
 *
 * Cursor's live catalog is authoritative for the account. Antigravity keeps the
 * static catalog as a fallback and appends account-discovered models, matching
 * the provider detail page behavior.
 */
export function mergeLiveProviderModels(providerId, staticModels = [], liveModelsByProvider = {}) {
  const liveModels = liveModelsByProvider[providerId];
  if (!Array.isArray(liveModels) || liveModels.length === 0) {
    return finalizeProviderModels(providerId, staticModels);
  }

  if (LIVE_CATALOG_STRATEGIES[providerId] === "replace") return liveModels;
  if (LIVE_CATALOG_STRATEGIES[providerId] !== "merge") return staticModels;

  const remainingLive = new Map(liveModels.map((model) => [model.id, model]));
  const mergedStatic = staticModels.map((staticModel) => {
    const liveModel = remainingLive.get(staticModel.id);
    if (!liveModel) return staticModel;

    remainingLive.delete(staticModel.id);
    return {
      ...liveModel,
      ...staticModel,
      name: liveModel.name || staticModel.name,
    };
  });

  return finalizeProviderModels(providerId, [...mergedStatic, ...remainingLive.values()]);
}
