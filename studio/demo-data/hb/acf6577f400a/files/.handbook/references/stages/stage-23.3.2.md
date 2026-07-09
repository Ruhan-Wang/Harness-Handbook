# top-level codex CLI command verification  `stage-23.3.2`

This stage checks the front door of the Codex command-line program. These are integration tests, meaning they run commands much like a real user would and check the visible results: exit codes, printed text, JSON output, and saved configuration files. The app-server and exec-server tests make sure strict config mode rejects unknown settings instead of ignoring mistakes. The delete test confirms Codex will not ask for deletion confirmation when the target session is missing. The update test makes sure debug builds fail clearly instead of dropping into the normal prompt. Debug tests cover clearing stored memories safely and printing model lists as valid JSON. Feature tests check command-line feature flags and config writing. Plugin tests cover plugin commands, marketplace add, remove, and upgrade behavior, including local folders, cleanup, and error messages. MCP tests cover adding, listing, getting, and removing MCP server entries, including hiding secrets in friendly output while preserving full JSON data. Finally, the live CLI smoke test can exercise the real program against the OpenAI API, but it is normally skipped to avoid network cost and outside-service failures.

## Files in this stage

### Entrypoint validation
These tests verify strict configuration handling and basic command-surface behavior for top-level and server-style CLI entrypoints.

### `cli/tests/app_server.rs`

`test` · `test run`

This is a small automated test for the command-line app server. The real-world problem it protects against is a user writing a setting in `config.toml` that the program does not understand. If the program quietly accepted that file, the user might think their setting worked when it was actually ignored. This test makes sure strict mode catches that mistake.

The test creates a temporary fake Codex home folder, like a clean mini user environment made just for the test. Inside it, it writes a `config.toml` file containing an unknown field, `foo = "bar"`. Then it starts the compiled `codex` command with `CODEX_HOME` pointed at that temporary folder, so the command reads this test config instead of any real user config.

It runs `codex app-server --strict-config --listen off`. The `--strict-config` flag means unknown config fields should be treated as errors, and `--listen off` avoids starting a real listening server. The test then checks two things: the command fails, and its error output contains the phrase `unknown configuration field`. Without this test, a future change could accidentally let bad config through, weakening strict config validation for the app server.

#### Function details

##### `codex_command`  (lines 7–11)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper builds a command object for running the `codex` binary in a test. It also points the command at a chosen Codex home directory, so each test can use its own isolated configuration files.

**Data flow**: It receives a path to a temporary Codex home folder. It finds the compiled `codex` test binary, creates a command for it, sets the `CODEX_HOME` environment variable to the supplied path, and returns the ready-to-customize command object. If finding the binary fails, it returns that error instead.

**Call relations**: The test function calls this helper after creating its temporary config directory. The helper relies on external test utilities to locate and create the command, then hands the prepared command back so the test can add app-server arguments and make assertions about the result.

*Call graph*: called by 1 (strict_config_rejects_unknown_config_fields_for_app_server); 2 external calls (new, cargo_bin).


##### `strict_config_rejects_unknown_config_fields_for_app_server`  (lines 14–30)

```
fn strict_config_rejects_unknown_config_fields_for_app_server() -> Result<()>
```

**Purpose**: This test proves that the app server refuses a configuration file with unknown fields when strict config checking is enabled. It exists to catch regressions where invalid config might otherwise be accepted silently.

**Data flow**: It starts with a new temporary directory, writes a `config.toml` containing an unsupported field, and asks `codex_command` for a command that will read from that directory. It then runs the command as `app-server` with strict config enabled and listening turned off. The expected outcome is a failed command whose standard error text includes `unknown configuration field`.

**Call relations**: This is the main test case in the file. It calls `codex_command` to get an isolated `codex` process setup, uses standard file writing to create the bad config, and uses the test assertion tools to check that the app server rejects the config in the expected way.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (new, contains, write).


### `cli/tests/delete.rs`

`test` · `test run`

Deleting data is risky, so the command-line tool needs to be careful about the order of its checks. This test makes sure the tool first looks for the session the user named, and only asks for deletion confirmation if that session actually exists. In everyday terms, it is like a clerk checking whether a file is in the cabinet before asking you to sign a form to destroy it.

The test creates a fresh temporary `CODEX_HOME`, which is the directory where this tool stores its local data. Because the directory is empty, there are no active or archived sessions inside it. The test then runs the real `codex` command with `delete` and a sample session ID.

The expected result is failure, but a specific kind of failure. The error message must say that no matching session was found. Just as importantly, the output must not include the phrase `cannot confirm`, because that would mean the program reached the confirmation step even though there was nothing valid to delete. This protects both user experience and deletion safety by enforcing the correct sequence: find the target first, then confirm.

#### Function details

##### `missing_session_fails_before_delete_confirmation`  (lines 4–17)

```
fn missing_session_fails_before_delete_confirmation() -> anyhow::Result<()>
```

**Purpose**: This test checks that deleting a nonexistent session stops with a clear “not found” error before the command tries to confirm the deletion. Someone would use this test to guard against a bug where the delete command asks for confirmation even though no session can be deleted.

**Data flow**: The test starts with an empty temporary storage directory and points `CODEX_HOME` at it. It then runs the `codex delete` command with a fixed session ID. The command is expected to exit unsuccessfully, print a message saying no active or archived session matched, and not print `cannot confirm`.

**Call relations**: During the test, it creates a temporary directory, locates the built `codex` command-line program, runs that program with the delete arguments, and checks the command output. The external helpers provide the temporary directory, command construction, binary lookup, and text-matching checks used to verify the result.

*Call graph*: 4 external calls (new, cargo_bin, contains, tempdir).


### `cli/tests/exec_server.rs`

`test` · `test run`

This is a small automated test for the command-line program. The real-life problem it checks is simple: if a user writes a setting that Codex does not understand, and asks for strict checking, Codex should say so and stop instead of ignoring the mistake. Without this test, a future change could accidentally let bad configuration slip through, which would make typos hard to notice.

The test creates a temporary Codex home folder, like a disposable mini version of a user’s Codex directory. Inside it, it writes a `config.toml` file with one made-up field: `foo = "bar"`. Then it builds a command that runs the `codex` binary with `CODEX_HOME` pointed at that temporary folder, so the program reads this test config instead of any real user config.

Next, the test runs `codex exec-server --strict-config --listen http://127.0.0.1:0`. The listen address uses port `0`, which means the operating system may choose any free port; the test is not trying to check networking here. It only checks startup validation. The expected result is failure, and the error text must include “unknown configuration field.”

#### Function details

##### `codex_command`  (lines 7–11)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper prepares a command that will run the `codex` executable in a controlled test environment. It points `CODEX_HOME` at a supplied folder so the test can decide exactly which configuration files Codex sees.

**Data flow**: It receives a path to a temporary Codex home directory. It asks the test tooling for the compiled `codex` binary, creates a command for that binary, adds the `CODEX_HOME` environment variable, and returns the ready-to-customize command. If finding the binary fails, it returns that error instead.

**Call relations**: The test function calls this after creating and filling the temporary config directory. This helper hides the repeated setup details, then hands back a command object that the test extends with `exec-server` arguments before running assertions against it.

*Call graph*: called by 1 (strict_config_rejects_unknown_config_fields_for_exec_server); 2 external calls (new, cargo_bin).


##### `strict_config_rejects_unknown_config_fields_for_exec_server`  (lines 14–35)

```
fn strict_config_rejects_unknown_config_fields_for_exec_server() -> Result<()>
```

**Purpose**: This test proves that `codex exec-server` rejects unknown configuration fields when `--strict-config` is used. It is checking for a clear failure message rather than allowing a bad config to be quietly ignored.

**Data flow**: It starts by creating a temporary directory, then writes a `config.toml` file containing an unsupported field. It asks `codex_command` to create a `codex` command using that directory as its home, adds the `exec-server`, `--strict-config`, and `--listen` arguments, runs the command, and checks that it fails with an error message containing “unknown configuration field.” The temporary files are automatically cleaned up afterward.

**Call relations**: This is the main test case in the file. It relies on `codex_command` to launch Codex with the test-only home directory, uses file-writing support to create the bad config, and uses assertion helpers to confirm the command exits unsuccessfully for the expected reason.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (new, contains, write).


### `cli/tests/update.rs`

`test` · `test run for debug builds`

This is a small safety test for the command-line program. In a debug build, which is the kind developers usually run while working on the project, `codex update` is not meant to be available. The important behavior is not just that the command fails, but that it fails in the right way: with a specific message, and without starting an interactive session that would hang the test or confuse the user.

The file first defines a helper that builds a test command for running the `codex` binary. It also points that command at a temporary `CODEX_HOME`, which is like giving the program a fresh, empty home folder so the test does not touch a real user’s settings.

The actual test creates that temporary home folder, runs `codex update`, and checks two things: the command must fail, and its error output must say that `codex update` is not available in debug builds. The test is only compiled and run when debug assertions are enabled, so it specifically protects developer/debug behavior rather than release behavior.

#### Function details

##### `codex_command`  (lines 6–10)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper prepares a command that runs the `codex` test binary with a chosen home directory. It keeps the test setup in one place so each test can run `codex` without using the developer’s real environment.

**Data flow**: It takes a path to a temporary Codex home folder. It finds the built `codex` binary, creates a command object for running it, sets the `CODEX_HOME` environment variable to the supplied path, and returns that ready-to-use command. If finding the binary fails, it returns that error instead.

**Call relations**: The update test calls this helper before adding the `update` argument. Internally it relies on the test tooling to locate the compiled `codex` binary and create a runnable command, then hands the prepared command back to the test.

*Call graph*: called by 1 (update_does_not_start_interactive_prompt); 2 external calls (new, cargo_bin).


##### `update_does_not_start_interactive_prompt`  (lines 14–24)

```
async fn update_does_not_start_interactive_prompt() -> Result<()>
```

**Purpose**: This test proves that `codex update` does not drop into the normal interactive prompt in debug builds. Instead, it should stop immediately with a clear error message.

**Data flow**: It creates a temporary folder to act as `CODEX_HOME`, asks `codex_command` for a command configured to use that folder, adds the `update` argument, runs the command, and checks the result. The expected outcome is failure, with standard error containing the message that `codex update` is not available in debug builds.

**Call relations**: During the debug test run, the test framework calls this function. It uses `codex_command` to build the isolated command, uses the temporary-directory tool to avoid touching real user files, and uses a text-matching helper to check that the error message says the right thing.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


### Debug and feature commands
These tests cover maintenance-oriented debug commands and the feature-management CLI, including output formats, persistence, and warnings.

### `cli/tests/debug_clear_memories.rs`

`test` · `test run`

This is an integration test file, meaning it runs the real `codex` command-line program in a temporary home directory and checks what happens on disk. The feature being tested is a debug command that clears Codex's memory state. In this project, “memory” is stored partly in SQLite databases, which are small file-based databases, and partly in files under a `memories` folder. If this cleanup command is wrong, old memory summaries or queued memory jobs could survive and affect later sessions, like a notebook that was supposed to be erased but still has pages tucked inside.

The tests build a fake Codex home directory, initialize the normal state layout, and then manually insert sample rows into the memory-related database tables. One test also creates a stale memory summary file. After that, the tests run `codex debug clear-memories` as an external process, just as a user would from a terminal.

The checks are deliberately concrete: the memory output rows must be gone, memory-related background jobs must be gone, and the `memories` directory must still exist but be empty. A second test removes the main state database before running the command, to prove that clearing memories still works even when the broader state database is missing.

#### Function details

##### `codex_command`  (lines 11–15)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper prepares a command object for running the real `codex` binary during the tests. It also points the command at the temporary Codex home directory so the test does not touch a developer's real files.

**Data flow**: It receives the path to a temporary Codex home folder. It finds the compiled `codex` program, creates a command for it, sets the `CODEX_HOME` environment variable to the temporary folder, and returns the ready-to-run command object.

**Call relations**: Both tests call this helper just before they run `codex debug clear-memories`. It hides the repeated setup needed to launch the command-line program safely in an isolated test environment.

*Call graph*: called by 2 (debug_clear_memories_resets_memories_db_without_state_db, debug_clear_memories_resets_state_and_removes_memory_dir); 2 external calls (new, cargo_bin).


