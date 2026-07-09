# System Handbook — Stage Index

Each stage below links to its full page; the paragraph is the stage's role in the system.

## [Process entrypoints and binary dispatch](stage-1.md) `stage-1` — 65 files

This stage is the system’s set of starting doors. It runs at process startup, when the operating system has launched a native binary and passed in the command name and arguments. Its job is to read what was invoked, understand the flags and subcommands, and hand control to the right runtime mode.

The primary user-facing launch surfaces are the main front desk. They route everyday commands into the text interface, one-shot exec mode, cloud tasks, desktop app launch, sandbox tools, remote control, doctor checks, MCP server commands, or session archive tools. They also define the options each mode accepts before the real work begins.

The auxiliary binaries and developer tools are the side workbench. They generate schemas, refresh protocol files, apply patches, search files, inspect logs, start helper services, run test clients, and launch commands inside safer restricted environments.

The directly assigned exec/src/main.rs is a small but important switch. It starts codex-exec, then decides whether to run the normal non-interactive agent or behave like the codex-linux-sandbox helper.

### [Primary user-facing launch surfaces](stage-1.1.md) `stage-1.1` — 19 files

This stage is the set of front doors users enter through. It sits at startup: before Codex can chat, run a task, open a desktop window, or diagnose a problem, these files read the command the user typed and route it to the right tool. The main CLI entry point chooses between the text interface, non-interactive exec mode, cloud tasks, desktop launch, sandbox tools, remote control, doctor checks, MCP server management, and session archive commands. The TUI and exec CLI files define the flags and prompts those modes accept, then their main files start the actual work and print final messages. Cloud task files connect terminal commands to cloud APIs, branch detection, task lists, diffs, and applying changes. Desktop files open or install the macOS or Windows app for the chosen workspace. Remote-control code starts or stops the app-server for outside access. Sandbox files run debug commands safely or prepare the Windows sandbox. Doctor files inspect local setup and conversation records. MCP and apply-command code connect Codex to external tools and bring agent-made code changes into the user’s checkout.

### [Auxiliary binaries and developer tools](stage-1.2.md) `stage-1.2` — 45 files

This stage is the toolbox beside the main Codex program. These binaries are run directly by developers, tests, editors, or helper processes, rather than through the normal user command. Some tools produce machine-readable descriptions: config_schema and schema.rs describe valid config.toml settings, protocol exporters write TypeScript and JSON Schema files, hook and app-server fixture writers refresh checked-in schemas, and generate-proto rebuilds Rust code from Protocol Buffers. Some tools do focused user work: apply_patch edits files from a patch, file-search finds likely matching paths, md-events shows how Markdown is parsed, and state logs_client watches stored logs like tail -f. Others start services or bridges: the app server, MCP server, Responses API proxy, stdio-to-socket bridge, exec server, filesystem helper, and test MCP/app clients. Several are samples or test probes, including extension examples, notification capture helpers, custom certificate checks, and Wine or Windows exec-server runners. The remaining tools enforce safe execution: execpolicy checkers decide whether commands are allowed, while Linux, Bubblewrap, Unix execve, and Windows sandbox launchers set up restricted environments before running commands.

## [Early process hardening and runtime bootstrap](stage-2.md) `stage-2` — 3 files

This stage happens at the very start, before Codex begins its real work. It is like locking the workshop, choosing the right power supply, and arranging the tool bench before anyone starts building. The process-hardening code tightens the running program’s defenses. On supported operating systems, it blocks or limits common ways another tool might inspect memory, create crash dumps, or tamper with the process. The rustls-provider code sets up the cryptography engine used by rustls, the library that makes secure TLS network connections. This matters because more than one engine may be available, and the program must choose one global provider early and consistently. The arg0 code shapes how the executable presents itself at launch. A single Codex binary can act like different helper programs depending on the name or hidden startup argument used. It also prepares early environment details, such as PATH aliases and .env variables, so later runtime setup can start from a predictable state.

## [Installation context, home discovery, and local environment probing](stage-3.md) `stage-3` — 12 files

This stage is early setup and shared support. Before Codex can load settings or run tools, it must learn “where am I, what machine is this, and what helpers can I use?” The home-dir code chooses the user’s Codex folder, using CODEX_HOME if set or ~/.codex otherwise. The install-context and managed-install code identify how Codex was installed, where bundled resources are, which executable is managed by the app, and on Unix can check its real path, version, and file fingerprint.

Several pieces probe the local working conditions. The shell snapshot code captures the user’s shell setup, like aliases and exported variables, so later commands feel like they ran in the user’s normal terminal. The environment and environment-provider code define available places to run commands: local machine, remote exec server, or neither. Windows helper materialization copies needed helper programs into a sandbox bin folder safely.

Diagnostics then report what was found. Doctor checks cover Git, system settings, launch details, and search-helper availability. Cloud environment detection finds suitable cloud workspaces. Hostname lookup gives the rest of Codex a consistent machine name for matching rules.

## [Configuration, feature resolution, and startup policy assembly](stage-4.md) `stage-4` — 105 files

This stage is the startup control room. It gathers every setting that can affect Codex before real work begins, then produces the final runtime configuration used by the app, server, tools, sandbox, and TUI.

First, the config ingestion parts read layered sources: managed policy, cloud settings, user and project files, thread overrides, and command-line flags. Shared CLI options, project-root markers, app-server config loading, and the central core config builder all feed into this. Requirements and permission files then turn human settings into concrete rules for files, network access, hooks, and sandbox limits.

Next, feature and catalog parts decide what is available: feature flags, models, providers, plugins, marketplaces, MCP tool servers, skills, presets, and bundled assets. Editing helpers safely update config files for plugins, marketplaces, and MCP servers, and migration code imports compatible external-agent settings.

Finally, the stage prepares policies for real execution. It resolves Windows sandbox permissions, executable paths, tool settings, service tiers, keymaps, and TUI persistence. Debug and config-lock files make the result explainable and repeatable, so later sessions can prove they used the same effective rules.

### [Config layer ingestion and requirements composition](stage-4.1.md) `stage-4.1` — 42 files

This stage is the system’s configuration intake and assembly line. It runs mostly during startup, and again whenever settings must be refreshed. Its job is to read settings from user files, administrator-managed files, cloud policy, command-line options, and session overrides, then turn them into one effective set of rules the rest of Codex can trust.

The core config loading part defines what valid settings look like, reads each layer, reports precise mistakes, merges layers in priority order, and records where each value came from. The requirements layering part does the same for safety rules: command permissions, sandbox limits, hooks, network policy, and allow or deny rules. It combines them carefully so security-sensitive settings are not accidentally weakened.

The configuration service part is the editing and support desk. It lets the app and daemon inspect or change settings, writes files safely, explains errors, and imports older settings when possible. Finally, config/src/lib.rs is the public front door for this whole library. It gathers the internal pieces and exposes the configuration tools other parts of the codebase should use.

#### [Core config schemas, diagnostics, merge, and layered loading](stage-4.1.1.md) `stage-4.1.1` — 22 files

This stage is the behind-the-scenes configuration workshop. It runs during startup and whenever Codex needs to rebuild its settings. First, schema files define what valid settings look like: config_toml, profile_toml, hook_config, mcp_types, tui_keymap, environment_toml, agent_roles, and schema cover normal settings, reusable profiles, hooks, MCP servers, keyboard shortcuts, execution environments, agent roles, and tests around those shapes. Next, strict_config and diagnostics check files carefully and explain mistakes with exact line and column locations.

The loading side gathers settings from many places. loader/mod is the main coordinator. layer_io and macos read administrator-managed settings. cloud_config_bundle, cloud_config_layers, and cloud validation turn cloud-delivered policy into ordinary layers. thread_config adds per-session settings, and overrides converts command-line flags into the same TOML-like shape.

Finally, state, merge, and fingerprint stack all layers in priority order, normalize names, remember where values came from, and detect changes. config_lock can save and later compare the exact resolved configuration, making runs repeatable.

#### [Requirements layering and execution-policy composition](stage-4.1.2.md) `stage-4.1.2` — 11 files

This stage is behind-the-scenes setup work. Before Codex starts running commands, it reads requirements.toml and other managed sources, then builds one clear rule set for what is allowed. config_requirements defines these high-level limits and keeps track of where each setting came from, so errors can point to the right source. requirements_layers/mod is the entry point for this combining system. layer cleans one raw requirements layer and separates normal settings from special ones, like execution policy, hooks, permissions, and sandbox rules. stack then assembles all layers into the final result.

Some fields need safer merging than simple “last one wins.” permissions keeps every denied read path from every layer. hooks combines hook event lists while preventing unsafe hook directory conflicts. rules preserves rule priority, keeping higher-priority rules first.

Execution policy is the command safety rulebook. requirements_exec_policy parses and validates it from requirements.toml. amend safely adds new allow or deny lines when a user approves something. network_proxy_loader turns config and policy into live network proxy settings and reloads them when files change. hooks/config_rules decides which saved hook settings are trusted enough to use.

#### [Configuration management services and editable persistence surfaces](stage-4.1.3.md) `stage-4.1.3` — 8 files

This stage is the system’s configuration “service desk.” It sits behind the main app and daemon, letting clients read settings, change them safely, import old settings, and get understandable errors when configuration loading fails. The app server request processor is the front desk: it accepts configuration requests, reports policy rules, applies changes, and refreshes running work so new settings take effect. The service layer behind it checks whether requested edits are valid, writes them to the right files, and warns when another configuration layer will override them.

The core edit code is the careful pen. It updates the user’s config.toml file, a human-editable settings file, while preserving formatting where possible and writing atomically, meaning it avoids leaving a half-written broken file. Its document helpers convert between TOML text and typed settings. Error handling turns configuration failures into clear JSON-RPC replies, with special guidance for cloud bundle sign-in problems. Migration code imports Claude-style agent settings and adds a default personality only when safe. The daemon settings file separately saves its small remote-control option as JSON.

### [Feature flags, provider catalogs, and built-in asset installation](stage-4.2.md) `stage-4.2` — 33 files

This stage is startup preparation. Before Codex opens a session or draws major UI screens, it builds the “menu of available things”: enabled features, known models, skills, plugins, tools, presets, and bundled assets.

The feature files define all feature flags, read them from TOML config, keep old flag names working, and enforce any flags that must stay on or off. The terminal experimental-features view lets users change some of those choices safely.

The skills files configure skills, install built-in system skills into CODEX_HOME, create default memory-extension instructions, then find, read, filter, and cache usable skill files from user, project, system, admin, plugin, and extra folders.

The plugin and marketplace files locate installed marketplaces, manage them from the command line, recognize plugins, and turn loaded plugin features into usable lists. MCP files then combine plugin, user, built-in, extension, and login-controlled tool servers into one catalog.

The model files define provider and model catalogs, apply local limits and defaults, and keep old preset keys working. Collaboration and approval preset files provide built-in working modes and permission levels. Finally, TUI files prepare model choices, update commands, and terminal pet images before the interface needs them.

## [Authentication, identity, and account readiness](stage-5.md) `stage-5` — 40 files

This stage is the system’s “who are you and what can you use?” checkpoint. It runs during startup, onboarding, account changes, and before network features need permission. First, the interactive and persisted login flows get the user signed in, refresh or store saved tokens, report status, and cleanly log out. They support browser login, device-code login, MCP login, and several safe storage places for secrets.

Next, provider and backend auth adaptation turns that identity into the right kind of badge for each service. Some requests use ChatGPT tokens, some use provider API keys, some use OAuth, and Amazon Bedrock may need AWS request signing, which proves a request came from a valid AWS identity.

The shared files tie this together. The auth manager loads, saves, refreshes, and rejects bad credentials. Token helpers identify personal tokens or agent identity tokens, validate personal access tokens, and decode ChatGPT ID tokens into plain account facts like email and plan. The installation ID gives this local Codex install a stable name. On Windows, sandbox user setup prepares special accounts so isolated work can run safely.

### [Interactive and persisted login flows](stage-5.1.md) `stage-5.1` — 15 files

This stage is the system’s sign-in and sign-out machinery. It is used during setup, onboarding, and later whenever the user checks status or changes accounts. The command-line entry point runs login, logout, and status commands, while the app server’s account processor answers account requests from the interface, such as auth state, limits, token use, and warning emails.

There are two main ways to sign in. The browser flow starts a tiny local web server, waits for the browser to return a temporary code, trades it for tokens, then saves them. The device-code flow shows a short code in the terminal, asks the user to enter it in a browser, and waits for approval; the terminal onboarding screen presents this same flow and ignores stale replies from old attempts. MCP server logins use a similar browser OAuth flow.

Behind the scenes, the login modules expose the right building blocks and shared error types. Storage code decides whether credentials go in an auth file, the operating-system keyring, encrypted local storage, or memory. Logout tries to revoke remote tokens, then removes local secrets.

### [Provider and backend auth adaptation](stage-5.2.md) `stage-5.2` — 19 files

This stage is shared behind-the-scenes support. It prepares the “ID badges” that later network clients attach to HTTP, websocket, and RPC requests. The model-provider front door and provider definition describe what a model service needs: its address, credentials, models, and features. The auth files then turn saved logins, provider API keys, external token commands, account routing IDs, and FedRAMP markers into bearer-token headers.

For Amazon Bedrock, the Bedrock files choose between a simple bearer token and AWS SigV4, Amazon’s method of signing a request to prove who sent it and that it was not changed. The AWS helper files load credentials and region settings, check they are usable, and add those signatures.

Agent identity files create or read cryptographic keys, register the running agent task, verify identity tokens, and build signed headers proving which agent made a request. The API auth and attestation files give the rest of the system one simple plug-in point for auth and optional proof metadata. Remote-control and MCP auth files decide when ChatGPT, bearer, or OAuth login is needed. The rate-limit reset processor uses backend auth to safely call an account action.

## [Persistence and local runtime services startup](stage-6.md) `stage-6` — 6 files

This stage runs during startup and prepares the app’s local storage so the rest of Codex can work safely. It is like opening a workshop before the day begins: checking the filing cabinets, updating their labels, and repairing any damaged drawers.

The main entry point is state/src/runtime.rs. It opens the local SQLite databases, which are small file-based databases, applies needed schema updates, and hands usable store objects to the rest of the program. state/src/migrations.rs defines those updates in a careful way so different Codex versions can share the same database without older versions crashing on newer changes.

Rollout data has its own path. core/src/state_db_bridge.rs gives core code a simple place to start and refer to the rollout state database. rollout/src/state_db.rs connects older session files on disk with the faster SQLite index, waits for copying to finish, and offers helpers to read or fix thread metadata.

If storage is broken, recovery code steps in. cli/src/state_db_recovery.rs explains startup failures to the user or moves bad state aside. state/src/runtime/recovery.rs backs up only damaged database files so fresh ones can be created.

## [Backend clients, remote catalogs, and startup refreshes](stage-7.md) `stage-7` — 22 files

This stage runs during startup and early background setup. Its job is to make the app ready to talk to outside services and local model tools before users depend on them. The cloud-config files load cloud-delivered settings: lib exposes the small public API, backend fetches bundles from the service, service chooses cache or network, and bundle_loader wires in login and starts refreshes. The model files ask Codex, OpenAI-compatible providers, Amazon Bedrock, Ollama, and LM Studio what models are available, then models-manager combines bundled, cached, live, and login-based choices into one usable menu. The OSS, Ollama, and LM Studio helpers check local model servers and prepare them when requested. Connector and plugin code fetches ChatGPT connector directories, workspace plugin settings, local plugin connectors, and the built-in plugin catalog, using caches and fallbacks so startup stays reliable. The MCP client starts or connects to tool servers and manages sessions and tokens. Smaller backend clients fetch ChatGPT tasks, rate-limit reset data, memory-write safety checks, and update notices, so the app can avoid wasted quota and show useful maintenance information.

## [Transport and server runtime initialization](stage-8.md) `stage-8` — 40 files

This stage sets up the communication roads used by server-style runs of the system. It happens during startup and then stays active during the main work loop, carrying requests, replies, and notifications between clients, servers, and helper processes. Most of these messages use JSON-RPC, a simple pattern where one side sends a named request in JSON and the other side sends back a matching response.

One part brings up the main app server and its daemon, which is a background process that can be started, stopped, checked, and reused. It opens transports such as standard input/output, Unix sockets, and WebSockets, then routes messages through the server and remote-control connections.

