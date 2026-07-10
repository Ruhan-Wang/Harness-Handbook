# System Handbook — Stage Index

Each stage below links to its full page; the paragraph is the stage's role in the system.

## [Process entrypoints and binary dispatch](stage-1.md) `stage-1` — 65 files

This stage is where a native program first wakes up. It is the system’s front desk during startup: it looks at how the program was launched, reads the command-line arguments, and decides which real mode should run next.

The biggest part is the primary launch surface. These are the commands users actually type or click. They define the allowed options, choose a subcommand, and hand off to the right feature, such as the full-screen text interface, one-shot exec mode, desktop app launch, remote control, sandbox setup, health checks, archive tools, or Git-based apply actions. Each launcher is like a labeled door into a different room of the same building.

The auxiliary binaries are the support tools around that front door. They generate shared data descriptions, apply patches, search files, bridge input/output to sockets, test servers and certificates, capture notifications, and start restricted helper processes on different operating systems.

Finally, exec/src/main.rs is the specific entrypoint for the codex-exec program. It parses top-level settings, can change behavior based on argv[0] (the program name used to start it), and then passes control into the exec runtime.

### [Primary user-facing launch surfaces](stage-1.1.md) `stage-1.1` — 19 files

This stage is the system’s front door. It is the set of commands and programs a user actually starts, and it decides which path the rest of the system should take: the full-screen text interface, a one-shot command, desktop app launch, health checks, sandbox tools, or remote control.

The main router is cli/src/main.rs. It reads the command line, checks global options, and sends work to the right feature. cli/src/lib.rs holds shared command definitions and a small helper for turning socket paths into full absolute paths. The TUI files do the same job for the text interface binary: tui/src/cli.rs defines its arguments, and tui/src/main.rs starts it and reports final status. exec/src/cli.rs and cloud-tasks/src/cli.rs define the input shapes for those specialized tools, while cloud-tasks/src/lib.rs actually runs cloud task commands and its interactive loop.

Other files are focused launchers: app_cmd.rs and the desktop_app files open or install the desktop app on each operating system. remote_control_cmd.rs starts a controllable server. debug_sandbox.rs and sandbox_setup.rs run or prepare sandboxed execution. doctor.rs and thread_inventory.rs perform system checkups. session_archive_commands.rs handles archive and delete actions. apply_command.rs applies task changes to Git. mcp_cmd.rs manages external MCP server settings and sign-in.

### [Auxiliary binaries and developer tools](stage-1.2.md) `stage-1.2` — 45 files

This stage is a toolbox of side programs that support the main system from the outside. They are not the usual command path a user takes. Instead, they help with setup, testing, inspection, protocol generation, and platform-specific launching.

Several tools generate shared descriptions of data formats, called schemas, so other code and tests know what inputs and messages should look like. That includes the config schema writers, protocol exporters, hook schema fixture writers, and the small protobuf generator example. Search and patch tools do real work on their own: `apply_patch` reads a patch and applies it, while `codex_file_search` walks folders and ranks matching paths.

Other binaries are bridges and probes. They connect standard input/output to sockets, proxy APIs, export server protocols, or test custom HTTPS certificate behavior. There are also sample and test servers for MCP and app-server work, plus notification-capture helpers that write files safely in one step.

Finally, several wrappers launch restricted processes on Linux or Windows, enforce execution policy, or expose logs and exec-server helpers. Together, these tools are the workshop equipment around the main machine.

## [Early process hardening and runtime bootstrap](stage-2.md) `stage-2` — 3 files

This stage is the app’s “make it safe and ready” step. It runs right at startup, before the program begins its real work. Think of it like locking the doors, choosing the right tools, and setting up the workshop before anyone starts building.

The process-hardening code tightens security early. Depending on the operating system, it turns off things like memory dumps or debugger attachment, and it removes risky environment variables — small named settings passed to a program — that could change how shared libraries are loaded. Doing this first reduces the chance of leaks or tampering.

The rustls provider code picks the program’s global cryptography engine once, for the whole process. Cryptography here means the low-level code used for secure connections such as TLS, the standard way to protect network traffic. It installs a specific provider and checks that it supports an important signing method, so later network code behaves predictably.

The arg0 code handles how this single binary pretends to be several helper commands based on how it was launched. It also sets up PATH aliases, environment settings, and the Tokio runtime scaffolding — the async task engine — so later stages inherit a consistent setup.

## [Installation context, home discovery, and local environment probing](stage-3.md) `stage-3` — 12 files

This stage is the system’s “figure out where I am and what tools I have” step. It happens early in startup and gives later code a reliable picture of the machine, files, and shell around it.

Several parts answer “where is home?” and “how was this installed?”. The home-dir library finds the Codex home folder, either from the CODEX_HOME setting or the user’s normal home directory. install-context then works out the installation layout: where the current Codex binary came from, where bundled files live, and where helper programs like rg (ripgrep, a fast file search tool) or a packaged zsh shell can be found. managed_install adds details specific to the standalone managed install, including version lookup and file fingerprinting for updater decisions. On Windows, helper_materialization copies packaged helper executables into a shared sandbox bin folder so they are ready to use.

Other parts probe the running environment. shell_snapshot records a shell’s exported variables, aliases, and options into temporary files. exec-server environment files turn that into reusable local or remote execution environments. host_name normalizes the machine name. The doctor and cloud-detection files gather Git, OS, locale, editor, pager, runtime, and cloud-environment clues, mainly for diagnostics and startup choices.

## [Configuration, feature resolution, and startup policy assembly](stage-4.md) `stage-4` — 105 files

This stage is the startup rule-builder for the whole system. Before the app can do real work, it must decide what settings apply, which optional features are on, what built-in tools and plugins exist, and what the app is allowed to read, write, or access on the network. Think of it as gathering instructions from many places, settling conflicts, and producing one final playbook.

First, the config loaders read layered settings and requirement files from managed, cloud, user, project, thread, and command-line sources, then merge them in priority order. Shared CLI option code helps decide which command-line values win. The core config model turns those raw layers into concrete runtime choices such as model selection, workspace roots, and sandbox policy.

Next, feature and asset setup resolves feature flags, installs bundled skills and memory files, and builds catalogs for providers, plugins, MCP servers, presets, and marketplaces. Editing helpers let the UI or tools safely update config files later.

Permissions code then compiles human-written permission profiles into enforceable filesystem and network rules, including Windows-specific sandbox details. Finally, the app can expose, save, and explain the result through lockfiles, debug views, and UI sync code.

### [Config layer ingestion and requirements composition](stage-4.1.md) `stage-4.1` — 42 files

This stage is the system’s configuration assembly line. It runs mostly behind the scenes during startup, before the main work begins, and builds the final settings and rulebook that the rest of the app will trust.

One part focuses on ordinary configuration. It knows what valid config files should look like, reads them from different places such as user files, project files, managed sources, cloud sources, and command-line overrides, then merges them into one layered result. It also remembers where each value came from, produces clear error messages when something is wrong, and can save a normalized snapshot of the final config.

Another part does the same kind of work for requirements and execution policy. In plain terms, these are the extra rules that restrict what the app is allowed to do. It reads multiple requirement files, combines them in priority order, applies special merge rules for things like permissions, hooks, and proxy settings, and rejects forbidden combinations with source-aware errors.

Finally, config/src/lib.rs is the front door to all of this. It gathers the loaders, validators, editors, and data types into one public API so other parts of the codebase can use the finished configuration system from one place.

#### [Core config schemas, diagnostics, merge, and layered loading](stage-4.1.1.md) `stage-4.1.1` — 22 files

This stage is the system’s configuration workshop. It sits behind the scenes and prepares the final settings the rest of the app will use at startup and during normal work. Think of it like gathering rules from many places, checking them, then stacking them in the right order so the last agreed version wins.

Several files define what valid config can look like: config_toml.rs for the main config file, hook_config.rs for event-triggered commands, mcp_types.rs for MCP server settings, profile_toml.rs for named presets, tui_keymap.rs for keyboard shortcuts, environment_toml.rs for environment bundles, and agent_roles.rs for role definitions. schema.rs exposes schema generation for tools.

Other files build and manage the stack itself. state.rs stores layered config and where each value came from. merge.rs and overrides.rs combine file values and command-line overrides. fingerprint.rs tracks origins and stable hashes. thread_config.rs, cloud_config_bundle.rs, cloud_config_layers.rs, layer_io.rs, macos.rs, and loader/mod.rs load settings from user, project, managed, cloud, thread, and platform sources.

Finally, strict_config.rs, diagnostics.rs, and cloud-config validation.rs catch mistakes early and turn them into clear, file-based error messages. config_lock.rs saves a normalized snapshot of the final result.

#### [Requirements layering and execution-policy composition](stage-4.1.2.md) `stage-4.1.2` — 11 files

This stage is the behind-the-scenes assembly step that turns many requirement and policy files into one reliable set of rules the rest of the system can trust. Think of it like combining company policy from several binders into one current handbook, while remembering which page each rule came from.

The process starts by reading each requirements layer and cleaning it into a standard form. requirements_layers/layer.rs parses the TOML text format, keeps track of where each value came from, and prepares it for merging. config_requirements.rs defines what valid requirements look like and turns loose input into checked constraints that can reject forbidden settings with clear source-based errors.

Most fields merge normally, but some need special treatment. permissions.rs combines deny-read file patterns by adding them together. hooks.rs appends hook lists and checks for conflicts in managed hook directories. rules.rs appends prefix rules so higher-priority layers come first. stack.rs coordinates all of this into one final requirements object, and mod.rs exposes that machinery.

Execution-policy files are handled too: requirements_exec_policy.rs parses policy entries from requirements, amend.rs can safely append new rules on disk, and network_proxy_loader.rs rebuilds proxy settings when files change while enforcing trusted limits. hooks/config_rules.rs similarly computes the final saved hook override state from allowed layers.

#### [Configuration management services and editable persistence surfaces](stage-4.1.3.md) `stage-4.1.3` — 8 files

This stage is the system’s “settings desk.” It sits behind the scenes, but it is what lets other parts of the app read configuration, change it safely, and keep user choices on disk.

At the front, the app server exposes configuration through request processors. One file answers read and write requests, reports which features are turned on, and refreshes cached information after a change. Another turns low-level loading failures into clear JSON-RPC errors, the structured error format used for API replies, while keeping extra machine-readable details when possible.

Under that, the configuration service does the careful bookkeeping for writes. It validates changes, checks that nobody else changed the same setting first, saves only to the user-editable layer, and explains when a write is hidden by a higher-priority config source.

In the core layer, editing code turns high-level changes into exact edits in config.toml, the main text config file, and writes them atomically so partial saves do not leak through. Helper code handles tricky TOML table edits while preserving formatting where it can.

Two migration pieces bring settings in from elsewhere: one imports data from an external agent installation, and one-time personality migration fills in a sensible default for older users. Finally, the daemon has its own small JSON settings file for local flags such as remote-control enablement.

### [Feature flags, provider catalogs, and built-in asset installation](stage-4.2.md) `stage-4.2` — 33 files

This stage prepares the “starter kit” the rest of the system depends on before any session or screen can safely appear. It runs during startup and answers basic questions like: which optional features are on, which AI model providers exist, which built-in tools and templates should be installed, and which plugin or MCP servers are available.

The feature files define the master list of feature flags, read settings from config files, accept old flag names for backward compatibility, apply policy rules, and warn when someone enables unstable options. The TUI popup lets a user flip experimental flags and save them.

Another group sets up built-in assets. Skills config describes how skills are enabled, while the skills installer copies bundled skills into the user cache only when needed. The skills loader and manager then scan user, repo, system, admin, and plugin skill folders, apply enable/disable rules, and return the final usable set. Memory extensions seed default instruction files without overwriting user edits.

Plugins and marketplaces supply extra capabilities. Their files find marketplace folders, manage them from the CLI, load plugin metadata, and merge plugin-provided MCP servers into one conflict-resolved catalog. Model-provider, model-info, collaboration presets, approval presets, and pet asset files provide the built-in catalogs and defaults that the UI and runtime later consume.

## [Authentication, identity, and account readiness](stage-5.md) `stage-5` — 40 files

This stage is the system’s “who are you, and are you ready to use the service?” checkpoint. It mostly happens during startup and account setup, but it also supports later moments when the app needs to confirm, refresh, or change identity.

One part covers sign-in itself. The interactive and saved-login pieces let a person log in through a browser, a device code, or a pasted key, then store those credentials safely so the app can reuse them next time.

Another part acts like an ID adapter. Different backends expect different proof: a normal bearer token, an Amazon-style signed request, or an agent identity token. The provider and backend adaptation layer translates saved settings into the right kind of badge for each service.

At the center, the auth manager is the traffic controller. It loads credentials from files or environment settings, decides which auth mode is active, refreshes tokens when needed, and enforces rules about what is allowed. Supporting files classify token types, fetch account details for personal tokens, parse and store token data, create a stable installation ID for this copy of the app, and on Windows set up the special local sandbox accounts the system depends on.

### [Interactive and persisted login flows](stage-5.1.md) `stage-5.1` — 15 files

This stage is the system’s “getting signed in and staying signed in” layer. It sits around startup and account setup, and also supports later checks like “am I logged in?”, logout, and saved credentials.

At the front door, cli/src/login.rs powers the command-line commands for login, logout, and status. It supports several paths: opening a browser, using a device code (a short code you enter on another device), or storing an API key or access token directly. During these one-off commands it also writes a small log file for troubleshooting.

The login crate is the main engine behind those flows. login/src/server.rs runs a short-lived local web server so a browser can send the OAuth callback back to the app. OAuth is the standard “send you to a website, then return with proof you signed in” flow. login/src/device_code_auth.rs covers the fallback path when that browser callback is not practical. login/src/auth/storage.rs, core/src/config/auth_keyring.rs, and keyring-store/src/lib.rs decide where credentials are kept and save/load/delete them safely, including system keyrings and file fallback. revoke.rs handles token revocation on logout, while bedrock_api_key.rs stores Bedrock-style API-key auth. account_processor.rs exposes the same account actions over JSON-RPC for app-server clients, and the TUI onboarding file presents the device-code version during first-run setup. Finally, the rmcp-client files do the same kind of OAuth and credential persistence for MCP HTTP servers.

### [Provider and backend auth adaptation](stage-5.2.md) `stage-5.2` — 19 files

This stage is the system’s “ID and badge desk.” It sits behind the scenes and prepares all the different ways later network clients prove who they are. The rest of the system can then send HTTP, websocket, or RPC requests without each caller reinventing login rules.

The model-provider files are the main switchboard. They define what a provider is, choose the right provider implementation, and turn saved settings into a concrete auth method. The shared bearer-token helper adds the usual Authorization header plus extra routing headers. The Bedrock-specific files do the special Amazon path: they normalize region and URL settings, choose between bearer tokens and AWS SigV4 signing, then adapt requests so Amazon accepts the signature.

The AWS auth crate is the signing engine. It loads AWS credentials and region from config, then rewrites a request with the cryptographic SigV4 signature. Agent-identity files manage a different proof system based on keys, signed claims, and JWTs.

Other files plug these auth methods into specific places: external command-based tokens, remote-control login refresh, MCP server auth detection, API-client auth hooks, optional attestation headers, and an account processor that builds an authenticated backend client before making its request.

## [Persistence and local runtime services startup](stage-6.md) `stage-6` — 6 files

This stage is part of startup. Its job is to switch on the app’s local memory: the SQLite databases on disk that store state, logs, goals, memories, rollout data, and message history. Think of it like opening a workshop in the morning, checking the tools, fixing old labels, and setting up repair bins before real work begins.

The main engine is state/src/runtime.rs. It opens the local databases, runs needed updates called migrations, and builds the shared StateRuntime object that the rest of the app uses. state/src/migrations.rs defines those database updates and makes startup tolerant when a database was already updated by a newer version of the app.

rollout/src/state_db.rs builds the rollout layer on top of that runtime. It waits for required metadata backfill to finish, then offers helpers to list, find, reconcile, and repair thread information. core/src/state_db_bridge.rs is a small adapter that lets core code start this rollout database without depending directly on rollout internals.

If startup hits damaged database files, state/src/runtime/recovery.rs detects corruption and safely moves affected files into timestamped backup folders so they can be rebuilt. cli/src/state_db_recovery.rs turns those failures into clear user-facing guidance in the terminal interface.

## [Backend clients, remote catalogs, and startup refreshes](stage-7.md) `stage-7` — 22 files

This stage is the system’s “stock up before opening” step. After configuration and sign-in are ready, it reaches out to outside services and local AI servers to gather the facts the app needs before it can show rich choices or make smart decisions.

The cloud-config files fetch a bundled set of server-delivered settings, check that it is valid, cache it on disk, and keep it fresh in the background. The model-related files do the same kind of work for AI model catalogs: they talk to remote `/models` endpoints, adapt provider-specific catalogs like Amazon Bedrock, and turn raw model lists into the ready-to-pick presets the UI uses. The OSS helpers, Ollama, and LM Studio files cover local open-source model providers by checking whether those servers are reachable, whether the right model exists, and sometimes starting downloads or loading.

Connector and plugin discovery is another part of this stage. The connectors and ChatGPT files collect connector directories from several sources, merge and filter them, and check workspace settings that enable plugins. The startup plugin sync refreshes the local curated plugin snapshot. Finally, a few support pieces fetch task details, rate-limit reset info, startup guards, and update metadata so the app begins in a safe, informed state.

## [Transport and server runtime initialization](stage-8.md) `stage-8` — 40 files

This stage is the “open the communication channels” part of startup for any mode that can act as a server. Before the system can do its real work, it needs working paths for messages such as requests, replies, and notifications. In practice, this stage brings those paths online and makes sure clients can find and use the right server process.

One part, app-server and daemon transport bring-up, starts or locates the main background server, checks that it is alive, and opens the normal ways to talk to it. That includes standard input/output, Unix sockets, and WebSocket connections, plus remote-control features and the rules for the first handshake, the initial “hello” exchange that proves both sides are ready.