##### `debug_clear_memories_resets_state_and_removes_memory_dir`  (lines 18–138)

```
async fn debug_clear_memories_resets_state_and_removes_memory_dir() -> Result<()>
```

**Purpose**: This test proves that `codex debug clear-memories` removes saved memory records, removes memory background jobs, and empties the memory files directory. It covers the normal case where both the main state database and the memories database exist.

**Data flow**: It starts with a fresh temporary Codex home, initializes the state system, and writes fake conversation and memory data into the SQLite databases. It also creates a `memories` folder containing a stale `memory_summary.md` file. Then it runs the debug clear command. After the command finishes, it reconnects to the memories database and checks that memory output rows and memory jobs are gone, while the memory folder still exists but contains no files.

**Call relations**: This test calls `codex_command` to run the real CLI after setting up the fake stored state. It relies on the state path helpers and database connections to create the before-state, then uses command assertions and database queries to verify the after-state.

*Call graph*: calls 2 internal fn (codex_command, init); 12 external calls (connect, new, assert!, assert_eq!, memories_db_path, state_db_path, format!, contains, query, query_scalar (+2 more)).


##### `debug_clear_memories_resets_memories_db_without_state_db`  (lines 141–189)

```
async fn debug_clear_memories_resets_memories_db_without_state_db() -> Result<()>
```

**Purpose**: This test checks an edge case: clearing memories should still work even if the main state database file is missing. That matters because a repair or cleanup command should not fail just because one piece of local state is already gone.

**Data flow**: It creates a temporary Codex home and initializes the usual databases. It inserts one fake memory output row into the memories database, closes that database connection, and then deletes the main state database file. Next it runs `codex debug clear-memories`. Finally, it checks that the memory output table is empty and that the missing state database was not recreated as a side effect.

**Call relations**: Like the first test, this one uses `codex_command` to launch the real CLI. It sets up a narrower failure scenario before the launch, then verifies that the cleanup path focuses on the memories database and does not depend on the main state database being present.

*Call graph*: calls 2 internal fn (codex_command, init); 11 external calls (connect, new, assert!, assert_eq!, memories_db_path, state_db_path, format!, contains, query, query_scalar (+1 more)).


### `cli/tests/debug_models.rs`

`test` · `test run`

This is a small integration test for the Codex command-line program. Its job is to make sure a debugging command that lists available models actually works from the outside, the same way a user would run it in a terminal.

The tests create a temporary Codex home folder for each run. That folder acts like a clean, empty user profile, so the test does not depend on any real local configuration, saved credentials, or previous state on the developer’s machine. This is like testing a new appliance in an empty room instead of in someone’s messy kitchen.

Both tests start the compiled `codex` binary, run `debug models`, collect its output, and check three important things: the command exits successfully, the text printed to standard output is valid JSON, and that JSON contains a non-empty `models` array. One test uses `--bundled`, which asks for the built-in model list. The other uses the default behavior and confirms it still works without authentication.

Without these tests, the project could accidentally break this diagnostic command, change its output into something that is no longer machine-readable JSON, or make it require login when it should not.

#### Function details

##### `codex_command`  (lines 6–10)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper builds a command object for running the `codex` executable in a test. It also points the command at a temporary `CODEX_HOME` folder so each test starts with clean local state.

**Data flow**: It receives the path to a temporary Codex home directory. It finds the compiled `codex` binary, creates a command runner for it, adds the `CODEX_HOME` environment variable, and returns that ready-to-use command object or an error if setup fails.

**Call relations**: Both test functions call this first so they can run the real CLI in a controlled environment. It relies on external test utilities to locate the binary and create the command, then hands the prepared command back to the test so the test can add arguments and run it.

*Call graph*: called by 2 (debug_models_bundled_prints_json, debug_models_default_prints_json_without_auth); 2 external calls (new, cargo_bin).


##### `debug_models_bundled_prints_json`  (lines 13–25)

```
fn debug_models_bundled_prints_json() -> Result<()>
```

**Purpose**: This test proves that `codex debug models --bundled` succeeds and prints a valid JSON object containing at least one model. The `--bundled` flag means it should use the model information shipped with the program.

**Data flow**: It creates a fresh temporary Codex home directory, asks `codex_command` for a command runner, adds the `debug models --bundled` arguments, and runs the process. It then checks that the process succeeded, converts the printed bytes into text, parses that text as JSON, and verifies that the `models` field is a non-empty array.

**Call relations**: During the test run, this function is called by the Rust test harness. It uses `codex_command` for setup, then uses standard parsing and assertion tools to confirm that the CLI output has the promised shape.

*Call graph*: calls 1 internal fn (codex_command); 4 external calls (from_utf8, new, assert!, from_str).


##### `debug_models_default_prints_json_without_auth`  (lines 28–40)

```
fn debug_models_default_prints_json_without_auth() -> Result<()>
```

**Purpose**: This test proves that the plain `codex debug models` command succeeds and prints valid model-list JSON even when there is no saved authentication. That matters because this debug information should be available in a clean environment.

**Data flow**: It creates an empty temporary Codex home directory, builds a command runner through `codex_command`, adds the `debug models` arguments, and runs the CLI. It checks for a successful exit, turns standard output into text, parses it as JSON, and confirms that the `models` field is a non-empty array.

**Call relations**: The Rust test harness runs this function as an integration test. Like the bundled test, it depends on `codex_command` to isolate the command from the real machine’s Codex state, then checks the command output with JSON parsing and assertions.

*Call graph*: calls 1 internal fn (codex_command); 4 external calls (from_utf8, new, assert!, from_str).


### `cli/tests/features.rs`

`test` · `test run`

These are integration tests, meaning they do not call the internal Rust code directly. Instead, they start the real `codex` command-line tool in a temporary home folder and inspect what it prints, whether it succeeds or fails, and what files it writes. The temporary folder acts like a clean user profile, so each test starts with no existing configuration and cannot disturb a real user's files.

The helper `codex_command` builds a command for the compiled `codex` binary and points `CODEX_HOME` at that temporary folder. The tests then exercise real user commands such as `features enable unified_exec`, `features disable shell_tool`, and `features list`.

Several tests protect important user-facing behavior. Strict config mode must reject unknown settings, but it must also clearly say when it is not supported for `codex cloud`. Feature enable and disable commands must update `config.toml` with a `[features]` section and the right true-or-false value. Under-development features must print a warning so users know they are opting into something less stable. Finally, the feature list must appear in alphabetical order, which keeps the output predictable and easy to scan.

#### Function details

##### `codex_command`  (lines 8–12)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper creates a ready-to-run `codex` command for the tests. It also points the command at a temporary `CODEX_HOME`, so the test uses an isolated fake user directory instead of the real one.

**Data flow**: It receives the path to a temporary Codex home folder. It finds the built `codex` executable, creates a command object for it, adds the `CODEX_HOME` environment variable, and returns that prepared command or an error if the binary cannot be found.

**Call relations**: All the tests call this helper before running `codex`. It hides the repeated setup work, so each test can focus on the command arguments and the expected result.

*Call graph*: called by 6 (features_disable_writes_feature_flag_to_config, features_enable_under_development_feature_prints_warning, features_enable_writes_feature_flag_to_config, features_list_is_sorted_alphabetically_by_feature_name, strict_config_is_not_supported_for_cloud_command, strict_config_rejects_unknown_config_override); 2 external calls (new, cargo_bin).


##### `strict_config_rejects_unknown_config_override`  (lines 15–25)

```
fn strict_config_rejects_unknown_config_override() -> Result<()>
```

**Purpose**: This test checks that strict configuration mode refuses an unknown config override. That matters because strict mode is meant to catch typos or unsupported settings instead of silently ignoring them.

**Data flow**: It creates a fresh temporary Codex home, builds a `codex` command with `codex_command`, and runs `codex --strict-config -c foo=bar mcp-server`. The expected result is failure, with an error message saying there is an unknown configuration field.

**Call relations**: It relies on `codex_command` for the isolated command setup. It then uses the command assertion tools to run the CLI and check the failure text printed to standard error.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


##### `strict_config_is_not_supported_for_cloud_command`  (lines 28–40)

```
fn strict_config_is_not_supported_for_cloud_command() -> Result<()>
```

**Purpose**: This test checks that `--strict-config` gives a clear error when used with `codex cloud`. The goal is to prevent users from thinking strict config checking applies there when it does not.

**Data flow**: It starts with a fresh temporary Codex home, prepares the command, and runs `codex --strict-config -c foo=bar cloud list`. The command should fail and print a message explaining that `--strict-config` is not supported for `codex cloud`.

**Call relations**: Like the other CLI tests, it calls `codex_command` to prepare the binary and environment. It then hands control to the external command assertion library, which runs the command and checks the printed error.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


##### `features_enable_writes_feature_flag_to_config`  (lines 43–57)

```
async fn features_enable_writes_feature_flag_to_config() -> Result<()>
```

**Purpose**: This test verifies that enabling a feature through the CLI actually saves that choice in `config.toml`. Without this, the command might appear to work but the setting would not persist for later runs.

**Data flow**: It creates a clean temporary Codex home, runs `codex features enable unified_exec`, and expects a success message. Then it reads the generated `config.toml` file and checks that it contains a `[features]` section and `unified_exec = true`.

**Call relations**: It uses `codex_command` to run the real CLI in an isolated folder. After the command succeeds, it switches from command-output checking to file checking by reading the config file from that same temporary home.

*Call graph*: calls 1 internal fn (codex_command); 4 external calls (new, assert!, contains, read_to_string).


##### `features_disable_writes_feature_flag_to_config`  (lines 60–74)

```
async fn features_disable_writes_feature_flag_to_config() -> Result<()>
```

**Purpose**: This test verifies that disabling a feature through the CLI saves a false value in `config.toml`. This makes sure users can explicitly turn a feature off and have that choice remembered.

**Data flow**: It creates a temporary Codex home, runs `codex features disable shell_tool`, and expects a success message. It then reads `config.toml` and checks for both the `[features]` section and `shell_tool = false`.

**Call relations**: It follows the same outside-in pattern as the enable test: `codex_command` prepares the real CLI command, the assertion tools check the command result, and a direct file read confirms the lasting config change.

*Call graph*: calls 1 internal fn (codex_command); 4 external calls (new, assert!, contains, read_to_string).


##### `features_enable_under_development_feature_prints_warning`  (lines 77–89)

```
async fn features_enable_under_development_feature_prints_warning() -> Result<()>
```

**Purpose**: This test checks that enabling an experimental or under-development feature warns the user. That warning is important because it tells users the feature may be less stable or still changing.

**Data flow**: It creates a clean temporary Codex home, runs `codex features enable runtime_metrics`, and expects the command to succeed. It then checks standard error for a warning that `runtime_metrics` is an under-development feature.

**Call relations**: It uses `codex_command` for the normal isolated CLI setup. The command assertion library runs the feature-enable command and checks the warning text that the CLI sends to standard error.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


##### `features_list_is_sorted_alphabetically_by_feature_name`  (lines 92–119)

```
async fn features_list_is_sorted_alphabetically_by_feature_name() -> Result<()>
```

**Purpose**: This test makes sure `codex features list` prints feature names in alphabetical order. Sorted output is easier for people to scan and makes automated output checks more predictable.

**Data flow**: It creates a temporary Codex home, runs `codex features list`, and captures the command's standard output. It turns the output bytes into text, extracts the feature name from each line, makes a sorted copy of those names, and checks that the original order already matches the sorted order.

**Call relations**: It starts with `codex_command` like the other tests, then inspects the full command output instead of only checking for one phrase. It uses the equality assertion to compare the actual feature order with the alphabetically sorted version.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (from_utf8, new, assert_eq!).


### Plugin marketplace workflows
These tests exercise plugin and marketplace command behavior from broad listing/install flows through marketplace source addition, removal, and upgrade paths.

### `cli/tests/plugin_cli.rs`

`test` · `test run`

This is an integration test file: instead of calling internal Rust functions directly, it launches the real `codex` command and watches what happens. The tests build small fake plugin marketplaces in temporary folders. A marketplace is a folder with a manifest file that says which plugins exist, and each plugin has its own small `plugin.json` file. The tests also write a temporary Codex config file with plugins enabled, so they do not touch the developer’s real machine.

