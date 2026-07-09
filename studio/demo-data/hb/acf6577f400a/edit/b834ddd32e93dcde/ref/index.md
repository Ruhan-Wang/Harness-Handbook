# System Handbook — Stage Index

Each stage below links to its full page; the paragraph is the stage's role in the system.

## [Process entrypoints and binary dispatch](stage-1.md) `stage-1` — 65 files

This stage is the very first step of startup for the project’s native programs. It is the switchboard that turns “a user started this binary” into “run this specific mode now.” In simple terms, it reads the command-line input, figures out which program behavior was requested, and hands control to the right runtime path.

The primary user-facing launch surfaces are the main front doors. They define the commands and options users can type, check them, and route each request to the right feature: the main CLI, the text interface, desktop app launchers, server modes, maintenance commands, and troubleshooting tools.

The auxiliary binaries and developer tools are the side doors and workshop tools. They start helper programs, generate shared format files, inspect logs, run test servers, search files, and set up sandboxed runs. These are smaller focused binaries that support development, testing, and safe execution.

The direct file here, exec/src/main.rs, is the entrypoint for the codex-exec binary. It reads top-level config overrides, can change behavior based on argv[0] (the program name used to start it), and then forwards ordinary exec runs into the main execution library.

### [Primary user-facing launch surfaces](stage-1.1.md) `stage-1.1` — 19 files

This stage is the system’s front door. It is where user commands first arrive, during startup, and where the program decides which path to take next. Think of it like a train station ticket desk: it reads what the user asked for, checks the rules, and sends the request to the right platform or tool.

The main `codex` command in `cli/src/main.rs` is the central traffic controller. It understands all top-level commands and shared flags. `cli/src/lib.rs`, `tui/src/cli.rs`, `exec/src/cli.rs`, and `cloud-tasks/src/cli.rs` define the shapes of those commands so raw text typed in a shell becomes structured options the code can trust.

From there, specialized launchers do the real work. The TUI files start the interactive text interface. The desktop-app files open Codex Desktop, with separate macOS and Windows behavior hidden behind one common entry point. Other commands start remote control, run sandboxed commands, set up Windows sandbox support, manage MCP server settings, apply task diffs to Git, archive or delete sessions, and run `doctor` checks that inspect local state and report problems clearly.

### [Auxiliary binaries and developer tools](stage-1.2.md) `stage-1.2` — 45 files

This stage is a toolbox of small programs that support the rest of the system. They are not the main everyday command path. Instead, they help developers generate files, inspect behavior, run test servers, or launch special helper processes.

One group creates shared descriptions of data formats. The config schema tools write the JSON Schema for config.toml, and the protocol and hooks exporters refresh TypeScript and schema fixture files that tests and other tools rely on. A similar helper regenerates example protobuf code.

Another group is made of standalone utilities. apply_patch wraps the patch engine as its own command. file-search scans folders and ranks matching paths, then prints results in human-friendly or JSON form. The state log viewer tails the SQLite log database. Markdown and extension examples help inspect parser output and demonstrate extension behavior.

The rest are bridge, server, and sandbox helpers. They start test servers, proxy APIs, connect stdio to sockets, capture notifications safely, and launch execution or policy-check tools. Linux and Windows sandbox binaries set up restricted environments and run commands inside them, acting like safety gear around risky work.

## [Early process hardening and runtime bootstrap](stage-2.md) `stage-2` — 3 files

This stage is the program’s “get ready before opening the doors” step. It runs very early, before the app starts its real work. Its job is to make the process safer, choose shared security settings, and set up the runtime pieces that later code expects.

process-hardening/src/lib.rs is the first safety check. It applies operating-system-specific protections, such as blocking crash dumps or debugger attachment where appropriate, and removing risky environment variables that could trick the system’s dynamic loader into using the wrong libraries. In simple terms, it clears out dangerous settings before anything important starts.

utils/rustls-provider/src/lib.rs sets the program’s global TLS and cryptography provider. TLS is the standard way software makes secure network connections. This file makes sure one specific crypto backend is chosen once, for the whole process, and confirms it supports a required signing method.

arg0/src/lib.rs then handles how the single binary can behave like several commands. It looks at the program name and arguments, creates temporary PATH aliases so re-run helper commands still resolve correctly, and starts the Tokio runtime, the async event loop that lets the program manage many tasks efficiently. Together, these pieces create a safe, predictable base for everything that follows.

## [Installation context, home discovery, and local environment probing](stage-3.md) `stage-3` — 12 files

This stage is the system’s “figure out where am I and what do I have?” step near startup. Before loading settings or making decisions, Codex needs a clear picture of its home folder, its installation layout, the machine it is on, and any helper tools it can use.

The home-dir code chooses the Codex home directory, either from CODEX_HOME or the user’s normal home folder, and checks that an explicitly supplied path is valid. install-context then works out how this copy of Codex was installed, where bundled files live, and where to find helper programs such as rg (ripgrep, a fast text search tool) or a bundled zsh shell. managed_install adds details for standalone installs, including version lookup and fingerprinting the executable so updaters can tell builds apart. On Windows, helper_materialization copies packaged helper programs into a shared sandbox bin folder and reuses cached results.

The rest describes the running environment. shell_snapshot captures a shell’s exported variables, aliases, and options into temporary files. environment and environment_provider turn that into reusable local or remote execution environments. host_name normalizes the machine name. The doctor and cloud-detection files report Git, OS, locale, editor, runtime, and likely cloud environment information for troubleshooting and automatic selection.

## [Configuration, feature resolution, and startup policy assembly](stage-4.md) `stage-4` — 105 files

This stage is the startup “decision desk” for the whole system. Before the app can do real work, it must gather settings from many places, decide which optional features are on, and turn broad rules like “what files may be touched” into exact runtime instructions.

One part loads and merges all config layers: built-in defaults, managed or cloud settings, user and project files, per-thread settings, and command-line options. Shared CLI option code defines which command-line value wins when options overlap. The server-side config manager gives other parts one place to ask for the latest final config.

Another part resolves feature flags, providers, plugins, MCP servers, model catalogs, project-root markers, and bundled assets so the app knows what tools and built-ins exist.

A key part compiles permission profiles and sandbox policy. It translates human-written TOML settings into concrete file access, network rules, workspace roots, and Windows-specific sandbox instructions.

The rest supports editing, migration, debugging, and persistence: UI helpers write config changes safely, debug views explain where settings came from, lockfiles record the exact config a session used, and migration tools import settings from older external tools.

### [Config layer ingestion and requirements composition](stage-4.1.md) `stage-4.1` — 42 files

This stage is the system’s configuration assembly shop. It runs after raw config files and managed inputs are available, but before the rest of the program starts relying on them. Its job is to turn many possible sources of settings and rules into one checked, trustworthy result.

The core config loading part reads TOML files (a human-friendly config file format), cloud or managed inputs, profiles, thread settings, and command-line overrides. It knows what valid settings should look like, merges layers in priority order, remembers where each value came from, and produces clear errors with file and line numbers when something is wrong. It can also freeze the final result as a snapshot.

The requirements composition part does the same kind of work for requirement rules and execution policies. It standardizes messy input, combines special fields like permissions and hooks carefully, and builds the final rule stack that runtime code will enforce.

The management services part lets other parts of the app read, edit, and save settings safely.

config/src/lib.rs is the front desk for all of this: one public entry point that re-exports the loaders, schemas, diagnostics, and editing tools.

#### [Core config schemas, diagnostics, merge, and layered loading](stage-4.1.1.md) `stage-4.1.1` — 22 files

This stage is the behind-the-scenes configuration engine. It takes settings from many places—built-in defaults, managed or cloud-provided policies, user files, project files, per-thread settings, and command-line overrides—and turns them into one final set of rules the rest of the system can trust.

Several files define what valid settings look like. config_toml.rs covers the main config.toml file, while hook_config.rs, mcp_types.rs, profile_toml.rs, tui_keymap.rs, environment_toml.rs, and thread_config.rs describe special areas such as hooks, external servers, named profiles, keybindings, environments, and thread-specific settings. schema.rs exposes these shapes for schema generation, and agent_roles.rs loads role definitions built on top of the same layered config.

Once raw settings are read, merge.rs combines layers in priority order, overrides.rs turns command-line paths into config data, and state.rs keeps the stack plus where each value came from. fingerprint.rs creates stable hashes and origin maps. cloud_config_bundle.rs, cloud_config_layers.rs, validation.rs, layer_io.rs, macos.rs, and loader/mod.rs fetch and assemble all sources. Finally, strict_config.rs and diagnostics.rs catch mistakes and point to the exact file and line, while config_lock.rs saves a frozen snapshot of the effective result.

#### [Requirements layering and execution-policy composition](stage-4.1.2.md) `stage-4.1.2` — 11 files

This stage is the behind-the-scenes builder that turns many requirement and policy inputs into one clear set of rules the rest of the system can trust. It sits between reading configuration files and actually enforcing them at runtime.

Some files define what these inputs are supposed to look like. config_requirements.rs reads requirement data from TOML, normalizes messy input into a standard shape, remembers where each piece came from, and turns it into checked constraints that can reject forbidden settings with useful error messages. requirements_exec_policy.rs does the same kind of job for execution policy rules, converting file-friendly syntax into the internal policy format.

The requirements_layers files are the assembly line. layer.rs prepares each incoming layer. permissions.rs, hooks.rs, and rules.rs handle special fields whose pieces must be combined carefully instead of simply replaced. stack.rs then merges all layers into one final result, keeping source information attached.

Two files apply these results to real runtime behavior. network_proxy_loader.rs builds proxy settings from layered config and policy overlays, reloads them when files change, and checks they stay within trusted limits. amend.rs safely appends new policy rules to disk. hooks/config_rules.rs computes the final saved hook overrides, with limits on which layers may control trust and enablement.

#### [Configuration management services and editable persistence surfaces](stage-4.1.3.md) `stage-4.1.3` — 8 files

This stage is the system’s control panel and notebook for settings. It sits in shared support work: not the main job itself, but the part that remembers choices, lets other parts read or change them, and explains when something went wrong.

At the app-server side, config_manager_service.rs is the main service for reading and writing user settings. It checks that changes are valid, avoids overwriting newer edits by accident, and reports when a saved value is being hidden by a stronger setting from somewhere else. config_processor.rs turns those abilities into RPCs, meaning remote calls other parts of the app can make, and also refreshes cached data after a change. config_errors.rs makes low-level loading failures understandable to callers, while still keeping detailed machine-readable clues.

Underneath, edit.rs and document_helpers.rs do the careful file surgery on config.toml. They turn high-level change requests into real text edits, batch them safely, and try to preserve the file’s structure and formatting.

external_agent_config.rs imports settings and related content from another agent during onboarding. personality_migration.rs performs a one-time default-setting upgrade. settings.rs stores the daemon’s own small local settings, such as whether remote control is enabled.

### [Feature flags, provider catalogs, and built-in asset installation](stage-4.2.md) `stage-4.2` — 33 files

This stage prepares the “catalogs and switches” the rest of the app depends on during startup. Before any session or screen can appear, the system needs to know which optional features are on, which providers and servers exist, and which built-in files should be present on disk.

One group of files builds the feature-flag system: it defines the shape of feature settings, translates old flag names to new ones, combines config files and runtime overrides into one final answer, and enforces policy rules. The TUI popup lets a user change experimental flags and saves the choice.

Another group prepares built-in assets. Skills settings describe which skills are allowed, the skills code installs bundled system skills only when needed, seeds default memory-extension instructions, loads skill files from many locations, and filters them through enable/disable rules. Plugin marketplace and plugin-loading code finds installed plugin sources and turns them into usable capability lists.

The stage also assembles service catalogs: MCP servers are parsed and merged from config, plugins, and built-ins; model providers and model metadata are validated and given defaults; collaboration modes and approval presets provide ready-made behavior choices. Finally, TUI catalogs supply built-in pets, model lists, update actions, and pet image assets.

## [Authentication, identity, and account readiness](stage-5.md) `stage-5` — 40 files

This stage is the system’s “who are you, and are you ready to use the service?” step. It mainly happens during startup and account changes, then keeps helping in the background whenever credentials need to be refreshed or adapted for a request.

One part covers interactive login and saved sign-in state. It lets a person log in through a browser or device code, stores the result safely, checks whether they are still signed in, and logs out when asked. Another part acts like a badge converter. Different backends want different proof of identity, so it turns saved login details into the right form, such as a bearer token or an AWS-signed request.

The direct auth manager is the traffic controller for all of this. It loads credentials from disk or the environment, decides which auth mode is active, refreshes expired tokens, and applies rules about what is allowed. Token files define what gets stored and how JWTs, which are signed identity tokens, are read. Access-token files distinguish token types and, for personal tokens, call “who am I” to fetch account details. Installation ID code gives each app install a stable local identity. On Windows sandboxed setups, special helper code creates and manages the local system accounts that the sandbox needs.

### [Interactive and persisted login flows](stage-5.1.md) `stage-5.1` — 15 files

This stage is the system’s “getting signed in and staying signed in” layer. It covers the moments when a person first logs in, when the app saves those credentials safely for later, and when it logs out or checks account status. In the bigger story, this is mostly startup and account management, with some behind-the-scenes support for later requests.

The CLI entry file drives commands like login, logout, and “am I signed in?”, and leaves a small log file to help troubleshoot problems. The login crate is the main engine behind those commands. Its browser path starts a short-lived local web server to catch the login callback after the browser finishes. If that is not possible, the device-code path shows a code for the user to enter elsewhere, then keeps checking until approval is complete.

Once login succeeds, the storage code decides where to keep the credentials: a normal file, the system keyring, encrypted secret storage, or temporary memory only. Keyring selection and the keyring wrapper make those secure stores usable. Logout also tries to revoke tokens remotely. The account processor exposes the same ideas through JSON-RPC for the app and onboarding screens, while the TUI onboarding flow presents the device-code version. Separate rmcp-client files do similar OAuth login and storage work for MCP servers.

### [Provider and backend auth adaptation](stage-5.2.md) `stage-5.2` — 19 files

This stage is the system’s “ID and badge office.” It sits behind the scenes and prepares the different kinds of proof the rest of the code needs before it can talk to outside services. Later HTTP requests, websocket connections, and internal RPC calls all rely on these adapters so they can authenticate in a consistent way.

At the center, the model-provider crate exposes the public API and builds the right provider at runtime. Its main wiring code chooses between a general provider and the Amazon Bedrock path, then asks the auth layer to turn saved settings into something that can actually attach credentials to requests. For common services, the bearer auth provider adds bearer tokens and related routing headers. For Bedrock, dedicated files choose between bearer tokens and AWS SigV4 signing, which is AWS’s way of proving a request was signed with valid cloud credentials, and they also build the correct Mantle endpoint URL.

Other files supply the raw credentials. Agent identity code creates and verifies signed identity data. Login helpers load saved agent or external bearer-token records. AWS auth code loads AWS credentials and performs SigV4 signing. Client-specific pieces adapt these results for Codex API, remote control, MCP servers, per-request attestation headers, and an authenticated backend call for rate-limit reset handling.

## [Persistence and local runtime services startup](stage-6.md) `stage-6` — 6 files

This stage is part of startup. Its job is to make sure the app’s local storage is ready before the rest of the system begins real work. Think of it like opening a workshop in the morning: unlock the room, check the tools, fix anything broken, and only then let everyone start.

The main setup happens in state/src/runtime.rs. It opens the local SQLite databases, which are small on-disk databases, for state, logs, goals, and memories, updates them to the expected format, and builds the shared runtime object other code uses. state/src/migrations.rs provides the upgrade rules and makes startup safer by tolerating cases where a database was already upgraded by a newer version of the app.

On top of that, rollout/src/state_db.rs connects the rollout feature to this storage layer. It waits for important metadata backfill, meaning filling in missing saved details, and then offers helpers to list, find, repair, and reconcile thread information. core/src/state_db_bridge.rs is just a small adapter so core code can start this service without depending directly on rollout internals.

If startup hits database corruption or file locking problems, state/src/runtime/recovery.rs and cli/src/state_db_recovery.rs detect the issue, back up damaged files, rebuild when possible, and show clear recovery guidance in the interactive interface.

## [Backend clients, remote catalogs, and startup refreshes](stage-7.md) `stage-7` — 22 files

This stage is the system’s “stock up before opening” step. After sign-in and basic settings are ready, it reaches out to outside services and local model servers to collect the facts the app needs before it can show rich choices or safely start extra features.

The cloud-config files fetch a packaged set of server-controlled settings, check that it is valid, cache it on disk, and keep it fresh in the background. The model files do the same kind of work for model catalogs: they call remote “/models” endpoints, adapt provider-specific catalogs such as Amazon Bedrock, and turn raw model lists into the ready-to-pick presets the UI uses. For open-source and local setups, the Ollama and LM Studio code checks whether the local server is reachable, whether required models exist, and starts downloads or loading when needed.

Connector and plugin discovery is another part of this stage. Connectors are fetched, cleaned up, merged from several sources, and filtered so the app knows what external tools are available. Startup plugin sync copies a curated plugin snapshot locally. A few smaller pieces round this out: workspace settings decide if plugins are allowed, rate-limit checks can block memory-writing work, and update checks refresh cached version information.

## [Transport and server runtime initialization](stage-8.md) `stage-8` — 40 files

This stage is part of startup for any mode that acts like a server. Its job is to open the “roads” that messages will travel on, so requests and notifications can move between the app and other programs. In this system, many of those messages use JSON-RPC, which is a simple format for sending commands and getting replies.

One part brings up the main app server and its daemon, a background helper process. It can start the server, reconnect to one that is already running, and expose ways to talk to it over standard input/output, local machine sockets, or WebSockets. It also sets up remote-control features, keeps track of connected clients, and makes sure replies go back to the right place.

The other part starts sidecar servers and bridges. These are helper services that let outside tools connect through child processes, local sockets, HTTP, SOCKS, WebSocket, or MCP. Together, these pieces act like adapters on a power strip: different plug shapes on the outside, but all feeding into the same running server and message flow.

### [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files

