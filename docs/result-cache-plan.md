# MCP Result Archive and Read-through Cache Plan

## Status

- Raw result archive: implemented behind `settings.resultArchive`
- Explicit read-through tool: implemented as `mcpCache` behind `settings.resultCache`
- Figma agent guidance: bundled as `figma-mcp-cache`
- Transparent interception of direct MCP tools: intentionally not implemented
- RFC 8785 canonicalization and Figma `nodeId` normalization: planned
- Same-process singleflight for concurrent misses: planned
- Retention, mark-and-sweep GC, and archive size ceiling: planned
- Windows private ACL support: not implemented; raw archiving fails closed

## Problem

Large MCP responses may be truncated before they reach the model or session history. Repeated Figma reads also consume daily and per-minute quotas even when the same node and arguments were fetched recently.

The design separates two concerns:

1. **Archive:** preserve the raw `CallToolResult` before output guarding.
2. **Read-through cache:** reuse an explicitly namespaced successful archive entry without contacting the MCP server.

This separation prevents an old or cross-document result from silently replacing a live call.

## Goals

- Preserve complete raw MCP results before model-facing truncation.
- Deduplicate repeated text, image, argument, and structured payloads.
- Avoid a live MCP call on a validated namespaced cache hit.
- Make stale-evidence behavior explicit through policy and TTL.
- Never publish MCP errors or oversized omitted results as hits.
- Preserve server-disabled and approval enforcement on cache hits.
- Keep archive failures non-fatal to the underlying MCP call.

## Non-goals

- Automatically cache dynamic current-selection requests.
- Infer a Figma file identity from `nodeId` alone.
- Claim that cached evidence represents the latest design.
- Cache write/mutation tools.
- Bypass MCP server permissions or approval policy.

## Configuration

Both features are disabled by default. Read-through caching requires the backing archive to be enabled for the same server.

```json
{
  "settings": {
    "resultArchive": {
      "enabled": true,
      "directory": "~/Library/Application Support/pi-mcp-adapter/archive",
      "servers": ["figma-desktop", "figma"],
      "maxBytes": 52428800,
      "maxArgumentBytes": 1048576
    },
    "resultCache": {
      "enabled": true,
      "allowTools": [
        "figma-desktop/get_design_context",
        "figma-desktop/get_metadata",
        "figma-desktop/get_screenshot",
        "figma-desktop/get_variable_defs"
      ],
      "defaultMaxAgeSeconds": 3600,
      "requireNodeId": true
    }
  }
}
```

Environment overrides:

- `MCP_RESULT_ARCHIVE=0|1`
- `MCP_RESULT_ARCHIVE_DIR=/path`

Per-server `resultArchive: true | false` overrides global archive enablement.

## Storage layout

```text
archive/
├── entries/<server>/<date>/*.json
├── objects/<sha-prefix>/<sha256>
└── cache/<cache-key-prefix>/<cache-key>.json
```

- `entries`: append-only invocation metadata and object references
- `objects`: SHA-256 content-addressed arguments, text, decoded images, `_meta`, structured content, and extra fields
- `cache`: atomic pointers from a namespaced canonical request key to the latest reusable successful entry

macOS/Linux directories use mode `0700`; files use `0600`. Existing unsafe directories are rejected rather than silently chmodded. Windows is currently unsupported because private ACL provisioning is not implemented.

## Cache identity and normalization

```text
SHA-256(
  namespace
  + server
  + original tool name
  + canonical JSON arguments
)
```

The current implementation recursively sorts object keys before serialization, but it is not yet a complete RFC 8785 JSON Canonicalization Scheme (JCS) implementation. Cross-SDK cache compatibility requires a normative encoding rather than relying on runtime-specific `JSON.stringify` behavior.

Target normalization rules:

1. Canonicalize arguments with RFC 8785 JCS before hashing.
2. Normalize Figma `nodeId` from `123-456` to `123:456` before both lookup and live execution.
3. Reject percent-encoded node IDs such as `123%3A456` at the cache boundary instead of creating a second identity.
4. Trim and validate namespace, server, and tool names without changing case-sensitive semantic values.
5. Resolve prefixed tool names to the original MCP tool name before hashing.
6. Preserve array order and string values; do not normalize domain values such as `clientFrameworks` beyond documented schema rules.

For Figma URLs:

- `/design/<fileKey>/...?...node-id=123-456` → namespace `<fileKey>`, node ID `123:456`
- `/design/<fileKey>/branch/<branchKey>/...` → namespace `<branchKey>`

A namespace and explicit normalized `nodeId` are required by default. Direct `figma_*` calls have no namespace, so their results can be archived but do not create reusable pointers.

## Read-through call chain