The file checks two main areas. First, marketplace listing: Codex should show configured marketplaces, include the user’s home marketplace when present, output stable JSON when asked, and report clear errors when a marketplace is missing, malformed, or wrongly configured. Second, plugin listing, adding, and removing: Codex should show available and installed plugins correctly, copy installed plugins into its cache, update the config file, and refuse unsafe cases such as using an unconfigured local repository as an authority.

A helpful way to read this file is as a set of “user stories” backed by disposable test data. The helper functions are the stage crew: they create fake homes, fake marketplaces, and expected rows. The test functions are the audience checks: they run commands and verify that Codex says and changes exactly what it should.

#### Function details

##### `marketplace_list_row`  (lines 16–22)

```
fn marketplace_list_row(marketplace_name: &str, root: &Path) -> String
```

**Purpose**: Builds the exact table row expected in `plugin marketplace list` output. It keeps spacing consistent so tests can compare human-readable command output without guessing.

**Data flow**: It receives a marketplace name and a root folder path. It pads the name to match the table header width, appends the displayed path, and returns the resulting string.

**Call relations**: Marketplace-listing tests call this before running Codex, then use the returned row as the expected text that should appear in standard output.

*Call graph*: called by 3 (marketplace_list_includes_home_marketplace_when_present, marketplace_list_includes_root_when_plugins_are_filtered_out, marketplace_list_shows_configured_marketplace_names); 1 external calls (format!).


##### `codex_command`  (lines 24–29)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates a ready-to-run test command for the real `codex` binary. It points Codex at a temporary home folder so tests are isolated from the user’s real configuration.

**Data flow**: It receives a temporary Codex home path. It finds the compiled `codex` executable, builds a command object, sets `CODEX_HOME` and `HOME` to the test folder, and returns that command or an error.

**Call relations**: Almost every test calls this when it is ready to run a CLI command. `codex_command_in` also builds on it when a test needs to run from a specific current directory.

*Call graph*: called by 29 (codex_command_in, marketplace_list_fails_when_configured_local_marketplace_source_is_missing, marketplace_list_fails_when_configured_marketplace_name_is_invalid, marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed, marketplace_list_fails_when_configured_marketplace_snapshot_is_missing, marketplace_list_fails_when_home_marketplace_is_malformed, marketplace_list_includes_home_marketplace_when_present, marketplace_list_includes_root_when_plugins_are_filtered_out, marketplace_list_json_includes_configured_git_marketplace_source, marketplace_list_json_keys_configured_source_by_root (+15 more)); 2 external calls (new, cargo_bin).


##### `codex_command_in`  (lines 31–35)

