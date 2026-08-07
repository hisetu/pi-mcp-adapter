import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
import {
  canonicalizeMcpArguments,
  computeMcpResultCacheKeyV1,
  computeMcpResultCacheKeyV2,
  MCP_CACHE_KEY_VERSION,
  normalizeMcpCacheArguments,
} from "./mcp-cache-key.ts";
import type { McpResultArchiveSettings, McpSettings, ServerEntry } from "./types.ts";

export const MCP_RESULT_ARCHIVE_SCHEMA_VERSION = 1;
export const DEFAULT_MCP_RESULT_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MCP_RESULT_ARCHIVE_MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_ARCHIVE_WARNING_KEYS = 100;

export type McpResultArchiveOrigin = "direct" | "proxy" | "script";

export interface ResolvedMcpResultArchiveOptions {
  enabled: boolean;
  directory: string;
  maxBytes: number;
  maxArgumentBytes: number;
}

export interface ArchiveObjectRef {
  sha256: string;
  path: string;
  bytes: number;
  mediaType: string;
  encoding: "utf8" | "binary" | "base64" | "json";
}

export interface McpResultArchiveReceipt {
  entryPath: string;
  rawSha256: string;
  rawBytes: number;
  omitted: boolean;
}

export type McpResultCacheLookup =
  | { hit: true; cacheKey: string; entryPath: string; capturedAt: string; ageMs: number; result: Record<string, unknown> }
  | { hit: false; cacheKey: string; reason: "archive-disabled" | "miss" | "expired" | "invalid" };

export interface ReadMcpResultCacheInput {
  settings?: McpSettings | undefined;
  definition?: ServerEntry | undefined;
  namespace: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  maxAgeSeconds: number;
}

export interface PromoteMcpArchiveEntryInput {
  settings?: McpSettings | undefined;
  definition?: ServerEntry | undefined;
  serverName: string;
  entryId: string;
  namespace: string;
  apply: boolean;
}

export interface PromoteMcpArchiveEntryResult {
  applied: boolean;
  reason: "dry-run" | "applied" | "pointer-exists";
  entryId: string;
  entryPath: string;
  capturedAt: string;
  server: string;
  tool: string;
  nodeId?: string;
  namespace: string;
  cacheKey: string;
  ageMs: number;
}

export interface ArchiveMcpToolResultInput {
  settings?: McpSettings | undefined;
  definition?: ServerEntry | undefined;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  origin: McpResultArchiveOrigin;
  namespace?: string | undefined;
  result: unknown;
}

type Recordish = Record<string, unknown>;

type ArchivePointer = {
  version: number;
  cacheKey: string;
  cacheKeyVersion?: number;
  entryCacheKey?: string;
  timestamp: string;
  namespace: string;
  server: string;
  tool: string;
  entryPath: string;
};

const warnedArchiveErrors = new Set<string>();

export function resolveMcpResultArchiveDirectory(settings: McpSettings | undefined): string {
  const configured = settings?.resultArchive;
  const tuning = typeof configured === "object" && configured !== null ? configured : undefined;
  return resolveArchiveDirectory(process.env.MCP_RESULT_ARCHIVE_DIR?.trim() || tuning?.directory);
}

export function resolveMcpResultArchiveOptions(
  settings: McpSettings | undefined,
  definition: ServerEntry | undefined,
  serverName: string,
): ResolvedMcpResultArchiveOptions {
  const configured = settings?.resultArchive;
  const tuning = typeof configured === "object" && configured !== null ? configured : undefined;
  const envEnabled = envBoolean("MCP_RESULT_ARCHIVE");
  const globallyEnabled = typeof configured === "object"
    ? configured.enabled !== false
    : configured === true;
  const serverAllowed = !tuning?.servers?.length || tuning.servers.includes(serverName);
  const enabled = envEnabled ?? definition?.resultArchive ?? (globallyEnabled && serverAllowed);
  const directory = resolveMcpResultArchiveDirectory(settings);

  return {
    enabled,
    directory,
    maxBytes: positiveInteger(tuning?.maxBytes) ?? DEFAULT_MCP_RESULT_ARCHIVE_MAX_BYTES,
    maxArgumentBytes: positiveInteger(tuning?.maxArgumentBytes) ?? DEFAULT_MCP_RESULT_ARCHIVE_MAX_ARGUMENT_BYTES,
  };
}

