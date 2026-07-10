# Extension and integration tools  `stage-14.3`

This stage is the system’s “extra abilities” layer. It runs during normal work, after startup has loaded settings and available add-ons. Its job is to make outside tools, connectors, and special namespaces usable in a live session, so the model can search the web, use memories or skills, call connected apps, or offer installation and discovery flows.

One part keeps MCP connections alive. MCP is a standard way to talk to outside tool servers. It turns saved connector settings into live sessions, lists the tools and resources those servers offer, runs calls, handles sign-in or approval prompts, and returns clean results.

Another part manages the plugin and connector ecosystem itself. It finds add-ons from disk, marketplaces, or remote servers, checks what is allowed, installs or removes them, keeps caches up to date, and exposes discovery and install-request features to users.

A third part is the runtime “switchboard” for extension-backed tools. It decides which tools appear each turn, makes different tool types look consistent, and routes calls for web search, image generation, goals, memories, skills, and sandboxed code execution.

Finally, app-server discovery code turns raw integration records into searchable, user-friendly app and file search results, with caching and background refreshes.

## Sub-stages

- [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files
- [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files
- [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files
- [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files