```
fn codex_command_in(codex_home: &Path, current_dir: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: Creates a `codex` command that runs from a chosen working directory. This is useful for tests that need to check whether Codex treats the current repository as a local marketplace.

**Data flow**: It receives a Codex home path and a current directory path. It first creates the normal isolated command, then changes that command’s working directory, and returns it.

**Call relations**: Tests for unconfigured local marketplaces use this to stand inside a fake marketplace folder before running `plugin list` or `plugin add`.

*Call graph*: calls 1 internal fn (codex_command); called by 2 (plugin_add_rejects_unconfigured_repo_local_marketplaces, plugin_list_excludes_unconfigured_repo_local_marketplaces).


##### `configured_local_marketplace`  (lines 37–46)

```
fn configured_local_marketplace(source: &str) -> MarketplaceConfigUpdate<'_>
```

**Purpose**: Builds a small configuration record that says a marketplace comes from a local folder. Tests use it when they want Codex to trust a temporary marketplace source.

**Data flow**: It receives a source path as text. It returns a marketplace update object with fixed test metadata, source type `local`, that source path, and no revision or sparse paths.

**Call relations**: Setup helpers pass this object to `record_user_marketplace`, which writes the fake marketplace into the temporary Codex config.

*Call graph*: called by 6 (setup_configured_marketplace_with_malformed_manifest, setup_configured_marketplace_without_manifest, setup_custom_marketplace_under_implicit_system_root, setup_local_marketplace, setup_local_marketplace_with_explicit_empty_products, setup_local_marketplace_with_implicit_system_roots).


##### `write_plugins_enabled_config`  (lines 48–56)

```
fn write_plugins_enabled_config(codex_home: &Path) -> Result<()>
```

**Purpose**: Writes the minimum Codex config needed to turn the plugins feature on. Without this, the CLI tests would not be exercising the plugin commands under normal enabled conditions.

**Data flow**: It receives the temporary Codex home path. It writes a config file containing a `[features]` section with `plugins = true`, then returns success or a file error.

**Call relations**: Most setup helpers call this before creating or recording marketplaces, so later CLI commands run with plugin support enabled.

*Call graph*: called by 11 (marketplace_list_fails_when_home_marketplace_is_malformed, marketplace_list_includes_home_marketplace_when_present, marketplace_list_json_includes_configured_git_marketplace_source, marketplace_list_json_keys_configured_source_by_root, plugin_list_json_includes_configured_git_marketplace_source, setup_configured_marketplace_with_malformed_manifest, setup_configured_marketplace_without_manifest, setup_custom_marketplace_under_implicit_system_root, setup_local_marketplace, setup_local_marketplace_with_explicit_empty_products (+1 more)); 2 external calls (join, write).


##### `write_marketplace_source_with_manifest`  (lines 58–77)

```
fn write_marketplace_source_with_manifest(source: &Path, marketplace_manifest: &str) -> Result<()>
```

**Purpose**: Creates a fake marketplace folder using a manifest string supplied by the caller. It also creates a sample plugin folder and plugin metadata so Codex has something real to discover.

**Data flow**: It receives a source directory and marketplace manifest text. It creates the manifest and plugin directories, writes `marketplace.json`, writes the sample plugin’s `plugin.json`, and returns success or an I/O error.

**Call relations**: The two marketplace-writing helpers call this with either a normal manifest or a manifest whose product policy filters out plugins.

*Call graph*: called by 2 (write_marketplace_source, write_marketplace_source_with_explicit_empty_products); 3 external calls (join, create_dir_all, write).


##### `write_marketplace_source`  (lines 79–95)

```
fn write_marketplace_source(source: &Path) -> Result<()>
```

**Purpose**: Creates the standard fake marketplace used by most tests. It contains one marketplace named `debug` and one plugin named `sample`.

**Data flow**: It receives a directory path. It passes that path and a normal marketplace manifest to the lower-level writer, which creates the files on disk.

**Call relations**: General setup helpers and several JSON-specific tests use this when they need a valid marketplace source before running Codex.

*Call graph*: calls 1 internal fn (write_marketplace_source_with_manifest); called by 6 (marketplace_list_includes_home_marketplace_when_present, marketplace_list_json_includes_configured_git_marketplace_source, marketplace_list_json_keys_configured_source_by_root, plugin_list_json_includes_configured_git_marketplace_source, setup_local_marketplace, setup_unconfigured_local_marketplace).


##### `write_marketplace_source_with_explicit_empty_products`  (lines 97–116)

```
fn write_marketplace_source_with_explicit_empty_products(source: &Path) -> Result<()>
```

**Purpose**: Creates a fake marketplace where the plugin has an explicit empty product list. This lets tests check that the marketplace root still appears even if plugin filtering removes visible plugins.

**Data flow**: It receives a directory path. It writes a marketplace manifest with the sample plugin and an empty `products` policy, plus the sample plugin metadata.

**Call relations**: The setup helper for filtered plugins calls this, and the marketplace list test then confirms the root is still listed.

*Call graph*: calls 1 internal fn (write_marketplace_source_with_manifest); called by 1 (setup_local_marketplace_with_explicit_empty_products).


##### `setup_local_marketplace`  (lines 118–130)

```
fn setup_local_marketplace() -> Result<(TempDir, TempDir)>
```

**Purpose**: Prepares the common happy-path test world: plugins are enabled, a valid marketplace exists, and Codex is configured to know about it.

**Data flow**: It creates temporary Codex home and source directories. It writes the plugin feature config, writes the fake marketplace files, records the marketplace in the config, and returns both temporary directories.

**Call relations**: Many plugin and marketplace tests call this first, then run CLI commands against the prepared home.

*Call graph*: calls 3 internal fn (configured_local_marketplace, write_marketplace_source, write_plugins_enabled_config); called by 15 (marketplace_list_json_prints_configured_marketplaces, marketplace_list_shows_configured_marketplace_names, plugin_add_and_remove_updates_installed_plugin_config, plugin_add_json_prints_install_outcome, plugin_add_reinstalls_from_configured_marketplace_snapshot, plugin_add_rejects_cached_plugins_without_authorizing_marketplace_snapshot, plugin_list_available_requires_json, plugin_list_hides_version_for_cached_but_unconfigured_plugin, plugin_list_json_prints_available_plugins_when_requested, plugin_list_json_prints_installed_plugins (+5 more)); 2 external calls (new, record_user_marketplace).


##### `setup_unconfigured_local_marketplace`  (lines 132–138)

```
fn setup_unconfigured_local_marketplace() -> Result<(TempDir, TempDir)>
```

**Purpose**: Creates a valid marketplace on disk but does not record it in Codex config. This models a local folder that exists but has not been trusted by the user.

**Data flow**: It creates temporary Codex home and source directories, enables plugins, writes the marketplace files, and returns both directories without registering the marketplace.

**Call relations**: Tests for rejecting unconfigured repository-local marketplaces use this before running Codex from inside the source folder.

*Call graph*: calls 2 internal fn (write_marketplace_source, write_plugins_enabled_config); called by 2 (plugin_add_rejects_unconfigured_repo_local_marketplaces, plugin_list_excludes_unconfigured_repo_local_marketplaces); 1 external calls (new).


##### `setup_local_marketplace_with_explicit_empty_products`  (lines 140–152)

```
fn setup_local_marketplace_with_explicit_empty_products() -> Result<(TempDir, TempDir)>
```

**Purpose**: Builds a configured marketplace whose plugin is filtered out by policy. It is used to prove that marketplace listing is about roots, not only visible plugins.

**Data flow**: It creates temporary home and source folders, enables plugins, writes the special manifest with an empty product list, records the marketplace, and returns the folders.

**Call relations**: The test for listing roots with filtered plugins calls this and then checks that the marketplace still appears.

*Call graph*: calls 3 internal fn (configured_local_marketplace, write_marketplace_source_with_explicit_empty_products, write_plugins_enabled_config); called by 1 (marketplace_list_includes_root_when_plugins_are_filtered_out); 2 external calls (new, record_user_marketplace).


##### `setup_configured_marketplace_without_manifest`  (lines 154–165)

```
fn setup_configured_marketplace_without_manifest() -> Result<(TempDir, TempDir)>
```

**Purpose**: Creates a marketplace configuration pointing at an empty source folder. This gives tests a controlled missing-manifest failure.

**Data flow**: It creates temporary home and source folders, enables plugins, records the source as a marketplace, but intentionally writes no marketplace manifest. It returns both folders.

**Call relations**: Marketplace and plugin listing failure tests use this setup, then verify that Codex reports the missing supported manifest clearly.

*Call graph*: calls 2 internal fn (configured_local_marketplace, write_plugins_enabled_config); called by 2 (marketplace_list_fails_when_configured_marketplace_snapshot_is_missing, plugin_list_fails_when_configured_marketplace_snapshot_is_missing); 2 external calls (new, record_user_marketplace).


##### `setup_configured_marketplace_with_malformed_manifest`  (lines 167–187)

```
fn setup_configured_marketplace_with_malformed_manifest() -> Result<(TempDir, TempDir)>
```

**Purpose**: Creates a marketplace whose manifest file exists but is invalid JSON. This checks that Codex reports bad marketplace files instead of silently ignoring them.

**Data flow**: It creates temporary folders, enables plugins, writes a broken `marketplace.json`, records the marketplace, and returns the home and source directories.

**Call relations**: Failure tests for listing and adding plugins call this before checking that the CLI explains the parse error.

*Call graph*: calls 2 internal fn (configured_local_marketplace, write_plugins_enabled_config); called by 2 (marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed, plugin_add_fails_when_configured_marketplace_snapshot_is_malformed); 4 external calls (new, record_user_marketplace, create_dir_all, write).


##### `setup_local_marketplace_with_implicit_system_roots`  (lines 189–221)

```
fn setup_local_marketplace_with_implicit_system_roots() -> Result<(TempDir, TempDir, TempDir)>
```

**Purpose**: Creates one normal configured marketplace plus fake system marketplace roots that have no manifests. This tests that Codex ignores missing manifests in special built-in locations.

**Data flow**: It starts with the standard local marketplace. Then it creates bundled and runtime marketplace directories under locations Codex treats specially, records them, creates a temporary cache home, and returns all needed folders.

**Call relations**: The system-root test calls this and then runs `plugin list` with `XDG_CACHE_HOME` set, expecting the normal marketplace to work and the empty system roots not to cause an error.

*Call graph*: calls 2 internal fn (configured_local_marketplace, setup_local_marketplace); called by 1 (plugin_list_ignores_implicit_system_marketplace_roots_without_manifests); 3 external calls (new, record_user_marketplace, create_dir_all).


##### `setup_custom_marketplace_under_implicit_system_root`  (lines 223–241)

```
fn setup_custom_marketplace_under_implicit_system_root() -> Result<(TempDir, std::path::PathBuf)>
```

**Purpose**: Creates a custom marketplace under a path that resembles a built-in system marketplace area. This checks that only known system roots get lenient missing-manifest treatment.

**Data flow**: It creates a temporary Codex home, enables plugins, creates a custom marketplace directory under `.tmp/bundled-marketplaces`, records it, and returns the home and custom path.

**Call relations**: The matching failure test uses this setup, then verifies that Codex still errors because the marketplace is custom and lacks a manifest.

*Call graph*: calls 2 internal fn (configured_local_marketplace, write_plugins_enabled_config); called by 1 (plugin_list_fails_for_custom_marketplace_under_system_root); 3 external calls (new, record_user_marketplace, create_dir_all).


##### `remove_installed_plugin_config`  (lines 243–265)

```
fn remove_installed_plugin_config(codex_home: &Path, plugin_key: &str) -> Result<()>
```

**Purpose**: Edits the test config to remove one installed plugin section while leaving cached plugin files on disk. This simulates a plugin that is present in the cache but no longer configured as installed.

**Data flow**: It receives a Codex home path and plugin key. It reads the config file, skips the matching plugin table and its lines, writes the rewritten config back, and returns success or a file error.

**Call relations**: The cached-but-unconfigured listing test calls this after installing a plugin, then checks how `plugin list` displays the leftover cache entry.

*Call graph*: called by 1 (plugin_list_hides_version_for_cached_but_unconfigured_plugin); 5 external calls (join, new, format!, read_to_string, write).


##### `setup_configured_local_marketplace_with_missing_source`  (lines 267–279)

```
fn setup_configured_local_marketplace_with_missing_source() -> Result<TempDir>
```

**Purpose**: Writes a deliberately incomplete marketplace config that says the source type is local but omits the source path. This lets the CLI error message be tested.

**Data flow**: It creates a temporary Codex home and writes a config with plugins enabled and `[marketplaces.debug]` missing its `source`. It returns the home directory.

**Call relations**: The marketplace list failure test calls this before running Codex and checking for the missing-source message.

*Call graph*: called by 1 (marketplace_list_fails_when_configured_local_marketplace_source_is_missing); 2 external calls (new, write).


##### `setup_configured_local_marketplace_with_invalid_name`  (lines 281–294)

```
fn setup_configured_local_marketplace_with_invalid_name() -> Result<TempDir>
```

**Purpose**: Writes a marketplace config with an invalid name containing a slash. This checks that Codex validates names before trusting marketplace configuration.

**Data flow**: It creates a temporary Codex home and writes a config with plugins enabled and a marketplace named `bad/name`. It returns the home directory.

**Call relations**: The invalid-name marketplace list test uses this setup and then checks that the CLI points to the bad marketplace name.

*Call graph*: called by 1 (marketplace_list_fails_when_configured_marketplace_name_is_invalid); 2 external calls (new, write).


##### `assert_configured_marketplace_snapshot_failure`  (lines 296–309)

```
fn assert_configured_marketplace_snapshot_failure(
    assert: assert_cmd::assert::Assert,
    source: &Path,
    detail: &str,
)
```

**Purpose**: Checks a common failure shape for commands that load configured marketplace snapshots. It avoids repeating the same error-message assertions in several tests.

**Data flow**: It receives a command assertion, the source path, and an expected detail message. It marks the command as expected to fail and checks standard error for the shared heading, marketplace name, path, and detail.

**Call relations**: Plugin-list and plugin-add failure tests call this after running Codex against missing or malformed configured marketplace snapshots.

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

**Purpose**: Checks a common failure shape for marketplace loading errors. It makes sure the CLI names the marketplace, shows the source path, and includes the important detail.

**Data flow**: It receives a command assertion, marketplace name, source path, and detail text. It asserts failure and verifies those pieces appear in standard error.

**Call relations**: Marketplace-list failure tests call this helper after running the command in broken marketplace configurations.

*Call graph*: called by 3 (marketplace_list_fails_when_configured_marketplace_name_is_invalid, marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed, marketplace_list_fails_when_configured_marketplace_snapshot_is_missing); 4 external calls (failure, display, format!, contains).


##### `marketplace_list_shows_configured_marketplace_names`  (lines 326–339)

```
async fn marketplace_list_shows_configured_marketplace_names() -> Result<()>
```

**Purpose**: Verifies that `codex plugin marketplace list` shows a configured marketplace in a readable table. It also checks that the table does not use tab characters.

**Data flow**: It creates a valid configured marketplace, builds the expected row, runs the list command, and checks for success, the table header, the row, and no tabs.

**Call relations**: The test runner invokes this as an async test. It relies on the standard marketplace setup, the row-format helper, and the command launcher.

*Call graph*: calls 3 internal fn (codex_command, marketplace_list_row, setup_local_marketplace); 1 external calls (contains).


##### `marketplace_list_json_prints_configured_marketplaces`  (lines 342–370)

```
async fn marketplace_list_json_prints_configured_marketplaces() -> Result<()>
```

**Purpose**: Verifies that marketplace listing can return machine-readable JSON for a configured local marketplace. This protects scripts that depend on stable output.

**Data flow**: It creates a configured marketplace, runs `plugin marketplace list --json`, parses standard output as JSON, and compares it to the exact expected object.

**Call relations**: The test runner calls it; the test uses the common setup and command helper, then hands the output to JSON parsing and equality checking.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert_eq!, from_slice).


##### `marketplace_list_json_includes_configured_git_marketplace_source`  (lines 373–417)

```
async fn marketplace_list_json_includes_configured_git_marketplace_source() -> Result<()>
```

**Purpose**: Checks that JSON marketplace output preserves the original Git source information, even though the marketplace files live in a local cache folder.

**Data flow**: It creates a cached marketplace root, writes marketplace files there, records a Git source URL in config, runs the JSON list command, parses the output, and compares it to the expected JSON.

**Call relations**: The test runner invokes it. It uses config-writing and marketplace-writing helpers, then checks that the CLI connects the cached root back to the configured Git source.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, write_plugins_enabled_config); 5 external calls (new, assert_eq!, record_user_marketplace, canonicalize_existing_preserving_symlinks, from_slice).


##### `marketplace_list_json_keys_configured_source_by_root`  (lines 420–471)

```
async fn marketplace_list_json_keys_configured_source_by_root() -> Result<()>
```

**Purpose**: Verifies that configured source metadata is attached to the correct marketplace root when two marketplaces share the same name. This prevents Codex from mixing up a home marketplace and a cached configured marketplace.

**Data flow**: It creates one marketplace in a fake home and another in Codex’s cached marketplace area, records the cached one as Git-sourced, runs JSON listing with the fake home, parses output, and compares both entries.

**Call relations**: The test runner calls it. The setup creates a possible name collision, and the CLI output is checked to ensure only the configured cached root gets `marketplaceSource`.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, write_plugins_enabled_config); 5 external calls (new, assert_eq!, record_user_marketplace, canonicalize_existing_preserving_symlinks, from_slice).


##### `marketplace_list_includes_home_marketplace_when_present`  (lines 474–491)

```
async fn marketplace_list_includes_home_marketplace_when_present() -> Result<()>
```

**Purpose**: Checks that Codex discovers a marketplace placed in the user’s home directory. This supports the simple case where a user keeps a local marketplace at home.

**Data flow**: It creates separate temporary Codex home and user home folders, writes a marketplace in the user home, enables plugins, runs marketplace listing with `HOME` set to that folder, and checks the table output.

**Call relations**: The test runner invokes it. It uses the command helper but overrides `HOME` so the CLI searches the fake user home.

*Call graph*: calls 4 internal fn (codex_command, marketplace_list_row, write_marketplace_source, write_plugins_enabled_config); 2 external calls (new, contains).


##### `marketplace_list_includes_root_when_plugins_are_filtered_out`  (lines 494–506)

```
async fn marketplace_list_includes_root_when_plugins_are_filtered_out() -> Result<()>
```

**Purpose**: Ensures marketplace listing still shows a marketplace even if its plugins are excluded by product policy. A marketplace root should not disappear just because no plugin is currently available.

**Data flow**: It creates a configured marketplace whose sample plugin has an empty products policy, runs marketplace listing, and checks that the marketplace row appears.

**Call relations**: The test runner calls it after the special setup helper creates the filtered marketplace.

*Call graph*: calls 3 internal fn (codex_command, marketplace_list_row, setup_local_marketplace_with_explicit_empty_products); 1 external calls (contains).


##### `marketplace_list_fails_when_configured_marketplace_snapshot_is_missing`  (lines 509–522)

```
async fn marketplace_list_fails_when_configured_marketplace_snapshot_is_missing() -> Result<()>
```

**Purpose**: Confirms that marketplace listing fails clearly when a configured marketplace root has no supported manifest. This prevents silent acceptance of broken configuration.

**Data flow**: It creates a configured marketplace without a manifest, runs marketplace listing, and checks that the failure names the marketplace, path, and missing-manifest problem.

**Call relations**: The test runner invokes it. It uses the missing-manifest setup and the shared marketplace failure assertion.

*Call graph*: calls 3 internal fn (assert_marketplace_failure, codex_command, setup_configured_marketplace_without_manifest).


##### `marketplace_list_fails_when_configured_marketplace_name_is_invalid`  (lines 525–538)

```
async fn marketplace_list_fails_when_configured_marketplace_name_is_invalid() -> Result<()>
```

**Purpose**: Checks that a marketplace name containing invalid characters is rejected during listing. This protects later plugin identifiers from ambiguous or unsafe names.

**Data flow**: It writes a config with the invalid marketplace name `bad/name`, runs marketplace listing, and checks that the command fails with a marketplace-name error.

**Call relations**: The test runner calls it. It uses the invalid-name setup and the shared marketplace failure checker.

*Call graph*: calls 3 internal fn (assert_marketplace_failure, codex_command, setup_configured_local_marketplace_with_invalid_name); 1 external calls (new).


##### `marketplace_list_fails_when_configured_local_marketplace_source_is_missing`  (lines 541–557)

```
async fn marketplace_list_fails_when_configured_local_marketplace_source_is_missing() -> Result<()>
```

**Purpose**: Verifies that Codex reports a useful error when a local marketplace config has no source path. Without this, users would see a vague load failure.

**Data flow**: It writes the incomplete config, runs marketplace listing, and checks standard error for the marketplace name, invalid source marker, and missing-source explanation.

**Call relations**: The test runner invokes it. It uses the missing-source setup and then directly checks the expected error text.

*Call graph*: calls 2 internal fn (codex_command, setup_configured_local_marketplace_with_missing_source); 1 external calls (contains).


##### `marketplace_list_fails_when_home_marketplace_is_malformed`  (lines 560–582)

```
async fn marketplace_list_fails_when_home_marketplace_is_malformed() -> Result<()>
```

**Purpose**: Checks that a broken marketplace manifest in the user’s home directory causes a clear listing failure. This proves home-discovered marketplaces are validated like configured ones.

**Data flow**: It creates temporary Codex home and user home folders, enables plugins, writes invalid JSON as the home marketplace manifest, runs listing with that home, and checks for the parse error.

**Call relations**: The test runner calls it. It creates the malformed file inline, then uses the command helper with a fake `HOME`.

*Call graph*: calls 2 internal fn (codex_command, write_plugins_enabled_config); 4 external calls (new, contains, create_dir_all, write).


##### `marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed`  (lines 585–598)

```
async fn marketplace_list_fails_when_configured_marketplace_snapshot_is_malformed() -> Result<()>
```

**Purpose**: Confirms that a configured marketplace with invalid JSON fails during marketplace listing. The command should explain the parse problem instead of hiding it.

**Data flow**: It creates a configured marketplace with a malformed manifest, runs marketplace listing, and checks the shared marketplace-load failure message.

**Call relations**: The test runner invokes it using the malformed-manifest setup and shared failure assertion.

*Call graph*: calls 3 internal fn (assert_marketplace_failure, codex_command, setup_configured_marketplace_with_malformed_manifest).


##### `plugin_list_prints_plugins_in_a_table`  (lines 601–625)

```
async fn plugin_list_prints_plugins_in_a_table() -> Result<()>
```

**Purpose**: Verifies that `codex plugin list` shows available plugins in a human-readable table. It checks key columns, marketplace context, plugin status, version, and path.

**Data flow**: It creates a configured marketplace, computes the expected manifest and plugin paths, runs `plugin list`, and checks standard output for the table content.

**Call relations**: The test runner calls it. It relies on the standard setup and command helper, then checks the visible CLI table.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 1 external calls (contains).


##### `plugin_list_json_prints_available_plugins_when_requested`  (lines 628–668)

```
async fn plugin_list_json_prints_available_plugins_when_requested() -> Result<()>
```

**Purpose**: Checks that `plugin list --available --json` returns available plugins as structured JSON. This protects automation that reads plugin data programmatically.

**Data flow**: It creates a configured marketplace, runs the JSON available-list command, parses standard output, and compares it to the expected installed-empty and available-one-plugin JSON.

**Call relations**: The test runner invokes it. It uses the common setup and then verifies the CLI’s JSON schema and values.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert_eq!, from_slice).


##### `plugin_list_json_includes_configured_git_marketplace_source`  (lines 671–727)

```
async fn plugin_list_json_includes_configured_git_marketplace_source() -> Result<()>
```

**Purpose**: Ensures plugin JSON output includes the Git marketplace source when the marketplace was configured from Git. This lets callers understand where a cached plugin originally came from.

**Data flow**: It creates a cached marketplace root, writes the sample plugin there, records a Git source URL, runs `plugin list --available --json`, parses output, and compares the plugin record to the expected JSON.

**Call relations**: The test runner calls it. It combines file setup, config recording, path normalization, command execution, and JSON checking.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, write_plugins_enabled_config); 5 external calls (new, assert_eq!, record_user_marketplace, canonicalize_existing_preserving_symlinks, from_slice).


##### `plugin_list_json_prints_installed_plugins`  (lines 730–775)

```
async fn plugin_list_json_prints_installed_plugins() -> Result<()>
```

**Purpose**: Verifies that once a plugin is added, JSON listing reports it as installed and enabled. This checks the connection between installation, config, and listing.

**Data flow**: It creates a marketplace, runs `plugin add`, then runs `plugin list --json`, parses the output, and checks that the sample plugin appears under `installed` with the expected fields.

**Call relations**: The test runner invokes it. It first uses the CLI to change state, then uses the CLI again to confirm that state is reflected.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert_eq!, from_slice).


##### `plugin_list_available_requires_json`  (lines 778–791)

```
async fn plugin_list_available_requires_json() -> Result<()>
```

**Purpose**: Checks the command-line rule that `--available` must be used with `--json`. This prevents ambiguous human table output for a special listing mode.

**Data flow**: It creates a normal marketplace, runs `plugin list --available` without `--json`, and checks that the command fails with an argument error mentioning `--json`.

**Call relations**: The test runner calls it. It uses normal setup but is really testing command-line argument validation.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 1 external calls (contains).


##### `plugin_list_shows_installed_version_when_plugin_is_installed`  (lines 794–811)

```
async fn plugin_list_shows_installed_version_when_plugin_is_installed() -> Result<()>
```

**Purpose**: Verifies that the human-readable plugin list shows version and installed/enabled status after installation. This gives users clear feedback about what is active.

**Data flow**: It creates a marketplace, installs the sample plugin, runs `plugin list`, and checks output for the plugin id, version `1.2.3`, and installed/enabled status.

**Call relations**: The test runner invokes it. It uses one CLI command to install and another to inspect the result.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 1 external calls (contains).


##### `plugin_list_excludes_unconfigured_repo_local_marketplaces`  (lines 814–825)

```
async fn plugin_list_excludes_unconfigured_repo_local_marketplaces() -> Result<()>
```

**Purpose**: Ensures Codex does not treat the current local repository as a trusted marketplace unless it is configured. This is a safety check against accidentally loading local plugin definitions.

**Data flow**: It creates a valid but unconfigured marketplace, runs `plugin list --marketplace debug` from inside that folder, and checks that no sample plugin is shown.

**Call relations**: The test runner calls it. It uses `codex_command_in` to simulate being inside the marketplace directory while still expecting Codex to ignore it.

*Call graph*: calls 2 internal fn (codex_command_in, setup_unconfigured_local_marketplace); 2 external calls (contains, is_match).


##### `plugin_list_fails_when_configured_marketplace_snapshot_is_missing`  (lines 828–840)

```
async fn plugin_list_fails_when_configured_marketplace_snapshot_is_missing() -> Result<()>
```

**Purpose**: Checks that plugin listing fails when a configured marketplace snapshot is missing its manifest. Installed or available plugin data should not be guessed from an invalid source.

**Data flow**: It creates a configured marketplace without a manifest, runs `plugin list`, and checks for the standard configured-snapshot failure message.

**Call relations**: The test runner invokes it. It uses the missing-manifest setup and the shared configured-snapshot failure assertion.

*Call graph*: calls 3 internal fn (assert_configured_marketplace_snapshot_failure, codex_command, setup_configured_marketplace_without_manifest).


##### `plugin_list_ignores_implicit_system_marketplace_roots_without_manifests`  (lines 843–866)

```
async fn plugin_list_ignores_implicit_system_marketplace_roots_without_manifests() -> Result<()>
```

**Purpose**: Verifies that empty built-in system marketplace roots do not break plugin listing. Codex may create or know about these special locations before they contain a manifest.

**Data flow**: It creates a normal marketplace plus empty bundled/runtime roots, runs `plugin list` with a fake cache home, and checks that the normal marketplace appears and no configured-snapshot error is printed.

**Call relations**: The test runner calls it. The special setup creates both real and empty system-like roots so the CLI’s exception behavior can be tested.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace_with_implicit_system_roots); 1 external calls (contains).


##### `plugin_list_fails_for_custom_marketplace_under_system_root`  (lines 869–886)

```
async fn plugin_list_fails_for_custom_marketplace_under_system_root() -> Result<()>
```

**Purpose**: Checks that a custom marketplace placed under a system-like directory is not given the same lenient treatment as known built-in roots. Missing manifests should still fail for custom marketplaces.

**Data flow**: It creates and records a custom marketplace under `.tmp/bundled-marketplaces` without a manifest, runs `plugin list`, and checks the failure details.

**Call relations**: The test runner invokes it after the custom-root setup helper prepares the edge case.

*Call graph*: calls 2 internal fn (codex_command, setup_custom_marketplace_under_implicit_system_root); 1 external calls (contains).


##### `plugin_list_hides_version_for_cached_but_unconfigured_plugin`  (lines 889–908)

```
async fn plugin_list_hides_version_for_cached_but_unconfigured_plugin() -> Result<()>
```

**Purpose**: Ensures a plugin left in the cache but removed from config is not shown as a normal installed plugin with a trusted version. This avoids giving stale cache data too much authority.

**Data flow**: It creates a marketplace, installs the plugin, removes that plugin’s config section while leaving files in place, runs `plugin list`, and checks that the plugin is marked not installed and its version is hidden.

**Call relations**: The test runner calls it. It uses the config-removal helper to create a state that could happen after manual config edits or partial cleanup.

*Call graph*: calls 3 internal fn (codex_command, remove_installed_plugin_config, setup_local_marketplace); 1 external calls (contains).


##### `plugin_add_and_remove_updates_installed_plugin_config`  (lines 911–935)

```
async fn plugin_add_and_remove_updates_installed_plugin_config() -> Result<()>
```

**Purpose**: Verifies that adding a plugin writes an installed-plugin section to config and removing it deletes that section. This checks the durable state Codex uses between runs.

**Data flow**: It creates a marketplace, runs `plugin add`, reads the config to confirm the plugin table exists, runs `plugin remove`, reads the config again, and confirms the table is gone.

**Call relations**: The test runner invokes it. The CLI is used for both operations, while direct file reading confirms the persistent config changed correctly.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 3 external calls (assert!, contains, read_to_string).


##### `plugin_add_json_prints_install_outcome`  (lines 938–963)

```
async fn plugin_add_json_prints_install_outcome() -> Result<()>
```

**Purpose**: Checks that `plugin add --json` reports the installed plugin details in a stable machine-readable form. This includes the final cache path and auth policy.

**Data flow**: It creates a marketplace, runs the add command with JSON output, parses standard output, normalizes the expected installed path, and compares the JSON object exactly.

**Call relations**: The test runner calls it. It uses setup and command execution, then path normalization so the expected path matches the filesystem’s real form.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 3 external calls (assert_eq!, canonicalize_existing_preserving_symlinks, from_slice).


##### `plugin_remove_json_prints_remove_outcome`  (lines 966–998)

```
async fn plugin_remove_json_prints_remove_outcome() -> Result<()>
```

**Purpose**: Verifies that `plugin remove --json` reports which plugin was removed. This gives scripts a clear confirmation without parsing human text.

**Data flow**: It creates a marketplace, installs the plugin, removes it with JSON output, parses standard output, and compares it to the expected plugin identity object.

**Call relations**: The test runner invokes it. It first creates installed state with `plugin add`, then checks the removal command’s structured response.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert_eq!, from_slice).


##### `plugin_add_rejects_unconfigured_repo_local_marketplaces`  (lines 1001–1013)

```
async fn plugin_add_rejects_unconfigured_repo_local_marketplaces() -> Result<()>
```

**Purpose**: Ensures Codex refuses to add a plugin from a local marketplace that exists only because the command is run inside its folder. The marketplace must be configured first.

**Data flow**: It creates a valid but unconfigured marketplace, runs `plugin add sample@debug` from that directory, and checks for a not-found error.

**Call relations**: The test runner calls it. It uses `codex_command_in` to test the current-directory edge case.

*Call graph*: calls 2 internal fn (codex_command_in, setup_unconfigured_local_marketplace); 1 external calls (contains).


##### `plugin_add_fails_when_configured_marketplace_snapshot_is_malformed`  (lines 1016–1028)

```
async fn plugin_add_fails_when_configured_marketplace_snapshot_is_malformed() -> Result<()>
```

**Purpose**: Checks that adding a plugin fails if the configured marketplace snapshot has invalid JSON. Codex should not install from a source it cannot parse.

**Data flow**: It creates a configured marketplace with a malformed manifest, runs `plugin add sample@debug`, and checks for the standard configured-snapshot failure message.

**Call relations**: The test runner invokes it. It uses the malformed setup helper and the shared failure assertion.

*Call graph*: calls 3 internal fn (assert_configured_marketplace_snapshot_failure, codex_command, setup_configured_marketplace_with_malformed_manifest).


##### `plugin_add_reinstalls_from_configured_marketplace_snapshot`  (lines 1031–1053)

```
async fn plugin_add_reinstalls_from_configured_marketplace_snapshot() -> Result<()>
```

**Purpose**: Verifies that running `plugin add` for an already installed plugin succeeds and refreshes the cached plugin files. Reinstalling should be a safe repeat operation.

**Data flow**: It creates a marketplace, adds the sample plugin, adds it again, checks for the success message, and confirms the cached plugin metadata file exists.

**Call relations**: The test runner calls it. The test uses the CLI twice to prove installation is repeatable.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert!, contains).


##### `plugin_remove_works_after_marketplace_is_removed`  (lines 1056–1081)

```
async fn plugin_remove_works_after_marketplace_is_removed() -> Result<()>
```

**Purpose**: Ensures an installed plugin can still be removed after its marketplace has been removed from config. Users should be able to clean up installed plugins even if the source is gone.

**Data flow**: It creates and installs a plugin, removes the marketplace, removes the plugin by id, checks the success message, then reads config to confirm the plugin section was deleted.

**Call relations**: The test runner invokes it. It uses marketplace removal as a middle step, then proves plugin removal does not depend on the marketplace still being configured.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 3 external calls (assert!, contains, read_to_string).


##### `plugin_add_rejects_cached_plugins_without_authorizing_marketplace_snapshot`  (lines 1084–1114)

```
async fn plugin_add_rejects_cached_plugins_without_authorizing_marketplace_snapshot() -> Result<()>
```

**Purpose**: Checks that cached plugin files alone are not enough to authorize installation. Codex must still have a configured marketplace snapshot that says the plugin is valid.

**Data flow**: It creates a marketplace, installs the plugin so files exist in the cache, removes the marketplace config, confirms the cached file remains, then tries to add again and expects a not-found error.

**Call relations**: The test runner calls it. It links several CLI actions to test the security boundary between cache contents and trusted marketplace configuration.

*Call graph*: calls 2 internal fn (codex_command, setup_local_marketplace); 2 external calls (assert!, contains).


### `cli/tests/marketplace_add.rs`

`test` · `test run`

This is an integration test file, meaning it runs the real `codex` command-line program instead of testing one small function in isolation. Its job is to prove that a user can add a plugin marketplace from a local directory and that Codex records that marketplace correctly in its configuration file. Think of it like a rehearsal with a temporary empty home folder: the test creates a fake marketplace on disk, runs the actual command, then looks at what the command printed and wrote.

The helper code builds a small marketplace folder containing a marketplace manifest and one sample plugin. Each test uses temporary directories so it does not touch the developer’s real files. The tests set `CODEX_HOME` to that temporary folder, so the command behaves as if it is running for a fresh user.

The file checks several important promises. A local marketplace directory should be saved in the config as a local source, not copied into the normal installed-marketplace location. With `--json`, the command should print a machine-readable summary. If the user points at the manifest file instead of the containing directory, Codex should reject it with a useful message. And if the user asks for `--sparse`, Codex should explain that sparse checkout only makes sense for git-based marketplaces, not plain local folders.

#### Function details

##### `codex_command`  (lines 11–15)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper prepares a command object for running the real `codex` binary in a test. It also sets `CODEX_HOME`, which tells Codex to use a temporary home directory instead of the user’s real one.

**Data flow**: It receives the path to a temporary Codex home folder. It finds the built `codex` executable, creates a test command for it, adds the `CODEX_HOME` environment variable, and returns that ready-to-customize command to the test.

**Call relations**: Each test calls this helper right before running the command-line scenario it cares about. The helper supplies the common setup, and the individual tests then add their own current directory and command arguments before checking success or failure.

*Call graph*: called by 4 (marketplace_add_json_prints_add_outcome, marketplace_add_local_directory_source, marketplace_add_rejects_local_manifest_file_source, marketplace_add_rejects_sparse_for_local_directory_source); 2 external calls (new, cargo_bin).


##### `write_marketplace_source`  (lines 17–41)

```
fn write_marketplace_source(source: &Path, marker: &str) -> Result<()>
```

**Purpose**: This helper creates a tiny fake marketplace folder on disk. Tests use it as sample input for the marketplace-add command.

**Data flow**: It receives a folder path and a marker string. It creates the expected marketplace and plugin directories, writes a marketplace manifest that names a `debug` marketplace with one `sample` plugin, writes the plugin’s own metadata file, and writes a marker text file inside the plugin folder.

**Call relations**: The marketplace-add tests call this before running `codex`. It gives the command a realistic local marketplace to inspect, so the later assertions can focus on what Codex did with that source.

*Call graph*: called by 4 (marketplace_add_json_prints_add_outcome, marketplace_add_local_directory_source, marketplace_add_rejects_local_manifest_file_source, marketplace_add_rejects_sparse_for_local_directory_source); 3 external calls (join, create_dir_all, write).


##### `marketplace_add_local_directory_source`  (lines 44–73)

```
async fn marketplace_add_local_directory_source() -> Result<()>
```

**Purpose**: This test proves that adding a marketplace from a local directory succeeds and records the correct local path in Codex’s configuration. It also checks that Codex does not copy the local marketplace into the installed marketplace area.

**Data flow**: It creates a temporary Codex home and a temporary fake marketplace. It runs `codex plugin marketplace add` using a relative path to that marketplace. After the command succeeds, it checks that no installed copy was created, reads the generated config file, and confirms that the `debug` marketplace is stored as a local source pointing to the canonical directory path.

**Call relations**: This is one of the main happy-path tests. It relies on `write_marketplace_source` to create the input marketplace and `codex_command` to run the real CLI in an isolated home. It then uses the project’s marketplace install-root helper and config file name to verify Codex’s observable results.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, marketplace_install_root); 6 external calls (new, assert!, assert_eq!, format!, read_to_string, from_str).


##### `marketplace_add_json_prints_add_outcome`  (lines 76–108)

```
async fn marketplace_add_json_prints_add_outcome() -> Result<()>
```

**Purpose**: This test checks the command’s JSON output mode. JSON is a structured text format that other programs can read reliably, so this matters for scripts and automation.

**Data flow**: It creates a temporary Codex home and fake local marketplace, then runs the add command with `--json`. It reads the command’s standard output, parses it as JSON, and compares it to the expected summary: the marketplace name, the local directory used as the installed root, and a flag saying this marketplace was not already added.

**Call relations**: Like the other success test, it uses `write_marketplace_source` for the fake marketplace and `codex_command` for the isolated CLI run. Its focus is not the config file, but the machine-readable result handed back to the caller.

*Call graph*: calls 3 internal fn (codex_command, write_marketplace_source, try_from); 4 external calls (new, assert_eq!, format!, from_slice).


##### `marketplace_add_rejects_local_manifest_file_source`  (lines 111–131)

```
async fn marketplace_add_rejects_local_manifest_file_source() -> Result<()>
```

**Purpose**: This test makes sure Codex rejects a common mistake: passing the marketplace manifest file itself instead of the marketplace directory. The error message should tell the user what went wrong.

**Data flow**: It creates a temporary Codex home and fake marketplace, then points the add command directly at `.agents/plugins/marketplace.json`. The expected result is command failure, and the test checks that standard error contains the message saying a local marketplace source must be a directory, not a file.

**Call relations**: This is a negative-path test. It uses the same fake marketplace setup as the success cases, but deliberately gives the CLI the wrong path so it can verify Codex fails safely and explains the problem.

*Call graph*: calls 2 internal fn (codex_command, write_marketplace_source); 2 external calls (new, contains).


##### `marketplace_add_rejects_sparse_for_local_directory_source`  (lines 134–155)

```
async fn marketplace_add_rejects_sparse_for_local_directory_source() -> Result<()>
```

**Purpose**: This test confirms that `--sparse` is rejected for local marketplace folders. Sparse checkout means fetching only part of a git repository, so it does not apply to an ordinary local directory.

**Data flow**: It creates a temporary Codex home and fake marketplace, then runs the add command with `--sparse .agents` against the local directory. The command is expected to fail, and the test checks that the error text explains that sparse mode is only supported for git marketplace sources.

**Call relations**: This negative-path test again uses `write_marketplace_source` and `codex_command` for setup. It protects the command-line behavior around an option that is valid in one kind of source but invalid for local directory sources.

*Call graph*: calls 2 internal fn (codex_command, write_marketplace_source); 2 external calls (new, contains).


### `cli/tests/marketplace_remove.rs`

`test` · `test run`

This is a test file for the Codex command-line tool. A “marketplace” here is a configured source of plugins, and the remove command is supposed to forget that source and delete its local installed copy. These tests create a temporary Codex home folder, like giving the command a fresh fake user account to work inside, so the real machine is not changed.

The file sets up two pieces of fake state: a marketplace entry in `config.toml`, and a matching installed marketplace folder on disk with a small marker file. It then runs the real `codex` binary with `CODEX_HOME` pointed at the temporary folder. That matters because these tests exercise the command as a user would run it, not just an internal function.

There are three main behaviors being checked. First, a normal remove should print a friendly success message, delete the marketplace’s config section, and remove its installed folder. Second, when `--json` is passed, the command should print machine-readable JSON with the marketplace name and the exact installed path that was removed. Third, trying to remove a marketplace that is neither configured nor installed should fail with a clear error. Together, these tests protect both the user-facing behavior and the cleanup side effects.

#### Function details

##### `codex_command`  (lines 12–16)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper prepares a command that runs the real `codex` executable in a controlled test home folder. Tests use it so every command reads and writes only inside a temporary directory.

**Data flow**: It receives the path to a temporary Codex home folder. It finds the compiled `codex` binary, creates a command object for it, sets the `CODEX_HOME` environment variable to the given folder, and returns the ready-to-customize command.

**Call relations**: Each test calls this helper right before running the remove command. The helper hides the repeated setup work, then the tests add command-line arguments and assert whether the process succeeds or fails.

*Call graph*: called by 3 (marketplace_remove_deletes_config_and_installed_root, marketplace_remove_json_prints_remove_outcome, marketplace_remove_rejects_unknown_marketplace); 2 external calls (new, cargo_bin).


##### `configured_marketplace_update`  (lines 18–27)

```
fn configured_marketplace_update() -> MarketplaceConfigUpdate<'static>
```

**Purpose**: This helper creates a standard fake marketplace configuration record for the tests. It gives the tests a consistent marketplace source to write into the temporary config file.

**Data flow**: It takes no input. It builds a marketplace update value containing fixed details such as a Git source URL, a branch name, and a last-updated timestamp, then returns that value for use when writing test configuration.

**Call relations**: The success-case tests call this before recording a marketplace in the temporary Codex home. That prepared config is what the remove command later has to delete.

*Call graph*: called by 2 (marketplace_remove_deletes_config_and_installed_root, marketplace_remove_json_prints_remove_outcome).


##### `write_installed_marketplace`  (lines 29–35)

```
fn write_installed_marketplace(codex_home: &Path, marketplace_name: &str) -> Result<()>
```

**Purpose**: This helper creates a fake installed marketplace folder on disk. It gives the remove command real files to delete during the test.

**Data flow**: It receives the temporary Codex home path and a marketplace name. It calculates where that marketplace should be installed, creates the expected plugin metadata directory, writes a minimal `marketplace.json`, writes a marker file, and returns success if all disk writes worked.

**Call relations**: The success-case tests call this after adding marketplace configuration. It prepares the installed-folder side of the setup, so the remove command can prove it cleans up both configuration and files.

*Call graph*: calls 1 internal fn (marketplace_install_root); called by 2 (marketplace_remove_deletes_config_and_installed_root, marketplace_remove_json_prints_remove_outcome); 2 external calls (create_dir_all, write).


##### `marketplace_remove_deletes_config_and_installed_root`  (lines 38–58)

```
async fn marketplace_remove_deletes_config_and_installed_root() -> Result<()>
```

**Purpose**: This test checks the normal human-facing remove path. It verifies that removing a marketplace succeeds, prints a friendly message, removes the config entry, and deletes the installed directory.

**Data flow**: It starts with a fresh temporary Codex home. It writes a marketplace config entry and a fake installed marketplace folder, runs `codex plugin marketplace remove debug`, then reads the config file and checks the installed folder path. The expected end state is no `[marketplaces.debug]` entry and no installed `debug` directory.

**Call relations**: This is one of the main test scenarios. It uses the setup helpers to create a realistic marketplace, calls the `codex` binary through `codex_command`, and then directly inspects disk state to confirm the command did the full cleanup.

*Call graph*: calls 3 internal fn (codex_command, configured_marketplace_update, write_installed_marketplace); 5 external calls (new, assert!, record_user_marketplace, contains, read_to_string).


##### `marketplace_remove_json_prints_remove_outcome`  (lines 61–84)

```
async fn marketplace_remove_json_prints_remove_outcome() -> Result<()>
```

**Purpose**: This test checks the machine-readable output mode for marketplace removal. It ensures `--json` prints the marketplace name and the removed install path in the exact JSON shape expected by other tools.

**Data flow**: It creates a temporary Codex home, records a fake marketplace, and writes its installed folder. It calculates the normalized installed path, runs `codex plugin marketplace remove debug --json`, parses the command’s standard output as JSON, and compares it with the expected JSON object.

**Call relations**: This test follows the same setup path as the normal remove test, but focuses on output rather than checking the remaining files afterward. It uses the path-normalizing helper so the expected path matches how the command reports paths.

*Call graph*: calls 4 internal fn (codex_command, configured_marketplace_update, write_installed_marketplace, marketplace_install_root); 5 external calls (new, assert_eq!, record_user_marketplace, canonicalize_existing_preserving_symlinks, from_slice).


##### `marketplace_remove_rejects_unknown_marketplace`  (lines 87–99)

```
async fn marketplace_remove_rejects_unknown_marketplace() -> Result<()>
```

**Purpose**: This test checks the error path. It makes sure the command refuses to remove a marketplace that does not exist in configuration or on disk, and that the error message explains the problem.

**Data flow**: It starts with an empty temporary Codex home and runs `codex plugin marketplace remove debug`. Because nothing named `debug` was configured or installed, the expected result is a failed command with an error message saying the marketplace is not configured or installed.

**Call relations**: Unlike the other tests, this one deliberately skips the setup helpers that create a marketplace. It calls the command helper directly and verifies that the command reports a clean failure instead of pretending the remove succeeded.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


### `cli/tests/marketplace_upgrade.rs`

`test` · `test run`

This is a small integration test file for the `codex` command-line tool. Instead of calling internal Rust functions directly, it starts the real `codex` binary the way a user would run it in a terminal. That matters because these tests check the public command layout and output, which are the parts users and scripts rely on.

Each test creates a fresh temporary `CODEX_HOME`, which is the directory Codex uses as its home/config area. This keeps the test environment empty and isolated, like giving each test a brand-new desk with no old papers on it. In that empty setup, there are no configured Git marketplaces, so the upgrade command should report that there is nothing to upgrade.

The file checks three important promises. First, `codex plugin marketplace upgrade` succeeds and prints a human-readable message. Second, the same command with `--json` succeeds and prints a machine-readable result with empty lists for selected marketplaces, upgraded roots, and errors. Third, the old top-level form, `codex marketplace upgrade`, no longer works and is rejected as an unrecognized subcommand. Together, these tests protect both user-facing text and automation-friendly JSON behavior.

#### Function details

##### `codex_command`  (lines 8–12)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper builds a command object for running the real `codex` executable in a test. It also points `CODEX_HOME` at a chosen temporary directory so each test runs with its own clean configuration area.

**Data flow**: It receives a filesystem path for the temporary Codex home directory. It finds the compiled `codex` binary, creates a command ready to run it, sets the `CODEX_HOME` environment variable on that command, and returns the prepared command or an error if the binary cannot be found.

**Call relations**: The three tests call this helper before adding their own command-line arguments. It centralizes the setup step so each test starts the same way: with a real `codex` process aimed at an isolated home directory.

*Call graph*: called by 3 (marketplace_upgrade_json_prints_upgrade_outcome, marketplace_upgrade_no_longer_runs_at_top_level, marketplace_upgrade_runs_under_plugin); 2 external calls (new, cargo_bin).


##### `marketplace_upgrade_runs_under_plugin`  (lines 15–25)

```
async fn marketplace_upgrade_runs_under_plugin() -> Result<()>
```

**Purpose**: This test proves that the marketplace upgrade command is available in its intended location: under `plugin marketplace`. It checks the normal, human-readable output when there is nothing to upgrade.

**Data flow**: It creates a new temporary Codex home, builds a `codex` command using that directory, and runs `plugin marketplace upgrade`. Because the temporary home has no marketplace configuration, it expects the command to succeed and print a message saying there are no configured Git marketplaces to upgrade.

**Call relations**: This test relies on `codex_command` to create the isolated command. It then uses the command assertion tools to run the real CLI and check both the exit result and the text shown to the user.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


##### `marketplace_upgrade_json_prints_upgrade_outcome`  (lines 28–48)

```
async fn marketplace_upgrade_json_prints_upgrade_outcome() -> Result<()>
```

**Purpose**: This test checks the automation-friendly JSON form of the marketplace upgrade command. It makes sure scripts can read a stable, structured result when no marketplaces are configured.

**Data flow**: It creates a fresh temporary Codex home, runs `codex plugin marketplace upgrade --json`, and captures the command's standard output. It parses that output as JSON and compares it with the expected object: no selected marketplaces, no upgraded roots, and no errors.

**Call relations**: Like the other tests, it starts by calling `codex_command` for a clean CLI run. After the command succeeds, it hands the captured bytes to JSON parsing and uses an equality assertion to verify the exact structured response.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (new, assert_eq!, from_slice).


##### `marketplace_upgrade_no_longer_runs_at_top_level`  (lines 51–61)

```
async fn marketplace_upgrade_no_longer_runs_at_top_level() -> Result<()>
```

**Purpose**: This test makes sure the old or unintended command shape, `codex marketplace upgrade`, is not accepted. It protects the command-line interface from accidentally reintroducing a confusing top-level shortcut.

**Data flow**: It creates a fresh temporary Codex home, builds a `codex` command, and runs `marketplace upgrade` without the `plugin` prefix. The expected result is failure, with an error message saying `upgrade` is an unrecognized subcommand.

**Call relations**: The test uses `codex_command` for the same isolated setup as the successful cases. It then checks the failure path, complementing the other tests by confirming not just where the command works, but also where it should not work.

*Call graph*: calls 1 internal fn (codex_command); 2 external calls (new, contains).


### MCP management commands
These tests validate MCP server configuration lifecycle commands, from adding and removing entries to listing and inspecting them in text and JSON forms.

### `cli/tests/mcp_add_remove.rs`

`test` · `test suite`

This is an automated test file for the Codex command-line app. MCP means “Model Context Protocol,” a way for Codex to connect to external tools or services. These tests treat the `codex` binary like a real user would: they create a temporary Codex home folder, run commands such as `codex mcp add ...`, then inspect the saved configuration to make sure the command did the right thing.

The temporary folder is important. It acts like a clean, throwaway user profile, so the tests do not touch a developer’s real settings. After each command runs, the tests load the global MCP server configuration from that folder and compare it with what should have been saved.

The file covers two main kinds of MCP servers. One kind starts a local command through standard input/output, like running `echo hello`. The other connects to a web URL using “streamable HTTP,” which means communication happens over regular web requests in a streaming-friendly format. The tests also check environment variables, OAuth-related settings, removed command flags, and invalid combinations of options.

In short, this file is a safety net for the CLI. If a future change breaks how MCP servers are added or removed, these tests should catch it before users do.

#### Function details

##### `codex_command`  (lines 10–14)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper creates a command object that runs the `codex` binary with a specific temporary Codex home folder. Tests use it so every command reads and writes settings in an isolated place.

**Data flow**: It receives a path to a temporary Codex home folder. It finds the built `codex` executable, creates a command runner for it, sets the `CODEX_HOME` environment variable to the given path, and returns that ready-to-use command runner.

**Call relations**: All the tests call this helper before running the CLI. It hands each test a prepared `codex` command so the test can add arguments, execute it, and then inspect the resulting configuration.

*Call graph*: called by 8 (add_and_remove_server_updates_global_config, add_cant_add_command_and_url, add_streamable_http_rejects_removed_flag, add_streamable_http_with_custom_env_var, add_streamable_http_with_oauth_options, add_streamable_http_without_manual_token, add_with_env_preserves_key_order_and_values, profile_mcp_reports_legacy_profile_migration); 2 external calls (new, cargo_bin).


##### `add_and_remove_server_updates_global_config`  (lines 17–69)

```
async fn add_and_remove_server_updates_global_config() -> Result<()>
```

**Purpose**: This test checks the basic happy path: adding a local MCP server writes it to global config, removing it deletes it, and removing it again gives a harmless “not found” message.

**Data flow**: It starts with an empty temporary Codex home folder. It runs `codex mcp add docs -- echo hello`, then loads the saved MCP server list and checks that one enabled server named `docs` exists with command `echo` and argument `hello`. Next it runs `codex mcp remove docs`, reloads the server list, and checks that it is empty. Finally it removes `docs` again and confirms the command succeeds without recreating anything.

**Call relations**: The test uses `codex_command` to run the real CLI, then uses `load_global_mcp_servers` to read back what the CLI wrote. It relies on output text checks to confirm the user-facing messages match the expected add, remove, and not-found cases.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 5 external calls (new, assert!, assert_eq!, panic!, contains).


##### `profile_mcp_reports_legacy_profile_migration`  (lines 72–91)

```
async fn profile_mcp_reports_legacy_profile_migration() -> Result<()>
```

**Purpose**: This test makes sure the CLI gives a clear error when someone tries to use `mcp` commands with an old-style profile configuration. It protects users from silently editing the wrong settings file.

**Data flow**: It creates a temporary Codex home folder and writes a `config.toml` file containing a legacy `[profiles.work]` section. It then runs `codex --profile work mcp list` and expects the command to fail. The failure message must mention that `--profile work` cannot be used, point to `[profiles.work]`, and suggest the newer `work.config.toml` style.

**Call relations**: The test calls `codex_command` to run the CLI against the temporary folder. It writes the setup file directly, then checks the command’s standard error output for the migration guidance users should see.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (new, contains, write).


##### `add_with_env_preserves_key_order_and_values`  (lines 94–127)

```
async fn add_with_env_preserves_key_order_and_values() -> Result<()>
```

**Purpose**: This test checks that environment variables passed during `mcp add` are saved correctly. This matters because MCP servers often need tokens, paths, or feature flags in their environment.

**Data flow**: It runs `codex mcp add envy` with two `--env` values, `FOO=bar` and `ALPHA=beta`, followed by a local command `python server.py`. It then loads the saved MCP configuration, finds the `envy` server, and checks that both environment entries are present with the right values and that the server is enabled.

**Call relations**: The test uses `codex_command` to execute the add command and `load_global_mcp_servers` to inspect the stored result. If the CLI parser or config writer changes how environment variables are stored, this test is meant to catch that.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 4 external calls (new, assert!, assert_eq!, panic!).


##### `add_streamable_http_without_manual_token`  (lines 130–161)

```
async fn add_streamable_http_without_manual_token() -> Result<()>
```

**Purpose**: This test checks that adding an HTTP-based MCP server without any manual token option creates a clean web-server configuration. It also confirms the command does not create credential files unnecessarily.

**Data flow**: It starts with an empty temporary Codex home folder and runs `codex mcp add github --url https://example.com/mcp`. It loads the saved server list and confirms that `github` uses the streamable HTTP transport with the exact URL and no bearer token environment variable or extra HTTP headers. It also checks that `.credentials.json` and `.env` were not created.

