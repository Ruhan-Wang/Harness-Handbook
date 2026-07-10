# Protocol schemas, shared types, and generated contracts  `stage-18` (cross-cutting infrastructure)

This stage is the project’s shared contract shelf. It sits behind the scenes and supports every phase of the system, from startup to the main work loop to saving results. Its job is to make sure every part of the codebase describes data the same way, so messages, saved records, and API calls all line up.

One part defines the core shared types: the common names and shapes for things like sessions, threads, tools, permissions, errors, and stored state. Another part defines the app-server’s wire contract: the exact message envelopes, versioned request and response formats, and schema exports that clients and servers exchange.

A third part covers generated contracts for backend services and protobuf, a compact binary message format used between services. These generated models let handwritten code talk to other systems without inventing its own structure. Another part adds schemas for public APIs, plugins, hooks, tool protocols, code-mode messages, and trace records. Finally, compile-time macro support automatically marks and tracks experimental API pieces while the code is being built. Together, these parts act like one rulebook for the whole system.

## Sub-stages

- [Core shared protocol and domain types](stage-18.1.md) `stage-18.1` — 46 files
- [App-server protocol schemas and transport contracts](stage-18.2.md) `stage-18.2` — 43 files
- [Generated backend and protobuf contracts](stage-18.3.md) `stage-18.3` — 24 files
- [API, extension, hook, MCP, and trace schemas](stage-18.4.md) `stage-18.4` — 60 files
- [API annotation macros and compile-time contract support](stage-18.5.md) `stage-18.5` — 1 files

## 📊 State Registers Touched

- `reg-remote-control-state` — The current remote-control enablement, pairing, and client connection state for controlling the app from elsewhere.
- `reg-code-mode-runtime` — The isolated JavaScript code-mode runtime state that survives long enough to manage timers, tool promises, and module execution.
- `reg-tool-catalog` — The current set of tools the model can call, including built-ins, plugins, MCP tools, web/image/memory helpers, and schemas.
- `reg-sandbox-and-exec-policy` — The active sandbox and command-execution rules that decide what commands, files, and network actions are allowed.
- `reg-exec-output-state` — The machine-readable exec-mode output stream state used to emit JSONL results and status updates for automation.
