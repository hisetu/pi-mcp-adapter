import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveMcpToolResult,
  archiveMcpToolResultSafely,
  computeMcpResultCacheKey,
  readMcpResultCache,
  DEFAULT_MCP_RESULT_ARCHIVE_MAX_ARGUMENT_BYTES,
  DEFAULT_MCP_RESULT_ARCHIVE_MAX_BYTES,
  resolveMcpResultArchiveOptions,
} from "../mcp-result-archive.ts";
import { computeMcpResultCacheKeyV1, computeMcpResultCacheKeyV2 } from "../mcp-cache-key.ts";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-result-archive-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.MCP_RESULT_ARCHIVE;
  delete process.env.MCP_RESULT_ARCHIVE_DIR;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveMcpResultArchiveOptions", () => {
  it("is disabled by default and supports global, allowlist, server, and env controls", () => {
    expect(resolveMcpResultArchiveOptions(undefined, undefined, "figma")).toMatchObject({
      enabled: false,
      maxBytes: DEFAULT_MCP_RESULT_ARCHIVE_MAX_BYTES,
      maxArgumentBytes: DEFAULT_MCP_RESULT_ARCHIVE_MAX_ARGUMENT_BYTES,
    });

    expect(resolveMcpResultArchiveOptions({ resultArchive: true }, undefined, "figma").enabled).toBe(true);
    expect(resolveMcpResultArchiveOptions({ resultArchive: { servers: ["github"] } }, undefined, "figma").enabled).toBe(false);
    expect(resolveMcpResultArchiveOptions({ resultArchive: { servers: ["figma"], maxBytes: 1234 } }, undefined, "figma")).toMatchObject({
      enabled: true,
      maxBytes: 1234,
    });
    expect(resolveMcpResultArchiveOptions(undefined, { resultArchive: true }, "figma").enabled).toBe(true);
    expect(resolveMcpResultArchiveOptions({ resultArchive: true }, { resultArchive: false }, "figma").enabled).toBe(false);

    process.env.MCP_RESULT_ARCHIVE = "1";
    expect(resolveMcpResultArchiveOptions(undefined, { resultArchive: false }, "figma").enabled).toBe(true);
    process.env.MCP_RESULT_ARCHIVE = "0";
    expect(resolveMcpResultArchiveOptions({ resultArchive: true }, { resultArchive: true }, "figma").enabled).toBe(false);
  });

  it("expands archive directory overrides", () => {
    process.env.MCP_RESULT_ARCHIVE_DIR = "~/custom-mcp-results";
    expect(resolveMcpResultArchiveOptions({ resultArchive: true }, undefined, "figma").directory).toMatch(/custom-mcp-results$/);
  });
});