**Call relations**: The test gets a prepared CLI command from `codex_command`, then reads the result through `load_global_mcp_servers`. It connects the command-line behavior to the saved config and to the absence of side-effect files.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 4 external calls (new, assert!, assert_eq!, panic!).


##### `add_streamable_http_with_custom_env_var`  (lines 164–199)

```
async fn add_streamable_http_with_custom_env_var() -> Result<()>
```

**Purpose**: This test checks that users can tell an HTTP MCP server which environment variable should contain its bearer token. A bearer token is a secret string used to prove access to a service.

**Data flow**: It runs `codex mcp add issues --url https://example.com/issues --bearer-token-env-var GITHUB_TOKEN`. It then loads the configuration, finds the `issues` server, and checks that the URL is saved and that the bearer token environment variable name is `GITHUB_TOKEN`. It also confirms there are no extra header settings and that the server is enabled.

**Call relations**: The test uses `codex_command` for the real CLI call and `load_global_mcp_servers` to verify the stored configuration. It focuses on the handoff from a command-line flag into the HTTP transport settings.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 4 external calls (new, assert!, assert_eq!, panic!).


##### `add_streamable_http_with_oauth_options`  (lines 202–235)

```
async fn add_streamable_http_with_oauth_options() -> Result<()>
```

**Purpose**: This test checks that OAuth-related options are saved for an HTTP MCP server. OAuth is a common sign-in and authorization flow used by web services.