The other part starts sidecar servers: small helper services that sit beside the main process. Exec servers run commands through shared channels, encrypted relays connect remote clients safely, MCP servers expose tools, and proxy bridges connect local programs or network traffic under controlled rules. Together, these pieces form the switchboard that lets the rest of the system talk reliably.

### [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files

This stage is the system’s “switchboard” for bringing the app server to life and letting other parts talk to it. The daemon files manage a background server process: the main daemon coordinates start, stop, restart, setup, updates, and configuration; the backend helpers add shared setup and clearer errors; the PID backend uses a process-ID file to prevent duplicate servers and remove stale records. The daemon client, remote-control client, and doctor check connect to the local control socket to inspect status, check versions, or enable and watch remote control without unsafe side effects.

Inside the app server, the runtime loads configuration, opens transports, routes JSON-RPC messages, performs the initialize handshake, sends outgoing replies, tracks pending answers, and can also run embedded inside the caller. Transport files provide the roads: standard input/output pipes, a private Unix socket, WebSockets, and WebSocket authentication. Remote-control files enroll the server, remember whether remote control should be enabled, maintain the remote WebSocket, track remote clients, reconnect, pair, revoke, and preserve messages. Client facades then give CLI and TUI code one simple way to send requests and receive events.

### [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

This stage is the “sidecar” layer: helper servers and bridges that run beside the main Codex process. They expose Codex abilities over specific communication routes during startup and the main work loop. The exec-server files define the public library, choose how clients connect, and turn WebSockets, standard input/output, child processes, or encrypted relays into one JSON-RPC channel, meaning structured request-and-response messages. Its client code sends command and file requests and safely routes process output back.

The Noise relay and remote files add encrypted WebSocket plumbing, so a cloud rendezvous service can connect clients to executors without reading or forging their messages. MCP files start tool servers, describe their runtime environment, connect over standard input/output locally or remotely, load available tools, filter them, and shut down cleanly. The prototype MCP server wires terminal streams into Codex’s message processor.

Other sidecars are practical bridges. stdio-to-uds connects terminal-style programs to Unix sockets. The Responses API proxy forwards only approved local HTTP requests with real credentials. The network proxy starts HTTP and SOCKS listeners, assigns safe ports, sets child-process environment variables, and enforces network rules before traffic leaves.

## [Frontend session startup and user-facing initialization](stage-9.md) `stage-9` — 41 files

This stage happens after the backend services are ready, but before the user can really start working. It is where Codex turns its prepared engine into something a person or script can use.

For the interactive terminal app, the TUI startup path opens the front door. It loads settings, connects to the app server, guides first-time users through sign-in and trust choices, checks project setup, and builds or resumes the visible chat. It also takes careful control of the terminal window: drawing the interface, reading keys, handling resize and suspend, showing notifications, and restoring the shell when finished.

For non-interactive use, exec mode starts a single scripted session instead of a full screen app. It gathers the prompt, configuration, saved session details, or review request, then runs once and writes predictable output, such as JSON lines for other programs to read. The resume helper makes sure an old conversation restarts with the right folder and model. Together, these parts make Codex ready for either a human at a terminal or an automation script.

### [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files

This stage is the front door of the terminal app. It runs before the main chat loop, then keeps owning the terminal safely while the app is open. The startup code loads settings, connects to or starts the app server, chooses local AI providers when needed, checks changed project hooks, offers updates, model moves, working-directory choices, and imports from other agents. Onboarding screens guide first-time users through welcome, sign-in, and trusting the project folder, using built-in keys so the flow works before custom settings exist.

Once startup choices are settled, the App builds or resumes a chat thread, can show a session picker, constructs the main chat widget, replays old conversations without rerunning actions, and displays startup cards, tips, MCP server progress, collaboration modes, pets, and status previews. The terminal layer is the machinery underneath: it probes terminal abilities, enables safer keyboard input, draws efficiently, handles resizing, title changes, suspend/resume, stderr noise, clipboard-style notifications, bells, and desktop notification escape codes. Together these pieces turn a normal shell window into Codex’s interactive workspace, then restore it cleanly afterward.

### [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

This stage is about starting a one-shot, non-interactive Codex run. Instead of opening a long-running text interface, it prepares one session, feeds in the prompt or resume information, runs the work, and finishes. It is mainly used by scripts, automation, or commands like codex exec, where output must be predictable.

exec/src/lib.rs is the main driver for this mode. It gathers instructions from command-line flags, config files, standard input, and saved session data. It can start a new request, continue an old session, or run a review. It also arranges output so that normal results can be read safely by other programs, for example as structured JSONL, which means one JSON record per line.

tui/src/session_resume.rs supports the resume path. It works out which saved conversation to use, which folder it belonged to, and which model should continue it. If the saved folder is not the user’s current folder, it asks what to do. Together, these pieces make sure a scripted run starts with the right context and can proceed without an interactive work loop.

## [Main event loop and request dispatch](stage-10.md) `stage-10` — 137 files

This stage is the system’s normal working loop, after startup is finished. It is the traffic control center for everything that happens while the app is running. On the user side, interactive event dispatch turns keyboard input, paste events, terminal resizing, redraw requests, and background updates into clear app actions, then sends them to the right screen area or chat thread.

On the server side, RPC request routing handles JSON-RPC messages, which are structured requests with names, data, and replies. It checks each request, chooses the right subsystem, and sends back results or errors. The exec server processor does this for each remote execution connection, reading requests, dispatching actions, writing replies, and cleaning up afterward.

Inside a live Codex session, session handlers act like a command desk for user messages, approvals, setting changes, rollbacks, reviews, voice input, and shutdown. Request serialization keeps requests that touch the same resource in a safe order, while allowing unrelated work to continue. Parallel tool handling decides which tool calls can run together, formats their results, and makes cancellation reliable.

### [Interactive event dispatch](stage-10.1.md) `stage-10.1` — 96 files

Interactive event dispatch is the terminal app’s live traffic system during normal use. It takes raw activity from the keyboard, paste buffer, terminal window, server, and background tasks, then sends each event to the right place.

At the outer edge, event_stream turns low-level terminal signals into app-friendly events like key press, paste, resize, focus change, or redraw request. It also fully releases the terminal input reader when the TUI is paused, so another program can safely read from standard input.

App-level dispatch is the main switchboard. It receives these events, routes them to the correct chat thread, tracks pending server questions, and asks for screen redraws without wasting work. The bottom-pane stage handles the message composer, slash commands, popups, prompts, history search, and “@” mention search. The chat widget stage applies events to the visible conversation: sending messages, queuing drafts, showing streaming replies, running commands, and managing interrupts. Specialized handlers cover side flows such as task lists, thread navigation, backtracking, pagers, keymap editing, theme picking, pets, clipboard actions, and imports.

#### [App-level event dispatch and thread routing](stage-10.1.1.md) `stage-10.1.1` — 10 files

This stage is the TUI’s main traffic system during normal use. It sits between the user, the screen, the app server, and multiple chat threads. app_event_sender gives other UI code a simple way to send actions into the main loop. app_command defines the allowed kinds of actions, so messages have clear meaning. event_dispatch is the central switchboard: it receives each event and sends it to the right handler.

User key presses go through input, which handles global shortcuts such as switching threads, opening views, clearing the screen, or backing out with Escape. frame_requester asks for screen redraws in a careful way, combining repeated requests so the UI does not waste work.

Messages from the app server go through app_server_events. Server requests that need a later user answer are tracked by app_server_requests. pending_interactive_replay remembers which prompts are still unresolved when a thread is replayed. thread_routing keeps events and actions tied to the correct conversation thread. background_requests runs slower server queries off to the side, then returns their results as normal app events.

#### [Bottom-pane composer, popups, and mention input](stage-10.1.2.md) `stage-10.1.2` — 42 files

This stage is the control center for the terminal app’s bottom pane, where the user types messages, chooses suggestions, answers prompts, and changes small settings. It is part of the main work loop. The bottom pane decides whether each key press belongs to the chat composer, a popup, a modal form, or an interrupt action.

At its core are the shared bottom-pane view contract, the pane controller, the reusable composer widget, and the text area. These keep typing, cursor movement, wrapping, paste detection, Vim-style edits, attachments, draft text, footer hints, and popup state working together. History files add Up/Down recall and Ctrl+R search. Slash-command files parse commands like “/status”, decide which ones are allowed, show suggestions, and run the chosen command.

Mention and search pieces power “@” style insertion. They build searchable candidates from files, skills, and plugins, filter them, and draw the popup and footer. Reusable picker views provide lists, multi-select menus, and search panels. The remaining popup views handle settings, skills, memories, hooks, custom prompts, feedback, app-link requests, server questions, and user-input overlays, all using the same bottom-pane machinery.

#### [Chat widget interaction and command flows](stage-10.1.3.md) `stage-10.1.3` — 23 files

This stage is the main control room for the terminal chat screen. It runs during normal use, after startup, while the user is talking to the agent. The central chat widget keeps the transcript, input box, status messages, popups, and streaming replies in sync. Rendering turns that state into terminal rows. Protocol files listen for server events and turn them into visible changes, such as approvals, tool prompts, review results, and notices.

User input passes through several gates. Interaction handles keys, paste, images, copy, interrupt, and quit. Input submission and input flow decide whether text is sent now, queued, treated as a slash command, or held until the current turn finishes. The queue and restore code protect drafts, rejected messages, steering instructions, and attachments from being lost.

Other parts add focused features. Slash dispatch runs commands like `/new` or `/diff`. Skills, connectors, IDE context, goals, hooks, usage, tokens, reviews, model popups, plan implementation, and reasoning shortcuts build the small menus and actions around chat. Interrupt and notification helpers make sure prompts and alerts appear in a useful order.

#### [Specialized interactive flows and auxiliary TUI handlers](stage-10.1.4.md) `stage-10.1.4` — 20 files

This stage covers special side flows in the terminal interface. These are not the main chat loop, but popups, pickers, previews, and helpers that users open while working. The cloud-tasks files form a small app inside the app: one file stores the task list, selected row, popups, and loaded details; another stores the “new task” form; the UI file draws the list, editor, overlays, confirmations, and spinners.

Several files support navigation through complex conversations. Agent navigation and multi-agent display keep agent threads in a stable order, show readable status rows, and let users switch agents. Backtrack lets a user return to an earlier prompt and roll the conversation back. Pager overlays show long transcripts or help pages.

Other files customize the interface. The keymap files provide the shortcut editor, action catalog, searchable picker, and keypress inspector. Theme picker previews and saves color themes. Pet files handle selecting, previewing, drawing, disabling, and cleaning up the companion pet.

Finally, platform actions, clipboard paste, and external import flows connect the app to the outside world: operating-system checks, pasted images or paths, and importing settings from Claude Code.

### [RPC request routing](stage-10.2.md) `stage-10.2` — 37 files

This stage is the system’s set of switchboards during normal operation. Messages arrive as JSON-RPC requests, meaning named messages with parameters and replies, and these files send each one to the right worker. The app server’s message processor checks that a client is ready, then request_processors fans out to specialists for catalogs, environments, external-agent imports, MCP servers, conversation turns, threads and goals, thread deletion, Windows sandbox setup, files and file watching, feedback, Git diffs, marketplace changes, plugins, remote control, and search. Small helpers shape model lists, attestation headers, dynamic tool results, and clear error replies.

The core tool router and registry do the same job inside conversations: validate a requested tool, run safety checks, call the tool, and return a readable result. The TUI routing map decides which thread should receive each update. The exec server has its own RPC wiring, registry, connection handler, file-system handler, and process handler for remote execution work. The MCP server routes MCP messages and runs Codex tool calls, while RMCP client handlers pass logging and user-question requests onward. The HTTP proxy routes network requests through policy checks.

## [Thread and session orchestration](stage-11.md) `stage-11` — 44 files

This stage is the traffic desk for long-running conversations. It sits between startup and the main work loop: before the agent can answer, it must know which thread it belongs to, what history to load, where to run commands, and who is listening for events.

The library entry files expose the stable “front doors” to this core machinery. The thread manager and Codex thread wrapper create, resume, fork, switch, and shut down conversations. Session files then build the live workspace: model access, permissions, tools, environment, history, input queues, turn state, and background task control. Storage files create local records, keep live thread handles, trim history at safe turn boundaries, and update searchable metadata.

Server-side files attach clients to running threads, support reconnects, refresh MCP configuration, filter visible threads, and clean up unused sessions. Import files detect outside agent histories and decide whether they are safe to bring in. Extension files add goals, skills, and plugin-provided MCP servers. Tool handlers let the model request a new context window or update its plan. TUI files keep the terminal’s view, settings, side chats, goals, and active-turn display synchronized with the live thread.

## [Prompt, context, and extension assembly](stage-12.md) `stage-12` — 74 files

This stage is the prompt-building workshop. Just before the system sends a turn to the model, it gathers everything the model is allowed to see and shapes it into one clear input package. Some parts provide the raw shelves and labels: shared prompt templates, context fragment formats, and extension hooks so built-in code and add-ons can add text in predictable places.

Other parts create the actual note cards that go into the prompt. They turn settings and events into model-readable messages: project instructions, permissions, network rules, available skills, memories, goals, IDE details, plugin and app connectors, review requests, and warnings about space limits. They also keep older saved warning formats understandable.

The turn assembly parts then combine these pieces with the conversation history. They trim old messages when the model’s memory space is limited, remove items the chosen model cannot use, and send only changed context when possible. Realtime startup and developer prompt-debugging use the same machinery to build their own opening briefings.

### [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files

This stage is shared behind-the-scenes support for building what the model sees. It does not run the main work itself. Instead, it provides the shelves and labels for prompt text and context snippets, so later code can assemble them safely and in the right order.

The `codex-home` front door exposes the provider for user instructions, hiding the internal layout. `collaboration-mode-templates` bundles ready-made collaboration instructions into the program, like built-in note cards. The `prompts` front door collects prompt text, helper code for building prompts, and review-related types into one place.

The `context-fragments` files define and export the common shape of a context fragment: a small piece of information injected into the conversation. They also let the system recognize its own injected fragments later. The extension prompt contributor file gives add-ons a labeled way to contribute prompt text to specific prompt sections. Finally, the core context files re-export permission instructions and other context pieces from convenient locations, making them easy for the rest of the system to use.

### [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files

This stage supplies the raw “building blocks” that later prompt assembly uses before the model is called. It is shared behind-the-scenes support, like labeled note cards that can be slipped into a conversation. The prompt asset files expose fixed template text for hierarchical agents, apply_patch instructions, compact summaries, and realtime start, backend, and end prompts, so Rust code can use stable names instead of reading files directly. The context fragment files turn real events and settings into clearly labeled messages: extra context, loaded skills, hidden internal guidance, available skills, saved command prefixes, environment facts, guardian review reminders, hook text, model-switch instructions, network rules, token budget warnings, aborted turns, project user instructions, user shell commands, realtime opening and closing instructions, and subagent status updates. Each wrapper chooses the right speaker role, tags, and wording so the model can tell what the information means. A few files recognize old warning formats for apply_patch, model mismatch, and process limits, so older saved conversations can still be read safely. Together, these pieces make prompt content consistent and recognizable.

### [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files

This stage is behind-the-scenes prompt assembly. It gathers all the extra guidance the model should see before or during the main work loop, like notes placed on a workbench before starting a task. Some files load standing instructions: global Codex instructions, project AGENTS.md files, collaboration mode, personality style, terminal formatting, IDE context, image-save notes, and permission rules. Others describe optional capabilities. Skills code selects skills named by the user, removes duplicates, bridges Codex data into the skills system, and renders available or enabled skills within a size limit. App and plugin code similarly lists connectors, plugin tools, servers, and plugin-specific guidance only when they exist or are mentioned. Code-mode support reshapes tool descriptions for a stricter runtime format. Extension examples show how prompt snippets can be added with shared state. Memory files decide when memories apply, summarize saved memories, and build prompts for writing or merging them. Goal files create reminders about objectives and budgets. Review files turn review requests and endings into clear prompts. Together, these pieces make the model’s context accurate, relevant, and not overloaded.

### [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

This stage prepares the exact package of information the model sees before it answers. It sits in the main work loop, just before a new turn is sent, and it also supports realtime startup and debugging.

The turn context builder creates one reliable snapshot of the session: model choice, file locations, allowed tools, permissions, and settings. The history manager keeps earlier conversation turns, trims them to fit the model’s limited memory space, and can roll back or clean them. Normalization keeps tool requests matched with their results and removes data the selected model cannot use, such as images for a text-only model.

