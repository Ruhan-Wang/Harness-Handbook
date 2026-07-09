# Extension and integration tools  `stage-14.3`

This stage gives Codex its “extra equipment” beyond the core chat and code loop. It is mostly shared behind-the-scenes support, used during startup, while choosing tools during a turn, and when clients ask to discover apps or files.

The MCP runtime is the bridge to outside programs that use the Model Context Protocol, a standard way for other apps to offer tools and resources. It starts those servers, lists what they provide, checks permissions, and sends tool results back to the session.

Plugin and connector management is the supply chain. It finds, installs, updates, disables, and removes plugins, while deciding which connectors are visible and safe for a user.

Extension-backed tool runtimes turn those add-ons into usable tools for the model, such as web search, image generation, memories, skills, and long-running code cells. They build the tool menu, run selected tools, and report progress.

App-server discovery and search adapters are the front desk. They gather connector, app, and file-search results, clean and merge them, then return useful lists to the client.

## Sub-stages

- [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files
- [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files
- [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files
- [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files