```mermaid
flowchart TD
    A[Agent] --> B["mcpCache(server, tool, namespace, args, policy, maxAgeSeconds)"]
    B --> V["Validate cache enabled, namespace, nodeId, allowlist, server state, approval, and archive"]
    V --> OK{Validation passed?}
    OK -- No --> ERR[Return cache error without contacting MCP]
    OK -- Yes --> P{Policy}

    P -- prefer-cache --> K["Compute SHA-256 of namespace + server + tool + canonical args"]
    P -- cache-only --> K
    P -- refresh --> LIVE[Live executeCall]

    K --> LOOKUP["Read pointer → archive entry → content-addressed objects"]
    LOOKUP --> VERIFY["Validate TTL, namespace, request identity, paths, and hashes"]
    VERIFY --> HIT{Valid hit?}
    HIT -- Yes --> RESTORE[Reconstruct raw CallToolResult]
    RESTORE --> GUARD_HIT[Apply outputGuard]
    GUARD_HIT --> RETURN_HIT[Return to Agent with cache=hit]

    HIT -- No --> ONLY{Policy is cache-only?}
    ONLY -- Yes --> MISS[Return cache_miss; never contact MCP]
    ONLY -- No --> LIVE

    LIVE --> CALL[MCP client.callTool]
    CALL --> RAW[Raw CallToolResult]
    RAW --> ARCHIVE["Archive before outputGuard"]
    ARCHIVE --> OBJECTS["Write arguments/content as SHA-256 objects"]
    OBJECTS --> ENTRY[Append invocation entry]
    ENTRY --> SUCCESS{Successful namespaced result?}
    SUCCESS -- Yes --> POINTER[Atomically replace cache pointer]
    SUCCESS -- No --> NO_POINTER[Do not publish pointer]
    POINTER --> GUARD_LIVE[Apply outputGuard]
    NO_POINTER --> GUARD_LIVE
    GUARD_LIVE --> RETURN_LIVE[Return to Agent with cache=miss or cache=refresh]

    DIRECT[Direct figma_* tool call] --> CALL
    DIRECT -. no namespace .-> NO_POINTER
```

| Stage | Cache hit | Cache miss / `refresh` | Direct `figma_*` call |
|---|---|---|---|
| Namespace required | Yes | Yes | No |
| Approval and server-disabled checks | Yes | Yes | Yes |
| Contacts MCP server | No | Yes | Yes |
| Archives raw result before truncation | No new entry | Yes | Yes |
| Publishes reusable pointer | Already exists | Successful namespaced results only | No namespace, so no pointer |
| Applies `outputGuard` | Yes | Yes | Yes |
| MCP error becomes a hit | Never | Never | Never |

## Concurrency and singleflight

Atomic object publication and pointer replacement protect on-disk integrity, but they do not prevent duplicate live calls when concurrent requests miss the same key.

Planned singleflight behavior:

```text
first miss for cache key
  → becomes leader
  → performs one live MCP call
  → archives result and updates pointer

concurrent misses for same key
  → join leader promise
  → receive the same guarded result
  → do not contact MCP server
```

The in-flight registry should be process-local and keyed by the final canonical cache key. Entries must be removed in `finally` on success, MCP error, cancellation, timeout, or archive failure. A later completion must not replace a pointer captured from a logically newer request; pointer updates should compare capture timestamps or generation numbers before publication.

Cross-process request collapsing remains future work. File locking alone can serialize pointer writes but cannot safely share an in-flight MCP response between processes.

## Tool usage

```js
mcpCache({
  server: "figma-desktop",
  tool: "get_design_context",
  namespace: "your-figma-file-key",
  args: {
    nodeId: "123:456",
    clientLanguages: "dart",
    clientFrameworks: "flutter"
  },
  policy: "prefer-cache",
  maxAgeSeconds: 3600
})
```

Only exact `server/original-tool` entries in `allowTools` can run.

## Policies and freshness

| Use case | Policy | Contacts MCP server | May return older data | Suggested age window | Proves current state |
|---|---|---:|---:|---:|---:|
| Check whether a design/spec changed | `refresh` | Yes | No | N/A | Yes, if live evidence succeeds |
| Formal drift verification | `refresh` | Yes | No | N/A | Yes, if all required evidence succeeds |
| Ordinary repeated work | `prefer-cache` | On miss/expiry | Yes | 3,600 seconds | No |
| Rate-limit evidence fallback | `cache-only` | No | Yes | 86,400 seconds | No |
| Offline evidence review | `cache-only` | No | Yes | Explicit caller choice | No |
| Force pointer replacement | `refresh` | Yes | No | N/A | Yes, if live evidence succeeds |
| Active tab unconfirmed | Do not call | No | No data used | N/A | No |
| Missing namespace or `nodeId` | Do not use cache | Depends on explicit live workflow | Unsafe to determine | N/A | No |
| MCP error | No pointer | Yes for attempted live call | Error is never a hit | N/A | No |

| Policy | Reads cache first | Live call on miss | Replaces pointer | Suitable during rate limiting |
|---|---:|---:|---:|---:|
| `prefer-cache` | Yes | Yes | On successful miss | No; a miss contacts the limited server |
| `cache-only` | Yes | Never | No | Yes |
| `refresh` | No | Always | On successful live call | No |

## Evidence status guidance