Additional context and context update code work like change notices. They send only what changed, such as new permissions or environment details, instead of repeating the whole setup. Token budgeting adds warnings when the conversation is filling up the available space.

Special user-message context is separated from normal human text. Realtime files build the startup briefing and choose the realtime instruction prompt. Prompt debugging assembles a visible test prompt for developers. Web search history extracts only recent useful text for standalone searches.

## [Turn execution and model interaction](stage-13.md) `stage-13` — 88 files

This stage is the heart of the session’s main work loop. It begins when the user sends a turn and ends when the assistant has answered, run needed tools, or prepared another model pass. The regular task starts a normal turn, while session/turn.rs coordinates the whole path: gather input, attach tools and context, call the model, stream updates, run tool calls, and finish bookkeeping. turn_metadata.rs adds useful background to each request, such as workspace and safety settings.

When a conversation grows too large, the compact task, compact.rs, and compact_remote.rs shrink it into a shorter summary, either locally or through the model service, so the session can continue.

Model transport execution is the “phone line” to model services. It builds requests, sends them over HTTP, server-sent events, WebSocket, or realtime audio links, decodes streamed replies, and handles retries or failures.

Streaming reduction and UI projection turn many tiny raw events into readable transcript cards, live text, tool statuses, diffs, and final history.

The code-mode runtime files run user JavaScript inside V8, load the main module, block unsupported imports, and provide timers like setTimeout.

### [Model transport execution](stage-13.1.md) `stage-13.1` — 28 files

This stage is the network layer for talking to model services during the main work of a session, with a little startup help. Shared request plumbing in client_common, responses_metadata, responses.rs, and tools/responses_api shapes Codex turns, IDs, metadata, and tool descriptions before they leave the app. The main client chooses HTTP streaming or WebSocket, adds authentication, sends the request, records telemetry, and uses retry policy when a stream fails.

Endpoint clients are the doorways to specific remote jobs: Responses, compact history, memories, images, search, and realtime calls. Their companion decoders turn raw server streams, JSON, SSE events, WebSocket messages, or WebRTC answers into clear Codex events and typed results. api_bridge makes network and HTTP failures understandable to the rest of the program.

Realtime files are the live conversation machinery. They hide protocol version differences, build outgoing voice/text messages, decode incoming events, and run WebSocket or WebRTC audio sessions. Higher-level orchestration starts realtime conversations, prewarms connections during session startup, and runs remote compaction so long chats stay usable.

### [Streaming reduction and UI projection](stage-13.2.md) `stage-13.2` — 51 files

This stage is the live “make it readable” part of the main work loop. As the assistant, tools, and server send small events, it turns them into clean text, stable transcript entries, and status messages the user can understand. The stream parsers strip hidden citation, plan, and Git-action markers from assistant text while saving their structured meaning. Markdown streaming and table holdback delay unsafe fragments, especially half-built tables, until they can be rendered without flicker or bad wrapping. Markdown, syntax highlighting, diff rendering, and table conversion then turn text, code, and file changes into styled terminal lines.

The streaming controller, chunking, and commit-tick code decide when queued text becomes permanent history and when it stays as a live tail. History-cell and exec-cell files define the many transcript “cards”: user and assistant messages, plans, approvals, searches, tool calls, notices, patches, hooks, commands, and MCP activity. Chat-widget files keep the active turn, command lifecycle, hooks, user drafts, status line, token usage, and live assistant output in sync. Resize and consolidation code rebuild final transcript state safely, while API and watcher helpers translate rate limits, process output, and other low-level events into user-facing updates.

## [Tool execution, approvals, and guarded side effects](stage-14.md) `stage-14` — 294 files

This stage is the system’s guarded action layer. It runs during the main work loop whenever the model asks to do something outside plain text, such as run a command, edit a file, call a web or MCP tool, use memory, or ask the user for approval. It is like a workshop with a front desk, safety officer, tool shelves, and locked work areas.

The approval, guardian, and hook parts decide whether an action may continue, needs user permission, or must be blocked. The execution backends then do the hands-on work: shell commands, interactive programs, file patches, sleeps, and remote or sandboxed file access. The extension tools connect extra equipment, including MCP servers, plugins, web, images, skills, and code cells. The policy and parsing helpers inspect commands and build the sandbox rules that limit what a tool can touch.

The shared tool files define the common shape of tools, their input schemas, MCP conversions, and error types. The handler front door routes each requested tool to the right runner and turns the result back into protocol messages the model can understand.

### [Approval, guardian, and hook mediation](stage-14.1.md) `stage-14.1` — 63 files

This stage is the system’s safety and permission hub. It sits mostly in the main work loop, just before the assistant does something with side effects, such as running a command, editing files, using the network, calling an external tool, or stopping a session.

Its policy engines are the rulebook. They read configured rules and decide whether an action is allowed, denied, or needs a prompt. Guardian review is the careful supervisor: for risky requests, it can run a separate review session and turn that review into a clear yes, no, timeout, or abort. Hook mediation is the checkpoint network. It discovers trusted user hooks, runs them at moments like prompt submit or tool use, and turns their output into “continue,” “block,” “warn,” or “change this” decisions.

Permission ingress is the front desk for “may I?” requests from the model or connected MCP tools. Tool orchestration and the approval UI then show requests to the user and route answers back. Finally, enforcement runtimes make decisions real by limiting network access and sandbox behavior while commands run.

#### [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files

This stage is the system’s safety gate. It works behind the scenes whenever a shell command, code patch, network request, or sandbox change is about to happen. Its job is to answer: allow it, block it, or ask the user first.

The newer execpolicy library is the main rule engine. Its front door exposes the useful pieces. Its parser reads policy files written in a small Starlark-based language, meaning a simple scripting format for rules. The rule and policy files define what rules look like, check examples, match commands or hosts, and produce allow, deny, or prompt decisions.

The core files connect those decisions to real tools. sandboxing defines the shared approval and sandbox contract. exec_policy loads and updates command and network rules. network_policy_decision turns network events into clear approval prompts and saved rules. safety does the same kind of gatekeeping for file-writing patches.

The legacy execpolicy library keeps older rule formats working. It parses old policies, matches program arguments, checks per-program rules, validates examples, and ensures commands cannot read or write outside approved folders.

#### [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files

This stage is a behind-the-scenes safety checkpoint in the main work loop. Before Codex takes a risky action, such as running a command, changing files, using the network, or calling an external MCP tool, Guardian may review it instead of immediately asking the user. It acts like a careful supervisor beside the main worker.

The front door in `guardian/mod.rs` decides when Guardian can automatically allow or deny a request, and includes a safety brake if too many actions are rejected. `approval_request.rs` describes the kinds of actions that may need approval and reshapes them for prompts, logs, safety checks, and conversation records. `prompt.rs` builds the message sent to the Guardian reviewer and reads the reviewer’s structured JSON answer.

The review itself runs as a separate mini-session. `session/review.rs` sets up that special review turn with its own model, limits, tools, and user-interface signal. `review_session.rs` manages whether to reuse an existing reviewer or start a temporary one, then handles timeouts and cancellation. Finally, `review.rs` turns the reviewer’s decision into an approved, denied, timed-out, or aborted result for the session, interface, and analytics.

#### [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files

This stage is the system’s checkpoint network. It runs user-configured hooks, which are small external commands, at key moments in the conversation: session start, prompt submit, tool use, permission checks, compaction, and stopping. The registry and engine module are the front desk. They build the hook system, list hooks, preview them, and route events to the right runner, while still supporting the older notify path. Discovery finds hook definitions in config, policy, and plugins, then checks whether they are trusted. The dispatcher chooses which hooks match an event. The command runner starts those hooks as real processes, sends them JSON input, and captures results. The output parser turns their printed text into decisions the system understands, and output spill saves oversized output to a temp file with a short preview. The runtime connects all this back to the main conversation, progress reporting, telemetry, and added context. Event handlers apply the decisions: start and prompt hooks may add context or stop work; pre- and post-tool hooks may block, rewrite, warn, or continue; permission hooks approve or deny; compaction hooks guard history shrinking; stop hooks decide whether to end, block, or continue.

#### [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files

This stage is the front desk for requests that need a human or policy decision. It sits in the main work loop, when the assistant or an outside MCP integration needs permission, confirmation, or extra information before continuing. MCP means “Model Context Protocol,” a way for other tools to connect to Codex.

The permission request handler lets the model ask for broader access, such as using a file or action that is currently blocked. It checks the request, connects it to the correct workspace, and sends it into the session’s approval path. The user input handler does a similar job when the assistant must pause and ask the human a question, then returns the answer as tool output.

For MCP traffic, elicitation decides whether an outside request is safe to accept, must be rejected by policy, or should be forwarded for review. The exec approval code asks an MCP client before running a shell command. The patch approval code asks before applying code edits. Together, these pieces normalize many kinds of “may I?” and “please answer” moments into the same review machinery.

#### [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files

This stage sits in the main work loop, whenever the assistant wants to do something that may affect the user’s machine or data. The core orchestrator is the traffic controller: it checks whether a tool needs permission, chooses a safety sandbox, runs the tool, and may ask again with broader access if the sandbox blocks it. MCP tool approval templates turn external tool-server requests into plain questions instead of raw names and JSON.

The terminal UI then makes those decisions visible. Approval events store requests in a safe displayable form, while the approval overlay shows the actual pop-up and sends back approve or deny. Tool requests puts these decisions into the chat screen. Permission popups and the permissions menu let users choose or change how much freedom the assistant has, including reviewing automatic denials. Auto-review denials keeps a recent list of blocked actions with readable labels. Pending thread approvals warns when background agent threads are waiting. Request user input handles structured questions and typed answers. Windows sandbox prompts guide Windows users through safe setup. Hooks RPC checks server-side hooks and records the user’s trust choices.

#### [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files

This stage is shared execution-time protection. It sits behind tool runs and approval-gated actions, making sure decisions about network access and sandbox safety are actually enforced while commands are running.

The network proxy pieces act like a guarded doorway to the internet. The library front door exposes the proxy parts other code may use. Its state builder turns requested settings into safe live settings, rejecting anything that would break central limits. The approval code handles “unknown host” cases by asking the right reviewer, remembering session-wide answers, and returning clear errors when access is denied. The network policy code decides allow, deny, or ask, and records why. The runtime is the proxy’s live rulebook: it checks hosts, HTTP methods, Unix sockets, and interception hooks, reloads changes, and logs blocked requests.

The Windows sandbox pieces enforce similar limits at the operating-system level. One file grants safe extra read access when needed. Others track and clean up read-deny rules, make protected workspace folders read-only, and install Windows Filtering Platform firewall rules. The setup wrapper applies that network lockdown defensively and records whether it worked.

### [Execution backends and sandboxed command runtimes](stage-14.2.md) `stage-14.2` — 91 files

This stage is the system’s safe command-running workshop. It is used in the main work loop when the assistant needs to run a shell command, edit files with apply_patch, start an interactive program, or pause briefly with the built-in sleep tool. It also provides shared support behind the scenes so those actions work locally, remotely, and across operating systems.

The command orchestration pieces act like the front desk: they receive requests, check rules, start commands, stream output, accept input, cancel work, and clean up. The unified-exec and PTY/process backends are the engine room, keeping interactive sessions alive through pipes or terminal-like connections. The patch engine is the file-editing arm: it recognizes patch requests, parses them, applies changes, and reports what happened.

Sandbox selection and platform launchers are the safety cage. On Unix they choose Linux or macOS restrictions and handle permission escalation. On Windows they create restricted users, permissions, firewall rules, and process settings. Exec-server filesystem services let local, sandboxed, or remote commands read and write files safely. The sleep tool simply waits, but can be interrupted when new user input arrives.

#### [Execution-facing app-server and core command orchestration](stage-14.2.1.md) `stage-14.2.1` — 15 files

This stage is the system’s command-running control room. It sits in the main work loop, where user or assistant requests become real programs running on the computer, but with checks and safety rules in between.

On the app-server side, command_exec_processor.rs, command_exec.rs, and process_exec_processor.rs translate client messages into process actions: start a command, send input, resize a terminal, stop it, watch its output, and clean up afterward. The TUI helpers, fs.rs and workspace_command.rs, let the text interface ask the app server to read or write files and run small workspace commands, whether the workspace is local or remote.

In core, exec.rs is the actual child-process runner, while sandboxing/mod.rs packages commands for restricted execution. user_shell.rs runs explicit user shell commands and records their progress. The shell handlers and runtimes check permissions, prepare environments, emit progress, support cancellation and hooks, and then launch commands safely. unified_exec.rs and exec_command.rs provide a newer single front door for execution requests. zsh_fork_backend.rs adds a special supported zsh path when needed.

#### [Unified-exec sessions and PTY/process backends](stage-14.2.2.md) `stage-14.2.2` — 17 files

This stage is the low-level machinery that lets the system run interactive commands, keep them alive, talk to them, and stop them safely. It sits behind the main tool loop: when a command is approved, these pieces turn that request into a real process and stream its output back.

The unified_exec front door defines the shared request shapes, limits, and helpers, while its errors file gives the whole area one clear failure language. process and process_manager are the control room: they start commands, reuse sessions, collect output, send later input, track exits, cancel work, and clean up. The write_stdin handler is the small inlet that sends more text into an already-running command.

On the exec-server side, process defines the common process contract. local_process runs commands on the server machine, and remote_process makes a remote command look local. spawn is the safe doorway for launching programs with the right folder, environment, network, and input/output setup.

The pty utilities provide the actual plumbing: pipes for simple programs, PTYs, or “fake terminals,” for interactive ones, process groups for cleanup, and Windows ConPTY bridges for terminal behavior on Windows.

#### [Patch application engine and patch-execution adapters](stage-14.2.3.md) `stage-14.2.3` — 9 files

This stage is the editing engine for the system. It is used during the main work loop when the assistant wants to change files. First, apply_patch_spec defines the “apply_patch” tool: its name, description, and the exact patch format the assistant must use. The parser and streaming_parser read that patch text. The normal parser waits for the whole patch and turns it into clear actions like add, delete, update, or move a file. The streaming parser can understand the patch while it is still arriving, so progress can be shown early.

The invocation code decides whether some command text is truly an apply_patch request, not just an ordinary shell command. The core apply-patch library then performs the actual file edits and records what succeeded or failed. The core handlers and runtime adapters act like safety gates: they validate the request, check policy, ask for user approval if needed, choose the right sandboxed environment, run the edit, and report results. For Git-based patches, git-utils applies them through Git and explains which files applied, skipped, or conflicted.

#### [Sandbox selection and Unix platform launchers](stage-14.2.4.md) `stage-14.2.4` — 16 files

This stage is shared behind-the-scenes support for running commands safely on Unix systems. It sits just before a tool or shell command is launched. Its job is to choose the right sandbox, rewrite the launch request, and, when needed, ask for permission to run with more power.

The sandboxing front door and manager provide the common entry point. They hide Linux and macOS differences, decide if a sandbox is needed, and turn a normal command into a sandbox-ready one. On Linux, the Bubblewrap and Landlock pieces check what sandbox tools are available, build the restricted filesystem and network rules, and start the helper process. The launcher picks a system Bubblewrap if possible, or a bundled copy if not, and reports clear setup problems.

The shell-escalation pieces handle commands that may need extra permission. A patched Unix shell can ask an escalation server what to do. The policy says allow, deny, or escalate. The client and server carry that request and connect it to the real process launcher. The runtime files prepare shells, environments, sandbox inputs, and the special Unix shell path that ties approval and sandboxing together.

#### [Exec-server filesystem sandbox services](stage-14.2.5.md) `stage-14.2.5` — 6 files

This stage is shared behind-the-scenes support for the exec server when it needs to work with files. The exec server may be running commands locally, in a restricted sandbox, or on another machine, but the rest of the system should be able to ask for simple actions like read, write, list, copy, or delete.

The local file system layer is the front desk for files on the same machine. It either performs the action directly or sends it through a sandbox, which is a locked-down area that limits which paths can be touched. The sandboxed file system layer is the safe version of those same operations, enforcing the sandbox rules. The filesystem sandbox runner starts helper work inside that restricted space and carefully controls what environment and file access the helper receives.

The helper protocol is the messenger format for filesystem actions. It turns requests into real file operations and turns results or failures back into replies. Remote file system support uses a similar idea to make files on another machine look local. File-read support handles long reads in small chunks, tracking open reads and rejecting unsafe or stale requests.

