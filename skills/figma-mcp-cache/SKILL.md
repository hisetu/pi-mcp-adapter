---
name: figma-mcp-cache
description: Use the namespaced mcpCache tool for Figma MCP reads instead of calling figma or figma-desktop read tools directly. Trigger whenever a task provides a Figma Design URL, file key, node ID, asks to inspect or implement Figma UI, requests design context/metadata/screenshots/variables, mentions Figma MCP rate limits, or needs to reuse previously fetched Figma data. Always prefer cache-aware reads when a stable Figma file key and node ID are available.
---

# Figma MCP Cache

Use `mcpCache` for cacheable Figma reads so repeated work does not consume another Figma MCP call.

## Required workflow

1. Extract identity from the Figma URL:
   - `/design/<fileKey>/...?...node-id=123-456` → namespace `<fileKey>`, node ID `123:456`.
   - `/design/<fileKey>/branch/<branchKey>/...` → use `<branchKey>` as the namespace.
2. Keep the exact MCP arguments stable. The cache key includes server, original tool, namespace, and canonical arguments.
3. Call `mcpCache`, not the matching `figma_desktop_*` or `figma_*` read tool.
4. Use `prefer-cache` for normal work.
5. Report whether the result details say `hit`, `miss`, or `refresh` when cache behavior matters.

## Normal call

```js
mcpCache({
  server: "figma-desktop",
  tool: "get_design_context",
  namespace: "<fileKey-or-branchKey>",
  args: {
    nodeId: "123:456",
    clientLanguages: "dart",
    clientFrameworks: "flutter",
    forceCode: true,
    artifactType: "WEB_PAGE_OR_APP_SCREEN",
    taskType: "CHANGE_ARTIFACT"
  },
  policy: "prefer-cache",
  maxAgeSeconds: 3600
})
```

Use the server name configured in the session (`figma-desktop` or `figma`). The tool may be given as its original name such as `get_design_context`.

## Policies

- `prefer-cache`: default. Return a valid hit without contacting Figma; call Figma only on miss or expiry.
- `cache-only`: never contact Figma. Use after a rate-limit response, while offline, or when the user explicitly wants stored evidence only.
- `refresh`: force one live call and update the pointer. Use only when the user requests the latest design or the cached result is known stale.

Recommended TTLs:

- design context: 3600 seconds
- metadata: 3600 seconds
- screenshot: 3600 seconds
- variable definitions: 21600 seconds

## Cacheable tools

Use `mcpCache` for these read tools when permitted by adapter configuration:

- `get_design_context`
- `get_metadata`
- `get_screenshot`
- `get_variable_defs`

Cache each tool separately. A cached design context does not imply a cached screenshot.

## Rate-limit behavior

When Figma says the rate limit is exceeded:

1. Stop all direct `figma_desktop_*` and `figma_*` retries.
2. Do not probe another node to test whether the limit reset.
3. Retry the required request through `mcpCache` with `policy: "cache-only"` and the correct namespace.
4. If it misses, state that no reusable namespaced cache exists. Do not claim that an archive-only entry is a hit.
5. Continue only with the evidence actually returned from cache.

## Safety rules

- A stable namespace and explicit `nodeId` are required. Do not cache current-selection calls.
- If the user provides only a node ID, request the Figma URL or file key before relying on cached data.
- Never invent a namespace or reuse a file key from an unrelated document.
- Do not use read-through caching for tools that modify Figma.
- MCP errors and oversized omitted results are not valid hits.
- Respect server disabled state and approval prompts; cache access does not bypass them.
- Do not silently fall back to a direct Figma read after `cache-only` misses.

## When direct tools are acceptable

Call a direct Figma read only when:

- no stable file key can be obtained and the user explicitly chooses a live selection-based call, or
- debugging the MCP server itself and the user explicitly requests a live call.

For ordinary link-based Figma work, use `mcpCache` first.