The other part, execution and integration sidecar servers, adds extra helper servers around the main app. These adapters let outside tools connect through different channels, including stdio, WebSocket, HTTP, and secure relay links. They also support remote environments, session reconnects, MCP tool servers, and proxy bridges. Together, these pieces build the message roads the rest of the system will drive on.

### [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files

This stage is the system’s “bring the server to life and open the doors” step. It sits between startup and normal work. Its job is to launch or find the app-server, connect callers to it, and set up the ways messages can travel in and out.

On the daemon side, app-server-daemon/src/lib.rs is the conductor. It decides how to start, probe, and stop background processes. The backend files define and implement the PID-file method, which uses saved process IDs to manage detached server and updater programs safely. client.rs is the daemon’s low-level probe tool, talking JSON-RPC over a local socket to check whether the server is ready. remote_control_client.rs turns remote control on or off and waits for status updates. The doctor check inspects this setup without changing anything.

On the server side, app-server/src/lib.rs boots the runtime, while transport.rs, outgoing_message.rs, and initialize_processor.rs manage connections, route replies and notifications, and make sure each client finishes its hello handshake before full use. The transport package provides stdio, Unix-socket, and network WebSocket paths, plus WebSocket auth rules. The remote-control files add enrollment, reconnect, and session tracking. Finally, the client and TUI facades give CLI and terminal UI code one simple way to talk to the server, whether it runs inside the same process or in the background.

### [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

This stage is a set of helper servers that run beside the main app and expose its abilities through different “wire formats” and channels. Think of it as the adapter rack: one piece speaks over standard input/output, another over WebSocket, another over HTTP, and they all let outside tools reach the same core features.

The exec-server is the biggest piece. Its library root defines the public surface. The connection and transport files open JSON-RPC links, which means request-and-response messages sent as structured text, over stdio or WebSocket. The client and client transport layers then use those links to control processes, access files, track sessions, and reconnect if a remote side drops.

The Noise relay files add a secure encrypted path for remote execution. They perform the handshake, wrap messages into relay frames, and turn them back into normal JSON-RPC streams on each side. Remote registration ties this into the environment registry and key authorization.

Alongside that, the MCP runtime and clients launch and manage tool servers, either locally or in remote environments. The MCP server runs its own message loop. Separate bridges relay stdio to Unix sockets, proxy response API calls with injected auth, and run HTTP/SOCKS network proxies. Together, these sidecars let the system plug into many environments safely and consistently.

## [Frontend session startup and user-facing initialization](stage-9.md) `stage-9` — 41 files

This stage is where the program stops being just a prepared backend and becomes something the user can actually use. It is the last step of startup for the frontend: either a live text interface opens, or a one-shot command runs and exits.

One part starts the TUI, the text-based screen interface. It loads settings, connects to the already started background services, and finds or resumes the right session. Before the main screen appears, onboarding can ask first-run questions like sign-in, folder trust, or approval choices. At the same time, terminal setup pieces test what the terminal can do, switch it into the right modes, manage keyboard behavior, protect the display from stray output, handle resize and suspend/resume, and choose titles and notifications. Extra startup pieces fill in the first screen so it feels complete, with chat state, history, status hints, and similar visible details.

The other part covers exec mode, the non-interactive path. It builds a session from command-line options, can resume saved work, runs the job to completion, and sends results to normal output or structured JSONL logs for scripts.

### [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files

This stage is the “opening act” for the text-based interface. It gets the program ready to take over the terminal, asks the user any important questions, and only then hands control to the main app loop. In simple terms, it is startup and terminal ownership.

The top-level entry files in lib.rs and app.rs load settings, connect to the background app server, attach to a session or pick one to resume, and then launch the interactive screen. Before that, onboarding modules show the welcome page, sign-in choices, trusted-folder question, and fixed early keyboard shortcuts. Other startup prompts handle hook trust review, model changes, update approval, working-directory choice, and importing outside agent settings.

Several pieces prepare the terminal itself. tui.rs, custom_terminal.rs, terminal_probe.rs, keyboard_modes.rs, terminal_stderr.rs, job_control.rs, notifications, terminal_title.rs, and resize_reflow_cap.rs decide what the terminal can do, switch modes on safely, protect the screen from stray output, support suspend/resume, and pick notification and title behavior.

Finally, chat widget setup, replay, MCP startup status, tooltips, history cards, collaboration mode helpers, status previews, and pets make the first visible screen feel complete rather than empty.

### [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

This stage is the startup and run-to-finish path for non-interactive use: when the tool is asked to do one job, complete it, and exit, rather than open a live chat screen. You can think of it as the “single trip” mode of the system.

The main driver is exec/src/lib.rs. It takes the command-line options the user supplied and turns them into a full session setup. It starts the app server inside the same process, builds the request that will be sent to the model, runs the event loop (the repeating cycle that processes events until the job is done), and then prints the final result. It also prepares structured JSONL output, which means one JSON record per line for easy logging or scripting, and includes small adapter helpers so shared core settings fit this exec mode cleanly.

tui/src/session_resume.rs supports cases where this one-shot run resumes or forks from an earlier saved session. It finds key saved details such as the thread ID, working folder, and model choice. It prefers the central state database when possible, but can fall back to reading local JSONL history files. If the saved folder differs from the current one, it asks the user which to use.

## [Main event loop and request dispatch](stage-10.md) `stage-10` — 137 files

This stage is the system’s “busy at work” loop. After startup is done, it spends most of its life here, watching for anything that happens and sending each thing to the right place. That includes user actions in the terminal app, incoming JSON-RPC messages (a standard message format with a method name and inputs), and background updates from other parts of the system.

The interactive event dispatch side is the front-desk for the user interface. It turns raw keyboard input, redraw requests, popups, and chat actions into clear app events, then routes them to the right screen, tool, or conversation thread.

The RPC request routing side is the front-desk for outside callers and helper services. It reads incoming protocol messages and hands each request to the specialist that knows that feature area.

Several direct files support this traffic flow. The exec server processor drives one JSON-RPC connection from start to finish. Session handlers are the central dispatcher for almost all protocol operations inside a live session. Request serialization keeps conflicting requests for the same resource in safe order while letting unrelated work run in parallel. Tool parallelism runs compatible tool calls at the same time, or one-at-a-time when needed, and cleans up correctly if work is cancelled.

### [Interactive event dispatch](stage-10.1.md) `stage-10.1` — 96 files

This stage is the terminal app’s switchboard. It lives in the main work loop, after startup, and decides where each incoming event should go. An event is simply “something happened,” such as a key press, a paste, a popup choice, a server update, or a request to redraw the screen.

At the bottom, event_stream.rs gathers raw terminal input and draw notifications into one shared stream of app-friendly events. It also works around a practical problem: only one part of the program can “own” keyboard input at a time, so it can safely drop and recreate that input stream when the app pauses or resumes.

From there, app-level dispatch and thread routing act like traffic control. They take each event, choose the right action, and keep separate conversation threads in sync. The bottom-pane composer, popups, and mention input turn typing into messages, slash commands, searchable pickers, and prompt overlays. The chat widget interaction layer handles the main conversation screen and command flows. Specialized interactive flows cover side tools like history browsing, settings, keymaps, and other focused popups. Together, these parts make the interface feel responsive and organized.

#### [App-level event dispatch and thread routing](stage-10.1.1.md) `stage-10.1.1` — 10 files

This stage is the traffic control center for the text user interface. It sits in the app’s main work loop and decides what to do when something happens: a key is pressed, the server sends news, a thread changes, or the screen needs redraw.

The flow starts with app_event_sender.rs and app_command.rs. They give the rest of the UI a simple, typed way to say “do this” without hand-building raw messages. event_dispatch.rs is the central dispatcher: it reads those queued events and turns them into real actions such as UI updates, server calls, config saves, thread switches, or exit.

input.rs handles top-level keyboard shortcuts before they reach the chat area. frame_requester.rs asks for screen redraws, but batches many requests together and slows them to a safe frame rate. app_server_events.rs is the bridge from server messages into the right UI parts. app_server_requests.rs remembers server requests that need a later user answer. thread_routing.rs keeps separate conversation threads organized, including switching and replaying their state. pending_interactive_replay.rs makes sure only still-unanswered prompts are replayed. background_requests.rs sends slower disk or network work off the main loop, then reports back through app events.

#### [Bottom-pane composer, popups, and mention input](stage-10.1.2.md) `stage-10.1.2` — 42 files

This stage is the bottom strip of the terminal app where the user types, picks things, and answers prompts. It is part of the main work loop: after startup, this is the control panel that turns keystrokes into messages, commands, and small popup-driven tasks.

At the center is the chat composer. The textarea files manage the actual editing experience: moving the cursor, selecting text, optional Vim-style editing, and spotting “paste bursts” so pasted text behaves sensibly. The composer also keeps draft state, footer hints, attachment rows, and message history, including Ctrl+R search through older entries.

Around that core are popups. Slash-command code recognizes inputs like “/name …”, knows which commands exist, and powers the command picker. Mention and file-search code builds a searchable catalog of skills, plugins, and files, then shows matches in an interactive popup. Reusable list and multi-select widgets support many other bottom-pane tools, such as status-line setup, title setup, skill toggles, memory settings, hooks browsing, feedback, and custom prompts.

Finally, the bottom-pane host decides which view is active, routes input to it, renders the result, and handles request-style overlays such as app-link and server form prompts.

#### [Chat widget interaction and command flows](stage-10.1.3.md) `stage-10.1.3` — 23 files

This stage is the chat screen’s “control room.” It sits in the main work loop of the app: it shows the conversation, reacts to what the user does, sends requests out, and updates the screen as replies and status events come back.

The heart is chatwidget.rs, which keeps the chat screen’s state together. rendering.rs draws that state as the transcript, temporary notices, and the bottom input area. interaction.rs listens for keys and nearby actions like paste, copy, rename, and quit. input_submission.rs turns what the user typed into a real message or command, while input_flow.rs decides whether to send it now or queue it. input_queue.rs stores queued drafts, and input_restore.rs puts them back after interruptions.

slash_dispatch.rs routes slash commands such as /usage, /goal, or /ide to the right feature. skills.rs, ide_context.rs, goal_menu.rs, hooks.rs, connectors.rs, model_popups.rs, review_popups.rs, plan_implementation.rs, reasoning_shortcuts.rs, tokens.rs, and usage.rs each power a specific tool or popup. protocol.rs and protocol_requests.rs translate backend messages into visible chat updates, approvals, and prompts. interrupts.rs delays urgent UI events until they can be shown safely, and notifications.rs decides when to raise desktop alerts.

#### [Specialized interactive flows and auxiliary TUI handlers](stage-10.1.4.md) `stage-10.1.4` — 20 files

This stage covers the side paths of the terminal app: small but important interactive flows that sit next to the main chat loop. Think of it as the set of special tools and pop-up workbenches the app opens when the user wants to browse history, change settings, pick extras, or use a separate cloud task screen.

The cloud-tasks files define that task screen’s state, the new-task form, and the code that draws lists, detail panels, diffs, and modal dialogs. Several files power focused TUI flows in the main app: backtracking lets a user step backward through transcript history and confirm a rollback; the pager overlay shows long transcript or static content in a scrollable full-screen view; and the multi-agent files keep track of agent threads, labels, shortcuts, and picker display.

Other files support configuration and convenience features. The keymap files drive the guided shortcut editor, its action catalog, picker, and debug inspector for showing what key the terminal actually sent. The pets files handle choosing, previewing, animating, and saving a terminal pet. Theme picking previews colors live. Clipboard helpers import pasted text or images. External import and platform-action files handle OS-specific helpers and the Claude Code migration flow.

### [RPC request routing](stage-10.2.md) `stage-10.2` — 37 files

This stage is the system’s switchboard. It sits in the main work loop, after a message arrives from a client or another service, and decides where that message should go next. Most messages use JSON-RPC, a simple format for naming a method and its inputs.

The main app-server router in message_processor.rs enforces startup rules, keeps track of each connection, and sends each request to the right specialist. The request processor files are those specialists: threads and turns drive conversations, goals and deletion manage thread state, catalog, models, plugins, marketplace, feedback, search, git, remote control, environments, filesystem, sandbox setup, and external-agent import each handle their own feature area. Shared helpers clean up request data and turn failures into user-facing protocol errors.

Several files bridge requests into deeper runtime systems. dynamic_tools.rs feeds tool-call results back into live conversations. attestation.rs asks the client for proof tokens. fs_watch.rs turns file changes into notifications. In core, the tool router and registry choose and run tools safely.

Parallel routers do the same job in other servers: exec-server dispatches process, file, and HTTP methods; mcp-server handles MCP tool calls; rmcp-client handles elicitation prompts; and the network proxy routes HTTP traffic under policy rules.

## [Thread and session orchestration](stage-11.md) `stage-11` — 44 files

This stage is the system’s conversation traffic controller. It sits around the main work loop and makes sure each piece of work belongs to the right thread, meaning one ongoing conversation, and the right long-lived session object that remembers history, settings, and live state.

At the center, the thread manager creates, resumes, forks, looks up, and shuts down threads. A CodexThread is the live handle clients use to talk to one thread. The session modules build the actual session runtime: queues for incoming input, shared services, saved state that survives across turns, and per-turn state for the turn currently running. Task code then starts and tracks the background jobs that drive each turn.

History and persistence are the memory layer. Thread-store files create and wrap local thread records, sync metadata, and reconstruct or trim history when a thread is resumed or forked. Environment selection prepares the execution environment snapshot each thread should use.

Around that core, app-server, exec-server, TUI, code mode, and extensions keep thread state visible and usable: they attach listeners, switch between threads, refresh services, import outside sessions, and add thread-specific features like goals, skills, plans, and side conversations.

## [Prompt, context, and extension assembly](stage-12.md) `stage-12` — 74 files

This stage is the briefing builder that runs just before the model starts its main work on a turn. Its job is to gather everything the model should know right now and turn it into one exact input packet. You can think of it like packing a suitcase: some items are always available on the shelf, some depend on the trip, and some are last-minute updates.

One part provides the basic pieces and templates: built-in instruction text, standard “context fragments” (small chunks of formatted information), and the public helper modules other code calls. Another part defines many concrete fragment types, such as environment details, permission warnings, skills, shell activity, and saved rules, so different information can all be wrapped in a consistent shape.

Contributor modules then choose which pieces to include for this turn: user and project instructions, AGENTS.md notes, collaboration rules, writing style, IDE information, apps, plugins, skills, memories, goals, and review prompts. Finally, the turn-assembly code snapshots current settings, cleans and trims conversation history, tracks what changed, manages token-budget notices, and builds special compact prompts for realtime and web-search modes.

### [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files

This stage is shared behind-the-scenes support for building the text the model sees. Think of it as the shelf of instruction cards and adapters used before the main work begins. It does not run the model by itself. Instead, it supplies the raw instruction text, the small building blocks of context, and the public entry points other parts of the system use.

The embedded instruction files are the source of built-in guidance. collaboration-mode-templates/src/lib.rs stores the standard collaboration instructions as fixed text inside the program. codex-home/src/lib.rs exposes the user-home instruction provider, which is the piece that can supply user-facing instructions. prompts/src/lib.rs is the front desk for prompt-related code, gathering and re-exporting the prompt tools others need.

The context-fragments files define the shape of a fragment, meaning one small piece of context to insert into the final prompt. fragment.rs sets the rules for how fragments are described, rendered into text, and converted for protocol use. context-fragments/src/lib.rs exposes those fragment types. ext/extension-api/src/contributors/prompt.rs gives extensions a simple fragment type for aiming content at the right slot. core/src/context/mod.rs gathers many context pieces into one central place, and permissions_instructions.rs simply re-exports one shared instruction fragment so core code can use it consistently.

### [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files

This stage provides the raw building blocks for what the AI model actually sees. It sits in shared behind-the-scenes support: not the main work itself, but the parts that shape instructions and context before a prompt is assembled.

One group of files stores reusable prompt text directly in the program, like canned instruction cards. These include guidance for agent coordination, using the apply_patch tool, compact summarizing, and realtime mode start/end behavior.

The other group defines “context fragments,” which are small formatted pieces of information that can be inserted into a conversation. Some fragments describe the environment, token budget, saved command or network rules, model switches, interruptions, or shell commands the user ran. Others carry outside instructions, such as AGENTS.md content, hook text, skills listings, or a single skill’s prompt. There are also fragments for realtime session boundaries and subagent status updates.

Several files act as adapters: they take internal data and wrap it into a standard tagged text shape. A few legacy files only recognize old warning formats so stored past sessions still make sense. Together, these pieces make prompt assembly consistent and predictable.

### [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files

This stage is the system’s prompt-building workshop. Before the model answers, these parts gather all the guidance it should see: long-term rules, project notes, optional features, and situation-specific hints. Think of it like packing a briefing folder before a meeting.

Some files load standing instructions from the user’s home folder and from project files like AGENTS.md, then combine them while keeping track of where each piece came from. Other files add context-dependent guidance: collaboration mode rules, a requested writing personality, terminal display advice, image-output instructions, IDE context, and the current permission limits such as sandboxed files or blocked network access.

Several parts describe available extras the model can use. Skills code finds skills mentioned by the user, injects their SKILL.md content, and also renders a compact catalog of available skills. Similar pieces explain apps/connectors and plugins, and can add extra instructions when a specific plugin is named.

Finally, memory, goal, and review contributors add higher-level steering. They surface saved memory summaries, goal-following prompts, and the exact text used for code review requests and review completion. Together, all of these contributors shape what the model knows for this turn.

### [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

This stage assembles the exact packet of information the model sees for the next turn. It sits right before the model does its main work. Think of it as a packing desk: it gathers the latest settings, recent conversation, small updates, and special startup notes, then puts them into one clean bundle.

`turn_context.rs` creates a fixed per-turn snapshot from changing session settings, permissions, environment choices, and runtime services. `history.rs` keeps the conversation transcript in memory, trims it when needed, and makes sure paired tool calls and results stay consistent. `normalize.rs` repairs or removes malformed history so the prompt stays safe and readable.

Several files add only what changed. `additional_context.rs` tracks keyed extra context and emits updates only for new or changed entries. `updates.rs` compares old and new turn context and turns differences into messages the model can read. `token_budget.rs` adds “tokens remaining” notices when usage crosses meaningful thresholds.

