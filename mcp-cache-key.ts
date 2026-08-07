import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export const MCP_CACHE_KEY_VERSION = 2;

export interface McpCacheIdentity {
  namespace: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export function normalizeMcpCacheArguments(
  argumentsValue: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = normalizeJsonValue(argumentsValue, new WeakSet<object>()) as Record<string, unknown>;
  const nodeId = normalized.nodeId;
  if (nodeId !== undefined && typeof nodeId !== "string") {
    throw new Error("nodeId must be a string in canonical 123:456 form");
  }
  if (typeof nodeId === "string") normalized.nodeId = normalizeNodeId(nodeId);
  return normalized;
}

export function normalizeNodeId(value: string): string {
  const trimmed = value.trim();
  if (/%3a/i.test(trimmed)) {
    throw new Error("nodeId must not be URL-encoded; use the canonical 123:456 form");
  }
  const match = /^(\d+)[:-](\d+)$/.exec(trimmed);
  return match ? `${match[1]}:${match[2]}` : trimmed;
}

export function computeMcpResultCacheKeyV2(identity: McpCacheIdentity): string {
  const normalizedArguments = normalizeMcpCacheArguments(identity.arguments);
  const serialized = canonicalizeOrThrow({
    version: MCP_CACHE_KEY_VERSION,
    namespace: identity.namespace.trim(),
    server: identity.serverName,
    tool: identity.toolName,
    arguments: normalizedArguments,
  });
  return sha256(serialized);
}

/** Legacy key retained only for v1 pointer lookup and lazy migration. */
export function computeMcpResultCacheKeyV1(identity: McpCacheIdentity): string {
  return sha256(legacyCanonicalJson({
    namespace: identity.namespace,
    server: identity.serverName,
    tool: identity.toolName,
    arguments: identity.arguments,
  }));
}

export function canonicalizeMcpArguments(value: Record<string, unknown>): string {
  return canonicalizeOrThrow(normalizeMcpCacheArguments(value));
}

function normalizeJsonValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MCP cache arguments must contain only finite JSON numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("MCP cache arguments must not contain cycles");
    seen.add(value);
    const result = value.map((item) => normalizeJsonValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("MCP cache arguments must contain only plain JSON objects");
    }
    if (seen.has(value)) throw new Error("MCP cache arguments must not contain cycles");
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new Error(`MCP cache argument ${key} is not JSON-serializable`);
      }
      result[key] = normalizeJsonValue(item, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new Error("MCP cache arguments must be JSON-serializable");
}

function canonicalizeOrThrow(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) throw new Error("MCP cache value could not be canonicalized");
  return result;
}

function legacyCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${legacyCanonicalJson(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Legacy MCP cache key value is not JSON-serializable");
  return serialized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
