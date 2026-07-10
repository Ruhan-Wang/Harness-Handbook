# System Handbook — Stage Index

Each stage below links to its full page; the paragraph is the stage's role in the system.

## [Process entrypoints and binary dispatch](stage-1.md) `stage-1` — 65 files

This stage is the system’s starting line for native programs. When one of the project’s binaries starts, this code reads the command-line arguments and decides what kind of run the user meant. In simple terms, it is the receptionist and switchboard: it looks at the program name, the flags, and the subcommand, then sends control to the right runtime mode.

The main user-facing launch surface covers the big entry programs. It includes the top-level codex command, the text-based full-screen interface, one-shot exec mode, desktop app launchers, remote control, sandbox setup, system health checks, archive commands, code-apply commands, MCP settings, and cloud task commands. These pieces define the available commands and perform the first handoff into real work.

The auxiliary binaries are smaller specialist tools. They generate schemas, rebuild protocol code, apply patches, search files, bridge standard input/output to sockets, inspect Markdown parsing, and provide test or platform-specific helpers.

exec/src/main.rs is the dedicated entrypoint for codex-exec. It parses shared config overrides, can change behavior based on argv[0] (the executable name the process was started with), and then forwards normal exec runs into the exec runtime.

### [Primary user-facing launch surfaces](stage-1.1.md) `stage-1.1` — 19 files

This stage is the system’s front door. It is where the main programs start, read what the user asked for, and decide which path to take: the full-screen text interface, a one-shot command, desktop app launch, remote control, sandbox tools, health checks, or maintenance commands.

The core router is cli/src/main.rs. It defines the top-level codex command, understands all the major subcommands, and enforces shared rules like config overrides and feature switches. cli/src/lib.rs supplies shared command shapes and a small helper for turning socket paths into full paths. The TUI and exec binaries have their own command parsers in tui/src/cli.rs, tui/src/main.rs, and exec/src/cli.rs so they can start correctly with their own options.

Several files then carry out specific launch actions. app_cmd.rs and the desktop_app files open or install the desktop app on macOS and Windows. remote_control_cmd.rs starts a controllable background or foreground server. debug_sandbox.rs and sandbox_setup.rs run or prepare locked-down environments. doctor.rs and doctor/thread_inventory.rs inspect system health. session_archive_commands.rs manages archive and delete actions. apply_command.rs applies task-generated code changes. mcp_cmd.rs manages external MCP server settings and login. cloud-tasks/src/cli.rs and cloud-tasks/src/lib.rs provide a separate task-focused command surface and runtime.

### [Auxiliary binaries and developer tools](stage-1.2.md) `stage-1.2` — 45 files

This stage is a toolbox shelf for the rest of the system. These programs are run directly for setup, testing, debugging, or integration, rather than through the main command-line app. Think of them as small specialist tools around the main machine.

Several tools generate or refresh machine-readable descriptions of data formats, called schemas. `config_schema.rs` and `config/src/schema.rs` produce the JSON blueprint for `config.toml`. The protocol and hooks exporters do the same for the app-server and hook interfaces, so tests and outside consumers can rely on stable files. `generate-proto.rs` regenerates protobuf bindings.

Other binaries are standalone workers. `apply_patch` reads input and applies a patch. `file-search` scans folders and ranks path matches, then prints them in JSON, plain text, or highlighted terminal output. The stdio bridge connects standard input/output to a Unix socket. `md-events` helps inspect how Markdown is parsed.

There are also sample and test servers, clients, and helpers: app-server launchers, MCP test servers, notification file writers, state log viewers, exec-policy checkers, and sandbox helpers for Linux and Windows. Together, these tools support development, testing, and platform-specific execution behind the scenes.

## [Early process hardening and runtime bootstrap](stage-2.md) `stage-2` — 3 files

This stage is the program’s “get ready before anything important happens” step. It runs right at startup. Its job is to make the process safer, choose core security tools, and set up the execution environment so later stages can trust the ground under them.

The process-hardening code locks down the program early. Depending on the operating system, it turns off risky features such as crash dumps or debugger attachment, and it removes dangerous environment variables that could trick the system’s dynamic loader, the part that pulls in shared libraries. This reduces the chance that outside settings can change how the program starts.

The rustls-provider code then installs a single global cryptography provider. That means all TLS, the standard way to secure network connections, will use the same crypto engine everywhere. It also checks that the chosen engine supports a required signing method, so failures happen early and predictably.

Finally, arg0 handles the program’s self-dispatch. It looks at how the binary was invoked and can pretend to be different helper commands through PATH aliases, temporary command names placed on the command search path. It also prepares the process environment and the Tokio runtime, the async task engine, in a way that keeps those aliases alive for the whole run.

## [Installation context, home discovery, and local environment probing](stage-3.md) `stage-3` — 12 files

This stage is the system’s “figure out where I am” step. It runs early in startup, before configuration and other decisions can be trusted. Its job is to learn where Codex is installed, where its home folder should be, what operating system and terminal it is inside, and which helper tools are actually available.

Several pieces build that picture together. The home-dir code chooses the Codex home folder, either from the CODEX_HOME setting or from the user’s normal home directory. The install-context code then works out what kind of installation this is and where bundled resources and helper programs live. managed_install adds the details for standalone installs, including version lookup and file fingerprinting so updates can tell exactly which executable is present. On Windows, helper_materialization copies packaged helper programs into a shared sandbox bin folder and reuses them when possible.

The environment files describe and cache usable local or remote execution environments, with shell_snapshot capturing a shell’s exported settings, aliases, and options into temporary snapshot files. The doctor and detection files inspect Git, runtime details, OS settings, hostname, and likely cloud environment IDs so later parts of the system can make sensible startup choices.

## [Configuration, feature resolution, and startup policy assembly](stage-4.md) `stage-4` — 105 files

This stage is the startup planning desk for the whole system. Before the app can do real work, it has to decide which settings, permissions, and built-in options actually apply. It gathers configuration from many places, such as managed or cloud settings, user and project files, per-thread values, and command-line arguments, then combines them by priority into one final runtime configuration.

One part loads and checks those layers, including requirement files that can restrict sensitive options. Another part resolves feature flags, which are simple on/off switches, and installs built-in assets such as skills, presets, plugin and model catalogs, and starter memory files.

Several files turn that merged input into concrete policy. They compile permission profiles into sandbox and network rules, map them to Windows-specific enforcement when needed, and decide tool behavior, service tiers, keymaps, project-root markers, and helper executable paths. The app server’s config manager is the main doorway other code uses to ask, “what is the current effective config?” Editing helpers let the UI safely update user config, while debug and lockfile support explain or record exactly what settings the session ran with.

### [Config layer ingestion and requirements composition](stage-4.1.md) `stage-4.1` — 42 files

This stage is the system’s configuration assembly line. It runs in shared support, before the main work can rely on settings and rules. Its job is to gather configuration from files and managed sources, combine those layers in priority order, and turn them into one checked result the rest of the app can trust.

The core schema, diagnostics, merge, and loading part defines what valid config looks like, reads it from places like disk, cloud, projects, and per-thread settings, then merges it while remembering where each value came from. It also gives precise errors when something is misspelled, the wrong type, or not allowed.

The requirements and execution-policy part does the same for rule files: it reads layered requirements, combines permissions, hooks, and policy rules with special merge behavior, and builds the final rule stack. It also enforces trust gates, meaning only approved sources may set sensitive options.

The management services part lets other parts of the app read, edit, migrate, and save config safely. `config/src/lib.rs` is the front desk for all of this, exposing one public entry point so other crates can use the whole configuration system consistently.

#### [Core config schemas, diagnostics, merge, and layered loading](stage-4.1.1.md) `stage-4.1.1` — 22 files

This stage is the system’s behind-the-scenes configuration workshop. Its job is to read settings from many places, check that they make sense, combine them in the right order, and produce one final “effective” configuration the rest of the app can trust.

Several files define the allowed shapes of settings: the main config file, hooks, MCP servers, profiles, TUI keymaps, thread-specific settings, environments, agent roles, and the lockfile format. These are the blueprints for what users, managed systems, cloud bundles, and runtime inputs are allowed to say.

Other files do the assembly work. `merge.rs` overlays one config layer on top of another. `overrides.rs` turns command-line overrides into a normal layer. `state.rs` keeps the stack of layers and remembers where each value came from. `fingerprint.rs` creates stable hashes and origin maps so changes can be tracked reliably.

Loading modules then gather layers from disk, cloud, macOS device management, projects, and threads. Strict validation and diagnostics catch unknown fields and type mistakes, and point back to the exact file and line. Together, these parts act like a careful customs desk: collect everything, verify it, and stamp one approved set of settings.

#### [Requirements layering and execution-policy composition](stage-4.1.2.md) `stage-4.1.2` — 11 files

This stage is shared support that turns many requirement and policy files into one trustworthy set of rules the rest of the system can enforce. Think of it like stacking tracing paper sheets into one final blueprint, while keeping notes about which sheet each line came from.

The process starts by reading raw requirement layers. config_requirements.rs defines what valid requirement data looks like and turns loose TOML text into checked rules with clear error messages. requirements_layers/layer.rs prepares each layer for merging, including source locations and some special selections. requirements_exec_policy.rs does the same for execution policy rules, converting file-friendly TOML into the internal policy format.

Then stack.rs assembles the full stack. Most fields merge normally, but some need custom behavior: permissions.rs adds deny-read patterns together, hooks.rs appends hook lists and checks for platform-specific conflicts, and rules.rs appends prefix rules so higher-priority layers come first. mod.rs exposes these pieces as one module.

Two runtime pieces use the result. network_proxy_loader.rs builds and reloads proxy settings from layered config plus policy overlays, and checks them against trusted limits. execpolicy/amend.rs safely adds new policy rules to disk. hooks/config_rules.rs computes the final saved hook-state overrides, while limiting which layers may set user-controlled trust and enablement.

#### [Configuration management services and editable persistence surfaces](stage-4.1.3.md) `stage-4.1.3` — 8 files

This stage is the system’s “settings desk.” It sits in shared support code and is used whenever the app needs to read settings, change them, save them safely, or bring old settings into the current system.

At the app-server side, config_manager_service.rs is the main service for reading and writing user configuration. It checks that changes are valid, avoids overwriting someone else’s newer edit by mistake, and explains when a user’s change is being hidden by a stronger setting from somewhere else. config_processor.rs turns those abilities into RPC calls, which are remote procedure calls: requests sent over the app’s management API. It also exposes feature switches, reports what the current config allows, and refreshes cached values after changes. If loading config fails, config_errors.rs turns low-level failures into clear JSON-RPC error responses, while keeping detailed machine-readable clues for special cloud bundle problems.

Underneath, edit.rs and document_helpers.rs do the careful file surgery on config.toml, trying to preserve layout and formatting. external_agent_config.rs imports settings and related content from another agent installation. personality_migration.rs performs a one-time upgrade for older users. settings.rs separately saves the daemon’s own small local settings, such as whether remote control is enabled.

### [Feature flags, provider catalogs, and built-in asset installation](stage-4.2.md) `stage-4.2` — 33 files

This stage prepares the system’s “starter kit” before any session or screen can open. It gathers all the built-in choices and switches the rest of the app depends on, then turns them into one reliable setup.

One part is feature flags: settings that turn features on or off. The feature files define the available flags, keep old names working, merge config files with runtime overrides, and enforce any policy rules. The TUI popup is the small screen that lets a user change experimental flags and save them.

Another part is skills and memory extensions. Shared config describes which skills are allowed. The skills installer copies bundled skills into the local cache only when needed. The loader scans skill folders and reads each skill’s metadata, while the manager applies config rules, filters disabled skills, and builds the final usable skill list. A similar seeding step creates the built-in ad hoc memory instructions without overwriting user edits.

The remaining pieces build catalogs: plugin marketplaces and plugin-provided capabilities, MCP server registrations, model providers and model metadata, collaboration presets, approval presets, and built-in pet assets. Together, they make sure the app starts with all required definitions, defaults, and files already in place.

## [Authentication, identity, and account readiness](stage-5.md) `stage-5` — 40 files

This stage is the system’s “who are you, and are you ready to use this service?” checkpoint. It mostly runs during startup and onboarding, but parts of it are reused later when the program needs to check login status, refresh an expired session, or switch account modes.

One part handles sign-in itself. The interactive and saved-login pieces let a person log in through a browser or device code, store the result safely, report whether they are signed in, and clear everything on logout. Once some credentials exist, the provider and backend adaptation part turns them into the exact proof each outside service expects, such as a bearer token in a request header or a signed request for AWS.

The manager file is the traffic controller. It loads saved credentials or environment settings, decides which auth mode is active, refreshes tokens, and blocks combinations that are not allowed. Supporting files classify token types, look up account details for personal tokens, and parse saved token data into useful fields. installation_id.rs gives this install a stable local ID. On Windows sandbox setups, sandbox_users.rs prepares the local helper accounts the sandbox depends on.

### [Interactive and persisted login flows](stage-5.1.md) `stage-5.1` — 15 files

This stage is the system’s “getting signed in and staying signed in” layer. It sits around startup and onboarding, and also supports later account checks and logout. Its job is to help a person prove who they are, save that result safely, and clear it when they sign out.

The main entry point is cli/src/login.rs, which powers the direct login, logout, and status commands and leaves a small log file for troubleshooting. The login crate is the engine behind those commands. Its top-level files gather the pieces together, while server.rs runs the short-lived local web server used for browser login, and device_code_auth.rs handles the fallback flow where you copy a code into a browser on another device. auth/storage.rs decides where credentials are kept: a plain file, the operating system keyring, encrypted secret storage, or memory only. auth_keyring.rs picks the right secure storage early, and keyring-store/src/lib.rs is the adapter that talks to the keyring safely.

For account-aware apps, account_processor.rs answers requests like “am I logged in?” and tracks in-progress login attempts. headless_chatgpt_login.rs shows device-code login during text-based onboarding. revoke.rs asks the identity service to invalidate tokens during logout. Bedrock and MCP files provide the same save-and-refresh pattern for those login types too.

### [Provider and backend auth adaptation](stage-5.2.md) `stage-5.2` — 19 files

This stage is the system’s ID and signature desk. It sits behind the scenes and prepares all the different ways later network clients prove who they are when they call outside services.

At the top, model-provider/src/lib.rs and provider.rs expose the public entry points and choose which kind of provider to build: a general one or the Amazon Bedrock version. model-provider/src/auth.rs then decides which auth method applies for each provider, while bearer_auth_provider.rs handles the common “Bearer token” pattern, where a request carries a secret token in a header.

Several files supply those secrets. external_bearer.rs can run a command to fetch a token and cache it. agent-identity/src/lib.rs and login/src/auth/agent_identity.rs manage a stronger machine identity using keys, signatures, and JWTs, which are signed identity tokens.

AWS support is separate: aws-auth loads AWS settings and uses SigV4, Amazon’s request-signing method. The Bedrock files adapt that for Bedrock’s special rules and URLs.

Other parts plug this auth into the rest of the system: codex-api defines the client-facing auth interface, remote_control/auth.rs manages ChatGPT-based remote-control login, the MCP files inspect OAuth support, attestation.rs defines optional per-request proof headers, and rate_limit_resets.rs shows a real backend call using these authenticated clients.

## [Persistence and local runtime services startup](stage-6.md) `stage-6` — 6 files

This stage is the app’s local storage startup. It runs early, during startup, before higher-level features can trust saved data. Its job is to open the app’s SQLite databases (small local database files), make sure their structure is up to date, recover from common damage, and then hand back shared storage services that the rest of the system can use.

The main engine is state/src/runtime.rs. It opens the databases for state, logs, goals, and memories, applies setup steps, and builds the shared runtime object. state/src/migrations.rs supplies the migration rules: the ordered database updates that bring older files up to the current layout, while being careful around files touched by newer versions.

rollout/src/state_db.rs sits on top of that runtime for the rollout feature. It waits for needed metadata backfill to finish, then offers useful operations like listing, lookup, reconciliation, and repair for thread information. core/src/state_db_bridge.rs is a small adapter that lets core code start this rollout state layer without depending on its internals directly.

If startup hits corruption or locked files, state/src/runtime/recovery.rs can detect the problem, back up the damaged database files, and rebuild as needed. cli/src/state_db_recovery.rs turns those failures into clear user-facing guidance in the terminal interface.

## [Backend clients, remote catalogs, and startup refreshes](stage-7.md) `stage-7` — 22 files

This stage is the “check the outside world before we begin” part of startup. Once the app knows its settings and who the user is, it reaches out to remote services and local model servers to collect fresh reference data. That data is then cached so the app can start quickly next time and show the right choices in its interface.

The cloud-config files fetch a signed configuration bundle, validate it, save it locally, and keep it refreshed in the background. The model pieces do something similar for model catalogs: they call `/models`, translate raw responses into structured model records, and build the ready-to-pick model lists used by the app. Static catalogs such as Amazon Bedrock are mixed in with refreshable ones.

For open-source providers, the Ollama and LM Studio code checks whether the local server is reachable, whether needed models exist, and may start downloads or loading. The connectors and ChatGPT files gather connector listings from several places, merge duplicates, and cache workspace settings that affect whether plugins are allowed. Startup also syncs the bundled plugin snapshot, prepares the MCP client used for remote tool connections, checks update information, and uses backend rate-limit data to decide whether the memories pipeline should run.

## [Transport and server runtime initialization](stage-8.md) `stage-8` — 40 files

This stage is the system’s communications setup for server-style running. It happens at startup and early runtime, before the main work can flow. Its job is to open the paths that requests and notifications will travel through, much like setting up doors, phone lines, and switchboards before a busy office opens.

One part brings up the app server and the daemon, the background manager that can start, watch, and stop server processes. It prepares local channels such as standard input/output, Unix sockets, WebSockets, and remote-control links. It also keeps track of running servers, checks when they are ready, and gives other tools a safe way to connect to the right place.

The other part starts integration and helper servers. These are adapters that let outside tools speak to the system using the transport they expect. It includes exec-server links, MCP server loops, secure relay paths, and small bridge programs and proxies that convert one connection style into another.

Together, these pieces establish the live connection network the rest of the system depends on.

### [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files

