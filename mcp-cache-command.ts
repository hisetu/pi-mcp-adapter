import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { McpExtensionState } from "./state.ts";
import {
  promoteMcpArchiveEntry,
  resolveMcpResultArchiveDirectory,
  type PromoteMcpArchiveEntryResult,
} from "./mcp-result-archive.ts";

export interface McpCacheCommandResult {
  level: "info" | "error";
  text: string;
}

type Recordish = Record<string, unknown>;

type PointerSummary = {
  cacheKey: string;
  cacheKeyVersion: number;
  timestamp: string;
  namespace: string;
  server: string;
  tool: string;
  entryPath: string;
};

type PointerInventory = {
  valid: Array<{ path: string; pointer: PointerSummary }>;
  invalid: string[];
};

export async function runMcpCacheCommand(
  state: McpExtensionState,
  rawArgs: string,
): Promise<McpCacheCommandResult> {
  const tokens = tokenize(rawArgs);
  const subcommand = tokens.shift() ?? "status";
  try {
    switch (subcommand) {
      case "status":
        return { level: "info", text: await cacheStatus(state) };
      case "list": {
        const options = parseOptions(tokens);
        assertAllowedOptions(options, ["server", "tool", "namespace", "limit"]);
        return { level: "info", text: await cacheList(state, options) };
      }
      case "inspect": {
        const key = tokens.shift();
        if (!key || tokens.length > 0) throw new Error("Usage: /mcp-cache inspect <cache-key-prefix>");
        return { level: "info", text: await cacheInspect(state, key) };
      }
      case "promote":
        return { level: "info", text: await cachePromote(state, tokens) };
      case "help":
      case "--help":
      case "-h":
        return { level: "info", text: helpText() };
      default:
        throw new Error(`Unknown /mcp-cache subcommand: ${subcommand}\n\n${helpText()}`);
    }
  } catch (error) {
    return { level: "error", text: error instanceof Error ? error.message : String(error) };
  }
}

async function cacheStatus(state: McpExtensionState): Promise<string> {
  const root = archiveRoot(state);
  const entries = await listJsonFiles(resolve(root, "entries"));
  const inventory = await readPointers(root);
  const pointers = inventory.valid;
  const objects = await listFiles(resolve(root, "objects"));
  const [entryBytes, pointerBytes, objectBytes] = await Promise.all([
    sumSizes(entries),
    sumSizes([...pointers.map((item) => item.path), ...inventory.invalid]),
    sumSizes(objects),
  ]);
  const byTool = countBy(pointers.map((item) => item.pointer.tool));
  const byVersion = countBy(pointers.map((item) => `v${item.pointer.cacheKeyVersion}`));
  const timestamps = pointers.map((item) => Date.parse(item.pointer.timestamp)).filter(Number.isFinite);
  return [
    `MCP cache: ${root}`,
    `Entries: ${entries.length} (${formatBytes(entryBytes)})`,
    `Pointers: ${pointers.length} valid, ${inventory.invalid.length} invalid (${formatBytes(pointerBytes)})`,
    `Objects: ${objects.length} (${formatBytes(objectBytes)})`,
    `Total: ${formatBytes(entryBytes + pointerBytes + objectBytes)}`,
    `Pointer versions: ${formatCounts(byVersion)}`,
    `Pointer tools: ${formatCounts(byTool)}`,
    `Oldest pointer: ${timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : "none"}`,
    `Newest pointer: ${timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : "none"}`,
  ].join("\n");
}

async function cacheList(
  state: McpExtensionState,
  options: Record<string, string | boolean>,
): Promise<string> {
  const root = archiveRoot(state);
  let pointers = (await readPointers(root)).valid;
  if (typeof options.server === "string") pointers = pointers.filter((item) => item.pointer.server === options.server);
  if (typeof options.tool === "string") pointers = pointers.filter((item) => item.pointer.tool === options.tool);
  if (typeof options.namespace === "string") pointers = pointers.filter((item) => item.pointer.namespace === options.namespace);
  if (options.limit !== undefined && positiveInteger(options.limit) === undefined) {
    throw new Error("--limit must be a positive integer");
  }
  const limit = positiveInteger(options.limit) ?? 30;
  pointers.sort((a, b) => b.pointer.timestamp.localeCompare(a.pointer.timestamp));
  const selected = pointers.slice(0, limit);
  if (selected.length === 0) return "No cache pointers matched.";
  const rows = selected.map(({ pointer }) => [
    pointer.timestamp,
    `v${pointer.cacheKeyVersion}`,
    pointer.server,
    pointer.tool,
    pointer.namespace,
    pointer.cacheKey.slice(0, 12),
  ].join(" | "));
  return [
    "timestamp | key | server | tool | namespace | cache-key",
    ...rows,
    ...(pointers.length > selected.length ? [`… ${pointers.length - selected.length} more; use --limit`] : []),
  ].join("\n");
}

async function cacheInspect(state: McpExtensionState, prefix: string): Promise<string> {
  const root = archiveRoot(state);
  const pointers = (await readPointers(root)).valid.filter((item) => item.pointer.cacheKey.startsWith(prefix));
  if (pointers.length === 0) throw new Error(`Cache pointer not found: ${prefix}`);
  if (pointers.length > 1) throw new Error(`Cache key prefix is ambiguous: ${prefix} (${pointers.length} matches)`);
  const { pointer, path } = pointers[0]!;
  const entry = await readArchiveJson(root, resolve(root, pointer.entryPath));
  const request = asRecord(entry.request);
  const result = asRecord(entry.result);
  const argumentsValue = request?.arguments ? await readObjectJson(root, request.arguments) : undefined;
  return JSON.stringify({
    pointerPath: path,
    pointer,
    entry: {
      id: entry.id,
      capturedAt: entry.timestamp,
      origin: entry.origin,
      request: argumentsValue,
      result: {
        status: result?.status,
        isError: result?.isError,
        rawBytes: result?.rawBytes,
        contentBlocks: Array.isArray(result?.content) ? result.content.length : 0,
      },
    },
    ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(pointer.timestamp)) / 1000)),
  }, null, 2);
}

