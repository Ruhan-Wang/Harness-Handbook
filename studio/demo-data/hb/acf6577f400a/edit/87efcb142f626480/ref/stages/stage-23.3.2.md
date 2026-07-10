# top-level codex CLI command verification  `stage-23.3.2`

This stage is the safety check for the very top of the Codex command-line tool: the place where a user types a command and expects the right thing to happen. It sits around startup and command dispatch, making sure the program chooses the correct path, reads options correctly, and fails in the right way when input is wrong.

Several tests focus on strict configuration checking for app-server, exec-server, and feature-related commands, so bad settings are caught early. Other tests cover maintenance and support commands: delete checks error messages come in the right order, update confirms debug builds stop immediately instead of starting an update flow, and the debug commands verify memory cleanup and model-list output.

A large group checks extension management. The plugin and marketplace tests cover listing, install and removal, JSON output, and how configured, cached, home, and built-in marketplace locations interact. Separate add, remove, and upgrade tests verify those specific command paths. The MCP tests cover adding, removing, listing, and showing remote tool servers, including saved settings, secret masking, and invalid flag combinations. Finally, the live CLI smoke test runs the real binary against the real online service for an end-to-end reality check.

## Files in this stage

### Entrypoint validation
These tests verify strict configuration handling and basic command-surface behavior for top-level and server-style CLI entrypoints.

### `cli/tests/app_server.rs`

`test` · `startup/config validation`

This file builds a real `codex` test process with `assert_cmd`, points it at an isolated temporary `CODEX_HOME`, and verifies that `app-server` refuses unknown keys when strict config parsing is enabled. The setup is intentionally minimal: it writes a `config.toml` containing only an invalid top-level field (`foo = "bar"`), then invokes `codex app-server --strict-config --listen off`. The assertion is not just that the command fails, but that stderr contains the specific validation message about an unknown configuration field, proving the failure happens during config decoding rather than later server startup. The helper centralizes command construction and environment wiring so the test always executes the compiled `codex` binary against the temporary home directory. A subtle design point is the `--listen off` argument: it prevents the test from depending on network binding or long-running server behavior, keeping the test focused entirely on configuration rejection at startup.

#### Function details

##### `codex_command`  (lines 7–11)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Constructs an `assert_cmd::Command` for the compiled `codex` binary and binds it to a supplied temporary home directory via `CODEX_HOME`.

**Data flow**: Takes `codex_home: &Path`, resolves the binary path with `codex_utils_cargo_bin::cargo_bin("codex")`, creates an `assert_cmd::Command`, sets the `CODEX_HOME` environment variable on that process, and returns the configured command wrapped in `anyhow::Result`.

**Call relations**: This helper is invoked by `strict_config_rejects_unknown_config_fields_for_app_server` before any assertions. It delegates binary lookup and process construction so the test body can focus on CLI arguments and expected stderr.

*Call graph*: called by 1 (strict_config_rejects_unknown_config_fields_for_app_server); 2 external calls (new, cargo_bin).


##### `strict_config_rejects_unknown_config_fields_for_app_server`  (lines 14–30)

```
fn strict_config_rejects_unknown_config_fields_for_app_server() -> Result<()>
```

**Purpose**: Verifies that `codex app-server` exits with an error when strict config mode encounters an unknown field in `config.toml`.

**Data flow**: Creates a `TempDir`, writes a malformed `config.toml` into that directory, obtains a configured command from `codex_command`, appends `app-server`, `--strict-config`, and `--listen off` arguments, executes the process, and asserts failure plus a stderr substring match. It returns `Ok(())` only if the command rejects the config as expected.

**Call relations**: This is the test entrypoint. It calls `codex_command` to prepare the subprocess, then relies on `assert_cmd` assertion chaining and `predicates::str::contains` to validate that startup fails specifically because of strict config parsing.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (new, contains, write).


### `cli/tests/delete.rs`

`test` · `command validation/error handling`

This file contains a single focused integration test that checks the CLI fails early on session lookup, before it ever reaches delete-confirmation logic. It creates a temporary `CODEX_HOME`, launches the compiled `codex` binary directly with `assert_cmd`, and requests deletion of a fixed UUID-like session identifier. The assertions are deliberately dual: stderr must contain the message indicating that no active or archived session matched the supplied identifier, and stderr must not contain the phrase `cannot confirm`. That negative assertion is the key behavior under test, because it proves the command does not proceed far enough to ask for or validate confirmation when the target session is missing. The test therefore locks down control-flow precedence in the delete command: existence checks happen before confirmation checks. No helper is needed because the setup is tiny and specific to this one scenario.

#### Function details

##### `missing_session_fails_before_delete_confirmation`  (lines 4–17)

```
fn missing_session_fails_before_delete_confirmation() -> anyhow::Result<()>
```

**Purpose**: Ensures `codex delete <id>` reports a missing session and does not emit confirmation-related errors when no matching session exists.

**Data flow**: Creates a temporary home directory, constructs an `assert_cmd::Command` for the `codex` binary, sets `CODEX_HOME`, passes the `delete` subcommand and a fixed session ID, executes the command, and asserts failure with one required stderr substring and one forbidden stderr substring. It returns success only if the command fails for the expected reason and in the expected phase.

**Call relations**: This is the sole test entrypoint in the file. It directly constructs the subprocess instead of using a helper because there is only one scenario, and it relies on predicate composition to verify both positive and negative stderr conditions.

*Call graph*: 4 external calls (new, cargo_bin, contains, tempdir).


### `cli/tests/exec_server.rs`

`test` · `startup/config validation`

This file mirrors the app-server strict-config test but targets the execution server entrypoint. It writes an invalid `config.toml` containing an unknown top-level field into a temporary `CODEX_HOME`, then invokes `codex exec-server --strict-config --listen http://127.0.0.1:0`. The expected outcome is immediate startup failure with stderr mentioning an unknown configuration field. Using a concrete listen URL keeps the invocation syntactically valid for the server command while still ensuring the test’s real subject is config parsing, not runtime request handling. The helper function encapsulates binary lookup and environment setup so the test body remains a concise statement of preconditions and expected failure. As with the app-server variant, this test protects against regressions where unknown config keys might be silently ignored or only rejected later in startup.

#### Function details

##### `codex_command`  (lines 7–11)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates a `codex` subprocess command configured with a caller-provided `CODEX_HOME`.

**Data flow**: Takes a path reference, resolves the built `codex` executable, constructs an `assert_cmd::Command`, sets the `CODEX_HOME` environment variable, and returns the command in a `Result`.

**Call relations**: The strict-config test calls this helper to avoid repeating binary resolution and environment wiring before adding `exec-server` arguments.

*Call graph*: called by 1 (strict_config_rejects_unknown_config_fields_for_exec_server); 2 external calls (new, cargo_bin).


##### `strict_config_rejects_unknown_config_fields_for_exec_server`  (lines 14–35)

```
fn strict_config_rejects_unknown_config_fields_for_exec_server() -> Result<()>
```

**Purpose**: Checks that `codex exec-server` rejects unknown configuration fields when `--strict-config` is enabled.

**Data flow**: Creates a temporary home directory, writes a `config.toml` containing `foo = "bar"`, obtains a command from `codex_command`, appends `exec-server`, `--strict-config`, and a loopback listen URL, executes the process, and asserts that it fails with stderr containing `unknown configuration field`.

**Call relations**: This test is the file’s main scenario and uses `codex_command` as setup. It delegates process execution and stderr matching to `assert_cmd` and `predicates`, focusing on the strict-config failure path.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (new, contains, write).


### `cli/tests/update.rs`

`test` · `CLI integration testing for debug-only update behavior`

This small integration test file exists specifically to pin down update-command behavior in debug builds. The helper `codex_command` creates an `assert_cmd::Command` for the built `codex` binary and injects a temporary `CODEX_HOME`, isolating the invocation from any real user state. The only test is compiled only when `debug_assertions` are enabled, matching the behavior it is asserting.

`update_does_not_start_interactive_prompt` creates a temporary home, runs `codex update`, and asserts failure with stderr containing the exact message ``codex update` is not available in debug builds`. The test is intentionally narrow: it does not inspect config or filesystem side effects because the contract being protected is that the command should stop before entering any interactive updater logic at all. In practice this guards against regressions where debug binaries accidentally expose production update flows or hang waiting for user interaction during automated test runs.

#### Function details

##### `codex_command`  (lines 6–10)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates an `assert_cmd::Command` for the `codex` executable with `CODEX_HOME` set to a temporary directory.

**Data flow**: It takes `codex_home`, resolves the binary path with `cargo_bin`, constructs the command, sets `CODEX_HOME`, and returns the configured command in a `Result`.

**Call relations**: The single test in this file calls it to launch `codex update` under isolated state.

*Call graph*: called by 1 (update_does_not_start_interactive_prompt); 2 external calls (new, cargo_bin).


##### `update_does_not_start_interactive_prompt`  (lines 14–24)

```
async fn update_does_not_start_interactive_prompt() -> Result<()>
```

**Purpose**: Verifies that `codex update` is unavailable in debug builds and fails with the expected message instead of entering an interactive updater flow.

**Data flow**: It creates a temporary home, invokes `codex update`, and asserts process failure with stderr containing the debug-build unavailability message.

**Call relations**: This async test is conditionally compiled under `debug_assertions` and uses `codex_command` to exercise the guarded update command path.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


### Debug and feature commands
These tests cover maintenance-oriented debug commands and the feature-management CLI, including output formats, persistence, and warnings.

### `cli/tests/debug_clear_memories.rs`

`test` · `maintenance command execution`

This file exercises the memory-reset maintenance command against real on-disk SQLite databases created under a temporary `CODEX_HOME`. Both async tests first initialize state with `codex_state::StateRuntime::init`, which creates the expected schema. The first test seeds the main state DB with a `threads` row, seeds the memories DB with `stage1_outputs` and memory-related `jobs`, creates a `memories/` directory containing a stale markdown file, closes both pools, then runs `codex debug clear-memories`. After the command succeeds and prints `Cleared memory state`, the test reconnects to the memories DB and confirms that `stage1_outputs` is empty, memory job rows are gone, and the `memories/` directory still exists but has been emptied rather than deleted. The second test covers a degraded environment: it inserts memory data, deletes the main state DB file entirely, runs the same command, and verifies the memories DB is still reset while the missing state DB is not recreated. These tests are concrete regression checks for cleanup scope, schema targeting, and resilience when only part of the persisted state is present.

#### Function details

##### `codex_command`  (lines 11–15)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Builds a `codex` subprocess command configured to use a specific temporary `CODEX_HOME`.

**Data flow**: Accepts a filesystem path, resolves the compiled `codex` binary, creates an `assert_cmd::Command`, injects `CODEX_HOME` into the child environment, and returns the configured command.

**Call relations**: Both async tests call this helper immediately before invoking `debug clear-memories`, so command setup is shared while database seeding remains local to each scenario.

*Call graph*: called by 2 (debug_clear_memories_resets_memories_db_without_state_db, debug_clear_memories_resets_state_and_removes_memory_dir); 2 external calls (new, cargo_bin).


##### `debug_clear_memories_resets_state_and_removes_memory_dir`  (lines 18–138)

```
async fn debug_clear_memories_resets_state_and_removes_memory_dir() -> Result<()>
```

**Purpose**: Checks that `debug clear-memories` wipes memory-related database contents and empties the memory artifact directory while preserving its existence.

**Data flow**: Creates a temp home, initializes state runtime, computes `state_db_path` and `memories_db_path`, opens `SqlitePool`s to both databases, inserts a thread into `threads`, inserts one memory summary row into `stage1_outputs`, inserts two completed memory job rows into `jobs`, creates `memories/memory_summary.md`, closes pools, runs `codex debug clear-memories`, reconnects to the memories DB, queries counts from `stage1_outputs` and filtered `jobs`, and asserts both are zero. It also reads the `memories/` directory and asserts the directory exists but contains no entries.

**Call relations**: This test is one of the two main consumers of `codex_command`. It delegates schema creation to `StateRuntime::init`, uses direct SQL inserts to establish preconditions the CLI should clean up, then validates the command’s effects through SQL queries and filesystem inspection.

*Call graph*: calls 2 internal fn (codex_command, init); 12 external calls (connect, new, assert!, assert_eq!, memories_db_path, state_db_path, format!, contains, query, query_scalar (+2 more)).


##### `debug_clear_memories_resets_memories_db_without_state_db`  (lines 141–189)

