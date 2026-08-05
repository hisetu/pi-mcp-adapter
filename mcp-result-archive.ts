import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentPath } from "./agent-dir.ts";
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

export interface ArchiveMcpToolResultInput {
  settings?: McpSettings | undefined;
  definition?: ServerEntry | undefined;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  origin: McpResultArchiveOrigin;
  result: unknown;
}

type Recordish = Record<string, unknown>;

const warnedArchiveErrors = new Set<string>();

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
  const directory = resolveArchiveDirectory(
    process.env.MCP_RESULT_ARCHIVE_DIR?.trim() || tuning?.directory,
  );

  return {
    enabled,
    directory,
    maxBytes: positiveInteger(tuning?.maxBytes) ?? DEFAULT_MCP_RESULT_ARCHIVE_MAX_BYTES,
    maxArgumentBytes: positiveInteger(tuning?.maxArgumentBytes) ?? DEFAULT_MCP_RESULT_ARCHIVE_MAX_ARGUMENT_BYTES,
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