This stage is the system’s bring-up and connection layer. It sits near startup and makes sure the app server can be launched, reached, and talked to, whether it runs as a background daemon, inside the same process, or over sockets and websockets.

On the daemon side, app-server-daemon/src/lib.rs is the foreman. It decides how to start or reconnect to the server, checks if it is ready, and switches remote-control mode on or off. The backend files define and implement the PID-file method, which uses a small file containing a process ID to find, validate, stop, or clean up detached processes. The daemon’s client speaks JSON-RPC, a request/response message format, over the control socket to probe the server, while the doctor check inspects state without disturbing anything.

Inside the server, app-server/src/lib.rs starts the runtime, transports, and shutdown path. Transport files wire up stdio, Unix sockets, and websockets, including authentication rules. Initialization and outgoing-message code turn raw connections into usable client sessions and route replies and notifications correctly. Remote-control files add enrollment, reconnect, and message tracking. Finally, shared client facades let the CLI and TUI talk to the server through one consistent API.

### [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

This stage is the system’s “side entrance” layer. Instead of doing the main job itself, it starts helper servers and bridges that let other programs talk to Codex over standard protocols such as JSON-RPC, HTTP, WebSocket, SOCKS, and Unix domain sockets (local machine-only sockets).

The exec-server files are the main hub. `lib.rs` exposes the public pieces. `connection.rs`, `server/transport.rs`, and `client_transport.rs` open and manage links over stdio, WebSocket, or child processes. `client.rs` gives a higher-level client that tracks sessions, routes messages, and reconnects when needed.

The Noise relay files add a secure relay path. `noise_relay/mod.rs` provides shared rules, `harness.rs` adapts a rendezvous WebSocket into an encrypted JSON-RPC connection, `executor_stream.rs` runs one executor-side stream, and `remote.rs` registers remote environments and checks whether a connecting key is allowed.

The MCP and proxy pieces build specialized sidecars on top. `runtime.rs`, `stdio_server_launcher.rs`, `rmcp_client.rs`, and `mcp-server/src/lib.rs` launch and run MCP servers. `stdio-to-uds` bridges stdin/stdout to a local socket. `responses-api-proxy` forwards one HTTP API safely. `network-proxy` and `socks5.rs` run the HTTP and SOCKS proxy services.

## [Frontend session startup and user-facing initialization](stage-9.md) `stage-9` — 41 files

This stage is where the prepared backend finally becomes something a person can use. It sits at the handoff between setup and real work. Its job is to open the right kind of session, connect it to the already-started services, and make the user-facing surface ready.

One branch is the interactive terminal app, or TUI (text user interface). That startup path claims control of the terminal window, checks what the terminal can do, switches into the app’s full-screen style, and protects the screen from stray output. It also handles suspend and resume, window titles, alerts, and resizing. Before dropping the user into the main screen, it may run onboarding steps such as welcome, sign-in, provider choice, trust for the current folder, updates, migrations, imports, or choosing a past session to continue. Then it prepares the first visible chat widgets and status views.

The other branch is exec mode, the non-interactive “do one job and exit” path. It builds a session from command-line options, starts the same core services, restores session context if needed, runs the request-processing loop, and prints or saves the final result. Together, these paths turn backend machinery into a ready interface.

### [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files

This stage is the “getting settled in” part of the terminal app. It runs before the main chat experience really begins, and it makes sure the program, the terminal window, and the user are all ready. Think of it like opening a cockpit, checking the switches, and asking a few setup questions before takeoff.

The top-level startup code in lib.rs and app.rs loads settings, connects to the background app-server, chooses terminal features, and starts the main screen. tui.rs, custom_terminal.rs, terminal_probe.rs, keyboard_modes.rs, terminal_stderr.rs, job_control.rs, notifications, terminal_title.rs, resize_reflow_cap.rs, and doctor/title.rs deal with “terminal ownership”: they test what the terminal can do, switch into the special full-screen mode, protect the display from stray output, support suspend/resume, and choose how titles and desktop alerts are sent.

Several prompts may appear before normal use: provider selection, hook review, update and model migration prompts, working-directory choice, external agent import, and session resume picking. The onboarding files guide first-time users through welcome, sign-in, and trusting the current folder. Chat widget startup helpers, tooltip selection, session history cards, collaboration mode choices, status previews, and pet setup prepare the first visible interface once startup is complete.

### [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

This stage is the startup and run-to-finish path for non-interactive use: when the system is asked to do one job, complete it, and exit, instead of opening a full interactive screen. You can think of it as the “single-trip” route.

The main driver is exec/src/lib.rs. It takes the command-line settings the user gave, turns them into a working session configuration, starts the app server inside the same process, builds the request or prompt that should be sent, runs the event loop (the repeating cycle that processes messages and progress), and finally prints or saves the result. It also includes small adapter code that translates shared system settings into the exact shapes this exec mode expects.

Before some runs can start, tui/src/session_resume.rs helps recover the right saved-session details. It figures out key facts like which thread to continue, which folder should count as the working directory, and which model to use. It prefers stored database metadata, but can fall back to reading JSONL log files if needed. If the saved folder and current folder do not match, it asks the user which one to trust. Together, these parts make sure scripted runs start with the right context and finish cleanly.

## [Main event loop and request dispatch](stage-10.md) `stage-10` — 137 files

This stage is the system’s steady working rhythm. After startup, it stays in a loop: it waits for something to happen, figures out what kind of thing it is, and sends it to the right part of the program. You can think of it as a busy front desk that receives phone calls, walk-ins, and internal messages, then directs each one correctly.

The interactive event dispatch side handles live terminal activity. It gathers raw user input and screen update signals, turns them into meaningful app actions, and routes them to the right conversation, popup, or editor area.

The RPC request routing side does the same for JSON-RPC messages, a standard text-based request-and-response protocol. It checks incoming commands, chooses the right feature area, and makes sure replies and follow-up events go back out correctly. The exec server’s processor file is one concrete connection driver for that message flow.

Behind that, session handlers in the core turn decoded operations into real state changes, background tasks, saved data, and outgoing events. Request serialization keeps conflicting requests for the same resource in safe order. Tool parallelism decides which tool calls may run together and which must run alone, while also handling cancellation cleanly.

### [Interactive event dispatch](stage-10.1.md) `stage-10.1` — 96 files

This stage is the terminal app’s live switchboard during normal use. After startup, while the user is typing, clicking through popups, switching conversations, and receiving backend updates, this is the part that catches each event and sends it to the right place.

At the bottom, `event_stream.rs` is the shared input broker: it gathers raw terminal events such as key presses, paste bursts, and redraw nudges into one common event stream the app can read. From there, app-level dispatch acts like traffic control. It interprets app-wide shortcuts, redraw requests, server messages, and background-task results, and routes them to the correct conversation thread or screen.

The bottom-pane composer and popup layer handle what the user is actively editing: normal message text, slash commands, “@” mention search, temporary overlays, and requests for extra user input. The chat widget then turns those interactions into concrete actions like sending a message, opening a command flow, restoring a draft, or showing warnings and approvals from the backend. Around that, smaller helper flows provide pickers, previews, imports, clipboard support, and platform-specific behavior. Together, these parts make the interface feel responsive and organized instead of chaotic.

#### [App-level event dispatch and thread routing](stage-10.1.1.md) `stage-10.1.1` — 10 files

This stage is the traffic-control center of the text user interface. It sits in the app’s main work loop. Its job is to take input from many places—keyboard shortcuts, server messages, and background tasks—and send each one to the right part of the app, especially the right conversation thread.

At the center, event_dispatch.rs is the main switchboard. It reads queued app events and decides what should happen next: update the screen, call the server, save settings, switch threads, or exit. app_event_sender.rs makes it easy for other UI code to submit those events and commands in a consistent way. app_command.rs defines that command language.

input.rs handles app-wide key presses before they reach the chat area, like global shortcuts or opening an external editor. frame_requester.rs asks for redraws without overloading the screen refresh rate.

On the server side, app_server_events.rs translates incoming server events into UI actions, while app_server_requests.rs keeps track of requests that need a later user answer. thread_routing.rs manages per-thread state, buffering and replaying events when the user switches threads. pending_interactive_replay.rs makes sure only still-unanswered prompts are replayed. background_requests.rs sends slow network or disk work off to helper tasks, then reports results back as app events.

#### [Bottom-pane composer, popups, and mention input](stage-10.1.2.md) `stage-10.1.2` — 42 files

This stage is the terminal app’s “conversation workbench” at the bottom of the screen. It is part of the main work loop: while the app is running, this is where the user types, picks options, and answers prompts. The core pieces are the bottom-pane host and its shared view contract, which let the app swap between the normal chat composer and temporary popup or modal views while keeping input, drawing, canceling, and timed updates consistent.

At the center is the chat composer. Its textarea edits text, supports optional Vim-style editing, remembers draft state, attachments, footer messages, and popup ownership, and uses paste-burst detection to notice when text was likely pasted instead of typed. History search lets users recall old inputs. Slash-command helpers parse commands like “/name …”, define which commands exist, and drive the command popup and inline completion.

For “@” mentions, the system builds a catalog of skills, plugins, and file matches, filters it by query and mode, and shows either the newer unified mentions popup or older specialized popups. Reusable list and multi-select widgets power settings flows such as title setup, status line setup, skills, memories, hooks, feedback, app-link prompts, custom text entry, and server requests.

#### [Chat widget interaction and command flows](stage-10.1.3.md) `stage-10.1.3` — 23 files

This stage is the chat screen’s “control center.” It sits in the main work loop of the app: after startup, while the user is actively chatting, choosing actions, and seeing live updates from the backend.

The heart of it is chatwidget.rs, which keeps the chat screen’s state and ties everything together. interaction.rs listens for keys, paste, copy, rename, quit, and submit actions. rendering.rs draws the visible chat area, notices, and bottom input pane. input_submission.rs turns what the user typed into a real message or command request, while input_flow.rs decides whether to send it now or queue it for later. input_queue.rs and input_restore.rs keep drafts and follow-up inputs safe so they can be restored after interruptions.

slash_dispatch.rs is the traffic director for slash commands like /usage, /goal, or /ide. protocol.rs and protocol_requests.rs translate backend events and requests into concrete screen updates, approvals, warnings, and shutdown prompts. The remaining files build special flows: notifications, skills and app mentions, hooks, connectors, model and review popups, plan follow-ups, reasoning shortcuts, and the usage/token screens. Together, they make the chat widget feel responsive, stateful, and guided.

#### [Specialized interactive flows and auxiliary TUI handlers](stage-10.1.4.md) `stage-10.1.4` — 20 files

This stage covers the smaller interactive tools that sit beside the app’s main event loop. They are not the core chat engine, but they make the terminal interface feel complete: picking options, previewing history, editing shortcuts, importing outside settings, and showing extra visual aids.

One group powers the cloud tasks screen. `cloud-tasks/src/app.rs` and `cloud-tasks/src/new_task.rs` store what the screen currently knows, such as task lists, overlays, and the new-task form. `cloud-tasks/src/ui.rs` turns that state into the actual terminal display.

Another group manages special pickers and overlays. The backtracking and pager files let users browse old transcript output, preview rollback, and confirm trimming history. The multi-agent files keep track of selectable agents and format them into labels and history entries. Theme, pets, and keymap files build guided selection flows, live previews, and editing steps. Pet files also load and animate the small on-screen companion.

Finally, helper files connect the terminal app to the outside world. Clipboard helpers import pasted images and clean up pasted text. External import flow guides users through bringing in settings from another tool. Platform helpers isolate operating-system-specific behavior.

### [RPC request routing](stage-10.2.md) `stage-10.2` — 37 files

This stage is the system’s switchboard. It sits in the main work loop and takes incoming requests from clients or other servers, checks that they are valid for the current connection, and sends each one to the right worker.

At the app server, message_processor.rs is the traffic controller. It builds the specialized processors and routes JSON-RPC messages, which are request-and-response messages sent as JSON text. The request processor files each cover one area: threads and turns drive conversations; thread goals and deletion manage thread state; catalog, models, plugins, marketplace, search, feedback, git, filesystem, remote control, Windows sandbox, environments, and external-agent import each expose a focused feature. Shared helpers normalize inputs and turn failures into clear protocol errors. fs_watch.rs and dynamic_tools.rs handle special follow-up events across requests.

In the core, the tool router and registry decide which tools a model may call and then execute them safely.

Other servers do the same kind of routing for their own world: exec-server dispatches process, file, and HTTP methods; mcp-server routes MCP requests and runs Codex-backed tool calls; rmcp-client handles elicitation prompts; the HTTP proxy routes network traffic under policy rules.

## [Thread and session orchestration](stage-11.md) `stage-11` — 44 files

This stage is the traffic control center for conversations. It sits in the system’s main working life: when a user starts a chat, comes back to an old one, branches into a side conversation, or keeps a long-running session alive, this is the layer that makes sure the right thread is loaded and the right session object is driving it.

At the core, the thread manager keeps a registry of live threads and knows how to create, resume, fork, archive, and shut them down. A CodexThread is the per-thread handle that outside code uses, while the session modules build the long-lived session itself: startup settings, event delivery, history, approvals, task scheduling, queued inputs, and shared services/state that survive across turns. Environment selection prepares the execution environment snapshot each thread needs.

Persistence pieces reconnect live threads to saved rollout history, trim that history when needed, and keep thread metadata in sync. API entry files expose these abilities cleanly to other crates.

Around that core, servers and UI layers use the same machinery to track loaded sessions, stream thread events, switch between threads, refresh shared connections, and support extras like goals, skills, side threads, and external-session import.

## [Prompt, context, and extension assembly](stage-12.md) `stage-12` — 74 files

This stage is the briefing builder that runs right before the model is asked to do work. Its job is to gather everything the model needs to know for the next turn and turn it into the exact input text and message structure the model will see.

One part provides the raw materials and the standard shapes. It stores built-in instruction text, defines what a context “fragment” is—a small piece of information that can be turned into model-ready text—and gives both core code and extensions a safe way to contribute those pieces.

Another part supplies the actual fragments and prompt assets. These include fixed instruction sheets plus live details such as environment facts, token budget (how much prompt space is left), command results, warnings, and compatibility support for older saved sessions.

A third part gathers extra guidance from many sources: user and project instructions, skills, plugins, apps/connectors, memories, goals, review rules, IDE hints, and permission limits.

Finally, turn assembly pulls in conversation history, cleans and trims it, adds what changed since the last turn, and packs everything into one final prompt, including special handling for realtime and debugging views.

### [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files

This stage is shared behind-the-scenes support for building the text the model sees before it answers. Think of it as the parts shelf and front desk for prompts: it stores built-in instruction text, defines the shapes of reusable context pieces, and gives the rest of the system simple entry points to fetch them.

The embedded instruction sources are `collaboration-mode-templates/src/lib.rs`, which keeps the built-in collaboration instructions as fixed strings inside the program, and `codex-home/src/lib.rs`, which exposes the main way to obtain home or user instruction content. `prompts/src/lib.rs` is the public doorway to the prompts crate, gathering prompt-related constants, types, and helpers in one place.

The context side is centered on `context-fragments/src/fragment.rs`, which defines what a “fragment” is: a small chunk of context that can be rendered into text and converted into the message format the model expects. `context-fragments/src/lib.rs` exposes that fragment system as a stable API. `ext/extension-api/src/contributors/prompt.rs` gives extensions a simple fragment type so they can add content to the right slot. Finally, `core/src/context/mod.rs` and `core/src/context/permissions_instructions.rs` re-export these shared pieces so core prompt assembly can use them consistently.

### [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files

This stage is shared behind-the-scenes support. It defines the raw building blocks that later stages use to assemble the exact text shown to the model. Think of it as a box of labeled parts: some files store fixed instruction sheets, and others turn live system facts into well-shaped message pieces.

The prompt files in prompts/src are the fixed sheets. They embed built-in instructions for agent coordination, the apply_patch editing tool, compact summaries, and realtime mode, including start and end text.

The context files create structured fragments that can be dropped into a conversation. Some describe the world around the model, such as environment details, remaining token budget (the amount of prompt space left), saved command or network rules, model-switch guidance, interruption notices, and shell-command results. Others carry outside instructions, like AGENTS.md rules, skill instructions, available skills, hook-provided text, extra key/value context, internal hidden context, and subagent status updates.

Several files also preserve compatibility with older saved sessions by recognizing legacy warning formats. Together, these pieces give later prompt-assembly code a consistent, reusable vocabulary for building model input.

### [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files

This stage gathers all the “extra instructions” the model should see before it answers. It is shared support for the main work loop: a prompt-building layer that pulls in rules, context, and reminders from many places and turns them into one clear package.

Some parts load instruction text from outside the code. User-wide instructions come from the Codex home folder, while project instructions come from files like AGENTS.md. Other files add situation-based guidance: collaboration mode rules, a requested personality or speaking style, image-generation notes, terminal display advice, IDE context, and the current permission limits such as file access or network access.

Another group teaches the model what optional helpers exist. Skills code finds skills the user mentioned, loads their SKILL.md files, and also renders a compact “available skills” catalog. Similar pieces describe apps/connectors and plugins, and can inject extra hints when a specific plugin was named.

The remaining parts add longer-term guidance. Memories point the model to saved notes and summaries. Goal prompts steer ongoing objectives and budget limits. Review prompts build the exact instructions for code review flows and how to exit them cleanly. Together, these pieces act like editors assembling a briefing packet before the model speaks.

### [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

This stage builds the exact package of information the model sees for the next reply. It sits in the main work loop: after the system knows the current session state, but before it asks the model to answer. Think of it as preparing a clean briefing folder.

Turn context starts by freezing all the moving settings for one turn into a stable snapshot: model choice, permissions, environment, services, and more. History management then gathers the conversation so far, fixes broken or malformed entries, trims oversized tool output, and keeps important pairs such as a tool call and its result together. Another piece spots “contextual” user messages that are really internal instructions, not ordinary chat text.

From there, update builders create short messages that tell the model what changed since last turn, such as permissions or collaboration mode. Additional context and token-budget logic add only meaningful incremental notes, avoiding repeats. For realtime sessions, separate code builds a compact startup summary and chooses the prompt template. A debug helper can assemble this whole prompt path for inspection without running a full session. Web search uses a smaller, text-only history view.