#### [Windows sandbox provisioning and process-launch internals](stage-14.2.6.md) `stage-14.2.6` — 27 files

This stage is the Windows-only machinery that prepares a safe “guest room” for commands and then starts them inside it. The public entry points choose the right sandbox path: the newer elevated runner or the older legacy runner, while the TUI asks for the requested sandbox level. Setup code creates or refreshes sandbox Windows users, stores and checks their identity, reports setup errors, hides those users from normal Windows screens, and fixes access to bundled runtime tools. Permission code edits Windows access-control lists, which are file permission rules, to allow workspace writes, deny reads to sensitive paths, and reduce risky “Everyone can write” folders. Token and desktop code decide what powers and screen environment the child process gets. Firewall and WFP rule code block or narrow network access. Spawn preparation turns the requested read, write, and network policy into these concrete Windows settings. Process-launch code then creates the command with the right user, environment, pipes, and optional ConPTY fake terminal. The elevated runner uses locked-down named pipes to talk to its child, and the stdio bridge connects the sandboxed program back to the user’s terminal until it exits.

### [Extension and integration tools](stage-14.3.md) `stage-14.3` — 117 files

This stage gives Codex its “extra equipment” beyond the core chat and code loop. It is mostly shared behind-the-scenes support, used during startup, while choosing tools during a turn, and when clients ask to discover apps or files.

The MCP runtime is the bridge to outside programs that use the Model Context Protocol, a standard way for other apps to offer tools and resources. It starts those servers, lists what they provide, checks permissions, and sends tool results back to the session.

Plugin and connector management is the supply chain. It finds, installs, updates, disables, and removes plugins, while deciding which connectors are visible and safe for a user.

Extension-backed tool runtimes turn those add-ons into usable tools for the model, such as web search, image generation, memories, skills, and long-running code cells. They build the tool menu, run selected tools, and report progress.

App-server discovery and search adapters are the front desk. They gather connector, app, and file-search results, clean and merge them, then return useful lists to the client.

#### [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files

This stage is the bridge between Codex and MCP, the Model Context Protocol, which lets outside programs offer tools, files, and other resources to the assistant. It is mostly behind-the-scenes support used during session startup and the main work loop. The app-server and ext/mcp files register MCP as an extension, discover MCP servers from plugins, and pass extension events to the right client. The codex-mcp library defines what an MCP server is, builds usable server configs, supports hosted Codex Apps, and keeps user app-tool caches separate. Its connection manager is the switchboard: it starts servers, checks readiness, collects tools and resources, and routes calls. Resource clients and handlers let the model list templates, list resources, and read one resource in a consistent way. Tool preparation code filters and renames tools, limits what the model sees, adapts file inputs, and uploads local files when a tool expects hosted files. Tool-call code checks permissions, asks for approval, records results, and reports back. Session and skill-dependency code connect MCP servers to each user session, refresh them when needed, and handle login prompts safely.

#### [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files

This stage is the plugin “supply chain” for Codex. It is shared support used during startup, tool discovery, installation, and user interaction. The core plugin files define the public API, read plugin.json manifests safely, load installed plugins into skills, apps, hooks, MCP servers, and telemetry, and coordinate installs, removals, cache refreshes, and marketplace rules. Marketplace files add, validate, upgrade, and remove catalogs from local folders or Git, while remote bundle and remote service files download, sync, install, uninstall, share, and check out plugins from ChatGPT-backed services, including older APIs.

Connector files decide which app connectors and tools are visible, enabled, and safe enough to run, combining login state, user settings, managed policy, and tool safety hints. Discovery and mention files find plugins the user may want, or ones the user explicitly referenced in chat. Install-suggestion tool files let the assistant list possible plugins and ask for user approval before installing. Finally, the CLI and terminal UI provide the human control panels: commands and popups for adding marketplaces, browsing plugins, installing, disabling, upgrading, and removing them.

#### [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files

This stage is shared support for the model’s “extra hands.” On each turn, spec_plan builds the tool menu and the router that runs the chosen tool. hosted_spec adds provider-side abilities like web search or image creation. Dynamic-tool files adapt tools supplied during the conversation, while extension_tools lets installed extensions behave like built-in tools and report progress.

Several helper tools make the menu easier to use: tool_search lets the model find hidden tools by text, view_image loads an image file for inspection, get_context_remaining reports remaining conversation space, and small spec files describe plan updates, new contexts, and worker-agent jobs.

Code mode is the long-running script area. Its runtime prepares a safe JavaScript world, callbacks let scripts talk back to Rust, and execute/wait tools start, monitor, or stop script cells.

The extension registry is the sign-up sheet. Web search, image generation, goals, memories, and skills plug into it. Memories safely list, read, search, and write local notes. Skills gather packages from the host, executor, orchestrator, or remote service, then expose safe list and read tools.

#### [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files

This stage is part of the app server’s main work: answering client requests when a user wants to discover apps, connectors, or files. It acts like a front desk that gathers information from several shelves, cleans it up, and returns a usable list.

The connector helpers prepare app discovery data. accessible.rs takes raw connector tools and turns them into user-facing apps, grouping duplicates and adding friendly names and descriptions. filter.rs decides what should be visible, hiding blocked connectors and avoiding suggestions for apps the user already has. merge.rs combines several connector lists into one best version, keeping the strongest name, description, logo, install link, and access state.

apps_processor.rs is the coordinator. It receives app-list requests from clients, checks whether app access is allowed, pulls data from cached and live sources, reports progress, and returns results in pages.

fuzzy_file_search.rs supports searching files and folders by approximate text matches, like typing a few letters into an editor’s “open file” box. It can run a single search or maintain a live session that updates as the query changes.

### [Sandbox policy generation and command-safety parsing helpers](stage-14.4.md) `stage-14.4` — 17 files

This stage is shared safety support used before running tools. It helps answer two questions: “What is this command really doing?” and “What should the sandbox allow it to touch?” The legacy policy files define the building blocks for allowed command arguments: argument shapes, option objects, argument types, and a narrow safe form of sed line-printing commands. The sandbox files then turn requested permissions into actual confinement rules. On macOS, seatbelt.rs writes Seatbelt rules for sandbox-exec. On Linux, build.rs makes sure sandbox build checks notice the expected bubblewrap hash.

The shell-command files inspect command text before execution. bash.rs parses only simple Bash or Zsh forms into plain argument lists. powershell.rs and the PowerShell parser helper understand Windows PowerShell scripts without repeatedly starting a new parser. parse_command.rs summarizes common actions, while command_canonicalization.rs normalizes commands so approval decisions can be reused. The command_safety files are the gatekeepers: they recognize safe read-only commands, flag dangerous ones like forceful deletion, and apply stricter Windows-specific safe and dangerous command rules.

## [Multi-agent, collaboration, and background workflows](stage-15.md) `stage-15` — 39 files

This stage is the system’s “extra workers” layer. It sits behind the main conversation loop and lets one session start helpers, send them messages, wait for them, stop them, or run background work. The agent files define the shared machinery: the module front door, roles and instructions, the registry of live agents, name-to-thread lookup, completion messages, and short status notes. The control files act like a dispatch desk: they limit how many agents run, keep only some threads loaded, and create, fork, reload, resume, or connect agents.

The multi-agent tool files expose this machinery to the assistant. Version 1 and Version 2 tools cover spawning, messaging, follow-up tasks, waiting, listing, interrupting, resuming, and closing agents, with shared helpers for validation and errors. Delegation, review mode, code-mode work, and the Guardian extension use the same pattern to run supervised child agents.

Other background workflows reuse the idea at larger scale: agent jobs split CSV rows across workers and collect results; memory startup extracts and consolidates long-term notes; the skills watcher refreshes available skills when files change.

## [Result persistence, projection, and user-visible state updates](stage-16.md) `stage-16` — 55 files

This stage is the system’s “make it real and show it” step. After the assistant, a tool, or an imported session produces progress, these files decide what should be saved, what should be shown, and what status other parts of the app should see. Rollout and thread-store code saves useful events, rebuilds old sessions, imports external chats, archives or restores threads, and keeps fast database summaries in sync with older transcript files. State and summary code turns raw event logs into searchable thread details like title, preview, model, folder, Git state, and token use.

Event-mapping code translates detailed core activity into simpler messages for app clients, exec JSONL output, and terminal displays. Tool, shell-command, diff, review, agent-status, and lifecycle code turn work into clear records: commands started or ended, files changed, approvals waited on, or agents finished. The TUI files then project that state into visible transcript cells, status lines, headers, pending-input previews, rate-limit warnings, goal indicators, and restored history. Together, they turn internal activity into durable records and understandable user-facing state.

## [Shutdown, cleanup, and teardown](stage-17.md) `stage-17` — 4 files

This stage covers the “put everything away safely” part of the system. It happens when a connection, session, agent, or daemon is ending, and its job is to stop new work, let safe in-progress work finish, and release anything the system was holding.

The connection RPC gate is like a door monitor for one client connection. RPC means “remote procedure call”: a request sent over the connection asking the server to do something. During shutdown, the gate blocks new request handlers from starting, but allows ones already running to complete.

The connection cleanup tracker manages jobs that continue briefly after a connection ends. It starts these cleanup tasks, records whether they succeed or fail, and can cancel them if the whole server is shutting down.

The legacy agent control code handles older paths for stopping agents. It asks live agents to shut down cleanly, flushes their saved work, and removes their stored parent-child relationship.

The daemon update loop is also part of teardown in practice: after downloading updates, it detects changed binaries and restarts the daemon in a controlled way.

## [Protocol schemas, shared types, and generated contracts](stage-18.md) `stage-18` · (cross-cutting) — 174 files

This stage is shared behind-the-scenes support for the whole system. It defines the “contracts” that clients, servers, plugins, storage, and tools all rely on when they exchange data. A contract is the agreed shape of a message, like a standard form everyone fills out the same way.

The core protocol and domain types provide the common vocabulary: sessions, threads, events, approvals, tools, permissions, errors, settings, plugins, and saved conversation state. The app-server schemas define how the desktop or web client talks to the app server, including JSON-RPC envelopes, which are simple wrappers for requests, replies, and errors. The generated backend and protobuf contracts cover messages produced from outside specifications, such as OpenAPI web models and protobuf service messages. The API, extension, hook, MCP, sandbox, and trace schemas define public and cross-process messages for tools, plugins, execution, realtime streams, and saved run histories. Finally, the annotation macros run during compilation to mark experimental API pieces consistently. Together, these parts keep every component speaking the same language.

### [Core shared protocol and domain types](stage-18.1.md) `stage-18.1` — 46 files

This stage is shared behind-the-scenes support. It is the project’s common dictionary: the names, message shapes, settings, and status labels that many crates use so they do not invent different versions of the same idea. The main protocol files define stable IDs for threads and sessions, safe agent and tool names, user input, conversation items, client requests, agent events, account data, approvals, permissions, errors, model info, MCP data, dynamic tools, command categories, memory citations, and network decisions. Config files describe user-visible settings and defaults. Plugin, tool, and skill files define how add-ons are named, described, discovered, filtered, and shown. Execution and network policy files describe allowed, blocked, or approval-needed actions and the reason codes used when something is refused. State, thread-store, and graph files define how conversations, spawned threads, memories, and process results are saved and reported. The TUI, cloud task, and startup error types give user interfaces and services the same event and error vocabulary. Together, these files act like standard forms that every department fills out the same way.

### [App-server protocol schemas and transport contracts](stage-18.2.md) `stage-18.2` — 43 files

This stage is the shared rulebook for how the app server and its clients talk. It sits behind the main work loop: before any feature can send a request, reply, warning, file update, or command output, both sides need to agree on the exact message shape. The JSON-RPC files define the basic envelope, like an addressed letter with a request, response, notification, or error inside. The common, v1, and v2 protocol files define the actual “forms” that go in those envelopes: startup, login, threads, turns, items, reviews, realtime sessions, accounts, models, apps, permissions, config, plugins, hooks, feedback, files, processes, MCP, remote control, and more. Helper and mapper files smooth over format details and keep older v1 command requests working with v2. The export and fixture tools turn Rust types into TypeScript and JSON Schema so other clients can use the same contract and detect accidental changes. Transport files describe outgoing messages, remote-control websocket rules, and JSON-RPC errors. Small bridge files translate approvals and MCP messages into the shapes other parts of the system expect.

### [Generated backend and protobuf contracts](stage-18.3.md) `stage-18.3` — 24 files

This stage is shared behind-the-scenes support. It is the system’s set of “forms” that different parts agree to fill out the same way. Most of it is generated from contracts: OpenAPI for web JSON APIs, and protobuf/gRPC for compact service messages sent between programs.

The backend client types describe the data the Codex backend sends back, such as accounts, usage limits, tasks, diffs, messages, errors, and token counts, with helpers to turn awkward responses into readable text. The OpenAPI crate exposes generated model modules, then gathers the needed types in one place. Those models cover rate limits, credit and spend controls, task details and task lists, pull requests, paginated results, and delivered configuration files or TOML fragments.

The protobuf files do the same job for internal services. The thread-config file defines requests, responses, and provider settings for asking another component for configuration. The exec-server relay file defines messages for handshakes, heartbeats, reconnects, resets, acknowledgements, and data transfer. The relay wrapper hides the generated details behind cleaner names.

### [API, extension, hook, MCP, and trace schemas](stage-18.4.md) `stage-18.4` — 60 files

This stage is shared behind-the-scenes support. It does not drive startup, the main agent loop, or shutdown by itself. Instead, it defines the public message shapes that many parts of the system must agree on, like standard forms used by different departments.

The code-mode contract types describe how code execution sessions, runtime messages, tool descriptions, and results such as text or images are represented. The public API schemas define requests, responses, errors, streaming events, search payloads, image payloads, and realtime WebSocket messages for outside services. The extension and hook contracts give plugins safe, stable ways to receive events, store state, add context, and declare hook commands. The tool and protocol schemas describe model-visible tool calls, permission requests, plans, human questions, and shared result formats. The MCP, exec, and sandbox wire models define exact messages that cross process boundaries, including command execution, event streams, and permission escalation. Finally, the rollout trace models describe saved histories of agent runs, with sessions, runtime events, and references to large payloads. Together, these schemas keep independent pieces speaking the same language.

#### [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files

This stage is shared behind-the-scenes support. It does not run code itself. Instead, it defines the public “contract” that other parts of the system agree to use when they talk about code mode. Think of it like the standard set of forms and labels used by everyone in an office.

The crate front door, lib.rs, gathers the important names from the internal files and re-exports them so other code can import them from one simple place. description.rs explains the available code-mode tools in human-readable text, including TypeScript-style examples, and reads small settings placed at the top of JavaScript input. response.rs defines common result content, such as text and images, and keeps their JSON shape consistent. runtime.rs defines the request and response messages exchanged with the runtime, the worker that actually executes code cells and reports progress or final results. session.rs defines the longer-lived session contract: how to start code, wait for answers, call tools, send updates, and shut everything down cleanly.

#### [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files

This stage is the public “language” of the Codex API layer. It is shared behind-the-scenes support used whenever the program sends requests to external services or reads their replies. Instead of each caller inventing its own message format, these files define the agreed shapes of those messages.

The library front door, lib.rs, decides what parts of this API package are visible to the rest of the codebase. common.rs provides the everyday forms for the Responses API: requests, responses, streamed events, and extra metadata such as tracing details used to follow a request through the system. error.rs gives all API code one common way to describe failures, such as bad requests, network trouble, or rate limits.

The remaining files cover specific transports or features. protocol.rs defines realtime WebSocket messages, which are two-way live messages, and selects the right parser for different protocol versions. images.rs defines image generation and editing payloads. search.rs defines request and reply formats for web, image, finance, weather, sports, time, and page-navigation searches.

#### [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files

This stage is shared behind-the-scenes support for people who add plugins, extensions, or hooks. It defines the stable “contracts” they can rely on, so outside code does not need to know the host’s private machinery. The extension API front doors gather and re-export the public pieces. Capability files describe powers the host may give an extension: starting a subagent, sending events, or adding extra items to the model’s current turn, with safe no-op versions when unsupported. Contributor files define the callback data for MCP server changes, thread and turn lifecycle moments, tool calls, and turn input. The main contributors file lists the plug-in points themselves. State gives extensions a safe typed storage box, and user instructions define how startup instruction text is reported. Goal events package goal changes in the standard event form. The memories backend defines a storage contract, while IDE context describes editor-provided file and selection data for the terminal UI. The hooks files define declared hook handlers, event modules, shared hook types, JSON wire formats, schema generation, and schema loading, making hook commands predictable and checkable.

