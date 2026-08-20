"use client";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import {
  ReactFlow,
  Handle,
  Position,
  Controls,
  BaseEdge,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

// Force-stop FE animation if a provider stays active longer than this
const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;
const FIT_OPTIONS = { padding: 0.2, duration: 200 };

// Kame + electric particles along active edges
const KAME_PARTICLE_COUNT = 6;
const SPARK_COUNT = 5;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getProviderImageUrl(providerId) {
  return getProviderIconSrc(providerId);
}

// Custom provider node - rectangle with image + name
function ProviderNode({ data }) {
  const { label, color, imageUrl, textIcon, active } = data;
  const [imgError, setImgError] = useState(false);
  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2.5 rounded-lg border-2 transition-all duration-300 bg-bg"
      style={{
        borderColor: active ? color : "var(--color-border)",
        boxShadow: active ? `0 0 16px ${color}40` : "none",
        minWidth: "150px",
      }}
    >
      <Handle type="target" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      {/* Provider icon */}
      <div
        className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}15` }}
      >
        {imageUrl && !imgError ? (
          <img
            src={imageUrl}
            alt={label}
            className="w-6 h-6 rounded-sm object-contain"
            loading="lazy"
            decoding="async"
            onError={() => {
              const m = imageUrl?.match(/^\/providers\/([^/]+)\.png$/i);
              if (m) markProviderIconMissing(m[1]);
              setImgError(true);
            }}
          />
        ) : (
          <span className="text-sm font-bold" style={{ color }}>{textIcon}</span>
        )}
      </div>

      {/* Provider name */}
      <span
        className="text-base font-medium truncate"
        style={{ color: active ? color : "var(--color-text)" }}
      >
        {label}
      </span>

      {/* Active indicator */}
      {active && (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: color }} />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: color }} />
        </span>
      )}
    </div>
  );
}

ProviderNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// Combo nodes sit between 9Router and their member providers. Their different
// silhouette/color keeps routing rules visually separate from provider nodes.
function ComboNode({ data }) {
  const { label, modelCount = 0, providerCount = 0, active, last } = data;
  const color = active ? "#a78bfa" : last ? "#f59e0b" : "#8b5cf6";

  return (
    <div
      className="relative flex min-w-[165px] max-w-[190px] items-center gap-2.5 rounded-xl border-2 bg-bg px-3.5 py-2.5 transition-all duration-300"
      style={{
        borderColor: active || last ? color : "#8b5cf680",
        boxShadow: active ? `0 0 18px ${color}55` : "none",
      }}
      title={`${label}: ${modelCount} model${modelCount === 1 ? "" : "s"}, ${providerCount} provider${providerCount === 1 ? "" : "s"}`}
    >
      {Object.entries({ Top: Position.Top, Bottom: Position.Bottom, Left: Position.Left, Right: Position.Right }).flatMap(([side, position]) => [
        <Handle key={`target-${side}`} type="target" position={position} id={`target-${side.toLowerCase()}`} className="!h-0 !w-0 !border-0 !bg-transparent" />,
        <Handle key={`source-${side}`} type="source" position={position} id={`source-${side.toLowerCase()}`} className="!h-0 !w-0 !border-0 !bg-transparent" />,
      ])}

      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-500">
        <span className="material-symbols-outlined text-[19px]">layers</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold" style={{ color: active ? color : "var(--color-text)" }}>
          {label}
        </div>
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-violet-500/80">
          Combo · {modelCount} model{modelCount === 1 ? "" : "s"}
        </div>
      </div>
      {active && (
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-400" />
        </span>
      )}
    </div>
  );
}

ComboNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// Center 9Router node — pulse/glow on card only (no expanding rings)
function RouterNode({ data }) {
  const powering = (data.activeCount || 0) > 0;
  return (
    <div
      className={`relative z-[1] flex items-center justify-center px-5 py-3 rounded-xl border-2 min-w-[130px] ${
        powering
          ? "topology-router-core border-yellow-300 bg-gradient-to-br from-primary/30 via-yellow-400/20 to-cyan-400/25"
          : "border-primary bg-primary/5 shadow-md"
      }`}
    >
      <Handle type="source" position={Position.Top} id="top" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />

      <img
        src="/favicon.svg"
        alt="9Router"
        className={`w-6 h-6 mr-2 ${powering ? "topology-router-icon" : ""}`}
        loading="lazy"
        decoding="async"
      />
      <span className={`text-sm font-bold ${powering ? "topology-router-label text-yellow-300" : "text-primary"}`}>
        9Router
      </span>
      {data.activeCount > 0 && (
        <span className="ml-2 px-1.5 py-0.5 rounded-full bg-yellow-400 text-black text-xs font-bold topology-router-badge">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

RouterNode.propTypes = {
  data: PropTypes.object.isRequired,
};

// Active: electric kame beam (multi-layer stroke + sparks). Idle/last/error: solid BaseEdge.
function TopologyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
}) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const active = !!data?.active;
  const stroke = style.stroke || "var(--color-border)";
  const filterId = `topo-electric-${id}`;

  if (!active) {
    return <BaseEdge id={id} path={edgePath} style={{ ...style, stroke }} />;
  }

  return (
    <g className="topology-edge-electric">
      <defs>
        <filter id={filterId} x="-40%" y="-40%" width="180%" height="180%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="2" result="noise">
            <animate attributeName="baseFrequency" values="0.8;1.4;0.8" dur="0.25s" repeatCount="indefinite" />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      {/* Outer electric halo */}
      <path
        d={edgePath}
        fill="none"
        stroke="#22d3ee"
        strokeWidth={10}
        strokeOpacity={0.35}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-halo"
      />
      {/* Mid plasma */}
      <path
        d={edgePath}
        fill="none"
        stroke="#4ade80"
        strokeWidth={5}
        strokeOpacity={0.85}
        strokeLinecap="round"
        filter={`url(#${filterId})`}
        className="topology-edge-plasma"
      />
      {/* Hot white core */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: "#f8fafc", strokeWidth: 2.2, opacity: 1 }}
        className="topology-edge-kame"
      />
      {/* Energy orbs */}
      {Array.from({ length: KAME_PARTICLE_COUNT }, (_, i) => (
        <circle
          key={`${id}-p-${i}`}
          r={i % 2 === 0 ? 4 : 2.5}
          fill={i % 3 === 0 ? "#fde047" : i % 3 === 1 ? "#67e8f9" : "#fff"}
          opacity={0.95}
          style={{ filter: "drop-shadow(0 0 4px #22d3ee)" }}
        >
          <animateMotion
            dur={`${0.4 + i * 0.08}s`}
            repeatCount="indefinite"
            path={edgePath}
            begin={`${i * 0.09}s`}
          />
        </circle>
      ))}
      {/* Electric sparks (short-lived blink along path) */}
      {Array.from({ length: SPARK_COUNT }, (_, i) => (
        <circle
          key={`${id}-s-${i}`}
          r={1.8}
          fill="#e0f2fe"
          opacity={0}
        >
          <animate
            attributeName="opacity"
            values="0;1;0;0;1;0"
            dur={`${0.35 + (i % 3) * 0.1}s`}
            begin={`${i * 0.07}s`}
            repeatCount="indefinite"
          />
          <animateMotion
            dur={`${0.28 + i * 0.05}s`}
            repeatCount="indefinite"
            path={edgePath}
            begin={`${i * 0.11}s`}
          />
        </circle>
      ))}
    </g>
  );
}