This stage brings the app server to life and gives other parts of the system safe ways to talk to it. It sits at startup and early runtime. Think of it as opening the building, unlocking the doors, and setting up the phone lines.

On the daemon side, app-server-daemon/src/lib.rs is the main supervisor. It finds the right server program, starts or stops background processes, checks when they are ready, and switches remote control on or off. The backend files define and implement the PID-file approach, where a small file records a process ID so the daemon can find, verify, and clean up detached server processes later. The daemon client speaks JSON-RPC, a request-and-response message format, over the local control socket to probe readiness. The doctor check inspects this background setup without changing it. The remote-control client handles enrollment, retries, and status updates.

On the server side, app-server/src/lib.rs boots configuration, state, and all transports: stdio, Unix socket, WebSocket, and remote control. Other files manage initialization rules, outgoing message routing, and in-process hosting. The transport package adds WebSocket auth, stdio wiring, socket listeners, and the full remote-control enrollment and reconnect machinery. Finally, shared client facades let the CLI and TUI use the same server through either local in-process channels or real socket connections.

### [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

This stage is the “adapter shelf” of the system. It is not the main work itself. Instead, it starts small helper servers and bridges so other programs can talk to Codex over the protocol they expect during normal running.

The exec-server is the biggest piece. Its crate root exposes the public entry points. The connection and client code speak JSON-RPC, which is a simple request-and-reply message format, over stdio, WebSockets, or child processes. The server transport starts listening, while the client transport opens the right kind of link. Remote and Noise relay files add a secure relay path: they register remote environments, authenticate them, encrypt traffic, and turn relay frames back into normal JSON-RPC streams.

The MCP pieces do similar integration work for MCP servers. The runtime chooses the right execution environment, the stdio launcher starts servers locally or remotely, the RMCP client manages each server’s lifetime, and mcp-server runs the server loop itself.

The remaining tools are focused bridges and proxies: stdio-to-UDS connects terminal-style input/output to a Unix socket, responses-api-proxy forwards one HTTP endpoint with injected auth, and network-proxy runs HTTP and SOCKS5 proxy servers with policy checks. Together, these parts let Codex plug into many outside setups safely and consistently.

## [Frontend session startup and user-facing initialization](stage-9.md) `stage-9` — 41 files

This stage is where the system stops being just “initialized in the background” and becomes something a person or script can actually use. It sits right after backend setup and just before the real work begins.

One path is the interactive text interface, or TUI. Its startup code loads settings, connects to the right service, starts logging, and decides whether to open a new session, resume an old one, or make a copy of one. If needed, it pauses for important first-run or safety questions, such as sign-in, folder trust, provider choice, or config import. In parallel, the terminal-integration pieces take control of the terminal window: they check what the terminal supports, switch it into the right modes, protect the screen, and make sure it can be restored cleanly after suspend or exit. Other helpers prepare shortcuts, notifications, chat widgets, titles, and replay of earlier session state.

The other path is exec mode for scripts and automation. It builds one session from command-line input, runs the event loop until done, and sends results out in readable machine-friendly logs. Session resume support lets either path continue or branch from saved work safely.

### [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files

This stage is the “getting settled” part of the text interface. It runs before the main chat loop and makes sure the app, the terminal window, and the user are all ready to work together.

The top-level startup code in lib.rs and app.rs loads settings, connects to the right backend service, starts logging, and decides whether to begin fresh, resume an old session, or fork a copy of one. If needed, startup can pause for important questions: provider choice in oss_selection.rs, hook safety review, update and model-migration prompts, working-directory choice, and external config import. The onboarding modules then guide a first-time user through welcome, sign-in, and trusting the current folder, using a small fixed set of keys before custom shortcuts exist.

At the same time, the terminal shell in tui.rs, custom_terminal.rs, terminal_probe.rs, keyboard_modes.rs, terminal_stderr.rs, and job_control.rs takes “ownership” of the terminal: it probes what the terminal can do, switches modes, protects the screen, and restores things cleanly after suspend or exit. Supporting pieces pick startup tips, notifications, terminal titles, pets, chat widget setup, and resume replay so that, once startup ends, the main interface can appear already assembled and stable.

### [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

This stage is the startup and run path for non-interactive sessions: cases where the system is given a task, prepares one session, runs it through to the end, and prints the result instead of opening an interactive screen. You can think of it as the “set up the job, then press go” part of the machine.

The main driver is exec/src/lib.rs. It takes settings from the command line, starts the app server inside the same process, builds the request that tells the system what prompt or review to run, and then runs the event loop — the repeating cycle that processes messages until the session is finished. It also prepares JSONL output, a line-by-line JSON log format that other tools can read, and converts shared configuration types into the forms this exec mode expects.

tui/src/session_resume.rs supports cases where the job continues or branches from an earlier session. It finds the saved thread ID, working directory, and model. It prefers the state database when possible, but can fall back to reading local rollout JSONL logs. If the saved folder does not match the current one, it asks the user which location to trust before execution continues.

## [Main event loop and request dispatch](stage-10.md) `stage-10` — 137 files

This stage is the system’s steady working heartbeat. After startup is done, it sits in the middle of normal use and keeps the app responsive. It listens for user actions, incoming JSON-RPC messages (a structured request-and-response format), and background results, then decides where each one should go.

The interactive event dispatch side is the live front desk for the terminal interface. It gathers key presses, pasted text, redraw signals, server replies, and task results into one stream, then sends each event to the right screen or widget. That is how typing, popups, chat actions, and side panels all react smoothly.

The RPC request routing side is the switchboard for requests coming from other processes. It checks what was asked for, chooses the correct feature area, and turns bad inputs into clear protocol errors. session/handlers.rs is the main control layer for session operations. The exec-server processor does the same kind of routing for the execution server connection. request_serialization.rs makes sure requests touching the same resource happen in safe order. tools/parallel.rs runs tool calls together or one-at-a-time when needed, and cleans up correctly if a call is canceled.

### [Interactive event dispatch](stage-10.1.md) `stage-10.1` — 96 files

This stage is the app’s live switchboard during normal use. Once the terminal interface is running, it takes raw input events—key presses, pasted text, screen redraw nudges, server messages, and background task results—and sends each one to the right part of the UI.

At the bottom, event_stream.rs is the shared input broker. A broker is a middleman. It listens to terminal input and redraw signals, merges them into one stream of TUI events, and can safely stop and recreate that input connection when the app pauses or resumes.

From there, app-level dispatch acts like traffic control. It catches global shortcuts, turns events into internal commands, routes server replies, manages thread switching, remembers unfinished prompts, and asks for redraws.

The bottom-pane and popup layer handles typing, slash commands, mentions, file search, and temporary chooser windows. The chat widget then turns those actions into chat behavior: submitting messages, restoring drafts, reacting to protocol messages, and updating the transcript.

Specialized flows add side screens such as key remapping, task views, undo history, import helpers, and pickers. Together, these parts make the terminal feel responsive and organized.

#### [App-level event dispatch and thread routing](stage-10.1.1.md) `stage-10.1.1` — 10 files

This stage is the traffic control center for the text-based app. It sits in the app’s main work loop and decides where user actions, server messages, and background task results should go next.

At the front, app_event_sender.rs gives the rest of the UI a simple way to post app events and commands without repeating setup code. app_command.rs defines those commands: the app’s small internal “instruction language” for things like switching threads, approving actions, or changing settings. input.rs watches top-level keyboard input and catches app-wide shortcuts before passing other keys down to the chat area.

event_dispatch.rs is the hub. It pulls events from the queue and turns them into visible UI changes, server calls, config saves, thread switches, or app exit. thread_routing.rs manages separate conversation threads, including buffering events and replaying the right pending prompts when you switch views. pending_interactive_replay.rs remembers which prompts are still unresolved so only those are shown again.

On the server side, app_server_events.rs routes incoming server events into the right thread or UI area, while app_server_requests.rs keeps track of requests that need a later user answer. background_requests.rs offloads slow network or disk work, and frame_requester.rs schedules redraws efficiently so the screen updates smoothly without wasting work.

#### [Bottom-pane composer, popups, and mention input](stage-10.1.2.md) `stage-10.1.2` — 42 files

This stage is the system’s “typing and choice” area at the bottom of the terminal. It is part of the main work loop: while the app is running, this is where the user writes messages, picks commands, answers prompts, and changes settings.

At the center is the chat composer. It uses a textarea engine to manage text, cursor movement, wrapping, paste detection, optional Vim-style editing, attachments, and message history search. It also understands slash commands like “/name …”: one small parser reads the command shape, a command catalog says which commands exist, and popup logic shows matching choices as you type.

The same area also powers “@” mentions and file lookup. Plugin data and file-search results are gathered, turned into searchable candidates, filtered, ranked, and shown in a popup with selection and footer hints.

Around the composer is the bottom-pane host. It decides which view is active, sends keys to it, draws the footer and status area, and stacks temporary popups on top. Reusable selection widgets support many modal flows, such as status-line setup, title setup, skills, memories, hooks, feedback, app-link guidance, custom prompts, and request forms.

#### [Chat widget interaction and command flows](stage-10.1.3.md) `stage-10.1.3` — 23 files

This stage is the main “conversation control panel” of the terminal chat screen. It sits in the system’s main work loop: after startup, this is the part that reacts to what the user types, what the server sends back, and what the screen should show next.

At the center is chatwidget.rs, the stateful object that remembers the current chat, input box, notices, and popups. interaction.rs listens for keys and nearby actions like paste, copy, rename, interrupt, or quit. input_submission.rs turns drafted text, images, mentions, and extra context into actual requests, while input_flow.rs decides whether to send them now or queue them. input_queue.rs and input_restore.rs save unfinished drafts and bring them back later if a turn was interrupted.

slash_dispatch.rs routes slash commands like /usage, /goal, or /ide to the right feature modules. protocol.rs and protocol_requests.rs convert backend messages and requests into visible UI changes, approvals, and notices. rendering.rs draws the transcript, bottom pane, and temporary messages. The remaining files provide focused tools: notifications, interrupts, skills and connectors, hooks, goals, model and review popups, plan follow-up choices, reasoning shortcuts, and usage/token tracking. Together they make the chat widget feel responsive, stateful, and organized.

#### [Specialized interactive flows and auxiliary TUI handlers](stage-10.1.4.md) `stage-10.1.4` — 20 files

This stage covers the app’s special side journeys: focused interactive screens and helpers that sit next to the main chat loop. Think of it as the set of tool panels, popups, and mini-workflows that let a user inspect, choose, undo, import, or customize things without changing the core event system.

Several files build complete interactive views. The cloud-tasks files store the screen state for task lists and new-task composition, then draw those screens, overlays, and dialogs in the terminal UI. The keymap files power the guided “change my shortcuts” flow: one file lists the actions that can be rebound, others show the picker, capture key presses, and offer a debug view that explains what key the terminal actually sent.

Other files support browsing and recovery. Backtracking and pager overlays let users review transcript history, preview rollback, and confirm undo steps. Multi-agent navigation keeps track of agent threads and turns raw events into readable picker labels. Pet and theme pickers build selection popups, while pet runtime code loads animations and schedules frames. Clipboard and external-import helpers connect the UI to the outside world by reading pasted content, normalizing paths, and guiding config import flows.

### [RPC request routing](stage-10.2.md) `stage-10.2` — 37 files

This stage is the system’s switchboard. It sits in the main work path, after a message arrives over RPC, which is a structured request-and-response protocol. Its job is to inspect each incoming message, make sure the connection is allowed to ask for it, and send it to the right worker.

At the center, the app-server message processor builds all the specialized request processors and routes requests to them. Those processors cover major features: threads and turns for conversation flow, thread goals and deletion, catalogs and models for available capabilities, environments and Windows sandbox setup for execution context, file system access and file watching, search, feedback, Git, plugins, marketplace actions, remote control, MCP operations, and importing settings from external agents. Shared helpers normalize inputs and turn validation failures into protocol errors.

Other files support the same routing story in nearby servers. The exec-server handler, registry, RPC plumbing, and file/process handlers route lower-level execution requests. The MCP server processor and tool runner route MCP tool calls into Codex threads. Tool router and registry choose and run tools. Smaller adapters handle dynamic tool replies, attestation tokens, TUI event targeting, special error detection, and HTTP proxy request handling.

## [Thread and session orchestration](stage-11.md) `stage-11` — 44 files

This stage is the system’s conversation traffic controller. It sits around the main work loop and makes sure every piece of work belongs to the right thread or session. A thread is one ongoing conversation, while a session is the live in-memory object that keeps that conversation running, remembers its history, and sends events out to clients.

At the center, `thread_manager.rs`, `codex_thread.rs`, and the session files build and manage live threads: creating new ones, resuming old ones, forking side conversations, loading saved history, and shutting things down cleanly. `environment_selection.rs`, the state files, input queues, and task machinery provide the long-lived settings, pending inputs, and per-turn bookkeeping that let a session keep working over time.

The thread store files save and reload conversation history and metadata, while rollout truncation rebuilds the “effective” history when forks or rollbacks happened. App-server files keep loaded threads attached to client connections and forward events. TUI files let the user start, switch, and view threads, including temporary side threads. Extensions such as goals, skills, MCP, code mode, and external-agent import plug thread-aware behavior into this shared session lifecycle.

## [Prompt, context, and extension assembly](stage-12.md) `stage-12` — 74 files

This stage is the assembly line that prepares exactly what the model will see before it answers. It sits right in front of the main work loop: after the system knows the current situation, but before it sends the next request to the model.

One part provides the standard pieces and containers. It stores built-in instruction text, defines what a “context fragment” is—a small named piece of prompt text—and gives both core code and extensions a clean way to add those pieces. Another part supplies the actual fragments and prompt assets: reusable notes about permissions, environment details, skills, saved rules, shell results, interruptions, realtime session start and end, and compatibility with older saved conversations.

A third part gathers higher-level contributors. It pulls in user and project instructions, skills, plugins, apps/connectors, memories, goals, and review-specific guidance. A final part assembles the current turn itself. It snapshots settings and permissions, cleans and trims conversation history, adds only changed context, tracks token budget warnings, and builds special prompts for realtime or debugging. Together, these parts create one complete, model-ready briefing packet.

### [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files

This stage is shared behind-the-scenes support for building the text the AI model actually sees. Think of it as the parts bin and front desk for prompt assembly: it stores reusable instruction text, defines the shapes of context pieces, and gives the rest of the system one clean way to ask for them.

The embedded instruction sources are the raw materials. collaboration-mode-templates/src/lib.rs bundles the built-in collaboration instructions directly into the program as fixed text. codex-home/src/lib.rs provides the main entry point for getting the home-style user instructions.

The prompt and fragment facades are the public doors. prompts/src/lib.rs exposes the prompt crate’s constants, types, and helper functions. context-fragments/src/lib.rs and context-fragments/src/fragment.rs define what a “fragment” is: a small piece of context that can be rendered into text, converted for the protocol, and registered in a generic way. ext/extension-api/src/contributors/prompt.rs gives extensions a simple fragment type so they can place extra text into the right slot.

Finally, core/src/context/mod.rs gathers all core context pieces in one place, and permissions_instructions.rs re-exports one shared instruction type so core code can use it consistently.

### [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files

This stage provides the raw building blocks that the system later assembles into the text a model actually sees. It is shared behind-the-scenes support rather than the main work loop. Think of it as the bin of labeled parts and prewritten note cards used to build a prompt.

Some files embed fixed prompt assets directly into the program: instructions for agent coordination, using apply_patch, compact summaries, and realtime mode startup and shutdown. Other files define “context fragments,” which are small, structured pieces of text with stable markers so the system can insert facts consistently.

These fragments cover many kinds of information: extra key/value context, skill instructions and skill listings, internal hidden notes, environment details like time, permissions, and available subagents, token budget notices, saved command or network rules, AGENTS.md user instructions, shell command results, subagent status updates, interruption notices, and model-switch guidance. Realtime start and end fragments provide matching wrappers for live sessions. A few files only recognize older warning formats so saved conversations from past versions still make sense. Together, these parts give prompt assembly a reliable vocabulary and set of ready-made instructions.

### [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files

This stage is the system’s prompt-building workshop. Before the model answers, it gathers all the “rules of the road” and helpful background that should be visible for this turn. Think of it like assembling a briefing packet from many small sources.

Some parts load standing instructions: user-wide notes from the home folder, project files like AGENTS.md, collaboration-mode guidance, personality style, terminal display advice, image-generation rules, and permission limits such as sandbox and network access. IDE context can also be turned into prompt text and later peeled back out.

Other parts add optional abilities. Skills code finds skills the user mentioned, loads their SKILL.md text, and also lists other available skills within a size budget. Similar pieces describe installed apps/connectors and plugins, and can inject extra guidance when a specific plugin is named. Tool definitions are also rewritten into the code-mode format the model expects.

The rest add longer-lived memory and workflow steering. Memory prompts point to saved memories and summaries. Goal prompts steer continuation and objective updates. Review prompts build the exact instructions for code review flows, including how the review ends. Together, these pieces create the full model-visible instruction set.

### [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

This stage is the prompt-building workshop for each new turn. Its job is to gather everything the model should know right now, clean it up, and turn it into the exact input for the next reply. It sits in the system’s main work loop, right before the model is asked to generate output.

`turn_context.rs` creates a frozen snapshot of the current turn: settings, permissions, chosen tools, model details, and runtime services. `history.rs` keeps the conversation transcript in memory, trims it when needed, and preserves important pairings like a tool call and its result. `normalize.rs` repairs or removes malformed history so later code can trust it.

Several files add only what changed. `updates.rs` turns differences between turns into short injected messages. `additional_context.rs` tracks extra named context entries and emits updates only for changed values. `token_budget.rs` adds “tokens remaining” notices when usage crosses meaningful thresholds.

For realtime sessions, `realtime_context.rs` builds a compact startup summary and `realtime_prompt.rs` chooses the prompt text. `contextual_user_message.rs` separates real user text from internal context fragments. `prompt_debug.rs` recreates a one-off prompt for inspection, and `ext/web-search/src/history.rs` makes a small, text-only history for web search. Together, these pieces assemble a clear, bounded, model-ready prompt.

## [Turn execution and model interaction](stage-13.md) `stage-13` — 88 files

