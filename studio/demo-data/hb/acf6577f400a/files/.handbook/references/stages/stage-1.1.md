# Primary user-facing launch surfaces  `stage-1.1`

This stage is the set of front doors users enter through. It sits at startup: before Codex can chat, run a task, open a desktop window, or diagnose a problem, these files read the command the user typed and route it to the right tool. The main CLI entry point chooses between the text interface, non-interactive exec mode, cloud tasks, desktop launch, sandbox tools, remote control, doctor checks, MCP server management, and session archive commands. The TUI and exec CLI files define the flags and prompts those modes accept, then their main files start the actual work and print final messages. Cloud task files connect terminal commands to cloud APIs, branch detection, task lists, diffs, and applying changes. Desktop files open or install the macOS or Windows app for the chosen workspace. Remote-control code starts or stops the app-server for outside access. Sandbox files run debug commands safely or prepare the Windows sandbox. Doctor files inspect local setup and conversation records. MCP and apply-command code connect Codex to external tools and bring agent-made code changes into the user’s checkout.

## Files in this stage

### Root CLI routing
These files define the main Codex command surface and the shared CLI types that route users into the stage's major launch paths.

### `cli/src/lib.rs`

`data_model` · `startup / command-line parsing`

This file is mostly a map of what users can type on the command line for running commands inside operating-system sandboxes. A sandbox is a restricted environment that limits what a command can read, write, or connect to, like putting a tool inside a locked workshop where only certain doors are open. The file defines three similar command structures: one for macOS Seatbelt, one for Linux Landlock, and one for Windows restricted-token sandboxing. They stay separate because each operating system has slightly different sandbox features, even though many options are shared.

Each command structure describes options such as which permissions profile to use, which configuration profile to layer on top, what working directory to run from, whether to include centrally managed configuration, and the actual command to execute. The macOS version also supports allowing specific Unix socket paths and optionally logging sandbox denials.

The file also re-exports login functions and sandbox runners from submodules, so other parts of the program can import them from one convenient place. Without this file, the CLI would not have a clear, typed description of these sandbox commands, and argument parsing would be scattered or duplicated.

#### Function details

##### `parse_allow_unix_socket_path`  (lines 69–72)

```
fn parse_allow_unix_socket_path(raw: &str) -> Result<AbsolutePathBuf, String>
```

**Purpose**: This function turns a user-provided Unix socket path into an absolute path. It is used so the sandbox receives a clear, unambiguous location instead of a path that depends on where the user happened to run the command.

**Data flow**: It receives a raw text path from the command line. It asks `AbsolutePathBuf::relative_to_current_dir` to convert that text into an absolute path, using the current directory if the user gave a relative path. If that works, it returns the absolute path; if it fails, it returns a friendly error message that includes the original path.

**Call relations**: The macOS `SeatbeltCommand` uses this function as the parser for each `--allow-unix-socket` value. During command-line parsing, Clap calls this helper to validate and normalize the path before the sandbox runner later uses the resulting allowed socket paths.

*Call graph*: calls 1 internal fn (relative_to_current_dir).


### `cli/src/main.rs`

`entrypoint` · `startup and command dispatch`

This file is like the front desk for the whole Codex CLI. A user may run plain `codex` for the interactive terminal interface, or a subcommand such as `exec`, `login`, `app-server`, `features`, `sandbox`, or `debug`. This file defines those command shapes, parses the flags, checks for combinations that do not make sense, folds shared options into the right subcommand, and then calls the crate that actually does the work. Without it, Codex would have many separate engines but no reliable way to turn a user’s command line into the correct action.

It also protects users from confusing or unsafe situations. For example, remote app-server options are only allowed for interactive terminal commands, `--force` deletion is only allowed with a real session UUID, and API-key remote registration is restricted to trusted hosts or local loopback addresses. It prints useful finish messages after the interactive app exits, can run self-update commands, writes feature flag changes into config, and includes debug utilities for inspecting models, prompt input, traces, and local memory state.

The large test section checks that command parsing and safety rules stay stable, because small changes in CLI behavior can break users’ scripts.

#### Function details

##### `SessionTuiCli::augment_args`  (lines 401–403)

```
fn augment_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: Adds the normal interactive terminal flags to session commands, but adjusts the prompt argument so it cannot be used in an ambiguous way with `--last`.

**Data flow**: It receives a command definition from the argument parser, lets the regular TUI command add its arguments, then changes the prompt argument to conflict with `last`. It returns the updated command definition.

**Call relations**: The command-line parser calls this while building the accepted arguments for resume and fork-style session commands. It delegates most of the shape to the normal TUI parser.

*Call graph*: 1 external calls (augment_args).


##### `SessionTuiCli::augment_args_for_update`  (lines 405–407)

```
fn augment_args_for_update(cmd: clap::Command) -> clap::Command
```

**Purpose**: Updates an existing parser definition for session-style TUI flags, again preventing an unclear prompt plus `--last` combination.

**Data flow**: It receives an existing command parser, applies the TUI update rules, marks the prompt as conflicting with `last`, and returns the adjusted parser.

**Call relations**: The argument parsing library uses this when it needs to update parser state. It mirrors `SessionTuiCli::augment_args` for parser-update flows.

*Call graph*: 1 external calls (augment_args_for_update).


##### `SessionTuiCli::from_arg_matches`  (lines 411–413)

```
fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error>
```

**Purpose**: Turns parsed command-line matches into a `SessionTuiCli` wrapper around the regular TUI options.

**Data flow**: It receives parsed argument matches, asks the normal TUI parser to read them, wraps the result, and returns either the wrapper or a parse error.

**Call relations**: The command-line parser calls this after parsing session commands. It hands the real reading work to the TUI CLI parser.

*Call graph*: 1 external calls (from_arg_matches).


##### `SessionTuiCli::update_from_arg_matches`  (lines 415–417)

```
fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error>
```

**Purpose**: Refreshes an existing `SessionTuiCli` value from newly parsed command-line matches.

**Data flow**: It receives parsed matches, passes them into the wrapped TUI options, and updates that inner value in place. It returns success or a parser error.

**Call relations**: The argument parser calls this in update-style parsing paths. It keeps the wrapper thin and lets the regular TUI CLI own the detailed flag reading.


##### `parse_socket_path`  (lines 697–700)

```
fn parse_socket_path(raw: &str) -> Result<AbsolutePathBuf, String>
```

**Purpose**: Converts a socket path typed by the user into an absolute path that the program can safely use.

**Data flow**: It receives raw text, resolves it relative to the current directory if needed, and returns either an absolute path object or a readable error message.

**Call relations**: Command-line options for app-server proxying and stdio-to-socket relay use this as their value parser before later code opens the socket.

*Call graph*: calls 1 internal fn (relative_to_current_dir).


##### `format_exit_messages`  (lines 702–728)

```
fn format_exit_messages(exit_info: AppExitInfo, color_enabled: bool) -> Vec<String>
```

**Purpose**: Builds the friendly lines shown after the interactive Codex app exits, such as token usage and how to resume the session.

**Data flow**: It receives exit details and whether colored output is available. It pulls out token usage, a resume hint, and fatal-session information, then returns a list of text lines to print.

**Call relations**: The exit handler calls this before printing. Several tests call it directly to make sure fatal exits, resume hints, color, and zero-token cases are shown correctly.

*Call graph*: called by 7 (handle_app_exit, format_exit_messages_applies_color_when_enabled, format_exit_messages_includes_resume_hint_for_fatal_exit, format_exit_messages_includes_resume_hint_without_color, format_exit_messages_includes_session_id_for_fatal_exit_without_resume_hint, format_exit_messages_names_picker_item_when_thread_has_name, format_exit_messages_skips_zero_usage); 3 external calls (new, format!, matches!).


##### `handle_app_exit`  (lines 731–753)

```
fn handle_app_exit(exit_info: AppExitInfo) -> anyhow::Result<()>
```

**Purpose**: Finishes an interactive Codex run by printing errors, usage, resume hints, and possibly starting an update.

**Data flow**: It receives an `AppExitInfo` result from the TUI. It prints fatal errors to standard error, prints summary lines to standard output, exits with code 1 for fatal failures, or runs a requested update action.

**Call relations**: The main dispatcher calls this after interactive, resume, and fork sessions. It uses `format_exit_messages` for the text and `run_update_action` if the TUI asked for an update.

*Call graph*: calls 2 internal fn (format_exit_messages, run_update_action); called by 1 (cli_main); 5 external calls (eprintln!, println!, stdout, exit, on).


##### `run_update_action`  (lines 756–796)

```
fn run_update_action(action: UpdateAction) -> anyhow::Result<()>
```

**Purpose**: Runs the platform-specific command that updates Codex and reports whether it worked.

**Data flow**: It receives an update action, turns it into a command and arguments, normalizes paths for Windows Subsystem for Linux when needed, runs the process, and returns success or an error if the command failed.

**Call relations**: It is called after an interactive exit requests an update and by the explicit `codex update` command. It hands off to the operating system process launcher.

*Call graph*: calls 3 internal fn (normalize_for_wsl, command_args, command_str); called by 2 (handle_app_exit, run_update_command); 3 external calls (bail!, new, println!).


##### `run_update_command`  (lines 798–815)

```
fn run_update_command() -> anyhow::Result<()>
```

**Purpose**: Implements `codex update` by choosing the right update action for the current installation.

**Data flow**: It checks whether this is a debug build, refuses updates there, otherwise asks the TUI update helper how Codex was installed. If an update method is found, it runs it; otherwise it returns guidance to update manually.

**Call relations**: The main command dispatcher calls this for the `Update` subcommand. It delegates the actual command execution to `run_update_action`.

*Call graph*: calls 1 internal fn (run_update_action); called by 1 (cli_main); 2 external calls (bail!, get_update_action).


##### `run_execpolicycheck`  (lines 817–819)

```
fn run_execpolicycheck(cmd: ExecPolicyCheckCommand) -> anyhow::Result<()>
```

**Purpose**: Runs the hidden exec-policy checker command.

**Data flow**: It receives the already parsed policy-check command and calls its `run` method. The result is passed back as success or failure.

**Call relations**: The main dispatcher calls it for `codex execpolicy check`, keeping that branch small.

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

**Purpose**: Runs archive, unarchive, or delete actions for saved interactive sessions.

**Data flow**: It receives the desired archive action, the session target, TUI options, root config overrides, remote settings, and executable paths. It merges options, resolves any remote endpoint, calls the TUI session archive command, and returns the command’s output text.

**Call relations**: The main dispatcher uses this for archive, delete, and unarchive. It prepares inputs with `finalize_session_archive_interactive` and `resolve_remote_endpoint` before handing off to `codex_tui`.

*Call graph*: calls 2 internal fn (finalize_session_archive_interactive, resolve_remote_endpoint); called by 1 (cli_main); 1 external calls (run_session_archive_command).


##### `delete_action`  (lines 854–863)

```
fn delete_action(target: &str, force: bool) -> anyhow::Result<codex_tui::SessionArchiveAction>
```

**Purpose**: Builds the correct delete behavior, including whether the user must confirm deletion.

**Data flow**: It receives a target string and a `force` flag. If forced deletion is requested, it verifies the target is a session UUID; then it returns a delete action that either skips or requires confirmation.

**Call relations**: The delete branch of the dispatcher calls this before running the shared session archive command. A test also checks the UUID safety rule.

*Call graph*: calls 1 internal fn (from_string); called by 2 (cli_main, delete_force_requires_uuid); 2 external calls (bail!, Delete).


##### `run_debug_app_server_command`  (lines 865–873)

```
async fn run_debug_app_server_command(cmd: DebugAppServerCommand) -> anyhow::Result<()>
```

**Purpose**: Runs app-server debugging tools, currently sending a test message through the app-server V2 path.

**Data flow**: It receives the parsed debug app-server command, finds the current Codex executable, and sends the requested user message through the test client. It returns whatever success or error the client reports.

**Call relations**: The main dispatcher calls this for `codex debug app-server`. It hands the actual protocol test to `codex_app_server_test_client`.

*Call graph*: called by 1 (cli_main); 2 external calls (send_message_v2, current_exe).


##### `FeatureToggles::to_overrides`  (lines 901–912)

```
fn to_overrides(&self) -> anyhow::Result<Vec<String>>
```

**Purpose**: Turns `--enable` and `--disable` feature flags into normal config override strings.

**Data flow**: It reads the feature names stored in the CLI struct, validates each name, and produces strings like `features.some_feature=true` or `features.some_feature=false`.

**Call relations**: The main dispatcher calls this early so feature toggles flow through the same path as other command-line config overrides. It relies on `FeatureToggles::validate_feature`.

*Call graph*: 3 external calls (validate_feature, new, format!).


##### `FeatureToggles::validate_feature`  (lines 914–920)

```
fn validate_feature(feature: &str) -> anyhow::Result<()>
```

**Purpose**: Rejects feature flag names that Codex does not recognize.

**Data flow**: It receives a feature key, checks it against the known feature list, and returns success or an error naming the unknown flag.

**Call relations**: Feature override conversion and feature config editing call this before accepting user input.

*Call graph*: called by 2 (disable_feature_in_config, enable_feature_in_config); 2 external calls (bail!, is_known_feature_key).


##### `stage_str`  (lines 945–953)

```
fn stage_str(stage: Stage) -> &'static str
```

**Purpose**: Converts a feature’s development stage into plain text for display.

**Data flow**: It receives a feature stage enum and returns a short label such as `experimental`, `stable`, or `removed`.

**Call relations**: The `features list` branch of the main dispatcher uses it when printing the feature table.

*Call graph*: called by 1 (cli_main).


##### `main`  (lines 955–961)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Starts the Codex CLI process.

**Data flow**: It reads a remote-control environment setting, then enters the special arg0 dispatcher, which can route alternate executable names before running `cli_main`.

**Call relations**: This is the process entrypoint. It hands the real command handling to `cli_main` through `arg0_dispatch_or_else`.

*Call graph*: 2 external calls (take_remote_control_disabled_env, arg0_dispatch_or_else).


##### `cli_main`  (lines 963–1647)

```
async fn cli_main(
    arg0_paths: Arg0DispatchPaths,
    remote_control_disabled: bool,
) -> anyhow::Result<()>
```

**Purpose**: This is the central traffic controller for every `codex` command.

**Data flow**: It parses the command line, merges feature toggles and config overrides, checks whether root flags are allowed, then matches the selected subcommand. Each branch prepares that command’s settings and calls the crate or helper that performs the real work.

**Call relations**: It is called by `main` after arg0 setup. It calls most helper functions in this file and many subsystem entrypoints, including the TUI, exec runner, app server, login, sandbox, debug tools, and feature editing.

*Call graph*: calls 45 internal fn (run_apply_command, run_app, delete_action, disable_feature_in_config, run_doctor, enable_feature_in_config, finalize_fork_interactive, finalize_resume_interactive, handle_app_exit, loader_overrides_for_profile (+15 more)); 28 external calls (default, try_parse_from, with_capacity, bail!, clone, parse, Review, app_server_control_socket_path, run_main_with_transport_options, bootstrap (+15 more)).


##### `profile_v2_for_subcommand`  (lines 1649–1674)

```
fn profile_v2_for_subcommand(
    interactive: &'a TuiCli,
    subcommand: &Subcommand,
) -> anyhow::Result<Option<&'a ProfileV2Name>>
```

**Purpose**: Decides whether the `--profile` config shortcut is allowed for the chosen subcommand.

**Data flow**: It reads the profile selected on the interactive options and the chosen subcommand. Runtime-style commands are allowed to use it; configuration or tooling commands get a clear error.

**Call relations**: The main dispatcher calls this after parsing. Tests call it through a small helper to verify which commands may use profiles.

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

**Purpose**: Starts the standalone exec-server either locally or as a registered remote environment.

**Data flow**: It receives exec-server CLI settings, executable paths, config overrides, and strict-config choice. It builds runtime paths, optionally loads config and authentication, then either registers with a remote service or starts a local listener.

**Call relations**: The main dispatcher calls it for `codex exec-server`. It calls config and authentication helpers before handing off to `codex_exec_server`.

*Call graph*: calls 4 internal fn (load_exec_server_config, load_exec_server_remote_auth_provider, new, new); called by 1 (cli_main); 2 external calls (run_main, run_remote_environment).


##### `load_exec_server_remote_auth_provider`  (lines 1725–1757)

```
async fn load_exec_server_remote_auth_provider(
    config: &codex_core::config::Config,
    base_url: &str,
    use_agent_identity_auth: bool,
) -> anyhow::Result<codex_api::SharedAuthProvider>
```

**Purpose**: Prepares the authentication provider used when registering an exec-server with a remote service.

**Data flow**: It receives loaded config, the remote URL, and whether to use Agent Identity auth. It reads the appropriate credentials, verifies the auth type is allowed, applies API-key host safety checks, and returns a shared auth provider.

**Call relations**: Remote exec-server startup calls this after loading config. It may call `load_exec_server_remote_auth`, `is_supported_exec_server_remote_auth`, and `validate_api_key_remote_host`.

*Call graph*: calls 4 internal fn (is_supported_exec_server_remote_auth, load_exec_server_remote_auth, validate_api_key_remote_host, from_agent_identity_jwt); called by 1 (run_exec_server_command); 3 external calls (bail!, read_codex_access_token_from_env, auth_provider_from_auth).


##### `is_supported_exec_server_remote_auth`  (lines 1759–1761)

```
fn is_supported_exec_server_remote_auth(auth: &CodexAuth) -> bool
```

**Purpose**: Checks whether a stored login method is allowed for remote exec-server registration.

**Data flow**: It receives a Codex auth object and returns true only for ChatGPT auth or API-key auth.

**Call relations**: The remote auth provider builder calls this before accepting stored credentials.

*Call graph*: calls 2 internal fn (is_api_key_auth, is_chatgpt_auth); called by 1 (load_exec_server_remote_auth_provider).


##### `validate_api_key_remote_host`  (lines 1763–1795)

```
fn validate_api_key_remote_host(base_url: &str) -> anyhow::Result<()>
```

**Purpose**: Prevents API keys from being sent to unsafe remote exec-server registration URLs.

**Data flow**: It parses the base URL, checks its host and scheme, and allows only HTTPS OpenAI domains or loopback addresses, with plain HTTP allowed only for loopback. Otherwise it returns an error.

**Call relations**: Remote exec-server auth setup calls this when API-key auth is used. Several tests call it directly to verify allowed and rejected hosts.

*Call graph*: called by 3 (load_exec_server_remote_auth_provider, exec_server_remote_api_key_auth_rejects_http_openai_domain, exec_server_remote_api_key_auth_rejects_suffix_spoof); 2 external calls (bail!, parse).


##### `load_exec_server_config`  (lines 1797–1809)

```
async fn load_exec_server_config(
    root_config_overrides: &CliConfigOverrides,
    strict_config: bool,
) -> anyhow::Result<codex_core::config::Config>
```

**Purpose**: Loads Codex configuration for exec-server startup.

**Data flow**: It receives root CLI config overrides and a strict-config flag, parses overrides, builds the config, and returns the loaded configuration or an error.

**Call relations**: Exec-server startup calls this before remote registration and also to validate config for strict local startup.

*Call graph*: calls 1 internal fn (parse_overrides); called by 1 (run_exec_server_command); 1 external calls (default).


##### `load_exec_server_remote_auth`  (lines 1811–1830)

```
async fn load_exec_server_remote_auth(
    config: &codex_core::config::Config,
    missing_auth_error: &'static str,
) -> anyhow::Result<codex_login::CodexAuth>
```

**Purpose**: Loads the user’s stored auth for remote exec-server registration, retrying once after a reload.

**Data flow**: It receives config and an error message to use if no auth exists. It creates an auth manager, asks for auth, reloads if needed, and returns the auth or the supplied missing-auth error.

**Call relations**: The remote auth provider helper calls this for normal ChatGPT or API-key authentication.

*Call graph*: calls 1 internal fn (shared_from_config); called by 1 (load_exec_server_remote_auth_provider).


##### `enable_feature_in_config`  (lines 1832–1842)

```
async fn enable_feature_in_config(feature: &str) -> anyhow::Result<()>
```

**Purpose**: Turns on a named feature flag in the user’s config file.

**Data flow**: It validates the feature name, finds the Codex home directory, edits `config.toml` to set the feature to true, prints confirmation, and may warn if the feature is still under development.

**Call relations**: The main dispatcher calls it for `codex features enable`. It uses `FeatureToggles::validate_feature` and `maybe_print_under_development_feature_warning`.

*Call graph*: calls 4 internal fn (validate_feature, maybe_print_under_development_feature_warning, new, find_codex_home); called by 1 (cli_main); 1 external calls (println!).


##### `disable_feature_in_config`  (lines 1844–1853)

```
async fn disable_feature_in_config(feature: &str) -> anyhow::Result<()>
```

**Purpose**: Turns off a named feature flag in the user’s config file.

**Data flow**: It validates the feature name, finds Codex home, edits `config.toml` to set the feature to false, and prints confirmation.

**Call relations**: The main dispatcher calls it for `codex features disable`.

*Call graph*: calls 3 internal fn (validate_feature, new, find_codex_home); called by 1 (cli_main); 1 external calls (println!).


##### `loader_overrides_for_profile`  (lines 1855–1869)

```
fn loader_overrides_for_profile(
    profile_v2: Option<&ProfileV2Name>,
) -> anyhow::Result<LoaderOverrides>
```

**Purpose**: Builds config loader settings for an optional named profile.

**Data flow**: It receives an optional profile name. If present, it finds Codex home and points the config loader at that profile’s config file; otherwise it returns default loader settings.

**Call relations**: Runtime commands and prompt-input debugging call this when they need profile-specific config loading.

*Call graph*: calls 2 internal fn (find_codex_home, resolve_profile_v2_config_path); called by 2 (cli_main, run_debug_prompt_input_command); 2 external calls (default, default).


##### `maybe_print_under_development_feature_warning`  (lines 1871–1884)

```
fn maybe_print_under_development_feature_warning(codex_home: &std::path::Path, feature: &str)
```

**Purpose**: Warns the user when they enable a feature that is explicitly marked incomplete.

**Data flow**: It receives Codex home and a feature name, looks up that feature, and if its stage is under development prints a warning with the config path for suppressing the warning.

**Call relations**: Feature enabling calls this after writing the config change.

*Call graph*: called by 1 (enable_feature_in_config); 3 external calls (join, eprintln!, matches!).


##### `run_debug_trace_reduce_command`  (lines 1886–1897)

```
async fn run_debug_trace_reduce_command(cmd: DebugTraceReduceCommand) -> anyhow::Result<()>
```

**Purpose**: Replays a rollout trace bundle and writes a smaller state JSON file for inspection.

**Data flow**: It receives a trace bundle path and optional output path, replays the bundle, serializes the reduced state as pretty JSON, writes it to disk, and prints the output path.

**Call relations**: The main dispatcher calls it for the hidden `debug trace-reduce` tool.

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

**Purpose**: Shows exactly what prompt input Codex would send to the model after applying config, images, and user instructions.

**Data flow**: It receives prompt debug arguments, root overrides, interactive CLI settings, and executable paths. It builds config, converts images and prompt text into user input items, builds the final prompt input, and prints it as JSON.

**Call relations**: The main dispatcher calls it for `codex debug prompt-input`. It uses profile loading, config building, and `codex_core::build_prompt_input`.

*Call graph*: calls 3 internal fn (loader_overrides_for_profile, new, parse_overrides); called by 1 (cli_main); 7 external calls (new, default, new, build_prompt_input, default, println!, String).


##### `run_debug_models_command`  (lines 1976–2001)

```
async fn run_debug_models_command(
    cmd: DebugModelsCommand,
    root_config_overrides: CliConfigOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Prints the raw model catalog that Codex knows about.

**Data flow**: It receives the debug models command and config overrides. It either loads the bundled catalog or builds config and auth to fetch or read the online model catalog, then writes JSON to standard output.

**Call relations**: The main dispatcher calls it for `codex debug models`.

*Call graph*: calls 2 internal fn (shared_from_config, parse_overrides); called by 1 (cli_main); 6 external calls (build_models_manager, bundled_models_response, default, println!, to_writer, stdout).


##### `run_debug_clear_memories_command`  (lines 2003–2033)

```
async fn run_debug_clear_memories_command(
    root_config_overrides: &CliConfigOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Clears local memory data for a fresh debugging start.

**Data flow**: It receives config overrides, builds config, clears memory rows in the SQLite state area, clears memory directories under Codex home, and prints what was cleared.

**Call relations**: The main dispatcher calls it for the hidden `debug clear-memories` command.

*Call graph*: calls 2 internal fn (clear_memory_data_in_sqlite_home, parse_overrides); called by 1 (cli_main); 5 external calls (clear_memory_roots_contents, memories_db_path, default, format!, println!).


##### `prepend_config_flags`  (lines 2037–2042)

```
fn prepend_config_flags(
    subcommand_config_overrides: &mut CliConfigOverrides,
    cli_config_overrides: CliConfigOverrides,
)
```

**Purpose**: Merges root-level `-c key=value` config overrides into a subcommand’s overrides with lower priority.

**Data flow**: It receives mutable subcommand overrides and root overrides, then prepends the root values so later subcommand-specific values can win.

**Call relations**: The main dispatcher and session finalizers use it whenever both root and subcommand config flags may exist.

*Call graph*: calls 1 internal fn (prepend_root_overrides); called by 4 (cli_main, finalize_fork_interactive, finalize_resume_interactive, finalize_session_archive_interactive).


##### `reject_remote_mode_for_subcommand`  (lines 2044–2060)

```
fn reject_remote_mode_for_subcommand(
    remote: Option<&str>,
    remote_auth_token_env: Option<&str>,
    subcommand: &str,
) -> anyhow::Result<()>
```

**Purpose**: Stops users from using interactive remote-TUI options with commands that do not support them.

**Data flow**: It receives optional remote address, optional auth-token environment variable name, and a subcommand name. If either remote option is present, it returns a clear error; otherwise it succeeds.

**Call relations**: Most non-interactive branches in `cli_main` call this before running. App-server-specific rejection also delegates to it, and tests verify the messages.

*Call graph*: called by 5 (cli_main, reject_remote_mode_for_app_server_subcommand, reject_remote_auth_token_env_for_non_interactive_subcommands, reject_remote_flag_for_remote_control, reject_remote_mode_for_non_interactive_subcommands); 1 external calls (bail!).


##### `reject_root_strict_config_for_subcommand`  (lines 2062–2076)

```
fn reject_root_strict_config_for_subcommand(
    strict_config: bool,
    subcommand: &Option<Subcommand>,
) -> anyhow::Result<()>
```

**Purpose**: Rejects root-level `--strict-config` for subcommands that cannot honor it safely.

**Data flow**: It receives the root strict flag and selected subcommand. If strict mode is off, it succeeds; otherwise it finds whether the subcommand is unsupported and returns an error if needed.

**Call relations**: The main dispatcher calls it after parsing. Tests call it directly for supported and unsupported cases.

*Call graph*: calls 2 internal fn (reject_strict_config_for_unsupported_subcommand, unsupported_subcommand_name_for_strict_config); called by 3 (cli_main, root_strict_config_is_rejected_for_unsupported_subcommands, root_strict_config_is_supported_for_exec_server).


##### `unsupported_subcommand_name_for_strict_config`  (lines 2090–2127)

```
fn unsupported_subcommand_name_for_strict_config(
    subcommand: &Option<Subcommand>,
) -> Option<&'static str>
```

**Purpose**: Maps a selected subcommand to the user-facing name to mention when root `--strict-config` is not allowed.

**Data flow**: It receives the optional subcommand and returns either no name, meaning strict config is allowed, or a static command-name string for the rejection message.

**Call relations**: The strict-config rejection helper calls this. It uses `app_server_subcommand_name` for nested app-server tools.

*Call graph*: calls 1 internal fn (app_server_subcommand_name); called by 1 (reject_root_strict_config_for_subcommand).


##### `reject_strict_config_for_app_server_subcommand`  (lines 2129–2140)

```
fn reject_strict_config_for_app_server_subcommand(
    strict_config: bool,
    subcommand: Option<&AppServerSubcommand>,
) -> anyhow::Result<()>
```

**Purpose**: Rejects `--strict-config` for app-server tooling subcommands while allowing it for normal app-server startup.

**Data flow**: It receives the strict flag and optional app-server subcommand. If no nested subcommand exists it succeeds; otherwise it builds the nested name and rejects strict mode when set.

**Call relations**: The app-server branch in `cli_main` calls this, and tests verify proxy/tooling rejection.

*Call graph*: calls 2 internal fn (app_server_subcommand_name, reject_strict_config_for_unsupported_subcommand); called by 2 (cli_main, app_server_subcommands_reject_strict_config).


##### `reject_strict_config_for_unsupported_subcommand`  (lines 2142–2150)

```
fn reject_strict_config_for_unsupported_subcommand(
    strict_config: bool,
    subcommand: &str,
) -> anyhow::Result<()>
```

**Purpose**: Produces the shared error for a command that does not support `--strict-config`.

**Data flow**: It receives a strict flag and subcommand name. If strict mode is true, it returns an error naming the command; otherwise it succeeds.

**Call relations**: Root strict-config checks and app-server strict checks both call this.

*Call graph*: called by 2 (reject_root_strict_config_for_subcommand, reject_strict_config_for_app_server_subcommand); 1 external calls (bail!).


##### `reject_remote_mode_for_app_server_subcommand`  (lines 2152–2159)

```
fn reject_remote_mode_for_app_server_subcommand(
    remote: Option<&str>,
    remote_auth_token_env: Option<&str>,
    subcommand: Option<&AppServerSubcommand>,
) -> anyhow::Result<()>
```

**Purpose**: Applies the remote-mode rejection rule to app-server subcommands with clear nested command names.

**Data flow**: It receives remote options and an optional app-server subcommand, converts the subcommand into a display name, and delegates to the generic remote rejection helper.

**Call relations**: The app-server branch of `cli_main` calls this before running app-server tooling. Tests call it for proxy, version, and schema-generation cases.

*Call graph*: calls 2 internal fn (app_server_subcommand_name, reject_remote_mode_for_subcommand); called by 4 (cli_main, reject_remote_auth_token_env_for_app_server_generate_internal_json_schema, reject_remote_auth_token_env_for_app_server_proxy, reject_remote_auth_token_env_for_app_server_version).


##### `app_server_subcommand_name`  (lines 2161–2185)

```
fn app_server_subcommand_name(subcommand: Option<&AppServerSubcommand>) -> &'static str
```

**Purpose**: Turns a nested app-server command into the exact text users recognize from the CLI.

**Data flow**: It receives an optional app-server subcommand and returns a static string such as `app-server daemon start` or `app-server proxy`.

**Call relations**: Strict-config and remote-mode rejection helpers call this to produce precise error messages.

*Call graph*: called by 3 (reject_remote_mode_for_app_server_subcommand, reject_strict_config_for_app_server_subcommand, unsupported_subcommand_name_for_strict_config).


##### `print_app_server_daemon_output`  (lines 2187–2191)

```
async fn print_app_server_daemon_output(command: AppServerLifecycleCommand) -> anyhow::Result<()>
```

**Purpose**: Runs an app-server daemon lifecycle command and prints its JSON result.

**Data flow**: It receives a lifecycle command such as start, stop, restart, or version, awaits the daemon response, serializes it to JSON, and prints it.

**Call relations**: The app-server daemon branch of `cli_main` calls this for most daemon actions.

*Call graph*: called by 1 (cli_main); 2 external calls (run, println!).


##### `print_app_server_remote_control_output`  (lines 2193–2199)

```
async fn print_app_server_remote_control_output(
    mode: AppServerRemoteControlMode,
) -> anyhow::Result<()>
```

**Purpose**: Changes the app-server daemon’s remote-control setting and prints the JSON result.

**Data flow**: It receives the desired remote-control mode, asks the daemon layer to set it, serializes the response, and prints it.

**Call relations**: The app-server daemon branch calls it for enable-remote-control and disable-remote-control.

*Call graph*: called by 1 (cli_main); 2 external calls (set_remote_control, println!).


##### `read_remote_auth_token_from_env_var_with`  (lines 2201–2215)

```
fn read_remote_auth_token_from_env_var_with(
    env_var_name: &str,
    get_var: F,
) -> anyhow::Result<String>
```

**Purpose**: Reads a bearer token from an environment variable, with a test-friendly way to supply the environment lookup.

**Data flow**: It receives an environment variable name and a lookup function. It reads the value, trims whitespace, rejects missing or empty values, and returns the token string.

**Call relations**: The normal environment reader wraps this. Tests call it with fake lookup functions to check missing, trimmed, and empty cases.

*Call graph*: called by 4 (read_remote_auth_token_from_env_var, read_remote_auth_token_from_env_var_rejects_empty_values, read_remote_auth_token_from_env_var_reports_missing_values, read_remote_auth_token_from_env_var_trims_values); 1 external calls (bail!).


##### `read_remote_auth_token_from_env_var`  (lines 2217–2219)

```
fn read_remote_auth_token_from_env_var(env_var_name: &str) -> anyhow::Result<String>
```

**Purpose**: Reads a remote app-server authentication token from the real process environment.

**Data flow**: It receives an environment variable name and returns the trimmed token or an error if the variable is missing or empty.

**Call relations**: Remote endpoint resolution calls this when the user supplied `--remote-auth-token-env`.

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

**Purpose**: Starts the interactive terminal UI, with safety checks and local database recovery guidance.

**Data flow**: It receives TUI options, optional remote connection settings, and executable paths. It normalizes prompt line endings, checks terminal support, resolves remote auth, starts the TUI, and if startup fails due to a damaged local database it may back up files and retry.

**Call relations**: The main dispatcher calls this for plain `codex`, `resume`, and `fork`. It uses `confirm`, `resolve_remote_endpoint`, and local state recovery helpers before calling `codex_tui::run_main`.

*Call graph*: calls 4 internal fn (confirm, is_remote_auth_usage_error, resolve_remote_endpoint, fatal); called by 1 (cli_main); 14 external calls (new, terminal_info, eprintln!, format!, backup_files_for_fresh_start, confirm_fresh_start_rebuild, is_auto_backup_recoverable, is_locked, print_auto_backup_start, print_diagnostic_guidance (+4 more)).


##### `resolve_remote_endpoint`  (lines 2300–2333)

```
fn resolve_remote_endpoint(
    remote: Option<String>,
    remote_auth_token_env: Option<String>,
) -> std::io::Result<Option<codex_tui::RemoteAppServerEndpoint>>
```

**Purpose**: Turns remote TUI flags into a concrete remote app-server endpoint, including optional auth.

**Data flow**: It receives an optional remote address and optional token environment variable name. It parses the address, checks whether token auth is allowed for that address, reads the token if requested, attaches it, and returns the endpoint or an I/O-style error.

**Call relations**: Interactive TUI startup and session archive commands call this before connecting to a remote app server.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var); called by 2 (run_interactive_tui, run_session_archive_cli_command); 2 external calls (other, remote_addr_supports_auth_token).


##### `is_remote_auth_usage_error`  (lines 2335–2338)

```
fn is_remote_auth_usage_error(err: &std::io::Error) -> bool
```

**Purpose**: Recognizes remote-auth errors that should be shown as friendly fatal app messages instead of raw I/O failures.

**Data flow**: It receives an I/O error, converts it to text, and checks whether it starts with the known `--remote-auth-token-env` usage message.

**Call relations**: Interactive TUI startup calls this when remote endpoint resolution fails.

*Call graph*: called by 1 (run_interactive_tui); 1 external calls (to_string).


##### `confirm`  (lines 2340–2347)

```
fn confirm(prompt: &str) -> std::io::Result<bool>
```

**Purpose**: Asks the user a yes-or-no question in the terminal.

**Data flow**: It prints a prompt to standard error, reads one line from standard input, trims it, and returns true only for `y` or `yes`.

**Call relations**: Interactive startup uses this when `TERM=dumb` but a real terminal is available, asking whether to continue anyway.

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

**Purpose**: Builds the final TUI settings for `codex resume`.

**Data flow**: It receives root interactive settings, root config overrides, resume selection flags, and resume-scoped TUI flags. It decides whether to show a picker, use the last session, or use a specific session, merges flags, prepends root config overrides, and returns the final TUI config.

**Call relations**: The main dispatcher calls this before starting the TUI for resume. Tests use a helper that parses arguments and calls it directly.

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

**Purpose**: Builds the final TUI settings for `codex fork`.

**Data flow**: It receives root interactive settings, root overrides, fork selection flags, and fork-scoped TUI flags. It decides picker/last/session behavior, merges subcommand flags, prepends root config, and returns the final TUI config.

**Call relations**: The main dispatcher calls this before starting the TUI for fork. Tests call it through a parsing helper.

*Call graph*: calls 2 internal fn (merge_interactive_cli_flags, prepend_config_flags); called by 2 (cli_main, finalize_fork_from_args).


##### `finalize_session_archive_interactive`  (lines 2417–2437)

```
fn finalize_session_archive_interactive(
    mut interactive: TuiCli,
    root_config_overrides: CliConfigOverrides,
    archive_cli: SessionArchiveConfigOverrides,
) -> TuiCli
```

**Purpose**: Builds the TUI-style configuration used by archive, unarchive, and delete session commands.

**Data flow**: It receives root interactive settings, root config overrides, and archive-scoped options. It applies shared command overrides, strict config, and raw config overrides, then prepends root overrides and returns the result.

**Call relations**: The shared session archive runner calls this. Tests call it through an archive parsing helper.

*Call graph*: calls 1 internal fn (prepend_config_flags); called by 2 (run_session_archive_cli_command, finalize_archive_from_args).


##### `merge_interactive_cli_flags`  (lines 2442–2473)

```
fn merge_interactive_cli_flags(interactive: &mut TuiCli, subcommand_cli: TuiCli)
```

**Purpose**: Applies subcommand-scoped TUI flags on top of root TUI flags.

**Data flow**: It receives mutable root interactive settings and a subcommand TUI settings value. It applies only explicitly meaningful subcommand choices, normalizes prompt line endings, and appends subcommand config overrides with higher priority.

**Call relations**: Resume and fork finalizers call this so their own flags win over root-level defaults.

*Call graph*: called by 2 (finalize_fork_interactive, finalize_resume_interactive).


##### `print_completion`  (lines 2475–2479)

```
fn print_completion(cmd: CompletionCommand)
```

**Purpose**: Generates shell completion script text for the requested shell.

**Data flow**: It receives the completion command, builds the full Codex command definition, and writes the generated completion script to standard output.

**Call relations**: The main dispatcher calls it for `codex completion`.

*Call graph*: called by 1 (cli_main); 3 external calls (generate, command, stdout).


##### `tests::exec_server_remote_auth_accepts_api_key_auth`  (lines 2490–2494)

```
fn exec_server_remote_auth_accepts_api_key_auth()
```

**Purpose**: Checks that API-key authentication is considered valid for remote exec-server registration.

**Data flow**: It creates a fake API-key auth object, passes it to the support check, and asserts the result is true.

**Call relations**: This test protects the behavior used by `load_exec_server_remote_auth_provider`.

*Call graph*: calls 1 internal fn (from_api_key); 1 external calls (assert!).


##### `tests::exec_server_remote_api_key_auth_accepts_https_openai_domains`  (lines 2497–2506)

```
fn exec_server_remote_api_key_auth_accepts_https_openai_domains()
```

**Purpose**: Checks that API-key remote registration allows secure OpenAI-owned domains.

**Data flow**: It loops over HTTPS OpenAI domain examples and asserts host validation succeeds.

**Call relations**: This test covers the allow-list logic in `validate_api_key_remote_host`.

*Call graph*: 1 external calls (assert!).


##### `tests::exec_server_remote_api_key_auth_accepts_http_loopback`  (lines 2509–2517)

```
fn exec_server_remote_api_key_auth_accepts_http_loopback()
```

**Purpose**: Checks that local loopback HTTP URLs are allowed for API-key registration.

**Data flow**: It tries localhost, IPv4 loopback, and IPv6 loopback URLs and expects validation success.

**Call relations**: This test covers local-development exceptions in `validate_api_key_remote_host`.

*Call graph*: 1 external calls (assert!).


##### `tests::exec_server_remote_api_key_auth_rejects_http_openai_domain`  (lines 2520–2533)

```
fn exec_server_remote_api_key_auth_rejects_http_openai_domain()
```

**Purpose**: Checks that OpenAI domains still require HTTPS when API keys are involved.

**Data flow**: It passes plain HTTP OpenAI URLs to the validator and asserts the exact rejection message.

**Call relations**: This test calls `validate_api_key_remote_host` directly to protect a credential-safety rule.

*Call graph*: calls 1 internal fn (validate_api_key_remote_host); 1 external calls (assert_eq!).


##### `tests::exec_server_remote_api_key_auth_rejects_suffix_spoof`  (lines 2536–2544)

```
fn exec_server_remote_api_key_auth_rejects_suffix_spoof()
```

**Purpose**: Checks that a malicious domain ending with an OpenAI-looking prefix is not accepted.

**Data flow**: It validates a spoofed hostname and asserts the standard API-key safety error.

**Call relations**: This test guards the domain matching inside `validate_api_key_remote_host`.

*Call graph*: calls 1 internal fn (validate_api_key_remote_host); 1 external calls (assert_eq!).


##### `tests::finalize_resume_from_args`  (lines 2546–2578)

```
fn finalize_resume_from_args(args: &[&str]) -> TuiCli
```

**Purpose**: Test helper that parses CLI text and returns the final resume TUI settings.

**Data flow**: It receives argument strings, parses them as `MultitoolCli`, extracts the resume command pieces, calls `finalize_resume_interactive`, and returns the result.

**Call relations**: Many resume tests use this helper instead of repeating parser setup.

*Call graph*: calls 1 internal fn (finalize_resume_interactive); 2 external calls (try_parse_from, unreachable!).


##### `tests::finalize_fork_from_args`  (lines 2580–2603)

```
fn finalize_fork_from_args(args: &[&str]) -> TuiCli
```

**Purpose**: Test helper that parses CLI text and returns the final fork TUI settings.

**Data flow**: It receives argument strings, parses them, extracts fork command fields, calls `finalize_fork_interactive`, and returns the result.

**Call relations**: Fork behavior tests call this helper.

*Call graph*: calls 1 internal fn (finalize_fork_interactive); 2 external calls (try_parse_from, unreachable!).


##### `tests::finalize_archive_from_args`  (lines 2605–2629)

```
fn finalize_archive_from_args(args: &[&str]) -> (String, TuiCli, InteractiveRemoteOptions)
```

**Purpose**: Test helper that parses archive CLI text and returns the target, final TUI settings, and remote options.

**Data flow**: It receives argument strings, parses them, extracts archive command fields, calls `finalize_session_archive_interactive`, and returns the pieces tests need.

**Call relations**: Archive merge tests use this helper.

*Call graph*: calls 1 internal fn (finalize_session_archive_interactive); 2 external calls (try_parse_from, unreachable!).


##### `tests::profile_v2_for_args`  (lines 2631–2641)

```
fn profile_v2_for_args(args: &[&str]) -> anyhow::Result<Option<String>>
```

**Purpose**: Test helper that checks how profile selection applies to a parsed command.

**Data flow**: It receives argument strings, parses them, and either returns the root profile for plain interactive use or calls `profile_v2_for_subcommand` for subcommands.

**Call relations**: Profile allowance and rejection tests use this helper.

*Call graph*: calls 1 internal fn (profile_v2_for_subcommand); 1 external calls (try_parse_from).


##### `tests::profile_v2_is_rejected_for_config_management_subcommands`  (lines 2644–2646)

```
fn profile_v2_is_rejected_for_config_management_subcommands()
```

**Purpose**: Verifies that `--profile` is not accepted for configuration-management commands such as feature listing.

**Data flow**: It parses a feature-list command with a profile and asserts the profile check returns an error.

**Call relations**: This protects the rules in `profile_v2_for_subcommand`.

*Call graph*: 1 external calls (assert!).


##### `tests::profile_v2_is_allowed_for_runtime_subcommands`  (lines 2649–2674)

```
fn profile_v2_is_allowed_for_runtime_subcommands()
```

**Purpose**: Verifies that runtime commands may use `--profile`.

**Data flow**: It tries resume, debug prompt-input, mcp, and sandbox commands with a profile and asserts the profile name is returned.

**Call relations**: This protects allowed branches in `profile_v2_for_subcommand`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::import_remains_an_interactive_prompt`  (lines 2677–2682)

```
fn import_remains_an_interactive_prompt()
```

**Purpose**: Ensures `codex import` is treated as a prompt to the interactive UI, not as a subcommand.

**Data flow**: It parses `codex import`, checks no subcommand was selected, and checks the prompt text is `import`.

**Call relations**: This test protects user-facing parsing behavior in `MultitoolCli`.

*Call graph*: 3 external calls (assert!, assert_eq!, try_parse_from).


##### `tests::profile_v2_rejects_non_plain_names_at_parse_time`  (lines 2685–2689)

```
fn profile_v2_rejects_non_plain_names_at_parse_time()
```

**Purpose**: Ensures profile names cannot contain path-like separators.

**Data flow**: It tries to parse a nested profile name and expects parsing to fail.

**Call relations**: This test protects profile-name validation from the CLI type parser.

*Call graph*: 1 external calls (assert!).


##### `tests::exec_resume_last_accepts_prompt_positional`  (lines 2692–2707)

```
fn exec_resume_last_accepts_prompt_positional()
```

**Purpose**: Checks that non-interactive `exec resume --last` can accept a prompt positional.

**Data flow**: It parses the command, extracts the exec resume arguments, and asserts `last` is true, session id is absent, and prompt text is kept.

**Call relations**: This guards parsing behavior in the exec subcommand integration.

*Call graph*: 4 external calls (assert!, assert_eq!, try_parse_from, panic!).


##### `tests::exec_resume_accepts_output_flags_after_subcommand`  (lines 2710–2741)

```
fn exec_resume_accepts_output_flags_after_subcommand()
```

**Purpose**: Checks that exec resume accepts output-related flags after the nested resume command.

**Data flow**: It parses a command with session id, output file, output schema, and prompt, then asserts all fields land in the expected places.

**Call relations**: This protects exec command-line compatibility.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::dangerous_bypass_conflicts_with_approval_policy`  (lines 2744–2754)

```
fn dangerous_bypass_conflicts_with_approval_policy()
```

**Purpose**: Ensures a broad unsafe bypass flag cannot be combined with an explicit approval policy.

**Data flow**: It parses conflicting flags and asserts the parser reports an argument conflict.

**Call relations**: This test protects safety-related clap configuration.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::app_server_from_args`  (lines 2756–2762)

```
fn app_server_from_args(args: &[&str]) -> AppServerCommand
```

**Purpose**: Test helper that parses an app-server command and returns its parsed struct.

**Data flow**: It receives argument strings, parses them, extracts the app-server subcommand, and returns it.

**Call relations**: Many app-server parsing tests use this helper.

*Call graph*: 2 external calls (try_parse_from, unreachable!).


##### `tests::default_app_server_socket_path`  (lines 2764–2768)

```
fn default_app_server_socket_path() -> AbsolutePathBuf
```

**Purpose**: Test helper that computes the default app-server control socket path.

**Data flow**: It finds Codex home, asks the app-server code for the control socket path, and returns it.

**Call relations**: App-server Unix socket parsing tests use this expected value.

*Call graph*: calls 1 internal fn (find_codex_home); 1 external calls (app_server_control_socket_path).


##### `tests::debug_prompt_input_parses_prompt_and_images`  (lines 2771–2794)

```
fn debug_prompt_input_parses_prompt_and_images()
```

**Purpose**: Checks that `debug prompt-input` reads a prompt and comma-separated images.

**Data flow**: It parses the command and asserts the prompt and image path list match expectations.

**Call relations**: This protects parser setup for `DebugPromptInputCommand`.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::debug_models_parses_bundled_flag`  (lines 2797–2809)

```
fn debug_models_parses_bundled_flag()
```

**Purpose**: Checks that `debug models --bundled` sets the bundled-catalog flag.

**Data flow**: It parses the command, extracts the debug models struct, and asserts `bundled` is true.

**Call relations**: This protects parser setup for `DebugModelsCommand`.

*Call graph*: 3 external calls (assert!, try_parse_from, panic!).


##### `tests::responses_subcommand_is_not_registered`  (lines 2812–2819)

```
fn responses_subcommand_is_not_registered()
```

**Purpose**: Ensures an old or unwanted `responses` subcommand is not exposed.

**Data flow**: It builds the command definition and asserts none of its subcommands is named `responses`.

**Call relations**: This protects the public CLI surface.

*Call graph*: 2 external calls (assert!, command).


##### `tests::help_from_args`  (lines 2821–2825)

```
fn help_from_args(args: &[&str]) -> String
```

**Purpose**: Test helper that captures help text for a command.

**Data flow**: It receives argument strings, expects parsing to stop with a help-display result, and returns that help text.

**Call relations**: Plugin marketplace help tests use this helper.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::plugin_marketplace_help_uses_plugin_namespace`  (lines 2828–2844)

```
fn plugin_marketplace_help_uses_plugin_namespace()
```

**Purpose**: Checks that marketplace plugin help appears under `codex plugin marketplace`.

**Data flow**: It captures help for marketplace and its nested commands and asserts the usage lines use the plugin namespace.

**Call relations**: This guards the CLI organization for marketplace plugin commands.

*Call graph*: 2 external calls (assert!, help_from_args).


##### `tests::plugin_marketplace_add_parses_under_plugin`  (lines 2847–2853)

```
fn plugin_marketplace_add_parses_under_plugin()
```

**Purpose**: Checks that marketplace add is parsed as a plugin command.

**Data flow**: It parses `codex plugin marketplace add ...` and asserts the selected top-level subcommand is Plugin.

**Call relations**: This protects plugin command routing in `cli_main`.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::plugin_marketplace_upgrade_parses_under_plugin`  (lines 2856–2862)

```
fn plugin_marketplace_upgrade_parses_under_plugin()
```

**Purpose**: Checks that marketplace upgrade is parsed below plugin.

**Data flow**: It parses the command and asserts the top-level subcommand is Plugin.

**Call relations**: This protects marketplace command nesting.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::plugin_add_parses_under_plugin`  (lines 2865–2877)

```
fn plugin_add_parses_under_plugin()
```

**Purpose**: Checks that plugin add with marketplace options stays under the plugin command.

**Data flow**: It parses the command and asserts the selected top-level subcommand is Plugin.

**Call relations**: This protects plugin command routing.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::plugin_list_parses_under_plugin`  (lines 2880–2886)

```
fn plugin_list_parses_under_plugin()
```

**Purpose**: Checks that plugin list with marketplace options stays under the plugin command.

**Data flow**: It parses the command and asserts the selected top-level subcommand is Plugin.

**Call relations**: This protects plugin command routing.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::plugin_remove_parses_under_plugin`  (lines 2889–2901)

```
fn plugin_remove_parses_under_plugin()
```

**Purpose**: Checks that plugin remove with marketplace options stays under the plugin command.

**Data flow**: It parses the command and asserts the selected top-level subcommand is Plugin.

**Call relations**: This protects plugin command routing.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::update_parses_as_update_subcommand`  (lines 2904–2907)

```
fn update_parses_as_update_subcommand()
```

**Purpose**: Checks that `codex update` selects the update subcommand.

**Data flow**: It parses `codex update` and asserts the parsed subcommand is Update.

**Call relations**: This protects routing to `run_update_command`.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::archive_merges_scoped_tui_flags`  (lines 2910–2942)

```
fn archive_merges_scoped_tui_flags()
```

**Purpose**: Checks that archive commands correctly merge root and archive-scoped TUI flags.

**Data flow**: It parses a complex archive command, finalizes archive settings, and asserts target, remote, model, profile, working directory, strict config, and hook-trust fields.

**Call relations**: This protects `finalize_session_archive_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_archive_from_args).


##### `tests::delete_force_requires_uuid`  (lines 2945–2953)

```
fn delete_force_requires_uuid()
```

**Purpose**: Checks that forced deletion is only allowed for UUID session ids.

**Data flow**: It calls `delete_action` with a UUID and a name, expecting success for the UUID and a clear error for the name.

**Call relations**: This protects the safety rule in `delete_action`.

*Call graph*: calls 1 internal fn (delete_action); 2 external calls (assert!, assert_eq!).


##### `tests::sandbox_parses_permissions_profile`  (lines 2957–2974)

```
fn sandbox_parses_permissions_profile()
```

**Purpose**: Checks that sandbox permissions profile parsing works with the long flag.

**Data flow**: It parses a sandbox command, extracts sandbox options, and asserts the permissions profile and command arguments.

**Call relations**: This protects platform sandbox CLI parsing.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::sandbox_parses_permissions_profile_short_alias`  (lines 2978–2989)

```
fn sandbox_parses_permissions_profile_short_alias()
```

**Purpose**: Checks that the short `-P` permissions profile flag works for sandbox commands.

**Data flow**: It parses the command and asserts the permissions profile and trailing command.

**Call relations**: This protects sandbox CLI shorthand behavior.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::sandbox_parses_config_profile`  (lines 2993–3004)

```
fn sandbox_parses_config_profile()
```

**Purpose**: Checks that sandbox config profile parsing works.

**Data flow**: It parses a sandbox command with `--profile` and asserts the profile and command arguments.

**Call relations**: This protects sandbox profile handling.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::sandbox_rejects_explicit_profile_controls_without_profile`  (lines 3008–3013)

```
fn sandbox_rejects_explicit_profile_controls_without_profile()
```

**Purpose**: Checks that sandbox profile-dependent controls require a profile.

**Data flow**: It parses an invalid sandbox command and asserts the parser reports a missing required argument.

**Call relations**: This protects sandbox argument constraints.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::plugin_marketplace_remove_parses_under_plugin`  (lines 3016–3022)

```
fn plugin_marketplace_remove_parses_under_plugin()
```

**Purpose**: Checks that marketplace remove is parsed under the plugin command.

**Data flow**: It parses the command and asserts the top-level subcommand is Plugin.

**Call relations**: This protects marketplace command nesting.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::marketplace_no_longer_parses_at_top_level`  (lines 3025–3037)

```
fn marketplace_no_longer_parses_at_top_level()
```

**Purpose**: Ensures marketplace commands are not accepted as top-level commands.

**Data flow**: It tries top-level marketplace add, upgrade, and remove commands and asserts parsing fails.

**Call relations**: This protects the intended plugin namespace.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::full_auto_no_longer_parses_at_top_level`  (lines 3040–3044)

```
fn full_auto_no_longer_parses_at_top_level()
```

**Purpose**: Ensures the removed top-level `--full-auto` flag is not accepted.

**Data flow**: It parses `codex --full-auto` and asserts parsing fails.

**Call relations**: This protects the cleaned-up root CLI surface.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::exec_full_auto_reports_migration_path`  (lines 3047–3058)

```
fn exec_full_auto_reports_migration_path()
```

**Purpose**: Checks that exec still recognizes removed `--full-auto` enough to show migration guidance.

**Data flow**: It parses an exec command with `--full-auto`, extracts the exec options, and asserts the warning text points to the new sandbox flag.

**Call relations**: This protects backward-compatible guidance in the exec CLI.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::sandbox_full_auto_no_longer_parses`  (lines 3061–3065)

```
fn sandbox_full_auto_no_longer_parses()
```

**Purpose**: Ensures sandbox does not accept the removed `--full-auto` flag.

**Data flow**: It parses an invalid sandbox command and asserts parsing fails.

**Call relations**: This protects sandbox CLI cleanup.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::sample_exit_info`  (lines 3067–3083)

```
fn sample_exit_info(conversation_id: Option<&str>, thread_name: Option<&str>) -> AppExitInfo
```

**Purpose**: Test helper that creates a sample interactive exit result.

**Data flow**: It receives optional conversation id and thread name, builds token usage and resume hint data, and returns an `AppExitInfo`.

**Call relations**: Exit message formatting tests use this helper.

*Call graph*: 2 external calls (default, resume_hint).


##### `tests::format_exit_messages_skips_zero_usage`  (lines 3086–3096)

```
fn format_exit_messages_skips_zero_usage()
```

**Purpose**: Checks that no token line is printed when token usage is zero.

**Data flow**: It builds a default exit info, calls `format_exit_messages`, and asserts the returned lines are empty.

**Call relations**: This protects `format_exit_messages` output.

*Call graph*: calls 1 internal fn (format_exit_messages); 2 external calls (assert!, default).


##### `tests::format_exit_messages_includes_session_id_for_fatal_exit_without_resume_hint`  (lines 3099–3112)

```
fn format_exit_messages_includes_session_id_for_fatal_exit_without_resume_hint()
```

**Purpose**: Checks that fatal exits still show the session id when no resume hint exists.

**Data flow**: It builds fatal exit info with a thread id, formats messages, and asserts the session-id line.

**Call relations**: This protects fatal-exit behavior in `format_exit_messages`.

*Call graph*: calls 2 internal fn (format_exit_messages, from_string); 3 external calls (assert_eq!, default, Fatal).


##### `tests::format_exit_messages_includes_resume_hint_for_fatal_exit`  (lines 3115–3130)

```
fn format_exit_messages_includes_resume_hint_for_fatal_exit()
```

**Purpose**: Checks that fatal exits prefer a resume hint when one is available.

**Data flow**: It builds sample exit info, marks it fatal, formats messages, and asserts token usage plus resume command text.

**Call relations**: This protects resume guidance in `format_exit_messages`.

*Call graph*: calls 1 internal fn (format_exit_messages); 3 external calls (assert_eq!, sample_exit_info, Fatal).


##### `tests::format_exit_messages_includes_resume_hint_without_color`  (lines 3133–3147)

```
fn format_exit_messages_includes_resume_hint_without_color()
```

**Purpose**: Checks normal resume hint text when color is disabled.

**Data flow**: It builds sample exit info, formats messages without color, and asserts exact text.

**Call relations**: This protects non-colored terminal output.

*Call graph*: calls 1 internal fn (format_exit_messages); 2 external calls (assert_eq!, sample_exit_info).


##### `tests::format_exit_messages_applies_color_when_enabled`  (lines 3150–3158)

```
fn format_exit_messages_applies_color_when_enabled()
```

**Purpose**: Checks that resume commands are colorized when color support is enabled.

**Data flow**: It formats sample exit info with color enabled and asserts the resume line contains an ANSI color escape.

**Call relations**: This protects colored output in `format_exit_messages`.

*Call graph*: calls 1 internal fn (format_exit_messages); 3 external calls (assert!, assert_eq!, sample_exit_info).


##### `tests::format_exit_messages_names_picker_item_when_thread_has_name`  (lines 3161–3174)

```
fn format_exit_messages_names_picker_item_when_thread_has_name()
```

**Purpose**: Checks that resume guidance includes the saved thread name when available.

**Data flow**: It builds sample exit info with a thread name, formats messages, and asserts the picker-style resume hint.

**Call relations**: This protects named-session resume messaging.

*Call graph*: calls 1 internal fn (format_exit_messages); 2 external calls (assert_eq!, sample_exit_info).


##### `tests::resume_model_flag_applies_when_no_root_flags`  (lines 3177–3185)

```
fn resume_model_flag_applies_when_no_root_flags()
```

**Purpose**: Checks that a model flag on `resume` applies to the final TUI config.

**Data flow**: It finalizes resume settings from CLI args and asserts the model and resume picker state.

**Call relations**: This protects `finalize_resume_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_picker_logic_none_and_not_last`  (lines 3188–3194)

```
fn resume_picker_logic_none_and_not_last()
```

**Purpose**: Checks that plain `codex resume` opens the session picker.

**Data flow**: It finalizes resume settings and asserts picker is on, last is off, and no session id is set.

**Call relations**: This protects resume selection logic.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_picker_logic_last`  (lines 3197–3203)

```
fn resume_picker_logic_last()
```

**Purpose**: Checks that `codex resume --last` uses the latest session without opening the picker.

**Data flow**: It finalizes resume settings and asserts last is on, picker is off, and no explicit session id is set.

**Call relations**: This protects resume `--last` behavior.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_last_accepts_prompt_positional`  (lines 3206–3218)

```
fn resume_last_accepts_prompt_positional()
```

**Purpose**: Checks that `resume --last` may treat one positional argument as a prompt.

**Data flow**: It finalizes settings from `--last` plus text and asserts the prompt is stored while no session id is set.

**Call relations**: This protects the special reinterpretation in `finalize_resume_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_last_rejects_explicit_session_and_prompt`  (lines 3221–3227)

```
fn resume_last_rejects_explicit_session_and_prompt()
```

**Purpose**: Checks that `resume --last` rejects both a session id and a prompt.

**Data flow**: It parses the ambiguous command and asserts an argument conflict.

**Call relations**: This protects the parser customization in `SessionTuiCli`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::resume_picker_logic_with_session_id`  (lines 3230–3236)

```
fn resume_picker_logic_with_session_id()
```

**Purpose**: Checks that `codex resume SESSION` targets that session directly.

**Data flow**: It finalizes resume settings and asserts picker and last are off while the session id is set.

**Call relations**: This protects resume selection logic.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_with_session_id_accepts_prompt_positional`  (lines 3239–3247)

```
fn resume_with_session_id_accepts_prompt_positional()
```

**Purpose**: Checks that resume with a session id can also include a prompt.

**Data flow**: It finalizes settings from session id plus prompt and asserts both are stored correctly.

**Call relations**: This protects resume argument handling.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_all_flag_sets_show_all`  (lines 3250–3254)

```
fn resume_all_flag_sets_show_all()
```

**Purpose**: Checks that `resume --all` disables current-directory filtering in the picker.

**Data flow**: It finalizes resume settings and asserts picker is on and show-all is true.

**Call relations**: This protects resume picker option handling.

*Call graph*: 2 external calls (assert!, finalize_resume_from_args).


##### `tests::resume_include_non_interactive_flag_sets_source_filter_override`  (lines 3257–3263)

```
fn resume_include_non_interactive_flag_sets_source_filter_override()
```

**Purpose**: Checks that resume can include non-interactive sessions in selection.

**Data flow**: It finalizes resume settings with the flag and asserts the include-non-interactive field is true.

**Call relations**: This protects resume filtering behavior.

*Call graph*: 2 external calls (assert!, finalize_resume_from_args).


##### `tests::resume_merges_option_flags`  (lines 3266–3320)

```
fn resume_merges_option_flags()
```

**Purpose**: Checks that many resume-scoped runtime flags merge into final interactive settings.

**Data flow**: It parses a resume command with model, profile, sandbox, approval, search, directory, strict config, and images, then asserts all final fields.

**Call relations**: This protects `merge_interactive_cli_flags` and `finalize_resume_interactive`.

*Call graph*: 4 external calls (assert!, assert_eq!, assert_matches!, finalize_resume_from_args).


##### `tests::resume_merges_dangerously_bypass_flag`  (lines 3323–3336)

```
fn resume_merges_dangerously_bypass_flag()
```

**Purpose**: Checks that resume accepts and applies the broad bypass flag.

**Data flow**: It finalizes resume settings with the bypass flag and asserts the final TUI config contains it.

**Call relations**: This protects resume flag merging.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::resume_merges_bypass_hook_trust_flag`  (lines 3339–3348)

```
fn resume_merges_bypass_hook_trust_flag()
```

**Purpose**: Checks that resume applies the hook-trust bypass flag.

**Data flow**: It finalizes resume settings with the hook-trust bypass flag and asserts it is true.

**Call relations**: This protects resume flag merging.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_resume_from_args).


##### `tests::fork_picker_logic_none_and_not_last`  (lines 3351–3357)

```
fn fork_picker_logic_none_and_not_last()
```

**Purpose**: Checks that plain `codex fork` opens a session picker.

**Data flow**: It finalizes fork settings and asserts picker is on, last is off, and no session id is set.

**Call relations**: This protects fork selection logic.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_picker_logic_last`  (lines 3360–3366)

```
fn fork_picker_logic_last()
```

**Purpose**: Checks that `fork --last` uses the latest session without opening the picker.

**Data flow**: It finalizes fork settings and asserts last is on, picker is off, and no session id is set.

**Call relations**: This protects fork `--last` behavior.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_last_accepts_prompt_positional`  (lines 3369–3380)

```
fn fork_last_accepts_prompt_positional()
```

**Purpose**: Checks that `fork --last` may treat one positional argument as a prompt.

**Data flow**: It finalizes fork settings and asserts prompt text is stored while session id stays absent.

**Call relations**: This protects `finalize_fork_interactive`.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_last_rejects_explicit_session_and_prompt`  (lines 3383–3389)

```
fn fork_last_rejects_explicit_session_and_prompt()
```

**Purpose**: Checks that `fork --last` rejects an explicit session plus prompt.

**Data flow**: It parses the ambiguous command and asserts an argument conflict.

**Call relations**: This protects the parser customization in `SessionTuiCli`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::fork_picker_logic_with_session_id`  (lines 3392–3398)

```
fn fork_picker_logic_with_session_id()
```

**Purpose**: Checks that `codex fork SESSION` targets that session directly.

**Data flow**: It finalizes fork settings and asserts picker and last are off while the session id is set.

**Call relations**: This protects fork selection logic.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_with_session_id_accepts_prompt_positional`  (lines 3401–3409)

```
fn fork_with_session_id_accepts_prompt_positional()
```

**Purpose**: Checks that fork with a session id can also include a prompt.

**Data flow**: It finalizes fork settings and asserts both session id and prompt are stored.

**Call relations**: This protects fork argument handling.

*Call graph*: 3 external calls (assert!, assert_eq!, finalize_fork_from_args).


##### `tests::fork_all_flag_sets_show_all`  (lines 3412–3416)

```
fn fork_all_flag_sets_show_all()
```

**Purpose**: Checks that `fork --all` enables showing all sessions in the picker.

**Data flow**: It finalizes fork settings and asserts picker and show-all are true.

**Call relations**: This protects fork picker option handling.

*Call graph*: 2 external calls (assert!, finalize_fork_from_args).


##### `tests::app_server_analytics_default_disabled_without_flag`  (lines 3419–3427)

```
fn app_server_analytics_default_disabled_without_flag()
```

**Purpose**: Checks default app-server startup settings.

**Data flow**: It parses `codex app-server` and asserts analytics default is disabled, remote control startup flag is off, and transport defaults to stdio.

**Call relations**: This protects app-server CLI defaults.

*Call graph*: 3 external calls (assert!, assert_eq!, app_server_from_args).


##### `tests::app_server_remote_control_startup_flag_enables_remote_control`  (lines 3430–3433)

```
fn app_server_remote_control_startup_flag_enables_remote_control()
```

**Purpose**: Checks that the app-server remote-control startup flag parses.

**Data flow**: It parses app-server with `--remote-control` and asserts the field is true.

**Call relations**: This protects app-server startup option parsing.

*Call graph*: 2 external calls (assert!, app_server_from_args).


##### `tests::app_server_analytics_default_enabled_with_flag`  (lines 3436–3440)

```
fn app_server_analytics_default_enabled_with_flag()
```

**Purpose**: Checks that app-server analytics can be default-enabled by flag.

**Data flow**: It parses app-server with `--analytics-default-enabled` and asserts the field is true.

**Call relations**: This protects app-server analytics option parsing.

*Call graph*: 2 external calls (assert!, app_server_from_args).


##### `tests::strict_config_parses_for_supported_commands`  (lines 3443–3476)

```
fn strict_config_parses_for_supported_commands()
```

**Purpose**: Checks that `--strict-config` parses for commands that support it.

**Data flow**: It parses root TUI, mcp-server, review, and exec-server strict-config examples and asserts the flags are set.

**Call relations**: This protects strict-config parser placement.

*Call graph*: 3 external calls (assert!, assert_matches!, try_parse_from).


##### `tests::root_strict_config_is_supported_for_exec_server`  (lines 3479–3485)

```
fn root_strict_config_is_supported_for_exec_server()
```

**Purpose**: Checks that root-level strict config may be inherited by exec-server.

**Data flow**: It parses a root strict exec-server command and asserts the rejection helper succeeds.

**Call relations**: This protects `reject_root_strict_config_for_subcommand`.

*Call graph*: calls 1 internal fn (reject_root_strict_config_for_subcommand); 1 external calls (try_parse_from).


##### `tests::root_strict_config_is_rejected_for_unsupported_subcommands`  (lines 3488–3514)

```
fn root_strict_config_is_rejected_for_unsupported_subcommands()
```

**Purpose**: Checks that unsupported commands reject root-level strict config with clear names.

**Data flow**: It parses strict mcp and remote-control commands, calls the rejection helper, and asserts exact error messages.

**Call relations**: This protects strict-config rejection logic.

*Call graph*: calls 1 internal fn (reject_root_strict_config_for_subcommand); 2 external calls (assert_eq!, try_parse_from).


##### `tests::app_server_subcommands_reject_strict_config`  (lines 3517–3530)

```
fn app_server_subcommands_reject_strict_config()
```

**Purpose**: Checks that app-server tooling subcommands reject strict config.

**Data flow**: It parses app-server proxy with strict config, calls the app-server rejection helper, and asserts the exact error.

**Call relations**: This protects `reject_strict_config_for_app_server_subcommand`.

*Call graph*: calls 1 internal fn (reject_strict_config_for_app_server_subcommand); 2 external calls (assert_eq!, app_server_from_args).


##### `tests::reject_remote_flag_for_remote_control`  (lines 3533–3549)

```
fn reject_remote_flag_for_remote_control()
```

**Purpose**: Checks that remote TUI options are rejected for remote-control tooling.

**Data flow**: It parses a root remote-control command with `--remote`, calls the rejection helper, and asserts the message mentions remote-control.

**Call relations**: This protects `reject_remote_mode_for_subcommand`.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_subcommand); 4 external calls (assert!, assert_eq!, try_parse_from, panic!).


##### `tests::remote_flag_parses_for_interactive_root`  (lines 3552–3556)

```
fn remote_flag_parses_for_interactive_root()
```

**Purpose**: Checks that the root interactive command accepts `--remote`.

**Data flow**: It parses a root command with a Unix remote address and asserts the remote field is set.

**Call relations**: This protects interactive remote parsing.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::remote_auth_token_env_flag_parses_for_interactive_root`  (lines 3559–3572)

```
fn remote_auth_token_env_flag_parses_for_interactive_root()
```

**Purpose**: Checks that the root interactive command accepts a remote auth token environment variable.

**Data flow**: It parses remote auth and remote address flags and asserts the environment variable name is stored.

**Call relations**: This protects interactive remote-auth parsing.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::remote_flag_parses_for_resume_subcommand`  (lines 3575–3585)

```
fn remote_flag_parses_for_resume_subcommand()
```

**Purpose**: Checks that `codex resume` can specify its own remote endpoint.

**Data flow**: It parses a resume command with `--remote` and asserts the resume remote field is set.

**Call relations**: This protects resume remote parsing.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::reject_remote_mode_for_non_interactive_subcommands`  (lines 3588–3599)

```
fn reject_remote_mode_for_non_interactive_subcommands()
```

**Purpose**: Checks that non-interactive commands reject `--remote`.

**Data flow**: It calls the remote rejection helper with a remote address and asserts the error explains the option is only for interactive TUI commands.

**Call relations**: This protects `reject_remote_mode_for_subcommand`.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_subcommand); 1 external calls (assert!).


##### `tests::reject_remote_auth_token_env_for_non_interactive_subcommands`  (lines 3602–3613)

```
fn reject_remote_auth_token_env_for_non_interactive_subcommands()
```

**Purpose**: Checks that non-interactive commands reject `--remote-auth-token-env`.

**Data flow**: It calls the remote rejection helper with an auth-token env var and asserts the error explains the option is only for interactive TUI commands.

**Call relations**: This protects `reject_remote_mode_for_subcommand`.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_subcommand); 1 external calls (assert!).


##### `tests::reject_remote_auth_token_env_for_app_server_generate_internal_json_schema`  (lines 3616–3628)

```
fn reject_remote_auth_token_env_for_app_server_generate_internal_json_schema()
```

**Purpose**: Checks that app-server schema-generation tooling rejects remote auth flags with a precise command name.

**Data flow**: It builds a generate-internal-json-schema subcommand, calls app-server remote rejection, and asserts the error mentions the nested command.

**Call relations**: This protects `reject_remote_mode_for_app_server_subcommand`.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_app_server_subcommand); 3 external calls (from, assert!, GenerateInternalJsonSchema).


##### `tests::read_remote_auth_token_from_env_var_reports_missing_values`  (lines 3631–3637)

```
fn read_remote_auth_token_from_env_var_reports_missing_values()
```

**Purpose**: Checks the error for a missing remote auth token environment variable.

**Data flow**: It calls the injectable environment reader with a fake missing variable and asserts the error says it is not set.

**Call relations**: This protects `read_remote_auth_token_from_env_var_with`.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var_with); 1 external calls (assert!).


##### `tests::read_remote_auth_token_from_env_var_trims_values`  (lines 3640–3647)

```
fn read_remote_auth_token_from_env_var_trims_values()
```

**Purpose**: Checks that remote auth token values are trimmed.

**Data flow**: It calls the injectable environment reader with a value containing spaces and asserts the returned token has no surrounding whitespace.

**Call relations**: This protects token cleanup in `read_remote_auth_token_from_env_var_with`.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var_with); 1 external calls (assert_eq!).


##### `tests::read_remote_auth_token_from_env_var_rejects_empty_values`  (lines 3650–3656)

```
fn read_remote_auth_token_from_env_var_rejects_empty_values()
```

**Purpose**: Checks that whitespace-only remote auth tokens are rejected.

**Data flow**: It calls the injectable environment reader with whitespace and asserts the error says the variable is empty.

**Call relations**: This protects token validation in `read_remote_auth_token_from_env_var_with`.

*Call graph*: calls 1 internal fn (read_remote_auth_token_from_env_var_with); 1 external calls (assert!).


##### `tests::app_server_listen_websocket_url_parses`  (lines 3659–3669)

```
fn app_server_listen_websocket_url_parses()
```

**Purpose**: Checks that app-server WebSocket listen URLs parse correctly.

**Data flow**: It parses an app-server command with a `ws://` listen URL and asserts the transport contains the expected bind address.

**Call relations**: This protects app-server transport parsing.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_listen_stdio_url_parses`  (lines 3672–3679)

```
fn app_server_listen_stdio_url_parses()
```

**Purpose**: Checks that `stdio://` listen URLs select stdio transport.

**Data flow**: It parses the app-server command and asserts the transport is stdio.

**Call relations**: This protects app-server transport parsing.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_stdio_flag_parses`  (lines 3682–3685)

```
fn app_server_stdio_flag_parses()
```

**Purpose**: Checks that the app-server `--stdio` shortcut parses.

**Data flow**: It parses app-server with `--stdio` and asserts the boolean flag is true.

**Call relations**: This protects app-server transport option parsing.

*Call graph*: 2 external calls (assert!, app_server_from_args).


##### `tests::app_server_stdio_flag_conflicts_with_listen`  (lines 3688–3698)

```
fn app_server_stdio_flag_conflicts_with_listen()
```

**Purpose**: Checks that users cannot specify both `--stdio` and `--listen`.

**Data flow**: It parses a command with both flags and asserts an argument conflict.

**Call relations**: This protects app-server parser constraints.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::app_server_listen_unix_socket_url_parses`  (lines 3701–3710)

```
fn app_server_listen_unix_socket_url_parses()
```

**Purpose**: Checks that `unix://` listen URLs use the default control socket path.

**Data flow**: It parses the command and asserts the transport is a Unix socket at the expected default path.

**Call relations**: This protects app-server Unix socket parsing.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_listen_unix_socket_path_parses`  (lines 3713–3724)

```
fn app_server_listen_unix_socket_path_parses()
```

**Purpose**: Checks that explicit Unix socket paths in listen URLs parse correctly.

**Data flow**: It parses a `unix:///tmp/codex.sock` listen URL and asserts the transport contains that absolute path.

**Call relations**: This protects app-server Unix socket parsing.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_listen_off_parses`  (lines 3727–3730)

```
fn app_server_listen_off_parses()
```

**Purpose**: Checks that app-server listen mode can be turned off.

**Data flow**: It parses `--listen off` and asserts the transport is Off.

**Call relations**: This protects app-server transport parsing.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_listen_invalid_url_fails_to_parse`  (lines 3733–3737)

```
fn app_server_listen_invalid_url_fails_to_parse()
```

**Purpose**: Checks that unsupported listen URLs are rejected.

**Data flow**: It parses an app-server command with an HTTP URL and asserts parsing fails.

**Call relations**: This protects app-server transport validation.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::app_server_proxy_subcommand_parses`  (lines 3740–3748)

```
fn app_server_proxy_subcommand_parses()
```

**Purpose**: Checks that `app-server proxy` parses with no socket path.

**Data flow**: It parses the command and asserts the nested subcommand is Proxy with no socket path set.

**Call relations**: This protects app-server proxy command parsing.

*Call graph*: 2 external calls (assert!, app_server_from_args).


##### `tests::app_server_daemon_subcommands_parse`  (lines 3751–3812)

```
fn app_server_daemon_subcommands_parse()
```

**Purpose**: Checks that all app-server daemon lifecycle subcommands parse.

**Data flow**: It parses bootstrap, start, restart, enable/disable remote control, stop, and version commands and asserts each maps to the expected enum variant.

**Call relations**: This protects app-server daemon command routing.

*Call graph*: 1 external calls (assert!).


##### `tests::app_server_proxy_sock_path_parses`  (lines 3815–3828)

```
fn app_server_proxy_sock_path_parses()
```

**Purpose**: Checks that app-server proxy accepts a socket path.

**Data flow**: It parses `app-server proxy --sock codex.sock`, extracts the proxy command, and asserts the path was resolved relative to the current directory.

**Call relations**: This protects `parse_socket_path` as used by proxy parsing.

*Call graph*: 3 external calls (assert_eq!, app_server_from_args, panic!).


##### `tests::reject_remote_auth_token_env_for_app_server_proxy`  (lines 3831–3840)

```
fn reject_remote_auth_token_env_for_app_server_proxy()
```

**Purpose**: Checks that app-server proxy rejects remote auth token flags.

**Data flow**: It builds a proxy subcommand, calls app-server remote rejection, and asserts the error mentions app-server proxy.

**Call relations**: This protects `reject_remote_mode_for_app_server_subcommand`.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_app_server_subcommand); 2 external calls (assert!, Proxy).


##### `tests::reject_remote_auth_token_env_for_app_server_version`  (lines 3843–3854)

```
fn reject_remote_auth_token_env_for_app_server_version()
```

**Purpose**: Checks that app-server daemon version rejects remote auth token flags.

**Data flow**: It builds the daemon version subcommand, calls app-server remote rejection, and asserts the error mentions the nested command.

**Call relations**: This protects `reject_remote_mode_for_app_server_subcommand`.

*Call graph*: calls 1 internal fn (reject_remote_mode_for_app_server_subcommand); 2 external calls (assert!, Daemon).


##### `tests::app_server_capability_token_flags_parse`  (lines 3857–3877)

```
fn app_server_capability_token_flags_parse()
```

**Purpose**: Checks parsing for app-server WebSocket capability-token authentication.

**Data flow**: It parses auth mode and token-file flags and asserts the parsed auth settings match.

**Call relations**: This protects app-server WebSocket auth CLI parsing.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_signed_bearer_flags_parse`  (lines 3880–3909)

```
fn app_server_signed_bearer_flags_parse()
```

**Purpose**: Checks parsing for app-server signed bearer token authentication.

**Data flow**: It parses shared secret, issuer, audience, and clock-skew flags and asserts all fields are stored correctly.

**Call relations**: This protects app-server WebSocket auth CLI parsing.

*Call graph*: 2 external calls (assert_eq!, app_server_from_args).


##### `tests::app_server_rejects_removed_insecure_non_loopback_flag`  (lines 3912–3919)

```
fn app_server_rejects_removed_insecure_non_loopback_flag()
```

**Purpose**: Ensures a removed insecure app-server flag is not accepted.

**Data flow**: It tries to parse the removed flag and asserts parsing fails.

**Call relations**: This protects the app-server CLI from reintroducing unsafe compatibility.

*Call graph*: 2 external calls (assert!, try_parse_from).


##### `tests::features_enable_parses_feature_name`  (lines 3922–3932)

```
fn features_enable_parses_feature_name()
```

**Purpose**: Checks that `features enable` captures the feature name.

**Data flow**: It parses the command, extracts the feature enable arguments, and asserts the feature string.

**Call relations**: This protects feature command parsing.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::features_disable_parses_feature_name`  (lines 3935–3945)

```
fn features_disable_parses_feature_name()
```

**Purpose**: Checks that `features disable` captures the feature name.

**Data flow**: It parses the command, extracts the feature disable arguments, and asserts the feature string.

**Call relations**: This protects feature command parsing.

*Call graph*: 3 external calls (assert_eq!, try_parse_from, panic!).


##### `tests::feature_toggles_known_features_generate_overrides`  (lines 3948–3961)

```
fn feature_toggles_known_features_generate_overrides()
```

**Purpose**: Checks that known `--enable` and `--disable` flags become config overrides.

**Data flow**: It builds a `FeatureToggles` value, calls `to_overrides`, and asserts the generated override strings.

**Call relations**: This protects `FeatureToggles::to_overrides`.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::feature_toggles_accept_legacy_linux_sandbox_flag`  (lines 3964–3974)

```
fn feature_toggles_accept_legacy_linux_sandbox_flag()
```

**Purpose**: Checks that a legacy Linux sandbox feature key is still accepted.

**Data flow**: It builds toggles with the legacy feature, converts to overrides, and asserts the expected override string.

**Call relations**: This protects compatibility in feature-key validation.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `tests::feature_toggles_accept_removed_image_detail_original_flag`  (lines 3977–3987)

```
fn feature_toggles_accept_removed_image_detail_original_flag()
```

**Purpose**: Checks that a removed image-detail feature key is still recognized for compatibility.

**Data flow**: It builds toggles with that feature, converts to overrides, and asserts the generated string.

**Call relations**: This protects feature-key compatibility.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `tests::feature_toggles_unknown_feature_errors`  (lines 3990–3999)

```
fn feature_toggles_unknown_feature_errors()
```

**Purpose**: Checks that unknown feature flags are rejected.

**Data flow**: It builds toggles with a fake feature, calls `to_overrides`, and asserts the error text.

**Call relations**: This protects `FeatureToggles::validate_feature`.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `tests::strict_config_with_unknown_enable_errors`  (lines 4002–4005)

```
fn strict_config_with_unknown_enable_errors()
```

**Purpose**: Checks that strict config plus an unknown `--enable` feature reports the unknown feature.

**Data flow**: It uses the strict-config helper with an unknown enable flag and asserts the error text.

**Call relations**: This protects feature validation during strict root parsing.

*Call graph*: 2 external calls (assert_eq!, strict_config_feature_toggle_error).


##### `tests::strict_config_with_unknown_disable_errors`  (lines 4008–4011)

```
fn strict_config_with_unknown_disable_errors()
```

**Purpose**: Checks that strict config plus an unknown `--disable` feature reports the unknown feature.

**Data flow**: It uses the strict-config helper with an unknown disable flag and asserts the error text.

**Call relations**: This protects feature validation during strict root parsing.

*Call graph*: 2 external calls (assert_eq!, strict_config_feature_toggle_error).


##### `tests::strict_config_with_compound_enable_errors`  (lines 4014–4022)

```
fn strict_config_with_compound_enable_errors()
```

**Purpose**: Checks that compound-looking unknown feature names are rejected as unknown.

**Data flow**: It uses the strict-config helper with a dotted feature name and asserts the exact unknown-feature error.

**Call relations**: This protects feature flag name validation.

*Call graph*: 2 external calls (assert_eq!, strict_config_feature_toggle_error).


##### `tests::strict_config_feature_toggle_error`  (lines 4024–4033)

```
fn strict_config_feature_toggle_error(args: &[&str]) -> anyhow::Error
```

**Purpose**: Test helper that parses strict-config plus feature toggle arguments and returns the validation error.

**Data flow**: It builds full CLI arguments, parses them, asserts strict config is set, then calls `to_overrides` and returns the expected error.

**Call relations**: Strict-config feature toggle tests use this helper.

*Call graph*: 3 external calls (assert!, try_parse_from, once).


### Interactive and task runners
These entrypoints and schemas cover the interactive TUI and cloud-task execution surfaces that users launch directly.

### `tui/src/cli.rs`

`config` · `startup`

This file is the front door for configuring the TUI, meaning the terminal-based interactive interface. When a user runs Codex, they may pass a starting prompt, ask for stricter config checking, enable web search, choose an approval style, or run without the terminal’s alternate screen. This file gives those choices names and shapes so the command-line parser can turn raw text like `--search` into structured Rust data.

Most of the options live in `Cli`, the main command-line settings struct for the TUI. Some fields are public user-facing flags. Others are deliberately hidden with `skip`; these are set by higher-level commands such as `codex resume` or `codex fork`, so the TUI can open, continue, or copy a previous session without exposing those controls on the base command.

The file also wraps shared command-line options in `TuiSharedCliOptions`. That wrapper lets the TUI reuse common Codex flags while adding one TUI-specific rule: the dangerous “bypass approvals and sandbox” option conflicts with the normal approval policy flag. In plain terms, it prevents the user from asking for both “use this approval mode” and “ignore approvals entirely” at the same time.

#### Function details

##### `Cli::deref`  (lines 81–83)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: This lets a `Cli` value be read as if it were its embedded shared command-line options. It is a convenience so other code can access common Codex settings without repeatedly writing through the `shared` field.

**Data flow**: It receives a reference to the full TUI command-line settings. It looks inside the `shared` wrapper and returns a read-only reference to the common `SharedCliOptions` stored there. Nothing is changed.

**Call relations**: This supports code that wants common CLI settings from a `Cli` object. Rather than copying or converting anything, it simply points callers to the shared options already stored inside the TUI CLI structure.


##### `Cli::deref_mut`  (lines 87–89)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: This lets a `Cli` value be changed as if it were its embedded shared command-line options. It is useful when setup code needs to adjust common options after parsing.

**Data flow**: It receives a mutable reference to the full TUI command-line settings. It reaches into the `shared` wrapper and returns a mutable reference to the common `SharedCliOptions`, allowing the caller to edit those shared fields in place.

**Call relations**: This is the writable companion to `Cli::deref`. It fits into startup configuration code that treats TUI-specific settings and shared Codex settings as one combined set of options.


##### `TuiSharedCliOptions::into_inner`  (lines 96–98)

```
fn into_inner(self) -> SharedCliOptions
```

**Purpose**: This unwraps the TUI wrapper and gives back the plain shared command-line options. It is used when later code no longer needs the TUI-specific wrapper.

**Data flow**: It takes ownership of a `TuiSharedCliOptions` value. It removes the outer wrapper and returns the contained `SharedCliOptions`. The wrapper itself is consumed.

**Call relations**: This function is the exit door from the wrapper type. After parsing and TUI-specific command setup are done, other code can call this to work directly with the shared options.


##### `TuiSharedCliOptions::deref`  (lines 104–106)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: This lets the wrapper be read like the shared options it contains. It keeps the wrapper lightweight while still making shared fields easy to access.

**Data flow**: It receives a read-only reference to `TuiSharedCliOptions`. It returns a read-only reference to the inner `SharedCliOptions`. No data is copied or changed.

**Call relations**: This supports the wrapper’s main job: add TUI-specific parsing behavior while still behaving like the shared options in normal use.


##### `TuiSharedCliOptions::deref_mut`  (lines 110–112)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: This lets the wrapper be edited like the shared options it contains. It allows callers to update common settings without manually unpacking the wrapper.

**Data flow**: It receives a mutable reference to `TuiSharedCliOptions`. It returns a mutable reference to the inner `SharedCliOptions`, so changes go directly into the stored shared options.

**Call relations**: This works alongside `TuiSharedCliOptions::deref` to make the wrapper mostly transparent to the rest of the startup code.


##### `TuiSharedCliOptions::augment_args`  (lines 116–118)

```
fn augment_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: This adds the shared Codex command-line flags to the TUI command definition, then applies the TUI’s extra rule about conflicting approval options. It is part of teaching the parser what flags are valid.

**Data flow**: It receives a Clap command builder, which is an object describing accepted command-line arguments. It first asks the shared options type to add its normal arguments, then passes the result to `mark_tui_args` so the TUI-specific conflict rule is added. It returns the updated command builder.

**Call relations**: The command-line parser calls this while building the TUI command. This function delegates the common work to the shared options implementation, then hands the command to `mark_tui_args` for the TUI-only adjustment.

*Call graph*: calls 1 internal fn (mark_tui_args); 1 external calls (augment_args).


##### `TuiSharedCliOptions::augment_args_for_update`  (lines 120–122)

```
fn augment_args_for_update(cmd: clap::Command) -> clap::Command
```

**Purpose**: This updates an existing command definition with shared Codex flags and the TUI-specific conflict rule. It is used in parser flows where arguments are being added to an already-built command.

**Data flow**: It receives a Clap command builder. It asks the shared options type to add update-style argument definitions, then sends that command through `mark_tui_args`. The returned command includes both the shared options and the TUI conflict rule.

**Call relations**: Like `TuiSharedCliOptions::augment_args`, this is called by the argument parsing framework. It follows the same two-step path: shared option setup first, then `mark_tui_args` to adapt the result for the TUI.

*Call graph*: calls 1 internal fn (mark_tui_args); 1 external calls (augment_args_for_update).


##### `TuiSharedCliOptions::from_arg_matches`  (lines 126–128)

```
fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error>
```

**Purpose**: This creates a `TuiSharedCliOptions` value from parsed command-line matches. In other words, it turns the parser’s raw findings into the wrapper type used by the TUI.

**Data flow**: It receives parsed argument matches from Clap. It asks `SharedCliOptions` to read its values from those matches. If that succeeds, it wraps the shared options in `TuiSharedCliOptions`; if parsing fails, it returns the parsing error.

**Call relations**: The parsing framework calls this after command-line text has been matched against known flags. This function relies on the shared options parser, then packages the result in the TUI wrapper.

*Call graph*: 1 external calls (from_arg_matches).


##### `TuiSharedCliOptions::update_from_arg_matches`  (lines 130–132)

```
fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error>
```

**Purpose**: This updates an existing `TuiSharedCliOptions` value using newly parsed command-line matches. It is useful when options are parsed or refreshed in stages.

**Data flow**: It receives a mutable wrapper and parsed argument matches. It forwards those matches to the inner `SharedCliOptions`, which updates itself. The result is either success or a Clap parsing error.

**Call relations**: This keeps the wrapper in sync with Clap’s update flow. Instead of doing its own parsing, it passes the work directly to the shared options stored inside it.


##### `mark_tui_args`  (lines 135–139)

```
fn mark_tui_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: This applies a TUI-specific safety rule to the command-line definition: the dangerous bypass option cannot be used together with the normal approval policy option. It prevents a confusing or unsafe combination of flags.

**Data flow**: It receives a Clap command builder. It finds the shared argument named `dangerously_bypass_approvals_and_sandbox` and marks it as conflicting with `approval_policy`. It returns the modified command builder.

**Call relations**: This helper is called by both TUI argument-building paths: `TuiSharedCliOptions::augment_args` and `TuiSharedCliOptions::augment_args_for_update`. They build the shared argument list first, then call this function to add the TUI’s extra conflict rule before parsing is used.

*Call graph*: called by 2 (augment_args, augment_args_for_update); 1 external calls (mut_arg).


### `tui/src/main.rs`

`entrypoint` · `startup and shutdown`

This is the front door for running the Codex TUI, meaning the terminal-based user interface. Its job is to turn a shell command into a running app, then turn the app’s ending state into clear terminal output.

First, it defines a small wrapper command-line shape, `TopCli`, that combines general configuration overrides with the TUI’s own options. A configuration override is a value passed on the command line to temporarily change settings without editing a config file.

When `main` runs, it uses an `arg0` dispatcher. `arg0` means the name used to launch the program; some tools behave differently depending on that name, like a person answering to different nicknames. Inside that dispatch, it parses the command-line arguments, merges the top-level config overrides into the inner TUI command, and calls `run_main`, which does the real application work.

After the app finishes, this file prints helpful closing information. That may include token usage, a command to resume the session later, or a session ID after a fatal error. It also checks whether the terminal supports color, so the resume command can be highlighted without printing raw color codes into terminals that cannot use them. If the app ended because of a fatal error, it prints the error and exits with status code 1 so scripts and shells can tell the run failed.

#### Function details

##### `format_exit_messages`  (lines 13–39)

```
fn format_exit_messages(exit_info: AppExitInfo, color_enabled: bool) -> Vec<String>
```

**Purpose**: This function turns the app’s final status into short human-readable lines to print after the TUI closes. It decides whether to show token usage, a resume command, or a session ID for troubleshooting.

**Data flow**: It receives an `AppExitInfo`, which is a bundle of facts about how the app ended, plus a yes/no value saying whether colored terminal output is safe. It checks whether the exit was fatal, pulls out token usage, session ID, and resume instructions, then builds a list of text lines. The result is a vector of strings ready to print; it does not print them itself.

**Call relations**: After `main` gets the final app result from `run_main`, it calls this helper to prepare the closing messages. This keeps the printing decision simple in `main`: `main` only loops over the returned lines and writes them to standard output.

*Call graph*: 3 external calls (new, format!, matches!).


##### `main`  (lines 50–83)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: This is the program’s main entry point. It parses command-line input, starts the Codex TUI, prints final information, and returns an error status if the run failed badly.

**Data flow**: It starts with the process arguments supplied by the shell. It parses them into `TopCli`, moves top-level configuration overrides into the inner TUI command, and passes that command plus launch-path information into `run_main`. When the app returns exit information, `main` prints any fatal error, asks whether stdout supports color, prints formatted exit messages, flushes stdout if needed, and exits with code 1 for fatal failures or success otherwise.

**Call relations**: The first thing it does is hand control to `arg0_dispatch_or_else`, which decides how to launch based on the executable name and then runs the async startup block. Inside that block, `main` calls the TUI’s `run_main` to do the real app work, then calls `format_exit_messages` to translate the app’s final state into user-facing closing text.

*Call graph*: 1 external calls (arg0_dispatch_or_else).


### `exec/src/cli.rs`

`config` · `startup / command-line parsing`

This file is the front door for the non-interactive `codex exec` command. Its job is to describe the command-line interface in one place, so the argument parser can turn text typed in a terminal into structured Rust values the program can use. Without this file, the exec tool would not know which options are valid, how to read a prompt, how to resume an old session, or how to start a review.

The main `Cli` structure lists top-level options such as strict config checking, whether to skip the Git repository check, whether to avoid saving session files, JSON output, color behavior, and where to write the final message. It also accepts subcommands: `resume`, for continuing an earlier conversation, and `review`, for asking Codex to review code changes.

A small wrapper, `ExecSharedCliOptions`, reuses shared options from the wider Codex command-line code, but marks some of them as “global,” meaning they still work even when placed after a subcommand. This is like allowing a theatre ticket to be checked at either the front door or the room door.

The `ResumeArgs` logic fixes one awkward case the parser cannot express by itself: with `--last`, a positional value should be treated as a prompt, not a session id. The file also keeps a hidden compatibility flag for the removed `--full-auto` option, so users get a helpful warning instead of confusing behavior.

#### Function details

##### `Cli::deref`  (lines 91–93)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: This lets a `Cli` value be used as if it were its shared command-line options. It is a convenience so other code can read common options without first digging through the `shared` field.

**Data flow**: It receives a reference to the full parsed `Cli` value. It looks inside the wrapped shared options and returns a reference to the underlying shared option structure; it does not change anything.

**Call relations**: After command-line parsing has produced a `Cli`, any later code that expects the common shared options can rely on this shortcut instead of manually accessing `cli.shared.0`.


##### `Cli::deref_mut`  (lines 97–99)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: This lets code modify the shared command-line options through a mutable `Cli` value. It is the writable version of the same convenience provided by `Cli::deref`.

**Data flow**: It receives a mutable reference to the full `Cli`. It returns a mutable reference to the underlying shared options, allowing the caller to update those shared settings in place.

**Call relations**: It fits into setup code that may adjust parsed command-line settings before the exec command actually runs.


##### `Cli::removed_full_auto_warning`  (lines 103–111)

```
fn removed_full_auto_warning(&self) -> Option<&'static str>
```

**Purpose**: This checks whether the user typed the old hidden `--full-auto` flag and, if so, returns a warning telling them what to use instead. It preserves a friendlier upgrade path for people with old scripts or habits.

**Data flow**: It reads the `removed_full_auto` boolean from the parsed command line. If the flag was present, it returns a fixed warning message; otherwise it returns no message.

**Call relations**: After parsing, startup code can call this to decide whether to print a compatibility warning before continuing with the requested exec behavior.


##### `ExecSharedCliOptions::into_inner`  (lines 118–120)

```
fn into_inner(self) -> SharedCliOptions
```

**Purpose**: This unwraps `ExecSharedCliOptions` and gives back the shared command-line options it contains. It is used when the caller no longer needs the exec-specific wrapper.

**Data flow**: It takes ownership of the wrapper. It removes the outer layer and returns the inner `SharedCliOptions` value unchanged.

**Call relations**: Once parsing and exec-specific argument setup are finished, later code can call this to pass the common options into shared configuration-loading or runtime code.


##### `ExecSharedCliOptions::deref`  (lines 126–128)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: This lets the exec-specific wrapper be read like the shared options it contains. It avoids repetitive wrapper-unwrapping code.

**Data flow**: It receives a reference to `ExecSharedCliOptions`. It returns a reference to the inner `SharedCliOptions`; nothing is copied or changed.

**Call relations**: Code that works with common Codex options can use this wrapper naturally during command setup and validation.


##### `ExecSharedCliOptions::deref_mut`  (lines 132–134)

```
fn deref_mut(&mut self) -> &mut Self::Target
```

**Purpose**: This lets code edit the shared options inside the exec-specific wrapper. It is useful when the parser or setup code needs to update common settings in place.

**Data flow**: It receives a mutable reference to the wrapper. It returns a mutable reference to the inner shared options so the caller can change them.

**Call relations**: It supports the argument parsing and update flow by making `ExecSharedCliOptions` behave like the shared options it wraps.


##### `ExecSharedCliOptions::augment_args`  (lines 138–140)

```
fn augment_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: This tells the command-line parser how to add the shared Codex options to the `codex exec` command, with a few of them made usable anywhere in the command. In command-line parser terms, these are “global” flags, meaning they apply even when typed after a subcommand.

**Data flow**: It receives a partially built parser command. It asks the shared options code to add its usual arguments, then passes that parser through `mark_exec_global_args` to mark selected options as global, and returns the updated parser.

**Call relations**: The parser-building process calls this while constructing the `codex exec` interface. It hands off to the shared option builder first, then to `mark_exec_global_args` for exec-specific tweaks.

*Call graph*: calls 1 internal fn (mark_exec_global_args); 1 external calls (augment_args).


##### `ExecSharedCliOptions::augment_args_for_update`  (lines 142–144)

```
fn augment_args_for_update(cmd: clap::Command) -> clap::Command
```

**Purpose**: This is the update-mode version of `augment_args`: it teaches the parser how to update existing shared exec options from new matches. It applies the same exec-specific global-flag behavior.

**Data flow**: It receives a parser command used for updating arguments. It lets the shared options code add update-capable arguments, then marks selected arguments as global, and returns the modified parser.

**Call relations**: When the command-line parser needs to support updating an existing options value, it calls this. The function again delegates the common work to shared code and uses `mark_exec_global_args` for the exec-specific adjustment.

*Call graph*: calls 1 internal fn (mark_exec_global_args); 1 external calls (augment_args_for_update).


##### `ExecSharedCliOptions::from_arg_matches`  (lines 148–150)

```
fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error>
```

**Purpose**: This builds `ExecSharedCliOptions` from the parser’s raw results. It converts matched command-line text into the shared options wrapper used by this exec command.

**Data flow**: It receives `ArgMatches`, which are the parser’s structured record of what the user typed. It asks `SharedCliOptions` to parse its own fields, wraps the result in `ExecSharedCliOptions`, and returns either that wrapper or a parse error.

**Call relations**: The command-line parser calls this after matching arguments. This function relies on the shared options parser so exec does not duplicate common option parsing.

*Call graph*: 1 external calls (from_arg_matches).


##### `ExecSharedCliOptions::update_from_arg_matches`  (lines 152–154)

```
fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error>
```

**Purpose**: This updates an existing `ExecSharedCliOptions` value using newly parsed command-line matches. It is used when the parser needs to refresh an already-created options object.

**Data flow**: It receives a mutable wrapper and parser matches. It passes the matches to the inner `SharedCliOptions`, which updates itself or reports a parsing error.

**Call relations**: This is part of the parser’s update path. Rather than replacing the wrapper itself, it lets the inner shared options object apply the changes.


##### `mark_exec_global_args`  (lines 157–163)

```
fn mark_exec_global_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: This marks a small set of shared options as global for `codex exec`, so users can type them before or after a subcommand. It makes the command-line experience more forgiving and consistent.

**Data flow**: It receives a parser command that already contains arguments. It finds the `model`, `dangerously_bypass_approvals_and_sandbox`, and `bypass_hook_trust` arguments, marks each one as global, and returns the changed parser command.

**Call relations**: Both `ExecSharedCliOptions::augment_args` and `ExecSharedCliOptions::augment_args_for_update` call this after the shared options have been added. It performs the exec-specific finishing touch on the parser definition.

*Call graph*: called by 2 (augment_args, augment_args_for_update); 1 external calls (mut_arg).


##### `ResumeArgs::from`  (lines 226–241)

```
fn from(raw: ResumeArgsRaw) -> Self
```

**Purpose**: This converts the raw parser shape for `resume` into the cleaner form the rest of the program wants. Its key job is to reinterpret a positional value as a prompt when the user says `--last` and did not provide a separate prompt.

**Data flow**: It receives `ResumeArgsRaw`, which directly reflects what the command-line parser can express. If `--last` is set and there is no explicit prompt, it moves the positional `session_id` value into `prompt` and clears `session_id`; otherwise it keeps both values as parsed. It then returns a `ResumeArgs` value with the corrected meaning.

**Call relations**: The parser first creates `ResumeArgsRaw`. `ResumeArgs::from_arg_matches` and `ResumeArgs::update_from_arg_matches` then call this conversion so the rest of the resume flow sees the intended session id, prompt, image list, and flags.


##### `ResumeArgs::augment_args`  (lines 245–247)

```
fn augment_args(cmd: clap::Command) -> clap::Command
```

**Purpose**: This tells the command-line parser which arguments the `resume` subcommand accepts. It delegates to the raw resume argument shape because that is the form the parser can describe directly.

**Data flow**: It receives a parser command for the `resume` subcommand. It passes that command to `ResumeArgsRaw`’s argument builder and returns the resulting command.

**Call relations**: During parser construction, this function supplies the visible `resume` options and positional values. The later conversion step fixes the conditional meaning that the parser cannot express on its own.

*Call graph*: 1 external calls (augment_args).


##### `ResumeArgs::augment_args_for_update`  (lines 249–251)

```
fn augment_args_for_update(cmd: clap::Command) -> clap::Command
```

**Purpose**: This is the update-mode parser builder for `resume` arguments. It keeps the parser’s update behavior aligned with the same raw resume argument layout.

**Data flow**: It receives a parser command meant for updating argument values. It delegates to `ResumeArgsRaw`’s update argument builder and returns the updated command.

**Call relations**: The command-line parser uses this when it needs to update an existing `ResumeArgs` value. As with normal parsing, the raw shape is built first and later converted into the cleaned-up `ResumeArgs` form.

*Call graph*: 1 external calls (augment_args_for_update).


##### `ResumeArgs::from_arg_matches`  (lines 255–257)

```
fn from_arg_matches(matches: &clap::ArgMatches) -> Result<Self, clap::Error>
```

**Purpose**: This builds a clean `ResumeArgs` value from the parser’s matched command-line input. It makes sure the special `--last` positional-value rule is applied before other code sees the result.

**Data flow**: It receives parser matches. It first parses them into `ResumeArgsRaw`; if that succeeds, it converts the raw value through `ResumeArgs::from` and returns the cleaned `ResumeArgs`, otherwise it returns the parser error.

**Call relations**: After the user runs `codex exec resume ...`, the parser calls this to produce the resume settings. It hands off raw parsing to `ResumeArgsRaw` and meaning-correction to `ResumeArgs::from`.

*Call graph*: 1 external calls (from_arg_matches).


##### `ResumeArgs::update_from_arg_matches`  (lines 259–262)

```
fn update_from_arg_matches(&mut self, matches: &clap::ArgMatches) -> Result<(), clap::Error>
```

**Purpose**: This replaces an existing `ResumeArgs` value with one newly parsed from command-line matches. It ensures updates use the same special `--last` interpretation as first-time parsing.

**Data flow**: It receives a mutable `ResumeArgs` and parser matches. It parses the matches into `ResumeArgsRaw`, converts that into a cleaned `ResumeArgs`, stores it over the old value, and returns success or a parsing error.

**Call relations**: This is used by the parser’s update flow for the `resume` subcommand. It reuses the same raw parsing and conversion path so updated resume arguments behave exactly like freshly parsed ones.

*Call graph*: 1 external calls (from_arg_matches).


### `cloud-tasks/src/cli.rs`

`config` · `startup command-line parsing`

This file is the front door for the cloud-tasks command-line interface. It describes, in one place, the commands a user can run: submit a task, check its status, list tasks, apply a task’s changes locally, or show a task’s diff. It uses clap, a Rust library that turns typed terminal arguments into structured Rust data. In everyday terms, clap is like a receptionist: it reads what the user said at the door, checks that it fits the expected form, and hands the rest of the program a neat form instead of a raw sentence.

The main `Cli` type represents the whole command. The `Command` enum lists the possible subcommands. Each subcommand has its own small struct containing only the options it needs, such as a task id, environment id, branch name, pagination cursor, or whether output should be JSON.

Two helper functions protect the program from unreasonable numeric input. `parse_attempts` only allows attempt counts from 1 to 4, and `parse_limit` only allows list sizes from 1 to 20. Without these checks, later code would need to guard against invalid values or might ask the cloud service for something the interface does not support.

#### Function details

##### `parse_attempts`  (lines 52–61)

```
fn parse_attempts(input: &str) -> Result<usize, String>
```

**Purpose**: This function checks the user’s requested number of task attempts. It makes sure the value is a whole number and stays within the allowed range of 1 through 4.

**Data flow**: It receives text from a command-line flag, such as `--attempts 3` or `--attempt 2`. It tries to turn that text into a number, then checks whether the number is between 1 and 4. If the input is valid, it returns the number; if not, it returns a clear error message that clap can show to the user.

**Call relations**: During command-line parsing, clap calls this function for fields that use attempt counts, such as creating a task with multiple assistant attempts or choosing which attempt to apply or display. Once this function approves the value, the parsed command structs carry a safe number to the later task-running, diff, or apply logic.


##### `parse_limit`  (lines 63–72)

```
fn parse_limit(input: &str) -> Result<i64, String>
```

**Purpose**: This function checks the maximum number of cloud tasks the user wants to list. It keeps the list size reasonable by allowing only whole numbers from 1 through 20.

**Data flow**: It receives the text written after the list command’s `--limit` flag. It parses that text into a number, verifies that the number falls between 1 and 20, and then returns it. If the text is not a number or is outside the allowed range, it returns an explanatory error message instead.

**Call relations**: Clap calls this function while parsing the list command. If the value passes, the list command receives a valid limit to send into the task-listing flow; if it fails, parsing stops early and the user sees the validation error before any cloud request is made.


### `cloud-tasks/src/lib.rs`

`entrypoint` · `startup, command execution, and interactive main loop`

This file is the central coordinator for Cloud Tasks. A Cloud Task is work created in a remote Codex environment, such as asking Codex to make a code change and then reviewing or applying the result locally. Without this file, the `codex cloud` command would not know how to sign in, talk to the backend service, pick an environment, create tasks, show task status, fetch diffs, or run the full-screen terminal interface.

The file starts by setting up a backend connection. In normal use this is an authenticated HTTP client; in debug builds it can use a mock client for local development. It also chooses a user-agent string, loads ChatGPT login information, and stops early with a clear message if the user is not signed in.

For one-shot commands, it provides small flows: create a task from a prompt, list tasks, check one task’s status, print a diff, or apply a diff. These flows share helper code for parsing task IDs, reading prompts from arguments or standard input, resolving environment names, and choosing the right Git branch.

For interactive use, `run_main` builds a terminal user interface. It listens for keyboard events, starts background tasks for slow network work, receives app events through channels, and redraws only when needed. Think of it like an air traffic controller: the UI, backend calls, spinners, modals, and user keystrokes all move at different speeds, and this file keeps them from colliding.

#### Function details

##### `init_backend`  (lines 43–107)

```
async fn init_backend(user_agent_suffix: &str) -> anyhow::Result<BackendContext>
```

**Purpose**: Creates the connection object used to talk to Cloud Tasks. It also checks whether the user is signed in and makes sure requests carry the right identity and user-agent information.

**Data flow**: It takes a short label describing which part of the cloud feature is running. It reads environment variables, sets the user-agent suffix, optionally chooses a mock backend in debug mode, loads saved authentication, attaches authentication to the HTTP client, logs useful startup details, and returns a backend context containing the backend object and base URL. If the user is not signed in correctly, it prints guidance and exits.

**Call relations**: All command flows and the interactive UI call this before doing cloud work. It hands back the shared backend that later functions use for creating, listing, reading, and applying tasks.

*Call graph*: calls 5 internal fn (new, append_error_log, load_auth_manager, set_user_agent_suffix, get_codex_user_agent); called by 6 (run_apply_command, run_diff_command, run_exec_command, run_list_command, run_main, run_status_command); 7 external calls (new, auth_provider_from_auth, eprintln!, format!, matches!, var, exit).


##### `RealGitInfo::default_branch_name`  (lines 124–126)

```
async fn default_branch_name(&self, path: &std::path::Path) -> Option<String>
```

**Purpose**: Asks Git what the repository’s default branch is, such as `main` or `master`.

**Data flow**: It receives a filesystem path, passes that path to the Git utility function, and returns the branch name if Git can find one.

**Call relations**: It is the real implementation behind the Git information interface. `resolve_git_ref_with_git_info` uses it when there is no explicit branch and no current branch could be found.

*Call graph*: 1 external calls (default_branch_name).


##### `RealGitInfo::current_branch_name`  (lines 128–130)

```
async fn current_branch_name(&self, path: &std::path::Path) -> Option<String>
```

**Purpose**: Asks Git which branch the current checkout is on.

**Data flow**: It receives a filesystem path, asks the Git helper for the current branch at that path, and returns the branch name if available.

**Call relations**: It is used by `resolve_git_ref_with_git_info` through the `RealGitInfo` provider. Tests replace it with a stub so branch-choice behavior can be checked without a real Git repository.

*Call graph*: 1 external calls (current_branch_name).


##### `resolve_git_ref`  (lines 133–135)

```
async fn resolve_git_ref(branch_override: Option<&String>) -> String
```

**Purpose**: Chooses the Git branch name to send when creating a cloud task.

**Data flow**: It receives an optional branch override from the user. It delegates the actual decision to `resolve_git_ref_with_git_info` using real Git lookups, and returns the chosen branch name.

**Call relations**: `run_exec_command` calls this before creating a task. It is a thin production wrapper around the more testable branch-resolution function.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); called by 1 (run_exec_command).


##### `resolve_git_ref_with_git_info`  (lines 137–159)

```
async fn resolve_git_ref_with_git_info(
    branch_override: Option<&String>,
    git_info: &impl GitInfoProvider,
) -> String
```

**Purpose**: Decides which branch name should be used, with a clear fallback order.

**Data flow**: It first checks whether the user supplied a non-empty branch override. If not, it looks at the current working directory, asks for the current Git branch, then the default branch, and finally falls back to `main` if nothing else is known.

**Call relations**: `resolve_git_ref` uses this in normal operation. The branch-related tests call it directly with fake Git information to confirm each fallback path.

*Call graph*: called by 6 (resolve_git_ref, branch_override_is_used_when_provided, falls_back_to_current_branch_when_default_is_missing, falls_back_to_main_when_no_git_info_is_available, prefers_current_branch_when_available, trims_override_whitespace); 3 external calls (current_branch_name, default_branch_name, current_dir).


##### `run_exec_command`  (lines 161–184)

```
async fn run_exec_command(args: crate::cli::ExecCommand) -> anyhow::Result<()>
```

**Purpose**: Implements the non-interactive command that creates a new cloud task and prints its URL.

**Data flow**: It receives command arguments containing the prompt, environment, optional branch, and attempt count. It connects to the backend, reads the prompt from the argument or standard input, resolves the environment and branch, creates the task remotely, builds a web URL for it, and prints that URL.

**Call relations**: `run_main` dispatches here when the user runs the `exec` subcommand. It relies on the backend initializer, input reader, environment resolver, branch resolver, and cloud client task creation call.

*Call graph*: calls 5 internal fn (init_backend, resolve_environment_id, resolve_git_ref, resolve_query_input, task_url); called by 1 (run_main); 2 external calls (create_task, println!).


##### `resolve_environment_id`  (lines 186–229)

```
async fn resolve_environment_id(ctx: &BackendContext, requested: &str) -> anyhow::Result<String>
```

**Purpose**: Turns what the user typed for an environment into the exact environment ID expected by the backend.

**Data flow**: It receives the backend context and a requested environment string. It trims the string, fetches the available environments, then matches either an exact ID or a case-insensitive label. It returns the matching ID, or an understandable error if none or several different matches are found.

**Call relations**: `run_exec_command` uses this before creating a task, and `run_list_command` uses it when filtering tasks. It calls the environment-detection module to get the current list of environments.

*Call graph*: calls 3 internal fn (list_environments, build_chatgpt_headers, normalize_base_url); called by 2 (run_exec_command, run_list_command); 1 external calls (anyhow!).


##### `resolve_query_input`  (lines 231–256)

```
fn resolve_query_input(query_arg: Option<String>) -> anyhow::Result<String>
```

**Purpose**: Gets the text prompt for a new cloud task from either the command line or standard input.

**Data flow**: It receives an optional query argument. If a normal string is present, it returns that. If the argument is `-`, or if input is being piped in, it reads all of standard input. It rejects missing or empty input with a clear error.

**Call relations**: `run_exec_command` calls this so users can create tasks either with `codex cloud exec "..."` or by piping longer text into the command.

*Call graph*: called by 1 (run_exec_command); 5 external calls (new, anyhow!, eprintln!, matches!, stdin).


##### `parse_task_id`  (lines 258–277)

```
fn parse_task_id(raw: &str) -> anyhow::Result<codex_cloud_tasks_client::TaskId>
```

**Purpose**: Accepts either a raw task ID or a full task URL and extracts the task ID.

**Data flow**: It receives a string, trims it, removes any URL fragment or query string, takes the last path segment if it looks like a URL, and wraps the result as a `TaskId`. Empty input becomes an error.

**Call relations**: The status, diff, and apply commands all use this so users can paste either `task_...` or a browser URL. Tests also check that both forms work.

*Call graph*: called by 5 (run_apply_command, run_diff_command, run_status_command, collect_attempt_diffs_includes_sibling_attempts, parse_task_id_from_url_and_raw); 2 external calls (bail!, TaskId).


##### `cmp_attempt`  (lines 286–298)

```
fn cmp_attempt(lhs: &AttemptDiffData, rhs: &AttemptDiffData) -> Ordering
```

**Purpose**: Defines the order for multiple attempts of the same task.

**Data flow**: It receives two attempt records. It compares their explicit placement numbers first, then their creation times if placement is missing, and returns which one should come first.

**Call relations**: `collect_attempt_diffs` uses this after gathering diffs from the main task and sibling attempts, so attempt selection is stable and human-friendly.


##### `collect_attempt_diffs`  (lines 300–341)

```
async fn collect_attempt_diffs(
    backend: &dyn codex_cloud_tasks_client::CloudBackend,
    task_id: &codex_cloud_tasks_client::TaskId,
) -> anyhow::Result<Vec<AttemptDiffData>>
```

**Purpose**: Fetches all available diffs for a task, including alternate attempts, and sorts them.

**Data flow**: It receives a backend and task ID. It fetches task text metadata, fetches the main task diff if present, then asks for sibling attempts when a turn ID is available. It keeps only attempts with diffs, sorts them, and returns the list. If no diff exists, it returns an error saying the task may still be running.

**Call relations**: The `diff` and `apply` commands call this before choosing which attempt to print or apply. A test uses the mock backend to confirm sibling attempts are included.

*Call graph*: called by 3 (run_apply_command, run_diff_command, collect_attempt_diffs_includes_sibling_attempts); 6 external calls (new, bail!, get_task_diff, get_task_text, list_sibling_attempts, clone).


##### `select_attempt`  (lines 343–361)

```
fn select_attempt(
    attempts: &[AttemptDiffData],
    attempt: Option<usize>,
) -> anyhow::Result<&AttemptDiffData>
```

**Purpose**: Picks one attempt from a list using the user’s one-based attempt number.

**Data flow**: It receives the collected attempts and an optional attempt number. If no number is supplied, it chooses attempt 1. It converts the human-friendly number to a zero-based index, checks bounds, and returns the selected attempt or an error.

**Call relations**: `run_diff_command` and `run_apply_command` use this after `collect_attempt_diffs`. The bounds-checking behavior is covered by a test.

*Call graph*: called by 3 (run_apply_command, run_diff_command, select_attempt_validates_bounds); 3 external calls (bail!, is_empty, len).


##### `task_status_label`  (lines 363–370)

```
fn task_status_label(status: &TaskStatus) -> &'static str
```

**Purpose**: Converts an internal task status into the short uppercase text shown to users.

**Data flow**: It receives a task status value and returns labels such as `PENDING`, `READY`, `APPLIED`, or `ERROR`.

**Call relations**: `format_task_status_lines` calls it when building human-readable status output.

*Call graph*: called by 1 (format_task_status_lines).


##### `summary_line`  (lines 372–409)

```
fn summary_line(summary: &codex_cloud_tasks_client::DiffSummary, colorize: bool) -> String
```

**Purpose**: Builds the small diff summary line shown under a task, such as added lines, removed lines, and changed files.

**Data flow**: It receives a diff summary and a color setting. If there is no diff, it returns `no diff`. Otherwise it formats added and removed line counts and file count, optionally coloring additions green, deletions red, and secondary text dim.

**Call relations**: `format_task_status_lines` uses it as the third line of each task summary.

*Call graph*: called by 1 (format_task_status_lines); 1 external calls (format!).


##### `format_task_status_lines`  (lines 411–476)

```
fn format_task_status_lines(
    task: &codex_cloud_tasks_client::TaskSummary,
    now: chrono::DateTime<Utc>,
    colorize: bool,
) -> Vec<String>
```

**Purpose**: Turns one task summary into the few lines of text shown in status and list output.

**Data flow**: It receives a task, the current time, and whether color is allowed. It formats the status and title, chooses an environment label or ID, calculates a relative update time, adds a diff summary, and returns the resulting lines.

**Call relations**: `run_status_command` prints these lines for one task, while `format_task_list_lines` uses them for every task in a list. Tests verify the plain-text output.

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

**Purpose**: Formats a whole page of tasks for command-line display.

**Data flow**: It receives task summaries, the base URL, current time, and color setting. For each task it builds the web URL, indents the status lines, and inserts blank lines between tasks.

**Call relations**: `run_list_command` calls this when the user wants normal text output rather than JSON. A test checks that URLs and status blocks are arranged correctly.

*Call graph*: calls 2 internal fn (format_task_status_lines, task_url); called by 2 (run_list_command, format_task_list_lines_formats_urls); 5 external calls (new, new, iter, len, format!).


##### `run_status_command`  (lines 497–511)

```
async fn run_status_command(args: crate::cli::StatusCommand) -> anyhow::Result<()>
```

**Purpose**: Implements the command that checks one task’s current status.

**Data flow**: It connects to the backend, parses the task ID, fetches the task summary, formats it, and prints it. If the task is not ready, it exits with a failure code so scripts can detect that the task is not done yet.

**Call relations**: `run_main` dispatches here for the `status` subcommand. It reuses task ID parsing, backend setup, and status formatting.

*Call graph*: calls 3 internal fn (format_task_status_lines, init_backend, parse_task_id); called by 1 (run_main); 6 external calls (now, get_task_summary, matches!, println!, exit, on).


##### `run_list_command`  (lines 513–578)

```
async fn run_list_command(args: crate::cli::ListCommand) -> anyhow::Result<()>
```

**Purpose**: Implements the command that lists cloud tasks, optionally filtered by environment.

**Data flow**: It connects to the backend, resolves an environment filter if provided, fetches a page of tasks, and then either prints JSON or readable text. If another page exists, it prints the command needed to fetch it.

**Call relations**: `run_main` dispatches here for the `list` subcommand. It combines backend listing, environment resolution, text formatting, and JSON output.

*Call graph*: calls 3 internal fn (format_task_list_lines, init_backend, resolve_environment_id); called by 1 (run_main); 6 external calls (now, list_tasks, format!, println!, json!, on).


##### `run_diff_command`  (lines 580–587)

```
async fn run_diff_command(args: crate::cli::DiffCommand) -> anyhow::Result<()>
```

**Purpose**: Implements the command that prints a task’s diff to standard output.

**Data flow**: It connects to the backend, parses the task ID, collects all available attempt diffs, selects the requested attempt, and prints the raw diff text.

**Call relations**: `run_main` dispatches here for the `diff` subcommand. It depends on the shared attempt collection and selection helpers.

*Call graph*: calls 4 internal fn (collect_attempt_diffs, init_backend, parse_task_id, select_attempt); called by 1 (run_main); 1 external calls (print!).


##### `run_apply_command`  (lines 589–608)

```
async fn run_apply_command(args: crate::cli::ApplyCommand) -> anyhow::Result<()>
```

**Purpose**: Implements the command that applies a task’s diff outside the interactive UI.

**Data flow**: It connects to the backend, parses the task ID, collects attempt diffs, chooses the requested attempt, sends that diff to the backend’s apply operation, and prints the result message. If applying did not fully succeed, it exits with failure.

**Call relations**: `run_main` dispatches here for the `apply` subcommand. The interactive UI has separate background helpers for apply and preflight, but this command follows the same basic idea synchronously.

*Call graph*: calls 4 internal fn (collect_attempt_diffs, init_backend, parse_task_id, select_attempt); called by 1 (run_main); 4 external calls (apply_task, matches!, println!, exit).


##### `level_from_status`  (lines 610–616)

```
fn level_from_status(status: codex_cloud_tasks_client::ApplyStatus) -> app::ApplyResultLevel
```

**Purpose**: Converts a backend apply result into the simpler result level used by the UI.

**Data flow**: It receives an apply status from the cloud client and maps it to a UI level: success, partial, or error.

**Call relations**: `spawn_preflight` uses this when turning a backend preflight response into an app event for the terminal UI.

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

**Purpose**: Starts a background dry-run check before applying a diff in the interactive UI.

**Data flow**: It receives the app state, backend, event channel, redraw channel, task title, and apply job. It first refuses to start if another apply or preflight is already running. Otherwise it marks preflight as in progress, schedules a redraw, spawns an asynchronous task, calls the backend preflight API, and sends a finished event with the message, level, skipped paths, and conflicts.

**Call relations**: The UI calls this when the user asks to apply a task or presses the preflight key in the apply modal. It reports back through `AppEvent::ApplyPreflightFinished`, which `run_main` later consumes.

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

**Purpose**: Starts the real apply operation in the background from the interactive UI.

**Data flow**: It receives the app state, backend, channels, and apply job. It refuses to start if an apply or preflight is already running, marks apply as in progress, schedules a redraw, spawns an asynchronous task, calls the backend apply API, and sends an `ApplyFinished` event with either the outcome or an error string.

**Call relations**: The apply confirmation modal in `run_main` calls this after the user confirms. The event it sends is later handled in the main UI loop to update status, close modals, and refresh the task list after success.

*Call graph*: 7 external calls (from_millis, now, clone, send, apply_task, format!, spawn).


##### `run_main`  (lines 735–2020)

```
async fn run_main(cli: Cli, _codex_linux_sandbox_exe: Option<PathBuf>) -> anyhow::Result<()>
```

**Purpose**: Runs the `codex cloud` subcommand, either by dispatching a one-shot command or by launching the full interactive terminal UI.

**Data flow**: It receives parsed CLI options. If a subcommand is present, it forwards to the matching command runner. Otherwise it sets up logging, initializes the backend, switches the terminal into full-screen raw mode, creates app state, starts background loads for tasks and environments, listens for keyboard and paste events, receives backend results through channels, updates state, redraws the UI, and finally restores the terminal before returning.

**Call relations**: This is the main hub of the file. It calls the command runners for non-interactive use, and for interactive use it coordinates `app`, `ui`, environment detection, task loading, diff loading, preflight/apply helpers, and terminal event handling.

*Call graph*: calls 13 internal fn (new, load_tasks, autodetect_environment_id, list_environments, init_backend, run_apply_command, run_diff_command, run_exec_command, run_list_command, run_status_command (+3 more)); 21 external calls (clone, new, try_from_default_env, new, now, from_std, EnvironmentAutodetected, EnvironmentsLoaded, execute!, format! (+11 more)).


##### `conversation_lines`  (lines 2025–2049)

```
fn conversation_lines(prompt: Option<String>, messages: &[String]) -> Vec<String>
```

**Purpose**: Turns a prompt and assistant messages into simple labeled text for the task details view.

**Data flow**: It receives an optional user prompt and a list of assistant messages. It writes `user:` followed by prompt lines, then `assistant:` followed by message lines, with blank lines where helpful. If there is nothing to show, it returns `<no output>`.

**Call relations**: `run_main` uses this when backend task text arrives, so the details overlay can show the conversation in a readable form.

*Call graph*: 2 external calls (new, new).


##### `pretty_lines_from_error`  (lines 2053–2129)

```
fn pretty_lines_from_error(raw: &str) -> Vec<String>
```

**Purpose**: Turns a noisy backend error into a few useful lines for the UI.

**Data flow**: It receives a raw error string. It first chooses a friendly headline, then tries to find and parse an embedded JSON body for assistant error details, status, or latest event text. If parsing fails, it includes a shortened raw message; if the task is still in progress, it adds a refresh hint.

**Call relations**: `run_main` calls this when loading task details fails, so the details overlay shows helpful context instead of a long technical HTTP error.

*Call graph*: 3 external calls (new, new, format!).


##### `tests::StubGitInfo::new`  (lines 2155–2160)

```
fn new(default_branch: Option<String>, current_branch: Option<String>) -> Self
```

**Purpose**: Creates fake Git branch information for tests.

**Data flow**: It receives optional default and current branch names and stores them in a stub object.

**Call relations**: The branch-resolution tests use this instead of real Git so each scenario is controlled and repeatable.


##### `tests::StubGitInfo::default_branch_name`  (lines 2164–2166)

```
async fn default_branch_name(&self, _path: &std::path::Path) -> Option<String>
```

**Purpose**: Returns the fake default branch configured for a test.

**Data flow**: It ignores the path argument and returns a clone of the stored default branch option.

**Call relations**: `resolve_git_ref_with_git_info` calls this during tests when it needs default-branch information.


##### `tests::StubGitInfo::current_branch_name`  (lines 2168–2170)

```
async fn current_branch_name(&self, _path: &std::path::Path) -> Option<String>
```

**Purpose**: Returns the fake current branch configured for a test.

**Data flow**: It ignores the path argument and returns a clone of the stored current branch option.

**Call relations**: `resolve_git_ref_with_git_info` calls this during tests when it needs current-branch information.


##### `tests::branch_override_is_used_when_provided`  (lines 2174–2182)

```
async fn branch_override_is_used_when_provided()
```

**Purpose**: Checks that an explicit branch argument wins over Git detection.

**Data flow**: It gives `resolve_git_ref_with_git_info` a branch override and a stub with no Git branches. It expects the returned branch to be the override.

**Call relations**: This protects the behavior used by task creation when users deliberately choose a branch.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::trims_override_whitespace`  (lines 2185–2193)

```
async fn trims_override_whitespace()
```

**Purpose**: Checks that accidental spaces around a branch override are ignored.

**Data flow**: It passes an override with leading and trailing spaces, then asserts that the resolved branch has those spaces removed.

**Call relations**: This supports `run_exec_command`, where branch input may come from a human typing at the command line.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::prefers_current_branch_when_available`  (lines 2196–2207)

```
async fn prefers_current_branch_when_available()
```

**Purpose**: Checks that the current Git branch is chosen before the default branch.

**Data flow**: It provides both a fake current branch and fake default branch. It expects the current branch to be returned.

**Call relations**: This confirms the normal task-creation behavior: cloud work should follow what the developer is currently working on.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::falls_back_to_current_branch_when_default_is_missing`  (lines 2210–2218)

```
async fn falls_back_to_current_branch_when_default_is_missing()
```

**Purpose**: Checks that a current branch is still used even when no default branch is known.

**Data flow**: It provides only a fake current branch and expects that branch to be returned.

**Call relations**: This covers repositories or situations where default-branch detection fails but current-branch detection still works.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::falls_back_to_main_when_no_git_info_is_available`  (lines 2221–2229)

```
async fn falls_back_to_main_when_no_git_info_is_available()
```

**Purpose**: Checks the final fallback branch name.

**Data flow**: It provides no fake current branch and no fake default branch. It expects the resolver to return `main`.

**Call relations**: This makes sure task creation still has a branch value even outside a usable Git repository.

*Call graph*: calls 1 internal fn (resolve_git_ref_with_git_info); 2 external calls (assert_eq!, new).


##### `tests::format_task_status_lines_with_diff_and_label`  (lines 2232–2258)

```
fn format_task_status_lines_with_diff_and_label()
```

**Purpose**: Checks readable task formatting when a task has a diff and a friendly environment label.

**Data flow**: It builds a sample ready task with changed files and line counts, formats it without color, and compares the exact output lines.

**Call relations**: This protects the output used by both the status command and list command.

*Call graph*: calls 1 internal fn (format_task_status_lines); 3 external calls (now, assert_eq!, new).


##### `tests::format_task_status_lines_without_diff_falls_back`  (lines 2261–2283)

```
fn format_task_status_lines_without_diff_falls_back()
```

**Purpose**: Checks readable task formatting when no diff summary is available.

**Data flow**: It builds a pending task with an empty diff summary and no environment label, formats it, and expects the environment ID and `no diff` line.

**Call relations**: This protects the plain-text output path for tasks that are still running or have no changes.

*Call graph*: calls 1 internal fn (format_task_status_lines); 4 external calls (now, assert_eq!, default, new).


##### `tests::format_task_list_lines_formats_urls`  (lines 2286–2336)

```
fn format_task_list_lines_formats_urls()
```

**Purpose**: Checks that a list of tasks is formatted with task URLs and indented summaries.

**Data flow**: It builds two sample tasks, formats them with a ChatGPT base URL, and compares the complete line list including the blank separator.

**Call relations**: This protects the text output used by `run_list_command`.

*Call graph*: calls 1 internal fn (format_task_list_lines); 3 external calls (now, assert_eq!, vec!).


##### `tests::collect_attempt_diffs_includes_sibling_attempts`  (lines 2339–2350)

```
async fn collect_attempt_diffs_includes_sibling_attempts()
```

**Purpose**: Checks that diff collection includes alternate attempts, not just the main task.

**Data flow**: It uses the mock backend and a parsed task URL, collects attempt diffs, and asserts that two ordered attempts with non-empty diffs are returned.

**Call relations**: This test covers the helper used by the `diff` and `apply` commands when users request different attempts.

*Call graph*: calls 2 internal fn (collect_attempt_diffs, parse_task_id); 2 external calls (assert!, assert_eq!).


##### `tests::select_attempt_validates_bounds`  (lines 2353–2362)

```
fn select_attempt_validates_bounds()
```

**Purpose**: Checks that attempt selection accepts valid attempt numbers and rejects missing ones.

**Data flow**: It creates a one-item attempt list, selects attempt 1 successfully, then checks that selecting attempt 2 returns an error.

**Call relations**: This protects the validation used before printing or applying a chosen attempt.

*Call graph*: calls 1 internal fn (select_attempt); 3 external calls (assert!, assert_eq!, vec!).


##### `tests::parse_task_id_from_url_and_raw`  (lines 2365–2372)

```
fn parse_task_id_from_url_and_raw()
```

**Purpose**: Checks that task IDs can be read from both raw IDs and full URLs.

**Data flow**: It parses a raw task ID, parses a URL with a query string, and confirms both return the expected IDs. It also checks that blank input is rejected.

**Call relations**: This protects the convenience behavior used by status, diff, and apply commands.

*Call graph*: calls 1 internal fn (parse_task_id); 2 external calls (assert!, assert_eq!).


##### `tests::composer_input_renders_typed_characters`  (lines 2376–2401)

```
fn composer_input_renders_typed_characters()
```

**Purpose**: Checks that the text composer used for new tasks actually renders typed input and footer hints.

**Data flow**: It creates a composer, sends it a typed `a` key, renders into a test buffer, and verifies that the character appears. It then adds hint items, renders again, and checks that the footer contains the hint text.

**Call relations**: This ignored slow test covers UI input behavior that the interactive new-task page depends on.

*Call graph*: calls 1 internal fn (new); 7 external calls (empty, Char, new, new, assert!, panic!, vec!).


### Desktop and remote app-server launch
These commands open the desktop app or start remote-control app-server modes, including platform-specific desktop launch behavior.

### `cli/src/app_cmd.rs`

`orchestration` · `command execution`

This file supports a command that opens a project folder in Codex Desktop. A user can give it a path, or leave it blank to use the current folder. They can also provide a special download URL, which is mainly for advanced cases such as testing a different app installer.

The `AppCommand` type describes those command-line inputs so `clap`, the command-line argument parser, can turn text typed in the terminal into structured Rust values. The main work happens in `run_app`. It first tries to turn the given path into a full, absolute path. This is like replacing “the house next door” with the exact street address, so the desktop app receives a clear workspace location. If that path lookup fails, it keeps the original path rather than stopping immediately.

After that, the file hands control to the desktop app layer. On macOS and Windows, it calls the shared routine that either opens the app if it is already available or installs/downloads it if needed. Without this file, the CLI would know how to parse an “app” command, but it would not have the small but important step that connects the user’s chosen folder to the desktop-app startup flow.

#### Function details

##### `run_app`  (lines 15–25)

```
async fn run_app(cmd: AppCommand) -> anyhow::Result<()>
```

**Purpose**: Runs the desktop-app command from the CLI. It prepares the workspace path and then asks the desktop app subsystem to open or install Codex Desktop for that workspace.

**Data flow**: It receives an `AppCommand`, which contains the user’s requested workspace path and an optional installer download URL override. It tries to convert the path into a canonical full path; if that fails, it uses the path as originally provided. It then passes the workspace path and optional download URL to the desktop app opener/installer, and returns the success or error result from that operation.

**Call relations**: This function is called by `cli_main` when the user invokes the desktop app command. Before handing off, it uses the standard `canonicalize` filesystem call to clean up the path. Then, on supported desktop platforms, it calls `run_app_open_or_install`, which takes over the real work of opening the app or installing it first if necessary.

*Call graph*: calls 1 internal fn (run_app_open_or_install); called by 1 (cli_main); 1 external calls (canonicalize).


### `cli/src/desktop_app/mod.rs`

`orchestration` · `CLI app-open/install command execution`

This file solves a portability problem. The command-line tool needs to open or install a desktop app, but that job is different on macOS and Windows. Rather than making the rest of the program know those differences, this file offers one common function: `run_app_open_or_install`.

The important detail is that the choice is made using Rust’s conditional compilation, which means only the code for the current operating system is included when the program is built. On macOS, this module includes the `mac` code and forwards the request to the macOS-specific routine. On Windows, it includes the `windows` code and forwards the request to the Windows-specific routine.

You can think of it like a hotel front desk: guests ask the same desk for help, but the desk routes the request to the right local service depending on where the hotel is. Without this file, callers such as `run_app` would need to know about each operating system directly, making the main flow more cluttered and easier to break when platform behavior changes.

#### Function details

##### `run_app_open_or_install`  (lines 17–22)

```
async fn run_app_open_or_install(
    workspace: std::path::PathBuf,
    download_url_override: Option<String>,
) -> anyhow::Result<()>
```

**Purpose**: This is the shared entry point for desktop app open-or-install behavior, regardless of whether the CLI was built for macOS or Windows. Callers use it so they do not need to know which operating-system-specific code should run.

**Data flow**: It receives a workspace path and an optional download URL override. It passes those same values to the platform-specific implementation for the current build: the macOS routine on macOS, or the Windows routine on Windows. The result is returned to the caller as either success or an error explaining what went wrong.

**Call relations**: When `run_app` reaches the point where the desktop app should be opened or installed, it calls this function. This function then hands the work to `run_mac_app_open_or_install` or `run_windows_app_open_or_install`, depending on the operating system the program was compiled for, and passes the final outcome back up to `run_app`.

*Call graph*: calls 2 internal fn (run_mac_app_open_or_install, run_windows_app_open_or_install); called by 1 (run_app).


### `cli/src/desktop_app/mac.rs`

`orchestration` · `desktop app launch/install on macOS`

This file is the macOS bridge between the command-line tool and Codex Desktop. Its job is simple from a user's point of view: when they ask to open the desktop app, it should open if already installed, or download and install it if not. Without this file, macOS users would have to manually find the right installer, mount the disk image, copy the app, and then open it with the right project path.

The flow works like a small installer assistant. First it checks the usual places where macOS apps live: the system Applications folder and the user's own Applications folder. If it finds Codex.app, it opens it using macOS's `open` command. It sends a special `codex://` link that includes the workspace path, like handing the desktop app a note saying, "open a new thread for this folder."

If the app is not found, the file chooses the right download link for the machine type. Apple Silicon Macs need a different installer than Intel Macs, so it detects that before downloading. It then uses standard macOS command-line tools: `curl` to download the `.dmg` disk image, `hdiutil` to mount and detach it, and `ditto` to copy the app bundle into Applications. It also tries to clean up by detaching the mounted installer even if installation fails.

#### Function details

##### `run_mac_app_open_or_install`  (lines 12–42)

```
async fn run_mac_app_open_or_install(
    workspace: PathBuf,
    download_url_override: Option<String>,
) -> anyhow::Result<()>
```

**Purpose**: This is the main macOS routine for opening Codex Desktop. It either opens an existing installation or downloads, installs, and then opens the app.

**Data flow**: It receives a workspace path and an optional installer download URL. It first looks for an installed Codex.app. If found, it opens that app with the workspace. If not found, it chooses a download URL, installs the app from that installer, then opens the newly installed app. The result is success if the desktop app was launched, or an error explaining what failed.

**Call relations**: This function is called by the higher-level app-opening flow, `run_app_open_or_install`. It coordinates the helper functions: it asks `find_existing_codex_app_path` whether the app is already present, calls `download_and_install_codex_to_user_applications` when it is missing, and hands the final app path to `open_codex_app`.

*Call graph*: calls 3 internal fn (download_and_install_codex_to_user_applications, find_existing_codex_app_path, open_codex_app); called by 1 (run_app_open_or_install); 1 external calls (eprintln!).


##### `is_apple_silicon_mac`  (lines 44–64)

```
fn is_apple_silicon_mac() -> bool
```

**Purpose**: This function decides whether the current Mac should use the Apple Silicon installer. That matters because Apple Silicon and Intel Macs can need different app builds.

**Data flow**: It reads the process architecture and, on macOS, checks system flags through `sysctl`, which is a low-level way to ask the operating system about hardware and translation mode. It returns true if the machine appears to be Apple Silicon or running under Apple's translation layer, and false otherwise.

**Call relations**: It supports the installer choice made by `run_mac_app_open_or_install`. Although the call graph does not list that inline use directly, its result is used there to choose between the ARM64 and x64 Codex Desktop download URLs.


##### `find_existing_codex_app_path`  (lines 66–70)

```
fn find_existing_codex_app_path() -> Option<PathBuf>
```

**Purpose**: This function checks whether Codex Desktop is already installed in one of the expected macOS app locations.

**Data flow**: It asks `candidate_codex_app_paths` for possible app paths, then checks each one to see whether it is an existing directory. It returns the first matching path, or nothing if Codex.app is not found.

**Call relations**: It is called by `run_mac_app_open_or_install` at the start of the flow. If it finds the app, the larger flow can skip downloading and installing, and go straight to `open_codex_app`.

*Call graph*: calls 1 internal fn (candidate_codex_app_paths); called by 1 (run_mac_app_open_or_install).


##### `candidate_codex_app_paths`  (lines 72–78)

```
fn candidate_codex_app_paths() -> Vec<PathBuf>
```

**Purpose**: This function builds the short list of places where Codex.app is expected to live on macOS.

**Data flow**: It always includes `/Applications/Codex.app`. If the `HOME` environment variable is available, it also adds `~/Applications/Codex.app`. It returns these paths as a list.

**Call relations**: It is used by `find_existing_codex_app_path`, which turns this list of guesses into an actual installed-app check.

*Call graph*: called by 1 (find_existing_codex_app_path); 3 external calls (from, var_os, vec!).


##### `open_codex_app`  (lines 80–103)

```
async fn open_codex_app(app_path: &Path, workspace: &Path) -> anyhow::Result<()>
```

**Purpose**: This function asks macOS to open Codex Desktop and tells it which workspace folder to use.

**Data flow**: It receives the path to Codex.app and a workspace path. It turns the workspace into a `codex://` deep link using `codex_new_thread_url`, then runs the macOS `open` command with the app and that link. It returns success if macOS reports that the app opened, or an error if the command failed.

**Call relations**: It is called by `run_mac_app_open_or_install` both when the app was already installed and after a fresh install. It relies on `codex_new_thread_url` to package the workspace path in the format the desktop app understands.

*Call graph*: calls 1 internal fn (codex_new_thread_url); called by 1 (run_mac_app_open_or_install); 3 external calls (bail!, new, eprintln!).


##### `codex_new_thread_url`  (lines 105–111)

```
fn codex_new_thread_url(workspace: &Path) -> String
```

**Purpose**: This function creates the special link that tells Codex Desktop to start a new thread for a particular workspace path.

**Data flow**: It receives a filesystem path, converts it to text, safely URL-encodes it as a query parameter named `path`, and returns a string like `codex://threads/new?path=...`. URL encoding matters because folder names can contain spaces or symbols.

**Call relations**: It is called by `open_codex_app` before launching the desktop app. It is also checked by the test `tests::codex_new_thread_url_encodes_workspace_path` to make sure unusual workspace paths survive the trip correctly.

*Call graph*: called by 2 (open_codex_app, codex_new_thread_url_encodes_workspace_path); 5 external calls (as_os_str, as_ref, new, format!, new).


##### `download_and_install_codex_to_user_applications`  (lines 113–146)

```
async fn download_and_install_codex_to_user_applications(dmg_url: &str) -> anyhow::Result<PathBuf>
```

**Purpose**: This function performs the full installer workflow after Codex Desktop is found to be missing.

**Data flow**: It receives a `.dmg` download URL. It creates a temporary folder, downloads the disk image there, mounts it, finds the app bundle inside, copies the app into an Applications folder, then detaches the mounted disk image. It returns the path where Codex.app was installed.

**Call relations**: It is called by `run_mac_app_open_or_install` when no existing app is found. Inside, it delegates each physical step to focused helpers: `download_dmg`, `mount_dmg`, `find_codex_app_in_mount`, `install_codex_app_bundle`, and finally `detach_dmg` for cleanup.

*Call graph*: calls 5 internal fn (detach_dmg, download_dmg, find_codex_app_in_mount, install_codex_app_bundle, mount_dmg); called by 1 (run_mac_app_open_or_install); 2 external calls (new, eprintln!).


##### `install_codex_app_bundle`  (lines 148–178)

```
async fn install_codex_app_bundle(app_in_volume: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: This function copies Codex.app from the mounted installer into a real Applications folder.

**Data flow**: It receives the path to the app bundle inside the mounted disk image. It gets possible destination folders, creates each folder if needed, and tries to place `Codex.app` there. If the app already exists in a destination, it treats that as success. If copying fails in one destination, it warns and tries the next. It returns the installed app path or an error if all locations fail.

**Call relations**: It is called by `download_and_install_codex_to_user_applications` after the installer has been mounted and the app has been found. It uses `candidate_applications_dirs` to decide where to install and `copy_app_bundle` to do the actual copy.

*Call graph*: calls 2 internal fn (candidate_applications_dirs, copy_app_bundle); called by 1 (download_and_install_codex_to_user_applications); 3 external calls (bail!, eprintln!, create_dir_all).


##### `candidate_applications_dirs`  (lines 180–184)

```
fn candidate_applications_dirs() -> anyhow::Result<Vec<PathBuf>>
```

**Purpose**: This function lists the folders where the installer should try to place Codex.app.

**Data flow**: It starts with the system-wide `/Applications` folder, then adds the current user's `Applications` folder. It returns that ordered list, or an error if the user's home folder cannot be determined.

**Call relations**: It is called by `install_codex_app_bundle`, which tries these destinations one by one until installation succeeds.

*Call graph*: calls 1 internal fn (user_applications_dir); called by 1 (install_codex_app_bundle); 1 external calls (vec!).


##### `download_dmg`  (lines 186–205)

```
async fn download_dmg(url: &str, dest: &Path) -> anyhow::Result<()>
```

**Purpose**: This function downloads the Codex Desktop installer disk image from the internet.

**Data flow**: It receives a URL and a destination file path. It runs `curl` with options to follow redirects, fail on bad HTTP responses, and retry a few times. If `curl` succeeds, the `.dmg` file is written at the destination. If it fails, the function returns an error.

**Call relations**: It is called near the start of `download_and_install_codex_to_user_applications`, before any mounting or copying can happen.

*Call graph*: called by 1 (download_and_install_codex_to_user_applications); 3 external calls (bail!, new, eprintln!).


##### `mount_dmg`  (lines 207–229)

```
async fn mount_dmg(dmg_path: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: This function opens the downloaded macOS disk image so its contents can be read.

**Data flow**: It receives the path to a `.dmg` file and runs `hdiutil attach` in read-only, no-browse mode. It reads the command output, extracts the `/Volumes/...` mount point using `parse_hdiutil_attach_mount_point`, and returns that mount folder. If mounting or parsing fails, it returns an error.

**Call relations**: It is called by `download_and_install_codex_to_user_applications` after the installer is downloaded. It hands the mounted volume path to the next step, which searches for Codex.app inside it.

*Call graph*: calls 1 internal fn (parse_hdiutil_attach_mount_point); called by 1 (download_and_install_codex_to_user_applications); 3 external calls (from_utf8_lossy, bail!, new).


##### `detach_dmg`  (lines 231–243)

```
async fn detach_dmg(mount_point: &Path) -> anyhow::Result<()>
```

**Purpose**: This function unmounts the installer disk image after installation is done.

**Data flow**: It receives the mounted volume path and runs `hdiutil detach` on it. If macOS reports success, it returns successfully. If detaching fails, it returns an error.

**Call relations**: It is called by `download_and_install_codex_to_user_applications` after the install attempt, even when the install step failed. The caller treats detach failure as a warning so cleanup problems do not hide the main install result.

*Call graph*: called by 1 (download_and_install_codex_to_user_applications); 2 external calls (bail!, new).


##### `find_codex_app_in_mount`  (lines 245–268)

```
fn find_codex_app_in_mount(mount_point: &Path) -> anyhow::Result<PathBuf>
```

**Purpose**: This function locates the app bundle inside the mounted installer volume.

**Data flow**: It receives a mount folder. It first checks for the expected `Codex.app` directly inside that folder. If not found, it scans the top level for any directory ending in `.app`. It returns the app path it finds, or an error if there is no app bundle.

**Call relations**: It is called by `download_and_install_codex_to_user_applications` after `mount_dmg` succeeds. Its result is passed to `install_codex_app_bundle` so the app can be copied into Applications.

*Call graph*: called by 1 (download_and_install_codex_to_user_applications); 3 external calls (join, bail!, read_dir).


##### `copy_app_bundle`  (lines 270–282)

```
async fn copy_app_bundle(src_app: &Path, dest_app: &Path) -> anyhow::Result<()>
```

**Purpose**: This function copies the Codex.app bundle from the installer to its final destination.

**Data flow**: It receives a source app path and a destination app path. It runs macOS's `ditto` tool, which is commonly used to copy app bundles while preserving their structure and metadata. It returns success if the copy command succeeds, or an error if it fails.

**Call relations**: It is called by `install_codex_app_bundle` for each destination folder being tried. The caller decides whether to accept the success or move on to another folder after a failure.

*Call graph*: called by 1 (install_codex_app_bundle); 2 external calls (bail!, new).


##### `user_applications_dir`  (lines 284–287)

```
fn user_applications_dir() -> anyhow::Result<PathBuf>
```

**Purpose**: This function builds the path to the current user's personal Applications folder.

**Data flow**: It reads the `HOME` environment variable. If it exists, it appends `Applications` and returns that path. If `HOME` is missing, it returns an error because it cannot safely guess the user's app folder.

**Call relations**: It is called by `candidate_applications_dirs`, which includes this user-specific folder as a fallback or alternative install location.

*Call graph*: called by 1 (candidate_applications_dirs); 2 external calls (from, var_os).


##### `parse_hdiutil_attach_mount_point`  (lines 289–301)

```
fn parse_hdiutil_attach_mount_point(output: &str) -> Option<String>
```

**Purpose**: This function extracts the mounted volume path from the text printed by `hdiutil attach`.

**Data flow**: It receives command output as text, looks for a line containing `/Volumes/`, and then tries to pull out the mount path. It handles both tab-separated output and simpler whitespace-separated output. It returns the mount path as text, or nothing if it cannot find one.

**Call relations**: It is called by `mount_dmg` after macOS mounts the installer. The tests check common output shapes, including mount names with spaces, so the installer does not fail just because the volume name is not a single word.

*Call graph*: called by 1 (mount_dmg).


##### `tests::parses_mount_point_from_tab_separated_hdiutil_output`  (lines 311–317)

```
fn parses_mount_point_from_tab_separated_hdiutil_output()
```

**Purpose**: This test confirms that mount-point parsing works for normal tab-separated `hdiutil` output.

**Data flow**: It feeds a sample line of `hdiutil` output into `parse_hdiutil_attach_mount_point` and checks that the returned value is `/Volumes/Codex`. The test changes nothing outside itself.

**Call relations**: It protects the behavior that `mount_dmg` depends on. If parsing breaks, this test should fail before users see installer failures.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parses_mount_point_with_spaces`  (lines 320–326)

```
fn parses_mount_point_with_spaces()
```

**Purpose**: This test confirms that installer volume names with spaces are parsed correctly.

**Data flow**: It passes sample `hdiutil` output where the volume is named `Codex Installer`. It checks that the full path `/Volumes/Codex Installer` is returned, not just the first word.

**Call relations**: It supports `parse_hdiutil_attach_mount_point`, which in turn supports `mount_dmg`. This matters because macOS volume names often contain spaces.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::codex_new_thread_url_encodes_workspace_path`  (lines 329–347)

```
fn codex_new_thread_url_encodes_workspace_path()
```

**Purpose**: This test checks that workspace paths are safely placed into the Codex deep link.

**Data flow**: It builds a deep link for a path containing spaces and a `#` symbol, parses that link as a URL, and checks that the scheme, host, path, and query value are all correct. Nothing is written to disk or sent to the network.

**Call relations**: It directly tests `codex_new_thread_url`, which is used by `open_codex_app`. This helps ensure the desktop app receives the exact workspace path the user intended.

*Call graph*: calls 1 internal fn (codex_new_thread_url); 3 external calls (new, assert_eq!, parse).


### `cli/src/desktop_app/windows.rs`

`orchestration` · `CLI command execution on Windows`

This file solves a practical Windows problem: a command-line tool cannot assume the Codex Desktop app is already present, and Windows app launching has its own rules. The main flow is simple. Given a workspace folder, it first asks Windows whether an app named “Codex” is installed. It does this by running PowerShell, which is Windows’ built-in command shell and scripting tool. If Codex is found, the file builds a special app link, like `codex://threads/new?...`, that tells Codex Desktop to open a new thread for that workspace. It then asks Windows to open that link. If Codex is not found, it opens the Microsoft installer link instead, with a fallback to the Microsoft Store web page when using the default installer URL. A small helper also cleans up Windows “extended length” path prefixes before showing paths to humans, so messages look normal rather than like internal Windows plumbing. Another helper safely encodes workspace paths into a URL, because characters like backslashes and colons need to be escaped inside links. Without this file, the CLI could not reliably hand a Windows workspace to Codex Desktop or guide the user through installing the app.

#### Function details

##### `run_windows_app_open_or_install`  (lines 10–31)

```
async fn run_windows_app_open_or_install(
    workspace: PathBuf,
    download_url_override: Option<String>,
) -> anyhow::Result<()>
```

**Purpose**: This is the main Windows flow for opening Codex Desktop from the CLI. It either opens the given workspace in the installed app or sends the user to install the app first.

**Data flow**: It receives a workspace path and, optionally, a replacement download URL. It turns the workspace into a display-friendly string, checks whether Codex Desktop is installed, then chooses what to open: a `codex://` app link for an installed app, or an installer/store URL for a missing app. It prints short instructions for the user and returns success or an error if opening something fails.

**Call relations**: This function is called by `run_app_open_or_install`, which is the higher-level platform-neutral flow. It relies on `codex_app_is_installed` to decide which branch to take, `display_workspace_path` to make messages readable, `codex_new_thread_url` to build the app-opening link, and `open_url` to ask Windows to launch either the app link or the installer page.

*Call graph*: calls 4 internal fn (codex_app_is_installed, codex_new_thread_url, display_workspace_path, open_url); called by 1 (run_app_open_or_install); 2 external calls (display, eprintln!).


##### `codex_app_is_installed`  (lines 33–47)

```
async fn codex_app_is_installed() -> anyhow::Result<bool>
```

**Purpose**: This function asks Windows whether the Codex Desktop app appears in the Start menu app list. It is used as the yes-or-no gate before trying to open a workspace in the app.

**Data flow**: It runs a PowerShell command that searches for a Start app named `Codex` and reads its output. If PowerShell cannot be launched, it returns an error. If the command runs but does not succeed, or if it succeeds with no app ID in the output, it returns `false`; otherwise it returns `true`.

**Call relations**: `run_windows_app_open_or_install` calls this before doing anything visible to the user. The result decides whether the next step is opening a `codex://` workspace link or opening an installer link.

*Call graph*: called by 1 (run_windows_app_open_or_install); 2 external calls (from_utf8_lossy, new).


##### `open_url`  (lines 49–64)

```
async fn open_url(url: &str) -> anyhow::Result<()>
```

**Purpose**: This function asks Windows to open a URL or app link using the system’s normal launcher. It is the shared doorway for opening Codex links, installer links, and store pages.

**Data flow**: It receives a string such as a web address or `codex://` link. It starts PowerShell and passes that string to `Start-Process`, which tells Windows to open it with the appropriate app or browser. If Windows reports success, it returns success; otherwise it returns an error that includes what failed.

**Call relations**: `run_windows_app_open_or_install` calls this whenever it needs Windows to open something. The caller decides what URL should be opened, while this function performs the actual operating-system handoff.

*Call graph*: called by 1 (run_windows_app_open_or_install); 2 external calls (bail!, new).


##### `codex_new_thread_url`  (lines 66–71)

```
fn codex_new_thread_url(workspace: &str) -> String
```

**Purpose**: This function builds the special Codex Desktop link that means “open a new thread for this workspace.” It also makes sure the workspace path is safely encoded for use inside a URL.

**Data flow**: It receives a workspace path as text. It puts that path into a URL query parameter named `path`, escaping characters such as backslashes and colons so the link stays valid. It returns a complete link like `codex://threads/new?path=...`.

**Call relations**: `run_windows_app_open_or_install` calls this only after it has confirmed the desktop app is installed. The resulting link is then handed to `open_url`, which asks Windows to launch it.

*Call graph*: called by 1 (run_windows_app_open_or_install); 3 external calls (new, format!, new).


##### `display_workspace_path`  (lines 73–82)

```
fn display_workspace_path(workspace: &Path) -> String
```

**Purpose**: This function turns some Windows-internal path formats into cleaner text for the user to read. It keeps normal paths unchanged.

**Data flow**: It receives a workspace path. If the path starts with Windows’ extended path prefix `\\?\`, it removes that prefix for display. If it is an extended network path beginning with `\\?\UNC\`, it converts it back to the familiar `\\server\share` form. It returns the cleaned-up string.

**Call relations**: `run_windows_app_open_or_install` uses this before printing messages. The cleaned path is for human-readable output only; the actual app-opening URL is built separately from the original workspace text.

*Call graph*: called by 1 (run_windows_app_open_or_install); 2 external calls (display, format!).


##### `tests::display_workspace_path_removes_windows_extended_prefix`  (lines 92–97)

```
fn display_workspace_path_removes_windows_extended_prefix()
```

**Purpose**: This test checks that a local Windows path with the extended `\\?\` prefix is displayed without that internal prefix.

**Data flow**: It gives `display_workspace_path` a path like `\\?\C:\...` and compares the result with the expected normal-looking `C:\...` form. The test passes only if the prefix is removed exactly as intended.

**Call relations**: This test protects the behavior used by `run_windows_app_open_or_install` when it prints workspace instructions. If someone changes path display logic later, this test warns them if local extended paths become user-unfriendly again.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::display_workspace_path_preserves_unc_prefix`  (lines 100–105)

```
fn display_workspace_path_preserves_unc_prefix()
```

**Purpose**: This test checks that an extended Windows network path is converted to the normal network-share form, not mangled.

**Data flow**: It gives `display_workspace_path` a path like `\\?\UNC\server\share\codex` and expects `\\server\share\codex`. The before-and-after comparison confirms that the network location remains intact while the internal prefix is removed.

**Call relations**: This test supports the same display path helper used by `run_windows_app_open_or_install`. It makes sure the helper treats network paths differently from local paths, because Windows writes those extended forms differently.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::display_workspace_path_leaves_regular_paths_unchanged`  (lines 108–113)

```
fn display_workspace_path_leaves_regular_paths_unchanged()
```

**Purpose**: This test checks that ordinary Windows paths are not changed unnecessarily.

**Data flow**: It passes a normal path like `C:\Users\...` into `display_workspace_path` and expects exactly the same string back. The test confirms that cleanup only happens when there is an extended Windows prefix to remove.

**Call relations**: This protects the display helper used in the main open-or-install flow. It prevents a future change from accidentally rewriting normal user-facing paths.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::codex_new_thread_url_encodes_windows_workspace_path`  (lines 116–121)

```
fn codex_new_thread_url_encodes_windows_workspace_path()
```

**Purpose**: This test checks that a normal Windows workspace path is correctly escaped when placed inside a Codex app link.

**Data flow**: It passes a path containing a drive letter and backslashes into `codex_new_thread_url`. It expects a `codex://threads/new` URL where characters such as `:` and `\` have been percent-encoded, which is the standard way to make them safe inside URLs.

**Call relations**: This test protects the link-building helper used by `run_windows_app_open_or_install`. If URL encoding breaks, Windows might open the app link but Codex Desktop could receive the wrong workspace path.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::codex_new_thread_url_preserves_verbatim_workspace_path`  (lines 124–129)

```
fn codex_new_thread_url_preserves_verbatim_workspace_path()
```

**Purpose**: This test checks that even Windows verbatim paths, including the `\\?\` prefix, are preserved when encoded into the Codex app link.

**Data flow**: It gives `codex_new_thread_url` a verbatim Windows path and expects the returned URL to contain an encoded version of that exact path. The path is not cleaned for display here; it is preserved as data for the desktop app.

**Call relations**: This test reinforces the distinction between display text and launch data. `display_workspace_path` may clean a path for messages, but `codex_new_thread_url`, used by the main flow, must encode the actual workspace string it was given.

*Call graph*: 1 external calls (assert_eq!).


### `cli/src/remote_control_cmd.rs`

`orchestration` · `CLI command execution, startup, foreground run, and shutdown`

This file is the command-line front door for Codex remote control. Its job is to turn a user command like `remote-control`, `remote-control start`, or `remote-control stop` into the right app-server action, then explain the result clearly. Without it, users would not have a simple CLI path to make their machine available for remote control or to shut that access down.

There are two ways to start remote control. With no subcommand, it runs an app-server in the foreground, meaning the command stays open and the server stops when the user presses Ctrl-C. With `start`, it asks the daemon system to make sure an app-server is running in the background. With `stop`, it asks the daemon system to stop it.

For foreground mode, the file creates a private temporary Unix socket, which is a local file-like connection point used for communication between processes. It starts the app-server task, waits until remote control is ready, watches for Ctrl-C, and aborts the server if startup fails or the user cancels. This is like opening a temporary service desk, waiting until the sign says “open,” and closing it cleanly if the operator walks away.

The file also centralizes output. It refuses to report a successful start if remote control is errored or disabled, and it can format the same result either as plain text for people or JSON for scripts.

#### Function details

##### `RemoteControlCommand::subcommand_name`  (lines 41–47)

```
fn subcommand_name(&self) -> &'static str
```

**Purpose**: Returns a readable name for the selected remote-control command. This is useful for reporting, logging, or analytics that need to know which command shape the user chose.

**Data flow**: It reads the command’s optional subcommand. If there is no subcommand, it returns `remote-control`; if the user chose start or stop, it returns the matching full command name.

**Call relations**: This method sits on the command data type itself. It does not start or stop anything; it simply gives the rest of the CLI a stable label for the command.


##### `run`  (lines 59–87)

```
async fn run(
    command: RemoteControlCommand,
    arg0_paths: Arg0DispatchPaths,
    root_config_overrides: CliConfigOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Runs the remote-control command chosen by the user. It decides whether to start foreground remote control, start the daemon-backed version, or stop remote control.

**Data flow**: It receives the parsed command, executable dispatch paths, and configuration overrides. It prints a progress message unless JSON mode is enabled, calls the appropriate app-server or daemon operation, then prints the final result.

**Call relations**: The main CLI calls this function when the remote-control command is selected. It delegates foreground startup to `run_foreground_remote_control`, daemon startup to the daemon readiness helper, daemon shutdown to the daemon lifecycle helper, and output formatting to the print functions.

*Call graph*: calls 4 internal fn (print_remote_control_progress, print_remote_control_start_output, print_remote_control_stop_output, run_foreground_remote_control); called by 1 (cli_main); 2 external calls (ensure_remote_control_ready, run).


##### `print_remote_control_progress`  (lines 89–99)

```
fn print_remote_control_progress(json: bool, message: &str) -> anyhow::Result<()>
```

**Purpose**: Prints a short progress message for humans before a longer remote-control operation starts. It stays silent in JSON mode so machine-readable output is not mixed with extra text.

**Data flow**: It receives a JSON flag and a message. If JSON is requested, it returns without printing; otherwise it writes the message to standard output and flushes it so the user sees it immediately.

**Call relations**: `run` calls this before starting or stopping remote control. It is deliberately separate from final output so progress text can be suppressed for scripts.

*Call graph*: called by 1 (run); 2 external calls (println!, stdout).


##### `run_foreground_remote_control`  (lines 101–174)

```
async fn run_foreground_remote_control(
    json: bool,
    arg0_paths: Arg0DispatchPaths,
    root_config_overrides: CliConfigOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Starts remote control in the foreground, where the app-server lives only as long as this command is running. This is the no-subcommand behavior of `remote-control`.

**Data flow**: It creates a private temporary socket path, builds app-server runtime options with remote control enabled, starts the app-server task, and starts a Ctrl-C watcher. It waits until the server is ready, stopped, failed, or exited too early; then it prints readiness, waits for the server to finish or for Ctrl-C, and cleans up tasks as needed.

**Call relations**: `run` calls this for foreground mode. It relies on `foreground_stop_signal` to notice Ctrl-C, `wait_for_foreground_remote_control_start` to race startup against cancellation and failure, `wait_for_foreground_remote_control_ready` to enable remote control through the socket, `print_foreground_ready_output` to tell the user the server is ready, and `wait_for_foreground_app_server` or `abort_foreground_app_server` to finish cleanly.

*Call graph*: calls 7 internal fn (abort_foreground_app_server, foreground_stop_signal, print_foreground_ready_output, wait_for_foreground_app_server, wait_for_foreground_remote_control_ready, wait_for_foreground_remote_control_start, from_absolute_path); called by 1 (run); 6 external calls (default, default, run_main_with_transport_options, default, new, spawn).


##### `foreground_stop_signal`  (lines 176–185)

```
fn foreground_stop_signal() -> (watch::Receiver<bool>, JoinHandle<()>)
```

**Purpose**: Creates a small background listener for Ctrl-C. It gives the foreground server flow a shared “stop requested” signal.

**Data flow**: It creates a watch channel, which is a simple shared value that other async tasks can observe. A spawned task waits for Ctrl-C; when Ctrl-C happens, it changes the shared value from false to true.

**Call relations**: `run_foreground_remote_control` calls this before starting its wait logic. The returned receiver is passed to startup and server-wait functions so both can stop promptly if the user cancels.

*Call graph*: called by 1 (run_foreground_remote_control); 4 external calls (eprintln!, ctrl_c, spawn, channel).


##### `wait_for_foreground_remote_control_start`  (lines 194–213)

```
async fn wait_for_foreground_remote_control_start(
    app_server_task: &mut JoinHandle<std::io::Result<()>>,
    ready: impl std::future::Future<Output = anyhow::Result<AppServerRemoteControlReadySta
```

**Purpose**: Waits for the foreground app-server to either become ready, fail readiness, exit early, or be cancelled by the user. It turns that race into one clear startup result.

**Data flow**: It receives the running app-server task, a future that checks remote-control readiness, and a stop-signal receiver. Whichever completes first determines the returned `ForegroundStartupResult`.

**Call relations**: `run_foreground_remote_control` uses this during startup. Tests also call it to confirm that Ctrl-C and early app-server exits are reported correctly.

*Call graph*: called by 3 (run_foreground_remote_control, foreground_start_wait_reports_app_server_exit_before_ready, foreground_start_wait_stops_before_ready); 2 external calls (pin!, select!).


##### `wait_for_foreground_app_server`  (lines 215–231)

```
async fn wait_for_foreground_app_server(
    mut app_server_task: JoinHandle<std::io::Result<()>>,
    mut stop_rx: watch::Receiver<bool>,
) -> anyhow::Result<()>
```

**Purpose**: Keeps the foreground command alive while the app-server is running. If the user asks to stop, it aborts the app-server and returns cleanly.

**Data flow**: It receives the app-server task and the stop-signal receiver. It waits for either the server task to finish or the stop signal to become true; server errors are returned, while user stop causes an abort and then success.

**Call relations**: `run_foreground_remote_control` calls this after remote control is ready and the ready message has been printed. A test calls it directly to verify that a stop signal ends the wait.

*Call graph*: called by 2 (run_foreground_remote_control, foreground_wait_aborts_app_server_on_stop_signal); 1 external calls (select!).


##### `wait_for_stop_signal`  (lines 233–238)

```
async fn wait_for_stop_signal(stop_rx: &mut watch::Receiver<bool>)
```

**Purpose**: Waits until the shared stop flag says the user has requested shutdown. It also returns immediately if the flag was already set.

**Data flow**: It reads the current boolean value from a watch receiver. If it is false, it waits until another task changes it to true; it produces no data, only the timing signal.

**Call relations**: The foreground startup and foreground running waits use this as their cancellation branch. It is the small adapter that turns the Ctrl-C watcher’s shared value into something async code can wait on.

*Call graph*: 2 external calls (borrow, wait_for).


##### `foreground_app_server_exited_before_ready`  (lines 240–252)

```
fn foreground_app_server_exited_before_ready(
    result: Result<std::io::Result<()>, tokio::task::JoinError>,
) -> anyhow::Error
```

**Purpose**: Turns an early app-server exit into a clear error message. This helps distinguish “remote control was not ready yet” from ordinary runtime shutdown.

**Data flow**: It receives the result of joining the app-server task. It looks at whether the task ended successfully, returned an I/O error, or failed as a task, then wraps that situation in a descriptive error.

**Call relations**: `wait_for_foreground_remote_control_start` uses this when the app-server finishes before readiness is confirmed. The result is passed back to `run_foreground_remote_control` as a startup failure.

*Call graph*: 2 external calls (anyhow!, new).


##### `abort_foreground_app_server`  (lines 254–257)

```
async fn abort_foreground_app_server(app_server_task: JoinHandle<std::io::Result<()>>)
```

**Purpose**: Stops a foreground app-server task when startup is cancelled or the user requests shutdown. It prevents the command from leaving a stray background task behind.

**Data flow**: It receives the app-server task handle, asks Tokio to abort it, then waits briefly for that abort to complete. If the task does not finish within the short timeout, the function still returns.

**Call relations**: `run_foreground_remote_control` calls this on cancellation, failed readiness, output failure, or stop. `wait_for_foreground_app_server` also uses the same shutdown idea when Ctrl-C happens during normal foreground running.

*Call graph*: called by 1 (run_foreground_remote_control); 2 external calls (abort, timeout).


##### `wait_for_foreground_remote_control_ready`  (lines 259–268)

```
async fn wait_for_foreground_remote_control_ready(
    socket_path: AbsolutePathBuf,
) -> anyhow::Result<AppServerRemoteControlReadyStatus>
```

**Purpose**: Connects to the foreground app-server’s private socket and asks it to enable remote control. It waits with retry and timeout settings because the socket may not be ready instantly.

**Data flow**: It receives an absolute socket path. It passes that path, a maximum wait time, and a retry delay to the daemon helper; the result is a remote-control readiness summary or an error.

**Call relations**: `run_foreground_remote_control` gives this future to `wait_for_foreground_remote_control_start`. It is the bridge between “server process started” and “remote control is actually usable.”

*Call graph*: calls 1 internal fn (as_path); called by 1 (run_foreground_remote_control); 1 external calls (enable_remote_control_on_socket).


##### `print_remote_control_start_output`  (lines 270–293)

```
fn print_remote_control_start_output(
    output: &AppServerRemoteControlReadyOutput,
    json: bool,
) -> anyhow::Result<()>
```

**Purpose**: Prints the result of starting daemon-backed remote control. It supports both human text and JSON, and it refuses to print a success-like result for unusable remote control.

**Data flow**: It receives the daemon readiness output and the JSON flag. It first checks that the remote-control status is connected or connecting; then it either serializes a JSON object or prints human lines plus details about the app-server binary used by the daemon.

**Call relations**: `run` calls this after asking the daemon to ensure remote control is ready. It uses `ensure_remote_control_startable`, `remote_control_start_human_lines`, and `daemon_app_server_human_lines` to build safe output.

*Call graph*: calls 3 internal fn (daemon_app_server_human_lines, ensure_remote_control_startable, remote_control_start_human_lines); called by 1 (run); 1 external calls (println!).


##### `print_foreground_ready_output`  (lines 295–313)

```
fn print_foreground_ready_output(
    summary: &AppServerRemoteControlReadyStatus,
    json: bool,
) -> anyhow::Result<()>
```

**Purpose**: Prints the result of foreground remote-control startup. It tells the user the machine is available and, in human mode, reminds them that Ctrl-C stops it.

**Data flow**: It receives a readiness summary and the JSON flag. In JSON mode it checks the status and prints a serialized foreground result; in human mode it prints formatted lines for the foreground case.

**Call relations**: `run_foreground_remote_control` calls this once startup has succeeded. It uses the same safety check and message-building helpers as daemon startup, but with foreground-specific wording.

*Call graph*: calls 2 internal fn (ensure_remote_control_startable, remote_control_start_human_lines); called by 1 (run_foreground_remote_control); 1 external calls (println!).


##### `RemoteControlStartJsonOutput::foreground`  (lines 335–344)

```
fn foreground(summary: &'a AppServerRemoteControlReadyStatus) -> Self
```

**Purpose**: Builds the JSON-friendly summary for foreground remote-control startup. It marks the mode as foreground and omits daemon-only details.

**Data flow**: It reads the readiness status, server name, optional environment ID, and timeout flag from the foreground summary. It returns a serializable struct with those values and no daemon field.

**Call relations**: `print_foreground_ready_output` uses this when the user requested JSON. It keeps the JSON shape consistent with daemon output while clearly saying this was a foreground run.


##### `RemoteControlStartJsonOutput::daemon`  (lines 346–356)

```
fn daemon(output: &'a AppServerRemoteControlReadyOutput) -> Self
```

**Purpose**: Builds the JSON-friendly summary for daemon-backed remote-control startup. It includes both remote-control status and daemon startup details.

**Data flow**: It reads the remote-control readiness part and the daemon output part from the combined daemon result. It returns a serializable struct marked as daemon mode with the daemon details attached.

**Call relations**: `print_remote_control_start_output` uses this when JSON output is requested. It packages the daemon helper’s detailed result into the CLI’s public output format.


##### `remote_control_start_human_message`  (lines 359–376)

```
fn remote_control_start_human_message(
    output: &AppServerRemoteControlReadyStatus,
) -> anyhow::Result<String>
```

**Purpose**: Creates the main human-readable message for a successful or still-connecting remote-control start. It also rejects statuses that should not be presented as usable.

**Data flow**: It receives a readiness summary, first checks that the status is startable, then turns `Connected` or `Connecting` into a sentence that includes the server name. Errored or disabled statuses are blocked before formatting.

**Call relations**: `remote_control_start_human_lines` uses this as the first line of human output. It depends on `ensure_remote_control_startable` so callers do not accidentally print a misleading success message.

*Call graph*: calls 1 internal fn (ensure_remote_control_startable); 2 external calls (format!, unreachable!).


##### `ensure_remote_control_startable`  (lines 378–395)

```
fn ensure_remote_control_startable(
    output: &AppServerRemoteControlReadyStatus,
) -> anyhow::Result<()>
```

**Purpose**: Checks whether a remote-control status is acceptable to report as started. Only connected and still-connecting states pass.

**Data flow**: It receives a readiness summary. If the status is connected or connecting, it returns success; if the status is errored or disabled, it returns a clear error message naming the server.

**Call relations**: Start-output functions and the human-message helper call this before formatting results. It is the shared guardrail that keeps both JSON and text output honest.

*Call graph*: called by 3 (print_foreground_ready_output, print_remote_control_start_output, remote_control_start_human_message); 1 external calls (bail!).


##### `remote_control_start_human_lines`  (lines 403–415)

```
fn remote_control_start_human_lines(
    summary: &AppServerRemoteControlReadyStatus,
    mode: RemoteControlHumanOutputMode,
) -> anyhow::Result<Vec<String>>
```

**Purpose**: Builds the human-readable lines shown after remote control starts. Foreground mode gets an extra reminder about how to stop it.

**Data flow**: It receives a readiness summary and an output mode. It creates the main status sentence, then adds `Press Ctrl-C to stop.` only for foreground mode, and returns the list of lines.

**Call relations**: Both foreground and daemon start printers call this. The mode value lets one helper serve both cases without duplicating the status wording.

*Call graph*: called by 2 (print_foreground_ready_output, print_remote_control_start_output); 1 external calls (vec!).


##### `daemon_app_server_human_lines`  (lines 417–424)

```
fn daemon_app_server_human_lines(output: &AppServerRemoteControlStartOutput) -> Vec<String>
```

**Purpose**: Builds the human-readable lines that say which app-server executable the daemon used. This helps users understand what binary and version are actually running.

**Data flow**: It receives daemon startup output, extracts the managed Codex path and optional version, and returns three display lines: a heading, the path, and the version or `unknown`.

**Call relations**: `print_remote_control_start_output` calls this after the remote-control status lines for daemon startup. It relies on `daemon_app_server_identity` to hide the difference between daemon bootstrap and normal daemon start results.

*Call graph*: calls 1 internal fn (daemon_app_server_identity); called by 1 (print_remote_control_start_output); 1 external calls (vec!).


##### `daemon_app_server_identity`  (lines 426–439)

```
fn daemon_app_server_identity(
    output: &AppServerRemoteControlStartOutput,
) -> (&std::path::Path, Option<&str>)
```

**Purpose**: Extracts the app-server path and version from daemon startup output, no matter which daemon-start path produced it. This gives the display code one simple shape to use.

**Data flow**: It receives either a bootstrap result or a start result. It matches the variant, then returns a borrowed path and an optional version string from inside that result.

**Call relations**: `daemon_app_server_human_lines` calls this before formatting daemon details. It is a small normalizer for the two daemon output variants.

*Call graph*: called by 1 (daemon_app_server_human_lines).


##### `print_remote_control_stop_output`  (lines 441–452)

```
fn print_remote_control_stop_output(
    output: &AppServerLifecycleOutput,
    json: bool,
) -> anyhow::Result<()>
```

**Purpose**: Prints the result of stopping remote control. It supports JSON for scripts and a short sentence for people.

**Data flow**: It receives lifecycle output from the daemon and the JSON flag. In JSON mode it serializes the full lifecycle output; otherwise it prints the sentence produced by `remote_control_stop_human_message`.

**Call relations**: `run` calls this after it asks the daemon lifecycle system to stop. It is the stop-side counterpart to the start-output functions.

*Call graph*: called by 1 (run); 1 external calls (println!).


##### `remote_control_stop_human_message`  (lines 454–468)

```
fn remote_control_stop_human_message(output: &AppServerLifecycleOutput) -> String
```

**Purpose**: Turns a daemon stop status into a plain English sentence. It gives simple messages for common stop outcomes and a fallback for unusual lifecycle statuses.

**Data flow**: It receives lifecycle output and reads its status. `Stopped` becomes `Remote control stopped.`, `NotRunning` becomes `Remote control is not running.`, and other statuses are included by name in a generic completion message.

**Call relations**: `print_remote_control_stop_output` uses this for human output. Keeping it separate makes the wording easy to test and adjust.

*Call graph*: 1 external calls (format!).


##### `tests::remote_control_status`  (lines 478–487)

```
fn remote_control_status(
        status: RemoteControlConnectionStatus,
    ) -> AppServerRemoteControlReadyStatus
```

**Purpose**: Creates a sample remote-control readiness status for tests. It avoids repeating the same test data in every assertion.

**Data flow**: It receives a connection status and builds a readiness summary with a fixed server name, fixed environment ID, and a timeout flag that is true only for the connecting case.

**Call relations**: Several tests call this to check human and JSON formatting. It is test support code, not part of the production command path.


##### `tests::daemon_ready_output`  (lines 489–510)

```
fn daemon_ready_output(
        status: RemoteControlConnectionStatus,
    ) -> AppServerRemoteControlReadyOutput
```

**Purpose**: Creates a sample daemon readiness result for tests. It includes both daemon lifecycle details and remote-control status details.

**Data flow**: It receives a connection status and builds a full daemon output with fixed paths, versions, process ID, server name, and environment ID. The timeout flag mirrors the connecting status.

**Call relations**: JSON and daemon display tests use this fixture to verify output without needing a real daemon. It is test-only setup data.

*Call graph*: 2 external calls (Start, from).


##### `tests::remote_control_human_start_messages_use_server_name`  (lines 513–544)

```
fn remote_control_human_start_messages_use_server_name()
```

**Purpose**: Verifies that human start messages include the server name and reject bad statuses. This protects the user-facing wording for connected, connecting, errored, and disabled cases.

**Data flow**: It builds sample statuses, calls the human-message helper, and compares either the returned sentence or returned error text to the expected value.

**Call relations**: This test exercises `remote_control_start_human_message` and, through it, the startability check. It helps ensure users do not see a misleading success message.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::remote_control_human_lines_include_foreground_stop_hint_only`  (lines 547–563)

```
fn remote_control_human_lines_include_foreground_stop_hint_only()
```

**Purpose**: Verifies that only foreground mode prints the Ctrl-C stop hint. Daemon mode should not tell the user to press Ctrl-C because the daemon continues after the command exits.

**Data flow**: It creates a connected status, asks for foreground lines and daemon lines, and compares each list to the expected text.

**Call relations**: This test calls `remote_control_start_human_lines` using sample status data. It protects the difference between foreground and daemon user instructions.

*Call graph*: 2 external calls (assert_eq!, remote_control_status).


##### `tests::daemon_app_server_human_lines_include_path_and_version`  (lines 566–577)

```
fn daemon_app_server_human_lines_include_path_and_version()
```

**Purpose**: Verifies that daemon human output includes the app-server path and version. This keeps diagnostic information visible to users.

**Data flow**: It creates a daemon output fixture, passes its daemon section to the formatting helper, and compares the resulting lines to the expected path and version text.

**Call relations**: This test covers `daemon_app_server_human_lines` and indirectly the identity extraction helper. It does not start a real daemon.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::remote_control_json_output_marks_foreground_or_daemon`  (lines 580–617)

```
fn remote_control_json_output_marks_foreground_or_daemon()
```

**Purpose**: Verifies the JSON shape for both foreground and daemon startup output. It makes sure tools can tell which mode was used and can read the expected fields.

**Data flow**: It builds foreground and daemon sample outputs, converts the JSON-output structs to JSON values, and compares them to exact expected JSON objects.

**Call relations**: This test exercises `RemoteControlStartJsonOutput::foreground` and `RemoteControlStartJsonOutput::daemon`. It protects the machine-readable contract of the CLI.

*Call graph*: 3 external calls (assert_eq!, daemon_ready_output, remote_control_status).


##### `tests::remote_control_daemon_json_rejects_unstartable_status`  (lines 620–630)

```
fn remote_control_daemon_json_rejects_unstartable_status()
```

**Purpose**: Verifies that daemon JSON output is not printed for an errored remote-control status. This confirms JSON mode follows the same safety rule as human mode.

**Data flow**: It creates a daemon output whose remote-control status is errored, calls the daemon start printer in JSON mode, and checks that the returned error message is correct.

**Call relations**: This test covers `print_remote_control_start_output` and the shared startability check. It guards against scripts receiving a success-shaped JSON object for a failed connection.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::foreground_wait_aborts_app_server_on_stop_signal`  (lines 633–645)

```
async fn foreground_wait_aborts_app_server_on_stop_signal()
```

**Purpose**: Verifies that the foreground wait ends cleanly when a stop signal is already set. This simulates the user pressing Ctrl-C while the app-server task would otherwise run forever.

**Data flow**: It starts a never-ending app-server task, creates a stop channel, sets the stop value to true, then calls `wait_for_foreground_app_server` inside a timeout. The expected result is a clean return before the timeout expires.

**Call relations**: This async test calls `wait_for_foreground_app_server` directly. It protects the shutdown path used by foreground remote control.

*Call graph*: calls 1 internal fn (wait_for_foreground_app_server); 4 external calls (from_secs, spawn, channel, timeout).


##### `tests::foreground_start_wait_stops_before_ready`  (lines 648–667)

```
async fn foreground_start_wait_stops_before_ready()
```

**Purpose**: Verifies that foreground startup returns a stopped result if the stop signal arrives before readiness. This covers cancelling startup before the server is usable.

**Data flow**: It starts a never-ending app-server task, creates and sets a stop signal, and waits for startup using a readiness future that never completes. The expected startup result is `Stopped`.

**Call relations**: This async test calls `wait_for_foreground_remote_control_start`. It mirrors the early-cancel branch used by `run_foreground_remote_control`.

*Call graph*: calls 1 internal fn (wait_for_foreground_remote_control_start); 5 external calls (assert!, from_secs, spawn, channel, timeout).


##### `tests::foreground_start_wait_reports_app_server_exit_before_ready`  (lines 670–694)

```
async fn foreground_start_wait_reports_app_server_exit_before_ready()
```

**Purpose**: Verifies that startup reports a useful error if the app-server exits before remote control becomes ready. This helps users see that startup failed early instead of silently hanging.

**Data flow**: It starts an app-server task that immediately returns an I/O error, uses a readiness future that never completes, and waits for startup. It expects an `AppServerExited` result with the specific early-exit message.

**Call relations**: This async test calls `wait_for_foreground_remote_control_start` and checks the error path produced through `foreground_app_server_exited_before_ready`. It protects the failure reporting used during foreground startup.

*Call graph*: calls 1 internal fn (wait_for_foreground_remote_control_start); 7 external calls (assert_eq!, other, panic!, from_secs, spawn, channel, timeout).


### Sandbox and maintenance commands
These top-level utilities handle sandbox execution and setup, doctor diagnostics, and session archive lifecycle operations.

### `cli/src/debug_sandbox.rs`

`orchestration` · `CLI command execution`

This file is the bridge between a `codex sandbox ...` style command and the operating system sandbox that actually restricts the command. A sandbox is like putting a program in a room with only certain doors unlocked: it may read some files, write to some places, or use the network only if the configured permissions allow it. Without this file, the debug sandbox command would not know how to turn Codex configuration into a real restricted process.

The flow starts with small platform-specific entry functions for Seatbelt on macOS, Landlock on Linux, and the Windows sandbox. They unpack the command-line request, decide whether managed requirements should be included, and send everything to one shared runner.

The shared runner loads the Codex configuration, decides the working directory, builds the environment variables, and starts a managed network proxy if the permissions require one. It then converts the chosen permission profile into the form expected by the platform sandbox. On macOS it prepares arguments for Apple `sandbox-exec`; on Linux it prepares arguments for the Codex Linux sandbox helper; on Windows it starts a Windows sandbox session and forwards input and output.

A few helper functions preserve compatibility with older configuration styles. If no newer permission profile is active, legacy configs default to read-only access, so debugging remains safely restrictive unless the caller asks otherwise.

#### Function details

##### `run_command_under_seatbelt`  (lines 79–85)

```
async fn run_command_under_seatbelt(
    _command: SeatbeltCommand,
    _codex_linux_sandbox_exe: Option<PathBuf>,
    _loader_overrides: LoaderOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Starts a command under the macOS Seatbelt sandbox, which is Apple's built-in process restriction system. On non-macOS systems, it reports that this sandbox is not available.

**Data flow**: It receives a parsed Seatbelt command, an optional path to the Linux sandbox helper, and configuration loading overrides. On macOS, it pulls out the permission profile, working directory, denial logging choice, Unix socket allowances, and command arguments, decides whether managed requirements should count, then passes the full request to the shared sandbox runner. The result is either a completed sandboxed run or an error.

**Call relations**: This is the macOS-specific front door into the shared sandbox flow. It uses `ManagedRequirementsMode::for_profile_invocation` to interpret the user's profile choice, then hands off to `run_command_under_sandbox`; if compiled on another operating system, it stops immediately with an error.

*Call graph*: calls 2 internal fn (for_profile_invocation, run_command_under_sandbox); 1 external calls (bail!).


##### `run_command_under_landlock`  (lines 87–119)

```
async fn run_command_under_landlock(
    command: LandlockCommand,
    codex_linux_sandbox_exe: Option<PathBuf>,
    loader_overrides: LoaderOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Starts a command under the Linux Landlock sandbox, which limits what files and resources the process can access. It prepares the Linux-specific request and delegates the rest to the common runner.

**Data flow**: It receives a parsed Landlock command, an optional sandbox helper executable path, and configuration loader overrides. It extracts the permission profile, working directory, CLI config overrides, and command to run, chooses whether managed requirements apply, and passes those values into the shared sandbox runner. The output is the final result of running or failing to run the sandboxed command.

**Call relations**: This is the Linux-oriented entry into the shared sandbox machinery. It calls `ManagedRequirementsMode::for_profile_invocation` first, then relies on `run_command_under_sandbox` to load configuration, create sandbox arguments, spawn the child process, and report the exit status.

*Call graph*: calls 2 internal fn (for_profile_invocation, run_command_under_sandbox).


##### `run_command_under_windows_sandbox`  (lines 121–153)

```
async fn run_command_under_windows_sandbox(
    command: WindowsCommand,
    codex_linux_sandbox_exe: Option<PathBuf>,
    loader_overrides: LoaderOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Starts a command under the Windows sandbox path. It packages the Windows command settings and sends them through the shared sandbox runner.

**Data flow**: It receives a parsed Windows sandbox command, an optional Linux sandbox helper path, and loader overrides. It extracts the requested permission profile, working directory, command, and config overrides, decides whether managed requirements should be included, and calls the shared runner with the Windows sandbox type. The caller gets success only if the command runs and exits cleanly according to the shared exit handling.

**Call relations**: This is the Windows-specific front door. Like the macOS and Linux entry functions, it first calls `ManagedRequirementsMode::for_profile_invocation`, then passes control to `run_command_under_sandbox`, which branches into Windows-only session launching when appropriate.

*Call graph*: calls 2 internal fn (for_profile_invocation, run_command_under_sandbox).


##### `ManagedRequirementsMode::for_profile_invocation`  (lines 177–186)

```
fn for_profile_invocation(
        permissions_profile: &Option<String>,
        include_managed_config: bool,
    ) -> Self
```

**Purpose**: Decides whether managed requirements, such as centrally supplied permission rules, should be included for this sandbox run. It protects the meaning of an explicit permission profile: if the caller chooses a profile and does not ask to include managed config, managed requirements are ignored.

**Data flow**: It receives the optional permission profile name and a boolean saying whether managed configuration should be included. If there is a profile and managed config was not requested, it returns `Ignore`; otherwise it returns `Include`. Nothing outside the return value is changed.

**Call relations**: The three platform entry functions call this before entering the common runner. The returned mode later influences configuration loading inside `build_debug_sandbox_config_with_loader_overrides`, where managed requirements may be turned off.

*Call graph*: called by 3 (run_command_under_landlock, run_command_under_seatbelt, run_command_under_windows_sandbox).


##### `run_command_under_sandbox`  (lines 189–360)

```
async fn run_command_under_sandbox(
    config_options: DebugSandboxConfigOptions,
    command: Vec<String>,
    config_overrides: CliConfigOverrides,
    codex_linux_sandbox_exe: Option<PathBuf>,
```

**Purpose**: This is the main coordinator that turns a sandbox debug request into a real child process running with restricted permissions. It loads configuration, prepares environment variables and network proxy settings, builds platform-specific sandbox arguments, starts the process, optionally reports denials, and handles the exit status.

**Data flow**: It receives config options, the command to run, CLI config overrides, an optional Linux sandbox helper path, the sandbox type, denial logging settings, and extra allowed Unix sockets. It loads the effective Codex configuration, chooses the working directory, builds the child environment, optionally starts a managed network proxy, adjusts permissions so the proxy certificate can be read, and then spawns the correct sandbox wrapper for macOS or Linux, or starts a Windows sandbox session. It waits for the child process, prints macOS denial information if requested, and exits according to the child's status.

**Call relations**: All platform entry functions hand off to this shared runner. It calls `load_debug_sandbox_config` for configuration, uses platform helper functions such as `create_seatbelt_command_args` or `create_linux_sandbox_command_args_for_permission_profile` to build sandbox launch arguments, calls `spawn_debug_sandbox_child` for non-Windows child processes, calls `run_command_under_windows_session` for Windows, and finally passes the child's exit status to `handle_exit_status`.

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

**Purpose**: Starts and drives a Windows sandbox session for the requested command. It is written to end the current process with the sandboxed command's exit code, so it behaves like the sandboxed program inherited the terminal directly.

**Data flow**: It receives the loaded configuration, command arguments, working directory, workspace roots, and environment variables. It builds a Windows sandbox session request using the effective permission profile, Codex home, sandbox level, terminal settings, and private desktop setting. If the session cannot start, it prints an error and exits with code 1; otherwise it forwards standard input, output, and error until the sandboxed command finishes, then exits with that command's code.

**Call relations**: `run_command_under_sandbox` calls this only when the requested sandbox type is Windows and the code is running on Windows. It hands the session to the Windows sandbox library and then to standard-input/output forwarding, rather than returning to the normal child-process path.

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

**Purpose**: Starts the actual sandbox wrapper process for non-Windows runs, with the right arguments, working directory, environment, and inherited terminal streams. It is the final launch step before the debug command is running.

**Data flow**: It receives the wrapper program path, argument list, optional displayed process name, working directory, network policy, a prepared environment map, and a callback that can add more environment variables. It creates a Tokio child process command, clears the parent environment, installs only the chosen variables, marks network-disabled state when needed, connects the child's input/output/error to the current terminal, and spawns it. The result is a running child process handle or an I/O error.

**Call relations**: `run_command_under_sandbox` calls this after it has built either Seatbelt or Landlock launch arguments. The returned child handle is then watched by `run_command_under_sandbox`, which waits for completion and performs any denial logging or exit handling.

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

**Purpose**: Loads the Codex configuration for a debug sandbox run using the normal Codex home location. It is a convenience wrapper around the more flexible config-loading function.

**Data flow**: It receives parsed CLI overrides, an optional Linux sandbox helper path, debug sandbox options, and a strict-config flag. It forwards those values to `load_debug_sandbox_config_with_codex_home` with no custom Codex home. It returns the built `Config` or an error.

**Call relations**: `run_command_under_sandbox` calls this at the start of a sandbox run. The heavier logic lives in `load_debug_sandbox_config_with_codex_home`, which tests also call directly so they can use temporary Codex home folders.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); called by 1 (run_command_under_sandbox).


##### `load_debug_sandbox_config_with_codex_home`  (lines 457–517)

```
async fn load_debug_sandbox_config_with_codex_home(
    cli_overrides: Vec<(String, TomlValue)>,
    codex_linux_sandbox_exe: Option<PathBuf>,
    options: DebugSandboxConfigOptions,
    codex_home: O
```

**Purpose**: Builds the effective configuration for a debug sandbox run, including compatibility rules for old and new permission settings. It makes sure explicit permission profiles are respected, while older configs still default to a safer read-only sandbox.

**Data flow**: It receives CLI override key-value pairs, an optional Linux sandbox helper path, debug sandbox options, an optional Codex home directory, and a strict-config flag. If the user selected a permission profile, it adds that as the `default_permissions` override. It then builds a config once, checks whether it uses the newer permission-profile style or an explicit old `sandbox_mode`, and returns it if so. If neither is true, it rebuilds with a read-only sandbox mode so legacy behavior remains restrictive.

**Call relations**: The general loader `load_debug_sandbox_config` calls this during real sandbox runs, and many tests call it directly to check edge cases. It delegates actual builder setup to `build_debug_sandbox_config_with_loader_overrides`, and uses `cli_overrides_use_legacy_sandbox_mode` and `config_uses_permission_profiles` to decide whether to keep the first config or rebuild it as read-only.

*Call graph*: calls 3 internal fn (build_debug_sandbox_config_with_loader_overrides, cli_overrides_use_legacy_sandbox_mode, config_uses_permission_profiles); called by 8 (load_debug_sandbox_config, debug_sandbox_defaults_legacy_configs_to_read_only, debug_sandbox_honors_active_permission_profiles, debug_sandbox_honors_config_profile_loader_overrides, debug_sandbox_honors_explicit_builtin_permission_profile, debug_sandbox_honors_explicit_legacy_sandbox_mode, debug_sandbox_honors_explicit_named_permission_profile, debug_sandbox_uses_explicit_cwd); 2 external calls (default, String).


##### `build_debug_sandbox_config_with_loader_overrides`  (lines 519–541)

```
async fn build_debug_sandbox_config_with_loader_overrides(
    cli_overrides: Vec<(String, TomlValue)>,
    harness_overrides: ConfigOverrides,
    codex_home: Option<PathBuf>,
    managed_requirement
```

**Purpose**: Creates a `Config` object from CLI overrides, harness overrides, optional Codex home, loader settings, and the managed-requirements choice. This is the low-level config builder used by the sandbox debug path.

**Data flow**: It receives override values from the command line and harness, an optional Codex home directory, the managed requirements mode, loader overrides, and a strict-config flag. It sets up a `ConfigBuilder`, marks managed requirements to be ignored when requested, applies any custom Codex home and fallback working directory, then asynchronously builds the final config. The output is a `Config` or an I/O error.

**Call relations**: `load_debug_sandbox_config_with_codex_home` uses this to build either the first candidate config or the read-only fallback config. Test helpers also call it so tests can compare exact configurations under controlled override combinations.

*Call graph*: called by 3 (load_debug_sandbox_config_with_codex_home, build_debug_sandbox_config, debug_sandbox_honors_config_profile_loader_overrides); 2 external calls (default, matches!).


##### `config_uses_permission_profiles`  (lines 543–549)

```
fn config_uses_permission_profiles(config: &Config) -> bool
```

**Purpose**: Checks whether the effective configuration uses the newer permission-profile setting. This tells the loader not to apply the old read-only fallback behavior.

**Data flow**: It receives a loaded `Config`. It looks inside the effective configuration layer for the `default_permissions` key and returns true if it is present, false otherwise. It does not modify the config.

**Call relations**: `load_debug_sandbox_config_with_codex_home` calls this after building a candidate config. If it returns true, the loader keeps that config because a permission profile is already in charge.

*Call graph*: called by 1 (load_debug_sandbox_config_with_codex_home).


##### `cli_overrides_use_legacy_sandbox_mode`  (lines 551–553)

```
fn cli_overrides_use_legacy_sandbox_mode(cli_overrides: &[(String, TomlValue)]) -> bool
```

**Purpose**: Checks whether the caller explicitly supplied the older `sandbox_mode` override. This preserves the caller's intentional legacy setting instead of silently replacing it with read-only.

**Data flow**: It receives a list of CLI override pairs. It scans the keys and returns true if any key is exactly `sandbox_mode`; otherwise it returns false. The override list is only read, not changed.

**Call relations**: `load_debug_sandbox_config_with_codex_home` calls this before deciding whether to rebuild the config with a read-only fallback. A true result means the user deliberately chose the older sandbox mode, so the first config is kept.

*Call graph*: called by 1 (load_debug_sandbox_config_with_codex_home).


##### `tests::build_debug_sandbox_config`  (lines 561–577)

```
async fn build_debug_sandbox_config(
        cli_overrides: Vec<(String, TomlValue)>,
        harness_overrides: ConfigOverrides,
        codex_home: Option<PathBuf>,
        managed_requirements_mode
```

**Purpose**: Provides a shorter test-only way to build a debug sandbox config without custom loader overrides. It keeps the tests focused on the behavior they are checking.

**Data flow**: It receives CLI overrides, harness overrides, optional Codex home, managed requirements mode, and a strict-config flag. It calls `build_debug_sandbox_config_with_loader_overrides` with default loader overrides and returns the resulting config or error.

**Call relations**: Several tests use this helper to build comparison configurations. It sits between test cases and the production config builder, reducing repeated setup code.

*Call graph*: calls 1 internal fn (build_debug_sandbox_config_with_loader_overrides); 1 external calls (default).


##### `tests::escape_toml_path`  (lines 579–581)

```
fn escape_toml_path(path: &std::path::Path) -> String
```

**Purpose**: Formats a filesystem path so it can be safely placed inside a TOML configuration string used by tests. This is especially important on systems where paths contain backslashes.

**Data flow**: It receives a path, turns it into display text, and doubles backslashes so the TOML text will read it correctly. It returns the escaped string and changes nothing on disk.

**Call relations**: The test config-writing helper uses this when embedding temporary directory paths into generated config files. It supports the tests that create named permission profiles.

*Call graph*: 1 external calls (display).


##### `tests::write_permissions_profile_config`  (lines 583–593)

```
fn write_permissions_profile_config(
        codex_home: &TempDir,
        docs: &std::path::Path,
        private: &std::path::Path,
    ) -> std::io::Result<()>
```

**Purpose**: Writes a test Codex config file into a temporary Codex home directory. The config defines a named permission profile with limited file access and network enabled.

**Data flow**: It receives a temporary Codex home directory plus paths for a readable docs folder and a private folder that should be denied. It chooses the standard `config.toml` path under Codex home and delegates the actual file creation. The result is success or an I/O error.

**Call relations**: Tests call this when they need a realistic named permission profile. It delegates to `tests::write_permissions_profile_config_to_path`, which writes the file contents.

*Call graph*: 2 external calls (path, write_permissions_profile_config_to_path).


##### `tests::write_permissions_profile_config_to_path`  (lines 595–615)

```
fn write_permissions_profile_config_to_path(
        config_path: &std::path::Path,
        docs: &std::path::Path,
        private: &std::path::Path,
    ) -> std::io::Result<()>
```

**Purpose**: Creates the actual test configuration file for a limited-read permission profile. It gives tests a small, concrete policy where some paths are allowed and one private path is denied.

**Data flow**: It receives the config file path, the docs path, and the private path. It creates the private directory, formats a TOML config string with escaped paths, and writes that text to disk. It returns success or an I/O error.

**Call relations**: This helper is called by `tests::write_permissions_profile_config` and directly by the loader-override test. The generated config is then loaded by the production config-loading functions under test.

*Call graph*: 3 external calls (format!, create_dir_all, write).


##### `tests::debug_sandbox_honors_active_permission_profiles`  (lines 618–676)

```
async fn debug_sandbox_honors_active_permission_profiles() -> anyhow::Result<()>
```

**Purpose**: Verifies that when a config already selects a permission profile, the debug sandbox uses that profile instead of falling back to legacy read-only behavior. This protects newer configuration files from being misread as old ones.

**Data flow**: The test creates temporary Codex and sandbox directories, writes a named permission profile, builds one config from that profile and another forced read-only legacy config, then loads the debug sandbox config normally. It compares the resulting file permissions to confirm they match the profile config and differ from the legacy read-only config.

**Call relations**: This test exercises `load_debug_sandbox_config_with_codex_home`, `config_uses_permission_profiles`, and the test config helpers. It proves the main loader keeps profile-based configuration as the source of truth.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 10 external calls (default, new, new, assert!, assert_eq!, assert_ne!, build_debug_sandbox_config, write_permissions_profile_config, default, default).


##### `tests::debug_sandbox_honors_config_profile_loader_overrides`  (lines 679–740)

```
async fn debug_sandbox_honors_config_profile_loader_overrides() -> anyhow::Result<()>
```

**Purpose**: Verifies that loader overrides selecting a specific config file and profile are respected by the debug sandbox. This matters when a caller wants the sandbox to use a non-default configuration profile.

**Data flow**: The test writes a permission-profile config to a custom file, builds loader overrides pointing at that file and profile name, then compares the loaded debug sandbox config against a config built directly from those overrides. It also compares against a read-only config to ensure the custom profile really changed the policy.

**Call relations**: This test calls `build_debug_sandbox_config_with_loader_overrides` and `load_debug_sandbox_config_with_codex_home`. It checks that the loader override path flows all the way through the debug sandbox config-loading path.

*Call graph*: calls 3 internal fn (build_debug_sandbox_config_with_loader_overrides, load_debug_sandbox_config_with_codex_home, from_absolute_path); 10 external calls (default, new, new, assert!, assert_eq!, assert_ne!, build_debug_sandbox_config, write_permissions_profile_config_to_path, default, default).


##### `tests::debug_sandbox_honors_explicit_legacy_sandbox_mode`  (lines 743–810)

```
async fn debug_sandbox_honors_explicit_legacy_sandbox_mode() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicit old-style `sandbox_mode` CLI override is not overwritten by the debug sandbox's read-only fallback. This keeps older callers compatible when they intentionally request a legacy mode.

**Data flow**: The test creates a temporary Codex home and a CLI override setting `sandbox_mode` to workspace-write. It builds comparison configs for workspace-write and read-only, then loads the debug sandbox config with the explicit override. It checks that the loaded policy matches the explicit workspace-write result, with a Windows-specific allowance where workspace-write may downgrade when Windows sandboxing is disabled.

**Call relations**: This test exercises `cli_overrides_use_legacy_sandbox_mode` through `load_debug_sandbox_config_with_codex_home`. It confirms the loader keeps deliberate legacy CLI input instead of applying the default read-only compatibility rule.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 10 external calls (default, new, new, assert_eq!, assert_ne!, cfg!, build_debug_sandbox_config, default, default, vec!).


##### `tests::debug_sandbox_defaults_legacy_configs_to_read_only`  (lines 813–850)

```
async fn debug_sandbox_defaults_legacy_configs_to_read_only() -> anyhow::Result<()>
```

**Purpose**: Verifies the safety fallback for old-style configs: when no permission profile and no explicit sandbox mode are present, the debug sandbox defaults to read-only. This prevents accidental broad access during debugging.

**Data flow**: The test creates a temporary Codex home, builds a read-only comparison config, then loads the debug sandbox config with no special overrides. It checks that no permission profile is active and that the resulting file permissions equal the read-only policy.

**Call relations**: This test calls `load_debug_sandbox_config_with_codex_home` and the test config builder. It validates the branch in the loader that rebuilds the config with `SandboxMode::ReadOnly`.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 7 external calls (default, new, new, assert!, assert_eq!, build_debug_sandbox_config, default).


##### `tests::debug_sandbox_honors_explicit_builtin_permission_profile`  (lines 853–885)

```
async fn debug_sandbox_honors_explicit_builtin_permission_profile() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicitly requested built-in permission profile, such as workspace write access, is preserved even when managed requirements are ignored. This ensures direct profile choices work without needing a custom config file.

**Data flow**: The test loads a debug sandbox config with the built-in `:workspace` profile and managed requirements set to ignore. It extracts the actual file-system policy and compares it with the expected built-in workspace-write policy, checking that the expected rules are present.

**Call relations**: This test calls `load_debug_sandbox_config_with_codex_home` with a direct profile name. It protects the path where `load_debug_sandbox_config_with_codex_home` converts `permissions_profile` into a `default_permissions` override.

*Call graph*: calls 2 internal fn (load_debug_sandbox_config_with_codex_home, workspace_write); 4 external calls (new, new, assert!, default).


##### `tests::debug_sandbox_honors_explicit_named_permission_profile`  (lines 888–927)

```
async fn debug_sandbox_honors_explicit_named_permission_profile() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicitly requested named permission profile from the user's config is honored. This checks that choosing a profile by name produces the same policy as setting it in config.

**Data flow**: The test writes a named limited-read profile into a temporary Codex home, then loads the debug sandbox config with that profile name as the explicit request. It separately builds the expected config by setting `default_permissions` to the same name, and compares the resulting file-system policies.

**Call relations**: This test uses the permission-profile config helper, `load_debug_sandbox_config_with_codex_home`, and the test config builder. It confirms the explicit profile path matches normal config-based profile selection.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 8 external calls (new, new, assert_eq!, build_debug_sandbox_config, write_permissions_profile_config, default, default, vec!).


##### `tests::debug_sandbox_uses_explicit_cwd`  (lines 930–951)

```
async fn debug_sandbox_uses_explicit_cwd() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicit working directory option becomes the working directory in the loaded debug sandbox config. This matters because sandbox rules can depend on where the command is run.

**Data flow**: The test creates temporary Codex home and working directory folders, then loads the debug sandbox config with the working directory set and a workspace permission profile. It checks that the config's `cwd` equals the requested directory.

**Call relations**: This test calls `load_debug_sandbox_config_with_codex_home` and checks that the `cwd` value passed through `DebugSandboxConfigOptions` survives the config-building path.

*Call graph*: calls 1 internal fn (load_debug_sandbox_config_with_codex_home); 4 external calls (new, new, assert_eq!, default).


### `cli/src/sandbox_setup.rs`

`orchestration` · `startup / CLI command execution`

This file is the command-line front door for a special Windows setup task: making Codex use an “elevated sandbox.” A sandbox is a controlled area where Codex can run with limits; “elevated” means this setup needs higher Windows privileges and extra provisioning. Without this file, users or deployment tools would not have a clear CLI path to prepare that sandbox and record the setting in Codex configuration.

The file first describes the accepted command-line flags. The user must say that they want the elevated setup, and they must identify the real Windows user who will run Codex. They can either name that user directly with `--user` and provide a `--codex-home` folder, or say `--current-user` and let the program discover the current account and default Codex home.

Once parsed, the command is deliberately narrow: it only supports the elevated setup level. The main run path resolves the identity, calls into the core Windows sandbox provisioning code, then writes `windows_sandbox_mode = elevated` into the user’s Codex config. This is like both installing a special lock on a workshop door and leaving a note in the workshop manual saying that this lock is now in use.

The tests focus on the safety rails: the command must include a user identity, managed users must include a Codex home, and unrelated sandbox commands are ignored.

#### Function details

##### `SandboxSetupCommand::setup_level`  (lines 48–54)

```
fn setup_level(&self) -> anyhow::Result<SandboxSetupLevel>
```

**Purpose**: This checks which sandbox setup level the user requested. Right now, the only allowed choice is the elevated Windows sandbox, so it rejects the command unless `--elevated` was supplied.

**Data flow**: It reads the parsed command fields from `SandboxSetupCommand`. If the elevated flag is true, it returns the internal `Elevated` setup level; if not, it returns an error explaining that `--elevated` is required.

**Call relations**: The top-level `run` function calls this first, before doing any real setup. This keeps unsupported or incomplete setup requests from reaching the provisioning code.

*Call graph*: called by 1 (run); 1 external calls (bail!).


##### `run`  (lines 57–61)

```
async fn run(cmd: SandboxSetupCommand) -> anyhow::Result<()>
```

**Purpose**: This is the main executor for the sandbox setup command. It decides which setup path to run based on the requested setup level.

**Data flow**: It receives a parsed `SandboxSetupCommand`, asks `setup_level` to turn the flags into a supported setup level, and then sends the command to the matching setup routine. Its output is success or an error from whichever step failed.

**Call relations**: The wider CLI entry point, `cli_main`, calls this when it has recognized a sandbox setup command. In the current design it always hands off to `run_elevated`, because elevated setup is the only supported level.

*Call graph*: calls 2 internal fn (setup_level, run_elevated); called by 1 (cli_main).


##### `parse_setup_command`  (lines 63–76)

```
fn parse_setup_command(
    sandbox_command: &[String],
) -> anyhow::Result<Option<SandboxSetupCommand>>
```

**Purpose**: This tries to recognize and parse the `setup` subcommand from raw sandbox command arguments. It lets the broader sandbox CLI tell the difference between setup requests and other sandbox-related commands.

**Data flow**: It receives a list of argument strings. If the first word is not `setup`, it returns `None` to say “this is not my command.” If it is `setup`, it asks Clap, the command-line parsing library, to convert those strings into a `SandboxSetupCommand`, returning either that parsed command or a parsing error.

**Call relations**: The main CLI code calls this while deciding what kind of sandbox command it has received. Two tests also call it directly: one proves it parses setup arguments, and another proves it leaves non-setup arguments alone.

*Call graph*: called by 3 (cli_main, ignores_non_setup_sandbox_command_args, parses_setup_from_sandbox_command_args); 1 external calls (try_parse_from).


##### `run_elevated`  (lines 78–101)

```
async fn run_elevated(cmd: SandboxSetupCommand) -> anyhow::Result<()>
```

**Purpose**: This performs the actual elevated Windows sandbox setup flow. It identifies the target user and Codex home folder, runs the Windows provisioning work, saves the configuration, and prints a success message.

**Data flow**: It starts with the parsed command. First it calls `resolve_sandbox_setup_identity` to get the real Windows username and the Codex home path. Then it calls the core Windows sandbox provisioning function with those values. After provisioning succeeds, it updates the Codex configuration in that home folder to say the sandbox mode is `elevated`. Finally, it prints a confirmation. If provisioning succeeds but saving config fails, it returns an error that makes that partial success clear.

**Call relations**: `run` calls this after confirming that the requested setup level is elevated. This function then hands the low-level Windows work to `codex_core::windows_sandbox::run_elevated_provisioning_setup` and hands the config-writing work to `ConfigEditsBuilder`.

*Call graph*: calls 3 internal fn (resolve_sandbox_setup_identity, new, run_elevated_provisioning_setup); called by 1 (run); 1 external calls (println!).


##### `resolve_sandbox_setup_identity`  (lines 108–139)

```
fn resolve_sandbox_setup_identity(
    cmd: &SandboxSetupCommand,
) -> anyhow::Result<SandboxSetupIdentity>
```

**Purpose**: This works out which Windows account and which Codex home folder the setup should apply to. It supports both the current user and a separately named managed-deployment user.

**Data flow**: It reads the parsed command. If `--current-user` was used, it reads the username from environment variables such as `USERNAME` or `USER`, then uses the provided Codex home or discovers the default one. If `--user` was used, it requires both the username and `--codex-home`. It returns a small identity object containing the chosen username and path, or an error if required information is missing.

**Call relations**: `run_elevated` calls this before provisioning because the core setup code needs exact user and folder information. This function calls `find_codex_home` only for the current-user case where no home folder was explicitly given.

*Call graph*: calls 1 internal fn (find_codex_home); called by 1 (run_elevated); 1 external calls (var).


##### `tests::parses_managed_user_identity`  (lines 146–164)

```
fn parses_managed_user_identity()
```

**Purpose**: This test proves that the command-line parser accepts a managed Windows user with an explicit Codex home. It protects the deployment scenario where setup is run for a named account.

**Data flow**: It feeds sample arguments into the parser: `setup`, `--elevated`, `--user`, and `--codex-home`. It then checks that the parsed command has the elevated flag set, stores the expected username, does not mark current-user mode, and keeps the expected Codex home path.

**Call relations**: This test calls the same Clap parsing path used by real CLI input. It supports the behavior that `parse_setup_command` and `run` depend on later.

*Call graph*: 3 external calls (assert!, assert_eq!, try_parse_from).


##### `tests::requires_explicit_user_identity`  (lines 167–172)

```
fn requires_explicit_user_identity()
```

**Purpose**: This test proves that the setup command refuses to run unless the user identity is stated. That prevents provisioning from guessing the wrong Windows account.

**Data flow**: It tries to parse only `setup --elevated`. The parser returns an error, and the test checks that the error is specifically a missing required argument.

**Call relations**: This test exercises the command definition rules directly. It backs up the guarantee that `resolve_sandbox_setup_identity` should receive a command that has either `--user` or `--current-user`.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::requires_codex_home_for_managed_user`  (lines 175–181)

```
fn requires_codex_home_for_managed_user()
```

**Purpose**: This test proves that a named managed user must also provide a Codex home folder. That matters because the program cannot safely infer another user’s Codex configuration location.

**Data flow**: It tries to parse `setup --elevated --user DOMAIN\alice` without `--codex-home`. The parser rejects it, and the test checks that the rejection is a missing required argument.

**Call relations**: This test confirms the parser-level rule used before `run_elevated` is reached. It reduces the chance that the provisioning step runs without knowing where to write the user’s Codex configuration.

*Call graph*: 2 external calls (assert_eq!, try_parse_from).


##### `tests::parses_setup_from_sandbox_command_args`  (lines 184–197)

```
fn parses_setup_from_sandbox_command_args()
```

**Purpose**: This test proves that `parse_setup_command` recognizes a real setup command and returns the parsed command. It checks the bridge between the wider sandbox CLI and this setup-specific file.

**Data flow**: It passes a list of strings beginning with `setup` and including elevated managed-user options. `parse_setup_command` returns `Some(command)`, and the test checks that the command contains the expected username.

**Call relations**: This test calls `parse_setup_command`, the same helper used by `cli_main`. It confirms that setup arguments are not merely valid in isolation, but are also detected correctly when routed through the sandbox command parser.

*Call graph*: calls 1 internal fn (parse_setup_command); 1 external calls (assert_eq!).


##### `tests::ignores_non_setup_sandbox_command_args`  (lines 200–205)

```
fn ignores_non_setup_sandbox_command_args()
```

**Purpose**: This test proves that this parser does not steal unrelated sandbox commands. If the first argument is not `setup`, the helper should step aside.

**Data flow**: It passes arguments like `echo hello` into `parse_setup_command`. The helper returns `None`, and the test checks that no setup command was produced.

**Call relations**: This test calls `parse_setup_command` to protect the broader CLI routing behavior. It ensures `cli_main` can ask this file about setup commands without breaking other sandbox subcommands.

*Call graph*: calls 1 internal fn (parse_setup_command); 1 external calls (assert!).


### `cli/src/doctor/thread_inventory.rs`

`domain_logic` · `doctor check execution`

Codex keeps conversation history in rollout files, and also keeps a faster thread inventory in a SQLite database. This file is the “stock check” that makes sure those two records tell the same story. Without it, Codex could silently show an incomplete thread list, point at files that no longer exist, or mark archived sessions incorrectly.

The check first scans two folders under CODEX_HOME: active sessions and archived sessions. It only looks at rollout JSONL files, reads enough of each file to learn its thread id, and records scan problems such as unreadable folders or badly named files. To avoid a runaway scan, it stops after a fixed maximum number of candidates.

Next it looks for the SQLite state database. If the database is missing, it decides whether that is harmless because there are no rollout files, or suspicious because rollout files exist but no inventory was built. If the database exists, it reads the thread rows and compares them with the scanned files. It reports rollout files missing from the database, database rows pointing to missing files, archive flags that disagree with file location, and duplicate thread ids or paths.

The result is a DoctorCheck: a structured health report with a status, human-readable details, samples, and possible remedies. The tests build small fake homes and databases to prove both healthy and broken cases are reported correctly.

#### Function details

##### `RolloutScan::candidate_count`  (lines 49–51)

```
fn candidate_count(&self) -> usize
```

**Purpose**: Counts how many rollout scan candidates have been recorded so far. This includes good files, malformed file names, and scan errors, because all of them consume space in the scan report.

**Data flow**: It reads the current RolloutScan lists, adds their lengths together, and returns that total number. It does not change the scan.

**Call relations**: The scan limit code asks this for the current total before accepting more work. scan_rollout_root also uses it directly before adding another rollout file.

*Call graph*: called by 2 (reached_candidate_cap, scan_rollout_root).


##### `RolloutScan::reached_candidate_cap`  (lines 53–55)

```
fn reached_candidate_cap(&self) -> bool
```

**Purpose**: Checks whether the rollout scan has reached the maximum number of items it is allowed to inspect or record. This keeps the doctor check from spending too much time or memory on huge directories.

**Data flow**: It asks candidate_count for the current total, compares that total with the fixed scan cap, and returns true or false. It does not change the scan by itself.

**Call relations**: The error-recording helpers call this before adding malformed names or scan errors, so they can stop adding more detail once the cap has been reached.

*Call graph*: calls 1 internal fn (candidate_count); called by 2 (record_malformed_name, record_scan_error).


##### `RolloutScan::record_malformed_name`  (lines 57–64)

```
fn record_malformed_name(&mut self, path: PathBuf)
```

**Purpose**: Records a rollout file whose name does not match the expected thread naming pattern. If the scan is already full, it marks the scan as capped instead of storing more paths.

**Data flow**: It receives a file path. If there is still room, it adds that path to malformed_names and updates the cap flag; if there is no room, it only marks reached_scan_cap as true.

**Call relations**: scan_rollout_root calls this after thread_id_from_rollout says a file was readable but its name could not be interpreted as a proper rollout name.

*Call graph*: calls 1 internal fn (reached_candidate_cap); called by 1 (scan_rollout_root).


##### `RolloutScan::record_scan_error`  (lines 66–73)

```
fn record_scan_error(&mut self, message: String)
```

**Purpose**: Records a problem encountered while walking rollout directories or reading rollout files. This lets the doctor report explain that the comparison may be incomplete.

**Data flow**: It receives an error message. If the scan has room, it stores the message and refreshes the cap flag; if not, it marks that the cap was reached and discards the extra message.

**Call relations**: scan_rollout_root calls this whenever it cannot read a directory entry, learn a file type, or parse a rollout file well enough to use it.

*Call graph*: calls 1 internal fn (reached_candidate_cap); called by 1 (scan_rollout_root).


##### `RolloutScan::active_count`  (lines 75–77)

```
fn active_count(&self) -> usize
```

**Purpose**: Counts how many scanned rollout files came from the active sessions area. The doctor report uses this as a quick summary of what was found on disk.

**Data flow**: It reads the scan’s file list, filters out archived files, and returns the number left. It does not modify anything.

**Call relations**: thread_inventory_check_for_roots uses this count when building the details shown in the final doctor result.


##### `RolloutScan::archived_count`  (lines 79–81)

```
fn archived_count(&self) -> usize
```

**Purpose**: Counts how many scanned rollout files came from the archived sessions area. This helps the report separate active conversations from archived ones.

**Data flow**: It reads the scan’s file list, keeps only files marked archived, and returns that count. Nothing is changed.

**Call relations**: thread_inventory_check_for_roots includes this number in the basic scan details before comparing against the database.


##### `thread_inventory_check`  (lines 84–91)

```
async fn thread_inventory_check(config: &Config) -> DoctorCheck
```

**Purpose**: Runs the thread inventory doctor check using the normal application configuration. This is the public entry used by the doctor system.

**Data flow**: It receives a Config, pulls out CODEX_HOME, the SQLite home, and the default model provider, then passes those values into the more general root-based checker. It returns the finished DoctorCheck.

**Call relations**: The broader doctor framework calls this check. It immediately hands the real work to thread_inventory_check_for_roots so the same logic can also be tested with temporary folders.

*Call graph*: calls 1 internal fn (thread_inventory_check_for_roots).


##### `thread_inventory_check_for_roots`  (lines 93–153)

```
async fn thread_inventory_check_for_roots(
    codex_home: &Path,
    sqlite_home: &Path,
    default_provider: &str,
) -> DoctorCheck
```

**Purpose**: Coordinates the full comparison between rollout files and the SQLite thread inventory. It builds the final health report for this check.

**Data flow**: It receives the rollout home folder, the SQLite home folder, and the default provider name. It scans rollout files, finds the state database path, adds summary details, then either reports a missing database, reports a database read error, or compares the scan with database rows and returns a DoctorCheck.

**Call relations**: thread_inventory_check calls this in normal use, and tests call it directly with fake directories. It delegates scanning to scan_rollout_files, database reading to codex_state, missing-database reporting to missing_state_db_check, and full parity comparison to parity_check_from_scan_and_rows.

*Call graph*: calls 6 internal fn (new, new, missing_state_db_check, parity_check_from_scan_and_rows, push_samples, scan_rollout_files); called by 3 (thread_inventory_check_ok_when_rollouts_match_db, thread_inventory_check_warns_for_missing_stale_and_mismatched_rows, thread_inventory_check); 4 external calls (read_thread_state_audit_rows, state_db_path, format!, vec!).


##### `missing_state_db_check`  (lines 155–210)

```
fn missing_state_db_check(scan: RolloutScan, details: Vec<String>) -> DoctorCheck
```

**Purpose**: Builds the doctor result for the special case where the SQLite state database does not exist. It decides whether that is okay or deserves a warning.

**Data flow**: It receives the rollout scan and already-built detail lines. If no files or scan problems exist, it returns an OK check. If rollout files or scan trouble exist, it returns a warning with issues and, when useful, a remedy explaining how startup backfill can recreate the database.

**Call relations**: thread_inventory_check_for_roots calls this only after discovering that the database file is missing. It produces the final DoctorCheck without trying to compare database rows.

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

**Purpose**: Performs the main “do the two inventories match?” comparison. It turns the raw rollout scan and database rows into counts, samples, warnings, and a final status.

**Data flow**: It receives CODEX_HOME, the scanned rollout files, the database audit rows, and existing detail text. It normalizes paths, groups rows by rollout path, finds missing rows, stale rows, archive mismatches, duplicate thread ids, duplicate database paths, provider summaries, and source summaries. It returns a DoctorCheck with OK status if nothing is wrong, otherwise a warning with specific issues.

**Call relations**: thread_inventory_check_for_roots calls this after successfully reading the database. It relies on helpers such as missing_rollout_paths, duplicate_rollout_thread_ids, duplicate_db_paths, path_key, push_path_samples, and push_samples to keep the comparison readable and the report concise.

*Call graph*: calls 8 internal fn (new, new, duplicate_db_paths, duplicate_rollout_thread_ids, missing_rollout_paths, path_key, push_path_samples, push_samples); called by 1 (thread_inventory_check_for_roots); 3 external calls (new, new, format!).


##### `scan_rollout_files`  (lines 423–438)

```
async fn scan_rollout_files(codex_home: &Path) -> RolloutScan
```

**Purpose**: Scans both active and archived rollout folders under CODEX_HOME. It returns one combined scan result that labels each discovered file as active or archived.

**Data flow**: It receives CODEX_HOME, creates an empty RolloutScan, scans CODEX_HOME/sessions as active, scans CODEX_HOME/archived_sessions as archived, and returns the filled scan.

**Call relations**: thread_inventory_check_for_roots calls this at the start of the doctor check. It hands each root folder to scan_rollout_root, which does the actual directory walking.

*Call graph*: calls 1 internal fn (scan_rollout_root); called by 1 (thread_inventory_check_for_roots); 2 external calls (join, default).


##### `scan_rollout_root`  (lines 440–503)

```
async fn scan_rollout_root(root: &Path, archived: bool, scan: &mut RolloutScan)
```

**Purpose**: Walks one rollout directory tree and records usable rollout files, malformed names, and scan errors. It is the file-system crawler for this doctor check.

**Data flow**: It receives a root path, an archived flag, and a mutable scan. It walks directories, ignores non-rollout files, checks the scan cap, reads each rollout’s thread id, then adds a RolloutAuditFile or records the reason the file could not be used.

**Call relations**: scan_rollout_files calls it once for active sessions and once for archived sessions. It calls is_rollout_file to filter names, thread_id_from_rollout to extract the thread id, path_key to normalize paths for comparison, and the RolloutScan recording helpers when something goes wrong.

*Call graph*: calls 6 internal fn (candidate_count, record_malformed_name, record_scan_error, is_rollout_file, path_key, thread_id_from_rollout); called by 1 (scan_rollout_files); 3 external calls (format!, read_dir, vec!).


##### `thread_id_from_rollout`  (lines 505–516)

```
async fn thread_id_from_rollout(path: &Path) -> RolloutThreadId
```

**Purpose**: Reads a rollout file and extracts the thread id that should identify that conversation. It also separates unreadable files from files with malformed rollout names.

**Data flow**: It receives a rollout file path, loads rollout items from the file, rejects empty or unreadable content, then asks the rollout builder to reconstruct metadata from those items. It returns either a thread id, a malformed-name marker, or an unusable-file reason.

**Call relations**: scan_rollout_root calls this for each candidate rollout file. Its result decides whether the file becomes part of the comparison or is reported as a scan problem.

*Call graph*: calls 1 internal fn (load_rollout_items); called by 1 (scan_rollout_root); 2 external calls (Unusable, builder_from_items).


##### `is_rollout_file`  (lines 518–524)

```
fn is_rollout_file(path: &Path) -> bool
```

**Purpose**: Checks whether a path looks like a rollout history file. This prevents the scanner from wasting work on unrelated files.

**Data flow**: It receives a path and checks two simple facts: the extension must be .jsonl, and the file name must start with rollout-. It returns true only when both are true.

**Call relations**: scan_rollout_root uses this while walking directories, before it tries to parse a file as rollout data.

*Call graph*: called by 1 (scan_rollout_root); 3 external calls (new, extension, file_name).


##### `count_or_skipped`  (lines 526–532)

```
fn count_or_skipped(count: usize, complete: bool) -> String
```

**Purpose**: Formats a count for the report, or explains that the count was skipped because the scan was incomplete. This avoids presenting unreliable numbers as if they were exact.

**Data flow**: It receives a number and a true-or-false flag saying whether the scan was complete. It returns the number as text when complete, or the phrase “skipped (scan cap reached)” when not.

**Call relations**: parity_check_from_scan_and_rows uses this when reporting stale rows and archive mismatches, because those checks are intentionally skipped if the rollout scan hit its cap.


##### `path_key`  (lines 534–536)

```
fn path_key(path: &Path) -> PathBuf
```

**Purpose**: Creates a normalized version of a path for reliable comparisons. This helps avoid false mismatches caused by different but equivalent path spellings.

**Data flow**: It receives a path, tries to normalize it with the shared path utility, and returns the normalized path. If normalization fails, it falls back to the original path.

**Call relations**: scan_rollout_root stores this key for each rollout file. parity_check_from_scan_and_rows uses it to group database rows and compare them with scanned files, and archived_from_rollout_path uses it to decide which root folder a path belongs to.

*Call graph*: called by 3 (archived_from_rollout_path, parity_check_from_scan_and_rows, scan_rollout_root); 1 external calls (normalize_for_path_comparison).


##### `archived_from_rollout_path`  (lines 538–547)

```
fn archived_from_rollout_path(codex_home: &Path, path: &Path) -> Option<bool>
```

**Purpose**: Infers whether a rollout path represents an archived or active session based on where it lives under CODEX_HOME. It is a fallback when the file was not already found in the scan map.

**Data flow**: It receives CODEX_HOME and a rollout path. It normalizes the path and compares it with the normalized archived_sessions and sessions roots, returning Some(true), Some(false), or None if the path is outside both known areas.

**Call relations**: parity_check_from_scan_and_rows uses this during archive mismatch checks when a database row points at a file that exists but was not found in the initial scanned map.

*Call graph*: calls 1 internal fn (path_key); 1 external calls (join).


##### `missing_rollout_paths`  (lines 549–559)

```
fn missing_rollout_paths(
    files: &'a [RolloutAuditFile],
    rows_by_key: &HashMap<PathBuf, Vec<&ThreadStateAuditRow>>,
    archived: bool,
) -> Vec<&'a Path>
```

**Purpose**: Finds rollout files that do not have a matching database thread row. It can do this separately for active files and archived files.

**Data flow**: It receives scanned files, database rows grouped by normalized path, and the archived flag to check. It keeps files with the requested archive state, asks whether each has a matching row with the same path and thread id, and returns the paths that are missing from the database.

**Call relations**: parity_check_from_scan_and_rows calls it twice: once for active rollout files and once for archived rollout files. It uses has_matching_thread_row to verify both the path and thread id match.

*Call graph*: called by 1 (parity_check_from_scan_and_rows); 1 external calls (iter).


##### `has_matching_thread_row`  (lines 561–569)

```
fn has_matching_thread_row(
    file: &RolloutAuditFile,
    rows_by_key: &HashMap<PathBuf, Vec<&ThreadStateAuditRow>>,
) -> bool
```

**Purpose**: Checks whether one scanned rollout file has a corresponding database row with the same normalized path and thread id. This avoids treating a row for the same path but wrong thread as a valid match.

**Data flow**: It receives one scanned rollout file and the database rows grouped by path. It looks up rows for that file’s key and returns true if any row has the same id as the file’s thread id.

**Call relations**: missing_rollout_paths uses this helper while building the list of rollout files that are absent from the SQLite inventory.


##### `duplicate_rollout_thread_ids`  (lines 571–582)

```
fn duplicate_rollout_thread_ids(files: &[RolloutAuditFile]) -> Vec<String>
```

**Purpose**: Finds thread ids that appear in more than one scanned rollout file. Duplicate ids are suspicious because each thread should have one identity.

**Data flow**: It receives the scanned files, walks their thread ids, records ids it has seen, collects ids that appear again, sorts them, and returns the duplicate id list.

**Call relations**: parity_check_from_scan_and_rows calls this to decide whether to add a duplicate-inventory warning and sample duplicate thread ids in the report.

*Call graph*: called by 1 (parity_check_from_scan_and_rows); 2 external calls (new, iter).


##### `duplicate_db_paths`  (lines 584–592)

```
fn duplicate_db_paths(rows_by_key: &HashMap<PathBuf, Vec<&ThreadStateAuditRow>>) -> Vec<PathBuf>
```

**Purpose**: Finds rollout paths that appear in more than one database row. A single rollout file should not be represented by multiple thread records.

**Data flow**: It receives database rows already grouped by normalized path, keeps paths whose row list has more than one entry, sorts those paths, and returns them.

**Call relations**: parity_check_from_scan_and_rows calls this after grouping database rows, then uses the result in detail counts, samples, and duplicate-entry warnings.

*Call graph*: called by 1 (parity_check_from_scan_and_rows).


##### `source_category`  (lines 594–619)

```
fn source_category(source: &str) -> &'static str
```

**Purpose**: Turns a stored session source value into a small, readable category such as cli, vscode, or subagent:review. This makes report summaries useful without exposing every raw source shape.

**Data flow**: It receives source text from a database row, tries to parse it as a structured SessionSource or as a plain string source, then returns a stable category name. If parsing fails, it returns “unparsable.”

**Call relations**: parity_check_from_scan_and_rows uses this while summarizing what kinds of sessions are present in the database. The source_category_coarsens_structured_sources test checks important structured cases.


##### `count_summary`  (lines 621–657)

```
fn count_summary(values: I) -> String
```

**Purpose**: Builds a compact frequency summary for repeated text values. It is used to show, for example, how many rows came from each provider or source category.

**Data flow**: It receives an iterator of values, counts how many times each appears, sorts by most common and then by name, keeps only a limited number of categories, and returns a comma-separated summary string. If there are no values, it returns “none.”

**Call relations**: parity_check_from_scan_and_rows uses this for model provider and source summaries. The count_summary_caps_distinct_values test calls it directly to confirm that long category lists are capped.

*Call graph*: called by 1 (count_summary_caps_distinct_values); 2 external calls (new, format!).


##### `push_path_samples`  (lines 659–665)

```
fn push_path_samples(
    details: &mut Vec<String>,
    label: &str,
    paths: impl Iterator<Item = &'a Path>,
)
```

**Purpose**: Adds a few example paths to the report details. Samples make the warning actionable without dumping every problem path.

**Data flow**: It receives the details list, a label, and an iterator of paths. It turns each path into display text and passes the first few values to push_samples.

**Call relations**: parity_check_from_scan_and_rows uses this for missing, stale, mismatched, and duplicate path examples. It is a path-specific wrapper around push_samples.

*Call graph*: calls 1 internal fn (push_samples); called by 1 (parity_check_from_scan_and_rows); 1 external calls (map).


##### `push_samples`  (lines 667–675)

```
fn push_samples(details: &mut Vec<String>, label: &str, values: I)
```

**Purpose**: Adds a limited number of example values to the report details. This keeps reports short while still showing concrete evidence.

**Data flow**: It receives the details list, a label, and values that can be turned into text. It takes only the configured sample limit and appends detail lines in the form “label: value.”

**Call relations**: thread_inventory_check_for_roots uses it for scan errors and malformed file names. parity_check_from_scan_and_rows uses it for duplicate thread id samples, and push_path_samples uses it for path examples.

*Call graph*: called by 3 (parity_check_from_scan_and_rows, push_path_samples, thread_inventory_check_for_roots); 2 external calls (take, format!).


##### `tests::thread_inventory_check_ok_when_rollouts_match_db`  (lines 689–729)

```
async fn thread_inventory_check_ok_when_rollouts_match_db()
```

**Purpose**: Tests the healthy case where active and archived rollout files both have matching database rows. It proves the check returns OK when the two inventories agree.

**Data flow**: It creates a temporary fixture, writes one active rollout and one archived rollout, inserts matching thread rows, runs the checker, and asserts that the status and important detail counts show no problems.

**Call relations**: This test calls thread_inventory_check_for_roots directly with temporary roots. It uses Fixture helpers to create the fake disk and database state, then uses assert_detail to verify the report.

*Call graph*: calls 1 internal fn (thread_inventory_check_for_roots); 3 external calls (assert_eq!, new, assert_detail).


##### `tests::thread_inventory_check_warns_for_missing_stale_and_mismatched_rows`  (lines 732–788)

```
async fn thread_inventory_check_warns_for_missing_stale_and_mismatched_rows()
```

**Purpose**: Tests a broken inventory with three different problems: a rollout missing from the database, a database row pointing at a missing file, and an archive flag mismatch. It proves these cases become warnings, not silent success.

**Data flow**: It builds a fixture, writes rollout files, inserts only selected database rows with one wrong archive flag and one stale path, runs the checker, and asserts the warning status, issue count, detail counts, and sample output.

**Call relations**: This test exercises thread_inventory_check_for_roots through realistic temporary files and rows. It depends on Fixture for setup and assert_detail for checking specific report lines.

*Call graph*: calls 1 internal fn (thread_inventory_check_for_roots); 4 external calls (assert!, assert_eq!, new, assert_detail).


##### `tests::Fixture::new`  (lines 796–809)

```
async fn new() -> Self
```

**Purpose**: Creates an isolated test environment with temporary Codex and SQLite homes. This lets tests run without touching a real user’s files.

**Data flow**: It creates two temporary directories, initializes the state runtime in the SQLite directory so the database schema exists, and returns a Fixture holding both directories.

**Call relations**: The inventory tests call this before writing rollout files or inserting rows. It hands back the controlled homes used by thread_inventory_check_for_roots.

*Call graph*: calls 1 internal fn (init); 1 external calls (new).


##### `tests::Fixture::write_rollout`  (lines 811–838)

```
fn write_rollout(&self, archived: bool, timestamp: &str, thread_id: &str) -> PathBuf
```

**Purpose**: Writes a small valid rollout file for a test thread. It can place the file in either the active sessions tree or the archived sessions tree.

**Data flow**: It receives an archived flag, timestamp, and thread id. It chooses the right folder, creates it, builds a session metadata rollout line, serializes it as JSON, writes it to a rollout-*.jsonl file, and returns the path.

**Call relations**: The tests call this to create the on-disk side of the comparison. The production scanner later reads these files through scan_rollout_root and thread_id_from_rollout.

*Call graph*: calls 1 internal fn (from_string); 7 external calls (default, path, format!, SessionMeta, to_string, create_dir_all, write).


##### `tests::Fixture::insert_thread_row`  (lines 840–884)

```
async fn insert_thread_row(&self, id: &str, rollout_path: &Path, archived: bool)
```

**Purpose**: Inserts one thread inventory row into the temporary SQLite database. This creates the database side of the comparison used by tests.

**Data flow**: It receives a thread id, rollout path, and archived flag. It opens the test state database, inserts a row with fixed test metadata and the requested values, executes the SQL, and closes the connection pool.

**Call relations**: The tests use this after writing rollout files to create matching, stale, or mismatched database records. thread_inventory_check_for_roots later reads those rows through codex_state.

*Call graph*: 6 external calls (display, new, new, path, state_db_path, query).


##### `tests::assert_detail`  (lines 887–895)

```
fn assert_detail(check: &DoctorCheck, label: &str, expected: &str)
```

**Purpose**: Checks that a DoctorCheck contains a detail line with an expected value. It makes test assertions easier to read.

**Data flow**: It receives a check, a detail label, and the expected text. It finds a detail starting with the label, extracts the value after the label, and asserts that it matches the expected value.

**Call relations**: Both main inventory tests call this to verify individual counts in the doctor report without manually searching the details each time.

*Call graph*: 2 external calls (assert_eq!, format!).


##### `tests::source_category_coarsens_structured_sources`  (lines 898–910)

```
fn source_category_coarsens_structured_sources()
```

**Purpose**: Tests that source_category turns both plain and structured session sources into stable summary labels. This protects report output for subagent and CLI sources.

**Data flow**: It passes representative source strings into source_category and asserts the returned category names. No files or database rows are involved.

**Call relations**: This test directly covers the source_category helper used by parity_check_from_scan_and_rows when summarizing database rows.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::count_summary_caps_distinct_values`  (lines 913–920)

```
fn count_summary_caps_distinct_values()
```

**Purpose**: Tests that count_summary limits long summaries and groups the rest into an “other” bucket. This keeps doctor details from becoming too noisy.

**Data flow**: It passes nine distinct values into count_summary and asserts that only the configured number of categories are shown before the remaining one is summarized as other.

**Call relations**: This test directly covers count_summary, which parity_check_from_scan_and_rows uses for provider and source summaries.

*Call graph*: calls 1 internal fn (count_summary); 1 external calls (assert_eq!).


### `cli/src/doctor.rs`

`orchestration` · `doctor command execution`

This file is like a mechanic's inspection checklist for Codex. When a user runs `codex doctor`, it gathers facts about the machine and the Codex setup: where the program was installed, whether config files load, whether credentials exist, whether network and MCP server settings are usable, whether the terminal can display Codex correctly, and more. Each check produces a `DoctorCheck`, which has a status, a short summary, details, possible issues, and suggested fixes. Smaller `DoctorIssue` values explain specific problems, such as `TERM=dumb` or a missing environment variable. The command can print either a human-friendly report or a JSON report for sharing. The JSON path deliberately hides or shortens sensitive details, such as editor commands or secrets-like configuration values, because reports may be attached to bug reports. The file also coordinates timing and progress updates, so slow checks can show signs of life instead of appearing stuck. If any check fails, the command exits with a failing process code, which lets scripts and users know the setup needs attention. This part of `doctor.rs` is the CLI’s troubleshooting kit. It asks practical questions a support person would ask: Is the terminal big enough to read output? Can tmux report useful terminal settings? Are Codex state folders and SQLite databases readable? Can the configured model provider be reached over HTTP or WebSocket? Do helper commands named in MCP server configuration actually exist?

The code gathers evidence from several places. It reads paths from configuration, checks files on disk, runs small `tmux` commands, looks at environment variables, performs DNS lookups, and sends short HTTP or WebSocket probes. It then packages the results as `DoctorCheck` objects. Each check has a status such as OK, Warning, or Fail, plus human-readable details and, when possible, a remedy.

A useful pattern here is “probe gently, explain clearly.” For example, an HTTP endpoint is considered reachable even if it returns an authentication error, because that still proves the server answered. But a missing `/models` route can indicate the configured API base URL points at the wrong path, so the doctor reports that as a more specific issue. The tests at the end protect these judgments so future changes do not make the diagnostics noisier, leak secrets, or misclassify common problems. The doctor command is like a pre-flight checklist. Before a user spends time debugging strange behavior, it can point out common local problems: a required MCP server command is missing, a certificate file cannot be read, a terminal is too narrow, colors are disabled, or the terminal setup cannot be trusted. The functions in this chunk are tests and small test helpers. They build controlled examples of broken or unusual environments, then check that the doctor logic reports them in a useful way. Several tests create fake inputs instead of relying on the real machine, which keeps the results predictable. For example, one test starts a tiny local HTTP server to confirm that an MCP HTTP probe tries a GET request when a HEAD request times out. Other tests simulate terminal environment variables such as TERM, COLUMNS, LANG, TERMINFO, and SSH_CONNECTION. The important theme is user-facing clarity: these tests do not just check pass or fail. They also check the summary text, details, and suggested remedies, because the doctor command is only useful if its diagnosis tells people what went wrong and how to fix it.

#### Function details

##### `DoctorIssue::new`  (lines 229–238)

```
fn new(severity: CheckStatus, cause: impl Into<String>) -> Self
```

**Purpose**: Creates a new specific problem found by a doctor check. It records how serious the problem is and the main reason it matters.

**Data flow**: It receives a severity and a cause message, converts the message into text, and creates an issue with no measured value, expected value, remedy, or fields yet.

**Call relations**: Individual checks call this when they discover a concrete problem. Follow-up builder methods add extra explanation before the issue is attached to a `DoctorCheck`.

*Call graph*: called by 8 (git_check_from_inputs, provider_reachability_check, terminal_check_from_inputs, terminal_size_issues, missing_state_db_check, parity_check_from_scan_and_rows, thread_inventory_check_for_roots, terminal_title_check_from_inputs); 2 external calls (into, new).


##### `DoctorIssue::measured`  (lines 240–243)

```
fn measured(mut self, measured: impl Into<String>) -> Self
```

**Purpose**: Adds what Codex actually observed for an issue. This helps users compare the current state with what should have been present.

**Data flow**: It takes an existing issue and a measured text value, stores that value on the issue, and returns the updated issue.

**Call relations**: It is used after `DoctorIssue::new` while building a detailed issue, usually before adding expected values and remedies.

*Call graph*: 1 external calls (into).


##### `DoctorIssue::expected`  (lines 245–248)

```
fn expected(mut self, expected: impl Into<String>) -> Self
```

**Purpose**: Adds what Codex expected to see for an issue. This makes the report more useful than just saying something is wrong.

**Data flow**: It takes an existing issue and expected text, stores it, and returns the updated issue.

**Call relations**: It fits into the issue-building chain after a problem is created and before the final issue is attached to a check.

*Call graph*: 1 external calls (into).


##### `DoctorIssue::remedy`  (lines 250–253)

```
fn remedy(mut self, remedy: impl Into<String>) -> Self
```

**Purpose**: Adds a suggested fix for a specific issue. This turns the report from a warning into practical guidance.

**Data flow**: It takes an existing issue and a remedy message, stores that message, and returns the updated issue.

**Call relations**: Checks use it while constructing issues that should tell the user how to recover.

*Call graph*: 1 external calls (into).


##### `DoctorIssue::field`  (lines 255–258)

```
fn field(mut self, field: impl Into<String>) -> Self
```

**Purpose**: Names the setting, environment variable, or report field connected to an issue. This points the user to the exact thing to inspect.

**Data flow**: It takes an existing issue and one field name, appends that name to the issue's field list, and returns the updated issue.

**Call relations**: It is usually used at the end of an issue-building chain, before the issue is added to a `DoctorCheck`.

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

**Purpose**: Creates the basic result for one doctor check. It gives the check an ID, category, status, and short summary.

**Data flow**: It receives identifying text, a status, and a summary, then creates a check with empty details, no issues, no remediation, and zero duration.

**Call relations**: Nearly every doctor check starts here, then adds details, issues, or remediation before being returned to the overall report.

*Call graph*: called by 25 (auth_check, background_server_check, config_check, fallback_state_check, git_check_from_inputs, installation_check, mcp_check_from_servers, network_check, render_human_report_includes_threads_row_in_environment, provider_reachability_check (+15 more)); 2 external calls (into, new).


##### `DoctorCheck::detail`  (lines 280–283)

```
fn detail(mut self, detail: impl Into<String>) -> Self
```

**Purpose**: Adds one explanatory line to a check. Details are the evidence behind the short summary.

**Data flow**: It takes a check and a detail string, appends the string to the detail list, and returns the updated check.

**Call relations**: Checks use this while assembling human-readable context about what was found.

*Call graph*: 1 external calls (into).


##### `DoctorCheck::details`  (lines 285–288)

```
fn details(mut self, details: Vec<String>) -> Self
```

**Purpose**: Adds several explanatory lines to a check at once. This is useful when a check has already collected a list of facts.

**Data flow**: It takes a check and a list of detail strings, appends all of them, and returns the updated check.

**Call relations**: Most larger checks gather details in a temporary list, then attach them through this method before returning.


##### `DoctorCheck::remediation`  (lines 290–293)

```
fn remediation(mut self, remediation: impl Into<String>) -> Self
```

**Purpose**: Adds a suggested next step for fixing a failed or suspicious check. It gives the user a clear action instead of only a diagnosis.

**Data flow**: It takes a check and remediation text, stores that text, and returns the updated check.

**Call relations**: Checks call this when their status is warning or fail and there is a useful repair suggestion.

*Call graph*: 1 external calls (into).


##### `DoctorCheck::issue`  (lines 295–298)

```
fn issue(mut self, issue: DoctorIssue) -> Self
```

**Purpose**: Attaches one specific issue to a check. This lets a check report several problems while keeping one overall status.

**Data flow**: It takes a check and a `DoctorIssue`, appends the issue to the check, and returns the updated check.

**Call relations**: Detailed checks, such as terminal checks, build issues separately and then add them to the final check with this method.


##### `run_doctor`  (lines 306–331)

```
async fn run_doctor(
    command: DoctorCommand,
    root_config_overrides: CliConfigOverrides,
    interactive: &TuiCli,
    arg0_paths: &Arg0DispatchPaths,
) -> anyhow::Result<()>
```

**Purpose**: Runs the doctor command from the command line. It builds the report, prints it in the requested format, and exits with an error code if something failed.

**Data flow**: It receives command options, config overrides, interactive CLI settings, and executable paths. It builds a report, prints either redacted JSON or human text, and returns success unless the report has a failing status, in which case the process exits with code 1.

**Call relations**: The main CLI calls this when the user asks for `codex doctor`. It hands the real inspection work to `build_report`, then chooses the output path.

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

**Purpose**: Coordinates all doctor checks and combines them into one report. It decides which checks can run immediately, which need loaded config, and what fallback checks to run if config loading fails.

**Data flow**: It receives doctor options, CLI config overrides, interactive settings, and executable paths. It runs system, installation, runtime, search, config-dependent, and fallback checks, records progress, computes the overall status, and returns a complete `DoctorReport`.

**Call relations**: `run_doctor` calls this once. It is the central dispatcher that calls the individual check functions and wraps them with timing and progress helpers.

*Call graph*: calls 8 internal fn (default_reachability_plan, generated_at, load_config, overall_status, doctor_progress, provider_reachability_plan, run_sync_check, shared_from_config); called by 1 (run_doctor); 3 external calls (new, env!, join!).


##### `load_config`  (lines 494–520)

```
async fn load_config(
    root_config_overrides: CliConfigOverrides,
    interactive: &TuiCli,
    arg0_paths: &Arg0DispatchPaths,
) -> anyhow::Result<Config>
```

**Purpose**: Loads Codex configuration in the same spirit as a real run, but marked as temporary for doctor inspection. This lets doctor checks see what Codex would actually use.

**Data flow**: It receives root CLI overrides, interactive options, and executable paths. It parses command-line key-value overrides, adds web search if requested, builds config overrides from interactive flags, and returns a loaded `Config` or an error.

**Call relations**: `build_report` calls this before running checks that need configuration. If it fails, `build_report` switches to a smaller fallback set of checks.

*Call graph*: calls 2 internal fn (config_overrides_from_interactive, parse_overrides); called by 1 (build_report); 2 external calls (default, String).


##### `config_overrides_from_interactive`  (lines 522–552)

```
fn config_overrides_from_interactive(
    interactive: &TuiCli,
    arg0_paths: &Arg0DispatchPaths,
) -> ConfigOverrides
```

**Purpose**: Turns interactive CLI flags into configuration override values. This keeps the doctor check aligned with the options the user supplied.

**Data flow**: It reads fields such as model, approval policy, sandbox mode, current directory, OSS provider, executable paths, and writable roots, then returns a `ConfigOverrides` structure.

**Call relations**: `load_config` uses this while preparing the config builder. Tests also use it to ensure important global options are preserved.

*Call graph*: called by 2 (load_config, config_overrides_from_interactive_preserves_global_options); 1 external calls (default).


##### `JsonDetailValue::push`  (lines 608–615)

```
fn push(&mut self, value: String)
```

**Purpose**: Adds another value to a JSON detail entry that may have one value or many. This keeps repeated detail keys from overwriting each other.

**Data flow**: It receives a string. If the entry held one previous value, it changes into a list containing the old and new values; if it was already a list, it appends the new value.

**Call relations**: Structured JSON detail building uses this when several report lines share the same key.

*Call graph*: 2 external calls (Many, vec!).


##### `redacted_json_report`  (lines 618–634)

```
fn redacted_json_report(report: &DoctorReport) -> JsonDoctorReport
```

**Purpose**: Converts the full doctor report into a JSON-safe version. It keeps useful structure while preparing the data for sharing.

**Data flow**: It reads the report metadata and checks, converts each check through the redaction path, and returns a `JsonDoctorReport` keyed by check ID.

**Call relations**: `run_doctor` uses this when the user requests JSON output. Tests verify that the resulting structure is sanitized.

*Call graph*: called by 1 (redacted_json_report_structures_and_sanitizes_details).


##### `redacted_json_check`  (lines 636–649)

```
fn redacted_json_check(check: &DoctorCheck) -> JsonDoctorCheck
```

**Purpose**: Converts one doctor check into its redacted JSON form. It organizes detail lines and removes sensitive text where needed.

**Data flow**: It reads a `DoctorCheck`, splits details into structured key-value data and notes, redacts issues and remediation, and returns a JSON check object.

**Call relations**: `redacted_json_report` calls this for every check in the report. It delegates detail parsing to `structured_json_details`.

*Call graph*: calls 1 internal fn (structured_json_details).


##### `redacted_json_issue`  (lines 651–664)

```
fn redacted_json_issue(issue: &DoctorIssue) -> JsonDoctorIssue
```

**Purpose**: Converts one issue into a JSON-safe issue. It redacts every user-facing text field that might contain private local information.

**Data flow**: It reads severity, cause, measured value, expected value, remedy, and fields from an issue, redacts the text values, and returns a JSON issue.

**Call relations**: `redacted_json_check` calls this while preparing the JSON version of a check.

*Call graph*: calls 1 internal fn (redact_detail).


##### `structured_json_details`  (lines 671–694)

```
fn structured_json_details(details: &[String]) -> (BTreeMap<String, JsonDetailValue>, Vec<String>)
```

**Purpose**: Turns plain detail lines into structured JSON when they look like `key: value`. Lines that do not fit that shape become notes.

**Data flow**: It receives detail strings, redacts each one, splits key-value lines, groups repeated keys, and returns both a map of structured details and a list of free-form notes.

**Call relations**: `redacted_json_check` uses this so JSON consumers can read important details by key instead of parsing plain text.

*Call graph*: calls 2 internal fn (json_detail_value, redact_detail); called by 1 (redacted_json_check); 3 external calls (new, new, One).


##### `json_detail_value`  (lines 696–709)

```
fn json_detail_value(key: &str, value: &str) -> String
```

**Purpose**: Sanitizes certain detail values before they enter JSON. Editor and pager settings can contain private commands, so JSON only says whether they are set.

**Data flow**: It receives a detail key and value. For sensitive editor or pager keys, it returns `set` unless the value says `not set`; otherwise it returns the original value.

**Call relations**: `structured_json_details` calls this while building redacted JSON details.

*Call graph*: called by 1 (structured_json_details); 1 external calls (matches!).


##### `run_sync_check`  (lines 711–722)

```
fn run_sync_check(
    label: &'static str,
    progress: Arc<dyn DoctorProgress>,
    f: impl FnOnce() -> DoctorCheck,
) -> DoctorCheck
```

**Purpose**: Runs a quick, non-async doctor check with progress reporting and timing. It gives every check a duration and visible start and finish events.

**Data flow**: It receives a label, a progress reporter, and a function that produces a check. It starts progress, runs the function, records elapsed milliseconds, finishes progress with the check status, and returns the check.

**Call relations**: `build_report` uses this for checks that do not need to wait on async work. Tests verify that progress notifications happen.

*Call graph*: called by 2 (build_report, run_sync_check_notifies_progress); 1 external calls (now).


##### `run_async_check`  (lines 724–751)

```
async fn run_async_check(
    label: &'static str,
    progress: Arc<dyn DoctorProgress>,
    future: Fut,
) -> DoctorCheck
```

**Purpose**: Runs an async doctor check with timing and heartbeat messages for slow work. This prevents long network or file checks from looking frozen.

**Data flow**: It receives a label, a progress reporter, and a future that will produce a check. It starts progress, waits for the future, sends heartbeat updates after a threshold, records duration, and returns the completed check.

**Call relations**: `build_report` uses this for checks that may wait on I/O, such as reachability or state checks. Tests verify its progress behavior.

*Call graph*: called by 1 (run_async_check_notifies_progress); 4 external calls (now, pin!, select!, interval).


##### `overall_status`  (lines 753–764)

```
fn overall_status(checks: &[DoctorCheck]) -> CheckStatus
```

**Purpose**: Computes the report's single overall health status from all individual checks. A failure beats a warning, and a warning beats OK.

**Data flow**: It reads the list of checks. If any failed it returns fail; otherwise if any warned it returns warning; otherwise it returns OK.

**Call relations**: `build_report` calls this after all checks finish, so the report and command exit behavior can reflect the worst result.

*Call graph*: called by 1 (build_report); 1 external calls (iter).


##### `generated_at`  (lines 766–774)

```
fn generated_at() -> String
```

**Purpose**: Creates a simple timestamp for the report. It records when the doctor report was generated.

**Data flow**: It reads the current system time and returns seconds since the Unix epoch, or `unknown` if the system clock cannot provide that value.

**Call relations**: `build_report` includes this value in every `DoctorReport`.

*Call graph*: called by 1 (build_report); 2 external calls (format!, now).


##### `installation_check`  (lines 776–866)

```
fn installation_check(show_details: bool) -> DoctorCheck
```

**Purpose**: Checks whether the running Codex installation looks consistent. It looks for confusing situations such as multiple `codex` executables on `PATH` or npm updates targeting a different install.

**Data flow**: It reads the current executable path, install context, package-manager environment variables, PATH lookup results, and npm global root when relevant. It builds details, chooses OK, warning, or fail, optionally adds remediation, and returns an installation check.

**Call relations**: `build_report` runs this early because install problems can explain many other failures. It calls helper functions that identify install context and compare npm package roots.

*Call graph*: calls 8 internal fn (new, codex_path_entries, doctor_install_context, doctor_managed_by_npm, inherited_managed_env_for_cargo_binary, npm_global_root_check, push_env_path_detail, push_path_detail); 3 external calls (new, current_exe, format!).


##### `doctor_install_context`  (lines 868–877)

```
fn doctor_install_context(current_exe: Option<&Path>) -> InstallContext
```

**Purpose**: Determines the install context for doctor output while ignoring misleading package-manager variables during local Cargo builds. Cargo is Rust's build tool, and local builds can inherit environment variables that do not describe the built binary.

**Data flow**: It receives the current executable path. If package-manager variables appear to be inherited by a Cargo-built binary, it returns an `Other` context; otherwise it returns the current detected install context.

**Call relations**: `installation_check` uses this to describe the install source without being fooled by inherited environment variables.

*Call graph*: calls 2 internal fn (inherited_managed_env_for_cargo_binary, current); called by 1 (installation_check).


##### `doctor_managed_by_npm`  (lines 879–882)

```
fn doctor_managed_by_npm(current_exe: Option<&Path>) -> bool
```

**Purpose**: Decides whether this doctor run should treat Codex as npm-managed. It avoids false positives from local Cargo-built binaries.

**Data flow**: It checks the npm management environment variable and the current executable path. It returns true only when npm management is present and not inherited by a Cargo build.

**Call relations**: `installation_check` uses this before running npm-specific consistency checks.

*Call graph*: calls 1 internal fn (inherited_managed_env_for_cargo_binary); called by 1 (installation_check); 1 external calls (var_os).


##### `inherited_managed_env_for_cargo_binary`  (lines 884–901)

```
fn inherited_managed_env_for_cargo_binary(current_exe: Option<&Path>) -> bool
```

**Purpose**: Detects a local Rust build that inherited npm or bun launch variables by accident. This prevents doctor from misreporting a development binary as package-manager installed.

**Data flow**: It reads package-manager environment variables and examines the executable path. If the path includes `target/debug` or `target/release`, it returns true; otherwise false.

**Call relations**: Install helpers call this to decide whether package-manager environment variables should be trusted.

*Call graph*: called by 3 (doctor_install_context, doctor_managed_by_npm, installation_check); 1 external calls (var_os).


##### `describe_install_context`  (lines 903–946)

```
fn describe_install_context(context: &InstallContext) -> String
```

**Purpose**: Turns the detected install context into a readable sentence for the report. It explains whether Codex came from standalone, npm, bun, brew, or another source.

**Data flow**: It receives an install context and formats its method and available package layout paths into one string.

**Call relations**: `installation_check` adds this string to its details so users can see how Codex thinks it was installed.

*Call graph*: calls 2 internal fn (describe_method_with_package_layout, display_optional_path); 1 external calls (format!).


##### `describe_method_with_package_layout`  (lines 948–964)

```
fn describe_method_with_package_layout(
    method: &str,
    package_layout: Option<&CodexPackageLayout>,
) -> String
```

**Purpose**: Formats package-layout details for non-standalone install methods. It shows package, binary, resources, and path directories when known.

**Data flow**: It receives a method name and optional layout. If layout exists, it formats key paths; otherwise it returns just the method name.

**Call relations**: `describe_install_context` uses this for npm, bun, brew, and other install methods.

*Call graph*: calls 1 internal fn (display_optional_path); called by 1 (describe_install_context); 1 external calls (format!).


##### `display_optional_path`  (lines 966–969)

```
fn display_optional_path(path: Option<&Path>) -> String
```

**Purpose**: Formats an optional filesystem path for report text. Missing paths are shown clearly as `none`.

**Data flow**: It receives an optional path and returns either the displayed path text or `none`.

**Call relations**: Install-context formatting helpers use this so their output stays readable when some paths are absent.

*Call graph*: called by 2 (describe_install_context, describe_method_with_package_layout).


##### `npm_global_root_check`  (lines 984–999)

```
fn npm_global_root_check() -> NpmRootCheck
```

**Purpose**: Checks whether `npm install -g @openai/codex` would update the same Codex package that is currently running. This catches PATH or npm-prefix mismatches.

**Data flow**: It reads the running package root from the environment, runs `npm root -g`, extracts npm's global root, compares the expected package path, and returns a match, mismatch, missing-root, or npm-unavailable result.

**Call relations**: `installation_check` calls this only when the current run appears npm-managed.

*Call graph*: calls 2 internal fn (compare_npm_package_roots, run_command); called by 1 (installation_check); 3 external calls (from, NpmUnavailable, var_os).


##### `compare_npm_package_roots`  (lines 1001–1015)

```
fn compare_npm_package_roots(running_package_root: &Path, npm_root: &Path) -> NpmRootCheck
```

**Purpose**: Compares the running npm package directory with npm's global Codex package directory. It accounts for path spelling differences before comparing.

**Data flow**: It receives the running package root and npm global root, builds npm's expected `@openai/codex` path, normalizes both paths, and returns either match or mismatch information.

**Call relations**: `npm_global_root_check` uses this after discovering npm's global root.

*Call graph*: calls 1 internal fn (normalize_path_for_compare); called by 1 (npm_global_root_check); 2 external calls (join, to_path_buf).


##### `normalize_path_for_compare`  (lines 1017–1025)

```
fn normalize_path_for_compare(path: &Path) -> String
```

**Purpose**: Normalizes a path so two paths can be compared more fairly. It resolves symlinks when possible, standardizes slashes, and lowercases on Windows.

**Data flow**: It receives a path, tries to canonicalize it, converts it to text with forward slashes, and returns a comparison string.

**Call relations**: `compare_npm_package_roots` uses this to avoid false mismatches caused by path formatting.

*Call graph*: called by 1 (compare_npm_package_roots); 2 external calls (canonicalize, cfg!).


##### `display_list`  (lines 1027–1037)

```
fn display_list(items: &[T]) -> String
```

**Purpose**: Formats a list of strings for report details. Empty lists are shown as `none` instead of a blank field.

**Data flow**: It receives a list of string-like items and returns either `none` or the items joined by commas.

**Call relations**: Feature flag reporting uses this to present enabled features and overrides cleanly.

*Call graph*: 2 external calls (is_empty, iter).


##### `codex_path_entries`  (lines 1039–1052)

```
fn codex_path_entries() -> Vec<String>
```

**Purpose**: Finds every `codex` executable visible on the user's PATH. Multiple entries can explain why the wrong version runs or updates go elsewhere.

**Data flow**: It runs `where codex` on Windows or `which -a codex` elsewhere, splits non-empty output lines, and returns them as a list.

**Call relations**: `installation_check` uses this to report duplicate or surprising executable locations.

*Call graph*: calls 1 internal fn (run_command); called by 1 (installation_check).


##### `run_command`  (lines 1054–1071)

```
fn run_command(program: &str, args: I) -> Result<String, String>
```

**Purpose**: Runs a small external command and captures its output. It turns command failures into readable error strings.

**Data flow**: It receives a program name and arguments, executes the command, returns standard output on success, or returns either standard error or the exit status on failure.

**Call relations**: Install checks use this to ask the operating system and npm where executables and global packages are located.

*Call graph*: called by 2 (codex_path_entries, npm_global_root_check); 3 external calls (from_utf8_lossy, new, format!).


##### `config_check`  (lines 1073–1102)

```
fn config_check(config: &Config) -> DoctorCheck
```

**Purpose**: Reports what configuration Codex loaded and whether startup warnings were produced. It helps users see which config files, model settings, feature flags, and MCP servers are active.

**Data flow**: It reads paths and settings from `Config`, gathers feature flag and config-file parse details, adds startup warning counts if present, and returns OK or warning.

**Call relations**: `build_report` runs this after config loads successfully. It relies on helpers to summarize warnings, feature flags, and `config.toml`.

*Call graph*: calls 4 internal fn (new, config_toml_details, feature_flag_details, push_startup_warning_counts); 2 external calls (new, format!).


##### `push_startup_warning_counts`  (lines 1104–1119)

```
fn push_startup_warning_counts(details: &mut Vec<String>, warnings: &[String])
```

**Purpose**: Summarizes startup warnings by broad source, such as skills, hooks, plugins, MCP, or deprecated settings. This gives a quick shape of what went wrong.

**Data flow**: It receives a mutable detail list and warning messages, appends the total count, then counts warnings containing selected keywords and appends those counts.

**Call relations**: `config_check` calls this when loaded config has startup warnings. Tests verify the grouping behavior.

*Call graph*: called by 2 (config_check, startup_warning_counts_group_known_sources); 1 external calls (format!).


##### `feature_flag_details`  (lines 1121–1149)

```
fn feature_flag_details(config: &Config, details: &mut Vec<String>)
```

**Purpose**: Adds feature-flag information to config details. Feature flags are switches that turn optional behavior on or off.

**Data flow**: It reads enabled feature flags and overrides from config, formats counts and lists, includes legacy flag usage, and appends those lines to the detail list.

**Call relations**: `config_check` calls this while building the configuration report.

*Call graph*: called by 1 (config_check); 1 external calls (format!).


##### `config_toml_details`  (lines 1151–1164)

```
fn config_toml_details(config: &Config, details: &mut Vec<String>)
```

**Purpose**: Reports whether the user's `config.toml` file exists and parses as valid TOML. TOML is the text format used for Codex configuration.

**Data flow**: It builds the config file path, tries to read it, tries to parse it if present, and appends either success, missing-file, read-error, or parse-error details.

**Call relations**: `config_check` calls this to include the health of the main config file.

*Call graph*: called by 1 (config_check); 2 external calls (format!, read_to_string).


##### `auth_check`  (lines 1166–1267)

```
fn auth_check(config: &Config) -> DoctorCheck
```

**Purpose**: Checks whether Codex has usable credentials. It considers environment variables, provider-specific auth rules, and stored `auth.json` credentials.

**Data flow**: It reads auth storage settings, auth-related environment variables, provider requirements, and stored credentials. It records credential facts, detects incomplete stored auth, chooses OK, warning, or fail, and may add a login-related remedy.

**Call relations**: `build_report` runs this after config loads. It delegates special provider cases to `provider_specific_auth_check` and stored credential validation to `stored_auth_issues`.

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

**Purpose**: Handles auth rules for model providers that do not use normal OpenAI auth. It can accept a provider-specific environment variable or say no OpenAI auth is needed.

**Data flow**: It receives whether OpenAI auth is required, an optional provider environment variable, optional instructions, existing details, and a way to test environment variables. It returns either a completed auth check or `None` if normal OpenAI auth should continue.

**Call relations**: `auth_check` calls this before reading stored OpenAI credentials. Tests cover non-OpenAI provider behavior and missing provider variables.

*Call graph*: calls 2 internal fn (new, env_var_present); called by 3 (auth_check, provider_specific_auth_allows_non_openai_provider_without_env_key, provider_specific_auth_fails_when_provider_env_key_is_missing); 1 external calls (format!).


##### `stored_auth_mode`  (lines 1324–1333)

```
fn stored_auth_mode(auth: &codex_login::AuthDotJson) -> &'static str
```

**Purpose**: Turns the stored credential mode into a short report string. This makes the auth report easier to read.

**Data flow**: It receives stored auth data, determines the auth mode, and returns a stable text label such as `api_key` or `chatgpt`.

**Call relations**: `auth_check` uses this when reporting what kind of stored auth was found.

*Call graph*: calls 1 internal fn (stored_auth_mode_value).


##### `stored_auth_mode_value`  (lines 1335–1348)

```
fn stored_auth_mode_value(auth: &AuthDotJson) -> codex_app_server_protocol::AuthMode
```

**Purpose**: Determines which auth mode stored credentials represent. It uses an explicit mode if present, otherwise infers one from the available credential fields.

**Data flow**: It reads the stored auth object. It returns the explicit mode when set, or chooses personal access token, Bedrock API key, OpenAI API key, or ChatGPT based on which fields exist.

**Call relations**: `stored_auth_mode` and `stored_auth_issues` both use this so they agree on how credentials should be interpreted.

*Call graph*: called by 2 (stored_auth_issues, stored_auth_mode).


##### `stored_auth_issues`  (lines 1350–1424)

```
fn stored_auth_issues(
    auth: &AuthDotJson,
    env_var_present: impl Fn(&str) -> bool,
) -> Vec<&'static str>
```

**Purpose**: Finds missing pieces inside stored credentials. For example, ChatGPT auth needs tokens and refresh metadata, while API-key auth needs a key.

**Data flow**: It receives stored auth data and a function for checking environment variables. It inspects the fields required by the detected auth mode and returns a list of issue messages.

**Call relations**: `auth_check` uses these messages to decide whether auth is OK, warning, or fail.

*Call graph*: calls 2 internal fn (env_var_present, stored_auth_mode_value); called by 1 (auth_check); 1 external calls (new).


##### `network_check`  (lines 1426–1460)

```
fn network_check() -> DoctorCheck
```

**Purpose**: Checks network-related environment settings that can affect Codex connections. It especially verifies custom certificate file paths.

**Data flow**: It records proxy environment variables, checks `CODEX_CA_CERTIFICATE` and `SSL_CERT_FILE` if set, verifies they point to readable files, and returns OK or warning with details.

**Call relations**: `build_report` runs this as a general environment check. It uses `push_proxy_env_details` and `read_probe_file` for the actual inspections.

*Call graph*: calls 3 internal fn (new, push_proxy_env_details, read_probe_file); 5 external calls (from, new, var_os, format!, metadata).


##### `push_proxy_env_details`  (lines 1462–1476)

```
fn push_proxy_env_details(details: &mut Vec<String>)
```

**Purpose**: Adds a report line showing which proxy environment variables are set. Proxy settings can change how network requests are routed.

**Data flow**: It scans known proxy variable names, checks which are present, and appends either `none` or a comma-separated list to the details.

**Call relations**: `network_check` and websocket reachability checks use this to explain network context.

*Call graph*: called by 2 (network_check, websocket_reachability_check); 1 external calls (format!).


##### `read_probe_file`  (lines 1478–1483)

```
fn read_probe_file(path: &Path) -> std::io::Result<()>
```

**Purpose**: Tests whether a file can actually be opened and read. Reading one byte is enough to catch many permission or path problems.

**Data flow**: It receives a path, opens the file, tries to read one byte, and returns success or an I/O error.

**Call relations**: Network and terminal path checks use this when they need to verify that a configured file is readable.

*Call graph*: called by 3 (network_check, terminal_path_readiness, read_probe_file_rejects_unreadable_file); 1 external calls (open).


##### `mcp_check`  (lines 1485–1487)

```
async fn mcp_check(config: &Config) -> DoctorCheck
```

**Purpose**: Starts the MCP configuration check using the servers from loaded config. MCP means Model Context Protocol, a way for Codex to talk to external tools or services.

**Data flow**: It receives config, extracts the configured MCP servers, awaits the server check, and returns its result.

**Call relations**: `build_report` calls this after config loads. It delegates the real inspection to `mcp_check_from_servers`.

*Call graph*: calls 1 internal fn (mcp_check_from_servers).


##### `mcp_check_from_servers`  (lines 1489–1629)

```
async fn mcp_check_from_servers(servers: &HashMap<String, McpServerConfig>) -> DoctorCheck
```

**Purpose**: Checks whether configured MCP servers have the local inputs they need, such as commands, working directories, environment variables, and reachable HTTP URLs.

**Data flow**: It receives all MCP server configs. It counts transports and disabled servers, checks stdio commands and environment variables, probes HTTP servers, separates required failures from optional warnings, then returns a check with details and possible remediation.

**Call relations**: `mcp_check` calls this in normal doctor runs, and tests call it directly for specific MCP cases.

*Call graph*: calls 4 internal fn (new, env_var_present, mcp_http_probe_url, stdio_command_resolves); called by 5 (mcp_check, mcp_check_fails_required_missing_stdio_command, mcp_check_fails_required_remote_stdio_env_var, mcp_check_ignores_disabled_servers, mcp_check_warns_for_optional_http_reachability); 3 external calls (new, new, format!).


##### `sandbox_check`  (lines 1631–1664)

```
fn sandbox_check(config: &Config, arg0_paths: &Arg0DispatchPaths) -> DoctorCheck
```

**Purpose**: Reports Codex sandbox and approval settings, plus helper executable paths. The sandbox is the safety boundary that limits what Codex can do on the machine.

**Data flow**: It reads permission settings from config and helper paths from startup dispatch data, records them, warns if the Linux sandbox helper path is present but missing, and returns the check.

**Call relations**: `build_report` runs this after config loads because sandbox behavior depends on configuration and helper executable discovery.

*Call graph*: calls 2 internal fn (new, push_path_detail); 2 external calls (new, format!).


##### `TerminalCheckInputs::detect`  (lines 1682–1706)

```
fn detect(no_color_flag: bool) -> Self
```

**Purpose**: Collects a snapshot of the current terminal environment for later checking. It separates data gathering from diagnosis so the logic can also be tested with fake inputs.

**Data flow**: It reads terminal-related environment variables, terminal size, terminal identity, tmux details when relevant, Windows console details, terminal stream status, color support, and the `--no-color` flag, then returns a `TerminalCheckInputs` bundle.

**Call relations**: `terminal_check` calls this before passing the gathered facts to `terminal_check_from_inputs`.

*Call graph*: calls 4 internal fn (collect_env_snapshot, terminal_env_names, tmux_diagnostic_details, windows_console_details); called by 1 (terminal_check); 8 external calls (new, terminal_info, size, matches!, stderr, stdin, stdout, on).


##### `TerminalCheckInputs::env_value`  (lines 1708–1710)

```
fn env_value(&self, name: &str) -> Option<&str>
```

**Purpose**: Looks up the non-empty saved value of a terminal-related environment variable. It gives check code a clean way to read the snapshot.

**Data flow**: It receives a variable name, looks it up in the captured environment map, and returns the value if one was saved.

**Call relations**: Terminal helper functions use this while building details and deciding whether locale, color, terminal size, or terminfo settings are healthy.

*Call graph*: called by 4 (color_output_summary, push_terminal_env_values, push_terminfo_details, terminal_size_issues).


##### `TerminalCheckInputs::env_present`  (lines 1712–1714)

```
fn env_present(&self, name: &str) -> bool
```

**Purpose**: Reports whether an environment variable was present, even if its value was empty. Presence can matter on its own for flags like `NO_COLOR`.

**Data flow**: It receives a variable name, checks the captured presence set, and returns true or false.

**Call relations**: Terminal detail and color helpers use this to distinguish missing variables from empty-but-present ones.

*Call graph*: called by 4 (color_output_summary, push_presence_env_values, push_terminal_env_values, push_terminfo_details); 1 external calls (contains).


##### `terminal_check`  (lines 1717–1719)

```
fn terminal_check(no_color_flag: bool) -> DoctorCheck
```

**Purpose**: Runs the terminal doctor check against the real current terminal. It checks whether Codex can reasonably display colors, Unicode, cursor control, and terminal-size-sensitive output.

**Data flow**: It receives the `--no-color` flag, detects terminal inputs from the current process, passes them to the diagnostic logic, and returns a `DoctorCheck`.

**Call relations**: `build_report` calls this during doctor execution. The actual decision-making lives in `terminal_check_from_inputs`.

*Call graph*: calls 2 internal fn (detect, terminal_check_from_inputs).


##### `windows_console_details`  (lines 1762–1764)

```
fn windows_console_details() -> Vec<String>
```

**Purpose**: Provides Windows-console-specific terminal details. In this chunk it returns no extra details.

**Data flow**: It creates and returns an empty list of strings.

**Call relations**: Terminal detection calls this so platform-specific details can be included in the same input bundle.

*Call graph*: called by 1 (detect); 2 external calls (new, format!).


##### `terminal_check_from_inputs`  (lines 1766–1856)

```
fn terminal_check_from_inputs(inputs: TerminalCheckInputs) -> DoctorCheck
```

**Purpose**: Diagnoses terminal health from a prepared snapshot. It explains terminal identity, size, color behavior, locale, remote indicators, tmux details, and terminfo readability.

**Data flow**: It receives terminal inputs, builds detail lines, creates issues for bad terminal type, non-UTF-8 locale, unreadable terminfo, and size problems, derives the worst status, and returns a terminal check with attached issues.

**Call relations**: `terminal_check` calls this with real inputs, while tests call it with controlled inputs for edge cases.

*Call graph*: calls 7 internal fn (new, new, effective_locale, push_presence_env_values, push_terminal_env_values, push_terminfo_details, terminal_size_issues); called by 9 (terminal_check, terminal_check_includes_windows_console_details, terminal_check_keeps_tmux_probe_failures_non_fatal, terminal_check_reports_remote_indicators_as_present_only, terminal_check_warns_for_declared_narrow_terminal, terminal_check_warns_for_dumb_terminal, terminal_check_warns_for_narrow_terminal, terminal_check_warns_for_non_utf8_locale, terminal_check_warns_for_unreadable_terminfo_path); 4 external calls (new, format!, matches!, vec!).


##### `terminal_name`  (lines 1858–1875)

```
fn terminal_name(info: &TerminalInfo) -> &'static str
```

**Purpose**: Converts an internal terminal name into friendly report text. This avoids exposing enum-style names to users.

**Data flow**: It receives terminal info and returns a human-readable terminal name string.

**Call relations**: `terminal_check_from_inputs` uses this when writing the first terminal detail line.


##### `multiplexer_name`  (lines 1877–1888)

```
fn multiplexer_name(multiplexer: &Multiplexer) -> String
```

**Purpose**: Formats the name of a terminal multiplexer, optionally including its version. A multiplexer is a tool like tmux or zellij that runs terminal sessions inside another terminal.

**Data flow**: It receives a multiplexer value and returns `tmux`, `zellij`, or those names with a version.

**Call relations**: `terminal_check_from_inputs` uses this when the detected terminal is running inside a multiplexer.

*Call graph*: 1 external calls (format!).


##### `terminal_env_names`  (lines 1890–1898)

```
fn terminal_env_names() -> BTreeSet<&'static str>
```

**Purpose**: Builds the set of terminal-related environment variable names to capture. This keeps terminal diagnosis focused on relevant variables.

**Data flow**: It starts with basic terminal names, adds color, dimension, terminfo, locale, and remote-terminal variables, and returns the complete set.

**Call relations**: `TerminalCheckInputs::detect` calls this before taking the environment snapshot.

*Call graph*: called by 1 (detect); 1 external calls (from).


##### `collect_env_snapshot`  (lines 1900–1915)

```
fn collect_env_snapshot(
    names: &BTreeSet<&'static str>,
) -> (BTreeMap<String, String>, BTreeSet<String>)
```

**Purpose**: Captures selected environment variables in a stable snapshot. It records both presence and non-empty values.

**Data flow**: It receives variable names, reads each from the process environment, stores present names, stores trimmed non-empty values, and returns both collections.

**Call relations**: `TerminalCheckInputs::detect` uses this so later terminal logic reads one consistent snapshot instead of repeatedly reading the live environment.

*Call graph*: called by 1 (detect); 3 external calls (new, new, var_os).


##### `push_terminal_env_values`  (lines 1917–1929)

```
fn push_terminal_env_values(
    details: &mut Vec<String>,
    inputs: &TerminalCheckInputs,
    names: &[&str],
)
```

**Purpose**: Adds terminal environment variable values to report details. If a variable is present but empty, it still notes that it was present.

**Data flow**: It receives a detail list, terminal inputs, and variable names. For each name, it appends either `name: value` or `name: present` when applicable.

**Call relations**: `terminal_check_from_inputs` uses this for terminal dimensions and color-related variables.

*Call graph*: calls 2 internal fn (env_present, env_value); called by 1 (terminal_check_from_inputs); 1 external calls (format!).


##### `push_presence_env_values`  (lines 1931–1941)

```
fn push_presence_env_values(
    details: &mut Vec<String>,
    inputs: &TerminalCheckInputs,
    names: &[&str],
)
```

**Purpose**: Adds presence-only environment variable details. This is used when the value itself may be private or unimportant.

**Data flow**: It receives a detail list, terminal inputs, and variable names. For each present variable, it appends a `name: present` line.

**Call relations**: `terminal_check_from_inputs` uses this for remote-terminal indicators.

*Call graph*: calls 1 internal fn (env_present); called by 1 (terminal_check_from_inputs); 1 external calls (format!).


##### `color_output_summary`  (lines 1943–1968)

```
fn color_output_summary(inputs: &TerminalCheckInputs) -> String
```

**Purpose**: Explains whether color output is enabled and, if not, why. Color can be disabled by flags, environment variables, terminal type, or unsupported output streams.

**Data flow**: It reads the no-color flag, `NO_COLOR`, `TERM`, stdout terminal status, and color support from inputs. It returns `enabled` or a disabled reason.

**Call relations**: `terminal_check_from_inputs` adds this summary to terminal details.

*Call graph*: calls 3 internal fn (env_present, env_value, should_enable_color); 1 external calls (format!).


##### `push_terminfo_details`  (lines 1970–1991)

```
fn push_terminfo_details(details: &mut Vec<String>, inputs: &TerminalCheckInputs) -> bool
```

**Purpose**: Reports whether terminfo paths look usable. Terminfo is the database that tells programs what a terminal can do.

**Data flow**: It reads `TERMINFO` and `TERMINFO_DIRS` from inputs, checks each path's readiness, appends detail lines, and returns true if any path has a warning.

**Call relations**: `terminal_check_from_inputs` uses the returned warning flag to decide whether to add a failing terminfo issue.

*Call graph*: calls 3 internal fn (env_present, env_value, terminal_path_readiness); called by 1 (terminal_check_from_inputs); 3 external calls (from, split_paths, format!).


##### `terminal_path_readiness`  (lines 1993–2007)

```
fn terminal_path_readiness(path: &Path) -> (String, bool)
```

**Purpose**: Checks whether a terminfo path exists and is readable. It accepts readable files or directories and flags missing or unreadable paths.

**Data flow**: It receives a path, checks filesystem metadata, tries to read directories or probe files, and returns a status string plus a boolean warning flag.

**Call relations**: `push_terminfo_details` calls this for every configured terminfo path.

*Call graph*: calls 1 internal fn (read_probe_file); called by 1 (push_terminfo_details); 3 external calls (format!, metadata, read_dir).


##### `effective_locale`  (lines 2009–2013)

```
fn effective_locale(inputs: &TerminalCheckInputs) -> Option<String>
```

**Purpose**: Finds the locale setting that should affect terminal text rendering. Locale controls language and character encoding, including whether UTF-8 text is expected.

**Data flow**: It checks known locale environment variables in priority order and returns the first captured value, if any.

**Call relations**: `terminal_check_from_inputs` uses this before checking whether the locale may break Unicode display.

*Call graph*: called by 1 (terminal_check_from_inputs).


##### `is_non_utf8_locale`  (lines 2015–2018)

```
fn is_non_utf8_locale(locale: &str) -> bool
```

**Purpose**: Detects whether a locale string does not mention UTF-8. Non-UTF-8 locales may display Unicode symbols incorrectly.

**Data flow**: It lowercases the locale text and returns true unless it contains `utf-8` or `utf8`.

**Call relations**: `terminal_check_from_inputs` uses this to decide whether to create a locale warning issue.


##### `terminal_size_issues`  (lines 2020–2085)

```
fn terminal_size_issues(inputs: &TerminalCheckInputs) -> Vec<DoctorIssue>
```

**Purpose**: Checks whether the terminal window is too narrow or too short for comfortable CLI output. It creates warnings when the real terminal size or the `COLUMNS` and `LINES` environment variables suggest output may wrap or scroll away.

**Data flow**: It receives collected terminal inputs, reads measured size and optional environment values, compares them with recommended minimums, and returns a list of `DoctorIssue` warnings. It does not change the terminal; it only describes what looks risky and how to fix it.

**Call relations**: This helper is called by `terminal_check_from_inputs` when building the terminal section of the doctor report. It creates `DoctorIssue` records that the caller can attach to the larger terminal check.

*Call graph*: calls 2 internal fn (new, env_value); called by 1 (terminal_check_from_inputs); 2 external calls (new, format!).


##### `tmux_diagnostic_details`  (lines 2087–2096)

```
fn tmux_diagnostic_details() -> Vec<String>
```

**Purpose**: Collects extra terminal information when the user is running inside tmux, a terminal multiplexer. These details help explain display problems caused by tmux settings.

**Data flow**: It starts with an empty list, asks tmux for client display values and selected global options, substitutes `unavailable` when an option cannot be read, and returns strings ready to appear in the report.

**Call relations**: This is called by `detect` as part of terminal detection. It delegates individual tmux display lookups to `push_tmux_display_detail` and option lookups to `tmux_option_value`.

*Call graph*: calls 2 internal fn (push_tmux_display_detail, tmux_option_value); called by 1 (detect); 2 external calls (new, format!).


##### `push_tmux_display_detail`  (lines 2098–2102)

```
fn push_tmux_display_detail(details: &mut Vec<String>, label: &str, format: &str)
```

**Purpose**: Adds one labeled tmux display value to a details list if tmux can provide it. It avoids adding blank or failed readings.

**Data flow**: It receives a mutable details list, a label, and a tmux format expression. It runs the format through `tmux_display_message`; if a value comes back, it appends `label: value` to the list.

**Call relations**: It is used by `tmux_diagnostic_details` to keep repeated tmux display lookups small and consistent.

*Call graph*: calls 1 internal fn (tmux_display_message); called by 1 (tmux_diagnostic_details); 1 external calls (format!).


##### `tmux_option_value`  (lines 2104–2113)

```
fn tmux_option_value(option: &str) -> Option<String>
```

**Purpose**: Reads one global tmux option value. This is useful when diagnosing whether tmux settings may be affecting terminal behavior.

**Data flow**: It runs `tmux show-options -gqv <option>`, checks that the command succeeded, converts standard output from bytes to text, trims whitespace, and returns `None` if anything fails or the value is empty.

**Call relations**: It is called by `tmux_diagnostic_details` for every tmux option the doctor wants to show.

*Call graph*: calls 1 internal fn (non_empty_trimmed); called by 1 (tmux_diagnostic_details); 2 external calls (from_utf8, new).


##### `tmux_display_message`  (lines 2115–2124)

```
fn tmux_display_message(format: &str) -> Option<String>
```

**Purpose**: Asks tmux to expand a display format, such as the current client terminal type. It is a small wrapper around `tmux display-message -p`.

**Data flow**: It receives a tmux format string, runs the tmux command, checks for success, decodes the output, trims it, and returns either a useful string or `None`.

**Call relations**: It is called by `push_tmux_display_detail`, which adds successful values to the doctor output.

*Call graph*: calls 1 internal fn (non_empty_trimmed); called by 1 (push_tmux_display_detail); 2 external calls (from_utf8, new).


##### `non_empty_trimmed`  (lines 2126–2129)

```
fn non_empty_trimmed(value: String) -> Option<String>
```

**Purpose**: Turns command output into a clean optional string. Empty output becomes no value.

**Data flow**: It receives a string, trims surrounding whitespace, and returns the trimmed text only if something remains.

**Call relations**: Both `tmux_option_value` and `tmux_display_message` use this so tmux output is cleaned in the same way.

*Call graph*: called by 2 (tmux_display_message, tmux_option_value).


##### `state_check`  (lines 2131–2161)

```
async fn state_check(config: &Config) -> DoctorCheck
```

**Purpose**: Checks whether Codex’s local state directories and runtime databases are present, readable, and healthy. Without this, the doctor could miss damaged SQLite databases or missing state paths that cause later CLI failures.

**Data flow**: It receives the loaded configuration, records readiness for key folders, checks each runtime SQLite database for integrity, counts rollout files, adds standalone install cache details, and returns a `DoctorCheck`. If any database integrity check fails, the final status is Fail and includes recovery advice.

**Call relations**: This is a main state diagnostic. It calls `path_readiness`, `sqlite_integrity_detail`, `rollout_stats_details`, and `standalone_release_cache_details` to gather the pieces before producing one state check.

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

**Purpose**: Runs an integrity check on one SQLite database, if the database file exists. SQLite is the small embedded database Codex uses for runtime state.

**Data flow**: It receives report details, a shared list of integrity failures, a label, and a path. Missing files are marked as skipped; healthy checks add `ok`; bad rows or errors are added both to details and to the failure list.

**Call relations**: It is called by `state_check` for each runtime database path. Its failure list directly decides whether the overall state check passes or fails.

*Call graph*: called by 1 (state_check); 3 external calls (is_file, sqlite_integrity_check, format!).


##### `rollout_stats_details`  (lines 2191–2196)

```
fn rollout_stats_details(details: &mut Vec<String>, codex_home: &Path)
```

**Purpose**: Adds size and count information for saved rollout files, both active and archived. This helps diagnose unexpectedly large or missing session history.

**Data flow**: It receives the details list and Codex home path, scans the `sessions` and `archived_sessions` folders, and appends one summary line for each.

**Call relations**: It is called by `state_check`. It uses `collect_rollout_stats` to scan folders and `push_rollout_stats_detail` to phrase the result.

*Call graph*: calls 2 internal fn (collect_rollout_stats, push_rollout_stats_detail); called by 1 (state_check); 1 external calls (join).


##### `push_rollout_stats_detail`  (lines 2198–2208)

```
fn push_rollout_stats_detail(details: &mut Vec<String>, label: &str, stats: RolloutStats)
```

**Purpose**: Formats rollout file statistics for the report. It also reports scan errors clearly instead of hiding them.

**Data flow**: It receives a label and collected stats. If scanning failed, it appends an error line; otherwise it appends file count, total bytes, and average bytes.

**Call relations**: It is called by `rollout_stats_details` after each rollout directory has been scanned.

*Call graph*: called by 1 (rollout_stats_details); 1 external calls (format!).


##### `RolloutStats::average_bytes`  (lines 2218–2220)

```
fn average_bytes(&self) -> u64
```

**Purpose**: Computes the average size of rollout files without crashing when there are zero files.

**Data flow**: It reads `total_bytes` and `files` from the stats object, divides safely, and returns zero if there is no valid divisor.

**Call relations**: It is used when rollout statistics are displayed, especially by `push_rollout_stats_detail` and related tests.


##### `collect_rollout_stats`  (lines 2223–2227)

```
fn collect_rollout_stats(root: &Path) -> RolloutStats
```

**Purpose**: Starts a recursive scan for rollout files under one root directory. It produces the totals used in the state report.

**Data flow**: It receives a root path, creates empty stats, asks `collect_rollout_stats_inner` to fill them, and returns the completed stats object.

**Call relations**: It is called by `rollout_stats_details` and by a test that checks nested rollout files are counted correctly.

*Call graph*: calls 1 internal fn (collect_rollout_stats_inner); called by 2 (rollout_stats_details, collect_rollout_stats_counts_nested_rollout_files); 1 external calls (default).


##### `collect_rollout_stats_inner`  (lines 2229–2265)

```
fn collect_rollout_stats_inner(path: &Path, stats: &mut RolloutStats)
```

**Purpose**: Walks through a directory tree and counts rollout files. A rollout file is a `rollout-...jsonl` file containing saved session events.

**Data flow**: It receives a path and mutable stats. It reads directory entries, recurses into subdirectories, adds matching file sizes, and stops early if any unexpected filesystem error happens.

**Call relations**: It is the worker behind `collect_rollout_stats`. It relies on `is_rollout_file` to decide which files count.

*Call graph*: calls 1 internal fn (is_rollout_file); called by 1 (collect_rollout_stats); 1 external calls (read_dir).


##### `is_rollout_file`  (lines 2267–2273)

```
fn is_rollout_file(path: &Path) -> bool
```

**Purpose**: Recognizes Codex rollout files by name. This prevents unrelated JSONL files from being included in session statistics.

**Data flow**: It receives a path and returns true only when the extension is `jsonl` and the file name starts with `rollout-`.

**Call relations**: It is called by `collect_rollout_stats_inner` while scanning state directories.

*Call graph*: called by 1 (collect_rollout_stats_inner); 3 external calls (new, extension, file_name).


##### `websocket_reachability_check`  (lines 2275–2409)

```
async fn websocket_reachability_check(
    config: &Config,
    auth_manager: Option<Arc<AuthManager>>,
) -> DoctorCheck
```

**Purpose**: Tests whether the active model provider’s Responses WebSocket endpoint can be reached and opened. This catches proxy, firewall, DNS, authentication, or endpoint problems before the user relies on WebSocket features.

**Data flow**: It receives configuration and optional authentication support, records provider facts, skips the probe if WebSockets are unsupported, builds the runtime provider and endpoint, resolves authentication, checks DNS, then attempts a timed WebSocket handshake. It returns an OK check, a warning, or a warning with immediate-close details.

**Call relations**: This is the main WebSocket diagnostic. It calls helpers such as `push_proxy_env_details`, `dns_address_family_details`, `auth_mode_name`, `websocket_error_detail`, and `websocket_probe_warning` to build an understandable result.

*Call graph*: calls 7 internal fn (new, dns_address_family_details, push_proxy_env_details, websocket_error_detail, websocket_probe_warning, new, default_headers); 6 external calls (new, from_static, create_model_provider, format!, timeout, vec!).


##### `websocket_probe_warning`  (lines 2411–2425)

```
fn websocket_probe_warning(
    summary: &'static str,
    mut details: Vec<String>,
    error_detail: String,
) -> DoctorCheck
```

**Purpose**: Builds a standard warning result for WebSocket probe problems. It keeps similar failures worded consistently.

**Data flow**: It receives a summary, existing detail lines, and one error detail. It appends the error, creates a warning `DoctorCheck`, and adds common network troubleshooting advice.

**Call relations**: It is called by `websocket_reachability_check` whenever setup, endpoint creation, authentication, timeout, or handshake fails in a non-fatal way.

*Call graph*: calls 1 internal fn (new); called by 1 (websocket_reachability_check).


##### `websocket_error_detail`  (lines 2427–2443)

```
fn websocket_error_detail(err: &ApiError) -> String
```

**Purpose**: Turns a structured API error into a short sentence suitable for the doctor report. This helps users see whether the failure was transport, API status, stream, or another API-level problem.

**Data flow**: It receives an `ApiError`, matches its kind, and returns one formatted string explaining the handshake failure.

**Call relations**: It is called by `websocket_reachability_check` when the WebSocket client returns an error.

*Call graph*: called by 1 (websocket_reachability_check); 1 external calls (format!).


##### `auth_mode_name`  (lines 2445–2454)

```
fn auth_mode_name(auth: &CodexAuth) -> &'static str
```

**Purpose**: Converts an internal authentication mode into a stable readable name. This lets diagnostic output say which kind of credentials were used without exposing the credentials themselves.

**Data flow**: It receives a `CodexAuth`, asks it for its auth mode, and returns a fixed text label such as `api_key` or `chatgpt`.

**Call relations**: It is used by `websocket_reachability_check` when adding authentication details to the WebSocket report.

*Call graph*: calls 1 internal fn (auth_mode).


##### `dns_address_family_details`  (lines 2456–2481)

```
async fn dns_address_family_details(host: &str, port: u16) -> Vec<String>
```

**Purpose**: Reports whether a hostname resolves to IPv4 addresses, IPv6 addresses, or both. This helps spot network setups where the first DNS result may be unusable.

**Data flow**: It receives a host and port, performs an asynchronous DNS lookup, counts IPv4 and IPv6 results, notes the first address family, and returns one detail string. If lookup fails, it returns a failure detail instead.

**Call relations**: It is called by `websocket_reachability_check` after the WebSocket endpoint URL has been built.

*Call graph*: called by 1 (websocket_reachability_check); 2 external calls (lookup_host, vec!).


##### `fallback_state_check`  (lines 2483–2501)

```
fn fallback_state_check() -> DoctorCheck
```

**Purpose**: Provides a minimal state check when full configuration is not available. It still tries to locate `CODEX_HOME`, the directory where Codex stores local data.

**Data flow**: It calls `find_codex_home`. If a path is found, it returns an OK check with that path; otherwise it returns a warning with the error text.

**Call relations**: This is a fallback path for state diagnostics when the normal `state_check` cannot use a loaded `Config`.

*Call graph*: calls 2 internal fn (new, find_codex_home); 1 external calls (format!).


##### `ProviderAuthReachabilityMode::description`  (lines 2525–2531)

```
fn description(self) -> &'static str
```

**Purpose**: Gives a human-readable description of which authentication route the provider reachability check will use.

**Data flow**: It receives the enum value and returns text such as `API key auth`, `ChatGPT auth`, or `provider auth`.

**Call relations**: It is called by `provider_reachability_plan_from_parts` when building the reachability plan description.

*Call graph*: called by 1 (provider_reachability_plan_from_parts).


##### `provider_reachability_plan`  (lines 2534–2556)

```
fn provider_reachability_plan(config: &Config) -> ReachabilityPlan
```

**Purpose**: Builds the network endpoints that should be probed for the currently configured model provider. It chooses between API-key reachability, ChatGPT reachability, or provider-specific reachability.

**Data flow**: It receives configuration, loads stored auth if available, inspects environment variables and stored credentials, decides the auth mode, and returns a `ReachabilityPlan` with endpoints and optional route probes.

**Call relations**: It is called by `build_report`. It delegates auth-mode selection to `provider_auth_reachability_mode_from_auth` and endpoint construction to `provider_reachability_plan_from_parts`.

*Call graph*: calls 2 internal fn (provider_auth_reachability_mode_from_auth, provider_reachability_plan_from_parts); called by 1 (build_report); 2 external calls (auth_keyring_backend_kind, load_auth_dot_json).


##### `default_reachability_plan`  (lines 2558–2568)

```
fn default_reachability_plan() -> ReachabilityPlan
```

**Purpose**: Creates a safe default reachability plan for ChatGPT when full provider configuration is not available.

**Data flow**: It supplies fixed OpenAI/ChatGPT defaults to `provider_reachability_plan_from_parts` and returns the resulting plan.

**Call relations**: It is called by `build_report` as a fallback reachability plan.

*Call graph*: calls 1 internal fn (provider_reachability_plan_from_parts); called by 1 (build_report).


##### `provider_auth_reachability_mode_from_auth`  (lines 2570–2597)

```
fn provider_auth_reachability_mode_from_auth(
    requires_openai_auth: bool,
    env_var_present: impl Fn(&str) -> bool,
    stored_auth: Option<&AuthDotJson>,
) -> ProviderAuthReachabilityMode
```

**Purpose**: Decides what kind of authentication should shape the provider network probe. It avoids checking ChatGPT when the active setup clearly uses an API key, and avoids auth probing when auth is not required.

**Data flow**: It receives whether OpenAI auth is required, a function for checking environment variables, and optional stored auth. It looks first at auth requirements, then environment variables, then stored auth mode, and returns the selected reachability mode.

**Call relations**: It is called by `provider_reachability_plan` and directly by tests that lock down API-key and ChatGPT behavior.

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

**Purpose**: Assembles the exact endpoint list for provider reachability checks. It also decides whether to probe a `/models` route to catch a wrong API base path.

**Data flow**: It receives the auth mode, provider identity, base URL, query parameters, Bedrock flag, and ChatGPT base URL. It returns a plan containing a description and zero or more required endpoints, each with an optional route probe URL.

**Call relations**: It is used by `provider_reachability_plan`, `default_reachability_plan`, and several tests. It calls `ProviderAuthReachabilityMode::description`, `should_probe_models_route`, and `provider_url_for_path`.

*Call graph*: calls 1 internal fn (description); called by 6 (default_reachability_plan, provider_reachability_plan, provider_reachability_api_key_does_not_require_chatgpt, provider_reachability_route_401_keeps_reachability_ok, provider_reachability_route_404_fails_bad_base_url_path, provider_reachability_skips_route_probe_for_bedrock); 1 external calls (vec!).


##### `should_probe_models_route`  (lines 2648–2650)

```
fn should_probe_models_route(provider_name: &str, base_url: &str, is_amazon_bedrock: bool) -> bool
```

**Purpose**: Decides whether the doctor should test the provider’s `/models` route. Some providers, such as Amazon Bedrock or Azure-style responses providers, should not be checked this way.

**Data flow**: It receives provider name, base URL, and a Bedrock flag, then returns true only when a `/models` route probe is appropriate.

**Call relations**: It is called by `provider_reachability_plan_from_parts` while building endpoint probes.

*Call graph*: 1 external calls (is_azure_responses_provider).


##### `provider_url_for_path`  (lines 2652–2680)

```
fn provider_url_for_path(
    base_url: &str,
    path: &str,
    query_params: Option<&HashMap<String, String>>,
) -> String
```

**Purpose**: Builds a provider URL by combining a base URL, a path, and optional query parameters. It is used to form route probe URLs consistently.

**Data flow**: It trims extra slashes, joins the base and path, appends query parameters with `?` or `&` as needed, and returns the final string.

**Call relations**: It is called from `provider_reachability_plan_from_parts` when creating a `/models` probe URL.

*Call graph*: 1 external calls (format!).


##### `provider_reachability_check`  (lines 2682–2797)

```
async fn provider_reachability_check(plan: ReachabilityPlan) -> DoctorCheck
```

**Purpose**: Runs the actual HTTP checks for a provider reachability plan. It verifies that required model-provider endpoints answer over HTTP and that optional route probes behave as expected.

**Data flow**: It receives a `ReachabilityPlan`, records the mode, probes each base URL, optionally probes a provider route, collects failures and warnings, attaches specific issues for bad route probes, and returns a final `DoctorCheck`.

**Call relations**: This is the executor for plans built elsewhere. It calls `http_probe_url`, `provider_route_probe_url`, and `provider_reachability_outcome`; tests call it with tiny local servers to verify 401, 404, and failure behavior.

*Call graph*: calls 5 internal fn (new, new, http_probe_url, provider_reachability_outcome, provider_route_probe_url); called by 2 (provider_reachability_route_401_keeps_reachability_ok, provider_reachability_route_404_fails_bad_base_url_path); 3 external calls (new, format!, vec!).


##### `provider_route_probe_url`  (lines 2806–2815)

```
async fn provider_route_probe_url(url: &str) -> RouteProbeOutcome
```

**Purpose**: Checks a provider route with an HTTP GET and classifies the status. A 401 or 403 still means the route exists, while 404 likely means the configured base path is wrong.

**Data flow**: It receives a URL, sends a GET with a short timeout, and returns `Ok`, `Warning`, `Fail`, or `TransportError` with a readable message.

**Call relations**: It is called by `provider_reachability_check` after a base endpoint has already answered.

*Call graph*: calls 1 internal fn (http_get_probe_status_with_timeout); called by 1 (provider_reachability_check); 7 external calls (from_secs, Fail, Ok, TransportError, Warning, format!, matches!).


##### `provider_reachability_outcome`  (lines 2817–2835)

```
fn provider_reachability_outcome(
    required_failures: usize,
    warnings: usize,
) -> (CheckStatus, &'static str)
```

**Purpose**: Turns counted reachability failures and warnings into one final status and summary. It captures the doctor’s policy for what is OK, warning, or failure.

**Data flow**: It receives counts of required failures and warnings. No problems returns OK, warnings only returns Warning, and any required failure returns Fail.

**Call relations**: It is called by `provider_reachability_check` and tested directly to keep the classification stable.

*Call graph*: called by 1 (provider_reachability_check).


##### `http_probe_url`  (lines 2837–2839)

```
async fn http_probe_url(url: &str) -> Result<String, String>
```

**Purpose**: Performs a quick HTTP HEAD probe with the default timeout. HEAD asks for headers only, which is a lightweight way to see whether a server responds.

**Data flow**: It receives a URL, calls the timeout-aware probe with a three-second limit, and returns either an HTTP status string or an error string.

**Call relations**: It is called by `provider_reachability_check` and by a test that confirms any HTTP status still counts as a reachable server.

*Call graph*: calls 1 internal fn (http_probe_url_with_timeout); called by 2 (provider_reachability_check, http_probe_treats_http_status_as_reachable); 1 external calls (from_secs).


##### `mcp_http_probe_url`  (lines 2841–2843)

```
async fn mcp_http_probe_url(url: &str) -> Result<String, String>
```

**Purpose**: Performs a quick reachability probe for an MCP HTTP server. MCP here means Model Context Protocol, an integration mechanism for external tools and services.

**Data flow**: It receives a URL, calls the MCP-specific timeout probe with a three-second limit, and returns either an HTTP status string or a combined error.

**Call relations**: It is called by `mcp_check_from_servers` when checking configured MCP HTTP servers.

*Call graph*: calls 1 internal fn (mcp_http_probe_url_with_timeout); called by 1 (mcp_check_from_servers); 1 external calls (from_secs).


##### `mcp_http_probe_url_with_timeout`  (lines 2845–2853)

```
async fn mcp_http_probe_url_with_timeout(url: &str, timeout: Duration) -> Result<String, String>
```

**Purpose**: Checks an MCP HTTP URL, first with HEAD and then with GET if HEAD fails. This matters because some servers do not support HEAD even though GET works.

**Data flow**: It receives a URL and timeout. If the HEAD probe succeeds, it returns that status; if HEAD fails, it tries GET; if both fail, it returns an error mentioning both attempts.

**Call relations**: It is called by `mcp_http_probe_url` and by a test that verifies GET fallback after HEAD timeout.

*Call graph*: calls 2 internal fn (http_get_probe_url_with_timeout, http_probe_url_with_timeout); called by 2 (mcp_http_probe_url, mcp_http_probe_falls_back_to_get_when_head_times_out); 1 external calls (format!).


##### `http_probe_url_with_timeout`  (lines 2855–2873)

```
async fn http_probe_url_with_timeout(url: &str, timeout: Duration) -> Result<String, String>
```

**Purpose**: Sends a timed HTTP HEAD request and turns the outcome into a simple status or error message.

**Data flow**: It receives a URL and timeout, builds an HTTP client, sends HEAD, maps timeout/connect/build errors to friendly text, and returns `HTTP <status>` on any server response.

**Call relations**: It is the core HEAD probe used by `http_probe_url` and `mcp_http_probe_url_with_timeout`.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 2 (http_probe_url, mcp_http_probe_url_with_timeout); 1 external calls (format!).


##### `http_get_probe_url_with_timeout`  (lines 2875–2879)

```
async fn http_get_probe_url_with_timeout(url: &str, timeout: Duration) -> Result<String, String>
```

**Purpose**: Sends a timed HTTP GET probe and formats the numeric status for display.

**Data flow**: It receives a URL and timeout, calls `http_get_probe_status_with_timeout`, and converts a successful numeric status into `HTTP <status>`.

**Call relations**: It is called by `mcp_http_probe_url_with_timeout` as the fallback after a failed HEAD probe.

*Call graph*: calls 1 internal fn (http_get_probe_status_with_timeout); called by 1 (mcp_http_probe_url_with_timeout).


##### `http_get_probe_status_with_timeout`  (lines 2881–2899)

```
async fn http_get_probe_status_with_timeout(url: &str, timeout: Duration) -> Result<u16, String>
```

**Purpose**: Sends a timed HTTP GET request and returns the raw status code. It is used when the caller needs to classify specific statuses like 404 or 401.

**Data flow**: It receives a URL and timeout, builds an HTTP client, sends GET, maps common request errors to friendly strings, and returns the response status number.

**Call relations**: It is called by `http_get_probe_url_with_timeout` and by `provider_route_probe_url`.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 2 (http_get_probe_url_with_timeout, provider_route_probe_url).


##### `stdio_command_resolves`  (lines 2901–2944)

```
fn stdio_command_resolves(
    command: &str,
    cwd: Option<&Path>,
    server_env: Option<&HashMap<String, String>>,
) -> Result<(), String>
```

**Purpose**: Checks whether a command configured for a stdio-based MCP server can actually be found. Stdio here means the server is started as a local process and communicates through standard input and output.

**Data flow**: It receives a command name or path, an optional working directory, and optional server environment. Absolute paths are checked directly, relative paths with slashes are resolved against the working directory, and simple command names are searched on `PATH`.

**Call relations**: It is called by `mcp_check_from_servers` when validating local MCP server commands. It relies on `executable_path_exists` for each candidate path.

*Call graph*: calls 1 internal fn (executable_path_exists); called by 1 (mcp_check_from_servers); 4 external calls (new, split_paths, var, format!).


##### `executable_path_exists`  (lines 2946–2952)

```
fn executable_path_exists(path: &Path) -> Result<(), String>
```

**Purpose**: Checks whether a path points to a file that can be treated as executable. This prevents the doctor from accepting directories or missing files as commands.

**Data flow**: It receives a path, reads filesystem metadata, rejects non-files and missing paths, and then asks `executable_file_permission` to validate permissions.

**Call relations**: It is called by `stdio_command_resolves` and by a test that verifies non-executable files are rejected where permission checks apply.

*Call graph*: calls 1 internal fn (executable_file_permission); called by 2 (stdio_command_resolves, executable_path_exists_rejects_non_executable_file); 1 external calls (metadata).


##### `executable_file_permission`  (lines 2966–2968)

```
fn executable_file_permission(_path: &Path, _metadata: &std::fs::Metadata) -> Result<(), String>
```

**Purpose**: Represents the platform-specific executable permission check. In this compiled version, it accepts any file as executable.

**Data flow**: It receives a path and file metadata and returns success without changing anything.

**Call relations**: It is called only by `executable_path_exists` after metadata confirms the path is a file.

*Call graph*: called by 1 (executable_path_exists); 2 external calls (permissions, format!).


##### `path_readiness`  (lines 2970–2987)

```
fn path_readiness(details: &mut Vec<String>, label: &str, path: &Path)
```

**Purpose**: Adds a clear line saying whether a path exists and what kind of filesystem item it is. This helps users see missing or unexpected state locations.

**Data flow**: It receives a details list, label, and path. It reads metadata and appends whether the path is a directory, file, other item, missing, or failed with an error.

**Call relations**: It is called by `state_check` for Codex home, log, SQLite home, and each runtime database path.

*Call graph*: called by 1 (state_check); 2 external calls (format!, metadata).


##### `standalone_release_cache_details`  (lines 2989–3005)

```
fn standalone_release_cache_details(details: &mut Vec<String>)
```

**Purpose**: Reports how many cached standalone releases are present, but only for standalone installations. This can help diagnose install or update clutter.

**Data flow**: It detects the current install context, exits quietly unless it is a standalone install with a readable releases directory, counts entries, and appends one detail line.

**Call relations**: It is called by `state_check` as one optional detail in the state report.

*Call graph*: calls 1 internal fn (current); called by 1 (state_check); 2 external calls (format!, read_dir).


##### `push_path_detail`  (lines 3007–3012)

```
fn push_path_detail(details: &mut Vec<String>, label: &str, path: Option<&Path>)
```

**Purpose**: Adds either a displayed filesystem path or `none` to a details list. It keeps path detail formatting consistent.

**Data flow**: It receives a details list, label, and optional path. It appends `label: path` when present or `label: none` when absent.

**Call relations**: It is called by `installation_check` and `sandbox_check` when those checks explain which executables or paths were found.

*Call graph*: called by 2 (installation_check, sandbox_check); 1 external calls (format!).


##### `push_env_path_detail`  (lines 3014–3019)

```
fn push_env_path_detail(details: &mut Vec<String>, label: &str, name: &str)
```

**Purpose**: Adds the value of a path-like environment variable to diagnostic details. If the variable is missing, it says so plainly.

**Data flow**: It receives a details list, label, and environment variable name. It reads the variable and appends either the displayed path or `not set`.

**Call relations**: It is called by `installation_check` when reporting path-related environment settings.

*Call graph*: called by 1 (installation_check); 2 external calls (var_os, format!).


##### `env_var_present`  (lines 3021–3023)

```
fn env_var_present(name: &str) -> bool
```

**Purpose**: Checks whether an environment variable exists and is not empty. This avoids treating empty credentials as real credentials.

**Data flow**: It receives a variable name, reads the process environment, and returns true only when the value exists and has content.

**Call relations**: It is used by MCP checks, provider-specific auth checks, stored-auth validation, and `provider_auth_reachability_mode_from_auth`.

*Call graph*: called by 4 (mcp_check_from_servers, provider_auth_reachability_mode_from_auth, provider_specific_auth_check, stored_auth_issues); 1 external calls (var_os).


##### `human_output_options`  (lines 3025–3040)

```
fn human_output_options(command: &DoctorCommand) -> HumanOutputOptions
```

**Purpose**: Decides how the doctor report should look in the terminal. It considers summary mode, whether to show all checks, ASCII-only output, and whether color is safe to use.

**Data flow**: It receives the parsed doctor command, reads terminal-related environment and stdout capabilities, calls `should_enable_color`, and returns `HumanOutputOptions`.

**Call relations**: This prepares display settings for human-readable doctor output. It delegates the color decision to `should_enable_color`.

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

**Purpose**: Applies the rules for when colored output should be enabled. It respects user opt-outs and avoids color on terminals that likely cannot show it.

**Data flow**: It receives command flags, environment signals, terminal name, whether stdout is a real terminal, and color support. It returns true only if all conditions allow color.

**Call relations**: It is called by `human_output_options` and by `color_output_summary`.

*Call graph*: called by 2 (color_output_summary, human_output_options).


##### `tests::RecordingProgress::events`  (lines 3075–3077)

```
fn events(&self) -> Vec<String>
```

**Purpose**: Returns a snapshot of recorded progress events for tests. It lets tests compare what happened without exposing the internal lock.

**Data flow**: It locks the stored event list, clones it, and returns the clone.

**Call relations**: It is used by progress-notification tests after running sync or async checks.


##### `tests::RecordingProgress::begin`  (lines 3081–3086)

```
fn begin(&self, label: &'static str)
```

**Purpose**: Records that a doctor check began during a test.

**Data flow**: It receives a label, locks the event list, and appends `begin <label>`.

**Call relations**: It is called through the test progress interface by `run_sync_check` and `run_async_check`.

*Call graph*: 1 external calls (format!).


##### `tests::RecordingProgress::heartbeat`  (lines 3088–3093)

```
fn heartbeat(&self, label: &'static str, elapsed: Duration)
```

**Purpose**: Records a progress heartbeat during a test. A heartbeat is a periodic “still working” signal.

**Data flow**: It receives a label and elapsed time, locks the event list, and appends a string containing the label and elapsed seconds.

**Call relations**: It implements the test progress interface, although the shown tests mainly assert begin and finish events.

*Call graph*: 1 external calls (format!).


##### `tests::RecordingProgress::finish`  (lines 3095–3100)

```
fn finish(&self, label: &'static str, status: CheckStatus)
```

**Purpose**: Records that a doctor check finished and what status it produced.

**Data flow**: It receives a label and status, locks the event list, and appends `finish <label> <status>`.

**Call relations**: It is called through the test progress interface by `run_sync_check` and `run_async_check`.

*Call graph*: 1 external calls (format!).


##### `tests::RecordingProgress::settle`  (lines 3102–3107)

```
fn settle(&self)
```

**Purpose**: Records that progress output settled at the end of an operation.

**Data flow**: It locks the event list and appends the fixed string `settle`.

**Call relations**: It is part of the test progress implementation used when progress behavior needs to be observed.


##### `tests::respond_once`  (lines 3110–3115)

```
fn respond_once(listener: &TcpListener, response: &[u8])
```

**Purpose**: Provides a tiny one-request HTTP responder for network tests. It lets tests simulate provider endpoints without using the real internet.

**Data flow**: It accepts one TCP connection, reads the request bytes, writes the provided raw HTTP response, and returns.

**Call relations**: Provider reachability tests call it from a background thread to feed controlled 401 or 404 responses to the probe code.

*Call graph*: 1 external calls (accept).


##### `tests::overall_status_prefers_fail`  (lines 3118–3124)

```
fn overall_status_prefers_fail()
```

**Purpose**: Checks that the combined doctor status becomes Fail when any individual check fails, even if another only warns.

**Data flow**: It builds two sample checks, calls `overall_status`, and asserts that the result is Fail.

**Call relations**: This protects the summary-status rule used by the broader doctor report.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::run_sync_check_notifies_progress`  (lines 3127–3140)

```
fn run_sync_check_notifies_progress()
```

**Purpose**: Verifies that synchronous doctor checks announce when they begin and finish.

**Data flow**: It creates a recording progress object, runs a simple OK check through `run_sync_check`, then asserts both the check status and recorded event order.

**Call relations**: It tests the interaction between `run_sync_check` and the `DoctorProgress` interface implemented by `RecordingProgress`.

*Call graph*: calls 1 internal fn (run_sync_check); 3 external calls (new, assert_eq!, default).


##### `tests::run_async_check_notifies_progress`  (lines 3143–3157)

```
async fn run_async_check_notifies_progress()
```

**Purpose**: Verifies that asynchronous doctor checks announce when they begin and finish.

**Data flow**: It creates a recording progress object, awaits `run_async_check` around a sample warning check, and compares the recorded events.

**Call relations**: It tests the async progress path and the same `RecordingProgress` helper.

*Call graph*: calls 2 internal fn (new, run_async_check); 3 external calls (new, assert_eq!, default).


##### `tests::compare_npm_package_roots_detects_match`  (lines 3160–3169)

```
fn compare_npm_package_roots_detects_match()
```

**Purpose**: Confirms that the npm package-root comparison recognizes a correctly installed package path.

**Data flow**: It supplies a running package path and npm root, calls `compare_npm_package_roots`, and expects a Match result.

**Call relations**: It protects installation diagnostics that compare the running CLI location with npm’s package root.

*Call graph*: 2 external calls (from, assert_eq!).


##### `tests::compare_npm_package_roots_detects_mismatch`  (lines 3172–3182)

```
fn compare_npm_package_roots_detects_mismatch()
```

**Purpose**: Confirms that the npm package-root comparison catches when Codex is running from a different npm root than expected.

**Data flow**: It supplies old and new package roots, calls `compare_npm_package_roots`, and expects a Mismatch result containing both paths.

**Call relations**: It protects installation diagnostics from silently accepting stale npm installs.

*Call graph*: 2 external calls (from, assert_eq!).


##### `tests::startup_warning_counts_group_known_sources`  (lines 3185–3207)

```
fn startup_warning_counts_group_known_sources()
```

**Purpose**: Checks that startup warnings are counted and grouped by source, such as skills, hooks, plugins, MCP, and deprecated settings.

**Data flow**: It builds sample warning strings, passes them to `push_startup_warning_counts`, and asserts the exact grouped detail lines.

**Call relations**: It verifies the warning-summary helper used in the doctor report.

*Call graph*: calls 1 internal fn (push_startup_warning_counts); 3 external calls (new, assert_eq!, vec!).


##### `tests::config_overrides_from_interactive_preserves_global_options`  (lines 3210–3254)

```
fn config_overrides_from_interactive_preserves_global_options()
```

**Purpose**: Ensures that doctor configuration built from interactive CLI arguments keeps important global options. This prevents diagnostics from running under different settings than the user requested.

**Data flow**: It parses sample CLI arguments, supplies known executable paths, calls `config_overrides_from_interactive`, and asserts model, provider, working directory, sandbox, approval, writable roots, and executable overrides.

**Call relations**: It tests the bridge between interactive CLI argument parsing and doctor configuration setup.

*Call graph*: calls 1 internal fn (config_overrides_from_interactive); 3 external calls (from, parse_from, assert_eq!).


##### `tests::redacted_json_report_structures_and_sanitizes_details`  (lines 3257–3360)

```
fn redacted_json_report_structures_and_sanitizes_details()
```

**Purpose**: Verifies that JSON doctor reports are structured and do not leak secrets. This is important because users may share doctor reports for support.

**Data flow**: It builds a report containing URLs with credentials, API keys, editor commands, duplicate details, issues, and remedies. It redacts the report, serializes it, and asserts secrets are gone while safe structure remains.

**Call relations**: It tests `redacted_json_report` and the sanitization rules used when exporting doctor output.

*Call graph*: calls 1 internal fn (redacted_json_report); 5 external calls (assert!, assert_eq!, to_string, to_value, vec!).


##### `tests::mcp_check_ignores_disabled_servers`  (lines 3363–3392)

```
async fn mcp_check_ignores_disabled_servers()
```

**Purpose**: Confirms disabled MCP servers are counted but not actively checked. Disabled entries should not trigger missing token or reachability warnings.

**Data flow**: It parses a disabled MCP server from TOML, runs `mcp_check_from_servers`, and asserts an OK status plus absence of token and reachability details.

**Call relations**: It protects MCP diagnostics from bothering users about servers they intentionally turned off.

*Call graph*: calls 1 internal fn (mcp_check_from_servers); 4 external calls (from, assert!, assert_eq!, from_str).


##### `tests::mcp_check_warns_for_optional_http_reachability`  (lines 3395–3414)

```
async fn mcp_check_warns_for_optional_http_reachability()
```

**Purpose**: Checks that an optional unreachable MCP HTTP server produces a warning rather than a failure.

**Data flow**: It creates an optional server pointing to an unreachable local port, runs `mcp_check_from_servers`, and asserts Warning with an optional reachability detail.

**Call relations**: It tests the optional-server path in MCP diagnostics.

*Call graph*: calls 1 internal fn (mcp_check_from_servers); 4 external calls (from, assert!, assert_eq!, from_str).


##### `tests::mcp_check_fails_required_remote_stdio_env_var`  (lines 3417–3442)

```
async fn mcp_check_fails_required_remote_stdio_env_var()
```

**Purpose**: Checks that a required stdio MCP server fails when it declares a remote-only environment variable that cannot work for local stdio startup.

**Data flow**: It builds a required server using the current executable as the command and a remote-source env var, runs `mcp_check_from_servers`, and asserts Fail with the expected explanation.

**Call relations**: It protects MCP validation for required local-process servers.

*Call graph*: calls 1 internal fn (mcp_check_from_servers); 7 external calls (from, assert!, assert_eq!, format!, current_exe, String, from_str).


##### `tests::provider_specific_auth_allows_non_openai_provider_without_env_key`  (lines 3445–3460)

```
fn provider_specific_auth_allows_non_openai_provider_without_env_key()
```

**Purpose**: Verifies that a non-OpenAI provider can pass auth diagnostics without an OpenAI environment key when no provider-specific key is required.

**Data flow**: It calls `provider_specific_auth_check` with OpenAI auth not required and no provider key requirement, then asserts an OK result.

**Call relations**: It tests provider-specific auth behavior outside the OpenAI-auth path.

*Call graph*: calls 1 internal fn (provider_specific_auth_check); 2 external calls (new, assert_eq!).


##### `tests::provider_specific_auth_fails_when_provider_env_key_is_missing`  (lines 3463–3482)

```
fn provider_specific_auth_fails_when_provider_env_key_is_missing()
```

**Purpose**: Verifies that provider-specific auth fails when a required provider environment variable is missing.

**Data flow**: It calls `provider_specific_auth_check` with a required env var and a checker that always says missing, then asserts Fail and the configured remediation text.

**Call relations**: It protects the auth check that tells users which provider key to set.

*Call graph*: calls 1 internal fn (provider_specific_auth_check); 2 external calls (new, assert_eq!).


##### `tests::stored_auth_validation_rejects_missing_api_key`  (lines 3485–3501)

```
fn stored_auth_validation_rejects_missing_api_key()
```

**Purpose**: Checks that stored API-key auth is considered invalid if the key is missing, unless an API key is available in the environment.

**Data flow**: It builds stored auth with API-key mode but no key, runs `stored_auth_issues` with different environment checks, and asserts the missing-key issue appears or disappears accordingly.

**Call relations**: It tests stored-auth validation used by doctor auth diagnostics.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::stored_auth_validation_rejects_missing_chatgpt_tokens`  (lines 3504–3522)

```
fn stored_auth_validation_rejects_missing_chatgpt_tokens()
```

**Purpose**: Checks that ChatGPT-style stored auth reports missing token data and refresh metadata.

**Data flow**: It builds an empty stored auth record, calls `stored_auth_issues`, and asserts both expected missing-data messages.

**Call relations**: It protects diagnostics for incomplete ChatGPT login state.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::stored_auth_validation_handles_personal_access_token`  (lines 3525–3545)

```
fn stored_auth_validation_handles_personal_access_token()
```

**Purpose**: Checks that personal access token auth is recognized and validated correctly.

**Data flow**: It builds auth containing a personal access token, verifies the stored auth mode and no issues, then removes the token under explicit personal-token mode and expects a missing-token issue.

**Call relations**: It tests stored-auth mode detection and validation for personal access tokens.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::provider_reachability_mode_uses_api_key_auth`  (lines 3548–3575)

```
fn provider_reachability_mode_uses_api_key_auth()
```

**Purpose**: Confirms provider reachability uses API-key mode when either stored auth or environment variables indicate API-key authentication.

**Data flow**: It builds API-key stored auth and also tests an environment-variable path, calling `provider_auth_reachability_mode_from_auth` in both cases and expecting API-key mode.

**Call relations**: It directly tests the decision helper used by `provider_reachability_plan`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::provider_reachability_uses_active_provider_endpoint`  (lines 3578–3599)

```
fn provider_reachability_uses_active_provider_endpoint()
```

**Purpose**: Checks that provider reachability probes the active provider’s configured endpoint when provider auth is not required.

**Data flow**: It calls `provider_reachability_plan_from_parts` for an Azure-like endpoint and asserts the resulting plan has that endpoint and no route probe.

**Call relations**: It protects endpoint planning for non-OpenAI active providers.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::provider_reachability_adds_models_route_probe_for_openai_compatible_base_urls`  (lines 3602–3627)

```
fn provider_reachability_adds_models_route_probe_for_openai_compatible_base_urls()
```

**Purpose**: Verifies that OpenAI-compatible provider base URLs get a `/models` route probe, including query parameters.

**Data flow**: It builds query parameters, calls `provider_reachability_plan_from_parts`, and asserts the route probe URL is correctly joined and includes the query string.

**Call relations**: It tests `provider_reachability_plan_from_parts` and indirectly the URL-building behavior used for route probes.

*Call graph*: 2 external calls (from, assert_eq!).


##### `tests::provider_reachability_skips_route_probe_for_bedrock`  (lines 3630–3642)

```
fn provider_reachability_skips_route_probe_for_bedrock()
```

**Purpose**: Confirms Amazon Bedrock endpoints do not get a `/models` route probe. Bedrock’s compatibility layer should not be tested that way.

**Data flow**: It builds a Bedrock reachability plan and asserts the first endpoint has no route probe URL.

**Call relations**: It tests the Bedrock branch inside `provider_reachability_plan_from_parts`.

*Call graph*: calls 1 internal fn (provider_reachability_plan_from_parts); 1 external calls (assert_eq!).


##### `tests::provider_reachability_api_key_does_not_require_chatgpt`  (lines 3645–3665)

```
fn provider_reachability_api_key_does_not_require_chatgpt()
```

**Purpose**: Ensures API-key reachability checks the OpenAI API endpoint, not ChatGPT. This avoids requiring the wrong service for API-key users.

**Data flow**: It creates an API-key reachability plan without a custom base URL and asserts the endpoint is `https://api.openai.com/v1` with a `/models` route probe.

**Call relations**: It tests `provider_reachability_plan_from_parts` for API-key mode.

*Call graph*: calls 1 internal fn (provider_reachability_plan_from_parts); 1 external calls (assert_eq!).


##### `tests::provider_reachability_outcome_reports_required_failures`  (lines 3668–3683)

```
fn provider_reachability_outcome_reports_required_failures()
```

**Purpose**: Checks the summary rules for provider reachability warnings and required failures.

**Data flow**: It calls `provider_reachability_outcome` with warning-only and failure cases, then asserts the expected statuses and summaries.

**Call relations**: It directly protects the outcome policy used by `provider_reachability_check`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::provider_reachability_route_404_fails_bad_base_url_path`  (lines 3686–3724)

```
async fn provider_reachability_route_404_fails_bad_base_url_path()
```

**Purpose**: Verifies that a provider `/models` route returning 404 is treated as a bad base URL path and fails the check.

**Data flow**: It starts a local TCP server that returns 404 twice, builds a reachability plan pointing at it, runs `provider_reachability_check`, and asserts Fail plus a specific remedy.

**Call relations**: It tests the full path from plan construction through base probe, route probe, issue creation, and final status.

*Call graph*: calls 2 internal fn (provider_reachability_check, provider_reachability_plan_from_parts); 5 external calls (bind, assert!, assert_eq!, format!, spawn).


##### `tests::provider_reachability_route_401_keeps_reachability_ok`  (lines 3727–3760)

```
async fn provider_reachability_route_401_keeps_reachability_ok()
```

**Purpose**: Verifies that a `/models` route returning 401 still counts as reachable. Unauthorized means the route exists; credentials may simply be absent.

**Data flow**: It starts a local server that returns 404 for the base HEAD and 401 for the route GET, runs `provider_reachability_check`, and asserts OK with a route-exists detail.

**Call relations**: It tests the provider route classification used by `provider_route_probe_url` and summarized by `provider_reachability_check`.

*Call graph*: calls 2 internal fn (provider_reachability_check, provider_reachability_plan_from_parts); 5 external calls (bind, assert!, assert_eq!, format!, spawn).


##### `tests::collect_rollout_stats_counts_nested_rollout_files`  (lines 3763–3785)

```
fn collect_rollout_stats_counts_nested_rollout_files()
```

**Purpose**: Checks that rollout statistics include nested rollout files and ignore other JSONL files.

**Data flow**: It creates a temporary nested directory, writes one matching rollout file and one non-matching file, calls `collect_rollout_stats`, and asserts one file, five bytes, five average bytes, and no error.

**Call relations**: It tests `collect_rollout_stats`, `collect_rollout_stats_inner`, `is_rollout_file`, and `RolloutStats::average_bytes` together.

*Call graph*: calls 1 internal fn (collect_rollout_stats); 4 external calls (assert_eq!, create_dir_all, write, tempdir).


##### `tests::http_probe_treats_http_status_as_reachable`  (lines 3788–3806)

```
async fn http_probe_treats_http_status_as_reachable()
```

**Purpose**: Confirms that the basic HTTP probe treats any HTTP response as evidence the server is reachable, even a 405 Method Not Allowed.

**Data flow**: It starts a local listener, returns a 405 response to the probe, calls `http_probe_url`, and asserts the result is `HTTP 405`.

**Call relations**: It protects the behavior of `http_probe_url`, which provider and MCP checks rely on for simple reachability.

*Call graph*: calls 1 internal fn (http_probe_url); 4 external calls (bind, assert_eq!, format!, spawn).


##### `tests::mcp_http_probe_falls_back_to_get_when_head_times_out`  (lines 3809–3839)

```
async fn mcp_http_probe_falls_back_to_get_when_head_times_out()
```

**Purpose**: This test proves that the MCP HTTP reachability probe does not give up too early when a HEAD request hangs. It expects the probe to fall back to a GET request and report the HTTP status it receives.

**Data flow**: It starts a temporary local TCP listener, then accepts one connection that represents the HEAD probe and deliberately delays it past the timeout. It accepts a second connection for the fallback GET probe and replies with HTTP 405. The test calls `mcp_http_probe_url_with_timeout` with a very short timeout, then checks that the returned result is `HTTP 405`.

**Call relations**: The async test runner calls this test. Inside the test, a small fake server is spawned so `mcp_http_probe_url_with_timeout` can be exercised without contacting the real network. The test verifies that the probe’s fallback path produces the final status.

*Call graph*: calls 1 internal fn (mcp_http_probe_url_with_timeout); 5 external calls (from_millis, bind, assert_eq!, format!, spawn).


##### `tests::mcp_check_fails_required_missing_stdio_command`  (lines 3842–3864)

```
async fn mcp_check_fails_required_missing_stdio_command()
```

**Purpose**: This test checks that a required MCP server configured to run a missing local command is treated as a failure. It protects the user-facing behavior that required inputs must be present and reachable.

**Data flow**: It reads a small TOML configuration into an `McpServerConfig`, marks the server as required, and gives it a command name that should not exist. It puts that config into a server map and passes it to `mcp_check_from_servers`. The result should be a failed check with a clear summary and a detail saying the command is not resolvable.

**Call relations**: The test runner invokes this scenario as part of doctor test coverage. It hands fake MCP server configuration to `mcp_check_from_servers`, then inspects the returned check report to make sure the failure is visible and explained.

*Call graph*: calls 1 internal fn (mcp_check_from_servers); 4 external calls (from, assert!, assert_eq!, from_str).


##### `tests::read_probe_file_rejects_unreadable_file`  (lines 3868–3887)

```
fn read_probe_file_rejects_unreadable_file()
```

**Purpose**: This test confirms that a file probe refuses a file that exists but cannot be read. That matters because a path is not useful to the doctor command if the process cannot actually open it.

**Data flow**: It creates a temporary file, writes sample content, then changes its Unix permissions to remove all access. It calls `read_probe_file` with that path. Afterward it restores permissions so the temporary file can be cleaned up, and checks that the probe returned an error.

**Call relations**: The test runner calls this test on systems where Unix-style permission checks apply. The test sets up the bad file condition, hands the path to `read_probe_file`, and verifies that the helper reports the problem instead of silently accepting the path.

*Call graph*: calls 1 internal fn (read_probe_file); 5 external calls (assert!, metadata, set_permissions, write, new).


##### `tests::executable_path_exists_rejects_non_executable_file`  (lines 3891–3911)

```
fn executable_path_exists_rejects_non_executable_file()
```

**Purpose**: This test checks that an executable-path probe requires more than just a file being present. The file must also have execute permission, meaning the operating system would allow it to run.

**Data flow**: It creates a temporary file containing a shell-script header, then sets permissions so the file is readable and writable but not executable. It calls `executable_path_exists` and expects an error. Then it changes the permissions to make the file executable and expects the same helper to return success.

**Call relations**: The test runner uses this test to validate the command-resolution logic used by doctor checks. The test feeds `executable_path_exists` the same file under two permission states, showing that execute permission is the deciding factor.

*Call graph*: calls 1 internal fn (executable_path_exists); 6 external calls (assert!, assert_eq!, metadata, set_permissions, write, new).


##### `tests::should_enable_color_respects_terminal_inputs`  (lines 3914–3950)

```
fn should_enable_color_respects_terminal_inputs()
```

**Purpose**: This test verifies the basic decision rules for colored output. Color should be enabled only when the user has not disabled it, the terminal is capable, and the output stream is actually a terminal.

**Data flow**: It calls `should_enable_color` several times with different combinations of inputs: normal terminal settings, an explicit no-color flag, the `NO_COLOR` environment setting, `TERM=dumb`, and stdout not being a terminal. The first case should return true, and the disabling cases should return false.

**Call relations**: The test runner calls this function to lock down the color-output decision logic. Each call goes directly to `should_enable_color`, and the assertions describe the expected answer for each common terminal situation.

*Call graph*: 1 external calls (assert!).


##### `tests::terminal_inputs`  (lines 3952–3972)

```
fn terminal_inputs() -> TerminalCheckInputs
```

**Purpose**: This helper builds a normal, healthy set of fake terminal inputs for other tests. It gives those tests a clean starting point so each test can change only the one thing it wants to examine.

**Data flow**: It creates a `TerminalCheckInputs` value with an unknown but usable terminal name, `TERM=xterm-256color`, terminal streams marked as connected to a terminal, color support enabled, and a 120 by 40 terminal size. It returns that complete input bundle to the caller.

**Call relations**: Other terminal-related tests call this helper before changing one field or environment variable. It does not call the doctor logic itself; it supplies the baseline data that later gets passed into `terminal_check_from_inputs` or `color_output_summary`.

*Call graph*: 3 external calls (from, from, new).


##### `tests::set_terminal_env`  (lines 3974–3981)

```
fn set_terminal_env(inputs: &mut TerminalCheckInputs, name: &str, value: &str)
```

**Purpose**: This helper edits the fake environment inside a `TerminalCheckInputs` value. It keeps track of both which environment variables are present and what values they have.

**Data flow**: It receives mutable terminal inputs, an environment variable name, and a value. It marks the variable as present. If the value is empty, it removes the stored value; otherwise it stores the name and value in the fake environment map.

**Call relations**: Terminal tests use this helper to simulate environment variables such as `TERM`, `COLUMNS`, `LANG`, `TERMINFO`, `SSH_CONNECTION`, and `NO_COLOR`. After this helper changes the fake environment, the tests pass the inputs to the doctor terminal-checking functions.


##### `tests::terminal_check_warns_for_dumb_terminal`  (lines 3984–4002)

```
fn terminal_check_warns_for_dumb_terminal()
```

**Purpose**: This test checks that `TERM=dumb` is reported as a serious terminal problem. A “dumb” terminal means colors and cursor-control features are disabled or unavailable.

**Data flow**: It starts with normal fake terminal inputs, changes the terminal name and `TERM` value to `dumb`, then runs `terminal_check_from_inputs`. The returned check should fail, summarize that colors and cursor control are disabled, contain one issue, and suggest setting `TERM` to a real value such as `xterm-256color`.

**Call relations**: The test runner calls this function. The test uses `terminal_inputs` and `set_terminal_env` to create the bad terminal condition, then relies on `terminal_check_from_inputs` to produce the diagnosis.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 3 external calls (assert_eq!, set_terminal_env, terminal_inputs).


##### `tests::terminal_check_warns_for_narrow_terminal`  (lines 4005–4021)

```
fn terminal_check_warns_for_narrow_terminal()
```

**Purpose**: This test verifies that the doctor warns when the measured terminal width is below the recommended minimum. Narrow terminals can make command output wrap and become hard to read.

**Data flow**: It creates normal fake terminal inputs, then changes the measured size to 79 columns wide. It passes the inputs to `terminal_check_from_inputs`. The result should be a warning with a summary about wrapping, an expected value of at least 80 columns, and a remedy telling the user to resize the window.

**Call relations**: The test runner invokes this as a terminal-diagnostics scenario. It feeds a narrow measured terminal size into `terminal_check_from_inputs` and checks that the output is useful to a person reading the doctor report.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 2 external calls (assert_eq!, terminal_inputs).


##### `tests::terminal_check_warns_for_declared_narrow_terminal`  (lines 4024–4037)

```
fn terminal_check_warns_for_declared_narrow_terminal()
```

**Purpose**: This test checks the case where the environment variable `COLUMNS` says the terminal is too narrow. The doctor should notice declared terminal size problems, not only measured ones.

**Data flow**: It builds normal terminal inputs, sets `COLUMNS` to `60`, then calls `terminal_check_from_inputs`. The returned check should be a warning, summarize that output may wrap, include `COLUMNS: 60` in the details, and mark `COLUMNS` as the field involved in the issue.

**Call relations**: The test uses `terminal_inputs` for the baseline and `set_terminal_env` to simulate a user environment. It then hands the prepared inputs to `terminal_check_from_inputs`, verifying that environment-declared width is included in the diagnosis.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 4 external calls (assert!, assert_eq!, set_terminal_env, terminal_inputs).


##### `tests::terminal_check_warns_for_non_utf8_locale`  (lines 4040–4056)

```
fn terminal_check_warns_for_non_utf8_locale()
```

**Purpose**: This test verifies that the doctor warns when the locale is not UTF-8. UTF-8 is the common text encoding needed for many Unicode symbols to display correctly.

**Data flow**: It starts with normal terminal inputs, sets `LANG` to `C`, and calls `terminal_check_from_inputs`. The result should be a warning saying Unicode glyphs may render incorrectly, include the effective locale in the details, and suggest exporting a UTF-8 locale such as `en_US.UTF-8`.

**Call relations**: The test runner calls this test as part of terminal diagnostics coverage. The test prepares the locale setting with `set_terminal_env`, then checks that `terminal_check_from_inputs` turns that setting into a clear warning and remedy.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 4 external calls (assert!, assert_eq!, set_terminal_env, terminal_inputs).


##### `tests::terminal_check_warns_for_unreadable_terminfo_path`  (lines 4059–4082)

```
fn terminal_check_warns_for_unreadable_terminfo_path()
```

**Purpose**: This test confirms that an invalid `TERMINFO` path is reported as a failure. `TERMINFO` points to terminal capability data; if it is unreadable or missing, the program may not know what the terminal can do.

**Data flow**: It creates a temporary directory, chooses a missing path inside it, and sets `TERMINFO` to that missing path in the fake terminal inputs. It calls `terminal_check_from_inputs`. The returned check should fail, explain that terminal capabilities are unknown, include a detail showing the missing path, and suggest checking that `$TERMINFO` points to a readable directory.

**Call relations**: The test uses `terminal_inputs` and `set_terminal_env` to create a bad `TERMINFO` environment. It then passes that setup to `terminal_check_from_inputs`, which is expected to produce the failure report.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 5 external calls (assert!, assert_eq!, set_terminal_env, terminal_inputs, tempdir).


##### `tests::terminal_check_reports_remote_indicators_as_present_only`  (lines 4085–4102)

```
fn terminal_check_reports_remote_indicators_as_present_only()
```

**Purpose**: This test checks that remote-session environment variables are reported without leaking their full values. That matters because variables like `SSH_CONNECTION` can contain IP addresses.

**Data flow**: It creates normal terminal inputs and sets `SSH_CONNECTION` to a value containing example IP addresses. After calling `terminal_check_from_inputs`, it checks that the details say `SSH_CONNECTION: present` but do not include the actual IP address text.

**Call relations**: The test runner calls this privacy-focused terminal test. The setup uses `set_terminal_env`, and `terminal_check_from_inputs` is expected to include the presence of a remote-session indicator while hiding sensitive connection details.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 3 external calls (assert!, set_terminal_env, terminal_inputs).


##### `tests::terminal_check_includes_windows_console_details`  (lines 4105–4118)

```
fn terminal_check_includes_windows_console_details()
```

**Purpose**: This test ensures that Windows console information collected by the terminal probe is preserved in the doctor report. These details can help explain color or virtual-terminal behavior on Windows.

**Data flow**: It creates normal terminal inputs, adds a Windows console detail string describing stdout console mode and virtual terminal processing, then calls `terminal_check_from_inputs`. The returned details should include that exact console information.

**Call relations**: The test runner invokes this test to cover Windows-specific diagnostic text. The test inserts the console detail into the input bundle and confirms that `terminal_check_from_inputs` carries it through into the final report.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 2 external calls (assert!, terminal_inputs).


##### `tests::terminal_check_keeps_tmux_probe_failures_non_fatal`  (lines 4121–4129)

```
fn terminal_check_keeps_tmux_probe_failures_non_fatal()
```

**Purpose**: This test verifies that incomplete tmux information does not make the terminal check fail. Tmux is a terminal multiplexer, meaning it lets one terminal window host multiple terminal sessions.

**Data flow**: It creates normal terminal inputs and marks the terminal as being inside tmux, but with no tmux version detected. It calls `terminal_check_from_inputs`. The result should still be OK with a summary saying terminal metadata was detected.

**Call relations**: The test runner calls this scenario to make sure optional tmux probing remains non-fatal. It prepares the multiplexer field in the fake input, then relies on `terminal_check_from_inputs` to decide that missing tmux version details are not a user-blocking problem.

*Call graph*: calls 1 internal fn (terminal_check_from_inputs); 2 external calls (assert_eq!, terminal_inputs).


##### `tests::color_output_summary_reports_disabled_reasons`  (lines 4132–4152)

```
fn color_output_summary_reports_disabled_reasons()
```

**Purpose**: This test checks that the color-output summary names the specific reason color is disabled. Clear reasons help users understand whether color was disabled by a flag, an environment variable, terminal type, or redirected output.

**Data flow**: It repeatedly creates fresh normal terminal inputs, changes one condition at a time, and calls `color_output_summary`. It checks the summary for four cases: `--no-color`, `NO_COLOR`, `TERM=dumb`, and stdout not being a terminal.

**Call relations**: The test runner calls this function to cover the user-facing text from `color_output_summary`. It uses `terminal_inputs` for clean defaults and `set_terminal_env` where needed, then verifies the summary string produced for each disabling condition.

*Call graph*: 3 external calls (assert_eq!, set_terminal_env, terminal_inputs).


### `tui/src/session_archive_commands.rs`

`orchestration` · `command execution`

This file is the shared engine behind three related commands: `codex archive`, `codex delete`, and `codex unarchive`. These commands are intentionally thin: they do not edit session storage directly. Instead, they start or connect to the Codex app server, find the session the user meant, and ask the server to perform the change. That matters because the app server is the central place that understands session state, archived status, remote workspaces, and storage details.

The flow is like asking a librarian to move a book: the command first identifies the exact book, then the librarian updates the catalog. A target can be a session UUID, which is a unique identifier, or an exact session name. Names are searched only in the relevant area: active sessions for archive, archived sessions for unarchive, and both active and archived sessions for delete.

Deletion gets extra care. If confirmation is required, the file reads the session first so it can show the user the name, asks for a clear yes/no answer in an interactive terminal, and refuses to guess if no terminal is available. The startup code also does the heavier setup work: loading configuration, resolving local or remote app-server targets, preparing environment paths, opening the state database, and creating an `AppServerSession` client used by the action code.

#### Function details

##### `success_message`  (lines 57–71)

```
fn success_message(
    action: SessionArchiveAction,
    session_id: ThreadId,
    session_name: Option<&str>,
) -> String
```

**Purpose**: Builds the short message shown after a session was successfully archived, deleted, or unarchived. It includes the session name when one is known, and always includes the session ID.

**Data flow**: It receives the requested action, the session ID, and an optional session name. It chooses the right past-tense word, such as “Archived” or “Deleted,” then returns a finished sentence as text. It does not change anything outside itself.

**Call relations**: After the app server has completed the archive, delete, or unarchive request, `run_session_archive_action_with_app_server` calls this function to turn the result into the final user-facing response.

*Call graph*: called by 1 (run_session_archive_action_with_app_server); 1 external calls (format!).


##### `run_session_archive_command`  (lines 78–85)

```
async fn run_session_archive_command(
    action: SessionArchiveAction,
    target: String,
    options: SessionArchiveCommandOptions,
) -> Result<String>
```

**Purpose**: This is the main entry for running one archive, delete, or unarchive command. It prepares an app-server connection and then performs the requested action on the requested session.

**Data flow**: It receives the action, the user’s target text, and command options such as CLI settings and executable paths. It first starts or connects to the app server, then passes that connection plus the target into the action runner. It returns the final success or cancellation message, or an error if setup or the action fails.

**Call relations**: This function ties together the two big phases of the command. It calls `start_app_server_for_archive_command` for setup, then hands the ready `AppServerSession` to `run_session_archive_action_with_app_server` to do the real archive, delete, or unarchive work.

*Call graph*: calls 2 internal fn (run_session_archive_action_with_app_server, start_app_server_for_archive_command).


##### `run_session_archive_action_with_app_server`  (lines 87–117)

```
async fn run_session_archive_action_with_app_server(
    app_server: &mut AppServerSession,
    action: SessionArchiveAction,
    target: &str,
) -> Result<String>
```

**Purpose**: Performs the actual archive, delete, or unarchive request once an app-server connection already exists. It also enforces the delete confirmation step when needed.

**Data flow**: It receives an app-server session, the chosen action, and the user’s target string. It first resolves that target into a concrete session ID and maybe a name. Then it calls the matching app-server method: archive, delete, or unarchive. For delete with prompting, it asks the user to confirm before calling the server. It returns a message saying what happened, or “Delete cancelled.” if the user declines.

**Call relations**: This is called by `run_session_archive_command` after setup. It relies on `resolve_session_target` to identify the session, may call `confirm_session_delete` before deletion, sends the final request through the app-server client methods, and then calls `success_message` to prepare the text shown to the user.

*Call graph*: calls 6 internal fn (thread_archive, thread_delete, thread_unarchive, confirm_session_delete, resolve_session_target, success_message); called by 1 (run_session_archive_command); 1 external calls (matches!).


##### `resolve_session_target`  (lines 119–159)

```
async fn resolve_session_target(
    app_server: &mut AppServerSession,
    action: SessionArchiveAction,
    target: &str,
) -> Result<ResolvedSessionTarget>
```

**Purpose**: Turns what the user typed into a definite session ID. The target may already be a UUID, or it may be an exact session name that needs to be looked up.

**Data flow**: It receives the app-server connection, the action being performed, and the target text. If the text is a valid session ID, it usually uses it directly; for prompted deletion it reads the session first so the confirmation prompt can show the name. If the text is not a valid ID, it searches sessions by exact name in the right archive state for the action. It returns a resolved session ID plus an optional name, or an error if nothing matches.

**Call relations**: This function is the name-and-ID resolver used by `run_session_archive_action_with_app_server` before any change is made. It may ask the app server to read a session directly, or it may call `lookup_session_by_exact_name` and then `session_target_from_app_server_thread` to convert the found server record into the local resolved form.

*Call graph*: calls 4 internal fn (from_string, thread_read, lookup_session_by_exact_name, session_target_from_app_server_thread); called by 1 (run_session_archive_action_with_app_server); 2 external calls (eyre!, matches!).


##### `lookup_session_by_exact_name`  (lines 161–203)

```
async fn lookup_session_by_exact_name(
    app_server: &mut AppServerSession,
    name: &str,
    archived: bool,
) -> Result<Option<AppServerThread>>
```

**Purpose**: Searches the app server for a session whose name exactly matches the text the user typed. It can search either active sessions or archived sessions, depending on what the caller asks for.

**Data flow**: It receives the app-server connection, the desired name, and whether to look in archived sessions. It requests session lists in pages of up to 100, first using the name as a search term for speed, then falling back to listing without a search term because some stores may attach names after filtering. It scans each page for an exact name match and returns the matching thread if found, or `None` if all pages are checked without a match.

**Call relations**: `resolve_session_target` calls this when the user did not provide a valid UUID. This function repeatedly calls the app server’s session-list operation and uses the shared resume-source filter so it searches the same kind of sessions the resume/archive UI expects.

*Call graph*: calls 1 internal fn (thread_list); called by 1 (resolve_session_target); 1 external calls (resume_source_kinds).


##### `session_target_from_app_server_thread`  (lines 205–212)

```
fn session_target_from_app_server_thread(thread: AppServerThread) -> Result<ResolvedSessionTarget>
```

**Purpose**: Converts a session record returned by the app server into the simpler target form used by this command code. It also checks that the server’s session ID is valid.

**Data flow**: It receives an app-server thread record containing an ID string and optional name. It parses the ID string into a `ThreadId`; if parsing fails, it returns an error that points out the app server returned an invalid ID. On success, it returns the parsed ID together with the thread name.

**Call relations**: `resolve_session_target` uses this after `lookup_session_by_exact_name` finds a matching thread. It is the small handoff step between the server’s thread-list format and the command’s internal resolved-target format.

*Call graph*: calls 1 internal fn (from_string); called by 1 (resolve_session_target).


##### `confirm_session_delete`  (lines 214–241)

```
fn confirm_session_delete(target: &ResolvedSessionTarget) -> Result<bool>
```

**Purpose**: Asks the user to confirm permanent deletion of a session. This protects against accidental data loss, because deletion cannot be undone and also removes subagent threads.

**Data flow**: It receives the resolved session target, including the ID and maybe the name. It first checks that standard input and standard error are connected to an interactive terminal; if not, it returns an error telling the user to use `--force` with a session UUID. If a terminal is available, it prints the warning and prompt, reads one line of input, and returns `true` only for `y` or `yes`, ignoring letter case.

**Call relations**: `run_session_archive_action_with_app_server` calls this only for delete actions that require prompting. If this function returns `false`, the delete request is not sent to the app server; if it returns `true`, the app-server delete call proceeds.

*Call graph*: called by 1 (run_session_archive_action_with_app_server); 6 external calls (new, eyre!, stderr, stdin, write!, writeln!).


##### `start_app_server_for_archive_command`  (lines 243–397)

```
async fn start_app_server_for_archive_command(
    options: SessionArchiveCommandOptions,
) -> Result<AppServerSession>
```

**Purpose**: Prepares the app-server client used by archive, delete, and unarchive commands. It hides the setup details needed before a simple command can safely talk to local or remote Codex session storage.

**Data flow**: It receives command options, including the parsed CLI settings, paths to Codex executables, and any explicit remote endpoint. It parses `-c` configuration overrides, finds the Codex home directory, resolves profile-specific config files, decides whether an existing local daemon can be reused, prepares runtime paths and the environment manager, loads configuration, prepares cloud authentication configuration, chooses OSS provider and model settings when needed, opens the state database, and starts or connects to the app server. It returns an `AppServerSession` ready for session RPC calls, with a remote current-directory override when appropriate.

**Call relations**: `run_session_archive_command` calls this before any session can be changed. This function coordinates many lower-level helpers from nearby modules and configuration crates, then hands back the single app-server session object that `run_session_archive_action_with_app_server` uses for the actual archive, delete, or unarchive request.

*Call graph*: calls 8 internal fn (default, load_config_toml_with_layer_stack, resolve_oss_provider, resolve_profile_v2_config_path, from_env, from_optional_paths, new, new); called by 1 (run_session_archive_command); 12 external calls (default, cloud_config_bundle_loader_for_storage, find_codex_home, default, default, resolve_bootstrap_auth_keyring_backend_kind, app_server_target_for_launch, can_reuse_implicit_local_daemon, config_cwd_for_app_server_target, init_state_db_for_app_server_target (+2 more)).


### Patch and MCP utilities
These standalone command handlers apply remote task diffs and manage MCP server configuration and authentication.

### `chatgpt/src/apply_command.rs`

`orchestration` · `command execution`

This file supports a command-line action: apply the newest diff from a Codex task. A diff is a text description of file changes, like a recipe saying “add this line here, remove that line there.” Without this file, a user could fetch or inspect a task, but the proposed code changes would not be automatically applied to their working folder.

The flow is simple. First, the command reads the task id from the command line, along with any configuration overrides. It loads the project configuration, then asks the Codex service for the task. From the task response, it looks for the current turn that contains a pull-request-style output item. That item is expected to contain the actual diff. If the task has no diff turn, or if the diff turn does not contain the expected pull request output, the command stops with a clear error.

Once it has the diff text, the file builds an apply request and passes it to the shared git patch utility. Git is the tool being used underneath to safely apply the patch to the chosen working directory. If git reports failure, this code includes useful details such as which paths were applied, skipped, or conflicted, plus the command output. If everything works, it prints a success message.

#### Function details

##### `run_apply_command`  (lines 22–36)

```
async fn run_apply_command(
    apply_cli: ApplyCommand,
    cwd: Option<PathBuf>,
) -> anyhow::Result<()>
```

**Purpose**: This is the top-level routine for the apply command. It loads configuration, fetches the requested Codex task, and then starts the process of applying that task’s latest diff.

**Data flow**: It receives the parsed command-line input, including the task id and configuration overrides, plus an optional working folder. It turns the overrides into a loaded configuration, uses that configuration and task id to fetch the task response, and passes the task response onward. It returns success if the diff is applied, or an error if configuration loading, task fetching, or patch application fails.

**Call relations**: The command-line entry point calls this when the user runs the apply command. This function then calls the task-fetching helper to get the task data, and hands the result to apply_diff_from_task, which knows how to find and apply the diff inside that task.

*Call graph*: calls 2 internal fn (apply_diff_from_task, get_task); called by 1 (cli_main); 1 external calls (load_with_cli_overrides).


##### `apply_diff_from_task`  (lines 38–54)

```
async fn apply_diff_from_task(
    task_response: GetTaskResponse,
    cwd: Option<PathBuf>,
) -> anyhow::Result<()>
```

**Purpose**: This function extracts the usable diff from a task response and sends it to be applied. It exists to turn the larger task data structure into the one piece needed here: the patch text.

**Data flow**: It receives a task response and an optional working folder. It first looks for the current diff-producing task turn. Inside that turn, it searches the output items for a pull-request output containing an output diff. If it finds one, it passes the diff text and folder to apply_diff. If the expected turn or output item is missing, it returns an error instead of guessing.

**Call relations**: run_apply_command calls this after fetching a task. Tests also call it directly to check both successful application and merge-conflict behavior. When it finds a diff, it hands off to apply_diff, which performs the actual git patch operation.

*Call graph*: calls 1 internal fn (apply_diff); called by 3 (run_apply_command, test_apply_command_creates_fibonacci_file, test_apply_command_with_merge_conflicts); 1 external calls (bail!).


##### `apply_diff`  (lines 56–77)

```
async fn apply_diff(diff: &str, cwd: Option<PathBuf>) -> anyhow::Result<()>
```

**Purpose**: This function applies a raw diff string to a directory using the project’s git patch utility. It is the point where proposed changes become real file changes on disk.

**Data flow**: It receives diff text and an optional working folder. If no folder is provided, it uses the current directory, falling back to the system temporary directory if the current directory cannot be read. It packages the folder and diff into an apply request, asks the git utility to apply it, and checks the result. On failure it returns an error with git output and path counts; on success it prints a confirmation and returns successfully.

**Call relations**: apply_diff_from_task calls this after it has found the diff inside the task response. This function delegates the low-level patch work to apply_git_patch, then interprets the result for the user by either reporting detailed failure information or printing that the diff was successfully applied.

*Call graph*: called by 1 (apply_diff_from_task); 4 external calls (bail!, apply_git_patch, println!, current_dir).


### `cli/src/mcp_cmd.rs`

`orchestration` · `command handling`

This file is the command-center for managing MCP, the Model Context Protocol, from the Codex command line. In plain terms, it lets a user tell Codex, “Here are the extra tool servers you can use,” and then view or change that list later. Without this file, users would have to edit configuration files and authentication tokens by hand, which is error-prone and especially awkward for OAuth login.

The file defines the shape of the `codex mcp` subcommands using Clap, the command-line parser. The main `McpCli::run` function looks at which subcommand the user typed and sends the work to the right helper. Some helpers read the current Codex configuration, some edit the global MCP server list under the Codex home directory, and some print friendly tables or JSON for scripts.

There are two kinds of MCP server connection described here. A `stdio` server is started as a local command, like launching a helper program and talking through its standard input and output. A `streamable_http` server is reached through a URL, like calling a web service. HTTP servers may need OAuth, which is a browser-based sign-in flow. The file includes a careful retry path for older servers that reject modern “scope” requests during OAuth, so login can still succeed.

#### Function details

##### `McpCli::run`  (lines 171–203)

```
async fn run(self, loader_overrides: LoaderOverrides) -> Result<()>
```

**Purpose**: This is the dispatcher for the `codex mcp` command. It reads which subcommand the user chose and sends control to the matching worker function.

**Data flow**: It receives the parsed command-line options and loader settings. It first checks whether a profile migration validation is needed, then matches the chosen subcommand and passes the relevant arguments along. It returns success if the chosen operation completes, or an error if validation, configuration loading, editing, or authentication fails.

**Call relations**: This function is the doorway into the rest of the file. When the user asks to list, get, add, remove, login, or logout, it calls `run_list`, `run_get`, `run_add`, `run_remove`, `run_login`, or `run_logout`; when profile-related loader settings are present, it first calls `validate_profile_v2_migration`.

*Call graph*: calls 7 internal fn (run_add, run_get, run_list, run_login, run_logout, run_remove, validate_profile_v2_migration).


##### `perform_oauth_login_retry_without_scopes`  (lines 210–258)

```
async fn perform_oauth_login_retry_without_scopes(
    name: &str,
    url: &str,
    store_mode: codex_config::types::OAuthCredentialsStoreMode,
    keyring_backend_kind: codex_config::types::AuthKey
```

**Purpose**: This function runs the OAuth sign-in flow for an MCP server, with a compatibility fallback for older or stricter providers. OAuth is the browser-style login process where Codex receives permission to access a server.

**Data flow**: It takes the server name, URL, credential storage settings, optional headers, resolved OAuth scopes, and optional OAuth details such as client ID and callback address. It first tries login using the requested or discovered scopes. If that fails in a way that means the provider rejected those scopes, it prints a message and tries once more with no scopes. The output is either a completed login with stored credentials, or an error explaining why login failed.

**Call relations**: `run_add` uses this after adding a server if OAuth support is detected, and `run_login` uses it when the user explicitly asks to sign in. Internally it hands the real login work to `perform_oauth_login`, and asks `should_retry_without_scopes` whether a failed scoped login is worth retrying.

*Call graph*: called by 2 (run_add, run_login); 3 external calls (should_retry_without_scopes, perform_oauth_login, println!).


##### `validate_profile_v2_migration`  (lines 260–274)

```
async fn validate_profile_v2_migration(
    config_overrides: &CliConfigOverrides,
    loader_overrides: LoaderOverrides,
) -> Result<()>
```

**Purpose**: This function checks that configuration can still be loaded correctly when profile-related loader overrides are in use. It acts as a safety check before running the requested MCP command.

**Data flow**: It receives CLI configuration overrides and loader overrides. It parses the CLI overrides, builds a configuration using those settings, and stops with a clear error if loading fails. It does not produce a user-facing value; success simply means the command can continue.

**Call relations**: `McpCli::run` calls this only when a user configuration profile override is present. It relies on configuration-building code outside this file to do the actual load and validation.

*Call graph*: calls 1 internal fn (parse_overrides); called by 1 (run); 1 external calls (default).


##### `run_add`  (lines 276–409)

```
async fn run_add(config_overrides: &CliConfigOverrides, add_args: AddArgs) -> Result<()>
```

**Purpose**: This function adds a new global MCP server entry to the user’s Codex configuration. It supports both local command-based servers and URL-based HTTP servers, and may start OAuth login right away if the new server advertises support for it.

**Data flow**: It receives CLI overrides plus the server name and connection details. It validates the name, loads the current global MCP server list, turns the command-line arguments into an MCP server configuration, inserts or replaces the named entry, and writes the updated list back to the Codex config. After saving, it checks whether the chosen transport supports OAuth; if so, it resolves scopes and runs the login flow. The visible result is printed confirmation, and possibly a completed OAuth login.

**Call relations**: `McpCli::run` calls this for the `add` subcommand. It uses `validate_server_name` before editing configuration, uses configuration and filesystem helpers to load and write the server list, and calls `perform_oauth_login_retry_without_scopes` when OAuth login should begin.

*Call graph*: calls 6 internal fn (perform_oauth_login_retry_without_scopes, validate_server_name, new, find_codex_home, load_global_mcp_servers, parse_overrides); called by 1 (run); 7 external calls (new, new, load_with_cli_overrides, bail!, oauth_login_support, resolve_oauth_scopes, println!).


##### `run_remove`  (lines 411–442)

```
async fn run_remove(config_overrides: &CliConfigOverrides, remove_args: RemoveArgs) -> Result<()>
```

**Purpose**: This function removes a named global MCP server from the user’s configuration. It is the safe command-line alternative to manually editing the config file.

**Data flow**: It receives CLI overrides and the server name. It validates the name, finds the Codex home directory, loads the global MCP server map, removes the matching entry if it exists, and writes the updated map back only when something changed. It prints either a removal confirmation or a message that no server by that name was found.

**Call relations**: `McpCli::run` calls this for the `remove` subcommand. It shares name checking with `run_add` through `validate_server_name`, and uses the same configuration editing path to persist the changed server list.

*Call graph*: calls 5 internal fn (validate_server_name, new, find_codex_home, load_global_mcp_servers, parse_overrides); called by 1 (run); 1 external calls (println!).


##### `run_login`  (lines 444–497)

```
async fn run_login(config_overrides: &CliConfigOverrides, login_args: LoginArgs) -> Result<()>
```

**Purpose**: This function signs in to an existing HTTP-based MCP server using OAuth. It is used when a server needs browser-style authentication before Codex can use it.

**Data flow**: It receives CLI overrides plus the server name and optional requested scopes. It loads the full Codex configuration, asks the MCP manager for configured servers, finds the named server, and rejects the request if that server is not an HTTP transport. It then decides which OAuth scopes to request: explicit command-line scopes, configured scopes, discovered scopes, or none. Finally it runs the OAuth login flow and prints a success message.

**Call relations**: `McpCli::run` calls this for the `login` subcommand. It creates an MCP manager to look up configured servers, may call external scope discovery, then delegates the actual sign-in to `perform_oauth_login_retry_without_scopes`.

*Call graph*: calls 4 internal fn (perform_oauth_login_retry_without_scopes, new, new, parse_overrides); called by 1 (run); 6 external calls (new, load_with_cli_overrides, bail!, discover_supported_scopes, resolve_oauth_scopes, println!).


##### `run_logout`  (lines 499–534)

```
async fn run_logout(config_overrides: &CliConfigOverrides, logout_args: LogoutArgs) -> Result<()>
```

**Purpose**: This function removes stored OAuth credentials for a named HTTP-based MCP server. It lets the user disconnect Codex from that server without deleting the server configuration itself.

**Data flow**: It receives CLI overrides and the server name. It loads configuration, finds the named MCP server, checks that it is an HTTP server, and then asks the credential storage layer to delete saved OAuth tokens for that server and URL. It prints whether credentials were removed, were not present, or could not be deleted.

**Call relations**: `McpCli::run` calls this for the `logout` subcommand. Like `run_login`, it uses the MCP manager to find the configured server, then hands token deletion to `delete_oauth_tokens`.

*Call graph*: calls 3 internal fn (new, new, parse_overrides); called by 1 (run); 6 external calls (new, anyhow!, load_with_cli_overrides, bail!, delete_oauth_tokens, println!).


##### `run_list`  (lines 536–791)

```
async fn run_list(config_overrides: &CliConfigOverrides, list_args: ListArgs) -> Result<()>
```

**Purpose**: This function shows all configured MCP servers. It can print either readable tables for people or JSON for scripts and automation.

**Data flow**: It receives CLI overrides and the list options. It loads configuration, asks the MCP manager for configured and effective servers, sorts the servers by name, and computes each server’s authentication status. If JSON output is requested, it builds structured JSON objects. Otherwise it separates local `stdio` servers from HTTP servers, formats their key fields, sizes the columns, and prints tables. If there are no servers, it prints a short hint for adding one.

**Call relations**: `McpCli::run` calls this for the `list` subcommand. It uses `format_mcp_status` to turn enabled or disabled state into display text, uses the MCP manager for server discovery, and relies on authentication-status code to show whether login is needed or available.

*Call graph*: calls 4 internal fn (format_mcp_status, new, new, parse_overrides); called by 1 (run); 7 external calls (new, new, load_with_cli_overrides, compute_auth_statuses, format_env_display, println!, to_string_pretty).


##### `run_get`  (lines 793–962)

```
async fn run_get(config_overrides: &CliConfigOverrides, get_args: GetArgs) -> Result<()>
```

**Purpose**: This function shows the details for one named MCP server. It is useful when a user wants to inspect exactly how Codex will connect to a server.

**Data flow**: It receives CLI overrides, a server name, and an optional JSON flag. It loads configuration, finds the named server, and stops with an error if it does not exist. In JSON mode it prints a structured version of the server configuration. In human-readable mode it prints whether the server is enabled, which tools are enabled or disabled, how the server is reached, timeouts, approval mode, and a ready-made remove command. Sensitive static HTTP header values are masked rather than printed in full.

**Call relations**: `McpCli::run` calls this for the `get` subcommand. It uses the MCP manager to locate the configured server, uses `format_env_display` for environment-variable display, and prints either JSON or plain text depending on the user’s option.

*Call graph*: calls 3 internal fn (new, new, parse_overrides); called by 1 (run); 7 external calls (new, load_with_cli_overrides, bail!, format_env_display, println!, json!, to_string_pretty).


##### `parse_env_pair`  (lines 964–977)

```
fn parse_env_pair(raw: &str) -> Result<(String, String), String>
```

**Purpose**: This function parses one `KEY=VALUE` environment-variable argument for a local MCP server. It helps make `codex mcp add --env ...` reject malformed input early.

**Data flow**: It receives one raw string from the command line. It splits the string at the first equals sign, trims and checks the key, and keeps the value as written. It returns a key-value pair on success, or a plain error message if the string is missing a key or missing the equals/value part.

**Call relations**: This function is wired into the command-line argument parser for `--env`. Before `run_add` sees environment variables, Clap uses this parser so `run_add` receives clean `(key, value)` pairs instead of raw strings.


##### `validate_server_name`  (lines 979–990)

```
fn validate_server_name(name: &str) -> Result<()>
```

**Purpose**: This function enforces a simple, safe naming rule for MCP servers. Names must be non-empty and contain only letters, numbers, dashes, or underscores.

**Data flow**: It receives a proposed server name. It checks every character against the allowed set. If the name is valid it returns success; otherwise it returns an error telling the user which characters are allowed.

**Call relations**: `run_add` calls this before saving a new server, and `run_remove` calls it before attempting deletion. That keeps the global server list using predictable names and prevents confusing or unsafe entries.

*Call graph*: called by 2 (run_add, run_remove); 1 external calls (bail!).


##### `format_mcp_status`  (lines 992–1000)

```
fn format_mcp_status(config: &McpServerConfig) -> String
```

**Purpose**: This function turns an MCP server’s enabled or disabled state into a short display string. It gives the list view a consistent status column.

**Data flow**: It receives one MCP server configuration. If the server is enabled, it returns `enabled`. If it is disabled with a reason, it returns `disabled: reason`. If it is disabled without a reason, it returns `disabled`.

**Call relations**: `run_list` calls this while building the human-readable tables. It does not change configuration; it only converts stored state into text for the user.

*Call graph*: called by 1 (run_list); 1 external calls (format!).
