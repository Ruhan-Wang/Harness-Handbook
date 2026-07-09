# Extension and integration tools  `stage-14.3`

This stage is the system’s “extra abilities” layer in the main work loop. Once the core program knows what the user is asking for, this stage lets it reach beyond built-in features and use outside services, add-on tools, and app connections.

One part is the MCP runtime. MCP, short for Model Context Protocol, is a standard way to talk to external tool servers during a session. It keeps those connections alive, shows their tools and resources to the model, and manages sign-in, approval, reading data, and sending tool calls.

Another part manages the plugin and connector ecosystem. Think of it as a mix of app store and adapter shelf. It finds installed plugins, reads marketplaces, installs or removes add-ons, and decides which connectors and app integrations are available and allowed.

The extension-backed tool runtimes turn those add-ons into normal tools the model can use. They build the current tool menu and run things like web search, image generation, memories, skills, and code-mode helpers.

Finally, the app-server discovery and search adapters turn raw integration data into browsable app lists and fast file search results for clients. Together, these parts make outside capabilities feel like first-class tools.

## Sub-stages

- [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files
- [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files
- [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files
- [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files
