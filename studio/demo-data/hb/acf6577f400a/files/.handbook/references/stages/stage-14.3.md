# Extension and integration tools  `stage-14.3`

This stage is the system’s extension-facing execution layer: it sits across session startup and the per-turn tool path, connecting the core runtime to capabilities that come from MCP servers, plugins, connectors, hosted app integrations, and other non-core namespaces. Its job is to make those external capabilities discoverable, policy-checked, callable, and refreshable without hardwiring them into the core loop.

The MCP runtime, resources, and session integration sub-stage turns configured or plugin-declared MCP servers into live session connections, exposes their tools and resources, routes calls, and keeps auth, approvals, refresh, and resource access consistent as sessions change. Plugin and connector ecosystem management supplies the inventory and policy layer: it discovers installed and marketplace extensions, validates manifests, manages install/upgrade/remove flows, and determines naming, routing, provenance, and connector accessibility. Extension-backed tool runtimes and namespaces then assemble the actual turn-specific toolbox, publishing model-visible specs and executing dynamic, hosted, code-mode, memory, skill, web-search, and image-generation tools. Finally, app-server integration discovery and search adapters expose connector/app discovery and fuzzy file search to clients, turning backend integration data into user-facing APIs and updates.

## Sub-stages

- [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files
- [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files
- [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files
- [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files