#### [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files

This stage is shared behind-the-scenes support. It defines the “contracts” for tools and protocol messages: the agreed shapes of data that the model, Codex core, extensions, hooks, MCP clients, and user interfaces pass to each other. Like blank forms, these schemas say what fields are allowed, what names to use, and how results should be reported safely.

The tools files describe model-visible calls: generic tool inputs, tool-call packages, OpenAI Responses API tool specs, shell tools, context-count tools, user-input tools, goal tools, web search, skills, and MCP Codex session tools. They do not usually perform the work; they describe how to ask for it. The core context and code-mode adapter files translate real tool results, including text, images, commands, patches, and MCP outputs, into shared messages for the model, logs, hooks, and code mode. The protocol files define common payloads for permission requests, human questions, plan updates, and MCP approval labels, so Rust, JSON schemas, and generated TypeScript stay in agreement. Small support files forward shared errors and keep hook tool names consistent.

#### [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files

This stage defines the “wire models” for parts of the system that talk across a boundary. A wire model is the exact shape of messages sent between programs, processes, or tools, usually as JSON or another stream format. These files are shared behind-the-scenes support: they do not run the main agent themselves, but they make sure both sides of a conversation agree on what each message means.

The exec-server files describe how clients connect to an executor, how running processes are named, and what requests and replies look like for starting commands, reading output, accessing files, or making HTTP calls. The exec events file defines the JSON-lines event stream produced by `codex exec`, so outside tools can follow an agent run step by step. The Unix escalation protocol defines the messages exchanged when a shell command may need different sandbox permissions. The Windows framed IPC file does the same for communication with an elevated command runner, and also wraps messages into length-marked packets so they can be read safely from a stream.

#### [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files

This stage provides shared behind-the-scenes data models rather than main work-loop behavior. It defines the common “forms” that other parts of the system fill in when they record or read rollout traces. A rollout trace is a saved history of what an agent did, useful for debugging, review, or replay.

The session model describes the overall run. It records whether a rollout is still active or finished, which agent threads joined in, and the start and end times of pieces of runtime work. This is like the cover sheet and timeline for a job.

The runtime model describes the events inside that job: code cells, tool calls, terminal commands, checkpoints where context was compacted, and links between trace objects. It gives the trace system a shared vocabulary for the moving parts of execution.

The payload model keeps the trace lightweight. Instead of putting large raw logs or request and response bodies directly into the main records, it stores small references that point to those larger payloads elsewhere in the rollout bundle.

### [API annotation macros and compile-time contract support](stage-18.5.md) `stage-18.5` — 1 files

This stage is behind-the-scenes support that runs while the code is being built, not while the program is doing its main work. Its job is to help the project keep track of “experimental” API features, meaning parts of the interface that may still change and should be used with care.

The source file `codex-experimental-api-macros/src/lib.rs` defines a Rust derive macro. A derive macro is build-time code that writes repetitive code for developers automatically. Here, it lets a struct or enum learn how to say whether it contains any experimental API pieces. Instead of every developer manually writing the same checking logic, they can place small annotations on fields or enum variants. During compilation, the macro reads those annotations and generates the needed checking code.

In the larger system, this acts like a labeling machine on an assembly line. It marks API shapes consistently before the program ever runs.

## [Cross-cutting transport, networking, and client infrastructure](stage-19.md) `stage-19` · (cross-cutting) — 55 files

This stage is shared behind-the-scenes infrastructure. It is the system’s networking toolbox, used during startup, normal work, remote control, and tool communication whenever one part needs to send requests, stream data, or connect safely.

The generic HTTP layer provides common clients, request and response shapes, retries, streaming support, cookies, proxy settings, and TLS certificate handling, which is the security layer used for HTTPS. The app-server, exec-server, and relay transports are the longer-distance pipes: they carry messages, files, and encrypted WebSocket traffic between clients, servers, and remote machines. Managed proxying and local IPC, meaning communication between processes on the same computer, add controlled network forwarding, sandbox bridges, Unix sockets, Windows named pipes, and IDE links. MCP transport adapters connect the client to tool servers through memory, process input/output, or HTTP.

The direct library front doors, such as backend-client, chatgpt, and cloud-tasks-client, expose these tools in clean packages so callers do not need to know the internal layout. The Codex client error file gives all of this networking code a shared way to describe failures like timeouts, bad responses, and exhausted retries.

### [Generic HTTP client, TLS, cookies, and streaming transport foundations](stage-19.1.md) `stage-19.1` — 21 files

This stage is shared behind-the-scenes networking support. It is the set of pipes, valves, and adapters that lets Codex safely talk to web services. The core client files define a common request and response shape, turn JSON or compressed bodies into bytes, send them with reqwest, retry temporary failures with backoff, and decode long-lived Server-Sent Events streams. The library front doors re-export these pieces so other crates use the same tools.

Several files add safety and environment support: custom certificate authorities for company proxies, a narrow Cloudflare cookie jar that avoids sharing private session cookies, and default clients that add tracing, user-agent, proxy, residency, and authentication headers. Backend, ChatGPT, cloud task, remote config, LM Studio, and file-upload clients build on these foundations to call their specific services and translate replies into project types.

The API provider and session code centralize endpoint URLs, headers, retries, telemetry, normal requests, and streaming requests. Endpoint, request, and SSE modules act as organized entry points, while realtime WebSocket helpers translate raw live messages into internal events.

### [App-server, exec-server, and relay transport channels](stage-19.2.md) `stage-19.2` — 10 files

This stage is shared behind-the-scenes plumbing. It is the set of “pipes” that lets different parts of the system talk to each other, whether they are on the same machine, behind an app server, or reached through a remote exec server.

The app-server transport module defines the common events for connections: a client opens a link, sends a message, or receives a reply. Remote-control segmenting acts like cutting a large parcel into numbered boxes, then rebuilding it safely while rejecting bad pieces. The remote-control clients code uses authenticated HTTP calls to list connected devices and revoke them.

On the exec-server side, the HTTP client module gathers the ways to make requests, while the response-body stream reads replies a chunk at a time and matches remote chunks to the right request. The remote file stream does the same for files, reading safe-sized pieces and closing the remote file afterward.

The relay pieces carry messages over WebSockets. Noise channels encrypt and authenticate them. Framing splits large JSON-RPC messages into allowed record sizes, and ordered ciphertext makes sure encrypted records arrive in the exact order needed.

### [Managed proxying and local IPC transport substrates](stage-19.3.md) `stage-19.3` — 12 files

This stage is shared behind-the-scenes transport work. It gives the system safe ways to send traffic outward and to talk between local processes. The proxy configuration code takes user proxy settings and security rules, checks them, and turns them into a plan that can start or update the managed network proxy. The proxy then uses certificates to inspect HTTPS when allowed, applies MITM hook rules to selected decrypted requests, blocks unsafe connections to private or local addresses unless permitted, and builds clear HTTP responses when requests are allowed, denied, or fail. Its upstream transport sends approved requests to the real server, either directly, through an environment proxy, or through a platform-specific socket.

Other files provide local “pipes” for parts of the program to communicate on the same machine. The Unix-domain socket layer hides operating-system differences. Shell escalation sockets can also pass open file handles between processes. Linux sandbox proxy routing builds small bridges so sandboxed code can reach a host-side proxy without opening the host network. The Windows named-pipe and IDE IPC code let the terminal UI safely ask a local IDE what the user is viewing.

### [MCP and executor-backed transport adapters](stage-19.4.md) `stage-19.4` — 8 files

This stage is shared transport support for MCP, the Model Context Protocol, which is how the client talks to tool servers. It sits underneath the main client flow and turns high-level MCP messages into the actual ways bytes move: memory, process pipes, or HTTP. The crate front door, lib.rs, exposes the pieces other code should use. in_process_transport.rs creates a local, in-memory link to a server running in the same program, like connecting two parts with a short internal wire. executor_process_transport.rs connects to a separate server process managed by the executor, translating structured JSON-RPC messages into newline-based stdin and stdout traffic. For HTTP, reqwest_http_client.rs sends real network requests, while rpc_http_client.rs lets another runtime send them remotely, including streamed bodies. http_client_adapter.rs maps RMCP’s streamable HTTP protocol onto that shared HTTP interface. www_authenticate.rs reads authentication failure headers to detect missing permission scopes. streamable_http_retry.rs makes startup over streamable HTTP sturdier by retrying short-lived handshake failures.

## [Cross-cutting observability, analytics, and feedback](stage-20.md) `stage-20` · (cross-cutting) — 81 files

This stage is the project’s shared “instrument panel.” It runs across startup, normal request handling, streaming, tool use, and shutdown, watching what happens so developers and operators can understand problems and usage without interrupting the main work.

Analytics event modeling turns scattered facts, such as errors, tool runs, settings, and accepted code changes, into safe summary events and sends them in the background. OpenTelemetry setup provides standard observability: logs, traces, and metrics. A trace is a linked timeline for one piece of work; metrics are counted or timed measurements. Session telemetry adds more detailed trip-recording for each conversation, request, tool call, login state, database startup, and feature outcome.

Rollout tracing is the flight recorder. It can save raw events from conversations, tools, model calls, terminals, and threads, then reduce them into a replayable story. Feedback and debug capture gathers recent logs, failed response details, diagnostics, and local evidence, while sanitizing secrets before anything is stored or sent. The Windows sandbox logging file adds a simple daily text trail for sandbox command starts, successes, failures, and debug notes.

### [Analytics event modeling, reduction, and emitters](stage-20.1.md) `stage-20.1` — 8 files

This stage is shared behind-the-scenes support for understanding how Codex is used. It does not do the main user work itself. Instead, it watches important moments, turns them into safe structured records, combines related pieces, and sends them out without slowing the app.

The process starts with facts.rs, which defines “facts”: small records such as an error, a tool run, a setting, or a turn result. events.rs defines the final analytics “vocabulary,” meaning the event shapes that can be sent. lib.rs is the public doorway that other code imports, with a few shared helpers.

accepted_lines.rs measures accepted code changes as line counts, and hashes repository identity so raw remote URLs are not exposed. reducer.rs acts like an assembler: it remembers context across requests, responses, turns, tools, reviews, and threads, then reduces scattered facts into meaningful events. client.rs sends those events in the background. app-server/src/analytics_utils.rs wires the client to the server’s login and configuration. ext/goal/src/analytics.rs adapts goal activity into the same event system.

### [OpenTelemetry runtime, provider, and metrics foundations](stage-20.2.md) `stage-20.2` — 22 files

This stage is shared behind-the-scenes support, used mostly during startup and then throughout the main work loop. It sets up observability: traces, metrics, and logs that help operators see what the program is doing. The core OpenTelemetry config cleans user settings, adds safe defaults, and rejects bad trace labels. The init code then turns those settings into a running setup. The otel crate config decides whether telemetry is enabled and where it goes, while its lib file exposes the pieces. The provider builds the real exporters, filters, global hooks, and shutdown path. The OTLP transport prepares HTTP or gRPC clients, certificates, headers, and timeouts. Targets decide which events may become logs or traces, and trace context carries a work ID across services. Metrics files define errors, names, config, safe tags, validation, the shared client, timers, one-time process-start reporting, and readable runtime summaries. Event helpers add consistent details like time, version, model, and session. Finally, Codex client and API telemetry hooks measure request attempts, retries, streaming, and WebSocket activity without mixing that reporting code into the networking logic.

### [Session telemetry and feature-specific instrumentation](stage-20.3.md) `stage-20.3` — 16 files

This stage is behind-the-scenes instrumentation for a running session. It does not make the assistant smarter by itself. Instead, it acts like a dashboard and trip recorder, noting what happened, how long it took, and where problems appeared.

The central session telemetry file records session events, results, durations, and safe context. Turn timing adds finer stopwatch data for each assistant reply, such as time to first output and time spent waiting on tools. App-server tracing wraps incoming requests in trace spans, which are linked log sections that let one request be followed across the system. Tool dispatch tracing records tool calls without cluttering the tool runner itself.

Several files add safe labels and counters for specific features. Auth environment telemetry notes which login settings exist without recording secrets. Sandbox tags summarize permission mode. Guardian, cloud-config, goals, and memories files count feature activity and outcomes using stable metric names and labels. Memory usage code detects when commands read memory-related files. Finally, SQLite telemetry records database startup, fallback behavior, counts, and timings, including lightweight metrics for rollout and state startup.

### [Rollout trace recording, schema, and replay reducers](stage-20.4.md) `stage-20.4` — 24 files

This stage is the project’s flight recorder. During the main run, it can write down what Codex does, then later turn that raw diary into a clean story that can be replayed or inspected. The bundle and raw event files define the trace package: a table of contents plus an ordered event log. The model files define the replay-friendly shapes for conversations, tool calls, threads, terminal work, code cells, compaction checkpoints, model requests, and stored payloads. The crate front door exports these pieces, while rollout configuration supplies the few settings tracing needs.

The writer, thread, code cell, compaction, inference, tool dispatch, MCP, and protocol event files are the recording adapters. They sit beside normal work, assign trace IDs, save large payloads, and keep running even if tracing is off or a write fails.

The reducer files are the replay workshop. They read the raw bundle in order and build one compact RolloutTrace. Separate reducers clean up conversations, normalize JSON messages, track model calls, compaction, threads, code cells, tools, agent handoffs, and terminal sessions, linking scattered events into one understandable run history.

### [Feedback capture, debug artifacts, and log persistence](stage-20.5.md) `stage-20.5` — 10 files

This stage is shared behind-the-scenes support for troubleshooting. It captures clues when something goes wrong, makes them safe to keep or send, and stores them for later inspection. The feedback library gathers recent Codex logs and context into a user feedback report, then packages it for Sentry, an error-reporting service. Feedback diagnostics add network clues, such as proxy settings, and the doctor report can run a diagnostic command and attach only valid JSON results. Response debug context extracts safe details from failed API replies and turns errors into short messages without exposing private response bodies. The secret sanitizer is the safety screen: it removes likely API keys, bearer tokens, and similar credentials before text is logged or shared. Several parts persist raw evidence locally. The response proxy can dump HTTP exchanges as JSON while hiding sensitive headers. Analytics capture writes events as one JSON line per record. The TUI session log records interface traffic when explicitly enabled. Finally, the log database layers collect live tracing logs into SQLite, then store, trim, and read them so debugging data stays useful without growing forever.

## [Cross-cutting persistence abstractions and data stores](stage-21.md) `stage-21` · (cross-cutting) — 54 files

This stage is the system’s long-term memory and filing system. It is shared support used throughout startup, normal work, recovery, and cleanup, rather than one single user-facing flow. Its parts save different kinds of information so the app can resume work, avoid repeats, and keep private data safe.

Rollout files and thread-store persistence keep conversation records: raw session logs, searchable indexes, live writers for active chats, and tools to list, rebuild, archive, or delete threads. SQLite runtime state and agent graph storage keep structured records in a small local database, such as thread summaries, goals, agent jobs, progress checkpoints, audit views, and “which agent started which thread.” Caches and local lookup files store reusable facts like cloud settings, connector lists, plugin catalogs, models, update notices, and local plugin paths, while checking age, account, and version before trusting them. Plugin, secrets, and memory stores manage installed plugins, encrypted secret values, and saved user memories. External session import persistence reads conversation files from other tools and keeps a ledger so the same outside session is not imported twice.

### [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files

This stage is the system’s local memory for conversations. It runs behind the scenes during normal use, so chats can be resumed, listed, searched, archived, or deleted later. The rollout files are the raw diary: recorder.rs writes each session as JSON Lines, meaning one JSON record per line, while compression.rs can read old diaries even after they are packed into smaller .zst files. list.rs, search.rs, and session_index.rs help find those diaries by time, thread ID, name, or text match. core/src/rollout.rs and rollout/src/lib.rs make these tools easy for the rest of the app to reach.

The thread-store layer is the cleaner front desk on top of those files. store.rs defines the shared “save, read, list, update, archive, delete” contract, error.rs defines common failure messages, and lib.rs exports it all. The local store ties rollout logs, optional SQLite metadata, and live writers together. Its helpers validate paths and convert old metadata. live_writer.rs keeps active chats being saved, read_thread.rs rebuilds a thread, list_threads.rs and search_threads.rs support browsing, and delete_thread.rs removes saved files. message-history separately stores the user’s global prompt history safely across processes.

### [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files

