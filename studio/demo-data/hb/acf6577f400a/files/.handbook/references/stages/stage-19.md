# Cross-cutting transport, networking, and client infrastructure  `stage-19` (cross-cutting infrastructure)

This stage is shared behind-the-scenes infrastructure. It is the system’s networking toolbox, used during startup, normal work, remote control, and tool communication whenever one part needs to send requests, stream data, or connect safely.

The generic HTTP layer provides common clients, request and response shapes, retries, streaming support, cookies, proxy settings, and TLS certificate handling, which is the security layer used for HTTPS. The app-server, exec-server, and relay transports are the longer-distance pipes: they carry messages, files, and encrypted WebSocket traffic between clients, servers, and remote machines. Managed proxying and local IPC, meaning communication between processes on the same computer, add controlled network forwarding, sandbox bridges, Unix sockets, Windows named pipes, and IDE links. MCP transport adapters connect the client to tool servers through memory, process input/output, or HTTP.

The direct library front doors, such as backend-client, chatgpt, and cloud-tasks-client, expose these tools in clean packages so callers do not need to know the internal layout. The Codex client error file gives all of this networking code a shared way to describe failures like timeouts, bad responses, and exhausted retries.

## Sub-stages

- [Generic HTTP client, TLS, cookies, and streaming transport foundations](stage-19.1.md) `stage-19.1` — 21 files
- [App-server, exec-server, and relay transport channels](stage-19.2.md) `stage-19.2` — 10 files
- [Managed proxying and local IPC transport substrates](stage-19.3.md) `stage-19.3` — 12 files
- [MCP and executor-backed transport adapters](stage-19.4.md) `stage-19.4` — 8 files

## Files in this stage

### Client crate surfaces
These files define the public module boundaries and exported APIs for the reusable client crates that other parts of the system consume.

### `backend-client/src/lib.rs`

`other` · `compile time and whenever other code imports the backend-client library`

This file does not contain business logic itself. Instead, it acts like a reception desk for the backend-client crate, which is a Rust library for talking to a backend service. The real work lives in two internal modules: `client`, which contains the code that sends requests and reports request errors, and `types`, which contains the data shapes used for requests and responses.

The important job here is to re-export selected names. A re-export means other code can import these items directly from `backend_client` without needing to know the library’s internal folder layout. For example, outside code can use `Client` or `AccountsCheckResponse` from this top-level library path, rather than reaching into `client` or `types` directly.

This matters because it creates a stable public surface. The maintainers can reorganize internal files later while keeping the same names available to callers. It also makes the library easier to learn: newcomers see the main client object, request error type, account and task response types, configuration bundle types, rate-limit credit types, and token-usage summary types all gathered in one place.


### `chatgpt/src/lib.rs`

`orchestration` · `cross-cutting`

This file is like the table of contents for the `chatgpt` library. It does not contain the working code itself. Instead, it names the main sections of the library and decides which sections are public doors that outside code can walk through.

The public modules are `apply_command`, `connectors`, `get_task`, and `workspace_settings`. Other parts of the project can import and use those directly. The `chatgpt_client` module is included too, but it is private, meaning it is meant to be used only inside this library. That usually means it is an internal helper: important to how the library works, but not something callers should depend on directly.

Without this file, Rust would not know how these source files fit together as one library. Code outside the library would also not know which features are intentionally available. In plain terms, this file defines the library’s public shape: what tools it offers to the rest of the project, and what machinery stays behind the curtain.


### `cloud-tasks-client/src/lib.rs`

`other` · `cross-cutting library import`

This file is the crate root, meaning it is the main file Rust shows to other code that depends on this library. Its job is not to do cloud-task work directly. Instead, it acts like a reception desk: it points to the real rooms inside the library and re-exports the important names from them.

The file declares two internal modules, `api` and `http`. A module is a Rust unit for grouping code. The `api` module appears to define the shared vocabulary of the client: task IDs, task text, task status, errors, result types, summaries, and the `CloudBackend` interface that describes what a cloud task service can do. The `http` module provides `HttpClient`, which is likely the concrete client that talks to a cloud service over HTTP, the common web protocol.

By using `pub use`, this file makes selected items available directly from the library root. That means users can write simpler imports, such as importing `HttpClient` or `TaskStatus` from `cloud_tasks_client`, without caring that those items live in `http` or `api` internally. Without this file, the library would either expose too much internal structure or force every user to know where each type is stored.


### Shared client errors
This file provides the typed transport and streaming error model used by client-side infrastructure.

### `codex-client/src/error.rs`

`data_model` · `request handling`

When the client talks to a remote service, many things can go wrong: the server may return an error status, the network may fail, a request may be built incorrectly, or a long-running stream may stop unexpectedly. This file collects those possibilities into two named error groups, so callers do not have to guess from loose strings or scattered error formats.

`TransportError` describes failures during ordinary request-and-response communication. For an HTTP error, it can carry the status code, the requested URL if known, response headers if available, and the response body if there was one. That extra detail is useful for debugging, like keeping the receipt when a delivery fails. Other variants cover retry limits, timeouts, network errors, and request-building errors.

`StreamError` is smaller and focused on streaming, where data arrives over time instead of all at once. It records either a general stream failure message or a timeout.

Both error types use `thiserror`, a Rust helper that makes errors display nicely while still behaving like normal Rust errors. Without this file, different parts of the client would likely report failures inconsistently, making retries, logging, and user-facing messages harder to understand.

## 📊 State Registers Touched

- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-tls-crypto-provider` — The one process-wide cryptography provider chosen early so HTTPS and other TLS connections use the same security engine.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-remote-control-relay` — The remote-control, relay, socket, WebSocket, and encrypted connection state used to connect clients and helper processes.
- `reg-network-proxy-policy` — The managed proxy and network-forwarding state that decides what network traffic is allowed, forwarded, or blocked.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-process-registry` — The shared record of running or tracked external processes, their identifiers, input/output streams, terminal sizes, and completion state.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-filesystem-watch-subscriptions` — Active file and directory watch subscriptions, invalidation signals, and watcher-to-client mappings used for skills, plugin/config refreshes, and app-server file APIs.
- `reg-attestation-state` — Client or host attestation provider state and generated proof metadata used to attach optional attestation headers to upstream requests.
- `reg-ide-integration-state` — Active IDE-link state such as connected IDE clients, workspace metadata, open file or selection context, and IDE details injected into prompts or server notifications.
- `reg-local-model-runtime-state` — Live readiness, endpoint, health, and launch/connect status for local model backends such as Ollama, LM Studio, and OSS helpers, separate from the model catalog itself.
- `reg-outgoing-transport-buffers` — Queued outbound protocol messages, write buffers, and backpressure state for app-server, daemon, exec-server, and remote transports.