## [Turn execution and model interaction](stage-13.md) `stage-13` — 88 files

This stage is the heart of a single conversation turn: one cycle where the system takes new input, decides what context to keep, asks a model for help, runs any needed code or tools, and saves the results. If the whole app is a conversation engine, this is the main piston moving up and down.

core/src/tasks/regular.rs starts a normal turn and keeps looping until there is no leftover work. The heavy lifting happens in core/src/session/turn.rs, which drives the full turn from start to finish: it checks whether old chat history should be compacted, processes hooks and inputs, prepares tools and skills, streams model output, handles retries, and finishes the bookkeeping.

Compaction files shrink long history so later requests stay manageable. core/src/compact.rs does this locally, while core/src/compact_remote.rs and core/src/tasks/compact.rs can ask the model provider to do it instead and record which path was used.

turn_metadata.rs adds extra facts sent with each request, such as session identity and workspace details. Model transport execution is the delivery system that sends requests and receives streamed answers. Streaming reduction and UI projection turns those raw incoming events into the live text and status updates the user sees. The code-mode runtime files run embedded JavaScript safely in a separate V8 engine, including module loading and simple timers, so tool-style code can participate in the turn.

### [Model transport execution](stage-13.1.md) `stage-13.1` — 28 files

This stage is the system’s “send the request out and bring the answer back” layer. It sits in the main work of talking to model providers, with some startup help so the first request can be faster. Think of it as the shipping department: it packs requests, chooses a route, watches the trip, and unpacks replies.

At the center, core/src/client.rs runs client sessions and turns. It builds requests, picks HTTP, server-sent events (a one-way live stream), WebSocket (a two-way live connection), compact-history, memory, image, search, or realtime routes, and records telemetry. Shared request pieces live in client_common.rs, responses_metadata.rs, requests/responses.rs, and tools/src/responses_api.rs, which shape prompts, metadata, compression options, and tool descriptions into the wire format.

The endpoint files are the concrete couriers for each API. The SSE and WebSocket response files decode streamed events into internal messages. api_bridge.rs turns transport and HTTP failures into clear public errors. responses_retry.rs retries dropped streams and can fall back from WebSocket to HTTP.

For faster startup, session_startup_prewarm.rs prepares a model session early. For live conversations, the realtime websocket modules, realtime_call.rs, realtime_conversation.rs, and the WebRTC crate manage long-lived audio/text sessions across protocol versions.

### [Streaming reduction and UI projection](stage-13.2.md) `stage-13.2` — 51 files

This stage is the “live translator” between raw incoming events and what the person using the terminal actually sees. It sits in the main work loop while the assistant is answering, tools are running, and status is changing.

First, stream parsers pull meaning out of partial text as it arrives. They strip hidden citation tags, extract proposed plans, and keep normal assistant text visible. Markdown helpers then turn that text into terminal-ready formatting, with special care for tables: if a table is still incomplete, table holdback waits before “locking in” rows, and wide tables can fall back to a stacked key/value view.

The streaming controller, chunking policy, and commit tick decide when enough text is stable to move from a live tail into permanent transcript history. History-cell modules are the display building blocks for each transcript item: messages, plans, approvals, command output, hooks, searches, notices, patches, and more.

Around that, ChatWidget state and lifecycle code keep track of the current turn, running commands, hooks, footer status, and transcript bookkeeping. Reflow and consolidation code rebuild the transcript cleanly after resizing. Supporting renderers handle highlighting, diffs, status cards, token usage, rate limits, and background exec output so the whole UI stays readable and up to date.

## [Tool execution, approvals, and guarded side effects](stage-14.md) `stage-14` — 294 files

This stage is the system’s action center in the main work loop. It wakes up when the model stops talking and asks to do something real, like run a command, edit files, search the web, or call an outside service. Its job is to turn that request into a safe, approved action and then turn the result back into something the conversation can use.

First, the approval, guardian, and hook parts act like checkpoints. They standardize requests, apply safety rules, ask the user when needed, run extra reviews, and let external helper programs weigh in. Next, the execution backends are the engine room that actually runs shell commands, patches, and other tasks inside the right sandbox, meaning a restricted environment.

Extension and integration tools add the wider world: MCP, a standard way to talk to external tool servers, plus plugins, connectors, web, image, memory, skills, and code-mode tools. Shared support pieces build sandbox rules and inspect commands to spot safe, risky, or dangerous patterns.

The direct files provide the common language for tools: schemas describe inputs, adapters translate MCP tools, executors define how tools run and whether they are visible, handlers share parsing helpers, and error types separate ordinary tool failures from serious runtime breakdowns.

### [Approval, guardian, and hook mediation](stage-14.1.md) `stage-14.1` — 63 files

This stage is the system’s checkpoint and referee. It sits mostly in the main work loop, whenever the agent wants to do something with real effects, like run a command, edit files, or use the network. Its job is to decide whether to allow that action, ask first, run an extra review, let custom hook programs weigh in, and then enforce the final answer.

The permission-ingress pieces are the front door. They take approval or user-input requests from tools and integrations, clean them up, and turn them into one standard form. The approval-policy engines are the rulebook: they read saved rules and current safety settings, then decide allow, ask, or block.

If a request needs a second opinion, the guardian review session takes over. It prepares a focused review prompt, opens a tightly controlled side session, and returns a structured decision.

Hook mediation adds another checkpoint. Hooks are external helper programs. The system discovers them, runs the right ones for each event, and merges their replies into a stop, continue, or modify-context result.

Finally, the approval UI and orchestration show choices to the user and carry decisions into tool execution, while enforcement runtimes make those decisions real in network proxies and Windows sandbox protections.

#### [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files

This stage is the system’s decision desk. It sits in the main work path whenever the agent wants to run a command, change files with a patch, use the network, or loosen sandbox limits. Its job is to answer: can this go ahead automatically, does it need the user’s approval, or must it be blocked?

The execpolicy files are the modern rule engine. The parser reads policy files written in Starlark, a small configuration language, and turns them into internal rules. The rule and policy code define what those rules mean, such as matching command prefixes or normalizing network hosts so “the same place” is recognized consistently. The crate root ties those pieces into one public interface. core/src/exec_policy.rs uses that engine at runtime, combining saved rules, sandbox state, and approval settings into a final decision.

Other core files apply the same idea to nearby cases. sandboxing.rs provides shared approval and sandbox building blocks. network_policy_decision.rs translates network blocks and user approvals into messages and rule updates. safety.rs decides whether apply_patch can proceed.

The execpolicy-legacy files keep the older rule system working: they parse old policies, match programs and arguments, and do a final safety check on file paths and executable selection.

#### [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files

This stage is the system’s “second opinion” step. It runs when an action needs approval, before the main work can continue. Its job is to turn a raw approval event into a careful review, run that review in a controlled side session, and report the result back.

At the base, core/src/guardian/mod.rs defines the shared building blocks for this subsystem and includes a circuit breaker, a safety stop that cuts off a turn after too many automatic denials. core/src/guardian/approval_request.rs takes an approval request and translates it into the different shapes the rest of the system needs: JSON data, analytics records, and readable prompt text.

Next, core/src/guardian/prompt.rs prepares the reviewer’s prompt by combining the request with useful session history, trimming away extra transcript text, and then reading the reviewer’s structured JSON answer back into internal types. core/src/session/review.rs opens a special nested review turn inside the current session with tighter limits and a review-specific setup.

Under that, core/src/guardian/review_session.rs runs and reuses these nested review sessions efficiently. Finally, core/src/guardian/review.rs is the conductor: it routes requests, launches reviews, retries when needed, records metrics and rejections, publishes events, and applies the circuit breaker.

#### [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files

This stage is the system’s hook runner: the part that lets outside commands step in at key moments and say “stop,” “go on,” “block this,” or “add this extra context.” It sits in the main work flow and also around start and stop moments, acting like a checkpoint desk between the session and any custom hook programs.

The top-level registry and engine build the available hooks from configuration, plugins, and older legacy settings. Discovery finds which hooks exist and whether they are enabled. The dispatcher then picks the right ones for a specific event and runs them, sometimes in parallel, while keeping results in a predictable order. The command runner actually launches the hook programs and captures their output. If that output is too large, output spilling saves the full text to a temporary file and keeps only a trimmed version in memory.

Each event file knows one situation in detail: session start, user prompt submission, before or after tool use, permission requests, compaction, and stopping. These files turn live data into JSON, read the hook responses, and merge several answers into one final decision. The runtime adapter connects all of this to sessions and turn handling, and the legacy notifier keeps older hook commands working.

#### [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files

This stage is the system’s front desk for “please ask before doing this” moments. It sits between outside callers and the deeper approval machinery. Its job is to take requests coming from tools or MCP integrations, clean them up into a standard shape, and pass them on for a user or reviewer decision.

The two tool handlers are direct entry points. request_permissions.rs receives a request for extra permissions, interprets it in the current execution environment, standardizes the requested permission sets, and sends it into the session for approval. request_user_input.rs does the same kind of intake work for general user questions, checking that the call is valid, normalizing the arguments, and returning the answer in a serialized form, meaning plain text structured so programs can read it reliably.

The MCP side does similar work for integrations. elicitation.rs keeps track of outstanding requests and applies policy rules so some can be auto-approved or auto-denied, while others are surfaced as events for human review. exec_approval.rs and patch_approval.rs create those MCP requests for command execution and code changes, then translate the reply back into the system’s internal approval operations.

#### [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files

This stage is the system’s “ask before acting” layer. It sits in the main work loop, between a tool wanting to do something and the system actually doing it. Its job is to make risky actions visible, collect the user’s decision, and then carry that decision through to execution.

At the center is the tool orchestrator, which runs a tool step by step: check whether approval is needed, choose a sandbox (a safety boundary that limits what code can touch), register any network approval, try the action, and retry with broader permissions if the rules allow it. For connector-based tools, approval templates turn raw requests into clear prompts with human-friendly parameter names.

On the screen side, approval events reshape server messages into UI-friendly forms. The approval overlay shows concrete choices for command, patch, permission, and connector prompts. The request-user-input overlay handles longer question flows with options and notes. Tool-request UI ties everything into the chat area, status messages, and final decision records. Permission popups, profile menus, and Windows sandbox prompts guide users through access choices. Pending-approval and recent-denial views make sure unanswered or blocked actions do not disappear. Hook RPC support fetches hook details and saves trust decisions.

#### [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files

This stage is the “rules are enforced for real” part of the system. It sits in the main execution path and in platform setup. Earlier stages decide what should be allowed; these pieces turn those decisions into live behavior while tools are running.

The network-proxy crate is the shell that assembles the proxy subsystem and exposes the parts other code uses. Inside it, state.rs takes raw network rules and turns them into a checked runtime form the proxy can use safely. network_policy.rs defines the question-and-answer format for policy decisions, asks for a decision asynchronously, and records audit events about what happened. runtime.rs is the live engine: it keeps the current allow and deny rules, optional MITM state (where traffic is inspected by the proxy), buffered blocked requests, and the logic used by both HTTP and SOCKS traffic.

On the approval side, network_approval.rs manages user or guardian approval for tool network access. It avoids asking the same question twice, remembers session decisions, and turns blocked proxy events into tool-facing errors.

For Windows, the sandbox files apply operating-system protections. windows_sandbox_read_grants.rs safely adds extra readable folders. deny_read_state.rs remembers persistent “no read” permissions. workspace_acl.rs locks down sensitive workspace folders. wfp.rs installs Windows network blocking filters, and wfp_setup.rs does that setup carefully so failures are logged and measured without stopping the rest of startup.

### [Execution backends and sandboxed command runtimes](stage-14.2.md) `stage-14.2` — 91 files

This stage is the system’s command engine room. It sits in the main work path whenever the app needs to run something: a shell command, an interactive terminal session, a file-changing patch, or a sandboxed helper. Its job is to turn “please run this” into a real process, while keeping it safe, controllable, and portable across machines and operating systems.

One part is the front door. It accepts requests from the app server, text interface, and built-in tools, checks rules, chooses a backend, and starts or stops commands. Under that is the session machinery, which keeps interactive runs alive, sends input, collects output, and makes local, remote, terminal-style, and simple pipe-based runs look like one consistent system.

Other parts add special paths. The patch engine applies text edits through the same approval and runtime flow. The Unix sandbox layer chooses and launches locked-down processes, and can support controlled privilege escalation when a shell task needs more access. The exec-server filesystem services provide safe file reads and writes, locally, in a sandbox, or through another server. On Windows, a separate sandbox launcher builds restricted identities and starts protected processes. The sleep tool is a tiny timed command in this same runtime world.

#### [Execution-facing app-server and core command orchestration](stage-14.2.1.md) `stage-14.2.1` — 15 files

This stage is the system’s “run a command” doorway. It sits in the main work of the app, taking requests from the app server, the text interface, and built-in tools, then turning them into real processes that can be started, fed input, resized, watched, and stopped.

On the app-server side, command_exec_processor.rs and process_exec_processor.rs receive JSON-RPC requests, which are network-style messages, and translate them into running command sessions. command_exec.rs keeps those sessions alive, tracks which connection owns which process, streams output back, and delivers the final result.

On the TUI side, workspace_command.rs gives the interface a simple way to run short workspace commands, while fs.rs adds helper calls for file-related server requests.

In core, sandboxing/mod.rs shapes execution requests after sandbox decisions, and exec.rs is the safe runner that actually launches a child process and reports success, timeout, cancellation, or sandbox blocking. user_shell.rs powers the /shell task. The shell and unified-exec handler and runtime files are the traffic directors: they check permissions, choose shell mode and backend, prepare requests, optionally use the Unix zsh-fork path, and hand everything off for execution.

#### [Unified-exec sessions and PTY/process backends](stage-14.2.2.md) `stage-14.2.2` — 17 files

This stage is the engine room for interactive command sessions. It sits below the user-facing tools and does the hard work of starting a command, talking to it while it runs, collecting its output, and stopping it cleanly. Think of it as the plumbing that makes a shell session feel continuous whether the process is local, remote, in a real terminal, or just using simple input and output pipes.

At the center, the unified-exec module defines the shared request types, small helper pieces, and the common error format. The process wrapper represents one running command and gives higher layers one consistent view of its state, output, and shutdown behavior. The process manager is the traffic controller: it assigns IDs, launches commands, stores live sessions, forwards input, polls output, and cleans up. The write_stdin tool is the doorway for sending keystrokes or polling interactive sessions.

Underneath, spawn.rs is the boundary to the operating system, applying sandbox and environment settings before launch. The exec-server files define a common process contract plus local and remote backends. The PTY utilities provide the actual terminal-style or pipe-style process implementations, with Unix process-group helpers and Windows ConPTY support so the same session model works across platforms.

#### [Patch application engine and patch-execution adapters](stage-14.2.3.md) `stage-14.2.3` — 9 files

This stage is the system’s “edit installer.” It takes a text patch — a recipe that says which lines to add, remove, or change — checks that it is well formed and safe, and then carries it out through the normal tool and approval machinery. It sits in the main work path when the system needs to change files.

The apply-patch library does the core job. Its parser and streaming parser read patch text, even as it arrives piece by piece, and turn it into structured change blocks. The invocation code also understands command-style forms, including shell wrappers, and checks them against the current files. The library then computes the replacements, updates the filesystem, produces diff output, and keeps track of what succeeded if a later step fails.

Around that engine are adapters. The tool spec describes what the apply_patch command is allowed to look like. The tool handler parses requests, verifies them, derives permissions, emits progress updates, and prepares hook data. The bridge in core decides whether to reject, auto-convert into lower-level file edits, or send the request to runtime, possibly needing approval. The runtime adapter finally executes the vetted operation inside the sandbox. A git helper offers an alternate path using git apply for unified diffs.

#### [Sandbox selection and Unix platform launchers](stage-14.2.4.md) `stage-14.2.4` — 16 files

This stage is the system’s “safe launch” layer for Unix-like systems. It sits between a simple “run this tool” request and the actual process that starts. Its job is to decide what kind of sandbox, or safety cage, should be used, rewrite the request into the right command shape, and, when needed, support a shell flow that can ask for more privileges in a controlled way.

The main entry points in sandboxing/src/lib.rs and manager.rs expose this service and turn high-level requests plus permission rules into platform-specific launch commands. On Linux, bwrap.rs checks whether bubblewrap, the main isolation tool, is usable and when to warn if it is not. landlock.rs in both sandboxing and core builds and applies the argument list for the Linux sandbox helper. Inside linux-sandbox, bwrap.rs defines the actual filesystem restrictions, launcher.rs and bundled_bwrap.rs choose and run the right bubblewrap binary, and landlock.rs keeps an older in-process fallback path.

The shell-escalation files add a Unix client/server protocol so shell commands can be intercepted, approved, denied, or relaunched with higher privileges. Finally, the runtime helpers in core/src/tools/runtimes prepare commands and rewrite shell invocations so all of this works cleanly in real tool launches.

#### [Exec-server filesystem sandbox services](stage-14.2.5.md) `stage-14.2.5` — 6 files

This stage is the exec-server’s file access layer: the part that lets the rest of the system read, inspect, and change files. It sits in the main work of serving requests, but it is also a safety barrier. Think of it like a front desk that decides whether a file job should be done directly, by a locked-down assistant, or by another server.

file_read.rs manages open file-read sessions for each client connection. It keeps track of handles and lets callers read chosen chunks of a file without loading the whole thing at once.

local_file_system.rs is the normal backend for filesystem work on the current machine. It performs reads, writes, listing folders, copying, deleting, and path lookup, and can switch some work to a sandboxed path when needed.

sandboxed_file_system.rs is that safer path. It only accepts operations that are allowed to run in the sandbox and sends them to a helper. fs_helper.rs defines the JSON message format for talking to that helper and also offers an in-process version of the same actions. fs_sandbox.rs launches the helper process with limited permissions and turns its replies back into normal results. remote_file_system.rs provides one more option: forward the same filesystem requests to another exec-server over RPC, a remote procedure call.

#### [Windows sandbox provisioning and process-launch internals](stage-14.2.6.md) `stage-14.2.6` — 27 files