```
async fn debug_clear_memories_resets_memories_db_without_state_db() -> Result<()>
```

**Purpose**: Verifies that `debug clear-memories` still clears the memories database even if the primary state database file has been removed.

**Data flow**: Creates a temp home, initializes runtime to create databases, computes both DB paths, opens only the memories DB, inserts a `stage1_outputs` row, closes the pool, deletes the state DB file from disk, runs `codex debug clear-memories`, reconnects to the memories DB, queries the remaining `stage1_outputs` count, asserts it is zero, closes the pool, and finally asserts the deleted state DB file still does not exist.

**Call relations**: Like the previous test, this one calls `codex_command` after preparing on-disk state. Its distinguishing role is to prove the cleanup command tolerates a missing state DB and limits itself to clearing memory state rather than reconstructing unrelated persistence.

*Call graph*: calls 2 internal fn (codex_command, init); 11 external calls (connect, new, assert!, assert_eq!, memories_db_path, state_db_path, format!, contains, query, query_scalar (+1 more)).


### `cli/tests/debug_models.rs`

`test` · `debug command execution`

This file validates the shape and availability of model metadata exposed by the debug CLI. Each test runs the compiled `codex` binary in an isolated temporary home directory and captures raw process output instead of using predicate-based assertions. The stdout bytes are decoded as UTF-8, parsed into `serde_json::Value`, and then inspected for a `models` field that must be a non-empty JSON array. One test explicitly requests bundled models with `debug models --bundled`; the other exercises the default `debug models` path and confirms it succeeds without any authentication setup. The tests intentionally avoid asserting exact model contents, which would be brittle, and instead lock down the contract that the command returns syntactically valid JSON with at least one model entry. The shared helper ensures both tests execute the same binary with the same `CODEX_HOME` isolation, so differences in behavior come only from the CLI arguments.

#### Function details

##### `codex_command`  (lines 6–10)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates an `assert_cmd::Command` for the `codex` executable and scopes it to a temporary home directory.

**Data flow**: Receives `codex_home`, resolves the cargo-built `codex` binary path, constructs the command, sets `CODEX_HOME`, and returns the configured process handle.

**Call relations**: Both JSON-output tests call this helper before adding their specific `debug models` arguments and collecting process output.

*Call graph*: called by 2 (debug_models_bundled_prints_json, debug_models_default_prints_json_without_auth); 2 external calls (new, cargo_bin).


##### `debug_models_bundled_prints_json`  (lines 13–25)

```
fn debug_models_bundled_prints_json() -> Result<()>
```

**Purpose**: Confirms that `codex debug models --bundled` succeeds and prints JSON containing a non-empty `models` array.

**Data flow**: Creates a temp directory, builds a command with `codex_command`, runs it with `debug models --bundled`, captures `Output`, asserts successful exit status, converts stdout bytes to `String`, parses JSON into `serde_json::Value`, and checks that `value["models"]` is an array with at least one element.

**Call relations**: This test uses `codex_command` for process setup and then performs direct output parsing rather than assertion chaining, because it needs to validate JSON structure rather than a simple substring.

*Call graph*: calls 1 internal fn (codex_command); 4 external calls (from_utf8, new, assert!, from_str).


##### `debug_models_default_prints_json_without_auth`  (lines 28–40)

```
fn debug_models_default_prints_json_without_auth() -> Result<()>
```

**Purpose**: Confirms that the default `codex debug models` command works without prior login and returns the same basic JSON structure.

**Data flow**: Creates a temp home, invokes `codex_command`, runs `debug models`, captures stdout, asserts success, decodes stdout as UTF-8, parses it as JSON, and verifies the `models` field is a non-empty array.

**Call relations**: This test parallels `debug_models_bundled_prints_json` but covers the unauthenticated default path. It demonstrates that model listing is available without extra auth state and shares the same command-construction helper.

*Call graph*: calls 1 internal fn (codex_command); 4 external calls (from_utf8, new, assert!, from_str).


### `cli/tests/features.rs`

`test` · `feature command execution/config mutation`

This file groups several end-to-end tests around the `codex features` command family and one top-level strict-config behavior. A shared helper launches the compiled binary against a temporary `CODEX_HOME`. Two tests cover configuration validation: one proves `--strict-config -c foo=bar` is rejected for a normal command (`mcp-server`), while another proves the same flag is explicitly unsupported for `codex cloud list` and yields a dedicated error message. The feature mutation tests run `features enable unified_exec` and `features disable shell_tool`, then read back `config.toml` from disk to confirm a `[features]` table was written with `true` or `false` values respectively, in addition to checking the success message. Another test enables `runtime_metrics` and asserts that under-development features emit a warning on stderr. The final test captures `features list` output, splits each line on the aligned double-space separator, extracts feature names, and compares the observed order to a sorted clone, enforcing alphabetical presentation without hard-coding the feature set. Together these tests validate CLI UX, config persistence format, and stable output ordering.

#### Function details

##### `codex_command`  (lines 8–12)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates a reusable `codex` subprocess command rooted at a temporary `CODEX_HOME`.

**Data flow**: Accepts a path, resolves the cargo-built `codex` binary, constructs an `assert_cmd::Command`, sets `CODEX_HOME`, and returns the configured command.

**Call relations**: All six scenario tests in this file call this helper before adding their specific arguments, making command setup consistent across validation, mutation, and listing cases.

*Call graph*: called by 6 (features_disable_writes_feature_flag_to_config, features_enable_under_development_feature_prints_warning, features_enable_writes_feature_flag_to_config, features_list_is_sorted_alphabetically_by_feature_name, strict_config_is_not_supported_for_cloud_command, strict_config_rejects_unknown_config_override); 2 external calls (new, cargo_bin).


##### `strict_config_rejects_unknown_config_override`  (lines 15–25)

```
fn strict_config_rejects_unknown_config_override() -> Result<()>
```

**Purpose**: Checks that an unknown `-c` configuration override is rejected when `--strict-config` is used with a regular command.

**Data flow**: Creates a temp home, builds a command with `codex_command`, runs `--strict-config -c foo=bar mcp-server`, and asserts process failure with stderr containing `unknown configuration field`.

**Call relations**: This test uses the shared helper and focuses on strict override parsing rather than file-based config. It complements the server-specific strict-config tests elsewhere by covering command-line overrides.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


##### `strict_config_is_not_supported_for_cloud_command`  (lines 28–40)

```
fn strict_config_is_not_supported_for_cloud_command() -> Result<()>
```

**Purpose**: Verifies that `codex cloud` rejects `--strict-config` with a dedicated unsupported-message instead of attempting strict parsing.

**Data flow**: Creates a temp home, obtains a command from `codex_command`, runs `--strict-config -c foo=bar cloud list`, and asserts failure with stderr containing the explicit unsupported text for `codex cloud`.

**Call relations**: This test shares setup with the other strict-config case but validates a different control-flow branch: cloud commands short-circuit with a feature-support error rather than generic config-field validation.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


##### `features_enable_writes_feature_flag_to_config`  (lines 43–57)

```
async fn features_enable_writes_feature_flag_to_config() -> Result<()>
```

**Purpose**: Ensures `features enable` persists the selected feature as `true` in `config.toml` and reports success to the user.

**Data flow**: Creates a temp home, runs `codex features enable unified_exec`, asserts success and a stdout confirmation message, then reads `config.toml` from disk and checks that it contains both a `[features]` section and `unified_exec = true`.

**Call relations**: This test invokes the shared command helper and then validates the command’s side effect by reading the generated config file, tying CLI output to actual persisted state.

*Call graph*: calls 1 internal fn (codex_command); 4 external calls (new, assert!, contains, read_to_string).


##### `features_disable_writes_feature_flag_to_config`  (lines 60–74)

```
async fn features_disable_writes_feature_flag_to_config() -> Result<()>
```

**Purpose**: Ensures `features disable` persists the selected feature as `false` in `config.toml` and reports success.

**Data flow**: Creates a temp home, runs `codex features disable shell_tool`, asserts success and the expected stdout message, reads `config.toml`, and checks for a `[features]` table containing `shell_tool = false`.

**Call relations**: This test is the disable-path counterpart to `features_enable_writes_feature_flag_to_config`, using the same helper and file-readback pattern to verify persisted configuration.

*Call graph*: calls 1 internal fn (codex_command); 4 external calls (new, assert!, contains, read_to_string).


##### `features_enable_under_development_feature_prints_warning`  (lines 77–89)

```
async fn features_enable_under_development_feature_prints_warning() -> Result<()>
```

**Purpose**: Checks that enabling an under-development feature succeeds but emits a warning on stderr naming that feature.

**Data flow**: Creates a temp home, runs `codex features enable runtime_metrics`, and asserts successful exit plus stderr containing `Under-development features enabled: runtime_metrics.`.

**Call relations**: This test uses `codex_command` and focuses on user-facing warning behavior rather than file contents, covering a special-case branch in feature enabling.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


##### `features_list_is_sorted_alphabetically_by_feature_name`  (lines 92–119)

```
async fn features_list_is_sorted_alphabetically_by_feature_name() -> Result<()>
```

**Purpose**: Verifies that `features list` prints feature rows ordered alphabetically by feature name.

**Data flow**: Creates a temp home, runs `codex features list`, captures stdout bytes from the successful assertion result, decodes them to `String`, splits output into lines, extracts the feature name from each line by splitting on the aligned double-space separator, collects the names into a vector, clones and sorts that vector, and asserts the original order matches the sorted order.

**Call relations**: This test uses the shared helper but differs from the others by inspecting formatted listing output. It depends on the command’s column alignment convention to parse names and then enforces ordering as a presentation invariant.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (from_utf8, new, assert_eq!).


### Plugin marketplace workflows
These tests exercise plugin and marketplace command behavior from broad listing/install flows through marketplace source addition, removal, and upgrade paths.

### `cli/tests/plugin_cli.rs`

`test` · `Comprehensive CLI integration testing for plugin and marketplace workflows`

This is the main end-to-end test suite for the plugin subsystem’s CLI. It defines a large set of fixture builders that create temporary Codex homes, marketplace manifests, plugin manifests, and config entries. The helpers distinguish configured local marketplaces, unconfigured repo-local marketplaces, malformed or missing manifests, marketplaces with explicit empty product policies, and implicit system roots under bundled/runtime directories. `codex_command` and `codex_command_in` launch the built binary with isolated `CODEX_HOME`; `HOME` is also set so tests can control discovery of a home marketplace independently from Codex config.

The file validates marketplace listing in text and JSON forms, including how configured source metadata is attached by root, how home marketplaces appear, and how malformed or invalid configured marketplaces fail. It separately validates plugin listing, ensuring available plugins only appear in JSON with `--available`, installed plugins report enabled state and version, cached-but-unconfigured plugins hide version information, and unconfigured repo-local marketplaces are excluded from discovery. Installation/removal tests verify config mutations in `config.toml`, JSON result payloads, reinstall behavior, and removal after the marketplace itself has been deleted. Several tests pin down subtle policy decisions: configured marketplace snapshots are authoritative for plugin add, cached plugin files alone are insufficient after marketplace removal, implicit system roots without manifests are ignored, but custom marketplaces under those roots still error. The suite therefore documents both the happy path and many edge conditions around marketplace provenance and plugin authorization.

#### Function details

##### `marketplace_list_row`  (lines 16–22)

```
fn marketplace_list_row(marketplace_name: &str, root: &Path) -> String
```

**Purpose**: Formats one expected text-table row for marketplace listing output using the same column width as the `MARKETPLACE` header.

**Data flow**: It takes `marketplace_name` and `root`, interpolates them into a left-aligned string with width equal to `MARKETPLACE_HEADER.len()`, and returns the formatted row string.

**Call relations**: Several marketplace list tests call it to build exact expected substrings for stdout assertions, avoiding duplicated formatting logic in the tests.

*Call graph*: called by 3 (marketplace_list_includes_home_marketplace_when_present, marketplace_list_includes_root_when_plugins_are_filtered_out, marketplace_list_shows_configured_marketplace_names); 1 external calls (format!).


##### `codex_command`  (lines 24–29)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Constructs an `assert_cmd::Command` for the `codex` binary with both `CODEX_HOME` and `HOME` pointed at the test home by default.

**Data flow**: It accepts `codex_home`, resolves the binary path, creates the command, sets `CODEX_HOME`, sets `HOME` to the same path, and returns the configured command.

