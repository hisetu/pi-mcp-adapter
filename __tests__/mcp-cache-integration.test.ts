import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpCacheExecutor } from "../mcp-cache.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { ToolMetadata } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const fixture = fileURLToPath(new URL("./fixtures/output-schema-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mcpCache integration", () => {
  it("uses live data on miss and restores it without another live call on hit", async () => {
    const { state, archive } = await createState();
    const execute = createMcpCacheExecutor(() => state, () => null);
    const params = {
      server: "real",
      tool: "draft07-valid",
      namespace: "figma-file-key",
      args: { nodeId: "1:2" },
      policy: "prefer-cache" as const,
      maxAgeSeconds: 3600,
    };

    const first = await execute("first", params);
    expect(first.details).toMatchObject({ cache: "miss", namespace: "figma-file-key" });
    expect(first.content).toEqual([{ type: "text", text: "draft07-valid" }]);

    await state.manager.close("real");
    const second = await execute("second", params);
    expect(second.details).toMatchObject({ mode: "cache", cache: "hit", server: "real", tool: "draft07-valid" });
    expect(second.content).toEqual([{ type: "text", text: "draft07-valid" }]);
    expect(String(second.details.entryPath)).toContain(archive);
  });

  it("collapses concurrent misses for one cache key into a single live archive entry", async () => {
    const { state, archive } = await createState();
    const execute = createMcpCacheExecutor(() => state, () => null);
    const params = {
      server: "real",
      tool: "draft07-valid",
      namespace: "singleflight-file",
      args: { nodeId: "9-9" },
      policy: "prefer-cache" as const,
      maxAgeSeconds: 3600,
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => execute(`call-${index}`, params)),
    );
    expect(results.every((result) => result.content[0]?.type === "text" && result.content[0].text === "draft07-valid"))
      .toBe(true);
    const entries = await collectFiles(join(archive, "entries"));
    expect(entries).toHaveLength(1);
    expect(await collectFiles(join(archive, "cache"))).toHaveLength(1);
    const entry = JSON.parse(await readFile(entries[0]!, "utf8"));
    const archivedArguments = JSON.parse(await readFile(join(archive, entry.request.arguments.path), "utf8"));
    expect(archivedArguments.nodeId).toBe("9:9");
  });

  it("supports cache-only misses and validates namespace, node id, and allowlist", async () => {
    const { state } = await createState();
    const execute = createMcpCacheExecutor(() => state, () => null);
    const base = { server: "real", tool: "draft07-valid", args: { nodeId: "1:2" } };

    expect((await execute("id", { ...base, namespace: "other", policy: "cache-only" })).details)
      .toMatchObject({ error: "cache_miss" });
    expect((await execute("id", { ...base, namespace: "" })).details)
      .toMatchObject({ error: "namespace_required" });
    expect((await execute("id", { ...base, namespace: "file", args: {} })).details)
      .toMatchObject({ error: "node_id_required" });
    expect((await execute("id", { ...base, namespace: "file", tool: "draft2020-valid" })).details)
      .toMatchObject({ error: "tool_not_allowed" });
  });

  it("does not return hits after the server is disabled or approval is tightened", async () => {
    const { state } = await createState();
    const execute = createMcpCacheExecutor(() => state, () => null);
    const params = {
      server: "real",
      tool: "draft07-valid",
      namespace: "file",
      args: { nodeId: "1:2" },
      policy: "prefer-cache" as const,
    };
    await execute("first", params);

    state.config.mcpServers.real!.disabled = true;
    expect((await execute("disabled", params)).details).toMatchObject({ error: "server_disabled" });

    state.config.mcpServers.real!.disabled = false;
    state.config.settings!.approveTools = true;
    expect((await execute("approval", params)).details).toMatchObject({ error: "approval_required" });
  });

  it("refresh bypasses an existing hit and archives the replacement", async () => {
    const { state } = await createState();
    const execute = createMcpCacheExecutor(() => state, () => null);
    const base = {
      server: "real",
      tool: "draft07-valid",
      namespace: "file",
      args: { nodeId: "1:2" },
    };
    await execute("first", { ...base, policy: "prefer-cache" });
    const refreshed = await execute("refresh", { ...base, policy: "refresh" });
    expect(refreshed.details).toMatchObject({ cache: "refresh", namespace: "file" });
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

async function createState(): Promise<{ state: McpExtensionState; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-cache-integration-"));
  tempRoots.push(root);
  const archive = join(root, "archive");
  const manager = new McpServerManager();
  await manager.connect("real", definition);
  managers.push(manager);
  const names = ["draft07-valid", "draft2020-valid"];
  const metadata = names.map((name): ToolMetadata => ({
    name: `real_${name}`,
    originalName: name,
    description: "cache integration test",
    inputSchema: { type: "object" },
  }));
  const state = {
    manager,
    config: {
      settings: {
        resultArchive: { directory: archive },
        resultCache: {
          enabled: true,
          allowTools: ["real/draft07-valid"],
          defaultMaxAgeSeconds: 3600,
          requireNodeId: true,
        },
      },
      mcpServers: { real: definition },
    },
    toolMetadata: new Map([["real", metadata]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    approvedToolCalls: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    completedUiSessions: [],
    uiServer: null,
  } as McpExtensionState;
  return { state, archive };
}
