# Primary user-facing launch surfaces  `stage-1.1`

This stage is the system’s front door. It is where user commands first arrive, during startup, and where the program decides which path to take next. Think of it like a train station ticket desk: it reads what the user asked for, checks the rules, and sends the request to the right platform or tool.

The main `codex` command in `cli/src/main.rs` is the central traffic controller. It understands all top-level commands and shared flags. `cli/src/lib.rs`, `tui/src/cli.rs`, `exec/src/cli.rs`, and `cloud-tasks/src/cli.rs` define the shapes of those commands so raw text typed in a shell becomes structured options the code can trust.

From there, specialized launchers do the real work. The TUI files start the interactive text interface. The desktop-app files open Codex Desktop, with separate macOS and Windows behavior hidden behind one common entry point. Other commands start remote control, run sandboxed commands, set up Windows sandbox support, manage MCP server settings, apply task diffs to Git, archive or delete sessions, and run `doctor` checks that inspect local state and report problems clearly.

## Files in this stage

### Root CLI routing
These files define the main Codex command surface and the shared CLI types that route users into the stage's major launch paths.

### `cli/src/lib.rs`

`config` · `CLI argument parsing`

This crate root primarily declares modules and re-exports functions used by the CLI binary, but it also defines the clap-parsed command structs for the sandbox subcommands: `SeatbeltCommand`, `LandlockCommand`, and `WindowsCommand`. These structs intentionally remain separate even though they share many fields, because each host sandbox backend has slightly different option surfaces. Common fields include an optional permissions profile name, optional config profile, optional working directory gated by `requires = "permissions_profile"`, a flag to include managed config while resolving explicit profiles, hidden `CliConfigOverrides`, and trailing command arguments. `SeatbeltCommand` additionally supports repeated `--allow-unix-socket` paths and a `--log-denials` flag.

The one local helper, `parse_allow_unix_socket_path`, is used as the clap value parser for `SeatbeltCommand.allow_unix_sockets`. It resolves each raw argument relative to the current directory into an `AbsolutePathBuf`, converting path-resolution failures into user-facing error strings that include the original input. This keeps path normalization and validation at argument-parse time rather than later in sandbox execution.

#### Function details

##### `parse_allow_unix_socket_path`  (lines 69–72)

```
fn parse_allow_unix_socket_path(raw: &str) -> Result<AbsolutePathBuf, String>
```

**Purpose**: Parses a `--allow-unix-socket` CLI argument into an absolute path. Relative inputs are resolved against the current working directory and invalid paths become clap-friendly error strings.

**Data flow**: Accepts the raw argument string, calls `AbsolutePathBuf::relative_to_current_dir(raw)`, and returns either the resolved `AbsolutePathBuf` or a formatted `String` error of the form `invalid path <raw>: <err>`.

**Call relations**: This function is referenced by the clap definition on `SeatbeltCommand.allow_unix_sockets`, so it runs during argument parsing before sandbox execution begins.

*Call graph*: calls 1 internal fn (relative_to_current_dir).


### `cli/src/main.rs`

`entrypoint` · `startup and command dispatch; also active during interactive startup/error recovery and subcommand invocation`

This file is the central command dispatcher for the Codex CLI binary. It declares the full clap surface: the root `MultitoolCli`, dozens of subcommands, wrapper argument structs for resume/fork/archive flows, app-server and exec-server controls, feature inspection/editing, and platform-specific sandbox/app commands. The main control path starts in `main`, captures an environment-derived remote-control disable flag, then enters `cli_main` through `arg0_dispatch_or_else` so alternate executable names can still resolve helper binaries.

`cli_main` parses the root CLI, folds `--enable/--disable` feature toggles into raw config overrides, validates whether root `--strict-config` and `--profile` are legal for the chosen subcommand, and then performs a large match dispatch. Interactive commands route through `run_interactive_tui`, which normalizes prompt newlines, warns on `TERM=dumb`, resolves optional remote app-server endpoints and bearer tokens, and contains a retry loop that detects local SQLite startup failures and attempts one automatic backup-and-rebuild per damaged database path before surfacing a fatal exit. Non-interactive branches propagate root config overrides into subcommand-local override lists with lower precedence than subcommand flags.

The file also contains concrete helper logic that would otherwise be easy to miss: resume/fork positional reinterpretation when `--last` is present, deletion safety requiring UUIDs for `--force`, exec-server remote-auth restrictions for API-key registration hosts, feature-stage labeling and under-development warnings, app-server daemon JSON printers, shell completion generation, and debug commands for prompt-input rendering, model catalog dumping, rollout trace reduction, and memory-state clearing. The large test module locks down parsing edge cases, migration behavior, and user-facing messages.

#### Function details

##### `SessionTuiCli::augment_args`  (lines 401–403)

```
fn augment_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: Customizes `TuiCli` argument parsing for session wrapper commands so the `prompt` positional conflicts with `--last`. This preserves the special resume/fork positional reinterpretation rules.

**Data flow**: Takes a clap `Command`, delegates to `TuiCli::augment_args`, then mutates the `prompt` argument definition to conflict with `last`. Returns the modified clap command without touching runtime state.

**Call relations**: Clap invokes this while building parser metadata for `SessionTuiCli`; it exists specifically so `resume`/`fork` can reuse `TuiCli` parsing while tightening one positional conflict rule.

*Call graph*: 1 external calls (augment_args).


##### `SessionTuiCli::augment_args_for_update`  (lines 405–407)

```
fn augment_args_for_update(cmd: clap::Command) -> clap::Command
```

**Purpose**: Applies the same `prompt` versus `--last` conflict rule when clap updates an existing command definition. It keeps update-mode parsing behavior aligned with initial parser construction.

**Data flow**: Receives a clap `Command`, delegates to `TuiCli::augment_args_for_update`, mutates the `prompt` arg to conflict with `last`, and returns the updated command.

**Call relations**: Used by clap’s update path for `SessionTuiCli`; paired with `SessionTuiCli::augment_args` so both parser construction modes enforce the same invariant.

*Call graph*: 1 external calls (augment_args_for_update).


##### `SessionTuiCli::from_arg_matches`  (lines 411–413)

```
fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error>
```

**Purpose**: Wraps clap parsing of `TuiCli` into the `SessionTuiCli` newtype used by resume/fork/archive command structs.

**Data flow**: Reads clap `ArgMatches`, delegates to `TuiCli::from_arg_matches`, and maps the parsed `TuiCli` into `SessionTuiCli`. Returns either the wrapped value or clap’s parse error.

**Call relations**: Called by clap during argument parsing for session-oriented subcommands so those commands can later unwrap and merge a scoped `TuiCli` into the root interactive configuration.

*Call graph*: 1 external calls (from_arg_matches).


##### `SessionTuiCli::update_from_arg_matches`  (lines 415–417)

```
fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error>
```

**Purpose**: Updates an existing wrapped `TuiCli` from clap matches during incremental parsing.

**Data flow**: Takes `&mut self` plus `ArgMatches`, forwards the update into the inner `TuiCli`, and returns clap success or failure. It mutates only the inner parser state.

**Call relations**: Used by clap’s update machinery for `SessionTuiCli`; it complements `from_arg_matches` and keeps the wrapper transparent except for the custom arg-shape rules.


##### `parse_socket_path`  (lines 697–700)

```
fn parse_socket_path(raw: &str) -> Result<AbsolutePathBuf, String>
```

**Purpose**: Resolves a user-supplied socket path string into an `AbsolutePathBuf` relative to the current working directory.

**Data flow**: Consumes a raw `&str`, calls `AbsolutePathBuf::relative_to_current_dir`, and converts any path-resolution error into a user-facing string mentioning the original input. Returns the absolute path or a parse error string.

**Call relations**: Used as the clap value parser for app-server proxy and stdio-to-UDS commands so path normalization happens during argument parsing rather than later at execution time.

*Call graph*: calls 1 internal fn (relative_to_current_dir).


##### `format_exit_messages`  (lines 702–728)

```
fn format_exit_messages(exit_info: AppExitInfo, color_enabled: bool) -> Vec<String>
```

**Purpose**: Builds the human-readable lines printed after an interactive TUI session exits, including token usage and resume guidance.

**Data flow**: Consumes `AppExitInfo` and a `color_enabled` flag, inspects `exit_reason`, `token_usage`, `thread_id`, and `resume_hint`, and produces a `Vec<String>`. It emits token usage only when non-zero, prefers a colored or plain resume command when available, and falls back to `Session ID: ...` only for fatal exits without a resume hint.

**Call relations**: Called by `handle_app_exit` after the TUI returns, and heavily exercised by tests that pin exact output for fatal/non-fatal exits, named threads, and colorized resume hints.

*Call graph*: called by 7 (handle_app_exit, format_exit_messages_applies_color_when_enabled, format_exit_messages_includes_resume_hint_for_fatal_exit, format_exit_messages_includes_resume_hint_without_color, format_exit_messages_includes_session_id_for_fatal_exit_without_resume_hint, format_exit_messages_names_picker_item_when_thread_has_name, format_exit_messages_skips_zero_usage); 3 external calls (new, format!, matches!).


##### `handle_app_exit`  (lines 731–753)

```
fn handle_app_exit(exit_info: AppExitInfo) -> anyhow::Result<()>
```

**Purpose**: Processes the final `AppExitInfo` from the TUI: prints fatal errors, prints formatted exit lines, exits with status 1 on fatal termination, and optionally runs a post-exit update action.

**Data flow**: Reads `exit_reason` to decide whether the exit is fatal, prints an `ERROR:` line for fatal messages, computes color support from stdout, iterates over `format_exit_messages` output, flushes stdout before `process::exit(1)` on fatal exits, and otherwise invokes `run_update_action` if `update_action` is present. Returns `Ok(())` only for non-fatal flows.

**Call relations**: Invoked by `cli_main` after interactive, resume, and fork TUI runs. It delegates message construction to `format_exit_messages` and update execution to `run_update_action`.

*Call graph*: calls 2 internal fn (format_exit_messages, run_update_action); called by 1 (cli_main); 5 external calls (eprintln!, println!, stdout, exit, on).


##### `run_update_action`  (lines 756–796)

```
fn run_update_action(action: UpdateAction) -> anyhow::Result<()>
```

**Purpose**: Executes the platform-specific self-update command represented by `UpdateAction` and reports success or failure to the user.

**Data flow**: Takes an `UpdateAction`, prints the command string, derives executable/args via `command_args` or `command_str`, then spawns a child process. On Windows it special-cases the standalone PowerShell installer and otherwise routes through `cmd /C`; on non-Windows it normalizes command paths and args through `wsl_paths::normalize_for_wsl`. It checks the exit status, bails on failure, and prints a restart message on success.

**Call relations**: Called either from `handle_app_exit` when the TUI requested an update or from `run_update_command` for explicit `codex update`. It encapsulates all OS-specific process-launch behavior.

*Call graph*: calls 3 internal fn (normalize_for_wsl, command_args, command_str); called by 2 (handle_app_exit, run_update_command); 3 external calls (bail!, new, println!).


##### `run_update_command`  (lines 798–815)

```
fn run_update_command() -> anyhow::Result<()>
```

**Purpose**: Implements the explicit `codex update` subcommand, rejecting debug builds and otherwise discovering the appropriate updater.

**Data flow**: In debug builds it immediately returns an error explaining that updates are unavailable. In release builds it asks `codex_tui::get_update_action` for an installation-specific updater, errors if none can be detected, and forwards the action to `run_update_action`.

**Call relations**: Reached from the `Subcommand::Update` branch in `cli_main`; it is a thin policy wrapper around `run_update_action`.

*Call graph*: calls 1 internal fn (run_update_action); called by 1 (cli_main); 2 external calls (bail!, get_update_action).


##### `run_execpolicycheck`  (lines 817–819)

```
fn run_execpolicycheck(cmd: ExecPolicyCheckCommand) -> anyhow::Result<()>
```

**Purpose**: Runs the hidden execpolicy validation command.

**Data flow**: Consumes an `ExecPolicyCheckCommand`, calls its `run` method, and returns the resulting `anyhow::Result<()>` unchanged.

**Call relations**: Dispatched from `cli_main` for `codex execpolicy check`; this file keeps the top-level branch minimal by delegating directly to the command object.

*Call graph*: calls 1 internal fn (run); called by 1 (cli_main).


##### `run_session_archive_cli_command`  (lines 821–852)

```
async fn run_session_archive_cli_command(
    action: codex_tui::SessionArchiveAction,
    cmd: SessionArchiveCommand,
    mut interactive: TuiCli,
    root_config_overrides: CliConfigOverrides,
    r
```

**Purpose**: Normalizes archive/delete/unarchive session command inputs into the shape expected by `codex_tui::run_session_archive_command`.

**Data flow**: Takes a `SessionArchiveAction`, parsed `SessionArchiveCommand`, root and scoped `TuiCli`/override/remote values, and `Arg0DispatchPaths`. It merges archive-scoped interactive flags via `finalize_session_archive_interactive`, resolves the effective remote endpoint with `resolve_remote_endpoint`, then calls `codex_tui::run_session_archive_command` with the target session string and assembled options. It returns the command’s output string or wraps its error into `anyhow`.

**Call relations**: Used by `cli_main` for archive, delete, and unarchive branches. It centralizes the shared setup so those branches differ only in the chosen `SessionArchiveAction`.

*Call graph*: calls 2 internal fn (finalize_session_archive_interactive, resolve_remote_endpoint); called by 1 (cli_main); 1 external calls (run_session_archive_command).


##### `delete_action`  (lines 854–863)

```
fn delete_action(target: &str, force: bool) -> anyhow::Result<codex_tui::SessionArchiveAction>
```

**Purpose**: Builds the delete archive action and enforces that `--force` may only be used with a UUID session identifier.

**Data flow**: Reads the target string and `force` flag, attempts `ThreadId::from_string` when forced, bails if the target is not a UUID, then maps `force` to either `DeleteConfirmation::Skip` or `Prompt` and returns `SessionArchiveAction::Delete`.

**Call relations**: Called by `cli_main` before invoking the shared archive/delete runner, and covered by tests that verify the UUID-only force rule.

*Call graph*: calls 1 internal fn (from_string); called by 2 (cli_main, delete_force_requires_uuid); 2 external calls (bail!, Delete).


##### `run_debug_app_server_command`  (lines 865–873)

```
async fn run_debug_app_server_command(cmd: DebugAppServerCommand) -> anyhow::Result<()>
```

**Purpose**: Executes app-server-specific debug tooling, currently a single send-message-v2 helper.

**Data flow**: Matches the nested debug subcommand, obtains the current executable path with `current_exe`, and passes that binary path plus the user message into `codex_app_server_test_client::send_message_v2`. Returns the async result directly.

**Call relations**: Reached from the `debug app-server` branch in `cli_main`; it isolates this internal tooling from the already-large dispatcher.

*Call graph*: called by 1 (cli_main); 2 external calls (send_message_v2, current_exe).


##### `FeatureToggles::to_overrides`  (lines 901–912)

```
fn to_overrides(&self) -> anyhow::Result<Vec<String>>
```

**Purpose**: Converts repeated `--enable` and `--disable` feature flags into canonical raw config override strings.

**Data flow**: Iterates over `self.enable` and `self.disable`, validates each feature key with `validate_feature`, and appends strings like `features.<name>=true` or `features.<name>=false` into a new `Vec<String>`. Returns the vector or the first validation error.

**Call relations**: Called early in `cli_main` so feature toggles become ordinary config overrides inherited by all relevant subcommands; tests verify accepted legacy/removed keys and rejection of unknown names.

*Call graph*: 3 external calls (validate_feature, new, format!).


##### `FeatureToggles::validate_feature`  (lines 914–920)

```
fn validate_feature(feature: &str) -> anyhow::Result<()>
```

**Purpose**: Rejects unknown feature keys before they are turned into config overrides or persisted to config.

**Data flow**: Reads a feature name string, checks `is_known_feature_key`, returns `Ok(())` for known keys, and otherwise returns an `anyhow` error naming the unknown flag.

**Call relations**: Used by `FeatureToggles::to_overrides` and by the explicit feature enable/disable config-edit commands to ensure both transient and persistent feature changes share the same validation.

*Call graph*: called by 2 (disable_feature_in_config, enable_feature_in_config); 2 external calls (bail!, is_known_feature_key).


##### `stage_str`  (lines 945–953)

```
fn stage_str(stage: Stage) -> &'static str
```

**Purpose**: Maps a `codex_features::Stage` enum to the lowercase human label shown by `codex features list`.

**Data flow**: Consumes a `Stage` value and returns a static string such as `under development`, `experimental`, `stable`, `deprecated`, or `removed`.

**Call relations**: Used only in the features-list branch of `cli_main` while formatting the feature table.

*Call graph*: called by 1 (cli_main).


##### `main`  (lines 955–961)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Bootstraps the CLI process, captures one environment-derived remote-control flag, and enters async dispatch through arg0-aware startup.

**Data flow**: Reads and clears the app-server remote-control-disabled environment via `take_remote_control_disabled_env`, then passes an async closure into `arg0_dispatch_or_else`. That closure receives `Arg0DispatchPaths` and forwards both values into `cli_main`.

**Call relations**: This is the binary entrypoint. It exists mainly to bridge synchronous process startup into the async `cli_main` dispatcher while preserving arg0-derived helper paths.

*Call graph*: 2 external calls (take_remote_control_disabled_env, arg0_dispatch_or_else).


##### `cli_main`  (lines 963–1647)

```
async fn cli_main(
    arg0_paths: Arg0DispatchPaths,
    remote_control_disabled: bool,
) -> anyhow::Result<()>
```

**Purpose**: Parses the root CLI and dispatches every supported Codex command, applying shared validation and config/remote inheritance rules before invoking subsystem-specific runners.

**Data flow**: Parses `MultitoolCli`, converts feature toggles into raw overrides, extracts root remote and strict-config state, validates root `--strict-config` and `--profile`, then matches on `subcommand`. Depending on the branch it merges config overrides, rejects unsupported remote mode, rewrites review into an `ExecCli`, starts the interactive TUI, invokes login/logout helpers, runs app-server daemon/proxy/generation flows, launches sandbox commands, executes debug utilities, manages features, or starts exec-server registration/listeners. It prints outputs, forwards JSON where appropriate, and returns `anyhow::Result<()>`.

**Call relations**: Called only from `main`, but it is the hub for the entire CLI. Nearly every helper in this file exists to keep one branch of this dispatcher readable or to enforce a cross-cutting rule before delegating into another crate.

*Call graph*: calls 45 internal fn (run_apply_command, run_app, delete_action, disable_feature_in_config, run_doctor, enable_feature_in_config, finalize_fork_interactive, finalize_resume_interactive, handle_app_exit, loader_overrides_for_profile (+15 more)); 28 external calls (default, try_parse_from, with_capacity, bail!, clone, parse, Review, app_server_control_socket_path, run_main_with_transport_options, bootstrap (+15 more)).


##### `profile_v2_for_subcommand`  (lines 1649–1674)

```
fn profile_v2_for_subcommand(
    interactive: &'a TuiCli,
    subcommand: &Subcommand,
) -> anyhow::Result<Option<&'a ProfileV2Name>>
```

**Purpose**: Determines whether a root `--profile` selection is legal for the chosen subcommand and returns it only for runtime-oriented commands.

**Data flow**: Reads `interactive.config_profile_v2`; if absent, returns `Ok(None)`. If present, matches the selected `Subcommand` and returns `Ok(Some(profile))` only for interactive/runtime commands like exec, review, resume/fork/archive variants, mcp, sandbox, and debug prompt-input; otherwise it returns a detailed error listing supported commands.

**Call relations**: Called by `cli_main` after parsing and by a test helper. It prevents config-management commands from silently accepting a profile that they do not honor.

*Call graph*: called by 2 (cli_main, profile_v2_for_args); 1 external calls (bail!).


##### `run_exec_server_command`  (lines 1676–1723)

```
async fn run_exec_server_command(
    cmd: ExecServerCommand,
    arg0_paths: &Arg0DispatchPaths,
    root_config_overrides: &CliConfigOverrides,
    strict_config: bool,
) -> anyhow::Result<()>
```

**Purpose**: Starts the standalone exec-server either as a local listener or as a remotely registered environment, with optional strict-config validation.

**Data flow**: Consumes `ExecServerCommand`, arg0-derived executable paths, root config overrides, and a strict-config flag. It requires `codex_self_exe`, builds `ExecServerRuntimePaths`, then branches: with `--remote`, it requires `--environment-id`, loads config, derives an auth provider, builds `RemoteEnvironmentConfig`, optionally sets a human-readable name, and runs remote registration; without `--remote`, it optionally validates config in strict mode, chooses a listen URL default, and runs the local exec-server main loop.

**Call relations**: Invoked from the `exec-server` branch in `cli_main`. It delegates config loading and auth-provider selection to dedicated helpers so the branch can support both local and remote modes cleanly.

*Call graph*: calls 4 internal fn (load_exec_server_config, load_exec_server_remote_auth_provider, new, new); called by 1 (cli_main); 2 external calls (run_main, run_remote_environment).


##### `load_exec_server_remote_auth_provider`  (lines 1725–1757)

```
async fn load_exec_server_remote_auth_provider(
    config: &codex_core::config::Config,
    base_url: &str,
    use_agent_identity_auth: bool,
) -> anyhow::Result<codex_api::SharedAuthProvider>
```

**Purpose**: Chooses and validates the authentication mechanism used when registering an exec-server against a remote base URL.

**Data flow**: Reads the loaded config, target base URL, and `use_agent_identity_auth` flag. If agent identity is requested, it requires `CODEX_ACCESS_TOKEN`, converts it into `CodexAuth` using the configured ChatGPT base URL, and returns a shared auth provider. Otherwise it loads normal CLI auth, rejects unsupported auth kinds, validates API-key destinations with `validate_api_key_remote_host`, and converts the accepted auth into a provider.

**Call relations**: Called only by `run_exec_server_command` in remote-registration mode. It encapsulates the nuanced policy that ChatGPT auth and API-key auth are allowed by default, while Agent Identity requires an explicit flag.

*Call graph*: calls 4 internal fn (is_supported_exec_server_remote_auth, load_exec_server_remote_auth, validate_api_key_remote_host, from_agent_identity_jwt); called by 1 (run_exec_server_command); 3 external calls (bail!, read_codex_access_token_from_env, auth_provider_from_auth).


##### `is_supported_exec_server_remote_auth`  (lines 1759–1761)

```
fn is_supported_exec_server_remote_auth(auth: &CodexAuth) -> bool
```

**Purpose**: Defines which `CodexAuth` variants are acceptable for remote exec-server registration without the explicit agent-identity flag.

**Data flow**: Reads a `CodexAuth` reference and returns `true` only if it reports ChatGPT auth or API-key auth.

**Call relations**: Used by `load_exec_server_remote_auth_provider` as a small policy predicate; tests cover the API-key acceptance path.

*Call graph*: calls 2 internal fn (is_api_key_auth, is_chatgpt_auth); called by 1 (load_exec_server_remote_auth_provider).


##### `validate_api_key_remote_host`  (lines 1763–1795)

```
fn validate_api_key_remote_host(base_url: &str) -> anyhow::Result<()>
```

**Purpose**: Restricts API-key-based remote exec-server registration to trusted HTTPS OpenAI hosts or loopback hosts.

**Data flow**: Parses the base URL, extracts the host, classifies it as loopback or an `openai.com`/`openai.org` domain or subdomain, then checks the scheme: HTTPS is allowed for loopback and OpenAI hosts, HTTP only for loopback, everything else rejected. Returns `Ok(())` or a fixed policy error.

**Call relations**: Called from `load_exec_server_remote_auth_provider` only when the chosen auth is API-key based. Multiple tests pin the accepted and rejected host patterns, including suffix-spoof protection.

*Call graph*: called by 3 (load_exec_server_remote_auth_provider, exec_server_remote_api_key_auth_rejects_http_openai_domain, exec_server_remote_api_key_auth_rejects_suffix_spoof); 2 external calls (bail!, parse).


##### `load_exec_server_config`  (lines 1797–1809)

```
async fn load_exec_server_config(
    root_config_overrides: &CliConfigOverrides,
    strict_config: bool,
) -> anyhow::Result<codex_core::config::Config>
```

**Purpose**: Loads the standard Codex config with root CLI overrides and optional strict-config enforcement for exec-server flows.

**Data flow**: Parses raw CLI overrides from `CliConfigOverrides`, feeds them into `ConfigBuilder`, sets `strict_config`, awaits `build`, and returns the resulting `codex_core::config::Config`.

**Call relations**: Used by `run_exec_server_command` both for remote registration and for local strict-config validation before opening a listener.

*Call graph*: calls 1 internal fn (parse_overrides); called by 1 (run_exec_server_command); 1 external calls (default).


##### `load_exec_server_remote_auth`  (lines 1811–1830)

```
async fn load_exec_server_remote_auth(
    config: &codex_core::config::Config,
    missing_auth_error: &'static str,
) -> anyhow::Result<codex_login::CodexAuth>
```

**Purpose**: Fetches the current CLI authentication state for remote exec-server registration, retrying after an auth-manager reload if necessary.

**Data flow**: Builds a shared `AuthManager` from config with Codex API key env support enabled, asks for current auth, and if absent triggers `reload` and checks again. Returns the discovered `CodexAuth` or the supplied missing-auth error.

**Call relations**: Called by `load_exec_server_remote_auth_provider` for the non-agent-identity path so auth lookup and reload behavior stay centralized.

*Call graph*: calls 1 internal fn (shared_from_config); called by 1 (load_exec_server_remote_auth_provider).


##### `enable_feature_in_config`  (lines 1832–1842)

```
async fn enable_feature_in_config(feature: &str) -> anyhow::Result<()>
```

**Purpose**: Persists a feature flag as enabled in `config.toml` and warns if the feature is still under development.

**Data flow**: Validates the feature key, resolves `CODEX_HOME`, builds a `ConfigEditsBuilder`, sets the feature enabled, applies the edit asynchronously, prints a success message, and then calls `maybe_print_under_development_feature_warning`.

**Call relations**: Reached from `cli_main` for `codex features enable`; it shares validation with transient feature toggles but performs a persistent config edit.

*Call graph*: calls 4 internal fn (validate_feature, maybe_print_under_development_feature_warning, new, find_codex_home); called by 1 (cli_main); 1 external calls (println!).


##### `disable_feature_in_config`  (lines 1844–1853)

```
async fn disable_feature_in_config(feature: &str) -> anyhow::Result<()>
```

**Purpose**: Persists a feature flag as disabled in `config.toml`.

**Data flow**: Validates the feature key, resolves `CODEX_HOME`, applies a config edit setting the feature to false, and prints a confirmation message.

**Call relations**: Reached from `cli_main` for `codex features disable`; unlike enable, it does not emit any stage-specific warning.

*Call graph*: calls 3 internal fn (validate_feature, new, find_codex_home); called by 1 (cli_main); 1 external calls (println!).


##### `loader_overrides_for_profile`  (lines 1855–1869)

```
fn loader_overrides_for_profile(
    profile_v2: Option<&ProfileV2Name>,
) -> anyhow::Result<LoaderOverrides>
```

**Purpose**: Builds `LoaderOverrides` that redirect config loading to a named profile-specific config file when `--profile` is active.

**Data flow**: If a `ProfileV2Name` is provided, it resolves `CODEX_HOME`, computes the profile config path with `resolve_profile_v2_config_path`, and returns `LoaderOverrides` with both `user_config_path` and `user_config_profile` set. Otherwise it returns the default overrides.

**Call relations**: Used by `cli_main` for MCP and sandbox profile-aware flows and by `run_debug_prompt_input_command` so debug prompt rendering sees the same profile-specific config.

*Call graph*: calls 2 internal fn (find_codex_home, resolve_profile_v2_config_path); called by 2 (cli_main, run_debug_prompt_input_command); 2 external calls (default, default).


##### `maybe_print_under_development_feature_warning`  (lines 1871–1884)

```
fn maybe_print_under_development_feature_warning(codex_home: &std::path::Path, feature: &str)
```

**Purpose**: Emits a stderr warning when a persisted feature belongs to the `UnderDevelopment` stage.

**Data flow**: Looks up the feature spec in the global `FEATURES` table, returns early if missing or not under development, computes the config path under `codex_home`, and prints a warning explaining how to suppress unstable-feature warnings.

**Call relations**: Called only after successful `enable_feature_in_config`; it keeps the warning policy separate from the config-edit logic.

*Call graph*: called by 1 (enable_feature_in_config); 3 external calls (join, eprintln!, matches!).


##### `run_debug_trace_reduce_command`  (lines 1886–1897)

```
async fn run_debug_trace_reduce_command(cmd: DebugTraceReduceCommand) -> anyhow::Result<()>
```

**Purpose**: Replays a rollout trace bundle and writes the reduced state JSON to disk.

**Data flow**: Chooses the output path from `--output` or `<trace_bundle>/state.json`, loads the trace via `replay_bundle`, serializes it with pretty JSON, writes it asynchronously with `tokio::fs::write`, and prints the output path.

**Call relations**: Dispatched from `cli_main` for the hidden `debug trace-reduce` command.

*Call graph*: called by 1 (cli_main); 4 external calls (replay_bundle, println!, to_vec_pretty, write).


##### `run_debug_prompt_input_command`  (lines 1899–1974)

```
async fn run_debug_prompt_input_command(
    cmd: DebugPromptInputCommand,
    root_config_overrides: CliConfigOverrides,
    interactive: TuiCli,
    arg0_paths: Arg0DispatchPaths,
) -> anyhow::Resul
```

**Purpose**: Constructs and prints the exact prompt-input payload that Codex would send to the model for an interactive session.

**Data flow**: Takes debug args, root overrides, parsed interactive CLI state, and arg0 paths. It derives profile loader overrides, parses CLI key/value overrides, injects `web_search=live` when requested, computes approval and sandbox overrides including the dangerous bypass shortcut, builds `ConfigOverrides` with model/cwd/executable/image/trust settings and `ephemeral=true`, loads the full config, assembles `UserInput` items from root and debug images plus normalized prompt text, creates a `CodexHomeUserInstructionsProvider`, calls `codex_core::build_prompt_input`, and prints pretty JSON.

**Call relations**: Reached from `cli_main` for `debug prompt-input`. It is one of the most concrete debug helpers in the file because it mirrors the real runtime config and input assembly path.

*Call graph*: calls 3 internal fn (loader_overrides_for_profile, new, parse_overrides); called by 1 (cli_main); 7 external calls (new, default, new, build_prompt_input, default, println!, String).


##### `run_debug_models_command`  (lines 1976–2001)

```
async fn run_debug_models_command(
    cmd: DebugModelsCommand,
    root_config_overrides: CliConfigOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Prints the raw model catalog either from the bundled binary payload or from the live/refreshed models manager.

**Data flow**: If `--bundled` is set, it loads the bundled catalog directly. Otherwise it parses CLI overrides, builds config, creates an auth manager and models manager, fetches the raw catalog with `RefreshStrategy::OnlineIfUncached`, writes JSON to stdout, and appends a newline.

**Call relations**: Called from `cli_main` for `debug models`; it delegates live catalog retrieval to the shared models-manager stack.

*Call graph*: calls 2 internal fn (shared_from_config, parse_overrides); called by 1 (cli_main); 6 external calls (build_models_manager, bundled_models_response, default, println!, to_writer, stdout).


##### `run_debug_clear_memories_command`  (lines 2003–2033)

```
async fn run_debug_clear_memories_command(
    root_config_overrides: &CliConfigOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Deletes persisted memory state from both the SQLite memories database and memory-root directories under Codex home.

**Data flow**: Parses root CLI overrides, loads config, computes the memories DB path, calls `StateRuntime::clear_memory_data_in_sqlite_home`, clears memory-root directory contents via `clear_memory_roots_contents`, builds a message indicating whether the DB existed, appends the cleared directory location, and prints it.

**Call relations**: Dispatched from `cli_main` for the hidden `debug clear-memories` command.

*Call graph*: calls 2 internal fn (clear_memory_data_in_sqlite_home, parse_overrides); called by 1 (cli_main); 5 external calls (clear_memory_roots_contents, memories_db_path, default, format!, println!).


##### `prepend_config_flags`  (lines 2037–2042)

```
fn prepend_config_flags(
    subcommand_config_overrides: &mut CliConfigOverrides,
    cli_config_overrides: CliConfigOverrides,
)
```

**Purpose**: Merges root-level config overrides into a subcommand’s override list with lower precedence than subcommand-local overrides.

**Data flow**: Mutably borrows a subcommand `CliConfigOverrides` and consumes the root overrides, then calls `prepend_root_overrides` so root flags appear earlier in the raw override sequence.

**Call relations**: Used throughout `cli_main` and by the resume/fork/archive finalizers to preserve the intended precedence rule between root and subcommand `-c key=value` flags.

*Call graph*: calls 1 internal fn (prepend_root_overrides); called by 4 (cli_main, finalize_fork_interactive, finalize_resume_interactive, finalize_session_archive_interactive).


##### `reject_remote_mode_for_subcommand`  (lines 2044–2060)

```
fn reject_remote_mode_for_subcommand(
    remote: Option<&str>,
    remote_auth_token_env: Option<&str>,
    subcommand: &str,
) -> anyhow::Result<()>
```

**Purpose**: Rejects root `--remote` and `--remote-auth-token-env` when the selected command is not an interactive TUI flow.

**Data flow**: Reads optional remote endpoint and auth-token-env strings plus a user-facing subcommand name. If either remote option is present, it returns an error explaining that remote mode is only supported for interactive TUI commands; otherwise it returns success.

**Call relations**: Called by many `cli_main` branches and by the app-server-specific wrapper. It is the main enforcement point preventing accidental remote-mode leakage into non-interactive commands.

*Call graph*: called by 5 (cli_main, reject_remote_mode_for_app_server_subcommand, reject_remote_auth_token_env_for_non_interactive_subcommands, reject_remote_flag_for_remote_control, reject_remote_mode_for_non_interactive_subcommands); 1 external calls (bail!).


##### `reject_root_strict_config_for_subcommand`  (lines 2062–2076)

```
fn reject_root_strict_config_for_subcommand(
    strict_config: bool,
    subcommand: &Option<Subcommand>,
) -> anyhow::Result<()>
```

**Purpose**: Post-parse validator that rejects root-level `--strict-config` for subcommands that do not support inheriting it.

**Data flow**: If `strict_config` is false it returns immediately. Otherwise it asks `unsupported_subcommand_name_for_strict_config` for a user-facing command name and, when present, forwards to `reject_strict_config_for_unsupported_subcommand`.

**Call relations**: Called near the top of `cli_main` after clap parsing, because clap accepts the root flag before the dispatcher knows which subcommand was chosen.

*Call graph*: calls 2 internal fn (reject_strict_config_for_unsupported_subcommand, unsupported_subcommand_name_for_strict_config); called by 3 (cli_main, root_strict_config_is_rejected_for_unsupported_subcommands, root_strict_config_is_supported_for_exec_server).


##### `unsupported_subcommand_name_for_strict_config`  (lines 2090–2127)

```
fn unsupported_subcommand_name_for_strict_config(
    subcommand: &Option<Subcommand>,
) -> Option<&'static str>
```

**Purpose**: Maps a parsed root subcommand to the user-facing command name fragment that should be rejected for inherited root `--strict-config`.

**Data flow**: Matches the optional `Subcommand` and returns `None` for allowed commands such as interactive root, exec, review, mcp-server, exec-server, resume/archive/fork variants, doctor, and bare app-server; otherwise returns strings like `mcp`, `remote-control`, or an app-server subcommand name via `app_server_subcommand_name`.

**Call relations**: Used only by `reject_root_strict_config_for_subcommand`; it centralizes the allowlist/denylist policy in one match.

*Call graph*: calls 1 internal fn (app_server_subcommand_name); called by 1 (reject_root_strict_config_for_subcommand).


##### `reject_strict_config_for_app_server_subcommand`  (lines 2129–2140)

```
fn reject_strict_config_for_app_server_subcommand(
    strict_config: bool,
    subcommand: Option<&AppServerSubcommand>,
) -> anyhow::Result<()>
```

**Purpose**: Rejects `--strict-config` for app-server tooling subcommands while allowing it for the main app-server runtime command.

**Data flow**: If no app-server subcommand is selected, returns success. Otherwise computes the user-facing name with `app_server_subcommand_name` and forwards to `reject_strict_config_for_unsupported_subcommand`.

**Call relations**: Called from the app-server branch in `cli_main` and by tests that verify proxy/version/generation commands reject strict-config.

*Call graph*: calls 2 internal fn (app_server_subcommand_name, reject_strict_config_for_unsupported_subcommand); called by 2 (cli_main, app_server_subcommands_reject_strict_config).


##### `reject_strict_config_for_unsupported_subcommand`  (lines 2142–2150)

```
fn reject_strict_config_for_unsupported_subcommand(
    strict_config: bool,
    subcommand: &str,
) -> anyhow::Result<()>
```

**Purpose**: Produces the standardized error message for commands that do not support `--strict-config`.

**Data flow**: Reads the boolean flag and subcommand name; if strict mode is enabled it returns an `anyhow` error of the form `` `--strict-config` is not supported for `codex ...` ``, otherwise returns success.

**Call relations**: Shared by root-level and app-server-specific strict-config validators.

*Call graph*: called by 2 (reject_root_strict_config_for_subcommand, reject_strict_config_for_app_server_subcommand); 1 external calls (bail!).


##### `reject_remote_mode_for_app_server_subcommand`  (lines 2152–2159)

```
fn reject_remote_mode_for_app_server_subcommand(
    remote: Option<&str>,
    remote_auth_token_env: Option<&str>,
    subcommand: Option<&AppServerSubcommand>,
) -> anyhow::Result<()>
```

**Purpose**: Applies the generic remote-mode rejection logic to app-server subcommands using app-server-specific command names.

**Data flow**: Computes the subcommand name with `app_server_subcommand_name` and forwards the remote endpoint/auth-token-env values into `reject_remote_mode_for_subcommand`.

**Call relations**: Used in the app-server branch of `cli_main` and by tests for proxy/version/internal-schema cases.

*Call graph*: calls 2 internal fn (app_server_subcommand_name, reject_remote_mode_for_subcommand); called by 4 (cli_main, reject_remote_auth_token_env_for_app_server_generate_internal_json_schema, reject_remote_auth_token_env_for_app_server_proxy, reject_remote_auth_token_env_for_app_server_version).


##### `app_server_subcommand_name`  (lines 2161–2185)

```
fn app_server_subcommand_name(subcommand: Option<&AppServerSubcommand>) -> &'static str
```

**Purpose**: Converts an optional `AppServerSubcommand` into the exact user-facing command name fragment used in validation errors.

**Data flow**: Matches the optional app-server subcommand and nested daemon subcommand, returning strings such as `app-server`, `app-server daemon start`, `app-server proxy`, or `app-server generate-json-schema`.

**Call relations**: Used by strict-config and remote-mode validators and by the root strict-config allowlist helper.

*Call graph*: called by 3 (reject_remote_mode_for_app_server_subcommand, reject_strict_config_for_app_server_subcommand, unsupported_subcommand_name_for_strict_config).


##### `print_app_server_daemon_output`  (lines 2187–2191)

```
async fn print_app_server_daemon_output(command: AppServerLifecycleCommand) -> anyhow::Result<()>
```

**Purpose**: Runs an app-server daemon lifecycle command and prints its JSON result.

**Data flow**: Consumes an `AppServerLifecycleCommand`, awaits `codex_app_server_daemon::run`, serializes the output to JSON, prints it, and returns success.

**Call relations**: Called from several app-server daemon branches in `cli_main` for start/restart/stop/version.

*Call graph*: called by 1 (cli_main); 2 external calls (run, println!).


##### `print_app_server_remote_control_output`  (lines 2193–2199)

```
async fn print_app_server_remote_control_output(
    mode: AppServerRemoteControlMode,
) -> anyhow::Result<()>
```

**Purpose**: Sets the daemon’s persisted remote-control mode and prints the resulting JSON payload.

**Data flow**: Consumes an `AppServerRemoteControlMode`, awaits `codex_app_server_daemon::set_remote_control`, serializes the output to JSON, prints it, and returns success.

**Call relations**: Used by the app-server daemon enable/disable remote-control branches in `cli_main`.

*Call graph*: called by 1 (cli_main); 2 external calls (set_remote_control, println!).


##### `read_remote_auth_token_from_env_var_with`  (lines 2201–2215)

```
fn read_remote_auth_token_from_env_var_with(
    env_var_name: &str,
    get_var: F,
) -> anyhow::Result<String>
```

**Purpose**: Reads, trims, and validates a bearer token from a named environment variable using an injectable getter.

**Data flow**: Takes an env-var name and a closure `get_var`, calls the closure, converts missing variables into a descriptive error, trims whitespace from the value, rejects empty results, and returns the cleaned token string.

**Call relations**: Used by the real env reader and by tests that inject fake environment lookups to verify missing/empty/trimmed behavior.

*Call graph*: called by 4 (read_remote_auth_token_from_env_var, read_remote_auth_token_from_env_var_rejects_empty_values, read_remote_auth_token_from_env_var_reports_missing_values, read_remote_auth_token_from_env_var_trims_values); 1 external calls (bail!).


##### `read_remote_auth_token_from_env_var`  (lines 2217–2219)

```
fn read_remote_auth_token_from_env_var(env_var_name: &str) -> anyhow::Result<String>
```

**Purpose**: Reads a remote auth token from the real process environment.

**Data flow**: Passes the env-var name into `read_remote_auth_token_from_env_var_with` with `std::env::var` as the getter and returns the validated token.

**Call relations**: Called by `resolve_remote_endpoint` when `--remote-auth-token-env` is supplied.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var_with); called by 1 (resolve_remote_endpoint).


##### `run_interactive_tui`  (lines 2221–2298)

```
async fn run_interactive_tui(
    mut interactive: TuiCli,
    remote: Option<String>,
    remote_auth_token_env: Option<String>,
    arg0_paths: Arg0DispatchPaths,
) -> std::io::Result<AppExitInfo>
```

**Purpose**: Starts the interactive TUI, handling prompt normalization, terminal suitability checks, remote endpoint resolution, and automatic local-state database recovery on startup failures.

**Data flow**: Mutably takes `TuiCli`, optional remote endpoint/auth-token-env strings, and arg0 paths. It normalizes prompt newlines, inspects terminal info and may warn or refuse startup for `TERM=dumb`, resolves the remote endpoint with `resolve_remote_endpoint`, then repeatedly calls `codex_tui::run_main`. On success it returns `AppExitInfo`. On error it checks whether the error wraps `LocalStateDbStartupError`; lock errors print guidance and return a fatal exit, unrecoverable corruption prints diagnostics and returns fatal, and recoverable corruption/blocking-file cases trigger one backup attempt per database path via `state_db_recovery`, prompt/continue messaging, and then retry startup.

**Call relations**: Called by `cli_main` for the root interactive mode and for resume/fork flows. It is the only place in this file that loops around TUI startup to recover from local database damage.

*Call graph*: calls 4 internal fn (confirm, is_remote_auth_usage_error, resolve_remote_endpoint, fatal); called by 1 (cli_main); 14 external calls (new, terminal_info, eprintln!, format!, backup_files_for_fresh_start, confirm_fresh_start_rebuild, is_auto_backup_recoverable, is_locked, print_auto_backup_start, print_diagnostic_guidance (+4 more)).


##### `resolve_remote_endpoint`  (lines 2300–2333)

```
fn resolve_remote_endpoint(
    remote: Option<String>,
    remote_auth_token_env: Option<String>,
) -> std::io::Result<Option<codex_tui::RemoteAppServerEndpoint>>
```

**Purpose**: Parses the interactive `--remote` address and optionally injects a bearer token loaded from an environment variable.

**Data flow**: Starts from optional remote and auth-token-env strings. It parses the remote address through `codex_tui::resolve_remote_addr`, then if an auth env var is present it requires that a remote endpoint exists and that it supports auth tokens (`wss://` or loopback `ws://`), reads the token with `read_remote_auth_token_from_env_var`, and stores it into the websocket endpoint’s `auth_token` slot. Returns `Option<RemoteAppServerEndpoint>` wrapped in `std::io::Result`.

**Call relations**: Used by `run_interactive_tui` and `run_session_archive_cli_command`. `run_interactive_tui` additionally classifies some of its errors with `is_remote_auth_usage_error` to turn them into fatal app exits instead of raw I/O failures.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var); called by 2 (run_interactive_tui, run_session_archive_cli_command); 2 external calls (other, remote_addr_supports_auth_token).


##### `is_remote_auth_usage_error`  (lines 2335–2338)

```
fn is_remote_auth_usage_error(err: &std::io::Error) -> bool
```

**Purpose**: Recognizes the specific usage-error strings produced when `--remote-auth-token-env` is misused.

**Data flow**: Converts a `std::io::Error` to string and returns true when it starts with `` `--remote-auth-token-env` requires ``.

**Call relations**: Called only by `run_interactive_tui` so those user mistakes become fatal TUI exit info rather than bubbling as generic I/O errors.

*Call graph*: called by 1 (run_interactive_tui); 1 external calls (to_string).


##### `confirm`  (lines 2340–2347)

```
fn confirm(prompt: &str) -> std::io::Result<bool>
```

**Purpose**: Prompts on stderr and reads a yes/no answer from stdin.

**Data flow**: Prints the prompt to stderr, reads one line from stdin into a `String`, trims it, and returns `true` only for case-insensitive `y` or `yes`.

**Call relations**: Used by `run_interactive_tui` for the `TERM=dumb` confirmation path.

*Call graph*: called by 1 (run_interactive_tui); 3 external calls (new, eprintln!, stdin).


##### `finalize_resume_interactive`  (lines 2350–2382)

```
fn finalize_resume_interactive(
    mut interactive: TuiCli,
    root_config_overrides: CliConfigOverrides,
    session_id: Option<String>,
    last: bool,
    show_all: bool,
    include_non_interact
```

**Purpose**: Builds the final `TuiCli` state for `codex resume`, including picker/last/session-id semantics and scoped flag precedence.

**Data flow**: Takes the root interactive CLI, root config overrides, parsed `session_id`, `last`, `show_all`, `include_non_interactive`, and a resume-scoped `TuiCli`. If `--last` is set and the scoped prompt is absent, it reinterprets the positional `session_id` as the prompt. It then sets resume-specific fields (`resume_picker`, `resume_last`, `resume_session_id`, `resume_show_all`, `resume_include_non_interactive`), merges scoped flags via `merge_interactive_cli_flags`, prepends root config overrides, and returns the mutated `TuiCli`.

**Call relations**: Called by `cli_main` for the resume branch and by tests that verify positional reinterpretation and precedence behavior.

*Call graph*: calls 2 internal fn (merge_interactive_cli_flags, prepend_config_flags); called by 2 (cli_main, finalize_resume_from_args).


##### `finalize_fork_interactive`  (lines 2385–2415)

```
fn finalize_fork_interactive(
    mut interactive: TuiCli,
    root_config_overrides: CliConfigOverrides,
    session_id: Option<String>,
    last: bool,
    show_all: bool,
    mut fork_cli: TuiCli,
```

**Purpose**: Builds the final `TuiCli` state for `codex fork`, mirroring resume’s positional and precedence rules but setting fork-specific fields.

**Data flow**: Takes root interactive state, root overrides, parsed `session_id`, `last`, `show_all`, and a fork-scoped `TuiCli`. It reinterprets the positional as prompt when `--last` is used without an explicit prompt, sets `fork_picker`, `fork_last`, `fork_session_id`, and `fork_show_all`, merges scoped flags, prepends root overrides, and returns the final `TuiCli`.

**Call relations**: Called by `cli_main` for the fork branch and by tests that mirror the resume parsing cases.

*Call graph*: calls 2 internal fn (merge_interactive_cli_flags, prepend_config_flags); called by 2 (cli_main, finalize_fork_from_args).


##### `finalize_session_archive_interactive`  (lines 2417–2437)

```
fn finalize_session_archive_interactive(
    mut interactive: TuiCli,
    root_config_overrides: CliConfigOverrides,
    archive_cli: SessionArchiveConfigOverrides,
) -> TuiCli
```

**Purpose**: Applies archive/delete/unarchive-scoped interactive flags and config overrides on top of the root interactive CLI.

**Data flow**: Consumes the root `TuiCli`, root config overrides, and `SessionArchiveConfigOverrides`. It applies shared subcommand overrides into `interactive.shared`, promotes `strict_config` if requested, appends archive-scoped raw config overrides, prepends root overrides for lower precedence, and returns the merged `TuiCli`.

**Call relations**: Used by `run_session_archive_cli_command` and test helpers for archive parsing.

*Call graph*: calls 1 internal fn (prepend_config_flags); called by 2 (run_session_archive_cli_command, finalize_archive_from_args).


##### `merge_interactive_cli_flags`  (lines 2442–2473)

```
fn merge_interactive_cli_flags(interactive: &mut TuiCli, subcommand_cli: TuiCli)
```

**Purpose**: Merges only explicitly set runtime-wrapper flags from a subcommand-scoped `TuiCli` into the root interactive CLI, preserving subcommand precedence.

**Data flow**: Destructures the scoped `TuiCli`, applies shared options into `interactive.shared`, overwrites approval policy, web search, strict-config, and prompt only when explicitly set, normalizes prompt newlines, and appends scoped raw config overrides to the root list.

**Call relations**: Called by both `finalize_resume_interactive` and `finalize_fork_interactive` so those wrappers share identical precedence and normalization behavior.

*Call graph*: called by 2 (finalize_fork_interactive, finalize_resume_interactive).


##### `print_completion`  (lines 2475–2479)

```
fn print_completion(cmd: CompletionCommand)
```

**Purpose**: Generates shell completion scripts for the selected shell using the root CLI definition.

**Data flow**: Builds a clap `Command` from `MultitoolCli::command`, fixes the binary name to `codex`, and streams generated completions for the requested `Shell` to stdout.

**Call relations**: Called from the `completion` branch in `cli_main`.

*Call graph*: called by 1 (cli_main); 3 external calls (generate, command, stdout).


##### `tests::exec_server_remote_auth_accepts_api_key_auth`  (lines 2490–2494)

```
fn exec_server_remote_auth_accepts_api_key_auth()
```

**Purpose**: Verifies that API-key authentication is considered valid for remote exec-server registration.

**Data flow**: Constructs a `CodexAuth` from a fake API key, passes it to `is_supported_exec_server_remote_auth`, and asserts the predicate is true.

**Call relations**: Unit test for the auth-policy helper used by `load_exec_server_remote_auth_provider`.

*Call graph*: calls 1 internal fn (from_api_key); 1 external calls (assert!).


##### `tests::exec_server_remote_api_key_auth_accepts_https_openai_domains`  (lines 2497–2506)

```
fn exec_server_remote_api_key_auth_accepts_https_openai_domains()
```

**Purpose**: Checks that HTTPS OpenAI domains and subdomains pass API-key remote-host validation.

**Data flow**: Iterates over several `https://openai.com` and `https://openai.org` URLs, calls `validate_api_key_remote_host`, and asserts success for each.

**Call relations**: Tests the allowlist branch of `validate_api_key_remote_host`.

*Call graph*: 1 external calls (assert!).


##### `tests::exec_server_remote_api_key_auth_accepts_http_loopback`  (lines 2509–2517)

```
fn exec_server_remote_api_key_auth_accepts_http_loopback()
```

**Purpose**: Checks that plaintext HTTP is accepted only for loopback remote exec-server registration targets.

**Data flow**: Feeds localhost, IPv4 loopback, and IPv6 loopback URLs into `validate_api_key_remote_host` and asserts they succeed.

**Call relations**: Covers the loopback exception in `validate_api_key_remote_host`.

*Call graph*: 1 external calls (assert!).


##### `tests::exec_server_remote_api_key_auth_rejects_http_openai_domain`  (lines 2520–2533)

```
fn exec_server_remote_api_key_auth_rejects_http_openai_domain()
```

**Purpose**: Ensures OpenAI domains over HTTP are rejected for API-key remote registration.

**Data flow**: Calls `validate_api_key_remote_host` with HTTP OpenAI URLs, captures the error, and asserts the exact policy message.

**Call relations**: Tests the scheme restriction branch of `validate_api_key_remote_host`.

*Call graph*: calls 1 internal fn (validate_api_key_remote_host); 1 external calls (assert_eq!).


##### `tests::exec_server_remote_api_key_auth_rejects_suffix_spoof`  (lines 2536–2544)

```
fn exec_server_remote_api_key_auth_rejects_suffix_spoof()
```

**Purpose**: Ensures suffix-spoofed domains like `openai.org.evil.example` are rejected.

**Data flow**: Validates a spoofed HTTPS URL, expects an error, and asserts the exact rejection message.

**Call relations**: Covers the hostname matching logic in `validate_api_key_remote_host`.

*Call graph*: calls 1 internal fn (validate_api_key_remote_host); 1 external calls (assert_eq!).


##### `tests::finalize_resume_from_args`  (lines 2546–2578)

```
fn finalize_resume_from_args(args: &[&str]) -> TuiCli
```

**Purpose**: Helper that parses a full CLI argv vector and returns the finalized `TuiCli` for a resume command.

**Data flow**: Parses `MultitoolCli`, extracts root interactive state and the `ResumeCommand`, unwraps `SessionTuiCli`, and passes the pieces into `finalize_resume_interactive`.

**Call relations**: Used by many resume-related tests to exercise real clap parsing plus the resume finalizer.

*Call graph*: calls 1 internal fn (finalize_resume_interactive); 2 external calls (try_parse_from, unreachable!).


##### `tests::finalize_fork_from_args`  (lines 2580–2603)

```
fn finalize_fork_from_args(args: &[&str]) -> TuiCli
```

**Purpose**: Helper that parses argv and returns the finalized `TuiCli` for a fork command.

**Data flow**: Parses `MultitoolCli`, extracts root interactive state and `ForkCommand`, unwraps `SessionTuiCli`, and calls `finalize_fork_interactive`.

**Call relations**: Shared by fork-related tests.

*Call graph*: calls 1 internal fn (finalize_fork_interactive); 2 external calls (try_parse_from, unreachable!).


##### `tests::finalize_archive_from_args`  (lines 2605–2629)

```
fn finalize_archive_from_args(args: &[&str]) -> (String, TuiCli, InteractiveRemoteOptions)
```

**Purpose**: Helper that parses argv and returns the archive target, merged interactive CLI, and archive-scoped remote options.

**Data flow**: Parses `MultitoolCli`, extracts the `Archive` subcommand payload, finalizes interactive state with `finalize_session_archive_interactive`, and returns a tuple of target string, merged `TuiCli`, and `InteractiveRemoteOptions`.

**Call relations**: Used by archive-merging tests.

*Call graph*: calls 1 internal fn (finalize_session_archive_interactive); 2 external calls (try_parse_from, unreachable!).


##### `tests::profile_v2_for_args`  (lines 2631–2641)

```
fn profile_v2_for_args(args: &[&str]) -> anyhow::Result<Option<String>>
```

**Purpose**: Helper that parses argv and asks whether the selected command accepts a profile-v2 name.

**Data flow**: Parses `MultitoolCli`, returns the root interactive profile when no subcommand is present, otherwise calls `profile_v2_for_subcommand` and maps the result to `Option<String>`.

**Call relations**: Used by tests covering profile acceptance and rejection.

*Call graph*: calls 1 internal fn (profile_v2_for_subcommand); 1 external calls (try_parse_from).


##### `tests::profile_v2_is_rejected_for_config_management_subcommands`  (lines 2644–2646)

```
fn profile_v2_is_rejected_for_config_management_subcommands()
```

**Purpose**: Verifies that config-management commands like `features list` reject root `--profile`.

**Data flow**: Calls the helper with `codex --profile work features list` and asserts the result is an error.

**Call relations**: Tests `profile_v2_for_subcommand`’s denylist.

*Call graph*: 1 external calls (assert!).


##### `tests::profile_v2_is_allowed_for_runtime_subcommands`  (lines 2649–2674)

```
fn profile_v2_is_allowed_for_runtime_subcommands()
```

**Purpose**: Verifies that runtime-oriented commands preserve the selected profile name.

**Data flow**: Runs the helper for `resume`, `debug prompt-input`, `mcp list`, and `sandbox`, then asserts each returns `Some("work")`.

**Call relations**: Tests the allowlist in `profile_v2_for_subcommand`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::import_remains_an_interactive_prompt`  (lines 2677–2682)

```
fn import_remains_an_interactive_prompt()
```

**Purpose**: Ensures a bare positional like `import` is treated as the interactive prompt rather than a subcommand.

**Data flow**: Parses `codex import`, asserts `subcommand` is `None`, and checks that `interactive.prompt` contains `import`.

**Call relations**: Protects the root parser shape in `MultitoolCli`.

*Call graph*: 3 external calls (assert!, assert_eq!, try_parse_from).


##### `tests::profile_v2_rejects_non_plain_names_at_parse_time`  (lines 2685–2689)

```
fn profile_v2_rejects_non_plain_names_at_parse_time()
```

**Purpose**: Checks that invalid profile names containing path separators fail during clap parsing.

**Data flow**: Attempts to parse `--profile nested/work` and asserts parsing fails.

**Call relations**: Covers validation performed by the profile argument type before `profile_v2_for_subcommand` runs.

*Call graph*: 1 external calls (assert!).


##### `tests::exec_resume_last_accepts_prompt_positional`  (lines 2692–2707)

```
fn exec_resume_last_accepts_prompt_positional()
```

**Purpose**: Verifies that `codex exec resume --last <prompt>` treats the positional as a prompt rather than a session id.

**Data flow**: Parses the exec command, extracts nested resume args, and asserts `last=true`, `session_id=None`, and `prompt=Some("2+2")`.

**Call relations**: Guards parsing behavior in the exec crate’s CLI integration as exposed through this root parser.

*Call graph*: 4 external calls (assert!, assert_eq!, try_parse_from, panic!).


##### `tests::exec_resume_accepts_output_flags_after_subcommand`  (lines 2710–2741)

```
fn exec_resume_accepts_output_flags_after_subcommand()
```

**Purpose**: Ensures exec resume accepts output-related flags after the nested subcommand and still parses session id and prompt correctly.

**Data flow**: Parses a command with `-o` and `--output-schema`, extracts the exec resume args, and asserts the output paths plus `session_id` and prompt values.

**Call relations**: Protects clap command nesting for the exec subcommand.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::dangerous_bypass_conflicts_with_approval_policy`  (lines 2744–2754)

```
fn dangerous_bypass_conflicts_with_approval_policy()
```

**Purpose**: Checks that the dangerous bypass flag conflicts with explicit approval-policy selection.

**Data flow**: Attempts to parse both flags together and asserts clap returns `ArgumentConflict`.

**Call relations**: Covers parser-level constraints inherited from `TuiCli`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::app_server_from_args`  (lines 2756–2762)

```
fn app_server_from_args(args: &[&str]) -> AppServerCommand
```

**Purpose**: Helper that parses argv and extracts the `AppServerCommand` payload.

**Data flow**: Parses `MultitoolCli`, unwraps the `AppServer` subcommand, and returns it.

**Call relations**: Used by many app-server parsing tests.

*Call graph*: 2 external calls (try_parse_from, unreachable!).


##### `tests::default_app_server_socket_path`  (lines 2764–2768)

```
fn default_app_server_socket_path() -> AbsolutePathBuf
```

**Purpose**: Helper that computes the default app-server control socket path from the current Codex home.

**Data flow**: Finds `CODEX_HOME`, calls `codex_app_server::app_server_control_socket_path`, and returns the resulting `AbsolutePathBuf`.

**Call relations**: Used by tests that compare parsed `unix://` listen URLs against the default socket path.

*Call graph*: calls 1 internal fn (find_codex_home); 1 external calls (app_server_control_socket_path).


##### `tests::debug_prompt_input_parses_prompt_and_images`  (lines 2771–2794)

```
fn debug_prompt_input_parses_prompt_and_images()
```

**Purpose**: Verifies parsing of the debug prompt-input command’s optional prompt and comma-delimited image list.

**Data flow**: Parses the command, extracts `DebugPromptInputCommand`, and asserts the prompt string and two `PathBuf` image entries.

**Call relations**: Covers clap parsing for `run_debug_prompt_input_command` inputs.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::debug_models_parses_bundled_flag`  (lines 2797–2809)

```
fn debug_models_parses_bundled_flag()
```

**Purpose**: Checks that `debug models --bundled` sets the expected boolean.

**Data flow**: Parses the command, extracts `DebugModelsCommand`, and asserts `bundled` is true.

**Call relations**: Covers clap parsing for `run_debug_models_command`.

*Call graph*: 3 external calls (assert!, try_parse_from, panic!).


##### `tests::responses_subcommand_is_not_registered`  (lines 2812–2819)

```
fn responses_subcommand_is_not_registered()
```

**Purpose**: Ensures an old or hidden `responses` subcommand name is absent from the root command table.

**Data flow**: Builds the root clap command and asserts none of its subcommands are named `responses`.

**Call relations**: Protects the public CLI namespace.

*Call graph*: 2 external calls (assert!, command).


##### `tests::help_from_args`  (lines 2821–2825)

```
fn help_from_args(args: &[&str]) -> String
```

**Purpose**: Helper that captures clap-generated help text for a given argv vector.

**Data flow**: Attempts to parse args, expects a `DisplayHelp` error, asserts that error kind, and returns the rendered help string.

**Call relations**: Used by help-text tests for plugin marketplace namespacing.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::plugin_marketplace_help_uses_plugin_namespace`  (lines 2828–2844)

```
fn plugin_marketplace_help_uses_plugin_namespace()
```

**Purpose**: Verifies that marketplace help text is nested under `codex plugin marketplace` rather than a top-level namespace.

**Data flow**: Calls `help_from_args` for the marketplace command and its subcommands, then asserts each usage string contains the expected plugin-prefixed path.

**Call relations**: Tests the parser wiring between `PluginCli` and `MarketplaceCli`.

*Call graph*: 2 external calls (assert!, help_from_args).


##### `tests::plugin_marketplace_add_parses_under_plugin`  (lines 2847–2853)

```
fn plugin_marketplace_add_parses_under_plugin()
```

**Purpose**: Checks that `plugin marketplace add` parses as the plugin subcommand tree.

**Data flow**: Parses the command and asserts the root subcommand is `Some(Subcommand::Plugin(_))`.

**Call relations**: Covers nested subcommand registration.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::plugin_marketplace_upgrade_parses_under_plugin`  (lines 2856–2862)

```
fn plugin_marketplace_upgrade_parses_under_plugin()
```

**Purpose**: Checks that `plugin marketplace upgrade` stays under the plugin namespace.

**Data flow**: Parses the command and asserts the root subcommand is plugin.

**Call relations**: Another namespace regression test for marketplace nesting.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::plugin_add_parses_under_plugin`  (lines 2865–2877)

```
fn plugin_add_parses_under_plugin()
```

**Purpose**: Checks that direct plugin add parsing still works under `codex plugin`.

**Data flow**: Parses a plugin add command with `--marketplace` and asserts the root subcommand is plugin.

**Call relations**: Covers the non-marketplace plugin branch.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::plugin_list_parses_under_plugin`  (lines 2880–2886)

```
fn plugin_list_parses_under_plugin()
```

**Purpose**: Checks that direct plugin list parsing still works under `codex plugin`.

**Data flow**: Parses a plugin list command and asserts the root subcommand is plugin.

**Call relations**: Namespace regression coverage.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::plugin_remove_parses_under_plugin`  (lines 2889–2901)

```
fn plugin_remove_parses_under_plugin()
```

**Purpose**: Checks that direct plugin remove parsing still works under `codex plugin`.

**Data flow**: Parses a plugin remove command and asserts the root subcommand is plugin.

**Call relations**: Namespace regression coverage.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::update_parses_as_update_subcommand`  (lines 2904–2907)

```
fn update_parses_as_update_subcommand()
```

**Purpose**: Verifies that `update` is recognized as a dedicated top-level subcommand.

**Data flow**: Parses `codex update` and asserts the root subcommand matches `Subcommand::Update`.

**Call relations**: Protects the top-level parser table.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::archive_merges_scoped_tui_flags`  (lines 2910–2942)

```
fn archive_merges_scoped_tui_flags()
```

**Purpose**: Verifies that archive-scoped TUI flags override or extend root interactive settings correctly.

**Data flow**: Uses `finalize_archive_from_args` on a command containing cwd, remote, strict-config, bypass-hook-trust, model, profile, and target values, then asserts the merged `TuiCli` and remote options contain the expected values.

**Call relations**: Tests `finalize_session_archive_interactive` and root/subcommand precedence.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_archive_from_args).


##### `tests::delete_force_requires_uuid`  (lines 2945–2953)

```
fn delete_force_requires_uuid()
```

**Purpose**: Checks the UUID-only safety rule for forced session deletion.

**Data flow**: Calls `delete_action` with a UUID and with a name, asserting success for the former and the exact error message for the latter.

**Call relations**: Direct unit test for `delete_action`.

*Call graph*: calls 1 internal fn (delete_action); 2 external calls (assert!, assert_eq!).


##### `tests::sandbox_parses_permissions_profile`  (lines 2957–2974)

```
fn sandbox_parses_permissions_profile()
```

**Purpose**: Verifies long-form sandbox permissions-profile parsing on supported platforms.

**Data flow**: Parses a sandbox command with `--permissions-profile :workspace -- echo`, extracts the sandbox command, and asserts the profile and trailing command vector.

**Call relations**: Covers clap integration for platform-specific sandbox args.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::sandbox_parses_permissions_profile_short_alias`  (lines 2978–2989)

```
fn sandbox_parses_permissions_profile_short_alias()
```

**Purpose**: Verifies short-form `-P` sandbox permissions-profile parsing.

**Data flow**: Parses the sandbox command and asserts the same fields as the long-form test.

**Call relations**: Complements the previous sandbox parser test.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::sandbox_parses_config_profile`  (lines 2993–3004)

```
fn sandbox_parses_config_profile()
```

**Purpose**: Checks that sandbox commands accept `--profile` on supported platforms.

**Data flow**: Parses the sandbox command, extracts the sandbox args, and asserts the config profile and trailing command.

**Call relations**: Covers profile-aware sandbox parsing.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::sandbox_rejects_explicit_profile_controls_without_profile`  (lines 3008–3013)

```
fn sandbox_rejects_explicit_profile_controls_without_profile()
```

**Purpose**: Ensures sandbox parsing rejects profile-scoped controls when no profile is supplied.

**Data flow**: Attempts to parse `codex sandbox -C /tmp`, expects a parse error, and asserts the error kind is `MissingRequiredArgument`.

**Call relations**: Protects clap constraints on sandbox profile controls.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::plugin_marketplace_remove_parses_under_plugin`  (lines 3016–3022)

```
fn plugin_marketplace_remove_parses_under_plugin()
```

**Purpose**: Checks that `plugin marketplace remove` remains nested under the plugin namespace.

**Data flow**: Parses the command and asserts the root subcommand is plugin.

**Call relations**: Namespace regression coverage.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::marketplace_no_longer_parses_at_top_level`  (lines 3025–3037)

```
fn marketplace_no_longer_parses_at_top_level()
```

**Purpose**: Ensures the old top-level `marketplace` namespace is no longer accepted.

**Data flow**: Attempts to parse top-level marketplace add/upgrade/remove commands and asserts each parse fails.

**Call relations**: Protects the CLI migration to `codex plugin marketplace`.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::full_auto_no_longer_parses_at_top_level`  (lines 3040–3044)

```
fn full_auto_no_longer_parses_at_top_level()
```

**Purpose**: Ensures the removed top-level `--full-auto` flag is rejected.

**Data flow**: Attempts to parse `codex --full-auto` and asserts parsing fails.

**Call relations**: Regression test for removed flag handling.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::exec_full_auto_reports_migration_path`  (lines 3047–3058)

```
fn exec_full_auto_reports_migration_path()
```

**Purpose**: Checks that exec still accepts the removed `--full-auto` long enough to emit a migration warning.

**Data flow**: Parses `codex exec --full-auto summarize`, extracts the exec CLI, and asserts the warning string returned by `removed_full_auto_warning()`.

**Call relations**: Covers compatibility behavior in the exec subcommand integration.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::sandbox_full_auto_no_longer_parses`  (lines 3061–3065)

```
fn sandbox_full_auto_no_longer_parses()
```

**Purpose**: Ensures sandbox does not accept the removed `--full-auto` flag.

**Data flow**: Attempts to parse a sandbox command with `--full-auto` and asserts parsing fails.

**Call relations**: Regression test for removed flag handling in sandbox mode.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::sample_exit_info`  (lines 3067–3083)

```
fn sample_exit_info(conversation_id: Option<&str>, thread_name: Option<&str>) -> AppExitInfo
```

**Purpose**: Builds a representative `AppExitInfo` for exit-message tests.

**Data flow**: Creates a `TokenUsage` with output tokens, optionally parses a `ThreadId`, computes a resume hint from thread name/id, and returns an `AppExitInfo` with `UserRequested` exit reason and no update action.

**Call relations**: Shared helper for the `format_exit_messages` test suite.

*Call graph*: 2 external calls (default, resume_hint).


##### `tests::format_exit_messages_skips_zero_usage`  (lines 3086–3096)

```
fn format_exit_messages_skips_zero_usage()
```

**Purpose**: Verifies that zero token usage produces no output lines.

**Data flow**: Constructs an `AppExitInfo` with default token usage and no resume hint, calls `format_exit_messages`, and asserts the returned vector is empty.

**Call relations**: Tests the token-usage suppression branch in `format_exit_messages`.

*Call graph*: calls 1 internal fn (format_exit_messages); 2 external calls (assert!, default).


##### `tests::format_exit_messages_includes_session_id_for_fatal_exit_without_resume_hint`  (lines 3099–3112)

```
fn format_exit_messages_includes_session_id_for_fatal_exit_without_resume_hint()
```

**Purpose**: Checks that fatal exits without a resume hint print the session ID.

**Data flow**: Builds a fatal `AppExitInfo` with a parsed thread ID and no resume hint, calls `format_exit_messages`, and asserts the single `Session ID: ...` line.

**Call relations**: Tests the fatal fallback branch in `format_exit_messages`.

*Call graph*: calls 2 internal fn (format_exit_messages, from_string); 3 external calls (assert_eq!, default, Fatal).


##### `tests::format_exit_messages_includes_resume_hint_for_fatal_exit`  (lines 3115–3130)

```
fn format_exit_messages_includes_resume_hint_for_fatal_exit()
```

**Purpose**: Checks that a fatal exit still prefers the resume hint over the raw session-id fallback.

**Data flow**: Starts from `sample_exit_info`, changes the exit reason to fatal, calls `format_exit_messages`, and asserts both token usage and resume command lines.

**Call relations**: Covers precedence between resume hints and fatal session-id fallback.

*Call graph*: calls 1 internal fn (format_exit_messages); 3 external calls (assert_eq!, sample_exit_info, Fatal).


##### `tests::format_exit_messages_includes_resume_hint_without_color`  (lines 3133–3147)

```
fn format_exit_messages_includes_resume_hint_without_color()
```

**Purpose**: Verifies plain-text resume hint formatting when color is disabled.

**Data flow**: Builds sample exit info, calls `format_exit_messages` with `false`, and asserts the exact two output lines.

**Call relations**: Tests the non-color branch in `format_exit_messages`.

*Call graph*: calls 1 internal fn (format_exit_messages); 2 external calls (assert_eq!, sample_exit_info).


##### `tests::format_exit_messages_applies_color_when_enabled`  (lines 3150–3158)

```
fn format_exit_messages_applies_color_when_enabled()
```

**Purpose**: Verifies that the resume command is colorized when color output is enabled.

**Data flow**: Builds sample exit info, calls `format_exit_messages` with `true`, and asserts the second line contains the cyan ANSI escape sequence.

**Call relations**: Tests the color branch in `format_exit_messages`.

*Call graph*: calls 1 internal fn (format_exit_messages); 3 external calls (assert!, assert_eq!, sample_exit_info).


##### `tests::format_exit_messages_names_picker_item_when_thread_has_name`  (lines 3161–3174)

```
fn format_exit_messages_names_picker_item_when_thread_has_name()
```

**Purpose**: Checks that named threads produce a picker-oriented resume hint rather than a raw `codex resume <id>` command.

**Data flow**: Builds sample exit info with both thread ID and thread name, calls `format_exit_messages`, and asserts the picker-selection wording.

**Call relations**: Covers resume-hint formatting behavior supplied by `codex_utils_cli::resume_hint`.

*Call graph*: calls 1 internal fn (format_exit_messages); 2 external calls (assert_eq!, sample_exit_info).


##### `tests::resume_model_flag_applies_when_no_root_flags`  (lines 3177–3185)

```
fn resume_model_flag_applies_when_no_root_flags()
```

**Purpose**: Verifies that a resume-scoped model flag is preserved in the finalized interactive CLI.

**Data flow**: Uses `finalize_resume_from_args` on `codex resume -m ...`, then asserts the model and default picker/last/session-id fields.

**Call relations**: Tests `finalize_resume_interactive` and `merge_interactive_cli_flags`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_picker_logic_none_and_not_last`  (lines 3188–3194)

```
fn resume_picker_logic_none_and_not_last()
```

**Purpose**: Checks that plain `codex resume` defaults to showing the picker.

**Data flow**: Finalizes resume args with no session id and no `--last`, then asserts `resume_picker=true` and other resume flags are unset.

**Call relations**: Directly tests resume picker logic.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_picker_logic_last`  (lines 3197–3203)

```
fn resume_picker_logic_last()
```

**Purpose**: Checks that `codex resume --last` disables the picker and selects the most recent session.

**Data flow**: Finalizes resume args with `--last` and asserts `resume_last=true`, `resume_picker=false`, and no explicit session id.

**Call relations**: Tests the `--last` branch in `finalize_resume_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_last_accepts_prompt_positional`  (lines 3206–3218)

```
fn resume_last_accepts_prompt_positional()
```

**Purpose**: Verifies the positional reinterpretation rule where `--last <prompt>` treats the positional as prompt text.

**Data flow**: Finalizes resume args with `--last` and one positional, then asserts no session id is set and `interactive.prompt` contains the positional text.

**Call relations**: Tests the special-case positional rewrite in `finalize_resume_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_last_rejects_explicit_session_and_prompt`  (lines 3221–3227)

```
fn resume_last_rejects_explicit_session_and_prompt()
```

**Purpose**: Ensures clap rejects `resume --last SESSION_ID PROMPT` because prompt conflicts with `--last` when an explicit session id is also present.

**Data flow**: Attempts to parse that argv shape and asserts the clap error kind is `ArgumentConflict`.

**Call relations**: Exercises the custom `SessionTuiCli` arg conflict rules.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::resume_picker_logic_with_session_id`  (lines 3230–3236)

```
fn resume_picker_logic_with_session_id()
```

**Purpose**: Checks that providing a session id disables the picker without enabling `--last`.

**Data flow**: Finalizes resume args with a positional session id and asserts the resulting resume fields.

**Call relations**: Tests the explicit-session branch in `finalize_resume_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_with_session_id_accepts_prompt_positional`  (lines 3239–3247)

```
fn resume_with_session_id_accepts_prompt_positional()
```

**Purpose**: Verifies that resume accepts both an explicit session id and a following prompt positional.

**Data flow**: Finalizes resume args with two positionals and asserts the first becomes `resume_session_id` and the second becomes `interactive.prompt`.

**Call relations**: Covers the non-`--last` positional interpretation path.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_all_flag_sets_show_all`  (lines 3250–3254)

```
fn resume_all_flag_sets_show_all()
```

**Purpose**: Checks that `--all` enables the resume picker’s all-sessions mode.

**Data flow**: Finalizes resume args with `--all` and asserts `resume_show_all=true`.

**Call relations**: Tests one of the resume-specific flags set by `finalize_resume_interactive`.

*Call graph*: 2 external calls (assert!, finalize_resume_from_args).


##### `tests::resume_include_non_interactive_flag_sets_source_filter_override`  (lines 3257–3263)

```
fn resume_include_non_interactive_flag_sets_source_filter_override()
```

**Purpose**: Checks that `--include-non-interactive` is propagated into the final interactive CLI.

**Data flow**: Finalizes resume args with that flag and asserts `resume_include_non_interactive=true`.

**Call relations**: Tests another resume-specific field set by `finalize_resume_interactive`.

*Call graph*: 2 external calls (assert!, finalize_resume_from_args).


##### `tests::resume_merges_option_flags`  (lines 3266–3320)

```
fn resume_merges_option_flags()
```

**Purpose**: Verifies that many resume-scoped runtime flags override or extend the root interactive CLI correctly.

**Data flow**: Finalizes a resume command containing OSS mode, search, sandbox, approval policy, model, profile, cwd, strict-config, and images, then asserts all corresponding fields on the merged `TuiCli`.

**Call relations**: Broad integration test for `merge_interactive_cli_flags` plus resume-specific field setup.

*Call graph*: 4 external calls (assert!, assert_eq!, assert_matches!, finalize_resume_from_args).


##### `tests::resume_merges_dangerously_bypass_flag`  (lines 3323–3336)

```
fn resume_merges_dangerously_bypass_flag()
```

**Purpose**: Checks that the dangerous bypass flag is preserved in resume mode.

**Data flow**: Finalizes resume args with the bypass flag and asserts the merged `TuiCli` field plus default picker behavior.

**Call relations**: Tests propagation of a shared runtime flag through `merge_interactive_cli_flags`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_merges_bypass_hook_trust_flag`  (lines 3339–3348)

```
fn resume_merges_bypass_hook_trust_flag()
```

**Purpose**: Checks that the bypass-hook-trust flag is preserved in resume mode.

**Data flow**: Finalizes resume args with that flag and asserts the merged field and default picker behavior.

**Call relations**: Another propagation test for `merge_interactive_cli_flags`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::fork_picker_logic_none_and_not_last`  (lines 3351–3357)

```
fn fork_picker_logic_none_and_not_last()
```

**Purpose**: Checks that plain `codex fork` defaults to showing the picker.

**Data flow**: Finalizes fork args with no session id and no `--last`, then asserts `fork_picker=true` and other fork fields are unset.

**Call relations**: Fork analogue of the resume picker test.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_picker_logic_last`  (lines 3360–3366)

```
fn fork_picker_logic_last()
```

**Purpose**: Checks that `codex fork --last` disables the picker and selects the most recent session.

**Data flow**: Finalizes fork args with `--last` and asserts `fork_last=true`, `fork_picker=false`, and no explicit session id.

**Call relations**: Tests the `--last` branch in `finalize_fork_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_last_accepts_prompt_positional`  (lines 3369–3380)

```
fn fork_last_accepts_prompt_positional()
```

**Purpose**: Verifies the positional reinterpretation rule for `fork --last <prompt>`.

**Data flow**: Finalizes fork args with `--last` and one positional, then asserts no session id is set and the prompt field contains the positional text.

**Call relations**: Tests the special-case positional rewrite in `finalize_fork_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_last_rejects_explicit_session_and_prompt`  (lines 3383–3389)

```
fn fork_last_rejects_explicit_session_and_prompt()
```

**Purpose**: Ensures clap rejects `fork --last SESSION_ID PROMPT`.

**Data flow**: Attempts to parse that argv shape and asserts an `ArgumentConflict` error.

**Call relations**: Exercises the same `SessionTuiCli` conflict rule in the fork path.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::fork_picker_logic_with_session_id`  (lines 3392–3398)

```
fn fork_picker_logic_with_session_id()
```

**Purpose**: Checks that providing a session id disables the fork picker.

**Data flow**: Finalizes fork args with a positional session id and asserts the resulting fork fields.

**Call relations**: Tests the explicit-session branch in `finalize_fork_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_with_session_id_accepts_prompt_positional`  (lines 3401–3409)

```
fn fork_with_session_id_accepts_prompt_positional()
```

**Purpose**: Verifies that fork accepts both an explicit session id and a following prompt positional.

**Data flow**: Finalizes fork args with two positionals and asserts the first becomes `fork_session_id` and the second becomes `interactive.prompt`.

**Call relations**: Covers the non-`--last` positional interpretation path for fork.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_all_flag_sets_show_all`  (lines 3412–3416)

```
fn fork_all_flag_sets_show_all()
```

**Purpose**: Checks that `fork --all` enables all-sessions mode.

**Data flow**: Finalizes fork args with `--all` and asserts `fork_show_all=true`.

**Call relations**: Tests a fork-specific field set by `finalize_fork_interactive`.

*Call graph*: 2 external calls (assert!, finalize_fork_from_args).


##### `tests::app_server_analytics_default_disabled_without_flag`  (lines 3419–3427)

```
fn app_server_analytics_default_disabled_without_flag()
```

**Purpose**: Verifies default app-server CLI values when no analytics or remote-control flags are supplied.

**Data flow**: Parses `codex app-server`, extracts the command, and asserts analytics default is false, remote control is false, and listen transport defaults to stdio.

**Call relations**: Covers clap defaults for `AppServerCommand`.

*Call graph*: 3 external calls (assert!, assert_eq!, app_server_from_args).


##### `tests::app_server_remote_control_startup_flag_enables_remote_control`  (lines 3430–3433)

```
fn app_server_remote_control_startup_flag_enables_remote_control()
```

**Purpose**: Checks that `--remote-control` sets the corresponding app-server startup flag.

**Data flow**: Parses the command and asserts `remote_control` is true.

**Call relations**: Covers one app-server CLI flag consumed by `cli_main`.

*Call graph*: 2 external calls (assert!, app_server_from_args).


##### `tests::app_server_analytics_default_enabled_with_flag`  (lines 3436–3440)

```
fn app_server_analytics_default_enabled_with_flag()
```

**Purpose**: Checks that `--analytics-default-enabled` flips the default analytics behavior.

**Data flow**: Parses the command and asserts the boolean is true.

**Call relations**: Covers another app-server CLI flag consumed by `cli_main`.

*Call graph*: 2 external calls (assert!, app_server_from_args).


##### `tests::strict_config_parses_for_supported_commands`  (lines 3443–3476)

```
fn strict_config_parses_for_supported_commands()
```

**Purpose**: Verifies that `--strict-config` is accepted by the root interactive CLI and by supported subcommands.

**Data flow**: Parses several commands and asserts the strict-config field is set in the expected location for root, mcp-server, review, and exec-server.

**Call relations**: Tests parser placement before post-parse rejection logic runs.

*Call graph*: 3 external calls (assert!, assert_matches!, try_parse_from).


##### `tests::root_strict_config_is_supported_for_exec_server`  (lines 3479–3485)

```
fn root_strict_config_is_supported_for_exec_server()
```

**Purpose**: Checks that inherited root `--strict-config` is allowed for `exec-server`.

**Data flow**: Parses `codex --strict-config exec-server`, then calls `reject_root_strict_config_for_subcommand` and expects success.

**Call relations**: Tests the allowlist in `unsupported_subcommand_name_for_strict_config`.

*Call graph*: calls 1 internal fn (reject_root_strict_config_for_subcommand); 1 external calls (try_parse_from).


##### `tests::root_strict_config_is_rejected_for_unsupported_subcommands`  (lines 3488–3514)

```
fn root_strict_config_is_rejected_for_unsupported_subcommands()
```

**Purpose**: Checks that inherited root `--strict-config` is rejected for unsupported commands like `mcp` and `remote-control`.

**Data flow**: Parses those commands, calls `reject_root_strict_config_for_subcommand`, captures the errors, and asserts the exact messages.

**Call relations**: Tests the denylist path in the root strict-config validator.

*Call graph*: calls 1 internal fn (reject_root_strict_config_for_subcommand); 2 external calls (assert_eq!, try_parse_from).


##### `tests::app_server_subcommands_reject_strict_config`  (lines 3517–3530)

```
fn app_server_subcommands_reject_strict_config()
```

**Purpose**: Ensures app-server tooling subcommands such as `proxy` reject `--strict-config`.

**Data flow**: Parses `codex app-server --strict-config proxy`, calls `reject_strict_config_for_app_server_subcommand`, and asserts the exact error message.

**Call relations**: Tests the app-server-specific strict-config validator.

*Call graph*: calls 1 internal fn (reject_strict_config_for_app_server_subcommand); 2 external calls (assert_eq!, app_server_from_args).


##### `tests::reject_remote_flag_for_remote_control`  (lines 3533–3549)

```
fn reject_remote_flag_for_remote_control()
```

**Purpose**: Checks that root `--remote` is rejected for the non-interactive `remote-control` command.

**Data flow**: Parses the command, extracts the remote-control subcommand name, calls `reject_remote_mode_for_subcommand`, and asserts the resulting error mentions `remote-control`.

**Call relations**: Tests the generic remote-mode rejection helper.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_subcommand); 4 external calls (assert!, assert_eq!, try_parse_from, panic!).


##### `tests::remote_flag_parses_for_interactive_root`  (lines 3552–3556)

```
fn remote_flag_parses_for_interactive_root()
```

**Purpose**: Verifies that root interactive mode accepts `--remote`.

**Data flow**: Parses `codex --remote unix://codex.sock` and asserts the parsed remote string.

**Call relations**: Covers the positive parse path for interactive remote mode.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::remote_auth_token_env_flag_parses_for_interactive_root`  (lines 3559–3572)

```
fn remote_auth_token_env_flag_parses_for_interactive_root()
```

**Purpose**: Verifies that root interactive mode accepts `--remote-auth-token-env` alongside `--remote`.

**Data flow**: Parses the command and asserts the env-var name is captured in `cli.remote.remote_auth_token_env`.

**Call relations**: Covers parsing for the auth-token injection feature used by `resolve_remote_endpoint`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::remote_flag_parses_for_resume_subcommand`  (lines 3575–3585)

```
fn remote_flag_parses_for_resume_subcommand()
```

**Purpose**: Verifies that resume commands accept their own scoped `--remote` option.

**Data flow**: Parses `codex resume --remote unix://codex.sock`, extracts the `ResumeCommand`, and asserts the scoped remote string.

**Call relations**: Covers parsing for resume-specific remote endpoint selection.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::reject_remote_mode_for_non_interactive_subcommands`  (lines 3588–3599)

```
fn reject_remote_mode_for_non_interactive_subcommands()
```

**Purpose**: Checks that non-interactive commands reject root `--remote`.

**Data flow**: Calls `reject_remote_mode_for_subcommand` with a sample remote and `exec` as the command name, expects an error, and asserts it mentions interactive-only support.

**Call relations**: Direct unit test for the remote-mode validator.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_subcommand); 1 external calls (assert!).


##### `tests::reject_remote_auth_token_env_for_non_interactive_subcommands`  (lines 3602–3613)

```
fn reject_remote_auth_token_env_for_non_interactive_subcommands()
```

**Purpose**: Checks that non-interactive commands reject root `--remote-auth-token-env`.

**Data flow**: Calls `reject_remote_mode_for_subcommand` with only an auth-token env var and asserts the error mentions interactive-only support.

**Call relations**: Direct unit test for the same validator.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_subcommand); 1 external calls (assert!).


##### `tests::reject_remote_auth_token_env_for_app_server_generate_internal_json_schema`  (lines 3616–3628)

```
fn reject_remote_auth_token_env_for_app_server_generate_internal_json_schema()
```

**Purpose**: Ensures app-server internal schema generation rejects remote auth-token env usage.

**Data flow**: Constructs the relevant app-server subcommand, calls `reject_remote_mode_for_app_server_subcommand`, and asserts the error mentions `generate-internal-json-schema`.

**Call relations**: Tests the app-server wrapper around the generic remote-mode validator.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_app_server_subcommand); 3 external calls (from, assert!, GenerateInternalJsonSchema).


##### `tests::read_remote_auth_token_from_env_var_reports_missing_values`  (lines 3631–3637)

```
fn read_remote_auth_token_from_env_var_reports_missing_values()
```

**Purpose**: Checks that missing environment variables produce a descriptive error.

**Data flow**: Calls `read_remote_auth_token_from_env_var_with` with a closure returning `VarError::NotPresent`, expects an error, and asserts it mentions the variable not being set.

**Call relations**: Tests the injectable env-reader helper.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var_with); 1 external calls (assert!).


##### `tests::read_remote_auth_token_from_env_var_trims_values`  (lines 3640–3647)

```
fn read_remote_auth_token_from_env_var_trims_values()
```

**Purpose**: Checks that surrounding whitespace is trimmed from remote auth tokens.

**Data flow**: Calls the injectable env-reader helper with a padded token string and asserts the returned token is trimmed.

**Call relations**: Tests normalization behavior in `read_remote_auth_token_from_env_var_with`.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var_with); 1 external calls (assert_eq!).


##### `tests::read_remote_auth_token_from_env_var_rejects_empty_values`  (lines 3650–3656)

```
fn read_remote_auth_token_from_env_var_rejects_empty_values()
```

**Purpose**: Checks that all-whitespace environment values are rejected as empty.

**Data flow**: Calls the injectable env-reader helper with whitespace-only content, expects an error, and asserts it mentions emptiness.

**Call relations**: Tests validation behavior in `read_remote_auth_token_from_env_var_with`.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var_with); 1 external calls (assert!).


##### `tests::app_server_listen_websocket_url_parses`  (lines 3659–3669)

```
fn app_server_listen_websocket_url_parses()
```

**Purpose**: Verifies parsing of websocket listen URLs into the typed app-server transport enum.

**Data flow**: Parses `--listen ws://127.0.0.1:4500` and asserts the resulting `AppServerTransport::WebSocket` bind address.

**Call relations**: Covers clap parsing for app-server transport selection.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_listen_stdio_url_parses`  (lines 3672–3679)

```
fn app_server_listen_stdio_url_parses()
```

**Purpose**: Verifies parsing of `stdio://` into the stdio transport variant.

**Data flow**: Parses the command and asserts `listen` equals `AppServerTransport::Stdio`.

**Call relations**: Transport parser coverage.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_stdio_flag_parses`  (lines 3682–3685)

```
fn app_server_stdio_flag_parses()
```

**Purpose**: Checks that the shorthand `--stdio` flag is accepted.

**Data flow**: Parses the command and asserts `stdio` is true.

**Call relations**: Covers the boolean shortcut consumed by `cli_main`.

*Call graph*: 2 external calls (assert!, app_server_from_args).


##### `tests::app_server_stdio_flag_conflicts_with_listen`  (lines 3688–3698)

```
fn app_server_stdio_flag_conflicts_with_listen()
```

**Purpose**: Ensures `--stdio` and `--listen` cannot be supplied together.

**Data flow**: Attempts to parse both flags and asserts clap returns `ArgumentConflict`.

**Call relations**: Tests parser-level conflict rules on `AppServerCommand`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::app_server_listen_unix_socket_url_parses`  (lines 3701–3710)

```
fn app_server_listen_unix_socket_url_parses()
```

**Purpose**: Verifies parsing of bare `unix://` into the default control socket path.

**Data flow**: Parses the command and asserts the resulting transport is `UnixSocket` with the helper-computed default path.

**Call relations**: Transport parser coverage.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_listen_unix_socket_path_parses`  (lines 3713–3724)

```
fn app_server_listen_unix_socket_path_parses()
```

**Purpose**: Verifies parsing of `unix:///tmp/codex.sock` into an absolute Unix socket transport path.

**Data flow**: Parses the command and asserts the resulting `AbsolutePathBuf` matches `/tmp/codex.sock`.

**Call relations**: Transport parser coverage.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_listen_off_parses`  (lines 3727–3730)

```
fn app_server_listen_off_parses()
```

**Purpose**: Checks that `--listen off` maps to the `Off` transport variant.

**Data flow**: Parses the command and asserts `listen == AppServerTransport::Off`.

**Call relations**: Transport parser coverage.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_listen_invalid_url_fails_to_parse`  (lines 3733–3737)

```
fn app_server_listen_invalid_url_fails_to_parse()
```

**Purpose**: Ensures unsupported listen URL schemes are rejected during parsing.

**Data flow**: Attempts to parse `--listen http://foo` and asserts parsing fails.

**Call relations**: Negative parser coverage for app-server transport parsing.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::app_server_proxy_subcommand_parses`  (lines 3740–3748)

```
fn app_server_proxy_subcommand_parses()
```

**Purpose**: Checks that the app-server proxy subcommand parses with no explicit socket path.

**Data flow**: Parses `codex app-server proxy` and asserts the nested subcommand is `Proxy` with `socket_path: None`.

**Call relations**: Covers parser wiring for the proxy branch handled in `cli_main`.

*Call graph*: 2 external calls (assert!, app_server_from_args).


##### `tests::app_server_daemon_subcommands_parse`  (lines 3751–3812)

```
fn app_server_daemon_subcommands_parse()
```

**Purpose**: Verifies parsing of all supported app-server daemon lifecycle subcommands.

**Data flow**: Parses bootstrap/start/restart/enable-remote-control/disable-remote-control/stop/version commands and asserts each nested enum shape.

**Call relations**: Parser coverage for the daemon branch dispatched in `cli_main`.

*Call graph*: 1 external calls (assert!).


##### `tests::app_server_proxy_sock_path_parses`  (lines 3815–3828)

```
fn app_server_proxy_sock_path_parses()
```

**Purpose**: Checks that `app-server proxy --sock` resolves a relative path into an absolute socket path.

**Data flow**: Parses the command, extracts the proxy args, and asserts the `socket_path` equals `AbsolutePathBuf::relative_to_current_dir("codex.sock")`.

**Call relations**: Covers the `parse_socket_path` value parser.

*Call graph*: 3 external calls (assert_eq!, app_server_from_args, panic!).


##### `tests::reject_remote_auth_token_env_for_app_server_proxy`  (lines 3831–3840)

```
fn reject_remote_auth_token_env_for_app_server_proxy()
```

**Purpose**: Ensures app-server proxy rejects remote auth-token env usage.

**Data flow**: Constructs a proxy subcommand, calls `reject_remote_mode_for_app_server_subcommand`, and asserts the error mentions `app-server proxy`.

**Call relations**: Tests the app-server remote-mode validator.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_app_server_subcommand); 2 external calls (assert!, Proxy).


##### `tests::reject_remote_auth_token_env_for_app_server_version`  (lines 3843–3854)

```
fn reject_remote_auth_token_env_for_app_server_version()
```

**Purpose**: Ensures app-server daemon version rejects remote auth-token env usage.

**Data flow**: Constructs the daemon version subcommand, calls the validator, and asserts the error mentions `app-server daemon version`.

**Call relations**: Tests the same validator on another nested app-server command.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_app_server_subcommand); 2 external calls (assert!, Daemon).


##### `tests::app_server_capability_token_flags_parse`  (lines 3857–3877)

```
fn app_server_capability_token_flags_parse()
```

**Purpose**: Verifies parsing of websocket capability-token auth flags for app-server.

**Data flow**: Parses `--ws-auth capability-token --ws-token-file ...`, extracts the app-server auth args, and asserts the auth mode and token-file path.

**Call relations**: Covers clap parsing for websocket auth settings later converted in `cli_main`.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_signed_bearer_flags_parse`  (lines 3880–3909)

```
fn app_server_signed_bearer_flags_parse()
```

**Purpose**: Verifies parsing of signed bearer token websocket auth settings.

**Data flow**: Parses auth mode, shared-secret file, issuer, audience, and max clock skew flags, then asserts each parsed field.

**Call relations**: Parser coverage for app-server websocket auth configuration.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_rejects_removed_insecure_non_loopback_flag`  (lines 3912–3919)

```
fn app_server_rejects_removed_insecure_non_loopback_flag()
```

**Purpose**: Ensures a removed insecure websocket flag is no longer accepted.

**Data flow**: Attempts to parse the removed flag and asserts parsing fails.

**Call relations**: Regression test for removed app-server CLI surface.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::features_enable_parses_feature_name`  (lines 3922–3932)

```
fn features_enable_parses_feature_name()
```

**Purpose**: Checks that `features enable` captures the feature key positional.

**Data flow**: Parses the command, extracts the nested `FeatureSetArgs`, and asserts the feature string.

**Call relations**: Parser coverage for the features subcommand.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::features_disable_parses_feature_name`  (lines 3935–3945)

```
fn features_disable_parses_feature_name()
```

**Purpose**: Checks that `features disable` captures the feature key positional.

**Data flow**: Parses the command, extracts the nested `FeatureSetArgs`, and asserts the feature string.

**Call relations**: Parser coverage for the features subcommand.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::feature_toggles_known_features_generate_overrides`  (lines 3948–3961)

```
fn feature_toggles_known_features_generate_overrides()
```

**Purpose**: Verifies that known feature toggles become the expected raw override strings.

**Data flow**: Constructs a `FeatureToggles` value with one enable and one disable entry, calls `to_overrides`, and asserts the resulting vector contents and order.

**Call relations**: Direct unit test for `FeatureToggles::to_overrides`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::feature_toggles_accept_legacy_linux_sandbox_flag`  (lines 3964–3974)

```
fn feature_toggles_accept_legacy_linux_sandbox_flag()
```

**Purpose**: Checks that a legacy feature key is still recognized.

**Data flow**: Constructs toggles enabling `use_linux_sandbox_bwrap`, calls `to_overrides`, and asserts success with the expected override string.

**Call relations**: Tests backward-compatibility in `FeatureToggles::validate_feature`.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `tests::feature_toggles_accept_removed_image_detail_original_flag`  (lines 3977–3987)

```
fn feature_toggles_accept_removed_image_detail_original_flag()
```

**Purpose**: Checks that a removed-but-known feature key is still accepted by the validator.

**Data flow**: Constructs toggles enabling `image_detail_original`, calls `to_overrides`, and asserts the expected override string.

**Call relations**: Another compatibility test for feature-key validation.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `tests::feature_toggles_unknown_feature_errors`  (lines 3990–3999)

```
fn feature_toggles_unknown_feature_errors()
```

**Purpose**: Ensures unknown feature keys are rejected with a clear error.

**Data flow**: Constructs toggles with an invalid feature, calls `to_overrides`, expects an error, and asserts the exact message.

**Call relations**: Direct unit test for `FeatureToggles::validate_feature`.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `tests::strict_config_with_unknown_enable_errors`  (lines 4002–4005)

```
fn strict_config_with_unknown_enable_errors()
```

**Purpose**: Checks that unknown `--enable` values still fail under root strict-config mode.

**Data flow**: Calls the helper that parses `--strict-config` plus the toggle args, captures the error from `to_overrides`, and asserts the exact message.

**Call relations**: Tests interaction between parsing and feature validation.

*Call graph*: 2 external calls (assert_eq!, strict_config_feature_toggle_error).


##### `tests::strict_config_with_unknown_disable_errors`  (lines 4008–4011)

```
fn strict_config_with_unknown_disable_errors()
```

**Purpose**: Checks that unknown `--disable` values fail under strict-config mode.

**Data flow**: Uses the same helper with `--disable`, then asserts the exact validation error.

**Call relations**: Companion test for the disable path.

*Call graph*: 2 external calls (assert_eq!, strict_config_feature_toggle_error).


##### `tests::strict_config_with_compound_enable_errors`  (lines 4014–4022)

```
fn strict_config_with_compound_enable_errors()
```

**Purpose**: Ensures dotted subkeys are not accepted as feature names.

**Data flow**: Parses strict-config plus a compound feature name, captures the validation error, and asserts the exact message.

**Call relations**: Tests that only canonical feature keys are accepted.

*Call graph*: 2 external calls (assert_eq!, strict_config_feature_toggle_error).


##### `tests::strict_config_feature_toggle_error`  (lines 4024–4033)

```
fn strict_config_feature_toggle_error(args: &[&str]) -> anyhow::Error
```

**Purpose**: Helper that parses a strict-config CLI invocation and returns the feature-toggle validation error.

**Data flow**: Builds an argv iterator beginning with `codex --strict-config`, parses `MultitoolCli`, asserts strict-config was set, then calls `cli.feature_toggles.to_overrides()` and returns the resulting error.

**Call relations**: Shared by the strict-config feature-toggle tests.

*Call graph*: 3 external calls (assert!, try_parse_from, once).


### Interactive and task runners
These entrypoints and schemas cover the interactive TUI and cloud-task execution surfaces that users launch directly.

### `tui/src/cli.rs`

`config` · `startup argument parsing`

This file is the TUI-facing CLI schema. The `Cli` struct derives `Parser` and contains both user-visible flags and several `#[clap(skip)]` internal fields that are populated by higher-level wrapper subcommands such as `codex resume` and `codex fork`. Besides the optional initial prompt and TUI-only flags like `strict_config`, `approval_policy`, `web_search`, and `no_alt_screen`, it embeds `TuiSharedCliOptions`, a newtype around `SharedCliOptions` from `codex_utils_cli`.

Both `Cli` and `TuiSharedCliOptions` implement `Deref`/`DerefMut`, making the wrapped shared options transparently accessible to downstream code without repeated `.shared.0` field access. The wrapper exists mainly so the TUI can intercept clap argument augmentation: its `Args` implementation delegates to `SharedCliOptions::augment_args` / `augment_args_for_update`, then passes the resulting `clap::Command` through `mark_tui_args`. That helper mutates the existing `dangerously_bypass_approvals_and_sandbox` argument to conflict with the TUI's `approval_policy` flag, preventing invalid combinations at parse time.

`FromArgMatches` is similarly delegated, so parsing behavior stays aligned with the shared CLI definition while still returning the TUI wrapper type. Overall, the file is mostly type plumbing and clap integration rather than runtime logic.

#### Function details

##### `Cli::deref`  (lines 81–83)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Exposes the embedded `SharedCliOptions` inside `Cli` by shared reference. This lets code using `Cli` access shared option fields and methods as though `Cli` directly implemented them.

**Data flow**: It reads `self.shared.0` and returns `&SharedCliOptions`. No mutation or side effects occur.

**Call relations**: This is invoked implicitly by Rust deref coercions wherever a `&Cli` is used in a context expecting `&SharedCliOptions`. It does not delegate to other local helpers.


##### `Cli::deref_mut`  (lines 87–89)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Provides mutable access from `Cli` to the wrapped `SharedCliOptions`. It supports in-place updates to shared CLI state through the outer TUI CLI type.

**Data flow**: It returns `&mut self.shared.0`, exposing the inner `SharedCliOptions` mutably. No additional transformation is performed.

**Call relations**: Like `Cli::deref`, this participates implicitly in deref coercions, but for mutable contexts. It is used by downstream code that mutates shared options through a `Cli` value.


##### `TuiSharedCliOptions::into_inner`  (lines 96–98)

```
fn into_inner(self) -> SharedCliOptions
```

**Purpose**: Consumes the TUI wrapper and returns the underlying `SharedCliOptions`. It is the explicit escape hatch when code needs ownership of the shared options rather than wrapper behavior.

**Data flow**: It takes `self` by value and returns `self.0`. No cloning or mutation occurs.

**Call relations**: This method is used when the wrapper's clap-specific behavior is no longer needed and the caller wants the plain shared options type. It stands alone and does not call other helpers.


##### `TuiSharedCliOptions::deref`  (lines 104–106)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Allows `TuiSharedCliOptions` to behave like `SharedCliOptions` for shared borrows. It keeps the wrapper ergonomically transparent outside clap integration points.

**Data flow**: It returns `&self.0` as `&SharedCliOptions`. There are no side effects.

**Call relations**: This is triggered implicitly by deref coercion in read-only contexts. It complements the wrapper's `Args` and `FromArgMatches` implementations by making the wrapper cheap to use elsewhere.


##### `TuiSharedCliOptions::deref_mut`  (lines 110–112)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Allows mutable access to the wrapped `SharedCliOptions` through the TUI wrapper. It preserves the same ergonomic transparency for mutation.

**Data flow**: It returns `&mut self.0`. No extra logic is applied.

**Call relations**: This is the mutable counterpart to `TuiSharedCliOptions::deref`, used implicitly when callers mutate shared CLI options through the wrapper.


##### `TuiSharedCliOptions::augment_args`  (lines 116–118)

```
fn augment_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: Builds the clap argument set for the wrapped shared options and then applies TUI-specific argument constraints. It ensures the TUI parser inherits all shared flags while adjusting one conflict rule.

**Data flow**: It accepts a `clap::Command`, passes it to `SharedCliOptions::augment_args(cmd)`, then feeds the resulting command into `mark_tui_args`. The returned `clap::Command` is the shared schema plus the TUI conflict mutation.

**Call relations**: This method is called by clap while constructing the parser for `TuiSharedCliOptions`. It delegates shared argument definition to the external `SharedCliOptions` implementation and centralizes the TUI-specific tweak in `mark_tui_args`.

*Call graph*: calls 1 internal fn (mark_tui_args); 1 external calls (augment_args).


##### `TuiSharedCliOptions::augment_args_for_update`  (lines 120–122)

```
fn augment_args_for_update(cmd: clap::Command) -> clap::Command
```

**Purpose**: Performs the same TUI-specific command mutation as `augment_args`, but for clap's update path. It keeps incremental argument updates consistent with initial parser construction.

**Data flow**: It takes a `clap::Command`, runs `SharedCliOptions::augment_args_for_update(cmd)`, then passes that command through `mark_tui_args` and returns the result.

**Call relations**: Clap invokes this when updating an existing command definition. The method mirrors `augment_args` so the same conflict rule is enforced in both parser-building modes.

*Call graph*: calls 1 internal fn (mark_tui_args); 1 external calls (augment_args_for_update).


##### `TuiSharedCliOptions::from_arg_matches`  (lines 126–128)

```
fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error>
```

**Purpose**: Parses shared CLI options from clap matches and wraps the result in `TuiSharedCliOptions`. It preserves the shared parser's semantics while returning the TUI wrapper type.

**Data flow**: It receives `&clap::ArgMatches`, calls `SharedCliOptions::from_arg_matches(matches)`, and maps a successful result into `Self`. Errors from clap are propagated unchanged.

**Call relations**: This is part of the wrapper's `FromArgMatches` implementation and is called by clap after argument parsing. It delegates all actual field extraction to the external shared-options parser.

*Call graph*: 1 external calls (from_arg_matches).


##### `TuiSharedCliOptions::update_from_arg_matches`  (lines 130–132)

```
fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error>
```

**Purpose**: Updates an existing wrapped `SharedCliOptions` instance from clap matches. It forwards clap's incremental update behavior directly to the inner type.

**Data flow**: It takes `&mut self` and `&clap::ArgMatches`, then calls `self.0.update_from_arg_matches(matches)`. The returned `Result<(), clap::Error>` is passed through unchanged.

**Call relations**: Clap uses this in update scenarios after parser construction. Unlike the augment methods, it does not need `mark_tui_args` because the command schema has already been built.


##### `mark_tui_args`  (lines 135–139)

```
fn mark_tui_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: Applies the one TUI-specific clap mutation: making `dangerously_bypass_approvals_and_sandbox` conflict with `approval_policy`. This prevents users from combining a total bypass flag with the TUI's approval-mode selector.

**Data flow**: It takes a `clap::Command`, calls `mut_arg` on the argument named `dangerously_bypass_approvals_and_sandbox`, and mutates that argument builder so it `conflicts_with("approval_policy")`. The modified command is returned.

**Call relations**: Both `TuiSharedCliOptions::augment_args` and `TuiSharedCliOptions::augment_args_for_update` funnel their generated command through this helper. It is the single place where the TUI diverges from the shared CLI schema.

*Call graph*: called by 2 (augment_args, augment_args_for_update); 1 external calls (mut_arg).


### `tui/src/main.rs`

`entrypoint` · `startup and process exit`

This file is the executable front door for the terminal UI. `TopCli` combines two flattened clap parsers: `CliConfigOverrides` for raw config override strings and the inner `codex_tui::Cli` command structure. In `main`, execution is wrapped in `arg0_dispatch_or_else`, which allows alternate behavior based on invocation path while still running the normal async TUI closure when no special arg0 dispatch applies.

Inside that closure, the parsed top-level override list is spliced to the front of `inner.config_overrides.raw_overrides`, ensuring outer overrides take precedence before `run_main` receives the final CLI object. `run_main` is invoked with default `LoaderOverrides` and no explicit remote endpoint. After it returns `AppExitInfo`, fatal exits are surfaced immediately to stderr as `ERROR: ...`; user-requested exits are silent.

The helper `format_exit_messages` then derives user-facing stdout lines from the exit info. It emits token usage only when non-zero, emits a cyan-colored resume command when `resume_hint` is present and stdout supports color, and otherwise emits `Session ID: ...` only for fatal exits that have a `thread_id`. If the exit was fatal, stdout is flushed before `std::process::exit(1)` so any printed summary lines are not lost.

#### Function details

##### `format_exit_messages`  (lines 13–39)

```
fn format_exit_messages(exit_info: AppExitInfo, color_enabled: bool) -> Vec<String>
```

**Purpose**: Builds the final stdout summary lines shown after the app exits, based on token usage, resume hints, fatality, and optional color support.

**Data flow**: It takes an `AppExitInfo` and a `color_enabled` flag, inspects `exit_reason` to determine whether the exit was fatal, destructures `token_usage`, `thread_id`, and `resume_hint`, and accumulates a `Vec<String>`. It adds token usage when non-zero, formats a colored or plain resume command when present, otherwise adds a session id only for fatal exits with a thread id, and returns the assembled lines.

**Call relations**: Called only from `main` after `run_main` completes. It does not perform I/O itself; `main` iterates over its returned strings and prints them.

*Call graph*: 3 external calls (new, format!, matches!).


##### `main`  (lines 50–83)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Parses CLI arguments, merges top-level and inner config overrides, runs the async TUI application, and converts the resulting exit reason into stderr/stdout output and process status.

**Data flow**: It takes no explicit arguments, but reads process argv through clap and arg0 dispatch. Inside the async closure passed to `arg0_dispatch_or_else`, it parses `TopCli`, prepends outer raw overrides into `inner.config_overrides.raw_overrides`, awaits `run_main`, prints fatal messages to stderr, computes stdout color support, prints each line from `format_exit_messages`, flushes stdout on fatal exits, and exits with code 1 for fatal failures; otherwise it returns `Ok(())`.

**Call relations**: This is the binary entrypoint. Its only direct graph-listed delegation is to `arg0_dispatch_or_else`, which owns the outer dispatch/run wrapper; inside that closure it orchestrates the rest of the startup and shutdown flow around `run_main`.

*Call graph*: 1 external calls (arg0_dispatch_or_else).


### `exec/src/cli.rs`

`config` · `startup / argument parsing`

This file is the central CLI model for the exec binary. The top-level `Cli` struct derives `Parser` and combines an optional `Command` subcommand with exec-specific booleans such as `strict_config`, `skip_git_repo_check`, `ephemeral`, `ignore_user_config`, `ignore_rules`, JSON output selection, output file paths, and an optional free-form prompt. It embeds `ExecSharedCliOptions`, a thin wrapper around `codex_utils_cli::SharedCliOptions`, so the exec command can reuse shared flags while forcing selected ones (`model`, `dangerously_bypass_approvals_and_sandbox`, `bypass_hook_trust`) to be globally valid even after subcommands. `Cli` and `ExecSharedCliOptions` both implement `Deref`/`DerefMut` to expose the wrapped shared options transparently. The file also preserves compatibility with the removed hidden `--full-auto` flag by parsing it and exposing a migration warning string instead of silently ignoring it.

Subcommand parsing includes a notable workaround: `ResumeArgsRaw` matches Clap’s direct positional layout, but `ResumeArgs::from` rewrites the meaning of the first positional when `--last` is present and no explicit prompt was supplied, treating that positional as `prompt` rather than `session_id`. `ReviewArgs` models mutually exclusive review targets (`--uncommitted`, `--base`, `--commit`) plus an optional title and prompt. Finally, the `Color` enum provides `always`/`never`/`auto` output-color policy as a Clap `ValueEnum`.

#### Function details

##### `Cli::deref`  (lines 91–93)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Exposes the wrapped `SharedCliOptions` inside `Cli` by immutable reference. This lets callers use `Cli` anywhere a shared-options reference is expected.

**Data flow**: It reads `self.shared.0` and returns `&SharedCliOptions` without modifying any state.

**Call relations**: This is a trait adapter used implicitly by Rust deref coercions after CLI parsing. It does not delegate further; it simply forwards access into the embedded shared options.


##### `Cli::deref_mut`  (lines 97–99)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Exposes the wrapped `SharedCliOptions` inside `Cli` by mutable reference. It allows downstream code to mutate shared CLI settings through the top-level parsed struct.

**Data flow**: It reads `self.shared.0` mutably and returns `&mut SharedCliOptions`, performing no transformation beyond field projection.

**Call relations**: Like `Cli::deref`, this participates in ergonomic access patterns after parsing. It is invoked implicitly when mutable shared-option access is needed.


##### `Cli::removed_full_auto_warning`  (lines 103–111)

```
fn removed_full_auto_warning(&self) -> Option<&'static str>
```

**Purpose**: Produces the exact migration warning text for the hidden legacy `--full-auto` flag. If the flag was not present, it returns no warning.

**Data flow**: It reads the boolean field `self.removed_full_auto`; when true it returns `Some(&'static str)` containing the deprecation guidance, otherwise `None`.

**Call relations**: This helper is consumed by higher-level startup/reporting code and by tests that verify compatibility behavior. It does not call into other modules.


##### `ExecSharedCliOptions::into_inner`  (lines 118–120)

```
fn into_inner(self) -> SharedCliOptions
```

**Purpose**: Unwraps the exec-specific wrapper and yields the underlying `SharedCliOptions`. It is the escape hatch for code that needs ownership of the shared options object.

**Data flow**: It consumes `self` and returns `self.0` by value, with no side effects.

**Call relations**: This is a simple conversion helper used after parsing when the wrapper type is no longer needed.


##### `ExecSharedCliOptions::deref`  (lines 126–128)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Provides immutable access to the wrapped `SharedCliOptions` from `ExecSharedCliOptions`. It makes the wrapper behave like the inner type for reads.

**Data flow**: It returns `&self.0` directly and does not mutate state.

**Call relations**: This supports deref coercion throughout the CLI layer and avoids repetitive `.0` field access.


##### `ExecSharedCliOptions::deref_mut`  (lines 132–134)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: Provides mutable access to the wrapped `SharedCliOptions` from `ExecSharedCliOptions`. It makes the wrapper behave like the inner type for writes.

**Data flow**: It returns `&mut self.0` directly and does not perform any additional logic.

**Call relations**: This is the mutable counterpart to `ExecSharedCliOptions::deref`, used implicitly by callers mutating shared options.


##### `ExecSharedCliOptions::augment_args`  (lines 138–140)

```
fn augment_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: Builds the Clap argument set for shared exec options and then marks selected inherited flags as global. This ensures those flags remain valid after subcommands in the `exec` CLI.

**Data flow**: It takes an input `clap::Command`, passes it through `SharedCliOptions::augment_args`, then transforms the resulting command with `mark_exec_global_args`, and returns the modified command.

**Call relations**: Clap invokes this during parser construction for the wrapper type. The function’s main role is to insert exec-specific policy on top of the generic shared-option definition.

*Call graph*: calls 1 internal fn (mark_exec_global_args); 1 external calls (augment_args).


##### `ExecSharedCliOptions::augment_args_for_update`  (lines 142–144)

```
fn augment_args_for_update(cmd: clap::Command) -> clap::Command
```

**Purpose**: Performs the same global-flag adjustment as `augment_args`, but for Clap’s update path. It keeps incremental argument updates consistent with initial parser construction.

**Data flow**: It accepts a `clap::Command`, delegates to `SharedCliOptions::augment_args_for_update`, then passes the result through `mark_exec_global_args` and returns the updated command.

**Call relations**: Clap uses this when updating an existing parser configuration. It mirrors `augment_args` so the same global-argument behavior applies in both parser-building modes.

*Call graph*: calls 1 internal fn (mark_exec_global_args); 1 external calls (augment_args_for_update).


##### `ExecSharedCliOptions::from_arg_matches`  (lines 148–150)

```
fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error>
```

**Purpose**: Parses shared exec options from Clap matches by reusing the underlying shared-options parser and wrapping the result. It converts generic shared parsing into the exec-specific wrapper type.

**Data flow**: It reads a `&clap::ArgMatches`, calls `SharedCliOptions::from_arg_matches`, maps the successful inner value into `ExecSharedCliOptions`, and returns `Result<Self, clap::Error>`.

**Call relations**: Clap calls this when materializing parsed values for the wrapper. It delegates all actual field extraction to the shared-options implementation.

*Call graph*: 1 external calls (from_arg_matches).


##### `ExecSharedCliOptions::update_from_arg_matches`  (lines 152–154)

```
fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error>
```

**Purpose**: Updates an existing wrapped shared-options value from new Clap matches. It forwards the update directly into the inner `SharedCliOptions`.

**Data flow**: It takes `&mut self` and `&clap::ArgMatches`, invokes `self.0.update_from_arg_matches(matches)`, and returns the resulting `Result<(), clap::Error>`.

**Call relations**: This is the mutable parsing counterpart to `from_arg_matches`, used by Clap’s update machinery rather than initial construction.


##### `mark_exec_global_args`  (lines 157–163)

```
fn mark_exec_global_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: Marks selected inherited arguments as global on a Clap command so they can appear before or after subcommands. The affected flags are `model`, `dangerously_bypass_approvals_and_sandbox`, and `bypass_hook_trust`.

**Data flow**: It takes a `clap::Command`, applies chained `mut_arg` calls to set `global(true)` on three named arguments, and returns the modified command.

**Call relations**: This helper is called only from the `ExecSharedCliOptions` Clap trait implementations. It centralizes the exec-specific parser tweak so both parser-construction paths stay aligned.

*Call graph*: called by 2 (augment_args, augment_args_for_update); 1 external calls (mut_arg).


##### `ResumeArgs::from`  (lines 226–241)

```
fn from(raw: ResumeArgsRaw) -> Self
```

**Purpose**: Converts the raw Clap-shaped resume arguments into the semantic `ResumeArgs` used by the application. Its key job is reinterpreting the first positional as a prompt when `--last` is set and no explicit prompt positional was provided.

**Data flow**: It consumes `ResumeArgsRaw`, inspects `raw.last` and `raw.prompt`, computes a `(session_id, prompt)` pair where `raw.session_id` may be moved into `prompt`, then returns a new `ResumeArgs` carrying the adjusted fields plus `last`, `all`, and `images` unchanged.

**Call relations**: This conversion is used by the `FromArgMatches` implementation for `ResumeArgs` and by update parsing. It encapsulates the conditional positional-meaning workaround that Clap cannot express declaratively.


##### `ResumeArgs::augment_args`  (lines 245–247)

```
fn augment_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: Defines the Clap argument schema for semantic `ResumeArgs` by reusing the raw parser shape. The semantic type itself does not declare flags directly.

**Data flow**: It accepts a `clap::Command`, forwards it to `ResumeArgsRaw::augment_args`, and returns the resulting command unchanged.

**Call relations**: Clap invokes this while building the parser for the `resume` subcommand. The function exists so `ResumeArgs` can expose custom post-processing while still borrowing the raw argument layout.

*Call graph*: 1 external calls (augment_args).


##### `ResumeArgs::augment_args_for_update`  (lines 249–251)

```
fn augment_args_for_update(cmd: clap::Command) -> clap::Command
```

**Purpose**: Provides the update-mode Clap schema for `ResumeArgs` by delegating to `ResumeArgsRaw`. It keeps update parsing identical to initial parsing.

**Data flow**: It takes a `clap::Command`, passes it to `ResumeArgsRaw::augment_args_for_update`, and returns the resulting command.

**Call relations**: This is the update-path counterpart to `ResumeArgs::augment_args`, used by Clap internals.

*Call graph*: 1 external calls (augment_args_for_update).


##### `ResumeArgs::from_arg_matches`  (lines 255–257)

```
fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error>
```

**Purpose**: Parses resume arguments from Clap matches and then applies the semantic reinterpretation logic from `ResumeArgs::from`. It turns raw positional parsing into the final application-facing structure.

**Data flow**: It reads `&clap::ArgMatches`, calls `ResumeArgsRaw::from_arg_matches`, maps the parsed raw value through `Self::from`, and returns `Result<ResumeArgs, clap::Error>`.

**Call relations**: Clap calls this to instantiate `ResumeArgs` for the `resume` subcommand. It delegates extraction to the raw type and semantic normalization to the conversion function.

*Call graph*: 1 external calls (from_arg_matches).


##### `ResumeArgs::update_from_arg_matches`  (lines 259–262)

```
fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error>
```

**Purpose**: Replaces an existing `ResumeArgs` value with a freshly parsed and normalized one from Clap matches. It ensures the same `--last` positional reinterpretation applies during updates.

**Data flow**: It takes `&mut self` and `&clap::ArgMatches`, parses a `ResumeArgsRaw` from the matches, converts it with `Self::from`, assigns the result into `*self`, and returns `Ok(())` or a Clap error.

**Call relations**: This is used by Clap’s update mechanism rather than initial construction. It mirrors `from_arg_matches` but writes into an existing value.

*Call graph*: 1 external calls (from_arg_matches).


### `cloud-tasks/src/cli.rs`

`config` · `startup`

This file is the clap-facing CLI definition for the `codex cloud` command family. The top-level `Cli` struct carries config overrides plus an optional `Command` subcommand. The `Command` enum enumerates the supported non-TUI modes: `Exec`, `Status`, `List`, `Apply`, and `Diff`. Each subcommand has its own `Args` struct with concrete fields and help text, including environment selection, branch override, pagination cursor, JSON output toggle, and optional attempt selection.

The only executable logic here is input validation for bounded numeric flags. `parse_attempts` accepts only integers from 1 through 4, which is reused for both `exec --attempts` and `apply/diff --attempt`. `parse_limit` accepts only integers from 1 through 20 for paginated listing. Both functions return user-facing error strings tailored for clap to display directly.

A notable design choice is that environment selection for `ExecCommand` is required and represented as a string rather than an enum or ID wrapper; resolution to a concrete environment ID happens later in runtime logic. Similarly, task IDs are accepted as raw strings here and normalized elsewhere.

#### Function details

##### `parse_attempts`  (lines 52–61)

```
fn parse_attempts(input: &str) -> Result<usize, String>
```

**Purpose**: Validates that an attempts argument is an integer between 1 and 4 inclusive.

**Data flow**: It takes the raw string from clap, tries to parse it as `usize`, maps parse failures to `"attempts must be an integer between 1 and 4"`, then returns `Ok(value)` if `1..=4` contains it or `Err("attempts must be between 1 and 4")` otherwise.

**Call relations**: Clap invokes this parser for `ExecCommand.attempts` and the optional `attempt` fields on apply and diff commands so invalid values are rejected before runtime logic starts.


##### `parse_limit`  (lines 63–72)

```
fn parse_limit(input: &str) -> Result<i64, String>
```

**Purpose**: Validates that a list limit argument is an integer between 1 and 20 inclusive.

**Data flow**: It takes the raw string from clap, parses it as `i64`, maps parse failures to `"limit must be an integer between 1 and 20"`, then returns `Ok(value)` if it falls within `1..=20` or `Err("limit must be between 1 and 20")` otherwise.

**Call relations**: Clap uses this parser for `ListCommand.limit`, ensuring pagination requests stay within the backend/UI-supported range.


### `cloud-tasks/src/lib.rs`

`orchestration` · `startup, command dispatch, main loop, request handling, teardown`

This is the main orchestration file for the cloud-tasks feature. It wires together CLI parsing, backend setup, git branch discovery, environment resolution, task formatting, apply/preflight background jobs, and the interactive terminal UI. `init_backend` chooses between the debug mock backend and the real HTTP client, configures user agent and auth, validates that the login is a ChatGPT/Codex backend session, and returns both the backend object and base URL. Small helpers normalize branch selection (`resolve_git_ref_with_git_info`), parse task IDs from raw IDs or URLs, collect and sort alternate attempt diffs, and format task summaries for plain-text CLI output.

The CLI subcommands are thin wrappers around those helpers: `exec` resolves prompt/environment/branch and prints the created task URL; `status` prints formatted status lines and exits nonzero unless the task is ready; `list` prints either JSON or formatted text with pagination hints; `diff` prints the selected attempt’s diff; and `apply` applies the selected attempt and exits nonzero on non-success.

The largest component is `run_main`, which either dispatches to a subcommand or launches the TUI. The TUI path sets up tracing and terminal modes, initializes `App`, spawns background tasks for initial task load, environment listing, and environment autodetection, then runs a `tokio::select!` loop over redraw timers, background `AppEvent`s, and crossterm input events. That loop coordinates modal precedence, spinner scheduling, task refresh races, detail overlay population, sibling-attempt loading, new-task submission, and apply/preflight workflows. Terminal restoration is handled best-effort on exit. The file also includes user-facing helpers for rendering conversation text and condensing verbose backend errors into readable overlay lines, plus tests for branch resolution, formatting, attempt selection, task ID parsing, and composer rendering.

#### Function details

##### `init_backend`  (lines 43–107)

```
async fn init_backend(user_agent_suffix: &str) -> anyhow::Result<BackendContext>
```

**Purpose**: Constructs the backend context used by both CLI commands and the TUI, including base URL selection, user-agent setup, optional mock backend selection, auth loading, and HTTP client authentication wiring.

**Data flow**: It reads `CODEX_CLOUD_TASKS_BASE_URL` and, in debug builds, `CODEX_CLOUD_TASKS_MODE`; updates the global user-agent suffix; optionally returns a mock backend immediately; otherwise builds an `HttpClient`, logs startup path style, loads auth manager state, awaits auth, exits the process with a login message if auth is missing or not a Codex backend session, logs account ID details when present, converts auth into a shared auth provider, attaches it to the HTTP client, and returns `BackendContext { backend: Arc<dyn CloudBackend>, base_url }`.

**Call relations**: All command paths and the TUI call this first. It delegates HTTP client construction to `HttpClient::new` and auth loading/header setup to utility modules.

*Call graph*: calls 5 internal fn (new, append_error_log, load_auth_manager, set_user_agent_suffix, get_codex_user_agent); called by 6 (run_apply_command, run_diff_command, run_exec_command, run_list_command, run_main, run_status_command); 7 external calls (new, auth_provider_from_auth, eprintln!, format!, matches!, var, exit).


##### `RealGitInfo::default_branch_name`  (lines 124–126)

```
async fn default_branch_name(&self, path: &std::path::Path) -> Option<String>
```

**Purpose**: Adapts the real git utility function into the `GitInfoProvider` trait.

**Data flow**: It takes a filesystem path and awaits `codex_git_utils::default_branch_name(path)`, returning the resulting `Option<String>` unchanged.

**Call relations**: Used indirectly by `resolve_git_ref_with_git_info` through the production `RealGitInfo` implementation.

*Call graph*: 1 external calls (default_branch_name).


##### `RealGitInfo::current_branch_name`  (lines 128–130)

```
async fn current_branch_name(&self, path: &std::path::Path) -> Option<String>
```

**Purpose**: Adapts the real current-branch lookup into the `GitInfoProvider` trait.

**Data flow**: It takes a filesystem path and awaits `codex_git_utils::current_branch_name(path)`, returning the resulting `Option<String>` unchanged.

**Call relations**: Used indirectly by `resolve_git_ref_with_git_info` through the production `RealGitInfo` implementation.

*Call graph*: 1 external calls (current_branch_name).


##### `resolve_git_ref`  (lines 133–135)

```
async fn resolve_git_ref(branch_override: Option<&String>) -> String
```

**Purpose**: Resolves the git ref to use for task creation using the real git provider.

**Data flow**: It takes an optional branch override reference and forwards it to `resolve_git_ref_with_git_info(branch_override, &RealGitInfo).await`, returning the chosen branch string.

**Call relations**: Called by task-creation flows so they do not need to know about the `GitInfoProvider` abstraction.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); called by 1 (run_exec_command).


##### `resolve_git_ref_with_git_info`  (lines 137–159)

```
async fn resolve_git_ref_with_git_info(
    branch_override: Option<&String>,
    git_info: &impl GitInfoProvider,
) -> String
```

**Purpose**: Chooses the git ref for task creation by preferring a non-empty explicit override, then the current branch, then the default branch, and finally `main`.

**Data flow**: It takes an optional branch override and a `GitInfoProvider`. If the override exists and trims to a non-empty string, it returns that trimmed value. Otherwise it reads the current working directory, asks the provider for `current_branch_name`, falls back to `default_branch_name`, and if both are absent or `current_dir` fails returns `"main"`.

**Call relations**: Used by production code through `resolve_git_ref` and directly by tests with `StubGitInfo` to verify branch-selection precedence.

*Call graph*: called by 6 (resolve_git_ref, branch_override_is_used_when_provided, falls_back_to_current_branch_when_default_is_missing, falls_back_to_main_when_no_git_info_is_available, prefers_current_branch_when_available, trims_override_whitespace); 3 external calls (current_branch_name, default_branch_name, current_dir).


##### `run_exec_command`  (lines 161–184)

```
async fn run_exec_command(args: crate::cli::ExecCommand) -> anyhow::Result<()>
```

**Purpose**: Implements `codex cloud exec` by resolving prompt, environment, and git ref, creating a new cloud task, and printing its URL.

**Data flow**: It destructures `ExecCommand`, initializes the backend, resolves the prompt via `resolve_query_input`, resolves the environment string to a concrete environment ID via `resolve_environment_id`, resolves the git ref, calls `CloudBackend::create_task` with QA mode false and the requested attempt count, converts the created task ID into a browser URL with `util::task_url`, and prints that URL.

**Call relations**: Dispatched from `run_main` when the `Exec` subcommand is selected. It delegates all validation and backend interaction to helper functions.

*Call graph*: calls 5 internal fn (init_backend, resolve_environment_id, resolve_git_ref, resolve_query_input, task_url); called by 1 (run_main); 2 external calls (create_task, println!).


##### `resolve_environment_id`  (lines 186–229)

```
async fn resolve_environment_id(ctx: &BackendContext, requested: &str) -> anyhow::Result<String>
```

**Purpose**: Resolves a user-supplied environment token to a concrete environment ID by matching either exact IDs or case-insensitive labels from the discovered environment list.

**Data flow**: It trims the requested string and errors if empty, normalizes the backend base URL, builds ChatGPT headers, fetches available environments with `env_detect::list_environments`, errors if none exist, returns the exact matching row ID if any row’s `id` equals the trimmed input, otherwise collects case-insensitive label matches and returns the unique matching ID, the shared ID if all matches point to the same environment, or an ambiguity/not-found error.

**Call relations**: Used by both `run_exec_command` and `run_list_command` before making backend requests that require a concrete environment ID.

*Call graph*: calls 3 internal fn (list_environments, build_chatgpt_headers, normalize_base_url); called by 2 (run_exec_command, run_list_command); 1 external calls (anyhow!).


##### `resolve_query_input`  (lines 231–256)

```
fn resolve_query_input(query_arg: Option<String>) -> anyhow::Result<String>
```

**Purpose**: Obtains the task prompt either from the CLI argument or from stdin, with explicit handling for `-` and empty interactive stdin.

**Data flow**: It takes an optional query string. If it is `Some(q)` and not `"-"`, it returns `q`. Otherwise it determines whether stdin is forced, errors immediately when stdin is a terminal and not forced, optionally prints `Reading query from stdin...`, reads all of stdin into a buffer, errors if the trimmed buffer is empty, and returns the raw buffer string.

**Call relations**: Used only by `run_exec_command` to support both direct arguments and piped prompts.

*Call graph*: called by 1 (run_exec_command); 5 external calls (new, anyhow!, eprintln!, matches!, stdin).


##### `parse_task_id`  (lines 258–277)

```
fn parse_task_id(raw: &str) -> anyhow::Result<codex_cloud_tasks_client::TaskId>
```

**Purpose**: Normalizes a task identifier from either a raw ID or a full task URL by stripping whitespace, fragments, queries, and path prefixes.

**Data flow**: It trims the input, errors if empty, removes any `#fragment`, removes any `?query`, takes the last path segment after `/`, trims again, errors if the resulting ID is empty, and returns `TaskId(id.to_string())`.

**Call relations**: Used by status, diff, and apply CLI commands, and exercised directly by tests.

*Call graph*: called by 5 (run_apply_command, run_diff_command, run_status_command, collect_attempt_diffs_includes_sibling_attempts, parse_task_id_from_url_and_raw); 2 external calls (bail!, TaskId).


##### `cmp_attempt`  (lines 286–298)

```
fn cmp_attempt(lhs: &AttemptDiffData, rhs: &AttemptDiffData) -> Ordering
```

**Purpose**: Orders attempt diffs by placement first and creation time second.

**Data flow**: It compares two `AttemptDiffData` values by `placement` when present, otherwise by `created_at`, and returns `Ordering::Equal` if neither field distinguishes them.

**Call relations**: Used by `collect_attempt_diffs` to sort the base diff and sibling diffs into a stable attempt order.


##### `collect_attempt_diffs`  (lines 300–341)

```
async fn collect_attempt_diffs(
    backend: &dyn codex_cloud_tasks_client::CloudBackend,
    task_id: &codex_cloud_tasks_client::TaskId,
) -> anyhow::Result<Vec<AttemptDiffData>>
```

**Purpose**: Builds the list of applyable/displayable diffs for a task by combining the base task diff with any sibling attempt diffs and sorting them.

**Data flow**: It takes a backend and task ID, fetches `TaskText` to learn the base attempt placement and current turn ID, fetches the base task diff and pushes it when present, fetches sibling attempts when `turn_id` exists, pushes each sibling that has a diff into an `AttemptDiffData` vector, sorts the vector with `cmp_attempt`, errors if no diffs were found, and returns the sorted attempts.

**Call relations**: Shared by `run_diff_command` and `run_apply_command`, and tested against the mock backend to verify sibling attempts are included.

*Call graph*: called by 3 (run_apply_command, run_diff_command, collect_attempt_diffs_includes_sibling_attempts); 6 external calls (new, bail!, get_task_diff, get_task_text, list_sibling_attempts, clone).


##### `select_attempt`  (lines 343–361)

```
fn select_attempt(
    attempts: &[AttemptDiffData],
    attempt: Option<usize>,
) -> anyhow::Result<&AttemptDiffData>
```

**Purpose**: Selects a 1-based attempt number from a sorted attempt list and validates bounds.

**Data flow**: It takes a slice of `AttemptDiffData` and an optional desired attempt number, defaults to 1, converts to zero-based with `checked_sub(1)`, errors if the result underflows or exceeds the slice length, and returns a reference to the chosen attempt.

**Call relations**: Used by both diff and apply CLI commands after `collect_attempt_diffs` has assembled the available attempts.

*Call graph*: called by 3 (run_apply_command, run_diff_command, select_attempt_validates_bounds); 3 external calls (bail!, is_empty, len).


##### `task_status_label`  (lines 363–370)

```
fn task_status_label(status: &TaskStatus) -> &'static str
```

**Purpose**: Maps `TaskStatus` enum values to uppercase display labels.

**Data flow**: It matches the input status and returns one of the static strings `PENDING`, `READY`, `APPLIED`, or `ERROR`.

**Call relations**: Used by `format_task_status_lines` as the base status text before optional colorization.

*Call graph*: called by 1 (format_task_status_lines).


##### `summary_line`  (lines 372–409)

```
fn summary_line(summary: &codex_cloud_tasks_client::DiffSummary, colorize: bool) -> String
```

**Purpose**: Formats a task’s diff summary as either `no diff` or a `+adds/-dels • N files` line, optionally colorized.

**Data flow**: It reads `files_changed`, `lines_added`, and `lines_removed` from a `DiffSummary`. If all are zero it returns `no diff` dimmed when colorization is enabled. Otherwise it formats additions, deletions, and file count, applying green/red/dim styling when requested, and returns the resulting string.

**Call relations**: Used by `format_task_status_lines` to produce the third line of task status output.

*Call graph*: called by 1 (format_task_status_lines); 1 external calls (format!).


##### `format_task_status_lines`  (lines 411–476)

```
fn format_task_status_lines(
    task: &codex_cloud_tasks_client::TaskSummary,
    now: chrono::DateTime<Utc>,
    colorize: bool,
) -> Vec<String>
```

**Purpose**: Builds the multi-line plain-text or colorized status block for a single task.

**Data flow**: It takes a `TaskSummary`, current time, and colorization flag; formats the status label via `task_status_label`, colorizes it by status when requested, builds the title line, builds metadata parts from environment label or ID plus relative time from `format_relative_time`, joins metadata with a dimmed or plain separator, appends the diff summary from `summary_line`, and returns the three-line vector.

**Call relations**: Used by `run_status_command` for single-task output and by `format_task_list_lines` for list output. Several tests verify its formatting behavior.

*Call graph*: calls 3 internal fn (summary_line, task_status_label, format_relative_time); called by 4 (format_task_list_lines, run_status_command, format_task_status_lines_with_diff_and_label, format_task_status_lines_without_diff_falls_back); 2 external calls (new, format!).


##### `format_task_list_lines`  (lines 478–495)

```
fn format_task_list_lines(
    tasks: &[codex_cloud_tasks_client::TaskSummary],
    base_url: &str,
    now: chrono::DateTime<Utc>,
    colorize: bool,
) -> Vec<String>
```

**Purpose**: Formats a whole task page as URL-prefixed blocks separated by blank lines.

**Data flow**: It iterates over the provided tasks with index, pushes each task URL from `util::task_url`, appends each line from `format_task_status_lines` indented by two spaces, and inserts an empty separator line between tasks except after the last one.

**Call relations**: Used by `run_list_command` for human-readable list output and covered by a formatting test.

*Call graph*: calls 2 internal fn (format_task_status_lines, task_url); called by 2 (run_list_command, format_task_list_lines_formats_urls); 5 external calls (new, new, iter, len, format!).


##### `run_status_command`  (lines 497–511)

```
async fn run_status_command(args: crate::cli::StatusCommand) -> anyhow::Result<()>
```

**Purpose**: Implements `codex cloud status` by fetching one task summary, printing formatted status lines, and exiting nonzero unless the task is ready.

**Data flow**: It initializes the backend, parses the task ID, fetches the summary via `CloudBackend::get_task_summary`, computes `now` and whether stdout supports color, prints each line from `format_task_status_lines`, and calls `std::process::exit(1)` if the status is not `Ready`.

**Call relations**: Dispatched from `run_main` for the `Status` subcommand.

*Call graph*: calls 3 internal fn (format_task_status_lines, init_backend, parse_task_id); called by 1 (run_main); 6 external calls (now, get_task_summary, matches!, println!, exit, on).


##### `run_list_command`  (lines 513–578)

```
async fn run_list_command(args: crate::cli::ListCommand) -> anyhow::Result<()>
```

**Purpose**: Implements `codex cloud list` by optionally resolving an environment filter, fetching one page of tasks, and printing either JSON or formatted text with pagination guidance.

**Data flow**: It initializes the backend, optionally resolves `args.environment` to an environment ID, calls `CloudBackend::list_tasks` with the requested limit and cursor, and then either serializes a JSON payload containing task URLs and summary fields or prints human-readable lines from `format_task_list_lines`. If the page is empty it prints `No tasks found.`; if a cursor is present it prints a follow-up command hint.

**Call relations**: Dispatched from `run_main` for the `List` subcommand. It delegates environment resolution and formatting to helpers in this file and `util`.

*Call graph*: calls 3 internal fn (format_task_list_lines, init_backend, resolve_environment_id); called by 1 (run_main); 6 external calls (now, list_tasks, format!, println!, json!, on).


##### `run_diff_command`  (lines 580–587)

```
async fn run_diff_command(args: crate::cli::DiffCommand) -> anyhow::Result<()>
```

**Purpose**: Implements `codex cloud diff` by selecting an attempt and printing its raw diff.

**Data flow**: It initializes the backend, parses the task ID, gathers available attempt diffs with `collect_attempt_diffs`, selects the requested or first attempt with `select_attempt`, and prints `selected.diff` directly to stdout.

**Call relations**: Dispatched from `run_main` for the `Diff` subcommand.

*Call graph*: calls 4 internal fn (collect_attempt_diffs, init_backend, parse_task_id, select_attempt); called by 1 (run_main); 1 external calls (print!).


##### `run_apply_command`  (lines 589–608)

```
async fn run_apply_command(args: crate::cli::ApplyCommand) -> anyhow::Result<()>
```

**Purpose**: Implements `codex cloud apply` by selecting an attempt diff, applying it through the backend, printing the outcome message, and exiting nonzero on non-success.

**Data flow**: It initializes the backend, parses the task ID, gathers and selects attempt diffs, calls `CloudBackend::apply_task` with the selected diff as `diff_override`, prints `outcome.message`, and exits with code 1 unless `outcome.status` is `ApplyStatus::Success`.

**Call relations**: Dispatched from `run_main` for the `Apply` subcommand. It shares attempt-selection logic with `run_diff_command`.

*Call graph*: calls 4 internal fn (collect_attempt_diffs, init_backend, parse_task_id, select_attempt); called by 1 (run_main); 4 external calls (apply_task, matches!, println!, exit).


##### `level_from_status`  (lines 610–616)

```
fn level_from_status(status: codex_cloud_tasks_client::ApplyStatus) -> app::ApplyResultLevel
```

**Purpose**: Converts backend `ApplyStatus` values into the UI-specific `ApplyResultLevel` enum.

**Data flow**: It matches `Success`, `Partial`, or `Error` and returns the corresponding `app::ApplyResultLevel` variant.

**Call relations**: Used by `spawn_preflight` when translating backend outcomes into `AppEvent::ApplyPreflightFinished`.

*Call graph*: called by 1 (spawn_preflight).


##### `spawn_preflight`  (lines 618–678)

```
fn spawn_preflight(
    app: &mut app::App,
    backend: &Arc<dyn codex_cloud_tasks_client::CloudBackend>,
    tx: &UnboundedSender<app::AppEvent>,
    frame_tx: &UnboundedSender<Instant>,
    title:
```

**Purpose**: Starts a background preflight apply job if no other apply/preflight is running, updates app spinner state, and arranges for an `ApplyPreflightFinished` event to be sent back.

**Data flow**: It takes mutable app state, backend and channel handles, a title, and an `ApplyJob`. It rejects the request with a status message if `apply_inflight` or `apply_preflight_inflight` is already true. Otherwise it sets `app.apply_preflight_inflight = true`, schedules a near-term frame, clones the backend and sender, spawns a task that calls `CloudBackend::apply_task_preflight`, maps success into an event carrying message/level/skipped/conflicts or maps errors into an error-level event with empty path lists, and sends that event on `tx`. It returns `true` when spawned and `false` when rejected.

**Call relations**: Called from TUI key handling when opening or re-running apply preflight. It delegates status conversion to `level_from_status` and backend work to the `CloudBackend` trait.

*Call graph*: calls 1 internal fn (level_from_status); 8 external calls (from_millis, now, clone, send, new, apply_task_preflight, format!, spawn).


##### `spawn_apply`  (lines 680–728)

```
fn spawn_apply(
    app: &mut app::App,
    backend: &Arc<dyn codex_cloud_tasks_client::CloudBackend>,
    tx: &UnboundedSender<app::AppEvent>,
    frame_tx: &UnboundedSender<Instant>,
    job: ApplyJ
```

**Purpose**: Starts a background real apply job if no conflicting apply/preflight is running, updates app spinner state, and arranges for an `ApplyFinished` event to be sent back.

**Data flow**: It checks and updates `app.apply_inflight` similarly to `spawn_preflight`, schedules a frame, clones backend and sender, spawns a task that calls `CloudBackend::apply_task`, wraps the result into `AppEvent::ApplyFinished { id, result }`, and sends it on `tx`. It returns whether the job was started.

**Call relations**: Called from TUI apply-modal key handling when the user confirms actual application.

*Call graph*: 7 external calls (from_millis, now, clone, send, apply_task, format!, spawn).


##### `run_main`  (lines 735–2020)

```
async fn run_main(cli: Cli, _codex_linux_sandbox_exe: Option<PathBuf>) -> anyhow::Result<()>
```

**Purpose**: Acts as the top-level entrypoint for the cloud-tasks feature, dispatching CLI subcommands or running the full interactive TUI with background loading, modal handling, and terminal lifecycle management.

**Data flow**: It first checks `cli.command` and dispatches to the corresponding command handler when present. Otherwise it initializes tracing, backend context, terminal raw/alternate-screen state, and `app::App`; logs startup details; spawns background tasks for initial task loading, environment listing, and environment autodetection; creates redraw and app-event channels; and enters a `tokio::select!` loop over redraw ticks, background `AppEvent`s, and crossterm events. Inside that loop it updates app state for task refreshes, new-task submission, environment selection, detail overlay population, sibling-attempt loading, apply/preflight completion, paste bursts, composer input, modal navigation, list navigation, and task opening. On exit it restores terminal modes and exits the process if a nonzero code was chosen.

**Call relations**: This is the file’s central orchestrator and the public entrypoint used by the binary. It invokes nearly every helper in this crate and coordinates all background/backend interactions through `AppEvent` messages.

*Call graph*: calls 13 internal fn (new, load_tasks, autodetect_environment_id, list_environments, init_backend, run_apply_command, run_diff_command, run_exec_command, run_list_command, run_status_command (+3 more)); 21 external calls (clone, new, try_from_default_env, new, now, from_std, EnvironmentAutodetected, EnvironmentsLoaded, execute!, format! (+11 more)).


##### `conversation_lines`  (lines 2025–2049)

```
fn conversation_lines(prompt: Option<String>, messages: &[String]) -> Vec<String>
```

**Purpose**: Formats a prompt and assistant message list into labeled plain-text lines for the detail overlay.

**Data flow**: It starts with an empty vector, appends `user:` plus each prompt line and a blank separator when a prompt exists, appends `assistant:` plus each message split into lines with blank lines between messages when any messages exist, and if nothing was added returns a single `"<no output>"` line.

**Call relations**: Used by the TUI when converting `TaskText` and sibling-attempt messages into overlay content.

*Call graph*: 2 external calls (new, new).


##### `pretty_lines_from_error`  (lines 2053–2129)

```
fn pretty_lines_from_error(raw: &str) -> Vec<String>
```

**Purpose**: Condenses verbose backend/HTTP detail-load errors into a short set of user-facing overlay lines, optionally extracting structured assistant error information from embedded JSON.

**Data flow**: It starts with a generic first line based on whether the raw error mentions missing diff or missing assistant messages. It then looks for ` body=` followed by JSON, parses that JSON when possible, extracts `current_assistant_turn` or `current_diff_task_turn`, and from there pulls `error.code`, `error.message`, `turn_status`, and `latest_event.text` into additional lines. If parsing yields nothing, it appends a trimmed raw-message tail; if it found multiple lines and any mention `in_progress`, it adds a refresh hint and a trailing blank line.

**Call relations**: Used by the TUI detail-failure path to turn backend diagnostics into readable overlay content.

*Call graph*: 3 external calls (new, new, format!).


##### `tests::StubGitInfo::new`  (lines 2155–2160)

```
fn new(default_branch: Option<String>, current_branch: Option<String>) -> Self
```

**Purpose**: Constructs a test git-info provider with predetermined default and current branch answers.

**Data flow**: It takes optional default and current branch strings and stores them in a `StubGitInfo` struct.

**Call relations**: Used by branch-resolution tests to control `resolve_git_ref_with_git_info` behavior.


##### `tests::StubGitInfo::default_branch_name`  (lines 2164–2166)

```
async fn default_branch_name(&self, _path: &std::path::Path) -> Option<String>
```

**Purpose**: Returns the stubbed default branch value for tests.

**Data flow**: It ignores the path and clones `self.default_branch`.

**Call relations**: Called indirectly by `resolve_git_ref_with_git_info` in tests.


##### `tests::StubGitInfo::current_branch_name`  (lines 2168–2170)

```
async fn current_branch_name(&self, _path: &std::path::Path) -> Option<String>
```

**Purpose**: Returns the stubbed current branch value for tests.

**Data flow**: It ignores the path and clones `self.current_branch`.

**Call relations**: Called indirectly by `resolve_git_ref_with_git_info` in tests.


##### `tests::branch_override_is_used_when_provided`  (lines 2174–2182)

```
async fn branch_override_is_used_when_provided()
```

**Purpose**: Verifies that an explicit branch override wins over any git-derived branch information.

**Data flow**: It calls `resolve_git_ref_with_git_info` with a non-empty override and a stub provider lacking branch data, awaits the result, and asserts that the override string is returned unchanged.

**Call relations**: Exercises the highest-precedence branch-selection path.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::trims_override_whitespace`  (lines 2185–2193)

```
async fn trims_override_whitespace()
```

**Purpose**: Verifies that branch overrides are trimmed before use.

**Data flow**: It passes a whitespace-padded override into `resolve_git_ref_with_git_info`, awaits the result, and asserts that the returned branch omits surrounding spaces.

**Call relations**: Covers the normalization branch inside `resolve_git_ref_with_git_info`.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::prefers_current_branch_when_available`  (lines 2196–2207)

```
async fn prefers_current_branch_when_available()
```

**Purpose**: Verifies that the current branch is preferred over the default branch when no override is supplied.

**Data flow**: It calls `resolve_git_ref_with_git_info` with no override and a stub provider containing both current and default branches, then asserts that the current branch is chosen.

**Call relations**: Tests the main fallback ordering in branch resolution.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::falls_back_to_current_branch_when_default_is_missing`  (lines 2210–2218)

```
async fn falls_back_to_current_branch_when_default_is_missing()
```

**Purpose**: Verifies that a present current branch is used even when no default branch exists.

**Data flow**: It calls `resolve_git_ref_with_git_info` with no override and a stub provider containing only `current_branch`, then asserts that value is returned.

**Call relations**: Covers one fallback case in branch resolution.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::falls_back_to_main_when_no_git_info_is_available`  (lines 2221–2229)

```
async fn falls_back_to_main_when_no_git_info_is_available()
```

**Purpose**: Verifies that branch resolution ultimately falls back to `main` when neither current nor default branch can be determined.

**Data flow**: It calls `resolve_git_ref_with_git_info` with no override and a stub provider returning `None` for both branch queries, then asserts that the result is `main`.

**Call relations**: Covers the terminal fallback branch in branch resolution.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::format_task_status_lines_with_diff_and_label`  (lines 2232–2258)

```
fn format_task_status_lines_with_diff_and_label()
```

**Purpose**: Checks the non-colorized formatting of a ready task that has an environment label and nonzero diff stats.

**Data flow**: It constructs a `TaskSummary` with known values, calls `format_task_status_lines(..., false)`, and asserts the exact three output lines.

**Call relations**: Tests the combined behavior of status labeling, metadata formatting, relative time formatting, and diff summary formatting.

*Call graph*: calls 1 internal fn (format_task_status_lines); 3 external calls (now, assert_eq!, new).


##### `tests::format_task_status_lines_without_diff_falls_back`  (lines 2261–2283)

```
fn format_task_status_lines_without_diff_falls_back()
```

**Purpose**: Checks that tasks with zero diff stats render `no diff` and fall back to environment ID when no label exists.

**Data flow**: It builds a pending task with `DiffSummary::default()`, calls `format_task_status_lines(..., false)`, and asserts the exact output lines.

**Call relations**: Exercises the zero-diff branch in `summary_line` and the environment-ID fallback in `format_task_status_lines`.

*Call graph*: calls 1 internal fn (format_task_status_lines); 4 external calls (now, assert_eq!, default, new).


##### `tests::format_task_list_lines_formats_urls`  (lines 2286–2336)

```
fn format_task_list_lines_formats_urls()
```

**Purpose**: Verifies that list formatting prepends task URLs and inserts blank lines between task blocks.

**Data flow**: It constructs two `TaskSummary` values, calls `format_task_list_lines` with a backend base URL and `colorize = false`, and asserts the exact resulting vector of lines.

**Call relations**: Tests the composition of `task_url`, `format_task_status_lines`, indentation, and inter-task spacing.

*Call graph*: calls 1 internal fn (format_task_list_lines); 3 external calls (now, assert_eq!, vec!).


##### `tests::collect_attempt_diffs_includes_sibling_attempts`  (lines 2339–2350)

```
async fn collect_attempt_diffs_includes_sibling_attempts()
```

**Purpose**: Verifies that attempt collection includes both the base diff and sibling attempt diffs from the mock backend.

**Data flow**: It creates a `MockClient`, parses a task URL into `TaskId`, awaits `collect_attempt_diffs`, and asserts that two attempts are returned with placements 0 and 1 and non-empty diffs.

**Call relations**: Exercises the integration of `get_task_text`, `get_task_diff`, and `list_sibling_attempts` inside `collect_attempt_diffs`.

*Call graph*: calls 2 internal fn (collect_attempt_diffs, parse_task_id); 2 external calls (assert!, assert_eq!).


##### `tests::select_attempt_validates_bounds`  (lines 2353–2362)

```
fn select_attempt_validates_bounds()
```

**Purpose**: Verifies that attempt selection returns the requested attempt when valid and errors when out of range.

**Data flow**: It builds a one-element attempt vector, calls `select_attempt` with `Some(1)` and asserts the diff, then calls it with `Some(2)` and asserts that an error is returned.

**Call relations**: Covers both success and bounds-check failure paths in `select_attempt`.

*Call graph*: calls 1 internal fn (select_attempt); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::parse_task_id_from_url_and_raw`  (lines 2365–2372)

```
fn parse_task_id_from_url_and_raw()
```

**Purpose**: Verifies that task ID parsing accepts both raw IDs and full URLs and rejects blank input.

**Data flow**: It calls `parse_task_id` on a raw ID and a URL containing a query string, asserts the normalized IDs, and asserts that whitespace-only input returns an error.

**Call relations**: Tests the normalization logic in `parse_task_id`.

*Call graph*: calls 1 internal fn (parse_task_id); 2 external calls (assert!, assert_eq!).


##### `tests::composer_input_renders_typed_characters`  (lines 2376–2401)

```
fn composer_input_renders_typed_characters()
```

**Purpose**: Checks that the composer widget used by the new-task page renders typed input and configured footer hints.

**Data flow**: It creates a `ComposerInput`, feeds it a typed `a` key event, renders into a `ratatui::Buffer`, asserts that the character appears, then sets hint items, re-renders, extracts the footer row, and asserts that the `⌃O env` hint is present.

**Call relations**: This test indirectly validates assumptions made by the new-task UI path in `run_main` and `new_task.rs`.

*Call graph*: calls 1 internal fn (new); 7 external calls (empty, Char, new, new, assert!, panic!, vec!).


### Desktop and remote app-server launch
These commands open the desktop app or start remote-control app-server modes, including platform-specific desktop launch behavior.

### `cli/src/app_cmd.rs`

`orchestration` · `CLI command dispatch`

This file contains the `AppCommand` argument struct and the async `run_app` dispatcher. `AppCommand` derives `clap::Parser`, so its fields become command-line parameters: `path: PathBuf` is a positional argument named `PATH` defaulting to `.`, and `download_url_override: Option<String>` is exposed as `--download-url`. The runtime logic in `run_app` first canonicalizes the requested path with `std::fs::canonicalize`, but deliberately falls back to the original `PathBuf` if canonicalization fails; that preserves user intent for paths that do not yet fully resolve while still normalizing existing ones.

After computing `workspace`, the function delegates entirely to `crate::desktop_app::run_app_open_or_install` on supported desktop targets. The implementation is gated with `#[cfg(target_os = "macos")]` and `#[cfg(target_os = "windows")]`, so the file acts as a thin CLI-to-platform bridge rather than containing installation logic itself. The key design choice is that argument parsing and path normalization live here, while OS-specific app discovery, installation, and launching are pushed into the desktop-app subsystem.

#### Function details

##### `run_app`  (lines 15–25)

```
async fn run_app(cmd: AppCommand) -> anyhow::Result<()>
```

**Purpose**: Normalizes the requested workspace path and forwards the app-launch request to the desktop-app installer/opener for the current supported OS. It is the execution path behind the `app` CLI command.

**Data flow**: The function consumes an `AppCommand`, attempts to canonicalize `cmd.path`, and if that fails uses the original path unchanged. It then passes the resulting `workspace` `PathBuf` plus `cmd.download_url_override` into `run_app_open_or_install` and returns that async result. It reads the filesystem during canonicalization but otherwise maintains no local state.

**Call relations**: The top-level CLI entrypoint `cli_main` invokes this function when the parsed subcommand is `app`. `run_app` itself is a thin dispatcher: after path preparation it delegates all substantive work to `crate::desktop_app::run_app_open_or_install`.

*Call graph*: calls 1 internal fn (run_app_open_or_install); called by 1 (cli_main); 1 external calls (canonicalize).


### `cli/src/desktop_app/mod.rs`

`orchestration` · `request handling`

This module is a thin compile-time dispatcher for desktop app integration. It conditionally includes either the `mac` or `windows` submodule based on the target OS, and exposes a single public async function, `run_app_open_or_install`, whose implementation is selected by `#[cfg]`. The function accepts a workspace path as `std::path::PathBuf` plus an optional download URL override, then forwards both values unchanged to the platform-specific implementation.

The important design choice is that there is no runtime branching here: unsupported branches are removed at compile time, so each build only contains the relevant OS logic. That keeps callers such as `run_app` independent of platform details while still allowing the macOS and Windows implementations to diverge completely in transport, installer URL handling, and app-launch mechanics. The module itself owns no state, performs no validation, and adds no error context; any `anyhow::Result<()>` error comes directly from the delegated platform module. As a result, this file is best understood as the stable public seam between generic CLI flow and OS-specific desktop-app behavior.

#### Function details

##### `run_app_open_or_install`  (lines 17–22)

```
async fn run_app_open_or_install(
    workspace: std::path::PathBuf,
    download_url_override: Option<String>,
) -> anyhow::Result<()>
```

**Purpose**: Dispatches desktop workspace open/install behavior to the current platform implementation. On macOS builds it forwards to the mac module; on Windows builds it forwards to the windows module.

**Data flow**: Takes `workspace: PathBuf` and `download_url_override: Option<String>` from the caller, passes them through unchanged to the selected OS-specific async function, awaits that future, and returns its `anyhow::Result<()>` directly without modification.

**Call relations**: It is invoked by `run_app` when the CLI wants desktop-app behavior. Its only job in the call flow is to bridge from platform-agnostic command logic into either `run_mac_app_open_or_install` or `run_windows_app_open_or_install`, depending on the target build.

*Call graph*: calls 2 internal fn (run_mac_app_open_or_install, run_windows_app_open_or_install); called by 1 (run_app).


### `cli/src/desktop_app/mac.rs`

`orchestration` · `CLI app launch / install flow on macOS`

This file contains the full macOS desktop-app flow behind the CLI `app` command. `run_mac_app_open_or_install` first searches standard install locations via `find_existing_codex_app_path`; if `Codex.app` already exists, it opens it immediately with a deep link targeting the requested workspace. Otherwise it chooses a DMG URL, preferring `download_url_override` when supplied and otherwise selecting between `CODEX_DMG_URL_ARM64` and `CODEX_DMG_URL_X64` based on `is_apple_silicon_mac`, which checks both architecture and relevant `sysctl` flags for native or translated ARM execution.

Installation is staged in a temporary directory created by `tempfile::Builder`. `download_and_install_codex_to_user_applications` downloads the DMG with `curl`, mounts it read-only with `hdiutil attach`, locates an `.app` bundle in the mounted volume, installs it into `/Applications` or `~/Applications` using `ditto`, and always attempts `hdiutil detach` afterward, warning rather than failing if detach itself errors. `install_codex_app_bundle` tries candidate application directories in order, creating them if needed and short-circuiting if `Codex.app` already exists at the destination.

Launching uses `open_codex_app`, which builds a `codex://threads/new?path=...` URL through `codex_new_thread_url`; the path is encoded with `url::form_urlencoded::Serializer`, so spaces and `#` are preserved correctly as query data rather than breaking the URL. Tests cover mount-point parsing from `hdiutil` output and deep-link encoding semantics.

#### Function details

##### `run_mac_app_open_or_install`  (lines 12–42)

```
async fn run_mac_app_open_or_install(
    workspace: PathBuf,
    download_url_override: Option<String>,
) -> anyhow::Result<()>
```

**Purpose**: Top-level macOS flow that either opens an existing Codex Desktop installation or downloads, installs, and then launches it. It is the platform-specific implementation behind the generic desktop-app command.

**Data flow**: The function takes a workspace `PathBuf` and optional download URL override. It first calls `find_existing_codex_app_path`; if that returns a path, it prints a message and awaits `open_codex_app(app_path, workspace)`. Otherwise it prints that the app was not found, chooses a download URL from the override or from `is_apple_silicon_mac()` and the built-in ARM64/X64 constants, awaits `download_and_install_codex_to_user_applications`, prints the installed path, and then opens the app with the workspace deep link. It returns `Ok(())` on success or contextualized `anyhow` errors on failure.

**Call relations**: The higher-level desktop-app dispatcher calls this function on macOS. It orchestrates the whole flow by delegating discovery to `find_existing_codex_app_path`, installation to `download_and_install_codex_to_user_applications`, and launching to `open_codex_app`.

*Call graph*: calls 3 internal fn (download_and_install_codex_to_user_applications, find_existing_codex_app_path, open_codex_app); called by 1 (run_app_open_or_install); 1 external calls (eprintln!).


##### `is_apple_silicon_mac`  (lines 44–64)

```
fn is_apple_silicon_mac() -> bool
```

**Purpose**: Determines whether the current macOS environment should use the Apple Silicon installer. It accounts for both native ARM machines and translated execution contexts.

**Data flow**: The function defines an inner helper that calls `libc::sysctlbyname` for a named integer flag and returns `Option<bool>`. It then returns true if `std::env::consts::ARCH == "aarch64"`, or if either `sysctl.proc_translated` or `hw.optional.arm64` resolves to true; otherwise false.

**Call relations**: Only `run_mac_app_open_or_install` uses this helper, and only when no explicit download URL override was provided. It influences which built-in DMG URL is selected.


##### `find_existing_codex_app_path`  (lines 66–70)

```
fn find_existing_codex_app_path() -> Option<PathBuf>
```

**Purpose**: Searches standard application locations for an already installed `Codex.app`. It returns the first candidate directory that exists.

**Data flow**: The function obtains the candidate path list from `candidate_codex_app_paths()`, iterates through it, and returns the first path for which `candidate.is_dir()` is true. If none exist, it returns `None`.

**Call relations**: This helper is called at the start of `run_mac_app_open_or_install` to decide whether installation can be skipped. It delegates candidate generation to `candidate_codex_app_paths`.

*Call graph*: calls 1 internal fn (candidate_codex_app_paths); called by 1 (run_mac_app_open_or_install).


##### `candidate_codex_app_paths`  (lines 72–78)

```
fn candidate_codex_app_paths() -> Vec<PathBuf>
```

**Purpose**: Builds the ordered list of locations where an existing `Codex.app` installation may reside. It includes both system-wide and per-user application directories.

**Data flow**: The function starts with a vector containing `/Applications/Codex.app`. If the `HOME` environment variable is set, it appends `~/Applications/Codex.app` by joining path components onto the home directory. It returns the resulting `Vec<PathBuf>`.

**Call relations**: Only `find_existing_codex_app_path` calls this helper. Its ordering determines which existing installation is preferred when multiple copies are present.

*Call graph*: called by 1 (find_existing_codex_app_path); 3 external calls (from, var_os, vec!).


##### `open_codex_app`  (lines 80–103)

```
async fn open_codex_app(app_path: &Path, workspace: &Path) -> anyhow::Result<()>
```

**Purpose**: Launches Codex Desktop with a deep link pointing at the requested workspace. It wraps the macOS `open` command and turns nonzero exit statuses into descriptive errors.

**Data flow**: The function takes an app bundle path and workspace path, prints the workspace being opened, computes a deep-link URL with `codex_new_thread_url`, and runs `open -a <app_path> <url>` asynchronously via `tokio::process::Command`. If the command invocation fails it adds context; if the process exits successfully it returns `Ok(())`; otherwise it bails with a message containing the app path, URL, and exit status.

**Call relations**: `run_mac_app_open_or_install` calls this both for already-installed apps and after a fresh installation. It delegates URL construction to `codex_new_thread_url`.

*Call graph*: calls 1 internal fn (codex_new_thread_url); called by 1 (run_mac_app_open_or_install); 3 external calls (bail!, new, eprintln!).


##### `codex_new_thread_url`  (lines 105–111)

```
fn codex_new_thread_url(workspace: &Path) -> String
```

**Purpose**: Constructs the `codex://threads/new` deep link used to open a workspace in Codex Desktop. It encodes the workspace path as a query parameter rather than embedding it directly in the path.

**Data flow**: The function converts the workspace `&Path` to a lossy string, creates a `url::form_urlencoded::Serializer`, appends a single `path=<workspace>` pair, finishes the query string, and formats `codex://threads/new?{query}`. It returns the resulting `String`.

**Call relations**: This helper is used by `open_codex_app` in production and by a unit test that verifies proper encoding of spaces and `#` characters in workspace paths.

*Call graph*: called by 2 (open_codex_app, codex_new_thread_url_encodes_workspace_path); 5 external calls (as_os_str, as_ref, new, format!, new).


##### `download_and_install_codex_to_user_applications`  (lines 113–146)

```
async fn download_and_install_codex_to_user_applications(dmg_url: &str) -> anyhow::Result<PathBuf>
```

**Purpose**: Downloads the installer DMG into a temporary directory, mounts it, installs the app bundle, and detaches the DMG afterward. It encapsulates the full installer lifecycle.

**Data flow**: The function creates a temporary directory with prefix `codex-app-installer-`, derives `Codex.dmg` inside it, awaits `download_dmg(url, dmg_path)`, prints progress, awaits `mount_dmg(dmg_path)` to obtain a mount point, and then runs an inner async block that finds the app bundle with `find_codex_app_in_mount` and installs it via `install_codex_app_bundle`. After that block completes, it always awaits `detach_dmg(mount_point)` and prints a warning if detach fails, then returns the installation result from the inner block.

**Call relations**: Only `run_mac_app_open_or_install` calls this helper when no existing installation is found. It orchestrates `download_dmg`, `mount_dmg`, `find_codex_app_in_mount`, `install_codex_app_bundle`, and `detach_dmg` in sequence.

*Call graph*: calls 5 internal fn (detach_dmg, download_dmg, find_codex_app_in_mount, install_codex_app_bundle, mount_dmg); called by 1 (run_mac_app_open_or_install); 2 external calls (new, eprintln!).


##### `install_codex_app_bundle`  (lines 148–178)

```
async fn install_codex_app_bundle(app_in_volume: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: Copies the mounted `Codex.app` bundle into the first usable Applications directory. It tries system-wide installation first and falls back to the user's Applications directory.

**Data flow**: The function obtains candidate directories from `candidate_applications_dirs()`, iterates through them, prints the target directory, ensures it exists with `create_dir_all`, computes `dest_app = applications_dir.join("Codex.app")`, and if that destination already exists as a directory returns it immediately. Otherwise it awaits `copy_app_bundle(src_app, dest_app)`; on success it returns the destination path, and on failure it prints a warning and continues to the next candidate. If all candidates fail, it bails with an error.

**Call relations**: This helper is called by `download_and_install_codex_to_user_applications` after the DMG has been mounted and the source app bundle located. It delegates directory enumeration to `candidate_applications_dirs` and actual copying to `copy_app_bundle`.

*Call graph*: calls 2 internal fn (candidate_applications_dirs, copy_app_bundle); called by 1 (download_and_install_codex_to_user_applications); 3 external calls (bail!, eprintln!, create_dir_all).


##### `candidate_applications_dirs`  (lines 180–184)

```
fn candidate_applications_dirs() -> anyhow::Result<Vec<PathBuf>>
```

**Purpose**: Returns the ordered list of installation targets for `Codex.app`. It prefers `/Applications` but also includes the current user's Applications directory.

**Data flow**: The function creates a vector containing `/Applications`, pushes the result of `user_applications_dir()?`, and returns the vector inside `anyhow::Result`. It reads the environment indirectly through `user_applications_dir`.

**Call relations**: Only `install_codex_app_bundle` calls this helper. Its ordering controls where installation is attempted first.

*Call graph*: calls 1 internal fn (user_applications_dir); called by 1 (install_codex_app_bundle); 1 external calls (vec!).


##### `download_dmg`  (lines 186–205)

```
async fn download_dmg(url: &str, dest: &Path) -> anyhow::Result<()>
```

**Purpose**: Downloads the installer DMG to a destination path using `curl` with retries. It converts command failures and nonzero statuses into `anyhow` errors.

**Data flow**: The function prints a progress message, runs `curl -fL --retry 3 --retry-delay 1 -o <dest> <url>` asynchronously, adds context if the command cannot be invoked, and returns `Ok(())` only when the exit status is successful. Otherwise it bails with the failing status.

**Call relations**: `download_and_install_codex_to_user_applications` calls this before mounting the DMG. It is a pure external-command wrapper and does not interact with other project-local helpers.

*Call graph*: called by 1 (download_and_install_codex_to_user_applications); 3 external calls (bail!, new, eprintln!).


##### `mount_dmg`  (lines 207–229)

```
async fn mount_dmg(dmg_path: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: Attaches a DMG read-only with `hdiutil` and extracts the resulting mount point from command output. It turns both attach failures and parse failures into contextualized errors.

**Data flow**: The function runs `hdiutil attach -nobrowse -readonly <dmg_path>` and captures its output. If the command exits unsuccessfully, it bails with the exit status and stderr decoded via `String::from_utf8_lossy`; otherwise it decodes stdout, passes it to `parse_hdiutil_attach_mount_point`, converts the returned string into a `PathBuf`, and adds context containing the full stdout if parsing fails.

**Call relations**: This helper is called by `download_and_install_codex_to_user_applications` after the DMG has been downloaded. It delegates the output-format-specific parsing to `parse_hdiutil_attach_mount_point`.

*Call graph*: calls 1 internal fn (parse_hdiutil_attach_mount_point); called by 1 (download_and_install_codex_to_user_applications); 3 external calls (from_utf8_lossy, bail!, new).


##### `detach_dmg`  (lines 231–243)

```
async fn detach_dmg(mount_point: &Path) -> anyhow::Result<()>
```

**Purpose**: Unmounts a previously attached DMG using `hdiutil detach`. It reports nonzero exit statuses as errors.

**Data flow**: The function runs `hdiutil detach <mount_point>` asynchronously, adds context if invocation fails, and returns `Ok(())` only when the exit status is successful; otherwise it bails with the status. It mutates system mount state through the external command.

**Call relations**: `download_and_install_codex_to_user_applications` calls this after attempting installation, regardless of whether installation succeeded. That caller intentionally downgrades detach failures to warnings.

*Call graph*: called by 1 (download_and_install_codex_to_user_applications); 2 external calls (bail!, new).


##### `find_codex_app_in_mount`  (lines 245–268)

```
fn find_codex_app_in_mount(mount_point: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: Locates an `.app` bundle inside the mounted installer volume. It first checks for `Codex.app` directly and then falls back to scanning the mount root for any app bundle directory.

**Data flow**: The function computes `mount_point.join("Codex.app")` and returns it immediately if it is a directory. Otherwise it reads the mount directory with `std::fs::read_dir`, iterates entries, converts each to a path, and returns the first path whose extension is `app` and which is a directory. If no such bundle is found, it bails with an error naming the mount point.

**Call relations**: This helper is called by `download_and_install_codex_to_user_applications` after mounting the DMG and before installation. It isolates volume-layout assumptions from the rest of the installer flow.

*Call graph*: called by 1 (download_and_install_codex_to_user_applications); 3 external calls (join, bail!, read_dir).


##### `copy_app_bundle`  (lines 270–282)

```
async fn copy_app_bundle(src_app: &Path, dest_app: &Path) -> anyhow::Result<()>
```

**Purpose**: Copies an app bundle from the mounted volume to its destination using `ditto`. It wraps the external copy command with error handling.

**Data flow**: The function runs `ditto <src_app> <dest_app>` asynchronously, adds context if the command cannot be invoked, and returns `Ok(())` on success or bails with the exit status on failure. It writes the destination app bundle on disk.

**Call relations**: `install_codex_app_bundle` calls this for each candidate destination that does not already contain `Codex.app`. It is the low-level copy primitive for installation.

*Call graph*: called by 1 (install_codex_app_bundle); 2 external calls (bail!, new).


##### `user_applications_dir`  (lines 284–287)

```
fn user_applications_dir() -> anyhow::Result<PathBuf>
```

**Purpose**: Computes the current user's `~/Applications` directory. It fails if `HOME` is not set.

**Data flow**: The function reads `HOME` from the environment with `std::env::var_os`, adds context if it is missing, converts it into a `PathBuf`, appends `Applications`, and returns the resulting path.

**Call relations**: Only `candidate_applications_dirs` calls this helper. It isolates environment-dependent path construction from the installer logic.

*Call graph*: called by 1 (candidate_applications_dirs); 2 external calls (from, var_os).


##### `parse_hdiutil_attach_mount_point`  (lines 289–301)

```
fn parse_hdiutil_attach_mount_point(output: &str) -> Option<String>
```

**Purpose**: Extracts the mounted volume path from `hdiutil attach` stdout, including paths containing spaces. It supports both tab-separated and whitespace-separated output formats.

**Data flow**: The function iterates over output lines, skips lines that do not contain `/Volumes/`, and for matching lines first tries `rsplit_once('\t')` to take the final tab-separated field as the mount path. If no tab split is available, it scans whitespace-separated fields for one starting with `/Volumes/`. It returns the first matching mount path as `Some(String)` or `None` if none are found.

**Call relations**: `mount_dmg` calls this parser after a successful `hdiutil attach`. Two unit tests validate tab-separated output and mount points containing spaces.

*Call graph*: called by 1 (mount_dmg).


##### `tests::parses_mount_point_from_tab_separated_hdiutil_output`  (lines 311–317)

```
fn parses_mount_point_from_tab_separated_hdiutil_output()
```

**Purpose**: Verifies that the mount-point parser handles the common tab-separated `hdiutil attach` output format. It protects against regressions in the simplest parsing path.

**Data flow**: The test passes a one-line sample string containing `/dev/disk2s1\tApple_HFS\tCodex\t/Volumes/Codex\n` into `parse_hdiutil_attach_mount_point` and asserts that the returned `Option<&str>` is `Some("/Volumes/Codex")`.

**Call relations**: This unit test is run by the test harness and directly exercises `parse_hdiutil_attach_mount_point`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_mount_point_with_spaces`  (lines 320–326)

```
fn parses_mount_point_with_spaces()
```

**Purpose**: Checks that the mount-point parser preserves spaces in mounted volume names. It covers the case where the final tab-separated field contains whitespace.

**Data flow**: The test supplies sample output ending in `/Volumes/Codex Installer` to `parse_hdiutil_attach_mount_point` and asserts that the parser returns that full path unchanged.

**Call relations**: This test complements the previous parser test by covering a mount path with spaces, still through direct invocation of `parse_hdiutil_attach_mount_point`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::codex_new_thread_url_encodes_workspace_path`  (lines 329–347)

```
fn codex_new_thread_url_encodes_workspace_path()
```

**Purpose**: Verifies that the deep-link URL builder encodes a workspace path as a query parameter without corrupting spaces or `#` characters. It checks the URL at the parsed-structure level rather than by raw string comparison.

**Data flow**: The test calls `codex_new_thread_url` with `/tmp/codex workspace/#1`, parses the resulting string as a `url::Url`, and asserts that the scheme is `codex`, the host is `threads`, the path is `/new`, and the decoded query pairs equal a single `("path", "/tmp/codex workspace/#1")` entry.

**Call relations**: This unit test exercises `codex_new_thread_url` and indirectly validates the use of `url::form_urlencoded::Serializer` for query encoding.

*Call graph*: calls 1 internal fn (codex_new_thread_url); 3 external calls (new, assert_eq!, parse).


### `cli/src/desktop_app/windows.rs`

`domain_logic` · `request handling`

This file contains the full Windows desktop-app path: detect whether Codex Desktop is installed, open a workspace if it is, otherwise launch an installer URL. `run_windows_app_open_or_install` first converts the incoming `PathBuf` into two forms: a raw string used in the deep link query and a cleaned display string produced by `display_workspace_path`, which strips Windows extended-path prefixes like `\\?\` while preserving UNC semantics. It then calls `codex_app_is_installed`, which shells out to `powershell.exe` and runs `Get-StartApps -Name 'Codex' ... -ExpandProperty AppID`; any non-success exit is treated as “not installed”, while a successful command with non-empty stdout means the app exists.

If installed, the function prints a status line and opens `codex://threads/new?path=...`, where `codex_new_thread_url` URL-encodes the workspace path using `url::form_urlencoded::Serializer`. If not installed, it prints an installer message and tries to open either the override URL or the built-in Microsoft installer URL via `open_url`, which again uses PowerShell `Start-Process`. A notable fallback only applies when no override was supplied: if opening the default installer URL fails, it falls back to the Microsoft Store web page. Errors from process launch are surfaced with context; installer-open failure with an override does not get a secondary fallback. The included tests pin down path-prefix stripping and URL encoding behavior for verbatim and normal Windows paths.

#### Function details

##### `run_windows_app_open_or_install`  (lines 10–31)

```
async fn run_windows_app_open_or_install(
    workspace: PathBuf,
    download_url_override: Option<String>,
) -> anyhow::Result<()>
```

**Purpose**: Determines whether Codex Desktop is already installed on Windows and either opens the requested workspace in the app or launches an installer/store URL. It also emits user-facing progress messages to stderr.

**Data flow**: Consumes `workspace: PathBuf` and optional `download_url_override`. It derives `workspace_path` as a display string for the deep link and `display_workspace` as a cleaned human-readable path. It reads installation state via `codex_app_is_installed`; if true, it builds a `codex://threads/new?...` URL with `codex_new_thread_url`, opens it with `open_url`, and returns `Ok(())`. Otherwise it selects either the override URL or `CODEX_WINDOWS_INSTALLER_URL`, tries `open_url`, optionally falls back to `CODEX_MICROSOFT_STORE_WEB_URL` when the default URL fails, prints post-install guidance, and returns success unless the final open attempt errors.

**Call relations**: This function is called by the platform-dispatching `run_app_open_or_install`. In the success path it delegates to `display_workspace_path`, `codex_app_is_installed`, `codex_new_thread_url`, and `open_url`; in the install path it may call `open_url` twice to implement the built-in fallback from installer URL to Store web page.

*Call graph*: calls 4 internal fn (codex_app_is_installed, codex_new_thread_url, display_workspace_path, open_url); called by 1 (run_app_open_or_install); 2 external calls (display, eprintln!).


##### `codex_app_is_installed`  (lines 33–47)

```
async fn codex_app_is_installed() -> anyhow::Result<bool>
```

**Purpose**: Checks Windows Start menu registrations to see whether an app named `Codex` is installed. It treats command failure as absence rather than a hard error.

**Data flow**: Launches `powershell.exe` with a `Get-StartApps -Name 'Codex' | Select-Object -First 1 -ExpandProperty AppID` command, awaits process output, and adds context if PowerShell itself could not be invoked. If the process exits unsuccessfully it returns `Ok(false)`. Otherwise it decodes stdout with `String::from_utf8_lossy`, trims it, and returns whether the resulting AppID string is non-empty.

**Call relations**: It is used only by `run_windows_app_open_or_install` as the gate between the open-existing-app path and the installer path. It does not delegate to any local helpers beyond process creation and UTF-8 decoding.

*Call graph*: called by 1 (run_windows_app_open_or_install); 2 external calls (from_utf8_lossy, new).


##### `open_url`  (lines 49–64)

```
async fn open_url(url: &str) -> anyhow::Result<()>
```

**Purpose**: Opens a URL or protocol target on Windows by asking PowerShell to start a process for that target. It converts nonzero exit status into an `anyhow` failure.

**Data flow**: Accepts `url: &str`, spawns `powershell.exe -NoProfile -Command '& { param($target) Start-Process -FilePath $target }' <url>`, awaits the exit status, and wraps spawn failures with a message naming the target. If the status is successful it returns `Ok(())`; otherwise it constructs an error with the URL and exit status.

**Call relations**: It is called by `run_windows_app_open_or_install` both for deep-link opening and for installer/store launching. The caller uses its error result to decide whether to attempt the Microsoft Store web fallback.

*Call graph*: called by 1 (run_windows_app_open_or_install); 2 external calls (bail!, new).


##### `codex_new_thread_url`  (lines 66–71)

```
fn codex_new_thread_url(workspace: &str) -> String
```

**Purpose**: Builds the custom deep-link URL that asks Codex Desktop to open a new thread for a workspace path. It ensures the path is query-encoded rather than inserted raw.

**Data flow**: Takes `workspace: &str`, creates a `url::form_urlencoded::Serializer`, appends a single `path=<workspace>` pair, finalizes the query string, and returns `codex://threads/new?{query}` as a `String`.

**Call relations**: It is used by `run_windows_app_open_or_install` only when the desktop app is already installed. Its output is then passed directly to `open_url`.

*Call graph*: called by 1 (run_windows_app_open_or_install); 3 external calls (new, format!, new).


##### `display_workspace_path`  (lines 73–82)

```
fn display_workspace_path(workspace: &Path) -> String
```

**Purpose**: Converts a Windows path into a friendlier display form by removing extended-path prefixes while preserving UNC network paths. This affects only user-facing messages, not the deep-link payload.

**Data flow**: Accepts `workspace: &Path`, renders it to a string, then checks for the `\\?\UNC\` prefix first and rewrites it to a normal UNC path `\\server\share...`; otherwise it strips a plain `\\?\` prefix; if neither prefix is present it returns the original rendered path.

**Call relations**: It is called by `run_windows_app_open_or_install` to produce the path shown in stderr messages. The raw path string used by `codex_new_thread_url` is intentionally left untouched.

*Call graph*: called by 1 (run_windows_app_open_or_install); 2 external calls (display, format!).


##### `tests::display_workspace_path_removes_windows_extended_prefix`  (lines 92–97)

```
fn display_workspace_path_removes_windows_extended_prefix()
```

**Purpose**: Verifies that verbatim local-drive paths lose the `\\?\` prefix in display output.

**Data flow**: Constructs a `Path` with an extended prefix, calls `display_workspace_path`, and asserts that the returned string is the normal drive path.

**Call relations**: This test exercises the local-path branch of `display_workspace_path`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::display_workspace_path_preserves_unc_prefix`  (lines 100–105)

```
fn display_workspace_path_preserves_unc_prefix()
```

**Purpose**: Verifies that verbatim UNC paths are rewritten back to standard UNC form rather than flattened incorrectly.

**Data flow**: Builds a `Path` beginning with `\\?\UNC\...`, calls `display_workspace_path`, and asserts that the result starts with `\\server\share`.

**Call relations**: This test covers the UNC-specific prefix handling in `display_workspace_path`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::display_workspace_path_leaves_regular_paths_unchanged`  (lines 108–113)

```
fn display_workspace_path_leaves_regular_paths_unchanged()
```

**Purpose**: Confirms that already-normal Windows paths are returned unchanged.

**Data flow**: Passes a standard `C:\...` path into `display_workspace_path` and asserts exact equality with the input string form.

**Call relations**: This test covers the default fallthrough branch of `display_workspace_path`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::codex_new_thread_url_encodes_windows_workspace_path`  (lines 116–121)

```
fn codex_new_thread_url_encodes_windows_workspace_path()
```

**Purpose**: Checks that a normal Windows path is percent-encoded correctly inside the deep-link query string.

**Data flow**: Calls `codex_new_thread_url` with a drive path and asserts the returned URL contains encoded `:` and `\` characters in the `path` parameter.

**Call relations**: This test validates the serializer-based encoding used by `codex_new_thread_url`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::codex_new_thread_url_preserves_verbatim_workspace_path`  (lines 124–129)

```
fn codex_new_thread_url_preserves_verbatim_workspace_path()
```

**Purpose**: Checks that verbatim Windows paths are encoded as-is rather than normalized before URL construction.

**Data flow**: Supplies a `\\?\...` path to `codex_new_thread_url` and asserts the returned URL contains the encoded verbatim prefix.

**Call relations**: This test documents the design choice that deep-link payloads preserve the original workspace string, unlike display formatting.

*Call graph*: 1 external calls (assert_eq!).


### `cli/src/remote_control_cmd.rs`

`orchestration` · `on demand during `codex remote-control` command handling`

This file is a focused driver for remote-control startup and shutdown. `RemoteControlCommand` exposes a global `--json` flag and optional `start`/`stop` subcommands; omitting the subcommand runs a foreground app-server instead of the managed daemon. The top-level `run` function prints a progress line unless JSON mode is active, then either calls `codex_app_server_daemon::ensure_remote_control_ready`, stops the daemon through the lifecycle API, or launches `run_foreground_remote_control`.

Foreground mode is the most intricate path. It creates a private temporary socket directory, constructs a Unix-socket `AppServerTransport`, and spawns `codex_app_server::run_main_with_transport_options` with remote control enabled ephemerally, analytics disabled, and shutdown-signal handling disabled so this wrapper owns Ctrl-C. `foreground_stop_signal` creates a watch channel and a task that flips it on Ctrl-C. Startup then races three events in `wait_for_foreground_remote_control_start`: remote-control readiness on the socket, premature app-server exit, or a stop signal. If readiness wins, the command prints either JSON or human lines and then waits for either app-server completion or Ctrl-C, aborting the task on stop. Abort uses a short timeout to avoid hanging on task shutdown.

Formatting helpers enforce an important invariant: only `Connected` and `Connecting` remote-control statuses are considered startable. `Errored` and `Disabled` statuses are converted into command failures before any JSON or human success output is emitted. Human output differs slightly between foreground and daemon modes: foreground adds `Press Ctrl-C to stop.`, while daemon mode appends the managed app-server path and version used by the daemon.

#### Function details

##### `RemoteControlCommand::subcommand_name`  (lines 41–47)

```
fn subcommand_name(&self) -> &'static str
```

**Purpose**: Returns the exact user-facing command name fragment for the selected remote-control mode.

**Data flow**: Reads `self.subcommand` and returns one of `remote-control`, `remote-control start`, or `remote-control stop` as a static string.

**Call relations**: Used by `main.rs` when validating unsupported root flags for the remote-control command.


##### `run`  (lines 59–87)

```
async fn run(
    command: RemoteControlCommand,
    arg0_paths: Arg0DispatchPaths,
    root_config_overrides: CliConfigOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Dispatches remote-control commands into foreground startup, daemon startup, or daemon stop flows and prints the corresponding output.

**Data flow**: Consumes the parsed command, arg0 paths, and root config overrides. With no subcommand it prints a progress message and calls `run_foreground_remote_control`; with `Start` it prints progress, awaits `ensure_remote_control_ready`, and formats the result with `print_remote_control_start_output`; with `Stop` it prints progress, runs the daemon lifecycle stop command, and formats the result with `print_remote_control_stop_output`.

**Call relations**: Called from `cli_main` for `Subcommand::RemoteControl`. It is the entrypoint for all logic in this file.

*Call graph*: calls 4 internal fn (print_remote_control_progress, print_remote_control_start_output, print_remote_control_stop_output, run_foreground_remote_control); called by 1 (cli_main); 2 external calls (ensure_remote_control_ready, run).


##### `print_remote_control_progress`  (lines 89–99)

```
fn print_remote_control_progress(json: bool, message: &str) -> anyhow::Result<()>
```

**Purpose**: Prints and flushes a one-line progress message unless JSON mode suppresses human chatter.

**Data flow**: Reads the `json` flag and message string. In JSON mode it returns immediately; otherwise it prints the message, flushes stdout, and returns any flush error with context.

**Call relations**: Used by `run` before each long-running remote-control action so users see immediate feedback.

*Call graph*: called by 1 (run); 2 external calls (println!, stdout).


##### `run_foreground_remote_control`  (lines 101–174)

```
async fn run_foreground_remote_control(
    json: bool,
    arg0_paths: Arg0DispatchPaths,
    root_config_overrides: CliConfigOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Starts an app-server in-process on a private Unix socket with remote control enabled, waits for readiness, prints the ready output, and then keeps it running until Ctrl-C or task exit.

**Data flow**: Creates a temporary socket directory and absolute socket path, builds `AppServerTransport::UnixSocket` and `AppServerRuntimeOptions` with ephemeral remote control and no shutdown handler, creates a stop watch channel via `foreground_stop_signal`, and spawns `codex_app_server::run_main_with_transport_options`. It then calls `wait_for_foreground_remote_control_start`, handling four outcomes: ready summary, stop before ready, readiness failure, or app-server exit before ready. On success it checks for a stop signal, prints readiness via `print_foreground_ready_output`, then waits for either app-server completion or stop via `wait_for_foreground_app_server`. In all early-exit/error paths it aborts the app-server task and stop-signal task as needed.

**Call relations**: Called only by `run` when no explicit subcommand is given. It orchestrates nearly every helper in this file.

*Call graph*: calls 7 internal fn (abort_foreground_app_server, foreground_stop_signal, print_foreground_ready_output, wait_for_foreground_app_server, wait_for_foreground_remote_control_ready, wait_for_foreground_remote_control_start, from_absolute_path); called by 1 (run); 6 external calls (default, default, run_main_with_transport_options, default, new, spawn).


##### `foreground_stop_signal`  (lines 176–185)

```
fn foreground_stop_signal() -> (watch::Receiver<bool>, JoinHandle<()>)
```

**Purpose**: Creates a watch channel that flips to `true` when Ctrl-C is received.

**Data flow**: Creates a `watch::channel(false)`, spawns a task that awaits `tokio::signal::ctrl_c`, logs an error to stderr if signal listening fails, and sends `true` on the channel. Returns the receiver and the spawned task handle.

**Call relations**: Used by `run_foreground_remote_control` to coordinate graceful foreground shutdown.

*Call graph*: called by 1 (run_foreground_remote_control); 4 external calls (eprintln!, ctrl_c, spawn, channel).


##### `wait_for_foreground_remote_control_start`  (lines 194–213)

```
async fn wait_for_foreground_remote_control_start(
    app_server_task: &mut JoinHandle<std::io::Result<()>>,
    ready: impl std::future::Future<Output = anyhow::Result<AppServerRemoteControlReadySta
```

**Purpose**: Races foreground remote-control readiness against premature app-server exit and user stop signals.

**Data flow**: Takes a mutable app-server `JoinHandle`, a future that resolves to `AppServerRemoteControlReadyStatus`, and a stop receiver. It pins the readiness future and uses `tokio::select!` to return `ForegroundStartupResult::Ready`, `ReadyFailed`, `AppServerExited`, or `Stopped` depending on which event completes first.

**Call relations**: Called by `run_foreground_remote_control`; tests exercise the stop-before-ready and app-server-exit-before-ready branches.

*Call graph*: called by 3 (run_foreground_remote_control, foreground_start_wait_reports_app_server_exit_before_ready, foreground_start_wait_stops_before_ready); 2 external calls (pin!, select!).


##### `wait_for_foreground_app_server`  (lines 215–231)

```
async fn wait_for_foreground_app_server(
    mut app_server_task: JoinHandle<std::io::Result<()>>,
    mut stop_rx: watch::Receiver<bool>,
) -> anyhow::Result<()>
```

**Purpose**: After readiness has been reported, waits for either app-server completion or a stop signal and shuts down cleanly in the latter case.

**Data flow**: Takes ownership of the app-server task and a stop receiver, then uses `tokio::select!`: if the task finishes, it unwraps join and I/O errors with context; if a stop signal arrives, it aborts the app-server task. Returns `Ok(())` once either path completes successfully.

**Call relations**: Called by `run_foreground_remote_control` after readiness output has been printed; also covered by a stop-signal test.

*Call graph*: called by 2 (run_foreground_remote_control, foreground_wait_aborts_app_server_on_stop_signal); 1 external calls (select!).


##### `wait_for_stop_signal`  (lines 233–238)

```
async fn wait_for_stop_signal(stop_rx: &mut watch::Receiver<bool>)
```

**Purpose**: Awaits the watch channel becoming `true`, returning immediately if it is already set.

**Data flow**: Borrows the current watch value; if already true it returns, otherwise it awaits `wait_for(|stopped| *stopped)` and ignores the result.

**Call relations**: Used inside both foreground wait helpers as the stop branch of their `select!` expressions.

*Call graph*: 2 external calls (borrow, wait_for).


##### `foreground_app_server_exited_before_ready`  (lines 240–252)

```
fn foreground_app_server_exited_before_ready(
    result: Result<std::io::Result<()>, tokio::task::JoinError>,
) -> anyhow::Error
```

**Purpose**: Converts a foreground app-server task result into a contextualized error explaining that readiness was never reached.

**Data flow**: Matches `Result<std::io::Result<()>, JoinError>`. A clean `Ok(())` becomes a synthetic error saying the app-server exited before readiness; an inner I/O error or join error is wrapped with context indicating the exit happened before remote control became ready.

**Call relations**: Used by `wait_for_foreground_remote_control_start` when the app-server task wins the race before readiness.

*Call graph*: 2 external calls (anyhow!, new).


##### `abort_foreground_app_server`  (lines 254–257)

```
async fn abort_foreground_app_server(app_server_task: JoinHandle<std::io::Result<()>>)
```

**Purpose**: Aborts the foreground app-server task and waits briefly for the task to terminate.

**Data flow**: Consumes the app-server `JoinHandle`, calls `abort()`, then awaits it under a one-second timeout and discards the result.

**Call relations**: Used by `run_foreground_remote_control` in all early-stop and error paths.

*Call graph*: called by 1 (run_foreground_remote_control); 2 external calls (abort, timeout).


##### `wait_for_foreground_remote_control_ready`  (lines 259–268)

```
async fn wait_for_foreground_remote_control_ready(
    socket_path: AbsolutePathBuf,
) -> anyhow::Result<AppServerRemoteControlReadyStatus>
```

**Purpose**: Waits for the foreground app-server’s private socket to accept remote-control enablement and report readiness.

**Data flow**: Consumes an `AbsolutePathBuf`, passes its path plus fixed connect timeout and retry delay constants into `codex_app_server_daemon::enable_remote_control_on_socket`, and returns the resulting readiness status.

**Call relations**: Called by `run_foreground_remote_control` as the readiness future raced by `wait_for_foreground_remote_control_start`.

*Call graph*: calls 1 internal fn (as_path); called by 1 (run_foreground_remote_control); 1 external calls (enable_remote_control_on_socket).


##### `print_remote_control_start_output`  (lines 270–293)

```
fn print_remote_control_start_output(
    output: &AppServerRemoteControlReadyOutput,
    json: bool,
) -> anyhow::Result<()>
```

**Purpose**: Formats daemon-mode remote-control startup results as either JSON or human-readable lines, rejecting unstartable statuses first.

**Data flow**: Borrows `AppServerRemoteControlReadyOutput` and a `json` flag. It validates `output.remote_control` with `ensure_remote_control_startable`; in JSON mode it serializes `RemoteControlStartJsonOutput::daemon(output)`, otherwise it prints lines from `remote_control_start_human_lines(..., Daemon)` followed by daemon app-server identity lines from `daemon_app_server_human_lines`.

**Call relations**: Called by `run` after `ensure_remote_control_ready()` succeeds in daemon mode.

*Call graph*: calls 3 internal fn (daemon_app_server_human_lines, ensure_remote_control_startable, remote_control_start_human_lines); called by 1 (run); 1 external calls (println!).


##### `print_foreground_ready_output`  (lines 295–313)

```
fn print_foreground_ready_output(
    summary: &AppServerRemoteControlReadyStatus,
    json: bool,
) -> anyhow::Result<()>
```

**Purpose**: Formats foreground remote-control readiness as either JSON or human-readable lines.

**Data flow**: Borrows `AppServerRemoteControlReadyStatus` and a `json` flag. In JSON mode it validates startability and serializes `RemoteControlStartJsonOutput::foreground`; otherwise it prints lines from `remote_control_start_human_lines(..., Foreground)`.

**Call relations**: Called by `run_foreground_remote_control` once the foreground app-server reports readiness.

*Call graph*: calls 2 internal fn (ensure_remote_control_startable, remote_control_start_human_lines); called by 1 (run_foreground_remote_control); 1 external calls (println!).


##### `RemoteControlStartJsonOutput::foreground`  (lines 335–344)

```
fn foreground(summary: &'a AppServerRemoteControlReadyStatus) -> Self
```

**Purpose**: Builds the JSON success payload for foreground remote-control startup.

**Data flow**: Borrows a readiness summary and returns `RemoteControlStartJsonOutput` with `mode=Foreground`, copied connection status, server name, optional environment id, timeout flag, and `daemon=None`.

**Call relations**: Used by `print_foreground_ready_output` in JSON mode.


##### `RemoteControlStartJsonOutput::daemon`  (lines 346–356)

```
fn daemon(output: &'a AppServerRemoteControlReadyOutput) -> Self
```

**Purpose**: Builds the JSON success payload for daemon-backed remote-control startup.

**Data flow**: Borrows `AppServerRemoteControlReadyOutput`, copies fields from `output.remote_control`, sets `mode=Daemon`, and includes a borrowed reference to the daemon lifecycle/start payload in `daemon`.

**Call relations**: Used by `print_remote_control_start_output` in JSON mode.


##### `remote_control_start_human_message`  (lines 359–376)

```
fn remote_control_start_human_message(
    output: &AppServerRemoteControlReadyStatus,
) -> anyhow::Result<String>
```

**Purpose**: Produces the primary one-line human success message for a startable remote-control status.

**Data flow**: Validates the status with `ensure_remote_control_startable`, then returns either `This machine is available for remote control as <server>.` for `Connected` or `Remote control is enabled on <server> and still connecting.` for `Connecting`. `Errored` and `Disabled` are unreachable after validation.

**Call relations**: Used by `remote_control_start_human_lines`; tests pin all success and failure messages.

*Call graph*: calls 1 internal fn (ensure_remote_control_startable); 2 external calls (format!, unreachable!).


##### `ensure_remote_control_startable`  (lines 378–395)

```
fn ensure_remote_control_startable(
    output: &AppServerRemoteControlReadyStatus,
) -> anyhow::Result<()>
```

**Purpose**: Rejects remote-control statuses that should not be presented as successful startup.

**Data flow**: Reads `RemoteControlConnectionStatus` from the readiness summary. Returns success for `Connected` and `Connecting`; returns an error naming the server for `Errored` or `Disabled`.

**Call relations**: Called by both JSON and human start-output formatters and by `remote_control_start_human_message`.

*Call graph*: called by 3 (print_foreground_ready_output, print_remote_control_start_output, remote_control_start_human_message); 1 external calls (bail!).


##### `remote_control_start_human_lines`  (lines 403–415)

```
fn remote_control_start_human_lines(
    summary: &AppServerRemoteControlReadyStatus,
    mode: RemoteControlHumanOutputMode,
) -> anyhow::Result<Vec<String>>
```

**Purpose**: Builds the full set of human-readable startup lines for foreground or daemon mode.

**Data flow**: Starts with the primary message from `remote_control_start_human_message`, then appends `Press Ctrl-C to stop.` only when the mode is `Foreground`. Returns the resulting `Vec<String>`.

**Call relations**: Used by both start-output printers; tests verify the foreground-only stop hint.

*Call graph*: called by 2 (print_foreground_ready_output, print_remote_control_start_output); 1 external calls (vec!).


##### `daemon_app_server_human_lines`  (lines 417–424)

```
fn daemon_app_server_human_lines(output: &AppServerRemoteControlStartOutput) -> Vec<String>
```

**Purpose**: Formats the managed app-server identity used by the daemon after remote-control startup.

**Data flow**: Borrows `AppServerRemoteControlStartOutput`, extracts the managed Codex path and version via `daemon_app_server_identity`, and returns three lines: a heading, `path: ...`, and `version: ...` with `unknown` fallback.

**Call relations**: Used only by `print_remote_control_start_output` in daemon human mode.

*Call graph*: calls 1 internal fn (daemon_app_server_identity); called by 1 (print_remote_control_start_output); 1 external calls (vec!).


##### `daemon_app_server_identity`  (lines 426–439)

```
fn daemon_app_server_identity(
    output: &AppServerRemoteControlStartOutput,
) -> (&std::path::Path, Option<&str>)
```

**Purpose**: Extracts the managed Codex executable path and optional version from either daemon bootstrap or start output variants.

**Data flow**: Matches `AppServerRemoteControlStartOutput::Bootstrap` or `::Start` and returns borrowed references to `managed_codex_path` and optional `managed_codex_version`.

**Call relations**: Used by `daemon_app_server_human_lines`.

*Call graph*: called by 1 (daemon_app_server_human_lines).


##### `print_remote_control_stop_output`  (lines 441–452)

```
fn print_remote_control_stop_output(
    output: &AppServerLifecycleOutput,
    json: bool,
) -> anyhow::Result<()>
```

**Purpose**: Formats daemon stop results as either raw JSON or a human-readable summary line.

**Data flow**: Borrows `AppServerLifecycleOutput` and a `json` flag. In JSON mode it serializes the output directly; otherwise it prints the string from `remote_control_stop_human_message`.

**Call relations**: Called by `run` after issuing the daemon stop lifecycle command.

*Call graph*: called by 1 (run); 1 external calls (println!).


##### `remote_control_stop_human_message`  (lines 454–468)

```
fn remote_control_stop_human_message(output: &AppServerLifecycleOutput) -> String
```

**Purpose**: Maps daemon lifecycle stop statuses into concise human-readable text.

**Data flow**: Reads `output.status` and returns `Remote control stopped.` for `Stopped`, `Remote control is not running.` for `NotRunning`, or a generic `stop completed with status ...` message for any other lifecycle status.

**Call relations**: Used only by `print_remote_control_stop_output`.

*Call graph*: 1 external calls (format!).


##### `tests::remote_control_status`  (lines 478–487)

```
fn remote_control_status(
        status: RemoteControlConnectionStatus,
    ) -> AppServerRemoteControlReadyStatus
```

**Purpose**: Builds a sample readiness summary for remote-control output tests.

**Data flow**: Consumes a `RemoteControlConnectionStatus` and returns `AppServerRemoteControlReadyStatus` with fixed server/environment names and `timed_out` set when the status is `Connecting`.

**Call relations**: Shared helper for multiple tests in this module.


##### `tests::daemon_ready_output`  (lines 489–510)

```
fn daemon_ready_output(
        status: RemoteControlConnectionStatus,
    ) -> AppServerRemoteControlReadyOutput
```

**Purpose**: Builds a sample daemon readiness payload including managed app-server metadata.

**Data flow**: Consumes a connection status and returns `AppServerRemoteControlReadyOutput` containing a `Start` lifecycle output with fixed pid/path/version/socket values plus a matching remote-control readiness summary.

**Call relations**: Shared helper for daemon-mode output tests.

*Call graph*: 2 external calls (Start, from).


##### `tests::remote_control_human_start_messages_use_server_name`  (lines 513–544)

```
fn remote_control_human_start_messages_use_server_name()
```

**Purpose**: Verifies the exact human messages for connected, connecting, errored, and disabled remote-control statuses.

**Data flow**: Builds sample statuses with `remote_control_status`, calls `remote_control_start_human_message`, and asserts either the returned string or the exact error text.

**Call relations**: Tests both `remote_control_start_human_message` and `ensure_remote_control_startable`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::remote_control_human_lines_include_foreground_stop_hint_only`  (lines 547–563)

```
fn remote_control_human_lines_include_foreground_stop_hint_only()
```

**Purpose**: Checks that only foreground human output includes the Ctrl-C stop hint.

**Data flow**: Builds a connected summary, calls `remote_control_start_human_lines` for foreground and daemon modes, and asserts the exact returned vectors.

**Call relations**: Tests mode-specific behavior in `remote_control_start_human_lines`.

*Call graph*: 2 external calls (assert_eq!, remote_control_status).


##### `tests::daemon_app_server_human_lines_include_path_and_version`  (lines 566–577)

```
fn daemon_app_server_human_lines_include_path_and_version()
```

**Purpose**: Verifies daemon human output includes the managed app-server path and version.

**Data flow**: Builds a sample daemon output and asserts the exact vector returned by `daemon_app_server_human_lines`.

**Call relations**: Tests `daemon_app_server_human_lines` and indirectly `daemon_app_server_identity`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::remote_control_json_output_marks_foreground_or_daemon`  (lines 580–617)

```
fn remote_control_json_output_marks_foreground_or_daemon()
```

**Purpose**: Checks the JSON payload shape for both foreground and daemon startup success.

**Data flow**: Builds sample foreground and daemon outputs, serializes `RemoteControlStartJsonOutput::foreground` and `::daemon` to JSON values, and asserts the exact structures including mode, status, server/environment names, timeout flag, and daemon metadata.

**Call relations**: Tests the two JSON-constructor helpers.

*Call graph*: 3 external calls (assert_eq!, daemon_ready_output, remote_control_status).


##### `tests::remote_control_daemon_json_rejects_unstartable_status`  (lines 620–630)

```
fn remote_control_daemon_json_rejects_unstartable_status()
```

**Purpose**: Ensures daemon JSON output still fails when the remote-control status is errored.

**Data flow**: Builds a daemon output with `Errored`, calls `print_remote_control_start_output` in JSON mode, expects an error, and asserts the exact message.

**Call relations**: Tests that `ensure_remote_control_startable` is enforced before JSON serialization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::foreground_wait_aborts_app_server_on_stop_signal`  (lines 633–645)

```
async fn foreground_wait_aborts_app_server_on_stop_signal()
```

**Purpose**: Verifies that the foreground wait loop returns promptly when a stop signal is already set.

**Data flow**: Spawns a never-completing app-server task, creates a watch channel, sends `true`, wraps `wait_for_foreground_app_server` in a timeout, and asserts it returns cleanly.

**Call relations**: Tests the stop branch in `wait_for_foreground_app_server`.

*Call graph*: calls 1 internal fn (wait_for_foreground_app_server); 4 external calls (from_secs, spawn, channel, timeout).


##### `tests::foreground_start_wait_stops_before_ready`  (lines 648–667)

```
async fn foreground_start_wait_stops_before_ready()
```

**Purpose**: Verifies that startup waiting returns `Stopped` when the stop signal arrives before readiness.

**Data flow**: Spawns a never-completing app-server task, creates a watch channel already set to true, races `wait_for_foreground_remote_control_start` under a timeout, and asserts the result matches `ForegroundStartupResult::Stopped`.

**Call relations**: Tests the stop branch in `wait_for_foreground_remote_control_start`.

*Call graph*: calls 1 internal fn (wait_for_foreground_remote_control_start); 5 external calls (assert!, from_secs, spawn, channel, timeout).


##### `tests::foreground_start_wait_reports_app_server_exit_before_ready`  (lines 670–694)

```
async fn foreground_start_wait_reports_app_server_exit_before_ready()
```

**Purpose**: Verifies that startup waiting reports a contextualized error when the app-server exits before readiness.

**Data flow**: Spawns an app-server task that immediately returns an I/O error, races `wait_for_foreground_remote_control_start` under a timeout, extracts the `AppServerExited` error, and asserts the exact message.

**Call relations**: Tests the app-server-exit branch and `foreground_app_server_exited_before_ready`.

*Call graph*: calls 1 internal fn (wait_for_foreground_remote_control_start); 7 external calls (assert_eq!, other, panic!, from_secs, spawn, channel, timeout).


### Sandbox and maintenance commands
These top-level utilities handle sandbox execution and setup, doctor diagnostics, and session archive lifecycle operations.

### `cli/src/debug_sandbox.rs`

`orchestration` · `CLI sandbox command execution and config resolution`

This file is the orchestration layer for sandbox debugging. The public entrypoints `run_command_under_seatbelt`, `run_command_under_landlock`, and `run_command_under_windows_sandbox` unpack command structs from the CLI, derive a `ManagedRequirementsMode`, and funnel everything into `run_command_under_sandbox`. That central function loads a `Config` via `load_debug_sandbox_config`, derives cwd and environment, optionally short-circuits into `run_command_under_windows_session` on Windows, and otherwise prepares runtime permissions, managed-network proxy state, and a possibly augmented permission profile that includes the managed MITM CA bundle as a readable root.

Sandbox-specific launch differs by `SandboxType`: Seatbelt builds `sandbox-exec` arguments and tags the environment with `CODEX_SANDBOX_ENV_VAR=seatbelt`; Landlock resolves the `codex-linux-sandbox` executable, computes command args from the effective permission profile, and optionally allows proxy networking. Both paths spawn the child through `spawn_debug_sandbox_child`, which clears the environment, injects the computed map, inherits stdio, and marks network-disabled state with `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR` when appropriate. After waiting for the child, the code prints macOS denial summaries if logging was enabled and then exits through `handle_exit_status`.

The configuration helpers are subtle: `load_debug_sandbox_config_with_codex_home` first builds config from CLI and loader overrides, checks whether permission profiles are active or whether the caller explicitly supplied legacy `sandbox_mode`, and only if neither is true rebuilds with `SandboxMode::ReadOnly` to preserve historical `codex sandbox` defaults for legacy configs. The test module constructs temporary config files and codex homes to verify those precedence rules, explicit profile selection, config-profile loader overrides, and cwd propagation.

#### Function details

##### `run_command_under_seatbelt`  (lines 79–85)

```
async fn run_command_under_seatbelt(
    _command: SeatbeltCommand,
    _codex_linux_sandbox_exe: Option<PathBuf>,
    _loader_overrides: LoaderOverrides,
) -> anyhow::Result<()>
```

**Purpose**: macOS entrypoint for running a command under Seatbelt, or a stub that errors on non-macOS targets. It translates CLI fields into the generic sandbox runner's configuration shape.

**Data flow**: On macOS, the function destructures `SeatbeltCommand`, computes `managed_requirements_mode` from the optional permissions profile and `include_managed_config`, builds `DebugSandboxConfigOptions`, and forwards the command vector, CLI config overrides, optional Linux sandbox executable path, sandbox type, denial-logging flag, and allowed Unix sockets slice into `run_command_under_sandbox`. On non-macOS builds it ignores its inputs and returns an `anyhow` error stating Seatbelt is only available on macOS.

**Call relations**: This function is called by the CLI layer when the user selects the Seatbelt sandbox mode. Its main role is argument adaptation: it delegates all actual config loading and process launching to `run_command_under_sandbox`, after first using `ManagedRequirementsMode::for_profile_invocation` to decide whether managed requirements should be ignored.

*Call graph*: calls 2 internal fn (for_profile_invocation, run_command_under_sandbox); 1 external calls (bail!).


##### `run_command_under_landlock`  (lines 87–119)

```
async fn run_command_under_landlock(
    command: LandlockCommand,
    codex_linux_sandbox_exe: Option<PathBuf>,
    loader_overrides: LoaderOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Linux-oriented entrypoint that prepares a Landlock sandbox invocation from CLI arguments. It strips command-specific wrapper fields and forwards the rest to the shared runner.

**Data flow**: The function destructures `LandlockCommand`, derives `managed_requirements_mode`, packages `permissions_profile`, `cwd`, and `loader_overrides` into `DebugSandboxConfigOptions`, and calls `run_command_under_sandbox` with the command vector, parsed config overrides, optional sandbox executable path, `SandboxType::Landlock`, denial logging disabled, and an empty Unix-socket allowlist. It returns the shared runner's `anyhow::Result<()>`.

**Call relations**: The CLI dispatch invokes this function for Landlock runs. It sits directly above `run_command_under_sandbox`, using `ManagedRequirementsMode::for_profile_invocation` to preserve the same managed-config semantics as the other sandbox entrypoints.

*Call graph*: calls 2 internal fn (for_profile_invocation, run_command_under_sandbox).


##### `run_command_under_windows_sandbox`  (lines 121–153)

```
async fn run_command_under_windows_sandbox(
    command: WindowsCommand,
    codex_linux_sandbox_exe: Option<PathBuf>,
    loader_overrides: LoaderOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Windows-oriented entrypoint that adapts CLI arguments into the common sandbox execution path. It mirrors the Landlock and Seatbelt wrappers but selects `SandboxType::Windows`.

**Data flow**: The function consumes `WindowsCommand`, extracts the permissions profile, cwd, include-managed flag, config overrides, and command vector, computes `managed_requirements_mode`, and forwards everything to `run_command_under_sandbox` with `SandboxType::Windows`, denial logging disabled, and no extra Unix sockets. It returns the propagated async result.

**Call relations**: This wrapper is called by the CLI when the Windows sandbox mode is requested. It delegates all substantive work to `run_command_under_sandbox`, which then either enters the Windows-specific session path or errors on unsupported hosts.

*Call graph*: calls 2 internal fn (for_profile_invocation, run_command_under_sandbox).


##### `ManagedRequirementsMode::for_profile_invocation`  (lines 177–186)

```
fn for_profile_invocation(
        permissions_profile: &Option<String>,
        include_managed_config: bool,
    ) -> Self
```

**Purpose**: Determines whether managed requirements should be included when a sandbox command is invoked with or without an explicit permission profile. It encodes a small but important policy decision.

**Data flow**: The method reads `permissions_profile: &Option<String>` and `include_managed_config: bool`. If a permissions profile is explicitly selected and the caller did not request managed config inclusion, it returns `ManagedRequirementsMode::Ignore`; otherwise it returns `ManagedRequirementsMode::Include`. It mutates no state.

**Call relations**: All three public sandbox entrypoints call this helper before invoking `run_command_under_sandbox`. Its output later influences `build_debug_sandbox_config_with_loader_overrides`, where `LoaderOverrides.ignore_managed_requirements` may be set.

*Call graph*: called by 3 (run_command_under_landlock, run_command_under_seatbelt, run_command_under_windows_sandbox).


##### `run_command_under_sandbox`  (lines 189–360)

```
async fn run_command_under_sandbox(
    config_options: DebugSandboxConfigOptions,
    command: Vec<String>,
    config_overrides: CliConfigOverrides,
    codex_linux_sandbox_exe: Option<PathBuf>,
```

**Purpose**: Core sandbox launcher that resolves effective configuration, starts any managed network proxy, constructs platform-specific sandbox command lines, spawns the child process, and exits according to the child's status. It is the central execution engine for debug sandbox runs.

**Data flow**: Inputs are `DebugSandboxConfigOptions`, the target command vector, CLI config overrides, an optional `codex_linux_sandbox_exe`, a `SandboxType`, a denial-logging flag, and an optional Unix-socket allowlist. It first parses CLI overrides and loads a `Config` through `load_debug_sandbox_config`; from that config it reads cwd, workspace roots on Windows, shell environment policy, permissions, feature flags, and managed-network settings. It builds an environment map with `create_env`, may immediately transfer control to `run_command_under_windows_session`, may start a managed proxy from `config.permissions.network`, derives `runtime_permission_profile` with `with_managed_mitm_ca_readable_root`, then branches by sandbox type to compute Seatbelt or Landlock command arguments and spawn the child via `spawn_debug_sandbox_child`. After waiting for the child, it optionally gathers and prints Seatbelt denials, then passes the exit status to `handle_exit_status`, which terminates or returns according to project policy.

**Call relations**: This function is called by the Seatbelt, Landlock, and Windows wrapper entrypoints. It delegates configuration assembly to `load_debug_sandbox_config`, process creation to `spawn_debug_sandbox_child`, Windows execution to `run_command_under_windows_session`, and final status handling to `handle_exit_status`; on macOS it also coordinates `DenialLogger` around the child lifecycle.

*Call graph*: calls 9 internal fn (load_debug_sandbox_config, run_command_under_windows_session, spawn_debug_sandbox_child, handle_exit_status, create_env, allow_network_for_proxy, create_linux_sandbox_command_args_for_permission_profile, create_seatbelt_command_args, parse_overrides); called by 3 (run_command_under_landlock, run_command_under_seatbelt, run_command_under_windows_sandbox); 6 external calls (from, bail!, with_managed_mitm_ca_readable_root, eprintln!, default, unreachable!).


##### `run_command_under_windows_session`  (lines 363–408)

```
async fn run_command_under_windows_session(
    config: &Config,
    command: Vec<String>,
    cwd: AbsolutePathBuf,
    workspace_roots: Vec<AbsolutePathBuf>,
    env: std::collections::HashMap<Strin
```

**Purpose**: Executes the command inside a Windows sandbox session and then terminates the current process with the sandboxed command's exit code. It exists to emulate inherited stdio semantics on Windows.

**Data flow**: The function takes a resolved `Config`, command vector, absolute cwd, workspace roots, and environment map. It reads the effective permission profile, codex home, Windows sandbox level, and private-desktop setting from `config`, constructs a `WindowsSandboxSessionRequest`, and awaits sandbox session creation. On spawn failure it prints an error and exits with code 1; on success it forwards stdio through `codex_windows_sandbox::forward_sandbox_session_stdio`, receives an exit code, and calls `std::process::exit(exit_code)`, never returning.

**Call relations**: Only `run_command_under_sandbox` calls this function, and only when `SandboxType::Windows` is selected on a Windows build. It is the terminal branch of the control flow for Windows sandbox execution.

*Call graph*: calls 1 internal fn (as_path); called by 1 (run_command_under_sandbox); 4 external calls (forward_sandbox_session_stdio, eprintln!, from_config, exit).


##### `spawn_debug_sandbox_child`  (lines 410–439)

```
async fn spawn_debug_sandbox_child(
    program: PathBuf,
    args: Vec<String>,
    arg0: Option<&str>,
    cwd: PathBuf,
    network_sandbox_policy: NetworkSandboxPolicy,
    mut env: std::collectio
```

**Purpose**: Builds and spawns the actual sandbox launcher process with a fully controlled environment and inherited stdio. It abstracts the common child-process setup shared by Seatbelt and Landlock.

**Data flow**: The function receives the launcher program path, argument vector, optional `arg0`, cwd, `NetworkSandboxPolicy`, an environment map, and a closure that can mutate that map before launch. It creates a `TokioCommand`, sets Unix `arg0` when available, appends args, sets current dir, applies the closure to the env map, clears inherited environment variables, installs the new envs, conditionally sets `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR=1` when networking is disabled, configures stdin/stdout/stderr to inherit, enables `kill_on_drop`, and spawns the child. It returns `std::io::Result<Child>`.

**Call relations**: The shared sandbox runner calls this helper after computing platform-specific command arguments. It is intentionally low-level and does not decide policy itself; instead it receives already-derived network policy and env mutations from `run_command_under_sandbox`.

*Call graph*: calls 1 internal fn (is_enabled); called by 1 (run_command_under_sandbox); 2 external calls (inherit, new).


##### `load_debug_sandbox_config`  (lines 441–455)

```
async fn load_debug_sandbox_config(
    cli_overrides: Vec<(String, TomlValue)>,
    codex_linux_sandbox_exe: Option<PathBuf>,
    options: DebugSandboxConfigOptions,
    strict_config: bool,
) -> any
```

**Purpose**: Thin wrapper that loads sandbox configuration without overriding `codex_home`. It exists to keep the production path simple while tests can target the more configurable variant.

**Data flow**: The function takes parsed CLI overrides, an optional Linux sandbox executable path, `DebugSandboxConfigOptions`, and a `strict_config` flag, then forwards them to `load_debug_sandbox_config_with_codex_home` with `codex_home` set to `None`. It returns the resulting `Config` or propagated error.

**Call relations**: Only `run_command_under_sandbox` calls this wrapper in production flow. It delegates all real decision-making to `load_debug_sandbox_config_with_codex_home`.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); called by 1 (run_command_under_sandbox).


##### `load_debug_sandbox_config_with_codex_home`  (lines 457–517)

```
async fn load_debug_sandbox_config_with_codex_home(
    cli_overrides: Vec<(String, TomlValue)>,
    codex_linux_sandbox_exe: Option<PathBuf>,
    options: DebugSandboxConfigOptions,
    codex_home: O
```

**Purpose**: Builds the effective sandbox `Config` while preserving historical defaults for legacy configs and honoring explicit permission-profile or legacy sandbox-mode overrides. This function encodes the file's most important configuration precedence rules.

**Data flow**: Inputs are CLI override pairs, optional Linux sandbox executable path, `DebugSandboxConfigOptions`, optional `codex_home`, and `strict_config`. It destructures the options, appends a `default_permissions` CLI override when `permissions_profile` is present, checks whether the CLI explicitly set legacy `sandbox_mode`, and performs an initial config build via `build_debug_sandbox_config_with_loader_overrides` using cwd and sandbox executable harness overrides. If that config already uses permission profiles or the CLI explicitly requested legacy `sandbox_mode`, it returns the config unchanged; otherwise it rebuilds with `ConfigOverrides { sandbox_mode: Some(SandboxMode::ReadOnly), ... }` so legacy configs default to read-only. The function returns the chosen `Config`.

**Call relations**: Production code reaches this function through `load_debug_sandbox_config`, while the test suite calls it directly with temporary `codex_home` directories to verify precedence behavior. It relies on `cli_overrides_use_legacy_sandbox_mode`, `config_uses_permission_profiles`, and `build_debug_sandbox_config_with_loader_overrides` to make and realize its branching decision.

*Call graph*: calls 3 internal fn (build_debug_sandbox_config_with_loader_overrides, cli_overrides_use_legacy_sandbox_mode, config_uses_permission_profiles); called by 8 (load_debug_sandbox_config, debug_sandbox_defaults_legacy_configs_to_read_only, debug_sandbox_honors_active_permission_profiles, debug_sandbox_honors_config_profile_loader_overrides, debug_sandbox_honors_explicit_builtin_permission_profile, debug_sandbox_honors_explicit_legacy_sandbox_mode, debug_sandbox_honors_explicit_named_permission_profile, debug_sandbox_uses_explicit_cwd); 2 external calls (default, String).


##### `build_debug_sandbox_config_with_loader_overrides`  (lines 519–541)

```
async fn build_debug_sandbox_config_with_loader_overrides(
    cli_overrides: Vec<(String, TomlValue)>,
    harness_overrides: ConfigOverrides,
    codex_home: Option<PathBuf>,
    managed_requirement
```

**Purpose**: Constructs a `ConfigBuilder`, applies CLI, harness, loader, and optional codex-home overrides, and asynchronously builds the final `Config`. It is the low-level config assembly primitive used by both production and tests.

**Data flow**: The function consumes CLI override pairs, `ConfigOverrides`, optional `codex_home`, a `ManagedRequirementsMode`, mutable `LoaderOverrides`, and `strict_config`. It starts from `ConfigBuilder::default()`, applies CLI overrides, harness overrides, and strictness, flips `loader_overrides.ignore_managed_requirements` when the mode is `Ignore`, attaches loader overrides, and if `codex_home` is provided also sets both `codex_home` and `fallback_cwd(Some(codex_home))`. Finally it awaits `builder.build()` and returns the resulting `std::io::Result<Config>`.

**Call relations**: This helper is called by `load_debug_sandbox_config_with_codex_home`, by the test-only `tests::build_debug_sandbox_config`, and directly by one test that verifies loader override behavior. It is the shared implementation point for all config construction in this file.

*Call graph*: called by 3 (load_debug_sandbox_config_with_codex_home, build_debug_sandbox_config, debug_sandbox_honors_config_profile_loader_overrides); 2 external calls (default, matches!).


##### `config_uses_permission_profiles`  (lines 543–549)

```
fn config_uses_permission_profiles(config: &Config) -> bool
```

**Purpose**: Detects whether the effective config stack contains a `default_permissions` setting, which the sandbox loader treats as evidence that permission-profile syntax is active. It is a small predicate used to choose between profile semantics and legacy read-only fallback.

**Data flow**: The function reads `config.config_layer_stack.effective_config()`, looks up the `default_permissions` key, and returns `true` if present and `false` otherwise. It performs no mutation.

**Call relations**: Only `load_debug_sandbox_config_with_codex_home` calls this predicate, using it to decide whether to keep the initially built config or rebuild with `SandboxMode::ReadOnly`.

*Call graph*: called by 1 (load_debug_sandbox_config_with_codex_home).


##### `cli_overrides_use_legacy_sandbox_mode`  (lines 551–553)

```
fn cli_overrides_use_legacy_sandbox_mode(cli_overrides: &[(String, TomlValue)]) -> bool
```

**Purpose**: Checks whether the CLI explicitly supplied a legacy `sandbox_mode` override. That explicit request suppresses the automatic read-only fallback logic for legacy configs.

**Data flow**: The function iterates over the `(String, TomlValue)` override pairs and returns `true` if any key equals `sandbox_mode`. It reads only the provided slice and returns a boolean.

**Call relations**: This helper is used exclusively by `load_debug_sandbox_config_with_codex_home` as part of its precedence logic between explicit legacy mode requests and implicit legacy defaults.

*Call graph*: called by 1 (load_debug_sandbox_config_with_codex_home).


##### `tests::build_debug_sandbox_config`  (lines 561–577)

```
async fn build_debug_sandbox_config(
        cli_overrides: Vec<(String, TomlValue)>,
        harness_overrides: ConfigOverrides,
        codex_home: Option<PathBuf>,
        managed_requirements_mode
```

**Purpose**: Test-only convenience wrapper around the production config builder that supplies default `LoaderOverrides`. It reduces boilerplate in the sandbox configuration tests.

**Data flow**: The helper accepts CLI overrides, harness overrides, optional codex home, managed-requirements mode, and strictness, then calls `build_debug_sandbox_config_with_loader_overrides` with `LoaderOverrides::default()`. It returns the built `Config` or I/O error.

**Call relations**: Multiple tests in this module call this helper when they do not need custom loader overrides. It delegates directly to the production builder to ensure tests exercise the same config assembly path.

*Call graph*: calls 1 internal fn (build_debug_sandbox_config_with_loader_overrides); 1 external calls (default).


##### `tests::escape_toml_path`  (lines 579–581)

```
fn escape_toml_path(path: &std::path::Path) -> String
```

**Purpose**: Escapes backslashes in a filesystem path so it can be embedded safely into TOML string literals in test-generated config files. This is mainly relevant for cross-platform path formatting.

**Data flow**: The function takes a `&Path`, converts it to a display string, replaces `\` with `\\`, and returns the escaped `String`. It reads only the input path and produces a transformed string.

**Call relations**: This helper is used by `tests::write_permissions_profile_config_to_path` while constructing TOML fixture content. It isolates path escaping from the rest of the test setup.

*Call graph*: 1 external calls (display).


##### `tests::write_permissions_profile_config`  (lines 583–593)

```
fn write_permissions_profile_config(
        codex_home: &TempDir,
        docs: &std::path::Path,
        private: &std::path::Path,
    ) -> std::io::Result<()>
```

**Purpose**: Writes a standard permission-profile test config into `<codex_home>/config.toml`. It is a convenience wrapper for the more general path-based writer.

**Data flow**: The function takes a `TempDir` representing codex home plus `docs` and `private` paths, computes `codex_home.path().join("config.toml")`, and forwards all three paths to `write_permissions_profile_config_to_path`. It returns that helper's `std::io::Result<()>`.

**Call relations**: Tests that want the default config location call this wrapper instead of specifying a path manually. It delegates all actual file creation and content generation to `write_permissions_profile_config_to_path`.

*Call graph*: 2 external calls (path, write_permissions_profile_config_to_path).


##### `tests::write_permissions_profile_config_to_path`  (lines 595–615)

```
fn write_permissions_profile_config_to_path(
        config_path: &std::path::Path,
        docs: &std::path::Path,
        private: &std::path::Path,
    ) -> std::io::Result<()>
```

**Purpose**: Creates a TOML config file defining a named permission profile with explicit filesystem and network rules for test fixtures. It materializes the profile syntax that the loader-under-test must recognize.

**Data flow**: Given a target config path and `docs`/`private` directories, the function first ensures the `private` directory exists with `create_dir_all`. It then formats a TOML string containing `default_permissions = "limited-read-test"`, filesystem entries granting read access to `:minimal` and `docs` while denying `private`, plus `[permissions.limited-read-test.network] enabled = true`, and writes that string to `config_path`. It returns `Ok(())` on success.

**Call relations**: This helper underpins several tests that need a concrete permission-profile config file. It is called either directly or through `write_permissions_profile_config` before the tests invoke the production config-loading functions.

*Call graph*: 3 external calls (format!, create_dir_all, write).


##### `tests::debug_sandbox_honors_active_permission_profiles`  (lines 618–676)

```
async fn debug_sandbox_honors_active_permission_profiles() -> anyhow::Result<()>
```

**Purpose**: Verifies that when a config file uses permission-profile syntax, the debug sandbox loader preserves that profile-based policy instead of forcing legacy read-only behavior. It compares the loaded config against both profile-based and legacy-built baselines.

**Data flow**: The test creates temporary codex-home and sandbox-path directories, writes a permission-profile config, builds one config with no legacy override and another with explicit `SandboxMode::ReadOnly`, then calls `load_debug_sandbox_config_with_codex_home` against the same codex home. It asserts that the loaded config reports active permission profiles, that the profile-based and legacy filesystem policies differ, and that the loaded policy matches the profile-based one rather than the legacy one.

**Call relations**: This test is run by the Tokio test harness. It uses the test fixture writers plus both `tests::build_debug_sandbox_config` and the production `load_debug_sandbox_config_with_codex_home` to validate the branch where `config_uses_permission_profiles` short-circuits the read-only fallback.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 10 external calls (default, new, new, assert!, assert_eq!, assert_ne!, build_debug_sandbox_config, write_permissions_profile_config, default, default).


##### `tests::debug_sandbox_honors_config_profile_loader_overrides`  (lines 679–740)

```
async fn debug_sandbox_honors_config_profile_loader_overrides() -> anyhow::Result<()>
```

**Purpose**: Checks that loader overrides selecting a specific user config path and profile are respected by the debug sandbox loader. It ensures profile-based config loading works even when the config is not at the default location.

**Data flow**: The test creates temporary directories, writes a permission-profile config to `work.config.toml`, constructs `LoaderOverrides` with `user_config_path` and `user_config_profile`, builds a baseline config using `build_debug_sandbox_config_with_loader_overrides`, builds a read-only comparison config, then loads config through `load_debug_sandbox_config_with_codex_home` using the same loader overrides. It asserts that permission profiles are active, that the profile-based and read-only filesystem policies differ, and that the loaded policy equals the profile-based one.

**Call relations**: The Tokio test harness invokes this test. It directly exercises both the low-level builder and the higher-level loader path to prove that loader overrides propagate through `load_debug_sandbox_config_with_codex_home`.

*Call graph*: calls 3 internal fn (build_debug_sandbox_config_with_loader_overrides, load_debug_sandbox_config_with_codex_home, from_absolute_path); 10 external calls (default, new, new, assert!, assert_eq!, assert_ne!, build_debug_sandbox_config, write_permissions_profile_config_to_path, default, default).


##### `tests::debug_sandbox_honors_explicit_legacy_sandbox_mode`  (lines 743–810)

```
async fn debug_sandbox_honors_explicit_legacy_sandbox_mode() -> anyhow::Result<()>
```

**Purpose**: Ensures that an explicit CLI `sandbox_mode` override wins over the automatic legacy read-only defaulting logic. It covers the compatibility path for older callers that still pass legacy sandbox mode settings.

**Data flow**: The test creates a temporary codex home, prepares CLI overrides containing `sandbox_mode = "workspace-write"`, builds a `workspace_write_config`, builds a `read_only_config`, and then loads config through `load_debug_sandbox_config_with_codex_home` with the same CLI overrides. It conditionally asserts either equality or inequality between workspace-write and read-only policies depending on whether Windows downgrades the mode, and finally asserts that the loaded config's filesystem policy matches the explicit workspace-write baseline.

**Call relations**: This test targets the branch in `load_debug_sandbox_config_with_codex_home` where `cli_overrides_use_legacy_sandbox_mode` suppresses the implicit read-only rebuild. It uses the test helper builder for baselines and the production loader for the actual behavior under test.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 10 external calls (default, new, new, assert_eq!, assert_ne!, cfg!, build_debug_sandbox_config, default, default, vec!).


##### `tests::debug_sandbox_defaults_legacy_configs_to_read_only`  (lines 813–850)

```
async fn debug_sandbox_defaults_legacy_configs_to_read_only() -> anyhow::Result<()>
```

**Purpose**: Verifies the historical default that legacy configs without permission profiles or explicit `sandbox_mode` are treated as read-only by `codex sandbox`. It protects a backward-compatibility behavior encoded in the loader.

**Data flow**: The test creates a temporary codex home, builds a baseline config with `ConfigOverrides { sandbox_mode: Some(SandboxMode::ReadOnly), .. }`, then loads config through `load_debug_sandbox_config_with_codex_home` with no CLI overrides and default loader overrides. It asserts that the loaded config does not use permission profiles and that its filesystem sandbox policy equals the read-only baseline.

**Call relations**: This Tokio test exercises the fallback branch of `load_debug_sandbox_config_with_codex_home` where neither permission profiles nor explicit legacy sandbox mode are present, forcing a rebuild with `SandboxMode::ReadOnly`.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 7 external calls (default, new, new, assert!, assert_eq!, build_debug_sandbox_config, default).


##### `tests::debug_sandbox_honors_explicit_builtin_permission_profile`  (lines 853–885)

```
async fn debug_sandbox_honors_explicit_builtin_permission_profile() -> anyhow::Result<()>
```

**Purpose**: Checks that explicitly selecting the built-in `:workspace` permission profile preserves the built-in workspace-write rules even when managed requirements are ignored. It validates direct profile selection independent of user config files.

**Data flow**: The test creates a temporary codex home and loads config through `load_debug_sandbox_config_with_codex_home` with `permissions_profile: Some(":workspace".to_string())`, `cwd: None`, and `ManagedRequirementsMode::Ignore`. It extracts the actual filesystem sandbox policy from the loaded permission profile, computes the expected built-in workspace-write policy via `codex_protocol::models::PermissionProfile::workspace_write()`, and asserts that every expected entry is present in the actual policy.

**Call relations**: This test directly targets the code path where `load_debug_sandbox_config_with_codex_home` injects a `default_permissions` CLI override from `permissions_profile`. It does not use the test config writers because it is validating a built-in profile.

*Call graph*: calls 2 internal fn (load_debug_sandbox_config_with_codex_home, workspace_write); 4 external calls (new, new, assert!, default).


##### `tests::debug_sandbox_honors_explicit_named_permission_profile`  (lines 888–927)

```
async fn debug_sandbox_honors_explicit_named_permission_profile() -> anyhow::Result<()>
```

**Purpose**: Verifies that explicitly naming a user-defined permission profile causes the loader to select that profile's policy. It confirms parity between direct profile selection and manually supplying the equivalent `default_permissions` override.

**Data flow**: The test creates temporary codex-home and sandbox-path directories, writes a permission-profile config, loads config through `load_debug_sandbox_config_with_codex_home` with `permissions_profile: Some("limited-read-test".to_string())` and `ManagedRequirementsMode::Ignore`, then builds an expected config using `tests::build_debug_sandbox_config` with an explicit `default_permissions` CLI override for the same profile name. It asserts that the loaded and expected filesystem sandbox policies are equal.

**Call relations**: This Tokio test exercises the explicit-profile branch of `load_debug_sandbox_config_with_codex_home` and compares it against the lower-level builder path to prove they converge on the same effective policy.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 8 external calls (new, new, assert_eq!, build_debug_sandbox_config, write_permissions_profile_config, default, default, vec!).


##### `tests::debug_sandbox_uses_explicit_cwd`  (lines 930–951)

```
async fn debug_sandbox_uses_explicit_cwd() -> anyhow::Result<()>
```

**Purpose**: Confirms that an explicit cwd supplied in debug sandbox options is preserved in the loaded config. It protects the path-resolution basis used later for workspace and policy calculations.

**Data flow**: The test creates temporary codex-home and cwd directories, calls `load_debug_sandbox_config_with_codex_home` with `permissions_profile: Some(":workspace".to_string())` and `cwd: Some(cwd.path().to_path_buf())`, then asserts that `config.cwd.as_path()` equals the provided cwd path. It reads only the returned config and performs no further mutation.

**Call relations**: This test directly invokes the production loader to validate that `DebugSandboxConfigOptions.cwd` is threaded through config construction unchanged.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 4 external calls (new, new, assert_eq!, default).


### `cli/src/sandbox_setup.rs`

`orchestration` · `on demand during Windows `codex sandbox setup ...` handling`

This file is a small Windows-specific helper layered under the broader `codex sandbox` command. Because the main sandbox command normally treats trailing arguments as the command to run inside the sandbox, `parse_setup_command` first peeks at the first trailing token and only invokes clap parsing when that token is literally `setup`; otherwise it returns `None` so normal sandbox execution can proceed. The parsed `SandboxSetupCommand` requires either `--user` plus `--codex-home` or `--current-user`, and currently supports only one setup level: `--elevated`.

Execution starts in `run`, which asks `SandboxSetupCommand::setup_level` to reject unsupported invocations early. `run_elevated` then resolves the target identity through `resolve_sandbox_setup_identity`: for `--current-user` it reads `USERNAME` or `USER` from the environment and defaults `codex_home` from `find_codex_home()` when not explicitly supplied; for managed-user mode it requires both the user string and explicit Codex home path. With that identity, it calls `codex_core::windows_sandbox::run_elevated_provisioning_setup` to perform the OS-level provisioning, then persists `windows_sandbox_mode = "elevated"` via `ConfigEditsBuilder`. A notable edge case is partial success: if provisioning succeeds but config persistence fails, the function returns a wrapped error explicitly saying setup succeeded but config could not be written. Tests focus on clap constraints and the setup-command detection shim.

#### Function details

##### `SandboxSetupCommand::setup_level`  (lines 48–54)

```
fn setup_level(&self) -> anyhow::Result<SandboxSetupLevel>
```

**Purpose**: Validates that the parsed setup command requested a supported sandbox setup level.

**Data flow**: Reads `self.elevated_sandbox_level`; if true it returns `SandboxSetupLevel::Elevated`, otherwise it returns an error stating that `codex sandbox setup` currently requires `--elevated`.

**Call relations**: Called by `run` before dispatching to the concrete setup implementation.

*Call graph*: called by 1 (run); 1 external calls (bail!).


##### `run`  (lines 57–61)

```
async fn run(cmd: SandboxSetupCommand) -> anyhow::Result<()>
```

**Purpose**: Dispatches the parsed sandbox setup command to the implementation for its validated setup level.

**Data flow**: Consumes `SandboxSetupCommand`, calls `setup_level()`, matches the resulting enum, and currently forwards only `Elevated` to `run_elevated`.

**Call relations**: Called from `cli_main` after `parse_setup_command` recognizes a sandbox setup invocation.

*Call graph*: calls 2 internal fn (setup_level, run_elevated); called by 1 (cli_main).


##### `parse_setup_command`  (lines 63–76)

```
fn parse_setup_command(
    sandbox_command: &[String],
) -> anyhow::Result<Option<SandboxSetupCommand>>
```

**Purpose**: Detects whether sandbox trailing arguments represent the special `setup` subcommand and, if so, parses them with clap.

**Data flow**: Borrows the sandbox command argument slice. If the first element is absent or not equal to `setup`, it returns `Ok(None)`. Otherwise it runs `SandboxSetupCommand::try_parse_from` over the string slice iterator and returns `Some(parsed_command)` or a clap-derived error.

**Call relations**: Called by `cli_main` before normal sandbox execution so Windows setup can be intercepted from the trailing-var-arg command shape.

*Call graph*: called by 3 (cli_main, ignores_non_setup_sandbox_command_args, parses_setup_from_sandbox_command_args); 1 external calls (try_parse_from).


##### `run_elevated`  (lines 78–101)

```
async fn run_elevated(cmd: SandboxSetupCommand) -> anyhow::Result<()>
```

**Purpose**: Performs elevated Windows sandbox provisioning for the resolved user and persists the elevated sandbox mode in config.

**Data flow**: Consumes `SandboxSetupCommand`, resolves `SandboxSetupIdentity` with `resolve_sandbox_setup_identity`, calls `codex_core::windows_sandbox::run_elevated_provisioning_setup` with the target Codex home and real user, then uses `ConfigEditsBuilder` rooted at that Codex home to set `windows_sandbox_mode("elevated")` and apply the edit. On success it prints a completion message naming the user and Codex home; on config-write failure after provisioning it returns a wrapped partial-success error.

**Call relations**: Called only by `run` for the `Elevated` setup level.

*Call graph*: calls 3 internal fn (resolve_sandbox_setup_identity, new, run_elevated_provisioning_setup); called by 1 (run); 1 external calls (println!).


##### `resolve_sandbox_setup_identity`  (lines 108–139)

```
fn resolve_sandbox_setup_identity(
    cmd: &SandboxSetupCommand,
) -> anyhow::Result<SandboxSetupIdentity>
```

**Purpose**: Determines which Windows user and Codex home directory the elevated sandbox should be provisioned for.

**Data flow**: Borrows `SandboxSetupCommand`. If `current_user` is true, it reads `USERNAME` or `USER` from the environment, chooses `cmd.codex_home` when provided or falls back to `find_codex_home()`, and returns that identity. Otherwise it requires `cmd.user` and `cmd.codex_home`, returning errors if either is missing. The result is a `SandboxSetupIdentity { real_user, codex_home }`.

**Call relations**: Used only by `run_elevated` to normalize the two supported identity-selection modes.

*Call graph*: calls 1 internal fn (find_codex_home); called by 1 (run_elevated); 1 external calls (var).


##### `tests::parses_managed_user_identity`  (lines 146–164)

```
fn parses_managed_user_identity()
```

**Purpose**: Verifies clap parsing for managed-user elevated sandbox setup.

**Data flow**: Parses a `setup --elevated --user ... --codex-home ...` argv vector and asserts the elevated flag, user string, `current_user=false`, and parsed Codex home path.

**Call relations**: Parser coverage for `SandboxSetupCommand`.

*Call graph*: 3 external calls (assert!, assert_eq!, try_parse_from).


##### `tests::requires_explicit_user_identity`  (lines 167–172)

```
fn requires_explicit_user_identity()
```

**Purpose**: Ensures setup parsing fails when neither `--user` nor `--current-user` is supplied.

**Data flow**: Attempts to parse `setup --elevated`, expects a clap error, and asserts the error kind is `MissingRequiredArgument`.

**Call relations**: Tests the `ArgGroup` requirement on `SandboxSetupCommand`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::requires_codex_home_for_managed_user`  (lines 175–181)

```
fn requires_codex_home_for_managed_user()
```

**Purpose**: Ensures managed-user setup parsing requires `--codex-home` alongside `--user`.

**Data flow**: Attempts to parse `setup --elevated --user DOMAIN\alice`, expects a clap error, and asserts the error kind is `MissingRequiredArgument`.

**Call relations**: Tests the `requires = "codex_home"` parser rule.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::parses_setup_from_sandbox_command_args`  (lines 184–197)

```
fn parses_setup_from_sandbox_command_args()
```

**Purpose**: Verifies that the setup-command detection shim recognizes and parses `setup` from sandbox trailing arguments.

**Data flow**: Builds a `Vec<String>` beginning with `setup`, passes it to `parse_setup_command`, unwraps the resulting `Some(command)`, and asserts the parsed user string.

**Call relations**: Tests the interception path used by `cli_main`.

*Call graph*: calls 1 internal fn (parse_setup_command); 1 external calls (assert_eq!).


##### `tests::ignores_non_setup_sandbox_command_args`  (lines 200–205)

```
fn ignores_non_setup_sandbox_command_args()
```

**Purpose**: Verifies that ordinary sandbox command arguments are ignored by the setup-command shim.

**Data flow**: Passes a non-setup trailing command vector into `parse_setup_command` and asserts the result is `None`.

**Call relations**: Tests the non-intercept path so normal sandbox execution is unaffected.

*Call graph*: calls 1 internal fn (parse_setup_command); 1 external calls (assert!).


### `cli/src/doctor/thread_inventory.rs`

`domain_logic` · `doctor request handling`

This file implements a substantial doctor check for thread inventory parity between rollout JSONL files under `CODEX_HOME` and `threads` rows in the SQLite state DB. `thread_inventory_check` forwards configured roots into `thread_inventory_check_for_roots`, which first scans rollout files, records malformed names and scan errors, and then either handles a missing DB specially or reads `ThreadStateAuditRow` values from SQLite for a full comparison.

Scanning is bounded by `MAX_PARITY_SCAN_FILES` across valid files, malformed names, and scan errors. `scan_rollout_root` walks directories iteratively, ignores non-files and non-`rollout-*.jsonl` names, extracts thread IDs by parsing rollout contents with `RolloutRecorder::load_rollout_items` and `codex_rollout::builder_from_items`, and stores normalized path keys for later matching. Path normalization via `normalize_for_path_comparison` avoids false mismatches from path representation differences.

`parity_check_from_scan_and_rows` builds maps keyed by normalized rollout path, then computes missing active/archived DB rows, stale DB rows pointing to missing files, archive-flag mismatches, duplicate rollout thread IDs, duplicate DB paths, and compact summaries of model providers and source categories. Expensive or potentially misleading checks for stale rows and archive mismatches are skipped when the scan cap was reached. The final `DoctorCheck` is `Ok` only when scan quality is clean and all parity sets are empty; otherwise it becomes `Warning` and accumulates `DoctorIssue`s describing each discrepancy class. The test module creates temporary rollout files and SQLite rows to validate both clean and divergent cases, plus helper behavior like source coarsening and summary truncation.

#### Function details

##### `RolloutScan::candidate_count`  (lines 49–51)

```
fn candidate_count(&self) -> usize
```

**Purpose**: Returns the total number of scan candidates already consumed toward the parity scan cap. It counts valid files, malformed names, and scan errors together.

**Data flow**: Reads `self.files.len()`, `self.malformed_names.len()`, and `self.scan_errors.len()`, sums them, and returns the resulting `usize`.

**Call relations**: This helper feeds cap enforcement logic in `reached_candidate_cap` and is also consulted directly by `scan_rollout_root` before admitting another rollout file.

*Call graph*: called by 2 (reached_candidate_cap, scan_rollout_root).


##### `RolloutScan::reached_candidate_cap`  (lines 53–55)

```
fn reached_candidate_cap(&self) -> bool
```

**Purpose**: Checks whether the bounded rollout scan has reached or exceeded `MAX_PARITY_SCAN_FILES`. It treats all candidate outcomes as consuming budget.

**Data flow**: Calls `candidate_count`, compares the result against the constant cap, and returns a boolean.

**Call relations**: Used by `record_malformed_name` and `record_scan_error` so those methods can stop accumulating once the global scan budget is exhausted.

*Call graph*: calls 1 internal fn (candidate_count); called by 2 (record_malformed_name, record_scan_error).


##### `RolloutScan::record_malformed_name`  (lines 57–64)

```
fn record_malformed_name(&mut self, path: PathBuf)
```

**Purpose**: Adds a malformed rollout filename to the scan result unless the scan cap has already been reached. It also updates the `reached_scan_cap` flag after insertion.

**Data flow**: Takes ownership of a `PathBuf`, checks `reached_candidate_cap`, and either sets `reached_scan_cap` and returns early or pushes the path into `malformed_names` and recomputes whether the cap is now reached.

**Call relations**: Called from `scan_rollout_root` when a rollout file exists but `thread_id_from_rollout` reports `MalformedName`, keeping malformed files visible in doctor output without crashing the scan.

*Call graph*: calls 1 internal fn (reached_candidate_cap); called by 1 (scan_rollout_root).


##### `RolloutScan::record_scan_error`  (lines 66–73)

```
fn record_scan_error(&mut self, message: String)
```

**Purpose**: Adds a textual scan error unless the scan cap has already been reached. It mirrors malformed-name handling for I/O and parsing failures.

**Data flow**: Consumes an error message string, checks `reached_candidate_cap`, and either marks `reached_scan_cap` and returns or pushes the message into `scan_errors` and refreshes the cap flag.

**Call relations**: Called from `scan_rollout_root` for directory read failures, entry iteration failures, file-type lookup failures, and unusable rollout contents.

*Call graph*: calls 1 internal fn (reached_candidate_cap); called by 1 (scan_rollout_root).


##### `RolloutScan::active_count`  (lines 75–77)

```
fn active_count(&self) -> usize
```

**Purpose**: Counts scanned rollout files that came from the active `sessions` tree. It excludes archived files.

**Data flow**: Iterates over `self.files`, filters on `!file.archived`, counts matches, and returns the count.

**Call relations**: Used when `thread_inventory_check_for_roots` builds top-level details summarizing the scan before DB comparison.


##### `RolloutScan::archived_count`  (lines 79–81)

```
fn archived_count(&self) -> usize
```

**Purpose**: Counts scanned rollout files that came from the `archived_sessions` tree. It is the archived complement of `active_count`.

**Data flow**: Iterates over `self.files`, filters on `file.archived`, counts matches, and returns the count.

**Call relations**: Used by `thread_inventory_check_for_roots` to report scan totals in the doctor details.


##### `thread_inventory_check`  (lines 84–91)

```
async fn thread_inventory_check(config: &Config) -> DoctorCheck
```

**Purpose**: Runs the rollout-vs-state-DB parity check using paths from the loaded doctor configuration. It is the public async entry for this module.

**Data flow**: Reads `codex_home`, `sqlite_home`, and `model_provider_id` from `Config`, passes them to `thread_inventory_check_for_roots`, awaits the result, and returns the resulting `DoctorCheck`.

**Call relations**: This is the function the doctor subsystem invokes. It delegates all substantive work to `thread_inventory_check_for_roots`.

*Call graph*: calls 1 internal fn (thread_inventory_check_for_roots).


##### `thread_inventory_check_for_roots`  (lines 93–153)

```
async fn thread_inventory_check_for_roots(
    codex_home: &Path,
    sqlite_home: &Path,
    default_provider: &str,
) -> DoctorCheck
```

**Purpose**: Coordinates rollout scanning, state DB lookup, and parity analysis for explicit filesystem roots. It also handles missing or unreadable state DB cases before deeper comparison.

**Data flow**: Accepts `codex_home`, `sqlite_home`, and a default provider string; awaits `scan_rollout_files`; computes the SQLite DB path with `codex_state::state_db_path`; initializes details with provider and scan counts; appends scan-error and malformed-file samples via `push_samples`; checks whether the DB file exists; if absent, returns `missing_state_db_check`; otherwise awaits `codex_state::read_thread_state_audit_rows`. On DB read failure it returns a warning `DoctorCheck` with a `DoctorIssue`; on success it forwards scan results, rows, and accumulated details into `parity_check_from_scan_and_rows`.

**Call relations**: Called by the production wrapper and by integration-style tests. It is the orchestration point that decides whether to stop at missing/unreadable DB handling or continue into full parity analysis.

*Call graph*: calls 6 internal fn (new, new, missing_state_db_check, parity_check_from_scan_and_rows, push_samples, scan_rollout_files); called by 3 (thread_inventory_check_ok_when_rollouts_match_db, thread_inventory_check_warns_for_missing_stale_and_mismatched_rows, thread_inventory_check); 4 external calls (read_thread_state_audit_rows, state_db_path, format!, vec!).


##### `missing_state_db_check`  (lines 155–210)

```
fn missing_state_db_check(scan: RolloutScan, details: Vec<String>) -> DoctorCheck
```

**Purpose**: Builds the doctor result for scenarios where the SQLite state DB is absent. It distinguishes a truly empty system from rollout files existing without a DB and from incomplete scans.

**Data flow**: Consumes a `RolloutScan` and prebuilt details. If there are no scanned files, no scan errors, no malformed names, and the cap was not reached, it returns an `Ok` check stating there is nothing to compare. Otherwise it creates a warning check whose summary depends on whether rollout files were found, conditionally adds an issue and remediation for missing DB rows when files exist, and conditionally adds another issue when the rollout scan itself was incomplete or dirty.

**Call relations**: This function is reached only from `thread_inventory_check_for_roots` when `state_db_path.is_file()` is false, isolating the special-case logic from the normal parity path.

*Call graph*: calls 2 internal fn (new, new); called by 1 (thread_inventory_check_for_roots); 1 external calls (format!).


##### `parity_check_from_scan_and_rows`  (lines 212–421)

```
fn parity_check_from_scan_and_rows(
    codex_home: &Path,
    scan: RolloutScan,
    rows: Vec<ThreadStateAuditRow>,
    mut details: Vec<String>,
) -> DoctorCheck
```

**Purpose**: Performs the actual parity comparison between scanned rollout files and `ThreadStateAuditRow` records. It computes discrepancy sets, summarizes row metadata, and emits warning issues for each problem class.

**Data flow**: Takes `codex_home`, a completed `RolloutScan`, DB rows, and an existing details vector. It builds `rollout_by_key` from scanned files and `rows_by_key` from DB rows using normalized `path_key`s. It computes missing active and archived rollout paths with `missing_rollout_paths`; if the scan was complete, it also derives stale rows whose `rollout_path` is not a file and archive mismatches by comparing row flags against scanned files or `archived_from_rollout_path`. It computes duplicate rollout thread IDs and duplicate DB paths, counts active/archived rows, appends many aggregate details and bounded samples, derives overall status, creates a `DoctorCheck`, and conditionally attaches `DoctorIssue`s for missing rows, stale rows, archive mismatches, duplicates, and scan-quality problems.

**Call relations**: This is the core comparison engine called after successful DB reads in `thread_inventory_check_for_roots`. It delegates focused subproblems to helpers like `missing_rollout_paths`, `duplicate_rollout_thread_ids`, `duplicate_db_paths`, `source_category`, `count_summary`, and the sample pushers.

*Call graph*: calls 8 internal fn (new, new, duplicate_db_paths, duplicate_rollout_thread_ids, missing_rollout_paths, path_key, push_path_samples, push_samples); called by 1 (thread_inventory_check_for_roots); 3 external calls (new, new, format!).


##### `scan_rollout_files`  (lines 423–438)

```
async fn scan_rollout_files(codex_home: &Path) -> RolloutScan
```

**Purpose**: Scans both active and archived rollout roots under `CODEX_HOME`. It returns a single `RolloutScan` aggregating files, malformed names, errors, and cap state.

**Data flow**: Creates a default `RolloutScan`, calls `scan_rollout_root` on `codex_home/sessions` with `archived = false`, then on `codex_home/archived_sessions` with `archived = true`, awaits both sequentially, and returns the mutated scan.

**Call relations**: This helper is called by `thread_inventory_check_for_roots` before any DB work so the doctor row can always report rollout-side state.

*Call graph*: calls 1 internal fn (scan_rollout_root); called by 1 (thread_inventory_check_for_roots); 2 external calls (join, default).


##### `scan_rollout_root`  (lines 440–503)

```
async fn scan_rollout_root(root: &Path, archived: bool, scan: &mut RolloutScan)
```

**Purpose**: Walks one rollout directory tree iteratively and records valid rollout files, malformed names, and scan errors. It enforces the global candidate cap while traversing.

**Data flow**: Accepts a root path, an `archived` flag, and mutable `RolloutScan`. It uses a stack of directories, repeatedly `read_dir`s each one, skips missing roots, records other directory errors, iterates entries, records entry and file-type errors, pushes subdirectories back onto the stack, ignores non-files and non-rollout filenames, checks the candidate cap, and for each candidate awaits `thread_id_from_rollout`. Depending on the result it records a malformed name, records an unusable-file error, or pushes a `RolloutAuditFile` containing the original path, normalized key from `path_key`, archive flag, and extracted thread ID.

**Call relations**: Called twice by `scan_rollout_files`, once per root tree. It delegates filename filtering to `is_rollout_file`, thread-ID extraction to `thread_id_from_rollout`, and cap/error bookkeeping to `RolloutScan` methods.

*Call graph*: calls 6 internal fn (candidate_count, record_malformed_name, record_scan_error, is_rollout_file, path_key, thread_id_from_rollout); called by 1 (scan_rollout_files); 3 external calls (format!, read_dir, vec!).


##### `thread_id_from_rollout`  (lines 505–516)

```
async fn thread_id_from_rollout(path: &Path) -> RolloutThreadId
```

**Purpose**: Extracts a thread ID from a rollout JSONL file by parsing its items and rebuilding rollout metadata. It distinguishes unreadable files, empty/unparseable contents, and malformed naming/build cases.

**Data flow**: Reads rollout items asynchronously with `RolloutRecorder::load_rollout_items`; on error returns `RolloutThreadId::Unusable(err.to_string())`. If the item list is empty it returns `Unusable("no parseable rollout items")`. Otherwise it calls `codex_rollout::builder_from_items(items.as_slice(), path)` and maps success to `RolloutThreadId::Id(builder.id.to_string())`, falling back to `MalformedName` when builder creation fails.

**Call relations**: This helper is called from `scan_rollout_root` for each candidate rollout file so the scan can compare file-derived thread IDs against DB rows.

*Call graph*: calls 1 internal fn (load_rollout_items); called by 1 (scan_rollout_root); 2 external calls (Unusable, builder_from_items).


##### `is_rollout_file`  (lines 518–524)

```
fn is_rollout_file(path: &Path) -> bool
```

**Purpose**: Recognizes rollout audit files by extension and filename prefix. Only `rollout-*.jsonl` files are considered candidates.

**Data flow**: Reads the path extension and filename, compares the extension to `jsonl`, converts the filename to UTF-8 when possible, checks for the `rollout-` prefix, and returns a boolean.

**Call relations**: Used by `scan_rollout_root` to cheaply filter directory entries before attempting rollout parsing.

*Call graph*: called by 1 (scan_rollout_root); 3 external calls (new, extension, file_name).


##### `count_or_skipped`  (lines 526–532)

```
fn count_or_skipped(count: usize, complete: bool) -> String
```

**Purpose**: Formats a discrepancy count, or a skip marker when the rollout scan was incomplete due to the cap. This prevents misleading exact counts for checks that require a full scan.

**Data flow**: Takes a numeric count and a `complete` flag; returns `count.to_string()` when complete, otherwise the literal `skipped (scan cap reached)`.

**Call relations**: Used inside `parity_check_from_scan_and_rows` for stale-row and archive-mismatch detail lines, where incomplete scans suppress exact conclusions.


##### `path_key`  (lines 534–536)

```
fn path_key(path: &Path) -> PathBuf
```

**Purpose**: Normalizes a filesystem path into a comparison key suitable for matching rollout files to DB rows. It falls back to the original path if normalization fails.

**Data flow**: Calls `normalize_for_path_comparison(path)` and returns the normalized `PathBuf` on success or `path.to_path_buf()` on error.

**Call relations**: This helper is central to parity matching and is used by `scan_rollout_root`, `parity_check_from_scan_and_rows`, and `archived_from_rollout_path` to avoid path-format mismatches.

*Call graph*: called by 3 (archived_from_rollout_path, parity_check_from_scan_and_rows, scan_rollout_root); 1 external calls (normalize_for_path_comparison).


##### `archived_from_rollout_path`  (lines 538–547)

```
fn archived_from_rollout_path(codex_home: &Path, path: &Path) -> Option<bool>
```

**Purpose**: Infers whether a rollout path should be considered archived based on whether it lives under `archived_sessions` or `sessions`. Paths outside those roots yield no inference.

**Data flow**: Normalizes the candidate path and the two root prefixes with `path_key`, checks prefix membership against `codex_home/archived_sessions` and `codex_home/sessions`, and returns `Some(true)`, `Some(false)`, or `None`.

**Call relations**: Used by `parity_check_from_scan_and_rows` as a fallback when a DB row's path was not present in the scanned file map but still exists on disk.

*Call graph*: calls 1 internal fn (path_key); 1 external calls (join).


##### `missing_rollout_paths`  (lines 549–559)

```
fn missing_rollout_paths(
    files: &'a [RolloutAuditFile],
    rows_by_key: &HashMap<PathBuf, Vec<&ThreadStateAuditRow>>,
    archived: bool,
) -> Vec<&'a Path>
```

**Purpose**: Finds rollout files of a given archive state that do not have a matching DB row for both path and thread ID. It returns borrowed filesystem paths for sampling and counting.

**Data flow**: Iterates over `files`, filters to those whose `archived` flag matches the requested value and for which `has_matching_thread_row` returns false, maps each surviving `RolloutAuditFile` to `file.path.as_path()`, and collects the results into a vector.

**Call relations**: Called twice by `parity_check_from_scan_and_rows`, once for active files and once for archived files, to produce the two missing-row discrepancy sets.

*Call graph*: called by 1 (parity_check_from_scan_and_rows); 1 external calls (iter).


##### `has_matching_thread_row`  (lines 561–569)

```
fn has_matching_thread_row(
    file: &RolloutAuditFile,
    rows_by_key: &HashMap<PathBuf, Vec<&ThreadStateAuditRow>>,
) -> bool
```

**Purpose**: Checks whether the DB contains at least one row for a rollout file's normalized path whose thread ID matches the file-derived thread ID. Path match alone is not sufficient.

**Data flow**: Looks up `file.key` in `rows_by_key`; if absent returns false. Otherwise iterates the rows for that path and returns true when any row's `id` equals `file.thread_id`.

**Call relations**: This helper is used by `missing_rollout_paths` to enforce the invariant that both rollout path and thread identity must agree with the DB.


##### `duplicate_rollout_thread_ids`  (lines 571–582)

```
fn duplicate_rollout_thread_ids(files: &[RolloutAuditFile]) -> Vec<String>
```

**Purpose**: Detects thread IDs that appear in more than one scanned rollout file. It returns a sorted unique list of duplicate IDs.

**Data flow**: Iterates over `files`, inserts each `thread_id` into a `seen` set, inserts repeated IDs into a `duplicates` set, converts duplicates into a vector, sorts it, and returns it.

**Call relations**: Called by `parity_check_from_scan_and_rows` to surface rollout-side duplication independently of DB path duplication.

*Call graph*: called by 1 (parity_check_from_scan_and_rows); 2 external calls (new, iter).


##### `duplicate_db_paths`  (lines 584–592)

```
fn duplicate_db_paths(rows_by_key: &HashMap<PathBuf, Vec<&ThreadStateAuditRow>>) -> Vec<PathBuf>
```

**Purpose**: Finds normalized rollout paths that have multiple DB rows associated with them. It returns the duplicate path keys in sorted order.

**Data flow**: Iterates over `rows_by_key`, filters entries whose row vector length exceeds one, clones the corresponding `PathBuf` keys into a vector, sorts it, and returns it.

**Call relations**: Used by `parity_check_from_scan_and_rows` to detect DB-side duplication after rows have already been grouped by normalized path.

*Call graph*: called by 1 (parity_check_from_scan_and_rows).


##### `source_category`  (lines 594–619)

```
fn source_category(source: &str) -> &'static str
```

**Purpose**: Coarsens serialized session-source values into stable summary categories for doctor output. It accepts either structured JSON encodings or plain string forms.

**Data flow**: Attempts to parse the input string as `SessionSource` JSON, falling back to wrapping the raw string as a JSON string value. If parsing fails it returns `unparsable`; otherwise it pattern-matches the parsed enum and returns a static category such as `cli`, `vscode`, `internal:memory_consolidation`, `subagent:thread_spawn`, or `unknown`.

**Call relations**: This helper is used by `parity_check_from_scan_and_rows` when building the `rollout DB sources` summary, and it is directly exercised by a unit test to lock down structured-source coarsening.


##### `count_summary`  (lines 621–657)

```
fn count_summary(values: I) -> String
```

**Purpose**: Builds a compact frequency summary string for categorical values, capped to `SUMMARY_LIMIT` distinct categories. Excess categories are folded into an `other=` bucket with omitted row and category counts.

**Data flow**: Consumes an iterator of values convertible into `String`, counts occurrences in a `BTreeMap`, returns `none` if empty, otherwise sorts entries by descending count then ascending value, computes omitted category and row totals beyond the limit, formats up to `SUMMARY_LIMIT` `value=count` parts, optionally appends an `other=... across ... categories` part, and joins them with commas.

**Call relations**: Used by `parity_check_from_scan_and_rows` to summarize model providers and source categories. A dedicated test verifies the capping behavior.

*Call graph*: called by 1 (count_summary_caps_distinct_values); 2 external calls (new, format!).


##### `push_path_samples`  (lines 659–665)

```
fn push_path_samples(
    details: &mut Vec<String>,
    label: &str,
    paths: impl Iterator<Item = &'a Path>,
)
```

**Purpose**: Adds bounded sample detail lines for a sequence of paths. It converts each path to display text and delegates the actual insertion limit to `push_samples`.

**Data flow**: Takes a mutable details vector, a label, and an iterator of `&Path`, maps each path to `path.display().to_string()`, and forwards the iterator to `push_samples`.

**Call relations**: Called from `parity_check_from_scan_and_rows` for missing, stale, mismatch, and duplicate-path samples so path formatting stays uniform.

*Call graph*: calls 1 internal fn (push_samples); called by 1 (parity_check_from_scan_and_rows); 1 external calls (map).


##### `push_samples`  (lines 667–675)

```
fn push_samples(details: &mut Vec<String>, label: &str, values: I)
```

**Purpose**: Appends up to `SAMPLE_LIMIT` labeled sample lines to the details vector. It is the generic bounded sampler used for both strings and path displays.

**Data flow**: Consumes a mutable details vector, a label, and an iterator of values implementing `ToString`; takes at most `SAMPLE_LIMIT` items, formats each as `<label>: <value>`, and pushes them into `details`.

**Call relations**: Used directly by `thread_inventory_check_for_roots` and `parity_check_from_scan_and_rows`, and indirectly by `push_path_samples`, to keep doctor output concise while still showing concrete examples.

*Call graph*: called by 3 (parity_check_from_scan_and_rows, push_path_samples, thread_inventory_check_for_roots); 2 external calls (take, format!).


##### `tests::thread_inventory_check_ok_when_rollouts_match_db`  (lines 689–729)

```
async fn thread_inventory_check_ok_when_rollouts_match_db()
```

**Purpose**: Verifies the happy path where active and archived rollout files exactly match DB rows. It asserts an overall `Ok` status and zero discrepancy counts.

**Data flow**: Creates a temporary `Fixture`, writes one active and one archived rollout file, inserts matching DB rows, awaits `thread_inventory_check_for_roots`, and asserts the returned check's status, category, and selected detail values via `assert_detail`.

**Call relations**: This test exercises the full scan-plus-DB path through `thread_inventory_check_for_roots` and confirms that parity produces no warnings.

*Call graph*: calls 1 internal fn (thread_inventory_check_for_roots); 3 external calls (assert_eq!, new, assert_detail).


##### `tests::thread_inventory_check_warns_for_missing_stale_and_mismatched_rows`  (lines 732–788)

```
async fn thread_inventory_check_warns_for_missing_stale_and_mismatched_rows()
```

**Purpose**: Verifies that the parity check reports multiple discrepancy classes simultaneously: missing rollout rows, stale DB rows, and archive-flag mismatches. It also checks that no generic restart remediation is attached.

**Data flow**: Builds a `Fixture`, writes rollout files, constructs a stale path without creating the file, inserts DB rows that intentionally mismatch archive state and reference the stale path, runs `thread_inventory_check_for_roots`, and asserts warning status, issue count, selected detail counts, absence of top-level remediation, absence of restart remedies on issues, and presence of the missing rollout path in details.

**Call relations**: This test drives the warning-producing branches in `parity_check_from_scan_and_rows` and validates the shape of emitted issues and samples.

*Call graph*: calls 1 internal fn (thread_inventory_check_for_roots); 4 external calls (assert!, assert_eq!, new, assert_detail).


##### `tests::Fixture::new`  (lines 796–809)

```
async fn new() -> Self
```

**Purpose**: Creates isolated temporary Codex and SQLite homes for thread-inventory tests and initializes the state runtime. This ensures the SQLite schema exists before rows are inserted.

**Data flow**: Allocates two `TempDir`s, calls `codex_state::StateRuntime::init` with the SQLite home and a test provider string, awaits successful initialization, and returns a `Fixture` containing both temp directories.

**Call relations**: Used by the async parity tests as the common setup step before writing rollout files or inserting DB rows.

*Call graph*: calls 1 internal fn (init); 1 external calls (new).


##### `tests::Fixture::write_rollout`  (lines 811–838)

```
fn write_rollout(&self, archived: bool, timestamp: &str, thread_id: &str) -> PathBuf
```

**Purpose**: Writes a minimal rollout JSONL file containing a `SessionMeta` line with the requested thread ID and timestamp. It can place the file in either active or archived layout.

**Data flow**: Chooses a root directory based on the `archived` flag, creates directories, constructs a rollout filename from timestamp and thread ID, builds a `RolloutLine` containing `RolloutItem::SessionMeta` with a parsed `ThreadId` and test metadata, serializes it to JSON, writes the line plus newline to disk, and returns the resulting `PathBuf`.

**Call relations**: Called by the parity tests to create realistic rollout files that `thread_id_from_rollout` can parse during scanning.

*Call graph*: calls 1 internal fn (from_string); 7 external calls (default, path, format!, SessionMeta, to_string, create_dir_all, write).


##### `tests::Fixture::insert_thread_row`  (lines 840–884)

```
async fn insert_thread_row(&self, id: &str, rollout_path: &Path, archived: bool)
```

**Purpose**: Inserts a synthetic row into the SQLite `threads` table for parity testing. It writes the rollout path, archive flag, and other required columns directly with SQLx.

**Data flow**: Computes the state DB path, opens a single-connection SQLite pool with `SqliteConnectOptions`, prepares an `INSERT INTO threads` statement, binds the provided ID, rollout path string, timestamps, source, provider, cwd, title, sandbox policy, approval mode, archive flag, and optional archived timestamp, executes the query, and closes the pool.

**Call relations**: Used by the parity tests to create DB-side inventory entries that either match or intentionally diverge from rollout files.

*Call graph*: 6 external calls (display, new, new, path, state_db_path, query).


##### `tests::assert_detail`  (lines 887–895)

```
fn assert_detail(check: &DoctorCheck, label: &str, expected: &str)
```

**Purpose**: Extracts a named detail value from a `DoctorCheck` and asserts it equals an expected string. It simplifies repetitive detail assertions in tests.

**Data flow**: Builds a `<label>: ` prefix, searches `check.details` for the first entry with that prefix, strips the prefix, and compares the extracted suffix to `expected` with `assert_eq!`.

**Call relations**: Called by both parity tests to validate specific count-bearing detail lines without asserting the entire details vector.

*Call graph*: 2 external calls (assert_eq!, format!).


##### `tests::source_category_coarsens_structured_sources`  (lines 898–910)

```
fn source_category_coarsens_structured_sources()
```

**Purpose**: Checks that `source_category` handles both plain and structured serialized source values. It locks down the expected coarse labels for representative cases.

**Data flow**: Calls `source_category` with a plain `cli` string and two JSON-encoded subagent variants, then asserts the returned category strings.

**Call relations**: This unit test targets the parsing and enum-coarsening logic used in parity summaries.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::count_summary_caps_distinct_values`  (lines 913–920)

```
fn count_summary_caps_distinct_values()
```

**Purpose**: Verifies that `count_summary` limits output to `SUMMARY_LIMIT` categories and folds the remainder into an `other=` bucket. It uses nine one-count categories to trigger truncation.

**Data flow**: Passes an iterator over nine distinct one-character strings into `count_summary` and asserts the exact summary string returned.

**Call relations**: This test protects the compact-summary formatting used by `parity_check_from_scan_and_rows` for provider and source distributions.

*Call graph*: calls 1 internal fn (count_summary); 1 external calls (assert_eq!).


### `cli/src/doctor.rs`

`orchestration` · `request handling`

This is the central orchestration and data-model file for the doctor subsystem. It defines CLI flags in `DoctorCommand`, report row types (`DoctorReport`, `DoctorCheck`, `DoctorIssue`), JSON-specific redacted output types, and the top-level `run_doctor` flow. `run_doctor` delegates to `build_report`, then either pretty-prints a redacted JSON object or renders grouped terminal output, and exits with status 1 when any check failed.

`build_report` is the heart of execution. It creates a progress reporter, runs several synchronous checks immediately (`system`, `installation`, `runtime`, `search`), then attempts `load_config`. If config loads, it derives an `AuthManager` and provider reachability plan and launches a large `tokio::join!` fan-out of sync and async checks: config, auth, updates, network, websocket reachability, MCP, sandbox, terminal, git, terminal title, state, thread inventory, background server, and provider reachability. If config loading fails, it falls back to a reduced set using `fallback_state_check` and a default reachability plan. Every check is wrapped by `run_sync_check` or `run_async_check`, which timestamp execution, notify progress, and stamp `duration_ms`.

The file also contains substantial domain logic for installation provenance, auth validation, network env inspection, MCP config validation, terminal diagnostics, SQLite integrity checks, websocket probing, provider reachability planning/probing, and helper utilities for path/env formatting. A key invariant is that doctor is read-mostly: checks inspect local state and perform bounded probes, but do not repair or mutate user data. Another subtle design choice is redaction: human and JSON output share the same raw detail strings, but JSON is restructured and sanitized by `structured_json_details`, `json_detail_value`, and `redacted_json_issue` so support reports preserve labels while stripping secrets, credentials, and sensitive URL components.

#### Function details

##### `DoctorIssue::new`  (lines 229–238)

```
fn new(severity: CheckStatus, cause: impl Into<String>) -> Self
```

**Purpose**: Constructs a new structured issue with a severity and cause, leaving measured/expected/remedy/fields empty for later builder-style enrichment.

**Data flow**: Takes `severity: CheckStatus` and `cause: impl Into<String>`, converts the cause into a `String`, and returns a `DoctorIssue` with `measured`, `expected`, and `remedy` set to `None` and `fields` initialized as an empty vector.

**Call relations**: It is the common constructor used throughout doctor checks that need actionable issue metadata, including terminal, git, provider reachability, thread inventory, title, and state-related checks. Callers typically chain `measured`, `expected`, `remedy`, and `field` immediately after creation.

*Call graph*: called by 8 (git_check_from_inputs, provider_reachability_check, terminal_check_from_inputs, terminal_size_issues, missing_state_db_check, parity_check_from_scan_and_rows, thread_inventory_check_for_roots, terminal_title_check_from_inputs); 2 external calls (into, new).


##### `DoctorIssue::measured`  (lines 240–243)

```
fn measured(mut self, measured: impl Into<String>) -> Self
```

**Purpose**: Adds the observed value to an issue in builder style.

**Data flow**: Consumes `self` plus `measured: impl Into<String>`, stores the converted string in `self.measured`, and returns the updated `DoctorIssue`.

**Call relations**: Used by callers after `DoctorIssue::new` when they want the rendered issue row to show what doctor actually observed.

*Call graph*: 1 external calls (into).


##### `DoctorIssue::expected`  (lines 245–248)

```
fn expected(mut self, expected: impl Into<String>) -> Self
```

**Purpose**: Adds the expected value or condition to an issue in builder style.

**Data flow**: Consumes `self` plus `expected: impl Into<String>`, stores it in `self.expected`, and returns the updated issue.

**Call relations**: Called by checks that want human and JSON output to show a measured-vs-expected comparison.

*Call graph*: 1 external calls (into).


##### `DoctorIssue::remedy`  (lines 250–253)

```
fn remedy(mut self, remedy: impl Into<String>) -> Self
```

**Purpose**: Attaches a remediation string to an issue in builder style.

**Data flow**: Consumes `self` plus `remedy: impl Into<String>`, stores the converted string in `self.remedy`, and returns the updated issue.

**Call relations**: Used by checks whose warnings/failures should surface explicit next actions in detailed human output.

*Call graph*: 1 external calls (into).


##### `DoctorIssue::field`  (lines 255–258)

```
fn field(mut self, field: impl Into<String>) -> Self
```

**Purpose**: Associates an issue with one detail field label so renderers can attach expected values to the right row.

**Data flow**: Consumes `self` plus `field: impl Into<String>`, pushes the converted field name into `self.fields`, and returns the updated issue.

**Call relations**: This metadata is later consumed indirectly by the detail renderer to match issue expectations/remedies to specific displayed rows.

*Call graph*: 1 external calls (into).


##### `DoctorCheck::new`  (lines 262–278)

```
fn new(
        id: impl Into<String>,
        category: impl Into<String>,
        status: CheckStatus,
        summary: impl Into<String>,
    ) -> Self
```

**Purpose**: Creates a new diagnostic row with identifiers, category, status, and summary, initializing all optional collections empty.

**Data flow**: Accepts `id`, `category`, `status`, and `summary`, converts string-like inputs into owned `String`s, and returns a `DoctorCheck` with empty `details` and `issues`, `remediation: None`, and `duration_ms: 0`.

**Call relations**: This is the standard constructor for every doctor row, used across this file and submodules before details, issues, remediation, and duration are added.

*Call graph*: called by 25 (auth_check, background_server_check, config_check, fallback_state_check, git_check_from_inputs, installation_check, mcp_check_from_servers, network_check, render_human_report_includes_threads_row_in_environment, provider_reachability_check (+15 more)); 2 external calls (into, new).


##### `DoctorCheck::detail`  (lines 280–283)

```
fn detail(mut self, detail: impl Into<String>) -> Self
```

**Purpose**: Appends one detail string to a check in builder style.

**Data flow**: Consumes `self` plus `detail: impl Into<String>`, pushes the converted string into `self.details`, and returns the updated check.

**Call relations**: Used when a caller wants to add a single detail inline while constructing a `DoctorCheck`.

*Call graph*: 1 external calls (into).


##### `DoctorCheck::details`  (lines 285–288)

```
fn details(mut self, details: Vec<String>) -> Self
```

**Purpose**: Extends a check with multiple detail strings in builder style.

**Data flow**: Consumes `self` plus `details: Vec<String>`, extends `self.details` with that vector’s contents, and returns the updated check.

**Call relations**: Commonly used by check builders that accumulate a `Vec<String>` first and then attach it all at once.


##### `DoctorCheck::remediation`  (lines 290–293)

```
fn remediation(mut self, remediation: impl Into<String>) -> Self
```

**Purpose**: Sets the top-level remediation text for a check in builder style.

**Data flow**: Consumes `self` plus `remediation: impl Into<String>`, stores the converted string in `self.remediation`, and returns the updated check.

**Call relations**: Used by checks that want a row-level remediation even when they do not emit structured issues.

*Call graph*: 1 external calls (into).


##### `DoctorCheck::issue`  (lines 295–298)

```
fn issue(mut self, issue: DoctorIssue) -> Self
```

**Purpose**: Appends one structured issue to a check in builder style.

**Data flow**: Consumes `self` plus a `DoctorIssue`, pushes it into `self.issues`, and returns the updated check.

**Call relations**: Called by checks that want richer warning/failure metadata than a summary string alone can provide.


##### `run_doctor`  (lines 306–331)

```
async fn run_doctor(
    command: DoctorCommand,
    root_config_overrides: CliConfigOverrides,
    interactive: &TuiCli,
    arg0_paths: &Arg0DispatchPaths,
) -> anyhow::Result<()>
```

**Purpose**: Runs the doctor command, prints either human or JSON output, and exits nonzero if the report contains failures.

**Data flow**: Receives parsed `DoctorCommand`, root CLI config overrides, interactive CLI settings, and arg0 dispatch paths. It awaits `build_report`, then either serializes `redacted_json_report(&report)` with `serde_json::to_string_pretty` to stdout or renders `render_human_report(&report, human_output_options(&command))`. If `report.overall_status` is `Fail`, it terminates the process with exit code 1; otherwise it returns `Ok(())`.

**Call relations**: This is the CLI-facing entry point called by `cli_main`. It delegates report construction to `build_report` and presentation to the output module, acting as the final bridge from diagnostics to process behavior.

*Call graph*: calls 1 internal fn (build_report); called by 1 (cli_main); 3 external calls (print!, println!, exit).


##### `build_report`  (lines 333–492)

```
async fn build_report(
    command: &DoctorCommand,
    root_config_overrides: CliConfigOverrides,
    interactive: &TuiCli,
    arg0_paths: &Arg0DispatchPaths,
) -> DoctorReport
```

**Purpose**: Executes the full bounded diagnostic suite, coordinating sync and async checks, config loading, fallback behavior, progress reporting, and final report assembly.

**Data flow**: Takes the parsed command plus CLI/config context. It creates a progress implementation with `doctor_progress`, accumulates `DoctorCheck` rows in a vector, runs early sync checks, then begins the config phase and awaits `load_config`. On success it derives an `AuthManager`, computes a provider reachability plan, and concurrently runs many checks via `tokio::join!`, collecting their `DoctorCheck`s. On config failure it builds a reduced fallback set using the error text, current/fallback cwd, `fallback_state_check`, and `default_reachability_plan`. After `progress.settle()`, it computes `overall_status`, stamps `schema_version`, `generated_at`, and `codex_version`, and returns a `DoctorReport`.

**Call relations**: It is called only by `run_doctor`. It is the central orchestrator that invokes `run_sync_check`, `run_async_check`, `load_config`, `provider_reachability_plan`, `default_reachability_plan`, and many imported submodule checks depending on whether config loading succeeds.

*Call graph*: calls 8 internal fn (default_reachability_plan, generated_at, load_config, overall_status, doctor_progress, provider_reachability_plan, run_sync_check, shared_from_config); called by 1 (run_doctor); 3 external calls (new, env!, join!).


##### `load_config`  (lines 494–520)

```
async fn load_config(
    root_config_overrides: CliConfigOverrides,
    interactive: &TuiCli,
    arg0_paths: &Arg0DispatchPaths,
) -> anyhow::Result<Config>
```

**Purpose**: Builds the effective `Config` used by doctor by combining root CLI overrides, interactive-mode flags, and doctor-specific harness overrides.

**Data flow**: Consumes root `CliConfigOverrides`, `TuiCli`, and `Arg0DispatchPaths`. It parses CLI key/value overrides, injects `web_search = "live"` when interactive web search is enabled, builds a `ConfigOverrides` with `ephemeral: Some(true)` plus values from `config_overrides_from_interactive`, and feeds both override sets into `ConfigBuilder::default().cli_overrides(...).harness_overrides(...).build().await`. Errors are wrapped with `failed to load Codex config` context.

**Call relations**: It is called by `build_report` before most config-dependent checks can run. It delegates interactive-specific override extraction to `config_overrides_from_interactive`.

*Call graph*: calls 2 internal fn (config_overrides_from_interactive, parse_overrides); called by 1 (build_report); 2 external calls (default, String).


##### `config_overrides_from_interactive`  (lines 522–552)

```
fn config_overrides_from_interactive(
    interactive: &TuiCli,
    arg0_paths: &Arg0DispatchPaths,
) -> ConfigOverrides
```

**Purpose**: Translates interactive CLI flags into `ConfigOverrides`, including dangerous bypass behavior, cwd/model/provider selection, helper executable paths, and writable roots.

**Data flow**: Reads fields from `interactive: &TuiCli` and `arg0_paths: &Arg0DispatchPaths`. It derives `approval_policy` and `sandbox_mode`, overriding both to unrestricted values when `dangerously_bypass_approvals_and_sandbox` is set; copies model, cwd, optional OSS provider, helper executable paths, raw reasoning flag, and additional writable roots; and returns a populated `ConfigOverrides` with remaining fields from `Default::default()`.

**Call relations**: It is used by `load_config` to build harness overrides and is also covered directly by a unit test to ensure interactive flags survive translation.

*Call graph*: called by 2 (load_config, config_overrides_from_interactive_preserves_global_options); 1 external calls (default).


##### `JsonDetailValue::push`  (lines 608–615)

```
fn push(&mut self, value: String)
```

**Purpose**: Accumulates repeated JSON detail values under one key while preserving the scalar case for single values.

**Data flow**: Mutably borrows `self`. If it is `One(previous)`, it replaces itself with `Many(vec![previous, value])`; if already `Many(values)`, it pushes the new `value` onto that vector.

**Call relations**: It is used by `structured_json_details` when multiple redacted detail lines share the same label.

*Call graph*: 2 external calls (Many, vec!).


##### `redacted_json_report`  (lines 618–634)

```
fn redacted_json_report(report: &DoctorReport) -> JsonDoctorReport
```

**Purpose**: Transforms the internal array-based `DoctorReport` into the stable JSON support-report shape keyed by check id.

**Data flow**: Iterates over `report.checks`, converts each `DoctorCheck` with `redacted_json_check`, collects them into a `BTreeMap<String, JsonDoctorCheck>` keyed by `check.id`, and returns a `JsonDoctorReport` carrying through schema version, timestamp, overall status, and codex version.

**Call relations**: It is used by `run_doctor` for `--json` output and by tests that verify redaction and structure.

*Call graph*: called by 1 (redacted_json_report_structures_and_sanitizes_details).


##### `redacted_json_check`  (lines 636–649)

```
fn redacted_json_check(check: &DoctorCheck) -> JsonDoctorCheck
```

**Purpose**: Converts one `DoctorCheck` into its redacted JSON representation, restructuring details into keyed fields plus freeform notes.

**Data flow**: Accepts `check: &DoctorCheck`, calls `structured_json_details(&check.details)` to split redacted details into a `BTreeMap` and notes vector, maps each issue through `redacted_json_issue`, redacts top-level remediation if present, and returns a `JsonDoctorCheck` with copied id/category/status/summary and original `duration_ms`.

**Call relations**: It is called by `redacted_json_report` for every check. Its main delegation is to `structured_json_details` and `redacted_json_issue`.

*Call graph*: calls 1 internal fn (structured_json_details).


##### `redacted_json_issue`  (lines 651–664)

```
fn redacted_json_issue(issue: &DoctorIssue) -> JsonDoctorIssue
```

**Purpose**: Produces a JSON-safe issue object by redacting all free-text fields and preserving severity and field names.

**Data flow**: Reads a `DoctorIssue`, copies `severity`, redacts `cause`, `measured`, `expected`, `remedy`, and each entry in `fields` with `redact_detail`, and returns a `JsonDoctorIssue`.

**Call relations**: It is used by `redacted_json_check` while serializing issue lists for support reports.

*Call graph*: calls 1 internal fn (redact_detail).


##### `structured_json_details`  (lines 671–694)

```
fn structured_json_details(details: &[String]) -> (BTreeMap<String, JsonDetailValue>, Vec<String>)
```

**Purpose**: Parses redacted detail strings into structured JSON fields when they follow the `label: value` convention, preserving nonconforming lines as notes.

**Data flow**: Iterates over `details: &[String]`, redacts each line with `redact_detail`, splits on the first `": "`, rejects empty labels, normalizes the value through `json_detail_value`, and inserts or appends it into a `BTreeMap<String, JsonDetailValue>`. Lines without a usable label/value pair are pushed into a `Vec<String>` of notes. It returns `(structured, notes)`.

**Call relations**: It is called by `redacted_json_check`. It delegates value sanitization to `json_detail_value` and repeated-key accumulation to `JsonDetailValue::push`.

*Call graph*: calls 2 internal fn (json_detail_value, redact_detail); called by 1 (redacted_json_check); 3 external calls (new, new, One).


##### `json_detail_value`  (lines 696–709)

```
fn json_detail_value(key: &str, value: &str) -> String
```

**Purpose**: Further sanitizes certain detail values for JSON by collapsing editor/pager command strings to a generic `set` marker.

**Data flow**: Receives a detail `key` and `value`. For keys like `VISUAL`, `EDITOR`, `PAGER`, `GIT_PAGER`, `GH_PAGER`, and `LESS`, if the value is not effectively `not set`, it returns `"set"`; otherwise it returns the original value as a `String`.

**Call relations**: It is used only by `structured_json_details` to avoid leaking arbitrary command lines or inline env assignments into support JSON.

*Call graph*: called by 1 (structured_json_details); 1 external calls (matches!).


##### `run_sync_check`  (lines 711–722)

```
fn run_sync_check(
    label: &'static str,
    progress: Arc<dyn DoctorProgress>,
    f: impl FnOnce() -> DoctorCheck,
) -> DoctorCheck
```

**Purpose**: Wraps a synchronous check function with progress notifications and duration measurement.

**Data flow**: Takes a display `label`, a shared `DoctorProgress`, and a closure `f` returning `DoctorCheck`. It calls `progress.begin(label)`, records `Instant::now()`, executes `f`, stores elapsed milliseconds into `check.duration_ms` with saturation fallback to `u64::MAX`, calls `progress.finish(label, check.status)`, and returns the check.

**Call relations**: It is used extensively by `build_report` for synchronous checks and directly by a unit test that verifies progress event ordering.

*Call graph*: called by 2 (build_report, run_sync_check_notifies_progress); 1 external calls (now).


##### `run_async_check`  (lines 724–751)

```
async fn run_async_check(
    label: &'static str,
    progress: Arc<dyn DoctorProgress>,
    future: Fut,
) -> DoctorCheck
```

**Purpose**: Wraps an async check future with progress notifications, duration measurement, and heartbeat updates for slow operations.

**Data flow**: Accepts a display `label`, shared `DoctorProgress`, and a future yielding `DoctorCheck`. It begins progress, records start time, pins the future, creates a Tokio interval, and loops with `tokio::select!`: when the future resolves it stamps `duration_ms`, finishes progress, and returns the check; on interval ticks it emits `progress.heartbeat` once elapsed time exceeds `SLOW_CHECK_PROGRESS_THRESHOLD`.

**Call relations**: It is used by `build_report` for async checks such as websocket, MCP, git, state, background server, and provider reachability. A dedicated test verifies begin/finish notifications.

*Call graph*: called by 1 (run_async_check_notifies_progress); 4 external calls (now, pin!, select!, interval).


##### `overall_status`  (lines 753–764)

```
fn overall_status(checks: &[DoctorCheck]) -> CheckStatus
```

**Purpose**: Computes the report-wide status by prioritizing failures over warnings over ok.

**Data flow**: Scans `checks: &[DoctorCheck]`; returns `Fail` if any check failed, else `Warning` if any check warned, else `Ok`.

**Call relations**: It is called by `build_report` after all checks complete and is also unit-tested directly.

*Call graph*: called by 1 (build_report); 1 external calls (iter).


##### `generated_at`  (lines 766–774)

```
fn generated_at() -> String
```

**Purpose**: Produces a simple timestamp string for the report header.

**Data flow**: Reads `SystemTime::now()`, computes duration since `UNIX_EPOCH`, and returns either `"{seconds}s since unix epoch"` or `"unknown"` if the clock is before the epoch.

**Call relations**: It is used only by `build_report` when constructing the final `DoctorReport`.

*Call graph*: called by 1 (build_report); 2 external calls (format!, now).


##### `installation_check`  (lines 776–866)

```
fn installation_check(show_details: bool) -> DoctorCheck
```

**Purpose**: Inspects how the current Codex binary was installed and whether package-manager provenance and PATH layout are internally consistent.

**Data flow**: Reads `env::current_exe`, records executable and install-context details, checks inherited package-manager env leakage for cargo builds, records npm/bun management flags and package root env, enumerates PATH entries containing `codex`, and optionally expands them. If npm-managed, it runs `npm_global_root_check` and converts match/mismatch/missing/unavailable outcomes into status, summary, remediation, and extra details. It returns a `DoctorCheck` summarizing installation consistency.

**Call relations**: It is run synchronously by `build_report` as one of the early checks. It delegates to `doctor_install_context`, `doctor_managed_by_npm`, `inherited_managed_env_for_cargo_binary`, `codex_path_entries`, `npm_global_root_check`, and path/env detail helpers.

*Call graph*: calls 8 internal fn (new, codex_path_entries, doctor_install_context, doctor_managed_by_npm, inherited_managed_env_for_cargo_binary, npm_global_root_check, push_env_path_detail, push_path_detail); 3 external calls (new, current_exe, format!).


##### `doctor_install_context`  (lines 868–877)

```
fn doctor_install_context(current_exe: Option<&Path>) -> InstallContext
```

**Purpose**: Returns the effective install context for doctor, suppressing misleading package-manager context when a cargo-built binary inherited managed env vars.

**Data flow**: Accepts `current_exe: Option<&Path>`. If `inherited_managed_env_for_cargo_binary` is true, it returns an `InstallContext` with `InstallMethod::Other` and no package layout; otherwise it clones `InstallContext::current()`.

**Call relations**: It is used by `installation_check` to avoid reporting npm/bun provenance for local debug/release binaries launched from a managed shell.

*Call graph*: calls 2 internal fn (inherited_managed_env_for_cargo_binary, current); called by 1 (installation_check).


##### `doctor_managed_by_npm`  (lines 879–882)

```
fn doctor_managed_by_npm(current_exe: Option<&Path>) -> bool
```

**Purpose**: Determines whether doctor should treat the current launch as npm-managed.

**Data flow**: Checks whether `CODEX_MANAGED_BY_NPM` is set and nonempty, then suppresses that result if `inherited_managed_env_for_cargo_binary(current_exe)` is true.

**Call relations**: It is called by `installation_check` both for summary details and to decide whether npm root consistency checks should run.

*Call graph*: calls 1 internal fn (inherited_managed_env_for_cargo_binary); called by 1 (installation_check); 1 external calls (var_os).


##### `inherited_managed_env_for_cargo_binary`  (lines 884–901)

```
fn inherited_managed_env_for_cargo_binary(current_exe: Option<&Path>) -> bool
```

**Purpose**: Detects the special case where package-manager environment variables leaked into a locally built cargo binary invocation.

**Data flow**: Reads `CODEX_MANAGED_BY_NPM` and `CODEX_MANAGED_BY_BUN`; if neither is set, returns false. Otherwise it inspects `current_exe` path components and returns true when it finds a `target/debug` or `target/release` segment pair, indicating a cargo build output path.

**Call relations**: It is used by `installation_check`, `doctor_install_context`, and `doctor_managed_by_npm` to avoid misclassifying local builds as managed installs.

*Call graph*: called by 3 (doctor_install_context, doctor_managed_by_npm, installation_check); 1 external calls (var_os).


##### `describe_install_context`  (lines 903–946)

```
fn describe_install_context(context: &InstallContext) -> String
```

**Purpose**: Formats an `InstallContext` into a detailed human-readable string including package layout paths when available.

**Data flow**: Matches on `context.method`, formats standalone installs differently for Unix vs Windows and for package-layout-present vs absent cases, and delegates npm/bun/brew/other formatting to `describe_method_with_package_layout`. Optional resource/path directories are rendered through `display_optional_path`.

**Call relations**: It is used by `installation_check` to emit the `install context:` detail line.

*Call graph*: calls 2 internal fn (describe_method_with_package_layout, display_optional_path); 1 external calls (format!).


##### `describe_method_with_package_layout`  (lines 948–964)

```
fn describe_method_with_package_layout(
    method: &str,
    package_layout: Option<&CodexPackageLayout>,
) -> String
```

**Purpose**: Formats a non-standalone install method together with optional package layout directories.

**Data flow**: Accepts a method label and optional `CodexPackageLayout`; if present it formats package, bin, resources, and path directories, otherwise it returns the bare method name.

**Call relations**: It is a helper used only by `describe_install_context`.

*Call graph*: calls 1 internal fn (display_optional_path); called by 1 (describe_install_context); 1 external calls (format!).


##### `display_optional_path`  (lines 966–969)

```
fn display_optional_path(path: Option<&Path>) -> String
```

**Purpose**: Renders an optional path as either its display string or `none`.

**Data flow**: Maps `Option<&Path>` to `path.display().to_string()` when present, otherwise returns `"none"`.

**Call relations**: It is used by install-context formatting helpers.

*Call graph*: called by 2 (describe_install_context, describe_method_with_package_layout).


##### `npm_global_root_check`  (lines 984–999)

```
fn npm_global_root_check() -> NpmRootCheck
```

**Purpose**: Compares the running npm-managed package root against the package root that `npm root -g` would update.

**Data flow**: Reads `CODEX_MANAGED_PACKAGE_ROOT`; if absent returns `MissingPackageRoot`. Otherwise it runs `run_command(NPM_COMMAND, ["root", "-g"])`, extracts the first nonempty output line as the npm global root, and passes the running root and npm root to `compare_npm_package_roots`. Command failures or empty output become `NpmUnavailable`.

**Call relations**: It is called by `installation_check` only when the launch is considered npm-managed.

*Call graph*: calls 2 internal fn (compare_npm_package_roots, run_command); called by 1 (installation_check); 3 external calls (from, NpmUnavailable, var_os).


##### `compare_npm_package_roots`  (lines 1001–1015)

```
fn compare_npm_package_roots(running_package_root: &Path, npm_root: &Path) -> NpmRootCheck
```

**Purpose**: Determines whether the running package root matches the canonical npm global package location for `@openai/codex`.

**Data flow**: Builds `npm_package_root = npm_root/@openai/codex`, normalizes both the running and target paths with `normalize_path_for_compare`, and returns either `NpmRootCheck::Match { package_root }` or `Mismatch { running_package_root, npm_package_root }`.

**Call relations**: It is used by `npm_global_root_check` and directly unit-tested for match and mismatch cases.

*Call graph*: calls 1 internal fn (normalize_path_for_compare); called by 1 (npm_global_root_check); 2 external calls (join, to_path_buf).


##### `normalize_path_for_compare`  (lines 1017–1025)

```
fn normalize_path_for_compare(path: &Path) -> String
```

**Purpose**: Normalizes a filesystem path for equality comparison across symlinks, separators, and Windows case differences.

**Data flow**: Attempts `canonicalize`, falls back to the original path on error, converts to a lossy string, replaces backslashes with slashes, and lowercases the result on Windows.

**Call relations**: It is a helper used by `compare_npm_package_roots`.

*Call graph*: called by 1 (compare_npm_package_roots); 2 external calls (canonicalize, cfg!).


##### `display_list`  (lines 1027–1037)

```
fn display_list(items: &[T]) -> String
```

**Purpose**: Formats a slice of string-like items as a comma-separated list or `none` when empty.

**Data flow**: Reads `items: &[T]` where `T: AsRef<str>`, returns `"none"` for an empty slice, otherwise joins all item strings with `", "`.

**Call relations**: It is used by feature-flag reporting to summarize enabled flags and overrides.

*Call graph*: 2 external calls (is_empty, iter).


##### `codex_path_entries`  (lines 1039–1052)

```
fn codex_path_entries() -> Vec<String>
```

**Purpose**: Finds all `codex` executables visible on PATH.

**Data flow**: Runs `where codex` on Windows or `which -a codex` elsewhere via `run_command`, then splits stdout into trimmed nonempty lines and returns them as `Vec<String>`. Command failure yields an empty vector.

**Call relations**: It is used by `installation_check` to detect duplicate PATH entries and optionally list them.

*Call graph*: calls 1 internal fn (run_command); called by 1 (installation_check).


##### `run_command`  (lines 1054–1071)

```
fn run_command(program: &str, args: I) -> Result<String, String>
```

**Purpose**: Runs a short external command and returns stdout text or a human-readable error string.

**Data flow**: Spawns `std::process::Command::new(program).args(args).output()`. Spawn errors become `Err(err.to_string())`. Non-success exit statuses return stderr text if present, otherwise `exited with status ...`. Success returns stdout decoded with `String::from_utf8_lossy`.

**Call relations**: It is the shared subprocess helper for `codex_path_entries` and `npm_global_root_check`.

*Call graph*: called by 2 (codex_path_entries, npm_global_root_check); 3 external calls (from_utf8_lossy, new, format!).


##### `config_check`  (lines 1073–1102)

```
fn config_check(config: &Config) -> DoctorCheck
```

**Purpose**: Summarizes the loaded configuration, startup warnings, feature flags, and config.toml readability/parsing.

**Data flow**: Reads fields from `Config` such as `codex_home`, `cwd`, model, provider id, log/sqlite dirs, and MCP server count; appends feature-flag details and config.toml details; if `startup_warnings` is nonempty it adds grouped counts and each warning line and marks the check `Warning`, otherwise `Ok`. Returns a `DoctorCheck` with id `config.load`.

**Call relations**: It is run by `build_report` only after config loads successfully. It delegates to `feature_flag_details`, `config_toml_details`, and `push_startup_warning_counts`.

*Call graph*: calls 4 internal fn (new, config_toml_details, feature_flag_details, push_startup_warning_counts); 2 external calls (new, format!).


##### `push_startup_warning_counts`  (lines 1104–1119)

```
fn push_startup_warning_counts(details: &mut Vec<String>, warnings: &[String])
```

**Purpose**: Adds grouped counts of startup warnings by rough source category.

**Data flow**: Takes a mutable details vector and a warning list, pushes the total count, then counts warnings whose lowercase text contains `skill`, `hook`, `plugin`, `mcp`, or `deprecated`, pushing one detail line per category.

**Call relations**: It is used by `config_check` and directly unit-tested to ensure grouping behavior.

*Call graph*: called by 2 (config_check, startup_warning_counts_group_known_sources); 1 external calls (format!).


##### `feature_flag_details`  (lines 1121–1149)

```
fn feature_flag_details(config: &Config, details: &mut Vec<String>)
```

**Purpose**: Reports enabled feature flags, explicit overrides, and legacy alias usage from the loaded config.

**Data flow**: Reads the feature set from `config.features.get()`, computes enabled feature keys and override strings by comparing against `FEATURES` defaults, pushes counts and comma-separated lists, then appends one detail per legacy feature alias usage.

**Call relations**: It is called by `config_check` to populate feature-related detail lines.

*Call graph*: called by 1 (config_check); 1 external calls (format!).


##### `config_toml_details`  (lines 1151–1164)

```
fn config_toml_details(config: &Config, details: &mut Vec<String>)
```

**Purpose**: Reports the location and parse/read status of `config.toml` under `CODEX_HOME`.

**Data flow**: Builds the config path from `config.codex_home`, pushes its path, then attempts `std::fs::read_to_string`. If found, it tries `toml::from_str::<toml::Value>` and records either `parse: ok` or the parse error. Missing files are reported explicitly; other read errors are included verbatim.

**Call relations**: It is used by `config_check` to expose config-file health without mutating anything.

*Call graph*: called by 1 (config_check); 2 external calls (format!, read_to_string).


##### `auth_check`  (lines 1166–1267)

```
fn auth_check(config: &Config) -> DoctorCheck
```

**Purpose**: Determines how Codex authentication is configured, validates stored credentials, and distinguishes environment-provided auth from broken or missing stored auth.

**Data flow**: Builds details including auth storage mode and auth file path, collects present auth env vars among `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN`, and first gives `provider_specific_auth_check` a chance to short-circuit for non-OpenAI providers. Otherwise it loads `auth.json` via `load_auth_dot_json`; when auth exists it records stored mode and presence booleans, computes `stored_auth_issues`, and derives status/summary/remediation based on issue presence and env-var overrides. If no stored auth exists, it returns `Ok` when env auth vars are present or `Fail` with remediation when none are found. Read errors become a failing check with the error text.

**Call relations**: It is run by `build_report` after config loads. It delegates to `provider_specific_auth_check`, `load_auth_dot_json`, `stored_auth_mode`, and `stored_auth_issues`.

*Call graph*: calls 3 internal fn (new, provider_specific_auth_check, stored_auth_issues); 4 external calls (new, auth_keyring_backend_kind, load_auth_dot_json, format!).


##### `provider_specific_auth_check`  (lines 1269–1322)

```
fn provider_specific_auth_check(
    requires_openai_auth: bool,
    provider_env_key: Option<&str>,
    provider_env_key_instructions: Option<&str>,
    mut details: Vec<String>,
    env_var_present:
```

**Purpose**: Handles auth validation for providers that do not require OpenAI auth, including provider-specific env-key requirements.

**Data flow**: Accepts booleans and optional provider env-key metadata plus an initial details vector and an env-var predicate. It records whether OpenAI auth is required. If OpenAI auth is required it returns `None` so generic auth logic continues. Otherwise it returns an `Ok` check when no provider env key is needed or when the required env key is present, and a `Fail` check with remediation when the provider env key is missing.

**Call relations**: It is called early by `auth_check` to short-circuit auth evaluation for non-OpenAI providers and is directly unit-tested for permissive and failing cases.

*Call graph*: calls 2 internal fn (new, env_var_present); called by 3 (auth_check, provider_specific_auth_allows_non_openai_provider_without_env_key, provider_specific_auth_fails_when_provider_env_key_is_missing); 1 external calls (format!).


##### `stored_auth_mode`  (lines 1324–1333)

```
fn stored_auth_mode(auth: &codex_login::AuthDotJson) -> &'static str
```

**Purpose**: Formats the effective stored auth mode as a stable snake-case string.

**Data flow**: Calls `stored_auth_mode_value(auth)` and maps the resulting enum variant to a string such as `api_key`, `chatgpt`, `agent_identity`, or `personal_access_token`.

**Call relations**: It is used by `auth_check` when reporting stored auth details.

*Call graph*: calls 1 internal fn (stored_auth_mode_value).


##### `stored_auth_mode_value`  (lines 1335–1348)

```
fn stored_auth_mode_value(auth: &AuthDotJson) -> codex_app_server_protocol::AuthMode
```

**Purpose**: Infers the effective auth mode from `AuthDotJson`, honoring explicit `auth_mode` when present and otherwise deriving it from populated fields.

**Data flow**: If `auth.auth_mode` is set, returns it directly. Otherwise it checks for `personal_access_token`, `bedrock_api_key`, `openai_api_key`, and falls back to `Chatgpt`.

**Call relations**: It is used by both `stored_auth_mode` and `stored_auth_issues`, and indirectly influences provider reachability planning.

*Call graph*: called by 2 (stored_auth_issues, stored_auth_mode).


##### `stored_auth_issues`  (lines 1350–1424)

```
fn stored_auth_issues(
    auth: &AuthDotJson,
    env_var_present: impl Fn(&str) -> bool,
) -> Vec<&'static str>
```

**Purpose**: Validates stored auth contents for the inferred auth mode and returns a list of concrete missing-field problems.

**Data flow**: Matches on `stored_auth_mode_value(auth)` and inspects the relevant fields: API key presence, ChatGPT access/refresh tokens and refresh metadata, external ChatGPT account id, agent identity token, personal access token, or Bedrock API key. It also treats supported auth env vars as satisfying API-key mode. It returns a `Vec<&'static str>` of issue descriptions.

**Call relations**: It is called by `auth_check` to decide status and summary, and is directly unit-tested for several auth modes.

*Call graph*: calls 2 internal fn (env_var_present, stored_auth_mode_value); called by 1 (auth_check); 1 external calls (new).


##### `network_check`  (lines 1426–1460)

```
fn network_check() -> DoctorCheck
```

**Purpose**: Inspects proxy-related environment variables and validates custom CA certificate path environment variables for readability and file-ness.

**Data flow**: Starts with proxy env details from `push_proxy_env_details`, then for `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE` reads the env var if present, checks metadata, distinguishes readable file vs not-a-file vs unreadable path, and probes readability with `read_probe_file`. It returns a `DoctorCheck` whose status remains `Ok` unless one of those CA-related validations produces a warning.

**Call relations**: It is run by `build_report` in both normal and fallback flows. It delegates to `push_proxy_env_details` and `read_probe_file`.

*Call graph*: calls 3 internal fn (new, push_proxy_env_details, read_probe_file); 5 external calls (from, new, var_os, format!, metadata).


##### `push_proxy_env_details`  (lines 1462–1476)

```
fn push_proxy_env_details(details: &mut Vec<String>)
```

**Purpose**: Adds a summary of which proxy-related environment variables are present.

**Data flow**: Scans the `PROXY_ENV_VARS` constant with `env_var_present`; if none are set it pushes `proxy env vars: none`, otherwise it pushes a comma-separated `proxy env vars present: ...` line.

**Call relations**: It is used by both `network_check` and `websocket_reachability_check` so those checks report the same proxy context.

*Call graph*: called by 2 (network_check, websocket_reachability_check); 1 external calls (format!).


##### `read_probe_file`  (lines 1478–1483)

```
fn read_probe_file(path: &Path) -> std::io::Result<()>
```

**Purpose**: Performs a minimal readability probe on a file without consuming meaningful contents.

**Data flow**: Opens the file at `path`, reads one byte into a fixed buffer, ignores the byte value, and returns `Ok(())` or the underlying I/O error.

**Call relations**: It is used by `network_check` and `terminal_path_readiness` to distinguish existing-but-unreadable files from healthy ones, and is unit-tested on Unix permission failures.

*Call graph*: called by 3 (network_check, terminal_path_readiness, read_probe_file_rejects_unreadable_file); 1 external calls (open).


##### `mcp_check`  (lines 1485–1487)

```
async fn mcp_check(config: &Config) -> DoctorCheck
```

**Purpose**: Runs the MCP configuration check against the servers configured in `Config`.

**Data flow**: Reads `config.mcp_servers.get()` and forwards that map to `mcp_check_from_servers`, awaiting the resulting `DoctorCheck`.

**Call relations**: It is the config-bound wrapper invoked by `build_report`; the substantive logic lives in `mcp_check_from_servers`.

*Call graph*: calls 1 internal fn (mcp_check_from_servers).


##### `mcp_check_from_servers`  (lines 1489–1629)

```
async fn mcp_check_from_servers(servers: &HashMap<String, McpServerConfig>) -> DoctorCheck
```

**Purpose**: Validates MCP server definitions for local consistency, required env vars, stdio command resolvability, and HTTP reachability, distinguishing required from optional failures.

**Data flow**: Accepts a `HashMap<String, McpServerConfig>`. If empty, returns an `Ok` check immediately. Otherwise it iterates all servers, counts transports, counts disabled servers, and for enabled servers validates stdio configs (`cwd` existence, nonempty command, command resolution, env key names, env var presence, and rejection of `remote` env-var sources) or streamable HTTP configs (bearer/header env vars and bounded HTTP probe via `mcp_http_probe_url`). It accumulates missing-input details plus required and optional reachability failures, derives status as `Fail` for required problems, `Warning` for optional-only problems, and returns a `DoctorCheck` with remediation when non-ok.

**Call relations**: It is called by `mcp_check` in production and by several tests covering disabled servers, optional HTTP warnings, missing stdio commands, and invalid remote env-var sources. It delegates to `stdio_command_resolves`, `env_var_present`, and `mcp_http_probe_url`.

*Call graph*: calls 4 internal fn (new, env_var_present, mcp_http_probe_url, stdio_command_resolves); called by 5 (mcp_check, mcp_check_fails_required_missing_stdio_command, mcp_check_fails_required_remote_stdio_env_var, mcp_check_ignores_disabled_servers, mcp_check_warns_for_optional_http_reachability); 3 external calls (new, new, format!).


##### `sandbox_check`  (lines 1631–1664)

```
fn sandbox_check(config: &Config, arg0_paths: &Arg0DispatchPaths) -> DoctorCheck
```

**Purpose**: Reports the effective approval and sandbox configuration and verifies that helper executable paths exist when configured.

**Data flow**: Reads approval policy, filesystem sandbox kind, network sandbox policy, and helper executable paths from `Config` and `Arg0DispatchPaths`, pushing them as details. If a configured Linux sandbox helper path does not exist, it downgrades the check to `Warning` with a helper-specific summary; otherwise it returns `Ok`.

**Call relations**: It is run synchronously by `build_report` after config loads and uses `push_path_detail` for helper path formatting.

*Call graph*: calls 2 internal fn (new, push_path_detail); 2 external calls (new, format!).


##### `TerminalCheckInputs::detect`  (lines 1682–1706)

```
fn detect(no_color_flag: bool) -> Self
```

**Purpose**: Captures a snapshot of terminal-related environment, terminal detection metadata, tty/color support, terminal size, tmux diagnostics, and Windows console details.

**Data flow**: Builds the set of relevant env names with `terminal_env_names`, snapshots present and nonempty values via `collect_env_snapshot`, reads terminal size from `crossterm::terminal::size`, gets `TerminalInfo` from `terminal_info()`, conditionally gathers tmux diagnostics when the multiplexer is tmux, gathers Windows console details, and returns a populated `TerminalCheckInputs` struct including stdin/stdout/stderr tty booleans and stdout color support.

**Call relations**: It is called by `terminal_check` as the environment-capture phase before pure evaluation in `terminal_check_from_inputs`.

*Call graph*: calls 4 internal fn (collect_env_snapshot, terminal_env_names, tmux_diagnostic_details, windows_console_details); called by 1 (terminal_check); 8 external calls (new, terminal_info, size, matches!, stderr, stdin, stdout, on).


##### `TerminalCheckInputs::env_value`  (lines 1708–1710)

```
fn env_value(&self, name: &str) -> Option<&str>
```

**Purpose**: Looks up a nonempty captured environment value by name.

**Data flow**: Reads `self.env` and returns `Option<&str>` for the requested variable name.

**Call relations**: It is used by terminal rendering/evaluation helpers such as `push_terminal_env_values`, `push_terminfo_details`, `color_output_summary`, and `terminal_size_issues`.

*Call graph*: called by 4 (color_output_summary, push_terminal_env_values, push_terminfo_details, terminal_size_issues).


##### `TerminalCheckInputs::env_present`  (lines 1712–1714)

```
fn env_present(&self, name: &str) -> bool
```

**Purpose**: Checks whether an environment variable was present at all, even if its captured value was empty.

**Data flow**: Tests membership of the requested name in `self.present_env` and returns a boolean.

**Call relations**: It is used where presence matters more than value, such as `NO_COLOR`, remote-terminal indicators, and empty `TERMINFO_DIRS` handling.

*Call graph*: called by 4 (color_output_summary, push_presence_env_values, push_terminal_env_values, push_terminfo_details); 1 external calls (contains).


##### `terminal_check`  (lines 1717–1719)

```
fn terminal_check(no_color_flag: bool) -> DoctorCheck
```

**Purpose**: Runs terminal diagnostics using a freshly detected terminal snapshot.

**Data flow**: Calls `TerminalCheckInputs::detect(no_color_flag)` and passes the resulting snapshot into `terminal_check_from_inputs`, returning that `DoctorCheck`.

**Call relations**: It is the production entry point used by `build_report`; tests target `terminal_check_from_inputs` directly with synthetic inputs.

*Call graph*: calls 2 internal fn (detect, terminal_check_from_inputs).


##### `windows_console_details`  (lines 1762–1764)

```
fn windows_console_details() -> Vec<String>
```

**Purpose**: Collects Windows console code-page and mode information when building on Windows, or returns no details on other platforms.

**Data flow**: On Windows, calls Win32 console APIs to read input/output code pages and stdout/stderr console modes, formatting VT-processing state when handles and modes are available. On non-Windows, returns an empty vector.

**Call relations**: It is called by `TerminalCheckInputs::detect` to enrich terminal diagnostics with Windows-specific console state.

*Call graph*: called by 1 (detect); 2 external calls (new, format!).


##### `terminal_check_from_inputs`  (lines 1766–1856)

```
fn terminal_check_from_inputs(inputs: TerminalCheckInputs) -> DoctorCheck
```

**Purpose**: Evaluates a captured terminal snapshot into a `DoctorCheck`, including metadata details and structured issues for dumb terminals, non-UTF-8 locales, unreadable terminfo, and narrow dimensions.

**Data flow**: Consumes `TerminalCheckInputs`, builds detail lines for terminal identity, TERM/TERM_PROGRAM/version, multiplexer, tty booleans, terminal size, color-output summary, env values, terminfo path readiness, effective locale, remote indicators, tmux details, and Windows console details. It then constructs `DoctorIssue`s for `TERM=dumb`, non-UTF-8 locale, unreadable terminfo, and any warnings from `terminal_size_issues`, computes status as the max issue severity, uses the first issue cause or a generic summary, and returns a `DoctorCheck` with attached issues.

**Call relations**: It is called by `terminal_check` in production and by many tests with synthetic inputs. It delegates to helpers like `terminal_name`, `multiplexer_name`, `push_terminal_env_values`, `push_presence_env_values`, `color_output_summary`, `push_terminfo_details`, `effective_locale`, and `terminal_size_issues`.

*Call graph*: calls 7 internal fn (new, new, effective_locale, push_presence_env_values, push_terminal_env_values, push_terminfo_details, terminal_size_issues); called by 9 (terminal_check, terminal_check_includes_windows_console_details, terminal_check_keeps_tmux_probe_failures_non_fatal, terminal_check_reports_remote_indicators_as_present_only, terminal_check_warns_for_declared_narrow_terminal, terminal_check_warns_for_dumb_terminal, terminal_check_warns_for_narrow_terminal, terminal_check_warns_for_non_utf8_locale, terminal_check_warns_for_unreadable_terminfo_path); 4 external calls (new, format!, matches!, vec!).


##### `terminal_name`  (lines 1858–1875)

```
fn terminal_name(info: &TerminalInfo) -> &'static str
```

**Purpose**: Maps a detected `TerminalName` enum to a human-readable terminal name string.

**Data flow**: Matches `info.name` and returns a static string such as `Ghostty`, `Windows Terminal`, `dumb`, or `unknown`.

**Call relations**: It is used by `terminal_check_from_inputs` when building the primary `terminal:` detail.


##### `multiplexer_name`  (lines 1877–1888)

```
fn multiplexer_name(multiplexer: &Multiplexer) -> String
```

**Purpose**: Formats a detected terminal multiplexer and optional version.

**Data flow**: Matches `Multiplexer::Tmux` or `Multiplexer::Zellij`, returning either the bare name or `name version` when a version string is present.

**Call relations**: It is used by `terminal_check_from_inputs` when a multiplexer was detected.

*Call graph*: 1 external calls (format!).


##### `terminal_env_names`  (lines 1890–1898)

```
fn terminal_env_names() -> BTreeSet<&'static str>
```

**Purpose**: Builds the complete set of terminal-related environment variable names doctor wants to snapshot.

**Data flow**: Starts with `TERM`, `TERM_PROGRAM`, and `TERM_PROGRAM_VERSION`, then extends a `BTreeSet` with color, dimension, terminfo, locale, and remote-terminal env-var constants.

**Call relations**: It is used by `TerminalCheckInputs::detect` before collecting the environment snapshot.

*Call graph*: called by 1 (detect); 1 external calls (from).


##### `collect_env_snapshot`  (lines 1900–1915)

```
fn collect_env_snapshot(
    names: &BTreeSet<&'static str>,
) -> (BTreeMap<String, String>, BTreeSet<String>)
```

**Purpose**: Captures both present env-var names and trimmed nonempty values for a selected set of variables.

**Data flow**: Iterates the requested names, reads each with `env::var_os`, records presence in a `BTreeSet<String>`, trims lossy string values, and stores only nonempty values in a `BTreeMap<String, String>`. Returns `(values, present)`.

**Call relations**: It is called by `TerminalCheckInputs::detect` to preserve both presence-only and value-bearing env vars.

*Call graph*: called by 1 (detect); 3 external calls (new, new, var_os).


##### `push_terminal_env_values`  (lines 1917–1929)

```
fn push_terminal_env_values(
    details: &mut Vec<String>,
    inputs: &TerminalCheckInputs,
    names: &[&str],
)
```

**Purpose**: Appends detail lines for env vars, preserving the distinction between empty-present and value-present variables.

**Data flow**: For each requested name, it checks `inputs.env_value(name)` first and pushes `name: value` when present; otherwise, if `inputs.env_present(name)` is true, it pushes `name: present`.

**Call relations**: It is used by `terminal_check_from_inputs` for dimension, color, and other env-value sections.

*Call graph*: calls 2 internal fn (env_present, env_value); called by 1 (terminal_check_from_inputs); 1 external calls (format!).


##### `push_presence_env_values`  (lines 1931–1941)

```
fn push_presence_env_values(
    details: &mut Vec<String>,
    inputs: &TerminalCheckInputs,
    names: &[&str],
)
```

**Purpose**: Appends presence-only detail lines for sensitive or noisy env vars whose values should not be shown.

**Data flow**: For each requested name, if `inputs.env_present(name)` is true it pushes `name: present` into the details vector.

**Call relations**: It is used by `terminal_check_from_inputs` for remote-terminal indicators like `SSH_CONNECTION` so values are not leaked.

*Call graph*: calls 1 internal fn (env_present); called by 1 (terminal_check_from_inputs); 1 external calls (format!).


##### `color_output_summary`  (lines 1943–1968)

```
fn color_output_summary(inputs: &TerminalCheckInputs) -> String
```

**Purpose**: Summarizes whether color output is enabled and, if disabled, why.

**Data flow**: Reads the no-color flag, `NO_COLOR` presence, `TERM`, stdout tty status, and detected color support from `TerminalCheckInputs`. If `should_enable_color(...)` is true it returns `enabled`; otherwise it returns `disabled (<reason>)` with the first matching reason among `--no-color`, `NO_COLOR`, `TERM=dumb`, non-tty stdout, or missing color support.

**Call relations**: It is used by `terminal_check_from_inputs` to produce the `color output:` detail and shares the same decision helper as final human-output rendering.

*Call graph*: calls 3 internal fn (env_present, env_value, should_enable_color); 1 external calls (format!).


##### `push_terminfo_details`  (lines 1970–1991)

```
fn push_terminfo_details(details: &mut Vec<String>, inputs: &TerminalCheckInputs) -> bool
```

**Purpose**: Reports TERMINFO and TERMINFO_DIRS path readiness and returns whether any unreadable/missing path should be treated as a warning.

**Data flow**: Reads `TERMINFO` and `TERMINFO_DIRS` from captured inputs, converts each path to `PathBuf`, evaluates it with `terminal_path_readiness`, pushes formatted detail lines, and ORs together the warning flags. If `TERMINFO_DIRS` is present but empty, it records `TERMINFO_DIRS: present`.

**Call relations**: It is called by `terminal_check_from_inputs`; its boolean result feeds issue creation for unreadable terminfo.

*Call graph*: calls 3 internal fn (env_present, env_value, terminal_path_readiness); called by 1 (terminal_check_from_inputs); 3 external calls (from, split_paths, format!).


##### `terminal_path_readiness`  (lines 1993–2007)

```
fn terminal_path_readiness(path: &Path) -> (String, bool)
```

**Purpose**: Classifies a terminal capability path as readable directory, readable file, missing, unreadable, or wrong type.

**Data flow**: Checks metadata for `path`; readable directories are validated with `read_dir`, readable files with `read_probe_file`, other filesystem object types become `not a file or directory`, missing paths become `missing`, and all error cases return a `(status_string, true)` warning pair.

**Call relations**: It is used by `push_terminfo_details` to evaluate TERMINFO-related paths.

*Call graph*: calls 1 internal fn (read_probe_file); called by 1 (push_terminfo_details); 3 external calls (format!, metadata, read_dir).


##### `effective_locale`  (lines 2009–2013)

```
fn effective_locale(inputs: &TerminalCheckInputs) -> Option<String>
```

**Purpose**: Finds the first configured locale value among `LC_ALL`, `LC_CTYPE`, and `LANG`.

**Data flow**: Scans `LOCALE_ENV_VARS` in order and returns the first captured env value as an owned `String`, or `None` if none are set.

**Call relations**: It is used by `terminal_check_from_inputs` before checking UTF-8 suitability.

*Call graph*: called by 1 (terminal_check_from_inputs).


##### `is_non_utf8_locale`  (lines 2015–2018)

```
fn is_non_utf8_locale(locale: &str) -> bool
```

**Purpose**: Determines whether a locale string appears not to be UTF-8 based on substring matching.

**Data flow**: Lowercases the locale string and returns true unless it contains `utf-8` or `utf8`.

**Call relations**: It is used by `terminal_check_from_inputs` to decide whether to emit a locale warning issue.


##### `terminal_size_issues`  (lines 2020–2085)

```
fn terminal_size_issues(inputs: &TerminalCheckInputs) -> Vec<DoctorIssue>
```

**Purpose**: Generates warning issues for narrow detected terminal dimensions or narrow `COLUMNS`/`LINES` declarations.

**Data flow**: Reads `inputs.terminal_size` and optional parsed `COLUMNS`/`LINES` env values. For widths below 80 or heights below 24, it creates `DoctorIssue`s with measured values, expected thresholds, resize remedies, and field labels (`terminal size`, `COLUMNS`, `LINES`). It returns all generated issues as a vector.

**Call relations**: It is called by `terminal_check_from_inputs` and contributes warning issues that may become the row summary if they are first.

*Call graph*: calls 2 internal fn (new, env_value); called by 1 (terminal_check_from_inputs); 2 external calls (new, format!).


##### `tmux_diagnostic_details`  (lines 2087–2096)

```
fn tmux_diagnostic_details() -> Vec<String>
```

**Purpose**: Collects extra tmux-specific diagnostic details such as client termtype/termname and selected global options.

**Data flow**: Builds a vector, adds display-message-derived client termtype and termname via `push_tmux_display_detail`, then queries each option in `TMUX_OPTION_NAMES` with `tmux_option_value`, defaulting to `unavailable` when absent.

**Call relations**: It is called by `TerminalCheckInputs::detect` only when tmux was detected.

*Call graph*: calls 2 internal fn (push_tmux_display_detail, tmux_option_value); called by 1 (detect); 2 external calls (new, format!).


##### `push_tmux_display_detail`  (lines 2098–2102)

```
fn push_tmux_display_detail(details: &mut Vec<String>, label: &str, format: &str)
```

**Purpose**: Adds one tmux display-message value to the detail list when available.

**Data flow**: Runs `tmux_display_message(format)` and, if it returns `Some(value)`, pushes `label: value` into the details vector.

**Call relations**: It is a helper used by `tmux_diagnostic_details`.

*Call graph*: calls 1 internal fn (tmux_display_message); called by 1 (tmux_diagnostic_details); 1 external calls (format!).


##### `tmux_option_value`  (lines 2104–2113)

```
fn tmux_option_value(option: &str) -> Option<String>
```

**Purpose**: Reads one tmux global option value as a trimmed string.

**Data flow**: Runs `tmux show-options -gqv <option>`, returns `None` on spawn failure or non-success exit, decodes stdout as UTF-8, trims it with `non_empty_trimmed`, and returns the resulting `Option<String>`.

**Call relations**: It is used by `tmux_diagnostic_details` for each option in `TMUX_OPTION_NAMES`.

*Call graph*: calls 1 internal fn (non_empty_trimmed); called by 1 (tmux_diagnostic_details); 2 external calls (from_utf8, new).


##### `tmux_display_message`  (lines 2115–2124)

```
fn tmux_display_message(format: &str) -> Option<String>
```

**Purpose**: Evaluates a tmux format string using `display-message -p` and returns a trimmed nonempty result.

**Data flow**: Runs `tmux display-message -p <format>`, returns `None` on failure or non-success exit, decodes stdout as UTF-8, and passes it through `non_empty_trimmed`.

**Call relations**: It is used by `push_tmux_display_detail`.

*Call graph*: calls 1 internal fn (non_empty_trimmed); called by 1 (push_tmux_display_detail); 2 external calls (from_utf8, new).


##### `non_empty_trimmed`  (lines 2126–2129)

```
fn non_empty_trimmed(value: String) -> Option<String>
```

**Purpose**: Normalizes a string by trimming whitespace and discarding it if empty.

**Data flow**: Trims the input `String`; returns `None` if the trimmed result is empty, otherwise returns `Some(trimmed_string)`.

**Call relations**: It is shared by tmux command helpers to collapse blank output into absence.

*Call graph*: called by 2 (tmux_display_message, tmux_option_value).


##### `state_check`  (lines 2131–2161)

```
async fn state_check(config: &Config) -> DoctorCheck
```

**Purpose**: Inspects Codex state directories and runtime SQLite databases, including integrity checks and rollout-file statistics.

**Data flow**: Builds details for `CODEX_HOME`, log dir, and sqlite home using `path_readiness`, then iterates `codex_state::runtime_db_paths(&config.sqlite_home)`, recording each DB path and awaiting `sqlite_integrity_detail` to collect integrity failures. It adds rollout statistics and standalone release-cache details, derives `Ok` vs `Fail` based on whether any integrity failures were recorded, and returns a `DoctorCheck` with a remediation instructing users to move damaged DBs aside when needed.

**Call relations**: It is run asynchronously by `build_report` after config loads. It delegates to `path_readiness`, `sqlite_integrity_detail`, `rollout_stats_details`, and `standalone_release_cache_details`.

*Call graph*: calls 5 internal fn (new, path_readiness, rollout_stats_details, sqlite_integrity_detail, standalone_release_cache_details); 2 external calls (new, runtime_db_paths).


##### `sqlite_integrity_detail`  (lines 2163–2189)

```
async fn sqlite_integrity_detail(
    details: &mut Vec<String>,
    integrity_failures: &mut Vec<String>,
    label: &str,
    path: &Path,
)
```

**Purpose**: Runs a bounded SQLite integrity check for one database file and records either success, failure rows, or probe errors.

**Data flow**: Accepts mutable detail and failure vectors plus a DB label and path. If the path is not a file, it records `integrity: skipped (missing)`. Otherwise it awaits `codex_state::sqlite_integrity_check(path)`; all-`ok` rows become `integrity: ok`, non-ok rows are joined into a failure message pushed to both vectors, and errors are likewise recorded as failures.

**Call relations**: It is called by `state_check` for each runtime DB path.

*Call graph*: called by 1 (state_check); 3 external calls (is_file, sqlite_integrity_check, format!).


##### `rollout_stats_details`  (lines 2191–2196)

```
fn rollout_stats_details(details: &mut Vec<String>, codex_home: &Path)
```

**Purpose**: Collects and records aggregate statistics for active and archived rollout JSONL files.

**Data flow**: Calls `collect_rollout_stats` on `codex_home/sessions` and `codex_home/archived_sessions`, then formats each result through `push_rollout_stats_detail`.

**Call relations**: It is used by `state_check` to expose rollout-file volume and scan errors.

*Call graph*: calls 2 internal fn (collect_rollout_stats, push_rollout_stats_detail); called by 1 (state_check); 1 external calls (join).


##### `push_rollout_stats_detail`  (lines 2198–2208)

```
fn push_rollout_stats_detail(details: &mut Vec<String>, label: &str, stats: RolloutStats)
```

**Purpose**: Formats one `RolloutStats` aggregate into a detail line.

**Data flow**: If `stats.error` is set, pushes `<label>: scan failed (<error>)`; otherwise pushes file count, total bytes, and average bytes using `stats.average_bytes()`.

**Call relations**: It is called by `rollout_stats_details` for active and archived rollout trees.

*Call graph*: called by 1 (rollout_stats_details); 1 external calls (format!).


##### `RolloutStats::average_bytes`  (lines 2218–2220)

```
fn average_bytes(&self) -> u64
```

**Purpose**: Computes average bytes per rollout file, safely handling zero files.

**Data flow**: Divides `self.total_bytes` by `self.files` with `checked_div`, returning 0 when `files == 0`.

**Call relations**: It is used when formatting rollout statistics.


##### `collect_rollout_stats`  (lines 2223–2227)

```
fn collect_rollout_stats(root: &Path) -> RolloutStats
```

**Purpose**: Recursively scans a rollout directory tree and returns aggregate file-count and byte-count statistics.

**Data flow**: Creates a default `RolloutStats`, passes it to `collect_rollout_stats_inner(root, &mut stats)`, and returns the filled struct.

**Call relations**: It is used by `rollout_stats_details` and directly unit-tested with nested rollout files.

*Call graph*: calls 1 internal fn (collect_rollout_stats_inner); called by 2 (rollout_stats_details, collect_rollout_stats_counts_nested_rollout_files); 1 external calls (default).


##### `collect_rollout_stats_inner`  (lines 2229–2265)

```
fn collect_rollout_stats_inner(path: &Path, stats: &mut RolloutStats)
```

**Purpose**: Performs the recursive directory walk for rollout statistics, stopping early on the first scan error.

**Data flow**: If `stats.error` is already set it returns immediately. Otherwise it reads the directory, ignoring `NotFound`, storing any other error in `stats.error`, then iterates entries. Directories recurse; files whose names satisfy `is_rollout_file` increment `stats.files` and saturating-add their byte length to `stats.total_bytes`.

**Call relations**: It is the recursive worker behind `collect_rollout_stats`.

*Call graph*: calls 1 internal fn (is_rollout_file); called by 1 (collect_rollout_stats); 1 external calls (read_dir).


##### `is_rollout_file`  (lines 2267–2273)

```
fn is_rollout_file(path: &Path) -> bool
```

**Purpose**: Recognizes rollout log files by extension and filename prefix.

**Data flow**: Returns true when `path.extension()` is `jsonl` and the filename string starts with `rollout-`.

**Call relations**: It is used by `collect_rollout_stats_inner` to filter relevant files.

*Call graph*: called by 1 (collect_rollout_stats_inner); 3 external calls (new, extension, file_name).


##### `websocket_reachability_check`  (lines 2275–2409)

```
async fn websocket_reachability_check(
    config: &Config,
    auth_manager: Option<Arc<AuthManager>>,
) -> DoctorCheck
```

**Purpose**: Performs a bounded Responses WebSocket handshake probe for the active model provider and reports setup, endpoint, DNS, auth, and handshake outcomes.

**Data flow**: Reads provider metadata from `Config`, records provider details and proxy env vars, and returns early `Ok` if websockets are unsupported. Otherwise it records connect timeout, builds a runtime provider with `create_model_provider`, resolves auth and API provider, records auth mode and endpoint, optionally adds DNS family details, resolves API auth, constructs extra beta headers, creates a `ResponsesWebsocketClient`, and runs `probe_handshake` under a timeout. Successful handshakes record HTTP status and response metadata; immediate close becomes a warning with remediation; provider setup/auth/endpoint failures, handshake errors, and timeouts all become warning checks via `websocket_probe_warning`.

**Call relations**: It is run asynchronously by `build_report` after config loads. It delegates to `push_proxy_env_details`, `auth_mode_name`, `dns_address_family_details`, `websocket_error_detail`, and `websocket_probe_warning`.

*Call graph*: calls 7 internal fn (new, dns_address_family_details, push_proxy_env_details, websocket_error_detail, websocket_probe_warning, new, default_headers); 6 external calls (new, from_static, create_model_provider, format!, timeout, vec!).


##### `websocket_probe_warning`  (lines 2411–2425)

```
fn websocket_probe_warning(
    summary: &'static str,
    mut details: Vec<String>,
    error_detail: String,
) -> DoctorCheck
```

**Purpose**: Builds a standardized warning check for websocket probe failures or degraded outcomes.

**Data flow**: Takes a summary string, an existing details vector, and one error-detail string, appends the error detail, and returns a warning `DoctorCheck` with a fixed remediation about proxy/VPN/firewall/DNS/custom-CA/WebSocket policy support.

**Call relations**: It is used by `websocket_reachability_check` for provider setup failures, endpoint build failures, auth resolution failures, handshake errors, and timeouts.

*Call graph*: calls 1 internal fn (new); called by 1 (websocket_reachability_check).


##### `websocket_error_detail`  (lines 2427–2443)

```
fn websocket_error_detail(err: &ApiError) -> String
```

**Purpose**: Converts `ApiError` variants from websocket probing into concise detail strings.

**Data flow**: Matches the `ApiError` enum and formats transport, API, stream, and other higher-level error variants into strings prefixed with `handshake ... error:`.

**Call relations**: It is used by `websocket_reachability_check` when a handshake attempt returns `Err(ApiError)`.

*Call graph*: called by 1 (websocket_reachability_check); 1 external calls (format!).


##### `auth_mode_name`  (lines 2445–2454)

```
fn auth_mode_name(auth: &CodexAuth) -> &'static str
```

**Purpose**: Formats a resolved runtime `CodexAuth` mode as a stable snake-case string.

**Data flow**: Calls `auth.auth_mode()` and maps the enum variant to strings like `api_key`, `chatgpt`, or `personal_access_token`.

**Call relations**: It is used by `websocket_reachability_check` when recording the auth mode detail.

*Call graph*: calls 1 internal fn (auth_mode).


##### `dns_address_family_details`  (lines 2456–2481)

```
async fn dns_address_family_details(host: &str, port: u16) -> Vec<String>
```

**Purpose**: Performs DNS resolution for a host/port pair and summarizes IPv4/IPv6 availability.

**Data flow**: Calls `tokio::net::lookup_host((host, port)).await`, collects all addresses, counts IPv4 and IPv6 entries, determines the family of the first address if any, and returns a one-element detail vector. Lookup errors become a `DNS: lookup failed (...)` detail.

**Call relations**: It is called by `websocket_reachability_check` after successfully constructing a websocket endpoint URL with a host and port.

*Call graph*: called by 1 (websocket_reachability_check); 2 external calls (lookup_host, vec!).


##### `fallback_state_check`  (lines 2483–2501)

```
fn fallback_state_check() -> DoctorCheck
```

**Purpose**: Provides a minimal state-path check when full config loading failed.

**Data flow**: Calls `find_codex_home()`. On success it returns an `Ok` check with one `CODEX_HOME:` detail; on failure it returns a `Warning` check containing the error text.

**Call relations**: It is used only by the config-failure branch of `build_report`.

*Call graph*: calls 2 internal fn (new, find_codex_home); 1 external calls (format!).


##### `ProviderAuthReachabilityMode::description`  (lines 2525–2531)

```
fn description(self) -> &'static str
```

**Purpose**: Returns the human-readable label for the chosen provider reachability mode.

**Data flow**: Matches the enum variant and returns `provider auth`, `API key auth`, or `ChatGPT auth`.

**Call relations**: It is used by `provider_reachability_plan_from_parts` when constructing the plan description.

*Call graph*: called by 1 (provider_reachability_plan_from_parts).


##### `provider_reachability_plan`  (lines 2534–2556)

```
fn provider_reachability_plan(config: &Config) -> ReachabilityPlan
```

**Purpose**: Builds the HTTP reachability probe plan for the active provider based on config and available auth signals.

**Data flow**: Attempts to load stored auth from `auth.json`, computes a `ProviderAuthReachabilityMode` with `provider_auth_reachability_mode_from_auth`, then calls `provider_reachability_plan_from_parts` with provider id/name/base URL/query params, Bedrock detection, and ChatGPT base URL.

**Call relations**: It is called by `build_report` after config loads and feeds the async `provider_reachability_check`.

*Call graph*: calls 2 internal fn (provider_auth_reachability_mode_from_auth, provider_reachability_plan_from_parts); called by 1 (build_report); 2 external calls (auth_keyring_backend_kind, load_auth_dot_json).


##### `default_reachability_plan`  (lines 2558–2568)

```
fn default_reachability_plan() -> ReachabilityPlan
```

**Purpose**: Builds a fallback reachability plan targeting ChatGPT/OpenAI defaults when config could not be loaded.

**Data flow**: Calls `provider_reachability_plan_from_parts` with hard-coded OpenAI/ChatGPT defaults and `ProviderAuthReachabilityMode::Chatgpt`.

**Call relations**: It is used only by the config-failure branch of `build_report`.

*Call graph*: calls 1 internal fn (provider_reachability_plan_from_parts); called by 1 (build_report).


##### `provider_auth_reachability_mode_from_auth`  (lines 2570–2597)

```
fn provider_auth_reachability_mode_from_auth(
    requires_openai_auth: bool,
    env_var_present: impl Fn(&str) -> bool,
    stored_auth: Option<&AuthDotJson>,
) -> ProviderAuthReachabilityMode
```

**Purpose**: Chooses whether reachability should be probed in provider-auth, API-key-auth, or ChatGPT-auth mode based on provider requirements and available auth signals.

**Data flow**: If the provider does not require OpenAI auth, returns `NotRequired`. Otherwise it prefers API-key mode when `OPENAI_API_KEY` or `CODEX_API_KEY` is present, ChatGPT mode when `CODEX_ACCESS_TOKEN` is present, and otherwise infers from stored auth mode: API key/Bedrock => `ApiKey`, everything else or no stored auth => `Chatgpt`.

**Call relations**: It is used by `provider_reachability_plan` and directly unit-tested for API-key selection behavior.

*Call graph*: calls 1 internal fn (env_var_present); called by 1 (provider_reachability_plan).


##### `provider_reachability_plan_from_parts`  (lines 2599–2646)

```
fn provider_reachability_plan_from_parts(
    mode: ProviderAuthReachabilityMode,
    provider_id: &str,
    provider_name: &str,
    provider_base_url: Option<&str>,
    provider_query_params: Option
```

**Purpose**: Constructs the concrete list of HTTP endpoints and optional `/models` route probes to test for provider reachability.

**Data flow**: Accepts the chosen auth mode plus provider metadata. It computes an optional `route_probe_url` by deciding whether `/models` should be probed and by appending query params with `provider_url_for_path`. It then builds endpoint vectors: API-key mode probes the provider base URL or OpenAI default; ChatGPT mode probes only the ChatGPT base URL; not-required mode probes the provider base URL if one exists. It returns a `ReachabilityPlan` with a description string and endpoint list.

**Call relations**: It is called by both `provider_reachability_plan` and `default_reachability_plan`, and is directly unit-tested for Azure/custom/Bedrock/OpenAI cases.

*Call graph*: calls 1 internal fn (description); called by 6 (default_reachability_plan, provider_reachability_plan, provider_reachability_api_key_does_not_require_chatgpt, provider_reachability_route_401_keeps_reachability_ok, provider_reachability_route_404_fails_bad_base_url_path, provider_reachability_skips_route_probe_for_bedrock); 1 external calls (vec!).


##### `should_probe_models_route`  (lines 2648–2650)

```
fn should_probe_models_route(provider_name: &str, base_url: &str, is_amazon_bedrock: bool) -> bool
```

**Purpose**: Decides whether a provider base URL should also be tested with a `/models` route probe.

**Data flow**: Returns false for Amazon Bedrock and Azure Responses providers; otherwise true.

**Call relations**: It is used by `provider_reachability_plan_from_parts` when deciding whether to generate `route_probe_url`.

*Call graph*: 1 external calls (is_azure_responses_provider).


##### `provider_url_for_path`  (lines 2652–2680)

```
fn provider_url_for_path(
    base_url: &str,
    path: &str,
    query_params: Option<&HashMap<String, String>>,
) -> String
```

**Purpose**: Appends a path and optional query parameters to a provider base URL without duplicating or dropping separators.

**Data flow**: Trims trailing slashes from `base_url` and leading slashes from `path`, concatenates them, then appends serialized `key=value` query params with either `?` or `&` depending on whether the URL already contains a query string.

**Call relations**: It is used by `provider_reachability_plan_from_parts` to build `/models` route-probe URLs.

*Call graph*: 1 external calls (format!).


##### `provider_reachability_check`  (lines 2682–2797)

```
async fn provider_reachability_check(plan: ReachabilityPlan) -> DoctorCheck
```

**Purpose**: Executes the HTTP reachability plan, probing base URLs and optional route URLs, and converts transport/404/warning outcomes into a final check with issues and remediation.

**Data flow**: Starts details with the plan description. If there are no endpoints, it returns an immediate `Ok` check. Otherwise it iterates endpoints, probing each base URL with `http_probe_url`; required failures are accumulated separately from optional failures. For endpoints with `route_probe_url`, it calls `provider_route_probe_url` and records `Ok`, `Warning`, `Fail`, or `TransportError` outcomes, creating structured `DoctorIssue`s for required route failures and transport errors. It then computes final status/summary with `provider_reachability_outcome`, attaches issues, adds remediation when non-ok, and returns the `DoctorCheck`.

**Call relations**: It is launched asynchronously by `build_report` and directly unit-tested for 404-failure and 401-success route-probe behavior. It delegates to `http_probe_url`, `provider_route_probe_url`, and `provider_reachability_outcome`.

*Call graph*: calls 5 internal fn (new, new, http_probe_url, provider_reachability_outcome, provider_route_probe_url); called by 2 (provider_reachability_route_401_keeps_reachability_ok, provider_reachability_route_404_fails_bad_base_url_path); 3 external calls (new, format!, vec!).


##### `provider_route_probe_url`  (lines 2806–2815)

```
async fn provider_route_probe_url(url: &str) -> RouteProbeOutcome
```

**Purpose**: Performs a GET probe against a provider route and classifies the HTTP status into ok, warning, fail, or transport error.

**Data flow**: Calls `http_get_probe_status_with_timeout(url, 3s)`. HTTP 2xx, 401, and 403 become `RouteProbeOutcome::Ok`; 404 becomes `Fail`; other statuses become `Warning`; transport errors become `TransportError` with the error string.

**Call relations**: It is used by `provider_reachability_check` for optional `/models` route validation.

*Call graph*: calls 1 internal fn (http_get_probe_status_with_timeout); called by 1 (provider_reachability_check); 7 external calls (from_secs, Fail, Ok, TransportError, Warning, format!, matches!).


##### `provider_reachability_outcome`  (lines 2817–2835)

```
fn provider_reachability_outcome(
    required_failures: usize,
    warnings: usize,
) -> (CheckStatus, &'static str)
```

**Purpose**: Maps counts of required failures and warnings into the final reachability status and summary string.

**Data flow**: Given `required_failures` and `warnings`, returns `(Ok, ...)` when both are zero, `(Warning, ...)` when only warnings are present, and `(Fail, ...)` when any required failure exists.

**Call relations**: It is used by `provider_reachability_check` and directly unit-tested.

*Call graph*: called by 1 (provider_reachability_check).


##### `http_probe_url`  (lines 2837–2839)

```
async fn http_probe_url(url: &str) -> Result<String, String>
```

**Purpose**: Runs a bounded HEAD probe against a URL and returns a formatted HTTP status string or transport error.

**Data flow**: Calls `http_probe_url_with_timeout(url, 3s)` and returns its `Result<String, String>` unchanged.

**Call relations**: It is used by `provider_reachability_check` and directly unit-tested to confirm non-2xx HTTP statuses still count as reachable transport.

*Call graph*: calls 1 internal fn (http_probe_url_with_timeout); called by 2 (provider_reachability_check, http_probe_treats_http_status_as_reachable); 1 external calls (from_secs).


##### `mcp_http_probe_url`  (lines 2841–2843)

```
async fn mcp_http_probe_url(url: &str) -> Result<String, String>
```

**Purpose**: Runs a bounded MCP HTTP reachability probe with HEAD-first then GET fallback behavior.

**Data flow**: Calls `mcp_http_probe_url_with_timeout(url, 3s)` and returns its result.

**Call relations**: It is used by `mcp_check_from_servers` for streamable HTTP MCP servers.

*Call graph*: calls 1 internal fn (mcp_http_probe_url_with_timeout); called by 1 (mcp_check_from_servers); 1 external calls (from_secs).


##### `mcp_http_probe_url_with_timeout`  (lines 2845–2853)

```
async fn mcp_http_probe_url_with_timeout(url: &str, timeout: Duration) -> Result<String, String>
```

**Purpose**: Probes an MCP HTTP endpoint with HEAD first and falls back to GET when HEAD fails, combining both error messages if necessary.

**Data flow**: Calls `http_probe_url_with_timeout(url, timeout)`; on success returns that status. On HEAD error it calls `http_get_probe_url_with_timeout(url, timeout)` and returns either the GET status or a combined `HEAD ...; GET ...` error string.

**Call relations**: It is used by `mcp_http_probe_url` and directly unit-tested for HEAD-timeout/GET-success fallback.

*Call graph*: calls 2 internal fn (http_get_probe_url_with_timeout, http_probe_url_with_timeout); called by 2 (mcp_http_probe_url, mcp_http_probe_falls_back_to_get_when_head_times_out); 1 external calls (format!).


##### `http_probe_url_with_timeout`  (lines 2855–2873)

```
async fn http_probe_url_with_timeout(url: &str, timeout: Duration) -> Result<String, String>
```

**Purpose**: Performs a HEAD request with a timeout and normalizes reqwest transport errors into concise strings.

**Data flow**: Builds a reqwest client with `build_reqwest_client()`, sends a HEAD request with the given timeout, maps timeout/connect/builder errors to short strings, and on success returns `HTTP <status_code>`.

**Call relations**: It is the transport helper behind `http_probe_url` and the HEAD phase of `mcp_http_probe_url_with_timeout`.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 2 (http_probe_url, mcp_http_probe_url_with_timeout); 1 external calls (format!).


##### `http_get_probe_url_with_timeout`  (lines 2875–2879)

```
async fn http_get_probe_url_with_timeout(url: &str, timeout: Duration) -> Result<String, String>
```

**Purpose**: Performs a GET request with a timeout and returns a formatted HTTP status string.

**Data flow**: Calls `http_get_probe_status_with_timeout`, then formats the returned status code as `HTTP <status>`.

**Call relations**: It is used by `mcp_http_probe_url_with_timeout` as the GET fallback.

*Call graph*: calls 1 internal fn (http_get_probe_status_with_timeout); called by 1 (mcp_http_probe_url_with_timeout).


##### `http_get_probe_status_with_timeout`  (lines 2881–2899)

```
async fn http_get_probe_status_with_timeout(url: &str, timeout: Duration) -> Result<u16, String>
```

**Purpose**: Performs a GET request with a timeout and returns the numeric HTTP status code or a concise transport error string.

**Data flow**: Builds a reqwest client, sends a GET request with the given timeout, maps timeout/connect/builder errors to short strings, and returns `response.status().as_u16()` on success.

**Call relations**: It is used by `http_get_probe_url_with_timeout` and `provider_route_probe_url`.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 2 (http_get_probe_url_with_timeout, provider_route_probe_url).


##### `stdio_command_resolves`  (lines 2901–2944)

```
fn stdio_command_resolves(
    command: &str,
    cwd: Option<&Path>,
    server_env: Option<&HashMap<String, String>>,
) -> Result<(), String>
```

**Purpose**: Checks whether an MCP stdio command resolves to an executable path, honoring absolute paths, relative paths, cwd, PATH, and PATHEXT on Windows.

**Data flow**: Accepts a command string, optional cwd, and optional server env map. Absolute paths are checked directly with `executable_path_exists`. Multi-component relative paths are resolved against `cwd` or current dir. Bare commands search either `server_env["PATH"]` or process `PATH`, testing each candidate and, on Windows, each PATHEXT suffix. It returns `Ok(())` on the first executable match or an explanatory `Err(String)` such as `PATH is not set` or `not found on PATH`.

**Call relations**: It is used by `mcp_check_from_servers` to validate enabled stdio MCP server commands before runtime.

*Call graph*: calls 1 internal fn (executable_path_exists); called by 1 (mcp_check_from_servers); 4 external calls (new, split_paths, var, format!).


##### `executable_path_exists`  (lines 2946–2952)

```
fn executable_path_exists(path: &Path) -> Result<(), String>
```

**Purpose**: Checks whether a path exists as a file and, on Unix, whether it has executable permission bits.

**Data flow**: Reads metadata for `path`; non-file objects become `Err("path is not a file")`, metadata errors become their string form, and files are passed to `executable_file_permission` for platform-specific executability validation.

**Call relations**: It is used by `stdio_command_resolves` and directly unit-tested on Unix.

*Call graph*: calls 1 internal fn (executable_file_permission); called by 2 (stdio_command_resolves, executable_path_exists_rejects_non_executable_file); 1 external calls (metadata).


##### `executable_file_permission`  (lines 2966–2968)

```
fn executable_file_permission(_path: &Path, _metadata: &std::fs::Metadata) -> Result<(), String>
```

**Purpose**: Validates Unix executable permission bits, or accepts all files on non-Unix platforms.

**Data flow**: On Unix it inspects `metadata.permissions().mode() & 0o111` and returns an error naming the path when no execute bits are set; on non-Unix it always returns `Ok(())`.

**Call relations**: It is called only by `executable_path_exists`.

*Call graph*: called by 1 (executable_path_exists); 2 external calls (permissions, format!).


##### `path_readiness`  (lines 2970–2987)

```
fn path_readiness(details: &mut Vec<String>, label: &str, path: &Path)
```

**Purpose**: Adds a detail line describing whether a path exists and whether it is a directory, file, other object, or missing/unreadable.

**Data flow**: Checks metadata for `path` and pushes `<label>: <path> (dir|file|other)` on success, `(missing)` for `NotFound`, or the raw I/O error otherwise.

**Call relations**: It is used by `state_check` for state directories and DB paths.

*Call graph*: called by 1 (state_check); 2 external calls (format!, metadata).


##### `standalone_release_cache_details`  (lines 2989–3005)

```
fn standalone_release_cache_details(details: &mut Vec<String>)
```

**Purpose**: Reports how many standalone release-cache entries exist when the current install method is standalone.

**Data flow**: Reads `InstallContext::current()`, returns early unless the method is `Standalone`, finds the parent releases directory of `release_dir`, counts readable directory entries, and pushes one detail line with the count and path.

**Call relations**: It is used by `state_check` to expose standalone release-cache buildup.

*Call graph*: calls 1 internal fn (current); called by 1 (state_check); 2 external calls (format!, read_dir).


##### `push_path_detail`  (lines 3007–3012)

```
fn push_path_detail(details: &mut Vec<String>, label: &str, path: Option<&Path>)
```

**Purpose**: Formats an optional path into a detail line with either the path or `none`.

**Data flow**: Given a mutable detail vector, label, and `Option<&Path>`, it pushes either `<label>: <path>` or `<label>: none`.

**Call relations**: It is used by `installation_check` and `sandbox_check`.

*Call graph*: called by 2 (installation_check, sandbox_check); 1 external calls (format!).


##### `push_env_path_detail`  (lines 3014–3019)

```
fn push_env_path_detail(details: &mut Vec<String>, label: &str, name: &str)
```

**Purpose**: Formats a path-valued environment variable into a detail line, preserving whether it is unset.

**Data flow**: Reads `env::var_os(name)` and pushes either `<label>: <path>` or `<label>: not set`.

**Call relations**: It is used by `installation_check` for `CODEX_MANAGED_PACKAGE_ROOT`.

*Call graph*: called by 1 (installation_check); 2 external calls (var_os, format!).


##### `env_var_present`  (lines 3021–3023)

```
fn env_var_present(name: &str) -> bool
```

**Purpose**: Checks whether an environment variable exists and is nonempty.

**Data flow**: Reads `env::var_os(name)` and returns true only when the value is present and not empty.

**Call relations**: It is a small shared predicate used across auth, MCP, proxy, and reachability logic.

*Call graph*: called by 4 (mcp_check_from_servers, provider_auth_reachability_mode_from_auth, provider_specific_auth_check, stored_auth_issues); 1 external calls (var_os).


##### `human_output_options`  (lines 3025–3040)

```
fn human_output_options(command: &DoctorCommand) -> HumanOutputOptions
```

**Purpose**: Derives renderer presentation options from the doctor command and current terminal capabilities.

**Data flow**: Reads `TERM`, `NO_COLOR`, stdout tty status, and stdout color support, computes `color_enabled` with `should_enable_color`, and returns `HumanOutputOptions` carrying `show_details`, `show_all`, `ascii`, and `color_enabled`.

**Call relations**: It is used by `run_doctor` when rendering human output.

*Call graph*: calls 1 internal fn (should_enable_color); 4 external calls (var, var_os, stdout, on).


##### `should_enable_color`  (lines 3042–3054)

```
fn should_enable_color(
    no_color_flag: bool,
    no_color_env: bool,
    term: Option<&str>,
    stdout_is_tty: bool,
    stream_supports_color: bool,
) -> bool
```

**Purpose**: Centralizes the decision for whether colored human output should be enabled.

**Data flow**: Returns true only when `--no-color` is false, `NO_COLOR` is absent, `TERM` is not `dumb`, stdout is a tty, and color support was detected.

**Call relations**: It is shared by `human_output_options` and terminal diagnostics via `color_output_summary`, and is directly unit-tested.

*Call graph*: called by 2 (color_output_summary, human_output_options).


##### `tests::RecordingProgress::events`  (lines 3075–3077)

```
fn events(&self) -> Vec<String>
```

**Purpose**: Returns a snapshot of recorded progress events from the test progress implementation.

**Data flow**: Locks the internal `Mutex<Vec<String>>`, clones the vector, and returns it.

**Call relations**: Used by progress-related tests to assert begin/finish/heartbeat/settle ordering.


##### `tests::RecordingProgress::begin`  (lines 3081–3086)

```
fn begin(&self, label: &'static str)
```

**Purpose**: Records a `begin <label>` event for tests.

**Data flow**: Locks the event vector and pushes a formatted begin string.

**Call relations**: Implements `DoctorProgress` for the test helper used by sync/async progress tests.

*Call graph*: 1 external calls (format!).


##### `tests::RecordingProgress::heartbeat`  (lines 3088–3093)

```
fn heartbeat(&self, label: &'static str, elapsed: Duration)
```

**Purpose**: Records a heartbeat event with elapsed seconds for tests.

**Data flow**: Locks the event vector and pushes `heartbeat <label> <secs>`.

**Call relations**: Part of the test `DoctorProgress` implementation.

*Call graph*: 1 external calls (format!).


##### `tests::RecordingProgress::finish`  (lines 3095–3100)

```
fn finish(&self, label: &'static str, status: CheckStatus)
```

**Purpose**: Records a finish event with final status for tests.

**Data flow**: Locks the event vector and pushes `finish <label> <status>`.

**Call relations**: Part of the test `DoctorProgress` implementation.

*Call graph*: 1 external calls (format!).


##### `tests::RecordingProgress::settle`  (lines 3102–3107)

```
fn settle(&self)
```

**Purpose**: Records a final `settle` event for tests.

**Data flow**: Locks the event vector and pushes the literal string `settle`.

**Call relations**: Part of the test `DoctorProgress` implementation.


##### `tests::respond_once`  (lines 3110–3115)

```
fn respond_once(listener: &TcpListener, response: &[u8])
```

**Purpose**: Accepts one TCP connection and writes a canned HTTP response for probe tests.

**Data flow**: Accepts a connection from `TcpListener`, reads up to 1024 bytes of request data, writes the provided response bytes, and returns.

**Call relations**: Used by HTTP and provider-reachability tests to simulate simple probe servers.

*Call graph*: 1 external calls (accept).


##### `tests::overall_status_prefers_fail`  (lines 3118–3124)

```
fn overall_status_prefers_fail()
```

**Purpose**: Verifies that overall report status becomes `Fail` when any check fails.

**Data flow**: Builds a small vector of warning and fail checks, calls `overall_status`, and asserts the result is `CheckStatus::Fail`.

**Call relations**: Direct unit test for `overall_status` precedence.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::run_sync_check_notifies_progress`  (lines 3127–3140)

```
fn run_sync_check_notifies_progress()
```

**Purpose**: Verifies that synchronous checks emit begin and finish progress events.

**Data flow**: Creates a `RecordingProgress`, runs `run_sync_check` with a trivial ok check, then asserts both the returned status and the recorded event sequence.

**Call relations**: Tests the wrapper behavior of `run_sync_check`.

*Call graph*: calls 1 internal fn (run_sync_check); 3 external calls (new, assert_eq!, default).


##### `tests::run_async_check_notifies_progress`  (lines 3143–3157)

```
async fn run_async_check_notifies_progress()
```

**Purpose**: Verifies that asynchronous checks emit begin and finish progress events.

**Data flow**: Creates a `RecordingProgress`, awaits `run_async_check` on a trivial warning future, and asserts the returned status and recorded events.

**Call relations**: Tests the wrapper behavior of `run_async_check`.

*Call graph*: calls 2 internal fn (new, run_async_check); 3 external calls (new, assert_eq!, default).


##### `tests::compare_npm_package_roots_detects_match`  (lines 3160–3169)

```
fn compare_npm_package_roots_detects_match()
```

**Purpose**: Checks that matching running and npm package roots are classified as `Match`.

**Data flow**: Builds representative running and npm root paths, calls `compare_npm_package_roots`, and asserts the exact `NpmRootCheck::Match` result.

**Call relations**: Direct unit test for npm root comparison logic.

*Call graph*: 2 external calls (from, assert_eq!).


##### `tests::compare_npm_package_roots_detects_mismatch`  (lines 3172–3182)

```
fn compare_npm_package_roots_detects_mismatch()
```

**Purpose**: Checks that differing running and npm package roots are classified as `Mismatch`.

**Data flow**: Builds mismatched paths, calls `compare_npm_package_roots`, and asserts the exact mismatch payload.

**Call relations**: Direct unit test for npm root comparison logic.

*Call graph*: 2 external calls (from, assert_eq!).


##### `tests::startup_warning_counts_group_known_sources`  (lines 3185–3207)

```
fn startup_warning_counts_group_known_sources()
```

**Purpose**: Verifies grouped startup-warning counting by keyword categories.

**Data flow**: Creates representative warning strings, passes them to `push_startup_warning_counts`, and asserts the resulting detail lines.

**Call relations**: Tests the categorization logic used by `config_check`.

*Call graph*: calls 1 internal fn (push_startup_warning_counts); 3 external calls (new, assert_eq!, vec!).


##### `tests::config_overrides_from_interactive_preserves_global_options`  (lines 3210–3254)

```
fn config_overrides_from_interactive_preserves_global_options()
```

**Purpose**: Verifies that interactive CLI flags are translated into `ConfigOverrides` correctly.

**Data flow**: Parses a synthetic `TuiCli`, builds `Arg0DispatchPaths`, calls `config_overrides_from_interactive`, and asserts model, provider, cwd, approval, sandbox, writable roots, raw reasoning, and helper executable fields.

**Call relations**: Direct unit test for interactive override translation.

*Call graph*: calls 1 internal fn (config_overrides_from_interactive); 3 external calls (from, parse_from, assert_eq!).


##### `tests::redacted_json_report_structures_and_sanitizes_details`  (lines 3257–3360)

```
fn redacted_json_report_structures_and_sanitizes_details()
```

**Purpose**: Verifies that JSON report generation both restructures details into keyed fields and redacts secrets, credentials, and sensitive URL components.

**Data flow**: Builds a synthetic `DoctorReport` with sensitive detail strings and issue/remediation text, calls `redacted_json_report`, serializes it, and asserts that secrets are absent while sanitized URLs, `set` markers, duplicate arrays, notes, and redacted fields are present.

**Call relations**: Tests the combined behavior of `redacted_json_report`, `structured_json_details`, `json_detail_value`, and `redacted_json_issue`.

*Call graph*: calls 1 internal fn (redacted_json_report); 5 external calls (assert!, assert_eq!, to_string, to_value, vec!).


##### `tests::mcp_check_ignores_disabled_servers`  (lines 3363–3392)

```
async fn mcp_check_ignores_disabled_servers()
```

**Purpose**: Verifies that disabled MCP servers do not trigger missing-env or reachability failures even when marked required.

**Data flow**: Deserializes a disabled MCP server config, runs `mcp_check_from_servers`, and asserts ok status plus absence of token and reachability failure details.

**Call relations**: Tests the disabled-server short-circuit in MCP validation.

*Call graph*: calls 1 internal fn (mcp_check_from_servers); 4 external calls (from, assert!, assert_eq!, from_str).


##### `tests::mcp_check_warns_for_optional_http_reachability`  (lines 3395–3414)

```
async fn mcp_check_warns_for_optional_http_reachability()
```

**Purpose**: Verifies that an unreachable optional HTTP MCP server produces only a warning.

**Data flow**: Deserializes an optional HTTP MCP server pointing at an unroutable local port, runs `mcp_check_from_servers`, and asserts warning status and an `optional reachability failed` detail.

**Call relations**: Tests optional-vs-required MCP reachability handling.

*Call graph*: calls 1 internal fn (mcp_check_from_servers); 4 external calls (from, assert!, assert_eq!, from_str).


##### `tests::mcp_check_fails_required_remote_stdio_env_var`  (lines 3417–3442)

```
async fn mcp_check_fails_required_remote_stdio_env_var()
```

**Purpose**: Verifies that a required stdio MCP server using a `remote` env-var source fails local consistency checks.

**Data flow**: Builds a required stdio MCP config whose `env_vars` entry uses source `remote`, runs `mcp_check_from_servers`, and asserts fail status plus the explanatory detail.

**Call relations**: Tests the explicit rejection of remote-only env-var sources for local stdio MCP.

*Call graph*: calls 1 internal fn (mcp_check_from_servers); 7 external calls (from, assert!, assert_eq!, format!, current_exe, String, from_str).


##### `tests::provider_specific_auth_allows_non_openai_provider_without_env_key`  (lines 3445–3460)

```
fn provider_specific_auth_allows_non_openai_provider_without_env_key()
```

**Purpose**: Verifies that non-OpenAI providers without a required env key are treated as authenticated enough.

**Data flow**: Calls `provider_specific_auth_check` with `requires_openai_auth = false` and no provider env key, unwraps the returned check, and asserts ok status and summary.

**Call relations**: Direct unit test for the permissive branch of provider-specific auth handling.

*Call graph*: calls 1 internal fn (provider_specific_auth_check); 2 external calls (new, assert_eq!).


##### `tests::provider_specific_auth_fails_when_provider_env_key_is_missing`  (lines 3463–3482)

```
fn provider_specific_auth_fails_when_provider_env_key_is_missing()
```

**Purpose**: Verifies that non-OpenAI providers with a required env key fail when that env var is absent.

**Data flow**: Calls `provider_specific_auth_check` with a missing provider env key and explicit instructions, unwraps the returned check, and asserts fail status, summary, and remediation.

**Call relations**: Direct unit test for the failing branch of provider-specific auth handling.

*Call graph*: calls 1 internal fn (provider_specific_auth_check); 2 external calls (new, assert_eq!).


##### `tests::stored_auth_validation_rejects_missing_api_key`  (lines 3485–3501)

```
fn stored_auth_validation_rejects_missing_api_key()
```

**Purpose**: Verifies that API-key auth without a stored or env-provided key is flagged as incomplete.

**Data flow**: Constructs an `AuthDotJson` in API-key mode with no key, calls `stored_auth_issues` with env predicates that first return false then true for `OPENAI_API_KEY`, and asserts issue presence/absence accordingly.

**Call relations**: Tests API-key validation logic in `stored_auth_issues`.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::stored_auth_validation_rejects_missing_chatgpt_tokens`  (lines 3504–3522)

```
fn stored_auth_validation_rejects_missing_chatgpt_tokens()
```

**Purpose**: Verifies that default ChatGPT auth without token data and refresh metadata yields both expected issues.

**Data flow**: Constructs an empty `AuthDotJson`, calls `stored_auth_issues`, and asserts the exact issue list.

**Call relations**: Tests ChatGPT-mode validation in `stored_auth_issues`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::stored_auth_validation_handles_personal_access_token`  (lines 3525–3545)

```
fn stored_auth_validation_handles_personal_access_token()
```

**Purpose**: Verifies both successful and failing validation paths for personal access token auth.

**Data flow**: Constructs an auth object with a PAT and asserts `stored_auth_mode` plus no issues, then switches to explicit PAT mode with the token removed and asserts the missing-token issue.

**Call relations**: Tests PAT inference and validation logic.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::provider_reachability_mode_uses_api_key_auth`  (lines 3548–3575)

```
fn provider_reachability_mode_uses_api_key_auth()
```

**Purpose**: Verifies that provider reachability mode selects API-key probing when API-key auth is stored or present in env.

**Data flow**: Constructs stored API-key auth and separately an env predicate exposing `OPENAI_API_KEY`, calls `provider_auth_reachability_mode_from_auth` in both cases, and asserts `ApiKey`.

**Call relations**: Tests auth-signal precedence for reachability planning.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::provider_reachability_uses_active_provider_endpoint`  (lines 3578–3599)

```
fn provider_reachability_uses_active_provider_endpoint()
```

**Purpose**: Verifies that non-OpenAI provider reachability plans probe the configured provider endpoint rather than ChatGPT.

**Data flow**: Calls `provider_reachability_plan_from_parts` with Azure-like provider metadata and asserts the exact `ReachabilityPlan` contents.

**Call relations**: Tests endpoint selection in reachability planning.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::provider_reachability_adds_models_route_probe_for_openai_compatible_base_urls`  (lines 3602–3627)

```
fn provider_reachability_adds_models_route_probe_for_openai_compatible_base_urls()
```

**Purpose**: Verifies that OpenAI-compatible custom base URLs get an additional `/models` route probe with query params preserved.

**Data flow**: Builds query params, calls `provider_reachability_plan_from_parts`, and asserts the generated `route_probe_url`.

**Call relations**: Tests route-probe URL construction logic.

*Call graph*: 2 external calls (from, assert_eq!).


##### `tests::provider_reachability_skips_route_probe_for_bedrock`  (lines 3630–3642)

```
fn provider_reachability_skips_route_probe_for_bedrock()
```

**Purpose**: Verifies that Bedrock endpoints do not get `/models` route probes.

**Data flow**: Builds a Bedrock-like plan and asserts that the first endpoint’s `route_probe_url` is `None`.

**Call relations**: Tests `should_probe_models_route` behavior through plan construction.

*Call graph*: calls 1 internal fn (provider_reachability_plan_from_parts); 1 external calls (assert_eq!).


##### `tests::provider_reachability_api_key_does_not_require_chatgpt`  (lines 3645–3665)

```
fn provider_reachability_api_key_does_not_require_chatgpt()
```

**Purpose**: Verifies that API-key reachability mode probes only the API endpoint and not ChatGPT.

**Data flow**: Builds a plan in `ApiKey` mode with no explicit base URL and asserts the exact endpoint list targeting `https://api.openai.com/v1` plus `/models` route probe.

**Call relations**: Tests API-key-mode plan construction.

*Call graph*: calls 1 internal fn (provider_reachability_plan_from_parts); 1 external calls (assert_eq!).


##### `tests::provider_reachability_outcome_reports_required_failures`  (lines 3668–3683)

```
fn provider_reachability_outcome_reports_required_failures()
```

**Purpose**: Verifies the mapping from required-failure/warning counts to final reachability status and summary.

**Data flow**: Calls `provider_reachability_outcome` with warning-only and required-failure cases and asserts the returned tuples.

**Call relations**: Direct unit test for reachability outcome classification.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::provider_reachability_route_404_fails_bad_base_url_path`  (lines 3686–3724)

```
async fn provider_reachability_route_404_fails_bad_base_url_path()
```

**Purpose**: Verifies that a reachable base URL whose `/models` route returns 404 is treated as a failing required route-probe issue.

**Data flow**: Starts a local TCP listener that returns 404 twice, builds an API-key reachability plan pointing at a bad `/xxxx` base path, awaits `provider_reachability_check`, joins the server thread, and asserts fail status, route-probe detail, and remediation-bearing issue.

**Call relations**: Integration-style test for `provider_reachability_check` and `provider_route_probe_url`.

*Call graph*: calls 2 internal fn (provider_reachability_check, provider_reachability_plan_from_parts); 5 external calls (bind, assert!, assert_eq!, format!, spawn).


##### `tests::provider_reachability_route_401_keeps_reachability_ok`  (lines 3727–3760)

```
async fn provider_reachability_route_401_keeps_reachability_ok()
```

**Purpose**: Verifies that a `/models` route returning 401 still counts as an acceptable reachable route.

**Data flow**: Starts a local listener that returns 404 for the base HEAD probe and 401 for the route GET probe, builds a plan, runs `provider_reachability_check`, and asserts overall ok status plus a `route exists (HTTP 401)` detail.

**Call relations**: Tests the special-case acceptance of 401/403 in route probing.

*Call graph*: calls 2 internal fn (provider_reachability_check, provider_reachability_plan_from_parts); 5 external calls (bind, assert!, assert_eq!, format!, spawn).


##### `tests::collect_rollout_stats_counts_nested_rollout_files`  (lines 3763–3785)

```
fn collect_rollout_stats_counts_nested_rollout_files()
```

**Purpose**: Verifies recursive rollout scanning counts only matching `rollout-*.jsonl` files in nested directories.

**Data flow**: Creates a temp directory tree with one rollout file and one ignored JSONL file, calls `collect_rollout_stats`, and asserts file count, total bytes, average bytes, and absence of errors.

**Call relations**: Direct unit test for rollout scanning.

*Call graph*: calls 1 internal fn (collect_rollout_stats); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `tests::http_probe_treats_http_status_as_reachable`  (lines 3788–3806)

```
async fn http_probe_treats_http_status_as_reachable()
```

**Purpose**: Verifies that transport reachability probes treat non-2xx HTTP responses as successful transport-level reachability.

**Data flow**: Runs a local listener that returns HTTP 405, calls `http_probe_url`, joins the server thread, and asserts `Ok("HTTP 405")`.

**Call relations**: Tests the semantics of `http_probe_url_with_timeout` as a transport probe rather than an application-success probe.

*Call graph*: calls 1 internal fn (http_probe_url); 4 external calls (bind, assert_eq!, format!, spawn).


##### `tests::mcp_http_probe_falls_back_to_get_when_head_times_out`  (lines 3809–3839)

```
async fn mcp_http_probe_falls_back_to_get_when_head_times_out()
```

**Purpose**: Verifies that MCP HTTP probing falls back from a timed-out HEAD request to a successful GET request.

**Data flow**: Runs a local listener that stalls the first connection and returns 405 on the second, calls `mcp_http_probe_url_with_timeout` with a short timeout, joins the server thread, and asserts `Ok("HTTP 405")`.

**Call relations**: Tests the HEAD-then-GET fallback behavior used for MCP HTTP endpoints.

*Call graph*: calls 1 internal fn (mcp_http_probe_url_with_timeout); 5 external calls (from_millis, bind, assert_eq!, format!, spawn).


##### `tests::mcp_check_fails_required_missing_stdio_command`  (lines 3842–3864)

```
async fn mcp_check_fails_required_missing_stdio_command()
```

**Purpose**: Verifies that a required stdio MCP server with an unresolvable command fails the MCP check.

**Data flow**: Deserializes a required stdio MCP config with a definitely missing command, runs `mcp_check_from_servers`, and asserts fail status, summary, and the command-resolution detail.

**Call relations**: Tests required stdio command validation in MCP checking.

*Call graph*: calls 1 internal fn (mcp_check_from_servers); 4 external calls (from, assert!, assert_eq!, from_str).


##### `tests::read_probe_file_rejects_unreadable_file`  (lines 3868–3887)

```
fn read_probe_file_rejects_unreadable_file()
```

**Purpose**: Verifies on Unix that `read_probe_file` surfaces unreadable-file errors.

**Data flow**: Creates a temp file, removes read permissions, calls `read_probe_file`, restores permissions, and asserts the result is an error.

**Call relations**: Direct unit test for file-read probing.

*Call graph*: calls 1 internal fn (read_probe_file); 5 external calls (assert!, metadata, set_permissions, write, new).


##### `tests::executable_path_exists_rejects_non_executable_file`  (lines 3891–3911)

```
fn executable_path_exists_rejects_non_executable_file()
```

**Purpose**: Verifies on Unix that executable-path validation rejects non-executable files and accepts them once execute bits are restored.

**Data flow**: Creates a temp file, removes execute permissions, calls `executable_path_exists` and asserts error, then restores execute bits and asserts success.

**Call relations**: Direct unit test for Unix executable permission checking.

*Call graph*: calls 1 internal fn (executable_path_exists); 6 external calls (assert!, assert_eq!, metadata, set_permissions, write, new).


##### `tests::should_enable_color_respects_terminal_inputs`  (lines 3914–3950)

```
fn should_enable_color_respects_terminal_inputs()
```

**Purpose**: Verifies the color-enable decision across no-color flag, NO_COLOR env, dumb TERM, and non-tty stdout cases.

**Data flow**: Calls `should_enable_color` with several combinations and asserts true only for the fully enabled case.

**Call relations**: Direct unit test for the shared color-decision helper.

*Call graph*: 1 external calls (assert!).


##### `tests::terminal_inputs`  (lines 3952–3972)

```
fn terminal_inputs() -> TerminalCheckInputs
```

**Purpose**: Builds a baseline synthetic `TerminalCheckInputs` fixture for terminal-check tests.

**Data flow**: Returns a `TerminalCheckInputs` struct with an unknown xterm-like terminal, TERM env set, tty booleans true, color support true, size 120x40, and no tmux or Windows-console details.

**Call relations**: Used by multiple terminal-check tests as a starting point.

*Call graph*: 3 external calls (from, from, new).


##### `tests::set_terminal_env`  (lines 3974–3981)

```
fn set_terminal_env(inputs: &mut TerminalCheckInputs, name: &str, value: &str)
```

**Purpose**: Mutates a synthetic terminal-input fixture to mark an env var present and optionally assign a value.

**Data flow**: Inserts the env name into `present_env`; if `value` is empty it removes the key from `env`, otherwise it inserts the provided string value.

**Call relations**: Used by terminal-check tests to simulate env presence-only and value-bearing variables.


##### `tests::terminal_check_warns_for_dumb_terminal`  (lines 3984–4002)

```
fn terminal_check_warns_for_dumb_terminal()
```

**Purpose**: Verifies that `TERM=dumb` produces a failing terminal issue with the expected remediation.

**Data flow**: Starts from `terminal_inputs`, changes terminal name and TERM to `dumb`, runs `terminal_check_from_inputs`, and asserts fail status, summary, issue count, and remedy.

**Call relations**: Tests the dumb-terminal branch of terminal diagnostics.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 3 external calls (assert_eq!, set_terminal_env, terminal_inputs).


##### `tests::terminal_check_warns_for_narrow_terminal`  (lines 4005–4021)

```
fn terminal_check_warns_for_narrow_terminal()
```

**Purpose**: Verifies that a detected width below 80 columns produces a warning issue.

**Data flow**: Starts from `terminal_inputs`, sets `terminal_size` to `79x24`, runs `terminal_check_from_inputs`, and asserts warning status, summary, expected value, and remedy.

**Call relations**: Tests size-based warning generation from actual terminal dimensions.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 2 external calls (assert_eq!, terminal_inputs).


##### `tests::terminal_check_warns_for_declared_narrow_terminal`  (lines 4024–4037)

```
fn terminal_check_warns_for_declared_narrow_terminal()
```

**Purpose**: Verifies that a narrow `COLUMNS` env declaration also produces a warning issue and detail line.

**Data flow**: Starts from `terminal_inputs`, sets `COLUMNS=60`, runs `terminal_check_from_inputs`, and asserts warning status, summary, presence of the detail line, and issue field metadata.

**Call relations**: Tests env-declared dimension warnings in `terminal_size_issues`.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 4 external calls (assert!, assert_eq!, set_terminal_env, terminal_inputs).


##### `tests::terminal_check_warns_for_non_utf8_locale`  (lines 4040–4056)

```
fn terminal_check_warns_for_non_utf8_locale()
```

**Purpose**: Verifies that a non-UTF-8 locale produces a warning with the expected remediation.

**Data flow**: Starts from `terminal_inputs`, sets `LANG=C`, runs `terminal_check_from_inputs`, and asserts warning status, summary, locale detail, and remedy.

**Call relations**: Tests locale evaluation in terminal diagnostics.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 4 external calls (assert!, assert_eq!, set_terminal_env, terminal_inputs).


##### `tests::terminal_check_warns_for_unreadable_terminfo_path`  (lines 4059–4082)

```
fn terminal_check_warns_for_unreadable_terminfo_path()
```

**Purpose**: Verifies that a missing TERMINFO path produces a failing terminal issue.

**Data flow**: Creates a temp directory, points `TERMINFO` at a missing child path, runs `terminal_check_from_inputs`, and asserts fail status, summary, matching detail text, and remedy.

**Call relations**: Tests terminfo path readiness handling.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 5 external calls (assert!, assert_eq!, set_terminal_env, terminal_inputs, tempdir).


##### `tests::terminal_check_reports_remote_indicators_as_present_only`  (lines 4085–4102)

```
fn terminal_check_reports_remote_indicators_as_present_only()
```

**Purpose**: Verifies that remote-terminal env vars are reported only as present, not with their potentially sensitive values.

**Data flow**: Starts from `terminal_inputs`, sets `SSH_CONNECTION` to a concrete value, runs `terminal_check_from_inputs`, and asserts the detail contains `SSH_CONNECTION: present` but not the IP address.

**Call relations**: Tests the privacy-preserving use of `push_presence_env_values`.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 3 external calls (assert!, set_terminal_env, terminal_inputs).


##### `tests::terminal_check_includes_windows_console_details`  (lines 4105–4118)

```
fn terminal_check_includes_windows_console_details()
```

**Purpose**: Verifies that precomputed Windows console details are preserved in terminal-check output.

**Data flow**: Starts from `terminal_inputs`, appends a synthetic console-mode detail, runs `terminal_check_from_inputs`, and asserts the detail is present.

**Call relations**: Tests passthrough of Windows-specific terminal metadata.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 2 external calls (assert!, terminal_inputs).


##### `tests::terminal_check_keeps_tmux_probe_failures_non_fatal`  (lines 4121–4129)

```
fn terminal_check_keeps_tmux_probe_failures_non_fatal()
```

**Purpose**: Verifies that merely being in tmux without successful tmux probe details does not itself create a warning.

**Data flow**: Starts from `terminal_inputs`, sets the multiplexer to tmux with no version, runs `terminal_check_from_inputs`, and asserts overall ok status and generic summary.

**Call relations**: Tests that tmux diagnostics are additive and non-fatal.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 2 external calls (assert_eq!, terminal_inputs).


##### `tests::color_output_summary_reports_disabled_reasons`  (lines 4132–4152)

```
fn color_output_summary_reports_disabled_reasons()
```

**Purpose**: Verifies the specific disabled-reason strings returned by `color_output_summary`.

**Data flow**: Mutates synthetic terminal inputs across `--no-color`, `NO_COLOR`, `TERM=dumb`, and non-tty stdout cases, calls `color_output_summary`, and asserts the exact strings.

**Call relations**: Tests the explanatory branches in color-output summarization.

*Call graph*: 3 external calls (assert_eq!, set_terminal_env, terminal_inputs).


### `tui/src/session_archive_commands.rs`

`orchestration` · `CLI command handling`

This module is the common implementation behind three session-management CLI commands. Its public API accepts a `SessionArchiveAction`, a user-provided target string, and launch options containing the parsed CLI, arg0 dispatch paths, and an optional explicit remote endpoint. The command flow is intentionally thin: start an `AppServerSession`, resolve the target to a concrete `ThreadId` plus optional session name, invoke the matching app-server RPC, and return a human-readable success or cancellation message.

Target resolution supports two forms. If the input parses as a `ThreadId`, it is accepted directly; for prompted deletes, the code additionally reads the thread to recover its name for confirmation text. Otherwise the module searches by exact session name. Name lookup is scoped by action: archive searches active sessions, unarchive searches archived sessions, and delete searches both. The lookup uses `thread_list` pagination in updated-at order, trying a fast path with `search_term = Some(name)` and then a full scan with `search_term = None` because some stores apply renamed titles after filtering.

Deletion confirmation is deliberately strict: it requires both stdin and stderr to be terminals, prints a warning that deletion is permanent and also removes subagent threads, and accepts only `y` or `yes` case-insensitively. The app-server startup path is the largest part of the file. It reconstructs enough of normal CLI startup to resolve config/profile overrides, decide whether an implicit local daemon can be reused, compute remote-workspace cwd behavior, initialize runtime paths and environment manager, load bootstrap and full config (including cloud config bundle and OSS provider/model defaults), initialize state DB, start the app server, and finally wrap it in `AppServerSession` with any remote cwd override attached.

#### Function details

##### `success_message`  (lines 57–71)

```
fn success_message(
    action: SessionArchiveAction,
    session_id: ThreadId,
    session_name: Option<&str>,
) -> String
```

**Purpose**: Formats the final user-facing success string for archive, delete, or unarchive operations.

**Data flow**: Matches the `SessionArchiveAction` to choose `Archived`, `Deleted`, or `Unarchived`, then formats either `{action} session {name} ({id}).` when a name is available or `{action} session {id}.` otherwise.

**Call relations**: Called after the RPC succeeds so all three commands share consistent output wording.

*Call graph*: called by 1 (run_session_archive_action_with_app_server); 1 external calls (format!).


##### `run_session_archive_command`  (lines 78–85)

```
async fn run_session_archive_command(
    action: SessionArchiveAction,
    target: String,
    options: SessionArchiveCommandOptions,
) -> Result<String>
```

**Purpose**: Top-level entrypoint that starts an app-server session and runs the requested archive/delete/unarchive action.

**Data flow**: Consumes the action, target string, and command options; awaits `start_app_server_for_archive_command`, then passes the resulting mutable `AppServerSession`, action, and target string to `run_session_archive_action_with_app_server`, returning its `Result<String>`.

**Call relations**: CLI command handlers call this as the single shared implementation entrypoint.

*Call graph*: calls 2 internal fn (run_session_archive_action_with_app_server, start_app_server_for_archive_command).


##### `run_session_archive_action_with_app_server`  (lines 87–117)

```
async fn run_session_archive_action_with_app_server(
    app_server: &mut AppServerSession,
    action: SessionArchiveAction,
    target: &str,
) -> Result<String>
```

**Purpose**: Resolves the target session and performs the corresponding app-server mutation, including optional delete confirmation.

**Data flow**: Takes a mutable app-server session, action, and target string; awaits `resolve_session_target`; then for archive calls `thread_archive`, for delete optionally calls `confirm_session_delete` and either returns `Delete cancelled.` or calls `thread_delete`, and for unarchive calls `thread_unarchive` and prefers the returned thread name over the previously resolved one. It then formats and returns the success message.

**Call relations**: This is the action executor used after startup; it delegates target resolution and confirmation before issuing the final RPC.

*Call graph*: calls 6 internal fn (thread_archive, thread_delete, thread_unarchive, confirm_session_delete, resolve_session_target, success_message); called by 1 (run_session_archive_command); 1 external calls (matches!).


##### `resolve_session_target`  (lines 119–159)

```
async fn resolve_session_target(
    app_server: &mut AppServerSession,
    action: SessionArchiveAction,
    target: &str,
) -> Result<ResolvedSessionTarget>
```

**Purpose**: Turns a user-supplied UUID or exact session name into a concrete session ID and optional name.

**Data flow**: First tries `ThreadId::from_string(target)`. If that succeeds and the action is prompted delete, it reads the thread via `thread_read(..., false)` to recover the name and wraps missing-thread errors with a target-specific message; otherwise it returns the parsed ID with no name. If parsing fails, it chooses a search scope and archived-state list based on the action, iterates those archived values, calls `lookup_session_by_exact_name`, and converts the first matching thread with `session_target_from_app_server_thread`. If nothing matches, it returns an eyre error naming the search scope and target.

**Call relations**: Called before any archive/delete/unarchive RPC so later steps always operate on a validated `ThreadId`.

*Call graph*: calls 4 internal fn (from_string, thread_read, lookup_session_by_exact_name, session_target_from_app_server_thread); called by 1 (run_session_archive_action_with_app_server); 2 external calls (eyre!, matches!).


##### `lookup_session_by_exact_name`  (lines 161–203)

```
async fn lookup_session_by_exact_name(
    app_server: &mut AppServerSession,
    name: &str,
    archived: bool,
) -> Result<Option<AppServerThread>>
```

**Purpose**: Searches paginated app-server thread listings for a thread whose `name` exactly matches the requested string.

**Data flow**: Accepts mutable app-server session, target name, and archived flag. It performs up to two scans: first with `search_term = Some(name)` as a fast path, then with `search_term = None` to catch stores where renamed titles are attached after filtering. Each scan paginates with `cursor`, `limit = 100`, `sort_key = UpdatedAt`, active source kinds, and the requested archived state, returning `Ok(Some(thread))` on the first exact `thread.name == Some(name)` match or `Ok(None)` after exhausting pages.

**Call relations**: Name-based target resolution delegates here for each archived-state bucket relevant to the action.

*Call graph*: calls 1 internal fn (thread_list); called by 1 (resolve_session_target); 1 external calls (resume_source_kinds).


##### `session_target_from_app_server_thread`  (lines 205–212)

```
fn session_target_from_app_server_thread(thread: AppServerThread) -> Result<ResolvedSessionTarget>
```

**Purpose**: Converts an app-server thread record into the internal resolved-target struct while validating the thread ID.

**Data flow**: Parses `thread.id` into `ThreadId`, wrapping parse failures with an error that includes the invalid ID string, then returns `ResolvedSessionTarget { session_id, session_name: thread.name }`.

**Call relations**: Used only after exact-name lookup succeeds.

*Call graph*: calls 1 internal fn (from_string); called by 1 (resolve_session_target).


##### `confirm_session_delete`  (lines 214–241)

```
fn confirm_session_delete(target: &ResolvedSessionTarget) -> Result<bool>
```

**Purpose**: Prompts the user to confirm permanent deletion of a session and its subagent threads.

**Data flow**: Checks that both stdin and stderr are terminals; if not, returns an error instructing the user to rerun with `--force` and a UUID. Otherwise it locks stderr, prints a prompt including the session name when available, prints an irreversible-action warning, flushes, reads one line from stdin, trims it, and returns `true` only for `y` or `yes` ignoring ASCII case.

**Call relations**: Delete execution calls this only for `DeleteConfirmation::Prompt`; a negative answer short-circuits the command with `Delete cancelled.`.

*Call graph*: called by 1 (run_session_archive_action_with_app_server); 6 external calls (new, eyre!, stderr, stdin, write!, writeln!).


##### `start_app_server_for_archive_command`  (lines 243–397)

```
async fn start_app_server_for_archive_command(
    options: SessionArchiveCommandOptions,
) -> Result<AppServerSession>
```

**Purpose**: Reconstructs enough of normal CLI startup to launch or connect to an app server suitable for archive/delete/unarchive commands.

**Data flow**: Consumes `SessionArchiveCommandOptions`, parses CLI `-c` overrides, finds `codex_home`, applies profile-v2 loader overrides, decides whether an implicit local daemon can be reused, probes the default daemon socket when appropriate, computes the app-server target and any remote cwd override, resolves local runtime paths, initializes `EnvironmentManager`, computes config cwd for the target, loads bootstrap config with layer stack, builds a cloud config bundle loader, resolves OSS provider/model defaults, builds the full `Config` with CLI and harness overrides, initializes the state DB for the chosen target, starts the app server, and wraps it in `AppServerSession::new(...).with_remote_cwd_override(...)`.

**Call relations**: This startup helper is called only by `run_session_archive_command`, but it encapsulates all environment/config/bootstrap orchestration needed before any archive action can run.

*Call graph*: calls 8 internal fn (default, load_config_toml_with_layer_stack, resolve_oss_provider, resolve_profile_v2_config_path, from_env, from_optional_paths, new, new); called by 1 (run_session_archive_command); 12 external calls (default, cloud_config_bundle_loader_for_storage, find_codex_home, default, default, resolve_bootstrap_auth_keyring_backend_kind, app_server_target_for_launch, can_reuse_implicit_local_daemon, config_cwd_for_app_server_target, init_state_db_for_app_server_target (+2 more)).


### Patch and MCP utilities
These standalone command handlers apply remote task diffs and manage MCP server configuration and authentication.

### `chatgpt/src/apply_command.rs`

`orchestration` · `CLI command handling`

This file contains the end-user `apply` command flow. `ApplyCommand` is a `clap::Parser` struct with the target `task_id` and flattened CLI config overrides. `run_apply_command` is the orchestration layer: it parses override flags, loads a `codex_core::config::Config` asynchronously, fetches the task payload from the ChatGPT backend via `get_task`, and then hands the typed response to `apply_diff_from_task`.

`apply_diff_from_task` contains the task-specific extraction logic. It requires `current_diff_task_turn` to exist and then scans that turn’s `output_items` for the first `OutputItem::Pr`, extracting its nested `output_diff`. If either the diff turn or PR output item is missing, it returns an `anyhow::bail!` error with a concrete message rather than silently doing nothing.

The actual patch application happens in the private `apply_diff` helper. It chooses a working directory from the explicit `cwd` argument, otherwise the current directory, and finally falls back to the system temp directory if `current_dir()` fails. It builds an `ApplyGitRequest` with `revert` and `preflight` both set to `false`, invokes `apply_git_patch`, and inspects the returned exit code. Non-zero exit codes are converted into a detailed error that includes counts of applied, skipped, and conflicted paths plus captured stdout/stderr. Success prints a confirmation line.

#### Function details

##### `run_apply_command`  (lines 22–36)

```
async fn run_apply_command(
    apply_cli: ApplyCommand,
    cwd: Option<PathBuf>,
) -> anyhow::Result<()>
```

**Purpose**: Runs the full `apply` CLI command from parsed arguments through to patch application. It is the async command entry used by the CLI layer.

**Data flow**: It takes `ApplyCommand` and an optional working directory. It parses CLI config overrides from `apply_cli.config_overrides`, loads a `Config` with those overrides, fetches the task via `get_task(&config, apply_cli.task_id)`, and passes the resulting `GetTaskResponse` plus `cwd` into `apply_diff_from_task`. It returns the final `anyhow::Result<()>` from that pipeline.

**Call relations**: Called by `cli_main` when the user invokes the apply subcommand. It delegates backend retrieval to `get_task` and task-specific extraction/application to `apply_diff_from_task`.

*Call graph*: calls 2 internal fn (apply_diff_from_task, get_task); called by 1 (cli_main); 1 external calls (load_with_cli_overrides).


##### `apply_diff_from_task`  (lines 38–54)

```
async fn apply_diff_from_task(
    task_response: GetTaskResponse,
    cwd: Option<PathBuf>,
) -> anyhow::Result<()>
```

**Purpose**: Extracts the latest PR diff from a fetched task response and applies it. It enforces that the task contains a current diff turn and a PR output item.

**Data flow**: It takes a `GetTaskResponse` and optional `cwd`. It matches `task_response.current_diff_task_turn`, returning an error if absent. It then iterates `diff_turn.output_items`, finds the first `OutputItem::Pr(PrOutputItem { output_diff })`, and either calls `apply_diff(&output_diff.diff, cwd).await` or returns `bail!("No PR output item found")` if none exists.

**Call relations**: Invoked by `run_apply_command` in normal CLI flow and by tests covering successful application and merge-conflict behavior. It delegates the actual Git patch execution to `apply_diff`.

*Call graph*: calls 1 internal fn (apply_diff); called by 3 (run_apply_command, test_apply_command_creates_fibonacci_file, test_apply_command_with_merge_conflicts); 1 external calls (bail!).


##### `apply_diff`  (lines 56–77)

```
async fn apply_diff(diff: &str, cwd: Option<PathBuf>) -> anyhow::Result<()>
```

**Purpose**: Applies a unified diff string to a Git working tree using the shared git-utils patching helper. It translates patch-tool results into user-facing success or detailed failure output.

**Data flow**: It takes a diff string and optional `cwd`. It resolves the working directory by preferring the provided path, otherwise `current_dir()`, otherwise `temp_dir()`. It constructs `ApplyGitRequest { cwd, diff: diff.to_string(), revert: false, preflight: false }`, calls `apply_git_patch(&req)`, and inspects the returned result. If `exit_code != 0`, it returns an error containing applied/skipped/conflicted counts and stdout/stderr; otherwise it prints `Successfully applied diff` and returns `Ok(())`.

**Call relations**: This private helper is called only by `apply_diff_from_task`. It is the final step in the command flow, delegating patch mechanics to `codex_git_utils::apply_git_patch`.

*Call graph*: called by 1 (apply_diff_from_task); 4 external calls (bail!, apply_git_patch, println!, current_dir).


### `cli/src/mcp_cmd.rs`

`orchestration` · `on demand during `codex mcp ...` command handling`

This file defines the full MCP management command surface. `McpCli` carries raw config overrides and a `McpSubcommand`; `run` optionally validates profile-v2 migration by forcing a config load with `LoaderOverrides`, then dispatches to list/get/add/remove/login/logout handlers. The add path supports two mutually exclusive transport families through `AddMcpTransportArgs`: stdio launchers with optional `KEY=VALUE` environment pairs, and streamable HTTP servers with optional bearer-token env vars and OAuth client/resource metadata. It validates server names, loads the current global MCP server map from `CODEX_HOME`, inserts or removes entries, and persists the updated map through `ConfigEditsBuilder`.

OAuth handling is a notable design point. Both add and login use `perform_oauth_login_retry_without_scopes`, which first attempts login with resolved scopes and retries once with an empty scope list if the provider rejects discovered scopes. Login resolves the target server from the effective configured server set, requires a streamable HTTP transport, optionally discovers supported scopes when neither explicit nor configured scopes exist, and then launches the OAuth flow using config-controlled credential storage and callback settings. Logout resolves the same server and deletes stored OAuth tokens.

The list and get commands load full config, build an `McpManager` backed by a `PluginsManager`, and inspect configured plus effective servers. `run_list` computes auth statuses for each effective server and can emit either JSON or two separate aligned tables: one for stdio transports and one for streamable HTTP transports. `run_get` prints either JSON or a detailed human-readable dump, masking literal HTTP header values while still showing header names and env-var-backed header mappings.

#### Function details

##### `McpCli::run`  (lines 171–203)

```
async fn run(self, loader_overrides: LoaderOverrides) -> Result<()>
```

**Purpose**: Dispatches the parsed MCP subcommand and optionally validates profile-specific config loading before any command runs.

**Data flow**: Consumes `self` and `LoaderOverrides`. If `user_config_profile` is set in the loader overrides, it calls `validate_profile_v2_migration` with the raw CLI overrides. It then matches the subcommand and forwards the raw overrides plus parsed args into `run_list`, `run_get`, `run_add`, `run_remove`, `run_login`, or `run_logout`.

**Call relations**: Called from `cli_main` for `codex mcp`. It is the entrypoint for all MCP management behavior in this file.

*Call graph*: calls 7 internal fn (run_add, run_get, run_list, run_login, run_logout, run_remove, validate_profile_v2_migration).


##### `perform_oauth_login_retry_without_scopes`  (lines 210–258)

```
async fn perform_oauth_login_retry_without_scopes(
    name: &str,
    url: &str,
    store_mode: codex_config::types::OAuthCredentialsStoreMode,
    keyring_backend_kind: codex_config::types::AuthKey
```

**Purpose**: Runs MCP OAuth login with resolved scopes and retries once without scopes when the provider rejects discovered-scope requests.

**Data flow**: Takes server identity, URL, credential-store settings, optional HTTP headers, resolved scopes, optional OAuth client/resource values, and callback settings. It first calls `perform_oauth_login` with `resolved_scopes.scopes`; if that fails and `should_retry_without_scopes` says the error is compatible with the legacy empty-scope flow, it prints a retry notice and calls `perform_oauth_login` again with an empty scope slice. It returns the first success or the final error.

**Call relations**: Used by both `run_add` and `run_login` so initial OAuth setup and explicit login share the same compatibility fallback.

*Call graph*: called by 2 (run_add, run_login); 3 external calls (should_retry_without_scopes, perform_oauth_login, println!).


##### `validate_profile_v2_migration`  (lines 260–274)

```
async fn validate_profile_v2_migration(
    config_overrides: &CliConfigOverrides,
    loader_overrides: LoaderOverrides,
) -> Result<()>
```

**Purpose**: Forces a config load under the selected profile so profile-v2 migration or validation errors surface before MCP commands proceed.

**Data flow**: Parses raw CLI overrides, feeds them plus the provided `LoaderOverrides` into `ConfigBuilder`, awaits `build`, and returns success or a contextualized configuration-load error.

**Call relations**: Called only by `McpCli::run` when a profile-specific config path is active.

*Call graph*: calls 1 internal fn (parse_overrides); called by 1 (run); 1 external calls (default).


##### `run_add`  (lines 276–409)

```
async fn run_add(config_overrides: &CliConfigOverrides, add_args: AddArgs) -> Result<()>
```

**Purpose**: Adds a global MCP server definition to config, supporting either stdio launchers or streamable HTTP endpoints, and may immediately start OAuth login if the transport advertises support.

**Data flow**: Parses and validates CLI overrides by loading `Config`, destructures `AddArgs`, validates the server name, resolves `CODEX_HOME`, and loads the current global MCP server map. It converts `AddMcpTransportArgs` into a concrete `McpServerTransportConfig`: stdio extracts the first command element as the binary and the rest as args, collecting env pairs into an optional `HashMap`; streamable HTTP stores URL and optional bearer-token env var. It builds a full `McpServerConfig` with defaults, inserts it into the server map, persists the replacement via `ConfigEditsBuilder`, and prints a success line. It then probes `oauth_login_support(&transport)`: on `Supported`, it resolves scopes and launches `perform_oauth_login_retry_without_scopes`; on `Unknown`, it prints guidance to run `codex mcp login`; on `Unsupported`, it does nothing further.

**Call relations**: Invoked by `McpCli::run` for `Add`. It delegates persistence to config-edit helpers and OAuth probing/login to `codex_mcp` plus the retry helper.

*Call graph*: calls 6 internal fn (perform_oauth_login_retry_without_scopes, validate_server_name, new, find_codex_home, load_global_mcp_servers, parse_overrides); called by 1 (run); 7 external calls (new, new, load_with_cli_overrides, bail!, oauth_login_support, resolve_oauth_scopes, println!).


##### `run_remove`  (lines 411–442)

```
async fn run_remove(config_overrides: &CliConfigOverrides, remove_args: RemoveArgs) -> Result<()>
```

**Purpose**: Removes a named global MCP server definition from config if it exists.

**Data flow**: Validates raw overrides by parsing them, destructures `RemoveArgs`, validates the server name, resolves `CODEX_HOME`, loads the current global MCP server map, removes the named entry, and if removal occurred writes the updated map back with `ConfigEditsBuilder`. It prints either `Removed global MCP server ...` or `No MCP server named ... found.`

**Call relations**: Invoked by `McpCli::run` for `Remove`. It shares server-name validation with `run_add`.

*Call graph*: calls 5 internal fn (validate_server_name, new, find_codex_home, load_global_mcp_servers, parse_overrides); called by 1 (run); 1 external calls (println!).


##### `run_login`  (lines 444–497)

```
async fn run_login(config_overrides: &CliConfigOverrides, login_args: LoginArgs) -> Result<()>
```

**Purpose**: Performs OAuth login for an existing streamable HTTP MCP server, optionally using explicit scopes from the CLI.

**Data flow**: Parses overrides, loads `Config`, constructs an `McpManager` backed by a `PluginsManager`, and fetches configured servers. It looks up the named server, requires that its transport is `StreamableHttp`, derives explicit scopes from `--scopes` when present, otherwise discovers supported scopes only when neither explicit nor configured scopes exist, resolves the final scope set with `resolve_oauth_scopes`, and calls `perform_oauth_login_retry_without_scopes` using config-controlled credential-store and callback settings. On success it prints a confirmation line.

**Call relations**: Invoked by `McpCli::run` for `Login`. It reuses the same retry helper as `run_add` but operates on an already-configured server.

*Call graph*: calls 4 internal fn (perform_oauth_login_retry_without_scopes, new, new, parse_overrides); called by 1 (run); 6 external calls (new, load_with_cli_overrides, bail!, discover_supported_scopes, resolve_oauth_scopes, println!).


##### `run_logout`  (lines 499–534)

```
async fn run_logout(config_overrides: &CliConfigOverrides, logout_args: LogoutArgs) -> Result<()>
```

**Purpose**: Deletes stored OAuth credentials for an existing streamable HTTP MCP server.

**Data flow**: Parses overrides, loads `Config`, constructs an `McpManager`, fetches configured servers, resolves the named server, requires a `StreamableHttp` transport to obtain the URL, and calls `delete_oauth_tokens` with the server name, URL, and config-controlled credential-store settings. It prints whether credentials were removed, absent, or returns a wrapped deletion error.

**Call relations**: Invoked by `McpCli::run` for `Logout`. It is the inverse of `run_login`.

*Call graph*: calls 3 internal fn (new, new, parse_overrides); called by 1 (run); 6 external calls (new, anyhow!, load_with_cli_overrides, bail!, delete_oauth_tokens, println!).


##### `run_list`  (lines 536–791)

```
async fn run_list(config_overrides: &CliConfigOverrides, list_args: ListArgs) -> Result<()>
```

**Purpose**: Lists configured MCP servers, including transport details, enabled/disabled status, and computed OAuth auth status.

**Data flow**: Parses overrides, loads `Config`, constructs an `McpManager` and backing `PluginsManager`, fetches both configured servers and effective servers, sorts configured entries by name, and computes auth statuses with `compute_auth_statuses`. If `--json` is set, it maps each server into a JSON object containing name, enabled state, disabled reason, transport-specific fields, timeout values, and auth status, then prints pretty JSON. Otherwise it partitions entries into stdio and streamable HTTP rows, formats transport-specific columns (`Command`, `Args`, `Env`, `Cwd` for stdio; `Url`, `Bearer Token Env Var` for HTTP), computes column widths, and prints one or two aligned tables separated by a blank line when both transport types are present. If no servers exist, it prints a setup hint.

**Call relations**: Invoked by `McpCli::run` for `List`. It uses `format_mcp_status` for human status strings and `compute_auth_statuses` to reflect credential state.

*Call graph*: calls 4 internal fn (format_mcp_status, new, new, parse_overrides); called by 1 (run); 7 external calls (new, new, load_with_cli_overrides, compute_auth_statuses, format_env_display, println!, to_string_pretty).


##### `run_get`  (lines 793–962)

```
async fn run_get(config_overrides: &CliConfigOverrides, get_args: GetArgs) -> Result<()>
```

**Purpose**: Shows the configuration of one named MCP server in either JSON or detailed human-readable form.

**Data flow**: Parses overrides, loads `Config`, constructs an `McpManager`, fetches configured servers, and looks up the requested name. If absent it bails. In JSON mode it serializes enabled state, disabled reason, transport-specific fields, enabled/disabled tool lists, and timeout values. In human mode it first prints a disabled summary and returns early when the server is disabled; otherwise it prints the name, enabled flag, optional enabled/disabled tool lists, transport details, optional startup/tool timeouts, optional default tool approval mode, and a convenience `remove:` command. For streamable HTTP transports it masks literal header values as `*****` while showing header names, and prints env-backed headers as `Header=ENV_VAR` pairs.

**Call relations**: Invoked by `McpCli::run` for `Get`. It complements `run_list` with a single-server deep view.

*Call graph*: calls 3 internal fn (new, new, parse_overrides); called by 1 (run); 7 external calls (new, load_with_cli_overrides, bail!, format_env_display, println!, json!, to_string_pretty).


##### `parse_env_pair`  (lines 964–977)

```
fn parse_env_pair(raw: &str) -> Result<(String, String), String>
```

**Purpose**: Parses a `KEY=VALUE` string for stdio MCP server environment variables.

**Data flow**: Splits the raw string once on `=`, trims and validates the key as non-empty, preserves the value verbatim after the separator, and returns `(String, String)` or a fixed parse error string.

**Call relations**: Used as the clap value parser for `AddMcpStdioArgs.env`.


##### `validate_server_name`  (lines 979–990)

```
fn validate_server_name(name: &str) -> Result<()>
```

**Purpose**: Restricts MCP server names to non-empty ASCII alphanumeric strings plus `-` and `_`.

**Data flow**: Checks that the name is not empty and that every character is ASCII alphanumeric, hyphen, or underscore. Returns success or an error naming the invalid server.

**Call relations**: Called by both `run_add` and `run_remove` before mutating config.

*Call graph*: called by 2 (run_add, run_remove); 1 external calls (bail!).


##### `format_mcp_status`  (lines 992–1000)

```
fn format_mcp_status(config: &McpServerConfig) -> String
```

**Purpose**: Formats a configured MCP server’s enabled/disabled state for table output.

**Data flow**: Reads `McpServerConfig.enabled` and optional `disabled_reason`, returning `enabled`, `disabled`, or `disabled: <reason>`.

**Call relations**: Used by `run_list` while building human-readable stdio and HTTP rows.

*Call graph*: called by 1 (run_list); 1 external calls (format!).