This stage is the heart of one chat “turn” — one cycle where the system takes new input, decides what extra prep is needed, asks the model for help, reacts to the streamed answer, and then wraps everything up. In the system’s story, this is the main work loop.

core/src/tasks/regular.rs starts a normal turn and keeps running the engine until there is no more pending input. The main conductor is core/src/session/turn.rs. It checks whether old conversation history should be compacted, runs hooks and tool setup, sends the request through the model transport layer, handles streamed replies, retries when needed, and records the finished result.

Compaction is the “pack the suitcase” step so long histories stay manageable. core/src/tasks/compact.rs chooses which compaction path to use. core/src/compact.rs does compaction locally inside the app, while core/src/compact_remote.rs asks the model provider to do it remotely. core/src/turn_metadata.rs adds extra per-turn facts, like session lineage and workspace details, to outgoing requests.

This stage also includes the code-mode JavaScript runtime. The runtime files create a small isolated JavaScript engine, load the user module, support simple timers, and turn tool-call results back into JavaScript promises. Together, these parts let one turn move smoothly from input to final saved outcome.

### [Model transport execution](stage-13.1.md) `stage-13.1` — 28 files

This stage is the system’s “send the request and bring the answer back” layer. It sits in the main work path whenever the app talks to a model provider, and it also supports startup by prewarming a connection so the first real request is faster.

At the center, core/src/client.rs builds requests, picks the right transport, adds authentication, and keeps session state such as sticky routing and reusable websocket connections. Small shared pieces in client_common.rs and responses_metadata.rs define the prompt, stream wrapper, and the metadata that rides along with each request. Request-shaping helpers in responses.rs and tools/src/responses_api.rs turn internal inputs and tool descriptions into the exact wire format the provider expects.

The codex-api endpoint files are the actual couriers: HTTP and server-sent events for normal Responses, WebSocket for bidirectional streaming, plus compact history, memory summaries, images, search, and realtime call setup. Their decoders turn raw events into typed internal messages, while api_bridge.rs converts transport failures into user-facing errors. Retry, fallback, and prewarm logic keep requests resilient. Realtime websocket and WebRTC files handle live audio/text sessions, and compact_remote_v2.rs extracts a single compaction result from a streamed response.

### [Streaming reduction and UI projection](stage-13.2.md) `stage-13.2` — 51 files

This stage is the “live translator” between raw incoming events and what the user actually sees while a response is streaming. It sits in the main work loop. As text, tool activity, and status updates arrive, it turns them into stable transcript entries plus a live tail that can still change.

The stream-parser files clean up assistant output as it arrives. They remove hidden citation tags, pull out hidden proposed-plan blocks, and keep the visible text separate from those side channels. On the TUI side, markdown collectors and controllers decide when a chunk is safe to commit, with special holdback for markdown tables so half-finished rows are not frozen too early. Markdown, syntax highlighting, diff rendering, and table fallback code then turn source text into terminal-friendly lines.

History-cell and exec-cell modules define the different transcript building blocks: messages, plans, approvals, command runs, searches, notices, patches, hooks, and more. ChatWidget state and lifecycle code keeps these pieces updated during a turn, including command progress, hook runs, status lines, token and rate-limit info, and final consolidation into durable transcript cells. Resize and reflow code then rebuilds the transcript cleanly when the terminal shape changes.

## [Tool execution, approvals, and guarded side effects](stage-14.md) `stage-14` — 294 files

This stage is the system’s “action desk” in the main work loop. After the model decides it wants to do something in the real world, this is the machinery that turns that request into a safe, tracked action. It checks whether the action is allowed, asks for approval when needed, runs the action in the right environment, and then turns the result back into something the model can understand.

The gatekeeper part mediates approvals, safety reviews, and hooks, which are optional outside checks that can warn, block, or allow an action. The execution backends are the engine room: they actually run shell commands, apply file patches, and manage restricted command sessions. Extension and integration tools connect to outside tool providers such as MCP servers, plugins, web, image, memory, skills, and code helpers. The sandbox and command-safety helpers act like the rulebook and inspectors, deciding what commands mean and what restrictions should apply.

The directly assigned files provide the common language for all this. They define what a tool is, how tool schemas are cleaned up, how MCP tools are translated, how errors are split into recoverable versus fatal cases, and shared helper utilities used by many tool handlers.

### [Approval, guardian, and hook mediation](stage-14.1.md) `stage-14.1` — 63 files

This stage is the system’s gatekeeper and referee during the main work loop. Whenever the assistant wants to do something with real-world effects—run a command, edit files, use the network, or ask the user a question—this stage decides whether to allow it, pause for approval, get a second opinion, or stop it.

One part takes incoming “please ask” requests from tools and integrations and converts them into one standard form. The policy engine then checks written rules, sandbox limits (a restricted safety environment), and saved choices to decide what is allowed. If a case is sensitive, the guardian review system opens a special mini-session and asks a reviewer model to assess it safely.

Hooks are optional outside programs that can inspect key moments before or after actions. They can add warnings, block an action, or say it may continue. The orchestration and UI layer turns all of these decisions into clear approval dialogs, collects the user’s answer, and resumes the tool run with the right permissions. Finally, the enforcement runtimes make those decisions real by applying live network and Windows file-access restrictions.

#### [Approval policy and request-decision engines](stage-14.1.1.md) `stage-14.1.1` — 14 files

This stage is the system’s gatekeeper. It sits in the main decision path whenever the agent wants to run a command, edit files with a patch, use the network, or relax sandbox limits. Its job is to answer a simple question: can this go through automatically, does it need the user’s approval, or must it be blocked?

The newer execpolicy files are the main engine. The parser reads rule files and turns them into an internal policy, while keeping source locations so error messages can point to the right line. The rule and policy files define what a rule looks like and how a real command or network request is checked against it, including host-name cleanup and layered policy merging. The public library file ties these pieces into one API.

In core, exec_policy.rs uses those policies with sandbox state, fallback heuristics, and approval settings to make final command and network decisions. sandboxing.rs provides shared approval memory and sandbox override rules. network_policy_decision.rs converts blocked network events into prompts and saved rule updates. safety.rs does the same kind of judgment for apply_patch.

The legacy execpolicy files are the older checker kept for compatibility. They parse older policy files, match programs and arguments, and do a final file-path safety check before execution.

#### [Guardian review and mediated approval sessions](stage-14.1.2.md) `stage-14.1.2` — 6 files

This stage is the system’s “second opinion” desk. It runs when an action needs mediated approval, not during startup or shutdown. Its job is to turn a raw approval event into a careful review, ask a guardian reviewer model to assess it, and report the result safely.

At the foundation, guardian/mod.rs defines the shared building blocks for this subsystem and includes a circuit breaker, which is a safety stop that cuts off a turn after too many automatic denials. approval_request.rs translates each approval case into the different forms the rest of the system needs: JSON data, analytics records, assessment actions, and readable prompt text.

prompt.rs then assembles the actual review prompt from the request plus useful session history, trims that history to keep it compact, and reads the reviewer’s structured JSON answer back into internal data. session/review.rs opens a special review sub-turn inside the current session, with tighter limits and a seeded prompt. review_session.rs runs the reusable nested review sessions themselves, including reuse, temporary forks, and cancellation. Finally, review.rs is the conductor: it routes requests, launches reviews, retries when needed, records outcomes, publishes events, and connects everything to safety tracking.

#### [Hook execution and stop-continue mediation](stage-14.1.3.md) `stage-14.1.3` — 16 files

This stage is the system’s “checkpoint and referee” layer. It sits around the main work of a session and asks optional outside programs, called hooks, whether something should proceed, stop, be blocked, or add extra notes for the model. In other words, before and after key moments, it gives custom rules a chance to speak.

The registry and engine are the front door. They discover which hooks exist from settings and plugins, prepare them in a consistent form, and expose simple preview and run calls. The dispatcher then picks the hooks that match a specific event and runs them, often in parallel, while keeping results in a predictable order. The command runner launches each hook as a child process, and the output parser reads its JSON response and turns it into structured decisions. If a hook prints too much, output spilling saves the full text to a temp file while keeping a smaller version in memory.

Event files handle each situation: session start, user prompt submission, tool use before and after, permission requests, stopping, and compaction. The core runtime connects all of this to live sessions, emits events and metrics, and gathers any extra context hooks produce. Legacy notify keeps older hook commands working too.

#### [Permission and elicitation request ingress](stage-14.1.4.md) `stage-14.1.4` — 5 files

This stage is one of the system’s front doors. It sits between outside callers such as tools or MCP integrations and the deeper approval and review machinery. Its job is to take different kinds of “please ask the user” requests, clean them up into a standard shape, and pass them inward so the system can decide whether to approve automatically or wait for a person.

The request_permissions tool is the entry point for permission requests. It reads what access is being asked for in the chosen execution environment, turns the request into normalized permission profiles, and sends it to the session for approval. The request_user_input tool does the same kind of intake work for general user questions: it checks that the call is valid, parses the arguments, and forwards the request, then returns the user’s reply.

On the MCP side, elicitation.rs keeps track of pending elicitation requests, meaning structured prompts sent out for approval or input. It applies policy rules, auto-resolves what it can, and emits events for anything that needs review. exec_approval.rs and patch_approval.rs create those MCP requests for command execution and code changes, then convert the client’s answer back into the system’s own approval format.

#### [Approval-mediated tool orchestration and approval UI](stage-14.1.5.md) `stage-14.1.5` — 12 files

This stage is the traffic controller for risky or important tool actions. It sits in the main work loop, between “the assistant wants to do something” and “the system is allowed to do it.” Its job is to decide what needs user approval, show that clearly, collect the answer, and then continue with the right safety settings.

At the center, core/src/tools/orchestrator.rs runs the full flow: ask for approval, choose a sandbox (a restricted run environment), register any network permission needs, run the tool, and retry with broader access if policy allows. core/src/mcp_tool_approval_templates.rs supplies the exact wording for connector-specific approval messages, with readable names for parameters.

On the screen side, tui/src/approval_events.rs reshapes raw approval requests into UI-friendly forms. approval_overlay.rs shows the actual approval dialog, while request_user_input/mod.rs handles richer questionnaires that need structured answers. tool_requests.rs ties incoming requests to visible popups, notifications, footer status, and final transcript entries. permission_popups.rs and permissions_menu.rs let the user choose permission levels, with windows_sandbox_prompts.rs covering Windows-specific setup and warnings. pending_thread_approvals.rs surfaces approvals waiting in other threads, auto_review_denials.rs summarizes recent automatic denials, and hooks_rpc.rs fetches hook review details and saves trust decisions.

#### [Approval-adjacent enforcement runtimes](stage-14.1.6.md) `stage-14.1.6` — 10 files

This stage is the “rules are actually enforced” part of the system. It sits just after a policy decision has been made and during normal execution. Its job is to keep live network and file protections in place, especially for actions that need approval.

The network proxy files are one half of this. The crate root wires the proxy subsystem together. state.rs takes raw policy settings and turns them into a checked, ready-to-use runtime form, including allowed and blocked host patterns and optional MITM state, meaning traffic inspection settings. runtime.rs is the live engine: it keeps the current policy in memory, can reload it, records blocked requests, and lets HTTP and SOCKS traffic ask “is this allowed?”. network_policy.rs defines the question-and-answer format for those checks and writes audit records. network_approval.rs connects blocked network attempts to the approval flow for tool runs: it groups repeated prompts, remembers per-session choices, and turns denials into clear tool errors.

The Windows sandbox files are the other half. windows_sandbox_read_grants.rs safely adds an extra readable folder. deny_read_state.rs remembers long-lived deny rules. workspace_acl.rs locks down sensitive workspace folders with ACLs, which are Windows permission lists. wfp.rs installs Windows Filtering Platform network blocks, and wfp_setup.rs does that setup carefully so failures are logged and measured without stopping everything else.

### [Execution backends and sandboxed command runtimes](stage-14.2.md) `stage-14.2` — 91 files

This stage is the system’s “make commands actually happen” layer. It sits in the main work path whenever the app needs to run something like a shell command, an interactive terminal session, or a file-editing patch. Think of it as a workshop with a front desk, engine room, safety gear, and platform-specific tools.

One part receives run requests from the app and turns them into tracked command sessions. Another part is the low-level engine that starts programs, connects their input and output, supports both simple pipes and PTYs (fake terminals that act like a real command window), and keeps sessions alive or stops them cleanly. The patch pieces reuse this machinery to apply file changes safely, by parsing patch text, checking permissions, and editing files in the right environment.

Safety is a big theme here. Unix sandbox launchers choose how restricted a command should be and start it that way. The exec-server filesystem services do file work either directly, through a sandbox, or by forwarding to another server. On Windows, separate code prepares restricted accounts and launch settings. The sleep tool also lives here: it pauses for a while, but can wake early if new user input arrives.

#### [Execution-facing app-server and core command orchestration](stage-14.2.1.md) `stage-14.2.1` — 15 files

This stage is the system’s “run a command” front desk and dispatcher. It sits in the main work path: when a user, tool, or screen asks to run a shell command, these pieces translate that request into a real process, start it safely, stream output back, and let later messages write input, resize a terminal window, or stop the process.

On the app-server side, command_exec_processor.rs and process_exec_processor.rs receive JSON-RPC requests, which are network messages between parts of the app. They hand work to command_exec.rs, which keeps track of running sessions per connection and sends output and final results back. tui/src/workspace_command.rs is the TUI’s simple “run this command here” wrapper, and tui/src/app_server_session/fs.rs adds matching file-system request helpers.

In core, exec.rs is the actual safe process runner. sandboxing/mod.rs converts sandbox decisions into a ready-to-run execution request. user_shell.rs powers the /shell task. The shell and unified_exec handlers and runtimes are the traffic controllers: they check permissions, prepare arguments, support patch interception and hooks, choose the right backend, and launch either normal shell commands or long-lived terminal-style sessions. zsh_fork_backend.rs adds an optional Unix-specific path.

#### [Unified-exec sessions and PTY/process backends](stage-14.2.2.md) `stage-14.2.2` — 17 files

This stage is the engine room for interactive command sessions. It sits under the main features and does the hard low-level work of starting programs, talking to them while they run, and stopping them cleanly on Unix and Windows.

At the top, unified_exec/mod.rs defines the shared request, context, and storage pieces, and errors.rs describes the common ways this work can fail. process.rs wraps one running command so the rest of the system can treat local, remote, PTY, and pipe-based processes the same way. A PTY is a fake terminal that makes a program behave as if a person is typing into a real terminal. process_manager.rs is the traffic controller: it assigns process IDs, launches commands, stores active sessions, forwards input, collects output, and cleans up. write_stdin.rs is the small entry point used when a user sends more keyboard input.

On the exec-server side, process.rs defines the common contract, local_process.rs runs commands on the same machine, and remote_process.rs talks to a process through another server session. spawn.rs performs the actual OS launch with sandbox and environment settings. The utils/pty files provide the two concrete backends: ordinary pipes for simple input/output, and PTYs for full terminal behavior, plus Unix process-group helpers and Windows ConPTY support.

#### [Patch application engine and patch-execution adapters](stage-14.2.3.md) `stage-14.2.3` — 9 files

This stage is the system’s “edit worker.” It sits in the main work path whenever the system is asked to change files by sending an apply_patch command. Its job is to understand the requested patch, check whether it is safe and allowed, and then carry out the file changes in the right environment.

The process starts with the tool definition in apply_patch_spec.rs, which tells the system what this command can look like. apply_patch.rs is the coordinator: it reads the incoming patch text, validates it, figures out what permissions are needed, prepares hook data for surrounding systems, and reports progress as the patch is processed.

The lower-level patch engine lives in the apply-patch library. streaming_parser.rs reads patch text bit by bit, while parser.rs turns it into a checked in-memory patch description. invocation.rs also understands command-line or shell-wrapped forms of the same request. lib.rs then does the real editing work: it computes replacements, updates files, makes diff output, and tracks partial success if some edits fail.

core/src/apply_patch.rs decides whether to reject, approve, or hand off the request. core/src/tools/runtimes/apply_patch.rs runs approved work inside the sandbox, the system’s controlled file area. git-utils/src/apply.rs is a helper that can use git apply for diff-based file changes when needed.

#### [Sandbox selection and Unix platform launchers](stage-14.2.4.md) `stage-14.2.4` — 16 files

This stage is the “safe launch” layer for Unix systems. It sits just before a command actually starts running. Its job is to decide how locked down the command should be, translate that decision into the exact form Linux or macOS tools expect, and, when needed, arrange a privileged re-launch through the user’s shell.

The main entry point is the sandboxing library. Its crate root exposes the public API, while manager.rs is the traffic controller: it takes a general launch request plus a permission profile and turns that into a real OS-specific command. On Linux, bwrap.rs checks whether bubblewrap, the external isolation tool, is usable and warns if not. landlock.rs and core/src/landlock.rs build and pass the right arguments to the Linux helper. Inside that helper, linux-sandbox/src/bwrap.rs creates the actual filesystem restrictions, linux-sandbox/src/landlock.rs applies extra in-process limits, and the bundled_bwrap.rs and launcher.rs files find and start the right bubblewrap binary.

Alongside this, the shell-escalation files provide a Unix request-and-approval path for commands that may need elevated execution. The runtime helpers in core rewrite shell commands and environment settings so both sandboxing and escalation work cleanly together.

#### [Exec-server filesystem sandbox services](stage-14.2.5.md) `stage-14.2.5` — 6 files

This stage is the exec server’s file access layer: the part that lets the server read, write, list, copy, and delete files while deciding how safe or direct that access should be. It sits in the system’s main working path and acts like a switchboard between callers and different kinds of filesystem access.

file_read.rs manages open file-reading sessions for each client connection. It lets a client ask for specific chunks of a file, with limits so reads stay controlled. local_file_system.rs is the normal backend that talks to the host machine’s filesystem and is the concrete implementation used for most file operations. sandboxed_file_system.rs offers the same kind of file operations, but sends them through a sandbox, meaning a restricted environment with only approved permissions. fs_helper.rs defines the message format used to ask that sandbox helper to do work, and also includes a direct in-process executor for the same operations. fs_sandbox.rs actually launches and manages the helper process, works out its permissions, and turns its replies back into normal results. remote_file_system.rs is the network version: instead of touching local files, it forwards requests to another exec server over RPC, a remote procedure call.

