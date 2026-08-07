import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { abortable } from "./abort.ts";
import {
  computeMcpResultCacheKeyV2,
  normalizeMcpCacheArguments,
} from "./mcp-cache-key.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { readMcpResultCache, resolveMcpResultArchiveOptions } from "./mcp-result-archive.ts";
import { executeCall } from "./proxy-modes.ts";
import type { McpExtensionState } from "./state.ts";
import { findToolByName } from "./tool-metadata.ts";
import { resolveMcpResultContent } from "./tool-registrar.ts";
import { ensureToolCallApproved } from "./tool-approval.ts";
import { isServerDisabled, type McpReadCacheSettings } from "./types.ts";

export type McpCachePolicy = "prefer-cache" | "cache-only" | "refresh";

export interface McpCacheParams {
  server: string;
  tool: string;
  namespace: string;
  args: Record<string, unknown>;
  policy?: McpCachePolicy;
  maxAgeSeconds?: number;
}

type McpCacheExecute = (
  toolCallId: string,
  params: McpCacheParams,
  signal?: AbortSignal,
) => Promise<AgentToolResult<Record<string, unknown>>>;

const DEFAULT_MAX_AGE_SECONDS = 3600;
const DEFAULT_LIVE_TIMEOUT_MS = 60_000;