TopologyEdge.propTypes = {
  id: PropTypes.string,
  sourceX: PropTypes.number,
  sourceY: PropTypes.number,
  targetX: PropTypes.number,
  targetY: PropTypes.number,
  sourcePosition: PropTypes.string,
  targetPosition: PropTypes.string,
  style: PropTypes.object,
  data: PropTypes.object,
};

const nodeTypes = { provider: ProviderNode, combo: ComboNode, router: RouterNode };
const edgeTypes = { topology: TopologyEdge };

function routeHandles(sourceCenter, targetCenter, sourcePrefix = "", targetPrefix = "") {
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  let sourceSide;
  let targetSide;

  if (Math.abs(dx) >= Math.abs(dy)) {
    sourceSide = dx >= 0 ? "right" : "left";
    targetSide = dx >= 0 ? "left" : "right";
  } else {
    sourceSide = dy >= 0 ? "bottom" : "top";
    targetSide = dy >= 0 ? "top" : "bottom";
  }

  return {
    sourceHandle: `${sourcePrefix}${sourceSide}`,
    targetHandle: `${targetPrefix}${targetSide}`,
  };
}

function edgeStyle(active, last, error, idleStroke = "var(--color-border)") {
  if (error) return { stroke: "#ef4444", strokeWidth: 2.5, opacity: 0.9 };
  if (active) return { stroke: "#22d3ee", strokeWidth: 3.5, opacity: 1 };
  if (last) return { stroke: "#f59e0b", strokeWidth: 2, opacity: 0.75 };
  return { stroke: idleStroke, strokeWidth: 1.2, opacity: idleStroke === "var(--color-border)" ? 0.3 : 0.32 };
}

