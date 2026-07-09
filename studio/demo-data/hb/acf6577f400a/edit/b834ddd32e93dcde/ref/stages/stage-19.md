# Cross-cutting transport, networking, and client infrastructure  `stage-19` (cross-cutting infrastructure)

This stage is the shared “roads and vehicles” layer used all across the system. It is not one single step like startup or shutdown. Instead, it is behind-the-scenes support that many other stages rely on whenever they need to talk to another process, another service, or a remote server.

One part provides the basic HTTP building blocks: making requests, checking certificates for secure connections, keeping only safe cookies, retrying temporary failures, and reading streamed responses. Another part moves messages between internal services over channels like standard input/output, Unix sockets, websockets, and encrypted relay links. A third part controls how network traffic is routed, including proxy rules, safety checks that block risky local addresses, and local machine-to-machine communication. A fourth part adapts these transport choices for MCP clients, so higher-level code can use one consistent interface whether the server is in-process, a child process, or reached over HTTP.

The directly assigned files expose the public client APIs for backend services, ChatGPT-related features, and cloud tasks, while codex-client/src/error.rs defines clear error types when requests, responses, or streams fail.

## Sub-stages

- [Generic HTTP client, TLS, cookies, and streaming transport foundations](stage-19.1.md) `stage-19.1` — 21 files
- [App-server, exec-server, and relay transport channels](stage-19.2.md) `stage-19.2` — 10 files
- [Managed proxying and local IPC transport substrates](stage-19.3.md) `stage-19.3` — 12 files
- [MCP and executor-backed transport adapters](stage-19.4.md) `stage-19.4` — 8 files

## Files in this stage

### Client crate surfaces
These files define the public module boundaries and exported APIs for the reusable client crates that other parts of the system consume.

### `backend-client/src/lib.rs`

`orchestration` · `compile-time API boundary / cross-cutting`

This crate root is a pure module-and-reexport boundary: it declares the internal `client` module and a crate-visible `types` module, then republishes selected items so downstream crates can depend on a stable, flat API instead of reaching into submodules. The exported `Client` and `RequestError` establish the operational entry point for talking to the backend, while `AddCreditsNudgeCreditType` exposes a request-domain enum or helper tied to one backend operation. The bulk of the file republishes concrete response and model types such as `AccountsCheckResponse`, `CodeTaskDetailsResponse`, `ConfigBundleResponse`, `ConsumeRateLimitResetCreditResponse`, `RateLimitsWithResetCredits`, `TaskListItem`, `PaginatedListTaskListItem`, `TurnAttemptsSiblingTurnsResponse`, and token-usage/accounting structures. A notable design choice is that `types` remains `pub(crate)` as a module while its individual contents are selectively re-exported; this lets the crate control namespace shape and hide internal organization without hiding the actual data contracts. There is no runtime logic here: its importance is architectural, defining what external code is allowed to construct, inspect, and pattern-match when integrating with backend APIs.


### `chatgpt/src/lib.rs`

`orchestration` · `compile-time API boundary / cross-cutting`

This crate root organizes the ChatGPT-facing subsystem into distinct modules: `apply_command`, `connectors`, `get_task`, and `workspace_settings` are public feature modules, while `chatgpt_client` is intentionally private. That split signals the crate’s layering: consumers are expected to use higher-level operations and integration points rather than directly coupling to the underlying client implementation. The file contains no executable logic, but it is still important because it defines the crate’s public API shape and encapsulation boundaries. By making `chatgpt_client` private, the crate can evolve transport details, authentication mechanics, or request formatting without forcing downstream changes. Meanwhile, the public modules suggest the main responsibilities of the crate: applying commands, interfacing with external connectors, retrieving tasks, and reading or enforcing workspace-specific settings. In practice this file is active whenever the crate is compiled or imported, because it determines which modules are visible to dependents and how the subsystem is conceptually partitioned.


### `cloud-tasks-client/src/lib.rs`

`orchestration` · `request handling / cross-cutting client API`