This stage is the Windows-only engine room for running a command inside a sandbox, a locked-down account with tightly controlled access. It sits between setup and the actual program run. First, it makes sure the sandbox identity exists and is still valid. setup.rs and identity.rs manage the on-disk sandbox state, while setup_error.rs records clear failure reports if helper steps go wrong.

Several files build the lock itself. token.rs creates restricted Windows security tokens, and acl.rs, deny_read_acl.rs, audit.rs, hide_users.rs, firewall.rs, and wfp/filter_specs.rs control what the sandbox user can read, write, see, or send over the network. spawn_prep.rs turns requested permissions into concrete launch-ready security settings.

Then the process-launch pieces take over. process.rs, desktop.rs, proc_thread_attr.rs, and conpty/mod.rs assemble the child process, its terminal support, and optional private desktop. stdio_bridge.rs connects that child’s input and output back to the main app.

At the top, lib.rs and unified_exec/mod.rs present one public entry point. They choose between the older direct-launch path in legacy.rs and the newer helper-runner path in elevated.rs, elevated_impl.rs, runner_client.rs, and runner_pipe.rs. The TUI helper lets the user-facing interface pick and diagnose these Windows sandbox modes.

### [Extension and integration tools](stage-14.3.md) `stage-14.3` — 117 files

This stage is the system’s “extra abilities” layer in the main work loop. Once the core program knows what the user is asking for, this stage lets it reach beyond built-in features and use outside services, add-on tools, and app connections.

One part is the MCP runtime. MCP, short for Model Context Protocol, is a standard way to talk to external tool servers during a session. It keeps those connections alive, shows their tools and resources to the model, and manages sign-in, approval, reading data, and sending tool calls.

Another part manages the plugin and connector ecosystem. Think of it as a mix of app store and adapter shelf. It finds installed plugins, reads marketplaces, installs or removes add-ons, and decides which connectors and app integrations are available and allowed.

The extension-backed tool runtimes turn those add-ons into normal tools the model can use. They build the current tool menu and run things like web search, image generation, memories, skills, and code-mode helpers.

Finally, the app-server discovery and search adapters turn raw integration data into browsable app lists and fast file search results for clients. Together, these parts make outside capabilities feel like first-class tools.

#### [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files

This stage is the live “switchboard” for MCP, the Model Context Protocol, which lets the system talk to outside tool and resource servers during a session. It sits in the main work loop: after startup choices are known, it keeps connections alive, exposes usable tools to the model, and routes calls, reads, approvals, and sign-in prompts.

At the edges, ext/mcp and app-server/extensions register MCP-backed extensions and adapt their events into the app-server world. The codex-mcp crate is the core MCP layer: server.rs defines what a configured server looks like, executor_plugin/provider.rs loads server definitions from plugins, codex_apps.rs adds app-specific caching and naming rules, and mcp/mod.rs builds the effective server list and snapshots. connection_manager.rs is the hub that owns active clients, refreshes them, and gathers tools and resources; resource_client.rs gives the rest of the system a stable handle even when the manager is replaced.

On the core side, session/mcp.rs ties MCP into session state, auth_elicitation.rs turns auth failures into user-facing sign-in requests, and mcp_tool_call.rs drives a full tool call from arguments to approval to result. The tool and resource handler files define what MCP tools look like, which ones are exposed, how files are uploaded when needed, and how resource listing and reading are performed. Finally, mcp_skill_dependencies.rs notices when a requested skill needs an MCP server and can help add and authorize it.

#### [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files

This stage is the system’s “app store and adapter hub.” It is mostly behind-the-scenes support, but it also powers the command-line and text UI screens where people browse, install, remove, and share plugins and connectors.

At the center, lib.rs exposes the whole plugin subsystem, while manager.rs coordinates the big jobs: loading installed plugins, reading marketplaces, refreshing caches, and running install or uninstall flows. loader.rs does the lower-level work of turning plugin IDs and marketplace entries into usable capabilities. manifest.rs, marketplace.rs, and provider.rs read plugin and marketplace files from disk and turn them into clean, checked data the rest of the system can trust.

Several files manage marketplace lifecycle: marketplace_add, marketplace_upgrade, marketplace_remove, plus metadata, source, and git helpers. remote.rs, remote_legacy.rs, remote_bundle.rs, and the remote sharing files handle plugins that come from online services, including downloading bundles safely, syncing local caches, and sharing a workspace plugin with others.

The connector side decides which app connectors are discoverable and allowed, using connectors.rs, app_tool_policy.rs, mcp_connector.rs, app_mcp_routing.rs, and plugin_namespace.rs. Finally, discoverable files, mention parsing, install-suggestion tools, plugin_cmd.rs, and the TUI plugin screen present this ecosystem to users and guide them toward relevant installs.

#### [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files

This stage is the “plug-in tools” layer of the system. It sits in the main work loop, between deciding what tools exist for this turn and actually running them. Its job is to expose extra abilities—some built in, some added by extensions—in a safe, model-friendly way.

At the center, spec_plan builds the tool menu for the current turn: what the model can see, and what runtime should receive each call. Several files only describe tools, such as the public schemas for plan updates, new context, code-mode commands, image viewing, job tools, and tool search. Matching handler files do the real work when those tools are called.

Dynamic and extension tool adapters let outside contributors plug into the same runtime. The extension registry keeps track of installed contributors. Tool search builds an index so the model can discover deferred tools later.

Code mode is a small sandboxed JavaScript environment. Its globals and callbacks define what code can do, while the core wrapper turns code execution and waiting into normal tool calls.

The extensions here add concrete abilities: web search, image generation, goal management, memories, and skills. Each one wires configuration, availability, execution, and output formatting together so these features behave like ordinary tools.

#### [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files

This stage is part of the app server’s main working path. Its job is to turn raw integration data into things a client can actually browse and search: a list of available apps and live fuzzy file search results. You can think of it as the translation desk between many data sources and the client-facing API.

On the app-discovery side, accessible.rs builds the list of connectors the user can already use. It removes duplicates, fills in missing bits of information from repeated records, gathers display names from plugins, and figures out install links. filter.rs then applies the product rules: which connectors should be hidden, and which unseen but discoverable ones are worth suggesting. merge.rs combines everything into one sorted app list, joining directory data, plugin findings, and accessible connectors, and creating simple placeholder entries when a plugin knows about an app that the directory does not.

apps_processor.rs is the request handler that serves apps/list. It mixes cached data with freshly fetched data and can answer in two steps: return quickly, then send updates as background work finishes.

fuzzy_file_search.rs handles fast file finding. It supports one-off searches and longer interactive sessions, while limiting work, cancelling outdated searches, and ensuring only the newest results reach the client.

### [Sandbox policy generation and command-safety parsing helpers](stage-14.4.md) `stage-14.4` — 17 files

This stage is shared support for deciding whether a tool command can run freely, needs approval, or must be tightly boxed in. Think of it as the rulebook plus the inspectors. One part builds sandbox rules: policy_transforms.rs takes broad permission requests and turns them into one concrete set of file and network limits, while seatbelt.rs converts those limits into the exact macOS sandbox text used to launch a restricted process. linux-sandbox/build.rs just makes sure Linux sandbox packaging is rebuilt when its bundled sandbox tool changes.

Another part understands command lines. bash.rs and powershell.rs unwrap shell wrappers and normalize commands. parse_command.rs turns messy command text into a simple summary of what the command is trying to do. command_canonicalization.rs makes stable keys so equivalent commands can share approval decisions.

The safety checkers then judge commands. is_safe_command.rs and windows_safe_commands.rs allow a small read-only set. is_dangerous_command.rs and windows_dangerous_commands.rs catch risky patterns like force deletes. powershell_parser.rs runs a helper PowerShell parser process to inspect scripts safely.

Finally, the legacy exec policy files define how argument patterns, option shapes, and exact argument types are described and validated, with sed_command.rs allowing only a tiny safe subset of sed commands.

## [Multi-agent, collaboration, and background workflows](stage-15.md) `stage-15` — 39 files

This stage adds “extra workers” on top of the normal one-turn-at-a-time session flow. It is mostly behind-the-scenes coordination for times when the system needs helper agents, background jobs, or long-running side work.

The agent module is the control desk. It defines agent roles, keeps a live registry of which helper agents exist, resolves names like paths or IDs, and enforces limits such as how many sub-agents can run at once or stay loaded in memory. Spawn and control code creates new agent threads, reloads old ones, routes messages between agents, and formats system-generated status notes so other agents can understand what happened.

The multi-agent tool files are the public controls. They define the commands for spawning, messaging, waiting, resuming, interrupting, listing, and closing agents, plus shared validation so those commands behave consistently. Delegation and review files use the same machinery to run a child conversation for a focused task.

Other parts build on this foundation. Agent jobs spread CSV rows across worker agents and collect results. The memories pipeline runs background extraction and consolidation work at startup. The skills watcher is another background helper, noticing file changes and telling the server when cached skill data must be refreshed.

## [Result persistence, projection, and user-visible state updates](stage-16.md) `stage-16` — 55 files

This stage is the “make it stick and show it” part of the system. After a turn of work produces events, these pieces save the important ones, rebuild the thread’s official history, update metadata like name and status, and push fresh information out to users and other programs.

At the core, rollout policy, stream-event mapping, tool-event helpers, shell-command formatting, and diff tracking decide which raw events become saved history and visible transcript items. Metadata extractors and thread-store files keep the file-based session record and the SQLite state database in sync, including archive, restore, and metadata edits. Reconstruction code can replay saved items later to rebuild a thread or explain startup errors.

On the app-server side, event-mapping and item-builder code translate low-level engine events into client notifications, thread items, summaries, token-usage replays, and live status values like idle or active. Import and resume-redaction handlers cover special cases for outside clients and imported sessions.

Finally, exec and TUI code turn those updates into machine-readable JSON output, transcript/history cells, status lines, goal and rate-limit displays, review text, and other user-facing views.

## [Shutdown, cleanup, and teardown](stage-17.md) `stage-17` — 4 files

This stage is the system’s “ending safely” phase. It runs when a connection, session, or whole process is going away, and its job is to stop work in an orderly way instead of just cutting power.

The connection gate in app-server/src/connection_rpc_gate.rs is like putting a “no new customers” sign on a checkout line. It blocks new RPC handlers—small request-processing jobs—from starting, but lets the ones already in progress finish. It keeps count of active work so shutdown can wait for the right moment.

app-server/src/connection_cleanup.rs then manages the follow-up chores for each connection. It can start cleanup tasks, watch them finish one by one or all together, and cancel any stragglers if shutdown must move on.

core/src/agent/control/legacy.rs handles older agent threads. It closes them, shuts down any child threads they started, and saves the final thread-tree state so the system’s stored records match what really happened.

Finally, app-server-daemon/src/update_loop.rs covers a special shutdown-and-restart path for the daemon. It watches for updater changes, refreshes the installed binary, and restarts the daemon when replacement is needed.

## [Protocol schemas, shared types, and generated contracts](stage-18.md) `stage-18` · (cross-cutting) — 174 files

This stage is the system’s shared contract library. It sits behind the scenes, but almost every part of the product depends on it during startup, normal work, storage, and communication with other services. Its job is to make sure everyone uses the same data shapes and meanings, like one set of official forms used across many offices.

The core shared types provide the common vocabulary: IDs, messages, permissions, errors, config, plugin records, and other basic concepts. The app-server schemas turn that vocabulary into actual request and response formats, including the JSON-RPC wrapper that carries calls and replies, plus versioned protocol definitions for old and new clients.

Generated backend and protobuf contracts connect this system to outside services. They are mostly produced from formal API descriptions, then cleaned up with small hand-written helpers so the rest of the code can use them more easily. Other schema groups define boundaries for public APIs, extensions, hooks, remote execution, tool calls, and trace records. Finally, compile-time macros automatically mark and track experimental API pieces, so new features can be introduced carefully and consistently.

### [Core shared protocol and domain types](stage-18.1.md) `stage-18.1` — 46 files

This stage is the shared vocabulary of the whole system. It sits behind the scenes and gives many different parts the same names, shapes, and rules for data, so they can talk to each other without confusion. Think of it as the common set of forms, labels, and ID cards used everywhere.

Some files define safe identifiers such as sessions, threads, plugins, tools, and agent paths. They keep plain string formats on the wire, but give Rust distinct types so code cannot mix them up by accident. Other files define the main protocol itself: user input, messages and items, session history, approvals, accounts, authentication, capabilities, model metadata, remembered-source citations, command parsing, and dynamic tools. These are the concrete data packets exchanged between runtime code, storage, and clients.

Another group captures policy and decisions: filesystem and network permissions, exec-policy decisions, network-proxy reason codes, and central error types. Shared configuration types, plugin manifests, tool discovery records, skills catalogs, thread-store payloads, and state snapshots round this out. Together, these pieces make sure all crates describe the same real-world concepts in one consistent way.

### [App-server protocol schemas and transport contracts](stage-18.2.md) `stage-18.2` — 43 files

This stage defines the shared “language” that the app server and its clients use to talk. It is mostly behind-the-scenes support, but it is essential during normal operation: every request, reply, notification, and error passes through these contracts.

At the bottom, jsonrpc_lite.rs supplies the basic JSON-RPC message envelope, meaning the standard wrapper around calls and responses. common.rs ties real app actions to those wire messages, while protocol/mod.rs, v1.rs, and the many v2 files organize the actual payload shapes for both the older and newer protocol versions. The v2 modules cover the system’s main topics: threads and turns, items and reviews, accounts, models, apps, permissions, config, plugins, file and process access, command execution, remote control, realtime sessions, and more. Mapper and helper files smooth over naming differences, special serialization rules, and v1-to-v2 compatibility.

Around that core, export.rs, schema_fixtures.rs, and experimental_api.rs generate JSON Schema and TypeScript descriptions so other tools can use the same contract safely. The transport files define how outgoing messages are queued and identified, and error_code.rs makes sure server errors are reported in a consistent format.

### [Generated backend and protobuf contracts](stage-18.3.md) `stage-18.3` — 24 files

This stage is the system’s translation layer. It sits behind the scenes and gives the rest of the code a common language for talking to outside services. Most of it is generated from shared API schemas, which are formal descriptions of request and response shapes, so different programs agree on the same fields and message formats.

The backend OpenAPI files describe the JSON data sent to and from the backend: task summaries and full task records, pull request data, configuration bundles and TOML config fragments, plus account, credit, spend-control, and rate-limit status. The crate root and models module gather these generated pieces into one place. On top of that, backend-client/src/types.rs adds hand-written fixes and helper methods where the backend’s JSON is messy or inconsistent, making it easier for the rest of the code to ask simple questions like “what diff was returned?” or “why was this limited?”

The protobuf files do the same job for binary service messages. The thread-config file defines remote config loading messages and gRPC client/server stubs, while the exec-server relay file defines low-level relay traffic. relay_proto.rs then exposes just the relay types the rest of exec-server needs.

### [API, extension, hook, MCP, and trace schemas](stage-18.4.md) `stage-18.4` — 60 files

This stage is the system’s shared rulebook for many important boundaries outside the core protocol crates. It is mostly behind-the-scenes support. When the system talks to outside clients, extensions, helper processes, or trace storage, these schemas define the exact shape of the data so each side can trust what it receives.

One part defines code-mode protocol types: the standard requests, replies, session IDs, and content formats used when code is run and results are returned. Another part covers the public API surface: request and response bodies, streaming events, WebSocket messages, image and search payloads, and a common error format.

The extension and hook contracts describe how plugins and hook handlers are called, what events they can see, what capabilities they may use, and what their replies must look like. The tool and protocol schemas do the same for tool calls, tool specifications, plan and permission messages, and related shared payloads.

The MCP, exec, and sandbox wire models define cross-process messages for remote execution, event streams, and privilege or sandbox control. Finally, the rollout trace models describe how a run is recorded afterward, including sessions, runtime activity, and references to large stored payloads.

#### [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files

This stage defines the shared “contract” for code mode: the agreed shapes of messages, results, and roles that other parts of the system must follow. It is behind-the-scenes support rather than the main work loop. Think of it as the forms, labels, and job descriptions that let separate components cooperate without guessing.

The crate root in lib.rs ties everything together into one public entry point and publishes the official tool names, so callers refer to the same tools in the same way. description.rs explains what those tools are, especially exec and wait. It builds both human-friendly descriptions and strict machine-readable ones, and can even read a special first-line comment pragma from JavaScript source to pick up exec settings.

runtime.rs defines the actual request and response payloads used when code is run or when a caller waits for work to finish, including pending states and nested tool calls. response.rs defines the content carried in those replies, such as text and images, plus hints about image quality. session.rs defines the longer-lived conversation rules: IDs for code cells, wrappers for started work, and the traits—formal interfaces—that session providers, sessions, and host code must implement.

#### [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files

This stage defines the public “shapes” of data that move into and out of the Codex API. It sits at the boundary of the system: when outside code sends a request, receives a reply, or talks over a network connection, these types describe exactly what that data should look like.

The crate root, lib.rs, is the front desk. It gathers the important public pieces and re-exports them so other parts of the code can use one stable API instead of digging through internal folders.

common.rs provides the shared building blocks used across many endpoints, such as standard request and response formats, controls for text output, and the event messages used during streaming. error.rs defines one common error type so different failure cases—network trouble, bad protocol messages, rate limits, and API-specific problems—can be reported in a consistent way.

The other files cover specific transport styles and features. protocol.rs defines the realtime WebSocket message formats and routes incoming events to the right parser. images.rs describes image generation and editing payloads. search.rs defines the richer search commands and results, from web lookups to weather and finance. Together, these files make the API boundary predictable and safe.

#### [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files

This stage is the public contract layer for extensions and hooks. It is mostly shared support behind the scenes: the rest of the system uses it to tell outside code, “here is what you may do, what data you will receive, and what shape your replies must have.” The goal is stability, so plugin authors can build against these rules without depending on internal details.