This stage is the system’s durable notebook. It is shared behind-the-scenes support used while the app runs, and also during startup or recovery, so important runtime facts survive a restart. Most data is kept in SQLite, a small local database stored as files.

The state crate is the main entry point. It defines safe data shapes for thread summaries, thread goals, agent jobs, backfill progress, and logs, then pairs them with runtime code that reads and writes those records. The thread runtime catalogs conversation threads, including parent and child links. The goal runtime records what a thread is trying to do and its budget. The memories runtime schedules memory extraction work. Agent job storage tracks queued, running, finished, and failed work items. Backfill storage remembers catch-up progress and prevents two workers from doing the same job.

Other pieces store imported external-agent configuration, remote-control server enrollments, and read-only audit views for diagnostics. The agent graph store adds a common interface for “which agent spawned which thread,” with a local SQLite implementation that reuses the same state database.

### [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files

This stage is shared behind-the-scenes support. It gives the app a local memory on disk, so it can start faster, work offline in some cases, and avoid asking servers the same questions again and again. These caches are small saved files, like notes the app leaves for its future self, but they are checked carefully before use.

The cloud-config cache stores cloud settings for the signed-in account. It rejects old, corrupted, edited, or wrong-user data. The connector directory cache saves lists of available connectors under the Codex home folder, so the app can reuse a valid list. The plugin catalog cache stores remote plugin lists separately for each server and account, preventing one user’s data from leaking into another’s view. The model cache keeps the available model list and ignores it when it is too old or from a different client version. The local plugin paths file remembers which shared plugin IDs map to folders on this machine. The update cache remembers the latest version seen and whether its notice was dismissed.

### [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files

This stage is shared behind-the-scenes support for data that must survive after the app closes. It is the system’s set of local “filing cabinets” for plugins, secrets, and memories. The plugin store decides where downloaded plugins are kept, checks their labels, installs them into versioned folders, finds the active version, and removes old copies. The secrets layer defines safe secret names and groups, then uses a local encrypted file store to save, read, list, and delete secret values without writing plain text to disk. On Windows, the DPAPI wrapper uses Windows’ built-in data protection service to encrypt and decrypt small secret blobs safely.

The memories files do similar durable storage for user memory. The local memory store turns requests such as list, read, search, and add note into safe folder operations. The memory write front door defines the standard folders and paths. Its storage code materializes saved memory records as Markdown files and keeps raw combined files and per-thread summaries in sync. Cleanup code clears memory contents safely, avoids following symbolic links, and prunes old extension resource notes so storage does not grow forever.

### [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

This stage is shared behind-the-scenes support for bringing in conversation history from another agent tool. It does not run the main chat loop itself. Instead, it helps the import feature answer two questions: “What is inside this outside session file?” and “Have we already imported this exact version?”

The records file is the reader and translator. It opens saved external conversation logs, parses their contents, and reshapes them into this project’s normal conversation format. It also creates short summaries, so the rest of the system can show a safe list of possible sessions before importing them.

The ledger file is the memory book. It stores a small record on disk of external session files that were already imported. If the same file content appears again, the system can skip it and avoid duplicates. If the file has changed, the ledger allows it to be imported again. Together, these parts make external imports repeatable, safe, and understandable.

## [Cross-cutting utility and support libraries](stage-22.md) `stage-22` · (cross-cutting) — 175 files

This stage is the shared toolbox used across the whole system, not one user-facing feature. It supports startup, the main work loop, tool execution, display, and build time. Path, filesystem, environment, terminal, and sandbox utilities give safe, portable ways to name files, watch changes, copy text, find programs, and run restricted commands. Text helpers clean, parse, shorten, wrap, style, and render output as it streams in. Configuration, metadata, auth, and network helpers turn user settings, login data, schemas, and proxy rules into safe internal forms. Shell, command, Git, plugin, and execution utilities run external programs, inspect repositories, package plugins, and manage process output. Async, image, sleep, cache, and summary helpers smooth long-running work and terminal display. Build scripts prepare platform-specific pieces before compilation.

The direct files are small entry points and shared vocabularies: core utility helpers, module “front doors” for core, CLI, and plugin utilities, structured errors for execution policy and Git failures, a fuzzy matcher for search-style highlighting, and common hook-event rules so hooks behave consistently.

### [Path, filesystem, environment, and sandbox support utilities](stage-22.1.md) `stage-22.1` — 31 files

This stage is shared behind-the-scenes support. It gives the rest of the system safe ways to talk about files, folders, programs, terminals, and sandboxes without each feature reinventing the rules. The path helpers form the base layer: PathUri, ApiPathString, AbsolutePathBuf, app-server paths, path-utils, WSL path conversion, memory path helpers, and timestamp helpers all clean, compare, display, and translate paths across Unix, Windows, WSL, remotes, and saved data. Filesystem pieces build on that: regular_file protects reads from special files, file-watcher reports disk changes, file-system defines common read/write/list operations, and symlink helpers hide platform differences. Build and execution helpers find binaries under Cargo or Bazel, resolve program names on Windows, and shape the environment variables passed to child commands. Terminal support detects the host terminal, chooses usable colors, and copies text safely through SSH, tmux, WSL, or local clipboards. Sandbox utilities prepare restricted runs on Linux, macOS, and Windows by finding sandbox tools, reporting denied permissions, normalizing paths, setting up safe working folders, environment variables, SSH dependencies, mutexes, and Windows-specific system details.

### [Text, parsing, truncation, and rendering helpers](stage-22.2.md) `stage-22.2` — 57 files

This stage is shared behind-the-scenes support for almost every place the project reads, prepares, or shows text. It is not one main feature. It is more like the workshop that cuts, labels, cleans, and paints text before other parts use it, especially in the command-line and terminal interface.

The generic text utilities shorten long output, format numbers and times, fill simple templates, protect private values, and make strings safe for terminals, metrics, or JSON. The streaming parsers handle text that arrives piece by piece, such as live model output or process logs. They join split characters, wait for complete lines, remove hidden markup, and keep useful metadata separate from visible words.

The layout and rendering helpers then make text fit on screen. They measure width, wrap lines, preserve colors and links, truncate safely, and support scrollable views such as diffs. Above that, the presentation helpers choose consistent styles, colors, rows, popups, footers, warnings, and status labels. Finally, the animation and progress helpers add small motion effects and temporary “working” messages without cluttering the final output.

#### [Generic string, formatting, truncation, and templating utilities](stage-22.2.1.md) `stage-22.2.1` — 12 files

This stage is shared behind-the-scenes support for making text safe, short, and easy to read across the project. It is like a set of measuring cups and labels used by many kitchens, not the main cooking itself.

The string utilities clean and convert text safely. They can produce ASCII-only JSON for places that may reject Unicode, shorten long strings without breaking emoji or non-English characters, and prepare safe metric tags or terminal-friendly code links. Number and elapsed-time formatters turn raw values into labels people can scan, like “12,000”, “12K”, or “1m 15s”. CLI helpers display environment variable names without leaking their values, and build copy-safe “resume” commands for old threads.

Several tools keep text from overwhelming the system. Output truncation preserves useful beginning and ending context, while response-history trimming keeps conversations within a reusable size budget. The strict template helper fills placeholders such as “{{ name }}” and catches missing or mistaken fields. Web search formatting and TUI text helpers turn actions, paths, JSON, and long tool output into compact readable labels for narrow displays.

#### [Streaming, line framing, and hidden-markup parsers](stage-22.2.2.md) `stage-22.2.2` — 9 files

This stage is shared behind-the-scenes support for reading text that arrives in pieces, such as live assistant output or process logs. Its job is to turn messy chunks into clean, useful events without losing hidden information. The stream-parser front door gathers these helpers for the rest of the project. Its common result model separates visible text from hidden parts, like citations or metadata, so the app can show only what users should see while still keeping machine-readable details. The UTF-8 stream reader safely joins raw bytes into text even when one character is split across chunks. The line buffer does a similar job for process output, waiting until a full newline-ended line is ready. Other parsers remove inline hidden tags, detect tagged blocks that start and end on their own lines, and extract structured memory citations. The table detector recognizes Markdown tables and code fences so display and cleanup code agree. The mention codec turns user-friendly tool mentions into stored links and back again. Together, these pieces act like filters on a conveyor belt for streamed text.

#### [TUI text layout, wrapping, and text-rendering primitives](stage-22.2.3.md) `stage-22.2.3` — 10 files

This stage is shared behind-the-scenes support for drawing text in the terminal interface. It is used whenever the app needs to show output, Markdown, diffs, links, or styled lines inside a limited screen area.

The geometry helper in render/mod.rs lets drawing code add padding inside a rectangle, like leaving margins in a page. line_utils.rs prepares display lines so they can be safely stored, copied, and given prefixes. width.rs checks whether there is any usable space left after those prefixes. ansi-escape/src/lib.rs converts colored terminal output into drawable text and expands tabs so columns line up.

Several files then shape text to fit. line_truncation.rs measures and cuts styled text without splitting wide characters such as emoji. wrapping.rs wraps rich terminal text while preserving styling, indentation, byte positions, and whole clickable URLs. live_wrap.rs does similar wrapping for incoming plain text. markdown_text_merge.rs joins adjacent Markdown text pieces after parsing so rendering sees smoother text. terminal_hyperlinks.rs keeps link targets separate from visible words until the final drawing step. scrollable_diff.rs uses these pieces to show wrapped diffs and messages with a valid scroll position.

#### [TUI presentation models, styling, and lightweight view helpers](stage-22.2.4.md) `stage-22.2.4` — 21 files

This stage is shared behind-the-scenes support for the terminal user interface. It sits above the low-level text drawing code and prepares what the user will see: colors, labels, rows, popups, footers, and status text. The color, style, chart palette, and spacing files choose readable colors, symbols, and margins so screens stay consistent on different terminals. The renderable building blocks let text and containers report their size and draw themselves.

Several files shape common controls. Key hints make shortcuts display consistently. Scroll state, selection rows, selection popups, and selection tabs keep lists, tabs, highlights, wrapping, and disabled choices predictable. The footer, action-required title, and popup constants build the bottom-pane messages that guide the user.

Other helpers turn internal data into friendly display models. Warning logic avoids repeated chat warnings. Migration, goal, skill, status, and remote-connection helpers convert raw settings, paths, counts, times, server details, and skill metadata into short readable text. History cells provide reusable transcript pieces, including wrapped text and links.

#### [TUI animation, motion, terminal media, and transient progress output](stage-22.2.5.md) `stage-22.2.5` — 5 files

This stage is shared behind-the-scenes support for making the command-line interface feel alive without getting in the way. It is used while the program is running, especially when the interface needs to show that work is happening.

The motion file is the central switchboard for small movement effects, such as loading dots or animated highlights. It also respects reduced-motion settings, meaning users who prefer less animation still see clear, steady feedback. The shimmer file supplies one of those effects: it breaks text into styled pieces and changes their brightness over time, like a light sweeping across a sign. The ASCII animation file is the frame driver. It decides which text-art picture to show next and asks the interface to redraw at the right moments. The frames file is the art library, packaging those pictures and their normal playback speed into the program. Finally, the doctor progress file shows temporary “checking…” messages during health checks, sending them somewhere safe so they do not mix into the final report or JSON output.

### [Configuration, metadata, schema, auth, and network glue utilities](stage-22.3.md) `stage-22.3` — 26 files

This stage is shared behind-the-scenes support. It is the toolbox other features reach for when they need clean settings, safe network rules, login helpers, or small bits of display data. The cloud tasks, login, API, proxy, MCP, and Ollama helpers prepare authentication, headers, URLs, readable errors, and server environment values so requests leave the app with the right context and fewer secret-handling mistakes. The configuration helpers explain where settings came from, enforce allowed values, rename old keys, convert JSON to TOML, and turn command-line options such as approval mode, sandbox mode, and key=value overrides into the internal settings the program uses. Metadata helpers give connectors, plugins, skills, mentions, memories, and execution-policy errors consistent names, schemas, counts, symbols, and messages. The network proxy files turn user-facing allow and deny rules into normalized host and IP policies, blocking risky local targets and choosing safe listen addresses. Finally, the TUI version helpers read baked-in version data, compare releases, and check npm registry records before treating an update as real. Together, these files act like adapters and gauges that keep the larger machine understandable and safe.

### [Shell, command, git, plugin, and execution support utilities](stage-22.4.md) `stage-22.4` — 24 files

This stage is behind-the-scenes support used whenever the app must run outside programs, inspect Git, or package plugins. The shell pieces provide one common view of bash, zsh, PowerShell, sh, and cmd: they detect a safe shell, turn a command string into the right arguments, build the variables a program receives while filtering secrets, and format commands for display without changing their meaning. The Git pieces wrap the git program to ask safe, timed questions about repositories, roots, remotes, branches, commits, changes, filesystem monitoring, and diffs, including the TUI /diff view and shared-starting-commit checks.

The plugin pieces package plugin folders into bounded, safe archives, clone marketplace content into a temporary staging area, keep writes inside the install folder, and activate a prepared marketplace only when its recorded source and revision match. The execution pieces are the plumbing for tools and sandboxes: they normalize executable names, prepare Linux arguments and input/output handles, communicate with Windows sandbox runners, track process families, mirror command exit status, open an external editor, and provide a common interface for interactive child processes. Output helpers keep command logs useful by preserving the start and end when text is huge. The patch helper finds matching text flexibly.

### [Async primitives, image handling, and miscellaneous small support libraries](stage-22.5.md) `stage-22.5` — 25 files

This stage is a toolbox of small behind-the-scenes helpers used by many larger parts of the system. The image pieces prepare pictures for safe use: pet files split spritesheets, choose terminal image protocols, and encode Sixel frames; image utilities read, resize, validate, and report clear errors; core and tool helpers manage “original detail” image requests and replace unusable images with text placeholders. Async helpers act like traffic signals: cancellation stops waiting work, readiness lets tasks wait for a safe start, the pauseable stopwatch enforces time limits, and the frame-rate limiter avoids excessive terminal redraws. Sleep-inhibitor files keep the computer awake during an active turn, with separate implementations for macOS, Linux, Windows, and a harmless dummy fallback. Other utilities translate V8 JavaScript results into Rust-friendly values, prove basic V8 linking, cache recent async values with SHA-1 keys, filter replayed interface events, and turn sandbox or configuration settings into compact human-readable summaries. Together these pieces do not drive the main story, but they make startup, display, tool output, and long-running work smoother and safer.

### [Build scripts and build-time asset/platform glue](stage-22.6.md) `stage-22.6` — 4 files

This stage runs before the main program is built. It is behind-the-scenes setup for Cargo, Rust’s build tool, so the final binaries are assembled correctly on each platform and stay up to date when bundled files change. The Bubblewrap build script prepares a Linux sandbox helper: it checks whether Bubblewrap can be built, compiles its C source code when appropriate, and tells Cargo how to link that compiled code into the Rust crate. The Windows sandbox build script does a similar kind of platform glue for Windows, but instead of compiling code it attaches an application manifest, a small settings file Windows reads to know how the helper should run. The CLI build script adds a special macOS linker option so code that depends on Objective-C-related system pieces can link cleanly. The skills build script watches sample asset folders and tells Cargo to rebuild if those files change. Together, these scripts act like workshop notes for the compiler, adjusting the build for each operating system and for bundled assets.

## [Testing, fixtures, and developer verification harnesses](stage-23.md) `stage-23` · (cross-cutting) — 659 files

This stage is the project’s test workshop. It is not used by normal users during startup, daily work, or shutdown. Instead, developers and automated checks use it to make sure every major part still behaves correctly before changes are shipped.

The app-server tests prove the server starts, speaks the expected message formats, and supports real client workflows. The core runtime tests check conversations, tools, permissions, saved history, recovery, and safe stopping. The CLI, exec, login, and MCP tests run the command-line programs like real users would, including patching files, signing in, streaming results, and handling failures. The exec-server, sandbox, and remote transport tests protect command execution, file access, encrypted connections, relays, and platform-specific safety rules. The TUI tests draw the terminal interface into fake screens and check chat behavior, popups, layout, scrolling, and rendering. The cross-cutting library tests cover shared pieces such as telemetry, configuration, plugins, APIs, persistence, and utilities.

The direct support file, `test-binary-support/lib.rs`, lets tests imitate different installed command names using temporary aliases and a temporary home folder, then cleans everything up afterward.

### [App-server test suites and protocol verification](stage-23.1.md) `stage-23.1` — 115 files