#### [Windows sandbox provisioning and process-launch internals](stage-14.2.6.md) `stage-14.2.6` — 27 files

This stage is the Windows-only machinery that prepares a locked-down user account and actually starts commands inside it. It sits between setup and the main work of running a sandboxed process.

At the top, lib.rs is the public front door. unified_exec chooses how to run a command: either the newer elevated path, which talks to a separate helper process with framed IPC (a message stream with clear packet boundaries), or the legacy path, which launches the process directly with restricted tokens. setup.rs and identity.rs make sure the sandbox account and its saved credentials exist, are still valid, and match the requested permissions.

Several files build the safety rules. token.rs creates restricted Windows security tokens, acl.rs edits access-control lists (the allow/deny rules on files and objects), deny_read_acl.rs blocks reads from chosen paths, audit.rs checks risky writable locations, hide_users.rs keeps sandbox accounts less visible, and firewall.rs plus wfp filter specs limit networking.

Finally, spawn_prep.rs, process.rs, desktop.rs, proc_thread_attr.rs, conpty, runner_client, runner_pipe, elevated_impl, and stdio_bridge handle launch details: private desktops, terminal support, pipes, helper handshakes, and connecting the sandboxed program’s input and output back to the app.

### [Extension and integration tools](stage-14.3.md) `stage-14.3` — 117 files

This stage is the system’s “extra tools desk.” It is mostly part of the main work loop: when the app is already running and needs something beyond its built-in abilities, these pieces decide what outside-powered tools exist, connect to them, and carry out requests.

One part is the live MCP connection layer. MCP is the protocol this app uses to talk to outside servers. It keeps those connections healthy, lists the tools and resources those servers offer, asks for approval when needed, and runs calls safely.

Another part manages plugins and connectors. Think of it as the store and inventory room for add-ons. It finds plugins, reads their manifests, installs or removes them, syncs remote copies, and decides which connectors and suggested apps should be shown to users.

A third part is the runtime for extension-backed tool namespaces such as web search, image generation, memories, skills, and code-mode helpers. It registers these tools, describes them to the model, checks inputs, and runs the real backend work.

Finally, app-server discovery and search adapters turn all that raw plugin and connector data into clean app lists and file-search results the client can use.

#### [MCP runtime, resources, and session integration](stage-14.3.1.md) `stage-14.3.1` — 22 files

This stage is the live wiring that lets the app talk to MCP servers during a session. MCP is the protocol used to reach outside tools and data sources. In the system’s story, this is mostly main-loop work: after setup has chosen servers, these pieces keep connections alive, expose what those servers can do, and carry calls back and forth.

At the center, codex-mcp provides the public MCP API. Its server and config modules describe each server, build the effective server list, and capture snapshots of available tools and resources. The connection manager is the session’s switchboard: it starts clients, refreshes them, gathers tools and resources, routes tool calls, and handles auth prompts. The resource client gives the rest of the app a simple, always-current way to list and read resources.

On top of that, core session code refreshes MCP state and approval flows. Tool handlers turn discovered MCP tools and resource operations into model-callable actions, while mcp_tool_call runs a full call from arguments through approval, execution, cleanup, and telemetry. Other files decide which tools are visible, rewrite file inputs, detect auth failures, add skill-required servers, and register MCP-backed extensions with the app server.

#### [Plugin and connector ecosystem management](stage-14.3.2.md) `stage-14.3.2` — 34 files

This stage is the system’s “plugin and connector shop and warehouse.” It is shared support that powers both setup and everyday use. Its job is to find extra tools, decide which ones are allowed, install or remove them, keep remote copies in sync, and expose all of that to the command line and on-screen interface.

At the center, core-plugins/src/lib.rs ties the whole plugin subsystem together. Manifest, provider, marketplace, and loader read plugin.json and marketplace.json files, turn them into clean typed records, and load the actual capabilities a plugin offers. manager.rs then acts like the foreman: it coordinates caching, listing, install and uninstall work, and refreshes.

The marketplace_add, marketplace_upgrade, and marketplace_remove pieces manage plugin catalogs from local folders or Git repositories. remote.rs, remote_legacy.rs, remote_bundle.rs, and the remote sharing files handle plugins that live on servers: fetching catalogs, downloading bundles safely, syncing installed remote plugins, and sharing workspace plugins with others.

The connectors and discoverable files decide which app connectors are visible and which plugins are worth suggesting. Finally, the tool handlers, CLI command, and TUI screen turn all of this into user-facing actions like browse, install, suggest, and manage.

#### [Extension-backed tool runtimes and namespaces](stage-14.3.3.md) `stage-14.3.3` — 56 files

This stage is the “tool room” for features that are not hard-wired into the core system. It sits behind the scenes during each turn and decides which extra abilities are available, how they are described to the model, and how calls are carried out.

At the center is the per-turn planner, which builds the tool registry and the public tool descriptions. Some files only describe tools, like update_plan, new_context, agent jobs, tool search, image viewing, and code-mode tools. Others do the actual work: running extension tools, handling thread-local dynamic tools, searching the available tools, loading an image file for model use, or reporting how much context space remains.

A big part of this stage is adapters. They translate between outside systems and the core runtime: extension registries, dynamic tool definitions, hosted tool settings, and the code-mode runtime, which runs restricted JavaScript with safe helper callbacks. Around that are concrete extension namespaces: web search, image generation, goals, memories, and skills. Each extension registers itself, exposes its tools, validates inputs, runs backend work, and turns results back into normal tool outputs so the rest of the system can treat them consistently.

#### [App-server integration discovery and search adapters](stage-14.3.4.md) `stage-14.3.4` — 5 files

This stage sits at the app server boundary, where raw integration data is turned into client-facing features. It is part of the system’s main work: answering requests for app listings and file search, using information gathered from connectors, plugins, and search tools.

The connector files work together to build a clean catalog. accessible.rs starts with many connector-tool records and turns them into the set of connectors a user can actually use. It removes duplicates, fills in missing pieces from repeated records, gathers friendly plugin names, and works out install links. filter.rs then applies the product rules: which connectors should be hidden, and which ones are discoverable but not yet available, so the system can suggest useful tools. merge.rs combines everything into one sorted app list, mixing directory data, plugin findings, and accessible connectors, and creating placeholder entries when a plugin points to an app the directory does not know yet.

On top of that, apps_processor.rs serves the apps/list request. It can answer quickly from cached data, then refresh in the background and send update notifications as better results arrive. fuzzy_file_search.rs does the same kind of translation for file search, including interactive search sessions, limits, cancellation, and ignoring out-of-date results.

### [Sandbox policy generation and command-safety parsing helpers](stage-14.4.md) `stage-14.4` — 17 files

This stage is shared behind-the-scenes support for deciding whether a tool may run a command, and if so, inside what kind of sandbox. Think of it as the rulebook plus the inspectors.

On the sandbox side, policy files describe what command arguments and options are allowed. `arg_matcher.rs` and `opt.rs` define those policy building blocks, while `arg_type.rs` checks real argument text against concrete types such as paths or other restricted values. `sed_command.rs` is a special guardrail for `sed`, only accepting a very small safe subset. `policy_transforms.rs` takes broad permission requests and merges them into one concrete runtime policy. `seatbelt.rs` then turns that policy into actual macOS sandbox rules, and `linux-sandbox/build.rs` makes sure Linux sandbox builds refresh when the bundled bubblewrap version marker changes.

On the command-analysis side, `bash.rs`, `powershell.rs`, and `parse_command.rs` peel away shell wrappers and summarize what a command is trying to do. `command_canonicalization.rs` produces stable command identities for approval caching. The `command_safety` files then judge commands: safe read-only ones, clearly dangerous ones, and Windows-specific cases, with `powershell_parser.rs` using a helper process to parse PowerShell scripts reliably.

## [Multi-agent, collaboration, and background workflows](stage-15.md) `stage-15` — 39 files

This stage adds “extra workers” on top of the normal one-turn-at-a-time session flow. It is shared support for cases where the system needs to split work, keep background tasks running, or let one agent talk to another.

The core agent modules are the traffic control center. They define agent roles, keep a live registry of active agents, resolve names or paths into real agent threads, and manage limits such as how many child agents can run at once or stay loaded in memory. The spawn and control code creates, resumes, interrupts, closes, and routes messages between these agents. Session-prefix and completion-message helpers turn internal agent events into clear model-visible messages.

On top of that, the multi-agent tool handlers expose these abilities as tools: spawn an agent, send input, wait for it, list it, resume it, or close it. The V2 tools add mailbox-style messaging and follow-up tasks. Delegation and review mode use the same machinery for specialized child conversations.

Other parts build background workflows from this foundation: CSV agent jobs fan work out across many workers, the memories pipeline extracts and consolidates long-term notes, and the skills watcher notices file changes and tells the server to refresh.

## [Result persistence, projection, and user-visible state updates](stage-16.md) `stage-16` — 55 files

This stage is the “make it stick and show it” part of the system. After a turn of work happens, these pieces save the important facts, rebuild a clean picture of the thread, and push updates out to users and other programs.

At the core, rollout and state files decide what gets recorded and extract metadata such as thread name, status, and settings. Reconstruction code can later replay those saved items to rebuild history, summaries, and resume information. Import, archive, unarchive, and metadata-update code keeps stored threads consistent over time.

Several mapping layers then translate low-level events into higher-level items a client can understand. They build thread history, visible notifications, tool output, review text, shell-command records, diffs, and agent status. Event handlers in the app server use those translations to mutate thread state, answer waiting requests, replay missed usage data, and track each thread’s public status.

Finally, presentation code turns that rebuilt state into what people actually see: exec JSONL output for machines, doctor command text for the CLI, and transcript cells, status lines, goal and rate-limit indicators, branch summaries, and activity previews for the text UI.

## [Shutdown, cleanup, and teardown](stage-17.md) `stage-17` — 4 files

This stage is the system’s “tidy up and turn off the lights” step. It runs when a connection, session, or whole process is ending. Its job is to stop new work from starting, let in-flight work finish when possible, and then clean up anything still left so shutdown is orderly instead of abrupt.

One part, connection_rpc_gate.rs, acts like a door guard for each connection. It flips a shared “no new requests” switch, but keeps count of work that already started so those tasks can finish cleanly. connection_cleanup.rs is the cleanup crew for that same connection. It starts small cleanup jobs, waits for them one by one or all at once, and can cancel any stragglers if shutdown time runs out.

legacy.rs handles older agent threads. It closes them, also closes any child threads they created, and saves the final thread-tree state so the system remembers what ended.

update_loop.rs is a special Unix-only background daemon piece. It watches for installer updates, swaps in a new managed binary when needed, and restarts the daemon so the updated version takes over.

## [Protocol schemas, shared types, and generated contracts](stage-18.md) `stage-18` · (cross-cutting) — 174 files

This stage is the project’s shared contract shelf. It sits behind the scenes and supports every phase of the system, from startup to the main work loop to saving results. Its job is to make sure every part of the codebase describes data the same way, so messages, saved records, and API calls all line up.

One part defines the core shared types: the common names and shapes for things like sessions, threads, tools, permissions, errors, and stored state. Another part defines the app-server’s wire contract: the exact message envelopes, versioned request and response formats, and schema exports that clients and servers exchange.

A third part covers generated contracts for backend services and protobuf, a compact binary message format used between services. These generated models let handwritten code talk to other systems without inventing its own structure. Another part adds schemas for public APIs, plugins, hooks, tool protocols, code-mode messages, and trace records. Finally, compile-time macro support automatically marks and tracks experimental API pieces while the code is being built. Together, these parts act like one rulebook for the whole system.

### [Core shared protocol and domain types](stage-18.1.md) `stage-18.1` — 46 files

This stage is the project’s shared language book. It sits behind the scenes and gives all the other parts a common set of names, shapes, and rules for the data they pass around. Without it, each part would describe sessions, tools, permissions, or errors differently.

The main protocol crate is the center. It defines the big message formats for sessions, turns, user input, outputs, approvals, accounts, models, configuration, network and filesystem rules, command parsing, memory citations, and error reporting. Small focused files provide safe ID types like SessionId and ThreadId, checked path and tool-name values, readable command output decoding, and the permission logic that explains what the sandbox may read, write, or reach on the network.

Around that core are matching shared types for plugins, tools, config, cloud tasks, skills, state storage, thread persistence, TUI events, and execution-policy decisions. These crates act like agreed-upon forms used by many teams. Together they make sure that data stays consistent when it moves between runtime code, saved records, APIs, generated schemas, and user-facing clients.

### [App-server protocol schemas and transport contracts](stage-18.2.md) `stage-18.2` — 43 files

This stage defines the “language” the app server speaks and the envelopes it uses to send that language over the wire. It is shared behind-the-scenes support, not the main work itself. Think of it as the official forms, mailing envelopes, and mailing rules that let clients, servers, and tools agree on what every message means.

At the base, jsonrpc_lite.rs defines the common JSON-RPC message shape: requests, responses, notifications, and errors. common.rs connects those envelopes to named app-server actions, while serde_helpers.rs handles a few fields whose JSON form needs special treatment. protocol/mod.rs, lib.rs, and the v2 module files organize and re-export the whole contract.

The versioned files describe the actual payloads. v1.rs keeps older clients working. mappers.rs translates old command requests into the newer v2 format. The many v2 files define concrete message types for threads, turns, items, reviews, accounts, models, permissions, config, plugins, files, processes, remote control, realtime audio, and more.

experimental_api.rs, export.rs, and schema_fixtures.rs turn these Rust definitions into JSON Schema and TypeScript so other code can use the same contract. The transport and error files add the paired sending rules, outgoing message types, remote-control transport details, and standard error codes.

### [Generated backend and protobuf contracts](stage-18.3.md) `stage-18.3` — 24 files

This stage is the system’s translation layer. It sits behind the scenes and defines the exact shapes of messages shared with other services, so the handwritten code can speak to the backend and other processes without guessing.

Most of the files in codex-backend-openapi-models are generated from an API description. They act like forms: task summaries and full task responses, pull request data, rate-limit and spending status, credit status, and delivered config files such as config.toml fragments. The crate root and models/mod.rs gather these generated pieces into one place and expose only the models the rest of the workspace uses.

backend-client/src/types.rs is the practical adapter on top. It deals with backend JSON that is not always consistent, then offers cleaner helpers for things like account checks, rate-limit details, task diffs, assistant messages, and errors.

The protobuf files play a similar role for binary service-to-service messages. The thread-config file defines messages and gRPC plumbing for loading remote thread settings. The exec-server relay protobuf defines the low-level relay packets, while relay_proto.rs re-exports just the parts the rest of exec-server needs.

### [API, extension, hook, MCP, and trace schemas](stage-18.4.md) `stage-18.4` — 60 files

This stage is a shared “dictionary of forms” for parts of the system that talk across boundaries. It is not one step in startup or shutdown. Instead, it supports the main work by making sure outside services, plugins, tools, and tracing all agree on the exact shape of messages.

One part defines code-mode protocol types: the common request and response shapes for running code, waiting for results, returning text or images, and tracking long-lived code sessions. Another part defines the public API schemas used when this system talks to the Codex service, including normal requests, streaming updates, websocket messages, image and search payloads, and a standard error format.

The extension and hook contracts are the rules plugin authors code against. They describe what callbacks exist, what data extensions receive, what the host can offer them, and how hook messages are shaped. Tool and protocol schemas do the same for tool calls, permissions, user questions, planning, shell actions, and MCP-related tool data. Finally, wire models define cross-process message formats for exec servers and sandboxing, while rollout trace models store a compact history of what happened during a run.

#### [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files

This stage is the shared contract for “code mode.” It does not run code itself. Instead, it defines the common language that the rest of the system uses to talk about code execution, results, and long-running sessions. Think of it as the forms, labels, and rules that let different parts of the system cooperate without guessing.

The crate root, lib.rs, ties everything together and exposes the official tool names, so callers know which tools exist and how to refer to them. description.rs explains those tools in a human-friendly and machine-friendly way. It describes the exec and wait tools, supports nested tools, can turn JSON Schema into TypeScript type text, and can read a special first-line // @exec: hint from JavaScript source.

runtime.rs defines the actual request and response shapes for running code and waiting for work to finish, including “still pending” states and nested tool-call data. response.rs defines the content carried back and forth, such as text and images, plus image quality hints. session.rs defines the higher-level session agreement: IDs for code cells, wrappers for started cells, and the traits—shared interfaces—that runtimes, session managers, and hosts must implement.

#### [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files

This stage is the public “language guide” for talking to the outside Codex service. It is shared support rather than the main work loop: other parts of the system use these definitions whenever they send a request, receive a reply, or report an error.

The crate root in lib.rs is the front desk. It gathers the important pieces from inside the package and re-exports them so the rest of the code can use one stable public interface. common.rs provides the standard shapes for messages used in many places, such as normal API requests, streamed events, websocket messages, and controls for text output. error.rs defines one common ApiError type so different kinds of failure—network trouble, bad protocol data, rate limits, or service-specific problems—can be treated in a consistent way.

The remaining files describe special-purpose message formats. protocol.rs covers the realtime websocket protocol and routes incoming events to the right parser version. images.rs defines the payloads for creating or editing images. search.rs defines the rich request and response formats for search features like web, finance, weather, sports, and time queries. Together, these files make sure both sides agree on exactly what each message means.

#### [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files

This stage is the public contract layer for extensions and hooks. It sits behind the scenes, but it is crucial: it defines the stable “rules of the road” that plugin authors code against, so the rest of the system can call them safely and consistently.

The extension API files are the front door. lib.rs and capabilities/mod.rs gather the public pieces into one stable surface. The capability files describe what the host can offer an extension: starting helper agents, sending events outward, or adding response items into the current reply. contributors.rs then defines all the callback points where extensions can join in, while the contributor data files describe the exact input passed for thread, turn, tool, and MCP server events. user_instructions.rs covers how extensions receive startup instructions, and state.rs gives them typed storage for shared data.

A few nearby files define specific contract boundaries too: goal events wrap one kind of update into the host’s event format, memories/backend.rs defines the storage interface for saved memories, and tui/ide_context.rs defines the shape of IDE context data.