async function cachePromote(state: McpExtensionState, tokens: string[]): Promise<string> {
  const entryId = tokens.shift();
  if (!entryId) throw new Error("Usage: /mcp-cache promote <entry-id> --server <server> --namespace <namespace> [--apply]");
  const options = parseOptions(tokens);
  assertAllowedOptions(options, ["server", "namespace", "apply"]);
  const serverName = typeof options.server === "string" ? options.server : "";
  const namespace = typeof options.namespace === "string" ? options.namespace : "";
  if (!serverName || !namespace) {
    throw new Error("Promotion requires --server and --namespace. It defaults to dry-run; add --apply to publish.");
  }
  const result = await promoteMcpArchiveEntry({
    settings: state.config.settings,
    definition: state.config.mcpServers[serverName],
    serverName,
    entryId,
    namespace,
    apply: options.apply === true,
  });
  return formatPromotion(result);
}

function formatPromotion(result: PromoteMcpArchiveEntryResult): string {
  return [
    `Promotion: ${result.reason}`,
    `Entry: ${result.entryId}`,
    `Captured: ${result.capturedAt}`,
    `Age: ${formatDuration(result.ageMs)}`,
    `Server/tool: ${result.server}/${result.tool}`,
    `Node: ${result.nodeId ?? "none"}`,
    `Namespace: ${result.namespace}`,
    `Cache key: ${result.cacheKey}`,
    `Pointer published: ${result.applied ? "yes" : "no"}`,
    ...(result.reason === "dry-run" ? ["Review this output, then rerun with --apply to publish."] : []),
  ].join("\n");
}

function archiveRoot(state: McpExtensionState): string {
  return resolveMcpResultArchiveDirectory(state.config.settings);
}

async function readPointers(root: string): Promise<PointerInventory> {
  const files = await listJsonFiles(resolve(root, "cache"));
  const valid: Array<{ path: string; pointer: PointerSummary }> = [];
  const invalid: string[] = [];
  for (const path of files) {
    try {
      const raw = await readArchiveJson(root, path);
      if (
        typeof raw.cacheKey === "string"
        && typeof raw.timestamp === "string"
        && typeof raw.namespace === "string"
        && typeof raw.server === "string"
        && typeof raw.tool === "string"
        && typeof raw.entryPath === "string"
      ) {
        valid.push({
          path,
          pointer: {
            cacheKey: raw.cacheKey,
            cacheKeyVersion: typeof raw.cacheKeyVersion === "number" ? raw.cacheKeyVersion : 1,
            timestamp: raw.timestamp,
            namespace: raw.namespace,
            server: raw.server,
            tool: raw.tool,
            entryPath: raw.entryPath,
          },
        });
      }
    } catch {
      invalid.push(path);
    }
  }
  return { valid, invalid };
}

async function readObjectJson(root: string, value: unknown): Promise<unknown> {
  const reference = asRecord(value);
  if (!reference || typeof reference.path !== "string" || typeof reference.sha256 !== "string") return undefined;
  const path = resolve(root, reference.path);
  const bytes = await readArchiveBytes(root, path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== reference.sha256) throw new Error("Archive object failed SHA-256 integrity verification");
  return JSON.parse(bytes.toString("utf8"));
}

async function readArchiveBytes(root: string, path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Archive reference is not a regular file");
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(path)]);
  const rel = relative(realRoot, realFile);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Archive reference escaped root");
  return readFile(realFile);
}

async function readArchiveJson(root: string, path: string): Promise<Recordish> {
  return JSON.parse((await readArchiveBytes(root, path)).toString("utf8")) as Recordish;
}

async function listJsonFiles(root: string): Promise<string[]> {
  return (await listFiles(root)).filter((path) => path.endsWith(".json"));
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
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
      else if (child.isFile()) files.push(path);
    }
  }
  return files;
}

function parseOptions(tokens: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const equals = token.indexOf("=");
    const name = token.slice(2, equals >= 0 ? equals : undefined);
    if (name === "apply") {
      if (equals >= 0) throw new Error("--apply does not accept a value");
      options.apply = true;
    } else if (equals >= 0) {
      const value = token.slice(equals + 1);
      if (!value) throw new Error(`Missing value for --${name}`);
      options[name] = value;
    } else {
      const value = tokens[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
      options[name] = value;
    }
  }
  return options;
}

function assertAllowedOptions(
  options: Record<string, string | boolean>,
  allowed: string[],
): void {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new Error(`Unknown option: --${key}`);
  }
}

function tokenize(value: string): string[] {
  return value.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  }) ?? [];
}

function helpText(): string {
  return [
    "/mcp-cache status",
    "/mcp-cache list [--server name] [--tool name] [--namespace key] [--limit N]",
    "/mcp-cache inspect <cache-key-prefix>",
    "/mcp-cache promote <entry-id> --server name --namespace key [--apply]",
    "Promotion is dry-run unless --apply is present.",
  ].join("\n");
}

function asRecord(value: unknown): Recordish | undefined {
  return typeof value === "object" && value !== null ? value as Recordish : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function formatCounts(values: Map<string, number>): string {
  return values.size ? [...values].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}=${count}`).join(", ") : "none";
}

async function sumSizes(paths: string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += (await stat(path)).size;
  return total;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function formatDuration(value: number): string {
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