This stage is the app server’s safety workshop. It is not part of normal startup, daily work, or shutdown. Instead, it runs during development and continuous testing to prove that the server still speaks the right language, starts correctly, connects to clients, and supports real workflows.

The protocol tests act like a ruler for messages. They check that JSON-RPC and remote-control data keep the exact shapes clients expect, and that generated schemas have not changed by accident. The daemon and transport tests check the background server process, update decisions, socket connections, client routing, and the special test client used to exercise the system safely.

The unit tests look inside the app server’s smaller parts, such as configuration import, command-line overrides, tracing, error reporting, and conversation state. Shared fixtures build a pretend world with fake accounts, models, saved sessions, and AI responses, so tests do not need real services.

Finally, the integration suites put everything together. They start the server like a real client would, send requests, run conversations, use tools and plugins, and verify the visible behavior from end to end.

#### [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files

This stage is a behind-the-scenes safety check for the project’s communication rules. It does not run the app’s main work. Instead, it makes sure the messages sent between the app server and its clients keep the same shape over time. That “wire format” is the agreed JSON layout used on the network, like a shared form both sides know how to fill in.

The common protocol tests check how client response data becomes JSON-RPC response parts. JSON-RPC is a simple request-and-response message style using JSON. These tests confirm when a response should also create an internal client response object, and when it should remain only a plain JSON-RPC result.

The version 2 remote-control tests focus on remote-control messages, checking that Rust data structures turn into exactly the expected JSON and can be read back correctly. The broader version 2 protocol tests cover app-server messages, older accepted JSON shapes, and conversions to and from core Codex protocol types.

Finally, the schema fixture test compares generated protocol schemas with the checked-in copies, catching accidental protocol changes.

#### [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files

This stage is the safety net around the app server’s background service, its communication pipes, and its special test client. It is shared behind-the-scenes support: it does not run the product itself, but it proves that startup, messaging, updates, and test-only tools behave correctly.

The daemon tests check the background server’s “PID file,” a small record saying which process is running. They cover starting, stopping, stale records, launch arguments, log reading, managed install version checks, and update decisions. One key rule is protected: if the updater program itself changes, that is more urgent than an ordinary version change.

The transport tests check how clients connect and receive messages. Unix-socket tests cover local WebSocket connections, socket-file protection, message forwarding, and avoiding double startup races. Other transport tests make sure messages go only to suitable clients and that one slow client cannot block the rest. Remote-control tests check pairing, client listing, revoking, refreshed authentication, and useful error details.

The test-client files provide a realistic command-line client, fake local HTTP service, and plugin analytics checks, including smoke tests for install, update, use, and removal events.

#### [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files

This stage is shared test support for the app server. It is not part of the running product path; it is the safety net used while building and changing the server. The unit tests check important behaviors inside the app-server crate: importing external agent settings without losing or duplicating data, managing config files safely, accepting command-line overrides, keeping tracing links across JSON-RPC requests, refreshing runtime state after config migration, reporting remote-control errors clearly, preserving conversation thread state, and creating summaries from the right user message.

The integration-test helpers act like a small pretend world around the server. They provide fake analytics, authentication files, config files, model lists, saved sessions, and AI service responses, so tests can run without real accounts, networks, or production services. The mock model server and test app-server client let tests start a real server process, send JSON-RPC commands, read replies, and shut it down cleanly. Finally, the suite index files are the test runner’s table of contents, gathering the right test groups so they compile and run together.

#### [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files

This stage is the broad end-to-end test bench for the app server. It treats the server like a real client would: start it, connect to it, send requests, run conversations, use tools, and check that the answers and side effects are correct. It is mostly about the server’s public behavior, not small internal parts.

One group tests the basic “front desk”: login, accounts, rate limits, configuration, startup handshakes, model discovery, safe file and process access, and remote-control pairing. Another group tests the live connection pipes, such as WebSockets, authentication, reconnects, shutdown behavior, desktop proof tokens, experimental features, and realtime text or audio sessions.

A third group checks extensions: plugins, marketplace installs, connector apps, hooks, skills, MCP tool servers, shell commands, file search, image generation, sleep, and web search. These tests make sure outside tools appear only when allowed and run safely.

The final group follows the conversation lifecycle: creating threads, running turns, interrupting work, asking permissions, saving history, summarizing, reviewing code, reopening sessions, and deleting or archiving old work.

##### [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files

This stage checks the app server from the outside, the way a real editor or tool would use it. It is mostly shared support for startup and everyday server work, not the plugin system or conversation loop. These tests call RPCs, meaning request-and-reply commands sent to the server, and verify the public promises clients depend on.

The auth and account tests cover login state, API keys, ChatGPT tokens, device-code login, logout, token refresh, workspace limits, and Bedrock account reporting. The rate-limit tests check reading usage limits, asking owners for more credits, and spending reset credits, including bad logins and backend failures. Strict config and config RPC tests protect configuration: the server must reject unknown settings when asked, read settings with their sources, and write changes safely. Initialize tests check the first handshake between client and server.

The discovery tests make sure clients can list models, collaboration modes, permission profiles, experimental features, and provider capabilities in stable shapes. The filesystem, process, and Windows sandbox tests check safe local file access, running and stopping commands, and sandbox setup. Remote-control tests verify pairing, revoking, policy rules, and fake network behavior.

##### [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files

This stage is a set of integration tests for the app server’s live client connections. It checks the “front door” behavior: how desktop clients connect, prove who they are, exchange messages, use realtime features, and disconnect. These tests sit around the main work loop, where the server is already running and must behave predictably while clients talk to it.

The WebSocket tests check the basic pipe between client and server. They make sure separate clients do not leak into each other, authentication is enforced, health checks work, and reconnecting clients can recover recent work. The Unix WebSocket shutdown tests add pressure: they send Ctrl-C-style signals while a request is active and confirm the server waits, exits fast on a second signal, and closes cleanly.

The attestation test follows a proof token from the desktop client into the outgoing ChatGPT connection handshake. The experimental API test makes sure new features stay locked unless the client opts in. The realtime conversation tests cover the full live experience: text, audio, WebRTC setup, feature flags, handoffs to background agents, and expected error behavior.

##### [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files

This stage is a behind-the-scenes safety net for the app server’s extension system. It tests the places where the server lets outside add-ons, tools, and local commands become part of a conversation. The plugin tests cover the full plugin life cycle: listing, reading details and skills, installing, sharing, uninstalling, and syncing with local or remote catalogs. The marketplace tests check adding, removing, and upgrading collections of plugins. App listing checks that connector apps and fake tool servers appear correctly.

Other tests check discovery features. Hooks tests make sure startup or project actions can be listed, trusted, enabled, or disabled. Skills tests confirm that instruction packs from users, workspaces, plugins, or executor choices are found without the wrong one taking over. MCP tests cover outside tool servers: their status, tools, resources, permission questions, and thread-specific visibility.

The remaining tests exercise tool execution. They check shell commands, packaged zsh commands, fuzzy file search, image generation, sleep, and web search. Together, these tests make sure extensions behave like well-labeled tools in a workshop: visible when allowed, hidden when not, and safe to use.

##### [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files

This stage is the app server’s “conversation lifecycle” test area. It checks the main work loop that clients use every day: create a thread, run assistant turns, pause or interrupt them, save history, reopen it later, and eventually archive or delete it. The thread tests act like a filing system inspection: start, list, read, resume, fork, rename, roll back, archive, unarchive, delete, and summarize conversations, whether they live on disk, in memory, or in a remote store. Other tests check per-thread details such as settings, memory mode, Git metadata, loaded-thread lists, subscriptions, and live status messages.

The turn tests check the moving parts during an active assistant response: starting a turn, steering it with a new user message, asking for permissions or user input, using dynamic tools, enforcing output schemas, injecting saved items, and interrupting safely. Review and compaction tests cover special workflows: code review and shrinking long chats into summaries. Finally, client metadata, safety notifications, memory reset, and external-agent import tests make sure surrounding state and policy messages stay accurate for connected clients.

### [Core runtime and session test harnesses](stage-23.2.md) `stage-23.2` — 179 files

This stage is the main safety-check area for the core system. It is not part of what users directly see. Instead, it proves that the conversation engine can start, run, use tools, save its place, recover later, and stop safely. One group of tests watches the runtime itself: sessions, history, state, permissions, compaction, agents, realtime behavior, and other internal records. Another group focuses on tools, such as running shell commands, editing files, calling outside services, asking for approval, and shutting down long-running work. A shared integration harness acts like a test workshop. It builds fake folders, fake model servers, fake app services, and controlled streams so tests can run without touching real user data. The end-to-end suites then put everything together, checking full sessions from model request to streamed reply, tool use, approvals, saved history, plugins, remote work, and helper agents. Together, these parts make sure the core behaves reliably before real users depend on it.

#### [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files

This stage is a behind-the-scenes safety net for the core runtime. It does not add user features itself. Instead, these tests check that the main conversation engine starts, runs turns, saves state, resumes later, and shuts work down safely. The session tests cover conversation setup, history, settings refresh, hooks, metrics, network rules, plan-mode messages, user shell commands, and worker-failure messages. Rollout, thread, history, compaction, event-mapping, stream, image, and client-request tests make sure saved or streaming conversation data is cleaned, shortened, restored, and sent to APIs in the right shape. Agent tests cover parent and child agents: spawning, roles, registries, delegation, concurrency limits, memory residency, cancellation, and resuming agent trees. Guardian, MCP, execution-policy, sandbox, and patch-safety tests check the permission system that decides what commands, tools, and file edits may run. State, metadata, timing, diff-tracking, Git, shell, AGENTS.md, personality migration, and realtime tests check supporting records and environment details. Together, these tests act like gauges around the engine, warning when lifecycle, safety, or saved-state behavior changes unexpectedly.

#### [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files

This stage is a broad safety check for Codex’s tool system, the behind-the-scenes machinery that lets the model edit files, run commands, ask the user, call external MCP tools, manage sub-agents, and use hosted features like web search or image generation. Most files here are tests that protect the public “tool contract”: the exact names, descriptions, inputs, and outputs the model or outside clients depend on. That includes specs for shell, patching, MCP resources, multi-agent tools, user input, plugin installs, hosted tools, and agent jobs.

Other tests check the moving parts that execute those tools. The registry finds and runs tools. The router sends each requested call to the right local, MCP, dynamic, or extension handler. Context and trace tests make sure results and history are recorded clearly. Approval, sandboxing, network, command-canonicalization, and runtime tests guard the rules for when commands or file edits are allowed. The test synchronization tool helps timing-sensitive tests coordinate reliably. Finally, the unified-exec tests cover the newer command runner: streaming output, long-running processes, remote exec servers, timeouts, cleanup, and safe shutdown.

#### [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files

This stage is shared behind-the-scenes support for testing the core crate. It is not a feature being tested; it is the workshop that lets all the feature tests run safely and repeatably. The main entry files, `all.rs` and `suite/mod.rs`, gather the integration tests into one runnable test program and let that program pretend to be helper binaries when needed. The common toolbox supplies temporary folders, default settings, sandbox checks, hook approval setup, tracing setup, and helpers for waiting on background processes. Other helpers decide whether tests run locally, in Docker, or through Wine, and prepare special zsh fork tests when that path is available. Several files build fake outside services: mock Codex Apps, OpenAI Responses and Models APIs, WebSocket or HTTP replies, and controlled Server-Sent Event streams. Snapshot helpers turn large request data into stable readable text. The Codex test builders create a complete fake conversation world, while the exec helper runs `codex-exec` without touching real user files. Together, these pieces make end-to-end tests reliable, isolated, and understandable.

#### [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files

This stage is a large end-to-end test area for Codex’s live user sessions. It checks the main work loop and the shared support around it: sending requests to AI models, receiving streamed replies, remembering conversation state, choosing models, using tools, asking for approvals, and working with helper agents or remote machines.

The transport suites test the “wires” to model providers, including HTTP, WebSocket, realtime, retries, headers, quotas, and streamed responses. The history and persistence suites test Codex’s memory: saving sessions, compacting long chats, resuming, forking, and restoring tool logs. The prompt and model-selection suites check that each model request is packed with the right instructions, context, tools, and limits. The multi-agent suites test child agents, delegation, shared limits, job queues, and remote environments. The approvals and hooks suites test safety gates that pause, block, review, or modify actions. The tool and runtime item suites test shell commands, patches, plugins, external app tools, images, searches, and the user-visible event stream. Together, these tests prove the whole session behaves safely and predictably.

##### [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files

This stage tests the network edge of Codex: the place where a user turn becomes a request to a model service, and where streamed answers come back. It is mainly behind-the-scenes support for the main work loop. The large client suite checks the basic machinery: request shape, auth headers, history, reasoning options, token counts, and provider differences. Header-focused tests make sure turn, sub-agent, workspace, and proxy identity labels are carried correctly. Compression, model-list ETag refresh, quota errors, and safety-check downgrade tests protect specific provider rules and user-facing failures.

Several tests cover streaming paths. HTTP streaming recovery tests make sure Codex can retry if a stream ends early and can continue after a failed turn. WebSocket tests check long-lived connections for normal model replies, agent messages, warmups, retries, tracing, service tiers, and fallback to plain HTTP when WebSockets fail. Realtime conversation tests cover live audio/text sessions and handoffs back to the normal agent. Other tests cover remote compaction of long chats, the lighter Responses Lite request path, and temporary turn state that must be used for one turn only.

##### [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files

This stage tests Codex’s memory: how a conversation survives long chats, restarts, branches, and saved state. It is shared support for the main chat loop and for reopening old sessions. The compaction tests check that long history can be squeezed into a shorter summary without losing key instructions, whether done manually, automatically, remotely, after a model switch, or during replay. Resume and fork tests check that saved conversations reopen with the right messages, warnings, settings, and request history, and that a copied branch keeps or drops messages exactly where asked. Pending-input tests make sure messages that arrive during an active model turn wait for the next turn instead of being lost. Window-header tests verify the backend can still identify the right conversation “window” after compacting, resuming, or forking. Rollout and SQLite tests cover the storage layer: finding saved sessions, saving images, preserving tool logs, restored tools, and safety flags. Model override tests ensure temporary thread settings do not quietly rewrite user config or history until a real new turn records them.

##### [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files

This stage checks the “package” Codex sends to the AI model before each turn, and the model choices that shape that package. It is behind-the-scenes support for the main conversation loop: like packing a briefing folder, it must include the right notes, tools, limits, and rules without confusing them with the user’s own words. Tests cover added context from browsers or automation, saved project guidance from AGENTS.md, nested AGENTS.md rules, collaboration instructions, repository skills, prompt-debug basics, and snapshots of the model-visible layout. Other tests make sure permission messages, assistant personality, token-budget guidance, and cache-friendly prompt ordering appear once, change when settings change, and survive resumed or forked sessions. Request-shaping tests check strict JSON replies and web-search tool fields. The model-selection side verifies remote model catalogs, runtime selectors, automatic review models, and mid-conversation model switching, including service tier, image support, token limits, and special switch instructions. Together, these suites guard the boundary between Codex and the model so the model receives clear, current instructions tailored to the selected model.

##### [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files

This stage checks the system’s collaborative “many helpers” behavior. It is part of the test suite, so it does not run the product itself; it proves that the main work loop stays safe and understandable when one session starts child sessions, delegates work, or uses a remote machine.

The spawn agent description tests make sure the model is shown the right instructions for creating helper agents, including which models are allowed and when not to use them. The agent execution tests check the traffic limit: nested helpers all share one cap, so a child cannot quietly create too many more children. The delegation tests confirm that a sub-agent’s approval requests appear in the parent conversation, without duplicate status messages. The subagent notification tests cover the “wiring” between parent and child sessions: settings, roles, skills, lifecycle messages, and multi-agent communication. The agent jobs tests treat CSV rows like a work queue, sending each row to workers and collecting results safely. The remote environment tests ensure the same rules hold when files, commands, patches, and approvals happen on another machine.

##### [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files

This stage tests the safety gates that sit around Codex while it is doing its main work. These gates decide when an action can run, when the user must be asked, and when something must be blocked. The approval, exec policy, skill approval, and zsh-fork approval tests check shell commands, patches, file writes, network access, and sandbox limits. The permission request tests check the path where Codex asks for extra access, receives a limited grant, and then must obey exactly that grant.

Other tests cover human and reviewer mediation. The request-user-input tests check that Codex can pause to ask a question and resume correctly. The review and Guardian review tests check separate reviewer flows, including automatic safety review, without leaking private review details. MCP metadata tests ensure tool calls to external app servers carry the right approval and review information.