The hooks files do the same job for hooks: declarations name hooks, types define execution results, schema.rs defines the JSON message shapes, and schema_loader.rs makes those schemas easy for the hook engine to load and use.

#### [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files

This stage defines the shared “contracts” for tools and messages. A contract here means the exact shape of data that different parts of the system agree to send and receive. It sits behind the scenes, but it is crucial during the main work loop whenever the model calls a tool, asks the user something, requests permissions, or exchanges data with external clients.

Several files define the common building blocks. tool_payload.rs and tool_call.rs describe what a tool request looks like, what context travels with it, and how results are emitted. tool_spec.rs describes how tools are advertised to the model in the JSON format the API expects. context.rs and the code-mode response adapter turn internal tool outputs into the protocol items other layers can understand. function_tool.rs shares a common error type.

Other files define exact schemas for specific tool families: permissions requests, user-input requests, planning, shell tools, context checking, goals, web search, and MCP-facing codex tools. hook_names.rs and mcp_approval_meta.rs keep names and metadata values consistent. Together, these files act like standardized forms, so every caller and tool speaks the same language.

#### [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files

This stage is shared behind-the-scenes support. It defines the “wire formats” the system uses when different parts need to talk to each other. A wire format is just the agreed shape of messages sent over a socket, pipe, or event stream, like agreeing on envelopes and forms before mailing information around.

The exec-server files set up that agreement for running and managing processes. client_api.rs describes how a client connects, which transport it uses, what time limits apply, and the common HTTP client interface. process_id.rs gives process IDs their own safe type, so they are not confused with ordinary text. protocol.rs defines the actual request, response, and notification messages for things like starting processes, inspecting files, and asking the executor to make HTTP calls.

exec_events.rs describes the stream of JSONL events emitted while commands run, so logs and progress updates have a consistent shape.

The last two files cover privileged execution. escalate_protocol.rs defines how a Unix shell asks an escalation service for permission or help. ipc_framed.rs does the same on Windows, including how messages are packed onto a byte stream. Together, these files make cross-process communication predictable and safe.

#### [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files

This stage provides shared “record formats” that other parts of the system can agree on. It is not the main work loop itself. Instead, it is behind-the-scenes support: the common shapes used to describe what happened during a rollout trace, which is a compact history of a run.

The session model is the top-level map. It describes the overall rollout status, the threads or parallel lines of work, the time windows when work happened, and when a Codex turn became active. In simple terms, it says who was involved, when things happened, and how the work was grouped.

The runtime model adds the action details from the execution side. It records code runs, compaction steps, tool calls, terminal activity, and links between threads. This explains how conversation events led to actual side effects, like a machine log that sits beside a chat transcript.

The payload reference file keeps the trace small. Instead of stuffing large requests, responses, or runtime dumps directly into the trace, it stores lightweight IDs and pointers to those separate files. Together, these pieces give a compact but connected picture of a session.

### [API annotation macros and compile-time contract support](stage-18.5.md) `stage-18.5` — 1 files

This stage is behind-the-scenes support. It does not run the app’s main work itself. Instead, it helps the rest of the codebase agree on rules at compile time, which means while the code is being built. You can think of it like a stamp-maker that prepares labels and warning signs before the machine starts.

Its main piece is codex-experimental-api-macros/src/lib.rs. This file defines a procedural macro, which is a special Rust feature that writes extra code for you during compilation. The macro is used as #[derive(ExperimentalApi)] on types such as structs and enums. When a developer marks something this way, the macro generates code that tracks which fields or enum variants are considered experimental.

That generated code does two jobs. First, it adds runtime checks, so the program can notice when experimental parts are being used and apply the project’s rules. Second, it adds inventory registrations, meaning it records those experimental items in a shared catalog the program can inspect later. Together, this keeps experimental features clearly marked, consistently checked, and discoverable across the whole system.

## [Cross-cutting transport, networking, and client infrastructure](stage-19.md) `stage-19` · (cross-cutting) — 55 files

This stage is the system’s shared communications toolbox. It is not one single step like startup or shutdown. Instead, many parts of the code use it whenever they need to talk to something else: a web service, another process on the same machine, or a remote relay.

One part provides the basic web plumbing. It builds requests and responses, supports streaming replies, retries temporary failures, loads trusted certificates for secure connections, and keeps only the small set of cookies the system actually wants. Another part provides transport channels between internal services. It can split large websocket messages into chunks, make remote HTTP responses and file reads look like local ones, and carry encrypted relay traffic safely.

A third part manages proxying and local IPC, meaning inter-process communication: private channels between programs on one machine. It decides what network access is allowed, can inspect encrypted web traffic when policy requires it, and offers socket-style local links across platforms. The MCP and executor adapters sit on top, turning high-level client actions into real traffic over in-process links, child processes, or HTTP.

The direct library files are the public front doors for backend, ChatGPT, and cloud-task clients, plus shared error types for transport failures.

### [Generic HTTP client, TLS, cookies, and streaming transport foundations](stage-19.1.md) `stage-19.1` — 21 files

This stage is the shared outbound networking toolkit: the plumbing the rest of the system uses whenever it needs to talk to another service. It sits behind the scenes, not in startup or shutdown, and gives higher-level features a safe, consistent way to make web requests.

At the bottom, request.rs defines the project’s own request and response shapes, including reusable JSON bodies and optional zstd compression, which means squeezing data smaller before sending it. transport.rs turns those requests into real HTTP calls through reqwest, and can return either a full response or a live stream of bytes. sse.rs decodes one common streaming format, Server-Sent Events, into plain message chunks. retry.rs decides when to try again after failures, waiting a little longer each time with randomness to avoid traffic spikes.

Security and identity are handled by custom_ca.rs, which loads trusted certificates, and by chatgpt_cloudflare_cookies.rs, which keeps only a narrow set of infrastructure cookies. default_client.rs and login/src/auth/default_client.rs build standard HTTP clients with tracing headers and logs.

On top of that, backend-client, chatgpt, cloud-tasks-client, thread_config/remote, lmstudio, and codex-api use these foundations to call specific backends, build authenticated sessions, upload files, and expose a cleaner public API.

### [App-server, exec-server, and relay transport channels](stage-19.2.md) `stage-19.2` — 10 files

This stage is shared plumbing. It sits behind the scenes and gives different parts of the system reliable ways to move data between processes and services, whether that data is a small message, an HTTP response, a file, or an encrypted relay packet.

At the center, app-server-transport/src/transport/mod.rs defines the common transport building blocks: how a connection is described, how incoming events are forwarded, how outgoing messages are encoded, and what to do when the system is overloaded. The remote-control files add two special jobs on top of that. segment.rs breaks large websocket messages into chunks and puts incoming chunks back together. clients.rs talks to the backend service to list or revoke enrolled remote-control clients.

On the exec-server side, http_client.rs and http_response_body_stream.rs make HTTP responses look the same whether they come directly from a local request or arrive piece by piece through remote procedure calls. remote_file_stream.rs does the same for remote files, reading them in chunks and closing them when finished.

For secure relay traffic, noise_channel.rs sets up an authenticated encrypted channel, ordered_ciphertext.rs straightens slightly out-of-order packets, message_framing.rs preserves message boundaries, and relay.rs carries those framed encrypted messages over websockets.

### [Managed proxying and local IPC transport substrates](stage-19.3.md) `stage-19.3` — 12 files

This stage is shared plumbing. It sits behind the scenes and gives the rest of the system safe ways to talk, both over the network and between programs on the same machine.

The network-proxy pieces decide when a managed proxy should exist and what rules it must enforce. network_proxy_spec combines user settings, admin restrictions, and execution policy into one effective proxy setup, then starts or updates the live proxy. Once traffic reaches that proxy, connect_policy checks whether an outgoing connection is even allowed, and upstream chooses how to send approved requests onward, either directly or through another proxy.

For encrypted web traffic, mitm and certs work together. “MITM” here means the proxy temporarily unwraps HTTPS so it can inspect and enforce rules, using its own locally generated certificates. mitm_hook adds per-site header changes, such as injecting secrets safely. responses makes sure blocked requests return clear human-readable messages.

The rest of the files provide local transport channels: uds gives a cross-platform Unix-socket style API, shell-escalation adds sockets that can pass extra OS resources, proxy_routing bridges proxies into Linux sandboxes, and the IDE IPC files use private local channels, including Windows named pipes, to talk to IDE integrations.

### [MCP and executor-backed transport adapters](stage-19.4.md) `stage-19.4` — 8 files

This stage is the bridge between the app’s high-level MCP client logic and the real ways it can talk to a server. It sits in the main communication path: once the client knows it wants to connect, these pieces turn that intent into actual messages over a process, an in-process link, or HTTP.

The main entry point is rmcp-client/src/lib.rs. It is the front door other code imports, gathering the client, transport options, and helper types into one public API. rmcp-client/src/in_process_transport.rs covers the simplest case: creating a transport stream inside the same program, so the client can reconnect without caring how that built-in server is started. rmcp-client/src/executor_process_transport.rs handles a child process managed by the executor, converting structured JSON-RPC messages into line-based stdin/stdout traffic and keeping stderr separate for diagnostics.

For HTTP, exec-server/src/client/reqwest_http_client.rs performs real network requests, while exec-server/src/client/rpc_http_client.rs forwards those requests through the executor’s JSON-RPC channel. rmcp-client/src/http_client_adapter.rs reshapes that shared HTTP ability into MCP’s streamable HTTP form. Its www_authenticate helper reads auth challenge headers to explain missing permissions clearly. Finally, streamable_http_retry.rs retries startup and temporary failures so brief network hiccups do not break the connection.

## [Cross-cutting observability, analytics, and feedback](stage-20.md) `stage-20` · (cross-cutting) — 81 files

This stage is the system’s shared “flight recorder and dashboard.” It is not one single step like startup or shutdown. Instead, it runs across the whole app, quietly watching what happens, measuring it, and saving useful clues for later.

One part turns raw observations into analytics events and sends them out in a cleaner, safer form. Another sets up the OpenTelemetry instrument panel, which provides traces, logs, and metrics: linked activity records, text notes, and numeric measurements. Session telemetry then stamps those signals with session and feature details, so one user turn or tool call can be followed end to end.

Rollout tracing keeps a richer black-box recording of important runtime events and can later replay them into a readable story of what happened. Feedback and debug capture gather logs, safe diagnostics, and redacted artifacts for bug reports, while local log persistence stores tracing data in SQLite and trims old entries.

Finally, windows-sandbox-rs/src/logging.rs adds simple rolling daily logs for sandbox commands, recording starts, successes, failures, and optional debug notes. Together, these parts make the system observable and debuggable without carelessly exposing secrets.

### [Analytics event modeling, reduction, and emitters](stage-20.1.md) `stage-20.1` — 8 files

This stage is the analytics engine room: shared support that watches what the app is doing, turns those observations into clean event records, and ships them out. It sits behind the main work of the system rather than being startup or shutdown code.

The flow starts with facts.rs, which defines the internal “facts” the system notices in memory, like a turn starting, a plugin being used, or an error happening. accepted_lines.rs adds one special input: it reads code diffs, summarizes which added lines were accepted, and creates privacy-safer fingerprints and repository hashes instead of sending raw file paths or remote URLs.

reducer.rs is the heart of the stage. It acts like a sorter on a conveyor belt, combining scattered facts from requests and notifications into complete analytics events. events.rs defines what those finished, sendable event payloads look like and converts facts into that wire-ready form, including extra timing and session details for guardian review tracking.

client.rs is the front door other code uses. It queues facts in the background, deduplicates repeated events, batches special cases, and sends results over HTTP or to a debug file. lib.rs ties these pieces together, while analytics_utils.rs and ext/goal/src/analytics.rs are small adapters that plug analytics into the app server and goal features.

### [OpenTelemetry runtime, provider, and metrics foundations](stage-20.2.md) `stage-20.2` — 22 files

This stage is the project’s shared “instrument panel.” It sits behind the scenes and makes sure the app can report what it is doing through traces, metrics, and logs. A trace is a linked record of work across steps, and metrics are numeric counters and timings.

The flow starts with configuration. core/src/config/otel.rs and otel/src/config.rs read user settings, clean them up, choose exporters, and validate extra metadata. core/src/otel_init.rs then bridges those settings into the real OpenTelemetry setup. otel/src/provider.rs builds the actual providers, installs them globally, adds common resource information, chooses what gets exported, and shuts things down cleanly. otel/src/otlp.rs supplies the network plumbing for sending telemetry out.

The metrics files form a small subsystem: config, validation, names, tags, client, timer, process, runtime_metrics, and error define what can be recorded, enforce safe names and labels, send measurements, time operations automatically, count process starts once, and summarize runtime snapshots.

trace_context.rs carries tracing identity across requests. targets.rs and events/shared.rs decide how events are categorized and emitted. otel/src/lib.rs and metrics/mod.rs expose the public entry points. The client and API telemetry trait files provide callback hooks so transport code can report per-attempt activity to this observability layer.

### [Session telemetry and feature-specific instrumentation](stage-20.3.md) `stage-20.3` — 16 files

This stage is the system’s shared “black box recorder” for a single session. It does not do the product’s main work by itself. Instead, it adds careful measurement around that work so developers can see what happened, how long it took, and which path was used, without exposing secrets.

At the center is the session telemetry layer, which gives the rest of the code one consistent way to emit logs, traces, and metrics, all stamped with the same session details. Turn timing adds a stopwatch for each user turn, breaking the response into milestones such as first output and tool wait time. App-server tracing marks incoming requests so activity can be followed across request boundaries.

Several files add tags and counters for specific features. Auth environment telemetry records only safe yes/no style signals about configuration. Sandbox tags summarize what safety sandbox was effectively active. Tool dispatch tracing records tool calls in a trace-friendly form. Guardian, cloud-config, goals, and memories each define their own stable metric names and tags. Finally, SQLite startup telemetry reports how database initialization and fallback behaved, so startup problems can be spotted early.

### [Rollout trace recording, schema, and replay reducers](stage-20.4.md) `stage-20.4` — 24 files

This stage is the system’s “black box recorder” and playback engine. During the main work of a session, it saves a raw log of what happened: requests to the model, tool calls, code execution, thread starts, and important runtime messages. Later, it can replay that raw log into a cleaner in-memory picture of the run.

