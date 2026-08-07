import { describe, expect, it } from "vitest";
import {
  canonicalizeMcpArguments,
  computeMcpResultCacheKeyV1,
  computeMcpResultCacheKeyV2,
  normalizeMcpCacheArguments,
  normalizeNodeId,
} from "../mcp-cache-key.ts";

describe("MCP cache key v2", () => {
  it("normalizes equivalent Figma node ID forms", () => {
    expect(normalizeNodeId("123-456")).toBe("123:456");
    expect(normalizeNodeId(" 123:456 ")).toBe("123:456");
    expect(() => normalizeNodeId("123%3A456")).toThrow("must not be URL-encoded");

    const base = { namespace: "file", serverName: "figma-desktop", toolName: "get_metadata" };
    expect(computeMcpResultCacheKeyV2({ ...base, arguments: { nodeId: "123-456" } }))
      .toBe(computeMcpResultCacheKeyV2({ ...base, arguments: { nodeId: "123:456" } }));
  });

  it("uses RFC 8785 canonical ordering and number serialization", () => {
    const first = {
      nodeId: "1:2",
      nested: { z: 1e30, a: -0 },
      labels: ["é", "€"],
    };
    const reordered = {
      labels: ["é", "€"],
      nested: { a: 0, z: 1e30 },
      nodeId: "1:2",
    };

    expect(canonicalizeMcpArguments(first)).toBe(
      '{"labels":["é","€"],"nested":{"a":0,"z":1e+30},"nodeId":"1:2"}',
    );
    expect(canonicalizeMcpArguments(first)).toBe(canonicalizeMcpArguments(reordered));
    expect(computeMcpResultCacheKeyV2({
      namespace: "file",
      serverName: "figma",
      toolName: "get_design_context",
      arguments: first,
    })).toBe(computeMcpResultCacheKeyV2({
      namespace: "file",
      serverName: "figma",
      toolName: "get_design_context",
      arguments: reordered,
    }));
  });

  it("keeps v1 distinct for lazy migration", () => {
    const identity = {
      namespace: "file",
      serverName: "figma-desktop",
      toolName: "get_metadata",
      arguments: { nodeId: "123:456" },
    };
    expect(computeMcpResultCacheKeyV2(identity)).not.toBe(computeMcpResultCacheKeyV1(identity));
  });

  it("rejects non-JSON and cyclic arguments", () => {
    expect(() => normalizeMcpCacheArguments({ value: Number.NaN })).toThrow("finite JSON numbers");
    expect(() => normalizeMcpCacheArguments({ value: undefined })).toThrow("not JSON-serializable");
    expect(() => normalizeMcpCacheArguments({ nodeId: 123 })).toThrow("nodeId must be a string");
    expect(() => normalizeMcpCacheArguments({ value: new Date() })).toThrow("plain JSON objects");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeMcpCacheArguments(cyclic)).toThrow("must not contain cycles");
  });
});