export function computeMcpResultCacheKey(
  namespace: string,
  serverName: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): string {
  return computeMcpResultCacheKeyV2({ namespace, serverName, toolName, arguments: argumentsValue });
}

export async function readMcpResultCache(
  input: ReadMcpResultCacheInput,
): Promise<McpResultCacheLookup> {
  const options = resolveMcpResultArchiveOptions(input.settings, input.definition, input.serverName);
  const identity = {
    namespace: input.namespace,
    serverName: input.serverName,
    toolName: input.toolName,
    arguments: input.arguments,
  };
  const cacheKey = computeMcpResultCacheKeyV2(identity);
  if (!options.enabled) return { hit: false, cacheKey, reason: "archive-disabled" };

  const v2 = await readCacheKey(options.directory, input, cacheKey, MCP_CACHE_KEY_VERSION);
  if (v2.hit || v2.reason !== "miss") return v2;

  let legacyHit: Extract<McpResultCacheLookup, { hit: true }> | undefined;
  let legacyKey: string | undefined;
  let legacyCandidates: string[];
  try {
    legacyCandidates = legacyCacheKeys(identity);
  } catch {
    return v2;
  }
  for (const candidate of legacyCandidates) {
    if (candidate === cacheKey) continue;
    const legacy = await readCacheKey(options.directory, input, candidate, 1);
    if (legacy.hit) {
      legacyHit = legacy;
      legacyKey = candidate;
      break;
    }
    if (legacy.reason !== "miss") return { ...legacy, cacheKey };
  }
  if (!legacyHit || !legacyKey) return v2;

  const concurrentV2 = await readCacheKey(options.directory, input, cacheKey, MCP_CACHE_KEY_VERSION);
  if (concurrentV2.hit || concurrentV2.reason !== "miss") return concurrentV2;

  const migrated = await writeCachePointerIfAbsent(options.directory, cacheKey, {
    version: MCP_RESULT_ARCHIVE_SCHEMA_VERSION,
    cacheKey,
    cacheKeyVersion: MCP_CACHE_KEY_VERSION,
    entryCacheKey: legacyKey,
    timestamp: legacyHit.capturedAt,
    namespace: input.namespace,
    server: input.serverName,
    tool: input.toolName,
    entryPath: relative(options.directory, legacyHit.entryPath),
  });
  if (!migrated) {
    const winner = await readCacheKey(options.directory, input, cacheKey, MCP_CACHE_KEY_VERSION);
    if (winner.hit || winner.reason !== "miss") return winner;
  }
  return { ...legacyHit, cacheKey };
}

function legacyCacheKeys(identity: {
  namespace: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
}): string[] {
  const argumentCandidates: Record<string, unknown>[] = [identity.arguments];
  const normalized = normalizeMcpCacheArguments(identity.arguments);
  argumentCandidates.push(normalized);
  if (typeof normalized.nodeId === "string" && /^(\d+):(\d+)$/.test(normalized.nodeId)) {
    argumentCandidates.push({ ...normalized, nodeId: normalized.nodeId.replace(":", "-") });
  }
  return [...new Set(argumentCandidates.map((argumentsValue) => computeMcpResultCacheKeyV1({
    ...identity,
    arguments: argumentsValue,
  })))];
}