The hook and hook-MCP tests cover small user or plugin scripts that can inspect, block, rewrite, or add context around actions. The notification test checks the final “turn finished” message sent to a user command.

##### [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files

This stage is a broad end-to-end safety check for Codex’s tool system, the part of the main work loop where the model asks the program to do real things. The tool tests check which tools are shown to the model, how custom tools run, and how blocked or unsafe actions are reported. The shell and exec suites cover local commands, long-running sessions, login shells, pipes, timeouts, Unicode, macOS sandbox limits, user-typed commands, aborts, saved shell setup, parallel tool calls, and readable result formatting. The patch tests make sure file edits are applied clearly and stay inside the workspace. Other suites check large-output truncation, image viewing and generation permissions, and file upload routing for app-style MCP tools, meaning external tools connected through a shared protocol. Plugin and search tests verify that Codex can discover plugins, apps, install options, and hidden tools only when needed. Code mode tests the JavaScript-like exec path that can call other tools. Finally, item tests make sure messages, reasoning, plans, searches, images, and tool events are emitted in the right user-visible stream.

### [CLI, exec, login, and MCP server developer verification](stage-23.3.md) `stage-23.3` — 73 files

This stage is a broad test bench for the programs developers and users run from the terminal. It is not the normal work loop; it is behind-the-scenes verification that the finished executables behave correctly when used like real tools.

The apply-patch tests feed patch text to the standalone patch program and check that files are created, edited, renamed, deleted, or rejected as expected. The top-level CLI tests exercise Codex’s main command entry point, checking config errors, plugin commands, MCP server settings, JSON output, and special debug commands. The codex-exec tests focus on the program that asks Codex to perform work, making sure flags, prompts, permissions, streamed events, resume behavior, hooks, and server failures are handled predictably. The execpolicy tests verify the rule system that decides whether shell commands are allowed, blocked, or need approval. The login tests rehearse signing in, refreshing credentials, storing secrets, and logging out. The MCP server tests start the server as a real child process and talk to it with JSON messages, using a mock AI server to check tool behavior safely.

#### [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files

This stage checks the standalone apply-patch program from the outside, as if it were being used by a real person in a terminal. It is part of the project’s testing support, not the normal startup or work loop. Its job is to prove that the finished executable accepts patch input correctly and leaves the filesystem in the right state.

The suite starts in `all.rs`, which acts like the front door and loads the shared test tree. `mod.rs` is the table of contents. It selects the test groups to run and leaves out one group on Windows where the behavior does not apply. `cli.rs` focuses on command-line use: it runs `apply_patch` with patch text passed either as an argument or through standard input, then checks that files are created or changed. `tool.rs` goes deeper into real folder effects, testing edits, overwrites, renames, deletes, and clear failures for bad patches. `scenarios.rs` runs complete example patches and compares the final folder contents with the expected results.

#### [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files

This stage checks the front door of the Codex command-line program. These are integration tests, meaning they run commands much like a real user would and check the visible results: exit codes, printed text, JSON output, and saved configuration files. The app-server and exec-server tests make sure strict config mode rejects unknown settings instead of ignoring mistakes. The delete test confirms Codex will not ask for deletion confirmation when the target session is missing. The update test makes sure debug builds fail clearly instead of dropping into the normal prompt. Debug tests cover clearing stored memories safely and printing model lists as valid JSON. Feature tests check command-line feature flags and config writing. Plugin tests cover plugin commands, marketplace add, remove, and upgrade behavior, including local folders, cleanup, and error messages. MCP tests cover adding, listing, getting, and removing MCP server entries, including hiding secrets in friendly output while preserving full JSON data. Finally, the live CLI smoke test can exercise the real program against the OpenAI API, but it is normally skipped to avoid network cost and outside-service failures.

#### [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files

This stage is the safety check for codex-exec, the command-line program people run to ask Codex to do work. It is behind-the-scenes support, run by tests to make sure startup options, the main request flow, and failure exits behave reliably. The CLI and main tests check that flags, configuration options, and resume prompts are read the way users expect. The library tests cover deeper defaults such as logging, permissions, review setup, prompt decoding, and session startup. The event processor tests check how server messages become user-visible output: readable text for humans, JSONL lines for streaming tools, and simpler JSON events for automation. The integration suite then tests the whole machine assembled: extra writable directories, AGENTS instruction files, API keys and Originator headers, JSON output schemas, stdin prompts, approval modes, ephemeral sessions, hooks, required MCP tool startup failures, patch application, resume behavior, server error exit codes, and real streaming against a mock server. Together these tests make sure codex-exec is predictable for both people and scripts.

#### [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files

This stage is behind-the-scenes safety checking for the execution policy, the part of the system that decides whether a shell command may run, must be blocked, or needs user approval. It is not the main work loop itself; it is the test harness that proves the rules behave as expected.

The current tests check both the policy engine and its command-line face. One test runs `codex execpolicy check` and confirms it reports JSON correctly when a rule blocks something risky like `git push`. Another checks policy files directly, making sure commands are sorted into allowed, denied, forbidden, or prompt-needed results.

The legacy tests act like an older library of examples that must still pass. A top-level test file and module list gather the suite. “Good” and “bad” command lists protect broad expectations. Command-specific tests then inspect known Unix tools: `cp`, `head`, `ls`, `pwd`, literal subcommands, and narrow safe forms of `sed`. Together they form a regression net, catching accidental changes that would make the policy too strict or too loose.

#### [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files

This stage is the safety net for the login system. It runs during testing, not during normal use, and checks the full journey of signing in, staying signed in, and signing out. The test entry files gather the separate test modules so Rust can run them as one suite.

The smaller auth tests check the building blocks: whether different token text formats are recognized, whether personal access tokens fetch complete user data, whether API keys and environment settings are accepted safely, and whether Amazon Bedrock credentials can replace older OpenAI-style credentials. Storage tests make sure saved logins can move between files, memory, and the system keyring, which is the operating system’s secure password store.

The larger workflow tests act more like rehearsals. Command-line login tests check API-key and device-code login, where a terminal asks the user to approve access in a browser. Browser-server end-to-end tests exercise the local login server from the outside. Refresh tests confirm expired ChatGPT tokens are renewed without overwriting newer data. Logout tests ensure remote revocation is attempted and local credentials are cleaned up even if revocation fails.

#### [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files

This stage tests the MCP server as a real program, not just as separate pieces. It belongs to the “prove the system works end to end” part of the story. The tests start the codex MCP server as a child process, send it JSON-RPC messages, and check the replies. JSON-RPC is a simple request-and-response format written as JSON.

The test entry point, all.rs, gathers the integration tests so Rust can run them together. suite/mod.rs points to the codex_tool tests, like a small table of contents. common/lib.rs provides shared test tools, including a way to turn raw JSON replies into normal Rust values.

mcp_process.rs is the main wiring harness. It starts the server, talks to it, and shuts it down cleanly. mock_model_server.rs plays the role of the remote AI model, returning prepared answers instead of making real network calls. responses.rs builds those prepared streamed answers. Finally, codex_tool.rs uses all of these pieces to check real codex tool behavior, including permission prompts, approved file changes, and instruction forwarding.

### [Exec-server, sandbox, and remote transport harnesses](stage-23.4.md) `stage-23.4` — 49 files

This stage is the test workshop for the system’s execution and remote-connection machinery. It is mostly behind-the-scenes support, but it protects the main work loop where Codex starts commands, reads files, talks to remote servers, and keeps those actions boxed in safely. The shared exec-server test helpers start real or pretend servers, connect over WebSocket or standard input/output, send JSON-RPC messages, and clean everything up. Other tests check the server’s first handshake, health checks, process control, terminal handling, file access, streamed file reads, HTTP requests, and path rules on Unix and Windows.

A second group tests the secure transport pipes: Noise encryption, relay registration, message splitting, ordering, reconnects, and remote-control routing. These make sure messages are private, complete, and delivered to the right place. Another group tests sandboxing on Linux, macOS, and Windows, including filesystem permissions, network blocking, proxy use, command-line wrappers, and signal or input/output forwarding. Wine-based tests bridge into Windows behavior from non-Windows hosts. Finally, RMCP client tests check that remote HTTP-style tool calls and process cleanup still work when routed through the exec-server.

### [TUI interaction and rendering tests](stage-23.5.md) `stage-23.5` — 52 files

This stage is the safety net for the terminal user interface, or TUI: the text screen users see in a terminal. It is shared behind-the-scenes support, not product startup or shutdown code. The test support files provide fake paths, fake models, ready-made App objects, and a fake terminal screen so tests can draw UI into memory instead of a real window. The main app tests check startup, session resume, thread handling, summaries, update prompts, configuration changes, authentication, and status feeds. The chat widget tests act like a workshop for the main chat screen: they send fake server events, press keys, open popups, submit messages, approve commands, replay history, test slash commands, permissions, goals, planning, reviews, side chats, usage, and layout. Rendering-focused tests protect Markdown, history cells, token charts, status panels, colors, titles, and flexible layouts. The integration tests tie everything together, including simulated VT100 terminals, resize behavior, scrollback history, ANSI cleanup, and dependency tripwires.

### [Cross-cutting library tests, fixtures, and telemetry or rollout support](stage-23.6.md) `stage-23.6` — 190 files

This stage is the project’s shared test workshop. It is not one user-facing flow. Instead, it checks many behind-the-scenes parts that other areas depend on: reporting, settings, add-ons, service connections, saved state, and small utility helpers.

The analytics and telemetry tests make sure activity is measured, labeled, filtered, and exported safely. Configuration and policy tests check that startup settings, enterprise rules, sandboxes, permissions, paths, and environment variables are read and enforced correctly. Plugin, extension, skills, MCP, and tool tests protect the add-on system, so extra abilities are found, loaded, displayed, and called predictably. API, model, prompt, and transport tests verify fake network clients, login, streaming, prompt text, schemas, proxies, sockets, and security setup. Memories, rollout, state, and persistence tests check saved conversations, replay logs, databases, recovery, and stored memory files. Utility tests cover file URI handling and safe shortening of long output.

The directly included files add entry points and focused checks: integration test wiring, mock Cloud Tasks access, test rendering hooks, goal token accounting, file watching, hook output spilling, line buffering, terminal detection, UTF-8 string truncation, image preparation, and image-loading performance.

#### [Analytics and telemetry tests](stage-23.6.1.md) `stage-23.6.1` — 18 files

This stage is a behind-the-scenes safety check for observability: the code that records what the system is doing. “Telemetry” means measurements, logs, and traces that help developers understand sessions without inspecting them by hand. The OpenTelemetry test entry files, tests.rs and suite/mod.rs, assemble the test suite, while harness/mod.rs provides an in-memory fake metrics collector. The validation, timing, send, snapshot, runtime_summary, manager_metrics, export-routing, and HTTP loopback tests check that metrics reject bad input, record durations, flush correctly, can be read immediately, summarize runtime activity, carry the right labels, route sensitive details safely, and can be exported to a local fake collector. The analytics client tests check that app-server activity becomes the right analytics events, with batching and privacy limits. The app-server analytics tests decide when analytics should run and provide HTTP capture helpers. Core task and utility tests verify telemetry tags for proxy use, memory, compaction, feedback, authentication failures, and thread names. The main core OpenTelemetry test checks session logs and traces. The state log filter test keeps noisy low-level SDK messages out of the user-facing log database.

#### [Configuration, policy, and environment tests](stage-23.6.2.md) `stage-23.6.2` — 43 files

This stage is a safety check area for Codex’s behind-the-scenes rules: how it reads settings, applies policy, and builds the environment before real work begins. The configuration tests check that TOML and JSON files are parsed, merged, edited, and rejected correctly when they contain typos, old names, unsafe values, or conflicting profiles. Cloud-config tests add the organization-managed layer: they build fake bundles, load cached or downloaded settings, verify signatures and account ownership, and make sure enterprise rules override user settings in the right order.

Other tests cover the policy machinery. Permission, sandbox, Windows sandbox, Bubblewrap, and network proxy tests make sure file access, internet access, and approval prompts are safe and predictable. Feature-flag and tool-config tests check which experimental or model-dependent abilities turn on. Hook, prompt, MCP, instruction, and memory-guard tests verify the smaller “control panels” around tools, user instructions, external servers, and quota safety. Environment, path, Git, and test-runner tests ensure commands run with the right variables, paths, and platform assumptions. Together, these tests keep startup choices and safety boundaries from drifting silently.

#### [Plugins, extensions, skills, MCP, and tools tests](stage-23.6.3.md) `stage-23.6.3` — 50 files

This stage is the test safety net for Codex’s add-on system. It covers the parts that let Codex find extra abilities, load them safely, show them to users, and turn them into tools the model can call. The plugin tests build fake home folders, marketplaces, caches, and executor file systems, then check discovery, loading, storage, curated startup syncing, remote sharing, app routing, mentions, rendering, and install requests. The skills tests do the same for skill folders: they check selection by user input, loading from user, project, plugin, and system locations, caching, enable rules, and safe executor-owned file access. The extension tests protect the public extension interface and specific extensions such as goals, image generation, and memories. The MCP tests cover Model Context Protocol, a standard way for Codex to talk to external tool servers, including configuration, catalogs, connection caching, hosted apps, executor plugins, and real client/server calls. The tool tests make sure tool definitions, schemas, search text, code-mode forms, and API JSON stay stable. Together, these tests keep the add-on “plugboard” predictable and safe.

#### [API clients, models, protocol, prompts, and transport support tests](stage-23.6.4.md) `stage-23.6.4` — 38 files

This stage is a behind-the-scenes test bench for the parts of the system that talk to services, choose AI models, build prompts, and move data over the network. It is not the main user workflow; it is the safety lab that keeps that workflow reliable.

The model tests check provider settings, built-in defaults, user overrides, collaboration presets, model caching, and offline test model data. Together they make sure the app picks and describes models without stale data or unsafe limits. The client and login tests check HTTP requests, authentication tokens, headers, error translation, certificates, rate-limit calls, and model-list fetching, using fake servers instead of real ones. Streaming tests cover server-sent events and realtime WebSocket sessions, including retries, audio flow, and clean shutdowns.

Prompt and tool tests protect the exact text and schemas sent to AI models, including reviews, goals, memory prompts, image detail, and JSON Schema cleanup. Protocol, code-mode, RMCP, proxy, socket, TLS, and mock-cloud-task tests check error messages, streamed output, retries, authorization recovery, blocked requests, local sockets, security setup, and fake service behavior.

#### [Memories, rollout, state, and persistence tests](stage-23.6.5.md) `stage-23.6.5` — 26 files

This stage is the project’s safety net for saved history and recovery. It is not the main user-facing work loop. Instead, it checks the behind-the-scenes machinery that records conversations, rebuilds them later, and keeps stored state usable after mistakes or damage.

The rollout trace tests feed fake event logs into the trace “reducer,” which is the part that turns noisy raw events into a clean replay of a session. They cover conversations, model calls, cancellations, code cells, terminal commands, child agents, protocol events, and thread tracing. The rollout storage tests then check the files and indexes that keep past sessions searchable, compressible, repairable, and linked to saved metadata.

The state and external-agent tests check the small databases and ledgers that remember threads, imported agent sessions, and completed configuration imports. Recovery tests make sure broken database files are moved aside safely.

The memories tests cover startup, prompt text, citations, file naming, cleanup, and workspace diffs. Message-history and thread-store helpers check that saved messages and fake local thread data can be read, appended, trimmed, and reused reliably in tests.

#### [Utility crate tests for path/URI and output truncation helpers](stage-23.6.6.md) `stage-23.6.6` — 3 files

This stage is a behind-the-scenes safety check for shared utility code. It is not part of startup, the main work loop, or shutdown. Instead, it makes sure small helper libraries behave correctly before other parts of the system rely on them.

The output truncation tests check the helper that shortens large results. This is like trimming a long receipt while keeping the important warning labels intact. The tests cover plain long text, mixed text and images, encrypted content, line limits, token estimates, and odd edge cases, so shortened output stays predictable and safe.

The PathUri tests protect the type that represents local file paths as file:// addresses. They verify converting, saving, loading, joining, and parsing paths on Unix, Windows, and unusual inputs.

The API path string tests check compatibility with an older path format. They make sure file URIs can move to and from that format, including spaces, percent-escaped characters, network shares, and invalid text. Together, these tests keep path handling and output trimming reliable across the whole project.
