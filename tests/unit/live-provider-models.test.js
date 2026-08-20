import { describe, expect, it, vi } from "vitest";
import {
  fetchLiveProviderModels,
  getLiveModelCatalogTargets,
  mergeLiveProviderModels,
  serializeLiveModelCatalogTargets,
} from "@/shared/utils/liveProviderModels.js";

describe("live provider model catalogs", () => {
  it("targets unique active Cursor and Antigravity connections only", () => {
    const activeAntigravity = { id: "ag-active", provider: "antigravity" };
    const activeCursor = { id: "cursor-active", provider: "cursor", isActive: true };

    expect(getLiveModelCatalogTargets([
      activeAntigravity,
      activeAntigravity,
      { ...activeAntigravity },
      activeCursor,
      { id: "ag-disabled", provider: "antigravity", isActive: false },
      { provider: "antigravity" },
      { id: "gemini-active", provider: "gemini" },
      null,
    ])).toEqual([activeAntigravity, activeCursor]);
  });

  it("keeps the request dependency stable for equivalent connection arrays", () => {
    const first = [
      { id: "cursor-active", provider: "cursor", name: "Cursor A" },
      { id: "ag-active", provider: "antigravity", priority: 1 },
    ];
    const rebuiltAndReordered = [
      { id: "ag-active", provider: "antigravity", priority: 99 },
      { id: "cursor-active", provider: "cursor", name: "Cursor renamed" },
    ];

    expect(serializeLiveModelCatalogTargets(first))
      .toBe(serializeLiveModelCatalogTargets(rebuiltAndReordered));
  });

  it("unions all successful Antigravity accounts despite partial failures and dedupes IDs", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url, options) => {
      expect(options).toMatchObject({ cache: "no-store" });
      expect(options.signal).toBe(controller.signal);

      if (url === "/api/providers/ag-primary/models") {
        return {
          ok: true,
          json: async () => ({
            models: [
              { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
              { id: "shared-model", name: "Shared on primary", primaryOnly: true },
              { name: "missing-id" },
            ],
          }),
        };
      }
      if (url === "/api/providers/ag-secondary/models") {
        return {
          ok: true,
          json: async () => ({
            models: [
              { id: "shared-model", name: "Shared on secondary", secondaryOnly: true },
              { id: "secondary-only" },
            ],
          }),
        };
      }
      if (url === "/api/providers/ag-http-error/models") {
        return { ok: false, json: vi.fn() };
      }
      if (url === "/api/providers/ag-network-error/models") {
        throw new Error("network unavailable");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const catalogs = await fetchLiveProviderModels([
      { id: "ag-primary", provider: "antigravity" },
      { id: "ag-secondary", provider: "antigravity", isActive: true },
      { id: "ag-http-error", provider: "antigravity" },
      { id: "ag-network-error", provider: "antigravity" },
      { id: "ag-disabled", provider: "antigravity", isActive: false },
      { provider: "antigravity" },
    ], { fetchImpl, signal: controller.signal });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(catalogs.antigravity.map((model) => model.id)).toEqual([
      "gemini-3.1-flash-lite",
      "shared-model",
      "secondary-only",
    ]);
    expect(catalogs.antigravity.filter((model) => model.id === "shared-model")).toHaveLength(1);
    expect(catalogs.antigravity.find((model) => model.id === "shared-model")).toMatchObject({
      name: "Shared on secondary",
      primaryOnly: true,
      secondaryOnly: true,
    });
    expect(catalogs.antigravity.find((model) => model.id === "secondary-only")?.name)
      .toBe("secondary-only");
  });

  it("keeps Antigravity static models and appends live-only discoveries", () => {
    const staticModels = [
      { id: "static-only", name: "Static only", upstreamModelId: "static-only-route" },
      { id: "shared-model", name: "Static shared", upstreamModelId: "static-route", kind: "llm" },
    ];
    const liveModelsByProvider = {
      antigravity: [
        {
          id: "shared-model",
          name: "Discovered shared",
          upstreamModelId: "discovered-route",
          availableAccountCount: 2,
        },
        { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
      ],
    };

    const models = mergeLiveProviderModels("antigravity", staticModels, liveModelsByProvider);

    expect(models.map((model) => model.id)).toEqual([
      "static-only",
      "shared-model",
      "gemini-3.1-flash-lite",
    ]);
    expect(models.find((model) => model.id === "shared-model")).toMatchObject({
      name: "Discovered shared",
      upstreamModelId: "static-route",
      kind: "llm",
      availableAccountCount: 2,
    });
  });

  it("uses Cursor live models as an authoritative replacement", () => {
    const staticModels = [{ id: "cursor-static", name: "Cursor static" }];
    const cursorLiveModels = [{ id: "cursor-live", name: "Cursor live" }];

    expect(mergeLiveProviderModels("cursor", staticModels, {
      cursor: cursorLiveModels,
    })).toEqual(cursorLiveModels);
    expect(mergeLiveProviderModels("cursor", staticModels, { cursor: [] })).toEqual(staticModels);
    expect(mergeLiveProviderModels("cursor", staticModels)).toEqual(staticModels);
  });
});
