# Protocol schemas, shared types, and generated contracts  `stage-18` (cross-cutting infrastructure)

This stage is the system’s shared rulebook. It sits behind the scenes and supports every part of the lifecycle: startup, normal work, storage, networking, tools, and shutdown. Its job is to make sure all parts of the codebase describe data the same way, so messages sent over the wire, saved to disk, or passed between processes all match.

One part defines the core shared types: the common names and shapes for things like sessions, threads, tools, permissions, plugins, and errors. Another part defines the app-server protocol: the exact request, response, and notification formats, plus the JSON-RPC envelope, which is the standard wrapper around messages. It also keeps older client versions working and can export machine-readable schemas.

A third part provides generated contracts from backend API descriptions and protobuf, a compact binary message format, so code can use typed fields instead of raw payloads. Another covers edge-facing schemas for the public API, code mode, hooks, extensions, MCP, exec messages, and trace records. Finally, compile-time macros automatically tag experimental fields and register them, so the system can enforce feature rules consistently.

## Sub-stages

- [Core shared protocol and domain types](stage-18.1.md) `stage-18.1` — 46 files
- [App-server protocol schemas and transport contracts](stage-18.2.md) `stage-18.2` — 43 files
- [Generated backend and protobuf contracts](stage-18.3.md) `stage-18.3` — 24 files
- [API, extension, hook, MCP, and trace schemas](stage-18.4.md) `stage-18.4` — 60 files
- [API annotation macros and compile-time contract support](stage-18.5.md) `stage-18.5` — 1 files

## 📊 State Registers Touched

- `reg-config-layer-stack` — The ordered stack of raw config sources and layer identities that can be read, explained, edited, and saved later.
- `reg-feature-flags` — The set of optional or experimental features that are currently enabled for this run.
- `reg-permission-policy` — The resolved filesystem and network permission rules that decide what the app and its tools are allowed to do.
- `reg-rpc-handshake-and-protocol-state` — The per-connection protocol readiness and negotiated message rules established during the initial hello exchange.
- `reg-code-mode-runtime-state` — The live JavaScript/code-mode execution state, including loaded modules, timers, and session-facing runtime handles.
- `reg-tool-runtime-catalog` — The live set of callable tools and handlers, including shell, patching, web, memory, skills, image, code, and MCP-backed tools.
- `reg-protocol-contracts` — The shared message and schema definitions that keep requests, responses, notifications, and stored data consistent across components.
- `reg-remote-control-state` — The persistent and live state for remote-control enablement, pairing, client management, and status used by the server and external controllers.
- `reg-experimental-field-registry` — The compile-time/runtime registry of experimental protocol fields and feature tags used to enforce schema and feature-gating consistency across components.
- `reg-tool-schema-normalization-cache` — The cached normalized/cleaned tool and MCP schema shapes reused when exposing tools, validating calls, and avoiding repeated schema cleanup work.