async function readCacheKey(
  root: string,
  input: ReadMcpResultCacheInput,
  cacheKey: string,
  expectedKeyVersion: number,
): Promise<McpResultCacheLookup> {
  try {
    const pointerPath = cachePointerPath(root, cacheKey);
    const pointer = JSON.parse((await readPrivateArchiveFile(root, pointerPath)).toString("utf8")) as ArchivePointer;
    const pointerKeyVersion = pointer.cacheKeyVersion ?? 1;
    if (
      pointer.version !== MCP_RESULT_ARCHIVE_SCHEMA_VERSION
      || pointer.cacheKey !== cacheKey
      || pointerKeyVersion !== expectedKeyVersion
      || pointer.namespace !== input.namespace
      || pointer.server !== input.serverName
      || pointer.tool !== input.toolName
    ) return { hit: false, cacheKey, reason: "invalid" };
    const ageMs = Date.now() - Date.parse(pointer.timestamp);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > input.maxAgeSeconds * 1000) {
      return { hit: false, cacheKey, reason: "expired" };
    }
    const entryPath = resolve(root, pointer.entryPath);
    if (!isWithinDirectory(root, entryPath)) return { hit: false, cacheKey, reason: "invalid" };
    const entry = JSON.parse((await readPrivateArchiveFile(root, entryPath)).toString("utf8")) as Recordish;
    const expectedEntryKey = pointer.entryCacheKey ?? cacheKey;
    if (
      entry.version !== MCP_RESULT_ARCHIVE_SCHEMA_VERSION
      || entry.cacheKey !== expectedEntryKey
      || entry.namespace !== input.namespace
      || entry.server !== input.serverName
      || entry.tool !== input.toolName
      || entry.timestamp !== pointer.timestamp
    ) return { hit: false, cacheKey, reason: "invalid" };
    const request = asRecord(entry.request);
    const archivedArguments = await readArchivedJson(root, request?.arguments);
    if (
      !asRecord(archivedArguments)
      || canonicalizeMcpArguments(archivedArguments as Record<string, unknown>) !== canonicalizeMcpArguments(input.arguments)
    ) return { hit: false, cacheKey, reason: "invalid" };
    const result = await reconstructArchivedResult(root, asRecord(entry.result));
    if (!result || result.isError === true) return { hit: false, cacheKey, reason: "invalid" };
    return { hit: true, cacheKey, entryPath, capturedAt: pointer.timestamp, ageMs, result };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hit: false, cacheKey, reason: "miss" };
    return { hit: false, cacheKey, reason: "invalid" };
  }
}

