# API, extension, hook, MCP, and trace schemas  `stage-18.4`

This stage is cross-cutting contract infrastructure that sits at the system’s boundaries rather than in one execution phase. It supplies the typed schemas shared during startup, the main request/response loop, inter-process communication, extension integration, and post-run inspection, so independently implemented components can exchange data without ambiguity.

The code-mode protocol types define the public contract for describing tools, issuing exec and wait requests, returning text/image content, and coordinating long-lived sessions. The public API schemas do the same for external service traffic, fixing HTTP, websocket, image, search, event, and error payloads. Extension and hook contracts specify how hosts expose capabilities, how contributors and plugins receive lifecycle data, how shared state is stored, and how hooks are named, validated, and serialized. Tool and protocol schemas standardize model-visible tool specs, permission and approval payloads, planning messages, and MCP-facing tool configuration. MCP, exec, and sandbox wire models define JSON-RPC, JSONL, and framed IPC formats for exec servers, escalation paths, and sandbox runners. Finally, shared extension backend and rollout-trace models capture reusable backend state and compact trace structures so downstream tooling can reconstruct what happened across a run.

## Sub-stages

- [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files
- [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files
- [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files
- [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files
- [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files
- [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files
