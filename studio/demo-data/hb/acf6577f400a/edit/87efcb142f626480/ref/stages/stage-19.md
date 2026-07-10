# Cross-cutting transport, networking, and client infrastructure  `stage-19` (cross-cutting infrastructure)

This stage is the system’s shared communications toolbox. It is not one single step like startup or shutdown. Instead, many parts of the code use it whenever they need to talk to something else: a web service, another process on the same machine, or a remote relay.

One part provides the basic web plumbing. It builds requests and responses, supports streaming replies, retries temporary failures, loads trusted certificates for secure connections, and keeps only the small set of cookies the system actually wants. Another part provides transport channels between internal services. It can split large websocket messages into chunks, make remote HTTP responses and file reads look like local ones, and carry encrypted relay traffic safely.

A third part manages proxying and local IPC, meaning inter-process communication: private channels between programs on one machine. It decides what network access is allowed, can inspect encrypted web traffic when policy requires it, and offers socket-style local links across platforms. The MCP and executor adapters sit on top, turning high-level client actions into real traffic over in-process links, child processes, or HTTP.

The direct library files are the public front doors for backend, ChatGPT, and cloud-task clients, plus shared error types for transport failures.

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

- `reg-auth-state` — The current login mode and live credentials the app uses to prove who the user is to outside services.
- `reg-installation-id` — A stable local identifier for this installation that lets services and logs recognize the same app install over time.
- `reg-transport-channels` — The currently open communication channels like stdio, sockets, websockets, and relays that requests travel through.
- `reg-model-response-stream` — The live streamed model reply and retry state for the active turn while output is still arriving.
- `reg-sandbox-and-exec-policy` — The active sandbox and command-execution rules that decide what commands, files, and network actions are allowed.
- `reg-command-session-state` — The live state of running shell or process sessions, including restricted command sessions and process control handles.
- `reg-network-client-infrastructure` — The shared HTTP/TLS/retry/cookie client plumbing used whenever the app talks to web services or relays.
- `reg-proxy-and-network-policy-state` — The current proxy and network-access control setup that decides how external connections are routed or restricted.
- `reg-crypto-provider` — The process-wide installed TLS/cryptography provider selection that all secure network clients share for the lifetime of the run.
- `reg-connection-pools-and-shared-clients` — Reusable pooled outbound client connections and shared service client instances kept alive across requests to avoid reconnect/setup cost.
- `reg-auth-refresh-state` — The in-flight token refresh coordination and refreshed-session bookkeeping that prevents conflicting auth refreshes and propagates updated credentials.
