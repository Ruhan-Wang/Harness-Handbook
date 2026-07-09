# TUI startup, onboarding, and terminal ownership  `stage-9.1`

This stage is the front door of the terminal app. It runs before the main chat loop, then keeps owning the terminal safely while the app is open. The startup code loads settings, connects to or starts the app server, chooses local AI providers when needed, checks changed project hooks, offers updates, model moves, working-directory choices, and imports from other agents. Onboarding screens guide first-time users through welcome, sign-in, and trusting the project folder, using built-in keys so the flow works before custom settings exist.

Once startup choices are settled, the App builds or resumes a chat thread, can show a session picker, constructs the main chat widget, replays old conversations without rerunning actions, and displays startup cards, tips, MCP server progress, collaboration modes, pets, and status previews. The terminal layer is the machinery underneath: it probes terminal abilities, enables safer keyboard input, draws efficiently, handles resizing, title changes, suspend/resume, stderr noise, clipboard-style notifications, bells, and desktop notification escape codes. Together these pieces turn a normal shell window into Codex’s interactive workspace, then restore it cleanly afterward.

## Files in this stage

### Startup entry and bootstrap decisions
These files cover the top-level TUI entrypoint and the early startup prompts and preflight decisions made before the main interactive app fully takes over.

### `tui/src/lib.rs`

`orchestration` · `startup through main interactive run`

This file is the startup conductor for the terminal version of Codex. Its job is to turn command-line choices, config files, login state, saved sessions, logging, and terminal setup into one working interactive app. Without it, the rest of the TUI widgets and app logic would exist, but there would be no reliable path from `codex` startup to a usable screen.

A useful way to think about it is an airport gate agent. It checks your ticket, decides which plane you should board, handles special cases, and makes sure the jet bridge is safe before people move. Here, the “plane” is either an embedded app server running inside this process, a local background daemon, or a remote server. The file decides which one to use, loads the right configuration, checks whether local databases and login rules are usable, prepares logging and telemetry, and then switches the terminal into TUI mode.

It also protects the user’s terminal. A `TerminalRestoreGuard` makes sure the screen is restored even if startup fails or the app exits early. The file contains helpers for remote addresses, session resume and fork lookup, onboarding decisions, alternate-screen mode, and configuration reloads after trust or login changes. The test module verifies many edge cases around startup, saved sessions, remote connections, and config reload behavior.

#### Function details

##### `start_embedded_app_server`  (lines 232–258)

```
async fn start_embedded_app_server(
    arg0_paths: Arg0DispatchPaths,
    config: Config,
    cli_kv_overrides: Vec<(String, toml::Value)>,
    loader_overrides: LoaderOverrides,
    strict_config: b
```

**Purpose**: Starts an app server inside the same process as the TUI. This is used when Codex is not connecting to an already-running local or remote server.

**Data flow**: It receives launch paths, configuration, command-line overrides, cloud config loading, feedback/logging hooks, database handles, and an environment manager. It passes all of that into the more general startup helper and returns an in-process app server client.

**Call relations**: When `start_app_server` decides the target is embedded, it calls this wrapper. Tests also call it through `start_test_embedded_app_server` to create a real embedded server.

*Call graph*: calls 1 internal fn (start_embedded_app_server_with); called by 2 (start_app_server, start_test_embedded_app_server).


##### `AppServerTarget::uses_remote_workspace`  (lines 268–270)

```
fn uses_remote_workspace(&self) -> bool
```

**Purpose**: Answers whether the chosen app server points at a remote workspace rather than the local machine. Many startup choices depend on this because local paths and permissions may not apply remotely.

**Data flow**: It reads the target variant. If the target is `Remote`, it returns true; otherwise it returns false.

**Call relations**: Other startup helpers ask this before deciding thread parameter style, whether to canonicalize a local current directory, whether to load local configured environments, and how `run_ratatui_app` should behave.

*Call graph*: called by 4 (thread_params_mode, config_cwd_for_app_server_target, run_ratatui_app, should_load_configured_environments); 1 external calls (matches!).


##### `AppServerTarget::thread_params_mode`  (lines 272–278)

```
fn thread_params_mode(&self) -> ThreadParamsMode
```

**Purpose**: Chooses the session parameter style expected by the app server. Remote workspaces use remote-style thread parameters; embedded and local daemon modes use embedded-style parameters.

**Data flow**: It checks whether the target uses a remote workspace and maps that answer to a `ThreadParamsMode` value.

**Call relations**: Session creation uses this when wrapping an app server client in `AppServerSession`, both during normal TUI startup and when temporary sessions are created for pickers.

*Call graph*: calls 1 internal fn (uses_remote_workspace); called by 2 (run_ratatui_app, start_app_server_for_picker).


##### `init_state_db_for_app_server_target`  (lines 281–298)

```
async fn init_state_db_for_app_server_target(
    config: &Config,
    app_server_target: &AppServerTarget,
) -> std::io::Result<Option<StateDbHandle>>
```

**Purpose**: Opens or finds the local state database used for saved session metadata and rollout state. It treats embedded startup more strictly because the embedded server depends on a working local database.

**Data flow**: It receives the loaded config and the chosen server target. For embedded mode it tries to initialize the database and turns failures into a typed startup error; for daemon or remote modes it asks for an existing database handle if available.

**Call relations**: Main startup calls this before launching the app server. Tests use it to verify both normal embedded startup and database failure reporting.

*Call graph*: calls 2 internal fn (get_state_db, try_init); called by 5 (run_main, start_embedded_app_server_for_picker, embedded_state_db_corruption_preserves_failed_database_for_cli_recovery, embedded_state_db_failure_is_typed_for_cli_recovery, start_test_embedded_app_server).


##### `remove_legacy_tui_log_file`  (lines 301–305)

```
fn remove_legacy_tui_log_file(codex_home: &Path)
```

**Purpose**: Deletes an old shared TUI log file that could otherwise grow forever. The cleanup is best-effort, so startup continues even if the file cannot be removed.

**Data flow**: It receives the Codex home directory, builds the old log file path, and attempts to remove it without returning an error.

**Call relations**: Normal startup calls it after config load. A test checks that the legacy file is removed when present.

*Call graph*: called by 2 (run_main, startup_removes_legacy_tui_log_file); 2 external calls (join, remove_file).


##### `remote_addr_has_explicit_port`  (lines 307–334)

```
fn remote_addr_has_explicit_port(addr: &str, parsed: &Url) -> bool
```

**Purpose**: Checks whether a WebSocket address explicitly includes a port, even when the port is the scheme’s default. Codex requires the port to be written so remote addresses are unambiguous.

**Data flow**: It receives the original address string and its parsed URL. It inspects the host, scheme, and authority text and returns true only when a port is visibly present.

**Call relations**: Remote address parsing calls this before accepting `ws://` or `wss://` endpoints.

*Call graph*: called by 1 (resolve_remote_addr); 4 external calls (host_str, port, scheme, format!).


##### `websocket_url_supports_auth_token`  (lines 336–344)

```
fn websocket_url_supports_auth_token(parsed: &Url) -> bool
```

**Purpose**: Decides whether it is safe to attach an authentication token to a WebSocket endpoint. Tokens are allowed for secure WebSockets, and for plain WebSockets only when they stay on localhost.

**Data flow**: It receives a parsed URL, checks its scheme and host, and returns a yes-or-no answer.

**Call relations**: This is the safety rule behind `remote_addr_supports_auth_token`.

*Call graph*: 2 external calls (host, scheme).


##### `resolve_remote_addr`  (lines 346–383)

```
fn resolve_remote_addr(addr: &str) -> color_eyre::Result<RemoteAppServerEndpoint>
```

**Purpose**: Turns a user-supplied remote address string into the endpoint type the app server client understands. It accepts WebSocket URLs and Unix socket paths, and rejects loose or incomplete addresses.

**Data flow**: It reads an address string. `unix://` becomes the default Codex socket, `unix://PATH` becomes an absolute socket path, and valid `ws://host:port` or `wss://host:port` becomes a WebSocket endpoint; invalid input produces a clear error.

**Call relations**: The CLI layer can use this before calling `run_main` with an explicit remote endpoint. Tests exercise valid and invalid forms.

*Call graph*: calls 2 internal fn (remote_addr_has_explicit_port, relative_to_current_dir); called by 1 (resolve_remote_addr_rejects_invalid_remote_addresses); 5 external calls (parse, app_server_control_socket_path, find_codex_home, bail!, matches!).


##### `remote_addr_supports_auth_token`  (lines 385–392)

```
fn remote_addr_supports_auth_token(endpoint: &RemoteAppServerEndpoint) -> bool
```

**Purpose**: Reports whether an already-resolved remote endpoint may safely carry an auth token. This prevents tokens from being sent over unsafe network paths.

**Data flow**: It receives a remote endpoint. For WebSockets it parses the stored URL and applies the token-safety rule; for Unix sockets it returns false.

**Call relations**: It builds on the WebSocket safety helper and is available to callers that need to decide whether token-based connection setup is allowed.

*Call graph*: 1 external calls (parse).


##### `connect_remote_app_server`  (lines 394–408)

```
async fn connect_remote_app_server(
    endpoint: RemoteAppServerEndpoint,
) -> color_eyre::Result<AppServerClient>
```

**Purpose**: Connects the TUI to an app server that is already running elsewhere. This is used for explicit remote connections and reusable local daemons.

**Data flow**: It receives an endpoint, builds connection arguments such as client name, version, API mode, and channel size, then returns a remote app server client wrapped in the common client enum.

**Call relations**: When `start_app_server` sees a local daemon or remote target, it delegates the connection work here.

*Call graph*: calls 1 internal fn (connect); called by 1 (start_app_server); 3 external calls (new, Remote, env!).


##### `maybe_probe_default_daemon_socket`  (lines 440–442)

```
async fn maybe_probe_default_daemon_socket(_codex_home: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Looks for a default local app-server daemon socket and quickly tests whether it is alive. This lets startup reuse a daemon only when doing so is safe and fast.

**Data flow**: It receives Codex home, computes the standard socket path, checks whether it exists, then attempts a short connection. Success returns the socket path; missing, failed, or timed-out probes return none.

**Call relations**: On startup, `run_main` calls this only when the current launch has no special overrides that a daemon could not reproduce.

*Call graph*: calls 1 internal fn (connect); called by 1 (run_main); 3 external calls (app_server_control_socket_path, timeout, debug!).


##### `start_app_server`  (lines 445–477)

```
async fn start_app_server(
    target: &AppServerTarget,
    arg0_paths: Arg0DispatchPaths,
    config: Config,
    cli_kv_overrides: Vec<(String, toml::Value)>,
    loader_overrides: LoaderOverrides,
```

**Purpose**: Starts or connects to the app server selected for this launch. It hides the difference between embedded, local daemon, and remote server modes from later code.

**Data flow**: It receives the target plus all startup inputs needed by embedded mode. Embedded mode starts an in-process server; daemon and remote modes connect to the endpoint; all paths return a common app server client.

**Call relations**: Both the main TUI startup and picker-only helpers call this before creating an `AppServerSession`.

*Call graph*: calls 2 internal fn (connect_remote_app_server, start_embedded_app_server); called by 2 (run_ratatui_app, start_app_server_for_picker).


##### `start_app_server_for_picker`  (lines 479–503)

```
async fn start_app_server_for_picker(
    config: &Config,
    target: &AppServerTarget,
    state_db: Option<StateDbHandle>,
    environment_manager: Arc<EnvironmentManager>,
) -> color_eyre::Result<
```

**Purpose**: Creates a minimal app server session for resume or fork picker screens. It avoids the full normal startup path while still giving the picker access to saved threads.

**Data flow**: It receives config, a target, optional state database handle, and an environment manager. It starts the app server with default or empty launch settings, then wraps the client as an `AppServerSession`.

**Call relations**: The test-only embedded picker helper calls this after preparing state database and environment objects.

*Call graph*: calls 5 internal fn (default, new, thread_params_mode, new, start_app_server); called by 1 (start_embedded_app_server_for_picker); 4 external calls (new, clone, default, default).


##### `start_embedded_app_server_for_picker`  (lines 506–517)

```
async fn start_embedded_app_server_for_picker(
    config: &Config,
) -> color_eyre::Result<AppServerSession>
```

**Purpose**: Test helper that starts an embedded app server session suitable for picker-related tests. It uses test defaults so tests do not need the full production launch setup.

**Data flow**: It receives config, initializes the embedded state database, creates a test environment manager, and returns an app server session.

**Call relations**: It composes the database initializer with `start_app_server_for_picker` for test use.

*Call graph*: calls 3 internal fn (default_for_tests, init_state_db_for_app_server_target, start_app_server_for_picker); 1 external calls (new).


##### `start_embedded_app_server_with`  (lines 520–571)

```
async fn start_embedded_app_server_with(
    arg0_paths: Arg0DispatchPaths,
    config: Config,
    cli_kv_overrides: Vec<(String, toml::Value)>,
    loader_overrides: LoaderOverrides,
    strict_conf
```

**Purpose**: Builds the full argument package needed to start an embedded app server. It exists so production code and tests can share the same setup while tests can inject a fake starter.

**Data flow**: It receives config and all launch services, converts startup warnings into protocol notifications, fills client identity and channel settings, calls the supplied starter function, and returns the started in-process client or a contextual error.

**Call relations**: `start_embedded_app_server` uses it with the real client starter. A test uses it with a failing starter to verify that startup errors are reported clearly.

*Call graph*: called by 2 (start_embedded_app_server, embedded_app_server_start_failure_is_returned); 5 external calls (new, new, env!, from_value, json!).


##### `shutdown_app_server_if_present`  (lines 573–579)

```
async fn shutdown_app_server_if_present(app_server: Option<AppServerSession>)
```

**Purpose**: Shuts down a temporary app server session if one exists. It prevents early-exit paths from leaving background work running.

**Data flow**: It receives an optional session. If present, it asks the session to shut down and logs a warning if that fails.

**Call relations**: `run_ratatui_app` uses this on early exits from onboarding or failed resume/fork lookups.

*Call graph*: called by 1 (run_ratatui_app); 1 external calls (warn!).


##### `session_target_from_app_server_thread`  (lines 581–598)

```
fn session_target_from_app_server_thread(
    thread: AppServerThread,
) -> Option<resume_picker::SessionTarget>
```

**Purpose**: Converts a thread returned by the app server into the smaller resume/fork target used by the TUI picker. It filters out threads with invalid IDs.

**Data flow**: It receives an app-server thread, parses its string ID, and returns a target containing the thread path and typed ID. If parsing fails, it logs a warning and returns none.

**Call relations**: Session lookup helpers use this after `thread/list` or `thread/read` responses.

*Call graph*: calls 1 internal fn (from_string); called by 2 (lookup_session_target_by_name_with_app_server, lookup_session_target_with_app_server); 1 external calls (warn!).


##### `resume_source_kinds`  (lines 600–609)

```
fn resume_source_kinds(include_non_interactive: bool) -> Vec<ThreadSourceKind>
```

**Purpose**: Chooses which kinds of saved sessions should be considered resumable. Interactive sessions are always included, and non-interactive sessions can be added on request.

**Data flow**: It receives a boolean. It starts with CLI and VS Code sources, then adds Exec and AppServer sources if non-interactive sessions are allowed.

**Call relations**: `latest_session_lookup_params` uses this when building app-server list requests.

*Call graph*: called by 1 (latest_session_lookup_params); 1 external calls (vec!).


##### `lookup_session_target_by_name_with_app_server`  (lines 611–644)

```
async fn lookup_session_target_by_name_with_app_server(
    app_server: &mut AppServerSession,
    name: &str,
) -> color_eyre::Result<Option<resume_picker::SessionTarget>>
```

**Purpose**: Finds a saved session whose title exactly matches a given name. This lets users resume or fork by session name rather than ID.

**Data flow**: It receives a mutable app server session and a name. It pages through search results from the app server, looks for an exact title match, converts the matching thread to a target, and returns none if no page matches.

**Call relations**: `lookup_session_target_with_app_server` calls this when the user input is not a UUID. A test verifies that backend title search is used.

*Call graph*: calls 2 internal fn (thread_list, session_target_from_app_server_thread); called by 2 (lookup_session_target_with_app_server, lookup_session_target_by_name_uses_backend_title_search); 1 external calls (vec!).


##### `lookup_session_target_with_app_server`  (lines 646–679)

```
async fn lookup_session_target_with_app_server(
    app_server: &mut AppServerSession,
    id_or_name: &str,
) -> color_eyre::Result<Option<resume_picker::SessionTarget>>
```

**Purpose**: Finds a saved session by either ID or name. It supports the user-facing `--resume <id-or-name>` and `--fork <id-or-name>` behavior.

**Data flow**: It receives an app server session and a string. If the string looks like a UUID, it reads that thread directly; otherwise it searches by name. It returns a resume/fork target or none.

**Call relations**: `run_ratatui_app` calls this when CLI arguments name a specific session.

*Call graph*: calls 4 internal fn (from_string, thread_read, lookup_session_target_by_name_with_app_server, session_target_from_app_server_thread); called by 1 (run_ratatui_app); 2 external calls (parse_str, warn!).


##### `lookup_latest_session_target_with_app_server`  (lines 681–712)

```
async fn lookup_latest_session_target_with_app_server(
    app_server: &mut AppServerSession,
    config: &Config,
    cwd_filter: Option<&Path>,
    include_non_interactive: bool,
) -> color_eyre::Re
```

**Purpose**: Finds the most recently updated saved session that matches the current scope. It first uses fast database metadata, then falls back to a scan-and-repair path if needed.

**Data flow**: It receives the app server, config, optional current-directory filter, and whether non-interactive sessions count. It asks the server for one latest thread in two modes and returns the first valid target whose path still makes sense locally or is remote.

**Call relations**: `run_ratatui_app` uses this for `--resume --last` and `--fork --last`. Tests cover current-directory filtering and fallback behavior.

*Call graph*: calls 3 internal fn (thread_list, uses_remote_workspace, latest_session_lookup_params); called by 3 (run_ratatui_app, fork_last_filters_latest_session_by_cwd_unless_show_all, latest_session_lookup_falls_back_for_rollout_missing_from_state_db).


##### `latest_session_lookup_params`  (lines 720–747)

```
fn latest_session_lookup_params(
    uses_remote_workspace: bool,
    config: &Config,
    cwd_filter: Option<&Path>,
    include_non_interactive: bool,
    lookup_mode: LatestSessionLookupMode,
) ->
```

**Purpose**: Builds the request sent to the app server when looking for the latest saved session. It keeps local and remote lookup rules separate.

**Data flow**: It receives remote/local status, config, optional directory filter, source inclusion choice, and lookup mode. It returns a `ThreadListParams` object with limit, sorting, provider filter, directory filter, and database-only flag set.

**Call relations**: The latest-session lookup helper calls this for each lookup mode. Tests verify the exact filters for embedded, local daemon, and remote cases.

*Call graph*: calls 1 internal fn (resume_source_kinds); called by 6 (lookup_latest_session_target_with_app_server, latest_session_lookup_params_can_include_non_interactive_sources, latest_session_lookup_params_keep_explicit_cwd_filter_for_remote_sessions, latest_session_lookup_params_keep_local_filters_for_embedded_sessions, latest_session_lookup_params_keep_local_filters_for_local_daemon_sessions, latest_session_lookup_params_omit_local_filters_for_remote_sessions); 1 external calls (vec!).


##### `config_cwd_for_app_server_target`  (lines 749–769)

```
fn config_cwd_for_app_server_target(
    cwd: Option<&Path>,
    app_server_target: &AppServerTarget,
    environment_manager: &EnvironmentManager,
) -> std::io::Result<Option<AbsolutePathBuf>>
```

**Purpose**: Decides which current directory should be used while loading configuration. Remote workspaces and remote execution environments cannot safely use local path assumptions.

**Data flow**: It receives an optional CLI directory, the app server target, and the environment manager. For remote contexts it returns none; otherwise it canonicalizes the supplied path or current directory and returns an absolute path.

**Call relations**: `run_main` uses this before loading bootstrap config. Tests cover remote omission, local canonicalization, and missing directory errors.

*Call graph*: calls 4 internal fn (default_environment, uses_remote_workspace, current_dir, from_absolute_path); called by 6 (run_main, config_cwd_for_app_server_target_canonicalizes_embedded_cli_cwd, config_cwd_for_app_server_target_canonicalizes_local_daemon_cli_cwd, config_cwd_for_app_server_target_errors_for_missing_embedded_cli_cwd, config_cwd_for_app_server_target_omits_cwd_for_remote_exec_server, config_cwd_for_app_server_target_omits_cwd_for_remote_sessions); 1 external calls (canonicalize_existing_preserving_symlinks).


##### `should_load_configured_environments`  (lines 771–776)

```
fn should_load_configured_environments(
    loader_overrides: &LoaderOverrides,
    app_server_target: &AppServerTarget,
) -> bool
```

**Purpose**: Decides whether startup should read user-configured execution environments. Remote workspaces skip this because their environment is not defined by local config.

**Data flow**: It reads loader override flags and the app server target. It returns true only when user config is allowed and the target is not a remote workspace.

**Call relations**: `run_main` calls this before creating the `EnvironmentManager`.

*Call graph*: calls 1 internal fn (uses_remote_workspace); called by 1 (run_main).


##### `latest_session_cwd_filter`  (lines 778–793)

```
fn latest_session_cwd_filter(
    uses_remote_workspace: bool,
    remote_cwd_override: Option<&'a Path>,
    config: &'a Config,
    show_all: bool,
) -> Option<&'a Path>
```

**Purpose**: Chooses the directory filter for latest-session lookup. This keeps `--last` scoped to the current project unless the user asks to show all sessions.

**Data flow**: It receives remote/local status, an optional remote current-directory override, config, and a show-all flag. It returns no filter for show-all, the remote override for remote workspaces, or the config current directory for local sessions.

**Call relations**: `run_ratatui_app` uses this before latest resume/fork lookup, and tests verify the scope choices.

*Call graph*: called by 3 (run_ratatui_app, fork_last_filters_latest_session_by_cwd_unless_show_all, latest_session_cwd_filter_respects_scope_options).


##### `app_server_target_for_launch`  (lines 795–811)

```
fn app_server_target_for_launch(
    explicit_remote_endpoint: Option<RemoteAppServerEndpoint>,
    default_daemon_socket: Option<AbsolutePathBuf>,
    can_reuse_implicit_local_daemon: bool,
) -> AppS
```

**Purpose**: Chooses whether this run should use an explicit remote server, a reusable local daemon, or a fresh embedded server. This is a key routing decision during startup.

**Data flow**: It receives an explicit endpoint if any, a probed default daemon socket if any, and whether implicit daemon reuse is allowed. It prefers explicit remote, then reusable daemon, then embedded.

**Call relations**: `run_main` calls this after checking CLI/config constraints. Tests verify each branch.

*Call graph*: called by 4 (run_main, app_server_target_for_launch_prefers_explicit_remote_endpoint, app_server_target_for_launch_skips_local_daemon_when_launch_config_is_not_replayable, app_server_target_for_launch_uses_local_daemon_for_default_socket).


##### `loader_overrides_are_default`  (lines 813–829)

```
fn loader_overrides_are_default(loader_overrides: &LoaderOverrides) -> bool
```

**Purpose**: Checks whether config-loading options are still at their normal defaults. A reused daemon can only be trusted when it does not need special one-off config loading behavior.

**Data flow**: It receives loader overrides and returns true only if no custom config paths, ignored config sources, or special managed-config data are set.

**Call relations**: `can_reuse_implicit_local_daemon` uses this as one of the safety gates for daemon reuse.

*Call graph*: called by 1 (can_reuse_implicit_local_daemon).


##### `can_reuse_implicit_local_daemon`  (lines 831–842)

```
fn can_reuse_implicit_local_daemon(
    cli_kv_overrides: &[(String, toml::Value)],
    loader_overrides: &LoaderOverrides,
    strict_config: bool,
    has_non_replayable_launch_overrides: bool,
) ->
```

**Purpose**: Decides whether startup may automatically reuse a local background daemon. It prevents reuse when the current launch includes settings the daemon cannot replay.

**Data flow**: It reads CLI config overrides, loader overrides, strict-config mode, and non-replayable launch flags. It returns true only when all are plain defaults.

**Call relations**: `run_main` uses this before probing the default daemon socket. Tests cover the conditions that disable reuse.

*Call graph*: calls 1 internal fn (loader_overrides_are_default); called by 1 (run_main).


##### `run_main`  (lines 844–1262)

```
async fn run_main(
    mut cli: Cli,
    arg0_paths: Arg0DispatchPaths,
    loader_overrides: LoaderOverrides,
    explicit_remote_endpoint: Option<RemoteAppServerEndpoint>,
) -> std::io::Result<AppEx
```

**Purpose**: Performs the full non-UI startup sequence for the TUI library. It parses launch choices, loads config, prepares logging/telemetry/database state, chooses the app server target, and then hands off to the terminal app runner.

**Data flow**: It receives parsed CLI data, paths for helper executables, config-loader overrides, and an optional explicit remote endpoint. It transforms these into final config, cloud config, app-server target, state/log database handles, feedback and telemetry layers, environment manager, and app launch overrides, then returns the app exit information.

**Call relations**: This is the main public runner used by the binary side of the TUI. After all setup succeeds, it calls `run_ratatui_app`; on unrecoverable config or auth errors it prints a message and exits.

*Call graph*: calls 21 internal fn (default, resolve_oss_provider, resolve_profile_v2_config_path, from_codex_home, from_env, from_optional_paths, new, originator, set_default_client_residency_requirement, add_dir_warning_message (+11 more)); 25 external calls (default, try_from_default_env, new, other, migrate_personality_if_needed, cloud_config_bundle_loader_for_storage, enforce_login_restrictions, record_process_start_once, sqlite_telemetry_recorder, install_process_db_telemetry (+15 more)).


##### `run_ratatui_app`  (lines 1265–1795)

```
async fn run_ratatui_app(
    cli: Cli,
    arg0_paths: Arg0DispatchPaths,
    loader_overrides: LoaderOverrides,
    strict_config: bool,
    app_server_target: AppServerTarget,
    remote_cwd_overri
```

**Purpose**: Runs the actual terminal UI after startup services are ready. It initializes the terminal, performs onboarding or session selection, starts or reuses the app server session, and launches `App::run`.

**Data flow**: It receives CLI data, config, app-server target, overrides, cloud config loader, feedback/logging/database services, and environment manager. It sets up panic handling and terminal restoration, may reload config after login/trust/resume choices, resolves resume or fork targets, bootstraps the app server, runs startup hook review, and returns the app’s exit information.

**Call relations**: `run_main` hands off here after process-level setup. This function then calls helpers for app server startup, login status, onboarding, session lookup, alternate-screen mode, and finally the main `App::run` loop.

*Call graph*: calls 29 internal fn (set_default_client_residency_requirement, thread_params_mode, uses_remote_workspace, new, new, write_config_batch, determine_alt_screen_mode, get_login_status, latest_session_cwd_filter, load_config_or_exit (+15 more)); called by 1 (run_main); 26 external calls (new, now, auth_keyring_backend_kind, clone, clone, run, cloud_config_bundle_loader_for_storage, find_codex_home, install, clone (+15 more)).


##### `restore`  (lines 1801–1807)

```
fn restore()
```

**Purpose**: Restores the terminal after the TUI is done or has failed. If restoration itself fails, it tells the user how to recover.

**Data flow**: It calls the TUI restore routine. On error, it writes a plain message to standard error suggesting `reset` or restarting the terminal.

**Call relations**: `TerminalRestoreGuard::restore_silently` uses this on normal guard cleanup and early error paths.

*Call graph*: calls 1 internal fn (restore_after_exit); called by 1 (restore_silently); 1 external calls (eprintln!).


##### `TerminalRestoreGuard::new`  (lines 1814–1816)

```
fn new() -> Self
```

**Purpose**: Creates a guard that will restore the terminal unless told it has already done so. This protects users from being left in alternate-screen or raw terminal mode.

**Data flow**: It creates a `TerminalRestoreGuard` with its active flag set to true.

**Call relations**: `run_ratatui_app` creates this immediately after terminal initialization.

*Call graph*: called by 1 (run_ratatui_app).


##### `TerminalRestoreGuard::restore`  (lines 1819–1825)

```
fn restore(&mut self) -> color_eyre::Result<()>
```

**Purpose**: Restores the terminal and reports any restoration error to the caller. It is used when the caller can still return a structured error.

**Data flow**: It checks whether the guard is active. If so, it calls terminal restoration, marks itself inactive, and returns success or the restoration error.

**Call relations**: The update prompt path can call this before leaving the TUI to run an updater.

*Call graph*: calls 1 internal fn (restore_after_exit).


##### `TerminalRestoreGuard::restore_silently`  (lines 1827–1832)

```
fn restore_silently(&mut self)
```

**Purpose**: Restores the terminal without returning an error. This is useful during cleanup paths where the app is already exiting.

**Data flow**: It checks the active flag, calls the best-effort `restore` helper, and then marks itself inactive.

**Call relations**: Early exits in `run_ratatui_app` call this, and the guard’s `drop` method calls it as a final safety net.

*Call graph*: calls 1 internal fn (restore); called by 1 (drop).


##### `TerminalRestoreGuard::drop`  (lines 1836–1838)

```
fn drop(&mut self)
```

**Purpose**: Automatically restores the terminal if the guard goes out of scope while still active. This is the backup plan for unexpected exits.

**Data flow**: When the guard is dropped, it calls silent restoration. The active flag prevents double restoration.

**Call relations**: Rust calls this automatically; it delegates to `TerminalRestoreGuard::restore_silently`.

*Call graph*: calls 1 internal fn (restore_silently).


##### `determine_alt_screen_mode`  (lines 1848–1854)

```
fn determine_alt_screen_mode(no_alt_screen: bool, tui_alternate_screen: AltScreenMode) -> bool
```

**Purpose**: Decides whether the TUI should use the terminal’s alternate screen buffer. The alternate screen gives a full-screen app feel, while inline mode preserves scrollback.

**Data flow**: It receives the `--no-alt-screen` flag and the config value. The flag always disables alternate screen; otherwise every config mode except `Never` enables it.

**Call relations**: `run_ratatui_app` calls this just before configuring the TUI display mode. A test verifies the expected combinations.

*Call graph*: called by 1 (run_ratatui_app).


##### `get_login_status`  (lines 1865–1880)

```
async fn get_login_status(
    app_server: &mut AppServerSession,
    config: &Config,
) -> color_eyre::Result<LoginStatus>
```

**Purpose**: Checks whether the user is logged in, without doing a heavier full app-server bootstrap. This avoids unnecessary model-list fetches and rate-limit work during startup.

**Data flow**: It receives the app server session and config. If the chosen provider does not require OpenAI-style auth, it returns not authenticated; otherwise it reads the account and maps API-key or ChatGPT accounts to login modes.

**Call relations**: `run_ratatui_app` calls this before deciding whether onboarding should show a login screen.

*Call graph*: calls 1 internal fn (read_account); called by 1 (run_ratatui_app); 1 external calls (AuthMode).


##### `load_config_or_exit`  (lines 1882–1898)

```
async fn load_config_or_exit(
    cli_kv_overrides: Vec<(String, toml::Value)>,
    overrides: ConfigOverrides,
    loader_overrides: LoaderOverrides,
    cloud_config_bundle: CloudConfigBundleLoader,
```

**Purpose**: Loads the full runtime configuration and exits the process with a message if it fails. It is the simple version used when no fallback current directory is needed.

**Data flow**: It receives CLI overrides, structured overrides, loader overrides, cloud config loader, and strict mode. It forwards them to the fallback-capable loader with no fallback directory and returns a config on success.

**Call relations**: `run_main` and `run_ratatui_app` use this after initial setup, onboarding, and some picker flows.

*Call graph*: calls 1 internal fn (load_config_or_exit_with_fallback_cwd); called by 2 (run_main, run_ratatui_app).


##### `load_config_or_exit_with_fallback_cwd`  (lines 1900–1925)

```
async fn load_config_or_exit_with_fallback_cwd(
    cli_kv_overrides: Vec<(String, toml::Value)>,
    overrides: ConfigOverrides,
    loader_overrides: LoaderOverrides,
    cloud_config_bundle: CloudC
```

**Purpose**: Loads the full runtime configuration, optionally using a fallback current directory for resumed or forked sessions. On failure it prints the error and exits.

**Data flow**: It builds a `ConfigBuilder` from CLI overrides, harness overrides, loader overrides, strict mode, cloud config, and fallback directory. Success returns the config; failure writes to standard error and terminates the process.

**Call relations**: `load_config_or_exit` delegates here, and `run_ratatui_app` calls it directly when resume/fork changes the effective directory.

*Call graph*: called by 2 (load_config_or_exit, run_ratatui_app); 3 external calls (default, eprintln!, exit).


##### `load_bootstrap_config_or_exit`  (lines 1928–1965)

```
async fn load_bootstrap_config_or_exit(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_kv_overrides: Vec<(String, codex_config::TomlValue)>,
    loader_overrides: LoaderOverrides,
```

**Purpose**: Loads just enough config-file data to make early startup decisions such as cloud config and OSS provider selection. It gives detailed source-formatted errors for config file problems.

**Data flow**: It receives Codex home, optional config current directory, CLI overrides, loader options, strict mode, and cloud config loader. It loads the TOML layer stack and returns it; on error it formats the problem and exits.

**Call relations**: `run_main` calls this before full config construction, including an additional load when OSS provider resolution needs cloud-managed settings.

*Call graph*: calls 1 internal fn (load_config_toml_with_layer_stack); called by 1 (run_main); 2 external calls (eprintln!, exit).


##### `should_show_trust_screen`  (lines 1968–1970)

```
fn should_show_trust_screen(config: &Config) -> bool
```

**Purpose**: Decides whether the user still needs to choose whether the current project directory is trusted. Trust affects what actions Codex may take automatically.

**Data flow**: It reads the active project trust level from config and returns true only when no trust decision exists.

**Call relations**: `run_ratatui_app` uses this for onboarding and startup prompts. Tests cover trusted, untrusted, and Windows-related cases.

*Call graph*: called by 4 (run_ratatui_app, untrusted_project_skips_trust_prompt, windows_shows_trust_prompt_with_sandbox, windows_shows_trust_prompt_without_sandbox).


##### `should_show_onboarding`  (lines 1972–1982)

```
fn should_show_onboarding(
    login_status: LoginStatus,
    config: &Config,
    show_trust_screen: bool,
) -> bool
```

**Purpose**: Decides whether any onboarding screen should be shown at startup. Onboarding appears if trust is undecided or login is required.

**Data flow**: It receives login status, config, and whether the trust screen is needed. A needed trust screen immediately returns true; otherwise it asks whether the login screen is needed.

**Call relations**: `run_ratatui_app` uses this before running onboarding, and it delegates login-specific logic to `should_show_login_screen`.

*Call graph*: calls 1 internal fn (should_show_login_screen); called by 1 (run_ratatui_app).


##### `should_show_login_screen`  (lines 1984–1992)

```
fn should_show_login_screen(login_status: LoginStatus, config: &Config) -> bool
```

**Purpose**: Decides whether startup should prompt the user to log in. Providers that do not require OpenAI-style authentication skip this entirely.

**Data flow**: It receives login status and config. It returns false for providers without required auth, and otherwise returns true only when the user is not authenticated.

**Call relations**: `run_ratatui_app` uses it to configure onboarding, and `should_show_onboarding` uses it as the login part of the onboarding decision.

*Call graph*: called by 2 (run_ratatui_app, should_show_onboarding).


##### `tests::build_config`  (lines 2009–2014)

```
async fn build_config(temp_dir: &TempDir) -> std::io::Result<Config>
```

**Purpose**: Creates a basic test configuration rooted in a temporary directory. It keeps tests isolated from the user’s real Codex home.

**Data flow**: It receives a temporary directory, passes its path into the config builder, and returns the built config.

**Call relations**: Many tests call this helper before exercising startup, session lookup, trust, or config behavior.

*Call graph*: 2 external calls (path, default).


##### `tests::write_session_rollout`  (lines 2016–2093)

```
fn write_session_rollout(
        codex_home: &Path,
        filename_ts: &str,
        meta_rfc3339: &str,
        preview: &str,
        model_provider: &str,
        cwd: &Path,
    ) -> color_eyre
```

**Purpose**: Writes a small fake saved-session rollout file for tests. This lets session lookup tests behave as if a real past conversation exists.

**Data flow**: It receives Codex home, timestamps, preview text, model provider, and current directory. It creates the expected session file path, writes JSON lines with metadata and a user message, sets the file timestamp, and returns the new thread ID.

**Call relations**: Session lookup tests use this to create old and new sessions that the embedded app server can discover.

*Call graph*: calls 1 internal fn (from_string); 12 external calls (default, join, to_path_buf, new_v4, parse_from_rfc3339, format!, json!, to_value, new, new (+2 more)).


##### `tests::startup_removes_legacy_tui_log_file`  (lines 2096–2107)

```
fn startup_removes_legacy_tui_log_file() -> std::io::Result<()>
```

**Purpose**: Verifies that startup cleanup deletes the old shared TUI log file.

**Data flow**: It creates a temporary log file, calls the cleanup helper, and checks that the file no longer exists.

**Call relations**: This directly tests `remove_legacy_tui_log_file`.

*Call graph*: calls 1 internal fn (remove_legacy_tui_log_file); 4 external calls (new, assert!, create_dir_all, write).


##### `tests::start_test_embedded_app_server`  (lines 2109–2127)

```
async fn start_test_embedded_app_server(
        config: Config,
    ) -> color_eyre::Result<InProcessAppServerClient>
```

**Purpose**: Starts a real embedded app server for tests using safe defaults. It avoids duplicating setup code across app-server-related tests.

**Data flow**: It receives config, initializes state database, builds default test services, and returns an in-process app server client.

**Call relations**: Tests that need app-server RPCs or session lookup call this helper, which calls the production embedded startup path.

*Call graph*: calls 5 internal fn (default, default_for_tests, new, init_state_db_for_app_server_target, start_embedded_app_server); 4 external calls (new, new, default, default).


##### `tests::alternate_screen_auto_uses_alt_screen`  (lines 2130–2147)

```
fn alternate_screen_auto_uses_alt_screen()
```

**Purpose**: Checks the rules for alternate-screen mode. It ensures config and the `--no-alt-screen` flag combine as intended.

**Data flow**: It calls the mode-deciding helper with several inputs and asserts the expected booleans.

**Call relations**: This protects `determine_alt_screen_mode`, which `run_ratatui_app` uses before launching the UI.

*Call graph*: 1 external calls (assert!).


##### `tests::session_target_display_label_falls_back_to_thread_id`  (lines 2150–2158)

```
fn session_target_display_label_falls_back_to_thread_id()
```

**Purpose**: Confirms that a session target without a file path still has a useful display label. The fallback label uses the thread ID.

**Data flow**: It creates a target with no path and checks that its display label is `thread <id>`.

**Call relations**: This indirectly protects resume picker display behavior.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::resolve_remote_addr_accepts_websocket_url`  (lines 2161–2169)

```
fn resolve_remote_addr_accepts_websocket_url()
```

**Purpose**: Verifies that a plain WebSocket address with an explicit port is accepted.

**Data flow**: It resolves `ws://127.0.0.1:4500` and checks that the normalized endpoint is a WebSocket URL with no auth token.

**Call relations**: This covers the WebSocket branch of `resolve_remote_addr`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_remote_addr_accepts_secure_websocket_url`  (lines 2172–2180)

```
fn resolve_remote_addr_accepts_secure_websocket_url()
```

**Purpose**: Verifies that a secure WebSocket address with an explicit default port is accepted.

**Data flow**: It resolves a `wss://` URL and checks that URL normalization still produces the expected endpoint.

**Call relations**: This protects the explicit-port detection used by `resolve_remote_addr`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_remote_addr_accepts_default_socket`  (lines 2183–2192)

```
fn resolve_remote_addr_accepts_default_socket() -> color_eyre::Result<()>
```

**Purpose**: Checks that `unix://` means the default Codex app-server socket.

**Data flow**: It finds Codex home, resolves `unix://`, and compares the result with the standard control socket path.

**Call relations**: This tests the default Unix socket path branch of `resolve_remote_addr`.

*Call graph*: 2 external calls (assert_eq!, find_codex_home).


##### `tests::resolve_remote_addr_accepts_relative_socket_path`  (lines 2195–2203)

```
fn resolve_remote_addr_accepts_relative_socket_path() -> color_eyre::Result<()>
```

**Purpose**: Checks that relative Unix socket paths are accepted and made absolute relative to the current directory.

**Data flow**: It resolves `unix://codex.sock` and compares the endpoint with the expected absolute path wrapper.

**Call relations**: This covers the relative-path branch of `resolve_remote_addr`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_remote_addr_accepts_absolute_socket_path`  (lines 2206–2216)

```
fn resolve_remote_addr_accepts_absolute_socket_path() -> color_eyre::Result<()>
```

**Purpose**: Checks that absolute Unix socket paths are accepted as remote endpoints.

**Data flow**: It creates a temporary absolute path, formats it as `unix://...`, resolves it, and compares the endpoint.

**Call relations**: This covers the absolute-path branch of `resolve_remote_addr`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::resolve_remote_addr_rejects_invalid_remote_addresses`  (lines 2219–2231)

```
fn resolve_remote_addr_rejects_invalid_remote_addresses()
```

**Purpose**: Verifies that incomplete or unsupported remote address strings fail clearly.

**Data flow**: It tries several invalid addresses and checks that each error mentions the expected accepted formats.

**Call relations**: This directly protects `resolve_remote_addr` validation.

*Call graph*: calls 1 internal fn (resolve_remote_addr); 1 external calls (assert!).


##### `tests::default_daemon_auto_connect_skips_missing_socket`  (lines 2234–2242)

```
async fn default_daemon_auto_connect_skips_missing_socket() -> color_eyre::Result<()>
```

**Purpose**: Checks that daemon auto-connect does nothing when the default socket is absent.

**Data flow**: It creates a temporary Codex home with no socket, probes it, and asserts that no socket path is returned.

**Call relations**: This tests the missing-socket path in `maybe_probe_default_daemon_socket`.

*Call graph*: 2 external calls (new, assert!).


##### `tests::default_daemon_auto_connect_probes_socket_only`  (lines 2246–2258)

```
async fn default_daemon_auto_connect_probes_socket_only() -> color_eyre::Result<()>
```

**Purpose**: On Unix, verifies that auto-connect recognizes a live default daemon socket.

**Data flow**: It creates the socket directory, binds a Unix listener at the standard path, probes, and expects that path back.

**Call relations**: This tests the successful socket-probe path used by `run_main`.

*Call graph*: calls 1 internal fn (bind); 4 external calls (new, assert_eq!, app_server_control_socket_path, create_dir_all).


##### `tests::app_server_target_for_launch_uses_local_daemon_for_default_socket`  (lines 2261–2279)

```
fn app_server_target_for_launch_uses_local_daemon_for_default_socket() -> color_eyre::Result<()>
```

**Purpose**: Checks that startup chooses a local daemon when reuse is allowed and a default socket was found.

**Data flow**: It passes no explicit remote endpoint, a socket path, and reuse allowed; then it asserts the target is `LocalDaemon`.

**Call relations**: This directly tests `app_server_target_for_launch` and its local-daemon branch.

*Call graph*: calls 2 internal fn (app_server_target_for_launch, relative_to_current_dir); 2 external calls (assert!, assert_eq!).


##### `tests::app_server_target_for_launch_prefers_explicit_remote_endpoint`  (lines 2282–2301)

```
fn app_server_target_for_launch_prefers_explicit_remote_endpoint() -> color_eyre::Result<()>
```

**Purpose**: Checks that an explicitly supplied remote endpoint wins over an auto-detected local daemon.

**Data flow**: It passes both an explicit endpoint and a default socket, then asserts that the result is `Remote`.

**Call relations**: This protects the priority order inside `app_server_target_for_launch`.

*Call graph*: calls 2 internal fn (app_server_target_for_launch, relative_to_current_dir); 2 external calls (assert!, assert_eq!).


##### `tests::app_server_target_for_launch_skips_local_daemon_when_launch_config_is_not_replayable`  (lines 2304–2315)

```
fn app_server_target_for_launch_skips_local_daemon_when_launch_config_is_not_replayable() -> color_eyre::Result<()>
```

**Purpose**: Checks that startup does not reuse a daemon when the current launch has special settings the daemon cannot reproduce.

**Data flow**: It passes a default socket but marks reuse as disallowed, then expects the embedded target.

**Call relations**: This verifies the safety gate used before daemon reuse.

*Call graph*: calls 2 internal fn (app_server_target_for_launch, relative_to_current_dir); 1 external calls (assert_eq!).


##### `tests::can_reuse_implicit_local_daemon_requires_default_launch_config`  (lines 2318–2354)

```
fn can_reuse_implicit_local_daemon_requires_default_launch_config() -> color_eyre::Result<()>
```

**Purpose**: Verifies the conditions required for implicit local daemon reuse. Any non-default launch setting should disable reuse.

**Data flow**: It tries default inputs and then variations with CLI overrides, ignored user config, strict config, and non-replayable flags, checking true only for the default case.

**Call relations**: This directly tests `can_reuse_implicit_local_daemon` and its default-loader helper.

*Call graph*: 3 external calls (assert!, default, vec!).


##### `tests::should_load_configured_environments_for_local_daemon`  (lines 2357–2369)

```
fn should_load_configured_environments_for_local_daemon() -> color_eyre::Result<()>
```

**Purpose**: Confirms that local daemon mode still loads configured local environments when user config is allowed.

**Data flow**: It builds a local daemon target and checks that environment loading is enabled.

**Call relations**: This tests `should_load_configured_environments`, which `run_main` uses before creating an environment manager.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 1 external calls (assert!).


##### `tests::latest_session_lookup_params_keep_local_filters_for_embedded_sessions`  (lines 2372–2405)

```
async fn latest_session_lookup_params_keep_local_filters_for_embedded_sessions() -> std::io::Result<()>
```

**Purpose**: Checks that latest-session lookup for embedded sessions keeps local model-provider and directory filters.

**Data flow**: It builds config and a project path, creates lookup parameters, and asserts provider, directory, and database-only fields.

**Call relations**: This protects `latest_session_lookup_params` for embedded startup.

*Call graph*: calls 1 internal fn (latest_session_lookup_params); 4 external calls (new, assert!, assert_eq!, build_config).


##### `tests::latest_session_lookup_params_keep_local_filters_for_local_daemon_sessions`  (lines 2408–2433)

```
async fn latest_session_lookup_params_keep_local_filters_for_local_daemon_sessions() -> color_eyre::Result<()>
```

**Purpose**: Checks that local daemon session lookup behaves like embedded lookup for local filters.

**Data flow**: It builds a local daemon target and asserts that lookup parameters include the local model provider and current directory filter.

**Call relations**: This verifies local daemon behavior in `latest_session_lookup_params`.

*Call graph*: calls 2 internal fn (latest_session_lookup_params, relative_to_current_dir); 3 external calls (new, assert_eq!, build_config).


##### `tests::latest_session_lookup_params_omit_local_filters_for_remote_sessions`  (lines 2436–2452)

```
async fn latest_session_lookup_params_omit_local_filters_for_remote_sessions() -> std::io::Result<()>
```

**Purpose**: Checks that remote session lookup does not include local-only filters.

**Data flow**: It builds lookup parameters with remote mode enabled and asserts that model provider and current-directory filters are omitted.

**Call relations**: This protects the remote branch of `latest_session_lookup_params`.

*Call graph*: calls 1 internal fn (latest_session_lookup_params); 3 external calls (new, assert_eq!, build_config).


##### `tests::latest_session_lookup_params_can_include_non_interactive_sources`  (lines 2455–2478)

```
async fn latest_session_lookup_params_can_include_non_interactive_sources() -> std::io::Result<()>
```

**Purpose**: Verifies that latest-session lookup can include non-interactive sessions when requested.

**Data flow**: It builds parameters with the include flag enabled and checks that CLI, VS Code, Exec, and AppServer sources are listed.

**Call relations**: This tests `resume_source_kinds` through `latest_session_lookup_params`.

*Call graph*: calls 1 internal fn (latest_session_lookup_params); 3 external calls (new, assert_eq!, build_config).


##### `tests::latest_session_lookup_params_keep_explicit_cwd_filter_for_remote_sessions`  (lines 2481–2501)

```
async fn latest_session_lookup_params_keep_explicit_cwd_filter_for_remote_sessions() -> std::io::Result<()>
```

**Purpose**: Checks that a remote workspace can still use an explicit remote current-directory filter.

**Data flow**: It passes a remote path string as the filter and confirms it appears in the lookup parameters while local provider filtering stays absent.

**Call relations**: This covers remote filtered lookup in `latest_session_lookup_params`.

*Call graph*: calls 1 internal fn (latest_session_lookup_params); 4 external calls (new, new, assert_eq!, build_config).


##### `tests::latest_session_cwd_filter_respects_scope_options`  (lines 2504–2528)

```
async fn latest_session_cwd_filter_respects_scope_options() -> std::io::Result<()>
```

**Purpose**: Verifies how latest-session directory scoping is chosen. Local sessions use the config directory, show-all removes the filter, and remote sessions use the remote override.

**Data flow**: It calls the filter helper for local, show-all, and remote cases, then compares each result.

**Call relations**: This directly tests `latest_session_cwd_filter`, which `run_ratatui_app` uses for `--last` operations.

*Call graph*: calls 1 internal fn (latest_session_cwd_filter); 4 external calls (new, new, assert_eq!, build_config).


##### `tests::fork_last_filters_latest_session_by_cwd_unless_show_all`  (lines 2531–2599)

```
async fn fork_last_filters_latest_session_by_cwd_unless_show_all() -> color_eyre::Result<()>
```

**Purpose**: Checks that `fork --last` chooses the latest session in the current project unless the user asks to show all sessions.

**Data flow**: It creates two fake sessions in different directories, starts an embedded server, performs scoped and global latest lookups, and compares the returned thread IDs.

**Call relations**: This exercises `latest_session_cwd_filter` and `lookup_latest_session_target_with_app_server` together.

*Call graph*: calls 3 internal fn (new, latest_session_cwd_filter, lookup_latest_session_target_with_app_server); 8 external calls (default, new, InProcess, assert_eq!, default, create_dir_all, start_test_embedded_app_server, write_session_rollout).


##### `tests::latest_session_lookup_falls_back_for_rollout_missing_from_state_db`  (lines 2602–2644)

```
async fn latest_session_lookup_falls_back_for_rollout_missing_from_state_db() -> color_eyre::Result<()>
```

**Purpose**: Verifies that latest-session lookup can still find a rollout file that was not in the state database. This protects compatibility with legacy writers.

**Data flow**: It starts an embedded server, writes a fake rollout after backfill, asks for the latest session, and checks that the fallback scan finds it.

**Call relations**: This tests the scan-and-repair fallback inside `lookup_latest_session_target_with_app_server`.

*Call graph*: calls 2 internal fn (new, lookup_latest_session_target_with_app_server); 8 external calls (default, new, InProcess, assert_eq!, default, create_dir_all, start_test_embedded_app_server, write_session_rollout).


##### `tests::config_cwd_for_app_server_target_omits_cwd_for_remote_sessions`  (lines 2647–2666)

```
async fn config_cwd_for_app_server_target_omits_cwd_for_remote_sessions() -> std::io::Result<()>
```

**Purpose**: Checks that config loading does not try to canonicalize a remote-only path on the local machine.

**Data flow**: It supplies a deliberately non-local-looking path with a remote target and expects no config current directory.

**Call relations**: This protects the remote branch of `config_cwd_for_app_server_target`.

*Call graph*: calls 3 internal fn (default_for_tests, config_cwd_for_app_server_target, relative_to_current_dir); 3 external calls (new, assert_eq!, cfg!).


##### `tests::config_cwd_for_app_server_target_canonicalizes_embedded_cli_cwd`  (lines 2669–2685)

```
async fn config_cwd_for_app_server_target_canonicalizes_embedded_cli_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that embedded startup canonicalizes a supplied local current directory.

**Data flow**: It passes a temporary directory as CLI cwd and expects the canonical absolute path back.

**Call relations**: This tests local path handling in `config_cwd_for_app_server_target`.

*Call graph*: calls 2 internal fn (default_for_tests, config_cwd_for_app_server_target); 2 external calls (new, assert_eq!).


##### `tests::config_cwd_for_app_server_target_canonicalizes_local_daemon_cli_cwd`  (lines 2688–2708)

```
async fn config_cwd_for_app_server_target_canonicalizes_local_daemon_cli_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that local daemon startup also canonicalizes a supplied local current directory.

**Data flow**: It passes a temporary directory with a local daemon target and expects the canonical absolute path.

**Call relations**: This confirms local daemon mode follows local cwd rules.

*Call graph*: calls 3 internal fn (default_for_tests, config_cwd_for_app_server_target, relative_to_current_dir); 2 external calls (new, assert_eq!).


##### `tests::config_cwd_for_app_server_target_errors_for_missing_embedded_cli_cwd`  (lines 2711–2723)

```
async fn config_cwd_for_app_server_target_errors_for_missing_embedded_cli_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that embedded startup reports an error when the requested local current directory does not exist.

**Data flow**: It passes a missing path and asserts that the result is a not-found error.

**Call relations**: This protects the error path in `config_cwd_for_app_server_target`.

*Call graph*: calls 2 internal fn (default_for_tests, config_cwd_for_app_server_target); 2 external calls (new, assert_eq!).


##### `tests::config_cwd_for_app_server_target_omits_cwd_for_remote_exec_server`  (lines 2726–2748)

```
async fn config_cwd_for_app_server_target_omits_cwd_for_remote_exec_server() -> std::io::Result<()>
```

**Purpose**: Checks that a remote execution environment also suppresses local current-directory canonicalization, even with an embedded app server target.

**Data flow**: It creates a test environment manager marked remote, passes a non-local-looking path, and expects no config cwd.

**Call relations**: This tests the environment-manager branch of `config_cwd_for_app_server_target`.

*Call graph*: calls 3 internal fn (create_for_tests, new, config_cwd_for_app_server_target); 4 external calls (new, assert_eq!, cfg!, current_exe).


##### `tests::windows_shows_trust_prompt_without_sandbox`  (lines 2752–2764)

```
async fn windows_shows_trust_prompt_without_sandbox() -> std::io::Result<()>
```

**Purpose**: Verifies that an undecided project trust level causes the trust prompt to appear, even when Windows sandboxing is disabled.

**Data flow**: It builds config, clears the trust level, disables sandboxing, and checks that the trust screen is needed.

**Call relations**: This tests `should_show_trust_screen`.

*Call graph*: calls 1 internal fn (should_show_trust_screen); 3 external calls (new, assert!, build_config).


##### `tests::embedded_app_server_supports_thread_start_rpc`  (lines 2767–2785)

```
async fn embedded_app_server_supports_thread_start_rpc() -> color_eyre::Result<()>
```

**Purpose**: Checks that the embedded app server can accept a basic thread-start request.

**Data flow**: It starts a test embedded server, sends a `thread/start` request for an ephemeral thread, checks that an ID is returned, and shuts the server down.

**Call relations**: This verifies the embedded startup path used by `start_embedded_app_server`.

*Call graph*: 6 external calls (new, Integer, default, assert!, build_config, start_test_embedded_app_server).


##### `tests::lookup_session_target_by_name_uses_backend_title_search`  (lines 2788–2850)

```
async fn lookup_session_target_by_name_uses_backend_title_search() -> color_eyre::Result<()>
```

**Purpose**: Verifies that session lookup by name uses the backend title search and returns the right path and thread ID.

**Data flow**: It creates state database metadata for a titled session, starts an embedded app server, searches by title, and compares the returned target.

**Call relations**: This directly tests `lookup_session_target_by_name_with_app_server`.

*Call graph*: calls 5 internal fn (new, new, init, new, lookup_session_target_by_name_with_app_server); 12 external calls (pin, new, InProcess, assert_eq!, parse_from_rfc3339, format!, from_value, json!, create_dir_all, write (+2 more)).


##### `tests::embedded_app_server_start_failure_is_returned`  (lines 2853–2881)

```
async fn embedded_app_server_start_failure_is_returned() -> color_eyre::Result<()>
```

**Purpose**: Checks that embedded app-server startup failures are returned with useful context.

**Data flow**: It calls the generic embedded startup helper with a fake starter that returns an error, then asserts the error text includes embedded startup context.

**Call relations**: This tests the error wrapping in `start_embedded_app_server_with`.

*Call graph*: calls 4 internal fn (default, default_for_tests, new, start_embedded_app_server_with); 8 external calls (new, new, new, default, assert!, default, panic!, build_config).


##### `tests::embedded_state_db_failure_is_typed_for_cli_recovery`  (lines 2884–2912)

```
async fn embedded_state_db_failure_is_typed_for_cli_recovery() -> color_eyre::Result<()>
```

**Purpose**: Verifies that embedded state database initialization failures keep typed context for recovery code.

**Data flow**: It makes the SQLite home path invalid by occupying it with a file, initializes state DB, extracts the typed startup error, and checks path and detail text.

**Call relations**: This protects `init_state_db_for_app_server_target` error conversion.

*Call graph*: calls 1 internal fn (init_state_db_for_app_server_target); 6 external calls (new, assert!, assert_eq!, panic!, write, build_config).


##### `tests::embedded_state_db_corruption_preserves_failed_database_for_cli_recovery`  (lines 2915–2942)

```
async fn embedded_state_db_corruption_preserves_failed_database_for_cli_recovery() -> color_eyre::Result<()>
```

**Purpose**: Checks that state database corruption errors identify the actual corrupted database file.

**Data flow**: It writes invalid data into the logs database path, attempts embedded state initialization, extracts the typed error, and checks that corruption details are preserved.

**Call relations**: This tests the corruption-reporting branch of `init_state_db_for_app_server_target`.

*Call graph*: calls 1 internal fn (init_state_db_for_app_server_target); 8 external calls (new, assert!, assert_eq!, logs_db_path, panic!, create_dir_all, write, build_config).


##### `tests::windows_shows_trust_prompt_with_sandbox`  (lines 2946–2965)

```
async fn windows_shows_trust_prompt_with_sandbox() -> std::io::Result<()>
```

**Purpose**: Verifies that an undecided project trust level still triggers the trust prompt when Windows sandboxing is enabled.

**Data flow**: It builds config, clears trust level, enables sandboxing, and asserts that the trust prompt is shown.

**Call relations**: This tests `should_show_trust_screen` across platform-sensitive setup.

*Call graph*: calls 1 internal fn (should_show_trust_screen); 4 external calls (new, assert!, cfg!, build_config).


##### `tests::untrusted_project_skips_trust_prompt`  (lines 2967–2981)

```
async fn untrusted_project_skips_trust_prompt() -> std::io::Result<()>
```

**Purpose**: Confirms that a project explicitly marked untrusted does not ask for another trust decision.

**Data flow**: It sets the project trust level to untrusted and checks that the trust screen is not needed.

**Call relations**: This protects the simple `none means undecided` rule in `should_show_trust_screen`.

*Call graph*: calls 1 internal fn (should_show_trust_screen); 3 external calls (new, assert!, build_config).


##### `tests::config_rebuild_changes_trust_defaults_with_cwd`  (lines 2984–3035)

```
async fn config_rebuild_changes_trust_defaults_with_cwd() -> std::io::Result<()>
```

**Purpose**: Verifies that rebuilding config with a different current directory changes project-specific trust defaults. This matters when resume or fork moves the effective directory.

**Data flow**: It writes config entries for trusted and untrusted directories, builds config for each directory, and checks the resulting approval policy.

**Call relations**: This supports the config-reload behavior in `run_ratatui_app` after session selection.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 7 external calls (default, new, assert_eq!, default, format!, create_dir_all, write).


##### `tests::theme_warning_uses_final_config`  (lines 3050–3079)

```
async fn theme_warning_uses_final_config() -> std::io::Result<()>
```

**Purpose**: Checks that syntax highlighting theme validation uses the final config, not an earlier config loaded before onboarding or resume/fork.

**Data flow**: It builds an initial config, then simulates a final config with an invalid theme, validates that theme, and checks that the warning lands in final startup warnings.

**Call relations**: This protects the ordering in `run_ratatui_app`, where theme setup happens after the last possible config reload.

*Call graph*: 4 external calls (new, assert!, assert_eq!, build_config).


### `tui/src/oss_selection.rs`

`orchestration` · `startup`

This file is a small startup wizard for choosing a local AI server. Before the main terminal app is fully running, it looks for LM Studio and Ollama on their usual local ports. If exactly one is responding, it quietly chooses that one so the user is not interrupted. If the situation is unclear, for example both are running or neither is running, it opens a simple full-screen terminal prompt and asks the user to choose.

The screen shows each provider with a status symbol: a filled dot for running, an empty dot for not running, and a question mark if the check failed. It also shows two selectable buttons, one for LM Studio and one for Ollama. The user can move left and right with arrow keys or Ctrl+H/Ctrl+L, press Enter to choose, press the provider’s letter shortcut, or cancel with Ctrl+C. Escape falls back to LM Studio.

Technically, the file combines three jobs: probing local HTTP ports, drawing the selection widget using Ratatui, and reading keyboard events using Crossterm. It also takes care to put the terminal into “raw mode” and an alternate screen while the prompt is open, then restores the terminal afterward. Without this file, users with local open-source providers would either need manual configuration or the app might guess incorrectly.

#### Function details

##### `OssSelectionWidget::new`  (lines 110–162)

```
fn new(lmstudio_status: ProviderStatus, ollama_status: ProviderStatus) -> io::Result<Self>
```

**Purpose**: Builds the on-screen provider selection widget. It prepares the text, provider status lines, selectable options, and initial state before anything is drawn.

**Data flow**: It receives the current LM Studio and Ollama status values. It turns those into display rows with colored symbols, builds a prompt explaining what the user should do, starts with the first provider option selected, and returns a ready-to-render widget.

**Call relations**: This is used by the startup provider chooser before showing the terminal prompt. The test also uses it to create a widget and check that keyboard navigation works. While building the prompt, it asks get_status_symbol_and_color how each status should look.

*Call graph*: calls 1 internal fn (get_status_symbol_and_color); called by 2 (select_oss_provider, ctrl_h_l_move_provider_selection); 3 external calls (from, new, vec!).


##### `OssSelectionWidget::get_confirmation_prompt_height`  (lines 164–167)

```
fn get_confirmation_prompt_height(&self, width: u16) -> u16
```

**Purpose**: Calculates how many terminal rows the explanatory prompt needs at a given width. This keeps the layout from overlapping when the terminal is narrow or wide.

**Data flow**: It receives a width in terminal columns, asks the prompt how many wrapped lines it will occupy, and returns that count as a height.

**Call relations**: The drawing code uses this before splitting the screen into prompt and button areas. desired_height also uses it when another part of the interface wants to know how much vertical space the widget needs.

*Call graph*: called by 2 (desired_height, render_ref); 1 external calls (line_count).


##### `OssSelectionWidget::handle_key_event`  (lines 174–183)

```
fn handle_key_event(&mut self, key: KeyEvent) -> Option<String>
```

**Purpose**: Receives a keyboard event and updates the widget if the key was actually pressed. If the key completes the choice, it returns the selected provider string.

**Data flow**: It takes one key event. If the event is a real key press, it passes it to the selection-key logic. Afterward, if the widget has been marked done, it returns the stored selection; otherwise it returns nothing.

**Call relations**: This is the widget’s main input doorway during the selection screen. It delegates the details of what each key means to handle_select_key, then reports completion back to the surrounding startup loop.

*Call graph*: calls 1 internal fn (handle_select_key).


##### `OssSelectionWidget::normalize_keycode`  (lines 188–193)

```
fn normalize_keycode(code: KeyCode) -> KeyCode
```

**Purpose**: Makes letter keys easier to compare by treating uppercase and lowercase as the same. This lets shortcuts like L and l mean the same thing.

**Data flow**: It receives a key code. If it is a character, it converts that character to lowercase; if it is any other kind of key, such as Enter or Escape, it leaves it unchanged and returns it.

**Call relations**: The provider shortcut logic uses this while matching a typed key against each option’s configured shortcut. handle_select_key relies on it so shortcut matching is case-insensitive.

*Call graph*: 1 external calls (Char).


##### `OssSelectionWidget::handle_select_key`  (lines 195–235)

```
fn handle_select_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Interprets the user’s key press while the provider picker is open. It moves the highlighted option, chooses a provider, or cancels depending on the key.

**Data flow**: It receives a key event and compares it against known actions. Ctrl+C stores a cancellation marker, left and right movement keys change the selected index, Enter stores the currently highlighted provider, Escape stores the LM Studio provider, and letter shortcuts store the matching provider.

**Call relations**: handle_key_event calls this whenever a real key press arrives. When a key means the user has made a final choice, this function hands the chosen string to send_decision; when it needs shortcut matching, it uses normalize_keycode.

*Call graph*: calls 1 internal fn (send_decision); called by 1 (handle_key_event); 1 external calls (normalize_keycode).


##### `OssSelectionWidget::send_decision`  (lines 237–240)

```
fn send_decision(&mut self, selection: String)
```

**Purpose**: Records that the user has made a final choice. After this runs, the widget is considered complete and can be removed.

**Data flow**: It receives the selected provider string, saves it inside the widget, and flips the done flag to true. It does not return anything; it changes the widget’s stored state.

**Call relations**: The key-handling logic calls this whenever a key press resolves the prompt, such as Enter, Escape, Ctrl+C, or a provider shortcut. Later, handle_key_event can return the stored selection because this function has marked the widget finished.

*Call graph*: called by 1 (handle_select_key).


##### `OssSelectionWidget::is_complete`  (lines 244–246)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the widget has already received a final choice. Other code can use this to know whether it should stop showing the prompt.

**Data flow**: It reads the widget’s internal done flag and returns true or false. It does not change anything.

**Call relations**: This is a small status check for callers that need to know whether the selection screen is finished. It reflects the state set by send_decision.


##### `OssSelectionWidget::desired_height`  (lines 248–250)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Tells the surrounding interface how tall the widget wants to be. This helps reserve enough room for both the explanatory prompt and the provider buttons.

**Data flow**: It receives the available width, calculates the wrapped prompt height, adds one row per selectable option, and returns the total desired height.

**Call relations**: It builds on get_confirmation_prompt_height instead of recalculating that directly. This is useful when a parent view needs to lay out the widget before rendering it.

*Call graph*: calls 1 internal fn (get_confirmation_prompt_height).


##### `OssSelectionWidget::render_ref`  (lines 254–300)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the provider picker into the terminal screen buffer. It lays out the prompt, selectable provider buttons, and the description of the currently highlighted option.

**Data flow**: It receives a rectangular screen area and a mutable drawing buffer. It splits the area into sections, styles the selected option differently from the others, renders the status prompt, draws the provider buttons, and writes the selected provider’s description below.

**Call relations**: The startup selection loop calls this each time it redraws the terminal. It asks get_confirmation_prompt_height how much space the prompt needs, then uses Ratatui layout and rendering tools to paint the widget.

*Call graph*: calls 1 internal fn (get_confirmation_prompt_height); 9 external calls (Length, Min, default, horizontal, vertical, from, new, clone, new).


##### `get_status_symbol_and_color`  (lines 303–309)

```
fn get_status_symbol_and_color(status: &ProviderStatus) -> (&'static str, Color)
```

**Purpose**: Chooses the visible symbol and color for a provider’s running status. This turns an internal status value into something a human can read quickly.

**Data flow**: It receives a provider status. Running becomes a green filled dot, not running becomes a red empty dot, and unknown becomes a yellow question mark; it returns both the symbol and the color.

**Call relations**: OssSelectionWidget::new calls this while building the status list shown in the prompt. It keeps the display rules in one place so the widget setup stays readable.

*Call graph*: called by 1 (new).


##### `select_oss_provider`  (lines 316–370)

```
async fn select_oss_provider() -> io::Result<OssProviderSelection>
```

**Purpose**: Runs the full provider selection process from start to finish. It checks local provider availability, auto-selects when possible, or opens the terminal UI when the user must decide.

**Data flow**: It first checks LM Studio and Ollama. If only one is running, it returns that provider with a flag saying it was not manually selected. Otherwise it creates the selection widget, switches the terminal into a special interactive mode, repeatedly draws the prompt and reads keys, then returns the chosen provider with a flag saying the user selected it.

**Call relations**: This is called during the main startup path. It relies on check_lmstudio_status and check_ollama_status for the initial probe, creates the widget with OssSelectionWidget::new, uses terminal drawing and keyboard reading while the prompt is visible, and restores the terminal before returning.

*Call graph*: calls 3 internal fn (new, check_lmstudio_status, check_ollama_status); called by 1 (run_main); 7 external calls (new, disable_raw_mode, enable_raw_mode, read, execute!, stdout, new).


##### `check_lmstudio_status`  (lines 372–378)

```
async fn check_lmstudio_status() -> ProviderStatus
```

**Purpose**: Checks whether LM Studio appears to be running on its default local port. It translates a low-level network check into the simple status used by the UI.

**Data flow**: It calls the shared port checker with LM Studio’s default port. A successful HTTP response becomes Running, a failed connection becomes NotRunning, and an unexpected checking error becomes Unknown.

**Call relations**: select_oss_provider calls this before deciding whether to auto-pick or show the prompt. It delegates the actual HTTP request work to check_port_status.

*Call graph*: calls 1 internal fn (check_port_status); called by 1 (select_oss_provider).


##### `check_ollama_status`  (lines 380–386)

```
async fn check_ollama_status() -> ProviderStatus
```

**Purpose**: Checks whether Ollama appears to be running on its default local port. It produces the same simple status categories used for display and auto-selection.

**Data flow**: It calls the shared port checker with Ollama’s default port. A successful HTTP response becomes Running, a failed connection becomes NotRunning, and an unexpected checking error becomes Unknown.

**Call relations**: select_oss_provider calls this alongside the LM Studio check. It uses check_port_status so both provider checks follow the same network-checking behavior.

*Call graph*: calls 1 internal fn (check_port_status); called by 1 (select_oss_provider).


##### `check_port_status`  (lines 388–400)

```
async fn check_port_status(port: u16) -> io::Result<bool>
```

**Purpose**: Tests whether something useful is responding at a local HTTP port. This is the basic probe used to guess whether a local provider server is running.

**Data flow**: It receives a port number, builds an HTTP client with a short two-second timeout, sends a GET request to localhost on that port, and returns true if the response status is successful. If the connection fails, it returns false; if the client cannot be built, it returns an input/output error.

**Call relations**: Both provider-specific status checks call this with their own default ports. By keeping the probing logic here, LM Studio and Ollama status checks differ only in which port they ask about.

*Call graph*: called by 2 (check_lmstudio_status, check_ollama_status); 3 external calls (from_secs, builder, format!).


##### `tests::ctrl_h_l_move_provider_selection`  (lines 407–416)

```
fn ctrl_h_l_move_provider_selection()
```

**Purpose**: Verifies that Ctrl+L moves the provider selection to the right and Ctrl+H moves it back to the left. This protects keyboard navigation that is important before the main app keymap is available.

**Data flow**: It creates a widget with unknown provider statuses, checks that the first option starts selected, sends a Ctrl+L key event and checks that the second option is selected, then sends a Ctrl+H key event and checks that selection returns to the first option.

**Call relations**: The test builds the widget through OssSelectionWidget::new and exercises its key-event path. It exists because this startup wizard has its own built-in movement keys rather than relying on the main application key configuration.

*Call graph*: calls 1 internal fn (new); 3 external calls (Char, new, assert_eq!).


### `tui/src/startup_hooks_review.rs`

`orchestration` · `startup`

Hooks are commands that can run automatically around tool use. Because trusted hooks may run outside the sandbox, this file adds a checkpoint at startup: if any hooks are new or changed, the terminal user interface pauses and asks what to do. Without this file, the app could either skip an important safety review or force users into the full hooks browser every time.

The flow starts by loading the hook list for the current working directory. If no review is needed, startup continues normally. If review is needed, the file builds a small standalone selection screen with three choices: review hooks, trust all and continue, or continue without trusting. It listens for keyboard events, redraws when the terminal changes, and reacts when the user picks an option.

The most sensitive path is “Trust all and continue.” The screen first changes into a disabled “Trusting hooks...” state so the user cannot press more choices while the write is in progress. It then sends trust updates to the app server for only the hooks that need review. If that write fails, the prompt reappears with the error shown in red. The file also includes tests that build fake hook data and check that the prompt appears correctly.

#### Function details

##### `load_startup_hooks_review_entry`  (lines 50–67)

```
async fn load_startup_hooks_review_entry(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> HooksListEntry
```

**Purpose**: Loads the hook information for the current folder before the startup review is shown. If the app server cannot provide the hook list, it logs a warning and returns an empty hook entry so startup can keep going safely.

**Data flow**: It receives an app server request handle and a current working directory path. It asks the server for the hook list, picks the entry that belongs to that directory, and returns it. If the request fails, it returns the same directory with no hooks, warnings, or errors.

**Call relations**: This is the loading step that prepares data for the later review decision. It calls the hook-list fetching code and the helper that finds the matching directory entry, then leaves the caller with a single HooksListEntry to inspect.

*Call graph*: calls 2 internal fn (fetch_hooks_list, hooks_list_entry_for_cwd); 3 external calls (clone, new, warn!).


##### `maybe_run_startup_hooks_review`  (lines 69–81)

```
async fn maybe_run_startup_hooks_review(
    app_server: &mut AppServerSession,
    tui: &mut Tui,
    config: &Config,
    bypass_hook_trust: bool,
    entry: HooksListEntry,
) -> Result<StartupHooks
```

**Purpose**: Decides whether the startup hook review screen should appear. It is the gate between normal startup and the safety prompt.

**Data flow**: It receives the app server session, terminal UI, configuration, a bypass flag, and the hook entry. It checks whether review is needed; if not, it returns Continue. If review is needed, it starts the interactive review screen and returns the user’s chosen outcome.

**Call relations**: The main terminal app startup calls this from run_ratatui_app. It first asks review_is_needed for the decision, and only hands control to run_startup_hooks_review_app when the user must be prompted.

*Call graph*: calls 2 internal fn (review_is_needed, run_startup_hooks_review_app); called by 1 (run_ratatui_app).


##### `run_startup_hooks_review_app`  (lines 83–173)

```
async fn run_startup_hooks_review_app(
    app_server: &mut AppServerSession,
    tui: &mut Tui,
    config: &Config,
    entry: HooksListEntry,
) -> Result<StartupHooksReviewOutcome>
```

**Purpose**: Runs the interactive startup prompt where the user chooses what to do about changed or untrusted hooks. It owns the short event loop for this prompt.

**Data flow**: It receives the live app server session, terminal UI, user configuration, and hook entry. It builds a keymap, creates the selection view, draws it, then reads terminal events. Depending on the chosen item, it returns either Continue or OpenHooksBrowser; for “trust all,” it writes trust records to the server and either continues or redraws with an error.

**Call relations**: maybe_run_startup_hooks_review calls this when a review is required. Inside the loop it uses selection_view to build the screen, draw_view to paint it, selected_choice to interpret completed selections, and write_hook_trusts to save trust decisions through the app server.

*Call graph*: calls 7 internal fn (new, request_handle, write_hook_trusts, from_config, draw_view, selected_choice, selection_view); called by 1 (maybe_run_startup_hooks_review); 4 external calls (event_stream, matches!, pin!, OpenHooksBrowser).


##### `selected_choice`  (lines 175–185)

```
fn selected_choice(view: &mut ListSelectionView) -> Option<StartupHooksReviewSelection>
```

**Purpose**: Turns the selection widget’s completed row into the meaning the startup flow needs. It translates list positions into actions like review, trust all, or continue without trusting.

**Data flow**: It receives a mutable selection view. If the view has not finished a selection, it returns nothing. If a selection is complete, it takes the selected index and converts it into a StartupHooksReviewSelection value.

**Call relations**: run_startup_hooks_review_app calls this after keyboard input. The review loop depends on it to know whether to redraw and wait, open the hooks browser, save trust, or continue.

*Call graph*: calls 2 internal fn (is_complete, take_last_selected_index); called by 1 (run_startup_hooks_review_app).


##### `selection_view`  (lines 187–199)

```
fn selection_view(
    entry: &HooksListEntry,
    trust_all_error: Option<&str>,
    trusting_all: bool,
    app_event_tx: AppEventSender,
    keymap: &RuntimeKeymap,
) -> ListSelectionView
```

**Purpose**: Builds the reusable list widget that appears in the startup prompt. It combines the visible prompt content with the event sender and keyboard bindings.

**Data flow**: It receives the hook entry, an optional trust error message, a flag saying whether trust-all is currently in progress, an app event sender, and the runtime keymap. It creates selection parameters and returns a ListSelectionView ready to draw and receive key events.

**Call relations**: run_startup_hooks_review_app uses this whenever the prompt state changes, including the initial prompt, the disabled “Trusting hooks...” state, and the error state. The rendering tests also call it to verify what users will see.

*Call graph*: calls 2 internal fn (new, selection_view_params); called by 3 (run_startup_hooks_review_app, renders_prompt, renders_prompt_with_trust_error).


##### `selection_view_params`  (lines 202–235)

```
fn selection_view_params(
    entry: &HooksListEntry,
    trust_all_error: Option<&str>,
    trusting_all: bool,
    keymap: &RuntimeKeymap,
) -> SelectionViewParams
```

**Purpose**: Creates the text and menu items for the startup review prompt. This is where the user-facing wording is assembled.

**Data flow**: It receives the hook entry, an optional error, a flag for the trust-in-progress state, and the keymap. It counts hooks needing review, builds a header with warning text, optionally adds either an error message or “Trusting hooks...”, and returns menu parameters with three choices and a keyboard hint footer.

**Call relations**: selection_view calls this before constructing the actual ListSelectionView. It uses review_needed_count to make the header accurate and standard_popup_hint_line_for_keymap so the footer matches the configured keys.

*Call graph*: calls 3 internal fn (standard_popup_hint_line_for_keymap, new, review_needed_count); called by 1 (selection_view); 6 external calls (new, default, from, new, format!, vec!).


##### `review_needed_count`  (lines 237–243)

```
fn review_needed_count(entry: &HooksListEntry) -> usize
```

**Purpose**: Counts how many hooks are new or changed enough to require the user’s attention. This keeps the prompt and the startup decision based on the same rule.

**Data flow**: It receives a HooksListEntry, looks through its hooks, filters to the hooks that need review, and returns the count.

**Call relations**: review_is_needed uses this to decide whether the prompt should open. selection_view_params uses the same count to tell the user how many hooks are affected.

*Call graph*: called by 2 (review_is_needed, selection_view_params).


##### `review_is_needed`  (lines 245–247)

```
fn review_is_needed(bypass_hook_trust: bool, entry: &HooksListEntry) -> bool
```

**Purpose**: Answers the simple startup question: should the hook review prompt be shown? It respects the bypass option as well as the hook state.

**Data flow**: It receives a bypass flag and a hook entry. If bypass is enabled, it returns false. Otherwise, it counts review-needed hooks and returns true only when the count is greater than zero.

**Call relations**: maybe_run_startup_hooks_review calls this before doing any UI work. The tests call it directly to confirm that bypass suppresses the prompt and untrusted hooks trigger it.

*Call graph*: calls 1 internal fn (review_needed_count); called by 1 (maybe_run_startup_hooks_review).


##### `selection_item`  (lines 249–256)

```
fn selection_item(name: &str, is_disabled: bool) -> SelectionItem
```

**Purpose**: Creates one menu row for the startup prompt. It gives each row a label and controls whether it is disabled.

**Data flow**: It receives the item name and a disabled flag. It returns a SelectionItem with that name, set to close the selection when chosen, and with the requested disabled state.

**Call relations**: selection_view_params uses this to create the three prompt choices. When trust-all is running, it passes the disabled flag so all choices become temporarily unavailable.

*Call graph*: 1 external calls (default).


##### `draw_view`  (lines 258–271)

```
fn draw_view(tui: &mut Tui, view: &ListSelectionView) -> Result<()>
```

**Purpose**: Paints the startup review prompt onto the terminal screen. It clears the current area first so the prompt is shown cleanly.

**Data flow**: It receives the terminal UI and the selection view. It asks the terminal to draw, clears the available area, computes a height that fits the view and screen, renders the standalone wrapper, and returns success or a drawing error.

**Call relations**: run_startup_hooks_review_app calls this after creating the view, after terminal resize or redraw events, and after state changes such as starting or failing “trust all.” It is the bridge from prompt state to visible terminal output.

*Call graph*: called by 1 (run_startup_hooks_review_app); 1 external calls (draw).


##### `StandaloneSelectionView::render_ref`  (lines 278–280)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Adapts the selection view so the terminal drawing library can render it as a widget. It is a small wrapper around the actual view rendering.

**Data flow**: It receives a screen rectangle and a text buffer. It asks the underlying ListSelectionView to draw itself into that rectangle and buffer.

**Call relations**: draw_view renders a StandaloneSelectionView when painting the prompt. This method is called by the terminal widget system during that draw.

*Call graph*: calls 1 internal fn (render).


##### `tests::hook`  (lines 304–322)

```
fn hook(key: &str, trust_status: HookTrustStatus) -> HookMetadata
```

**Purpose**: Builds a fake hook record for tests. This lets the tests create realistic hook data without repeating every field each time.

**Data flow**: It receives a hook key and a trust status. It fills in a HookMetadata object with fixed test values, uses the key in the hash, and returns the completed hook record.

**Call relations**: tests::entry calls this to make hooks that look new or changed. Those fake hooks then feed the startup review decision and rendering tests.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::entry`  (lines 324–334)

```
fn entry() -> HooksListEntry
```

**Purpose**: Creates a fake hook-list entry for the test project folder. It contains two hooks that should require review.

**Data flow**: It creates a test current directory path and a HooksListEntry with two fake hooks, one untrusted and one modified. It returns that entry with no warnings or errors.

**Call relations**: The review-decision tests and rendering tests use this as their shared sample input. It relies on tests::hook to create the hook metadata.

*Call graph*: 3 external calls (new, test_path_buf, vec!).


##### `tests::render_lines`  (lines 336–358)

```
fn render_lines(view: &crate::bottom_pane::ListSelectionView, width: u16) -> String
```

**Purpose**: Turns a rendered selection view into plain text for snapshot tests. This makes it easy to compare what the terminal prompt looks like.

**Data flow**: It receives a ListSelectionView and a width. It asks the view for its height, creates an empty terminal buffer, renders the view into it, reads every character back row by row, trims trailing spaces, and returns the resulting text.

**Call relations**: The rendering tests call this after building a selection_view. Its output is passed to the snapshot checker so changes to the prompt are visible in tests.

*Call graph*: calls 2 internal fn (desired_height, render); 2 external calls (empty, new).


##### `tests::bypass_hook_trust_suppresses_startup_review`  (lines 361–363)

```
fn bypass_hook_trust_suppresses_startup_review()
```

**Purpose**: Checks that the bypass option really prevents the startup prompt. This protects the intended behavior for users or modes that intentionally skip hook trust review.

**Data flow**: It creates the standard fake entry and calls review_is_needed with bypass turned on. It asserts that the result is false.

**Call relations**: This test calls review_is_needed directly. It confirms the first half of maybe_run_startup_hooks_review’s decision logic without needing to run the full UI.

*Call graph*: 1 external calls (assert!).


##### `tests::untrusted_hooks_need_review_without_bypass`  (lines 366–368)

```
fn untrusted_hooks_need_review_without_bypass()
```

**Purpose**: Checks that untrusted or changed hooks trigger the startup prompt when bypass is not enabled. This protects the safety checkpoint.

**Data flow**: It creates the standard fake entry and calls review_is_needed with bypass turned off. It asserts that the result is true.

**Call relations**: This test also focuses on review_is_needed. It verifies that the startup flow will enter run_startup_hooks_review_app when risky hooks are present.

*Call graph*: 1 external calls (assert!).


##### `tests::renders_prompt`  (lines 371–386)

```
fn renders_prompt()
```

**Purpose**: Checks the normal startup review prompt text and layout. It makes sure the user sees the expected choices and warning message.

**Data flow**: It creates a dummy app-event channel, uses default key bindings, builds a selection view from the fake hook entry, renders that view to text, and compares it with a saved snapshot.

**Call relations**: This test calls selection_view the same way the real prompt does, but without starting the full terminal event loop. The snapshot assertion catches accidental changes to the visible prompt.

*Call graph*: calls 3 internal fn (new, defaults, selection_view); 2 external calls (assert_snapshot!, entry).


##### `tests::renders_prompt_with_trust_error`  (lines 389–406)

```
fn renders_prompt_with_trust_error()
```

**Purpose**: Checks how the prompt looks after “trust all” fails. It ensures the error message is shown as part of the prompt instead of disappearing.

**Data flow**: It creates a dummy app-event channel, default key bindings, the fake hook entry, and a long sample error message. It builds the selection view with that error, renders it to text, and compares the result with a saved snapshot.

**Call relations**: This test covers the error path used by run_startup_hooks_review_app after write_hook_trusts fails. It calls selection_view directly so the visual state can be tested in isolation.

*Call graph*: calls 3 internal fn (new, defaults, selection_view); 2 external calls (assert_snapshot!, entry).


### `tui/src/app/startup_prompts.rs`

`orchestration` · `startup/bootstrap`

This file is the app’s startup “front desk.” Before the main terminal interface settles into normal use, the app may need to tell the user about skipped skills, disabled project settings, sandbox problems, or a recommended model change. Without these helpers, those situations might either be silent, confusing, or repeated too often.

The file turns internal state into clear interface events. For example, if a custom skill file cannot be loaded, it creates warning history cells so the user can see which file failed and why. It also remembers which skill errors are already active, so the same warning is not shown again and again unless it clears and later comes back.

A larger part of the file deals with model migration prompts. If the current model has a recommended replacement, the code checks whether the user has already seen that suggestion, whether the target model is actually available, and whether the prompt has been hidden in configuration. If the user accepts, it updates the in-memory config and sends events to persist the new choice.

There is also a small “new user experience” tooltip path for model availability messages, capped so it does not nag forever. Finally, one helper normalizes writable folder overrides so relative paths are interpreted from the chosen working directory.

#### Function details

##### `SkillLoadWarningState::clear`  (lines 22–24)

```
fn clear(&mut self)
```

**Purpose**: This resets the memory of which skill-loading warnings are currently active. It is useful when the app wants to allow the same warning to be shown again later.

**Data flow**: It takes the warning state as it exists now, removes every remembered warning key from it, and returns nothing. Afterward, the state behaves as if no skill warnings have been seen.

**Call relations**: The tests call this to confirm that clearing the state lets a still-existing skill error be reported again. In normal use, it supports the same warning-tracking flow used by SkillLoadWarningState::newly_active_errors.


##### `SkillLoadWarningState::newly_active_errors`  (lines 26–44)

```
fn newly_active_errors(&mut self, errors: &[SkillErrorInfo]) -> Vec<SkillErrorInfo>
```

**Purpose**: This compares the latest list of skill-loading errors with the errors that were already active, and returns only the ones that are new. It prevents the interface from repeating the same warning over and over while the same bad skill file remains broken.

**Data flow**: It receives a list of current skill errors. It turns each error into a key made from the file path and message, compares those keys with the previous set, stores the new current set, and returns cloned error records only for warnings that were not already active.

**Call relations**: This is the filter that should run before warnings are emitted. The warning display function can then be given just the new errors, so the user sees fresh problems without being spammed by unchanged ones.

*Call graph*: 3 external calls (new, new, take).


##### `emit_skill_load_warnings`  (lines 47–66)

```
fn emit_skill_load_warnings(app_event_tx: &AppEventSender, errors: &[SkillErrorInfo])
```

**Purpose**: This sends visible warning messages when one or more skill files could not be loaded. A skill here is a user-provided capability described by a SKILL.md file, so a bad file means that capability is skipped.

**Data flow**: It receives an event sender and a list of skill errors. If the list is empty, it does nothing. Otherwise, it sends one summary warning with the count, then sends one warning per error with the file path and error message.

**Call relations**: The test helper tests::render_skill_load_warning_cells calls it to capture what would appear in the interface. In the app flow, it hands warning cells to the event system so the terminal history can display them.

*Call graph*: calls 1 internal fn (send); called by 1 (render_skill_load_warning_cells); 6 external calls (new, is_empty, len, InsertHistoryCell, new_warning_event, format!).


##### `emit_project_config_warnings`  (lines 68–105)

```
fn emit_project_config_warnings(app_event_tx: &AppEventSender, config: &Config)
```

**Purpose**: This tells the user when project-local configuration has been disabled because a project is not yet trusted. That matters because local config, hooks, and execution policies can affect what the app is allowed to do.

**Data flow**: It reads the configuration layer stack, looks for project folders that have a disabled reason, builds a numbered message listing each folder and reason, and sends that message as a warning cell. If no project folders are disabled, it sends nothing.

**Call relations**: This function is part of startup warning preparation. It takes low-level configuration layer information and hands a readable warning to the app event stream for display.

*Call graph*: calls 1 internal fn (send); 6 external calls (new, new, InsertHistoryCell, concat!, format!, new_warning_event).


##### `emit_system_bwrap_warning`  (lines 107–117)

```
fn emit_system_bwrap_warning(app_event_tx: &AppEventSender, config: &Config)
```

**Purpose**: This warns the user if the system sandbox setup may have a problem. The sandbox is a safety boundary that limits what commands can touch on the machine.

**Data flow**: It reads the current permission profile from the config and asks the sandboxing code whether there is a bubblewrap warning. Bubblewrap is a Linux sandboxing tool. If a warning message is returned, it sends it as a warning cell; otherwise it does nothing.

**Call relations**: This function sits between the sandboxing subsystem and the terminal UI. It does not decide the warning itself; it asks codex_sandboxing::system_bwrap_warning and passes any result into the app’s event stream.

*Call graph*: calls 1 internal fn (send); 4 external calls (new, InsertHistoryCell, system_bwrap_warning, new_warning_event).


##### `should_show_model_migration_prompt`  (lines 119–157)

```
fn should_show_model_migration_prompt(
    current_model: &str,
    target_model: &str,
    seen_migrations: &BTreeMap<String, String>,
    available_models: &[ModelPreset],
) -> bool
```

**Purpose**: This decides whether the app should ask the user to move from one model to another. It avoids showing pointless or repeated upgrade prompts.

**Data flow**: It receives the current model, the proposed target model, a record of migrations already acknowledged, and the list of available model presets. It returns false if the target is the same as the current model, if this migration was already seen, or if the target is not visible in the model picker. It returns true only when the catalog shows a real upgrade relationship involving these models.

**Call relations**: handle_model_migration_prompt_if_needed calls this before showing a prompt. This function acts like a gatekeeper, so the later prompt code only runs when there is a meaningful and available migration to offer.

*Call graph*: called by 1 (handle_model_migration_prompt_if_needed); 1 external calls (iter).


##### `migration_prompt_hidden`  (lines 159–170)

```
fn migration_prompt_hidden(config: &Config, migration_config_key: &str) -> bool
```

**Purpose**: This checks whether a specific migration prompt has been turned off in the user’s configuration. It lets product-specific prompt switches live in config instead of being hard-coded into the prompt flow.

**Data flow**: It receives the full config and a migration config key. For known keys, it reads the matching boolean setting and treats a missing value as false. For unknown keys, it returns false.

**Call relations**: handle_model_migration_prompt_if_needed calls this before doing the rest of the migration work. If it returns true, the prompt path stops immediately.

*Call graph*: called by 1 (handle_model_migration_prompt_if_needed).


##### `target_preset_for_upgrade`  (lines 172–179)

```
fn target_preset_for_upgrade(
    available_models: &'a [ModelPreset],
    target_model: &str,
) -> Option<&'a ModelPreset>
```

**Purpose**: This finds the model preset for the proposed upgrade target, but only if that model is meant to be shown to users. A preset is the catalog entry that contains display name, description, and defaults for a model.

**Data flow**: It receives the available model list and a target model identifier. It searches for a preset with that exact model identifier and with show_in_picker enabled, then returns that preset if found.

**Call relations**: handle_model_migration_prompt_if_needed uses this after deciding a prompt may be shown. The returned preset supplies user-facing text and the default reasoning effort to apply if the user accepts.

*Call graph*: called by 1 (handle_model_migration_prompt_if_needed); 1 external calls (iter).


##### `apply_accepted_model_migration`  (lines 181–203)

```
fn apply_accepted_model_migration(
    config: &mut Config,
    app_event_tx: &AppEventSender,
    from_model: String,
    target_model: String,
    target_default_effort: ReasoningEffortConfig,
)
```

**Purpose**: This applies a model upgrade after the user accepts the migration prompt. It updates both the live configuration and the saved user preference.

**Data flow**: It receives mutable config, an event sender, the old model, the target model, and the target model’s default reasoning effort. It records that the prompt was acknowledged, changes config.model and config.model_reasoning_effort, sends events to update the running app, and sends an event to persist the new model selection.

**Call relations**: handle_model_migration_prompt_if_needed calls this only after the prompt outcome is Accepted. It then hands off to the app event system so both the visible app state and persistent settings are updated.

*Call graph*: calls 1 internal fn (send); called by 1 (handle_model_migration_prompt_if_needed); 3 external calls (clone, UpdateModel, UpdateReasoningEffort).


##### `select_model_availability_nux`  (lines 213–229)

```
fn select_model_availability_nux(
    available_models: &[ModelPreset],
    nux_config: &ModelAvailabilityNuxConfig,
) -> Option<StartupTooltipOverride>
```

**Purpose**: This chooses a startup tooltip about model availability, if one should still be shown. NUX means “new user experience,” a short guided message shown only a limited number of times.

**Data flow**: It receives the model catalog and the stored counts of how often each model’s availability message has been shown. It scans for the first model with an availability message whose count is below the maximum, and returns the model slug plus message. If none qualify, it returns nothing.

**Call relations**: prepare_startup_tooltip_override calls this to decide whether there is a tooltip worth showing. This function only chooses the candidate; the caller increments and saves the display count.

*Call graph*: called by 1 (prepare_startup_tooltip_override); 1 external calls (iter).


##### `prepare_startup_tooltip_override`  (lines 231–268)

```
async fn prepare_startup_tooltip_override(
    config: &mut Config,
    available_models: &[ModelPreset],
    is_first_run: bool,
) -> Option<String>
```

**Purpose**: This prepares a one-time startup tooltip message about model availability and records that it was shown. It keeps these messages helpful instead of endlessly repeated.

**Data flow**: It receives mutable config, available models, and whether this is the first run. It returns nothing if this is the first run or tooltips are disabled. Otherwise it asks select_model_availability_nux for a message, increments that model’s shown count, tries to save the new count to config storage, updates the in-memory config if saving succeeds, and returns the tooltip text.

**Call relations**: This function builds on select_model_availability_nux. It also uses ConfigEditsBuilder to persist the new count, and logs an error if saving fails while still allowing the tooltip message to be returned.

*Call graph*: calls 1 internal fn (select_model_availability_nux); 2 external calls (for_config, error!).


##### `handle_model_migration_prompt_if_needed`  (lines 270–355)

```
async fn handle_model_migration_prompt_if_needed(
    tui: &mut tui::Tui,
    config: &mut Config,
    model: &str,
    app_event_tx: &AppEventSender,
    available_models: &[ModelPreset],
) -> Option
```

**Purpose**: This is the main startup flow for offering a model upgrade to the user. It decides whether a prompt is needed, shows it, and reacts to accept, reject, or exit.

**Data flow**: It receives the terminal UI object, mutable config, the current model name, an event sender, and available model presets. It looks up whether the current model has an upgrade, checks whether the prompt is hidden or already seen, finds the target preset, builds the prompt text, then waits for the user’s choice. Accepting updates the model and saves the choice; rejecting only records that the prompt was acknowledged; exiting returns app exit information.

**Call relations**: This function coordinates the smaller helpers in this file: migration_prompt_hidden, should_show_model_migration_prompt, target_preset_for_upgrade, and apply_accepted_model_migration. It is the bridge between catalog/config facts, the prompt UI, and the app’s event system.

*Call graph*: calls 5 internal fn (apply_accepted_model_migration, migration_prompt_hidden, should_show_model_migration_prompt, target_preset_for_upgrade, send); 2 external calls (iter, default).


##### `normalize_harness_overrides_for_cwd`  (lines 356–371)

```
fn normalize_harness_overrides_for_cwd(
    mut overrides: ConfigOverrides,
    base_cwd: &AbsolutePathBuf,
) -> Result<ConfigOverrides>
```

**Purpose**: This turns relative extra writable folder paths into paths based on a chosen working directory. That helps a test or harness configuration mean the same thing no matter where the process was launched from.

**Data flow**: It receives configuration overrides and a base current working directory. If there are no additional writable roots, it returns the overrides unchanged. Otherwise, it joins each root to the base directory, replaces the list with those normalized paths, and returns the updated overrides.

**Call relations**: The test tests::normalize_harness_overrides_resolves_relative_add_dirs calls this to verify the behavior. In startup setup, it can prepare override paths before sandbox or permission logic relies on them.

*Call graph*: calls 1 internal fn (join); called by 1 (normalize_harness_overrides_resolves_relative_add_dirs); 1 external calls (with_capacity).


##### `tests::normalize_harness_overrides_resolves_relative_add_dirs`  (lines 384–400)

```
fn normalize_harness_overrides_resolves_relative_add_dirs() -> Result<()>
```

**Purpose**: This test proves that a relative writable root is resolved under the provided base directory. It protects against accidentally treating such paths as relative to some other process location.

**Data flow**: It creates a temporary directory, creates a base folder inside it, builds overrides containing the relative path rel, runs normalize_harness_overrides_for_cwd, and checks that the result is base/rel.

**Call relations**: This test directly exercises normalize_harness_overrides_for_cwd. If that helper changes and stops normalizing paths correctly, this test should fail.

*Call graph*: calls 1 internal fn (normalize_harness_overrides_for_cwd); 5 external calls (default, assert_eq!, create_dir_all, tempdir, vec!).


##### `tests::skill_error`  (lines 402–407)

```
fn skill_error(path: &str, message: &str) -> SkillErrorInfo
```

**Purpose**: This small test helper creates a SkillErrorInfo value from simple string inputs. It keeps the skill-warning tests short and readable.

**Data flow**: It receives a path string and a message string. It converts the path into a PathBuf, copies the message into an owned string, and returns a SkillErrorInfo record.

**Call relations**: Several tests call this helper before exercising SkillLoadWarningState. It supplies consistent fake errors without repeating struct-building code.

*Call graph*: 1 external calls (from).


##### `tests::render_line_text`  (lines 409–414)

```
fn render_line_text(line: &Line<'static>) -> String
```

**Purpose**: This test helper turns a rendered terminal line into plain text. It strips away styling so tests can compare the words the user would see.

**Data flow**: It receives a ratatui Line, reads each span of text inside it, concatenates the span contents, and returns one plain string.

**Call relations**: tests::render_skill_load_warning_cells uses this after warning cells are rendered. It lets the snapshot test compare human-readable warning output.


##### `tests::render_skill_load_warning_cells`  (lines 416–431)

```
fn render_skill_load_warning_cells(errors: &[SkillErrorInfo]) -> String
```

**Purpose**: This test helper runs the skill warning emitter and captures the rendered warning text. It simulates the app event path without needing the full terminal app.

**Data flow**: It receives a list of skill errors, creates an in-memory event channel, wraps the sender in AppEventSender, calls emit_skill_load_warnings, then drains inserted history cells from the receiver. It renders their display lines and joins them into a single string.

**Call relations**: This helper calls emit_skill_load_warnings and is used by the repeated warning snapshot test. It connects the event-producing code to the rendered text that a user would actually see.

*Call graph*: calls 2 internal fn (emit_skill_load_warnings, new); 2 external calls (new, unbounded_channel).


##### `tests::skill_load_warning_state_suppresses_repeated_active_errors`  (lines 434–446)

```
fn skill_load_warning_state_suppresses_repeated_active_errors()
```

**Purpose**: This test checks that the same active skill error is reported once, not repeatedly. It confirms the anti-spam behavior of the warning state.

**Data flow**: It creates a fresh SkillLoadWarningState and one fake error. The first call returns that error as new; the second call with the same error returns an empty list.

**Call relations**: This test exercises SkillLoadWarningState::newly_active_errors through its public behavior. It supports the startup warning flow by proving repeated active errors are filtered out.

*Call graph*: 3 external calls (assert_eq!, default, skill_error).


##### `tests::skill_load_warning_state_reemits_after_error_clears`  (lines 449–462)

```
fn skill_load_warning_state_reemits_after_error_clears()
```

**Purpose**: This test checks that an error can be shown again if it disappears and later returns. That is important because a returning error may represent a fresh problem the user should notice.

**Data flow**: It creates a warning state and a fake error. It reports the error once, then calls with an empty list to mark it cleared, then calls with the same error again and expects it to be returned as new.

**Call relations**: This test focuses on SkillLoadWarningState::newly_active_errors. It proves the state tracks currently active errors, not every error ever seen forever.

*Call graph*: 3 external calls (assert_eq!, default, skill_error).


##### `tests::skill_load_warning_state_displays_new_message_for_active_path`  (lines 465–478)

```
fn skill_load_warning_state_displays_new_message_for_active_path()
```

**Purpose**: This test checks that a changed error message for the same file is treated as a new warning. A different message may tell the user about a different problem in the same skill file.

**Data flow**: It creates two fake errors with the same path but different messages. After reporting the first, it reports the second and expects the second to be returned as newly active.

**Call relations**: This test verifies the key used by SkillLoadWarningState::newly_active_errors includes both path and message. That supports accurate warning updates when the reason changes.

*Call graph*: 3 external calls (assert_eq!, default, skill_error).


##### `tests::skill_load_warning_state_clear_allows_active_error_again`  (lines 481–500)

```
fn skill_load_warning_state_clear_allows_active_error_again()
```

**Purpose**: This test confirms that clearing the warning state makes an already-active error eligible to be shown again. It validates the reset behavior.

**Data flow**: It creates a warning state and one fake error. The first call returns the error, the second suppresses it, then clear is called, and the next call returns the error again.

**Call relations**: This test uses SkillLoadWarningState::clear together with SkillLoadWarningState::newly_active_errors. It proves the manual reset path works.

*Call graph*: 3 external calls (assert_eq!, default, skill_error).


##### `tests::repeated_active_skill_load_warning_renders_once`  (lines 503–522)

```
fn repeated_active_skill_load_warning_renders_once()
```

**Purpose**: This snapshot test checks the final text shown for a repeated active skill warning. It makes sure the user sees the warning once, with the expected summary and file-specific message.

**Data flow**: It creates a warning state and one fake skill error. It asks for newly active errors twice, renders warnings for both results, drops empty output, joins what remains, and compares it to a saved expected snapshot.

**Call relations**: This test combines SkillLoadWarningState::newly_active_errors with tests::render_skill_load_warning_cells, which calls emit_skill_load_warnings. It verifies the full mini-flow from deduplication to displayed warning text.

*Call graph*: 5 external calls (assert_snapshot!, from_ref, default, render_skill_load_warning_cells, skill_error).


### `tui/src/tooltips.rs`

`domain_logic` · `startup`

Codex shows a small tooltip at startup. This file is the message picker. Without it, users would either see no guidance or see the wrong kind of message, such as a Mac-only app prompt on Linux or a paid-plan promotion that does not fit their account.

The file combines three sources of messages. First, it reads a built-in text file of general tips and removes blank lines, comments, and app-related tips on unsupported operating systems. Second, it adds experimental feature announcements from the feature list. Third, it can use a remote announcement file from GitHub, written in TOML, a simple configuration format.

The main entry point is `get_tooltip`. It first asks whether a remote announcement has already been fetched and whether it matches the user's plan, operating system, CLI version, and date. If so, that announcement wins. Otherwise it usually shows a plan-specific promotional message, with different behavior for paid users, free or Go users, and unknown plans. A small percentage of the time it falls back to a random general tip.

The announcement submodule is careful not to slow startup. It warms the announcement cache in a background thread and returns nothing if the download is not ready yet. This is like putting a flyer on the counter only if someone already brought it in; the checkout line does not wait for it.

#### Function details

##### `experimental_tooltips`  (lines 44–49)

```
fn experimental_tooltips() -> Vec<&'static str>
```

**Purpose**: Collects announcement text for features that are marked as experimental. This lets newly introduced features add startup messages without putting every message directly in this file.

**Data flow**: It reads the global feature list, looks at each feature's stage, keeps only the stages that provide an experimental announcement, and returns those messages as a list of text snippets.

**Call relations**: It feeds the `ALL_TOOLTIPS` startup list. When that list is built, the normal tooltip text is combined with these feature-driven tips so `pick_tooltip` can choose from both.


##### `get_tooltip`  (lines 52–88)

```
fn get_tooltip(plan: Option<PlanType>, fast_mode_enabled: bool) -> Option<String>
```

**Purpose**: Chooses the single tooltip, promotion, or announcement to show when Codex starts. It uses the user's plan and whether fast mode is already enabled to avoid showing irrelevant messages.

**Data flow**: It receives an optional account plan and a true-or-false flag for fast mode. It first checks for a cached remote announcement. If one matches, it returns that. If not, it uses random chance and plan rules to choose a paid-plan promo, a free/Go promo, a generic app promo, or finally a random built-in tooltip. The result is either a message string or no message.

**Call relations**: This is the top-level picker used by the startup UI. It asks `announcement::fetch_announcement_tip` for high-priority remote announcements, calls `pick_paid_tooltip` for paid-plan promotion choices, and calls `pick_tooltip` when it falls back to the general random pool.

*Call graph*: calls 2 internal fn (pick_paid_tooltip, pick_tooltip); 3 external calls (fetch_announcement_tip, matches!, rng).


##### `paid_app_tooltip`  (lines 90–96)

```
fn paid_app_tooltip() -> Option<&'static str>
```

**Purpose**: Returns the Codex App promotion only on operating systems where that app promotion should be shown. This prevents users on unsupported platforms from seeing a misleading app prompt.

**Data flow**: It checks compile-time operating system flags. On macOS or Windows it returns the app promotion text; otherwise it returns nothing.

**Call relations**: It is a small helper for `pick_paid_tooltip`. The paid-tooltip tests also call it to build the expected result for the current operating system.

*Call graph*: called by 3 (pick_paid_tooltip, paid_tooltip_pool_rotates_between_promos, paid_tooltip_pool_skips_fast_when_fast_mode_is_enabled).


##### `pick_paid_tooltip`  (lines 102–111)

```
fn pick_paid_tooltip(
    rng: &mut R,
    fast_mode_enabled: bool,
) -> Option<&'static str>
```

**Purpose**: Chooses the special promotional tooltip for paid users. It splits attention between the Codex App and fast mode, but stops advertising fast mode once the user already has it enabled.

**Data flow**: It receives a random number generator and a fast-mode flag. If fast mode is already on, it tries to return the app promo. If fast mode is off, it flips a random yes/no choice: one side picks the app promo, the other side picks the fast-mode promo. The output is a message or nothing if the app promo is not suitable for this operating system.

**Call relations**: `get_tooltip` calls this when the user is on a paid or team-like plan. The tests call it repeatedly with seeded random generators to prove it can rotate between promos and that it suppresses the fast-mode promo when needed.

*Call graph*: calls 1 internal fn (paid_app_tooltip); called by 3 (get_tooltip, paid_tooltip_pool_rotates_between_promos, paid_tooltip_pool_skips_fast_when_fast_mode_is_enabled); 1 external calls (random_bool).


##### `pick_tooltip`  (lines 113–121)

```
fn pick_tooltip(rng: &mut R) -> Option<&'static str>
```

**Purpose**: Selects one random message from the full built-in tooltip pool. This is the general fallback when no targeted announcement or promotion is chosen.

**Data flow**: It receives a random number generator. If there are no available tips, it returns nothing. Otherwise it chooses a random index in the tooltip list and returns the message at that position.

**Call relations**: `get_tooltip` calls this for the small chance of showing a general tip. A reproducibility test also calls it with a seeded random generator to confirm the same seed gives the same result.

*Call graph*: called by 2 (get_tooltip, random_tooltip_is_reproducible_with_seed); 1 external calls (random_range).


##### `announcement::prewarm`  (lines 139–141)

```
fn prewarm()
```

**Purpose**: Starts loading the remote announcement in the background before it is needed. This keeps startup responsive because the main program does not wait on the network.

**Data flow**: It takes no input. It starts a background thread that initializes the shared announcement cache. It does not return the announcement directly; it only begins the work.

**Call relations**: Startup code can call this early. Later, `announcement::fetch_announcement_tip` checks whether the background work has completed and uses the cached text if it is available.

*Call graph*: 1 external calls (spawn).


##### `announcement::fetch_announcement_tip`  (lines 144–150)

```
fn fetch_announcement_tip(plan: Option<PlanType>) -> Option<String>
```

**Purpose**: Returns a remote announcement if one has already been downloaded and matches the current user. It deliberately does not wait if the background download is still running.

**Data flow**: It receives the user's optional plan. It reads the one-time announcement cache. If the cache contains downloaded TOML text, it parses and filters that text for the plan and returns the chosen announcement content. If the cache is empty, unfinished, invalid, or has no match, it returns nothing.

**Call relations**: `get_tooltip` calls this first because remote announcements have priority over ordinary tips. It hands the raw downloaded text to `announcement::parse_announcement_tip_toml` so the detailed matching rules are applied in one place.


##### `announcement::TargetOs::current`  (lines 190–199)

```
fn current() -> Self
```

**Purpose**: Identifies which operating system this build of Codex is running on. Announcement filtering uses this so OS-specific messages only appear where they make sense.

**Data flow**: It reads compile-time operating system flags. It returns `Macos` for macOS builds, `Windows` for Windows builds, and `Linux` otherwise.

**Call relations**: The announcement module stores this as its current operating system value. `announcement::parse_announcement_tip_toml` compares announcement target operating systems against it when deciding whether a remote message applies.

*Call graph*: 1 external calls (cfg!).


##### `announcement::init_announcement_tip_in_thread`  (lines 202–207)

```
fn init_announcement_tip_in_thread() -> Option<String>
```

**Purpose**: Runs the blocking announcement download in a separate thread and converts its result into the cache value. This wrapper keeps the one-time cache initialization isolated from the network call.

**Data flow**: It takes no input. It starts a thread that performs the actual download, waits for that thread to finish, and returns the downloaded text if the thread succeeded and the download produced text.

**Call relations**: `announcement::prewarm` uses this as the initializer for the announcement cache. It delegates the actual HTTP work to `announcement::blocking_init_announcement_tip`.

*Call graph*: 1 external calls (spawn).


##### `announcement::blocking_init_announcement_tip`  (lines 209–221)

```
fn blocking_init_announcement_tip() -> Option<String>
```

**Purpose**: Downloads the remote announcement file from GitHub. It is intentionally short-timeout and fail-soft, so a network problem does not break Codex startup.

**Data flow**: It creates a blocking HTTP client with proxy detection disabled, requests the announcement URL with a two-second timeout, checks that the response status is successful, and returns the response body as text. Any setup, network, HTTP, or text-reading failure becomes no result.

**Call relations**: `announcement::init_announcement_tip_in_thread` calls this inside a worker thread. The downloaded text later flows through the shared cache into `announcement::fetch_announcement_tip` and then into the main `get_tooltip` decision.

*Call graph*: 2 external calls (from_millis, builder).


##### `announcement::parse_announcement_tip_toml`  (lines 223–256)

```
fn parse_announcement_tip_toml(
        text: &str,
        plan: Option<PlanType>,
    ) -> Option<String>
```

**Purpose**: Reads a remote announcement document and picks the last announcement that applies right now. It filters by date, CLI version, target app, user plan, and operating system.

**Data flow**: It receives TOML text and an optional plan. It parses the text either as a document with an `announcements` list or as a plain list. For each raw announcement, it builds a validated `AnnouncementTip`, checks whether it matches today's date, the current CLI version, the CLI app, the plan, and the current operating system, and remembers the latest matching message. It returns that message or nothing.

**Call relations**: `announcement::fetch_announcement_tip` calls this after retrieving cached remote text. It relies on `announcement::AnnouncementTip::from_raw` to validate each entry, then uses `version_matches` and `date_matches` to apply the remaining rules. Many tests exercise this function because it is the heart of remote announcement selection.

*Call graph*: 2 external calls (now, from_raw).


##### `announcement::AnnouncementTip::from_raw`  (lines 259–301)

```
fn from_raw(raw: AnnouncementTipRaw) -> Option<Self>
```

**Purpose**: Turns a loosely parsed announcement entry into a validated announcement that the program can safely compare. Bad dates, bad version patterns, empty content, and unknown target names are rejected.

**Data flow**: It receives a raw announcement with strings and optional fields. It trims the content, parses date strings into date values, compiles the version pattern into a regular expression, normalizes the target app name, and rejects entries with unknown plan or operating system targets. It returns a cleaned `AnnouncementTip` or nothing if validation fails.

**Call relations**: `announcement::parse_announcement_tip_toml` calls this for every announcement entry before applying match rules. Its output is then checked by `version_matches` and `date_matches`.

*Call graph*: 2 external calls (parse_from_str, new).


##### `announcement::AnnouncementTip::version_matches`  (lines 303–307)

```
fn version_matches(&self, version: &str) -> bool
```

**Purpose**: Checks whether an announcement applies to a particular Codex CLI version. If no version rule was supplied, the announcement applies to all versions.

**Data flow**: It receives a version string. If the announcement has a regular expression, it tests the version string against that pattern. If there is no pattern, it returns true.

**Call relations**: `announcement::parse_announcement_tip_toml` uses this while scanning remote announcements. It is one of the filters that decides whether a message is eligible to be shown.


##### `announcement::AnnouncementTip::date_matches`  (lines 309–321)

```
fn date_matches(&self, today: NaiveDate) -> bool
```

**Purpose**: Checks whether an announcement is active on a given date. This lets remote messages have a start date and an end date.

**Data flow**: It receives today's date. If the announcement has a start date and today is before it, it returns false. If it has an end date and today is on or after that end date, it returns false. Otherwise it returns true.

**Call relations**: `announcement::parse_announcement_tip_toml` calls this after converting raw entries into validated announcements. Together with version, plan, app, and operating system checks, it decides whether an announcement can be shown.


##### `tests::random_tooltip_returns_some_tip_when_available`  (lines 333–336)

```
fn random_tooltip_returns_some_tip_when_available()
```

**Purpose**: Confirms that the random tooltip picker can return a message when the tooltip pool is populated. This protects against accidentally emptying the built-in tip list.

**Data flow**: It creates a predictable random number generator from a fixed seed, calls the random tooltip picker, and checks that the result is present.

**Call relations**: This test exercises `pick_tooltip` indirectly through the module's internal test access. It supports the fallback path used by `get_tooltip`.

*Call graph*: 2 external calls (seed_from_u64, assert!).


##### `tests::random_tooltip_is_reproducible_with_seed`  (lines 339–347)

```
fn random_tooltip_is_reproducible_with_seed()
```

**Purpose**: Confirms that using the same random seed produces the same tooltip choice. This makes the random behavior testable and repeatable.

**Data flow**: It creates one seeded random generator and records the tooltip selected from it. Then it creates another generator with the same seed, picks again, and checks that both results are equal.

**Call relations**: This test calls `pick_tooltip` directly. It verifies the general random-tip path that `get_tooltip` uses as a fallback.

*Call graph*: calls 1 internal fn (pick_tooltip); 2 external calls (seed_from_u64, assert_eq!).


##### `tests::paid_tooltip_pool_rotates_between_promos`  (lines 350–361)

```
fn paid_tooltip_pool_rotates_between_promos()
```

**Purpose**: Checks that paid users can see both paid promotional options when fast mode is not already enabled. This guards the intended split between app promotion and fast-mode promotion.

**Data flow**: It tries many seeded random generators, calls `pick_paid_tooltip` with fast mode off, stores every result it sees, and compares that set with the expected app-promo and fast-promo choices for the current operating system.

**Call relations**: This test calls both `pick_paid_tooltip` and `paid_app_tooltip`. It protects the paid-user branch used by `get_tooltip`.

*Call graph*: calls 2 internal fn (paid_app_tooltip, pick_paid_tooltip); 4 external calls (seed_from_u64, assert_eq!, from, new).


##### `tests::paid_tooltip_pool_skips_fast_when_fast_mode_is_enabled`  (lines 364–374)

```
fn paid_tooltip_pool_skips_fast_when_fast_mode_is_enabled()
```

**Purpose**: Checks that users who already enabled fast mode are not shown the fast-mode advertisement. This prevents a stale or annoying promotion.

**Data flow**: It tries several seeded random generators, calls `pick_paid_tooltip` with fast mode on, gathers the results, and checks that only the app-promo option appears and the fast-mode message does not.

**Call relations**: This test calls `pick_paid_tooltip` and `paid_app_tooltip`. It verifies the fast-mode suppression rule inside the paid-user path of `get_tooltip`.

*Call graph*: calls 2 internal fn (paid_app_tooltip, pick_paid_tooltip); 5 external calls (seed_from_u64, assert!, assert_eq!, from, new).


##### `tests::announcement_tip_toml_picks_last_matching`  (lines 377–417)

```
fn announcement_tip_toml_picks_last_matching()
```

**Purpose**: Confirms that when several remote announcements match, the last matching one wins. This lets the remote file override earlier general messages with later, more specific ones.

**Data flow**: It builds sample TOML with multiple announcements, including earlier matches and non-matches, parses it, and checks that the returned message is the later matching entry.

**Call relations**: This test focuses on `announcement::parse_announcement_tip_toml`, the selector used by `announcement::fetch_announcement_tip` before `get_tooltip` shows a remote announcement.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_picks_no_match`  (lines 420–437)

```
fn announcement_tip_toml_picks_no_match()
```

**Purpose**: Confirms that no remote announcement is returned when every entry is expired, version-mismatched, or meant for another app. This prevents irrelevant remote messages from appearing.

**Data flow**: It builds sample TOML where each announcement fails a different rule, parses it with no plan, and checks that the result is empty.

**Call relations**: This test exercises the filtering rules inside `announcement::parse_announcement_tip_toml`, especially date, version, and target-app checks.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_bad_deserialization`  (lines 440–448)

```
fn announcement_tip_toml_bad_deserialization()
```

**Purpose**: Confirms that malformed announcement TOML is ignored safely. A bad remote file should not crash Codex or show nonsense.

**Data flow**: It supplies TOML where the content field has the wrong type, asks the parser to read it, and checks that no announcement is returned.

**Call relations**: This test protects the error-handling path in `announcement::parse_announcement_tip_toml`, which is reached through `announcement::fetch_announcement_tip` when remote text is available.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_parse_comments`  (lines 451–476)

```
fn announcement_tip_toml_parse_comments()
```

**Purpose**: Confirms that a realistic announcement file with comments can be parsed and that a valid later announcement is selected. This matches how maintainers are expected to write the remote file.

**Data flow**: It provides a commented TOML example with one version-limited announcement and one simple announcement, parses it, and checks that the simple valid message is returned.

**Call relations**: This test exercises `announcement::parse_announcement_tip_toml` using a document shape close to the production remote announcement file.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_matches_target_plan_type`  (lines 479–509)

```
fn announcement_tip_toml_matches_target_plan_type()
```

**Purpose**: Checks that plan-specific announcements are shown only to users on matching plans, while general announcements remain available to everyone. This keeps messaging relevant to account type.

**Data flow**: It builds TOML with a general announcement plus pro/enterprise and free-specific announcements. It parses the same text with different plan inputs and checks that each plan receives the expected message.

**Call relations**: This test verifies the plan filtering inside `announcement::parse_announcement_tip_toml`, which is fed by `announcement::fetch_announcement_tip` using the plan passed into `get_tooltip`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_rejects_unknown_target_plan_type`  (lines 512–526)

```
fn announcement_tip_toml_rejects_unknown_target_plan_type()
```

**Purpose**: Confirms that an announcement with an unrecognized plan target is ignored. This protects users from messages caused by typos in the remote file.

**Data flow**: It provides TOML with a valid general announcement and another announcement using a misspelled plan name. It parses the text and checks that only the general announcement is selected.

**Call relations**: This test covers validation performed by `announcement::AnnouncementTip::from_raw` as part of the parsing flow in `announcement::parse_announcement_tip_toml`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_matches_target_os`  (lines 529–555)

```
fn announcement_tip_toml_matches_target_os()
```

**Purpose**: Checks that operating-system-specific announcements match the platform running the test. This prevents, for example, a Windows-only message from appearing on macOS or Linux.

**Data flow**: It builds TOML with separate Linux, macOS, and Windows announcements, computes which one should match the current build, parses the TOML, and checks that the expected message is returned.

**Call relations**: This test exercises the operating system filtering in `announcement::parse_announcement_tip_toml`, which depends on `announcement::TargetOs::current` through the module's current OS constant.

*Call graph*: 2 external calls (assert_eq!, cfg!).


##### `tests::announcement_tip_toml_rejects_unknown_target_os`  (lines 558–572)

```
fn announcement_tip_toml_rejects_unknown_target_os()
```

**Purpose**: Confirms that an announcement with an unrecognized operating system target is ignored. This keeps remote-file typos from producing accidental matches.

**Data flow**: It provides TOML with a valid all-platform announcement and another announcement using an invalid operating system name. It parses the text and checks that the valid all-platform message is returned.

**Call relations**: This test covers the operating-system validation in `announcement::AnnouncementTip::from_raw`, which is used during `announcement::parse_announcement_tip_toml`.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/update_prompt.rs`

`orchestration` · `startup update check`

This file is the app’s “new version available” notice for the terminal interface. Without it, the app could still run, but users would not get a clear in-app chance to upgrade or silence a repeated reminder.

The main flow starts by asking the update system whether there is a newer version worth showing. If not, it immediately lets the app continue. If an update is available and the app knows how to run the update command, it builds an `UpdatePromptScreen`, draws it, and then waits for keyboard events.

The screen is like a tiny menu card. It shows the current version, the latest version, a release-notes link, and three choices: update now, skip, or skip until the next version. Arrow keys, `j`/`k`, number keys, Enter, Escape, and Ctrl-C/Ctrl-D all behave in expected terminal-friendly ways.

If the user chooses to update, the terminal is cleared and the caller is told to run the update action. If the user skips, normal startup continues. If the user chooses “skip until next version,” this file asks the update system to remember that dismissal, but it does not crash the app if saving that preference fails.

#### Function details

##### `run_update_prompt_if_needed`  (lines 37–86)

```
async fn run_update_prompt_if_needed(
    tui: &mut Tui,
    config: &Config,
) -> Result<UpdatePromptOutcome>
```

**Purpose**: This is the top-level routine for deciding whether the update prompt should appear. It checks whether an update is available, displays the prompt if needed, waits for the user’s choice, and returns what the rest of the app should do next.

**Data flow**: It receives the terminal interface and the user configuration. It asks the update system for a newer version and asks the update-action code what command could perform the upgrade. If either answer is missing, it returns “continue.” Otherwise it draws the prompt, reads terminal events, updates the screen as keys arrive, and finally returns either “run this update action” or “continue.” If the user chose not to be reminded about this version, it also tries to save that dismissal in the configuration-related update state.

**Call relations**: The main terminal app calls this during startup through `run_ratatui_app`. This function pulls together `updates::get_upgrade_version_for_popup`, `crate::update_action::get_update_action`, `UpdatePromptScreen::new`, terminal drawing, and the TUI event stream. It hands keyboard events to `UpdatePromptScreen::handle_key` and uses the finished screen state to decide what outcome to return.

*Call graph*: calls 3 internal fn (get_update_action, new, get_upgrade_version_for_popup); called by 1 (run_ratatui_app); 7 external calls (draw, event_stream, frame_requester, pin!, error!, RunUpdate, dismiss_version).


##### `UpdatePromptScreen::new`  (lines 105–118)

```
fn new(
        request_frame: FrameRequester,
        latest_version: String,
        update_action: UpdateAction,
    ) -> Self
```

**Purpose**: This builds the in-memory state for the update prompt before it is drawn. It records what version is available, what update command would be used, and which menu option starts highlighted.

**Data flow**: It takes a frame requester, the latest version string, and an update action. It also reads the current app version from the build-time package version. It returns a fresh prompt screen with “Update now” highlighted and no final selection yet.

**Call relations**: `run_update_prompt_if_needed` uses this when the real prompt is needed. The test helper `tests::new_prompt` also uses it to create predictable screens for rendering and keyboard tests.

*Call graph*: called by 2 (run_update_prompt_if_needed, new_prompt); 1 external calls (env!).


##### `UpdatePromptScreen::handle_key`  (lines 120–140)

```
fn handle_key(&mut self, key_event: KeyEvent)
```

**Purpose**: This translates a keyboard press into a prompt action. It lets the user move through the choices, confirm a choice, or cancel the prompt in familiar terminal ways.

**Data flow**: It receives one key event. Key-release events are ignored so one press is not processed twice. Ctrl-C and Ctrl-D choose “skip.” Up or `k` moves the highlight to the previous option, Down or `j` moves to the next option, number keys select a specific row, Enter selects the highlighted row, and Escape skips. The screen’s highlighted item or final selection may change.

**Call relations**: The event loop in `run_update_prompt_if_needed` calls this whenever the TUI reports a key event. It delegates movement to `UpdateSelection::next` and `UpdateSelection::prev`, and delegates screen-state changes to `set_highlight` and `select` so redraw requests happen consistently.

*Call graph*: calls 4 internal fn (select, set_highlight, next, prev); 1 external calls (matches!).


##### `UpdatePromptScreen::set_highlight`  (lines 142–147)

```
fn set_highlight(&mut self, highlight: UpdateSelection)
```

**Purpose**: This changes which menu option is visually highlighted. It also asks the terminal UI to redraw, but only when the highlight actually changes.

**Data flow**: It receives the option that should become highlighted. If that option differs from the current one, it updates the screen state and schedules a new frame so the user can see the new highlight. It returns nothing.

**Call relations**: `UpdatePromptScreen::handle_key` calls this after navigation keys. It uses the `FrameRequester` stored on the screen to request a redraw from the larger TUI system.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key).


##### `UpdatePromptScreen::select`  (lines 149–153)

```
fn select(&mut self, selection: UpdateSelection)
```

**Purpose**: This records the user’s final choice. Once this is called, the prompt is considered finished.

**Data flow**: It receives the chosen update option. It makes that option both the highlighted row and the saved final selection, then schedules a redraw so the chosen state can be reflected before the prompt exits. It returns nothing.

**Call relations**: `UpdatePromptScreen::handle_key` calls this when the user confirms, presses a number shortcut, cancels, or sends Ctrl-C/Ctrl-D. The outer prompt loop later notices the selection through `is_done` and `selection`.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key).


##### `UpdatePromptScreen::is_done`  (lines 155–157)

```
fn is_done(&self) -> bool
```

**Purpose**: This answers whether the user has made a final choice. The event loop uses it to know when to stop waiting for input.

**Data flow**: It reads the screen’s stored selection. If there is a saved selection, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: `run_update_prompt_if_needed` checks this repeatedly while waiting for terminal events. Once it becomes true, that outer function leaves the prompt loop and decides the final outcome.


##### `UpdatePromptScreen::selection`  (lines 159–161)

```
fn selection(&self) -> Option<UpdateSelection>
```

**Purpose**: This returns the final choice the user made, if any. It is used after the prompt ends to decide whether to update, skip, or remember a dismissal.

**Data flow**: It reads the optional selection stored in the screen and returns it. If no choice has been made, the result is empty. It does not change screen state.

**Call relations**: After the event loop finishes, `run_update_prompt_if_needed` calls this to convert the user’s choice into an `UpdatePromptOutcome` for the rest of the application.


##### `UpdatePromptScreen::latest_version`  (lines 163–165)

```
fn latest_version(&self) -> &str
```

**Purpose**: This provides the latest version string stored on the prompt. It is mainly used when saving the user’s “do not remind me about this version” choice.

**Data flow**: It reads the prompt’s latest-version text and returns it as a borrowed string. It does not allocate new data or change anything.

**Call relations**: `run_update_prompt_if_needed` uses this when calling the update system to dismiss the currently offered version.


##### `UpdateSelection::next`  (lines 169–175)

```
fn next(self) -> Self
```

**Purpose**: This gives the next menu option when the user moves downward. It wraps around from the last option back to the first, like a circular menu.

**Data flow**: It receives the current option and returns the option below it. “Update now” becomes “Skip,” “Skip” becomes “Skip until next version,” and the last option becomes “Update now.” It changes no stored state by itself.

**Call relations**: `UpdatePromptScreen::handle_key` calls this for Down and `j` key navigation, then passes the result to `set_highlight`.

*Call graph*: called by 1 (handle_key).


##### `UpdateSelection::prev`  (lines 177–183)

```
fn prev(self) -> Self
```

**Purpose**: This gives the previous menu option when the user moves upward. It wraps around from the first option to the last.

**Data flow**: It receives the current option and returns the option above it. “Update now” wraps to “Skip until next version,” while the other options move one row upward. It changes no stored state by itself.

**Call relations**: `UpdatePromptScreen::handle_key` calls this for Up and `k` key navigation, then passes the result to `set_highlight`.

*Call graph*: called by 1 (handle_key).


##### `UpdatePromptScreen::render_ref`  (lines 187–240)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws the update prompt into the terminal screen buffer. It turns the prompt’s state into visible text, colors, spacing, menu rows, and a release-notes link.

**Data flow**: It receives the available screen area and the terminal buffer to draw into. It clears the area, builds a vertical column of lines, inserts the current and latest versions, shows the update command, marks which menu row is highlighted, adds an Enter-key hint, renders the column, and marks the underlined release-notes URL as a terminal hyperlink. The output is not a return value; it is the changed terminal buffer.

**Call relations**: The TUI drawing code calls this through the `WidgetRef` interface whenever `run_update_prompt_if_needed` draws or redraws the prompt. It uses helpers such as `selection_option_row`, `command_str`, and hyperlink marking to keep the visual style consistent with the rest of the terminal UI.

*Call graph*: calls 5 internal fn (tlbr, new, selection_option_row, mark_underlined_hyperlink, command_str); 3 external calls (from, format!, vec!).


##### `tests::new_prompt`  (lines 253–259)

```
fn new_prompt() -> UpdatePromptScreen
```

**Purpose**: This test helper creates a standard update prompt for the unit tests. It avoids repeating the same setup in every test.

**Data flow**: It creates a dummy frame requester, uses a fake latest version of `9.9.9`, and chooses a known update action. It returns a ready-to-test `UpdatePromptScreen`.

**Call relations**: All the tests in this module call this helper before checking rendering or keyboard behavior. It calls `UpdatePromptScreen::new`, just like the real prompt flow does, but with test-friendly inputs.

*Call graph*: calls 2 internal fn (test_dummy, new).


##### `tests::update_prompt_snapshot`  (lines 262–269)

```
fn update_prompt_snapshot()
```

**Purpose**: This test checks what the update prompt looks like when rendered. A snapshot test compares the terminal output against a saved expected version.

**Data flow**: It builds a prompt, creates a fake 80-by-12 terminal, draws the screen into that terminal, and compares the resulting terminal contents with the stored snapshot. It changes only test-local objects.

**Call relations**: This test uses `tests::new_prompt` to get the screen and then exercises `UpdatePromptScreen::render_ref` indirectly through terminal drawing. It protects the prompt layout from accidental visual changes.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_snapshot!, new, new_prompt).


##### `tests::update_prompt_confirm_selects_update`  (lines 272–277)

```
fn update_prompt_confirm_selects_update()
```

**Purpose**: This test confirms that pressing Enter on the default prompt chooses “Update now.” It proves the default highlighted option is actionable.

**Data flow**: It creates a prompt, sends an Enter key event, and then checks that the prompt is done and that the saved selection is `UpdateNow`.

**Call relations**: The test uses `tests::new_prompt` and drives `UpdatePromptScreen::handle_key`. It verifies the path that the real event loop would use when a user accepts the update immediately.

*Call graph*: 4 external calls (new, assert!, assert_eq!, new_prompt).


##### `tests::update_prompt_dismiss_option_leaves_prompt_in_normal_state`  (lines 280–286)

```
fn update_prompt_dismiss_option_leaves_prompt_in_normal_state()
```

**Purpose**: This test checks that moving down once and pressing Enter chooses the temporary skip option. It confirms that normal dismissal does not accidentally trigger an update.

**Data flow**: It creates a prompt, sends a Down key event to move the highlight to “Skip,” sends Enter, and checks that the prompt is finished with `NotNow` selected.

**Call relations**: The test exercises `UpdatePromptScreen::handle_key`, including its use of menu navigation and selection. It mirrors what happens when the outer prompt loop receives those same key events from a real user.

*Call graph*: 4 external calls (new, assert!, assert_eq!, new_prompt).


##### `tests::update_prompt_dont_remind_selects_dismissal`  (lines 289–296)

```
fn update_prompt_dont_remind_selects_dismissal()
```

**Purpose**: This test checks that the third menu option is reachable and records the “skip until next version” choice. That choice is important because it leads to persisting a dismissal in the real flow.

**Data flow**: It creates a prompt, sends two Down key events to move to the third row, sends Enter, and checks that the prompt is done with `DontRemind` selected.

**Call relations**: The test uses `tests::new_prompt` and `UpdatePromptScreen::handle_key`. It verifies the user path that later causes `run_update_prompt_if_needed` to call the update dismissal code.

*Call graph*: 4 external calls (new, assert!, assert_eq!, new_prompt).


##### `tests::update_prompt_ctrl_c_skips_update`  (lines 299–304)

```
fn update_prompt_ctrl_c_skips_update()
```

**Purpose**: This test ensures Ctrl-C behaves as a safe cancel rather than as an update confirmation. In terminal programs, users often press Ctrl-C to back out, so this behavior matters.

**Data flow**: It creates a prompt, sends a Ctrl-C key event, and checks that the prompt is finished with `NotNow` selected.

**Call relations**: The test drives the same `UpdatePromptScreen::handle_key` shortcut path that the real prompt uses when the TUI event stream reports Ctrl-C.

*Call graph*: 5 external calls (Char, new, assert!, assert_eq!, new_prompt).


##### `tests::update_prompt_navigation_wraps_between_entries`  (lines 307–313)

```
fn update_prompt_navigation_wraps_between_entries()
```

**Purpose**: This test checks that menu navigation wraps around at the top and bottom. That makes the small three-item menu feel predictable and prevents the highlight from getting stuck.

**Data flow**: It creates a prompt with “Update now” highlighted, sends Up and checks that the highlight moved to the last option, then sends Down and checks that it returned to the first option.

**Call relations**: The test exercises `UpdatePromptScreen::handle_key`, which in turn uses `UpdateSelection::prev` and `UpdateSelection::next`. It confirms the circular-menu behavior used during real keyboard navigation.

*Call graph*: 3 external calls (new, assert_eq!, new_prompt).


### `tui/src/cwd_prompt.rs`

`orchestration` · `during resume/fork prompt`

When a user resumes or forks a session, there can be two reasonable places to start: the directory remembered from that session, or the directory where the user is running the command now. This file creates the little decision screen for that moment. Without it, the program would have to guess, which could put the user in the wrong folder.

The prompt works like a simple two-item menu. It displays a short explanation, shows the saved session directory and the current directory, highlights one option, and waits for keyboard input. The session directory is highlighted by default. The user can move the highlight with arrow keys or vim-style keys, choose with Enter, pick directly with number keys, accept the session directory with Escape, or quit with Ctrl-C or Ctrl-D.

The file has three main ideas. `CwdPromptAction` changes the wording depending on whether the user is resuming or forking. `CwdSelection` represents the two possible directory choices. `CwdPromptScreen` keeps the prompt state: what is highlighted, whether a choice has been made, and whether the user asked to exit. The top-level async function runs the screen inside the terminal UI event loop, redrawing when needed and returning the final outcome.

#### Function details

##### `CwdPromptAction::verb`  (lines 33–38)

```
fn verb(self) -> &'static str
```

**Purpose**: Returns the action word to show in the prompt, such as "resume" or "fork". This keeps the same screen reusable for both cases.

**Data flow**: It starts with a `CwdPromptAction` value. It matches that value to the right plain English verb. It returns a short text string used in the prompt title.

**Call relations**: When the prompt is drawn, `render_ref` asks this function for the right verb so the message says what the user is actually doing.

*Call graph*: called by 1 (render_ref).


##### `CwdPromptAction::past_participle`  (lines 40–45)

```
fn past_participle(self) -> &'static str
```

**Purpose**: Returns the past-tense wording for the action, such as "resumed" or "forked". This is used in the explanatory text about the session directory.

**Data flow**: It receives the current action value. It converts that value into a short text phrase. The phrase is returned for display on screen.

**Call relations**: The drawing code in `render_ref` calls this while building the help text, so the explanation matches whether the session is being resumed or forked.

*Call graph*: called by 1 (render_ref).


##### `CwdSelection::next`  (lines 61–66)

```
fn next(self) -> Self
```

**Purpose**: Moves the menu highlight to the other directory choice. Because there are only two choices, moving next just toggles between them.

**Data flow**: It receives the currently highlighted choice. If it is `Current`, it returns `Session`; if it is `Session`, it returns `Current`.

**Call relations**: `CwdPromptScreen::handle_key` calls this when the user presses Down or `j`, so keyboard navigation changes the highlighted row.

*Call graph*: called by 1 (handle_key).


##### `CwdSelection::prev`  (lines 68–73)

```
fn prev(self) -> Self
```

**Purpose**: Moves the menu highlight to the previous directory choice. With only two choices, this behaves the same as moving next: it switches to the other option.

**Data flow**: It receives the currently highlighted choice. It returns the opposite choice. It does not change anything by itself.

**Call relations**: `CwdPromptScreen::handle_key` calls this when the user presses Up or `k`, so the user can navigate the menu in either direction.

*Call graph*: called by 1 (handle_key).


##### `run_cwd_selection_prompt`  (lines 76–118)

```
async fn run_cwd_selection_prompt(
    tui: &mut Tui,
    action: CwdPromptAction,
    current_cwd: &Path,
    session_cwd: &Path,
) -> Result<CwdPromptOutcome>
```

**Purpose**: Runs the full working-directory prompt from start to finish. It draws the prompt, listens for terminal events, and returns either the user's directory choice or an exit result.

**Data flow**: It receives the terminal UI object, the action wording to use, and two filesystem paths: the current directory and the session directory. It turns the paths into display text, creates a `CwdPromptScreen`, draws it, then reads events from the terminal until the screen reports that it is done. At the end it returns `Exit` if the user cancelled, otherwise it returns the selected directory choice, defaulting to the session directory if needed.

**Call relations**: This is called by `resolve_cwd_for_resume_or_fork` when the larger resume-or-fork flow needs the user's decision. It creates the screen with `CwdPromptScreen::new`, sends keyboard events into `CwdPromptScreen::handle_key`, and redraws the screen whenever the terminal asks for a draw or resize.

*Call graph*: calls 1 internal fn (new); called by 1 (resolve_cwd_for_resume_or_fork); 6 external calls (display, draw, event_stream, frame_requester, pin!, Selection).


##### `CwdPromptScreen::new`  (lines 131–146)

```
fn new(
        request_frame: FrameRequester,
        action: CwdPromptAction,
        current_cwd: String,
        session_cwd: String,
    ) -> Self
```

**Purpose**: Creates a fresh prompt screen with all the text and starting state needed to ask the question. The session directory starts highlighted because it is the default choice.

**Data flow**: It receives a frame requester, the action type, and the two directory strings to show. It stores them in a new `CwdPromptScreen`, sets the highlighted option to `Session`, and records that no selection or exit has happened yet. It returns the ready-to-render screen state.

**Call relations**: `run_cwd_selection_prompt` uses this to start the real prompt. The tests also use it, through `tests::new_prompt` or directly, to create predictable screens for snapshots and key-behavior checks.

*Call graph*: called by 3 (run_cwd_selection_prompt, cwd_prompt_fork_snapshot, new_prompt).


##### `CwdPromptScreen::handle_key`  (lines 148–169)

```
fn handle_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Interprets one keyboard event and updates the prompt state. This is where keys like Enter, Escape, arrows, number keys, Ctrl-C, and Ctrl-D get their meaning.

**Data flow**: It receives a key event. It ignores key-release events, treats Ctrl-C and Ctrl-D as an exit request, moves the highlight for navigation keys, chooses an option for number keys or Enter, and chooses the session directory for Escape. When the screen changes, it asks the terminal to draw another frame.

**Call relations**: The event loop in `run_cwd_selection_prompt` calls this whenever a key event arrives. It delegates small pieces of work to `CwdSelection::next`, `CwdSelection::prev`, `CwdPromptScreen::set_highlight`, and `CwdPromptScreen::select`.

*Call graph*: calls 5 internal fn (select, set_highlight, next, prev, schedule_frame); 1 external calls (matches!).


##### `CwdPromptScreen::set_highlight`  (lines 171–176)

```
fn set_highlight(&mut self, highlight: CwdSelection)
```

**Purpose**: Changes which menu item is visually highlighted. It avoids unnecessary redraws if the requested highlight is already active.

**Data flow**: It receives the desired highlighted choice. If that choice differs from the current one, it updates the stored highlight and schedules a new frame so the screen can show the change. It returns nothing.

**Call relations**: `CwdPromptScreen::handle_key` calls this after navigation keys decide the next highlighted option. It then uses the frame requester to make sure the user sees the updated highlight.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key).


##### `CwdPromptScreen::select`  (lines 178–182)

```
fn select(&mut self, selection: CwdSelection)
```

**Purpose**: Records the user's final directory choice. It also moves the highlight to that choice so the visual state and stored decision agree.

**Data flow**: It receives the chosen `CwdSelection`. It stores that choice as both the highlighted row and the final selection, then schedules a redraw. After this, `is_done` will report that the prompt can finish.

**Call relations**: `CwdPromptScreen::handle_key` calls this when the user presses Enter, Escape, or a direct number key. The outer loop in `run_cwd_selection_prompt` later reads the stored choice with `selection`.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key).


##### `CwdPromptScreen::is_done`  (lines 184–186)

```
fn is_done(&self) -> bool
```

**Purpose**: Answers whether the prompt should stop waiting for input. It is done once the user has selected an option or asked to exit.

**Data flow**: It reads the screen's `should_exit` flag and the optional stored selection. If either says the interaction is finished, it returns true; otherwise it returns false.

**Call relations**: `run_cwd_selection_prompt` checks this during its event loop to know whether to keep listening for terminal events or return an outcome.


##### `CwdPromptScreen::selection`  (lines 188–190)

```
fn selection(&self) -> Option<CwdSelection>
```

**Purpose**: Returns the directory choice that has been made, if any. Other code uses this after the prompt finishes to learn what the user picked.

**Data flow**: It reads the screen's stored optional selection. It returns that value unchanged, either `Some(Session)`, `Some(Current)`, or `None` if no choice was recorded.

**Call relations**: After `run_cwd_selection_prompt` leaves its loop, it calls this to turn the screen state into a `CwdPromptOutcome`. Several tests also call it to check that key presses choose the expected option.


##### `CwdPromptScreen::render_ref`  (lines 194–247)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the prompt into the terminal screen buffer. It turns the current prompt state into visible text, options, highlighting, and key hints.

**Data flow**: It receives a screen area and a terminal buffer to draw into. It clears the area, builds a vertical column of text lines, inserts action-specific wording, adds explanations for the two directory choices, draws two selectable rows, and adds an Enter-key hint. The result is written into the buffer for the terminal to display.

**Call relations**: The terminal rendering system calls this whenever `run_cwd_selection_prompt` draws the screen. It asks `CwdPromptAction::verb` and `CwdPromptAction::past_participle` for wording and uses `selection_option_row` to make the two menu rows look consistent with other selection lists.

*Call graph*: calls 5 internal fn (past_participle, verb, tlbr, new, selection_option_row); 3 external calls (from, format!, vec!).


##### `tests::new_prompt`  (lines 259–266)

```
fn new_prompt() -> CwdPromptScreen
```

**Purpose**: Builds a standard test prompt with fixed example directories. This keeps the tests short and makes their expected output stable.

**Data flow**: It creates a dummy frame requester and supplies fixed resume/current/session values to `CwdPromptScreen::new`. It returns the ready-made screen for tests to use.

**Call relations**: The snapshot and key-behavior tests call this helper whenever they need a normal resume prompt without repeating the setup.

*Call graph*: calls 2 internal fn (new, test_dummy).


##### `tests::cwd_prompt_snapshot`  (lines 269–277)

```
fn cwd_prompt_snapshot()
```

**Purpose**: Checks that the default resume prompt still looks the way the project expects. This catches accidental visual changes in the terminal UI.

**Data flow**: It creates the standard prompt, renders it into a fake 80-by-14 terminal, and compares the captured terminal output with a stored snapshot. The test passes only if the rendered screen matches.

**Call relations**: It uses `tests::new_prompt` for setup and then relies on the screen's rendering implementation, `CwdPromptScreen::render_ref`, through the terminal drawing call.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_snapshot!, new, new_prompt).


##### `tests::cwd_prompt_fork_snapshot`  (lines 280–293)

```
fn cwd_prompt_fork_snapshot()
```

**Purpose**: Checks the visual output for the fork version of the prompt. This makes sure the wording changes correctly from resume to fork.

**Data flow**: It creates a prompt using `CwdPromptAction::Fork`, renders it in a fake terminal, and compares the result to a stored snapshot. Any unexpected wording or layout change makes the test fail.

**Call relations**: It constructs the screen with `CwdPromptScreen::new` and exercises the same rendering path used by the real prompt, especially the action-specific wording functions.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 2 external calls (assert_snapshot!, new).


##### `tests::cwd_prompt_selects_session_by_default`  (lines 296–300)

```
fn cwd_prompt_selects_session_by_default()
```

**Purpose**: Verifies that pressing Enter immediately selects the session directory. This protects the default behavior of the prompt.

**Data flow**: It creates a standard prompt, sends it an Enter key event, then reads back the stored selection. The expected result is `Session`.

**Call relations**: It uses `tests::new_prompt`, drives the screen through `CwdPromptScreen::handle_key`, and checks the result through `CwdPromptScreen::selection`.

*Call graph*: 3 external calls (new, assert_eq!, new_prompt).


##### `tests::cwd_prompt_can_select_current`  (lines 303–308)

```
fn cwd_prompt_can_select_current()
```

**Purpose**: Verifies that the user can move to the current directory option and select it. This protects the basic keyboard navigation path.

**Data flow**: It creates a standard prompt, sends a Down key event to move the highlight, then sends Enter to choose the highlighted option. It checks that the final selection is `Current`.

**Call relations**: It exercises the same route a real user would take: `handle_key` moves the highlight through `CwdSelection::next`, then `handle_key` selects it, and the test reads the result with `selection`.

*Call graph*: 3 external calls (new, assert_eq!, new_prompt).


##### `tests::cwd_prompt_ctrl_c_exits_instead_of_selecting`  (lines 311–316)

```
fn cwd_prompt_ctrl_c_exits_instead_of_selecting()
```

**Purpose**: Verifies that Ctrl-C exits the prompt rather than choosing a directory. This matters because Ctrl-C is commonly understood as cancel.

**Data flow**: It creates a standard prompt, sends a Ctrl-C key event, then checks two things: no selection was stored, and the screen reports that it is done. The expected result is a cancelled prompt.

**Call relations**: It drives `CwdPromptScreen::handle_key` through the cancellation branch and checks the state using `selection` and `is_done`, matching what `run_cwd_selection_prompt` relies on in the real event loop.

*Call graph*: 5 external calls (Char, new, assert!, assert_eq!, new_prompt).


### Onboarding and migration flows
These files implement the first-run onboarding experience and related interactive migration/import prompts shown during startup.

### `tui/src/onboarding/mod.rs`

`orchestration` · `startup and first-run onboarding`

This file does not contain the onboarding behavior itself. Instead, it works like a table of contents for the onboarding area of the terminal user interface. Onboarding is the first-run flow that helps a user get set up, such as signing in, checking keys, trusting a directory, and seeing a welcome screen.

The file names the submodules that make up that flow: authentication, keys, the main onboarding screen, trust-directory logic, and the welcome step. Some of these modules are kept private, meaning only the onboarding code can use them directly. The main onboarding screen is made visible to the rest of the crate, so other parts of the app can show or drive the onboarding experience.

It also re-exports two helper functions from the authentication module: one for marking underlined hyperlink text and one for marking URL hyperlinks. Re-exporting means other code can import them from this onboarding module instead of needing to know they live inside the authentication file. Without this file, the onboarding code would be scattered and harder to reach consistently, and other parts of the terminal app would need to know too much about its internal layout.


### `tui/src/onboarding/keys.rs`

`config` · `onboarding`

When someone first uses Codex, the app cannot depend on personalized keyboard shortcuts yet, because the user may not have configured anything. This file solves that bootstrapping problem by listing a small, fixed set of keys that always work during onboarding. Think of it like the emergency buttons on a machine: they are available before any preferences or custom controls are loaded.

The file groups shortcuts by action. For moving through choices, it accepts both arrow keys and familiar Vim-style keys: Up or `k` to move up, Down or `j` to move down. For choosing options, it supports number keys like `1`, `2`, and `3`, plus simple yes/no-style alternatives for the first two choices: `y` and `n`. Enter confirms, Escape cancels, and quitting can be done with `q`, Control-C, or Control-D. There is also a shortcut for toggling animation using Control-period, including a shifted Control-period form.

Each shortcut is stored as a `KeyBinding`, which is the project’s way of representing a key plus any modifier keys such as Control or Shift. Other onboarding code can import these constants and compare real keyboard input against them, without hard-coding the same key choices in many places.


### `tui/src/onboarding/onboarding_screen.rs`

`orchestration` · `startup onboarding flow`

This file is the traffic controller for onboarding in the terminal user interface. Onboarding is a short sequence of screens: a welcome screen, an optional login screen, and an optional screen asking whether to trust the current project directory. Without this file, those pieces would exist separately but would not behave like one smooth flow.

The central idea is a small state machine. Each step can be hidden, in progress, or complete. The screen shows completed steps plus the first unfinished step, like a checklist where you can see what you have already passed and what needs action now. Keyboard and paste events are sent to the right step, while cross-step rules live here.

One important safety rule protects API-key entry. The plain `q` key is normally a quit shortcut, but if the user is typing an API key and the field already has text, `q` is treated as text instead. Explicit control or alt key combinations still work as emergency exits.

The file also draws the onboarding steps from top to bottom, asks for fresh frames when input changes, forwards login notifications from the app server to the auth widget, and persists the user's “trust this project” choice. Its tests focus on the API-key quit guard and the trust-persistence failure path.

#### Function details

##### `KeyboardHandler::handle_paste`  (lines 62–62)

```
fn handle_paste(&mut self, _pasted: String)
```

**Purpose**: This is the default paste behavior for anything that says it can receive keyboard input. By default, pasted text is ignored unless a specific screen overrides this method.

**Data flow**: Pasted text goes in, but this default version does nothing with it. Nothing is returned and no state changes.

**Call relations**: Individual onboarding pieces can choose to provide their own paste behavior. The broader input-routing code can call `handle_paste` safely without needing to know whether a particular step actually accepts pasted text.


##### `OnboardingScreen::new`  (lines 105–169)

```
async fn new(tui: &mut Tui, args: OnboardingScreenArgs) -> Self
```

**Purpose**: This builds the onboarding screen from the current configuration and startup choices. It decides which steps should appear and prepares each one with the information it needs.

**Data flow**: It receives the terminal interface, login status, configuration, optional app-server request handle, and flags saying whether login or trust screens should be shown. It creates a welcome step, optionally creates an auth step, optionally resolves the project directory to trust and creates a trust step, then returns a ready-to-use `OnboardingScreen`.

**Call relations**: `run_onboarding_app` calls this at the start of onboarding. During setup it asks the terminal for a frame requester, may ask platform-specific code about Windows sandbox state, and may ask git utilities for the best project root to trust.

*Call graph*: calls 2 internal fn (new, level_from_config); called by 1 (run_onboarding_app); 11 external calls (new, new, new, resolve_root_git_project_for_trust, frame_requester, Auth, TrustDirectory, Welcome, matches!, new (+1 more)).


##### `OnboardingScreen::current_steps_mut`  (lines 171–184)

```
fn current_steps_mut(&mut self) -> Vec<&mut Step>
```

**Purpose**: This finds the steps that are currently visible and returns them in a form that can be changed. It includes completed visible steps and stops at the first step still in progress.

**Data flow**: It reads the screen's step list and checks each step's state. Hidden steps are skipped, completed steps are included, and the first in-progress step is included before stopping; the result is a list of mutable step references.

**Call relations**: Keyboard and paste routing use this when they need to send input to the active step. It is the helper that keeps later, not-yet-reached steps from receiving input too early.

*Call graph*: called by 2 (handle_key_event, handle_paste); 1 external calls (new).


##### `OnboardingScreen::current_steps`  (lines 186–199)

```
fn current_steps(&self) -> Vec<&Step>
```

**Purpose**: This finds the steps that should be visible without allowing them to be changed. It gives drawing and animation code a safe view of the current onboarding stack.

**Data flow**: It reads the step list, skips hidden steps, includes completed steps, includes the first in-progress step, and returns shared references to those steps.

**Call relations**: Rendering uses this to know what to draw. Animation suppression also uses it to inspect only the steps that are currently on screen.

*Call graph*: called by 2 (render_ref, should_suppress_animations); 1 external calls (new).


##### `OnboardingScreen::should_suppress_animations`  (lines 201–208)

```
fn should_suppress_animations(&self) -> bool
```

**Purpose**: This decides whether onboarding animations should be paused. It pauses them when the auth screen is showing copyable login material, so terminal selection is not disrupted by redraws.

**Data flow**: It looks at the currently visible steps. If an auth step says animations should be suppressed, this returns true; otherwise it returns false.

**Call relations**: Rendering calls this before drawing. The result is passed into visible widgets so the whole onboarding view can stay still when the user may need to copy text.

*Call graph*: calls 1 internal fn (current_steps); called by 1 (render_ref).


##### `OnboardingScreen::is_auth_in_progress`  (lines 210–214)

```
fn is_auth_in_progress(&self) -> bool
```

**Purpose**: This checks whether the sign-in step is currently the unfinished active step. It is used to decide what quitting should mean while login is underway.

**Data flow**: It scans all steps for the auth step and checks whether that step reports an in-progress state. It returns true if active sign-in is still underway, otherwise false.

**Call relations**: The key handler calls this when a quit shortcut is pressed. If auth is in progress, quitting cancels login work and marks the whole app for exit rather than leaving the user unauthenticated at another prompt.

*Call graph*: called by 1 (handle_key_event).


##### `OnboardingScreen::is_done`  (lines 216–222)

```
fn is_done(&self) -> bool
```

**Purpose**: This tells the main onboarding loop whether it can stop. Onboarding is done either because it was explicitly marked done or because no step is still in progress.

**Data flow**: It reads the screen's `is_done` flag and the state of every step. It returns a boolean answer and does not change anything.

**Call relations**: `run_onboarding_app` checks this as the condition for its event loop. Once it returns true, onboarding finishes and returns its result.


##### `OnboardingScreen::should_exit`  (lines 224–226)

```
fn should_exit(&self) -> bool
```

**Purpose**: This reports whether finishing onboarding should also exit the whole application. It separates “onboarding is complete” from “the user wants to leave.”

**Data flow**: It reads the screen's `should_exit` flag and returns it. No other state changes.

**Call relations**: After the event loop ends, `run_onboarding_app` includes this value in the `OnboardingResult` so the caller can decide whether to continue launching the app or stop.


##### `OnboardingScreen::cancel_auth_if_active`  (lines 228–234)

```
fn cancel_auth_if_active(&self)
```

**Purpose**: This asks the auth widget to cancel any active login attempt. It is used when the user quits while authentication is still underway.

**Data flow**: It scans the step list for the auth step. If found, it tells that widget to cancel its active attempt; it returns nothing.

**Call relations**: The key handler calls this during quit handling when sign-in is in progress. This gives the auth widget a chance to stop background login work before onboarding ends.

*Call graph*: called by 1 (handle_key_event).


##### `OnboardingScreen::auth_widget_mut`  (lines 236–241)

```
fn auth_widget_mut(&mut self) -> Option<&mut AuthModeWidget>
```

**Purpose**: This finds the auth widget, if onboarding has one, and returns it in a form that can be updated. It avoids making callers search through every possible step type themselves.

**Data flow**: It scans the mutable step list. If it finds an auth step, it returns a mutable reference to that auth widget; otherwise it returns nothing.

**Call relations**: Server-notification handling uses this helper before forwarding account login and account update messages into the auth UI.

*Call graph*: called by 1 (handle_app_server_notification).


##### `OnboardingScreen::handle_app_server_notification`  (lines 243–257)

```
fn handle_app_server_notification(&mut self, notification: ServerNotification)
```

**Purpose**: This receives account-related messages from the app server and forwards the relevant ones to the auth screen. Other server messages are ignored here because they do not affect onboarding.

**Data flow**: A server notification comes in. If it says account login completed or account data updated, the function finds the auth widget and passes the message to it; otherwise it leaves onboarding unchanged.

**Call relations**: `run_onboarding_app` calls this when the app-server event stream produces a server notification. It uses `auth_widget_mut` so only the auth step needs to know the details of login updates.

*Call graph*: calls 1 internal fn (auth_widget_mut).


##### `OnboardingScreen::api_key_entry_context`  (lines 259–273)

```
fn api_key_entry_context(&self) -> ApiKeyEntryContext
```

**Purpose**: This checks whether the auth screen is currently in API-key typing mode and whether the input field already contains text. That small summary is needed to avoid treating a typed `q` as a quit command at the wrong time.

**Data flow**: It searches for the auth step and asks it two questions: is API-key entry active, and does the field have text? It returns those two answers in an `ApiKeyEntryContext`, or a default “not active, no text” context if there is no auth step.

**Call relations**: The key handler calls this before deciding whether a quit shortcut should really quit. The result is passed to `suppress_quit_while_typing_api_key`.

*Call graph*: called by 1 (handle_key_event).


##### `OnboardingScreen::handle_key_event`  (lines 284–323)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: This is the main keyboard router for onboarding. It decides whether a key press means quit, text input, or a command for the current step.

**Data flow**: A key event comes in. Non-press events are ignored; real presses are checked against quit rules, including the API-key typing guard. If it is a quit, onboarding is marked done and active auth may be canceled. Otherwise the welcome widget and the current active step receive the key. If the trust step requests quitting, the screen is marked done and set to exit. A new frame is requested at the end.

**Call relations**: The main event loop calls this whenever the terminal reports a key event. It consults helpers for auth state, API-key context, and visible mutable steps, then schedules a redraw so the user sees the result.

*Call graph*: calls 6 internal fn (api_key_entry_context, cancel_auth_if_active, current_steps_mut, is_auth_in_progress, suppress_quit_while_typing_api_key, schedule_frame); 1 external calls (matches!).


##### `OnboardingScreen::handle_paste`  (lines 325–334)

```
fn handle_paste(&mut self, pasted: String)
```

**Purpose**: This sends pasted text to the currently active onboarding step. Empty pastes are ignored because they cannot change anything.

**Data flow**: Pasted text comes in. If it is not empty, the function finds the current active step and passes the text to that step, then asks the terminal to draw again.

**Call relations**: The main event loop calls this for paste events. It uses `current_steps_mut` to make sure only the active visible step receives the pasted text.

*Call graph*: calls 2 internal fn (current_steps_mut, schedule_frame).


##### `suppress_quit_while_typing_api_key`  (lines 343–353)

```
fn suppress_quit_while_typing_api_key(
    key_event: KeyEvent,
    api_key_entry_context: ApiKeyEntryContext,
) -> bool
```

**Purpose**: This decides whether a quit shortcut should be treated as normal typed text instead. It protects users from accidentally exiting while entering an API key.

**Data flow**: It receives a key event and a short description of API-key entry state. It returns true only when API-key entry is active, the field already has text, the key is a printable character, and the key is not combined with Control or Alt.

**Call relations**: The onboarding key handler calls this before honoring a quit shortcut. The tests call it directly to prove that plain printable quit keys are suppressed during API-key typing, while empty fields and Control-key exits still work.

*Call graph*: called by 5 (handle_key_event, does_not_suppress_control_quit_key_during_api_key_entry, does_not_suppress_printable_quit_key_when_api_key_input_is_empty, does_not_suppress_when_not_in_api_key_entry, suppresses_printable_quit_key_during_api_key_entry); 1 external calls (matches!).


##### `OnboardingScreen::render_ref`  (lines 356–427)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws the onboarding screen into the terminal buffer. It lays out visible steps from top to bottom and gives each step only the space it needs.

**Data flow**: It receives a screen area and a drawing buffer. It first decides whether animations should be paused, tells visible widgets about that, clears the area, then renders each visible step into a temporary buffer to measure its used height before drawing it into the real buffer.

**Call relations**: The terminal draw calls in `run_onboarding_app` use this to display onboarding. It relies on `current_steps` to know which steps are visible and on `should_suppress_animations` to keep copyable login material stable.

*Call graph*: calls 2 internal fn (current_steps, should_suppress_animations); 2 external calls (empty, new).


##### `Step::handle_key_event`  (lines 431–437)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: This forwards a key event to whichever concrete widget the step contains. It lets the rest of the onboarding code treat welcome, auth, and trust steps uniformly.

**Data flow**: A key event and a step go in. The function matches the step's kind and passes the key to the matching widget; it returns nothing.

**Call relations**: The onboarding screen calls this after it has decided which step should receive input. This small adapter keeps the top-level router from duplicating widget-specific calls everywhere.


##### `Step::handle_paste`  (lines 439–445)

```
fn handle_paste(&mut self, pasted: String)
```

**Purpose**: This forwards pasted text to steps that can use it. Welcome ignores paste, while auth and trust can receive pasted content.

**Data flow**: Pasted text and a step go in. If the step is auth or trust, the text is passed to that widget; if it is welcome, nothing changes.

**Call relations**: The onboarding screen's paste handler calls this for the active step. It hides the difference between step types behind one common method.


##### `Step::get_step_state`  (lines 449–455)

```
fn get_step_state(&self) -> StepState
```

**Purpose**: This asks the concrete widget inside a step whether it is hidden, in progress, or complete. The top-level flow uses that answer to decide what should be visible and active.

**Data flow**: A step goes in. The function calls the matching widget's state method and returns the resulting `StepState`.

**Call relations**: Helpers such as `current_steps`, `current_steps_mut`, and `is_done` depend on this shared view of step state. It is the bridge between individual widgets and the overall onboarding sequence.


##### `Step::render_ref`  (lines 459–471)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws whichever widget is stored in a step. It gives the rendering system one common way to draw welcome, auth, or trust content.

**Data flow**: It receives a drawing area and buffer. It matches the step's kind and asks the contained widget to render itself into that area.

**Call relations**: `OnboardingScreen::render_ref` calls this while measuring and drawing each visible step. This keeps the screen renderer independent of each widget's internal drawing details.


##### `run_onboarding_app`  (lines 474–575)

```
async fn run_onboarding_app(
    args: OnboardingScreenArgs,
    mut app_server: Option<&mut AppServerSession>,
    tui: &mut Tui,
) -> Result<OnboardingResult>
```

**Purpose**: This is the live onboarding loop. It builds the screen, draws it, listens for terminal input and app-server messages, and returns what happened.

**Data flow**: It receives onboarding arguments, an optional app-server session, and the terminal interface. It creates an `OnboardingScreen`, draws it, then loops until onboarding is done. During the loop it routes key, paste, draw, resize, and server events; it may persist project trust; when finished it returns whether trust was saved and whether the app should exit.

**Call relations**: The larger terminal app calls this during startup. Inside the loop it hands keyboard and paste events to the onboarding screen, forwards login notifications from the app server, performs redraws, and calls `persist_selected_trust` once the user chooses to trust a directory.

*Call graph*: calls 1 internal fn (new); called by 1 (run_ratatui_app); 4 external calls (draw, event_stream, pin!, select!).


##### `persist_selected_trust`  (lines 577–622)

```
async fn persist_selected_trust(
    onboarding_screen: &mut OnboardingScreen,
    request_handle: Option<AppServerRequestHandle>,
) -> bool
```

**Purpose**: This saves the user's choice to trust the current project directory. If saving fails, it keeps the trust step open and shows an error instead of pretending the choice worked.

**Data flow**: It receives the onboarding screen and an optional app-server request handle. It searches for a trust step whose selection is “trust,” then tries to write that trusted project through the app server. On success it returns true. On failure it formats the error, logs it, clears the selection, stores an error message in the trust widget, and returns false.

**Call relations**: `run_onboarding_app` calls this after key events until trust has been persisted. A test also calls it directly to confirm that failure leaves the trust step in progress for the user to retry or choose differently.

*Call graph*: calls 2 internal fn (format_config_error, write_trusted_project); called by 1 (trust_persistence_failure_keeps_trust_step_in_progress); 3 external calls (eyre!, format!, error!).


##### `tests::suppresses_printable_quit_key_during_api_key_entry`  (lines 642–651)

```
fn suppresses_printable_quit_key_during_api_key_entry()
```

**Purpose**: This test proves that a plain printable quit key is ignored as a quit command once the user has started typing an API key.

**Data flow**: It builds a `q` key event with no modifiers and an API-key context saying entry is active and has text. It calls the suppression helper and checks that the answer is true.

**Call relations**: The test runner calls this as part of the file's safety checks. It directly exercises `suppress_quit_while_typing_api_key`, the helper used by the real key handler.

*Call graph*: calls 1 internal fn (suppress_quit_while_typing_api_key); 3 external calls (Char, new, assert!).


##### `tests::does_not_suppress_printable_quit_key_when_api_key_input_is_empty`  (lines 654–663)

```
fn does_not_suppress_printable_quit_key_when_api_key_input_is_empty()
```

**Purpose**: This test proves that plain `q` can still quit when the API-key input field is empty. That keeps the quit shortcut convenient before typing begins.

**Data flow**: It creates a plain `q` key event and an API-key context where entry is active but has no text. It calls the helper and checks that suppression is false.

**Call relations**: The test runner calls this to guard the intended empty-field behavior. It checks the same helper used by onboarding's key-routing code.

*Call graph*: calls 1 internal fn (suppress_quit_while_typing_api_key); 3 external calls (Char, new, assert!).


##### `tests::does_not_suppress_control_quit_key_during_api_key_entry`  (lines 666–675)

```
fn does_not_suppress_control_quit_key_during_api_key_entry()
```

**Purpose**: This test proves that Control-key quit shortcuts still work while typing an API key. These shortcuts are treated as explicit exits, not normal text.

**Data flow**: It creates a Control-modified character key event and an API-key context where entry is active and has text. It calls the helper and checks that suppression is false.

**Call relations**: The test runner calls this to make sure the emergency-exit behavior stays available. It directly verifies the rule that Control or Alt modifiers bypass printable-key suppression.

*Call graph*: calls 1 internal fn (suppress_quit_while_typing_api_key); 3 external calls (Char, new, assert!).


##### `tests::does_not_suppress_when_not_in_api_key_entry`  (lines 678–687)

```
fn does_not_suppress_when_not_in_api_key_entry()
```

**Purpose**: This test proves that the quit-key suppression only applies during API-key entry. Outside that mode, normal quit handling should not be blocked.

**Data flow**: It creates a plain character key event and a context saying API-key entry is not active. It calls the helper and checks that suppression is false.

**Call relations**: The test runner calls this to keep the API-key guard narrowly scoped. It protects the rest of onboarding from accidentally losing quit shortcuts.

*Call graph*: calls 1 internal fn (suppress_quit_while_typing_api_key); 3 external calls (Char, new, assert!).


##### `tests::trust_persistence_failure_keeps_trust_step_in_progress`  (lines 690–721)

```
async fn trust_persistence_failure_keeps_trust_step_in_progress()
```

**Purpose**: This test proves that failing to save a trusted project does not silently finish the trust step. The user should see an error and remain able to act.

**Data flow**: It builds a minimal onboarding screen with a trust step already selected, but passes no app-server request handle. It calls `persist_selected_trust`, checks that it returns false, then verifies the selection was cleared, the step is still in progress, and the error mentions the unavailable app server.

**Call relations**: The test runner calls this to cover the failure path of `persist_selected_trust`. It makes sure the main onboarding loop will not move on after a trust-save failure.

*Call graph*: calls 2 internal fn (persist_selected_trust, test_dummy); 4 external calls (assert!, assert_eq!, panic!, vec!).


### `tui/src/onboarding/welcome.rs`

`domain_logic` · `onboarding screen rendering and keyboard handling`

The welcome screen is the first friendly face of the terminal app. This file makes sure that screen looks right, does not break on small terminal windows, and reacts to a small amount of keyboard input. Its main type, `WelcomeWidget`, keeps track of whether the user is already logged in, whether animations are allowed, whether they are temporarily paused, and what screen area it should use when deciding if an animation will fit.

When the widget is drawn, it first clears its part of the terminal. If animations are enabled and not suppressed, it asks the animation system to schedule another frame, like telling a flipbook to keep flipping. It then checks the available size. If the terminal is too short or narrow, it skips the ASCII art entirely so the image is not clipped or messy. Either way, it prints the welcome line: “Welcome to Codex, OpenAI's command-line coding agent.”

The file also connects this welcome panel to the onboarding flow. If the user is already logged in, this step is hidden. If not, the step counts as complete, meaning the user can continue onward. The tests verify the important visible behavior: the animation appears when there is room, disappears when there is not, and changes variant when the expected keyboard shortcuts are pressed.

#### Function details

##### `WelcomeWidget::handle_key_event`  (lines 39–47)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: This reacts to keyboard input while the welcome screen is active. If animations are enabled and the user presses the animation-toggle shortcut, it switches the welcome background to another random ASCII animation variant.

**Data flow**: It receives one key event from the terminal. It first ignores the event if animations are disabled. Otherwise, it checks that the key was a press, not a release or repeat-like event, and that it matches the configured animation shortcut. If it matches, it asks the animation object to pick a new variant; the visible result is that future draws can show different ASCII art.

**Call relations**: The onboarding screen calls this when keyboard input arrives for the welcome step. Inside, it hands the actual variant change to the animation object through `pick_random_variant`, and writes a warning log message for visibility while debugging.

*Call graph*: calls 1 internal fn (pick_random_variant); 1 external calls (warn!).


##### `WelcomeWidget::new`  (lines 51–63)

```
fn new(
        is_logged_in: bool,
        request_frame: FrameRequester,
        animations_enabled: bool,
    ) -> Self
```

**Purpose**: This builds a fresh welcome widget with the right login state, animation setup, and animation policy. Code uses it when creating the onboarding welcome screen.

**Data flow**: It receives whether the user is logged in, a frame requester used by the animation to ask the terminal to redraw, and a flag saying whether animations are enabled. It creates a new `AsciiAnimation`, stores the flags, starts with animations not suppressed, and starts without a saved layout area. The result is a ready-to-render `WelcomeWidget`.

**Call relations**: Higher-level onboarding setup calls this when it needs the welcome panel. The tests also call it to create normal widgets before drawing them. It delegates animation construction to `AsciiAnimation::new`, passing along the frame requester so the animation can keep the screen refreshed.

*Call graph*: calls 1 internal fn (new); called by 3 (new, welcome_renders_animation_on_first_draw, welcome_skips_animation_below_height_breakpoint); 1 external calls (new).


##### `WelcomeWidget::update_layout_area`  (lines 65–67)

```
fn update_layout_area(&self, area: Rect)
```

**Purpose**: This records the screen area that should be used when deciding whether the animation has enough room. It lets layout code tell the widget about the real space available to it.

**Data flow**: It receives a rectangle describing part of the terminal screen. It stores that rectangle inside the widget. Later, rendering reads this saved value to decide whether the ASCII animation should be shown or skipped.

**Call relations**: Layout code calls this before rendering when it has calculated the welcome screen’s actual area. `render_ref` later uses the stored area, falling back to the render area if no separate layout area has been provided.


##### `WelcomeWidget::set_animations_suppressed`  (lines 69–71)

```
fn set_animations_suppressed(&self, suppressed: bool)
```

**Purpose**: This temporarily turns welcome animations off or back on without changing the global animation setting. It is useful when another screen state needs the welcome page to stop moving for a while.

**Data flow**: It receives a boolean value: `true` means suppress animations, `false` means allow them again. It stores that value in the widget. Later rendering and keyboard behavior use this stored state to avoid scheduling or showing animation frames while suppressed.

**Call relations**: Other onboarding UI code can call this when animations should pause, for example if another overlay or mode should keep the screen still. `render_ref` reads the stored value before scheduling or drawing animation frames.


##### `WelcomeWidget::render_ref`  (lines 75–104)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: This draws the welcome widget into the terminal buffer. It clears the area, optionally draws the ASCII animation, and always draws the welcome message.

**Data flow**: It receives a rectangle saying where to draw and a mutable terminal buffer where characters are placed. It clears that rectangle, schedules the next animation frame if animations are active, checks whether the available layout is large enough, then builds a list of text lines. If there is enough room, it adds the current ASCII animation frame first. Finally, it adds the welcome text and renders all lines as a paragraph into the buffer.

**Call relations**: The terminal UI rendering system calls this whenever the welcome widget needs to be painted. It asks the `AsciiAnimation` for the current frame and to schedule future redraws, then hands the finished lines to Ratatui’s `Paragraph`, which is the library component that writes formatted text into the terminal buffer.

*Call graph*: calls 2 internal fn (current_frame, schedule_next_frame); 4 external calls (from, new, new, vec!).


##### `WelcomeWidget::get_step_state`  (lines 108–113)

```
fn get_step_state(&self) -> StepState
```

**Purpose**: This tells the onboarding flow whether the welcome step should be visible and considered done. It hides the welcome step for users who are already logged in.

**Data flow**: It reads the widget’s `is_logged_in` flag. If the flag is true, it returns `StepState::Hidden`. If the flag is false, it returns `StepState::Complete`. It does not change any stored data.

**Call relations**: The onboarding screen asks this through the `StepStateProvider` trait when deciding which steps to show and how to advance through them. This function supplies the welcome screen’s simple rule: logged-in users do not need to see it, and logged-out users can pass through it.


##### `tests::row_containing`  (lines 129–137)

```
fn row_containing(buf: &Buffer, needle: &str) -> Option<u16>
```

**Purpose**: This test helper finds which row of a terminal buffer contains a given piece of text. The tests use it to check where the welcome message appears on screen.

**Data flow**: It receives a rendered buffer and a text snippet to search for. It scans each row from top to bottom, joins the visible symbols in that row into a string, and checks whether the row contains the snippet. It returns the row number if found, or nothing if the text is absent.

**Call relations**: The rendering tests call this after drawing the widget into a fake buffer. It turns the buffer’s grid of terminal cells into an easy answer: where did the word “Welcome” land?


##### `tests::welcome_renders_animation_on_first_draw`  (lines 140–153)

```
fn welcome_renders_animation_on_first_draw()
```

**Purpose**: This test proves that the welcome screen includes the animation when the terminal is large enough. It protects against accidentally removing or delaying the first animation frame.

**Data flow**: It creates a welcome widget with animations enabled, prepares a buffer exactly large enough for the animation threshold, counts the current animation frame’s lines, and renders the widget. It then searches for the welcome text and checks that it appears after the animation plus one blank line.

**Call relations**: The test uses `WelcomeWidget::new` to build a normal widget, renders it through the widget interface, and uses `tests::row_containing` to inspect the result. It confirms the main drawing path in `WelcomeWidget::render_ref` when animation display is allowed.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (empty, new, assert_eq!, row_containing).


##### `tests::welcome_skips_animation_below_height_breakpoint`  (lines 156–168)

```
fn welcome_skips_animation_below_height_breakpoint()
```

**Purpose**: This test proves that the welcome screen skips the ASCII animation when the terminal is too short. That keeps the interface readable instead of showing clipped art.

**Data flow**: It creates a welcome widget with animations enabled, but gives it a buffer one row shorter than the required animation height. After rendering, it searches for the welcome text and expects it to be on the first row, showing that no animation lines were drawn above it.

**Call relations**: The test builds the widget with `WelcomeWidget::new`, draws it, then asks `tests::row_containing` where the welcome message appeared. It checks the small-screen branch of `WelcomeWidget::render_ref`.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (empty, new, assert_eq!, row_containing).


##### `tests::ctrl_dot_changes_animation_variant`  (lines 171–192)

```
fn ctrl_dot_changes_animation_variant()
```

**Purpose**: This test checks that pressing Control plus period changes the welcome animation variant. It ensures the documented shortcut works in terminals that report that key combination in this form.

**Data flow**: It creates a widget with two known animation variants and starts on the first one. It records the current frame, sends a Control-period key event to the widget, then reads the frame again. The test passes only if the frame changed.

**Call relations**: The test calls `WelcomeWidget::handle_key_event` directly with a fake key event. That exercises the shortcut path, which then calls the animation’s variant-picking logic.

*Call graph*: calls 2 internal fn (with_variants, test_dummy); 4 external calls (new, Char, new, assert_ne!).


##### `tests::ctrl_shift_dot_changes_animation_variant`  (lines 195–219)

```
fn ctrl_shift_dot_changes_animation_variant()
```

**Purpose**: This test checks that Control plus Shift plus period also changes the welcome animation variant. This matters because different terminals may report the same practical shortcut with slightly different modifier keys.

**Data flow**: It creates a widget with two known animation variants and starts on the first one. It saves the current frame, sends a Control-Shift-period key event, and then reads the current frame again. The expected result is that the frame is different after the key press.

**Call relations**: Like the Control-period test, this calls `WelcomeWidget::handle_key_event` directly. It verifies the compatibility version of the animation shortcut, making sure the key binding list accepts this terminal-specific variation.

*Call graph*: calls 2 internal fn (with_variants, test_dummy); 4 external calls (new, Char, new, assert_ne!).


### `tui/src/onboarding/auth.rs`

`domain_logic` · `onboarding auth step`

This file is the control panel for authentication during first-time setup in the terminal UI. Without it, onboarding would not know how to ask the user to sign in, how to collect an API key, how to cancel a half-finished login, or how to react when the app server reports that login finished.

The main piece is `AuthModeWidget`, a terminal widget that both draws the screen and reacts to keyboard input. It keeps a shared sign-in state, such as “pick a method,” “continue in browser,” “enter API key,” or “signed in.” Think of it like a small ticket counter: the user chooses a line, the widget starts the right process, and then it updates the display as the process moves forward.

For ChatGPT login, it asks the app server to start login, may open the browser, and shows the URL if needed. For remote machines, it can switch to a device-code flow handled by a helper module. For API keys, it shows an input box, accepts typing or paste, and sends the key to the app server to store locally. It also respects workspace rules that may force only ChatGPT or only API-key login.

The file also contains tests for important edge cases: disabled API-key login, canceling active login attempts, hyperlink rendering, and successful device-code completion.

#### Function details

##### `mark_url_hyperlink`  (lines 64–66)

```
fn mark_url_hyperlink(buf: &mut Buffer, area: Rect, url: &str)
```

**Purpose**: Marks the rendered characters of a visible URL so terminals treat the whole URL as one clickable link. This is useful when a long login URL wraps across multiple terminal rows.

**Data flow**: It receives a terminal buffer, the rectangle to scan, and the URL text. It passes those to the shared terminal hyperlink helper, which wraps the matching styled cells with terminal hyperlink escape codes. The buffer is changed in place; nothing is returned.

**Call relations**: The browser-login screen calls this after drawing the auth URL. Tests also call it directly to prove wrapped URLs and unsafe control characters are handled correctly.

*Call graph*: calls 1 internal fn (mark_url_hyperlink); called by 3 (render_continue_in_browser, mark_url_hyperlink_sanitizes_control_chars, mark_url_hyperlink_wraps_cyan_underlined_cells).


##### `mark_underlined_hyperlink`  (lines 69–71)

```
fn mark_underlined_hyperlink(buf: &mut Buffer, area: Rect, url: &str)
```

**Purpose**: Marks underlined text in a terminal buffer as a clickable terminal hyperlink. It is a small local wrapper around the shared hyperlink helper.

**Data flow**: It receives a buffer, an area, and a URL. It forwards them to the shared helper, which edits matching underlined cells in the buffer. It returns no value.

**Call relations**: This file exposes the helper for auth-related rendering, although the listed call graph does not show another function in this file using it directly.

*Call graph*: calls 1 internal fn (mark_underlined_hyperlink).


##### `onboarding_request_id`  (lines 97–99)

```
fn onboarding_request_id() -> codex_app_server_protocol::RequestId
```

**Purpose**: Creates a fresh request ID for messages sent from onboarding to the app server. A request ID is a unique label that lets the server and client tell one request from another.

**Data flow**: It generates a new UUID, which is a random unique identifier, turns it into text, and wraps it in the protocol’s request ID type. The result is used in outgoing app-server requests.

**Call relations**: API-key saving, ChatGPT login start, and login cancellation all call this before sending a request so each request can be tracked separately.

*Call graph*: called by 3 (save_api_key, start_chatgpt_login, cancel_login_attempt); 2 external calls (new_v4, String).


##### `cancel_login_attempt`  (lines 101–113)

```
async fn cancel_login_attempt(
    request_handle: &AppServerRequestHandle,
    login_id: String,
)
```

**Purpose**: Asks the app server to cancel a login that was already started. This prevents abandoned browser or device-code login attempts from staying active after the user backs out.

**Data flow**: It receives an app-server request handle and a login ID. It builds a cancel request with a fresh request ID and sends it asynchronously. It ignores the response because cancellation is best-effort.

**Call relations**: When the user presses cancel during an active ChatGPT or device-code login, `AuthModeWidget::cancel_active_attempt` starts this function in the background.

*Call graph*: calls 1 internal fn (onboarding_request_id); called by 1 (cancel_active_attempt).


##### `ContinueWithDeviceCodeState::pending`  (lines 137–144)

```
fn pending(request_id: String) -> Self
```

**Purpose**: Creates the starting state for a device-code login before the server has returned the code and verification URL. It records that a request is underway.

**Data flow**: It receives a request ID and builds a state object with no login ID, no verification URL, and no user code yet. The returned state means “waiting for device-code details.”

**Call relations**: The headless ChatGPT login helper uses this while requesting a code. Tests use it to check that the auth widget suppresses animations even while the code is still being fetched.

*Call graph*: called by 4 (start_headless_chatgpt_login, device_code_attempt_matches_only_for_matching_request_id, pending_device_code_state, auth_widget_suppresses_animations_while_requesting_device_code).


##### `ContinueWithDeviceCodeState::ready`  (lines 146–158)

```
fn ready(
        request_id: String,
        login_id: String,
        verification_url: String,
        user_code: String,
    ) -> Self
```

**Purpose**: Creates the device-code state once the server has provided everything the user needs. This is the state where the screen can show a URL and one-time code.

**Data flow**: It receives the request ID, login ID, verification URL, and user code. It stores them in a state object and returns it for rendering and later completion matching.

**Call relations**: The headless login helper uses this after receiving device-code details. Tests also build this state to check cancellation, animation suppression, and successful login completion.

*Call graph*: called by 4 (start_headless_chatgpt_login, auth_widget_suppresses_animations_when_device_code_is_visible, cancel_active_attempt_notifies_device_code_login, device_code_login_completion_advances_to_success_message).


##### `ContinueWithDeviceCodeState::login_id`  (lines 160–162)

```
fn login_id(&self) -> Option<&str>
```

**Purpose**: Returns the login ID for a device-code attempt, if the server has assigned one. The login ID is used to match later success or failure notifications to the correct attempt.

**Data flow**: It reads the optional stored login ID and returns it as borrowed text when present. It does not change the state.

**Call relations**: Other auth logic uses this when deciding whether a cancel request or login-completed notification belongs to the current device-code login.


##### `ContinueWithDeviceCodeState::is_showing_copyable_auth`  (lines 164–172)

```
fn is_showing_copyable_auth(&self) -> bool
```

**Purpose**: Checks whether the device-code screen has both pieces of information the user can copy: the verification URL and the one-time code.

**Data flow**: It reads the stored URL and code, checks that both exist and are not empty, and returns true only in that case. It does not change anything.

**Call relations**: The device-code renderer uses this to decide whether to show copy-friendly login information or a still-loading view.

*Call graph*: called by 1 (render_device_code_login).


##### `AuthModeWidget::handle_key_event`  (lines 176–218)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Responds to keyboard input on the auth screen. It moves the selection, starts the chosen sign-in method, advances past a success message, or cancels an active login.

**Data flow**: It receives a key event. First it gives API-key entry a chance to consume the key; if not, it checks navigation, number shortcuts, confirm, and cancel. The result may be a changed highlighted option, changed sign-in state, an app-server request, or a scheduled redraw.

**Call relations**: The onboarding screen calls this when the user presses a key. It delegates to option selection, API-key editing, login start, and cancellation helpers depending on the current state.

*Call graph*: calls 5 internal fn (cancel_active_attempt, handle_api_key_entry_key_event, handle_sign_in_option, move_highlight, select_option_by_index); 1 external calls (info!).


##### `AuthModeWidget::handle_paste`  (lines 220–222)

```
fn handle_paste(&mut self, pasted: String)
```

**Purpose**: Responds to pasted text, mainly so users can paste an API key into the API-key input box.

**Data flow**: It receives pasted text and passes it to the API-key paste handler. If the auth screen is not currently accepting an API key, the paste has no effect.

**Call relations**: The onboarding screen calls this when terminal paste input arrives. It hands off to `handle_api_key_entry_paste` for the actual state update.

*Call graph*: calls 1 internal fn (handle_api_key_entry_paste).


##### `AuthModeWidget::set_animations_suppressed`  (lines 240–242)

```
fn set_animations_suppressed(&self, suppressed: bool)
```

**Purpose**: Records whether animations should be temporarily hidden for this widget. This lets surrounding UI avoid distracting motion during sensitive or copy-focused login screens.

**Data flow**: It receives a boolean value and stores it in an internal cell. It returns nothing and does not redraw by itself.

**Call relations**: Other UI code can call this to tell the auth widget whether animation should be suppressed. Rendering later reads this flag when deciding whether to shimmer text.


##### `AuthModeWidget::should_suppress_animations`  (lines 244–249)

```
fn should_suppress_animations(&self) -> bool
```

**Purpose**: Reports whether the current auth state is one where animations should be avoided. Browser and device-code login screens are treated as copy-sensitive or focus-sensitive.

**Data flow**: It reads the shared sign-in state and returns true if the user is in browser-login or device-code-login mode. Otherwise it returns false.

**Call relations**: Tests exercise this behavior for device-code states. The surrounding onboarding UI can use it to decide whether to reduce motion.

*Call graph*: 1 external calls (matches!).


##### `AuthModeWidget::cancel_active_attempt`  (lines 251–275)

```
fn cancel_active_attempt(&self)
```

**Purpose**: Cancels the current ChatGPT login attempt, if one is active, and returns the screen to the method picker. This gives the user a clean way out of browser or device-code login.

**Data flow**: It reads the current sign-in state. If there is an active browser or device-code login with a login ID, it starts a background cancellation request to the app server. It then clears the error, switches back to pick mode, and asks the UI to redraw.

**Call relations**: `handle_key_event` calls this when the cancel key is pressed. It uses `cancel_login_attempt` for the server notification and `set_error` to clear visible errors.

*Call graph*: calls 3 internal fn (set_error, cancel_login_attempt, schedule_frame); called by 1 (handle_key_event); 2 external calls (clone, spawn).


##### `AuthModeWidget::set_error`  (lines 277–279)

```
fn set_error(&self, message: Option<String>)
```

**Purpose**: Stores the error message that should be shown on the auth screen. Passing no message clears the error.

**Data flow**: It receives an optional string and writes it into the shared error slot. The next render can read and display that value.

**Call relations**: Many flows call this before or after state changes: API-key editing, login start, login completion, cancellation, and disabled-login handling.

*Call graph*: called by 9 (cancel_active_attempt, disallow_api_login, handle_api_key_entry_key_event, handle_api_key_entry_paste, on_account_login_completed, save_api_key, start_api_key_entry, start_chatgpt_login, start_device_code_login).


##### `AuthModeWidget::error_message`  (lines 281–283)

```
fn error_message(&self) -> Option<String>
```

**Purpose**: Returns the current auth error message, if there is one. Renderers use it to show helpful feedback to the user.

**Data flow**: It reads the shared error slot, clones the optional string, and returns it. It does not change state.

**Call relations**: The pick-mode and API-key-entry renderers call this when deciding whether to draw an error line.

*Call graph*: called by 2 (render_api_key_entry, render_pick_mode).


##### `AuthModeWidget::is_api_key_entry_active`  (lines 286–290)

```
fn is_api_key_entry_active(&self) -> bool
```

**Purpose**: Tells other code whether the auth screen is currently showing the API-key input field.

**Data flow**: It reads the sign-in state and returns true only when that state is API-key entry. It returns false if the state cannot be read or is anything else.

**Call relations**: This is a status helper for surrounding UI code that may need to know whether typed text should be treated as API-key input.


##### `AuthModeWidget::api_key_entry_has_text`  (lines 293–297)

```
fn api_key_entry_has_text(&self) -> bool
```

**Purpose**: Tells other code whether the API-key field currently contains any text. This can be used to decide whether leaving the field would discard typed input.

**Data flow**: It reads the sign-in state. If the state is API-key entry, it checks whether the stored value is empty and returns the answer.

**Call relations**: This is a small query helper for the larger onboarding screen or input system.


##### `AuthModeWidget::confirm_binding`  (lines 299–301)

```
fn confirm_binding(&self) -> KeyBinding
```

**Purpose**: Returns the key binding shown as the confirm action on this screen. It keeps rendered instructions aligned with the actual key handling.

**Data flow**: It reads the first configured confirm key binding and returns it. No state is changed.

**Call relations**: Render functions use this when drawing text like “Press Enter to continue” or “Press Enter to save.”


##### `AuthModeWidget::cancel_binding`  (lines 303–305)

```
fn cancel_binding(&self) -> KeyBinding
```

**Purpose**: Returns the key binding shown as the cancel action on this screen. It keeps the on-screen help text consistent with input behavior.

**Data flow**: It reads the first configured cancel key binding and returns it. No state is changed.

**Call relations**: Browser-login and API-key-entry renderers use this when showing cancel instructions.


##### `AuthModeWidget::is_api_login_allowed`  (lines 307–309)

```
fn is_api_login_allowed(&self) -> bool
```

**Purpose**: Checks whether API-key login is allowed under the current workspace rules. Some workspaces may force ChatGPT login only.

**Data flow**: It reads the optional forced login method. It returns false when the forced method is ChatGPT, and true otherwise.

**Call relations**: Option display, selection handling, API-key start, and API-key saving all call this so the UI cannot bypass the forced-login rule.

*Call graph*: called by 6 (displayed_sign_in_options, handle_sign_in_option, render_pick_mode, save_api_key, selectable_sign_in_options, start_api_key_entry); 1 external calls (matches!).


##### `AuthModeWidget::is_chatgpt_login_allowed`  (lines 311–313)

```
fn is_chatgpt_login_allowed(&self) -> bool
```

**Purpose**: Checks whether ChatGPT login is allowed under the current workspace rules. Some workspaces may force API-key login only.

**Data flow**: It reads the optional forced login method. It returns false when the forced method is API, and true otherwise.

**Call relations**: The picker, navigation list, and sign-in option handler use this to hide or block ChatGPT-based choices when needed.

*Call graph*: called by 4 (displayed_sign_in_options, handle_sign_in_option, render_pick_mode, selectable_sign_in_options); 1 external calls (matches!).


##### `AuthModeWidget::displayed_sign_in_options`  (lines 315–324)

```
fn displayed_sign_in_options(&self) -> Vec<SignInOption>
```

**Purpose**: Builds the list of sign-in options that should be shown to the user. This list can include disabled-looking information differently from what is selectable.

**Data flow**: It starts with ChatGPT as a displayed option, adds device-code if ChatGPT login is allowed, and adds API key if API login is allowed. It returns the resulting list.

**Call relations**: The picker renderer uses this list to draw choices. Number-key selection also uses it to map “first,” “second,” or “third” to a visible option.

*Call graph*: calls 2 internal fn (is_api_login_allowed, is_chatgpt_login_allowed); called by 2 (render_pick_mode, select_option_by_index); 1 external calls (vec!).


##### `AuthModeWidget::selectable_sign_in_options`  (lines 326–336)

```
fn selectable_sign_in_options(&self) -> Vec<SignInOption>
```

**Purpose**: Builds the list of options the highlight can actually move through. This avoids landing the cursor on choices that are not allowed.

**Data flow**: It checks the forced-login rules and adds only allowed options to a new list. It returns that list for navigation.

**Call relations**: `move_highlight` calls this whenever the user presses up or down.

*Call graph*: calls 2 internal fn (is_api_login_allowed, is_chatgpt_login_allowed); called by 1 (move_highlight); 1 external calls (new).


##### `AuthModeWidget::move_highlight`  (lines 338–351)

```
fn move_highlight(&mut self, delta: isize)
```

**Purpose**: Moves the highlighted sign-in option up or down, wrapping around at the ends. This is the menu-navigation behavior for the picker.

**Data flow**: It receives a positive or negative movement amount. It finds the current option in the selectable list, calculates the next index with wraparound, and updates `highlighted_mode`.

**Call relations**: `handle_key_event` calls this for the move-up and move-down keys. It relies on `selectable_sign_in_options` to respect login restrictions.

*Call graph*: calls 1 internal fn (selectable_sign_in_options); called by 1 (handle_key_event).


##### `AuthModeWidget::select_option_by_index`  (lines 353–358)

```
fn select_option_by_index(&mut self, index: usize)
```

**Purpose**: Chooses a sign-in option by its displayed number. This powers keyboard shortcuts like pressing 1, 2, or 3.

**Data flow**: It receives a zero-based index, looks up that option in the displayed list, and if one exists passes it to the sign-in option handler. Invalid indexes do nothing.

**Call relations**: `handle_key_event` calls this for number shortcuts. It then hands off to `handle_sign_in_option` to start or reject the chosen flow.

*Call graph*: calls 2 internal fn (displayed_sign_in_options, handle_sign_in_option); called by 1 (handle_key_event).


##### `AuthModeWidget::handle_sign_in_option`  (lines 360–380)

```
fn handle_sign_in_option(&mut self, option: SignInOption)
```

**Purpose**: Starts the flow for the selected sign-in method, while enforcing which methods are allowed. It is the main branch point after the user chooses a login type.

**Data flow**: It receives a sign-in option. For ChatGPT it may start browser login, for device code it may start headless login, and for API key it may open the API-key input or show a disabled message. It updates state through the called helpers.

**Call relations**: This is called when the user presses confirm on the highlighted option or selects an option by number. It delegates to the specific start functions.

*Call graph*: calls 6 internal fn (disallow_api_login, is_api_login_allowed, is_chatgpt_login_allowed, start_api_key_entry, start_chatgpt_login, start_device_code_login); called by 2 (handle_key_event, select_option_by_index).


##### `AuthModeWidget::disallow_api_login`  (lines 382–387)

```
fn disallow_api_login(&mut self)
```

**Purpose**: Shows the user that API-key login is not permitted and returns them to the normal picker. This prevents a forced-ChatGPT workspace from accepting an API key.

**Data flow**: It changes the highlighted option back to ChatGPT, stores a clear error message, sets the state to pick mode, and schedules a redraw.

**Call relations**: API-key selection, API-key entry start, and API-key saving call this whenever the forced-login rules block API login.

*Call graph*: calls 2 internal fn (set_error, schedule_frame); called by 3 (handle_sign_in_option, save_api_key, start_api_key_entry).


##### `AuthModeWidget::render_pick_mode`  (lines 389–489)

```
fn render_pick_mode(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the sign-in method picker. It explains the choices, highlights the current one, shows disabled-login information, and displays any error.

**Data flow**: It reads allowed methods, the highlighted method, key bindings, and current error. It builds styled text lines and writes them into the terminal buffer.

**Call relations**: `render_ref` calls this whenever the sign-in state is pick mode. It uses option-list and permission helpers so the screen matches the actual rules.

*Call graph*: calls 4 internal fn (displayed_sign_in_options, error_message, is_api_login_allowed, is_chatgpt_login_allowed); called by 1 (render_ref); 3 external calls (from, new, vec!).


##### `AuthModeWidget::render_continue_in_browser`  (lines 491–544)

```
fn render_continue_in_browser(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the screen shown after browser-based ChatGPT login has started. It tells the user to finish in the browser and shows a fallback URL if available.

**Data flow**: It reads the current browser-login state and animation settings. It writes status text, the auth URL, remote-machine advice, and cancel instructions into the buffer. If a URL was drawn, it marks it as a terminal hyperlink.

**Call relations**: `render_ref` calls this for browser-login state. It uses `shimmer_text` for optional animation and `mark_url_hyperlink` so the login URL remains clickable even when wrapped.

*Call graph*: calls 3 internal fn (shimmer_text, mark_url_hyperlink, schedule_frame_in); called by 1 (render_ref); 4 external calls (from, new, from_millis, vec!).


##### `AuthModeWidget::render_chatgpt_success_message`  (lines 546–591)

```
fn render_chatgpt_success_message(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the longer success-and-safety message after ChatGPT login completes. It gives the user a brief pause to read important guidance before continuing.

**Data flow**: It builds lines that confirm sign-in, mention autonomy and review reminders, link to docs and settings, and show the confirm key. It writes those lines to the terminal buffer.

**Call relations**: `render_ref` calls this for the intermediate ChatGPT success-message state. Pressing confirm later moves the state to final success.

*Call graph*: called by 1 (render_ref); 2 external calls (new, vec!).


##### `AuthModeWidget::render_chatgpt_success`  (lines 593–603)

```
fn render_chatgpt_success(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the compact final ChatGPT success line. This is used once the auth step is considered complete.

**Data flow**: It creates a green confirmation line and writes it to the terminal buffer. It reads no extra data and changes no state.

**Call relations**: `render_ref` calls this when the sign-in state is final ChatGPT success.

*Call graph*: called by 1 (render_ref); 2 external calls (new, vec!).


##### `AuthModeWidget::render_api_key_configured`  (lines 605–615)

```
fn render_api_key_configured(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the success screen for API-key setup. It confirms that Codex will use usage-based billing with the provided key.

**Data flow**: It creates a small set of confirmation lines and writes them into the terminal buffer. It changes no state.

**Call relations**: `render_ref` calls this after the app server accepts the API key.

*Call graph*: called by 1 (render_ref); 2 external calls (new, vec!).


##### `AuthModeWidget::render_api_key_entry`  (lines 617–682)

```
fn render_api_key_entry(&self, area: Rect, buf: &mut Buffer, state: &ApiKeyInputState)
```

**Purpose**: Draws the API-key entry form. It includes instructions, a bordered input box, save/back key hints, and any validation or save error.

**Data flow**: It receives the current API-key input state, including the typed value and whether it came from the environment. It splits the screen into intro, input, and footer areas, then writes the appropriate text into each.

**Call relations**: `render_ref` calls this while the sign-in state is API-key entry. It reads `error_message` to show problems like an empty key or save failure.

*Call graph*: calls 1 internal fn (error_message); called by 1 (render_ref); 8 external calls (default, Length, Min, vertical, from, new, default, vec!).


##### `AuthModeWidget::handle_api_key_entry_key_event`  (lines 684–744)

```
fn handle_api_key_entry_key_event(&mut self, key_event: &KeyEvent) -> bool
```

**Purpose**: Processes keystrokes while the API-key input box is active. It supports cancel, save, backspace, and normal character typing.

**Data flow**: It receives a key event and checks whether the current state is API-key entry. It may edit the stored key text, clear the environment-prefill marker, set an error, return to pick mode, or trigger saving a trimmed non-empty key. It returns true when it handled the key.

**Call relations**: `handle_key_event` gives this function first chance at every key. If it saves, it calls `save_api_key`; otherwise it schedules redraws after local edits.

*Call graph*: calls 3 internal fn (save_api_key, set_error, schedule_frame); called by 1 (handle_key_event).


##### `AuthModeWidget::handle_api_key_entry_paste`  (lines 746–768)

```
fn handle_api_key_entry_paste(&mut self, pasted: String) -> bool
```

**Purpose**: Adds pasted text to the API-key field when that field is active. This makes pasting long keys practical.

**Data flow**: It receives pasted text, trims surrounding whitespace, and ignores it if empty. If API-key entry is active, it replaces an environment-prefilled value or appends to existing typed text, clears errors, schedules a redraw, and returns true.

**Call relations**: `handle_paste` calls this for paste events from the onboarding screen.

*Call graph*: calls 2 internal fn (set_error, schedule_frame); called by 1 (handle_paste).


##### `AuthModeWidget::start_api_key_entry`  (lines 770–798)

```
fn start_api_key_entry(&mut self)
```

**Purpose**: Switches the auth screen into API-key entry mode. If an `OPENAI_API_KEY` environment variable is available, it pre-fills the field so the user can save or replace it.

**Data flow**: It first checks whether API login is allowed. If allowed, it clears errors, reads a possible API key from the environment, updates or creates the API-key entry state, and schedules a redraw.

**Call relations**: `handle_sign_in_option` calls this when the user chooses API-key login. It uses `disallow_api_login` if workspace rules forbid the path.

*Call graph*: calls 4 internal fn (disallow_api_login, is_api_login_allowed, set_error, schedule_frame); called by 1 (handle_sign_in_option); 2 external calls (read_openai_api_key_from_env, ApiKeyEntry).


##### `AuthModeWidget::save_api_key`  (lines 800–844)

```
fn save_api_key(&mut self, api_key: String)
```

**Purpose**: Sends the entered API key to the app server so it can be stored and used for future requests. It also updates the UI based on whether saving worked.

**Data flow**: It receives the API key text, checks that API login is allowed, clears errors, and starts a background app-server request. On success it marks API key configured; on unexpected response or error it restores the entry screen with the key still present and shows an error. It schedules redraws before and after the async work.

**Call relations**: `handle_api_key_entry_key_event` calls this after the user confirms a non-empty key. It uses `onboarding_request_id` for the server request and `disallow_api_login` if rules changed.

*Call graph*: calls 5 internal fn (disallow_api_login, is_api_login_allowed, set_error, onboarding_request_id, schedule_frame); called by 1 (handle_api_key_entry_key_event); 5 external calls (clone, format!, spawn, ApiKeyEntry, clone).


##### `AuthModeWidget::handle_existing_chatgpt_login`  (lines 846–857)

```
fn handle_existing_chatgpt_login(&mut self) -> bool
```

**Purpose**: Detects when the user is already signed in with a ChatGPT-compatible account. In that case, it skips starting a new login attempt.

**Data flow**: It reads `login_status`. If the status says there is already a ChatGPT account, it sets the state to ChatGPT success, schedules a redraw, and returns true. Otherwise it returns false.

**Call relations**: Both browser login and device-code login call this before starting. Tests verify that different ChatGPT credential types count as already signed in.

*Call graph*: calls 1 internal fn (schedule_frame); called by 2 (start_chatgpt_login, start_device_code_login); 1 external calls (matches!).


##### `AuthModeWidget::start_chatgpt_login`  (lines 860–904)

```
fn start_chatgpt_login(&mut self)
```

**Purpose**: Starts the normal ChatGPT browser sign-in flow. It asks the app server for a login URL, optionally opens the browser, and moves the UI into “continue in browser” mode.

**Data flow**: It first checks for an existing ChatGPT login. If none exists, it clears errors and sends a background login request to the app server. A successful ChatGPT response stores the login ID and auth URL; errors return the screen to pick mode with an error message.

**Call relations**: `handle_sign_in_option` calls this for ChatGPT login. It uses `maybe_open_auth_url_in_browser` after receiving the URL and `onboarding_request_id` for the request.

*Call graph*: calls 4 internal fn (handle_existing_chatgpt_login, set_error, maybe_open_auth_url_in_browser, onboarding_request_id); called by 1 (handle_sign_in_option); 5 external calls (clone, format!, spawn, ChatGptContinueInBrowser, clone).


##### `AuthModeWidget::start_device_code_login`  (lines 906–913)

```
fn start_device_code_login(&mut self)
```

**Purpose**: Starts the device-code version of ChatGPT login, intended for remote or headless machines where opening a browser is inconvenient.

**Data flow**: It first checks for an existing ChatGPT login. If none exists, it clears errors and hands the widget to the headless-login helper, which begins the device-code request and state updates.

**Call relations**: `handle_sign_in_option` calls this when the user chooses device-code login. The detailed flow is delegated to `headless_chatgpt_login::start_headless_chatgpt_login`.

*Call graph*: calls 3 internal fn (handle_existing_chatgpt_login, set_error, start_headless_chatgpt_login); called by 1 (handle_sign_in_option).


##### `AuthModeWidget::on_account_login_completed`  (lines 915–943)

```
fn on_account_login_completed(
        &mut self,
        notification: AccountLoginCompletedNotification,
    )
```

**Purpose**: Responds to an app-server notification that a ChatGPT login attempt finished. It only acts if the notification belongs to the login currently shown on this screen.

**Data flow**: It receives a completion notification, extracts the login ID, and compares it with the active browser or device-code login. If it matches, success moves to the ChatGPT success message; failure returns to pick mode and shows the server-provided error. It then schedules a redraw.

**Call relations**: The broader app event system calls this when login completion notifications arrive. It protects against stale or unrelated login notifications by matching the login ID.

*Call graph*: calls 2 internal fn (set_error, schedule_frame); 1 external calls (matches!).


##### `AuthModeWidget::on_account_updated`  (lines 945–950)

```
fn on_account_updated(&mut self, notification: AccountUpdatedNotification)
```

**Purpose**: Updates the widget’s remembered account status after the app server reports an account change.

**Data flow**: It receives an account-updated notification. If it contains an auth mode, it stores that as the current login status; otherwise it marks the user as not authenticated.

**Call relations**: The broader app event system calls this when account state changes, so later choices like “already signed in” use fresh information.


##### `AuthModeWidget::get_step_state`  (lines 954–964)

```
fn get_step_state(&self) -> StepState
```

**Purpose**: Tells the onboarding screen whether the auth step is still in progress or complete. The enclosing onboarding flow uses this to decide when it can move on.

**Data flow**: It reads the current sign-in state. Picker, entry, active login, and intermediate success-message states return in-progress; final ChatGPT success and API-key configured return complete.

**Call relations**: The onboarding screen calls this through the `StepStateProvider` trait. This file deliberately reports status but does not itself decide full onboarding completion.


##### `AuthModeWidget::render_ref`  (lines 968–993)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Chooses which auth screen to draw based on the current sign-in state. It is the central rendering switch for the widget.

**Data flow**: It reads the shared sign-in state and dispatches to the matching render function: picker, browser login, device-code login, success message, final success, API-key entry, or API-key configured. The chosen renderer writes into the terminal buffer.

**Call relations**: The terminal UI framework calls this when drawing the widget. It hands device-code rendering to the headless-login helper and uses local renderers for the other states.

*Call graph*: calls 7 internal fn (render_api_key_configured, render_api_key_entry, render_chatgpt_success, render_chatgpt_success_message, render_continue_in_browser, render_pick_mode, render_device_code_login).


##### `maybe_open_auth_url_in_browser`  (lines 996–1004)

```
fn maybe_open_auth_url_in_browser(request_handle: &AppServerRequestHandle, url: &str)
```

**Purpose**: Attempts to open the ChatGPT auth URL in the user’s browser when the app server is running in the same process. This avoids trying to launch a browser from remote server contexts.

**Data flow**: It receives the app-server request handle and URL. If the handle is not in-process, it returns without doing anything. Otherwise it asks the operating system to open the URL and logs a warning if that fails.

**Call relations**: `start_chatgpt_login` calls this after receiving a browser-login URL from the app server.

*Call graph*: called by 1 (start_chatgpt_login); 3 external calls (matches!, warn!, open).


##### `tests::widget_forced_chatgpt`  (lines 1023–1075)

```
async fn widget_forced_chatgpt() -> (AuthModeWidget, TempDir)
```

**Purpose**: Builds a test `AuthModeWidget` configured so only ChatGPT login is allowed. This gives tests a realistic widget without touching the user’s real configuration.

**Data flow**: It creates a temporary Codex home directory, builds test configuration, starts an in-process app server client, and returns a widget plus the temporary directory. The widget starts in pick mode with forced ChatGPT login.

**Call relations**: Most tests in this module call this helper to avoid repeating setup code.

*Call graph*: calls 5 internal fn (start, default, default_for_tests, new, test_dummy); 12 external calls (new, default, new, new, new, InProcess, default, cloud_config_bundle_loader_for_storage, default, from_value (+2 more)).


##### `tests::api_key_flow_disabled_when_chatgpt_forced`  (lines 1078–1091)

```
async fn api_key_flow_disabled_when_chatgpt_forced()
```

**Purpose**: Checks that starting API-key entry is blocked when the workspace forces ChatGPT login.

**Data flow**: It creates a forced-ChatGPT widget, tries to start API-key entry, then checks that the error message is the disabled message and the state remains pick mode.

**Call relations**: This test exercises `start_api_key_entry` and the disabled-login path.

*Call graph*: 3 external calls (assert!, assert_eq!, widget_forced_chatgpt).


##### `tests::saving_api_key_is_blocked_when_chatgpt_forced`  (lines 1094–1108)

```
async fn saving_api_key_is_blocked_when_chatgpt_forced()
```

**Purpose**: Checks that even a direct save attempt cannot bypass a forced ChatGPT-only setting.

**Data flow**: It creates a forced-ChatGPT widget, calls the API-key save function with a fake key, and verifies that the disabled message appears, the state returns to pick mode, and the login status stays unauthenticated.

**Call relations**: This test exercises the guard inside `save_api_key`.

*Call graph*: 3 external calls (assert!, assert_eq!, widget_forced_chatgpt).


##### `tests::existing_non_oauth_chatgpt_login_counts_as_signed_in`  (lines 1111–1127)

```
async fn existing_non_oauth_chatgpt_login_counts_as_signed_in()
```

**Purpose**: Checks that different ChatGPT-compatible credential types are treated as already signed in. This avoids forcing users through login again unnecessarily.

**Data flow**: For each tested auth mode, it creates a widget, sets the login status, calls the existing-login check, and verifies that the widget moves to ChatGPT success.

**Call relations**: This test exercises `handle_existing_chatgpt_login`, which is used before starting ChatGPT or device-code login.

*Call graph*: 4 external calls (assert!, assert_eq!, AuthMode, widget_forced_chatgpt).


##### `tests::cancel_active_attempt_resets_browser_login_state`  (lines 1130–1146)

```
async fn cancel_active_attempt_resets_browser_login_state()
```

**Purpose**: Checks that canceling a browser-login attempt clears the error and returns to the picker.

**Data flow**: It creates a widget, injects an active browser-login state and an error, calls cancel, and verifies that the error is gone and the state is pick mode.

**Call relations**: This test exercises `cancel_active_attempt` for the browser-login branch.

*Call graph*: 4 external calls (assert!, assert_eq!, ChatGptContinueInBrowser, widget_forced_chatgpt).


##### `tests::cancel_active_attempt_notifies_device_code_login`  (lines 1149–1167)

```
async fn cancel_active_attempt_notifies_device_code_login()
```

**Purpose**: Checks that canceling a device-code login resets the local UI state. It also covers the path where a device-code login has a login ID that can be canceled server-side.

**Data flow**: It creates a widget, sets a ready device-code state with a login ID and error, calls cancel, and verifies that the local error is cleared and the picker is restored.

**Call relations**: This test exercises `cancel_active_attempt` for the device-code branch and uses `ContinueWithDeviceCodeState::ready` to build the state.

*Call graph*: calls 1 internal fn (ready); 4 external calls (assert!, assert_eq!, ChatGptDeviceCode, widget_forced_chatgpt).


##### `tests::collect_osc8_chars`  (lines 1171–1186)

```
fn collect_osc8_chars(buf: &Buffer, area: Rect, url: &str) -> String
```

**Purpose**: Reads a test buffer and gathers the characters wrapped in a specific terminal hyperlink. This is a test helper for checking OSC 8 hyperlink rendering.

**Data flow**: It receives a buffer, area, and URL. It scans every cell in the area, looks for the hyperlink open and close escape sequences for that URL, and concatenates the visible characters found inside them.

**Call relations**: Hyperlink tests call this after rendering or manually marking a buffer to verify exactly which characters became clickable.

*Call graph*: 6 external calls (bottom, left, right, top, new, format!).


##### `tests::continue_in_browser_renders_osc8_hyperlink`  (lines 1189–1207)

```
fn continue_in_browser_renders_osc8_hyperlink()
```

**Purpose**: Checks that the browser-login screen marks the full auth URL as one terminal hyperlink, even when the URL wraps across lines.

**Data flow**: It creates a widget in browser-login state, renders into a narrow buffer, collects hyperlink-wrapped characters, and asserts that they equal the original URL.

**Call relations**: This test exercises `render_continue_in_browser`, which calls `mark_url_hyperlink` after drawing the URL.

*Call graph*: 7 external calls (empty, new, assert_eq!, new, ChatGptContinueInBrowser, collect_osc8_chars, widget_forced_chatgpt).


##### `tests::auth_widget_suppresses_animations_when_device_code_is_visible`  (lines 1210–1222)

```
fn auth_widget_suppresses_animations_when_device_code_is_visible()
```

**Purpose**: Checks that animations are suppressed when a ready device-code login is visible. This helps keep the copyable code and URL steady.

**Data flow**: It creates a widget, sets a ready device-code state, calls the animation-suppression query, and expects true.

**Call relations**: This test exercises `should_suppress_animations` with a state built by `ContinueWithDeviceCodeState::ready`.

*Call graph*: calls 1 internal fn (ready); 4 external calls (assert_eq!, new, ChatGptDeviceCode, widget_forced_chatgpt).


##### `tests::auth_widget_suppresses_animations_while_requesting_device_code`  (lines 1225–1233)

```
fn auth_widget_suppresses_animations_while_requesting_device_code()
```

**Purpose**: Checks that animations are also suppressed while the device-code request is still pending.

**Data flow**: It creates a widget, sets a pending device-code state, calls the animation-suppression query, and expects true.

**Call relations**: This test exercises `should_suppress_animations` with a state built by `ContinueWithDeviceCodeState::pending`.

*Call graph*: calls 1 internal fn (pending); 4 external calls (assert_eq!, new, ChatGptDeviceCode, widget_forced_chatgpt).


##### `tests::device_code_login_completion_advances_to_success_message`  (lines 1236–1256)

```
async fn device_code_login_completion_advances_to_success_message()
```

**Purpose**: Checks that a successful completion notification for the active device-code login advances the UI to the ChatGPT success message.

**Data flow**: It creates a widget in ready device-code state, sends a matching successful completion notification, and verifies that the sign-in state becomes the success-message state.

**Call relations**: This test exercises `on_account_login_completed` and its login-ID matching logic.

*Call graph*: calls 1 internal fn (ready); 3 external calls (assert!, ChatGptDeviceCode, widget_forced_chatgpt).


##### `tests::mark_url_hyperlink_wraps_cyan_underlined_cells`  (lines 1259–1282)

```
fn mark_url_hyperlink_wraps_cyan_underlined_cells()
```

**Purpose**: Checks that styled URL cells are wrapped in terminal hyperlink codes and unrelated cells are left alone.

**Data flow**: It creates a buffer, manually writes cyan underlined characters, leaves one plain character, calls `mark_url_hyperlink`, and verifies only the styled characters became hyperlink text.

**Call relations**: This test calls the local hyperlink wrapper directly and uses `collect_osc8_chars` to inspect the result.

*Call graph*: calls 1 internal fn (mark_url_hyperlink); 4 external calls (empty, new, assert_eq!, collect_osc8_chars).


##### `tests::mark_url_hyperlink_sanitizes_control_chars`  (lines 1285–1311)

```
fn mark_url_hyperlink_sanitizes_control_chars()
```

**Purpose**: Checks that unsafe control characters in a URL are removed before building terminal hyperlink escape sequences. This prevents a malicious URL from injecting terminal commands.

**Data flow**: It creates one styled buffer cell, passes a URL containing escape and bell control characters to `mark_url_hyperlink`, and verifies the stored symbol contains a sanitized URL but not the raw dangerous sequence.

**Call relations**: This test calls `mark_url_hyperlink` directly to validate the safety behavior provided by the shared hyperlink helper.

*Call graph*: calls 1 internal fn (mark_url_hyperlink); 3 external calls (empty, new, assert!).


### `tui/src/onboarding/trust_directory.rs`

`domain_logic` · `startup onboarding`

This screen is a safety checkpoint during startup. Before the app loads project-local settings, hooks, or execution rules, it asks whether the user trusts the files in the current directory. That matters because project files can influence what the app does, and untrusted files may contain malicious instructions, often called prompt injection: text designed to trick an AI or tool into doing something unsafe.

The main piece is `TrustDirectoryWidget`, which stores the current directory, the directory that will actually be trusted, the highlighted menu choice, any error message, and whether the user chose to quit. Its drawing code builds a simple terminal layout: it shows where the user is, warns if trust will apply to a Git repository root rather than the exact subdirectory, explains the risk, then displays two choices: “Yes, continue” and “No, quit.”

The keyboard code turns key presses into decisions. Arrow-like movement changes which choice is highlighted. Shortcut keys can immediately choose the first or second option. Confirming the highlighted option either records trust or marks the flow as quitting.

The file also includes tests that check important behavior: key release events are ignored, and the screen renders as expected with and without an error message.

#### Function details

##### `TrustDirectoryWidget::render_ref`  (lines 41–125)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the trust prompt into the terminal screen. It turns the widget’s stored state into visible text, warnings, choices, and optional error messages.

**Data flow**: It reads the widget’s current directory, trust target, highlighted option, Windows sandbox hint flag, and error text. From that, it builds a vertical column of terminal UI elements: location text, an optional Git-root warning, the trust explanation, the two selectable rows, any error, and the confirm-key hint. It writes the finished display into the terminal buffer for the given screen area.

**Call relations**: The terminal UI framework calls this when the onboarding screen needs to be painted. Inside, it uses shared rendering helpers to create rows, spacing, wrapping text, and insets, and it uses `selection_option_row` so the two choices look consistent with other selection lists.

*Call graph*: calls 3 internal fn (tlbr, new, selection_option_row); 4 external calls (from, new, format!, vec!).


##### `TrustDirectoryWidget::handle_key_event`  (lines 129–151)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Turns a keyboard event into a change on the trust screen. It lets the user move between choices, accept trust, or quit.

**Data flow**: It receives one key event. If the event is only a key release, it ignores it so the same physical key press is not counted twice. For movement keys, it changes the highlighted choice. For direct selection or confirm keys, it calls either the trust path or the quit path, which updates the widget’s stored decision.

**Call relations**: The onboarding screen calls this whenever the user presses a key. This function is the central dispatcher for keyboard behavior and hands the actual state changes to `TrustDirectoryWidget::handle_trust` or `TrustDirectoryWidget::handle_quit`.

*Call graph*: calls 2 internal fn (handle_quit, handle_trust).


##### `TrustDirectoryWidget::get_step_state`  (lines 155–161)

```
fn get_step_state(&self) -> StepState
```

**Purpose**: Reports whether this onboarding step is still waiting for the user or has finished. The surrounding onboarding flow uses this to know whether it can move on.

**Data flow**: It reads whether a trust selection has been recorded or whether quitting has been requested. If either is true, it returns `Complete`; otherwise it returns `InProgress`.

**Call relations**: The onboarding controller asks this while coordinating steps. It does not change anything itself; it simply summarizes the widget’s current state for the larger flow.


##### `TrustDirectoryWidget::handle_trust`  (lines 165–169)

```
fn handle_trust(&mut self)
```

**Purpose**: Records that the user chose to trust the directory. It also clears any previous error so the screen can proceed cleanly.

**Data flow**: It takes the existing widget state, sets the highlighted choice to `Trust`, removes any error message, and stores `Trust` as the selected answer. The result is that the step is now considered complete with a positive trust choice.

**Call relations**: `TrustDirectoryWidget::handle_key_event` calls this when the user chooses the trust option, either through a shortcut or by confirming while “Yes, continue” is highlighted.

*Call graph*: called by 1 (handle_key_event).


##### `TrustDirectoryWidget::handle_quit`  (lines 171–174)

```
fn handle_quit(&mut self)
```

**Purpose**: Records that the user chose not to continue. This is the safe exit path when the user does not want to trust the directory.

**Data flow**: It takes the existing widget state, moves the highlight to `Quit`, and sets the `should_quit` flag to true. After this, the surrounding app can see that onboarding should end by quitting rather than continuing.

**Call relations**: `TrustDirectoryWidget::handle_key_event` calls this when the user chooses “No, quit,” presses a quit key, presses a cancel key, or confirms while the quit option is highlighted.

*Call graph*: called by 1 (handle_key_event).


##### `TrustDirectoryWidget::should_quit`  (lines 176–178)

```
fn should_quit(&self) -> bool
```

**Purpose**: Answers whether the user has chosen to quit from this trust prompt. Other code can call it instead of reading the internal flag directly.

**Data flow**: It reads the widget’s `should_quit` field and returns that boolean value unchanged. It does not update the screen or modify any state.

**Call relations**: This is a small public accessor for the wider onboarding flow. After keyboard handling has possibly called `handle_quit`, other code can use this function to decide whether to stop the application.


##### `tests::widget`  (lines 194–204)

```
fn widget(error: Option<String>) -> TrustDirectoryWidget
```

**Purpose**: Builds a standard test version of `TrustDirectoryWidget`. It avoids repeating the same setup in every rendering test.

**Data flow**: It receives an optional error message. It creates a widget set to `/workspace/project`, with trust and current directory matching, the trust option highlighted, no quit request, and the supplied error. The completed widget is returned to the test.

**Call relations**: The snapshot tests call this helper before drawing the screen. It keeps those tests focused on what changes in the display rather than on boilerplate setup.

*Call graph*: 1 external calls (from).


##### `tests::release_event_does_not_change_selection`  (lines 207–228)

```
fn release_event_does_not_change_selection()
```

**Purpose**: Checks that key release events do not accidentally trigger a selection. This prevents one physical key press from being treated as multiple actions.

**Data flow**: It creates a widget with the quit option highlighted and no selection. It sends an Enter key release event and verifies that no selection was made. Then it sends a normal Enter key press and verifies that the widget switches into the quit state.

**Call relations**: This test exercises `TrustDirectoryWidget::handle_key_event`. It confirms the early return for release events and then confirms that an actual key press still reaches the normal quit behavior.

*Call graph*: 4 external calls (new, from, assert!, assert_eq!).


##### `tests::renders_snapshot_for_git_repo`  (lines 231–241)

```
fn renders_snapshot_for_git_repo()
```

**Purpose**: Checks that the normal trust prompt renders in the expected shape. A snapshot test compares the drawn terminal output against a saved reference image made of text.

**Data flow**: It builds a standard widget without an error, creates a fake terminal of a fixed size, asks the widget to render into it, and compares the final terminal contents with the saved snapshot. The test fails if the visible screen changes unexpectedly.

**Call relations**: This test calls the shared `tests::widget` helper and then invokes `TrustDirectoryWidget::render_ref` through the terminal drawing callback. It protects the user-facing layout from accidental changes.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_snapshot!, new, widget).


##### `tests::renders_snapshot_for_trust_error`  (lines 244–257)

```
fn renders_snapshot_for_trust_error()
```

**Purpose**: Checks that the trust prompt renders correctly when an error message is present. This matters because failure text can be long and must still be readable in the terminal.

**Data flow**: It builds a widget with a realistic trust-setting error, creates a fake terminal with enough height, renders the widget, and compares the output with a saved snapshot. The result is a pass or fail depending on whether the display matches the expected error layout.

**Call relations**: This test uses `tests::widget` to create the screen state and then exercises `TrustDirectoryWidget::render_ref`. It specifically covers the branch where the renderer shows red wrapped error text.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_snapshot!, new, widget).


### `tui/src/external_agent_config_migration.rs`

`orchestration` · `request handling`

This file is the control center for an interactive terminal screen. Its job is to turn a list of possible migration items into a clear choice for the user: import them, customize the list, or skip the import. Without it, the app could discover importable data but would have no safe, user-friendly way to ask permission before changing the user's Codex setup.

The screen has two main views. The summary view shows grouped choices, like a short receipt: what will be imported and whether each group is fully, partly, or not selected. The customize view is more like opening the receipt and checking individual lines. There, the user can move up and down, toggle items with the space bar, select all, select none, and go back.

The file keeps track of selection state, keyboard focus, the highlighted action button, scrolling, and the final answer. It also rewrites some technical migration wording into friendlier import wording, and shortens paths so they make sense relative to the current project. The top-level async function draws the screen, listens for terminal events, and stops when the user chooses an outcome.

#### Function details

##### `ActionMenuOption::label`  (lines 42–49)

```
fn label(self) -> &'static str
```

**Purpose**: Returns the human-readable text for each action button, such as importing selected items or cancelling. This keeps the menu wording in one place instead of scattering strings through the screen code.

**Data flow**: It receives one action option → matches it to the text the user should see → returns that text as a fixed string.

**Call relations**: This is the small vocabulary helper for the action menu. When the screen is drawn, the render code can ask each action what label should appear.


##### `run_external_agent_config_migration_prompt`  (lines 77–115)

```
async fn run_external_agent_config_migration_prompt(
    tui: &mut Tui,
    items: &[ExternalAgentConfigMigrationItem],
    selected_items: &[ExternalAgentConfigMigrationItem],
    error: Option<&str>
```

**Purpose**: Shows the migration prompt, keeps it updated while the user presses keys or the terminal resizes, and returns the user's final choice. This is the main doorway into this prompt from the rest of the app.

**Data flow**: It receives the terminal UI object, all possible items, the initially selected items, and an optional error message → builds a screen, draws it, listens to terminal events, and updates the screen state → returns either a list of items to import or a skip result.

**Call relations**: It is called by the higher-level migration prompt handler. It creates an ExternalAgentConfigMigrationScreen, asks the TUI to draw it, feeds keyboard events into handle_key, redraws on draw or resize events, and reads the screen outcome when the screen says it is done.

*Call graph*: calls 1 internal fn (new); called by 1 (handle_external_agent_config_migration_prompt); 4 external calls (draw, event_stream, frame_requester, pin!).


##### `ExternalAgentConfigMigrationScreen::proceed_enabled`  (lines 132–134)

```
fn proceed_enabled(&self) -> bool
```

**Purpose**: Answers whether the user is currently allowed to proceed with an import. Proceeding is only allowed when at least one item is selected.

**Data flow**: It reads the screen's item selections → counts how many are enabled → returns true if that count is greater than zero.

**Call relations**: available_actions asks this before deciding whether the “Import selected” action should be shown. That prevents an empty import from being chosen.

*Call graph*: calls 1 internal fn (selected_count); called by 1 (available_actions).


##### `ExternalAgentConfigMigrationScreen::first_available_action`  (lines 136–141)

```
fn first_available_action(&self) -> ActionMenuOption
```

**Purpose**: Finds the first action the user can choose right now. It is used when focus needs a safe place to land.

**Data flow**: It builds the current action list → takes the first entry if one exists → otherwise falls back to the Back action.

**Call relations**: When selection changes or the screen returns to summary mode, other navigation helpers use this to keep the highlighted button valid.

*Call graph*: calls 1 internal fn (available_actions); called by 3 (back_to_summary, move_down, normalize_highlighted_action).


##### `ExternalAgentConfigMigrationScreen::last_available_action`  (lines 143–148)

```
fn last_available_action(&self) -> ActionMenuOption
```

**Purpose**: Finds the last action the user can choose right now. It supports wraparound keyboard movement.

**Data flow**: It builds the current action list → takes the last entry if one exists → otherwise falls back to the Back action.

**Call relations**: move_up uses this when the user moves above the first action or leaves the item list toward the action area.

*Call graph*: calls 1 internal fn (available_actions); called by 1 (move_up).


##### `ExternalAgentConfigMigrationScreen::previous_available_action`  (lines 150–158)

```
fn previous_available_action(&self, action: ActionMenuOption) -> Option<ActionMenuOption>
```

**Purpose**: Finds the action immediately before a given action in the current menu. This lets the highlighted button move upward through the available choices.

**Data flow**: It builds the current action list → locates the current action → steps one position backward if possible → returns that earlier action or nothing.

**Call relations**: move_up calls this while navigating the action menu. If there is no earlier action, move_up decides whether to wrap around or move focus elsewhere.

*Call graph*: calls 1 internal fn (available_actions); called by 1 (move_up).


##### `ExternalAgentConfigMigrationScreen::next_available_action`  (lines 160–167)

```
fn next_available_action(&self, action: ActionMenuOption) -> Option<ActionMenuOption>
```

**Purpose**: Finds the action immediately after a given action in the current menu. This lets the highlighted button move downward through the available choices.

**Data flow**: It builds the current action list → locates the current action → steps one position forward if possible → returns that later action or nothing.

**Call relations**: move_down calls this while navigating the action menu. If there is no later action, move_down wraps or moves focus back to the item list.

*Call graph*: calls 1 internal fn (available_actions); called by 1 (move_down).


##### `ExternalAgentConfigMigrationScreen::available_actions`  (lines 169–181)

```
fn available_actions(&self) -> Vec<ActionMenuOption>
```

**Purpose**: Builds the list of action buttons that should exist in the current view. For example, it hides “Import selected” when nothing is selected.

**Data flow**: It reads the current view and selection state → chooses the valid actions for summary or customize mode → returns them in display order.

**Call relations**: Navigation, shortcuts, and highlight cleanup all depend on this function so they agree with what the user can actually see and choose.

*Call graph*: calls 1 internal fn (proceed_enabled); called by 6 (first_available_action, last_available_action, next_available_action, normalize_highlighted_action, previous_available_action, select_numbered_action); 2 external calls (new, vec!).


##### `ExternalAgentConfigMigrationScreen::normalize_highlighted_action`  (lines 183–187)

```
fn normalize_highlighted_action(&mut self)
```

**Purpose**: Makes sure the currently highlighted action is still valid. This matters when a selection change removes an action, such as hiding “Import selected” after all items are deselected.

**Data flow**: It reads the current highlighted action and the current valid action list → if the highlight is no longer allowed, replaces it with the first valid action → changes only the highlight.

**Call relations**: set_all_enabled and toggle_selected_item call this after changing selections, so the keyboard focus never points at a vanished button.

*Call graph*: calls 2 internal fn (available_actions, first_available_action); called by 2 (set_all_enabled, toggle_selected_item).


##### `ExternalAgentConfigMigrationScreen::display_description`  (lines 189–260)

```
fn display_description(item: &ExternalAgentConfigMigrationItem) -> String
```

**Purpose**: Turns a migration item's technical description into friendlier text for the terminal prompt. It also shortens file paths relative to a project when possible.

**Data flow**: It receives one migration item → changes wording from “Migrate” to “Import”, reformats known path patterns, and adds plugin counts when plugin details exist → returns the text shown to the user.

**Call relations**: The customize-line builder uses this when it creates the detail line under each item. It relies on display_path_for so paths are easier to read.

*Call graph*: 1 external calls (format!).


##### `ExternalAgentConfigMigrationScreen::new`  (lines 262–293)

```
fn new(
        request_frame: FrameRequester,
        items: &[ExternalAgentConfigMigrationItem],
        selected_items: &[ExternalAgentConfigMigrationItem],
        error: Option<String>,
    ) ->
```

**Purpose**: Creates a fresh migration prompt screen with its starting selections, grouped summary data, focus, and default outcome. This is the setup step before drawing or handling keys.

**Data flow**: It receives a frame requester, all items, initially selected items, and an optional error → groups the items, marks each item enabled or disabled, chooses initial focus and highlighted action → returns a ready-to-use screen.

**Call relations**: The top-level prompt runner and tests call this first. It uses the migration model helpers to build summary groups, then normalizes the highlighted action so the first draw starts in a valid state.

*Call graph*: calls 1 internal fn (external_agent_config_migration_groups); called by 12 (run_external_agent_config_migration_prompt, control_exit_shortcuts_cancel_prompt, customize_action_snapshot, customize_snapshot, empty_selection_enter_opens_customize_instead_of_proceeding, escape_skips_prompt, numeric_shortcuts_choose_actions, numeric_shortcuts_follow_visible_actions_when_proceed_is_disabled, proceed_returns_selected_items, prompt_snapshot (+2 more)); 1 external calls (iter).


##### `ExternalAgentConfigMigrationScreen::plugin_detail_lines`  (lines 295–327)

```
fn plugin_detail_lines(plugin_groups: &[PluginsMigration]) -> Vec<Line<'static>>
```

**Purpose**: Creates a short preview of plugin details for display under a plugin import item. It deliberately limits the list so the prompt does not become huge.

**Data flow**: It receives plugin groups grouped by marketplace → keeps at most three marketplaces and at most two plugin names per marketplace, adding “more” counts when needed → returns formatted terminal text lines.

**Call relations**: The customize view uses this when an item has plugin migration details. It turns nested plugin data into readable extra lines.

*Call graph*: 4 external calls (from, iter, len, format!).


##### `ExternalAgentConfigMigrationScreen::is_done`  (lines 329–331)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the prompt has finished. The event loop uses this as its stop condition.

**Data flow**: It reads the screen's done flag → returns that true-or-false value.

**Call relations**: run_external_agent_config_migration_prompt checks this repeatedly while waiting for events. finish_with is what eventually changes the flag.


##### `ExternalAgentConfigMigrationScreen::outcome`  (lines 333–335)

```
fn outcome(&self) -> ExternalAgentConfigMigrationOutcome
```

**Purpose**: Returns the final answer chosen by the user. The answer is either to proceed with selected items or skip.

**Data flow**: It reads the stored outcome → clones it so the caller can own the result → returns that copy.

**Call relations**: After the prompt loop ends, the runner calls this to hand the result back to the migration flow.

*Call graph*: 1 external calls (clone).


##### `ExternalAgentConfigMigrationScreen::finish_with`  (lines 337–341)

```
fn finish_with(&mut self, outcome: ExternalAgentConfigMigrationOutcome)
```

**Purpose**: Ends the prompt with a specific result. It is the shared finalization step for both importing and skipping.

**Data flow**: It receives an outcome → stores it, marks the screen done, and asks the terminal to redraw → leaves the screen ready for the outer loop to stop.

**Call relations**: proceed and skip both call this. The scheduled frame lets the UI catch up after the state changes.

*Call graph*: calls 1 internal fn (schedule_frame); called by 2 (proceed, skip).


##### `ExternalAgentConfigMigrationScreen::proceed`  (lines 343–346)

```
fn proceed(&mut self)
```

**Purpose**: Finishes the prompt by choosing to import the currently selected items. This is what happens when the user confirms the import action.

**Data flow**: It reads all enabled items → wraps them in a Proceed outcome → passes that outcome to finish_with.

**Call relations**: confirm_selection calls this when the highlighted action is Proceed. It hands final control to finish_with.

*Call graph*: calls 2 internal fn (finish_with, selected_items); called by 1 (confirm_selection); 1 external calls (Proceed).


##### `ExternalAgentConfigMigrationScreen::skip`  (lines 348–350)

```
fn skip(&mut self)
```

**Purpose**: Finishes the prompt by cancelling the import. This gives the user and the event loop a clean way to exit without changing selections further.

**Data flow**: It creates a Skip outcome → passes it to finish_with → the screen becomes done.

**Call relations**: confirm_selection calls this for the Cancel action, and handle_key calls it for escape or control-exit shortcuts.

*Call graph*: calls 1 internal fn (finish_with); called by 2 (confirm_selection, handle_key).


##### `ExternalAgentConfigMigrationScreen::selected_items`  (lines 352–358)

```
fn selected_items(&self) -> Vec<ExternalAgentConfigMigrationItem>
```

**Purpose**: Collects the migration items that are currently enabled. This is the final shopping basket used when the user imports.

**Data flow**: It scans the screen's item list → keeps only enabled entries → clones and returns the underlying migration items.

**Call relations**: proceed calls this just before finishing, so the outcome contains exactly what the user left selected.

*Call graph*: called by 1 (proceed).


##### `ExternalAgentConfigMigrationScreen::selected_count`  (lines 360–362)

```
fn selected_count(&self) -> usize
```

**Purpose**: Counts how many items are currently selected. This is used to decide whether importing is possible.

**Data flow**: It scans all item selections → counts the enabled ones → returns the number.

**Call relations**: proceed_enabled calls this, and available_actions uses that result to show or hide the Proceed action.

*Call graph*: called by 1 (proceed_enabled).


##### `ExternalAgentConfigMigrationScreen::group_selection_marker`  (lines 364–378)

```
fn group_selection_marker(
        &self,
        group: &ExternalAgentConfigMigrationGroupModel,
    ) -> &'static str
```

**Purpose**: Chooses the checkbox marker for a summary group. It can show empty, checked, or partly checked.

**Data flow**: It receives a group → checks how many items in that group are enabled → returns a marker: blank for none, x for all, or dash for some.

**Call relations**: The summary-line builder uses this to make grouped selection status easy to understand at a glance.


##### `ExternalAgentConfigMigrationScreen::set_all_enabled`  (lines 380–387)

```
fn set_all_enabled(&mut self, enabled: bool)
```

**Purpose**: Turns every migration item on or off at once. This powers the “select all” and “select none” keyboard shortcuts in customize mode.

**Data flow**: It receives a desired enabled value → applies it to every item, clears any error, fixes the highlighted action, and requests a redraw → the whole selection changes together.

**Call relations**: handle_key calls this for the customize shortcuts. After changing the list, it uses normalize_highlighted_action so the action menu stays consistent.

*Call graph*: calls 2 internal fn (normalize_highlighted_action, schedule_frame); called by 1 (handle_key).


##### `ExternalAgentConfigMigrationScreen::toggle_selected_item`  (lines 389–403)

```
fn toggle_selected_item(&mut self)
```

**Purpose**: Flips the enabled state of the currently highlighted item. It only works in the customize view while focus is on the item list.

**Data flow**: It checks the view, focus, and selected item index → if an item is actually selected, switches it from on to off or off to on, clears errors, fixes the action highlight, and requests a redraw.

**Call relations**: confirm_selection calls this when Enter is pressed on an item, and handle_key calls it for the space bar in customize mode.

*Call graph*: calls 2 internal fn (normalize_highlighted_action, schedule_frame); called by 2 (confirm_selection, handle_key).


##### `ExternalAgentConfigMigrationScreen::customize`  (lines 405–412)

```
fn customize(&mut self)
```

**Purpose**: Switches from the summary view into the detailed customize view. It sets focus to the item list so the user can immediately review individual choices.

**Data flow**: It changes the view, selects the first item if there is one, resets scrolling, moves focus to items, highlights Back as the available action, and requests a redraw.

**Call relations**: confirm_selection calls this when the user chooses Customize, and handle_key calls it for the summary shortcut.

*Call graph*: calls 1 internal fn (schedule_frame); called by 2 (confirm_selection, handle_key).


##### `ExternalAgentConfigMigrationScreen::back_to_summary`  (lines 414–421)

```
fn back_to_summary(&mut self)
```

**Purpose**: Returns from the detailed customize view to the shorter summary view. It resets navigation so the action menu is ready again.

**Data flow**: It changes the view to summary, selects the first group if there is one, resets scrolling, moves focus to actions, picks the first valid action, and requests a redraw.

**Call relations**: confirm_selection calls this for the Back action, and handle_key calls it for the customize shortcut or Escape.

*Call graph*: calls 2 internal fn (first_available_action, schedule_frame); called by 2 (confirm_selection, handle_key).


##### `ExternalAgentConfigMigrationScreen::move_up`  (lines 423–459)

```
fn move_up(&mut self)
```

**Purpose**: Moves the keyboard focus upward. Depending on the current view, this can move between action buttons, move through items, or jump between the item list and actions.

**Data flow**: It reads the current view, focus, selected item, and highlighted action → updates them to the previous logical place, wrapping when appropriate → keeps the selected item visible and requests a redraw.

**Call relations**: handle_key calls this for Up or k. It uses the action-navigation helpers and ensure_selected_item_visible so movement and scrolling stay in sync.

*Call graph*: calls 4 internal fn (ensure_selected_item_visible, last_available_action, previous_available_action, schedule_frame); called by 1 (handle_key).


##### `ExternalAgentConfigMigrationScreen::move_down`  (lines 461–493)

```
fn move_down(&mut self)
```

**Purpose**: Moves the keyboard focus downward. It mirrors move_up for Down or j navigation.

**Data flow**: It reads the current view, focus, selected item, and highlighted action → updates them to the next logical place, wrapping when appropriate → keeps the selected item visible and requests a redraw.

**Call relations**: handle_key calls this for Down or j. It uses next and first action helpers plus ensure_selected_item_visible.

*Call graph*: calls 4 internal fn (ensure_selected_item_visible, first_available_action, next_available_action, schedule_frame); called by 1 (handle_key).


##### `ExternalAgentConfigMigrationScreen::confirm_selection`  (lines 495–505)

```
fn confirm_selection(&mut self)
```

**Purpose**: Performs the action represented by the current focus. Enter either toggles an item or activates the highlighted action button.

**Data flow**: It checks whether focus is on items or actions → toggles the item if on items, or dispatches to proceed, customize, skip, or back_to_summary if on actions → updates the screen or finishes the prompt.

**Call relations**: handle_key calls this for Enter, and select_numbered_action calls it after moving the highlight to a numbered action.

*Call graph*: calls 5 internal fn (back_to_summary, customize, proceed, skip, toggle_selected_item); called by 2 (handle_key, select_numbered_action).


##### `ExternalAgentConfigMigrationScreen::handle_key`  (lines 507–538)

```
fn handle_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Translates raw key presses into screen behavior. This is where keyboard controls become navigation, selection changes, view changes, or cancellation.

**Data flow**: It receives a key event → ignores key-release events, checks control-exit shortcuts, then matches the key code to the correct screen operation → changes state and often schedules a redraw through the called operation.

**Call relations**: The top-level prompt runner feeds all terminal key events here. This function delegates almost everything to smaller helpers such as move_up, move_down, customize, set_all_enabled, and confirm_selection.

*Call graph*: calls 10 internal fn (back_to_summary, confirm_selection, customize, move_down, move_up, select_numbered_action, set_all_enabled, skip, toggle_selected_item, is_ctrl_exit_combo).


##### `ExternalAgentConfigMigrationScreen::select_numbered_action`  (lines 540–550)

```
fn select_numbered_action(&mut self, number: char)
```

**Purpose**: Lets number keys choose visible action buttons. For example, pressing 1 activates the first currently available action.

**Data flow**: It receives a digit character → converts it to a zero-based menu index, looks up that action, moves focus and highlight to it, then confirms it → may change view or finish the prompt.

**Call relations**: handle_key calls this for number keys. It uses available_actions so shortcuts always match the actions currently visible to the user.

*Call graph*: calls 2 internal fn (available_actions, confirm_selection); called by 1 (handle_key).


##### `ExternalAgentConfigMigrationScreen::ensure_selected_item_visible`  (lines 552–567)

```
fn ensure_selected_item_visible(&mut self)
```

**Purpose**: Adjusts scrolling so the currently selected item stays on screen. It is like keeping the cursor inside the visible window.

**Data flow**: It reads the selected item and current scroll position → finds where that item appears in the rendered line list → moves scroll_top up or down if needed.

**Call relations**: move_up and move_down call this after changing selection. It uses render_line_count and selected_render_line_index to reason in terms of visible lines, not just items.

*Call graph*: calls 2 internal fn (render_line_count, selected_render_line_index); called by 2 (move_down, move_up).


##### `ExternalAgentConfigMigrationScreen::render_line_count`  (lines 569–571)

```
fn render_line_count(&self) -> usize
```

**Purpose**: Counts how many text lines the current view would render. This supports scroll calculations.

**Data flow**: It builds the render-line list for the current view → returns the number of lines.

**Call relations**: ensure_selected_item_visible calls this when it decides how much content can be scrolled through.

*Call graph*: calls 1 internal fn (build_render_lines); called by 1 (ensure_selected_item_visible).


##### `ExternalAgentConfigMigrationScreen::selected_render_line_index`  (lines 573–578)

```
fn selected_render_line_index(&self, selected_item_idx: usize) -> usize
```

**Purpose**: Finds the rendered line that corresponds to a selected item. This bridges item selection and the actual text layout.

**Data flow**: It receives an item index → builds the current render-line list, searches for the line tied to that item, and returns the line position → falls back to the item index if not found.

**Call relations**: ensure_selected_item_visible calls this to know whether the selected item is above or below the visible area.

*Call graph*: calls 1 internal fn (build_render_lines); called by 1 (ensure_selected_item_visible).


##### `ExternalAgentConfigMigrationScreen::section_title`  (lines 580–588)

```
fn section_title(cwd: Option<&std::path::Path>) -> Line<'static>
```

**Purpose**: Creates the heading used to separate home-level items from project-specific items in the customize view.

**Data flow**: It receives an optional current working directory path → returns a styled line saying either “Current project” with the path or “Home”.

**Call relations**: build_customize_render_lines calls this whenever it starts a new item scope.

*Call graph*: 2 external calls (from, vec!).


##### `ExternalAgentConfigMigrationScreen::build_render_lines`  (lines 590–595)

```
fn build_render_lines(&self) -> Vec<RenderLineEntry>
```

**Purpose**: Builds the text-line model for whichever view is active. This gives scrolling and rendering a common source of truth.

**Data flow**: It reads the current view → delegates to the summary or customize line builder → returns the list of render-line entries.

**Call relations**: render_line_count and selected_render_line_index call this when they need to understand the current screen layout.

*Call graph*: calls 2 internal fn (build_customize_render_lines, build_summary_render_lines); called by 2 (render_line_count, selected_render_line_index).


##### `ExternalAgentConfigMigrationScreen::build_summary_render_lines`  (lines 597–620)

```
fn build_summary_render_lines(&self) -> Vec<RenderLineEntry>
```

**Purpose**: Creates the compact summary text lines. Each group gets a checkbox-style status line and a description line.

**Data flow**: It reads the grouped migration data and current selections → builds display entries for each group, including selection markers → returns the list of summary lines.

**Call relations**: build_render_lines calls this when the screen is in summary view. The render module can then draw these entries.

*Call graph*: called by 1 (build_render_lines).


##### `ExternalAgentConfigMigrationScreen::build_customize_render_lines`  (lines 622–678)

```
fn build_customize_render_lines(&self) -> Vec<RenderLineEntry>
```

**Purpose**: Creates the detailed item-by-item text lines for the customize view. It includes section headings, checkboxes, descriptions, optional extra details, and plugin previews.

**Data flow**: It scans every migration item in order → inserts a new section when the project scope changes, adds the item label and description, adds model-provided details and plugin lines when present → returns the full customize layout.

**Call relations**: build_render_lines calls this in customize mode. It works with item-label/detail helpers, section_title, display_description, and plugin_detail_lines to make raw migration data readable.

*Call graph*: calls 1 internal fn (external_agent_config_migration_item_detail); called by 1 (build_render_lines); 6 external calls (from, plugin_detail_lines, section_title, new, format!, vec!).


##### `is_ctrl_exit_combo`  (lines 681–684)

```
fn is_ctrl_exit_combo(key_event: KeyEvent) -> bool
```

**Purpose**: Detects terminal-style exit shortcuts: Control-C and Control-D. These should cancel the prompt quickly.

**Data flow**: It receives a key event → checks whether the key is c or d and whether the Control modifier is held → returns true or false.

**Call relations**: handle_key calls this before normal key handling. If it returns true, the screen skips the prompt.

*Call graph*: called by 1 (handle_key); 1 external calls (matches!).


##### `tests::sample_plugin_details`  (lines 706–732)

```
fn sample_plugin_details() -> codex_app_server_protocol::MigrationDetails
```

**Purpose**: Builds realistic plugin migration details for tests. The sample includes enough marketplaces and plugin names to test truncation and “more” text.

**Data flow**: It creates several plugin marketplace groups with plugin names → wraps them in a migration details structure → returns that test data.

**Call relations**: sample_items uses this to attach plugin details to a sample plugin migration item.

*Call graph*: 2 external calls (default, vec!).


##### `tests::sample_project_root`  (lines 740–742)

```
fn sample_project_root() -> PathBuf
```

**Purpose**: Provides a platform-appropriate sample project path for tests. It returns a Windows path on Windows and a Unix-style path elsewhere.

**Data flow**: It checks the compile-time operating system configuration → creates the matching path buffer → returns it.

**Call relations**: sample_project_path and sample_items use this so snapshots match the operating system's path style.

*Call graph*: 1 external calls (from).


##### `tests::sample_project_path`  (lines 744–746)

```
fn sample_project_path(path: &str) -> String
```

**Purpose**: Builds a sample path inside the fake project root. This keeps test paths consistent.

**Data flow**: It receives a relative path string → joins it to the sample project root → returns it as display text.

**Call relations**: sample_items calls this when building item descriptions that contain project-local files.

*Call graph*: 1 external calls (sample_project_root).


##### `tests::sample_items`  (lines 748–792)

```
fn sample_items() -> Vec<ExternalAgentConfigMigrationItem>
```

**Purpose**: Creates a representative set of migration items for tests. The items cover global config, sessions, plugins, and project instructions.

**Data flow**: It builds paths and detail structures → creates several ExternalAgentConfigMigrationItem values with different types and scopes → returns them in a vector.

**Call relations**: Nearly all tests call this to start from the same realistic prompt data.

*Call graph*: 2 external calls (sample_project_root, vec!).


##### `tests::render_screen`  (lines 794–814)

```
fn render_screen(
        screen: &ExternalAgentConfigMigrationScreen,
        width: u16,
        height: u16,
    ) -> String
```

**Purpose**: Renders a screen into plain text for snapshot tests. This lets tests compare what the terminal would show without needing a real terminal window.

**Data flow**: It receives a screen plus width and height → creates a fake VT100 terminal backend, renders the widget, flushes the terminal, trims line endings → returns the visible screen as a string.

**Call relations**: The snapshot tests call this after constructing or changing a screen, then compare the result to stored snapshots.

*Call graph*: calls 2 internal fn (with_options, new); 1 external calls (new).


##### `tests::prompt_snapshot`  (lines 817–831)

```
fn prompt_snapshot()
```

**Purpose**: Checks that the default summary prompt looks as expected. This protects the user-facing layout from accidental changes.

**Data flow**: It creates sample items and a new screen with all items selected → renders it at a fixed terminal size → compares the text to the appropriate stored snapshot.

**Call relations**: This test exercises ExternalAgentConfigMigrationScreen::new and render_screen in the starting summary state.

*Call graph*: calls 2 internal fn (new, test_dummy); 3 external calls (assert_snapshot!, render_screen, sample_items).


##### `tests::customize_snapshot`  (lines 834–852)

```
fn customize_snapshot()
```

**Purpose**: Checks that the customize view looks as expected. It verifies the detailed item list and extra details.

**Data flow**: It creates a screen, switches it to customize mode, renders it, and compares the output to a stored snapshot.

**Call relations**: This test uses the screen's customize method and render_screen to cover the detailed view.

*Call graph*: calls 2 internal fn (new, test_dummy); 3 external calls (assert_snapshot!, render_screen, sample_items).


##### `tests::customize_action_snapshot`  (lines 855–874)

```
fn customize_action_snapshot()
```

**Purpose**: Checks the customize view when focus is on the action area instead of the item list. This protects the visual highlight behavior.

**Data flow**: It creates a screen, enters customize mode, moves focus upward to the action button, renders, and compares the output to a snapshot.

**Call relations**: This test exercises customize, move_up, and render_screen together.

*Call graph*: calls 2 internal fn (new, test_dummy); 3 external calls (assert_snapshot!, render_screen, sample_items).


##### `tests::proceed_returns_selected_items`  (lines 877–893)

```
fn proceed_returns_selected_items()
```

**Purpose**: Verifies that pressing Enter on the default prompt proceeds with all selected items. This confirms the happy path.

**Data flow**: It creates a screen with all items selected → sends an Enter key event → checks that the screen is done and that the outcome contains all items.

**Call relations**: This test drives handle_key, which reaches confirm_selection and proceed.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (new, assert!, assert_eq!, sample_items).


##### `tests::toggle_item_then_proceed_keeps_remaining_selection`  (lines 896–919)

```
fn toggle_item_then_proceed_keeps_remaining_selection()
```

**Purpose**: Verifies that deselecting one item in customize mode affects the final import list. This ensures user customization is honored.

**Data flow**: It creates a selected screen → enters customize mode, toggles the first item off, returns to summary, chooses the first action → checks that the outcome excludes only that item.

**Call relations**: This test exercises handle_key paths for customize, toggle_selected_item, back_to_summary, numeric action selection, and proceed.

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (Char, new, assert!, assert_eq!, sample_items).


##### `tests::escape_skips_prompt`  (lines 922–935)

```
fn escape_skips_prompt()
```

**Purpose**: Verifies that Escape cancels the prompt from the summary view. This protects an expected terminal escape behavior.

**Data flow**: It creates a screen → sends an Escape key event → checks that the screen is done with a Skip outcome.

**Call relations**: This test drives handle_key into the skip path.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (new, assert!, assert_eq!, sample_items).


##### `tests::numeric_shortcuts_follow_visible_actions_when_proceed_is_disabled`  (lines 938–953)

```
fn numeric_shortcuts_follow_visible_actions_when_proceed_is_disabled()
```

**Purpose**: Verifies that number shortcuts match the currently visible actions when importing is not allowed. This prevents shortcut numbers from activating hidden buttons.

**Data flow**: It creates a screen, enters customize mode, deselects all items, returns to summary, then presses 1 → checks that this opens customize instead of proceeding.

**Call relations**: This test covers set_all_enabled, back_to_summary, available_actions, and select_numbered_action through handle_key.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (Char, new, assert_eq!, sample_items).


##### `tests::empty_selection_enter_opens_customize_instead_of_proceeding`  (lines 956–969)

```
fn empty_selection_enter_opens_customize_instead_of_proceeding()
```

**Purpose**: Verifies that Enter does not proceed when no items are initially selected. Instead, the first available action is to customize.

**Data flow**: It creates a screen with no selected items → sends Enter → checks that the prompt is still open and now in customize view.

**Call relations**: This test depends on new normalizing the highlighted action and handle_key confirming the visible Customize action.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (new, assert!, assert_eq!, sample_items).


##### `tests::control_exit_shortcuts_cancel_prompt`  (lines 972–987)

```
fn control_exit_shortcuts_cancel_prompt()
```

**Purpose**: Verifies that Control-C and Control-D cancel the prompt. These are common terminal shortcuts for stopping or exiting.

**Data flow**: For each shortcut, it creates a fresh screen → sends the control key event → checks that the screen is done with Skip.

**Call relations**: This test covers is_ctrl_exit_combo through handle_key.

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (Char, new, assert!, assert_eq!, sample_items).


##### `tests::numeric_shortcuts_choose_actions`  (lines 990–1027)

```
fn numeric_shortcuts_choose_actions()
```

**Purpose**: Verifies that number keys activate Proceed, Customize, Back, and Skip in the expected positions. This protects keyboard-only use of the prompt.

**Data flow**: It creates separate screens for each shortcut scenario → sends number key events → checks the resulting outcome or view.

**Call relations**: This test drives select_numbered_action through handle_key and confirms it uses available_actions correctly.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (Char, new, assert_eq!, sample_items).


##### `tests::summary_does_not_toggle_selection`  (lines 1030–1042)

```
fn summary_does_not_toggle_selection()
```

**Purpose**: Verifies that pressing space in the summary view does not change item selection. Toggling is only allowed in customize mode.

**Data flow**: It creates a fully selected screen → sends a space key event → checks that selected_items still returns all sample items.

**Call relations**: This test exercises handle_key's summary behavior and protects the guard inside toggle_selected_item from being bypassed.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (Char, new, assert_eq!, sample_items).


### `tui/src/external_agent_config_migration/render.rs`

`other` · `screen rendering during the terminal UI main loop`

This file is the display layer for the external agent configuration migration screen. In plain terms, it is responsible for painting the “Import from Claude Code” flow in the terminal. Without it, the migration logic might still know what items exist and what is selected, but the user would not see a usable screen or know which keys to press.

The screen is built like a small form. At the top it shows a title and a few explanatory lines. If something went wrong, it shows a red error line. In the middle it shows the importable items, keeping the currently selected item visible even when the list is taller than the available space. At the bottom it shows available actions, such as continuing or customizing, and a footer with keyboard shortcuts.

The file also pays attention to small but important terminal details. It clears the drawing area before repainting, adds margins, splits the screen into sections, dims text that is less active, highlights the focused choice in cyan and bold, and shortens long lines with an ellipsis so they do not spill past the edge. The result is similar to a well-laid-out paper form: the state may change elsewhere, but this file decides how that state is presented to the person using the app.

#### Function details

##### `ExternalAgentConfigMigrationScreen::render_items`  (lines 18–70)

```
fn render_items(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the scrollable list of migration items inside a given rectangle of the terminal. It makes sure the selected item stays visible and visually marks the current choice so the user can tell where they are.

**Data flow**: It receives a screen area and a mutable terminal buffer, then reads the screen’s prepared render lines, current scroll position, selected item, and focus state. It chooses which rows fit, adjusts the starting row if the selected item would otherwise be off-screen, styles selected rows brightly, dims non-item helper rows, trims overly long lines with an ellipsis, and writes each visible row into the buffer. It does not return a value; the visible terminal buffer is the result.

**Call relations**: This is the list-painting helper used by ExternalAgentConfigMigrationScreen::render_ref when the full screen is being drawn. It delegates only the final safety step for too-long text to truncate_line_with_ellipsis_if_overflow, so the list stays inside its assigned space.

*Call graph*: calls 1 internal fn (truncate_line_with_ellipsis_if_overflow); called by 1 (render_ref).


##### `ExternalAgentConfigMigrationScreen::render_ref`  (lines 74–205)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the whole migration screen: title, introduction, error message, item list, action choices, and footer key hints. This is the main rendering entry used when the terminal UI asks this screen to paint itself.

**Data flow**: It receives the outer terminal area and a mutable buffer. It clears the area, adds padding, decides which introduction and title to show based on the current view, measures how much space each section needs, splits the screen into rectangles, and renders each section into its rectangle. It reads the current error, list contents, selected count, available actions, focus area, highlighted action, and view mode. The output is a fully updated terminal buffer ready to be displayed.

**Call relations**: The terminal UI rendering system calls this through the WidgetRef interface, which means the screen can be drawn like a standard terminal widget. During that draw, it calls render_items for the central item list, uses layout helpers to divide the screen, uses selection_option_row_with_dim to draw action rows consistently, and uses key_hint helpers so shortcut labels look like the rest of the app.

*Call graph*: calls 3 internal fn (render_items, vh, selection_option_row_with_dim); 10 external calls (Fill, Length, vertical, from, new, inset, format!, repeat_n, from, vec!).


### `tui/src/model_migration.rs`

`domain_logic` · `startup or model-selection prompt`

When Codex wants to recommend a new model, it needs to ask without disrupting the rest of the terminal session. This file is that small interactive screen. It prepares the words the user sees, either as simple formatted lines or as markdown text, then draws them in the terminal user interface. If the user is allowed to opt out, it shows a two-choice menu: try the new model or keep the existing one. If opting out is not allowed, it shows an informational prompt and treats Enter or Escape as continuing.

The screen behaves like a short checkout counter: it presents the offer, lets the user move the highlight with arrow keys or vim-style keys, and records the final decision. Ctrl-C and Ctrl-D are treated as leaving the prompt, while Escape is intentionally not a hard exit; in this screen it confirms the current/default choice.

The prompt is drawn on the terminal's alternate screen, which is a temporary full-screen area. That matters because it prevents a large prompt from being left behind in normal scrollback after the user answers. The file also contains snapshot-style tests that render the screen into a fake terminal and compare the result, so layout changes are caught.

#### Function details

##### `MigrationMenuOption::all`  (lines 48–50)

```
fn all() -> [Self; 2]
```

**Purpose**: Returns the two choices that can appear in the migration menu. It gives the renderer a fixed, ordered list so the menu is always shown consistently.

**Data flow**: Nothing is passed in. The function creates a small two-item array containing the new-model choice followed by the existing-model choice. That array is returned for menu drawing.

**Call relations**: When the screen draws the menu, render_menu asks this function for the available choices, then turns each one into a visible row.

*Call graph*: called by 1 (render_menu).


##### `MigrationMenuOption::label`  (lines 52–57)

```
fn label(self) -> &'static str
```

**Purpose**: Turns one internal menu choice into the text the user sees. This keeps the display wording in one place instead of scattering strings through the drawing code.

**Data flow**: It receives a menu option value. It matches that value to either "Try new model" or "Use existing model". The matching text is returned.

**Call relations**: The menu renderer uses this when building each row, so the internal choice and the visible label stay connected.


##### `migration_copy_for_models`  (lines 61–135)

```
fn migration_copy_for_models(
    current_model: &str,
    target_model: &str,
    model_link: Option<String>,
    migration_copy: Option<String>,
    migration_markdown: Option<String>,
    target_di
```

**Purpose**: Builds the message content for the migration prompt from model names, optional marketing copy, links, markdown, and opt-out rules. It is the main place where raw model information becomes user-facing text.

**Data flow**: Inputs include the current model, target model, optional link, optional custom copy, optional markdown template, display name, description, and whether the user may opt out. If markdown is supplied, it fills in the model placeholders and returns markdown-only prompt content. Otherwise it creates a heading, explanatory lines, optional learn-more link text, and either opt-out wording or a simple continue instruction. The result is a ModelMigrationCopy object used by the screen.

**Call relations**: The runtime prompt receives this prepared copy before drawing. The tests also call it to build realistic prompt examples and check how they render.

*Call graph*: calls 1 internal fn (fill_migration_markdown); called by 6 (escape_key_accepts_prompt, prompt_snapshot, prompt_snapshot_gpt5_codex, prompt_snapshot_gpt5_codex_mini, prompt_snapshot_gpt5_family, selecting_use_existing_model_rejects_upgrade); 5 external calls (from, from, new, format!, vec!).


##### `run_model_migration_prompt`  (lines 137–169)

```
async fn run_model_migration_prompt(
    tui: &mut Tui,
    copy: ModelMigrationCopy,
) -> ModelMigrationOutcome
```

**Purpose**: Runs the whole interactive prompt and returns the final outcome: accepted, rejected, or exit. This is the function other code can call when it needs to ask the user about a model migration.

**Data flow**: It receives the terminal interface and the prepared prompt copy. It enters the alternate screen, creates a ModelMigrationScreen, draws it, then listens for terminal events such as key presses, redraw requests, and resize events. It updates or redraws the screen until the screen says it is done, then returns the recorded outcome.

**Call relations**: This function wires the prompt together. It uses AltScreenGuard::enter to protect the terminal, creates the screen with ModelMigrationScreen::new, sends key events into ModelMigrationScreen::handle_key, and reads ModelMigrationScreen::outcome at the end.

*Call graph*: calls 2 internal fn (enter, new); 1 external calls (pin!).


##### `ModelMigrationScreen::new`  (lines 180–188)

```
fn new(request_frame: FrameRequester, copy: ModelMigrationCopy) -> Self
```

**Purpose**: Creates the in-memory state for a migration prompt screen. It starts with the new-model option highlighted and assumes acceptance unless the user chooses otherwise.

**Data flow**: It receives a frame requester, which can ask the terminal to redraw, and the prompt copy to display. It stores those, marks the screen as not finished, sets the outcome to accepted, and highlights "Try new model". The initialized screen is returned.

**Call relations**: The prompt runner calls this before the event loop starts. The tests also use it to create screens that can be rendered or fed key presses without running the full terminal loop.

*Call graph*: called by 8 (run_model_migration_prompt, escape_key_accepts_prompt, markdown_prompt_keeps_long_url_tail_visible_when_narrow, prompt_snapshot, prompt_snapshot_gpt5_codex, prompt_snapshot_gpt5_codex_mini, prompt_snapshot_gpt5_family, selecting_use_existing_model_rejects_upgrade).


##### `ModelMigrationScreen::finish_with`  (lines 190–194)

```
fn finish_with(&mut self, outcome: ModelMigrationOutcome)
```

**Purpose**: Marks the prompt as finished with a specific result. It also asks for one more redraw so the terminal can reflect the changed state if needed.

**Data flow**: It receives the desired outcome. It writes that outcome into the screen, flips the done flag to true, and calls the frame requester to schedule a redraw. It does not return a separate value.

**Call relations**: The simpler accept, reject, and exit methods all use this shared finishing step, so every ending path updates the state in the same way.

*Call graph*: calls 1 internal fn (schedule_frame); called by 3 (accept, exit, reject).


##### `ModelMigrationScreen::accept`  (lines 196–198)

```
fn accept(&mut self)
```

**Purpose**: Finishes the prompt as accepted, meaning Codex should proceed with the new model or continue when no opt-out is offered.

**Data flow**: It reads no external data beyond the screen itself. It sets the final outcome to Accepted through finish_with and marks the screen done. Nothing is returned.

**Call relations**: It is used when the highlighted option is the new model, when a non-optional prompt is confirmed, and when menu shortcuts choose the new model.

*Call graph*: calls 1 internal fn (finish_with); called by 3 (confirm_selection, handle_key, handle_menu_key).


##### `ModelMigrationScreen::reject`  (lines 200–202)

```
fn reject(&mut self)
```

**Purpose**: Finishes the prompt as rejected, meaning the user chose to keep the existing model. This is only reachable when opting out is allowed.

**Data flow**: It changes the screen outcome to Rejected through finish_with and marks the prompt done. It returns nothing.

**Call relations**: confirm_selection calls this when the existing-model option is highlighted. handle_menu_key also calls it directly for the numeric shortcut that chooses the second option.

*Call graph*: calls 1 internal fn (finish_with); called by 2 (confirm_selection, handle_menu_key).


##### `ModelMigrationScreen::exit`  (lines 204–206)

```
fn exit(&mut self)
```

**Purpose**: Finishes the prompt as an exit rather than as a model choice. This represents the user pressing a control-key combination such as Ctrl-C or Ctrl-D.

**Data flow**: It changes the stored outcome to Exit through finish_with and marks the screen done. It returns nothing.

**Call relations**: handle_key calls this after is_ctrl_exit_combo identifies a control-key exit request.

*Call graph*: calls 1 internal fn (finish_with); called by 1 (handle_key).


##### `ModelMigrationScreen::confirm_selection`  (lines 208–217)

```
fn confirm_selection(&mut self)
```

**Purpose**: Turns the currently highlighted choice into a final answer. If the prompt does not allow opting out, confirmation simply accepts.

**Data flow**: It reads whether opt-out is allowed and, if so, which menu option is highlighted. Highlighting the new model becomes Accepted; highlighting the existing model becomes Rejected. If opt-out is not allowed, it always accepts.

**Call relations**: handle_menu_key calls this when the user presses Enter or Escape in the menu flow, so key input becomes a final migration outcome.

*Call graph*: calls 2 internal fn (accept, reject); called by 1 (handle_menu_key).


##### `ModelMigrationScreen::highlight_option`  (lines 219–224)

```
fn highlight_option(&mut self, option: MigrationMenuOption)
```

**Purpose**: Moves the visible highlight to a given menu option. It only asks for a redraw when the highlighted option actually changes.

**Data flow**: It receives the option that should be highlighted. If that differs from the current one, it stores the new option and schedules a frame redraw. It returns nothing.

**Call relations**: handle_menu_key uses this for arrow keys, vim-style movement keys, and numeric shortcuts before accepting or rejecting.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_menu_key).


##### `ModelMigrationScreen::handle_key`  (lines 226–241)

```
fn handle_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Interprets one keyboard event for the prompt. It decides whether the key should finish the prompt, move through the menu, or be ignored.

**Data flow**: It receives a key event. Key-release events are ignored, Ctrl-C and Ctrl-D become Exit, opt-out prompts pass the key code to the menu handler, and non-opt-out prompts accept on Escape or Enter. It updates the screen state when a key has meaning.

**Call relations**: The main prompt loop sends every key event here. This function delegates menu-specific behavior to handle_menu_key and uses is_ctrl_exit_combo to recognize hard-exit shortcuts.

*Call graph*: calls 4 internal fn (accept, exit, handle_menu_key, is_ctrl_exit_combo); 1 external calls (matches!).


##### `ModelMigrationScreen::is_done`  (lines 243–245)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the prompt has reached a final answer. The event loop uses it to know when to stop waiting for input.

**Data flow**: It reads the screen's done flag and returns that true-or-false value. It does not change anything.

**Call relations**: run_model_migration_prompt checks this around its event loop so it keeps listening only while the prompt is still active.


##### `ModelMigrationScreen::outcome`  (lines 247–249)

```
fn outcome(&self) -> ModelMigrationOutcome
```

**Purpose**: Returns the final outcome stored by the screen. Callers use it after the prompt has finished to know what the user chose.

**Data flow**: It reads the screen's outcome field and returns a copy of that value. It does not alter the screen.

**Call relations**: run_model_migration_prompt calls this after the loop ends. Tests also inspect it after simulated key presses.


##### `ModelMigrationScreen::render_ref`  (lines 253–270)

```
fn render_ref(&self, area: ratatui::layout::Rect, buf: &mut ratatui::buffer::Buffer)
```

**Purpose**: Draws the entire migration prompt into the terminal buffer. This is the screen's main rendering entry point.

**Data flow**: It receives the area to draw into and the terminal buffer. It clears the area, builds a vertical column of content, chooses markdown rendering or plain heading/content rendering, optionally adds the menu, and writes the column into the buffer.

**Call relations**: The terminal drawing code calls this whenever the prompt needs to appear or be refreshed. It coordinates heading_line, render_content, render_markdown_content, and render_menu to assemble the visible screen.

*Call graph*: calls 5 internal fn (heading_line, render_content, render_markdown_content, render_menu, new); 1 external calls (from).


##### `ModelMigrationScreen::handle_menu_key`  (lines 274–293)

```
fn handle_menu_key(&mut self, code: KeyCode)
```

**Purpose**: Interprets keyboard input when the prompt has a two-choice menu. It supports arrows, j/k movement, number shortcuts, Enter, and Escape.

**Data flow**: It receives a key code. Up or k highlights the new-model choice; Down or j highlights the existing-model choice; 1 accepts the new model; 2 rejects the migration; Enter or Escape confirms the current highlight. Unknown keys do nothing.

**Call relations**: handle_key sends key codes here only when the user may opt out. This function then calls highlight_option, accept, reject, or confirm_selection to update the screen.

*Call graph*: calls 4 internal fn (accept, confirm_selection, highlight_option, reject); called by 1 (handle_key).


##### `ModelMigrationScreen::heading_line`  (lines 295–299)

```
fn heading_line(&self) -> Line<'static>
```

**Purpose**: Builds the prompt heading as one terminal line. It adds a simple leading marker before the prepared heading text.

**Data flow**: It reads the heading spans from the prompt copy, prefixes them with "> ", and returns a Line object ready for rendering. It does not change the screen.

**Call relations**: render_ref calls this when drawing the non-markdown version of the prompt.

*Call graph*: called by 1 (render_ref); 2 external calls (from, vec!).


##### `ModelMigrationScreen::render_content`  (lines 301–303)

```
fn render_content(&self, column: &mut ColumnRenderable)
```

**Purpose**: Adds the prepared plain-text content lines to the render column. It is a small bridge between stored prompt copy and the common line-rendering helper.

**Data flow**: It reads the content lines from the screen's copy and passes them into render_lines along with the column being built. The column gains those rendered paragraphs.

**Call relations**: render_ref uses this for normal, non-markdown prompts after drawing the heading.

*Call graph*: calls 1 internal fn (render_lines); called by 1 (render_ref).


##### `ModelMigrationScreen::render_lines`  (lines 305–315)

```
fn render_lines(&self, lines: &[Line<'static>], column: &mut ColumnRenderable)
```

**Purpose**: Turns a list of terminal text lines into indented, wrapping paragraphs in the output column. This keeps ordinary prompt text readable at different terminal widths.

**Data flow**: It receives a slice of lines and a column under construction. For each line, it creates a paragraph that wraps without trimming spaces, adds a left inset, and pushes it into the column. The column is changed; no value is returned.

**Call relations**: render_content calls this so all plain content lines get the same indentation and wrapping behavior.

*Call graph*: calls 2 internal fn (tlbr, push); called by 1 (render_content); 1 external calls (new).


##### `ModelMigrationScreen::render_markdown_content`  (lines 317–339)

```
fn render_markdown_content(
        &self,
        markdown: &str,
        area_width: u16,
        column: &mut ColumnRenderable,
    )
```

**Purpose**: Renders markdown prompt text into terminal lines that fit the current screen width. This supports richer migration messages while still wrapping cleanly.

**Data flow**: It receives markdown text, the available area width, and the column being built. It subtracts a small left inset to find a usable wrap width, asks the markdown renderer to produce display lines, then inserts each line as an indented paragraph. The column is updated.

**Call relations**: render_ref calls this instead of the plain heading/content path when ModelMigrationCopy contains markdown. It hands off text wrapping to render_markdown_text_with_width.

*Call graph*: calls 3 internal fn (render_markdown_text_with_width, tlbr, push); called by 1 (render_ref); 1 external calls (new).


##### `ModelMigrationScreen::render_menu`  (lines 341–375)

```
fn render_menu(&self, column: &mut ColumnRenderable)
```

**Purpose**: Adds the opt-out menu and its keyboard hints to the prompt. This is the part of the display that lets users choose between the new and existing model.

**Data flow**: It receives the column being built. It adds spacing, an instruction sentence, one row for each menu option with the current highlight applied, and a final hint line showing which keys move and confirm. The column is updated.

**Call relations**: render_ref calls this only when the prompt allows opting out. It asks MigrationMenuOption::all for the choices, uses each option's label, and uses selection_option_row to draw consistent selectable rows.

*Call graph*: calls 4 internal fn (all, tlbr, push, selection_option_row); called by 1 (render_ref); 3 external calls (from, new, vec!).


##### `AltScreenGuard::enter`  (lines 386–389)

```
fn enter(tui: &'a mut Tui) -> Self
```

**Purpose**: Switches the terminal into its alternate screen and creates a guard object that will switch it back later. This protects the user's normal scrollback from the large full-screen prompt.

**Data flow**: It receives a mutable terminal interface. It asks the terminal to enter alternate-screen mode, then stores the terminal reference inside an AltScreenGuard. The guard is returned.

**Call relations**: run_model_migration_prompt uses this before drawing. The call graph also shows another prompt-like flow, run_session_picker_with_loader, using the same guard pattern.

*Call graph*: called by 2 (run_model_migration_prompt, run_session_picker_with_loader); 1 external calls (enter_alt_screen).


##### `AltScreenGuard::drop`  (lines 393–395)

```
fn drop(&mut self)
```

**Purpose**: Leaves the alternate screen automatically when the guard goes away. This is cleanup code that runs even if the prompt exits early.

**Data flow**: It uses the terminal reference stored in the guard and asks it to leave alternate-screen mode. It ignores any cleanup error and returns nothing.

**Call relations**: Rust calls this automatically when AltScreenGuard falls out of scope, so run_model_migration_prompt does not need a separate explicit cleanup step.

*Call graph*: 1 external calls (leave_alt_screen).


##### `is_ctrl_exit_combo`  (lines 398–401)

```
fn is_ctrl_exit_combo(key_event: KeyEvent) -> bool
```

**Purpose**: Checks whether a key event is one of the control-key exits for this prompt. In plain terms, it recognizes Ctrl-C and Ctrl-D.

**Data flow**: It receives a key event, checks that the Control modifier is present, and checks that the key is c or d. It returns true only for those combinations.

**Call relations**: handle_key uses this before normal menu handling so exit shortcuts take priority over regular prompt choices.

*Call graph*: called by 1 (handle_key); 1 external calls (matches!).


##### `fill_migration_markdown`  (lines 403–407)

```
fn fill_migration_markdown(template: &str, current_model: &str, target_model: &str) -> String
```

**Purpose**: Fills a markdown template with the actual old and new model names. This lets server- or config-provided copy contain placeholders instead of hard-coded model names.

**Data flow**: It receives a template string, the current model name, and the target model name. It replaces {model_from} with the current model and {model_to} with the target model, then returns the completed string.

**Call relations**: migration_copy_for_models calls this when markdown copy is supplied, before the text is stored in ModelMigrationCopy.

*Call graph*: called by 1 (migration_copy_for_models).


##### `tests::prompt_snapshot`  (lines 423–454)

```
fn prompt_snapshot()
```

**Purpose**: Checks the rendered prompt for a typical opt-out migration message. It helps catch accidental layout or wording changes.

**Data flow**: The test creates a fake terminal, builds migration copy with custom text and opt-out enabled, renders a ModelMigrationScreen, flushes the terminal, and compares the output to a stored snapshot. The test passes only if the rendering matches the expected screen.

**Call relations**: It exercises migration_copy_for_models and ModelMigrationScreen::new, then relies on the screen rendering path to produce the snapshot.

*Call graph*: calls 5 internal fn (with_options, new, migration_copy_for_models, new, test_dummy); 2 external calls (new, assert_snapshot!).


##### `tests::prompt_snapshot_gpt5_family`  (lines 457–481)

```
fn prompt_snapshot_gpt5_family()
```

**Purpose**: Checks how a non-optional GPT-5 family migration prompt renders when it includes a learn-more link. This protects that specific prompt layout.

**Data flow**: The test sets up a fake terminal, builds prompt copy with a model link and opt-out disabled, renders the screen, flushes output, and compares it to a stored snapshot. The result is a pass or fail from the snapshot comparison.

**Call relations**: It uses the same copy builder and screen constructor as production code, then verifies the drawing behavior for the no-opt-out path.

*Call graph*: calls 5 internal fn (with_options, new, migration_copy_for_models, new, test_dummy); 2 external calls (new, assert_snapshot!).


##### `tests::prompt_snapshot_gpt5_codex`  (lines 484–508)

```
fn prompt_snapshot_gpt5_codex()
```

**Purpose**: Checks the rendered prompt for migrating from a GPT-5 Codex model to a newer Codex max model. It guards the screen layout for this model family.

**Data flow**: The test creates a fake terminal at a fixed size, builds copy with a link and target description, renders the screen, flushes it, and compares the terminal contents with a stored snapshot.

**Call relations**: It drives migration_copy_for_models and ModelMigrationScreen::new, then indirectly covers render_ref and its helper rendering functions.

*Call graph*: calls 5 internal fn (with_options, new, migration_copy_for_models, new, test_dummy); 2 external calls (new, assert_snapshot!).


##### `tests::prompt_snapshot_gpt5_codex_mini`  (lines 511–535)

```
fn prompt_snapshot_gpt5_codex_mini()
```

**Purpose**: Checks the rendered prompt for migrating from one mini Codex model to another. This makes sure the smaller-model wording and layout stay stable.

**Data flow**: The test builds a fixed-size fake terminal, creates no-opt-out migration copy with a link and description, renders the prompt, flushes the terminal, and compares against a stored snapshot.

**Call relations**: Like the other snapshot tests, it uses the production copy-building and screen-building functions to verify the final terminal output.

*Call graph*: calls 5 internal fn (with_options, new, migration_copy_for_models, new, test_dummy); 2 external calls (new, assert_snapshot!).


##### `tests::escape_key_accepts_prompt`  (lines 538–564)

```
fn escape_key_accepts_prompt()
```

**Purpose**: Verifies the intentional behavior that Escape accepts the prompt rather than counting as an exit. This prevents future changes from accidentally making Escape cancel the migration prompt.

**Data flow**: The test creates a screen with opt-out enabled, sends it an Escape key event, then checks that the screen is done and that the outcome is Accepted. It does not render the terminal.

**Call relations**: It calls migration_copy_for_models and ModelMigrationScreen::new to set up realistic state, then exercises ModelMigrationScreen::handle_key and checks is_done and outcome.

*Call graph*: calls 3 internal fn (new, migration_copy_for_models, test_dummy); 2 external calls (new, assert!).


##### `tests::selecting_use_existing_model_rejects_upgrade`  (lines 567–596)

```
fn selecting_use_existing_model_rejects_upgrade()
```

**Purpose**: Verifies that moving to the second menu option and confirming records a rejection of the upgrade. This protects the opt-out path.

**Data flow**: The test creates an opt-out screen, sends a Down key to highlight "Use existing model", then sends Enter. It then checks that the screen is done and that the outcome is Rejected.

**Call relations**: It exercises the key-handling chain from handle_key through handle_menu_key, highlight_option, confirm_selection, and reject.

*Call graph*: calls 3 internal fn (new, migration_copy_for_models, test_dummy); 2 external calls (new, assert!).


##### `tests::markdown_prompt_keeps_long_url_tail_visible_when_narrow`  (lines 599–626)

```
fn markdown_prompt_keeps_long_url_tail_visible_when_narrow()
```

**Purpose**: Verifies that markdown rendering does not lose the end of a very long URL in a narrow terminal. This matters because links are often only useful if their final identifying part remains visible.

**Data flow**: The test creates a screen whose markdown is a long URL, renders it into a narrow fake terminal, converts the terminal contents to text, and asserts that the URL tail appears. The output is a pass or fail from that assertion.

**Call relations**: It builds a ModelMigrationScreen directly with markdown copy, then exercises the markdown rendering path inside render_ref and render_markdown_content.

*Call graph*: calls 4 internal fn (with_options, new, new, test_dummy); 3 external calls (new, new, assert!).


### Session resume and application assembly
These files handle resuming prior sessions and assembling the main application and chat widget state that will drive the interactive UI.

### `tui/src/app.rs`

`orchestration` · `startup, main loop, teardown`

This file ties together the visible terminal app, the background app server, the chat widget, configuration, permissions, feedback, model choice, thread state, and shutdown behavior. Without it, the project would still have many useful parts, but nothing would coordinate them into a working interactive terminal session.

The main type is App. Think of it like the stage manager in a theater: it does not write every line of dialogue, but it makes sure the actors, props, lights, and cues all happen at the right time. At startup, App::run prepares configuration, connects to the app server, chooses or resumes a thread, builds the ChatWidget that users see, starts file search and background refreshes, and schedules the first screen draw.

Then it enters an event loop. That loop waits for several kinds of things at once: keyboard and paste events from the terminal, internal app events, messages from the active thread, and notifications from the app server. Each event is routed to the right part of the system. Drawing is also coordinated here, including transcript reflow, overlays, cursor position, and optional pet images.

The file also contains small helpers for resume hints, approval choices, model provider status, thread-start races, and Windows sandbox checks. These helpers keep the main loop readable and make edge cases predictable.

#### Function details

##### `collab_receiver_thread_ids`  (lines 251–269)

```
fn collab_receiver_thread_ids(notification: &ServerNotification) -> Option<&[String]>
```

**Purpose**: Finds which collaborator or sub-agent threads are meant to receive a collaboration tool-call notification. It only answers for the specific notification shapes that can actually contain those receiver IDs.

**Data flow**: It takes one server notification. If the notification says a collaboration agent tool call started or completed, it reads the receiver thread ID list from that item and returns it. For every other kind of notification, it returns nothing.

**Call relations**: This is a small inspection helper used when higher-level event code needs to route collaboration activity to the right threads. It does not call into other project logic; it simply extracts the useful part from a server message.


##### `sub_agent_activity_item`  (lines 271–283)

```
fn sub_agent_activity_item(notification: &ServerNotification) -> Option<&ThreadItem>
```

**Purpose**: Checks whether a server notification is about sub-agent activity and, if so, returns the underlying thread item. This lets the app recognize activity updates from helper agents without treating all notifications the same.

**Data flow**: It receives a server notification. If the notification marks a SubAgentActivity item as started or completed, it returns a reference to that item. Otherwise it returns nothing.

**Call relations**: This helper supports the app-server event path by identifying sub-agent activity messages before other code decides how to display or route them.


##### `collab_receiver_is_not_found`  (lines 285–303)

```
fn collab_receiver_is_not_found(
    notification: &ServerNotification,
    receiver_thread_id: &str,
) -> bool
```

**Purpose**: Detects a specific failure case: a collaboration tool call finished, but one intended receiver thread was reported as not found. This helps the app react differently to missing agent threads.

**Data flow**: It takes a server notification and one receiver thread ID. If the notification is a completed collaboration tool call, it looks up that receiver in the tool call's agent states. It returns true only when that receiver's status is NotFound; otherwise it returns false.

**Call relations**: This is used as a decision helper in collaboration routing. It depends only on the notification contents and hands back a yes-or-no answer for the caller.


##### `default_exec_approval_decisions`  (lines 305–353)

```
fn default_exec_approval_decisions(
    network_approval_context: Option<&codex_app_server_protocol::NetworkApprovalContext>,
    proposed_execpolicy_amendment: Option<&codex_app_server_protocol::Exec
```

**Purpose**: Builds the default list of choices shown when the app asks the user to approve a command execution. The choices change depending on whether the command needs network permission, extra permissions, or a command-policy change.

**Data flow**: It receives optional context about network approval, proposed execution-policy changes, proposed network-policy changes, and extra permissions. It turns those inputs into an ordered list of approval decisions, such as accept, accept for the session, apply a policy amendment, or cancel.

**Call relations**: Approval UI code can call this when preparing a permission prompt. It does not perform the approval itself; it prepares the menu of reasonable choices for the next layer to display.

*Call graph*: 1 external calls (vec!).


##### `auto_review_mode`  (lines 366–374)

```
fn auto_review_mode() -> AutoReviewMode
```

**Purpose**: Returns the permission settings that should be applied when the Auto-review experiment is enabled. Auto-review means the system can review approval requests automatically under a specific safe permission profile.

**Data flow**: It takes no input. It creates an AutoReviewMode value containing an on-request approval policy, the AutoReview reviewer setting, and the built-in workspace permission profile. The result is used as a ready-made settings bundle.

**Call relations**: Other parts of the app use this when enabling the Auto-review feature so the current runtime permissions immediately match the experiment.

*Call graph*: calls 1 internal fn (new).


##### `AutoReviewMode::permission_profile`  (lines 378–381)

```
fn permission_profile(&self) -> PermissionProfile
```

**Purpose**: In tests, turns the AutoReviewMode's active built-in profile name into the full PermissionProfile object. This confirms that Auto-review points at a valid built-in profile.

**Data flow**: It reads the active permission profile stored inside AutoReviewMode. It asks the shared permission-profile helper to look up the built-in profile and returns the full profile, failing the test if that lookup should have worked but did not.

**Call relations**: This method is compiled only for tests. It supports test code that needs to compare or inspect the actual permission profile behind Auto-review.

*Call graph*: 1 external calls (builtin_permission_profile_for_active_permission_profile).


##### `managed_filesystem_sandbox_is_restricted`  (lines 385–390)

```
fn managed_filesystem_sandbox_is_restricted(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: On Windows, checks whether a permission profile uses the restricted managed file-system sandbox. This matters because restricted sandboxing has extra safety checks and warnings.

**Data flow**: It receives a PermissionProfile, reads its file-system sandbox policy, and returns true if the policy kind is Restricted. Otherwise it returns false.

**Call relations**: App::run calls this during startup on Windows before deciding whether to scan for world-writable directories and warn the user.

*Call graph*: called by 1 (run); 1 external calls (matches!).


##### `AppExitInfo::fatal`  (lines 408–416)

```
fn fatal(message: impl Into<String>) -> Self
```

**Purpose**: Creates an AppExitInfo value for a startup or runtime failure that should end the app. It packages the error message in the same shape as normal exit information.

**Data flow**: It receives a message, converts it into a string, and builds an AppExitInfo with empty token usage, no thread ID, no resume hint, no update action, and a Fatal exit reason.

**Call relations**: The interactive TUI launcher calls this when it needs to report a fatal exit without having a fully running App instance.

*Call graph*: called by 1 (run_interactive_tui); 3 external calls (into, default, Fatal).


##### `session_summary`  (lines 431–448)

```
fn session_summary(
    token_usage: TokenUsage,
    thread_id: Option<ThreadId>,
    thread_name: Option<String>,
    rollout_path: Option<&Path>,
) -> Option<SessionSummary>
```

**Purpose**: Builds a short end-of-session summary for the user, including token usage and a resume command when either is available. It avoids showing an empty summary when there is nothing useful to say.

**Data flow**: It receives token usage, optional thread ID, optional thread name, and an optional rollout file path. It converts nonzero token usage into text and asks for a resume hint if the thread can be resumed. If both are missing, it returns nothing; otherwise it returns a SessionSummary.

**Call relations**: This helper combines token accounting with resume-hint logic. It calls resume_hint_for_resumable_thread to decide whether a user can continue the session later.

*Call graph*: calls 2 internal fn (is_zero, resume_hint_for_resumable_thread).


##### `resumable_thread`  (lines 456–467)

```
fn resumable_thread(
    thread_id: Option<ThreadId>,
    thread_name: Option<String>,
    rollout_path: Option<&Path>,
) -> Option<ResumableThread>
```

**Purpose**: Decides whether a thread has enough saved information to be resumed later. A thread is resumable only if it has an ID and a nonempty rollout file on disk.

**Data flow**: It receives an optional thread ID, optional thread name, and optional rollout path. If the ID or path is missing, it returns nothing. If the path points to a nonempty file, it returns a ResumableThread containing the ID and name.

**Call relations**: resume_hint_for_resumable_thread calls this first, so resume hints are only produced for threads that really have saved state.

*Call graph*: calls 1 internal fn (rollout_path_is_resumable); called by 1 (resume_hint_for_resumable_thread).


##### `resume_hint_for_resumable_thread`  (lines 469–476)

```
fn resume_hint_for_resumable_thread(
    thread_id: Option<ThreadId>,
    thread_name: Option<String>,
    rollout_path: Option<&Path>,
) -> Option<String>
```

**Purpose**: Creates the human-facing command hint that tells the user how to resume a saved thread. It only does this when the thread is actually resumable.

**Data flow**: It receives optional thread details and a rollout path. It asks resumable_thread to validate them, then passes the thread name and ID to the shared command-line hint formatter. If validation fails, it returns nothing.

**Call relations**: App::run uses this at shutdown to include a resume hint in AppExitInfo, and session_summary uses it when building a summary message.

*Call graph*: calls 1 internal fn (resumable_thread); called by 2 (run, session_summary); 1 external calls (resume_hint).


##### `rollout_path_is_resumable`  (lines 478–480)

```
fn rollout_path_is_resumable(rollout_path: &Path) -> bool
```

**Purpose**: Checks whether the saved session file exists, is a file, and is not empty. This is a practical guard against offering a resume command that cannot work.

**Data flow**: It receives a filesystem path. It reads the file metadata and returns true only when the path exists as a regular file with length greater than zero.

**Call relations**: resumable_thread calls this as the final check before considering a thread resumable.

*Call graph*: called by 1 (resumable_thread); 1 external calls (metadata).


##### `errors_for_cwd`  (lines 482–489)

```
fn errors_for_cwd(cwd: &Path, response: &SkillsListResponse) -> Vec<SkillErrorInfo>
```

**Purpose**: Finds skill-loading errors that belong to one working directory. This lets the UI show only the warnings relevant to the current project folder.

**Data flow**: It receives a current working directory path and a skills-list response. It searches the response entries for one whose cwd matches the given path, then returns that entry's errors. If there is no match, it returns an empty list.

**Call relations**: This helper is part of startup and refresh warning logic for skills. It narrows a broader server response down to the directory the app is currently using.


##### `RuntimePermissionProfileOverride::from_config`  (lines 597–603)

```
fn from_config(config: &Config) -> Self
```

**Purpose**: Captures the current permission-related settings from the app configuration as a runtime override. This gives the app a snapshot it can apply or compare after permission changes.

**Data flow**: It receives a Config. It copies the effective permission profile, the active permission-profile identity if one exists, and the network permission settings. It returns a RuntimePermissionProfileOverride containing those values.

**Call relations**: Permission-changing flows call this when applying profile selections, syncing Auto-review state, updating feature flags, or handling events that need to preserve runtime permission choices.

*Call graph*: called by 4 (apply_permission_profile_selection, sync_auto_review_runtime_state_from_effective_config, update_feature_flags, handle_event).


##### `active_turn_not_steerable_turn_error`  (lines 606–616)

```
fn active_turn_not_steerable_turn_error(error: &TypedRequestError) -> Option<AppServerTurnError>
```

**Purpose**: Recognizes a server error that means the current model turn cannot be steered. Steering means sending a change or instruction to a turn that is already in progress.

**Data flow**: It receives a typed request error. If the error came from the server, it tries to decode the server's data as a turn error. It returns that turn error only when it is specifically an ActiveTurnNotSteerable error; otherwise it returns nothing.

**Call relations**: Higher-level event or request handling can use this to turn a technical server failure into the right UI behavior instead of treating it as an unknown error.

*Call graph*: 2 external calls (matches!, from_value).


##### `resolve_runtime_model_provider_base_url`  (lines 618–627)

```
async fn resolve_runtime_model_provider_base_url(provider: &ModelProviderInfo) -> Option<String>
```

**Purpose**: Asks the configured model provider what base URL it is actually using at runtime. This can be shown in status information, especially when provider settings are dynamic.

**Data flow**: It receives model provider information. It creates a provider object, awaits its runtime base URL, and returns that URL if successful. If the lookup fails, it logs a warning and returns nothing.

**Call relations**: App::run calls this during startup while building the chat widget's status context.

*Call graph*: called by 1 (run); 4 external calls (create_model_provider, clone, runtime_base_url, warn!).


##### `spawn_startup_thread_start`  (lines 629–648)

```
fn spawn_startup_thread_start(
    app_server: &AppServerSession,
    config: Config,
    app_event_tx: AppEventSender,
)
```

**Purpose**: Starts the initial chat thread in the background so the user interface can keep starting up without blocking. When the thread start finishes, it sends an app event with the result.

**Data flow**: It receives an app-server session, configuration, and an app-event sender. It copies the request handle, thread-parameter mode, and optional remote working directory, then spawns an asynchronous task. That task starts the thread and sends StartupThreadStarted with either success or an error string.

**Call relations**: App::run calls this for fresh sessions. The spawned task hands its result back through the app event channel, where the main event loop later receives and processes it.

*Call graph*: calls 5 internal fn (send, remote_cwd_override, request_handle, thread_params_mode, start_thread_with_request_handle); called by 1 (run); 1 external calls (spawn).


##### `active_turn_steer_race`  (lines 656–679)

```
fn active_turn_steer_race(error: &TypedRequestError) -> Option<ActiveTurnSteerRace>
```

**Purpose**: Detects race conditions when the app tries to steer an active turn but the server's idea of the active turn has changed. A race condition is when two things happen in close timing and one side has stale information.

**Data flow**: It receives a typed request error. It only examines errors from the turn/steer method. If the server says there is no active turn, it returns Missing. If the server says the expected active turn ID did not match the actual one, it extracts and returns the actual ID.

**Call relations**: Request handling can use this to resynchronize with the app server and possibly retry once, instead of failing immediately because of stale cached turn state.


##### `session_start_error`  (lines 681–692)

```
fn session_start_error(
    action: &str,
    target_session: &SessionTarget,
    err: color_eyre::eyre::Report,
) -> color_eyre::eyre::Report
```

**Purpose**: Turns a failed resume or fork operation into a clearer error message for the user. It gives special guidance for archived sessions.

**Data flow**: It receives the action name, the target session, and the original error. First it asks archived_session_guidance whether the error contains a known archived-session message. If so, it returns that clearer message. Otherwise it includes the action, target label, and original error in a new report.

**Call relations**: App::run uses this when resume_thread or fork_thread fails during startup. It delegates archived-session wording to archived_session_guidance.

*Call graph*: calls 2 internal fn (archived_session_guidance, display_label); 1 external calls (eyre!).


##### `archived_session_guidance`  (lines 694–704)

```
fn archived_session_guidance(err: &color_eyre::eyre::Report) -> Option<String>
```

**Purpose**: Extracts the useful user-facing part of an archived-session error. This avoids showing extra protocol detail when the main advice is to unarchive the session.

**Data flow**: It receives an error report, converts it to text, and searches for the archived-session guidance pattern. If found, it trims off trailing error-code detail and returns the guidance string. If the pattern is absent, it returns nothing.

**Call relations**: session_start_error calls this before building its generic failure message.

*Call graph*: called by 1 (session_start_error); 2 external calls (find, to_string).


##### `active_turn_interrupt_race`  (lines 706–723)

```
fn active_turn_interrupt_race(error: &TypedRequestError) -> Option<String>
```

**Purpose**: Detects when an interrupt request targeted one active turn but the server had already moved to another. Interrupting means asking the server to stop an in-progress turn.

**Data flow**: It receives a typed request error. It only handles errors from turn/interrupt. If the message follows the expected mismatch pattern, it extracts the server's actual active turn ID and returns it. Otherwise it returns nothing.

**Call relations**: Higher-level interrupt handling can use this result to update stale turn state or decide how to recover from the mismatch.


##### `App::chatwidget_init_for_forked_or_resumed_thread`  (lines 726–756)

```
fn chatwidget_init_for_forked_or_resumed_thread(
        &self,
        tui: &mut tui::Tui,
        cfg: crate::legacy_core::config::Config,
        initial_user_message: Option<crate::chatwidget::Use
```

**Purpose**: Builds the setup package needed to create a ChatWidget for a thread that was forked or resumed. It reuses the current app's shared services and status information so the new widget behaves like the old one.

**Data flow**: It reads App fields such as the event sender, workspace command runner, model catalog, feedback object, account status, current plan, current model, warning flags, and telemetry. It combines those with the provided TUI, configuration, and optional initial user message, then returns a ChatWidgetInit value.

**Call relations**: Thread lifecycle code can call this when switching to a resumed or forked thread. The returned setup object is handed to ChatWidget creation code.

*Call graph*: 10 external calls (frame_requester, clone, clone, clone, current_model, current_plan_type, has_chatgpt_account, has_codex_backend_auth, runtime_model_provider_base_url, status_account_display).


##### `App::run`  (lines 759–1252)

```
async fn run(
        tui: &mut tui::Tui,
        mut app_server: AppServerSession,
        mut config: Config,
        cli_kv_overrides: Vec<(String, TomlValue)>,
        harness_overrides: ConfigOve
```

**Purpose**: Starts and runs the whole terminal application. It performs setup, enters the main event loop, routes events until exit, then shuts down the app server and returns final session information.

**Data flow**: It receives the terminal UI, app-server session, configuration, startup options, initial prompt data, feedback, state database, environment manager, and other startup context. It bootstraps the app server, chooses the model, handles migration prompts, creates telemetry and the ChatWidget, starts or resumes the selected thread, prepares keymaps and file search, and schedules the first draw. During the loop it consumes app events, terminal events, active-thread events, and app-server events. On exit it shuts down the server, clears terminal UI resources, computes token usage and resume hints, and returns AppExitInfo.

**Call relations**: This is the file's main orchestration function. It calls many helpers in this file, including managed_filesystem_sandbox_is_restricted, resolve_runtime_model_provider_base_url, spawn_startup_thread_start, and resume_hint_for_resumable_thread, and it hands events off to methods such as handle_tui_event and app-server event handlers defined in submodules.

*Call graph*: calls 23 internal fn (originator, new, new, managed_filesystem_sandbox_is_restricted, resolve_runtime_model_provider_base_url, resume_hint_for_resumable_thread, spawn_startup_thread_start, new, bootstrap, fork_thread (+13 more)); 38 external calls (new, new, new, pin, new, now, should_prompt_for_paused_goal_after_startup_resume, should_wait_for_initial_session, spawn_world_writable_scan, new (+15 more)).


##### `App::handle_tui_event`  (lines 1254–1327)

```
async fn handle_tui_event(
        &mut self,
        tui: &mut tui::Tui,
        app_server: &mut AppServerSession,
        event: TuiEvent,
    ) -> Result<AppRunControl>
```

**Purpose**: Processes one event from the terminal user interface, such as a key press, paste, resize, or draw request. It turns raw terminal activity into updates on the chat widget and screen.

**Data flow**: It receives the current App, the TUI, the app-server session, and one TuiEvent. For draw and resize events it prepares rendering. If an overlay is open, it sends the event to overlay handling. Otherwise it routes key presses to key handling, normalizes pasted text before giving it to the chat widget, and on draw events updates timers, renders the chat widget, draws optional pet images, and launches the external editor when requested. It returns Continue unless a called path requests exit.

**Call relations**: App::run calls this from the main event loop whenever terminal events arrive. It uses render_chat_widget_frame for normal drawing and sends LaunchExternalEditor back into the app event system when needed.

*Call graph*: calls 3 internal fn (render_chat_widget_frame, send, pre_draw_tick); 14 external calls (new, draw_ambient_pet_image, draw_pet_picker_preview_image, frame_requester, matches!, ambient_pet_draw, ambient_pet_image_enabled, external_editor_state, handle_paste, handle_paste_burst_tick (+4 more)).


##### `App::show_shutdown_feedback`  (lines 1329–1336)

```
fn show_shutdown_feedback(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Shows the user that shutdown is in progress before the app exits. This is useful when the app must stop an active thread before closing.

**Data flow**: It receives the App and TUI. It disables the ambient pet image, tells the chat widget to display a shutdown message, performs pre-render work, ticks the widget once, and renders the frame. It returns success or any rendering error.

**Call relations**: Exit-handling code calls this when it needs visible feedback during shutdown. It reuses render_chat_widget_frame for the actual screen draw.

*Call graph*: calls 3 internal fn (render_chat_widget_frame, pre_draw_tick, show_shutdown_in_progress).


##### `App::render_chat_widget_frame`  (lines 1338–1351)

```
fn render_chat_widget_frame(&mut self, tui: &mut tui::Tui) -> Result<Rect>
```

**Purpose**: Draws the chat widget for one frame and places the terminal cursor where the widget says it should be. This is the common drawing path for normal updates and shutdown feedback.

**Data flow**: It receives the App and TUI. It asks the chat widget how tall it wants to be for the terminal width, asks the TUI to draw with resize-aware reflow, renders the widget into the frame buffer, and sets cursor style and position if the widget provides one. It returns the rectangle area that was rendered.

**Call relations**: App::handle_tui_event calls this during draw and resize events. App::show_shutdown_feedback also calls it to display shutdown state.

*Call graph*: called by 2 (handle_tui_event, show_shutdown_feedback); 3 external calls (default, draw_with_resize_reflow, desired_height).


##### `App::drop`  (lines 1355–1359)

```
fn drop(&mut self)
```

**Purpose**: Cleans up terminal title changes when an App value is destroyed. This prevents the terminal from being left with a title that the app set while running.

**Data flow**: It runs automatically when App is dropped. It asks the chat widget to clear the managed terminal title. If that fails, it logs a debug message but does not stop shutdown.

**Call relations**: Rust calls this automatically as part of cleanup. It is the final safety net for terminal-title restoration after the main run loop has ended.

*Call graph*: 2 external calls (debug!, clear_managed_terminal_title).


### `tui/src/resume_picker.rs`

`orchestration` · `startup, in-app session picking, and terminal event loop`

This file is the control room for the session picker shown in the terminal user interface. Its job is to help the user find the right past conversation, instead of forcing them to remember file names or thread IDs. Without it, resuming or forking a previous session would be much harder and would lose useful comforts like search, current-folder filtering, sorting, paging, transcript previews, and saved display density.

The picker works like a small app inside the terminal. A run function prepares options from the main configuration, starts a background loader that talks to the app server, then enters an alternate full-screen terminal mode. A PickerState object keeps the current screen state: loaded rows, selected row, search text, filter mode, sort choice, scroll position, loading status, cached previews, and any transcript overlay.

Two event streams drive the picker. User events come from the keyboard, paste, resize, and draw requests. Background events arrive when session pages, previews, or transcripts finish loading. The state updates itself, asks for more pages when needed, and requests redraws. Rendering functions then turn the state into a header, search toolbar, list, loading overlay, and footer. In everyday terms, the file is both the receptionist who fetches records and the display board that helps the user choose one. The resume picker is the terminal app’s “choose a conversation” screen. It has to fit useful information into whatever terminal size the user has, from a wide desktop window to a narrow split pane. This part of the file turns picker state into lines of styled terminal text: rows for sessions, small metadata footers, loading messages, keyboard shortcut hints, and expanded conversation previews.

A lot of the work is careful layout. The code asks: how wide is the screen, which labels can fit, what should be shortened, and what should move to another line? It uses small helper functions like measuring text width, truncating long paths, and choosing colors that remain readable on light or dark backgrounds. The footer hints behave like labels on a crowded dashboard: when there is room they are descriptive, and when space is tight they shrink down to just the keys.

The session list supports two densities. Comfortable mode uses more lines per session with metadata below the title. Dense mode packs date and title into one row. Selecting or expanding a session changes its marker and styling. Expanded rows show session details and, when available, a transcript preview.

The tests in this chunk create fake picker states and terminal buffers, then check the rendered text or snapshots. They protect the picker from visual regressions. The resume picker is the “choose a previous conversation” screen in the terminal interface. It keeps a list of session rows, lets the user move through them with keys, filters or sorts what is shown, and asks a background loader for more data when the visible list is not enough. In this chunk, the focus is on tests that protect the picker’s behavior. They check small display details, such as the footer saying “3 / 10” or showing a frozen percent while another page is loading. They also check keyboard shortcuts: Ctrl-O changes between comfortable and dense layouts, Ctrl-T opens a transcript, Ctrl-E expands a row preview, and navigation keys move by visible rows. Several tests make sure the interface stays usable while background work is happening, for example by blocking normal typing while a transcript is loading but still allowing Ctrl-C to exit. Other tests render the picker into a fake terminal and compare snapshots, which is like taking a picture of the screen to make sure future changes do not accidentally alter the layout. Without these checks, small changes could quietly break important user-facing behavior in this busy terminal UI. From this chunk, `resume_picker.rs` is concerned with making the resume screen feel predictable in a terminal user interface. The picker has to show saved sessions, keep the highlighted card visible as the user moves up and down, search through more saved history when the current page has no match, and preserve enough information to reopen the right conversation. Think of it like a file chooser, but for past chat threads instead of files.

These tests build small fake session lists and fake app-server threads, then drive the picker as a user would: pressing arrow keys, typing or pasting a search query, or pressing Escape. They check that the picker does not lose remote threads that have no local file path, that transcript rendering includes normal user and assistant messages, and that private raw reasoning is only shown when explicitly allowed. They also check scrolling rules: when cards are taller than the visible area, the selected card should stay in view without jumpy movement. Finally, the search tests make sure the picker keeps requesting more pages until it finds a match or reaches a scan limit, and ignores stale background results so old searches cannot disturb the current one.

#### Function details

##### `SessionTarget::display_label`  (lines 88–93)

```
fn display_label(&self) -> String
```

**Purpose**: Returns a human-readable name for the session the user chose. It prefers the saved file path, and falls back to the thread ID when there is no path.

**Data flow**: It reads the target's optional path and thread ID. If a path exists, it turns that path into display text; otherwise it formats the thread ID as "thread ...". It returns that label as a string.

**Call relations**: When the app reports a selected session or an error involving one, callers use this helper so messages can show a useful name instead of raw internal data.

*Call graph*: called by 2 (resume_target_session, session_start_error).


##### `SessionPickerAction::title`  (lines 117–122)

```
fn title(self) -> &'static str
```

**Purpose**: Gives the screen title for the picker, depending on whether the user is resuming or forking a session.

**Data flow**: It reads the action value and maps it to fixed title text. Nothing else changes.

**Call relations**: The drawing code uses this title in the picker header so the user always knows what kind of choice they are making.


##### `SessionPickerAction::action_label`  (lines 124–129)

```
fn action_label(self) -> &'static str
```

**Purpose**: Provides a short lowercase word for the action, such as "resume" or "fork". This is useful in compact messages or prompts.

**Data flow**: It reads the action and returns a fixed label string. It does not modify state.

**Call relations**: This is a small wording helper for the picker flow, keeping labels consistent wherever the action is described.


##### `SessionPickerAction::selection`  (lines 131–137)

```
fn selection(self, path: Option<PathBuf>, thread_id: ThreadId) -> SessionSelection
```

**Purpose**: Turns the currently highlighted session into the final choice returned by the picker. It preserves whether the user meant to resume it or fork it.

**Data flow**: It receives an optional session path and a required thread ID. It wraps them in a SessionTarget, then returns either a Resume or Fork selection based on the current picker action.

**Call relations**: PickerState::handle_key calls this when the user accepts a row. The returned SessionSelection leaves the picker and tells the surrounding app what to do next.

*Call graph*: called by 1 (handle_key); 2 external calls (Fork, Resume).


##### `SessionFilterMode::from_show_all`  (lines 169–175)

```
fn from_show_all(show_all: bool, filter_cwd: Option<&Path>) -> Self
```

**Purpose**: Chooses the initial filter mode for the picker. It decides whether to show all sessions or only sessions from the current working folder.

**Data flow**: It receives the show-all flag and an optional folder to filter by. If show-all is true, or there is no folder to filter with, it returns All; otherwise it returns Cwd.

**Call relations**: PickerState::new uses this during setup so the picker starts with the right scope before any sessions are loaded.

*Call graph*: called by 1 (new).


##### `SessionFilterMode::toggle`  (lines 177–183)

```
fn toggle(self, filter_cwd: Option<&Path>) -> Self
```

**Purpose**: Switches the filter between current-folder-only and all sessions when that switch is available.

**Data flow**: It reads the current mode and whether there is a folder to filter by. Cwd becomes All; All becomes Cwd only if a folder exists; otherwise All stays All.

**Call relations**: PickerState::toggle_filter_mode calls this when the user changes the filter toolbar control.

*Call graph*: called by 1 (toggle_filter_mode).


##### `ToolbarControl::previous`  (lines 193–198)

```
fn previous(self) -> Self
```

**Purpose**: Moves toolbar focus to the previous control. Since there are only two controls, it simply flips between Filter and Sort.

**Data flow**: It reads the current toolbar control and returns the other one. It does not change anything itself.

**Call relations**: PickerState::focus_previous_toolbar_control uses this when the user presses the reverse toolbar navigation key.

*Call graph*: called by 1 (focus_previous_toolbar_control).


##### `ToolbarControl::next`  (lines 200–205)

```
fn next(self) -> Self
```

**Purpose**: Moves toolbar focus to the next control. With two controls, next is the same as previous: it flips between Filter and Sort.

**Data flow**: It reads the current toolbar control and returns the other one. It has no side effects.

**Call relations**: PickerState::focus_next_toolbar_control uses this when the user tabs through the toolbar.

*Call graph*: called by 1 (focus_next_toolbar_control).


##### `SessionListDensity::toggle`  (lines 215–220)

```
fn toggle(self) -> Self
```

**Purpose**: Switches the list between a roomier display and a tighter display. This lets users trade readability for seeing more rows at once.

**Data flow**: It reads the current density and returns the opposite density. It does not save the choice by itself.

**Call relations**: PickerState::toggle_density calls this, then redraws and tries to persist the new preference.

*Call graph*: called by 1 (toggle_density).


##### `SessionListDensity::from`  (lines 224–229)

```
fn from(mode: SessionPickerViewMode) -> Self
```

**Purpose**: Converts the saved configuration view mode into the picker’s internal density value.

**Data flow**: It receives a SessionPickerViewMode from config and returns the matching SessionListDensity. No state is changed.

**Call relations**: The run functions use this during picker setup so the screen starts with the user's saved comfortable or dense layout.

*Call graph*: called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context).


##### `SessionPickerViewMode::from`  (lines 233–238)

```
fn from(density: SessionListDensity) -> Self
```

**Purpose**: Converts the picker’s current density back into the configuration value that can be saved.

**Data flow**: It receives a SessionListDensity and returns the matching SessionPickerViewMode. It only transforms the value.

**Call relations**: PickerState::persist_density uses this before writing the user's density preference to configuration.


##### `run_resume_picker_with_app_server`  (lines 304–320)

```
async fn run_resume_picker_with_app_server(
    tui: &mut Tui,
    config: &Config,
    show_all: bool,
    include_non_interactive: bool,
    app_server: AppServerSession,
) -> Result<SessionSelectio
```

**Purpose**: Starts the resume picker when the app is first launching. It is a convenience wrapper that marks the launch context as startup.

**Data flow**: It receives the terminal UI, config, filtering flags, and an app-server session. It forwards them to the shared resume picker setup with a Startup context and returns the user's final selection.

**Call relations**: run_ratatui_app calls this for the normal resume flow. It hands off all real setup to run_resume_picker_with_launch_context.

*Call graph*: calls 1 internal fn (run_resume_picker_with_launch_context); called by 1 (run_ratatui_app).


##### `run_resume_picker_from_existing_session_with_app_server`  (lines 322–338)

```
async fn run_resume_picker_from_existing_session_with_app_server(
    tui: &mut Tui,
    config: &Config,
    show_all: bool,
    include_non_interactive: bool,
    app_server: AppServerSession,
) ->
```

**Purpose**: Starts the resume picker from inside an already running session. This lets the app distinguish an in-session picker from the startup picker.

**Data flow**: It receives the same inputs as the startup resume picker. It passes them to the shared setup with an ExistingSession context and returns the chosen session action.

**Call relations**: handle_event calls this when the user opens the picker from an existing session. The common work is delegated to run_resume_picker_with_launch_context.

*Call graph*: calls 1 internal fn (run_resume_picker_with_launch_context); called by 1 (handle_event).


##### `run_resume_picker_with_launch_context`  (lines 340–385)

```
async fn run_resume_picker_with_launch_context(
    tui: &mut Tui,
    config: &Config,
    show_all: bool,
    include_non_interactive: bool,
    app_server: AppServerSession,
    launch_context: Ses
```

**Purpose**: Builds all options needed for a resume picker, including filters, key bindings, display density, persistence, and background loading.

**Data flow**: It reads config and app-server information, works out whether the workspace is remote, chooses folder and provider filters, loads runtime key bindings, creates run options, starts a loader, and awaits the picker result.

**Call relations**: Both public resume entry points call this. It then calls run_session_picker_with_loader, which runs the actual terminal event loop.

*Call graph*: calls 10 internal fn (remote_cwd_override, uses_remote_workspace, from, local_picker_cwd_filter, picker_cwd_filter, picker_provider_filter, picker_runtime_keymap, raw_reasoning_visibility, run_session_picker_with_loader, spawn_app_server_page_loader); called by 2 (run_resume_picker_from_existing_session_with_app_server, run_resume_picker_with_app_server); 1 external calls (unbounded_channel).


##### `run_fork_picker_with_app_server`  (lines 387–430)

```
async fn run_fork_picker_with_app_server(
    tui: &mut Tui,
    config: &Config,
    show_all: bool,
    app_server: AppServerSession,
) -> Result<SessionSelection>
```

**Purpose**: Starts the picker in fork mode, where selecting a past session creates a fork instead of resuming it directly.

**Data flow**: It reads config and app-server workspace details, prepares filters and keymaps, creates options with the Fork action, starts an app-server loader, and awaits the final selection.

**Call relations**: run_ratatui_app calls this for the fork workflow. It shares the same lower-level picker runner as resume mode.

*Call graph*: calls 10 internal fn (remote_cwd_override, uses_remote_workspace, from, local_picker_cwd_filter, picker_cwd_filter, picker_provider_filter, picker_runtime_keymap, raw_reasoning_visibility, run_session_picker_with_loader, spawn_app_server_page_loader); called by 1 (run_ratatui_app); 1 external calls (unbounded_channel).


##### `run_session_picker_with_loader`  (lines 432–501)

```
async fn run_session_picker_with_loader(
    tui: &mut Tui,
    options: SessionPickerRunOptions,
    picker_loader: PickerLoader,
    bg_rx: mpsc::UnboundedReceiver<BackgroundEvent>,
) -> Result<Sess
```

**Purpose**: Runs the full-screen picker loop. It listens for user input and background loading results until the user chooses, cancels, exits, or the streams end.

**Data flow**: It receives the terminal UI, prepared options, a loader callback, and a background-event receiver. It enters alternate screen mode, creates PickerState, starts the first load, then repeatedly updates state and redraws. It returns a SessionSelection.

**Call relations**: The resume and fork setup functions call this after preparing their options. It coordinates PickerState, drawing, terminal events, and background loader events.

*Call graph*: calls 2 internal fn (enter, new); called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context); 2 external calls (new, select!).


##### `raw_reasoning_visibility`  (lines 503–509)

```
fn raw_reasoning_visibility(config: &Config) -> RawReasoningVisibility
```

**Purpose**: Decides whether raw agent reasoning should be included when loading transcripts. This follows the user's configuration.

**Data flow**: It reads config.show_raw_agent_reasoning. True becomes Visible; false becomes Hidden.

**Call relations**: The resume and fork setup paths call this before creating the background loader, so transcript loading knows what content may be shown.

*Call graph*: called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context).


##### `local_picker_cwd_filter`  (lines 511–520)

```
fn local_picker_cwd_filter(
    cwd_filter: &Option<PathBuf>,
    uses_remote_workspace: bool,
) -> Option<PathBuf>
```

**Purpose**: Decides whether folder filtering should also be applied locally after rows are loaded. Remote workspaces rely on the server-side filter instead.

**Data flow**: It receives the chosen folder filter and whether the workspace is remote. For remote workspaces it returns None; otherwise it clones and returns the folder filter.

**Call relations**: The run functions use this to fill PickerState.local_filter_cwd. Tests also check the remote behavior to avoid double-filtering remote paths locally.

*Call graph*: called by 3 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context, remote_picker_sends_cwd_filter_without_local_post_filtering).


##### `picker_provider_filter`  (lines 522–528)

```
fn picker_provider_filter(config: &Config, uses_remote_workspace: bool) -> ProviderFilter
```

**Purpose**: Chooses which model-provider sessions should appear. Local picking filters to the configured default provider, while remote picking accepts any provider.

**Data flow**: It reads the config provider ID and whether the workspace is remote. It returns Any for remote workspaces, or MatchDefault with the configured provider for local workspaces.

**Call relations**: The run functions pass this into PickerState and later into thread_list_params through load requests.

*Call graph*: called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context); 1 external calls (MatchDefault).


##### `picker_runtime_keymap`  (lines 530–533)

```
fn picker_runtime_keymap(config: &Config) -> Result<RuntimeKeymap>
```

**Purpose**: Loads the picker’s keyboard shortcuts from configuration and turns configuration errors into a clear runtime error.

**Data flow**: It reads config.tui_keymap, asks RuntimeKeymap to parse it, and either returns the keymap or an error saying the keymap configuration is invalid.

**Call relations**: Resume and fork setup call this before entering the picker, because the event loop needs valid list and pager key bindings.

*Call graph*: calls 1 internal fn (from_config); called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context).


##### `picker_cwd_filter`  (lines 535–548)

```
fn picker_cwd_filter(
    config_cwd: &Path,
    show_all: bool,
    uses_remote_workspace: bool,
    remote_cwd_override: Option<&Path>,
) -> Option<PathBuf>
```

**Purpose**: Chooses the folder filter sent to the session source. It respects show-all mode and treats remote workspaces differently from local ones.

**Data flow**: It receives the configured current folder, show-all flag, remote-workspace flag, and optional remote folder override. Show-all returns no filter; remote mode returns the remote override; local mode returns the configured folder.

**Call relations**: The run functions use this during setup, and tests verify the filter values that later reach thread list requests.

*Call graph*: called by 3 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context, local_picker_thread_list_params_include_cwd_filter); 1 external calls (to_path_buf).


##### `spawn_app_server_page_loader`  (lines 550–605)

```
fn spawn_app_server_page_loader(
    app_server: AppServerSession,
    include_non_interactive: bool,
    raw_reasoning_visibility: RawReasoningVisibility,
    bg_tx: mpsc::UnboundedSender<BackgroundE
```

**Purpose**: Starts a background task that performs slow app-server reads for the picker. This keeps the terminal UI responsive while pages, previews, and transcripts load.

**Data flow**: It receives an app-server session, loading options, reasoning visibility, and a channel for results. It returns a loader callback; each callback request is sent to the background task, which performs the server call and sends a BackgroundEvent back.

**Call relations**: Resume and fork setup call this before run_session_picker_with_loader. The PickerState later calls the returned loader whenever it needs more rows, a preview, or a transcript.

*Call graph*: calls 4 internal fn (shutdown, load_app_server_page, load_transcript_preview, load_session_transcript); called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context); 4 external calls (new, send, spawn, warn!).


##### `sort_key_label`  (lines 608–613)

```
fn sort_key_label(sort_key: ThreadSortKey) -> &'static str
```

**Purpose**: Returns the display label for a sort option.

**Data flow**: It maps CreatedAt to "Created" and UpdatedAt to "Updated". It has no side effects.

**Call relations**: Toolbar rendering uses this so the sort control can show friendly labels.


##### `AltScreenGuard::enter`  (lines 621–624)

```
fn enter(tui: &'a mut Tui) -> Self
```

**Purpose**: Switches the terminal into alternate-screen mode for the picker. Alternate-screen mode is like a temporary full-screen page that can be removed cleanly afterward.

**Data flow**: It receives the terminal UI, asks it to enter alternate screen mode, and returns a guard object that keeps access to the UI.

**Call relations**: run_session_picker_with_loader calls this before starting the picker loop. The guard’s drop method later restores the normal screen.

*Call graph*: 1 external calls (enter_alt_screen).


##### `AltScreenGuard::drop`  (lines 628–630)

```
fn drop(&mut self)
```

**Purpose**: Restores the terminal from alternate-screen mode when the picker finishes or is abandoned.

**Data flow**: It uses the stored terminal UI and asks it to leave alternate screen mode. Errors are ignored because this runs during cleanup.

**Call relations**: Rust calls this automatically when the AltScreenGuard goes out of scope in run_session_picker_with_loader.

*Call graph*: 1 external calls (leave_alt_screen).


##### `LoadingState::is_pending`  (lines 728–730)

```
fn is_pending(&self) -> bool
```

**Purpose**: Answers whether a page load is currently in progress.

**Data flow**: It checks the loading state and returns true only for Pending. It does not change the state.

**Call relations**: Pagination and footer logic use this to avoid duplicate loads and to show loading progress correctly.

*Call graph*: 1 external calls (matches!).


##### `load_app_server_page`  (lines 733–763)

```
async fn load_app_server_page(
    app_server: &mut AppServerSession,
    cursor: Option<String>,
    cwd_filter: Option<&Path>,
    provider_filter: ProviderFilter,
    sort_key: ThreadSortKey,
    i
```

**Purpose**: Fetches one page of sessions from the app server and converts it into picker rows.

**Data flow**: It receives server access, cursor, filters, sort choice, and source options. It calls the server's thread list API, converts valid threads into Row values, stores the next cursor, and returns a PickerPage or an I/O error.

**Call relations**: The background loader calls this for Page requests. Its output is sent back to PickerState as a BackgroundEvent::Page.

*Call graph*: calls 2 internal fn (thread_list, thread_list_params); called by 1 (spawn_app_server_page_loader).


##### `load_transcript_preview`  (lines 765–815)

```
async fn load_transcript_preview(
    app_server: &mut AppServerSession,
    thread_id: ThreadId,
) -> std::io::Result<Vec<TranscriptPreviewLine>>
```

**Purpose**: Loads a short preview of recent user and assistant messages for an expanded session row.

**Data flow**: It receives an app-server session and thread ID. It reads the thread with turns included, extracts text from user and assistant messages, cleans blank lines, keeps only the last few lines, and returns them.

**Call relations**: The background loader calls this for Preview requests. PickerState stores the returned lines so expanded rows can show a quick conversation snippet.

*Call graph*: calls 1 internal fn (thread_read); called by 1 (spawn_app_server_page_loader).


##### `SearchState::active_token`  (lines 818–823)

```
fn active_token(&self) -> Option<usize>
```

**Purpose**: Returns the current search request token, if a search is still in progress.

**Data flow**: It reads the search state. Idle returns None; Active returns its token.

**Call relations**: Search continuation logic uses this token to tell whether arriving page results still belong to the current search text.

*Call graph*: called by 1 (is_active).


##### `SearchState::is_active`  (lines 825–827)

```
fn is_active(&self) -> bool
```

**Purpose**: Reports whether the picker is actively searching through more pages.

**Data flow**: It calls active_token and returns true when a token exists. It changes nothing.

**Call relations**: This is a small status helper for code that needs to know whether search paging is ongoing.

*Call graph*: calls 1 internal fn (active_token).


##### `Row::seen_key`  (lines 849–854)

```
fn seen_key(&self) -> Option<SeenRowKey>
```

**Purpose**: Builds a stable identity for a session row so duplicates can be skipped. A file path is preferred; otherwise the thread ID is used.

**Data flow**: It reads the row path and thread ID. It returns a SeenRowKey for the path or thread, or None if neither exists.

**Call relations**: PickerState::ingest_page uses this when adding newly loaded rows, preventing the same session from appearing twice.

*Call graph*: 1 external calls (Path).


##### `Row::display_preview`  (lines 856–858)

```
fn display_preview(&self) -> &str
```

**Purpose**: Chooses the main text to show for a row. A named thread gets its name shown first; otherwise the message preview is used.

**Data flow**: It reads thread_name and preview from the row and returns a borrowed string slice. It does not modify the row.

**Call relations**: Rendering code uses this to decide what the user sees as the row's main label.


##### `Row::matches_query`  (lines 860–890)

```
fn matches_query(&self, query: &str) -> bool
```

**Purpose**: Checks whether a row matches the user's search text.

**Data flow**: It receives a lowercase query and compares it against the row preview, thread name, thread ID, git branch, and working folder. It returns true on the first match, otherwise false.

**Call relations**: PickerState::apply_filter calls this when the search box is not empty, so only matching rows remain visible.


##### `PickerState::new`  (lines 894–945)

```
fn new(
        requester: FrameRequester,
        picker_loader: PickerLoader,
        provider_filter: ProviderFilter,
        show_all: bool,
        filter_cwd: Option<PathBuf>,
        action: Se
```

**Purpose**: Creates the in-memory state for a fresh picker screen. This is the starting snapshot before any sessions have been loaded.

**Data flow**: It receives a frame requester, loader callback, provider filter, show-all setting, folder filter, and picker action. It fills all state fields with defaults, derived filter mode, default keymaps, and empty row caches.

**Call relations**: run_session_picker_with_loader calls this at the start of the event loop. Tests also construct PickerState directly to check behavior.

*Call graph*: calls 2 internal fn (defaults, from_show_all); called by 68 (run_session_picker_with_loader, all_filter_can_switch_back_to_cwd_when_cwd_candidate_exists, cached_transcript_still_shows_loading_frame_before_opening_overlay, comfortable_zebra_lines_use_full_width_background, ctrl_c_exits_even_when_cancel_is_remapped_to_ctrl_c, ctrl_e_toggles_selected_session_expansion, ctrl_o_keeps_toggled_density_when_persistence_fails, ctrl_o_persists_density_preference, ctrl_o_toggles_density_without_typing_into_search, ctrl_t_on_row_without_thread_id_shows_inline_error (+15 more)); 4 external calls (new, new, new, new).


##### `PickerState::request_frame`  (lines 947–949)

```
fn request_frame(&self)
```

**Purpose**: Asks the terminal UI to redraw the picker soon.

**Data flow**: It uses the stored frame requester and schedules a frame. It returns nothing.

**Call relations**: Many state-changing methods call this after changing selection, filters, loading state, errors, or overlays so the screen catches up.

*Call graph*: calls 1 internal fn (schedule_frame); called by 13 (apply_filter, begin_transcript_loading, clear_query_preserving_selection, complete_pending_page_down, handle_background_event, handle_key, handle_overlay_event, load_more_if_needed, open_pending_transcript_if_ready, open_selected_transcript (+3 more)).


##### `PickerState::is_transcript_loading`  (lines 951–953)

```
fn is_transcript_loading(&self) -> bool
```

**Purpose**: Reports whether the picker is waiting to open a full transcript overlay.

**Data flow**: It checks whether pending_transcript_open contains a thread ID and returns a boolean.

**Call relations**: Keyboard and paste handling use this to temporarily ignore normal picker input while the loading overlay is active.

*Call graph*: called by 3 (handle_key, handle_paste, footer_hint_lines).


##### `PickerState::note_transcript_loading_frame_drawn`  (lines 955–962)

```
fn note_transcript_loading_frame_drawn(&mut self) -> bool
```

**Purpose**: Records that the transcript loading message has been drawn at least once.

**Data flow**: If a transcript is pending, it marks transcript_loading_frame_shown true and returns true. If nothing is pending, it returns false.

**Call relations**: The draw loop calls this after rendering. It helps ensure the user sees a loading frame before a cached transcript overlay opens.


##### `PickerState::open_pending_transcript_if_ready`  (lines 964–982)

```
fn open_pending_transcript_if_ready(&mut self)
```

**Purpose**: Opens the transcript overlay once both conditions are met: the loading frame has been shown and transcript content is loaded.

**Data flow**: It checks the loading-frame flag, pending thread ID, and cached transcript cells. If all are ready, it creates an overlay, clears pending flags, and requests a redraw.

**Call relations**: The draw loop and background-event handler call this around transcript loading. It hands loaded cells to Overlay::new_transcript.

*Call graph*: calls 2 internal fn (new_transcript, request_frame); called by 1 (handle_background_event); 1 external calls (clone).


##### `PickerState::begin_transcript_loading`  (lines 984–988)

```
fn begin_transcript_loading(&mut self, thread_id: ThreadId)
```

**Purpose**: Marks a transcript as the one the user is trying to open and asks the screen to show loading feedback.

**Data flow**: It stores the thread ID as pending, resets the loading-frame flag, and requests a redraw.

**Call relations**: PickerState::open_selected_transcript calls this whether the transcript is already cached, currently loading, or needs a new load.

*Call graph*: calls 1 internal fn (request_frame); called by 1 (open_selected_transcript).


##### `PickerState::handle_overlay_event`  (lines 990–1000)

```
fn handle_overlay_event(&mut self, tui: &mut Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Sends terminal events to an open overlay, such as the transcript viewer, instead of the session list.

**Data flow**: It receives the terminal UI and an event. If an overlay exists, it lets the overlay process the event; if the overlay says it is done, it closes it and requests a redraw.

**Call relations**: run_session_picker_with_loader calls this whenever state.overlay is present, so overlay controls temporarily take priority over picker controls.

*Call graph*: calls 1 internal fn (request_frame).


##### `PickerState::open_selected_transcript`  (lines 1002–1026)

```
fn open_selected_transcript(&mut self)
```

**Purpose**: Starts opening the full transcript for the currently selected session.

**Data flow**: It reads the selected row. If there is no row or thread ID, it either does nothing or shows an error. If a transcript is cached or loading, it begins the pending-open flow; otherwise it marks it loading and asks the loader to fetch it.

**Call relations**: PickerState::handle_key calls this for transcript shortcuts. It sends Transcript requests through the picker loader when needed.

*Call graph*: calls 2 internal fn (begin_transcript_loading, request_frame); called by 1 (handle_key).


##### `PickerState::handle_transcript_loading_key`  (lines 1028–1037)

```
fn handle_transcript_loading_key(&mut self, key: KeyEvent) -> Option<SessionSelection>
```

**Purpose**: Handles the limited keys allowed while a transcript is loading. Currently, Ctrl-C can still exit.

**Data flow**: It receives a key event. Ctrl-C returns an Exit selection; all other keys return None.

**Call relations**: PickerState::handle_key delegates here whenever is_transcript_loading is true, preventing normal list actions during transcript loading.

*Call graph*: called by 1 (handle_key).


##### `PickerState::handle_key`  (lines 1039–1229)

```
async fn handle_key(&mut self, key: KeyEvent) -> Result<Option<SessionSelection>>
```

**Purpose**: Interprets keyboard input for the picker. It covers exit, cancel, search typing, movement, paging, accepting a session, toolbar changes, transcript actions, expansion, and density changes.

**Data flow**: It receives one key event and reads the current state and runtime keymap. It updates state, may trigger loads or redraws, and may return a final SessionSelection when the user accepts, cancels, exits, resumes, or forks.

**Call relations**: run_session_picker_with_loader calls this for key events. It delegates to many smaller PickerState helpers and uses SessionPickerAction::selection when a row is accepted.

*Call graph*: calls 17 internal fn (is_plain_text_key_event, change_focused_toolbar_value, clear_query_preserving_selection, ensure_selected_visible, focus_next_toolbar_control, focus_previous_toolbar_control, handle_transcript_loading_key, is_transcript_loading, load_more_if_needed, maybe_load_more_for_scroll (+7 more)); 2 external calls (from, format!).


##### `PickerState::handle_paste`  (lines 1231–1244)

```
fn handle_paste(&mut self, pasted: String)
```

**Purpose**: Adds pasted text to the search query in a safe, normalized form.

**Data flow**: It receives pasted text. If a transcript is loading or the paste normalizes to nothing, it stops; otherwise it appends the cleaned text to the existing query, adding a space if needed, and updates the query.

**Call relations**: run_session_picker_with_loader calls this for paste events. It feeds into set_query, which filters rows and may load more pages for search.

*Call graph*: calls 3 internal fn (normalize_pasted_search_query, is_transcript_loading, set_query).


##### `PickerState::start_initial_load`  (lines 1246–1280)

```
fn start_initial_load(&mut self)
```

**Purpose**: Clears current results and starts loading the first page for the current filter, sort, and search settings.

**Data flow**: It resets pagination and rows, records a fresh time reference, prepares search and request tokens, marks loading pending, requests a frame, and sends a Page load request with no cursor.

**Call relations**: run_session_picker_with_loader calls this when the picker starts. Filter and sort changes also call it to reload results from the beginning.

*Call graph*: calls 5 internal fn (active_cwd_filter, allocate_request_token, allocate_search_token, request_frame, reset_pagination); called by 2 (toggle_filter_mode, toggle_sort_key); 4 external calls (now, Pending, Page, clone).


##### `PickerState::handle_background_event`  (lines 1282–1339)

```
async fn handle_background_event(&mut self, event: BackgroundEvent) -> Result<()>
```

**Purpose**: Applies results that arrive from the background loader.

**Data flow**: It receives a page, preview, or transcript event. Page events are checked against request tokens, then ingested; preview events update preview cache; transcript events update transcript cache, open overlays when ready, or show an error.

**Call relations**: run_session_picker_with_loader calls this for background events. It is the bridge from app-server loading back into visible picker state.

*Call graph*: calls 5 internal fn (complete_pending_page_down, continue_search_if_token_matches, ingest_page, open_pending_transcript_if_ready, request_frame); 2 external calls (Loaded, Loaded).


##### `PickerState::reset_pagination`  (lines 1341–1347)

```
fn reset_pagination(&mut self)
```

**Purpose**: Returns pagination bookkeeping to an empty, not-loading state.

**Data flow**: It clears the next cursor, scan counters, scan-cap flag, loading state, and frozen footer percentage.

**Call relations**: PickerState::start_initial_load calls this before requesting the first page of a new result set.

*Call graph*: called by 1 (start_initial_load).


##### `PickerState::ingest_page`  (lines 1349–1374)

```
fn ingest_page(&mut self, page: PickerPage)
```

**Purpose**: Adds a newly loaded page of sessions into the picker and refreshes the visible list.

**Data flow**: It receives a PickerPage, updates cursor and count information, records scan-cap status, appends rows that have not been seen before, and reapplies the current filter and search query.

**Call relations**: PickerState::handle_background_event calls this after a page load completes successfully.

*Call graph*: calls 1 internal fn (apply_filter); called by 1 (handle_background_event).


##### `PickerState::complete_pending_page_down`  (lines 1376–1395)

```
fn complete_pending_page_down(&mut self)
```

**Purpose**: Finishes a page-down action that needed more data before it could land on the requested row.

**Data flow**: It reads the stored target row. If more pages are still needed, it asks for another load; otherwise it moves selection to the target or last row, keeps it visible, may load more near the bottom, and redraws.

**Call relations**: PickerState::handle_background_event calls this after ingesting a page that might satisfy a previous page-down request.

*Call graph*: calls 4 internal fn (ensure_selected_visible, load_more_if_needed, maybe_load_more_for_scroll, request_frame); called by 1 (handle_background_event).


##### `PickerState::apply_filter`  (lines 1397–1416)

```
fn apply_filter(&mut self)
```

**Purpose**: Rebuilds the visible row list from all loaded rows using the current folder filter and search query.

**Data flow**: It reads all_rows, filter mode, and query. It creates filtered_rows, adjusts selection and scroll if needed, keeps the selected row visible, and requests a redraw.

**Call relations**: This is called after pages arrive, after search changes, and after clearing search, so visible results stay consistent.

*Call graph*: calls 2 internal fn (ensure_selected_visible, request_frame); called by 3 (clear_query_preserving_selection, ingest_page, set_query).


##### `PickerState::row_matches_filter`  (lines 1418–1429)

```
fn row_matches_filter(&self, row: &Row) -> bool
```

**Purpose**: Checks whether a row passes the current folder filter.

**Data flow**: It reads the filter mode and local folder filter. All mode accepts everything; current-folder mode compares the row's folder to the filter folder and returns whether they match.

**Call relations**: PickerState::apply_filter calls this before applying text search.

*Call graph*: calls 1 internal fn (paths_match).


##### `PickerState::set_query`  (lines 1431–1453)

```
fn set_query(&mut self, new_query: String)
```

**Purpose**: Changes the search query and updates visible results. If no loaded rows match, it can keep loading more pages to search beyond the current page.

**Data flow**: It receives new query text. If changed, it stores it, resets selection, filters loaded rows, updates search state, and may request another page with a search token.

**Call relations**: Keyboard typing and paste handling call this. It works with background page loading and search tokens to continue searching through paged results.

*Call graph*: calls 3 internal fn (allocate_search_token, apply_filter, load_more_if_needed); called by 2 (handle_key, handle_paste).


##### `PickerState::clear_query_preserving_selection`  (lines 1455–1473)

```
fn clear_query_preserving_selection(&mut self)
```

**Purpose**: Clears the search box while trying to keep the same session selected afterward.

**Data flow**: It remembers the selected row's identity, clears query and search state, reapplies filtering, then finds the same row in the larger list if possible and moves selection back to it.

**Call relations**: PickerState::handle_key calls this when the cancel key is pressed while a search query is present.

*Call graph*: calls 3 internal fn (apply_filter, ensure_selected_visible, request_frame); called by 1 (handle_key).


##### `PickerState::continue_search_if_needed`  (lines 1475–1488)

```
fn continue_search_if_needed(&mut self)
```

**Purpose**: Keeps loading more pages for an active search until a match appears or there is nowhere else to search.

**Data flow**: It checks the active search token, visible results, scan cap, and next cursor. If search should continue, it requests another page tied to that token; otherwise it marks search idle.

**Call relations**: continue_search_if_token_matches calls this after a search-related page finishes.

*Call graph*: calls 1 internal fn (load_more_if_needed); called by 1 (continue_search_if_token_matches); 1 external calls (active_token).


##### `PickerState::continue_search_if_token_matches`  (lines 1490–1500)

```
fn continue_search_if_token_matches(&mut self, completed_token: Option<usize>)
```

**Purpose**: Protects search continuation from stale page results. It only continues if the completed page belongs to the current search.

**Data flow**: It receives an optional completed token and compares it to the active token. Matching or absent tokens allow continuation; mismatched tokens are ignored.

**Call relations**: PickerState::handle_background_event calls this after page loading so old search results cannot drive the current search.

*Call graph*: calls 1 internal fn (continue_search_if_needed); called by 1 (handle_background_event); 1 external calls (active_token).


##### `PickerState::ensure_selected_visible`  (lines 1502–1517)

```
fn ensure_selected_visible(&mut self)
```

**Purpose**: Adjusts scrolling so the selected row is visible in the current viewport.

**Data flow**: It reads selected row, scroll top, viewport height, and row render heights. It moves scroll_top upward or downward until the selected row fits on screen.

**Call relations**: Movement, filtering, viewport changes, density changes, and paging call this before redraw.

*Call graph*: calls 2 internal fn (available_content_rows, rendered_height_between); called by 6 (apply_filter, clear_query_preserving_selection, complete_pending_page_down, handle_key, toggle_density, update_viewport).


##### `PickerState::ensure_minimum_rows_for_view`  (lines 1519–1539)

```
fn ensure_minimum_rows_for_view(&mut self, minimum_rows: usize)
```

**Purpose**: Loads more rows when the current loaded content is not enough to fill the visible list area.

**Data flow**: It receives the minimum row area height, checks whether loading is already happening or no more pages exist, measures rendered content height, and requests another page if the screen would otherwise look underfilled.

**Call relations**: The draw/resize path calls this after measuring terminal size so the picker fills the available space.

*Call graph*: calls 3 internal fn (available_content_rows, load_more_if_needed, rendered_height_between); 1 external calls (active_token).


##### `PickerState::update_viewport`  (lines 1541–1545)

```
fn update_viewport(&mut self, rows: usize, width: u16)
```

**Purpose**: Stores the current list viewport size and rechecks scrolling.

**Data flow**: It receives row count and width, updates view_rows and view_width, then ensures the selected row is visible.

**Call relations**: The event loop calls this on draw or resize before rendering the picker.

*Call graph*: calls 1 internal fn (ensure_selected_visible).


##### `PickerState::maybe_load_more_for_scroll`  (lines 1547–1561)

```
fn maybe_load_more_for_scroll(&mut self)
```

**Purpose**: Starts loading the next page when the user scrolls close to the end of the loaded rows.

**Data flow**: It checks loading status, next cursor, row count, and how many rows remain below the selection. If the remaining count is below the threshold, it requests another page.

**Call relations**: Movement and pending page-down completion call this to make scrolling feel continuous.

*Call graph*: calls 1 internal fn (load_more_if_needed); called by 2 (complete_pending_page_down, handle_key).


##### `PickerState::load_more_if_needed`  (lines 1563–1590)

```
fn load_more_if_needed(&mut self, trigger: LoadTrigger)
```

**Purpose**: Requests the next page of sessions if a load is not already running and another page exists.

**Data flow**: It reads the next cursor, freezes the footer progress display, allocates a request token, records loading state, requests a frame, and sends a Page request through the picker loader.

**Call relations**: Search, scrolling, viewport filling, and page-down flows all call this when they need more data.

*Call graph*: calls 4 internal fn (active_cwd_filter, allocate_request_token, freeze_footer_percent, request_frame); called by 6 (complete_pending_page_down, continue_search_if_needed, ensure_minimum_rows_for_view, handle_key, maybe_load_more_for_scroll, set_query); 3 external calls (Pending, Page, clone).


##### `PickerState::freeze_footer_percent`  (lines 1592–1595)

```
fn freeze_footer_percent(&mut self)
```

**Purpose**: Keeps the footer percentage from jumping while another page is loading.

**Data flow**: It computes the current scroll percentage using the current list height and stores it as frozen_footer_percent.

**Call relations**: PickerState::load_more_if_needed calls this before marking loading pending. Footer rendering then uses the frozen value.

*Call graph*: calls 1 internal fn (picker_footer_scroll_percent); called by 1 (load_more_if_needed).


##### `PickerState::allocate_request_token`  (lines 1597–1601)

```
fn allocate_request_token(&mut self) -> usize
```

**Purpose**: Creates a new number used to identify a page load request.

**Data flow**: It returns the current request counter, then increments it with wrapping behavior. The state is changed only by advancing the counter.

**Call relations**: Initial and later page loads use these tokens so stale page responses can be ignored.

*Call graph*: called by 2 (load_more_if_needed, start_initial_load).


##### `PickerState::allocate_search_token`  (lines 1603–1607)

```
fn allocate_search_token(&mut self) -> usize
```

**Purpose**: Creates a new number used to identify the current search.

**Data flow**: It returns the current search counter and increments it with wrapping behavior.

**Call relations**: Search startup in set_query and start_initial_load uses these tokens so background results can be matched to the right query.

*Call graph*: called by 2 (set_query, start_initial_load).


##### `PickerState::toggle_sort_key`  (lines 1614–1620)

```
fn toggle_sort_key(&mut self)
```

**Purpose**: Switches sorting between creation time and last update time, then reloads results.

**Data flow**: It flips the sort_key field and calls start_initial_load to clear old results and request the first page under the new sort.

**Call relations**: PickerState::change_focused_toolbar_value calls this when the Sort toolbar control is focused.

*Call graph*: calls 1 internal fn (start_initial_load); called by 1 (change_focused_toolbar_value).


##### `PickerState::toggle_filter_mode`  (lines 1622–1629)

```
fn toggle_filter_mode(&mut self)
```

**Purpose**: Switches between current-folder filtering and all sessions when possible, then reloads results.

**Data flow**: It asks the filter mode for its next value. If the value changes, it stores it and starts a fresh load.

**Call relations**: PickerState::change_focused_toolbar_value calls this when the Filter toolbar control is focused.

*Call graph*: calls 2 internal fn (start_initial_load, toggle); called by 1 (change_focused_toolbar_value).


##### `PickerState::active_cwd_filter`  (lines 1631–1636)

```
fn active_cwd_filter(&self) -> Option<PathBuf>
```

**Purpose**: Returns the folder filter that should be sent with the next load request.

**Data flow**: It reads filter_mode. Cwd returns the configured folder filter; All returns None.

**Call relations**: Initial and later page load requests call this so the app server receives the current filter choice.

*Call graph*: called by 2 (load_more_if_needed, start_initial_load).


##### `PickerState::focus_previous_toolbar_control`  (lines 1638–1640)

```
fn focus_previous_toolbar_control(&mut self)
```

**Purpose**: Moves toolbar focus backward.

**Data flow**: It reads toolbar_focus, replaces it with ToolbarControl::previous, and returns nothing.

**Call relations**: PickerState::handle_key calls this for reverse toolbar navigation.

*Call graph*: calls 1 internal fn (previous); called by 1 (handle_key).


##### `PickerState::focus_next_toolbar_control`  (lines 1642–1644)

```
fn focus_next_toolbar_control(&mut self)
```

**Purpose**: Moves toolbar focus forward.

**Data flow**: It reads toolbar_focus, replaces it with ToolbarControl::next, and returns nothing.

**Call relations**: PickerState::handle_key calls this when the user presses Tab.

*Call graph*: calls 1 internal fn (next); called by 1 (handle_key).


##### `PickerState::change_focused_toolbar_value`  (lines 1646–1651)

```
fn change_focused_toolbar_value(&mut self)
```

**Purpose**: Changes whichever toolbar setting is currently focused.

**Data flow**: It checks whether focus is on Sort or Filter. Sort toggles the sort key; Filter toggles the filter mode.

**Call relations**: PickerState::handle_key calls this for left/right toolbar-control keys.

*Call graph*: calls 2 internal fn (toggle_filter_mode, toggle_sort_key); called by 1 (handle_key).


##### `PickerState::toggle_density`  (lines 1653–1661)

```
async fn toggle_density(&mut self)
```

**Purpose**: Switches between comfortable and dense row spacing, then tries to save that preference.

**Data flow**: It flips density, fixes scroll visibility, writes the preference if persistence is configured, records an inline error if saving fails, and requests a redraw.

**Call relations**: PickerState::handle_key calls this for the density shortcut. It delegates saving to persist_density.

*Call graph*: calls 4 internal fn (ensure_selected_visible, persist_density, request_frame, toggle); called by 1 (handle_key); 2 external calls (format!, warn!).


##### `PickerState::persist_density`  (lines 1663–1675)

```
async fn persist_density(&self) -> Result<()>
```

**Purpose**: Writes the current picker density to the user configuration, if persistence is enabled.

**Data flow**: It reads view_persistence and density. If persistence exists, it builds a config edit, converts density into a SessionPickerViewMode, applies the edit, and returns success or an error.

**Call relations**: PickerState::toggle_density calls this after changing density so the next picker can reopen with the same layout.

*Call graph*: calls 1 internal fn (new); called by 1 (toggle_density); 1 external calls (from).


##### `PickerState::toggle_selected_expansion`  (lines 1677–1697)

```
fn toggle_selected_expansion(&mut self)
```

**Purpose**: Expands or collapses the selected row to show a short transcript preview.

**Data flow**: It reads the selected row and thread ID. If that row is already expanded, it collapses it; otherwise it marks it expanded, starts preview loading if not cached, and requests a redraw.

**Call relations**: PickerState::handle_key calls this for the expansion shortcut. Preview loading goes through the picker loader and returns through handle_background_event.

*Call graph*: calls 1 internal fn (request_frame); called by 1 (handle_key).


##### `PickerState::rendered_height_between`  (lines 1699–1723)

```
fn rendered_height_between(&self, start: usize, end_inclusive: usize) -> usize
```

**Purpose**: Calculates how many terminal lines a range of rows will occupy.

**Data flow**: It receives start and end indexes, renders each row virtually to count its lines, adds separator height between rows, and returns the total height.

**Call relations**: Scrolling, footer percentage, and viewport-fill logic use this measurement because rows can have different heights, especially when expanded.

*Call graph*: calls 1 internal fn (row_separator_height); called by 3 (ensure_minimum_rows_for_view, ensure_selected_visible, picker_footer_scroll_percent).


##### `PickerState::has_more_above`  (lines 1725–1727)

```
fn has_more_above(&self) -> bool
```

**Purpose**: Reports whether there are hidden rows above the current scroll position.

**Data flow**: It checks whether scroll_top is greater than zero and returns a boolean.

**Call relations**: List rendering and available-content calculations use this to reserve space for a more-above indicator.

*Call graph*: called by 2 (available_content_rows, render_list).


##### `PickerState::has_more_below`  (lines 1729–1759)

```
fn has_more_below(&self, viewport_height: usize) -> bool
```

**Purpose**: Reports whether there is content below the visible list area.

**Data flow**: It checks for more server pages first. If no pages remain, it measures rendered rows from the scroll position until the viewport is full and returns true if anything would overflow.

**Call relations**: render_list uses this to decide whether to show a more-below indicator.

*Call graph*: calls 3 internal fn (available_content_rows, row_separator_height, render_session_lines); called by 1 (render_list); 1 external calls (from).


##### `PickerState::available_content_rows`  (lines 1761–1769)

```
fn available_content_rows(&self, viewport_height: usize) -> usize
```

**Purpose**: Calculates how many terminal rows are available for actual session rows after reserving space for more-above or more-below indicators.

**Data flow**: It receives viewport height, subtracts one line if there is hidden content above, subtracts one if there is content or pages below, and returns at least one.

**Call relations**: Scrolling, footer progress, viewport filling, and below-content detection use this shared calculation.

*Call graph*: calls 1 internal fn (has_more_above); called by 4 (ensure_minimum_rows_for_view, ensure_selected_visible, has_more_below, picker_footer_scroll_percent); 1 external calls (from).


##### `PickerState::row_separator_height`  (lines 1771–1776)

```
fn row_separator_height(&self) -> usize
```

**Purpose**: Returns how many blank separator lines should appear between rows for the current density.

**Data flow**: It reads density. Comfortable returns 1; Dense returns 0.

**Call relations**: Height calculations and list rendering use this so spacing matches the user's density choice.

*Call graph*: called by 2 (has_more_below, rendered_height_between).


##### `row_from_app_server_thread`  (lines 1779–1804)

```
fn row_from_app_server_thread(thread: Thread) -> Option<Row>
```

**Purpose**: Converts one thread returned by the app server into one row the picker can display.

**Data flow**: It receives a Thread, parses its ID, trims its preview, fills fallback text if needed, converts timestamps, copies path, name, working folder, and git branch, and returns Some(Row). Invalid IDs are logged and skipped with None.

**Call relations**: load_app_server_page uses this while converting app-server pages into PickerPage rows.

*Call graph*: calls 1 internal fn (from_string); called by 1 (app_server_row_keeps_pathless_threads); 3 external calls (from, from_timestamp, warn!).


##### `thread_list_params`  (lines 1806–1829)

```
fn thread_list_params(
    cursor: Option<String>,
    cwd_filter: Option<&Path>,
    provider_filter: ProviderFilter,
    sort_key: ThreadSortKey,
    include_non_interactive: bool,
) -> ThreadListPa
```

**Purpose**: Builds the request object used to ask the app server for a page of session threads.

**Data flow**: It receives cursor, folder filter, provider filter, sort key, and source options. It creates ThreadListParams with page size, sort, provider list if needed, source kinds, non-archived setting, and optional current-folder filter.

**Call relations**: load_app_server_page calls this right before app_server.thread_list. Tests check important request details such as folder and provider filtering.

*Call graph*: called by 4 (load_app_server_page, local_picker_thread_list_params_include_cwd_filter, remote_thread_list_params_can_include_non_interactive_sources, remote_thread_list_params_omit_provider_filter); 2 external calls (resume_source_kinds, vec!).


##### `paths_match`  (lines 1831–1833)

```
fn paths_match(a: &Path, b: &Path) -> bool
```

**Purpose**: Compares two paths after normalizing them, so small path-format differences do not break filtering.

**Data flow**: It receives two paths and delegates to path_utils::paths_match_after_normalization, returning the boolean result.

**Call relations**: PickerState::row_matches_filter uses this for current-folder filtering.

*Call graph*: called by 1 (row_matches_filter); 1 external calls (paths_match_after_normalization).


##### `parse_timestamp_str`  (lines 1836–1840)

```
fn parse_timestamp_str(ts: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses a timestamp string into a UTC date-time value for tests and row construction helpers.

**Data flow**: It receives text in RFC 3339 timestamp format, tries to parse it, converts successful values to UTC, and returns Some date-time or None.

**Call relations**: Test helpers and snapshots use this to build rows with predictable timestamps.

*Call graph*: called by 12 (comfortable_zebra_lines_use_full_width_background, dense_session_line_prefers_thread_name_over_preview, dense_session_snapshot_uses_no_blank_lines_between_rows, dense_snapshot_row, density_toggle_clears_stale_more_indicator, expanded_session_details_include_metadata, expanded_session_snapshot, make_row, narrow_session_snapshot, render_dense_row_snapshot (+2 more)); 1 external calls (parse_from_rfc3339).


##### `draw_picker`  (lines 1842–1892)

```
fn draw_picker(tui: &mut Tui, state: &PickerState) -> std::io::Result<()>
```

**Purpose**: Draws the whole picker screen: title, search bar, session list, optional transcript loading overlay, and footer.

**Data flow**: It reads terminal size and PickerState, lays the screen into sections, renders header and search line, draws the list, overlays transcript loading if needed, and draws the footer.

**Call relations**: run_session_picker_with_loader calls this on draw and resize events after updating viewport information.

*Call graph*: 1 external calls (draw).


##### `list_viewport_width`  (lines 1894–1896)

```
fn list_viewport_width(width: u16) -> u16
```

**Purpose**: Computes the usable width for the session list after subtracting horizontal padding.

**Data flow**: It receives the available terminal width and subtracts a fixed inset using saturating arithmetic so the value never goes below zero.

**Call relations**: The event loop and draw_picker use this when measuring and drawing the list.


##### `search_line`  (lines 1898–1933)

```
fn search_line(state: &PickerState, width: u16) -> Line<'_>
```

**Purpose**: Builds the search-and-toolbar line shown near the top of the picker.

**Data flow**: It reads inline errors, query text, toolbar state, and available width. It returns either an error line or a line with search text, spacing, and compacted toolbar controls if space is tight.

**Call relations**: draw_picker renders this line. Snapshot tests cover narrow-width and toolbar behavior.

*Call graph*: calls 2 internal fn (toolbar_line, truncate_text); called by 3 (resume_search_error_snapshot, search_line_compacts_toolbar_on_narrow_width, search_line_renders_sort_and_filter_tabs); 4 external calls (from, width, format!, vec!).


##### `toolbar_line`  (lines 1935–1941)

```
fn toolbar_line(state: &PickerState, compact: bool) -> Line<'static>
```

**Purpose**: Builds the combined filter and sort toolbar text.

**Data flow**: It receives picker state and a compact flag, asks the filter and sort helpers for spans, inserts spacing between them, and returns a Line.

**Call relations**: search_line calls this first in full mode and then compact mode if the toolbar would not fit.

*Call graph*: calls 2 internal fn (filter_control_spans, sort_control_spans); called by 1 (search_line); 1 external calls (new).


##### `sort_control_spans`  (lines 1943–1968)

```
fn sort_control_spans(state: &PickerState, compact: bool) -> Vec<Span<'static>>
```

**Purpose**: Creates the display pieces for the sort control in the toolbar.

**Data flow**: It reads the current sort key and toolbar focus. In compact mode it shows only the active sort; otherwise it shows both choices with the active one bracketed.

**Call relations**: toolbar_line calls this when building the toolbar.

*Call graph*: called by 1 (toolbar_line); 1 external calls (vec!).


##### `filter_control_spans`  (lines 1970–1995)

```
fn filter_control_spans(state: &PickerState, compact: bool) -> Vec<Span<'static>>
```

**Purpose**: Creates the display pieces for the filter control in the toolbar.

**Data flow**: It reads the current filter mode, whether folder filtering is available, toolbar focus, and compact flag. It returns either one active label or both Cwd and All choices.

**Call relations**: toolbar_line calls this when building the toolbar.

*Call graph*: called by 1 (toolbar_line); 1 external calls (vec!).


##### `toolbar_value`  (lines 1997–2008)

```
fn toolbar_value(label: &'static str, active: bool, focused: bool) -> Span<'static>
```

**Purpose**: Formats one toolbar option, making active and focused values stand out.

**Data flow**: It receives a label plus active and focused flags. Active labels are bracketed; focused active labels are colored; inactive labels are dimmed.

**Call relations**: The sort and filter toolbar helpers call this for each displayed value.

*Call graph*: 1 external calls (format!).


##### `filter_mode_label`  (lines 2010–2015)

```
fn filter_mode_label(filter_mode: SessionFilterMode) -> &'static str
```

**Purpose**: Returns the short label for a filter mode.

**Data flow**: It maps Cwd to "Cwd" and All to "All". It does not change state.

**Call relations**: filter_control_spans uses this to display filter choices consistently.


##### `render_picker_footer`  (lines 2024–2049)

```
fn render_picker_footer(
    frame: &mut crate::custom_terminal::Frame,
    area: Rect,
    state: &PickerState,
    list_height: u16,
)
```

**Purpose**: Draws the bottom area of the picker, including a separator, progress label, and keyboard hints.

**Data flow**: It receives the frame, footer rectangle, picker state, and list height. It draws the separator with progress, then writes hint lines until the footer area is full.

**Call relations**: draw_picker calls this after rendering the list. It delegates progress and hint details to footer helpers.

*Call graph*: calls 4 internal fn (render_widget_ref, footer_hint_lines, picker_footer_progress_label, render_picker_footer_separator); called by 1 (footer_snapshot); 2 external calls (bottom, new).


##### `render_picker_footer_separator`  (lines 2051–2073)

```
fn render_picker_footer_separator(
    frame: &mut crate::custom_terminal::Frame,
    area: Rect,
    progress_label: String,
)
```

**Purpose**: Draws the horizontal footer divider and places the progress label at the right when it fits.

**Data flow**: It receives the frame, target area, and progress label. It fills the area with a dim line, measures the label, and renders it near the right edge if there is room.

**Call relations**: render_picker_footer calls this before drawing footer hints.

*Call graph*: calls 1 internal fn (render_widget_ref); called by 1 (render_picker_footer); 3 external calls (from, new, width).


##### `picker_footer_progress_label`  (lines 2075–2096)

```
fn picker_footer_progress_label(state: &PickerState, list_height: u16, width: u16) -> String
```

**Purpose**: Builds the footer text that shows the selected position, total visible rows, and scroll percentage.

**Data flow**: It reads selection, row count, loading state, list height, and available width. It tries a full label, a shorter label, then just percent, returning the first one that fits.

**Call relations**: render_picker_footer uses this label in the separator. Tests check its behavior during loading and at different widths.

*Call graph*: calls 1 internal fn (picker_footer_percent); called by 4 (render_picker_footer, picker_footer_progress_label_freezes_percent_while_loading, picker_footer_progress_label_shows_position_total_and_percent, picker_footer_progress_label_uses_known_count_when_more_pages_exist); 1 external calls (format!).


##### `picker_footer_percent`  (lines 2098–2110)

```
fn picker_footer_percent(state: &PickerState, list_height: u16) -> u8
```

**Purpose**: Returns the scroll percentage shown in the footer, with special handling while loading.

**Data flow**: It reads loading state and frozen_footer_percent. During loading it reuses the frozen percent when available; otherwise it computes the current scroll percent. When not loading, it computes normally.

**Call relations**: picker_footer_progress_label calls this so the footer does not flicker while more rows are being fetched.

*Call graph*: calls 1 internal fn (picker_footer_scroll_percent); called by 1 (picker_footer_progress_label).


##### `picker_footer_scroll_percent`  (lines 2112–2136)

```
fn picker_footer_scroll_percent(state: &PickerState, list_height: u16) -> u8
```

**Purpose**: Calculates how far down the visible list is, as a percentage.

**Data flow**: It measures total rendered height, visible content height, remaining height, and skipped height above the scroll position. Empty or fully visible lists return 100; otherwise it returns a rounded percentage.

**Call relations**: freeze_footer_percent and picker_footer_percent call this. It relies on PickerState height helpers because rows can take more than one terminal line.

*Call graph*: calls 2 internal fn (available_content_rows, rendered_height_between); called by 2 (freeze_footer_percent, picker_footer_percent).


##### `footer_hint_lines`  (lines 2138–2245)

```
fn footer_hint_lines(state: &PickerState, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the two footer lines that tell the user which keys do what. It changes the wording depending on the picker state, such as whether a transcript is loading, whether the search box has text, and whether the picker was opened at startup or inside an existing session.

**Data flow**: It reads the picker state and the available terminal width. From that it creates groups of key hints, tries wide labels first, then compact labels, then key-only labels if space is tight. It returns terminal text lines ready to draw in the footer.

**Call relations**: The footer renderer and tests call this when they need the visible shortcut text. It delegates the fitting work to hint_line_for_row and fit_footer_hints so the main function can focus on choosing the right labels for the current state.

*Call graph*: calls 2 internal fn (is_transcript_loading, fit_footer_hints); called by 3 (render_picker_footer, footer_lines_text, hint_line_prioritizes_keybinds_when_very_narrow); 2 external calls (from, vec!).


##### `hint_line_for_row`  (lines 2247–2274)

```
fn hint_line_for_row(hints: &[PickerFooterHint], width: u16) -> Line<'static>
```

**Purpose**: Chooses the best version of one row of footer hints that will fit on screen. It keeps the most important keys visible when the terminal is very narrow.

**Data flow**: It receives a list of hints and a width. It first tries full labels, then shorter labels, then keys only. If even that is too wide, it drops lower-priority hints until a key-only line fits. It returns a single terminal line, or an empty line if nothing fits.

**Call relations**: footer_hint_lines uses this for the normal footer rows. It hands the actual measuring and line construction to fit_footer_hints and fit_footer_hint_refs.

*Call graph*: calls 2 internal fn (fit_footer_hint_refs, fit_footer_hints); 2 external calls (default, len).


##### `render_transcript_loading_overlay`  (lines 2276–2311)

```
fn render_transcript_loading_overlay(frame: &mut crate::custom_terminal::Frame, area: Rect)
```

**Purpose**: Draws a centered overlay saying that a transcript is loading. This gives the user feedback while the app waits instead of leaving the screen looking frozen.

**Data flow**: It receives the terminal frame and the rectangle where it may draw. It computes a small centered box, fills it with a background style, shortens the message if needed, and renders the bold text in the middle. It changes the frame buffer but returns nothing.

**Call relations**: Snapshot tests call this through the transcript overlay test path. It uses transcript_loading_overlay_style for readable background color and truncate_text to keep the message inside the available space.

*Call graph*: calls 3 internal fn (render_widget_ref, transcript_loading_overlay_style, truncate_text); called by 1 (transcript_loading_overlay_snapshot); 3 external calls (from, new, width).


##### `transcript_loading_overlay_style`  (lines 2313–2323)

```
fn transcript_loading_overlay_style() -> Style
```

**Purpose**: Chooses the background color for the transcript loading overlay. It makes the overlay subtly stand out without becoming harsh on light or dark terminal themes.

**Data flow**: It reads the terminal’s default background color if available. It blends a small amount of black or white over that color, then returns a style with the resulting background. If no background is known, it falls back to dark gray.

**Call relations**: render_transcript_loading_overlay calls this before filling the overlay box. It relies on shared color helpers that detect light backgrounds and choose the nearest terminal color.

*Call graph*: calls 4 internal fn (blend, is_light, best_color, default_bg); called by 1 (render_transcript_loading_overlay); 1 external calls (default).


##### `fit_footer_hints`  (lines 2332–2339)

```
fn fit_footer_hints(
    hints: &[PickerFooterHint],
    mode: FooterHintLabelMode,
    width: u16,
) -> Option<Line<'static>>
```

**Purpose**: Converts owned footer hint objects into references and asks the lower-level fitter to build a line. It is a convenience wrapper for callers that have a normal slice of hints.

**Data flow**: It receives hints, a label mode, and a width. It collects references to the hints and passes them on. It returns either a fitted terminal line or nothing if the hints are too wide.

**Call relations**: footer_hint_lines and hint_line_for_row use this during the wide, compact, and key-only fitting attempts. It hands off the real measurement and styling to fit_footer_hint_refs.

*Call graph*: calls 1 internal fn (fit_footer_hint_refs); called by 2 (footer_hint_lines, hint_line_for_row); 1 external calls (iter).


##### `fit_footer_hint_refs`  (lines 2341–2371)

```
fn fit_footer_hint_refs(
    hints: &[&PickerFooterHint],
    mode: FooterHintLabelMode,
    width: u16,
) -> Option<Line<'static>>
```

**Purpose**: Builds a styled footer hint line if the selected hints fit in the available width. It is the point where keys and labels become terminal spans.

**Data flow**: It receives references to hints, a label mode, and a width. It first measures the total width. If too wide, it returns nothing. If it fits, it creates styled spans for padding, keys, gaps, and optional labels, then returns the completed line.

**Call relations**: fit_footer_hints calls this for normal fitting, and hint_line_for_row calls it directly when trying reduced subsets of hints. It uses footer_hints_width to decide fit and the footer hint style helpers to color the text.

*Call graph*: calls 3 internal fn (footer_hint_key_style, footer_hint_label_style, footer_hints_width); called by 2 (fit_footer_hints, hint_line_for_row); 2 external calls (iter, vec!).


##### `footer_hint_key_style`  (lines 2373–2379)

```
fn footer_hint_key_style() -> Style
```

**Purpose**: Chooses the style for the key names in the footer hints. On light backgrounds it forces black text so keys stay readable.

**Data flow**: It checks the default terminal background. If the background is light, it returns a black foreground style. Otherwise it returns the default style.

**Call relations**: fit_footer_hint_refs calls this while building each key span in the footer hint line.

*Call graph*: calls 1 internal fn (default_bg); called by 1 (fit_footer_hint_refs); 1 external calls (default).


##### `footer_hint_label_style`  (lines 2381–2387)

```
fn footer_hint_label_style() -> Style
```

**Purpose**: Chooses the style for the descriptive words beside footer keys. Labels are made visually quieter than the keys.

**Data flow**: It checks the default background. On light backgrounds it uses dark gray text; otherwise it uses a dim style. It returns the style for label and gap spans.

**Call relations**: fit_footer_hint_refs calls this for labels, spaces, and padding in footer hint lines.

*Call graph*: calls 1 internal fn (default_bg); called by 1 (fit_footer_hint_refs); 1 external calls (default).


##### `footer_hints_width`  (lines 2389–2416)

```
fn footer_hints_width(
    hints: &[&PickerFooterHint],
    mode: FooterHintLabelMode,
    gap_width: usize,
) -> usize
```

**Purpose**: Measures how much horizontal space a row of footer hints would take. This prevents text from spilling past the edge of the terminal.

**Data flow**: It receives hint references, a label mode, and the gap size between hints. It adds left padding, key widths, optional label widths, and inter-hint gaps. It returns the total character-cell width.

**Call relations**: fit_footer_hint_refs calls this before building the visible line so it can reject layouts that are too wide.

*Call graph*: called by 1 (fit_footer_hint_refs); 1 external calls (iter).


##### `render_list`  (lines 2418–2498)

```
fn render_list(frame: &mut crate::custom_terminal::Frame, area: Rect, state: &PickerState)
```

**Purpose**: Draws the main session list area. It shows empty messages, session rows, selection highlighting, scroll indicators, and loading-more text.

**Data flow**: It receives a terminal frame, a drawing area, and picker state. It clears the area, decides whether there are rows, computes whether “more above” or “more below” indicators are needed, renders visible rows from the scroll position, and draws pagination messages when older sessions are loading. It writes to the frame buffer and returns nothing.

**Call relations**: Many snapshot tests call this to verify list rendering. It calls render_empty_state_line for empty lists, render_session_lines for each row, and more_line for scroll indicators.

*Call graph*: calls 6 internal fn (render_widget_ref, has_more_above, has_more_below, more_line, render_empty_state_line, render_session_lines); called by 8 (dense_session_snapshot_uses_no_blank_lines_between_rows, density_toggle_clears_stale_more_indicator, expanded_session_snapshot, narrow_session_snapshot, render_dense_row_snapshot, resume_table_snapshot, session_list_more_indicators_snapshot, transcript_loading_overlay_snapshot); 3 external calls (new, from, vec!).


##### `more_line`  (lines 2500–2502)

```
fn more_line(label: &'static str) -> Line<'static>
```

**Purpose**: Creates the dim “more” indicator line used above or below a scrollable list.

**Data flow**: It receives a fixed label such as “↑ more”. It returns a one-line dimmed terminal line containing that label.

**Call relations**: render_list calls this when there are hidden rows above or below the visible area.

*Call graph*: called by 1 (render_list); 1 external calls (vec!).


##### `render_session_lines`  (lines 2504–2520)

```
fn render_session_lines(
    row: &Row,
    state: &PickerState,
    is_selected: bool,
    is_expanded: bool,
    is_zebra: bool,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Chooses how to render one session row based on the current density setting. It keeps the rest of the list renderer from needing to know the details of each layout.

**Data flow**: It receives a row, picker state, selection and expansion flags, zebra-striping information, and width. It dispatches to either comfortable or dense rendering and returns the lines for that session.

**Call relations**: render_list calls this for each visible row, and has_more_below also uses it when estimating visible height. It hands off to render_comfortable_session_lines or render_dense_session_lines.

*Call graph*: calls 2 internal fn (render_comfortable_session_lines, render_dense_session_lines); called by 2 (has_more_below, render_list).


##### `render_comfortable_session_lines`  (lines 2522–2577)

```
fn render_comfortable_session_lines(
    row: &Row,
    state: &PickerState,
    is_selected: bool,
    is_expanded: bool,
    is_zebra: bool,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Renders a session in the roomier layout. It shows the title on one line and metadata below it, or expanded details if the selected session is open.

**Data flow**: It receives the row, state, visual flags, and width. It builds a marker and truncated title, applies selected or zebra background styling when needed, and either appends transcript preview lines or footer metadata such as time, directory, and branch. It returns all lines for the row.

**Call relations**: render_session_lines calls this when the picker is in comfortable mode. It uses helpers for markers, selected title color, row backgrounds, relative times, footer metadata, and transcript previews.

*Call graph*: calls 9 internal fn (apply_session_row_background, dense_selected_style, dense_zebra_style, format_relative_time, render_footer_lines, render_transcript_preview_lines, selected_session_title_span, selection_marker, truncate_text); called by 2 (render_session_lines, comfortable_zebra_lines_use_full_width_background); 3 external calls (from, display_preview, vec!).


##### `apply_session_row_background`  (lines 2579–2588)

```
fn apply_session_row_background(
    lines: Vec<Line<'static>>,
    style: Style,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Applies a background style to every line in a session row. This makes selected rows and alternating rows fill the full width instead of only coloring the text.

**Data flow**: It receives lines, a style, and the target width. It maps each line through apply_line_background and returns the styled lines.

**Call relations**: render_comfortable_session_lines calls this when a comfortable row is selected or zebra-striped.

*Call graph*: called by 1 (render_comfortable_session_lines).


##### `apply_line_background`  (lines 2590–2600)

```
fn apply_line_background(mut line: Line<'static>, style: Style, width: u16) -> Line<'static>
```

**Purpose**: Extends one line with styled spaces and patches its spans so the whole row has a consistent background.

**Data flow**: It receives a terminal line, a style, and a width. It measures the line, appends styled spaces if the line is shorter than the target width, applies the style to the line and all spans, and returns the updated line.

**Call relations**: apply_session_row_background uses this for each line in a styled session row.

*Call graph*: 1 external calls (width).


##### `render_dense_session_lines`  (lines 2602–2630)

```
fn render_dense_session_lines(
    row: &Row,
    state: &PickerState,
    is_selected: bool,
    is_expanded: bool,
    is_zebra: bool,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Renders a session in the compact one-line layout. It can also append transcript preview lines if the session is expanded.

**Data flow**: It receives the row, picker state, visual flags, and width. It chooses the displayed date based on the active sort order, builds a dense summary line, and optionally adds expanded transcript lines. It returns the lines for the row.

**Call relations**: render_session_lines calls this in dense mode. It uses dense_summary_line for the main row and render_transcript_preview_lines for expanded content.

*Call graph*: calls 3 internal fn (format_relative_time, render_transcript_preview_lines, selection_marker); called by 2 (render_session_lines, dense_session_line_prefers_thread_name_over_preview); 1 external calls (vec!).


##### `dense_summary_line`  (lines 2641–2673)

```
fn dense_summary_line(input: DenseSummaryInput<'_>) -> Line<'static>
```

**Purpose**: Builds the single-line dense summary for a session: marker, date, and title. It also fills the full row background for selected or zebra-striped rows.

**Data flow**: It receives a DenseSummaryInput containing text, widths, and visual flags. It calculates column widths, truncates and pads date/title text, applies selected styling when needed, and returns one terminal line.

**Call relations**: render_dense_session_lines uses this as the main dense row renderer, and tests call it directly to confirm full-width styling.

*Call graph*: calls 5 internal fn (dense_column_text, dense_columns, dense_selected_style, dense_zebra_style, selected_session_title_span); called by 2 (dense_selected_summary_line_uses_full_width_selection_style, dense_zebra_summary_line_uses_full_width_background); 2 external calls (from, vec!).


##### `dense_columns`  (lines 2680–2686)

```
fn dense_columns(width: usize) -> DenseColumns
```

**Purpose**: Splits the available dense row width into a fixed date column and a remaining title column.

**Data flow**: It receives the width left after the selection marker. It assigns the standard date width and gives the rest to the title, never going below zero. It returns those two widths.

**Call relations**: dense_summary_line calls this before laying out the dense row.

*Call graph*: called by 1 (dense_summary_line).


##### `dense_zebra_style`  (lines 2688–2690)

```
fn dense_zebra_style() -> Style
```

**Purpose**: Returns the background style used for alternating dense rows. This subtle striping helps the eye track rows across the terminal.

**Data flow**: It takes no input. It asks dense_row_background_style for the non-selected background and returns that style.

**Call relations**: dense_summary_line and render_comfortable_session_lines use this when a row is not selected but should get alternating background color.

*Call graph*: calls 1 internal fn (dense_row_background_style); called by 2 (dense_summary_line, render_comfortable_session_lines).


##### `dense_selected_style`  (lines 2692–2694)

```
fn dense_selected_style() -> Style
```

**Purpose**: Returns the style used for the selected row. It combines the selected text color with a selected-row background.

**Data flow**: It takes no input. It gets the selected text style, patches in the selected background style, and returns the combined style.

**Call relations**: dense_summary_line and render_comfortable_session_lines use this to make the current selection stand out.

*Call graph*: calls 2 internal fn (dense_row_background_style, selected_session_style); called by 2 (dense_summary_line, render_comfortable_session_lines).


##### `dense_row_background_style`  (lines 2696–2706)

```
fn dense_row_background_style(selected: bool) -> Style
```

**Purpose**: Chooses a subtle row background color that works on light and dark terminal themes. Selected rows get a stronger tint than normal zebra rows.

**Data flow**: It receives a boolean saying whether the row is selected. It reads the default background, blends in a small amount of black or white depending on theme brightness, and returns a background style. If no background is known, it returns the default style.

**Call relations**: dense_zebra_style and dense_selected_style call this to get their background colors.

*Call graph*: calls 4 internal fn (blend, is_light, best_color, default_bg); called by 2 (dense_selected_style, dense_zebra_style); 1 external calls (default).


##### `dense_column_text`  (lines 2708–2712)

```
fn dense_column_text(text: &str, width: usize) -> String
```

**Purpose**: Prepares text for a fixed-width dense column. It shortens long text and pads short text so the next column starts in the right place.

**Data flow**: It receives text and a desired width. It truncates the text to fit, measures its display width, adds spaces for padding, and returns the padded string.

**Call relations**: dense_summary_line calls this for the date and title columns.

*Call graph*: calls 1 internal fn (truncate_text); called by 1 (dense_summary_line); 2 external calls (width, format!).


##### `selection_marker`  (lines 2714–2720)

```
fn selection_marker(is_selected: bool, is_expanded: bool) -> Span<'static>
```

**Purpose**: Creates the small marker at the start of each session row. It shows a different symbol when the selected row is expanded.

**Data flow**: It receives flags for selected and expanded. It returns a styled down marker for selected-expanded, a styled pointer for selected-collapsed, or two blank spaces for unselected rows.

**Call relations**: Both comfortable and dense row renderers call this before drawing a session. Tests also use it when checking dense row styling.

*Call graph*: calls 1 internal fn (selected_session_style); called by 4 (render_comfortable_session_lines, render_dense_session_lines, dense_selected_summary_line_uses_full_width_selection_style, dense_zebra_summary_line_uses_full_width_background).


##### `selected_session_style`  (lines 2722–2728)

```
fn selected_session_style() -> Style
```

**Purpose**: Chooses the foreground color for selected session text. It uses a color that contrasts with the terminal’s background.

**Data flow**: It checks whether the default background is light. On light themes it uses magenta; otherwise it uses yellow. It returns the style.

**Call relations**: selection_marker, selected_session_title_span, and dense_selected_style all build on this selected-row color.

*Call graph*: calls 1 internal fn (default_bg); called by 3 (dense_selected_style, selected_session_title_span, selection_marker); 1 external calls (default).


##### `selected_session_title_span`  (lines 2730–2732)

```
fn selected_session_title_span(title: String) -> Span<'static>
```

**Purpose**: Turns a selected session title into a styled terminal span.

**Data flow**: It receives the already-truncated title string. It applies the selected session style and returns the styled span.

**Call relations**: Comfortable and dense summary renderers call this when the row is selected.

*Call graph*: calls 1 internal fn (selected_session_style); called by 2 (dense_summary_line, render_comfortable_session_lines).


##### `render_footer_lines`  (lines 2734–2753)

```
fn render_footer_lines(
    sort_key: ThreadSortKey,
    created: &str,
    updated: &str,
    branch: Option<&str>,
    cwd: Option<&str>,
    show_cwd: bool,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Builds the small metadata lines shown under a session in comfortable mode. It shows the active sort time first, then optional directory and branch information.

**Data flow**: It receives the sort key, created and updated time labels, optional branch, optional current directory, a flag for showing the directory, and width. It chooses the active date, creates footer parts, and packs them into one or more terminal lines. It returns those lines.

**Call relations**: render_comfortable_session_lines calls this for collapsed comfortable rows. Several tests call it directly to verify ordering, truncation, and missing metadata wording.

*Call graph*: calls 1 internal fn (pack_footer_parts); called by 6 (render_comfortable_session_lines, footer_branch_expands_when_line_has_room, footer_cwd_truncates_to_responsive_column, footer_marks_missing_branch, footer_omits_cwd_when_hidden, footer_prioritizes_active_sort_timestamp); 3 external calls (Branch, Cwd, vec!).


##### `FooterPart::text`  (lines 2762–2769)

```
fn text(&self) -> &str
```

**Purpose**: Returns the visible text for one footer metadata part. It supplies friendly placeholder text when branch or directory data is missing.

**Data flow**: It reads the FooterPart value. Dates return their date text, present branch or directory parts return their stored text, and missing values return “no branch” or “no cwd”.

**Call relations**: footer_part_width and push_footer_part call this while measuring and rendering footer metadata.

*Call graph*: called by 2 (footer_part_width, push_footer_part).


##### `FooterPart::prefix`  (lines 2771–2777)

```
fn prefix(&self) -> Option<&'static str>
```

**Purpose**: Returns the icon-like prefix for a metadata part. Dates have no icon, while branch and directory parts do.

**Data flow**: It reads the FooterPart kind. It returns no prefix for dates, the branch icon for branch parts, and the directory icon for current-directory parts.

**Call relations**: footer_part_width and push_footer_part call this so measuring and rendering agree on the same prefixes.

*Call graph*: called by 2 (footer_part_width, push_footer_part).


##### `pack_footer_parts`  (lines 2780–2810)

```
fn pack_footer_parts(parts: Vec<FooterPart>, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Fits footer metadata parts into the available width, splitting them across lines if necessary. This keeps long paths or branch names from breaking the row layout.

**Data flow**: It receives footer parts and the row width. It computes available space and a responsive directory column width. If all parts fit on one line, it returns one line. Otherwise it groups parts into multiple lines that each fit. It returns the packed lines.

**Call relations**: render_footer_lines calls this after choosing which metadata parts should be shown. It uses footer_parts_width to test fit and footer_line to render each packed group.

*Call graph*: calls 3 internal fn (cwd_column_width, footer_line, footer_parts_width); called by 1 (render_footer_lines); 4 external calls (new, with_capacity, take, vec!).


##### `cwd_column_width`  (lines 2812–2817)

```
fn cwd_column_width(width: usize) -> usize
```

**Purpose**: Chooses a reasonable width for the current-directory column in the session metadata footer. It grows and shrinks with the terminal while staying within minimum and maximum bounds.

**Data flow**: It receives the full row width. It subtracts the known space needed for indentation, date, and gaps, then uses about half of the remaining space, clamped to allowed limits. It returns that width.

**Call relations**: pack_footer_parts calls this before measuring and rendering footer parts.

*Call graph*: called by 1 (pack_footer_parts).


##### `footer_parts_width`  (lines 2819–2826)

```
fn footer_parts_width(parts: &[FooterPart], cwd_width: usize) -> usize
```

**Purpose**: Measures the total width needed for a set of footer metadata parts. This tells the packer whether the parts fit on one line.

**Data flow**: It receives parts and the chosen directory column width. It sums each part’s measured width plus the indent. It returns the total width.

**Call relations**: pack_footer_parts calls this when deciding whether to keep adding parts to the current line or start a new one.

*Call graph*: called by 1 (pack_footer_parts); 1 external calls (iter).


##### `footer_part_width`  (lines 2828–2838)

```
fn footer_part_width(part: &FooterPart, padded: bool, cwd_width: usize) -> usize
```

**Purpose**: Measures one footer metadata part, including its icon, gap, text, and any reserved padding. Accurate measurement prevents visual overflow.

**Data flow**: It receives a part, whether it should reserve padding because more parts follow, and the directory column width. It calculates prefix and text widths, then returns either the actual width or a padded width for date/current-directory columns.

**Call relations**: footer_parts_width calls this for each part. It relies on FooterPart::prefix and FooterPart::text so measurement matches rendering.

*Call graph*: calls 2 internal fn (prefix, text); 2 external calls (width, from).


##### `footer_line`  (lines 2840–2869)

```
fn footer_line(parts: Vec<FooterPart>, width: usize, cwd_width: usize) -> Line<'static>
```

**Purpose**: Turns a group of footer metadata parts into one styled terminal line. It adds indentation, gaps, padding, icons, and truncated text.

**Data flow**: It receives parts, total width, and directory column width. It walks through the parts, inserts gaps, chooses target widths for padded columns, asks push_footer_part to render each piece, and tracks remaining space. It returns the assembled line.

**Call relations**: pack_footer_parts calls this for each group of parts that should appear on the same line.

*Call graph*: calls 1 internal fn (push_footer_part); called by 1 (pack_footer_parts); 1 external calls (vec!).


##### `push_footer_part`  (lines 2871–2910)

```
fn push_footer_part(
    spans: &mut Vec<Span<'static>>,
    part: FooterPart,
    target_width: Option<usize>,
    available_width: usize,
) -> usize
```

**Purpose**: Appends one metadata part to a footer line while respecting the space left. It handles icons, missing values, and truncation.

**Data flow**: It receives the span list being built, a footer part, an optional target width, and available width. It adds the prefix if any, adds a separating space, truncates the text to fit, styles missing values in italic, and returns how much width was used.

**Call relations**: footer_line calls this for each footer part. It uses FooterPart::prefix and FooterPart::text to render the same content that measurement expected.

*Call graph*: calls 3 internal fn (prefix, text, truncate_text); called by 1 (footer_line); 1 external calls (width).


##### `render_transcript_preview_lines`  (lines 2912–2939)

```
fn render_transcript_preview_lines(
    row: &Row,
    state: &PickerState,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Builds the expanded area shown under a session, including metadata and any recent transcript preview. It shows loading and error messages when preview data is not ready.

**Data flow**: It receives a row, picker state, and width. It starts with expanded session details. If the row has a thread id, it looks up the transcript preview state and appends loading text, failure text, rendered conversation lines, or nothing. It returns all expanded lines.

**Call relations**: Both comfortable and dense session renderers call this when the selected row is expanded. It delegates metadata to render_expanded_session_details and loaded transcript content to render_conversation_preview_lines.

*Call graph*: calls 2 internal fn (render_conversation_preview_lines, render_expanded_session_details); called by 2 (render_comfortable_session_lines, render_dense_session_lines); 2 external calls (new, vec!).


##### `render_expanded_session_details`  (lines 2941–2978)

```
fn render_expanded_session_details(
    row: &Row,
    state: &PickerState,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Creates the metadata block shown before an expanded transcript preview. It gives the user concrete context about which session is open.

**Data flow**: It receives the row, state, and width. It builds display strings for session name/id, created and updated times, directory, and branch, using placeholders for missing values. It returns styled detail lines plus a “Conversation:” heading.

**Call relations**: render_transcript_preview_lines calls this first for any expanded row. Tests call it directly to verify that important metadata appears.

*Call graph*: called by 2 (render_transcript_preview_lines, expanded_session_details_include_metadata); 2 external calls (format!, vec!).


##### `render_conversation_preview_lines`  (lines 2980–3011)

```
fn render_conversation_preview_lines(
    lines: &[TranscriptPreviewLine],
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Renders recent transcript preview messages with tree-like connector prefixes. It also shows a friendly message if there is no preview content.

**Data flow**: It receives transcript preview lines and width. If the input is empty, it returns one “No transcript preview available” line. Otherwise it renders each transcript line, then prefixes each output line with either a vertical connector or final connector. It returns the finished lines.

**Call relations**: render_transcript_preview_lines calls this when transcript preview data is loaded. It uses render_transcript_content_lines for each message and prefix_transcript_line for the connector prefix.

*Call graph*: calls 1 internal fn (render_transcript_content_lines); called by 1 (render_transcript_preview_lines); 3 external calls (new, is_empty, vec!).


##### `render_transcript_content_lines`  (lines 3013–3032)

```
fn render_transcript_content_lines(line: &TranscriptPreviewLine, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Turns one transcript preview message into styled, wrapped terminal lines. User and assistant messages get different visual treatment.

**Data flow**: It receives a transcript message and the full row width. It reserves space for the connector prefix, styles user text directly, renders assistant text as markdown, applies speaker-specific colors, wraps the result to the content width, and returns the wrapped lines.

**Call relations**: render_conversation_preview_lines calls this for each preview message. It uses conversation_content_line plus user or assistant style helpers.

*Call graph*: calls 5 internal fn (append_markdown, conversation_assistant_style, conversation_content_line, new, adaptive_wrap_lines); called by 1 (render_conversation_preview_lines); 3 external calls (new, clone, vec!).


##### `conversation_content_line`  (lines 3034–3040)

```
fn conversation_content_line(mut line: Line<'static>, style: Style) -> Line<'static>
```

**Purpose**: Applies a speaker style to every part of a transcript line. This keeps markdown spans and plain text visually consistent.

**Data flow**: It receives a terminal line and a style. It patches the line’s style and each span’s style, then returns the updated line.

**Call relations**: render_transcript_content_lines uses this after creating user or assistant message lines.

*Call graph*: called by 1 (render_transcript_content_lines).


##### `prefix_transcript_line`  (lines 3042–3046)

```
fn prefix_transcript_line(prefix: &'static str, line: Line<'static>) -> Line<'static>
```

**Purpose**: Adds the tree-style connector prefix in front of a rendered transcript line. The prefix borrows color from the content so it feels attached to that message.

**Data flow**: It receives a prefix string and a content line. It chooses a prefix style from the content, places the prefix before the line’s spans, keeps the line style, and returns the combined line.

**Call relations**: render_conversation_preview_lines calls this after wrapping transcript content.

*Call graph*: 2 external calls (from, vec!).


##### `transcript_prefix_style`  (lines 3048–3056)

```
fn transcript_prefix_style(line: &Line<'_>) -> Style
```

**Purpose**: Finds a suitable style for a transcript connector prefix based on the first non-empty content span. This avoids drawing connectors in a mismatched color.

**Data flow**: It receives a line. It looks for the first span with visible content, combines that span’s style with the line style, and strips it down to foreground and background color. It returns that connector style.

**Call relations**: prefix_transcript_line calls this before adding the connector prefix. It delegates final cleanup to connector_style_from_content.

*Call graph*: calls 1 internal fn (connector_style_from_content).


##### `connector_style_from_content`  (lines 3058–3064)

```
fn connector_style_from_content(style: Style) -> Style
```

**Purpose**: Creates a simple connector style from message content style. It keeps only foreground and background colors and drops other effects like bold or italic.

**Data flow**: It receives a style. It copies the foreground and background into a fresh default style and returns it.

**Call relations**: transcript_prefix_style calls this after choosing the content style to copy from.

*Call graph*: called by 1 (transcript_prefix_style); 1 external calls (default).


##### `conversation_assistant_style`  (lines 3066–3072)

```
fn conversation_assistant_style() -> Style
```

**Purpose**: Chooses the color for assistant transcript preview text. It uses a subdued gray that works on light and dark backgrounds.

**Data flow**: It checks the default terminal background. On light backgrounds it uses gray; on dark backgrounds it uses dark gray. It returns the style.

**Call relations**: render_transcript_content_lines calls this when styling assistant messages.

*Call graph*: calls 1 internal fn (default_bg); called by 1 (render_transcript_content_lines); 1 external calls (default).


##### `conversation_user_style`  (lines 3074–3080)

```
fn conversation_user_style() -> Style
```

**Purpose**: Chooses the style for user transcript preview text. User messages are italic and use a gray tone adjusted for the terminal theme.

**Data flow**: It checks the default terminal background. On light backgrounds it uses dark gray italic text; on dark backgrounds it uses gray italic text. It returns the style.

**Call relations**: render_transcript_content_lines calls this when styling user messages.

*Call graph*: calls 1 internal fn (default_bg); 1 external calls (default).


##### `expanded_detail_line`  (lines 3082–3096)

```
fn expanded_detail_line(label: &'static str, value: &str, width: u16) -> Line<'static>
```

**Purpose**: Builds one labeled line in the expanded session details block. It keeps labels aligned and truncates long values to the available space.

**Data flow**: It receives a label, value, and width. It calculates how much space the value can use after the connector, label column, and gap, truncates the value, and returns a styled line.

**Call relations**: render_expanded_session_details uses this for most detail rows, and expanded_time_detail_line uses it after formatting time values.

*Call graph*: called by 1 (expanded_time_detail_line); 1 external calls (vec!).


##### `expanded_time_detail_line`  (lines 3098–3113)

```
fn expanded_time_detail_line(
    label: &'static str,
    reference: DateTime<Utc>,
    ts: Option<DateTime<Utc>>,
    width: u16,
) -> Line<'static>
```

**Purpose**: Builds an expanded detail line for a timestamp. It shows both a friendly relative time and an exact timestamp.

**Data flow**: It receives a label, reference time, optional timestamp, and width. If the timestamp is missing, it renders “-”. Otherwise it formats “how long ago” plus the exact date and passes that value to expanded_detail_line. It returns the detail line.

**Call relations**: render_expanded_session_details calls this for created and updated times.

*Call graph*: calls 1 internal fn (expanded_detail_line); 1 external calls (format!).


##### `format_relative_time`  (lines 3115–3136)

```
fn format_relative_time(reference: DateTime<Utc>, ts: Option<DateTime<Utc>>) -> String
```

**Purpose**: Formats a timestamp as a short age like “now”, “5m ago”, or “2d ago”. This makes session ages easy to scan in the list.

**Data flow**: It receives a reference time and an optional timestamp. Missing timestamps become “-”. Otherwise it calculates elapsed seconds, clamps future times to zero, chooses seconds, minutes, hours, or days, and returns a short string.

**Call relations**: Comfortable and dense row renderers call this for session metadata. Tests call it to verify edge cases such as zero seconds.

*Call graph*: called by 2 (render_comfortable_session_lines, render_dense_session_lines); 1 external calls (format!).


##### `format_relative_time_long`  (lines 3138–3155)

```
fn format_relative_time_long(reference: DateTime<Utc>, ts: DateTime<Utc>) -> String
```

**Purpose**: Formats a timestamp as a wordier age like “20 minutes ago”. This is used where there is more room, such as expanded details.

**Data flow**: It receives a reference time and timestamp. It calculates elapsed time, chooses the largest useful unit, and returns a grammatically correct phrase.

**Call relations**: expanded_time_detail_line uses this before pairing the relative time with an exact timestamp. It calls plural_time for singular and plural wording.

*Call graph*: calls 1 internal fn (plural_time).


##### `plural_time`  (lines 3157–3163)

```
fn plural_time(value: i64, unit: &str) -> String
```

**Purpose**: Builds a correctly pluralized time phrase. It avoids awkward text like “1 minutes ago”.

**Data flow**: It receives a number and a unit word. If the number is one, it returns “1 unit ago”; otherwise it adds “s” to the unit. It returns the phrase.

**Call relations**: format_relative_time_long calls this for seconds, minutes, hours, and days.

*Call graph*: called by 1 (format_relative_time_long); 1 external calls (format!).


##### `format_timestamp`  (lines 3165–3167)

```
fn format_timestamp(ts: DateTime<Utc>) -> String
```

**Purpose**: Formats an exact UTC timestamp for display in expanded details.

**Data flow**: It receives a timestamp. It formats it as year-month-day and 24-hour time, then returns the string.

**Call relations**: expanded_time_detail_line uses this alongside the long relative time.

*Call graph*: 1 external calls (format).


##### `render_empty_state_line`  (lines 3169–3194)

```
fn render_empty_state_line(state: &PickerState) -> Line<'static>
```

**Purpose**: Chooses the message shown when the session list has no visible rows. It explains whether the picker is searching, loading, capped, empty, or has no matches.

**Data flow**: It reads the picker state, including search text, search activity, pagination state, scan cap, and loaded rows. It returns one styled terminal line with the most accurate status message.

**Call relations**: render_list calls this when there are no filtered rows to display.

*Call graph*: called by 1 (render_list); 2 external calls (format!, vec!).


##### `tests::page`  (lines 3217–3229)

```
fn page(
        rows: Vec<Row>,
        next_cursor: Option<&str>,
        num_scanned_files: usize,
        reached_scan_cap: bool,
    ) -> PickerPage
```

**Purpose**: Creates a fake page of picker results for tests. It keeps test setup short and consistent.

**Data flow**: It receives rows, an optional cursor string, scanned file count, and scan-cap flag. It wraps the cursor in the app-server cursor type when present and returns a PickerPage.

**Call relations**: Test cases use this helper when they need to simulate loaded pages without contacting real storage or a server.


##### `tests::page_only_loader`  (lines 3231–3237)

```
fn page_only_loader(loader: impl Fn(PageLoadRequest) + Send + Sync + 'static) -> PickerLoader
```

**Purpose**: Creates a fake picker loader that only reacts to page-load requests. This lets tests observe or control pagination without implementing every loader path.

**Data flow**: It receives a test callback. It returns a shared loader function that checks incoming requests and calls the callback only when the request is for a page.

**Call relations**: Many tests pass this into PickerState::new so they can build a picker state without a real backend.

*Call graph*: 1 external calls (new).


##### `tests::make_row`  (lines 3239–3251)

```
fn make_row(path: &str, ts: &str, preview: &str) -> Row
```

**Purpose**: Builds a simple test session row with a path, timestamp, and preview text. It reduces repeated boilerplate in tests.

**Data flow**: It receives a path, timestamp string, and preview. It parses the timestamp and fills a Row with matching created and updated times, leaving optional metadata empty. It returns the row.

**Call relations**: Footer progress tests use this to create predictable lists of rows.

*Call graph*: calls 1 internal fn (parse_timestamp_str); 1 external calls (from).


##### `tests::footer_lines_text`  (lines 3253–3259)

```
fn footer_lines_text(state: &PickerState, width: u16) -> String
```

**Purpose**: Converts footer hint lines into plain text for assertions. This makes tests easy to read.

**Data flow**: It receives picker state and width. It calls footer_hint_lines, converts each terminal line to a string, joins them with newlines, and returns the text.

**Call relations**: Footer hint tests use this helper instead of inspecting styled spans directly.

*Call graph*: calls 1 internal fn (footer_hint_lines).


##### `tests::footer_snapshot`  (lines 3261–3283)

```
fn footer_snapshot(state: &PickerState, width: u16, list_height: u16) -> String
```

**Purpose**: Renders the picker footer into a fake terminal and returns its text snapshot. This tests the final screen output rather than just individual strings.

**Data flow**: It receives picker state, terminal width, and list height. It creates a VT100-style test terminal, calls render_picker_footer, flushes the terminal, trims line endings, and returns the rendered text.

**Call relations**: Snapshot tests call this to verify wide and compact footer layouts.

*Call graph*: calls 3 internal fn (with_options, render_picker_footer, new); 1 external calls (new).


##### `tests::row_display_preview_prefers_thread_name`  (lines 3286–3299)

```
fn row_display_preview_prefers_thread_name()
```

**Purpose**: Verifies that a row shows its thread name instead of the first-message preview when a thread name exists.

**Data flow**: It builds a row with both a preview and a thread name. It calls row.display_preview and asserts that the result is the thread name.

**Call relations**: The test runner calls this to protect the display-name behavior used by session row renderers.

*Call graph*: 3 external calls (from, from, assert_eq!).


##### `tests::local_picker_thread_list_params_include_cwd_filter`  (lines 3302–3321)

```
fn local_picker_thread_list_params_include_cwd_filter()
```

**Purpose**: Checks that local picker requests include a current-directory filter when appropriate. This keeps local session lists scoped to the current project.

**Data flow**: It builds a cwd filter for a local project, passes it into thread_list_params, and asserts that the resulting request asks for exactly that directory.

**Call relations**: The test runner calls this to protect request-building behavior used before sessions are loaded.

*Call graph*: calls 2 internal fn (picker_cwd_filter, thread_list_params); 4 external calls (new, from, assert_eq!, MatchDefault).


##### `tests::row_search_matches_metadata_fields`  (lines 3324–3341)

```
fn row_search_matches_metadata_fields()
```

**Purpose**: Verifies that searching a row checks metadata, not just preview text. Users can find sessions by directory, branch, or thread id.

**Data flow**: It builds a row with a thread id, name, cwd, and branch. It calls matches_query with pieces of the directory, branch, and id, and asserts all match.

**Call relations**: The test runner calls this to protect the row filtering logic used by the picker search.

*Call graph*: calls 1 internal fn (from_string); 3 external calls (from, from, assert!).


##### `tests::relative_time_formats_zero_seconds_as_now`  (lines 3344–3354)

```
fn relative_time_formats_zero_seconds_as_now()
```

**Purpose**: Checks that short relative time formatting says “now” for exact matches and seconds for nearby past times.

**Data flow**: It creates a fixed reference time, formats the same time and one second earlier, and compares the strings to expected values.

**Call relations**: The test runner calls this to protect format_relative_time, which is used in list rows.

*Call graph*: 2 external calls (parse_from_rfc3339, assert_eq!).


##### `tests::long_relative_time_uses_words`  (lines 3357–3371)

```
fn long_relative_time_uses_words()
```

**Purpose**: Checks that expanded-detail relative times use full words and correct singular/plural wording.

**Data flow**: It creates a fixed reference time, formats several past times with format_relative_time_long, and asserts the expected phrases.

**Call relations**: The test runner calls this to protect expanded_time_detail_line’s user-facing wording.

*Call graph*: 2 external calls (parse_from_rfc3339, assert_eq!).


##### `tests::expanded_session_details_include_metadata`  (lines 3374–3414)

```
fn expanded_session_details_include_metadata()
```

**Purpose**: Verifies that expanded session details include all key metadata: session name/id, times, directory, branch, and conversation heading.

**Data flow**: It builds a picker state with a fixed reference time and a row full of metadata. It renders expanded details, converts them to text, and asserts that each expected piece appears.

**Call relations**: The test runner calls this to protect render_expanded_session_details, which expanded row rendering relies on.

*Call graph*: calls 5 internal fn (from_string, new, parse_timestamp_str, render_expanded_session_details, test_dummy); 6 external calls (from, from, assert!, format_directory_display, MatchDefault, page_only_loader).


##### `tests::footer_prioritizes_active_sort_timestamp`  (lines 3417–3445)

```
fn footer_prioritizes_active_sort_timestamp()
```

**Purpose**: Checks that the footer shows the timestamp matching the current sort order first. This prevents confusing metadata when sorting by created versus updated time.

**Data flow**: It renders footer lines once for updated sort and once for created sort. It asserts the first text differs appropriately and that directory still appears before branch.

**Call relations**: The test runner calls this to protect render_footer_lines and the footer packing helpers.

*Call graph*: calls 1 internal fn (render_footer_lines); 3 external calls (assert!, assert_eq!, assert_metadata_order).


##### `tests::footer_marks_missing_branch`  (lines 3448–3464)

```
fn footer_marks_missing_branch()
```

**Purpose**: Verifies that missing branch information is shown explicitly as “no branch”. This is clearer than silently omitting the field.

**Data flow**: It renders footer metadata with no branch and a directory. It checks that the directory and “no branch” text both appear in the expected order.

**Call relations**: The test runner calls this to protect FooterPart::text and render_footer_lines behavior for missing metadata.

*Call graph*: calls 1 internal fn (render_footer_lines); 3 external calls (assert!, assert_eq!, assert_metadata_order).


##### `tests::footer_branch_expands_when_line_has_room`  (lines 3467–3481)

```
fn footer_branch_expands_when_line_has_room()
```

**Purpose**: Checks that long branch names are not unnecessarily shortened when the terminal is wide enough.

**Data flow**: It renders a footer with a long branch and wide width, then asserts the full branch string appears.

**Call relations**: The test runner calls this to protect pack_footer_parts, footer_line, and push_footer_part from over-truncating.

*Call graph*: calls 1 internal fn (render_footer_lines); 2 external calls (assert!, assert_eq!).


##### `tests::footer_cwd_truncates_to_responsive_column`  (lines 3484–3503)

```
fn footer_cwd_truncates_to_responsive_column()
```

**Purpose**: Verifies that an overly long directory is shortened while preserving other metadata. This keeps branch information visible on normal-width terminals.

**Data flow**: It renders a footer with a long cwd and branch at width 80. It asserts the full cwd is absent, a shortened cwd with ellipsis is present, and the branch remains visible.

**Call relations**: The test runner calls this to protect cwd_column_width and footer text truncation.

*Call graph*: calls 1 internal fn (render_footer_lines); 2 external calls (assert!, assert_eq!).


##### `tests::footer_omits_cwd_when_hidden`  (lines 3506–3523)

```
fn footer_omits_cwd_when_hidden()
```

**Purpose**: Checks that the footer leaves out directory metadata when the picker is configured not to show it.

**Data flow**: It renders footer lines with show_cwd set to false. It asserts the time and branch are present while the cwd icon and path are absent.

**Call relations**: The test runner calls this to protect render_footer_lines’ show_cwd flag.

*Call graph*: calls 1 internal fn (render_footer_lines); 2 external calls (assert!, assert_eq!).


##### `tests::assert_metadata_order`  (lines 3525–3530)

```
fn assert_metadata_order(line: &Line<'_>, first: &str, second: &str)
```

**Purpose**: Test helper that checks one metadata string appears before another in a rendered line.

**Data flow**: It receives a terminal line and two expected substrings. It converts the line to text, finds both positions, and asserts the first comes earlier.

**Call relations**: Footer metadata tests call this to make ordering assertions easier to read.

*Call graph*: 2 external calls (to_string, assert!).


##### `tests::remote_thread_list_params_omit_provider_filter`  (lines 3533–3552)

```
fn remote_thread_list_params_omit_provider_filter()
```

**Purpose**: Checks that remote thread-list requests do not include a provider filter when the provider setting is “any”. It also verifies source kinds and cwd filtering.

**Data flow**: It builds thread list parameters with a cursor, cwd filter, and ProviderFilter::Any. It asserts the cursor is preserved, model providers are omitted, source kinds are set, and cwd is included.

**Call relations**: The test runner calls this to protect request-building behavior for remote session loading.

*Call graph*: calls 1 internal fn (thread_list_params); 3 external calls (new, from, assert_eq!).


##### `tests::remote_thread_list_params_can_include_non_interactive_sources`  (lines 3555–3568)

```
fn remote_thread_list_params_can_include_non_interactive_sources()
```

**Purpose**: Verifies that remote requests can include non-interactive session sources when configured to do so.

**Data flow**: It builds thread list parameters with include_non_interactive enabled. It compares the resulting source kinds to the shared resume_source_kinds helper output.

**Call relations**: The test runner calls this to protect thread_list_params behavior used by remote loading.

*Call graph*: calls 1 internal fn (thread_list_params); 3 external calls (from, assert_eq!, resume_source_kinds).


##### `tests::remote_picker_sends_cwd_filter_without_local_post_filtering`  (lines 3571–3609)

```
fn remote_picker_sends_cwd_filter_without_local_post_filtering()
```

**Purpose**: Checks that a remote picker sends the cwd filter to the server but does not also filter returned rows locally by a different resolved path.

**Data flow**: It records page-load requests through a fake loader, builds picker state with a remote cwd, starts initial loading, and asserts the request carries that cwd. Then it creates a row with a different cwd and asserts the state still accepts it locally.

**Call relations**: The test runner calls this to protect remote cwd behavior in PickerState loading and row filtering.

*Call graph*: calls 4 internal fn (new, new, local_picker_cwd_filter, test_dummy); 8 external calls (new, new, from, from, new, assert!, assert_eq!, page_only_loader).


##### `tests::remote_picker_does_not_filter_rows_by_local_cwd`  (lines 3612–3634)

```
fn remote_picker_does_not_filter_rows_by_local_cwd()
```

**Purpose**: Verifies that remote picker rows are not rejected by local current-directory filtering when no local filter is set.

**Data flow**: It creates a picker state without a cwd filter and a remote-looking row. It asserts row_matches_filter accepts the row.

**Call relations**: The test runner calls this to protect filtering behavior for remote session lists.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 4 external calls (from, from, assert!, page_only_loader).


##### `tests::resume_table_snapshot`  (lines 3637–3706)

```
fn resume_table_snapshot()
```

**Purpose**: Captures a snapshot of the rendered session list. This protects the table layout, selection marker, spacing, and relative times from accidental visual changes.

**Data flow**: It builds a picker state with three rows and fixed timestamps, renders the list into a fake terminal, flushes it, and compares the output to a stored snapshot.

**Call relations**: The test runner calls this snapshot test, which exercises render_list and the row rendering helpers together.

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 6 external calls (new, from, assert_snapshot!, MatchDefault, page_only_loader, vec!).


##### `tests::resume_search_error_snapshot`  (lines 3709–3741)

```
fn resume_search_error_snapshot()
```

**Purpose**: Captures a snapshot of the search line when an inline error is present. This protects how errors are displayed in the picker’s search area.

**Data flow**: It builds picker state with an inline error, renders the search line into a one-line fake terminal, flushes it, and compares the output to a stored snapshot.

**Call relations**: The test runner calls this to exercise search_line rendering, which is elsewhere in the same file.

*Call graph*: calls 5 internal fn (with_options, new, search_line, new, test_dummy); 5 external calls (new, from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::hint_line_switches_esc_label_for_search_mode`  (lines 3744–3760)

```
fn hint_line_switches_esc_label_for_search_mode()
```

**Purpose**: Checks that the Esc hint changes meaning when search text is present. Esc starts a new session normally at startup, but clears search while searching.

**Data flow**: It builds picker state, reads footer text, then adds a query and reads it again. It asserts the footer changes from “esc start new” to “esc clear search”.

**Call relations**: The test runner calls this to protect footer_hint_lines label selection.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert!, MatchDefault, page_only_loader).


##### `tests::hint_line_labels_cancel_keys_as_exit_for_existing_session_resume_picker`  (lines 3763–3786)

```
fn hint_line_labels_cancel_keys_as_exit_for_existing_session_resume_picker()
```

**Purpose**: Checks footer wording when the picker is opened from an existing session. In that context, canceling exits the picker rather than quitting the whole app.

**Data flow**: It builds picker state, marks the launch context as existing session, and checks wide and compact footer text for “esc exit” and “ctrl+c exit”. Then it adds a query and verifies Esc becomes “clear search”.

**Call relations**: The test runner calls this to protect context-sensitive labels in footer_hint_lines.

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (from, assert!, MatchDefault, footer_lines_text, page_only_loader).


##### `tests::hint_line_switches_density_label`  (lines 3789–3807)

```
fn hint_line_switches_density_label()
```

**Purpose**: Verifies that the density toggle hint describes the action that will happen next. If the view is comfortable, the hint says dense view; if already dense, it says comfortable view.

**Data flow**: It builds picker state, checks wide footer text in comfortable mode, then changes density to dense and checks the updated label.

**Call relations**: The test runner calls this to protect footer_hint_lines’ density-dependent wording.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert!, MatchDefault, page_only_loader).


##### `tests::hint_line_compacts_on_narrow_width`  (lines 3810–3830)

```
fn hint_line_compacts_on_narrow_width()
```

**Purpose**: Checks that footer hints use shorter labels on narrower terminals. This keeps important shortcuts visible without overflowing.

**Data flow**: It builds picker state and renders footer text at a compact width. It asserts compact labels appear and a long wide label does not.

**Call relations**: The test runner calls this to protect hint_line_for_row and fit_footer_hints compact fallback behavior.

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (from, assert!, MatchDefault, footer_lines_text, page_only_loader).


##### `tests::hint_line_snapshot_uses_distributed_wide_footer`  (lines 3833–3848)

```
fn hint_line_snapshot_uses_distributed_wide_footer()
```

**Purpose**: Captures a snapshot of the wide footer layout. This protects spacing and full-label presentation on large terminals.

**Data flow**: It builds default picker state, renders the footer into a wide fake terminal through footer_snapshot, and compares the result to a stored snapshot.

**Call relations**: The test runner calls this snapshot test, which exercises render_picker_footer and footer_hint_lines together.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::hint_line_snapshot_uses_compact_footer`  (lines 3851–3868)

```
fn hint_line_snapshot_uses_compact_footer()
```

**Purpose**: Captures a snapshot of the compact footer layout. This protects how search mode and dense mode hints appear on smaller terminals.

**Data flow**: It builds picker state with a search query and dense density, renders the footer at a compact width, and compares the output to a stored snapshot.

**Call relations**: The test runner calls this snapshot test to cover footer layout under constrained width.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::hint_line_prioritizes_keybinds_when_very_narrow`  (lines 3871–3899)

```
fn hint_line_prioritizes_keybinds_when_very_narrow()
```

**Purpose**: Checks that very narrow footers keep the key names visible even if labels must be dropped. The keybindings are the most important information.

**Data flow**: It builds dense picker state, renders footer hint lines at width 38, joins their text, and asserts every line fits and important keys are present.

**Call relations**: The test runner calls this to protect hint_line_for_row’s priority-dropping behavior.

*Call graph*: calls 3 internal fn (new, footer_hint_lines, test_dummy); 4 external calls (from, assert!, MatchDefault, page_only_loader).


##### `tests::hint_line_shows_loading_transcript_mode`  (lines 3902–3919)

```
fn hint_line_shows_loading_transcript_mode()
```

**Purpose**: Verifies that the footer changes while a transcript is being opened. During loading, it should show only loading and cancel/quit guidance, not normal picker actions.

**Data flow**: It builds picker state with a pending transcript id, renders footer text, and asserts it contains “loading transcript” and “ctrl+c quit” but not “enter”.

**Call relations**: The test runner calls this to protect the loading branch in footer_hint_lines.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 5 external calls (from, assert!, MatchDefault, footer_lines_text, page_only_loader).


##### `tests::picker_footer_percent_reports_scroll_progress`  (lines 3922–3947)

```
fn picker_footer_percent_reports_scroll_progress()
```

**Purpose**: Checks that footer scroll progress reports 0 percent at the top and 100 percent at the bottom.

**Data flow**: It builds picker state with ten rows, sets scroll_top to the start and end, and asserts picker_footer_percent returns 0 and 100 respectively.

**Call relations**: The test runner calls this for picker_footer_percent, which is elsewhere in the same file and is used by footer rendering.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::picker_footer_progress_label_shows_position_total_and_percent`  (lines 3950–3975)

```
fn picker_footer_progress_label_shows_position_total_and_percent()
```

**Purpose**: Checks that the footer progress label shows the selected row number, total rows, and percent. This helps users know where they are in a long list.

**Data flow**: It builds picker state with ten rows and selected index 2. It calls picker_footer_progress_label and asserts the label reads “3 / 10 · 0%” with no negative sign.

**Call relations**: The test runner calls this for picker_footer_progress_label, which supports the picker footer display.

*Call graph*: calls 3 internal fn (new, picker_footer_progress_label, test_dummy); 5 external calls (from, assert!, assert_eq!, MatchDefault, page_only_loader).


##### `tests::picker_footer_progress_label_uses_known_count_when_more_pages_exist`  (lines 3978–4003)

```
fn picker_footer_progress_label_uses_known_count_when_more_pages_exist()
```

**Purpose**: Checks that the footer shows the current selection and the number of already known rows when another page still exists. This matters because the picker should not pretend it knows the final total before loading all pages.

**Data flow**: The test builds a picker with 10 visible rows, selects the third row, and marks that another page can be loaded. It asks for the footer progress label and expects a label showing “3 / 10” with a low scroll percentage.

**Call relations**: The test runner calls this test. Inside it, the test creates PickerState, then calls picker_footer_progress_label to verify the text a real render would show at the bottom of the picker.

*Call graph*: calls 3 internal fn (new, picker_footer_progress_label, test_dummy); 5 external calls (from, assert_eq!, AppServer, MatchDefault, page_only_loader).


##### `tests::picker_footer_progress_label_freezes_percent_while_loading`  (lines 4006–4037)

```
fn picker_footer_progress_label_freezes_percent_while_loading()
```

**Purpose**: Checks that the footer keeps showing a previously calculated percentage while the next page is loading. This avoids a jumpy progress indicator while the list is in between states.

**Data flow**: The test creates 10 rows, selects the last one, marks pagination as pending, and stores a frozen percent of 37. It asks for the footer label and expects the count to show an ellipsis for more loading, while the percent stays at 37%.

**Call relations**: The test runner invokes it to exercise picker_footer_progress_label through a realistic PickerState. It relies on the pagination loading state to prove the footer uses the frozen value instead of recalculating.

*Call graph*: calls 3 internal fn (new, picker_footer_progress_label, test_dummy); 6 external calls (from, assert_eq!, Pending, AppServer, MatchDefault, page_only_loader).


##### `tests::picker_footer_percent_is_complete_when_not_scrollable`  (lines 4040–4059)

```
fn picker_footer_percent_is_complete_when_not_scrollable()
```

**Purpose**: Checks that the progress percent is 100% when the list does not need scrolling. A list that fits on screen should feel complete, even if it has zero or one row.

**Data flow**: The test starts with an empty picker and asks for the footer percent with a tall list area. It then adds one row and asks again; both times the answer should be 100.

**Call relations**: The test runner calls this test. It uses PickerState as input and directly exercises picker_footer_percent, the helper that the footer label depends on.

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (from, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::ctrl_o_toggles_density_without_typing_into_search`  (lines 4062–4081)

```
async fn ctrl_o_toggles_density_without_typing_into_search()
```

**Purpose**: Checks that Ctrl-O changes the picker layout density instead of adding the letter “o” to the search box. This keeps keyboard shortcuts from corrupting the user’s search text.

**Data flow**: The test creates a picker with an existing query, sends a Ctrl-O key event, and then inspects the state. The density changes to dense, while the query remains unchanged.

**Call relations**: The test runner calls it. The test goes through PickerState::handle_key, just as real keyboard input would, rather than changing the state directly.

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::ctrl_t_requests_selected_session_transcript`  (lines 4084–4124)

```
async fn ctrl_t_requests_selected_session_transcript()
```

**Purpose**: Checks that Ctrl-T asks for the transcript of the selected session. It also verifies that the picker enters a loading state before showing the transcript.

**Data flow**: The test installs a fake loader that records transcript requests, creates one selected row with a thread id, and sends Ctrl-T. The loader receives that thread id, the picker marks the transcript as loading, and it remembers that this transcript should open when ready.

**Call relations**: The test runner calls it. The flow goes through PickerState::handle_key, which sends a PickerLoadRequest::Transcript to the loader and updates transcript-related state.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 10 external calls (new, Char, new, new, from, new, assert!, assert_eq!, MatchDefault, vec!).


##### `tests::transcript_loading_consumes_picker_input`  (lines 4127–4178)

```
async fn transcript_loading_consumes_picker_input()
```

**Purpose**: Checks that ordinary picker input is ignored while a transcript is waiting to open. This prevents the selected row or search query from changing underneath a loading overlay.

**Data flow**: The test marks a transcript as pending, then sends Down and a normal character key. Both inputs produce no selection, leave the selected row unchanged, and leave the search query empty.

**Call relations**: The test runner invokes this case to exercise PickerState::handle_key during the special transcript-loading period. It confirms that most keys are swallowed instead of being passed into normal list or search behavior.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 8 external calls (Char, new, from, assert!, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::transcript_loading_still_allows_ctrl_c_exit`  (lines 4181–4199)

```
async fn transcript_loading_still_allows_ctrl_c_exit()
```

**Purpose**: Checks that Ctrl-C can still exit while a transcript is loading. Even during a temporary blocking state, the user must keep an emergency way out.

**Data flow**: The test marks a transcript as pending and sends Ctrl-C. The returned result is an Exit selection.

**Call relations**: The test runner calls this test. It passes through PickerState::handle_key and verifies that the exit shortcut takes priority over transcript-loading input blocking.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 6 external calls (Char, new, from, assert!, MatchDefault, page_only_loader).


##### `tests::transcript_loading_overlay_snapshot`  (lines 4202–4263)

```
fn transcript_loading_overlay_snapshot()
```

**Purpose**: Captures what the picker looks like while a transcript-loading overlay is displayed. This protects the visual design from accidental changes.

**Data flow**: The test creates a fake terminal, fills the picker with two rows, marks one transcript as pending, renders the list and the loading overlay, then turns the fake screen into text. That text is compared with a stored snapshot.

**Call relations**: The test runner calls it. The test uses render_list first, then render_transcript_loading_overlay, matching the order the real interface uses when drawing this temporary overlay.

*Call graph*: calls 7 internal fn (new, with_options, new, render_list, render_transcript_loading_overlay, new, test_dummy); 6 external calls (new, from, assert_snapshot!, MatchDefault, page_only_loader, vec!).


##### `tests::raw_ctrl_t_requests_selected_session_transcript`  (lines 4266–4300)

```
async fn raw_ctrl_t_requests_selected_session_transcript()
```

**Purpose**: Checks that the raw control character for Ctrl-T also requests a transcript. Some terminals report control keys this way, so the picker must recognize both forms.

**Data flow**: The test creates a row with a thread id and a fake loader that records transcript requests. It sends the raw Ctrl-T character and expects exactly one request for that thread id.

**Call relations**: The test runner invokes it. The path goes through PickerState::handle_key, proving the keyboard decoder accepts the raw character form as the same command.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 9 external calls (new, Char, new, new, from, new, assert_eq!, MatchDefault, vec!).


##### `tests::ctrl_t_on_row_without_thread_id_shows_inline_error`  (lines 4303–4333)

```
async fn ctrl_t_on_row_without_thread_id_shows_inline_error()
```

**Purpose**: Checks that Ctrl-T gives a clear inline error when the selected row has no transcript id. This is better than doing nothing or crashing.

**Data flow**: The test creates a selected row with a file path but no thread id, sends Ctrl-T, and checks the picker’s inline error text. The state ends with “No transcript available for this session.”

**Call relations**: The test runner calls this test. It exercises PickerState::handle_key and the user-facing error path used when a transcript cannot be requested.

*Call graph*: calls 2 internal fn (new, test_dummy); 7 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::loaded_transcript_waits_for_loading_frame_before_opening_overlay`  (lines 4336–4373)

```
async fn loaded_transcript_waits_for_loading_frame_before_opening_overlay()
```

**Purpose**: Checks that even when transcript data arrives, the picker waits until a loading frame has been drawn before opening the transcript overlay. This makes the UI transition predictable instead of flickering.

**Data flow**: The test marks a transcript as pending, feeds in a successful background transcript event, and confirms the overlay is not opened immediately. After noting that the loading frame was drawn, it asks the picker to open ready transcripts and sees the transcript overlay appear.

**Call relations**: The test runner invokes it. It drives PickerState::handle_background_event first, then note_transcript_loading_frame_drawn and open_pending_transcript_if_ready, matching the real order of background completion followed by a render cycle.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 6 external calls (from, assert!, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::cached_transcript_still_shows_loading_frame_before_opening_overlay`  (lines 4376–4419)

```
async fn cached_transcript_still_shows_loading_frame_before_opening_overlay()
```

**Purpose**: Checks that cached transcripts still show one loading frame before the overlay opens. This keeps the experience consistent whether data comes from cache or a fresh load.

**Data flow**: The test preloads transcript cells into the cache, selects that row, and sends Ctrl-T. The overlay does not open immediately; after recording that the loading frame was drawn, the pending transcript opens.

**Call relations**: The test runner calls it. It uses PickerState::handle_key to start the transcript-opening flow, then the same frame-drawn and open-ready methods used by the normal rendering loop.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 9 external calls (Char, new, from, assert!, assert_eq!, MatchDefault, Loaded, page_only_loader, vec!).


##### `tests::ctrl_o_persists_density_preference`  (lines 4422–4451)

```
async fn ctrl_o_persists_density_preference()
```

**Purpose**: Checks that Ctrl-O not only changes the layout density but also saves that choice to the user’s config file. This lets the picker remember the preferred view next time.

**Data flow**: The test points persistence at a temporary home directory, sends Ctrl-O, and reads the generated config file. The state becomes dense and the file contains the saved session picker view setting.

**Call relations**: The test runner invokes it. It exercises PickerState::handle_key together with SessionPickerViewPersistence, proving the shortcut connects UI state to disk-backed preference saving.

*Call graph*: calls 2 internal fn (new, test_dummy); 8 external calls (Char, new, from, assert_eq!, read_to_string, tempdir, MatchDefault, page_only_loader).


##### `tests::ctrl_o_keeps_toggled_density_when_persistence_fails`  (lines 4454–4485)

```
async fn ctrl_o_keeps_toggled_density_when_persistence_fails()
```

**Purpose**: Checks that a failed save does not undo the user’s density change. The picker should still respond immediately, while showing an error about the failed preference write.

**Data flow**: The test points persistence at a path that is a file rather than a directory, then sends Ctrl-O. The picker switches to dense and records an inline error saying the view mode could not be saved.

**Call relations**: The test runner calls this case. It drives PickerState::handle_key through the persistence failure path and verifies both the visible state change and the user-facing warning.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (Char, new, from, assert!, assert_eq!, write, tempdir, MatchDefault, page_only_loader).


##### `tests::raw_ctrl_o_toggles_density_without_typing_into_search`  (lines 4488–4507)

```
async fn raw_ctrl_o_toggles_density_without_typing_into_search()
```

**Purpose**: Checks that the raw control character for Ctrl-O changes density without editing the search query. This supports terminals that encode Ctrl-O as a plain control character.

**Data flow**: The test starts with the query “pick”, sends the raw Ctrl-O character, and then reads the picker state. Density changes to dense and the query remains “pick.”

**Call relations**: The test runner calls it. The behavior is verified through PickerState::handle_key, the same route used for real key input.

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::space_appends_to_search_query`  (lines 4510–4533)

```
async fn space_appends_to_search_query()
```

**Purpose**: Checks that a space key is treated as normal search text. This lets users type multi-word searches.

**Data flow**: The test starts with the query “resize”, sends Space and then “r”. The query becomes “resize r”, and no row expansion is triggered.

**Call relations**: The test runner invokes it. It passes ordinary character input through PickerState::handle_key to confirm it goes to the search query rather than to command handling.

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::ctrl_e_toggles_selected_session_expansion`  (lines 4536–4578)

```
async fn ctrl_e_toggles_selected_session_expansion()
```

**Purpose**: Checks that Ctrl-E expands the selected session to show a preview, then collapses it when pressed again. It also confirms that expanding asks the loader for preview data.

**Data flow**: The test creates a row with a thread id and a fake loader that records preview requests. The first Ctrl-E sets that thread id as expanded and sends one preview request; the second Ctrl-E clears the expansion.

**Call relations**: The test runner calls it. PickerState::handle_key connects the keyboard shortcut to preview loading and to the expanded row state.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 9 external calls (new, Char, new, new, from, new, assert_eq!, MatchDefault, vec!).


##### `tests::raw_ctrl_e_toggles_selected_session_expansion`  (lines 4581–4609)

```
async fn raw_ctrl_e_toggles_selected_session_expansion()
```

**Purpose**: Checks that the raw control character for Ctrl-E expands the selected row. This makes the shortcut work across different terminal key encodings.

**Data flow**: The test creates one row with a thread id, sends the raw Ctrl-E character, and checks that the picker marks that thread as expanded.

**Call relations**: The test runner invokes it. It exercises PickerState::handle_key to prove raw control input is mapped to the same expansion command.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 7 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::search_line_renders_sort_and_filter_tabs`  (lines 4612–4642)

```
fn search_line_renders_sort_and_filter_tabs()
```

**Purpose**: Captures the search toolbar with its sort and filter tabs. This ensures the top line of the picker keeps showing the controls users need.

**Data flow**: The test creates a picker with a current-directory filter, renders the search line into a fake one-line terminal, and compares the screen text with a snapshot.

**Call relations**: The test runner calls it. It uses search_line and the terminal test backend, mirroring the real drawing path for the picker’s search/header row.

*Call graph*: calls 5 internal fn (with_options, new, search_line, new, test_dummy); 6 external calls (from, new, from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::search_line_compacts_toolbar_on_narrow_width`  (lines 4645–4661)

```
fn search_line_compacts_toolbar_on_narrow_width()
```

**Purpose**: Checks that the search toolbar still includes filter and sort information on narrow screens. It also verifies that filter appears before sort in the compact form.

**Data flow**: The test builds a picker with a current-directory filter and asks search_line for a width of 40. It checks the resulting text for compact “Filter” and “Sort” labels in the expected order.

**Call relations**: The test runner calls it. The test directly exercises search_line, which is the helper used by rendering code to fit toolbar text into available width.

*Call graph*: calls 3 internal fn (new, search_line, test_dummy); 5 external calls (from, from, assert!, MatchDefault, page_only_loader).


##### `tests::dense_snapshot_row`  (lines 4663–4680)

```
fn dense_snapshot_row() -> Row
```

**Purpose**: Builds a representative session row used by dense-layout snapshot tests. Having one shared row keeps those tests focused on layout differences instead of repeated setup.

**Data flow**: The function returns a Row with a path, preview text, thread id, timestamps, working directory, and git branch. Nothing outside is changed.

**Call relations**: Other tests in this module call it when they need consistent dense-row input for render_dense_row_snapshot or direct dense-line rendering.

*Call graph*: calls 2 internal fn (from_string, parse_timestamp_str); 2 external calls (from, from).


##### `tests::render_dense_row_snapshot`  (lines 4682–4718)

```
fn render_dense_row_snapshot(
        show_all: bool,
        filter_cwd: Option<PathBuf>,
        width: u16,
    ) -> String
```

**Purpose**: Renders one dense session row into a fake terminal and returns the screen text. Tests use it as a small picture-making helper for different filter and width situations.

**Data flow**: The function receives whether the picker is showing all sessions, an optional current-directory filter, and a terminal width. It builds state, switches to dense layout, renders the list, flushes the fake terminal, and returns the rendered text.

**Call relations**: Several dense snapshot tests call this helper. It hands setup off to dense_snapshot_row, PickerState::new, and render_list so each snapshot test can stay short.

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 6 external calls (new, from, MatchDefault, dense_snapshot_row, page_only_loader, vec!).


##### `tests::dense_session_snapshot_omits_cwd_in_cwd_filter`  (lines 4721–4732)

```
fn dense_session_snapshot_omits_cwd_in_cwd_filter()
```

**Purpose**: Checks that dense rows omit the working directory when the picker is already filtered to that directory. Showing the same directory again would waste space.

**Data flow**: The test renders a dense row with a current-directory filter matching the row’s directory. The returned screen text is compared with a stored snapshot.

**Call relations**: The test runner calls it. It relies on render_dense_row_snapshot to produce the fake terminal output used for snapshot comparison.

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_snapshot_includes_cwd_in_all_filter`  (lines 4735–4742)

```
fn dense_session_snapshot_includes_cwd_in_all_filter()
```

**Purpose**: Checks that dense rows include the working directory when viewing all sessions. In the all-sessions view, the directory helps users tell projects apart.

**Data flow**: The test renders a dense row with no current-directory filter and a wide terminal. The output is compared with a stored snapshot.

**Call relations**: The test runner invokes it. It uses render_dense_row_snapshot to exercise the normal render_list path.

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_snapshot_auto_hides_cwd_when_narrow`  (lines 4745–4752)

```
fn dense_session_snapshot_auto_hides_cwd_when_narrow()
```

**Purpose**: Checks that dense layout can hide the working directory automatically when space is tight. This keeps the main session title readable on narrower screens.

**Data flow**: The test renders the dense all-sessions view at a medium width and compares the fake terminal output to a snapshot. The expected picture omits or reduces directory metadata as needed.

**Call relations**: The test runner calls it. render_dense_row_snapshot supplies the consistent state and terminal rendering used by this visual regression test.

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_snapshot_forces_cwd_when_narrow`  (lines 4755–4762)

```
fn dense_session_snapshot_forces_cwd_when_narrow()
```

**Purpose**: Checks the very narrow dense-row layout where the renderer must make hard choices about what metadata to show. It protects the intended fallback layout.

**Data flow**: The test renders the dense all-sessions view at width 48 and compares the output to a snapshot. The snapshot records how the row is squeezed into that width.

**Call relations**: The test runner invokes it. It calls render_dense_row_snapshot, which in turn uses render_list to exercise the real dense rendering code.

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_snapshot_drops_metadata_when_narrow`  (lines 4765–4772)

```
fn dense_session_snapshot_drops_metadata_when_narrow()
```

**Purpose**: Checks that dense rows drop less important metadata on narrow screens. The goal is to preserve the most useful information instead of overflowing.

**Data flow**: The test renders a dense row at width 48 and compares the fake terminal output with a snapshot. The snapshot captures which details are kept or removed.

**Call relations**: The test runner calls it. It uses the shared render_dense_row_snapshot helper to keep the setup identical to other dense layout tests.

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_line_prefers_thread_name_over_preview`  (lines 4775–4803)

```
fn dense_session_line_prefers_thread_name_over_preview()
```

**Purpose**: Checks that a saved thread name is shown instead of the raw preview text in dense layout. A name is usually a better human label for the session.

**Data flow**: The test modifies a sample row to have both a preview and a thread name, renders dense session lines, and joins them into text. The text must contain the name and not the preview.

**Call relations**: The test runner invokes it. It calls render_dense_session_lines directly to focus on the row text choice without involving a whole terminal render.

*Call graph*: calls 4 internal fn (new, parse_timestamp_str, render_dense_session_lines, test_dummy); 5 external calls (from, assert!, MatchDefault, dense_snapshot_row, page_only_loader).


##### `tests::dense_selected_summary_line_uses_full_width_selection_style`  (lines 4806–4819)

```
fn dense_selected_summary_line_uses_full_width_selection_style()
```

**Purpose**: Checks that a selected dense summary line fills the full width and uses the selected style. This makes the highlighted row look like one continuous selection bar.

**Data flow**: The test builds a dense summary line with selected settings and width 80. It verifies the line width, foreground style, and leading selection marker.

**Call relations**: The test runner calls it. It exercises dense_summary_line and selection_marker, the small helpers used when dense rows are drawn.

*Call graph*: calls 2 internal fn (dense_summary_line, selection_marker); 1 external calls (assert_eq!).


##### `tests::dense_zebra_summary_line_uses_full_width_background`  (lines 4822–4834)

```
fn dense_zebra_summary_line_uses_full_width_background()
```

**Purpose**: Checks that alternating dense rows, often called zebra rows, paint their background across the full width. This keeps row striping visually clean.

**Data flow**: The test builds a non-selected zebra summary line at width 80. It verifies the line width and that the background color matches the dense zebra style.

**Call relations**: The test runner invokes it. It tests dense_summary_line with selection_marker to protect the styling used by render_list.

*Call graph*: calls 2 internal fn (dense_summary_line, selection_marker); 1 external calls (assert_eq!).


##### `tests::comfortable_zebra_lines_use_full_width_background`  (lines 4837–4867)

```
fn comfortable_zebra_lines_use_full_width_background()
```

**Purpose**: Checks that comfortable-layout zebra rows also fill the whole row width with their background. The wider card-like layout should not leave ragged unstyled gaps.

**Data flow**: The test creates a row and renders it in comfortable mode as a zebra row. It expects two lines, each exactly width 100 and each using the zebra background style.

**Call relations**: The test runner calls it. It exercises render_comfortable_session_lines directly, which is the renderer used for non-dense session rows.

*Call graph*: calls 4 internal fn (new, parse_timestamp_str, render_comfortable_session_lines, test_dummy); 6 external calls (from, assert!, assert_eq!, MatchDefault, make_row, page_only_loader).


##### `tests::dense_session_snapshot_uses_no_blank_lines_between_rows`  (lines 4870–4912)

```
fn dense_session_snapshot_uses_no_blank_lines_between_rows()
```

**Purpose**: Checks that dense mode packs rows without blank lines between them. Dense mode is meant to show more sessions at once.

**Data flow**: The test renders two dense rows into a two-line fake terminal, selects the second row, and compares the output with a snapshot. The expected output has one row per line.

**Call relations**: The test runner invokes it. It uses render_list through the fake terminal backend to verify the full list rendering behavior, not just a single line helper.

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 8 external calls (from, new, from, assert_snapshot!, MatchDefault, dense_snapshot_row, page_only_loader, vec!).


##### `tests::expanded_session_snapshot`  (lines 4915–4981)

```
fn expanded_session_snapshot()
```

**Purpose**: Captures the visual layout of an expanded session that shows transcript preview lines. This protects the design of the inline preview area.

**Data flow**: The test builds one row, marks it expanded, inserts loaded preview lines from user and assistant speakers, renders into a fake terminal, trims trailing spaces, and compares the result with a snapshot.

**Call relations**: The test runner calls it. The setup feeds render_list with expanded-row state and loaded transcript preview data, matching what happens after Ctrl-E and a preview load.

*Call graph*: calls 7 internal fn (from_string, with_options, new, parse_timestamp_str, render_list, new, test_dummy); 8 external calls (from, new, from, assert_snapshot!, MatchDefault, Loaded, page_only_loader, vec!).


##### `tests::narrow_session_snapshot`  (lines 4984–5031)

```
fn narrow_session_snapshot()
```

**Purpose**: Captures how a session row appears on a narrow terminal. This ensures the picker remains readable when the terminal is not wide.

**Data flow**: The test creates one session row with metadata, renders it into a fake terminal 58 columns wide, and compares the output to a snapshot.

**Call relations**: The test runner invokes it. It uses PickerState::new and render_list to test the real list renderer under constrained width.

*Call graph*: calls 7 internal fn (from_string, with_options, new, parse_timestamp_str, render_list, new, test_dummy); 7 external calls (from, new, from, assert_snapshot!, MatchDefault, page_only_loader, vec!).


##### `tests::session_list_more_indicators_snapshot`  (lines 5034–5083)

```
fn session_list_more_indicators_snapshot()
```

**Purpose**: Captures the “more above” or “more below” indicators that appear when the list is scrolled. These markers tell users there are hidden rows outside the visible area.

**Data flow**: The test creates five rows, sets selection and scroll position so not all rows are visible, updates the viewport, renders the list, and compares the fake screen to a snapshot.

**Call relations**: The test runner calls it. It drives update_viewport and render_list together, matching how scrolling state affects the real display.

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 5 external calls (new, from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::density_toggle_clears_stale_more_indicator`  (lines 5086–5140)

```
fn density_toggle_clears_stale_more_indicator()
```

**Purpose**: Checks that changing from comfortable to dense layout removes an old “more” indicator when the denser rows now fit. This prevents leftover scroll hints from lying to the user.

**Data flow**: The test renders comfortable rows and confirms the screen contains “↓ more”. It then switches to dense mode, updates the viewport, renders again, and confirms the marker is gone.

**Call relations**: The test runner invokes it. It uses update_viewport and render_list twice to simulate the state recalculation that should happen after a density change.

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 5 external calls (new, from, assert!, MatchDefault, page_only_loader).


##### `tests::pageless_scrolling_deduplicates_and_keeps_order`  (lines 5143–5195)

```
fn pageless_scrolling_deduplicates_and_keeps_order()
```

**Purpose**: Checks that loading multiple pages removes duplicate sessions while preserving the intended order. This keeps infinite scrolling from showing the same session twice.

**Data flow**: The test resets pagination, ingests three pages, including a duplicate path, then reads the previews from filtered_rows. The final list contains four unique rows in the expected order.

**Call relations**: The test runner calls it. It exercises reset_pagination and ingest_page, the same path used when background page loads return more sessions.

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (from, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::ensure_minimum_rows_prefetches_when_underfilled`  (lines 5198–5229)

```
fn ensure_minimum_rows_prefetches_when_underfilled()
```

**Purpose**: Checks that the picker asks for another page when too few rows are loaded to fill the requested minimum. This makes the screen fill itself instead of showing a sparse list when more data exists.

**Data flow**: The test records page-load requests, ingests a two-row page with a next cursor, and then asks the state to ensure 10 rows. One new load request is recorded, with no search token.

**Call relations**: The test runner invokes it. It drives ensure_minimum_rows_for_view after ingest_page to verify the automatic prefetch path.

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::ensure_minimum_rows_does_not_prefetch_when_comfortable_cards_fill_view`  (lines 5232–5264)

```
fn ensure_minimum_rows_does_not_prefetch_when_comfortable_cards_fill_view()
```

**Purpose**: Checks that comfortable layout does not prefetch unnecessarily when the existing cards already fill the visible area. Rows in comfortable mode take more screen space than dense rows.

**Data flow**: The test ingests four rows, updates a six-row viewport, and asks for a minimum of six rows. No extra page-load request is recorded.

**Call relations**: The test runner calls it. It exercises ensure_minimum_rows_for_view together with update_viewport so the picker can judge visible card height correctly.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, new, from, new, assert!, MatchDefault, page, page_only_loader, vec!).


##### `tests::ensure_minimum_rows_still_prefetches_when_dense_rows_underfill_view`  (lines 5267–5300)

```
fn ensure_minimum_rows_still_prefetches_when_dense_rows_underfill_view()
```

**Purpose**: Checks that dense mode still prefetches when the loaded rows do not fill the viewport. Dense rows are shorter, so the same number of sessions may leave empty space.

**Data flow**: The test switches to dense mode, ingests two rows with a next cursor, updates a ten-row viewport, and asks for enough rows. One page-load request is recorded.

**Call relations**: The test runner invokes it. It verifies ensure_minimum_rows_for_view uses density-aware sizing when deciding whether to call the loader.

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::list_viewport_width_matches_rendered_list_inset`  (lines 5303–5306)

```
fn list_viewport_width_matches_rendered_list_inset()
```

**Purpose**: Checks the helper that calculates the usable list width after the picker’s side inset is applied. This keeps measurement logic aligned with actual rendering.

**Data flow**: The test calls list_viewport_width for width 80 and width 3. It expects 76 for the normal case and 0 when the terminal is too narrow.

**Call relations**: The test runner calls it. The helper is used by viewport calculations, so this test protects the same width math that render_list depends on.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::toggle_sort_key_reloads_with_new_sort`  (lines 5309–5344)

```
async fn toggle_sort_key_reloads_with_new_sort()
```

**Purpose**: Checks that changing the sort key triggers a fresh page load with the new sort order. Otherwise the visible list would not match the selected sort tab.

**Data flow**: The test records load requests, starts the initial load, then moves focus to the sort control and activates the toggle. The first request uses UpdatedAt, and the second uses CreatedAt.

**Call relations**: The test runner invokes it. It combines start_initial_load with PickerState::handle_key to verify toolbar interaction causes a new PageLoadRequest.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, Char, new, new, from, new, assert_eq!, MatchDefault, page_only_loader).


##### `tests::default_filter_focus_arrows_reload_with_new_filter`  (lines 5347–5378)

```
async fn default_filter_focus_arrows_reload_with_new_filter()
```

**Purpose**: Checks that moving the filter choice from current directory to all sessions reloads the list. The displayed data must follow the selected filter tab.

**Data flow**: The test starts with a current-directory filter, records the initial load request, then sends Right. A second request appears with no current-directory filter.

**Call relations**: The test runner calls it. It uses start_initial_load and PickerState::handle_key to exercise the keyboard path for changing filter focus.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, new, new, from, from, new, assert_eq!, MatchDefault, page_only_loader).


##### `tests::all_filter_can_switch_back_to_cwd_when_cwd_candidate_exists`  (lines 5381–5412)

```
async fn all_filter_can_switch_back_to_cwd_when_cwd_candidate_exists()
```

**Purpose**: Checks that the user can switch from all sessions back to current-directory filtering when a current directory is known. This keeps the filter tabs reversible.

**Data flow**: The test starts in all-sessions mode with a current-directory candidate available, records the first request, then sends Right. The second request includes the candidate directory as the filter.

**Call relations**: The test runner invokes it. It verifies the filter-switching branch inside PickerState::handle_key and the reload request it sends.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, new, new, from, from, new, assert_eq!, MatchDefault, page_only_loader).


##### `tests::filter_stays_all_when_no_cwd_candidate_exists`  (lines 5415–5448)

```
async fn filter_stays_all_when_no_cwd_candidate_exists()
```

**Purpose**: Checks that the picker does not offer or switch to a current-directory filter when it has no directory to use. This avoids a broken filter tab.

**Data flow**: The test creates state with no current-directory candidate and confirms the search line does not mention “Cwd”. It starts loading, sends Right, and sees only the original all-sessions load request.

**Call relations**: The test runner calls it. It exercises both search_line, for the visible toolbar, and PickerState::handle_key, for the attempted filter change.

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (new, new, new, new, assert_eq!, page_only_loader).


##### `tests::page_navigation_uses_view_rows`  (lines 5451–5507)

```
async fn page_navigation_uses_view_rows()
```

**Purpose**: Checks that PageUp and PageDown move by the number of visible rows. Navigation should match what the user sees on screen.

**Data flow**: The test loads 20 rows, sets a five-row viewport, and sends PageDown, PageDown, PageUp, End, and Home. The selected index moves to 5, 10, 5, 19, and 0.

**Call relations**: The test runner invokes it. It uses ingest_page, update_viewport, and PickerState::handle_key to verify navigation through real picker state.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::page_and_jump_navigation_use_list_keymap`  (lines 5510–5569)

```
async fn page_and_jump_navigation_use_list_keymap()
```

**Purpose**: Checks that page and jump commands obey the configured list keymap instead of hard-coded keys. This lets users or modes remap navigation.

**Data flow**: The test remaps page down, page up, jump bottom, and jump top to control-key shortcuts, then loads 20 rows. The physical PageDown key no longer moves, while the mapped shortcuts move selection as expected.

**Call relations**: The test runner calls it. It drives PickerState::handle_key after changing state.list_keymap, proving navigation consults the keymap before acting.

*Call graph*: calls 2 internal fn (new, test_dummy); 11 external calls (Char, new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader (+1 more)).


##### `tests::ctrl_c_exits_even_when_cancel_is_remapped_to_ctrl_c`  (lines 5572–5590)

```
async fn ctrl_c_exits_even_when_cancel_is_remapped_to_ctrl_c()
```

**Purpose**: Checks that Ctrl-C always exits, even if the cancel action is also mapped to Ctrl-C. This protects the standard terminal escape hatch.

**Data flow**: The test remaps cancel to Ctrl-C and sends Ctrl-C. The picker returns an Exit selection.

**Call relations**: The test runner invokes it. It verifies PickerState::handle_key gives Ctrl-C exit behavior priority over normal keymap resolution.

*Call graph*: calls 2 internal fn (new, test_dummy); 7 external calls (Char, new, from, assert!, MatchDefault, page_only_loader, vec!).


##### `tests::end_jumps_to_last_known_row_and_starts_loading_more`  (lines 5593–5638)

```
async fn end_jumps_to_last_known_row_and_starts_loading_more()
```

**Purpose**: Checks that End jumps to the last loaded row and starts loading more if more pages exist. This lets users quickly move toward the bottom without waiting first.

**Data flow**: The test loads 10 rows with a next cursor, sets the viewport, and sends End. Selection moves to row 9, pagination becomes pending, one page-load request is recorded, and the footer shows an ellipsis for more loading.

**Call relations**: The test runner calls it. It goes through PickerState::handle_key for the End key and then checks picker_footer_progress_label to confirm the visible status matches the loading state.

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader).


##### `tests::enter_on_row_without_resolvable_thread_id_shows_inline_error`  (lines 5641–5677)

```
async fn enter_on_row_without_resolvable_thread_id_shows_inline_error()
```

**Purpose**: Checks that pressing Enter on a row without a usable thread id shows a clear error instead of closing the picker. This covers older or incomplete session records.

**Data flow**: The test creates one row with a path but no thread id, sends Enter, and expects no selection result. The picker records an inline error saying it failed to read metadata from that path.

**Call relations**: The test runner invokes it. It exercises PickerState::handle_key for the resume action and verifies the failure path stays inside the picker.

*Call graph*: calls 2 internal fn (new, test_dummy); 8 external calls (new, from, from, assert!, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::enter_on_pathless_thread_uses_thread_id`  (lines 5680–5716)

```
async fn enter_on_pathless_thread_uses_thread_id()
```

**Purpose**: Checks that a row with no file path can still be resumed when it has a thread id. This supports sessions that come from a server or another source rather than a local JSONL file.

**Data flow**: The test creates one pathless row with a thread id and sends Enter. The returned selection is a Resume target with no path and the same thread id.

**Call relations**: The test runner calls it. It drives PickerState::handle_key through the successful resume path and verifies the returned SessionSelection carries the right target information.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 7 external calls (new, from, assert_eq!, panic!, MatchDefault, page_only_loader, vec!).


##### `tests::app_server_row_keeps_pathless_threads`  (lines 5719–5749)

```
fn app_server_row_keeps_pathless_threads()
```

**Purpose**: This test checks that a thread coming from the app server is still usable even when it has no local transcript file path. That matters because remote or server-owned conversations may not map to a `.jsonl` file on disk, but the picker should still show and resume them.

**Data flow**: It creates a fake server thread with an id, name, preview text, and no `path`. It sends that thread through `row_from_app_server_thread`, which turns server data into a row for the picker. The result is checked to make sure the missing path stays missing, while the thread id and thread name are preserved.

**Call relations**: The Rust test runner calls this test. Inside the test, `row_from_app_server_thread` is the production conversion step being exercised; the assertions verify that this conversion does not accidentally throw away pathless server threads.

*Call graph*: calls 2 internal fn (new, row_from_app_server_thread); 4 external calls (from, new, assert_eq!, test_path_buf).


##### `tests::thread_to_transcript_cells_renders_core_message_types`  (lines 5752–5818)

```
fn thread_to_transcript_cells_renders_core_message_types()
```

**Purpose**: This test makes sure the transcript preview renderer can show the main kinds of conversation content: a user message, an assistant message, and a proposed plan. Without this, the resume picker could show an incomplete or misleading preview of a saved thread.

**Data flow**: It builds a fake thread with one completed turn containing three items: user text, assistant text, and a plan. It passes the thread into `thread_to_transcript_cells`, asks each display cell for its visible lines at a fixed width, joins those lines into one string, and checks that the expected words and plan heading appear.

**Call relations**: The test runner invokes this as a transcript-rendering safety check. It hands a realistic thread shape to `crate::thread_transcript::thread_to_transcript_cells`, then inspects the rendered text that the picker would eventually show on screen.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert!, test_path_buf, vec!).


##### `tests::thread_to_transcript_cells_hides_raw_reasoning_when_not_enabled`  (lines 5821–5876)

```
fn thread_to_transcript_cells_hides_raw_reasoning_when_not_enabled()
```

**Purpose**: This test verifies that private raw reasoning text is hidden unless the caller explicitly asks to show it. This protects sensitive internal reasoning from appearing in the resume transcript by default.

**Data flow**: It creates a fake thread whose only item is a reasoning entry containing raw text. It renders the thread twice: once with raw reasoning hidden and once with raw reasoning visible. The hidden output must not contain the private text, while the visible output must contain it.

**Call relations**: The test runner calls this function to guard the privacy-related branch of transcript rendering. It uses `thread_to_transcript_cells` with two different `RawReasoningVisibility` settings and compares the resulting display text.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert!, test_path_buf, vec!).


##### `tests::thread_to_transcript_cells_shows_raw_reasoning_over_summary_when_enabled`  (lines 5879–5928)

```
fn thread_to_transcript_cells_shows_raw_reasoning_over_summary_when_enabled()
```

**Purpose**: This test checks the rule used when both a public reasoning summary and raw reasoning are present. If raw reasoning display is enabled, the renderer should show the raw content instead of the summary.

**Data flow**: It builds a thread with one reasoning item containing both `summary` text and `content` text. It renders that thread with raw reasoning set to visible, collects the visible lines, and checks that the raw text appears while the summary does not.

**Call relations**: The test runner runs this against the transcript rendering path. It focuses on the choice made inside `thread_to_transcript_cells` when two possible versions of reasoning text are available.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert!, test_path_buf, vec!).


##### `tests::moving_to_last_card_scrolls_when_cards_exceed_viewport`  (lines 5931–5970)

```
async fn moving_to_last_card_scrolls_when_cards_exceed_viewport()
```

**Purpose**: This test makes sure moving down through a short list scrolls the picker when the selected card would otherwise fall below the visible area. It protects the basic promise that the highlighted session stays visible.

**Data flow**: It creates a picker state with three fake rows, loads them into the picker, and gives the picker a small viewport. It simulates pressing the Down arrow twice. After the first and second moves, it checks both the selected row index and `scroll_top`, which is the first visible row.

**Call relations**: The test runner calls this to exercise `PickerState` as if a user were navigating with the keyboard. The flow goes through `handle_key`, which updates selection and calls the picker’s visibility logic as needed.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::up_from_bottom_keeps_viewport_stable_when_card_remains_visible`  (lines 5973–6012)

```
async fn up_from_bottom_keeps_viewport_stable_when_card_remains_visible()
```

**Purpose**: This test checks upward navigation from the bottom of a longer list. It makes sure the scroll position changes only enough to keep the newly selected card visible, instead of jumping unpredictably.

**Data flow**: It loads ten fake rows, sets a small viewport, manually places the selection at the last row, and asks the picker to make that selection visible. Then it simulates one Up arrow press. The result should be that the selected row moves up by one and the scroll position moves up in step.

**Call relations**: The test runner drives this through `PickerState::handle_key`. The test depends on `ensure_selected_visible` to set up a realistic bottom-of-list view, then checks that keyboard navigation keeps the viewport stable.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::up_scrolls_only_after_crossing_top_edge`  (lines 6015–6050)

```
async fn up_scrolls_only_after_crossing_top_edge()
```

**Purpose**: This test protects the rule for scrolling upward: the view should scroll when moving the selection would cross the top edge of what is currently visible. This prevents the highlighted row from disappearing above the viewport.

**Data flow**: It creates ten rows, loads them, sets the viewport, and manually places both the selected row and the top visible row near the bottom of the list. After one Up arrow press, it checks that the selection and scroll top both move from 8 to 7.

**Call relations**: The test runner calls this as a focused keyboard-navigation check. The simulated key press goes through `handle_key`, and the assertions confirm that the picker’s scroll correction runs at the right moment.

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::list_reports_more_rows_above_and_below`  (lines 6053–6086)

```
fn list_reports_more_rows_above_and_below()
```

**Purpose**: This test checks the picker’s ability to report whether there are hidden rows above or below the visible part of the list. That information is useful for showing scroll indicators or deciding whether more movement is possible.

**Data flow**: It loads five fake rows into a picker with a small viewport. At the top of the list, it checks that there is nothing above but more below. Then it moves `scroll_top` down and checks that there are now rows above and still rows below.

**Call relations**: The test runner calls this directly against `PickerState` helper methods. It does not simulate key presses; instead, it sets the scroll position and verifies what `has_more_above` and `has_more_below` report.

*Call graph*: calls 2 internal fn (new, test_dummy); 8 external calls (from, new, assert!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::set_query_loads_until_match_and_respects_scan_cap`  (lines 6089–6207)

```
async fn set_query_loads_until_match_and_respects_scan_cap()
```

**Purpose**: This test checks the search behavior when the current loaded sessions do not contain a match. The picker should keep asking for more pages until it finds a match, but it must stop when a scan limit says there is no point looking further.

**Data flow**: It sets up a fake page loader that records every page request. The picker starts with one non-matching row, then receives a search query. The test feeds back one non-matching page, expects another request, then feeds back a matching page and expects the search to stop. It then starts a new search for a missing term, sends an old stale result that should be ignored, and finally sends a current result marked as reaching the scan cap. The final state has no matches, no active search, and the scan-cap flag set.

**Call relations**: The test runner drives a realistic asynchronous search story. `set_query` starts the search and asks the loader for more data; `handle_background_event` accepts page results, ignores stale tokens, updates rows, and decides whether to request another page or stop.

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::paste_appends_to_existing_query`  (lines 6210–6225)

```
async fn paste_appends_to_existing_query()
```

**Purpose**: This test makes sure pasted text is added to an existing search query in a readable way. If a user already typed a word and pastes another word, the picker should form one sensible search string instead of jamming them together.

**Data flow**: It creates a picker state with the query set to `resize`. It calls `handle_paste` with `results`. The query becomes `resize results`, adding a space between the old and new text.

**Call relations**: The test runner calls this as a small input-behavior check. It exercises `PickerState::handle_paste`, which is used when the terminal sends pasted text to the picker.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::whitespace_only_paste_is_ignored`  (lines 6228–6243)

```
async fn whitespace_only_paste_is_ignored()
```

**Purpose**: This test checks that pasting only spaces, tabs, or newlines does not change the search query. That avoids accidental changes when the clipboard contains no useful search text.

**Data flow**: It starts with the query `resize`, then calls `handle_paste` with whitespace-only text. The query remains exactly `resize`.

**Call relations**: The test runner invokes this as another focused check of `PickerState::handle_paste`. It confirms that paste cleanup happens before the query is changed.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::paste_uses_existing_search_loading_path`  (lines 6246–6280)

```
async fn paste_uses_existing_search_loading_path()
```

**Purpose**: This test verifies that pasting search text triggers the same loading behavior as typing a search query. That matters because a pasted query may need to search beyond the currently loaded page.

**Data flow**: It sets up a fake loader that records page requests, loads an initial row, clears the recorded requests, and pastes `target`. The picker’s query becomes `target`, and the loader receives one new request that includes a search token, meaning it belongs to an active search.

**Call relations**: The test runner calls this to connect paste handling with the broader search machinery. `handle_paste` updates the query and then uses the same search-loading path that `set_query` uses, rather than having a separate paste-only behavior.

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::esc_with_empty_query_starts_fresh`  (lines 6283–6300)

```
async fn esc_with_empty_query_starts_fresh()
```

**Purpose**: This test checks the Escape key behavior when there is no active search text. In that situation, Escape means the user wants to leave the resume flow and start a new session instead.

**Data flow**: It creates a fresh picker with an empty query and sends an Escape key event through `handle_key`. The returned selection is `StartFresh`, which tells the surrounding application to begin a new conversation.

**Call relations**: The test runner drives this through the same keyboard path used by the real terminal UI. `handle_key` interprets Escape and returns a `SessionSelection` for the higher-level app to act on.

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (new, from, assert!, MatchDefault, page_only_loader).


##### `tests::esc_with_query_clears_search_and_preserves_selected_result`  (lines 6303–6337)

```
async fn esc_with_query_clears_search_and_preserves_selected_result()
```

**Purpose**: This test checks the other Escape key behavior: when a search query exists, Escape should clear the search instead of starting fresh. It also makes sure the row that matched the query stays selected after the full list comes back.

**Data flow**: It loads two rows, searches for `beta`, and then sends Escape. The picker returns no final selection, clears the query, restores both rows to the visible list, and keeps the selected row on the previously matched beta session.

**Call relations**: The test runner uses `set_query` to enter search mode and `handle_key` to simulate Escape. This confirms that keyboard handling, filtering, and selection preservation work together instead of treating Escape as an unconditional exit.

*Call graph*: calls 2 internal fn (new, test_dummy); 8 external calls (new, from, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


### `tui/src/chatwidget/constructor.rs`

`orchestration` · `startup`

This file is the setup desk for the chat interface. A `ChatWidget` is a large object: it needs configuration, model choice, keyboard shortcuts, the input area, transcript state, account status, rate-limit tracking, plugin state, pet/animation state, collaboration mode, and many other small pieces. Without this constructor, the chat screen would not start in a consistent state, and later code would have to guess which fields are ready.

The main function takes a bundle of startup information called `ChatWidgetInit`. It first cleans up the chosen model name, stores it back into the configuration, chooses random placeholder text for the input box, and works out which model and service tier should be shown in the header. It also prepares the initial collaboration mode, terminal information, and keyboard bindings.

Then it creates the `ChatWidget` itself, filling in every field with either real startup data or a safe empty/default value. Think of it like opening a new notebook: the title is filled in, the first page is prepared, tabs are labeled, and blank sections are ready for future notes. After construction, it performs final wiring: it prefetches rate-limit data, applies custom key bindings, enables or disables bottom-pane commands, updates collaboration indicators, and refreshes status displays.

#### Function details

##### `ChatWidget::new_with_app_event`  (lines 6–8)

```
fn new_with_app_event(common: ChatWidgetInit) -> Self
```

**Purpose**: This is the simple, usual way to create a `ChatWidget` when its Codex operations should report through the app event system. It exists so callers do not need to know the lower-level target choice.

**Data flow**: It receives the common startup bundle for the chat widget. It adds one decision: use `CodexOpTarget::AppEvent` as the operation target. It then passes everything to the fuller constructor and returns the finished `ChatWidget`.

**Call relations**: This function is a small front door. When outside code wants a normal app-event-backed chat widget, it calls this, and this immediately hands the real building work to `ChatWidget::new_with_op_target`.

*Call graph*: 1 external calls (new_with_op_target).


##### `ChatWidget::new_with_op_target`  (lines 10–278)

```
fn new_with_op_target(
        common: ChatWidgetInit,
        codex_op_target: CodexOpTarget,
    ) -> Self
```

**Purpose**: This is the full constructor for `ChatWidget`. It turns startup configuration and environment information into a ready-to-use chat screen with input, transcript, model header, status tracking, keyboard behavior, and feature flags all set up.

**Data flow**: It starts with a `ChatWidgetInit` bundle and a Codex operation target. It reads configuration, account flags, model information, keymap settings, terminal details, and initial UI options. It normalizes the selected model, chooses display text, creates the bottom input pane and transcript state, fills many tracking fields with defaults, starts any needed pet loading, then applies final settings such as key bindings, status-line visibility, collaboration controls, connector support, and token activity commands. The result is a fully initialized `ChatWidget` ready to be rendered and used.

**Call relations**: This function is called by the simpler `ChatWidget::new_with_app_event` and likely by other setup paths that need a different operation target. During construction it calls many smaller constructors and setup helpers, such as creating the bottom pane, transcript state, session header, default state objects, runtime keymaps, and configured pet loading. After the struct exists, it calls methods on the new widget to synchronize commands and refresh visible status surfaces, so later user interaction starts from a coherent state.

*Call graph*: calls 10 internal fn (new, new, start_configured_pet_load_if_needed, new, default, new, new, defaults, from_config, effective_service_tier); 24 external calls (new, new, new, now, initial_collaboration_mask, placeholder_session_header_cell, new, new, matches!, default (+14 more)).


### `tui/src/chatwidget/pets.rs`

`orchestration` · `main loop and request handling`

The chat widget can show a small ambient pet beside the conversation, and it also lets the user choose a pet from a picker. This file is the bridge between those ideas and the rest of the chat screen. Without it, the configured pet would not appear, the chat text would not make room for pet images, and the picker would not be able to preview or select pets.

The file first checks the user’s configuration to see whether a pet is enabled. If a pet pack needs to be prepared, it starts that work in the background so the terminal interface does not freeze. When loading finishes, it sends an app event back to the main interface, like leaving a note for the front desk instead of interrupting the whole room.

Inside `ChatWidget`, the methods decide when a pet can be shown, where it should sit, and how much space chat text must reserve beside it. They also protect the display from confusing overlap: the pet is not drawn when a modal or popup is active. The picker methods open the pet selection view, load previews, ignore stale preview results, and show a temporary loading popup while a chosen pet is prepared. Test-only helpers let tests pretend the terminal supports or does not support pet images.

#### Function details

##### `load_ambient_pet`  (lines 6–22)

```
fn load_ambient_pet(
    config: &Config,
    frame_requester: FrameRequester,
) -> Option<crate::pets::AmbientPet>
```

**Purpose**: Loads the pet named in the configuration, if one is set and not explicitly disabled. It gives the chat widget a ready-to-draw ambient pet or no pet at all.

**Data flow**: It reads the configured pet name, the Codex home folder, the animation setting, and a frame requester used to ask the screen to redraw. If no pet is configured, or the special disabled pet is selected, it returns nothing. Otherwise it asks the pet system to load that pet and returns it when loading succeeds; loading errors are quietly turned into no pet.

**Call relations**: This is used by `ChatWidget::set_tui_pet` after the widget’s stored pet choice changes. It hands the actual loading work to the pet system’s `load` function.

*Call graph*: calls 1 internal fn (load); called by 1 (set_tui_pet).


##### `start_configured_pet_load_if_needed`  (lines 24–53)

```
fn start_configured_pet_load_if_needed(
    config: &Config,
    ambient_pet_missing: bool,
    frame_requester: FrameRequester,
    app_event_tx: AppEventSender,
)
```

**Purpose**: Starts a background load for the configured pet when the chat widget does not already have one. This prevents startup or setup from blocking the terminal while pet files are prepared.

**Data flow**: It reads the configured pet id, the Codex home folder, animation settings, a frame requester, and an app-event sender. If there is no pet, the pet is disabled, or a pet is already present, it does nothing. Otherwise it starts background work that prepares the built-in pet pack, loads the pet, and sends back either the loaded pet or an error message wrapped in a `ConfiguredPetLoaded` event.

**Call relations**: `new_with_op_target` calls this during chat widget setup when a configured pet may need to appear. It uses `spawn_pet_load` so slow file work happens away from the user interface thread.

*Call graph*: calls 1 internal fn (spawn_pet_load); called by 1 (new_with_op_target).


##### `ChatWidget::set_ambient_pet_notification`  (lines 56–64)

```
fn set_ambient_pet_notification(
        &mut self,
        kind: crate::pets::PetNotificationKind,
        body: Option<String>,
    )
```

**Purpose**: Shows or changes a small notification attached to the ambient pet, if a pet is currently active. This lets the pet visually react to chat events.

**Data flow**: It receives a notification kind and optional message text. If the widget has an ambient pet, it passes those values into the pet. If there is no pet, nothing changes.

**Call relations**: This method is called by nearby chat-widget behavior when the interface wants the pet to display a status or message. It does not call other listed functions; it simply forwards the request to the current pet.


##### `ChatWidget::ambient_pet_image_enabled`  (lines 66–70)

```
fn ambient_pet_image_enabled(&self) -> bool
```

**Purpose**: Reports whether the current ambient pet is using image-based drawing. The chat layout needs this because image pets take up real terminal columns.

**Data flow**: It looks at the optional ambient pet stored in the widget. If there is a pet, it asks whether images are enabled for it. The result is true only when a pet exists and image drawing is active.

**Call relations**: Other chat layout and display code can call this to decide whether pet image behavior matters. It is a small query into the current pet state.


##### `ChatWidget::disable_ambient_pet_for_session`  (lines 72–75)

```
fn disable_ambient_pet_for_session(&mut self)
```

**Purpose**: Turns off the ambient pet for the current running session without necessarily changing saved configuration. This gives the interface a quick way to hide the pet immediately.

**Data flow**: It clears the widget’s current ambient pet value. Then it requests a redraw so the next screen update removes the pet from view.

**Call relations**: This sits in the chat widget as an immediate state change. It does not perform loading or configuration writes; it only affects what this widget currently shows.


##### `ChatWidget::ambient_pet_draw`  (lines 77–93)

```
fn ambient_pet_draw(
        &self,
        area: Rect,
        composer_bottom_y: u16,
    ) -> Option<crate::pets::AmbientPetDraw>
```

**Purpose**: Builds the draw request for the ambient pet, but only when it is safe to show it. It keeps the pet from appearing over modal dialogs or popup views.

**Data flow**: It receives the screen area and the bottom position of the message composer. First it checks whether the bottom pane has any modal or popup active; if so, it returns nothing. Otherwise it chooses the pet’s vertical anchor from configuration: either near the composer or at the screen bottom. If a pet exists, it asks the pet for a draw request for that area and anchor.

**Call relations**: The chat rendering path calls this when deciding what to paint. It relies on the bottom pane’s active-view state and then delegates the final drawing calculation to the ambient pet.

*Call graph*: 1 external calls (bottom).


##### `ChatWidget::ambient_pet_wrap_reserved_cols`  (lines 95–104)

```
fn ambient_pet_wrap_reserved_cols(&self) -> u16
```

**Purpose**: Calculates how many terminal columns should be kept free beside chat history for the pet image. This prevents text from running underneath the pet.

**Data flow**: It checks whether an ambient pet exists and whether that pet is using images. If so, it takes the pet image width and adds a small gap. If not, it returns zero reserved columns.

**Call relations**: `ChatWidget::history_wrap_width` calls this when deciding how wide chat messages may be. It is the layout helper that translates pet size into text-wrapping space.

*Call graph*: called by 1 (history_wrap_width).


##### `ChatWidget::history_wrap_width`  (lines 106–110)

```
fn history_wrap_width(&self, width: u16) -> u16
```

**Purpose**: Returns the usable width for wrapping chat history text after leaving room for the pet. It makes sure the text area never shrinks below one column.

**Data flow**: It receives the full available width. It subtracts the columns reserved for the ambient pet, using saturating subtraction so it cannot underflow, then clamps the result to at least one.

**Call relations**: This method calls `ChatWidget::ambient_pet_wrap_reserved_cols` as part of chat layout. Rendering code can use the returned width to wrap messages cleanly around the pet.

*Call graph*: calls 1 internal fn (ambient_pet_wrap_reserved_cols).


##### `ChatWidget::pet_picker_preview_draw`  (lines 112–122)

```
fn pet_picker_preview_draw(&self) -> Option<crate::pets::AmbientPetDraw>
```

**Purpose**: Creates a draw request for the pet preview shown inside the pet picker. It only does this when the picker view is active and a preview pet is ready.

**Data flow**: It first checks that the pet picker is the active selection view. Then it reads the preview area from preview state and asks the loaded preview pet to prepare a draw request for that area. If all of that succeeds, it marks the preview image as visible and returns the draw request.

**Call relations**: The rendering path uses this while the pet picker is open. It works with the picker state and the preview pet that was loaded by `ChatWidget::finish_pet_picker_preview_load`.


##### `ChatWidget::should_clear_pet_picker_preview_image`  (lines 124–126)

```
fn should_clear_pet_picker_preview_image(&self) -> bool
```

**Purpose**: Tells the renderer whether the old picker preview image should be cleared. This avoids leaving a stale pet image behind after the preview is no longer drawn.

**Data flow**: It reads and resets an internal visible flag in one step. If the flag was true, it returns true and changes it to false. If it was already false, it returns false.

**Call relations**: Rendering code can call this after a frame to decide whether cleanup is needed. It pairs with `ChatWidget::pet_picker_preview_draw`, which sets the visible flag when a preview is actually drawn.


##### `ChatWidget::fail_pet_picker_preview_render`  (lines 128–132)

```
fn fail_pet_picker_preview_render(&mut self, message: String)
```

**Purpose**: Records that rendering the pet picker preview failed and clears the preview pet. This lets the picker show an understandable error instead of a broken image.

**Data flow**: It receives an error message, stores that message in the preview state, removes the current preview pet, and requests a redraw. The visible result is that the picker updates to an error state.

**Call relations**: This is used when preview drawing cannot complete successfully. It updates the same preview state used by the picker drawing and loading methods.


##### `ChatWidget::open_pets_picker`  (lines 134–154)

```
fn open_pets_picker(&mut self)
```

**Purpose**: Opens the pet selection interface and starts loading the first preview. This is what turns a user action like “choose pet” into an on-screen picker.

**Data flow**: It first checks whether pet images are supported; if not, it shows a warning and stops. Otherwise it clears old preview state, builds the picker options from the current configuration and Codex home folder, shows the selection view in the bottom pane, chooses the initial pet id, and starts preview loading for that pet.

**Call relations**: This method calls `ChatWidget::warn_if_pets_unsupported` before doing anything visual. It uses the external picker-parameter builder, shows the resulting view, and then calls `ChatWidget::start_pet_picker_preview` to fill the preview area.

*Call graph*: calls 2 internal fn (start_pet_picker_preview, warn_if_pets_unsupported); 1 external calls (build_pet_picker_params).


##### `ChatWidget::select_pet_by_id`  (lines 156–162)

```
fn select_pet_by_id(&mut self, pet_id: String)
```

**Purpose**: Begins the flow for choosing a specific pet by its id. It checks support first, then notifies the application that the user selected that pet.

**Data flow**: It receives a pet id string. If the terminal cannot support pet images, it shows a warning and stops. Otherwise it sends a `PetSelected` app event containing that pet id.

**Call relations**: This method calls `ChatWidget::warn_if_pets_unsupported` as a guard. After that, it hands the actual selection action to the wider app through the event channel.

*Call graph*: calls 1 internal fn (warn_if_pets_unsupported).


##### `ChatWidget::warn_if_pets_unsupported`  (lines 164–172)

```
fn warn_if_pets_unsupported(&mut self) -> bool
```

**Purpose**: Checks whether the current terminal can show pet images and warns the user if it cannot. It gives picker and selection code one shared safety check.

**Data flow**: It asks `ChatWidget::pet_image_support` for the current support status. If that status includes an unsupported message, it adds the message as a warning in the chat and returns true. If there is no problem, it returns false.

**Call relations**: `ChatWidget::open_pets_picker` and `ChatWidget::select_pet_by_id` call this before starting pet-related work. It delegates the actual environment check to `ChatWidget::pet_image_support`.

*Call graph*: calls 1 internal fn (pet_image_support); called by 2 (open_pets_picker, select_pet_by_id).


##### `ChatWidget::pet_image_support`  (lines 174–187)

```
fn pet_image_support(&self) -> crate::pets::PetImageSupport
```

**Purpose**: Determines whether pet images can be displayed in the current environment. In tests, it can return controlled fake answers so behavior is predictable.

**Data flow**: In normal builds, it asks the pet system to detect terminal image support. In tests, it first uses any override set on the widget; otherwise it returns a fixed unsupported result. The output is a support value that may include the reason images cannot be shown.

**Call relations**: `ChatWidget::warn_if_pets_unsupported` calls this when deciding whether to block pet UI actions. It calls the external detection function in normal use and uses test-only paths during tests.

*Call graph*: called by 1 (warn_if_pets_unsupported); 2 external calls (detect_pet_image_support, Unsupported).


##### `ChatWidget::set_tui_pet`  (lines 190–195)

```
fn set_tui_pet(&mut self, pet: Option<String>)
```

**Purpose**: Updates the widget’s copy of the configured pet choice and immediately tries to load that pet. This keeps the visible chat state in sync with the selected pet setting.

**Data flow**: It receives an optional pet id and stores it in the widget configuration. It calls `load_ambient_pet` to create the matching ambient pet, applies any test-only image support override, and requests a redraw so the new choice appears or disappears.

**Call relations**: This method is used when the widget needs to change its configured pet directly. It depends on `load_ambient_pet` for the real pet loading and on `ChatWidget::apply_ambient_pet_image_support_override_for_tests` for test behavior.

*Call graph*: calls 2 internal fn (apply_ambient_pet_image_support_override_for_tests, load_ambient_pet).


##### `ChatWidget::set_tui_pet_loaded`  (lines 197–206)

```
fn set_tui_pet_loaded(
        &mut self,
        pet: Option<String>,
        ambient_pet: Option<crate::pets::AmbientPet>,
    )
```

**Purpose**: Sets both the configured pet choice and an already-loaded ambient pet. This is useful when loading happened elsewhere and the widget just needs to accept the result.

**Data flow**: It receives an optional pet id and an optional loaded ambient pet. It stores both on the widget, applies any test-only image support override, and requests a redraw.

**Call relations**: `ChatWidget::install_test_ambient_pet_for_tests` calls this to install a ready-made test pet. In normal flows, similar state updates can happen after background loading completes.

*Call graph*: calls 1 internal fn (apply_ambient_pet_image_support_override_for_tests); called by 1 (install_test_ambient_pet_for_tests).


##### `ChatWidget::apply_ambient_pet_image_support_override_for_tests`  (lines 218–218)

```
fn apply_ambient_pet_image_support_override_for_tests(&mut self)
```

**Purpose**: Applies a fake image-support setting to the current ambient pet during tests. In normal builds, this function does nothing.

**Data flow**: In test builds, it reads the widget’s optional support override and the current ambient pet. If both exist, it writes that support setting into the pet. In non-test builds, there is no state change.

**Call relations**: `ChatWidget::set_tui_pet`, `ChatWidget::set_tui_pet_loaded`, and `ChatWidget::set_pet_image_support_for_tests` call this so tests can force predictable pet-image behavior.

*Call graph*: called by 3 (set_pet_image_support_for_tests, set_tui_pet, set_tui_pet_loaded).


##### `ChatWidget::start_pet_picker_preview`  (lines 220–250)

```
fn start_pet_picker_preview(&mut self, pet_id: String)
```

**Purpose**: Starts loading the preview image for a pet shown in the picker. It uses request ids so an older, slower preview cannot overwrite a newer user choice.

**Data flow**: It receives a pet id, increments the preview request id, clears the current preview pet, and handles the disabled pet specially by marking the preview disabled. For normal pets, it marks the preview as loading, redraws, then starts background work to prepare the built-in pack and load the pet without animation. When done, the background task sends a `PetPreviewLoaded` event with the request id and result.

**Call relations**: `ChatWidget::open_pets_picker` calls this for the initial picker preview, and other picker movement code can use the same flow. It calls `spawn_pet_load` to keep loading work off the interface thread.

*Call graph*: calls 1 internal fn (spawn_pet_load); called by 1 (open_pets_picker).


##### `ChatWidget::finish_pet_picker_preview_load`  (lines 252–278)

```
fn finish_pet_picker_preview_load(
        &mut self,
        request_id: u64,
        result: Result<crate::pets::AmbientPet, String>,
    )
```

**Purpose**: Accepts the result of a pet preview load and updates the picker preview, but only if the result still matches the latest request. This avoids showing the wrong preview after quick selection changes.

**Data flow**: It receives a request id and either a loaded preview pet or an error message. If the request id is stale, it ignores the result. If loading succeeded, it marks the preview ready and stores the pet. If loading failed, it stores the error and clears the pet. It then requests a redraw.

**Call relations**: This is the counterpart to `ChatWidget::start_pet_picker_preview`. Background loading sends an app event, and the widget calls this when that event is processed.


##### `ChatWidget::show_pet_selection_loading_popup`  (lines 280–297)

```
fn show_pet_selection_loading_popup(&mut self) -> u64
```

**Purpose**: Shows a temporary popup saying the selected pet is being prepared. It gives the user feedback while the final selected pet is loading.

**Data flow**: It increments the pet-selection load request id, clears preview state, and opens a bottom-pane selection view with a loading title, subtitle, and one disabled item. It returns the new request id so the caller can later close the correct popup.

**Call relations**: Selection flow code calls this before waiting for the selected pet to load. It builds a simple selection view using default values and a one-item list.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::finish_pet_selection_loading_popup`  (lines 299–306)

```
fn finish_pet_selection_loading_popup(&mut self, request_id: u64) -> bool
```

**Purpose**: Closes the pet-loading popup if the supplied request id is still current. This prevents an older load from dismissing a newer loading popup by mistake.

**Data flow**: It receives a request id and compares it with the widget’s current pet-selection load request id. If they differ, it returns false and leaves the screen alone. If they match, it asks the bottom pane to dismiss that loading view and returns true.

**Call relations**: This pairs with `ChatWidget::show_pet_selection_loading_popup`. The wider pet selection flow calls it when loading finishes.


##### `ChatWidget::set_pet_image_support_for_tests`  (lines 309–315)

```
fn set_pet_image_support_for_tests(
        &mut self,
        support: crate::pets::PetImageSupport,
    )
```

**Purpose**: Lets tests force a specific pet-image support result. This makes it possible to test supported and unsupported terminal behavior without depending on the real terminal.

**Data flow**: It receives a support value and stores it as an override on the widget. Then it applies that override to the current ambient pet if one exists.

**Call relations**: This test-only method calls `ChatWidget::apply_ambient_pet_image_support_override_for_tests`. Test code uses it before exercising picker or drawing behavior.

*Call graph*: calls 1 internal fn (apply_ambient_pet_image_support_override_for_tests).


##### `ChatWidget::install_test_ambient_pet_for_tests`  (lines 318–326)

```
fn install_test_ambient_pet_for_tests(&mut self, animations_enabled: bool)
```

**Purpose**: Installs a simple test ambient pet into the widget. This gives tests a known pet without needing normal configuration or pet-pack loading.

**Data flow**: It receives an animation setting, creates a test pet using the widget’s frame requester, and stores it with the pet id `test`. The widget is then redrawn through the normal loaded-pet setter.

**Call relations**: This test-only helper calls the external `test_ambient_pet` constructor and then `ChatWidget::set_tui_pet_loaded`, so tests reuse the same state-setting path as normal loaded pets.

*Call graph*: calls 1 internal fn (set_tui_pet_loaded); 1 external calls (test_ambient_pet).


##### `spawn_pet_load`  (lines 329–335)

```
fn spawn_pet_load(f: impl FnOnce() + Send + 'static)
```

**Purpose**: Runs pet-loading work away from the main interface path. This keeps slow file preparation or loading from freezing the terminal UI.

**Data flow**: It receives a one-time function to run. If the code is already inside a Tokio runtime, which is an asynchronous task system, it uses that runtime’s blocking-task pool. If not, it starts a regular operating-system thread. It does not return the task result directly; the task is expected to report back through events.

**Call relations**: `start_configured_pet_load_if_needed` and `ChatWidget::start_pet_picker_preview` call this when they need to load pets in the background. It chooses the safest available execution method and then lets the caller’s closure send completion events.

*Call graph*: called by 2 (start_pet_picker_preview, start_configured_pet_load_if_needed); 3 external calls (drop, spawn, try_current).


### `tui/src/chatwidget/mcp_startup.rs`

`domain_logic` · `MCP startup and status update handling`

MCP servers are helper services the app may need before the chat can fully proceed. Their startup messages can arrive one server at a time, and sometimes old messages arrive late. This file keeps the chat widget from getting confused by that messy timing.

Think of it like a receptionist tracking which invited guests have arrived. Some guests say “I’m on my way,” some say “I’m here,” and some report a problem. The receptionist updates the sign in the lobby, warns if someone failed to arrive, and only opens the next room when the important arrivals are settled.

The main state is `McpStartupStatus`, which records whether each server is starting, ready, failed, or cancelled. `ChatWidget` stores the current startup round, the expected server names, and a small buffer for a possible next round. That buffer matters because the app server can deliver stale updates after startup has already been marked finished. Instead of reopening the startup display immediately, this code waits until the buffered updates look like a real new startup round.

When all expected servers have stopped “Starting,” startup finishes. Failures and cancellations become warnings. The startup header is cleared or restored, the task-running state is refreshed, queued user input may be sent, and the screen is redrawn.

#### Function details

##### `ChatWidget::update_mcp_startup_status`  (lines 35–175)

```
fn update_mcp_startup_status(
        &mut self,
        server: String,
        status: McpStartupStatus,
        complete_when_settled: bool,
    )
```

**Purpose**: Records one MCP server startup update and decides how it should affect the chat screen. It updates the progress header, reports new failures, and finishes startup once all expected servers have settled.

**Data flow**: It receives a server name, that server’s new startup status, and a flag saying whether startup should automatically complete when settled. If the widget is ignoring late updates from a just-finished round, it first stores the update in a pending buffer and only promotes that buffer when it looks like a complete new round. Otherwise it folds the update into the active startup state. It may show warnings, change the status header to list still-starting servers, call the normal finish path when all expected servers are done, and ask the screen to redraw.

**Call relations**: This is the core worker called by `ChatWidget::on_mcp_server_status_updated` after an app-server notification has been translated into the widget’s internal status type. When it sees that every expected server is no longer starting, it hands control to `ChatWidget::finish_mcp_startup` so the startup round can be closed cleanly.

*Call graph*: calls 1 internal fn (finish_mcp_startup); called by 1 (on_mcp_server_status_updated); 4 external calls (new, format!, matches!, take).


##### `ChatWidget::set_mcp_startup_expected_servers`  (lines 177–182)

```
fn set_mcp_startup_expected_servers(&mut self, server_names: I)
```

**Purpose**: Stores the list of MCP servers that are expected to report during startup. This lets the widget know when it has heard enough updates to consider startup complete.

**Data flow**: It receives any iterable collection of server names. It converts those names into the widget’s stored expected-server set. After that, later status updates can be compared against this set to decide whether the startup round is complete.

**Call relations**: No caller is shown in the provided call graph, but this method is meant to be used before or during startup setup. Its stored list is later read by `ChatWidget::update_mcp_startup_status` and `ChatWidget::finish_mcp_startup_after_lag` when they decide which servers are still missing, failed, or cancelled.

*Call graph*: 1 external calls (into_iter).


##### `ChatWidget::finish_mcp_startup`  (lines 184–211)

```
fn finish_mcp_startup(&mut self, failed: Vec<String>, cancelled: Vec<String>)
```

**Purpose**: Closes the current MCP startup round. It reports any failed or cancelled servers, clears startup state, restores the normal status display if appropriate, and allows queued user input to continue.

**Data flow**: It receives two lists: failed server names and cancelled server names. It turns those lists into warning messages when they are not empty. Then it checks whether the current status header belongs to MCP startup, clears the active startup state, enters a short ignore mode for stale late updates, refreshes task state, possibly restores the previous reasoning header, maybe sends the next queued input, and requests a redraw.

**Call relations**: `ChatWidget::update_mcp_startup_status` calls this when normal status updates show that all expected servers have settled. `ChatWidget::finish_mcp_startup_after_lag` also calls it when startup must be ended because of lag or missing updates. Before clearing the header, it asks `ChatWidget::status_header_is_mcp_startup_owned` whether the visible header is one this file created.

*Call graph*: calls 1 internal fn (status_header_is_mcp_startup_owned); called by 2 (finish_mcp_startup_after_lag, update_mcp_startup_status); 2 external calls (new, format!).


##### `ChatWidget::finish_mcp_startup_after_lag`  (lines 213–248)

```
fn finish_mcp_startup_after_lag(&mut self)
```

**Purpose**: Forces MCP startup to finish when waiting any longer would leave the interface stuck. Servers that are still starting, missing, or explicitly cancelled are treated as cancelled for the final warning.

**Data flow**: It first adjusts the pending-round rules if the widget is currently ignoring late updates. If there is no active startup state, it stops. Otherwise it builds a combined set of server names from the current statuses and the expected-server list. For each server, it sorts the result into ready, failed, or cancelled/missing. It removes duplicates, sorts the warning lists, and passes them to the normal finish function.

**Call relations**: This is an alternate path into `ChatWidget::finish_mcp_startup`. It is used when startup completion cannot rely on clean, timely server updates, so it computes the final failed and cancelled lists itself and then lets the shared finish routine do the cleanup.

*Call graph*: calls 1 internal fn (finish_mcp_startup); 1 external calls (new).


##### `ChatWidget::status_header_is_mcp_startup_owned`  (lines 250–260)

```
fn status_header_is_mcp_startup_owned(&self) -> bool
```

**Purpose**: Checks whether the current visible status header was created by the MCP startup display. This prevents the finish logic from accidentally clearing or replacing an unrelated status message.

**Data flow**: It reads the widget’s current status header text. If the text starts with either the single-server startup prefix or the multi-server startup prefix, it returns true. Otherwise it returns false and leaves everything unchanged.

**Call relations**: `ChatWidget::finish_mcp_startup` calls this just before clearing startup state. The answer tells the finish path whether it is safe to restore the previous non-startup status header.

*Call graph*: called by 1 (finish_mcp_startup).


##### `ChatWidget::on_mcp_server_status_updated`  (lines 262–281)

```
fn on_mcp_server_status_updated(
        &mut self,
        notification: McpServerStatusUpdatedNotification,
    )
```

**Purpose**: Receives a raw MCP server status notification from the app server and translates it into the chat widget’s internal startup status. It also creates a fallback error message if the server reports failure without giving a reason.

**Data flow**: It receives a notification containing the server name, protocol-level status, and optional error text. It maps protocol states such as Starting, Ready, Failed, and Cancelled into `McpStartupStatus`. For failures, it uses the provided error or builds a clear default message. It then sends the server name and translated status into the startup-status update flow.

**Call relations**: This is the public-facing entry point in this file for app-server status notifications. After translating the notification, it calls `ChatWidget::update_mcp_startup_status`, which does the real state tracking, warning display, completion check, and redraw work.

*Call graph*: calls 1 internal fn (update_mcp_startup_status).


### `tui/src/chatwidget/replay.rs`

`domain_logic` · `session resume and transcript replay`

When a user resumes an existing chat, the terminal interface needs to show what already happened: user messages, assistant replies, commands, file changes, searches, and other activity. This file is the replay path for that. It takes saved thread data and feeds it back into the `ChatWidget`, which is the chat display, as if the events had just arrived — but with an important safety label: these are replayed events, not live ones.

That distinction matters. A live command or tool call may need spinners, notifications, or state changes. A replayed command should usually just appear in the transcript as history. Think of it like watching a recording of a cooking show: you want to see that the oven was used, not turn your own oven on again.

The main flow starts with whole turns, where a “turn” is one round of user and assistant activity. Each saved item inside the turn is replayed one by one. The file then translates each kind of saved item into the matching chat-widget action: user text becomes a committed user message, assistant text becomes an assistant message, completed commands become command results, web searches are shown as begun and ended, and so on. Some items are deliberately ignored or limited during replay, especially ones that are only meaningful while live.

#### Function details

##### `ChatWidget::replay_thread_turns`  (lines 14–55)

```
fn replay_thread_turns(&mut self, turns: Vec<Turn>, replay_kind: ReplayKind)
```

**Purpose**: Rebuilds the chat transcript from a list of saved turns. It is used when an existing session is opened and the interface needs to show past conversation history without treating it as fresh live activity.

**Data flow**: It receives saved turns and a replay kind that explains what sort of replay is happening. For each turn, it checks whether the turn was still in progress or already finished, replays each saved item inside it, and then, for completed-like turns, sends the widget a completion-style update using a lightweight turn record. The result is not a returned value; the chat widget’s visible state is updated.

**Call relations**: This is the top-level replay loop in this file. As it walks through each turn, it delegates each individual saved item to `ChatWidget::replay_thread_item`, so the detailed item-by-item rendering stays in one place. It also uses ordinary status checks to decide whether the widget should act as though a task started or a turn finished.

*Call graph*: calls 1 internal fn (replay_thread_item); 2 external calls (new, matches!).


##### `ChatWidget::replay_thread_item`  (lines 57–64)

```
fn replay_thread_item(
        &mut self,
        item: ThreadItem,
        turn_id: String,
        replay_kind: ReplayKind,
    )
```

**Purpose**: Replays one saved thread item into the chat display. It is a small adapter that marks the item as coming from replay before passing it to the shared item-rendering logic.

**Data flow**: It receives one saved item, the turn id it belongs to, and the kind of replay being performed. It wraps that replay information into a render-source label and passes the item onward. It does not return anything; its effect is to route the item into the widget update path with the correct replay marker.

**Call relations**: `ChatWidget::replay_thread_turns` calls this for every item inside every saved turn. This function then hands the real work to `ChatWidget::handle_thread_item`, making sure that function knows the item came from replay rather than from a live stream.

*Call graph*: calls 1 internal fn (handle_thread_item); called by 1 (replay_thread_turns); 1 external calls (Replay).


##### `ChatWidget::handle_thread_item`  (lines 66–202)

```
fn handle_thread_item(
        &mut self,
        item: ThreadItem,
        turn_id: String,
        render_source: ThreadItemRenderSource,
    )
```

**Purpose**: Turns one thread item into the matching change in the chat widget. It is the central translator from saved or incoming thread data into what the user sees in the transcript.

**Data flow**: It receives a thread item, the id of the turn it belongs to, and a render-source label. First it asks whether the source is replay and what replay kind it is. Then it matches the item’s type and updates the widget accordingly: user messages become chat entries, assistant messages become assistant text, reasoning summaries are finalized, command and tool calls become started or completed UI entries, file changes and searches are shown, review mode can be entered or exited, and some live-only or unsupported items are skipped. It returns nothing; it changes the chat widget’s internal display state and may request a redraw in one snapshot case.

**Call relations**: This function is reached through `ChatWidget::replay_thread_item` during replay. Its first step is to read replay information from the render source, because that choice changes how some items are shown. At the end, if the item came from a thread snapshot and has no turn id, it asks the interface to redraw so the restored transcript becomes visible.

*Call graph*: calls 2 internal fn (is_replay, replay_kind); called by 1 (replay_thread_item); 2 external calls (matches!, vec!).


### `tui/src/collaboration_modes.rs`

`domain_logic` · `cross-cutting during TUI startup and user mode switching`

The app has several “collaboration mode” presets, such as the normal default mode and plan mode. A preset is like a saved recipe: it says which mode is active and includes the settings that should go with that mode. This file is the small gatekeeper for those recipes inside the text user interface, or TUI, which is the terminal-based screen the user interacts with.

Its first job is to take the built-in preset list and keep only the modes that are meant to be visible in the TUI. That matters because the wider system may know about modes that should not appear as user choices in this interface. From that filtered list, the file can pick the default mode, find a mode by its kind, move to the next visible mode when the user cycles modes, and provide convenient helpers for common modes like Default and Plan.

The functions all accept a ModelCatalog, which represents the available models, but this file currently does not use it when filtering. Keeping it in the function shape still lets callers ask mode questions in a model-aware way if that logic is added later. Without this file, different parts of the TUI could choose modes differently, causing confusing switches, missing defaults, or hidden modes showing up by accident.

#### Function details

##### `filtered_presets`  (lines 7–12)

```
fn filtered_presets(_model_catalog: &ModelCatalog) -> Vec<CollaborationModeMask>
```

**Purpose**: Builds the list of collaboration mode presets that are allowed to appear in the terminal interface. It removes any built-in preset whose mode is not marked as visible for the TUI.

**Data flow**: It receives the model catalog, though it does not currently read from it. It asks the shared preset provider for all built-in collaboration mode presets, checks each preset’s mode for TUI visibility, and returns a new list containing only the visible ones.

**Call relations**: This is the local “front door” to the preset list. The default picker, specific-mode lookup, and mode-cycling logic all call it first so they work from the same TUI-safe set of choices.

*Call graph*: calls 1 internal fn (builtin_collaboration_mode_presets); called by 3 (default_mask, mask_for_kind, next_mask).


##### `default_mask`  (lines 14–21)

```
fn default_mask(model_catalog: &ModelCatalog) -> Option<CollaborationModeMask>
```

**Purpose**: Chooses the collaboration mode preset that should be used when the TUI needs an initial or fallback mode. It prefers the preset explicitly marked as Default, but still returns the first visible preset if no Default preset exists.

**Data flow**: It takes the model catalog, gets the TUI-visible presets, searches them for the Default mode, and clones that preset if found. If there is no Default entry, it falls back to the first visible preset; if the list is empty, it returns nothing.

**Call relations**: Startup and mode-related UI flows call this when they need a safe starting mask. Tests around preserving settings, switching modes, and submitting messages also exercise it because many user flows depend on the app having a predictable initial collaboration mode.

*Call graph*: calls 1 internal fn (filtered_presets); called by 6 (initial_collaboration_mask, thread_settings_updated_preserves_default_settings_for_plan_mode, mode_switch_surfaces_model_change_notification_when_effective_model_changes, submit_user_message_with_mode_errors_when_mode_changes_during_running_turn, submit_user_message_with_mode_submits_when_plan_stream_is_not_active, status_line_model_with_reasoning_updates_on_mode_switch_without_manual_refresh).


##### `mask_for_kind`  (lines 23–33)

```
fn mask_for_kind(
    model_catalog: &ModelCatalog,
    kind: ModeKind,
) -> Option<CollaborationModeMask>
```

**Purpose**: Finds the preset for one requested collaboration mode kind, but only if that kind is allowed to be shown in the TUI. This prevents hidden modes from being selected through this path.

**Data flow**: It receives the model catalog and a requested mode kind. First it checks whether that kind is TUI-visible; if not, it returns nothing immediately. Otherwise it filters the built-in presets to the visible set and returns the preset whose mode matches the requested kind, or nothing if no matching preset exists.

**Call relations**: This is the main lookup helper used whenever another part of the TUI wants a particular mode, especially Plan or Default. Many plan-mode prompts, mode-switch notifications, and message-submission paths depend on it to turn a mode name into the full settings mask the app should apply.

*Call graph*: calls 2 internal fn (is_tui_visible, filtered_presets); called by 20 (enter_submits_when_plan_stream_is_not_active, mode_switch_surfaces_model_change_notification_when_effective_model_changes, plan_completion_restores_status_indicator_after_streaming_plan_output, plan_implementation_popup_shows_after_new_plan_follows_steer, plan_implementation_popup_shows_after_proposed_plan_output, plan_implementation_popup_shows_once_when_replay_precedes_live_turn_complete, plan_implementation_popup_skips_replayed_turn_complete, plan_implementation_popup_skips_when_messages_queued, plan_implementation_popup_skips_when_rate_limit_prompt_pending, plan_implementation_popup_skips_when_steer_follows_proposed_plan (+10 more)).


##### `next_mask`  (lines 36–50)

```
fn next_mask(
    model_catalog: &ModelCatalog,
    current: Option<&CollaborationModeMask>,
) -> Option<CollaborationModeMask>
```

**Purpose**: Moves from the current collaboration mode to the next visible preset, wrapping back to the start at the end. This supports the user action of cycling through modes.

**Data flow**: It receives the model catalog and the current mask, if there is one. It builds the visible preset list; if the list is empty, it returns nothing. Otherwise it reads the current mode kind, finds that mode’s position in the list, and returns the following preset. If the current mode is missing or unknown, it returns the first visible preset.

**Call relations**: The TUI’s mode-cycling action calls this when the user asks to move to the next collaboration mode. It relies on the shared filtered preset list so cycling never lands on a mode that should be hidden from the terminal UI.

*Call graph*: calls 1 internal fn (filtered_presets); called by 1 (cycle_collaboration_mode).


##### `default_mode_mask`  (lines 52–54)

```
fn default_mode_mask(model_catalog: &ModelCatalog) -> Option<CollaborationModeMask>
```

**Purpose**: Provides a short, clear way to ask for the Default collaboration mode preset. It exists so callers do not have to repeat the requested mode kind themselves.

**Data flow**: It receives the model catalog and passes it along with the Default mode kind to the general mode lookup helper. The result is the Default preset if it is visible and available, otherwise nothing.

**Call relations**: Flows that need to return to or confirm the normal coding/default mode call this helper. It delegates the real lookup to mask_for_kind, so it follows the same visibility rules as every other specific-mode request.

*Call graph*: calls 1 internal fn (mask_for_kind); called by 3 (plan_implementation_clear_context_requires_default_mode_and_plan, submit_user_message_with_mode_sets_coding_collaboration_mode, open_plan_implementation_prompt).


##### `plan_mask`  (lines 56–58)

```
fn plan_mask(model_catalog: &ModelCatalog) -> Option<CollaborationModeMask>
```

**Purpose**: Provides a short, clear way to ask for the Plan collaboration mode preset. Plan mode is used when the user wants the assistant to reason about or outline work before implementing it.

**Data flow**: It receives the model catalog and passes it along with the Plan mode kind to the general mode lookup helper. The result is the Plan preset if it is visible and available, otherwise nothing.

**Call relations**: Plan-mode prompts, slash commands, reasoning-effort controls, and nudges call this when they need to apply or inspect Plan mode. It hands off to mask_for_kind so Plan mode is only returned when it is meant to be available in the TUI.

*Call graph*: calls 1 internal fn (mask_for_kind); called by 16 (open_plan_reasoning_scope_prompt, set_plan_mode_reasoning_effort, should_show_plan_mode_nudge, apply_plan_slash_command, interrupted_turn_restore_keeps_active_mode_for_resubmission, mode_switch_surfaces_reasoning_change_notification_when_model_stays_same, plan_mode_nudge_shows_only_for_eligible_default_mode_drafts, plan_mode_reasoning_override_is_marked_current_in_reasoning_popup, reasoning_selection_in_plan_mode_matching_plan_effort_but_different_global_opens_scope_prompt, reasoning_selection_in_plan_mode_model_switch_does_not_open_scope_prompt_event (+6 more)).


### `tui/src/history_cell/session.rs`

`domain_logic` · `session startup and history rendering`

This file is about presentation in the terminal user interface, or TUI: the text-based screen the user sees. It builds small “history cells,” which are chunks of transcript-like content that can be displayed on screen, copied into transcripts, or shown as plain raw lines. The main card is the session header. It shows the Codex version, current model, optional reasoning level, working directory, and a special “YOLO mode” warning when permissions are very open. The file also adds first-session help commands, optional tooltip text, and a note if the user asked for one model but the session used another.

A useful analogy is a printed event badge: the header card tells you who you are talking to, where you are, and what special access is enabled before the real work starts. The helper functions make the badge fit neatly in a terminal by calculating widths, truncating long paths, and drawing box borders with Unicode line characters. The code is careful about visual width, because emojis and non-ASCII characters can take more or less space than a simple byte count suggests.

#### Function details

##### `card_inner_width`  (lines 7–13)

```
fn card_inner_width(width: u16, max_inner_width: usize) -> Option<usize>
```

**Purpose**: Calculates how wide the inside of a bordered card can be for a given terminal width. It prevents the card from trying to draw when the terminal is too narrow.

**Data flow**: It receives the available terminal width and a maximum allowed inner width. If the terminal is less than four columns wide, it returns nothing because there is no room for borders and content. Otherwise, it subtracts space for the border and padding, clamps the result to the maximum, and returns that usable inner width.

**Call relations**: The session header asks this helper for a safe content width before drawing itself. It uses a standard minimum comparison so the card stays readable instead of stretching too wide.

*Call graph*: called by 1 (display_lines); 1 external calls (min).


##### `with_border`  (lines 16–18)

```
fn with_border(lines: Vec<Line<'static>>) -> Vec<Line<'static>>
```

**Purpose**: Wraps a group of terminal text lines in a neat box border sized to the widest line. Callers use it when they want content to look like a card.

**Data flow**: It receives already-prepared lines of styled text. It passes them to the shared border-building helper without forcing a width. The result is a new list of lines with a top border, padded content rows, and a bottom border.

**Call relations**: The session header uses this after building its title, model, directory, and permission rows. It delegates the detailed border math to with_border_internal so that border behavior stays consistent.

*Call graph*: calls 1 internal fn (with_border_internal); called by 1 (display_lines).


##### `with_border_with_inner_width`  (lines 25–30)

```
fn with_border_with_inner_width(
    lines: Vec<Line<'static>>,
    inner_width: usize,
) -> Vec<Line<'static>>
```

**Purpose**: Wraps text lines in a border while guaranteeing that the inside of the box is at least a chosen width. This is useful when another part of the UI has already decided how wide the content should be.

**Data flow**: It receives styled text lines and a requested inner width. It forwards both to the shared border-building helper, which pads lines as needed and returns the bordered version.

**Call relations**: This is a sibling of with_border. No caller is shown in the provided call graph, but it exists so other widgets can reuse the same border rules without copying the padding logic.

*Call graph*: calls 1 internal fn (with_border_internal).


##### `with_border_internal`  (lines 32–72)

```
fn with_border_internal(
    lines: Vec<Line<'static>>,
    forced_inner_width: Option<usize>,
) -> Vec<Line<'static>>
```

**Purpose**: Does the actual work of drawing a Unicode box around text. It centralizes the width calculation and padding so every card has matching borders.

**Data flow**: It receives styled lines and, optionally, a forced minimum inner width. It measures the visible width of each line, chooses the final content width, creates the top border, pads each content row to the same width, and creates the bottom border. It returns the full bordered set of lines.

**Call relations**: Both public border helpers feed into this function. It is the workshop behind the scenes: callers decide whether the width is automatic or forced, and this function turns that decision into finished terminal lines.

*Call graph*: called by 2 (with_border, with_border_with_inner_width); 4 external calls (from, from, with_capacity, vec!).


##### `padded_emoji`  (lines 77–79)

```
fn padded_emoji(emoji: &str) -> String
```

**Purpose**: Adds a tiny visual gap after an emoji. This keeps emoji labels from crowding the following text without adding a full wide space.

**Data flow**: It receives an emoji string. It appends a hair space, which is a very narrow Unicode space, and returns the combined string.

**Call relations**: No caller is shown in the provided call graph. It is a small formatting helper available to nearby UI code that wants emoji to line up pleasantly in terminals.

*Call graph*: 1 external calls (format!).


##### `TooltipHistoryCell::new`  (lines 88–93)

```
fn new(tip: String, cwd: &Path) -> Self
```

**Purpose**: Creates a tooltip history cell from tip text and the current working directory. The directory is kept so markdown links or file references in the tip can be interpreted relative to the session.

**Data flow**: It receives the tip text and a borrowed path. It copies the path into owned storage and returns a new TooltipHistoryCell containing both pieces of information.

**Call relations**: new_session_info calls this when tooltips are enabled and a tip is available. The created cell is then placed into the session info card stack.

*Call graph*: 1 external calls (to_path_buf).


##### `TooltipHistoryCell::display_lines`  (lines 97–112)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Turns a tooltip into wrapped, indented, styled terminal lines for display. It formats the tip as markdown so emphasis and links can appear correctly.

**Data flow**: It receives the available terminal width. It subtracts the indentation width, asks the markdown formatter to append styled lines for “Tip: ...”, and then prefixes each line with two spaces. The output is a list of terminal lines ready to draw.

**Call relations**: The TUI calls this through the HistoryCell interface when the tooltip needs to appear in the conversation history. It relies on markdown formatting and line prefixing helpers from the surrounding module.

*Call graph*: 5 external calls (as_path, width, new, format!, from).


##### `TooltipHistoryCell::raw_lines`  (lines 114–116)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Provides a plain-text version of the tooltip. This is useful for logs, transcripts, or places that should not include terminal styling.

**Data flow**: It reads the stored tip string and returns one simple line beginning with “Tip:”. It does not wrap, indent, or apply markdown styling.

**Call relations**: The history system can call this through the HistoryCell interface when it needs unstyled content instead of display-ready terminal lines.

*Call graph*: 1 external calls (vec!).


##### `SessionInfoCell::display_lines`  (lines 123–125)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Displays the complete session information block by forwarding the request to its inner collection of history cells. This lets the header, help text, tooltip, and model note behave as one unit.

**Data flow**: It receives a terminal width and passes that width to the wrapped CompositeHistoryCell. The composite returns the combined display lines, which this method returns unchanged.

**Call relations**: The TUI calls this through the HistoryCell interface. SessionInfoCell itself is a thin wrapper; the real rendering is done by the cells that new_session_info placed inside the composite.


##### `SessionInfoCell::desired_height`  (lines 127–129)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Reports how many terminal rows the full session information block wants to use at a given width. This helps the UI plan layout before drawing.

**Data flow**: It receives the available width, forwards it to the inner CompositeHistoryCell, and returns the height that composite calculates.

**Call relations**: The history layout code can call this through the HistoryCell interface. SessionInfoCell delegates the calculation because its inner parts know how tall they become after wrapping.


##### `SessionInfoCell::transcript_lines`  (lines 131–133)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Produces transcript-oriented lines for the full session information block. This is for saved or copied conversation text rather than the live terminal view.

**Data flow**: It receives a width and forwards that to the inner CompositeHistoryCell. The composite gathers transcript lines from each part and returns them.

**Call relations**: The transcript path calls this through the HistoryCell interface. SessionInfoCell acts as a pass-through so the grouped session information is treated like one history item.


##### `SessionInfoCell::raw_lines`  (lines 135–137)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Returns plain, unstyled lines for the whole session information block. This is useful when formatting and terminal colors should be removed.

**Data flow**: It asks the inner CompositeHistoryCell for its raw lines and returns them directly. The output combines the raw text from the header and any extra cells.

**Call relations**: The history system calls this through the HistoryCell interface when it needs simple text. The wrapper keeps callers from needing to know that the session information is made of multiple parts.


##### `new_session_info`  (lines 140–217)

```
fn new_session_info(
    config: &Config,
    requested_model: &str,
    session: &ThreadSessionState,
    is_first_event: bool,
    tooltip_override: Option<String>,
    auth_plan: Option<PlanType>,
```

**Purpose**: Builds the full session information cell shown near the top of a conversation. It decides which pieces should appear: the header, first-run help, tooltip, and model-change warning.

**Data flow**: It receives configuration, the model the user requested, the actual session state, flags about whether this is the first event, optional tooltip text, plan information, and whether to show fast status. It creates a header, marks it as YOLO mode when permissions are very open, then adds help lines for a first event or optional tip/model-change lines later. It returns one SessionInfoCell containing all chosen parts.

**Call relations**: This is the main assembly point in the file. It calls SessionHeaderHistoryCell::new to create the header, has_yolo_permissions to decide whether to show the permission warning, and TooltipHistoryCell::new when a tip should be included.

*Call graph*: calls 2 internal fn (new, has_yolo_permissions); 2 external calls (new, vec!).


##### `is_yolo_mode`  (lines 219–224)

```
fn is_yolo_mode(config: &Config) -> bool
```

**Purpose**: Checks whether a full configuration is effectively in “YOLO mode,” meaning Codex can proceed without approval and with very broad permissions. This gives other code one simple yes-or-no question to ask.

**Data flow**: It reads the approval policy and effective permission profile from the configuration. It converts the stored approval setting into the runtime approval type, then passes both values to has_yolo_permissions. The result is a boolean.

**Call relations**: This is a convenience wrapper around has_yolo_permissions for callers that have a Config object. It keeps the exact permission test in one place.

*Call graph*: calls 2 internal fn (from, has_yolo_permissions).


##### `has_yolo_permissions`  (lines 226–239)

```
fn has_yolo_permissions(
    approval_policy: AskForApproval,
    permission_profile: &PermissionProfile,
) -> bool
```

**Purpose**: Defines the exact permission combination that counts as YOLO mode. The important idea is: no approval prompts, plus either disabled sandboxing or an unrestricted managed file system with network access enabled.

**Data flow**: It receives an approval policy and a permission profile. It checks that approval is set to Never, then checks whether the profile matches one of the broad-access cases. It returns true only when both conditions are met.

**Call relations**: new_session_info uses this to decide whether the header should warn the user. is_yolo_mode also uses it so the same rule applies when checking a whole Config.

*Call graph*: called by 2 (is_yolo_mode, new_session_info); 1 external calls (matches!).


##### `SessionHeaderHistoryCell::new`  (lines 252–267)

```
fn new(
        model: String,
        reasoning_effort: Option<ReasoningEffortConfig>,
        show_fast_status: bool,
        directory: PathBuf,
        version: &'static str,
    ) -> Self
```

**Purpose**: Creates a normal session header cell using the default text style for the model name. This is the common constructor for the header shown at the top of a session.

**Data flow**: It receives the model name, optional reasoning effort, fast-status flag, working directory, and Codex version. It supplies a default style and forwards everything to new_with_style, which builds the actual struct.

**Call relations**: new_session_info calls this when assembling the session info block. Tests and other UI code also call it when they need a standard header without custom styling.

*Call graph*: called by 5 (clear_ui_header_lines_with_version, new_session_info, session_header_hides_fast_status_when_disabled, session_header_includes_reasoning_level_when_present, session_header_indicates_yolo_mode); 2 external calls (new_with_style, default).


##### `SessionHeaderHistoryCell::new_with_style`  (lines 269–286)

```
fn new_with_style(
        model: String,
        model_style: Style,
        reasoning_effort: Option<ReasoningEffortConfig>,
        show_fast_status: bool,
        directory: PathBuf,
        versi
```

**Purpose**: Creates a session header cell while letting the caller choose the style used for the model name. This is useful for placeholders or tests that need special coloring.

**Data flow**: It receives the same header data as new, plus a style for the model text. It stores those values in a SessionHeaderHistoryCell and starts with YOLO mode turned off. The completed cell is returned.

**Call relations**: SessionHeaderHistoryCell::new delegates to this with the default style. The provided call graph also shows a placeholder header creator using it directly.

*Call graph*: called by 1 (placeholder_session_header_cell).


##### `SessionHeaderHistoryCell::with_yolo_mode`  (lines 288–291)

```
fn with_yolo_mode(mut self, yolo_mode: bool) -> Self
```

**Purpose**: Marks an existing header so it will show a YOLO mode permission line. It uses a builder-style pattern, meaning it returns the modified header so calls can be chained.

**Data flow**: It receives the header by value and a true-or-false YOLO flag. It stores that flag inside the header and returns the updated header.

**Call relations**: new_session_info uses this right after creating the header, based on the result of has_yolo_permissions. Later, display_lines and raw_lines read the flag to decide whether to include the permission warning.


##### `SessionHeaderHistoryCell::format_directory`  (lines 293–295)

```
fn format_directory(&self, max_width: Option<usize>) -> String
```

**Purpose**: Formats the header’s working directory for display, optionally shortening it to fit a given width. This keeps long paths from breaking the card layout.

**Data flow**: It reads the directory stored in the header and passes it, along with an optional maximum width, to format_directory_inner. It returns the formatted path string.

**Call relations**: SessionHeaderHistoryCell::display_lines calls this when building the directory row. The actual path rules live in format_directory_inner so they can also be tested directly.

*Call graph*: called by 1 (display_lines); 1 external calls (format_directory_inner).


##### `SessionHeaderHistoryCell::format_directory_inner`  (lines 297–318)

```
fn format_directory_inner(directory: &Path, max_width: Option<usize>) -> String
```

**Purpose**: Turns a filesystem path into a friendly display string. It uses “~” for the home directory when possible and truncates long paths in the middle so the beginning and end remain recognizable.

**Data flow**: It receives a path and an optional maximum display width. It first tries to make the path relative to the user’s home directory; if that works, it formats it with “~”, otherwise it uses the full path. If a maximum width is supplied and the result is too wide, it shortens the path with center truncation. It returns the final string.

**Call relations**: format_directory calls this for the live header. The call graph also shows tests calling it directly to verify path truncation behavior.

*Call graph*: calls 1 internal fn (center_truncate_path); called by 2 (session_header_directory_center_truncates, session_header_directory_front_truncates_long_segment); 4 external calls (display, new, width, format!).


##### `SessionHeaderHistoryCell::reasoning_label`  (lines 320–324)

```
fn reasoning_label(&self) -> Option<&str>
```

**Purpose**: Returns the short text label for the configured reasoning effort, if one exists. This lets the header show extra model detail without duplicating option-handling code.

**Data flow**: It reads the optional reasoning effort stored in the header. If present, it converts that setting to its string label and returns it as an optional borrowed string; if absent, it returns nothing.

**Call relations**: SessionHeaderHistoryCell::display_lines calls this when building the model row. raw_lines also uses the same idea so plain output includes the reasoning label when present.

*Call graph*: called by 1 (display_lines).


##### `SessionHeaderHistoryCell::display_lines`  (lines 328–401)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Draws the visible session header card for the terminal. It shows the Codex title, version, model, optional reasoning and fast labels, working directory, and optional YOLO mode warning.

**Data flow**: It receives the terminal width. It first asks card_inner_width whether there is enough room; if not, it returns no lines. Otherwise it builds styled rows, measures space for the directory, shortens the path if needed, optionally adds the permission row, and wraps everything in a border. The output is a list of styled terminal lines.

**Call relations**: The TUI calls this through the HistoryCell interface whenever the header needs to be drawn. Inside, it relies on card_inner_width for sizing, reasoning_label for model detail, format_directory for the path, and with_border for the final card shape.

*Call graph*: calls 4 internal fn (format_directory, reasoning_label, card_inner_width, with_border); 7 external calls (from, styled, magenta, width, new, format!, vec!).


##### `SessionHeaderHistoryCell::raw_lines`  (lines 403–422)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Provides a plain-text version of the session header. This is for transcripts or logs where borders, colors, and terminal styling are not wanted.

**Data flow**: It reads the version, model, optional reasoning label, directory, and YOLO flag from the header. It builds simple lines such as “OpenAI Codex,” “model,” and “directory,” and adds a permissions line only when YOLO mode is active. It returns those raw lines.

**Call relations**: The history system calls this through the HistoryCell interface when it needs unstyled text. It mirrors the important facts from display_lines without the visual card formatting.

*Call graph*: 2 external calls (from, vec!).


### `tui/src/bottom_pane/status_surface_preview.rs`

`domain_logic` · `status/title setup preview rendering`

The status line can contain many small pieces of information: the app name, project folder, git branch, model name, token counts, rate limits, and more. This file gives each possible piece a safe preview value, like a showroom label on a display model. Without it, the setup UI would either show blanks or need live project/session data just to demonstrate what a status line option looks like.

The main enum, StatusSurfacePreviewItem, names every kind of previewable status item. Each item has a built-in placeholder, such as “my-project” for the project name or “gpt-5.2-codex” for the model. StatusSurfacePreviewData stores the actual text to show for each item. It keeps track of whether a value is only a placeholder or a real live value, so real values are not accidentally overwritten by examples.

The file also has special wording for rate-limit items. Rate limits can appear under different names, such as daily, weekly, monthly, or usage limits. When the preview has a real rate-limit string, helper code turns it into a clearer item name and description for selection menus.

Finally, the file can turn a chosen list of status-line items into a rendered ratatui Line, which is the terminal UI library’s styled line of text.

#### Function details

##### `StatusSurfacePreviewItem::placeholder`  (lines 40–70)

```
fn placeholder(self) -> &'static str
```

**Purpose**: Returns the built-in example text for one preview item. This gives the setup screen something human-readable to show when no real app data is available.

**Data flow**: It receives a specific preview item, such as project name or git branch. It matches that item to a fixed sample string. It returns that sample text without changing anything else.

**Call relations**: This is used when default preview data is built. Each item asks for its placeholder so the preview screen starts with a complete set of example values.


##### `StatusSurfacePreviewItem::iter`  (lines 72–103)

```
fn iter() -> impl Iterator<Item = Self>
```

**Purpose**: Provides every possible preview item in a fixed order. Code uses this when it needs to create or inspect the full set of status-line pieces.

**Data flow**: It takes no outside input. It creates an ordered list of all StatusSurfacePreviewItem variants and returns an iterator, which is a step-by-step way to walk through the list.

**Call relations**: The default preview builder calls this to fill in every placeholder. Other setup-related code also uses it when it needs to know all available preview items.

*Call graph*: called by 2 (default, status_surface_preview_data).


##### `StatusSurfacePreviewData::default`  (lines 118–126)

```
fn default() -> Self
```

**Purpose**: Creates a complete preview data set filled with placeholder text. This is the fallback used when the UI needs to show a preview before real values are known.

**Data flow**: It starts with an empty ordered map, which stores preview items and their text. It walks through every possible item, asks each one for its placeholder, and stores that placeholder. It returns the finished preview data object.

**Call relations**: The title setup popup uses this when it needs a ready-made preview. It relies on StatusSurfacePreviewItem::iter to discover all items and on placeholder text to populate them.

*Call graph*: calls 1 internal fn (iter); called by 1 (renders_title_setup_popup); 1 external calls (new).


##### `StatusSurfacePreviewData::from_iter`  (lines 130–140)

```
fn from_iter(values: I) -> Self
```

**Purpose**: Creates preview data from a supplied set of real values while still keeping placeholders for anything missing. This is useful when tests or runtime code only know some of the status-line values.

**Data flow**: It receives pairs of preview item and text. It first builds the full default placeholder set, then replaces the named items with live values. It returns preview data containing a mix of real values and placeholders.

**Call relations**: Several tests and setup-preview paths call this to prove that runtime values appear when available and placeholders remain when they are not. It builds on the default preview data and then uses live-value insertion.

*Call graph*: called by 5 (preview_includes_thread_title, preview_uses_placeholders_when_runtime_values_are_missing, preview_uses_runtime_values, setup_view_snapshot_uses_runtime_preview_values, status_surface_preview_data); 1 external calls (default).


##### `StatusSurfacePreviewData::set_live`  (lines 142–153)

```
fn set_live(&mut self, item: StatusSurfacePreviewItem, value: V)
```

**Purpose**: Stores a real runtime value for a preview item. A live value is treated as more trustworthy than a placeholder.

**Data flow**: It receives the item to update and text that can be turned into a string. It inserts that text into the map and marks it as not a placeholder. Afterward, that item’s preview will show the real value.

**Call relations**: This is the main way from_iter and other preview-building code replace showroom sample text with actual session or project information.

*Call graph*: 1 external calls (into).


##### `StatusSurfacePreviewData::set_placeholder`  (lines 155–173)

```
fn set_placeholder(&mut self, item: StatusSurfacePreviewItem, value: V)
```

**Purpose**: Stores example text for a preview item, but only if a real value is not already present. This protects live data from being overwritten by fallback text.

**Data flow**: It receives the item and placeholder text. It first checks whether the item already has a live value. If it does, the function leaves it alone; otherwise, it stores the placeholder and marks it as a placeholder.

**Call relations**: The default preview builder uses this while filling every item. Its “do not overwrite live values” rule also makes it safe for later code to add fallback text without damaging real preview data.

*Call graph*: 1 external calls (into).


##### `StatusSurfacePreviewData::suppress_placeholder`  (lines 175–183)

```
fn suppress_placeholder(&mut self, item: StatusSurfacePreviewItem)
```

**Purpose**: Removes a placeholder value for one item, while leaving real values untouched. This is used when a missing real value should mean “show nothing” rather than “show an example.”

**Data flow**: It receives the item to check. If that item exists and is only a placeholder, it removes it from the map. If the item has a live value or is absent, nothing changes.

**Call relations**: This gives setup code a way to hide fallback examples for items that should disappear when unavailable, without risking removal of actual runtime data.


##### `StatusSurfacePreviewData::rate_limit_item_name`  (lines 185–194)

```
fn rate_limit_item_name(
        &self,
        item: StatusSurfacePreviewItem,
        fallback: &str,
    ) -> String
```

**Purpose**: Chooses a clear internal name for a rate-limit preview item. If the preview contains a recognizable live rate-limit value, it names the specific kind of limit; otherwise it uses the supplied fallback name.

**Data flow**: It receives a preview item and fallback text. It looks up only the live value for that item, checks whether the text starts with a known rate-limit phrase, and returns the matching name. If no live or recognizable value exists, it returns the fallback.

**Call relations**: Selection UI code for status-line and title items calls this when it needs a label for a rate-limit option. It uses live_value_for so placeholders do not falsely decide the rate-limit type, then relies on rate_limit_preview_copy for the wording.

*Call graph*: calls 1 internal fn (live_value_for); called by 2 (status_line_select_item, title_select_item).


##### `StatusSurfacePreviewData::rate_limit_item_description`  (lines 196–205)

```
fn rate_limit_item_description(
        &self,
        item: StatusSurfacePreviewItem,
        fallback: &str,
    ) -> String
```

**Purpose**: Chooses a helpful description for a rate-limit preview item. It explains what kind of limit is being shown when the live preview text reveals that information.

**Data flow**: It receives a preview item and fallback description. It reads the live value only, tries to recognize the rate-limit category, and returns that category’s description. If it cannot recognize one, it returns the fallback description.

**Call relations**: Selection UI code for status-line and title items calls this alongside rate_limit_item_name. Together they make rate-limit options easier to understand in menus.

*Call graph*: calls 1 internal fn (live_value_for); called by 2 (status_line_select_item, title_select_item).


##### `StatusSurfacePreviewData::value_for`  (lines 207–209)

```
fn value_for(&self, item: StatusSurfacePreviewItem) -> Option<&str>
```

**Purpose**: Looks up the text currently stored for one preview item. It returns either a live value or a placeholder, whichever is present.

**Data flow**: It receives a preview item. It checks the internal map and, if the item exists, returns the stored text as a borrowed string slice. If the item is missing, it returns nothing.

**Call relations**: status_line_for_items uses this to fetch the text for each selected status-line piece before rendering the preview.


##### `StatusSurfacePreviewData::live_value_for`  (lines 211–216)

```
fn live_value_for(&self, item: StatusSurfacePreviewItem) -> Option<&str>
```

**Purpose**: Looks up text for one preview item, but only if that text came from real runtime data. This prevents placeholder examples from being mistaken for facts.

**Data flow**: It receives a preview item. It checks the stored value, filters out anything marked as a placeholder, and returns the text only when it is live. Otherwise it returns nothing.

**Call relations**: The rate-limit name and description helpers call this before interpreting rate-limit text. That keeps sample placeholder strings from changing menu labels.

*Call graph*: called by 2 (rate_limit_item_description, rate_limit_item_name).


##### `StatusSurfacePreviewData::status_line_for_items`  (lines 218–231)

```
fn status_line_for_items(
        &self,
        items: I,
        use_theme_colors: bool,
    ) -> Option<Line<'static>>
```

**Purpose**: Builds a rendered preview line from a chosen list of status-line items. This is what turns stored preview values into something the terminal UI can display.

**Data flow**: It receives a list of status-line item definitions and a flag saying whether to use theme colors. For each item, it finds the matching preview value, pairs the item with its text, and passes those pieces to the shared status-line rendering function. It returns a styled Line if there is something to render.

**Call relations**: Setup screens call this when they need to show what a chosen status-line layout will look like. It hands the prepared item-and-text pairs to status_line_from_segments, which does the actual formatting and coloring.

*Call graph*: 2 external calls (into_iter, status_line_from_segments).


##### `rate_limit_preview_copy`  (lines 239–279)

```
fn rate_limit_preview_copy(value: &str) -> Option<RateLimitPreviewCopy>
```

**Purpose**: Recognizes the kind of rate limit described by a live preview string and returns friendly copy for it. This keeps labels and descriptions consistent for primary, daily, weekly, monthly, and similar limits.

**Data flow**: It receives a text value, trims spaces from the start, and checks the beginning of the string for known phrases such as “usage ”, “weekly ”, or “monthly ”. When it finds a match, it returns a small object containing a name and description. If nothing matches, it returns nothing.

**Call relations**: The rate-limit name and description methods use this after they have confirmed they are looking at a live value. It is the shared translator from raw preview text to user-facing menu wording.


### `tui/src/public_widgets/mod.rs`

`other` · `compile-time module organization`

This file does not contain behavior of its own. Its job is to organize code. In Rust, a `mod.rs` file often acts like a folder label: it says which source files belong inside that folder-shaped module. Here, it declares one child module, `composer_input`.

The phrase `pub(crate)` means “public inside this crate only.” A crate is one Rust package or library. So `composer_input` is made available to other code within the TUI crate, but it is not exposed as part of a wider public API for outside packages.

Without this file, Rust would not know that `composer_input` is part of `public_widgets`, and code elsewhere in the TUI crate would not be able to refer to it through this module path. Think of it like adding a chapter to a book’s table of contents: the chapter may contain all the real material, but it still needs to be listed so readers — and in this case the compiler — can find it.


### Terminal runtime and ownership
These files establish terminal capabilities, runtime shell behavior, suspend/resume handling, notifications, and low-level terminal ownership mechanics for the TUI.

### `tui/src/resize_reflow_cap.rs`

`domain_logic` · `startup, initial replay, and terminal resize`

When a terminal window changes size, text that used to fit on one line may need to wrap differently. Codex can rebuild, or “reflow,” recent terminal output so the screen still looks right. But terminals only keep a limited amount of scrollback history. Replaying far more rows than the terminal can show is like restocking a shelf that is already too small: it wastes effort and may slow down the resize without helping the user.

This file chooses a safe row limit for that replay work. It first looks at the user’s configuration. If the user set a number, that number wins. If the user disabled the limit, Codex keeps all rows. If the setting is automatic, Codex looks at the detected terminal, such as VS Code, Windows Terminal, WezTerm, or Alacritty, and uses a conservative default for that terminal. If the terminal is unknown, it falls back to a shared default.

There is one important special case: VS Code terminals can sometimes look, through normal terminal metadata, like the shell or host terminal rather than VS Code itself. So this file also checks a separate “am I running inside VS Code?” probe and prefers the VS Code cap when that probe says yes.

The tests confirm that known terminals get their expected caps, manual settings override detection, disabling works, and unknown terminals still use the fallback even inside a terminal multiplexer such as tmux.

#### Function details

##### `resize_reflow_max_rows`  (lines 29–35)

```
fn resize_reflow_max_rows(config: TerminalResizeReflowConfig) -> Option<usize>
```

**Purpose**: This is the public helper used by the rest of the TUI to ask, “How many rows should we keep for resize reflow?” It combines the user’s setting with live information about the current terminal.

**Data flow**: It receives a terminal resize reflow configuration. It reads the detected terminal information from the environment and checks whether the process is running inside VS Code’s terminal. It passes those facts to the more testable helper and returns either a row limit, or no limit if the user disabled limiting.

**Call relations**: This function is the real-world entry point for this file’s logic. It gathers outside facts from terminal detection and the VS Code probe, then hands them to resize_reflow_max_rows_for so the decision can be made in one place.

*Call graph*: calls 2 internal fn (resize_reflow_max_rows_for, running_in_vscode_terminal); called by 1 (resize_reflow_max_rows); 1 external calls (terminal_info).


##### `resize_reflow_max_rows_for`  (lines 37–50)

```
fn resize_reflow_max_rows_for(
    config: TerminalResizeReflowConfig,
    terminal: &TerminalInfo,
    running_in_vscode_terminal: bool,
) -> Option<usize>
```

**Purpose**: This function applies the user’s row-limit setting to a known terminal situation. It exists so the choice can be tested without depending on the actual terminal running the tests.

**Data flow**: It takes three pieces of information: the user configuration, the detected terminal details, and whether the terminal is known to be VS Code. If the configuration says automatic, it asks auto_resize_reflow_max_rows for the best default. If the configuration says disabled, it returns no limit. If the configuration gives a number, it returns that number unchanged.

**Call relations**: resize_reflow_max_rows calls this after collecting live terminal facts. In automatic mode, this function delegates the terminal-specific choice to auto_resize_reflow_max_rows; otherwise it finishes the decision itself from the user’s explicit setting.

*Call graph*: calls 1 internal fn (auto_resize_reflow_max_rows); called by 1 (resize_reflow_max_rows).


##### `auto_resize_reflow_max_rows`  (lines 52–76)

```
fn auto_resize_reflow_max_rows(
    terminal_name: TerminalName,
    running_in_vscode_terminal: bool,
) -> usize
```

**Purpose**: This function chooses a conservative automatic row cap based on the terminal Codex appears to be running in. It protects resize performance by avoiding replay work beyond likely terminal scrollback limits.

**Data flow**: It receives a terminal name and a yes-or-no flag for whether Codex is running in VS Code’s terminal. If the VS Code flag is true, it immediately returns the VS Code limit. Otherwise, it matches the terminal name to known limits for VS Code, Windows Terminal, WezTerm, and Alacritty, or returns the shared fallback for other and unknown terminals.

**Call relations**: resize_reflow_max_rows_for calls this only when the user chose automatic row limiting. It is the final lookup table for terminal-specific defaults, with the VS Code environment probe taking priority over the ordinary terminal name.

*Call graph*: called by 1 (resize_reflow_max_rows_for).


##### `tests::test_terminal`  (lines 83–91)

```
fn test_terminal(name: TerminalName) -> TerminalInfo
```

**Purpose**: This small test helper builds a fake TerminalInfo value with only the terminal name filled in. It lets tests focus on the row-limit decision without repeating unrelated terminal metadata.

**Data flow**: It takes a terminal name and returns a TerminalInfo object whose name is set to that value while fields such as version, TERM value, and multiplexer are left empty.

**Call relations**: The configuration override and disabled-limit tests call this helper to create simple terminal inputs for resize_reflow_max_rows_for. It keeps those tests readable by hiding boilerplate setup.


##### `tests::auto_resize_reflow_max_rows_uses_terminal_defaults`  (lines 94–122)

```
fn auto_resize_reflow_max_rows_uses_terminal_defaults()
```

**Purpose**: This test checks that automatic mode returns the expected built-in cap for several known terminals and the fallback cap for less specific or unknown ones.

**Data flow**: It creates a list of terminal names paired with the row limits they should produce. For each pair, it calls auto_resize_reflow_max_rows with the VS Code probe set to false, then compares the result with the expected number.

**Call relations**: This test directly exercises the terminal-name lookup inside auto_resize_reflow_max_rows. It guards against accidental changes to the default caps for common terminals.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::auto_resize_reflow_max_rows_prefers_vscode_probe`  (lines 125–133)

```
fn auto_resize_reflow_max_rows_prefers_vscode_probe()
```

**Purpose**: This test confirms that the separate VS Code detection wins even if the terminal name says something else. That matters because VS Code can sometimes hide behind other terminal metadata.

**Data flow**: It calls auto_resize_reflow_max_rows with a Windows Terminal name but with the VS Code flag set to true. It expects the VS Code row cap, not the Windows Terminal cap.

**Call relations**: This test focuses on the first branch of auto_resize_reflow_max_rows. It protects the special VS Code behavior that resize_reflow_max_rows relies on when it passes in the result of running_in_vscode_terminal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::configured_resize_reflow_max_rows_overrides_auto_detection`  (lines 136–148)

```
fn configured_resize_reflow_max_rows_overrides_auto_detection()
```

**Purpose**: This test verifies that a user-supplied numeric limit takes priority over automatic terminal detection. If a user asks for 42 rows, Codex should use 42 rows.

**Data flow**: It builds a fake VS Code terminal and a configuration whose max_rows value is a fixed limit of 42. It passes both into resize_reflow_max_rows_for and checks that the result is Some(42).

**Call relations**: This test calls test_terminal to create the terminal input, then exercises resize_reflow_max_rows_for. It makes sure that the configuration path stops before auto detection can replace the user’s explicit choice.

*Call graph*: 3 external calls (assert_eq!, Limit, test_terminal).


##### `tests::disabled_resize_reflow_max_rows_keeps_all_rows`  (lines 151–163)

```
fn disabled_resize_reflow_max_rows_keeps_all_rows()
```

**Purpose**: This test verifies that disabling the row cap really means there is no row limit. In the code, that is represented by returning None.

**Data flow**: It creates a fake VS Code terminal and a configuration whose max_rows value is Disabled. It passes those to resize_reflow_max_rows_for and checks that the function returns None.

**Call relations**: This test uses test_terminal for setup and then checks resize_reflow_max_rows_for directly. It protects the meaning of the Disabled setting so it is not confused with a terminal-specific automatic cap.

*Call graph*: 2 external calls (assert_eq!, test_terminal).


##### `tests::unknown_terminal_uses_fallback_even_under_multiplexer`  (lines 166–182)

```
fn unknown_terminal_uses_fallback_even_under_multiplexer()
```

**Purpose**: This test checks that an unknown terminal still gets the safe fallback cap, even when the TERM string and tmux multiplexer information are present. A multiplexer is a tool like tmux that runs terminal sessions inside another terminal.

**Data flow**: It builds a TerminalInfo value marked as Unknown, with a TERM-like string and tmux multiplexer data. It uses the default resize reflow configuration, calls resize_reflow_max_rows_for, and expects the fallback row limit.

**Call relations**: This test exercises resize_reflow_max_rows_for in automatic mode, which then relies on auto_resize_reflow_max_rows. It confirms that extra terminal surroundings, such as tmux, do not cause unknown terminals to escape the conservative fallback.

*Call graph*: 2 external calls (assert_eq!, default).


### `tui/src/tui.rs`

`orchestration` · `startup, main loop, resize handling, external-command handoff, teardown`

This file is the control room for Codex's text user interface. A terminal normally behaves like a shell: typed keys echo, Enter submits a line, and output scrolls. A rich terminal app needs different behavior: raw key presses, paste detection, focus changes, scheduled redraws, temporary alternate-screen overlays, and careful cleanup so the user's shell is not left broken afterward. This file sets those modes up, tears them down, and wraps the lower-level terminal object used for drawing.

The `init` path checks that standard input and output are real terminals, enables raw terminal behavior, probes the terminal for useful features, installs panic cleanup, and returns an initialized terminal plus metadata. The `Tui` struct then acts like the app's terminal desk: it owns the drawing surface, event broker, frame requester, pending history lines, notification settings, pet image state, and alternate-screen state.

During normal use, callers ask `Tui` for an event stream, queue history lines, schedule frames, and call `draw` or `draw_with_resize_reflow`. Drawing happens inside synchronized terminal updates, like changing a stage set behind a curtain so the audience does not see half-painted frames. The file also knows how to pause itself while an external interactive program runs, then put Codex's terminal modes back. Without this file, Codex could still compute UI content, but it would not safely control the terminal, repaint reliably, preserve shell scrollback, or recover cleanly after errors.

#### Function details

##### `running_in_vscode_terminal`  (lines 76–78)

```
fn running_in_vscode_terminal() -> bool
```

**Purpose**: Reports whether Codex appears to be running inside VS Code's integrated terminal. Other code can use this to adjust terminal behavior for that environment.

**Data flow**: It takes no input from the caller. It asks the keyboard-mode helper to detect the terminal environment, then returns a true-or-false answer.

**Call relations**: The resize-reflow sizing logic calls this when it needs to know whether VS Code-specific terminal behavior may affect how much room the UI should use.

*Call graph*: calls 1 internal fn (running_in_vscode_terminal); called by 1 (resize_reflow_max_rows).


##### `should_emit_notification`  (lines 80–85)

```
fn should_emit_notification(condition: NotificationCondition, terminal_focused: bool) -> bool
```

**Purpose**: Decides whether a desktop notification should be shown, based on the user's notification rule and whether the terminal currently has focus.

**Data flow**: It receives a notification condition and a focused/unfocused flag. If the rule is "unfocused", it returns true only when the terminal is not focused; if the rule is "always", it returns true every time.

**Call relations**: `Tui::notify` calls this before trying to send a notification, so the notification backend is only used when the user's rule allows it.

*Call graph*: called by 1 (notify).


##### `Tui::drop`  (lines 88–92)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the ambient pet image when the `Tui` object is destroyed. This prevents leftover image data from staying visible after the interface is gone.

**Data flow**: It uses the `Tui`'s current terminal and pet image state. It asks `clear_ambient_pet_image` to remove the image; if that fails, it writes a debug log and otherwise lets shutdown continue.

**Call relations**: Rust calls this automatically when a `Tui` value is dropped. It delegates the actual clearing work to `Tui::clear_ambient_pet_image`.

*Call graph*: calls 1 internal fn (clear_ambient_pet_image); 1 external calls (debug!).


##### `tests::unfocused_notification_condition_is_suppressed_when_focused`  (lines 108–113)

```
fn unfocused_notification_condition_is_suppressed_when_focused()
```

**Purpose**: Checks that an "only when unfocused" notification rule does not notify while the terminal is focused.

**Data flow**: The test passes the unfocused-only rule and a focused flag into `should_emit_notification`. It expects the result to be false.

**Call relations**: This protects the behavior used by `Tui::notify`, making sure focused users are not bothered by notifications they asked to receive only when away.

*Call graph*: 1 external calls (assert!).


##### `tests::always_notification_condition_emits_when_focused`  (lines 116–121)

```
fn always_notification_condition_emits_when_focused()
```

**Purpose**: Checks that an "always" notification rule still allows notifications even when the terminal is focused.

**Data flow**: The test passes the always rule and a focused flag into `should_emit_notification`. It expects the result to be true.

**Call relations**: This verifies one branch of the decision that `Tui::notify` relies on before contacting the notification backend.

*Call graph*: 1 external calls (assert!).


##### `tests::unfocused_notification_condition_emits_when_unfocused`  (lines 124–129)

```
fn unfocused_notification_condition_emits_when_unfocused()
```

**Purpose**: Checks that an "only when unfocused" notification rule does notify when the terminal is not focused.

**Data flow**: The test passes the unfocused-only rule and an unfocused flag into `should_emit_notification`. It expects the result to be true.

**Call relations**: This confirms the notification gate used by `Tui::notify` behaves as intended when the user has switched away.

*Call graph*: 1 external calls (assert!).


##### `tests::first_viewport_change_clears_from_new_viewport_when_old_viewport_is_empty`  (lines 132–170)

```
fn first_viewport_change_clears_from_new_viewport_when_old_viewport_is_empty()
```

**Purpose**: Checks that the first viewport change clears stale terminal cells inside the new UI area without erasing shell output above it.

**Data flow**: The test creates a fake terminal, writes sample shell and stale text into it, then calls `clear_for_viewport_change` with a new viewport. It reads the fake screen afterward and asserts that the shell line remains while stale text in the UI area is gone.

**Call relations**: This test directly exercises `clear_for_viewport_change`, which is used by the normal draw path when the inline viewport moves or grows.

*Call graph*: calls 2 internal fn (new, clear_for_viewport_change); 4 external calls (with_options_and_cursor_position, new, assert!, write!).


##### `set_modes`  (lines 173–189)

```
fn set_modes() -> Result<()>
```

**Purpose**: Puts the terminal into the input and output modes Codex needs for an interactive text UI. This includes raw key input, paste markers, focus events, and enhanced keyboard reporting where available.

**Data flow**: It reads and changes terminal state through standard output and the terminal library. It enables virtual terminal processing, bracketed paste, raw mode, keyboard enhancement, and focus-change reporting, then returns success or an input/output error.

**Call relations**: `init` calls this during startup. `Tui::with_restored` calls it after an external program finishes so Codex can resume controlling the terminal.

*Call graph*: calls 2 internal fn (ensure_virtual_terminal_processing, enable_keyboard_enhancement); called by 2 (with_restored, init); 2 external calls (execute!, enable_raw_mode).


##### `EnableAlternateScroll::write_ansi`  (lines 195–197)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Writes the escape code that asks a terminal to translate mouse-wheel scrolling into arrow-key style events while the alternate screen is active.

**Data flow**: It receives a formatter and writes a small ANSI escape sequence into it. The result is either success or a formatting error.

**Call relations**: This method is part of the custom crossterm command used by `Tui::enter_alt_screen` when that command is executed.

*Call graph*: 1 external calls (write!).


##### `EnableAlternateScroll::execute_winapi`  (lines 200–204)

```
fn execute_winapi(&self) -> Result<()>
```

**Purpose**: Prevents this command from being run through the Windows console API path. The command is meant to be sent as an ANSI escape sequence instead.

**Data flow**: It takes no meaningful input beyond the command object and immediately returns an error explaining that the ANSI path should be used.

**Call relations**: Crossterm may ask command types how to execute on Windows; this method makes the intended route explicit for `EnableAlternateScroll`.

*Call graph*: 1 external calls (other).


##### `EnableAlternateScroll::is_ansi_code_supported`  (lines 207–209)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Tells crossterm that the alternate-scroll command supports ANSI escape output on Windows.

**Data flow**: It takes the command object and returns true. No terminal state is changed here.

**Call relations**: This supports the Windows execution path for the command used when `Tui::enter_alt_screen` enables alternate scrolling.


##### `DisableAlternateScroll::write_ansi`  (lines 216–218)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Writes the escape code that turns off alternate-scroll behavior after Codex leaves the alternate screen.

**Data flow**: It receives a formatter and writes the matching ANSI escape sequence that disables the mode. It returns success or a formatting error.

**Call relations**: This method is part of the custom crossterm command used by `Tui::leave_alt_screen`.

*Call graph*: 1 external calls (write!).


##### `DisableAlternateScroll::execute_winapi`  (lines 221–225)

```
fn execute_winapi(&self) -> Result<()>
```

**Purpose**: Prevents this command from being run through the Windows console API path. Like enabling alternate scroll, disabling it is intended to use ANSI output.

**Data flow**: It immediately returns an error message instead of changing terminal state through the Windows API.

**Call relations**: Crossterm may consult this on Windows when `Tui::leave_alt_screen` executes the disable command.

*Call graph*: 1 external calls (other).


##### `DisableAlternateScroll::is_ansi_code_supported`  (lines 228–230)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Tells crossterm that the disable-alternate-scroll command can be emitted as ANSI text on Windows.

**Data flow**: It returns true and does not modify anything.

**Call relations**: This supports the command path used when `Tui::leave_alt_screen` turns alternate scrolling off.


##### `restore_common`  (lines 245–276)

```
fn restore_common(
    raw_mode_restore: RawModeRestore,
    keyboard_restore: KeyboardRestore,
) -> Result<()>
```

**Purpose**: Performs the shared work for returning terminal settings toward normal. It reverses paste, focus, keyboard, cursor, and optionally raw-mode changes.

**Data flow**: It receives two choices: whether to disable raw mode and how strongly to reset keyboard reporting. It tries each cleanup step, remembers the first error if any, and returns either success or that first error after all cleanup attempts have run.

**Call relations**: `restore`, `restore_keep_raw`, and `restore_after_exit` all call this with different cleanup strength depending on whether Codex is pausing temporarily or exiting.

*Call graph*: calls 3 internal fn (ensure_virtual_terminal_processing, reset_keyboard_reporting_after_exit, restore_keyboard_enhancement_stack); called by 3 (restore, restore_after_exit, restore_keep_raw); 3 external calls (execute!, matches!, disable_raw_mode).


##### `restore`  (lines 280–282)

```
fn restore() -> Result<()>
```

**Purpose**: Restores the terminal to its normal shell-friendly state after Codex's interactive modes were enabled.

**Data flow**: It takes no input. It calls `restore_common` with instructions to disable raw mode and pop the keyboard enhancement stack, then returns the result.

**Call relations**: `RestoreMode::restore` uses this for a full restore, especially before temporarily handing the terminal to another interactive program.

*Call graph*: calls 1 internal fn (restore_common); called by 1 (restore).


##### `reapply_raw_mode_after_resume`  (lines 291–294)

```
fn reapply_raw_mode_after_resume() -> Result<()>
```

**Purpose**: On Unix systems, fixes raw-mode state after the process resumes from job control, such as after Ctrl-Z and `fg`.

**Data flow**: It disables raw mode first to clear the terminal library's cached idea of the state, then enables raw mode again so the real terminal state and library state match. It returns any terminal error.

**Call relations**: This is part of the Unix suspend/resume support used around terminal event and drawing flows, even though the direct call is outside the listed graph.

*Call graph*: 2 external calls (disable_raw_mode, enable_raw_mode).


##### `restore_after_exit`  (lines 300–311)

```
fn restore_after_exit() -> Result<()>
```

**Purpose**: Performs a stronger terminal cleanup for final process exit. It is designed to leave the parent shell usable even if normal keyboard-mode cleanup was missed.

**Data flow**: It calls `restore_common` with the stronger keyboard reset, then finishes terminal stderr handling. It keeps the first error encountered and returns it after attempting both cleanup stages.

**Call relations**: The panic hook installed by `set_panic_hook` calls this before showing panic output. It is also the appropriate final cleanup path when Codex exits.

*Call graph*: calls 2 internal fn (restore_common, finish); called by 2 (restore, restore).


##### `restore_keep_raw`  (lines 314–316)

```
fn restore_keep_raw() -> Result<()>
```

**Purpose**: Restores Codex-specific terminal features while intentionally leaving raw mode enabled.

**Data flow**: It takes no input. It calls `restore_common` with raw mode set to stay on, then returns that result.

**Call relations**: `RestoreMode::restore` uses this when `Tui::with_restored` must let another operation run without fully leaving raw mode.

*Call graph*: calls 1 internal fn (restore_common); called by 1 (restore).


##### `RestoreMode::restore`  (lines 326–331)

```
fn restore(self) -> Result<()>
```

**Purpose**: Turns a `RestoreMode` choice into the actual terminal cleanup call.

**Data flow**: It receives either `Full` or `KeepRaw`. `Full` calls `restore`; `KeepRaw` calls `restore_keep_raw`; the chosen function's success or error is returned.

**Call relations**: `Tui::with_restored` calls this before running an external interactive action, so the caller can choose how much terminal state to give back temporarily.

*Call graph*: calls 2 internal fn (restore, restore_keep_raw); called by 1 (with_restored).


##### `flush_terminal_input_buffer`  (lines 371–371)

```
fn flush_terminal_input_buffer()
```

**Purpose**: Clears keystrokes that may have accumulated in the terminal's input queue while Codex was not reading events.

**Data flow**: It reads no application data. On supported platforms it asks the operating system to discard pending standard-input events and logs a warning if that fails; on unsupported platforms it does nothing.

**Call relations**: `init` calls this after entering raw mode to start clean. `Tui::with_restored` calls it after an external program finishes so old keypresses do not leak into Codex.

*Call graph*: called by 2 (with_restored, init); 3 external calls (last_os_error, tcflush, warn!).


##### `init`  (lines 374–463)

```
fn init() -> Result<InitializedTerminal>
```

**Purpose**: Builds an initialized terminal ready for Codex's TUI. It validates the environment, enables terminal modes, probes capabilities, and creates the drawing backend.

**Data flow**: It checks that stdin and stdout are terminals, changes terminal modes, flushes queued input, installs panic cleanup, probes cursor position, colors, and keyboard support where possible, then constructs and returns an `InitializedTerminal` with the terminal object, keyboard-support flag, and stderr guard.

**Call relations**: The top-level ratatui app runner calls this during startup. It relies on helpers such as `set_modes`, `flush_terminal_input_buffer`, platform probes, and `set_panic_hook` before later code creates a `Tui` with the returned pieces.

*Call graph*: calls 9 internal fn (startup, cursor_position_with_crossterm, detect_keyboard_enhancement_supported, flush_terminal_input_buffer, keyboard_enhancement_disabled, probe_windows_default_colors, set_modes, set_panic_hook, install); called by 1 (run_ratatui_app); 9 external calls (new, with_options_and_cursor_position, other, set_default_colors_from_startup_probe, stdin, stdout, now, info!, warn!).


##### `cursor_position_with_crossterm`  (lines 466–471)

```
fn cursor_position_with_crossterm(backend: &mut CrosstermBackend<Stdout>) -> Position
```

**Purpose**: Reads the terminal cursor position on non-Unix platforms, falling back safely if the query fails.

**Data flow**: It receives a crossterm backend, asks it for the current cursor position, and returns that position. If reading fails, it logs a warning and returns the top-left origin position.

**Call relations**: `init` calls this on non-Unix systems to decide where the inline viewport should start.

*Call graph*: called by 1 (init); 1 external calls (get_cursor_position).


##### `detect_keyboard_enhancement_supported`  (lines 474–478)

```
fn detect_keyboard_enhancement_supported() -> bool
```

**Purpose**: Checks whether the current non-Unix terminal appears to support enhanced keyboard reporting.

**Data flow**: It asks crossterm's platform-specific support probe and returns its true-or-false result, defaulting to false if the probe cannot decide.

**Call relations**: `init` calls this on non-Unix systems when keyboard enhancement has not been disabled by configuration.

*Call graph*: called by 1 (init); 1 external calls (supports_keyboard_enhancement).


##### `probe_windows_default_colors`  (lines 481–500)

```
fn probe_windows_default_colors()
```

**Purpose**: On Windows, discovers the terminal's default foreground and background colors so Codex can draw without guessing.

**Data flow**: It starts a timer, runs a default-color probe with a timeout, logs whether it succeeded, and stores either the discovered colors or no colors in the terminal palette module.

**Call relations**: `init` calls this during Windows startup after setting up the backend and before returning the initialized terminal.

*Call graph*: calls 1 internal fn (default_colors); called by 1 (init); 4 external calls (set_default_colors_from_startup_probe, now, info!, warn!).


##### `set_panic_hook`  (lines 502–508)

```
fn set_panic_hook()
```

**Purpose**: Installs a crash-safety hook that restores the terminal before Rust prints panic information.

**Data flow**: It takes the existing panic hook, wraps it in a new hook, and inside that wrapper calls `restore_after_exit` before delegating to the original hook.

**Call relations**: `init` installs this once during terminal startup so unexpected failures do not leave the user's terminal stuck in raw mode or hidden-cursor state.

*Call graph*: called by 1 (init); 3 external calls (new, set_hook, take_hook).


##### `clear_for_viewport_change`  (lines 556–566)

```
fn clear_for_viewport_change(terminal: &mut CustomTerminal<B>, new_area: Rect) -> Result<()>
```

**Purpose**: Clears terminal cells that would otherwise show stale text when Codex's inline drawing area changes.

**Data flow**: It receives a terminal and the new viewport rectangle. If the old viewport is empty, it clears starting at the new viewport; otherwise it clears from the old viewport. The terminal screen is modified, and an input/output result is returned.

**Call relations**: `Tui::draw` uses this when the viewport changes. A dedicated test checks the startup case where the previous viewport was empty.

*Call graph*: called by 1 (first_viewport_change_clears_from_new_viewport_when_old_viewport_is_empty); 2 external calls (clear_after_position, as_position).


##### `Tui::new`  (lines 569–602)

```
fn new(
        terminal: Terminal,
        enhanced_keys_supported: bool,
        stderr_guard: terminal_stderr::TerminalStderrGuard,
    ) -> Self
```

**Purpose**: Creates the main `Tui` object from an initialized terminal. It sets up redraw signaling, event brokering, notification support, pet image state, and terminal-environment flags.

**Data flow**: It receives the terminal, keyboard-support flag, and stderr guard. It creates a broadcast channel for draw requests, a frame requester, an event broker, cached color information, terminal detection state, notification backend, and default internal fields, then returns the ready `Tui`.

**Call relations**: After `init` has prepared the raw terminal pieces, application setup calls this to get the object used for events, drawing, notifications, history insertion, and alternate-screen control.

*Call graph*: calls 4 internal fn (detect_backend, new, new, new); 10 external calls (new, new, channel, terminal_info, default, default, default_colors, on_cached, default, vec!).


##### `Tui::set_alt_screen_enabled`  (lines 605–607)

```
fn set_alt_screen_enabled(&mut self, enabled: bool)
```

**Purpose**: Turns alternate-screen use on or off for this `Tui`. When disabled, attempts to enter or leave alternate screen become harmless no-ops.

**Data flow**: It receives a boolean and stores it in the `Tui`. Future calls to `enter_alt_screen` and `leave_alt_screen` read that stored value.

**Call relations**: This is a configuration-style switch for callers that want inline-only behavior while still using the rest of the `Tui` machinery.


##### `Tui::set_notification_settings`  (lines 609–616)

```
fn set_notification_settings(
        &mut self,
        method: NotificationMethod,
        condition: NotificationCondition,
    )
```

**Purpose**: Applies the user's desktop notification preferences to the running TUI.

**Data flow**: It receives a notification method and condition. It chooses an appropriate backend for the method and stores both the backend and the condition for later notification attempts.

**Call relations**: `Tui::notify` later uses these stored settings to decide whether and how to post a notification.

*Call graph*: calls 1 internal fn (detect_backend).


##### `Tui::frame_requester`  (lines 618–620)

```
fn frame_requester(&self) -> FrameRequester
```

**Purpose**: Gives callers a cloneable handle they can use to request a future redraw.

**Data flow**: It reads the existing frame requester from the `Tui`, clones it, and returns the clone. The original remains owned by the `Tui`.

**Call relations**: `Tui::insert_history_hyperlink_lines_with_wrap_policy` uses this to schedule a frame after new history text is queued.

*Call graph*: called by 1 (insert_history_hyperlink_lines_with_wrap_policy); 1 external calls (clone).


##### `Tui::enhanced_keys_supported`  (lines 622–624)

```
fn enhanced_keys_supported(&self) -> bool
```

**Purpose**: Reports whether the startup probes found support for enhanced keyboard events.

**Data flow**: It reads the stored boolean from the `Tui` and returns it unchanged.

**Call relations**: Other UI code can call this to decide whether modified keys can be interpreted precisely.


##### `Tui::is_alt_screen_active`  (lines 626–628)

```
fn is_alt_screen_active(&self) -> bool
```

**Purpose**: Reports whether the TUI currently believes the alternate screen is active.

**Data flow**: It reads an atomic true-or-false flag and returns the current value. The atomic is a thread-safe flag that can be shared with event code.

**Call relations**: `Tui::with_restored` calls this before running an external program so it can leave alternate screen first and restore it afterward if needed.

*Call graph*: called by 1 (with_restored).


##### `Tui::pause_events`  (lines 631–633)

```
fn pause_events(&mut self)
```

**Purpose**: Stops Codex's terminal event reader so another process can safely read from stdin.

**Data flow**: It tells the event broker to pause events. This drops or suspends the underlying event stream so Codex no longer competes for keyboard input.

**Call relations**: `Tui::with_restored` calls this before handing control to an external interactive program.

*Call graph*: called by 1 (with_restored).


##### `Tui::resume_events`  (lines 637–639)

```
fn resume_events(&mut self)
```

**Purpose**: Restarts Codex's terminal event reader after it was paused.

**Data flow**: It tells the event broker to resume events, allowing Codex to poll terminal input again.

**Call relations**: `Tui::with_restored` calls this after the external program has finished and Codex has restored its terminal modes.

*Call graph*: called by 1 (with_restored).


##### `Tui::with_restored`  (lines 646–684)

```
async fn with_restored(&mut self, mode: RestoreMode, f: F) -> R
```

**Purpose**: Temporarily gives the terminal back to a normal or external interactive program, then restores Codex's TUI afterward.

**Data flow**: It receives a restore mode and an async function to run. It pauses events, leaves alternate screen if active, restores terminal modes and stderr, awaits the external work, then resumes stderr suppression, re-enables Codex terminal modes, flushes stray input, re-enters alternate screen if needed, resumes events, and returns the external function's result.

**Call relations**: This is the safe handoff path for running something that needs direct terminal control. It coordinates `pause_events`, `leave_alt_screen`, `RestoreMode::restore`, `set_modes`, `flush_terminal_input_buffer`, `enter_alt_screen`, and `resume_events`.

*Call graph*: calls 10 internal fn (restore, enter_alt_screen, is_alt_screen_active, leave_alt_screen, pause_events, resume_events, flush_terminal_input_buffer, set_modes, pause, resume); 1 external calls (warn!).


##### `Tui::notify`  (lines 688–712)

```
fn notify(&mut self, message: impl AsRef<str>) -> bool
```

**Purpose**: Attempts to post a desktop notification using the current notification settings.

**Data flow**: It receives a message, checks whether the terminal focus and notification condition allow notifying, then sends the message through the configured backend. It returns true if a notification was posted; if the backend fails, it logs a warning, disables future notifications, and returns false.

**Call relations**: It calls `should_emit_notification` as the gatekeeper before using the notification backend selected by `Tui::set_notification_settings` or `Tui::new`.

*Call graph*: calls 1 internal fn (should_emit_notification); 2 external calls (as_ref, warn!).


##### `Tui::event_stream`  (lines 714–730)

```
fn event_stream(&self) -> Pin<Box<dyn Stream<Item = TuiEvent> + Send + 'static>>
```

**Purpose**: Creates the stream of high-level TUI events consumed by the app, such as keys, paste data, resize signals, and draw requests.

**Data flow**: It clones shared event state, subscribes to draw requests, includes focus tracking and Unix suspend context where applicable, builds a `TuiEventStream`, boxes it, pins it in memory for async polling, and returns it.

**Call relations**: The main app loop uses this stream to receive terminal input and redraw signals. It is fed by the event broker and frame-request broadcast channel owned by `Tui`.

*Call graph*: calls 1 internal fn (new); 3 external calls (pin, subscribe, clone).


##### `Tui::enter_alt_screen`  (lines 734–753)

```
fn enter_alt_screen(&mut self) -> Result<()>
```

**Purpose**: Switches the terminal into the alternate screen for overlay-style UI and expands Codex's viewport to the full terminal.

**Data flow**: It first checks whether alternate screen is enabled. If so, it sends enter-screen and alternate-scroll commands, saves the current inline viewport, sets the viewport to the terminal's full size, clears it, marks alternate screen active, and returns success.

**Call relations**: `Tui::with_restored` may call this after an external program finishes if Codex had been in alternate screen beforehand. Other UI flows can use it to show full-screen overlays.

*Call graph*: calls 3 internal fn (clear, set_viewport_area, size); called by 1 (with_restored); 2 external calls (execute!, new).


##### `Tui::leave_alt_screen`  (lines 756–768)

```
fn leave_alt_screen(&mut self) -> Result<()>
```

**Purpose**: Leaves alternate screen mode and restores the saved inline viewport.

**Data flow**: It checks whether alternate screen is enabled. If so, it sends commands to disable alternate scrolling and leave alternate screen, restores the saved viewport if one exists, marks alternate screen inactive, and returns success.

**Call relations**: `Tui::with_restored` calls this before running an external program so that program does not inherit Codex's alternate-screen state.

*Call graph*: calls 1 internal fn (set_viewport_area); called by 1 (with_restored); 1 external calls (execute!).


##### `Tui::insert_history_lines`  (lines 770–772)

```
fn insert_history_lines(&mut self, lines: Vec<Line<'static>>)
```

**Purpose**: Queues plain text UI lines to be inserted into terminal scrollback above the live viewport.

**Data flow**: It receives ratatui text lines and forwards them using the default pre-wrapping policy. The lines are not written immediately; they are buffered for the next draw.

**Call relations**: It is a convenience wrapper around `Tui::insert_history_lines_with_wrap_policy`.

*Call graph*: calls 1 internal fn (insert_history_lines_with_wrap_policy).


##### `Tui::insert_history_lines_with_wrap_policy`  (lines 774–783)

```
fn insert_history_lines_with_wrap_policy(
        &mut self,
        lines: Vec<Line<'static>>,
        wrap_policy: HistoryLineWrapPolicy,
    )
```

**Purpose**: Queues plain text history lines with a chosen wrapping rule.

**Data flow**: It receives ratatui text lines and a wrap policy. It converts the lines into the hyperlink-aware form, then forwards them to the lower-level queueing function.

**Call relations**: `Tui::insert_history_lines` calls this with the default wrapping policy. It then hands off to `Tui::insert_history_hyperlink_lines_with_wrap_policy`.

*Call graph*: calls 2 internal fn (plain_hyperlink_lines, insert_history_hyperlink_lines_with_wrap_policy); called by 1 (insert_history_lines).


##### `Tui::insert_history_hyperlink_lines_with_wrap_policy`  (lines 785–802)

```
fn insert_history_hyperlink_lines_with_wrap_policy(
        &mut self,
        lines: Vec<HyperlinkLine>,
        wrap_policy: HistoryLineWrapPolicy,
    )
```

**Purpose**: Queues history lines that may contain terminal hyperlinks, grouping adjacent batches that use the same wrapping rule.

**Data flow**: It receives hyperlink-aware lines and a wrap policy. Empty input is ignored; otherwise it appends to the last compatible pending batch or creates a new batch, then schedules a redraw so the queued history will be flushed.

**Call relations**: `Tui::insert_history_lines_with_wrap_policy` calls this after converting plain lines. It uses `Tui::frame_requester` to make sure the draw loop wakes up.

*Call graph*: calls 1 internal fn (frame_requester); called by 1 (insert_history_lines_with_wrap_policy).


##### `Tui::clear_pending_history_lines`  (lines 804–806)

```
fn clear_pending_history_lines(&mut self)
```

**Purpose**: Drops any history lines that were queued but not yet written to terminal scrollback.

**Data flow**: It clears the `pending_history_lines` buffer inside the `Tui`. Nothing is written to the terminal.

**Call relations**: Callers can use this when queued history is no longer valid, before the next draw has a chance to flush it.


##### `Tui::update_inline_viewport_for_resize_reflow`  (lines 813–849)

```
fn update_inline_viewport_for_resize_reflow(
        terminal: &mut Terminal,
        height: u16,
    ) -> Result<bool>
```

**Purpose**: Adjusts the inline viewport during the newer resize-reflow path without accidentally scrolling already-rendered history into the wrong place.

**Data flow**: It receives the terminal and desired viewport height. It reads the current terminal size, compares it with the last known size, computes a new viewport rectangle, performs any needed scroll or clear, updates the terminal viewport, and returns whether a full repaint is needed.

**Call relations**: `Tui::draw_with_resize_reflow` calls this before flushing history and drawing, so resize-aware transcript rebuilding can happen cleanly.

*Call graph*: calls 4 internal fn (backend_mut, clear_after_position, set_viewport_area, size); 1 external calls (new).


##### `Tui::flush_pending_history_lines`  (lines 852–876)

```
fn flush_pending_history_lines(
        terminal: &mut Terminal,
        pending_history_lines: &mut Vec<PendingHistoryLines>,
        is_zellij: bool,
    ) -> Result<()>
```

**Purpose**: Writes queued history batches into terminal scrollback and then clears the queue.

**Data flow**: It receives the terminal, the pending batch list, and whether the app is running inside Zellij. For each batch it chooses the correct insertion mode, writes the hyperlink-aware lines using the batch's wrapping policy, and clears the pending list after successful insertion.

**Call relations**: Both `Tui::draw` and `Tui::draw_with_resize_reflow` call this before rendering the live frame, so completed conversation or output lines move into scrollback at the right time.

*Call graph*: calls 1 internal fn (insert_history_hyperlink_lines_with_mode_and_wrap_policy).


##### `Tui::draw`  (lines 878–951)

```
fn draw(
        &mut self,
        height: u16,
        draw_fn: impl FnOnce(&mut custom_terminal::Frame),
    ) -> Result<()>
```

**Purpose**: Draws one normal UI frame while maintaining the inline viewport and flushing pending history.

**Data flow**: It receives the desired UI height and a drawing callback. It prepares any Unix resume work, computes possible viewport movement, ensures terminal processing is enabled, performs all terminal mutations inside a synchronized update, resizes or clears the viewport as needed, flushes pending history, updates suspend cursor position, calls the drawing callback, and returns any terminal error.

**Call relations**: The app's render loop calls this for the legacy drawing path. It coordinates helpers such as `pending_viewport_area`, `clear_for_viewport_change`, and `flush_pending_history_lines` before handing a frame to caller-provided drawing code.

*Call graph*: calls 3 internal fn (pending_viewport_area, ensure_virtual_terminal_processing, prepare_resume_action); 1 external calls (stdout).


##### `Tui::draw_ambient_pet_image`  (lines 953–970)

```
fn draw_ambient_pet_image(
        &mut self,
        request: Option<crate::pets::AmbientPetDraw>,
    ) -> std::result::Result<(), crate::pets::PetImageRenderError>
```

**Purpose**: Draws or updates the ambient pet image in the terminal.

**Data flow**: It receives an optional pet draw request. It ensures terminal escape processing is available, then inside a synchronized update asks the pet renderer to draw using the terminal backend and stored ambient-pet state. Terminal errors and asset errors are returned in the pet renderer's error type.

**Call relations**: This is separate from normal text frame drawing because image rendering talks directly to the terminal backend. It uses the same synchronized-update idea as `Tui::draw` to avoid visible partial updates.

*Call graph*: calls 1 internal fn (ensure_virtual_terminal_processing); 2 external calls (stdout, Terminal).


##### `Tui::draw_pet_picker_preview_image`  (lines 972–993)

```
fn draw_pet_picker_preview_image(
        &mut self,
        request: Option<crate::pets::AmbientPetDraw>,
    ) -> std::result::Result<(), crate::pets::PetImageRenderError>
```

**Purpose**: Draws or updates the pet preview image used by the pet picker UI.

**Data flow**: It receives an optional pet draw request, ensures terminal processing is enabled, and runs the preview image renderer inside a synchronized update with its own stored image state. It returns success or a pet rendering error.

**Call relations**: This mirrors `Tui::draw_ambient_pet_image`, but uses separate state and renderer calls so the picker preview does not interfere with the ambient pet image.

*Call graph*: calls 1 internal fn (ensure_virtual_terminal_processing); 2 external calls (stdout, Terminal).


##### `Tui::clear_ambient_pet_image`  (lines 995–1007)

```
fn clear_ambient_pet_image(
        &mut self,
    ) -> std::result::Result<(), crate::pets::PetImageRenderError>
```

**Purpose**: Removes the ambient pet image from the terminal.

**Data flow**: It ensures terminal processing is enabled, then calls the ambient pet renderer with no draw request, using the stored image state to clear whatever was previously drawn. It returns success or a pet rendering error.

**Call relations**: `Tui::drop` calls this during cleanup so pet image artifacts are not left behind when the TUI is destroyed.

*Call graph*: calls 3 internal fn (backend_mut, render_ambient_pet_image, ensure_virtual_terminal_processing); called by 1 (drop); 1 external calls (Terminal).


##### `Tui::draw_with_resize_reflow`  (lines 1014–1065)

```
fn draw_with_resize_reflow(
        &mut self,
        height: u16,
        draw_fn: impl FnOnce(&mut custom_terminal::Frame),
    ) -> Result<()>
```

**Purpose**: Draws one UI frame using the resize-reflow path, where scrollback is rebuilt more carefully after terminal size changes.

**Data flow**: It receives the desired UI height and a drawing callback. It prepares Unix resume work, ensures terminal processing is enabled, updates the inline viewport with resize-reflow rules, flushes pending history, invalidates the viewport if a full repaint is needed, updates suspend cursor position, invokes the drawing callback, and returns any terminal error.

**Call relations**: This is the feature-gated counterpart to `Tui::draw`. It uses `update_inline_viewport_for_resize_reflow` instead of the legacy cursor-position heuristic from `pending_viewport_area`.

*Call graph*: calls 2 internal fn (ensure_virtual_terminal_processing, prepare_resume_action); 1 external calls (stdout).


##### `Tui::pending_viewport_area`  (lines 1067–1087)

```
fn pending_viewport_area(&mut self) -> Result<Option<Rect>>
```

**Purpose**: Estimates whether the inline viewport should move after a terminal resize in the legacy draw path.

**Data flow**: It reads the current terminal size, last known size, current cursor position, and last known cursor position. If the screen size changed and the cursor's row moved, it returns a viewport rectangle offset by that row difference; otherwise it returns no change.

**Call relations**: `Tui::draw` calls this before entering the synchronized terminal update, because reading cursor position can conflict with event reading if done at the wrong time.

*Call graph*: called by 1 (draw).


##### `ensure_virtual_terminal_processing`  (lines 1134–1136)

```
fn ensure_virtual_terminal_processing() -> Result<()>
```

**Purpose**: Makes sure the terminal can understand ANSI escape sequences, the small text commands used for cursor movement, color, clearing, and similar effects.

**Data flow**: On Windows, it enables virtual terminal processing for stdout and stderr when possible; on non-Windows platforms it simply returns success because this support is normally already present. It returns an input/output error if enabling fails.

**Call relations**: Setup, cleanup, and drawing paths call this before sending terminal control sequences: `set_modes`, `restore_common`, `Tui::draw`, pet image drawing and clearing, and `Tui::draw_with_resize_reflow`.

*Call graph*: called by 7 (clear_ambient_pet_image, draw, draw_ambient_pet_image, draw_pet_picker_preview_image, draw_with_resize_reflow, restore_common, set_modes).


### `tui/src/custom_terminal.rs`

`io_transport` · `main loop and terminal cleanup`

A terminal user interface is redrawn many times, but writing the whole screen every time is slow and can flicker. This file solves that by keeping two screen buffers: the last frame that was shown and the next frame the app wants to show. It compares them, finds only what changed, and writes just those changes to the terminal. Think of it like updating a whiteboard by changing only the letters that differ, instead of erasing and rewriting the whole board.

The `Terminal` type owns the real terminal backend, the two buffers, the viewport area, and remembered cursor state. The `Frame` type is what the rest of the app receives while drawing; widgets paint into its buffer instead of talking directly to the terminal. After drawing, `try_draw` flushes differences, applies cursor visibility and shape, swaps the buffers, and flushes output.

This file also includes careful terminal cleanup. When the `Terminal` is dropped, it tries to restore the cursor so the user’s shell is not left with a hidden or strangely shaped cursor. It has extra clearing methods for scrollback and full-screen cleanup, because terminals differ in how reliably they interpret standard clear commands. A small but important detail is `display_width`, which ignores invisible OSC escape sequences such as hyperlink metadata when measuring how many columns text occupies.

#### Function details

##### `display_width`  (lines 57–80)

```
fn display_width(s: &str) -> usize
```

**Purpose**: Computes how many terminal columns a string visibly occupies. It ignores OSC escape sequences, which are invisible control text often used for terminal hyperlinks, so layout math does not get fooled by hidden URL data.

**Data flow**: It receives a string. If there is no escape character, it directly measures the visible Unicode width; otherwise it copies only visible characters into a temporary string, skipping `ESC ] ... BEL` control sequences. It returns the number of display columns the visible text uses.

**Call relations**: The buffer comparison code calls this while deciding where characters start and end on screen. That matters especially for wide characters and hidden hyperlink escape sequences, because a wrong width would make later drawing land in the wrong columns.

*Call graph*: called by 1 (diff_buffers); 1 external calls (with_capacity).


##### `Frame::area`  (lines 107–109)

```
fn area(&self) -> Rect
```

**Purpose**: Returns the rectangle that the current frame is allowed to draw into. Code uses this as the reliable screen area for the current render pass.

**Data flow**: It reads the frame’s stored viewport rectangle and returns it unchanged. Nothing else is changed.

**Call relations**: Rendering code such as the main draw flow and the new-task page asks the frame for this area before laying out widgets. It gives them a stable size even if the real terminal is resized during the draw.

*Call graph*: called by 2 (draw, draw_new_task_page).


##### `Frame::render_widget_ref`  (lines 116–118)

```
fn render_widget_ref(&mut self, widget: W, area: Rect)
```

**Purpose**: Draws a Ratatui widget into this frame’s buffer. It lets app code render reusable UI pieces without writing terminal commands directly.

**Data flow**: It receives a widget and a rectangle. It asks the widget to paint itself into the frame’s mutable buffer inside that rectangle. It returns nothing, but the buffer now contains the widget’s cells.

**Call relations**: Picker, footer, list, and loading-overlay renderers call this when they need to place a widget in the current frame. The actual terminal is not touched yet; the later `Terminal::flush` step turns the buffer changes into output.

*Call graph*: called by 4 (render_list, render_picker_footer, render_picker_footer_separator, render_transcript_loading_overlay); 1 external calls (render_ref).


##### `Frame::set_cursor_position`  (lines 130–132)

```
fn set_cursor_position(&mut self, position: P)
```

**Purpose**: Requests that the cursor be shown at a specific position after this frame is drawn. If nobody calls it, the cursor is hidden after drawing.

**Data flow**: It receives anything convertible into a terminal position, converts it, and stores it in the frame. The visible terminal cursor is not moved immediately.

**Call relations**: Page rendering code can call this during drawing. Later, `Terminal::try_draw` reads the saved position after flushing the frame and then shows and moves the real cursor.

*Call graph*: called by 1 (draw_new_task_page); 1 external calls (into).


##### `Frame::set_cursor_style`  (lines 135–137)

```
fn set_cursor_style(&mut self, style: SetCursorStyle)
```

**Purpose**: Requests a visible cursor shape, such as a bar cursor, for after this frame is drawn. This lets a screen choose the cursor style that matches its interaction mode.

**Data flow**: It receives a cursor style command and stores it on the frame. It does not write to the terminal immediately.

**Call relations**: This setting is picked up by `Terminal::try_draw` only if the frame also asks for a visible cursor position. The terminal then applies the style before showing and placing the cursor.


##### `Frame::buffer_mut`  (lines 140–142)

```
fn buffer_mut(&mut self) -> &mut Buffer
```

**Purpose**: Gives drawing code direct mutable access to the frame’s buffer. This is used when a screen needs lower-level cell edits instead of rendering a whole widget.

**Data flow**: It returns the same mutable buffer reference held by the frame. The caller can then change individual cells or strings in that buffer.

**Call relations**: The new-task page uses this when it needs to write directly into the frame. Those buffer changes are later compared with the previous buffer and written by `Terminal::flush`.

*Call graph*: called by 1 (draw_new_task_page).


##### `Terminal::drop`  (lines 176–187)

```
fn drop(&mut self)
```

**Purpose**: Tries to leave the user’s terminal in a sane state when the `Terminal` object goes away. It resets cursor shape and restores the cursor if this code had hidden it.

**Data flow**: It reads whether the cursor is currently hidden. It sends reset/show commands through the backend, and if those fail during cleanup it prints an error to standard error.

**Call relations**: Rust calls this automatically during teardown. It calls `reset_cursor_style` and sometimes `show_cursor`, because otherwise the user’s shell could be left with an invisible or non-default cursor.

*Call graph*: calls 2 internal fn (reset_cursor_style, show_cursor); 1 external calls (eprintln!).


##### `Terminal::with_options`  (lines 196–209)

```
fn with_options(mut backend: B) -> io::Result<Self>
```

**Purpose**: Creates a `Terminal` from a backend by asking the backend for the current screen size and cursor position. It uses a safe cursor fallback if the terminal does not answer the position query.

**Data flow**: It receives a backend, asks for its size, then tries to read the cursor position. If cursor probing fails, it logs a warning and uses `(0, 0)`. It returns a ready `Terminal` or an I/O error if size lookup fails.

**Call relations**: Many snapshot tests and app startup paths use this constructor. It delegates the actual field setup to `with_screen_size_and_cursor_position` after collecting the starting facts.

*Call graph*: called by 52 (thread_goal_ephemeral_error_message_renders_snapshot, chained_config_error_wraps_in_history_snapshot, approval_modal_exec_snapshot, app_server_guardian_review_denied_renders_denied_request_snapshot, app_server_guardian_review_timed_out_renders_timed_out_request_snapshot, guardian_approved_exec_renders_approved_request, guardian_approved_request_permissions_renders_request_summary, guardian_denied_exec_renders_warning_and_denied_request, guardian_timed_out_exec_renders_warning_and_timed_out_request, app_server_mcp_startup_failure_renders_warning_history (+15 more)); 3 external calls (get_cursor_position, size, with_screen_size_and_cursor_position).


##### `Terminal::with_options_and_cursor_position`  (lines 217–224)

```
fn with_options_and_cursor_position(backend: B, cursor_pos: Position) -> io::Result<Self>
```

**Purpose**: Creates a `Terminal` when the caller already knows what cursor position should be used. This avoids probing the backend again.

**Data flow**: It receives a backend and a chosen cursor position. It asks the backend for screen size, then builds the terminal using that size and supplied position.

**Call relations**: Startup code can use this when cursor probing was already done elsewhere, especially if the probe was bounded or had a chosen fallback. It hands setup to `with_screen_size_and_cursor_position`.

*Call graph*: 2 external calls (size, with_screen_size_and_cursor_position).


##### `Terminal::with_screen_size_and_cursor_position`  (lines 226–246)

```
fn with_screen_size_and_cursor_position(
        backend: B,
        screen_size: Size,
        cursor_pos: Position,
    ) -> Self
```

**Purpose**: Builds the initial `Terminal` state from a backend, a screen size, and a cursor position. This is the shared constructor logic used after startup facts are known.

**Data flow**: It receives the backend, screen size, and cursor position. It creates two empty buffers, stores the screen and cursor state, anchors the initial viewport at the cursor row, and returns the new `Terminal`.

**Call relations**: The public constructors call this after gathering size and cursor information. Later drawing methods rely on the buffers and viewport state initialized here.

*Call graph*: 2 external calls (empty, new).


##### `Terminal::get_frame`  (lines 249–256)

```
fn get_frame(&mut self) -> Frame<'_>
```

**Purpose**: Creates the temporary `Frame` that app code draws into for one render pass. It gives drawing code a stable viewport and the current buffer.

**Data flow**: It reads the terminal’s viewport area and borrows the current buffer mutably. It returns a `Frame` with no cursor position request and the default cursor style.

**Call relations**: `Terminal::try_draw` calls this just before running the render callback. The frame is then dropped before flushing so the terminal can safely use the buffer again.

*Call graph*: calls 1 internal fn (current_buffer_mut); called by 1 (try_draw).


##### `Terminal::current_buffer`  (lines 259–261)

```
fn current_buffer(&self) -> &Buffer
```

**Purpose**: Returns the buffer that contains the frame currently being prepared or just prepared. It is used for read-only comparison.

**Data flow**: It reads the current buffer index and returns a shared reference to that buffer. No state changes.

**Call relations**: `Terminal::flush` uses this as the “next screen” when comparing against the previous buffer.

*Call graph*: called by 1 (flush).


##### `Terminal::current_buffer_mut`  (lines 264–266)

```
fn current_buffer_mut(&mut self) -> &mut Buffer
```

**Purpose**: Returns the current drawing buffer for modification. This is where the next screen image is built.

**Data flow**: It reads the current buffer index and returns a mutable reference to that buffer. Callers can resize or write into it.

**Call relations**: `get_frame` uses it to give rendering code a place to draw, and `set_viewport_area` uses it when the drawable area changes.

*Call graph*: called by 2 (get_frame, set_viewport_area).


##### `Terminal::previous_buffer`  (lines 269–271)

```
fn previous_buffer(&self) -> &Buffer
```

**Purpose**: Returns the buffer that represents what the terminal is believed to have shown last time. It is used as the baseline for diffing.

**Data flow**: It computes the inactive buffer index and returns a shared reference to that buffer. It changes nothing.

**Call relations**: `Terminal::flush` compares this buffer with the current one to decide which terminal commands are needed.

*Call graph*: called by 1 (flush).


##### `Terminal::previous_buffer_mut`  (lines 274–276)

```
fn previous_buffer_mut(&mut self) -> &mut Buffer
```

**Purpose**: Returns the inactive buffer for mutation. Resetting this buffer forces future drawing to repaint more of the screen.

**Data flow**: It computes the inactive buffer index and returns a mutable reference. Callers resize or reset it depending on what happened to the real terminal.

**Call relations**: Clearing, viewport invalidation, viewport resizing, and buffer swapping all use this helper to keep the remembered previous frame accurate.

*Call graph*: called by 7 (clear_after_position, clear_scrollback, clear_scrollback_and_visible_screen_ansi, clear_visible_screen, invalidate_viewport, set_viewport_area, swap_buffers).


##### `Terminal::backend`  (lines 279–281)

```
fn backend(&self) -> &B
```

**Purpose**: Gives read-only access to the underlying terminal backend. This is useful for inspection without allowing direct mutation.

**Data flow**: It returns a shared reference to the backend stored inside the terminal. It does not write output or change state.

**Call relations**: History insertion code uses this when it needs to inspect backend-related information without taking over the terminal drawing flow.

*Call graph*: called by 1 (insert_history_hyperlink_lines_with_mode_and_wrap_policy).


##### `Terminal::backend_mut`  (lines 284–286)

```
fn backend_mut(&mut self) -> &mut B
```

**Purpose**: Gives mutable access to the underlying backend for special terminal operations. This is an escape hatch for code that must write or query below the normal frame system.

**Data flow**: It returns a mutable reference to the backend. The caller can then perform backend-specific operations that may affect terminal state.

**Call relations**: History insertion, pet image cleanup, and inline viewport resize code call this when normal buffered drawing is not enough. Such raw operations often require later viewport invalidation or clearing.

*Call graph*: called by 3 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, clear_ambient_pet_image, update_inline_viewport_for_resize_reflow).


##### `Terminal::flush`  (lines 290–297)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Writes the prepared frame to the terminal by sending only the differences from the previous frame. This is the core efficient drawing step.

**Data flow**: It reads the previous and current buffers, asks `diff_buffers` for drawing commands, records the last printed position if there is one, and passes the commands to `draw`. It returns success or an I/O error.

**Call relations**: `Terminal::try_draw` calls this after the render callback fills the frame. `flush` delegates change detection to `diff_buffers` and actual command emission to `draw`.

*Call graph*: calls 4 internal fn (current_buffer, previous_buffer, diff_buffers, draw); called by 1 (try_draw).


##### `Terminal::resize`  (lines 303–306)

```
fn resize(&mut self, screen_size: Size) -> io::Result<()>
```

**Purpose**: Records a new terminal screen size. This keeps the terminal’s remembered size in sync with the backend.

**Data flow**: It receives a screen size, stores it as the last known size, and returns success. It does not resize buffers by itself.

**Call relations**: `autoresize` calls this when it detects that the backend size changed. Viewport buffer sizing is handled separately by `set_viewport_area`.

*Call graph*: called by 1 (autoresize).


##### `Terminal::set_viewport_area`  (lines 309–314)

```
fn set_viewport_area(&mut self, area: Rect)
```

**Purpose**: Changes the rectangle of the screen that this terminal renderer owns. It resizes both internal buffers so future frames match that area.

**Data flow**: It receives a rectangle, resizes current and previous buffers to it, stores it as the viewport, and clamps the visible history-row count so it cannot exceed the viewport’s top edge.

**Call relations**: Screen-mode changes, thread switching, inline history insertion, and resize reflow code call this when the app’s drawable area moves or changes size.

*Call graph*: calls 2 internal fn (current_buffer_mut, previous_buffer_mut); called by 6 (clear_terminal_for_thread_switch, insert_history_hyperlink_lines_with_mode_and_wrap_policy, enter_alt_screen, leave_alt_screen, update_inline_viewport_for_resize_reflow, apply); 1 external calls (top).


##### `Terminal::autoresize`  (lines 317–323)

```
fn autoresize(&mut self) -> io::Result<()>
```

**Purpose**: Checks whether the real terminal size changed and records the new size if needed. This prevents rendering with stale dimensions.

**Data flow**: It asks the backend for its current size, compares it with the stored size, and calls `resize` when they differ. It returns success or an I/O error.

**Call relations**: `try_draw` calls this before every frame. That early check avoids drawing glitches or out-of-bounds buffer access after a terminal resize.

*Call graph*: calls 2 internal fn (resize, size); called by 1 (try_draw).


##### `Terminal::draw`  (lines 348–356)

```
fn draw(&mut self, render_callback: F) -> io::Result<()>
```

**Purpose**: Draws one frame using a render callback that cannot fail. It is the simpler drawing entry point for normal UI rendering.

**Data flow**: It receives a callback, wraps it in a fallible callback that always returns success, and passes it to `try_draw`. The terminal is updated if drawing succeeds.

**Call relations**: Footer drawing code calls this when it only needs to paint and does not need to return its own error. The real work is done by `try_draw`.

*Call graph*: calls 1 internal fn (try_draw); called by 1 (draw_footer_frame).


##### `Terminal::try_draw`  (lines 393–429)

```
fn try_draw(&mut self, render_callback: F) -> io::Result<()>
```

**Purpose**: Runs a full draw cycle where the render callback may fail. It prepares a frame, lets the app paint it, flushes changes, applies cursor choices, swaps buffers, and flushes output.

**Data flow**: It checks for terminal resize, creates a frame, runs the callback, extracts cursor settings, flushes buffer differences, hides or shows and positions the cursor, swaps the buffers, and flushes the backend. If the callback fails, it returns an I/O error and does not update the terminal.

**Call relations**: `draw` calls this for simple drawing. It ties together `autoresize`, `get_frame`, `flush`, cursor methods, and `swap_buffers`, making it the main render-loop operation.

*Call graph*: calls 8 internal fn (autoresize, flush, get_frame, hide_cursor, set_cursor_position, set_cursor_style, show_cursor, swap_buffers); called by 1 (draw); 1 external calls (flush).


##### `Terminal::hide_cursor`  (lines 432–436)

```
fn hide_cursor(&mut self) -> io::Result<()>
```

**Purpose**: Hides the terminal cursor and records that it is hidden. This is used when the current frame does not ask for a visible cursor.

**Data flow**: It sends a hide-cursor command to the backend. If successful, it sets `hidden_cursor` to true and returns success.

**Call relations**: `try_draw` calls this after drawing frames that did not request a cursor position. `drop` later uses the recorded state to know whether it should restore the cursor.

*Call graph*: called by 1 (try_draw); 1 external calls (hide_cursor).


##### `Terminal::show_cursor`  (lines 439–443)

```
fn show_cursor(&mut self) -> io::Result<()>
```

**Purpose**: Shows the terminal cursor and records that it is visible. This restores normal cursor visibility when a frame needs one or when the terminal is being cleaned up.

**Data flow**: It sends a show-cursor command to the backend. If successful, it sets `hidden_cursor` to false and returns success.

**Call relations**: `try_draw` calls this when a frame requested a cursor position. `Terminal::drop` also calls it during cleanup if the cursor was hidden.

*Call graph*: called by 2 (drop, try_draw); 1 external calls (show_cursor).


##### `Terminal::set_cursor_style`  (lines 446–448)

```
fn set_cursor_style(&mut self, style: SetCursorStyle) -> io::Result<()>
```

**Purpose**: Queues a command to change the visible cursor shape. It is used for things like switching to a bar cursor while editing text.

**Data flow**: It receives a cursor style command and queues it on the backend writer. It returns any I/O error from queuing the command.

**Call relations**: `try_draw` calls this before showing a requested cursor, and `reset_cursor_style` uses it to restore the user’s default cursor shape.

*Call graph*: called by 2 (reset_cursor_style, try_draw); 1 external calls (queue!).


##### `Terminal::reset_cursor_style`  (lines 451–453)

```
fn reset_cursor_style(&mut self) -> io::Result<()>
```

**Purpose**: Restores the cursor shape to the user’s default terminal setting. This is important cleanup so the app does not leave a custom cursor behind.

**Data flow**: It sends the default-user-shape cursor style through `set_cursor_style`. It returns success or an I/O error.

**Call relations**: `Terminal::drop` calls this during teardown. Tests also check that it emits the expected reset command.

*Call graph*: calls 1 internal fn (set_cursor_style); called by 1 (drop).


##### `Terminal::get_cursor_position`  (lines 459–461)

```
fn get_cursor_position(&mut self) -> io::Result<Position>
```

**Purpose**: Asks the backend where the cursor currently is. This is a direct query to the terminal backend.

**Data flow**: It forwards the request to the backend and returns the reported position or an I/O error. It does not update the terminal’s remembered position itself.

**Call relations**: This method is available for callers that need a fresh cursor query, although the main drawing path normally tracks cursor position through `set_cursor_position` and `flush`.

*Call graph*: 1 external calls (get_cursor_position).


##### `Terminal::set_cursor_position`  (lines 464–469)

```
fn set_cursor_position(&mut self, position: P) -> io::Result<()>
```

**Purpose**: Moves the terminal cursor to a chosen position and records that position. It keeps this file’s remembered cursor location aligned with what was sent to the backend.

**Data flow**: It receives a position-like value, converts it to a `Position`, asks the backend to move the cursor there, then stores that position as the last known cursor position.

**Call relations**: `try_draw` uses this after showing a requested cursor. Full-screen and scrollback clearing methods also use it to make clear sequences more reliable.

*Call graph*: called by 3 (clear_scrollback, clear_visible_screen, try_draw); 2 external calls (set_cursor_position, into).


##### `Terminal::clear`  (lines 472–477)

```
fn clear(&mut self) -> io::Result<()>
```

**Purpose**: Clears the current viewport and forces the next frame to repaint it. It does nothing if there is no viewport area.

**Data flow**: It checks whether the viewport is empty. If not, it converts the viewport’s top-left corner into a position and calls `clear_after_position` from there.

**Call relations**: Alternate-screen entry and layout application code call this when the visible UI needs a clean redraw. The actual clear work is delegated to `clear_after_position`.

*Call graph*: calls 1 internal fn (clear_after_position); called by 2 (enter_alt_screen, apply); 2 external calls (as_position, is_empty).


##### `Terminal::clear_after_position`  (lines 480–486)

```
fn clear_after_position(&mut self, position: Position) -> io::Result<()>
```

**Purpose**: Clears from a given cursor position to the end of the visible screen and makes the next draw repaint everything. This is useful after raw terminal changes.

**Data flow**: It moves the backend cursor to the requested position, sends a clear-after-cursor command, resets the previous buffer, and returns success or an I/O error.

**Call relations**: `clear` calls this for the viewport start. History insertion and resize reflow code also call it when terminal contents outside the buffer model have changed.

*Call graph*: calls 1 internal fn (previous_buffer_mut); called by 3 (clear, insert_history_hyperlink_lines_with_mode_and_wrap_policy, update_inline_viewport_for_resize_reflow); 2 external calls (clear_region, set_cursor_position).


##### `Terminal::invalidate_viewport`  (lines 491–493)

```
fn invalidate_viewport(&mut self)
```

**Purpose**: Forces the next draw to repaint the whole viewport without immediately clearing the physical terminal. This repairs the renderer’s memory after outside changes.

**Data flow**: It resets the previous buffer. On the next diff, everything in the current buffer appears changed and will be redrawn.

**Call relations**: Callers use this after raw terminal operations that the buffer system did not see. It uses `previous_buffer_mut` to invalidate the diff baseline.

*Call graph*: calls 1 internal fn (previous_buffer_mut).


##### `Terminal::clear_scrollback`  (lines 496–509)

```
fn clear_scrollback(&mut self) -> io::Result<()>
```

**Purpose**: Clears terminal scrollback history, when the terminal supports it, and forces a redraw. Scrollback is the old text you can reach by scrolling upward.

**Data flow**: It exits early for an empty viewport. Otherwise it moves the cursor home, queues a scrollback purge, moves home again, flushes the backend writer, resets the previous buffer, and returns any I/O error.

**Call relations**: This method is available for flows that need to remove old terminal history. It uses explicit cursor positioning because some terminals are sensitive to where purge commands are issued.

*Call graph*: calls 2 internal fn (previous_buffer_mut, set_cursor_position); 3 external calls (is_empty, queue!, flush).


##### `Terminal::clear_visible_screen`  (lines 512–524)

```
fn clear_visible_screen(&mut self) -> io::Result<()>
```

**Purpose**: Clears the currently visible terminal screen and forces a full redraw. This is broader than clearing only the app’s viewport.

**Data flow**: It moves the cursor to the top-left, sends a clear-all command, moves home again, flushes output, resets the visible-history count, resets the previous buffer, and returns success or an error.

**Call relations**: Other screen-reset flows can call this when the whole visible screen must be cleaned. It relies on `set_cursor_position` and backend clearing, then invalidates the next diff.

*Call graph*: calls 2 internal fn (previous_buffer_mut, set_cursor_position); 2 external calls (clear_region, flush).


##### `Terminal::clear_scrollback_and_visible_screen_ansi`  (lines 530–543)

```
fn clear_scrollback_and_visible_screen_ansi(&mut self) -> io::Result<()>
```

**Purpose**: Performs a hard clear of both scrollback and the visible screen using one explicit ANSI escape sequence. ANSI escape sequences are text commands understood by terminals.

**Data flow**: It exits if the viewport is empty. Otherwise it writes a combined reset, home, clear-screen, purge-scrollback, and home sequence, flushes it, resets remembered cursor and history state, resets the previous buffer, and returns any I/O error.

**Call relations**: Thread-switch clearing code calls this when it needs a stronger and more reliable reset than separate backend commands. It exists because some terminals behave better with this exact combined sequence.

*Call graph*: calls 1 internal fn (previous_buffer_mut); called by 1 (clear_terminal_for_thread_switch); 3 external calls (is_empty, flush, write!).


##### `Terminal::visible_history_rows`  (lines 545–547)

```
fn visible_history_rows(&self) -> u16
```

**Purpose**: Reports how many history rows are currently visible above the viewport in inline mode. This helps other code reason about how much old content is still on screen.

**Data flow**: It reads and returns the stored `visible_history_rows` count. It does not change state.

**Call relations**: Other inline-terminal code can use this as a simple status query. The count is updated by viewport changes and history insertion notes.


##### `Terminal::note_history_rows_inserted`  (lines 549–554)

```
fn note_history_rows_inserted(&mut self, inserted_rows: u16)
```

**Purpose**: Records that new history rows were inserted above the viewport. It keeps the visible-history count accurate without letting it exceed the viewport’s top edge.

**Data flow**: It receives a row count, adds it using saturating arithmetic so it cannot overflow, then clamps the result to the viewport’s top coordinate.

**Call relations**: History hyperlink insertion code calls this after adding visible rows. Later viewport calculations can use the updated count.

*Call graph*: called by 1 (insert_history_hyperlink_lines_with_mode_and_wrap_policy); 1 external calls (top).


##### `Terminal::swap_buffers`  (lines 557–560)

```
fn swap_buffers(&mut self)
```

**Purpose**: Moves to the other buffer after a successful draw. This makes the just-drawn buffer become the previous frame for the next comparison.

**Data flow**: It resets the inactive buffer, then flips the current-buffer index between 0 and 1. It returns nothing.

**Call relations**: `try_draw` calls this after flushing and cursor updates. Without this swap, the next frame would be compared against the wrong baseline.

*Call graph*: calls 1 internal fn (previous_buffer_mut); called by 1 (try_draw).


##### `Terminal::size`  (lines 563–565)

```
fn size(&self) -> io::Result<Size>
```

**Purpose**: Asks the backend for the real terminal size. This is the direct size query used before drawing and during layout changes.

**Data flow**: It forwards the size request to the backend and returns the size or an I/O error. It does not update stored size by itself.

**Call relations**: `autoresize`, alternate-screen setup, resize reflow, and layout application code use this when they need current dimensions.

*Call graph*: called by 4 (autoresize, enter_alt_screen, update_inline_viewport_for_resize_reflow, apply); 1 external calls (size).


##### `diff_buffers`  (lines 576–639)

```
fn diff_buffers(a: &Buffer, b: &Buffer) -> Vec<DrawCommand>
```

**Purpose**: Compares the previous and next screen buffers and produces drawing commands for only the needed changes. This is what makes rendering efficient and avoids unnecessary terminal output.

**Data flow**: It receives two buffers. It scans each row to find where useful content ends, emits row-clear commands when trailing content can be cleared cheaply, then walks cells to emit put commands for changed cells while respecting wide characters and skipped cells. It returns a list of draw commands.

**Call relations**: `Terminal::flush` calls this every successful frame. Tests call it directly to verify important edge cases, such as full-width rows and wide Chinese characters.

*Call graph*: calls 1 internal fn (display_width); called by 3 (flush, diff_buffers_clear_to_end_starts_after_wide_char, diff_buffers_does_not_emit_clear_to_end_for_full_width_row); 4 external calls (pos_of, empty, max, vec!).


##### `draw`  (lines 641–698)

```
fn draw(writer: &mut impl Write, commands: I) -> io::Result<()>
```

**Purpose**: Turns draw commands into real terminal escape commands written to a writer. It moves the cursor, applies colors and text modifiers, prints symbols, and clears row tails.

**Data flow**: It receives a writer and an iterator of draw commands. It tracks the current foreground, background, text modifiers, and cursor position so it only sends changes when needed. It queues terminal commands and resets colors and attributes at the end.

**Call relations**: `Terminal::flush` calls this after `diff_buffers` decides what changed. `draw` is the final bridge from buffer-level intentions to terminal bytes.

*Call graph*: called by 1 (flush); 3 external calls (empty, matches!, queue!).


##### `ModifierDiff::queue`  (lines 709–764)

```
fn queue(self, w: &mut W) -> io::Result<()>
```

**Purpose**: Queues only the text-style changes needed to move from one modifier set to another. Modifiers are styles such as bold, italic, underline, blink, or reverse video.

**Data flow**: It receives the old and new modifier sets. It first queues commands to turn off removed styles, then queues commands to turn on added styles, taking care with styles such as bold and dim that share intensity behavior. It returns success or an I/O error.

**Call relations**: `draw` creates a `ModifierDiff` whenever the next cell’s style differs from the currently active style. This avoids sending a full style reset for every character.

*Call graph*: 2 external calls (contains, queue!).


##### `tests::CaptureBackend::new`  (lines 782–788)

```
fn new(width: u16, height: u16) -> Self
```

**Purpose**: Creates a fake terminal backend for tests. It captures output bytes instead of writing to a real terminal.

**Data flow**: It receives a width and height, creates an empty output buffer, stores the given size, sets the cursor to `(0, 0)`, and returns the fake backend.

**Call relations**: Cursor-style tests use this backend through `Terminal::with_options` so they can inspect what commands would have been sent.

*Call graph*: 1 external calls (new).


##### `tests::CaptureBackend::output`  (lines 790–792)

```
fn output(&self) -> String
```

**Purpose**: Returns the fake backend’s captured bytes as a string for test assertions. Invalid UTF-8 bytes are converted lossily so tests can still inspect output.

**Data flow**: It reads the backend’s output byte vector, converts it to a string-like value, and returns an owned `String`.

**Call relations**: Tests call this after drawing or resetting cursor style to check whether the expected escape sequence was emitted.

*Call graph*: 1 external calls (from_utf8_lossy).


##### `tests::CaptureBackend::write`  (lines 796–799)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Implements writing for the fake backend by appending bytes to memory. This lets queued terminal commands be captured during tests.

**Data flow**: It receives a byte slice, copies those bytes into the backend’s output vector, and reports that all bytes were written.

**Call relations**: Crossterm queueing and terminal drawing use this through the standard `Write` trait during tests. It replaces real terminal output with inspectable memory.


##### `tests::CaptureBackend::draw`  (lines 807–812)

```
fn draw(&mut self, _content: I) -> io::Result<()>
```

**Purpose**: Provides the backend drawing method required by Ratatui, but does nothing. The tests in this file focus on queued output, not Ratatui’s backend draw path.

**Data flow**: It receives an iterator of cell content and ignores it. It returns success without changing state.

**Call relations**: This exists so `CaptureBackend` satisfies the `Backend` trait and can be used to construct a `Terminal` in tests.


##### `tests::CaptureBackend::hide_cursor`  (lines 814–816)

```
fn hide_cursor(&mut self) -> io::Result<()>
```

**Purpose**: Pretends to hide the cursor in tests. It succeeds without producing output.

**Data flow**: It receives no extra data, changes nothing, and returns success.

**Call relations**: The terminal draw flow may call this when a frame does not request a cursor. The fake implementation keeps tests simple.


##### `tests::CaptureBackend::show_cursor`  (lines 818–820)

```
fn show_cursor(&mut self) -> io::Result<()>
```

**Purpose**: Pretends to show the cursor in tests. It succeeds without producing output.

**Data flow**: It receives no extra data, changes nothing, and returns success.

**Call relations**: The terminal draw flow calls this when a frame requests a visible cursor. The fake backend allows that path to run without a real terminal.


##### `tests::CaptureBackend::get_cursor_position`  (lines 822–824)

```
fn get_cursor_position(&mut self) -> io::Result<Position>
```

**Purpose**: Returns the fake backend’s stored cursor position. This supports terminal construction and cursor-related test paths.

**Data flow**: It reads the backend’s `cursor` field and returns it as a successful result.

**Call relations**: `Terminal::with_options` calls this during setup in tests, just as it would query a real backend in the app.


##### `tests::CaptureBackend::set_cursor_position`  (lines 826–829)

```
fn set_cursor_position(&mut self, position: P) -> io::Result<()>
```

**Purpose**: Updates the fake backend’s stored cursor position. This simulates moving the terminal cursor.

**Data flow**: It receives a position-like value, converts it, stores it in the fake backend, and returns success.

**Call relations**: Terminal cursor and clear methods can call this during tests. It lets code paths that depend on cursor movement execute without terminal I/O.

*Call graph*: 1 external calls (into).


##### `tests::CaptureBackend::clear`  (lines 831–833)

```
fn clear(&mut self) -> io::Result<()>
```

**Purpose**: Pretends to clear the fake terminal. It does nothing and succeeds.

**Data flow**: It receives no extra input, changes no state, and returns success.

**Call relations**: This is part of the `Backend` trait implementation. It is present so the fake backend can stand in for a real one.


##### `tests::CaptureBackend::clear_region`  (lines 835–837)

```
fn clear_region(&mut self, _clear_type: ClearType) -> io::Result<()>
```

**Purpose**: Pretends to clear a requested region of the fake terminal. It ignores the clear type and succeeds.

**Data flow**: It receives a clear-region request, does not change output or cursor state, and returns success.

**Call relations**: Terminal clearing code can call this in tests without affecting a real terminal. The method exists to satisfy the backend contract.


##### `tests::CaptureBackend::append_lines`  (lines 839–841)

```
fn append_lines(&mut self, _line_count: u16) -> io::Result<()>
```

**Purpose**: Pretends to append lines in the fake terminal. It accepts the request but does not store any screen content.

**Data flow**: It receives a line count, ignores it, and returns success.

**Call relations**: This completes the fake backend’s trait implementation for code paths that might append terminal lines.


##### `tests::CaptureBackend::scroll_region_up`  (lines 843–849)

```
fn scroll_region_up(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> io::Result<()>
```

**Purpose**: Pretends to scroll a region upward in the fake terminal. It succeeds without changing memory.

**Data flow**: It receives a row range and scroll amount, ignores both, and returns success.

**Call relations**: The fake backend includes this so it can satisfy Ratatui’s backend interface even though these tests do not inspect scrolling behavior.


##### `tests::CaptureBackend::scroll_region_down`  (lines 851–857)

```
fn scroll_region_down(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> io::Result<()>
```

**Purpose**: Pretends to scroll a region downward in the fake terminal. It succeeds without changing memory.

**Data flow**: It receives a row range and scroll amount, ignores both, and returns success.

**Call relations**: This is another required backend method. It lets terminal code compile and run in tests without a real scrolling terminal.


##### `tests::CaptureBackend::size`  (lines 859–861)

```
fn size(&self) -> io::Result<Size>
```

**Purpose**: Returns the fake terminal’s configured size. Tests use this to make terminal setup deterministic.

**Data flow**: It reads the stored size and returns it as a successful result.

**Call relations**: `Terminal::with_options` and resize checks call this in tests the same way they would call a real backend.


##### `tests::CaptureBackend::window_size`  (lines 863–868)

```
fn window_size(&mut self) -> io::Result<WindowSize>
```

**Purpose**: Returns a fake full window-size report. It uses the same stored size for both character cells and pixels.

**Data flow**: It reads the stored size and builds a `WindowSize` with that size in both fields. It returns success.

**Call relations**: This satisfies the backend trait for tests. The exact pixel value is not important for the tests in this file.


##### `tests::CaptureBackend::flush`  (lines 870–872)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Pretends to flush output from the fake backend. Since output is already stored in memory, there is nothing to do.

**Data flow**: It receives no extra input, changes nothing, and returns success.

**Call relations**: Terminal drawing and tests may call backend flush after queueing commands. This fake implementation keeps the captured output available for inspection.


##### `tests::diff_buffers_does_not_emit_clear_to_end_for_full_width_row`  (lines 876–901)

```
fn diff_buffers_does_not_emit_clear_to_end_for_full_width_row()
```

**Purpose**: Checks that `diff_buffers` does not clear past the end of a row when the changed cell is in the final column. This guards against an off-by-one drawing bug.

**Data flow**: It creates previous and next buffers for a small area, puts an `X` in the last column of the first row, runs `diff_buffers`, then asserts there is no clear-to-end command for that row and that the final cell is updated.

**Call relations**: This test calls `diff_buffers` directly. It protects the logic used by `Terminal::flush` during normal drawing.

*Call graph*: calls 1 internal fn (diff_buffers); 4 external calls (empty, new, assert!, assert_eq!).


##### `tests::diff_buffers_clear_to_end_starts_after_wide_char`  (lines 904–919)

```
fn diff_buffers_clear_to_end_starts_after_wide_char()
```

**Purpose**: Checks that clearing after a wide character starts in the correct column. Wide characters, such as many Chinese characters, occupy two terminal columns.

**Data flow**: It creates a previous buffer containing two wide characters and a next buffer containing one. It runs `diff_buffers` and asserts that the clear-to-end command begins after the remaining wide character.

**Call relations**: This test exercises the same width logic that `Terminal::flush` relies on. It helps ensure `display_width` and row-tail clearing work together correctly.

*Call graph*: calls 1 internal fn (diff_buffers); 4 external calls (empty, new, default, assert!).


##### `tests::terminal_draw_applies_requested_cursor_style`  (lines 922–944)

```
fn terminal_draw_applies_requested_cursor_style()
```

**Purpose**: Checks that a frame’s requested cursor style is actually emitted during drawing. This ensures screens can request a cursor shape and see it reach the terminal backend.

**Data flow**: It creates a terminal with the fake backend, sets a viewport, draws a frame that requests a steady bar cursor at `(0, 0)`, builds the expected escape sequence, then asserts the captured output contains it.

**Call relations**: This test goes through `Terminal::with_options` and `try_draw`, then inspects `CaptureBackend::output`. It verifies the connection between `Frame::set_cursor_style` and `Terminal::set_cursor_style`.

*Call graph*: calls 1 internal fn (with_options); 6 external calls (new, from_utf8, new, assert!, queue!, new).


##### `tests::reset_cursor_style_emits_default_user_shape`  (lines 947–963)

```
fn reset_cursor_style_emits_default_user_shape()
```

**Purpose**: Checks that resetting the cursor style emits the default-user-shape command. This protects cleanup behavior that should restore the user’s terminal.

**Data flow**: It creates a terminal with the fake backend, calls `reset_cursor_style`, flushes the backend, builds the expected reset sequence, and asserts the captured output contains it.

**Call relations**: This test covers the same reset command that `Terminal::drop` uses during teardown. It confirms cleanup will send the intended terminal instruction.

*Call graph*: calls 1 internal fn (with_options); 6 external calls (from_utf8, new, assert!, queue!, flush, new).


### `tui/src/terminal_probe.rs`

`io_transport` · `startup and resume probing`

A terminal can answer special escape-code questions, but some terminals do not answer them at all. Waiting too long would slow every startup. This file is the TUI's fast “knock on the door”: it sends a small query, listens briefly, and uses the answer only if it arrives in time.

The probes are best-effort. If the terminal does not reply, the caller gets `None` and can use safe fallback behavior. That matters for first paint: the UI can still start even if exact cursor position, default foreground/background colors, or advanced keyboard support are unknown.

On Unix, the file opens temporary terminal input and output handles, makes input nonblocking, sends escape sequences, and reads bytes until a parser recognizes the expected reply or the deadline passes. It restores the terminal file flags afterward. On Windows, it first tries similar OSC color replies through console handles, and can fall back to the Windows console color table.

One important caution is that bytes read during a probe are consumed. Like checking the mailbox and throwing away unrelated flyers, the probe may discard unrelated pending input. For that reason it is only used while the normal Crossterm event reader is not running or is paused.

#### Function details

##### `imp::Tty::open`  (lines 81–120)

```
fn open() -> io::Result<Self>
```

**Purpose**: Opens a temporary terminal reader and writer for Unix probes. It prefers duplicated standard input and output, but falls back to `/dev/tty` when standard streams are redirected or unavailable.

**Data flow**: It starts with the process standard input and output file descriptors. It tries to duplicate them so the probe owns its own handles; if that fails, it opens the controlling terminal path instead. It returns a `Tty` ready for probing, or an error explaining why no terminal handle could be opened.

**Call relations**: Startup, cursor-position, and color probes call this before sending terminal questions. It hands the opened files to `imp::Tty::new`, which prepares the reader for short nonblocking reads.

*Call graph*: 4 external calls (new, new, format!, dup_file).


##### `imp::Tty::new`  (lines 122–136)

```
fn new(reader: File, writer: File) -> io::Result<Self>
```

**Purpose**: Builds a Unix probe handle from an already opened reader and writer. It saves the reader's current settings and switches only the reader into nonblocking mode.

**Data flow**: It receives two file objects. It reads the current file flags from the reader, sets the nonblocking flag, and stores the original flags inside the `Tty`. The result is a handle that can check for available input without getting stuck.

**Call relations**: `imp::Tty::open` uses this after it has either duplicated stdio or opened `/dev/tty`. The saved flags are later used by `imp::Tty::drop` to put the reader back the way it was.

*Call graph*: 3 external calls (as_raw_fd, last_os_error, fcntl).


##### `imp::Tty::write_all`  (lines 138–141)

```
fn write_all(&mut self, bytes: &[u8]) -> io::Result<()>
```

**Purpose**: Sends a complete terminal query and flushes it so the terminal sees it immediately. This is used for escape-code requests such as “report cursor position” or “report default colors.”

**Data flow**: It receives bytes to write. It writes every byte to the terminal writer and then flushes the writer. It returns success when the whole request has been pushed out, or an input/output error if writing fails.

**Call relations**: Probe functions call this right after opening the temporary terminal handle. After the query is sent, reading helpers wait for the terminal's reply.

*Call graph*: 2 external calls (flush, write_all).


##### `imp::Tty::read_available`  (lines 143–169)

```
fn read_available(&mut self, buffer: &mut Vec<u8>) -> io::Result<()>
```

**Purpose**: Reads whatever terminal input is currently available without waiting. This lets a probe collect response bytes while still respecting a short deadline.

**Data flow**: It receives a mutable byte buffer. It repeatedly reads chunks from the terminal reader and appends them to the buffer until there is no more immediate data, the read is interrupted, or an error occurs. The buffer grows with any bytes that were available.

**Call relations**: The Unix probe loops call this before trying to parse a response. If no full answer is found, they use `imp::Tty::poll_readable` to wait briefly for more bytes.

*Call graph*: 4 external calls (as_raw_fd, last_os_error, read, matches!).


##### `imp::Tty::poll_readable`  (lines 171–201)

```
fn poll_readable(&self, timeout: Duration) -> io::Result<bool>
```

**Purpose**: Waits for the Unix terminal reader to become readable, but only up to a given timeout. It prevents the probe from sleeping longer than its caller allowed.

**Data flow**: It receives a duration. It calculates a deadline, asks the operating system whether input is available, retries if the wait is interrupted, and returns `true` if bytes can be read or `false` if time ran out.

**Call relations**: Read loops use this after parsing fails on the bytes already collected. When it says input is ready, the loop goes back to `imp::Tty::read_available`; when it times out, the probe gives up cleanly.

*Call graph*: 4 external calls (as_raw_fd, now, last_os_error, poll).


##### `imp::Tty::drop`  (lines 205–208)

```
fn drop(&mut self)
```

**Purpose**: Restores the Unix terminal reader's original file flags when the temporary probe handle is no longer used. This avoids leaving standard input in nonblocking mode by accident.

**Data flow**: It reads the stored original flags from the `Tty` and applies them back to the reader file descriptor. It ignores restoration errors because cleanup is happening during drop.

**Call relations**: This runs automatically when a `Tty` value goes out of scope. It completes the setup done by `imp::Tty::new`.

*Call graph*: 2 external calls (as_raw_fd, fcntl).


##### `imp::dup_file`  (lines 212–218)

```
fn dup_file(fd: libc::c_int) -> io::Result<File>
```

**Purpose**: Duplicates an existing Unix file descriptor so the probe can own and close the duplicate safely. This keeps cleanup from closing the real standard input or output.

**Data flow**: It receives a raw file descriptor number. It asks the operating system to duplicate it and wraps the duplicate in a `File`. It returns that file or the operating system error from the failed duplication.

**Call relations**: `imp::Tty::open` uses this for standard input and output before falling back to `/dev/tty`.

*Call graph*: 3 external calls (from_raw_fd, last_os_error, dup).


##### `imp::cursor_position`  (lines 240–244)

```
fn cursor_position(timeout: Duration) -> io::Result<Option<Position>>
```

**Purpose**: Asks the terminal where the cursor is, using a short timeout. This is useful when the TUI resumes and needs to resynchronize without waiting on slow public helpers.

**Data flow**: It receives a timeout, opens a temporary terminal handle, writes the cursor-position request, and reads until `imp::parse_cursor_position` recognizes a reply. It returns the position if found, `None` if no reply arrives in time, or an I/O error.

**Call relations**: The suspend/resume flow calls this while normal input polling is paused. It delegates opening, writing, and bounded reading to the lower-level terminal helpers.

*Call graph*: called by 1 (suspend); 2 external calls (open, read_until).


##### `imp::startup`  (lines 250–264)

```
fn startup(
        timeout: Duration,
        keyboard_probe: StartupKeyboardEnhancementProbe,
    ) -> io::Result<StartupProbe>
```

**Purpose**: Runs the startup terminal probes as one batch. It can ask for cursor position, default colors, and optionally keyboard enhancement support under one shared deadline.

**Data flow**: It receives a timeout and a choice of whether to query keyboard support. It opens the terminal, writes all requested query escape sequences at once, and then collects replies into a `StartupProbe` result. Missing replies stay as `None`.

**Call relations**: The TUI initialization path calls this before the first frame. It hands the reading and parsing work to `imp::read_startup_probe` so startup pays one short wait instead of several separate waits.

*Call graph*: called by 1 (init); 2 external calls (open, read_startup_probe).


##### `imp::read_startup_probe`  (lines 293–327)

```
fn read_startup_probe(
        tty: &mut Tty,
        timeout: Duration,
        keyboard_probe: StartupKeyboardEnhancementProbe,
    ) -> io::Result<StartupProbe>
```

**Purpose**: Collects replies for the batched Unix startup probe until all requested answers arrive or time runs out. It keeps partial results instead of treating a missing answer as total failure.

**Data flow**: It receives the temporary terminal handle, a timeout, and the keyboard-probe choice. It repeatedly reads available bytes, updates a `StartupProbe` from the accumulated buffer, checks whether the probe is complete, and waits briefly for more input if needed. It returns whatever answers were found by the deadline.

**Call relations**: `imp::startup` calls this after sending the batched query. It relies on `imp::update_startup_probe` for parsing, `imp::startup_probe_complete` to know when to stop early, and `imp::finish_startup_probe` to settle keyboard support at timeout.

*Call graph*: 7 external calls (now, new, poll_readable, read_available, finish_startup_probe, startup_probe_complete, update_startup_probe).


##### `imp::update_startup_probe`  (lines 329–358)

```
fn update_startup_probe(
        probe: &mut StartupProbe,
        saw_supported_keyboard: &mut bool,
        buffer: &[u8],
        keyboard_probe: StartupKeyboardEnhancementProbe,
    )
```

**Purpose**: Looks through the accumulated startup response bytes and fills in any missing probe answers. It does not overwrite answers that were already found.

**Data flow**: It receives the current `StartupProbe`, a flag remembering whether keyboard support was seen, the byte buffer, and the keyboard-probe mode. It tries to parse cursor position, default colors, and keyboard support from the buffer. The `StartupProbe` and keyboard flag are updated in place.

**Call relations**: `imp::read_startup_probe` calls this after each read. It uses the shared color parser plus Unix-specific parsers for cursor position and keyboard capability.

*Call graph*: calls 1 internal fn (parse_default_colors); 2 external calls (parse_cursor_position, parse_keyboard_enhancement_support).


##### `imp::startup_probe_complete`  (lines 360–368)

```
fn startup_probe_complete(
        probe: &StartupProbe,
        keyboard_probe: StartupKeyboardEnhancementProbe,
    ) -> bool
```

**Purpose**: Decides whether the startup probe has all the answers it was asked to collect. This lets startup stop early instead of waiting until the timeout expires.

**Data flow**: It receives the current `StartupProbe` and the keyboard-probe mode. It checks whether cursor position and default colors are present, and also keyboard support when that query was requested. It returns a simple yes/no answer.

**Call relations**: `imp::read_startup_probe` calls this after each update. A `true` result ends the probe loop immediately.


##### `imp::finish_startup_probe`  (lines 370–380)

```
fn finish_startup_probe(
        probe: &mut StartupProbe,
        keyboard_probe: StartupKeyboardEnhancementProbe,
        saw_supported_keyboard: bool,
    )
```

**Purpose**: Finalizes the keyboard support answer when the startup probe times out or no more input is available. It preserves a positive keyboard signal even if the fallback response was not drained in time.

**Data flow**: It receives the partially filled probe, the keyboard-probe mode, and whether supported keyboard flags were seen. If keyboard probing was requested and no final answer exists, it sets support to `Some(true)` only when the supported signal was seen; otherwise it leaves it unknown.

**Call relations**: `imp::read_startup_probe` calls this when it cannot complete all requested answers before stopping. It complements `imp::update_startup_probe`, which records the earlier keyboard signal.


##### `imp::parse_cursor_position`  (lines 382–405)

```
fn parse_cursor_position(buffer: &[u8]) -> Option<Position>
```

**Purpose**: Extracts a terminal cursor-position reply from raw bytes. It converts the terminal's one-based row and column numbers into the zero-based coordinates used by the TUI layout code.

**Data flow**: It receives a byte buffer that may contain noise before or after the reply. It searches for escape sequences shaped like a cursor report, parses row and column as numbers, subtracts one from each without underflowing, and returns a `Position` if successful.

**Call relations**: `imp::cursor_position` and `imp::update_startup_probe` use this while reading probe replies. It uses `imp::find_all_subslices` to find candidate escape-sequence starts.

*Call graph*: 2 external calls (from_utf8, find_all_subslices).


##### `imp::parse_keyboard_enhancement_support`  (lines 423–433)

```
fn parse_keyboard_enhancement_support(buffer: &[u8]) -> KeyboardProbeState
```

**Purpose**: Classifies whether the terminal seems to support Crossterm's enhanced keyboard protocol. It also notices the ordinary device-attributes fallback reply that means support is absent.

**Data flow**: It receives all bytes read so far. It checks for enhanced keyboard flags and for a primary device attributes response. It returns a small state saying pending, unsupported fallback, supported, or supported plus fallback.

**Call relations**: `imp::update_startup_probe` calls this during startup when keyboard probing is enabled. It delegates the two pattern searches to `imp::find_keyboard_flags` and `imp::find_primary_device_attributes`.

*Call graph*: 2 external calls (find_keyboard_flags, find_primary_device_attributes).


##### `imp::find_keyboard_flags`  (lines 435–466)

```
fn find_keyboard_flags(buffer: &[u8]) -> Option<KeyboardEnhancementFlags>
```

**Purpose**: Finds and decodes an enhanced keyboard capability reply in the terminal byte stream. The decoded flags tell which extra keyboard reporting features the terminal says it can use.

**Data flow**: It receives raw bytes, searches for the keyboard reply prefix, reads the numeric bit field before the ending marker, and converts those bits into `KeyboardEnhancementFlags`. It returns the flags if a valid reply is found.

**Call relations**: `imp::parse_keyboard_enhancement_support` uses this as the positive-support check. It scans candidate positions found by `imp::find_all_subslices`.

*Call graph*: 3 external calls (empty, from_utf8, find_all_subslices).


##### `imp::find_primary_device_attributes`  (lines 468–479)

```
fn find_primary_device_attributes(buffer: &[u8]) -> Option<()>
```

**Purpose**: Detects a normal primary device attributes reply from the terminal. In this probe, that reply acts as the fallback signal that enhanced keyboard support was not reported.

**Data flow**: It receives raw bytes and searches for a device-attributes escape sequence ending in `c`. It accepts only digit and semicolon payloads. It returns `Some(())` when such a reply is found, otherwise `None`.

**Call relations**: `imp::parse_keyboard_enhancement_support` uses this alongside `imp::find_keyboard_flags` to decide whether keyboard probing is supported, unsupported, or still pending.

*Call graph*: 1 external calls (find_all_subslices).


##### `imp::find_all_subslices`  (lines 481–489)

```
fn find_all_subslices(
        haystack: &'a [u8],
        needle: &'a [u8],
    ) -> impl Iterator<Item = usize> + 'a
```

**Purpose**: Finds every place where a smaller byte pattern appears inside a larger byte buffer. It is a small search helper for terminal escape sequence parsing.

**Data flow**: It receives a haystack buffer and a needle pattern. It slides across the buffer and yields each starting index where the bytes match. Nothing is changed.

**Call relations**: Unix parsers use this to find possible starts of cursor, keyboard, and device-attributes replies without assuming the response begins at byte zero.


##### `imp::tests::parses_cursor_position_as_zero_based`  (lines 497–506)

```
fn parses_cursor_position_as_zero_based()
```

**Purpose**: Checks that cursor-position replies are parsed correctly and converted from terminal numbering to TUI numbering. It also verifies that unrelated focus-report bytes before the reply do not confuse the parser.

**Data flow**: The test feeds sample byte strings into the cursor parser and compares the result with expected `Position` values. It produces a passing or failing test result.

**Call relations**: The test runner calls this during automated tests. It protects the behavior used by resume and startup probing.

*Call graph*: 1 external calls (assert_eq!).


##### `imp::tests::parses_keyboard_enhancement_flags_and_pda_fallback`  (lines 509–530)

```
fn parses_keyboard_enhancement_flags_and_pda_fallback()
```

**Purpose**: Checks the keyboard enhancement parser's main states. It covers supported replies, fallback-only replies, both orders of combined replies, and an empty pending buffer.

**Data flow**: The test sends fixed byte samples into the keyboard support parser and compares each returned state with the expected one. It changes no production data.

**Call relations**: The test runner calls this to guard the startup keyboard detection rules used by `imp::update_startup_probe`.

*Call graph*: 1 external calls (assert_eq!).


##### `imp::tests::startup_probe_parses_batched_terminal_responses`  (lines 533–562)

```
fn startup_probe_parses_batched_terminal_responses()
```

**Purpose**: Checks that a mixed startup response buffer can fill all startup probe fields. It proves the parser can handle cursor, colors, device attributes, and keyboard flags arriving together.

**Data flow**: The test creates an empty `StartupProbe`, feeds one combined byte buffer into `imp::update_startup_probe`, and then compares the filled result with the expected cursor, colors, and keyboard support. It also checks that the probe is considered complete.

**Call relations**: The test runner calls this as a focused check of the batched startup parsing path used by `imp::read_startup_probe`.

*Call graph*: 3 external calls (assert!, assert_eq!, update_startup_probe).


##### `imp::default_colors`  (lines 595–607)

```
fn default_colors(timeout: Duration) -> io::Result<Option<DefaultColors>>
```

**Purpose**: Finds the terminal's default foreground and background colors if they can be discovered quickly. On Windows it can also fall back to the console's own color table when OSC replies are unavailable.

**Data flow**: It receives a timeout. It tries to get usable console or terminal handles, sends or delegates an OSC color query where supported, and returns the color pair if both colors are known. If the terminal does not answer or handles are unavailable, it returns `None` rather than failing the UI.

**Call relations**: Higher-level palette probing calls this through `query_default_colors` or the Windows-specific probing path. It uses lower-level helpers to get handles, query OSC replies, or decode console defaults.

*Call graph*: called by 2 (query_default_colors, probe_windows_default_colors); 5 external calls (open, query_console_default_colors, query_osc_default_colors, read_until, std_handle).


##### `imp::query_osc_default_colors`  (lines 609–617)

```
fn query_osc_default_colors(
        input: HANDLE,
        output: HANDLE,
        timeout: Duration,
    ) -> io::Result<Option<DefaultColors>>
```

**Purpose**: On Windows, asks the terminal for default colors using OSC escape-code replies. It temporarily enables virtual terminal input so those replies can be read from the console input handle.

**Data flow**: It receives input and output handles plus a timeout. It enables virtual-terminal input, writes the foreground/background color query, reads until the shared color parser recognizes both answers or time expires, and returns the optional color pair.

**Call relations**: `imp::default_colors` calls this before falling back to console color-table decoding. It relies on `imp::VirtualTerminalInputMode::enable`, `imp::write_all`, and `imp::read_until`.

*Call graph*: 3 external calls (enable, read_until, write_all).


##### `imp::query_console_default_colors`  (lines 619–629)

```
fn query_console_default_colors(output: HANDLE) -> io::Result<Option<DefaultColors>>
```

**Purpose**: On Windows, reads the console's configured color table and current foreground/background attributes. This is a fallback when terminal OSC color replies are missing.

**Data flow**: It receives an output console handle. It asks Windows for extended screen-buffer information, then decodes the active color indexes into RGB values. It returns the resulting default colors or an operating system error.

**Call relations**: `imp::default_colors` calls this after the OSC route fails or is unavailable. It hands the actual color-index decoding to `imp::decode_console_default_colors`.

*Call graph*: 3 external calls (last_os_error, decode_console_default_colors, GetConsoleScreenBufferInfoEx).


##### `imp::decode_console_default_colors`  (lines 631–640)

```
fn decode_console_default_colors(attributes: u16, color_table: &[u32; 16]) -> DefaultColors
```

**Purpose**: Converts Windows console attribute bits and a 16-entry color table into foreground and background RGB colors. It intentionally reads the configured defaults rather than trying to interpret reverse-video rendering.

**Data flow**: It receives the console attribute word and color table. It extracts the low four bits as the foreground index and the next four bits as the background index, decodes both table entries, and returns a `DefaultColors` value.

**Call relations**: `imp::query_console_default_colors` uses this after fetching console screen-buffer information. Unit tests call it to lock down Windows color behavior.

*Call graph*: 1 external calls (decode_color_ref).


##### `imp::decode_color_ref`  (lines 642–648)

```
fn decode_color_ref(color_ref: u32) -> (u8, u8, u8)
```

**Purpose**: Decodes a Windows `COLORREF` value into a normal red, green, blue tuple. Windows stores these bytes in blue-shifted integer form, so this helper makes the order explicit.

**Data flow**: It receives a 32-bit color number. It extracts the low byte as red, the next byte as green, and the next byte as blue. It returns those three 8-bit values.

**Call relations**: `imp::decode_console_default_colors` calls this for both foreground and background table entries.


##### `imp::std_handle`  (lines 650–656)

```
fn std_handle(kind: u32) -> io::Result<HANDLE>
```

**Purpose**: Fetches a Windows standard handle, such as standard input or standard output, and rejects invalid handles. This gives the probe a safe starting point for console I/O.

**Data flow**: It receives a handle kind constant. It asks Windows for that handle and checks for null or invalid values. It returns the handle on success or the last operating system error on failure.

**Call relations**: `imp::default_colors` uses this before trying either OSC color probing or console color-table fallback.

*Call graph*: 2 external calls (last_os_error, GetStdHandle).


##### `imp::VirtualTerminalInputMode::enable`  (lines 664–679)

```
fn enable(handle: HANDLE) -> io::Result<Self>
```

**Purpose**: Temporarily turns on Windows virtual terminal input for a console handle. This allows escape-code replies to be delivered in a form the probe can read.

**Data flow**: It receives an input handle. It reads the current console mode, adds the virtual-terminal-input flag, applies the new mode, and returns a guard object that remembers the original mode.

**Call relations**: `imp::query_osc_default_colors` uses this before sending OSC queries. The returned guard's drop function restores the original mode when the query ends.

*Call graph*: 3 external calls (last_os_error, GetConsoleMode, SetConsoleMode).


##### `imp::VirtualTerminalInputMode::drop`  (lines 683–687)

```
fn drop(&mut self)
```

**Purpose**: Restores the Windows console input mode that was active before a probe enabled virtual terminal input. This prevents a short color probe from changing later input behavior.

**Data flow**: It uses the stored handle and original mode inside the guard object. It calls Windows to set the mode back. It does not return a value.

**Call relations**: This runs automatically when the guard from `imp::VirtualTerminalInputMode::enable` leaves scope, usually at the end of `imp::query_osc_default_colors`.

*Call graph*: 1 external calls (SetConsoleMode).


##### `imp::write_all`  (lines 690–711)

```
fn write_all(handle: HANDLE, mut bytes: &[u8]) -> io::Result<()>
```

**Purpose**: Writes a full byte sequence to a Windows handle. It loops because a single Windows write call may write only part of the data.

**Data flow**: It receives an output handle and a byte slice. It writes chunks until no bytes remain, advancing through the slice after each successful write. It returns success, a Windows error, or a write-zero error if progress stops.

**Call relations**: `imp::query_osc_default_colors` uses this to send the OSC color request before waiting for a reply.

*Call graph*: 4 external calls (from, last_os_error, null_mut, WriteFile).


##### `imp::read_until`  (lines 713–739)

```
fn read_until(
        handle: HANDLE,
        timeout: Duration,
        mut parse: impl FnMut(&[u8]) -> Option<T>,
    ) -> io::Result<Option<T>>
```

**Purpose**: Reads from a Windows input handle until a parser recognizes the wanted terminal reply or the timeout expires. It is the bounded wait loop for Windows probe responses.

**Data flow**: It receives a handle, a timeout, and a parser function. It keeps a growing byte buffer, checks the parser, waits for input readiness up to the remaining deadline, reads one chunk when ready, and returns the parsed value or `None` on timeout.

**Call relations**: `imp::query_osc_default_colors` calls this after writing the color query. It hands individual reads to `imp::read_once` and hands accumulated bytes to the supplied parser.

*Call graph*: 7 external calls (now, new, last_os_error, poll_readable, read_available, read_once, WaitForSingleObject).


##### `imp::read_once`  (lines 741–758)

```
fn read_once(handle: HANDLE, buffer: &mut Vec<u8>) -> io::Result<()>
```

**Purpose**: Reads one chunk of bytes from a Windows handle and appends it to a buffer. It is a small wrapper around the Windows `ReadFile` call.

**Data flow**: It receives an input handle and a mutable byte buffer. It reads up to 256 bytes from the handle and appends the bytes actually read. It returns success or the last Windows error.

**Call relations**: `imp::read_until` calls this whenever the handle is signaled as readable.

*Call graph*: 3 external calls (last_os_error, null_mut, ReadFile).


##### `imp::tests::color_table`  (lines 766–772)

```
fn color_table() -> [u32; 16]
```

**Purpose**: Provides a fixed Windows console color table for tests. This keeps the expected color-decoding examples easy to read and repeat.

**Data flow**: It takes no input and returns an array of 16 color values. The values mimic the standard console color slots used by the decoding tests.

**Call relations**: Windows color-decoding tests call this helper when they need a known palette.


##### `imp::tests::decodes_console_color_attribute_indices`  (lines 775–783)

```
fn decodes_console_color_attribute_indices()
```

**Purpose**: Checks that basic Windows foreground and background color indexes are decoded from console attributes correctly.

**Data flow**: The test feeds a sample attribute value and the test color table into the decoder, then compares the result with the expected foreground and background RGB colors.

**Call relations**: The test runner calls this to protect `imp::decode_console_default_colors` from regressions in attribute-index handling.

*Call graph*: 1 external calls (assert_eq!).


##### `imp::tests::decodes_console_color_intensity_indices`  (lines 786–794)

```
fn decodes_console_color_intensity_indices()
```

**Purpose**: Checks that brighter Windows console color indexes are decoded correctly. These use the high-intensity slots in the 16-color table.

**Data flow**: The test passes a sample attribute value into the console color decoder and compares the decoded RGB pair with expected bright colors.

**Call relations**: The test runner calls this as another guard for `imp::decode_console_default_colors`.

*Call graph*: 1 external calls (assert_eq!).


##### `imp::tests::decodes_console_color_ref_byte_order`  (lines 797–809)

```
fn decodes_console_color_ref_byte_order()
```

**Purpose**: Checks the byte order used when decoding Windows color table entries. This prevents accidentally swapping red, green, and blue.

**Data flow**: The test modifies two entries in the fixed color table, decodes an attribute that points at them, and compares the result with the expected RGB tuples.

**Call relations**: The test runner calls this to cover the `imp::decode_color_ref` behavior through the public decoder path.

*Call graph*: 2 external calls (assert_eq!, color_table).


##### `imp::tests::ignores_reverse_video_when_decoding_default_colors`  (lines 812–823)

```
fn ignores_reverse_video_when_decoding_default_colors()
```

**Purpose**: Checks that the Windows reverse-video attribute does not swap the reported default colors. The probe wants configured palette defaults, not the temporary way a cell may render.

**Data flow**: The test combines a reverse-video bit with normal color attributes, decodes them, and compares the result with the non-reversed expected colors.

**Call relations**: The test runner calls this to preserve the design choice documented in `imp::decode_console_default_colors`.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_osc_color`  (lines 827–835)

```
fn parse_osc_color(buffer: &[u8], slot: u8) -> Option<(u8, u8, u8)>
```

**Purpose**: Extracts one OSC color reply from raw terminal bytes. OSC means “Operating System Command,” a family of escape sequences terminals use for settings such as palette colors.

**Data flow**: It receives a byte buffer and a color slot number, such as 10 for foreground or 11 for background. It finds the matching OSC prefix, locates the reply terminator, converts the payload to text, parses the RGB value, and returns the color tuple if valid.

**Call relations**: `parse_default_colors` calls this once for foreground and once for background. It uses helpers to find the prefix, find the end of the OSC payload, and decode the RGB text.

*Call graph*: calls 3 internal fn (find_subslice, osc_payload_end, parse_osc_rgb); called by 1 (parse_default_colors); 2 external calls (format!, from_utf8).


##### `parse_default_colors`  (lines 837–841)

```
fn parse_default_colors(buffer: &[u8]) -> Option<DefaultColors>
```

**Purpose**: Parses both default foreground and background colors from terminal response bytes. It only succeeds when both colors are present, because palette calculations need the pair.

**Data flow**: It receives a byte buffer that may contain unrelated bytes. It asks `parse_osc_color` for slot 10 and slot 11. If both parse successfully, it returns a `DefaultColors`; otherwise it returns `None`.

**Call relations**: Startup probing and color probing use this as the shared parser for OSC color replies on Unix and Windows.

*Call graph*: calls 1 internal fn (parse_osc_color); called by 1 (update_startup_probe).


##### `osc_payload_end`  (lines 843–853)

```
fn osc_payload_end(buffer: &[u8]) -> Option<(usize, usize)>
```

**Purpose**: Finds where an OSC reply payload ends. Terminals can end OSC replies with either a bell byte or an escape-backslash sequence.

**Data flow**: It receives the bytes after an OSC prefix. It scans forward until it sees one of the valid terminators. It returns the payload length and terminator length, or `None` if the reply is incomplete.

**Call relations**: `parse_osc_color` uses this before converting the payload bytes to text. This helps reject partial replies that have not finished arriving.

*Call graph*: called by 1 (parse_osc_color).


##### `parse_osc_rgb`  (lines 855–869)

```
fn parse_osc_rgb(payload: &str) -> Option<(u8, u8, u8)>
```

**Purpose**: Parses the text form of an OSC RGB or RGBA color. It accepts both three-channel `rgb` and four-channel `rgba`, ignoring the alpha channel after validating it.

**Data flow**: It receives a payload string such as an RGB value split by slashes. It checks the prefix, parses red, green, and blue components, optionally parses alpha, and rejects extra or malformed parts. It returns an 8-bit RGB tuple.

**Call relations**: `parse_osc_color` calls this after extracting a complete OSC payload. It delegates individual number conversion to `parse_osc_component`.

*Call graph*: calls 1 internal fn (parse_osc_component); called by 1 (parse_osc_color).


##### `parse_osc_component`  (lines 871–879)

```
fn parse_osc_component(component: &str) -> Option<u8>
```

**Purpose**: Converts one OSC color component into an 8-bit value. Terminals may send either two hex digits or four hex digits per color channel.

**Data flow**: It receives one component string. If it has two hex digits, it parses directly as 0 to 255; if it has four, it scales the 16-bit value down to 8 bits. Other lengths or invalid hex text return `None`.

**Call relations**: `parse_osc_rgb` calls this for red, green, blue, and optional alpha components.

*Call graph*: called by 1 (parse_osc_rgb); 2 external calls (from_str_radix, from_str_radix).


##### `find_subslice`  (lines 881–885)

```
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize>
```

**Purpose**: Finds the first place where a byte pattern appears inside a larger byte buffer. It is a simple search helper for OSC parsing.

**Data flow**: It receives a haystack buffer and a needle pattern. It scans windows of the haystack until one equals the needle, then returns that starting index. If no match exists, it returns `None`.

**Call relations**: `parse_osc_color` uses this to find the requested OSC color slot inside a buffer that may contain unrelated input.

*Call graph*: called by 1 (parse_osc_color).


##### `tests::parses_osc_colors_with_bel_and_st`  (lines 896–905)

```
fn parses_osc_colors_with_bel_and_st()
```

**Purpose**: Checks that single OSC color replies are parsed with both supported terminator styles. The two styles are bell and string terminator.

**Data flow**: The test feeds sample foreground and background OSC replies into `parse_osc_color` and compares the parsed RGB tuples with expected values.

**Call relations**: The test runner calls this to protect the common OSC parser used by both Unix and Windows probing.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_two_and_four_digit_color_components`  (lines 908–914)

```
fn parses_two_and_four_digit_color_components()
```

**Purpose**: Checks that OSC color text works with both two-digit and four-digit hex components. This covers the common formats terminals may use.

**Data flow**: The test passes sample RGB and RGBA payload strings into `parse_osc_rgb` and compares the returned RGB values with expected 8-bit colors.

**Call relations**: The test runner calls this to guard `parse_osc_rgb` and `parse_osc_component`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_default_colors_from_one_buffer`  (lines 917–936)

```
fn parses_default_colors_from_one_buffer()
```

**Purpose**: Checks that foreground and background default colors can be parsed from the same buffer in either order. It also checks that one color alone is not enough.

**Data flow**: The test feeds combined OSC response buffers into `parse_default_colors` and compares the results with expected `DefaultColors` values or `None`.

**Call relations**: The test runner calls this to protect the shared default-color parser used by startup and color probes.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::ignores_malformed_or_partial_default_color_responses`  (lines 939–952)

```
fn ignores_malformed_or_partial_default_color_responses()
```

**Purpose**: Checks that bad or incomplete OSC color replies are rejected. This prevents the UI from trusting broken terminal data.

**Data flow**: The test sends malformed, overlong, and unterminated response buffers into `parse_default_colors` and expects `None` each time.

**Call relations**: The test runner calls this to ensure `parse_default_colors` fails safely when terminal replies are not usable.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_default_colors_with_unrelated_bytes`  (lines 955–965)

```
fn parses_default_colors_with_unrelated_bytes()
```

**Purpose**: Checks that the default-color parser can find valid replies even when other input bytes are mixed in. Real terminal input can contain user keystrokes or other reports around probe replies.

**Data flow**: The test passes a buffer containing noise plus valid foreground and background OSC replies into `parse_default_colors`. It expects the correct `DefaultColors` value.

**Call relations**: The test runner calls this to validate the parser behavior needed by short probe windows, where unrelated bytes may already be buffered.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/tui/keyboard_modes.rs`

`io_transport` · `TUI startup and teardown`

A terminal program does not receive keys directly like a desktop app does. Instead, the terminal sends short text codes that mean “Escape was pressed”, “Ctrl+Enter was pressed”, and so on. This file asks compatible terminals to send richer key information while the TUI owns the screen, so the app can understand more key combinations reliably.

The file is careful because changing terminal keyboard reporting is like changing the language spoken between the keyboard and the app. If the app exits without switching it back, the parent shell may receive unfamiliar key codes. To prevent that, this file has both a normal restore step and a stronger reset step for process exit.

It first decides whether enhanced reporting should be disabled. A user can force this with the CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT environment variable. If there is no explicit setting, it automatically disables the feature for VS Code terminals running through WSL, because that combination can hide or mishandle terminal details.

When enabled, it uses crossterm and raw ANSI escape sequences, which are special text commands understood by terminals. It also has extra tmux support: tmux is a terminal multiplexer, like a terminal inside a terminal, and this file only enables its special modified-key mode when tmux confirms it uses the key format crossterm can understand.

#### Function details

##### `keyboard_enhancement_disabled`  (lines 18–23)

```
fn keyboard_enhancement_disabled() -> bool
```

**Purpose**: Decides whether the TUI should avoid enhanced keyboard reporting in the current environment. This protects users from broken key input in terminals that do not behave well with these modes.

**Data flow**: It reads the CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT environment variable, checks whether the app is running in WSL, and checks whether the terminal appears to be VS Code. It sends those facts to keyboard_enhancement_disabled_for and returns the final yes-or-no answer.

**Call relations**: The startup path asks this before setting terminal modes, and enable_keyboard_enhancement asks it again before sending terminal commands. It gathers real environment facts, then hands the decision to keyboard_enhancement_disabled_for.

*Call graph*: calls 3 internal fn (keyboard_enhancement_disabled_for, running_in_vscode_terminal, running_in_wsl); called by 2 (init, enable_keyboard_enhancement); 1 external calls (var).


##### `keyboard_enhancement_disabled_for`  (lines 25–38)

```
fn keyboard_enhancement_disabled_for(
    disable_env: Option<&str>,
    is_wsl: bool,
    is_vscode_terminal: bool,
) -> bool
```

**Purpose**: Applies the actual rule for disabling enhanced keyboard reporting. A user setting wins first; otherwise, the VS Code-on-WSL safety rule is used.

**Data flow**: It receives an optional environment-variable string plus two booleans saying whether this is WSL and whether this is VS Code. It tries to parse the string as a yes/no value. If that works, it returns that value; if not, it returns true only when both WSL and VS Code are detected.

**Call relations**: keyboard_enhancement_disabled calls this after collecting environment facts. This function keeps the decision logic easy to test without needing to fake the real machine environment.

*Call graph*: calls 1 internal fn (parse_bool_env); called by 1 (keyboard_enhancement_disabled).


##### `parse_bool_env`  (lines 40–50)

```
fn parse_bool_env(value: Option<&str>) -> Option<bool>
```

**Purpose**: Turns common environment-variable spellings into a true or false value. This lets users write values like 1, true, yes, 0, false, or no.

**Data flow**: It receives an optional string, trims whitespace, compares it case-insensitively where appropriate, and returns Some(true), Some(false), or None when the value is missing or not recognized.

**Call relations**: keyboard_enhancement_disabled_for uses this to understand the override environment variable before falling back to automatic terminal detection.

*Call graph*: called by 1 (keyboard_enhancement_disabled_for).


##### `running_in_wsl`  (lines 52–62)

```
fn running_in_wsl() -> bool
```

**Purpose**: Checks whether the program is probably running under WSL, which means Linux running inside Windows. This matters because some Windows terminal information may be hidden from the Linux process.

**Data flow**: On Linux builds, it asks the clipboard_paste module's WSL detector. On non-Linux builds, it simply returns false.

**Call relations**: keyboard_enhancement_disabled calls this as one input to the safety decision for VS Code inside WSL.

*Call graph*: calls 1 internal fn (is_probably_wsl); called by 1 (keyboard_enhancement_disabled).


##### `running_in_vscode_terminal`  (lines 64–69)

```
fn running_in_vscode_terminal() -> bool
```

**Purpose**: Checks whether the current terminal appears to be VS Code's integrated terminal. It looks from both the Linux side and, when possible, the Windows side.

**Data flow**: It reads TERM_PROGRAM from the current process environment, gets any Windows-side TERM_PROGRAM value, and passes both values to vscode_terminal_detected. The result is a yes-or-no answer.

**Call relations**: keyboard_enhancement_disabled uses this when deciding whether to automatically disable enhanced keyboard reporting. It delegates the string comparison to vscode_terminal_detected.

*Call graph*: calls 2 internal fn (vscode_terminal_detected, windows_term_program); called by 2 (keyboard_enhancement_disabled, running_in_vscode_terminal); 1 external calls (var).


##### `vscode_terminal_detected`  (lines 71–76)

```
fn vscode_terminal_detected(
    linux_term_program: Option<&str>,
    windows_term_program: Option<&str>,
) -> bool
```

**Purpose**: Combines two possible TERM_PROGRAM values into one answer about VS Code. It treats either the local Linux value or the Windows-side value as enough evidence.

**Data flow**: It receives two optional strings. It checks each with term_program_is_vscode and returns true if either one says the value is VS Code.

**Call relations**: running_in_vscode_terminal calls this after gathering the possible terminal names. This split makes the detection rule simple to test.

*Call graph*: calls 1 internal fn (term_program_is_vscode); called by 1 (running_in_vscode_terminal).


##### `term_program_is_vscode`  (lines 78–80)

```
fn term_program_is_vscode(value: Option<&str>) -> bool
```

**Purpose**: Checks one TERM_PROGRAM value to see if it names VS Code. The comparison ignores letter case.

**Data flow**: It receives an optional string. If a value is present and equals vscode in any casing, it returns true; otherwise it returns false.

**Call relations**: vscode_terminal_detected uses this small helper for both the Linux-side and Windows-side terminal values.

*Call graph*: called by 1 (vscode_terminal_detected).


##### `windows_term_program`  (lines 82–96)

```
fn windows_term_program() -> Option<String>
```

**Purpose**: Gets the Windows-side TERM_PROGRAM value when running on Linux, mainly for WSL cases. It caches the answer so the external check is not repeated.

**Data flow**: On Linux, it initializes a once-only cached value by calling read_windows_term_program and then returns a clone of that cached option. On non-Linux systems, it returns None.

**Call relations**: running_in_vscode_terminal calls this because VS Code in WSL may not expose TERM_PROGRAM inside the Linux environment.

*Call graph*: called by 1 (running_in_vscode_terminal); 1 external calls (new).


##### `read_windows_term_program`  (lines 99–119)

```
fn read_windows_term_program() -> Option<String>
```

**Purpose**: Asks Windows what TERM_PROGRAM is set to, from inside a Linux process. This is a WSL-specific fallback for detecting VS Code.

**Data flow**: It runs cmd.exe with a command that prints TERM_PROGRAM, ignores stdin and stderr, and reads stdout. If the command succeeds, it looks for a line starting with TERM_PROGRAM=, strips that prefix and any carriage return, and returns a non-empty value.

**Call relations**: windows_term_program uses this as the expensive, platform-specific probe and then caches its result.

*Call graph*: 3 external calls (from_utf8_lossy, new, null).


##### `enable_keyboard_enhancement`  (lines 121–139)

```
fn enable_keyboard_enhancement()
```

**Purpose**: Turns on richer keyboard reporting for the TUI, unless the environment says not to. This lets the app understand more key combinations while it owns the terminal.

**Data flow**: It first asks keyboard_enhancement_disabled whether to skip. If not skipped, it writes terminal commands to stdout: reset one older key mode, then push crossterm keyboard enhancement flags. If tmux should get a special mode, it writes that extra command too. It ignores write errors.

**Call relations**: set_modes calls this during terminal setup. It calls tmux_should_enable_modify_other_keys only after the main enhancement request, because tmux needs extra care for modified keys.

*Call graph*: calls 2 internal fn (keyboard_enhancement_disabled, tmux_should_enable_modify_other_keys); called by 1 (set_modes); 1 external calls (execute!).


##### `running_in_tmux_session`  (lines 141–146)

```
fn running_in_tmux_session() -> bool
```

**Purpose**: Checks whether the TUI is running inside tmux, a tool that lets one terminal contain many terminal sessions. tmux can affect how key codes are translated.

**Data flow**: It reads the TMUX and TMUX_PANE environment variables and passes their optional values to tmux_session_detected. The result says whether either marker is present.

**Call relations**: tmux_should_enable_modify_other_keys calls this before deciding whether to ask tmux for special key reporting.

*Call graph*: calls 1 internal fn (tmux_session_detected); called by 1 (tmux_should_enable_modify_other_keys); 1 external calls (var).


##### `tmux_session_detected`  (lines 148–150)

```
fn tmux_session_detected(tmux: Option<&str>, tmux_pane: Option<&str>) -> bool
```

**Purpose**: Decides whether tmux is present based on common tmux environment markers. Either marker is enough.

**Data flow**: It receives optional TMUX and TMUX_PANE values. If either exists, it returns true; if both are missing, it returns false.

**Call relations**: running_in_tmux_session uses this so the environment-reading part is separate from the easily tested detection rule.

*Call graph*: called by 1 (running_in_tmux_session).


##### `tmux_should_enable_modify_other_keys`  (lines 152–157)

```
fn tmux_should_enable_modify_other_keys() -> bool
```

**Purpose**: Decides whether to turn on tmux's modified-key reporting mode. It only does this when tmux is present and tmux says it uses a compatible key format.

**Data flow**: It checks whether the process is in tmux, reads tmux's extended key format, and passes both facts to tmux_should_enable_modify_other_keys_for. It returns that helper's yes-or-no decision.

**Call relations**: enable_keyboard_enhancement calls this before sending the extra EnableModifyOtherKeys command. It protects crossterm from key formats it may not parse consistently.

*Call graph*: calls 3 internal fn (read_tmux_extended_keys_format, running_in_tmux_session, tmux_should_enable_modify_other_keys_for); called by 1 (enable_keyboard_enhancement).


##### `tmux_should_enable_modify_other_keys_for`  (lines 159–167)

```
fn tmux_should_enable_modify_other_keys_for(
    running_in_tmux_session: bool,
    extended_keys_format: Option<&str>,
) -> bool
```

**Purpose**: Applies the safe rule for tmux modified-key mode. It only approves the mode when tmux is active and reports the csi-u format.

**Data flow**: It receives a boolean saying whether tmux is active and an optional extended-key-format string. It returns true only when tmux is active and the format is exactly csi-u.

**Call relations**: tmux_should_enable_modify_other_keys uses this after collecting facts from the environment and from tmux itself. Tests exercise this helper directly.

*Call graph*: called by 1 (tmux_should_enable_modify_other_keys); 1 external calls (matches!).


##### `read_tmux_extended_keys_format`  (lines 169–195)

```
fn read_tmux_extended_keys_format() -> Option<String>
```

**Purpose**: Asks tmux which extended key format it is configured to use. This prevents the app from enabling a mode that would produce key codes crossterm may misunderstand.

**Data flow**: It tries two tmux commands, each with stdin and stderr silenced. For the first successful command that prints non-empty UTF-8 text, it trims the value and returns it. If neither works, it returns None.

**Call relations**: tmux_should_enable_modify_other_keys calls this before asking the rule helper whether EnableModifyOtherKeys is safe.

*Call graph*: called by 1 (tmux_should_enable_modify_other_keys); 3 external calls (from_utf8, new, null).


##### `restore_keyboard_enhancement_stack`  (lines 197–203)

```
fn restore_keyboard_enhancement_stack()
```

**Purpose**: Restores the normal keyboard enhancement stack when the TUI is leaving terminal mode normally. This is the polite cleanup step.

**Data flow**: It writes commands to stdout that pop crossterm's keyboard enhancement flags and disable modifyOtherKeys. It ignores errors because cleanup should not crash the program.

**Call relations**: restore_common calls this during normal terminal restoration. It pairs with enable_keyboard_enhancement, like taking off a borrowed jacket before leaving.

*Call graph*: called by 1 (restore_common); 1 external calls (execute!).


##### `reset_keyboard_reporting_after_exit`  (lines 205–212)

```
fn reset_keyboard_reporting_after_exit()
```

**Purpose**: Performs a stronger keyboard-reporting reset after exit. This protects the parent shell if the normal stack cleanup did not fully restore the terminal.

**Data flow**: It writes commands to stdout that pop crossterm's flags, send a hard reset for keyboard enhancement flags, and disable modifyOtherKeys. It ignores errors.

**Call relations**: restore_common calls this as part of exit cleanup. It uses ResetKeyboardEnhancementFlags and DisableModifyOtherKeys to make sure the terminal is left in a plain state.

*Call graph*: called by 1 (restore_common); 1 external calls (execute!).


##### `ResetKeyboardEnhancementFlags::write_ansi`  (lines 218–220)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Writes the ANSI escape sequence that resets terminal keyboard enhancement flags. ANSI escape sequences are special text commands interpreted by terminals.

**Data flow**: It receives a formatter and writes the reset sequence into it. The output is text that a terminal can interpret as a keyboard-reporting reset.

**Call relations**: reset_keyboard_reporting_after_exit uses this command through crossterm's execute machinery when sending cleanup instructions to stdout.

*Call graph*: 1 external calls (write_str).


##### `ResetKeyboardEnhancementFlags::execute_winapi`  (lines 223–228)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: Reports that this reset command is not available through the old Windows console API. It avoids pretending the command can work through an unsupported path.

**Data flow**: It receives no useful input beyond the command itself and returns an unsupported I/O error explaining that the legacy Windows API implementation is missing.

**Call relations**: This exists because crossterm Command implementations need a Windows API path on Windows builds. The file expects ANSI-terminal support instead for this command.

*Call graph*: 1 external calls (new).


##### `ResetKeyboardEnhancementFlags::is_ansi_code_supported`  (lines 231–233)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Says that this command should not be treated as supported by the legacy Windows API path. This steers crossterm away from the wrong execution route.

**Data flow**: It takes the command value and returns false.

**Call relations**: Crossterm can consult this on Windows builds when deciding how to execute the command.


##### `EnableModifyOtherKeys::write_ansi`  (lines 240–242)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Writes the ANSI escape sequence that asks for modifyOtherKeys mode level 2. This mode helps terminals report modified keys, such as Ctrl or Alt combinations, more clearly.

**Data flow**: It receives a formatter and writes the enable sequence into it. The resulting text is meant to be sent to the terminal.

**Call relations**: enable_keyboard_enhancement sends this command only in tmux setups that have confirmed the compatible csi-u format.

*Call graph*: 1 external calls (write_str).


##### `EnableModifyOtherKeys::execute_winapi`  (lines 245–250)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: Reports that enabling modifyOtherKeys is not implemented through the old Windows console API. This prevents a silent, misleading success.

**Data flow**: It returns an unsupported I/O error with a clear message.

**Call relations**: Crossterm uses this method on Windows builds if it tries the legacy API route. The intended route here is ANSI escape output.

*Call graph*: 1 external calls (new).


##### `EnableModifyOtherKeys::is_ansi_code_supported`  (lines 253–255)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Says this command is not supported through the legacy Windows ANSI-code support check. It is a conservative answer for that platform path.

**Data flow**: It returns false.

**Call relations**: This is part of the crossterm Command contract for Windows builds.


##### `DisableModifyOtherKeys::write_ansi`  (lines 262–264)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Writes the ANSI escape sequence that turns modifyOtherKeys back off. This helps return the terminal to normal keyboard reporting.

**Data flow**: It receives a formatter and writes the disable sequence into it. The output is the terminal command used during setup and cleanup.

**Call relations**: enable_keyboard_enhancement sends this before pushing crossterm's enhanced flags, and both restore functions send it during cleanup.

*Call graph*: 1 external calls (write_str).


##### `DisableModifyOtherKeys::execute_winapi`  (lines 267–272)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: Reports that resetting modifyOtherKeys is not implemented through the old Windows console API. This keeps unsupported behavior explicit.

**Data flow**: It returns an unsupported I/O error with a message describing the missing Windows API implementation.

**Call relations**: Crossterm may call this on Windows builds through its Command interface. The normal behavior for this file is to emit ANSI text instead.

*Call graph*: 1 external calls (new).


##### `DisableModifyOtherKeys::is_ansi_code_supported`  (lines 275–277)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Says this command should not be considered supported by the legacy Windows API path. This avoids sending it through an unsuitable backend.

**Data flow**: It returns false.

**Call relations**: This completes the crossterm Command implementation for Windows builds.


##### `tests::ansi_for`  (lines 293–297)

```
fn ansi_for(command: impl Command) -> String
```

**Purpose**: Builds the exact ANSI text produced by a command so tests can compare it with the expected sequence. It is a small test helper.

**Data flow**: It receives a crossterm command, creates an empty string, asks the command to write its ANSI text into that string, and returns the string.

**Call relations**: The ANSI-sequence tests use this helper for ResetKeyboardEnhancementFlags, EnableModifyOtherKeys, and DisableModifyOtherKeys.

*Call graph*: 2 external calls (new, write_ansi).


##### `tests::keyboard_enhancement_env_flag_parses_common_values`  (lines 300–309)

```
fn keyboard_enhancement_env_flag_parses_common_values()
```

**Purpose**: Checks that the disable environment variable accepts common true and false spellings. This protects the user-facing override from accidental breakage.

**Data flow**: It feeds parse_bool_env several sample inputs and checks that each produces the expected true, false, or unknown result.

**Call relations**: This test covers the parsing helper used by keyboard_enhancement_disabled_for.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::keyboard_enhancement_auto_disables_for_vscode_in_wsl`  (lines 312–316)

```
fn keyboard_enhancement_auto_disables_for_vscode_in_wsl()
```

**Purpose**: Checks the automatic safety rule for VS Code inside WSL. In that setup, keyboard enhancement should be disabled when the user has not set an override.

**Data flow**: It calls keyboard_enhancement_disabled_for with no environment override, WSL set to true, and VS Code set to true. It expects the result to be true.

**Call relations**: This test directly exercises the decision helper used by keyboard_enhancement_disabled.

*Call graph*: 1 external calls (assert!).


##### `tests::keyboard_enhancement_auto_disable_requires_wsl_and_vscode`  (lines 319–326)

```
fn keyboard_enhancement_auto_disable_requires_wsl_and_vscode()
```

**Purpose**: Checks that the automatic disable rule is narrow. It should not disable enhancement for WSL alone or VS Code alone.

**Data flow**: It calls keyboard_enhancement_disabled_for with one condition true at a time and confirms the result is false in both cases.

**Call relations**: This protects the logic used by keyboard_enhancement_disabled from becoming too broad.

*Call graph*: 1 external calls (assert!).


##### `tests::keyboard_enhancement_env_flag_overrides_auto_detection`  (lines 329–340)

```
fn keyboard_enhancement_env_flag_overrides_auto_detection()
```

**Purpose**: Checks that the user's environment setting takes priority over automatic detection. This lets users opt in or out when the default guess is wrong.

**Data flow**: It passes explicit 0 and 1 values to keyboard_enhancement_disabled_for with different WSL and VS Code facts, then checks that the explicit value controls the result.

**Call relations**: This test covers the top-priority branch of the decision helper used during terminal setup.

*Call graph*: 1 external calls (assert!).


##### `tests::vscode_terminal_detection_uses_linux_and_windows_term_program`  (lines 343–359)

```
fn vscode_terminal_detection_uses_linux_and_windows_term_program()
```

**Purpose**: Checks that VS Code detection works from either the Linux-side or Windows-side TERM_PROGRAM value. This is important for WSL.

**Data flow**: It calls vscode_terminal_detected with different pairs of optional terminal names and checks which combinations count as VS Code.

**Call relations**: This test covers the helper used by running_in_vscode_terminal.

*Call graph*: 1 external calls (assert!).


##### `tests::tmux_session_detection_accepts_tmux_or_tmux_pane`  (lines 362–371)

```
fn tmux_session_detection_accepts_tmux_or_tmux_pane()
```

**Purpose**: Checks that either common tmux environment marker is enough to identify a tmux session. This keeps tmux detection flexible.

**Data flow**: It calls tmux_session_detected with TMUX only, TMUX_PANE only, and neither value, then checks the expected true or false result.

**Call relations**: This test covers the rule used by running_in_tmux_session before tmux-specific keyboard setup.

*Call graph*: 1 external calls (assert!).


##### `tests::tmux_modify_other_keys_only_requests_confirmed_csi_u_format`  (lines 374–394)

```
fn tmux_modify_other_keys_only_requests_confirmed_csi_u_format()
```

**Purpose**: Checks that tmux modifyOtherKeys is enabled only in the safe, confirmed case. This avoids sending key formats that crossterm may misread.

**Data flow**: It calls tmux_should_enable_modify_other_keys_for with combinations of tmux presence and extended key format values, then checks that only active tmux with csi-u returns true.

**Call relations**: This test protects the rule used by enable_keyboard_enhancement before sending EnableModifyOtherKeys.

*Call graph*: 1 external calls (assert!).


##### `tests::reset_keyboard_enhancement_flags_clears_all_pushed_levels`  (lines 397–399)

```
fn reset_keyboard_enhancement_flags_clears_all_pushed_levels()
```

**Purpose**: Checks the exact terminal command used for the stronger keyboard enhancement reset. Exact bytes matter for terminal control sequences.

**Data flow**: It converts ResetKeyboardEnhancementFlags to ANSI text with ansi_for and compares it to the expected escape sequence.

**Call relations**: This test covers the command used by reset_keyboard_reporting_after_exit.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::enable_modify_other_keys_requests_xterm_keyboard_reporting`  (lines 402–404)

```
fn enable_modify_other_keys_requests_xterm_keyboard_reporting()
```

**Purpose**: Checks the exact terminal command used to enable modifyOtherKeys mode. This ensures the app asks for the intended key-reporting level.

**Data flow**: It converts EnableModifyOtherKeys to ANSI text with ansi_for and compares it to the expected escape sequence.

**Call relations**: This test covers the command that enable_keyboard_enhancement may send for compatible tmux sessions.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::disable_modify_other_keys_resets_xterm_keyboard_reporting`  (lines 407–409)

```
fn disable_modify_other_keys_resets_xterm_keyboard_reporting()
```

**Purpose**: Checks the exact terminal command used to disable modifyOtherKeys mode. This cleanup sequence must stay correct so the shell is restored.

**Data flow**: It converts DisableModifyOtherKeys to ANSI text with ansi_for and compares it to the expected escape sequence.

**Call relations**: This test covers the command used during both setup preparation and terminal cleanup.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/tui/terminal_stderr.rs`

`io_transport` · `active during TUI terminal ownership, with pause/resume during temporary releases and cleanup at teardown`

The inline TUI draws into a specific part of the terminal. On macOS, some system frameworks and runtime diagnostics can write directly to file descriptor 2, better known as stderr. Those writes bypass the TUI renderer, so they are like someone drawing on a whiteboard while another person is carefully presenting slides. This file prevents that mess when stdout and stderr point at the same terminal.

The main object is `TerminalStderrGuard`. When installed on macOS, it checks whether stdout and stderr are both terminals and actually refer to the same terminal device. If so, it saves the real stderr file descriptor, redirects stderr to `/dev/null`, and records that suppression is active. On non-macOS systems, or when stderr is already redirected somewhere else, it does nothing.

The file also supports temporary release and return of terminal ownership. `pause` restores stderr so external work can report normally. `resume` suppresses it again when the TUI takes the terminal back. `finish`, and the guard’s `Drop` behavior, restore stderr permanently at the end. A global mutex, which is a lock that stops two tasks changing the same state at once, protects the saved descriptor and active flag.

#### Function details

##### `TerminalStderrGuard::install`  (lines 45–54)

```
fn install() -> io::Result<Self>
```

**Purpose**: Starts stderr protection for a TUI session if it is needed. On macOS it only suppresses stderr when stderr and stdout both point to the same terminal, because that is the case where stray stderr text would overwrite the TUI.

**Data flow**: It reads the current stdout and stderr destinations. If they are the same terminal on macOS, it asks the suppression installer to save and redirect stderr, then returns an active guard. Otherwise it returns an inactive guard that changes nothing.

**Call relations**: This is called by `init` when the TUI is being set up. The redirected-stderr test also calls it to prove that it leaves already redirected stderr alone. When suppression is required, it hands off to `TerminalStderrGuard::install_suppression`; otherwise it simply returns.

*Call graph*: calls 1 internal fn (stderr_targets_stdout_terminal); called by 2 (init, preserves_stderr_when_already_redirected); 1 external calls (install_suppression).


##### `TerminalStderrGuard::install_suppression`  (lines 57–68)

```
fn install_suppression() -> io::Result<Self>
```

**Purpose**: Forces stderr suppression on macOS by saving the current stderr and redirecting future stderr writes away from the terminal. It is the lower-level setup step used when suppression is definitely wanted.

**Data flow**: It locks the shared stderr state, checks that another owner is not already active, saves the current stderr through `suppress_locked`, marks ownership as active, and returns a guard whose `active` flag is true. If suppression is already active, it returns an error instead of stacking another owner.

**Call relations**: It is the workhorse behind installation and is exercised directly by the suppression test. It uses `lock_state` to get exclusive access and `suppress_locked` to do the file-descriptor redirection.

*Call graph*: calls 2 internal fn (lock_state, suppress_locked); called by 1 (suppresses_stderr_only_while_terminal_is_owned); 1 external calls (new).


##### `TerminalStderrGuard::drop`  (lines 72–77)

```
fn drop(&mut self)
```

**Purpose**: Cleans up automatically when the guard object goes away. This makes stderr restoration hard to forget, even if the caller exits the TUI path by returning early.

**Data flow**: It checks the guard’s `active` flag. If the guard had actually suppressed stderr, it calls `finish` to restore stderr and then marks itself inactive so cleanup is not repeated.

**Call relations**: Rust calls this automatically when `TerminalStderrGuard` is dropped. It delegates cleanup to `finish`, the same permanent restore path used by explicit shutdown code.

*Call graph*: calls 1 internal fn (finish).


##### `pause`  (lines 81–91)

```
fn pause() -> io::Result<()>
```

**Purpose**: Temporarily restores stderr while the TUI has released the terminal. This lets other code print errors normally during a suspension or an operation that should own the terminal for a while.

**Data flow**: On macOS it locks the shared state. If a TUI owner is active, it restores the saved stderr descriptor; if no owner is active, it does nothing. It returns success or any operating-system error from restoring stderr.

**Call relations**: `with_restored` and `suspend_process` call this when terminal control is handed away from the TUI, and the test calls it to verify visible output during the pause. It uses `lock_state` for safe shared access and `restore_locked` for the actual restoration.

*Call graph*: calls 2 internal fn (lock_state, restore_locked); called by 3 (with_restored, suspend_process, suppresses_stderr_only_while_terminal_is_owned).


##### `resume`  (lines 94–104)

```
fn resume() -> io::Result<()>
```

**Purpose**: Turns stderr suppression back on after a temporary pause. This protects the TUI again when it retakes ownership of the terminal.

**Data flow**: On macOS it locks the shared state. If the TUI owner is still active, it redirects stderr back to `/dev/null` through `suppress_locked`; otherwise it does nothing. It returns success or an error if the redirect fails.

**Call relations**: `with_restored` and `suspend_process` call this after their temporary restored-stderr section ends. The suppression test also calls it to confirm output becomes hidden again. It relies on `lock_state` and `suppress_locked`.

*Call graph*: calls 2 internal fn (lock_state, suppress_locked); called by 3 (with_restored, suspend_process, suppresses_stderr_only_while_terminal_is_owned).


##### `finish`  (lines 107–118)

```
fn finish() -> io::Result<()>
```

**Purpose**: Permanently restores stderr when the TUI session ends. It is the final cleanup step for this stderr protection feature.

**Data flow**: On macOS it locks the shared state. If an owner is active, it restores stderr from the saved descriptor, clears the active flag, and returns success. If nothing is active, it leaves everything unchanged.

**Call relations**: `restore_after_exit` calls this during shutdown, `TerminalStderrGuard::drop` calls it as automatic cleanup, and the suppression test calls it directly. It uses `lock_state` and `restore_locked` to make the restoration safe.

*Call graph*: calls 2 internal fn (lock_state, restore_locked); called by 3 (restore_after_exit, drop, suppresses_stderr_only_while_terminal_is_owned).


##### `lock_state`  (lines 121–125)

```
fn lock_state() -> io::Result<MutexGuard<'static, StderrState>>
```

**Purpose**: Gets exclusive access to the shared stderr suppression state. The lock prevents two parts of the program from saving, restoring, or redirecting stderr at the same time.

**Data flow**: It tries to lock the global mutex that holds whether a TUI owner is active and any saved stderr descriptor. If the lock succeeds, it returns access to that state; if the lock is poisoned because another thread panicked while holding it, it returns an I/O error.

**Call relations**: `install_suppression`, `pause`, `resume`, and `finish` all call this before touching the shared stderr state. It is the gatekeeper that makes those operations orderly.

*Call graph*: called by 4 (install_suppression, finish, pause, resume).


##### `stderr_targets_stdout_terminal`  (lines 128–146)

```
fn stderr_targets_stdout_terminal() -> bool
```

**Purpose**: Checks whether stdout and stderr both point to the same terminal. Suppression is only needed in that case, because stderr text would appear in the same place the TUI is drawing.

**Data flow**: It first asks whether stdout and stderr are terminals. If either is not, it returns false. If both are terminals, it asks the operating system for each stream’s device and inode identifiers and returns true only when those identifiers match.

**Call relations**: `TerminalStderrGuard::install` calls this during startup to decide whether suppression is appropriate. It uses low-level system calls such as `fstat` because it needs to compare the actual terminal objects, not just assume they are the same.

*Call graph*: called by 1 (install); 4 external calls (uninit, stderr, stdout, fstat).


##### `suppress_locked`  (lines 149–168)

```
fn suppress_locked(state: &mut StderrState) -> io::Result<()>
```

**Purpose**: Redirects stderr to `/dev/null` while remembering where stderr originally pointed. `/dev/null` is the operating system’s discard sink, like a trash can for output.

**Data flow**: It receives already-locked shared state. If stderr is already saved, it does nothing. Otherwise it duplicates the current stderr descriptor, opens `/dev/null` for writing, replaces file descriptor 2 with `/dev/null`, stores the duplicate in the state, and returns success or an operating-system error.

**Call relations**: `TerminalStderrGuard::install_suppression` calls this when suppression first starts, and `resume` calls it after a temporary pause. The caller must already hold the state lock, which is why this function works on the locked state directly.

*Call graph*: called by 2 (install_suppression, resume); 5 external calls (new, from_raw_fd, last_os_error, dup, dup2).


##### `restore_locked`  (lines 171–182)

```
fn restore_locked(state: &mut StderrState) -> io::Result<()>
```

**Purpose**: Restores stderr from the saved copy. This brings normal error output back after suppression was active.

**Data flow**: It receives already-locked shared state. If there is no saved stderr, it does nothing. If there is a saved descriptor, it copies that descriptor back onto file descriptor 2, clears the saved copy from the state, and returns success or an operating-system error.

**Call relations**: `pause` calls this for temporary restoration, and `finish` calls it for permanent cleanup. Like `suppress_locked`, it assumes the caller already locked the shared state.

*Call graph*: called by 2 (finish, pause); 2 external calls (last_os_error, dup2).


##### `tests::CapturedStderr::start`  (lines 207–220)

```
fn start(file: &File) -> std::io::Result<Self>
```

**Purpose**: In tests, redirects stderr into a temporary file so the test can inspect exactly what was visible. It also saves the original stderr so it can be restored later.

**Data flow**: It receives a file to capture into. It duplicates the current stderr descriptor, points file descriptor 2 at the capture file, and returns a `CapturedStderr` helper holding the saved original descriptor. If any operating-system call fails, it returns an error.

**Call relations**: The macOS tests call this before writing to stderr. It sets up the test environment so later writes can be read back from the temporary file.

*Call graph*: 5 external calls (as_raw_fd, from_raw_fd, last_os_error, dup, dup2).


##### `tests::CapturedStderr::drop`  (lines 224–227)

```
fn drop(&mut self)
```

**Purpose**: Restores the original stderr when the test capture helper is dropped. This keeps one test’s stderr redirection from leaking into later work.

**Data flow**: It reads the saved original stderr descriptor stored in the helper and copies it back onto file descriptor 2. It ignores any error during this cleanup path.

**Call relations**: Rust calls this automatically when `CapturedStderr` leaves scope or is explicitly dropped in the tests. It undoes the setup done by `tests::CapturedStderr::start`.

*Call graph*: 2 external calls (as_raw_fd, dup2).


##### `tests::write_stderr`  (lines 230–234)

```
fn write_stderr(message: &str) -> std::io::Result<()>
```

**Purpose**: Writes a test message to stderr and flushes it immediately. Flushing matters because the tests need the message to reach the capture file before they read it.

**Data flow**: It receives a string message, locks stderr for writing, writes the message bytes, flushes the stream, and returns success or any write error.

**Call relations**: Both macOS tests use this to create controlled stderr output. The surrounding test setup determines whether that output is captured, discarded, or restored.

*Call graph*: 1 external calls (stderr).


##### `tests::suppresses_stderr_only_while_terminal_is_owned`  (lines 238–257)

```
fn suppresses_stderr_only_while_terminal_is_owned() -> std::io::Result<()>
```

**Purpose**: Verifies the main promise of the file: stderr is hidden while the TUI owns the terminal, visible during a pause, hidden after resume, and visible again after finish.

**Data flow**: It creates a temporary capture file, redirects stderr into it, starts suppression, writes messages across active, paused, resumed, and finished states, then reads the capture file. The expected result contains only the messages written while stderr was restored.

**Call relations**: This test drives `TerminalStderrGuard::install_suppression`, `pause`, `resume`, `finish`, and `tests::write_stderr` in sequence. It proves the state transitions cooperate correctly.

*Call graph*: calls 4 internal fn (install_suppression, finish, pause, resume); 5 external calls (new, assert_eq!, tempfile, start, write_stderr).


##### `tests::preserves_stderr_when_already_redirected`  (lines 261–274)

```
fn preserves_stderr_when_already_redirected() -> std::io::Result<()>
```

**Purpose**: Verifies that normal installation does not suppress stderr when stderr is already redirected away from the terminal. This protects users who intentionally send errors to a file or another stream.

**Data flow**: It creates a temporary capture file, redirects stderr into it, calls `TerminalStderrGuard::install`, writes a message, then reads the capture file. The expected result still contains the message, showing that installation left redirected stderr alone.

**Call relations**: This test calls `tests::CapturedStderr::start`, `TerminalStderrGuard::install`, and `tests::write_stderr`. It covers the decision path where `install` chooses not to suppress.

*Call graph*: calls 1 internal fn (install); 5 external calls (new, assert_eq!, tempfile, start, write_stderr).


### `tui/src/tui/job_control.rs`

`orchestration` · `main loop suspend/resume handling`

Terminal apps have to be careful when they are suspended by the shell. Ctrl+Z sends a signal called SIGTSTP, which means “stop this process for now so the shell can take over.” If a full-screen terminal interface does not clean up first, the user may return to a hidden cursor, raw keyboard mode, or the wrong screen buffer. This file is the safety choreography for that moment.

The main helper, SuspendContext, keeps two small pieces of shared state: what kind of resume is needed, and the last known cursor row. If the app is using the terminal’s alternate screen, like a temporary full-screen page, it leaves that screen before stopping. If it is drawing inline in the normal terminal scrollback, it records that the inline view must be realigned later. After the operating system resumes the process, the code restores terminal modes, asks the terminal where the cursor ended up, clears any leftover input, and prepares a follow-up action for the next draw.

PreparedResumeAction is that follow-up instruction. It either re-enters the alternate screen and clears it, or shifts the drawing area so the inline cursor stays in a sensible place. Without this file, suspending the TUI could leave the shell and app fighting over the terminal, much like two people trying to write on the same whiteboard at once.

#### Function details

##### `SuspendContext::new`  (lines 50–55)

```
fn new() -> Self
```

**Purpose**: Creates a fresh suspend/resume tracker for the TUI. It starts with no pending resume work and a remembered cursor row of zero.

**Data flow**: It takes no outside data. It builds shared storage for the pending resume instruction and the cached cursor row, then returns a SuspendContext that can be cloned and shared safely between the drawing code and event code.

**Call relations**: This is used when the TUI and its event stream are being set up. Later, the created context is passed into the parts of the system that notice Ctrl+Z and the parts that redraw after the program comes back.

*Call graph*: called by 2 (new, make_stream); 3 external calls (new, new, new).


##### `SuspendContext::suspend`  (lines 63–98)

```
fn suspend(&self, alt_screen_active: &Arc<AtomicBool>) -> Result<()>
```

**Purpose**: Performs the careful pause when the user suspends the TUI. It cleans up the terminal, records how to restore the display later, sends the process to the background, and then repairs the terminal state when the process returns.

**Data flow**: It receives a shared flag telling whether the alternate screen is currently active. If that flag is true, it leaves alternate scrolling and the alternate screen, then records that the alternate screen must be restored. If not, it records that the normal inline view must be realigned. It uses the saved cursor row to place and show the cursor, suspends the process, restores raw terminal behavior after resume, probes the terminal for the current cursor position, updates the cached row when possible, flushes stale input, and returns success or an I/O error.

**Call relations**: This is called when the event-mapping code sees the suspend key. It uses set_resume_action to remember what the next draw must do, calls suspend_process to actually yield to the shell, uses set_cursor_y if the terminal reports a new cursor location, and leaves prepare_resume_action with a clear instruction to consume later.

*Call graph*: calls 4 internal fn (cursor_position, set_cursor_y, set_resume_action, suspend_process); called by 1 (map_crossterm_event); 5 external calls (execute!, flush_terminal_input_buffer, reapply_raw_mode_after_resume, debug!, trace!).


##### `SuspendContext::prepare_resume_action`  (lines 104–126)

```
fn prepare_resume_action(
        &self,
        alt_saved_viewport: &mut Option<Rect>,
    ) -> Option<PreparedResumeAction>
```

**Purpose**: Turns the remembered resume intent into a concrete drawing instruction. Drawing code uses this so the first redraw after resume happens in the right place and screen mode.

**Data flow**: It receives the saved alternate-screen viewport, if one exists. It takes and clears the pending resume action. For inline drawing, it creates a tiny viewport marker at the remembered cursor row. For alternate-screen drawing, it updates the saved viewport’s row to the current cursor row and returns an instruction to restore the alternate screen. If there was no pending suspend, it returns nothing.

**Call relations**: This is called by the draw paths after the process has resumed. It relies on take_resume_action to avoid applying the same resume work twice, reads cursor_y for the latest row, and hands back a PreparedResumeAction that the drawing layer can apply during a safe redraw.

*Call graph*: calls 2 internal fn (cursor_y, take_resume_action); called by 2 (draw, draw_with_resize_reflow); 2 external calls (new, RealignViewport).


##### `SuspendContext::set_cursor_y`  (lines 132–134)

```
fn set_cursor_y(&self, value: u16)
```

**Purpose**: Stores the latest known cursor row for use during suspend and resume. The TUI updates this as it draws so the suspend code has a meaningful place to put the cursor.

**Data flow**: It receives a row number. It writes that number into shared atomic storage, replacing the previous remembered row. It returns nothing.

**Call relations**: Normal drawing keeps this value fresh, and suspend also uses it after probing the terminal on resume. Later, cursor_y and prepare_resume_action read the stored row to decide where the resumed view should line up.

*Call graph*: called by 1 (suspend).


##### `SuspendContext::cursor_y`  (lines 136–138)

```
fn cursor_y(&self) -> u16
```

**Purpose**: Reads the currently remembered cursor row. It is a small helper so resume preparation can use the latest stored cursor position.

**Data flow**: It takes no new data. It reads the shared cursor-row value and returns it as a number.

**Call relations**: prepare_resume_action calls this when building the post-resume drawing instruction. That keeps the draw code from needing to know how the cursor row is stored internally.

*Call graph*: called by 1 (prepare_resume_action).


##### `SuspendContext::set_resume_action`  (lines 141–146)

```
fn set_resume_action(&self, value: ResumeAction)
```

**Purpose**: Records what kind of repair should happen after the suspended process is brought back. This is the file’s “note to future drawing code.”

**Data flow**: It receives a ResumeAction, either to realign inline drawing or restore the alternate screen. It locks the shared pending-action slot, replaces its contents with the new action, and returns nothing.

**Call relations**: suspend calls this just before the process is stopped. prepare_resume_action later consumes the stored value, so the decision made at suspend time is applied at redraw time.

*Call graph*: called by 1 (suspend).


##### `SuspendContext::take_resume_action`  (lines 149–154)

```
fn take_resume_action(&self) -> Option<ResumeAction>
```

**Purpose**: Fetches the pending resume instruction and clears it at the same time. This prevents the same resume fix from being applied more than once.

**Data flow**: It takes no new data. It locks the shared pending-action slot, removes the stored action if there is one, and returns that action. Afterward the slot is empty.

**Call relations**: prepare_resume_action calls this at the start of resume preparation. If it returns nothing, the draw code knows there is no suspend-related repair to perform.

*Call graph*: called by 1 (prepare_resume_action).


##### `PreparedResumeAction::apply`  (lines 181–197)

```
fn apply(self, terminal: &mut Terminal) -> Result<()>
```

**Purpose**: Applies a prepared post-resume screen fix to the terminal. It either shifts the inline drawing area or re-enters and resets the full-screen alternate terminal view.

**Data flow**: It receives itself as the instruction to perform and a mutable terminal object to change. For an inline realign instruction, it sets the terminal viewport to the stored area. For an alternate-screen restore instruction, it enters the alternate screen, enables alternate scrolling, reads the terminal size, resets the viewport to fill the screen, clears the display, and returns success or an I/O error.

**Call relations**: prepare_resume_action creates these instructions after a suspend. The draw side applies them during a controlled redraw so terminal changes happen in one clean place rather than in the middle of event handling.

*Call graph*: calls 3 internal fn (clear, set_viewport_area, size); 2 external calls (new, execute!).


##### `suspend_process`  (lines 201–211)

```
fn suspend_process() -> Result<()>
```

**Purpose**: Does the low-level work of actually suspending the process and then restoring terminal modes after it resumes. It is the bridge between the TUI cleanup code and the operating system’s job-control signal.

**Data flow**: It takes no inputs. Before stopping, it restores the terminal to a normal state and pauses special stderr terminal handling. It sends SIGTSTP to the current process group, which lets the shell take over. When the process is continued later, it resumes stderr handling, reapplies the TUI terminal modes, and returns success or an I/O error.

**Call relations**: SuspendContext::suspend calls this after it has recorded the needed resume action and made the cursor visible. Once this helper returns, suspend continues with higher-level cleanup such as reapplying raw mode, probing the cursor position, and flushing stale input.

*Call graph*: calls 2 internal fn (pause, resume); called by 1 (suspend); 3 external calls (kill, restore, set_modes).


### `tui/src/notifications/mod.rs`

`orchestration` · `cross-cutting`

Terminal apps cannot assume every user’s terminal supports the same notification features. Some modern terminals understand OSC 9, a special escape sequence that can ask the terminal to show a desktop notification. Others do not, but almost all terminals can at least receive BEL, the old terminal “bell” signal. This file is the small decision point that chooses between those two approaches.

The main type is `DesktopNotificationBackend`, which is like a plug adapter: the rest of the app can say “notify the user” without caring whether that means OSC 9 or BEL underneath. When the configuration says `Auto`, the file checks the detected terminal name and uses OSC 9 only for terminals known to support it, such as Ghostty, iTerm2, Kitty, Warp, and WezTerm. Otherwise it falls back to BEL. If the user explicitly asks for OSC 9 or BEL, that choice is honored directly.

Once a backend is selected, `notify` simply forwards the message to the chosen implementation. The tests make sure explicit choices work and that the auto-detection list accepts and rejects the intended terminal names.

#### Function details

##### `DesktopNotificationBackend::for_method`  (lines 20–32)

```
fn for_method(method: NotificationMethod) -> Self
```

**Purpose**: Chooses the concrete notification backend to use for a requested notification method. It is used when the app needs to turn a user setting such as “auto”, “OSC 9”, or “bell” into something that can actually send notifications.

**Data flow**: It receives a `NotificationMethod` setting. If the setting is `Auto`, it reads the current terminal information, checks whether that terminal is known to support OSC 9, and then builds either an OSC 9 backend or a BEL backend. If the setting is explicit, it directly builds the requested backend. The result is a `DesktopNotificationBackend` value ready to be used.

**Call relations**: This is the main chooser behind notification setup. `detect_backend` calls it as the public entry point. During the auto path, it asks `terminal_info` what terminal is running, asks `supports_osc9` whether that terminal is on the supported list, and creates the matching backend.

*Call graph*: calls 2 internal fn (new, supports_osc9); called by 1 (detect_backend); 3 external calls (Bel, Osc9, terminal_info).


##### `DesktopNotificationBackend::method`  (lines 34–39)

```
fn method(&self) -> NotificationMethod
```

**Purpose**: Reports which notification method the selected backend represents. This lets other code ask, “what did we end up using?” without inspecting the backend’s internals.

**Data flow**: It reads the current `DesktopNotificationBackend` variant. If the backend is OSC 9, it returns `NotificationMethod::Osc9`; if it is BEL, it returns `NotificationMethod::Bel`. It does not change anything.

**Call relations**: This function sits beside the selection and notification functions as a simple status check. After a backend has been chosen, other code can call it to display or store the effective notification method.


##### `DesktopNotificationBackend::notify`  (lines 41–46)

```
fn notify(&mut self, message: &str) -> io::Result<()>
```

**Purpose**: Sends a notification message using whichever backend was selected earlier. The caller does not need to know whether the message becomes an OSC 9 notification or a terminal bell.

**Data flow**: It receives a mutable backend and a text message. It checks which kind of backend is stored, then passes the message to that backend’s own `notify` function. It returns success or an input/output error if writing the notification signal fails.

**Call relations**: This is the common doorway used after setup. Code that wants to alert the user calls this function, and it delegates to either the OSC 9 implementation or the BEL implementation.


##### `detect_backend`  (lines 49–51)

```
fn detect_backend(method: NotificationMethod) -> DesktopNotificationBackend
```

**Purpose**: Provides a simple public wrapper for choosing a notification backend from a configured method. It keeps callers from needing to know the enum’s constructor details.

**Data flow**: It receives a `NotificationMethod`, passes it to `DesktopNotificationBackend::for_method`, and returns the selected backend. It does not do extra work of its own.

**Call relations**: This is the function other parts of the app call when creating or updating notification settings. It hands the real choice off to `DesktopNotificationBackend::for_method`.

*Call graph*: calls 1 internal fn (for_method); called by 2 (new, set_notification_settings).


##### `supports_osc9`  (lines 53–62)

```
fn supports_osc9(terminal: &TerminalInfo) -> bool
```

**Purpose**: Answers whether a detected terminal is known to support OSC 9 notifications. This is the safety check that prevents the app from sending richer notification codes to terminals that probably will not understand them.

**Data flow**: It receives `TerminalInfo`, looks at the terminal name inside it, and compares that name with a fixed supported list. It returns `true` for known OSC 9-friendly terminals and `false` for the rest.

**Call relations**: This function is used by `DesktopNotificationBackend::for_method` only when the user chose automatic detection. The tests also call it with sample terminal names to protect the supported and unsupported lists from accidental changes.

*Call graph*: called by 1 (for_method); 1 external calls (matches!).


##### `tests::test_terminal`  (lines 73–81)

```
fn test_terminal(name: TerminalName) -> TerminalInfo
```

**Purpose**: Builds a minimal fake terminal description for tests. It lets each test focus on the terminal name without filling in unrelated details.

**Data flow**: It receives a `TerminalName` and creates a `TerminalInfo` value with that name. All other fields are set to `None`, because these tests only care about the name.

**Call relations**: The OSC 9 support tests use this helper to feed different terminal names into `supports_osc9`. It keeps the test cases short and easy to read.


##### `tests::selects_osc9_method`  (lines 84–89)

```
fn selects_osc9_method()
```

**Purpose**: Checks that an explicit OSC 9 setting really selects the OSC 9 backend. This protects the user’s direct choice from being overridden by detection logic.

**Data flow**: It asks `detect_backend` for a backend using `NotificationMethod::Osc9`. It then verifies that the returned backend is the OSC 9 variant.

**Call relations**: This test exercises the public backend-selection path. It confirms that `detect_backend`, through `DesktopNotificationBackend::for_method`, honors the explicit OSC 9 setting.

*Call graph*: 1 external calls (assert!).


##### `tests::selects_bel_method`  (lines 92–97)

```
fn selects_bel_method()
```

**Purpose**: Checks that an explicit BEL setting really selects the BEL backend. This ensures users can force the simple terminal bell behavior.

**Data flow**: It asks `detect_backend` for a backend using `NotificationMethod::Bel`. It then verifies that the returned backend is the BEL variant.

**Call relations**: This test follows the same public selection path as normal code. It confirms that `detect_backend`, through `DesktopNotificationBackend::for_method`, honors the explicit BEL setting.

*Call graph*: 1 external calls (assert!).


##### `tests::supports_osc9_for_supported_terminals`  (lines 100–113)

```
fn supports_osc9_for_supported_terminals()
```

**Purpose**: Verifies that terminals known to support OSC 9 are accepted by the support check. This protects the auto-selection behavior for modern terminals that can show richer notifications.

**Data flow**: It loops over the supported terminal names, builds a fake `TerminalInfo` for each one, and checks that `supports_osc9` returns `true`. Nothing outside the test is changed.

**Call relations**: This test directly exercises `supports_osc9`, the helper used by automatic backend selection. If a supported terminal were accidentally removed from the list, this test would fail.

*Call graph*: 1 external calls (assert!).


##### `tests::supports_osc9_for_unsupported_terminals`  (lines 116–134)

```
fn supports_osc9_for_unsupported_terminals()
```

**Purpose**: Verifies that terminals not on the OSC 9 support list are rejected. This helps ensure automatic mode falls back to the safer BEL behavior when support is uncertain.

**Data flow**: It loops over terminal names that should not be treated as OSC 9-capable, builds a fake `TerminalInfo` for each one, and checks that `supports_osc9` returns `false`. Nothing outside the test is changed.

**Call relations**: This test directly protects the conservative side of `supports_osc9`. It supports the larger auto-selection flow by making sure unknown or unsupported terminals do not get OSC 9 by mistake.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/notifications/osc9.rs`

`io_transport` · `cross-cutting notification output`

This file is the bridge between the app’s notification request and the terminal feature that can show it to the user. Some terminals understand OSC 9, a small hidden command printed to the terminal that says, in effect, “show this message as a notification.” Without this file, the app could still print text, but it would not be able to ask the terminal to raise a desktop notification.

The main piece is Osc9Backend. When it is created, it checks whether the program is running inside tmux. Tmux is like a window manager inside the terminal: it sits between the app and the real terminal. Because of that extra layer, normal escape sequences may not reach the outside terminal unless they are wrapped in tmux’s special pass-through format.

When notify is called, the backend creates a PostNotification command and asks crossterm, a terminal-control library, to write it to standard output. PostNotification then formats the exact characters needed: either a plain OSC 9 sequence, or a tmux-wrapped version. If wrapping for tmux, it also doubles any escape characters inside the message so they are treated as safe content rather than accidentally ending or changing the wrapper.

The tests check the three important cases: normal output, tmux output, and messages that contain escape bytes.

#### Function details

##### `Osc9Backend::default`  (lines 16–18)

```
fn default() -> Self
```

**Purpose**: Creates a default OSC 9 notification backend. This lets other code use the standard Rust default-construction pattern without knowing the setup details.

**Data flow**: It receives no input. It simply asks Osc9Backend::new to build the backend, including the terminal environment check, and returns that ready-to-use backend.

**Call relations**: This is the convenience doorway for code that constructs the backend through Rust’s Default trait. It immediately hands the real work to Osc9Backend::new so there is only one place that decides how the backend should be initialized.

*Call graph*: 1 external calls (new).


##### `Osc9Backend::new`  (lines 22–26)

```
fn new() -> Self
```

**Purpose**: Builds a notification backend and records whether tmux-specific wrapping is needed. Someone uses this when they want a backend that can send OSC 9 notifications correctly in the current terminal setup.

**Data flow**: It reads terminal information from the environment, checks whether the app is inside tmux, and stores the answer as a true-or-false setting called dcs_passthrough. It returns a new Osc9Backend containing that setting.

**Call relations**: This is the setup step for the backend. Osc9Backend::default delegates to it, and later Osc9Backend::notify uses the stored tmux decision when it creates the notification command.

*Call graph*: called by 1 (for_method); 1 external calls (matches!).


##### `Osc9Backend::notify`  (lines 28–36)

```
fn notify(&mut self, message: &str) -> io::Result<()>
```

**Purpose**: Sends one notification message to the terminal. It is the simple public action: give it text, and it writes the terminal command that may become a desktop notification.

**Data flow**: It takes a message string and reads the backend’s stored dcs_passthrough setting. It packages both into a PostNotification command, writes that command to standard output through crossterm, and returns success or an input/output error.

**Call relations**: This is called when the app wants to notify the user. It does not format the escape sequence itself; it hands that job to PostNotification through crossterm’s execute mechanism.

*Call graph*: 1 external calls (execute!).


##### `PostNotification::write_ansi`  (lines 47–54)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Formats the actual ANSI escape text for an OSC 9 notification. ANSI escape text means special hidden character sequences that terminals interpret as commands instead of visible text.

**Data flow**: It receives a writable text buffer and reads the notification message plus the dcs_passthrough flag from the PostNotification value. If tmux wrapping is needed, it first escapes unsafe escape characters in the message, then writes a tmux pass-through wrapper around the OSC 9 command. Otherwise, it writes the plain OSC 9 command. It returns whether formatting succeeded.

**Call relations**: Crossterm calls this when Osc9Backend::notify executes a PostNotification command. If tmux wrapping is enabled, this function calls escape_tmux_dcs_passthrough_payload before writing, so the message can safely travel through tmux.

*Call graph*: calls 1 internal fn (escape_tmux_dcs_passthrough_payload); 1 external calls (write!).


##### `PostNotification::execute_winapi`  (lines 57–61)

```
fn execute_winapi(&self) -> io::Result<()>
```

**Purpose**: Prevents this command from being sent through the Windows-specific terminal API path. This notification command is meant to be written as ANSI escape text instead.

**Data flow**: On Windows builds, it receives the command object but does not use its message. It returns an error explaining that the WinAPI route is the wrong route for this command.

**Call relations**: This exists because crossterm commands can have a Windows API implementation. For PostNotification, the intended path is PostNotification::write_ansi, so this function acts as a guardrail if something tries the wrong execution method.

*Call graph*: 1 external calls (other).


##### `PostNotification::is_ansi_code_supported`  (lines 64–66)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Tells crossterm that this command supports ANSI escape output on Windows. In plain terms, it says, “yes, write the special terminal text for this command.”

**Data flow**: On Windows builds, it takes no meaningful input beyond the command object and always returns true. It does not change anything.

**Call relations**: Crossterm can consult this when deciding how to execute the command on Windows. It points execution toward the ANSI path, where PostNotification::write_ansi formats the notification sequence.


##### `escape_tmux_dcs_passthrough_payload`  (lines 69–71)

```
fn escape_tmux_dcs_passthrough_payload(message: &str) -> String
```

**Purpose**: Makes a notification message safe to place inside tmux’s pass-through wrapper. It protects against escape characters inside the message being mistaken for control characters that affect the wrapper itself.

**Data flow**: It takes the original message text, replaces every escape character with two escape characters, and returns the adjusted string. It does not change the original message.

**Call relations**: PostNotification::write_ansi calls this only for the tmux-wrapped path. It is a small safety helper that keeps the tmux wrapper well-formed even when the notification text contains terminal control bytes.

*Call graph*: called by 1 (write_ansi).


##### `tests::post_notification_writes_plain_osc9_sequence`  (lines 81–93)

```
fn post_notification_writes_plain_osc9_sequence()
```

**Purpose**: Checks that a normal, non-tmux notification is formatted as the expected plain OSC 9 escape sequence. This protects the basic notification output from accidental changes.

**Data flow**: It creates an empty string, builds a PostNotification with message "hello" and tmux wrapping turned off, asks the command to write its ANSI text into the string, and compares the result with the exact expected sequence.

**Call relations**: This test exercises PostNotification::write_ansi in the simplest path. It confirms that code using Osc9Backend::notify outside tmux will send the right terminal command.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::post_notification_writes_tmux_dcs_wrapped_osc9_sequence`  (lines 96–108)

```
fn post_notification_writes_tmux_dcs_wrapped_osc9_sequence()
```

**Purpose**: Checks that a notification meant to pass through tmux is wrapped in tmux’s special outer sequence. This matters because tmux otherwise may keep the real terminal from seeing the OSC 9 command.

**Data flow**: It creates an empty string, builds a PostNotification with message "done" and tmux wrapping turned on, writes the ANSI text into the string, and compares it with the expected tmux-wrapped OSC 9 sequence.

**Call relations**: This test exercises the tmux branch of PostNotification::write_ansi. It verifies the behavior that Osc9Backend::new enables when terminal detection says the app is inside tmux.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::post_notification_escapes_escape_bytes_inside_tmux_payload`  (lines 111–126)

```
fn post_notification_escapes_escape_bytes_inside_tmux_payload()
```

**Purpose**: Checks that escape characters inside the notification message are doubled when using tmux pass-through. This prevents message content from accidentally breaking the terminal control sequence.

**Data flow**: It creates a message containing an escape character, builds a tmux-wrapped PostNotification, writes the ANSI text into a string, and checks that the escape character inside the message has been doubled in the output.

**Call relations**: This test covers the safety helper escape_tmux_dcs_passthrough_payload through PostNotification::write_ansi. It proves that the tmux path is not only wrapped, but also protected against risky message contents.

*Call graph*: 2 external calls (new, assert_eq!).


### `tui/src/notifications/bel.rs`

`io_transport` · `cross-cutting notification output`

This file solves the simplest version of “get the user’s attention” in a terminal app. Many terminals understand a special control character called BEL. It is like ringing a tiny bell at the terminal: the terminal may play a sound, flash the window, bounce the dock icon, or do nothing depending on the user’s settings.

The main piece is `BelBackend`, a notification sender. When asked to notify, it ignores the message text and writes a BEL command to standard output, which is the normal output stream connected to the terminal. It uses Crossterm, a library for sending terminal commands in a portable way.

`PostNotification` is the actual Crossterm command. On systems that accept ANSI escape/control codes, it writes the BEL byte, written in Rust as `\x07`. On Windows, the file deliberately says not to use the older Windows API route for this command; it reports an error if that path is attempted and declares that the ANSI route is supported instead.

Without this file, this notification mode would not exist. Parts of the TUI that want a lightweight alert would need a different backend, or users would not get this terminal bell-style notification.

#### Function details

##### `BelBackend::notify`  (lines 12–14)

```
fn notify(&mut self, _message: &str) -> io::Result<()>
```

**Purpose**: Sends a terminal bell notification. The message text is accepted so it can fit the same shape as other notification backends, but this backend does not display or use the text.

**Data flow**: It receives a mutable `BelBackend` and a message string. It ignores the message, gets standard output, and asks Crossterm to execute `PostNotification` there. The result is either success or an input/output error if writing to the terminal fails.

**Call relations**: When some higher-level notification code chooses this backend, it calls `BelBackend::notify`. This function then hands the real work to Crossterm’s `execute!` macro, which will use the `PostNotification` command to produce the actual terminal output.

*Call graph*: 1 external calls (execute!).


##### `PostNotification::write_ansi`  (lines 22–24)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Writes the actual BEL control character into an ANSI-style terminal command stream. ANSI here means the common text-based control language many terminals understand.

**Data flow**: It receives a formatter, which is a place Crossterm can write command text. It writes the single BEL character `\x07` into that formatter and returns whether the write succeeded.

**Call relations**: Crossterm calls this method when it needs the ANSI form of `PostNotification`, typically as part of the `execute!` call started by `BelBackend::notify`. This is the point where the abstract notification command becomes the concrete byte that can make the terminal alert the user.

*Call graph*: 1 external calls (write!).


##### `PostNotification::execute_winapi`  (lines 27–31)

```
fn execute_winapi(&self) -> io::Result<()>
```

**Purpose**: On Windows builds, this refuses to send the notification through the older Windows API path. It tells callers to use the ANSI terminal path instead.

**Data flow**: It receives the command object and does not write anything to the terminal. Instead, it creates and returns an input/output error explaining that the WinAPI route is not the intended way to run this command.

**Call relations**: Crossterm may look for a Windows-specific execution method for commands on Windows. If that path is tried for `PostNotification`, this function stops it with a clear error, while `is_ansi_code_supported` tells Crossterm that the ANSI path is acceptable.

*Call graph*: 1 external calls (other).


##### `PostNotification::is_ansi_code_supported`  (lines 34–36)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: On Windows builds, this tells Crossterm that the ANSI version of this command is supported. That steers execution toward writing the BEL control character rather than using the Windows API path.

**Data flow**: It receives the command object and returns `true`. It does not read external state or change anything.

**Call relations**: Crossterm can consult this when deciding how to execute `PostNotification` on Windows. Together with `execute_winapi`, it makes the intended route clear: use `write_ansi` to emit the BEL character.


### `tui/src/terminal_title.rs`

`io_transport` · `cross-cutting terminal title updates`

Terminal titles are set by writing a special escape sequence to standard output. That is powerful, but also risky: the title may include text from model output, project paths, thread names, or user config, and those sources should not be trusted blindly. This file is the small gatekeeper between ordinary text and the terminal title bar. Before anything is written, it removes control characters, invisible formatting marks, and bidirectional text controls, which are characters that can make text appear in a different order than it really is. It also collapses messy whitespace into single spaces and limits the title to a practical length so tab bars stay readable. If the cleaned title has no visible content left, the file refuses to write it and lets higher-level code decide what that should mean. The file also provides a separate way to clear the title by intentionally writing an empty title. The actual writing is done through a small crossterm command, SetWindowTitle, which emits the terminal's OSC title sequence. In plain terms, this module is like a careful label printer: it checks that the label is safe and readable before sticking it on the terminal window.

#### Function details

##### `set_terminal_title`  (lines 56–68)

```
fn set_terminal_title(title: &str) -> io::Result<SetTerminalTitleResult>
```

**Purpose**: Safely writes a new terminal title if standard output is really connected to a terminal. It is used when higher-level code has decided the visible window or tab title should change.

**Data flow**: It receives a proposed title as text. First it checks whether stdout is a terminal; if not, it treats the request as successfully applied because there is nowhere useful to write a title. If stdout is a terminal, it sends the text through sanitize_terminal_title, stops if nothing visible remains, and otherwise writes a SetWindowTitle command. It returns either Applied, NoVisibleContent, or an I/O error if the terminal write fails.

**Call relations**: This is the main public path for setting titles in this file. It calls sanitize_terminal_title before it calls the external terminal-writing machinery, so unsafe or noisy text is cleaned before SetWindowTitle is ever emitted.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 2 external calls (execute!, stdout).


##### `clear_terminal_title`  (lines 74–80)

```
fn clear_terminal_title() -> io::Result<()>
```

**Purpose**: Clears the current terminal title by deliberately writing an empty title. This does not restore whatever title existed before; it only removes the title this program is setting now.

**Data flow**: It takes no title input. It checks whether stdout is a terminal, and if not, it does nothing and succeeds. If stdout is a terminal, it writes a SetWindowTitle command containing an empty string, then returns success or an I/O error from the write.

**Call relations**: This is the companion to set_terminal_title for the explicit clear case. Unlike set_terminal_title, it does not sanitize or reject the empty title, because the whole point here is to send an empty title payload.

*Call graph*: 2 external calls (execute!, stdout).


##### `SetWindowTitle::write_ansi`  (lines 86–91)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Turns a title string into the exact ANSI escape text that terminals understand as 'set the window title.' ANSI escape text means special character sequences written to the terminal to control its behavior.

**Data flow**: It reads the title stored inside SetWindowTitle and writes an OSC 0 title sequence into the provided formatter. The result is not a normal user-facing string; it is terminal control text that says 'set title to this value' and ends with a bell character terminator.

**Call relations**: The crossterm execute macro calls this when set_terminal_title or clear_terminal_title asks to send SetWindowTitle to the terminal. This function is the final encoding step before bytes go to stdout.

*Call graph*: 1 external calls (write!).


##### `SetWindowTitle::execute_winapi`  (lines 94–98)

```
fn execute_winapi(&self) -> io::Result<()>
```

**Purpose**: Prevents this command from being run through the Windows API path. The file wants this title command to use ANSI escape sequences instead, even on Windows.

**Data flow**: It receives no extra data beyond the command object. If the Windows-specific API route is attempted, it returns an error explaining that ANSI should be used instead. It does not write a title.

**Call relations**: This function only exists on Windows builds as part of the crossterm Command interface. It protects the intended flow: terminal title updates should go through write_ansi, not through a separate Windows API implementation.

*Call graph*: 1 external calls (other).


##### `SetWindowTitle::is_ansi_code_supported`  (lines 101–103)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Tells crossterm that this command supports ANSI escape output on Windows. That lets the normal ANSI-writing path be used for the title sequence.

**Data flow**: It takes no input other than the command object and returns true. It does not inspect or change the title.

**Call relations**: This Windows-only Command hook works with execute_winapi to steer crossterm toward the ANSI path, where SetWindowTitle::write_ansi produces the actual title escape sequence.


##### `sanitize_terminal_title`  (lines 111–146)

```
fn sanitize_terminal_title(title: &str) -> String
```

**Purpose**: Cleans unsafe or messy title text into one short, readable line. It is the safety filter that stops control characters, invisible formatting marks, and excessive whitespace from reaching the terminal title escape sequence.

**Data flow**: It receives raw title text. It walks through the text one character at a time, drops disallowed characters, turns any run of whitespace into at most one ordinary space, removes leading whitespace, and stops once the title reaches the maximum allowed character count. It returns the cleaned title as a new string.

**Call relations**: set_terminal_title calls this before writing to the terminal. The test functions also call it directly to prove that messy whitespace, invisible characters, and overlong input are treated correctly.

*Call graph*: calls 1 internal fn (is_disallowed_terminal_title_char); called by 5 (set_terminal_title, sanitizes_terminal_title, strips_invisible_format_chars_from_terminal_title, truncates_terminal_title, truncation_prefers_visible_char_over_pending_space); 1 external calls (new).


##### `is_disallowed_terminal_title_char`  (lines 154–177)

```
fn is_disallowed_terminal_title_char(ch: char) -> bool
```

**Purpose**: Decides whether one character is unsafe or unsuitable for a terminal title. It rejects ordinary control characters and a specific set of invisible or text-reordering formatting characters.

**Data flow**: It receives a single character. It first checks whether it is a control character; if so, it rejects it. Otherwise it compares the character against known invisible and bidirectional formatting ranges, then returns true for characters that should be dropped and false for characters that may remain.

**Call relations**: sanitize_terminal_title calls this for each non-whitespace character. It is the focused rulebook that keeps the sanitizer readable and makes the security-sensitive character list explicit.

*Call graph*: called by 1 (sanitize_terminal_title); 1 external calls (matches!).


##### `tests::sanitizes_terminal_title`  (lines 188–192)

```
fn sanitizes_terminal_title()
```

**Purpose**: Checks that the sanitizer turns messy terminal-title input into a clean readable line. It covers leading and trailing whitespace, tabs, newlines, and terminal control characters.

**Data flow**: It builds a deliberately messy title string, sends it to sanitize_terminal_title, and compares the result with the expected clean title. Nothing outside the test is changed.

**Call relations**: This test exercises sanitize_terminal_title directly. It confirms the normal cleanup behavior that set_terminal_title relies on before writing a title.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 1 external calls (assert_eq!).


##### `tests::strips_invisible_format_chars_from_terminal_title`  (lines 195–200)

```
fn strips_invisible_format_chars_from_terminal_title()
```

**Purpose**: Checks that invisible and bidirectional formatting characters are removed from title text. These characters can make text misleading or hard to inspect, so they should not appear in a terminal title.

**Data flow**: It creates a title containing hidden formatting characters mixed into visible words. It passes that string to sanitize_terminal_title and asserts that the output contains only the visible words in normal order.

**Call relations**: This test verifies the security-focused part of sanitize_terminal_title, which in turn depends on is_disallowed_terminal_title_char to identify the characters that must be dropped.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 1 external calls (assert_eq!).


##### `tests::truncates_terminal_title`  (lines 203–207)

```
fn truncates_terminal_title()
```

**Purpose**: Checks that very long titles are shortened to the file's maximum title length. This keeps terminal tabs and window managers from receiving excessively large title strings.

**Data flow**: It creates a string longer than the allowed title length, runs it through sanitize_terminal_title, and asserts that the cleaned result has exactly the maximum allowed length.

**Call relations**: This test directly supports sanitize_terminal_title's length limit. That limit matters because set_terminal_title writes whatever sanitized text it receives to the terminal.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 1 external calls (assert_eq!).


##### `tests::truncation_prefers_visible_char_over_pending_space`  (lines 210–215)

```
fn truncation_prefers_visible_char_over_pending_space()
```

**Purpose**: Checks a subtle edge case in truncation: when there is room for only one more character, the sanitizer should keep the next visible character rather than spend the final slot on a space.

**Data flow**: It creates a title that is almost at the maximum length, followed by a space and then a visible letter. It sanitizes the title and checks that the result reaches the maximum length and ends with the visible letter.

**Call relations**: This test exercises the interaction between whitespace collapsing and length limiting inside sanitize_terminal_title. It helps ensure titles stay meaningful even right at the cutoff.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 2 external calls (assert_eq!, format!).


##### `tests::writes_osc_title_with_bel_terminator`  (lines 218–224)

```
fn writes_osc_title_with_bel_terminator()
```

**Purpose**: Checks that SetWindowTitle encodes the terminal title command in the expected OSC format and ends it with the bell terminator. This protects the exact low-level sequence that terminals receive.

**Data flow**: It creates a SetWindowTitle value containing 'hello', asks it to write its ANSI escape text into a string, and compares that string with the expected terminal control sequence.

**Call relations**: This test exercises SetWindowTitle::write_ansi directly. That is the same encoding path used when set_terminal_title and clear_terminal_title send title updates through crossterm.

*Call graph*: 3 external calls (new, assert_eq!, new).


### `cli/src/doctor/title.rs`

`domain_logic` · `doctor diagnostics`

This file is part of the “doctor” diagnostics: code that explains whether a user’s setup looks healthy. Its focus is the terminal title, meaning the text the app can put in the terminal window’s title bar. Without this check, a user could mistype a title item in the configuration and get confusing behavior with little explanation.

The file first decides where the title setting came from. An empty configured list means the feature is disabled. A missing setting means the app uses its default title pieces: activity plus project name. A non-empty configured list is parsed and normalized, so friendly aliases like “project” become the official “project-name”. Unknown entries are kept aside and reported as warnings.

If the title includes a project name, the file also works out what project name would be shown. It prefers the Git repository root, then falls back to project configuration, and finally uses the current working directory. The displayed name is shortened safely by counting user-visible characters, so emoji and accented characters are not cut in the middle.

The result is a DoctorCheck: a small report with a status, a summary, details, and, when needed, a suggested fix.

#### Function details

##### `terminal_title_check`  (lines 30–36)

```
fn terminal_title_check(config: &Config) -> DoctorCheck
```

**Purpose**: This is the public check used by the doctor command for terminal title settings. It gathers the needed facts from the full app configuration, then asks the lower-level checker to build the report.

**Data flow**: It receives the full Config. From that it reads the configured terminal title list, the current working directory, and a possible project root. It packages those into TerminalTitleInputs and returns the DoctorCheck produced from them.

**Call relations**: When the doctor system wants to inspect terminal title behavior, it calls this function. This function first asks terminal_title_project_root to find the best project folder, then hands all prepared inputs to terminal_title_check_from_inputs to create the final diagnostic report.

*Call graph*: calls 2 internal fn (terminal_title_check_from_inputs, terminal_title_project_root).


##### `terminal_title_check_from_inputs`  (lines 38–106)

```
fn terminal_title_check_from_inputs(inputs: TerminalTitleInputs) -> DoctorCheck
```

**Purpose**: This builds the actual terminal title doctor report from simple, testable inputs. It explains whether the title is default, configured, or disabled, and warns if the configuration names unknown title parts.

**Data flow**: It receives optional configured title items, the current directory, and an optional project root. It chooses defaults when no setting exists, treats an empty list as disabled, or parses the configured list into valid and invalid entries. It then creates details, adds project-name information when relevant, sets the status to OK or Warning, and returns a DoctorCheck.

**Call relations**: terminal_title_check calls this after preparing inputs from the real Config. The tests also call it directly so they can check behavior without needing a real Git repository or full configuration stack. Inside, it uses parse_terminal_title_items to clean user input, project_title_selected to decide whether project details matter, and project_title_candidate to compute the project name that would be shown.

*Call graph*: calls 5 internal fn (new, new, parse_terminal_title_items, project_title_candidate, project_title_selected); called by 8 (terminal_title_check, terminal_title_omits_project_when_project_item_is_not_selected, terminal_title_project_value_uses_tui_truncation_shape, terminal_title_reports_default_items_and_git_project_name, terminal_title_reports_disabled_configuration, terminal_title_reports_project_config_fallback, terminal_title_warns_for_invalid_configured_items, terminal_title_warns_when_all_configured_items_are_invalid); 3 external calls (new, format!, vec!).


##### `parse_terminal_title_items`  (lines 108–123)

```
fn parse_terminal_title_items(items: Vec<String>) -> (Vec<String>, Vec<String>)
```

**Purpose**: This turns a user’s list of terminal title item names into known, official names. It also collects unknown names so the doctor report can warn the user clearly.

**Data flow**: It receives a list of strings from configuration. For each string, it asks terminal_title_item_id whether the name is recognized. Recognized items are added to the parsed list; unknown items are quoted and added once to the invalid list. It returns both lists.

**Call relations**: terminal_title_check_from_inputs uses this whenever the user has supplied a non-empty title configuration. It relies on terminal_title_item_id as the dictionary of accepted names and aliases, then hands the cleaned and rejected names back for reporting.

*Call graph*: calls 1 internal fn (terminal_title_item_id); called by 1 (terminal_title_check_from_inputs); 3 external calls (new, new, format!).


##### `terminal_title_item_id`  (lines 125–150)

```
fn terminal_title_item_id(item: &str) -> Option<&'static str>
```

**Purpose**: This is the small dictionary of valid terminal title item names. It also accepts older or friendlier aliases, such as “project” for “project-name”.

**Data flow**: It receives one item name as text. If the name or alias is known, it returns the official item identifier. If not, it returns nothing, marking the item as invalid.

**Call relations**: parse_terminal_title_items calls this for each configured item. This function is the source of truth for which terminal title pieces the doctor check recognizes.

*Call graph*: called by 1 (parse_terminal_title_items).


##### `activity_enabled`  (lines 152–156)

```
fn activity_enabled(items: &[String]) -> bool
```

**Purpose**: This answers whether the terminal title includes an activity indicator, such as a spinner. The doctor report uses this to show whether the title will visibly reflect activity.

**Data flow**: It receives the parsed title item list. It scans for “activity” or the alias “spinner” and returns true if either is present, otherwise false.

**Call relations**: It is used while the terminal title report is being assembled, so the details can include a simple yes-or-no line about activity display.


##### `project_title_selected`  (lines 158–162)

```
fn project_title_selected(items: &[String]) -> bool
```

**Purpose**: This answers whether the terminal title is supposed to include a project name. That matters because project-name details are only useful if the title will actually show them.

**Data flow**: It receives the parsed title item list. It scans for “project-name” or the alias “project” and returns true if one is present.

**Call relations**: terminal_title_check_from_inputs calls this before doing project-name reporting. If it returns true, the checker asks project_title_candidate what project name would be displayed.

*Call graph*: called by 1 (terminal_title_check_from_inputs).


##### `terminal_title_project_root`  (lines 164–189)

```
fn terminal_title_project_root(config: &Config, cwd: &Path) -> Option<ProjectTitleRoot>
```

**Purpose**: This finds the best folder to treat as the project root for the terminal title. It prefers a Git repository root, then falls back to project configuration.

**Data flow**: It receives the full Config and the current working directory. It first asks the Git helper whether the current directory is inside a Git repository. If so, it returns that root with the source label “git repo root”. If not, it searches the configuration layers for a project config folder and returns its parent as the root. If neither exists, it returns nothing.

**Call relations**: terminal_title_check calls this while preparing inputs for the report. The result is later used by project_title_candidate, through terminal_title_check_from_inputs, to explain which project name would appear in the terminal title.

*Call graph*: called by 1 (terminal_title_check); 1 external calls (get_git_repo_root).


##### `project_title_candidate`  (lines 191–202)

```
fn project_title_candidate(
    project_root: Option<ProjectTitleRoot>,
    cwd: &Path,
) -> (&'static str, Option<String>)
```

**Purpose**: This chooses the actual project text that would be shown in the terminal title. It also records where that choice came from, such as Git, project config, or the current directory.

**Data flow**: It receives an optional project root and the current directory. If a project root exists, it takes that folder’s display name and shortens it if needed. If no root exists, it does the same with the current directory. It returns a source label and the display value.

**Call relations**: terminal_title_check_from_inputs calls this only when the title includes a project-name item. It uses path_display_name to get a human-friendly folder name and truncate_title_part to keep it short enough for a title bar.

*Call graph*: calls 2 internal fn (path_display_name, truncate_title_part); called by 1 (terminal_title_check_from_inputs).


##### `path_display_name`  (lines 204–208)

```
fn path_display_name(path: &Path) -> String
```

**Purpose**: This turns a filesystem path into the name most people expect to see in a title bar. For example, “/work/my-app” becomes “my-app”.

**Data flow**: It receives a path. If the path has a final folder or file name, it converts that name to text. If not, it falls back to the full displayed path. It returns the chosen text.

**Call relations**: project_title_candidate calls this before shortening the project name. It is the step that changes a full path into a compact, user-facing label.

*Call graph*: called by 1 (project_title_candidate); 1 external calls (file_name).


##### `truncate_title_part`  (lines 210–226)

```
fn truncate_title_part(value: String) -> String
```

**Purpose**: This shortens long title pieces so the terminal title does not become unwieldy. It adds an ellipsis when text is longer than the allowed project-title length.

**Data flow**: It receives a string. It counts user-visible characters, called graphemes, so combined characters and emoji stay intact. If the text fits, it returns it unchanged. If it is too long, it keeps the leading part and appends “...”.

**Call relations**: project_title_candidate calls this after choosing a folder name. This keeps the project part of the terminal title in the same compact shape that the user interface expects.

*Call graph*: called by 1 (project_title_candidate).


##### `tests::terminal_title_reports_default_items_and_git_project_name`  (lines 235–261)

```
fn terminal_title_reports_default_items_and_git_project_name()
```

**Purpose**: This test proves that, when no title setting is configured, the checker reports the default title items and uses the Git repository name as the project value.

**Data flow**: It builds fake inputs with no configured items, a current directory inside a repo, and a Git root. It runs terminal_title_check_from_inputs and checks that the summary, item list, project source, and project value match expectations.

**Call relations**: The test calls terminal_title_check_from_inputs directly to isolate the report-building logic. It represents the normal default path that terminal_title_check would use after finding a Git root.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 3 external calls (from, assert!, assert_eq!).


##### `tests::terminal_title_reports_disabled_configuration`  (lines 264–288)

```
fn terminal_title_reports_disabled_configuration()
```

**Purpose**: This test proves that an explicitly empty title item list means the terminal title feature is disabled.

**Data flow**: It builds fake inputs with an empty configured list and no project root. After running terminal_title_check_from_inputs, it checks that the summary says disabled, the item list says none, activity is false, and no project details are included.

**Call relations**: The test exercises the disabled branch inside terminal_title_check_from_inputs. It helps ensure the checker does not do unnecessary project-name reporting when the title has no items.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, new, assert!, assert_eq!).


##### `tests::terminal_title_reports_project_config_fallback`  (lines 291–312)

```
fn terminal_title_reports_project_config_fallback()
```

**Purpose**: This test proves that project configuration can provide the project root when Git information is not the source.

**Data flow**: It supplies a title list containing “project”, a current directory below a project, and a project root marked as coming from project config. It checks that the report says the title is configured and shows the project config source and folder name.

**Call relations**: The test calls terminal_title_check_from_inputs with prepared fallback data. It covers the same kind of project-root value that terminal_title_project_root can produce from configuration layers.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, assert!, assert_eq!, vec!).


##### `tests::terminal_title_omits_project_when_project_item_is_not_selected`  (lines 315–332)

```
fn terminal_title_omits_project_when_project_item_is_not_selected()
```

**Purpose**: This test proves that the report does not include project-name details unless the title actually asks for a project name.

**Data flow**: It supplies a configured title list containing only “model”, plus a project root. After running terminal_title_check_from_inputs, it checks that the report is configured but contains no project-related detail lines.

**Call relations**: The test checks the decision made through project_title_selected inside terminal_title_check_from_inputs. It protects against noisy or misleading doctor output.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, assert!, assert_eq!, vec!).


##### `tests::terminal_title_warns_for_invalid_configured_items`  (lines 335–366)

```
fn terminal_title_warns_for_invalid_configured_items()
```

**Purpose**: This test proves that unknown configured title items produce a warning while valid items are still accepted.

**Data flow**: It supplies a configured list with valid items and the invalid value “bogus” repeated. It runs terminal_title_check_from_inputs and checks that the status is Warning, the valid items are normalized, the invalid item is reported once, and one issue is attached.

**Call relations**: The test exercises parse_terminal_title_items through terminal_title_check_from_inputs. It confirms that the checker both preserves useful configuration and gives the user a clear fixable warning.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, assert!, assert_eq!, vec!).


##### `tests::terminal_title_warns_when_all_configured_items_are_invalid`  (lines 369–387)

```
fn terminal_title_warns_when_all_configured_items_are_invalid()
```

**Purpose**: This test proves that the checker still gives a useful warning when every configured title item is unknown.

**Data flow**: It supplies a configured list containing only “bogus”. After running terminal_title_check_from_inputs, it checks that the status is Warning, the accepted item list is none, and the invalid value is shown.

**Call relations**: The test covers the edge case where parse_terminal_title_items returns no valid items. It ensures terminal_title_check_from_inputs still creates a clear doctor report instead of treating the title as silently disabled.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, assert!, assert_eq!, vec!).


##### `tests::terminal_title_project_value_uses_tui_truncation_shape`  (lines 390–405)

```
fn terminal_title_project_value_uses_tui_truncation_shape()
```

**Purpose**: This test proves that long project names are shortened in the same style expected by the terminal user interface.

**Data flow**: It supplies a long project folder name and a title list that requests the project name. It runs terminal_title_check_from_inputs and checks that the reported project value is shortened with an ellipsis.

**Call relations**: The test reaches truncate_title_part through terminal_title_check_from_inputs and project_title_candidate. It protects the visible title format so doctor output matches what the app would show.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 3 external calls (from, assert!, vec!).


### Pet and auxiliary terminal surfaces
These files provide the pet-rendering subsystem and other auxiliary terminal-facing surfaces used once the TUI is running.

### `tui/src/pets/mod.rs`

`io_transport` · `main loop pet drawing and pet picker preview`

The pet feature has two kinds of pets. Built-in pets belong to the application and may need to be downloaded or copied into the app cache before use. Custom pets belong to the user and are already local files. This file keeps that split clear for the rest of the terminal UI.

It re-exports the main pet types from smaller submodules, defines the default and disabled pet IDs, and provides the small public functions callers use before loading or drawing pets. One part makes sure a built-in pet’s spritesheet is available in CODEX_HOME, the app’s local data directory. Another part draws pet images into the terminal.

Terminal images are tricky because different terminals support different image protocols. A protocol is just a way of sending image data to a terminal. This file supports Kitty-style images, Kitty images by local file reference, and Sixel images. It also remembers what was drawn last, because clearing an image is different for each protocol. Kitty images can be deleted by image ID. Sixel images behave more like paint on the terminal grid, so the code clears the old cell area with spaces before redrawing. Like putting down a sticker versus painting on a wall, removing them takes different tools.

Without this file, pet rendering would be scattered and error-prone: first-use built-in pets might fail unpredictably, old images could remain on screen, and the cursor could be left in the wrong place after drawing.

#### Function details

##### `ensure_builtin_pack_for_pet`  (lines 60–68)

```
fn ensure_builtin_pack_for_pet(
    pet_id: &str,
    codex_home: &std::path::Path,
) -> Result<()>
```

**Purpose**: This checks whether a selected pet is one of the app’s built-in pets, and if so makes sure its image pack exists in the local CODEX_HOME cache. Custom pets are left alone because their files are already user-owned local data.

**Data flow**: It receives a pet ID and the path to CODEX_HOME. It asks the catalog whether that ID belongs to a built-in pet; if it does, it asks the asset pack code to make the built-in files available. It returns success when there is nothing to do or the files are ready, and returns an error if the built-in pack cannot be prepared.

**Call relations**: Callers use this before previewing or selecting a built-in pet, so asset problems are caught at the asset boundary. It relies on catalog::builtin_pet to identify built-ins, then hands the actual cache preparation to asset_pack::ensure_builtin_pet.

*Call graph*: calls 2 internal fn (ensure_builtin_pet, builtin_pet).


##### `PetImageRenderError::fmt`  (lines 77–82)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This turns a pet image rendering error into a clear human-readable message. It distinguishes between terminal writing failures and missing or unreadable image assets.

**Data flow**: It receives the error value and a text formatter. It writes a message such as “terminal image write failed” or “pet image asset unavailable,” including the underlying error text. The output is formatted text for logs, diagnostics, or user-facing error paths.

**Call relations**: This is used automatically when PetImageRenderError needs to be displayed. It wraps lower-level errors from terminal output or asset preparation in language that explains which side failed.

*Call graph*: 1 external calls (write!).


##### `PetImageRenderError::source`  (lines 86–91)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: This exposes the original lower-level error inside a pet rendering error. That lets error-reporting tools show the full chain of what went wrong.

**Data flow**: It receives a PetImageRenderError. If the problem came from the terminal writer, it returns the original input/output error; if it came from an asset operation, it returns the underlying asset error. Nothing is changed.

**Call relations**: This supports Rust’s standard error chaining. The tests check that both asset failures and writer failures keep a source error instead of hiding the real cause.


##### `PetImageRenderError::from`  (lines 95–97)

```
fn from(err: std::io::Error) -> Self
```

**Purpose**: This converts a normal terminal input/output error into the pet renderer’s own error type. It lets the drawing code use ordinary error shortcuts while still returning a pet-specific error.

**Data flow**: It receives a std::io::Error from writing to the terminal. It wraps that error as PetImageRenderError::Terminal and returns it. No other state changes.

**Call relations**: render_pet_image writes escape codes and image bytes to a writer; when those writes fail, this conversion lets the failure become a terminal render error.

*Call graph*: 1 external calls (Terminal).


##### `render_ambient_pet_image`  (lines 100–106)

```
fn render_ambient_pet_image(
    writer: &mut impl Write,
    state: &mut PetImageRenderState,
    request: Option<AmbientPetDraw>,
) -> std::result::Result<(), PetImageRenderError>
```

**Purpose**: This draws or clears the pet image that lives in the main terminal UI. It is a convenience wrapper that gives the ambient pet a stable image ID.

**Data flow**: It receives a terminal writer, remembered render state, and either a draw request or None. It passes those to the shared renderer with the ambient pet image ID. The writer receives terminal commands and image data, and the state is updated so the next draw knows what was last shown.

**Call relations**: The main ambient pet path and several tests call this function. It delegates all real drawing and clearing behavior to render_pet_image, using image ID 0xC0DE so Kitty-style terminals can replace or delete the same image reliably.

*Call graph*: calls 1 internal fn (render_pet_image); called by 8 (ambient_pet_image_restores_cursor_after_drawing, kitty_local_file_pet_image_uses_file_reference_without_inline_payload, kitty_pet_image_clear_deletes_without_moving_cursor, missing_frame_is_an_asset_error, sixel_pet_image_clear_erases_last_drawn_area, sixel_pet_image_clears_cell_area_before_redrawing, writer_failure_is_a_terminal_error, clear_ambient_pet_image).


##### `render_pet_picker_preview_image`  (lines 108–114)

```
fn render_pet_picker_preview_image(
    writer: &mut impl Write,
    state: &mut PetImageRenderState,
    request: Option<AmbientPetDraw>,
) -> std::result::Result<(), PetImageRenderError>
```

**Purpose**: This draws or clears the preview image shown in the pet picker. It uses the same renderer as the ambient pet but with a different image ID so the two images do not conflict.

**Data flow**: It receives a writer, render state, and optional draw request. It forwards them to the shared image renderer with the picker preview’s image ID. The result is terminal output for the preview and updated state for future preview draws.

**Call relations**: Picker preview code can call this when it wants to show a selected pet. It hands off to render_pet_image, separating preview identity from the ambient pet’s identity.

*Call graph*: calls 1 internal fn (render_pet_image).


##### `render_pet_image`  (lines 122–207)

```
fn render_pet_image(
    writer: &mut impl Write,
    state: &mut PetImageRenderState,
    image_id: u32,
    request: Option<AmbientPetDraw>,
) -> std::result::Result<(), PetImageRenderError>
```

**Purpose**: This is the core drawing routine for pet images. It sends the right terminal commands for the chosen image protocol, clears old images when needed, preserves the cursor position, and writes the new image at the requested screen location.

**Data flow**: It receives a writer, render state, an image ID, and either a draw request or None. If the request is None, it clears the previous image: Kitty images are deleted by ID, while any remembered Sixel area is erased with spaces. If there is a draw request, it first removes any old Kitty image when needed, prepares the image payload for Kitty, Kitty local-file, or Sixel, clears any stale Sixel area, moves the cursor to the pet position, writes the image payload, restores the cursor, flushes the writer, and updates remembered state.

**Call relations**: Both render_ambient_pet_image and render_pet_picker_preview_image funnel into this function. It calls the image protocol helpers to build Kitty commands or find Sixel frame files, uses SixelClearArea::from to remember what terminal cells must be wiped, uses clear_sixel_area for Sixel cleanup, and uses is_kitty_protocol to decide when image-ID deletion is needed.

*Call graph*: calls 6 internal fn (from, clear_sixel_area, kitty_transmit_png_file_with_id, kitty_transmit_png_with_id, sixel_frame, is_kitty_protocol); called by 2 (render_ambient_pet_image, render_pet_picker_preview_image); 8 external calls (flush, write_all, matches!, queue!, read, Bytes, Text, write!).


##### `is_kitty_protocol`  (lines 214–219)

```
fn is_kitty_protocol(protocol: image_protocol::ImageProtocol) -> bool
```

**Purpose**: This answers whether an image protocol is one of the Kitty-family protocols. The renderer needs this because Kitty images can be deleted by image ID.

**Data flow**: It receives an image protocol value. It returns true for inline Kitty images and Kitty local-file images, and false for Sixel. It does not change anything.

**Call relations**: render_pet_image calls this before drawing or clearing. That check decides whether to send a Kitty delete command so an old image does not linger.

*Call graph*: called by 1 (render_pet_image); 1 external calls (matches!).


##### `SixelClearArea::from`  (lines 230–237)

```
fn from(request: &AmbientPetDraw) -> Self
```

**Purpose**: This converts a draw request into the rectangle of terminal cells that should be blanked when using Sixel. Sixel images need this because they are cleared by overwriting the terminal area with spaces.

**Data flow**: It reads the requested x position, top clear row, image y position, row height, and column width from AmbientPetDraw. It creates a SixelClearArea with the left edge, top row, bottom row, and width to erase. The bottom row is calculated safely so it does not overflow.

**Call relations**: render_pet_image calls this when the current request uses Sixel. The resulting area is stored in PetImageRenderState and later passed to clear_sixel_area before redraws or when the pet is cleared.

*Call graph*: called by 1 (render_pet_image).


##### `clear_sixel_area`  (lines 240–250)

```
fn clear_sixel_area(writer: &mut impl Write, area: SixelClearArea) -> std::io::Result<()>
```

**Purpose**: This erases the terminal cells where a Sixel pet image was drawn. It does this by moving to each affected row and writing spaces across the image width.

**Data flow**: It receives a writer and a SixelClearArea. It creates a blank string as wide as the image, then for every row from the top clear row to the bottom clear row it moves the cursor and writes that blank string. It returns success or the terminal write error that stopped it.

**Call relations**: render_pet_image calls this before redrawing a Sixel image, when the Sixel image changes area, and when clearing a previously drawn Sixel pet. It uses terminal cursor commands so the old Sixel pixels do not remain on screen.

*Call graph*: called by 1 (render_pet_image); 2 external calls (queue!, write!).


##### `tests::ambient_pet_image_restores_cursor_after_drawing`  (lines 262–290)

```
fn ambient_pet_image_restores_cursor_after_drawing()
```

**Purpose**: This test proves that drawing an ambient Kitty pet saves the cursor position, moves to the pet, writes the image, and restores the cursor afterward. That matters because drawing the pet should not disrupt where the user is typing.

**Data flow**: It creates a temporary fake PNG file and a draw request, writes the render output into a memory buffer, then turns that buffer into text. It checks that the cursor-save command appears before the move command, the image payload appears after the move, and the cursor-restore command appears last.

**Call relations**: The test calls render_ambient_pet_image as a normal caller would. It verifies the shared renderer’s cursor behavior through the ambient pet wrapper.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (new, from_utf8, new, assert!, write, tempdir, default).


##### `tests::kitty_pet_image_clear_deletes_without_moving_cursor`  (lines 293–320)

```
fn kitty_pet_image_clear_deletes_without_moving_cursor()
```

**Purpose**: This test checks that clearing a Kitty pet sends a delete-image command without moving the cursor. Clearing should be invisible to the user’s cursor location.

**Data flow**: It first draws a fake Kitty pet into a buffer to set the render state. Then it clears the buffer and calls render_ambient_pet_image with no draw request. The resulting output is checked for a Kitty delete command and checked not to contain cursor save, move, or restore commands.

**Call relations**: The test calls render_ambient_pet_image twice: once to establish state and once to clear it. It confirms render_pet_image’s special no-request path for Kitty images.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (new, from_utf8, new, assert!, write, tempdir, default).


##### `tests::kitty_local_file_pet_image_uses_file_reference_without_inline_payload`  (lines 323–349)

```
fn kitty_local_file_pet_image_uses_file_reference_without_inline_payload()
```

**Purpose**: This test confirms that the Kitty local-file protocol sends a file reference instead of embedding the PNG bytes directly. That keeps the renderer’s behavior different for the two Kitty modes.

**Data flow**: It creates a fake PNG file and asks the renderer to draw it using KittyLocalFile. It reads the terminal output as text and checks for the delete/setup command, the move-to-position command, and the file-reference transmit command. It also checks that the base64 inline PNG payload is absent.

**Call relations**: The test reaches the behavior through render_ambient_pet_image. It exercises the render_pet_image branch that calls the Kitty local-file protocol helper.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (new, from_utf8, new, assert!, write, tempdir, default).


##### `tests::sixel_pet_image_clears_cell_area_before_redrawing`  (lines 352–380)

```
fn sixel_pet_image_clears_cell_area_before_redrawing()
```

**Purpose**: This test proves that drawing a Sixel pet first blanks the terminal cell area where the image will appear. That prevents old Sixel pixels from mixing with the new image.

**Data flow**: It creates a fake PNG, a fake precomputed Sixel frame file, and a Sixel draw request. It renders into a memory buffer, converts the output to text, and checks that blank rows are written before the image bytes and that the cursor is restored afterward.

**Call relations**: The test calls render_ambient_pet_image, which reaches render_pet_image’s Sixel branch. It indirectly checks both SixelClearArea::from and clear_sixel_area.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (from_utf8, new, assert!, create_dir, write, tempdir, default).


##### `tests::sixel_pet_image_clear_erases_last_drawn_area`  (lines 383–415)

```
fn sixel_pet_image_clear_erases_last_drawn_area()
```

**Purpose**: This test checks that clearing a previously drawn Sixel pet erases the remembered terminal area and does not send Kitty delete commands. Sixel cleanup must use spaces, not image IDs.

**Data flow**: It draws a fake Sixel pet once to store the last clear area in render state. Then it clears the output buffer and calls render_ambient_pet_image with no request. It checks that the output saves the cursor, writes blank rows over the old area, restores the cursor, and does not include the old image bytes or Kitty deletion text.

**Call relations**: The test uses render_ambient_pet_image for both draw and clear. It verifies render_pet_image’s remembered-state cleanup for Sixel images.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (from_utf8, new, assert!, create_dir, write, tempdir, default).


##### `tests::missing_frame_is_an_asset_error`  (lines 418–438)

```
fn missing_frame_is_an_asset_error()
```

**Purpose**: This test makes sure a missing image file is reported as an asset problem, not as a terminal writing problem. That distinction helps callers diagnose whether the pet files or the terminal output failed.

**Data flow**: It builds a draw request pointing to a PNG path that does not exist, renders into a memory buffer, and captures the error. It checks that the error is PetImageRenderError::Asset and that the original cause is still available.

**Call relations**: The test calls render_ambient_pet_image, which delegates to render_pet_image and then to the Kitty image helper. The missing file failure is expected to come back through the asset-error path.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 5 external calls (new, new, assert!, tempdir, default).


##### `tests::writer_failure_is_a_terminal_error`  (lines 441–467)

```
fn writer_failure_is_a_terminal_error()
```

**Purpose**: This test checks that failures while writing terminal commands are reported as terminal errors. It protects the boundary between broken output and broken pet assets.

**Data flow**: It defines a fake writer that always fails when written to, sets render state as if a Kitty image was previously drawn, and asks the renderer to clear it. The write failure is captured and checked to be PetImageRenderError::Terminal with a source error.

**Call relations**: The test calls render_ambient_pet_image with no request so render_pet_image tries to send a Kitty delete command. The fake writer forces the PetImageRenderError::from path to be used.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 2 external calls (default, assert!).