This crate root is the façade for the cloud tasks client subsystem. It declares an internal `api` module and re-exports the task-domain vocabulary defined there: identifiers like `TaskId`, summaries and pages such as `TaskSummary` and `TaskListPage`, lifecycle/status enums including `TaskStatus`, `AttemptStatus`, `ApplyStatus`, and `ApplyOutcome`, payload-oriented types like `TaskText`, `DiffSummary`, `TurnAttempt`, and `CreatedTask`, plus the backend abstraction `CloudBackend`, its future type `CloudBackendFuture`, and the crate-level `Result`/`CloudTaskError`. It also declares an `http` module and publicly exposes `HttpClient`, indicating that the crate supports both abstract backend-driven use and a concrete HTTP transport implementation. The design choice here is to flatten both domain types and transport entry points into one import surface, making the crate convenient for consumers while preserving internal module boundaries. There is no executable code in this file, but it defines the conceptual layering of the subsystem: `api` holds the protocol/domain contract, and `http` supplies one implementation of that contract.


### Shared client errors
This file provides the typed transport and streaming error model used by client-side infrastructure.

### `codex-client/src/error.rs`

`data_model` · `cross-cutting`

This file centralizes the error vocabulary used by the HTTP client layer. `TransportError` models failures around building and executing ordinary requests. Its `Http` variant preserves concrete response context — `StatusCode`, optional request URL, optional response `HeaderMap`, and optional body text — so callers can inspect server-side failures instead of receiving a flattened message. The remaining variants distinguish retry exhaustion (`RetryLimit`), elapsed deadlines (`Timeout`), lower-level connectivity problems captured as strings (`Network`), and request-construction problems (`Build`). Separately, `StreamError` narrows the failure space for streaming APIs to either a generic stream failure string or a timeout. Both enums derive `Debug` and `thiserror::Error`, so they integrate with standard Rust error propagation while producing stable human-readable messages. The split between transport and stream errors is a design choice worth noting: non-streaming code can reason about HTTP metadata and retry semantics, while SSE or byte-stream consumers work with a smaller, stream-oriented error type that avoids implying the presence of a complete HTTP response body.

## 📊 State Registers Touched

- `reg-process-hardening-policy` — The one-time safety settings applied to the whole process, like stripped risky environment variables and OS protections.
- `reg-global-tls-provider` — The single cryptography and TLS backend chosen for all secure network connections in this process.
- `reg-mcp-server-catalog` — The current set of configured MCP servers and their runtime launch details for routing tool calls.
- `reg-sandbox-and-exec-policy` — The concrete file, network, workspace-root, and command-execution safety rules enforced at runtime.
- `reg-auth-session` — The current signed-in account state and saved login details for this installation.
- `reg-access-tokens-and-refresh-state` — The bearer tokens, refresh tokens, and expiry information that get renewed and attached to requests.
- `reg-rate-limit-status` — The current account usage and rate-limit status that can block or shape work.
- `reg-transport-endpoints` — The active communication endpoints like stdio, local sockets, websockets, HTTP bridges, and sidecar links.
- `reg-model-request-metadata` — The standardized metadata attached to model requests, such as session identity and workspace details.
- `reg-network-client-stack` — The shared HTTP and transport client infrastructure used for requests, retries, cookies, streams, and relays.
- `reg-proxy-and-network-routing` — The current proxy rules and network-routing safety decisions that determine where traffic may go.
- `reg-backend-client-pool` — The shared pool/factory of authenticated backend API clients and request adapters reused across startup refreshes, turns, tools, updates, and feedback uploads.
- `reg-connection-pool-and-session-cache` — The shared pool/cache of long-lived outbound service connections and session handles, especially for MCP and related transports, reused and refreshed across requests and threads.
- `reg-response-cache-and-request-dedup` — Shared cached/in-flight remote fetch state used to reuse or coalesce background refresh results such as model, cloud-config, connector, and update lookups across startup and later requests.
- `reg-feedback-upload-queue` — The queued and in-progress feedback/report submissions, including attachments prepared locally and later uploaded through shared backend/network infrastructure.
