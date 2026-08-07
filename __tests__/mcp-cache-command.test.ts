import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveMcpToolResult, readMcpResultCache } from "../mcp-result-archive.ts";
import { runMcpCacheCommand } from "../mcp-cache-command.ts";
import type { McpExtensionState } from "../state.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("/mcp-cache command", () => {
  it("shows status, lists pointers, and inspects cache entries", async () => {
    const { state, archive } = await createState();
    await archiveMcpToolResult({
      settings: state.config.settings,
      definition: state.config.mcpServers.figma,
      serverName: "figma",
      toolName: "get_metadata",
      namespace: "file-key",
      arguments: { nodeId: "1-2" },
      origin: "proxy",
      result: { content: [{ type: "text", text: "metadata" }], isError: false },
    });

    const status = await runMcpCacheCommand(state, "status");
    expect(status).toMatchObject({ level: "info" });
    expect(status.text).toContain("Pointers: 1");
    expect(status.text).toContain("get_metadata=1");

    const listing = await runMcpCacheCommand(state, "list --server figma --tool get_metadata --namespace file-key");
    expect(listing.text).toContain("figma | get_metadata | file-key");
    const keyPrefix = listing.text.trim().split("\n")[1]!.split(" | ").at(-1)!;

    const inspect = await runMcpCacheCommand(state, `inspect ${keyPrefix}`);
    expect(inspect.text).toContain('"nodeId": "1-2"');
    expect(inspect.text).toContain('"status": "archived"');

    const pointer = JSON.parse(inspect.text);
    const entry = JSON.parse(await readFile(join(archive, pointer.pointer.entryPath), "utf8"));
    await writeFile(join(archive, entry.request.arguments.path), "{}", { mode: 0o600 });
    expect(await runMcpCacheCommand(state, `inspect ${keyPrefix}`)).toMatchObject({
      level: "error",
      text: expect.stringContaining("SHA-256 integrity"),
    });
    expect(archive).toContain("mcp-cache-command-test");
  });

  it("dry-runs promotion and publishes only with --apply", async () => {
    const { state, archive } = await createState();
    const receipt = await archiveMcpToolResult({
      settings: state.config.settings,
      definition: state.config.mcpServers.figma,
      serverName: "figma",
      toolName: "get_design_context",
      arguments: { nodeId: "7-8" },
      origin: "direct",
      result: { content: [{ type: "text", text: "design" }], isError: false },
    });
    const entry = JSON.parse(await readFile(receipt!.entryPath, "utf8"));

    const dryRun = await runMcpCacheCommand(
      state,
      `promote ${entry.id} --server figma --namespace file-key`,
    );
    expect(dryRun.text).toContain("Promotion: dry-run");
    expect(dryRun.text).toContain("Node: 7:8");
    expect((await runMcpCacheCommand(state, "status")).text).toContain("Pointers: 0");

    const apply = await runMcpCacheCommand(
      state,
      `promote ${entry.id} --server figma --namespace file-key --apply`,
    );
    expect(apply.text).toContain("Promotion: applied");
    expect(apply.text).toContain("Pointer published: yes");
    expect((await runMcpCacheCommand(state, "status")).text).toContain("Pointers: 1");
    expect(await readMcpResultCache({
      settings: state.config.settings,
      definition: state.config.mcpServers.figma,
      serverName: "figma",
      toolName: "get_design_context",
      namespace: "file-key",
      arguments: { nodeId: "7:8" },
      maxAgeSeconds: 3600,
    })).toMatchObject({ hit: true });

    const repeated = await runMcpCacheCommand(
      state,
      `promote ${entry.id} --server figma --namespace file-key --apply`,
    );
    expect(repeated.text).toContain("Promotion: pointer-exists");
    expect(archive).toBeTruthy();
  });

  it("reports malformed pointers instead of silently hiding them", async () => {
    const { state, archive } = await createState();
    const directory = join(archive, "cache", "ff");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "broken.json"), "not-json", { mode: 0o600 });
    expect((await runMcpCacheCommand(state, "status")).text).toContain("Pointers: 0 valid, 1 invalid");
  });

  it("returns concise usage errors", async () => {
    const { state } = await createState();
    expect(await runMcpCacheCommand(state, "unknown")).toMatchObject({ level: "error" });
    expect((await runMcpCacheCommand(state, "promote missing")).text).toContain("requires --server and --namespace");
    expect((await runMcpCacheCommand(state, "inspect abc extra")).text).toContain("Usage:");
    expect((await runMcpCacheCommand(state, "list --limit nope")).text).toContain("positive integer");
  });
});

async function createState(): Promise<{ state: McpExtensionState; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), "mcp-cache-command-test-"));
  roots.push(root);
  const archive = join(root, "archive");
  const state = {
    config: {
      settings: {
        resultArchive: {
          enabled: true,
          directory: archive,
          servers: ["figma"],
        },
      },
      mcpServers: { figma: { command: "figma" } },
    },
  } as McpExtensionState;
  return { state, archive };
}