The extension API files are the main front door. `lib.rs` and `capabilities/mod.rs` gather the pieces into one public surface. The capability files define small powers the host may give an extension: start a sub-agent, send events outward, or inject extra response items into the current reply, with safe fallback versions when a host does not support them. `contributors.rs` defines the callback interfaces for extensions, while the contributor data files describe the exact event payloads for thread, turn, tool, and MCP configuration changes. `state.rs` gives extensions typed storage slots for saved values, and `user_instructions.rs` defines how startup instructions are loaded.

The hook files do the same job for hooks: declare handlers, name events, define payload and result types, and publish JSON schema documents so other processes can validate messages. A few neighboring files add stable contracts for goal events, memory backends, and TUI IDE context data.

#### [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files

This stage is the shared contract layer for tools: the agreed shapes of messages that different parts of the system send to each other. It sits behind the scenes, not in the main work loop itself, but it makes that loop possible by ensuring everyone speaks the same language.

Several files define the actual payloads. tool_payload.rs describes the kinds of inputs a tool can receive. tool_call.rs wraps that input with extra context such as recent conversation history and places to publish visible output. context.rs then converts tool results into the response formats the rest of the system expects, with response_adapter.rs doing a smaller translation for code mode.

Other files define the model-facing tool specifications: tool_spec.rs builds the JSON descriptions sent to the API, while shell_spec.rs, request_user_input_spec.rs, get_context_remaining_spec.rs, ext/goal/spec.rs, ext/web-search/schema.rs, ext/skills/tools/schema.rs, and mcp-server/codex_tool_config.rs each describe specific tools or schema fragments.

The protocol files cover special shared message types for plans, permission requests, user-input questions, and MCP approval metadata. hook_names.rs keeps tool names stable, and function_tool.rs re-exports a shared error type so failures are reported consistently.

#### [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files

This stage is shared behind-the-scenes support. It defines the exact message shapes that different parts of the system use when they talk to each other across process boundaries. You can think of it as the set of official forms and envelopes for remote control, event streaming, and sandbox or privilege-change requests.

The exec server pieces provide the main contract. client_api.rs describes how a client connects, what transport it uses, and shared defaults like time limits. protocol.rs lists the actual JSON-RPC messages — a standard request/response format — for starting and controlling processes, touching files, checking the environment, and making HTTP requests on the executor side. process_id.rs gives process IDs their own dedicated type so they are not mixed up with ordinary text.

exec_events.rs defines the event stream emitted by codex exec as JSONL, meaning one JSON record per line. That makes long-running work easy to watch as a sequence of typed events.

The last two files cover OS-specific side channels. escalate_protocol.rs defines Unix messages for asking an escalation service whether a command should be allowed or rerouted. ipc_framed.rs does the same for Windows elevated runs, including the byte-level framing used to send spawn, input/output, control, and exit messages safely.

#### [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files

This stage provides shared “record-keeping” models that sit behind the scenes. It is not the code that starts the system or runs the main loop itself. Instead, it defines the common shapes of data that other parts use to describe what happened during a rollout trace, which is a saved record of a run.

In session.rs, the code defines the top-level map of a run. It describes the session, the threads inside it, when work was active, and which Codex turns were running. You can think of it as the table of contents and ownership chart for the trace.

In runtime.rs, the code adds the execution-side details. It models code runs, tool calls, terminal activity, compaction, and links between threads. This explains how visible conversation events led to actual work and side effects.

In payload.rs, the code defines small identifiers and references to large raw files stored separately. Instead of stuffing big requests, responses, or runtime dumps directly into the trace, the reduced model points to them by reference, like labels on boxes in storage. Together, these files make traces compact but still understandable and complete.

### [API annotation macros and compile-time contract support](stage-18.5.md) `stage-18.5` — 1 files

This stage is behind-the-scenes support. It does not do the program’s main work at runtime. Instead, it helps shape the code while the project is being compiled, so the rest of the system can follow shared API rules in a consistent way.

Its one part, codex-experimental-api-macros/src/lib.rs, defines a procedural macro. A procedural macro is a code generator that runs during compilation: you write a simple annotation in source code, and the compiler expands it into extra Rust code for you. Here, the #[derive(ExperimentalApi)] macro is used on types that contain experimental features.

When a developer marks a type this way, the macro creates two kinds of support code. First, it generates runtime checks, so the program can notice when someone tries to use a field or enum choice that is still experimental. Second, it adds inventory registrations, meaning it records these experimental pieces in a shared catalog the program can inspect later. In effect, this stage is like a stamp-and-log system: it labels experimental parts and makes sure they are tracked everywhere automatically.

## [Cross-cutting transport, networking, and client infrastructure](stage-19.md) `stage-19` · (cross-cutting) — 55 files

This stage is the shared “roads and vehicles” layer used all across the system. It is not one single step like startup or shutdown. Instead, it is behind-the-scenes support that many other stages rely on whenever they need to talk to another process, another service, or a remote server.

One part provides the basic HTTP building blocks: making requests, checking certificates for secure connections, keeping only safe cookies, retrying temporary failures, and reading streamed responses. Another part moves messages between internal services over channels like standard input/output, Unix sockets, websockets, and encrypted relay links. A third part controls how network traffic is routed, including proxy rules, safety checks that block risky local addresses, and local machine-to-machine communication. A fourth part adapts these transport choices for MCP clients, so higher-level code can use one consistent interface whether the server is in-process, a child process, or reached over HTTP.

The directly assigned files expose the public client APIs for backend services, ChatGPT-related features, and cloud tasks, while codex-client/src/error.rs defines clear error types when requests, responses, or streams fail.

### [Generic HTTP client, TLS, cookies, and streaming transport foundations](stage-19.1.md) `stage-19.1` — 21 files

This stage is the shared plumbing for talking to outside services over HTTP, especially during the system’s normal work. It gives the rest of the codebase a common way to build requests, send them safely, retry when a network call fails, and read back normal or streaming responses.

At the center, request.rs defines the project’s own request and response shapes, including reusable JSON bodies and optional zstd compression, which means shrinking data before sending it. transport.rs turns those shapes into real network calls using reqwest, and retry.rs decides when to try again and how long to wait, with small random delays to avoid thundering-herd retries. sse.rs reads server-sent events, a simple stream of text updates sent over one HTTP connection.

custom_ca.rs controls trusted certificates so private or custom servers can be verified correctly. chatgpt_cloudflare_cookies.rs keeps only a narrow set of safe infrastructure cookies. default_client.rs and login/auth/default_client.rs assemble ready-to-use HTTP clients with tracing and logging.

On top of that foundation, backend-client, chatgpt, cloud-tasks-client, thread_config remote loading, LM Studio, file uploads, and codex-api session/provider code each use the shared transport pieces to talk to their specific backends.

### [App-server, exec-server, and relay transport channels](stage-19.2.md) `stage-19.2` — 10 files

This stage is the system’s message-moving plumbing. It sits behind the scenes and gives different parts of the product a common way to send requests, replies, files, and encrypted data between processes and services.

At the center is the app-server transport module. It defines the basic connection types, events, message forwarding, overload rules, and how outgoing messages are turned into bytes. Different connection styles, like standard input/output, Unix sockets, websockets, and remote control, all plug into this shared core. For remote control, one file breaks large messages into chunks and puts incoming chunks back together, while another talks to the backend service to list or revoke enrolled clients.

On the exec-server side, the HTTP client layer hides whether a request is handled locally or forwarded remotely. Its body-stream code makes response bytes look like one continuous stream even when they arrive in pieces over remote procedure calls. A separate file does the same for remote file reads.

Finally, the relay pieces secure and package traffic. The Noise channel performs the encrypted handshake and protects data in transit. Ordered ciphertext, message framing, and the websocket relay then keep encrypted packets in order, preserve message boundaries, and carry them over the network reliably.

### [Managed proxying and local IPC transport substrates](stage-19.3.md) `stage-19.3` — 12 files

This stage provides the “roads and checkpoints” for local communication and controlled network access. It sits behind the scenes and supports the system’s main work by deciding how requests travel, when they are allowed, and how local helper processes talk to each other.

The network proxy side starts with network_proxy_spec.rs, which combines user settings, company rules, and execution policy into one effective proxy plan, then starts or updates the live proxy. connect_policy.rs checks whether an outbound connection targets a forbidden local or private address. upstream.rs then builds the actual outgoing client, either direct or through another proxy. If traffic must be inspected, mitm.rs performs HTTPS “man in the middle” interception by briefly decrypting traffic with certificates managed by certs.rs. mitm_hook.rs adds per-host header changes, and responses.rs generates the clear blocked or error messages users see.

The local transport side supplies private channels on the same machine. uds/src/lib.rs gives a cross-platform Unix-socket style API. shell-escalation/src/unix/socket.rs adds richer sockets that can pass file handles. linux-sandbox/src/proxy_routing.rs bridges proxy access into sandboxes. The IDE integration uses windows_pipe.rs and ipc.rs to safely exchange request and response messages with a local IDE.

### [MCP and executor-backed transport adapters](stage-19.4.md) `stage-19.4` — 8 files

This stage is the bridge between the high-level MCP client and the real ways it can talk to a server. It sits in the main connection path: when the client needs to start or re-start a conversation, these pieces choose a transport and make it behave in a consistent way.

The main entry point is rmcp-client/src/lib.rs. It is the front desk of the library: other code imports it to get the client, transport types, and helper tools. From there, one path is in_process_transport.rs, which creates a transport to a server running inside the same program. Another path is executor_process_transport.rs, which talks to a child process through standard input and output, turning line-based JSON messages into structured requests and replies.

For HTTP-based MCP, reqwest_http_client.rs performs real network requests, while rpc_http_client.rs sends those HTTP requests through the exec-server’s JSON-RPC link instead. http_client_adapter.rs then reshapes that shared HTTP ability into the streamable MCP form, including server-sent event streams. www_authenticate.rs reads auth failure headers to explain missing permissions, and streamable_http_retry.rs retries temporary startup and request failures without losing the overall timeout.

## [Cross-cutting observability, analytics, and feedback](stage-20.md) `stage-20` · (cross-cutting) — 81 files

This stage is the system’s shared observability and feedback layer: the behind-the-scenes instruments, black boxes, and notebooks that stay active across startup, normal request handling, streaming work, tool runs, and shutdown. Its job is to help developers see what happened, measure how the system behaved, and save enough evidence to diagnose problems later.

One part models analytics events. It turns scattered facts about user turns, tool use, and outcomes into clean records, reduces them into complete events, and sends them out in batches. Another part sets up OpenTelemetry, the standard toolkit for traces, logs, and metrics. A trace is a linked breadcrumb trail of one request. Metrics are counts and timings. This layer configures exporters, carries trace IDs across boundaries, and keeps metric names consistent.

Session telemetry adds a per-session flight recorder, with timing and feature-specific measurements. Rollout tracing records detailed raw events and payloads, then can replay them later into a readable timeline. Feedback and debug capture package logs, safe diagnostics, and attachments for bug reports, while local persistence saves logs and captures to files or SQLite for later search. The Windows sandbox logging file adds simple rolling daily logs for sandbox commands.

### [Analytics event modeling, reduction, and emitters](stage-20.1.md) `stage-20.1` — 8 files

This stage is the system’s analytics engine: the behind-the-scenes part that watches what happened, turns it into clean event records, and sends those records out. It sits alongside the main work of the app rather than doing user-facing work itself.

The flow starts with facts.rs, which defines the raw observations the system can notice in memory, such as a turn starting or ending, a plugin being used, or an error being rejected. events.rs defines the final event shapes that are ready to send over the wire, plus helpers to convert those raw facts into sendable records. accepted_lines.rs handles one special case: it reads code diffs, summarizes which added lines were accepted, and creates privacy-safer fingerprints and repository identifiers instead of sending raw code or URLs.

The heart is reducer.rs. It acts like an assembly line that gathers scattered observations, matches related pieces together, and produces complete analytics events. client.rs is the front door other code uses; it queues facts in the background, avoids duplicate events, batches some event types, and delivers them by HTTP or to a debug file. lib.rs ties these pieces together, while analytics_utils.rs and ext/goal/src/analytics.rs are small adapters that plug analytics into the app server and goal features.

### [OpenTelemetry runtime, provider, and metrics foundations](stage-20.2.md) `stage-20.2` — 22 files

This stage is the shared observability toolbox for the whole system. It mostly sits behind the scenes during startup and then stays available while the app runs. Its job is to turn user telemetry settings into working tracing, logging, and metrics: tracing follows a request’s path, logging records notable events, and metrics count and time things.

It starts with configuration. core/src/config/otel.rs cleans up user TOML settings and turns bad tracing metadata into warnings instead of blocking startup. core/src/otel_init.rs and otel/src/provider.rs then assemble the real OpenTelemetry provider, choose exporters, install global handlers, add standard resource information, and shut things down cleanly later. otel/src/otlp.rs builds the network pieces used to send telemetry out.

The metrics files provide a small measurement system: config, names, tags, validation, errors, the main client, timers, one-time process-start reporting, and runtime snapshot summaries. Together they make sure metric names and labels are safe and consistent before recording anything.

trace_context.rs carries tracing IDs across process boundaries so related work can be linked. events/shared.rs standardizes session event emission. targets.rs decides what becomes a log versus a trace. The telemetry trait files in codex-client and codex-api let transport code report request-attempt details to outside observers.

### [Session telemetry and feature-specific instrumentation](stage-20.3.md) `stage-20.3` — 16 files

This stage is the system’s shared “flight recorder” for one user session. It sits behind the scenes during startup and the main work loop, making sure important events are measured in a consistent, privacy-safe way.

At the center is the session telemetry layer, which gives the rest of the code one place to send logs, traces, and metrics. A trace is a breadcrumb trail showing what happened during a request. Turn timing adds a stopwatch for each conversation turn, including when the first token or message appears and where time was spent.

Around that core, several files add instrumentation for specific product areas. App-server tracing labels incoming requests. Auth environment telemetry records which auth features are present or enabled, without exposing secrets. Cloud-config, guardian, goals, and memories each emit their own standardized metrics. Memory usage code notices safe shell-style reads of memory files and classifies them. Sandbox tags summarize the active safety policy in a compact form. Tool-dispatch tracing records tool calls without leaking trace-format details into core dispatch code. Finally, SQLite startup telemetry tracks database initialization and fallback outcomes, with a small adapter that connects database events to the system-wide metrics pipeline.

### [Rollout trace recording, schema, and replay reducers](stage-20.4.md) `stage-20.4` — 24 files

This stage is the system’s “black box recorder” and playback engine. During the main work of a rollout, it captures what happened as a stream of raw events and saved payload files. Later, it can replay that trace and rebuild a cleaner, easier-to-browse picture of the session.

At the bottom, bundle.rs, raw_event.rs, and writer.rs define the trace package on disk: the manifest, file names, event format, and the rule that big payloads are saved before events point to them. lib.rs is the front door that exposes these pieces. config.rs provides a small, stable way to read rollout settings.

Several files record specific kinds of activity: thread.rs tracks session and thread lifecycles, inference.rs records model requests and responses, compaction.rs tracks history-rewrite checkpoints, tool_dispatch.rs records tool calls, code_cell.rs covers code execution cells, and mcp.rs adds tracing information to MCP backend calls. protocol_event.rs converts broader protocol messages into this smaller trace vocabulary.