**Call relations**: Most tests in the file call this helper directly. Setting `HOME` here makes home-marketplace discovery deterministic unless a test overrides `HOME` explicitly.

*Call graph*: called by 29 (codex_command_in, marketplace_list_fails_when_configured_local_marketplace_source_is_missing, marketplace_list_fails_when_configured_marketplace_name_is_invalid, marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed, marketplace_list_fails_when_configured_marketplace_snapshot_is_missing, marketplace_list_fails_when_home_marketplace_is_malformed, marketplace_list_includes_home_marketplace_when_present, marketplace_list_includes_root_when_plugins_are_filtered_out, marketplace_list_json_includes_configured_git_marketplace_source, marketplace_list_json_keys_configured_source_by_root (+15 more)); 2 external calls (new, cargo_bin).


##### `codex_command_in`  (lines 31–35)

```
fn codex_command_in(codex_home: &Path, current_dir: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates a Codex command like `codex_command` but also fixes the process current working directory.

**Data flow**: It takes `codex_home` and `current_dir`, obtains a command from `codex_command`, sets `.current_dir(current_dir)`, and returns it.

**Call relations**: The tests for unconfigured repo-local marketplaces use this helper so the CLI runs inside the marketplace source tree and can prove that repo-local discovery is not enough for configured plugin operations.

*Call graph*: calls 1 internal fn (codex_command); called by 2 (plugin_add_rejects_unconfigured_repo_local_marketplaces, plugin_list_excludes_unconfigured_repo_local_marketplaces).


##### `configured_local_marketplace`  (lines 37–46)

```
fn configured_local_marketplace(source: &str) -> MarketplaceConfigUpdate<'_>
```

**Purpose**: Builds a reusable `MarketplaceConfigUpdate` fixture for a local marketplace source path.

**Data flow**: It takes a source string and returns `MarketplaceConfigUpdate` with fixed timestamp, `source_type: "local"`, the supplied `source`, no `ref_name`, and empty `sparse_paths`.

**Call relations**: Multiple setup helpers call it before passing the result to `record_user_marketplace`, centralizing the shape of configured local marketplace entries.

*Call graph*: called by 6 (setup_configured_marketplace_with_malformed_manifest, setup_configured_marketplace_without_manifest, setup_custom_marketplace_under_implicit_system_root, setup_local_marketplace, setup_local_marketplace_with_explicit_empty_products, setup_local_marketplace_with_implicit_system_roots).


##### `write_plugins_enabled_config`  (lines 48–56)

```
fn write_plugins_enabled_config(codex_home: &Path) -> Result<()>
```

**Purpose**: Writes a minimal `config.toml` that enables the plugin feature flag.

**Data flow**: It takes `codex_home`, writes `[features]
plugins = true
` to `CONFIG_TOML_FILE` under that directory, and returns `Ok(())`.

**Call relations**: Most setup helpers call this before creating marketplaces so plugin-related CLI commands run with plugins enabled.

*Call graph*: called by 11 (marketplace_list_fails_when_home_marketplace_is_malformed, marketplace_list_includes_home_marketplace_when_present, marketplace_list_json_includes_configured_git_marketplace_source, marketplace_list_json_keys_configured_source_by_root, plugin_list_json_includes_configured_git_marketplace_source, setup_configured_marketplace_with_malformed_manifest, setup_configured_marketplace_without_manifest, setup_custom_marketplace_under_implicit_system_root, setup_local_marketplace, setup_local_marketplace_with_explicit_empty_products (+1 more)); 2 external calls (join, write).


##### `write_marketplace_source_with_manifest`  (lines 58–77)

```
fn write_marketplace_source_with_manifest(source: &Path, marketplace_manifest: &str) -> Result<()>
```

**Purpose**: Creates a marketplace directory tree and writes caller-supplied marketplace manifest contents plus a fixed sample plugin manifest.

**Data flow**: It takes `source` and `marketplace_manifest`, creates `.agents/plugins` and `plugins/sample/.codex-plugin`, writes the provided marketplace JSON to `.agents/plugins/marketplace.json`, writes a fixed plugin manifest containing name `sample`, version `1.2.3`, and description `Sample plugin`, and returns `Ok(())`.

**Call relations**: The two marketplace-writing helpers delegate to this function so tests can vary only the marketplace manifest while reusing the same plugin fixture.

*Call graph*: called by 2 (write_marketplace_source, write_marketplace_source_with_explicit_empty_products); 3 external calls (join, create_dir_all, write).


##### `write_marketplace_source`  (lines 79–95)

```
fn write_marketplace_source(source: &Path) -> Result<()>
```

**Purpose**: Creates the standard valid marketplace fixture used by most plugin and marketplace tests.

**Data flow**: It takes a source path and delegates to `write_marketplace_source_with_manifest` with a manifest naming marketplace `debug` and one local plugin source at `./plugins/sample`.

**Call relations**: Many setup helpers and direct tests call it to create a normal marketplace snapshot before recording config or invoking the CLI.

*Call graph*: calls 1 internal fn (write_marketplace_source_with_manifest); called by 6 (marketplace_list_includes_home_marketplace_when_present, marketplace_list_json_includes_configured_git_marketplace_source, marketplace_list_json_keys_configured_source_by_root, plugin_list_json_includes_configured_git_marketplace_source, setup_local_marketplace, setup_unconfigured_local_marketplace).


##### `write_marketplace_source_with_explicit_empty_products`  (lines 97–116)

```
fn write_marketplace_source_with_explicit_empty_products(source: &Path) -> Result<()>
```

**Purpose**: Creates a valid marketplace fixture whose plugin policy explicitly sets an empty `products` list.

**Data flow**: It takes a source path and delegates to `write_marketplace_source_with_manifest` with a manifest identical to the standard one except for `policy.products: []` on the sample plugin.

**Call relations**: Only the setup helper for the filtered-products scenario calls this, allowing one test to verify marketplace roots still appear even when no plugins are installable.

*Call graph*: calls 1 internal fn (write_marketplace_source_with_manifest); called by 1 (setup_local_marketplace_with_explicit_empty_products).


##### `setup_local_marketplace`  (lines 118–130)

```
fn setup_local_marketplace() -> Result<(TempDir, TempDir)>
```

**Purpose**: Builds the standard configured local marketplace test fixture and returns both the Codex home and marketplace source tempdirs.

**Data flow**: It creates temporary `codex_home` and `source` directories, writes plugin-enabled config, writes the standard marketplace source, converts the source path to an owned string, records marketplace `debug` in config using `record_user_marketplace` and `configured_local_marketplace`, and returns `(codex_home, source)`.

**Call relations**: This is the primary fixture factory for success-path tests covering marketplace listing, plugin listing, plugin add/remove, reinstall, and cached-plugin behavior.

*Call graph*: calls 3 internal fn (configured_local_marketplace, write_marketplace_source, write_plugins_enabled_config); called by 15 (marketplace_list_json_prints_configured_marketplaces, marketplace_list_shows_configured_marketplace_names, plugin_add_and_remove_updates_installed_plugin_config, plugin_add_json_prints_install_outcome, plugin_add_reinstalls_from_configured_marketplace_snapshot, plugin_add_rejects_cached_plugins_without_authorizing_marketplace_snapshot, plugin_list_available_requires_json, plugin_list_hides_version_for_cached_but_unconfigured_plugin, plugin_list_json_prints_available_plugins_when_requested, plugin_list_json_prints_installed_plugins (+5 more)); 2 external calls (new, record_user_marketplace).


##### `setup_unconfigured_local_marketplace`  (lines 132–138)

```
fn setup_unconfigured_local_marketplace() -> Result<(TempDir, TempDir)>
```

**Purpose**: Creates a valid local marketplace on disk without recording it in Codex config.

**Data flow**: It creates temporary `codex_home` and `source`, writes plugin-enabled config, writes the standard marketplace source, and returns both tempdirs without calling `record_user_marketplace`.

**Call relations**: Tests that prove unconfigured repo-local marketplaces are excluded from plugin discovery or installation call this helper.

*Call graph*: calls 2 internal fn (write_marketplace_source, write_plugins_enabled_config); called by 2 (plugin_add_rejects_unconfigured_repo_local_marketplaces, plugin_list_excludes_unconfigured_repo_local_marketplaces); 1 external calls (new).


##### `setup_local_marketplace_with_explicit_empty_products`  (lines 140–152)

```
fn setup_local_marketplace_with_explicit_empty_products() -> Result<(TempDir, TempDir)>
```

**Purpose**: Creates a configured local marketplace whose plugin manifest policy filters out all products.

**Data flow**: It creates temporary home and source directories, writes plugin-enabled config, writes the explicit-empty-products marketplace source, records marketplace `debug` as a configured local marketplace, and returns `(codex_home, source)`.

**Call relations**: The marketplace list test for filtered-out plugins uses this helper to show that marketplace roots are still listed even when no plugins survive policy filtering.

*Call graph*: calls 3 internal fn (configured_local_marketplace, write_marketplace_source_with_explicit_empty_products, write_plugins_enabled_config); called by 1 (marketplace_list_includes_root_when_plugins_are_filtered_out); 2 external calls (new, record_user_marketplace).


##### `setup_configured_marketplace_without_manifest`  (lines 154–165)

```
fn setup_configured_marketplace_without_manifest() -> Result<(TempDir, TempDir)>
```

**Purpose**: Creates a configured local marketplace entry whose source directory lacks any marketplace manifest.

**Data flow**: It creates temporary home and source directories, writes plugin-enabled config, records marketplace `debug` pointing at the empty source directory, and returns both tempdirs.

**Call relations**: Failure tests for marketplace and plugin listing call this helper to drive the missing-manifest error path for configured marketplace snapshots.

*Call graph*: calls 2 internal fn (configured_local_marketplace, write_plugins_enabled_config); called by 2 (marketplace_list_fails_when_configured_marketplace_snapshot_is_missing, plugin_list_fails_when_configured_marketplace_snapshot_is_missing); 2 external calls (new, record_user_marketplace).


##### `setup_configured_marketplace_with_malformed_manifest`  (lines 167–187)

```
fn setup_configured_marketplace_with_malformed_manifest() -> Result<(TempDir, TempDir)>
```

**Purpose**: Creates a configured local marketplace entry whose `marketplace.json` exists but contains invalid JSON.

**Data flow**: It creates temporary home and source directories, writes plugin-enabled config, creates `.agents/plugins`, writes `{not valid json` to `marketplace.json`, records marketplace `debug` pointing at that source, and returns both tempdirs.

**Call relations**: Malformed-snapshot tests for marketplace listing and plugin add use this helper to trigger parse failures while keeping the marketplace configured.

*Call graph*: calls 2 internal fn (configured_local_marketplace, write_plugins_enabled_config); called by 2 (marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed, plugin_add_fails_when_configured_marketplace_snapshot_is_malformed); 4 external calls (new, record_user_marketplace, create_dir_all, write).


##### `setup_local_marketplace_with_implicit_system_roots`  (lines 189–221)

```
fn setup_local_marketplace_with_implicit_system_roots() -> Result<(TempDir, TempDir, TempDir)>
```

**Purpose**: Creates one normal configured marketplace plus two additional configured marketplaces under implicit bundled/runtime system root patterns.

**Data flow**: It starts from `setup_local_marketplace`, creates a bundled root under `codex_home/.tmp/bundled-marketplaces/openai-bundled`, records it as a configured local marketplace, creates a separate `cache_home` tempdir with a runtime root under `codex-runtimes/.../plugins/openai-primary-runtime`, records that as another configured local marketplace, and returns `(codex_home, source, cache_home)`.

**Call relations**: The plugin list test for implicit system roots uses this helper to prove missing manifests under recognized system-root names are ignored rather than treated as fatal snapshot failures.

*Call graph*: calls 2 internal fn (configured_local_marketplace, setup_local_marketplace); called by 1 (plugin_list_ignores_implicit_system_marketplace_roots_without_manifests); 3 external calls (new, record_user_marketplace, create_dir_all).


##### `setup_custom_marketplace_under_implicit_system_root`  (lines 223–241)

```
fn setup_custom_marketplace_under_implicit_system_root() -> Result<(TempDir, std::path::PathBuf)>
```

**Purpose**: Creates a configured marketplace under the bundled-marketplaces directory pattern but with a custom name that should not receive implicit-system-root leniency.

**Data flow**: It creates a temporary home, writes plugin-enabled config, creates `.tmp/bundled-marketplaces/custom-marketplace`, records that path as a configured local marketplace named `custom-marketplace`, and returns `(codex_home, custom_root)`.

**Call relations**: The corresponding failure test uses this helper to show that only recognized implicit system marketplaces are ignored when missing manifests; custom ones still produce errors.

*Call graph*: calls 2 internal fn (configured_local_marketplace, write_plugins_enabled_config); called by 1 (plugin_list_fails_for_custom_marketplace_under_system_root); 3 external calls (new, record_user_marketplace, create_dir_all).


##### `remove_installed_plugin_config`  (lines 243–265)

```
fn remove_installed_plugin_config(codex_home: &Path, plugin_key: &str) -> Result<()>
```

**Purpose**: Deletes a specific `[plugins."..."]` section from `config.toml` while leaving the rest of the file intact.

**Data flow**: It takes `codex_home` and `plugin_key`, reads `CONFIG_TOML_FILE` as text, computes the exact plugin section header string, iterates line-by-line while toggling a `skipping` flag from that header until the next section header, collects all non-skipped lines, rewrites the config file with the remaining lines plus a trailing newline, and returns `Ok(())`.

**Call relations**: Only the cached-but-unconfigured plugin test calls this helper after installing a plugin, creating the state where plugin files remain cached on disk but the plugin is no longer configured.

*Call graph*: called by 1 (plugin_list_hides_version_for_cached_but_unconfigured_plugin); 5 external calls (join, new, format!, read_to_string, write).


##### `setup_configured_local_marketplace_with_missing_source`  (lines 267–279)

```
fn setup_configured_local_marketplace_with_missing_source() -> Result<TempDir>
```

**Purpose**: Creates a malformed config entry for a local marketplace that omits the required `source` field.

**Data flow**: It creates a temporary home, writes a `config.toml` containing `[features] plugins = true` and `[marketplaces.debug] source_type = "local"` but no `source`, and returns the tempdir.

**Call relations**: The marketplace list failure test for missing local source uses this helper to trigger config-validation logic before any filesystem lookup.

*Call graph*: called by 1 (marketplace_list_fails_when_configured_local_marketplace_source_is_missing); 2 external calls (new, write).


##### `setup_configured_local_marketplace_with_invalid_name`  (lines 281–294)

```
fn setup_configured_local_marketplace_with_invalid_name() -> Result<TempDir>
```

**Purpose**: Creates a malformed config entry whose marketplace table key contains an invalid marketplace name (`bad/name`).

**Data flow**: It creates a temporary home and writes a `config.toml` enabling plugins and defining `[marketplaces."bad/name"]` with `source_type = "local"` and `source = "/tmp/debug"`, then returns the tempdir.

**Call relations**: The invalid-name marketplace list test uses this helper to exercise marketplace-name validation on configured entries.

*Call graph*: called by 1 (marketplace_list_fails_when_configured_marketplace_name_is_invalid); 2 external calls (new, write).


##### `assert_configured_marketplace_snapshot_failure`  (lines 296–309)

```
fn assert_configured_marketplace_snapshot_failure(
    assert: assert_cmd::assert::Assert,
    source: &Path,
    detail: &str,
)
```

**Purpose**: Encapsulates the common stderr assertions for failures loading configured marketplace snapshots.

**Data flow**: It takes an `assert_cmd::assert::Assert`, a `source` path, and a detail string, then chains assertions requiring failure and stderr substrings for the configured-snapshot failure prefix, marketplace name ``debug``, the source path display string, and the supplied detail.

**Call relations**: Two plugin-oriented failure tests call this helper to keep their malformed/missing configured-snapshot assertions consistent.

*Call graph*: called by 2 (plugin_add_fails_when_configured_marketplace_snapshot_is_malformed, plugin_list_fails_when_configured_marketplace_snapshot_is_missing); 3 external calls (failure, display, contains).


##### `assert_marketplace_failure`  (lines 311–323)

```
fn assert_marketplace_failure(
    assert: assert_cmd::assert::Assert,
    marketplace_name: &str,
    source: &Path,
    detail: &str,
)
```

**Purpose**: Encapsulates the common stderr assertions for failures loading marketplaces in general, parameterized by marketplace name and source path.

**Data flow**: It takes an `Assert`, `marketplace_name`, `source`, and `detail`, then asserts failure and stderr substrings for the generic marketplace-load failure prefix, the formatted marketplace name in backticks, the source path display string, and the supplied detail.

**Call relations**: Marketplace list failure tests call this helper for invalid names, missing manifests, and malformed manifests.

*Call graph*: called by 3 (marketplace_list_fails_when_configured_marketplace_name_is_invalid, marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed, marketplace_list_fails_when_configured_marketplace_snapshot_is_missing); 4 external calls (failure, display, format!, contains).


##### `marketplace_list_shows_configured_marketplace_names`  (lines 326–339)

```
async fn marketplace_list_shows_configured_marketplace_names() -> Result<()>
```

**Purpose**: Verifies text-mode marketplace listing shows the configured marketplace name and root in a space-aligned table without tab characters.

**Data flow**: It creates the standard configured marketplace fixture, computes the expected row with `marketplace_list_row`, runs `codex plugin marketplace list`, and asserts stdout contains the table header, the expected row, and no tab characters.

**Call relations**: This async test uses the standard fixture and row formatter to validate the human-readable marketplace list output.

*Call graph*: calls 3 internal fn (codex_command, marketplace_list_row, setup_local_marketplace); 1 external calls (contains).


##### `marketplace_list_json_prints_configured_marketplaces`  (lines 342–370)

```
async fn marketplace_list_json_prints_configured_marketplaces() -> Result<()>
```

**Purpose**: Checks the JSON representation of a configured local marketplace in `plugin marketplace list --json`.

**Data flow**: It creates the standard configured marketplace fixture, captures stdout from `plugin marketplace list --json`, parses it as `serde_json::Value`, and asserts equality with an object containing one marketplace entry with `name`, `root`, and `marketplaceSource { sourceType: "local", source: <path> }`.

**Call relations**: This async test is the JSON counterpart to the basic marketplace list text test, using the same fixture but validating structured output.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert_eq!, from_slice).


##### `marketplace_list_json_includes_configured_git_marketplace_source`  (lines 373–417)

```
async fn marketplace_list_json_includes_configured_git_marketplace_source() -> Result<()>
```

**Purpose**: Verifies that a configured git marketplace is listed with its normalized root path and git source metadata in JSON output.

**Data flow**: It creates a temporary home and marketplace root under `.tmp/marketplaces/debug`, enables plugins, writes a valid marketplace snapshot there, records a git `MarketplaceConfigUpdate`, normalizes the root path, runs `plugin marketplace list --json`, parses stdout, and asserts the JSON includes `marketplaceSource { sourceType: "git", source: <repo-url> }` alongside the normalized root.

**Call relations**: This async test bypasses the local-marketplace setup helper to create a git-configured marketplace and validate that list output reflects configured source provenance rather than local path provenance.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, write_plugins_enabled_config); 5 external calls (new, assert_eq!, record_user_marketplace, canonicalize_existing_preserving_symlinks, from_slice).


##### `marketplace_list_json_keys_configured_source_by_root`  (lines 420–471)

```
async fn marketplace_list_json_keys_configured_source_by_root() -> Result<()>
```

**Purpose**: Checks that configured source metadata is attached only to the marketplace entry whose root matches the configured marketplace root, even when another marketplace with the same name is discovered from `HOME`.

**Data flow**: It creates separate temporary Codex home and `HOME` directories, writes valid marketplace snapshots in both the home directory and `.tmp/marketplaces/debug`, records a git marketplace config for the latter, normalizes the configured root, runs `plugin marketplace list --json` with `HOME` overridden, parses stdout, and asserts the JSON contains two `debug` entries: one for the home root without `marketplaceSource`, and one for the configured root with git source metadata.

**Call relations**: This async test exercises a subtle merge/discovery rule: source metadata is keyed by root, not just marketplace name.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, write_plugins_enabled_config); 5 external calls (new, assert_eq!, record_user_marketplace, canonicalize_existing_preserving_symlinks, from_slice).


##### `marketplace_list_includes_home_marketplace_when_present`  (lines 474–491)

```
async fn marketplace_list_includes_home_marketplace_when_present() -> Result<()>
```

**Purpose**: Verifies that a marketplace discovered from the user `HOME` directory appears in text-mode marketplace listing.

**Data flow**: It creates temporary Codex home and separate `HOME` directories, writes a valid marketplace under `HOME`, enables plugins in Codex config, computes the expected row, runs `plugin marketplace list` with `HOME` overridden, and asserts stdout contains the header, expected row, and no tabs.

**Call relations**: This async test uses direct fixture creation rather than configured marketplace setup to validate home-directory marketplace discovery.

*Call graph*: calls 4 internal fn (codex_command, marketplace_list_row, write_marketplace_source, write_plugins_enabled_config); 2 external calls (new, contains).


##### `marketplace_list_includes_root_when_plugins_are_filtered_out`  (lines 494–506)

```
async fn marketplace_list_includes_root_when_plugins_are_filtered_out() -> Result<()>
```

**Purpose**: Ensures marketplace listing still shows a marketplace root even when plugin policy filtering leaves no installable plugins.

**Data flow**: It creates a configured marketplace fixture with explicit empty products, computes the expected row, runs `plugin marketplace list`, and asserts stdout contains the header and row.

**Call relations**: This async test targets a subtle behavior: marketplace visibility is independent of whether any plugins remain after policy filtering.

*Call graph*: calls 3 internal fn (codex_command, marketplace_list_row, setup_local_marketplace_with_explicit_empty_products); 1 external calls (contains).


##### `marketplace_list_fails_when_configured_marketplace_snapshot_is_missing`  (lines 509–522)

```
async fn marketplace_list_fails_when_configured_marketplace_snapshot_is_missing() -> Result<()>
```

**Purpose**: Checks that marketplace listing fails with a detailed error when a configured marketplace root lacks a supported manifest.

**Data flow**: It creates a configured marketplace pointing at an empty directory, runs `plugin marketplace list`, and passes the resulting assertion object to `assert_marketplace_failure` with the expected marketplace name, source path, and missing-manifest detail.

**Call relations**: This async test uses the missing-manifest fixture and shared assertion helper to validate the configured-snapshot failure path for marketplace listing.

*Call graph*: calls 3 internal fn (assert_marketplace_failure, codex_command, setup_configured_marketplace_without_manifest).


##### `marketplace_list_fails_when_configured_marketplace_name_is_invalid`  (lines 525–538)

```
async fn marketplace_list_fails_when_configured_marketplace_name_is_invalid() -> Result<()>
```

**Purpose**: Verifies that an invalid configured marketplace name causes marketplace listing to fail with a validation-oriented error.

**Data flow**: It creates a temp home whose config contains marketplace key `bad/name`, runs `plugin marketplace list`, and feeds the assertion into `assert_marketplace_failure` with marketplace name `bad/name`, synthetic source path `<invalid config>`, and detail `marketplace name`.

**Call relations**: This async test exercises config validation before marketplace loading, using the generic marketplace-failure assertion helper.

*Call graph*: calls 3 internal fn (assert_marketplace_failure, codex_command, setup_configured_local_marketplace_with_invalid_name); 1 external calls (new).


##### `marketplace_list_fails_when_configured_local_marketplace_source_is_missing`  (lines 541–557)

```
async fn marketplace_list_fails_when_configured_local_marketplace_source_is_missing() -> Result<()>
```

**Purpose**: Ensures a configured local marketplace entry without a `source` field fails with a specific invalid-source diagnostic.

**Data flow**: It creates malformed config via the dedicated setup helper, runs `plugin marketplace list`, and asserts failure with stderr containing the generic marketplace-load prefix, marketplace name `debug`, placeholder source `<invalid source>`, and the missing-or-empty-source message.

**Call relations**: This async test covers a distinct malformed-config branch not handled by the generic assertion helpers because the source placeholder is synthetic.

*Call graph*: calls 2 internal fn (codex_command, setup_configured_local_marketplace_with_missing_source); 1 external calls (contains).


##### `marketplace_list_fails_when_home_marketplace_is_malformed`  (lines 560–582)

```
async fn marketplace_list_fails_when_home_marketplace_is_malformed() -> Result<()>
```

**Purpose**: Checks that a malformed marketplace manifest discovered from `HOME` causes marketplace listing to fail and reports the manifest path and parse error.

**Data flow**: It creates temporary Codex home and `HOME`, enables plugins, creates `HOME/.agents/plugins`, writes invalid JSON to `marketplace.json`, runs `plugin marketplace list` with `HOME` overridden, and asserts stderr contains the marketplace-load failure prefix, the malformed manifest path, and the JSON parse detail `key must be a string`.

**Call relations**: This async test validates that home-discovered marketplaces are parsed and surfaced through the same failure reporting path as configured marketplaces.

*Call graph*: calls 2 internal fn (codex_command, write_plugins_enabled_config); 4 external calls (new, contains, create_dir_all, write).


##### `marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed`  (lines 585–598)

```
async fn marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed() -> Result<()>
```

**Purpose**: Verifies that marketplace listing fails with parse details when a configured marketplace manifest contains invalid JSON.

**Data flow**: It creates a configured marketplace with malformed `marketplace.json`, runs `plugin marketplace list`, and passes the assertion to `assert_marketplace_failure` with marketplace `debug`, the source path, and parse detail `key must be a string`.

**Call relations**: This async test is the malformed-manifest counterpart to the missing-manifest test, using the shared marketplace failure helper.

*Call graph*: calls 3 internal fn (assert_marketplace_failure, codex_command, setup_configured_marketplace_with_malformed_manifest).


##### `plugin_list_prints_plugins_in_a_table`  (lines 601–625)

```
async fn plugin_list_prints_plugins_in_a_table() -> Result<()>
```

**Purpose**: Checks the human-readable `plugin list` output for an available-but-not-installed plugin from a configured marketplace.

**Data flow**: It creates the standard configured marketplace fixture, computes the marketplace manifest path and plugin path, runs `codex plugin list`, and asserts stdout contains the marketplace heading, table headers (`PLUGIN`, `STATUS`, `VERSION`, `PATH`), the manifest path, plugin ID `sample@debug`, status `not installed`, and the plugin source path.

**Call relations**: This async test validates the default text rendering of available plugins discovered from configured marketplaces.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 1 external calls (contains).


##### `plugin_list_json_prints_available_plugins_when_requested`  (lines 628–668)

```
async fn plugin_list_json_prints_available_plugins_when_requested() -> Result<()>
```

**Purpose**: Verifies that `plugin list --available --json` returns available plugins with full metadata, including marketplace source provenance and policy fields.

**Data flow**: It creates the standard configured marketplace fixture, computes plugin and source paths, runs `plugin list --available --json`, parses stdout as JSON, and asserts equality with an object containing an empty `installed` array and one `available` entry describing `sample@debug`, version `1.2.3`, disabled/not-installed state, local plugin source path, local marketplace source, `installPolicy: "AVAILABLE"`, and `authPolicy: "ON_INSTALL"`.

**Call relations**: This async test covers the machine-readable available-plugin listing path, which is distinct from the default text-mode list.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert_eq!, from_slice).


##### `plugin_list_json_includes_configured_git_marketplace_source`  (lines 671–727)

```
async fn plugin_list_json_includes_configured_git_marketplace_source() -> Result<()>
```

**Purpose**: Checks that available plugin JSON includes git marketplace provenance when the marketplace is configured from a git source.

**Data flow**: It creates a temporary home and marketplace root under `.tmp/marketplaces/debug`, enables plugins, writes a valid marketplace snapshot, records a git marketplace config, normalizes the plugin path, runs `plugin list --available --json`, parses stdout, and asserts the available plugin entry includes the normalized local plugin path plus `marketplaceSource { sourceType: "git", source: <repo-url> }`.

**Call relations**: This async test mirrors the local-source available-plugin JSON test but proves marketplace provenance comes from config and can differ from the plugin’s local on-disk source path.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, write_plugins_enabled_config); 5 external calls (new, assert_eq!, record_user_marketplace, canonicalize_existing_preserving_symlinks, from_slice).


##### `plugin_list_json_prints_installed_plugins`  (lines 730–775)

```
async fn plugin_list_json_prints_installed_plugins() -> Result<()>
```

**Purpose**: Verifies that after installation, `plugin list --json` reports the plugin under `installed` with `installed: true` and `enabled: true`.

**Data flow**: It creates the standard configured marketplace fixture, computes plugin and source paths, runs `plugin add sample@debug`, then runs `plugin list --json`, parses stdout, and asserts equality with an object containing one installed plugin entry and an empty `available` array.

**Call relations**: This async test composes plugin installation with subsequent listing to validate the installed-plugin JSON branch.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert_eq!, from_slice).


##### `plugin_list_available_requires_json`  (lines 778–791)

```
async fn plugin_list_available_requires_json() -> Result<()>
```

**Purpose**: Ensures the `--available` flag cannot be used without `--json` on `plugin list`.

**Data flow**: It creates the standard configured marketplace fixture, runs `plugin list --available`, and asserts failure with stderr mentioning missing required arguments and specifically `--json`.

**Call relations**: This async test validates CLI argument constraints rather than marketplace or plugin state.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 1 external calls (contains).


##### `plugin_list_shows_installed_version_when_plugin_is_installed`  (lines 794–811)

```
async fn plugin_list_shows_installed_version_when_plugin_is_installed() -> Result<()>
```

**Purpose**: Checks that text-mode `plugin list` shows the installed plugin’s version and enabled status after installation.

**Data flow**: It creates the standard configured marketplace fixture, runs `plugin add sample@debug`, then runs `plugin list` and asserts stdout contains `sample@debug`, version `1.2.3`, and status text `installed, enabled`.

**Call relations**: This async test is the text-output counterpart to the installed-plugin JSON test.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 1 external calls (contains).


##### `plugin_list_excludes_unconfigured_repo_local_marketplaces`  (lines 814–825)

```
async fn plugin_list_excludes_unconfigured_repo_local_marketplaces() -> Result<()>
```

**Purpose**: Verifies that running inside a repository containing a marketplace does not make that marketplace eligible for plugin listing unless it is configured.

**Data flow**: It creates an unconfigured local marketplace fixture, runs `plugin list --marketplace debug` from within the source directory using `codex_command_in`, and asserts success with stdout saying no plugins were found in marketplace `debug` and not matching `sample@debug`.

**Call relations**: This async test uses the current-directory helper to prove repo-local discovery is intentionally excluded from plugin listing unless the marketplace is configured.

*Call graph*: calls 2 internal fn (codex_command_in, setup_unconfigured_local_marketplace); 2 external calls (contains, is_match).


##### `plugin_list_fails_when_configured_marketplace_snapshot_is_missing`  (lines 828–840)

```
async fn plugin_list_fails_when_configured_marketplace_snapshot_is_missing() -> Result<()>
```

**Purpose**: Checks that `plugin list` fails with the configured-snapshot error format when a configured marketplace root lacks a manifest.

**Data flow**: It creates a configured marketplace pointing at an empty directory, runs `plugin list`, and passes the assertion to `assert_configured_marketplace_snapshot_failure` with the source path and missing-manifest detail.

**Call relations**: This async test parallels the marketplace-list missing-snapshot case but validates the plugin-list-specific error prefix and wording.

*Call graph*: calls 3 internal fn (assert_configured_marketplace_snapshot_failure, codex_command, setup_configured_marketplace_without_manifest).


##### `plugin_list_ignores_implicit_system_marketplace_roots_without_manifests`  (lines 843–866)

```
async fn plugin_list_ignores_implicit_system_marketplace_roots_without_manifests() -> Result<()>
```

**Purpose**: Ensures missing manifests under recognized implicit system marketplace roots do not cause `plugin list` to fail.

**Data flow**: It creates one normal configured marketplace plus bundled/runtime implicit system roots without manifests, runs `plugin list` with `XDG_CACHE_HOME` pointed at the runtime cache tempdir, and asserts success with output for the normal `debug` marketplace while stderr does not contain the configured-snapshot failure prefix.

**Call relations**: This async test uses the specialized implicit-system-root fixture to validate a leniency rule for known system-managed marketplace locations.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace_with_implicit_system_roots); 1 external calls (contains).


##### `plugin_list_fails_for_custom_marketplace_under_system_root`  (lines 869–886)

```
async fn plugin_list_fails_for_custom_marketplace_under_system_root() -> Result<()>
```

**Purpose**: Verifies that a custom configured marketplace placed under a system-root-like directory still fails if it lacks a manifest.

**Data flow**: It creates a configured custom marketplace under `.tmp/bundled-marketplaces/custom-marketplace`, runs `plugin list`, and asserts failure with stderr containing the configured-snapshot failure prefix, marketplace name, custom root path, and missing-manifest detail.

**Call relations**: This async test complements the previous one by showing the ignore rule is selective and does not apply to arbitrary custom marketplace names.

*Call graph*: calls 2 internal fn (codex_command, setup_custom_marketplace_under_implicit_system_root); 1 external calls (contains).


##### `plugin_list_hides_version_for_cached_but_unconfigured_plugin`  (lines 889–908)

```
async fn plugin_list_hides_version_for_cached_but_unconfigured_plugin() -> Result<()>
```

**Purpose**: Checks that if plugin files remain cached on disk but the plugin config entry is removed, `plugin list` treats it as not installed and suppresses the cached version.

**Data flow**: It creates the standard configured marketplace fixture, installs `sample@debug`, removes its `[plugins."sample@debug"]` section from config via `remove_installed_plugin_config`, runs `plugin list`, and asserts stdout contains the plugin ID and `not installed` but does not contain version `1.2.3`.

**Call relations**: This async test creates a deliberately inconsistent state to prove installation status is driven by config authorization, not merely by cached files.

*Call graph*: calls 3 internal fn (codex_command, remove_installed_plugin_config, setup_local_marketplace); 1 external calls (contains).


##### `plugin_add_and_remove_updates_installed_plugin_config`  (lines 911–935)

```
async fn plugin_add_and_remove_updates_installed_plugin_config() -> Result<()>
```

**Purpose**: Verifies that `plugin add` creates a plugin config section and `plugin remove` deletes it again.

**Data flow**: It creates the standard configured marketplace fixture, runs `plugin add sample@debug` and asserts the success message, reads `config.toml` and checks for `[plugins."sample@debug"]`, then runs `plugin remove sample --marketplace debug`, asserts the removal message, rereads `config.toml`, and checks the plugin section is absent.

**Call relations**: This async test validates the persistent config side effects of plugin installation and removal in addition to command output.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 3 external calls (assert!, contains, read_to_string).


##### `plugin_add_json_prints_install_outcome`  (lines 938–963)

```
async fn plugin_add_json_prints_install_outcome() -> Result<()>
```

**Purpose**: Checks the JSON payload emitted by `plugin add --json`, including the normalized installed cache path and auth policy.

**Data flow**: It creates the standard configured marketplace fixture, runs `plugin add sample@debug --json`, parses stdout as JSON, computes the expected installed cache path `plugins/cache/debug/sample/1.2.3`, normalizes it with `canonicalize_existing_preserving_symlinks`, and asserts equality with the expected object containing plugin identity, version, installed path, and `authPolicy: "ON_INSTALL"`.

**Call relations**: This async test validates the structured install-result contract after a successful plugin installation.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 3 external calls (assert_eq!, canonicalize_existing_preserving_symlinks, from_slice).


##### `plugin_remove_json_prints_remove_outcome`  (lines 966–998)

```
async fn plugin_remove_json_prints_remove_outcome() -> Result<()>
```

**Purpose**: Verifies the JSON payload emitted by `plugin remove --json` after a plugin has been installed.

**Data flow**: It creates the standard configured marketplace fixture, installs `sample@debug`, runs `plugin remove sample --marketplace debug --json`, parses stdout as JSON, and asserts equality with an object containing `pluginId`, `name`, and `marketplaceName`.

**Call relations**: This async test complements the install JSON test by pinning the machine-readable removal result shape.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert_eq!, from_slice).


##### `plugin_add_rejects_unconfigured_repo_local_marketplaces`  (lines 1001–1013)

```
async fn plugin_add_rejects_unconfigured_repo_local_marketplaces() -> Result<()>
```

**Purpose**: Ensures plugin installation cannot source plugins from an unconfigured repo-local marketplace even when run inside that repository.

**Data flow**: It creates an unconfigured local marketplace fixture, runs `plugin add sample@debug` from within the source directory using `codex_command_in`, and asserts failure with stderr saying the plugin was not found in marketplace `debug`.

**Call relations**: This async test is the add-command counterpart to the list exclusion test, proving configured marketplace snapshots are required for installation.

*Call graph*: calls 2 internal fn (codex_command_in, setup_unconfigured_local_marketplace); 1 external calls (contains).


##### `plugin_add_fails_when_configured_marketplace_snapshot_is_malformed`  (lines 1016–1028)

```
async fn plugin_add_fails_when_configured_marketplace_snapshot_is_malformed() -> Result<()>
```

**Purpose**: Checks that plugin installation fails with the configured-snapshot error format when the configured marketplace manifest is malformed.

**Data flow**: It creates a configured marketplace with invalid JSON manifest, runs `plugin add sample@debug`, and passes the assertion to `assert_configured_marketplace_snapshot_failure` with the source path and parse detail.

**Call relations**: This async test validates that plugin installation depends on successfully loading the configured marketplace snapshot before locating the plugin.

*Call graph*: calls 3 internal fn (assert_configured_marketplace_snapshot_failure, codex_command, setup_configured_marketplace_with_malformed_manifest).


##### `plugin_add_reinstalls_from_configured_marketplace_snapshot`  (lines 1031–1053)

```
async fn plugin_add_reinstalls_from_configured_marketplace_snapshot() -> Result<()>
```

**Purpose**: Verifies that re-running `plugin add` for an already installed plugin reinstalls from the configured marketplace snapshot and leaves the cached plugin manifest present.

**Data flow**: It creates the standard configured marketplace fixture, runs `plugin add sample@debug` twice, asserts the second invocation still reports success with the add message, and checks that `plugins/cache/debug/sample/1.2.3/.codex-plugin/plugin.json` exists as a file.

**Call relations**: This async test exercises idempotent/reinstall behavior on the success path, showing the command does not short-circuit solely because cache files already exist.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert!, contains).


##### `plugin_remove_works_after_marketplace_is_removed`  (lines 1056–1081)

```
async fn plugin_remove_works_after_marketplace_is_removed() -> Result<()>
```

**Purpose**: Ensures an installed plugin can still be removed from config after its marketplace configuration has been deleted.

**Data flow**: It creates the standard configured marketplace fixture, installs `sample` from marketplace `debug`, removes marketplace `debug`, then runs `plugin remove sample@debug`, asserts the success message, reads `config.toml`, and confirms the plugin section is absent.

**Call relations**: This async test validates that plugin removal can rely on the installed plugin identifier/config entry even when the originating marketplace is no longer configured.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 3 external calls (assert!, contains, read_to_string).


##### `plugin_add_rejects_cached_plugins_without_authorizing_marketplace_snapshot`  (lines 1084–1114)

```
async fn plugin_add_rejects_cached_plugins_without_authorizing_marketplace_snapshot() -> Result<()>
```

**Purpose**: Checks that cached plugin files are not sufficient to authorize installation once the marketplace snapshot has been removed.

**Data flow**: It creates the standard configured marketplace fixture, installs `sample@debug`, removes marketplace `debug`, asserts the cached plugin manifest file still exists under `plugins/cache/debug/sample/1.2.3`, then runs `plugin add sample@debug` again and asserts failure with stderr saying the plugin was not found in marketplace `debug`.

**Call relations**: This async test captures an important invariant: plugin add consults current marketplace authorization/snapshot state, not just the presence of cached plugin artifacts.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert!, contains).


### `cli/tests/marketplace_add.rs`

`test` · `CLI integration testing for marketplace configuration commands`

This integration test file builds temporary marketplace directories on disk, invokes the compiled `codex` binary with `assert_cmd`, and inspects both process output and the resulting filesystem/config state under a temporary `CODEX_HOME`. The helper `codex_command` standardizes command creation and injects `CODEX_HOME` so each test runs in isolation. `write_marketplace_source` creates a minimal but valid local marketplace layout: `.agents/plugins/marketplace.json`, a plugin manifest at `plugins/sample/.codex-plugin/plugin.json`, and a marker file in the plugin directory.

The success-path tests focus on the semantics of adding a local directory marketplace: the command should not copy the marketplace into the installed-marketplaces root, but instead persist a marketplace entry in `config.toml` with `source_type = "local"` and a canonicalized absolute source path. The JSON-mode test confirms the command reports the marketplace name, the resolved installed root/path string, and `alreadyAdded: false`. The failure-path tests pin down argument validation: passing the manifest file itself instead of its containing directory must fail with a directory-specific error, and combining `--sparse` with a local directory source must fail because sparse checkout is only meaningful for git sources. Together these tests define the CLI contract for local marketplace registration rather than marketplace installation.

#### Function details

##### `codex_command`  (lines 11–15)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Constructs an `assert_cmd::Command` targeting the built `codex` executable and scopes it to a supplied temporary Codex home directory.

**Data flow**: It takes `codex_home: &Path`, resolves the binary path via `codex_utils_cargo_bin::cargo_bin("codex")`, creates an `assert_cmd::Command`, sets the `CODEX_HOME` environment variable on that command, and returns the configured command wrapped in `anyhow::Result`.

**Call relations**: All four tests call this helper before adding CLI arguments. It is the common setup step that ensures each invocation of `plugin marketplace add` reads and writes only the temporary test home.

*Call graph*: called by 4 (marketplace_add_json_prints_add_outcome, marketplace_add_local_directory_source, marketplace_add_rejects_local_manifest_file_source, marketplace_add_rejects_sparse_for_local_directory_source); 2 external calls (new, cargo_bin).


##### `write_marketplace_source`  (lines 17–41)

```
fn write_marketplace_source(source: &Path, marker: &str) -> Result<()>
```

**Purpose**: Creates a minimal local marketplace tree on disk that the CLI can recognize as a valid marketplace containing one plugin named `sample`.

**Data flow**: It takes a root `source: &Path` and a `marker: &str`, creates `.agents/plugins` and `plugins/sample/.codex-plugin`, writes a fixed `marketplace.json` manifest naming marketplace `debug` and a local plugin source `./plugins/sample`, writes `plugin.json` with plugin name `sample`, and writes `marker.txt` containing the caller-provided marker string.

**Call relations**: Each test that needs a valid local marketplace calls this helper first. The tests then either pass the directory or a derived manifest path into `codex_command` to exercise success and validation branches.

*Call graph*: called by 4 (marketplace_add_json_prints_add_outcome, marketplace_add_local_directory_source, marketplace_add_rejects_local_manifest_file_source, marketplace_add_rejects_sparse_for_local_directory_source); 3 external calls (join, create_dir_all, write).


##### `marketplace_add_local_directory_source`  (lines 44–73)

```
async fn marketplace_add_local_directory_source() -> Result<()>
```

**Purpose**: Verifies that adding a local marketplace directory records configuration only, without creating an installed marketplace copy.

**Data flow**: It creates temporary `codex_home` and `source` directories, populates the source marketplace, computes a relative CLI argument from the source parent directory, runs `codex plugin marketplace add <relative-dir>`, then reads `config.toml` from `CODEX_HOME` and parses it as `toml::Value`. It asserts the installed-marketplace root for `debug` does not exist and that the config stores `source_type = "local"` and the canonicalized absolute source path.

**Call relations**: This is a top-level async test. It uses `write_marketplace_source` for fixture creation, `codex_command` for process execution, and `marketplace_install_root` to prove the add operation did not materialize a copied marketplace under the managed install directory.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, marketplace_install_root); 6 external calls (new, assert!, assert_eq!, format!, read_to_string, from_str).


##### `marketplace_add_json_prints_add_outcome`  (lines 76–108)

```
async fn marketplace_add_json_prints_add_outcome() -> Result<()>
```

**Purpose**: Checks the machine-readable JSON emitted by `plugin marketplace add --json` for a local directory source.

**Data flow**: It creates temporary home and source directories, writes the marketplace fixture, invokes `codex plugin marketplace add <relative-dir> --json`, captures stdout bytes, parses them into `serde_json::Value`, canonicalizes the source path and converts it into `AbsolutePathBuf`, and compares the parsed JSON to an expected object containing `marketplaceName`, `installedRoot`, and `alreadyAdded: false`.

**Call relations**: This async test follows the same setup path as the plain success test but validates the structured output branch instead of config contents. It depends on `codex_command` and `write_marketplace_source` to reach the JSON-producing code path.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, try_from); 4 external calls (new, assert_eq!, format!, from_slice).


##### `marketplace_add_rejects_local_manifest_file_source`  (lines 111–131)

```
async fn marketplace_add_rejects_local_manifest_file_source() -> Result<()>
```

**Purpose**: Ensures the CLI rejects a local source argument that points directly at `marketplace.json` instead of the marketplace directory.

**Data flow**: It creates temporary home and source directories, writes a valid marketplace fixture, derives the manifest file path `.agents/plugins/marketplace.json`, runs `codex plugin marketplace add <manifest-path>`, and asserts command failure with stderr containing the specific directory-vs-file validation message.

**Call relations**: This async test uses the shared fixture and command helpers, but intentionally passes the wrong path shape to drive the CLI's local-source validation branch.

*Call graph*: calls 2 internal fn (codex_command, write_marketplace_source); 2 external calls (new, contains).


##### `marketplace_add_rejects_sparse_for_local_directory_source`  (lines 134–155)

```
async fn marketplace_add_rejects_sparse_for_local_directory_source() -> Result<()>
```

**Purpose**: Pins down that `--sparse` is invalid when the marketplace source is a local directory rather than a git repository.

**Data flow**: It creates temporary home and source directories, writes a valid local marketplace, runs `codex plugin marketplace add --sparse .agents <source-dir>`, and asserts failure with stderr mentioning that sparse mode is only supported for git marketplace sources.

**Call relations**: This async test again uses the common helpers, but combines a local source with git-only flags to verify the command-line parser or command implementation rejects that combination before any marketplace is added.

*Call graph*: calls 2 internal fn (codex_command, write_marketplace_source); 2 external calls (new, contains).


### `cli/tests/marketplace_remove.rs`

`test` · `CLI integration testing for marketplace removal`

This file sets up marketplace state directly in the temporary Codex home, then invokes the CLI to remove it. `codex_command` creates a binary invocation scoped by `CODEX_HOME`. `configured_marketplace_update` returns a fixed `MarketplaceConfigUpdate<'static>` representing a git-backed marketplace named later by the tests; this avoids repeating the same source metadata in each fixture. `write_installed_marketplace` creates a synthetic installed marketplace tree under `marketplace_install_root(codex_home)/<name>` with a minimal `.agents/plugins/marketplace.json` and a marker file.

The main success test seeds both configuration and installed files, runs `plugin marketplace remove debug`, and then checks two independent side effects: the `[marketplaces.debug]` section is gone from `config.toml`, and the installed root directory no longer exists. The JSON-mode test verifies the structured response includes the marketplace name and a normalized installed root path, using `canonicalize_existing_preserving_symlinks` before removal to match the CLI’s path reporting. The final test covers the negative case where neither config nor installed files exist; the command must fail with a precise message saying the marketplace is not configured or installed. These tests collectively define removal as a cleanup operation over both persistent config and on-disk marketplace contents.

#### Function details

##### `codex_command`  (lines 12–16)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Builds an `assert_cmd::Command` for the `codex` binary with `CODEX_HOME` pointed at the test-specific temporary directory.

**Data flow**: It accepts `codex_home: &Path`, resolves the binary path with `cargo_bin`, constructs the command, sets `CODEX_HOME`, and returns the configured command in a `Result`.

**Call relations**: Every test in this file calls it before invoking `plugin marketplace remove`, making it the shared process setup layer.

*Call graph*: called by 3 (marketplace_remove_deletes_config_and_installed_root, marketplace_remove_json_prints_remove_outcome, marketplace_remove_rejects_unknown_marketplace); 2 external calls (new, cargo_bin).


##### `configured_marketplace_update`  (lines 18–27)

```
fn configured_marketplace_update() -> MarketplaceConfigUpdate<'static>
```

**Purpose**: Provides a reusable `MarketplaceConfigUpdate<'static>` fixture representing a configured git marketplace.

**Data flow**: It constructs and returns a `MarketplaceConfigUpdate` with fixed timestamps, `source_type: "git"`, source URL `https://github.com/owner/repo.git`, `ref_name: Some("main")`, and no sparse paths.

**Call relations**: The two success-path tests call this helper and pass its return value into `record_user_marketplace` to seed config before exercising removal.

*Call graph*: called by 2 (marketplace_remove_deletes_config_and_installed_root, marketplace_remove_json_prints_remove_outcome).


##### `write_installed_marketplace`  (lines 29–35)

```
fn write_installed_marketplace(codex_home: &Path, marketplace_name: &str) -> Result<()>
```

**Purpose**: Creates a minimal installed marketplace directory tree under Codex’s managed marketplace install root.

**Data flow**: It takes `codex_home` and `marketplace_name`, computes `marketplace_install_root(codex_home).join(marketplace_name)`, creates `.agents/plugins`, writes an empty `marketplace.json`, writes `marker.txt`, and returns `Ok(())`.

**Call relations**: The success tests call it after recording marketplace config so the remove command has both config state and filesystem state to delete.

*Call graph*: calls 1 internal fn (marketplace_install_root); called by 2 (marketplace_remove_deletes_config_and_installed_root, marketplace_remove_json_prints_remove_outcome); 2 external calls (create_dir_all, write).


##### `marketplace_remove_deletes_config_and_installed_root`  (lines 38–58)

```
async fn marketplace_remove_deletes_config_and_installed_root() -> Result<()>
```

**Purpose**: Verifies that removing a marketplace deletes both its config entry and its installed directory, and emits the expected human-readable success message.

**Data flow**: It creates a temporary home, records marketplace `debug` using `record_user_marketplace` and the shared update fixture, writes an installed marketplace tree, runs `codex plugin marketplace remove debug`, then reads `config.toml` as text and asserts the marketplace section string is absent and the installed root path no longer exists.

**Call relations**: This async test is the primary end-to-end removal scenario. It composes `configured_marketplace_update`, `write_installed_marketplace`, and `codex_command` to drive the CLI through its normal success path.

*Call graph*: calls 3 internal fn (codex_command, configured_marketplace_update, write_installed_marketplace); 5 external calls (new, assert!, record_user_marketplace, contains, read_to_string).


##### `marketplace_remove_json_prints_remove_outcome`  (lines 61–84)

```
async fn marketplace_remove_json_prints_remove_outcome() -> Result<()>
```

**Purpose**: Checks that JSON mode for marketplace removal reports the removed marketplace name and normalized installed root path.

**Data flow**: It creates a temporary home, seeds config and installed files for `debug`, computes and normalizes the installed root path before deletion, runs `codex plugin marketplace remove debug --json`, parses stdout as `serde_json::Value`, and compares it to the expected JSON object.

**Call relations**: This async test follows the same setup as the plain success test but validates the structured-output branch. It uses path normalization to match the CLI’s reported root exactly.

*Call graph*: calls 4 internal fn (codex_command, configured_marketplace_update, write_installed_marketplace, marketplace_install_root); 5 external calls (new, assert_eq!, record_user_marketplace, canonicalize_existing_preserving_symlinks, from_slice).


##### `marketplace_remove_rejects_unknown_marketplace`  (lines 87–99)

```
async fn marketplace_remove_rejects_unknown_marketplace() -> Result<()>
```

**Purpose**: Ensures the remove command fails cleanly when asked to remove a marketplace that is neither configured nor installed.

**Data flow**: It creates an empty temporary home, runs `codex plugin marketplace remove debug`, and asserts process failure with stderr containing the unknown-marketplace message.

**Call relations**: This async test exercises the command’s early validation/error path without any fixture setup beyond `codex_command`.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


### `cli/tests/marketplace_upgrade.rs`

`test` · `CLI integration testing for marketplace upgrade command routing`

This small integration test file is entirely about command routing and output shape for marketplace upgrades. The shared `codex_command` helper creates an `assert_cmd::Command` for the built `codex` binary and injects a temporary `CODEX_HOME`, ensuring no real user configuration affects the tests.

The first test verifies the nominal command path `codex plugin marketplace upgrade` succeeds even when there are no configured git marketplaces, and that it prints the explicit empty-state message `No configured Git marketplaces to upgrade.`. The second test exercises the same command in `--json` mode and asserts that stdout parses into a JSON object with three empty arrays: `selectedMarketplaces`, `upgradedRoots`, and `errors`. That output contract matters because callers can distinguish “nothing to do” from command failure without scraping text. The final test locks in a CLI migration: `codex marketplace upgrade` should now fail with an unrecognized-subcommand error, proving the old top-level route has been removed. Together these tests define both the current invocation path and the no-op behavior when no upgrade candidates exist.

#### Function details

##### `codex_command`  (lines 8–12)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates an `assert_cmd::Command` for the `codex` executable with a temporary `CODEX_HOME`.

**Data flow**: It takes a home path, resolves the cargo-built binary, constructs the command, sets `CODEX_HOME`, and returns the configured command.

**Call relations**: All three tests call this helper before supplying arguments for either the supported nested command or the rejected legacy top-level command.

*Call graph*: called by 3 (marketplace_upgrade_json_prints_upgrade_outcome, marketplace_upgrade_no_longer_runs_at_top_level, marketplace_upgrade_runs_under_plugin); 2 external calls (new, cargo_bin).


##### `marketplace_upgrade_runs_under_plugin`  (lines 15–25)

```
async fn marketplace_upgrade_runs_under_plugin() -> Result<()>
```

**Purpose**: Verifies that the supported upgrade command path is `plugin marketplace upgrade` and that it succeeds with a clear no-op message when no git marketplaces are configured.

**Data flow**: It creates a temporary home, runs `codex plugin marketplace upgrade`, and asserts success plus stdout containing `No configured Git marketplaces to upgrade.`.

**Call relations**: This async test uses `codex_command` to exercise the current command path and validate the human-readable empty-state branch.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


##### `marketplace_upgrade_json_prints_upgrade_outcome`  (lines 28–48)

```
async fn marketplace_upgrade_json_prints_upgrade_outcome() -> Result<()>
```

**Purpose**: Checks the JSON payload emitted by `plugin marketplace upgrade --json` when there is nothing to upgrade.

**Data flow**: It creates a temporary home, runs the JSON form of the upgrade command, captures stdout, parses it as `serde_json::Value`, and asserts equality with an object containing empty `selectedMarketplaces`, `upgradedRoots`, and `errors` arrays.

**Call relations**: This async test complements the text-output test by pinning the machine-readable no-op contract for the same command path.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (new, assert_eq!, from_slice).


##### `marketplace_upgrade_no_longer_runs_at_top_level`  (lines 51–61)

```
async fn marketplace_upgrade_no_longer_runs_at_top_level() -> Result<()>
```

**Purpose**: Ensures the deprecated top-level `marketplace upgrade` route is rejected by the CLI parser.

**Data flow**: It creates a temporary home, runs `codex marketplace upgrade`, and asserts failure with stderr containing `unrecognized subcommand 'upgrade'`.

**Call relations**: This async test uses `codex_command` to validate command-tree structure rather than marketplace behavior, proving callers must now go through `plugin marketplace`.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


### MCP management commands
These tests validate MCP server configuration lifecycle commands, from adding and removing entries to listing and inspecting them in text and JSON forms.

### `cli/tests/mcp_add_remove.rs`

`test` · `CLI integration testing for MCP server configuration`

This integration test file drives the MCP server management CLI and then reads back the persisted global MCP server configuration using `codex_core::config::load_global_mcp_servers`. The shared `codex_command` helper launches the built binary with an isolated `CODEX_HOME`. Unlike tests that only inspect stdout, these tests validate the exact `McpServerTransportConfig` variants and fields written into config.

The stdio-path tests add a server named `docs` or `envy` with command arguments and optional repeated `--env` flags, then load the resulting server map and pattern-match on `McpServerTransportConfig::Stdio { command, args, env, env_vars, cwd }`. They assert command/arg preservation, enabled state, and that explicit env key/value pairs survive round-trip with the expected values. The remove flow is also tested for idempotence: removing an existing server empties the config, and removing it again succeeds with a “not found” message rather than failing.

The HTTP-path tests add `StreamableHttp` servers via `--url`, checking default absence of bearer-token wiring, custom `--bearer-token-env-var`, and OAuth metadata (`--oauth-client-id`, `--oauth-resource`). They also verify that no `.credentials.json` or `.env` files are created for the no-token case. Two negative tests pin down CLI validation: the removed `--with-bearer-token` flag must fail without writing config, and mixing URL mode with a command-style invocation must be rejected by argument parsing.

#### Function details

##### `codex_command`  (lines 10–14)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates an `assert_cmd::Command` for the `codex` binary scoped to a temporary Codex home.

**Data flow**: It accepts `codex_home`, resolves the binary path, constructs the command, sets `CODEX_HOME`, and returns the configured command in a `Result`.

**Call relations**: Every test in this file uses it to invoke `mcp add`, `mcp remove`, or `mcp list` under isolated configuration.

*Call graph*: called by 8 (add_and_remove_server_updates_global_config, add_cant_add_command_and_url, add_streamable_http_rejects_removed_flag, add_streamable_http_with_custom_env_var, add_streamable_http_with_oauth_options, add_streamable_http_without_manual_token, add_with_env_preserves_key_order_and_values, profile_mcp_reports_legacy_profile_migration); 2 external calls (new, cargo_bin).


##### `add_and_remove_server_updates_global_config`  (lines 17–69)

```
async fn add_and_remove_server_updates_global_config() -> Result<()>
```

**Purpose**: Verifies that adding a stdio MCP server writes the expected global config and that removing it deletes that config, including the idempotent second-remove case.

**Data flow**: It creates a temporary home, runs `mcp add docs -- echo hello`, loads the global server map asynchronously, extracts `docs`, matches its transport as `McpServerTransportConfig::Stdio`, and asserts command, args, empty env/env_vars, absent cwd, and `enabled = true`. It then runs `mcp remove docs`, reloads and asserts the map is empty, runs the same remove again, and confirms the map remains empty while stdout reports no server found.

**Call relations**: This async test is the main add/remove lifecycle scenario. It uses `codex_command` for CLI execution and `load_global_mcp_servers` after each mutation to verify persisted state rather than trusting command output alone.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 5 external calls (new, assert!, assert_eq!, panic!, contains).


##### `profile_mcp_reports_legacy_profile_migration`  (lines 72–91)

```
async fn profile_mcp_reports_legacy_profile_migration() -> Result<()>
```

**Purpose**: Checks that using `--profile` with MCP commands against a legacy profile layout fails with a migration-oriented diagnostic.

**Data flow**: It creates a temporary home, writes a `config.toml` containing `[profiles.work]`, runs `codex --profile work mcp list`, and asserts failure with stderr mentioning that profile `work` cannot be used, the legacy config section, and the expected `work.config.toml` migration target.

**Call relations**: This async test bypasses helper config loaders and writes the legacy profile file directly so the CLI enters its profile-migration error path.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (new, contains, write).


##### `add_with_env_preserves_key_order_and_values`  (lines 94–127)

```
async fn add_with_env_preserves_key_order_and_values() -> Result<()>
```

**Purpose**: Verifies that repeated `--env` flags on `mcp add` are persisted as explicit environment entries with the expected keys and values.

**Data flow**: It creates a temporary home, runs `mcp add envy --env FOO=bar --env ALPHA=beta -- python server.py`, loads the global server map, extracts `envy`, matches `transport` as `Stdio` with `env: Some(env)`, and asserts the map length is 2, `FOO` maps to `bar`, `ALPHA` maps to `beta`, and the server is enabled.

**Call relations**: This async test uses `codex_command` to create the server and `load_global_mcp_servers` to inspect the persisted transport structure after parsing repeated CLI flags.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 4 external calls (new, assert!, assert_eq!, panic!).


##### `add_streamable_http_without_manual_token`  (lines 130–161)

```
async fn add_streamable_http_without_manual_token() -> Result<()>
```

**Purpose**: Checks that adding an HTTP MCP server with only `--url` produces a `StreamableHttp` transport with no token or header configuration and no credential side files.

**Data flow**: It creates a temporary home, runs `mcp add github --url https://example.com/mcp`, loads the server map, extracts `github`, matches `transport` as `McpServerTransportConfig::StreamableHttp`, and asserts the URL matches while `bearer_token_env_var`, `http_headers`, and `env_http_headers` are all `None`. It also asserts the server is enabled and that `.credentials.json` and `.env` do not exist under `CODEX_HOME`.

**Call relations**: This async test covers the simplest HTTP transport path and explicitly checks that the command does not create extra credential storage when no token-related option is supplied.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 4 external calls (new, assert!, assert_eq!, panic!).


##### `add_streamable_http_with_custom_env_var`  (lines 164–199)

```
async fn add_streamable_http_with_custom_env_var() -> Result<()>
```

**Purpose**: Verifies that `--bearer-token-env-var` is persisted on a streamable HTTP MCP server.

**Data flow**: It creates a temporary home, runs `mcp add issues --url https://example.com/issues --bearer-token-env-var GITHUB_TOKEN`, loads the server map, extracts `issues`, matches `StreamableHttp`, and asserts the URL, `bearer_token_env_var = Some("GITHUB_TOKEN")`, absent header fields, and enabled state.

**Call relations**: This async test exercises the HTTP transport branch with explicit bearer-token environment wiring and validates the resulting config via `load_global_mcp_servers`.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 4 external calls (new, assert!, assert_eq!, panic!).


##### `add_streamable_http_with_oauth_options`  (lines 202–235)

```
async fn add_streamable_http_with_oauth_options() -> Result<()>
```

**Purpose**: Checks that OAuth-related CLI options are stored on the created MCP server entry.

**Data flow**: It creates a temporary home, runs `mcp add oauth-server --url https://example.com/mcp --oauth-client-id eci-prd-pub-codex-123 --oauth-resource https://resource.example.com`, loads the server map, extracts `oauth-server`, and asserts `oauth_client_id()` returns the configured client ID and `oauth_resource` matches the supplied resource URL.

**Call relations**: This async test focuses on metadata attached to the server entry beyond the transport enum fields, using `load_global_mcp_servers` to verify the persisted server object.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 2 external calls (new, assert_eq!).


##### `add_streamable_http_rejects_removed_flag`  (lines 238–259)

```
async fn add_streamable_http_rejects_removed_flag() -> Result<()>
```

**Purpose**: Ensures the obsolete `--with-bearer-token` flag is rejected and does not leave behind any MCP server config.

**Data flow**: It creates a temporary home, runs `mcp add github --url https://example.com/mcp --with-bearer-token`, asserts failure with stderr mentioning the removed flag, then loads the global server map and asserts it is empty.

**Call relations**: This async test drives a parser/validation failure path and then confirms via `load_global_mcp_servers` that no partial configuration was written.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 3 external calls (new, assert!, contains).


##### `add_cant_add_command_and_url`  (lines 262–286)

```
async fn add_cant_add_command_and_url() -> Result<()>
```

**Purpose**: Verifies that command-style and URL-style MCP server definitions are mutually exclusive at the CLI level.

**Data flow**: It creates a temporary home, runs `mcp add github --url https://example.com/mcp --command -- echo hello`, asserts failure with stderr containing the unexpected-argument message for `--command`, then loads the global server map and asserts it remains empty.

**Call relations**: This async test checks argument parsing rather than transport semantics, ensuring invalid mixed-mode invocations are rejected before config mutation.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 3 external calls (new, assert!, contains).


### `cli/tests/mcp_list.rs`

`test` · `CLI integration testing for MCP inspection commands`

This file validates the read side of MCP server management after configuration has been written. `codex_command` launches the CLI under a temporary `CODEX_HOME`. The tests use `load_global_mcp_servers` to fetch the current server map, mutate it in memory, and write it back with `ConfigEditsBuilder::replace_mcp_servers(...).apply_blocking()` so they can exercise rendering paths that are hard to reach through CLI flags alone.

`list_shows_empty_state` covers the simplest case: `codex mcp list` should succeed and print `No MCP servers configured yet.` when no servers exist. The larger `list_and_get_render_expected_output` test first adds a stdio server with one explicit secret env var, then edits the stored transport to add `env_vars` placeholders such as `APP_TOKEN` and `WORKSPACE_ID`. It verifies the table output includes headers, server identity, command, masked env values (`*****`), enabled status, and auth status `Unsupported`. It then checks `mcp list --json` returns a precise JSON array with the full stdio transport object, including unmasked stored env values and the added `env_vars`. Finally it validates `mcp get docs` in both text and JSON forms, including the suggested remove command. The last test disables a server in config and confirms `mcp get` collapses to the single-line `docs (disabled)` representation instead of the full detail block.

#### Function details

##### `codex_command`  (lines 14–18)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates an `assert_cmd::Command` for the `codex` binary with `CODEX_HOME` set to the temporary test directory.

**Data flow**: It takes a home path, resolves the cargo-built executable, constructs the command, sets `CODEX_HOME`, and returns the configured command.

**Call relations**: All three tests use this helper before invoking `mcp list`, `mcp get`, or `mcp add`.

*Call graph*: called by 3 (get_disabled_server_shows_single_line, list_and_get_render_expected_output, list_shows_empty_state); 2 external calls (new, cargo_bin).


##### `list_shows_empty_state`  (lines 21–31)

```
fn list_shows_empty_state() -> Result<()>
```

**Purpose**: Verifies that `mcp list` succeeds and prints the expected empty-state message when no MCP servers are configured.

**Data flow**: It creates a temporary home, runs `codex mcp list` via `.output()`, asserts the exit status is successful, decodes stdout as UTF-8, and checks that the output contains `No MCP servers configured yet.`.

**Call relations**: This synchronous test uses only `codex_command` and direct process output inspection to validate the zero-config rendering path.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (from_utf8, new, assert!).


##### `list_and_get_render_expected_output`  (lines 34–139)

```
async fn list_and_get_render_expected_output() -> Result<()>
```

**Purpose**: Exercises the full text and JSON rendering of an enabled stdio MCP server, including masked secrets and persisted transport fields.

**Data flow**: It creates a temporary home, adds server `docs` with `mcp add` and one `--env TOKEN=secret`, loads the server map asynchronously, mutates the `docs` transport to set `env_vars = ["APP_TOKEN", "WORKSPACE_ID"]`, writes the edited map back with `ConfigEditsBuilder`, then runs `mcp list`, `mcp list --json`, `mcp get docs`, and `mcp get docs --json`. It decodes text outputs, parses JSON outputs, and asserts on headers, masked values, enabled/auth labels, exact JSON structure, and the presence of the suggested remove command.

**Call relations**: This async test combines CLI writes, direct config mutation, and multiple read commands to validate both serialization and human-facing formatting paths that depend on stored transport details.

*Call graph*: calls 3 internal fn (codex_command, new, load_global_mcp_servers); 8 external calls (from_utf8, new, assert!, assert_eq!, panic!, contains, from_str, vec!).


##### `get_disabled_server_shows_single_line`  (lines 142–166)

```
async fn get_disabled_server_shows_single_line() -> Result<()>
```

**Purpose**: Checks that `mcp get` renders a disabled server as a compact single-line status instead of the normal detailed block.

**Data flow**: It creates a temporary home, adds server `docs`, loads the server map, sets `docs.enabled = false`, writes the modified map back with `ConfigEditsBuilder`, runs `codex mcp get docs`, decodes stdout, and asserts the trimmed output equals exactly `docs (disabled)`.

**Call relations**: This async test uses the same add-then-edit pattern as the previous test, but specifically drives the disabled rendering branch in the `get` command.

*Call graph*: calls 3 internal fn (codex_command, new, load_global_mcp_servers); 4 external calls (from_utf8, new, assert!, assert_eq!).


### Live CLI smoke coverage
These optional smoke tests run the real CLI binary against the live service to confirm end-to-end behavior beyond the mocked integration suite.

### `core/tests/suite/live_cli.rs`

`test` · `request handling`

Unlike the rest of the suite, this file intentionally talks to the real network and is marked `#[ignore]` so CI remains deterministic and free. The tests are aimed at developers running local smoke checks with a valid `OPENAI_API_KEY`. The helper `require_api_key` enforces that prerequisite, while `run_live` does the heavy lifting of spawning the compiled `codex-rs` binary inside a temporary working directory and isolated temporary home directory with `CODEX_HOME` pointing at a fresh `.codex` tree.

A notable design choice in `run_live` is that it bypasses `assert_cmd`’s command wrapper for process creation. Instead it constructs a plain `std::process::Command`, pipes stdin/stdout/stderr manually, writes a terminating newline to stdin so the session exits after one turn, and spawns one thread per output stream to tee bytes to both the parent terminal and an in-memory buffer. That gives live visibility during the test while still producing a captured `std::process::Output` that can be converted into `assert_cmd::Assert` for familiar assertions.

The two ignored tests then assert concrete side effects. One asks the model to create `hello.txt` via the shell/apply_patch path and checks the file exists with trimmed contents `hello`. The other asks the model to print the current working directory and asserts stdout contains the temporary directory path. Both short-circuit with a skip message if the API key is absent.

#### Function details

##### `require_api_key`  (lines 12–15)

```
fn require_api_key() -> String
```

**Purpose**: Fetches `OPENAI_API_KEY` from the environment and fails immediately with a descriptive message if it is missing. It centralizes the live-test prerequisite check.

**Data flow**: Takes no arguments, reads `std::env::var("OPENAI_API_KEY")`, and returns the resulting `String` on success. If the variable is absent, it panics with an `expect` message instructing the caller to skip live tests.

**Call relations**: Called only by `run_live` during child-process setup. The top-level tests perform their own softer presence checks first so they can print a skip message instead of panicking.

*Call graph*: called by 1 (run_live); 1 external calls (var).


##### `run_live`  (lines 18–115)

```
fn run_live(prompt: &str) -> (assert_cmd::assert::Assert, TempDir)
```

**Purpose**: Spawns the real `codex-rs` binary in an isolated temp workspace, streams its stdout/stderr live to the parent terminal, captures the same output for assertions, and returns both the `Assert` handle and working directory. It is the core harness for the live CLI smoke tests.

**Data flow**: Accepts a prompt string. It creates temporary working and home directories, creates `CODEX_HOME/.codex`, builds a `std::process::Command` pointing at the compiled `codex-rs` binary, sets `OPENAI_API_KEY`, `HOME`, and `CODEX_HOME`, appends CLI args `--allow-no-git-exec -v -- <prompt>`, and configures piped stdin/stdout/stderr. After spawning the child, it writes a newline to stdin so the session exits after one turn. It defines a nested `tee` helper that reads from a child stream in chunks, mirrors bytes to the parent stdout/stderr, accumulates them into `Vec<u8>`, and returns that buffer from a thread. `run_live` joins both tee threads, waits for process exit, constructs `std::process::Output { status, stdout, stderr }`, converts it to `assert_cmd::Assert`, and returns that together with the temp working directory.

**Call relations**: Both ignored live tests call this helper with different prompts. It delegates to `require_api_key` for credentials and encapsulates all process-management details so the tests themselves only assert on success, stdout, and filesystem side effects.

*Call graph*: calls 1 internal fn (require_api_key); called by 2 (live_create_file_hello_txt, live_print_working_directory); 7 external calls (piped, new, new, cargo_bin, create_dir_all, stderr, stdout).


##### `live_create_file_hello_txt`  (lines 119–137)

```
fn live_create_file_hello_txt()
```

**Purpose**: Runs a live CLI prompt instructing the model to create `hello.txt` via the shell/apply_patch path, then verifies the file was actually created with the expected contents. It is a concrete end-to-end smoke test of tool use plus filesystem mutation.

**Data flow**: Takes no arguments. It first checks whether `OPENAI_API_KEY` is set; if not, it prints a skip message and returns early. Otherwise it calls `run_live` with a prompt that explicitly asks for `hello.txt` containing `hello`, asserts the child process succeeded, checks that `dir.path().join("hello.txt")` exists, reads the file to string, and asserts the trimmed contents equal `hello`.

**Call relations**: This top-level ignored test depends on `run_live` for process execution and environment isolation. Its assertions are intentionally concrete so a developer can tell whether the live model successfully used the shell tool to modify the temp workspace.

*Call graph*: calls 1 internal fn (run_live); 5 external calls (assert!, assert_eq!, eprintln!, var, read_to_string).


##### `live_print_working_directory`  (lines 141–152)

```
fn live_print_working_directory()
```

**Purpose**: Runs a live CLI prompt asking the model to print the current working directory and verifies stdout contains the temporary workspace path. It is a lightweight smoke test of shell execution and CLI output plumbing.

**Data flow**: Takes no arguments. It checks for `OPENAI_API_KEY`, printing a skip message and returning if absent. Otherwise it calls `run_live` with a prompt requesting the current working directory, then asserts process success and that stdout contains `dir.path().to_string_lossy()` using a predicate.

**Call relations**: This is the simpler companion to `live_create_file_hello_txt`. It reuses `run_live` but validates observable stdout rather than a created file.

*Call graph*: calls 1 internal fn (run_live); 3 external calls (eprintln!, contains, var).