Several files define the shared language for this. bundle.rs sets the bundle format on disk, raw_event.rs defines the basic event shapes, and model/*.rs defines the reduced replay model, especially the user-and-model conversation view. lib.rs exposes these pieces as the public entry points, while rollout/src/config.rs supplies the tracing configuration shape.

The writer side records events and payload files. writer.rs does the actual file writing. thread.rs, inference.rs, tool_dispatch.rs, code_cell.rs, compaction.rs, mcp.rs, and protocol_event.rs provide small tracing helpers for specific kinds of activity, so calling code can report events without knowing storage details.

The reducer side turns raw events back into a structured story. reducer/mod.rs coordinates this, and the conversation, inference, compaction, thread, code cell, tool, agents, terminal, and normalize reducers each rebuild one part of the final replayable trace.

### [Feedback capture, debug artifacts, and log persistence](stage-20.5.md) `stage-20.5` — 10 files

This stage is the system’s “black box recorder.” It runs behind the scenes while the app is doing its normal work, collecting enough evidence to understand problems later without exposing sensitive data.

Several parts gather feedback that can be sent to Sentry, a service for error reports. feedback/src/lib.rs keeps logs, request labels, and optional attachments in memory, then packages them for upload. feedback_diagnostics.rs adds a small text note about network proxy settings. feedback_doctor_report.rs tries to attach a cleaned-up “doctor” report, but only if it succeeds, so reporting never blocks on diagnostics.

Other parts make debugging safer. response-debug-context/src/lib.rs pulls useful clues like request IDs from API errors while avoiding private response contents. secrets/src/sanitizer.rs redacts obvious secrets such as API keys and bearer tokens before anything is logged or shown.

The remaining files save local artifacts for later inspection. responses-api-proxy/src/dump.rs writes redacted request and response snapshots to disk. analytics_capture.rs and tui/src/session_log.rs record analytics events and TUI session activity to JSONL files. state/src/log_db.rs and state/src/runtime/logs.rs store tracing events in SQLite, batch them efficiently, and prune old entries so logs stay useful without growing forever.

## [Cross-cutting persistence abstractions and data stores](stage-21.md) `stage-21` · (cross-cutting) — 54 files

This stage is the system’s shared long-term memory. It sits behind the main work and startup steps, and gives many different features a safe place to save things they will need later. Think of it as a mix of filing cabinets, indexes, and caches.

One part stores conversation threads in rollout files and a thread store. The rollout files are the raw session logs on disk, while the thread store gives the rest of the app a simpler way to create, read, search, archive, and delete threads. A separate message history keeps a global running record.

Another part uses SQLite, a small database kept in one file, to store runtime facts such as thread metadata, goals, agent jobs, memory-processing state, repair progress, and spawn relationships between agents.

Other pieces keep local caches so the system does not keep downloading the same cloud config, plugin catalogs, model lists, or update state. There is also storage for installed plugins, encrypted secrets, and memory workspace files.

Finally, import persistence remembers which outside session files were already brought in, and translates foreign session records into the format this system expects.

### [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files

This stage is the system’s long-term memory. It sits behind the main work loop and makes sure conversation threads can be saved, found again, searched, and removed later, even after the program exits.

The rollout files are the raw on-disk session logs. The rollout crate is the toolkit around those logs: recorder writes and replays them, list discovers and summarizes them, search scans them for matching text, session_index keeps a small side file of thread names, and compression quietly turns old logs into smaller compressed files without changing how the rest of the code reads them. message-history is a separate global history file that keeps an append-only record of messages across sessions.

The thread-store crate puts a cleaner, storage-neutral interface on top of all this. store defines the contract: create, append, read, list, archive, search, and delete threads. in_memory provides a simple fake version for tests. The local implementation is the real filesystem-backed version: live_writer updates active threads, read_thread reconstructs saved threads, list_threads and search_threads power browsing, delete_thread removes data, and helpers smooth over older file formats. core/src/rollout.rs connects the app’s config into this persistence layer.

### [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files

This stage is the system’s long-term memory. It sits behind the scenes and saves the facts the rest of the system needs between runs, using SQLite, a small built-in database stored in a file. The main entry point is state/src/lib.rs, which exposes the storage runtime and shared types.

Several files define the shapes of stored records: thread_metadata, thread_goal, agent_job, backfill_state, and log turn raw database rows into checked, typed objects the rest of the code can trust. The runtime files do the real work. threads.rs stores thread details, lists threads, and records parent/child spawn links. goals.rs keeps each thread’s goals, versions, and usage counts. memories.rs runs the multi-step memory pipeline and tracks retention and pollution rules. agent_jobs.rs saves job batches and item progress. backfill.rs tracks a one-off repair worker that fills in missing rollout metadata. remote_control.rs stores remote-control enrollment records, and external_agent_config_imports.rs keeps import history. audit.rs is a safe read-only window for diagnostics.

The agent-graph-store crate adds a clean interface for saving and querying spawn relationships. store.rs defines the contract, error.rs defines shared errors, local.rs connects that contract to the SQLite state runtime, and lib.rs re-exports the public pieces.

### [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files

This stage is shared support work that helps many parts of the system start faster and keep working when the network is slow or unavailable. Instead of asking remote services for the same information every time, it saves small lookup files on disk and reuses them when they are still safe and fresh.

The cloud config cache stores downloaded configuration bundles in a signed format. “Signed” here means the file includes proof that it was written by trusted code, so the system can reject anything tampered with, expired, broken, or belonging to the wrong user or account. The connector directory cache does a similar job for connector lists, using stable file names and throwing away stale or damaged JSON files. The plugin catalog cache keeps a local copy of the remote plugin directory, carefully separated by server endpoint and logged-in account so one user’s data is not reused for another. The models cache saves fetched model catalogs and checks both age and version before reuse. A shared-plugin-path file remembers which remote shared plugin ID maps to which local folder. The updates cache stores small update-related state, such as whether a popup was dismissed.

### [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files

This stage is shared behind-the-scenes storage work. It is where the system keeps long-lived local data on disk and makes sure that data is laid out safely and predictably.

The plugin store in core-plugins/src/store.rs is the local “warehouse” for downloaded plugins. It finds what is already installed, chooses the right version, installs or removes plugin folders, and updates files in a mostly atomic way, meaning it tries to avoid leaving half-written results behind.

The secrets files provide a secure local vault. secrets/src/lib.rs defines the public rules: what a valid secret name looks like, how secrets are grouped, and how a manager chooses a storage backend. secrets/src/local.rs is the file-based backend that encrypts secret contents before writing them under the app’s home folder, while windows-sandbox-rs/src/dpapi.rs uses Windows’ built-in DPAPI encryption so different Windows processes on the same machine can share the passphrase safely.

The memories files manage a local memory workspace. ext/memories/src/local.rs keeps all file access inside the allowed root folder. memories/write/src/lib.rs and storage.rs define the standard folder layout and rebuild markdown memory files from database results. control.rs safely clears old workspace contents without following dangerous symlinks, and extensions/prune.rs removes expired extension files.

### [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

This stage is shared behind-the-scenes support for bringing session history in from other tools. Its job is to remember what has already been imported and to turn outside session files into a clean, consistent shape that the rest of the system can use.

The ledger file is the memory. It stores a record of imported session file versions using two clues: the file’s real path and a content hash, which is a fingerprint of the file’s contents. That lets the system quickly answer practical questions like “Have we seen this exact version before?” and refresh file details when it scans for imports, so it does not re-import the same material by mistake.

The records file is the translator. It reads JSONL files, which are text files made of one JSON object per line, and can produce either quick summaries or full message streams ready for import. While reading, it smooths out differences in message formats, titles, timestamps, and tool output blocks, turning mixed external data into Codex-friendly text.

Together, these two parts act like a librarian and a translator: one tracks what is already on the shelf, and the other rewrites incoming material into the house style.

## [Cross-cutting utility and support libraries](stage-22.md) `stage-22` · (cross-cutting) — 175 files

This stage is the project’s shared toolbox. It is not one step in startup or shutdown. Instead, it supplies the small, reusable parts that many other stages depend on during everyday work.

Several sub-stages cover the big support areas. Path, filesystem, environment, and sandbox utilities give the program safe ways to talk about files, folders, terminals, and restricted run spaces on different operating systems. Text and rendering helpers clean up raw text, parse streams, shorten long content, and lay it out neatly for terminal screens. Configuration, metadata, auth, and network glue make different parts agree on settings, names, URLs, and login details. Shell, command, git, plugin, and execution support help the system run external commands, inspect Git repositories, and manage plugins. Async, image, and small support libraries provide timers, cancellation, readiness signals, image conversion, caches, and other handy building blocks. Build-script helpers prepare platform-specific pieces before the app is even run.

The direct files tie these tools together: shared utility roots expose helpers, CLI and plugin facades give stable entry points, common error types keep failures understandable, fuzzy matching powers flexible search, and hook-event helpers enforce consistent event behavior.

### [Path, filesystem, environment, and sandbox support utilities](stage-22.1.md) `stage-22.1` — 31 files

This stage is shared behind-the-scenes support. It gives the rest of the system safe, consistent ways to talk about paths, files, environment variables, terminals, and sandboxes on different operating systems.

Several pieces make path handling dependable. `PathUri`, `LegacyAppPathString`, `AbsolutePathBuf`, and the low-level absolutize code turn messy path text into checked, normalized forms, while still preserving the original spelling when needed. The app-server path wrapper keeps “host machine” path rules separate from the local client’s rules. The general path utilities add comparison-friendly normalization, symlink handling, atomic file replacement, WSL detection, and small helpers used by memories code and core re-exports.

Other files deal with real filesystem access. The filesystem abstraction defines a common interface for local or remote files and carries sandbox permission data. The file watcher reports changes to many listeners. There are helpers for safe regular-file opening, file modification times, symlink creation, locating built binaries, and finding runnable programs.

The rest shapes the runtime environment. Core environment code builds cleaned child-process environments. Terminal detection, clipboard support, and terminal palette selection adapt behavior to SSH, tmux, WSL, and color capabilities. Linux, macOS, and Windows sandbox utilities handle platform-specific path rewriting, log collection, ACL locking, SSH config scanning, and other setup details.

### [Text, parsing, truncation, and rendering helpers](stage-22.2.md) `stage-22.2` — 57 files

This stage is shared support code for anything the system needs to do with text before showing it to a person. It mostly works behind the scenes, especially for command-line and terminal screens, but many other parts use it too. You can think of it as the workshop where raw data is cleaned up, shortened, parsed, and shaped into something readable.

One part provides general string tools: formatting numbers and times, hiding secrets, shortening long text safely, keeping history within size limits, producing plain JSON text, and filling simple templates with placeholders like {{ name }}. Another part reads streaming input a piece at a time. It safely decodes bytes into text, waits for full lines, detects special hidden tags or table blocks, and extracts structured mentions without mixing them into visible output.

Above that, the layout helpers turn styled text into terminal-width lines. They measure visible width correctly, wrap long content, preserve links and colors, and support smooth scrolling. The presentation helpers add consistent colors, spacing, labels, menus, and status text. Finally, the motion tools add careful animation and progress output, with quieter fallbacks when less movement is preferred.

#### [Generic string, formatting, truncation, and templating utilities](stage-22.2.1.md) `stage-22.2.1` — 12 files

This stage is shared support code for turning internal data into readable, safe text. It sits behind the scenes and is used by many parts of the system whenever something must be shown to a person, sent through a text-only channel, or shortened to fit limits.

Several files focus on formatting. Number helpers print values with digit grouping or short suffixes like “k”. The elapsed-time helper turns durations into compact strings. CLI helpers build safe display text for environment settings by hiding secrets, and generate consistent “resume” command hints. The web-search formatter turns different kinds of search actions into one short description.

Other files focus on cleaning and shrinking text. The truncation utilities shorten long strings without breaking UTF-8, the text encoding used for modern characters. TUI text formatting adds display-friendly helpers like list joining, path shortening, and grapheme-safe cutting so visible characters are not split apart. Output-truncation and response-history code enforce byte or token budgets and keep only the most useful recent history.

Finally, JSON utilities produce ASCII-only but still valid JSON, and the template engine fills in {{ name }} placeholders while reporting mistakes clearly.

#### [Streaming, line framing, and hidden-markup parsers](stage-22.2.2.md) `stage-22.2.2` — 9 files

This stage is shared behind-the-scenes support for reading text a little at a time as it streams in. Its job is to turn messy incoming bytes or partial text chunks into clean pieces the rest of the system can trust, like a mail sorter that waits until it has a full envelope before routing it.

At the center, stream_text.rs defines the basic contract: a parser can accept more text, immediately return visible text, and also pull out extra hidden data on the side. lib.rs gathers these tools into the public entry point. utf8_stream.rs sits in front when input arrives as raw bytes, safely decoding UTF-8 text even when a character is split across chunks.

Several parsers build on that base. line_buffer.rs collects partial bytes until a full newline-terminated line exists. tagged_line_parser.rs watches for special blocks whose start and end markers must appear on their own lines. inline_hidden_tag.rs removes inline hidden tags from displayed text while extracting their contents. citations.rs is a concrete user of that machinery for memory citation markup. table_detect.rs recognizes markdown tables and fenced code blocks consistently, and mention_codec.rs converts visible @name and $name mentions to and from stored structured form.

#### [TUI text layout, wrapping, and text-rendering primitives](stage-22.2.3.md) `stage-22.2.3` — 10 files

This stage is shared behind-the-scenes support for drawing text in the terminal user interface. Its job is to take rich text from many sources and turn it into lines that fit the screen, keep their colors and links, and can still be scrolled or cut cleanly.

Several small helpers provide the building blocks. The render module defines safe rectangle shrinking, like margins around a box. line_utils copies and prefixes lines in a consistent way. width.rs adds guard rails so wrapping code does not try to squeeze text into zero space. ansi-escape converts ANSI-colored strings into the project’s internal text form, with tabs normalized for transcript output. line_truncation measures visible width and cuts lines at real display boundaries, so Unicode characters and styling stay intact.

The wrapping side does the heavier work. wrapping.rs breaks text into terminal-width lines, with a special path that keeps URL-like text together so hyperlinks survive. terminal_hyperlinks tracks links separately from visible text and emits terminal hyperlink codes only at the end. markdown_text_merge joins split markdown text pieces back together first. live_wrap incrementally wraps streaming text as it arrives. scrollable_diff builds on all this to cache wrapped diff text and provide smooth scrolling, paging, and progress tracking.

#### [TUI presentation models, styling, and lightweight view helpers](stage-22.2.4.md) `stage-22.2.4` — 21 files

This stage is shared presentation support for the text-based interface. It sits above the low-level text layout layer and below the bigger screens and widgets. Think of it as the kit of labels, colors, spacing rules, and small view models that help many TUI parts look consistent and behave the same.

Some files define the visual language. color.rs and style.rs choose readable colors and surface styles based on the terminal’s palette. ui_consts.rs keeps common indentation aligned. renderable.rs gives the main building block for anything that can be drawn, plus simple ways to place items in rows, columns, and inset boxes.

Other files shape user-facing text and interaction. key_hint.rs formats shortcut hints safely across keyboard quirks. footer.rs, action_required_title.rs, and popup_consts.rs build the bottom area’s status text, titles, and popup instructions. scroll_state.rs, selection_popup_common.rs, selection_tabs.rs, and selection_list.rs provide reusable menu behavior and drawing.

The remaining helpers turn raw data into compact display text: warnings suppression, import-item labels, goal summaries, skill labels, status formatting, remote connection summaries, token-chart palettes, and reusable history-cell pieces. Together, these pieces make many screens feel like one coherent interface.

#### [TUI animation, motion, terminal media, and transient progress output](stage-22.2.5.md) `stage-22.2.5` — 5 files

This stage is shared presentation support for moments when the program wants to look alive in a terminal without being distracting. It sits behind the scenes and is used during longer-running work, such as diagnostics, to show motion, progress, or richer terminal output in a safe, consistent way.

The pieces divide the job clearly. motion.rs is the front door. Other parts of the text user interface, or TUI, ask it for things like spinners or shimmering text, and it decides whether animation should run at all. It also applies the reduced-motion rule, meaning people or terminals that prefer less movement get calmer fallback output.

shimmer.rs creates the moving highlight effect for text. It can use full color when the terminal supports it, or a simpler brightness-only version when it does not. ascii_animation.rs is the small engine that flips through text frames over time and asks the screen to redraw. frames.rs supplies the actual built-in frame sets and their timing, like a box of prepared film strips. Finally, cli/src/doctor/progress.rs uses these ideas for doctor checks, choosing either a temporary status line on standard error or staying quiet when that fits better.

### [Configuration, metadata, schema, auth, and network glue utilities](stage-22.3.md) `stage-22.3` — 26 files

This stage is shared backstage support. It is not one single feature or main loop. Instead, it provides the small but important adapters that make many parts of the system agree on names, formats, rules, and safety checks.

Several files shape configuration. They rename old config keys to new ones, apply command-line overrides, convert JSON data into TOML (a configuration file format), label where a setting came from, and wrap values with validation rules. Related CLI helpers turn flags like approval and sandbox modes into the internal forms the program uses. Plugin toggle and mention-syntax helpers keep plugin settings and naming consistent.

Another group handles metadata and schemas: connector labels and install links, skill name collision counts, memory-tool JSON Schema descriptions, and the app version and update comparison helpers.

Auth and network glue live here too. PKCE support creates the verifier/challenge pair used in secure login. Other auth helpers extract readable server errors, build request headers, read API keys safely, and add session labels. Network utilities normalize backend and provider URLs, recognize allowed ChatGPT hosts, build task links, and enforce proxy host and policy rules, including private-address safety checks.

### [Shell, command, git, plugin, and execution support utilities](stage-22.4.md) `stage-22.4` — 24 files

This stage is shared support code that many other parts of the system lean on while doing real work. It sits behind the scenes. Its job is to safely turn “run this command” into an actual process, gather useful output, and help with nearby tasks like Git inspection and plugin packaging.

The shell-command and core shell files figure out which command shell to use, such as bash or PowerShell, and how to pass a command to it correctly on each platform. The shell environment and TUI command helpers prepare environment variables, escape text safely, and make command strings readable to users.

The git-utils files are the Git toolbox. They run git in a controlled way, disable risky helper programs, find repository facts, choose the right branch comparison point, and produce safe diffs for display. The plugin archive and marketplace files package plugins, unpack them carefully, and swap installed versions into place without leaving half-finished updates behind.

The remaining files support execution itself: shared tool helpers, bounded output buffering, executable-name cleanup, low-level exec setup for sandboxes, common process/session control, Windows-specific exec glue, exit-code mapping, PID tracking, launching an external editor, and fuzzy text matching for patch application.

### [Async primitives, image handling, and miscellaneous small support libraries](stage-22.5.md) `stage-22.5` — 25 files

This stage is shared support code: the small tools the rest of the system leans on during normal work, rather than one big startup or shutdown step. Think of it as a drawer of adapters, timers, and format converters that keep higher-level features simple.

Several pieces deal with images. The image utility crate reads images from raw bytes or data URLs, resizes and re-encodes them safely, caches them by content, and reports clear image errors. Core image preparation uses that to shrink or replace inline conversation images before they reach prompt limits. Image-detail helpers decide when “original” detail is allowed. For terminal pets, frames.rs splits a sprite sheet into cached PNG frames, image_protocol.rs chooses Kitty or Sixel output for the current terminal, and sixel.rs builds compact Sixel data.

Other parts support async work and system behavior. async-utils can stop an async task early with a cancellation token. readiness provides a one-way “ready” flag that tasks can wait on. stopwatch turns elapsed time into a cancel signal, with pause support.

The rest are small helpers: sleep inhibition keeps the computer awake on Linux, macOS, Windows, or does nothing when unsupported; runtime value code converts between Rust, JSON, JavaScript, text, and images; cache offers a tiny in-memory LRU cache; replay and frame-rate helpers keep the TUI orderly; sandbox-summary turns permission settings into short human-readable descriptions; and v8-poc is a tiny test crate proving the V8 JavaScript engine is wired up correctly.

### [Build scripts and build-time asset/platform glue](stage-22.6.md) `stage-22.6` — 4 files

This stage is behind-the-scenes build support. It runs while the project is being compiled, before the program starts, and makes sure each platform gets the extra pieces it needs. You can think of it as the packing and labeling step before shipping.

The `bwrap/build.rs` script prepares Linux sandbox support. If the target is Linux, it can compile the bundled Bubblewrap C code into a static library, meaning native code packed directly into the final binary. It also tells Cargo, Rust’s build tool, when to rebuild, where to find the compiled library, and sets a flag so the Rust code knows Bubblewrap is available.

The `windows-sandbox-rs/build.rs` script prepares Windows-specific metadata. It embeds a manifest, a small file that tells Windows how the helper program should run, but only when the compiler toolchain supports that feature.

The `cli/build.rs` script adds a special macOS linker option so the final CLI binary includes Objective-C pieces correctly.

The `skills/build.rs` script watches embedded sample assets. If anything under `src/assets/samples` changes, it forces a rebuild so the bundled assets stay up to date.

## [Testing, fixtures, and developer verification harnesses](stage-23.md) `stage-23` · (cross-cutting) — 659 files

This stage is the project’s big proving ground. It sits mostly behind the scenes and checks the whole system across every phase: starting up, doing real work, talking over networks, saving state, drawing the interface, and shutting down cleanly. If the product is a machine, this stage is the test garage where every moving part is exercised before release.

The app-server suites verify the server’s message protocol, small internal rules, and full end-to-end behavior with realistic clients. The core runtime harnesses test sessions, tools, safety approvals, saved history, and larger recovery and persistence flows. The CLI, login, exec, patch, and MCP checks make sure the developer-facing programs behave correctly when run for real. The exec-server, sandbox, and remote transport tests focus on launching processes, connecting to them safely, and handling files and platform-specific restrictions. The TUI tests inspect the terminal interface using a fake terminal so screen output can be checked exactly. Cross-cutting library tests cover shared building blocks like telemetry, configuration, plugins, transports, and storage. Finally, test-binary-support/lib.rs helps test binaries pretend to be different commands and gives them temporary home directories so tests stay isolated.

### [App-server test suites and protocol verification](stage-23.1.md) `stage-23.1` — 115 files

This stage is the app server’s full safety net. It lives mostly behind the scenes, but it checks nearly every part of the server’s story: how messages are shaped, how the server behaves in small pieces, how whole features work end to end, and whether support systems like updating and background processes stay safe.

One part verifies the protocol, meaning the message format used on the wire. It makes sure data is turned into JSON-RPC messages correctly and that saved schema files still match what the code generates, so outside clients do not break by surprise.

Another part covers unit tests and shared fixtures. Unit tests check small rules in isolation, while fixtures provide fake services, saved data, and a harness that starts a real server for realistic tests.

The integration suites are the dress rehearsal. They drive login, settings, conversations, plugins, realtime connections, and tool use the way a real client would.

The remaining tests check transport, the path messages travel through sockets and routing rules, plus daemon updating and process tracking. A dedicated test client ties these larger checks together by connecting to the server and sending real requests.

#### [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files

This stage is a safety net for the protocol layer: the part of the system that turns in-memory data into messages sent over the wire, and back again. It sits in behind-the-scenes support, not in startup or shutdown. Its job is to make sure outside clients and remote-control tools keep seeing exactly the message shapes they expect, even as the code changes.

The tests in common_tests.rs check a key split in app-server replies: when a response becomes the JSON-RPC “result” sent on the wire, and when extra higher-level response data is kept separately. This protects basic response formatting.

The remote_control_tests.rs file focuses on the remote-control v2 format. It checks tricky cases such as optional fields that may be missing or explicitly null, and responses that should appear as empty objects.

The larger v2/tests.rs file is the broad compatibility guardrail. It exercises many protocol types and edge cases across features like threads, permissions, files, commands, plugins, skills, and realtime APIs.

Finally, schema_fixtures.rs compares checked-in schema files with newly generated ones, like comparing a blueprint to the latest machine output, to catch any accidental drift.

#### [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files

This stage is the safety net and test toolkit for the app-server’s behind-the-scenes support systems. It checks three important areas: the daemon, which is the long-running background process; the transport layer, which is how parts of the system talk to each other; and a special test client used to drive realistic end-to-end checks.

The daemon tests make sure process tracking and updating behave safely in tricky cases. `pid_tests.rs` checks how the server records and reuses process IDs, especially when files are empty, stale, or racing with another start. `managed_install_tests.rs` and `update_loop_tests.rs` verify how installed binaries are identified and when the updater should restart or refresh itself.

The transport tests check both local sockets and message-routing rules. `unix_socket_tests.rs` covers Unix sockets, startup locking, and cleanup. `transport_tests.rs` checks which messages are forwarded, dropped, or delayed. The remote-control tests verify client listing, revocation, pairing, token refresh, and clear error reporting.

The test-client code is the hands-on driver. `lib.rs` launches or connects to the server and sends requests. The loopback server fakes a small HTTP service for tests. The plugin analytics files capture emitted event logs and run smoke tests to confirm plugin install, uninstall, and usage events are recorded correctly.

#### [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files

This stage is the app server’s safety net. It sits behind the scenes and checks that the server behaves correctly, both in small isolated pieces and in larger “talk to the real program” tests.

The unit test files each pin down one area of behavior. They verify configuration import and migration from external agents, reading and writing config files, command-line flag parsing, tracing data for requests, refresh rules after config imports, remote-control error handling, thread and conversation state changes, and how thread summaries choose preview text. Together, these tests act like executable examples of what the server is supposed to do.

The shared files under tests/common are the test toolkit. They create fake analytics and model servers, fake login data, temporary config files, cached model lists, canned streaming responses, and saved conversation histories. The TestAppServer harness starts the real server as a child process and talks to it using JSON-RPC, a request/response message format.

Finally, the suite index files gather everything into one integration test tree, organizing tests by feature area and version so the full app-server story can be checked consistently.

#### [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files

This stage is the big end-to-end test bed for the app server as a whole. It sits around startup, the normal running loop, and some behind-the-scenes support. Its job is to prove that a real client can talk to the server, sign in, configure it, use its features, and keep working as conversations and tools change over time.

One part checks the core public surface: login, account limits, startup rules, settings, feature flags, discovery of available models and capabilities, file and process access, and remote control. Another part tests the live connection layer, especially WebSocket, which is a long-lived two-way network link. These tests cover connecting, reconnecting, trust checks, version rules, hidden feature gates, and real-time conversation traffic.

A third part exercises extension points: plugins, marketplaces, MCP servers for outside tools and resources, local commands, shells, and add-on tools like search or image generation. The last part follows the life of a conversation from start to finish: creating threads, resuming and branching them, running and interrupting turns, storing summaries, and keeping session state consistent. Together, these suites act like a full dress rehearsal for the server.

##### [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files

This stage is a broad “real-world checkout” for the app server’s main public API. It sits in the shared support layer: not the plugin system or conversation loop, but the core services a client depends on before and around that work.

Several tests focus on identity and account state. auth.rs and v2/account.rs check how sign-in, tokens, logout, and refresh failures behave through JSON-RPC, the server’s request-and-response protocol. The rate limit suites make sure account usage limits, credit resets, and “add credits” actions require the right login and report backend problems clearly.

Another group checks startup and settings. strict_config.rs confirms the server refuses bad config files at launch. initialize.rs verifies the client introduces itself correctly at startup. config_rpc.rs and experimental_feature_list.rs test reading, writing, and layering settings from different places, including feature flags.

The discovery tests ask “what is available?”: models, provider capabilities, collaboration presets, and permission profiles. Finally, fs.rs, process_exec.rs, windows_sandbox_setup.rs, and remote_control.rs cover the server’s practical tools: file access, running local processes, preparing a Windows sandbox, and pairing or managing remote-control clients. Together they prove these core surfaces work end to end.

##### [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files

This stage is a set of end-to-end tests for the app server’s live connection layer: the part that talks to clients over long-lived links such as WebSocket, a two-way network channel that stays open so both sides can keep sending messages. It sits around the system’s startup and main work loop, checking that clients can connect, identify themselves, and keep working as the server runs, restarts, or rejects unsupported requests.

The websocket connection file is the main “road test.” It checks how connections are grouped, whether health-check URLs respond, how different login modes behave, whether startup blocks unsafe situations, and what happens when a client reconnects after work is already loaded. The Unix-only websocket file adds operating-system signal tests, making sure shutdown and restart happen cleanly even if a task is still in progress.

The attestation tests cover a trust check during connection setup: the server asks for a token through JSON-RPC, a simple request-response message format, and then passes that token in the WebSocket handshake headers. The experimental API tests make sure hidden or in-progress features stay locked unless the client explicitly opts in. Finally, the realtime conversation tests exercise full live conversations across WebSocket and WebRTC, including protocol version differences, event translation, and background work delegation.

##### [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files

This stage is a big safety net for the app server’s extension points: the places where outside add-ons, tools, and command runners plug into the system. It sits around the main work loop, checking that once the server is running, it can discover, install, use, and remove extra capabilities correctly.

The plugin and marketplace tests cover the full plugin life cycle: listing catalogs, reading plugin details and skills, adding or removing marketplaces, upgrading them, installing plugins, sharing them with a backend service, and uninstalling them cleanly. The app, hooks, and skills tests check what the server can discover from local files, project settings, plugins, and remote sources, and whether updates and caches behave properly.

Another group focuses on MCP, a protocol for external tool and resource servers. These tests check server status, direct tool calls, user-confirmation requests, resource reads, and executor-scoped behavior so one thread sees only the tools it selected. The command and shell tests verify running local commands safely, with streaming output, approvals, and special shell modes. Finally, extension-backed tools like image generation, sleep, web search, and fuzzy file search are tested end to end.

##### [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files

This stage is the app server’s “life of a conversation” test bed. It sits in the system’s main working path and checks that a chat session can be created, used, paused, changed, and picked up again without losing its place.

Several tests focus on thread lifecycle, where a “thread” means one saved conversation. thread_start, thread_read, thread_list, thread_loaded_list, thread_resume, thread_archive, thread_unarchive, thread_delete, thread_fork, and thread_rollback cover creating conversations, finding them later, showing active ones in memory, resuming old ones, archiving or deleting them, branching into child threads, and trimming recent history. conversation_summary and remote_thread_store check how summaries are found and how storage works when conversations live in an external store instead of local files.

Another group covers what happens inside a conversation turn: turn_start, turn_interrupt, turn_steer, output_schema, dynamic_tools, plan_item, thread_inject_items, request_permissions, and request_user_input test starting work, interrupting it, steering it mid-stream, and passing structured tool or user-input requests through the server.

The remaining files check supporting state: review and compaction flows, memory reset, per-thread settings and metadata, name and status notifications, client metadata forwarding, safety notices, and imported external-agent configuration. Together, these tests make sure conversations behave like a well-kept case file: updated in the right place, visible to the right clients, and restorable when needed.

### [Core runtime and session test harnesses](stage-23.2.md) `stage-23.2` — 179 files

This stage is the project’s full testing safety net for the core runtime: the part that keeps sessions running, lets the system use tools, talks to outside services, and remembers state between turns. It mostly supports the system’s normal work loop, but it also checks startup, pause-and-resume, and shutdown edge cases.

One part focuses on runtime, session, policy, and state tests. It checks conversation flow, prompt building, saved history, approval gates for risky actions, and the rules that decide what commands or tools are allowed. Another part focuses on tools and unified execution, the shared command runner. These tests make sure tool requests have the right shape, are routed correctly, obey safety rules, and produce the expected results.

A shared integration harness under core/tests provides the test workshop. It spins up fake servers, isolated environments, helper processes, and stable snapshots so larger tests can run in a controlled world. On top of that, the end-to-end suites test the whole machine working together: transport, streaming, tools, plugins, approvals, persistence, realtime features, rollout, and recovery.

#### [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files

This stage is the project’s safety net for the core runtime: the part that keeps a session alive, remembers what happened, decides what is allowed, and prepares what the agent sees and says. It sits behind the scenes during the system’s normal work, but many tests also cover startup, resume after interruption, rollback, and shutdown of agent threads.

The biggest group checks session behavior. These tests build realistic conversations and verify turn-by-turn flow, prompt and context building, history compaction, resume from saved data, and special guardian review when risky actions need approval. Nearby files check smaller but important details like final message storage, token-budget truncation, event mapping, metadata, timing, image preparation, and shell-command records.

Another group checks state and policy rules: execution policy, sandbox and patch safety, MCP tool visibility, and platform-specific command handling. Agent-control, registry, residency, delegate, and thread-manager tests make sure subagents can spawn, pause, resume, and be cleaned up correctly.

The rest covers shared support pieces such as environment and history rendering, AGENTS.md discovery, Git and shell inspection, personality migration, realtime handoff, and transport request formatting. Together, these tests make sure the core engine behaves predictably under real-world conditions.

#### [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files

This stage is a behind-the-scenes safety net for the system’s tool and command-running machinery. It does not add new features by itself. Instead, it proves that the “tools” the model can call, the router that chooses them, and the execution layer that runs commands all behave exactly as intended.

One group of files checks tool contracts: the published schemas for shell, patching, agent jobs, MCP tools, multi-agent tools, hosted tools, and user-input requests. These are like forms that must keep the same shape so callers do not break. Another group tests the handlers behind those tools, making sure they parse inputs, build outputs, enforce rules, and trigger the right side effects. The internal test_sync tool is a special test helper that coordinates parallel work so timing-sensitive tests stay predictable.

The rest tests the plumbing underneath: the registry and router that expose tools, tracing that records what happened, approval and sandbox rules that keep risky actions contained, runtime preparation that rewrites environments safely, and unified-exec, the shared command runner. Together, these tests make sure tool calls are routed, approved, executed, and reported safely and consistently.

#### [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files

This stage is the shared test workshop for the core crate. It does not test one feature by itself. Instead, it provides the reusable scaffolding that end-to-end tests stand on, so the rest of the test suite can start programs, fake outside services, and check results in a controlled way.

At the top, all.rs defines the single integration test program, and suite/mod.rs gathers the whole suite and adds an early trick that lets the test binary pretend to be helper executables when needed. common/lib.rs is the toolbox that re-exports the main helpers. test_support.rs exposes special test-only setup paths from inside the core code without changing production behavior.

Several files describe or shape the test world: test_environment.rs detects whether tests run locally, in Docker, or through Wine; hooks.rs marks hook fixtures as trusted; tracing.rs turns on test logging and telemetry; process.rs waits for child processes to start or stop.

The rest are realistic stand-ins and harnesses. apps_test_server.rs, responses.rs, and streaming_sse.rs simulate external servers and streaming replies. context_snapshot.rs makes stable readable snapshots for assertions. zsh_fork.rs, test_codex.rs, and test_codex_exec.rs build fully isolated test runs for shell and core execution scenarios.

#### [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files

This stage is the big end-to-end proving ground for the system’s main work during a live session. It checks the full user-visible journey: starting a conversation, sending requests out, receiving streamed replies, using tools, asking for approval, saving progress, and continuing later. If earlier stages test individual parts, this one tests the whole machine while it is running.

The transport and provider suites check the “roads” between the app and external AI services: request headers, compression, streaming, WebSocket or WebRTC live channels, retries, and fallback when something goes wrong. The session history and persistence suites test memory over time, making sure saved sessions, trimmed history, resumes, forks, and durable storage still preserve the conversation’s meaning.

The request-shaping and model-selection suites verify what is packed into each model request and which model is chosen. The multi-agent and remote-environment suites test teamwork: parent and child agents, job routing, and isolated remote workspaces. The approvals, hooks, and review suites act like gatekeepers, checking permissions, pauses for user input, and review flows. Finally, the tool and plugin suites confirm that commands, apps, plugins, and outputs run safely and are reported back in the right form.

##### [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files

This stage tests the system’s “roads and rules” at the API edge: how Codex sends requests out, keeps streams alive, and reacts when providers answer in unusual ways. It sits in the main work path, because every turn depends on these transport details being correct.

Several tests check how requests are built before they leave the app. client.rs, responses_headers.rs, responses_api_proxy_headers.rs, request_compression.rs, responses_lite.rs, and compact_remote.rs make sure the right headers, authentication, metadata, compression, history, tools, and compacted summaries are sent for each mode. models_etag_responses.rs checks the model list refresh rule when the server signals it has changed.

Other files focus on live streaming channels. agent_websocket.rs, client_websockets.rs, and realtime_conversation.rs verify WebSocket and WebRTC sessions, including startup context, reused connections, handoffs, and realtime settings. turn_state.rs makes sure per-turn state sticks within one turn but resets for the next.

The remaining tests cover failures and recovery. stream_no_completed.rs, stream_error_allows_next_turn.rs, websocket_fallback.rs, quota_exceeded.rs, and safety_check_downgrade.rs confirm retries, clean turn completion, fallback to plain HTTP, and clear error handling. Together, these tests act like a border inspection, ensuring requests and responses travel safely and predictably.

##### [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files

This stage is a behind-the-scenes test area for one big promise: a conversation should still make sense later, even after the system trims old context, pauses mid-turn, restarts, or branches into a new thread. Think of it as checking the system’s memory, notebook, and save files.

The compaction tests make sure old conversation history can be compressed without changing what the model effectively sees. They cover manual and automatic compaction, compare old and new remote compaction paths, and check what happens after resume, fork, or rollback. Pending-input tests check that if new user or agent messages arrive while work is still in progress, they are queued and replayed in the right order.

Resume and resume-warning tests verify that reopening a saved session rebuilds the earlier story correctly and warns if the active model has changed. Fork-thread and window-header tests check branching: a fork should start a fresh line of history while keeping the right inherited context. Image-rollout, model-overrides, and override-updates confirm what state is saved to disk and what should stay temporary. Finally, rollout-list-find and sqlite-state test how saved sessions are discovered and stored, including the SQLite database used for durable session data.

##### [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files

This stage is the “packing and routing” part of the system. Before Codex asks a model for help, it must decide what to send, how to lay it out, and sometimes which model should answer. These tests check that the request is built correctly and stays correct as settings, threads, and models change.

Several files focus on what gets injected into the prompt, meaning the text and structured input the model actually sees. That includes extra context, AGENTS.md instruction files, collaboration guidance, hierarchical child-agent rules, selected repository skills, personality settings, permission messages, and token-budget notes. Prompt layout and debugging tests make sure all these pieces appear in the right order and survive resume, fork, and multi-environment flows. Prompt-caching tests check that reusable prefixes stay stable instead of being rebuilt unnecessarily.

Other files check provider-facing request shaping. They verify JSON schema output requests, web-search tool configuration, and the exact request payload sent over the network. Finally, remote-model, runtime-selector, auto-review, and model-switching tests make sure metadata from a remote catalog can change behavior safely, including tool modes, review-model overrides, and how history is rewritten when switching models.

##### [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files

This stage is a full-system test bed for the “many workers at once” parts of the project. It sits in the main work of the system, not startup or shutdown. Its job is to prove that when one agent creates other agents, passes work around, or runs in a remote machine-like environment, the rules still hold and messages end up in the right place.

spawn_agent_description.rs checks the help text for the spawn-agent tool, making sure users only see allowed model choices and clear guidance about overrides, effort levels, service tier, and authorization. agent_execution.rs tests nested agent spawning, especially the shared limit on how many tasks can run at once, and confirms that going over the limit fails clearly instead of quietly overloading the system.

codex_delegate.rs and subagent_notifications.rs cover communication between parent and child agents. They verify approval forwarding, event filtering, inherited context, mailbox-style messages, and lifecycle notifications. agent_jobs.rs tests batch-style jobs created from CSV input, including creation, cancellation, and saving results to the right thread. remote_env.rs checks that work done in remote environments stays isolated, uses the right permissions, and does not leak into the local workspace.

##### [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files

This stage tests the system’s “gatekeepers” during the main work of a session: the checks, prompts, and side routes that stand between a requested action and actually doing it. Think of it as the rules desk and security checkpoint for user-visible actions.

The approval and policy tests make sure commands, patching files, and network changes are allowed or blocked for the right reasons, even in tricky combinations of sandbox limits, saved exceptions, and collaboration modes. The permission-request tests cover both asking inline and using a dedicated tool, including temporary versus lasting grants, partial approval, and denial. The user-input tests check how the system pauses to ask the user a question and then resumes cleanly.

Review-focused tests follow `/review` requests and Guardian auto-review routing, making sure review work stays separate from normal conversation and notifications. Metadata tests confirm that later tool calls carry the right context about earlier prompts and reviewer choices. Finally, hook and notification tests check the plug-in style interception points before and after tools run, including rewriting inputs, blocking actions, adding context, and sending a summary notification when a turn finishes.

##### [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files

This stage is the “full dress rehearsal” for how the system exposes tools and runs them during real conversations. It sits in the main work loop: after the model decides what to do, these tests check that commands, plugins, apps, and other helpers are actually offered, executed, limited, and reported back correctly.

Several files focus on command execution. tools.rs, shell_command.rs, exec.rs, unified_exec.rs, tool_harness.rs, apply_patch_cli.rs, and shell_snapshot.rs test built-in tools for running shell commands, editing files with patches, reusing sessions, and saving command state. They check success, failure, timeouts, sandbox blocks, and what side effects happen on disk.

Other files make sure results are packaged properly. shell_serialization.rs, truncation.rs, abort_tasks.rs, items.rs, and tool_parallelism.rs verify the event stream, runtime “items” (the records the system emits), parallel tool calls, interrupted work, and trimming oversized output before it goes back to the model.

The remaining tests cover integrations and special entry points: plugins.rs, request_plugin_install.rs, search_tool.rs, openai_file_mcp.rs, extension_sandbox.rs, code_mode.rs, user_shell_cmd.rs, and view_image.rs. Together they ensure external tools, file uploads, image handling, and user-started commands follow the same safety rules and appear in a form the model can understand.

### [CLI, exec, login, and MCP server developer verification](stage-23.3.md) `stage-23.3` — 73 files

This stage is the big outside-in check for developer-facing programs. It sits around startup and real user workflows, and asks: if someone runs these tools from the command line, logs in, applies a patch, or connects an MCP server, does the finished executable behave as promised?

Each sub-stage checks one doorway into the system. The top-level CLI tests make sure typed commands are understood correctly, the right feature starts, and mistakes produce useful errors. The codex-exec tests do the same for the separate execution program, including input rules, streamed output, saved sessions, authentication headers, and failure cases. The login tests walk through signing in, storing credentials, refreshing them when they expire, and logging out cleanly. The apply-patch tests launch the real patch tool and confirm it changes files on disk correctly, even in awkward edge cases. The execpolicy tests verify the rule engine that decides whether commands are allowed. Finally, the MCP server tests start the real server process and talk to it like a client would, using fake backend services to check approvals, instructions, and tool behavior end to end.

#### [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files

This stage is the final “does the real program behave correctly?” check for the standalone apply-patch command-line tool. It sits around the program from the outside, like a user would, instead of inspecting its inside parts. The goal is to prove that the compiled executable can be launched, given patch text, and trusted to make the right changes on disk.

all.rs is the entry door for these integration tests: it builds one test binary and hands work to the shared suite. suite/mod.rs is the organizer. It groups the tests by topic and skips some platform-specific cases on Windows when needed.

cli.rs checks the basic ways a person can run the tool, including passing input as command-line arguments or through standard input, the text stream a program reads from the terminal or a pipe. tool.rs goes deeper into edge cases: bad patch syntax, missing files, overwrite rules, renames, and what happens if only part of a patch can be applied. scenarios.rs runs full end-to-end examples by copying sample folders, applying patches, and comparing the final folder contents to the expected result.

#### [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files

This stage is the safety check for the very top of the Codex command-line tool: the place where a user types a command and expects the right thing to happen. It sits around startup and command dispatch, making sure the program chooses the correct path, reads options correctly, and fails in the right way when input is wrong.

Several tests focus on strict configuration checking for app-server, exec-server, and feature-related commands, so bad settings are caught early. Other tests cover maintenance and support commands: delete checks error messages come in the right order, update confirms debug builds stop immediately instead of starting an update flow, and the debug commands verify memory cleanup and model-list output.

A large group checks extension management. The plugin and marketplace tests cover listing, install and removal, JSON output, and how configured, cached, home, and built-in marketplace locations interact. Separate add, remove, and upgrade tests verify those specific command paths. The MCP tests cover adding, removing, listing, and showing remote tool servers, including saved settings, secret masking, and invalid flag combinations. Finally, the live CLI smoke test runs the real binary against the real online service for an end-to-end reality check.

#### [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files

This stage is the safety net around the codex-exec command-line program itself. It sits at the boundary between a user or script and the rest of the system, so these tests make sure the executable starts correctly, reads inputs the right way, talks to the backend with the right headers, prints results in the promised formats, and exits with the right status when something goes wrong.

Some tests focus on the front door: cli_tests.rs and main_tests.rs lock down command-line argument parsing, including tricky cases like resume prompts and old flags. lib_tests.rs checks the startup helper code that prepares prompts, logging, and thread settings before real work begins.

Another group checks output processing. The human-output and JSONL event processor tests verify how streamed events become readable text or machine-readable lines, and the larger JSON output test follows full event translation end to end.

The integration suite then exercises real binary behavior: prompt and stdin rules, session save and resume, ephemeral mode, hooks, approval choices, workspace instruction files, auth and Originator headers, output schemas, MCP startup failures, server-error exits, writable directories, and patch application. all.rs and suite/mod.rs simply gather these tests into one runnable package.

#### [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files

This stage is the safety net for execpolicy, the part of the system that decides whether a command is allowed to run and why. It sits in shared behind-the-scenes support, but it tests the policy from the outside, the way a real user or tool would experience it.

The current tests check the modern policy engine end to end. cli/tests/execpolicy.rs runs the `codex execpolicy check` command itself and makes sure it returns the right JSON, the machine-readable result format, including cases with and without explanations. execpolicy/tests/basic.rs checks the parser and runtime together: reading rules, matching commands, handling network permissions, examples, justifications, and finding the real executable on the host machine.

The legacy test suite keeps older command-specific behavior from drifting. all.rs and suite/mod.rs gather everything into one organized test run. good.rs and bad.rs protect the curated examples of commands that must pass or fail. The other files focus on particular commands like cp, ls, head, pwd, and sed, checking exact accepted forms, exact error cases, and command normalization. literal.rs and parse_sed_command.rs test smaller matching pieces in isolation. Together, these tests act like a long checklist that catches both new mistakes and accidental changes to trusted old behavior.

#### [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files

This stage is the safety net for the login system. It sits in shared behind-the-scenes support, but it checks the full story a developer experiences: signing in, staying signed in, refreshing expired credentials, and signing out cleanly.

At the top, login/tests/all.rs and login/tests/suite/mod.rs gather many separate test modules into one test program, like a folder and index for the whole test collection. The smaller auth tests check the building blocks. access_token_tests.rs makes sure the code can tell different token formats apart. personal_access_token_tests.rs checks that personal tokens can be looked up and validated through a fake auth service. storage_tests.rs verifies where login data is saved, loaded, migrated, or temporarily kept. auth_tests.rs covers the main auth manager’s decisions, recovery steps, and saved state. bedrock_api_key_tests.rs checks API-key storage and how logout removes it.

The larger integration tests exercise real user journeys. cli/tests/login.rs checks command-line login. device_code_login.rs covers the “enter this code on another device” flow. login_server_e2e.rs tests browser login with a local callback server. auth_refresh.rs checks token renewal. logout.rs confirms revocation and cleanup.

#### [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files

This stage is the end-to-end test bench for the MCP server program. Instead of checking tiny pieces in isolation, it starts the real server as a separate process and talks to it the way a real client would. That makes it part of behind-the-scenes quality checking: it proves the finished executable behaves correctly when all the parts are connected.

The top-level entry point is all.rs, which builds one integration test program, and suite/mod.rs, which gathers the test groups inside it. common/lib.rs adds small shared helpers, including one that turns raw JSON-RPC replies—a standard message format for remote procedure calls—into normal typed test values.

The core harness is common/mcp_process.rs. It launches the codex-mcp-server binary and sends and receives one JSON message per line. common/mock_model_server.rs supplies a fake model service, using preloaded server-sent events (streamed text messages) to imitate model output in a fixed order. common/responses.rs creates those canned streams, including examples where the model asks to run shell commands, returns assistant text, or suggests an apply_patch edit. Finally, suite/codex_tool.rs uses all of this to verify real codex tool behavior, especially approval prompts and instruction passing.

### [Exec-server, sandbox, and remote transport harnesses](stage-23.4.md) `stage-23.4` — 49 files

This stage is the project’s proving ground for “how we talk to other processes safely.” It sits behind the scenes, not in the main product flow. Its job is to test the servers, transport links, sandboxes, and platform bridges that let code run locally or remotely.

Several tests focus on exec-server itself: starting a real server, doing the first initialize handshake, checking health, speaking over WebSocket, and managing process lifecycles such as start, resume, input, output, and shutdown. Shared harness files act like test actors, pretending to be helper programs or spinning up a real server so the other tests can talk to it.

Another group checks file access, including local and remote filesystems, path and file-URI handling, sandbox rules, and file streaming. Transport tests cover HTTP helpers, stdio links, Unix socket bridges, and the Noise protocol, which is an encrypted channel; these tests verify framing, ordering, authorization, reconnects, and relay behavior.

The rest covers the sandbox machinery on Linux, macOS, and Windows, plus remote-control transport and Wine-based Windows execution. Together, these tests make sure commands can be launched, connected, restricted, and observed correctly across many environments.

### [TUI interaction and rendering tests](stage-23.5.md) `stage-23.5` — 52 files

This stage is the safety net for the terminal user interface, the text-based screen the user sees and interacts with. It sits mostly around the system’s main work loop: it checks that typing, popups, status lines, history, and screen drawing all behave correctly while the app is running, and that startup and shutdown details still look right.

A few files provide the test scaffolding. Shared helpers build realistic fake app state, normalize text, and keep tests short. A special test backend replaces the real terminal with a VT100 parser, which is a terminal simulator that lets tests inspect exactly what would appear on screen without touching the user’s terminal. The integration-test entry files gather all these checks into one runnable test bundle.

From there, the tests fan out by feature. App-level tests verify overall orchestration such as startup routing, resizing, rollback, summaries, and status feeds. ChatWidget tests cover composing messages, slash commands, approvals, permissions, review and plan modes, side conversations, popups, usage and status commands, and layout snapshots. Other suites lock down rendering details for history cells, markdown, token charts, status output, and architectural boundaries. Together, they make sure the TUI behaves like a well-fitted dashboard, not a collection of loose parts.

### [Cross-cutting library tests, fixtures, and telemetry or rollout support](stage-23.6.md) `stage-23.6` — 190 files

This stage is a broad safety net for shared library code that many other parts of the system depend on. It mostly sits behind the scenes rather than being one step in startup or shutdown. Think of it as checking the common tools, records, and measuring equipment before the main product uses them.

Its sub-stages cover the big shared areas. Analytics and telemetry tests make sure the system reports events, timings, logs, and traces correctly. Configuration and policy tests check how settings are read, merged, and turned into rules. Plugin, extension, skill, MCP, and tool tests verify that add-ons can be discovered, described, and connected safely. API client, model, prompt, protocol, and transport tests check the plumbing for talking to outside services. Memory, rollout, state, and persistence tests make sure long-lived data can be saved, rebuilt, and repaired. Utility tests cover path and URI handling and safe output truncation.

The directly assigned files add focused checks around smaller shared pieces: a mock cloud-tasks client, file watching, hook output spilling to disk, terminal detection, incremental line scanning, image loading, goal accounting, and a small aggregated chatgpt test suite. Together, these tests keep the project’s reusable building blocks trustworthy.

#### [Analytics and telemetry tests](stage-23.6.1.md) `stage-23.6.1` — 18 files

This stage is the safety net for the system’s observability features: the parts that record what the app did, how long it took, and what happened when something went wrong. It is shared behind the scenes rather than part of startup or shutdown. These tests make sure analytics events, metrics, logs, and traces are produced correctly and sent to the right place.

The otel test crate ties the OpenTelemetry test suite together, while the harness sets up fake in-memory exporters so tests can inspect emitted data without needing real servers. The suite then checks specific behaviors: rejecting bad metric inputs, recording timings, sending data in the background, taking snapshots of current metrics, building runtime summaries, and adding manager-level tags and counters. Other tests verify routing rules between logs and trace events, plus full OTLP/HTTP export through a tiny local loopback server.

The analytics tests focus on higher-level event creation: choosing destinations, batching, filtering, serialization, deduplication, and turn-by-turn app behavior. App-server, core, and state tests then confirm that these signals appear correctly in real workflows, helper utilities, and stored logs.

#### [Configuration, policy, and environment tests](stage-23.6.2.md) `stage-23.6.2` — 43 files

This stage is the safety net for the system’s rules about configuration, policy, and environment. It mostly supports startup and shared behind-the-scenes behavior: before the app can do real work, it must read settings from files, combine layers from users and enterprise management, decide which features are allowed, and turn those choices into clear runtime rules.

Several tests focus on configuration itself. They check parsing of TOML and JSON text, merging of multiple config layers, schema generation, config editing, profile selection, and one-time migrations. Cloud-config tests cover managed bundles, cache files, service refresh behavior, and helpers that build fake managed configs for larger tests. Policy tests then verify what those settings mean: permissions, sandboxing, network proxy rules, tool and app policy precedence, hook behavior, prompt wording, and feature resolution, including warnings for old or unstable flags.

The remaining tests cover the environment around those rules, such as command environment variables, path normalization, keyring selection, home-directory instructions, and special platform cases like Windows sandboxing and bubblewrap discovery. Together, these tests make sure the system reads the right inputs and turns them into the right decisions.

#### [Plugins, extensions, skills, MCP, and tools tests](stage-23.6.3.md) `stage-23.6.3` — 50 files

This stage is the safety net for the system’s “add-on” world: plugins, extensions, skills, MCP servers, and tool descriptions. It sits mostly in shared behind-the-scenes support, checking that extra features can be found, loaded, described, and used correctly before the main app relies on them.

A big group of tests covers plugins. Some build fake plugin folders and config files, then check discovery, loading, version picking, marketplace listings, remote recommendations, startup syncing, sharing, and manager behavior. Together they make sure plugins are read from the right place, bad inputs are rejected clearly, and plugin data turns into usable apps, hooks, skills, and MCP servers.

Another group covers skills, which are reusable abilities. These tests check how skills are found on disk, enabled or disabled, mentioned by name, and even inferred from shell commands.

Extension tests focus on the extension API, registry, stored state, and concrete extensions like goals, image generation, memories, and skills. MCP tests verify server config, catalog conflict rules, connection handling, client transports, and hosted or plugin-provided servers.

Finally, tool tests make sure tool definitions, schema conversion, naming, serialization, and API-facing formats stay predictable.

#### [API clients, models, protocol, prompts, and transport support tests](stage-23.6.4.md) `stage-23.6.4` — 38 files

This stage is the project’s safety net for the “plumbing” that sits behind the main features. It is mostly shared support, not startup or shutdown. These tests make sure the app can talk to outside services, describe available models correctly, build prompts, encode and decode protocol messages, and survive tricky network conditions.

Several files check the model catalog side: provider definitions, built-in presets, model-info overrides, caches, and the manager that chooses which model data to trust. Nearby support code gives tests a stable fake model setup without contacting real servers. Another group tests API clients and login behavior: request paths, headers, auth tokens, error mapping, rate-limit responses, and custom certificate handling. Transport-focused tests cover server-sent events, WebSockets, HTTP retries, OAuth startup, Unix sockets, and line-based process I/O.

Prompt tests lock down the exact words sent to models for goals, reviews, exits, and memory writing. Protocol tests verify error formatting and text decoding, especially odd terminal encodings. Finally, mock backends, proxy tests, and TLS-provider tests supply realistic stand-ins so all these pieces can be checked together reliably.

#### [Memories, rollout, state, and persistence tests](stage-23.6.5.md) `stage-23.6.5` — 26 files

This stage is the system’s safety net for long-lived data and replayable history. It sits in the shared support layer, checking that important records can be written, read back, rebuilt after problems, and turned into the right higher-level view.

Several tests focus on rollout traces, which are event logs of what happened. Shared fixtures build small fake traces, and the reducer tests check that code cells, conversations, model inference, terminal actions, agent-to-agent work, protocol events, and whole thread traces are replayed into the correct final graph.

Another group checks runtime and persistence. Runtime helpers create clean temporary test folders. Tests then verify external-agent import records, database corruption recovery, and message-history trimming. Local thread-store fixtures support reading and listing saved thread data, while ledger tests make sure external-agent session records are updated efficiently.

The memories tests cover both reading and writing memory files: prompt building, citation parsing, startup behavior, storage naming, workspace diffs, and pruning old extension files. Finally, rollout storage tests verify compression, metadata extraction, session indexing, state-database syncing, recording, scanning, repair, and resume behavior. Together, these tests make sure the system remembers accurately and recovers safely.

#### [Utility crate tests for path/URI and output truncation helpers](stage-23.6.6.md) `stage-23.6.6` — 3 files

This stage is a behind-the-scenes safety check for shared helper code. It is not part of startup or shutdown. Instead, it verifies small utility libraries that many other parts of the system may rely on, especially code for file paths and URIs, and code that shortens output when there is a size limit.

The truncation tests check how text is cut down when there is a byte budget or a token budget. A token here means a chunk used by language-model tooling, not just a character. These tests cover both simple text and structured “content items,” so the system keeps output within limits without breaking the shape of the data.

The main path/URI tests focus on PathUri, the library type that represents either a local path or a URI (a standard text form for locations like files or web-style addresses). They verify normalization, conversion to native operating-system paths, safe fallback encoding, simple path operations, data-format support through serde, and clear errors for bad input.

The API path string tests sit one layer higher. They check the text form exposed to the rest of the app, making sure it parses and prints correctly across Unix-style paths, Windows paths, network shares, and unusual fallback URIs.
