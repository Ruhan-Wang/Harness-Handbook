# Cross-cutting transport, networking, and client infrastructure  `stage-19` (cross-cutting infrastructure)

This stage is the project’s shared networking toolbox. It does not represent one moment like startup or shutdown. Instead, it supports many parts of the system whenever they need to talk to web services, local helper programs, or remote servers.

One part provides the basic HTTP pieces: building requests and responses, handling secure HTTPS certificates, keeping only safe cookies, retrying temporary failures, and reading streamed updates. On top of that, it offers ready-made clients for specific services such as backend APIs, ChatGPT-style services, and cloud task systems.

Another part moves data between the app server, exec server, and relay connections. It makes direct and forwarded HTTP look the same, supports large messages by splitting and rejoining them, streams files and response bodies piece by piece, and secures relay traffic with encryption and message framing.

A third part manages proxying and local IPC, meaning private communication between programs on one machine. It enforces proxy rules, supports trusted interception when allowed, and provides local socket and pipe connections across platforms.

The MCP transport adapters then sit on top, letting one client API talk through in-process, child-process, direct HTTP, or forwarded HTTP paths. The top-level client files simply expose these capabilities cleanly, while codex-client errors give callers clear failure types.

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

- `reg-process-security-posture` — The process-wide safety setup that locks down risky OS features and strips unsafe environment settings before normal work begins.
- `reg-global-tls-provider` — The one cryptography engine chosen for the whole process so all secure network connections use the same TLS behavior.
- `reg-mcp-server-catalog` — The materialized list of MCP servers and their launch metadata used for routing, diagnostics, and approval checks.
- `reg-sandbox-exec-policy` — The concrete sandbox and command-execution policy used to restrict process launches and side effects.
- `reg-auth-state` — The live signed-in state, including which auth mode is active and whether credentials are ready, expired, or refreshed.
- `reg-provider-auth-adapters` — The translated service-specific credentials used to talk to different backends, such as bearer tokens or signed-request auth.
- `reg-rate-limit-and-account-snapshot` — The latest known account, usage, and rate-limit status fetched from backend services and shown across the app.
- `reg-transport-connections` — The active communication channels and connection identities for stdio, sockets, websockets, relay links, and sidecar servers.
- `reg-model-stream-state` — The active request-and-stream state while talking to a model, including partial outputs and live projection into the UI.
- `reg-tool-runtime-catalog` — The live set of callable tools and handlers, including shell, patching, web, memory, skills, image, code, and MCP-backed tools.
- `reg-protocol-contracts` — The shared message and schema definitions that keep requests, responses, notifications, and stored data consistent across components.
- `reg-http-client-and-network-policy` — The shared networking client setup for HTTP, retries, certificates, cookies, proxies, and safe outbound connection rules.
- `reg-relay-and-forwarding-state` — The active state for forwarded and relay-based traffic, including chunking, framing, encryption, and direct-vs-forwarded routing.
- `reg-pending-transport-chunk-assembly` — The in-flight state for splitting, reassembling, and streaming large forwarded or relayed messages and bodies across transport boundaries.
- `reg-provider-catalog-refresh-state` — The live bookkeeping for model/provider catalog refresh attempts, staleness, and background revalidation beyond the on-disk cache snapshot.
- `reg-connection-pool-state` — The shared pool(s) of reusable outbound network connections and transport clients kept alive across requests to reduce setup cost and support many stages.
- `reg-cookie-jar-state` — The process-wide safe-cookie storage used by HTTP clients so authenticated or stateful web interactions can persist session cookies across requests.
- `reg-fs-watch-state` — The live filesystem watch registrations and delivery state used for directory/file change notifications that feed protocol clients and background refresh features.