**Data flow**: It runs `codex mcp add oauth-server` with a URL, an OAuth client ID, and an OAuth resource URL. After loading the saved MCP servers, it finds `oauth-server` and checks that the OAuth client ID and resource were stored exactly as provided.

**Call relations**: The test gets its command runner from `codex_command` and reads back the resulting configuration with `load_global_mcp_servers`. It confirms that OAuth command-line options make it all the way into the saved server definition.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 2 external calls (new, assert_eq!).


##### `add_streamable_http_rejects_removed_flag`  (lines 238–259)

```
async fn add_streamable_http_rejects_removed_flag() -> Result<()>
```

**Purpose**: This test makes sure an old removed flag, `--with-bearer-token`, is rejected instead of being accepted silently. That helps prevent users from thinking they configured authentication when they did not.

**Data flow**: It runs `codex mcp add github --url https://example.com/mcp --with-bearer-token` in a temporary Codex home folder. The command is expected to fail and print an error mentioning the removed flag. The test then loads the server list and checks that no server was saved.

**Call relations**: The test uses `codex_command` to exercise the CLI parser and `load_global_mcp_servers` to confirm failure left no configuration behind. It ties an invalid user input directly to both the error message and the absence of side effects.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 3 external calls (new, assert!, contains).


##### `add_cant_add_command_and_url`  (lines 262–286)