function normalizeAngle(angle) {
  const full = Math.PI * 2;
  return ((angle % full) + full) % full;
}

// Providers occupy the outer ellipse; combos occupy an inner ellipse. This
// keeps the route legible as Router → Combo → Provider without losing direct
// Router → Provider paths for providers outside every combo.
function buildLayout(providers, combos, routeState) {
  const providerW = 180;
  const providerH = 54;
  const comboW = 180;
  const comboH = 58;
  const routerW = 130;
  const routerH = 48;
  const nodeGap = 28;
  const providerCount = providers.length;
  const comboCount = combos.length;

  const comboMinRx = ((comboW + nodeGap) * comboCount) / (2 * Math.PI);
  const innerRx = Math.max(190, comboMinRx);
  const innerRy = Math.max(112, innerRx * 0.58);
  const providerMinRx = ((providerW + nodeGap) * providerCount) / (2 * Math.PI);
  const outerRx = Math.max(comboCount ? innerRx + 230 : 320, providerMinRx);
  const outerRy = Math.max(comboCount ? innerRy + 145 : 200, outerRx * 0.55);
  const routerCenter = { x: 0, y: 0 };
  const nodes = [];
  const edges = [];
  const providerCenters = new Map();
  const providerAngles = new Map();

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: routeState.activeCombos.size + routeState.directActiveProviders.size },
    draggable: false,
  });

  providers.forEach((provider, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(providerCount, 1);
    const center = { x: outerRx * Math.cos(angle), y: outerRy * Math.sin(angle) };
    const providerKey = typeof provider.provider === "string" ? provider.provider.toLowerCase() : "";
    const config = getProviderConfig(provider.provider);
    const active = routeState.activeProviders.has(providerKey);

    providerCenters.set(provider.provider, center);
    providerAngles.set(provider.provider, angle);
    nodes.push({
      id: `provider-${provider.provider}`,
      type: "provider",
      position: { x: center.x - providerW / 2, y: center.y - providerH / 2 },
      data: {
        label: (config.name !== provider.provider ? config.name : null) || provider.nodeName || provider.name || provider.provider,
        color: config.color || "#6b7280",
        imageUrl: getProviderImageUrl(provider.provider),
        textIcon: config.textIcon || (provider.provider || "?").slice(0, 2).toUpperCase(),
        active,
      },
      draggable: false,
    });
  });

  const validProviderIds = new Set(providerCenters.keys());
  const representedProviderIds = new Set();
  const comboEntries = combos.map((combo) => {
    const providerIds = [...new Set(
      (Array.isArray(combo.providerIds) ? combo.providerIds : []).filter((id) => validProviderIds.has(id))
    )];
    providerIds.forEach((id) => representedProviderIds.add(id));

    const vectors = providerIds
      .map((id) => providerAngles.get(id))
      .filter((angle) => typeof angle === "number")
      .map((angle) => ({ x: Math.cos(angle), y: Math.sin(angle) }));
    const vector = vectors.reduce((sum, item) => ({ x: sum.x + item.x, y: sum.y + item.y }), { x: 0, y: 0 });
    const magnitude = Math.hypot(vector.x, vector.y);
    const preferredAngle = magnitude > 0.1 ? Math.atan2(vector.y, vector.x) : -Math.PI / 2;
    return { combo, providerIds, preferredAngle };
  });

  // Preserve the circular order of each combo's providers to reduce crossings.
  comboEntries.sort((a, b) => {
    // Layout slots also begin at the top (-π/2), so rotate before normalizing.
    const angleDiff = normalizeAngle(a.preferredAngle + Math.PI / 2) - normalizeAngle(b.preferredAngle + Math.PI / 2);
    return angleDiff || String(a.combo.name).localeCompare(String(b.combo.name));
  });

  const comboCenters = new Map();
  comboEntries.forEach((entry, index) => {
    const angle = comboCount === 1
      ? entry.preferredAngle
      : -Math.PI / 2 + (2 * Math.PI * index) / Math.max(comboCount, 1);
    const center = { x: innerRx * Math.cos(angle), y: innerRy * Math.sin(angle) };
    const active = routeState.activeCombos.has(entry.combo.name);
    const last = !active && routeState.lastCombo === entry.combo.name;
    const nodeId = `combo-${entry.combo.name}`;
    const handles = routeHandles(routerCenter, center, "", "target-");

    comboCenters.set(entry.combo.name, center);
    nodes.push({
      id: nodeId,
      type: "combo",
      position: { x: center.x - comboW / 2, y: center.y - comboH / 2 },
      data: {
        label: entry.combo.name,
        modelCount: Array.isArray(entry.combo.models) ? entry.combo.models.length : 0,
        providerCount: entry.providerIds.length,
        active,
        last,
      },
      draggable: false,
    });
    edges.push({
      id: `e-router-combo-${entry.combo.name}`,
      type: "topology",
      source: "router",
      sourceHandle: handles.sourceHandle,
      target: nodeId,
      targetHandle: handles.targetHandle,
      animated: false,
      data: { active },
      style: edgeStyle(active, last, false, "#8b5cf6"),
    });
  });

  comboEntries.forEach((entry) => {
    const comboCenter = comboCenters.get(entry.combo.name);
    for (const providerId of entry.providerIds) {
      const providerCenter = providerCenters.get(providerId);
      if (!comboCenter || !providerCenter) continue;
      const providerKey = typeof providerId === "string" ? providerId.toLowerCase() : "";
      const pairKey = `${entry.combo.name}\u0000${providerKey}`;
      const active = routeState.activeComboProviders.has(pairKey);
      const last = !active && routeState.lastCombo === entry.combo.name && routeState.lastProvider === providerKey;
      const error = !active && routeState.errorProviders.has(providerKey) && routeState.lastCombo === entry.combo.name;
      const handles = routeHandles(comboCenter, providerCenter, "source-", "");

      edges.push({
        id: `e-combo-${entry.combo.name}-provider-${providerId}`,
        type: "topology",
        source: `combo-${entry.combo.name}`,
        sourceHandle: handles.sourceHandle,
        target: `provider-${providerId}`,
        targetHandle: handles.targetHandle,
        animated: false,
        data: { active },
        style: edgeStyle(active, last, error, "#8b5cf6"),
      });
    }
  });

  // A provider represented by a combo normally uses only the two-hop path.
  // Temporarily retain its direct edge when live/recent direct traffic proves
  // that Router → Provider is also being used.
  providers.forEach((provider) => {
    const providerId = provider.provider;
    const providerKey = typeof providerId === "string" ? providerId.toLowerCase() : "";
    const active = routeState.directActiveProviders.has(providerKey);
    const last = !active && !routeState.lastCombo && routeState.lastProvider === providerKey;
    const error = !active && !routeState.lastCombo && routeState.errorProviders.has(providerKey);
    const needsDirectEdge = !representedProviderIds.has(providerId) || routeState.directActiveProviders.has(providerKey) || last || error;
    if (!needsDirectEdge) return;

    const providerCenter = providerCenters.get(providerId);
    const handles = routeHandles(routerCenter, providerCenter);
    edges.push({
      id: `e-router-provider-${providerId}`,
      type: "topology",
      source: "router",
      sourceHandle: handles.sourceHandle,
      target: `provider-${providerId}`,
      targetHandle: handles.targetHandle,
      animated: false,
      data: { active },
      style: edgeStyle(active, last, error),
    });
  });

  return { nodes, edges };
}

