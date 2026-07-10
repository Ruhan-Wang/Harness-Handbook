# Extension and integration tools  `stage-14.3`

This stage is the system’s “extra tools desk.” It is mostly part of the main work loop: when the app is already running and needs something beyond its built-in abilities, these pieces decide what outside-powered tools exist, connect to them, and carry out requests.

One part is the live MCP connection layer. MCP is the protocol this app uses to talk to outside servers. It keeps those connections healthy, lists the tools and resources those servers offer, asks for approval when needed, and runs calls safely.

Another part manages plugins and connectors. Think of it as the store and inventory room for add-ons. It finds plugins, reads their manifests, installs or removes them, syncs remote copies, and decides which connectors and suggested apps should be shown to users.

A third part is the runtime for extension-backed tool namespaces such as web search, image generation, memories, skills, and code-mode helpers. It registers these tools, describes them to the model, checks inputs, and runs the real backend work.

Finally, app-server discovery and search adapters turn all that raw plugin and connector data into clean app lists and file-search results the client can use.

## Sub-stages

- [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files
- [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files
- [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files
- [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files