| Evidence source | Safe claim | Do not claim |
|---|---|---|
| Successful `refresh` with all required context/screenshots | Current evidence was verified | Anything beyond returned evidence |
| Successful `refresh` with missing required evidence | Partial/unverifiable | Full verification completed |
| `prefer-cache` hit | Cached evidence matches the inspected reference | Current Figma has not changed |
| `cache-only` hit | Historical evidence is available; report age/source | This is the latest design |
| `cache-only` miss | No reusable namespaced cache exists | Guessed design content |
| Rate-limit response | Blocked/unverifiable; use `cache-only` without direct retries | Repeated reset probes |
| Node absent from active tab | Active-file mismatch | Rate limiting |

`cache-only` during a quota lockout is deliberately stale-evidence mode. It must not upgrade verification status by itself.

## Integrity and safety

A hit is accepted only after validating:

- pointer schema, namespace, server, tool, and timestamp
- referenced entry schema and cache key
- canonical request argument identity
- TTL
- real-path containment under the configured archive root
- regular-file/no-symlink requirements
- SHA-256 object hashes
- server disabled state and approval policy

MCP error results, oversized omitted results, and oversized omitted arguments never publish cache pointers.

## Agent behavior

The bundled `figma-mcp-cache` skill instructs new agents to:

- prefer `mcpCache` for link-based Figma reads
- extract file/branch identity from the URL
- use `refresh` for “check whether it changed”
- use `cache-only` with a deliberate 86,400-second window after rate limiting
- stop direct Figma retries during a quota lockout
- distinguish cached evidence from current live verification

## Rollout plan

### Phase 1 — Archive

- Capture raw results before `outputGuard`.
- Store content-addressed objects and append-only entries.
- Keep tool behavior unchanged.

### Phase 2 — Explicit read-through cache

- Add `mcpCache` with stable namespaces.
- Support `prefer-cache`, `cache-only`, and `refresh`.
- Require exact allowlists and explicit node identity.

### Phase 3 — Migration and promotion

- Import historical Pi session results.
- Promote only entries with a verified file/branch namespace.
- Reject errors, incomplete/truncated data, and ambiguous file identity.
- Preserve the original capture timestamp; promotion must never make old evidence appear newly fetched.
- Require an explicit `maxAgeSeconds` when reading promoted data.
- Default promoted evidence to a short or review-specific TTL and never use it to prove current Figma state without `refresh`.
- Provide a reviewed command such as `pi-mcp-cache promote <entry-id> --namespace <key> --dry-run` that shows provenance, age, arguments, and target cache key before publication.

### Phase 4 — Operations

- Add cache inventory, hit/miss counters, invalidation, and pruning commands.
- Report saved MCP calls and storage usage.
- Add dual retention controls:
  - pointers follow short TTL/freshness policy
  - raw invocation entries follow configurable age and total-size limits
- Add mark-and-sweep GC:
  1. mark every object referenced by retained entries and pointers
  2. sweep unreferenced objects after a grace period
  3. verify hashes and refuse deletion when the reference scan is incomplete
- Add a configurable archive ceiling (for example 5 GiB by default, with an explicit higher limit for audit-heavy deployments).
- When over the ceiling, remove the oldest eligible entries according to retention policy, then sweep orphan objects. Do not use object filesystem mtime as LRU evidence because deduplicated objects are shared.
- Keep unique evidence unless the configured retention policy explicitly permits deletion.

## Design decisions and open work

| Topic | Decision | Remaining work |
|---|---|---|
| JSON canonicalization | Adopt RFC 8785 JCS and explicit Figma `nodeId` normalization | Replace the current recursive-key-sort serializer and add cross-runtime vectors |
| Concurrent cache misses | Add process-local singleflight per canonical cache key | Define cancellation ownership and pointer generation ordering; evaluate cross-process coordination later |
| Figma revision / last-modified | Store and validate it when the MCP server exposes trustworthy revision metadata | Current Figma Desktop raw results expose neither revision nor `lastModified`; TTL/refresh remain authoritative |
| Direct archive promotion | Support through an explicit reviewed CLI with `--namespace` and `--dry-run` | Preserve capture time, require provenance, reject ambiguous/error/incomplete entries |
| Historical promotion freshness | Treat as historical evidence, never as a fresh fetch | Require explicit read TTL and prohibit verification-status upgrades without live `refresh` |
| Retention | Use pointer TTL plus raw archive age/size limits | Implement inventory, retention planning, mark-and-sweep GC, and orphan grace periods |
| Windows | Keep disk archive fail-closed until private ACLs are implemented | Consider an explicitly selected memory-only tier as a temporary feature; do not silently downgrade durable archive security |
| Approval audit | Record cache-hit approval separately from live-call approval | Add audit event types such as `APPROVAL_CACHE_HIT` and `APPROVAL_LIVE_CALL` without storing secrets |

### Windows position

A silent fallback to disk under `%LOCALAPPDATA%` is not sufficient by itself because path convention does not prove the ACL is private. Short term, Windows remains fail-closed for durable raw archives. A future opt-in memory-only tier may provide basic read-through behavior without persistence, while durable Windows support should provision and verify a user-only ACL through a reviewed native mechanism.
