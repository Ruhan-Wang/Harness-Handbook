# Protocol schemas, shared types, and generated contracts  `stage-18` (cross-cutting infrastructure)

This stage is the system’s shared contract library. It sits behind the scenes, but almost every part of the product depends on it during startup, normal work, storage, and communication with other services. Its job is to make sure everyone uses the same data shapes and meanings, like one set of official forms used across many offices.

The core shared types provide the common vocabulary: IDs, messages, permissions, errors, config, plugin records, and other basic concepts. The app-server schemas turn that vocabulary into actual request and response formats, including the JSON-RPC wrapper that carries calls and replies, plus versioned protocol definitions for old and new clients.

Generated backend and protobuf contracts connect this system to outside services. They are mostly produced from formal API descriptions, then cleaned up with small hand-written helpers so the rest of the code can use them more easily. Other schema groups define boundaries for public APIs, extensions, hooks, remote execution, tool calls, and trace records. Finally, compile-time macros automatically mark and track experimental API pieces, so new features can be introduced carefully and consistently.

## Sub-stages

- [Core shared protocol and domain types](stage-18.1.md) `stage-18.1` — 46 files
- [App-server protocol schemas and transport contracts](stage-18.2.md) `stage-18.2` — 43 files
- [Generated backend and protobuf contracts](stage-18.3.md) `stage-18.3` — 24 files
- [API, extension, hook, MCP, and trace schemas](stage-18.4.md) `stage-18.4` — 60 files
- [API annotation macros and compile-time contract support](stage-18.5.md) `stage-18.5` — 1 files

## 📊 State Registers Touched

- `reg-sandbox-policy` — The concrete file, network, workspace-root, and platform sandbox rules that approved commands and tools must obey.