```
async fn add_cant_add_command_and_url() -> Result<()>
```

**Purpose**: This test checks that users cannot mix two different ways of defining an MCP server: a local command and a web URL. The CLI should force one clear transport choice.

**Data flow**: It runs an `mcp add` command that includes both `--url https://example.com/mcp` and a command-style setup with `echo hello`. The command is expected to fail with an error about the unexpected `--command` argument. The test then loads the MCP configuration and verifies that nothing was saved.

**Call relations**: The test calls `codex_command` to run the invalid CLI input and `load_global_mcp_servers` afterward to check that the failed command did not modify global config. It guards the boundary where command-line parsing decides which MCP transport style is allowed.

*Call graph*: calls 2 internal fn (codex_command, load_global_mcp_servers); 3 external calls (new, assert!, contains).


### `cli/tests/mcp_list.rs`

`test` · `test run`

This is an integration test file. Instead of testing one small function in isolation, it runs the real `codex` command-line program in a temporary home folder, much like a user would. MCP here means “Model Context Protocol,” a way for Codex to connect to external helper servers. The tests make sure the CLI behaves correctly when there are no MCP servers, when one server exists, and when a server has been disabled.

The temporary `CODEX_HOME` folder is important. It gives each test a clean, throwaway configuration area, like testing a recipe in a fresh kitchen so old ingredients cannot affect the result. The helper `codex_command` creates a command that runs the built `codex` binary with that temporary home set.