export async function promoteMcpArchiveEntry(
  input: PromoteMcpArchiveEntryInput,
): Promise<PromoteMcpArchiveEntryResult> {
  const options = resolveMcpResultArchiveOptions(input.settings, input.definition, input.serverName);
  if (!options.enabled) throw new Error("MCP result archive is disabled for this server");
  const namespace = input.namespace.trim();
  if (!namespace) throw new Error("A stable namespace is required for promotion");

  const matched = await findArchiveEntry(options.directory, input.serverName, input.entryId);
  const entry = matched.entry;
  if (
    entry.version !== MCP_RESULT_ARCHIVE_SCHEMA_VERSION
    || entry.server !== input.serverName
    || typeof entry.tool !== "string"
    || typeof entry.timestamp !== "string"
  ) throw new Error("Archive entry identity is invalid");
  const result = asRecord(entry.result);
  if (!result || result.status !== "archived" || result.isError === true) {
    throw new Error("Only complete successful archive entries can be promoted");
  }
  const request = asRecord(entry.request);
  if (!request?.arguments || request.argumentsOmitted === true) {
    throw new Error("Archive entry arguments are unavailable");
  }
  const archivedArguments = await readArchivedJson(options.directory, request.arguments);
  if (!asRecord(archivedArguments)) throw new Error("Archive entry arguments are invalid");
  const normalizedArguments = normalizeMcpCacheArguments(archivedArguments as Record<string, unknown>);
  const cacheKey = computeMcpResultCacheKeyV2({
    namespace,
    serverName: input.serverName,
    toolName: entry.tool,
    arguments: normalizedArguments,
  });
  const ageMs = Date.now() - Date.parse(entry.timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0) throw new Error("Archive entry timestamp is invalid");
  const preview: PromoteMcpArchiveEntryResult = {
    applied: false,
    reason: "dry-run",
    entryId: String(entry.id ?? input.entryId),
    entryPath: matched.path,
    capturedAt: entry.timestamp,
    server: input.serverName,
    tool: entry.tool,
    ...(typeof normalizedArguments.nodeId === "string" ? { nodeId: normalizedArguments.nodeId } : {}),
    namespace,
    cacheKey,
    ageMs,
  };
  if (!input.apply) return preview;
  try {
    await lstat(cachePointerPath(options.directory, cacheKey));
    return { ...preview, reason: "pointer-exists" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const promotedEntry = {
    ...entry,
    id: `${String(entry.id ?? input.entryId)}-promoted-${randomBytes(4).toString("hex")}`,
    origin: "promotion",
    namespace,
    cacheKey,
    cacheKeyVersion: MCP_CACHE_KEY_VERSION,
    promotion: {
      sourceEntryPath: relative(options.directory, matched.path),
      promotedAt: new Date().toISOString(),
    },
  };
  const promotedPath = await writeEntry(options.directory, input.serverName, entry.timestamp, promotedEntry);
  const published = await writeCachePointerIfAbsent(options.directory, cacheKey, {
    version: MCP_RESULT_ARCHIVE_SCHEMA_VERSION,
    cacheKey,
    cacheKeyVersion: MCP_CACHE_KEY_VERSION,
    entryCacheKey: cacheKey,
    timestamp: entry.timestamp,
    namespace,
    server: input.serverName,
    tool: entry.tool,
    entryPath: relative(options.directory, promotedPath),
  });
  if (!published) await unlink(promotedPath).catch(() => {});
  return {
    ...preview,
    entryPath: published ? promotedPath : matched.path,
    applied: published,
    reason: published ? "applied" : "pointer-exists",
  };
}

export async function archiveMcpToolResult(
  input: ArchiveMcpToolResultInput,
): Promise<McpResultArchiveReceipt | undefined> {
  const options = resolveMcpResultArchiveOptions(
    input.settings,
    input.definition,
    input.serverName,
  );
  if (!options.enabled) return undefined;
  if (process.platform === "win32") {
    throw new Error("Raw MCP result archiving currently requires POSIX private-file permissions and is not supported on Windows");
  }

  const raw = stringifyJson(input.result, "MCP result");
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const rawSha256 = sha256(Buffer.from(raw, "utf8"));
  const argumentsJson = stringifyJson(input.arguments, "MCP tool arguments");
  const argumentsBuffer = Buffer.from(argumentsJson, "utf8");
  const argumentsSha256 = sha256(argumentsBuffer);
  const argumentsBytes = argumentsBuffer.length;
  const timestamp = new Date().toISOString();
  const resultRecord = asRecord(input.result);
  const oversized = rawBytes > options.maxBytes;
  const namespace = input.namespace?.trim() || undefined;
  const cacheKey = namespace
    ? computeMcpResultCacheKey(namespace, input.serverName, input.toolName, input.arguments)
    : undefined;

  await ensurePrivateDirectory(options.directory);

  const argumentsObject = argumentsBytes <= options.maxArgumentBytes
    ? await writeObject(options.directory, argumentsBuffer, "application/json", "json")
    : undefined;
  const content = oversized
    ? []
    : await archiveContentBlocks(options.directory, resultRecord?.content);
  const structuredContent = oversized || resultRecord?.structuredContent === undefined
    ? undefined
    : await archiveJsonValue(options.directory, resultRecord.structuredContent);
  const meta = oversized || resultRecord?._meta === undefined
    ? undefined
    : await archiveJsonValue(options.directory, resultRecord._meta);
  const extra = oversized
    ? undefined
    : await archiveExtraFields(options.directory, resultRecord);

  const entry = {
    version: MCP_RESULT_ARCHIVE_SCHEMA_VERSION,
    id: `${timestamp}-${randomBytes(6).toString("hex")}`,
    timestamp,
    server: input.serverName,
    tool: input.toolName,
    origin: input.origin,
    ...(namespace ? { namespace, cacheKey, cacheKeyVersion: MCP_CACHE_KEY_VERSION } : {}),
    request: {
      argumentsSha256,
      argumentsBytes,
      ...(argumentsObject
        ? { arguments: argumentsObject }
        : { argumentsOmitted: true, reason: `Serialized MCP tool arguments exceeded the configured ${options.maxArgumentBytes}-byte archive limit.` }),
    },
    result: {
      status: oversized ? "omitted" : "archived",
      ...(oversized ? { reason: `Raw MCP result exceeded the configured ${options.maxBytes}-byte archive limit.` } : {}),
      isError: resultRecord?.isError === true,
      rawSha256,
      rawBytes,
      content,
      ...(structuredContent ? { structuredContent } : {}),
      ...(meta ? { meta } : {}),
      ...(extra ? { extra } : {}),
    },
  };

  const entryPath = await writeEntry(options.directory, input.serverName, timestamp, entry);
  if (cacheKey && namespace && argumentsObject && !oversized && resultRecord?.isError !== true) {
    await writeCachePointer(options.directory, cacheKey, {
      version: MCP_RESULT_ARCHIVE_SCHEMA_VERSION,
      cacheKey,
      cacheKeyVersion: MCP_CACHE_KEY_VERSION,
      entryCacheKey: cacheKey,
      timestamp,
      namespace,
      server: input.serverName,
      tool: input.toolName,
      entryPath: relative(options.directory, entryPath),
    });
  }
  return { entryPath, rawSha256, rawBytes, omitted: oversized };
}

/** Archive failures must never change the MCP tool result returned to the model. */
export async function archiveMcpToolResultSafely(
  input: ArchiveMcpToolResultInput,
): Promise<McpResultArchiveReceipt | undefined> {
  try {
    return await archiveMcpToolResult(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = (error as NodeJS.ErrnoException).code
      ?? (error instanceof Error ? error.constructor.name : typeof error);
    const warningKey = `${input.serverName}:${errorCode}`;
    if (!warnedArchiveErrors.has(warningKey) && warnedArchiveErrors.size < MAX_ARCHIVE_WARNING_KEYS) {
      warnedArchiveErrors.add(warningKey);
      console.warn(`[MCP result archive] Failed to archive ${input.serverName}/${input.toolName}: ${message}`);
    }
    return undefined;
  }
}

async function archiveContentBlocks(
  root: string,
  value: unknown,
): Promise<Array<Record<string, unknown>>> {
  if (!Array.isArray(value)) return [];

  return mapWithConcurrency(value, 8, async (block, ordinal) => {
    const record = asRecord(block);
    if (!record) {
      return {
        ordinal,
        type: typeof block,
        object: await archiveJsonValue(root, block),
      };
    }

    if (record.type === "text" && typeof record.text === "string") {
      const { text, ...metadata } = record;
      return {
        ordinal,
        type: "text",
        metadata,
        object: await writeObject(root, Buffer.from(text, "utf8"), "text/plain; charset=utf-8", "utf8"),
      };
    }

    if (record.type === "image" && typeof record.data === "string") {
      const { data, ...metadata } = record;
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream";
      const decoded = decodeBase64(data);
      return {
        ordinal,
        type: "image",
        metadata,
        object: decoded
          ? await writeObject(root, decoded, mimeType, "binary")
          : await writeObject(root, Buffer.from(data, "utf8"), mimeType, "base64"),
      };
    }

    return {
      ordinal,
      type: typeof record.type === "string" ? record.type : "unknown",
      object: await archiveJsonValue(root, block),
    };
  });
}

async function archiveExtraFields(
  root: string,
  result: Recordish | undefined,
): Promise<ArchiveObjectRef | undefined> {
  if (!result) return undefined;
  const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
  const extra = Object.fromEntries(Object.entries(result).filter(([key]) => !standard.has(key)));
  if (Object.keys(extra).length === 0) return undefined;
  return archiveJsonValue(root, extra);
}

async function archiveJsonValue(root: string, value: unknown): Promise<ArchiveObjectRef> {
  const json = stringifyJson(value, "MCP archive value");
  return writeObject(root, Buffer.from(json, "utf8"), "application/json", "json");
}

async function writeObject(
  root: string,
  bytes: Buffer,
  mediaType: string,
  encoding: ArchiveObjectRef["encoding"],
): Promise<ArchiveObjectRef> {
  const digest = sha256(bytes);
  const relativePath = join("objects", digest.slice(0, 2), digest);
  const absolutePath = join(root, relativePath);
  await ensurePrivateDirectory(resolve(root, "objects", digest.slice(0, 2)));
  await writeExclusive(absolutePath, bytes);
  return {
    sha256: digest,
    path: relativePath,
    bytes: bytes.length,
    mediaType,
    encoding,
  };
}

async function findArchiveEntry(
  root: string,
  serverName: string,
  entryId: string,
): Promise<{ path: string; entry: Recordish }> {
  const directory = resolve(root, "entries", safePathSegment(serverName));
  const pending = [directory];
  const matches: Array<{ path: string; entry: Recordish }> = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const child of children) {
      const path = resolve(current, child.name);
      if (child.isDirectory()) pending.push(path);
      else if (child.isFile() && child.name.endsWith(".json")) {
        const entry = JSON.parse((await readPrivateArchiveFile(root, path)).toString("utf8")) as Recordish;
        if (entry.id === entryId || child.name === entryId || child.name === `${entryId}.json`) {
          matches.push({ path, entry });
        }
      }
    }
  }
  if (matches.length === 0) throw new Error(`Archive entry not found: ${entryId}`);
  if (matches.length > 1) throw new Error(`Archive entry is ambiguous: ${entryId}`);
  return matches[0]!;
}

async function writeCachePointer(root: string, cacheKey: string, pointer: ArchivePointer): Promise<void> {
  const destination = cachePointerPath(root, cacheKey);
  const directory = resolve(root, "cache", cacheKey.slice(0, 2));
  await ensurePrivateDirectory(directory);
  await writeJsonAtomic(destination, pointer);
}

async function writeCachePointerIfAbsent(
  root: string,
  cacheKey: string,
  pointer: ArchivePointer,
): Promise<boolean> {
  const destination = cachePointerPath(root, cacheKey);
  const directory = resolve(root, "cache", cacheKey.slice(0, 2));
  await ensurePrivateDirectory(directory);
  const temporary = `${destination}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${stringifyJson(pointer, "MCP cache pointer")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await link(temporary, destination);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function cachePointerPath(root: string, cacheKey: string): string {
  return resolve(root, "cache", cacheKey.slice(0, 2), `${cacheKey}.json`);
}

async function reconstructArchivedResult(
  root: string,
  archived: Recordish | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (!archived || archived.status !== "archived" || !Array.isArray(archived.content)) return undefined;
  const content: unknown[] = [];
  for (const blockValue of archived.content) {
    const block = asRecord(blockValue);
    const object = asRecord(block?.object);
    if (!block || !object || typeof block.type !== "string") return undefined;
    const metadata = asRecord(block.metadata) ?? {};
    const bytes = await readArchivedObject(root, object);
    if (block.type === "text") content.push({ ...metadata, type: "text", text: bytes.toString("utf8") });
    else if (block.type === "image") content.push({ ...metadata, type: "image", data: bytes.toString("base64") });
    else content.push(JSON.parse(bytes.toString("utf8")));
  }

  const result: Record<string, unknown> = { content, isError: archived.isError === true };
  if (archived.structuredContent) result.structuredContent = await readArchivedJson(root, archived.structuredContent);
  if (archived.meta) result._meta = await readArchivedJson(root, archived.meta);
  if (archived.extra) Object.assign(result, await readArchivedJson(root, archived.extra));
  return result;
}

async function readArchivedJson(root: string, reference: unknown): Promise<unknown> {
  return JSON.parse((await readArchivedObject(root, asRecord(reference))).toString("utf8"));
}

async function readArchivedObject(root: string, reference: Recordish | undefined): Promise<Buffer> {
  if (!reference || typeof reference.path !== "string" || typeof reference.sha256 !== "string") {
    throw new Error("Invalid MCP archive object reference");
  }
  const path = resolve(root, reference.path);
  if (!isWithinDirectory(root, path)) throw new Error("MCP archive object escaped archive root");
  const bytes = await readPrivateArchiveFile(root, path);
  if (sha256(bytes) !== reference.sha256) throw new Error("MCP archive object failed integrity verification");
  return bytes;
}

async function readPrivateArchiveFile(root: string, path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("MCP archive reference is not a regular file");
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
  if (!isWithinDirectory(realRoot, realFile)) throw new Error("MCP archive reference escaped archive root");
  return readFile(realFile);
}

function isWithinDirectory(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  let exists = false;
  try {
    await writeFile(temporary, `${stringifyJson(value, "MCP cache pointer")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    exists = true;
    await rename(temporary, path);
    exists = false;
  } finally {
    if (exists) await unlink(temporary).catch(() => {});
  }
}

async function writeEntry(
  root: string,
  serverName: string,
  timestamp: string,
  entry: unknown,
): Promise<string> {
  const date = timestamp.slice(0, 10);
  const directory = resolve(root, "entries", safePathSegment(serverName), date);
  await ensurePrivateDirectory(directory);
  const baseName = `${timestamp.replaceAll(":", "-")}-${randomBytes(6).toString("hex")}.json`;
  const destination = join(directory, baseName);
  const temporary = join(directory, `.${baseName}.tmp`);
  const json = `${stringifyJson(entry, "MCP archive entry")}\n`;
  await writeFile(temporary, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
  return destination;
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  if (await verifyExistingObject(path, bytes)) return;

  const temporary = `${path}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (await verifyExistingObject(path, bytes)) return;
    try {
      await rename(temporary, path);
      temporaryExists = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !await verifyExistingObject(path, bytes)) {
        throw error;
      }
    }
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => {});
  }
}

async function verifyExistingObject(path: string, expected: Buffer): Promise<boolean> {
  try {
    const existing = await readFile(path);
    if (existing.length === expected.length && sha256(existing) === sha256(expected)) return true;
    throw new Error(`MCP result archive object failed integrity verification: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`MCP result archive path is not a directory: ${path}`);
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`MCP result archive directory must not be accessible by group or others: ${path}`);
  }
}

function resolveArchiveDirectory(configured: string | undefined): string {
  if (!configured) return getAgentPath("mcp-results");
  const expanded = configured === "~"
    ? homedir()
    : configured.startsWith("~/")
      ? join(homedir(), configured.slice(2))
      : configured;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function stringifyJson(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error(`${label} is not JSON-serializable`);
    return serialized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} could not be serialized: ${message}`);
  }
}

function decodeBase64(value: string): Buffer | undefined {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 === 1) return undefined;
  const decoded = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/, "");
  const canonicalOutput = decoded.toString("base64").replace(/=+$/, "");
  return canonicalInput === canonicalOutput ? decoded : undefined;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function asRecord(value: unknown): Recordish | undefined {
  return typeof value === "object" && value !== null ? value as Recordish : undefined;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "server";
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function envBoolean(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}