The reducer files then turn raw traces into useful models. model/*.rs defines the final in-memory shapes. reducer/mod.rs coordinates replay, while the conversation, inference, compaction, thread, code_cell, and tool reducers each rebuild one part of the story and connect them into one coherent timeline.

### [Feedback capture, debug artifacts, and log persistence](stage-20.5.md) `stage-20.5` — 10 files

This stage is the system’s “black box recorder.” It runs behind the scenes while the app is doing its normal work. Its job is to keep useful evidence for later, without carelessly leaking secrets.

Several parts gather feedback and diagnostics. The feedback library stores logs, request tags, and optional attachments in memory, then bundles them into a Sentry upload, which is a report sent to an error-tracking service. It can also collect simple environment-based network diagnostics, and add a best-effort “doctor” report with sensitive details removed. If those extras fail, feedback still goes through.

Other parts make debugging safer. The response debug context pulls out safe clues from HTTP errors, such as request IDs and authorization failure details, while avoiding raw response bodies. The secret sanitizer scans text and masks common API keys, bearer tokens, and obvious secret assignments before they reach logs or screens.

Finally, several files save debug data locally. Proxy request and response dumps are written to disk with header redaction. Analytics payloads and TUI session activity can be captured as JSONL files. For longer-term storage, tracing events are queued and written into a SQLite log database, which also handles cleanup, size limits, searching, and extracting logs for feedback reports.

## [Cross-cutting persistence abstractions and data stores](stage-21.md) `stage-21` · (cross-cutting) — 54 files

This stage is the app’s shared storage toolbox. It is not just for startup or shutdown. It supports the system all through normal use by remembering things on disk, in small databases, and in safe local files, so work can continue after a restart.

One part keeps conversation threads and message history. It writes sessions as durable log files, compresses older ones, keeps quick indexes for listing and search, and offers a thread-store interface so the rest of the app can read, write, search, or delete threads without caring about file details. Another part uses SQLite, a small built-in database, to keep runtime state such as thread metadata, goals, job queues, repair tasks, and links between related threads; the agent graph layer then makes those family links easy to query.

Other parts act as caches: they save downloaded configs, model lists, plugin data, and small UI choices so the app does not have to fetch them again every time. Separate stores manage installed plugins, protected secrets, and filesystem-based memory files. Finally, the import persistence pieces track outside session files already seen and read their records into the app’s format.

### [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files

This stage is the system’s long-term memory. It sits behind the scenes and makes sure conversation threads survive after the app stops, can be found again later, and can be searched or removed.

At the rollout layer, rollout.rs and rollout/src/lib.rs expose the shared tools for saving sessions to disk. recorder.rs is the main worker: it writes conversation events into line-by-line JSON files, reloads them, and helps choose where a resumed session should continue. compression.rs quietly swaps old log files into compressed form to save space, while still letting the rest of the code read them as if nothing changed. session_index.rs keeps a small side file of thread IDs and names for quick title lookup. list.rs and search.rs are the browsing tools: one finds and summarizes threads, the other looks inside them for matching text.

The thread-store crate builds a storage-neutral interface on top. store.rs defines the contract, error.rs standardizes failures, and in_memory.rs offers a simple test version. The local implementation in local/mod.rs ties everything together for real disk storage, with separate parts for live writing, reading, listing, searching, helper conversions, and deletion. message-history/src/lib.rs stores a separate global append-only history log for all messages.

### [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files

This stage is the system’s long-term memory. It is shared support used while the app is running, so important facts survive restarts and can be queried later. The main entry point is state/src/lib.rs, which exposes the SQLite-based storage runtime. SQLite is a small on-disk database built into the app.

Several files define the shapes of saved records: thread metadata, thread goals, agent jobs, backfill state, and logs. These model files are the translation layer between raw database rows and clean in-memory objects. The matching runtime files do the real work: they save and list threads, record parent/child spawn links, track each thread’s goals and budgets, manage memory-processing jobs and consolidated memories, store batches of agent work items, remember remote-control enrollments, and keep results from external config imports.

Backfill support tracks a one-off repair worker that fills in missing rollout metadata, with leasing so only one worker owns the job at a time. audit.rs is a safe read-only window for diagnostics. The agent-graph-store crate then puts a simple interface on top of the saved spawn links, so other parts of the system can ask about the thread family tree without knowing database details.

### [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files

This stage is shared support code that helps the rest of the system remember small pieces of information between runs. Instead of asking the network for everything every time, it saves trusted results on disk and reuses them when they are still fresh. Think of it like labeled storage boxes the app can quickly check before going back to the warehouse.

The cloud-config cache stores downloaded configuration bundles in a signed format. A signature here is a tamper check: if the file was changed, too old, broken, or belongs to a different signed-in user or account, it is rejected. The connector, model, and plugin catalog caches do a similar job for lists of connectors, available models, and remote plugins. Each uses account- or endpoint-specific keys so one user’s data is not confused with another’s, and stale or malformed files are thrown away.

The shared-plugin-path store keeps a small local map from remote shared plugin IDs to local folder paths, with a lock to stop two parts of the same process from editing it at once. The updates cache saves small UI state, such as whether an update popup was dismissed.

### [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files

This stage is the system’s long-term storage room. It sits behind the scenes and defines how three kinds of durable data live on disk: plugins, secrets, and memories. Its job is not the main work loop itself, but making sure important data is stored safely, found again later, and cleaned up when needed.

The plugin store file is like a careful warehouse manager. It decides where plugin files live, how a cached plugin is discovered or installed, which version should be used, and how old ones are removed without leaving the folder structure in a broken state.

The secrets files protect sensitive values such as tokens. One part defines the public rules: what a secret name can look like, how secrets are grouped, and how the code chooses a storage backend. Another part is the local backend, which saves encrypted secret files under the app’s home folder and keeps the passphrase in the operating system’s keyring. On Windows, the DPAPI wrapper uses the built-in Windows encryption service so different privilege levels can still share protected data.

The memories files manage a filesystem-based memory area. The local backend keeps all reads and writes inside the allowed root folder. The write-side code rebuilds workspace files from database results, creates per-rollout summary files with predictable names, deletes summaries that are no longer needed, safely clears memory directories without following dangerous symlinks, and prunes expired extension files. Together, these parts keep durable local state organized, private, and tidy.

### [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

This stage is shared support for bringing conversation history in from other tools. It sits behind the scenes during import, making sure Codex can read outside session files and avoid importing the same version twice.

One part is the ledger. Think of it as a shipping logbook. It stores which external session files have already been imported, using the file’s real location on disk and a content hash, which is a fingerprint of the file’s contents. With that record, the system can quickly check whether a file is new, unchanged, or needs its saved details refreshed before import starts.

The other part is the record reader. It opens external session files written as JSONL, a format where each line is one JSON record, and turns them into something Codex can use. It can do a light pass to get summaries, or a full pass to produce the complete stream of messages for import. While reading, it cleans up differences between source formats by normalizing message text, titles, timestamps, and tool output into a consistent Codex-friendly form.

Together, these pieces answer two questions: “Have we seen this file version before?” and “What exactly does it say?”

## [Cross-cutting utility and support libraries](stage-22.md) `stage-22` · (cross-cutting) — 175 files

This stage is the project’s shared toolbox. It mostly sits behind the scenes and supports both startup and the main work of the program. Instead of doing one user-facing job, it gives many other parts the small, reliable building blocks they need.

Several sub-stages cover the big support areas: working with files, paths, environments, and sandboxes; cleaning up and displaying text; handling config, metadata, auth, and network details; running shells, Git, plugins, and other processes; managing async work and images; and even build-time setup before the app runs.

The direct files here fill in extra glue. `core/src/util.rs` adds common odds and ends like retry timing, error display, path lookup, and structured feedback tags. `core/src/utils/mod.rs`, `utils/cli/src/lib.rs`, and `utils/plugins/src/lib.rs` act like front desks, giving other code one stable place to import path, command-line, and plugin helpers. `execpolicy-legacy/src/error.rs` and `git-utils/src/errors.rs` give those areas a shared way to describe failures. `utils/fuzzy-match/src/lib.rs` powers “close enough” text matching for filtering. `hooks/src/events/common.rs` keeps hook events using the same text cleanup and matching rules. Together, these pieces make the rest of the system more consistent and predictable.

### [Path, filesystem, environment, and sandbox support utilities](stage-22.1.md) `stage-22.1` — 31 files

This stage is shared support code that many other parts of the system lean on before they can do real work. It teaches the program how to talk about files, folders, commands, and the outside environment in a safe, consistent way across Windows, macOS, Linux, WSL, and sandboxed setups.

Several pieces standardize paths. PathUri, LegacyAppPathString, AbsolutePathBuf, and the lower-level absolutize code turn messy path text into validated absolute forms or file URLs, while keeping platform differences straight. Small helpers in path-utils, app-server-client, memories, and state add comparison rules, safe writes, hidden-file checks, and file timestamp reading. The file watcher then builds on that to reliably watch changing files.

Another group shapes execution environments. Program resolution finds executables correctly on each platform. exec_env and the Windows sandbox environment helpers build cleaned-up child-process environments. Terminal detection, clipboard selection, and terminal palette code inspect the current terminal so user-facing features behave correctly.

Finally, filesystem and sandbox utilities provide the abstract filesystem interface, guarded file opening, symlink helpers, Bazel/Cargo binary lookup, macOS and Windows sandbox support, and SSH config scanning. Together, these are the adapters and safety rails that let the rest of the system run predictably anywhere.

### [Text, parsing, truncation, and rendering helpers](stage-22.2.md) `stage-22.2` — 57 files

This stage is shared support that helps the rest of the system turn raw text into something clean, readable, and safe to show. It is mostly behind the scenes, especially for the terminal interface, but many other parts use it too. You can think of it as the text workshop: it reads text in, tidies it up, measures it, reshapes it, and prepares it for display.

One part provides everyday string tools: formatting numbers and durations, filling in templates with placeholders, escaping JSON text, and shortening long text without cutting a character in half. Another part reads streaming text as it arrives in pieces, rebuilds full UTF-8 characters, splits lines correctly, removes hidden markup, and extracts special items like mentions, citations, or tables.

On top of that, the layout layer figures out how wide text will be in a terminal, wraps or truncates it, and keeps colors and links intact. The presentation layer then applies styles, labels, spacing, and reusable small view pieces. Finally, animation and progress helpers add spinners, shimmer effects, and temporary status lines so long-running work feels responsive.

#### [Generic string, formatting, truncation, and templating utilities](stage-22.2.1.md) `stage-22.2.1` — 12 files

This stage is shared behind-the-scenes support for turning values into readable, safe text. It is not the app’s main work loop by itself. Instead, many parts of the system call it when they need to show, shorten, or package text in a predictable way.

Several files focus on formatting. Number helpers present large values with grouped digits or short suffixes like “K”. Duration helpers turn time spans into compact strings. CLI helpers build safe display text for environment settings without leaking secrets, and generate consistent “resume” command hints. There is also a formatter for web-search actions so search details read clearly even when the input comes in different shapes.

Other files focus on shaping text. Truncation helpers shorten long strings in the middle without breaking UTF-8, the text encoding used for Unicode characters, and can work by byte or rough token budget. Output and response-history utilities use those limits to keep logs or message histories within size budgets. JSON helpers force non-ASCII characters into escaped forms while keeping valid JSON. Finally, the template engine fills in {{ name }} placeholders strictly, and TUI text helpers provide reusable cleanup and shortening rules for on-screen text.

#### [Streaming, line framing, and hidden-markup parsers](stage-22.2.2.md) `stage-22.2.2` — 9 files

This stage is shared behind-the-scenes support for reading text a little at a time as it arrives. It sits underneath the main work loop and turns messy incoming chunks into clean pieces the rest of the system can trust.

At the center, stream_text.rs defines the basic “deal” for these parsers: feed in streamed text, get back text that can be shown right away plus any hidden data pulled out on the side. lib.rs ties the pieces together and exposes the public entry points. utf8_stream.rs adds a wrapper for raw bytes, making sure split UTF-8 characters are reassembled correctly before parsing.

Several files then recognize structure inside the stream. line_buffer.rs collects partial bytes until a full line is ready. tagged_line_parser.rs watches for special blocks whose start and end markers must be on lines by themselves, even if those lines arrive in pieces. inline_hidden_tag.rs is the reusable engine for stripping hidden inline tags from visible text while extracting their contents.

On top of those primitives, table_detect.rs spots markdown tables and code fences consistently, mention_codec.rs translates visible @name and $name mentions to and from stored link form, and citations.rs extracts structured memory citation IDs from hidden markup.

#### [TUI text layout, wrapping, and text-rendering primitives](stage-22.2.3.md) `stage-22.2.3` — 10 files

This stage is the behind-the-scenes text workshop for the terminal user interface. Before anything can be drawn on screen, the system must figure out how wide text really is, where lines should break, what to cut off, and how to keep colors and links intact. These helpers do that low-level preparation so higher-level screens can render safely.

Several files provide the basic measuring tools. `render/mod.rs` defines small rectangle and padding helpers, while `line_utils.rs` copies and prefixes lines in a consistent way. `width.rs` adds safety checks so wrapping code does not try to squeeze text into zero space. `line_truncation.rs` shortens lines by terminal cell width without breaking Unicode characters or losing style.

Other parts shape richer text. `ansi-escape/src/lib.rs` turns ANSI-colored strings into the UI’s text objects. `markdown_text_merge.rs` recombines split markdown text so things like URLs stay recognizable. `terminal_hyperlinks.rs` tracks links separately from visible text, so wrapping and truncation do not break clickable areas. `wrapping.rs` handles normal and link-preserving wrapping, `live_wrap.rs` supports streaming text that must reflow as it arrives, and `scrollable_diff.rs` builds a scrollable wrapped view for diffs and long messages.

#### [TUI presentation models, styling, and lightweight view helpers](stage-22.2.4.md) `stage-22.2.4` — 21 files

This stage is shared presentation support for the text-based interface. It sits above the low-level text layout layer and below the screens the user sees. Think of it as the kit of labels, paint, rulers, and small display parts that help many TUI features look consistent.

Some files decide how things should look. color.rs and style.rs choose readable colors and surface styles that fit the terminal’s theme and color limits. ui_consts.rs keeps common indentation and gutter widths aligned. The chart palette file does the same job for token-activity charts.

Other files shape information into display-ready pieces. goal_display.rs, status/helpers.rs, status/format.rs, status/remote_connection.rs, skills_helpers.rs, and external_agent_config_migration_model.rs turn raw internal data into short labels, summaries, and tidy status text.

A third group helps build reusable interface pieces. renderable.rs defines a common “renderable” building block so text and widgets can be arranged in rows, columns, and inset boxes. history_cell/base.rs and selection_list.rs provide ready-made line and list row parts.

Finally, several bottom-pane helpers make menus and prompts behave consistently: key_hint.rs formats shortcut hints, footer.rs builds footer lines, popup constants unify popup instructions, selection and tab helpers render chooser popups, scroll_state.rs tracks list movement, and warnings.rs avoids showing the same warning again and again.

#### [TUI animation, motion, terminal media, and transient progress output](stage-22.2.5.md) `stage-22.2.5` — 5 files

This stage supplies the “moving parts” of the command-line interface: the small bits of motion, glow, and temporary status output that make the program feel alive while it is doing work. It is mostly shared support used during the main work of the app, especially when showing progress or drawing attention without overwhelming the user.

The hub is motion.rs. Other parts of the TUI ask it for things like a spinner or shimmering text, and it decides whether to show full animation or a calmer reduced-motion version for people or terminals that prefer less movement. shimmer.rs creates the shimmer effect itself, either with rich color or a simpler brightness-based version when the terminal is more limited.

For ASCII art animation, ascii_animation.rs is the engine: it picks which text frame to show based on time and tells the screen when to redraw. frames.rs is the library of built-in frame sets and timing defaults that engine uses.

Finally, cli/src/doctor/progress.rs uses these ideas for diagnostics. While checks run, it either shows a temporary status line on standard error or stays quiet when the environment calls for silent output.

### [Configuration, metadata, schema, auth, and network glue utilities](stage-22.3.md) `stage-22.3` — 26 files

This stage is shared backstage support. It is not one single feature. Instead, it supplies the small but important adapters, checks, and translators that help startup, normal app work, and network calls behave consistently.

Several files shape configuration. They rename old config keys to new ones, apply command-line overrides like key=value, wrap settings with validation rules, and produce human-readable labels saying where a setting came from. Related CLI helpers turn user-friendly flags such as approval or sandbox modes into the internal forms the program uses.

Another group prepares metadata and schemas: connector labels and install links, plugin mention symbols, duplicate skill-name counts, plugin toggle extraction, JSON-to-TOML conversion, and compact JSON Schema descriptions for memory tools.

Authentication and request glue live here too. PKCE creates the secure verifier/challenge pair for OAuth login, auth utilities pull readable server error messages, API-key reading protects secret bytes in memory, and header helpers turn optional tracing metadata into real HTTP headers.

Finally, network and URL helpers normalize backend URLs and hosts, decide which ChatGPT hosts are trusted, classify private or loopback addresses, validate proxy policy and config, and compare versions or npm release metadata so update-related features can trust what they see.

### [Shell, command, git, plugin, and execution support utilities](stage-22.4.md) `stage-22.4` — 24 files

This stage is shared support code that many other parts of the system lean on while doing their real jobs. It is the toolbox behind the scenes for running commands, talking to Git, working with plugins, and keeping shell use safe and predictable.

Several pieces focus on shells, which are programs like bash or PowerShell that run typed commands. The shell-command and core shell files figure out which shell to use, turn that choice into the exact program arguments needed on each operating system, and help parse or safely display commands. The shell-environment code prepares the environment variables passed into those commands, including filtering secrets. The external-editor helper uses the same ideas to launch the user’s editor.

Another group wraps Git. The git-utils files run Git with safety limits, collect repository facts and diffs, choose the right branch comparison point, and block risky helper programs. The TUI diff code turns that into a safe, view-only diff for users.

The remaining files support execution itself: buffering long output without using endless memory, normalizing executable names, preparing low-level process launches on Linux and Windows, tracking child processes, mapping exit codes, packaging plugins, and finding patch locations in files. Together, these utilities make higher-level features reliable and safe.

### [Async primitives, image handling, and miscellaneous small support libraries](stage-22.5.md) `stage-22.5` — 25 files

This stage is shared behind-the-scenes support. It is a box of small tools that other parts of the system rely on during normal work, rather than one big feature on its own.

Several pieces deal with images. The image utility crate reads images from raw bytes or data URLs, resizes and re-encodes them safely, caches them by content, and reports clear image errors. Image-preparation uses that to shrink inline chat images so later prompt-building code does not get overloaded, or swaps bad images for explanatory text. The image-detail helpers decide when a model may ask for the untouched original image. In the terminal UI, pet sprite sheets are split into per-frame PNG files, cached, and then turned into terminal-specific output. The protocol layer picks Kitty or Sixel, and the Sixel encoder produces compact text-based image data.

Other helpers keep the app steady. Async utilities support cancellation, readiness waiting, and timeout budgets. Sleep-inhibitor prevents the computer from dozing off during active work on Linux, macOS, or Windows, with a dummy fallback. Small libraries also handle runtime value conversion, replay filtering, frame-rate limiting, lightweight caching, and human-readable sandbox summaries.

### [Build scripts and build-time asset/platform glue](stage-22.6.md) `stage-22.6` — 4 files

This stage lives before the program even runs. It is the build-time support layer: small helper scripts that prepare each platform-specific piece so the finished binaries are assembled correctly. You can think of it as the packing and setup station before the real work begins.

The `bwrap/build.rs` script is for Linux. It can compile bundled C source code for bubblewrap, a sandboxing tool, into a static library, meaning the code is packed directly into the final program. If that works, it tells Cargo, Rust’s build tool, where to find the library, when to rebuild, and sets a flag so the Rust code knows bubblewrap support is available.

The `windows-sandbox-rs/build.rs` script is the Windows counterpart. It adds a Windows manifest, a small metadata file that tells Windows how the helper program should behave.

The `cli/build.rs` script handles a macOS quirk by passing an extra linker argument so Objective-C pieces are included correctly.

The `skills/build.rs` script watches embedded sample assets and forces a rebuild when any sample file changes, keeping built-in content up to date.

## [Testing, fixtures, and developer verification harnesses](stage-23.md) `stage-23` · (cross-cutting) — 659 files

This stage is the project’s big proving ground. It sits behind the scenes and checks the system across its whole life: starting up, doing real work, talking over protocols, saving state, drawing the interface, and shutting down cleanly. Think of it as a workshop full of test rigs, fake environments, and inspection tools that catch mistakes before users do.

Its sub-stages each watch a different part of the machine. App-server suites verify message formats, background server behavior, reusable fake setups, and full client-to-server flows. Core runtime harnesses test session memory, safety rules, tool execution, and end-to-end runs. CLI, login, patching, and MCP checks make sure developer-facing commands behave correctly from the outside. Exec-server, sandbox, and remote transport tests validate command running, file access, encrypted links, and platform-specific safety boundaries. TUI tests confirm the text interface renders and reacts properly. Cross-cutting library tests cover shared support code such as telemetry, configuration, plugins, persistence, and utilities.

The direct support file, test-binary-support/lib.rs, helps tests launch the right helper binary by name and gives them a temporary home directory, so each test run stays isolated and repeatable.

### [App-server test suites and protocol verification](stage-23.1.md) `stage-23.1` — 115 files

This stage is the app server’s full safety net. It sits behind the scenes and checks that the server’s message format, internal rules, real-world behavior, and support tools all keep working as the code changes.

One part verifies the protocol, meaning the exact JSON messages sent between pieces of the system. These tests make sure data is turned into JSON and back correctly, and that published schema files still match what the code really sends.

Another part tests the daemon and transport layers. The daemon is the long-running helper process in the background. The transport layer is the path messages travel through, such as sockets or standard input/output. These tests check updating, connection routing, broadcasts, pairing, and the special test client used to drive realistic scenarios.

A third part covers app-server unit tests and shared fixtures. Unit tests check small rules in isolation. Fixtures are reusable fake servers, files, accounts, and histories that create controlled test setups.

Finally, the integration suites run the whole server like a real client would, checking login, settings, conversations, tools, live connections, and shutdown. Together, these parts test the server from the smallest wire detail to full end-to-end use.

#### [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files

This stage is a safety net for the system’s “language on the wire” — the exact JSON messages different parts of the app send to each other. It is not part of startup or shutdown. Instead, it is behind-the-scenes support that makes sure later changes do not silently break compatibility.

The tests in common_tests.rs check one small but important rule: when the server builds a response, which pieces become the JSON-RPC result and which pieces stay in a higher-level wrapper. Think of it like making sure a package is split correctly between the box and the label.

The files v2/remote_control_tests.rs and v2/tests.rs check the v2 protocol itself. They verify serialization and deserialization, meaning turning in-memory data into JSON and back again. They lock down tricky cases such as missing versus null fields, empty objects, old compatibility behavior, enum value mapping, and feature gates for experimental APIs.

Finally, schema_fixtures.rs compares checked-in schema files with freshly generated ones. That confirms the published TypeScript and JSON schema descriptions still match the real protocol exactly.

#### [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files

This stage is the safety net and test toolkit for the server’s background service, its connection paths, and the special client used to drive end-to-end checks. It sits behind the scenes: not the main work itself, but the code that proves startup, communication, updating, and cleanup behave correctly.

Several tests focus on the daemon, the long-running background process. pid_tests.rs checks how it reads and writes process-ID files, avoids races, builds commands, and reports recent error output. managed_install_tests.rs and update_loop_tests.rs lock down how the updater recognizes a managed binary, compares versions or identities, and decides whether a restart or updater refresh is needed.

Another group checks transport, meaning the channels used to talk to the server. unix_socket_tests.rs verifies local Unix-socket behavior, while transport_tests.rs checks routing rules, message filtering, broadcasts, and stdio queue behavior. The remote-control client and pairing tests make sure browser- or device-style control APIs list, revoke, pair, and recover correctly.

The test-client library and tiny loopback server act like a practice driver and fake outside service. Together with the plugin analytics helpers and smoke tests, they run realistic scenarios and confirm the right analytics events are emitted.

#### [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files

This stage is the app server’s safety net. It sits behind the scenes and checks both small internal rules and bigger end-to-end behavior before changes can break real users.

The unit test files each pin down one part of the server. Some focus on configuration: importing outside agent settings, reading and writing config files, and turning command-line override flags into the right settings. Others check request handling: tracing request flows, deciding when imported agent data should refresh caches, mapping remote-control failures into client-facing errors, and managing thread state, summaries, and edge cases.

The shared integration fixtures are the test workshop. They create fake analytics and model servers, fake login data, temporary config files, cached model lists, canned streaming replies, and saved conversation history on disk. The test harness then launches a real app-server process as a child program and talks to it through JSON-RPC, a structured message protocol.

Finally, the suite index files gather everything into one large test binary and organize tests by feature area, including the larger version-2 API suite.

#### [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files

This stage is the big “prove the whole server works from the outside” test area. It sits mostly in the system’s main working path, but it also checks startup mistakes and clean shutdown. Think of it as a full dress rehearsal: a client connects, signs in, changes settings, starts conversations, uses tools, and the tests confirm the server keeps its promises all the way through.

One part checks the basics of identity, settings, discovery, and core remote calls. “Remote calls” here means requests a client sends to the server over the API. These tests cover login, limits, configuration files, feature flags, file and process actions, and remote control.

Another part focuses on the live connection itself, especially WebSocket, a network link that stays open for two-way messages. It checks handshakes, reconnects, protocol rules, and shutdown behavior.

A third part tests extensions and tools: plugins, marketplaces, MCP tool servers, command runners, and built-in helpers like search.

The last part follows conversation threads over time: creating them, running turns, interrupting or steering work, saving state, resuming later, reviewing results, and cleaning up. Together, these suites show whether the app server behaves correctly in real use.

##### [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files

This stage is a broad “does the server really behave correctly from the outside?” check for the app server’s main public surface. It sits in the system’s everyday work: starting up safely, accepting client requests, and talking to outside services.

Several tests focus on identity and access. auth.rs and v2/account.rs walk through login, logout, token use, refresh problems, and provider-specific rules. v2/rate_limits.rs and v2/rate_limit_reset_credits.rs check account limits, credit use, and how backend results and failures are passed back to clients.

Another group checks startup and configuration. strict_config.rs makes sure bad config files stop the server early with a clear error. v2/initialize.rs verifies the server records who the client is and sends the right notifications later. v2/config_rpc.rs and v2/experimental_feature_list.rs test reading, editing, layering, and enabling settings.

The rest cover discovery and core utilities: listing models, provider capabilities, collaboration modes, and permission profiles; file operations in fs.rs; process running in process_exec.rs; Windows sandbox setup; and remote_control.rs for pairing and management. Together, these tests act like a full dashboard of the server’s core promises.

##### [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files

This stage is a set of end-to-end tests for the app server’s live connection layer: the part that talks to clients over long-lived links such as WebSocket, which is a two-way network connection that stays open. It sits in the system’s “main work” path, but it also checks some startup and shutdown behavior because connection mistakes often show up there first.

connection_handling_websocket.rs is the broad safety net. It opens real WebSocket sessions and checks basics such as which work belongs to which connection, whether health-check URLs still answer, how different login modes behave, whether startup blocks unsafe states, and whether work stays correctly attached when clients reconnect. connection_handling_websocket_unix.rs adds Unix-only tests for operating-system signals, making sure the server shuts down or restarts cleanly even if a turn is still running.

attestation.rs focuses on trust signals during the opening handshake: it verifies that a client token is asked for through JSON-RPC and then sent in the WebSocket headers. experimental_api.rs checks feature gating, so experimental methods are refused unless the client explicitly opts in. realtime_conversation.rs ties everything together with fuller conversation flows across WebSocket and WebRTC, including protocol version differences and event translation.

##### [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files

This stage tests the app server’s “extension points” and tool-running features: the places where outside add-ons, tool providers, and command runners plug into the main system. It sits in the shared support layer behind the main work loop, making sure the server can discover, install, use, and remove extra capabilities safely.

One group of tests covers plugins and marketplaces. These check how the server lists plugins, reads plugin details and skills, adds or removes marketplaces, upgrades them, installs plugins, shares them to a backend, and uninstalls them cleanly. Together, they verify the full plugin life cycle from catalog to local files.

Another group covers discovery surfaces: app lists, hooks, skills, and executor-scoped behavior. “Executor-scoped” means a capability is available only in the specific running context that selected it. These tests make sure the right skills, apps, and MCP servers appear in the right place.

The rest checks tool execution itself: MCP servers, tools, resources, and status; shell and command execution; special execution paths like zsh fork; and built-in or extension-backed tools such as image generation, sleep, web search, and fuzzy file search. Together, these act like a proving ground for everything the server can plug in and run.

##### [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files

This stage is the app server’s “life story” test bed for conversations. It sits in the main work of the system: creating a chat thread, running turns inside it, pausing or steering work, saving state, and later finding, resuming, reviewing, compacting, archiving, or deleting it.

Some tests focus on thread identity and storage. thread_start, thread_read, thread_list, thread_loaded_list, conversation_summary, remote_thread_store, and thread_resume check how threads are created, described, found, stored locally or in a separate store, and loaded back into memory. Archive, unarchive, delete, fork, rollback, unsubscribe, memory_reset, memory_mode_set, metadata_update, and settings_update cover how a thread changes over time and how those changes are saved.

Another group covers active work inside a thread. turn_start, turn_interrupt, turn_steer, output_schema, dynamic_tools, plan_item, inject_items, request_permissions, and request_user_input test what happens while a response is being generated, including tool calls, approvals, user follow-up input, and mid-flight control.

The rest check side effects around that lifecycle: name and status websocket notifications, client metadata, review flows, compaction, external-agent imports, and safety-policy notifications. Together, these tests make sure conversation sessions behave consistently from birth to cleanup.

### [Core runtime and session test harnesses](stage-23.2.md) `stage-23.2` — 179 files

This stage is the project’s full testing ground for the core runtime, especially the parts that keep a user session going from one turn to the next. It is mostly behind-the-scenes support, but it checks the system at every scale: small unit tests, larger integration tests, and full end-to-end runs that act like real usage.

One part tests the runtime’s memory and rules. It checks sessions, saved state, prompts, approvals, safety policy, and how conversation history is trimmed or summarized so the model sees the right context. Another part focuses on tools and command execution. It verifies the exact shapes of tool calls, the code that runs them, and the safety gates around shell access, network use, and other risky actions.

A shared integration harness provides the test workshop: reusable setup code, fake servers, helper processes, logging, and controlled environments so tests are repeatable. On top of that, the end-to-end suites run the whole machine together, checking transport to model providers, streaming replies, plugins, remote work, multi-agent flows, compaction, and review or approval paths. Together, these layers make sure core behavior stays correct and safe.

#### [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files

This stage is the project’s safety net for the core runtime: the part that keeps a session alive from one user turn to the next, remembers state, shapes what the model sees, and enforces approval and execution rules. It sits behind the scenes during the main work of the system, checking that all these moving parts keep telling the same story.

The biggest group of tests centers on sessions and agents. They simulate real conversations, resumes, rollbacks, forks, thread limits, and shutdowns so session history, state, and control logic stay consistent. Another group checks how context is built and trimmed: history ingestion, event mapping, compacted summaries, environment details, user-message wrappers, images, metadata, timing, diffs, and realtime handoff text.

Policy-focused tests make sure dangerous actions are screened correctly. Guardian tests cover human-review flows. Exec-policy, safety, sandbox-tag, and MCP exposure tests confirm what is allowed, blocked, or deferred. Supporting files check shells, shell snapshots, Git info, AGENTS.md discovery, personality migration, client request formatting, and plugin review metadata. Together, these tests act like a full dress rehearsal for the runtime’s non-tool behavior.

#### [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files

This stage is a behind-the-scenes safety net for the system’s tool and command-running machinery. It does not do the main user work itself. Instead, it proves that the pieces used during normal operation behave exactly as intended, especially when commands run, tools are exposed to the model, or approvals and sandbox rules are involved.

Several files lock down tool “specs,” meaning the exact shapes of the inputs and outputs the model is allowed to use. These cover agent jobs, patching files, MCP tools, multi-agent tools, shell tools, hosted tools, and asking the user for input. Other tests check the handlers that actually carry out those requests, including shell execution, patch application, plugin install requests, and multi-agent coordination.

Another group checks the router and registry, which are the traffic directors deciding which tools exist, when they are visible, and where a call should go. Approval, sandboxing, and network-approval tests make sure risky actions stay gated. Finally, the unified-exec and runtime tests verify the engine that starts processes, streams output, manages timeouts, and preserves safe environment settings. Together, these tests keep the whole tool system predictable and safe.

#### [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files

This stage is the shared test toolkit for the core crate. It sits behind the scenes of end-to-end testing, not in the product’s normal runtime. Think of it as the workshop and jigs that let many different tests build the same kind of setup reliably.

The entry point is `core/tests/all.rs`, which creates one integration-test program, and `core/tests/suite/mod.rs`, which gathers the full suite and adds an early dispatch trick so that the test program can pretend to be helper command-line tools when needed. `core/tests/common/lib.rs` is the main toolbox, re-exporting helpers used across many tests. On the core side, `core/src/test_support.rs` exposes special test-only setup paths without changing production behavior.

Several files prepare realistic test conditions. `test_environment.rs` detects whether tests run locally, in Docker, or through Wine. `hooks.rs` marks hook fixtures as trusted. `tracing.rs`, `process.rs`, and `zsh_fork.rs` help with logging, child-process waiting, and real `zsh` interception. `apps_test_server.rs`, `responses.rs`, and `streaming_sse.rs` provide fake servers and controlled streaming. `context_snapshot.rs` makes request data readable and stable. Finally, `test_codex.rs` and `test_codex_exec.rs` are the main harnesses that assemble all of this into isolated, repeatable test runs.

#### [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files

This stage is the big end-to-end check for the system’s main “live session” experience. It sits in the heart of the story: once a conversation is running, these tests make sure requests go out correctly, replies stream back, tools run safely, and the session can keep its place over time.

One part tests transport and provider protocols, which means the rules for talking to outside model services over the network. It checks request shape, streaming, retries, and fallback when connections fail. Another part tests session history and saved state, making sure old conversation can be shortened, stored, resumed, or replayed without losing important context.

The request-shaping and model-selection suites make sure the system packs the right instructions and picks the right model before asking for help. The multi-agent and remote-environment suites cover teamwork: parent and child agents, shared limits, message passing, and work done in a separate remote workspace.

The approval, permission, hook, and review tests act like gatekeepers, checking what must be allowed, blocked, or reviewed. Finally, the tool and plugin suites verify that commands, file edits, integrations, and progress updates all work end to end and are reported back clearly.

##### [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files

This stage checks the system’s “front door” to model providers: the network requests, streaming connections, and the small rules that make those conversations reliable. It sits in the main work path, where a user turn is turned into an API call and the streamed reply comes back.

Several tests focus on building the outgoing request correctly. client.rs, responses_headers.rs, responses_api_proxy_headers.rs, request_compression.rs, responses_lite.rs, and compact_remote.rs verify headers, metadata, compression, subagent identity, lite-mode differences, and remote compaction that trims or replaces history. models_etag_responses.rs checks the model list refresh rule when the server says its catalog changed.

Another group covers live streaming transports. agent_websocket.rs and client_websockets.rs test WebSocket behavior, including prewarming, reused connections, request shape, and events. realtime_conversation.rs extends that to realtime sessions over WebSocket and WebRTC. turn_state.rs checks that per-turn transport state stays consistent within one turn and resets for the next.

The remaining files test failure recovery at the boundary: retries for incomplete SSE streams, releasing the session after a stream error, falling back from WebSocket to plain HTTP, and clean handling of quota or safety-triggered server responses.

##### [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files

This stage tests the system’s memory between turns and across restarts. It sits in the “keep going later” part of the story: after a conversation has begun, these tests check that the system can trim old history, save what matters, pause, restart, and continue without losing the plot.

The compaction tests are the heart of this stage. They check how long conversation history is compressed into a shorter summary, whether done manually, automatically, or by a remote service, and whether both remote compaction versions behave the same. Related tests then make sure that compacted history still behaves correctly when a session is resumed, rolled back, or split into a new branch with fork.

Other files focus on saved state. Resume tests rebuild a session from stored rollout logs and warn if it comes back under a different model. Pending-input tests cover messages that arrive while work is still in progress, making sure they are queued and replayed properly. Window-header, image-rollout, and rollout-list tests verify the bookkeeping around saved transcripts. Finally, model-override, override-update, and SQLite-state tests make sure temporary thread settings and database-backed session records are saved only where they should be, and not written back into permanent config by accident.

##### [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files

This stage is the “packing and routing” part of the system. Before Codex asks a model for help, it must decide what to send, how to arrange it, and sometimes which model should receive it. These tests make sure that request is built correctly and stays consistent across normal turns, resumes, forks, and setting changes.

Several files check what instructions get added to the model’s input: extra context, AGENTS.md project instructions, collaboration rules, hierarchical child-agent guidance, repository skills, permissions messages, personality settings, and token-budget notes about how much context space is left. Prompt layout tests then verify the exact visible order and formatting of all those pieces, while prompt-debug and prompt-caching tests make sure prompt assembly is correct and reusable across turns.

Other files focus on provider-facing request shape. They verify JSON-schema output requests, web-search tool configuration, and how model-visible content is rewritten when switching models or service tiers.

Finally, remote-model, runtime-selector, and auto-review tests cover model choice itself: fetching model metadata from a server, merging it with local settings, applying runtime behavior flags, and choosing special review models when required.

##### [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files

This stage is a behind-the-scenes safety net for the system’s most complex teamwork features. It tests what happens when one session creates helper agents, passes work down to them, and sometimes runs that work in a separate remote environment instead of the local machine. Think of it as checking that a manager, assistants, inboxes, and off-site workspaces all coordinate correctly.

spawn_agent_description.rs checks the instructions shown when the system offers the “spawn agent” tool, so users only see allowed model choices and clear guidance about overrides, effort levels, service tiers, and approval rules. agent_execution.rs makes sure nested agents share a limited pool of execution slots and fail clearly when that limit is exceeded. codex_delegate.rs verifies that a child agent’s review events are forwarded into the parent conversation in the right form. subagent_notifications.rs follows the full parent/child lifecycle, including inherited context, message passing, and notifications. agent_jobs.rs tests batch-style agent jobs, including creation, cancellation, and saving results to the right thread. remote_env.rs ensures remote execution uses the correct remote files, permissions, and sandbox, without leaking into the local workspace.

##### [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files

This stage tests the system’s “gatekeepers” during the main work of a session. These are the checks and side routes that stand between a user-facing action and the action actually running. Think of it like a front desk, security desk, and audit trail all working together.

The approval and permission tests check when commands, patching files, network access, or saved exceptions are allowed, blocked, or need a prompt. That includes command policy rules, special cases for shell execution, and the zsh-fork path, where commands run inside a stricter sandbox, meaning an isolated safety boundary. The request-permissions files cover both asking inline during a tool call and using a dedicated tool to gain access for later steps.

Other files test how the system asks the user for more input, how `/review` and Guardian review create separate review sessions without leaking the wrong transcript, and how metadata about reviews or earlier user questions is attached to MCP and app tool calls. Finally, the hooks and notification tests make sure outside scripts can intercept, rewrite, block, observe, and summarize actions at the right moments.

##### [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files

This stage is the system’s full dress rehearsal for “doing work” with tools. It checks what happens when the model or the user asks the program to run commands, edit files, call outside integrations, or emit progress records during a turn. In simple terms, it makes sure the tool belt is shown correctly, used safely, and reported back clearly.

Several tests focus on command running: shell, shell_command, exec, unified exec, snapshots, user-run commands, interrupts, timeouts, and parallel tool calls. They verify real command startup, output capture, sandbox limits, approval rules, session reuse, and shutdown cleanup. Apply-patch and the tool harness test file editing flows end to end, including patch parsing, file changes, streaming updates, and the records sent back afterward.

Other suites cover how results are packaged for the model: plain-text serialization, truncation of oversized output, and the runtime items and events that describe what happened. The rest test integrations beyond built-in tools: plugins, app/MCP tools, search-based tool discovery, file upload for app calls, extension sandbox permissions, Code Mode nested tools, and image viewing. Together, these tests check the whole path from tool offer to final visible result.

### [CLI, exec, login, and MCP server developer verification](stage-23.3.md) `stage-23.3` — 73 files

This stage is a broad reality check for developer-facing command-line tools. It lives in the testing side of the system and covers the moments when someone runs a command, signs in, applies a patch, or connects tools together. In simple terms, it asks: if a developer uses these programs for real, do they behave correctly from the outside?

The top-level CLI tests check the main codex command at the front door: command selection, options, warnings, plugin and marketplace actions, MCP server management, and a few live end-to-end smoke tests. The codex-exec tests focus on the separate exec program, making sure it reads prompts and flags correctly, turns server events into human or machine-readable output, and handles sessions, approvals, hooks, and failures.

The login tests follow full sign-in and sign-out journeys, including browser login, device-code login, token storage, refresh, and cleanup. The apply-patch tests run the real patch tool against sample files and confirm the final files match expectations. Execpolicy tests verify the allow-or-block decision system, both current and legacy rules. Finally, the MCP server harness starts the real server process and talks to it like a client would, checking approvals and instruction passing end to end.

#### [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files

This stage is the safety check for the standalone apply-patch program after it has been built. It sits in the testing part of the system, not startup or shutdown. Its job is to run the real command-line tool the way a user would and confirm that files on disk end up exactly as expected.

all.rs is the single entry point for these integration tests, meaning tests that exercise the whole executable from the outside instead of calling its internal functions directly. suite/mod.rs arranges the test set into topic areas and skips a few tests on Windows when they depend on behavior that differs there.

cli.rs checks the basic ways a user can feed a patch into the program: as normal command-line arguments or through stdin, which is standard input text piped into the process. tool.rs goes deeper, testing success and failure cases, including bad patch text, missing files, overwriting rules, rename behavior, and what happens when only part of a patch can be applied. scenarios.rs is the big end-to-end check: it copies prepared sample folders, runs patches on them, and compares the final directory tree to an expected snapshot. Together, these tests verify the program’s user-visible contract.

#### [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files

This stage is the final checkpoint for the main codex command-line tool: it tests what happens when a real user types top-level commands. It sits around startup and command dispatch, making sure the right command path is chosen, input is checked strictly, and clear output or errors are produced before deeper work begins.

The tests for app-server and exec-server confirm those entrypoints reject bad configuration instead of quietly guessing. Update checks that debug builds stop immediately with a plain message, rather than starting the normal update flow. Delete covers a specific failure case so errors appear in the right order. The debug tests verify maintenance commands: one clears stored “memory” state safely, and another prints model information as valid JSON, with or without bundled models.

Feature tests check feature flags, saved settings, warnings, and listing order. Plugin and marketplace tests cover listing, JSON output, install and removal, adding and removing marketplace sources, malformed inputs, and the moved upgrade command. MCP tests check adding, removing, listing, and showing MCP servers, including transport details, secret masking, and invalid option combinations. Finally, the live CLI smoke tests run the actual binary against the real service for an end-to-end sanity check.

#### [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files

This stage is the safety net around the codex-exec command-line program itself. It sits at the point where a user or script actually runs the binary, so it checks both startup behavior and the main run path. Think of it as testing the front door, the wiring behind it, and the signals it sends back out.

Some tests focus on understanding the command line correctly. cli_tests.rs and main_tests.rs make sure flags, subcommands, and prompts are read in the right order. lib_tests.rs checks the helper code used during startup, such as turning raw prompt text into the right form and mapping settings into running threads.

Other tests verify output. The human-output and JSONL event processor tests check how streamed events become readable text or machine-readable lines, including errors, final messages, and metadata. The larger JSON output tests cover the full translation from server notifications into exec events.

The integration suite then checks real end-to-end behavior: reading prompts from stdin, adding writable directories, sending auth and Originator headers, embedding output schemas, honoring approval rules, saving or skipping session files, resuming sessions, running hooks, reporting startup or server failures, and handling patch-style workflows.

#### [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files

This stage is the safety net for the execpolicy system: the part that decides whether a command is allowed to run. It sits in behind-the-scenes support, but it checks the whole path from reading a policy to producing the final allow-or-block decision.

The current tests cover both the command-line tool and the policy engine itself. cli/tests/execpolicy.rs checks the user-facing command, codex execpolicy check, and makes sure it returns the right JSON decision report, including when a rule includes a human-readable reason. execpolicy/tests/basic.rs tests the engine end to end: parsing policy files, applying prefix and network rules, resolving which executable is meant, and confirming examples and justifications.

The legacy test suite keeps older, command-specific behavior from drifting. all.rs and suite/mod.rs gather everything into one runnable set. good.rs and bad.rs check the curated examples of commands that must pass or fail. The other files focus on particular commands like cp, head, ls, pwd, and sed, verifying exact accepted forms and exact failure cases. Together, these tests act like a long checklist that preserves both new behavior and old promises.

#### [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files

This stage is the safety net for the login system. It sits around the main login and logout work, checking that the whole journey works the way a real developer would experience it and that saved sign-in data is handled correctly.

At the top, all.rs and suite/mod.rs gather the many test pieces into one test program, so everything runs under a single harness. Several tests focus on the building blocks of authentication. access_token_tests.rs checks how the system tells one token format from another. personal_access_token_tests.rs makes sure personal tokens can be looked up against a fake auth service. storage_tests.rs verifies where sign-in data is stored, from files to secure system storage, including upgrade paths. auth_tests.rs ties many of these rules together, and bedrock_api_key_tests.rs checks API-key behavior and cleanup.

The larger journey tests then exercise full user flows. cli/tests/login.rs checks command-line login. device_code_login.rs covers the “enter this code on another device” flow. login_server_e2e.rs tests browser-based sign-in through a local callback server. auth_refresh.rs checks automatic token renewal. logout.rs confirms sign-out revokes tokens and removes saved credentials.

#### [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files

This stage is the system’s end-to-end check for the MCP server executable. Instead of testing tiny pieces in isolation, it starts the real `codex-mcp-server` program as a child process and talks to it the way a real client would. That makes it part of the “does the whole thing actually work?” story.

The entry point is `tests/all.rs`, which gathers these integration tests into one test binary. `tests/suite/mod.rs` organizes the suite and currently points to the `codex_tool` tests. `tests/common/lib.rs` adds shared helpers, including one that turns raw JSON-RPC messages — remote procedure call messages sent as JSON text — back into typed Rust values for easy checking.

`mcp_process.rs` is the heart of the harness. It launches the server and sends and receives line-by-line JSON-RPC traffic. `mock_model_server.rs` supplies a fake model service, so tests do not need a real backend. `responses.rs` prepares scripted streamed replies, including assistant text, shell tool requests, and patch commands. Finally, `codex_tool.rs` ties it together to verify real tool behavior, especially approval prompts and instruction passing.

### [Exec-server, sandbox, and remote transport harnesses](stage-23.4.md) `stage-23.4` — 49 files

This stage is the project’s proving ground for “how commands and files move around safely.” It sits behind the scenes and checks the plumbing that lets one part of the system start programs, talk to remote machines, and enforce sandbox rules.

Several test harnesses act like reusable test rigs. The common exec-server helpers can launch a real server, fake helper binaries, connect over WebSocket, and send JSON-RPC messages, which are structured remote procedure calls. Other tests then use that rig to check startup handshakes, health endpoints, WebSocket behavior, process lifetime, stdin and output handling, and client-side HTTP request/stream support.

Another group focuses on filesystems and paths. Shared and platform-specific tests compare local and remote file access, sandbox restrictions, symlink or junction behavior, file streaming, and tricky `file:` URI cases.

Security and transport tests cover the Noise encrypted channel, relay framing, ciphertext ordering, reconnect logic, and remote-control message chunking. Finally, sandbox and bridge tests verify Linux, macOS, Windows, Wine, stdio-to-socket, and RMCP transport behavior. Together, these pieces make sure the system can execute work remotely and locally, correctly and safely.

### [TUI interaction and rendering tests](stage-23.5.md) `stage-23.5` — 52 files

This stage is the safety net for the terminal user interface, the text-based screen people actually see and interact with. It sits around the system’s main work loop: not startup or shutdown itself, but the checks that prove the live interface behaves correctly while the app runs.

A few shared helpers make these tests practical. test_support files build realistic fake app state, normalize text that differs across machines, and keep test data short and readable. The custom test backend replaces a real terminal with a VT100 parser, a virtual terminal model, so tests can inspect exactly what would appear on screen without touching the user’s console.

From there, the tests work at several levels. App tests check the overall conductor: startup choices, thread replay, resizing, config changes, shutdown, and status summaries. ChatWidget tests focus on the main conversation area: composing messages, slash commands, approvals, popups, permissions, review mode, side chats, status lines, layouts, terminal titles, and token-usage charts. Rendering-focused tests verify markdown, history cells, status output, and layout math. Finally, integration tests wire everything together and run smoke checks, including resize and VT100 history behavior, to catch boundary and regression problems.

### [Cross-cutting library tests, fixtures, and telemetry or rollout support](stage-23.6.md) `stage-23.6` — 190 files

This stage is a wide safety net for shared parts of the codebase that many features depend on. It mostly sits behind the scenes. Instead of running the main app itself, it checks that support libraries, test fixtures, and monitoring or rollout pieces behave correctly so other stages can trust them.

Several sub-stages cover big shared areas. Analytics and telemetry tests make sure the system records useful signals about what it is doing. Configuration and policy tests check how settings, permissions, and environment rules are read and combined. Plugin, extension, skill, MCP, and tool tests verify how outside add-ons are discovered, loaded, and turned into usable features. API client and transport tests lock down how the code talks to remote services. Memory, rollout, state, and persistence tests check what gets remembered across runs. Utility tests define low-level rules for paths, URIs, and output trimming.

The direct files add smaller but important checks: grouped ChatGPT crate tests, a fake cloud-tasks client, app test-only rendering support, goal accounting rules, file watching, hook output spilling to disk, line buffering, terminal detection, string truncation, and image loading and benchmarking. Together, these parts act like inspection stations for the project’s shared machinery.

#### [Analytics and telemetry tests](stage-23.6.1.md) `stage-23.6.1` — 18 files

This stage is the system’s safety net for observability: the parts that record what the app is doing through analytics, metrics, logs, and traces. These are behind-the-scenes signals used to measure behavior, debug problems, and understand usage. The tests make sure those signals are produced correctly.

At the top, the otel test crate, suite index, and shared harness set up a reusable test world, including in-memory exporters so tests can inspect telemetry without talking to real servers. The OpenTelemetry suite then checks specific jobs: rejecting bad metric inputs, recording timings, sending metrics in the background, taking snapshots of current values, summarizing runtime activity, adding manager-specific tags and counters, deciding what goes to logs versus traces, and exporting over local HTTP loopback.

The analytics tests focus on higher-level user and app events. They verify where events are sent, how they are batched and filtered, and how realistic app activity is reduced into clean analytics records. Other tests check default analytics settings, exact metric names and tags, tracing helper behavior, full request-handling telemetry, and log filtering into SQLite storage. Together, these tests confirm the whole observability pipeline tells an accurate story.

#### [Configuration, policy, and environment tests](stage-23.6.2.md) `stage-23.6.2` — 43 files

This stage is the safety net for the system’s rules about configuration, permissions, features, and environment setup. It sits mostly behind the scenes, but it protects both startup and normal operation by checking that many kinds of settings are read, combined, validated, and explained correctly.

One group of tests focuses on configuration itself: builders in test_support create fake managed “cloud” bundles, and many config and loader tests check parsing, profile selection, layer precedence, strict validation, editing, schema output, and preservation of comments. Cloud-config tests then make sure remote managed settings are ordered, cached, refreshed, and rejected safely when malformed or expired.

Another group checks policy decisions. Permissions, sandbox, network proxy, Windows sandbox, and network-policy tests confirm what the user or an enterprise admin is allowed to do, which rule wins when settings conflict, and what message the user sees. Feature and tool-policy tests verify how optional capabilities are turned on, renamed, warned about, or blocked.

The remaining tests cover hooks, prompts, environment variables, path handling, home-directory instructions, deprecation notices, and migration behavior. Together, these files act like a large inspection checklist, ensuring the system interprets settings predictably before real work begins.

#### [Plugins, extensions, skills, MCP, and tools tests](stage-23.6.3.md) `stage-23.6.3` — 50 files

This stage is the system’s safety net for add-ons and outside integrations. It sits in the main working part of the story, checking that plugins, extensions, skills, MCP servers, and tool descriptions all behave correctly when the app discovers them, loads them, connects to them, and turns them into features a user can use.

One group of tests focuses on plugins and marketplaces. The test-support files build realistic fake folders and config files. Then provider, loader, store, marketplace, remote, startup-sync, sharing, manager, discoverable, and routing tests check the full plugin life cycle: finding plugin files, choosing versions, merging config, syncing curated plugin sets, talking to remote marketplaces, installing or listing plugins, and deciding which apps or MCP servers should actually be visible.

Another group covers the user-facing feature layers built on top: core plugin discovery and mentions, connector selection and install prompts, and skills loading and invocation. Extension API tests make sure extensions can register themselves, keep state, and contribute behavior safely. Specific extensions such as goal, image generation, memories, and skills are tested end to end. MCP tests then verify server config, catalog conflict handling, connection management, and client transport behavior. Finally, tool tests ensure tool definitions, schemas, conversions, and API formats are translated consistently.

#### [API clients, models, protocol, prompts, and transport support tests](stage-23.6.4.md) `stage-23.6.4` — 38 files

This stage is the project’s safety net for the code that talks to outside services and for the shared “glue” around that work. It sits behind the scenes, making sure startup choices, everyday requests, and streamed responses all behave exactly as expected.

Several tests focus on model and provider data: they check how provider definitions are read from config files, how built-in presets are created, how model facts can be overridden, and when cached model lists should be trusted or refreshed. Test-support helpers let other tests build realistic model settings without needing real network calls.

Another group checks client behavior: login token parsing, default HTTP headers, API error mapping, request shaping, retries, auth injection, and special cases like Azure, custom certificates, and mocked cloud backends. Transport tests cover server-sent events, WebSockets, Unix sockets, line buffering, retry rules, OAuth startup, and recovery after failures.

The rest lock down message formats and prompt text. They verify protocol error wording, shell-output decoding, code-mode contracts, prompt templates, JSON schema cleanup, image-detail compatibility, and proxy or TLS support. Together, these tests make the system’s communication layers predictable and safe to change.

#### [Memories, rollout, state, and persistence tests](stage-23.6.5.md) `stage-23.6.5` — 26 files

This stage is the system’s safety net for the parts that remember things over time. It sits behind the scenes and checks that saved conversations, rollout logs, runtime state, and recovery rules all behave correctly when the program is running, restarting, or cleaning up after trouble.

Several test groups focus on rollout traces: shared fixtures build tiny fake event histories, then reducer tests check how raw events are turned into simpler summaries for code cells, conversations, model inference, terminal tool use, and multi-agent work. Other rollout tests cover thread-level tracing, protocol event mapping, compression, metadata, indexing, state-database links, recording, loading, scanning, and repair.

Another set checks persistence: runtime helpers create isolated temporary folders, while runtime tests verify external-agent import records and database corruption recovery. Memory tests cover prompt building, citation parsing, startup steps, stored summary files, pruning old extension resources, and workspace diffs. Message-history and thread-store tests make sure stored messages and thread files stay readable and trimmed correctly. Ledger tests confirm external-agent session records are updated efficiently without unnecessary rereading.

#### [Utility crate tests for path/URI and output truncation helpers](stage-23.6.6.md) `stage-23.6.6` — 3 files

This stage is the project’s safety net for two shared helper libraries. It is not part of startup, the main work loop, or shutdown. Instead, it checks behind-the-scenes rules that many other parts rely on: how paths and URIs (uniform resource identifiers, such as file-like addresses) are understood, and how long output is shortened when there is a size limit.

The truncation tests in utils/output-truncation/src/truncate_tests.rs make sure text and structured output are cut down in the right way when there is a byte budget or a token budget. In other words, they confirm the system trims output predictably without breaking the format.

The path and URI tests in utils/path-uri/src/tests.rs define what PathUri is supposed to do across different operating systems. They check cleanup of path forms, conversion to native host paths, fallback URI encoding when a normal path is not possible, text-based path operations, save/load behavior through serde, and clear error reporting.

The API path string tests in utils/path-uri/src/api_path_string_tests.rs check the user-facing wrapper built on top of PathUri. They verify how path text is read, written, guessed, and preserved for Unix-style paths, Windows paths, network paths, and fallback URI forms. Together, these tests act like executable examples and guardrails for shared utility behavior.