For realtime work, `realtime_context.rs` builds a compact startup summary, and `realtime_prompt.rs` chooses the prompt text itself. `contextual_user_message.rs` separates true user text from internal injected context. `prompt_debug.rs` recreates a single turn for inspection, and `ext/web-search/src/history.rs` makes a much smaller history for web search.

## [Turn execution and model interaction](stage-13.md) `stage-13` — 88 files

This stage is the heart of one conversation turn: the system takes the next user input, decides what needs to happen, talks to the model, reacts to live results, and wraps the turn up. In the system’s story, this is the main work loop.

core/src/tasks/regular.rs starts a normal turn and keeps running turns until there is no queued input left. core/src/session/turn.rs is the conductor. It checks whether the conversation should be compacted, meaning older history is squeezed into a shorter summary to save space. That compaction can happen locally in core/src/compact.rs, or be handed to the model service by core/src/compact_remote.rs and core/src/tasks/compact.rs.

Before sending a request, core/src/turn_metadata.rs adds extra facts about the turn, such as session identity and workspace details. The Model transport execution part then sends the request over the right connection and reads the streamed reply. The Streaming reduction and UI projection part turns that live stream into readable screen updates.

Alongside this, the code-mode runtime files provide a small JavaScript engine for code-mode tasks: mod.rs runs it, module_loader.rs loads user code, and timers.rs supplies basic timeouts. Together, these pieces carry a turn from input to finished result.

### [Model transport execution](stage-13.1.md) `stage-13.1` — 28 files

This stage is the system’s “talk to the model service” layer. It sits in the main work path, after the app has decided what to ask, and before higher-level features can use the answer. Its job is to package requests, send them over the right channel, read streamed replies, and turn transport failures into clear public errors.

At the center, core/src/client.rs manages a model session: it chooses HTTP, server-sent events (a one-way live event stream), WebSocket, compact endpoints, memory summary, image, search, or realtime call routes. Small shared types in client_common.rs and responses_metadata.rs define the request payload, stream wrapper, and attached metadata. requests/responses.rs and tools/src/responses_api.rs shape request bodies, including tool descriptions.

The endpoint files are the actual connectors for each API path. responses.rs, compact.rs, memories.rs, images.rs, and search.rs send typed HTTP requests. sse/responses.rs and responses_websocket.rs decode live streamed output. api_bridge.rs translates low-level failures into user-facing Codex errors.

