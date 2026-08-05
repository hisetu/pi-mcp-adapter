import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectToolExecutor } from "../direct-tools.ts";
import { executeCall } from "../proxy-modes.ts";
import { McpServerManager } from "../server-manager.ts";
import type { McpExtensionState } from "../state.ts";
import type { DirectToolSpec, ToolMetadata } from "../types.ts";
import { UiResourceHandler } from "../ui-resource-handler.ts";

const fixture = fileURLToPath(new URL("./fixtures/output-schema-server.mjs", import.meta.url));
const definition = { command: process.execPath, args: [fixture] };
const managers: McpServerManager[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("raw MCP result archive integration", () => {
  it.each([
    ["proxy", "proxy"],
    ["script", "script"],
    ["direct", "direct"],
  ] as const)("archives the unguarded result through the %s path", async (path, expectedOrigin) => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-result-archive-integration-"));
    tempRoots.push(root);
    const archive = join(root, "archive");
    const name = "draft07-valid";
    const manager = new McpServerManager();
    await manager.connect("real", definition);
    managers.push(manager);
    const state = createState(manager, name, archive);

    const result = path === "direct"
      ? await createDirectToolExecutor(() => state, () => null, directSpec(name))("id", {})
      : await executeCall(
          state,
          `real_${name}`,
          {},
          undefined,
          undefined,
          undefined,
          path === "script" ? "script" : "proxy",
        );

    const returnedText = result.content.find((block) => block.type === "text")?.text ?? "";
    expect(returnedText).toContain("MCP text output truncated");

    const entryPaths = await collectFiles(join(archive, "entries"));
    expect(entryPaths).toHaveLength(1);
    const entry = JSON.parse(await readFile(entryPaths[0]!, "utf8"));
    expect(entry).toMatchObject({ server: "real", tool: name, origin: expectedOrigin });
    expect(entry.result.rawBytes).toBeGreaterThan(5);

    const textRef = entry.result.content.find((block: { type: string }) => block.type === "text").object;
    expect(await readFile(join(archive, textRef.path), "utf8")).toBe(name);
  });
});

function createState(manager: McpServerManager, name: string, archive: string): McpExtensionState {
  const metadata: ToolMetadata = {
    name: `real_${name}`,
    originalName: name,
    description: "archive integration test",
    inputSchema: { type: "object" },
  };
  return {
    manager,
    config: {
      settings: {
        outputGuard: { maxBytes: 5, maxLines: 1 },
        resultArchive: { directory: archive },
      },
      mcpServers: { real: definition },
    },
    toolMetadata: new Map([["real", [metadata]]]),
    serverInstructions: new Map(),
    failureTracker: new Map(),
    uiResourceHandler: new UiResourceHandler(manager),
    completedUiSessions: [],
    uiServer: null,
  } as McpExtensionState;
}

function directSpec(originalName: string): DirectToolSpec {
  return {
    serverName: "real",
    originalName,
    prefixedName: `real_${originalName}`,
    description: "archive integration test",
    inputSchema: { type: "object" },
  };
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files;
}