The tests check both friendly text output and machine-readable JSON output. The friendly output must mask secrets such as `TOKEN=secret` as `TOKEN=*****`, so users can safely copy terminal output without leaking private values. The JSON output, however, is expected to contain the real saved configuration, because tools may need exact data. The file also edits the saved MCP config directly to test details that are harder to create through the CLI alone, such as inherited environment variable names and disabled servers.

#### Function details

##### `codex_command`  (lines 14–18)

```
fn codex_command(codex_home: &Path) -> Result<assert_cmd::Command>
```

**Purpose**: This helper creates a ready-to-run `codex` command for a test. It points the command at a temporary `CODEX_HOME`, so each test uses its own isolated configuration instead of the developer’s real files.

**Data flow**: It receives the path to a temporary Codex home folder. It finds the compiled `codex` binary, creates a command object for it, sets the `CODEX_HOME` environment variable on that command, and returns the prepared command. If finding the binary fails, it returns an error instead.

**Call relations**: The three tests call this whenever they need to run the CLI. It wraps the lower-level command creation and binary lookup, so the test bodies can focus on the MCP behavior they are checking rather than repeating setup code.

*Call graph*: called by 3 (get_disabled_server_shows_single_line, list_and_get_render_expected_output, list_shows_empty_state); 2 external calls (new, cargo_bin).


##### `list_shows_empty_state`  (lines 21–31)

```
fn list_shows_empty_state() -> Result<()>
```

**Purpose**: This test confirms that `codex mcp list` gives a helpful message when no MCP servers have been configured. Without this behavior, a new user might see a blank or confusing result.

**Data flow**: It starts with a brand-new temporary Codex home folder. It builds a `codex` command for that folder, runs `mcp list`, reads the command’s standard output as text, and checks that the command succeeded and printed `No MCP servers configured yet.` Nothing lasting is written outside the temporary folder.

**Call relations**: This test uses `codex_command` to run the real CLI in an isolated setup. It then relies on normal process output and assertions to verify the user-facing empty-state message.

*Call graph*: calls 1 internal fn (codex_command); 3 external calls (from_utf8, new, assert!).


##### `list_and_get_render_expected_output`  (lines 34–139)

```
async fn list_and_get_render_expected_output() -> Result<()>
```

**Purpose**: This test checks the main happy path for MCP display commands: add a server, list it, fetch it by name, and verify both text and JSON forms. It also verifies that secrets are hidden in text output but preserved in JSON configuration output.

**Data flow**: It begins with an empty temporary Codex home. It runs `codex mcp add docs` to save a server named `docs` with a command, arguments, and an environment secret. It then loads the saved MCP server configuration, edits it to include extra environment variable names, and writes the updated configuration back. After that it runs `mcp list`, `mcp list --json`, `mcp get docs`, and `mcp get docs --json`. The test checks that human-readable output includes the expected names, commands, status fields, and masked secrets, while the JSON output exactly matches the expected structured data.

**Call relations**: This test repeatedly calls `codex_command` to run separate CLI invocations against the same temporary home folder, so each command sees the configuration written by the previous one. It also calls `load_global_mcp_servers` and uses `ConfigEditsBuilder` to adjust the saved config before checking how the list and get commands render it.

*Call graph*: calls 3 internal fn (codex_command, new, load_global_mcp_servers); 8 external calls (from_utf8, new, assert!, assert_eq!, panic!, contains, from_str, vec!).


##### `get_disabled_server_shows_single_line`  (lines 142–166)

```
async fn get_disabled_server_shows_single_line() -> Result<()>
```

**Purpose**: This test verifies the special display for a disabled MCP server. When a server is disabled, `codex mcp get` should show a short single-line summary instead of the full server details.

**Data flow**: It creates a temporary Codex home, runs the CLI to add a `docs` MCP server, then loads the saved server configuration. It changes the server’s `enabled` flag to false and writes the configuration back. Finally it runs `codex mcp get docs`, reads the output, and checks that the trimmed output is exactly `docs (disabled)`.

**Call relations**: Like the other tests, it uses `codex_command` to run the real CLI in a clean environment. It uses `load_global_mcp_servers` and `ConfigEditsBuilder` between CLI calls to put the configuration into a disabled state, then checks that the get command follows the intended disabled-server display path.

*Call graph*: calls 3 internal fn (codex_command, new, load_global_mcp_servers); 4 external calls (from_utf8, new, assert!, assert_eq!).


### Live CLI smoke coverage
These optional smoke tests run the real CLI binary against the live service to confirm end-to-end behavior beyond the mocked integration suite.

### `core/tests/suite/live_cli.rs`

`test` · `optional ignored test run`

These tests answer a simple but important question: can the finished command-line tool actually talk to OpenAI and use tools in a real working directory? Most tests in a project try to be predictable and isolated. This file deliberately does the opposite, but only when a developer asks for it. It uses a real `OPENAI_API_KEY`, starts the real `codex-rs` binary, gives it a prompt, and checks whether the visible result matches what was requested.

The helper code creates temporary folders so the test does not touch the developer’s real files or Codex settings. Think of it like setting up a clean hotel room for the program: it can work there freely, and the room is thrown away afterward. The command is run with its output captured and also streamed live to the terminal, so the developer can watch what happens while still getting normal test assertions afterward.

There are two ignored tests. One asks the model to create `hello.txt` with the text `hello`, proving file editing through the shell path works. The other asks it to print the current working directory, proving the CLI can run a shell request and report the expected directory. Without this file, the project would still have unit tests, but it would lack a quick manual check that the whole real stack works together.

#### Function details

##### `require_api_key`  (lines 12–15)

```
fn require_api_key() -> String
```

**Purpose**: This function reads the `OPENAI_API_KEY` environment variable, which is the secret token needed to call the real OpenAI service. It stops immediately with a clear message if the key is missing, because these live tests cannot run without it.

**Data flow**: It takes no direct input. It looks in the process environment for `OPENAI_API_KEY`; if the value is present, it returns that string so the child `codex-rs` process can use it. If the value is absent, it fails with an explanation instead of letting the test fail later in a more confusing way.

**Call relations**: The live command setup calls this when preparing to launch `codex-rs`. That keeps the API-key check close to the place where the child process environment is built.

*Call graph*: called by 1 (run_live); 1 external calls (var).


##### `run_live`  (lines 18–115)

```
fn run_live(prompt: &str) -> (assert_cmd::assert::Assert, TempDir)
```

**Purpose**: This is the shared test helper that runs the real `codex-rs` binary with a prompt in a clean temporary workspace. It gives the tests a ready-made result object for assertions, plus the temporary directory where any files should have been created.

**Data flow**: It receives a prompt string. It creates temporary directories for the working folder and fake home/Codex home, adds the API key and environment settings, starts `codex-rs`, sends a newline so the session finishes after one turn, and captures both standard output and standard error. At the same time, it copies that output to the developer’s terminal for live visibility. It returns the captured command result, wrapped for convenient assertions, and the temporary working directory.

**Call relations**: Both live smoke tests use this helper instead of duplicating the process-launching work. Inside, it asks `require_api_key` for the credential, starts the binary, collects the result, and hands that result back so each test can check its own expected behavior.

*Call graph*: calls 1 internal fn (require_api_key); called by 2 (live_create_file_hello_txt, live_print_working_directory); 7 external calls (piped, new, new, cargo_bin, create_dir_all, stderr, stdout).


##### `live_create_file_hello_txt`  (lines 119–137)

```
fn live_create_file_hello_txt()
```

**Purpose**: This ignored smoke test checks whether the real CLI can ask the model to use the shell tool to create a file. It verifies the full path from prompt, to live model response, to tool execution, to a changed file on disk.

**Data flow**: It first checks whether `OPENAI_API_KEY` exists. If not, it prints a skip message and returns. If the key is present, it sends a prompt through `run_live` asking for `hello.txt` to be created with the text `hello`. It then checks that the command succeeded, that the file exists in the temporary directory, and that the file contents match the expected text after trimming whitespace.

**Call relations**: This test is one of the direct users of `run_live`. It relies on that helper to create the isolated environment and run the binary, then performs file-system checks specific to the “create a file” scenario.

*Call graph*: calls 1 internal fn (run_live); 5 external calls (assert!, assert_eq!, eprintln!, var, read_to_string).


##### `live_print_working_directory`  (lines 141–152)

```
fn live_print_working_directory()
```

**Purpose**: This ignored smoke test checks whether the real CLI can use the shell tool to print its current working directory. It confirms that the command runs in the intended temporary folder and that the output reaches the test harness.

**Data flow**: It first looks for `OPENAI_API_KEY`. If the key is missing, it prints a skip message and exits early. If the key is present, it calls `run_live` with a prompt asking the model to print the current directory. It then asserts that the command succeeded and that the captured standard output contains the path of the temporary directory.

**Call relations**: This test also builds on `run_live`, using its launched real CLI session and captured output. Unlike the file-creation test, it focuses on what the command prints, so it checks the returned assertion object’s stdout for the temporary directory path.

*Call graph*: calls 1 internal fn (run_live); 3 external calls (eprintln!, contains, var).