For live conversations, realtime_call.rs, realtime_websocket/*, realtime_conversation.rs, and realtime-webrtc/* handle WebRTC and realtime WebSocket setup, messages, and event parsing. responses_retry.rs and session_startup_prewarm.rs make this smoother by retrying, falling back, and preparing a session early.

### [Streaming reduction and UI projection](stage-13.2.md) `stage-13.2` — 51 files

This stage is the “live display pipeline” for the app’s main work loop. It takes a stream of low-level events and half-finished text, turns them into stable pieces, and keeps the terminal UI readable while new output is still arriving.

First, the stream parsers clean assistant text as it comes in. They strip hidden citation tags, pull out proposed plan blocks, and leave the visible text behind. Markdown streaming then decides what is safe to “commit” now versus what must wait, especially for tables, which can change shape until more lines arrive. The markdown renderer, syntax highlighter, diff renderer, and table fallback renderer turn that text into terminal-friendly lines.

Next, the streaming controllers and commit-tick logic manage the flow: they queue finished lines, keep a mutable live tail, and choose whether to drip output smoothly or catch up quickly. History-cell modules define every transcript row type, from messages and plans to approvals, searches, hooks, patches, and command output.

Finally, ChatWidget state and lifecycle code assemble these cells into the visible transcript, footer status, and live indicators, while resize reflow and consolidation rebuild the transcript cleanly when the window changes or streaming finishes.

## [Tool execution, approvals, and guarded side effects](stage-14.md) `stage-14` — 294 files

This stage is the system’s action engine. It runs in the main work path when the model stops talking and asks to do something real, like run a shell command, edit files, call an outside tool server, search the web, or use memory and skills. Its job is to turn that request into a safe, approved action and then turn the outcome back into something the model can read.

First, the approval and guardian pieces act like a checkpoint. They read the rules, consider sandbox limits, ask for human approval when needed, run plug-in hooks, and enforce the final decision. Next, the execution backends are the workshop floor: they start commands, manage interactive sessions, apply patches, and keep runs inside sandboxes, which are restricted environments.

Extension and integration tools add the “special abilities” layer. They keep outside connections alive, expose available tools, and route calls to web, image, memory, skills, code, and MCP servers. Shared safety helpers inspect command text, recognize obviously safe or dangerous patterns, and build concrete sandbox policies.

The direct files define the common tool contract, schema cleanup, MCP conversion, shared handler utilities, public crate entry points, and error types that separate ordinary tool failures from fatal runtime problems.

### [Approval, guardian, and hook mediation](stage-14.1.md) `stage-14.1` — 63 files

This stage is the system’s checkpoint and referee. It sits in the main work path whenever the program wants to do something with real side effects, like run a command, reach the network, change files, or ask an outside helper program to weigh in. Its job is to decide whether to allow the action, ask someone, review it more carefully, or stop it.

One part is the policy engine. It reads approval rules, combines them with the current sandbox and permission settings, and gives the first answer: allow, ask, or block. If a human decision is needed, the request-ingress pieces turn many incoming request types into one standard approval request. Then the guardian review system prepares a clear summary, starts or reuses a focused review session, and records the result.

Hooks are like plug-in checkpoints. The hook runner discovers configured hook programs, runs the ones that match an event, and interprets replies such as continue, stop, or add context.

Around this, the tool orchestrator and UI make approval prompts understandable and keep risky tool actions paused until a decision is made. Finally, the enforcement runtime turns those decisions into real behavior by applying live network and Windows sandbox restrictions.

#### [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files

This stage is the system’s gatekeeper. It sits in the main decision path whenever the program is about to run a command, use the network, apply a patch, or relax sandbox limits. Its job is to answer: may this go through automatically, should the user be asked, or must it be blocked?

The newer execution-policy engine is the main machinery. The crate root ties the pieces together. The parser reads policy files written in a small rule language and turns them into internal rules, while keeping source locations so error messages can point to the right line. The rule and policy files define what a rule looks like, how command prefixes and network hosts are matched, and how several layers of policy are combined into one final verdict.

Around that, core decision code loads and updates rules, mixes them with approval settings and current sandbox state, and produces the final approval requirement. Shared sandboxing code provides common approval caches and override rules. Separate helpers translate network decisions into user prompts and saved rule changes, and decide whether code patches can be auto-approved.

The legacy engine remains as an older checker. It parses old-style policies, matches programs and arguments, and does an extra safety pass on file paths and executable resolution.

#### [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files

This stage is the system’s safety review desk. It sits in the main work path whenever an action needs mediated approval, and it decides how to ask for that approval, run the review, and report the result.

At the bottom, core/src/guardian/mod.rs defines the shared building blocks and a circuit breaker, which is a safety stop that cuts off a turn after too many automatic denials. core/src/guardian/approval_request.rs turns a real approval event into several useful forms: structured data, analytics data, and readable text for a reviewer. core/src/guardian/prompt.rs then assembles the actual reviewer prompt from the request plus relevant session history, trims it to stay compact, and reads the reviewer’s JSON reply back into internal data.

To run the review, core/src/session/review.rs starts a special nested sub-turn inside the current session, with tighter limits and a review-focused prompt. core/src/guardian/review_session.rs manages those nested review sessions, including reusing an existing one, making temporary forks for parallel checks, and handling timeouts or cancellation. Finally, core/src/guardian/review.rs is the conductor: it routes requests, launches reviews, retries when needed, records metrics, stores rejections, and ties everything into the circuit breaker.

#### [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files

This stage is the system’s hook runner: the part that lets outside commands watch key moments and influence what happens next. A hook is a small extra program that can inspect an event and reply with “go on,” “stop,” “block this,” or “add this extra context.” This sits in the main work loop, between normal actions like starting a session, sending a prompt, using a tool, asking permission, compacting history, and stopping.

At the top, the registry and engine build the hook system from configuration and expose simple “preview” and “run” entry points. Discovery finds which hooks exist, whether they are enabled, and whether they are trusted. The dispatcher then picks the hooks that match a specific event and runs them, while the command runner actually launches the child processes and captures their output. The output parser turns that output into structured decisions, and output spilling saves oversized output to temp files while keeping only a smaller visible summary.

The event files contain the special rules for each moment in the lifecycle. The runtime adapter connects all of this to sessions and turns, emits events and metrics, and passes any hook-produced context back into the conversation. Legacy notify support keeps older hook commands working too.

#### [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files

This stage is the system’s front desk for requests that need a human answer. It sits between outside callers—tools and MCP integrations—and the deeper approval and review system. Its job is to take several kinds of “please decide” requests, clean them up into a standard shape, and pass them inward so the right person or policy can respond.

The request_permissions tool accepts a tool’s ask for extra permissions, figures out what environment that request applies to, converts the requested permission set into a normalized form, and sends it to the session for approval. The request_user_input tool does the same kind of intake work for general structured questions that need user-provided data.

On the MCP side, elicitation.rs is the traffic controller. It keeps track of open MCP requests, checks approval rules, and either answers automatically or emits an event so Codex can ask for a decision. exec_approval.rs and patch_approval.rs are two specific feeders into that bridge: one asks for approval to run shell commands, and the other asks for approval to apply code changes. Together, these parts turn many incoming request styles into one consistent approval flow.

#### [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files

This stage is the system’s traffic controller for risky or sensitive tool actions. It sits in the main work loop, between “the assistant wants to do something” and “the tool actually runs.” Its job is to make sure the right approval, permission, and safety checks happen, then show clear choices to the user.

At the center, the tool orchestrator runs the whole sequence: ask for approval, choose a sandbox (an isolated safe-running environment), register any network access that also needs approval, try the tool, and retry with broader access if policy allows. For connector-specific tools, the approval template code turns raw requests into readable prompts with friendly parameter names.

On the screen side, approval event models reshape server messages into forms the TUI can render easily. The approval overlay shows yes/no and permission choices. The request-user-input overlay handles more complex questionnaires and queued prompts. Tool-request UI ties everything into chat, status messages, notifications, and final transcript entries. Permission popups, the permissions menu, and Windows sandbox prompts guide users through access choices. Pending-thread approvals and recent auto-review denials keep unresolved or blocked actions visible. Hooks RPC supports the special flow for reviewing and trusting hooks.

#### [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files

This stage is the system’s “enforcement layer.” It sits beside approval flows and turns decisions like “allow this network call” or “block access to this folder” into live behavior while the program is running.

On the network side, network-proxy/src/lib.rs is the entry point that assembles the proxy pieces. state.rs takes raw policy settings and turns them into a checked, ready-to-use runtime form. network_policy.rs defines how the proxy asks for a decision and records what happened in audit logs. runtime.rs is the live engine: it keeps the current rules in memory, can reload them, and applies them to HTTP and SOCKS traffic. core/src/tools/network_approval.rs connects this to tool execution. It remembers active requests, avoids asking the same approval twice, caches session decisions, and turns proxy blocks into clear tool errors.

On Windows, the sandbox files enforce local OS protections. windows_sandbox_read_grants.rs safely adds an allowed read folder. workspace_acl.rs tightens folder permissions for sensitive workspace areas. deny_read_state.rs keeps deny-read permission state across runs. wfp.rs installs Windows Filtering Platform rules, and wfp_setup.rs wraps that setup so failures are logged and measured without stopping the rest of startup.

### [Execution backends and sandboxed command runtimes](stage-14.2.md) `stage-14.2` — 91 files

This stage is the system’s command-running machinery. It sits in the main work path whenever the app needs to start a shell command, keep talking to it, apply a patch, or stop it cleanly. You can think of it as the workshop floor plus the safety cage around it.

One part is the command control center, which accepts requests from the app or text UI and turns them into real running programs. Under that, the unified-exec session layer makes different kinds of runs look the same, whether they use a PTY (a fake terminal window for interactive programs), plain input/output pipes, or a remote exec server.

Another part is the patch engine, which reads patch text, checks it, and applies file changes through the normal approval and sandbox rules. The sandbox launchers are the gatekeepers: on Unix they choose tools like bubblewrap or privilege escalation when needed, and on Windows they prepare a locked-down sandbox identity before launch. The exec-server filesystem services give sandboxed or remote runs safe file access. Finally, sleep.rs provides a simple timed pause tool that can wake early on new input and records that pause in the turn history.

#### [Execution-facing app-server and core command orchestration](stage-14.2.1.md) `stage-14.2.1` — 15 files

This stage is the system’s “run a command” control center. It sits in the main work path: when a user, tool, or UI asks to start a shell command, send more input, resize a terminal view, or stop a running process, this is the layer that turns that request into a real program execution.

On the app-server side, the request processors are the front desk. command_exec_processor.rs and process_exec_processor.rs accept JSON-RPC requests, which are structured messages sent over the app connection. They translate those messages into running processes and route follow-up actions like stdin input, resize, and terminate. command_exec.rs keeps long-lived command/exec sessions alive, tracks them per connection, streams output back, and finishes with a final result. The TUI files provide client helpers: fs.rs smooths over local versus remote server calls, and workspace_command.rs gives the text UI a simple way to run short workspace commands.

In core, exec.rs is the safe process runner. sandboxing/mod.rs shapes approved execution requests. user_shell.rs powers the /shell task. The shell and unified_exec handlers and runtimes decide how to launch commands, apply approval and sandbox rules, support patch interception, pick backends like zsh-fork on Unix, and finally hand everything to the process launcher.

#### [Unified-exec sessions and PTY/process backends](stage-14.2.2.md) `stage-14.2.2` — 17 files

This stage is the engine room for interactive command sessions. It sits in the system’s main work path whenever the app starts a command, talks to it while it runs, and shuts it down cleanly. Its job is to make many kinds of processes look the same to the rest of the code, whether they run locally, through a remote exec server, in a normal pipe connection, or in a PTY, a pseudo terminal that behaves like a real terminal window.

At the center, the unified-exec module defines the shared request, state, and error types. The process wrapper tracks one running command: its output, exit status, cancellation, and failures. Above that, the process manager is the traffic controller. It assigns IDs, launches commands through the shared spawn routine, stores live processes, forwards input, polls output, and cleans up.

The write_stdin tool is the doorway for sending keystrokes or input into an interactive session. On the exec-server side, common process traits define the contract, while local and remote backends either run the command directly or control it over RPC, a remote procedure call. The PTY library supplies the actual Unix and Windows terminal or pipe implementations, plus process-group helpers so whole process trees can be stopped reliably.

#### [Patch application engine and patch-execution adapters](stage-14.2.3.md) `stage-14.2.3` — 9 files

This stage is the system’s “edit mechanic.” It takes a text patch — a set of instructions that say which lines in which files should change — checks that it is valid and safe, and then applies it through the normal tool and approval system. It sits in the main work path whenever the system is asked to change files by patch rather than by rewriting whole files.

The process starts with the tool definition in apply_patch_spec.rs, which describes what an apply_patch request can look like. apply_patch.rs is the conductor: it reads the request, parses the patch, works out what permissions are needed, prepares hook data for surrounding systems, and reports progress as the patch is processed. core/src/apply_patch.rs is the decision point that chooses whether to reject the request, ask the runtime to execute it, or turn it into lower-level file edits.

Inside the patch engine, streaming_parser.rs and parser.rs read patch text and turn it into structured change blocks. invocation.rs also understands command-style and heredoc-wrapped forms. lib.rs then computes and performs the actual file changes. core/src/tools/runtimes/apply_patch.rs runs approved patch work inside the sandbox. git-utils/src/apply.rs offers a separate helper that uses git apply when that route is needed.

#### [Sandbox selection and Unix platform launchers](stage-14.2.4.md) `stage-14.2.4` — 16 files

This stage is the behind-the-scenes gatekeeper that decides how a command should actually be launched on Unix systems, especially when it needs to run inside a safety box called a sandbox. It sits between a high-level “run this tool with these permissions” request and the final operating-system command.

The main entry points in sandboxing/src/lib.rs and sandboxing/src/manager.rs expose this feature and turn a general request into a platform-specific launch plan. On Linux, sandboxing/src/bwrap.rs checks whether bubblewrap, the main Linux isolation tool, is available and worth warning about. sandboxing/src/landlock.rs and core/src/landlock.rs build and pass the exact arguments for the Linux sandbox helper. Inside that helper, linux-sandbox/src/bwrap.rs creates the filesystem rules, linux-sandbox/src/landlock.rs applies lower-level kernel restrictions, and linux-sandbox/src/bundled_bwrap.rs plus launcher.rs choose and start either a system or bundled bubblewrap binary.

The shell-escalation files add a separate Unix path for commands that may need higher privileges: a client wrapper intercepts exec requests, a server asks policy whether to allow or escalate them, and the Unix shell runtime helpers rewrite shell commands so all of this works cleanly in practice.

#### [Exec-server filesystem sandbox services](stage-14.2.5.md) `stage-14.2.5` — 6 files

This stage is the exec-server’s file access layer. It sits in the main work path, between higher-level requests and the real storage underneath. Its job is to make file operations safe and flexible: the server can read or change files on the local machine, send those requests to another exec-server, or run them inside a locked-down sandbox.

local_file_system.rs is the normal backend. It knows how to open files, read and write them, inspect metadata, walk directories, delete, copy, and resolve paths. It can do this directly or hand work to a sandboxed version when needed. sandboxed_file_system.rs is that sandboxed version. It checks that a request is suitable for sandboxing and then sends it to a helper instead of touching the disk itself.

fs_helper.rs defines the small JSON-based message format used to talk to that helper process, and also includes an in-process version for direct execution. fs_sandbox.rs launches the helper in a restricted subprocess, gives it only the needed permissions, and turns its replies back into normal results. file_read.rs manages open read handles for each client connection and serves bounded block reads. remote_file_system.rs provides the same filesystem interface, but forwards operations over RPC to another server.

#### [Windows sandbox provisioning and process-launch internals](stage-14.2.6.md) `stage-14.2.6` — 27 files

This stage is the Windows-only machinery that prepares a safe “guest identity” and then starts commands inside it. It sits between setup and the main work loop: first it provisions the sandbox account and permissions, then it launches the actual process and carries its input and output back.

At the top, lib.rs is the public front door, and unified_exec chooses between two ways to run: an elevated path, which talks to a helper runner over IPC (inter-process communication, a way for programs to exchange messages), and a legacy path, which starts the process directly with a restricted token. setup.rs, identity.rs, spawn_prep.rs, token.rs, acl.rs, deny_read_acl.rs, audit.rs, hide_users.rs, firewall.rs, and WFP filter specs build the sandbox’s security rules: who the sandbox “user” is, what files it may read or write, and what network access is blocked.

Once that groundwork is ready, process.rs, desktop.rs, proc_thread_attr.rs, conpty, and stdio_bridge.rs do the launch itself, including interactive terminal support and standard input/output wiring. setup_error.rs and the TUI helper explain failures and let higher layers diagnose or trigger setup.

### [Extension and integration tools](stage-14.3.md) `stage-14.3` — 117 files

This stage is the system’s “extra abilities” layer. It runs during normal work, after startup has loaded settings and available add-ons. Its job is to make outside tools, connectors, and special namespaces usable in a live session, so the model can search the web, use memories or skills, call connected apps, or offer installation and discovery flows.

One part keeps MCP connections alive. MCP is a standard way to talk to outside tool servers. It turns saved connector settings into live sessions, lists the tools and resources those servers offer, runs calls, handles sign-in or approval prompts, and returns clean results.

Another part manages the plugin and connector ecosystem itself. It finds add-ons from disk, marketplaces, or remote servers, checks what is allowed, installs or removes them, keeps caches up to date, and exposes discovery and install-request features to users.

A third part is the runtime “switchboard” for extension-backed tools. It decides which tools appear each turn, makes different tool types look consistent, and routes calls for web search, image generation, goals, memories, skills, and sandboxed code execution.

Finally, app-server discovery code turns raw integration records into searchable, user-friendly app and file search results, with caching and background refreshes.

#### [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files

This stage is the live “plug-in and connector” layer of the system. It sits in the main work loop, after setup has produced configuration, and keeps outside MCP servers connected and usable during a session. MCP, or Model Context Protocol, is the common language used to talk to external tools and resources.

At the front, extension wiring code in app-server and ext/mcp registers MCP-powered features, including servers declared by executor plugins. The provider reads those plugin declarations and ignores unsupported connection types. Inside codex-mcp, the public library ties together server definitions, config snapshots, tool shaping, Apps-specific caching, and auth-elicitation parsing when a connector needs the user to sign in.

The connection manager is the hub. It turns server config into live clients, keeps the current session’s connections, gathers available tools and resources, runs calls, and refreshes caches. The resource client gives the rest of the app a stable handle even when that manager is replaced.

On the core side, session code refreshes MCP state and routes approval or login prompts. Tool exposure rules decide what the model sees directly. MCP tool-call and resource handlers then execute requests, rewrite file inputs when needed, record telemetry, and return clean results.

#### [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files

This stage is the system’s “app store and adapter workshop.” It is shared support that powers plugin and connector setup before and during normal use. Its job is to find available add-ons, decide which ones are allowed, install or remove them, and make them usable by the rest of the system.

At the center, core-plugins exposes the public API, while manifest, marketplace, provider, and loader read plugin files, interpret marketplace catalogs, and turn raw folders or archives into trusted, typed plugin records. Manager coordinates the bigger workflows: loading, caching, listing, install and uninstall, plus refreshes. The marketplace_add, marketplace_upgrade, and marketplace_remove pieces manage where marketplaces come from, how git-based ones are updated, and how old ones are cleaned out.

Remote support handles plugins that live on a server instead of only on disk. remote, remote_legacy, remote_bundle, remote_installed_plugin_sync, and share/checkout fetch catalogs, download bundles, keep local cache in sync, and let users publish or check out shared plugins.

Connector discovery and policy are handled by connectors, app_tool_policy, app_mcp_routing, and helper utilities. Finally, discoverable, mentions, and the install-request tools feed suggestion flows, while the CLI and TUI present all of this to users.

#### [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files

This stage is the “tool workshop” of the system. It sits behind the scenes during each turn and decides which extra abilities are available, how they are described to the model, and how a tool call actually reaches the right code. The main planner builds the per-turn tool menu, while companion spec files describe tools like planning, starting a fresh context, checking remaining context space, viewing images, searching tools, and running code.

Several adapters then make different kinds of tools look uniform. Dynamic-tool files turn temporary, session-defined tools into normal callable tools. Extension-tool code does the same for plug-ins installed through the extension registry. Tool-search code builds a searchable index so hidden or deferred tools can still be discovered.

Other parts provide concrete namespaces. Web search, image generation, goals, memories, and skills each register their own tools and runtime behavior. The code-mode pieces create a restricted JavaScript sandbox, expose helper callbacks, and connect code execution back into the normal tool system. Together, these parts act like a switchboard: they expose the right tools, route calls correctly, and translate results back into a standard format.

#### [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files

This stage is part of the app server’s main work: it turns raw integration data into client-friendly discovery and search features. You can think of it as the layer that gathers scattered facts, tidies them up, and presents them in a form the UI can use.

On the app-discovery side, connectors/src/accessible.rs builds the list of integrations a user can actually use. It reads many connector-tool records, removes duplicates, fills in missing pieces from partial records, collects plugin names to show, and works out install links. connectors/src/filter.rs then applies the product rules: which connectors should be hidden, and which ones are discoverable but not yet available, so they can be suggested. connectors/src/merge.rs combines that accessible list with directory data and plugin findings into one sorted app list, even creating placeholder entries when only plugin data exists.

app-server/src/request_processors/apps_processor.rs exposes all of this through the apps/list request. It can answer quickly from cached data, then refresh in the background and send updates as better information arrives. app-server/src/fuzzy_file_search.rs does the same kind of adaptation for file search, managing interactive search sessions, limits, cancellation, and clean client updates.

### [Sandbox policy generation and command-safety parsing helpers](stage-14.4.md) `stage-14.4` — 17 files

This stage is shared support for deciding whether a tool command can run freely, needs approval, or must be tightly boxed in. Think of it as the system’s safety desk: it reads the rules, turns them into concrete restrictions, and inspects commands before they run.

The legacy policy files are modeled by arg_matcher.rs and opt.rs, which describe allowed command options and argument patterns. arg_type.rs then checks real argument text against those meanings, and sed_command.rs adds a special extra check for only a very small safe subset of sed editing commands.

On the sandbox side, policy_transforms.rs merges base permissions with extra user or tool requests into one final sandbox policy. seatbelt.rs converts that policy into the exact macOS sandbox program and launch arguments, while linux-sandbox/build.rs makes sure Linux sandbox builds are refreshed when the bundled bubblewrap version changes.

For command inspection, bash.rs and powershell.rs peel apart shell wrappers and normalize commands. parse_command.rs turns raw command lines into simple summaries. command_canonicalization.rs creates stable keys for approval caching. The command_safety modules then judge commands: is_safe_command.rs and windows_safe_commands.rs allow clearly read-only commands, while is_dangerous_command.rs and windows_dangerous_commands.rs catch risky ones, with powershell_parser.rs providing structured PowerShell parsing behind the scenes.

## [Multi-agent, collaboration, and background workflows](stage-15.md) `stage-15` — 39 files

This stage is the system’s “extra workers and background jobs” layer. It sits on top of the main session loop and is used when one conversation needs help from other agent threads, or when work should continue in the background instead of blocking the current turn.

The core agent modules are the control room. They define roles, keep a live registry of active agents, resolve names or paths into real thread IDs, and enforce limits on how many child agents can run or stay loaded in memory at once. The spawn and control code creates new agent threads, reloads old ones, routes messages between them, and tracks parent-child relationships. Session-prefix and completion-message code turns those internal events into clear model-visible messages.

On top of that, the multi-agent tool handlers are the public buttons: spawn, send input or messages, wait, resume, interrupt, list, and close agents. Shared helpers keep validation and output consistent across both older and newer tool versions.

The rest are special workflows built from the same machinery: delegated child Codex sessions, review-mode agents, CSV-driven worker jobs, memory-extraction pipelines, and the skills watcher that notices file changes and alerts the server.

## [Result persistence, projection, and user-visible state updates](stage-16.md) `stage-16` — 55 files

This stage is the “make it real and show it” part that runs after a thread does work or moves forward. It saves what happened, updates the thread’s official state, and turns raw internal events into things users and other programs can actually consume.

At the core, rollout and state files decide what gets recorded and extract metadata like thread name, status, and settings. Archive, unarchive, update, resume, summary, and import code keep stored threads usable over time, including bringing in sessions from outside systems and trimming oversized resume data for certain clients.

Another group of files translates low-level event messages into higher-level notifications, thread history, status changes, review text, token-usage updates, and machine-readable exec output. Tool, shell-command, diff, lifecycle, and agent-status code turn concrete actions into user-visible records.

Finally, the TUI files refresh what a person sees: transcript history, tool activity, status lines, goal and rate-limit indicators, branch summaries, pending input previews, and `/status` or `/agent` views. Together, these parts act like the system’s bookkeeping clerk, translator, and dashboard updater all at once.

## [Shutdown, cleanup, and teardown](stage-17.md) `stage-17` — 4 files

This stage is the system’s “packing up and turning off the lights” work. It runs when a connection, session, or whole process is ending. Its job is to stop new work from sneaking in, let safe-to-finish work complete, clean up leftovers, and save any important final state before things fully stop.

One part, the connection RPC gate, acts like a closing door for each connection. RPC means a request sent to the server asking it to do something. During shutdown, this gate refuses new fully started requests, but lets requests that already began finish cleanly.

The connection cleanup manager is the janitor for each connection. It starts cleanup tasks, watches them finish one by one or all together, and can cancel any that are still hanging around if shutdown must move on.

The legacy agent control code closes older background agent threads. It also shuts down child threads they created and records the final “who spawned whom” state so the saved thread tree stays correct.

Finally, the app-server daemon update loop handles a special case: the updater process can replace the daemon binary and restart it safely when a newer managed version is detected.

## [Protocol schemas, shared types, and generated contracts](stage-18.md) `stage-18` · (cross-cutting) — 174 files

This stage is the system’s shared rulebook. It sits behind the scenes and supports every part of the lifecycle: startup, normal work, storage, networking, tools, and shutdown. Its job is to make sure all parts of the codebase describe data the same way, so messages sent over the wire, saved to disk, or passed between processes all match.

One part defines the core shared types: the common names and shapes for things like sessions, threads, tools, permissions, plugins, and errors. Another part defines the app-server protocol: the exact request, response, and notification formats, plus the JSON-RPC envelope, which is the standard wrapper around messages. It also keeps older client versions working and can export machine-readable schemas.

A third part provides generated contracts from backend API descriptions and protobuf, a compact binary message format, so code can use typed fields instead of raw payloads. Another covers edge-facing schemas for the public API, code mode, hooks, extensions, MCP, exec messages, and trace records. Finally, compile-time macros automatically tag experimental fields and register them, so the system can enforce feature rules consistently.

### [Core shared protocol and domain types](stage-18.1.md) `stage-18.1` — 46 files

This stage is the system’s shared vocabulary. It sits behind the scenes and gives the rest of the codebase a common set of names, shapes, and rules for data. Think of it like agreed forms and labels used by many departments, so everyone means the same thing when they talk about a session, a thread, a tool, a plugin, a permission, or an error.

The main protocol crate does most of this work. It defines core IDs like SessionId and ThreadId, trusted path and tool-name values, the big session and event message formats, user input, turn items, approvals, account and auth details, model and config settings, dynamic tool descriptions, memory citations, network-policy reports, shell output decoding, and the central error and sandbox-permission rules. Its crate root gathers these pieces into one import point.

Around that are other shared contract crates. Plugin files define plugin IDs and manifests. Tools files describe tool metadata and discoverable tools. Config, state, thread-store, cloud-tasks, skills, exec-policy, network-proxy, TUI, and core files each contribute small but important shared types. Together, they let startup, runtime, storage, and UI all exchange data safely and consistently.

### [App-server protocol schemas and transport contracts](stage-18.2.md) `stage-18.2` — 43 files

This stage defines the “language” the app server speaks and the packaging used to send it. It is shared behind-the-scenes support: not the main work itself, but the contract that lets clients, servers, and tools agree on what every message means.

At the base, jsonrpc_lite.rs describes the JSON-RPC message envelope, the standard request/response wrapper used on the wire. common.rs and protocol/mod.rs gather the shared request, response, and notification types, while serde_helpers.rs handles small formatting quirks. v1.rs preserves the older protocol, and mappers.rs translates older command shapes into the newer v2 form so old clients still work.

Most files here define v2 message shapes for specific features: threads and turns, items, reviews, accounts, models, apps, permissions, config, plugins, hooks, feedback, filesystem and process access, remote control, realtime audio, MCP connections, and more. shared.rs and related adapters convert internal Rust types into the exact client-facing spellings and enum values.

experimental_api.rs and export.rs power schema export, generating TypeScript and JSON Schema descriptions and filtering out experimental pieces from stable output. The transport files define outgoing server messages and remote-control wire details, while error_code.rs standardizes protocol error replies.

### [Generated backend and protobuf contracts](stage-18.3.md) `stage-18.3` — 24 files

This stage is the system’s shared translation layer. It sits behind the scenes, between handwritten Rust code and data that arrives over the network. Its job is to give the rest of the codebase stable, typed shapes for backend API replies and protobuf messages, so other parts can work with real fields instead of raw JSON or binary blobs.

Most of the files in codex-backend-openapi-models are generated from the backend’s OpenAPI schema, which is a machine-readable description of the HTTP API. The crate root and models/mod.rs gather those generated types into one place. The individual model files describe concrete payloads such as rate-limit and credit status, spend controls, tasks, pull requests, and delivered config files.

backend-client/src/types.rs adds the practical glue. It compensates for backend responses that are not always shaped consistently, then offers cleaner helpers for things like account checks, task details, messages, diffs, and errors.

The protobuf side does the same for binary protocols. The thread-config file provides generated gRPC bindings for loading thread settings remotely. The exec-server relay files define and lightly wrap the relay message format used for handshakes, heartbeats, acknowledgements, and reconnect control.

### [API, extension, hook, MCP, and trace schemas](stage-18.4.md) `stage-18.4` — 60 files

This stage is shared support code that sits around the edges of the system. It is not the main loop that answers a request. Instead, it defines the agreed data shapes for several important borders: the public API, code execution mode, extensions and hooks, MCP connections, low-level exec messages, and rollout traces. You can think of it as the system’s rulebook and set of official forms.

The code-mode contract types define how code-running requests, results, tool calls, and sessions are described so runtimes and callers stay in sync. The public API schemas do the same at the outside boundary, covering requests, responses, streaming events, websocket messages, and errors.

The extension and hook contracts tell plugins what the host can offer, what events they can observe, and what inputs and outputs a hook must use. The tool and protocol schemas define the exact message formats for tools, permissions, planning, and related protocol features.

The MCP, exec, and sandbox wire models describe the raw messages used between processes. Finally, the rollout trace models record what happened during a run in a compact, linked way. Together, these pieces let many separate parts communicate clearly and consistently.

#### [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files

This stage defines the “contract” for code mode: the shared shapes and names that every other part of the system agrees to use. It is behind-the-scenes support rather than startup or shutdown work. Think of it like the official forms, labels, and rules that let different components talk without confusion.

The crate root in lib.rs gathers everything into one public package and publishes the standard tool names, so callers and runtimes refer to the same tools in the same way.

description.rs explains what those tools are. It builds rich descriptions for tools like exec and wait, including nested tools, and can turn a JSON schema— a structured description of data fields—into TypeScript types for developer-facing use. It also reads an optional first-line // @exec: note from JavaScript source to pick up execution hints.

runtime.rs defines the actual request and response payloads for running code and waiting for results, including pending states and nested tool calls. response.rs defines the content pieces those messages can carry, such as text or images. session.rs defines the longer-lived relationship around execution: cell IDs, started cells, and the traits—interfaces that describe required methods—for sessions, providers, and host callbacks.

#### [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files

This stage defines the public “shapes” of the Codex API: the exact fields that requests, responses, streamed events, and errors use when data crosses the system boundary. It sits at the edge of the system, between your code and the outside world, during the main work of sending requests and receiving results.

The crate root in codex-api/src/lib.rs is the front desk. It gathers the important types from the internal modules and exposes them as the supported public API. codex-api/src/common.rs provides the shared building blocks used by many endpoints, such as standard request and response bodies, text controls, websocket messages, and streaming event records. codex-api/src/error.rs gives the whole crate one common error type, so network failures, protocol mismatches, rate limits, and other problems are reported in a consistent way.

The remaining files cover specific API areas. images.rs defines the payloads for generating and editing images. search.rs defines the richer request and response format for search tasks across different domains. endpoint/realtime_websocket/protocol.rs defines the message format for live websocket conversations and routes incoming events to the right parser version. Together, these files act like a shared dictionary so every transport speaks the same language.

#### [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files

This stage defines the “rules of the road” for extensions and hooks. It is shared support, not the main work loop itself. Its job is to give plugin authors a stable set of promises about what the host can provide, what events they can observe, and what data shapes travel across the boundary.

The extension API is the main front door. `lib.rs` and `capabilities/mod.rs` gather the public pieces. The capability files describe optional powers the host may hand to an extension: spawning helper agents, sending events outward, or adding extra response items into the current reply. Each also includes a safe fallback when the host does not support that power.

The contributor files define the callback contracts for different moments in runtime life: thread, turn, and tool execution, plus MCP server configuration and user instructions. `contributors.rs` ties these callbacks together and gives default “do nothing” behavior. `state.rs` provides typed storage so hosts and extensions can attach extra data safely.

The hooks side defines declared hook names, event payload types, execution result types, and JSON schemas—the machine-readable descriptions of inputs and outputs. Together these files keep hook behavior consistent, versionable, and understandable across processes.

#### [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files

This stage defines the “contracts” for tools: the exact shapes of the messages, settings, and results that different parts of the system agree to exchange. It is shared behind-the-scenes support, not the main work loop itself. Think of it like the forms, labels, and field rules that let many departments pass work back and forth without confusion.

Several files define common tool payloads and call context. `tool_payload.rs` says what kinds of tool inputs exist. `tool_call.rs` adds the extra information a tool run needs, like conversation history and places to send visible output. `function_tool.rs` exposes a shared error type. `context.rs` and `response_adapter.rs` translate tool results into the protocol formats the rest of the system expects.

Other files define the model-visible tool specs: `tool_spec.rs` turns internal tool definitions into the JSON format used by the API, while the built-in spec files describe exact inputs and outputs for context checks, user questions, shell actions, and goals. Protocol files do the same for planning, permissions, user input, and MCP approval metadata. Supporting schema builders for skills, web search, and MCP tool config make sure every integration speaks the same precise language.

#### [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files

This stage is shared behind-the-scenes support. It defines the “wire models”: the exact message shapes different parts of the system use when they talk to each other. Think of it as agreeing on envelopes, forms, and labels before any real work begins.

The exec-server files cover the main remote-control channel. client_api.rs describes how a client connects, what transport it uses, what features it supports, and the common HTTP client interface. process_id.rs gives each logical process a special ID type, so process names are not mixed up with ordinary text. protocol.rs defines the actual JSON-RPC messages, meaning the request-and-response format used for commands like starting processes, accessing files, checking the environment, or making HTTP requests through the executor.

exec_events.rs defines the event stream produced by codex exec as JSONL, which is one JSON record per line. This is the live activity feed for status updates and outputs.

The last two files define operating-system-specific control messages. escalate_protocol.rs covers Unix shell escalation requests, while ipc_framed.rs defines framed, length-prefixed JSON messages for the elevated Windows sandbox runner. Together, these files let many moving parts speak the same language reliably.

#### [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files

This stage is shared support code that sits behind the main work of the system. It does not run the conversation itself. Instead, it defines the common data shapes other parts of the code use to describe what happened during a rollout, which is a recorded run of the system.

The session model in rollout-trace/src/model/session.rs gives the top-level picture. It describes a session, the threads inside it, when work started and stopped, and which Codex turns were active. Think of it as the table of contents for a run.

The runtime model in rollout-trace/src/model/runtime.rs fills in the action details. It records code execution, tool calls, terminal activity, compaction, and links between threads. In other words, it explains how outputs and side effects were produced.

The payload reference code in rollout-trace/src/payload.rs keeps the trace lightweight. Instead of storing large request, response, or runtime blobs directly inside the main trace, it stores small IDs and pointers to files saved alongside it.

Together, these files give the system a compact but connected record of both the conversation structure and the runtime work behind it.

### [API annotation macros and compile-time contract support](stage-18.5.md) `stage-18.5` — 1 files

This stage is quiet, behind-the-scenes support. It does not do the program’s main work at runtime. Instead, it helps shape the code while the project is being built, so different parts of the system follow the same rules about experimental features.

Its main piece is a procedural macro, which is a code generator that runs during compilation. In `codex-experimental-api-macros/src/lib.rs`, the `#[derive(ExperimentalApi)]` macro looks at a data type such as a struct or enum and creates extra code automatically. That generated code does two jobs. First, it adds runtime checks, so the program can notice when an experimental field or enum choice is being used and apply the project’s rules. Second, it adds inventory registrations, meaning it records those experimental parts in a shared catalog the rest of the system can inspect.

A good way to think of it is like attaching labels and check-in cards to new items before they enter a warehouse. Later systems can enforce rules consistently because this stage already marked and registered everything in a standard way.

## [Cross-cutting transport, networking, and client infrastructure](stage-19.md) `stage-19` · (cross-cutting) — 55 files

This stage is the project’s shared networking toolbox. It does not represent one moment like startup or shutdown. Instead, it supports many parts of the system whenever they need to talk to web services, local helper programs, or remote servers.

One part provides the basic HTTP pieces: building requests and responses, handling secure HTTPS certificates, keeping only safe cookies, retrying temporary failures, and reading streamed updates. On top of that, it offers ready-made clients for specific services such as backend APIs, ChatGPT-style services, and cloud task systems.

Another part moves data between the app server, exec server, and relay connections. It makes direct and forwarded HTTP look the same, supports large messages by splitting and rejoining them, streams files and response bodies piece by piece, and secures relay traffic with encryption and message framing.

A third part manages proxying and local IPC, meaning private communication between programs on one machine. It enforces proxy rules, supports trusted interception when allowed, and provides local socket and pipe connections across platforms.

The MCP transport adapters then sit on top, letting one client API talk through in-process, child-process, direct HTTP, or forwarded HTTP paths. The top-level client files simply expose these capabilities cleanly, while codex-client errors give callers clear failure types.

### [Generic HTTP client, TLS, cookies, and streaming transport foundations](stage-19.1.md) `stage-19.1` — 21 files

This stage is the shared outbound networking toolkit: the plumbing that lets the rest of the system talk safely and reliably to web services. It sits behind the scenes, not in startup or shutdown, and gives higher-level features a common way to make HTTP requests, retry failures, trust custom certificates, and read streamed events.

At the core, request.rs defines a neutral “request” and “response” shape, including reusable JSON bodies and optional zstd compression, which means shrinking data before sending it. transport.rs turns those requests into real network calls with reqwest, including normal one-shot replies and streaming replies. retry.rs decides when to try again and how long to wait, using increasing delays with a little randomness to avoid stampedes. sse.rs reads Server-Sent Events, a simple text stream of updates, from raw bytes.

custom_ca.rs manages custom certificate authorities, so private or company-issued HTTPS certificates can be trusted. chatgpt_cloudflare_cookies.rs keeps only a narrow set of Cloudflare cookies, avoiding unsafe sharing of user session cookies. default_client.rs and login/auth/default_client.rs build standard clients with tracing, logs, headers, cookies, and certificate settings.

The rest are ready-made clients built on this foundation: backend-client, chatgpt, cloud-tasks-client, remote thread config, LM Studio, Codex API sessions and endpoints, realtime parsing helpers, and file upload support. Together, they act like a shared delivery service with clear labels, safe routes, and retry rules.

### [App-server, exec-server, and relay transport channels](stage-19.2.md) `stage-19.2` — 10 files

This stage is shared plumbing. It sits behind the scenes and gives different parts of the system reliable ways to move data around, whether that data is a small message, a long HTTP response, a file, or an encrypted relay packet.

At the center, app-server-transport/src/transport/mod.rs defines the common rules for app-server connections: how to choose a transport, describe connection events, pass incoming messages onward, slow down under overload, and turn outgoing data into bytes. For remote control over websockets, remote_control/segment.rs cuts large messages into chunks and joins them back together, while remote_control/clients.rs talks to the backend to list or revoke enrolled clients.

On the exec-server side, client/http_client.rs provides one face for HTTP requests, whether they are made directly or forwarded remotely. http_response_body_stream.rs then makes streamed response bodies look the same in both cases. remote_file_stream.rs does the same for remote files, reading them piece by piece and closing them when done.

For secure relaying, noise_channel.rs sets up an authenticated encrypted channel, ordered_ciphertext.rs fixes small out-of-order packet arrival, message_framing.rs preserves message boundaries, and relay.rs carries everything over websockets.

### [Managed proxying and local IPC transport substrates](stage-19.3.md) `stage-19.3` — 12 files

This stage is shared plumbing for talking safely to the outside world and to other programs on the same machine. It sits behind the scenes, supporting the main work of the system. One part decides what proxy rules really apply after mixing user choices with company or policy restrictions, then starts or updates the live proxy process. The proxy can inspect web traffic when needed: it manages its own trusted certificate setup, unwraps encrypted HTTPS traffic, applies host-specific header rewrite hooks, checks whether outgoing connections are allowed, forwards approved traffic directly or through another upstream proxy, and produces clear blocked messages when a request is denied.

The other part is about local IPC, meaning inter-process communication: private channels between programs on one computer. A cross-platform Unix-socket layer gives one simple API on Unix and Windows. The shell-escalation socket code can send JSON messages plus file handles, which is useful when a higher-privilege helper is involved. Sandbox proxy routing builds bridges so isolated Linux programs can still reach the managed proxy safely. Finally, the IDE IPC code uses Windows named pipes or platform-specific local channels to fetch context from an IDE, with timeouts and identity checks for safety.

### [MCP and executor-backed transport adapters](stage-19.4.md) `stage-19.4` — 8 files

This stage is the bridge between the MCP client’s high-level “talk to a server” logic and the real ways that talking can happen underneath. It is part of the system’s main work, but mostly as behind-the-scenes plumbing.

At the top, rmcp-client/src/lib.rs is the front door. It gathers the public client API and the helper pieces so other code can use MCP without knowing the internal layout.

The transport files provide different roads to the same destination. in_process_transport.rs defines how to create a connection to a server that lives inside the same program. executor_process_transport.rs does the same for a server started as a child process, sending and receiving JSON-RPC messages over standard input and output, line by line, while keeping error output separate.

For HTTP-based MCP, http_client_adapter.rs converts the project’s shared HTTP capability into the streamable HTTP form MCP expects, including server-sent events (a way to receive updates as a stream). It relies on reqwest_http_client.rs for real network calls and rpc_http_client.rs when HTTP must be forwarded through the exec-server connection. www_authenticate.rs reads auth challenge headers, and streamable_http_retry.rs retries startup and temporary failures so connections are more resilient.

## [Cross-cutting observability, analytics, and feedback](stage-20.md) `stage-20` · (cross-cutting) — 81 files

This stage is the system’s shared “watch and remember” layer. It is not one step in the app’s life. Instead, it runs across startup, normal request handling, streaming responses, tool runs, and shutdown. Its job is to leave a clear, privacy-aware trail of what happened, how well it worked, and what evidence is worth saving for later.

One part turns raw observations into analytics events and sends them out. Another sets up observability tools: traces, which follow one request across steps, plus metrics and structured logs. Session and feature instrumentation adds the actual measurements, such as timing a turn, tagging tool calls, or recording safe summaries of auth and storage behavior.

The rollout trace system is a flight recorder. It writes a raw timeline to disk, then can replay it later into a cleaner picture of conversations, threads, model calls, and tool activity. Feedback and debug capture gather logs, safe diagnostics, and redacted request or response details into bundles for investigation. Finally, log persistence stores runtime logs in SQLite for later review, while the Windows sandbox logging file keeps simple rolling daily logs for sandbox command activity.

### [Analytics event modeling, reduction, and emitters](stage-20.1.md) `stage-20.1` — 8 files

This stage is the app’s analytics engine: the behind-the-scenes part that watches what happens, turns those observations into clean event records, and sends them out. It sits alongside the main work of the system, quietly collecting a reliable story of usage, errors, and outcomes.

The flow starts with facts.rs, which defines the raw “things we noticed” in memory, such as a turn starting or ending, a plugin being used, or an error being rejected for a known reason. events.rs defines the final event shapes that are safe to send over the wire, plus helpers to convert facts into those payloads. accepted_lines.rs is a specialist: it reads code diffs, counts which added lines were accepted, and creates privacy-preserving fingerprints instead of sending raw file paths or Git remote URLs.

The reducer in reducer.rs is the heart of the system. It combines scattered observations over time into complete events. client.rs is the front door used by the rest of the codebase: it queues facts in the background, avoids duplicate events, and delivers batches over HTTP or to a debug file. lib.rs ties these pieces together, while the small adapters in app-server and goal code make it easy to initialize analytics and emit goal-specific events.

### [OpenTelemetry runtime, provider, and metrics foundations](stage-20.2.md) `stage-20.2` — 22 files

This stage is the system’s shared “observability” toolkit: the behind-the-scenes parts that let the app report what it is doing through traces, metrics, and logs. It mostly matters during startup, when telemetry is configured and installed, and then keeps supporting the main work loop as the app runs.

The flow starts with configuration. core/src/config/otel.rs reads user TOML settings and cleans them up, turning bad tracing details into warnings instead of blocking startup. core/src/otel_init.rs and otel/src/config.rs translate those settings into concrete exporter choices. otel/src/provider.rs then builds the actual providers, installs them globally, and shuts them down cleanly later. otel/src/otlp.rs supplies the network plumbing used to send telemetry out.

The metrics files form a small subsystem: config, validation, errors, standard names, standard tags, the recording client, an auto-stopping timer, one-time process-start tracking, and runtime snapshot summaries. otel/src/metrics/mod.rs ties that together.

Trace context support in otel/src/trace_context.rs keeps request identity flowing across boundaries. events/shared.rs standardizes session event output. targets.rs decides what becomes a log versus a trace. otel/src/lib.rs exposes the whole package to the rest of the codebase, while the client and API telemetry files define callback hooks so transport code can report each request attempt.

### [Session telemetry and feature-specific instrumentation](stage-20.3.md) `stage-20.3` — 16 files

This stage is the system’s shared “instrument panel.” It does not do the main user work itself. Instead, it watches what happens during a session and reports useful signals about speed, outcomes, and operating conditions.

At the center is session_telemetry, the common entry point other parts use to record logs, traces, and metrics. It makes sure every report carries the same session details, such as which conversation or model it belongs to. turn_timing adds a stopwatch for each turn, breaking time into steps like waiting, tool work, and first response. app_server_tracing does the same kind of tracking for incoming app-server requests.

Several files add focused measurements for specific product areas. auth_env_telemetry records a privacy-safe summary of authentication setup. sandbox_tags turns permission settings into short tags. tool_dispatch_trace reports tool calls and results. guardian, cloud-config, goals, and memories each define the names and tags for their own metrics so reports stay consistent. memory_usage and memories/read usage classify safe memory-file reads from shell-like commands. Finally, sqlite_metrics and state telemetry record how SQLite starts up and whether it had to fall back, using stable tags that are safe to count and compare.

### [Rollout trace recording, schema, and replay reducers](stage-20.4.md) `stage-20.4` — 24 files

This stage is the system’s “flight recorder” and replay engine. While the app is doing its main work, it saves a raw, step-by-step trace of what happened. Later, it can replay that trace into a cleaner story of the conversation, threads, tool calls, code execution, and runtime state.

At the bottom, bundle.rs, raw_event.rs, and writer.rs define the package on disk: which files exist, how events are stored, and how payload data must be written before events that refer to it. lib.rs is the front door that exposes these pieces. config.rs gives rollout code a stable way to read settings.

Several files record specific kinds of activity: thread.rs tracks sessions and child threads, inference.rs records model requests and responses, compaction.rs records history replacement, code_cell.rs tracks one code execution cell, tool_dispatch.rs records tool calls, mcp.rs tags backend calls, and protocol_event.rs converts larger protocol messages into this trace format.

Then the reducer files turn raw logs into useful models. model/*.rs defines the final in-memory shapes. reducer/mod.rs coordinates replay, while the conversation, thread, inference, compaction, code_cell, and tool reducers each rebuild one part of the picture and link them together.

### [Feedback capture, debug artifacts, and log persistence](stage-20.5.md) `stage-20.5` — 10 files

This stage is the system’s “black box recorder.” It runs behind the scenes during normal work and when something goes wrong, so people can later inspect what happened without exposing private data.

The feedback code is the main collector. It gathers logs, request tags, auth-related tags, and optional attachments in memory, then bundles them into a feedback upload for Sentry, a service for error and feedback reports. Two helpers add extra clues: one records simple network setup details such as proxy environment settings, and another tries to attach a redacted “doctor” report, which is a health check snapshot of the local setup. If those diagnostics fail, feedback still goes through.

Several files focus on safe debugging. The response debug context pulls useful IDs and error facts from HTTP responses while avoiding leaking full response bodies. The secrets sanitizer removes obvious API keys, bearer tokens, and similar sensitive text before anything is logged or shown.

The rest stores raw evidence locally. Request/response dumps save redacted API traffic to disk. Analytics capture and TUI session logging write debug JSONL files when enabled. Finally, the log database layer and runtime log storage persist tracing events into SQLite, prune old entries, and make saved logs available for later feedback or inspection.

## [Cross-cutting persistence abstractions and data stores](stage-21.md) `stage-21` · (cross-cutting) — 54 files

This stage is the system’s shared storage layer: the shelves, filing cabinets, and indexes that many other parts use while the app is running. It is not just startup or shutdown code. Instead, it keeps important information safe, findable, and reusable across the whole life of the app.

One part stores conversations. Rollout files keep the raw transcript, while the thread store sits on top as a common front desk for writing, reopening, listing, searching, and deleting threads. Another part uses SQLite, a database stored in one local file, to remember runtime facts such as thread relationships, goals, jobs, memories, repair progress, and import history. The agent graph store gives a simpler view of thread spawn links by building on that same database.

Several small caches save downloaded lookup data like cloud settings, plugin catalogs, connector directories, model lists, shared plugin paths, and update UI state so the app can avoid repeated network work. Other stores manage local plugin files, encrypted secrets, and memory workspaces. Finally, external session import persistence remembers which outside session files were already seen and translates them into the system’s own message format.

### [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files

This stage is the system’s filing cabinet for conversations. It is shared support used while the app is running and later when it needs to reopen, browse, search, or remove old threads. The main idea is simple: save each conversation to disk, keep enough index information to find it again, and offer one common interface no matter how the storage works.

The rollout files are the raw transcript logs. rollout/src/recorder.rs writes them and can replay them later. compression.rs lets old logs be quietly compressed to save space without changing how other code reads them. list.rs and search.rs are the browsing tools: one finds threads and summaries, the other finds text inside them. session_index.rs keeps a lightweight name lookup, and message-history/src/lib.rs stores the global append-only history file safely.

The thread-store crate sits above that as the “front desk.” store.rs defines the contract for any backend, error.rs gives shared failure types, and in_memory.rs provides a simple test version. local/mod.rs ties the real local-disk version together, with live_writer, read_thread, list_threads, search_threads, delete_thread, and helpers each handling one part of writing, reconstructing, listing, searching, and deleting threads. core/src/rollout.rs and rollout/src/lib.rs expose these pieces in a usable package.

### [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files

This stage is the system’s long-term memory. It is shared behind the scenes, not part of one startup or shutdown moment. Its job is to save important runtime facts in a SQLite database, a single-file database the app can read and write as it works.

The main entry point is state/src/lib.rs, which exposes this storage system to the rest of the code. Several model files define the shapes of stored data so raw database rows become safe, typed records: thread metadata, goals, jobs, backfill state, and logs. The runtime files are the workers that actually read and update those tables. Threads stores per-thread details and parent/child spawn links. Goals tracks each thread’s objective, status changes, and budget use. Memories manages a two-step memory pipeline, from per-thread extraction to one shared consolidation job. Agent jobs stores batches of work and progress for each item. Backfill tracks a one-off repair/catch-up worker. Remote control and external config imports save enrollment records and import history.

Audit offers read-only inspection of an existing database for diagnostics. The agent-graph-store crate adds a cleaner interface just for thread spawn relationships, with a local adapter that forwards those graph operations into the shared SQLite state runtime.

### [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files

This stage is shared behind-the-scenes support. It keeps small bits of downloaded or remembered information on disk so the rest of the system can start faster, avoid unnecessary network calls, and still have a local fallback when a server is temporarily unavailable.

Each file is a small specialist cache. cloud-config/src/cache.rs stores cloud configuration bundles in a signed cache. “Signed” here means it adds a secret-based check so the app can detect tampering. It also refuses data that is too old, broken, or belongs to a different signed-in user or account. connectors/src/directory_cache.rs saves connector directory results as JSON text files and throws them away if they are stale or malformed. core-plugins/src/remote/catalog_cache.rs does the same for the remote plugin catalog, but keeps entries separated by server endpoint and account so one user’s data is not reused for another. models-manager/src/cache.rs stores fetched model catalogs and checks both age and version before reuse. core-plugins/src/remote/share/local_paths.rs keeps a simple map from remote shared plugin IDs to local file paths, with a lock to prevent two parts of the same process from editing it at once. tui/src/updates_cache.rs remembers update-related UI state, such as dismissed popups.

### [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files

This stage is the system’s long-term storage room. It is shared support code, not the main work loop itself. Its job is to keep important things on disk in a safe, predictable layout: plugins, secrets, and memory files.

For plugins, core-plugins/src/store.rs manages the local plugin folders like a careful package shelf. It discovers what is already cached, installs new versions, chooses the right version to use, removes old ones, and updates files in ways that reduce the chance of ending up half-written or unsafe.

For secrets, secrets/src/lib.rs defines the public rules: what a secret name can look like, how secrets are scoped to the right place, and how the rest of the system talks to a chosen storage backend. secrets/src/local.rs provides the local backend, storing encrypted secret files under the app’s home directory, while windows-sandbox-rs/src/dpapi.rs uses a Windows built-in protection system to safely encrypt and decrypt secret material.

For memories, ext/memories/src/local.rs stores memory data under the right root folder. The memories/write files then build and maintain a writeable workspace: lib.rs defines the shared layout, storage.rs rebuilds summary files from database results, control.rs safely clears old workspace contents, and extensions/prune.rs removes expired extension files. Together, these pieces keep durable data organized, protected, and cleaned up.

### [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

This stage is shared support for bringing session history in from outside systems. Its job is to remember what has already been imported and to turn raw session files into a format the rest of the system can use. You can think of it as a combination of a logbook and a translator.

The ledger file is the logbook. It stores which external session file versions have already been seen, using the file’s real path and a content hash, which is a short fingerprint of the file’s contents. That lets the system quickly answer questions like “is this the same session file as before?” and “has anything changed since last time?” It also refreshes stored details so later import steps have up-to-date facts.

The records file is the translator. It reads JSONL files, which are text files made of one JSON record per line, and turns them into either quick summaries or full streams of messages ready to import. While doing that, it smooths out differences between source formats by standardizing message text, titles, times, and tool output blocks into a Codex-friendly shape.

## [Cross-cutting utility and support libraries](stage-22.md) `stage-22` · (cross-cutting) — 175 files

This stage is the project’s shared toolbox. It sits behind the scenes and supports almost every other part of the system during build time, startup, and the main work of running commands and showing results.

Several sub-stages provide the big building blocks. One keeps paths, files, environment variables, terminals, and sandboxes safe and consistent across Windows, macOS, Linux, and remote setups. Another handles text: cleaning it up, reading streamed text correctly, fitting it into terminal screens, and styling what the user sees. A third covers configuration, metadata, schemas, authentication, and network rules so different parts of the program agree on names, settings, hosts, and security checks. Others help run shells and Git commands, manage plugins, work with images, and supply small async tools such as readiness flags and cancellation helpers. Build scripts prepare platform-specific extras before the program is compiled.

The directly assigned files add small but important glue: shared utility functions, stable public entry points for CLI and plugin helpers, common error types for policy and Git code, fuzzy text matching for search-like filtering, and shared hook-event rules. Together, these pieces are like the standard screws, adapters, and gauges used all across a large machine.

### [Path, filesystem, environment, and sandbox support utilities](stage-22.1.md) `stage-22.1` — 31 files

This stage is shared support code. It sits behind the scenes and gives the rest of the system a safe, consistent way to talk about paths, files, environment variables, terminals, and sandboxes on different operating systems.

Several files define “trusted wrappers” around paths so code does not pass around loose strings. `PathUri`, `LegacyAppPathString`, `AbsolutePathBuf`, the low-level absolutizing code, and the app-server path wrapper turn raw path text into checked forms, convert between Windows and POSIX rules, and preserve exact spellings when needed. The path utility crates then normalize paths for comparison, resolve symlinks, replace files safely, detect WSL, and expose these helpers to other crates. Memory-related path helpers and the state timestamp reader build on that.

Another group deals with files and watching them. The filesystem abstraction describes what file access looks like locally or remotely, `regular_file.rs` only opens real disk files, and `file-watcher` sends clean change notifications to many listeners.

The rest shapes the runtime environment: locating binaries, building sanitized child-process environments, detecting terminal and color support, choosing clipboard methods, and handling platform-specific sandbox details for Linux, macOS, and Windows. Together, these pieces are like adapters and safety guards that let higher-level features run reliably everywhere.

### [Text, parsing, truncation, and rendering helpers](stage-22.2.md) `stage-22.2` — 57 files

This stage is shared support that helps the rest of the system turn raw text into something readable on screen or safe to store and pass around. It is not one step in startup or shutdown. It is a toolbox used all through the program, especially while the terminal interface is running.

One part cleans up and formats text. It shortens long strings, fills in simple templates, formats numbers and times, and makes display text consistent. Another part reads text that arrives in pieces, like a stream. It rebuilds full characters and lines, and it can notice hidden tags, mentions, tables, or citation markers mixed into the text.

Once the text is understood, the layout helpers make it fit the terminal. They measure visible width, wrap or trim lines, preserve colors and links, and support scrolling views. On top of that, the presentation helpers choose styles, colors, labels, menus, and small view models so different screens look consistent. Finally, the animation and progress helpers add spinners, shimmer effects, simple terminal media, and temporary progress lines when the terminal can handle them.

#### [Generic string, formatting, truncation, and templating utilities](stage-22.2.1.md) `stage-22.2.1` — 12 files

This stage is shared behind-the-scenes support for turning raw values into clear, safe text. It is not the app’s main work loop by itself. Instead, many other parts call it when they need to show numbers, times, commands, search details, or shortened content to a person or another system.

Several files focus on formatting. Number and duration helpers turn values into readable forms like grouped digits, short “1.2k” styles, or compact elapsed times. CLI helpers build stable display strings for environment settings without leaking secrets, and generate consistent “resume” command hints. The web search formatter turns different kinds of search actions into one short description.

Another group focuses on shrinking text safely. Truncation utilities cut long strings in the middle without breaking UTF-8, the text encoding used for Unicode characters. There are byte-based and rough token-based budgets, plus extra helpers for truncating function output and response history.

The rest are text cleanup tools: strict templates with {{name}} placeholders, ASCII-only JSON output using \uXXXX escapes, TUI text shaping, and small string utilities like safe slicing and UUID extraction. Together, these parts make text output consistent, compact, and dependable.

#### [Streaming, line framing, and hidden-markup parsers](stage-22.2.2.md) `stage-22.2.2` — 9 files

This stage is shared behind-the-scenes support for reading text that arrives a little at a time, like messages coming through a narrow pipe. Its job is to turn broken-up bytes or text chunks into clean pieces the rest of the system can use right away, while also pulling out special hidden markers.

At the center, stream_text.rs defines the common parser contract: a parser can take the next chunk of input and return visible text plus extra side data it discovered. lib.rs then gathers these tools into the public package other code imports.

utf8_stream.rs sits at the front when input arrives as raw bytes. It makes sure UTF-8 text is decoded correctly even if one character is split across chunks. line_buffer.rs does a similar incremental job for newline-based records, holding partial lines until the rest arrives.

The other files build smarter parsers on top of those basics. inline_hidden_tag.rs extracts hidden inline tags without showing them to users. tagged_line_parser.rs recognizes larger tagged blocks whose markers must appear on their own lines. table_detect.rs supplies shared rules for spotting markdown tables and code fences. mention_codec.rs translates visible @name or $name mentions to and from stored link form. citations.rs uses the hidden-tag machinery to pull structured memory citation IDs from markup.

#### [TUI text layout, wrapping, and text-rendering primitives](stage-22.2.3.md) `stage-22.2.3` — 10 files

This stage is the text-shaping toolbox behind the terminal user interface. It sits in shared support: before the screen can draw anything, the system must turn raw text into lines that actually fit in a terminal window, with the right colors, links, and scroll positions.

Several small helpers provide the basics. `render/mod.rs` and `line_utils.rs` supply simple building blocks for working with rectangles and text lines, like safely shrinking drawing areas or adding prefixes. `width.rs` adds guardrails so layout code does not try to wrap text into zero remaining columns. `ansi-escape/src/lib.rs` converts ANSI-colored strings into the project’s screen-text format.

Then come the layout tools. `line_truncation.rs` measures and cuts lines by visible terminal width, while keeping style intact. `wrapping.rs` breaks text into wrapped lines, including a special path that keeps URL-like text together. `markdown_text_merge.rs` repairs split-up markdown text so later steps can recognize whole visible chunks. `terminal_hyperlinks.rs` keeps hyperlinks as separate metadata so wrapping does not break them, then emits real terminal links at the end. `live_wrap.rs` supports streaming text that must wrap as it arrives. `scrollable_diff.rs` builds on all this to offer a wrapped, scrollable view of long diffs or messages.

#### [TUI presentation models, styling, and lightweight view helpers](stage-22.2.4.md) `stage-22.2.4` — 21 files

This stage is shared support for what the terminal interface looks like while the app is running. It sits above the low-level text layout layer: the lower layer knows how to place text, and this layer decides what text, colors, labels, and small view models should be shown.

Several files shape appearance. color.rs and style.rs choose readable colors and common visual styles based on the user’s terminal. ui_consts.rs keeps different parts lined up with the same left margin. renderable.rs gives the app a common “renderable” building block, so many kinds of text or widgets can be arranged in rows, columns, or with padding.

Other files prepare specific UI pieces. key_hint.rs formats keyboard shortcut hints consistently. footer.rs and action_required_title.rs build the bottom-area status text and urgent title text. popup_consts.rs, scroll_state.rs, selection_popup_common.rs, selection_tabs.rs, and selection_list.rs provide the machinery for menus and popups: tabs, row formatting, scrolling, and selected-item behavior.

The remaining helpers format compact user-facing text for goals, skills, status cards, remote connections, token charts, warnings, import-migration items, and history cells, so the interface stays consistent and easy to read.

#### [TUI animation, motion, terminal media, and transient progress output](stage-22.2.5.md) `stage-22.2.5` — 5 files

This stage is shared presentation support for moments when the program wants to look alive in the terminal without being distracting. It sits behind the scenes during the main work of the app and in command-line diagnostics, adding movement, images, or temporary status text when the terminal can support them.

The pieces work like a small display toolbox. motion.rs is the front desk: other parts of the text UI ask it for a spinner, shimmer, or other activity hint, and it decides whether to show full animation or a reduced-motion fallback for people who prefer less movement. shimmer.rs creates the moving highlight effect that makes text look like light is passing over it, using rich color when available and simpler brightness changes otherwise.

ascii_animation.rs is the timing engine for text art. It picks which frame of an animation to show based on time and tells widgets when to redraw. frames.rs supplies the actual built-in frame sets and default timing, like a catalog of flipbook pages stored inside the program.

cli/src/doctor/progress.rs does a similar job for the doctor command, showing a temporary progress line on standard error or staying quiet when that is the safer choice.

### [Configuration, metadata, schema, auth, and network glue utilities](stage-22.3.md) `stage-22.3` — 26 files

This stage is shared behind-the-scenes support. It does not do one big user-facing task by itself. Instead, it supplies the small but important rules that help the rest of the system agree on settings, names, versions, hosts, and security details.

Several files focus on configuration. They label where a setting came from, enforce rules on allowed values, translate old config keys to new ones, convert JSON into TOML, apply command-line overrides, and map CLI flags like approval mode or sandbox mode into the system’s internal form. Plugin and mention helpers keep names and syntax consistent, while skill mention counting detects name collisions.

Another group shapes metadata and schemas. Connector metadata helpers produce display names and links, memory schema code generates JSON Schema descriptions of tool inputs and outputs, and version helpers expose or compare release versions.

Security and network glue are another major part. PKCE generation supports secure login, auth utilities build headers or extract readable server errors, API-key reading tries to keep secrets out of memory, and host utilities normalize URLs, check allowed ChatGPT hosts, and enforce proxy network policy. Small request and task helpers tie these pieces into actual API calls and user displays.

### [Shell, command, git, plugin, and execution support utilities](stage-22.4.md) `stage-22.4` — 24 files

This stage is shared behind-the-scenes support. It gives the rest of the system the safe, practical building blocks for running commands, talking to Git, packaging plugins, and handling command output without surprises.

The shell pieces figure out which command shell to use, turn that choice into the exact program-and-arguments to launch, and build the environment variables passed in. They also help display commands clearly, split typed command text sensibly, and escape special characters so text is not misread by the shell.

The Git pieces are small wrappers around the system’s git program. They gather repository facts, compute diffs and branch relationships, and disable risky extras like hooks or unsafe file-monitor helpers so read-only Git checks stay side-effect free.

The plugin utilities pack plugin folders into compressed archives, unpack them safely, clone or stage marketplace content, and swap upgraded versions into place with rollback if something fails.

The execution utilities support launching processes across Unix, Linux sandboxing, Windows, PTY terminal sessions, and the CLI. They normalize executable names, preserve useful head-and-tail output when logs get large, map exit codes correctly, track sandboxed child processes, launch an external editor, and even help patching code by finding matching text approximately.

### [Async primitives, image handling, and miscellaneous small support libraries](stage-22.5.md) `stage-22.5` — 25 files

This stage is shared behind-the-scenes support. It is a box of small tools that many other parts of the system rely on during normal work, rather than one big feature by itself.

Several pieces help with images. The image utility crate reads images from bytes or data URLs, checks size and format, resizes when needed, preserves useful metadata, re-encodes safely, and caches results by content. Its error type gives clear reasons when that fails. Image-detail helpers decide when a model is allowed to request the untouched original image, and image preparation rewrites oversized or unsupported inline images into safe placeholders before later code sees them.

Another group supports terminal pets. Frames are cut out of a PNG sprite sheet and cached as separate files. Protocol detection then decides whether the terminal can show them with Kitty or Sixel graphics, and the Sixel encoder produces compact output for that path.

The rest are small plumbing parts: async cancellation racing, a one-time readiness flag, a pausable timeout stopwatch, cross-platform sleep prevention, runtime value conversion for JS and JSON, replay and frame-rate helpers for the TUI, a tiny cache, human-readable sandbox summaries, and a small V8 linkage test crate.

### [Build scripts and build-time asset/platform glue](stage-22.6.md) `stage-22.6` — 4 files

This stage is behind-the-scenes build support. It runs while the project is being compiled, before the program starts, and makes sure each platform gets the right extras bundled in. You can think of it as the packing and setup desk for the build.

The `bwrap/build.rs` script prepares Linux sandbox support. If the target is Linux, it can compile the bundled Bubblewrap C code into a static library, meaning native code that gets packed directly into the final binary. It also tells Cargo, Rust’s build tool, when to rebuild, where to find the compiled library, and sets a flag so the Rust code knows Bubblewrap is available.

The `windows-sandbox-rs/build.rs` script handles Windows packaging details. It adds a Windows manifest, a small metadata file that tells Windows how the helper program should behave, but only when the toolchain supports it.

The `cli/build.rs` script adds a special macOS linker option so the command-line app links Objective-C pieces correctly.

The `skills/build.rs` script watches embedded sample assets and forces a rebuild when those files change, keeping built-in content up to date.

## [Testing, fixtures, and developer verification harnesses](stage-23.md) `stage-23` · (cross-cutting) — 659 files

This stage is the project’s full testing workshop. It sits mostly behind the scenes and is used by developers to check the whole system before changes are trusted. It covers every phase of the product’s life: starting up, doing real work, talking to other programs, saving state, and shutting down cleanly.

Several big test groups work like different kinds of inspectors. The app-server suites check the server’s message formats, background process behavior, and full client-to-server conversations. The core runtime harnesses test the live session engine, tool running, safety rules, and end-to-end session flows. The CLI, exec, login, and MCP tests drive the real command-line programs and sign-in flows from the outside, the way users and editor integrations would. The exec-server, sandbox, and remote transport tests verify command execution, file access, secure remote links, and restricted environments. The TUI tests watch the text interface itself, using a fake terminal to confirm screens and interactions look right. Cross-cutting library tests cover shared support pieces used everywhere.

The `test-binary-support/lib.rs` file helps all this run smoothly by making test binaries pretend to be different commands based on how they are launched, while setting up a temporary home directory for safe, isolated test runs.

### [App-server test suites and protocol verification](stage-23.1.md) `stage-23.1` — 115 files

This stage is the app server’s big safety net. It lives behind the scenes and makes sure the server keeps speaking the right language, moving data safely, and behaving correctly from startup through normal use. Think of it as a mix of spell-checker, crash test, and dress rehearsal.

One part verifies the protocol, the message format clients and servers use to talk. It checks JSON encoding and decoding, compatibility rules, and saved schema “blueprints” so accidental message changes are caught early.

Another part tests the plumbing around the server: the daemon that stays running in the background, update logic, local socket connections, transport rules, and a special test client that can connect and act like a real user or tool.

A third part covers focused unit tests and shared fixtures. These fixtures are reusable test supplies such as fake config files, mock services, and a harness that can launch a real test server process.

Finally, the integration suites run full end-to-end scenarios: signing in, connecting live, using plugins and tools, and carrying conversations through their whole life cycle. Together, these layers catch both tiny mistakes and system-wide breakage.

#### [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files

This stage is a safety net for the protocol layer: the part of the system that turns in-memory data into messages sent over the wire, and back again. It sits behind the scenes and helps prevent accidental breaking changes as the code evolves.

The tests in common_tests.rs check one small but important rule: when the server builds a response, which pieces become the JSON-RPC result and which stay in a higher-level wrapper. That keeps replies shaped the way clients expect.

The files remote_control_tests.rs and v2/tests.rs check the actual message formats for version 2 of the protocol. They verify serialization and deserialization, meaning turning Rust data into JSON and reading JSON back into Rust. They lock down tricky edge cases like optional fields that may be null, responses that must encode as empty objects, older compatibility behaviors, enum value conversions, and feature gates for experimental APIs.

Finally, schema_fixtures.rs checks the generated schema files against saved fixtures. In other words, it makes sure the published “blueprints” for these messages still match what the code now produces.

#### [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files

This stage is the safety net around the app server’s “plumbing.” It sits mostly behind the scenes and checks that startup, updating, local communication, and special test tools behave correctly in awkward real-world cases.

Several tests focus on the daemon, the long-running background process. pid_tests.rs checks how it reads and writes PID files, which are small files that record a running process’s ID, especially when records are empty, stale, or racing with another launch. managed_install_tests.rs and update_loop_tests.rs verify how the updater recognizes installed binaries, compares versions by file identity, and decides whether to restart or refresh itself.

The transport tests check how messages move around. unix_socket_tests.rs validates local Unix socket addresses, permissions, cleanup, websocket control behavior, and startup locking. transport_tests.rs checks routing rules such as dropping unneeded notifications, gating experimental features, stripping fields, and handling backpressure.

Remote-control tests cover pairing and client management over HTTP. The test-client library and its tiny loopback server act like a practice robot: they launch or connect to the server, send requests, and support plugin analytics smoke tests. The analytics helper reads captured event logs and confirms that expected plugin-change events were emitted with the right metadata.

#### [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files

This stage is the app server’s safety net. It sits behind the scenes and checks that both small internal pieces and full server interactions behave the way the rest of the system expects.

Several files are tight, focused unit tests. They verify config import and migration rules, config file reading and writing, command-line flag parsing, tracing links between requests, refresh decisions after config import, remote-control error reporting, thread and summary behavior, and tricky regressions that once broke before. Together, these tests act like executable examples of the intended rules.

The rest is shared test infrastructure for bigger integration tests. Common helpers create fake auth data, temporary config files, cached model lists, stored conversation histories, and canned streaming responses. Mock servers stand in for external services such as analytics and model APIs. The `TestAppServer` harness starts a real `codex-app-server` process and talks to it through JSON-RPC, a request/response protocol that uses JSON text.

Finally, the suite index files gather all integration tests into one organized tree, so the whole app server can be tested as one machine.

#### [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files

This stage is the system’s full dress rehearsal for the app server. Instead of checking tiny pieces in isolation, it talks to the server the way a real client would and verifies that the whole thing works from startup checks through everyday use. It is mostly about the server’s main working life, with some startup validation and shared support around it.

One part checks the basics: signing in and out, token refresh, account limits, startup config validation, and the server’s catalog-style APIs for settings, models, features, and permission profiles. It also tests practical actions such as file access, running programs, sandbox setup, and remote-control pairing.

Another part focuses on live connections. It tests WebSocket and WebRTC links, reconnect behavior, clean shutdown signals, trust tokens during the initial handshake, and rules for hidden experimental features.

A third part covers extension points: plugins, marketplaces, hooks, skills, MCP tool servers, shell commands, file search, image generation, and web search.

The last part follows conversation life cycles end to end: creating threads, resuming and branching them, running turns, interrupting or steering them, saving state, reviewing results, and keeping clients updated consistently.

##### [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files

This stage is a broad “does the server really behave correctly from the outside?” check for the app server’s core surfaces. It sits in shared support around startup and normal operation. Instead of testing one small function, these suites talk to the server through its real JSON-RPC interface, like a client would.

Several tests focus on identity and access: auth.rs and v2/account.rs cover login, logout, token refresh, and which login methods are allowed. The rate limit suites check account limits, credit reset actions, and how backend failures are passed through. strict_config.rs makes sure the standalone server refuses bad config files at startup with a clear error.

Other files test what the server tells clients when it starts and what settings it uses. initialize.rs checks client identity and capability-based filtering. config_rpc.rs verifies reading and editing layered configuration. experimental_feature_list.rs, model_provider_capabilities_read.rs, collaboration_mode_list.rs, model_list.rs, and permission_profile_list.rs cover the server’s “catalog” APIs: lists of features, provider abilities, presets, models, and permission profiles.

Finally, fs.rs, process_exec.rs, windows_sandbox_setup.rs, and remote_control.rs test practical system actions like file access, running processes, sandbox setup, and pairing with remote-control services. Together, these suites make sure the server’s everyday contract stays reliable.

##### [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files

This stage is a set of end-to-end checks for how the app server talks to clients in real time. It sits in the system’s “main work loop”: once the server is running, these tests make sure connections open correctly, carry the right information, and behave safely when things go wrong.

The websocket connection tests are the foundation. They check that each client connection is kept in the right scope, that health-check web pages respond, that different login rules work, and that reconnecting does not confuse which worker thread is loaded. The Unix-only websocket tests add operating-system signal cases, such as shutting down or restarting the server while work is still in progress, and confirm clients see a clean disconnect.

The attestation tests focus on trust at the start of a connection. They verify that a client can be asked for a proof token and that the server forwards it in the websocket handshake header. The experimental API tests make sure hidden or in-progress features stay blocked unless the client explicitly opts in. Finally, the realtime conversation tests tie many features together, covering full live conversations over WebSocket and WebRTC, protocol version differences, event translation, and background agent turns.

##### [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files

This stage checks the app server’s “extension points” — the places where outside add-ons, tools, and helper services plug in. It sits in the system’s main working path, because these features are what make the server flexible once it is running.

Several tests focus on plugins and marketplaces, which are like app stores plus the install/uninstall machinery behind them. They check listing plugins, reading plugin details, adding, removing, and upgrading marketplaces, installing and uninstalling plugins, and sharing plugins with a backend service. Together, these make sure the server can find add-ons, fetch them, keep local files in sync, and clean up after changes.

Another group covers discovery: apps, hooks, and skills. A hook is a custom action triggered by events, and a skill is a reusable capability the model can call. These tests verify that the server notices them in the right places and updates clients when they change.

The rest covers MCP, command execution, and built-in tool integrations. MCP is a protocol for exposing tools and resources. These tests confirm tool calls, server status, user-confirmation flows, thread-specific executor behavior, shell commands, file search, image generation, sleep, and web search all behave correctly end to end.

##### [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files

This stage is the app server’s big reality check for conversation life cycle behavior. It sits in the system’s main working path: starting conversations, running turns, pausing or steering them, saving their state, and cleaning them up later. Think of it as testing the whole “conversation engine” while it is running, not just its individual parts.

Several files focus on threads, which are the server’s saved conversation sessions. They test creating a thread, reading it back, listing it, showing only loaded in-memory threads, resuming old ones, forking new branches, archiving, unarchiving, deleting, rolling back, resetting memory, and updating names, settings, metadata, and memory mode. Other tests make sure summaries are found correctly and that a remote thread store can replace local disk storage.

The turn-oriented tests cover starting a turn, interrupting it, steering it mid-flight, injecting items into history, handling dynamic tools, output schemas, plan items, permissions requests, and requests for user input. Review, compaction, status updates, client metadata, safety-policy notifications, and external-agent imports round out the picture, proving that active sessions stay consistent and clients see the right updates.

### [Core runtime and session test harnesses](stage-23.2.md) `stage-23.2` — 179 files

This stage is the project’s big test umbrella for the core runtime: the code that keeps a live session moving. It is mostly behind-the-scenes verification, not product startup or shutdown. Its job is to prove that sessions, tools, rules, and communication still work correctly when all the pieces are exercised together.

One part tests the core runtime’s internal rules: creating and restoring sessions, shaping prompts, keeping history and visible transcripts aligned, and enforcing safety and approval policies. Another part focuses on tools and command execution. It checks the published tool formats, the code that routes and runs them, and the guardrails around risky actions like shell commands or network access.

A shared integration harness acts like a reusable test workshop. It builds isolated fake environments, helper processes, mock servers, and logging so realistic tests can run repeatably. On top of that, the end-to-end suites perform full dress rehearsals: they send requests, stream responses, resume saved state, use tools, trigger approvals, and cover plugins, realtime features, rollout behavior, and remote or multi-agent work. Together, these layers catch both small mistakes and whole-system failures.

#### [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files

This stage is the safety net for the core runtime: the part of the system that keeps sessions, agent threads, permissions, history, and request formatting working while the app is running. It is not about one user feature. It is a broad behind-the-scenes test group that checks the “rules of the road” for the whole core crate.

Several files test session life from start to finish: creating a session, building each turn, restoring old conversations, rolling back mistakes, compacting long history, and keeping the visible transcript in sync with stored state. Other tests focus on context shaping: how user text, environment details, images, metadata, shell commands, and hidden markup are turned into the exact messages the model sees and the user later reads back.

A large set covers control and policy. These tests check guardian review, execution approvals, sandbox and safety decisions, agent spawning, thread limits, residency, registries, and delegated subagents. The remaining files verify support pieces such as plugins, realtime handoff, Git and shell discovery, timing, diffs, and wire-format request helpers. Together, they make sure core behavior stays predictable during refactors.

#### [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files

This stage is the project’s safety net for its tool system and command runner. It sits behind the scenes, mostly in testing, and makes sure the parts that describe tools, choose them, approve them, and execute them all behave exactly as intended.

One group of files checks tool “specs,” meaning the published shape of each tool’s inputs and outputs. These tests lock down schemas for things like shell commands, patching files, multi-agent work, MCP resources, hosted tools, and user-input requests, so other parts of the system can rely on a stable contract. Another group tests the handlers themselves: parsing inputs, building payloads, enforcing rules, and producing results.

The router and registry tests make sure tools are visible under the right names, exposed only when allowed, and dispatched to the right implementation. Approval, sandbox, and network-approval tests verify that risky actions are blocked or asked about correctly. Runtime and unified-exec tests then check the actual command-running machinery: preparing environments, handling shells, streaming output, buffering logs, managing processes, and preserving failures. The special test_sync tool helps these parallel tests stay predictable.

#### [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files

This stage is the shared test bench for the core part of the system. It is not the product’s normal startup or main work loop. Instead, it is the behind-the-scenes support that lets end-to-end tests run the core code in realistic situations and check what happened.

At the top, core/tests/all.rs creates one integration-test program, and core/tests/suite/mod.rs gathers all test modules into it. That suite file also adds a trick so the test program can pretend to be helper command-line tools when a test needs them.

Most of the heavy lifting lives in common/lib.rs, which collects reusable helpers. test_environment.rs figures out whether tests run locally, in Docker, or through Wine, and hooks.rs updates test config so hook scripts are treated as trusted. tracing.rs turns on test logging and telemetry, while process.rs waits for child processes to start or stop.

The rest are specialized fixtures: fake servers for apps, responses, websockets, and streamed SSE events; snapshot tools for comparing request context; zsh_fork.rs for real zsh-based scenarios; and builders such as test_codex.rs and test_codex_exec.rs that assemble isolated, repeatable test worlds. core/src/test_support.rs exposes extra test-only setup paths inside the core crate so these tests can wire everything together safely.

#### [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files

This stage is the big “real-world behavior” check for the core of the system. It sits in the main work of a live session and follows what happens as a conversation sends requests, streams replies, chooses tools, asks for approval, saves its place, and sometimes branches into helper agents or remote workspaces. In other words, it tests the whole journey a user can actually experience.

Its parts fit together like a full dress rehearsal. The transport and provider suites check the roads in and out: building requests correctly, streaming replies, and recovering from failures. The session history and persisted state suites make sure the system remembers where it was, can shrink old history into a shorter summary, and can resume after interruption. The model-shaping suites decide what the AI model sees and which model is used. The multi-agent and remote-environment suites cover teamwork and off-machine execution. The approvals, permissions, hooks, and review suites act as gatekeepers. Finally, the tool, shell, plugin, and runtime-item suites verify that available tools run safely and that the resulting event log tells an accurate story.

##### [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files

This stage checks the system’s “roads and rules” at the API boundary: how Codex sends requests out, receives streamed replies back, and copes when the trip is bumpy. It sits in the main work loop, because it covers real conversations with model providers, not startup or shutdown.

Several tests focus on building the right request before it leaves. client.rs checks headers, authentication, conversation history, special provider options, and error mapping. responses_headers.rs and responses_api_proxy_headers.rs make sure extra labels and metadata are attached so requests can be traced, especially for subagents. request_compression.rs confirms large requests are compressed when they should be.

Other files test streaming paths. agent_websocket.rs, client_websockets.rs, and realtime_conversation.rs cover WebSocket and WebRTC live sessions, including setup, reuse, and failure cases. turn_state.rs makes sure per-turn state stays consistent during one turn and resets on the next. stream_no_completed.rs, stream_error_allows_next_turn.rs, websocket_fallback.rs, quota_exceeded.rs, and safety_check_downgrade.rs verify retries, clean recovery, fallback to plain HTTP, and clear error handling.

The remaining tests cover special request flows: compact_remote.rs shortens old history safely, responses_lite.rs checks the lighter transport mode, and models_etag_responses.rs ensures model-list refreshes happen once, not repeatedly.

##### [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files

This stage tests the system’s memory: how a conversation keeps its place across turns, interruptions, and even restarts. It sits in the “continuity” part of the story, making sure the app can stop, save what matters, and pick up again without confusing the model or the user.

Several tests focus on compaction, which means shrinking long history into a shorter summary so future requests stay manageable. compact.rs checks the main compaction behavior, while compact_remote_parity.rs makes sure two remote compaction paths behave the same. compact_resume_fork.rs checks that compacted history still makes sense after resume, fork, or rollback.

Other files cover ongoing conversation flow. pending_input.rs tests how new input is queued and replayed while a turn is still running. resume.rs and resume_warning.rs verify how a saved session is rebuilt, including warnings if the model has changed. fork_thread.rs checks creating a new branch from an old conversation. window_headers.rs tracks the request “window” identity across these changes.

The remaining tests cover what gets saved: image input, temporary setting overrides, finding saved rollout files, and SQLite database state. Together, they verify that both visible history and behind-the-scenes storage stay consistent.

##### [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files

This stage is the “packing and routing desk” for model calls. It sits just before Codex sends a request to an AI model during the main work loop. Its job is to decide what the model should see, how that information is arranged, and sometimes which model should receive it.

Several tests check how extra instructions are added. additional_context, AGENTS.md, hierarchical agents, collaboration instructions, skills, permissions messages, personality, and token budget all make sure the right guidance is injected, kept across turns when needed, trimmed when too large, and not repeated by accident. prompt_debug_tests and model_visible_layout then verify the final model-facing layout: the exact input assembled from user messages, instructions, environment details, and resume or fork state.

Other tests focus on provider-specific request shaping. json_result checks structured JSON output requests, and web_search checks how search-tool settings are translated for the model provider. prompt_caching makes sure stable prompt prefixes are reused efficiently.

Finally, remote_models, model_runtime_selectors, auto_review, and model_switching cover model choice at runtime. They verify how remote model metadata updates local behavior, how special review models are chosen, and how requests are rewritten safely when Codex switches models mid-conversation.

##### [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files

This stage checks the system’s “teamwork” features: what happens when one session starts helper agents, sends work to them, shares updates, or runs in a remote workspace instead of the local one. It sits in the main work loop, not startup or shutdown, because it tests how the system behaves while real tasks are in progress.

The files each cover one part of that story. spawn_agent_description.rs makes sure the tool that creates a new agent explains itself clearly and only offers choices the user is actually allowed to see. agent_execution.rs tests the safety limits: nested agents must share the same pool of working capacity, and when the limit is hit, the failure must be visible instead of hidden. codex_delegate.rs checks how a child agent’s review and approval events are passed back into the parent conversation. subagent_notifications.rs follows the full parent/child lifecycle, including inherited context, overrides, hooks, and mailbox-style messages. agent_jobs.rs covers batch job creation, cancellation, and storing results. remote_env.rs verifies that work done in a remote environment stays properly isolated from the local machine.

##### [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files

This stage tests the system’s “gatekeepers” and side channels: the rules that decide whether a visible action is allowed, who must review it, what extra information is attached, and what outside hooks are notified. It sits in the main work loop, right where the system is about to run a command, ask the user something, or send work to another tool.

Several files focus on permission decisions. approvals.rs, exec_policy.rs, skill_approval.rs, unified_exec_zsh_fork_approvals.rs, request_permissions.rs, and request_permissions_tool.rs check when commands, patches, network changes, and file writes are blocked, allowed, or require approval, including saved grants and tricky sandbox limits.

Other files cover user and reviewer interaction. request_user_input.rs makes sure the system can pause and ask the user for more information. review.rs and guardian_review.rs test review flows, including automatic Guardian review, and ensure review data is routed correctly without leaking into ordinary notifications. mcp_turn_metadata.rs checks the labels attached to app or MCP tool calls so later reviewers understand what happened.

Finally, hooks.rs, hooks_mcp.rs, and user_notification.rs verify the plug-in style callbacks that can intercept, rewrite, log, or announce actions before and after tools run.

##### [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files

This stage is the system’s full dress rehearsal for tool use during the main work of a turn. It checks what tools the model or user can see, what happens when those tools run, and how the results are reported back. Think of it as testing the workshop floor: which tools are on the bench, who is allowed to use them, and what gets written in the job log.

Several suites focus on command running. tools.rs, tool_harness.rs, exec.rs, shell_command.rs, unified_exec.rs, shell_snapshot.rs, user_shell_cmd.rs, and abort_tasks.rs cover shell and exec commands, time limits, sandboxes, snapshots, interruptions, and the records produced while they run. apply_patch_cli.rs and shell_serialization.rs check file-editing tools and make sure outputs are sent back in the right plain-text form, with truncation.rs limiting oversized results safely.

Other files test special tool families. plugins.rs, request_plugin_install.rs, search_tool.rs, openai_file_mcp.rs, extension_sandbox.rs, code_mode.rs, and view_image.rs cover plugin discovery, app/MCP integrations, file upload before tool calls, extension permissions, script-runtime tool use, and image handling. Finally, tool_parallelism.rs and items.rs verify that multiple tools can run together and that the stream of events and history items accurately tells the story of what happened.

### [CLI, exec, login, and MCP server developer verification](stage-23.3.md) `stage-23.3` — 73 files

This stage is the big real-world test bench for developer-facing command-line tools and workflows. It sits after the code is written, as a final “does it actually behave right from the outside?” check. Instead of testing small internal pieces, it runs the actual executables the way a person, script, or editor integration would.

The apply-patch tests focus on the standalone patching tool. They check simple command use, error cases, and full folder-changing scenarios. The top-level codex CLI tests cover the main codex command itself: server-style commands, maintenance commands, plugin and marketplace actions, MCP server management, and a few live smoke tests.

The codex-exec tests do the same for the codex-exec program. They verify command-line parsing, human-readable and machine-readable output, saved sessions, approvals, hooks, patch flows, and failure behavior. The execpolicy tests are the rule checker for command safety. They confirm both the current and older policy systems still make the expected allow-or-block decisions.

The login tests rehearse full sign-in, token refresh, and sign-out journeys. The MCP server tests then drive the real server process with JSON-RPC, a simple request/reply message format, to confirm external tool flows end to end.

#### [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files

This stage is the outside-in check for the standalone apply-patch program. It sits in the testing part of the system, not startup or shutdown. Its job is to make sure the compiled command-line tool behaves correctly when a real user runs it, writes files, hits errors, or applies a full patch to a folder tree.

all.rs is the single entry point that launches these integration tests. It hands off to the shared suite in suite/mod.rs, which groups the tests by theme and skips a few that do not make sense on Windows.

The tests then cover the tool from different angles. cli.rs checks the most basic ways people invoke the program: passing patch text as an argument or sending it through standard input, which is the text stream a program can read from the terminal or another command. tool.rs goes deeper into the user-facing contract: success paths, bad input, file errors, overwriting existing files, renaming, and what happens if only part of a patch can be applied. scenarios.rs is the broad safety net, using prepared example folders and comparing the final directory contents with the expected result.

#### [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files

This stage is the final checkpoint for the main codex command-line tool: it tests what happens when a real user types top-level commands. In the system’s story, this sits at the boundary where startup choices, maintenance tasks, and admin-style commands all meet the outside world.

The tests make sure each entrypoint accepts the right inputs and rejects bad ones early. app_server.rs and exec_server.rs check strict configuration parsing, so these server-style commands fail clearly when settings are wrong. delete.rs guards a past bug by checking that `codex delete` reports errors in the right order. update.rs confirms debug builds refuse to run the normal update flow.

Several files cover maintenance commands. debug_clear_memories.rs checks cleanup of stored memory data, even when the main database file is missing. debug_models.rs verifies machine-readable JSON output for model listings. features.rs tests feature flags, including saving settings and showing warnings.

The plugin and marketplace tests act like a store manager: plugin_cli.rs covers listing, install/remove, and marketplace lookup rules, while marketplace_add.rs, marketplace_remove.rs, and marketplace_upgrade.rs check the add, remove, and upgrade commands. mcp_add_remove.rs and mcp_list.rs test managing external MCP servers. Finally, live_cli.rs runs optional real-world smoke tests against the live service.

#### [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files

This stage is the safety net around the codex-exec command-line program itself. It sits at the boundary where a user, script, or automation tool actually runs the binary, so these tests make sure startup, normal work, and failure cases all look correct from the outside.

Some tests focus on understanding the command line. cli_tests.rs and main_tests.rs make sure flags, subcommands, prompts, and older compatibility options are parsed the right way before the program does any real work. lib_tests.rs checks the small startup helpers underneath that parsing, such as prompt decoding and logging filters.

Another group checks what codex-exec says while it runs. The human-output and JSONL event processor tests confirm that streamed events become the right final messages, warnings, summaries, and machine-readable records. The broader JSON output suite tests the full event translation path.

The integration tests then treat codex-exec like a real tool. They verify prompt input from stdin, session saving and resume, auth and headers, instruction-file loading, approval rules, hooks, patch workflows, MCP startup failures, server-error exit codes, extra writable directories, and streaming behavior as an external subprocess. Together, these tests confirm the binary keeps its public promises.

#### [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files

This stage is the system’s safety check for command-running rules. It sits in the “does it really behave as promised?” part of the story, after the policy code exists, and proves that both the current and older rule sets still make the same kinds of allow-or-block decisions.

The newer tests cover the full path from reading a policy to judging a command. execpolicy/tests/basic.rs checks common rule types such as command prefixes, network access, examples, explanations, and finding the real program on the host machine. cli/tests/execpolicy.rs goes one step further and tests the user-facing command-line tool, making sure its JSON output has the right decision details.

The legacy side keeps a large, curated command corpus alive. all.rs and suite/mod.rs gather many smaller test groups into one runnable suite. good.rs and bad.rs act like a master answer key: known-safe examples must pass, and known-unsafe ones must fail. The command-specific files then inspect tricky cases for cp, head, ls, pwd, literal argument matching, and sed parsing and safety, checking not just pass or fail but the exact normalized result or exact error returned.

#### [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files

This stage is the safety net for the login system. It sits around the main work of signing in, staying signed in, and signing out, and checks that those real user journeys work from end to end. Think of it like rehearsing the whole front-desk process, not just testing each button in isolation.

At the top, all.rs and suite/mod.rs gather the separate test modules into one test program so they run together consistently. Several smaller tests check the building blocks: access_token_tests.rs tells apart two token formats, personal_access_token_tests.rs confirms token details can be loaded from the auth service, storage_tests.rs checks every place login data can be saved, and bedrock_api_key_tests.rs verifies API-key storage and cleanup. auth_tests.rs ties many of these rules together, including loading saved login state, handling expired or invalid credentials, and applying account restrictions.

The larger integration tests play out full login stories. device_code_login.rs covers sign-in with a code shown to the user. login_server_e2e.rs tests browser-based sign-in through a local callback server. auth_refresh.rs checks automatic token renewal. logout.rs makes sure sign-out revokes tokens and wipes saved state. cli/tests/login.rs confirms the command-line entry points behave correctly.

#### [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files

This stage is the system’s end-to-end test bench for the MCP server program. It is not part of normal startup or shutdown. Instead, it checks that the finished executable behaves correctly when spoken to from the outside, much like testing a machine by pressing its buttons and watching what comes out.

The top-level test entry point in all.rs gathers these integration tests into one runnable bundle. suite/mod.rs organizes that bundle and currently points to the codex tool tests. common/lib.rs offers small shared helpers, including a way to turn raw JSON-RPC replies—JSON-RPC is a simple message format for request-and-response conversations—into typed Rust values that tests can inspect safely.

The heart of the harness is common/mcp_process.rs, which starts the real codex-mcp-server as a child process and sends it line-by-line JSON-RPC messages. common/mock_model_server.rs stands in for the remote model service, replaying preloaded streamed replies in a fixed order. common/responses.rs builds those fake streams, including assistant text, shell commands, and patch requests. Finally, suite/codex_tool.rs ties everything together to verify real codex tool flows, especially approval prompts and instruction passing.

### [Exec-server, sandbox, and remote transport harnesses](stage-23.4.md) `stage-23.4` — 49 files

This stage is the system’s proving ground for running code outside the main app. It sits in shared behind-the-scenes support, but it checks many paths the system depends on later: starting an exec-server, talking to it over WebSocket or stdio, moving files, making HTTP requests, and running commands inside sandboxes or on remote machines.

The common test helpers boot fake helper programs, launch real exec-server processes, and let tests send JSON-RPC messages, which are structured request-and-response messages. From there, several groups check the server’s basic contract: initialize, health, WebSocket behavior, process start and stop, and the lower-level handler logic that keeps sessions and child processes straight.

Another group tests file access. Shared support runs the same scenarios against local and remote filesystems, plus Unix and Windows edge cases, URI path handling, and streamed file reads. Transport-focused tests check HTTP-over-RPC helpers, stdio-to-socket bridging, and remote-control message chunking.

Finally, the relay, Noise encryption, and remote-environment tests verify secure remote links, reconnect behavior, and encrypted traffic. Sandbox tests on Linux, macOS, Windows, and Wine make sure restricted execution really enforces the intended rules.

### [TUI interaction and rendering tests](stage-23.5.md) `stage-23.5` — 52 files

This stage is the safety net for the terminal user interface, or TUI: the text-based app people see and interact with. It mostly belongs to the system’s main working life, checking that screens, prompts, menus, and status lines behave correctly while the app is running, and that startup and shutdown details still look right.

A few shared helpers make these tests possible. `test_support.rs`, `app/test_support.rs`, and the chat widget helpers build realistic fake app state so tests stay short but believable. `test_backend.rs` provides a pretend terminal powered by a VT100 parser, so tests can “look at the screen” without using a real terminal window. The integration entry files under `tui/tests/` gather everything into one test program.

From there, the tests cover the app from different angles. App-level files check startup routing, session summaries, config updates, shutdown, and cross-module behavior. Chat widget tests are the biggest group: they verify message submission, slash commands, approvals, popups, permissions, review and plan modes, layout, status surfaces, terminal title updates, and replaying old sessions. Other files lock down rendering details for history cells, markdown, token charts, status output, and layout math, plus a few smoke tests that drive the real TUI.

### [Cross-cutting library tests, fixtures, and telemetry or rollout support](stage-23.6.md) `stage-23.6` — 190 files

This stage is a broad safety net for shared support code that many parts of the system depend on. It sits mostly behind the scenes rather than in the main app loop. Its job is to prove that common libraries, storage helpers, add-on systems, and test doubles all behave predictably before the bigger features build on them.

Several sub-stages cover the major support areas. Analytics and telemetry tests check the system’s self-reporting, like counters, traces, and event logs. Configuration and policy tests make sure settings are read, merged, and enforced correctly. Plugin, extension, skill, MCP, and tool tests verify that optional add-ons can be discovered, loaded, and described properly. API, model, prompt, protocol, and transport tests cover the plumbing for talking to remote services. Memory, rollout, state, and persistence tests check stored history, replay, and recovery. Utility tests lock down small shared helpers such as path handling and text truncation.

The directly assigned files add focused checks for specific parts: a mock cloud-tasks client, file watching, hook output spilling to disk, line buffering, terminal detection, image loading, goal token accounting, and the `chatgpt` crate’s test entry points. Together, these pieces act like inspection stations across the shared toolkit.

#### [Analytics and telemetry tests](stage-23.6.1.md) `stage-23.6.1` — 18 files

This stage is the system’s observability safety net. It sits behind the scenes and checks that the code reports the right facts about what the app is doing: counts, timings, logs, traces, and analytics events. In other words, it tests the “dashboard and black box recorder” parts of the system.

The otel test crate and suite files organize the OpenTelemetry tests, while the shared harness builds a fake in-memory exporter so tests can inspect emitted metrics without needing a real server. The validation, timing, send, snapshot, runtime summary, and manager metrics tests each check a different part of metric reporting, from rejecting bad inputs to exporting histograms, taking snapshots, and adding standard tags. Export routing and OTLP loopback tests go a step further by checking how logs, traces, and metrics are packaged and sent over HTTP.

The analytics client tests and reducer tests verify which analytics events are created, how they are grouped, filtered, inherited, and serialized. The app-server, core, and state tests then confirm that telemetry appears correctly in real workflows, helper functions, tracing events, and the SQLite-backed log store. Together, these tests prove that the system’s self-reporting is trustworthy.

#### [Configuration, policy, and environment tests](stage-23.6.2.md) `stage-23.6.2` — 43 files

This stage is the project’s safety net for all the rules that shape how the app starts and behaves before the main work begins. It checks how configuration files are read, combined, edited, and validated, and how policy decisions are derived from them. In simple terms, it makes sure the system interprets settings the same way every time.

Several tests focus on configuration itself: parsing TOML text, merging layers from user files, managed enterprise bundles, profiles, and cloud-delivered settings. Test-support helpers build fake cloud bundles so other tests can exercise realistic setups without lots of boilerplate. Other tests lock down strict validation, feature flags, schema generation, deprecation notices, and migrations from older settings.

A second group covers policy: permissions, sandbox behavior, network proxy rules, Windows sandbox options, tool-policy choices, hook rules, and prompt text shown to users. These tests confirm precedence—who wins when user settings, defaults, and managed requirements disagree.

A third group checks environment-related behavior, such as execution environment variables, path handling, home-directory instructions, cache and service behavior for cloud config, and a few focused fixtures for tasks, memories, and auth storage. Together, these tests keep the project’s “control panel” reliable.

#### [Plugins, extensions, skills, MCP, and tools tests](stage-23.6.3.md) `stage-23.6.3` — 50 files

This stage is the system’s safety net for everything that can be added on top of the core app: plugins, extensions, skills, MCP servers, and tools. It mostly supports the main work of the product, but from behind the scenes. These tests make sure outside pieces are found, loaded, filtered, and turned into something the app can actually use.

One group checks plugins from end to end: building fake plugin folders, reading manifests, choosing versions, syncing curated marketplaces, sharing remotely, and deciding which plugin apps, hooks, skills, and MCP servers should be visible. Another group focuses on skills, which are reusable abilities: it tests how skills are discovered on disk, enabled or disabled, chosen from user mentions or shell commands, and exposed through the skills extension.

Extension tests cover the shared API that extensions plug into, plus concrete extensions like goals, memories, image generation, and skills. MCP tests cover server configuration, catalog conflict handling, connection setup, hosted apps, and real client transport behavior over stdio or HTTP. Finally, tool tests verify how tool descriptions are named, serialized, searched, converted from MCP or dynamic inputs, and adapted for different APIs and clients.

#### [API clients, models, protocol, prompts, and transport support tests](stage-23.6.4.md) `stage-23.6.4` — 38 files

This stage is the project’s safety net for the “client side” of the system: the parts that talk to APIs, choose models, build prompts, encode protocol messages, and move data over HTTP, WebSockets, sockets, or local mock backends. It sits mostly in shared behind-the-scenes support, making sure the system’s plumbing behaves exactly as expected before the main work loop depends on it.

Several tests focus on model and provider data: they check how provider definitions are read from config files, how built-in presets and collaboration modes are created, how overrides change model limits, and when cached model catalogs should be reused or refreshed. Another group checks login and API client behavior, such as token parsing, request headers, error mapping, retries, and Azure-specific request shaping.

Prompt tests lock down the exact wording sent to models, including review prompts, goal prompts, and memory-writing prompts. Protocol and transport tests verify message formatting, text decoding, line splitting, retry rules, socket behavior, and realtime event handling. Mock and test-support files provide fake backends and easy-to-build model data so these tests can run predictably without relying on real remote services.

#### [Memories, rollout, state, and persistence tests](stage-23.6.5.md) `stage-23.6.5` — 26 files

This stage is the system’s safety net for behind-the-scenes storage and replay. It does not do the main work itself. Instead, it checks that the system can remember what happened, rebuild that history later, and recover cleanly when files or databases go wrong.

One group of tests focuses on rollout traces: recorded event streams that can be replayed into a simpler summary of a conversation, code run, terminal session, or agent handoff. Shared fixtures build tiny fake traces, and the reducer tests check tricky event order, partial results, cancellations, and missing evidence. Thread and protocol tests make sure traces are captured in the right shape from the outside.

Another group covers persistence: runtime state, recovery after SQLite database corruption, message history files, local thread storage, and the ledger that tracks external-agent sessions. These confirm that records are written, updated, found again, and repaired correctly.

The memories tests check the startup pipeline, prompt building, citation parsing, workspace diffs, pruning old resources, and syncing summary files to disk. Finally, rollout storage tests verify compression, metadata extraction, indexing, recording, scanning, and database fallback so saved sessions stay usable over time.

#### [Utility crate tests for path/URI and output truncation helpers](stage-23.6.6.md) `stage-23.6.6` — 3 files

This stage is the project’s safety net for two small but important shared tools. It is not part of startup or shutdown. Instead, it is behind-the-scenes support: tests that make sure other parts of the system can trust these utility libraries.

One part checks output truncation, which means cutting text down to fit a size limit. The tests in truncate_tests.rs make sure shortening works the same way whether the limit is based on bytes or tokens, and whether the output is plain text or a structured list of content items. This prevents broken snippets and inconsistent limits.

The other two files focus on paths and URIs. A URI is a standard text form for identifying a location, like a file or web address. tests.rs checks PathUri, the core type that stores file-like locations in a platform-safe way. It verifies normalization, conversion to native Windows or POSIX path forms, encoding fallbacks, serialization, and clear error handling. api_path_string_tests.rs then tests the API-facing wrapper that turns those locations into the text form users and external callers see, including tricky cases like Windows drives, network shares, and unusual fallback URIs.
