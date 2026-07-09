# Protocol schemas, shared types, and generated contracts  `stage-18` (cross-cutting infrastructure)

This stage is shared behind-the-scenes support for the whole system. It defines the “contracts” that clients, servers, plugins, storage, and tools all rely on when they exchange data. A contract is the agreed shape of a message, like a standard form everyone fills out the same way.

The core protocol and domain types provide the common vocabulary: sessions, threads, events, approvals, tools, permissions, errors, settings, plugins, and saved conversation state. The app-server schemas define how the desktop or web client talks to the app server, including JSON-RPC envelopes, which are simple wrappers for requests, replies, and errors. The generated backend and protobuf contracts cover messages produced from outside specifications, such as OpenAPI web models and protobuf service messages. The API, extension, hook, MCP, sandbox, and trace schemas define public and cross-process messages for tools, plugins, execution, realtime streams, and saved run histories. Finally, the annotation macros run during compilation to mark experimental API pieces consistently. Together, these parts keep every component speaking the same language.

## Sub-stages

- [Core shared protocol and domain types](stage-18.1.md) `stage-18.1` — 46 files
- [App-server protocol schemas and transport contracts](stage-18.2.md) `stage-18.2` — 43 files
- [Generated backend and protobuf contracts](stage-18.3.md) `stage-18.3` — 24 files
- [API, extension, hook, MCP, and trace schemas](stage-18.4.md) `stage-18.4` — 60 files
- [API annotation macros and compile-time contract support](stage-18.5.md) `stage-18.5` — 1 files

## 📊 State Registers Touched

- `reg-collaboration-mode-catalog` — Built-in and configured collaboration-mode presets/templates that clients can list and apply to choose model, mode, reasoning, and prompt behavior.
- `reg-windows-sandbox-readiness` — Prepared Windows sandbox accounts, helper readiness, setup status, and client-visible sandbox availability separate from the policy rules themselves.
