# Cross-cutting transport, networking, and client infrastructure  `stage-19` (cross-cutting infrastructure)

This stage is cross-cutting runtime infrastructure that sits underneath both startup-time client construction and the main execution paths that talk over HTTP, websockets, relays, proxies, local IPC, or MCP transports. Its job is to give the rest of the system one consistent way to open connections, enforce network policy, stream data, and surface typed failures regardless of whether traffic is local, remote, direct, forwarded, or process-backed.

The generic HTTP/TLS/cookie foundation provides the shared outbound request and response model, reqwest transport, retries, SSE decoding, custom CA loading, restricted cookie handling, and the concrete service clients built on top of that. App-server, exec-server, and relay transport channels then carry messages and streamed bodies across stdio, Unix sockets, websockets, RPC forwarding, and encrypted relay links. Managed proxying and local IPC substrates enforce outbound policy, perform MITM interception when configured, and supply Unix-socket, named-pipe, sandbox, and privileged-helper channels. MCP and executor-backed adapters bridge RMCP client sessions onto in-process transports, child-process stdio, or HTTP. Directly in this stage, the backend-client, chatgpt, and cloud-tasks-client lib.rs files expose those reusable client APIs, while codex-client/error.rs standardizes transport and streaming error types shared across callers.

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

- `reg-process-environment` — The process-wide environment and argv/arg0-derived execution context that shapes binary dispatch, bootstrap aliases, and inherited subprocess state.
- `reg-provider-catalog` — The resolved catalog of model providers, backend adapters, and related provider metadata available to the runtime.
- `reg-backend-clients` — The initialized reusable outbound service clients and adapters for backend, model, cloud-tasks, ChatGPT, and related remote APIs.
- `reg-helper-materialization-state` — The shared CODEX_HOME helper-bin materialization state tracking versioned copied helper executables, freshness, and path aliases used by later subprocesses.
- `reg-connection-pools` — The reusable outbound HTTP/WebSocket/TLS connection pools and session-level transport reuse state shared by backend and catalog clients across requests.
- `reg-cookie-jar` — The restricted shared HTTP cookie storage carried across outbound client requests where backend or web flows require session cookies.
- `reg-mcp-client-sessions` — The live RMCP/MCP transport session state and client handles kept across requests for remote connector/tool access and MCP runtime communication.
- `reg-auth-transport-adapters` — The live derived transport-auth materialization (e.g. bearer headers, agent assertions, SigV4 signing context) built from auth state and reused by outbound clients/tooling.
- `reg-remote-control-client-attestation-state` — The persisted and runtime client-attestation token/material state used for remote-control pairing and authenticated remote sessions.
- `reg-trace-propagation-context` — The active distributed-tracing propagation state carried across inbound/outbound requests so child operations inherit the correct trace context.