describe("archiveMcpToolResult", () => {
  it("archives raw text, decoded images, structured content, metadata, extras, and request provenance", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const image = Buffer.from("fake-png-bytes");
    const result = {
      content: [
        { type: "text", text: "design context", annotations: { audience: ["assistant"] } },
        { type: "text", text: "design context" },
        { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      ],
      isError: false,
      structuredContent: { nodeId: "1:2" },
      _meta: { source: "figma" },
      customField: { retained: true },
    };

    const receipt = await archiveMcpToolResult({
      settings: { resultArchive: { directory: archive } },
      definition: {},
      serverName: "figma/desktop",
      toolName: "get_design_context",
      arguments: { nodeId: "1:2", forceCode: true },
      origin: "direct",
      result,
    });

    expect(receipt).toBeDefined();
    expect(receipt?.omitted).toBe(false);
    expect(receipt?.rawBytes).toBe(Buffer.byteLength(JSON.stringify(result)));
    expect(receipt?.rawSha256).toBe(createHash("sha256").update(JSON.stringify(result)).digest("hex"));
    expect(receipt?.entryPath).toContain(join("entries", "figma_desktop"));

    const entry = JSON.parse(await readFile(receipt!.entryPath, "utf8"));
    expect(entry).toMatchObject({
      version: 1,
      server: "figma/desktop",
      tool: "get_design_context",
      origin: "direct",
      request: { argumentsBytes: expect.any(Number), argumentsSha256: expect.any(String) },
      result: { status: "archived", isError: false, rawSha256: receipt?.rawSha256 },
    });
    expect(JSON.parse(await readFile(join(archive, entry.request.arguments.path), "utf8"))).toEqual({
      nodeId: "1:2",
      forceCode: true,
    });
    expect(entry.result.content).toHaveLength(3);
    expect(entry.result.content[0].object.sha256).toBe(entry.result.content[1].object.sha256);
    expect(entry.result.content[2].object).toMatchObject({ mediaType: "image/png", encoding: "binary", bytes: image.length });
    expect(await readFile(join(archive, entry.result.content[2].object.path))).toEqual(image);
    expect(entry.result.structuredContent.encoding).toBe("json");
    expect(entry.result.meta.encoding).toBe("json");
    expect(entry.result.extra.encoding).toBe("json");

    expect((await stat(archive)).mode & 0o777).toBe(0o700);
    expect((await stat(receipt!.entryPath)).mode & 0o777).toBe(0o600);

    const objectFiles = await collectFiles(join(archive, "objects"));
    expect(objectFiles).toHaveLength(6);
  });

  it("restores a namespaced cached result with canonical argument ordering", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const settings = { resultArchive: { directory: archive } };
    const image = Buffer.from("image-bytes");
    await archiveMcpToolResult({
      settings,
      serverName: "figma-desktop",
      toolName: "get_design_context",
      namespace: "file-key-1",
      arguments: { nodeId: "1:2", options: { b: 2, a: 1 } },
      origin: "proxy",
      result: {
        content: [
          { type: "text", text: "cached design" },
          { type: "image", data: image.toString("base64"), mimeType: "image/png" },
        ],
        isError: false,
        structuredContent: { ok: true },
        _meta: { source: "figma" },
        custom: "value",
      },
    });

    expect(computeMcpResultCacheKey(
      "file-key-1",
      "figma-desktop",
      "get_design_context",
      { options: { a: 1, b: 2 }, nodeId: "1:2" },
    )).toBe(computeMcpResultCacheKey(
      "file-key-1",
      "figma-desktop",
      "get_design_context",
      { nodeId: "1:2", options: { b: 2, a: 1 } },
    ));

    const cached = await readMcpResultCache({
      settings,
      namespace: "file-key-1",
      serverName: "figma-desktop",
      toolName: "get_design_context",
      arguments: { options: { a: 1, b: 2 }, nodeId: "1:2" },
      maxAgeSeconds: 3600,
    });
    expect(cached.hit).toBe(true);
    if (!cached.hit) return;
    expect(cached.result).toMatchObject({
      content: [
        { type: "text", text: "cached design" },
        { type: "image", data: image.toString("base64"), mimeType: "image/png" },
      ],
      isError: false,
      structuredContent: { ok: true },
      _meta: { source: "figma" },
      custom: "value",
    });
  });

  it("lazily migrates a valid v1 pointer to cache key v2", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const settings = { resultArchive: { directory: archive } };
    const identity = {
      namespace: "legacy-file",
      serverName: "figma-desktop",
      toolName: "get_metadata",
      arguments: { nodeId: "7-8" },
    };
    await archiveMcpToolResult({
      settings,
      serverName: identity.serverName,
      toolName: identity.toolName,
      namespace: identity.namespace,
      arguments: identity.arguments,
      origin: "proxy",
      result: { content: [{ type: "text", text: "legacy metadata" }], isError: false },
    });

    const v2Key = computeMcpResultCacheKeyV2(identity);
    const v1Key = computeMcpResultCacheKeyV1(identity);
    const v2PointerPath = join(archive, "cache", v2Key.slice(0, 2), `${v2Key}.json`);
    const pointer = JSON.parse(await readFile(v2PointerPath, "utf8"));
    const entryPath = join(archive, pointer.entryPath);
    const entry = JSON.parse(await readFile(entryPath, "utf8"));
    entry.cacheKey = v1Key;
    delete entry.cacheKeyVersion;
    await writeFile(entryPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });

    const v1Directory = join(archive, "cache", v1Key.slice(0, 2));
    await mkdir(v1Directory, { recursive: true, mode: 0o700 });
    pointer.cacheKey = v1Key;
    delete pointer.cacheKeyVersion;
    delete pointer.entryCacheKey;
    await writeFile(join(v1Directory, `${v1Key}.json`), `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
    await unlink(v2PointerPath);

    const cached = await readMcpResultCache({
      ...identity,
      arguments: { nodeId: "7:8" },
      settings,
      maxAgeSeconds: 3600,
    });
    expect(cached).toMatchObject({ hit: true, cacheKey: v2Key });
    expect(JSON.parse(await readFile(v2PointerPath, "utf8"))).toMatchObject({
      cacheKey: v2Key,
      cacheKeyVersion: 2,
      entryCacheKey: v1Key,
    });
  });

  it("rejects symlinked cache pointers that escape the archive root", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const settings = { resultArchive: { directory: archive } };
    const request = {
      settings,
      serverName: "figma-desktop",
      toolName: "get_metadata",
      namespace: "file-key-1",
      arguments: { nodeId: "1:2" },
      origin: "proxy" as const,
      result: { content: [{ type: "text", text: "metadata" }], isError: false },
    };
    await archiveMcpToolResult(request);
    const pointer = (await collectFiles(join(archive, "cache")))[0]!;
    const external = join(root, "external-pointer.json");
    await rename(pointer, external);
    await symlink(external, pointer);

    const cached = await readMcpResultCache({
      settings,
      namespace: request.namespace,
      serverName: request.serverName,
      toolName: request.toolName,
      arguments: request.arguments,
      maxAgeSeconds: 3600,
    });
    expect(cached).toMatchObject({ hit: false, reason: "invalid" });
  });

  it("does not publish MCP error results as cache hits", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const settings = { resultArchive: { directory: archive } };
    await archiveMcpToolResult({
      settings,
      serverName: "figma-desktop",
      toolName: "get_metadata",
      namespace: "file-key-1",
      arguments: { nodeId: "1:2" },
      origin: "proxy",
      result: { content: [{ type: "text", text: "denied" }], isError: true },
    });
    const cached = await readMcpResultCache({
      settings,
      namespace: "file-key-1",
      serverName: "figma-desktop",
      toolName: "get_metadata",
      arguments: { nodeId: "1:2" },
      maxAgeSeconds: 3600,
    });
    expect(cached).toMatchObject({ hit: false, reason: "miss" });
  });

  it("omits oversized arguments while retaining their hash and byte count", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const argumentsValue = { upload: "x".repeat(500) };
    const receipt = await archiveMcpToolResult({
      settings: { resultArchive: { directory: archive, maxArgumentBytes: 50 } },
      serverName: "figma",
      toolName: "upload",
      arguments: argumentsValue,
      origin: "direct",
      result: { content: [{ type: "text", text: "ok" }] },
    });

    const entry = JSON.parse(await readFile(receipt!.entryPath, "utf8"));
    expect(entry.request).toMatchObject({
      argumentsOmitted: true,
      argumentsBytes: Buffer.byteLength(JSON.stringify(argumentsValue)),
      argumentsSha256: createHash("sha256").update(JSON.stringify(argumentsValue)).digest("hex"),
    });
    expect(entry.request.arguments).toBeUndefined();
  });

  it("records an omission instead of persisting payload objects above maxBytes", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const result = { content: [{ type: "text", text: "x".repeat(500) }], isError: false };

    const receipt = await archiveMcpToolResult({
      settings: { resultArchive: { directory: archive, maxBytes: 50 } },
      serverName: "figma",
      toolName: "get_design_context",
      arguments: { nodeId: "1:2" },
      origin: "proxy",
      result,
    });

    expect(receipt?.omitted).toBe(true);
    const entry = JSON.parse(await readFile(receipt!.entryPath, "utf8"));
    expect(entry.result).toMatchObject({ status: "omitted", content: [] });
    expect(await collectFiles(join(archive, "objects"))).toHaveLength(1);
  });

  it("publishes shared objects atomically across concurrent writers", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const input = {
      settings: { resultArchive: { directory: archive } },
      serverName: "figma",
      toolName: "get_design_context",
      arguments: { nodeId: "1:2" },
      origin: "direct" as const,
      result: { content: [{ type: "text", text: "shared payload" }] },
    };

    const receipts = await Promise.all(Array.from({ length: 20 }, () => archiveMcpToolResult(input)));
    expect(receipts.every(Boolean)).toBe(true);
    const entries = await collectFiles(join(archive, "entries"));
    const objects = await collectFiles(join(archive, "objects"));
    expect(entries).toHaveLength(20);
    expect(objects).toHaveLength(2);
    const objectContents = await Promise.all(objects.map((path) => readFile(path, "utf8")));
    expect(objectContents).toContain("shared payload");
  });

  it("rejects a corrupt pre-existing content-addressed object", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const payload = Buffer.from("expected payload");
    const digest = createHash("sha256").update(payload).digest("hex");
    const objectDirectory = join(archive, "objects", digest.slice(0, 2));
    await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(objectDirectory, digest), "corrupt", { mode: 0o600 });

    await expect(archiveMcpToolResult({
      settings: { resultArchive: { directory: archive } },
      serverName: "figma",
      toolName: "get_design_context",
      arguments: {},
      origin: "direct",
      result: { content: [{ type: "text", text: payload.toString("utf8") }] },
    })).rejects.toThrow("integrity verification");
  });

  it("rejects an existing archive directory with unsafe permissions without changing them", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "shared");
    await mkdir(archive, { mode: 0o755 });
    await chmod(archive, 0o755);

    await expect(archiveMcpToolResult({
      settings: { resultArchive: { directory: archive } },
      serverName: "figma",
      toolName: "get_design_context",
      arguments: {},
      origin: "direct",
      result: { content: [{ type: "text", text: "result" }] },
    })).rejects.toThrow("must not be accessible by group or others");
    expect((await stat(archive)).mode & 0o777).toBe(0o755);
  });

  it("archives high block counts without unbounded concurrent writes", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const content = Array.from({ length: 300 }, (_, index) => ({ type: "text", text: `block-${index}` }));
    const receipt = await archiveMcpToolResult({
      settings: { resultArchive: { directory: archive } },
      serverName: "figma",
      toolName: "get_design_context",
      arguments: {},
      origin: "direct",
      result: { content },
    });

    const entry = JSON.parse(await readFile(receipt!.entryPath, "utf8"));
    expect(entry.result.content).toHaveLength(300);
  });

  it("preserves invalid image base64 as encoded text", async () => {
    const root = await makeTempRoot();
    const archive = join(root, "archive");
    const receipt = await archiveMcpToolResult({
      settings: { resultArchive: { directory: archive } },
      serverName: "figma",
      toolName: "get_screenshot",
      arguments: { nodeId: "1:2" },
      origin: "script",
      result: { content: [{ type: "image", data: "%%%invalid%%%", mimeType: "image/png" }] },
    });

    const entry = JSON.parse(await readFile(receipt!.entryPath, "utf8"));
    expect(entry.result.content[0].object.encoding).toBe("base64");
  });

  it("fails closed on Windows instead of writing raw data without a private ACL", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await expect(archiveMcpToolResult({
      settings: { resultArchive: true },
      serverName: "figma",
      toolName: "get_design_context",
      arguments: {},
      origin: "direct",
      result: { content: [{ type: "text", text: "private" }] },
    })).rejects.toThrow("not supported on Windows");
  });

  it("never changes tool behavior when safe archiving fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(archiveMcpToolResultSafely({
      settings: { resultArchive: true },
      serverName: "figma",
      toolName: "get_design_context",
      arguments: {},
      origin: "direct",
      result: circular,
    })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}