type SharedLiveCall = {
  promise: Promise<AgentToolResult<Record<string, unknown>>>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const liveCallsByState = new WeakMap<McpExtensionState, Map<string, SharedLiveCall>>();

export function createMcpCacheExecutor(
  getState: () => McpExtensionState | null,
  getInitPromise: () => Promise<McpExtensionState> | null,
): McpCacheExecute {
  return async function execute(_toolCallId, params, signal) {
    let state = getState();
    const initPromise = getInitPromise();
    if (!state && initPromise) {
      try {
        state = await initPromise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return cacheError("init_failed", `MCP initialization failed: ${message}`);
      }
    }
    if (!state) return cacheError("not_initialized", "MCP not initialized");

    const configured = resolveReadCacheSettings(state.config.settings?.resultCache);
    if (!configured.enabled) return cacheError("cache_disabled", "mcpCache is disabled. Enable settings.resultCache first.");

    const namespace = params.namespace?.trim();
    if (!namespace) return cacheError("namespace_required", "A stable namespace such as the Figma file key is required.");
    if (!params.server?.trim() || !params.tool?.trim()) return cacheError("invalid_request", "server and tool are required.");
    if (!params.args || typeof params.args !== "object" || Array.isArray(params.args)) {
      return cacheError("invalid_args", "args must be a JSON object.");
    }
    let normalizedArgs: Record<string, unknown>;
    try {
      normalizedArgs = normalizeMcpCacheArguments(params.args);
    } catch (error) {
      return cacheError("invalid_args", error instanceof Error ? error.message : String(error));
    }
    if (configured.requireNodeId && (typeof normalizedArgs.nodeId !== "string" || !normalizedArgs.nodeId.trim())) {
      return cacheError("node_id_required", "args.nodeId is required; dynamic current-selection calls are not cache-safe.");
    }

    const serverMetadata = state.toolMetadata.get(params.server);
    const metadata = findToolByName(serverMetadata, params.tool)
      ?? serverMetadata?.find((tool) => tool.originalName === params.tool);
    if (!metadata || metadata.resourceUri) return cacheError("tool_not_found", `MCP tool not found: ${params.server}/${params.tool}`);
    const identity = `${params.server}/${metadata.originalName}`;
    if (!configured.allowTools.includes(identity)) {
      return cacheError("tool_not_allowed", `${identity} is not listed in settings.resultCache.allowTools.`);
    }
    const definition = state.config.mcpServers[params.server];
    if (isServerDisabled(definition)) return cacheError("server_disabled", `MCP server "${params.server}" is disabled.`);
    const approval = await ensureToolCallApproved(
      state,
      params.server,
      metadata,
      normalizedArgs,
      signal,
      "proxy",
    );
    if (approval.ok === false) {
      return cacheError(
        approval.reason === "denied" ? "approval_denied" : "approval_required",
        approval.reason === "denied"
          ? `The user declined approval to use cached data for ${identity}.`
          : `Cached access to ${identity} requires an interactive approval.`,
      );
    }

    const policy = params.policy ?? "prefer-cache";
    if (!["prefer-cache", "cache-only", "refresh"].includes(policy)) {
      return cacheError("invalid_policy", `Unsupported cache policy: ${policy}`);
    }
    const maxAgeSeconds = positiveNumber(params.maxAgeSeconds) ?? configured.defaultMaxAgeSeconds;
    if (!resolveMcpResultArchiveOptions(state.config.settings, definition, params.server).enabled) {
      return cacheError("archive_disabled", "mcpCache requires settings.resultArchive to be enabled for this server.");
    }

    if (policy !== "refresh") {
      const cached = await readMcpResultCache({
        settings: state.config.settings,
        definition,
        namespace,
        serverName: params.server,
        toolName: metadata.originalName,
        arguments: params.args,
        maxAgeSeconds,
      });
      if (cached.hit) {
        const content = resolveMcpResultContent(cached.result);
        const guarded = await guardMcpOutput(
          content.length > 0 ? content : [{ type: "text" as const, text: "(empty cached result)" }],
          { ...resolveMcpOutputGuardOptions(state.config.settings), rawMcpResult: cached.result },
        );
        return {
          content: guarded.content,
          details: {
            mode: "cache",
            cache: "hit",
            cacheKey: cached.cacheKey,
            ageMs: cached.ageMs,
            entryPath: cached.entryPath,
            server: params.server,
            tool: metadata.originalName,
            ...guardedMcpDetails(guarded),
          },
        };
      }
      if (policy === "cache-only") {
        return cacheError("cache_miss", `No valid cached result for ${identity} (${cached.reason}).`, {
          cacheKey: cached.cacheKey,
          reason: cached.reason,
        });
      }
    }

    const cacheKey = computeMcpResultCacheKeyV2({
      namespace,
      serverName: params.server,
      toolName: metadata.originalName,
      arguments: normalizedArgs,
    });
    const live = await runLiveSingleflight(
      state,
      cacheKey,
      (sharedSignal) => executeCall(
        state!,
        metadata.name,
        normalizedArgs,
        params.server,
        undefined,
        sharedSignal,
        "proxy",
        namespace,
      ),
      signal,
      configured.liveTimeoutMs,
    );
    return {
      content: live.content,
      details: {
        ...live.details,
        cache: policy === "refresh" ? "refresh" : "miss",
        namespace,
      },
    };
  };
}

async function runLiveSingleflight(
  state: McpExtensionState,
  cacheKey: string,
  factory: (signal: AbortSignal) => Promise<AgentToolResult<Record<string, unknown>>>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<AgentToolResult<Record<string, unknown>>> {
  let calls = liveCallsByState.get(state);
  if (!calls) {
    calls = new Map();
    liveCallsByState.set(state, calls);
  }

  let shared = calls.get(cacheKey);
  if (!shared) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`MCP cache shared live call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    shared = {
      promise: factory(controller.signal),
      controller,
      waiters: 0,
      settled: false,
      timer,
    };
    calls.set(cacheKey, shared);
    const current = shared;
    void current.promise.finally(() => {
      current.settled = true;
      clearTimeout(current.timer);
      if (calls?.get(cacheKey) === current) calls.delete(cacheKey);
    }).catch(() => {});
  }

  shared.waiters += 1;
  try {
    return await (signal ? abortable(shared.promise, signal) : shared.promise);
  } finally {
    shared.waiters -= 1;
    if (shared.waiters === 0 && !shared.settled) {
      shared.controller.abort(new Error("All MCP cache singleflight waiters cancelled"));
    }
  }
}

function resolveReadCacheSettings(value: boolean | McpReadCacheSettings | undefined): Required<McpReadCacheSettings> {
  const settings = typeof value === "object" && value !== null ? value : {};
  return {
    enabled: value === true || (typeof value === "object" && value !== null && value.enabled !== false),
    allowTools: Array.isArray(settings.allowTools) ? settings.allowTools.filter((item): item is string => typeof item === "string") : [],
    defaultMaxAgeSeconds: positiveNumber(settings.defaultMaxAgeSeconds) ?? DEFAULT_MAX_AGE_SECONDS,
    requireNodeId: settings.requireNodeId !== false,
    liveTimeoutMs: positiveNumber(settings.liveTimeoutMs) ?? DEFAULT_LIVE_TIMEOUT_MS,
  };
}

function cacheError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    details: { mode: "cache", error: code, message, ...extra },
  };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
