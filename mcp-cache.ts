import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
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
    if (configured.requireNodeId && (typeof params.args.nodeId !== "string" || !params.args.nodeId.trim())) {
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
      params.args,
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

    const live = await executeCall(
      state,
      metadata.name,
      params.args,
      params.server,
      undefined,
      signal,
      "proxy",
      namespace,
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

function resolveReadCacheSettings(value: boolean | McpReadCacheSettings | undefined): Required<McpReadCacheSettings> {
  const settings = typeof value === "object" && value !== null ? value : {};
  return {
    enabled: value === true || (typeof value === "object" && value !== null && value.enabled !== false),
    allowTools: Array.isArray(settings.allowTools) ? settings.allowTools.filter((item): item is string => typeof item === "string") : [],
    defaultMaxAgeSeconds: positiveNumber(settings.defaultMaxAgeSeconds) ?? DEFAULT_MAX_AGE_SECONDS,
    requireNodeId: settings.requireNodeId !== false,
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
