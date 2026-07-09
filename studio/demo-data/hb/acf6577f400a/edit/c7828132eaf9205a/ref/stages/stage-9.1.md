# TUI startup, onboarding, and terminal ownership  `stage-9.1`

This stage is the “getting settled in” part of the terminal app. It runs before the main chat experience really begins, and it makes sure the program, the terminal window, and the user are all ready. Think of it like opening a cockpit, checking the switches, and asking a few setup questions before takeoff.

The top-level startup code in lib.rs and app.rs loads settings, connects to the background app-server, chooses terminal features, and starts the main screen. tui.rs, custom_terminal.rs, terminal_probe.rs, keyboard_modes.rs, terminal_stderr.rs, job_control.rs, notifications, terminal_title.rs, resize_reflow_cap.rs, and doctor/title.rs deal with “terminal ownership”: they test what the terminal can do, switch into the special full-screen mode, protect the display from stray output, support suspend/resume, and choose how titles and desktop alerts are sent.

Several prompts may appear before normal use: provider selection, hook review, update and model migration prompts, working-directory choice, external agent import, and session resume picking. The onboarding files guide first-time users through welcome, sign-in, and trusting the current folder. Chat widget startup helpers, tooltip selection, session history cards, collaboration mode choices, status previews, and pet setup prepare the first visible interface once startup is complete.

## Files in this stage

### Startup entry and bootstrap decisions
These files cover the top-level TUI entrypoint and the early startup prompts and preflight decisions made before the main interactive app fully takes over.

### `tui/src/lib.rs`

`entrypoint` · `startup through full application run and shutdown`

This file is the main driver for the TUI crate. It declares the crate’s module tree, re-exports selected public types, and then implements the startup pipeline from CLI invocation to `App::run`. A large part of the file is concerned with app-server selection and startup. `AppServerTarget` distinguishes embedded, implicit local-daemon, and explicit remote endpoints; helper functions parse remote addresses, decide whether a local daemon can be reused, initialize the state DB differently for embedded vs remote targets, and start either an in-process or remote app server.

`run_main` is the outer orchestration layer. It normalizes CLI flags, parses `-c` overrides, resolves `CODEX_HOME`, chooses the app-server target, loads bootstrap config and cloud config, computes final config overrides (including OSS provider/model selection), initializes telemetry/logging/state DB, validates exec-policy and login restrictions, and then hands off to `run_ratatui_app`. That inner function installs panic forwarding, initializes the terminal and `Tui`, optionally runs the update prompt, starts or reconnects the app server, runs onboarding if trust/login screens are needed, resolves resume/fork session selection and fallback cwd behavior, reloads config when onboarding or session selection changes it, applies the final syntax theme, decides alternate-screen mode, prefetches startup bootstrap/hooks review data, and finally calls `App::run`.

The file also owns terminal restoration via `TerminalRestoreGuard`, lightweight login-status detection, config-loading helpers that print and exit on fatal errors, and session lookup helpers that query the app server by id, name, or latest-updated thread with local/remote cwd filtering. The tests focus on these orchestration decisions rather than UI rendering.

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

**Purpose**: Starts an in-process app server using the standard embedded-client startup function.

**Data flow**: Accepts launch paths, config, overrides, cloud bundle, feedback, optional log/state DB handles, and an environment manager; forwards them unchanged into `start_embedded_app_server_with` together with `InProcessAppServerClient::start`, awaits the result, and returns an `InProcessAppServerClient`.

**Call relations**: Used by `start_app_server` for the embedded target and by tests that need a real in-process server.

*Call graph*: calls 1 internal fn (start_embedded_app_server_with); called by 2 (start_app_server, start_test_embedded_app_server).


##### `AppServerTarget::uses_remote_workspace`  (lines 268–270)

```
fn uses_remote_workspace(&self) -> bool
```

**Purpose**: Reports whether the selected app-server target implies a remote workspace model.

**Data flow**: Matches `self` and returns `true` only for `AppServerTarget::Remote { .. }`.

**Call relations**: Used throughout startup to decide cwd handling, environment loading, thread parameter mode, and onboarding/login behavior.

*Call graph*: called by 4 (thread_params_mode, config_cwd_for_app_server_target, run_ratatui_app, should_load_configured_environments); 1 external calls (matches!).


##### `AppServerTarget::thread_params_mode`  (lines 272–278)

```
fn thread_params_mode(&self) -> ThreadParamsMode
```

**Purpose**: Maps the app-server target to the thread-parameter mode expected by `AppServerSession`.

**Data flow**: Calls `uses_remote_workspace`; returns `ThreadParamsMode::Remote` for remote workspaces and `ThreadParamsMode::Embedded` otherwise.

**Call relations**: Used when wrapping started clients into `AppServerSession` values.

*Call graph*: calls 1 internal fn (uses_remote_workspace); called by 2 (run_ratatui_app, start_app_server_for_picker).


##### `init_state_db_for_app_server_target`  (lines 281–298)

```
async fn init_state_db_for_app_server_target(
    config: &Config,
    app_server_target: &AppServerTarget,
) -> std::io::Result<Option<StateDbHandle>>
```

**Purpose**: Initializes or retrieves the local state DB according to the chosen app-server target. Embedded startup gets stricter typed error wrapping so the CLI can surface recovery guidance.

**Data flow**: Reads `config` and `app_server_target`; for `Embedded`, awaits `state_db::try_init(config)`, wraps failures into `std::io::Error::other(LocalStateDbStartupError::new(...))` using either the corruption path or default state DB path, and returns `Some(StateDbHandle)` on success; for `LocalDaemon` and `Remote`, awaits `state_db::get_state_db(config)` and returns that optional handle.

**Call relations**: Called during startup and picker-specific embedded-server setup before app-server launch.

*Call graph*: calls 2 internal fn (get_state_db, try_init); called by 5 (run_main, start_embedded_app_server_for_picker, embedded_state_db_corruption_preserves_failed_database_for_cli_recovery, embedded_state_db_failure_is_typed_for_cli_recovery, start_test_embedded_app_server).


##### `remove_legacy_tui_log_file`  (lines 301–305)

```
fn remove_legacy_tui_log_file(codex_home: &Path)
```

**Purpose**: Best-effort cleanup for the old shared append-only TUI log file.

**Data flow**: Builds `codex_home/log/codex-tui.log` and calls `std::fs::remove_file`, ignoring any error.

**Call relations**: Run during startup after config load to prevent unbounded growth of the legacy log file.

*Call graph*: called by 2 (run_main, startup_removes_legacy_tui_log_file); 2 external calls (join, remove_file).


##### `remote_addr_has_explicit_port`  (lines 307–334)

```
fn remote_addr_has_explicit_port(addr: &str, parsed: &Url) -> bool
```

**Purpose**: Determines whether a parsed websocket URL string explicitly included a port, including explicit default ports like `:80` or `:443`.

**Data flow**: Reads the original address string and parsed `Url`, extracts host and authority components, checks `parsed.port()`, reconstructs the expected host representation (including IPv6 brackets), and compares the authority host:port text against the scheme’s default port when necessary.

**Call relations**: Used by `resolve_remote_addr` to reject websocket URLs that omit an explicit port.

*Call graph*: called by 1 (resolve_remote_addr); 4 external calls (host_str, port, scheme, format!).


##### `websocket_url_supports_auth_token`  (lines 336–344)

```
fn websocket_url_supports_auth_token(parsed: &Url) -> bool
```

**Purpose**: Checks whether a websocket endpoint is eligible for auth-token transport.

**Data flow**: Matches the parsed URL’s scheme and host; returns `true` for any `wss` host and for `ws` only when the host is localhost or a loopback IP, otherwise `false`.

**Call relations**: Used by `remote_addr_supports_auth_token` after parsing a websocket endpoint.

*Call graph*: 2 external calls (host, scheme).


##### `resolve_remote_addr`  (lines 346–383)

```
fn resolve_remote_addr(addr: &str) -> color_eyre::Result<RemoteAppServerEndpoint>
```

**Purpose**: Parses a user-supplied remote address string into a `RemoteAppServerEndpoint`, accepting websocket URLs with explicit ports and unix-socket forms.

**Data flow**: If the string starts with `unix://`, resolves either the default control socket path from `CODEX_HOME` or a relative/absolute socket path into `RemoteAppServerEndpoint::UnixSocket`; otherwise parses the string as `Url`, validates scheme/host/explicit-port/path/query/fragment constraints using `remote_addr_has_explicit_port`, and returns `RemoteAppServerEndpoint::WebSocket { websocket_url, auth_token: None }` or a descriptive error.

**Call relations**: Used by CLI-facing remote endpoint parsing and covered by address-validation tests.

*Call graph*: calls 2 internal fn (remote_addr_has_explicit_port, relative_to_current_dir); called by 1 (resolve_remote_addr_rejects_invalid_remote_addresses); 5 external calls (parse, app_server_control_socket_path, find_codex_home, bail!, matches!).


##### `remote_addr_supports_auth_token`  (lines 385–392)

```
fn remote_addr_supports_auth_token(endpoint: &RemoteAppServerEndpoint) -> bool
```

**Purpose**: Reports whether a resolved remote endpoint can carry an auth token.

**Data flow**: Matches the endpoint; for websocket endpoints parses the stored URL and returns whether `websocket_url_supports_auth_token` accepts it, and for unix sockets returns `false`.

**Call relations**: Used by higher-level remote connection logic outside this file.

*Call graph*: 1 external calls (parse).


##### `connect_remote_app_server`  (lines 394–408)

```
async fn connect_remote_app_server(
    endpoint: RemoteAppServerEndpoint,
) -> color_eyre::Result<AppServerClient>
```

**Purpose**: Connects to a remote app server over the resolved endpoint and wraps it in the generic `AppServerClient` enum.

**Data flow**: Builds `RemoteAppServerConnectArgs` with endpoint, client name/version, experimental API flag, empty opt-out notifications, and default channel capacity; awaits `RemoteAppServerClient::connect`; wraps connection errors with context; and returns `AppServerClient::Remote` on success.

**Call relations**: Called by `start_app_server` for both explicit remote and local-daemon targets.

*Call graph*: calls 1 internal fn (connect); called by 1 (start_app_server); 3 external calls (new, Remote, env!).


##### `maybe_probe_default_daemon_socket`  (lines 440–442)

```
async fn maybe_probe_default_daemon_socket(_codex_home: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: On Unix, probes the default local daemon control socket quickly to see whether an implicit local daemon can be reused.

**Data flow**: Resolves the default socket path from `codex_home`, returns `None` if the path does not exist, otherwise attempts a timed `tokio::net::UnixStream::connect` using `AUTO_CONNECT_DAEMON_CONNECT_TIMEOUT`; returns `Some(socket_path)` on success and logs debug messages before returning `None` on connection failure or timeout.

**Call relations**: Used by `run_main` only when no explicit remote endpoint is given and launch settings are replayable enough to reuse a daemon.

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

**Purpose**: Starts the appropriate app-server client for the selected target.

**Data flow**: Matches `target`; for `Embedded`, awaits `start_embedded_app_server(...)` and wraps the result as `AppServerClient::InProcess`; for `LocalDaemon` and `Remote`, clones the endpoint and awaits `connect_remote_app_server`.

**Call relations**: This is the common app-server startup entry used by both the main app flow and picker-specific startup.

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

**Purpose**: Starts an app server and immediately wraps it in an `AppServerSession` configured for picker use.

**Data flow**: Calls `start_app_server` with default arg0 paths, cloned config, empty CLI overrides, default loader overrides, non-strict config, default cloud bundle, fresh feedback, no log DB, the provided state DB, and the provided environment manager; then constructs and returns `AppServerSession::new(app_server, target.thread_params_mode())`.

**Call relations**: Used by picker flows that need a temporary app-server session outside the full app startup path.

*Call graph*: calls 5 internal fn (default, new, thread_params_mode, new, start_app_server); called by 1 (start_embedded_app_server_for_picker); 4 external calls (new, clone, default, default).


##### `start_embedded_app_server_for_picker`  (lines 506–517)

```
async fn start_embedded_app_server_for_picker(
    config: &Config,
) -> color_eyre::Result<AppServerSession>
```

**Purpose**: Test-only helper that initializes state DB and starts an embedded picker session with a default test environment manager.

**Data flow**: Initializes state DB for the embedded target, constructs `Arc<EnvironmentManager::default_for_tests()>`, and delegates to `start_app_server_for_picker` with `AppServerTarget::Embedded`.

**Call relations**: Used by tests that need a picker-scoped embedded app server.

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

**Purpose**: Generic embedded app-server startup wrapper that prepares `InProcessClientStartArgs` and delegates to an injected start function. It exists so tests can simulate startup failures.

**Data flow**: Builds `config_warnings` from `config.startup_warnings`, constructs `InProcessClientStartArgs` with config, overrides, cloud bundle, feedback, optional DB handles, environment manager, serialized `session_source`, client metadata, and channel capacity, awaits the injected `start_client` future, wraps any I/O error with `failed to start embedded app server`, and returns the started client.

**Call relations**: Called by `start_embedded_app_server` in production and directly by a failure-injection test.

*Call graph*: called by 2 (start_embedded_app_server, embedded_app_server_start_failure_is_returned); 5 external calls (new, new, env!, from_value, json!).


##### `shutdown_app_server_if_present`  (lines 573–579)

```
async fn shutdown_app_server_if_present(app_server: Option<AppServerSession>)
```

**Purpose**: Best-effort async shutdown for an optional temporary app-server session.

**Data flow**: If the `Option<AppServerSession>` is `Some`, awaits `shutdown()` and logs a warning if shutdown fails; otherwise does nothing.

**Call relations**: Used in early-return branches of `run_ratatui_app` when onboarding or missing-session handling exits before the main app loop.

*Call graph*: called by 1 (run_ratatui_app); 1 external calls (warn!).


##### `session_target_from_app_server_thread`  (lines 581–598)

```
fn session_target_from_app_server_thread(
    thread: AppServerThread,
) -> Option<resume_picker::SessionTarget>
```

**Purpose**: Converts an app-server `Thread` record into the resume-picker’s `SessionTarget`, dropping invalid thread ids.

**Data flow**: Attempts `ThreadId::from_string(&thread.id)`; on success returns `Some(SessionTarget { path: thread.path, thread_id })`, and on failure logs a warning and returns `None`.

**Call relations**: Used by all session lookup helpers after `thread/list` or `thread/read` responses.

*Call graph*: calls 1 internal fn (from_string); called by 2 (lookup_session_target_by_name_with_app_server, lookup_session_target_with_app_server); 1 external calls (warn!).


##### `resume_source_kinds`  (lines 600–609)

```
fn resume_source_kinds(include_non_interactive: bool) -> Vec<ThreadSourceKind>
```

**Purpose**: Builds the list of thread source kinds that should be considered resumable.

**Data flow**: Starts with `Cli` and `VsCode`; if `include_non_interactive` is true, extends the vector with `Exec` and `AppServer`; returns the resulting `Vec<ThreadSourceKind>`.

**Call relations**: Used by `latest_session_lookup_params` to populate `source_kinds`.

*Call graph*: called by 1 (latest_session_lookup_params); 1 external calls (vec!).


##### `lookup_session_target_by_name_with_app_server`  (lines 611–644)

```
async fn lookup_session_target_by_name_with_app_server(
    app_server: &mut AppServerSession,
    name: &str,
) -> color_eyre::Result<Option<resume_picker::SessionTarget>>
```

**Purpose**: Searches app-server threads by exact saved session name using paginated `thread/list` requests.

**Data flow**: Loops with a `cursor`, requesting up to 100 threads sorted by update time, filtered to interactive source kinds and `search_term = Some(name)`, scans each page for a thread whose `name` exactly matches, converts it with `session_target_from_app_server_thread`, and continues until `next_cursor` is `None` or a match is found.

**Call relations**: Used by `lookup_session_target_with_app_server` for non-UUID identifiers and covered by a backend-title-search test.

*Call graph*: calls 2 internal fn (thread_list, session_target_from_app_server_thread); called by 2 (lookup_session_target_with_app_server, lookup_session_target_by_name_uses_backend_title_search); 1 external calls (vec!).


##### `lookup_session_target_with_app_server`  (lines 646–679)

```
async fn lookup_session_target_with_app_server(
    app_server: &mut AppServerSession,
    id_or_name: &str,
) -> color_eyre::Result<Option<resume_picker::SessionTarget>>
```

**Purpose**: Resolves a user-supplied session identifier that may be either a UUID-like thread id or a saved session name.

**Data flow**: If `Uuid::parse_str(id_or_name)` succeeds, attempts `ThreadId::from_string`, then calls `thread_read(thread_id, false)` and converts the result with `session_target_from_app_server_thread`, logging and returning `Ok(None)` on parse or read failure; otherwise delegates to `lookup_session_target_by_name_with_app_server`.

**Call relations**: Used by `run_ratatui_app` for `--resume <id>` and `--fork <id>` flows.

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

**Purpose**: Finds the latest resumable session, first using state-DB-only lookup and then falling back to scan-and-repair if needed.

**Data flow**: Reads whether the session uses a remote workspace, iterates over `LatestSessionLookupMode::StateDbOnly` and `ScanAndRepair`, requests one thread via `thread_list(latest_session_lookup_params(...))`, converts the first valid thread with `session_target_from_app_server_thread`, and returns it only if the path exists for local workspaces or unconditionally for remote workspaces.

**Call relations**: Used by `run_ratatui_app` for `--resume-last` and `--fork-last`, and by tests covering fallback behavior.

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

**Purpose**: Builds the exact `thread/list` request used for latest-session lookup under local or remote workspace rules.

**Data flow**: Constructs `ThreadListParams` with `limit = 1`, updated-at sorting, `model_providers = None` for remote workspaces or the current provider for local ones, `source_kinds` from `resume_source_kinds`, archived false, optional cwd filter converted to `ThreadListCwdFilter::One`, `use_state_db_only` based on `lookup_mode`, and no search term.

**Call relations**: Used only by `lookup_latest_session_target_with_app_server` and heavily covered by tests.

*Call graph*: calls 1 internal fn (resume_source_kinds); called by 6 (lookup_latest_session_target_with_app_server, latest_session_lookup_params_can_include_non_interactive_sources, latest_session_lookup_params_keep_explicit_cwd_filter_for_remote_sessions, latest_session_lookup_params_keep_local_filters_for_embedded_sessions, latest_session_lookup_params_keep_local_filters_for_local_daemon_sessions, latest_session_lookup_params_omit_local_filters_for_remote_sessions); 1 external calls (vec!).


##### `config_cwd_for_app_server_target`  (lines 749–769)

```
fn config_cwd_for_app_server_target(
    cwd: Option<&Path>,
    app_server_target: &AppServerTarget,
    environment_manager: &EnvironmentManager,
) -> std::io::Result<Option<AbsolutePathBuf>>
```

**Purpose**: Determines the cwd that should be used while loading config, omitting local cwd resolution when the workspace or exec environment is remote.

**Data flow**: If `app_server_target.uses_remote_workspace()` or the environment manager’s default environment is remote, returns `Ok(None)`; otherwise canonicalizes the provided cwd or current directory with symlink preservation, wraps it in `AbsolutePathBuf`, and returns `Ok(Some(cwd))`.

**Call relations**: Used by `run_main` before bootstrap config loading so config resolution uses the correct local project directory.

*Call graph*: calls 4 internal fn (default_environment, uses_remote_workspace, current_dir, from_absolute_path); called by 6 (run_main, config_cwd_for_app_server_target_canonicalizes_embedded_cli_cwd, config_cwd_for_app_server_target_canonicalizes_local_daemon_cli_cwd, config_cwd_for_app_server_target_errors_for_missing_embedded_cli_cwd, config_cwd_for_app_server_target_omits_cwd_for_remote_exec_server, config_cwd_for_app_server_target_omits_cwd_for_remote_sessions); 1 external calls (canonicalize_existing_preserving_symlinks).


##### `should_load_configured_environments`  (lines 771–776)

```
fn should_load_configured_environments(
    loader_overrides: &LoaderOverrides,
    app_server_target: &AppServerTarget,
) -> bool
```

**Purpose**: Decides whether startup should load configured environments from `CODEX_HOME` rather than just the process environment.

**Data flow**: Returns `true` only when `loader_overrides.ignore_user_config` is false and the app-server target does not use a remote workspace.

**Call relations**: Used by `run_main` when constructing the `EnvironmentManager`.

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

**Purpose**: Chooses the cwd filter to apply when looking up the latest session, respecting `show_all` and remote-workspace overrides.

**Data flow**: Returns `None` when `show_all` is true; otherwise returns `remote_cwd_override` for remote workspaces or `Some(config.cwd.as_path())` for local ones.

**Call relations**: Used by `run_ratatui_app` before latest-session lookup for resume/fork flows.

*Call graph*: called by 3 (run_ratatui_app, fork_last_filters_latest_session_by_cwd_unless_show_all, latest_session_cwd_filter_respects_scope_options).


##### `app_server_target_for_launch`  (lines 795–811)

```
fn app_server_target_for_launch(
    explicit_remote_endpoint: Option<RemoteAppServerEndpoint>,
    default_daemon_socket: Option<AbsolutePathBuf>,
    can_reuse_implicit_local_daemon: bool,
) -> AppS
```

**Purpose**: Chooses the launch target from explicit remote settings, an implicitly reusable local daemon socket, and replayability constraints.

**Data flow**: If `explicit_remote_endpoint` is present, returns `AppServerTarget::Remote`; else if implicit local-daemon reuse is allowed, returns `LocalDaemon` when a default socket path exists or `Embedded` otherwise; else returns `Embedded`.

**Call relations**: Used by `run_main` after probing daemon availability and replayability.

*Call graph*: called by 4 (run_main, app_server_target_for_launch_prefers_explicit_remote_endpoint, app_server_target_for_launch_skips_local_daemon_when_launch_config_is_not_replayable, app_server_target_for_launch_uses_local_daemon_for_default_socket).


##### `loader_overrides_are_default`  (lines 813–829)

```
fn loader_overrides_are_default(loader_overrides: &LoaderOverrides) -> bool
```

**Purpose**: Checks whether `LoaderOverrides` is still at its default replayable state.

**Data flow**: Reads every relevant field of `loader_overrides`, including platform-specific ones, and returns `true` only when no custom paths or ignore flags are set.

**Call relations**: Used by `can_reuse_implicit_local_daemon` to decide whether a daemon can safely be reused.

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

**Purpose**: Determines whether this invocation’s launch configuration is replayable enough to reuse an already-running implicit local daemon.

**Data flow**: Returns `true` only when CLI key/value overrides are empty, `loader_overrides_are_default(loader_overrides)` is true, `strict_config` is false, and there are no non-replayable launch overrides.

**Call relations**: Used by `run_main` before probing or selecting an implicit local daemon.

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

**Purpose**: Top-level async startup entrypoint for the TUI. It parses and normalizes CLI/config state, chooses the app-server target, initializes telemetry/logging/state, enforces startup constraints, and then launches the ratatui app.

**Data flow**: Mutates `cli` to normalize legacy flags and derive sandbox/approval overrides; parses raw `-c` overrides; resolves `CODEX_HOME`; applies profile-v2 loader overrides; decides whether an implicit local daemon can be reused and probes it; chooses `AppServerTarget`; builds runtime paths and an `EnvironmentManager`; computes config cwd; loads bootstrap config and cloud config bundle; resolves OSS provider/model selection and config overrides; loads full config; removes the legacy log file; initializes OTEL, state DB, migrations, exec-policy checks, login restrictions, file logging, feedback/log DB layers, and provider readiness; then calls `run_ratatui_app` and maps any error into `std::io::Error`.

**Call relations**: This is the crate’s main orchestration function, called by the binary layer to start the TUI.

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

**Purpose**: Runs the interactive TUI after startup prerequisites are ready. It owns terminal initialization/restoration, onboarding, session selection, final config reloads, app-server startup/reuse, startup hook review, and the final `App::run` call.

**Data flow**: Installs color-eyre and panic forwarding, initializes the terminal and `Tui`, creates a `TerminalRestoreGuard`, optionally runs the update prompt, initializes session logging, starts or reconnects the app server, persists manually selected OSS provider if needed, computes onboarding/login/trust decisions, may run onboarding and reload config/cloud bundle, resolves resume/fork session selection and fallback cwd, may reload config again with fallback cwd, applies final syntax theme and residency settings, decides alternate-screen mode, ensures an app server exists, prefetches bootstrap and startup-hooks review data, may run the startup hooks review UI, then awaits `App::run`; on exit or error it restores the terminal silently and logs session end.

**Call relations**: Called only by `run_main`; it is the main runtime driver immediately before entering the application event loop.

*Call graph*: calls 29 internal fn (set_default_client_residency_requirement, thread_params_mode, uses_remote_workspace, new, new, write_config_batch, determine_alt_screen_mode, get_login_status, latest_session_cwd_filter, load_config_or_exit (+15 more)); called by 1 (run_main); 26 external calls (new, now, auth_keyring_backend_kind, clone, clone, run, cloud_config_bundle_loader_for_storage, find_codex_home, install, clone (+15 more)).


##### `restore`  (lines 1801–1807)

```
fn restore()
```

**Purpose**: Restores the terminal after the TUI exits and prints a recovery message to stderr if restoration fails.

**Data flow**: Calls `tui::restore_after_exit()` and, on error, prints a user-facing recovery instruction to stderr.

**Call relations**: Used by `TerminalRestoreGuard::restore_silently` as the non-fallible restoration path.

*Call graph*: calls 1 internal fn (restore_after_exit); called by 1 (restore_silently); 1 external calls (eprintln!).


##### `TerminalRestoreGuard::new`  (lines 1814–1816)

```
fn new() -> Self
```

**Purpose**: Creates a guard that will restore the terminal on drop unless restoration has already happened.

**Data flow**: Returns `TerminalRestoreGuard { active: true }`.

**Call relations**: Constructed in `run_ratatui_app` immediately after terminal initialization.

*Call graph*: called by 1 (run_ratatui_app).


##### `TerminalRestoreGuard::restore`  (lines 1819–1825)

```
fn restore(&mut self) -> color_eyre::Result<()>
```

**Purpose**: Performs terminal restoration once and marks the guard inactive, propagating restoration errors.

**Data flow**: If `active` is true, calls `crate::tui::restore_after_exit()?`, sets `active = false`, and returns `Ok(())`; otherwise returns `Ok(())` without doing anything.

**Call relations**: Used in branches where the caller wants restoration failures surfaced explicitly.

*Call graph*: calls 1 internal fn (restore_after_exit).


##### `TerminalRestoreGuard::restore_silently`  (lines 1827–1832)

```
fn restore_silently(&mut self)
```

**Purpose**: Performs terminal restoration once using the non-fallible helper and suppresses any restoration error.

**Data flow**: If `active` is true, calls `restore()`, then sets `active = false`.

**Call relations**: Used by `Drop` and by many early-return/error branches in `run_ratatui_app`.

*Call graph*: calls 1 internal fn (restore); called by 1 (drop).


##### `TerminalRestoreGuard::drop`  (lines 1836–1838)

```
fn drop(&mut self)
```

**Purpose**: Ensures the terminal is restored if the guard goes out of scope while still active.

**Data flow**: Calls `self.restore_silently()` during drop.

**Call relations**: Provides the final safety net for terminal cleanup.

*Call graph*: calls 1 internal fn (restore_silently).


##### `determine_alt_screen_mode`  (lines 1848–1854)

```
fn determine_alt_screen_mode(no_alt_screen: bool, tui_alternate_screen: AltScreenMode) -> bool
```

**Purpose**: Decides whether the TUI should use the terminal’s alternate screen buffer.

**Data flow**: Returns `false` immediately when `no_alt_screen` is true; otherwise returns whether `tui_alternate_screen != AltScreenMode::Never`.

**Call relations**: Used by `run_ratatui_app` after final config resolution to configure the `Tui`.

*Call graph*: called by 1 (run_ratatui_app).


##### `get_login_status`  (lines 1865–1880)

```
async fn get_login_status(
    app_server: &mut AppServerSession,
    config: &Config,
) -> color_eyre::Result<LoginStatus>
```

**Purpose**: Performs a lightweight account read to determine whether the current provider is authenticated and, if so, by which auth mode.

**Data flow**: If `config.model_provider.requires_openai_auth` is false, returns `LoginStatus::NotAuthenticated`; otherwise awaits `app_server.read_account()`, inspects `account.account`, and maps API-key and ChatGPT accounts to `LoginStatus::AuthMode(...)`, treating Bedrock and `None` as not authenticated.

**Call relations**: Used by `run_ratatui_app` to decide whether onboarding should include the login screen.

*Call graph*: calls 1 internal fn (read_account); called by 1 (run_ratatui_app); 1 external calls (AuthMode).


##### `load_config_or_exit`  (lines 1882–1898)

```
async fn load_config_or_exit(
    cli_kv_overrides: Vec<(String, toml::Value)>,
    overrides: ConfigOverrides,
    loader_overrides: LoaderOverrides,
    cloud_config_bundle: CloudConfigBundleLoader,
```

**Purpose**: Loads full config and exits the process on failure, using no fallback cwd.

**Data flow**: Delegates to `load_config_or_exit_with_fallback_cwd(..., None)` and returns the resulting `Config`.

**Call relations**: Used by `run_main` and `run_ratatui_app` whenever config must be rebuilt.

*Call graph*: calls 1 internal fn (load_config_or_exit_with_fallback_cwd); called by 2 (run_main, run_ratatui_app).


##### `load_config_or_exit_with_fallback_cwd`  (lines 1900–1925)

```
async fn load_config_or_exit_with_fallback_cwd(
    cli_kv_overrides: Vec<(String, toml::Value)>,
    overrides: ConfigOverrides,
    loader_overrides: LoaderOverrides,
    cloud_config_bundle: CloudC
```

**Purpose**: Builds full config with optional fallback cwd and terminates the process on failure.

**Data flow**: Constructs a `ConfigBuilder` with CLI overrides, harness overrides, loader overrides, strict-config flag, cloud bundle, and optional fallback cwd; awaits `build()`; returns the `Config` on success or prints an error and exits the process on failure.

**Call relations**: Used by `load_config_or_exit` and directly by `run_ratatui_app` when resume/fork selection changes cwd semantics.

*Call graph*: called by 2 (load_config_or_exit, run_ratatui_app); 3 external calls (default, eprintln!, exit).


##### `load_bootstrap_config_or_exit`  (lines 1928–1965)

```
async fn load_bootstrap_config_or_exit(
    codex_home: &Path,
    cwd: Option<&AbsolutePathBuf>,
    cli_kv_overrides: Vec<(String, codex_config::TomlValue)>,
    loader_overrides: LoaderOverrides,
```

**Purpose**: Loads the bootstrap `config.toml` layer stack needed before full config construction and exits on failure with source-aware diagnostics when possible.

**Data flow**: Calls `load_config_toml_with_layer_stack` with `codex_home`, optional cwd, CLI overrides, and `ConfigLoadOptions`; on success returns `ConfigTomlLoadResult`; on failure tries to extract a `ConfigLoadError` for formatted source diagnostics, prints the error, and exits the process.

**Call relations**: Used by `run_main` before cloud-config and full-config resolution.

*Call graph*: calls 1 internal fn (load_config_toml_with_layer_stack); called by 1 (run_main); 2 external calls (eprintln!, exit).


##### `should_show_trust_screen`  (lines 1968–1970)

```
fn should_show_trust_screen(config: &Config) -> bool
```

**Purpose**: Determines whether onboarding should include the directory trust decision screen.

**Data flow**: Returns whether `config.active_project.trust_level.is_none()`.

**Call relations**: Used by `run_ratatui_app` and covered by trust-related tests.

*Call graph*: called by 4 (run_ratatui_app, untrusted_project_skips_trust_prompt, windows_shows_trust_prompt_with_sandbox, windows_shows_trust_prompt_without_sandbox).


##### `should_show_onboarding`  (lines 1972–1982)

```
fn should_show_onboarding(
    login_status: LoginStatus,
    config: &Config,
    show_trust_screen: bool,
) -> bool
```

**Purpose**: Determines whether any onboarding UI should run at startup.

**Data flow**: Returns `true` immediately if `show_trust_screen` is true; otherwise delegates to `should_show_login_screen(login_status, config)`.

**Call relations**: Used by `run_ratatui_app` after login-status detection.

*Call graph*: calls 1 internal fn (should_show_login_screen); called by 1 (run_ratatui_app).


##### `should_show_login_screen`  (lines 1984–1992)

```
fn should_show_login_screen(login_status: LoginStatus, config: &Config) -> bool
```

**Purpose**: Determines whether onboarding should include the login screen for the current provider.

**Data flow**: Returns `false` when the model provider does not require OpenAI auth; otherwise returns whether `login_status == LoginStatus::NotAuthenticated`.

**Call relations**: Used by `should_show_onboarding` and directly by `run_ratatui_app` when constructing onboarding arguments.

*Call graph*: called by 2 (run_ratatui_app, should_show_onboarding).


##### `tests::build_config`  (lines 2009–2014)

```
async fn build_config(temp_dir: &TempDir) -> std::io::Result<Config>
```

**Purpose**: Creates a minimal test `Config` rooted at a temporary directory.

**Data flow**: Builds a `ConfigBuilder`, sets `codex_home` to the temp dir path, awaits `build()`, and returns the resulting config.

**Call relations**: Shared by many startup and session-lookup tests.

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

**Purpose**: Creates a synthetic rollout file and metadata suitable for session lookup tests.

**Data flow**: Generates a UUID/thread id, constructs the dated rollout path under `codex_home/sessions`, writes JSONL lines for session metadata and user preview content, sets the file modification time from the provided RFC3339 timestamp, and returns the `ThreadId`.

**Call relations**: Used by latest-session and fork/resume lookup tests.

*Call graph*: calls 1 internal fn (from_string); 12 external calls (default, join, to_path_buf, new_v4, parse_from_rfc3339, format!, json!, to_value, new, new (+2 more)).


##### `tests::startup_removes_legacy_tui_log_file`  (lines 2096–2107)

```
fn startup_removes_legacy_tui_log_file() -> std::io::Result<()>
```

**Purpose**: Verifies startup cleanup deletes the old shared TUI log file.

**Data flow**: Creates a temp `log/codex-tui.log`, calls `remove_legacy_tui_log_file`, and asserts the file no longer exists.

**Call relations**: Direct test of the legacy-log cleanup helper.

*Call graph*: calls 1 internal fn (remove_legacy_tui_log_file); 4 external calls (new, assert!, create_dir_all, write).


##### `tests::start_test_embedded_app_server`  (lines 2109–2127)

```
async fn start_test_embedded_app_server(
        config: Config,
    ) -> color_eyre::Result<InProcessAppServerClient>
```

**Purpose**: Starts a real embedded app server for tests using default launch settings and a test environment manager.

**Data flow**: Initializes state DB for the embedded target, then delegates to `start_embedded_app_server` with default arg0 paths, empty overrides, default loader/cloud settings, fresh feedback, no log DB, and `EnvironmentManager::default_for_tests()`.

**Call relations**: Shared by embedded app-server and session-lookup tests.

*Call graph*: calls 5 internal fn (default, default_for_tests, new, init_state_db_for_app_server_target, start_embedded_app_server); 4 external calls (new, new, default, default).


##### `tests::alternate_screen_auto_uses_alt_screen`  (lines 2130–2147)

```
fn alternate_screen_auto_uses_alt_screen()
```

**Purpose**: Checks the alternate-screen decision matrix for `Auto`, `Always`, `Never`, and `--no-alt-screen`.

**Data flow**: Calls `determine_alt_screen_mode` with several combinations and asserts the expected booleans.

**Call relations**: Direct unit test for alternate-screen selection.

*Call graph*: 1 external calls (assert!).


##### `tests::session_target_display_label_falls_back_to_thread_id`  (lines 2150–2158)

```
fn session_target_display_label_falls_back_to_thread_id()
```

**Purpose**: Verifies a session target without a path still has a usable display label.

**Data flow**: Constructs a `SessionTarget` with `path: None`, calls its display-label method, and compares the result to `thread <id>`.

**Call relations**: Covers resume-picker display behavior indirectly.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


##### `tests::resolve_remote_addr_accepts_websocket_url`  (lines 2161–2169)

```
fn resolve_remote_addr_accepts_websocket_url()
```

**Purpose**: Checks that a valid `ws://host:port` address parses and normalizes correctly.

**Data flow**: Calls `resolve_remote_addr("ws://127.0.0.1:4500")` and compares the result to the expected websocket endpoint with trailing slash and no auth token.

**Call relations**: Parser acceptance test for websocket endpoints.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_remote_addr_accepts_secure_websocket_url`  (lines 2172–2180)

```
fn resolve_remote_addr_accepts_secure_websocket_url()
```

**Purpose**: Checks that a valid `wss://host:port` address parses and normalizes correctly.

**Data flow**: Calls `resolve_remote_addr("wss://example.com:443")` and compares the result to the expected normalized websocket endpoint.

**Call relations**: Parser acceptance test for secure websocket endpoints.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_remote_addr_accepts_default_socket`  (lines 2183–2192)

```
fn resolve_remote_addr_accepts_default_socket() -> color_eyre::Result<()>
```

**Purpose**: Checks that `unix://` resolves to the default control socket path under `CODEX_HOME`.

**Data flow**: Finds `CODEX_HOME`, calls `resolve_remote_addr("unix://")`, and compares the result to the expected unix-socket endpoint.

**Call relations**: Parser acceptance test for the default unix-socket form.

*Call graph*: 2 external calls (assert_eq!, find_codex_home).


##### `tests::resolve_remote_addr_accepts_relative_socket_path`  (lines 2195–2203)

```
fn resolve_remote_addr_accepts_relative_socket_path() -> color_eyre::Result<()>
```

**Purpose**: Checks that `unix://relative-path` resolves relative to the current directory.

**Data flow**: Calls `resolve_remote_addr("unix://codex.sock")` and compares the result to the expected `AbsolutePathBuf::relative_to_current_dir` endpoint.

**Call relations**: Parser acceptance test for relative unix-socket paths.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::resolve_remote_addr_accepts_absolute_socket_path`  (lines 2206–2216)

```
fn resolve_remote_addr_accepts_absolute_socket_path() -> color_eyre::Result<()>
```

**Purpose**: Checks that `unix://<absolute-path>` resolves to the expected absolute unix-socket endpoint.

**Data flow**: Creates a temp absolute path, formats it into a `unix://` URL, resolves it, and compares the result to the expected endpoint.

**Call relations**: Parser acceptance test for absolute unix-socket paths.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::resolve_remote_addr_rejects_invalid_remote_addresses`  (lines 2219–2231)

```
fn resolve_remote_addr_rejects_invalid_remote_addresses()
```

**Purpose**: Ensures malformed or unsupported remote address forms are rejected with the documented error message.

**Data flow**: Iterates over several invalid address strings, calls `resolve_remote_addr`, expects errors, and checks each error string for the expected guidance.

**Call relations**: Negative parser coverage for remote address validation.

*Call graph*: calls 1 internal fn (resolve_remote_addr); 1 external calls (assert!).


##### `tests::default_daemon_auto_connect_skips_missing_socket`  (lines 2234–2242)

```
async fn default_daemon_auto_connect_skips_missing_socket() -> color_eyre::Result<()>
```

**Purpose**: Checks that probing for an implicit local daemon returns `None` when the default socket path does not exist.

**Data flow**: Creates a temp `codex_home`, calls `maybe_probe_default_daemon_socket`, and asserts the result is `None`.

**Call relations**: Covers the missing-socket branch of daemon probing.

*Call graph*: 2 external calls (new, assert!).


##### `tests::default_daemon_auto_connect_probes_socket_only`  (lines 2246–2258)

```
async fn default_daemon_auto_connect_probes_socket_only() -> color_eyre::Result<()>
```

**Purpose**: Checks that daemon probing succeeds when a unix listener is bound at the default socket path.

**Data flow**: Creates the socket parent directory, binds a `UnixListener` at the default control socket path, calls `maybe_probe_default_daemon_socket`, and compares the result to `Some(socket_path)`.

**Call relations**: Positive coverage for daemon probing.

*Call graph*: calls 1 internal fn (bind); 4 external calls (new, assert_eq!, app_server_control_socket_path, create_dir_all).


##### `tests::app_server_target_for_launch_uses_local_daemon_for_default_socket`  (lines 2261–2279)

```
fn app_server_target_for_launch_uses_local_daemon_for_default_socket() -> color_eyre::Result<()>
```

**Purpose**: Verifies that an available default socket yields `LocalDaemon` when implicit reuse is allowed.

**Data flow**: Builds a relative socket path, calls `app_server_target_for_launch(None, Some(socket_path), true)`, and asserts the target variant plus workspace/thread-mode behavior.

**Call relations**: Covers target selection for implicit local-daemon reuse.

*Call graph*: calls 2 internal fn (app_server_target_for_launch, relative_to_current_dir); 2 external calls (assert!, assert_eq!).


##### `tests::app_server_target_for_launch_prefers_explicit_remote_endpoint`  (lines 2282–2301)

```
fn app_server_target_for_launch_prefers_explicit_remote_endpoint() -> color_eyre::Result<()>
```

**Purpose**: Ensures an explicit remote endpoint wins over any default daemon socket.

**Data flow**: Builds explicit and default socket endpoints, calls `app_server_target_for_launch(Some(explicit), Some(default), false)`, and asserts the result is `Remote` with remote workspace/thread mode.

**Call relations**: Covers precedence in target selection.

*Call graph*: calls 2 internal fn (app_server_target_for_launch, relative_to_current_dir); 2 external calls (assert!, assert_eq!).


##### `tests::app_server_target_for_launch_skips_local_daemon_when_launch_config_is_not_replayable`  (lines 2304–2315)

```
fn app_server_target_for_launch_skips_local_daemon_when_launch_config_is_not_replayable() -> color_eyre::Result<()>
```

**Purpose**: Ensures implicit local-daemon reuse is skipped when launch settings are not replayable.

**Data flow**: Calls `app_server_target_for_launch(None, Some(socket_path), false)` and asserts the result is `Embedded`.

**Call relations**: Covers the replayability gate in target selection.

*Call graph*: calls 2 internal fn (app_server_target_for_launch, relative_to_current_dir); 1 external calls (assert_eq!).


##### `tests::can_reuse_implicit_local_daemon_requires_default_launch_config`  (lines 2318–2354)

```
fn can_reuse_implicit_local_daemon_requires_default_launch_config() -> color_eyre::Result<()>
```

**Purpose**: Checks the exact conditions under which implicit local-daemon reuse is allowed.

**Data flow**: Builds several combinations of CLI overrides, loader overrides, strict-config flag, and non-replayable launch overrides, calls `can_reuse_implicit_local_daemon`, and asserts the expected booleans.

**Call relations**: Direct unit test for daemon-reuse eligibility.

*Call graph*: 3 external calls (assert!, default, vec!).


##### `tests::should_load_configured_environments_for_local_daemon`  (lines 2357–2369)

```
fn should_load_configured_environments_for_local_daemon() -> color_eyre::Result<()>
```

**Purpose**: Verifies that configured environments are still loaded for a local-daemon target when user config is not ignored.

**Data flow**: Constructs a `LocalDaemon` target, calls `should_load_configured_environments` with default loader overrides, and asserts `true`.

**Call relations**: Covers environment-loading policy.

*Call graph*: calls 1 internal fn (relative_to_current_dir); 1 external calls (assert!).


##### `tests::latest_session_lookup_params_keep_local_filters_for_embedded_sessions`  (lines 2372–2405)

```
async fn latest_session_lookup_params_keep_local_filters_for_embedded_sessions() -> std::io::Result<()>
```

**Purpose**: Checks that latest-session lookup for embedded sessions keeps local model-provider and cwd filters and toggles `use_state_db_only` by lookup mode.

**Data flow**: Builds a test config and cwd, calls `latest_session_lookup_params` for both lookup modes, and compares `model_providers`, `cwd`, and `use_state_db_only` fields.

**Call relations**: Direct coverage for local latest-session query construction.

*Call graph*: calls 1 internal fn (latest_session_lookup_params); 4 external calls (new, assert!, assert_eq!, build_config).


##### `tests::latest_session_lookup_params_keep_local_filters_for_local_daemon_sessions`  (lines 2408–2433)

```
async fn latest_session_lookup_params_keep_local_filters_for_local_daemon_sessions() -> color_eyre::Result<()>
```

**Purpose**: Checks that local-daemon sessions use the same local filters as embedded sessions.

**Data flow**: Builds a local-daemon target and config, calls `latest_session_lookup_params`, and compares `model_providers` and `cwd` to expected local values.

**Call relations**: Covers local-daemon query construction.

*Call graph*: calls 2 internal fn (latest_session_lookup_params, relative_to_current_dir); 3 external calls (new, assert_eq!, build_config).


##### `tests::latest_session_lookup_params_omit_local_filters_for_remote_sessions`  (lines 2436–2452)

```
async fn latest_session_lookup_params_omit_local_filters_for_remote_sessions() -> std::io::Result<()>
```

**Purpose**: Checks that remote-workspace latest-session lookup omits local model-provider and cwd filters.

**Data flow**: Builds a config, calls `latest_session_lookup_params(true, ...)`, and asserts `model_providers` and `cwd` are `None`.

**Call relations**: Covers remote query construction.

*Call graph*: calls 1 internal fn (latest_session_lookup_params); 3 external calls (new, assert_eq!, build_config).


##### `tests::latest_session_lookup_params_can_include_non_interactive_sources`  (lines 2455–2478)

```
async fn latest_session_lookup_params_can_include_non_interactive_sources() -> std::io::Result<()>
```

**Purpose**: Checks that latest-session lookup can include non-interactive source kinds when requested.

**Data flow**: Builds a config, calls `latest_session_lookup_params(..., include_non_interactive = true, ...)`, and compares `source_kinds` to the expected four-entry list.

**Call relations**: Covers `resume_source_kinds` integration.

*Call graph*: calls 1 internal fn (latest_session_lookup_params); 3 external calls (new, assert_eq!, build_config).


##### `tests::latest_session_lookup_params_keep_explicit_cwd_filter_for_remote_sessions`  (lines 2481–2501)

```
async fn latest_session_lookup_params_keep_explicit_cwd_filter_for_remote_sessions() -> std::io::Result<()>
```

**Purpose**: Checks that an explicit remote cwd override is preserved in remote latest-session lookup.

**Data flow**: Builds a config and remote cwd path, calls `latest_session_lookup_params(true, ..., Some(cwd), ...)`, and asserts `cwd` contains that remote path while `model_providers` remains `None`.

**Call relations**: Covers remote cwd-filter handling.

*Call graph*: calls 1 internal fn (latest_session_lookup_params); 4 external calls (new, new, assert_eq!, build_config).


##### `tests::latest_session_cwd_filter_respects_scope_options`  (lines 2504–2528)

```
async fn latest_session_cwd_filter_respects_scope_options() -> std::io::Result<()>
```

**Purpose**: Verifies the cwd-filter helper respects local scope, `show_all`, and remote overrides.

**Data flow**: Builds a config and remote cwd, calls `latest_session_cwd_filter` in local, show-all, and remote modes, and compares the returned options.

**Call relations**: Direct unit test for cwd-filter selection.

*Call graph*: calls 1 internal fn (latest_session_cwd_filter); 4 external calls (new, new, assert_eq!, build_config).


##### `tests::fork_last_filters_latest_session_by_cwd_unless_show_all`  (lines 2531–2599)

```
async fn fork_last_filters_latest_session_by_cwd_unless_show_all() -> color_eyre::Result<()>
```

**Purpose**: Checks that `--fork-last` uses cwd scoping by default but can return the globally latest session when `show_all` is enabled.

**Data flow**: Creates two rollout files in different cwd roots with different timestamps, starts an embedded app server, computes scoped and show-all cwd filters, looks up latest sessions under both filters, shuts down the server, and compares the returned thread ids.

**Call relations**: Integration-style test for latest-session lookup plus cwd filtering.

*Call graph*: calls 3 internal fn (new, latest_session_cwd_filter, lookup_latest_session_target_with_app_server); 8 external calls (default, new, InProcess, assert_eq!, default, create_dir_all, start_test_embedded_app_server, write_session_rollout).


##### `tests::latest_session_lookup_falls_back_for_rollout_missing_from_state_db`  (lines 2602–2644)

```
async fn latest_session_lookup_falls_back_for_rollout_missing_from_state_db() -> color_eyre::Result<()>
```

**Purpose**: Verifies latest-session lookup falls back from state-DB-only mode to scan-and-repair when a rollout exists on disk but is missing from the state DB.

**Data flow**: Builds config and embedded app server, writes a rollout after backfill completion, calls `lookup_latest_session_target_with_app_server`, shuts down the server, and asserts the returned thread id matches the rollout.

**Call relations**: Covers the two-phase latest-session lookup strategy.

*Call graph*: calls 2 internal fn (new, lookup_latest_session_target_with_app_server); 8 external calls (default, new, InProcess, assert_eq!, default, create_dir_all, start_test_embedded_app_server, write_session_rollout).


##### `tests::config_cwd_for_app_server_target_omits_cwd_for_remote_sessions`  (lines 2647–2666)

```
async fn config_cwd_for_app_server_target_omits_cwd_for_remote_sessions() -> std::io::Result<()>
```

**Purpose**: Checks that config loading ignores local cwd for explicit remote sessions.

**Data flow**: Builds a remote target and test environment manager, calls `config_cwd_for_app_server_target(Some(remote_only_cwd), ...)`, and asserts the result is `None`.

**Call relations**: Covers remote-workspace cwd omission.

*Call graph*: calls 3 internal fn (default_for_tests, config_cwd_for_app_server_target, relative_to_current_dir); 3 external calls (new, assert_eq!, cfg!).


##### `tests::config_cwd_for_app_server_target_canonicalizes_embedded_cli_cwd`  (lines 2669–2685)

```
async fn config_cwd_for_app_server_target_canonicalizes_embedded_cli_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that embedded config cwd resolution canonicalizes the provided local path.

**Data flow**: Builds an embedded target and test environment manager, calls `config_cwd_for_app_server_target(Some(temp_dir.path()), ...)`, and compares the result to the canonicalized absolute path.

**Call relations**: Covers local cwd canonicalization.

*Call graph*: calls 2 internal fn (default_for_tests, config_cwd_for_app_server_target); 2 external calls (new, assert_eq!).


##### `tests::config_cwd_for_app_server_target_canonicalizes_local_daemon_cli_cwd`  (lines 2688–2708)

```
async fn config_cwd_for_app_server_target_canonicalizes_local_daemon_cli_cwd() -> std::io::Result<()>
```

**Purpose**: Checks that local-daemon config cwd resolution also canonicalizes the provided local path.

**Data flow**: Builds a local-daemon target and test environment manager, calls `config_cwd_for_app_server_target(Some(temp_dir.path()), ...)`, and compares the result to the canonicalized absolute path.

**Call relations**: Covers local-daemon cwd canonicalization.

*Call graph*: calls 3 internal fn (default_for_tests, config_cwd_for_app_server_target, relative_to_current_dir); 2 external calls (new, assert_eq!).


##### `tests::config_cwd_for_app_server_target_errors_for_missing_embedded_cli_cwd`  (lines 2711–2723)

```
async fn config_cwd_for_app_server_target_errors_for_missing_embedded_cli_cwd() -> std::io::Result<()>
```

**Purpose**: Ensures missing local cwd paths produce a `NotFound` error for embedded sessions.

**Data flow**: Builds an embedded target and missing path, calls `config_cwd_for_app_server_target`, expects an error, and compares its kind to `NotFound`.

**Call relations**: Negative coverage for local cwd resolution.

*Call graph*: calls 2 internal fn (default_for_tests, config_cwd_for_app_server_target); 2 external calls (new, assert_eq!).


##### `tests::config_cwd_for_app_server_target_omits_cwd_for_remote_exec_server`  (lines 2726–2748)

```
async fn config_cwd_for_app_server_target_omits_cwd_for_remote_exec_server() -> std::io::Result<()>
```

**Purpose**: Checks that config cwd is omitted when the default exec environment is remote even if the app-server target itself is embedded.

**Data flow**: Builds an embedded target and a test `EnvironmentManager` configured with a remote exec server, calls `config_cwd_for_app_server_target(Some(remote_only_cwd), ...)`, and asserts `None`.

**Call relations**: Covers the environment-manager branch of cwd omission.

*Call graph*: calls 3 internal fn (create_for_tests, new, config_cwd_for_app_server_target); 4 external calls (new, assert_eq!, cfg!, current_exe).


##### `tests::windows_shows_trust_prompt_without_sandbox`  (lines 2752–2764)

```
async fn windows_shows_trust_prompt_without_sandbox() -> std::io::Result<()>
```

**Purpose**: Verifies that an undecided project trust level triggers the trust prompt.

**Data flow**: Builds a config, sets `active_project.trust_level = None` and disables Windows sandbox, calls `should_show_trust_screen`, and asserts `true`.

**Call relations**: Trust-screen policy test.

*Call graph*: calls 1 internal fn (should_show_trust_screen); 3 external calls (new, assert!, build_config).


##### `tests::embedded_app_server_supports_thread_start_rpc`  (lines 2767–2785)

```
async fn embedded_app_server_supports_thread_start_rpc() -> color_eyre::Result<()>
```

**Purpose**: Checks that the embedded app server can service a basic `thread/start` RPC.

**Data flow**: Builds config, starts a test embedded app server, sends a typed `ClientRequest::ThreadStart` with `ephemeral: Some(true)`, asserts the returned thread id is non-empty, and shuts down the server.

**Call relations**: Smoke test for embedded app-server startup and RPC wiring.

*Call graph*: 6 external calls (new, Integer, default, assert!, build_config, start_test_embedded_app_server).


##### `tests::lookup_session_target_by_name_uses_backend_title_search`  (lines 2788–2850)

```
async fn lookup_session_target_by_name_uses_backend_title_search() -> color_eyre::Result<()>
```

**Purpose**: Verifies name-based session lookup uses backend thread metadata title search rather than only rollout filenames.

**Data flow**: Creates a rollout path and state runtime metadata with title `saved-session`, starts an embedded app server, calls `lookup_session_target_by_name_with_app_server`, asserts the returned path and thread id, and shuts down the server.

**Call relations**: Integration test for name-based session lookup.

*Call graph*: calls 5 internal fn (new, new, init, new, lookup_session_target_by_name_with_app_server); 12 external calls (pin, new, InProcess, assert_eq!, parse_from_rfc3339, format!, from_value, json!, create_dir_all, write (+2 more)).


##### `tests::embedded_app_server_start_failure_is_returned`  (lines 2853–2881)

```
async fn embedded_app_server_start_failure_is_returned() -> color_eyre::Result<()>
```

**Purpose**: Ensures embedded app-server startup failures are returned with preserved context rather than swallowed.

**Data flow**: Builds config, calls `start_embedded_app_server_with` using an injected start closure that returns `Err("boom")`, extracts the error, and asserts the message contains `failed to start embedded app server`.

**Call relations**: Covers the generic startup wrapper’s error context.

*Call graph*: calls 4 internal fn (default, default_for_tests, new, start_embedded_app_server_with); 8 external calls (new, new, new, default, assert!, default, panic!, build_config).


##### `tests::embedded_state_db_failure_is_typed_for_cli_recovery`  (lines 2884–2912)

```
async fn embedded_state_db_failure_is_typed_for_cli_recovery() -> color_eyre::Result<()>
```

**Purpose**: Checks that embedded state DB initialization failures preserve typed `LocalStateDbStartupError` context for CLI recovery messaging.

**Data flow**: Builds config, points `sqlite_home` at an occupied file path, calls `init_state_db_for_app_server_target`, extracts the typed startup error from the returned `std::io::Error`, and asserts the state DB path and detail text.

**Call relations**: Covers typed error wrapping in embedded state DB startup.

*Call graph*: calls 1 internal fn (init_state_db_for_app_server_target); 6 external calls (new, assert!, assert_eq!, panic!, write, build_config).


##### `tests::embedded_state_db_corruption_preserves_failed_database_for_cli_recovery`  (lines 2915–2942)

```
async fn embedded_state_db_corruption_preserves_failed_database_for_cli_recovery() -> color_eyre::Result<()>
```

**Purpose**: Checks that SQLite corruption during embedded state DB startup preserves the exact failed database path and corruption detail.

**Data flow**: Builds config, writes invalid bytes to the logs DB path under `sqlite_home`, calls `init_state_db_for_app_server_target`, extracts the typed startup error, and asserts the database path and corruption detail predicate.

**Call relations**: Another typed-error regression test for embedded state DB startup.

*Call graph*: calls 1 internal fn (init_state_db_for_app_server_target); 8 external calls (new, assert!, assert_eq!, logs_db_path, panic!, create_dir_all, write, build_config).


##### `tests::windows_shows_trust_prompt_with_sandbox`  (lines 2946–2965)

```
async fn windows_shows_trust_prompt_with_sandbox() -> std::io::Result<()>
```

**Purpose**: Verifies that an undecided project trust level still triggers the trust prompt when Windows sandbox is enabled.

**Data flow**: Builds config, sets `trust_level = None` and enables Windows sandbox, calls `should_show_trust_screen`, and asserts `true`.

**Call relations**: Trust-screen policy test across sandbox settings.

*Call graph*: calls 1 internal fn (should_show_trust_screen); 4 external calls (new, assert!, cfg!, build_config).


##### `tests::untrusted_project_skips_trust_prompt`  (lines 2967–2981)

```
async fn untrusted_project_skips_trust_prompt() -> std::io::Result<()>
```

**Purpose**: Ensures explicitly untrusted projects do not show the trust prompt again.

**Data flow**: Builds config, sets `active_project.trust_level = Some(Untrusted)`, calls `should_show_trust_screen`, and asserts `false`.

**Call relations**: Negative trust-screen policy test.

*Call graph*: calls 1 internal fn (should_show_trust_screen); 3 external calls (new, assert!, build_config).


##### `tests::config_rebuild_changes_trust_defaults_with_cwd`  (lines 2984–3035)

```
async fn config_rebuild_changes_trust_defaults_with_cwd() -> std::io::Result<()>
```

**Purpose**: Verifies that rebuilding config with a different cwd picks up project-specific trust defaults from `config.toml`.

**Data flow**: Creates trusted and untrusted project directories plus a config file assigning trust levels, builds config twice with different cwd overrides, and compares the resulting effective approval policies.

**Call relations**: Regression test for cwd-sensitive config rebuild behavior.

*Call graph*: calls 1 internal fn (without_managed_config_for_tests); 7 external calls (default, new, assert_eq!, default, format!, create_dir_all, write).


##### `tests::theme_warning_uses_final_config`  (lines 3050–3079)

```
async fn theme_warning_uses_final_config() -> std::io::Result<()>
```

**Purpose**: Verifies that syntax-theme validation uses the final config after onboarding/resume reloads rather than the initial config.

**Data flow**: Builds an initial config with no theme, then a second config with invalid `tui_theme`, runs `validate_theme_name` against the final config and pushes any warning, and asserts the warning count and contents reference the final theme name.

**Call relations**: Regression test for final-config theme application timing.

*Call graph*: 4 external calls (new, assert!, assert_eq!, build_config).


### `tui/src/oss_selection.rs`

`entrypoint` · `startup provider selection`

This file implements a self-contained provider-selection modal that runs before the main runtime keymap and TUI infrastructure are available. It defines static `SelectOption` entries for LM Studio and Ollama, plus a small `ProviderStatus` model used to show whether each local server appears to be running. `OssSelectionWidget` stores the selectable options, a prebuilt `Paragraph` prompt containing provider status indicators, the currently selected option index, a completion flag, and the chosen provider ID.

The widget's input model is intentionally simple: only key press events are processed; left/right or Ctrl-H/Ctrl-L move the selection horizontally; Enter confirms the highlighted provider; Esc defaults to LM Studio; Ctrl-C returns a sentinel cancellation string; and direct letter keys (`l`/`o`, case-insensitive) immediately choose the matching provider. Rendering splits the area into a prompt section and a response section, draws centered button-like labels with cyan/black styling for the selected option, and shows the selected option's description below.

`select_oss_provider` first probes localhost ports using short-timeout HTTP GETs to infer LM Studio and Ollama availability. If exactly one is running, it returns that provider without showing UI and marks `manually_selected = false`. Otherwise it enters raw mode, switches to the alternate screen, repeatedly draws the widget and reads crossterm events until a selection is made, then restores the terminal and returns the chosen provider with `manually_selected = true`.

#### Function details

##### `OssSelectionWidget::new`  (lines 110–162)

```
fn new(lmstudio_status: ProviderStatus, ollama_status: ProviderStatus) -> io::Result<Self>
```

**Purpose**: Constructs the provider-selection widget and precomputes the prompt text showing provider statuses and usage hints. It translates raw status values into visible symbols and colors.

**Data flow**: Takes `lmstudio_status` and `ollama_status`, builds a local `providers` list including both Ollama modes, converts each status through `get_status_symbol_and_color`, assembles a `Vec<Line>` prompt, wraps it in a `Paragraph`, and returns an `OssSelectionWidget` with `selected_option = 0`, `done = false`, and `selection = None`.

**Call relations**: Called by `select_oss_provider` when UI is needed and by the keyboard-navigation test. It depends on `get_status_symbol_and_color` for the status legend rows.

*Call graph*: calls 1 internal fn (get_status_symbol_and_color); called by 2 (select_oss_provider, ctrl_h_l_move_provider_selection); 3 external calls (from, new, vec!).


##### `OssSelectionWidget::get_confirmation_prompt_height`  (lines 164–167)

```
fn get_confirmation_prompt_height(&self, width: u16) -> u16
```

**Purpose**: Computes how many rows the prebuilt prompt paragraph will occupy at a given width. This lets the widget size its layout dynamically.

**Data flow**: Calls `self.confirmation_prompt.line_count(width)` and returns the result as `u16`. It does not mutate state.

**Call relations**: Used by both `desired_height` and `render_ref` to split the widget area between prompt and selection controls.

*Call graph*: called by 2 (desired_height, render_ref); 1 external calls (line_count).


##### `OssSelectionWidget::handle_key_event`  (lines 174–183)

```
fn handle_key_event(&mut self, key: KeyEvent) -> Option<String>
```

**Purpose**: Consumes a crossterm key event while the modal is visible and returns the chosen provider once a decision has been made. It only reacts to key press events.

**Data flow**: Checks `key.kind`; on `Press` it delegates to `handle_select_key`, then returns `self.selection.clone()` if `done` is true or `None` otherwise. It mutates widget state only through the delegated handler.

**Call relations**: Called from the event loop inside `select_oss_provider`. It is the public input entry point for the widget.

*Call graph*: calls 1 internal fn (handle_select_key).


##### `OssSelectionWidget::normalize_keycode`  (lines 188–193)

```
fn normalize_keycode(code: KeyCode) -> KeyCode
```

**Purpose**: Normalizes character keys to lowercase so direct option matching is case-insensitive. Non-character key codes are left unchanged.

**Data flow**: Matches the input `KeyCode`; for `Char(c)` it returns `KeyCode::Char(c.to_ascii_lowercase())`, otherwise it returns the original code. It has no side effects.

**Call relations**: Used by `handle_select_key` when comparing arbitrary typed keys against each option's shortcut key.

*Call graph*: 1 external calls (Char).


##### `OssSelectionWidget::handle_select_key`  (lines 195–235)

```
fn handle_select_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Implements all selection-mode key behavior: cancellation, horizontal navigation, confirmation, escape defaulting, and direct shortcut selection. It is the widget's core state machine.

**Data flow**: Pattern-matches the incoming `KeyEvent`; Ctrl-C stores a cancellation sentinel, left/right bindings update `selected_option` with wraparound, Enter stores the highlighted option's `provider_id`, Esc stores the LM Studio provider ID, and any other key is normalized and compared against option shortcut keys for direct selection. It mutates `selected_option`, `selection`, and `done` via `send_decision`.

**Call relations**: Called only from `handle_key_event`. It delegates final completion state updates to `send_decision`.

*Call graph*: calls 1 internal fn (send_decision); called by 1 (handle_key_event); 1 external calls (normalize_keycode).


##### `OssSelectionWidget::send_decision`  (lines 237–240)

```
fn send_decision(&mut self, selection: String)
```

**Purpose**: Marks the widget complete and stores the chosen provider identifier. It is the single place where selection finalization happens.

**Data flow**: Writes `Some(selection)` into `self.selection` and sets `self.done = true`. It returns `()`.

**Call relations**: Used by `handle_select_key` for every terminal decision path, including cancellation and direct shortcut selection.

*Call graph*: called by 1 (handle_select_key).


##### `OssSelectionWidget::is_complete`  (lines 244–246)

```
fn is_complete(&self) -> bool
```

**Purpose**: Reports whether the widget has already received a final decision. This lets callers know when it can be removed.

**Data flow**: Reads and returns `self.done`. It has no side effects.

**Call relations**: Available to callers as a completion check, though this file's own selection loop relies on `handle_key_event` returning the selection instead.


##### `OssSelectionWidget::desired_height`  (lines 248–250)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Returns the total height the widget would like to occupy at a given width. It combines prompt height with one row per selectable option.

**Data flow**: Calls `get_confirmation_prompt_height(width)`, adds `self.select_options.len() as u16`, and returns the sum. It does not mutate state.

**Call relations**: Used by external layout code if the widget is embedded elsewhere.

*Call graph*: calls 1 internal fn (get_confirmation_prompt_height).


##### `OssSelectionWidget::render_ref`  (lines 254–300)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the provider-selection modal, including the status prompt, centered option buttons, and description of the currently highlighted provider. It is the ratatui drawing entry point for the widget.

**Data flow**: Computes prompt height, splits the area vertically and horizontally, styles each option label based on whether its index equals `selected_option`, renders the title, prompt paragraph, button row, and selected description into the buffer. It writes only to the render buffer.

**Call relations**: Called repeatedly by the loop in `select_oss_provider` while waiting for a decision.

*Call graph*: calls 1 internal fn (get_confirmation_prompt_height); 9 external calls (Length, Min, default, horizontal, vertical, from, new, clone, new).


##### `get_status_symbol_and_color`  (lines 303–309)

```
fn get_status_symbol_and_color(status: &ProviderStatus) -> (&'static str, Color)
```

**Purpose**: Maps a provider status to the visible symbol and color used in the prompt legend. Running is green `●`, not running is red `○`, and unknown is yellow `?`.

**Data flow**: Matches the input `ProviderStatus` and returns a `(&'static str, Color)` pair. It has no side effects.

**Call relations**: Used by `OssSelectionWidget::new` when constructing the status rows in the prompt.

*Call graph*: called by 1 (new).


##### `select_oss_provider`  (lines 316–370)

```
async fn select_oss_provider() -> io::Result<OssProviderSelection>
```

**Purpose**: Runs the full provider-selection flow: probe local provider availability, auto-select when possible, otherwise open the alternate-screen selector UI and return the user's choice. It is the public entry point for OSS provider selection.

**Data flow**: Asynchronously calls `check_lmstudio_status` and `check_ollama_status`, returns early with `manually_selected = false` if exactly one provider is running, otherwise constructs `OssSelectionWidget::new`, enables raw mode, enters the alternate screen, creates a `Terminal<CrosstermBackend<_>>`, loops drawing the widget and reading crossterm events until `handle_key_event` yields a selection, then disables raw mode, leaves the alternate screen, and returns `OssProviderSelection { provider, manually_selected: true }`.

**Call relations**: Called by `run_main` during startup. It orchestrates the lower-level status probes and widget event loop.

*Call graph*: calls 3 internal fn (new, check_lmstudio_status, check_ollama_status); called by 1 (run_main); 7 external calls (new, disable_raw_mode, enable_raw_mode, read, execute!, stdout, new).


##### `check_lmstudio_status`  (lines 372–378)

```
async fn check_lmstudio_status() -> ProviderStatus
```

**Purpose**: Checks whether LM Studio appears to be running on its default localhost port. It converts the generic port probe result into a `ProviderStatus`.

**Data flow**: Calls `check_port_status(DEFAULT_LMSTUDIO_PORT).await` and maps `Ok(true)` to `Running`, `Ok(false)` to `NotRunning`, and any error to `Unknown`. It returns the status enum and writes no state.

**Call relations**: Used by `select_oss_provider` before deciding whether to auto-select or show the UI.

*Call graph*: calls 1 internal fn (check_port_status); called by 1 (select_oss_provider).


##### `check_ollama_status`  (lines 380–386)

```
async fn check_ollama_status() -> ProviderStatus
```

**Purpose**: Checks whether Ollama appears to be running on its default localhost port. It mirrors the LM Studio probe logic.

**Data flow**: Calls `check_port_status(DEFAULT_OLLAMA_PORT).await` and maps the boolean/error result into `ProviderStatus`. It has no side effects beyond the network probe.

**Call relations**: Also used by `select_oss_provider` during startup probing.

*Call graph*: calls 1 internal fn (check_port_status); called by 1 (select_oss_provider).


##### `check_port_status`  (lines 388–400)

```
async fn check_port_status(port: u16) -> io::Result<bool>
```

**Purpose**: Performs a short-timeout HTTP probe against `http://localhost:<port>` and reports whether the endpoint responded successfully. Connection failures are treated as 'not running' rather than hard errors.

**Data flow**: Builds a `reqwest::Client` with a 2-second timeout, formats the localhost URL, sends a GET request, and returns `Ok(response.status().is_success())` on response, `Ok(false)` on request error, or an `io::Error` if client construction fails. It performs network I/O but does not mutate shared state.

**Call relations**: Called by both provider-specific status helpers. Its tolerant error mapping is what allows `select_oss_provider` to distinguish unavailable services from probe setup failures.

*Call graph*: called by 2 (check_lmstudio_status, check_ollama_status); 3 external calls (from_secs, builder, format!).


##### `tests::ctrl_h_l_move_provider_selection`  (lines 407–416)

```
fn ctrl_h_l_move_provider_selection()
```

**Purpose**: Verifies that Ctrl-L and Ctrl-H move the highlighted provider right and left, respectively. This locks in the startup wizard's built-in horizontal navigation bindings.

**Data flow**: Creates a widget with unknown statuses, asserts the initial `selected_option`, sends synthetic Ctrl-L and Ctrl-H key events through `handle_key_event`, and asserts the updated indices. It mutates the widget under test.

**Call relations**: Exercises the movement branches in `handle_select_key` via the public `handle_key_event` entry point.

*Call graph*: calls 1 internal fn (new); 3 external calls (Char, new, assert_eq!).


### `tui/src/startup_hooks_review.rs`

`orchestration` · `startup gating before entering the main TUI flow`

This file drives a focused modal flow shown at startup when configured hooks are new or modified and therefore require trust review. It begins with `load_startup_hooks_review_entry`, which asks the app server for the hooks list for the current cwd and degrades gracefully to an empty `HooksListEntry` on RPC failure, logging a warning instead of aborting startup. `maybe_run_startup_hooks_review` then decides whether the prompt is needed by combining the bypass flag with a count of hooks for which `hook_needs_review` is true.

When review is required, `run_startup_hooks_review_app` creates a temporary `RuntimeKeymap`, a throwaway `AppEventSender`, and a `ListSelectionView` containing three choices: review hooks, trust all and continue, or continue without trusting. It draws the popup, consumes `TuiEvent`s from the terminal stream, and only reacts to key press/repeat events. Once the selection view reports completion, the chosen index is mapped to a `StartupHooksReviewSelection`. Choosing review returns `OpenHooksBrowser(entry)`; choosing continue exits immediately; choosing trust-all redraws the view in a disabled/loading state, sends `write_hook_trusts` updates for every hook still needing review, and either exits on success or redisplays the prompt with a formatted error message on failure. Supporting helpers build the header/footer text, count reviewable hooks, create disabled items while trust-all is in progress, and render the popup through a tiny `WidgetRef` wrapper. Tests snapshot the rendered prompt and verify the bypass/count logic.

#### Function details

##### `load_startup_hooks_review_entry`  (lines 50–67)

```
async fn load_startup_hooks_review_entry(
    request_handle: AppServerRequestHandle,
    cwd: PathBuf,
) -> HooksListEntry
```

**Purpose**: Fetches the hook list for the startup cwd and extracts the entry relevant to that directory. If the RPC fails, it logs a warning and returns an empty entry so startup can continue safely.

**Data flow**: Takes an `AppServerRequestHandle` and a `PathBuf` cwd. It clones the cwd for `fetch_hooks_list`, awaits the response, and on success passes the response plus `&cwd` to `hooks_list_entry_for_cwd`. On error it writes a warning log and returns a synthesized `HooksListEntry` containing the cwd and empty `hooks`, `warnings`, and `errors` vectors.

**Call relations**: This async loader is used before the review UI runs to gather the startup hook state. It delegates remote retrieval to `fetch_hooks_list` and response extraction to `hooks_list_entry_for_cwd`, while intentionally swallowing fetch failures into an empty result.

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

**Purpose**: Decides whether startup should pause for hook trust review and, if so, launches the review mini-app. Otherwise it immediately returns a continue outcome.

**Data flow**: Takes mutable references to `AppServerSession` and `Tui`, a `Config`, a `bypass_hook_trust` flag, and a `HooksListEntry`. It reads `review_is_needed`; if false it returns `Ok(StartupHooksReviewOutcome::Continue)`, otherwise it awaits `run_startup_hooks_review_app` and returns that result.

**Call relations**: This function is called by `run_ratatui_app` during startup. It is the gatekeeper between normal startup and the interactive review flow, delegating the actual UI loop to `run_startup_hooks_review_app` only when review conditions are met.

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

**Purpose**: Runs the interactive startup hook-review popup, handling redraws, keyboard navigation, and the trust-all RPC. It returns either a continue outcome or a request to open the full hooks browser.

**Data flow**: Consumes mutable `app_server` and `tui`, reads `config` to build a `RuntimeKeymap`, creates an unbounded `AppEvent` channel and `AppEventSender`, initializes `trust_all_error` to `None`, builds an initial `ListSelectionView` with `selection_view`, and draws it. It then reads from `tui.event_stream()` in a loop. For key press/repeat events it forwards the key to `view.handle_key_event`, asks `selected_choice` whether the popup completed, and branches: review returns `OpenHooksBrowser(entry)`, continue returns `Continue`, and trust-all rebuilds the view in disabled mode, redraws, sends `write_hook_trusts` with one `HookTrustUpdate` per review-needed hook, then either returns `Continue` on success or stores a formatted error string, rebuilds the normal view, and redraws. Paste events are ignored; draw/resize events trigger `draw_view`.

**Call relations**: This function is invoked only by `maybe_run_startup_hooks_review` when startup review is required. It delegates view construction to `selection_view`, completion decoding to `selected_choice`, rendering to `draw_view`, keymap parsing to `RuntimeKeymap::from_config`, and persistence of trust decisions to `write_hook_trusts`.

*Call graph*: calls 7 internal fn (new, request_handle, write_hook_trusts, from_config, draw_view, selected_choice, selection_view); called by 1 (maybe_run_startup_hooks_review); 4 external calls (event_stream, matches!, pin!, OpenHooksBrowser).


##### `selected_choice`  (lines 175–185)

```
fn selected_choice(view: &mut ListSelectionView) -> Option<StartupHooksReviewSelection>
```

**Purpose**: Translates a completed `ListSelectionView` selection index into the semantic startup-review choice enum. It also treats a completed view with no remembered index as the safe 'continue without trusting' path.

**Data flow**: Takes `&mut ListSelectionView`, reads `is_complete()`, and returns `None` if the popup is still active. Otherwise it consumes `take_last_selected_index()` and maps index `0` to `ReviewHooks`, `1` to `TrustAllAndContinue`, `2` or `None` to `ContinueWithoutTrusting`, and any other index to `None`.

**Call relations**: This helper is called inside `run_startup_hooks_review_app` after key handling. It isolates the index-to-enum mapping so the event loop can branch on meaningful choices instead of raw list positions.

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

**Purpose**: Constructs the `ListSelectionView` used by the startup review popup from current state such as trust errors and whether trust-all is in progress. It wires together the view parameters, app-event sender, and list keymap.

**Data flow**: Takes a `HooksListEntry`, optional error text, a `trusting_all` flag, an `AppEventSender`, and a `RuntimeKeymap`. It calls `selection_view_params(...)` to build `SelectionViewParams`, then passes those plus `app_event_tx` and `keymap.list.clone()` into `ListSelectionView::new`, returning the resulting view.

**Call relations**: This helper is used by `run_startup_hooks_review_app` whenever the popup needs to be created or rebuilt, and by snapshot tests that render the prompt. It delegates all textual/layout decisions to `selection_view_params`.

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

**Purpose**: Builds the header, footer hint, and selectable items for the startup hook-review popup. It reflects the number of changed hooks and optionally shows an in-progress or error message.

**Data flow**: Takes a `HooksListEntry`, optional trust-all error text, a `trusting_all` flag, and a `RuntimeKeymap`. It computes `count` via `review_needed_count`, formats a singular/plural count line, builds a `ColumnRenderable` header with bold/yellow/dim lines, optionally appends a wrapped red error paragraph or a dim 'Trusting hooks...' line, and returns `SelectionViewParams` containing a footer hint from `standard_popup_hint_line_for_keymap`, three `SelectionItem`s from `selection_item`, the boxed header, and default values for the remaining fields.

**Call relations**: This function is called by `selection_view` to supply all popup content. It delegates count computation to `review_needed_count`, footer text generation to `standard_popup_hint_line_for_keymap`, and item creation to `selection_item`.

*Call graph*: calls 3 internal fn (standard_popup_hint_line_for_keymap, new, review_needed_count); called by 1 (selection_view); 6 external calls (new, default, from, new, format!, vec!).


##### `review_needed_count`  (lines 237–243)

```
fn review_needed_count(entry: &HooksListEntry) -> usize
```

**Purpose**: Counts how many hooks in a `HooksListEntry` are currently untrusted or modified according to the shared review predicate. This is the numeric basis for both gating and prompt text.

**Data flow**: Takes `&HooksListEntry`, iterates `entry.hooks`, filters with `hook_needs_review`, counts the matches, and returns the resulting `usize`. It reads but does not mutate the entry.

**Call relations**: This helper is used by both `review_is_needed` and `selection_view_params`. It centralizes the definition of 'how many hooks still need review' so gating and UI stay consistent.

*Call graph*: called by 2 (review_is_needed, selection_view_params).


##### `review_is_needed`  (lines 245–247)

```
fn review_is_needed(bypass_hook_trust: bool, entry: &HooksListEntry) -> bool
```

**Purpose**: Determines whether startup should show the hook-review prompt. Review is required only when bypass is disabled and at least one hook needs review.

**Data flow**: Takes a `bool` bypass flag and `&HooksListEntry`, calls `review_needed_count(entry)`, and returns `true` only if bypass is false and the count is greater than zero. It writes no state.

**Call relations**: This predicate is called by `maybe_run_startup_hooks_review` before launching the popup. It delegates the actual counting logic to `review_needed_count`.

*Call graph*: calls 1 internal fn (review_needed_count); called by 1 (maybe_run_startup_hooks_review).


##### `selection_item`  (lines 249–256)

```
fn selection_item(name: &str, is_disabled: bool) -> SelectionItem
```

**Purpose**: Creates one selectable row for the startup review popup, optionally disabled while trust-all is running. It standardizes the item flags used by all three choices.

**Data flow**: Takes a display `name` and `is_disabled` flag, allocates `name.to_string()`, sets `dismiss_on_select: true` and `is_disabled`, fills the rest from `Default::default()`, and returns the `SelectionItem`.

**Call relations**: This helper is used only by `selection_view_params` when assembling the popup's three choices. It keeps item construction concise and consistent.

*Call graph*: 1 external calls (default).


##### `draw_view`  (lines 258–271)

```
fn draw_view(tui: &mut Tui, view: &ListSelectionView) -> Result<()>
```

**Purpose**: Renders the startup review popup into the terminal, clearing the frame and sizing the popup to the view's desired height. It wraps the list view in a standalone widget adapter for drawing.

**Data flow**: Takes mutable `Tui` and `&ListSelectionView`. It calls `tui.draw(...)`, reads the frame area, renders `Clear` over the full area, computes a `Rect` whose height is `view.desired_height(area.width).min(area.height)`, and renders `StandaloneSelectionView { view }` into that rectangle. It returns `Result<()>` from the draw operation.

**Call relations**: This renderer is called repeatedly by `run_startup_hooks_review_app` on initial display, after state changes, and on draw/resize events. It delegates actual list rendering to `StandaloneSelectionView::render_ref` and the underlying `ListSelectionView`.

*Call graph*: called by 1 (run_startup_hooks_review_app); 1 external calls (draw).


##### `StandaloneSelectionView::render_ref`  (lines 278–280)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Implements `WidgetRef` for a borrowed wrapper around `ListSelectionView`, allowing the popup view to be rendered through ratatui's widget API. It simply forwards rendering to the wrapped selection view.

**Data flow**: Takes `&self`, a target `Rect`, and mutable `Buffer`, then calls `self.view.render(area, buf)`. It returns `()` and writes only to the provided buffer.

**Call relations**: This method is reached from `draw_view` when ratatui renders the popup. Its sole role is adapting `ListSelectionView` into the `WidgetRef` trait expected by `render_widget_ref`.

*Call graph*: calls 1 internal fn (render).


##### `tests::hook`  (lines 304–322)

```
fn hook(key: &str, trust_status: HookTrustStatus) -> HookMetadata
```

**Purpose**: Builds a representative `HookMetadata` test fixture with a configurable key and trust status. It fills the remaining fields with stable dummy values suitable for snapshots and logic tests.

**Data flow**: Takes `&str` key and `HookTrustStatus`, constructs a `HookMetadata` with fixed event/handler/source fields, derives `source_path` from `test_path_buf(...).abs()`, formats `current_hash` from the key, and returns the struct.

**Call relations**: This fixture helper is used by `tests::entry` to populate a startup review scenario with changed hooks.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::entry`  (lines 324–334)

```
fn entry() -> HooksListEntry
```

**Purpose**: Creates a `HooksListEntry` fixture containing two hooks that both require review. It provides a reusable startup-review input for tests.

**Data flow**: Constructs a `HooksListEntry` with cwd `/tmp`, a `hooks` vector containing `hook("path:new", Untrusted)` and `hook("path:changed", Modified)`, and empty warnings/errors vectors. It returns the assembled entry.

**Call relations**: This helper is used by the review gating tests and the snapshot-rendering tests to supply consistent hook data.

*Call graph*: 3 external calls (new, test_path_buf, vec!).


##### `tests::render_lines`  (lines 336–358)

```
fn render_lines(view: &crate::bottom_pane::ListSelectionView, width: u16) -> String
```

**Purpose**: Renders a `ListSelectionView` into a text snapshot string by drawing it into an off-screen buffer and extracting visible symbols row by row. It normalizes trailing spaces for stable snapshot output.

**Data flow**: Takes `&ListSelectionView` and a width, computes the desired height, creates a `Rect` and empty `Buffer`, calls `view.render(area, &mut buf)`, then iterates every cell in the buffer to collect symbols into trimmed lines joined by `\n`. It returns the resulting `String`.

**Call relations**: This helper is used by the snapshot tests `renders_prompt` and `renders_prompt_with_trust_error` to compare the popup's textual rendering.

*Call graph*: calls 2 internal fn (desired_height, render); 2 external calls (empty, new).


##### `tests::bypass_hook_trust_suppresses_startup_review`  (lines 361–363)

```
fn bypass_hook_trust_suppresses_startup_review()
```

**Purpose**: Verifies that the bypass flag disables startup hook review even when hooks would otherwise require it. This protects the explicit bypass behavior.

**Data flow**: Calls `review_is_needed(true, &entry())` and asserts the result is false. It returns `()` and mutates no state.

**Call relations**: This unit test exercises the gating predicate directly, covering the bypass branch.

*Call graph*: 1 external calls (assert!).


##### `tests::untrusted_hooks_need_review_without_bypass`  (lines 366–368)

```
fn untrusted_hooks_need_review_without_bypass()
```

**Purpose**: Checks that changed/untrusted hooks trigger startup review when bypass is not enabled. It validates the normal gating path.

**Data flow**: Calls `review_is_needed(false, &entry())` and asserts the result is true. It returns `()` and writes no state.

**Call relations**: This test complements the bypass test by covering the positive review-needed case.

*Call graph*: 1 external calls (assert!).


##### `tests::renders_prompt`  (lines 371–386)

```
fn renders_prompt()
```

**Purpose**: Snapshot-tests the normal startup hook-review prompt rendering. It ensures the popup text and layout remain stable for the default state.

**Data flow**: Creates an unbounded `AppEvent` channel, obtains default key bindings with `RuntimeKeymap::defaults()`, builds a view via `selection_view(&entry(), None, false, AppEventSender::new(tx_raw), &keymap)`, renders it to text with `render_lines`, and compares the result with `assert_snapshot!`.

**Call relations**: This test exercises `selection_view` and the rendering path indirectly, guarding the user-visible prompt layout.

*Call graph*: calls 3 internal fn (new, defaults, selection_view); 2 external calls (assert_snapshot!, entry).


##### `tests::renders_prompt_with_trust_error`  (lines 389–406)

```
fn renders_prompt_with_trust_error()
```

**Purpose**: Snapshot-tests the startup review prompt when a trust-all attempt has failed and an error message must be shown. It protects wrapping and error presentation behavior.

**Data flow**: Creates an event channel and default keymap, builds a view with `selection_view(&entry(), Some(long_error_message), false, AppEventSender::new(tx_raw), &keymap)`, renders it at a narrower width with `render_lines`, and asserts the snapshot output.

**Call relations**: This test covers the error-display branch in `selection_view_params`, ensuring failed trust-all attempts are rendered clearly.

*Call graph*: calls 3 internal fn (new, defaults, selection_view); 2 external calls (assert_snapshot!, entry).


### `tui/src/app/startup_prompts.rs`

`orchestration` · `startup/bootstrap, config warning emission, and one-time prompt selection`

This file contains pre-run and early-run helpers that translate config/model state into one-time UI output or persisted prompt state. It does not own the event loop; instead it emits `AppEvent`s or returns prompt decisions for callers in startup orchestration.

`SkillLoadWarningState` deduplicates repeated skill-load errors across refreshes. It keys active warnings by both `path` and `message`, so a changed error message for the same `SKILL.md` path is treated as newly active. `emit_skill_load_warnings`, `emit_project_config_warnings`, and `emit_system_bwrap_warning` all convert startup conditions into warning history cells sent through `AppEventSender`.

The model-migration section decides whether to show an upgrade prompt based on current model, target model, prior acknowledgements in `config.notices.model_migrations`, and whether the target preset is visible in the picker. Hidden-prompt config flags are checked by `migration_prompt_hidden`. If the user accepts, `apply_accepted_model_migration` updates in-memory config and emits a sequence of persistence/update events: acknowledge migration, update model, update reasoning effort, and persist the new selection.

For model-availability NUX, `select_model_availability_nux` scans `ModelPreset`s in existing order and picks the first preset whose `availability_nux` exists and whose shown count is below `MODEL_AVAILABILITY_NUX_MAX_SHOW_COUNT`. `prepare_startup_tooltip_override` persists the incremented shown count via `ConfigEditsBuilder`, but still returns the tooltip message even if persistence fails.

Finally, `normalize_harness_overrides_for_cwd` rewrites relative `additional_writable_roots` in `ConfigOverrides` into absolute paths under a provided base cwd, which keeps test harness overrides deterministic.

#### Function details

##### `SkillLoadWarningState::clear`  (lines 22–24)

```
fn clear(&mut self)
```

**Purpose**: Clears all remembered active skill-load warnings so currently active errors can be emitted again on the next refresh. This is used when UI state is reset.

**Data flow**: Mutates `self.active`, a `HashSet<SkillLoadWarningKey>`, by calling `clear()`. Returns no value.

**Call relations**: Used by app reset flows outside this file to forget deduplication state for skill warnings.


##### `SkillLoadWarningState::newly_active_errors`  (lines 26–44)

```
fn newly_active_errors(&mut self, errors: &[SkillErrorInfo]) -> Vec<SkillErrorInfo>
```

**Purpose**: Filters a fresh list of `SkillErrorInfo` values down to only those that were not already active in the previous refresh cycle. It also updates the active-warning set to exactly match the current errors.

**Data flow**: Takes `&[SkillErrorInfo]`, moves the previous `self.active` out with `std::mem::take`, builds a new `current` `HashSet`, and for each error constructs a `SkillLoadWarningKey { path, message }`. If the key was not previously active and is newly inserted into `current`, it clones the error into `newly_active`. It stores `current` back into `self.active` and returns the collected `Vec<SkillErrorInfo>`.

**Call relations**: Called by startup/config-refresh logic to suppress repeated warning emission while still re-emitting errors that disappeared and later returned or changed message text.

*Call graph*: 3 external calls (new, new, take).


##### `emit_skill_load_warnings`  (lines 47–66)

```
fn emit_skill_load_warnings(app_event_tx: &AppEventSender, errors: &[SkillErrorInfo])
```

**Purpose**: Emits startup warning history cells for invalid `SKILL.md` files: one summary cell plus one per-path detail cell. It does nothing when there are no errors.

**Data flow**: Reads `errors`; if empty it returns. Otherwise it computes `error_count`, sends an `AppEvent::InsertHistoryCell` containing a warning event summarizing skipped skill count, then iterates each `SkillErrorInfo` and sends another warning event with `path: message` text.

**Call relations**: Used by startup/test code to turn deduplicated skill-load errors into visible transcript warnings.

*Call graph*: calls 1 internal fn (send); called by 1 (render_skill_load_warning_cells); 6 external calls (new, is_empty, len, InsertHistoryCell, new_warning_event, format!).


##### `emit_project_config_warnings`  (lines 68–105)

```
fn emit_project_config_warnings(app_event_tx: &AppEventSender, config: &Config)
```

**Purpose**: Emits a warning history cell listing project-local config folders whose config/hooks/exec policies are disabled until trust is granted. Skills are explicitly noted as still loading.

**Data flow**: Iterates `config.config_layer_stack.get_layers(...)`, filters `ConfigLayerSource::Project` layers with a `disabled_reason`, collects `(folder, reason)` pairs, and if any exist builds a multiline warning string with numbered entries. It then sends that string as `AppEvent::InsertHistoryCell(history_cell::new_warning_event(message))`.

**Call relations**: Called during startup/config load to surface trust-related project config suppression in the transcript.

*Call graph*: calls 1 internal fn (send); 6 external calls (new, new, InsertHistoryCell, concat!, format!, new_warning_event).


##### `emit_system_bwrap_warning`  (lines 107–117)

```
fn emit_system_bwrap_warning(app_event_tx: &AppEventSender, config: &Config)
```

**Purpose**: Emits a warning history cell when sandbox configuration implies a system bubblewrap warning. If no warning applies, it stays silent.

**Data flow**: Calls `codex_sandboxing::system_bwrap_warning(config.permissions.permission_profile())`; if it returns `Some(message)`, wraps it in a warning history cell and sends `AppEvent::InsertHistoryCell`. Otherwise returns immediately.

**Call relations**: Used during startup warning emission alongside other config/environment warnings.

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

**Purpose**: Determines whether a model-upgrade migration prompt should be shown for a current model and target model. It requires a real change, an unacknowledged migration, and a visible target preset, and it only triggers when either the current preset declares an upgrade or some preset upgrades into the target.

**Data flow**: Takes `current_model`, `target_model`, `seen_migrations`, and `available_models`. It returns false if current equals target, if `seen_migrations[current_model] == target_model`, or if no visible preset matches the target. It then returns true if the current preset has `upgrade.is_some()` or if any preset’s `upgrade.id` equals the target model; otherwise false.

**Call relations**: Called by `handle_model_migration_prompt_if_needed` before constructing and running the migration prompt.

*Call graph*: called by 1 (handle_model_migration_prompt_if_needed); 1 external calls (iter).


##### `migration_prompt_hidden`  (lines 159–170)

```
fn migration_prompt_hidden(config: &Config, migration_config_key: &str) -> bool
```

**Purpose**: Checks whether a specific migration prompt has been hidden by config notices. Only known migration config keys are recognized.

**Data flow**: Matches `migration_config_key` against known constants and reads the corresponding optional boolean from `config.notices`, defaulting to `false`. Unknown keys also return `false`.

**Call relations**: Used by `handle_model_migration_prompt_if_needed` to suppress prompts that the user has explicitly hidden.

*Call graph*: called by 1 (handle_model_migration_prompt_if_needed).


##### `target_preset_for_upgrade`  (lines 172–179)

```
fn target_preset_for_upgrade(
    available_models: &'a [ModelPreset],
    target_model: &str,
) -> Option<&'a ModelPreset>
```

**Purpose**: Finds the visible `ModelPreset` corresponding to a migration target model. Hidden targets are intentionally excluded.

**Data flow**: Iterates `available_models` and returns the first preset whose `model == target_model` and `show_in_picker` is true, or `None` if none match.

**Call relations**: Called by `handle_model_migration_prompt_if_needed` after eligibility checks to obtain display name, description, and default reasoning effort for the target.

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

**Purpose**: Applies an accepted model migration to in-memory config and emits the full sequence of app events needed to persist acknowledgement, update runtime model/effort, and persist the new selection. It is the side-effectful acceptance path for migration prompts.

**Data flow**: Takes mutable `config`, `app_event_tx`, source and target model strings, and `target_default_effort`. It sends `PersistModelMigrationPromptAcknowledged`, updates `config.model` and `config.model_reasoning_effort`, sends `UpdateModel`, `UpdateReasoningEffort`, and finally `PersistModelSelection { model, effort }`.

**Call relations**: Called only from `handle_model_migration_prompt_if_needed` when the user accepts the migration prompt.

*Call graph*: calls 1 internal fn (send); called by 1 (handle_model_migration_prompt_if_needed); 3 external calls (clone, UpdateModel, UpdateReasoningEffort).


##### `select_model_availability_nux`  (lines 213–229)

```
fn select_model_availability_nux(
    available_models: &[ModelPreset],
    nux_config: &ModelAvailabilityNuxConfig,
) -> Option<StartupTooltipOverride>
```

**Purpose**: Chooses the first eligible model-availability tooltip override from the available presets, respecting per-model show-count limits. Existing preset order defines priority.

**Data flow**: Iterates `available_models`, skips presets without `availability_nux`, reads each preset’s shown count from `nux_config.shown_count`, and returns `Some(StartupTooltipOverride { model_slug, message })` for the first preset whose count is below `MODEL_AVAILABILITY_NUX_MAX_SHOW_COUNT`. Returns `None` if all are exhausted or missing.

**Call relations**: Used by `prepare_startup_tooltip_override` to decide whether a startup tooltip override should be shown and persisted.

*Call graph*: called by 1 (prepare_startup_tooltip_override); 1 external calls (iter).


##### `prepare_startup_tooltip_override`  (lines 231–268)

```
async fn prepare_startup_tooltip_override(
    config: &mut Config,
    available_models: &[ModelPreset],
    is_first_run: bool,
) -> Option<String>
```

**Purpose**: Computes and persists a startup tooltip override for model availability, incrementing the shown count for the selected model unless persistence fails. First run and globally disabled tooltips suppress the feature entirely.

**Data flow**: Takes mutable `config`, `available_models`, and `is_first_run`. It returns `None` if first run or `config.show_tooltips` is false. Otherwise it calls `select_model_availability_nux`; if none is selected it returns `None`. For a selected override it computes `next_count`, clones and updates `config.model_availability_nux.shown_count`, and tries to persist via `ConfigEditsBuilder::for_config(config).set_model_availability_nux_count(...).apply().await`. On persistence failure it logs an error and still returns `Some(message)` without mutating in-memory counts; on success it updates `config.model_availability_nux.shown_count` and returns `Some(message)`.

**Call relations**: Called during startup bootstrap before the main run loop to decide whether the chat widget should start with a tooltip override.

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

**Purpose**: Runs the full model-migration prompt flow for the current model if its preset declares an upgrade and the prompt is eligible. Depending on user choice, it applies the migration, records rejection acknowledgement, or requests app exit.

**Data flow**: Looks up the current model’s `upgrade` in `available_models`. If present, it checks `migration_prompt_hidden`, computes `target_model`, calls `should_show_model_migration_prompt`, finds current and target presets, derives display labels and optional description, builds prompt copy with `migration_copy_for_models`, and awaits `run_model_migration_prompt`. On `Accepted` it calls `apply_accepted_model_migration`; on `Rejected` it sends only `PersistModelMigrationPromptAcknowledged`; on `Exit` it returns `Some(AppExitInfo { exit_reason: UserRequested, ...default token/thread fields... })`. If no prompt is needed it returns `None`.

**Call relations**: Used during startup/bootstrap before entering the main app loop. It is the top-level migration prompt orchestrator built on the smaller eligibility and apply helpers in this file.

*Call graph*: calls 5 internal fn (apply_accepted_model_migration, migration_prompt_hidden, should_show_model_migration_prompt, target_preset_for_upgrade, send); 2 external calls (iter, default).


##### `normalize_harness_overrides_for_cwd`  (lines 356–371)

```
fn normalize_harness_overrides_for_cwd(
    mut overrides: ConfigOverrides,
    base_cwd: &AbsolutePathBuf,
) -> Result<ConfigOverrides>
```

**Purpose**: Normalizes relative harness override writable roots against a base cwd so test/runtime harness config uses absolute paths. If there are no additional writable roots, it returns the overrides unchanged.

**Data flow**: Takes ownership of `ConfigOverrides` and `base_cwd: &AbsolutePathBuf`. If `additional_writable_roots` is empty it returns early. Otherwise it drains the roots, joins each onto `base_cwd`, collects the resulting absolute `PathBuf`s into a new vector, assigns it back to `overrides.additional_writable_roots`, and returns `Ok(overrides)`.

**Call relations**: Used by tests in this file and by harness-related setup elsewhere to ensure writable-root overrides are cwd-relative in a predictable way.

*Call graph*: calls 1 internal fn (join); called by 1 (normalize_harness_overrides_resolves_relative_add_dirs); 1 external calls (with_capacity).


##### `tests::normalize_harness_overrides_resolves_relative_add_dirs`  (lines 384–400)

```
fn normalize_harness_overrides_resolves_relative_add_dirs() -> Result<()>
```

**Purpose**: Verifies that relative `additional_writable_roots` are rewritten under the provided base cwd. This protects the path-normalization helper from regressing to relative output.

**Data flow**: Creates a temp base directory, builds `ConfigOverrides` with `additional_writable_roots = ["rel"]`, calls `normalize_harness_overrides_for_cwd`, and asserts the result contains `base_cwd.join("rel")`.

**Call relations**: Unit test for the harness override normalization helper.

*Call graph*: calls 1 internal fn (normalize_harness_overrides_for_cwd); 5 external calls (default, assert_eq!, create_dir_all, tempdir, vec!).


##### `tests::skill_error`  (lines 402–407)

```
fn skill_error(path: &str, message: &str) -> SkillErrorInfo
```

**Purpose**: Constructs a `SkillErrorInfo` test value from a path and message string. It keeps the warning-state tests concise.

**Data flow**: Converts `path` into `PathBuf`, clones `message` into `String`, and returns `SkillErrorInfo { path, message }`.

**Call relations**: Used by the skill warning state tests in this module.

*Call graph*: 1 external calls (from).


##### `tests::render_line_text`  (lines 409–414)

```
fn render_line_text(line: &Line<'static>) -> String
```

**Purpose**: Flattens a `ratatui::text::Line<'static>` into plain text by concatenating span contents. This is a small rendering helper for warning-cell tests.

**Data flow**: Iterates `line.spans`, reads each span’s `content`, concatenates them into a `String`, and returns it.

**Call relations**: Used by `render_skill_load_warning_cells` to inspect emitted warning cell text.


##### `tests::render_skill_load_warning_cells`  (lines 416–431)

```
fn render_skill_load_warning_cells(errors: &[SkillErrorInfo]) -> String
```

**Purpose**: Runs `emit_skill_load_warnings` against a test event channel and renders the resulting warning cells into a newline-joined plain-text string. It provides an end-to-end assertion surface for warning emission.

**Data flow**: Creates an unbounded channel and `AppEventSender`, calls `emit_skill_load_warnings`, drains `AppEvent::InsertHistoryCell` events from the receiver, renders each cell with `display_lines(120)`, maps lines through `render_line_text`, and joins the collected strings with newlines.

**Call relations**: Used by the snapshot-style warning emission test to verify deduplication plus rendering behavior.

*Call graph*: calls 2 internal fn (emit_skill_load_warnings, new); 2 external calls (new, unbounded_channel).


##### `tests::skill_load_warning_state_suppresses_repeated_active_errors`  (lines 434–446)

```
fn skill_load_warning_state_suppresses_repeated_active_errors()
```

**Purpose**: Checks that the same active skill error is emitted only once across consecutive refreshes. This validates the deduplication behavior of `SkillLoadWarningState`.

**Data flow**: Creates default warning state and one `SkillErrorInfo`, calls `newly_active_errors` twice with the same slice, and asserts the first call returns the error while the second returns an empty vector.

**Call relations**: Unit test for `SkillLoadWarningState::newly_active_errors`.

*Call graph*: 3 external calls (assert_eq!, default, skill_error).


##### `tests::skill_load_warning_state_reemits_after_error_clears`  (lines 449–462)

```
fn skill_load_warning_state_reemits_after_error_clears()
```

**Purpose**: Ensures an error that disappears and later returns is treated as newly active again. The active set should track current errors, not permanently suppress a path/message pair.

**Data flow**: Calls `newly_active_errors` with one error, then with an empty slice, then with the same error again, asserting the error is returned on the first and third calls but not while absent.

**Call relations**: Tests the active-set replacement semantics of `SkillLoadWarningState`.

*Call graph*: 3 external calls (assert_eq!, default, skill_error).


##### `tests::skill_load_warning_state_displays_new_message_for_active_path`  (lines 465–478)

```
fn skill_load_warning_state_displays_new_message_for_active_path()
```

**Purpose**: Verifies that a changed error message for the same skill path is considered a new active warning. The deduplication key includes both path and message.

**Data flow**: Creates two `SkillErrorInfo` values with the same path but different messages, feeds them to `newly_active_errors` in sequence, and asserts each is emitted when first seen.

**Call relations**: Covers the path-plus-message keying behavior of `SkillLoadWarningState`.

*Call graph*: 3 external calls (assert_eq!, default, skill_error).


##### `tests::skill_load_warning_state_clear_allows_active_error_again`  (lines 481–500)

```
fn skill_load_warning_state_clear_allows_active_error_again()
```

**Purpose**: Checks that calling `clear()` resets deduplication so an already-active error can be emitted again. This mirrors app UI reset behavior.

**Data flow**: Creates warning state and one error, confirms the second repeated call is suppressed, calls `state.clear()`, then confirms the same error is emitted again.

**Call relations**: Tests the interaction between `SkillLoadWarningState::clear` and `newly_active_errors`.

*Call graph*: 3 external calls (assert_eq!, default, skill_error).


##### `tests::repeated_active_skill_load_warning_renders_once`  (lines 503–522)

```
fn repeated_active_skill_load_warning_renders_once()
```

**Purpose**: End-to-end test that repeated active skill-load errors produce only one rendered warning output. It snapshots the rendered warning text after two refresh cycles.

**Data flow**: Uses `SkillLoadWarningState` to split first and repeated errors, renders each batch through `render_skill_load_warning_cells`, filters empty outputs, joins them, and snapshots the final string.

**Call relations**: Combines warning-state deduplication with event emission/rendering to verify the user-visible result.

*Call graph*: 5 external calls (assert_snapshot!, from_ref, default, render_skill_load_warning_cells, skill_error).


### `tui/src/tooltips.rs`

`domain_logic` · `startup`

This file implements two related systems: ordinary startup tooltip selection and remote announcement-tip parsing. At the top level it defines several hard-coded promo strings, loads `tooltips.txt` into `RAW_TOOLTIPS`, and builds `TOOLTIPS` and `ALL_TOOLTIPS` with `lazy_static!`. The filtering step removes blank/comment lines and suppresses app-related tips on non-macOS/non-Windows platforms. `experimental_tooltips` appends feature-stage announcement strings from the global `FEATURES` registry.

`get_tooltip` is the main selector. It first creates a random generator and gives remote announcements highest priority by calling `announcement::fetch_announcement_tip(plan)`. If no announcement is ready, it enters a high-probability promo branch (`random_ratio(8, 10)`) that varies by account plan: paid/team/business-like plans use `pick_paid_tooltip`, free/go plans always get `FREE_GO_TOOLTIP`, and unknown/no-plan users get a generic app or non-app message depending on OS. Outside that promo branch it falls back to a random entry from `ALL_TOOLTIPS`.

The nested `announcement` module manages a cached remote TOML document in `OnceLock<Option<String>>`. `prewarm` starts background initialization; `blocking_init_announcement_tip` fetches the raw TOML over `reqwest::blocking` with `no_proxy()` and a 2-second timeout to avoid proxy-related macOS crashes. `parse_announcement_tip_toml` accepts either a document with `announcements = [...]` or a bare array, converts each raw entry through `AnnouncementTip::from_raw`, and returns the content of the last entry whose version regex, date window, target app (`cli`), optional plan list, and optional OS list all match. Invalid dates, regexes, unknown plan types, and unknown OS values cause individual entries to be discarded rather than poisoning the whole parse.

#### Function details

##### `experimental_tooltips`  (lines 44–49)

```
fn experimental_tooltips() -> Vec<&'static str>
```

**Purpose**: Collects announcement strings for experimental features from the global feature registry. These tips are appended to the normal tooltip pool.

**Data flow**: Iterates `FEATURES`, calls `spec.stage.experimental_announcement()` on each entry, filters out `None`, collects the resulting `&'static str` values into a `Vec`, and returns it.

**Call relations**: Used during lazy initialization of `ALL_TOOLTIPS` to augment static file-based tips with feature-driven announcements.


##### `get_tooltip`  (lines 52–88)

```
fn get_tooltip(plan: Option<PlanType>, fast_mode_enabled: bool) -> Option<String>
```

**Purpose**: Chooses the startup tooltip or announcement to show, prioritizing remotely fetched announcements and otherwise mixing plan-specific promos with random generic tips.

**Data flow**: Takes `plan: Option<PlanType>` and `fast_mode_enabled: bool`, creates a random generator, first queries `announcement::fetch_announcement_tip(plan)`, and returns that if present. Otherwise, with 80% probability it enters a promo branch: paid/team/business-like plans call `pick_paid_tooltip`, free/go plans return `FREE_GO_TOOLTIP`, and all others return either `OTHER_TOOLTIP` or `OTHER_TOOLTIP_NON_MAC` depending on OS. If the promo branch is skipped or yields no paid tooltip, it calls `pick_tooltip` and maps the chosen `&str` to `String`.

**Call relations**: This is the top-level tooltip selector used at startup. It orchestrates plan checks, remote announcement lookup, paid-promo selection, and fallback random-tip selection.

*Call graph*: calls 2 internal fn (pick_paid_tooltip, pick_tooltip); 3 external calls (fetch_announcement_tip, matches!, rng).


##### `paid_app_tooltip`  (lines 90–96)

```
fn paid_app_tooltip() -> Option<&'static str>
```

**Purpose**: Returns the app-promotion tooltip only on platforms where the app is relevant. On unsupported platforms it suppresses that promo entirely.

**Data flow**: Reads compile-time OS booleans and returns `Some(APP_TOOLTIP)` on macOS or Windows, otherwise `None`.

**Call relations**: Used by `pick_paid_tooltip` and directly referenced by tests that verify the paid promo pool.

*Call graph*: called by 3 (pick_paid_tooltip, paid_tooltip_pool_rotates_between_promos, paid_tooltip_pool_skips_fast_when_fast_mode_is_enabled).


##### `pick_paid_tooltip`  (lines 102–111)

```
fn pick_paid_tooltip(
    rng: &mut R,
    fast_mode_enabled: bool,
) -> Option<&'static str>
```

**Purpose**: Chooses between the paid-user app promo and the Fast-mode promo, suppressing the Fast promo when Fast mode is already enabled.

**Data flow**: Takes a mutable RNG and `fast_mode_enabled`. If Fast mode is already enabled or the RNG coin flip returns true, it returns `paid_app_tooltip()`; otherwise it returns `Some(FAST_TOOLTIP)`.

**Call relations**: Called by `get_tooltip` for paid/team/business-like plans. Tests exercise both the rotating-promo behavior and the Fast-enabled suppression rule.

*Call graph*: calls 1 internal fn (paid_app_tooltip); called by 3 (get_tooltip, paid_tooltip_pool_rotates_between_promos, paid_tooltip_pool_skips_fast_when_fast_mode_is_enabled); 1 external calls (random_bool).


##### `pick_tooltip`  (lines 113–121)

```
fn pick_tooltip(rng: &mut R) -> Option<&'static str>
```

**Purpose**: Selects a random tooltip from the combined static and experimental tooltip pool. It returns `None` only when the pool is empty.

**Data flow**: Takes a mutable RNG, checks `ALL_TOOLTIPS.is_empty()`, and otherwise chooses a random index in `0..ALL_TOOLTIPS.len()`, returning the copied `&'static str` at that position.

**Call relations**: Used as the generic fallback by `get_tooltip` and directly by tests that verify deterministic seeded selection.

*Call graph*: called by 2 (get_tooltip, random_tooltip_is_reproducible_with_seed); 1 external calls (random_range).


##### `announcement::prewarm`  (lines 139–141)

```
fn prewarm()
```

**Purpose**: Starts background initialization of the remote announcement-tip cache. It avoids blocking startup on network I/O.

**Data flow**: Spawns a thread whose closure calls `ANNOUNCEMENT_TIP.get_or_init(init_announcement_tip_in_thread)`. It ignores the thread handle and return value.

**Call relations**: Called during startup warmup so later `fetch_announcement_tip` calls can read a ready cache without waiting.

*Call graph*: 1 external calls (spawn).


##### `announcement::fetch_announcement_tip`  (lines 144–150)

```
fn fetch_announcement_tip(plan: Option<PlanType>) -> Option<String>
```

**Purpose**: Returns the parsed announcement tip from the cache if prewarming has already completed. It never blocks waiting for initialization.

**Data flow**: Reads `ANNOUNCEMENT_TIP.get()`, clones the cached `Option<String>` if present, flattens it, then passes the raw TOML string and `plan` into `parse_announcement_tip_toml`, returning the resulting `Option<String>`.

**Call relations**: Called by `get_tooltip` as the highest-priority source of startup messaging. It depends on `prewarm` having populated the cache earlier.


##### `announcement::TargetOs::current`  (lines 190–199)

```
fn current() -> Self
```

**Purpose**: Determines the current target OS as the local `TargetOs` enum used by announcement matching.

**Data flow**: Evaluates compile-time `cfg!(target_os = ...)` checks and returns `TargetOs::Macos`, `Windows`, or `Linux`.

**Call relations**: Used to initialize the module-level `CURRENT_OS` constant, which `parse_announcement_tip_toml` consults when filtering announcements by OS.

*Call graph*: 1 external calls (cfg!).


##### `announcement::init_announcement_tip_in_thread`  (lines 202–207)

```
fn init_announcement_tip_in_thread() -> Option<String>
```

**Purpose**: Runs the blocking announcement fetch inside a nested thread and joins it, returning the fetched raw TOML if successful. This extra indirection isolates the blocking work.

**Data flow**: Spawns a thread running `blocking_init_announcement_tip`, joins it, converts join failure to `None`, and flattens the nested `Option<Option<String>>` into `Option<String>`.

**Call relations**: Used as the initializer passed into `ANNOUNCEMENT_TIP.get_or_init` by `prewarm`.

*Call graph*: 1 external calls (spawn).


##### `announcement::blocking_init_announcement_tip`  (lines 209–221)

```
fn blocking_init_announcement_tip() -> Option<String>
```

**Purpose**: Performs the actual blocking HTTP fetch of the remote announcement-tip TOML document with a short timeout and proxy detection disabled.

**Data flow**: Builds a `reqwest::blocking::Client` with `.no_proxy()`, issues a GET to `ANNOUNCEMENT_TIP_URL`, applies a 2-second timeout, sends the request, checks for HTTP success, extracts the response body text, and returns it as `Option<String>`, converting any failure to `None`.

**Call relations**: Called only by `init_announcement_tip_in_thread` as the network-fetch implementation behind announcement prewarming.

*Call graph*: 2 external calls (from_millis, builder).


##### `announcement::parse_announcement_tip_toml`  (lines 223–256)

```
fn parse_announcement_tip_toml(
        text: &str,
        plan: Option<PlanType>,
    ) -> Option<String>
```

**Purpose**: Parses announcement-tip TOML and returns the content of the last announcement entry that matches the current CLI version, date, target app, optional plan restrictions, and optional OS restrictions.

**Data flow**: Takes raw TOML `text` and optional `plan`. It first tries to deserialize either `AnnouncementTipDocument` or `Vec<AnnouncementTipRaw>`, gets today’s UTC date, then iterates announcements in order. Each raw entry is converted with `AnnouncementTip::from_raw`; invalid entries are skipped. For valid entries it computes plan and OS matches, checks `version_matches`, `date_matches`, and `target_app == "cli"`, and if all pass stores `tip.content` as `latest_match`. After the loop it returns the last stored match.

**Call relations**: Called by `fetch_announcement_tip` and directly by tests. It orchestrates raw parsing, per-entry validation, and matching logic while delegating field normalization to `AnnouncementTip::from_raw`.

*Call graph*: 2 external calls (now, from_raw).


##### `announcement::AnnouncementTip::from_raw`  (lines 259–301)

```
fn from_raw(raw: AnnouncementTipRaw) -> Option<Self>
```

**Purpose**: Validates and normalizes a raw deserialized announcement entry into the internal typed form used for matching. It rejects empty content, invalid dates/regexes, and unknown plan or OS targets.

**Data flow**: Consumes `AnnouncementTipRaw`, trims `content`, parses optional `from_date` and `to_date` with `NaiveDate::parse_from_str`, compiles optional `version_regex` with `Regex::new`, checks optional `target_plan_types` and `target_oses` for `Unknown` values, lowercases `target_app` defaulting to `cli`, and returns `Some(AnnouncementTip)` or `None` on any invalid field.

**Call relations**: Used by `parse_announcement_tip_toml` for per-entry validation and normalization before matching.

*Call graph*: 2 external calls (parse_from_str, new).


##### `announcement::AnnouncementTip::version_matches`  (lines 303–307)

```
fn version_matches(&self, version: &str) -> bool
```

**Purpose**: Checks whether an announcement applies to the given CLI version, treating a missing regex as universally matching.

**Data flow**: Reads `self.version_regex`; if absent returns `true`, otherwise tests `regex.is_match(version)` and returns that boolean.

**Call relations**: Called by `parse_announcement_tip_toml` as one of the filters for selecting the active announcement.


##### `announcement::AnnouncementTip::date_matches`  (lines 309–321)

```
fn date_matches(&self, today: NaiveDate) -> bool
```

**Purpose**: Checks whether a given date falls within the announcement’s active date window, with inclusive `from_date` and exclusive `to_date` semantics.

**Data flow**: Reads `self.from_date` and `self.to_date`; returns `false` if `today < from_date` or `today >= to_date`, otherwise returns `true`.

**Call relations**: Called by `parse_announcement_tip_toml` to enforce announcement scheduling.


##### `tests::random_tooltip_returns_some_tip_when_available`  (lines 333–336)

```
fn random_tooltip_returns_some_tip_when_available()
```

**Purpose**: Verifies that random tooltip selection yields a tip when the tooltip pool is non-empty.

**Data flow**: Seeds a deterministic RNG, calls `pick_tooltip`, and asserts the result is `Some`.

**Call relations**: This test covers the non-empty-pool behavior of `pick_tooltip`.

*Call graph*: 2 external calls (seed_from_u64, assert!).


##### `tests::random_tooltip_is_reproducible_with_seed`  (lines 339–347)

```
fn random_tooltip_is_reproducible_with_seed()
```

**Purpose**: Checks that random tooltip selection is deterministic for a fixed RNG seed.

**Data flow**: Creates two `StdRng` instances with the same seed, calls `pick_tooltip` on each, and asserts the results are equal.

**Call relations**: This test validates that `pick_tooltip` depends only on the supplied RNG state.

*Call graph*: calls 1 internal fn (pick_tooltip); 2 external calls (seed_from_u64, assert_eq!).


##### `tests::paid_tooltip_pool_rotates_between_promos`  (lines 350–361)

```
fn paid_tooltip_pool_rotates_between_promos()
```

**Purpose**: Ensures the paid-user promo slot can produce both the app promo and the Fast promo across different RNG seeds.

**Data flow**: Iterates several seeds, calls `pick_paid_tooltip` with `fast_mode_enabled = false`, inserts results into a `BTreeSet`, and asserts the set equals `{paid_app_tooltip(), Some(FAST_TOOLTIP)}`.

**Call relations**: This test validates the branching behavior of `pick_paid_tooltip` when Fast mode is not already enabled.

*Call graph*: calls 2 internal fn (paid_app_tooltip, pick_paid_tooltip); 4 external calls (seed_from_u64, assert_eq!, from, new).


##### `tests::paid_tooltip_pool_skips_fast_when_fast_mode_is_enabled`  (lines 364–374)

```
fn paid_tooltip_pool_skips_fast_when_fast_mode_is_enabled()
```

**Purpose**: Ensures the Fast promo is never shown once Fast mode is already enabled.

**Data flow**: Iterates several seeds, calls `pick_paid_tooltip` with `fast_mode_enabled = true`, collects results into a set, and asserts the set contains only `paid_app_tooltip()` and not `Some(FAST_TOOLTIP)`.

**Call relations**: This test covers the suppression rule in `pick_paid_tooltip`.

*Call graph*: calls 2 internal fn (paid_app_tooltip, pick_paid_tooltip); 5 external calls (seed_from_u64, assert!, assert_eq!, from, new).


##### `tests::announcement_tip_toml_picks_last_matching`  (lines 377–417)

```
fn announcement_tip_toml_picks_last_matching()
```

**Purpose**: Verifies that when multiple announcements match, the parser returns the content of the last matching entry.

**Data flow**: Builds two TOML samples with multiple announcements, calls `parse_announcement_tip_toml` on each, and asserts the returned string is the later matching content.

**Call relations**: This test validates the overwrite-on-match behavior in `parse_announcement_tip_toml`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_picks_no_match`  (lines 420–437)

```
fn announcement_tip_toml_picks_no_match()
```

**Purpose**: Checks that the parser returns `None` when no announcement satisfies the date/version/app filters.

**Data flow**: Supplies TOML containing only non-matching entries to `parse_announcement_tip_toml` and asserts the result is `None`.

**Call relations**: This test covers the no-match outcome of `parse_announcement_tip_toml`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_bad_deserialization`  (lines 440–448)

```
fn announcement_tip_toml_bad_deserialization()
```

**Purpose**: Ensures malformed TOML field types cause parsing to fail cleanly with `None`.

**Data flow**: Passes TOML with an invalid `content` type into `parse_announcement_tip_toml` and asserts the result is `None`.

**Call relations**: This test covers the top-level deserialization failure path in `parse_announcement_tip_toml`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_parse_comments`  (lines 451–476)

```
fn announcement_tip_toml_parse_comments()
```

**Purpose**: Verifies that TOML comments are tolerated and do not interfere with selecting a valid announcement.

**Data flow**: Supplies a commented TOML document to `parse_announcement_tip_toml` and asserts the expected announcement content is returned.

**Call relations**: This test confirms the parser works with realistic commented configuration files.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_matches_target_plan_type`  (lines 479–509)

```
fn announcement_tip_toml_matches_target_plan_type()
```

**Purpose**: Checks that plan-targeted announcements match only the intended plan types, while unrestricted announcements still apply broadly.

**Data flow**: Builds TOML with unrestricted and plan-restricted announcements, calls `parse_announcement_tip_toml` with several `PlanType` values and `None`, and asserts the expected content each time.

**Call relations**: This test validates the optional plan-filter logic in `parse_announcement_tip_toml`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_rejects_unknown_target_plan_type`  (lines 512–526)

```
fn announcement_tip_toml_rejects_unknown_target_plan_type()
```

**Purpose**: Ensures announcements containing unknown plan-type values are discarded rather than matched.

**Data flow**: Supplies TOML with one unrestricted announcement and one typoed plan-targeted announcement, calls `parse_announcement_tip_toml`, and asserts the unrestricted announcement wins.

**Call relations**: This test exercises the `AnnouncementTip::from_raw` rejection of `PlanType::Unknown` in target lists.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::announcement_tip_toml_matches_target_os`  (lines 529–555)

```
fn announcement_tip_toml_matches_target_os()
```

**Purpose**: Checks that OS-targeted announcements match the current platform and return the corresponding content.

**Data flow**: Builds TOML with Linux, macOS, and Windows announcements, computes the expected string from compile-time `cfg!`, calls `parse_announcement_tip_toml`, and asserts the expected platform-specific result.

**Call relations**: This test validates OS filtering in `parse_announcement_tip_toml` against `CURRENT_OS`.

*Call graph*: 2 external calls (assert_eq!, cfg!).


##### `tests::announcement_tip_toml_rejects_unknown_target_os`  (lines 558–572)

```
fn announcement_tip_toml_rejects_unknown_target_os()
```

**Purpose**: Ensures announcements containing unknown OS values are discarded rather than matched.

**Data flow**: Supplies TOML with one unrestricted announcement and one typoed OS-targeted announcement, calls `parse_announcement_tip_toml`, and asserts the unrestricted announcement is returned.

**Call relations**: This test exercises the `AnnouncementTip::from_raw` rejection of `TargetOs::Unknown` in target lists.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/update_prompt.rs`

`orchestration` · `startup prompt before entering the main interactive session`

This release-only file contains both the orchestration for showing the update popup and the widget/state machine that drives it. `run_update_prompt_if_needed` is the top-level async flow: it first asks `updates::get_upgrade_version_for_popup` whether a newer version should be shown, then asks `crate::update_action::get_update_action` whether the current installation method supports a concrete update command. If either answer is absent, it exits immediately with `Continue`.

When a prompt is needed, it constructs `UpdatePromptScreen`, renders it once, then enters an event loop over the TUI stream. Key events are delegated to `handle_key`; draw and resize events trigger a redraw; paste is ignored. The loop ends when the screen records a selection or the stream closes. The final selection is interpreted into `UpdatePromptOutcome`: `UpdateNow` clears the terminal and returns `RunUpdate(update_action)`, `NotNow` continues silently, and `DontRemind` asynchronously persists a dismissal for the exact latest version while logging any persistence failure.

`UpdatePromptScreen` stores immutable prompt context (`latest_version`, compile-time `current_version`, `update_action`) plus mutable UI state (`highlighted`, `selection`) and a `FrameRequester` used to schedule redraws only when state changes. Navigation wraps cyclically through `UpdateSelection::{UpdateNow, NotNow, DontRemind}`. `handle_key` ignores key-release events, treats Ctrl-C/Ctrl-D as a skip, supports vim-style `j`/`k`, numeric shortcuts `1`-`3`, Enter to confirm the highlighted row, and Esc to skip. Rendering builds a centered column with the version transition, release-notes URL, the exact update command string, three selectable rows, and an Enter hint, then marks the underlined URL as a terminal hyperlink.

#### Function details

##### `run_update_prompt_if_needed`  (lines 37–86)

```
async fn run_update_prompt_if_needed(
    tui: &mut Tui,
    config: &Config,
) -> Result<UpdatePromptOutcome>
```

**Purpose**: Determines whether an update popup should appear, runs the modal event loop if so, and converts the user's choice into a high-level outcome.

**Data flow**: It takes mutable access to `Tui` and shared `Config`. It reads the latest eligible version via `updates::get_upgrade_version_for_popup` and the current install's update mechanism via `get_update_action`; if either is missing it returns `UpdatePromptOutcome::Continue`. Otherwise it constructs an `UpdatePromptScreen`, draws it, consumes events from `tui.event_stream()`, and repeatedly forwards key events to `screen.handle_key` or redraws on draw/resize. After the loop, it reads `screen.selection()` and either clears the terminal and returns `RunUpdate(update_action)`, returns `Continue`, or calls `updates::dismiss_version(config, screen.latest_version()).await` before continuing. On dismissal-write failure it logs an error but still continues.

**Call relations**: This function is invoked by `run_ratatui_app` as a pre-main-loop gate. It delegates UI state transitions to `UpdatePromptScreen` methods and persistence to `updates::dismiss_version`, while relying on `updates` and `update_action` to decide whether the prompt is even applicable.

*Call graph*: calls 3 internal fn (get_update_action, new, get_upgrade_version_for_popup); called by 1 (run_ratatui_app); 7 external calls (draw, event_stream, frame_requester, pin!, error!, RunUpdate, dismiss_version).


##### `UpdatePromptScreen::new`  (lines 105–118)

```
fn new(
        request_frame: FrameRequester,
        latest_version: String,
        update_action: UpdateAction,
    ) -> Self
```

**Purpose**: Creates the prompt state object with the current and latest versions, update command source, and default selection state.

**Data flow**: It takes a `FrameRequester`, the fetched `latest_version`, and an `UpdateAction`. It stores those values, reads the compile-time package version from `env!("CARGO_PKG_VERSION")` into `current_version`, initializes `highlighted` to `UpdateNow`, and leaves `selection` as `None`. It returns a fully initialized `UpdatePromptScreen`.

**Call relations**: This constructor is used by the runtime prompt flow and by tests via `new_prompt`. Its initialization choices define the prompt's default focus and the version text rendered by `render_ref`.

*Call graph*: called by 2 (run_update_prompt_if_needed, new_prompt); 1 external calls (env!).


##### `UpdatePromptScreen::handle_key`  (lines 120–140)

```
fn handle_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Interprets a single keyboard event and updates highlight or final selection according to the prompt's key bindings.

**Data flow**: It takes mutable `self` and a `KeyEvent`. It first ignores release events. If Control is held with `c` or `d`, it immediately selects `NotNow`. Otherwise it matches on `key_event.code`: Up/`k` moves to `prev()`, Down/`j` moves to `next()`, `1`/`2`/`3` directly select the corresponding option, Enter selects the currently highlighted option, Esc selects `NotNow`, and all other keys are ignored. State changes occur through `set_highlight` or `select`, both of which may schedule a redraw.

**Call relations**: This is called from the event loop in `run_update_prompt_if_needed`. It delegates wraparound navigation to `UpdateSelection::next`/`prev` and centralizes all user-input semantics for the modal.

*Call graph*: calls 4 internal fn (select, set_highlight, next, prev); 1 external calls (matches!).


##### `UpdatePromptScreen::set_highlight`  (lines 142–147)

```
fn set_highlight(&mut self, highlight: UpdateSelection)
```

**Purpose**: Changes the currently highlighted option only when it actually differs, and requests a redraw for visible navigation changes.

**Data flow**: It takes mutable `self` and a target `UpdateSelection`. If the new value differs from `self.highlighted`, it updates that field and calls `self.request_frame.schedule_frame()`. It returns no value and leaves `selection` untouched.

**Call relations**: This helper is used by `handle_key` for non-committing navigation. The equality guard avoids unnecessary redraw scheduling when repeated keys would not change the visible state.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key).


##### `UpdatePromptScreen::select`  (lines 149–153)

```
fn select(&mut self, selection: UpdateSelection)
```

**Purpose**: Commits a final prompt choice and schedules one more frame so the selected state can be rendered before exit.

**Data flow**: It takes mutable `self` and a chosen `UpdateSelection`, writes that value into both `highlighted` and `selection`, and calls `schedule_frame()` on the stored `FrameRequester`. It returns no value.

**Call relations**: This is the committing counterpart to `set_highlight`, called by `handle_key` for Enter, numeric shortcuts, Ctrl-C/Ctrl-D, and Esc. `run_update_prompt_if_needed` later observes the committed state through `is_done` and `selection`.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key).


##### `UpdatePromptScreen::is_done`  (lines 155–157)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the prompt has received a final selection and should stop consuming events.

**Data flow**: It reads `self.selection` and returns `true` when it is `Some(_)`, otherwise `false`. No state is modified.

**Call relations**: The event loop in `run_update_prompt_if_needed` uses this as its termination condition.


##### `UpdatePromptScreen::selection`  (lines 159–161)

```
fn selection(&self) -> Option<UpdateSelection>
```

**Purpose**: Exposes the committed selection, if any, for post-loop outcome handling.

**Data flow**: It reads and returns `self.selection` as `Option<UpdateSelection>`. No mutation occurs.

**Call relations**: After the modal loop ends, `run_update_prompt_if_needed` calls this to decide whether to run an update, continue, or persist a dismissal.


##### `UpdatePromptScreen::latest_version`  (lines 163–165)

```
fn latest_version(&self) -> &str
```

**Purpose**: Returns the fetched latest version string associated with this prompt.

**Data flow**: It borrows `self.latest_version` and returns it as `&str`. No state changes occur.

**Call relations**: This accessor is used when the user chooses `DontRemind`, so `run_update_prompt_if_needed` can persist dismissal for the exact version shown.


##### `UpdateSelection::next`  (lines 169–175)

```
fn next(self) -> Self
```

**Purpose**: Advances the highlighted option to the next menu entry with wraparound.

**Data flow**: It matches on the current enum value and returns `NotNow` after `UpdateNow`, `DontRemind` after `NotNow`, and wraps back to `UpdateNow` after `DontRemind`. It is pure and side-effect free.

**Call relations**: Called by `handle_key` for Down and `j` navigation to implement cyclic movement through the three choices.

*Call graph*: called by 1 (handle_key).


##### `UpdateSelection::prev`  (lines 177–183)

```
fn prev(self) -> Self
```

**Purpose**: Moves the highlighted option to the previous menu entry with wraparound.

**Data flow**: It matches on the current enum value and returns `DontRemind` before `UpdateNow`, `UpdateNow` before `NotNow`, and `NotNow` before `DontRemind`. It returns the new enum value without mutating external state.

**Call relations**: Called by `handle_key` for Up and `k` navigation to implement reverse cyclic movement.

*Call graph*: called by 1 (handle_key).


##### `UpdatePromptScreen::render_ref`  (lines 187–240)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the update modal, including version information, release-notes link, selectable actions, and the exact update command.

**Data flow**: Given a `Rect` and mutable `Buffer`, it first clears the target area, creates a `ColumnRenderable`, and computes `update_command` by calling `self.update_action.command_str()`. It then pushes blank lines, a styled title line with emoji and `current_version -> latest_version`, an inset release-notes line using `RELEASE_NOTES_URL`, three `selection_option_row` entries keyed to the current `highlighted` state, and an Enter key hint. Finally it renders the column into the buffer and marks the underlined release-notes URL as a hyperlink via `mark_underlined_hyperlink`.

**Call relations**: This widget implementation is invoked by the TUI draw closures in `run_update_prompt_if_needed` and by the snapshot test. It depends on `command_str` so the displayed command matches the actual update action.

*Call graph*: calls 5 internal fn (tlbr, new, selection_option_row, mark_underlined_hyperlink, command_str); 3 external calls (from, format!, vec!).


##### `tests::new_prompt`  (lines 253–259)

```
fn new_prompt() -> UpdatePromptScreen
```

**Purpose**: Builds a deterministic prompt instance for tests with a dummy frame requester, fixed latest version, and npm update action.

**Data flow**: It creates a `FrameRequester::test_dummy()`, passes it with `"9.9.9"` and `UpdateAction::NpmGlobalLatest` into `UpdatePromptScreen::new`, and returns the resulting screen.

**Call relations**: This helper is shared by all prompt tests to keep setup consistent and focused on behavior under test.

*Call graph*: calls 2 internal fn (test_dummy, new).


##### `tests::update_prompt_snapshot`  (lines 262–269)

```
fn update_prompt_snapshot()
```

**Purpose**: Verifies the rendered modal layout and styling against a stored snapshot.

**Data flow**: It creates a test prompt, constructs a `Terminal` backed by `VT100Backend`, renders the widget into an 80x12 frame, and passes the backend contents to `insta::assert_snapshot!`. It writes only to the in-memory test terminal.

**Call relations**: This test exercises `render_ref` end-to-end, catching regressions in text, ordering, spacing, and selection-row rendering.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_snapshot!, new, new_prompt).


##### `tests::update_prompt_confirm_selects_update`  (lines 272–277)

```
fn update_prompt_confirm_selects_update()
```

**Purpose**: Checks that pressing Enter on the default highlight commits the `UpdateNow` choice.

**Data flow**: It creates a mutable prompt, sends an Enter `KeyEvent` to `handle_key`, then asserts `is_done()` is true and `selection()` equals `Some(UpdateSelection::UpdateNow)`. No external state is touched.

**Call relations**: This test validates the default-highlight initialization from `new` and the Enter-selection path in `handle_key`.

*Call graph*: 4 external calls (new, assert!, assert_eq!, new_prompt).


##### `tests::update_prompt_dismiss_option_leaves_prompt_in_normal_state`  (lines 280–286)

```
fn update_prompt_dismiss_option_leaves_prompt_in_normal_state()
```

**Purpose**: Checks that moving down once and confirming selects the ordinary skip option.

**Data flow**: It creates a prompt, sends Down then Enter key events through `handle_key`, and asserts the prompt is done with `selection()` equal to `Some(UpdateSelection::NotNow)`.

**Call relations**: This covers the navigation-plus-confirm flow through `set_highlight`, `next`, and `select` for the middle menu entry.

*Call graph*: 4 external calls (new, assert!, assert_eq!, new_prompt).


##### `tests::update_prompt_dont_remind_selects_dismissal`  (lines 289–296)

```
fn update_prompt_dont_remind_selects_dismissal()
```

**Purpose**: Checks that navigating to the third option and confirming records the dismissal choice.

**Data flow**: It creates a prompt, sends two Down events and then Enter, and asserts completion with `selection()` equal to `Some(UpdateSelection::DontRemind)`.

**Call relations**: This test exercises wrap-free downward navigation across multiple entries and the final selection path used by dismissal persistence.

*Call graph*: 4 external calls (new, assert!, assert_eq!, new_prompt).


##### `tests::update_prompt_ctrl_c_skips_update`  (lines 299–304)

```
fn update_prompt_ctrl_c_skips_update()
```

**Purpose**: Verifies that Ctrl-C is treated as a safe skip rather than an update confirmation.

**Data flow**: It creates a prompt, sends a `KeyEvent` for Control-`c` to `handle_key`, then asserts the prompt is done and selected `NotNow`.

**Call relations**: This covers the early control-key branch in `handle_key`, which is important because the runtime loop treats prompt cancellation as continue rather than process abort.

*Call graph*: 5 external calls (Char, new, assert!, assert_eq!, new_prompt).


##### `tests::update_prompt_navigation_wraps_between_entries`  (lines 307–313)

```
fn update_prompt_navigation_wraps_between_entries()
```

**Purpose**: Verifies cyclic navigation at the top and bottom of the three-option menu.

**Data flow**: It creates a prompt, sends Up once and checks `highlighted` wrapped to `DontRemind`, then sends Down once and checks it returned to `UpdateNow`.

**Call relations**: This test directly validates the wraparound behavior implemented by `UpdateSelection::prev` and `next` and used by `handle_key`.

*Call graph*: 3 external calls (new, assert_eq!, new_prompt).


### `tui/src/cwd_prompt.rs`

`domain_logic` · `interactive modal / request handling`

This file defines a small interactive modal with two choices and a simple event loop. `run_cwd_selection_prompt` constructs a `CwdPromptScreen`, renders it once, then listens to the TUI event stream until the screen reports completion or the stream ends. Key events are routed into the screen state machine; draw and resize events trigger a redraw; paste events are ignored. The final outcome is either `Exit` for Ctrl-C/Ctrl-D cancellation or `Selection(...)`, defaulting to `Session` if the screen somehow finishes without an explicit stored selection.

The state model is intentionally compact: `CwdPromptAction` controls wording (`resume`/`fork` and past participles), `CwdSelection` tracks the highlighted and chosen option, and `CwdPromptScreen` stores the rendered cwd strings, current highlight, optional final selection, and an exit flag. Navigation wraps between the two options because `next` and `prev` both toggle between `Current` and `Session`. `handle_key` ignores key-release events, treats Ctrl-C/Ctrl-D as immediate exit, supports vim-style and arrow navigation, numeric shortcuts (`1` for session, `2` for current), Enter to accept the highlighted option, and Esc as an explicit “use session directory” shortcut.

Rendering clears the modal area and builds a vertical `ColumnRenderable` containing explanatory text, two `selection_option_row` entries, and a footer hint. The copy is concrete: it explains what “Session” and “Current” mean and interpolates the actual directory paths into the option labels.

#### Function details

##### `CwdPromptAction::verb`  (lines 33–38)

```
fn verb(self) -> &'static str
```

**Purpose**: Maps the action enum to the present-tense verb shown in the prompt heading.

**Data flow**: Reads `self` and returns either `"resume"` or `"fork"` as a `&'static str`.

**Call relations**: Used during widget rendering to build the main prompt sentence.

*Call graph*: called by 1 (render_ref).


##### `CwdPromptAction::past_participle`  (lines 40–45)

```
fn past_participle(self) -> &'static str
```

**Purpose**: Maps the action enum to the past participle used in the explanatory session-directory text.

**Data flow**: Reads `self` and returns either `"resumed"` or `"forked"`.

**Call relations**: Used by `render_ref` when describing where the session cwd came from.

*Call graph*: called by 1 (render_ref).


##### `CwdSelection::next`  (lines 61–66)

```
fn next(self) -> Self
```

**Purpose**: Returns the next selectable cwd option. Because there are only two options, this simply toggles to the other one.

**Data flow**: Matches on `self` and returns `Session` for `Current` or `Current` for `Session`.

**Call relations**: Called by `handle_key` for Down/j navigation.

*Call graph*: called by 1 (handle_key).


##### `CwdSelection::prev`  (lines 68–73)

```
fn prev(self) -> Self
```

**Purpose**: Returns the previous selectable cwd option. With two options, it is the same toggle behavior as `next`.

**Data flow**: Matches on `self` and returns the opposite variant.

**Call relations**: Called by `handle_key` for Up/k navigation.

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

**Purpose**: Runs the full asynchronous cwd-selection modal until the user chooses an option, exits, or the event stream ends.

**Data flow**: Takes mutable `Tui`, action, and two `&Path`s; converts the paths to display strings, constructs `CwdPromptScreen`, draws it, then consumes `tui.event_stream()` in a loop. Key events mutate screen state, draw/resize events redraw, and on completion it returns `CwdPromptOutcome::Exit` or `Selection(...)`.

**Call relations**: Invoked by resume/fork orchestration. It owns the event loop and delegates all state transitions to `CwdPromptScreen::handle_key`.

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

**Purpose**: Creates the prompt screen state with the session directory highlighted by default and no final selection yet.

**Data flow**: Stores the provided `FrameRequester`, action, cwd strings, initializes `highlighted` to `Session`, `selection` to `None`, and `should_exit` to `false`.

**Call relations**: Used by the async prompt runner and tests to create a fresh modal state.

*Call graph*: called by 3 (run_cwd_selection_prompt, cwd_prompt_fork_snapshot, new_prompt).


##### `CwdPromptScreen::handle_key`  (lines 148–169)

```
fn handle_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Implements all keyboard behavior for the modal, including navigation, selection, and Ctrl-C/Ctrl-D exit.

**Data flow**: Reads a `KeyEvent`; ignores release events, checks for control-exit combos, otherwise matches on `key_event.code` to move highlight, select explicit options, accept the current highlight, or map Esc to session selection. It mutates `highlighted`, `selection`, `should_exit`, and schedules redraws through `request_frame` as needed.

**Call relations**: Called from the outer event loop whenever a key event arrives. It delegates highlight changes to `set_highlight` and final choices to `select`.

*Call graph*: calls 5 internal fn (select, set_highlight, next, prev, schedule_frame); 1 external calls (matches!).


##### `CwdPromptScreen::set_highlight`  (lines 171–176)

```
fn set_highlight(&mut self, highlight: CwdSelection)
```

**Purpose**: Updates the highlighted option only when it actually changes, avoiding unnecessary redraw requests.

**Data flow**: Compares the new `highlight` against `self.highlighted`; if different, stores it and calls `request_frame.schedule_frame()`.

**Call relations**: Used by `handle_key` for navigation keys.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key).


##### `CwdPromptScreen::select`  (lines 178–182)

```
fn select(&mut self, selection: CwdSelection)
```

**Purpose**: Marks a cwd option as chosen and aligns the highlight with that final selection.

**Data flow**: Stores `selection` into both `self.highlighted` and `self.selection`, then schedules a frame.

**Call relations**: Used by `handle_key` for Enter, Esc, and numeric shortcuts.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_key).


##### `CwdPromptScreen::is_done`  (lines 184–186)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the modal should stop processing events.

**Data flow**: Returns `true` if `should_exit` is set or `selection` is `Some(_)`.

**Call relations**: Polled by the outer async loop in `run_cwd_selection_prompt`.


##### `CwdPromptScreen::selection`  (lines 188–190)

```
fn selection(&self) -> Option<CwdSelection>
```

**Purpose**: Returns the currently chosen cwd option, if any.

**Data flow**: Reads and returns `self.selection`.

**Call relations**: Used after the event loop and in tests to inspect final state.


##### `CwdPromptScreen::render_ref`  (lines 194–247)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the cwd-selection modal contents into the provided buffer. It renders explanatory copy, both selectable options, and the Enter key hint.

**Data flow**: Clears the target `Rect`, builds a `ColumnRenderable`, derives action wording from `verb()` and `past_participle()`, inserts descriptive `Line`s and `selection_option_row(...)` entries using the stored cwd strings and current highlight, then renders the column into `buf`.

**Call relations**: Called by the TUI draw closure through `WidgetRef`; it is the sole presentation layer for this modal.

*Call graph*: calls 5 internal fn (past_participle, verb, tlbr, new, selection_option_row); 3 external calls (from, format!, vec!).


##### `tests::new_prompt`  (lines 259–266)

```
fn new_prompt() -> CwdPromptScreen
```

**Purpose**: Creates a standard prompt fixture for tests with fixed example paths and the `Resume` action.

**Data flow**: Constructs a `CwdPromptScreen` using `FrameRequester::test_dummy()` and hard-coded cwd strings.

**Call relations**: Shared helper for snapshot and interaction tests.

*Call graph*: calls 2 internal fn (new, test_dummy).


##### `tests::cwd_prompt_snapshot`  (lines 269–277)

```
fn cwd_prompt_snapshot()
```

**Purpose**: Snapshot-tests the default resume prompt rendering.

**Data flow**: Builds the fixture screen, renders it into a `ratatui::Terminal<VT100Backend>`, and snapshots the backend contents.

**Call relations**: Validates the visual layout and copy produced by `render_ref`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_snapshot!, new, new_prompt).


##### `tests::cwd_prompt_fork_snapshot`  (lines 280–293)

```
fn cwd_prompt_fork_snapshot()
```

**Purpose**: Snapshot-tests the prompt wording when the action is `Fork` instead of `Resume`.

**Data flow**: Constructs a `CwdPromptScreen` with `Fork`, renders it, and snapshots the terminal output.

**Call relations**: Ensures `verb` and `past_participle` affect the rendered copy correctly.

*Call graph*: calls 3 internal fn (new, new, test_dummy); 2 external calls (assert_snapshot!, new).


##### `tests::cwd_prompt_selects_session_by_default`  (lines 296–300)

```
fn cwd_prompt_selects_session_by_default()
```

**Purpose**: Verifies that pressing Enter immediately accepts the default highlighted session directory.

**Data flow**: Creates the fixture prompt, sends an Enter `KeyEvent`, and asserts `selection()` is `Some(Session)`.

**Call relations**: Covers the default-highlight behavior in `handle_key`.

*Call graph*: 3 external calls (new, assert_eq!, new_prompt).


##### `tests::cwd_prompt_can_select_current`  (lines 303–308)

```
fn cwd_prompt_can_select_current()
```

**Purpose**: Verifies that moving down once and pressing Enter selects the current directory option.

**Data flow**: Creates the fixture prompt, sends Down then Enter key events, and asserts the final selection is `Some(Current)`.

**Call relations**: Exercises navigation plus selection flow.

*Call graph*: 3 external calls (new, assert_eq!, new_prompt).


##### `tests::cwd_prompt_ctrl_c_exits_instead_of_selecting`  (lines 311–316)

```
fn cwd_prompt_ctrl_c_exits_instead_of_selecting()
```

**Purpose**: Checks that Ctrl-C cancels the modal rather than choosing an option.

**Data flow**: Creates the fixture prompt, sends a Ctrl-C key event, then asserts `selection()` is `None` and `is_done()` is true.

**Call relations**: Covers the explicit exit path in `handle_key`.

*Call graph*: 5 external calls (Char, new, assert!, assert_eq!, new_prompt).


### Onboarding and migration flows
These files implement the first-run onboarding experience and related interactive migration/import prompts shown during startup.

### `tui/src/onboarding/mod.rs`

`orchestration` · `startup`

This file is the top-level module declaration for onboarding-related functionality. It declares internal submodules `auth`, `keys`, `trust_directory`, and `welcome`, and exposes `onboarding_screen` as `pub(crate)` so other parts of the crate can drive the onboarding UI. In addition to wiring the module tree together, it re-exports `mark_underlined_hyperlink` and `mark_url_hyperlink` from `auth`, making those text-markup helpers available through the onboarding namespace instead of forcing callers to depend on the lower-level `auth` module directly. That suggests the authentication flow owns the logic for annotating or styling clickable links shown during onboarding, while the broader onboarding package is the intended integration surface. There is no executable logic here; its importance is organizational. By centralizing declarations and re-exports, it defines what onboarding internals remain private and what capabilities are shared with sibling modules. The split also hints at the onboarding flow’s composition: welcome messaging, trust-directory prompts, authentication-specific behavior, and a screen-level coordinator live in separate files under one cohesive subsystem.


### `tui/src/onboarding/keys.rs`

`config` · `startup`

This module is a constant table of onboarding-specific key bindings. It imports `crossterm::event::KeyCode` and `KeyModifiers`, plus the crate’s `key_hint::KeyBinding` type and helper constructors, then defines named arrays for each onboarding action. The bindings are intentionally redundant in places: movement supports both arrow keys and Vim-style `j`/`k`; first and second choices can be selected by numeric keys or mnemonic letters (`y`/`n`); quitting accepts `q`, `Ctrl-C`, or `Ctrl-D`. `CONFIRM` is bound to Enter and `CANCEL` to Escape. `TOGGLE_ANIMATION` is notable because it supports two equivalent representations of Control-period: one built through `key_hint::ctrl(KeyCode::Char('.'))`, and one explicitly constructed with `KeyModifiers::CONTROL.union(KeyModifiers::SHIFT)`, accounting for terminals that report `.` as shifted. All values are `pub(crate)` constants, so onboarding screens can match against a stable set of shortcuts without consulting user settings or runtime configuration. The file’s main design constraint is predictability during first-run flows: these bindings must work before any customization UI or persisted config has been loaded, so they are hard-coded and self-contained.


### `tui/src/onboarding/onboarding_screen.rs`

`orchestration` · `startup onboarding loop`

This module assembles onboarding as an ordered list of `Step` enum variants wrapping `WelcomeWidget`, `AuthModeWidget`, and `TrustDirectoryWidget`. `OnboardingScreen::new` decides which steps exist based on startup arguments and config: it always creates welcome, conditionally adds auth if a login screen is requested and an app-server handle is available, and conditionally adds trust-directory selection using the resolved Git repository root as the trust target. The screen tracks `is_done` and `should_exit` separately so onboarding can complete normally or request process exit.

A key design choice is `current_steps`/`current_steps_mut`: completed steps remain visible, hidden steps are skipped, and iteration stops at the first in-progress step, which becomes the active recipient of input. Top-level keyboard handling also enforces a cross-step safety rule for API-key entry: printable quit bindings are suppressed only when the auth widget is actively editing a non-empty API-key field, while control/alt quit chords still work. Quitting during an in-progress auth attempt cancels the active login and marks the app for exit.

Rendering clears the screen, propagates animation suppression from auth to welcome, then measures each visible step in a scratch buffer to stack them vertically with dynamic heights. `run_onboarding_app` drives the event loop over TUI events and optional app-server events, persists trust selections once chosen, performs a one-time full terminal clear after the ChatGPT success message to reset lingering underline/color state, and returns whether trust was persisted and whether the app should exit.

#### Function details

##### `KeyboardHandler::handle_paste`  (lines 62–62)

```
fn handle_paste(&mut self, _pasted: String)
```

**Purpose**: Provides a default no-op paste handler for onboarding widgets that do not care about pasted text. It lets implementors override paste handling only when needed.

**Data flow**: Accepts a pasted `String` parameter and ignores it. It returns `()` and mutates no state.

**Call relations**: Inherited by widgets implementing `KeyboardHandler` unless they provide their own paste behavior, such as auth and trust-related steps.


##### `OnboardingScreen::new`  (lines 105–169)

```
async fn new(tui: &mut Tui, args: OnboardingScreenArgs) -> Self
```

**Purpose**: Builds the onboarding screen and its ordered step list from startup arguments and config. It decides which steps are present and initializes each widget with the right policy and environment.

**Data flow**: Consumes `OnboardingScreenArgs` plus a mutable `Tui`, reads config fields like `cwd`, `forced_login_method`, and animation settings, constructs a welcome step, optionally constructs an auth step with fresh locks and the provided app-server handle, optionally resolves a trust target via `resolve_root_git_project_for_trust` and constructs a trust step, then returns a populated `OnboardingScreen` with `is_done` and `should_exit` false.

**Call relations**: Called once by `run_onboarding_app` during onboarding startup. It wires together the lower-level step widgets and emits a warning instead of creating auth if login was requested without an app-server handle.

*Call graph*: calls 2 internal fn (new, level_from_config); called by 1 (run_onboarding_app); 11 external calls (new, new, new, resolve_root_git_project_for_trust, frame_requester, Auth, TrustDirectory, Welcome, matches!, new (+1 more)).


##### `OnboardingScreen::current_steps_mut`  (lines 171–184)

```
fn current_steps_mut(&mut self) -> Vec<&mut Step>
```

**Purpose**: Returns the currently visible prefix of steps, mutable, stopping after the first in-progress step. This defines which steps are rendered and which step is considered active for input.

**Data flow**: Iterates `self.steps`, reads each step's `StepState`, skips hidden steps, pushes complete steps into an output vector, and pushes then stops at the first in-progress step. It returns `Vec<&mut Step>` without mutating step state itself.

**Call relations**: Used by `handle_key_event` and `handle_paste` to route input to the active step while still allowing earlier completed steps to remain visible.

*Call graph*: called by 2 (handle_key_event, handle_paste); 1 external calls (new).


##### `OnboardingScreen::current_steps`  (lines 186–199)

```
fn current_steps(&self) -> Vec<&Step>
```

**Purpose**: Returns the currently visible prefix of steps, immutable, using the same hidden/complete/in-progress cutoff logic as the mutable variant. It is the read-only view used for rendering and animation decisions.

**Data flow**: Iterates `self.steps`, inspects each `StepState`, accumulates visible steps until the first in-progress step, and returns `Vec<&Step>`. It does not mutate state.

**Call relations**: Called by `render_ref` to know which steps to draw and by `should_suppress_animations` to inspect visible auth state.

*Call graph*: called by 2 (render_ref, should_suppress_animations); 1 external calls (new).


##### `OnboardingScreen::should_suppress_animations`  (lines 201–208)

```
fn should_suppress_animations(&self) -> bool
```

**Purpose**: Determines whether onboarding-wide animations should be frozen because the auth step is showing copyable login material. This prevents redraws from interfering with text selection.

**Data flow**: Reads the current visible steps via `current_steps` and returns `true` if any visible `Step::Auth` widget reports `should_suppress_animations()`. It writes no state.

**Call relations**: Queried by `render_ref` before rendering so it can propagate the suppression flag into welcome and auth widgets.

*Call graph*: calls 1 internal fn (current_steps); called by 1 (render_ref).


##### `OnboardingScreen::is_auth_in_progress`  (lines 210–214)

```
fn is_auth_in_progress(&self) -> bool
```

**Purpose**: Reports whether an auth step exists and is currently the in-progress step. This is used to decide whether quitting should also cancel an active login attempt.

**Data flow**: Scans `self.steps` and returns `true` if any step is `Step::Auth(_)` whose `get_step_state()` is `StepState::InProgress`. It does not mutate state.

**Call relations**: Used by `handle_key_event` in the quit path to decide whether to call `cancel_auth_if_active` and mark the app for exit.

*Call graph*: called by 1 (handle_key_event).


##### `OnboardingScreen::is_done`  (lines 216–222)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether onboarding has finished, either because it was explicitly marked done or because no step remains in progress. It is the loop condition for the onboarding event loop.

**Data flow**: Reads `self.is_done` and scans `self.steps` for any `StepState::InProgress`, returning `true` if the explicit flag is set or no in-progress steps remain. It writes nothing.

**Call relations**: Polled by `run_onboarding_app` in its main loop condition.


##### `OnboardingScreen::should_exit`  (lines 224–226)

```
fn should_exit(&self) -> bool
```

**Purpose**: Returns whether onboarding requested process exit rather than normal continuation. This is surfaced in the final `OnboardingResult`.

**Data flow**: Reads and returns `self.should_exit`. It has no side effects.

**Call relations**: Called by `run_onboarding_app` when constructing the final result.


##### `OnboardingScreen::cancel_auth_if_active`  (lines 228–234)

```
fn cancel_auth_if_active(&self)
```

**Purpose**: Cancels any auth widget's active login attempt if an auth step is present. It is a flow-level cleanup helper used during quit handling.

**Data flow**: Iterates `self.steps`, finds `Step::Auth` variants, and calls `widget.cancel_active_attempt()` on each. It returns `()` and mutates auth widget state through that delegated call.

**Call relations**: Used by `handle_key_event` when the user quits while auth is in progress.

*Call graph*: called by 1 (handle_key_event).


##### `OnboardingScreen::auth_widget_mut`  (lines 236–241)

```
fn auth_widget_mut(&mut self) -> Option<&mut AuthModeWidget>
```

**Purpose**: Returns a mutable reference to the auth widget if the onboarding screen contains one. It is a convenience accessor for notification handling.

**Data flow**: Iterates `self.steps`, returning `Some(&mut AuthModeWidget)` for the first `Step::Auth` found or `None` otherwise. It does not mutate state itself.

**Call relations**: Used by `handle_app_server_notification` to forward account-related notifications into the auth step.

*Call graph*: called by 1 (handle_app_server_notification).


##### `OnboardingScreen::handle_app_server_notification`  (lines 243–257)

```
fn handle_app_server_notification(&mut self, notification: ServerNotification)
```

**Purpose**: Routes relevant app-server notifications to the auth widget and ignores unrelated notifications. It keeps onboarding auth state synchronized with server-side account events.

**Data flow**: Consumes a `ServerNotification`, pattern-matches it, and if it is `AccountLoginCompleted` or `AccountUpdated`, obtains the auth widget via `auth_widget_mut` and forwards the notification. It returns `()` and mutates auth state only through those delegated handlers.

**Call relations**: Called from the app-server branch of `run_onboarding_app`'s `tokio::select!` loop.

*Call graph*: calls 1 internal fn (auth_widget_mut).


##### `OnboardingScreen::api_key_entry_context`  (lines 259–273)

```
fn api_key_entry_context(&self) -> ApiKeyEntryContext
```

**Purpose**: Extracts the auth widget's API-key-entry status into a small value object used by quit-suppression logic. It decouples top-level key handling from auth internals.

**Data flow**: Scans `self.steps` for an auth widget, reads `is_api_key_entry_active()` and `api_key_entry_has_text()`, and returns an `ApiKeyEntryContext`; if no auth step exists, it returns the default inactive/empty context. It writes no state.

**Call relations**: Called by `handle_key_event` before evaluating quit bindings.

*Call graph*: called by 1 (handle_key_event).


##### `OnboardingScreen::handle_key_event`  (lines 284–323)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Implements top-level onboarding keyboard routing, including quit handling, API-key text-entry protection, welcome-step compatibility handling, active-step dispatch, trust-step exit detection, and redraw scheduling. It is the central synchronous controller for onboarding input.

**Data flow**: Consumes a `KeyEvent`, ignores non-press/non-repeat kinds, computes `ApiKeyEntryContext`, evaluates whether the event should trigger quit using `suppress_quit_while_typing_api_key`, and either marks onboarding done/exit (cancelling auth if needed) or forwards the event first to the welcome step and then to the last visible current step. After delegated handling it checks whether any trust widget requested quit, updates `should_exit`/`is_done` accordingly, and schedules a frame.

**Call relations**: Called from `run_onboarding_app` for every key event. It delegates quit suppression to `suppress_quit_while_typing_api_key`, auth cleanup to `cancel_auth_if_active`, and per-step behavior to `current_steps_mut` and each step's `KeyboardHandler` implementation.

*Call graph*: calls 6 internal fn (api_key_entry_context, cancel_auth_if_active, current_steps_mut, is_auth_in_progress, suppress_quit_while_typing_api_key, schedule_frame); 1 external calls (matches!).


##### `OnboardingScreen::handle_paste`  (lines 325–334)

```
fn handle_paste(&mut self, pasted: String)
```

**Purpose**: Routes pasted text to the currently active onboarding step and schedules a redraw. It ignores empty paste payloads.

**Data flow**: Takes a pasted `String`, returns early if it is empty, otherwise finds the last visible current step via `current_steps_mut`, calls that step's `handle_paste`, and schedules a frame. It mutates step state only through the delegated handler.

**Call relations**: Called from `run_onboarding_app` on `TuiEvent::Paste`. In practice this mainly matters for auth API-key entry.

*Call graph*: calls 2 internal fn (current_steps_mut, schedule_frame).


##### `suppress_quit_while_typing_api_key`  (lines 343–353)

```
fn suppress_quit_while_typing_api_key(
    key_event: KeyEvent,
    api_key_entry_context: ApiKeyEntryContext,
) -> bool
```

**Purpose**: Decides whether a quit shortcut should be treated as ordinary text input instead of exiting onboarding. The rule applies only during non-empty API-key entry and only for printable keys without control/alt modifiers.

**Data flow**: Reads the provided `KeyEvent` and `ApiKeyEntryContext`, returning `true` when API-key entry is active, the field already has text, the key code is `KeyCode::Char(_)`, and modifiers do not include Control or Alt. It writes no state.

**Call relations**: Used exclusively by `OnboardingScreen::handle_key_event` to protect in-progress API-key typing from accidental printable quit bindings.

*Call graph*: called by 5 (handle_key_event, does_not_suppress_control_quit_key_during_api_key_entry, does_not_suppress_printable_quit_key_when_api_key_input_is_empty, does_not_suppress_when_not_in_api_key_entry, suppresses_printable_quit_key_during_api_key_entry); 1 external calls (matches!).


##### `OnboardingScreen::render_ref`  (lines 356–427)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the visible onboarding steps top-to-bottom with dynamic per-step heights and onboarding-wide animation suppression. It is the ratatui rendering entry point for the whole onboarding screen.

**Data flow**: Computes whether animations should be suppressed, propagates that flag into visible welcome/auth widgets, clears the target area, then iteratively renders each visible step into a scratch buffer to measure used rows before rendering it into the real buffer at the next vertical offset. It writes only to the render buffer and widget-local animation suppression flags.

**Call relations**: Called by `run_onboarding_app` during initial draw and on draw/resize events. It depends on `current_steps` and `should_suppress_animations` to decide what to render and how.

*Call graph*: calls 2 internal fn (current_steps, should_suppress_animations); 2 external calls (empty, new).


##### `Step::handle_key_event`  (lines 431–437)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Dispatches a key event to the concrete widget wrapped by a `Step`. It erases the enum layer for keyboard handling.

**Data flow**: Matches `self` and forwards the `KeyEvent` to the contained welcome, auth, or trust widget's `handle_key_event`. It returns `()` and mutates only the delegated widget.

**Call relations**: Used by onboarding's active-step routing in `OnboardingScreen::handle_key_event`.


##### `Step::handle_paste`  (lines 439–445)

```
fn handle_paste(&mut self, pasted: String)
```

**Purpose**: Dispatches pasted text to the concrete widget wrapped by a `Step`, skipping welcome because it has no paste behavior. It is the enum-level paste router.

**Data flow**: Matches `self`; for auth and trust it forwards the pasted string to the contained widget, while for welcome it does nothing. It returns `()`.

**Call relations**: Used by `OnboardingScreen::handle_paste` after selecting the active step.


##### `Step::get_step_state`  (lines 449–455)

```
fn get_step_state(&self) -> StepState
```

**Purpose**: Returns the current `StepState` of the wrapped widget. It lets the onboarding screen treat heterogeneous steps uniformly.

**Data flow**: Matches `self` and calls the contained widget's `get_step_state`, returning that value. It does not mutate state.

**Call relations**: Used throughout onboarding step selection and rendering logic, especially by `current_steps` and `current_steps_mut`.


##### `Step::render_ref`  (lines 459–471)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Dispatches rendering to the concrete widget wrapped by a `Step`. It is the enum-level rendering adapter.

**Data flow**: Matches `self` and forwards the target area and mutable buffer to the contained widget's `render_ref`. It writes only to the render buffer through the delegated widget.

**Call relations**: Used by `OnboardingScreen::render_ref` when rendering each visible step.


##### `run_onboarding_app`  (lines 474–575)

```
async fn run_onboarding_app(
    args: OnboardingScreenArgs,
    mut app_server: Option<&mut AppServerSession>,
    tui: &mut Tui,
) -> Result<OnboardingResult>
```

**Purpose**: Runs the full onboarding event loop, drawing the screen, consuming TUI and app-server events, persisting trust selections, and returning the final onboarding outcome. It is the top-level driver for onboarding.

**Data flow**: Consumes onboarding args, optional mutable `AppServerSession`, and mutable `Tui`; clones the request handle, constructs `OnboardingScreen::new`, performs an initial draw, then loops until `onboarding_screen.is_done()`. Inside `tokio::select!` it routes key/paste/draw/resize TUI events into the screen, persists trust once selected via `persist_selected_trust`, forwards app-server notifications into `handle_app_server_notification`, converts app-server disconnects into errors, performs a one-time terminal clear after the ChatGPT success message, and finally returns `OnboardingResult { directory_trust_persisted, should_exit }`.

**Call relations**: Called by the outer TUI application runner. It orchestrates all lower-level onboarding pieces and is the only function in this file that directly drives asynchronous event streams.

*Call graph*: calls 1 internal fn (new); called by 1 (run_ratatui_app); 4 external calls (draw, event_stream, pin!, select!).


##### `persist_selected_trust`  (lines 577–622)

```
async fn persist_selected_trust(
    onboarding_screen: &mut OnboardingScreen,
    request_handle: Option<AppServerRequestHandle>,
) -> bool
```

**Purpose**: Persists a chosen trusted-project selection through the app server and updates the trust widget with an error if persistence fails. It turns a local trust choice into durable configuration.

**Data flow**: Scans `onboarding_screen.steps` for a `TrustDirectoryWidget` whose `selection` is `Some(Trust)`, extracts its index and `trust_target`, then either calls `write_trusted_project(request_handle, &trust_target)` or synthesizes an `app server unavailable` error. On success it returns `true`; on failure it formats the error with `format_config_error`, logs it, resets the widget's `selection` to `None`, stores a user-visible error string, and returns `false`.

**Call relations**: Called from `run_onboarding_app` after key events until trust has been persisted, and directly by a failure-path test. It is the bridge between trust-step UI state and persisted config.

*Call graph*: calls 2 internal fn (format_config_error, write_trusted_project); called by 1 (trust_persistence_failure_keeps_trust_step_in_progress); 3 external calls (eyre!, format!, error!).


##### `tests::suppresses_printable_quit_key_during_api_key_entry`  (lines 642–651)

```
fn suppresses_printable_quit_key_during_api_key_entry()
```

**Purpose**: Verifies that a printable quit key is suppressed while editing a non-empty API-key field. It captures the main safety rule behind onboarding quit handling.

**Data flow**: Constructs a printable `q` key event and an active/non-empty `ApiKeyEntryContext`, calls `suppress_quit_while_typing_api_key`, and asserts that the result is `true`. It mutates no shared state.

**Call relations**: Directly tests the helper used by `OnboardingScreen::handle_key_event`.

*Call graph*: calls 1 internal fn (suppress_quit_while_typing_api_key); 3 external calls (Char, new, assert!).


##### `tests::does_not_suppress_printable_quit_key_when_api_key_input_is_empty`  (lines 654–663)

```
fn does_not_suppress_printable_quit_key_when_api_key_input_is_empty()
```

**Purpose**: Verifies that the printable quit key remains usable when the API-key field is active but still empty. This preserves an easy exit path before typing begins.

**Data flow**: Builds a printable `q` key event and an active-but-empty `ApiKeyEntryContext`, calls `suppress_quit_while_typing_api_key`, and asserts `false`. It has no side effects.

**Call relations**: Tests the empty-field exception in the quit-suppression helper.

*Call graph*: calls 1 internal fn (suppress_quit_while_typing_api_key); 3 external calls (Char, new, assert!).


##### `tests::does_not_suppress_control_quit_key_during_api_key_entry`  (lines 666–675)

```
fn does_not_suppress_control_quit_key_during_api_key_entry()
```

**Purpose**: Verifies that control-modified quit chords are never suppressed during API-key entry. These remain emergency exit shortcuts even while typing.

**Data flow**: Creates a control-modified character key event and an active/non-empty API-key context, calls `suppress_quit_while_typing_api_key`, and asserts `false`. It mutates no state.

**Call relations**: Covers the modifier-based escape hatch in the quit-suppression logic.

*Call graph*: calls 1 internal fn (suppress_quit_while_typing_api_key); 3 external calls (Char, new, assert!).


##### `tests::does_not_suppress_when_not_in_api_key_entry`  (lines 678–687)

```
fn does_not_suppress_when_not_in_api_key_entry()
```

**Purpose**: Verifies that quit suppression does not apply outside API-key entry mode. This keeps normal onboarding quit behavior unchanged for other steps.

**Data flow**: Creates a printable key event and an inactive `ApiKeyEntryContext`, calls `suppress_quit_while_typing_api_key`, and asserts `false`. It writes no state.

**Call relations**: Tests the top-level mode guard in the quit-suppression helper.

*Call graph*: calls 1 internal fn (suppress_quit_while_typing_api_key); 3 external calls (Char, new, assert!).


##### `tests::trust_persistence_failure_keeps_trust_step_in_progress`  (lines 690–721)

```
async fn trust_persistence_failure_keeps_trust_step_in_progress()
```

**Purpose**: Ensures that when trust persistence fails, the trust step remains in progress and shows an error instead of silently completing. This protects the user from thinking trust was saved when it was not.

**Data flow**: Constructs an `OnboardingScreen` containing a trust widget already selected to trust, calls `persist_selected_trust` with no request handle, then asserts that persistence returned `false`, the widget's `selection` was cleared, its step state is still `InProgress`, and its error mentions app-server unavailability. It mutates the onboarding screen fixture under test.

**Call relations**: Exercises the failure branch of `persist_selected_trust`, which is also used by the live onboarding loop.

*Call graph*: calls 2 internal fn (persist_selected_trust, test_dummy); 4 external calls (assert!, assert_eq!, panic!, vec!).


### `tui/src/onboarding/welcome.rs`

`domain_logic` · `onboarding rendering`

This module defines `WelcomeWidget`, a mostly presentational onboarding step with a small amount of animation state. The widget stores whether the user is already logged in, an `AsciiAnimation` instance, whether animations are globally enabled, a `Cell<bool>` suppression flag propagated from the parent onboarding screen, and a remembered `layout_area` used to decide whether there is enough room to show the animation without clipping. Two constants, `MIN_ANIMATION_HEIGHT` and `MIN_ANIMATION_WIDTH`, enforce that the animation is skipped entirely on small viewports.

The widget's behavior is intentionally minimal. `get_step_state` hides the welcome step when the user is already logged in and otherwise marks it complete immediately, so it remains visible above later steps but never blocks progression. Rendering clears the area, schedules the next animation frame only when animations are enabled and not suppressed, optionally appends the current ASCII frame lines when the remembered layout area is large enough, and always renders the 'Welcome to Codex' line. Keyboard handling only supports the animation-toggle shortcut (`ctrl+.` and compatibility variants via `keys::TOGGLE_ANIMATION`), which rotates to a random animation variant and logs a warning. Tests verify that the animation appears on sufficiently large first draw, disappears below the height breakpoint, and that both control-dot variants switch animation variants.

#### Function details

##### `WelcomeWidget::handle_key_event`  (lines 39–47)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Handles the fixed animation-toggle shortcut for the welcome screen. When animations are enabled and the key is a press event matching the toggle binding, it switches to a different animation variant.

**Data flow**: Reads `animations_enabled`, checks the incoming `KeyEvent` kind and binding match, logs a warning, and calls `self.animation.pick_random_variant()` while ignoring its return value. It returns `()` and mutates only the internal animation state.

**Call relations**: Called by onboarding keyboard routing, including a special path where the welcome step receives keys even when later steps are active. It does not affect onboarding progression, only the background animation variant.

*Call graph*: calls 1 internal fn (pick_random_variant); 1 external calls (warn!).


##### `WelcomeWidget::new`  (lines 51–63)

```
fn new(
        is_logged_in: bool,
        request_frame: FrameRequester,
        animations_enabled: bool,
    ) -> Self
```

**Purpose**: Constructs a welcome widget with a fresh ASCII animation and default unsuppressed layout state. It is the standard initializer for the onboarding welcome step.

**Data flow**: Takes `is_logged_in`, a `FrameRequester`, and `animations_enabled`, creates `AsciiAnimation::new(request_frame)`, initializes suppression to `false` and `layout_area` to `None`, and returns the populated `WelcomeWidget`. It writes no external state.

**Call relations**: Called by `OnboardingScreen::new` in production and by rendering tests. It wires the widget to the frame requester used for animation scheduling.

*Call graph*: calls 1 internal fn (new); called by 3 (new, welcome_renders_animation_on_first_draw, welcome_skips_animation_below_height_breakpoint); 1 external calls (new).


##### `WelcomeWidget::update_layout_area`  (lines 65–67)

```
fn update_layout_area(&self, area: Rect)
```

**Purpose**: Stores the layout area that should be used when deciding whether the animation fits. This lets the parent renderer measure the full available viewport before drawing.

**Data flow**: Writes `Some(area)` into the `layout_area` cell. It returns nothing.

**Call relations**: Called by `OnboardingScreen::render_ref` on the scratch render pass before the widget is actually rendered.


##### `WelcomeWidget::set_animations_suppressed`  (lines 69–71)

```
fn set_animations_suppressed(&self, suppressed: bool)
```

**Purpose**: Sets whether welcome-screen animations should be frozen. This is used when another onboarding step is showing copyable auth material.

**Data flow**: Writes the provided boolean into `animations_suppressed`. It has no return value.

**Call relations**: Called by `OnboardingScreen::render_ref` after computing onboarding-wide animation suppression.


##### `WelcomeWidget::render_ref`  (lines 75–104)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the welcome screen, optionally including the current ASCII animation frame above the welcome text. It also schedules future animation frames when animation is active.

**Data flow**: Clears the target area, conditionally calls `self.animation.schedule_next_frame()`, reads `layout_area` or falls back to the current area, computes whether the animation should be shown based on enablement, suppression, and minimum dimensions, optionally appends `current_frame()` lines, then renders the resulting lines as a wrapped `Paragraph` into the buffer. It mutates only the frame scheduler and render buffer.

**Call relations**: Called by the onboarding screen through the `Step` rendering adapter. Its animation scheduling is suppressed when auth requests a frozen screen.

*Call graph*: calls 2 internal fn (current_frame, schedule_next_frame); 4 external calls (from, new, new, vec!).


##### `WelcomeWidget::get_step_state`  (lines 108–113)

```
fn get_step_state(&self) -> StepState
```

**Purpose**: Reports whether the welcome step should be hidden or treated as already complete. It never blocks onboarding progression.

**Data flow**: Reads `is_logged_in` and returns `StepState::Hidden` when true, otherwise `StepState::Complete`. It writes no state.

**Call relations**: Used by the onboarding screen's step-selection logic to decide whether the welcome step is visible at all.


##### `tests::row_containing`  (lines 129–137)

```
fn row_containing(buf: &Buffer, needle: &str) -> Option<u16>
```

**Purpose**: Finds the first buffer row whose concatenated symbols contain a given substring. It is a rendering test helper for locating the welcome text.

**Data flow**: Iterates each row of the provided `Buffer`, concatenates cell symbols into a string, checks for `needle`, and returns `Some(y)` for the first matching row or `None`. It does not mutate the buffer.

**Call relations**: Used by the welcome rendering tests to verify whether the animation shifted the welcome line downward.


##### `tests::welcome_renders_animation_on_first_draw`  (lines 140–153)

```
fn welcome_renders_animation_on_first_draw()
```

**Purpose**: Verifies that the animation is rendered when the viewport meets the minimum size requirements. It checks that the welcome line appears below the animation frame.

**Data flow**: Creates a widget with animations enabled, renders it into a buffer sized exactly at the animation breakpoints, computes the current frame line count, finds the row containing `Welcome`, and asserts that it appears after the animation plus one blank line. It mutates only the test buffer.

**Call relations**: Exercises the positive animation branch of `WelcomeWidget::render_ref`.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (empty, new, assert_eq!, row_containing).


##### `tests::welcome_skips_animation_below_height_breakpoint`  (lines 156–168)

```
fn welcome_skips_animation_below_height_breakpoint()
```

**Purpose**: Verifies that the animation is omitted when the viewport height is too small. This protects against clipped animation frames.

**Data flow**: Creates an animated widget, renders it into a buffer one row shorter than `MIN_ANIMATION_HEIGHT`, finds the row containing `Welcome`, and asserts that it is at the top row. It writes only to the test buffer.

**Call relations**: Exercises the size-check branch in `WelcomeWidget::render_ref` that suppresses animation on small layouts.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (empty, new, assert_eq!, row_containing).


##### `tests::ctrl_dot_changes_animation_variant`  (lines 171–192)

```
fn ctrl_dot_changes_animation_variant()
```

**Purpose**: Checks that pressing `Ctrl+.` rotates the welcome animation to a different variant. It validates one of the supported toggle shortcuts.

**Data flow**: Constructs a widget with deterministic test variants, captures `current_frame()` before and after sending a `Ctrl+.` key event to `handle_key_event`, and asserts that the frames differ. It mutates the widget's animation state.

**Call relations**: Exercises the key-binding path in `WelcomeWidget::handle_key_event`.

*Call graph*: calls 2 internal fn (with_variants, test_dummy); 4 external calls (new, Char, new, assert_ne!).


##### `tests::ctrl_shift_dot_changes_animation_variant`  (lines 195–219)

```
fn ctrl_shift_dot_changes_animation_variant()
```

**Purpose**: Checks that pressing `Ctrl+Shift+.` also rotates the animation variant. This covers terminals that report modifier bits differently.

**Data flow**: Builds the same deterministic widget setup, sends a `Ctrl+Shift+.` key event to `handle_key_event`, and asserts that the current frame changed. It mutates only the widget under test.

**Call relations**: Covers the compatibility binding behavior documented in `WelcomeWidget::handle_key_event`.

*Call graph*: calls 2 internal fn (with_variants, test_dummy); 4 external calls (new, Char, new, assert_ne!).


### `tui/src/onboarding/auth.rs`

`domain_logic` · `onboarding request handling and rendering`

This module owns the auth-step state and presentation for onboarding. Its core enum, `SignInState`, models the visible subflow: mode picker, browser-based ChatGPT login, device-code login, transient success message, final success, API-key entry, and API-key configured. `AuthModeWidget` stores the mutable UI state in `Arc<RwLock<...>>` fields so async tasks spawned with `tokio::spawn` can update the same state and error message after app-server responses arrive. The widget also tracks the highlighted option, current `LoginStatus`, optional `ForcedLoginMethod`, and animation suppression flags used to freeze redraws while copyable URLs/codes are on screen.

Control flow starts in `handle_key_event`, which first gives API-key editing exclusive handling, then routes navigation, numeric selection, confirm, and cancel actions. ChatGPT browser login sends `ClientRequest::LoginAccount::Chatgpt`, optionally opens the returned URL only for in-process app-server handles, and transitions to `ChatGptContinueInBrowser`. Device-code login delegates to the headless submodule. API-key entry can prefill from `OPENAI_API_KEY`, treats backspace specially when the value came from the environment, and persists via `LoginAccountParams::ApiKey`. Completion notifications are matched by `login_id` so stale or unrelated login completions are ignored. Rendering is state-specific and includes OSC 8 hyperlink marking for wrapped URLs, explicit error display, and animation scheduling only when allowed. Tests cover forced-login restrictions, cancellation behavior, hyperlink wrapping/sanitization, animation suppression, and device-code completion.

#### Function details

##### `mark_url_hyperlink`  (lines 64–66)

```
fn mark_url_hyperlink(buf: &mut Buffer, area: Rect, url: &str)
```

**Purpose**: Marks cyan-underlined cells in a rendered buffer region as one OSC 8 hyperlink for the given URL. This preserves clickability across wrapped rows where terminal URL autodetection would fail.

**Data flow**: Takes a mutable `Buffer`, a `Rect` area, and a URL string, then forwards them unchanged to `crate::terminal_hyperlinks::mark_url_hyperlink`. It mutates buffer cell symbols in-place to embed OSC 8 open/close sequences and returns no value.

**Call relations**: Used by `AuthModeWidget::render_continue_in_browser` after the URL text has been rendered, and exercised directly by hyperlink-focused tests. It is a thin wrapper so auth code can expose hyperlink marking without depending on the lower-level module directly.

*Call graph*: calls 1 internal fn (mark_url_hyperlink); called by 3 (render_continue_in_browser, mark_url_hyperlink_sanitizes_control_chars, mark_url_hyperlink_wraps_cyan_underlined_cells).


##### `mark_underlined_hyperlink`  (lines 69–71)

```
fn mark_underlined_hyperlink(buf: &mut Buffer, area: Rect, url: &str)
```

**Purpose**: Marks any underlined cells in a buffer region as an OSC 8 hyperlink. It is a more general variant of the auth hyperlink helper.

**Data flow**: Receives a mutable buffer, area, and URL and forwards them to `crate::terminal_hyperlinks::mark_underlined_hyperlink`. It writes hyperlink escape sequences into matching cells and returns nothing.

**Call relations**: This helper is defined alongside `mark_url_hyperlink` for auth rendering code, though this file itself does not call it. It exists as a local façade over the terminal hyperlink utility.

*Call graph*: calls 1 internal fn (mark_underlined_hyperlink).


##### `onboarding_request_id`  (lines 97–99)

```
fn onboarding_request_id() -> codex_app_server_protocol::RequestId
```

**Purpose**: Generates a fresh request identifier for onboarding-originated app-server requests. Each call produces a UUID-backed string request ID.

**Data flow**: Creates a new UUID with `Uuid::new_v4()`, converts it to a string, and wraps it in `codex_app_server_protocol::RequestId::String`. It returns the new request ID without touching shared state.

**Call relations**: Called whenever this module sends a typed app-server request, including API-key save, ChatGPT login start, and login cancellation. It ensures those async requests are uniquely identifiable.

*Call graph*: called by 3 (save_api_key, start_chatgpt_login, cancel_login_attempt); 2 external calls (new_v4, String).


##### `cancel_login_attempt`  (lines 101–113)

```
async fn cancel_login_attempt(
    request_handle: &AppServerRequestHandle,
    login_id: String,
)
```

**Purpose**: Sends a best-effort cancellation request for an in-progress login attempt identified by `login_id`. Failures are intentionally ignored because cancellation is cleanup, not a user-visible transaction.

**Data flow**: Consumes an `AppServerRequestHandle` reference and a `login_id` string, builds `ClientRequest::CancelLoginAccount` with a fresh onboarding request ID and `CancelLoginAccountParams`, awaits `request_typed`, and discards the result. It performs network/IPC output through the request handle and returns `()`.

**Call relations**: Invoked from `AuthModeWidget::cancel_active_attempt`, usually inside a spawned task so UI state can reset immediately. It delegates request ID creation to `onboarding_request_id`.

*Call graph*: calls 1 internal fn (onboarding_request_id); called by 1 (cancel_active_attempt).


##### `ContinueWithDeviceCodeState::pending`  (lines 137–144)

```
fn pending(request_id: String) -> Self
```

**Purpose**: Constructs the initial device-code state before the server has returned a login ID, verification URL, or user code. It represents a request in flight.

**Data flow**: Takes a generated `request_id` string and returns a `ContinueWithDeviceCodeState` with that ID and all optional fields set to `None`. It writes no external state.

**Call relations**: Used when device-code login starts, both in production flow and tests. It gives later async responses a request-scoped token that can be matched against the still-active attempt.

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

**Purpose**: Constructs the populated device-code state once the server has returned all information needed for the user to complete login on another device. It stores both correlation IDs and copyable auth material.

**Data flow**: Accepts `request_id`, `login_id`, `verification_url`, and `user_code`, wraps the latter three in `Some(...)`, and returns a fully populated `ContinueWithDeviceCodeState`. It does not mutate shared state itself.

**Call relations**: Created by the headless login startup path when the app server responds successfully, and by tests that need a visible device-code state. It is the state variant rendered with URL and one-time code instructions.

*Call graph*: called by 4 (start_headless_chatgpt_login, auth_widget_suppresses_animations_when_device_code_is_visible, cancel_active_attempt_notifies_device_code_login, device_code_login_completion_advances_to_success_message).


##### `ContinueWithDeviceCodeState::login_id`  (lines 160–162)

```
fn login_id(&self) -> Option<&str>
```

**Purpose**: Exposes the optional login ID as `Option<&str>` for matching notifications and cancellation requests. It avoids cloning unless the caller needs ownership.

**Data flow**: Reads `self.login_id` and converts `Option<String>` to `Option<&str>` via `as_deref`. It returns the borrowed optional string and writes nothing.

**Call relations**: Used by auth cancellation and login-completion matching logic to compare incoming notifications against the active device-code attempt.


##### `ContinueWithDeviceCodeState::is_showing_copyable_auth`  (lines 164–172)

```
fn is_showing_copyable_auth(&self) -> bool
```

**Purpose**: Reports whether the device-code state has both a non-empty verification URL and a non-empty user code. This distinguishes the loading phase from the copyable-auth phase.

**Data flow**: Reads `verification_url` and `user_code`, checks each optional string for presence and non-emptiness, and returns a boolean. It does not mutate state.

**Call relations**: Called by `render_device_code_login` to choose between the 'preparing' banner and the full instructions UI. It encodes the rendering invariant that both pieces must be present before showing copyable auth material.

*Call graph*: called by 1 (render_device_code_login).


##### `AuthModeWidget::handle_key_event`  (lines 176–218)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Routes keyboard input for the auth step, including API-key text editing, option navigation, selection shortcuts, confirmation, and cancellation. It is the main synchronous event dispatcher for this widget.

**Data flow**: Consumes a `KeyEvent`, first offering it to `handle_api_key_entry_key_event`; if not handled there, it reads and updates `highlighted_mode` and `sign_in_state`, may clear or preserve errors, and may schedule redraws or trigger async login flows. It returns no value but mutates widget state and may spawn cancellation work indirectly.

**Call relations**: Called by onboarding's top-level keyboard routing whenever the auth step is active. Depending on the current `SignInState`, it delegates to movement helpers, option selection helpers, or `cancel_active_attempt`; confirm on `PickMode` starts the selected flow, while confirm on `ChatGptSuccessMessage` advances to final success.

*Call graph*: calls 5 internal fn (cancel_active_attempt, handle_api_key_entry_key_event, handle_sign_in_option, move_highlight, select_option_by_index); 1 external calls (info!).


##### `AuthModeWidget::handle_paste`  (lines 220–222)

```
fn handle_paste(&mut self, pasted: String)
```

**Purpose**: Routes pasted text into API-key entry when that mode is active. It ignores the boolean result because onboarding only needs the side effects.

**Data flow**: Takes a pasted `String` and forwards it to `handle_api_key_entry_paste`. It may mutate the API-key input state and schedule a frame through that helper, but returns `()`.

**Call relations**: Invoked by the onboarding screen's paste routing. It exists to satisfy the shared `KeyboardHandler` trait for auth widgets.

*Call graph*: calls 1 internal fn (handle_api_key_entry_paste).


##### `AuthModeWidget::set_animations_suppressed`  (lines 240–242)

```
fn set_animations_suppressed(&self, suppressed: bool)
```

**Purpose**: Sets the local flag that disables auth-step shimmer animations during rendering. This is used when the broader onboarding screen wants to freeze redraw-sensitive content.

**Data flow**: Writes the provided boolean into `self.animations_suppressed`, a `Cell<bool>`. It returns nothing.

**Call relations**: Called by `OnboardingScreen::render_ref` before rendering visible steps. It does not itself trigger rendering; it only changes how later render methods behave.


##### `AuthModeWidget::should_suppress_animations`  (lines 244–249)

```
fn should_suppress_animations(&self) -> bool
```

**Purpose**: Reports whether the auth widget is currently showing browser/device-code login content that should freeze onboarding-wide animations. This protects text selection and copying of URLs/codes.

**Data flow**: Reads `sign_in_state` under a read lock and returns `true` when the state is `ChatGptContinueInBrowser` or `ChatGptDeviceCode`, otherwise `false`. It writes no state.

**Call relations**: Queried by `OnboardingScreen::should_suppress_animations` to decide whether to suppress animations across all visible onboarding steps.

*Call graph*: 1 external calls (matches!).


##### `AuthModeWidget::cancel_active_attempt`  (lines 251–275)

```
fn cancel_active_attempt(&self)
```

**Purpose**: Cancels any active browser or device-code login attempt, resets the auth UI back to mode selection, clears errors, and requests a redraw. It is the escape hatch for abandoning in-flight auth.

**Data flow**: Takes a write lock on `sign_in_state`, inspects the current variant, clones `app_server_request_handle` and `login_id` when needed, spawns `cancel_login_attempt` for cancellable states, then overwrites the state with `PickMode`, clears `error`, and schedules a frame. It returns `()`.

**Call relations**: Triggered by auth-level cancel keys and by onboarding quit handling when auth is in progress. It delegates the actual server-side cancellation to `cancel_login_attempt` but performs the UI reset immediately regardless of request outcome.

*Call graph*: calls 3 internal fn (set_error, cancel_login_attempt, schedule_frame); called by 1 (handle_key_event); 2 external calls (clone, spawn).


##### `AuthModeWidget::set_error`  (lines 277–279)

```
fn set_error(&self, message: Option<String>)
```

**Purpose**: Stores the current user-visible auth error message. `None` clears any prior error.

**Data flow**: Writes the provided `Option<String>` into the `error` `RwLock`. It returns nothing.

**Call relations**: Used throughout the auth flow whenever a branch needs to clear stale errors or surface a new one, including cancellation, API-key editing, login completion, and async request failures.

*Call graph*: called by 9 (cancel_active_attempt, disallow_api_login, handle_api_key_entry_key_event, handle_api_key_entry_paste, on_account_login_completed, save_api_key, start_api_key_entry, start_chatgpt_login, start_device_code_login).


##### `AuthModeWidget::error_message`  (lines 281–283)

```
fn error_message(&self) -> Option<String>
```

**Purpose**: Returns a cloned snapshot of the current auth error message for rendering. It avoids exposing the lock guard to callers.

**Data flow**: Reads the `error` lock, clones the inner `Option<String>`, and returns it. It does not mutate state.

**Call relations**: Called by render methods that need to append an error line, notably the mode picker and API-key entry screen.

*Call graph*: called by 2 (render_api_key_entry, render_pick_mode).


##### `AuthModeWidget::is_api_key_entry_active`  (lines 286–290)

```
fn is_api_key_entry_active(&self) -> bool
```

**Purpose**: Reports whether the auth widget is currently in API-key entry mode. This is used by onboarding-level quit suppression logic.

**Data flow**: Attempts to read `sign_in_state` and returns `true` only if the lock succeeds and the state matches `SignInState::ApiKeyEntry(_)`. It writes nothing.

**Call relations**: Queried by `OnboardingScreen::api_key_entry_context` so the parent screen can treat printable quit keys as text input when appropriate.


##### `AuthModeWidget::api_key_entry_has_text`  (lines 293–297)

```
fn api_key_entry_has_text(&self) -> bool
```

**Purpose**: Reports whether the current API-key entry field contains any text. This lets onboarding distinguish an empty field from in-progress typing.

**Data flow**: Reads `sign_in_state` and pattern-matches for `ApiKeyEntry(state)` with a non-empty `state.value`, returning a boolean. It does not mutate state.

**Call relations**: Also used by `OnboardingScreen::api_key_entry_context`, specifically for the quit-suppression guard.


##### `AuthModeWidget::confirm_binding`  (lines 299–301)

```
fn confirm_binding(&self) -> KeyBinding
```

**Purpose**: Returns the primary configured confirm key binding used in auth UI hints. It standardizes footer text across auth subviews.

**Data flow**: Reads the first element of `keys::CONFIRM` and returns that `KeyBinding` by copy. No state is mutated.

**Call relations**: Used only by render methods to display the concrete confirm shortcut in instructional text.


##### `AuthModeWidget::cancel_binding`  (lines 303–305)

```
fn cancel_binding(&self) -> KeyBinding
```

**Purpose**: Returns the primary configured cancel key binding used in auth UI hints. It keeps rendered instructions aligned with actual key handling.

**Data flow**: Reads the first element of `keys::CANCEL` and returns it by copy. It has no side effects.

**Call relations**: Used by render methods that tell the user how to cancel browser login, device-code login, or API-key entry.


##### `AuthModeWidget::is_api_login_allowed`  (lines 307–309)

```
fn is_api_login_allowed(&self) -> bool
```

**Purpose**: Determines whether API-key login is permitted under the current workspace's forced login policy. It blocks API-key flows when ChatGPT is mandated.

**Data flow**: Reads `forced_login_method` and returns `false` only when it is `Some(ForcedLoginMethod::Chatgpt)`, otherwise `true`. It writes nothing.

**Call relations**: Consulted by option-list builders, selection handlers, rendering, and API-key start/save paths. It is the central policy gate for API-key auth.

*Call graph*: called by 6 (displayed_sign_in_options, handle_sign_in_option, render_pick_mode, save_api_key, selectable_sign_in_options, start_api_key_entry); 1 external calls (matches!).


##### `AuthModeWidget::is_chatgpt_login_allowed`  (lines 311–313)

```
fn is_chatgpt_login_allowed(&self) -> bool
```

**Purpose**: Determines whether ChatGPT-based login options are permitted under the current forced login policy. It blocks ChatGPT and device-code flows when API auth is mandated.

**Data flow**: Reads `forced_login_method` and returns `false` only when it is `Some(ForcedLoginMethod::Api)`, otherwise `true`. It has no side effects.

**Call relations**: Used by option-list builders, selection handlers, and rendering to hide or disable ChatGPT-related choices consistently.

*Call graph*: called by 4 (displayed_sign_in_options, handle_sign_in_option, render_pick_mode, selectable_sign_in_options); 1 external calls (matches!).


##### `AuthModeWidget::displayed_sign_in_options`  (lines 315–324)

```
fn displayed_sign_in_options(&self) -> Vec<SignInOption>
```

**Purpose**: Builds the ordered list of sign-in options that should be shown in the picker UI, including disabled ChatGPT text when relevant. Its ordering drives numeric labels.

**Data flow**: Reads login-policy helpers and constructs a `Vec<SignInOption>` beginning with `ChatGpt`, conditionally adding `DeviceCode` and `ApiKey`. It returns the vector without mutating widget state.

**Call relations**: Used by `render_pick_mode` to draw the menu and by `select_option_by_index` to map number keys to visible rows. Its behavior intentionally differs from `selectable_sign_in_options`.

*Call graph*: calls 2 internal fn (is_api_login_allowed, is_chatgpt_login_allowed); called by 2 (render_pick_mode, select_option_by_index); 1 external calls (vec!).


##### `AuthModeWidget::selectable_sign_in_options`  (lines 326–336)

```
fn selectable_sign_in_options(&self) -> Vec<SignInOption>
```

**Purpose**: Builds the subset of sign-in options that keyboard highlight navigation may land on. Unlike the displayed list, it excludes options disallowed by policy.

**Data flow**: Reads login-policy helpers and constructs a `Vec<SignInOption>` containing only currently selectable modes. It returns that vector and does not mutate state.

**Call relations**: Used exclusively by `move_highlight` so up/down navigation wraps only across actionable choices.

*Call graph*: calls 2 internal fn (is_api_login_allowed, is_chatgpt_login_allowed); called by 1 (move_highlight); 1 external calls (new).


##### `AuthModeWidget::move_highlight`  (lines 338–351)

```
fn move_highlight(&mut self, delta: isize)
```

**Purpose**: Moves the highlighted sign-in option up or down with wraparound across selectable options. It keeps the highlight valid even when some modes are hidden or disabled.

**Data flow**: Reads the selectable options list, finds the current highlighted index or defaults to zero, applies the signed `delta` with Euclidean wraparound, and writes the resulting option back to `highlighted_mode`. It returns nothing.

**Call relations**: Called from `handle_key_event` for move-up and move-down bindings. It depends on `selectable_sign_in_options` so policy restrictions are respected.

*Call graph*: calls 1 internal fn (selectable_sign_in_options); called by 1 (handle_key_event).


##### `AuthModeWidget::select_option_by_index`  (lines 353–358)

```
fn select_option_by_index(&mut self, index: usize)
```

**Purpose**: Maps a visible menu index to a sign-in option and starts that option's flow if present. It powers numeric shortcuts like first/second/third choice.

**Data flow**: Builds the displayed options vector, looks up the requested `index`, and if found passes the copied option to `handle_sign_in_option`. It mutates widget state only through that delegated handler.

**Call relations**: Invoked by `handle_key_event` for direct-selection shortcuts. It uses `displayed_sign_in_options` rather than selectable options so the numeric labels match what the user sees.

*Call graph*: calls 2 internal fn (displayed_sign_in_options, handle_sign_in_option); called by 1 (handle_key_event).


##### `AuthModeWidget::handle_sign_in_option`  (lines 360–380)

```
fn handle_sign_in_option(&mut self, option: SignInOption)
```

**Purpose**: Dispatches a chosen sign-in option into the correct flow starter while enforcing policy checks. It is the central branch point from menu selection to concrete auth behavior.

**Data flow**: Consumes a `SignInOption`, reads policy helpers, and either starts ChatGPT login, starts device-code login, starts API-key entry, or calls `disallow_api_login`. It returns no value but mutates widget state and may trigger async work through the delegated methods.

**Call relations**: Reached from confirm-on-picker and numeric selection. It delegates to `start_chatgpt_login`, `start_device_code_login`, or `start_api_key_entry`, with `disallow_api_login` as the explicit rejection path.

*Call graph*: calls 6 internal fn (disallow_api_login, is_api_login_allowed, is_chatgpt_login_allowed, start_api_key_entry, start_chatgpt_login, start_device_code_login); called by 2 (handle_key_event, select_option_by_index).


##### `AuthModeWidget::disallow_api_login`  (lines 382–387)

```
fn disallow_api_login(&mut self)
```

**Purpose**: Resets the picker to ChatGPT, records the fixed 'API key login is disabled' error, and redraws. It is the user-visible response when policy forbids API-key auth.

**Data flow**: Writes `highlighted_mode = ChatGpt`, stores `API_KEY_DISABLED_MESSAGE` in `error`, sets `sign_in_state` to `PickMode`, and schedules a frame. It returns nothing.

**Call relations**: Called when the user selects API-key login under a forced ChatGPT policy, and defensively from API-key start/save paths if they are reached anyway.

*Call graph*: calls 2 internal fn (set_error, schedule_frame); called by 3 (handle_sign_in_option, save_api_key, start_api_key_entry).


##### `AuthModeWidget::render_pick_mode`  (lines 389–489)

```
fn render_pick_mode(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the auth mode picker with descriptions, current highlight styling, policy-dependent explanatory text, confirm instructions, and any current error. It is the default auth screen.

**Data flow**: Reads `highlighted_mode`, policy helpers, displayed options, key bindings, and the current error message to assemble a `Vec<Line>`, then renders it as a wrapped `Paragraph` into the provided buffer area. It writes only to the render buffer.

**Call relations**: Called by `render_ref` when `sign_in_state` is `PickMode`. It reflects the same option ordering used by `select_option_by_index` and the same policy checks used by selection logic.

*Call graph*: calls 4 internal fn (displayed_sign_in_options, error_message, is_api_login_allowed, is_chatgpt_login_allowed); called by 1 (render_ref); 3 external calls (from, new, vec!).


##### `AuthModeWidget::render_continue_in_browser`  (lines 491–544)

```
fn render_continue_in_browser(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the browser-login waiting screen, including an animated or static banner, the fallback auth URL, remote/headless guidance, cancel instructions, and OSC 8 hyperlink markup. It is shown after ChatGPT browser login has started.

**Data flow**: Reads animation flags and `sign_in_state`, optionally schedules a follow-up frame for shimmer animation, builds lines containing the auth URL when present, renders them into the buffer, and then calls `mark_url_hyperlink` to wrap the rendered URL cells. It mutates only the frame scheduler and render buffer.

**Call relations**: Selected by `render_ref` for `ChatGptContinueInBrowser`. It depends on `mark_url_hyperlink` so wrapped URLs remain clickable and on `schedule_frame_in` to keep shimmer text moving when animations are enabled.

*Call graph*: calls 3 internal fn (shimmer_text, mark_url_hyperlink, schedule_frame_in); called by 1 (render_ref); 4 external calls (from, new, from_millis, vec!).


##### `AuthModeWidget::render_chatgpt_success_message`  (lines 546–591)

```
fn render_chatgpt_success_message(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the intermediate post-login guidance screen shown immediately after successful ChatGPT authentication. It includes safety reminders, documentation links, and a prompt to continue.

**Data flow**: Builds a fixed set of styled `Line`s, including OSC 8 hyperlinks produced by `crate::terminal_hyperlinks::osc8_hyperlink`, and renders them as a wrapped `Paragraph` into the buffer. It does not mutate widget state.

**Call relations**: Called by `render_ref` when `sign_in_state` is `ChatGptSuccessMessage`. The next confirm key handled by `handle_key_event` advances from this screen to `ChatGptSuccess`.

*Call graph*: called by 1 (render_ref); 2 external calls (new, vec!).


##### `AuthModeWidget::render_chatgpt_success`  (lines 593–603)

```
fn render_chatgpt_success(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the compact final success state for ChatGPT login after the user dismisses the longer guidance message. It serves as the completed auth-step display.

**Data flow**: Creates a one-line green success message and renders it into the buffer as a wrapped paragraph. It writes only to the render buffer.

**Call relations**: Chosen by `render_ref` once `handle_key_event` has advanced past `ChatGptSuccessMessage`, or when existing login state means no new login is needed.

*Call graph*: called by 1 (render_ref); 2 external calls (new, vec!).


##### `AuthModeWidget::render_api_key_configured`  (lines 605–615)

```
fn render_api_key_configured(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the completed API-key success state. It confirms that usage-based billing will use the saved key.

**Data flow**: Builds a short green success message plus explanatory text and renders it into the buffer. It has no side effects beyond drawing.

**Call relations**: Displayed by `render_ref` after `save_api_key` receives a successful `LoginAccountResponse::ApiKey`.

*Call graph*: called by 1 (render_ref); 2 external calls (new, vec!).


##### `AuthModeWidget::render_api_key_entry`  (lines 617–682)

```
fn render_api_key_entry(&self, area: Rect, buf: &mut Buffer, state: &ApiKeyInputState)
```

**Purpose**: Renders the API-key entry form with intro text, optional environment-variable notice, bordered input box, save/back hints, and any validation or save error. It is the text-entry subview of auth onboarding.

**Data flow**: Splits the given area vertically, reads the provided `ApiKeyInputState` and current error message, constructs intro/footer lines, renders the current key value or placeholder into a bordered `Block`, and writes all output into the buffer. It does not mutate widget state.

**Call relations**: Called by `render_ref` when `sign_in_state` is `ApiKeyEntry`. Its behavior matches the editing semantics implemented by `handle_api_key_entry_key_event` and `handle_api_key_entry_paste`.

*Call graph*: calls 1 internal fn (error_message); called by 1 (render_ref); 8 external calls (default, Length, Min, vertical, from, new, default, vec!).


##### `AuthModeWidget::handle_api_key_entry_key_event`  (lines 684–744)

```
fn handle_api_key_entry_key_event(&mut self, key_event: &KeyEvent) -> bool
```

**Purpose**: Implements all keyboard editing behavior for API-key entry, including cancel, confirm/save, backspace, and printable character insertion. It also handles the special case where the field was prefilled from the environment.

**Data flow**: Takes a `KeyEvent`, acquires a write lock on `sign_in_state`, and if the state is `ApiKeyEntry`, mutates `ApiKeyInputState.value` and `prepopulated_from_env`, clears or sets `error`, possibly transitions back to `PickMode`, and records whether to save or redraw after dropping the lock. It returns `true` if the event was handled in API-key mode, otherwise `false`; on confirm with non-empty trimmed text it delegates to `save_api_key`.

**Call relations**: Called first from `handle_key_event` so text entry gets priority over menu navigation. It delegates persistence to `save_api_key` only after releasing the state lock, avoiding holding the lock across async-triggering work.

*Call graph*: calls 3 internal fn (save_api_key, set_error, schedule_frame); called by 1 (handle_key_event).


##### `AuthModeWidget::handle_api_key_entry_paste`  (lines 746–768)

```
fn handle_api_key_entry_paste(&mut self, pasted: String) -> bool
```

**Purpose**: Appends or replaces API-key text from a paste operation when API-key entry is active. It trims surrounding whitespace and clears any prior error.

**Data flow**: Receives a pasted string, trims it, returns `false` immediately if empty, otherwise writes into `ApiKeyInputState.value` under the `sign_in_state` lock, replacing the env-prefilled value on first paste or appending to existing user-entered text. It clears `error`, schedules a frame, and returns `true` when paste was applied.

**Call relations**: Reached from `handle_paste`. It mirrors the env-prefill replacement behavior used by typed character input in `handle_api_key_entry_key_event`.

*Call graph*: calls 2 internal fn (set_error, schedule_frame); called by 1 (handle_paste).


##### `AuthModeWidget::start_api_key_entry`  (lines 770–798)

```
fn start_api_key_entry(&mut self)
```

**Purpose**: Transitions the auth widget into API-key entry mode, optionally prepopulating the field from `OPENAI_API_KEY`. It is the entry point for the API-key flow.

**Data flow**: Checks policy via `is_api_login_allowed`, clears errors, reads `OPENAI_API_KEY` with `read_openai_api_key_from_env`, then either updates an existing `ApiKeyEntry` state or replaces the current state with a new `ApiKeyInputState` carrying the prefill and `prepopulated_from_env` flag. It schedules a frame and returns `()`.

**Call relations**: Called from `handle_sign_in_option` when the user chooses API-key login. If policy forbids API auth, it delegates to `disallow_api_login` instead of entering edit mode.

*Call graph*: calls 4 internal fn (disallow_api_login, is_api_login_allowed, set_error, schedule_frame); called by 1 (handle_sign_in_option); 2 external calls (read_openai_api_key_from_env, ApiKeyEntry).


##### `AuthModeWidget::save_api_key`  (lines 800–844)

```
fn save_api_key(&mut self, api_key: String)
```

**Purpose**: Starts the async request that persists an API key through the app server and updates the auth UI based on the response. It is the commit step for API-key entry.

**Data flow**: Validates policy, clears errors, clones the request handle and shared state arcs, then spawns an async task that sends `ClientRequest::LoginAccount { params: LoginAccountParams::ApiKey { api_key } }` with a fresh request ID. The task writes either `ApiKeyConfigured` on success or restores `ApiKeyEntry` with the attempted key plus an error message on unexpected response or request failure; both the task and the caller schedule redraws.

**Call relations**: Invoked only from `handle_api_key_entry_key_event` after confirm on non-empty input. It depends on `onboarding_request_id` for request correlation and uses the shared locks so the background response can update the visible widget.

*Call graph*: calls 5 internal fn (disallow_api_login, is_api_login_allowed, set_error, onboarding_request_id, schedule_frame); called by 1 (handle_api_key_entry_key_event); 5 external calls (clone, format!, spawn, ApiKeyEntry, clone).


##### `AuthModeWidget::handle_existing_chatgpt_login`  (lines 846–857)

```
fn handle_existing_chatgpt_login(&mut self) -> bool
```

**Purpose**: Short-circuits new ChatGPT login flows when the current `LoginStatus` already represents a ChatGPT-capable authenticated mode. It treats both OAuth and non-OAuth ChatGPT-backed modes as already signed in.

**Data flow**: Reads `login_status`, and if it matches `LoginStatus::AuthMode(auth_mode)` where `auth_mode.has_chatgpt_account()` is true, writes `SignInState::ChatGptSuccess`, schedules a frame, and returns `true`; otherwise it returns `false`. It mutates only `sign_in_state` in the handled case.

**Call relations**: Called at the start of both `start_chatgpt_login` and `start_device_code_login`. It prevents redundant login attempts and lets onboarding proceed immediately when auth already exists.

*Call graph*: calls 1 internal fn (schedule_frame); called by 2 (start_chatgpt_login, start_device_code_login); 1 external calls (matches!).


##### `AuthModeWidget::start_chatgpt_login`  (lines 860–904)

```
fn start_chatgpt_login(&mut self)
```

**Purpose**: Starts the browser-based ChatGPT login flow and transitions the UI into the waiting-for-browser state. It also attempts to open the auth URL automatically for in-process app-server sessions.

**Data flow**: First checks `handle_existing_chatgpt_login`; if not already authenticated, it clears errors, clones shared state, and spawns an async task that sends `ClientRequest::LoginAccount { params: LoginAccountParams::Chatgpt { codex_streamlined_login: false } }`. On a `Chatgpt { login_id, auth_url }` response it calls `maybe_open_auth_url_in_browser`, clears errors, and writes `SignInState::ChatGptContinueInBrowser`; on unexpected response or error it resets to `PickMode` and stores an error string, then schedules a frame.

**Call relations**: Reached from `handle_sign_in_option` when ChatGPT login is chosen. It delegates browser opening to `maybe_open_auth_url_in_browser` and later relies on `on_account_login_completed` notifications to finish the flow.

*Call graph*: calls 4 internal fn (handle_existing_chatgpt_login, set_error, maybe_open_auth_url_in_browser, onboarding_request_id); called by 1 (handle_sign_in_option); 5 external calls (clone, format!, spawn, ChatGptContinueInBrowser, clone).


##### `AuthModeWidget::start_device_code_login`  (lines 906–913)

```
fn start_device_code_login(&mut self)
```

**Purpose**: Starts the headless/device-code ChatGPT login flow after clearing stale errors and checking for an existing authenticated ChatGPT session. It is the non-browser alternative for remote environments.

**Data flow**: Calls `handle_existing_chatgpt_login`, clears `error` if a new attempt is needed, and delegates the rest of the startup work to `headless_chatgpt_login::start_headless_chatgpt_login`. It returns no value.

**Call relations**: Chosen by `handle_sign_in_option` for the device-code menu item. The actual async request and state transitions are implemented in the sibling submodule.

*Call graph*: calls 3 internal fn (handle_existing_chatgpt_login, set_error, start_headless_chatgpt_login); called by 1 (handle_sign_in_option).


##### `AuthModeWidget::on_account_login_completed`  (lines 915–943)

```
fn on_account_login_completed(
        &mut self,
        notification: AccountLoginCompletedNotification,
    )
```

**Purpose**: Consumes app-server login-completion notifications and advances or resets the auth UI only if the notification matches the currently active login attempt. It prevents unrelated completions from corrupting onboarding state.

**Data flow**: Reads `notification.login_id`; if absent, returns immediately. Otherwise it compares that ID against the active browser-login or device-code state's login ID, and if they match, clears errors and sets `ChatGptSuccessMessage` on success or stores `notification.error` and resets to `PickMode` on failure, then schedules a frame.

**Call relations**: Called by `OnboardingScreen::handle_app_server_notification` when an `AccountLoginCompleted` notification arrives. It is the bridge from async server notifications back into the auth state machine.

*Call graph*: calls 2 internal fn (set_error, schedule_frame); 1 external calls (matches!).


##### `AuthModeWidget::on_account_updated`  (lines 945–950)

```
fn on_account_updated(&mut self, notification: AccountUpdatedNotification)
```

**Purpose**: Updates the widget's cached `LoginStatus` from an account-updated notification. This keeps future auth decisions aligned with the server's current auth mode.

**Data flow**: Reads `notification.auth_mode` and writes `self.login_status` to either `LoginStatus::AuthMode(...)` or `LoginStatus::NotAuthenticated`. It returns nothing.

**Call relations**: Called by onboarding's app-server notification handler on `AccountUpdated`. The updated status is later consulted by `handle_existing_chatgpt_login`.


##### `AuthModeWidget::get_step_state`  (lines 954–964)

```
fn get_step_state(&self) -> StepState
```

**Purpose**: Reports whether the auth onboarding step is still in progress or complete based on the current sign-in state. It is the auth widget's implementation of the shared step-state contract.

**Data flow**: Reads `sign_in_state` and maps picker, API-key entry, browser/device-code waiting, and success-message states to `StepState::InProgress`, while mapping final ChatGPT success and API-key configured to `StepState::Complete`. It writes no state.

**Call relations**: Used by the onboarding screen to decide which steps are visible and which one currently receives input.


##### `AuthModeWidget::render_ref`  (lines 968–993)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Dispatches rendering to the correct auth subview based on the current `SignInState`. It is the ratatui entry point for drawing the auth step.

**Data flow**: Reads `sign_in_state` under a read lock and calls the corresponding render helper or the headless device-code renderer, passing through the target area and mutable buffer. It writes only to the render buffer and any animation frame scheduling performed by delegated renderers.

**Call relations**: Called by the onboarding screen's rendering pipeline. It is the single switch that ties the auth state machine to the concrete UI functions.

*Call graph*: calls 7 internal fn (render_api_key_configured, render_api_key_entry, render_chatgpt_success, render_chatgpt_success_message, render_continue_in_browser, render_pick_mode, render_device_code_login).


##### `maybe_open_auth_url_in_browser`  (lines 996–1004)

```
fn maybe_open_auth_url_in_browser(request_handle: &AppServerRequestHandle, url: &str)
```

**Purpose**: Attempts to open the ChatGPT auth URL in the user's browser, but only when the app server is running in-process. Remote/out-of-process sessions intentionally skip this behavior.

**Data flow**: Reads the `AppServerRequestHandle` variant; if it is not `InProcess`, returns immediately. Otherwise it calls `webbrowser::open(url)` and logs a warning on failure, without changing widget state.

**Call relations**: Called only from `start_chatgpt_login` after a successful browser-login start response. It is a convenience side effect layered on top of the core login state transition.

*Call graph*: called by 1 (start_chatgpt_login); 3 external calls (matches!, warn!, open).


##### `tests::widget_forced_chatgpt`  (lines 1023–1075)

```
async fn widget_forced_chatgpt() -> (AuthModeWidget, TempDir)
```

**Purpose**: Builds a realistic `AuthModeWidget` fixture backed by an in-process app server and a temporary Codex home, with `ForcedLoginMethod::Chatgpt` enabled. It gives tests an environment where API-key login should be blocked.

**Data flow**: Creates a temp directory, builds config, starts an `InProcessAppServerClient`, constructs an `AuthModeWidget` with fresh locks and `PickMode`, and returns the widget plus the temp directory. It performs filesystem setup and app-server startup as test-side effects.

**Call relations**: Used by most auth tests in this file to avoid repeating setup and to exercise policy behavior against a real request handle.

*Call graph*: calls 5 internal fn (start, default, default_for_tests, new, test_dummy); 12 external calls (new, default, new, new, new, InProcess, default, cloud_config_bundle_loader_for_storage, default, from_value (+2 more)).


##### `tests::api_key_flow_disabled_when_chatgpt_forced`  (lines 1078–1091)

```
async fn api_key_flow_disabled_when_chatgpt_forced()
```

**Purpose**: Verifies that entering API-key mode is blocked when the workspace forces ChatGPT login. It checks both the visible error and the unchanged picker state.

**Data flow**: Obtains a forced-ChatGPT widget fixture, calls `start_api_key_entry`, then asserts that `error_message()` equals the fixed disabled message and `sign_in_state` remains `PickMode`. It mutates only test-local fixture state.

**Call relations**: Exercises the policy gate in `start_api_key_entry` and the fallback behavior implemented by `disallow_api_login`.

*Call graph*: 3 external calls (assert!, assert_eq!, widget_forced_chatgpt).


##### `tests::saving_api_key_is_blocked_when_chatgpt_forced`  (lines 1094–1108)

```
async fn saving_api_key_is_blocked_when_chatgpt_forced()
```

**Purpose**: Ensures that even direct calls to save an API key are rejected under forced ChatGPT policy. This covers the defensive check in the save path itself.

**Data flow**: Creates the forced-ChatGPT fixture, calls `save_api_key("sk-test")`, then asserts the disabled error, `PickMode` state, and unchanged `LoginStatus::NotAuthenticated`. It does not inspect async server effects because the save should be blocked before any request is sent.

**Call relations**: Targets the policy guard inside `save_api_key`, complementing the earlier test that blocks entry into API-key mode.

*Call graph*: 3 external calls (assert!, assert_eq!, widget_forced_chatgpt).


##### `tests::existing_non_oauth_chatgpt_login_counts_as_signed_in`  (lines 1111–1127)

```
async fn existing_non_oauth_chatgpt_login_counts_as_signed_in()
```

**Purpose**: Checks that non-OAuth ChatGPT-backed auth modes are treated as already signed in for onboarding purposes. It validates the broad `has_chatgpt_account()` shortcut.

**Data flow**: For each tested `AppServerAuthMode`, it creates a fixture, sets `widget.login_status`, calls `handle_existing_chatgpt_login`, and asserts that the function returns `true` and the state becomes `ChatGptSuccess`. It mutates only the widget under test.

**Call relations**: Exercises `handle_existing_chatgpt_login`, which is used by both ChatGPT login starters to avoid redundant auth attempts.

*Call graph*: 4 external calls (assert!, assert_eq!, AuthMode, widget_forced_chatgpt).


##### `tests::cancel_active_attempt_resets_browser_login_state`  (lines 1130–1146)

```
async fn cancel_active_attempt_resets_browser_login_state()
```

**Purpose**: Verifies that cancelling a browser-based ChatGPT login clears the error and returns the widget to mode selection. It focuses on the UI reset behavior rather than the async cancellation request.

**Data flow**: Creates a fixture, manually seeds `error` and `sign_in_state` with `ChatGptContinueInBrowser`, calls `cancel_active_attempt`, and asserts that the error is `None` and the state is `PickMode`. It mutates the widget's shared locks directly for setup.

**Call relations**: Covers the browser-login branch of `cancel_active_attempt`.

*Call graph*: 4 external calls (assert!, assert_eq!, ChatGptContinueInBrowser, widget_forced_chatgpt).


##### `tests::cancel_active_attempt_notifies_device_code_login`  (lines 1149–1167)

```
async fn cancel_active_attempt_notifies_device_code_login()
```

**Purpose**: Verifies that cancelling a device-code login also clears the error and resets to mode selection. It covers the branch where a device-code state may carry a cancellable login ID.

**Data flow**: Creates a fixture, seeds `error` and `sign_in_state` with a ready `ChatGptDeviceCode` state, calls `cancel_active_attempt`, and asserts cleared error plus `PickMode`. It uses `ContinueWithDeviceCodeState::ready` to build the setup state.

**Call relations**: Exercises the device-code branch of `cancel_active_attempt`, complementing the browser-login cancellation test.

*Call graph*: calls 1 internal fn (ready); 4 external calls (assert!, assert_eq!, ChatGptDeviceCode, widget_forced_chatgpt).


##### `tests::collect_osc8_chars`  (lines 1171–1186)

```
fn collect_osc8_chars(buf: &Buffer, area: Rect, url: &str) -> String
```

**Purpose**: Scans a rendered buffer region and extracts the visible characters from cells wrapped in a specific OSC 8 hyperlink sequence. It is a test helper for verifying hyperlink coverage.

**Data flow**: Builds the expected OSC 8 open and close markers from `url`, iterates every cell in `area`, and concatenates the inner character from any symbol that matches the wrapped form. It returns the collected string and does not mutate the buffer.

**Call relations**: Used by hyperlink-rendering tests to confirm that every character of a rendered URL was wrapped with the expected OSC 8 metadata.

*Call graph*: 6 external calls (bottom, left, right, top, new, format!).


##### `tests::continue_in_browser_renders_osc8_hyperlink`  (lines 1189–1207)

```
fn continue_in_browser_renders_osc8_hyperlink()
```

**Purpose**: Checks that the browser-login screen wraps the full auth URL in OSC 8 hyperlink markup even when the URL wraps across multiple rows. This protects clickability in narrow terminals.

**Data flow**: Builds a fixture, seeds `sign_in_state` with `ChatGptContinueInBrowser`, renders into a narrow `Buffer`, extracts wrapped characters with `collect_osc8_chars`, and asserts that they equal the full URL. It writes only to the test buffer.

**Call relations**: Exercises `render_continue_in_browser` together with `mark_url_hyperlink`.

*Call graph*: 7 external calls (empty, new, assert_eq!, new, ChatGptContinueInBrowser, collect_osc8_chars, widget_forced_chatgpt).


##### `tests::auth_widget_suppresses_animations_when_device_code_is_visible`  (lines 1210–1222)

```
fn auth_widget_suppresses_animations_when_device_code_is_visible()
```

**Purpose**: Verifies that a ready device-code screen requests animation suppression. This ensures copyable auth material is not disturbed by redraws.

**Data flow**: Creates a fixture, sets `sign_in_state` to a ready `ChatGptDeviceCode`, calls `should_suppress_animations`, and asserts `true`. It mutates only test-local widget state.

**Call relations**: Covers the visible-device-code branch of `AuthModeWidget::should_suppress_animations`.

*Call graph*: calls 1 internal fn (ready); 4 external calls (assert_eq!, new, ChatGptDeviceCode, widget_forced_chatgpt).


##### `tests::auth_widget_suppresses_animations_while_requesting_device_code`  (lines 1225–1233)

```
fn auth_widget_suppresses_animations_while_requesting_device_code()
```

**Purpose**: Verifies that animation suppression also applies during the pending device-code request phase, before the URL and code arrive. This keeps the whole auth subflow stable while waiting.

**Data flow**: Creates a fixture, sets `sign_in_state` to a pending `ChatGptDeviceCode`, calls `should_suppress_animations`, and asserts `true`. It writes only to the widget under test.

**Call relations**: Covers the pending-device-code branch of `AuthModeWidget::should_suppress_animations`.

*Call graph*: calls 1 internal fn (pending); 4 external calls (assert_eq!, new, ChatGptDeviceCode, widget_forced_chatgpt).


##### `tests::device_code_login_completion_advances_to_success_message`  (lines 1236–1256)

```
async fn device_code_login_completion_advances_to_success_message()
```

**Purpose**: Ensures that a successful login-completion notification for the active device-code attempt advances the auth state to the success-message screen. It validates notification matching and success handling.

**Data flow**: Creates a fixture, seeds a ready device-code state with `login-1`, calls `on_account_login_completed` with a successful notification for the same login ID, and asserts that `sign_in_state` becomes `ChatGptSuccessMessage`. It mutates widget state through the notification handler.

**Call relations**: Exercises the matching-device-code success path in `on_account_login_completed`.

*Call graph*: calls 1 internal fn (ready); 3 external calls (assert!, ChatGptDeviceCode, widget_forced_chatgpt).


##### `tests::mark_url_hyperlink_wraps_cyan_underlined_cells`  (lines 1259–1282)

```
fn mark_url_hyperlink_wraps_cyan_underlined_cells()
```

**Purpose**: Checks that `mark_url_hyperlink` wraps only cyan-underlined cells and leaves plain cells untouched. It validates the cell-selection rule used by auth URL rendering.

**Data flow**: Creates a one-line buffer, manually styles several cells as cyan+underlined and one cell as plain text, calls `mark_url_hyperlink`, then uses `collect_osc8_chars` and direct symbol inspection to assert wrapped and untouched cells respectively. It mutates the test buffer in place.

**Call relations**: Directly tests the local hyperlink wrapper helper independent of the higher-level auth renderers.

*Call graph*: calls 1 internal fn (mark_url_hyperlink); 4 external calls (empty, new, assert_eq!, collect_osc8_chars).


##### `tests::mark_url_hyperlink_sanitizes_control_chars`  (lines 1285–1311)

```
fn mark_url_hyperlink_sanitizes_control_chars()
```

**Purpose**: Ensures that malicious control characters embedded in a URL are stripped before OSC 8 markup is written into buffer cells. This prevents escape-sequence injection through hyperlink destinations.

**Data flow**: Creates a buffer with one cyan-underlined cell, calls `mark_url_hyperlink` using a URL containing ESC and BEL, then inspects the resulting cell symbol string to assert that the sanitized printable URL remains while raw control characters do not. It mutates only the test buffer.

**Call relations**: Exercises the sanitization behavior of the underlying terminal hyperlink utility through this module's wrapper.

*Call graph*: calls 1 internal fn (mark_url_hyperlink); 3 external calls (empty, new, assert!).


### `tui/src/onboarding/trust_directory.rs`

`domain_logic` · `onboarding trust confirmation`

This file defines `TrustDirectoryWidget`, the final onboarding step that asks the user to trust the current working directory before enabling project-local configuration, hooks, and exec policies. The widget stores both `cwd` and `trust_target`; when they differ, rendering inserts a yellow warning explaining that trust will apply to the repository root rather than the current subdirectory. The UI is built with the project's `ColumnRenderable` helpers and `selection_option_row`, producing a vertically stacked prompt, optional warning, two choices (`Yes, continue` and `No, quit`), optional error text, and a footer that can mention Windows sandbox creation.

Input handling is intentionally simple and stateful. Release events are ignored entirely. Up/down only move the highlight between `Trust` and `Quit`; direct selection keys invoke the corresponding action immediately; quit/cancel shortcuts are treated as choosing `Quit`; and confirm activates whichever option is highlighted. `handle_trust` clears any prior error and records `selection = Some(Trust)`, while `handle_quit` sets `should_quit = true`. The step is considered complete once either a trust selection exists or quit has been requested. Tests cover release-event behavior and snapshot rendering for both the normal prompt and a long wrapped error message.

#### Function details

##### `TrustDirectoryWidget::render_ref`  (lines 41–125)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the trust-directory prompt, optional repository-root warning, two selectable options, optional error message, and confirm footer. It is the visual representation of the trust step.

**Data flow**: Reads `cwd`, `trust_target`, `highlighted`, `error`, and `show_windows_create_sandbox_hint`, builds a `ColumnRenderable` containing styled `Line` and `Paragraph` items, and renders that column into the provided buffer area. It writes only to the render buffer.

**Call relations**: Called by the onboarding screen through the `Step` rendering adapter whenever the trust step is visible.

*Call graph*: calls 3 internal fn (tlbr, new, selection_option_row); 4 external calls (from, new, format!, vec!).


##### `TrustDirectoryWidget::handle_key_event`  (lines 129–151)

```
fn handle_key_event(&mut self, key_event: KeyEvent)
```

**Purpose**: Processes trust-step keyboard input for moving the highlight, selecting trust or quit, and confirming the highlighted choice. It ignores key-release events entirely.

**Data flow**: Consumes a `KeyEvent`, returns early on `KeyEventKind::Release`, otherwise checks movement, direct-selection, quit/cancel, and confirm bindings in order, mutating `highlighted`, `selection`, `should_quit`, and `error` through `handle_trust` or `handle_quit`. It returns `()`.

**Call relations**: Called by onboarding's active-step routing. It delegates the actual state mutations for final choices to `handle_trust` and `handle_quit`.

*Call graph*: calls 2 internal fn (handle_quit, handle_trust).


##### `TrustDirectoryWidget::get_step_state`  (lines 155–161)

```
fn get_step_state(&self) -> StepState
```

**Purpose**: Reports whether the trust step is complete or still awaiting a decision. Completion occurs on either trust selection or quit request.

**Data flow**: Reads `selection` and `should_quit` and returns `StepState::Complete` if either is set, otherwise `StepState::InProgress`. It writes no state.

**Call relations**: Used by the onboarding screen to decide visibility and progression through steps.


##### `TrustDirectoryWidget::handle_trust`  (lines 165–169)

```
fn handle_trust(&mut self)
```

**Purpose**: Records that the user chose to trust the directory and clears any prior persistence error. It is the positive-action state transition.

**Data flow**: Sets `highlighted` to `Trust`, clears `error`, and writes `selection = Some(TrustDirectorySelection::Trust)`. It returns nothing.

**Call relations**: Called from `handle_key_event` for direct trust selection or confirm while trust is highlighted. Later, `persist_selected_trust` consumes this selection and may clear it again on failure.

*Call graph*: called by 1 (handle_key_event).


##### `TrustDirectoryWidget::handle_quit`  (lines 171–174)

```
fn handle_quit(&mut self)
```

**Purpose**: Records that the user chose to quit instead of trusting the directory. It is the negative-action state transition.

**Data flow**: Sets `highlighted` to `Quit` and writes `should_quit = true`. It returns `()`.

**Call relations**: Called from `handle_key_event` for direct quit selection, quit/cancel shortcuts, or confirm while quit is highlighted. The onboarding screen watches `should_quit()` to decide whether to exit.

*Call graph*: called by 1 (handle_key_event).


##### `TrustDirectoryWidget::should_quit`  (lines 176–178)

```
fn should_quit(&self) -> bool
```

**Purpose**: Returns whether the trust widget has requested quitting onboarding. It exposes the quit decision to the parent screen.

**Data flow**: Reads and returns `self.should_quit`. It has no side effects.

**Call relations**: Queried by `OnboardingScreen::handle_key_event` after step dispatch to convert the widget's local quit choice into onboarding-level exit behavior.


##### `tests::widget`  (lines 194–204)

```
fn widget(error: Option<String>) -> TrustDirectoryWidget
```

**Purpose**: Creates a standard `TrustDirectoryWidget` fixture for rendering tests, optionally with an error message. It centralizes common test setup.

**Data flow**: Constructs and returns a `TrustDirectoryWidget` with fixed `cwd`, `trust_target`, default highlight, no selection, and the provided `error`. It mutates no external state.

**Call relations**: Used by the snapshot tests to avoid repeating fixture construction.

*Call graph*: 1 external calls (from).


##### `tests::release_event_does_not_change_selection`  (lines 207–228)

```
fn release_event_does_not_change_selection()
```

**Purpose**: Verifies that key-release events are ignored while key-press events still trigger the highlighted action. This protects against duplicate handling from press/release pairs.

**Data flow**: Builds a widget highlighted on `Quit`, sends a synthetic release `Enter` event and asserts `selection` remains `None`, then sends a press `Enter` event and asserts `should_quit` becomes true. It mutates the widget under test.

**Call relations**: Exercises the early-return guard in `handle_key_event` and the confirm path that delegates to `handle_quit`.

*Call graph*: 4 external calls (new, from, assert!, assert_eq!).


##### `tests::renders_snapshot_for_git_repo`  (lines 231–241)

```
fn renders_snapshot_for_git_repo()
```

**Purpose**: Captures a snapshot of the normal trust prompt rendering for a repository-root case. It guards the visual layout and wording of the trust UI.

**Data flow**: Creates a standard widget fixture, renders it into a `VT100Backend` terminal of fixed size, and snapshots the backend output. It writes only to the test terminal buffer.

**Call relations**: Exercises `TrustDirectoryWidget::render_ref` in its standard no-error configuration.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_snapshot!, new, widget).


##### `tests::renders_snapshot_for_trust_error`  (lines 244–257)

```
fn renders_snapshot_for_trust_error()
```

**Purpose**: Captures a snapshot of trust-step rendering when a long persistence error is present. It verifies wrapping and placement of the error block.

**Data flow**: Creates a widget fixture with a long error string, renders it into a fixed-size `VT100Backend` terminal, and snapshots the output. It mutates only the test terminal buffer.

**Call relations**: Exercises the error-rendering branch of `TrustDirectoryWidget::render_ref`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_snapshot!, new, widget).


### `tui/src/external_agent_config_migration.rs`

`domain_logic` · `interactive modal / migration prompt flow`

This file drives a modal workflow for external-agent config migration. `run_external_agent_config_migration_prompt` creates an `ExternalAgentConfigMigrationScreen`, renders it, then consumes the TUI event stream until the screen reports completion or the stream ends. The screen supports two views: a summary view that groups migration items into higher-level categories, and a customize view that exposes individual items grouped by cwd/project scope.

State is held in `ExternalAgentConfigMigrationScreen`: a `Vec<MigrationSelection>` tracks each item plus whether it is enabled, `groups` stores summary-group models, `view` and `focus` determine whether keyboard input targets items or action buttons, `selected_item_idx` and `scroll_top` support item navigation, and `highlighted_action` tracks the currently selected action menu entry. Available actions are dynamic: in summary view, `Proceed` only appears when at least one item is enabled; otherwise the visible actions are `Customize` and `Skip`. Customize view exposes only `Back`.

Keyboard handling is explicit and modal. Ctrl-C/Ctrl-D cancel immediately. Up/down and j/k move within actions or items, wrapping appropriately between focus areas. Number keys activate currently visible actions by position, so shortcuts remain stable even when `Proceed` disappears. Space toggles the selected item only in customize/item focus; `a` and `n` bulk-enable or bulk-disable all items; Enter confirms the current focus target; Esc skips from summary or returns from customize.

The file also normalizes migration descriptions for user-facing wording. `display_description` rewrites `Migrate ...` prefixes to `Import ...`, relativizes source/destination paths against item cwd using `display_path_for`, and expands plugin-import descriptions with marketplace/plugin counts. `build_summary_render_lines` and `build_customize_render_lines` produce the line model consumed by the rendering submodule, including section headers, item labels, optional detail lines, and compact plugin detail bullets.

#### Function details

##### `ActionMenuOption::label`  (lines 42–49)

```
fn label(self) -> &'static str
```

**Purpose**: Returns the user-facing label for an action menu option.

**Data flow**: Matches `self` and returns one of `Import selected`, `Customize selection`, `Cancel`, or `Review selection`.

**Call relations**: Used by the rendering layer to display action buttons.


##### `run_external_agent_config_migration_prompt`  (lines 77–115)

```
async fn run_external_agent_config_migration_prompt(
    tui: &mut Tui,
    items: &[ExternalAgentConfigMigrationItem],
    selected_items: &[ExternalAgentConfigMigrationItem],
    error: Option<&str>
```

**Purpose**: Runs the full asynchronous migration prompt until the user proceeds, skips, or the event stream ends.

**Data flow**: Takes mutable `Tui`, item slices, selected-item slice, and optional error string; constructs a screen, draws it once, then loops over `tui.event_stream()`. Key events mutate screen state, draw/resize events redraw, EOF triggers `screen.skip()`, and the final `screen.outcome()` is returned.

**Call relations**: Called by higher-level migration orchestration. It owns the event loop and delegates all state transitions to the screen object.

*Call graph*: calls 1 internal fn (new); called by 1 (handle_external_agent_config_migration_prompt); 4 external calls (draw, event_stream, frame_requester, pin!).


##### `ExternalAgentConfigMigrationScreen::proceed_enabled`  (lines 132–134)

```
fn proceed_enabled(&self) -> bool
```

**Purpose**: Reports whether the `Proceed` action should be available.

**Data flow**: Calls `self.selected_count()` and returns whether it is greater than zero.

**Call relations**: Used by `available_actions` to hide `Proceed` when nothing is selected.

*Call graph*: calls 1 internal fn (selected_count); called by 1 (available_actions).


##### `ExternalAgentConfigMigrationScreen::first_available_action`  (lines 136–141)

```
fn first_available_action(&self) -> ActionMenuOption
```

**Purpose**: Returns the first currently visible action, defaulting to `Back` if none are available.

**Data flow**: Builds `available_actions()`, takes `.first()`, and returns the copied action or `ActionMenuOption::Back`.

**Call relations**: Used when normalizing or resetting action focus.

*Call graph*: calls 1 internal fn (available_actions); called by 3 (back_to_summary, move_down, normalize_highlighted_action).


##### `ExternalAgentConfigMigrationScreen::last_available_action`  (lines 143–148)

```
fn last_available_action(&self) -> ActionMenuOption
```

**Purpose**: Returns the last currently visible action, defaulting to `Back` if none are available.

**Data flow**: Builds `available_actions()`, takes `.last()`, and returns the copied action or `Back`.

**Call relations**: Used when moving focus upward from the item list into actions.

*Call graph*: calls 1 internal fn (available_actions); called by 1 (move_up).


##### `ExternalAgentConfigMigrationScreen::previous_available_action`  (lines 150–158)

```
fn previous_available_action(&self, action: ActionMenuOption) -> Option<ActionMenuOption>
```

**Purpose**: Returns the action immediately before a given action in the current visible action list.

**Data flow**: Builds `available_actions()`, finds the position of `action`, subtracts one if possible, and returns the copied previous action.

**Call relations**: Used by `move_up` for action-menu navigation.

*Call graph*: calls 1 internal fn (available_actions); called by 1 (move_up).


##### `ExternalAgentConfigMigrationScreen::next_available_action`  (lines 160–167)

```
fn next_available_action(&self, action: ActionMenuOption) -> Option<ActionMenuOption>
```

**Purpose**: Returns the action immediately after a given action in the current visible action list.

**Data flow**: Builds `available_actions()`, finds the position of `action`, looks up the next index, and returns the copied action if present.

**Call relations**: Used by `move_down` for action-menu navigation.

*Call graph*: calls 1 internal fn (available_actions); called by 1 (move_down).


##### `ExternalAgentConfigMigrationScreen::available_actions`  (lines 169–181)

```
fn available_actions(&self) -> Vec<ActionMenuOption>
```

**Purpose**: Computes the visible action menu for the current view and selection state.

**Data flow**: In `Summary` view, it conditionally includes `Proceed` when `proceed_enabled()` is true, then appends `Customize` and `Skip`. In `Customize` view, it returns only `[Back]`.

**Call relations**: Central helper used by navigation, normalization, and numeric shortcut handling.

*Call graph*: calls 1 internal fn (proceed_enabled); called by 6 (first_available_action, last_available_action, next_available_action, normalize_highlighted_action, previous_available_action, select_numbered_action); 2 external calls (new, vec!).


##### `ExternalAgentConfigMigrationScreen::normalize_highlighted_action`  (lines 183–187)

```
fn normalize_highlighted_action(&mut self)
```

**Purpose**: Ensures the currently highlighted action is still valid after selection changes alter the visible action list.

**Data flow**: Checks whether `available_actions()` contains `self.highlighted_action`; if not, replaces it with `first_available_action()`.

**Call relations**: Called after bulk or individual selection changes so action focus never points at a hidden `Proceed` button.

*Call graph*: calls 2 internal fn (available_actions, first_available_action); called by 2 (set_all_enabled, toggle_selected_item).


##### `ExternalAgentConfigMigrationScreen::display_description`  (lines 189–260)

```
fn display_description(item: &ExternalAgentConfigMigrationItem) -> String
```

**Purpose**: Normalizes an item description into user-facing import wording and rewrites embedded paths relative to the item’s cwd when possible.

**Data flow**: Starts from `item.description`, rewrites a leading `Migrate ` to `Import `, then if `item.cwd` exists tries several prefix/separator patterns (`Import ... into ...`, `Import skills from ... to ...`, `Import ... to ...`) and rewrites both sides with `display_path_for`. For plugin-import descriptions it also appends marketplace/plugin counts from `item.details`.

**Call relations**: Used by customize-view line building so descriptions are concise and consistently phrased.

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

**Purpose**: Constructs the initial migration prompt state from all items, preselected items, and an optional error message.

**Data flow**: Groups items with `external_agent_config_migration_groups(items)`, clones each item into `MigrationSelection { enabled: selected_items.contains(&item), item }`, initializes summary view with action focus, selects the first group if any exist, sets default highlighted action to `Proceed`, then calls `normalize_highlighted_action()` before returning.

**Call relations**: Used by the async prompt runner and tests to create a fresh screen.

*Call graph*: calls 1 internal fn (external_agent_config_migration_groups); called by 12 (run_external_agent_config_migration_prompt, control_exit_shortcuts_cancel_prompt, customize_action_snapshot, customize_snapshot, empty_selection_enter_opens_customize_instead_of_proceeding, escape_skips_prompt, numeric_shortcuts_choose_actions, numeric_shortcuts_follow_visible_actions_when_proceed_is_disabled, proceed_returns_selected_items, prompt_snapshot (+2 more)); 1 external calls (iter).


##### `ExternalAgentConfigMigrationScreen::plugin_detail_lines`  (lines 295–327)

```
fn plugin_detail_lines(plugin_groups: &[PluginsMigration]) -> Vec<Line<'static>>
```

**Purpose**: Builds compact detail lines summarizing plugin marketplaces and plugin names for a migration item.

**Data flow**: Takes up to three `PluginsMigration` groups, for each takes up to two plugin names and appends `+N more` if additional plugins are hidden, formats lines like `• marketplace: plugin1, plugin2`, and appends a final `+N more marketplaces` line if more than three marketplaces exist.

**Call relations**: Used by customize-view rendering when an item includes plugin migration details.

*Call graph*: 4 external calls (from, iter, len, format!).


##### `ExternalAgentConfigMigrationScreen::is_done`  (lines 329–331)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the prompt has reached a terminal outcome.

**Data flow**: Returns the `done` boolean.

**Call relations**: Polled by the outer event loop.


##### `ExternalAgentConfigMigrationScreen::outcome`  (lines 333–335)

```
fn outcome(&self) -> ExternalAgentConfigMigrationOutcome
```

**Purpose**: Returns the current terminal outcome value.

**Data flow**: Clones and returns `self.outcome`.

**Call relations**: Called after the event loop exits and in tests.

*Call graph*: 1 external calls (clone).


##### `ExternalAgentConfigMigrationScreen::finish_with`  (lines 337–341)

```
fn finish_with(&mut self, outcome: ExternalAgentConfigMigrationOutcome)
```

**Purpose**: Stores a final outcome, marks the prompt done, and requests one more frame.

**Data flow**: Assigns `outcome`, sets `done = true`, and calls `request_frame.schedule_frame()`.

**Call relations**: Shared helper used by both `proceed` and `skip`.

*Call graph*: calls 1 internal fn (schedule_frame); called by 2 (proceed, skip).


##### `ExternalAgentConfigMigrationScreen::proceed`  (lines 343–346)

```
fn proceed(&mut self)
```

**Purpose**: Finishes the prompt with the currently selected migration items.

**Data flow**: Collects `selected_items()`, wraps them in `ExternalAgentConfigMigrationOutcome::Proceed`, and passes that to `finish_with`.

**Call relations**: Triggered by action confirmation when `Proceed` is highlighted.

*Call graph*: calls 2 internal fn (finish_with, selected_items); called by 1 (confirm_selection); 1 external calls (Proceed).


##### `ExternalAgentConfigMigrationScreen::skip`  (lines 348–350)

```
fn skip(&mut self)
```

**Purpose**: Finishes the prompt with a skip/cancel outcome.

**Data flow**: Calls `finish_with(ExternalAgentConfigMigrationOutcome::Skip)`.

**Call relations**: Triggered by explicit cancel actions, Ctrl-C/Ctrl-D, Esc in summary view, or EOF from the event stream.

*Call graph*: calls 1 internal fn (finish_with); called by 2 (confirm_selection, handle_key).


##### `ExternalAgentConfigMigrationScreen::selected_items`  (lines 352–358)

```
fn selected_items(&self) -> Vec<ExternalAgentConfigMigrationItem>
```

**Purpose**: Returns the currently enabled migration items in their original order.

**Data flow**: Filters `self.items` for `enabled`, clones each underlying `item`, and collects them into a vector.

**Call relations**: Used by `proceed` and tests.

*Call graph*: called by 1 (proceed).


##### `ExternalAgentConfigMigrationScreen::selected_count`  (lines 360–362)

```
fn selected_count(&self) -> usize
```

**Purpose**: Counts how many migration items are currently enabled.

**Data flow**: Iterates `self.items`, filters by `enabled`, and returns the count.

**Call relations**: Used by `proceed_enabled`.

*Call graph*: called by 1 (proceed_enabled).


##### `ExternalAgentConfigMigrationScreen::group_selection_marker`  (lines 364–378)

```
fn group_selection_marker(
        &self,
        group: &ExternalAgentConfigMigrationGroupModel,
    ) -> &'static str
```

**Purpose**: Computes the summary-view checkbox marker for a group based on how many of its items are enabled.

**Data flow**: Counts enabled items among `group.item_indices`; returns `" "` for none, `"x"` for all, and `"-"` for partial selection.

**Call relations**: Used by `build_summary_render_lines`.


##### `ExternalAgentConfigMigrationScreen::set_all_enabled`  (lines 380–387)

```
fn set_all_enabled(&mut self, enabled: bool)
```

**Purpose**: Bulk-enables or bulk-disables every migration item and clears any error message.

**Data flow**: Mutates every `MigrationSelection.enabled` to the provided boolean, sets `error = None`, normalizes the highlighted action, and schedules a frame.

**Call relations**: Triggered by `a` and `n` shortcuts in customize view.

*Call graph*: calls 2 internal fn (normalize_highlighted_action, schedule_frame); called by 1 (handle_key).


##### `ExternalAgentConfigMigrationScreen::toggle_selected_item`  (lines 389–403)

```
fn toggle_selected_item(&mut self)
```

**Purpose**: Toggles the enabled state of the currently selected item, but only when customize view is focused on items.

**Data flow**: Early-returns unless `view == Customize` and `focus == Items`; then looks up `selected_item_idx`, flips that item’s `enabled` flag, clears `error`, normalizes the highlighted action, and schedules a frame.

**Call relations**: Triggered by Space or Enter on an item row.

*Call graph*: calls 2 internal fn (normalize_highlighted_action, schedule_frame); called by 2 (confirm_selection, handle_key).


##### `ExternalAgentConfigMigrationScreen::customize`  (lines 405–412)

```
fn customize(&mut self)
```

**Purpose**: Switches from summary view into customize view with item focus at the top of the item list.

**Data flow**: Sets `view = Customize`, selects item 0 if any items exist, resets `scroll_top` to 0, sets `focus = Items`, highlights `Back`, and schedules a frame.

**Call relations**: Triggered by the `Customize` action, `c` shortcut in summary view, or Enter when customize is the first visible action.

*Call graph*: calls 1 internal fn (schedule_frame); called by 2 (confirm_selection, handle_key).


##### `ExternalAgentConfigMigrationScreen::back_to_summary`  (lines 414–421)

```
fn back_to_summary(&mut self)
```

**Purpose**: Returns from customize view to summary view and restores action focus.

**Data flow**: Sets `view = Summary`, selects group 0 if any groups exist, resets `scroll_top`, sets `focus = Actions`, highlights `first_available_action()`, and schedules a frame.

**Call relations**: Triggered by the `Back` action, `b` shortcut in customize view, or Esc in customize view.

*Call graph*: calls 2 internal fn (first_available_action, schedule_frame); called by 2 (confirm_selection, handle_key).


##### `ExternalAgentConfigMigrationScreen::move_up`  (lines 423–459)

```
fn move_up(&mut self)
```

**Purpose**: Moves selection upward through actions or items, including transitions between focus areas.

**Data flow**: In summary view it cycles upward through available actions, wrapping to the last action. In customize view, moving up from the first item transfers focus to actions and highlights the last action; moving up within actions either selects the previous action or transfers focus back to the last item. It then ensures the selected item is visible and schedules a frame.

**Call relations**: Called by `handle_key` for Up/k navigation.

*Call graph*: calls 4 internal fn (ensure_selected_item_visible, last_available_action, previous_available_action, schedule_frame); called by 1 (handle_key).


##### `ExternalAgentConfigMigrationScreen::move_down`  (lines 461–493)

```
fn move_down(&mut self)
```

**Purpose**: Moves selection downward through actions or items, including transitions between focus areas.

**Data flow**: In summary view it cycles downward through available actions, wrapping to the first action. In customize view, moving down within items advances to the next item or transfers focus to actions; moving down within actions advances to the next action or transfers focus back to the first item. It then ensures visibility and schedules a frame.

**Call relations**: Called by `handle_key` for Down/j navigation.

*Call graph*: calls 4 internal fn (ensure_selected_item_visible, first_available_action, next_available_action, schedule_frame); called by 1 (handle_key).


##### `ExternalAgentConfigMigrationScreen::confirm_selection`  (lines 495–505)

```
fn confirm_selection(&mut self)
```

**Purpose**: Executes the currently focused selection target, either toggling an item or invoking the highlighted action.

**Data flow**: If focus is `Items`, calls `toggle_selected_item()`. If focus is `Actions`, dispatches to `proceed`, `customize`, `skip`, or `back_to_summary` based on `highlighted_action`.

**Call relations**: Triggered by Enter and by numeric action shortcuts after they set action focus.

*Call graph*: calls 5 internal fn (back_to_summary, customize, proceed, skip, toggle_selected_item); called by 2 (handle_key, select_numbered_action).


##### `ExternalAgentConfigMigrationScreen::handle_key`  (lines 507–538)

```
fn handle_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Implements all keyboard behavior for the migration prompt, including navigation, selection, bulk toggles, view switching, and cancellation.

**Data flow**: Ignores key-release events, checks `is_ctrl_exit_combo` for immediate skip, then matches on `key_event.code` to move up/down, invoke numbered actions, switch views with `c`/`b`, toggle items with Space, bulk-enable/disable with `a`/`n`, confirm with Enter, or map Esc to skip/back depending on view.

**Call relations**: Called from the outer event loop for every key event; it is the main state-transition dispatcher.

*Call graph*: calls 10 internal fn (back_to_summary, confirm_selection, customize, move_down, move_up, select_numbered_action, set_all_enabled, skip, toggle_selected_item, is_ctrl_exit_combo).


##### `ExternalAgentConfigMigrationScreen::select_numbered_action`  (lines 540–550)

```
fn select_numbered_action(&mut self, number: char)
```

**Purpose**: Maps a numeric shortcut to the corresponding currently visible action and immediately confirms it.

**Data flow**: Converts the digit char to a zero-based index, looks up that index in `available_actions()`, sets `focus = Actions`, updates `highlighted_action`, and calls `confirm_selection()`.

**Call relations**: Used by `handle_key` so numeric shortcuts track the dynamic visible action list.

*Call graph*: calls 2 internal fn (available_actions, confirm_selection); called by 1 (handle_key).


##### `ExternalAgentConfigMigrationScreen::ensure_selected_item_visible`  (lines 552–567)

```
fn ensure_selected_item_visible(&mut self)
```

**Purpose**: Adjusts `scroll_top` so the selected item’s render line stays within the visible window.

**Data flow**: If no item is selected, resets `scroll_top` to 0. Otherwise it computes the selected item’s render-line index and the total visible row count from `render_line_count()`, then shifts `scroll_top` upward or downward to include the selected line.

**Call relations**: Called after item-navigation changes in customize view.

*Call graph*: calls 2 internal fn (render_line_count, selected_render_line_index); called by 2 (move_down, move_up).


##### `ExternalAgentConfigMigrationScreen::render_line_count`  (lines 569–571)

```
fn render_line_count(&self) -> usize
```

**Purpose**: Returns how many render-line entries the current view produces.

**Data flow**: Builds the current render lines with `build_render_lines()` and returns their length.

**Call relations**: Used by scrolling logic.

*Call graph*: calls 1 internal fn (build_render_lines); called by 1 (ensure_selected_item_visible).


##### `ExternalAgentConfigMigrationScreen::selected_render_line_index`  (lines 573–578)

```
fn selected_render_line_index(&self, selected_item_idx: usize) -> usize
```

**Purpose**: Finds the render-line index corresponding to a selected item index.

**Data flow**: Builds current render lines, searches for the first entry whose `item_idx` matches `selected_item_idx`, and falls back to the item index itself if not found.

**Call relations**: Used by `ensure_selected_item_visible`.

*Call graph*: calls 1 internal fn (build_render_lines); called by 1 (ensure_selected_item_visible).


##### `ExternalAgentConfigMigrationScreen::section_title`  (lines 580–588)

```
fn section_title(cwd: Option<&std::path::Path>) -> Line<'static>
```

**Purpose**: Builds the customize-view section header for a cwd scope.

**Data flow**: If `cwd` is `Some`, returns `Current project: <cwd>` with bold label and dim path; otherwise returns `Home` in bold.

**Call relations**: Used by `build_customize_render_lines` when grouping items by scope.

*Call graph*: 2 external calls (from, vec!).


##### `ExternalAgentConfigMigrationScreen::build_render_lines`  (lines 590–595)

```
fn build_render_lines(&self) -> Vec<RenderLineEntry>
```

**Purpose**: Dispatches to the appropriate render-line builder for the current view.

**Data flow**: Matches `self.view` and returns either `build_summary_render_lines()` or `build_customize_render_lines()`.

**Call relations**: Used by scrolling logic and by the rendering submodule.

*Call graph*: calls 2 internal fn (build_customize_render_lines, build_summary_render_lines); called by 2 (render_line_count, selected_render_line_index).


##### `ExternalAgentConfigMigrationScreen::build_summary_render_lines`  (lines 597–620)

```
fn build_summary_render_lines(&self) -> Vec<RenderLineEntry>
```

**Purpose**: Builds the summary-view line model from grouped migration items.

**Data flow**: Iterates `self.groups` with indices and emits, for each group, one item line containing the group selection marker and label plus one detail line containing the group description.

**Call relations**: Used when the screen is in summary view.

*Call graph*: called by 1 (build_render_lines).


##### `ExternalAgentConfigMigrationScreen::build_customize_render_lines`  (lines 622–678)

```
fn build_customize_render_lines(&self) -> Vec<RenderLineEntry>
```

**Purpose**: Builds the customize-view line model with section headers, per-item checkboxes, normalized descriptions, optional detail text, and plugin detail bullets.

**Data flow**: Iterates `self.items`, inserts a blank line and `section_title` whenever cwd scope changes, emits an item line with `[x]` or `[ ]` plus `external_agent_config_migration_item_label`, emits a detail line using `display_description`, optionally appends `external_agent_config_migration_item_detail`, and appends plugin detail lines from `plugin_detail_lines` when present.

**Call relations**: Used when the screen is in customize view.

*Call graph*: calls 1 internal fn (external_agent_config_migration_item_detail); called by 1 (build_render_lines); 6 external calls (from, plugin_detail_lines, section_title, new, format!, vec!).


##### `is_ctrl_exit_combo`  (lines 681–684)

```
fn is_ctrl_exit_combo(key_event: KeyEvent) -> bool
```

**Purpose**: Recognizes Ctrl-C and Ctrl-D as prompt-cancel shortcuts.

**Data flow**: Checks that the key code is `Char('c')` or `Char('d')` and that `KeyModifiers::CONTROL` is present.

**Call relations**: Used by `handle_key` for immediate cancellation.

*Call graph*: called by 1 (handle_key); 1 external calls (matches!).


##### `tests::sample_plugin_details`  (lines 706–732)

```
fn sample_plugin_details() -> codex_app_server_protocol::MigrationDetails
```

**Purpose**: Builds a representative plugin-migration detail fixture with multiple marketplaces and plugin counts.

**Data flow**: Constructs `MigrationDetails` containing four `PluginsMigration` entries and default values for other fields.

**Call relations**: Used by sample-item fixtures and snapshot tests.

*Call graph*: 2 external calls (default, vec!).


##### `tests::sample_project_root`  (lines 740–742)

```
fn sample_project_root() -> PathBuf
```

**Purpose**: Returns a platform-specific sample project root path for tests.

**Data flow**: Constructs a `PathBuf` using either a Windows or Unix literal depending on cfg.

**Call relations**: Used by sample path and item helpers.

*Call graph*: 1 external calls (from).


##### `tests::sample_project_path`  (lines 744–746)

```
fn sample_project_path(path: &str) -> String
```

**Purpose**: Builds a sample absolute path under the sample project root.

**Data flow**: Calls `sample_project_root()`, joins the provided relative path, and returns its display string.

**Call relations**: Used by `sample_items` to build realistic descriptions.

*Call graph*: 1 external calls (sample_project_root).


##### `tests::sample_items`  (lines 748–792)

```
fn sample_items() -> Vec<ExternalAgentConfigMigrationItem>
```

**Purpose**: Builds a representative set of migration items covering config, sessions, plugins, and AGENTS.md migration.

**Data flow**: Constructs four `ExternalAgentConfigMigrationItem` values with realistic descriptions, cwd scopes, and optional details, using `sample_project_root`, `sample_project_path`, and `sample_plugin_details`.

**Call relations**: Shared fixture for prompt snapshots and interaction tests.

*Call graph*: 2 external calls (sample_project_root, vec!).


##### `tests::render_screen`  (lines 794–814)

```
fn render_screen(
        screen: &ExternalAgentConfigMigrationScreen,
        width: u16,
        height: u16,
    ) -> String
```

**Purpose**: Renders the migration screen into a VT100 test backend and returns the trimmed textual screen contents.

**Data flow**: Creates a `VT100Backend`, wraps it in the custom `Terminal`, sets viewport area, obtains a frame, renders the screen widget into the frame, flushes the terminal, then converts backend output to lines with trailing spaces trimmed and joins them with newlines.

**Call relations**: Shared helper for snapshot tests.

*Call graph*: calls 2 internal fn (with_options, new); 1 external calls (new).


##### `tests::prompt_snapshot`  (lines 817–831)

```
fn prompt_snapshot()
```

**Purpose**: Snapshot-tests the default summary-view migration prompt.

**Data flow**: Builds sample items, constructs a screen with all items selected, renders it with `render_screen`, and snapshots the result with platform-specific snapshot names.

**Call relations**: Visual regression for summary view.

*Call graph*: calls 2 internal fn (new, test_dummy); 3 external calls (assert_snapshot!, render_screen, sample_items).


##### `tests::customize_snapshot`  (lines 834–852)

```
fn customize_snapshot()
```

**Purpose**: Snapshot-tests the customize view after switching from summary.

**Data flow**: Builds the screen, calls `customize()`, renders it, and snapshots the result.

**Call relations**: Visual regression for customize view.

*Call graph*: calls 2 internal fn (new, test_dummy); 3 external calls (assert_snapshot!, render_screen, sample_items).


##### `tests::customize_action_snapshot`  (lines 855–874)

```
fn customize_action_snapshot()
```

**Purpose**: Snapshot-tests customize view with focus moved from items up to the action area.

**Data flow**: Builds the screen, enters customize view, calls `move_up()`, renders it, and snapshots the result.

**Call relations**: Visual regression for focus-state rendering.

*Call graph*: calls 2 internal fn (new, test_dummy); 3 external calls (assert_snapshot!, render_screen, sample_items).


##### `tests::proceed_returns_selected_items`  (lines 877–893)

```
fn proceed_returns_selected_items()
```

**Purpose**: Verifies that pressing Enter in the default state proceeds with all selected items.

**Data flow**: Builds the screen with all items selected, sends an Enter key event, then asserts the screen is done and the outcome is `Proceed(items)`.

**Call relations**: Covers default action selection and proceed flow.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (new, assert!, assert_eq!, sample_items).


##### `tests::toggle_item_then_proceed_keeps_remaining_selection`  (lines 896–919)

```
fn toggle_item_then_proceed_keeps_remaining_selection()
```

**Purpose**: Verifies that deselecting one item in customize view and then proceeding returns only the remaining enabled items.

**Data flow**: Builds the screen, enters customize view, toggles the first item with Space, returns to summary with `b`, triggers action `1`, and asserts the outcome contains items 1..3.

**Call relations**: Exercises customize toggling plus numeric action shortcuts.

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (Char, new, assert!, assert_eq!, sample_items).


##### `tests::escape_skips_prompt`  (lines 922–935)

```
fn escape_skips_prompt()
```

**Purpose**: Verifies that Esc in summary view cancels the prompt.

**Data flow**: Builds the screen, sends an Esc key event, and asserts the screen is done with `Skip` outcome.

**Call relations**: Covers summary-view escape behavior.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (new, assert!, assert_eq!, sample_items).


##### `tests::numeric_shortcuts_follow_visible_actions_when_proceed_is_disabled`  (lines 938–953)

```
fn numeric_shortcuts_follow_visible_actions_when_proceed_is_disabled()
```

**Purpose**: Checks that numeric shortcuts map to the currently visible actions after `Proceed` disappears.

**Data flow**: Builds the screen, enters customize view, disables all items with `n`, returns to summary, presses `1`, and asserts the view becomes `Customize` rather than proceeding.

**Call relations**: Regression test for dynamic action indexing.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (Char, new, assert_eq!, sample_items).


##### `tests::empty_selection_enter_opens_customize_instead_of_proceeding`  (lines 956–969)

```
fn empty_selection_enter_opens_customize_instead_of_proceeding()
```

**Purpose**: Verifies that when nothing is preselected, pressing Enter activates `Customize` instead of a hidden `Proceed` action.

**Data flow**: Builds the screen with an empty selected-items slice, sends Enter, and asserts the prompt is not done and the view is `Customize`.

**Call relations**: Covers action normalization when `Proceed` is unavailable.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (new, assert!, assert_eq!, sample_items).


##### `tests::control_exit_shortcuts_cancel_prompt`  (lines 972–987)

```
fn control_exit_shortcuts_cancel_prompt()
```

**Purpose**: Verifies both Ctrl-C and Ctrl-D cancel the prompt immediately.

**Data flow**: For each key code, builds a fresh screen, sends the control-modified key event, and asserts the prompt is done with `Skip` outcome.

**Call relations**: Covers `is_ctrl_exit_combo` and cancellation handling.

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (Char, new, assert!, assert_eq!, sample_items).


##### `tests::numeric_shortcuts_choose_actions`  (lines 990–1027)

```
fn numeric_shortcuts_choose_actions()
```

**Purpose**: Verifies numeric shortcuts activate `Proceed`, `Customize`, `Back`, and `Skip` according to the visible action list.

**Data flow**: Builds separate screens, presses `1`, `2`, or `3` as appropriate, and asserts the resulting outcome or view transition matches the expected action.

**Call relations**: Exercises `select_numbered_action` across both views.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (Char, new, assert_eq!, sample_items).


##### `tests::summary_does_not_toggle_selection`  (lines 1030–1042)

```
fn summary_does_not_toggle_selection()
```

**Purpose**: Verifies that pressing Space in summary view does not alter item selection.

**Data flow**: Builds the screen, sends a Space key event, and asserts `selected_items()` still equals the original item list.

**Call relations**: Covers the view-guard in `toggle_selected_item`.

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (Char, new, assert_eq!, sample_items).


### `tui/src/external_agent_config_migration/render.rs`

`io_transport` · `interactive prompt rendering`

This file is the view layer for `ExternalAgentConfigMigrationScreen`. It implements two rendering methods: one for the scrollable item list and one for the full screen widget. The top-level renderer clears the target rectangle, applies vertical/horizontal insets, computes dynamic section heights from the current `MigrationView`, optional `error`, available actions, and the number of render lines, then splits the inner area into header, intro, error, list, actions, and footer regions using `Layout::vertical` constraints.

The intro copy and title change between `Summary` and `Customize` modes. The actions section always begins with a sentence reporting `selected_count()` out of `self.items.len()`, then renders each action row with dimming based on whether `FocusArea::Actions` is active. The footer text also changes by mode and focus, showing different key hints for selection versus toggling.

`render_items` is responsible for viewport management over `build_render_lines()`. It derives `start_idx` from `scroll_top`, then adjusts it so the currently selected item’s render-line index stays visible. Each visible row is cloned and restyled: the selected row gets a leading `› ` marker plus cyan bold styling when item focus is active; non-item rows are dimmed. Every line is truncated with ellipsis to fit `area.width` before being rendered one row tall. Zero-sized areas short-circuit immediately, avoiding invalid rendering work.

#### Function details

##### `ExternalAgentConfigMigrationScreen::render_items`  (lines 18–70)

```
fn render_items(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Draws the scrollable list portion of the migration screen, keeping the selected item within the visible viewport and applying per-row styling. It renders only the rows that fit in the provided rectangle.

**Data flow**: It reads `area`, the mutable `Buffer`, and screen state from `self`: `scroll_top`, `selected_item_idx`, `focus`, and the render-line data produced by `build_render_lines()`. It computes a starting row index, adjusts it using `selected_render_line_index` so the selected item remains visible, clones each visible line, mutates spans for selection or dimming, truncates the line with `truncate_line_with_ellipsis_if_overflow`, and writes the final one-line widgets into `buf`. It returns no value and updates no persistent state.

**Call relations**: This method is invoked only from `ExternalAgentConfigMigrationScreen::render_ref` after the outer layout has reserved the list area. Its main delegated work is overflow-safe line shortening via `truncate_line_with_ellipsis_if_overflow`, which ensures styled rows fit the current terminal width.

*Call graph*: calls 1 internal fn (truncate_line_with_ellipsis_if_overflow); called by 1 (render_ref).


##### `ExternalAgentConfigMigrationScreen::render_ref`  (lines 74–205)

```
fn render_ref(&self, area: Rect, buf: &mut Buffer)
```

**Purpose**: Renders the complete migration prompt screen into a ratatui buffer, including title, explanatory copy, optional error text, item list, action rows, and footer instructions. It adapts the layout and wording to the current migration view and focus area.

**Data flow**: It consumes `area`, `buf`, and reads screen state from `self`: `view`, `error`, `items`, `focus`, `highlighted_action`, and selection counts via helper methods. It clears the full area, computes an inset inner rectangle with `Insets::vh`, builds intro lines and title text from `MigrationView`, derives heights for fixed sections and the list, splits the area with `Layout::vertical`, renders paragraphs and lines into each sub-rectangle, calls `render_items` for the list body, and renders action rows using `selection_option_row_with_dim`. It returns nothing and writes only to the terminal buffer.

**Call relations**: This is the ratatui `WidgetRef` entry for `&ExternalAgentConfigMigrationScreen`, so the broader TUI rendering pipeline calls it whenever this screen is active. It delegates list-body drawing to `ExternalAgentConfigMigrationScreen::render_items`, uses shared rendering helpers like `Insets::vh` and `selection_option_row_with_dim`, and assembles the final screen from those lower-level pieces.

*Call graph*: calls 3 internal fn (render_items, vh, selection_option_row_with_dim); 10 external calls (Fill, Length, vertical, from, new, inset, format!, repeat_n, from, vec!).


### `tui/src/model_migration.rs`

`orchestration` · `interactive migration prompt during startup or model-switch flow`

This module owns the model-migration prompt end to end. `ModelMigrationOutcome` captures the three terminal states, while `ModelMigrationCopy` packages either structured heading/content lines or a markdown body plus the `can_opt_out` flag that determines whether the prompt shows a two-option menu. `migration_copy_for_models` synthesizes that copy from model names, optional custom text, optional markdown templates, optional docs links, and fallback descriptions. If markdown is supplied, it bypasses the normal heading/content layout and fills `{model_from}` / `{model_to}` placeholders.

`run_model_migration_prompt` drives the interactive lifecycle. It enters the terminal alternate screen via `AltScreenGuard`, creates a `ModelMigrationScreen`, draws once, then consumes `TuiEvent`s until the screen marks itself done or the event stream ends. Key handling ignores release events, treats Ctrl-C/Ctrl-D as explicit exit, and otherwise routes to menu navigation or simple accept-on-Esc/Enter behavior depending on `can_opt_out`. The screen stores the highlighted menu option, current outcome, and a `FrameRequester` used to schedule redraws only when state changes.

Rendering is implemented through `WidgetRef` for `&ModelMigrationScreen`. The widget clears the area, builds a `ColumnRenderable`, renders either markdown or structured lines with left insets, and optionally appends a numbered selection menu plus key hints. The alternate-screen guard ensures the prompt does not leave blank space in normal scrollback after dismissal.

#### Function details

##### `MigrationMenuOption::all`  (lines 48–50)

```
fn all() -> [Self; 2]
```

**Purpose**: Returns the fixed ordered list of menu choices shown when opting out is allowed.

**Data flow**: It produces a two-element array containing `TryNewModel` followed by `UseExistingModel`. It reads no state and writes nothing.

**Call relations**: This helper is used by `ModelMigrationScreen::render_menu` to render menu rows in a stable order.

*Call graph*: called by 1 (render_menu).


##### `MigrationMenuOption::label`  (lines 52–57)

```
fn label(self) -> &'static str
```

**Purpose**: Maps each menu enum variant to the exact user-facing label rendered in the prompt.

**Data flow**: It takes `self` and returns a static string: either `"Try new model"` or `"Use existing model"`. No state is mutated.

**Call relations**: The labels are consumed when `render_menu` iterates over `MigrationMenuOption::all()` to build selection rows.


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

**Purpose**: Builds the prompt text shown to the user, choosing between markdown-driven copy and a structured heading/content layout with sensible fallbacks.

**Data flow**: Inputs include current and target model identifiers, optional docs link, optional custom migration copy, optional markdown template, target display name, optional target description, and `can_opt_out`. If markdown is present, it calls `fill_migration_markdown` and returns a `ModelMigrationCopy` with empty heading/content and populated `markdown`. Otherwise it constructs a bold heading, chooses a description from explicit migration copy, target description, or a default recommendation sentence, optionally prepends a recommendation line, optionally appends a cyan underlined link, and ends with either an opt-out sentence or a dim `Press enter to continue` line. It returns the assembled `ModelMigrationCopy` without side effects.

**Call relations**: This is the copy-construction entry used by tests and likely by higher-level migration orchestration before `run_model_migration_prompt` displays the result.

*Call graph*: calls 1 internal fn (fill_migration_markdown); called by 6 (escape_key_accepts_prompt, prompt_snapshot, prompt_snapshot_gpt5_codex, prompt_snapshot_gpt5_codex_mini, prompt_snapshot_gpt5_family, selecting_use_existing_model_rejects_upgrade); 5 external calls (from, from, new, format!, vec!).


##### `run_model_migration_prompt`  (lines 137–169)

```
async fn run_model_migration_prompt(
    tui: &mut Tui,
    copy: ModelMigrationCopy,
) -> ModelMigrationOutcome
```

**Purpose**: Runs the interactive migration prompt until the user accepts, rejects, exits, or the event stream ends.

**Data flow**: It takes a mutable `Tui` and prepared `ModelMigrationCopy`. It enters the alternate screen with `AltScreenGuard::enter`, creates a `ModelMigrationScreen`, performs an initial draw, then pins and polls the TUI event stream. Key events are forwarded to `screen.handle_key`, paste events are ignored, and draw/resize events trigger redraws. If the stream ends, it forces acceptance. It returns the final `ModelMigrationOutcome`.

**Call relations**: This is the top-level driver for the module. It wires together alternate-screen setup, screen state, event handling, and redraws, delegating all interaction decisions to `ModelMigrationScreen` methods.

*Call graph*: calls 2 internal fn (enter, new); 1 external calls (pin!).


##### `ModelMigrationScreen::new`  (lines 180–188)

```
fn new(request_frame: FrameRequester, copy: ModelMigrationCopy) -> Self
```

**Purpose**: Initializes the prompt screen state with default selection and accepted outcome.

**Data flow**: It takes a `FrameRequester` and `ModelMigrationCopy`, stores them, sets `done` to `false`, `outcome` to `Accepted`, and `highlighted_option` to `TryNewModel`, then returns the new screen.

**Call relations**: This constructor is used by `run_model_migration_prompt` and by rendering/interaction tests that exercise the screen in isolation.

*Call graph*: called by 8 (run_model_migration_prompt, escape_key_accepts_prompt, markdown_prompt_keeps_long_url_tail_visible_when_narrow, prompt_snapshot, prompt_snapshot_gpt5_codex, prompt_snapshot_gpt5_codex_mini, prompt_snapshot_gpt5_family, selecting_use_existing_model_rejects_upgrade).


##### `ModelMigrationScreen::finish_with`  (lines 190–194)

```
fn finish_with(&mut self, outcome: ModelMigrationOutcome)
```

**Purpose**: Marks the prompt complete with a specific outcome and requests one more frame.

**Data flow**: It takes a mutable screen and a `ModelMigrationOutcome`, writes that outcome into `self.outcome`, sets `self.done = true`, and calls `self.request_frame.schedule_frame()`. It returns nothing.

**Call relations**: This is the shared completion primitive used by `accept`, `reject`, and `exit` so all terminal states consistently trigger a redraw.

*Call graph*: calls 1 internal fn (schedule_frame); called by 3 (accept, exit, reject).


##### `ModelMigrationScreen::accept`  (lines 196–198)

```
fn accept(&mut self)
```

**Purpose**: Completes the prompt with the accepted outcome.

**Data flow**: It mutably borrows the screen and forwards to `finish_with(ModelMigrationOutcome::Accepted)`, updating internal state and scheduling a frame.

**Call relations**: This path is reached from `confirm_selection`, direct non-menu key handling, menu shortcuts, and EOF handling in `run_model_migration_prompt`.

*Call graph*: calls 1 internal fn (finish_with); called by 3 (confirm_selection, handle_key, handle_menu_key).


##### `ModelMigrationScreen::reject`  (lines 200–202)

```
fn reject(&mut self)
```

**Purpose**: Completes the prompt with the rejected outcome when the user chooses to keep the existing model.

**Data flow**: It mutably borrows the screen and calls `finish_with(ModelMigrationOutcome::Rejected)`, setting state and scheduling a frame.

**Call relations**: This is invoked from `confirm_selection` and from the explicit `2` shortcut in `handle_menu_key`.

*Call graph*: calls 1 internal fn (finish_with); called by 2 (confirm_selection, handle_menu_key).


##### `ModelMigrationScreen::exit`  (lines 204–206)

```
fn exit(&mut self)
```

**Purpose**: Completes the prompt with the explicit exit outcome used for Ctrl-C/Ctrl-D cancellation.

**Data flow**: It mutably borrows the screen and calls `finish_with(ModelMigrationOutcome::Exit)`, updating state and scheduling a frame.

**Call relations**: Only `handle_key` reaches this path, after `is_ctrl_exit_combo` recognizes a control-key exit gesture.

*Call graph*: calls 1 internal fn (finish_with); called by 1 (handle_key).


##### `ModelMigrationScreen::confirm_selection`  (lines 208–217)

```
fn confirm_selection(&mut self)
```

**Purpose**: Applies the currently highlighted menu choice, or accepts immediately when opting out is not allowed.

**Data flow**: It reads `self.copy.can_opt_out` and `self.highlighted_option`. If opt-out is enabled, `TryNewModel` maps to `accept()` and `UseExistingModel` maps to `reject()`; otherwise it always calls `accept()`. It returns nothing.

**Call relations**: This method is called from `handle_menu_key` for Enter and Esc, centralizing the mapping from highlighted option to final outcome.

*Call graph*: calls 2 internal fn (accept, reject); called by 1 (handle_menu_key).


##### `ModelMigrationScreen::highlight_option`  (lines 219–224)

```
fn highlight_option(&mut self, option: MigrationMenuOption)
```

**Purpose**: Updates the highlighted menu row and schedules a redraw only when the selection actually changes.

**Data flow**: It takes a target `MigrationMenuOption`, compares it to `self.highlighted_option`, and if different writes the new option and calls `self.request_frame.schedule_frame()`. It returns nothing.

**Call relations**: This is used by `handle_menu_key` for arrow/j/k navigation and numeric shortcuts so rendering stays in sync with selection changes.

*Call graph*: calls 1 internal fn (schedule_frame); called by 1 (handle_menu_key).


##### `ModelMigrationScreen::handle_key`  (lines 226–241)

```
fn handle_key(&mut self, key_event: KeyEvent)
```

**Purpose**: Processes one keyboard event according to prompt mode, ignoring releases and distinguishing accept, reject, and exit gestures.

**Data flow**: It takes a `KeyEvent`. If the event kind is `Release`, it returns immediately. If `is_ctrl_exit_combo` matches, it calls `exit()` and stops. Otherwise, when `can_opt_out` is true it delegates to `handle_menu_key(key_event.code)`; when opt-out is false it accepts on `Esc` or `Enter`. It mutates screen state through those delegated methods.

**Call relations**: This is the main event handler called by `run_model_migration_prompt` for every `TuiEvent::Key`. It delegates menu-specific behavior to `handle_menu_key` and exit detection to `is_ctrl_exit_combo`.

*Call graph*: calls 4 internal fn (accept, exit, handle_menu_key, is_ctrl_exit_combo); 1 external calls (matches!).


##### `ModelMigrationScreen::is_done`  (lines 243–245)

```
fn is_done(&self) -> bool
```

**Purpose**: Reports whether the prompt has reached a terminal state.

**Data flow**: It reads `self.done` and returns that boolean. No state changes occur.

**Call relations**: The event loop in `run_model_migration_prompt` polls this method to know when to stop consuming events.


##### `ModelMigrationScreen::outcome`  (lines 247–249)

```
fn outcome(&self) -> ModelMigrationOutcome
```

**Purpose**: Returns the final or current outcome stored on the screen.

**Data flow**: It reads `self.outcome` and returns the `ModelMigrationOutcome` by copy. No mutation occurs.

**Call relations**: After the event loop ends, `run_model_migration_prompt` calls this to produce its return value; tests also inspect it directly.


##### `ModelMigrationScreen::render_ref`  (lines 253–270)

```
fn render_ref(&self, area: ratatui::layout::Rect, buf: &mut ratatui::buffer::Buffer)
```

**Purpose**: Renders the migration prompt into the provided ratatui buffer, choosing between markdown and structured content layouts.

**Data flow**: It receives the target `area` and mutable `Buffer`. It clears the area, creates a `ColumnRenderable`, inserts a top spacer, then either calls `render_markdown_content` with the current width or pushes `heading_line`, a blank line, and `render_content`. If `can_opt_out` is true it appends `render_menu`, then renders the column into the buffer.

**Call relations**: This `WidgetRef` implementation is invoked by the initial draw and redraws in `run_model_migration_prompt`, and by snapshot tests that render the screen directly.

*Call graph*: calls 5 internal fn (heading_line, render_content, render_markdown_content, render_menu, new); 1 external calls (from).


##### `ModelMigrationScreen::handle_menu_key`  (lines 274–293)

```
fn handle_menu_key(&mut self, code: KeyCode)
```

**Purpose**: Implements menu navigation and selection shortcuts for the opt-out prompt variant.

**Data flow**: It takes a `KeyCode` and matches it: Up/k highlights `TryNewModel`, Down/j highlights `UseExistingModel`, `1` highlights then accepts, `2` highlights then rejects, and Enter/Esc confirms the current selection. Other keys are ignored. It mutates selection and completion state through helper methods.

**Call relations**: This method is called only from `handle_key` when `copy.can_opt_out` is true, separating menu-specific controls from the outer key-event policy.

*Call graph*: calls 4 internal fn (accept, confirm_selection, highlight_option, reject); called by 1 (handle_key).


##### `ModelMigrationScreen::heading_line`  (lines 295–299)

```
fn heading_line(&self) -> Line<'static>
```

**Purpose**: Builds the rendered heading line with the prompt marker prefix.

**Data flow**: It clones the spans from `self.copy.heading`, prepends a raw `"> "` span, wraps the result in a `Line<'static>`, and returns it.

**Call relations**: This helper is used by `render_ref` when the prompt is in structured-content mode rather than markdown mode.

*Call graph*: called by 1 (render_ref); 2 external calls (from, vec!).


##### `ModelMigrationScreen::render_content`  (lines 301–303)

```
fn render_content(&self, column: &mut ColumnRenderable)
```

**Purpose**: Renders the structured body lines stored in `copy.content` into the column layout.

**Data flow**: It takes a mutable `ColumnRenderable` and forwards `self.copy.content` to `render_lines`. It returns nothing and mutates only the passed column.

**Call relations**: This is a thin wrapper used by `render_ref` to keep the structured rendering path readable.

*Call graph*: calls 1 internal fn (render_lines); called by 1 (render_ref).


##### `ModelMigrationScreen::render_lines`  (lines 305–315)

```
fn render_lines(&self, lines: &[Line<'static>], column: &mut ColumnRenderable)
```

**Purpose**: Pushes each provided line into the column as a wrapped paragraph with a left inset.

**Data flow**: Inputs are a slice of `Line<'static>` and a mutable `ColumnRenderable`. For each line it clones the line into a `Paragraph`, enables wrapping with `trim: false`, applies `Insets::tlbr(0, 2, 0, 0)`, and pushes the widget into the column.

**Call relations**: This helper is called by `render_content` and encapsulates the common paragraph styling for structured prompt text.

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

**Purpose**: Renders markdown prompt content at the current width, preserving wrapped output inside the column layout.

**Data flow**: It takes the markdown string, current `area_width`, and mutable column. It computes a content width by subtracting a horizontal inset of 2, converts that to an optional wrap width, calls `render_markdown_text_with_width`, then pushes each rendered line as a wrapped inset `Paragraph` into the column.

**Call relations**: This path is selected by `render_ref` when `copy.markdown` is present, allowing richer migration copy than the structured heading/content format.

*Call graph*: calls 3 internal fn (render_markdown_text_with_width, tlbr, push); called by 1 (render_ref); 1 external calls (new).


##### `ModelMigrationScreen::render_menu`  (lines 341–375)

```
fn render_menu(&self, column: &mut ColumnRenderable)
```

**Purpose**: Appends the opt-out menu, numbered options, and navigation hint footer to the column.

**Data flow**: It mutates the provided `ColumnRenderable` by pushing blank lines, an explanatory paragraph, one `selection_option_row` per option from `MigrationMenuOption::all()`, and a final inset `Line` containing key hints for Up, Down, and Enter. It reads `self.highlighted_option` to mark the active row.

**Call relations**: This helper is called by `render_ref` only when `copy.can_opt_out` is true, and it depends on `MigrationMenuOption::all` and `MigrationMenuOption::label` for stable menu contents.

*Call graph*: calls 4 internal fn (all, tlbr, push, selection_option_row); called by 1 (render_ref); 3 external calls (from, new, vec!).


##### `AltScreenGuard::enter`  (lines 386–389)

```
fn enter(tui: &'a mut Tui) -> Self
```

**Purpose**: Switches the TUI into the terminal alternate screen and returns a guard that will restore the normal screen on drop.

**Data flow**: It takes `&mut Tui`, calls `tui.enter_alt_screen()` while ignoring any error, stores the mutable reference in `AltScreenGuard`, and returns the guard.

**Call relations**: This guard constructor is used by `run_model_migration_prompt` so the prompt renders off the normal scrollback and cleanup is automatic.

*Call graph*: called by 2 (run_model_migration_prompt, run_session_picker_with_loader); 1 external calls (enter_alt_screen).


##### `AltScreenGuard::drop`  (lines 393–395)

```
fn drop(&mut self)
```

**Purpose**: Leaves the alternate screen when the guard goes out of scope.

**Data flow**: On drop it calls `self.tui.leave_alt_screen()` and ignores any error. It mutates terminal state but returns no value.

**Call relations**: This destructor pairs with `AltScreenGuard::enter`; `run_model_migration_prompt` relies on it for cleanup regardless of how the prompt exits.

*Call graph*: 1 external calls (leave_alt_screen).


##### `is_ctrl_exit_combo`  (lines 398–401)

```
fn is_ctrl_exit_combo(key_event: KeyEvent) -> bool
```

**Purpose**: Recognizes Ctrl-C and Ctrl-D as explicit exit gestures for the migration prompt.

**Data flow**: It takes a `KeyEvent`, checks whether `CONTROL` is present in the modifiers and whether the code is `Char('c')` or `Char('d')`, and returns a boolean.

**Call relations**: This predicate is called by `ModelMigrationScreen::handle_key` before any accept/reject logic so control-key exits are handled distinctly.

*Call graph*: called by 1 (handle_key); 1 external calls (matches!).


##### `fill_migration_markdown`  (lines 403–407)

```
fn fill_migration_markdown(template: &str, current_model: &str, target_model: &str) -> String
```

**Purpose**: Substitutes model placeholders inside markdown migration templates.

**Data flow**: It takes the template plus `current_model` and `target_model`, performs chained string replacements for `{model_from}` and `{model_to}`, and returns the filled `String`.

**Call relations**: This helper is used only by `migration_copy_for_models` when markdown-based copy is supplied.

*Call graph*: called by 1 (migration_copy_for_models).


##### `tests::prompt_snapshot`  (lines 423–454)

```
fn prompt_snapshot()
```

**Purpose**: Captures a snapshot of the opt-out migration prompt with explicit migration copy text.

**Data flow**: The test builds a VT100-backed terminal, constructs screen copy via `migration_copy_for_models`, renders a `ModelMigrationScreen`, flushes the terminal, and snapshots the backend contents.

**Call relations**: It exercises the structured rendering path, menu rendering, and overall widget layout.

*Call graph*: calls 5 internal fn (with_options, new, migration_copy_for_models, new, test_dummy); 2 external calls (new, assert_snapshot!).


##### `tests::prompt_snapshot_gpt5_family`  (lines 457–481)

```
fn prompt_snapshot_gpt5_family()
```

**Purpose**: Snapshots the non-opt-out prompt variant for a generic GPT-5 family migration with a docs link.

**Data flow**: It creates a terminal, builds copy without custom migration text but with a link and description, renders the screen, flushes, and snapshots the output.

**Call relations**: This test covers the fallback copy-generation branch and the no-menu rendering path.

*Call graph*: calls 5 internal fn (with_options, new, migration_copy_for_models, new, test_dummy); 2 external calls (new, assert_snapshot!).


##### `tests::prompt_snapshot_gpt5_codex`  (lines 484–508)

```
fn prompt_snapshot_gpt5_codex()
```

**Purpose**: Snapshots the prompt for a codex-specific migration with generated recommendation text and a docs link.

**Data flow**: It follows the same render-and-snapshot flow as the other snapshot tests using different model names and description text.

**Call relations**: It validates that `migration_copy_for_models` and `render_ref` produce stable output for another realistic migration scenario.

*Call graph*: calls 5 internal fn (with_options, new, migration_copy_for_models, new, test_dummy); 2 external calls (new, assert_snapshot!).


##### `tests::prompt_snapshot_gpt5_codex_mini`  (lines 511–535)

```
fn prompt_snapshot_gpt5_codex_mini()
```

**Purpose**: Snapshots the prompt for a codex-mini migration scenario.

**Data flow**: The test constructs copy for the mini model upgrade, renders the screen into a VT100 terminal, flushes, and snapshots the result.

**Call relations**: It provides another regression fixture for prompt wording and wrapping.

*Call graph*: calls 5 internal fn (with_options, new, migration_copy_for_models, new, test_dummy); 2 external calls (new, assert_snapshot!).


##### `tests::escape_key_accepts_prompt`  (lines 538–564)

```
fn escape_key_accepts_prompt()
```

**Purpose**: Verifies that pressing Escape on an opt-out prompt confirms the currently highlighted default option rather than producing an exit outcome.

**Data flow**: It creates a screen with `can_opt_out = true`, sends an `Esc` `KeyEvent` to `handle_key`, then asserts that the screen is done and the outcome is `Accepted`.

**Call relations**: It exercises `handle_key` delegating to `handle_menu_key`, then `confirm_selection`, with the default highlighted option.

*Call graph*: calls 3 internal fn (new, migration_copy_for_models, test_dummy); 2 external calls (new, assert!).


##### `tests::selecting_use_existing_model_rejects_upgrade`  (lines 567–596)

```
fn selecting_use_existing_model_rejects_upgrade()
```

**Purpose**: Checks that moving the highlight to the second menu option and pressing Enter yields a rejected migration outcome.

**Data flow**: The test creates an opt-out screen, sends `Down` then `Enter` key events through `handle_key`, and asserts `is_done()` plus `Rejected` outcome.

**Call relations**: It covers menu navigation via `highlight_option` and confirmation via `confirm_selection`.

*Call graph*: calls 3 internal fn (new, migration_copy_for_models, test_dummy); 2 external calls (new, assert!).


##### `tests::markdown_prompt_keeps_long_url_tail_visible_when_narrow`  (lines 599–626)

```
fn markdown_prompt_keeps_long_url_tail_visible_when_narrow()
```

**Purpose**: Ensures markdown rendering on narrow terminals still preserves the tail of a long URL after wrapping.

**Data flow**: It constructs a screen whose `markdown` is a long URL, renders it into a narrow VT100 terminal, converts the backend to a string, and asserts that the final `tail42` segment is present.

**Call relations**: This test specifically exercises `render_markdown_content` and the markdown renderer width calculation.

*Call graph*: calls 4 internal fn (with_options, new, new, test_dummy); 3 external calls (new, new, assert!).


### Session resume and application assembly
These files handle resuming prior sessions and assembling the main application and chat widget state that will drive the interactive UI.

### `tui/src/app.rs`

`orchestration` · `startup, main loop, shutdown`

This file is the core orchestration layer for the TUI. Its largest component is the `App` struct, which aggregates long-lived runtime state: configuration, telemetry, the `ChatWidget`, transcript cells, overlay state, file search, permission overrides, thread/event-channel bookkeeping, plugin and hook write serialization, and various UI flags. Around that state, the file defines helper enums and structs such as `AppExitInfo`, `ExitReason`, `AutoReviewMode`, `RuntimePermissionProfileOverride`, `SessionSummary`, and `ResumableThread`.

Several small pure helpers decode backend notifications and request errors. Examples include extracting receiver thread IDs from collaboration tool-call notifications, detecting "active turn not steerable" or turn-steer/interrupt race conditions from `TypedRequestError`, deriving resumability from rollout files, and selecting default approval decisions based on network or exec-policy amendment context.

The dominant control flow lives in `App::run`. Startup normalizes config overrides, bootstraps or resumes/forks an app-server session, optionally runs model migration prompting, initializes telemetry and the `ChatWidget`, resolves runtime model-provider status, creates the `App` state, and schedules startup work such as skill refreshes, rate-limit prefetch, and Windows sandbox warnings. It then enters a `tokio::select!` loop multiplexing app events, active-thread buffered events, terminal input, and app-server notifications. Shutdown clears terminal UI, computes resume hints from thread metadata and rollout files, and returns `AppExitInfo`.

Rendering is split so `handle_tui_event` performs pre-render maintenance, overlay routing, paste normalization, ambient pet image drawing, and external-editor launch requests, while `render_chat_widget_frame` performs the actual ratatui draw pass and cursor placement. The file also ensures terminal-title cleanup in `Drop`, making it the lifecycle owner for both startup and teardown side effects.

#### Function details

##### `collab_receiver_thread_ids`  (lines 251–269)

```
fn collab_receiver_thread_ids(notification: &ServerNotification) -> Option<&[String]>
```

**Purpose**: Extracts the `receiver_thread_ids` slice from collaboration agent tool-call notifications that carry it.

**Data flow**: Reads a borrowed `ServerNotification`, matches only `ItemStarted` and `ItemCompleted`, then further matches the embedded `ThreadItem::CollabAgentToolCall`. If present, it returns `Some(&[String])` borrowed from the notification; all other notification/item variants return `None`.

**Call relations**: This helper is used by higher-level app-server event handling to recognize which sub-agent threads are implicated by collaboration tool-call notifications. It performs only pattern matching and does not allocate or mutate state.


##### `sub_agent_activity_item`  (lines 271–283)

```
fn sub_agent_activity_item(notification: &ServerNotification) -> Option<&ThreadItem>
```

**Purpose**: Returns the embedded `ThreadItem` when a server notification represents started or completed sub-agent activity.

**Data flow**: Inspects a `ServerNotification`, accepts only `ItemStarted` and `ItemCompleted`, and returns a borrowed `&ThreadItem` if the item is `ThreadItem::SubAgentActivity`. Otherwise it returns `None`.

**Call relations**: This helper supports app-server event processing that wants to react specifically to sub-agent activity notifications without duplicating nested match logic.


##### `collab_receiver_is_not_found`  (lines 285–303)

```
fn collab_receiver_is_not_found(
    notification: &ServerNotification,
    receiver_thread_id: &str,
) -> bool
```

**Purpose**: Checks whether a completed collaboration tool-call notification reports a specific receiver thread as `NotFound`.

**Data flow**: Matches only `ServerNotification::ItemCompleted` containing `ThreadItem::CollabAgentToolCall`, looks up `receiver_thread_id` in `agents_states`, and returns `true` only if the stored status matches `CollabAgentStatus::NotFound`. All other cases return `false`.

**Call relations**: This helper is part of the app's defensive handling for collaboration races and stale thread references. It is consumed by event-processing code that needs to distinguish a missing receiver from other completion outcomes.


##### `default_exec_approval_decisions`  (lines 305–353)

```
fn default_exec_approval_decisions(
    network_approval_context: Option<&codex_app_server_protocol::NetworkApprovalContext>,
    proposed_execpolicy_amendment: Option<&codex_app_server_protocol::Exec
```

**Purpose**: Builds the default list of approval choices shown for command execution requests based on network context, proposed policy amendments, and additional-permission requests.

**Data flow**: Reads four optional inputs describing approval context. If network approval context exists, it starts with `Accept` and `AcceptForSession`, optionally adds `ApplyNetworkPolicyAmendment` for the first proposed allow-rule amendment, then appends `Cancel`. If additional permissions are requested, it returns only `Accept` and `Cancel`. Otherwise it starts with `Accept`, optionally adds `AcceptWithExecpolicyAmendment` cloned from the proposed exec-policy amendment, and finally appends `Cancel`.

**Call relations**: This helper is used when constructing approval UI state for command execution prompts. It encapsulates the branching policy so callers can present a context-appropriate decision list without duplicating amendment-selection logic.

*Call graph*: 1 external calls (vec!).


##### `auto_review_mode`  (lines 366–374)

```
fn auto_review_mode() -> AutoReviewMode
```

**Purpose**: Constructs the canonical auto-review permission/reviewer mode used when the TUI experiment is enabled.

**Data flow**: Creates and returns an `AutoReviewMode` with `approval_policy` set to `AskForApproval::OnRequest`, `approvals_reviewer` set to `ApprovalsReviewer::AutoReview`, and `active_permission_profile` initialized from the built-in workspace profile constant via `ActivePermissionProfile::new`.

**Call relations**: This helper is used by runtime configuration synchronization code to switch the current permissions state into the matching auto-review defaults when the experiment is enabled.

*Call graph*: calls 1 internal fn (new).


##### `AutoReviewMode::permission_profile`  (lines 378–381)

```
fn permission_profile(&self) -> PermissionProfile
```

**Purpose**: Resolves the built-in concrete `PermissionProfile` corresponding to the auto-review mode's active permission profile.

**Data flow**: Borrows `self.active_permission_profile`, passes it to `builtin_permission_profile_for_active_permission_profile`, unwraps the expected built-in result, and returns the resulting `PermissionProfile`.

**Call relations**: This test-only helper supports assertions around auto-review behavior by converting the abstract active-profile selection into the concrete permission profile the app would actually use.

*Call graph*: 1 external calls (builtin_permission_profile_for_active_permission_profile).


##### `managed_filesystem_sandbox_is_restricted`  (lines 385–390)

```
fn managed_filesystem_sandbox_is_restricted(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: On Windows builds, reports whether the permission profile's filesystem sandbox kind is the restricted managed sandbox.

**Data flow**: Reads `permission_profile.file_system_sandbox_policy().kind` and returns whether it matches `FileSystemSandboxKind::Restricted`.

**Call relations**: This helper is called during startup from `run` to decide whether to launch the Windows world-writable directory scan. It isolates the platform-specific sandbox-kind check from the larger startup flow.

*Call graph*: called by 1 (run); 1 external calls (matches!).


##### `AppExitInfo::fatal`  (lines 408–416)

```
fn fatal(message: impl Into<String>) -> Self
```

**Purpose**: Creates a fatal-exit summary with default token usage and no resumable-thread metadata.

**Data flow**: Consumes any `Into<String>` message, converts it, and returns an `AppExitInfo` whose `token_usage` is `TokenUsage::default()`, `thread_id`, `resume_hint`, and `update_action` are `None`, and `exit_reason` is `ExitReason::Fatal(message)`.

**Call relations**: This constructor is used by higher-level entrypoint code such as `run_interactive_tui` when startup fails before a normal session can produce richer exit metadata.

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

**Purpose**: Builds an optional summary containing token-usage text and a resume hint for display after a session ends.

**Data flow**: Takes `TokenUsage`, optional thread id/name, and optional rollout path. It derives `usage_line` only when token usage is nonzero, derives `resume_hint` via `resume_hint_for_resumable_thread`, and returns `None` if both are absent; otherwise it returns `Some(SessionSummary { usage_line, resume_hint })`.

**Call relations**: This helper packages two independent post-session signals into one optional summary object. It delegates resumability logic to `resume_hint_for_resumable_thread` and is used where the app needs concise exit/reporting metadata.

*Call graph*: calls 2 internal fn (is_zero, resume_hint_for_resumable_thread).


##### `resumable_thread`  (lines 456–467)

```
fn resumable_thread(
    thread_id: Option<ThreadId>,
    thread_name: Option<String>,
    rollout_path: Option<&Path>,
) -> Option<ResumableThread>
```

**Purpose**: Determines whether a thread should be considered resumable based on the presence of both a thread id and a nonempty rollout file.

**Data flow**: Consumes optional `thread_id`, optional `thread_name`, and optional `rollout_path`. It early-returns `None` if either the thread id or rollout path is missing; otherwise it calls `rollout_path_is_resumable` and, if true, returns `Some(ResumableThread { thread_id, thread_name })`.

**Call relations**: This helper is the structural gate used by `resume_hint_for_resumable_thread`. It separates file-based resumability checks from the final CLI hint formatting.

*Call graph*: calls 1 internal fn (rollout_path_is_resumable); called by 1 (resume_hint_for_resumable_thread).


##### `resume_hint_for_resumable_thread`  (lines 469–476)

```
fn resume_hint_for_resumable_thread(
    thread_id: Option<ThreadId>,
    thread_name: Option<String>,
    rollout_path: Option<&Path>,
) -> Option<String>
```

**Purpose**: Produces the CLI resume hint string for a thread only when the thread has resumable rollout state.

**Data flow**: Accepts optional thread id/name and rollout path, calls `resumable_thread`, and if that returns a thread, passes its optional name and id into `codex_utils_cli::resume_hint`. It returns `None` when resumability prerequisites are not met.

**Call relations**: This helper is used both during normal app shutdown in `run` and by `session_summary`. It bridges low-level resumability checks to the user-facing command hint string.

*Call graph*: calls 1 internal fn (resumable_thread); called by 2 (run, session_summary); 1 external calls (resume_hint).


##### `rollout_path_is_resumable`  (lines 478–480)

```
fn rollout_path_is_resumable(rollout_path: &Path) -> bool
```

**Purpose**: Checks whether a rollout path points to an existing nonempty file, which is the app's criterion for resumability.

**Data flow**: Calls `std::fs::metadata` on the provided path and returns `true` only if metadata lookup succeeds, the path is a file, and its length is greater than zero.

**Call relations**: This helper is called only by `resumable_thread`. It isolates the filesystem predicate so resumability logic remains explicit and testable.

*Call graph*: called by 1 (resumable_thread); 1 external calls (metadata).


##### `errors_for_cwd`  (lines 482–489)

```
fn errors_for_cwd(cwd: &Path, response: &SkillsListResponse) -> Vec<SkillErrorInfo>
```

**Purpose**: Extracts the skill-loading errors associated with a specific working directory from a `SkillsListResponse`.

**Data flow**: Iterates over `response.data`, finds the first entry whose `cwd` matches the provided path, clones its `errors` vector, and returns it. If no matching entry exists, it returns an empty vector.

**Call relations**: This helper is used by skill-refresh handling to pull out only the errors relevant to the current workspace rather than all reported skill-load failures.


##### `RuntimePermissionProfileOverride::from_config`  (lines 597–603)

```
fn from_config(config: &Config) -> Self
```

**Purpose**: Snapshots the permission-related runtime override state from the current `Config`.

**Data flow**: Borrows `Config`, clones its concrete `permission_profile`, copies its optional `active_permission_profile`, clones the optional network proxy spec, and returns a new `RuntimePermissionProfileOverride` containing those three fields.

**Call relations**: This helper is called from several configuration-update paths such as permission-profile selection and feature-flag synchronization. It provides a stable runtime snapshot so later UI or request logic can compare or reapply permission overrides.

*Call graph*: called by 4 (apply_permission_profile_selection, sync_auto_review_runtime_state_from_effective_config, update_feature_flags, handle_event).


##### `active_turn_not_steerable_turn_error`  (lines 606–616)

```
fn active_turn_not_steerable_turn_error(error: &TypedRequestError) -> Option<AppServerTurnError>
```

**Purpose**: Parses a server-side typed request error and returns the embedded `TurnError` only when it specifically indicates `ActiveTurnNotSteerable`.

**Data flow**: Matches `TypedRequestError::Server`, clones the optional JSON `source.data`, deserializes it into `AppServerTurnError` with `serde_json::from_value`, and returns `Some(turn_error)` only if `turn_error.codex_error_info` matches `AppServerCodexErrorInfo::ActiveTurnNotSteerable`. Otherwise it returns `None`.

**Call relations**: This helper is used by turn-steering request handling to distinguish a specific recoverable backend condition from generic request failures.

*Call graph*: 2 external calls (matches!, from_value).


##### `resolve_runtime_model_provider_base_url`  (lines 618–627)

```
async fn resolve_runtime_model_provider_base_url(provider: &ModelProviderInfo) -> Option<String>
```

**Purpose**: Asynchronously asks the configured model provider for its runtime base URL and suppresses failures into a warning plus `None`.

**Data flow**: Clones the `ModelProviderInfo`, constructs a provider with `create_model_provider(..., None)`, awaits `runtime_base_url()`, and returns `Some(base_url)` on success. On error it logs a warning and returns `None`.

**Call relations**: This helper is called during `run` startup so the chat widget can display provider status information without making startup fail if the provider cannot resolve its runtime URL.

*Call graph*: called by 1 (run); 4 external calls (create_model_provider, clone, runtime_base_url, warn!).


##### `spawn_startup_thread_start`  (lines 629–648)

```
fn spawn_startup_thread_start(
    app_server: &AppServerSession,
    config: Config,
    app_event_tx: AppEventSender,
)
```

**Purpose**: Launches an asynchronous startup task that starts a fresh thread through the app server and reports the result back into the app event channel.

**Data flow**: Reads request handle, thread-parameter mode, and optional remote cwd override from `AppServerSession`, clones the config and event sender into an async task, calls `start_thread_with_request_handle`, maps any error into a formatted string, and sends `AppEvent::StartupThreadStarted { result }` back to the app.

**Call relations**: This helper is invoked from `run` when starting a fresh session. It decouples thread creation from initial UI rendering so startup can proceed without blocking on the backend thread-start request.

*Call graph*: calls 5 internal fn (send, remote_cwd_override, request_handle, thread_params_mode, start_thread_with_request_handle); called by 1 (run); 1 external calls (spawn).


##### `active_turn_steer_race`  (lines 656–679)

```
fn active_turn_steer_race(error: &TypedRequestError) -> Option<ActiveTurnSteerRace>
```

**Purpose**: Recognizes app-server `turn/steer` race errors and extracts either a missing-active-turn condition or the server's actual active turn id.

**Data flow**: Matches only `TypedRequestError::Server` with method `turn/steer`. If the message is exactly `no active turn to steer`, it returns `Some(ActiveTurnSteerRace::Missing)`. Otherwise it parses the expected/actual mismatch message format and returns `ExpectedTurnMismatch { actual_turn_id }` when parsing succeeds; all other cases return `None`.

**Call relations**: This helper supports retry/resynchronization logic around steering requests by turning backend error strings into structured race categories.


##### `session_start_error`  (lines 681–692)

```
fn session_start_error(
    action: &str,
    target_session: &SessionTarget,
    err: color_eyre::eyre::Report,
) -> color_eyre::eyre::Report
```

**Purpose**: Wraps resume/fork startup failures in a user-facing error message, with special handling for archived-session guidance.

**Data flow**: Accepts an action label, a `SessionTarget`, and an error report. It first asks `archived_session_guidance` for a cleaner message; if present, it returns that as a new eyre error. Otherwise it gets the target's display label and returns a formatted eyre report describing the failed action and original error.

**Call relations**: This helper is used in `run` when `resume_thread` or `fork_thread` fails. It centralizes the user-facing wording and delegates archived-session special-casing to `archived_session_guidance`.

*Call graph*: calls 2 internal fn (archived_session_guidance, display_label); 1 external calls (eyre!).


##### `archived_session_guidance`  (lines 694–704)

```
fn archived_session_guidance(err: &color_eyre::eyre::Report) -> Option<String>
```

**Purpose**: Extracts a concise archived-session remediation message from a larger error report string when that specific backend guidance is present.

**Data flow**: Converts the report to a string, finds the substring beginning at `session `, checks whether it contains the archived-session guidance text, strips any trailing ` (code ...)` suffix if present, and returns the cleaned message as `Some(String)`. If the expected pattern is absent, it returns `None`.

**Call relations**: This helper is called only by `session_start_error` to improve the UX for archived-session failures by surfacing the actionable unarchive command instead of a generic wrapped error.

*Call graph*: called by 1 (session_start_error); 2 external calls (find, to_string).


##### `active_turn_interrupt_race`  (lines 706–723)

```
fn active_turn_interrupt_race(error: &TypedRequestError) -> Option<String>
```

**Purpose**: Parses `turn/interrupt` server errors to recover the backend's actual active turn id when the client's cached id is stale.

**Data flow**: Matches only `TypedRequestError::Server` with method `turn/interrupt`, then parses the message format `expected active turn id ... but found ...` and returns the trailing actual turn id as `Some(String)`. Nonmatching methods or unparsable messages return `None`.

**Call relations**: This helper is used by interrupt-handling code to detect and recover from active-turn races similarly to `active_turn_steer_race`, but for the interrupt endpoint.


##### `App::chatwidget_init_for_forked_or_resumed_thread`  (lines 726–756)

```
fn chatwidget_init_for_forked_or_resumed_thread(
        &self,
        tui: &mut tui::Tui,
        cfg: crate::legacy_core::config::Config,
        initial_user_message: Option<crate::chatwidget::Use
```

**Purpose**: Builds a `ChatWidgetInit` struct for creating a chat widget attached to an already existing forked or resumed thread.

**Data flow**: Reads current app state including frame requester, event sender, optional workspace command runner, account/auth flags, model catalog, feedback handle, status display, runtime provider URL, current plan type, current model, warning flags, and telemetry. It combines those with the supplied config and optional initial user message into a new `ChatWidgetInit` value and returns it.

**Call relations**: This helper is used when the app needs to recreate or initialize a chat widget for a non-fresh thread while preserving shared runtime state from the existing `App`.

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

**Purpose**: Starts the TUI application, initializes backend/session/UI state, runs the main asynchronous event loop, and returns structured exit information on shutdown.

**Data flow**: Consumes startup inputs including `tui`, `AppServerSession`, `Config`, overrides, initial prompt/images, session selection, telemetry dependencies, and environment handles. It creates the app event channel, emits config warnings, bootstraps the app server if needed, optionally runs model migration prompting, initializes telemetry and model catalog, resolves runtime provider status, creates or resumes/forks the initial thread and `ChatWidget`, constructs the full `App` state, schedules startup tasks, and enters a `tokio::select!` loop over app events, active-thread events, terminal events, and app-server notifications. On exit it shuts down the app server, clears terminal artifacts, computes final thread/resume metadata, and returns `AppExitInfo` or propagates an error.

**Call relations**: This is the file's central orchestrator and is called by the outer TUI entrypoint. It delegates extensively to startup helpers, app-server session methods, chat-widget constructors, event handlers, and rendering helpers, then coordinates their outputs inside the main loop until an `AppRunControl::Exit` is produced.

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

**Purpose**: Processes one terminal/UI event, including draw ticks, resize handling, key input, paste normalization, overlay routing, and image/editor side effects.

**Data flow**: Mutably reads and updates `self`, `tui`, and `app_server` based on the incoming `TuiEvent`. For draw/resize it performs pre-render maintenance, optional transcript rebuild after backtrack, pending notification/timer processing, frame rendering, ambient pet image drawing, pet-picker preview drawing/clearing, and external-editor launch signaling. For key events it delegates to key handling; for paste events it normalizes `\r` to `\n` before passing text to the chat widget. It returns `AppRunControl::Continue` unless delegated logic requests exit.

**Call relations**: This method is called from the main `run` loop whenever a terminal event arrives. It sits between raw TUI input and lower-level widget/rendering methods, delegating to overlay handling, key handling, `render_chat_widget_frame`, and image/editor helpers as needed.

*Call graph*: calls 3 internal fn (render_chat_widget_frame, send, pre_draw_tick); 14 external calls (new, draw_ambient_pet_image, draw_pet_picker_preview_image, frame_requester, matches!, ambient_pet_draw, ambient_pet_image_enabled, external_editor_state, handle_paste, handle_paste_burst_tick (+4 more)).


##### `App::show_shutdown_feedback`  (lines 1329–1336)

```
fn show_shutdown_feedback(&mut self, tui: &mut tui::Tui) -> Result<()>
```

**Purpose**: Renders a final shutdown-in-progress UI state before the app exits.

**Data flow**: Mutates app and terminal state by disabling ambient pet rendering, telling the chat widget to show shutdown feedback, running pre-render maintenance, ticking widget timers, and drawing one final frame. It returns `Result<()>` from the rendering path.

**Call relations**: This helper is used during shutdown flows that want visible feedback before backend teardown completes. It delegates the actual frame draw to `render_chat_widget_frame` after updating widget state.

*Call graph*: calls 3 internal fn (render_chat_widget_frame, pre_draw_tick, show_shutdown_in_progress).


##### `App::render_chat_widget_frame`  (lines 1338–1351)

```
fn render_chat_widget_frame(&mut self, tui: &mut tui::Tui) -> Result<Rect>
```

**Purpose**: Performs the ratatui draw pass for the chat widget and sets the terminal cursor position/style when the widget exposes one.

**Data flow**: Queries terminal width to compute the widget's desired height, initializes a default `Rect`, then calls `tui.draw_with_resize_reflow` with a closure that records the frame area, renders the chat widget into the frame buffer, and applies cursor style/position if available. It returns the rendered area rectangle.

**Call relations**: This rendering primitive is called from both `handle_tui_event` and `show_shutdown_feedback`. It isolates the actual frame drawing from the surrounding event-handling logic so callers can perform pre/post-render work separately.

*Call graph*: called by 2 (handle_tui_event, show_shutdown_feedback); 3 external calls (default, draw_with_resize_reflow, desired_height).


##### `App::drop`  (lines 1355–1359)

```
fn drop(&mut self)
```

**Purpose**: Cleans up managed terminal title state when the `App` is dropped.

**Data flow**: On drop, it calls `self.chat_widget.clear_managed_terminal_title()`. If that fails, it logs a debug message; otherwise it performs no further action.

**Call relations**: This destructor runs automatically at teardown regardless of the exit path. It provides a last-resort cleanup for terminal title side effects that may outlive the visible UI.

*Call graph*: 2 external calls (debug!, clear_managed_terminal_title).


### `tui/src/resume_picker.rs`

`domain_logic` · `interactive session picking`

This is the core interactive session-picker implementation. It defines the picker’s domain types (`SessionTarget`, `SessionSelection`, `SessionPickerAction`, `SessionFilterMode`, `SessionListDensity`, `ToolbarControl`, `Row`, pagination/search/loading enums, preview/transcript state, and footer metadata helpers), then wires them into an async event loop that runs inside the terminal alternate screen. Startup helpers build `SessionPickerRunOptions` from `Config` and `AppServerSession`, choosing cwd and provider filters differently for local versus remote workspaces, deriving keymaps, and spawning a background loader task that serializes page, preview, and transcript requests over an unbounded channel.

`PickerState` is the center of the file. It tracks loaded rows, deduplication keys, filtered rows, selection and scroll position, pending page-down targets, frozen footer percentages during pagination, typed search state with request/search tokens to discard stale responses, toolbar focus, density, launch context, inline errors, expanded preview state, transcript cache, and overlay state. Key handling prioritizes plain text as search input, supports configurable list navigation, toggles sort/filter via toolbar focus, lazily loads more pages near the bottom, resolves missing thread IDs from rollout files on accept, and gates most input while a transcript overlay is loading except `Ctrl+C` exit.

Rendering is equally substantial: the file draws header/search/footer chrome, computes responsive toolbar and footer hint layouts, renders comfortable or dense session rows with zebra/selection backgrounds, packs metadata fields into one or more footer lines, shows expandable transcript previews with markdown-aware assistant formatting, and computes scroll percentages from rendered row heights rather than raw item counts. The large test module exercises behavior, snapshots, pagination/search edge cases, remote filtering semantics, transcript loading, density persistence, and layout responsiveness.

#### Function details

##### `SessionTarget::display_label`  (lines 88–93)

```
fn display_label(&self) -> String
```

**Purpose**: Builds a human-readable label for a selected session target, preferring its filesystem path when available.

**Data flow**: Reads `self.path` and `self.thread_id`; if `path` is `Some`, converts it to a display string, otherwise formats `thread {thread_id}` and returns that `String`.

**Call relations**: Callers use it when presenting resume/fork targets in later flows, so path-backed sessions display as paths while pathless app-server threads still have a stable fallback label.

*Call graph*: called by 2 (resume_target_session, session_start_error).


##### `SessionPickerAction::title`  (lines 117–122)

```
fn title(self) -> &'static str
```

**Purpose**: Returns the header title text for the picker based on whether the user is resuming or forking.

**Data flow**: Matches `self` and returns one of two static strings.

**Call relations**: Rendering code uses this to label the picker header consistently with the action mode.


##### `SessionPickerAction::action_label`  (lines 124–129)

```
fn action_label(self) -> &'static str
```

**Purpose**: Returns the short verb used in footer hints and action prompts for the current picker mode.

**Data flow**: Matches `self` and returns either `"resume"` or `"fork"`.

**Call relations**: Footer hint generation uses this shorter label where the full title would be too verbose.


##### `SessionPickerAction::selection`  (lines 131–137)

```
fn selection(self, path: Option<PathBuf>, thread_id: ThreadId) -> SessionSelection
```

**Purpose**: Converts a chosen path/thread pair into the correct `SessionSelection` variant for the current action.

**Data flow**: Takes an optional `PathBuf` and `ThreadId`, constructs a `SessionTarget`, then wraps it in `SessionSelection::Resume` or `SessionSelection::Fork` depending on `self`.

**Call relations**: The accept-key path in `PickerState::handle_key` delegates here after it has resolved the selected row’s thread ID.

*Call graph*: called by 1 (handle_key); 2 external calls (Fork, Resume).


##### `SessionFilterMode::from_show_all`  (lines 169–175)

```
fn from_show_all(show_all: bool, filter_cwd: Option<&Path>) -> Self
```

**Purpose**: Derives the initial filter mode from the caller’s `show_all` flag and whether a cwd filter candidate exists.

**Data flow**: Consumes `show_all` and `filter_cwd`; returns `All` if showing all sessions or no cwd is available, otherwise returns `Cwd`.

**Call relations**: Used during `PickerState::new` so the picker starts in a mode that matches launch context and available cwd information.

*Call graph*: called by 1 (new).


##### `SessionFilterMode::toggle`  (lines 177–183)

```
fn toggle(self, filter_cwd: Option<&Path>) -> Self
```

**Purpose**: Switches between cwd-scoped and all-session filtering, but only enables cwd mode when a cwd candidate exists.

**Data flow**: Reads the current mode and optional cwd candidate; flips `Cwd -> All`, flips `All -> Cwd` only if `filter_cwd.is_some()`, otherwise leaves `All` unchanged.

**Call relations**: Called from `PickerState::toggle_filter_mode` when the toolbar’s filter control is changed.

*Call graph*: called by 1 (toggle_filter_mode).


##### `ToolbarControl::previous`  (lines 193–198)

```
fn previous(self) -> Self
```

**Purpose**: Moves toolbar focus to the previous control in the two-item filter/sort cycle.

**Data flow**: Matches `self` and returns the opposite enum variant.

**Call relations**: Used by `PickerState::focus_previous_toolbar_control` in response to reverse-tab navigation.

*Call graph*: called by 1 (focus_previous_toolbar_control).


##### `ToolbarControl::next`  (lines 200–205)

```
fn next(self) -> Self
```

**Purpose**: Moves toolbar focus to the next control in the two-item filter/sort cycle.

**Data flow**: Matches `self` and returns the opposite enum variant.

**Call relations**: Used by `PickerState::focus_next_toolbar_control` when the user presses Tab.

*Call graph*: called by 1 (focus_next_toolbar_control).


##### `SessionListDensity::toggle`  (lines 215–220)

```
fn toggle(self) -> Self
```

**Purpose**: Switches the list between comfortable multi-line cards and dense single-line rows.

**Data flow**: Matches `self` and returns the opposite density variant.

**Call relations**: Invoked by `PickerState::toggle_density` after the user presses the density shortcut.

*Call graph*: called by 1 (toggle_density).


##### `SessionListDensity::from`  (lines 224–229)

```
fn from(mode: SessionPickerViewMode) -> Self
```

**Purpose**: Maps persisted config view mode into the picker’s internal density enum.

**Data flow**: Consumes a `SessionPickerViewMode` and returns the corresponding `SessionListDensity` variant.

**Call relations**: Startup helpers use it when building picker options from config.

*Call graph*: called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context).


##### `SessionPickerViewMode::from`  (lines 233–238)

```
fn from(density: SessionListDensity) -> Self
```

**Purpose**: Maps the picker’s internal density enum back into the config-facing persisted view mode.

**Data flow**: Consumes a `SessionListDensity` and returns the matching `SessionPickerViewMode`.

**Call relations**: Used when persisting a density toggle back to `config.toml`.


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

**Purpose**: Starts the resume picker in startup context using an app-server-backed loader.

**Data flow**: Accepts TUI/config/show-all/include-non-interactive/app-server inputs, forwards them with `SessionPickerLaunchContext::Startup`, awaits the result, and returns a `SessionSelection`.

**Call relations**: This is the normal startup entry used by the main TUI app; it is a thin wrapper over the shared launch-context helper.

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

**Purpose**: Starts the resume picker from inside an already-running session, changing cancel/exit semantics.

**Data flow**: Passes its arguments through to the shared launch-context helper with `ExistingSession` and returns the resulting `SessionSelection`.

**Call relations**: Invoked from in-session event handling so the picker can be reopened without startup-specific wording.

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

**Purpose**: Builds picker options for resume mode, including workspace-aware filters, keymaps, persistence, and background loading channels.

**Data flow**: Reads config cwd, model provider, keymap, and view mode; queries the app server for remote-workspace behavior and remote cwd override; computes backend and local cwd filters plus provider filter; creates background channels; packages everything into `SessionPickerRunOptions`; spawns the app-server loader; and awaits `run_session_picker_with_loader`.

**Call relations**: Both resume entrypoints delegate here so only launch context differs while all setup logic stays shared.

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

**Purpose**: Builds and runs the same picker machinery in fork mode instead of resume mode.

**Data flow**: Performs the same setup as the resume helper—channels, workspace-aware filters, keymaps, persistence, loader spawning—but sets `action` to `SessionPickerAction::Fork` and disables non-interactive sources for page loading.

**Call relations**: Used by the main app when the user wants to fork a previous session rather than resume it.

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

**Purpose**: Runs the picker event loop inside the alternate screen, multiplexing TUI events and background loader responses until a selection or exit occurs.

**Data flow**: Enters alt-screen via `AltScreenGuard`, constructs `PickerState`, copies option fields into it, starts the initial page load, then loops over fused TUI and background streams. Key events route to overlay handling or `handle_key`; paste updates search; draw/resize updates viewport and renders; background events mutate state asynchronously. It returns the chosen `SessionSelection`, or `StartFresh` if the streams end.

**Call relations**: This is the orchestration hub called by both resume and fork setup helpers; it delegates all state transitions to `PickerState` methods and all drawing to `draw_picker`.

*Call graph*: calls 2 internal fn (enter, new); called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context); 2 external calls (new, select!).


##### `raw_reasoning_visibility`  (lines 503–509)

```
fn raw_reasoning_visibility(config: &Config) -> RawReasoningVisibility
```

**Purpose**: Translates config into whether raw agent reasoning should be shown when loading full transcripts.

**Data flow**: Reads `config.show_raw_agent_reasoning` and returns `RawReasoningVisibility::Visible` or `Hidden`.

**Call relations**: Startup helpers pass this into the background transcript loader so transcript overlays honor the current config.

*Call graph*: called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context).


##### `local_picker_cwd_filter`  (lines 511–520)

```
fn local_picker_cwd_filter(
    cwd_filter: &Option<PathBuf>,
    uses_remote_workspace: bool,
) -> Option<PathBuf>
```

**Purpose**: Determines whether the picker should also apply a local post-filter by cwd after backend filtering.

**Data flow**: Takes the backend cwd filter and a `uses_remote_workspace` flag; returns `None` for remote workspaces and otherwise clones the cwd filter.

**Call relations**: Resume/fork setup uses this split so remote sessions rely on server-side cwd semantics without incorrectly filtering local paths client-side.

*Call graph*: called by 3 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context, remote_picker_sends_cwd_filter_without_local_post_filtering).


##### `picker_provider_filter`  (lines 522–528)

```
fn picker_provider_filter(config: &Config, uses_remote_workspace: bool) -> ProviderFilter
```

**Purpose**: Chooses whether thread listing should be restricted to the configured default model provider.

**Data flow**: Reads config and remote-workspace mode; returns `ProviderFilter::Any` for remote workspaces, otherwise `ProviderFilter::MatchDefault(config.model_provider_id.to_string())`.

**Call relations**: The startup helpers feed this into `PickerState` and page requests so local pickers stay scoped to the active provider while remote ones do not.

*Call graph*: called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context); 1 external calls (MatchDefault).


##### `picker_runtime_keymap`  (lines 530–533)

```
fn picker_runtime_keymap(config: &Config) -> Result<RuntimeKeymap>
```

**Purpose**: Builds the runtime keymap used by the picker and wraps parse failures with a user-facing error.

**Data flow**: Reads `config.tui_keymap`, calls `RuntimeKeymap::from_config`, and returns either the parsed keymap or an eyre error describing invalid configuration.

**Call relations**: Resume/fork setup calls this before entering the picker so key bindings are ready and validated.

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

**Purpose**: Computes the backend cwd filter sent to thread listing based on show-all mode and remote workspace behavior.

**Data flow**: Given config cwd, `show_all`, `uses_remote_workspace`, and optional remote override, returns `None` when showing all, the remote override path for remote workspaces, or the local config cwd otherwise.

**Call relations**: Used during picker setup and tested directly because it controls which sessions the backend returns.

*Call graph*: called by 3 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context, local_picker_thread_list_params_include_cwd_filter); 1 external calls (to_path_buf).


##### `spawn_app_server_page_loader`  (lines 550–605)

```
fn spawn_app_server_page_loader(
    app_server: AppServerSession,
    include_non_interactive: bool,
    raw_reasoning_visibility: RawReasoningVisibility,
    bg_tx: mpsc::UnboundedSender<BackgroundE
```

**Purpose**: Creates the background worker that serializes page, preview, and transcript requests against a single `AppServerSession` and forwards results back to the picker.

**Data flow**: Creates an unbounded request channel, spawns a Tokio task that loops over `PickerLoadRequest`s, dispatches each variant to `load_app_server_page`, `load_transcript_preview`, or `load_session_transcript`, wraps results in `BackgroundEvent`s, sends them on `bg_tx`, and shuts down the app server when the request stream ends. It returns an `Arc<dyn Fn(PickerLoadRequest)>` closure that enqueues requests.

**Call relations**: Resume/fork setup installs this loader into `PickerState`; the state machine later invokes it whenever it needs another page, an expanded preview, or a full transcript.

*Call graph*: calls 4 internal fn (shutdown, load_app_server_page, load_transcript_preview, load_session_transcript); called by 2 (run_fork_picker_with_app_server, run_resume_picker_with_launch_context); 4 external calls (new, send, spawn, warn!).


##### `sort_key_label`  (lines 608–613)

```
fn sort_key_label(sort_key: ThreadSortKey) -> &'static str
```

**Purpose**: Provides the human-readable label for the active thread sort key.

**Data flow**: Matches a `ThreadSortKey` and returns `"Created"` or `"Updated"`.

**Call relations**: Toolbar rendering uses it for both compact and expanded sort controls.


##### `AltScreenGuard::enter`  (lines 621–624)

```
fn enter(tui: &'a mut Tui) -> Self
```

**Purpose**: Enters the terminal alternate screen and returns an RAII guard that will restore the previous screen on drop.

**Data flow**: Takes `&mut Tui`, calls `enter_alt_screen`, stores the mutable reference in `AltScreenGuard`, and returns the guard.

**Call relations**: The main picker loop uses this at startup so cleanup is automatic even on early return.

*Call graph*: 1 external calls (enter_alt_screen).


##### `AltScreenGuard::drop`  (lines 628–630)

```
fn drop(&mut self)
```

**Purpose**: Leaves the terminal alternate screen when the guard goes out of scope.

**Data flow**: Uses the stored `&mut Tui` to call `leave_alt_screen`; ignores any error.

**Call relations**: This runs automatically when `run_session_picker_with_loader` exits, ensuring terminal restoration.

*Call graph*: 1 external calls (leave_alt_screen).


##### `LoadingState::is_pending`  (lines 728–730)

```
fn is_pending(&self) -> bool
```

**Purpose**: Reports whether a page load is currently in flight.

**Data flow**: Pattern-matches `self` and returns `true` for `LoadingState::Pending(_)`, `false` otherwise.

**Call relations**: Many picker-state methods consult this to avoid issuing overlapping page requests and to adjust footer/loading UI.

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

**Purpose**: Fetches one page of threads from the app server and converts it into picker rows plus pagination metadata.

**Data flow**: Accepts mutable app-server session, optional cursor string, optional cwd filter, provider filter, sort key, and source inclusion flag; builds `ThreadListParams`, awaits `thread_list`, converts transport errors into `std::io::Error`, counts scanned files from `response.data.len()`, maps threads through `row_from_app_server_thread`, wraps the next cursor in `PageCursor::AppServer`, and returns a `PickerPage`.

**Call relations**: The background loader task calls this for `PickerLoadRequest::Page` requests before sending a `BackgroundEvent::Page` back to the UI.

*Call graph*: calls 2 internal fn (thread_list, thread_list_params); called by 1 (spawn_app_server_page_loader).


##### `load_transcript_preview`  (lines 765–815)

```
async fn load_transcript_preview(
    app_server: &mut AppServerSession,
    thread_id: ThreadId,
) -> std::io::Result<Vec<TranscriptPreviewLine>>
```

**Purpose**: Loads a thread’s recent conversation and distills it into a small list of preview lines for expanded rows.

**Data flow**: Reads a full thread via `thread_read(..., include_turns = true)`, walks turn items, extracts user text inputs and assistant markdown text, normalizes assistant markdown with cwd-aware parsing, splits multiline content into trimmed non-empty lines, keeps speaker metadata, truncates to the last six lines, and returns `Vec<TranscriptPreviewLine>`.

**Call relations**: The background loader uses this for preview requests triggered when the user expands a row.

*Call graph*: calls 1 internal fn (thread_read); called by 1 (spawn_app_server_page_loader).


##### `SearchState::active_token`  (lines 818–823)

```
fn active_token(&self) -> Option<usize>
```

**Purpose**: Returns the active search token if the picker is currently auto-loading pages to satisfy a search.

**Data flow**: Matches `self`; returns `Some(token)` for `Active { token }` and `None` for `Idle`.

**Call relations**: Search continuation logic uses this to correlate page responses with the currently active search.

*Call graph*: called by 1 (is_active).


##### `SearchState::is_active`  (lines 825–827)

```
fn is_active(&self) -> bool
```

**Purpose**: Reports whether search-driven pagination is currently active.

**Data flow**: Calls `active_token` and returns whether it produced `Some(_)`.

**Call relations**: Empty-state rendering uses this to show `Searching…` while the picker is still paging for a query.

*Call graph*: calls 1 internal fn (active_token).


##### `Row::seen_key`  (lines 849–854)

```
fn seen_key(&self) -> Option<SeenRowKey>
```

**Purpose**: Computes the deduplication key for a picker row, preferring path identity and falling back to thread ID.

**Data flow**: If `self.path` exists, clones it into `SeenRowKey::Path`; otherwise maps `self.thread_id` into `SeenRowKey::Thread`; returns `None` only if both are absent.

**Call relations**: Pagination ingestion uses this to suppress duplicates across overlapping app-server pages.

*Call graph*: 1 external calls (Path).


##### `Row::display_preview`  (lines 856–858)

```
fn display_preview(&self) -> &str
```

**Purpose**: Chooses the row title shown in the list, preferring a thread name over the raw preview text.

**Data flow**: Returns `thread_name.as_deref()` when present, otherwise returns `&self.preview`.

**Call relations**: Both comfortable and dense row renderers call this so named sessions display their title consistently.


##### `Row::matches_query`  (lines 860–890)

```
fn matches_query(&self, query: &str) -> bool
```

**Purpose**: Checks whether a lowercased search query matches any searchable field on the row.

**Data flow**: Reads `preview`, optional `thread_name`, optional `thread_id`, optional `git_branch`, and optional `cwd`; lowercases/comparisons each candidate and returns `true` on the first substring match, otherwise `false`.

**Call relations**: Client-side filtering uses this after backend/provider/cwd filtering to implement typed search over already-loaded rows.


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

**Purpose**: Constructs a fresh picker state with empty rows, idle pagination/search, default toolbar focus, and default keymaps.

**Data flow**: Takes a `FrameRequester`, loader closure, provider filter, show-all flag, optional cwd filter, and action; initializes all state fields, derives initial `filter_mode` from `SessionFilterMode::from_show_all`, clones the cwd filter into `local_filter_cwd`, and seeds default runtime keymaps.

**Call relations**: The main picker loop and many tests create state through this constructor before mutating fields or starting loads.

*Call graph*: calls 2 internal fn (defaults, from_show_all); called by 68 (run_session_picker_with_loader, all_filter_can_switch_back_to_cwd_when_cwd_candidate_exists, cached_transcript_still_shows_loading_frame_before_opening_overlay, comfortable_zebra_lines_use_full_width_background, ctrl_c_exits_even_when_cancel_is_remapped_to_ctrl_c, ctrl_e_toggles_selected_session_expansion, ctrl_o_keeps_toggled_density_when_persistence_fails, ctrl_o_persists_density_preference, ctrl_o_toggles_density_without_typing_into_search, ctrl_t_on_row_without_thread_id_shows_inline_error (+15 more)); 4 external calls (new, new, new, new).


##### `PickerState::request_frame`  (lines 947–949)

```
fn request_frame(&self)
```

**Purpose**: Schedules a redraw of the picker.

**Data flow**: Uses the stored `FrameRequester` to call `schedule_frame`; returns unit.

**Call relations**: Nearly every state mutation path calls this so UI updates happen promptly after changes.

*Call graph*: calls 1 internal fn (schedule_frame); called by 13 (apply_filter, begin_transcript_loading, clear_query_preserving_selection, complete_pending_page_down, handle_background_event, handle_key, handle_overlay_event, load_more_if_needed, open_pending_transcript_if_ready, open_selected_transcript (+3 more)).


##### `PickerState::is_transcript_loading`  (lines 951–953)

```
fn is_transcript_loading(&self) -> bool
```

**Purpose**: Reports whether the picker is currently waiting to open a transcript overlay.

**Data flow**: Returns whether `pending_transcript_open` is `Some(_)`.

**Call relations**: Input handling, paste handling, footer hints, and drawing use this to switch into transcript-loading behavior.

*Call graph*: called by 3 (handle_key, handle_paste, footer_hint_lines).


##### `PickerState::note_transcript_loading_frame_drawn`  (lines 955–962)

```
fn note_transcript_loading_frame_drawn(&mut self) -> bool
```

**Purpose**: Marks that at least one loading frame has been rendered while a transcript is pending.

**Data flow**: If `pending_transcript_open` is set, flips `transcript_loading_frame_shown` to `true` and returns `true`; otherwise returns `false`.

**Call relations**: The draw path calls this so cached or freshly loaded transcripts still show a loading overlay for one frame before opening.


##### `PickerState::open_pending_transcript_if_ready`  (lines 964–982)

```
fn open_pending_transcript_if_ready(&mut self)
```

**Purpose**: Opens the transcript overlay once a pending transcript has loaded and a loading frame has already been shown.

**Data flow**: Checks `transcript_loading_frame_shown`, `pending_transcript_open`, and `transcript_cells`; if the pending thread has `SessionTranscriptState::Loaded(cells)`, clones the cells into `Overlay::new_transcript`, clears pending/loading flags, stores the overlay, and requests a frame.

**Call relations**: Called after draws and after transcript background events so overlay opening is deferred until the UI has visibly entered loading state.

*Call graph*: calls 2 internal fn (new_transcript, request_frame); called by 1 (handle_background_event); 1 external calls (clone).


##### `PickerState::begin_transcript_loading`  (lines 984–988)

```
fn begin_transcript_loading(&mut self, thread_id: ThreadId)
```

**Purpose**: Starts the UI-side loading phase for a transcript overlay.

**Data flow**: Stores the target `thread_id` in `pending_transcript_open`, resets `transcript_loading_frame_shown` to `false`, and requests a frame.

**Call relations**: Used by `open_selected_transcript` for both cached and uncached transcripts so the same loading-overlay flow is followed.

*Call graph*: calls 1 internal fn (request_frame); called by 1 (open_selected_transcript).


##### `PickerState::handle_overlay_event`  (lines 990–1000)

```
fn handle_overlay_event(&mut self, tui: &mut Tui, event: TuiEvent) -> Result<()>
```

**Purpose**: Forwards TUI events to the active overlay and closes it when the overlay reports completion.

**Data flow**: If `self.overlay` is `Some`, passes the event to `overlay.handle_event`, checks `overlay.is_done()`, clears the overlay if finished, and requests a frame.

**Call relations**: The main event loop routes all events here whenever an overlay is active instead of letting normal picker input run.

*Call graph*: calls 1 internal fn (request_frame).


##### `PickerState::open_selected_transcript`  (lines 1002–1026)

```
fn open_selected_transcript(&mut self)
```

**Purpose**: Initiates transcript viewing for the currently selected row, using cache when possible and surfacing an inline error when no thread ID exists.

**Data flow**: Reads the selected `Row`; if it lacks `thread_id`, sets `inline_error` and requests a frame. Otherwise it inspects `transcript_cells`: loaded or loading entries just call `begin_transcript_loading`, while missing/failed entries are set to `Loading`, `begin_transcript_loading` is called, and a `PickerLoadRequest::Transcript` is sent through the loader.

**Call relations**: Triggered by transcript shortcuts in `handle_key`; it bridges selection state to background transcript loading.

*Call graph*: calls 2 internal fn (begin_transcript_loading, request_frame); called by 1 (handle_key).


##### `PickerState::handle_transcript_loading_key`  (lines 1028–1037)

```
fn handle_transcript_loading_key(&mut self, key: KeyEvent) -> Option<SessionSelection>
```

**Purpose**: Restricts input during transcript loading to only the emergency exit shortcut.

**Data flow**: Matches the incoming `KeyEvent`; returns `Some(SessionSelection::Exit)` only for `Ctrl+C`, otherwise `None`.

**Call relations**: When `is_transcript_loading()` is true, `handle_key` delegates here and suppresses all normal picker navigation and search input.

*Call graph*: called by 1 (handle_key).


##### `PickerState::handle_key`  (lines 1039–1229)

```
async fn handle_key(&mut self, key: KeyEvent) -> Result<Option<SessionSelection>>
```

**Purpose**: Implements the picker’s full keyboard state machine: exit/cancel, search editing, navigation, paging, toolbar focus, sort/filter toggles, density toggles, transcript actions, expansion, and accept behavior.

**Data flow**: Reads and mutates most picker state. It clears stale inline errors, short-circuits to transcript-loading handling when needed, resets pending page-down targets when appropriate, treats plain text as search input before navigation, handles `Ctrl+C` exit, cancel/escape semantics, transcript and expansion shortcuts (`Ctrl+T`, `Ctrl+E`, raw control chars), density toggle (`Ctrl+O`), accept/enter resolution including fallback `resolve_session_thread_id` from rollout files, movement/page/home/end via runtime keymap, toolbar focus via Tab/BackTab, toolbar value changes via left/right, backspace editing, and character insertion. It returns `Ok(Some(SessionSelection))` on exit or successful selection, otherwise `Ok(None)`.

**Call relations**: This is the central input dispatcher called from the main event loop on every non-release key event; it delegates to many smaller `PickerState` helpers depending on the key path.

*Call graph*: calls 17 internal fn (is_plain_text_key_event, change_focused_toolbar_value, clear_query_preserving_selection, ensure_selected_visible, focus_next_toolbar_control, focus_previous_toolbar_control, handle_transcript_loading_key, is_transcript_loading, load_more_if_needed, maybe_load_more_for_scroll (+7 more)); 2 external calls (from, format!).


##### `PickerState::handle_paste`  (lines 1231–1244)

```
fn handle_paste(&mut self, pasted: String)
```

**Purpose**: Appends normalized pasted text into the search query unless transcript loading is in progress.

**Data flow**: If transcript loading is active it returns immediately. Otherwise it normalizes the pasted string with `normalize_pasted_search_query`; if normalization yields text, it appends it to the existing query with a separating space when needed and calls `set_query`.

**Call relations**: The main event loop invokes this on `TuiEvent::Paste` so pasted text follows the same search-loading path as typed input.

*Call graph*: calls 3 internal fn (normalize_pasted_search_query, is_transcript_loading, set_query).


##### `PickerState::start_initial_load`  (lines 1246–1280)

```
fn start_initial_load(&mut self)
```

**Purpose**: Resets picker contents and kicks off a fresh first page load, optionally as part of an active search.

**Data flow**: Sets `relative_time_reference` to `Utc::now()`, resets pagination, clears rows and dedupe state, resets selection/footer state, derives a search token if `query` is non-empty, allocates a request token, marks pagination as pending, requests a frame, and sends a `PickerLoadRequest::Page` with `cursor = None`, current cwd/provider filters, and current sort key.

**Call relations**: Called at picker startup and whenever sort/filter changes require a full backend reload.

*Call graph*: calls 5 internal fn (active_cwd_filter, allocate_request_token, allocate_search_token, request_frame, reset_pagination); called by 2 (toggle_filter_mode, toggle_sort_key); 4 external calls (now, Pending, Page, clone).


##### `PickerState::handle_background_event`  (lines 1282–1339)

```
async fn handle_background_event(&mut self, event: BackgroundEvent) -> Result<()>
```

**Purpose**: Applies asynchronous page, preview, and transcript results to picker state while discarding stale page responses.

**Data flow**: Matches `BackgroundEvent`. For pages, it verifies the request token matches the current pending load, clears loading state, converts errors, ingests the page, completes any deferred page-down target, and continues search if the search token still matches. For previews, it stores `Loaded` or `Failed` preview state and requests a frame. For transcripts, it stores loaded cells or failure state, optionally opens a pending transcript if ready, clears pending loading on failure, sets inline error when transcript loading fails, and requests a frame.

**Call relations**: The main event loop feeds all loader responses here; this is the asynchronous counterpart to `handle_key`.

*Call graph*: calls 5 internal fn (complete_pending_page_down, continue_search_if_token_matches, ingest_page, open_pending_transcript_if_ready, request_frame); 2 external calls (Loaded, Loaded).


##### `PickerState::reset_pagination`  (lines 1341–1347)

```
fn reset_pagination(&mut self)
```

**Purpose**: Clears pagination cursors, scanned counts, scan-cap state, loading state, and frozen footer progress.

**Data flow**: Mutates the `pagination` struct fields back to empty/idle values and clears `frozen_footer_percent`.

**Call relations**: Used by `start_initial_load` before issuing a fresh first-page request.

*Call graph*: called by 1 (start_initial_load).


##### `PickerState::ingest_page`  (lines 1349–1374)

```
fn ingest_page(&mut self, page: PickerPage)
```

**Purpose**: Merges a newly loaded page into the picker, updating pagination metadata and deduplicating overlapping rows.

**Data flow**: Reads `page.next_cursor`, `num_scanned_files`, and `reached_scan_cap` into pagination state; iterates page rows, computes each row’s `seen_key`, inserts unseen keys into `seen_rows`, appends unique rows to `all_rows`, and finally recomputes `filtered_rows` via `apply_filter`.

**Call relations**: Called from page background-event handling after token validation.

*Call graph*: calls 1 internal fn (apply_filter); called by 1 (handle_background_event).


##### `PickerState::complete_pending_page_down`  (lines 1376–1395)

```
fn complete_pending_page_down(&mut self)
```

**Purpose**: Finishes a deferred PageDown movement after additional rows have been loaded.

**Data flow**: Reads `pending_page_down_target`; if the target still exceeds the current max index and more pages exist, it triggers another load. Otherwise it clears the pending target, clamps `selected` to the available rows, ensures visibility, maybe preloads more for near-bottom scrolling, and requests a frame.

**Call relations**: Page background handling invokes this after ingesting a page when a previous PageDown requested movement beyond the currently loaded rows.

*Call graph*: calls 4 internal fn (ensure_selected_visible, load_more_if_needed, maybe_load_more_for_scroll, request_frame); called by 1 (handle_background_event).


##### `PickerState::apply_filter`  (lines 1397–1416)

```
fn apply_filter(&mut self)
```

**Purpose**: Rebuilds `filtered_rows` from `all_rows` using the current cwd filter mode and typed query, then repairs selection and scroll state.

**Data flow**: Filters `all_rows` through `row_matches_filter`; if `query` is empty it clones all matching rows, otherwise lowercases the query and keeps rows whose `matches_query` returns true. It clamps `selected`, resets `scroll_top` when empty, ensures the selected row is visible, and requests a frame.

**Call relations**: Called after page ingestion, query changes, and query clearing to keep the visible list synchronized with state.

*Call graph*: calls 2 internal fn (ensure_selected_visible, request_frame); called by 3 (clear_query_preserving_selection, ingest_page, set_query).


##### `PickerState::row_matches_filter`  (lines 1418–1429)

```
fn row_matches_filter(&self, row: &Row) -> bool
```

**Purpose**: Applies the non-search filter layer, currently cwd scoping for local workspaces.

**Data flow**: If `filter_mode` is `All`, returns `true`. Otherwise it reads `local_filter_cwd` and the row’s `cwd`; rows without cwd fail in cwd mode, and rows with cwd are compared using normalized `paths_match`.

**Call relations**: Used inside `apply_filter`; remote workspaces typically set `local_filter_cwd` to `None`, effectively disabling local post-filtering.

*Call graph*: calls 1 internal fn (paths_match).


##### `PickerState::set_query`  (lines 1431–1453)

```
fn set_query(&mut self, new_query: String)
```

**Purpose**: Updates the search query, reapplies filtering, and starts search-driven pagination when no loaded rows match yet.

**Data flow**: If the query is unchanged it returns. Otherwise it stores the new query, resets selection to 0, calls `apply_filter`, and then either idles search state (empty query, existing matches, no more pages, or scan cap reached) or allocates a new search token, marks `search_state` active, and calls `load_more_if_needed(LoadTrigger::Search { token })`.

**Call relations**: Both typed character input and paste handling funnel through this method.

*Call graph*: calls 3 internal fn (allocate_search_token, apply_filter, load_more_if_needed); called by 2 (handle_key, handle_paste).


##### `PickerState::clear_query_preserving_selection`  (lines 1455–1473)

```
fn clear_query_preserving_selection(&mut self)
```

**Purpose**: Clears the search query while trying to keep the same logical row selected in the unfiltered list.

**Data flow**: Captures the selected row’s `seen_key`, clears `query`, sets search state idle, reapplies filtering, then searches the new `filtered_rows` for the same key; if found, updates `selected`, ensures visibility, and requests a frame.

**Call relations**: Used by the cancel/escape path when the user wants to leave search mode without losing context.

*Call graph*: calls 3 internal fn (apply_filter, ensure_selected_visible, request_frame); called by 1 (handle_key).


##### `PickerState::continue_search_if_needed`  (lines 1475–1488)

```
fn continue_search_if_needed(&mut self)
```

**Purpose**: Continues search-driven pagination after a page arrives if the active query still has no matches and more pages remain.

**Data flow**: Reads the active search token; if matches now exist or pagination is exhausted/scan-capped, it idles search state. Otherwise it requests another page load with the same search token.

**Call relations**: This is the iterative search-paging step called only through token-checked continuation.

*Call graph*: calls 1 internal fn (load_more_if_needed); called by 1 (continue_search_if_token_matches); 1 external calls (active_token).


##### `PickerState::continue_search_if_token_matches`  (lines 1490–1500)

```
fn continue_search_if_token_matches(&mut self, completed_token: Option<usize>)
```

**Purpose**: Prevents stale page responses from advancing a newer search.

**Data flow**: Reads the current active search token and compares it with an optional completed token from the page response; if they differ it returns early, otherwise it calls `continue_search_if_needed`.

**Call relations**: Page background handling uses this after each completed load to decide whether to keep paging for the current query.

*Call graph*: calls 1 internal fn (continue_search_if_needed); called by 1 (handle_background_event); 1 external calls (active_token).


##### `PickerState::ensure_selected_visible`  (lines 1502–1517)

```
fn ensure_selected_visible(&mut self)
```

**Purpose**: Adjusts `scroll_top` so the selected row fits within the current viewport, accounting for variable rendered row heights.

**Data flow**: If there are no rows it resets `scroll_top` to 0. Otherwise it computes viewport capacity from `view_rows`, moves `scroll_top` upward if selection is above it, and then increments `scroll_top` while the rendered height from `scroll_top` through `selected` exceeds available content rows.

**Call relations**: Called after selection changes, filtering, viewport changes, and density toggles to keep the cursor on-screen.

*Call graph*: calls 2 internal fn (available_content_rows, rendered_height_between); called by 6 (apply_filter, clear_query_preserving_selection, complete_pending_page_down, handle_key, toggle_density, update_viewport).


##### `PickerState::ensure_minimum_rows_for_view`  (lines 1519–1539)

```
fn ensure_minimum_rows_for_view(&mut self, minimum_rows: usize)
```

**Purpose**: Prefetches additional pages when the currently rendered rows do not fill the visible list area.

**Data flow**: Given a minimum row count, it returns early for zero height, active loads, or no next cursor. Otherwise it computes total rendered height of current filtered rows and compares it with available content rows; if underfilled, it triggers another load using the active search token when searching or a scroll-triggered load otherwise.

**Call relations**: The draw/resize path calls this after viewport updates so the picker opportunistically fills empty space.

*Call graph*: calls 3 internal fn (available_content_rows, load_more_if_needed, rendered_height_between); 1 external calls (active_token).


##### `PickerState::update_viewport`  (lines 1541–1545)

```
fn update_viewport(&mut self, rows: usize, width: u16)
```

**Purpose**: Stores the current list viewport dimensions and revalidates scroll position.

**Data flow**: Sets `view_rows` to `Some(rows)` unless zero, stores `view_width`, and calls `ensure_selected_visible`.

**Call relations**: The draw/resize branch in the main loop updates these values before rendering.

*Call graph*: calls 1 internal fn (ensure_selected_visible).


##### `PickerState::maybe_load_more_for_scroll`  (lines 1547–1561)

```
fn maybe_load_more_for_scroll(&mut self)
```

**Purpose**: Starts loading another page when the selection approaches the end of the loaded rows.

**Data flow**: Returns early if already loading, no next cursor exists, or there are no rows. Otherwise it computes remaining rows below the selection and triggers `load_more_if_needed(Scroll)` when that count is at or below `LOAD_NEAR_THRESHOLD`.

**Call relations**: Movement and deferred page-down completion call this to keep scrolling smooth near the bottom.

*Call graph*: calls 1 internal fn (load_more_if_needed); called by 2 (complete_pending_page_down, handle_key).


##### `PickerState::load_more_if_needed`  (lines 1563–1590)

```
fn load_more_if_needed(&mut self, trigger: LoadTrigger)
```

**Purpose**: Issues the next paginated page request if pagination is idle and a next cursor exists.

**Data flow**: Checks loading state and `pagination.next_cursor`; if loadable, freezes the footer percent, allocates a request token, derives an optional search token from the trigger, marks pagination pending, requests a frame, and sends a `PickerLoadRequest::Page` with the next cursor plus current cwd/provider/sort settings.

**Call relations**: This is the single page-fetch issuance path used by scrolling, underfilled viewport prefetch, and search continuation.

*Call graph*: calls 4 internal fn (active_cwd_filter, allocate_request_token, freeze_footer_percent, request_frame); called by 6 (complete_pending_page_down, continue_search_if_needed, ensure_minimum_rows_for_view, handle_key, maybe_load_more_for_scroll, set_query); 3 external calls (Pending, Page, clone).


##### `PickerState::freeze_footer_percent`  (lines 1592–1595)

```
fn freeze_footer_percent(&mut self)
```

**Purpose**: Captures the current scroll percentage so the footer does not jump backward while a page load is in flight.

**Data flow**: Computes list height from `view_rows`, calls `picker_footer_scroll_percent`, and stores the result in `frozen_footer_percent`.

**Call relations**: Called immediately before starting a paginated load.

*Call graph*: calls 1 internal fn (picker_footer_scroll_percent); called by 1 (load_more_if_needed).


##### `PickerState::allocate_request_token`  (lines 1597–1601)

```
fn allocate_request_token(&mut self) -> usize
```

**Purpose**: Generates a monotonically wrapping token for page requests.

**Data flow**: Returns the current `next_request_token`, then increments it with wrapping arithmetic.

**Call relations**: Used by both initial loads and subsequent pagination so stale page responses can be ignored.

*Call graph*: called by 2 (load_more_if_needed, start_initial_load).


##### `PickerState::allocate_search_token`  (lines 1603–1607)

```
fn allocate_search_token(&mut self) -> usize
```

**Purpose**: Generates a monotonically wrapping token for search sessions.

**Data flow**: Returns the current `next_search_token`, then increments it with wrapping arithmetic.

**Call relations**: Used when a new query starts a search-driven pagination sequence.

*Call graph*: called by 2 (set_query, start_initial_load).


##### `PickerState::toggle_sort_key`  (lines 1614–1620)

```
fn toggle_sort_key(&mut self)
```

**Purpose**: Switches the backend sort order between created-at and updated-at and reloads from page one.

**Data flow**: Flips `sort_key` between the two enum variants and calls `start_initial_load` to clear rows and request a fresh first page.

**Call relations**: Toolbar value changes delegate here when sort is focused.

*Call graph*: calls 1 internal fn (start_initial_load); called by 1 (change_focused_toolbar_value).


##### `PickerState::toggle_filter_mode`  (lines 1622–1629)

```
fn toggle_filter_mode(&mut self)
```

**Purpose**: Switches between cwd-only and all-session filtering and reloads from page one when the mode actually changes.

**Data flow**: Computes the next mode via `SessionFilterMode::toggle`; if unchanged it returns, otherwise stores the new mode and calls `start_initial_load`.

**Call relations**: Toolbar value changes delegate here when filter is focused.

*Call graph*: calls 2 internal fn (start_initial_load, toggle); called by 1 (change_focused_toolbar_value).


##### `PickerState::active_cwd_filter`  (lines 1631–1636)

```
fn active_cwd_filter(&self) -> Option<PathBuf>
```

**Purpose**: Returns the backend cwd filter that should be attached to the next page request under the current filter mode.

**Data flow**: If `filter_mode` is `Cwd`, clones and returns `self.filter_cwd`; if `All`, returns `None`.

**Call relations**: Initial and subsequent page loads call this so backend filtering tracks the toolbar state.

*Call graph*: called by 2 (load_more_if_needed, start_initial_load).


##### `PickerState::focus_previous_toolbar_control`  (lines 1638–1640)

```
fn focus_previous_toolbar_control(&mut self)
```

**Purpose**: Moves toolbar focus backward.

**Data flow**: Replaces `toolbar_focus` with `toolbar_focus.previous()`.

**Call relations**: Called from `handle_key` on reverse-tab.

*Call graph*: calls 1 internal fn (previous); called by 1 (handle_key).


##### `PickerState::focus_next_toolbar_control`  (lines 1642–1644)

```
fn focus_next_toolbar_control(&mut self)
```

**Purpose**: Moves toolbar focus forward.

**Data flow**: Replaces `toolbar_focus` with `toolbar_focus.next()`.

**Call relations**: Called from `handle_key` on Tab.

*Call graph*: calls 1 internal fn (next); called by 1 (handle_key).


##### `PickerState::change_focused_toolbar_value`  (lines 1646–1651)

```
fn change_focused_toolbar_value(&mut self)
```

**Purpose**: Applies a left/right toolbar action to whichever control currently has focus.

**Data flow**: Matches `toolbar_focus` and calls either `toggle_sort_key` or `toggle_filter_mode`.

**Call relations**: The left/right navigation branch in `handle_key` delegates here.

*Call graph*: calls 2 internal fn (toggle_filter_mode, toggle_sort_key); called by 1 (handle_key).


##### `PickerState::toggle_density`  (lines 1653–1661)

```
async fn toggle_density(&mut self)
```

**Purpose**: Switches list density, keeps the selection visible, attempts to persist the preference, and surfaces persistence failures inline without reverting the toggle.

**Data flow**: Flips `density`, calls `ensure_selected_visible`, awaits `persist_density`, logs and stores an inline error if persistence fails, then requests a frame.

**Call relations**: Triggered by `Ctrl+O` or raw `^O` in `handle_key`.

*Call graph*: calls 4 internal fn (ensure_selected_visible, persist_density, request_frame, toggle); called by 1 (handle_key); 2 external calls (format!, warn!).


##### `PickerState::persist_density`  (lines 1663–1675)

```
async fn persist_density(&self) -> Result<()>
```

**Purpose**: Writes the current picker density back to `config.toml` when persistence is configured.

**Data flow**: If `view_persistence` is absent it returns `Ok(())`. Otherwise it builds a `ConfigEditsBuilder` rooted at `codex_home`, sets `session_picker_view` from the current density, applies the edit asynchronously, and maps write failures into an eyre error.

**Call relations**: Only `toggle_density` calls this; tests verify both successful persistence and failure behavior.

*Call graph*: calls 1 internal fn (new); called by 1 (toggle_density); 1 external calls (from).


##### `PickerState::toggle_selected_expansion`  (lines 1677–1697)

```
fn toggle_selected_expansion(&mut self)
```

**Purpose**: Expands or collapses the selected row’s transcript preview and lazily requests preview data on first expansion.

**Data flow**: Reads the selected row and its `thread_id`; if the row is already expanded it clears `expanded_thread_id` and requests a frame. Otherwise it stores the thread ID as expanded, inserts `TranscriptPreviewState::Loading` if no preview state exists yet, sends a `PickerLoadRequest::Preview`, and requests a frame.

**Call relations**: Expansion shortcuts in `handle_key` route here.

*Call graph*: calls 1 internal fn (request_frame); called by 1 (handle_key).


##### `PickerState::rendered_height_between`  (lines 1699–1723)

```
fn rendered_height_between(&self, start: usize, end_inclusive: usize) -> usize
```

**Purpose**: Computes the total rendered height of a contiguous slice of filtered rows, including separators and expansion state.

**Data flow**: Slices `filtered_rows[start..=end_inclusive]`, renders each row via `render_session_lines` using current selection/expansion/view width, sums line counts, adds separator heights between rows according to density, and returns the total `usize`.

**Call relations**: Scrolling, viewport fill checks, and footer percentage calculations all depend on this height-aware measurement.

*Call graph*: calls 1 internal fn (row_separator_height); called by 3 (ensure_minimum_rows_for_view, ensure_selected_visible, picker_footer_scroll_percent).


##### `PickerState::has_more_above`  (lines 1725–1727)

```
fn has_more_above(&self) -> bool
```

**Purpose**: Reports whether there are rows scrolled off above the visible list.

**Data flow**: Returns `true` when `scroll_top > 0`.

**Call relations**: List rendering and content-row calculations use this to reserve a top `↑ more` indicator line.

*Call graph*: called by 2 (available_content_rows, render_list).


##### `PickerState::has_more_below`  (lines 1729–1759)

```
fn has_more_below(&self, viewport_height: usize) -> bool
```

**Purpose**: Reports whether there are rows or pages below the visible viewport.

**Data flow**: If there are no rows it returns `false`. If another page cursor exists it returns `true` immediately. Otherwise it simulates rendering rows from `scroll_top` downward, accounting for row heights and separators against available content capacity, and returns `true` if content would overflow.

**Call relations**: Used by list rendering and content-row calculations to decide whether to show a bottom `↓ more` or `↓ loading more` indicator.

*Call graph*: calls 3 internal fn (available_content_rows, row_separator_height, render_session_lines); called by 1 (render_list); 1 external calls (from).


##### `PickerState::available_content_rows`  (lines 1761–1769)

```
fn available_content_rows(&self, viewport_height: usize) -> usize
```

**Purpose**: Computes how many viewport rows remain for actual session content after reserving top/bottom more indicators.

**Data flow**: Starts from `viewport_height`, subtracts one row if `has_more_above()` is true, subtracts one row if there may be more below or the selection is not on the last row, and clamps the result to at least 1.

**Call relations**: Scrolling, footer percentage, and underfill prefetch logic all use this shared capacity calculation.

*Call graph*: calls 1 internal fn (has_more_above); called by 4 (ensure_minimum_rows_for_view, ensure_selected_visible, has_more_below, picker_footer_scroll_percent); 1 external calls (from).


##### `PickerState::row_separator_height`  (lines 1771–1776)

```
fn row_separator_height(&self) -> usize
```

**Purpose**: Returns the blank-line separator height inserted between rows for the current density.

**Data flow**: Returns `1` for `Comfortable` and `0` for `Dense`.

**Call relations**: Height calculations and list rendering use this to keep scrolling math aligned with visual spacing.

*Call graph*: called by 2 (has_more_below, rendered_height_between).


##### `row_from_app_server_thread`  (lines 1779–1804)

```
fn row_from_app_server_thread(thread: Thread) -> Option<Row>
```

**Purpose**: Converts an app-server `Thread` into a picker `Row`, skipping threads whose IDs cannot be parsed.

**Data flow**: Parses `thread.id` into `ThreadId`; on failure logs a warning and returns `None`. On success it trims `thread.preview`, substitutes `(no message yet)` when empty, converts timestamps with `DateTime::from_timestamp(...).with_timezone(&Utc)`, copies path/name/cwd, extracts git branch, and returns `Some(Row)`.

**Call relations**: Page loading maps backend threads through this function before rows enter picker state.

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

**Purpose**: Builds the `thread/list` RPC parameters used by picker pagination.

**Data flow**: Combines cursor, page size, sort key, provider filter, source kinds, archived=false, optional cwd filter, and `use_state_db_only = false` into a `ThreadListParams` struct.

**Call relations**: Only `load_app_server_page` uses this in production; tests also inspect it directly to verify local/remote filtering behavior.

*Call graph*: called by 4 (load_app_server_page, local_picker_thread_list_params_include_cwd_filter, remote_thread_list_params_can_include_non_interactive_sources, remote_thread_list_params_omit_provider_filter); 2 external calls (resume_source_kinds, vec!).


##### `paths_match`  (lines 1831–1833)

```
fn paths_match(a: &Path, b: &Path) -> bool
```

**Purpose**: Compares two paths using the project’s normalization-aware path matcher.

**Data flow**: Passes both `&Path` arguments to `path_utils::paths_match_after_normalization` and returns the boolean result.

**Call relations**: This isolates cwd matching semantics for row filtering.

*Call graph*: called by 1 (row_matches_filter); 1 external calls (paths_match_after_normalization).


##### `parse_timestamp_str`  (lines 1836–1840)

```
fn parse_timestamp_str(ts: &str) -> Option<DateTime<Utc>>
```

**Purpose**: Parses an RFC3339 timestamp string into `DateTime<Utc>` for tests and snapshots.

**Data flow**: Calls `chrono::DateTime::parse_from_rfc3339`, converts successful parses to UTC, and returns `Option<DateTime<Utc>>`.

**Call relations**: Production code does not rely on it; the test module uses it heavily to build deterministic rows and reference times.

*Call graph*: called by 12 (comfortable_zebra_lines_use_full_width_background, dense_session_line_prefers_thread_name_over_preview, dense_session_snapshot_uses_no_blank_lines_between_rows, dense_snapshot_row, density_toggle_clears_stale_more_indicator, expanded_session_details_include_metadata, expanded_session_snapshot, make_row, narrow_session_snapshot, render_dense_row_snapshot (+2 more)); 1 external calls (parse_from_rfc3339).


##### `draw_picker`  (lines 1842–1892)

```
fn draw_picker(tui: &mut Tui, state: &PickerState) -> std::io::Result<()>
```

**Purpose**: Renders the full picker screen, including header, search line, list area, transcript-loading overlay, and footer.

**Data flow**: Reads terminal size, invokes `tui.draw`, splits the frame into header/search/list/footer regions with fixed chrome heights, applies horizontal insets, renders the action title, search line, list, optional transcript-loading overlay, and footer.

**Call relations**: The main event loop calls this on draw/resize events after updating viewport state.

*Call graph*: 1 external calls (draw).


##### `list_viewport_width`  (lines 1894–1896)

```
fn list_viewport_width(width: u16) -> u16
```

**Purpose**: Computes the effective content width of the list after horizontal inset is applied.

**Data flow**: Subtracts `PICKER_LIST_HORIZONTAL_INSET` from the supplied width using saturating arithmetic and returns the resulting `u16`.

**Call relations**: Used both in drawing and viewport bookkeeping so width-sensitive row rendering matches the actual list area.


##### `search_line`  (lines 1898–1933)

```
fn search_line(state: &PickerState, width: u16) -> Line<'_>
```

**Purpose**: Builds the single-line search and toolbar row, including inline errors, placeholder text, truncation, and compact toolbar fallback.

**Data flow**: If `inline_error` exists it returns a red error line. Otherwise it builds either a dim placeholder or `Search: {query}`, renders the toolbar in wide mode then retries compact mode if needed, computes widths with `UnicodeWidthStr`, truncates the search text if necessary, inserts spacer padding, and returns the combined `Line`.

**Call relations**: Called from `draw_picker`; tests snapshot both normal and error states.

*Call graph*: calls 2 internal fn (toolbar_line, truncate_text); called by 3 (resume_search_error_snapshot, search_line_compacts_toolbar_on_narrow_width, search_line_renders_sort_and_filter_tabs); 4 external calls (from, width, format!, vec!).


##### `toolbar_line`  (lines 1935–1941)

```
fn toolbar_line(state: &PickerState, compact: bool) -> Line<'static>
```

**Purpose**: Assembles the filter and sort toolbar spans into one line.

**Data flow**: Collects spans from `filter_control_spans`, inserts a dim three-space gap, appends spans from `sort_control_spans`, and returns them as a `Line`.

**Call relations**: Used only by `search_line`.

*Call graph*: calls 2 internal fn (filter_control_spans, sort_control_spans); called by 1 (search_line); 1 external calls (new).


##### `sort_control_spans`  (lines 1943–1968)

```
fn sort_control_spans(state: &PickerState, compact: bool) -> Vec<Span<'static>>
```

**Purpose**: Renders the sort toolbar control in either compact single-value form or expanded two-option form.

**Data flow**: Reads `state.sort_key` and whether sort has focus; in compact mode returns `Sort:` plus one highlighted current value, otherwise returns `Sort:` plus separate `Updated` and `Created` values with active/focused styling.

**Call relations**: Called by `toolbar_line` as part of the search/header chrome.

*Call graph*: called by 1 (toolbar_line); 1 external calls (vec!).


##### `filter_control_spans`  (lines 1970–1995)

```
fn filter_control_spans(state: &PickerState, compact: bool) -> Vec<Span<'static>>
```

**Purpose**: Renders the filter toolbar control in compact or expanded form, hiding the cwd/all split when no cwd candidate exists.

**Data flow**: Reads `state.filter_mode`, `state.filter_cwd`, and toolbar focus; returns either a compact `Filter:[...]` control or expanded `Cwd`/`All` options, with active/focused styling.

**Call relations**: Called by `toolbar_line`; its compacting behavior is important on narrow widths and when cwd filtering is unavailable.

*Call graph*: called by 1 (toolbar_line); 1 external calls (vec!).


##### `toolbar_value`  (lines 1997–2008)

```
fn toolbar_value(label: &'static str, active: bool, focused: bool) -> Span<'static>
```

**Purpose**: Styles one toolbar option according to whether it is active and focused.

**Data flow**: Formats active values as `[label]`, colors them magenta when focused, leaves inactive values as dim padded text, and returns a `Span`.

**Call relations**: Both sort and filter toolbar renderers use this helper to keep styling consistent.

*Call graph*: 1 external calls (format!).


##### `filter_mode_label`  (lines 2010–2015)

```
fn filter_mode_label(filter_mode: SessionFilterMode) -> &'static str
```

**Purpose**: Returns the short display label for a filter mode.

**Data flow**: Matches `SessionFilterMode` and returns `"Cwd"` or `"All"`.

**Call relations**: Used by filter toolbar rendering.


##### `render_picker_footer`  (lines 2024–2049)

```
fn render_picker_footer(
    frame: &mut crate::custom_terminal::Frame,
    area: Rect,
    state: &PickerState,
    list_height: u16,
)
```

**Purpose**: Draws the footer separator/progress line and up to two rows of responsive key-hint text.

**Data flow**: Returns early for zero-sized areas, renders a separator line with `picker_footer_progress_label`, computes footer hint lines with `footer_hint_lines`, and renders each line within the footer area until space runs out.

**Call relations**: Called from `draw_picker`; tests snapshot its output across widths and states.

*Call graph*: calls 4 internal fn (render_widget_ref, footer_hint_lines, picker_footer_progress_label, render_picker_footer_separator); called by 1 (footer_snapshot); 2 external calls (bottom, new).


##### `render_picker_footer_separator`  (lines 2051–2073)

```
fn render_picker_footer_separator(
    frame: &mut crate::custom_terminal::Frame,
    area: Rect,
    progress_label: String,
)
```

**Purpose**: Draws the horizontal separator line and overlays the progress label at the right edge when it fits.

**Data flow**: Fills the area with dim `─` characters, measures the progress label width, and if it fits, renders the dim label right-aligned with one column of padding.

**Call relations**: Used only by `render_picker_footer`.

*Call graph*: calls 1 internal fn (render_widget_ref); called by 1 (render_picker_footer); 3 external calls (from, new, width).


##### `picker_footer_progress_label`  (lines 2075–2096)

```
fn picker_footer_progress_label(state: &PickerState, list_height: u16, width: u16) -> String
```

**Purpose**: Formats the footer’s position/total/percent label, choosing among progressively shorter variants to fit the available width.

**Data flow**: Computes current position from `selected`, total from `filtered_rows.len()` with an ellipsis suffix while loading, gets percent from `picker_footer_percent`, builds three candidate strings, and returns the first whose display width fits.

**Call relations**: Footer rendering calls this every draw; tests verify loading and pagination edge cases.

*Call graph*: calls 1 internal fn (picker_footer_percent); called by 4 (render_picker_footer, picker_footer_progress_label_freezes_percent_while_loading, picker_footer_progress_label_shows_position_total_and_percent, picker_footer_progress_label_uses_known_count_when_more_pages_exist); 1 external calls (format!).


##### `picker_footer_percent`  (lines 2098–2110)

```
fn picker_footer_percent(state: &PickerState, list_height: u16) -> u8
```

**Purpose**: Returns the footer scroll percentage, freezing it during active pagination when a frozen value exists.

**Data flow**: If pagination is pending, returns `frozen_footer_percent` when set or computes a fallback percent; otherwise delegates directly to `picker_footer_scroll_percent`.

**Call relations**: Used only by `picker_footer_progress_label`; `freeze_footer_percent` prepares the frozen value before loads.

*Call graph*: calls 1 internal fn (picker_footer_scroll_percent); called by 1 (picker_footer_progress_label).


##### `picker_footer_scroll_percent`  (lines 2112–2136)

```
fn picker_footer_scroll_percent(state: &PickerState, list_height: u16) -> u8
```

**Purpose**: Computes scroll progress from rendered content height rather than item count.

**Data flow**: Handles empty/non-scrollable lists as 100%, computes content capacity, total rendered height, max scroll height, remaining height below `scroll_top`, and skipped height above `scroll_top`, then converts the skipped/max-scroll ratio into a rounded `u8` percent.

**Call relations**: This underpins both live and frozen footer percentages.

*Call graph*: calls 2 internal fn (available_content_rows, rendered_height_between); called by 2 (freeze_footer_percent, picker_footer_percent).


##### `footer_hint_lines`  (lines 2138–2245)

```
fn footer_hint_lines(state: &PickerState, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Builds the footer key-hint rows, adapting labels and priorities to transcript-loading state, launch context, search state, density, and available width.

**Data flow**: If transcript loading is active, constructs a minimal hint set (`loading transcript`, `ctrl+c quit/exit`) and fits it. Otherwise it derives action/cancel/density labels from picker state, builds two ordered `PickerFooterHint` lists, and returns one fitted line per row using `hint_line_for_row`.

**Call relations**: Footer rendering calls this every draw; many tests validate its responsive behavior and wording changes.

*Call graph*: calls 2 internal fn (is_transcript_loading, fit_footer_hints); called by 3 (render_picker_footer, footer_lines_text, hint_line_prioritizes_keybinds_when_very_narrow); 2 external calls (from, vec!).


##### `hint_line_for_row`  (lines 2247–2274)

```
fn hint_line_for_row(hints: &[PickerFooterHint], width: u16) -> Line<'static>
```

**Purpose**: Fits one row of footer hints into the available width, progressively degrading from wide labels to compact labels to key-only subsets.

**Data flow**: Tries wide mode when width exceeds the compact breakpoint, then compact mode, then key-only mode. If none fit, it sorts hints by priority, repeatedly drops the lowest-priority hints, and returns the first key-only subset that fits, or an empty line.

**Call relations**: Used by `footer_hint_lines` to make footer hints responsive without overflowing.

*Call graph*: calls 2 internal fn (fit_footer_hint_refs, fit_footer_hints); 2 external calls (default, len).


##### `render_transcript_loading_overlay`  (lines 2276–2311)

```
fn render_transcript_loading_overlay(frame: &mut crate::custom_terminal::Frame, area: Rect)
```

**Purpose**: Draws a centered translucent overlay over the list while a full transcript is loading.

**Data flow**: Computes an overlay rectangle sized around the message `Loading transcript…`, fills the rectangle in the frame buffer with spaces styled by `transcript_loading_overlay_style`, truncates the message if needed, centers it, and renders it in bold.

**Call relations**: Called from `draw_picker` when `PickerState::is_transcript_loading()` is true.

*Call graph*: calls 3 internal fn (render_widget_ref, transcript_loading_overlay_style, truncate_text); called by 1 (transcript_loading_overlay_snapshot); 3 external calls (from, new, width).


##### `transcript_loading_overlay_style`  (lines 2313–2323)

```
fn transcript_loading_overlay_style() -> Style
```

**Purpose**: Chooses a subtle overlay background color blended against the terminal’s default background.

**Data flow**: Reads `default_bg()`. If absent, returns dark gray background. Otherwise it chooses a black or white overlay color and alpha based on whether the background is light, blends it with `blend`, converts via `best_color`, and returns the resulting `Style`.

**Call relations**: Used only by the transcript-loading overlay renderer.

*Call graph*: calls 4 internal fn (blend, is_light, best_color, default_bg); called by 1 (render_transcript_loading_overlay); 1 external calls (default).


##### `fit_footer_hints`  (lines 2332–2339)

```
fn fit_footer_hints(
    hints: &[PickerFooterHint],
    mode: FooterHintLabelMode,
    width: u16,
) -> Option<Line<'static>>
```

**Purpose**: Convenience wrapper that converts owned footer hints into references before width fitting.

**Data flow**: Collects `hints.iter()` into a `Vec<&PickerFooterHint>` and forwards to `fit_footer_hint_refs`.

**Call relations**: Called by footer hint layout code in both normal and transcript-loading modes.

*Call graph*: calls 1 internal fn (fit_footer_hint_refs); called by 2 (footer_hint_lines, hint_line_for_row); 1 external calls (iter).


##### `fit_footer_hint_refs`  (lines 2341–2371)

```
fn fit_footer_hint_refs(
    hints: &[&PickerFooterHint],
    mode: FooterHintLabelMode,
    width: u16,
) -> Option<Line<'static>>
```

**Purpose**: Renders a specific set of footer hints in a chosen label mode if they fit within the given width.

**Data flow**: Computes total width with `footer_hints_width`; if too wide returns `None`. Otherwise it builds spans with left padding, inter-hint gaps, key styling from `footer_hint_key_style`, optional labels from the selected mode styled by `footer_hint_label_style`, and returns the assembled `Line`.

**Call relations**: This is the low-level footer hint formatter used by all fitting strategies.

*Call graph*: calls 3 internal fn (footer_hint_key_style, footer_hint_label_style, footer_hints_width); called by 2 (fit_footer_hints, hint_line_for_row); 2 external calls (iter, vec!).


##### `footer_hint_key_style`  (lines 2373–2379)

```
fn footer_hint_key_style() -> Style
```

**Purpose**: Returns the style used for footer hint key names.

**Data flow**: Checks whether the terminal background is light; returns black foreground on light backgrounds and default style otherwise.

**Call relations**: Used by `fit_footer_hint_refs` so key labels remain legible across themes.

*Call graph*: calls 1 internal fn (default_bg); called by 1 (fit_footer_hint_refs); 1 external calls (default).


##### `footer_hint_label_style`  (lines 2381–2387)

```
fn footer_hint_label_style() -> Style
```

**Purpose**: Returns the style used for footer hint descriptive labels.

**Data flow**: Checks whether the terminal background is light; returns dark gray foreground on light backgrounds and dim default style otherwise.

**Call relations**: Used by `fit_footer_hint_refs` for the non-key portion of footer hints.

*Call graph*: calls 1 internal fn (default_bg); called by 1 (fit_footer_hint_refs); 1 external calls (default).


##### `footer_hints_width`  (lines 2389–2416)

```
fn footer_hints_width(
    hints: &[&PickerFooterHint],
    mode: FooterHintLabelMode,
    gap_width: usize,
) -> usize
```

**Purpose**: Measures the display width of a footer hint row under a specific label mode and gap size.

**Data flow**: Sums left padding plus each hint’s key width and optional label width, adding `gap_width` between hints after the first, and returns the total `usize` width.

**Call relations**: `fit_footer_hint_refs` uses this as its fit predicate before constructing spans.

*Call graph*: called by 1 (fit_footer_hint_refs); 1 external calls (iter).


##### `render_list`  (lines 2418–2498)

```
fn render_list(frame: &mut crate::custom_terminal::Frame, area: Rect, state: &PickerState)
```

**Purpose**: Renders the scrollable session list area, including empty states, top/bottom more indicators, rows, and inline loading text.

**Data flow**: Clears the area, checks for empty `filtered_rows` and renders `render_empty_state_line` if needed. Otherwise it computes whether more content exists above/below, reserves indicator rows, iterates visible rows from `scroll_top`, renders each via `render_session_lines`, inserts blank separators in comfortable mode, optionally renders `Loading older sessions…` inside the content area, and draws top/bottom more indicators.

**Call relations**: Called from `draw_picker`; many snapshot tests validate its output across densities and widths.

*Call graph*: calls 6 internal fn (render_widget_ref, has_more_above, has_more_below, more_line, render_empty_state_line, render_session_lines); called by 8 (dense_session_snapshot_uses_no_blank_lines_between_rows, density_toggle_clears_stale_more_indicator, expanded_session_snapshot, narrow_session_snapshot, render_dense_row_snapshot, resume_table_snapshot, session_list_more_indicators_snapshot, transcript_loading_overlay_snapshot); 3 external calls (new, from, vec!).


##### `more_line`  (lines 2500–2502)

```
fn more_line(label: &'static str) -> Line<'static>
```

**Purpose**: Builds the dim single-line `↑ more`, `↓ more`, or `↓ loading more` indicator.

**Data flow**: Wraps the supplied static label in a dim `Line` and returns it.

**Call relations**: Used only by `render_list`.

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

**Purpose**: Dispatches row rendering to the comfortable or dense renderer based on current picker density.

**Data flow**: Reads `state.density` and forwards all row/rendering flags to either `render_comfortable_session_lines` or `render_dense_session_lines`, returning the resulting `Vec<Line>`.

**Call relations**: Both list rendering and height calculations call this shared dispatcher.

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

**Purpose**: Renders a session as a multi-line card with title plus metadata footer, or expanded transcript details when selected and expanded.

**Data flow**: Builds a selection marker, truncates and styles the title, optionally applies selected/zebra background across full width, and either appends transcript preview lines when expanded or computes relative created/updated times, formatted cwd/branch metadata, and footer lines via `render_footer_lines`. It returns all lines for the row.

**Call relations**: Used when density is `Comfortable`; expanded rows also route through transcript preview rendering here.

*Call graph*: calls 9 internal fn (apply_session_row_background, dense_selected_style, dense_zebra_style, format_relative_time, render_footer_lines, render_transcript_preview_lines, selected_session_title_span, selection_marker, truncate_text); called by 2 (render_session_lines, comfortable_zebra_lines_use_full_width_background); 3 external calls (from, display_preview, vec!).


##### `apply_session_row_background`  (lines 2579–2588)

```
fn apply_session_row_background(
    lines: Vec<Line<'static>>,
    style: Style,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Applies a background style across every line of a rendered session row.

**Data flow**: Maps each input `Line` through `apply_line_background` with the supplied style and width, returning the transformed vector.

**Call relations**: Comfortable row rendering uses this to ensure zebra and selected backgrounds fill the full row width.

*Call graph*: called by 1 (render_comfortable_session_lines).


##### `apply_line_background`  (lines 2590–2600)

```
fn apply_line_background(mut line: Line<'static>, style: Style, width: u16) -> Line<'static>
```

**Purpose**: Pads a line to full width and patches its line/span styles with a background style.

**Data flow**: Computes missing width, appends a padding span styled with the given `Style` if needed, patches the line style and each span style with the background style, and returns the modified `Line`.

**Call relations**: Called by `apply_session_row_background`.

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

**Purpose**: Renders a session as a compact single-line summary, optionally followed by expanded transcript preview lines.

**Data flow**: Builds a selection marker, computes relative created/updated times, chooses the active date based on `state.sort_key`, creates one summary line via `dense_summary_line`, and appends transcript preview lines if the row is expanded.

**Call relations**: Used when density is `Dense`; unlike comfortable mode, metadata is compressed into the summary line.

*Call graph*: calls 3 internal fn (format_relative_time, render_transcript_preview_lines, selection_marker); called by 2 (render_session_lines, dense_session_line_prefers_thread_name_over_preview); 1 external calls (vec!).


##### `dense_summary_line`  (lines 2641–2673)

```
fn dense_summary_line(input: DenseSummaryInput<'_>) -> Line<'static>
```

**Purpose**: Formats one dense row with fixed-width date and truncated title columns plus full-width selection/zebra background styling.

**Data flow**: Computes available width after the marker, derives column widths from `dense_columns`, truncates/pads date and title with `dense_column_text`, styles the title if selected, assembles spans, and if selected or zebra, pads to full width and applies the corresponding row style.

**Call relations**: Dense row rendering delegates its main summary line formatting here; tests inspect its width and styling invariants directly.

*Call graph*: calls 5 internal fn (dense_column_text, dense_columns, dense_selected_style, dense_zebra_style, selected_session_title_span); called by 2 (dense_selected_summary_line_uses_full_width_selection_style, dense_zebra_summary_line_uses_full_width_background); 2 external calls (from, vec!).


##### `dense_columns`  (lines 2680–2686)

```
fn dense_columns(width: usize) -> DenseColumns
```

**Purpose**: Computes the fixed date column width and remaining title width for dense rows.

**Data flow**: Uses the constant `SESSION_META_DATE_WIDTH` for the date column and assigns the remaining width to the title column.

**Call relations**: Called only by `dense_summary_line`.

*Call graph*: called by 1 (dense_summary_line).


##### `dense_zebra_style`  (lines 2688–2690)

```
fn dense_zebra_style() -> Style
```

**Purpose**: Returns the background style used for alternating dense rows.

**Data flow**: Delegates to `dense_row_background_style(false)`.

**Call relations**: Used by dense summary rendering and comfortable zebra backgrounds.

*Call graph*: calls 1 internal fn (dense_row_background_style); called by 2 (dense_summary_line, render_comfortable_session_lines).


##### `dense_selected_style`  (lines 2692–2694)

```
fn dense_selected_style() -> Style
```

**Purpose**: Returns the combined foreground/background style for a selected row in dense-style rendering.

**Data flow**: Combines `selected_session_style()` with `dense_row_background_style(true)` using `patch` and returns the result.

**Call relations**: Used by dense summary rendering and comfortable selected-row backgrounds.

*Call graph*: calls 2 internal fn (dense_row_background_style, selected_session_style); called by 2 (dense_summary_line, render_comfortable_session_lines).


##### `dense_row_background_style`  (lines 2696–2706)

```
fn dense_row_background_style(selected: bool) -> Style
```

**Purpose**: Computes a subtle blended background for dense rows, with a stronger overlay when selected.

**Data flow**: Reads the terminal default background; if absent returns default style. Otherwise it chooses black or white overlay plus alpha based on light/dark background and selected state, blends with `blend`, converts via `best_color`, and returns a background-only style.

**Call relations**: This is the shared background-color policy behind zebra and selected row styles.

*Call graph*: calls 4 internal fn (blend, is_light, best_color, default_bg); called by 2 (dense_selected_style, dense_zebra_style); 1 external calls (default).


##### `dense_column_text`  (lines 2708–2712)

```
fn dense_column_text(text: &str, width: usize) -> String
```

**Purpose**: Truncates text to fit a dense column and pads it with spaces to the exact column width.

**Data flow**: Truncates the input string to `width - 1`, measures display width, computes remaining padding, appends spaces, and returns the padded `String`.

**Call relations**: Used by `dense_summary_line` for both date and title columns.

*Call graph*: calls 1 internal fn (truncate_text); called by 1 (dense_summary_line); 2 external calls (width, format!).


##### `selection_marker`  (lines 2714–2720)

```
fn selection_marker(is_selected: bool, is_expanded: bool) -> Span<'static>
```

**Purpose**: Returns the left-edge marker span for selected and expanded rows.

**Data flow**: Matches `(is_selected, is_expanded)` and returns `"⌄ "` for selected+expanded, `"❯ "` for selected+collapsed, or two spaces otherwise, styling selected markers with bold `selected_session_style()`.

**Call relations**: Both comfortable and dense row renderers use this to indicate cursor position and expansion state.

*Call graph*: calls 1 internal fn (selected_session_style); called by 4 (render_comfortable_session_lines, render_dense_session_lines, dense_selected_summary_line_uses_full_width_selection_style, dense_zebra_summary_line_uses_full_width_background).


##### `selected_session_style`  (lines 2722–2728)

```
fn selected_session_style() -> Style
```

**Purpose**: Returns the foreground color used to highlight selected rows and markers.

**Data flow**: Checks whether the terminal background is light; returns magenta on light backgrounds and yellow otherwise.

**Call relations**: Used by selection markers, selected titles, and dense selected row styling.

*Call graph*: calls 1 internal fn (default_bg); called by 3 (dense_selected_style, selected_session_title_span, selection_marker); 1 external calls (default).


##### `selected_session_title_span`  (lines 2730–2732)

```
fn selected_session_title_span(title: String) -> Span<'static>
```

**Purpose**: Wraps a selected row title string in the standard selected-session style.

**Data flow**: Applies `selected_session_style()` to the provided `String` and returns a styled `Span`.

**Call relations**: Used by both comfortable and dense row renderers for selected titles.

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

**Purpose**: Builds the metadata footer lines shown under comfortable rows, ordering date, cwd, and branch according to current sort/filter context.

**Data flow**: Chooses the active date string from `sort_key`, creates a `Vec<FooterPart>` starting with date, conditionally includes cwd when `show_cwd` is true, always includes branch, and passes the parts to `pack_footer_parts`.

**Call relations**: Comfortable row rendering uses this to produce responsive metadata lines.

*Call graph*: calls 1 internal fn (pack_footer_parts); called by 6 (render_comfortable_session_lines, footer_branch_expands_when_line_has_room, footer_cwd_truncates_to_responsive_column, footer_marks_missing_branch, footer_omits_cwd_when_hidden, footer_prioritizes_active_sort_timestamp); 3 external calls (Branch, Cwd, vec!).


##### `FooterPart::text`  (lines 2762–2769)

```
fn text(&self) -> &str
```

**Purpose**: Returns the display text for a footer metadata part, including placeholders for missing branch/cwd.

**Data flow**: Matches the enum variant and returns the stored string or fallback text `no branch` / `no cwd`.

**Call relations**: Width calculation and footer rendering use this to measure and emit metadata consistently.

*Call graph*: called by 2 (footer_part_width, push_footer_part).


##### `FooterPart::prefix`  (lines 2771–2777)

```
fn prefix(&self) -> Option<&'static str>
```

**Purpose**: Returns the icon prefix associated with a footer metadata part, if any.

**Data flow**: Returns `None` for dates, the branch icon for branch parts, and the cwd icon for cwd parts.

**Call relations**: Footer width calculation and rendering use this to account for icons.

*Call graph*: called by 2 (footer_part_width, push_footer_part).


##### `pack_footer_parts`  (lines 2780–2810)

```
fn pack_footer_parts(parts: Vec<FooterPart>, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Packs footer metadata parts into one or more lines depending on available width.

**Data flow**: Computes available width and cwd column width, measures whether all parts fit on one line, and if not, incrementally groups parts into multiple lines without overflowing, rendering each group via `footer_line`.

**Call relations**: Called by `render_footer_lines`; it is the main responsive layout algorithm for comfortable-row metadata.

*Call graph*: calls 3 internal fn (cwd_column_width, footer_line, footer_parts_width); called by 1 (render_footer_lines); 4 external calls (new, with_capacity, take, vec!).


##### `cwd_column_width`  (lines 2812–2817)

```
fn cwd_column_width(width: usize) -> usize
```

**Purpose**: Computes the target width for the cwd metadata column within a footer line.

**Data flow**: Subtracts indent, date width, and field gaps from total width, halves the remainder, and clamps it between configured min and max cwd widths.

**Call relations**: Used by footer packing and width measurement so cwd truncation is responsive but bounded.

*Call graph*: called by 1 (pack_footer_parts).


##### `footer_parts_width`  (lines 2819–2826)

```
fn footer_parts_width(parts: &[FooterPart], cwd_width: usize) -> usize
```

**Purpose**: Measures the total width of a set of footer parts including indent.

**Data flow**: Sums `footer_part_width` for each part, passing whether the part is padded and the cwd column width, then adds the fixed indent width.

**Call relations**: Used by `pack_footer_parts` to decide whether parts fit on one line or need wrapping.

*Call graph*: called by 1 (pack_footer_parts); 1 external calls (iter).


##### `footer_part_width`  (lines 2828–2838)

```
fn footer_part_width(part: &FooterPart, padded: bool, cwd_width: usize) -> usize
```

**Purpose**: Measures the rendered width of one footer part, accounting for icon, gap, text, and optional padded columns.

**Data flow**: Reads the part’s prefix and text widths, computes actual width, and for padded date/cwd columns returns the target padded width instead of the raw width.

**Call relations**: Called by `footer_parts_width` during footer layout decisions.

*Call graph*: calls 2 internal fn (prefix, text); 2 external calls (width, from).


##### `footer_line`  (lines 2840–2869)

```
fn footer_line(parts: Vec<FooterPart>, width: usize, cwd_width: usize) -> Line<'static>
```

**Purpose**: Renders one line of footer metadata parts with indent, gaps, truncation, and optional column padding.

**Data flow**: Starts with a two-space indent, tracks remaining width, inserts field gaps between parts, determines target widths for padded date/cwd columns, delegates actual rendering to `push_footer_part`, and appends dim padding spans when a padded column used less than its target width.

**Call relations**: Used by `pack_footer_parts` to materialize each packed footer line.

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

**Purpose**: Appends one footer metadata part into a span buffer, truncating to available width and styling missing values distinctly.

**Data flow**: Extracts the part text and optional prefix. Prefixless date text is truncated directly and dimmed. Prefixed parts render the icon, optional space, then truncated text sized to either the target width or remaining width. Missing branch/cwd values are dim italicized. It returns the width consumed.

**Call relations**: Called by `footer_line` for each metadata part.

*Call graph*: calls 3 internal fn (prefix, text, truncate_text); called by 1 (footer_line); 1 external calls (width).


##### `render_transcript_preview_lines`  (lines 2912–2939)

```
fn render_transcript_preview_lines(
    row: &Row,
    state: &PickerState,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Builds the expanded-row body consisting of session details plus transcript preview/loading/error lines.

**Data flow**: Starts with `render_expanded_session_details`, then if the row has a `thread_id`, looks up preview state in `state.transcript_previews` and appends either a loading line, failure line, rendered conversation preview lines, or nothing.

**Call relations**: Both comfortable and dense row renderers call this when the selected row is expanded.

*Call graph*: calls 2 internal fn (render_conversation_preview_lines, render_expanded_session_details); called by 2 (render_comfortable_session_lines, render_dense_session_lines); 2 external calls (new, vec!).


##### `render_expanded_session_details`  (lines 2941–2978)

```
fn render_expanded_session_details(
    row: &Row,
    state: &PickerState,
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Renders the fixed metadata block shown at the top of an expanded session row.

**Data flow**: Builds a session label from thread name and/or thread ID, formats directory and branch strings with placeholders when absent, computes relative/absolute created and updated timestamps, and returns a vector of detail lines plus a `Conversation:` header.

**Call relations**: Used as the first section of expanded-row rendering before transcript preview content.

*Call graph*: called by 2 (render_transcript_preview_lines, expanded_session_details_include_metadata); 2 external calls (format!, vec!).


##### `render_conversation_preview_lines`  (lines 2980–3011)

```
fn render_conversation_preview_lines(
    lines: &[TranscriptPreviewLine],
    width: u16,
) -> Vec<Line<'static>>
```

**Purpose**: Renders transcript preview lines with tree-like connector prefixes and an empty-preview fallback.

**Data flow**: If the input slice is empty, returns a single `No transcript preview available` line. Otherwise it expands each preview line through `render_transcript_content_lines`, then prefixes each rendered line with `│` or `└` depending on whether it is the last line.

**Call relations**: Called by `render_transcript_preview_lines` when preview data has loaded.

*Call graph*: calls 1 internal fn (render_transcript_content_lines); called by 1 (render_transcript_preview_lines); 3 external calls (new, is_empty, vec!).


##### `render_transcript_content_lines`  (lines 3013–3032)

```
fn render_transcript_content_lines(line: &TranscriptPreviewLine, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Converts one preview item into styled and wrapped display lines, treating user text and assistant markdown differently.

**Data flow**: Computes content width as `width - 4`. For user lines it wraps the raw text in a styled `Line`; for assistant lines it parses markdown into lines with `append_markdown` and patches each line with assistant style. It then wraps the resulting lines with `adaptive_wrap_lines` and returns them.

**Call relations**: Conversation preview rendering calls this for each preview item before adding connector prefixes.

*Call graph*: calls 5 internal fn (append_markdown, conversation_assistant_style, conversation_content_line, new, adaptive_wrap_lines); called by 1 (render_conversation_preview_lines); 3 external calls (new, clone, vec!).


##### `conversation_content_line`  (lines 3034–3040)

```
fn conversation_content_line(mut line: Line<'static>, style: Style) -> Line<'static>
```

**Purpose**: Applies a conversation-specific style to a line and all of its spans.

**Data flow**: Patches the line style and each span style with the supplied `Style`, then returns the modified line.

**Call relations**: Used by transcript content rendering for both user and assistant preview lines.

*Call graph*: called by 1 (render_transcript_content_lines).


##### `prefix_transcript_line`  (lines 3042–3046)

```
fn prefix_transcript_line(prefix: &'static str, line: Line<'static>) -> Line<'static>
```

**Purpose**: Prepends a connector prefix to a transcript preview line while matching the prefix color to the line’s content style.

**Data flow**: Computes a prefix style with `transcript_prefix_style`, creates a prefix span, prepends it to the line’s spans, and returns a new `Line` carrying the original line style.

**Call relations**: Used by `render_conversation_preview_lines` after content lines have been generated.

*Call graph*: 2 external calls (from, vec!).


##### `transcript_prefix_style`  (lines 3048–3056)

```
fn transcript_prefix_style(line: &Line<'_>) -> Style
```

**Purpose**: Derives connector styling from the first non-empty content span in a transcript line.

**Data flow**: Finds the first non-whitespace span, patches it with the line style, then strips the result down to foreground/background via `connector_style_from_content`; if no non-empty span exists, it uses the line style directly.

**Call relations**: Called by `prefix_transcript_line` so tree connectors visually match the associated content.

*Call graph*: calls 1 internal fn (connector_style_from_content).


##### `connector_style_from_content`  (lines 3058–3064)

```
fn connector_style_from_content(style: Style) -> Style
```

**Purpose**: Reduces a full content style to just foreground/background for connector glyphs.

**Data flow**: Builds a new `Style` carrying only `fg` and `bg` from the input style and defaulting all other attributes.

**Call relations**: Used only by `transcript_prefix_style`.

*Call graph*: called by 1 (transcript_prefix_style); 1 external calls (default).


##### `conversation_assistant_style`  (lines 3066–3072)

```
fn conversation_assistant_style() -> Style
```

**Purpose**: Returns the style used for assistant transcript preview content.

**Data flow**: Chooses gray on light backgrounds and dark gray on dark backgrounds.

**Call relations**: Assistant preview rendering uses this before wrapping markdown lines.

*Call graph*: calls 1 internal fn (default_bg); called by 1 (render_transcript_content_lines); 1 external calls (default).


##### `conversation_user_style`  (lines 3074–3080)

```
fn conversation_user_style() -> Style
```

**Purpose**: Returns the style used for user transcript preview content.

**Data flow**: Chooses italic dark gray on light backgrounds and italic gray on dark backgrounds.

**Call relations**: User preview rendering uses this for plain-text user messages.

*Call graph*: calls 1 internal fn (default_bg); 1 external calls (default).


##### `expanded_detail_line`  (lines 3082–3096)

```
fn expanded_detail_line(label: &'static str, value: &str, width: u16) -> Line<'static>
```

**Purpose**: Formats one labeled metadata line in the expanded-row details block.

**Data flow**: Uses fixed widths for the tree prefix, label column, and gap, computes remaining width for the value, truncates the value to fit, and returns a line containing dim prefix/label plus the value.

**Call relations**: Used by `render_expanded_session_details` and `expanded_time_detail_line`.

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

**Purpose**: Formats an expanded metadata line for a timestamp, combining relative and absolute time when present.

**Data flow**: If the timestamp is absent it delegates to `expanded_detail_line(label, "-")`; otherwise it builds `"{relative} · {absolute}"` using `format_relative_time_long` and `format_timestamp`, then delegates to `expanded_detail_line`.

**Call relations**: Used by `render_expanded_session_details` for created and updated timestamps.

*Call graph*: calls 1 internal fn (expanded_detail_line); 1 external calls (format!).


##### `format_relative_time`  (lines 3115–3136)

```
fn format_relative_time(reference: DateTime<Utc>, ts: Option<DateTime<Utc>>) -> String
```

**Purpose**: Formats a timestamp as a short relative age such as `now`, `42s ago`, `5m ago`, `3h ago`, or `2d ago`.

**Data flow**: If the timestamp is absent it returns `"-"`. Otherwise it computes non-negative elapsed seconds from the reference time and formats the largest suitable unit among seconds, minutes, hours, and days.

**Call relations**: Used in row summaries and metadata footers where compact time labels are needed.

*Call graph*: called by 2 (render_comfortable_session_lines, render_dense_session_lines); 1 external calls (format!).


##### `format_relative_time_long`  (lines 3138–3155)

```
fn format_relative_time_long(reference: DateTime<Utc>, ts: DateTime<Utc>) -> String
```

**Purpose**: Formats a timestamp as a wordier relative age such as `20 minutes ago` or `1 hour ago`.

**Data flow**: Computes non-negative elapsed seconds from the reference time and returns `now` or delegates to `plural_time` for seconds, minutes, hours, or days.

**Call relations**: Expanded metadata details use this longer form before appending the absolute timestamp.

*Call graph*: calls 1 internal fn (plural_time).


##### `plural_time`  (lines 3157–3163)

```
fn plural_time(value: i64, unit: &str) -> String
```

**Purpose**: Formats a singular or plural relative-time phrase for a numeric value and unit.

**Data flow**: If `value == 1`, returns `"1 {unit} ago"`; otherwise returns `"{value} {unit}s ago"`.

**Call relations**: Used only by `format_relative_time_long`.

*Call graph*: called by 1 (format_relative_time_long); 1 external calls (format!).


##### `format_timestamp`  (lines 3165–3167)

```
fn format_timestamp(ts: DateTime<Utc>) -> String
```

**Purpose**: Formats a UTC timestamp in a fixed `YYYY-MM-DD HH:MM:SS` form.

**Data flow**: Calls `ts.format("%Y-%m-%d %H:%M:%S")` and converts the result to `String`.

**Call relations**: Expanded timestamp detail lines append this absolute representation after the relative age.

*Call graph*: 1 external calls (format).


##### `render_empty_state_line`  (lines 3169–3194)

```
fn render_empty_state_line(state: &PickerState) -> Line<'static>
```

**Purpose**: Chooses the appropriate empty/list-status message for the list area based on search and loading state.

**Data flow**: Reads `query`, `search_state`, pagination loading state, scan-cap state, `all_rows`, and `num_scanned_files`; returns dim italic lines such as `Searching…`, `Search scanned first N sessions; more may exist`, `No results for your search`, `Loading sessions…`, `Loading older sessions…`, or `No sessions yet`.

**Call relations**: Called by `render_list` when `filtered_rows` is empty.

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


##### `tests::page_only_loader`  (lines 3231–3237)

```
fn page_only_loader(loader: impl Fn(PageLoadRequest) + Send + Sync + 'static) -> PickerLoader
```

*Call graph*: 1 external calls (new).


##### `tests::make_row`  (lines 3239–3251)

```
fn make_row(path: &str, ts: &str, preview: &str) -> Row
```

*Call graph*: calls 1 internal fn (parse_timestamp_str); 1 external calls (from).


##### `tests::footer_lines_text`  (lines 3253–3259)

```
fn footer_lines_text(state: &PickerState, width: u16) -> String
```

*Call graph*: calls 1 internal fn (footer_hint_lines).


##### `tests::footer_snapshot`  (lines 3261–3283)

```
fn footer_snapshot(state: &PickerState, width: u16, list_height: u16) -> String
```

*Call graph*: calls 3 internal fn (with_options, render_picker_footer, new); 1 external calls (new).


##### `tests::row_display_preview_prefers_thread_name`  (lines 3286–3299)

```
fn row_display_preview_prefers_thread_name()
```

*Call graph*: 3 external calls (from, from, assert_eq!).


##### `tests::local_picker_thread_list_params_include_cwd_filter`  (lines 3302–3321)

```
fn local_picker_thread_list_params_include_cwd_filter()
```

*Call graph*: calls 2 internal fn (picker_cwd_filter, thread_list_params); 4 external calls (new, from, assert_eq!, MatchDefault).


##### `tests::row_search_matches_metadata_fields`  (lines 3324–3341)

```
fn row_search_matches_metadata_fields()
```

*Call graph*: calls 1 internal fn (from_string); 3 external calls (from, from, assert!).


##### `tests::relative_time_formats_zero_seconds_as_now`  (lines 3344–3354)

```
fn relative_time_formats_zero_seconds_as_now()
```

*Call graph*: 2 external calls (parse_from_rfc3339, assert_eq!).


##### `tests::long_relative_time_uses_words`  (lines 3357–3371)

```
fn long_relative_time_uses_words()
```

*Call graph*: 2 external calls (parse_from_rfc3339, assert_eq!).


##### `tests::expanded_session_details_include_metadata`  (lines 3374–3414)

```
fn expanded_session_details_include_metadata()
```

*Call graph*: calls 5 internal fn (from_string, new, parse_timestamp_str, render_expanded_session_details, test_dummy); 6 external calls (from, from, assert!, format_directory_display, MatchDefault, page_only_loader).


##### `tests::footer_prioritizes_active_sort_timestamp`  (lines 3417–3445)

```
fn footer_prioritizes_active_sort_timestamp()
```

*Call graph*: calls 1 internal fn (render_footer_lines); 3 external calls (assert!, assert_eq!, assert_metadata_order).


##### `tests::footer_marks_missing_branch`  (lines 3448–3464)

```
fn footer_marks_missing_branch()
```

*Call graph*: calls 1 internal fn (render_footer_lines); 3 external calls (assert!, assert_eq!, assert_metadata_order).


##### `tests::footer_branch_expands_when_line_has_room`  (lines 3467–3481)

```
fn footer_branch_expands_when_line_has_room()
```

*Call graph*: calls 1 internal fn (render_footer_lines); 2 external calls (assert!, assert_eq!).


##### `tests::footer_cwd_truncates_to_responsive_column`  (lines 3484–3503)

```
fn footer_cwd_truncates_to_responsive_column()
```

*Call graph*: calls 1 internal fn (render_footer_lines); 2 external calls (assert!, assert_eq!).


##### `tests::footer_omits_cwd_when_hidden`  (lines 3506–3523)

```
fn footer_omits_cwd_when_hidden()
```

*Call graph*: calls 1 internal fn (render_footer_lines); 2 external calls (assert!, assert_eq!).


##### `tests::assert_metadata_order`  (lines 3525–3530)

```
fn assert_metadata_order(line: &Line<'_>, first: &str, second: &str)
```

*Call graph*: 2 external calls (to_string, assert!).


##### `tests::remote_thread_list_params_omit_provider_filter`  (lines 3533–3552)

```
fn remote_thread_list_params_omit_provider_filter()
```

*Call graph*: calls 1 internal fn (thread_list_params); 3 external calls (new, from, assert_eq!).


##### `tests::remote_thread_list_params_can_include_non_interactive_sources`  (lines 3555–3568)

```
fn remote_thread_list_params_can_include_non_interactive_sources()
```

*Call graph*: calls 1 internal fn (thread_list_params); 3 external calls (from, assert_eq!, resume_source_kinds).


##### `tests::remote_picker_sends_cwd_filter_without_local_post_filtering`  (lines 3571–3609)

```
fn remote_picker_sends_cwd_filter_without_local_post_filtering()
```

*Call graph*: calls 4 internal fn (new, new, local_picker_cwd_filter, test_dummy); 8 external calls (new, new, from, from, new, assert!, assert_eq!, page_only_loader).


##### `tests::remote_picker_does_not_filter_rows_by_local_cwd`  (lines 3612–3634)

```
fn remote_picker_does_not_filter_rows_by_local_cwd()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 4 external calls (from, from, assert!, page_only_loader).


##### `tests::resume_table_snapshot`  (lines 3637–3706)

```
fn resume_table_snapshot()
```

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 6 external calls (new, from, assert_snapshot!, MatchDefault, page_only_loader, vec!).


##### `tests::resume_search_error_snapshot`  (lines 3709–3741)

```
fn resume_search_error_snapshot()
```

*Call graph*: calls 5 internal fn (with_options, new, search_line, new, test_dummy); 5 external calls (new, from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::hint_line_switches_esc_label_for_search_mode`  (lines 3744–3760)

```
fn hint_line_switches_esc_label_for_search_mode()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert!, MatchDefault, page_only_loader).


##### `tests::hint_line_labels_cancel_keys_as_exit_for_existing_session_resume_picker`  (lines 3763–3786)

```
fn hint_line_labels_cancel_keys_as_exit_for_existing_session_resume_picker()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (from, assert!, MatchDefault, footer_lines_text, page_only_loader).


##### `tests::hint_line_switches_density_label`  (lines 3789–3807)

```
fn hint_line_switches_density_label()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert!, MatchDefault, page_only_loader).


##### `tests::hint_line_compacts_on_narrow_width`  (lines 3810–3830)

```
fn hint_line_compacts_on_narrow_width()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (from, assert!, MatchDefault, footer_lines_text, page_only_loader).


##### `tests::hint_line_snapshot_uses_distributed_wide_footer`  (lines 3833–3848)

```
fn hint_line_snapshot_uses_distributed_wide_footer()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::hint_line_snapshot_uses_compact_footer`  (lines 3851–3868)

```
fn hint_line_snapshot_uses_compact_footer()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::hint_line_prioritizes_keybinds_when_very_narrow`  (lines 3871–3899)

```
fn hint_line_prioritizes_keybinds_when_very_narrow()
```

*Call graph*: calls 3 internal fn (new, footer_hint_lines, test_dummy); 4 external calls (from, assert!, MatchDefault, page_only_loader).


##### `tests::hint_line_shows_loading_transcript_mode`  (lines 3902–3919)

```
fn hint_line_shows_loading_transcript_mode()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 5 external calls (from, assert!, MatchDefault, footer_lines_text, page_only_loader).


##### `tests::picker_footer_percent_reports_scroll_progress`  (lines 3922–3947)

```
fn picker_footer_percent_reports_scroll_progress()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::picker_footer_progress_label_shows_position_total_and_percent`  (lines 3950–3975)

```
fn picker_footer_progress_label_shows_position_total_and_percent()
```

*Call graph*: calls 3 internal fn (new, picker_footer_progress_label, test_dummy); 5 external calls (from, assert!, assert_eq!, MatchDefault, page_only_loader).


##### `tests::picker_footer_progress_label_uses_known_count_when_more_pages_exist`  (lines 3978–4003)

```
fn picker_footer_progress_label_uses_known_count_when_more_pages_exist()
```

*Call graph*: calls 3 internal fn (new, picker_footer_progress_label, test_dummy); 5 external calls (from, assert_eq!, AppServer, MatchDefault, page_only_loader).


##### `tests::picker_footer_progress_label_freezes_percent_while_loading`  (lines 4006–4037)

```
fn picker_footer_progress_label_freezes_percent_while_loading()
```

*Call graph*: calls 3 internal fn (new, picker_footer_progress_label, test_dummy); 6 external calls (from, assert_eq!, Pending, AppServer, MatchDefault, page_only_loader).


##### `tests::picker_footer_percent_is_complete_when_not_scrollable`  (lines 4040–4059)

```
fn picker_footer_percent_is_complete_when_not_scrollable()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (from, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::ctrl_o_toggles_density_without_typing_into_search`  (lines 4062–4081)

```
async fn ctrl_o_toggles_density_without_typing_into_search()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::ctrl_t_requests_selected_session_transcript`  (lines 4084–4124)

```
async fn ctrl_t_requests_selected_session_transcript()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 10 external calls (new, Char, new, new, from, new, assert!, assert_eq!, MatchDefault, vec!).


##### `tests::transcript_loading_consumes_picker_input`  (lines 4127–4178)

```
async fn transcript_loading_consumes_picker_input()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 8 external calls (Char, new, from, assert!, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::transcript_loading_still_allows_ctrl_c_exit`  (lines 4181–4199)

```
async fn transcript_loading_still_allows_ctrl_c_exit()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 6 external calls (Char, new, from, assert!, MatchDefault, page_only_loader).


##### `tests::transcript_loading_overlay_snapshot`  (lines 4202–4263)

```
fn transcript_loading_overlay_snapshot()
```

*Call graph*: calls 7 internal fn (new, with_options, new, render_list, render_transcript_loading_overlay, new, test_dummy); 6 external calls (new, from, assert_snapshot!, MatchDefault, page_only_loader, vec!).


##### `tests::raw_ctrl_t_requests_selected_session_transcript`  (lines 4266–4300)

```
async fn raw_ctrl_t_requests_selected_session_transcript()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 9 external calls (new, Char, new, new, from, new, assert_eq!, MatchDefault, vec!).


##### `tests::ctrl_t_on_row_without_thread_id_shows_inline_error`  (lines 4303–4333)

```
async fn ctrl_t_on_row_without_thread_id_shows_inline_error()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 7 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::loaded_transcript_waits_for_loading_frame_before_opening_overlay`  (lines 4336–4373)

```
async fn loaded_transcript_waits_for_loading_frame_before_opening_overlay()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 6 external calls (from, assert!, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::cached_transcript_still_shows_loading_frame_before_opening_overlay`  (lines 4376–4419)

```
async fn cached_transcript_still_shows_loading_frame_before_opening_overlay()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 9 external calls (Char, new, from, assert!, assert_eq!, MatchDefault, Loaded, page_only_loader, vec!).


##### `tests::ctrl_o_persists_density_preference`  (lines 4422–4451)

```
async fn ctrl_o_persists_density_preference()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 8 external calls (Char, new, from, assert_eq!, read_to_string, tempdir, MatchDefault, page_only_loader).


##### `tests::ctrl_o_keeps_toggled_density_when_persistence_fails`  (lines 4454–4485)

```
async fn ctrl_o_keeps_toggled_density_when_persistence_fails()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (Char, new, from, assert!, assert_eq!, write, tempdir, MatchDefault, page_only_loader).


##### `tests::raw_ctrl_o_toggles_density_without_typing_into_search`  (lines 4488–4507)

```
async fn raw_ctrl_o_toggles_density_without_typing_into_search()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::space_appends_to_search_query`  (lines 4510–4533)

```
async fn space_appends_to_search_query()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::ctrl_e_toggles_selected_session_expansion`  (lines 4536–4578)

```
async fn ctrl_e_toggles_selected_session_expansion()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 9 external calls (new, Char, new, new, from, new, assert_eq!, MatchDefault, vec!).


##### `tests::raw_ctrl_e_toggles_selected_session_expansion`  (lines 4581–4609)

```
async fn raw_ctrl_e_toggles_selected_session_expansion()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 7 external calls (Char, new, from, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::search_line_renders_sort_and_filter_tabs`  (lines 4612–4642)

```
fn search_line_renders_sort_and_filter_tabs()
```

*Call graph*: calls 5 internal fn (with_options, new, search_line, new, test_dummy); 6 external calls (from, new, from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::search_line_compacts_toolbar_on_narrow_width`  (lines 4645–4661)

```
fn search_line_compacts_toolbar_on_narrow_width()
```

*Call graph*: calls 3 internal fn (new, search_line, test_dummy); 5 external calls (from, from, assert!, MatchDefault, page_only_loader).


##### `tests::dense_snapshot_row`  (lines 4663–4680)

```
fn dense_snapshot_row() -> Row
```

*Call graph*: calls 2 internal fn (from_string, parse_timestamp_str); 2 external calls (from, from).


##### `tests::render_dense_row_snapshot`  (lines 4682–4718)

```
fn render_dense_row_snapshot(
        show_all: bool,
        filter_cwd: Option<PathBuf>,
        width: u16,
    ) -> String
```

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 6 external calls (new, from, MatchDefault, dense_snapshot_row, page_only_loader, vec!).


##### `tests::dense_session_snapshot_omits_cwd_in_cwd_filter`  (lines 4721–4732)

```
fn dense_session_snapshot_omits_cwd_in_cwd_filter()
```

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_snapshot_includes_cwd_in_all_filter`  (lines 4735–4742)

```
fn dense_session_snapshot_includes_cwd_in_all_filter()
```

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_snapshot_auto_hides_cwd_when_narrow`  (lines 4745–4752)

```
fn dense_session_snapshot_auto_hides_cwd_when_narrow()
```

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_snapshot_forces_cwd_when_narrow`  (lines 4755–4762)

```
fn dense_session_snapshot_forces_cwd_when_narrow()
```

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_snapshot_drops_metadata_when_narrow`  (lines 4765–4772)

```
fn dense_session_snapshot_drops_metadata_when_narrow()
```

*Call graph*: 1 external calls (assert_snapshot!).


##### `tests::dense_session_line_prefers_thread_name_over_preview`  (lines 4775–4803)

```
fn dense_session_line_prefers_thread_name_over_preview()
```

*Call graph*: calls 4 internal fn (new, parse_timestamp_str, render_dense_session_lines, test_dummy); 5 external calls (from, assert!, MatchDefault, dense_snapshot_row, page_only_loader).


##### `tests::dense_selected_summary_line_uses_full_width_selection_style`  (lines 4806–4819)

```
fn dense_selected_summary_line_uses_full_width_selection_style()
```

*Call graph*: calls 2 internal fn (dense_summary_line, selection_marker); 1 external calls (assert_eq!).


##### `tests::dense_zebra_summary_line_uses_full_width_background`  (lines 4822–4834)

```
fn dense_zebra_summary_line_uses_full_width_background()
```

*Call graph*: calls 2 internal fn (dense_summary_line, selection_marker); 1 external calls (assert_eq!).


##### `tests::comfortable_zebra_lines_use_full_width_background`  (lines 4837–4867)

```
fn comfortable_zebra_lines_use_full_width_background()
```

*Call graph*: calls 4 internal fn (new, parse_timestamp_str, render_comfortable_session_lines, test_dummy); 6 external calls (from, assert!, assert_eq!, MatchDefault, make_row, page_only_loader).


##### `tests::dense_session_snapshot_uses_no_blank_lines_between_rows`  (lines 4870–4912)

```
fn dense_session_snapshot_uses_no_blank_lines_between_rows()
```

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 8 external calls (from, new, from, assert_snapshot!, MatchDefault, dense_snapshot_row, page_only_loader, vec!).


##### `tests::expanded_session_snapshot`  (lines 4915–4981)

```
fn expanded_session_snapshot()
```

*Call graph*: calls 7 internal fn (from_string, with_options, new, parse_timestamp_str, render_list, new, test_dummy); 8 external calls (from, new, from, assert_snapshot!, MatchDefault, Loaded, page_only_loader, vec!).


##### `tests::narrow_session_snapshot`  (lines 4984–5031)

```
fn narrow_session_snapshot()
```

*Call graph*: calls 7 internal fn (from_string, with_options, new, parse_timestamp_str, render_list, new, test_dummy); 7 external calls (from, new, from, assert_snapshot!, MatchDefault, page_only_loader, vec!).


##### `tests::session_list_more_indicators_snapshot`  (lines 5034–5083)

```
fn session_list_more_indicators_snapshot()
```

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 5 external calls (new, from, assert_snapshot!, MatchDefault, page_only_loader).


##### `tests::density_toggle_clears_stale_more_indicator`  (lines 5086–5140)

```
fn density_toggle_clears_stale_more_indicator()
```

*Call graph*: calls 6 internal fn (with_options, new, parse_timestamp_str, render_list, new, test_dummy); 5 external calls (new, from, assert!, MatchDefault, page_only_loader).


##### `tests::pageless_scrolling_deduplicates_and_keeps_order`  (lines 5143–5195)

```
fn pageless_scrolling_deduplicates_and_keeps_order()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (from, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::ensure_minimum_rows_prefetches_when_underfilled`  (lines 5198–5229)

```
fn ensure_minimum_rows_prefetches_when_underfilled()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::ensure_minimum_rows_does_not_prefetch_when_comfortable_cards_fill_view`  (lines 5232–5264)

```
fn ensure_minimum_rows_does_not_prefetch_when_comfortable_cards_fill_view()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, new, from, new, assert!, MatchDefault, page, page_only_loader, vec!).


##### `tests::ensure_minimum_rows_still_prefetches_when_dense_rows_underfill_view`  (lines 5267–5300)

```
fn ensure_minimum_rows_still_prefetches_when_dense_rows_underfill_view()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::list_viewport_width_matches_rendered_list_inset`  (lines 5303–5306)

```
fn list_viewport_width_matches_rendered_list_inset()
```

*Call graph*: 1 external calls (assert_eq!).


##### `tests::toggle_sort_key_reloads_with_new_sort`  (lines 5309–5344)

```
async fn toggle_sort_key_reloads_with_new_sort()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, Char, new, new, from, new, assert_eq!, MatchDefault, page_only_loader).


##### `tests::default_filter_focus_arrows_reload_with_new_filter`  (lines 5347–5378)

```
async fn default_filter_focus_arrows_reload_with_new_filter()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, new, new, from, from, new, assert_eq!, MatchDefault, page_only_loader).


##### `tests::all_filter_can_switch_back_to_cwd_when_cwd_candidate_exists`  (lines 5381–5412)

```
async fn all_filter_can_switch_back_to_cwd_when_cwd_candidate_exists()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, new, new, from, from, new, assert_eq!, MatchDefault, page_only_loader).


##### `tests::filter_stays_all_when_no_cwd_candidate_exists`  (lines 5415–5448)

```
async fn filter_stays_all_when_no_cwd_candidate_exists()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 6 external calls (new, new, new, new, assert_eq!, page_only_loader).


##### `tests::page_navigation_uses_view_rows`  (lines 5451–5507)

```
async fn page_navigation_uses_view_rows()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::page_and_jump_navigation_use_list_keymap`  (lines 5510–5569)

```
async fn page_and_jump_navigation_use_list_keymap()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 11 external calls (Char, new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader (+1 more)).


##### `tests::ctrl_c_exits_even_when_cancel_is_remapped_to_ctrl_c`  (lines 5572–5590)

```
async fn ctrl_c_exits_even_when_cancel_is_remapped_to_ctrl_c()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 7 external calls (Char, new, from, assert!, MatchDefault, page_only_loader, vec!).


##### `tests::end_jumps_to_last_known_row_and_starts_loading_more`  (lines 5593–5638)

```
async fn end_jumps_to_last_known_row_and_starts_loading_more()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader).


##### `tests::enter_on_row_without_resolvable_thread_id_shows_inline_error`  (lines 5641–5677)

```
async fn enter_on_row_without_resolvable_thread_id_shows_inline_error()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 8 external calls (new, from, from, assert!, assert_eq!, MatchDefault, page_only_loader, vec!).


##### `tests::enter_on_pathless_thread_uses_thread_id`  (lines 5680–5716)

```
async fn enter_on_pathless_thread_uses_thread_id()
```

*Call graph*: calls 3 internal fn (new, new, test_dummy); 7 external calls (new, from, assert_eq!, panic!, MatchDefault, page_only_loader, vec!).


##### `tests::app_server_row_keeps_pathless_threads`  (lines 5719–5749)

```
fn app_server_row_keeps_pathless_threads()
```

*Call graph*: calls 2 internal fn (new, row_from_app_server_thread); 4 external calls (from, new, assert_eq!, test_path_buf).


##### `tests::thread_to_transcript_cells_renders_core_message_types`  (lines 5752–5818)

```
fn thread_to_transcript_cells_renders_core_message_types()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert!, test_path_buf, vec!).


##### `tests::thread_to_transcript_cells_hides_raw_reasoning_when_not_enabled`  (lines 5821–5876)

```
fn thread_to_transcript_cells_hides_raw_reasoning_when_not_enabled()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert!, test_path_buf, vec!).


##### `tests::thread_to_transcript_cells_shows_raw_reasoning_over_summary_when_enabled`  (lines 5879–5928)

```
fn thread_to_transcript_cells_shows_raw_reasoning_over_summary_when_enabled()
```

*Call graph*: calls 1 internal fn (new); 4 external calls (from, assert!, test_path_buf, vec!).


##### `tests::moving_to_last_card_scrolls_when_cards_exceed_viewport`  (lines 5931–5970)

```
async fn moving_to_last_card_scrolls_when_cards_exceed_viewport()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::up_from_bottom_keeps_viewport_stable_when_card_remains_visible`  (lines 5973–6012)

```
async fn up_from_bottom_keeps_viewport_stable_when_card_remains_visible()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::up_scrolls_only_after_crossing_top_edge`  (lines 6015–6050)

```
async fn up_scrolls_only_after_crossing_top_edge()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 9 external calls (new, from, new, assert_eq!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::list_reports_more_rows_above_and_below`  (lines 6053–6086)

```
fn list_reports_more_rows_above_and_below()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 8 external calls (from, new, assert!, format!, MatchDefault, make_row, page, page_only_loader).


##### `tests::set_query_loads_until_match_and_respects_scan_cap`  (lines 6089–6207)

```
async fn set_query_loads_until_match_and_respects_scan_cap()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::paste_appends_to_existing_query`  (lines 6210–6225)

```
async fn paste_appends_to_existing_query()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::whitespace_only_paste_is_ignored`  (lines 6228–6243)

```
async fn whitespace_only_paste_is_ignored()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 4 external calls (from, assert_eq!, MatchDefault, page_only_loader).


##### `tests::paste_uses_existing_search_loading_path`  (lines 6246–6280)

```
async fn paste_uses_existing_search_loading_path()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 10 external calls (new, new, from, new, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


##### `tests::esc_with_empty_query_starts_fresh`  (lines 6283–6300)

```
async fn esc_with_empty_query_starts_fresh()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 5 external calls (new, from, assert!, MatchDefault, page_only_loader).


##### `tests::esc_with_query_clears_search_and_preserves_selected_result`  (lines 6303–6337)

```
async fn esc_with_query_clears_search_and_preserves_selected_result()
```

*Call graph*: calls 2 internal fn (new, test_dummy); 8 external calls (new, from, assert!, assert_eq!, MatchDefault, page, page_only_loader, vec!).


### `tui/src/chatwidget/constructor.rs`

`orchestration` · `startup`

This file contains the `ChatWidget` constructor logic. `new_with_app_event` is a convenience wrapper that selects `CodexOpTarget::AppEvent`, while `new_with_op_target` performs the full initialization. The constructor destructures `ChatWidgetInit`, normalizes the optional model override by dropping blank strings, writes that model back into `config`, and derives several startup decisions: whether idle sleep prevention should be active, random placeholder strings for normal and side conversations, the initial collaboration mask and header model, effective service tier, terminal info, runtime/default keymaps, and the queued-message edit hint binding.

It also kicks off pet loading via `pets::start_configured_pet_load_if_needed` before building the widget. The `Self { ... }` literal initializes a very large amount of state: transcript and bottom pane, auth/account flags, model catalog, telemetry, rate-limit tracking, command execution bookkeeping (`running_commands`, `suppressed_exec_calls`, unified-exec fields), connectors/plugins/IDE caches, hook and review state, thread metadata, placeholders, input queue/edit state, status-line and terminal-title caches, and many optional transient UI fields. Several fields are seeded from helper constructors such as `TranscriptState::new`, `SessionHeader::new`, `TurnLifecycleState::new`, and various `Default` implementations.

After construction, the method performs post-init wiring: prefetch rate limits, install runtime key bindings if available, configure vim mode and status line visibility, enable collaboration modes, sync command availability for service tier/personality/plugins/goals/mentions, set queued-message edit binding, apply a Windows sandbox indicator when relevant, update the collaboration mode indicator, propagate connectors/token-activity capability flags into the bottom pane, and refresh status surfaces.

#### Function details

##### `ChatWidget::new_with_app_event`  (lines 6–8)

```
fn new_with_app_event(common: ChatWidgetInit) -> Self
```

**Purpose**: Creates a `ChatWidget` using the standard app-event operation target. It is a convenience constructor that avoids repeating the common target selection at call sites.

**Data flow**: Consumes `ChatWidgetInit` and forwards it to `Self::new_with_op_target(common, CodexOpTarget::AppEvent)`, returning the constructed widget unchanged.

**Call relations**: This is the simpler public constructor. All real initialization work is delegated to `ChatWidget::new_with_op_target`.

*Call graph*: 1 external calls (new_with_op_target).


##### `ChatWidget::new_with_op_target`  (lines 10–278)

```
fn new_with_op_target(
        common: ChatWidgetInit,
        codex_op_target: CodexOpTarget,
    ) -> Self
```

**Purpose**: Builds and post-configures a complete `ChatWidget` instance from initialization inputs and a chosen `CodexOpTarget`. It computes derived startup values, initializes every major subsystem field, and synchronizes the bottom pane with the resulting capabilities and settings.

**Data flow**: Consumes `ChatWidgetInit` plus `codex_op_target`. It destructures the init bundle, normalizes `model`, mutates `config.model`, computes feature-derived flags and random placeholders, derives collaboration/header/service-tier/keymap state, starts pet loading, and then constructs `Self` with explicit values for all persistent and transient fields. The resulting widget is further mutated by calling methods such as `prefetch_rate_limits`, `bottom_pane.set_keymap_bindings`, `set_vim_enabled`, `set_status_line_enabled`, `set_collaboration_modes_enabled`, `sync_service_tier_commands`, `sync_personality_command_enabled`, `sync_plugins_command_enabled`, `sync_goal_command_enabled`, `sync_mentions_v2_enabled`, `set_queued_message_edit_binding`, optional Windows sandbox setup, `update_collaboration_mode_indicator`, `bottom_pane.set_connectors_enabled`, `bottom_pane.set_token_activity_command_enabled`, and `refresh_status_surfaces`, after which it is returned.

**Call relations**: This is the root assembly function for the widget and is called by `new_with_app_event`. It orchestrates initialization across many subsystems but does not itself implement their domain behavior; instead it wires together helper constructors and post-init synchronization methods.

*Call graph*: calls 10 internal fn (new, new, start_configured_pet_load_if_needed, new, default, new, new, defaults, from_config, effective_service_tier); 24 external calls (new, new, new, now, initial_collaboration_mask, placeholder_session_header_cell, new, new, matches!, default (+14 more)).


### `tui/src/chatwidget/pets.rs`

`orchestration` · `interactive UI rendering and asynchronous asset loading`

This file encapsulates both the always-on ambient pet shown beside chat content and the popup-driven pet picker preview flow. The top-level helpers `load_ambient_pet` and `start_configured_pet_load_if_needed` interpret `config.tui_pet`, treat the special disabled ID as “no pet”, and load pets from `config.codex_home` with the current animation setting. The async helper uses `spawn_pet_load`, which prefers `tokio::spawn_blocking` when a runtime exists and falls back to a plain thread otherwise.

Within `ChatWidget`, ambient-pet methods are mostly thin state adapters: they set pet notifications, answer whether image rendering is enabled, disable the pet for the session, compute reserved wrap columns for history text, and produce draw requests only when no modal or popup is active. The anchor position is derived from `config.tui_pet_anchor`, choosing either the composer baseline or the screen bottom.

The picker flow maintains separate preview state: a request ID to discard stale async results, a preview pet instance, a preview-state object that tracks loading/error/disabled/ready, and a one-shot flag indicating whether the preview image was visible and should be cleared. `open_pets_picker` resets preview state, builds picker params from the pets subsystem, shows the selection view, and immediately starts loading the initially selected pet. `start_pet_picker_preview` increments the request ID, handles the disabled sentinel synchronously, otherwise marks loading and spawns a background load with animations disabled. `finish_pet_picker_preview_load` ignores out-of-date responses and updates preview state accordingly. Test-only helpers let tests force image-support behavior or install a synthetic pet.

#### Function details

##### `load_ambient_pet`  (lines 6–22)

```
fn load_ambient_pet(
    config: &Config,
    frame_requester: FrameRequester,
) -> Option<crate::pets::AmbientPet>
```

**Purpose**: Loads the configured ambient pet immediately from disk/assets if one is selected and not explicitly disabled.

**Data flow**: It takes a `&Config` and `FrameRequester`, reads `config.tui_pet`, returns `None` if unset or equal to `DISABLED_PET_ID`, otherwise calls `crate::pets::AmbientPet::load(Some(selected_pet), &config.codex_home, frame_requester, config.animations)` and converts success to `Some(pet)` and failure to `None` via `.ok()`.

**Call relations**: This helper is used by `ChatWidget::set_tui_pet` to synchronously refresh the ambient pet after the configured pet ID changes.

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

**Purpose**: Starts an asynchronous load of the configured pet when the widget currently lacks an ambient pet but configuration says one should exist.

**Data flow**: It reads `config.tui_pet`, `config.codex_home`, and `config.animations`, plus the `ambient_pet_missing` flag. If no pet is configured, the disabled sentinel is selected, or a pet is already present, it returns early. Otherwise it spawns a background task that ensures the builtin pack exists, loads the pet, maps the result to `Result<Option<AmbientPet>, String>`, and sends `AppEvent::ConfiguredPetLoaded { pet_id, result }`.

**Call relations**: This helper is invoked during widget construction/startup when the UI wants to lazily materialize the configured pet without blocking. It delegates execution to `spawn_pet_load`.

*Call graph*: calls 1 internal fn (spawn_pet_load); called by 1 (new_with_op_target).


##### `ChatWidget::set_ambient_pet_notification`  (lines 56–64)

```
fn set_ambient_pet_notification(
        &mut self,
        kind: crate::pets::PetNotificationKind,
        body: Option<String>,
    )
```

**Purpose**: Forwards a notification badge/message to the currently loaded ambient pet, if any.

**Data flow**: It takes a `PetNotificationKind` and optional body string, checks `self.ambient_pet.as_mut()`, and if present calls `pet.set_notification(kind, body)`. It does not redraw on its own.

**Call relations**: This is a small adapter used by other widget flows that want the pet to reflect status changes.


##### `ChatWidget::ambient_pet_image_enabled`  (lines 66–70)

```
fn ambient_pet_image_enabled(&self) -> bool
```

**Purpose**: Reports whether the current ambient pet exists and is using image rendering.

**Data flow**: It reads `self.ambient_pet`, applies `is_some_and(AmbientPet::image_enabled)`, and returns a boolean without mutating state.

**Call relations**: This helper supports layout and rendering decisions elsewhere in the widget.


##### `ChatWidget::disable_ambient_pet_for_session`  (lines 72–75)

```
fn disable_ambient_pet_for_session(&mut self)
```

**Purpose**: Turns off the ambient pet for the current session only.

**Data flow**: It sets `self.ambient_pet = None` and requests redraw. It does not persist the change to config.

**Call relations**: This is a local UI-state mutation used when the session needs to suppress pet rendering without changing saved settings.


##### `ChatWidget::ambient_pet_draw`  (lines 77–93)

```
fn ambient_pet_draw(
        &self,
        area: Rect,
        composer_bottom_y: u16,
    ) -> Option<crate::pets::AmbientPetDraw>
```

**Purpose**: Builds a draw request for the ambient pet when the main chat view is unobstructed.

**Data flow**: It takes the available `Rect` and the composer bottom Y coordinate, returns `None` if `self.bottom_pane.no_modal_or_popup_active()` is false, otherwise chooses an anchor Y from `self.config.tui_pet_anchor` (`Composer` uses `composer_bottom_y`, `ScreenBottom` uses `area.bottom()`), then asks the current ambient pet for `draw_request(area, anchor_bottom_y)`.

**Call relations**: This method is called during rendering. It depends on popup/modal visibility so pets do not overlap transient UI surfaces.

*Call graph*: 1 external calls (bottom).


##### `ChatWidget::ambient_pet_wrap_reserved_cols`  (lines 95–104)

```
fn ambient_pet_wrap_reserved_cols(&self) -> u16
```

**Purpose**: Computes how many text columns should be reserved so wrapped history text does not collide with an image-rendered ambient pet.

**Data flow**: It reads `self.ambient_pet`, filters to pets with `image_enabled()`, maps to `image_columns() + AMBIENT_PET_WRAP_GAP_COLUMNS` using saturating arithmetic, and returns `0` when no image pet is active.

**Call relations**: This helper feeds `ChatWidget::history_wrap_width` to adjust text layout around the pet.

*Call graph*: called by 1 (history_wrap_width).


##### `ChatWidget::history_wrap_width`  (lines 106–110)

```
fn history_wrap_width(&self, width: u16) -> u16
```

**Purpose**: Calculates the effective wrap width for history text after reserving space for the ambient pet image.

**Data flow**: It takes a total width, subtracts `ambient_pet_wrap_reserved_cols()` with saturation, clamps the result to at least `1`, and returns the adjusted width.

**Call relations**: This is a layout helper that delegates the pet-space calculation to `ChatWidget::ambient_pet_wrap_reserved_cols`.

*Call graph*: calls 1 internal fn (ambient_pet_wrap_reserved_cols).


##### `ChatWidget::pet_picker_preview_draw`  (lines 112–122)

```
fn pet_picker_preview_draw(&self) -> Option<crate::pets::AmbientPetDraw>
```

**Purpose**: Produces the draw request for the pet-picker preview image when the pet picker is active and a preview pet is ready.

**Data flow**: It checks that the active bottom-pane view has the pets picker view ID selected, reads the preview area from `self.pet_picker_preview_state.area()`, asks `self.pet_picker_preview_pet` for a `preview_draw_request(area)`, sets `self.pet_picker_preview_image_visible` to `true`, and returns the resulting `AmbientPetDraw`.

**Call relations**: This method is used during rendering of the pet picker. It works with `ChatWidget::should_clear_pet_picker_preview_image`, which consumes the visibility flag afterward.


##### `ChatWidget::should_clear_pet_picker_preview_image`  (lines 124–126)

```
fn should_clear_pet_picker_preview_image(&self) -> bool
```

**Purpose**: Returns whether a preview image was shown since the last check and resets that one-shot flag.

**Data flow**: It reads and resets `self.pet_picker_preview_image_visible` using `replace(false)` and returns the previous boolean value.

**Call relations**: This helper is part of the preview-render lifecycle, allowing the renderer to know when stale preview imagery should be cleared.


##### `ChatWidget::fail_pet_picker_preview_render`  (lines 128–132)

```
fn fail_pet_picker_preview_render(&mut self, message: String)
```

**Purpose**: Marks the pet-picker preview as failed after a rendering error and clears the loaded preview pet.

**Data flow**: It takes an error message string, writes it into `self.pet_picker_preview_state` via `set_error`, sets `self.pet_picker_preview_pet = None`, and requests redraw.

**Call relations**: This is the error path for preview rendering after a pet has loaded but cannot be displayed correctly.


##### `ChatWidget::open_pets_picker`  (lines 134–154)

```
fn open_pets_picker(&mut self)
```

**Purpose**: Opens the pet picker popup, resets preview state, and starts loading the initially selected pet for preview.

**Data flow**: It first calls `warn_if_pets_unsupported()` and returns if unsupported. Otherwise it clears `pet_picker_preview_state`, clears `pet_picker_preview_pet`, builds picker params from `crate::pets::build_pet_picker_params(self.config.tui_pet.as_deref(), &self.config.codex_home, self.pet_picker_preview_state.clone())`, shows that selection view in `self.bottom_pane`, derives the initial pet ID from config or `DEFAULT_PET_ID`, and calls `start_pet_picker_preview(initial_pet_id)`.

**Call relations**: This is the entrypoint for the pet-selection UI. It delegates capability checks to `ChatWidget::warn_if_pets_unsupported` and async preview loading to `ChatWidget::start_pet_picker_preview`.

*Call graph*: calls 2 internal fn (start_pet_picker_preview, warn_if_pets_unsupported); 1 external calls (build_pet_picker_params).


##### `ChatWidget::select_pet_by_id`  (lines 156–162)

```
fn select_pet_by_id(&mut self, pet_id: String)
```

**Purpose**: Initiates selection of a pet by sending an app event, unless pet images are unsupported in the current terminal.

**Data flow**: It takes an owned pet ID string, calls `warn_if_pets_unsupported()`, and if supported sends `AppEvent::PetSelected { pet_id }` on `self.app_event_tx`.

**Call relations**: This is the action side of the pet picker. It shares the same capability gate as `ChatWidget::open_pets_picker`.

*Call graph*: calls 1 internal fn (warn_if_pets_unsupported).


##### `ChatWidget::warn_if_pets_unsupported`  (lines 164–172)

```
fn warn_if_pets_unsupported(&mut self) -> bool
```

**Purpose**: Checks terminal pet-image support and emits a warning message when the feature cannot work.

**Data flow**: It reads `self.pet_image_support()`, asks the returned support object for `unsupported_message()`, and if a message exists adds it as a warning and returns `true`; otherwise it returns `false`.

**Call relations**: This guard is called by both `ChatWidget::open_pets_picker` and `ChatWidget::select_pet_by_id` to prevent entering unsupported pet flows.

*Call graph*: calls 1 internal fn (pet_image_support); called by 2 (open_pets_picker, select_pet_by_id).


##### `ChatWidget::pet_image_support`  (lines 174–187)

```
fn pet_image_support(&self) -> crate::pets::PetImageSupport
```

**Purpose**: Determines the current terminal’s pet-image support, with deterministic overrides in tests.

**Data flow**: In tests it first reads `self.pet_image_support_override` and returns it if set, otherwise returns a fixed unsupported value. Outside tests it calls `crate::pets::detect_pet_image_support()` and returns that result.

**Call relations**: This helper underpins `ChatWidget::warn_if_pets_unsupported` and test-only pet behavior.

*Call graph*: called by 1 (warn_if_pets_unsupported); 2 external calls (detect_pet_image_support, Unsupported).


##### `ChatWidget::set_tui_pet`  (lines 190–195)

```
fn set_tui_pet(&mut self, pet: Option<String>)
```

**Purpose**: Updates the widget’s configured pet ID, reloads the ambient pet synchronously, applies any test image-support override, and redraws.

**Data flow**: It takes an optional pet ID, writes it into `self.config.tui_pet`, reloads `self.ambient_pet` via `load_ambient_pet(&self.config, self.frame_requester.clone())`, calls `apply_ambient_pet_image_support_override_for_tests()`, and requests redraw.

**Call relations**: This is the normal synchronous state-update path after a pet selection has been committed.

*Call graph*: calls 2 internal fn (apply_ambient_pet_image_support_override_for_tests, load_ambient_pet).


##### `ChatWidget::set_tui_pet_loaded`  (lines 197–206)

```
fn set_tui_pet_loaded(
        &mut self,
        pet: Option<String>,
        ambient_pet: Option<crate::pets::AmbientPet>,
    )
```

**Purpose**: Updates the configured pet ID and ambient pet instance using a preloaded pet object rather than loading synchronously.

**Data flow**: It takes an optional pet ID and optional `AmbientPet`, writes both into `self.config.tui_pet` and `self.ambient_pet`, applies any test image-support override, and requests redraw.

**Call relations**: This helper is used when a pet has already been loaded asynchronously or synthesized in tests, including by `ChatWidget::install_test_ambient_pet_for_tests`.

*Call graph*: calls 1 internal fn (apply_ambient_pet_image_support_override_for_tests); called by 1 (install_test_ambient_pet_for_tests).


##### `ChatWidget::apply_ambient_pet_image_support_override_for_tests`  (lines 218–218)

```
fn apply_ambient_pet_image_support_override_for_tests(&mut self)
```

**Purpose**: In test builds, forces the current ambient pet to use the configured image-support override.

**Data flow**: It reads `self.pet_image_support_override` and `self.ambient_pet.as_mut()`, and when both are present calls `pet.set_image_support_for_tests(support)`. In non-test builds the function is a no-op.

**Call relations**: This helper is called after pet assignment by `ChatWidget::set_tui_pet`, `ChatWidget::set_tui_pet_loaded`, and the test-only setter so tests can simulate supported or unsupported terminals.

*Call graph*: called by 3 (set_pet_image_support_for_tests, set_tui_pet, set_tui_pet_loaded).


##### `ChatWidget::start_pet_picker_preview`  (lines 220–250)

```
fn start_pet_picker_preview(&mut self, pet_id: String)
```

**Purpose**: Begins loading a preview pet for the picker, invalidating older preview requests and updating preview state immediately.

**Data flow**: It takes a pet ID, increments `self.pet_picker_preview_request_id` with wrapping arithmetic, clears `self.pet_picker_preview_pet`, and if the ID is the disabled sentinel marks the preview state disabled and redraws. Otherwise it marks the preview state loading, redraws, captures `codex_home`, `frame_requester`, and `app_event_tx`, then spawns a background task that ensures the builtin pack exists, loads the pet with animations disabled, converts errors to strings, and sends `AppEvent::PetPreviewLoaded { request_id, result }`.

**Call relations**: This function is called by `ChatWidget::open_pets_picker` and is paired with `ChatWidget::finish_pet_picker_preview_load`, which consumes the async result.

*Call graph*: calls 1 internal fn (spawn_pet_load); called by 1 (open_pets_picker).


##### `ChatWidget::finish_pet_picker_preview_load`  (lines 252–278)

```
fn finish_pet_picker_preview_load(
        &mut self,
        request_id: u64,
        result: Result<crate::pets::AmbientPet, String>,
    )
```

**Purpose**: Applies the result of an asynchronous pet preview load if it still matches the latest outstanding preview request.

**Data flow**: It takes a request ID and `Result<AmbientPet, String>`, compares the ID against `self.pet_picker_preview_request_id`, and returns early for stale results. On success it marks preview state ready, stores the pet in `self.pet_picker_preview_pet`, and in tests may apply an image-support override; on error it stores the error in preview state and clears the preview pet. It then requests redraw.

**Call relations**: This is the completion half of `ChatWidget::start_pet_picker_preview`, ensuring out-of-order async loads do not overwrite newer preview selections.


##### `ChatWidget::show_pet_selection_loading_popup`  (lines 280–297)

```
fn show_pet_selection_loading_popup(&mut self) -> u64
```

**Purpose**: Shows a temporary loading popup while the selected pet is being prepared for actual activation and returns the request ID guarding that popup.

**Data flow**: It increments `self.pet_selection_load_request_id` with wrapping arithmetic, clears preview state and preview pet, writes a loading `SelectionViewParams` with `PET_SELECTION_LOADING_VIEW_ID` into `self.bottom_pane`, and returns the new request ID.

**Call relations**: This helper is used around asynchronous pet-selection application so later completion code can dismiss only the matching loading popup.

*Call graph*: 2 external calls (default, vec!).


##### `ChatWidget::finish_pet_selection_loading_popup`  (lines 299–306)

```
fn finish_pet_selection_loading_popup(&mut self, request_id: u64) -> bool
```

**Purpose**: Dismisses the pet-selection loading popup if the completion corresponds to the latest outstanding selection request.

**Data flow**: It takes a request ID, compares it to `self.pet_selection_load_request_id`, returns `false` if they differ, otherwise asks `self.bottom_pane` to dismiss the active view with `PET_SELECTION_LOADING_VIEW_ID` and returns `true`.

**Call relations**: This function pairs with `ChatWidget::show_pet_selection_loading_popup` to avoid dismissing a newer loading popup with an older completion.


##### `ChatWidget::set_pet_image_support_for_tests`  (lines 309–315)

```
fn set_pet_image_support_for_tests(
        &mut self,
        support: crate::pets::PetImageSupport,
    )
```

**Purpose**: In tests, installs a terminal image-support override and reapplies it to the current ambient pet.

**Data flow**: It takes a `PetImageSupport`, stores it in `self.pet_image_support_override`, and calls `apply_ambient_pet_image_support_override_for_tests()`.

**Call relations**: This test-only helper supports deterministic pet rendering tests and feeds the override logic used by `ChatWidget::pet_image_support`.

*Call graph*: calls 1 internal fn (apply_ambient_pet_image_support_override_for_tests).


##### `ChatWidget::install_test_ambient_pet_for_tests`  (lines 318–326)

```
fn install_test_ambient_pet_for_tests(&mut self, animations_enabled: bool)
```

**Purpose**: In tests, installs a synthetic ambient pet instance with a chosen animation setting.

**Data flow**: It takes a boolean `animations_enabled`, constructs a test pet via `crate::pets::test_ambient_pet(self.frame_requester.clone(), animations_enabled)`, and passes it to `set_tui_pet_loaded(Some("test".to_string()), Some(...))`.

**Call relations**: This test-only helper is a convenience wrapper around `ChatWidget::set_tui_pet_loaded` for fixture setup.

*Call graph*: calls 1 internal fn (set_tui_pet_loaded); 1 external calls (test_ambient_pet).


##### `spawn_pet_load`  (lines 329–335)

```
fn spawn_pet_load(f: impl FnOnce() + Send + 'static)
```

**Purpose**: Runs a pet-loading closure off the main thread, using Tokio’s blocking pool when available and a plain OS thread otherwise.

**Data flow**: It takes an owned `FnOnce() + Send + 'static`. It tries `tokio::runtime::Handle::try_current()`: on success it spawns the closure with `spawn_blocking` and drops the join handle; on failure it starts a new `std::thread::spawn(f)`. It returns no value.

**Call relations**: This helper is the execution primitive used by both `start_configured_pet_load_if_needed` and `ChatWidget::start_pet_picker_preview` so pet asset loading does not block the UI thread.

*Call graph*: called by 2 (start_pet_picker_preview, start_configured_pet_load_if_needed); 3 external calls (drop, spawn, try_current).


### `tui/src/chatwidget/mcp_startup.rs`

`domain_logic` · `startup and post-startup lag handling`

This file defines the chat widget’s internal model for MCP startup progress and the logic that keeps that model stable despite delayed or lossy status delivery from the app server. The local enum `McpStartupStatus` collapses protocol states into four UI-facing cases: `Starting`, `Ready`, `Failed { error }`, and `Cancelled`.

The core logic lives in `ChatWidget::update_mcp_startup_status`. It maintains two startup maps: the active round in `self.mcp_startup_status` and a buffered pending round used while `self.mcp_startup_ignore_updates_until_next_start` is set after a finish. That ignore window prevents stale post-finish events from reopening startup. A pending round is only promoted when it looks coherent against `self.mcp_startup_expected_servers`: every expected server has appeared, and either at least one `Starting` was seen or lag handling explicitly allows a terminal-only round. Failures trigger `on_warning` immediately, but duplicate failure messages for the same server/error pair are suppressed.

Once the active round contains all expected servers and none remain `Starting`, the code computes sorted `failed` and `cancelled` server lists and finalizes startup. If startup is still in progress, it synthesizes a status header showing either a single-server boot message or a multi-server progress line with completed/total counts and up to three in-progress names. Finishing startup clears state, restores any non-startup status header if appropriate, releases queued input, and redraws. Lag-based finishing treats missing or still-starting servers as cancelled so the UI can recover even if terminal updates never arrive.

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

**Purpose**: Incorporates one server status update into either the active MCP startup round or a buffered next round, emits warnings for failures, updates the startup header, and finishes startup when the round has settled.

**Data flow**: Inputs are a server name, a `McpStartupStatus`, and a `complete_when_settled` flag. It reads widget fields including `mcp_startup_ignore_updates_until_next_start`, `mcp_startup_pending_next_round`, `mcp_startup_expected_servers`, `mcp_startup_status`, and status-header state; it mutates those maps/flags, may call `on_warning`, updates task-running state, may set a startup-owned header string, may finish startup with sorted failed/cancelled server vectors, and always requests redraw unless it returns early while buffering an incoherent pending round.

**Call relations**: This is the central transition function for MCP startup and is reached from `ChatWidget::on_mcp_server_status_updated` after protocol notifications are translated. In the normal path it folds updates into the active map; in ignore mode it buffers them until they resemble a fresh round. When all expected servers are present and no value is `Starting`, it delegates to `ChatWidget::finish_mcp_startup` to tear down startup state.

*Call graph*: calls 1 internal fn (finish_mcp_startup); called by 1 (on_mcp_server_status_updated); 4 external calls (new, format!, matches!, take).


##### `ChatWidget::set_mcp_startup_expected_servers`  (lines 177–182)

```
fn set_mcp_startup_expected_servers(&mut self, server_names: I)
```

**Purpose**: Stores the set of server names that define what a complete MCP startup round should contain.

**Data flow**: It takes any `IntoIterator<Item = String>`, consumes it into a collection, and writes the resulting set into `self.mcp_startup_expected_servers`. It returns no value and does not trigger redraw or completion by itself.

**Call relations**: This function prepares the invariants used by `ChatWidget::update_mcp_startup_status` and `ChatWidget::finish_mcp_startup_after_lag`: both rely on the expected-server set to decide whether a round is complete, promotable, or partially cancelled.

*Call graph*: 1 external calls (into_iter).


##### `ChatWidget::finish_mcp_startup`  (lines 184–211)

```
fn finish_mcp_startup(&mut self, failed: Vec<String>, cancelled: Vec<String>)
```

**Purpose**: Ends the current MCP startup round, emits summary warnings for cancelled or failed servers, clears startup-owned UI state, and releases any queued user input.

**Data flow**: It receives precomputed `failed` and `cancelled` server-name vectors. It reads the current header via `status_header_is_mcp_startup_owned`, emits warning strings when either list is non-empty, clears `self.mcp_startup_status`, resets ignore/pending-round flags and buffers, updates task-running state, may restore the reasoning header if startup owned the current header and another task is still running, sends the next queued input if available, and requests redraw.

**Call relations**: This is the shared teardown path used both by `ChatWidget::update_mcp_startup_status` when all expected servers have settled and by `ChatWidget::finish_mcp_startup_after_lag` when lag forces completion. It depends on `ChatWidget::status_header_is_mcp_startup_owned` to avoid overwriting unrelated status text.

*Call graph*: calls 1 internal fn (status_header_is_mcp_startup_owned); called by 2 (finish_mcp_startup_after_lag, update_mcp_startup_status); 2 external calls (new, format!).


##### `ChatWidget::finish_mcp_startup_after_lag`  (lines 213–248)

```
fn finish_mcp_startup_after_lag(&mut self)
```

**Purpose**: Forces MCP startup completion after a lag timeout by treating missing or still-starting servers as cancelled and preserving enough state to recognize a terminal-only next round.

**Data flow**: It reads ignore-mode flags, the pending-next-round buffer, the active startup map, and the expected-server set. It may set `mcp_startup_allow_terminal_only_next_round`, then builds a `BTreeSet<String>` union of current and expected server names, classifies each as ready, failed, or cancelled (`Cancelled`, `Starting`, or absent all count as cancelled), sorts/deduplicates the failed and cancelled vectors, and passes them to `finish_mcp_startup`.

**Call relations**: This function is the timeout/recovery path when normal settling never occurs. It delegates final cleanup to `ChatWidget::finish_mcp_startup`, and its `allow_terminal_only_next_round` flag changes how later calls to `ChatWidget::update_mcp_startup_status` decide whether buffered post-finish updates can activate a new round.

*Call graph*: calls 1 internal fn (finish_mcp_startup); 1 external calls (new).


##### `ChatWidget::status_header_is_mcp_startup_owned`  (lines 250–260)

```
fn status_header_is_mcp_startup_owned(&self) -> bool
```

**Purpose**: Checks whether the current status header text was produced by MCP startup progress rather than some other widget activity.

**Data flow**: It reads `self.status_state.current_status.header` and returns `true` if the string starts with either the single-server or multi-server MCP startup prefix constant. It does not mutate widget state.

**Call relations**: This predicate is used by `ChatWidget::finish_mcp_startup` to decide whether it is safe to restore the reasoning/task header after startup ends, preventing unrelated status text from being replaced.

*Call graph*: called by 1 (finish_mcp_startup).


##### `ChatWidget::on_mcp_server_status_updated`  (lines 262–281)

```
fn on_mcp_server_status_updated(
        &mut self,
        notification: McpServerStatusUpdatedNotification,
    )
```

**Purpose**: Translates an app-server `McpServerStatusUpdatedNotification` into the widget’s local startup status enum and feeds it into startup tracking.

**Data flow**: It consumes a notification containing `name`, protocol `status`, and optional `error`. It maps protocol states to `McpStartupStatus`, synthesizing a default failure message when `Failed` arrives without an error string, then passes the server name and mapped status into `update_mcp_startup_status` with `complete_when_settled` set to `true`.

**Call relations**: This is the protocol-facing entry into the file’s logic. It is invoked when the app server reports per-server MCP startup changes, and it delegates all buffering, warning, header, and completion behavior to `ChatWidget::update_mcp_startup_status`.

*Call graph*: calls 1 internal fn (update_mcp_startup_status).


### `tui/src/chatwidget/replay.rs`

`domain_logic` · `startup`

This module reconstructs transcript state from stored thread data rather than live notifications. `replay_thread_turns` iterates through a vector of `Turn` records, destructuring each turn so it can inspect status and replay items in order. If a turn is still `InProgress`, it clears `last_non_retry_error` and calls `on_task_started` to approximate the live UI state. Each item is then replayed through `replay_thread_item`, and terminal turn states (`Completed`, `Interrupted`, `Failed`) are finalized by synthesizing a minimal `TurnCompletedNotification` and routing it through the same completion handler used for live notifications. That preserves turn-end behavior such as dedupe reset and interruption/error handling.

`replay_thread_item` is a thin wrapper that tags the item as `ThreadItemRenderSource::Replay(replay_kind)` and delegates to `handle_thread_item`. The latter is the core replay-aware item renderer. It computes `from_replay` and `replay_kind`, then matches every `ThreadItem` variant into the corresponding transcript/UI callback. Some variants are rendered incrementally during replay, such as reasoning summaries and optionally raw reasoning deltas; others intentionally skip side effects, such as in-progress file changes and hook prompts. Review-mode entry is replayed only when the source is replay, while exits always clear review mode. Agent messages also translate app-server memory citations into local protocol citation structs. A final redraw is requested for thread-snapshot replay items that have an empty turn id, ensuring snapshot-only items become visible immediately.

#### Function details

##### `ChatWidget::replay_thread_turns`  (lines 14–55)

```
fn replay_thread_turns(&mut self, turns: Vec<Turn>, replay_kind: ReplayKind)
```

**Purpose**: Rehydrates a sequence of historical turns into the widget by replaying each item and then applying turn-completion logic for finished turns. It approximates live event order while avoiding direct live protocol dependencies.

**Data flow**: Inputs are `&mut self`, `turns: Vec<Turn>`, and a `ReplayKind`. For each turn it destructures ids, items, status, error, and timing fields; if status is `InProgress` it clears `last_non_retry_error` and calls `on_task_started`; it then iterates items and passes each to `replay_thread_item`; for terminal statuses it constructs a synthetic `TurnCompletedNotification` using the current widget thread id and an empty-items `Turn`, then calls `handle_turn_completed_notification(Some(replay_kind))`. It returns unit.

**Call relations**: This is the top-level replay driver. It delegates per-item work to `ChatWidget::replay_thread_item` and reuses the normal turn-finalization path by invoking `handle_turn_completed_notification` with replay context.

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

**Purpose**: Wraps a historical `ThreadItem` with replay provenance and forwards it into the unified item renderer. It keeps replay tagging centralized.

**Data flow**: It takes `&mut self`, a `ThreadItem`, a `turn_id: String`, and a `ReplayKind`, constructs `ThreadItemRenderSource::Replay(replay_kind)`, passes all values to `handle_thread_item`, and returns unit.

**Call relations**: This function is called by `ChatWidget::replay_thread_turns` for each historical item and delegates all item-specific behavior to `ChatWidget::handle_thread_item`.

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

**Purpose**: Renders a completed or replayed `ThreadItem` into transcript/review/tool state, with behavior adjusted for replay source and replay kind. It is the shared item-consumption path used by both replay and live item-completion handling.

**Data flow**: Inputs are `&mut self`, a `ThreadItem`, a `turn_id: String`, and a `ThreadItemRenderSource`. It derives `from_replay` and `replay_kind`, matches the item variant, and invokes the corresponding widget callback: user messages, agent messages, plans, reasoning deltas/finalization, command execution start/completion, file changes, MCP tool calls, web search begin/end, image view/generation, review mode entry/exit, context compaction info messages, collaboration tool calls, and sub-agent activity. For agent messages it transforms app-server memory citation entries into local `codex_protocol::memory_citation` structs. After item handling, if the replay kind is `ThreadSnapshot` and `turn_id` is empty, it requests a redraw.

**Call relations**: This method is called by `ChatWidget::replay_thread_item` and also by live protocol handling through `handle_item_completed_notification`. Its replay checks are what let both paths share one renderer without triggering inappropriate live-only effects.

*Call graph*: calls 2 internal fn (is_replay, replay_kind); called by 1 (replay_thread_item); 2 external calls (matches!, vec!).


### `tui/src/collaboration_modes.rs`

`domain_logic` · `mode selection, startup defaults, and mode-switch interactions`

This file is a compact adapter around `builtin_collaboration_mode_presets()`. The central helper, `filtered_presets`, loads all built-in collaboration mode masks and discards any whose `mode` is absent or whose `ModeKind` is not marked TUI-visible. The `ModelCatalog` parameter is currently unused, but it is threaded through every function so future filtering can depend on model availability without changing call sites.

On top of that filtered list, the module offers three selection patterns. `default_mask` prefers the preset whose `mode` is `Some(ModeKind::Default)` and otherwise falls back to the first visible preset, giving the TUI a stable startup choice even if the canonical default is missing. `mask_for_kind` returns the visible preset for a requested `ModeKind`, but explicitly rejects kinds that are not TUI-visible before searching. `next_mask` implements wraparound cycling: if there are no visible presets it returns `None`; otherwise it finds the current mode's position and advances to the next index modulo the preset count, defaulting to index 0 when the current mask is absent or not found.

The final two helpers, `default_mode_mask` and `plan_mask`, are convenience wrappers for the common `Default` and `Plan` lookups used throughout the chat workflow.

#### Function details

##### `filtered_presets`  (lines 7–12)

```
fn filtered_presets(_model_catalog: &ModelCatalog) -> Vec<CollaborationModeMask>
```

**Purpose**: Loads the built-in collaboration mode presets and keeps only those whose `ModeKind` is visible in the TUI. It is the shared source of truth for every other helper in this module.

**Data flow**: It takes a `&ModelCatalog` parameter but does not currently read it. It calls `builtin_collaboration_mode_presets()`, iterates the resulting masks, filters to entries where `mask.mode.is_some_and(ModeKind::is_tui_visible)`, collects them into a `Vec<CollaborationModeMask>`, and returns that vector.

**Call relations**: This helper is called by `default_mask`, `mask_for_kind`, and `next_mask`. Those functions rely on it so they all operate over the same TUI-visible subset of presets.

*Call graph*: calls 1 internal fn (builtin_collaboration_mode_presets); called by 3 (default_mask, mask_for_kind, next_mask).


##### `default_mask`  (lines 14–21)

```
fn default_mask(model_catalog: &ModelCatalog) -> Option<CollaborationModeMask>
```

**Purpose**: Chooses the TUI's default collaboration mode preset from the visible preset list. It prefers the explicit `Default` mode when present and otherwise falls back to the first visible preset.

**Data flow**: It calls `filtered_presets(model_catalog)` to obtain a `Vec<CollaborationModeMask>`, searches the vector for an element whose `mode == Some(ModeKind::Default)`, clones and returns that mask if found, and otherwise consumes the vector and returns its first element via `into_iter().next()`.

**Call relations**: This function is used by startup and mode-preservation logic that needs a stable default collaboration mask. It depends entirely on `filtered_presets` for the candidate set.

*Call graph*: calls 1 internal fn (filtered_presets); called by 6 (initial_collaboration_mask, thread_settings_updated_preserves_default_settings_for_plan_mode, mode_switch_surfaces_model_change_notification_when_effective_model_changes, submit_user_message_with_mode_errors_when_mode_changes_during_running_turn, submit_user_message_with_mode_submits_when_plan_stream_is_not_active, status_line_model_with_reasoning_updates_on_mode_switch_without_manual_refresh).


##### `mask_for_kind`  (lines 23–33)

```
fn mask_for_kind(
    model_catalog: &ModelCatalog,
    kind: ModeKind,
) -> Option<CollaborationModeMask>
```

**Purpose**: Returns the visible collaboration mode preset corresponding to a specific `ModeKind`. It refuses to return hidden modes even if a built-in preset exists for them.

**Data flow**: It takes `&ModelCatalog` and `kind: ModeKind`. If `!kind.is_tui_visible()`, it returns `None` immediately; otherwise it calls `filtered_presets(model_catalog)`, searches for the first mask whose `mode == Some(kind)`, and returns that mask.

**Call relations**: This helper is the generic lookup used by many mode-switching and plan-mode flows. The convenience wrappers `default_mode_mask` and `plan_mask` simply call it with fixed `ModeKind` values.

*Call graph*: calls 2 internal fn (is_tui_visible, filtered_presets); called by 20 (enter_submits_when_plan_stream_is_not_active, mode_switch_surfaces_model_change_notification_when_effective_model_changes, plan_completion_restores_status_indicator_after_streaming_plan_output, plan_implementation_popup_shows_after_new_plan_follows_steer, plan_implementation_popup_shows_after_proposed_plan_output, plan_implementation_popup_shows_once_when_replay_precedes_live_turn_complete, plan_implementation_popup_skips_replayed_turn_complete, plan_implementation_popup_skips_when_messages_queued, plan_implementation_popup_skips_when_rate_limit_prompt_pending, plan_implementation_popup_skips_when_steer_follows_proposed_plan (+10 more)).


##### `next_mask`  (lines 36–50)

```
fn next_mask(
    model_catalog: &ModelCatalog,
    current: Option<&CollaborationModeMask>,
) -> Option<CollaborationModeMask>
```

**Purpose**: Cycles to the next visible collaboration mode preset in list order, wrapping around to the beginning. It supports keyboard or command-driven mode cycling in the TUI.

**Data flow**: It calls `filtered_presets(model_catalog)` and returns `None` if the resulting vector is empty. Otherwise it extracts `current_kind` from `current.and_then(|mask| mask.mode)`, finds the position of the matching preset in the vector, computes `(idx + 1) % presets.len()` when found or `0` when not found, and returns a clone of the preset at that index.

**Call relations**: This function is called by the collaboration-mode cycling action in the UI. It depends on `filtered_presets` so cycling order matches the visible preset order exposed elsewhere.

*Call graph*: calls 1 internal fn (filtered_presets); called by 1 (cycle_collaboration_mode).


##### `default_mode_mask`  (lines 52–54)

```
fn default_mode_mask(model_catalog: &ModelCatalog) -> Option<CollaborationModeMask>
```

**Purpose**: Convenience wrapper that returns the visible preset for `ModeKind::Default`. It avoids repeating the enum constant at call sites.

**Data flow**: It forwards `model_catalog` into `mask_for_kind(model_catalog, ModeKind::Default)` and returns that result unchanged.

**Call relations**: This helper is used by flows that specifically need the coding/default mode, such as plan implementation prompts and mode resets. It delegates all real work to `mask_for_kind`.

*Call graph*: calls 1 internal fn (mask_for_kind); called by 3 (plan_implementation_clear_context_requires_default_mode_and_plan, submit_user_message_with_mode_sets_coding_collaboration_mode, open_plan_implementation_prompt).


##### `plan_mask`  (lines 56–58)

```
fn plan_mask(model_catalog: &ModelCatalog) -> Option<CollaborationModeMask>
```

**Purpose**: Convenience wrapper that returns the visible preset for `ModeKind::Plan`. It centralizes the common lookup for plan-mode behavior.

**Data flow**: It calls `mask_for_kind(model_catalog, ModeKind::Plan)` and returns the resulting `Option<CollaborationModeMask>`.

**Call relations**: This helper is used by plan-mode nudges, slash commands, reasoning settings, and related flows. Like `default_mode_mask`, it is a thin specialization of `mask_for_kind`.

*Call graph*: calls 1 internal fn (mask_for_kind); called by 16 (open_plan_reasoning_scope_prompt, set_plan_mode_reasoning_effort, should_show_plan_mode_nudge, apply_plan_slash_command, interrupted_turn_restore_keeps_active_mode_for_resubmission, mode_switch_surfaces_reasoning_change_notification_when_model_stays_same, plan_mode_nudge_shows_only_for_eligible_default_mode_drafts, plan_mode_reasoning_override_is_marked_current_in_reasoning_popup, reasoning_selection_in_plan_mode_matching_plan_effort_but_different_global_opens_scope_prompt, reasoning_selection_in_plan_mode_model_switch_does_not_open_scope_prompt_event (+6 more)).


### `tui/src/history_cell/session.rs`

`domain_logic` · `startup and session-boundary rendering, plus later transcript display of session metadata and guidance`

This file combines reusable card-layout utilities with the concrete cells that appear at session boundaries. The layout helpers (`card_inner_width`, `with_border`, `with_border_with_inner_width`, `with_border_internal`) centralize bordered-card sizing and Unicode-aware padding. `with_border_internal` computes the widest content line by summing span display widths, optionally honors a forced inner width, and wraps each line between dim `│` borders with right-padding so all rows align under a top `╭──╮` and bottom `╰──╯` frame. `padded_emoji` standardizes emoji spacing using a hair space.

`TooltipHistoryCell` renders markdown-formatted tips prefixed with `Tip:` and indented by two spaces, preserving cwd context for local links. `SessionInfoCell` is a thin wrapper around `CompositeHistoryCell`; it delegates all rendering and sizing to its inner composite so a session info block can contain multiple heterogeneous subcells. `new_session_info` assembles that composite: it always starts with a `SessionHeaderHistoryCell`, optionally marks it as YOLO mode based on approval policy and permission profile, then either appends first-run onboarding commands (`/init`, `/status`, `/permissions`, `/model`, `/review`) or, on later events, an optional tooltip and a model-changed notice when the requested model differs from the actual session model.

`SessionHeaderHistoryCell` is the bordered startup card. It stores version, model, optional reasoning effort, fast-status flag, directory, and YOLO-mode state. Rich rendering computes a bounded inner width, formats the title row, aligns `model:`, `directory:`, and optionally `permissions:` labels to a common width, truncates the displayed directory with home-relative formatting and center truncation when needed, and includes `/model to change` plus optional `fast` and `YOLO mode` indicators. Raw mode emits the same information as plain lines.

#### Function details

##### `card_inner_width`  (lines 7–13)

```
fn card_inner_width(width: u16, max_inner_width: usize) -> Option<usize>
```

**Purpose**: Computes the usable inner width for a bordered card, accounting for border columns and a caller-specified maximum.

**Data flow**: It reads `width` and `max_inner_width`; if `width < 4` it returns `None` because there is not enough room for borders, otherwise it subtracts 4 columns for border/padding, clamps to `max_inner_width`, and returns `Some(inner_width)`.

**Call relations**: Card-style renderers such as `SessionHeaderHistoryCell::display_lines` use this helper before attempting bordered layout.

*Call graph*: called by 1 (display_lines); 1 external calls (min).


##### `with_border`  (lines 16–18)

```
fn with_border(lines: Vec<Line<'static>>) -> Vec<Line<'static>>
```

**Purpose**: Wraps content lines in a Unicode box border sized to the widest content line.

**Data flow**: It takes `lines`, forwards them to `with_border_internal` with no forced width, and returns the bordered lines.

**Call relations**: Callers use this when they want automatic border sizing based solely on content width.

*Call graph*: calls 1 internal fn (with_border_internal); called by 1 (display_lines).


##### `with_border_with_inner_width`  (lines 25–30)

```
fn with_border_with_inner_width(
    lines: Vec<Line<'static>>,
    inner_width: usize,
) -> Vec<Line<'static>>
```

**Purpose**: Wraps content lines in a Unicode box border while enforcing a minimum inner width chosen by the caller.

**Data flow**: It takes `lines` and `inner_width`, forwards both to `with_border_internal` as `Some(inner_width)`, and returns the bordered lines.

**Call relations**: Cells that already computed a target content width, such as update cards, use this to keep border sizing consistent with prior wrapping decisions.

*Call graph*: calls 1 internal fn (with_border_internal).


##### `with_border_internal`  (lines 32–72)

```
fn with_border_internal(
    lines: Vec<Line<'static>>,
    forced_inner_width: Option<usize>,
) -> Vec<Line<'static>>
```

**Purpose**: Implements the actual bordered-card layout, including Unicode-width measurement, right-padding, and top/bottom frame generation.

**Data flow**: It scans `lines` to compute `max_line_width` by summing `UnicodeWidthStr::width` across spans, chooses `content_width` as either the forced width or the measured maximum but never smaller than the maximum, allocates an output vector with room for top and bottom borders, pushes a dim top border sized to `content_width + 2`, then for each input line computes `used_width`, builds a span vector containing dim `│ `, the original spans, optional dim space padding to `content_width`, and dim ` │`, converts that to a `Line`, and finally appends a matching dim bottom border.

**Call relations**: Both public border helpers delegate here so all bordered cards share identical width and padding behavior.

*Call graph*: called by 2 (with_border, with_border_with_inner_width); 4 external calls (from, from, with_capacity, vec!).


##### `padded_emoji`  (lines 77–79)

```
fn padded_emoji(emoji: &str) -> String
```

**Purpose**: Formats an emoji followed by a hair space to create a subtle visual gap without full-space padding.

**Data flow**: It takes `emoji: &str`, interpolates it with `\u{200A}`, and returns the resulting `String`.

**Call relations**: Notice and card renderers use this helper when they want consistent emoji spacing across terminals.

*Call graph*: 1 external calls (format!).


##### `TooltipHistoryCell::new`  (lines 88–93)

```
fn new(tip: String, cwd: &Path) -> Self
```

**Purpose**: Constructs a tooltip cell from markdown tip text and the cwd needed for local-link rendering.

**Data flow**: It takes `tip: String` and `cwd: &Path`, clones `cwd` with `to_path_buf`, stores both fields, and returns the new `TooltipHistoryCell`.

**Call relations**: `new_session_info` creates this cell when tooltips are enabled and a tooltip string is available.

*Call graph*: 1 external calls (to_path_buf).


##### `TooltipHistoryCell::display_lines`  (lines 97–112)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the tooltip as indented markdown with cwd-aware local-link resolution.

**Data flow**: It defines a two-space indent, computes `wrap_width` as `width - indent_width` clamped to at least 1, initializes an output vector, appends markdown for `**Tip:** {tip}` via `append_markdown(..., Some(self.cwd.as_path()), &mut lines)`, then prefixes every resulting line with the same indent using `prefix_lines` and returns the prefixed lines.

**Call relations**: Session info rendering uses this rich representation when showing contextual tips below the session header.

*Call graph*: 5 external calls (as_path, width, new, format!, from).


##### `TooltipHistoryCell::raw_lines`  (lines 114–116)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text tooltip line without markdown formatting.

**Data flow**: It formats `Tip: {self.tip}` into a single `Line` and returns it in a one-element vector.

**Call relations**: Raw transcript mode uses this simplified tooltip representation.

*Call graph*: 1 external calls (vec!).


##### `SessionInfoCell::display_lines`  (lines 123–125)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Delegates rich rendering of the session info block to its inner composite cell.

**Data flow**: It forwards `width` to `self.0.display_lines(width)` and returns the resulting lines.

**Call relations**: This wrapper lets callers treat a multi-part session info composite as a single `HistoryCell`.


##### `SessionInfoCell::desired_height`  (lines 127–129)

```
fn desired_height(&self, width: u16) -> u16
```

**Purpose**: Delegates height measurement of the session info block to its inner composite cell.

**Data flow**: It forwards `width` to `self.0.desired_height(width)` and returns the row count.

**Call relations**: Layout code uses this through the `HistoryCell` trait when sizing the composite session info entry.


##### `SessionInfoCell::transcript_lines`  (lines 131–133)

```
fn transcript_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Delegates transcript-overlay rendering of the session info block to its inner composite cell.

**Data flow**: It forwards `width` to `self.0.transcript_lines(width)` and returns the result.

**Call relations**: Transcript overlay treats the composite session info entry as a single cell via this delegation.


##### `SessionInfoCell::raw_lines`  (lines 135–137)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Delegates raw-mode rendering of the session info block to its inner composite cell.

**Data flow**: It calls `self.0.raw_lines()` and returns the resulting plain lines.

**Call relations**: Raw transcript mode uses this wrapper to expose the composite’s plain-text representation.


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

**Purpose**: Assembles the full session-info composite shown near the top of a conversation, including header, onboarding help, optional tooltip, and model-change notice.

**Data flow**: It reads `config`, `requested_model`, `session`, `is_first_event`, `tooltip_override`, `auth_plan`, and `show_fast_status`. It constructs a `SessionHeaderHistoryCell` from session model, reasoning effort, cwd, and CLI version, then applies `.with_yolo_mode(...)` using `has_yolo_permissions(session.approval_policy, &session.permission_profile)`. It initializes `parts` with that boxed header. If `is_first_event` is true, it appends a `PlainHistoryCell` containing fixed onboarding/help lines for several slash commands. Otherwise, if `config.show_tooltips` is true, it chooses a tooltip from `tooltip_override` or `tooltips::get_tooltip(auth_plan, show_fast_status)`, wraps it in `TooltipHistoryCell`, and appends it; then, if `requested_model != session.model`, it appends a plain three-line model-changed notice. Finally it returns `SessionInfoCell(CompositeHistoryCell { parts })`.

**Call relations**: Session startup and session-boundary orchestration call this helper to create the top-of-history informational block tailored to first-run vs later events.

*Call graph*: calls 2 internal fn (new, has_yolo_permissions); 2 external calls (new, vec!).


##### `is_yolo_mode`  (lines 219–224)

```
fn is_yolo_mode(config: &Config) -> bool
```

**Purpose**: Determines whether the current config implies unrestricted YOLO-style permissions.

**Data flow**: It converts `config.permissions.approval_policy.value()` into `AskForApproval`, obtains the effective permission profile from config, passes both to `has_yolo_permissions`, and returns the resulting boolean.

**Call relations**: Configuration/status code can call this helper when it needs the same YOLO-mode predicate used by session header rendering.

*Call graph*: calls 2 internal fn (from, has_yolo_permissions).


##### `has_yolo_permissions`  (lines 226–239)

```
fn has_yolo_permissions(
    approval_policy: AskForApproval,
    permission_profile: &PermissionProfile,
) -> bool
```

**Purpose**: Encodes the exact policy/profile combination that qualifies as YOLO mode.

**Data flow**: It reads `approval_policy` and `permission_profile` and returns `true` only when approval is `AskForApproval::Never` and the profile is either `PermissionProfile::Disabled` or `PermissionProfile::Managed { file_system: ManagedFileSystemPermissions::Unrestricted, network: NetworkSandboxPolicy::Enabled }`.

**Call relations**: Both `is_yolo_mode` and `new_session_info` use this shared predicate so UI labeling and config-derived checks stay consistent.

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

**Purpose**: Constructs a session header cell using the default model style.

**Data flow**: It takes model, optional reasoning effort, fast-status flag, directory, and version; creates `Style::default()`; forwards all fields to `new_with_style`; and returns the resulting header cell.

**Call relations**: Most production and test code uses this convenience constructor when no custom model styling is needed.

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

**Purpose**: Constructs a session header cell with an explicit style for the model label/value.

**Data flow**: It stores `version`, `model`, `model_style`, `reasoning_effort`, `show_fast_status`, and `directory`, initializes `yolo_mode` to `false`, and returns the struct.

**Call relations**: Specialized callers and tests use this lower-level constructor when they need non-default model styling.

*Call graph*: called by 1 (placeholder_session_header_cell).


##### `SessionHeaderHistoryCell::with_yolo_mode`  (lines 288–291)

```
fn with_yolo_mode(mut self, yolo_mode: bool) -> Self
```

**Purpose**: Marks a session header cell to display the extra permissions row indicating YOLO mode.

**Data flow**: It takes ownership of `self`, sets `self.yolo_mode` to the provided boolean, and returns the modified cell.

**Call relations**: `new_session_info` applies this after constructing the header so permission-derived UI state is embedded in the final cell.


##### `SessionHeaderHistoryCell::format_directory`  (lines 293–295)

```
fn format_directory(&self, max_width: Option<usize>) -> String
```

**Purpose**: Formats this header’s stored directory path with optional width truncation.

**Data flow**: It forwards `&self.directory` and `max_width` to `SessionHeaderHistoryCell::format_directory_inner` and returns the resulting string.

**Call relations**: The rich header renderer uses this wrapper when computing the directory row.

*Call graph*: called by 1 (display_lines); 1 external calls (format_directory_inner).


##### `SessionHeaderHistoryCell::format_directory_inner`  (lines 297–318)

```
fn format_directory_inner(directory: &Path, max_width: Option<usize>) -> String
```

**Purpose**: Formats a directory path for display, preferring `~`-relative output and center truncating when it exceeds a width limit.

**Data flow**: It first tries `relativize_to_home(directory)`: if successful and empty it returns `~`, otherwise it formats `~/<relative>`. If home-relativization fails it uses `directory.display().to_string()`. When `max_width` is `Some(0)` it returns an empty string; when the formatted path’s Unicode width exceeds `max_width`, it returns `center_truncate_path(&formatted, max_width)`; otherwise it returns the full formatted string.

**Call relations**: The header renderer and tests use this helper to ensure directory display is stable, home-aware, and width-bounded.

*Call graph*: calls 1 internal fn (center_truncate_path); called by 2 (session_header_directory_center_truncates, session_header_directory_front_truncates_long_segment); 4 external calls (display, new, width, format!).


##### `SessionHeaderHistoryCell::reasoning_label`  (lines 320–324)

```
fn reasoning_label(&self) -> Option<&str>
```

**Purpose**: Returns the configured reasoning-effort label string, if any, for inclusion in the model row.

**Data flow**: It reads `self.reasoning_effort`, maps the inner enum through `ReasoningEffortConfig::as_str`, and returns `Option<&str>`.

**Call relations**: The rich and raw header renderers use this to append reasoning level text only when configured.

*Call graph*: called by 1 (display_lines).


##### `SessionHeaderHistoryCell::display_lines`  (lines 328–401)

```
fn display_lines(&self, width: u16) -> Vec<Line<'static>>
```

**Purpose**: Renders the bordered session header card with title, model row, directory row, optional fast badge, `/model` hint, and optional YOLO permissions row.

**Data flow**: It first computes `inner_width` with `card_inner_width`; if unavailable it returns an empty vector. It builds a title row (`>_ OpenAI Codex (vX)`), computes a shared `label_width` based on whether the permissions row will be shown, formats the model row with dim `model:` label, styled model name, optional reasoning label, optional magenta `fast` marker, and `/model to change` hint, computes a width-limited directory string by subtracting the directory-label prefix width from `inner_width` and calling `format_directory(Some(dir_max_width))`, and assembles rows for title, blank spacer, model, and directory. If `self.yolo_mode` is true, it appends a permissions row showing bold magenta `YOLO mode`. Finally it wraps all rows with `with_border` and returns the bordered lines.

**Call relations**: This is the main rich renderer for the startup/session header card and is the first component inserted by `new_session_info`.

*Call graph*: calls 4 internal fn (format_directory, reasoning_label, card_inner_width, with_border); 7 external calls (from, styled, magenta, width, new, format!, vec!).


##### `SessionHeaderHistoryCell::raw_lines`  (lines 403–422)

```
fn raw_lines(&self) -> Vec<Line<'static>>
```

**Purpose**: Produces a plain-text version of the session header containing version, model plus reasoning, directory, and optional YOLO permissions line.

**Data flow**: It builds a vector with `OpenAI Codex (v...)`, `model: ...` including optional reasoning suffix, and `directory: ...` using `format_directory(None)`. If `self.yolo_mode` is true, it appends `permissions: YOLO mode`, then returns the vector.

**Call relations**: Raw transcript mode uses this textual representation instead of the bordered card.

*Call graph*: 2 external calls (from, vec!).


### `tui/src/bottom_pane/status_surface_preview.rs`

`data_model` · `config preview rendering`

This file defines the preview-data model used by configuration UIs that let users choose status-line and terminal-title items before real runtime values are available. `StatusSurfacePreviewItem` is the canonical enum of previewable fields, spanning app identity, paths, git metadata, permissions, token/context counters, model labels, and task progress. Each variant has a fixed placeholder string, and `iter()` returns the full stable inventory used to seed defaults.

`StatusSurfacePreviewData` wraps a `BTreeMap<StatusSurfacePreviewItem, PreviewValue>`, where each stored value carries both text and an `is_placeholder` flag. The `Default` implementation prepopulates every preview item with its placeholder. `set_live` overwrites an item with runtime text and marks it non-placeholder; `set_placeholder` only fills gaps or existing placeholders, never replacing live data; `suppress_placeholder` removes an item entirely if it is still synthetic. That distinction matters for configuration UIs that should omit unavailable runtime-only fields instead of showing fake values.

The file also contains rate-limit-specific copy derivation. Given a live rate-limit string such as `"weekly ..."` or `"usage ..."`, helper methods derive a more precise item name and description for picker rows. Finally, `status_line_for_items` maps selected `StatusLineItem`s through each item’s preview counterpart, collects available strings, and delegates actual line styling/rendering to `status_line_from_segments`.

#### Function details

##### `StatusSurfacePreviewItem::placeholder`  (lines 40–70)

```
fn placeholder(self) -> &'static str
```

**Purpose**: Returns the built-in sample text for one preview item.

**Data flow**: Matches on a `StatusSurfacePreviewItem` and returns a static placeholder string such as `"codex"`, `"~/my-project/subdir"`, `"PR #123"`, or `"gpt-5.2-codex medium"`. It is pure and does not mutate state.

**Call relations**: Default preview-data initialization uses this to seed every item with a representative value before any runtime data is injected.


##### `StatusSurfacePreviewItem::iter`  (lines 72–103)

```
fn iter() -> impl Iterator<Item = Self>
```

**Purpose**: Provides the complete ordered list of preview items.

**Data flow**: Constructs a fixed array of all enum variants and returns its iterator. The order is explicit in source and reused by callers.

**Call relations**: The default preview-data builder iterates this list to populate placeholders, and tests can use it to inspect the full supported preview inventory.

*Call graph*: called by 2 (default, status_surface_preview_data).


##### `StatusSurfacePreviewData::default`  (lines 118–126)

```
fn default() -> Self
```

**Purpose**: Creates preview data populated entirely with placeholders for every known item.

**Data flow**: Initializes `values` as an empty `BTreeMap`, iterates all `StatusSurfacePreviewItem`s, and calls `set_placeholder(item, item.placeholder())` for each. It returns the fully seeded `StatusSurfacePreviewData`.

**Call relations**: Configuration views start from this baseline so previews remain complete even before live session metadata is available.

*Call graph*: calls 1 internal fn (iter); called by 1 (renders_title_setup_popup); 1 external calls (new).


##### `StatusSurfacePreviewData::from_iter`  (lines 130–140)

```
fn from_iter(values: I) -> Self
```

**Purpose**: Builds preview data from defaults plus a set of live overrides.

**Data flow**: Starts from `Self::default()`, consumes an iterator of `(StatusSurfacePreviewItem, V)` where `V: Into<String>`, and applies each pair through `set_live`. It returns the merged preview dataset.

**Call relations**: Tests and setup views use this to inject runtime-like values while preserving placeholders for everything not explicitly supplied.

*Call graph*: called by 5 (preview_includes_thread_title, preview_uses_placeholders_when_runtime_values_are_missing, preview_uses_runtime_values, setup_view_snapshot_uses_runtime_preview_values, status_surface_preview_data); 1 external calls (default).


##### `StatusSurfacePreviewData::set_live`  (lines 142–153)

```
fn set_live(&mut self, item: StatusSurfacePreviewItem, value: V)
```

**Purpose**: Stores a runtime value for one preview item and marks it as non-placeholder.

**Data flow**: Takes a mutable reference, an item key, and any `Into<String>` value, converts the value to `String`, and inserts a `PreviewValue { text, is_placeholder: false }` into the map.

**Call relations**: This is the authoritative path for replacing synthetic preview text with actual session data.

*Call graph*: 1 external calls (into).


##### `StatusSurfacePreviewData::set_placeholder`  (lines 155–173)

```
fn set_placeholder(&mut self, item: StatusSurfacePreviewItem, value: V)
```

**Purpose**: Stores placeholder text only when no live value already exists for that item.

**Data flow**: Checks the current map entry for the item; if a non-placeholder value is already present, it returns early. Otherwise it inserts `PreviewValue { text: value.into(), is_placeholder: true }`.

**Call relations**: Default initialization and later placeholder refreshes use this to avoid clobbering runtime values that were already loaded.

*Call graph*: 1 external calls (into).


##### `StatusSurfacePreviewData::suppress_placeholder`  (lines 175–183)

```
fn suppress_placeholder(&mut self, item: StatusSurfacePreviewItem)
```

**Purpose**: Removes an item entirely when its current value is still only a placeholder.

**Data flow**: Looks up the item, and if the stored `PreviewValue` exists and `is_placeholder` is true, removes that key from the map. Live values are left untouched.

**Call relations**: Callers use this when a field should disappear from previews unless real runtime data is available.


##### `StatusSurfacePreviewData::rate_limit_item_name`  (lines 185–194)

```
fn rate_limit_item_name(
        &self,
        item: StatusSurfacePreviewItem,
        fallback: &str,
    ) -> String
```

**Purpose**: Derives a picker-friendly rate-limit item identifier from a live preview string, with fallback text when no specialized mapping applies.

**Data flow**: Reads the live-only value for the given item via `live_value_for`, passes it to `rate_limit_preview_copy`, extracts `copy.name` when recognized, and otherwise returns `fallback.to_string()`.

**Call relations**: Title and status-line setup UIs call this for rate-limit rows so labels can reflect the actual limit type currently surfaced by runtime data.

*Call graph*: calls 1 internal fn (live_value_for); called by 2 (status_line_select_item, title_select_item).


##### `StatusSurfacePreviewData::rate_limit_item_description`  (lines 196–205)

```
fn rate_limit_item_description(
        &self,
        item: StatusSurfacePreviewItem,
        fallback: &str,
    ) -> String
```

**Purpose**: Derives a human-readable rate-limit description from a live preview string, falling back to static copy when needed.

**Data flow**: Fetches the live-only value, parses it with `rate_limit_preview_copy`, returns the matched `description` string when available, or clones the provided fallback.

**Call relations**: Used alongside `rate_limit_item_name` when building picker rows for dynamic rate-limit items.

*Call graph*: calls 1 internal fn (live_value_for); called by 2 (status_line_select_item, title_select_item).


##### `StatusSurfacePreviewData::value_for`  (lines 207–209)

```
fn value_for(&self, item: StatusSurfacePreviewItem) -> Option<&str>
```

**Purpose**: Returns the stored text for an item regardless of whether it is live or placeholder data.

**Data flow**: Looks up the item in the `BTreeMap` and maps the stored `PreviewValue` to `&str` over its `text` field. It returns `Option<&str>`.

**Call relations**: Preview renderers use this broad accessor when placeholders are acceptable for display.


##### `StatusSurfacePreviewData::live_value_for`  (lines 211–216)

```
fn live_value_for(&self, item: StatusSurfacePreviewItem) -> Option<&str>
```

**Purpose**: Returns the stored text only if the item currently has a non-placeholder value.

**Data flow**: Looks up the item, filters out entries whose `is_placeholder` flag is true, and returns the underlying `&str` text for live entries only.

**Call relations**: Rate-limit copy derivation depends on this stricter accessor so placeholder strings do not masquerade as real runtime metadata.

*Call graph*: called by 2 (rate_limit_item_description, rate_limit_item_name).


##### `StatusSurfacePreviewData::status_line_for_items`  (lines 218–231)

```
fn status_line_for_items(
        &self,
        items: I,
        use_theme_colors: bool,
    ) -> Option<Line<'static>>
```

**Purpose**: Builds a preview footer line for a selected set of `StatusLineItem`s using the stored preview values.

**Data flow**: Consumes an iterator of `StatusLineItem`, maps each item to its preview counterpart with `item.preview_item()`, looks up the corresponding text with `value_for`, converts found values into owned `(item, String)` segments, and passes the resulting iterator plus `use_theme_colors` to `status_line_from_segments`.

**Call relations**: Status-line setup UIs use this as the bridge from preview data to the actual styled footer-line renderer.

*Call graph*: 2 external calls (into_iter, status_line_from_segments).


##### `rate_limit_preview_copy`  (lines 239–279)

```
fn rate_limit_preview_copy(value: &str) -> Option<RateLimitPreviewCopy>
```

**Purpose**: Recognizes rate-limit preview strings by prefix and returns canonical item-copy metadata for them.

**Data flow**: Trims leading whitespace from `value`, checks a sequence of `starts_with` prefixes such as `secondary usage `, `usage `, `5h `, `daily `, `weekly `, `monthly `, and `annual `, and returns a `RateLimitPreviewCopy { name, description }` for the first match or `None` otherwise.

**Call relations**: The preview-data methods for rate-limit names and descriptions delegate here to centralize the string-prefix mapping logic.


### `tui/src/public_widgets/mod.rs`

`orchestration` · `cross-cutting`

This module is a minimal namespace wrapper whose sole job is to publish `composer_input` as a `pub(crate)` submodule. Even though the file contains no runtime logic, it establishes an architectural boundary: widgets placed under `public_widgets` are treated as reusable UI building blocks rather than private implementation details of a single screen. By routing access through this module, the crate can grow a curated set of shared widgets without exposing every internal UI helper indiscriminately. The current contents indicate that the composer input component is one such shared widget, likely used anywhere the TUI needs editable text entry with consistent behavior and styling. The absence of re-exports means consumers are expected to reference items through `public_widgets::composer_input`, preserving module identity and keeping the API surface explicit. In practice this file participates during compilation and module resolution rather than at runtime, but it matters for maintainability because it signals which widgets are stable enough for broader internal reuse.


### Terminal runtime and ownership
These files establish terminal capabilities, runtime shell behavior, suspend/resume handling, notifications, and low-level terminal ownership mechanics for the TUI.

### `tui/src/resize_reflow_cap.rs`

`config` · `config load`

This module translates `TerminalResizeReflowConfig` into an `Option<usize>` row cap used by resize reflow and initial replay. The public entrypoint, `resize_reflow_max_rows`, gathers runtime terminal metadata via `terminal_info()` and separately probes whether the process is running inside the VS Code terminal, then forwards both signals to a pure helper. The helper distinguishes three config modes: `Auto`, `Disabled`, and `Limit(max_rows)`. `Disabled` maps to `None`, which is the explicit "no cap" case; `Limit` returns the configured number unchanged; `Auto` delegates to a terminal-name lookup.

The auto lookup is intentionally conservative and hard-coded. VS Code wins first if the environment probe says so, even when terminal metadata points at a host shell. Otherwise, known terminals map to constants such as 1,000 rows for VS Code, 9,001 for Windows Terminal, 3,500 for WezTerm, and 10,000 for Alacritty. Everything else—including Apple Terminal, Kitty, Konsole, VTE-based terminals, `Dumb`, and `Unknown`—falls back to `DEFAULT_TERMINAL_RESIZE_REFLOW_FALLBACK_MAX_ROWS`. The tests cover default selection, VS Code probe precedence, explicit override behavior, disabled behavior, and the fact that an unknown terminal under a multiplexer still uses the fallback rather than trying to infer a larger cap.

#### Function details

##### `resize_reflow_max_rows`  (lines 29–35)

```
fn resize_reflow_max_rows(config: TerminalResizeReflowConfig) -> Option<usize>
```

**Purpose**: Resolves the effective resize-reflow row cap from config plus live terminal detection.

**Data flow**: Takes a `TerminalResizeReflowConfig`, reads current `TerminalInfo` from `terminal_info()` and a boolean from `crate::tui::running_in_vscode_terminal()`, passes them to `resize_reflow_max_rows_for`, and returns the resulting `Option<usize>`.

**Call relations**: This is the runtime-facing wrapper used by the rest of the TUI; it exists to gather environment-dependent inputs before delegating the actual decision logic to the pure helper.

*Call graph*: calls 2 internal fn (resize_reflow_max_rows_for, running_in_vscode_terminal); called by 1 (resize_reflow_max_rows); 1 external calls (terminal_info).


##### `resize_reflow_max_rows_for`  (lines 37–50)

```
fn resize_reflow_max_rows_for(
    config: TerminalResizeReflowConfig,
    terminal: &TerminalInfo,
    running_in_vscode_terminal: bool,
) -> Option<usize>
```

**Purpose**: Maps the config enum to either an explicit limit, no limit, or an auto-detected terminal default.

**Data flow**: Consumes `config.max_rows`, reads `terminal.name` and the VS Code probe flag, and returns `Some(limit)`, `None`, or `Some(auto_resize_reflow_max_rows(...))` depending on the variant.

**Call relations**: It is called by the public wrapper and centralizes the config branching so tests can exercise the logic without depending on process environment.

*Call graph*: calls 1 internal fn (auto_resize_reflow_max_rows); called by 1 (resize_reflow_max_rows).


##### `auto_resize_reflow_max_rows`  (lines 52–76)

```
fn auto_resize_reflow_max_rows(
    terminal_name: TerminalName,
    running_in_vscode_terminal: bool,
) -> usize
```

**Purpose**: Chooses a conservative default row cap for a detected terminal, with a special override for VS Code.

**Data flow**: Takes a `TerminalName` and `running_in_vscode_terminal` flag; if the flag is true it immediately returns the VS Code constant, otherwise it matches the terminal name and returns one of the terminal-specific constants or the fallback constant.

**Call relations**: This is the terminal-policy core used only from `resize_reflow_max_rows_for`; the tests target it directly to validate the mapping table.

*Call graph*: called by 1 (resize_reflow_max_rows_for).


##### `tests::test_terminal`  (lines 83–91)

```
fn test_terminal(name: TerminalName) -> TerminalInfo
```

**Purpose**: Builds a minimal `TerminalInfo` fixture with a chosen terminal name and all optional metadata absent.

**Data flow**: Accepts a `TerminalName`, constructs a `TerminalInfo` with that name and `None` for `term_program`, `version`, `term`, and `multiplexer`, and returns it.

**Call relations**: The config-oriented tests use it to avoid repeating boilerplate when calling `resize_reflow_max_rows_for`.


##### `tests::auto_resize_reflow_max_rows_uses_terminal_defaults`  (lines 94–122)

```
fn auto_resize_reflow_max_rows_uses_terminal_defaults()
```

**Purpose**: Checks that known terminal names map to the expected hard-coded defaults and unknown-like terminals use the fallback.

**Data flow**: Defines a table of `(TerminalName, expected_max_rows)` pairs, iterates through them, calls `auto_resize_reflow_max_rows(..., false)`, and asserts equality for each case.

**Call relations**: This test exercises the normal auto-detection branch without the VS Code environment override.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::auto_resize_reflow_max_rows_prefers_vscode_probe`  (lines 125–133)

```
fn auto_resize_reflow_max_rows_prefers_vscode_probe()
```

**Purpose**: Confirms that the explicit VS Code environment probe overrides conflicting terminal-name metadata.

**Data flow**: Calls `auto_resize_reflow_max_rows` with `TerminalName::WindowsTerminal` and `running_in_vscode_terminal = true`, then asserts the result is the VS Code cap.

**Call relations**: It validates the early-return branch that intentionally supersedes terminal-name matching.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::configured_resize_reflow_max_rows_overrides_auto_detection`  (lines 136–148)

```
fn configured_resize_reflow_max_rows_overrides_auto_detection()
```

**Purpose**: Verifies that an explicit numeric config limit wins over terminal defaults.

**Data flow**: Creates a `TerminalInfo` fixture and a `TerminalResizeReflowConfig` with `TerminalResizeReflowMaxRows::Limit(42)`, passes them to `resize_reflow_max_rows_for`, and asserts the result is `Some(42)`.

**Call relations**: This test covers the `Limit` branch in the config matcher rather than the auto-detection path.

*Call graph*: 3 external calls (assert_eq!, Limit, test_terminal).


##### `tests::disabled_resize_reflow_max_rows_keeps_all_rows`  (lines 151–163)

```
fn disabled_resize_reflow_max_rows_keeps_all_rows()
```

**Purpose**: Verifies that disabling the cap produces `None` rather than a numeric limit.

**Data flow**: Builds a terminal fixture and config with `TerminalResizeReflowMaxRows::Disabled`, calls `resize_reflow_max_rows_for`, and asserts the return value is `None`.

**Call relations**: It exercises the explicit opt-out branch that signals unlimited replay.

*Call graph*: 2 external calls (assert_eq!, test_terminal).


##### `tests::unknown_terminal_uses_fallback_even_under_multiplexer`  (lines 166–182)

```
fn unknown_terminal_uses_fallback_even_under_multiplexer()
```

**Purpose**: Checks that an unknown terminal still uses the fallback cap even when `TERM` and multiplexer metadata are present.

**Data flow**: Constructs a `TerminalInfo` with `name = Unknown`, `term = Some("xterm-256color")`, and `multiplexer = Some(Tmux { ... })`, uses the default config, calls `resize_reflow_max_rows_for`, and asserts the fallback constant is returned.

**Call relations**: This test documents that the module does not try to infer a larger cap from multiplexer context when terminal identity is unknown.

*Call graph*: 2 external calls (assert_eq!, default).


### `tui/src/tui.rs`

`orchestration` · `startup and main loop`

This file is the core orchestration layer for the TUI. It defines terminal initialization (`init`), terminal mode transitions (`set_modes`, `restore`, `restore_after_exit`, `restore_keep_raw`), the `Tui` struct that owns the active `CustomTerminal<CrosstermBackend<Stdout>>`, and the draw/event plumbing used by the rest of the application. Initialization validates that stdin/stdout are terminals, enables bracketed paste, focus change, raw mode, keyboard enhancement, flushes buffered input, installs a panic hook that restores the terminal on crash, probes startup terminal capabilities, and installs a stderr guard to keep unmanaged writes out of the inline viewport.

`Tui` stores a `FrameRequester`, a broadcast sender for draw notifications, a shared `EventBroker`, pending history batches grouped by `HistoryLineWrapPolicy`, pet-image render state, alternate-screen bookkeeping, focus state, notification backend/config, Zellij detection, and a guard for stderr suppression. The draw path has two variants: legacy `draw`, which may use a cursor-position heuristic (`pending_viewport_area`) to preserve viewport placement across resize, and `draw_with_resize_reflow`, which instead uses `update_inline_viewport_for_resize_reflow` and expects transcript reflow to rebuild history above the viewport. Both paths run inside `stdout().sync_update`, flush pending history lines before drawing, and update Unix suspend cursor state.

The file also defines custom ANSI-only crossterm commands for alternate scroll mode, desktop notification gating via focus state, temporary terminal restoration around external interactive programs (`with_restored`), and helper functions for viewport clearing and platform-specific virtual-terminal processing.

#### Function details

##### `running_in_vscode_terminal`  (lines 76–78)

```
fn running_in_vscode_terminal() -> bool
```

**Purpose**: Exposes the keyboard-mode module’s VS Code terminal detection through the `tui` module API.

**Data flow**: Takes no arguments, delegates to `keyboard_modes::running_in_vscode_terminal()`, and returns the resulting `bool`.

**Call relations**: Called by resize-related logic elsewhere in the TUI crate that needs environment-sensitive behavior without depending directly on the keyboard-modes submodule.

*Call graph*: calls 1 internal fn (running_in_vscode_terminal); called by 1 (resize_reflow_max_rows).


##### `should_emit_notification`  (lines 80–85)

```
fn should_emit_notification(condition: NotificationCondition, terminal_focused: bool) -> bool
```

**Purpose**: Applies the configured notification policy to the current terminal focus state.

**Data flow**: Consumes a `NotificationCondition` and `terminal_focused: bool`; returns `true` for `Always`, and for `Unfocused` only when the terminal is not focused.

**Call relations**: Used exclusively by `Tui::notify` as the policy gate before attempting desktop notification delivery.

*Call graph*: called by 1 (notify).


##### `Tui::drop`  (lines 88–92)

```
fn drop(&mut self)
```

**Purpose**: Best-effort cleanup hook that clears any ambient pet image when the `Tui` instance is dropped.

**Data flow**: Uses `&mut self`, calls `clear_ambient_pet_image()`, logs a debug message if that returns an error, and otherwise performs no further state changes.

**Call relations**: Runs automatically at object teardown. It delegates cleanup to the pet-image renderer path rather than duplicating terminal-clearing logic.

*Call graph*: calls 1 internal fn (clear_ambient_pet_image); 1 external calls (debug!).


##### `tests::unfocused_notification_condition_is_suppressed_when_focused`  (lines 108–113)

```
fn unfocused_notification_condition_is_suppressed_when_focused()
```

**Purpose**: Tests that the `Unfocused` notification policy blocks notifications while the terminal is focused.

**Data flow**: Calls `should_emit_notification(NotificationCondition::Unfocused, true)` and asserts the result is false.

**Call relations**: Documents the negative branch of the notification policy helper.

*Call graph*: 1 external calls (assert!).


##### `tests::always_notification_condition_emits_when_focused`  (lines 116–121)

```
fn always_notification_condition_emits_when_focused()
```

**Purpose**: Tests that the `Always` notification policy allows notifications even when focused.

**Data flow**: Calls `should_emit_notification(NotificationCondition::Always, true)` and asserts the result is true.

**Call relations**: Covers the unconditional branch used by `Tui::notify`.

*Call graph*: 1 external calls (assert!).


##### `tests::unfocused_notification_condition_emits_when_unfocused`  (lines 124–129)

```
fn unfocused_notification_condition_emits_when_unfocused()
```

**Purpose**: Tests that the `Unfocused` policy emits when focus has been lost.

**Data flow**: Calls `should_emit_notification(NotificationCondition::Unfocused, false)` and asserts the result is true.

**Call relations**: Completes the focus-policy matrix for notification gating.

*Call graph*: 1 external calls (assert!).


##### `tests::first_viewport_change_clears_from_new_viewport_when_old_viewport_is_empty`  (lines 132–170)

```
fn first_viewport_change_clears_from_new_viewport_when_old_viewport_is_empty()
```

**Purpose**: Verifies that the first viewport transition clears stale cells starting at the new viewport top when no previous viewport existed.

**Data flow**: Builds a VT100-backed custom terminal with cursor position `(0,1)`, writes shell/stale content into the backend, calls `clear_for_viewport_change` with a viewport beginning on row 1, then inspects rendered rows and asserts shell content above remains while stale viewport content is erased.

**Call relations**: Exercises the startup edge case in `clear_for_viewport_change` that avoids leaving shell text visible inside the new viewport.

*Call graph*: calls 2 internal fn (new, clear_for_viewport_change); 4 external calls (with_options_and_cursor_position, new, assert!, write!).


##### `set_modes`  (lines 173–189)

```
fn set_modes() -> Result<()>
```

**Purpose**: Puts the terminal into the interactive mode expected by the TUI.

**Data flow**: Ensures virtual-terminal processing is enabled, emits `EnableBracketedPaste`, enables raw mode, asks `keyboard_modes` to enable keyboard enhancement if appropriate, best-effort enables focus-change reporting, and returns `Result<()>` with the first hard failure.

**Call relations**: Called during `init` and after temporary terminal release in `Tui::with_restored`. It delegates keyboard-specific setup to the keyboard-modes module and low-level mode toggles to crossterm.

*Call graph*: calls 2 internal fn (ensure_virtual_terminal_processing, enable_keyboard_enhancement); called by 2 (with_restored, init); 2 external calls (execute!, enable_raw_mode).


##### `EnableAlternateScroll::write_ansi`  (lines 195–197)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Serializes the ANSI escape sequence that enables alternate-scroll behavior in terminals that support it.

**Data flow**: Writes `\x1b[?1007h` into the provided formatter and returns `fmt::Result`.

**Call relations**: Used when entering alternate screen or restoring it after suspend so mouse wheel input may be translated to arrow keys by the terminal.

*Call graph*: 1 external calls (write!).


##### `EnableAlternateScroll::execute_winapi`  (lines 200–204)

```
fn execute_winapi(&self) -> Result<()>
```

**Purpose**: Rejects WinAPI execution for this command, forcing ANSI-path usage on Windows.

**Data flow**: Returns an `io::Error` indicating ANSI must be used instead of legacy WinAPI execution.

**Call relations**: Part of the `Command` implementation; only relevant on Windows builds.

*Call graph*: 1 external calls (other).


##### `EnableAlternateScroll::is_ansi_code_supported`  (lines 207–209)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Declares that the alternate-scroll command is supported through ANSI output on Windows.

**Data flow**: Returns `true`.

**Call relations**: Supports crossterm command dispatch for the custom command type.


##### `DisableAlternateScroll::write_ansi`  (lines 216–218)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Serializes the ANSI escape sequence that disables alternate-scroll behavior.

**Data flow**: Writes `\x1b[?1007l` into the provided formatter and returns `fmt::Result`.

**Call relations**: Used when leaving alternate screen or suspending out of it so terminal scrolling behavior returns to normal.

*Call graph*: 1 external calls (write!).


##### `DisableAlternateScroll::execute_winapi`  (lines 221–225)

```
fn execute_winapi(&self) -> Result<()>
```

**Purpose**: Rejects WinAPI execution for the disable command, requiring ANSI output instead.

**Data flow**: Returns an `io::Error` explaining that ANSI must be used.

**Call relations**: Windows-only branch of the custom `Command` implementation.

*Call graph*: 1 external calls (other).


##### `DisableAlternateScroll::is_ansi_code_supported`  (lines 228–230)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Declares ANSI support for the disable command on Windows.

**Data flow**: Returns `true`.

**Call relations**: Completes the custom command implementation contract.


##### `restore_common`  (lines 245–276)

```
fn restore_common(
    raw_mode_restore: RawModeRestore,
    keyboard_restore: KeyboardRestore,
) -> Result<()>
```

**Purpose**: Performs the shared terminal teardown sequence used by the various restore modes.

**Data flow**: Takes `RawModeRestore` and `KeyboardRestore` enums, ensures VT processing, restores keyboard reporting either by stack pop or stronger reset, disables bracketed paste and focus change, optionally disables raw mode, restores default cursor style and visibility, and returns the first encountered `io::Error` if any step fails.

**Call relations**: This is the common worker behind `restore`, `restore_after_exit`, and `restore_keep_raw`. It centralizes the ordering of keyboard reset, raw-mode handling, and cursor restoration.

*Call graph*: calls 3 internal fn (ensure_virtual_terminal_processing, reset_keyboard_reporting_after_exit, restore_keyboard_enhancement_stack); called by 3 (restore, restore_after_exit, restore_keep_raw); 3 external calls (execute!, matches!, disable_raw_mode).


##### `restore`  (lines 280–282)

```
fn restore() -> Result<()>
```

**Purpose**: Fully restores the terminal to its normal state, including disabling raw mode.

**Data flow**: Calls `restore_common(RawModeRestore::Disable, KeyboardRestore::PopStack)` and returns its `Result<()>`.

**Call relations**: Used as the normal inverse of `set_modes`, including by `RestoreMode::restore` and suspend/exit paths.

*Call graph*: calls 1 internal fn (restore_common); called by 1 (restore).


##### `reapply_raw_mode_after_resume`  (lines 291–294)

```
fn reapply_raw_mode_after_resume() -> Result<()>
```

**Purpose**: On Unix, forces crossterm’s cached raw-mode state to resynchronize with the kernel after job-control resume.

**Data flow**: Calls `disable_raw_mode()` and then `enable_raw_mode()`, returning any resulting `io::Error`.

**Call relations**: Invoked by Unix suspend/resume handling after `SIGCONT` to recover from shell termios races.

*Call graph*: 2 external calls (disable_raw_mode, enable_raw_mode).


##### `restore_after_exit`  (lines 300–311)

```
fn restore_after_exit() -> Result<()>
```

**Purpose**: Restores terminal state for process exit using a stronger keyboard reset and final stderr restoration.

**Data flow**: Calls `restore_common` with `ResetAfterExit`, then calls `terminal_stderr::finish()`, preserving and returning the first error encountered across both phases.

**Call relations**: Used by panic handling and shutdown paths where the parent shell must be left in a clean state even if normal keyboard stack pairing was disrupted.

*Call graph*: calls 2 internal fn (restore_common, finish); called by 2 (restore, restore).


##### `restore_keep_raw`  (lines 314–316)

```
fn restore_keep_raw() -> Result<()>
```

**Purpose**: Restores terminal features like paste/focus/cursor state while intentionally leaving raw mode enabled.

**Data flow**: Calls `restore_common(RawModeRestore::Keep, KeyboardRestore::PopStack)` and returns its result.

**Call relations**: Selected by `RestoreMode::KeepRaw` for external programs that still expect raw mode.

*Call graph*: calls 1 internal fn (restore_common); called by 1 (restore).


##### `RestoreMode::restore`  (lines 326–331)

```
fn restore(self) -> Result<()>
```

**Purpose**: Dispatches a `RestoreMode` enum value to the corresponding restore routine.

**Data flow**: Matches on `self`; `Full` calls `restore()`, `KeepRaw` calls `restore_keep_raw()`, and returns the resulting `Result<()>`.

**Call relations**: Used by `Tui::with_restored` to choose how much terminal state to relinquish around an external interactive action.

*Call graph*: calls 2 internal fn (restore, restore_keep_raw); called by 1 (with_restored).


##### `flush_terminal_input_buffer`  (lines 371–371)

```
fn flush_terminal_input_buffer()
```

**Purpose**: Clears buffered terminal input so stale keystrokes or terminal responses do not leak into later event handling.

**Data flow**: On Unix, calls `libc::tcflush(STDIN_FILENO, TCIFLUSH)` and logs a warning on failure; on other platforms this file provides platform-specific variants or a no-op. Returns `()`.

**Call relations**: Called during `init`, after `with_restored`, and from Unix suspend/resume support to discard input accumulated while the event stream was dropped or terminal ownership changed.

*Call graph*: called by 2 (with_restored, init); 3 external calls (last_os_error, tcflush, warn!).


##### `init`  (lines 374–463)

```
fn init() -> Result<InitializedTerminal>
```

**Purpose**: Initializes terminal ownership for the TUI and returns the fully prepared terminal plus capability metadata.

**Data flow**: Checks that stdin and stdout are terminals, calls `set_modes`, flushes input, installs the panic hook, constructs a `CrosstermBackend`, probes startup terminal capabilities (Unix) or cursor position/keyboard support via crossterm (non-Unix), optionally probes Windows default colors, creates the `CustomTerminal` at the discovered cursor position, installs `TerminalStderrGuard`, and returns `InitializedTerminal { terminal, enhanced_keys_supported, stderr_guard }`.

**Call relations**: Called by the outer app startup path before constructing `Tui`. It orchestrates several subsystems: keyboard modes, terminal probing, palette initialization, panic recovery, and stderr suppression.

*Call graph*: calls 9 internal fn (startup, cursor_position_with_crossterm, detect_keyboard_enhancement_supported, flush_terminal_input_buffer, keyboard_enhancement_disabled, probe_windows_default_colors, set_modes, set_panic_hook, install); called by 1 (run_ratatui_app); 9 external calls (new, with_options_and_cursor_position, other, set_default_colors_from_startup_probe, stdin, stdout, now, info!, warn!).


##### `cursor_position_with_crossterm`  (lines 466–471)

```
fn cursor_position_with_crossterm(backend: &mut CrosstermBackend<Stdout>) -> Position
```

**Purpose**: Reads the initial cursor position through the backend on non-Unix platforms, defaulting safely on failure.

**Data flow**: Takes a mutable `CrosstermBackend<Stdout>`, calls `get_cursor_position()`, returns the reported `Position` or logs a warning and returns `(0,0)`.

**Call relations**: Used only by non-Unix `init` as the fallback startup cursor-position path.

*Call graph*: called by 1 (init); 1 external calls (get_cursor_position).


##### `detect_keyboard_enhancement_supported`  (lines 474–478)

```
fn detect_keyboard_enhancement_supported() -> bool
```

**Purpose**: Queries crossterm’s platform-specific keyboard enhancement support on non-Unix systems.

**Data flow**: Calls `supports_keyboard_enhancement()` and returns the reported bool, defaulting to `false` if the probe fails or is unavailable.

**Call relations**: Used only by non-Unix `init` to populate `enhanced_keys_supported`.

*Call graph*: called by 1 (init); 1 external calls (supports_keyboard_enhancement).


##### `probe_windows_default_colors`  (lines 481–500)

```
fn probe_windows_default_colors()
```

**Purpose**: Runs the Windows default-color probe and stores the result in the terminal palette cache.

**Data flow**: Measures elapsed time, calls `crate::terminal_probe::default_colors`, logs success or failure, and passes either the discovered colors or `None` to `terminal_palette::set_default_colors_from_startup_probe`.

**Call relations**: Called during Windows initialization to populate palette defaults independently of the Unix startup probe path.

*Call graph*: calls 1 internal fn (default_colors); called by 1 (init); 4 external calls (set_default_colors_from_startup_probe, now, info!, warn!).


##### `set_panic_hook`  (lines 502–508)

```
fn set_panic_hook()
```

**Purpose**: Installs a panic hook that restores terminal state before delegating to the previous panic hook.

**Data flow**: Takes the current panic hook, wraps it in a new closure that calls `restore_after_exit()` best-effort and then invokes the original hook with the panic info.

**Call relations**: Called during `init` so crashes do not leave raw mode, bracketed paste, or stderr suppression active.

*Call graph*: called by 1 (init); 3 external calls (new, set_hook, take_hook).


##### `clear_for_viewport_change`  (lines 556–566)

```
fn clear_for_viewport_change(terminal: &mut CustomTerminal<B>, new_area: Rect) -> Result<()>
```

**Purpose**: Clears terminal content from the appropriate row when the inline viewport changes.

**Data flow**: Given a mutable `CustomTerminal<B>` and `new_area: Rect`, chooses the clear start position as `new_area.as_position()` if the current `viewport_area` is empty, otherwise the old viewport’s top-left position, then calls `clear_after_position` and returns its `Result<()>`.

**Call relations**: Used by the legacy draw path and tested directly for the startup case where no previous viewport exists.

*Call graph*: called by 1 (first_viewport_change_clears_from_new_viewport_when_old_viewport_is_empty); 2 external calls (clear_after_position, as_position).


##### `Tui::new`  (lines 569–602)

```
fn new(
        terminal: Terminal,
        enhanced_keys_supported: bool,
        stderr_guard: terminal_stderr::TerminalStderrGuard,
    ) -> Self
```

**Purpose**: Constructs a `Tui` instance with draw scheduling, event broker, viewport state, notification defaults, and platform-specific helpers initialized.

**Data flow**: Consumes a prepared `terminal`, `enhanced_keys_supported`, and `stderr_guard`; creates a broadcast channel and `FrameRequester`, warms color caches, detects whether the terminal is Zellij, initializes pet-image state, alt-screen/focus atomics, notification backend and condition defaults, Unix suspend context, and stores all fields in `Self`.

**Call relations**: Called after `init` by higher-level app startup. It wires together the frame scheduler, shared event broker, terminal ownership state, and notification subsystem.

*Call graph*: calls 4 internal fn (detect_backend, new, new, new); 10 external calls (new, new, channel, terminal_info, default, default, default_colors, on_cached, default, vec!).


##### `Tui::set_alt_screen_enabled`  (lines 605–607)

```
fn set_alt_screen_enabled(&mut self, enabled: bool)
```

**Purpose**: Enables or disables use of alternate screen mode for this TUI instance.

**Data flow**: Writes the provided `enabled: bool` into `self.alt_screen_enabled` and returns `()`. No immediate terminal command is emitted.

**Call relations**: A configuration setter that affects later `enter_alt_screen` and `leave_alt_screen` calls.


##### `Tui::set_notification_settings`  (lines 609–616)

```
fn set_notification_settings(
        &mut self,
        method: NotificationMethod,
        condition: NotificationCondition,
    )
```

**Purpose**: Updates the desktop notification backend and focus policy from configuration.

**Data flow**: Consumes a `NotificationMethod` and `NotificationCondition`, rebuilds `self.notification_backend` via `detect_backend(method)`, stores the condition, and returns `()`.

**Call relations**: Called when app configuration changes or is applied after startup; later used by `Tui::notify`.

*Call graph*: calls 1 internal fn (detect_backend).


##### `Tui::frame_requester`  (lines 618–620)

```
fn frame_requester(&self) -> FrameRequester
```

**Purpose**: Returns a cloneable handle for scheduling future draw notifications.

**Data flow**: Clones `self.frame_requester` and returns the clone.

**Call relations**: Used internally when history insertion queues work and by external code that needs to request redraws without direct access to the scheduler task.

*Call graph*: called by 1 (insert_history_hyperlink_lines_with_wrap_policy); 1 external calls (clone).


##### `Tui::enhanced_keys_supported`  (lines 622–624)

```
fn enhanced_keys_supported(&self) -> bool
```

**Purpose**: Reports whether startup probing determined that enhanced keyboard reporting is supported.

**Data flow**: Returns the stored `self.enhanced_keys_supported` boolean.

**Call relations**: Read by higher-level UI logic that may adapt key handling based on terminal capability.


##### `Tui::is_alt_screen_active`  (lines 626–628)

```
fn is_alt_screen_active(&self) -> bool
```

**Purpose**: Reports whether the TUI currently considers alternate screen mode active.

**Data flow**: Loads `self.alt_screen_active` with relaxed atomic ordering and returns the bool.

**Call relations**: Used by `with_restored` and potentially other callers to decide whether alternate-screen teardown/restoration is needed.

*Call graph*: called by 1 (with_restored).


##### `Tui::pause_events`  (lines 631–633)

```
fn pause_events(&mut self)
```

**Purpose**: Drops the shared crossterm event source so stdin is fully relinquished.

**Data flow**: Calls `self.event_broker.pause_events()` and returns `()`. No local fields are otherwise changed.

**Call relations**: Used by `with_restored` before running external interactive programs and by suspend logic indirectly through the event stream.

*Call graph*: called by 1 (with_restored).


##### `Tui::resume_events`  (lines 637–639)

```
fn resume_events(&mut self)
```

**Purpose**: Recreates the shared event source so stdin polling resumes.

**Data flow**: Calls `self.event_broker.resume_events()` and returns `()`. The broker wakes paused streams through its watch channel.

**Call relations**: Used by `with_restored` after terminal ownership returns.

*Call graph*: called by 1 (with_restored).


##### `Tui::with_restored`  (lines 646–684)

```
async fn with_restored(&mut self, mode: RestoreMode, f: F) -> R
```

**Purpose**: Temporarily releases terminal ownership around an async external operation, then restores the TUI environment afterward.

**Data flow**: Pauses events, conditionally leaves alt screen, restores terminal modes according to `RestoreMode`, pauses stderr suppression, awaits the provided future `f`, resumes stderr suppression, reapplies TUI modes with `set_modes`, flushes buffered input, re-enters alt screen if it had been active, resumes events, and returns the future’s output `R`.

**Call relations**: This is the main handoff path for launching editors or other interactive subprocesses. It coordinates event broker state, alt-screen state, terminal mode restoration, and stderr suppression in a strict sequence.

*Call graph*: calls 10 internal fn (restore, enter_alt_screen, is_alt_screen_active, leave_alt_screen, pause_events, resume_events, flush_terminal_input_buffer, set_modes, pause, resume); 1 external calls (warn!).


##### `Tui::notify`  (lines 688–712)

```
fn notify(&mut self, message: impl AsRef<str>) -> bool
```

**Purpose**: Attempts to emit a desktop notification, respecting focus policy and disabling the backend after a delivery failure.

**Data flow**: Reads `terminal_focused`, checks `should_emit_notification`, returns false immediately if policy blocks or no backend exists, converts the message to `String`, calls `backend.notify(&message)`, returns true on success, or logs a warning, clears `self.notification_backend`, and returns false on error.

**Call relations**: Called by higher-level app logic when user-visible events occur. It delegates policy to `should_emit_notification` and backend-specific delivery to the selected notification backend.

*Call graph*: calls 1 internal fn (should_emit_notification); 2 external calls (as_ref, warn!).


##### `Tui::event_stream`  (lines 714–730)

```
fn event_stream(&self) -> Pin<Box<dyn Stream<Item = TuiEvent> + Send + 'static>>
```

**Purpose**: Builds a boxed async stream that merges draw notifications with terminal input events.

**Data flow**: Subscribes to `self.draw_tx`, clones shared state (`event_broker`, `terminal_focused`, and on Unix suspend/alt-screen state), constructs `TuiEventStream`, boxes and pins it, and returns `Pin<Box<dyn Stream<Item = TuiEvent> + Send + 'static>>`.

**Call relations**: Used by the main app loop to consume `TuiEvent`s. It wires this file’s state into the lower-level event-stream module.

*Call graph*: calls 1 internal fn (new); 3 external calls (pin, subscribe, clone).


##### `Tui::enter_alt_screen`  (lines 734–753)

```
fn enter_alt_screen(&mut self) -> Result<()>
```

**Purpose**: Switches the terminal into alternate screen mode and expands the viewport to the full terminal size.

**Data flow**: If `alt_screen_enabled` is false, returns `Ok(())` immediately. Otherwise emits `EnterAlternateScreen` and `EnableAlternateScroll`, queries terminal size, saves the current inline viewport into `alt_saved_viewport`, sets viewport area to the full screen rect, clears the terminal, marks `alt_screen_active` true, and returns `Ok(())`.

**Call relations**: Called when overlay-style full-screen UI is entered and by `with_restored` when restoring a previously active alt screen.

*Call graph*: calls 3 internal fn (clear, set_viewport_area, size); called by 1 (with_restored); 2 external calls (execute!, new).


##### `Tui::leave_alt_screen`  (lines 756–768)

```
fn leave_alt_screen(&mut self) -> Result<()>
```

**Purpose**: Leaves alternate screen mode and restores the previously saved inline viewport.

**Data flow**: If alt screen is disabled, returns `Ok(())`. Otherwise emits `DisableAlternateScroll` and `LeaveAlternateScreen`, restores `self.alt_saved_viewport` into the terminal if present, marks `alt_screen_active` false, and returns `Ok(())`.

**Call relations**: Called before external interactive handoff in `with_restored` and when overlay UI exits.

*Call graph*: calls 1 internal fn (set_viewport_area); called by 1 (with_restored); 1 external calls (execute!).


##### `Tui::insert_history_lines`  (lines 770–772)

```
fn insert_history_lines(&mut self, lines: Vec<Line<'static>>)
```

**Purpose**: Queues plain ratatui `Line` values for insertion above the viewport using the default pre-wrap policy.

**Data flow**: Consumes `Vec<Line<'static>>`, forwards it to `insert_history_lines_with_wrap_policy` with `HistoryLineWrapPolicy::PreWrap`, and returns `()`.

**Call relations**: Convenience wrapper for callers that do not need hyperlink-aware or custom wrap-policy insertion.

*Call graph*: calls 1 internal fn (insert_history_lines_with_wrap_policy).


##### `Tui::insert_history_lines_with_wrap_policy`  (lines 774–783)

```
fn insert_history_lines_with_wrap_policy(
        &mut self,
        lines: Vec<Line<'static>>,
        wrap_policy: HistoryLineWrapPolicy,
    )
```

**Purpose**: Converts plain lines into hyperlink-aware lines and queues them with an explicit wrap policy.

**Data flow**: Takes `Vec<Line<'static>>` and a `HistoryLineWrapPolicy`, converts the lines via `plain_hyperlink_lines`, forwards them to `insert_history_hyperlink_lines_with_wrap_policy`, and returns `()`.

**Call relations**: Intermediate adapter between plain text history producers and the hyperlink-aware insertion buffer.

*Call graph*: calls 2 internal fn (plain_hyperlink_lines, insert_history_hyperlink_lines_with_wrap_policy); called by 1 (insert_history_lines).


##### `Tui::insert_history_hyperlink_lines_with_wrap_policy`  (lines 785–802)

```
fn insert_history_hyperlink_lines_with_wrap_policy(
        &mut self,
        lines: Vec<HyperlinkLine>,
        wrap_policy: HistoryLineWrapPolicy,
    )
```

**Purpose**: Buffers hyperlink-capable history lines for later insertion above the viewport, coalescing adjacent batches with the same wrap policy.

**Data flow**: If `lines` is empty, returns immediately. Otherwise it either extends the last `PendingHistoryLines` batch when `wrap_policy` matches, or pushes a new batch. It then clones a `FrameRequester` via `frame_requester()` and schedules a redraw.

**Call relations**: Called by the plain-line wrapper and by hyperlink-aware callers. The buffered lines are later consumed by `flush_pending_history_lines` during drawing.

*Call graph*: calls 1 internal fn (frame_requester); called by 1 (insert_history_lines_with_wrap_policy).


##### `Tui::clear_pending_history_lines`  (lines 804–806)

```
fn clear_pending_history_lines(&mut self)
```

**Purpose**: Drops any queued history insertion batches that have not yet been flushed to the terminal.

**Data flow**: Clears `self.pending_history_lines` and returns `()`.

**Call relations**: Used when pending history should be discarded rather than emitted on the next draw.


##### `Tui::update_inline_viewport_for_resize_reflow`  (lines 813–849)

```
fn update_inline_viewport_for_resize_reflow(
        terminal: &mut Terminal,
        height: u16,
    ) -> Result<bool>
```

**Purpose**: Adjusts the inline viewport for the resize-reflow draw path without performing the legacy scroll-above-viewport behavior on shrink.

**Data flow**: Reads current terminal size and `last_known_screen_size`, computes whether height shrank or grew and whether the viewport was bottom-aligned, updates viewport width and clamped height, conditionally scrolls rows above the viewport upward only when needed and not on shrink, repositions `area.y` when bottom overflow or bottom-aligned growth occurs, clears from the minimum old/new top row if the viewport changed, updates the terminal viewport, and returns `Ok(needs_full_repaint)`.

**Call relations**: Used only by `draw_with_resize_reflow`. It preserves the invariant that transcript reflow, not viewport scrolling, owns rebuilding rows above the viewport during resize-sensitive rendering.

*Call graph*: calls 4 internal fn (backend_mut, clear_after_position, set_viewport_area, size); 1 external calls (new).


##### `Tui::flush_pending_history_lines`  (lines 852–876)

```
fn flush_pending_history_lines(
        terminal: &mut Terminal,
        pending_history_lines: &mut Vec<PendingHistoryLines>,
        is_zellij: bool,
    ) -> Result<()>
```

**Purpose**: Writes all buffered history batches above the viewport using the correct insertion mode for the terminal environment, then clears the buffer.

**Data flow**: If `pending_history_lines` is empty, returns `Ok(())`. Otherwise iterates each batch, chooses `InsertHistoryMode::ZellijRaw` only when `is_zellij` and the batch wrap policy is `Terminal`, otherwise `InsertHistoryMode::Standard`, calls `insert_history_hyperlink_lines_with_mode_and_wrap_policy` with a cloned line batch, then clears the vector and returns `Ok(())`.

**Call relations**: Called by both draw paths immediately before rendering the viewport so queued transcript/history output is emitted in order.

*Call graph*: calls 1 internal fn (insert_history_hyperlink_lines_with_mode_and_wrap_policy).


##### `Tui::draw`  (lines 878–951)

```
fn draw(
        &mut self,
        height: u16,
        draw_fn: impl FnOnce(&mut custom_terminal::Frame),
    ) -> Result<()>
```

**Purpose**: Runs the legacy synchronized draw path, including viewport heuristics, pending history flush, and Unix suspend-resume integration.

**Data flow**: On Unix, prepares any pending resume action. It computes `pending_viewport_area()`, ensures VT processing, enters `stdout().sync_update`, applies resume action if present, applies any pending viewport area and clears the terminal, recomputes viewport dimensions from current terminal size and requested `height`, scrolls rows above the viewport upward if expansion would overflow the screen, clears appropriately on viewport change, flushes pending history lines, updates suspend cursor row, and finally calls `terminal.draw` with the provided closure.

**Call relations**: This is the default frame-rendering path used by the app. It delegates viewport heuristics to `pending_viewport_area`, history insertion to `flush_pending_history_lines`, and Unix resume handling to `SuspendContext`.

*Call graph*: calls 3 internal fn (pending_viewport_area, ensure_virtual_terminal_processing, prepare_resume_action); 1 external calls (stdout).


##### `Tui::draw_ambient_pet_image`  (lines 953–970)

```
fn draw_ambient_pet_image(
        &mut self,
        request: Option<crate::pets::AmbientPetDraw>,
    ) -> std::result::Result<(), crate::pets::PetImageRenderError>
```

**Purpose**: Renders or clears the ambient pet image in a synchronized terminal update, translating terminal errors into pet-render errors.

**Data flow**: Ensures VT processing, borrows `self.terminal` and `self.ambient_pet_image_state`, runs `crate::pets::render_ambient_pet_image` inside `stdout().sync_update`, maps terminal I/O failures to the outer `Err`, preserves asset errors as logical pet-render errors, and returns `Result<(), PetImageRenderError>`.

**Call relations**: Used when ambient pet imagery changes independently of the main frame draw.

*Call graph*: calls 1 internal fn (ensure_virtual_terminal_processing); 2 external calls (stdout, Terminal).


##### `Tui::draw_pet_picker_preview_image`  (lines 972–993)

```
fn draw_pet_picker_preview_image(
        &mut self,
        request: Option<crate::pets::AmbientPetDraw>,
    ) -> std::result::Result<(), crate::pets::PetImageRenderError>
```

**Purpose**: Renders the pet-picker preview image using the same synchronized-update/error-mapping pattern as ambient pet rendering.

**Data flow**: Ensures VT processing, borrows `self.terminal` and `self.pet_picker_preview_image_state`, calls `render_pet_picker_preview_image` inside `stdout().sync_update`, and returns either success, a terminal error, or an asset error.

**Call relations**: Used by pet-selection UI flows that need image updates outside the main widget draw closure.

*Call graph*: calls 1 internal fn (ensure_virtual_terminal_processing); 2 external calls (stdout, Terminal).


##### `Tui::clear_ambient_pet_image`  (lines 995–1007)

```
fn clear_ambient_pet_image(
        &mut self,
    ) -> std::result::Result<(), crate::pets::PetImageRenderError>
```

**Purpose**: Clears any ambient pet image currently rendered on the terminal.

**Data flow**: Ensures VT processing, then directly calls `render_ambient_pet_image` with `request: None`, `self.terminal.backend_mut()`, and `self.ambient_pet_image_state`, returning the renderer’s `Result`.

**Call relations**: Called explicitly by cleanup paths and automatically from `Tui::drop`.

*Call graph*: calls 3 internal fn (backend_mut, render_ambient_pet_image, ensure_virtual_terminal_processing); called by 1 (drop); 1 external calls (Terminal).


##### `Tui::draw_with_resize_reflow`  (lines 1014–1065)

```
fn draw_with_resize_reflow(
        &mut self,
        height: u16,
        draw_fn: impl FnOnce(&mut custom_terminal::Frame),
    ) -> Result<()>
```

**Purpose**: Runs the resize-reflow-aware draw path that avoids legacy viewport heuristics and lets transcript reflow own scrollback reconstruction.

**Data flow**: On Unix, prepares any pending resume action, ensures VT processing, enters `stdout().sync_update`, applies resume action if present, updates the inline viewport via `update_inline_viewport_for_resize_reflow`, flushes pending history lines, invalidates the viewport if a full repaint is needed, updates suspend cursor row, and calls `terminal.draw` with the provided closure.

**Call relations**: Feature-gated counterpart to `draw`, used when transcript resize reflow is active so viewport movement and history rebuilding follow the newer model.

*Call graph*: calls 2 internal fn (ensure_virtual_terminal_processing, prepare_resume_action); 1 external calls (stdout).


##### `Tui::pending_viewport_area`  (lines 1067–1087)

```
fn pending_viewport_area(&mut self) -> Result<Option<Rect>>
```

**Purpose**: Computes a heuristic viewport shift after terminal resize by comparing current and last-known cursor positions.

**Data flow**: Reads current terminal size, `last_known_screen_size`, and if the screen size changed attempts `terminal.get_cursor_position()`. If the cursor’s `y` differs from `last_known_cursor_pos.y`, it builds an `Offset` with that delta and returns `Some(terminal.viewport_area.offset(offset))`; otherwise returns `Ok(None)`.

**Call relations**: Used only by the legacy `draw` path before entering synchronized update, because cursor-position queries can race with the event reader.

*Call graph*: called by 1 (draw).


##### `ensure_virtual_terminal_processing`  (lines 1134–1136)

```
fn ensure_virtual_terminal_processing() -> Result<()>
```

**Purpose**: Ensures ANSI virtual-terminal processing is enabled where required, especially on Windows consoles.

**Data flow**: On Windows, fetches stdout and stderr console handles, reads their modes, sets `ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING` if missing, and returns any OS error from `SetConsoleMode`; on non-Windows it simply returns `Ok(())`.

**Call relations**: Called before mode changes and terminal writes in several paths (`set_modes`, restore helpers, draw helpers, pet rendering) so ANSI escape sequences are interpreted correctly.

*Call graph*: called by 7 (clear_ambient_pet_image, draw, draw_ambient_pet_image, draw_pet_picker_preview_image, draw_with_resize_reflow, restore_common, set_modes).


### `tui/src/custom_terminal.rs`

`io_transport` · `main loop / every render pass / terminal teardown`

This file is the low-level rendering core for the TUI. It wraps a `Backend + Write` in a `Terminal<B>` that owns two `ratatui::buffer::Buffer`s and alternates between them to compute minimal screen updates. The `Frame` type exposes the current viewport `Rect`, mutable access to the active `Buffer`, widget rendering via `WidgetRef`, and deferred cursor placement/style requests that are applied only after the frame flushes.

The central draw path is `try_draw`: it autoresizes against the backend-reported `Size`, builds a `Frame`, runs the caller’s render closure into the current buffer, flushes the diff to the backend, then applies cursor visibility/style/position and swaps buffers. The diffing logic is custom: `diff_buffers` scans each row to find the last visually significant column, emits `ClearToEnd` commands instead of trailing space writes, and carefully invalidates cells affected by replacing multi-width glyphs. `display_width` strips OSC sequences before measuring width so hyperlinks and similar control payloads do not distort layout.

The file also tracks inline viewport state (`viewport_area`, `last_known_cursor_pos`, `visible_history_rows`) for callers that insert history above the viewport. Clearing helpers distinguish between viewport-only clears, visible-screen clears, scrollback purges, and a hard ANSI reset sequence for terminals that behave poorly with separate commands. `Drop` defensively restores cursor style and visibility so abnormal exits do not leave the user’s terminal in a broken state.

#### Function details

##### `display_width`  (lines 57–80)

```
fn display_width(s: &str) -> usize
```

**Purpose**: Computes the visible column width of a cell symbol while ignoring OSC control sequences embedded in the string. This fixes width accounting for hyperlink-like escape payloads that `UnicodeWidthStr::width()` would otherwise count as printable text.

**Data flow**: Takes `&str` input; if it contains no ESC byte, it directly measures Unicode width. Otherwise it scans characters, removes `ESC ] ... BEL` OSC segments into a temporary `String`, then returns the width of only the visible characters.

**Call relations**: Used exclusively by `diff_buffers` when deciding how far multi-width cells extend and where trailing clears should begin, so diff generation stays aligned with what the terminal actually displays.

*Call graph*: called by 1 (diff_buffers); 1 external calls (with_capacity).


##### `Frame::area`  (lines 107–109)

```
fn area(&self) -> Rect
```

**Purpose**: Returns the immutable viewport rectangle associated with the current frame. Rendering code can call it repeatedly without worrying about resize races during the same draw pass.

**Data flow**: Reads `self.viewport_area` and returns that `Rect` by value; it does not mutate frame or terminal state.

**Call relations**: Called by higher-level render closures to size widgets against the exact buffer area being drawn in the current pass.

*Call graph*: called by 2 (draw, draw_new_task_page).


##### `Frame::render_widget_ref`  (lines 116–118)

```
fn render_widget_ref(&mut self, widget: W, area: Rect)
```

**Purpose**: Renders a `WidgetRef` directly into the frame’s backing buffer for a specified rectangle. It is the bridge from this custom frame wrapper to ratatui widget rendering.

**Data flow**: Consumes a widget value implementing `WidgetRef`, an `area: Rect`, and writes into `self.buffer` by invoking the widget’s `render_ref` method. It returns no value.

**Call relations**: Used by UI rendering code whenever a widget needs to paint into the current frame; it delegates all actual drawing to the widget implementation.

*Call graph*: called by 4 (render_list, render_picker_footer, render_picker_footer_separator, render_transcript_loading_overlay); 1 external calls (render_ref).


##### `Frame::set_cursor_position`  (lines 130–132)

```
fn set_cursor_position(&mut self, position: P)
```

**Purpose**: Records where the terminal cursor should be shown after the frame has been flushed. It does not move the cursor immediately because the frame still holds a mutable borrow of the buffer.

**Data flow**: Accepts any `P: Into<Position>`, converts it, and stores `Some(position)` in `self.cursor_position`.

**Call relations**: Called by render code that wants a visible cursor after drawing; `Terminal::try_draw` later extracts this stored position and applies it after `flush()`.

*Call graph*: called by 1 (draw_new_task_page); 1 external calls (into).


##### `Frame::set_cursor_style`  (lines 135–137)

```
fn set_cursor_style(&mut self, style: SetCursorStyle)
```

**Purpose**: Stores the visible cursor shape requested for this frame. The style is deferred until after the buffer diff has been written.

**Data flow**: Takes a `SetCursorStyle` and assigns it to `self.cursor_style`.

**Call relations**: Its value is consumed by `Terminal::try_draw` only when the frame also requested a visible cursor position.


##### `Frame::buffer_mut`  (lines 140–142)

```
fn buffer_mut(&mut self) -> &mut Buffer
```

**Purpose**: Exposes the underlying mutable `Buffer` so callers can perform direct buffer operations not covered by widget APIs.

**Data flow**: Returns `&mut Buffer` borrowed from `self.buffer`.

**Call relations**: Used by rendering code that needs raw buffer access instead of going through `WidgetRef`.

*Call graph*: called by 1 (draw_new_task_page).


##### `Terminal::drop`  (lines 176–187)

```
fn drop(&mut self)
```

**Purpose**: Best-effort terminal cleanup on object destruction. It restores the default cursor shape and unhides the cursor if this terminal instance had hidden it.

**Data flow**: Reads `hidden_cursor`; attempts `reset_cursor_style()` and conditionally `show_cursor()`. On failure it writes diagnostic messages to stderr via `eprintln!`.

**Call relations**: Runs automatically at teardown. It is the final safety net if the application exits without explicitly restoring terminal cursor state.

*Call graph*: calls 2 internal fn (reset_cursor_style, show_cursor); 1 external calls (eprintln!).


##### `Terminal::with_options`  (lines 196–209)

```
fn with_options(mut backend: B) -> io::Result<Self>
```

**Purpose**: Constructs a terminal from a backend by probing initial screen size and cursor position. If cursor probing fails, it logs a warning and falls back to origin instead of aborting startup.

**Data flow**: Mutably queries `backend.size()` and `backend.get_cursor_position()`, substitutes `Position { x: 0, y: 0 }` on cursor-probe failure, then builds the struct through `with_screen_size_and_cursor_position` and returns `io::Result<Self>`.

**Call relations**: This is the normal constructor used by startup and tests. It centralizes the tolerant initial cursor-position behavior before handing off to the internal initializer.

*Call graph*: called by 52 (thread_goal_ephemeral_error_message_renders_snapshot, chained_config_error_wraps_in_history_snapshot, approval_modal_exec_snapshot, app_server_guardian_review_denied_renders_denied_request_snapshot, app_server_guardian_review_timed_out_renders_timed_out_request_snapshot, guardian_approved_exec_renders_approved_request, guardian_approved_request_permissions_renders_request_summary, guardian_denied_exec_renders_warning_and_denied_request, guardian_timed_out_exec_renders_warning_and_timed_out_request, app_server_mcp_startup_failure_renders_warning_history (+15 more)); 3 external calls (get_cursor_position, size, with_screen_size_and_cursor_position).


##### `Terminal::with_options_and_cursor_position`  (lines 217–224)

```
fn with_options_and_cursor_position(backend: B, cursor_pos: Position) -> io::Result<Self>
```

**Purpose**: Constructs a terminal using a caller-supplied initial cursor position instead of probing the backend. This is intended for startup paths that already performed bounded cursor probing elsewhere.

**Data flow**: Reads `backend.size()`, combines it with the provided `Position`, and returns a terminal initialized by `with_screen_size_and_cursor_position`.

**Call relations**: Alternative constructor for orchestration code that wants explicit control over the initial inline viewport anchor.

*Call graph*: 2 external calls (size, with_screen_size_and_cursor_position).


##### `Terminal::with_screen_size_and_cursor_position`  (lines 226–246)

```
fn with_screen_size_and_cursor_position(
        backend: B,
        screen_size: Size,
        cursor_pos: Position,
    ) -> Self
```

**Purpose**: Internal initializer that seeds all terminal state from a known screen size and cursor position. It creates empty front/back buffers and anchors the viewport at the cursor’s row.

**Data flow**: Consumes `backend`, `screen_size`, and `cursor_pos`; creates two empty `Buffer`s, sets `current = 0`, initializes cursor/viewport/history bookkeeping, and returns `Self`.

**Call relations**: Used only by the public constructors to avoid duplicating initialization details.

*Call graph*: 2 external calls (empty, new).


##### `Terminal::get_frame`  (lines 249–256)

```
fn get_frame(&mut self) -> Frame<'_>
```

**Purpose**: Builds a `Frame` view over the current terminal state for one render pass. The frame starts with no requested cursor position and the default user cursor shape.

**Data flow**: Reads `viewport_area`, borrows the current buffer mutably via `current_buffer_mut()`, and returns a `Frame<'_>` containing those references and defaults.

**Call relations**: Called at the start of `try_draw` before invoking the caller’s render closure.

*Call graph*: calls 1 internal fn (current_buffer_mut); called by 1 (try_draw).


##### `Terminal::current_buffer`  (lines 259–261)

```
fn current_buffer(&self) -> &Buffer
```

**Purpose**: Returns the active draw buffer currently being rendered into.

**Data flow**: Indexes `self.buffers[self.current]` and returns `&Buffer`.

**Call relations**: Used by `flush` as the new frame image to compare against the previous buffer.

*Call graph*: called by 1 (flush).


##### `Terminal::current_buffer_mut`  (lines 264–266)

```
fn current_buffer_mut(&mut self) -> &mut Buffer
```

**Purpose**: Returns the active draw buffer mutably.

**Data flow**: Indexes `self.buffers[self.current]` and returns `&mut Buffer`.

**Call relations**: Used when creating a `Frame` and when resizing the viewport buffers.

*Call graph*: called by 2 (get_frame, set_viewport_area).


##### `Terminal::previous_buffer`  (lines 269–271)

```
fn previous_buffer(&self) -> &Buffer
```

**Purpose**: Returns the inactive buffer representing the previously flushed frame.

**Data flow**: Indexes `self.buffers[1 - self.current]` and returns `&Buffer`.

**Call relations**: Used by `flush` as the baseline for diff computation.

*Call graph*: called by 1 (flush).


##### `Terminal::previous_buffer_mut`  (lines 274–276)

```
fn previous_buffer_mut(&mut self) -> &mut Buffer
```

**Purpose**: Returns the inactive diff buffer mutably so it can be reset or resized.

**Data flow**: Indexes `self.buffers[1 - self.current]` and returns `&mut Buffer`.

**Call relations**: Used by clear/invalidate/swap operations to force future full redraws or keep both buffers sized consistently.

*Call graph*: called by 7 (clear_after_position, clear_scrollback, clear_scrollback_and_visible_screen_ansi, clear_visible_screen, invalidate_viewport, set_viewport_area, swap_buffers).


##### `Terminal::backend`  (lines 279–281)

```
fn backend(&self) -> &B
```

**Purpose**: Exposes an immutable reference to the wrapped backend.

**Data flow**: Returns `&B` from `self.backend`.

**Call relations**: Used by callers that need to inspect backend-specific state after rendering.

*Call graph*: called by 1 (insert_history_hyperlink_lines_with_mode_and_wrap_policy).


##### `Terminal::backend_mut`  (lines 284–286)

```
fn backend_mut(&mut self) -> &mut B
```

**Purpose**: Exposes a mutable reference to the wrapped backend for raw terminal operations outside the diff renderer.

**Data flow**: Returns `&mut B` from `self.backend`.

**Call relations**: Used by higher-level terminal orchestration code when it must issue backend-specific commands directly.

*Call graph*: called by 3 (insert_history_hyperlink_lines_with_mode_and_wrap_policy, clear_ambient_pet_image, update_inline_viewport_for_resize_reflow).


##### `Terminal::flush`  (lines 290–297)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Computes the diff between the previous and current buffers and writes the resulting draw commands to the backend. It also updates the terminal’s last-known cursor position based on the last emitted `Put` command.

**Data flow**: Reads both buffers, transforms them through `diff_buffers` into `Vec<DrawCommand>`, scans that vector for the last `Put`, updates `last_known_cursor_pos` if found, then streams the commands into `draw(&mut self.backend, ...)`.

**Call relations**: Called by `try_draw` after the render closure completes and before cursor visibility/style updates are applied.

*Call graph*: calls 4 internal fn (current_buffer, previous_buffer, diff_buffers, draw); called by 1 (try_draw).


##### `Terminal::resize`  (lines 303–306)

```
fn resize(&mut self, screen_size: Size) -> io::Result<()>
```

**Purpose**: Records a newly observed screen size. This implementation intentionally only updates bookkeeping; viewport resizing is handled separately by callers.

**Data flow**: Assigns `screen_size` into `last_known_screen_size` and returns `Ok(())`.

**Call relations**: Invoked by `autoresize` when the backend-reported size changes.

*Call graph*: called by 1 (autoresize).


##### `Terminal::set_viewport_area`  (lines 309–314)

```
fn set_viewport_area(&mut self, area: Rect)
```

**Purpose**: Resizes both internal buffers to a new viewport rectangle and updates viewport/history bookkeeping. It keeps `visible_history_rows` clamped so history never exceeds the viewport’s top offset.

**Data flow**: Takes a `Rect`, resizes current and previous buffers to that area, stores it in `viewport_area`, and clamps `visible_history_rows` against `area.top()`.

**Call relations**: Used by higher-level screen-mode transitions and inline viewport management whenever the visible drawing region changes.

*Call graph*: calls 2 internal fn (current_buffer_mut, previous_buffer_mut); called by 6 (clear_terminal_for_thread_switch, insert_history_hyperlink_lines_with_mode_and_wrap_policy, enter_alt_screen, leave_alt_screen, update_inline_viewport_for_resize_reflow, apply); 1 external calls (top).


##### `Terminal::autoresize`  (lines 317–323)

```
fn autoresize(&mut self) -> io::Result<()>
```

**Purpose**: Checks the backend’s current size and updates terminal size bookkeeping if it changed since the last draw.

**Data flow**: Reads `self.size()`, compares it to `last_known_screen_size`, conditionally calls `resize(screen_size)`, and returns `io::Result<()>`.

**Call relations**: Always runs at the start of `try_draw` to avoid stale size assumptions during rendering.

*Call graph*: calls 2 internal fn (resize, size); called by 1 (try_draw).


##### `Terminal::draw`  (lines 348–356)

```
fn draw(&mut self, render_callback: F) -> io::Result<()>
```

**Purpose**: Convenience wrapper around `try_draw` for infallible render closures. It adapts a `FnOnce(&mut Frame)` into the fallible callback shape expected by `try_draw`.

**Data flow**: Accepts a render closure, invokes `try_draw` with a wrapper that runs the closure and returns `io::Result::Ok(())`.

**Call relations**: Used by most application rendering code when widget rendering itself cannot fail.

*Call graph*: calls 1 internal fn (try_draw); called by 1 (draw_footer_frame).


##### `Terminal::try_draw`  (lines 393–429)

```
fn try_draw(&mut self, render_callback: F) -> io::Result<()>
```

**Purpose**: Runs one complete render cycle: autoresize, render into the current buffer, flush the diff, apply deferred cursor state, swap buffers, and flush the backend writer. If the render callback errors, no terminal update is emitted.

**Data flow**: Mutates terminal state throughout the draw pass. It calls `autoresize()`, creates a `Frame`, passes it to the callback, extracts `cursor_position` and `cursor_style`, flushes buffer diffs, then either hides the cursor or sets style/shows/moves it, swaps buffers, flushes the backend, and returns `io::Result<()>`.

**Call relations**: This is the main rendering engine behind `draw`. It orchestrates all lower-level helpers in the correct order so buffer borrowing, terminal writes, and cursor updates do not conflict.

*Call graph*: calls 8 internal fn (autoresize, flush, get_frame, hide_cursor, set_cursor_position, set_cursor_style, show_cursor, swap_buffers); called by 1 (draw); 1 external calls (flush).


##### `Terminal::hide_cursor`  (lines 432–436)

```
fn hide_cursor(&mut self) -> io::Result<()>
```

**Purpose**: Hides the terminal cursor and records that hidden state locally.

**Data flow**: Calls `self.backend.hide_cursor()`, sets `hidden_cursor = true`, and returns `Ok(())` on success.

**Call relations**: Used by `try_draw` when the frame did not request a visible cursor.

*Call graph*: called by 1 (try_draw); 1 external calls (hide_cursor).


##### `Terminal::show_cursor`  (lines 439–443)

```
fn show_cursor(&mut self) -> io::Result<()>
```

**Purpose**: Shows the terminal cursor and records that it is no longer hidden.

**Data flow**: Calls `self.backend.show_cursor()`, sets `hidden_cursor = false`, and returns `Ok(())`.

**Call relations**: Used by `try_draw` when a frame requested a cursor position, and by `Drop` to restore terminal state.

*Call graph*: called by 2 (drop, try_draw); 1 external calls (show_cursor).


##### `Terminal::set_cursor_style`  (lines 446–448)

```
fn set_cursor_style(&mut self, style: SetCursorStyle) -> io::Result<()>
```

**Purpose**: Queues a crossterm cursor-style command onto the backend writer.

**Data flow**: Accepts a `SetCursorStyle` and writes it with `queue!(self.backend, style)`, returning any I/O error.

**Call relations**: Called by `try_draw` for per-frame cursor styling and by `reset_cursor_style` for teardown restoration.

*Call graph*: called by 2 (reset_cursor_style, try_draw); 1 external calls (queue!).


##### `Terminal::reset_cursor_style`  (lines 451–453)

```
fn reset_cursor_style(&mut self) -> io::Result<()>
```

**Purpose**: Restores the terminal cursor to the user-configured default shape.

**Data flow**: Delegates to `set_cursor_style(SetCursorStyle::DefaultUserShape)` and returns its result.

**Call relations**: Used by `Drop` and tests to ensure cursor-style cleanup emits the expected sequence.

*Call graph*: calls 1 internal fn (set_cursor_style); called by 1 (drop).


##### `Terminal::get_cursor_position`  (lines 459–461)

```
fn get_cursor_position(&mut self) -> io::Result<Position>
```

**Purpose**: Queries the backend for the current cursor position after the last draw.

**Data flow**: Calls `self.backend.get_cursor_position()` and returns the resulting `Position`.

**Call relations**: Present as a direct backend passthrough; not part of the main draw flow.

*Call graph*: 1 external calls (get_cursor_position).


##### `Terminal::set_cursor_position`  (lines 464–469)

```
fn set_cursor_position(&mut self, position: P) -> io::Result<()>
```

**Purpose**: Moves the terminal cursor immediately and updates the terminal’s last-known cursor bookkeeping.

**Data flow**: Converts the input into `Position`, calls `backend.set_cursor_position(position)`, stores it in `last_known_cursor_pos`, and returns `Ok(())`.

**Call relations**: Used by `try_draw` after flushing, and by screen-clearing helpers that need explicit cursor-home behavior.

*Call graph*: called by 3 (clear_scrollback, clear_visible_screen, try_draw); 2 external calls (set_cursor_position, into).


##### `Terminal::clear`  (lines 472–477)

```
fn clear(&mut self) -> io::Result<()>
```

**Purpose**: Clears from the viewport origin through the end of the visible screen and forces a full redraw next frame. It is a no-op for an empty viewport.

**Data flow**: Checks `viewport_area.is_empty()`. If non-empty, converts the viewport origin to `Position` and delegates to `clear_after_position`.

**Call relations**: Used by higher-level screen setup code when the viewport should be visually reset.

*Call graph*: calls 1 internal fn (clear_after_position); called by 2 (enter_alt_screen, apply); 2 external calls (as_position, is_empty).


##### `Terminal::clear_after_position`  (lines 480–486)

```
fn clear_after_position(&mut self, position: Position) -> io::Result<()>
```

**Purpose**: Clears the terminal from an arbitrary position to the end of the screen and invalidates the previous buffer so the next draw repaints everything.

**Data flow**: Moves the backend cursor to `position`, clears `ClearType::AfterCursor`, resets the previous buffer, and returns `Ok(())`.

**Call relations**: Underlying primitive for viewport clears and inline viewport maintenance after raw terminal mutations.

*Call graph*: calls 1 internal fn (previous_buffer_mut); called by 3 (clear, insert_history_hyperlink_lines_with_mode_and_wrap_policy, update_inline_viewport_for_resize_reflow); 2 external calls (clear_region, set_cursor_position).


##### `Terminal::invalidate_viewport`  (lines 491–493)

```
fn invalidate_viewport(&mut self)
```

**Purpose**: Forces the next draw pass to repaint the entire viewport without issuing any immediate terminal I/O.

**Data flow**: Resets the previous buffer in place.

**Call relations**: Used after out-of-band terminal operations that changed screen contents behind ratatui’s back.

*Call graph*: calls 1 internal fn (previous_buffer_mut).


##### `Terminal::clear_scrollback`  (lines 496–509)

```
fn clear_scrollback(&mut self) -> io::Result<()>
```

**Purpose**: Purges terminal scrollback, homes the cursor before and after the purge for compatibility, and forces a full redraw. It skips work when the viewport is empty.

**Data flow**: Checks `viewport_area.is_empty()`, sets cursor to `(0,0)`, queues crossterm `ClearType::Purge`, homes again, flushes the backend writer, resets the previous buffer, and returns `Ok(())`.

**Call relations**: Used by higher-level terminal reset flows when scrollback should be removed without necessarily clearing all visible content via the ANSI hard-reset path.

*Call graph*: calls 2 internal fn (previous_buffer_mut, set_cursor_position); 3 external calls (is_empty, queue!, flush).


##### `Terminal::clear_visible_screen`  (lines 512–524)

```
fn clear_visible_screen(&mut self) -> io::Result<()>
```

**Purpose**: Clears the entire visible screen, homes the cursor before and after, resets visible-history tracking, and forces a full redraw.

**Data flow**: Moves cursor to home, calls `backend.clear_region(ClearType::All)`, homes again, flushes the backend, sets `visible_history_rows = 0`, resets the previous buffer, and returns `Ok(())`.

**Call relations**: Used when the whole visible terminal surface must be blanked in a terminal-compatible way.

*Call graph*: calls 2 internal fn (previous_buffer_mut, set_cursor_position); 2 external calls (clear_region, flush).


##### `Terminal::clear_scrollback_and_visible_screen_ansi`  (lines 530–543)

```
fn clear_scrollback_and_visible_screen_ansi(&mut self) -> io::Result<()>
```

**Purpose**: Performs a hard reset of scrollback and visible screen using one explicit ANSI sequence rather than separate backend commands. This is a compatibility path for terminals that behave better with a single combined sequence.

**Data flow**: If the viewport is non-empty, writes `\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H` directly to the backend, flushes it, resets cursor/history bookkeeping, resets the previous buffer, and returns `Ok(())`.

**Call relations**: Called by thread-switch clearing logic when a stronger terminal reset is desired than the backend abstractions provide.

*Call graph*: calls 1 internal fn (previous_buffer_mut); called by 1 (clear_terminal_for_thread_switch); 3 external calls (is_empty, flush, write!).


##### `Terminal::visible_history_rows`  (lines 545–547)

```
fn visible_history_rows(&self) -> u16
```

**Purpose**: Returns how many history rows are currently considered visible above the inline viewport.

**Data flow**: Reads and returns `self.visible_history_rows`.

**Call relations**: Accessor for higher-level inline viewport logic.


##### `Terminal::note_history_rows_inserted`  (lines 549–554)

```
fn note_history_rows_inserted(&mut self, inserted_rows: u16)
```

**Purpose**: Accumulates newly inserted history rows above the viewport while clamping the count to the viewport’s top edge.

**Data flow**: Adds `inserted_rows` to `visible_history_rows` with saturation, then clamps the result to `self.viewport_area.top()`.

**Call relations**: Used by history insertion code to keep inline viewport bookkeeping synchronized with terminal mutations.

*Call graph*: called by 1 (insert_history_hyperlink_lines_with_mode_and_wrap_policy); 1 external calls (top).


##### `Terminal::swap_buffers`  (lines 557–560)

```
fn swap_buffers(&mut self)
```

**Purpose**: Resets the inactive buffer and flips which of the two buffers is current for the next frame.

**Data flow**: Calls `previous_buffer_mut().reset()` and toggles `self.current` between `0` and `1`.

**Call relations**: Called at the end of `try_draw` after the current frame has been flushed.

*Call graph*: calls 1 internal fn (previous_buffer_mut); called by 1 (try_draw).


##### `Terminal::size`  (lines 563–565)

```
fn size(&self) -> io::Result<Size>
```

**Purpose**: Queries the backend for the real terminal size.

**Data flow**: Calls `self.backend.size()` and returns `io::Result<Size>`.

**Call relations**: Used by autoresize and by higher-level terminal mode transitions that need current dimensions.

*Call graph*: called by 4 (autoresize, enter_alt_screen, update_inline_viewport_for_resize_reflow, apply); 1 external calls (size).


##### `diff_buffers`  (lines 576–639)

```
fn diff_buffers(a: &Buffer, b: &Buffer) -> Vec<DrawCommand>
```

**Purpose**: Computes a compact sequence of `DrawCommand`s needed to transform one buffer into another. It optimizes trailing blanks into `ClearToEnd` commands and handles invalidation caused by replacing multi-width glyphs.

**Data flow**: Reads both buffers’ `content` vectors and area geometry. First it scans each row of the next buffer to find the last visually significant column using `display_width`, row trailing background, and modifiers; it emits `ClearToEnd` after that point. Then it walks both buffers cell-by-cell, emitting `Put` commands for changed or invalidated cells unless skipped, while tracking `to_skip` and `invalidated` widths for multi-column symbols. It returns `Vec<DrawCommand>`.

**Call relations**: Called by `Terminal::flush` and directly by tests. It is the core diff algorithm that determines both correctness and rendering efficiency.

*Call graph*: calls 1 internal fn (display_width); called by 3 (flush, diff_buffers_clear_to_end_starts_after_wide_char, diff_buffers_does_not_emit_clear_to_end_for_full_width_row); 4 external calls (pos_of, empty, max, vec!).


##### `draw`  (lines 641–698)

```
fn draw(writer: &mut impl Write, commands: I) -> io::Result<()>
```

**Purpose**: Serializes `DrawCommand`s into queued crossterm operations while minimizing redundant cursor moves and style changes. It maintains local foreground/background/modifier state to avoid re-emitting unchanged attributes.

**Data flow**: Consumes an iterator of `DrawCommand`s and writes to a mutable `Write`. For each command it conditionally queues `MoveTo`, applies modifier diffs via `ModifierDiff::queue`, updates colors, prints symbols or clears to end of line, then finally resets foreground/background/attributes before returning `Ok(())`.

**Call relations**: Used only by `Terminal::flush` as the final translation layer from abstract diff commands to terminal escape sequences.

*Call graph*: called by 1 (flush); 3 external calls (empty, matches!, queue!).


##### `ModifierDiff::queue`  (lines 709–764)

```
fn queue(self, w: &mut W) -> io::Result<()>
```

**Purpose**: Queues only the crossterm attribute changes needed to move from one `Modifier` bitset to another. It handles removal and addition order carefully for overlapping intensity-related flags like bold and dim.

**Data flow**: Consumes `self` and a mutable writer, computes `removed = from - to` and `added = to - from`, then queues the corresponding `SetAttribute` commands for reverse, intensity, italic, underline, crossed-out, and blink states.

**Call relations**: Called by `draw` whenever a `Put` command’s cell modifiers differ from the currently active modifier state.

*Call graph*: 2 external calls (contains, queue!).


##### `tests::CaptureBackend::new`  (lines 782–788)

```
fn new(width: u16, height: u16) -> Self
```

**Purpose**: Creates a minimal in-memory backend for terminal rendering tests. It starts with empty output, a fixed size, and cursor at origin.

**Data flow**: Takes width and height, constructs `Size` and `Position`, and returns `CaptureBackend` with an empty `Vec<u8>` output buffer.

**Call relations**: Used by tests that need to inspect emitted terminal escape sequences without a real terminal.

*Call graph*: 1 external calls (new).


##### `tests::CaptureBackend::output`  (lines 790–792)

```
fn output(&self) -> String
```

**Purpose**: Returns the backend’s captured byte stream as a lossy UTF-8 string for assertions.

**Data flow**: Reads `self.output`, converts it with `String::from_utf8_lossy`, and returns an owned `String`.

**Call relations**: Used by cursor-style tests to verify that expected escape sequences were emitted.

*Call graph*: 1 external calls (from_utf8_lossy).


##### `tests::CaptureBackend::write`  (lines 796–799)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Implements `Write` by appending bytes into the capture buffer.

**Data flow**: Extends `self.output` with the provided byte slice and returns the written length.

**Call relations**: Supports the custom terminal’s direct `Write`-based rendering path during tests.


##### `tests::CaptureBackend::draw`  (lines 807–812)

```
fn draw(&mut self, _content: I) -> io::Result<()>
```

**Purpose**: Implements the `Backend` draw hook as a no-op for tests that bypass ratatui’s normal backend drawing.

**Data flow**: Ignores the iterator input and returns `Ok(())`.

**Call relations**: Required trait implementation for the test backend.


##### `tests::CaptureBackend::hide_cursor`  (lines 814–816)

```
fn hide_cursor(&mut self) -> io::Result<()>
```

**Purpose**: Test backend stub for hiding the cursor.

**Data flow**: Performs no state change and returns `Ok(())`.

**Call relations**: Satisfies the `Backend` trait for cursor visibility operations.


##### `tests::CaptureBackend::show_cursor`  (lines 818–820)

```
fn show_cursor(&mut self) -> io::Result<()>
```

**Purpose**: Test backend stub for showing the cursor.

**Data flow**: Performs no state change and returns `Ok(())`.

**Call relations**: Used indirectly by terminal cleanup and draw tests.


##### `tests::CaptureBackend::get_cursor_position`  (lines 822–824)

```
fn get_cursor_position(&mut self) -> io::Result<Position>
```

**Purpose**: Returns the backend’s stored cursor position.

**Data flow**: Reads `self.cursor` and returns it in `Ok(...)`.

**Call relations**: Supports terminal initialization and cursor-position tests.


##### `tests::CaptureBackend::set_cursor_position`  (lines 826–829)

```
fn set_cursor_position(&mut self, position: P) -> io::Result<()>
```

**Purpose**: Stores a new cursor position in the test backend.

**Data flow**: Converts the input into `Position`, assigns it to `self.cursor`, and returns `Ok(())`.

**Call relations**: Used by terminal methods that explicitly move the cursor during tests.

*Call graph*: 1 external calls (into).


##### `tests::CaptureBackend::clear`  (lines 831–833)

```
fn clear(&mut self) -> io::Result<()>
```

**Purpose**: No-op implementation of full clear for the test backend.

**Data flow**: Returns `Ok(())` without mutating state.

**Call relations**: Trait stub only.


##### `tests::CaptureBackend::clear_region`  (lines 835–837)

```
fn clear_region(&mut self, _clear_type: ClearType) -> io::Result<()>
```

**Purpose**: No-op implementation of region clear for the test backend.

**Data flow**: Ignores the clear type and returns `Ok(())`.

**Call relations**: Allows clear-related terminal methods to run in tests.


##### `tests::CaptureBackend::append_lines`  (lines 839–841)

```
fn append_lines(&mut self, _line_count: u16) -> io::Result<()>
```

**Purpose**: No-op implementation of line appending for the test backend.

**Data flow**: Ignores the line count and returns `Ok(())`.

**Call relations**: Trait stub only.


##### `tests::CaptureBackend::scroll_region_up`  (lines 843–849)

```
fn scroll_region_up(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> io::Result<()>
```

**Purpose**: No-op implementation of upward region scrolling for the test backend.

**Data flow**: Ignores region and amount and returns `Ok(())`.

**Call relations**: Trait stub only.


##### `tests::CaptureBackend::scroll_region_down`  (lines 851–857)

```
fn scroll_region_down(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> io::Result<()>
```

**Purpose**: No-op implementation of downward region scrolling for the test backend.

**Data flow**: Ignores region and amount and returns `Ok(())`.

**Call relations**: Trait stub only.


##### `tests::CaptureBackend::size`  (lines 859–861)

```
fn size(&self) -> io::Result<Size>
```

**Purpose**: Returns the fixed terminal size configured for the test backend.

**Data flow**: Reads `self.size` and returns it.

**Call relations**: Used by terminal initialization and autoresize logic in tests.


##### `tests::CaptureBackend::window_size`  (lines 863–868)

```
fn window_size(&mut self) -> io::Result<WindowSize>
```

**Purpose**: Returns a synthetic `WindowSize` using the backend’s configured dimensions for both character and pixel sizes.

**Data flow**: Builds and returns `WindowSize { columns_rows: self.size, pixels: self.size }`.

**Call relations**: Completes the `Backend` trait for tests.


##### `tests::CaptureBackend::flush`  (lines 870–872)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: No-op flush for the test backend.

**Data flow**: Returns `Ok(())`.

**Call relations**: Used when tests explicitly flush the backend after queuing commands.


##### `tests::diff_buffers_does_not_emit_clear_to_end_for_full_width_row`  (lines 876–901)

```
fn diff_buffers_does_not_emit_clear_to_end_for_full_width_row()
```

**Purpose**: Verifies that a row whose last changed cell is the final column does not spuriously emit a `ClearToEnd` command.

**Data flow**: Builds empty previous/next buffers, writes `X` into the last cell of the next buffer, runs `diff_buffers`, then asserts there is no row-0 `ClearToEnd` and that a `Put` for `(2,0)` exists.

**Call relations**: Exercises the row-tail optimization boundary condition in `diff_buffers`.

*Call graph*: calls 1 internal fn (diff_buffers); 4 external calls (empty, new, assert!, assert_eq!).


##### `tests::diff_buffers_clear_to_end_starts_after_wide_char`  (lines 904–919)

```
fn diff_buffers_clear_to_end_starts_after_wide_char()
```

**Purpose**: Checks that trailing clear begins after the remaining wide character when a two-wide glyph sequence shrinks.

**Data flow**: Creates previous buffer with `中文`, next buffer with `中`, diffs them, and asserts a `ClearToEnd` starts at column 2 on row 0.

**Call relations**: Targets the multi-width invalidation and trailing-clear logic in `diff_buffers`.

*Call graph*: calls 1 internal fn (diff_buffers); 4 external calls (empty, new, default, assert!).


##### `tests::terminal_draw_applies_requested_cursor_style`  (lines 922–944)

```
fn terminal_draw_applies_requested_cursor_style()
```

**Purpose**: Ensures a frame-requested cursor style is emitted during drawing when the frame also requests a visible cursor position.

**Data flow**: Creates a `Terminal<CaptureBackend>`, sets viewport area, runs `try_draw` that sets cursor style and position, then compares captured backend output against the expected queued `SetCursorStyle::SteadyBar` sequence.

**Call relations**: Validates the deferred cursor-style path inside `Terminal::try_draw`.

*Call graph*: calls 1 internal fn (with_options); 6 external calls (new, from_utf8, new, assert!, queue!, new).


##### `tests::reset_cursor_style_emits_default_user_shape`  (lines 947–963)

```
fn reset_cursor_style_emits_default_user_shape()
```

**Purpose**: Verifies that resetting cursor style emits the default-user-shape escape sequence.

**Data flow**: Creates a terminal, calls `reset_cursor_style()`, flushes the backend, and asserts the captured output contains the queued `DefaultUserShape` sequence.

**Call relations**: Covers the cleanup path used by `Drop`.

*Call graph*: calls 1 internal fn (with_options); 6 external calls (from_utf8, new, assert!, queue!, flush, new).


### `tui/src/terminal_probe.rs`

`io_transport` · `startup and resume probing`

This module owns direct terminal probing outside the normal crossterm event loop. Its shared data model is `DefaultColors`, an RGB foreground/background pair parsed from OSC 10 and OSC 11 responses. Platform-specific `imp` modules then implement the actual probe transport. On Unix, a temporary `Tty` duplicates stdin/stdout when possible, falls back to `/dev/tty` otherwise, switches only the reader into nonblocking mode, and restores original file flags on drop. On Windows, the implementation uses raw console handles, optionally enables virtual-terminal input, and falls back to console attribute/color-table inspection when OSC color queries are unavailable.

The startup path batches multiple queries under one deadline to avoid paying one timeout per unsupported capability. Unix `startup` writes cursor-position, default-color, and optional keyboard-enhancement queries in one burst, then `read_startup_probe` repeatedly drains available bytes, updates a `StartupProbe` struct, and stops either when all requested fields are known or when the deadline expires. Keyboard support detection is nuanced: seeing keyboard flags marks support, seeing only primary-device-attributes fallback marks unsupported, and if support was seen without fallback before timeout, `finish_startup_probe` still records `Some(true)` so those bytes do not need to arrive in a fixed order.

Shared parsing helpers are platform-independent. `parse_osc_color`, `parse_default_colors`, `osc_payload_end`, `parse_osc_rgb`, and `parse_osc_component` decode OSC 10/11 replies with BEL or ST terminators and 2- or 4-digit hex components. Unix-only helpers parse cursor-position reports and keyboard-enhancement responses by scanning arbitrary byte buffers for escape-sequence subsequences, tolerating unrelated bytes before or between responses. Tests cover both parser correctness and Windows console-color decoding.

#### Function details

##### `imp::Tty::open`  (lines 81–120)

```
fn open() -> io::Result<Self>
```

**Purpose**: Opens an isolated terminal reader/writer pair for Unix probes, preferring duplicated stdio and falling back to `/dev/tty` when necessary. It ensures probe I/O owns its own file descriptions.

**Data flow**: It attempts `dup_file` on stdin and stdout. If both succeed, it forwards the duplicated `File`s to `Self::new`. Otherwise it formats a combined stdio error description, opens `/dev/tty` separately for reading and writing, wraps fallback failures with contextual `io::Error`s, and then calls `Self::new(reader, writer)`.

**Call relations**: Unix probe entry points call this before sending queries. It delegates nonblocking setup to `Tty::new` and descriptor duplication to `dup_file`.

*Call graph*: 4 external calls (new, new, format!, dup_file).


##### `imp::Tty::new`  (lines 122–136)

```
fn new(reader: File, writer: File) -> io::Result<Self>
```

**Purpose**: Constructs a Unix probe `Tty` from already-opened reader and writer files and switches the reader into nonblocking mode. It also records the original file status flags for restoration on drop.

**Data flow**: It takes `reader: File` and `writer: File`, reads the reader fd via `as_raw_fd`, fetches current flags with `fcntl(F_GETFL)`, sets `O_NONBLOCK` with `fcntl(F_SETFL, ...)`, and returns `Ok(Tty { reader, writer, original_flags })` or an `io::Error` on failure.

**Call relations**: Only `Tty::open` calls this constructor. It encapsulates the Unix-specific file-descriptor setup required by all probe reads.

*Call graph*: 3 external calls (as_raw_fd, last_os_error, fcntl).


##### `imp::Tty::write_all`  (lines 138–141)

```
fn write_all(&mut self, bytes: &[u8]) -> io::Result<()>
```

**Purpose**: Writes a complete probe query byte sequence to the terminal and flushes it immediately. This ensures the terminal sees the query before the bounded read window begins.

**Data flow**: It takes `&mut self` and `bytes: &[u8]`, writes all bytes to `self.writer`, flushes the writer, and returns `io::Result<()>`.

**Call relations**: Unix probe functions call this right after opening the `Tty` and before entering read loops.

*Call graph*: 2 external calls (flush, write_all).


##### `imp::Tty::read_available`  (lines 143–169)

```
fn read_available(&mut self, buffer: &mut Vec<u8>) -> io::Result<()>
```

**Purpose**: Reads all currently available bytes from the nonblocking Unix terminal reader into a caller-provided buffer. It stops cleanly on `WouldBlock` or `Interrupted`.

**Data flow**: It repeatedly calls `libc::read` into a fixed 256-byte stack buffer, extends the provided `Vec<u8>` with any bytes read, returns `Ok(())` on EOF or on `WouldBlock`/`Interrupted`, and returns an `io::Error` for other read failures.

**Call relations**: Unix read loops use this before polling so they can parse any bytes already buffered by the terminal.

*Call graph*: 4 external calls (as_raw_fd, last_os_error, read, matches!).


##### `imp::Tty::poll_readable`  (lines 171–201)

```
fn poll_readable(&self, timeout: Duration) -> io::Result<bool>
```

**Purpose**: Waits until the Unix terminal reader becomes readable or a timeout expires, handling interrupted polls transparently. It is the bounded blocking primitive for probe loops.

**Data flow**: It builds a `pollfd` for the reader fd, computes a deadline from `Instant::now() + timeout`, repeatedly polls with the remaining timeout in milliseconds, returns `Ok(true)` when `POLLIN` is set, `Ok(false)` on timeout, and propagates non-interrupted poll errors.

**Call relations**: Unix `read_until` and `read_startup_probe` call this between nonblocking reads to avoid busy-waiting.

*Call graph*: 4 external calls (as_raw_fd, now, last_os_error, poll).


##### `imp::Tty::drop`  (lines 205–208)

```
fn drop(&mut self)
```

**Purpose**: Restores the Unix reader file descriptor's original status flags when the temporary probe handle is dropped. This prevents nonblocking mode from leaking into unrelated code.

**Data flow**: On drop it calls `fcntl(F_SETFL, self.original_flags)` on the reader fd and ignores any error.

**Call relations**: This runs automatically after Unix probe functions finish with a `Tty`.

*Call graph*: 2 external calls (as_raw_fd, fcntl).


##### `imp::dup_file`  (lines 212–218)

```
fn dup_file(fd: libc::c_int) -> io::Result<File>
```

**Purpose**: Duplicates a Unix stdio file descriptor and wraps the duplicate in a `File`. The duplicate is owned solely by probe cleanup.

**Data flow**: It calls `libc::dup(fd)`, returns an `io::Error` on `-1`, or constructs `File::from_raw_fd(duplicated)` and returns it.

**Call relations**: Only `Tty::open` uses this helper when trying the preferred duplicated-stdio path.

*Call graph*: 3 external calls (from_raw_fd, last_os_error, dup).


##### `imp::cursor_position`  (lines 240–244)

```
fn cursor_position(timeout: Duration) -> io::Result<Option<Position>>
```

**Purpose**: Queries the terminal for the current cursor position under a bounded timeout on Unix. It is used while normal input polling is paused.

**Data flow**: It opens a `Tty`, writes the `ESC [ 6 n` query, then calls `read_until(&mut tty, timeout, parse_cursor_position)` and returns the resulting `io::Result<Option<Position>>`.

**Call relations**: Suspend/resume logic calls this Unix probe. It delegates generic bounded reading to `read_until` and parsing to `parse_cursor_position`.

*Call graph*: called by 1 (suspend); 2 external calls (open, read_until).


##### `imp::startup`  (lines 250–264)

```
fn startup(
        timeout: Duration,
        keyboard_probe: StartupKeyboardEnhancementProbe,
    ) -> io::Result<StartupProbe>
```

**Purpose**: Runs the Unix startup probe batch under one shared deadline, optionally including keyboard-enhancement detection. It minimizes startup latency by sending all desired queries together.

**Data flow**: It opens a `Tty`, writes either a combined cursor/default-colors/keyboard query sequence or a cursor/default-colors-only sequence depending on `keyboard_probe`, then calls `read_startup_probe(&mut tty, timeout, keyboard_probe)` and returns the resulting `StartupProbe`.

**Call relations**: TUI initialization calls this Unix entry point during startup. It delegates all response accumulation and parsing to `read_startup_probe`.

*Call graph*: called by 1 (init); 2 external calls (open, read_startup_probe).


##### `imp::read_startup_probe`  (lines 293–327)

```
fn read_startup_probe(
        tty: &mut Tty,
        timeout: Duration,
        keyboard_probe: StartupKeyboardEnhancementProbe,
    ) -> io::Result<StartupProbe>
```

**Purpose**: Accumulates Unix startup probe responses until all requested fields are known or the deadline expires. It is the main batched-response read loop.

**Data flow**: It takes a mutable `Tty`, timeout, and keyboard probe mode; computes a deadline; initializes an empty byte buffer and `StartupProbe` with all fields `None`; tracks `saw_supported_keyboard`; repeatedly reads available bytes, updates the probe via `update_startup_probe`, returns early when `startup_probe_complete` is true, or on timeout/poll expiry calls `finish_startup_probe` before returning the partially filled probe.

**Call relations**: Only `startup` calls this helper. It orchestrates repeated reads and delegates field extraction and completion logic to smaller helpers.

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

**Purpose**: Parses the accumulated startup-response buffer and fills any still-missing fields in the `StartupProbe`. It also tracks intermediate keyboard-support evidence.

**Data flow**: It mutably updates `probe` and `saw_supported_keyboard` from `buffer`: fills `cursor_position` via `parse_cursor_position` if absent, fills `default_colors` via `parse_default_colors` if absent, and unless keyboard probing is skipped or already resolved, interprets `parse_keyboard_enhancement_support(buffer)` to set `keyboard_enhancement_supported` to `Some(true)` or `Some(false)` or to remember that support was seen pending fallback drainage.

**Call relations**: This is called on each iteration of `read_startup_probe`. It delegates actual byte parsing to the cursor, color, and keyboard parsers.

*Call graph*: calls 1 internal fn (parse_default_colors); 2 external calls (parse_cursor_position, parse_keyboard_enhancement_support).


##### `imp::startup_probe_complete`  (lines 360–368)

```
fn startup_probe_complete(
        probe: &StartupProbe,
        keyboard_probe: StartupKeyboardEnhancementProbe,
    ) -> bool
```

**Purpose**: Determines whether a startup probe has collected all fields required for the chosen probe mode. It is the early-exit condition for the batched read loop.

**Data flow**: It reads `probe.cursor_position`, `probe.default_colors`, and, when keyboard probing is enabled, `probe.keyboard_enhancement_supported`, and returns `true` only when all required fields are `Some`.

**Call relations**: Only `read_startup_probe` uses this helper to decide whether it can stop before the deadline.


##### `imp::finish_startup_probe`  (lines 370–380)

```
fn finish_startup_probe(
        probe: &mut StartupProbe,
        keyboard_probe: StartupKeyboardEnhancementProbe,
        saw_supported_keyboard: bool,
    )
```

**Purpose**: Finalizes keyboard-enhancement support at timeout when support was observed but the fallback response never arrived. It converts remembered partial evidence into a final probe result.

**Data flow**: It mutates `probe.keyboard_enhancement_supported` to `Some(true)` when keyboard probing was requested, the field is still `None`, and `saw_supported_keyboard` is true; otherwise it leaves the probe unchanged.

**Call relations**: Timeout and poll-expiry paths in `read_startup_probe` call this before returning a partial startup probe.


##### `imp::parse_cursor_position`  (lines 382–405)

```
fn parse_cursor_position(buffer: &[u8]) -> Option<Position>
```

**Purpose**: Scans an arbitrary byte buffer for a cursor-position report and returns it as zero-based coordinates. It tolerates unrelated bytes before the response.

**Data flow**: It iterates over all indices where the buffer contains `ESC [`, slices until the next `R`, decodes the payload as UTF-8, splits it on `;`, parses row and column as `u16`, subtracts one from each with saturation, and returns `Some(Position { x: col, y: row })` for the first valid match or `None`.

**Call relations**: Unix cursor and startup probes use this parser through `read_until` or `update_startup_probe`.

*Call graph*: 2 external calls (from_utf8, find_all_subslices).


##### `imp::parse_keyboard_enhancement_support`  (lines 423–433)

```
fn parse_keyboard_enhancement_support(buffer: &[u8]) -> KeyboardProbeState
```

**Purpose**: Classifies the current startup-response buffer with respect to keyboard-enhancement support and fallback device attributes. It distinguishes pending, supported, unsupported, and supported-plus-fallback states.

**Data flow**: It checks whether `find_keyboard_flags(buffer)` and `find_primary_device_attributes(buffer)` return `Some`, then maps the boolean pair to `KeyboardProbeState::{SupportedAndFallback, Supported, UnsupportedFallback, Pending}`.

**Call relations**: Only `update_startup_probe` calls this helper while resolving keyboard support during startup.

*Call graph*: 2 external calls (find_keyboard_flags, find_primary_device_attributes).


##### `imp::find_keyboard_flags`  (lines 435–466)

```
fn find_keyboard_flags(buffer: &[u8]) -> Option<KeyboardEnhancementFlags>
```

**Purpose**: Searches a byte buffer for a keyboard-enhancement flag response and decodes the reported bitfield into `KeyboardEnhancementFlags`. It ignores malformed or incomplete sequences.

**Data flow**: It scans all `ESC [?` subsequences, looks for a terminating `u`, decodes the intervening bytes as UTF-8 and then `u8`, constructs an empty flag set, sets individual crossterm flags based on bits 1, 2, 4, and 8, and returns the first successfully decoded flag set or `None`.

**Call relations**: This parser feeds `parse_keyboard_enhancement_support` during startup probing.

*Call graph*: 3 external calls (empty, from_utf8, find_all_subslices).


##### `imp::find_primary_device_attributes`  (lines 468–479)

```
fn find_primary_device_attributes(buffer: &[u8]) -> Option<()>
```

**Purpose**: Searches a byte buffer for a primary-device-attributes response used as the keyboard-probe fallback signal. It only accepts digit-and-semicolon payloads ending in `c`.

**Data flow**: It scans all `ESC [?` subsequences, looks for a terminating `c`, and returns `Some(())` when the payload is non-empty and consists only of ASCII digits or semicolons; otherwise it returns `None`.

**Call relations**: This helper is paired with `find_keyboard_flags` inside `parse_keyboard_enhancement_support`.

*Call graph*: 1 external calls (find_all_subslices).


##### `imp::find_all_subslices`  (lines 481–489)

```
fn find_all_subslices(
        haystack: &'a [u8],
        needle: &'a [u8],
    ) -> impl Iterator<Item = usize> + 'a
```

**Purpose**: Returns an iterator over every start index where a needle byte slice occurs inside a haystack. It is a small generic scanner used by Unix parsers.

**Data flow**: It iterates over `haystack.windows(needle.len()).enumerate()`, filters windows equal to `needle`, and yields their indices.

**Call relations**: Cursor-position and keyboard-response parsers use this helper to find candidate escape-sequence starts.


##### `imp::tests::parses_cursor_position_as_zero_based`  (lines 497–506)

```
fn parses_cursor_position_as_zero_based()
```

**Purpose**: Verifies that cursor-position parsing finds the response amid unrelated bytes and converts one-based terminal coordinates to zero-based positions. It protects parser semantics.

**Data flow**: The test calls `parse_cursor_position` on plain and prefixed buffers and asserts `Position { x: 9, y: 19 }` for `ESC[20;10R`.

**Call relations**: This test exercises the Unix cursor parser directly.

*Call graph*: 1 external calls (assert_eq!).


##### `imp::tests::parses_keyboard_enhancement_flags_and_pda_fallback`  (lines 509–530)

```
fn parses_keyboard_enhancement_flags_and_pda_fallback()
```

**Purpose**: Checks all keyboard-probe parser states: supported, unsupported fallback, supported plus fallback, and pending. It validates the startup keyboard-detection state machine.

**Data flow**: It calls `parse_keyboard_enhancement_support` on representative buffers and asserts the expected `KeyboardProbeState` values.

**Call relations**: This test isolates the keyboard-support parser used by `update_startup_probe`.

*Call graph*: 1 external calls (assert_eq!).


##### `imp::tests::startup_probe_parses_batched_terminal_responses`  (lines 533–562)

```
fn startup_probe_parses_batched_terminal_responses()
```

**Purpose**: Verifies that a single mixed response buffer can populate all startup probe fields correctly. It validates the batched parsing strategy used during startup.

**Data flow**: It initializes an empty `StartupProbe`, calls `update_startup_probe` with a buffer containing cursor, background color, PDA fallback, foreground color, and keyboard flags, then asserts the fully populated probe contents and that `startup_probe_complete` returns true.

**Call relations**: This test exercises `update_startup_probe` and the completion logic together on realistic batched input.

*Call graph*: 3 external calls (assert!, assert_eq!, update_startup_probe).


##### `imp::default_colors`  (lines 595–607)

```
fn default_colors(timeout: Duration) -> io::Result<Option<DefaultColors>>
```

**Purpose**: Queries default terminal colors on Windows, preferring OSC 10/11 replies when possible and falling back to console attribute/color-table decoding otherwise. Missing support is reported as `Ok(None)` rather than an error.

**Data flow**: It tries to obtain the stdout handle; if that fails it returns `Ok(None)`. If stdin is also available, it attempts `query_osc_default_colors(input, output, timeout)` and returns `Some(colors)` on success. Otherwise it calls `query_console_default_colors(output)` and returns its optional result, converting errors into `Ok(None)` only at the outer fallback boundary.

**Call relations**: The palette module's Windows cache initialization calls this probe. It delegates the two concrete strategies to `query_osc_default_colors` and `query_console_default_colors`.

*Call graph*: called by 2 (query_default_colors, probe_windows_default_colors); 5 external calls (open, query_console_default_colors, query_osc_default_colors, read_until, std_handle).


##### `imp::query_osc_default_colors`  (lines 609–617)

```
fn query_osc_default_colors(
        input: HANDLE,
        output: HANDLE,
        timeout: Duration,
    ) -> io::Result<Option<DefaultColors>>
```

**Purpose**: Performs the Windows OSC 10/11 color query path using raw console handles and temporary virtual-terminal input mode. It is the preferred path when the terminal supports OSC replies.

**Data flow**: It enables VT input on the input handle via `VirtualTerminalInputMode::enable`, writes the combined OSC 10/11 query bytes to the output handle with `write_all`, then calls `read_until(input, timeout, parse_default_colors)` and returns the parsed optional colors.

**Call relations**: Windows `default_colors` calls this first when both stdin and stdout handles are available.

*Call graph*: 3 external calls (enable, read_until, write_all).


##### `imp::query_console_default_colors`  (lines 619–629)

```
fn query_console_default_colors(output: HANDLE) -> io::Result<Option<DefaultColors>>
```

**Purpose**: Reads Windows console default colors from `CONSOLE_SCREEN_BUFFER_INFOEX` when OSC probing is unavailable or unsupported. It is the fallback path for native console environments.

**Data flow**: It zero-initializes a `CONSOLE_SCREEN_BUFFER_INFOEX`, sets its `cbSize`, calls `GetConsoleScreenBufferInfoEx`, returns an `io::Error` on failure, otherwise decodes `wAttributes` and `ColorTable` through `decode_console_default_colors` and wraps the result in `Some`.

**Call relations**: Windows `default_colors` uses this after OSC probing fails or is unavailable.

*Call graph*: 3 external calls (last_os_error, decode_console_default_colors, GetConsoleScreenBufferInfoEx).


##### `imp::decode_console_default_colors`  (lines 631–640)

```
fn decode_console_default_colors(attributes: u16, color_table: &[u32; 16]) -> DefaultColors
```

**Purpose**: Derives foreground and background RGB tuples from Windows console attribute indices and the console color table. It intentionally ignores reverse-video rendering flags.

**Data flow**: It extracts the low 4 bits of `attributes` as the foreground index and bits 4..7 as the background index, looks up both entries in `color_table`, decodes each `COLORREF` with `decode_color_ref`, and returns `DefaultColors { fg, bg }`.

**Call relations**: Only `query_console_default_colors` and Windows tests use this decoder.

*Call graph*: 1 external calls (decode_color_ref).


##### `imp::decode_color_ref`  (lines 642–648)

```
fn decode_color_ref(color_ref: u32) -> (u8, u8, u8)
```

**Purpose**: Converts a Windows `COLORREF` integer into an `(r, g, b)` tuple. It decodes the byte order used by the console color table.

**Data flow**: It extracts the low, middle, and high bytes of `color_ref` as red, green, and blue respectively and returns them as a tuple.

**Call relations**: This helper is used only by `decode_console_default_colors`.


##### `imp::std_handle`  (lines 650–656)

```
fn std_handle(kind: u32) -> io::Result<HANDLE>
```

**Purpose**: Obtains a Windows standard handle and rejects null or invalid-handle results. It is the basic handle acquisition helper for probes.

**Data flow**: It calls `GetStdHandle(kind)`, returns `io::Error::last_os_error()` when the handle is `0` or `INVALID_HANDLE_VALUE`, and otherwise returns the handle.

**Call relations**: Windows probe entry points call this before attempting OSC or console queries.

*Call graph*: 2 external calls (last_os_error, GetStdHandle).


##### `imp::VirtualTerminalInputMode::enable`  (lines 664–679)

```
fn enable(handle: HANDLE) -> io::Result<Self>
```

**Purpose**: Temporarily enables `ENABLE_VIRTUAL_TERMINAL_INPUT` on a Windows console input handle and remembers the original mode for restoration. This allows OSC response bytes to be read as VT input.

**Data flow**: It reads the current console mode with `GetConsoleMode`, ORs in `ENABLE_VIRTUAL_TERMINAL_INPUT`, applies the new mode with `SetConsoleMode`, and returns `VirtualTerminalInputMode { handle, original_mode }` or an `io::Error` on failure.

**Call relations**: Only `query_osc_default_colors` uses this RAII helper before reading OSC replies.

*Call graph*: 3 external calls (last_os_error, GetConsoleMode, SetConsoleMode).


##### `imp::VirtualTerminalInputMode::drop`  (lines 683–687)

```
fn drop(&mut self)
```

**Purpose**: Restores the original Windows console input mode when the temporary VT-input guard is dropped. This prevents probe-specific mode changes from leaking outward.

**Data flow**: On drop it calls `SetConsoleMode(self.handle, self.original_mode)` and ignores the result.

**Call relations**: This runs automatically after `query_osc_default_colors` finishes.

*Call graph*: 1 external calls (SetConsoleMode).


##### `imp::write_all`  (lines 690–711)

```
fn write_all(handle: HANDLE, mut bytes: &[u8]) -> io::Result<()>
```

**Purpose**: Writes an entire byte slice to a Windows handle, retrying until all bytes are written or an error occurs. It is the raw-handle equivalent of `Write::write_all`.

**Data flow**: It loops while `bytes` is non-empty, calls `WriteFile`, errors on API failure or zero bytes written, slices off the written prefix, and returns `Ok(())` once all bytes are sent.

**Call relations**: Windows OSC probing uses this to send query sequences to the output handle.

*Call graph*: 4 external calls (from, last_os_error, null_mut, WriteFile).


##### `imp::read_until`  (lines 713–739)

```
fn read_until(
        handle: HANDLE,
        timeout: Duration,
        mut parse: impl FnMut(&[u8]) -> Option<T>,
    ) -> io::Result<Option<T>>
```

**Purpose**: Reads from a Windows handle until a parser recognizes a response or the deadline expires. It is the bounded read loop used by OSC probing.

**Data flow**: It computes a deadline, initializes an empty byte buffer, repeatedly tries `parse(&buffer)`, returns `Some(value)` when parsing succeeds, otherwise waits with `WaitForSingleObject(handle, timeout_ms)`, calls `read_once` on readiness, returns `Ok(None)` on timeout, and propagates wait errors.

**Call relations**: Windows OSC probing delegates its bounded response collection to this helper.

*Call graph*: 7 external calls (now, new, last_os_error, poll_readable, read_available, read_once, WaitForSingleObject).


##### `imp::read_once`  (lines 741–758)

```
fn read_once(handle: HANDLE, buffer: &mut Vec<u8>) -> io::Result<()>
```

**Purpose**: Reads one chunk of bytes from a Windows handle into an existing buffer. It is the low-level primitive used by the Windows read loop.

**Data flow**: It allocates a 256-byte stack buffer, calls `ReadFile`, returns an `io::Error` on failure, extends the provided `Vec<u8>` with the bytes actually read, and returns `Ok(())`.

**Call relations**: Only Windows `read_until` uses this helper.

*Call graph*: 3 external calls (last_os_error, null_mut, ReadFile).


##### `imp::tests::color_table`  (lines 766–772)

```
fn color_table() -> [u32; 16]
```

**Purpose**: Provides a deterministic 16-entry Windows console color table fixture for decoding tests. It mirrors the shape of the real console color table.

**Data flow**: It returns a fixed `[u32; 16]` array of `COLORREF` values.

**Call relations**: The Windows console-color decoding tests use this helper as shared fixture data.


##### `imp::tests::decodes_console_color_attribute_indices`  (lines 775–783)

```
fn decodes_console_color_attribute_indices()
```

**Purpose**: Verifies that foreground and background indices are extracted correctly from console attributes. It protects the basic attribute-decoding logic.

**Data flow**: It calls `decode_console_default_colors(0x21, &color_table())` and asserts the expected foreground/background RGB tuples.

**Call relations**: This test exercises the normal attribute-index path of Windows console decoding.

*Call graph*: 1 external calls (assert_eq!).


##### `imp::tests::decodes_console_color_intensity_indices`  (lines 786–794)

```
fn decodes_console_color_intensity_indices()
```

**Purpose**: Verifies that high-intensity attribute bits select the correct bright palette entries. It protects decoding of the full 4-bit fg/bg indices.

**Data flow**: It calls `decode_console_default_colors(0xe9, &color_table())` and asserts the expected bright colors.

**Call relations**: This test covers another representative attribute combination for Windows decoding.

*Call graph*: 1 external calls (assert_eq!).


##### `imp::tests::decodes_console_color_ref_byte_order`  (lines 797–809)

```
fn decodes_console_color_ref_byte_order()
```

**Purpose**: Checks that `COLORREF` byte order is decoded correctly into RGB tuples. It protects against channel-order mistakes.

**Data flow**: It mutates two entries in the fixture color table, calls `decode_console_default_colors(0x43, &colors)`, and asserts the expected RGB tuples derived from those `COLORREF` values.

**Call relations**: This test isolates `decode_color_ref` behavior through the higher-level decoder.

*Call graph*: 2 external calls (assert_eq!, color_table).


##### `imp::tests::ignores_reverse_video_when_decoding_default_colors`  (lines 812–823)

```
fn ignores_reverse_video_when_decoding_default_colors()
```

**Purpose**: Verifies that reverse-video flags do not swap the decoded default foreground/background colors. The probe is meant to discover configured defaults, not current rendering inversion.

**Data flow**: It calls `decode_console_default_colors(COMMON_LVB_REVERSE_VIDEO | 0x21, &color_table())` and asserts the same result as without reverse video.

**Call relations**: This test protects the design choice documented in `decode_console_default_colors`.

*Call graph*: 1 external calls (assert_eq!).


##### `parse_osc_color`  (lines 827–835)

```
fn parse_osc_color(buffer: &[u8], slot: u8) -> Option<(u8, u8, u8)>
```

**Purpose**: Extracts and parses one OSC color response for a specific slot number from an arbitrary byte buffer. It supports both BEL and ST terminators.

**Data flow**: It formats the slot-specific prefix `ESC ] {slot} ;`, finds that subsequence with `find_subslice`, slices the payload after the prefix, finds the payload terminator with `osc_payload_end`, decodes the payload as UTF-8, parses it with `parse_osc_rgb`, and returns the resulting RGB tuple or `None`.

**Call relations**: `parse_default_colors` calls this twice, once for slot 10 and once for slot 11.

*Call graph*: calls 3 internal fn (find_subslice, osc_payload_end, parse_osc_rgb); called by 1 (parse_default_colors); 2 external calls (format!, from_utf8).


##### `parse_default_colors`  (lines 837–841)

```
fn parse_default_colors(buffer: &[u8]) -> Option<DefaultColors>
```

**Purpose**: Parses both OSC 10 foreground and OSC 11 background replies from one accumulated byte buffer. It succeeds only when both colors are present and valid.

**Data flow**: It calls `parse_osc_color(buffer, 10)` and `parse_osc_color(buffer, 11)`, returns `Some(DefaultColors { fg, bg })` when both succeed, and `None` otherwise.

**Call relations**: Startup and default-color probes use this parser through their read loops and startup-buffer updater.

*Call graph*: calls 1 internal fn (parse_osc_color); called by 1 (update_startup_probe).


##### `osc_payload_end`  (lines 843–853)

```
fn osc_payload_end(buffer: &[u8]) -> Option<(usize, usize)>
```

**Purpose**: Finds the end of an OSC payload by locating either a BEL terminator or an ST (`ESC \`) terminator. It returns both the payload length and terminator length.

**Data flow**: It scans the byte buffer from index 0, returning `Some((idx, 1))` on byte `0x07`, `Some((idx, 2))` on `ESC \`, or `None` if no terminator is found.

**Call relations**: Only `parse_osc_color` uses this helper while slicing OSC payload text.

*Call graph*: called by 1 (parse_osc_color).


##### `parse_osc_rgb`  (lines 855–869)

```
fn parse_osc_rgb(payload: &str) -> Option<(u8, u8, u8)>
```

**Purpose**: Parses an OSC `rgb:` or `rgba:` payload into an 8-bit RGB tuple. It accepts either 2-digit or 4-digit hex components and ignores alpha except for validating its presence in `rgba` form.

**Data flow**: It trims the payload, splits once on `:`, rejects prefixes other than `rgb` or `rgba` ignoring ASCII case, splits the value string on `/`, parses three components with `parse_osc_component`, parses and discards a fourth component for `rgba`, ensures no extra components remain, and returns `Some((r,g,b))` or `None`.

**Call relations**: `parse_osc_color` delegates payload decoding to this helper.

*Call graph*: calls 1 internal fn (parse_osc_component); called by 1 (parse_osc_color).


##### `parse_osc_component`  (lines 871–879)

```
fn parse_osc_component(component: &str) -> Option<u8>
```

**Purpose**: Parses one OSC color component from either 2-digit or 4-digit hexadecimal into an 8-bit value. Four-digit values are downscaled by dividing by 257.

**Data flow**: It matches on `component.len()`: length 2 parses as `u8` hex directly, length 4 parses as `u16` hex and maps to `(value / 257) as u8`, and all other lengths return `None`.

**Call relations**: Only `parse_osc_rgb` uses this helper.

*Call graph*: called by 1 (parse_osc_rgb); 2 external calls (from_str_radix, from_str_radix).


##### `find_subslice`  (lines 881–885)

```
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize>
```

**Purpose**: Finds the first occurrence of a needle byte slice inside a haystack. It is the simple shared search primitive for OSC parsing.

**Data flow**: It iterates over `haystack.windows(needle.len())`, returns the first matching position, or `None` if no match exists.

**Call relations**: Only `parse_osc_color` uses this helper.

*Call graph*: called by 1 (parse_osc_color).


##### `tests::parses_osc_colors_with_bel_and_st`  (lines 896–905)

```
fn parses_osc_colors_with_bel_and_st()
```

**Purpose**: Verifies that OSC color parsing accepts both BEL and ST terminators and correctly decodes 4-digit and 2-digit component forms. It protects terminator handling.

**Data flow**: It calls `parse_osc_color` on one BEL-terminated slot-10 response and one ST-terminated slot-11 response, asserting the expected RGB tuples.

**Call relations**: This test exercises `parse_osc_color`, `osc_payload_end`, and `parse_osc_rgb` together.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_two_and_four_digit_color_components`  (lines 908–914)

```
fn parses_two_and_four_digit_color_components()
```

**Purpose**: Checks direct parsing of `rgb:` and `rgba:` payload strings with mixed component widths. It validates component decoding and alpha handling.

**Data flow**: It calls `parse_osc_rgb` on representative payloads and asserts the expected RGB tuples.

**Call relations**: This test isolates the payload parser from surrounding OSC framing.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_default_colors_from_one_buffer`  (lines 917–936)

```
fn parses_default_colors_from_one_buffer()
```

**Purpose**: Verifies that foreground and background colors can be parsed from one mixed buffer regardless of response order, and that a missing slot yields `None`. It protects the combined parser.

**Data flow**: It calls `parse_default_colors` on buffers containing both slot 10 and slot 11 in both orders and on a buffer containing only slot 10, asserting the expected `Some(DefaultColors)` or `None` results.

**Call relations**: This test exercises the order-insensitive behavior of `parse_default_colors`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::ignores_malformed_or_partial_default_color_responses`  (lines 939–952)

```
fn ignores_malformed_or_partial_default_color_responses()
```

**Purpose**: Ensures malformed, overlong, or unterminated OSC color replies do not produce a default-color result. It protects parser robustness against partial terminal responses.

**Data flow**: It calls `parse_default_colors` on several invalid buffers and asserts `None` each time.

**Call relations**: This test covers failure paths in the shared OSC color parsers.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_default_colors_with_unrelated_bytes`  (lines 955–965)

```
fn parses_default_colors_with_unrelated_bytes()
```

**Purpose**: Verifies that default-color parsing can find valid OSC replies amid unrelated surrounding bytes. It matches the real probe environment where buffers may contain noise.

**Data flow**: It calls `parse_default_colors` on a buffer containing arbitrary text plus valid slot-10 and slot-11 replies and asserts the expected `DefaultColors` result.

**Call relations**: This test validates the parser's subsequence-search behavior rather than requiring a clean buffer.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/tui/keyboard_modes.rs`

`util` · `startup and teardown`

This file centralizes keyboard-reporting policy and terminal command emission. The top-level decision point is `keyboard_enhancement_disabled`, which checks the `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT` environment variable, whether the process is running under WSL, and whether the terminal appears to be VS Code. The helper `keyboard_enhancement_disabled_for` gives explicit environment override precedence; only when no explicit boolean is present does it auto-disable for the WSL + VS Code combination. VS Code detection can inspect both the Linux-side `TERM_PROGRAM` and, on Linux, a cached Windows-side `TERM_PROGRAM` fetched through `cmd.exe`, because WSL shells may hide the Windows environment.

When enhancement is enabled, `enable_keyboard_enhancement` first emits `DisableModifyOtherKeys` and pushes crossterm `KeyboardEnhancementFlags` for escape-code disambiguation, event-type reporting, and alternate-key reporting. It then conditionally enables xterm `modifyOtherKeys` mode 2 only when running inside tmux and tmux explicitly reports `extended-keys-format` as `csi-u`; this avoids terminals or tmux versions that emit incompatible modified-key sequences. Teardown has two strengths: `restore_keyboard_enhancement_stack` pops the normal crossterm stack and disables `modifyOtherKeys`, while `reset_keyboard_reporting_after_exit` additionally emits a custom `ResetKeyboardEnhancementFlags` ANSI sequence to clear all pushed levels on process exit.

The file also defines the custom command types `ResetKeyboardEnhancementFlags`, `EnableModifyOtherKeys`, and `DisableModifyOtherKeys`, each implemented as ANSI-only commands with unsupported WinAPI fallbacks.

#### Function details

##### `keyboard_enhancement_disabled`  (lines 18–23)

```
fn keyboard_enhancement_disabled() -> bool
```

**Purpose**: Determines whether keyboard enhancement should be disabled in the current environment.

**Data flow**: Reads `CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT` from the environment, computes `is_wsl` via `running_in_wsl()`, computes `is_vscode_terminal` as `is_wsl && running_in_vscode_terminal()`, passes those values to `keyboard_enhancement_disabled_for`, and returns the resulting bool.

**Call relations**: Called by `init` and `enable_keyboard_enhancement` to decide whether startup should attempt enhanced keyboard reporting.

*Call graph*: calls 3 internal fn (keyboard_enhancement_disabled_for, running_in_vscode_terminal, running_in_wsl); called by 2 (init, enable_keyboard_enhancement); 1 external calls (var).


##### `keyboard_enhancement_disabled_for`  (lines 25–38)

```
fn keyboard_enhancement_disabled_for(
    disable_env: Option<&str>,
    is_wsl: bool,
    is_vscode_terminal: bool,
) -> bool
```

**Purpose**: Applies explicit env override and fallback auto-detection rules to decide whether enhancement is disabled.

**Data flow**: Takes optional env text plus `is_wsl` and `is_vscode_terminal` booleans. If `parse_bool_env` returns `Some`, that value is returned immediately; otherwise it returns `is_wsl && is_vscode_terminal`.

**Call relations**: Pure helper used by `keyboard_enhancement_disabled` and directly by tests.

*Call graph*: calls 1 internal fn (parse_bool_env); called by 1 (keyboard_enhancement_disabled).


##### `parse_bool_env`  (lines 40–50)

```
fn parse_bool_env(value: Option<&str>) -> Option<bool>
```

**Purpose**: Parses common textual boolean environment values into `Some(true)`, `Some(false)`, or `None` for unrecognized input.

**Data flow**: Trims the optional string and matches accepted truthy values (`1`, `true`, `yes`) and falsy values (`0`, `false`, `no`) case-insensitively, returning `Option<bool>`.

**Call relations**: Used only by `keyboard_enhancement_disabled_for`.

*Call graph*: called by 1 (keyboard_enhancement_disabled_for).


##### `running_in_wsl`  (lines 52–62)

```
fn running_in_wsl() -> bool
```

**Purpose**: Detects whether the process is probably running under Windows Subsystem for Linux.

**Data flow**: On Linux, delegates to `crate::clipboard_paste::is_probably_wsl()`; on non-Linux targets returns `false`.

**Call relations**: Used by keyboard-enhancement policy to gate the VS Code auto-disable workaround.

*Call graph*: calls 1 internal fn (is_probably_wsl); called by 1 (keyboard_enhancement_disabled).


##### `running_in_vscode_terminal`  (lines 64–69)

```
fn running_in_vscode_terminal() -> bool
```

**Purpose**: Detects whether the terminal appears to be VS Code, considering both Linux and Windows-side environment sources.

**Data flow**: Reads Linux `TERM_PROGRAM`, obtains optional Windows-side `TERM_PROGRAM` via `windows_term_program()`, passes both to `vscode_terminal_detected`, and returns the bool result.

**Call relations**: Used by `keyboard_enhancement_disabled` and re-exported through `tui::running_in_vscode_terminal`.

*Call graph*: calls 2 internal fn (vscode_terminal_detected, windows_term_program); called by 2 (keyboard_enhancement_disabled, running_in_vscode_terminal); 1 external calls (var).


##### `vscode_terminal_detected`  (lines 71–76)

```
fn vscode_terminal_detected(
    linux_term_program: Option<&str>,
    windows_term_program: Option<&str>,
) -> bool
```

**Purpose**: Determines whether either provided `TERM_PROGRAM` value identifies VS Code.

**Data flow**: Calls `term_program_is_vscode` on both `linux_term_program` and `windows_term_program`, returning true if either matches.

**Call relations**: Pure helper used by `running_in_vscode_terminal` and tests.

*Call graph*: calls 1 internal fn (term_program_is_vscode); called by 1 (running_in_vscode_terminal).


##### `term_program_is_vscode`  (lines 78–80)

```
fn term_program_is_vscode(value: Option<&str>) -> bool
```

**Purpose**: Checks whether an optional terminal-program string equals `vscode`, case-insensitively.

**Data flow**: Returns `value.is_some_and(|v| v.eq_ignore_ascii_case("vscode"))`.

**Call relations**: Used only by `vscode_terminal_detected`.

*Call graph*: called by 1 (vscode_terminal_detected).


##### `windows_term_program`  (lines 82–96)

```
fn windows_term_program() -> Option<String>
```

**Purpose**: Fetches and caches the Windows-side `TERM_PROGRAM` value when running on Linux, otherwise returns none.

**Data flow**: On Linux, uses a `OnceLock<Option<String>>` to memoize `read_windows_term_program()` and returns a clone of the cached option; on non-Linux returns `None`.

**Call relations**: Used by `running_in_vscode_terminal` to compensate for WSL environment visibility issues.

*Call graph*: called by 1 (running_in_vscode_terminal); 1 external calls (new).


##### `read_windows_term_program`  (lines 99–119)

```
fn read_windows_term_program() -> Option<String>
```

**Purpose**: Queries `cmd.exe` for the Windows environment variable `TERM_PROGRAM` and extracts its value.

**Data flow**: Runs `cmd.exe /d /s /c set TERM_PROGRAM` with null stdin/stderr, returns `None` on process failure, otherwise decodes stdout lossily, scans lines for a `TERM_PROGRAM=` prefix, strips trailing CR, converts the value to `String`, filters out empty strings, and returns `Option<String>`.

**Call relations**: Called lazily by `windows_term_program` on Linux.

*Call graph*: 3 external calls (from_utf8_lossy, new, null).


##### `enable_keyboard_enhancement`  (lines 121–139)

```
fn enable_keyboard_enhancement()
```

**Purpose**: Enables enhanced keyboard reporting for the TUI unless policy disables it.

**Data flow**: Returns early if `keyboard_enhancement_disabled()` is true. Otherwise emits `DisableModifyOtherKeys` and `PushKeyboardEnhancementFlags(DISAMBIGUATE_ESCAPE_CODES | REPORT_EVENT_TYPES | REPORT_ALTERNATE_KEYS)`, then if `tmux_should_enable_modify_other_keys()` is true emits `EnableModifyOtherKeys`. All command execution errors are ignored.

**Call relations**: Called by `set_modes` during terminal initialization and restoration after external handoff.

*Call graph*: calls 2 internal fn (keyboard_enhancement_disabled, tmux_should_enable_modify_other_keys); called by 1 (set_modes); 1 external calls (execute!).


##### `running_in_tmux_session`  (lines 141–146)

```
fn running_in_tmux_session() -> bool
```

**Purpose**: Detects whether the process appears to be inside a tmux session.

**Data flow**: Reads `TMUX` and `TMUX_PANE` from the environment, passes them to `tmux_session_detected`, and returns the bool result.

**Call relations**: Used by `tmux_should_enable_modify_other_keys`.

*Call graph*: calls 1 internal fn (tmux_session_detected); called by 1 (tmux_should_enable_modify_other_keys); 1 external calls (var).


##### `tmux_session_detected`  (lines 148–150)

```
fn tmux_session_detected(tmux: Option<&str>, tmux_pane: Option<&str>) -> bool
```

**Purpose**: Determines tmux presence from the standard tmux environment variables.

**Data flow**: Returns true if either `tmux` or `tmux_pane` is `Some(_)`, otherwise false.

**Call relations**: Pure helper used by `running_in_tmux_session` and tests.

*Call graph*: called by 1 (running_in_tmux_session).


##### `tmux_should_enable_modify_other_keys`  (lines 152–157)

```
fn tmux_should_enable_modify_other_keys() -> bool
```

**Purpose**: Determines whether xterm `modifyOtherKeys` mode should be enabled inside tmux.

**Data flow**: Computes `running_in_tmux_session()`, reads tmux’s `extended-keys-format` via `read_tmux_extended_keys_format()`, passes both to `tmux_should_enable_modify_other_keys_for`, and returns the bool result.

**Call relations**: Used by `enable_keyboard_enhancement` to avoid enabling incompatible modified-key reporting.

*Call graph*: calls 3 internal fn (read_tmux_extended_keys_format, running_in_tmux_session, tmux_should_enable_modify_other_keys_for); called by 1 (enable_keyboard_enhancement).


##### `tmux_should_enable_modify_other_keys_for`  (lines 159–167)

```
fn tmux_should_enable_modify_other_keys_for(
    running_in_tmux_session: bool,
    extended_keys_format: Option<&str>,
) -> bool
```

**Purpose**: Applies the policy that `modifyOtherKeys` should only be enabled when tmux confirms `csi-u` formatting.

**Data flow**: Returns true only when `running_in_tmux_session` is true and `extended_keys_format` matches `Some("csi-u")`; otherwise false.

**Call relations**: Pure helper used by `tmux_should_enable_modify_other_keys` and tests.

*Call graph*: called by 1 (tmux_should_enable_modify_other_keys); 1 external calls (matches!).


##### `read_tmux_extended_keys_format`  (lines 169–195)

```
fn read_tmux_extended_keys_format() -> Option<String>
```

**Purpose**: Queries tmux for its configured extended-keys format using two fallback commands.

**Data flow**: Iterates over `tmux display-message -p #{extended-keys-format}` and `tmux show-options -gqv extended-keys-format`, running each with null stdin/stderr. For the first successful command, it decodes stdout as UTF-8, trims whitespace, filters out empty strings, and returns `Some(value)`; otherwise returns `None`.

**Call relations**: Used by `tmux_should_enable_modify_other_keys`.

*Call graph*: called by 1 (tmux_should_enable_modify_other_keys); 3 external calls (from_utf8, new, null).


##### `restore_keyboard_enhancement_stack`  (lines 197–203)

```
fn restore_keyboard_enhancement_stack()
```

**Purpose**: Restores keyboard reporting using the normal paired stack-pop path.

**Data flow**: Best-effort executes `PopKeyboardEnhancementFlags` and `DisableModifyOtherKeys` to stdout, ignoring errors.

**Call relations**: Called by `restore_common` for ordinary terminal restoration.

*Call graph*: called by 1 (restore_common); 1 external calls (execute!).


##### `reset_keyboard_reporting_after_exit`  (lines 205–212)

```
fn reset_keyboard_reporting_after_exit()
```

**Purpose**: Performs a stronger keyboard-reporting reset intended for process exit.

**Data flow**: Best-effort executes `PopKeyboardEnhancementFlags`, `ResetKeyboardEnhancementFlags`, and `DisableModifyOtherKeys` to stdout, ignoring errors.

**Call relations**: Called by `restore_common` when `restore_after_exit` requests the stronger shell-protecting reset.

*Call graph*: called by 1 (restore_common); 1 external calls (execute!).


##### `ResetKeyboardEnhancementFlags::write_ansi`  (lines 218–220)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Serializes the ANSI sequence that resets all pushed keyboard enhancement levels.

**Data flow**: Writes `\x1b[<u` into the provided formatter and returns `fmt::Result`.

**Call relations**: Used only through `reset_keyboard_reporting_after_exit`.

*Call graph*: 1 external calls (write_str).


##### `ResetKeyboardEnhancementFlags::execute_winapi`  (lines 223–228)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: Reports that legacy WinAPI execution is unsupported for keyboard enhancement reset.

**Data flow**: Returns an `Unsupported` `io::Error`.

**Call relations**: Windows-only branch of the custom command implementation.

*Call graph*: 1 external calls (new).


##### `ResetKeyboardEnhancementFlags::is_ansi_code_supported`  (lines 231–233)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Declares that ANSI support is not available through the legacy WinAPI path for this command.

**Data flow**: Returns `false`.

**Call relations**: Part of the Windows `Command` implementation contract.


##### `EnableModifyOtherKeys::write_ansi`  (lines 240–242)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Serializes the ANSI sequence that enables xterm `modifyOtherKeys` mode 2.

**Data flow**: Writes `\x1b[>4;2m` into the formatter and returns `fmt::Result`.

**Call relations**: Emitted by `enable_keyboard_enhancement` only when tmux compatibility checks pass.

*Call graph*: 1 external calls (write_str).


##### `EnableModifyOtherKeys::execute_winapi`  (lines 245–250)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: Reports that enabling `modifyOtherKeys` is unsupported through legacy WinAPI.

**Data flow**: Returns an `Unsupported` `io::Error`.

**Call relations**: Windows-only branch of the custom command implementation.

*Call graph*: 1 external calls (new).


##### `EnableModifyOtherKeys::is_ansi_code_supported`  (lines 253–255)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Declares no legacy WinAPI ANSI support for this command.

**Data flow**: Returns `false`.

**Call relations**: Completes the Windows command implementation.


##### `DisableModifyOtherKeys::write_ansi`  (lines 262–264)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Serializes the ANSI sequence that disables xterm `modifyOtherKeys` reporting.

**Data flow**: Writes `\x1b[>4;0m` into the formatter and returns `fmt::Result`.

**Call relations**: Used during both startup normalization and teardown.

*Call graph*: 1 external calls (write_str).


##### `DisableModifyOtherKeys::execute_winapi`  (lines 267–272)

```
fn execute_winapi(&self) -> std::io::Result<()>
```

**Purpose**: Reports that disabling `modifyOtherKeys` is unsupported through legacy WinAPI.

**Data flow**: Returns an `Unsupported` `io::Error`.

**Call relations**: Windows-only branch of the custom command implementation.

*Call graph*: 1 external calls (new).


##### `DisableModifyOtherKeys::is_ansi_code_supported`  (lines 275–277)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Declares no legacy WinAPI ANSI support for this command.

**Data flow**: Returns `false`.

**Call relations**: Completes the Windows command implementation.


##### `tests::ansi_for`  (lines 293–297)

```
fn ansi_for(command: impl Command) -> String
```

**Purpose**: Helper that renders a command’s ANSI sequence into a string for assertions.

**Data flow**: Creates an empty `String`, calls `command.write_ansi(&mut out).unwrap()`, and returns the resulting string.

**Call relations**: Used by command-sequence tests in this module.

*Call graph*: 2 external calls (new, write_ansi).


##### `tests::keyboard_enhancement_env_flag_parses_common_values`  (lines 300–309)

```
fn keyboard_enhancement_env_flag_parses_common_values()
```

**Purpose**: Tests parsing of common truthy, falsy, and invalid environment values.

**Data flow**: Calls `parse_bool_env` with several inputs and asserts the expected `Option<bool>` outputs.

**Call relations**: Documents the accepted override syntax for the disable environment variable.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::keyboard_enhancement_auto_disables_for_vscode_in_wsl`  (lines 312–316)

```
fn keyboard_enhancement_auto_disables_for_vscode_in_wsl()
```

**Purpose**: Tests the auto-disable rule for the WSL + VS Code combination.

**Data flow**: Calls `keyboard_enhancement_disabled_for(None, true, true)` and asserts true.

**Call relations**: Covers the fallback policy branch when no explicit env override is present.

*Call graph*: 1 external calls (assert!).


##### `tests::keyboard_enhancement_auto_disable_requires_wsl_and_vscode`  (lines 319–326)

```
fn keyboard_enhancement_auto_disable_requires_wsl_and_vscode()
```

**Purpose**: Tests that auto-disable does not trigger unless both WSL and VS Code conditions are true.

**Data flow**: Calls `keyboard_enhancement_disabled_for` with mixed boolean combinations and asserts false in both cases.

**Call relations**: Complements the previous test by checking the negative cases.

*Call graph*: 1 external calls (assert!).


##### `tests::keyboard_enhancement_env_flag_overrides_auto_detection`  (lines 329–340)

```
fn keyboard_enhancement_env_flag_overrides_auto_detection()
```

**Purpose**: Tests that explicit env values override the WSL/VS Code auto-disable heuristic.

**Data flow**: Asserts that `Some("0")` forces false even in WSL+VS Code, and `Some("1")` forces true even without auto-detection triggers.

**Call relations**: Validates precedence rules in `keyboard_enhancement_disabled_for`.

*Call graph*: 1 external calls (assert!).


##### `tests::vscode_terminal_detection_uses_linux_and_windows_term_program`  (lines 343–359)

```
fn vscode_terminal_detection_uses_linux_and_windows_term_program()
```

**Purpose**: Tests that VS Code detection accepts either Linux-side or Windows-side `TERM_PROGRAM` values.

**Data flow**: Calls `vscode_terminal_detected` with various combinations and asserts true only when one side equals `vscode`.

**Call relations**: Documents the dual-source detection strategy used for WSL.

*Call graph*: 1 external calls (assert!).


##### `tests::tmux_session_detection_accepts_tmux_or_tmux_pane`  (lines 362–371)

```
fn tmux_session_detection_accepts_tmux_or_tmux_pane()
```

**Purpose**: Tests that either standard tmux environment variable is sufficient to detect a tmux session.

**Data flow**: Calls `tmux_session_detected` with `TMUX`, with `TMUX_PANE`, and with neither, asserting true, true, and false respectively.

**Call relations**: Covers the tmux-session helper used by keyboard enablement.

*Call graph*: 1 external calls (assert!).


##### `tests::tmux_modify_other_keys_only_requests_confirmed_csi_u_format`  (lines 374–394)

```
fn tmux_modify_other_keys_only_requests_confirmed_csi_u_format()
```

**Purpose**: Tests that `modifyOtherKeys` is enabled only when tmux is present and explicitly reports `csi-u` formatting.

**Data flow**: Calls `tmux_should_enable_modify_other_keys_for` with several combinations of session presence and format strings, asserting true only for `(true, Some("csi-u"))`.

**Call relations**: Documents the conservative compatibility policy around tmux modified-key reporting.

*Call graph*: 1 external calls (assert!).


##### `tests::reset_keyboard_enhancement_flags_clears_all_pushed_levels`  (lines 397–399)

```
fn reset_keyboard_enhancement_flags_clears_all_pushed_levels()
```

**Purpose**: Tests the ANSI sequence emitted by `ResetKeyboardEnhancementFlags`.

**Data flow**: Renders the command with `ansi_for` and asserts the string equals `\x1b[<u`.

**Call relations**: Verifies the custom reset command used on exit.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::enable_modify_other_keys_requests_xterm_keyboard_reporting`  (lines 402–404)

```
fn enable_modify_other_keys_requests_xterm_keyboard_reporting()
```

**Purpose**: Tests the ANSI sequence emitted to enable `modifyOtherKeys` mode 2.

**Data flow**: Renders `EnableModifyOtherKeys` with `ansi_for` and asserts the string equals `\x1b[>4;2m`.

**Call relations**: Verifies the custom command used when tmux compatibility allows it.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::disable_modify_other_keys_resets_xterm_keyboard_reporting`  (lines 407–409)

```
fn disable_modify_other_keys_resets_xterm_keyboard_reporting()
```

**Purpose**: Tests the ANSI sequence emitted to disable `modifyOtherKeys`.

**Data flow**: Renders `DisableModifyOtherKeys` with `ansi_for` and asserts the string equals `\x1b[>4;0m`.

**Call relations**: Verifies the custom command used during startup normalization and teardown.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/tui/terminal_stderr.rs`

`io_transport` · `startup, external handoff, and teardown`

This file implements stderr suppression as a terminal-ownership guard. The public-facing type is `TerminalStderrGuard`, which records whether suppression is active for the current TUI session. On macOS, a global `STDERR_STATE: Mutex<StderrState>` tracks whether a TUI owner is active and stores a duplicated copy of the original stderr file descriptor in `saved_stderr`. Suppression is only installed when `stderr_targets_stdout_terminal()` determines that stdout and stderr are both terminals and refer to the same underlying device/inode; if stderr is already redirected elsewhere, the guard remains inactive and leaves it alone.

When suppression is active, `suppress_locked` duplicates `STDERR_FILENO`, opens `/dev/null`, and `dup2`s that file onto stderr, preserving the original descriptor in `saved_stderr`. `restore_locked` reverses the redirection by `dup2`ing the saved descriptor back onto `STDERR_FILENO` and clearing the saved handle. `pause` and `resume` temporarily restore or re-suppress stderr while the TUI gives terminal ownership to an external program or suspend path, but only if `owner_active` is still true. `finish` performs the permanent restoration at session end and clears the owner flag. `TerminalStderrGuard::drop` calls `finish` automatically when needed.

On non-macOS targets these functions compile to inert success paths, so the rest of the TUI can call them unconditionally without platform branching.

#### Function details

##### `TerminalStderrGuard::install`  (lines 45–54)

```
fn install() -> io::Result<Self>
```

**Purpose**: Installs stderr suppression if the current platform and terminal topology require it, otherwise returns an inactive guard.

**Data flow**: On macOS, checks `stderr_targets_stdout_terminal()` and if true delegates to `install_suppression`; otherwise returns `Ok(TerminalStderrGuard { active: false })`. On other platforms it always returns an inactive guard.

**Call relations**: Called during `init` and by tests. It is the normal entrypoint for stderr protection during TUI startup.

*Call graph*: calls 1 internal fn (stderr_targets_stdout_terminal); called by 2 (init, preserves_stderr_when_already_redirected); 1 external calls (install_suppression).


##### `TerminalStderrGuard::install_suppression`  (lines 57–68)

```
fn install_suppression() -> io::Result<Self>
```

**Purpose**: Activates stderr suppression on macOS, failing if another owner is already active.

**Data flow**: Locks global stderr state, returns `AlreadyExists` if `owner_active` is already true, otherwise calls `suppress_locked`, sets `owner_active = true`, and returns `TerminalStderrGuard { active: true }`.

**Call relations**: Used internally by `install` and directly by macOS-specific tests.

*Call graph*: calls 2 internal fn (lock_state, suppress_locked); called by 1 (suppresses_stderr_only_while_terminal_is_owned); 1 external calls (new).


##### `TerminalStderrGuard::drop`  (lines 72–77)

```
fn drop(&mut self)
```

**Purpose**: Automatically restores stderr when an active guard is dropped.

**Data flow**: If `self.active` is true, calls `finish()` best-effort and then sets `self.active = false`.

**Call relations**: Runs at guard teardown, ensuring suppression does not outlive the owning TUI session.

*Call graph*: calls 1 internal fn (finish).


##### `pause`  (lines 81–91)

```
fn pause() -> io::Result<()>
```

**Purpose**: Temporarily restores stderr while the TUI has released terminal ownership.

**Data flow**: On macOS, locks global state and if `owner_active` is true calls `restore_locked`; otherwise does nothing. Returns `io::Result<()>`.

**Call relations**: Called by `Tui::with_restored`, by Unix suspend handling, and by tests to make unmanaged stderr visible during external terminal use.

*Call graph*: calls 2 internal fn (lock_state, restore_locked); called by 3 (with_restored, suspend_process, suppresses_stderr_only_while_terminal_is_owned).


##### `resume`  (lines 94–104)

```
fn resume() -> io::Result<()>
```

**Purpose**: Reapplies stderr suppression after the TUI regains terminal ownership.

**Data flow**: On macOS, locks global state and if `owner_active` is true calls `suppress_locked`; otherwise does nothing. Returns `io::Result<()>`.

**Call relations**: Called after external handoff or suspend resume so unmanaged stderr stops painting into the inline viewport again.

*Call graph*: calls 2 internal fn (lock_state, suppress_locked); called by 3 (with_restored, suspend_process, suppresses_stderr_only_while_terminal_is_owned).


##### `finish`  (lines 107–118)

```
fn finish() -> io::Result<()>
```

**Purpose**: Permanently restores stderr and marks the suppression owner inactive.

**Data flow**: On macOS, locks global state and if `owner_active` is true calls `restore_locked` and then sets `owner_active = false`; otherwise does nothing. Returns `io::Result<()>`.

**Call relations**: Called by `restore_after_exit`, by `TerminalStderrGuard::drop`, and by tests as the final cleanup step.

*Call graph*: calls 2 internal fn (lock_state, restore_locked); called by 3 (restore_after_exit, drop, suppresses_stderr_only_while_terminal_is_owned).


##### `lock_state`  (lines 121–125)

```
fn lock_state() -> io::Result<MutexGuard<'static, StderrState>>
```

**Purpose**: Acquires the global stderr suppression mutex and converts poisoning into an `io::Error`.

**Data flow**: Locks `STDERR_STATE`; on success returns `MutexGuard<'static, StderrState>`, on poison returns `io::Error::other("terminal stderr suppression lock poisoned")`.

**Call relations**: Used by all macOS state-mutating helpers to centralize poison handling.

*Call graph*: called by 4 (install_suppression, finish, pause, resume).


##### `stderr_targets_stdout_terminal`  (lines 128–146)

```
fn stderr_targets_stdout_terminal() -> bool
```

**Purpose**: Determines whether stderr and stdout both point at the same terminal device, which is the condition under which suppression is needed.

**Data flow**: Checks `stdout().is_terminal()` and `stderr().is_terminal()`, then `fstat`s both file descriptors into `libc::stat` buffers, compares `st_dev` and `st_ino`, and returns true only when both descriptors refer to the same terminal endpoint.

**Call relations**: Called by `TerminalStderrGuard::install` to avoid suppressing stderr when it is already redirected elsewhere.

*Call graph*: called by 1 (install); 4 external calls (uninit, stderr, stdout, fstat).


##### `suppress_locked`  (lines 149–168)

```
fn suppress_locked(state: &mut StderrState) -> io::Result<()>
```

**Purpose**: Redirects stderr to `/dev/null` while preserving the original stderr descriptor for later restoration.

**Data flow**: If `state.saved_stderr` is already set, returns success immediately. Otherwise duplicates `STDERR_FILENO` with `dup`, wraps it as `OwnedFd`, opens `/dev/null` for writing, `dup2`s that fd onto `STDERR_FILENO`, stores the saved original fd in `state.saved_stderr`, and returns `io::Result<()>`.

**Call relations**: Called by `install_suppression` and `resume` while holding the global state lock.

*Call graph*: called by 2 (install_suppression, resume); 5 external calls (new, from_raw_fd, last_os_error, dup, dup2).


##### `restore_locked`  (lines 171–182)

```
fn restore_locked(state: &mut StderrState) -> io::Result<()>
```

**Purpose**: Restores stderr from the saved original descriptor if suppression is currently active.

**Data flow**: If `state.saved_stderr` is `None`, returns success. Otherwise `dup2`s the saved fd back onto `STDERR_FILENO`, clears `state.saved_stderr`, and returns `io::Result<()>`.

**Call relations**: Called by `pause` and `finish` while holding the global state lock.

*Call graph*: called by 2 (finish, pause); 2 external calls (last_os_error, dup2).


##### `tests::CapturedStderr::start`  (lines 207–220)

```
fn start(file: &File) -> std::io::Result<Self>
```

**Purpose**: Test helper that redirects stderr into a temporary file while preserving the original descriptor for restoration on drop.

**Data flow**: Duplicates `STDERR_FILENO`, wraps it as `OwnedFd`, `dup2`s the provided file’s fd onto stderr, and returns `CapturedStderr { saved_stderr }` or an OS error.

**Call relations**: Used by macOS tests to capture visible stderr output while exercising suppression logic.

*Call graph*: 5 external calls (as_raw_fd, from_raw_fd, last_os_error, dup, dup2).


##### `tests::CapturedStderr::drop`  (lines 224–227)

```
fn drop(&mut self)
```

**Purpose**: Restores the original stderr descriptor after a test capture ends.

**Data flow**: Best-effort `dup2`s `self.saved_stderr` back onto `STDERR_FILENO` and returns `()`. Errors are ignored in drop.

**Call relations**: Automatic cleanup for the `CapturedStderr` test helper.

*Call graph*: 2 external calls (as_raw_fd, dup2).


##### `tests::write_stderr`  (lines 230–234)

```
fn write_stderr(message: &str) -> std::io::Result<()>
```

**Purpose**: Writes and flushes a string to stderr for test assertions.

**Data flow**: Locks `std::io::stderr()`, writes the message bytes, flushes, and returns `std::io::Result<()>`.

**Call relations**: Used by the macOS tests to observe whether stderr is currently visible or suppressed.

*Call graph*: 1 external calls (stderr).


##### `tests::suppresses_stderr_only_while_terminal_is_owned`  (lines 238–257)

```
fn suppresses_stderr_only_while_terminal_is_owned() -> std::io::Result<()>
```

**Purpose**: Tests the full suppression lifecycle: hidden while active, visible while paused, hidden again after resume, and visible after finish.

**Data flow**: Creates a tempfile and redirects stderr into it with `CapturedStderr`, installs suppression, writes messages across active/pause/resume/finish phases, drops the capture, rewinds and reads the file, and asserts only the paused and finished messages were captured.

**Call relations**: Exercises `install_suppression`, `pause`, `resume`, and `finish` together to validate ownership-sensitive behavior.

*Call graph*: calls 4 internal fn (install_suppression, finish, pause, resume); 5 external calls (new, assert_eq!, tempfile, start, write_stderr).


##### `tests::preserves_stderr_when_already_redirected`  (lines 261–274)

```
fn preserves_stderr_when_already_redirected() -> std::io::Result<()>
```

**Purpose**: Tests that `install` leaves stderr untouched when it is already redirected away from the terminal.

**Data flow**: Redirects stderr into a tempfile, calls `TerminalStderrGuard::install()`, writes a message, drops the capture, reads the file, and asserts the message remained visible.

**Call relations**: Validates the `stderr_targets_stdout_terminal` gate used by the normal installation path.

*Call graph*: calls 1 internal fn (install); 5 external calls (new, assert_eq!, tempfile, start, write_stderr).


### `tui/src/tui/job_control.rs`

`orchestration` · `request handling`

This file encapsulates the TUI’s Unix suspend/resume behavior around Ctrl-Z. `SuspendContext` is cloneable and internally uses `Arc<Mutex<Option<ResumeAction>>>` plus `Arc<AtomicU16>` so it can be shared with the boxed event stream without borrowing the parent `Tui`. The context tracks two pieces of state: a pending resume intent (`RealignInline` or `RestoreAlt`) and the inline cursor row that should be used when yielding control to the shell.

When `suspend` is called, it checks whether alternate screen is active. If so, it emits `DisableAlternateScroll` and `LeaveAlternateScreen`, records `ResumeAction::RestoreAlt`, and otherwise records `RealignInline`. It then moves the cursor to column 0 of the cached row, shows it, calls `suspend_process()` to restore terminal modes and deliver `SIGTSTP`, reapplies raw mode after resume, probes the terminal for the current cursor position, flushes buffered input, and logs the restored cursor row. `prepare_resume_action` later drains the pending resume intent and converts it into a `PreparedResumeAction`: either a zero-sized `Rect` anchored at the resumed cursor row for inline viewport realignment, or `RestoreAltScreen`, optionally updating the saved inline viewport’s `y` coordinate first.

`PreparedResumeAction::apply` is designed to run inside the synchronized draw path. It either sets the viewport directly for inline realignment or re-enters alternate screen, re-enables alternate scroll, expands the viewport to terminal size, and clears the screen. The low-level `suspend_process` helper performs the actual restore/pause/kill/resume/set-modes sequence around `SIGTSTP`.

#### Function details

##### `SuspendContext::new`  (lines 50–55)

```
fn new() -> Self
```

**Purpose**: Creates a fresh suspend context with no pending resume action and a cursor row of zero.

**Data flow**: Allocates `resume_pending` as `Arc<Mutex<Option<ResumeAction>>>` initialized to `None`, allocates `suspend_cursor_y` as `Arc<AtomicU16>` initialized to `0`, and returns `Self`.

**Call relations**: Constructed by `Tui::new` and by event-stream tests on Unix.

*Call graph*: called by 2 (new, make_stream); 3 external calls (new, new, new).


##### `SuspendContext::suspend`  (lines 63–98)

```
fn suspend(&self, alt_screen_active: &Arc<AtomicBool>) -> Result<()>
```

**Purpose**: Performs the suspend sequence: records how to resume, restores terminal state for the shell, yields via `SIGTSTP`, and refreshes cursor state after resume.

**Data flow**: Reads `alt_screen_active`; if true, emits `DisableAlternateScroll` and `LeaveAlternateScreen` and stores `ResumeAction::RestoreAlt`, else stores `RealignInline`. It loads the cached cursor row, emits `MoveTo(0, y)` and `Show`, calls `suspend_process()`, then `reapply_raw_mode_after_resume()`. After resume it probes terminal cursor position and updates `suspend_cursor_y` if available, flushes terminal input, logs trace/debug information, and returns `Result<()>`.

**Call relations**: Called from `TuiEventStream::map_crossterm_event` when the suspend key is pressed. It delegates signal delivery and terminal mode handoff to `suspend_process`.

*Call graph*: calls 4 internal fn (cursor_position, set_cursor_y, set_resume_action, suspend_process); called by 1 (map_crossterm_event); 5 external calls (execute!, flush_terminal_input_buffer, reapply_raw_mode_after_resume, debug!, trace!).


##### `SuspendContext::prepare_resume_action`  (lines 104–126)

```
fn prepare_resume_action(
        &self,
        alt_saved_viewport: &mut Option<Rect>,
    ) -> Option<PreparedResumeAction>
```

**Purpose**: Consumes any pending resume intent and converts it into a concrete action to apply during the next synchronized draw.

**Data flow**: Calls `take_resume_action()`; if none, returns `None`. For `RealignInline`, it builds a zero-sized `Rect` at `(0, cursor_y())` and returns `Some(PreparedResumeAction::RealignViewport(rect))`. For `RestoreAlt`, it updates `alt_saved_viewport.y` to the current cursor row if present and returns `Some(PreparedResumeAction::RestoreAltScreen)`.

**Call relations**: Called by both `Tui::draw` and `Tui::draw_with_resize_reflow` before rendering so resume effects happen inside synchronized terminal updates.

*Call graph*: calls 2 internal fn (cursor_y, take_resume_action); called by 2 (draw, draw_with_resize_reflow); 2 external calls (new, RealignViewport).


##### `SuspendContext::set_cursor_y`  (lines 132–134)

```
fn set_cursor_y(&self, value: u16)
```

**Purpose**: Updates the cached inline cursor row used during suspend and resume bookkeeping.

**Data flow**: Stores the provided `value: u16` into `suspend_cursor_y` with relaxed ordering and returns `()`. No locking is required.

**Call relations**: Called during normal drawing and after successful post-resume cursor probing.

*Call graph*: called by 1 (suspend).


##### `SuspendContext::cursor_y`  (lines 136–138)

```
fn cursor_y(&self) -> u16
```

**Purpose**: Reads the cached cursor row.

**Data flow**: Loads and returns the `u16` from `suspend_cursor_y` with relaxed ordering.

**Call relations**: Used internally by `prepare_resume_action` and for logging after resume.

*Call graph*: called by 1 (prepare_resume_action).


##### `SuspendContext::set_resume_action`  (lines 141–146)

```
fn set_resume_action(&self, value: ResumeAction)
```

**Purpose**: Stores the resume action that should be applied after the process returns from suspend.

**Data flow**: Locks `resume_pending`, replacing its contents with `Some(value)`, and returns `()`. Poisoned locks are recovered with `PoisonError::into_inner`.

**Call relations**: Called only by `suspend` after deciding whether resume should restore alt screen or realign inline viewport.

*Call graph*: called by 1 (suspend).


##### `SuspendContext::take_resume_action`  (lines 149–154)

```
fn take_resume_action(&self) -> Option<ResumeAction>
```

**Purpose**: Drains and returns the pending resume action, if any.

**Data flow**: Locks `resume_pending`, calls `.take()` on the inner `Option<ResumeAction>`, and returns the drained value.

**Call relations**: Used only by `prepare_resume_action` so each suspend episode produces at most one applied resume action.

*Call graph*: called by 1 (prepare_resume_action).


##### `PreparedResumeAction::apply`  (lines 181–197)

```
fn apply(self, terminal: &mut Terminal) -> Result<()>
```

**Purpose**: Applies the precomputed resume effect to the terminal inside a synchronized draw.

**Data flow**: Matches on `self`: `RealignViewport(area)` sets `terminal.viewport_area` to `area`; `RestoreAltScreen` emits `EnterAlternateScreen` and `EnableAlternateScroll`, queries terminal size, sets viewport to the full-screen rect, and clears the terminal. Returns `Result<()>`.

**Call relations**: Called by both draw paths after `prepare_resume_action` returns a pending action.

*Call graph*: calls 3 internal fn (clear, set_viewport_area, size); 2 external calls (new, execute!).


##### `suspend_process`  (lines 201–211)

```
fn suspend_process() -> Result<()>
```

**Purpose**: Performs the low-level suspend handoff: restore terminal state, pause stderr suppression, send `SIGTSTP`, then re-enable TUI modes after resume.

**Data flow**: Calls `super::restore()`, `super::terminal_stderr::pause()`, sends `SIGTSTP` to process group 0 via `libc::kill`, then after resume calls `terminal_stderr::resume()` and `set_modes()`, returning `Result<()>`.

**Call relations**: Used only by `SuspendContext::suspend` as the OS-facing suspend primitive.

*Call graph*: calls 2 internal fn (pause, resume); called by 1 (suspend); 3 external calls (kill, restore, set_modes).


### `tui/src/notifications/mod.rs`

`orchestration` · `notification backend setup and notification dispatch`

This module is the notification backend facade. It declares the `bel` and `osc9` submodules, defines the `DesktopNotificationBackend` enum, and exposes the selection logic used by the rest of the application. `for_method` interprets `NotificationMethod`: explicit `Osc9` and `Bel` requests instantiate the corresponding backend directly, while `Auto` probes the current terminal via `terminal_info()` and `supports_osc9(...)`. Supported terminals are a fixed allowlist of `Ghostty`, `Iterm2`, `Kitty`, `WarpTerminal`, and `WezTerm`; everything else falls back to BEL.

Once constructed, the enum provides `method()` to report the effective backend and `notify()` to forward a message to the selected transport. The free function `detect_backend` is just a thin wrapper around `for_method`, giving callers a simple entry point for configuration-driven setup. The tests cover explicit selection and the terminal allowlist, ensuring auto-detection remains conservative and predictable.

#### Function details

##### `DesktopNotificationBackend::for_method`  (lines 20–32)

```
fn for_method(method: NotificationMethod) -> Self
```

**Purpose**: Constructs the concrete notification backend requested by configuration, including auto-detection for `NotificationMethod::Auto`.

**Data flow**: It takes a `NotificationMethod`. For `Auto`, it calls `terminal_info()` and passes the result to `supports_osc9`; if true it returns `DesktopNotificationBackend::Osc9(Osc9Backend::new())`, otherwise `DesktopNotificationBackend::Bel(BelBackend)`. Explicit `Osc9` and `Bel` methods bypass detection and instantiate the requested variant directly.

**Call relations**: This is the main backend-selection routine, called by `detect_backend` and used during notification settings setup.

*Call graph*: calls 2 internal fn (new, supports_osc9); called by 1 (detect_backend); 3 external calls (Bel, Osc9, terminal_info).


##### `DesktopNotificationBackend::method`  (lines 34–39)

```
fn method(&self) -> NotificationMethod
```

**Purpose**: Reports which notification method the enum currently wraps.

**Data flow**: It matches on `self` and returns `NotificationMethod::Osc9` for the `Osc9` variant or `NotificationMethod::Bel` for the `Bel` variant.

**Call relations**: This accessor lets callers inspect the effective backend after auto-detection or explicit construction.


##### `DesktopNotificationBackend::notify`  (lines 41–46)

```
fn notify(&mut self, message: &str) -> io::Result<()>
```

**Purpose**: Dispatches a notification message to the selected backend implementation.

**Data flow**: It takes `&mut self` and `message: &str`, matches on the enum variant, and forwards the message to either `Osc9Backend::notify` or `BelBackend::notify`. It returns the backend's `io::Result<()>`.

**Call relations**: This is the runtime send path used after backend selection; it hides the transport-specific details from callers.


##### `detect_backend`  (lines 49–51)

```
fn detect_backend(method: NotificationMethod) -> DesktopNotificationBackend
```

**Purpose**: Convenience wrapper that selects a desktop notification backend from a configured method.

**Data flow**: It takes a `NotificationMethod`, calls `DesktopNotificationBackend::for_method(method)`, and returns the resulting enum.

**Call relations**: This free function is the module-level entry point used by higher-level setup code instead of calling the enum constructor directly.

*Call graph*: calls 1 internal fn (for_method); called by 2 (new, set_notification_settings).


##### `supports_osc9`  (lines 53–62)

```
fn supports_osc9(terminal: &TerminalInfo) -> bool
```

**Purpose**: Determines whether the current terminal should be treated as supporting OSC 9 desktop notifications.

**Data flow**: It takes a borrowed `TerminalInfo` and returns true only when `terminal.name` matches one of the allowlisted terminal variants: `Ghostty`, `Iterm2`, `Kitty`, `WarpTerminal`, or `WezTerm`.

**Call relations**: This predicate is used by `DesktopNotificationBackend::for_method` during auto-detection and is covered directly by tests.

*Call graph*: called by 1 (for_method); 1 external calls (matches!).


##### `tests::test_terminal`  (lines 73–81)

```
fn test_terminal(name: TerminalName) -> TerminalInfo
```

**Purpose**: Builds a minimal `TerminalInfo` fixture with a chosen terminal name and no extra metadata.

**Data flow**: It takes a `TerminalName` and returns `TerminalInfo { name, term_program: None, version: None, term: None, multiplexer: None }`.

**Call relations**: This helper is used by the OSC 9 support tests to avoid depending on real environment detection.


##### `tests::selects_osc9_method`  (lines 84–89)

```
fn selects_osc9_method()
```

**Purpose**: Verifies that explicitly requesting the OSC 9 method yields the OSC 9 backend variant.

**Data flow**: The test calls `detect_backend(NotificationMethod::Osc9)` and asserts that the result matches `DesktopNotificationBackend::Osc9(_)`.

**Call relations**: It covers the explicit-selection branch of `DesktopNotificationBackend::for_method` through the public wrapper.

*Call graph*: 1 external calls (assert!).


##### `tests::selects_bel_method`  (lines 92–97)

```
fn selects_bel_method()
```

**Purpose**: Verifies that explicitly requesting the BEL method yields the BEL backend variant.

**Data flow**: The test calls `detect_backend(NotificationMethod::Bel)` and asserts that the result matches `DesktopNotificationBackend::Bel(_)`.

**Call relations**: It covers the explicit BEL branch of backend selection.

*Call graph*: 1 external calls (assert!).


##### `tests::supports_osc9_for_supported_terminals`  (lines 100–113)

```
fn supports_osc9_for_supported_terminals()
```

**Purpose**: Checks that every allowlisted terminal name is recognized as OSC 9 capable.

**Data flow**: The test iterates a fixed array of supported `TerminalName` values, wraps each with `test_terminal`, calls `supports_osc9`, and asserts true with a descriptive message.

**Call relations**: It directly validates the positive cases in the terminal allowlist used by auto-detection.

*Call graph*: 1 external calls (assert!).


##### `tests::supports_osc9_for_unsupported_terminals`  (lines 116–134)

```
fn supports_osc9_for_unsupported_terminals()
```

**Purpose**: Checks that non-allowlisted terminal names are rejected for OSC 9 support.

**Data flow**: The test iterates several unsupported `TerminalName` values, wraps each with `test_terminal`, calls `supports_osc9`, and asserts the result is false.

**Call relations**: It validates the conservative fallback behavior of auto-detection.

*Call graph*: 1 external calls (assert_eq!).


### `tui/src/notifications/osc9.rs`

`io_transport` · `desktop notification emission`

This file contains the richer desktop-notification transport. `Osc9Backend` stores one piece of runtime state, `dcs_passthrough`, which is computed at construction time by inspecting `terminal_info().multiplexer` and enabling passthrough when running inside tmux. `Default` simply delegates to `new`, so callers can construct the backend either way.

`notify` wraps the message and passthrough flag into a `PostNotification` command and executes it on stdout. The command's `write_ansi` implementation emits either a plain OSC 9 sequence (`ESC ] 9 ; message BEL`) or a tmux DCS-wrapped version (`ESC Ptmux; ... ESC \`). When passthrough is enabled, the payload is first processed by `escape_tmux_dcs_passthrough_payload`, which doubles embedded escape bytes so tmux does not misparse the nested control sequence. As with the BEL backend, Windows-specific trait hooks reject WinAPI execution and advertise ANSI support instead.

The tests assert exact serialized output for plain OSC 9, tmux-wrapped OSC 9, and escape-byte doubling inside tmux payloads, making the wire format explicit and regression-resistant.

#### Function details

##### `Osc9Backend::default`  (lines 16–18)

```
fn default() -> Self
```

**Purpose**: Provides the default constructor by delegating to `Osc9Backend::new`.

**Data flow**: It takes no inputs, calls `Self::new()`, and returns the resulting backend.

**Call relations**: This trait implementation exists so callers can use `Default` while still sharing the same initialization logic as `new`.

*Call graph*: 1 external calls (new).


##### `Osc9Backend::new`  (lines 22–26)

```
fn new() -> Self
```

**Purpose**: Constructs an OSC 9 backend and decides whether tmux DCS passthrough is required.

**Data flow**: It reads `terminal_info().multiplexer`, sets `dcs_passthrough` to true when it matches `Some(Multiplexer::Tmux { .. })`, and returns `Osc9Backend { dcs_passthrough }`.

**Call relations**: This constructor is called by notification backend selection code and by `Default::default`.

*Call graph*: called by 1 (for_method); 1 external calls (matches!).


##### `Osc9Backend::notify`  (lines 28–36)

```
fn notify(&mut self, message: &str) -> io::Result<()>
```

**Purpose**: Emits an OSC 9 notification carrying the provided message.

**Data flow**: It takes `&mut self` and `message: &str`, clones the message into a `String`, packages it with `self.dcs_passthrough` into `PostNotification`, and executes that command on stdout via `execute!`. It returns `io::Result<()>`.

**Call relations**: This method is invoked by `DesktopNotificationBackend::notify` when the OSC 9 backend variant is active.

*Call graph*: 1 external calls (execute!).


##### `PostNotification::write_ansi`  (lines 47–54)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Serializes the notification command into either a plain OSC 9 sequence or a tmux DCS-wrapped OSC 9 sequence.

**Data flow**: It reads `self.message` and `self.dcs_passthrough`. If passthrough is true, it first calls `escape_tmux_dcs_passthrough_payload(&self.message)` and writes the wrapped sequence `\x1bPtmux;\x1b\x1b]9;...\x07\x1b\\`; otherwise it writes `\x1b]9;{message}\x07`. It returns `fmt::Result`.

**Call relations**: This is the core wire-format implementation used when `Osc9Backend::notify` executes the command. It delegates only the tmux payload escaping to `escape_tmux_dcs_passthrough_payload`.

*Call graph*: calls 1 internal fn (escape_tmux_dcs_passthrough_payload); 1 external calls (write!).


##### `PostNotification::execute_winapi`  (lines 57–61)

```
fn execute_winapi(&self) -> io::Result<()>
```

**Purpose**: Rejects WinAPI execution for OSC 9 notifications with an explicit error.

**Data flow**: On Windows builds it returns `Err(std::io::Error::other(...))` indicating ANSI should be used instead.

**Call relations**: This trait hook prevents unsupported execution paths for the OSC 9 command.

*Call graph*: 1 external calls (other).


##### `PostNotification::is_ansi_code_supported`  (lines 64–66)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Declares that ANSI execution is supported for OSC 9 notifications on Windows.

**Data flow**: On Windows builds it returns `true` unconditionally.

**Call relations**: This complements `execute_winapi` so crossterm can choose ANSI output for the command.


##### `escape_tmux_dcs_passthrough_payload`  (lines 69–71)

```
fn escape_tmux_dcs_passthrough_payload(message: &str) -> String
```

**Purpose**: Escapes embedded escape bytes inside a tmux passthrough payload by doubling them.

**Data flow**: It takes `message: &str`, replaces every `\u{1b}` with `\u{1b}\u{1b}`, and returns the escaped `String`.

**Call relations**: This helper is used only by `PostNotification::write_ansi` when tmux passthrough is enabled.

*Call graph*: called by 1 (write_ansi).


##### `tests::post_notification_writes_plain_osc9_sequence`  (lines 81–93)

```
fn post_notification_writes_plain_osc9_sequence()
```

**Purpose**: Verifies the exact ANSI bytes produced for a normal non-tmux OSC 9 notification.

**Data flow**: The test creates a `PostNotification` with `dcs_passthrough = false`, writes it into a `String` via `write_ansi`, and asserts the resulting sequence equals `ESC ] 9 ; hello BEL`.

**Call relations**: It covers the plain branch of `PostNotification::write_ansi`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::post_notification_writes_tmux_dcs_wrapped_osc9_sequence`  (lines 96–108)

```
fn post_notification_writes_tmux_dcs_wrapped_osc9_sequence()
```

**Purpose**: Verifies the exact ANSI bytes produced for a tmux-wrapped OSC 9 notification.

**Data flow**: The test creates a `PostNotification` with `dcs_passthrough = true`, serializes it with `write_ansi`, and asserts the resulting string matches the expected DCS passthrough wrapper.

**Call relations**: It covers the tmux branch of `PostNotification::write_ansi`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::post_notification_escapes_escape_bytes_inside_tmux_payload`  (lines 111–126)

```
fn post_notification_escapes_escape_bytes_inside_tmux_payload()
```

**Purpose**: Checks that embedded escape bytes in tmux passthrough messages are doubled before serialization.

**Data flow**: The test constructs a tmux `PostNotification` whose message contains an ANSI escape sequence, serializes it with `write_ansi`, and asserts the output contains doubled escape bytes inside the OSC 9 payload.

**Call relations**: It specifically validates `escape_tmux_dcs_passthrough_payload` as used by the tmux serialization path.

*Call graph*: 2 external calls (new, assert_eq!).


### `tui/src/notifications/bel.rs`

`io_transport` · `desktop notification emission`

This file contains the BEL-based notification transport. `BelBackend` is a zero-state backend with a single `notify` method that ignores the message body and simply executes a `PostNotification` command against stdout. The command implementation writes the ASCII BEL byte (`\x07`) in ANSI mode, which many terminals interpret as an audible bell or desktop notification trigger.

On Windows, the `Command` implementation explicitly rejects WinAPI execution with an error and reports that ANSI is supported, forcing the caller down the ANSI path instead of attempting a platform-specific execution mode that this command does not implement. The design is intentionally minimal: there is no escaping, payload formatting, or terminal detection because BEL carries no message text. This backend therefore serves as the lowest-common-denominator fallback when richer notification protocols are unavailable.

#### Function details

##### `BelBackend::notify`  (lines 12–14)

```
fn notify(&mut self, _message: &str) -> io::Result<()>
```

**Purpose**: Emits a BEL notification to stdout, ignoring the provided message text.

**Data flow**: It takes `&mut self` and `_message: &str`, then calls `execute!(stdout(), PostNotification)`. It returns the resulting `io::Result<()>` from crossterm execution and does not maintain internal state.

**Call relations**: This method is invoked by the higher-level `DesktopNotificationBackend::notify` dispatcher when the BEL backend has been selected.

*Call graph*: 1 external calls (execute!).


##### `PostNotification::write_ansi`  (lines 22–24)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Formats the BEL command as a single ANSI control byte.

**Data flow**: It takes a mutable formatter implementing `fmt::Write`, writes `"\x07"` into it with `write!`, and returns `fmt::Result`.

**Call relations**: This is the core serialization hook used by crossterm when `BelBackend::notify` executes the command.

*Call graph*: 1 external calls (write!).


##### `PostNotification::execute_winapi`  (lines 27–31)

```
fn execute_winapi(&self) -> io::Result<()>
```

**Purpose**: Rejects WinAPI execution for the BEL command with an explicit error message.

**Data flow**: On Windows builds it returns `Err(std::io::Error::other(...))` explaining that ANSI should be used instead. No state is read or written.

**Call relations**: This method is part of the `Command` trait implementation and protects the backend from unsupported execution paths.

*Call graph*: 1 external calls (other).


##### `PostNotification::is_ansi_code_supported`  (lines 34–36)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Declares that the BEL command supports ANSI execution on Windows.

**Data flow**: On Windows builds it returns `true` unconditionally.

**Call relations**: This trait hook complements `execute_winapi` by steering crossterm toward ANSI output for this command.


### `tui/src/terminal_title.rs`

`io_transport` · `startup and title updates`

This module owns terminal-title output as a small, security-conscious utility. Its public API consists of `set_terminal_title`, which sanitizes untrusted display text and emits OSC 0 to stdout, and `clear_terminal_title`, which writes an empty title payload. Both functions first check `stdout().is_terminal()` and become no-ops for non-terminal stdout, avoiding escape-sequence writes into redirected output.

The key logic is `sanitize_terminal_title`. It normalizes arbitrary input into a single bounded display line by collapsing any whitespace run to one ASCII space, stripping leading whitespace without a separate trim pass, dropping all control characters, and removing a curated set of invisible or bidi formatting codepoints associated with Trojan-Source-style visual deception or non-rendering text. Output is capped at `MAX_TERMINAL_TITLE_CHARS` visible `char`s, with a subtle design choice around truncation: a pending collapsed space is only emitted if there is room for both that space and at least one following visible character, so truncation prefers a final visible character over ending with a dangling space.

Actual OSC emission is implemented by the private `SetWindowTitle` command type. Its `write_ansi` method formats `ESC ] 0 ; <title> BEL`, intentionally using BEL rather than ST because some terminal integrations visibly expose ST terminators in decorations. On Windows, the command explicitly rejects WinAPI execution and declares ANSI support so crossterm uses the escape-sequence path. Tests cover whitespace normalization, invisible-character stripping, truncation behavior, and exact OSC framing.

#### Function details

##### `set_terminal_title`  (lines 56–68)

```
fn set_terminal_title(title: &str) -> io::Result<SetTerminalTitleResult>
```

**Purpose**: Sanitizes a requested title and writes it to the terminal as an OSC 0 sequence when stdout is a terminal. If sanitization removes all visible content, it reports that fact instead of clearing the title.

**Data flow**: It takes `title: &str`, returns `Applied` immediately when `stdout().is_terminal()` is false, otherwise computes `sanitize_terminal_title(title)`, returns `NoVisibleContent` if the sanitized string is empty, or executes `SetWindowTitle(title)` on stdout via `execute!` and returns `Applied` on success.

**Call relations**: Higher-level title-management code calls this when it has decided a title update should occur. It delegates normalization to `sanitize_terminal_title` and low-level OSC formatting to `SetWindowTitle`.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 2 external calls (execute!, stdout).


##### `clear_terminal_title`  (lines 74–80)

```
fn clear_terminal_title() -> io::Result<()>
```

**Purpose**: Clears the visible terminal title by emitting an empty OSC 0 payload when stdout is a terminal. It does not attempt to restore any previous shell or application title.

**Data flow**: It checks `stdout().is_terminal()`, returns `Ok(())` immediately for non-terminals, otherwise executes `SetWindowTitle(String::new())` on stdout and returns the resulting `io::Result<()>`.

**Call relations**: Callers use this when policy says Codex should explicitly clear the title it manages. It bypasses sanitization because the payload is intentionally empty.

*Call graph*: 2 external calls (execute!, stdout).


##### `SetWindowTitle::write_ansi`  (lines 86–91)

```
fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result
```

**Purpose**: Formats the ANSI OSC 0 sequence for a terminal title update using BEL termination. It is the low-level serialization hook used by crossterm command execution.

**Data flow**: It takes `&self` and a mutable formatter, writes `"\x1b]0;{}\x07"` with the stored title string, and returns `fmt::Result`.

**Call relations**: This method is invoked by crossterm's command machinery when `set_terminal_title` or `clear_terminal_title` executes the command.

*Call graph*: 1 external calls (write!).


##### `SetWindowTitle::execute_winapi`  (lines 94–98)

```
fn execute_winapi(&self) -> io::Result<()>
```

**Purpose**: Rejects WinAPI execution for the title command on Windows, forcing callers to use the ANSI escape-sequence path instead. This keeps behavior consistent with the module's OSC-based design.

**Data flow**: It returns `Err(std::io::Error::other("tried to execute SetWindowTitle using WinAPI; use ANSI instead"))`.

**Call relations**: Crossterm may consult this on Windows command execution paths; the method exists to make the intended transport explicit.

*Call graph*: 1 external calls (other).


##### `SetWindowTitle::is_ansi_code_supported`  (lines 101–103)

```
fn is_ansi_code_supported(&self) -> bool
```

**Purpose**: Declares that the title command supports ANSI execution on Windows. This steers crossterm toward the OSC path.

**Data flow**: It returns `true` with no side effects.

**Call relations**: This method complements `execute_winapi` in the Windows-specific command implementation.


##### `sanitize_terminal_title`  (lines 111–146)

```
fn sanitize_terminal_title(title: &str) -> String
```

**Purpose**: Normalizes untrusted title text into a single safe display line suitable for embedding inside an OSC title sequence. It removes dangerous or misleading characters, collapses whitespace, and enforces a practical length limit.

**Data flow**: It takes `title: &str`, iterates over its characters while maintaining `sanitized: String`, `chars_written`, and `pending_space`. Whitespace characters set `pending_space` only after visible content has begun. Disallowed characters identified by `is_disallowed_terminal_title_char` are skipped. Before writing a visible character, a pending space is emitted only if more than one character of capacity remains. The loop stops once `chars_written` reaches `MAX_TERMINAL_TITLE_CHARS`, and the accumulated sanitized string is returned.

**Call relations**: `set_terminal_title` calls this immediately before deciding whether to emit a title. Tests also call it directly to pin normalization behavior.

*Call graph*: calls 1 internal fn (is_disallowed_terminal_title_char); called by 5 (set_terminal_title, sanitizes_terminal_title, strips_invisible_format_chars_from_terminal_title, truncates_terminal_title, truncation_prefers_visible_char_over_pending_space); 1 external calls (new).


##### `is_disallowed_terminal_title_char`  (lines 154–177)

```
fn is_disallowed_terminal_title_char(ch: char) -> bool
```

**Purpose**: Classifies characters that must be removed from terminal titles, including all control characters and a curated set of invisible or bidi formatting codepoints. This prevents escape-sequence corruption and visually deceptive titles.

**Data flow**: It takes `ch: char`, returns `true` immediately for `ch.is_control()`, otherwise returns whether `ch` matches one of the listed Unicode codepoints or ranges such as soft hyphen, directional isolates/overrides, zero-width characters, variation selectors, interlinear annotation controls, and related formatting characters.

**Call relations**: Only `sanitize_terminal_title` uses this helper while filtering untrusted title text.

*Call graph*: called by 1 (sanitize_terminal_title); 1 external calls (matches!).


##### `tests::sanitizes_terminal_title`  (lines 188–192)

```
fn sanitizes_terminal_title()
```

**Purpose**: Verifies that title sanitization collapses whitespace and removes control characters from mixed input. It protects the basic normalization contract.

**Data flow**: The test calls `sanitize_terminal_title` on a string containing spaces, tabs, newlines, and control bytes, then asserts the sanitized result is `"Project | Working | Thread"`.

**Call relations**: This test exercises the main whitespace and control-character paths in `sanitize_terminal_title`.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 1 external calls (assert_eq!).


##### `tests::strips_invisible_format_chars_from_terminal_title`  (lines 195–200)

```
fn strips_invisible_format_chars_from_terminal_title()
```

**Purpose**: Verifies that invisible and bidi formatting characters are removed while visible letters remain. It protects the Trojan-Source-style sanitization policy.

**Data flow**: It calls `sanitize_terminal_title` on a string containing several disallowed Unicode formatting characters interleaved with visible text and asserts the result is `"Project Title"`.

**Call relations**: This test specifically covers the Unicode filtering performed by `is_disallowed_terminal_title_char`.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 1 external calls (assert_eq!).


##### `tests::truncates_terminal_title`  (lines 203–207)

```
fn truncates_terminal_title()
```

**Purpose**: Checks that sanitized titles are capped at `MAX_TERMINAL_TITLE_CHARS`. It protects the practical title-length bound.

**Data flow**: It builds an overlong string of repeated `a`, sanitizes it, and asserts that the resulting length equals `MAX_TERMINAL_TITLE_CHARS`.

**Call relations**: This test covers the length-limit branch in `sanitize_terminal_title`.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 1 external calls (assert_eq!).


##### `tests::truncation_prefers_visible_char_over_pending_space`  (lines 210–215)

```
fn truncation_prefers_visible_char_over_pending_space()
```

**Purpose**: Verifies the subtle truncation rule that a pending collapsed space is skipped when only one character of capacity remains, allowing the final visible character to fit. It protects a reader-friendly edge case.

**Data flow**: It constructs a string with `MAX_TERMINAL_TITLE_CHARS - 1` visible `a` characters followed by a space and `b`, sanitizes it, then asserts the final length is exactly the maximum and the last character is `b`.

**Call relations**: This test targets the `remaining > 1` condition used when deciding whether to emit a pending space.

*Call graph*: calls 1 internal fn (sanitize_terminal_title); 2 external calls (assert_eq!, format!).


##### `tests::writes_osc_title_with_bel_terminator`  (lines 218–224)

```
fn writes_osc_title_with_bel_terminator()
```

**Purpose**: Checks that the low-level title command serializes to OSC 0 terminated by BEL. It protects the exact wire format used for title updates.

**Data flow**: It constructs `SetWindowTitle("hello".to_string())`, writes it into a `String` via `write_ansi`, and asserts the output equals `"\x1b]0;hello\x07"`.

**Call relations**: This test isolates the command-formatting behavior used by both title-setting and title-clearing paths.

*Call graph*: 3 external calls (new, assert_eq!, new).


### `cli/src/doctor/title.rs`

`domain_logic` · `doctor request handling`

This file turns terminal-title configuration into a doctor row. `terminal_title_check` extracts the relevant inputs from `codex_core::config::Config`: the optional `tui_terminal_title` list, current working directory, and a derived project root. Project-root resolution prefers `get_git_repo_root(cwd)` and falls back to the first project config layer in the config stack, using `ConfigLayerStackOrdering::LowestPrecedenceFirst` and the parent of the `.codex` folder.

`terminal_title_check_from_inputs` interprets three configuration modes: `None` means default items `activity, project-name`; `Some([])` means the feature is disabled; any other list is normalized by `parse_terminal_title_items`. Parsing canonicalizes aliases such as `project` to `project-name`, `spinner` to `activity`, and `session-id` to `thread-id`, while collecting unknown identifiers once each in quoted form. The doctor details always include source, normalized item list or `none`, and whether activity is enabled. If the project item is selected, it also reports the source of the project title and the concrete value derived from either the project root or the cwd.

Project display names come from the last path component when available, and `truncate_title_part` trims them by Unicode grapheme clusters to `PROJECT_TITLE_MAX_CHARS`, replacing the tail with `...` when needed. Invalid configured items downgrade the check to `Warning` and attach a `DoctorIssue` pointing users to `[tui].terminal_title`.

#### Function details

##### `terminal_title_check`  (lines 30–36)

```
fn terminal_title_check(config: &Config) -> DoctorCheck
```

**Purpose**: Builds the terminal-title doctor row from the loaded runtime configuration. It gathers the configured item list, cwd, and best project-root candidate before delegating formatting.

**Data flow**: Reads `config.tui_terminal_title`, clones `config.cwd` into a `PathBuf`, computes `project_root` with `terminal_title_project_root(config, &config.cwd)`, packages these into `TerminalTitleInputs`, and returns the `DoctorCheck` from `terminal_title_check_from_inputs`.

**Call relations**: This is the production entry used by the doctor subsystem. It delegates all normalization and warning logic to `terminal_title_check_from_inputs`.

*Call graph*: calls 2 internal fn (terminal_title_check_from_inputs, terminal_title_project_root).


##### `terminal_title_check_from_inputs`  (lines 38–106)

```
fn terminal_title_check_from_inputs(inputs: TerminalTitleInputs) -> DoctorCheck
```

**Purpose**: Formats terminal-title inputs into a doctor row and warns about unknown configured item identifiers. It also reports the concrete project-name value when that item is active.

**Data flow**: Consumes `TerminalTitleInputs` and branches on `configured_items`: `None` yields default items, `Some(empty)` yields disabled mode with no items, and non-empty lists are normalized by `parse_terminal_title_items`. It builds details for source, item list, and `activity_enabled`; appends invalid-item details when present; if `project_title_selected` is true, computes `(project_source, project_value)` via `project_title_candidate` and appends those details. It sets status to `Ok` or `Warning`, creates a `DoctorCheck`, and when invalid items exist adds a `DoctorIssue` containing measured invalid identifiers, expected known identifiers, a remedy, and the field name.

**Call relations**: Called by `terminal_title_check` in production and directly by all tests. It relies on parsing helpers and project-title helpers to keep configuration interpretation and path formatting separate.

*Call graph*: calls 5 internal fn (new, new, parse_terminal_title_items, project_title_candidate, project_title_selected); called by 8 (terminal_title_check, terminal_title_omits_project_when_project_item_is_not_selected, terminal_title_project_value_uses_tui_truncation_shape, terminal_title_reports_default_items_and_git_project_name, terminal_title_reports_disabled_configuration, terminal_title_reports_project_config_fallback, terminal_title_warns_for_invalid_configured_items, terminal_title_warns_when_all_configured_items_are_invalid); 3 external calls (new, format!, vec!).


##### `parse_terminal_title_items`  (lines 108–123)

```
fn parse_terminal_title_items(items: Vec<String>) -> (Vec<String>, Vec<String>)
```

**Purpose**: Normalizes configured terminal-title item identifiers and collects unknown entries without duplicates. It preserves the order of recognized items while deduplicating only the invalid-report list.

**Data flow**: Consumes a `Vec<String>`, iterates each item, calls `terminal_title_item_id`, pushes canonical IDs into `parsed` on success, and on failure inserts the original string into a `HashSet` to avoid repeated invalid reports before pushing a quoted version into `invalid`. It returns `(parsed, invalid)`.

**Call relations**: Used only by `terminal_title_check_from_inputs` when the user explicitly configured a non-empty item list.

*Call graph*: calls 1 internal fn (terminal_title_item_id); called by 1 (terminal_title_check_from_inputs); 3 external calls (new, new, format!).


##### `terminal_title_item_id`  (lines 125–150)

```
fn terminal_title_item_id(item: &str) -> Option<&'static str>
```

**Purpose**: Maps accepted terminal-title item names and aliases to canonical identifiers. Unknown strings return `None`.

**Data flow**: Matches the input `&str` against a fixed set of supported names and aliases and returns `Some(<canonical static str>)` or `None`.

**Call relations**: This helper is the vocabulary table used by `parse_terminal_title_items` to validate and canonicalize configured entries.

*Call graph*: called by 1 (parse_terminal_title_items).


##### `activity_enabled`  (lines 152–156)

```
fn activity_enabled(items: &[String]) -> bool
```

**Purpose**: Determines whether the normalized title item list includes activity/spinner output. It accepts either canonical or alias spellings.

**Data flow**: Iterates over the provided `items` slice and returns true if any entry equals `activity` or `spinner`, otherwise false.

**Call relations**: Used by `terminal_title_check_from_inputs` to emit the `terminal title activity` detail line.


##### `project_title_selected`  (lines 158–162)

```
fn project_title_selected(items: &[String]) -> bool
```

**Purpose**: Checks whether the title configuration includes the project-name item. It recognizes both canonical and alias spellings.

**Data flow**: Iterates over the provided `items` slice and returns true if any entry equals `project-name` or `project`.

**Call relations**: Called by `terminal_title_check_from_inputs` to decide whether project-source and project-value details should be included.

*Call graph*: called by 1 (terminal_title_check_from_inputs).


##### `terminal_title_project_root`  (lines 164–189)

```
fn terminal_title_project_root(config: &Config, cwd: &Path) -> Option<ProjectTitleRoot>
```

**Purpose**: Finds the path that should supply the project-name title segment. It prefers the Git repository root and otherwise falls back to the first project config layer root.

**Data flow**: Accepts the loaded `Config` and current working directory. It first calls `get_git_repo_root(cwd)` and, if present, returns a `ProjectTitleRoot` tagged `git repo root`. Otherwise it iterates config layers from lowest precedence upward, including disabled layers, and for the first `ConfigLayerSource::Project` extracts the parent directory of `dot_codex_folder` and returns it tagged `project config`; if none match, it returns `None`.

**Call relations**: Used by `terminal_title_check` before formatting so the doctor row can explain where the project title would come from.

*Call graph*: called by 1 (terminal_title_check); 1 external calls (get_git_repo_root).


##### `project_title_candidate`  (lines 191–202)

```
fn project_title_candidate(
    project_root: Option<ProjectTitleRoot>,
    cwd: &Path,
) -> (&'static str, Option<String>)
```

**Purpose**: Computes the displayed project-name source label and truncated value. It falls back to the cwd when no explicit project root was found.

**Data flow**: Consumes an optional `ProjectTitleRoot` and a cwd path. If a project root exists, it returns that root's source plus `truncate_title_part(path_display_name(&root.path))`; otherwise it returns `cwd` plus the truncated display name of the cwd.

**Call relations**: Called by `terminal_title_check_from_inputs` only when the project-name item is selected, separating source selection from the main doctor formatting logic.

*Call graph*: calls 2 internal fn (path_display_name, truncate_title_part); called by 1 (terminal_title_check_from_inputs).


##### `path_display_name`  (lines 204–208)

```
fn path_display_name(path: &Path) -> String
```

**Purpose**: Extracts a human-friendly name for a path segment to use in the terminal title. It prefers the final path component and falls back to the full display string.

**Data flow**: Reads `path.file_name()`, converts it lossily to `String` when present, and otherwise returns `path.display().to_string()`.

**Call relations**: Used by `project_title_candidate` before truncation so project titles are usually just the directory name rather than the full path.

*Call graph*: called by 1 (project_title_candidate); 1 external calls (file_name).


##### `truncate_title_part`  (lines 210–226)

```
fn truncate_title_part(value: String) -> String
```

**Purpose**: Truncates a title segment to the same shape used by the TUI, counting Unicode grapheme clusters rather than bytes. Long values are shortened with a trailing ellipsis.

**Data flow**: Consumes a `String`, iterates grapheme clusters with `UnicodeSegmentation::graphemes(true)`, collects the first `PROJECT_TITLE_MAX_CHARS` graphemes into `head`, and if additional graphemes remain and the limit exceeds three, rebuilds a shorter prefix of `PROJECT_TITLE_MAX_CHARS - 3` graphemes and appends `...`; otherwise it returns `head` unchanged.

**Call relations**: Called by `project_title_candidate` so the doctor output mirrors the actual terminal-title truncation behavior users see.

*Call graph*: called by 1 (project_title_candidate).


##### `tests::terminal_title_reports_default_items_and_git_project_name`  (lines 235–261)

```
fn terminal_title_reports_default_items_and_git_project_name()
```

**Purpose**: Verifies the default configuration path when no explicit title items are configured and a Git root is available. It checks summary text and project-source/value details.

**Data flow**: Constructs `TerminalTitleInputs` with `configured_items: None`, a cwd under `/repo`, and a `ProjectTitleRoot` tagged `git repo root`, calls `terminal_title_check_from_inputs`, and asserts the summary plus presence of expected detail strings.

**Call relations**: This test covers the `None` configuration branch and the Git-root project-title path in `terminal_title_check_from_inputs`.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 3 external calls (from, assert!, assert_eq!).


##### `tests::terminal_title_reports_disabled_configuration`  (lines 264–288)

```
fn terminal_title_reports_disabled_configuration()
```

**Purpose**: Verifies that an explicitly empty configured item list disables terminal titles. It ensures no project details are emitted in that mode.

**Data flow**: Builds inputs with `configured_items: Some(Vec::new())`, calls `terminal_title_check_from_inputs`, and asserts the summary, `items: none`, `activity: false`, and absence of any detail starting with `terminal title project `.

**Call relations**: This test exercises the special disabled branch in `terminal_title_check_from_inputs`.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, new, assert!, assert_eq!).


##### `tests::terminal_title_reports_project_config_fallback`  (lines 291–312)

```
fn terminal_title_reports_project_config_fallback()
```

**Purpose**: Verifies that project-name details can come from project config rather than Git. It checks the fallback source label and derived project value.

**Data flow**: Creates inputs with a configured `project` item, cwd under `/workspace/project/subdir`, and a `ProjectTitleRoot` tagged `project config`, then calls `terminal_title_check_from_inputs` and asserts summary and expected project detail strings.

**Call relations**: This test covers the project-config fallback path represented by `terminal_title_project_root` in production.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, assert!, assert_eq!, vec!).


##### `tests::terminal_title_omits_project_when_project_item_is_not_selected`  (lines 315–332)

```
fn terminal_title_omits_project_when_project_item_is_not_selected()
```

**Purpose**: Verifies that project-source and project-value details are omitted when the configured title items do not include project-name. This prevents unrelated project diagnostics from appearing.

**Data flow**: Builds inputs with only the `model` item and a present `ProjectTitleRoot`, calls `terminal_title_check_from_inputs`, and asserts the configured summary plus absence of any `terminal title project ` detail.

**Call relations**: This test targets the `project_title_selected` gate inside `terminal_title_check_from_inputs`.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, assert!, assert_eq!, vec!).


##### `tests::terminal_title_warns_for_invalid_configured_items`  (lines 335–366)

```
fn terminal_title_warns_for_invalid_configured_items()
```

**Purpose**: Verifies that unknown configured item identifiers produce a warning, are deduplicated in reporting, and still preserve recognized items. It also checks that a doctor issue is attached.

**Data flow**: Supplies a configured item list containing valid aliases and repeated `bogus`, calls `terminal_title_check_from_inputs`, and asserts warning status, warning summary, normalized valid items, quoted invalid-item detail, and a single issue.

**Call relations**: This test exercises `parse_terminal_title_items` and the warning/issue branch in `terminal_title_check_from_inputs`.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, assert!, assert_eq!, vec!).


##### `tests::terminal_title_warns_when_all_configured_items_are_invalid`  (lines 369–387)

```
fn terminal_title_warns_when_all_configured_items_are_invalid()
```

**Purpose**: Verifies the edge case where every configured item is unknown. The resulting normalized item list should be empty while still reporting the invalid entries.

**Data flow**: Builds inputs with only `bogus`, calls `terminal_title_check_from_inputs`, and asserts warning status plus details showing `items: none` and the quoted invalid item.

**Call relations**: This test covers the all-invalid branch after `parse_terminal_title_items` returns an empty parsed list.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 4 external calls (from, assert!, assert_eq!, vec!).


##### `tests::terminal_title_project_value_uses_tui_truncation_shape`  (lines 390–405)

```
fn terminal_title_project_value_uses_tui_truncation_shape()
```

**Purpose**: Verifies that project-name values are truncated to the same visible shape as the TUI. It checks the exact ellipsis placement for a long directory name.

**Data flow**: Creates inputs with a long project path and the `project` item selected, calls `terminal_title_check_from_inputs`, and asserts that the details contain the expected truncated project value string.

**Call relations**: This test protects the `truncate_title_part` behavior as surfaced through `project_title_candidate` and the doctor row.

*Call graph*: calls 1 internal fn (terminal_title_check_from_inputs); 3 external calls (from, assert!, vec!).


### Pet and auxiliary terminal surfaces
These files provide the pet-rendering subsystem and other auxiliary terminal-facing surfaces used once the TUI is running.

### `tui/src/pets/mod.rs`

`orchestration` · `pet asset preparation and terminal image emission during UI redraws`

This module is the integration layer for terminal pets. It re-exports the ambient pet types and selected helpers from submodules, defines the default and disabled pet ids, and exposes `ensure_builtin_pack_for_pet` so callers can materialize built-in assets before attempting to load or persist a selection. That function is intentionally a no-op for custom pets: only catalog ids trigger `asset_pack::ensure_builtin_pet`.

The rendering half centers on `PetImageRenderState`, which remembers the last image protocol used and the last sixel cell area that was cleared. `render_ambient_pet_image` and `render_pet_picker_preview_image` are thin wrappers that call the shared `render_pet_image` with distinct Kitty image ids so the ambient sprite and picker preview do not collide. `render_pet_image` handles three cases: clearing when there is no request, replacing an existing image, and drawing a new image. Kitty-family protocols always emit a delete command before redraw or clear to avoid stale images. Sixel requires different bookkeeping: because sixel output is not tied to an image id, the code computes a `SixelClearArea` from the draw request, clears any previously occupied cell rectangle when it changes, clears the current rectangle before drawing, and stores that area for future erasure.

Payload generation is delegated by protocol: inline Kitty PNG, Kitty local-file reference, or cached sixel bytes loaded from disk. All drawing preserves the terminal cursor by saving position, moving to the image origin, writing the payload, restoring position, and flushing. Errors are normalized into `PetImageRenderError`, distinguishing terminal write failures from missing/unavailable image assets.

#### Function details

##### `ensure_builtin_pack_for_pet`  (lines 60–68)

```
fn ensure_builtin_pack_for_pet(
    pet_id: &str,
    codex_home: &std::path::Path,
) -> Result<()>
```

**Purpose**: Ensures that a selected built-in pet has its spritesheet cached locally before later load or preview steps. Custom pet ids are ignored because their assets are already expected to be local.

**Data flow**: Inputs are `pet_id: &str` and `codex_home: &Path`. It looks up the id with `catalog::builtin_pet`; if that returns `Some(pet)`, it calls `asset_pack::ensure_builtin_pet(codex_home, pet)`, otherwise it does nothing, and returns `Result<()>`.

**Call relations**: Called by higher-level pet selection or preview orchestration before `Pet::load_with_codex_home`. It delegates built-in detection to the catalog and actual download/validation to the asset-pack module.

*Call graph*: calls 2 internal fn (ensure_builtin_pet, builtin_pet).


##### `PetImageRenderError::fmt`  (lines 77–82)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats rendering failures into user-readable error messages that distinguish terminal I/O problems from asset-generation problems. The wording reflects whether the failure happened while writing to the terminal or preparing image data.

**Data flow**: It matches on `self` and writes either `terminal image write failed: ...` or `pet image asset unavailable: ...` into the provided formatter.

**Call relations**: Used automatically when `PetImageRenderError` is displayed by callers or tests.

*Call graph*: 1 external calls (write!).


##### `PetImageRenderError::source`  (lines 86–91)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Exposes the underlying error object for error chaining. This preserves the original `std::io::Error` or `anyhow::Error` as the source.

**Data flow**: It matches on `self` and returns `Some(err)` for both variants, converting the boxed `anyhow` error to `&dyn Error` via `as_ref()`.

**Call relations**: Used by generic error-reporting infrastructure and by tests that verify source chaining is preserved.


##### `PetImageRenderError::from`  (lines 95–97)

```
fn from(err: std::io::Error) -> Self
```

**Purpose**: Converts a plain terminal `std::io::Error` into the rendering error type. This lets `?` propagate terminal write failures naturally inside rendering code.

**Data flow**: Input is `err: std::io::Error`. It wraps the error as `PetImageRenderError::Terminal(err)` and returns it.

**Call relations**: Used implicitly by `render_pet_image` when terminal cursor movement, writes, or flushes fail.

*Call graph*: 1 external calls (Terminal).


##### `render_ambient_pet_image`  (lines 100–106)

```
fn render_ambient_pet_image(
    writer: &mut impl Write,
    state: &mut PetImageRenderState,
    request: Option<AmbientPetDraw>,
) -> std::result::Result<(), PetImageRenderError>
```

**Purpose**: Renders or clears the ambient pet image using a fixed Kitty image id reserved for the ambient sprite. It is the public entry point for transcript/composer ambient pet output.

**Data flow**: Inputs are a mutable terminal writer, mutable `PetImageRenderState`, and an optional `AmbientPetDraw`. It forwards those to `render_pet_image` with image id `0xC0DE` and returns the resulting `Result<(), PetImageRenderError>`.

**Call relations**: Called by the ambient pet drawing path and by tests. It is a thin wrapper over `render_pet_image` that exists to keep ambient and preview image ids distinct.

*Call graph*: calls 1 internal fn (render_pet_image); called by 8 (ambient_pet_image_restores_cursor_after_drawing, kitty_local_file_pet_image_uses_file_reference_without_inline_payload, kitty_pet_image_clear_deletes_without_moving_cursor, missing_frame_is_an_asset_error, sixel_pet_image_clear_erases_last_drawn_area, sixel_pet_image_clears_cell_area_before_redrawing, writer_failure_is_a_terminal_error, clear_ambient_pet_image).


##### `render_pet_picker_preview_image`  (lines 108–114)

```
fn render_pet_picker_preview_image(
    writer: &mut impl Write,
    state: &mut PetImageRenderState,
    request: Option<AmbientPetDraw>,
) -> std::result::Result<(), PetImageRenderError>
```

**Purpose**: Renders or clears the `/pets` picker preview image using a separate fixed Kitty image id. This prevents preview updates from deleting or replacing the ambient pet image.

**Data flow**: Inputs mirror `render_ambient_pet_image`; it forwards them to `render_pet_image` with image id `0xC0DF` and returns the result.

**Call relations**: Used by picker preview rendering. Like the ambient wrapper, it delegates all real work to `render_pet_image`.

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

**Purpose**: Implements the full terminal-image rendering state machine for Kitty, KittyLocalFile, and Sixel protocols, including deletion, area clearing, cursor preservation, payload generation, and state updates. It is the central renderer shared by ambient and picker preview images.

**Data flow**: Inputs are a mutable writer, mutable `PetImageRenderState`, a numeric `image_id`, and an optional `AmbientPetDraw`. If `request` is `None`, it deletes any previous Kitty image when `state.last_protocol` was Kitty-family, clears any remembered sixel area, flushes, and returns. If a request exists, it may delete the previous/current Kitty image, stores `state.last_protocol`, builds a payload by protocol (`kitty_transmit_png_with_id`, `kitty_transmit_png_file_with_id`, or `sixel_frame` plus `std::fs::read`), saves cursor position, computes the current sixel clear area if needed, clears the previous sixel area when it changed, clears the current sixel area before drawing, moves the cursor to `request.x, request.y`, writes either text or raw bytes, restores cursor position, flushes, and updates `state.last_sixel_clear_area`.

**Call relations**: This function is called only by the two public wrapper functions. It delegates protocol-specific payload creation to the image-protocol module and uses `clear_sixel_area`, `is_kitty_protocol`, and `SixelClearArea::from` to manage protocol-specific redraw semantics.

*Call graph*: calls 6 internal fn (from, clear_sixel_area, kitty_transmit_png_file_with_id, kitty_transmit_png_with_id, sixel_frame, is_kitty_protocol); called by 2 (render_ambient_pet_image, render_pet_picker_preview_image); 8 external calls (flush, write_all, matches!, queue!, read, Bytes, Text, write!).


##### `is_kitty_protocol`  (lines 214–219)

```
fn is_kitty_protocol(protocol: image_protocol::ImageProtocol) -> bool
```

**Purpose**: Classifies whether an `ImageProtocol` belongs to the Kitty family for deletion semantics. Both inline Kitty and local-file Kitty are treated the same here.

**Data flow**: Input is an `image_protocol::ImageProtocol`. It returns `true` for `Kitty` or `KittyLocalFile` and `false` for `Sixel`.

**Call relations**: Used by `render_pet_image` to decide when to emit Kitty delete commands before redraw or clear.

*Call graph*: called by 1 (render_pet_image); 1 external calls (matches!).


##### `SixelClearArea::from`  (lines 230–237)

```
fn from(request: &AmbientPetDraw) -> Self
```

**Purpose**: Derives the terminal cell rectangle that must be blanked before or after drawing a sixel image. The rectangle spans from the request’s `clear_top_y` down through the sprite’s bottom row.

**Data flow**: Input is `&AmbientPetDraw`. It copies `x`, `clear_top_y`, and `columns`, computes `clear_bottom_y` as `request.y.saturating_add(request.rows)`, and returns a `SixelClearArea`.

**Call relations**: Called by `render_pet_image` whenever the active protocol is Sixel so the renderer can track and clear the occupied cell area.

*Call graph*: called by 1 (render_pet_image).


##### `clear_sixel_area`  (lines 240–250)

```
fn clear_sixel_area(writer: &mut impl Write, area: SixelClearArea) -> std::io::Result<()>
```

**Purpose**: Erases a rectangular terminal cell area by writing spaces row by row. This compensates for sixel images not being tied to a deletable image id.

**Data flow**: Inputs are a mutable writer and a `SixelClearArea`. It allocates a blank string of `area.columns` spaces, iterates rows from `clear_top_y` up to but not including `clear_bottom_y`, queues a cursor move to `(area.x, row)` for each row, writes the blank string, and returns `std::io::Result<()>`.

**Call relations**: Used by `render_pet_image` before drawing sixel images, when clearing changed sixel regions, and when removing the last sixel image on a `None` request.

*Call graph*: called by 1 (render_pet_image); 2 external calls (queue!, write!).


##### `tests::ambient_pet_image_restores_cursor_after_drawing`  (lines 262–290)

```
fn ambient_pet_image_restores_cursor_after_drawing()
```

**Purpose**: Verifies that drawing an ambient pet saves the cursor, moves to the image position, writes the payload, and restores the cursor afterward. This protects the TUI layout from image rendering side effects.

**Data flow**: It creates a temporary PNG file and `AmbientPetDraw`, renders it into a `Vec<u8>` with default state, converts the output to UTF-8, locates the save, move, payload, and restore sequences, and asserts they appear in the correct order.

**Call relations**: This test exercises the normal Kitty draw path in `render_ambient_pet_image` and `render_pet_image`.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (new, from_utf8, new, assert!, write, tempdir, default).


##### `tests::kitty_pet_image_clear_deletes_without_moving_cursor`  (lines 293–320)

```
fn kitty_pet_image_clear_deletes_without_moving_cursor()
```

**Purpose**: Checks that clearing a previously drawn Kitty image emits only the delete command and does not save, move, or restore the cursor. Clearing should be minimally invasive.

**Data flow**: It renders a Kitty request once to seed state, clears the output buffer, calls `render_ambient_pet_image` with `None`, converts output to UTF-8, and asserts the delete command is present while cursor-control sequences are absent.

**Call relations**: This test validates the `request == None` clear branch in `render_pet_image` when the previous protocol was Kitty-family.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (new, from_utf8, new, assert!, write, tempdir, default).


##### `tests::kitty_local_file_pet_image_uses_file_reference_without_inline_payload`  (lines 323–349)

```
fn kitty_local_file_pet_image_uses_file_reference_without_inline_payload()
```

**Purpose**: Verifies that the KittyLocalFile path uses a file-reference transmission command rather than embedding base64 PNG bytes inline. It also confirms normal cursor save/move/restore behavior.

**Data flow**: It creates a temporary PNG file and a `AmbientPetDraw` with `protocol: KittyLocalFile`, renders it, converts output to UTF-8, and asserts the output contains the delete command, cursor move, file-reference transmit command, no inline `cG5n` payload, and a restore sequence.

**Call relations**: This test exercises the `ImageProtocol::KittyLocalFile` payload branch in `render_pet_image`.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (new, from_utf8, new, assert!, write, tempdir, default).


##### `tests::sixel_pet_image_clears_cell_area_before_redrawing`  (lines 352–380)

```
fn sixel_pet_image_clears_cell_area_before_redrawing()
```

**Purpose**: Checks that sixel rendering blanks the occupied cell rectangle before writing the sixel payload. This prevents stale text from showing through or around the image.

**Data flow**: It creates a fake cached sixel file and a sixel draw request, renders it, converts output to UTF-8, and asserts the output contains the expected sequence of row-by-row blank writes followed by the sixel payload and cursor restore.

**Call relations**: This test validates the Sixel draw branch in `render_pet_image`, including `SixelClearArea::from` and `clear_sixel_area`.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (from_utf8, new, assert!, create_dir, write, tempdir, default).


##### `tests::sixel_pet_image_clear_erases_last_drawn_area`  (lines 383–415)

```
fn sixel_pet_image_clear_erases_last_drawn_area()
```

**Purpose**: Verifies that clearing a previously drawn sixel image erases the remembered cell area instead of emitting a Kitty delete command. This is the sixel-specific clear contract.

**Data flow**: It first renders a sixel request to seed `last_sixel_clear_area`, clears the output buffer, calls `render_ambient_pet_image` with `None`, converts output to UTF-8, and asserts there is no Kitty delete command, but there are cursor save/restore sequences and the expected blanking writes, with no sixel payload.

**Call relations**: This test exercises the `request == None` clear branch in `render_pet_image` when the previous protocol was Sixel.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 7 external calls (from_utf8, new, assert!, create_dir, write, tempdir, default).


##### `tests::missing_frame_is_an_asset_error`  (lines 418–438)

```
fn missing_frame_is_an_asset_error()
```

**Purpose**: Checks that a missing frame file is reported as an asset-preparation failure rather than a terminal write failure. This preserves the renderer’s error classification boundary.

**Data flow**: It constructs a Kitty draw request pointing at a nonexistent PNG path, calls `render_ambient_pet_image`, captures the error, and asserts it matches `PetImageRenderError::Asset(_)` and has a source error.

**Call relations**: This test validates error mapping from image-protocol payload generation into the renderer’s `Asset` variant.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 5 external calls (new, new, assert!, tempdir, default).


##### `tests::writer_failure_is_a_terminal_error`  (lines 441–467)

```
fn writer_failure_is_a_terminal_error()
```

**Purpose**: Verifies that failures from the output writer are surfaced as `Terminal` errors with preserved source chaining. This distinguishes transport failures from asset failures.

**Data flow**: It defines a `FailingWriter` whose `write` method returns `BrokenPipe`, seeds render state with a previous Kitty protocol, calls `render_ambient_pet_image` with `None`, and asserts the resulting error matches `PetImageRenderError::Terminal(_)` and has a source.

**Call relations**: This test exercises the clear path in `render_pet_image` and the `From<std::io::Error>` conversion into `PetImageRenderError`.

*Call graph*: calls 1 internal fn (render_ambient_pet_image); 2 external calls (default, assert!).