function getRequestCombo(request, comboNameSet) {
  const comboName = typeof request?.comboName === "string" ? request.comboName.trim() : "";
  if (comboName && comboNameSet.has(comboName)) return comboName;
  const requestedModel = typeof request?.requestedModel === "string" ? request.requestedModel.trim() : "";
  return requestedModel && comboNameSet.has(requestedModel) ? requestedModel : "";
}

function activityKey(type, ...parts) {
  return `${type}:${parts.join("\u0000")}`;
}

// Activity keys include a request-count suffix so a newly started request on a
// route that was previously expired gets a fresh animation window. Match by
// the stable route prefix when deriving graph state.
function hasActivity(activitySet, type, ...parts) {
  const base = activityKey(type, ...parts);
  for (const key of activitySet) {
    if (key === base || key.startsWith(`${base}\u0000`)) return true;
  }
  return false;
}

export default function ProviderTopology({
  providers = [],
  combos = [],
  activeRequests = [],
  lastProvider = "",
  lastCombo = "",
  errorProvider = "",
}) {
  const comboNameSet = useMemo(() => new Set(combos.map((combo) => combo.name).filter(Boolean)), [combos]);

  // Serialize route-level activity so unchanged SSE snapshots do not rebuild the
  // graph. Combo metadata is optional for compatibility with older snapshots.
  const rawActivityKey = useMemo(() => {
    const counts = new Map();
    for (const request of activeRequests) {
      const provider = typeof request?.provider === "string" ? request.provider.toLowerCase() : "";
      const combo = getRequestCombo(request, comboNameSet);
      const countValue = Number(request?.count);
      const count = Number.isFinite(countValue) && countValue > 0 ? countValue : 1;
      const addActivity = (type, ...parts) => {
        const key = activityKey(type, ...parts);
        counts.set(key, (counts.get(key) || 0) + count);
      };
      if (provider) addActivity("provider", provider);
      if (combo) {
        addActivity("combo", combo);
        if (provider) addActivity("combo-provider", combo, provider);
      } else if (provider) {
        addActivity("direct-provider", provider);
      }
    }
    return [...counts.entries()]
      .map(([key, count]) => `${key}\u0000${count}`)
      .sort()
      .join("|");
  }, [activeRequests, comboNameSet]);
  const rawActivitySet = useMemo(() => new Set(rawActivityKey ? rawActivityKey.split("|") : []), [rawActivityKey]);

  // Track firstSeen per active route; drop animations if a BE request gets stuck.
  const firstSeenRef = useRef({});
  const [expiredActivityKey, setExpiredActivityKey] = useState("");

  useEffect(() => {
    const seen = firstSeenRef.current;
    const now = Date.now();
    for (const key of rawActivitySet) {
      if (!seen[key]) seen[key] = now;
    }
    for (const key of Object.keys(seen)) {
      if (!rawActivitySet.has(key)) delete seen[key];
    }

    const refreshExpired = () => {
      const currentTime = Date.now();
      const expired = [...rawActivitySet]
        .filter((key) => currentTime - (seen[key] || currentTime) >= FE_ACTIVE_TIMEOUT_MS)
        .sort()
        .join("|");
      setExpiredActivityKey((previous) => previous === expired ? previous : expired);
    };
    // Run asynchronously so a reappearing route immediately loses stale expiry.
    const initialId = setTimeout(refreshExpired, 0);
    const intervalId = rawActivitySet.size > 0
      ? setInterval(refreshExpired, FE_ACTIVE_TICK_MS)
      : null;
    return () => {
      clearTimeout(initialId);
      if (intervalId) clearInterval(intervalId);
    };
  }, [rawActivitySet]);

  const expiredActivitySet = useMemo(
    () => new Set(expiredActivityKey ? expiredActivityKey.split("|") : []),
    [expiredActivityKey]
  );
  const activeActivitySet = useMemo(
    () => new Set([...rawActivitySet].filter((key) => !expiredActivitySet.has(key))),
    [rawActivitySet, expiredActivitySet]
  );

  const routeState = useMemo(() => {
    const activeProviders = new Set();
    const activeCombos = new Set();
    const activeComboProviders = new Set();
    const directActiveProviders = new Set();

    for (const provider of providers) {
      const providerKey = typeof provider.provider === "string" ? provider.provider.toLowerCase() : "";
      if (providerKey && hasActivity(activeActivitySet, "provider", providerKey)) {
        activeProviders.add(providerKey);
      }
      if (providerKey && hasActivity(activeActivitySet, "direct-provider", providerKey)) {
        directActiveProviders.add(providerKey);
      }
    }
    for (const combo of combos) {
      if (hasActivity(activeActivitySet, "combo", combo.name)) activeCombos.add(combo.name);
      for (const providerId of (Array.isArray(combo.providerIds) ? combo.providerIds : [])) {
        const providerKey = typeof providerId === "string" ? providerId.toLowerCase() : "";
        if (providerKey && hasActivity(activeActivitySet, "combo-provider", combo.name, providerKey)) {
          activeComboProviders.add(`${combo.name}\u0000${providerKey}`);
        }
      }
    }

    return {
      activeProviders,
      activeCombos,
      activeComboProviders,
      directActiveProviders,
      lastProvider: typeof lastProvider === "string" ? lastProvider.toLowerCase() : "",
      lastCombo: comboNameSet.has(lastCombo) ? lastCombo : "",
      errorProviders: new Set(typeof errorProvider === "string" && errorProvider ? [errorProvider.toLowerCase()] : []),
    };
  }, [providers, combos, activeActivitySet, lastProvider, lastCombo, errorProvider, comboNameSet]);

  const { nodes, edges } = useMemo(
    () => buildLayout(providers, combos, routeState),
    [providers, combos, routeState]
  );

  // Stable key — only remount when the topology catalog itself changes.
  const topologyKey = useMemo(
    () => [
      providers.map((provider) => provider.provider).sort().join(","),
      combos
        .map((combo) => `${combo.name}:${(combo.providerIds || []).slice().sort().join("+")}`)
        .sort()
        .join(","),
    ].join("|"),
    [providers, combos]
  );

  const rfInstance = useRef(null);
  const containerRef = useRef(null);
  const onInit = useCallback((instance) => {
    rfInstance.current = instance;
    setTimeout(() => instance.fitView(FIT_OPTIONS), 50);
  }, []);

  // Re-fit on container resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (rfInstance.current) rfInstance.current.fitView(FIT_OPTIONS);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-fit when node count/layout changes
  useEffect(() => {
    if (rfInstance.current) {
      const id = setTimeout(() => rfInstance.current.fitView(FIT_OPTIONS), 50);
      return () => clearTimeout(id);
    }
  }, [nodes.length]);

  return (
    <div ref={containerRef} className="h-[320px] w-full min-w-0 rounded-lg border border-border bg-bg-subtle/30 sm:h-[480px]">
      {providers.length === 0 && combos.length === 0 ? (
        <div className="h-full flex items-center justify-center text-text-muted text-sm">
          No providers or combos configured
        </div>
      ) : (
        <ReactFlow
          key={topologyKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={FIT_OPTIONS}
          minZoom={0.1}
          maxZoom={2}
          onInit={onInit}
          proOptions={{ hideAttribution: true }}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          zoomOnDoubleClick
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
        >
          <Controls showInteractive={false} className="react-flow-controls-custom" />
        </ReactFlow>
      )}
    </div>
  );
}

ProviderTopology.propTypes = {
  providers: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    provider: PropTypes.string,
    name: PropTypes.string,
  })),
  combos: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string.isRequired,
    models: PropTypes.arrayOf(PropTypes.string),
    providerIds: PropTypes.arrayOf(PropTypes.string),
  })),
  activeRequests: PropTypes.arrayOf(PropTypes.shape({
    provider: PropTypes.string,
    model: PropTypes.string,
    account: PropTypes.string,
    comboName: PropTypes.string,
    requestedModel: PropTypes.string,
  })),
  lastProvider: PropTypes.string,
  lastCombo: PropTypes.string,
  errorProvider: PropTypes.string,
};
