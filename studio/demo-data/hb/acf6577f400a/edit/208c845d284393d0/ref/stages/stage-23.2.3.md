# Core integration harness and common test support  `stage-23.2.3`

This stage is the shared test bench for the core part of the system. It is not the product’s normal startup or main work loop. Instead, it is the behind-the-scenes support that lets end-to-end tests run the core code in realistic situations and check what happened.

At the top, core/tests/all.rs creates one integration-test program, and core/tests/suite/mod.rs gathers all test modules into it. That suite file also adds a trick so the test program can pretend to be helper command-line tools when a test needs them.

Most of the heavy lifting lives in common/lib.rs, which collects reusable helpers. test_environment.rs figures out whether tests run locally, in Docker, or through Wine, and hooks.rs updates test config so hook scripts are treated as trusted. tracing.rs turns on test logging and telemetry, while process.rs waits for child processes to start or stop.

The rest are specialized fixtures: fake servers for apps, responses, websockets, and streamed SSE events; snapshot tools for comparing request context; zsh_fork.rs for real zsh-based scenarios; and builders such as test_codex.rs and test_codex_exec.rs that assemble isolated, repeatable test worlds. core/src/test_support.rs exposes extra test-only setup paths inside the core crate so these tests can wire everything together safely.

## Files in this stage

### Test suite entrypoints
These files define the integration-test binary and top-level suite aggregation that all shared support code serves.

### `core/tests/all.rs`

`test` · `startup`

This file is the root of the `core` integration test binary. Instead of many standalone integration test crates under `tests/`, the project aggregates them into one binary and places the actual test modules under `tests/all/`, imported here through `mod suite;`. The crate-level `#![allow(clippy::expect_used)]` reflects a testing convention that permits `expect` calls in assertions and setup code without lint noise.

The file also publicly re-exports `codex_protocol::error` for use by submodules, giving the suite a common error type path without each test module needing to import it independently. There is no runtime logic here beyond Rust’s normal test harness initialization and module loading. The important design choice is consolidation: a single integration binary can share setup, reduce compile duplication, and support global initialization patterns implemented in `suite/mod.rs`. This file therefore serves as the entry shell that hands control to the aggregated suite structure.


### `core/tests/suite/mod.rs`

`test` · `startup`

This module is the central registry for integration tests under `core/tests/all/`. Its most significant content is the `#[ctor]`-initialized static `CODEX_ALIASES_TEMP_DIR`, which runs before any tests and calls `configure_test_binary_dispatch("codex-core-tests", ...)` to decide how the test binary should behave when invoked under different executable names or first arguments. The closure checks `argv1` against `CODEX_CORE_APPLY_PATCH_ARG1` and `CODEX_FS_HELPER_ARG1`, and checks `exe_name` against `CODEX_LINUX_SANDBOX_ARG0`; in those cases it returns `TestBinaryDispatchMode::DispatchArg0Only`, causing the binary to dispatch like the corresponding helper tool. Otherwise it returns `TestBinaryDispatchMode::InstallAliases`, which sets up alias executables for normal test operation. The static stores an optional `TestBinaryDispatchGuard`, preserving the installation for the test process lifetime.

Below that, the file declares a large set of test modules, with platform gating for Windows, Unix, and non-Windows cases. This makes the file the suite manifest: adding a test means adding a module here, and platform-specific behavior is encoded directly in conditional compilation. The note about ARM documents an important limitation of the constructor-based alias mechanism. Overall, this file performs global test-environment orchestration first, then exposes the full matrix of integration scenarios to the Rust test harness.


### Core test wiring
These modules provide the foundational shared utilities, internal test-only constructors, and environment/config helpers used to assemble hermetic integration fixtures.

### `core/tests/common/lib.rs`

`util` · `cross-cutting test support`

This file is the umbrella support module for core tests. At process startup, three `#[ctor]` functions force deterministic thread/process IDs, install arg0 dispatch for test binaries, and set `INSTA_WORKSPACE_ROOT` when absent so snapshot tests resolve paths consistently. The rest of the file is a grab bag of concrete helpers used across integration tests.

Path helpers normalize Unix-vs-Windows expectations: `test_path_buf_with_windows`, `test_absolute_path_with_windows`, and related wrappers synthesize platform-appropriate `PathBuf` and `AbsolutePathBuf` values from canonical test literals. `create_directory_symlink` abstracts the OS-specific symlink syscall. `TempDirExt::abs` converts a `tempfile::TempDir` into an absolute-path wrapper used throughout the codebase.

Config helpers build hermetic `Config` instances rooted in a per-test temp home. `load_default_config_for_test_with_cloud_config_bundle` uses `ConfigBuilder` with managed-config loading disabled, test harness overrides, and optional cloud bundle fixtures; on Linux, `default_test_overrides` injects the `codex-linux-sandbox` executable path. Runtime helpers wait for protocol events from `CodexThread`, interpret MCP startup summaries, and submit thread-settings updates while matching responses by submission ID.

The nested `fs_wait` module provides blocking file-existence and file-discovery loops wrapped in `spawn_blocking`, using `notify` watchers plus final rescans to avoid races. Finally, exported macros skip tests under sandboxed, no-network, remote, Wine, or missing-binary conditions, allowing downstream test crates to share the same environment gating logic.

#### Function details

##### `enable_deterministic_unified_exec_process_ids_for_tests`  (lines 46–49)

```
fn enable_deterministic_unified_exec_process_ids_for_tests()
```

**Purpose**: Turns on deterministic thread-manager and process-ID behavior for the entire test process before tests run.

**Data flow**: It takes no arguments and writes global test-support state inside `codex_core` by enabling thread-manager test mode and deterministic process IDs. It returns nothing.

**Call relations**: As a startup ctor, it is invoked automatically during test process initialization rather than by explicit callers. It prepares global execution behavior that later test helpers and assertions rely on.

*Call graph*: calls 2 internal fn (set_deterministic_process_ids, set_thread_manager_test_mode).


##### `configure_arg0_dispatch_for_test_binaries`  (lines 52–54)

```
fn configure_arg0_dispatch_for_test_binaries()
```

**Purpose**: Initializes arg0-based binary dispatch once for the test process and stores the resulting guard.

**Data flow**: It reads and writes the `TEST_ARG0_PATH_ENTRY` `OnceLock`, invoking `codex_arg0::arg0_dispatch` only on first initialization and retaining the optional `Arg0PathEntryGuard`. It returns nothing.

**Call relations**: This ctor runs at startup so later helpers such as Linux sandbox binary lookup can consult the cached arg0-dispatch paths without reinitializing dispatch.


##### `configure_insta_workspace_root_for_snapshot_tests`  (lines 57–74)

```
fn configure_insta_workspace_root_for_snapshot_tests()
```

**Purpose**: Sets `INSTA_WORKSPACE_ROOT` at startup when absent so snapshot paths resolve relative to the repository workspace.

**Data flow**: It reads the `INSTA_WORKSPACE_ROOT` environment variable; if unset, it queries `repo_root`, appends `codex-rs`, canonicalizes the path, and writes the environment variable via `set_var`. It returns nothing.

**Call relations**: This startup ctor only acts when the variable is missing. It supports snapshot-based tests elsewhere in the suite by establishing a stable workspace root before test threads begin.

*Call graph*: 3 external calls (repo_root, set_var, var_os).


##### `assert_regex_match`  (lines 77–82)

```
fn assert_regex_match(pattern: &str, actual: &'s str) -> regex_lite::Captures<'s>
```

**Purpose**: Compiles a regex and asserts that it captures against the provided string, returning the captures for further inspection.

**Data flow**: It takes a pattern and an `actual` string slice, constructs a `regex_lite::Regex`, runs `captures(actual)`, and returns the resulting `Captures<'s>`. It panics if compilation fails or no match is found.

**Call relations**: This is a leaf assertion helper used directly by tests that need both a match assertion and access to capture groups.

*Call graph*: 1 external calls (new).


##### `test_path_buf_with_windows`  (lines 84–101)

```
fn test_path_buf_with_windows(unix_path: &str, windows_path: Option<&str>) -> PathBuf
```

**Purpose**: Builds a platform-appropriate `PathBuf` for tests from a Unix-style path and an optional explicit Windows override.

**Data flow**: It takes `unix_path` and optional `windows_path`. On Windows it either returns `PathBuf::from(windows_path)` or synthesizes a `C:\...` path by splitting the Unix path into segments; on non-Windows it returns `PathBuf::from(unix_path)`.

**Call relations**: This is the base path-construction helper used by `test_path_buf` and the absolute-path wrappers so tests can express one logical path across platforms.

*Call graph*: called by 2 (test_absolute_path_with_windows, test_path_buf); 2 external calls (from, cfg!).


##### `test_path_buf`  (lines 103–105)

```
fn test_path_buf(unix_path: &str) -> PathBuf
```

**Purpose**: Convenience wrapper that converts a Unix-style test path into a platform-specific `PathBuf` without a custom Windows override.

**Data flow**: It takes `unix_path`, forwards it to `test_path_buf_with_windows` with `None`, and returns the resulting `PathBuf`.

**Call relations**: This is the simpler sibling of `test_path_buf_with_windows`, used when the default Windows translation is sufficient.

*Call graph*: calls 1 internal fn (test_path_buf_with_windows).


##### `test_absolute_path_with_windows`  (lines 107–113)

```
fn test_absolute_path_with_windows(
    unix_path: &str,
    windows_path: Option<&str>,
) -> AbsolutePathBuf
```

**Purpose**: Builds an `AbsolutePathBuf` from a Unix-style path and optional Windows override, asserting the result is absolute.

**Data flow**: It takes `unix_path` and optional `windows_path`, obtains a `PathBuf` from `test_path_buf_with_windows`, converts it with `AbsolutePathBuf::from_absolute_path`, and returns the absolute wrapper. It panics if the path is not absolute.

**Call relations**: This helper underpins `test_absolute_path` and `test_tmp_path`, giving tests a typed absolute path in the project's path abstraction.

*Call graph*: calls 2 internal fn (test_path_buf_with_windows, from_absolute_path); called by 2 (test_absolute_path, test_tmp_path).


##### `test_absolute_path`  (lines 115–117)

```
fn test_absolute_path(unix_path: &str) -> AbsolutePathBuf
```

**Purpose**: Convenience wrapper that creates an `AbsolutePathBuf` from a Unix-style path using default Windows translation.

**Data flow**: It takes `unix_path`, delegates to `test_absolute_path_with_windows` with no explicit Windows path, and returns the resulting `AbsolutePathBuf`.

**Call relations**: This is the common absolute-path helper used by tests that do not need a custom Windows path literal.

*Call graph*: calls 1 internal fn (test_absolute_path_with_windows).


##### `create_directory_symlink`  (lines 127–131)

```
fn create_directory_symlink(source: &Path, link: &Path)
```

**Purpose**: Creates a directory symlink using the platform-specific filesystem API and panics with a test-oriented message on failure.

**Data flow**: It takes source and link `&Path` values and invokes either Unix `symlink` or Windows `symlink_dir`, writing the symlink on disk. It returns nothing.

**Call relations**: Tests call this helper instead of branching on OS-specific symlink APIs themselves.

*Call graph*: 2 external calls (symlink, symlink_dir).


##### `TempDir::abs`  (lines 138–140)

```
fn abs(&self) -> AbsolutePathBuf
```

**Purpose**: Converts a `tempfile::TempDir` into an `AbsolutePathBuf` using the test path extension trait.

**Data flow**: It reads `self.path()`, converts it via `.abs()`, and returns the resulting `AbsolutePathBuf`.

**Call relations**: This trait method is used throughout test setup code whenever a temp directory must be passed into APIs expecting the project's absolute-path wrapper.


##### `test_tmp_path`  (lines 143–145)

```
fn test_tmp_path() -> AbsolutePathBuf
```

**Purpose**: Returns the canonical temporary-directory path used by tests on the current platform.

**Data flow**: It takes no arguments and returns an `AbsolutePathBuf` built from `/tmp` on Unix or `C:\Users\codex\AppData\Local\Temp` on Windows via `test_absolute_path_with_windows`.

**Call relations**: This helper centralizes the expected temp-root path and is used by `test_tmp_path_buf` and tests that compare temp locations.

*Call graph*: calls 1 internal fn (test_absolute_path_with_windows); called by 1 (test_tmp_path_buf).


##### `test_tmp_path_buf`  (lines 147–149)

```
fn test_tmp_path_buf() -> PathBuf
```

**Purpose**: Returns the canonical test temporary-directory path as a plain `PathBuf`.

**Data flow**: It calls `test_tmp_path`, converts the `AbsolutePathBuf` into a `PathBuf`, and returns it.

**Call relations**: This is the `PathBuf`-returning companion to `test_tmp_path` for APIs that do not use the absolute-path wrapper.

*Call graph*: calls 1 internal fn (test_tmp_path).


##### `fetch_dotslash_file`  (lines 152–185)

```
fn fetch_dotslash_file(
    dotslash_file: &std::path::Path,
    dotslash_cache: Option<&std::path::Path>,
) -> anyhow::Result<PathBuf>
```

**Purpose**: Runs the external `dotslash -- fetch` command for a resource file and validates that the resolved path is a real file.

**Data flow**: It takes a DotSlash manifest path and optional cache path, constructs a `std::process::Command`, optionally sets `DOTSLASH_CACHE`, executes it, checks exit status and UTF-8 stdout, trims the fetched path string, converts it to `PathBuf`, verifies `is_file()`, and returns that path or an `anyhow::Error` with contextual messages.

**Call relations**: This helper is used by tests that need to materialize external resources through DotSlash while surfacing command failures and malformed output clearly.

*Call graph*: 4 external calls (from, from_utf8, new, ensure!).


##### `load_default_config_for_test`  (lines 190–196)

```
async fn load_default_config_for_test(codex_home: &TempDir) -> Config
```

**Purpose**: Builds a default hermetic `Config` rooted in the provided temporary Codex home using the default cloud bundle loader.

**Data flow**: It takes `&TempDir`, constructs `CloudConfigBundleLoader::default()`, delegates to `load_default_config_for_test_with_cloud_config_bundle`, awaits the result, and returns the built `Config`.

**Call relations**: This is the standard config-construction entry used by most tests; specialized callers use the cloud-bundle variant directly.

*Call graph*: calls 2 internal fn (default, load_default_config_for_test_with_cloud_config_bundle).


##### `load_default_config_for_test_with_cloud_config_bundle`  (lines 200–212)

```
async fn load_default_config_for_test_with_cloud_config_bundle(
    codex_home: &TempDir,
    cloud_config_bundle: CloudConfigBundleLoader,
) -> Config
```

**Purpose**: Constructs a test `Config` with managed config disabled, a temp `codex_home`, harness overrides, and a caller-supplied cloud config bundle loader.

**Data flow**: It takes `&TempDir` and a `CloudConfigBundleLoader`, configures a `ConfigBuilder` with `LoaderOverrides::without_managed_config_for_tests()`, `codex_home`, `default_test_overrides()`, and the cloud bundle, then asynchronously builds and returns the resulting `Config`, panicking if construction fails.

**Call relations**: This is the underlying config builder used by `load_default_config_for_test` and by higher-level harness builders that need cloud-config fixtures applied during config load.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, default_test_overrides); called by 1 (load_default_config_for_test); 2 external calls (path, default).


##### `managed_network_requirements_loader`  (lines 214–222)

```
fn managed_network_requirements_loader() -> CloudConfigBundleLoader
```

**Purpose**: Creates a cloud-config fixture loader that enables experimental network access and local binding requirements.

**Data flow**: It takes no arguments and returns a `CloudConfigBundleLoader` produced from an inline TOML fixture string via `CloudConfigBundleFixture::loader_with_enterprise_requirement`.

**Call relations**: Tests use this helper when they need config construction to include enterprise-managed network requirements.

*Call graph*: calls 1 internal fn (loader_with_enterprise_requirement).


##### `default_test_overrides`  (lines 235–237)

```
fn default_test_overrides() -> ConfigOverrides
```

**Purpose**: Provides platform-specific `ConfigOverrides` for tests, injecting the Linux sandbox executable path on Linux and defaults elsewhere.

**Data flow**: On Linux it resolves `find_codex_linux_sandbox_exe()` and returns a `ConfigOverrides` with `codex_linux_sandbox_exe` set; on other platforms it returns `ConfigOverrides::default()`.

**Call relations**: This helper is consumed during test config construction so sandbox-related code paths can find the helper binary when needed.

*Call graph*: calls 1 internal fn (find_codex_linux_sandbox_exe); called by 1 (load_default_config_for_test_with_cloud_config_bundle); 1 external calls (default).


##### `find_codex_linux_sandbox_exe`  (lines 240–254)

```
fn find_codex_linux_sandbox_exe() -> Result<PathBuf, CargoBinError>
```

**Purpose**: Finds the `codex-linux-sandbox` executable for Linux tests using arg0-dispatch paths, the current executable, or Cargo binary lookup.

**Data flow**: It reads the cached `TEST_ARG0_PATH_ENTRY` for a precomputed sandbox path; if absent, it tries `std::env::current_exe()`, and finally falls back to `codex_utils_cargo_bin::cargo_bin("codex-linux-sandbox")`. It returns a `Result<PathBuf, CargoBinError>`.

**Call relations**: Linux-only test setup calls this from `default_test_overrides`, and skip macros may also rely on it indirectly to decide whether sandbox-dependent tests can run.

*Call graph*: called by 1 (default_test_overrides); 2 external calls (cargo_bin, current_exe).


##### `wait_for_event`  (lines 256–265)

```
async fn wait_for_event(
    codex: &CodexThread,
    predicate: F,
) -> codex_protocol::protocol::EventMsg
```

**Purpose**: Waits up to a default short timeout for the next `CodexThread` event whose message satisfies a predicate.

**Data flow**: It takes `&CodexThread` and a predicate over `EventMsg`, constructs a one-second duration, delegates to `wait_for_event_with_timeout`, and returns the matching `EventMsg`.

**Call relations**: This is the convenience wrapper used by `wait_for_event_match` and tests that do not need a custom timeout.

*Call graph*: calls 1 internal fn (wait_for_event_with_timeout); called by 1 (wait_for_event_match); 1 external calls (from_secs).


##### `wait_for_mcp_server`  (lines 268–298)

```
async fn wait_for_mcp_server(codex: &CodexThread, server_name: &str) -> anyhow::Result<()>
```

**Purpose**: Consumes events until MCP startup completes, then verifies that a named MCP server ended in the ready set rather than failed or cancelled.

**Data flow**: It takes `&CodexThread` and `server_name`, repeatedly awaits `next_event()` until it sees `EventMsg::McpStartupComplete(summary)`, inspects `summary.failed`, `summary.cancelled`, and `summary.ready`, and returns `Ok(())` or an `anyhow` error / assertion failure describing the startup outcome.

**Call relations**: Tests call this after configuring MCP servers to block until startup settles and to surface the specific server's status from the aggregate startup summary.

*Call graph*: calls 1 internal fn (next_event); 2 external calls (bail!, assert!).


##### `submit_thread_settings`  (lines 300–323)

```
async fn submit_thread_settings(
    codex: &CodexThread,
    thread_settings: codex_protocol::protocol::ThreadSettingsOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Submits thread-settings overrides to a running `CodexThread` and waits for the matching success or error event for that submission ID.

**Data flow**: It takes `&CodexThread` and `ThreadSettingsOverrides`, submits `Op::ThreadSettings`, stores the returned submission ID, then loops reading timed events until one with the same `id` arrives. It returns `Ok(())` on `ThreadSettingsApplied`, panics on `Error` or any unexpected event kind for that submission.

**Call relations**: This helper is used by tests that need to mutate thread settings mid-run and verify the update completed before proceeding.

*Call graph*: calls 2 internal fn (next_event, submit); 2 external calls (from_secs, panic!).


##### `wait_for_event_match`  (lines 325–331)

```
async fn wait_for_event_match(codex: &CodexThread, matcher: F) -> T
```

**Purpose**: Waits for an event whose message can be transformed by a matcher closure and returns the extracted value.

**Data flow**: It takes `&CodexThread` and a matcher `Fn(&EventMsg) -> Option<T>`, waits using `wait_for_event` until the matcher would succeed, then re-applies the matcher to the returned event and yields the extracted `T`.

**Call relations**: This helper layers extraction on top of `wait_for_event`; higher-level test harnesses use it to wait for specific protocol events and pull out IDs or payloads.

*Call graph*: calls 1 internal fn (wait_for_event).


##### `wait_for_event_with_timeout`  (lines 333–353)

```
async fn wait_for_event_with_timeout(
    codex: &CodexThread,
    mut predicate: F,
    wait_time: tokio::time::Duration,
) -> codex_protocol::protocol::EventMsg
```

**Purpose**: Loops on `CodexThread::next_event` until a predicate matches, enforcing a caller-specified timeout with a minimum floor to tolerate startup work.

**Data flow**: It takes `&CodexThread`, a mutable predicate over `EventMsg`, and a `Duration`. On each iteration it awaits `next_event()` under `timeout(wait_time.max(10s), ...)`, panics on timeout or stream end, and returns the first `EventMsg` whose message satisfies the predicate.

**Call relations**: This is the primitive event waiter used by `wait_for_event` and by harness code that needs longer waits for turn completion or startup-related events.

*Call graph*: calls 1 internal fn (next_event); called by 1 (wait_for_event); 2 external calls (from_secs, max).


##### `sandbox_env_var`  (lines 355–357)

```
fn sandbox_env_var() -> &'static str
```

**Purpose**: Exposes the environment variable name used to indicate the active sandbox implementation.

**Data flow**: It takes no arguments and returns the `&'static str` constant from `codex_core::spawn::CODEX_SANDBOX_ENV_VAR`.

**Call relations**: The exported skip macros use this helper so downstream crates can expand them without depending directly on `codex_core` internals.


##### `sandbox_network_env_var`  (lines 359–361)

```
fn sandbox_network_env_var() -> &'static str
```

**Purpose**: Exposes the environment variable name used to indicate network-disabled sandbox execution.

**Data flow**: It takes no arguments and returns the `&'static str` constant from `codex_core::spawn::CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR`.

**Call relations**: This helper is consumed by the no-network skip macro and any tests that need to inspect the same environment variable.


##### `format_with_current_shell`  (lines 363–365)

```
fn format_with_current_shell(command: &str) -> Vec<String>
```

**Purpose**: Formats a command string into the current user's shell executable arguments using a login shell.

**Data flow**: It takes a command string, reads the default user shell from `codex_core::shell::default_user_shell()`, derives exec args with `use_login_shell = true`, and returns `Vec<String>`.

**Call relations**: This helper is used by the display-formatting wrapper and by tests that need the exact argv shape Codex would use for shell execution.

*Call graph*: calls 1 internal fn (default_user_shell); called by 1 (format_with_current_shell_display).


##### `format_with_current_shell_display`  (lines 367–370)

```
fn format_with_current_shell_display(command: &str) -> String
```

**Purpose**: Formats a command for the current login shell and serializes the resulting argv into a shell-escaped display string.

**Data flow**: It takes a command string, gets argv from `format_with_current_shell`, joins it with `shlex::try_join`, and returns the display string.

**Call relations**: This is the human-readable companion to `format_with_current_shell`, used in assertions and snapshots.

*Call graph*: calls 1 internal fn (format_with_current_shell); 1 external calls (try_join).


##### `format_with_current_shell_non_login`  (lines 372–375)

```
fn format_with_current_shell_non_login(command: &str) -> Vec<String>
```

**Purpose**: Formats a command string into the current user's shell executable arguments without using a login shell.

**Data flow**: It takes a command string, reads the default user shell, derives exec args with `use_login_shell = false`, and returns `Vec<String>`.

**Call relations**: This helper parallels the login-shell variant and feeds the non-login display wrapper.

*Call graph*: calls 1 internal fn (default_user_shell); called by 1 (format_with_current_shell_display_non_login).


##### `format_with_current_shell_display_non_login`  (lines 377–381)

```
fn format_with_current_shell_display_non_login(command: &str) -> String
```

**Purpose**: Formats a command for the current non-login shell and serializes the argv into a shell-escaped display string.

**Data flow**: It takes a command string, gets argv from `format_with_current_shell_non_login`, joins it with `shlex::try_join`, and returns the resulting string.

**Call relations**: This is the display-oriented wrapper for the non-login shell formatting path.

*Call graph*: calls 1 internal fn (format_with_current_shell_non_login); 1 external calls (try_join).


##### `stdio_server_bin`  (lines 383–385)

```
fn stdio_server_bin() -> Result<String, CargoBinError>
```

**Purpose**: Finds the `test_stdio_server` Cargo binary and returns its path as a string.

**Data flow**: It takes no arguments, resolves the binary with `cargo_bin`, converts the resulting path lossily to `String`, and returns `Result<String, CargoBinError>`.

**Call relations**: Tests that launch the stdio test server use this helper to locate the compiled binary.

*Call graph*: 1 external calls (cargo_bin).


##### `fs_wait::wait_for_path_exists`  (lines 401–407)

```
async fn wait_for_path_exists(
        path: impl Into<PathBuf>,
        timeout: Duration,
    ) -> Result<PathBuf>
```

**Purpose**: Asynchronously waits for a path to appear by running the blocking watcher-based implementation on a blocking thread.

**Data flow**: It takes a path-like input and timeout, converts the path into `PathBuf`, spawns `wait_for_path_exists_blocking` via `tokio::task::spawn_blocking`, awaits it, and returns the existing `PathBuf` or an error.

**Call relations**: This is the async wrapper around the blocking filesystem watcher logic, used by tests that need to await file creation without blocking the runtime.

*Call graph*: 2 external calls (into, spawn_blocking).


##### `fs_wait::wait_for_matching_file`  (lines 409–420)

```
async fn wait_for_matching_file(
        root: impl Into<PathBuf>,
        timeout: Duration,
        predicate: impl FnMut(&Path) -> bool + Send + 'static,
    ) -> Result<PathBuf>
```

**Purpose**: Asynchronously waits for any file under a root directory to satisfy a predicate, using the blocking scanner/watcher implementation.

**Data flow**: It takes a root path, timeout, and `Send + 'static` predicate, converts the root to `PathBuf`, moves the predicate into a `spawn_blocking` closure, and returns the first matching file path or an error.

**Call relations**: This helper is the async entrypoint for tests that need to wait for generated files whose exact names are not known in advance.

*Call graph*: 2 external calls (into, spawn_blocking).


##### `fs_wait::wait_for_path_exists_blocking`  (lines 422–461)

```
fn wait_for_path_exists_blocking(path: PathBuf, timeout: Duration) -> Result<PathBuf>
```

**Purpose**: Synchronously waits for a specific path to exist by watching the nearest existing ancestor and rechecking after each filesystem event until timeout.

**Data flow**: It takes a target `PathBuf` and timeout. If the path already exists it returns immediately; otherwise it computes `nearest_existing_ancestor`, creates a `notify` watcher and channel, loops until the deadline checking `path.exists()` before and after each received event, and returns the path or an `anyhow!` timeout error.

**Call relations**: This is the core implementation behind `wait_for_path_exists` and is also reused by `blocking_find_matching_file` to ensure the watched root exists before scanning.

*Call graph*: 6 external calls (now, exists, anyhow!, nearest_existing_ancestor, channel, recommended_watcher).


##### `fs_wait::blocking_find_matching_file`  (lines 463–501)

```
fn blocking_find_matching_file(
        root: PathBuf,
        timeout: Duration,
        predicate: &mut impl FnMut(&Path) -> bool,
    ) -> Result<PathBuf>
```

**Purpose**: Synchronously waits for a root directory to exist and then repeatedly scans it for a file matching a predicate, rescanning after watcher events until timeout.

**Data flow**: It takes a root `PathBuf`, timeout, and mutable predicate. It first ensures the root exists via `wait_for_path_exists_blocking`, performs an initial `scan_for_match`, then installs a recursive watcher on the root and loops until the deadline, rescanning after each event. It returns the first matching `PathBuf` or an `anyhow!` timeout error.

**Call relations**: This function powers `wait_for_matching_file`; it combines existence waiting, recursive scanning, and event-driven rescans to avoid missing files created between polls.

*Call graph*: 6 external calls (now, anyhow!, scan_for_match, wait_for_path_exists_blocking, channel, recommended_watcher).


##### `fs_wait::scan_for_match`  (lines 503–514)

```
fn scan_for_match(root: &Path, predicate: &mut impl FnMut(&Path) -> bool) -> Option<PathBuf>
```

**Purpose**: Walks a directory tree and returns the first regular file for which the predicate returns true.

**Data flow**: It takes a root `&Path` and mutable predicate, iterates `WalkDir::new(root)`, skips non-file entries, applies the predicate to each file path, and returns `Some(PathBuf)` for the first match or `None`.

**Call relations**: This is the pure scanning primitive used by `blocking_find_matching_file` before and after watcher notifications.

*Call graph*: 1 external calls (new).


##### `fs_wait::nearest_existing_ancestor`  (lines 516–527)

```
fn nearest_existing_ancestor(path: &Path) -> PathBuf
```

**Purpose**: Finds the closest existing ancestor of a path, falling back to `.` if no ancestor exists.

**Data flow**: It takes `&Path`, repeatedly checks `current.exists()`, walks to `current.parent()` when absent, and returns the first existing ancestor as `PathBuf` or `PathBuf::from(".")` if it reaches the root without finding one.

**Call relations**: This helper is used by `wait_for_path_exists_blocking` to choose a valid watch root even when the target path and some parents do not yet exist.

*Call graph*: 1 external calls (from).


### `core/src/test_support.rs`

`test` · `cross-cutting test setup and fixtures`

This module is explicitly marked test-only and re-exports a curated set of helpers that integration tests in other crates can call. It includes `EmptyUserInstructionsProvider`, a trivial `UserInstructionsProvider` implementation whose async loader always returns `LoadedUserInstructions::default()`, allowing tests to bypass user-instruction loading entirely.

Several functions are thin wrappers around internal `*_for_tests` constructors: toggles for thread-manager test mode and deterministic unified-exec process ids; auth-manager builders from `CodexAuth`, optionally with a custom Codex home; thread-manager constructors with model providers, custom homes, environment managers, and optional state DB handles; and thread start/resume helpers that inject a user-shell override. `models_manager_with_provider` creates a provider via `create_model_provider` and immediately asks it for a models manager rooted at the supplied home directory. Offline model helpers forward to codex-models-manager test support to resolve a model slug or construct `ModelInfo` from a `Config`'s models-manager view.

The file also defines `TestCodexResponsesRequestKind` and a `responses_metadata` helper that maps test-facing request kinds into `Option<CodexResponsesRequestKind>`, conditionally includes `turn_id`, computes subagent header/kind from `SessionSource`, and fills the remaining fields from `CodexResponsesMetadata::new`. Finally, it exposes a lazily initialized, sorted `TEST_MODEL_PRESETS` built from bundled models JSON and a wrapper for builtin collaboration mode presets. The design keeps tests using the same production wiring paths while avoiding crate-feature permutations.

#### Function details

##### `EmptyUserInstructionsProvider::load_user_instructions`  (lines 53–55)

```
fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_>
```

**Purpose**: Implements the test provider by returning an async future that resolves to empty/default user instructions.

**Data flow**: Reads `self`, constructs an async block returning `LoadedUserInstructions::default()`, boxes it with `Box::pin`, and returns `LoadUserInstructionsFuture<'_>`.

**Call relations**: Tests use this provider wherever production code expects a `UserInstructionsProvider` but no instructions should be loaded.

*Call graph*: 2 external calls (pin, default).


##### `set_thread_manager_test_mode`  (lines 58–60)

```
fn set_thread_manager_test_mode(enabled: bool)
```

**Purpose**: Enables or disables thread-manager test mode through the internal test-only hook.

**Data flow**: Consumes `enabled: bool` and forwards it to `thread_manager::set_thread_manager_test_mode_for_tests(enabled)`. It returns `()`.

**Call relations**: Test setup code calls this to switch thread-manager behavior into deterministic or test-friendly mode.

*Call graph*: calls 1 internal fn (set_thread_manager_test_mode_for_tests); called by 1 (enable_deterministic_unified_exec_process_ids_for_tests).


##### `set_deterministic_process_ids`  (lines 62–64)

```
fn set_deterministic_process_ids(enabled: bool)
```

**Purpose**: Turns deterministic unified-exec process id generation on or off for tests.

**Data flow**: Consumes `enabled: bool` and forwards it to `unified_exec::set_deterministic_process_ids_for_tests(enabled)`. It returns `()`.

**Call relations**: Tests that assert process ids or background-terminal behavior call this during setup.

*Call graph*: calls 1 internal fn (set_deterministic_process_ids_for_tests); called by 1 (enable_deterministic_unified_exec_process_ids_for_tests).


##### `auth_manager_from_auth`  (lines 66–68)

```
fn auth_manager_from_auth(auth: CodexAuth) -> Arc<AuthManager>
```

**Purpose**: Builds an `AuthManager` from a `CodexAuth` value using the testing constructor.

**Data flow**: Consumes `auth: CodexAuth`, calls `AuthManager::from_auth_for_testing(auth)`, and returns `Arc<AuthManager>`.

**Call relations**: Many integration tests use this as the standard way to obtain authenticated session infrastructure without production login flows.

*Call graph*: calls 1 internal fn (from_auth_for_testing); called by 25 (remote_control_auth_manager, remote_control_auth_manager, rewrite_mcp_tool_arguments_for_openai_files_surfaces_upload_failures, approve_mode_skips_guardian_in_every_permission_mode, build_from_config, responses_respects_model_info_overrides_from_config, azure_responses_request_includes_store_and_reasoning_ids, prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens, websocket_harness_with_provider_options, code_mode_can_call_standalone_web_search (+15 more)).


##### `auth_manager_from_auth_with_home`  (lines 70–72)

```
fn auth_manager_from_auth_with_home(auth: CodexAuth, codex_home: PathBuf) -> Arc<AuthManager>
```

**Purpose**: Builds a test `AuthManager` from auth plus an explicit Codex home directory.

**Data flow**: Consumes `auth` and `codex_home: PathBuf`, forwards them to `AuthManager::from_auth_for_testing_with_home`, and returns `Arc<AuthManager>`.

**Call relations**: Tests that need auth state rooted in a temporary home directory use this variant.

*Call graph*: calls 1 internal fn (from_auth_for_testing_with_home); called by 1 (remote_control_auth_manager_with_home).


##### `thread_manager_with_models_provider`  (lines 74–79)

```
fn thread_manager_with_models_provider(
    auth: CodexAuth,
    provider: ModelProviderInfo,
) -> ThreadManager
```

**Purpose**: Constructs a `ThreadManager` for tests using a chosen model provider.

**Data flow**: Consumes `auth` and `provider`, forwards them to `ThreadManager::with_models_provider_for_tests`, and returns the resulting `ThreadManager`.

**Call relations**: Integration tests use this to stand up thread management with a specific provider backend.

*Call graph*: calls 1 internal fn (with_models_provider_for_tests); called by 3 (emits_warning_when_resumed_model_differs, emits_warning_when_unstable_features_enabled_via_config, suppresses_warning_when_configured).


##### `thread_manager_with_models_provider_and_home`  (lines 81–93)

```
fn thread_manager_with_models_provider_and_home(
    auth: CodexAuth,
    provider: ModelProviderInfo,
    codex_home: PathBuf,
    environment_manager: Arc<EnvironmentManager>,
) -> ThreadManager
```

**Purpose**: Constructs a test `ThreadManager` with explicit model provider, Codex home, and environment manager.

**Data flow**: Consumes auth, provider, `codex_home`, and `Arc<EnvironmentManager>`, forwards them to `ThreadManager::with_models_provider_and_home_for_tests`, and returns `ThreadManager`.

**Call relations**: Tests needing both custom filesystem roots and environment management use this richer constructor.

*Call graph*: calls 1 internal fn (with_models_provider_and_home_for_tests); called by 3 (guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, turn_started_omits_active_snapshot_items).


##### `thread_manager_with_models_provider_home_and_state`  (lines 95–109)

```
fn thread_manager_with_models_provider_home_and_state(
    auth: CodexAuth,
    provider: ModelProviderInfo,
    codex_home: PathBuf,
    environment_manager: Arc<EnvironmentManager>,
    state_db: Op
```

**Purpose**: Constructs a test `ThreadManager` with explicit provider, home, environment manager, and optional persisted state handle.

**Data flow**: Consumes auth, provider, home path, environment manager, and `Option<crate::StateDbHandle>`, forwards them to `ThreadManager::with_models_provider_home_and_state_for_tests`, and returns `ThreadManager`.

**Call relations**: Stateful integration tests use this when they need to exercise resume/state-db behavior.

*Call graph*: calls 1 internal fn (with_models_provider_home_and_state_for_tests).


##### `start_thread_with_user_shell_override`  (lines 111–119)

```
async fn start_thread_with_user_shell_override(
    thread_manager: &ThreadManager,
    config: Config,
    user_shell_override: crate::shell::Shell,
) -> codex_protocol::error::Result<crate::NewThrea
```

**Purpose**: Starts a new thread in tests while forcing a specific shell configuration.

**Data flow**: Consumes a borrowed `ThreadManager`, `Config`, and shell override, forwards them to `start_thread_with_user_shell_override_for_tests(...).await`, and returns `codex_protocol::error::Result<crate::NewThread>`.

**Call relations**: Test harnesses call this to create threads whose shell behavior is controlled independently of the host environment.

*Call graph*: calls 1 internal fn (start_thread_with_user_shell_override_for_tests); called by 1 (build_from_config).


##### `resume_thread_from_rollout_with_user_shell_override`  (lines 121–136)

```
async fn resume_thread_from_rollout_with_user_shell_override(
    thread_manager: &ThreadManager,
    config: Config,
    rollout_path: PathBuf,
    auth_manager: Arc<AuthManager>,
    user_shell_over
```

**Purpose**: Resumes a thread from rollout state in tests while forcing a specific shell configuration.

**Data flow**: Consumes a borrowed `ThreadManager`, `Config`, rollout path, `Arc<AuthManager>`, and shell override; forwards them to `resume_thread_from_rollout_with_user_shell_override_for_tests(...).await`; and returns the resulting `Result<crate::NewThread>`.

**Call relations**: Resume-path tests use this to recreate threads from saved rollout data under controlled shell settings.

*Call graph*: calls 1 internal fn (resume_thread_from_rollout_with_user_shell_override_for_tests); called by 1 (build_from_config).


##### `models_manager_with_provider`  (lines 138–145)

```
fn models_manager_with_provider(
    codex_home: PathBuf,
    auth_manager: Arc<AuthManager>,
    provider: ModelProviderInfo,
) -> SharedModelsManager
```

**Purpose**: Creates a shared models manager for tests from a provider descriptor and auth manager.

**Data flow**: Consumes `codex_home`, `Arc<AuthManager>`, and `ModelProviderInfo`. It creates a provider with `create_model_provider(provider, Some(auth_manager))`, then calls `provider.models_manager(codex_home, None)` and returns the resulting `SharedModelsManager`.

**Call relations**: Many tests use this to obtain a models manager without constructing a full thread manager.

*Call graph*: called by 24 (guardian_review_request_layout_matches_model_visible_request_snapshot, guardian_review_surfaces_responses_api_errors_in_rejection_reason, guardian_test_session_and_turn_with_base_url, guardian_test_session_turn_and_rx, approve_mode_skips_guardian_in_every_permission_mode, guardian_mode_mcp_denial_returns_rationale_message, guardian_mode_skips_auto_when_annotations_do_not_require_approval, guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, guardian_subagent_does_not_inherit_parent_exec_policy_rules, request_permissions_guardian_review_stops_when_cancelled (+14 more)); 2 external calls (create_model_provider, models_manager).


##### `get_model_offline`  (lines 147–149)

```
fn get_model_offline(model: Option<&str>) -> String
```

**Purpose**: Returns the offline-test model slug chosen for an optional requested model name.

**Data flow**: Consumes `model: Option<&str>`, forwards it to `get_model_offline_for_tests`, and returns the resulting `String`.

**Call relations**: Tests that need a stable offline model selection use this wrapper instead of reaching into codex-models-manager directly.

*Call graph*: calls 1 internal fn (get_model_offline_for_tests); called by 4 (responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids, send_provider_auth_request).


##### `construct_model_info_offline`  (lines 151–153)

```
fn construct_model_info_offline(model: &str, config: &Config) -> ModelInfo
```

**Purpose**: Builds offline `ModelInfo` for a given model slug using the supplied config's models-manager configuration.

**Data flow**: Consumes `model: &str` and `config: &Config`, converts the config with `config.to_models_manager_config()`, forwards both to `construct_model_info_offline_for_tests`, and returns `ModelInfo`.

**Call relations**: Tests that need realistic `ModelInfo` objects derived from config use this helper.

*Call graph*: calls 1 internal fn (construct_model_info_offline_for_tests); called by 9 (responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids, send_provider_auth_request, websocket_harness_with_provider_options, base_instructions_override_disables_personality_template, instructions_uses_base_if_feature_disabled, personality_does_not_mutate_base_instructions_without_template); 1 external calls (to_models_manager_config).


##### `responses_metadata`  (lines 163–191)

```
fn responses_metadata(
    installation_id: &str,
    session_id: &str,
    thread_id: &str,
    turn_id: Option<&str>,
    window_id: String,
    session_source: &SessionSource,
    parent_thread_id:
```

**Purpose**: Constructs `CodexResponsesMetadata` for tests, including optional turn/request-kind fields and subagent headers derived from session source.

**Data flow**: Consumes installation/session/thread ids, optional turn id, window id, `SessionSource`, optional parent thread id, and `TestCodexResponsesRequestKind`. It maps the test enum to `Option<CodexResponsesRequestKind>`, conditionally derives `turn_id` and `subagent_kind` only when a request kind exists, computes `subagent_header` from `subagent_header_value(session_source)`, and fills the remaining fields from `CodexResponsesMetadata::new(...)`. It returns the assembled metadata struct.

**Call relations**: Tests that validate outbound Responses API metadata call this helper to mirror production metadata construction while controlling request-kind semantics.

*Call graph*: calls 2 internal fn (new, subagent_header_value); called by 1 (test_responses_metadata_for_client); 2 external calls (and, and_then).


##### `all_model_presets`  (lines 193–195)

```
fn all_model_presets() -> &'static Vec<ModelPreset>
```

**Purpose**: Returns the lazily initialized list of bundled model presets prepared for tests.

**Data flow**: Reads the static `TEST_MODEL_PRESETS` and returns `&'static Vec<ModelPreset>`.

**Call relations**: Tests that need the full visible preset list use this shared fixture rather than reparsing bundled models each time.

*Call graph*: called by 5 (write_models_cache, expected_visible_models, service_tier_model_and_tier_id, turn_start_sends_service_tier_id_to_model_request, bundled_default_model_slug).


##### `builtin_collaboration_mode_presets`  (lines 197–199)

```
fn builtin_collaboration_mode_presets() -> Vec<CollaborationModeMask>
```

**Purpose**: Returns the builtin collaboration mode presets exposed by the models-manager preset module.

**Data flow**: Calls `collaboration_mode_presets::builtin_collaboration_mode_presets()` and returns the resulting `Vec<CollaborationModeMask>`.

**Call relations**: Tests that enumerate or validate collaboration modes use this wrapper to access the production preset list.

*Call graph*: calls 1 internal fn (builtin_collaboration_mode_presets); called by 1 (list_collaboration_modes_returns_presets).


### `core/tests/common/test_environment.rs`

`config` · `test startup / environment detection`

This file defines the `TestEnvironment` enum and the parsing logic that maps process environment variables into one of three modes: `Local`, `Docker { container_name }`, or `WineExec`. The parser supports both the current `CODEX_TEST_ENVIRONMENT` variable and a legacy Docker-only variable pair for backward compatibility. Validation is strict: configured values must be valid UTF-8, container names must be non-empty after trimming, and unknown environment names produce descriptive errors.

The enum carries behavior needed by remote test setup. `is_remote` distinguishes local from non-local modes. `docker_container_name` exposes the Docker container name only when applicable. `remote_cwd` computes a unique remote working directory path for a given instance ID, returning `None` for local mode, a POSIX `/tmp/codex-core-test-cwd-<id>` file URI for Docker, or a Windows-style `C:/codex-core-test-cwd-<id>` file URI for Wine-exec. It then converts that URI into a `LegacyAppPathString` using the environment's `PathConvention`, which is native for local, POSIX for Docker, and Windows for Wine-exec.

`test_environment` is the public entrypoint: it reads the relevant environment variables, delegates to `parse_test_environment`, panics on invalid configuration, and additionally rejects `wine-exec` unless the host OS is Linux. `get_remote_test_env` simply returns `Some(environment)` when the parsed environment is remote. This module is used by higher-level test harnesses and by skip macros exported from the common test library.

#### Function details

##### `TestEnvironment::is_remote`  (lines 20–22)

```
fn is_remote(&self) -> bool
```

**Purpose**: Returns whether the test environment is anything other than `Local`.

**Data flow**: It matches on `self` and returns `false` for `Local`, `true` otherwise.

**Call relations**: `get_remote_test_env` uses this to decide whether to return the parsed environment or `None`.

*Call graph*: 1 external calls (matches!).


##### `TestEnvironment::docker_container_name`  (lines 24–29)

```
fn docker_container_name(&self) -> Option<&str>
```

**Purpose**: Returns the Docker container name when the environment is Docker-backed.

**Data flow**: It matches on `self`, returning `Some(&container_name)` for `Docker` and `None` for `Local` or `WineExec`.

**Call relations**: Remote test setup and cleanup use this to decide whether Docker-specific cleanup commands are possible.


##### `TestEnvironment::remote_cwd`  (lines 31–47)

```
fn remote_cwd(&self, instance_id: &str) -> Result<Option<LegacyAppPathString>>
```

**Purpose**: Computes the remote working-directory path for a given test instance ID in the environment's path convention.

**Data flow**: It takes `instance_id`, returns `Ok(None)` for `Local`, otherwise formats a file URI under `/tmp` for Docker or `C:/` for Wine-exec, parses it as `PathUri`, converts it to `LegacyAppPathString` using `self.path_convention()`, and returns `Ok(Some(...))`.

**Call relations**: Higher-level remote test harness code calls this when provisioning a unique cwd inside the remote environment.

*Call graph*: calls 3 internal fn (path_convention, parse, from_path_uri); 1 external calls (format!).


##### `TestEnvironment::path_convention`  (lines 49–55)

```
fn path_convention(&self) -> PathConvention
```

**Purpose**: Returns the filesystem path convention associated with the environment.

**Data flow**: It matches on `self` and returns `PathConvention::native()` for `Local`, `PathConvention::Posix` for `Docker`, and `PathConvention::Windows` for `WineExec`.

**Call relations**: `remote_cwd` uses this to convert file URIs into the legacy path-string representation expected by remote environment APIs.

*Call graph*: calls 1 internal fn (native); called by 1 (remote_cwd).


##### `test_environment`  (lines 58–71)

```
fn test_environment() -> TestEnvironment
```

**Purpose**: Parses the current process environment into a validated `TestEnvironment`, panicking on invalid configuration or unsupported Wine-exec host OS.

**Data flow**: It reads `TEST_ENVIRONMENT_ENV_VAR`, `LEGACY_REMOTE_ENV_ENV_VAR`, and `DOCKER_CONTAINER_ENV_VAR` with `std::env::var_os`, passes them to `parse_test_environment`, panics if parsing fails, then additionally panics if the result is `WineExec` on a non-Linux host. It returns the validated `TestEnvironment`.

**Call relations**: This is the public environment-detection entrypoint used by `get_remote_test_env` and by skip macros in the common test library.

*Call graph*: calls 1 internal fn (parse_test_environment); called by 1 (get_remote_test_env); 4 external calls (cfg!, matches!, panic!, var_os).


##### `get_remote_test_env`  (lines 73–76)

```
fn get_remote_test_env() -> Option<TestEnvironment>
```

**Purpose**: Returns the parsed test environment only when it is remote.

**Data flow**: It calls `test_environment()`, checks `environment.is_remote()`, and returns `Some(environment)` or `None` accordingly.

**Call relations**: Higher-level harness code uses this to branch between local and remote setup without reimplementing environment parsing.

*Call graph*: calls 1 internal fn (test_environment).


##### `parse_test_environment`  (lines 78–120)

```
fn parse_test_environment(
    configured_environment: Option<&OsStr>,
    legacy_remote_environment: Option<&OsStr>,
    docker_container: Option<&OsStr>,
) -> Result<TestEnvironment, String>
```

**Purpose**: Implements the detailed environment-variable parsing and backward-compatibility rules for selecting `Local`, `Docker`, or `WineExec` test mode.

**Data flow**: It takes optional `OsStr` values for the configured environment, legacy remote environment, and Docker container name. It first validates UTF-8 for the configured environment if present. With no configured environment, it falls back to legacy Docker mode when `legacy_remote_environment` is set, otherwise `Local`. For `local`, it returns `Local`. For `docker`, it requires a container name from `DOCKER_CONTAINER_ENV_VAR` or falls back to the legacy variable, validates it with `non_empty_utf8`, and returns `Docker { container_name }`. For `wine-exec`, it returns `WineExec`. Any other configured value yields an error string naming the allowed values.

**Call relations**: This parser is called only by `test_environment`, which turns its `Result` into a panic-on-invalid public API.

*Call graph*: calls 1 internal fn (non_empty_utf8); called by 1 (test_environment); 1 external calls (format!).


##### `non_empty_utf8`  (lines 122–130)

```
fn non_empty_utf8(name: &str, value: &OsStr) -> Result<String, String>
```

**Purpose**: Validates that an environment-variable value is valid UTF-8 and not empty after trimming.

**Data flow**: It takes the variable name and `&OsStr` value, converts it with `to_str()`, trims whitespace, returns an error string if conversion fails or the trimmed value is empty, and otherwise returns an owned `String`.

**Call relations**: `parse_test_environment` uses this helper for Docker container-name validation in both current and legacy configuration paths.

*Call graph*: called by 1 (parse_test_environment); 4 external calls (to_str, to_string, trim, format!).


### `core/tests/common/hooks.rs`

`config` · `test config setup`

This file provides a narrow set of helpers used by tests that need Codex hooks to be treated as already trusted. The central operation is to take a `codex_core::config::Config`, inspect or synthesize its active user TOML layer, and inject per-hook trust records keyed by each `HookListEntry.key`. Each inserted record is a TOML table containing a single `trusted_hash` string set to the hook's `current_hash`, matching the shape expected by hook trust logic.

`trust_discovered_hooks` is the high-level convenience path: it first enables the `Feature::CodexHooks` feature flag on the mutable config, then calls `codex_hooks::list_hooks` with `feature_enabled: true` and the config's cloned `ConfigLayerStack` so discovery runs against the same layered configuration the test will use. It asserts that at least one hook was found, making fixture failures obvious, and then delegates to `trust_hooks`.

`trust_hooks` simply replaces `config.config_layer_stack` with a rewritten stack returned by `trusted_config_layer_stack`. That lower-level function preserves any existing user config if present, otherwise starts from an empty TOML table; it then ensures `hooks`, `hooks.state`, and each hook entry are tables, panicking with explicit messages if the existing user config has an incompatible shape. Finally it rebuilds the stack with `with_user_config`, targeting `<codex_home>/config.toml` via `CONFIG_TOML_FILE`.

#### Function details

##### `trust_discovered_hooks`  (lines 9–25)

```
fn trust_discovered_hooks(config: &mut Config)
```

**Purpose**: Enables the hooks feature in a test config, discovers hooks using the current layered configuration, asserts that discovery found at least one fixture hook, and marks those hooks trusted.

**Data flow**: It takes `&mut Config`, mutates `config.features` to enable `Feature::CodexHooks`, reads `config.config_layer_stack` to build a `codex_hooks::HooksConfig`, receives a discovered hook list from `list_hooks`, asserts the list is non-empty, and then passes the discovered `Vec<HookListEntry>` into `trust_hooks`, which updates `config.config_layer_stack`.

**Call relations**: This is the convenience entry used by higher-level test setup paths such as `configure` and `enable_hooks_and_rmcp_server` when they want fixture hooks trusted without manually enumerating them. After discovery it delegates all persistence of trust state to `trust_hooks`.

*Call graph*: calls 1 internal fn (trust_hooks); called by 2 (configure, enable_hooks_and_rmcp_server); 3 external calls (assert!, list_hooks, default).


##### `trust_hooks`  (lines 27–30)

```
fn trust_hooks(config: &mut Config, hooks: Vec<HookListEntry>)
```

**Purpose**: Replaces the config's layer stack with a version whose user layer contains trust records for the supplied hooks.

**Data flow**: It accepts `&mut Config` plus a `Vec<HookListEntry>`, reads `config.config_layer_stack` and `config.codex_home`, computes a new `ConfigLayerStack` via `trusted_config_layer_stack`, and writes that stack back into `config.config_layer_stack`.

**Call relations**: This is the shared mutation point used both after automatic discovery and by tests that already have a concrete hook list. It is a thin wrapper around `trusted_config_layer_stack`, which performs the actual TOML rewriting.

*Call graph*: calls 1 internal fn (trusted_config_layer_stack); called by 2 (trust_discovered_hooks, trust_plugin_hooks).


##### `trusted_config_layer_stack`  (lines 32–67)

```
fn trusted_config_layer_stack(
    config_layer_stack: &ConfigLayerStack,
    codex_home: &AbsolutePathBuf,
    hooks: Vec<HookListEntry>,
) -> ConfigLayerStack
```

**Purpose**: Builds a new `ConfigLayerStack` whose active user config contains `hooks.state.<hook_key>.trusted_hash = <current_hash>` entries for every provided hook.

**Data flow**: It takes an existing `&ConfigLayerStack`, the `&AbsolutePathBuf` for `codex_home`, and a `Vec<HookListEntry>`. It reads the active user layer if one exists and clones its `TomlValue`; otherwise it starts from `TomlValue::Table(Default::default())`. It then mutates nested TOML tables for `hooks` and `state`, inserts one table per hook keyed by `hook.key` with a `trusted_hash` string from `hook.current_hash`, and returns a new stack from `with_user_config` pointing at `codex_home.join(CONFIG_TOML_FILE)`.

**Call relations**: This is the core implementation called by `trust_hooks` and also reused directly by tests that need a precomputed trusted stack, such as hook-installation helpers. It does not perform discovery itself; it assumes callers already chose the hooks to trust.

*Call graph*: calls 3 internal fn (get_active_user_layer, with_user_config, join); called by 2 (install_mcp_permission_request_hook, trust_hooks); 3 external calls (default, String, Table).


### `core/tests/common/tracing.rs`

`util` · `test setup around tracing-sensitive request handling`

The module defines `TestTracingContext`, a simple holder for two resources that must not be dropped immediately: an `SdkTracerProvider` and a `tracing::dispatcher::DefaultGuard`. The sole constructor, `install_test_tracing`, performs the full setup sequence used by tracing-sensitive tests. It first installs a global `TraceContextPropagator`, so trace context can be injected and extracted using standard W3C traceparent semantics. It then builds a fresh `SdkTracerProvider`, derives a named tracer from the caller-supplied `tracer_name`, and wires that tracer into a `tracing_subscriber` registry via `tracing_opentelemetry::layer().with_tracer(tracer)`. Instead of globally initializing the subscriber for the whole process, it calls `set_default()` and stores the returned guard, making the subscriber active only within the current scope and restoring the previous dispatcher when the context is dropped. That design is important for tests: it avoids cross-test contamination while still enabling span propagation and trace-id assertions. The underscore-prefixed struct fields intentionally suppress unused-field warnings while making the ownership-based lifetime requirement explicit.

#### Function details

##### `install_test_tracing`  (lines 14–26)

```
fn install_test_tracing(tracer_name: &str) -> TestTracingContext
```

**Purpose**: Installs a scoped tracing subscriber backed by an OpenTelemetry tracer and returns the resources that keep it active. It is the one-step setup used by tests that need trace propagation or trace-id emission.

**Data flow**: Accepts `tracer_name: &str` → sets the global text-map propagator to `TraceContextPropagator::new()`, builds an `SdkTracerProvider`, creates a tracer named from `tracer_name.to_string()`, attaches that tracer to a subscriber registry, and calls `set_default()` → returns `TestTracingContext { _provider, _guard }`, whose ownership preserves the provider and active subscriber until drop.

**Call relations**: Tracing-focused integration tests call this during setup before exercising code paths that emit spans or propagate trace context. The function delegates to OpenTelemetry and `tracing_subscriber` constructors to assemble the stack, but intentionally stops at returning a scoped context rather than running any test logic itself.

*Call graph*: called by 8 (new_default_turn_captures_current_span_trace_id, regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm, spawn_task_turn_span_inherits_dispatch_trace_context, submission_dispatch_span_prefers_submission_trace_context, submission_dispatch_span_uses_debug_for_realtime_audio, submit_with_id_captures_current_span_trace_context, responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_reuses_connection_with_per_turn_trace_payloads); 5 external calls (builder, new, set_text_map_propagator, layer, registry).


### `core/tests/common/process.rs`

`util` · `test process coordination`

This file contains focused helpers for tests that need to observe an external process indirectly. `wait_for_pid_file` polls a filesystem path for up to two seconds, repeatedly attempting `fs::read_to_string` and trimming the contents until it finds a non-empty PID string. The polling interval is 25 ms, and timeout errors are wrapped with `anyhow::Context` so failures clearly indicate that the pid file never became usable.

`process_is_alive` uses the Unix `kill -0 <pid>` convention as a non-destructive liveness probe. It shells out to the `kill` command, returning `Ok(true)` when the command succeeds and `Ok(false)` when it exits unsuccessfully; command-launch failures become contextualized errors.

`wait_for_process_exit_inner` is the unbounded async loop that repeatedly calls `process_is_alive` and sleeps 25 ms until the process disappears. The public `wait_for_process_exit` wraps that loop in a two-second `tokio::time::timeout`, cloning the input `&str` PID into an owned `String` so the future can outlive the caller's borrow. Together these helpers let tests assert that long-running sessions survive or terminate at the expected times without embedding process-management logic in each test.

#### Function details

##### `wait_for_pid_file`  (lines 6–22)

```
async fn wait_for_pid_file(path: &Path) -> anyhow::Result<String>
```

**Purpose**: Polls a pid file until it contains a non-empty PID string or a two-second timeout elapses.

**Data flow**: It takes a `&Path`, repeatedly tries `fs::read_to_string(path)`, trims the contents, and returns the first non-empty trimmed string. Between attempts it sleeps 25 ms, and the whole loop is wrapped in a two-second timeout that converts expiry into an `anyhow` error with context.

**Call relations**: Tests that launch background processes call this first to obtain the PID written by the process before performing liveness or shutdown assertions.

*Call graph*: called by 2 (unified_exec_interrupt_preserves_long_running_session, unified_exec_keeps_long_running_session_after_turn_end); 5 external calls (from_millis, from_secs, read_to_string, sleep, timeout).


##### `process_is_alive`  (lines 24–30)

```
fn process_is_alive(pid: &str) -> anyhow::Result<bool>
```

**Purpose**: Checks whether a process identified by PID string appears alive by invoking `kill -0`.

**Data flow**: It takes a PID string slice, runs `std::process::Command::new("kill").args(["-0", pid]).status()`, and returns `Ok(status.success())` or an error if the probe command itself could not be executed.

**Call relations**: This is the low-level liveness probe used by `wait_for_process_exit_inner`.

*Call graph*: called by 1 (wait_for_process_exit_inner); 1 external calls (new).


##### `wait_for_process_exit_inner`  (lines 32–39)

```
async fn wait_for_process_exit_inner(pid: String) -> anyhow::Result<()>
```

**Purpose**: Loops until `process_is_alive` reports that the target PID is no longer running.

**Data flow**: It takes an owned `String` PID, repeatedly calls `process_is_alive(&pid)`, returns `Ok(())` once that becomes false, and otherwise sleeps 25 ms between checks.

**Call relations**: This internal future is wrapped by `wait_for_process_exit` so the public API can impose a timeout while owning the PID string.

*Call graph*: calls 1 internal fn (process_is_alive); called by 1 (wait_for_process_exit); 2 external calls (from_millis, sleep).


##### `wait_for_process_exit`  (lines 41–48)

```
async fn wait_for_process_exit(pid: &str) -> anyhow::Result<()>
```

**Purpose**: Waits up to two seconds for a process to exit, returning an error if it remains alive too long.

**Data flow**: It takes a borrowed PID string, clones it into an owned `String`, runs `wait_for_process_exit_inner(pid)` under a two-second timeout, propagates inner errors, and returns `Ok(())` on successful exit detection.

**Call relations**: Tests use this after obtaining a PID to assert that a background process eventually terminates; it delegates the polling loop to `wait_for_process_exit_inner`.

*Call graph*: calls 1 internal fn (wait_for_process_exit_inner); called by 2 (unified_exec_interrupt_preserves_long_running_session, unified_exec_keeps_long_running_session_after_turn_end); 2 external calls (from_secs, timeout).


### Transport and mock servers
These files supply reusable mock HTTP/SSE infrastructure and fake external services that underpin end-to-end request and streaming tests.

### `core/tests/common/apps_test_server.rs`

`test` · `integration test setup and request inspection`

This test support file defines constants and helpers for standing up a realistic mock Apps surface. `AppsTestServer` stores the base URL that tests inject into `Config`, and its mount methods compose three endpoint groups on a `wiremock::MockServer`: OAuth authorization-server metadata, connector-directory listing endpoints, and a streamable HTTP JSON-RPC endpoint at `/api/codex/apps`. Variants of the mount flow let tests choose a custom connector name, a searchable tool catalog, or inclusion of an app-only tool hidden from normal direct invocation.

The configuration helpers mutate `codex_core::config::Config` for tests: `configure_apps` enables `Feature::Apps` and points `chatgpt_base_url` at the mock server, while `configure_search_capable_model` edits the bundled model catalog so `gpt-5.4` advertises `supports_search_tool = true`. Builder helpers wrap those mutations into `TestCodexBuilder` instances with dummy ChatGPT auth.

For assertions, the file can inspect recorded requests and filter them down to Apps `tools/call` JSON-RPC bodies, then select exactly one by `_codex_apps.call_id` or by tool name. The heart of the fake server is `CodexAppsJsonRpcResponder::respond`, which parses incoming JSON, validates the `method` field, and returns realistic JSON-RPC responses for `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, generic notifications, and unknown methods. The `tools/list` response includes rich `_meta` payloads, schemas, optional searchable filler tools up to `SEARCHABLE_TOOL_COUNT`, and an optional app-only tool with `ui.visibility = ["app"]`, allowing higher-level tests to exercise discovery, filtering, deferred loading, file parameters, and metadata propagation.

#### Function details

##### `AppsTestServer::mount`  (lines 62–64)

```
async fn mount(server: &MockServer) -> Result<Self>
```

**Purpose**: Mounts the standard fake Apps server using the default connector name.

**Data flow**: Accepts a `&MockServer`, delegates to `Self::mount_with_connector_name(server, CONNECTOR_NAME)`, and returns the resulting `AppsTestServer` in a `Result`.

**Call relations**: Many integration tests call this as the simplest setup path. It is a thin wrapper over `mount_with_connector_name`.

*Call graph*: called by 12 (includes_apps_guidance_as_developer_message_for_chatgpt_auth, omits_apps_guidance_for_api_key_auth_even_when_feature_enabled, omits_apps_guidance_when_configured_off, approved_mcp_tool_call_metadata_records_prior_user_input_request, apps_default_auto_review_routes_actual_mcp_approval_to_guardian, mcp_tool_call_metadata_records_prior_request_user_input_tool, codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook, codex_apps_file_params_upload_environment_files_before_mcp_tool_call, request_plugin_install_is_available_without_search_tool_after_discovery_attempts, always_defer_feature_hides_small_app_tool_sets (+2 more)); 1 external calls (mount_with_connector_name).


##### `AppsTestServer::mount_searchable`  (lines 66–80)

```
async fn mount_searchable(server: &MockServer) -> Result<Self>
```

**Purpose**: Mounts the fake Apps server with a large searchable tool catalog suitable for tool-search tests.

**Data flow**: Given a `&MockServer`, it awaits `mount_oauth_metadata`, `mount_connectors_directory`, and `mount_streamable_http_json_rpc` with `searchable = true` and `include_app_only_tool = false`, then returns `AppsTestServer { chatgpt_base_url: server.uri() }`.

**Call relations**: Search-related integration tests invoke this variant so the responder's `tools/list` branch will append many extra tools for indexing and deferred-loading scenarios.

*Call graph*: calls 3 internal fn (mount_connectors_directory, mount_oauth_metadata, mount_streamable_http_json_rpc); called by 9 (code_mode_only_guides_all_tools_search_and_calls_deferred_app_tools, search_tool_adds_discovery_instructions_to_tool_description, search_tool_enabled_by_default_adds_tool_search, search_tool_hides_apps_tools_without_search, tool_search_indexes_only_enabled_non_app_mcp_tools, tool_search_matches_mcp_tools_by_distinct_name_description_and_schema_terms, tool_search_returns_deferred_tools_without_follow_up_tool_injection, tool_search_surfaced_mcp_tool_errors_are_returned_to_model, tool_search_uses_non_app_mcp_server_instructions_as_namespace_description); 1 external calls (uri).


##### `AppsTestServer::mount_with_connector_name`  (lines 82–99)

```
async fn mount_with_connector_name(
        server: &MockServer,
        connector_name: &str,
    ) -> Result<Self>
```

**Purpose**: Mounts the fake Apps server while allowing tests to override the connector display name returned in tool metadata.

**Data flow**: Accepts a `&MockServer` and `&str` connector name, mounts OAuth metadata and connector-directory endpoints, mounts the JSON-RPC responder with the provided connector name, default description, `searchable = false`, and `include_app_only_tool = false`, then returns an `AppsTestServer` containing `server.uri()`.

**Call relations**: Tests that care about connector naming call this directly. `AppsTestServer::mount` delegates here for the default-name case.

*Call graph*: calls 3 internal fn (mount_connectors_directory, mount_oauth_metadata, mount_streamable_http_json_rpc); called by 3 (capability_sections_render_in_developer_message_in_order, explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins); 1 external calls (uri).


##### `AppsTestServer::mount_with_app_only_tool`  (lines 101–118)

```
async fn mount_with_app_only_tool(
        server: &MockServer,
        tool_loading: AppsTestToolLoading,
    ) -> Result<Self>
```

**Purpose**: Mounts the fake Apps server with an additional app-only tool, optionally in searchable mode.

**Data flow**: Accepts a `&MockServer` and `AppsTestToolLoading`, mounts OAuth metadata and connector-directory endpoints, computes `searchable` with `matches!(tool_loading, AppsTestToolLoading::Searchable)`, mounts the JSON-RPC responder with `include_app_only_tool = true`, and returns an `AppsTestServer` with the server URI.

**Call relations**: Tests that verify app-only tool visibility and invocation behavior use this setup path. It differs from the other mount helpers only in responder configuration.

*Call graph*: calls 3 internal fn (mount_connectors_directory, mount_oauth_metadata, mount_streamable_http_json_rpc); called by 2 (app_only_tools_are_not_visible_or_runnable_by_code_mode_model, app_only_tools_are_not_visible_or_runnable_by_direct_model_calls); 2 external calls (uri, matches!).


##### `configure_search_capable_model`  (lines 121–131)

```
fn configure_search_capable_model(config: &mut Config)
```

**Purpose**: Mutates test config so model `gpt-5.4` is selected and marked as supporting the search tool.

**Data flow**: Loads the bundled model catalog with `bundled_models_response()`, finds the mutable model whose `slug` is `"gpt-5.4"`, sets `config.model = Some("gpt-5.4".to_string())`, flips `model.supports_search_tool = true`, and stores the modified catalog in `config.model_catalog`.

**Call relations**: This helper is called by `configure_search_capable_apps` to make Apps tests exercise search-capable model behavior.

*Call graph*: called by 1 (configure_search_capable_apps); 1 external calls (bundled_models_response).


##### `configure_apps`  (lines 133–139)

```
fn configure_apps(config: &mut Config, apps_base_url: &str)
```

**Purpose**: Enables the Apps feature and points the config at the mock Apps base URL.

**Data flow**: Mutably borrows `Config`, enables `Feature::Apps` on `config.features`, and writes `apps_base_url.to_string()` into `config.chatgpt_base_url`.

**Call relations**: It is the shared base configuration step used by `configure_search_capable_apps` and indirectly by the builder helpers.

*Call graph*: called by 1 (configure_search_capable_apps).


##### `configure_search_capable_apps`  (lines 141–144)

```
fn configure_search_capable_apps(config: &mut Config, apps_base_url: &str)
```

**Purpose**: Combines Apps enablement with search-capable model configuration for tests that need both.

**Data flow**: Takes mutable `Config` and an Apps base URL, calls `configure_apps(config, apps_base_url)`, then `configure_search_capable_model(config)`. It returns unit after mutating the config in place.

**Call relations**: This helper is used by `search_capable_apps_builder` to prepare a fully search-enabled test configuration.

*Call graph*: calls 2 internal fn (configure_apps, configure_search_capable_model).


##### `apps_enabled_builder`  (lines 146–151)

```
fn apps_enabled_builder(apps_base_url: impl Into<String>) -> TestCodexBuilder
```

**Purpose**: Builds a `TestCodexBuilder` configured with dummy ChatGPT auth and Apps enabled against the supplied mock base URL.

**Data flow**: Consumes any `apps_base_url` convertible into `String`, stores the owned string, starts from `test_codex()`, injects dummy ChatGPT auth via `with_auth(CodexAuth::create_dummy_chatgpt_auth_for_testing())`, and adds a config mutation closure that calls `configure_apps` with the captured URL.

**Call relations**: Integration tests that need Apps but not search capability call this builder helper. It packages auth and config wiring into one reusable setup step.

*Call graph*: calls 2 internal fn (test_codex, create_dummy_chatgpt_auth_for_testing); called by 3 (codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook, codex_apps_file_params_upload_environment_files_before_mcp_tool_call, app_only_tools_are_not_visible_or_runnable_by_direct_model_calls); 1 external calls (into).


##### `search_capable_apps_builder`  (lines 153–158)

```
fn search_capable_apps_builder(apps_base_url: impl Into<String>) -> TestCodexBuilder
```

**Purpose**: Builds a `TestCodexBuilder` configured for Apps plus a search-capable model against the supplied mock base URL.

**Data flow**: Converts the base URL into an owned `String`, starts from `test_codex()`, injects dummy ChatGPT auth, and adds a config mutation closure that calls `configure_search_capable_apps` with the captured URL.

**Call relations**: Search-oriented Apps integration tests use this helper instead of `apps_enabled_builder` so both feature and model capabilities are enabled.

*Call graph*: calls 2 internal fn (test_codex, create_dummy_chatgpt_auth_for_testing); called by 14 (app_only_tools_are_not_visible_or_runnable_by_code_mode_model, approved_mcp_tool_call_metadata_records_prior_user_input_request, apps_default_auto_review_routes_actual_mcp_approval_to_guardian, mcp_tool_call_metadata_records_prior_request_user_input_tool, always_defer_feature_hides_small_app_tool_sets, explicit_app_mentions_respect_always_defer, search_tool_adds_discovery_instructions_to_tool_description, search_tool_enabled_by_default_adds_tool_search, search_tool_hides_apps_tools_without_search, tool_search_indexes_only_enabled_non_app_mcp_tools (+4 more)); 1 external calls (into).


##### `apps_tool_call_id`  (lines 160–166)

```
fn apps_tool_call_id(body: &Value) -> Option<&str>
```

**Purpose**: Extracts the `_codex_apps.call_id` field from a JSON-RPC request body if present.

**Data flow**: Traverses a `serde_json::Value` through `params -> _meta -> _codex_apps -> call_id`, returning `Some(&str)` if each level exists and the final value is a string, otherwise `None`.

**Call relations**: This private helper is used by `recorded_apps_tool_call_by_call_id` when filtering captured `tools/call` requests.

*Call graph*: 1 external calls (get).


##### `recorded_apps_tool_calls`  (lines 168–181)

```
async fn recorded_apps_tool_calls(server: &MockServer) -> Vec<Value>
```

**Purpose**: Returns all captured Apps `tools/call` JSON-RPC request bodies received by the mock server.

**Data flow**: Awaits `server.received_requests()`, expects capture support to succeed, iterates over requests, parses each body as JSON, filters to requests whose URL path is `/api/codex/apps` and whose `method` field is `"tools/call"`, and collects the matching JSON bodies into a `Vec<Value>`.

**Call relations**: This is the common request-inspection primitive used by both `recorded_apps_tool_call_by_call_id` and `recorded_apps_tool_call_by_name`.

*Call graph*: called by 2 (recorded_apps_tool_call_by_call_id, recorded_apps_tool_call_by_name); 1 external calls (received_requests).


##### `recorded_apps_tool_call_by_call_id`  (lines 183–198)

```
async fn recorded_apps_tool_call_by_call_id(server: &MockServer, call_id: &str) -> Value
```

**Purpose**: Finds exactly one recorded Apps `tools/call` request matching a specific `_codex_apps.call_id`.

**Data flow**: Awaits `recorded_apps_tool_calls(server)`, filters the resulting bodies with `apps_tool_call_id(body) == Some(call_id)`, collects matches, asserts there is exactly one, and returns that single `Value`.

**Call relations**: Tests that need to inspect metadata propagation for a specific tool call invoke this helper. It builds on `recorded_apps_tool_calls` and the `apps_tool_call_id` extractor.

*Call graph*: calls 1 internal fn (recorded_apps_tool_calls); called by 4 (approved_mcp_tool_call_metadata_records_prior_user_input_request, apps_default_auto_review_routes_actual_mcp_approval_to_guardian, mcp_tool_call_metadata_records_prior_request_user_input_tool, tool_search_returns_deferred_tools_without_follow_up_tool_injection); 1 external calls (assert_eq!).


##### `recorded_apps_tool_call_by_name`  (lines 200–215)

```
async fn recorded_apps_tool_call_by_name(server: &MockServer, tool_name: &str) -> Value
```

**Purpose**: Finds exactly one recorded Apps `tools/call` request by the tool name in `/params/name`.

**Data flow**: Awaits `recorded_apps_tool_calls(server)`, filters bodies whose `/params/name` string equals `tool_name`, collects matches, asserts there is exactly one, and returns that body.

**Call relations**: This helper is used by tests that care about a specific tool invocation but not its call ID, such as file-parameter upload flows.

*Call graph*: calls 1 internal fn (recorded_apps_tool_calls); called by 1 (codex_apps_file_params_upload_environment_files_before_mcp_tool_call); 1 external calls (assert_eq!).


##### `mount_oauth_metadata`  (lines 217–227)

```
async fn mount_oauth_metadata(server: &MockServer)
```

**Purpose**: Registers the OAuth authorization-server metadata endpoint expected by Apps clients.

**Data flow**: Builds a wiremock `Mock` matching `GET /.well-known/oauth-authorization-server/mcp`, responds with HTTP 200 and JSON containing authorization and token endpoints derived from `server.uri()` plus a trivial `scopes_supported` array, mounts it on the server, and awaits completion.

**Call relations**: All Apps server mount variants call this first so client initialization can discover OAuth metadata.

*Call graph*: called by 3 (mount_searchable, mount_with_app_only_tool, mount_with_connector_name); 5 external calls (given, new, json!, method, path).


##### `mount_connectors_directory`  (lines 229–258)

```
async fn mount_connectors_directory(server: &MockServer)
```

**Purpose**: Registers mock connector-directory endpoints for discoverable and workspace-specific apps.

**Data flow**: Mounts one `GET /connectors/directory/list` mock returning two discoverable apps (Google Calendar and Gmail) with IDs, names, descriptions, and `nextToken: null`, then mounts a second `GET /connectors/directory/list_workspace` mock returning an empty app list and `nextToken: null`.

**Call relations**: Every Apps server mount helper calls this so tests can exercise connector discovery alongside JSON-RPC tool access.

*Call graph*: called by 3 (mount_searchable, mount_with_app_only_tool, mount_with_connector_name); 5 external calls (given, new, json!, method, path).


##### `mount_streamable_http_json_rpc`  (lines 260–277)

```
async fn mount_streamable_http_json_rpc(
    server: &MockServer,
    connector_name: String,
    connector_description: String,
    searchable: bool,
    include_app_only_tool: bool,
)
```

**Purpose**: Registers the main Apps JSON-RPC endpoint and binds it to a configurable responder instance.

**Data flow**: Accepts server plus connector metadata and behavior flags, creates a wiremock `Mock` matching `POST` requests whose path matches `^/api/codex/apps/?$`, attaches a `CodexAppsJsonRpcResponder` populated with those fields, mounts it on the server, and awaits completion.

**Call relations**: This is called by all `AppsTestServer` mount variants after metadata and directory endpoints are installed. It is the entry point to `CodexAppsJsonRpcResponder::respond`.

*Call graph*: called by 3 (mount_searchable, mount_with_app_only_tool, mount_with_connector_name); 3 external calls (given, method, path_regex).


##### `CodexAppsJsonRpcResponder::respond`  (lines 287–527)

```
fn respond(&self, request: &Request) -> ResponseTemplate
```

**Purpose**: Implements the fake Apps JSON-RPC protocol, returning realistic responses for initialization, tool listing, tool invocation, notifications, and unknown methods.

**Data flow**: Receives a wiremock `Request`, parses `request.body` as `serde_json::Value`, and returns HTTP 400 with an error JSON if parsing fails or if `method` is missing. For `initialize`, it echoes the request `id`, uses the requested protocol version or a default, and returns server capabilities and server info. For `notifications/initialized` and any `notifications/*` method it returns HTTP 202. For `tools/list`, it builds a JSON-RPC result containing three base tools with schemas and `_meta` blocks, optionally appends many searchable filler tools when `self.searchable` is true, and optionally appends an app-only tool when `self.include_app_only_tool` is true. For `tools/call`, it extracts request fields like tool name, title, starts_at, file_id, and `_codex_apps` metadata, then returns a success result whose text content echoes those values and whose `structuredContent._codex_apps` mirrors the incoming metadata. For any other method, it returns a JSON-RPC error with code `-32601` and a `method not found` message.

**Call relations**: Wiremock invokes this responder for requests matched by `mount_streamable_http_json_rpc`. Higher-level integration tests depend on its branch behavior to simulate Apps discovery, deferred tool loading, file parameter handling, and metadata round-tripping.

*Call graph*: 3 external calls (new, json!, from_slice).


### `core/tests/common/context_snapshot.rs`

`test` · `test snapshot rendering`

This test utility file turns `ResponsesRequest` inputs and raw response-item arrays into deterministic snapshot strings. `ContextSnapshotOptions` controls rendering with four modes: fully redacted text, full text, kind-only summaries, or kind plus a text prefix, along with booleans to strip capability-instruction fragments from developer messages and AGENTS.md user-context fragments from user messages. The main formatter, `format_response_items_snapshot`, walks each JSON item, emits a numbered line, and branches by item `type`. Message items receive the richest handling: it inspects each content entry, preserves text after optional stripping and normalization, renders non-text spans as `<type>` or `<type:key1,key2>`, collapses single-part messages to one line, and expands multi-part messages into indented numbered sublines. Other item types summarize function calls, shell commands, reasoning summaries plus encrypted-content presence, and compaction markers.

For full request-body parity tests, `format_request_body_snapshot` obtains `request.body_json()`, recursively canonicalizes all JSON values, sorts object keys for stable ordering, and normalizes every string through `format_snapshot_json_string`. That string path canonicalizes known instruction payloads into placeholders like `<APPS_INSTRUCTIONS>`, `<AGENTS_MD>`, and `<ENVIRONMENT_CONTEXT:cwd=<CWD>:subagents=N>`, normalizes line endings, rewrites dynamic filesystem skill paths, and redacts UUIDs, sandbox names, and turn timestamps with regexes cached in `OnceLock<Regex>`. `format_changed_lines_diff` then computes a line diff using `similar::TextDiff`, emitting only inserted and deleted lines with `---/+++` headers. The embedded tests cover each rendering mode and the key normalization rules, ensuring snapshots stay stable across environments and runs.

#### Function details

##### `ContextSnapshotOptions::default`  (lines 31–37)

```
fn default() -> Self
```

**Purpose**: Constructs snapshot options with redacted-text rendering and no stripping of capability or AGENTS.md fragments.

**Data flow**: Returns `ContextSnapshotOptions { render_mode: RedactedText, strip_capability_instructions: false, strip_agents_md_user_context: false }` with no inputs or side effects.

**Call relations**: This default is the starting point for most snapshot tests and helper builders, which then optionally chain the mutating builder-style methods below.

*Call graph*: called by 19 (guardian_snapshot_options, fork_startup_context_then_first_turn_diff_snapshot, full_text_mode_normalizes_crlf_line_endings, full_text_mode_preserves_unredacted_text, image_only_message_is_rendered_as_non_text_span, kind_with_text_prefix_mode_normalizes_crlf_line_endings, mixed_text_and_image_message_keeps_image_span, redacted_text_mode_keeps_canonical_placeholders, redacted_text_mode_keeps_capability_instruction_placeholders, redacted_text_mode_normalizes_environment_context_with_subagents (+9 more)).


##### `ContextSnapshotOptions::render_mode`  (lines 41–44)

```
fn render_mode(mut self, render_mode: ContextSnapshotRenderMode) -> Self
```

**Purpose**: Sets the desired rendering mode on a snapshot-options value in builder style.

**Data flow**: Consumes `self`, overwrites `self.render_mode` with the provided `ContextSnapshotRenderMode`, and returns the updated options value.

**Call relations**: Callers chain this after `default()` to switch between redacted, full-text, kind-only, or prefix modes before passing options into formatting helpers.


##### `ContextSnapshotOptions::strip_capability_instructions`  (lines 46–49)

```
fn strip_capability_instructions(mut self) -> Self
```

**Purpose**: Enables omission of Apps/Skills/Plugins instruction fragments from developer-message snapshots.

**Data flow**: Consumes `self`, sets `self.strip_capability_instructions = true`, and returns the updated options.

**Call relations**: This flag is consulted inside `format_response_items_snapshot` when iterating developer-message text parts.


##### `ContextSnapshotOptions::strip_agents_md_user_context`  (lines 51–54)

```
fn strip_agents_md_user_context(mut self) -> Self
```

**Purpose**: Enables omission of AGENTS.md instruction fragments from user-message snapshots.

**Data flow**: Consumes `self`, sets `self.strip_agents_md_user_context = true`, and returns the updated options.

**Call relations**: This flag is checked by `format_response_items_snapshot` when processing user-message text entries.


##### `format_request_input_snapshot`  (lines 57–63)

```
fn format_request_input_snapshot(
    request: &ResponsesRequest,
    options: &ContextSnapshotOptions,
) -> String
```

**Purpose**: Formats the input items of a `ResponsesRequest` using the standard response-item snapshot renderer.

**Data flow**: Reads `request.input()`, takes the resulting collection as a slice, passes it with `options` to `format_response_items_snapshot`, and returns the produced snapshot string.

**Call relations**: This is a convenience wrapper over `format_response_items_snapshot` for callers that have a full `ResponsesRequest` rather than a raw item slice.

*Call graph*: calls 2 internal fn (format_response_items_snapshot, input).


##### `format_response_items_snapshot`  (lines 65–209)

```
fn format_response_items_snapshot(items: &[Value], options: &ContextSnapshotOptions) -> String
```

**Purpose**: Renders a numbered textual snapshot of response/input items, with type-specific formatting and optional text redaction or stripping.

**Data flow**: Iterates over `&[Value]` with indices, extracts each item's `type`, and emits a fallback `<MISSING_TYPE>` line when absent. In `KindOnly` mode it emits only item kinds and message roles. Otherwise it branches by type: `message` items inspect `role` and `content`, optionally drop capability or AGENTS.md text parts based on options, normalize text via `format_snapshot_text`, render non-text content as angle-bracket spans with extra keys, and choose single-line or multi-line output depending on part count; `function_call` emits the function name; `function_call_output` formats string output or `<NON_STRING_OUTPUT>`; `local_shell_call` joins command parts and formats them or emits `<NO_COMMAND>`; `reasoning` summarizes the first summary text and whether encrypted content exists; `compaction` reports only encrypted-content presence; unknown types are emitted by raw type name. It joins all rendered lines with newlines and returns the final string.

**Call relations**: This is the central formatter used by `format_request_input_snapshot`, `format_labeled_requests_snapshot`, `format_labeled_items_snapshot`, and many unit tests in the embedded test module.

*Call graph*: called by 13 (format_request_input_snapshot, full_text_mode_normalizes_crlf_line_endings, full_text_mode_preserves_unredacted_text, image_only_message_is_rendered_as_non_text_span, kind_with_text_prefix_mode_normalizes_crlf_line_endings, mixed_text_and_image_message_keeps_image_span, redacted_text_mode_keeps_canonical_placeholders, redacted_text_mode_keeps_capability_instruction_placeholders, redacted_text_mode_normalizes_environment_context_with_subagents, redacted_text_mode_normalizes_system_skill_temp_paths (+3 more)); 1 external calls (iter).


##### `format_labeled_requests_snapshot`  (lines 211–227)

```
fn format_labeled_requests_snapshot(
    scenario: &str,
    sections: &[(&str, &ResponsesRequest)],
    options: &ContextSnapshotOptions,
) -> String
```

**Purpose**: Formats multiple labeled `ResponsesRequest` snapshots under a scenario heading.

**Data flow**: Accepts a scenario string, a slice of `(title, &ResponsesRequest)` pairs, and options. It maps each section to `## <title>` plus the result of `format_request_input_snapshot`, joins sections with blank lines, prefixes `Scenario: <scenario>`, and returns the combined string.

**Call relations**: Higher-level tests use this to compare several request snapshots in one assertion. It delegates per-request rendering to `format_request_input_snapshot`.

*Call graph*: called by 5 (fork_startup_context_then_first_turn_diff_snapshot, format_labeled_requests_snapshot, format_labeled_requests_snapshot, format_labeled_requests_snapshot, new_context_tool_starts_new_window_before_follow_up); 2 external calls (iter, format!).


##### `format_labeled_items_snapshot`  (lines 229–245)

```
fn format_labeled_items_snapshot(
    scenario: &str,
    sections: &[(&str, &[Value])],
    options: &ContextSnapshotOptions,
) -> String
```

**Purpose**: Formats multiple labeled raw item slices under a scenario heading.

**Data flow**: Accepts a scenario string, a slice of `(title, &[Value])` pairs, and options. It maps each section to a heading plus `format_response_items_snapshot(items, options)`, joins sections with blank lines, and returns the final scenario-prefixed string.

**Call relations**: This is the raw-items counterpart to `format_labeled_requests_snapshot`, used when tests already have item arrays rather than full requests.

*Call graph*: called by 1 (assert_two_responses_input_snapshot); 2 external calls (iter, format!).


##### `format_request_body_diff_snapshot`  (lines 251–263)

```
fn format_request_body_diff_snapshot(
    scenario: &str,
    before_title: &str,
    before_request: &ResponsesRequest,
    after_title: &str,
    after_request: &ResponsesRequest,
    options: &Cont
```

**Purpose**: Produces a snapshot containing only changed lines between two full `/responses` request bodies after canonicalization and redaction.

**Data flow**: Formats `before_request` and `after_request` through `format_request_body_snapshot`, computes a changed-lines diff with `format_changed_lines_diff(before_title, &before, after_title, &after)`, prefixes the scenario heading, and returns the resulting string.

**Call relations**: Request-parity tests call this when they need a compact diff of whole JSON payloads rather than item-level summaries. It delegates body rendering and diffing to dedicated helpers.

*Call graph*: calls 2 internal fn (format_changed_lines_diff, format_request_body_snapshot); 1 external calls (format!).


##### `format_request_body_snapshot`  (lines 265–272)

```
fn format_request_body_snapshot(
    request: &ResponsesRequest,
    options: &ContextSnapshotOptions,
) -> String
```

**Purpose**: Canonicalizes and pretty-prints a request's full JSON body for stable snapshot comparison.

**Data flow**: Calls `request.body_json()` to obtain a mutable `Value`, recursively canonicalizes it with `canonicalize_json_snapshot_value`, then serializes it with `serde_json::to_string_pretty`, panicking if serialization fails.

**Call relations**: This helper is used by `format_request_body_diff_snapshot` as the normalized input to line-based diffing.

*Call graph*: calls 2 internal fn (canonicalize_json_snapshot_value, body_json); called by 1 (format_request_body_diff_snapshot); 1 external calls (to_string_pretty).


##### `canonicalize_json_snapshot_value`  (lines 274–295)

```
fn canonicalize_json_snapshot_value(value: &mut Value, options: &ContextSnapshotOptions)
```

**Purpose**: Recursively normalizes a JSON value for snapshot stability by sorting object keys and rewriting all strings through snapshot string formatting.

**Data flow**: Mutably matches on a `serde_json::Value`. For arrays it recursively canonicalizes each element. For objects it `take`s the map, collects entries into a vector, sorts by key, recursively canonicalizes each value, and reinserts entries in sorted order. For strings it replaces the text with `format_snapshot_json_string(text, options)`. Nulls, booleans, and numbers are left unchanged.

**Call relations**: This function is called only by `format_request_body_snapshot` and is the recursive engine behind stable full-body snapshots.

*Call graph*: calls 1 internal fn (format_snapshot_json_string); called by 1 (format_request_body_snapshot); 1 external calls (take).


##### `format_snapshot_json_string`  (lines 297–320)

```
fn format_snapshot_json_string(text: &str, options: &ContextSnapshotOptions) -> String
```

**Purpose**: Normalizes a JSON string value according to snapshot options, including canonical placeholders, dynamic-value redaction, line-ending normalization, and optional prefix truncation.

**Data flow**: Accepts raw `text` and options. In redacted or prefix modes it canonicalizes known text blocks with `canonicalize_snapshot_text`, normalizes line endings, then redacts dynamic values with `normalize_snapshot_dynamic_values`; in full-text mode it only normalizes line endings. If the mode is `KindWithTextPrefix` and the normalized string exceeds `max_chars`, it truncates to that many characters and appends `...`; otherwise it returns the normalized string. `KindOnly` is treated as unreachable.

**Call relations**: It is used by `canonicalize_json_snapshot_value` for every JSON string in full-body snapshots, and is also directly tested by the dynamic-turn-metadata unit test.

*Call graph*: calls 3 internal fn (canonicalize_snapshot_text, normalize_snapshot_dynamic_values, normalize_snapshot_line_endings); called by 2 (canonicalize_json_snapshot_value, redacted_text_mode_normalizes_turn_metadata_dynamic_json_strings); 2 external calls (format!, unreachable!).


##### `format_changed_lines_diff`  (lines 322–343)

```
fn format_changed_lines_diff(
    before_title: &str,
    before: &str,
    after_title: &str,
    after: &str,
) -> String
```

**Purpose**: Builds a compact unified-style diff containing only inserted and deleted lines between two strings.

**Data flow**: Starts a string with `--- <before_title>` and `+++ <after_title>`, computes a line diff via `TextDiff::from_lines(before, after)`, iterates all changes, ignores equal lines, prefixes deleted lines with `-` and inserted lines with `+`, appends each changed line's original text, and returns the diff string.

**Call relations**: This helper is called by `format_request_body_diff_snapshot` after both request bodies have been canonicalized and pretty-printed.

*Call graph*: called by 1 (format_request_body_diff_snapshot); 2 external calls (from_lines, format!).


##### `format_snapshot_text`  (lines 345–365)

```
fn format_snapshot_text(text: &str, options: &ContextSnapshotOptions) -> String
```

**Purpose**: Formats free-form text content for item-level snapshots according to the selected render mode.

**Data flow**: In `RedactedText` mode it canonicalizes known text blocks, normalizes line endings, and escapes newlines as `\n`. In `FullText` mode it only normalizes line endings and escapes newlines. In `KindWithTextPrefix` mode it canonicalizes and normalizes similarly, escapes newlines, and truncates to `max_chars` with `...` if needed. `KindOnly` is unreachable.

**Call relations**: This function is used inside `format_response_items_snapshot` for message text, function-call output strings, shell commands, and reasoning summaries.

*Call graph*: calls 2 internal fn (canonicalize_snapshot_text, normalize_snapshot_line_endings); 2 external calls (format!, unreachable!).


##### `normalize_snapshot_line_endings`  (lines 367–369)

```
fn normalize_snapshot_line_endings(text: &str) -> String
```

**Purpose**: Converts CRLF and lone CR line endings to LF for snapshot stability across platforms.

**Data flow**: Takes `&str`, replaces `"\r\n"` with `"\n"`, then replaces remaining `\r` with `\n`, and returns the normalized string.

**Call relations**: Both `format_snapshot_json_string` and `format_snapshot_text` call this before further rendering so snapshots are insensitive to platform-specific line endings.

*Call graph*: called by 2 (format_snapshot_json_string, format_snapshot_text).


##### `canonicalize_snapshot_text`  (lines 371–426)

```
fn canonicalize_snapshot_text(text: &str) -> String
```

**Purpose**: Rewrites known large or environment-specific text blocks into stable placeholders while preserving meaningful structure where needed.

**Data flow**: Examines the start of `text` and returns fixed placeholders for permissions instructions, Apps/Skills/Plugins instruction blocks, AGENTS.md instructions, summarization prompts, and compaction summaries. For `<environment_context>` blocks it optionally counts `- ` lines inside `<subagents>`, extracts `<cwd>...</cwd>` when present, and returns placeholders such as `<ENVIRONMENT_CONTEXT:cwd=<CWD>:subagents=2>` or a special `PRETURN_CONTEXT_DIFF_CWD` variant. If no special case matches, it delegates to `normalize_dynamic_snapshot_paths(text)`.

**Call relations**: This is the main semantic redaction helper used by both `format_snapshot_json_string` and `format_snapshot_text`.

*Call graph*: calls 1 internal fn (normalize_dynamic_snapshot_paths); called by 2 (format_snapshot_json_string, format_snapshot_text); 2 external calls (new, format!).


##### `is_capability_instruction_text`  (lines 428–432)

```
fn is_capability_instruction_text(text: &str) -> bool
```

**Purpose**: Recognizes whether a text fragment is one of the capability-instruction blocks that may be stripped from developer messages.

**Data flow**: Checks whether `text` starts with any of `APPS_INSTRUCTIONS_OPEN_TAG`, `SKILLS_INSTRUCTIONS_OPEN_TAG`, or `PLUGINS_INSTRUCTIONS_OPEN_TAG`, and returns the resulting boolean.

**Call relations**: It is consulted inside `format_response_items_snapshot` when `strip_capability_instructions` is enabled.


##### `normalize_dynamic_snapshot_paths`  (lines 434–443)

```
fn normalize_dynamic_snapshot_paths(text: &str) -> String
```

**Purpose**: Rewrites environment-specific system-skill file paths into a stable placeholder rooted at `<SYSTEM_SKILLS_ROOT>`.

**Data flow**: Uses a lazily initialized `Regex` stored in `OnceLock` to match paths ending in `/skills/.system/<name>/SKILL.md`, replaces matches with `<SYSTEM_SKILLS_ROOT>/$1/SKILL.md`, and returns the owned normalized string.

**Call relations**: This helper is the fallback path from `canonicalize_snapshot_text` when no higher-level placeholder rule applies.

*Call graph*: called by 1 (canonicalize_snapshot_text); 1 external calls (new).


##### `normalize_snapshot_dynamic_values`  (lines 445–467)

```
fn normalize_snapshot_dynamic_values(text: &str) -> String
```

**Purpose**: Redacts dynamic scalar values embedded inside JSON-like strings, such as UUIDs, sandbox names, and turn timestamps.

**Data flow**: Uses three lazily initialized regexes in `OnceLock`s: one replaces UUIDs with `<UUID>`, one rewrites `"turn_started_at_unix_ms":<number>` to `"turn_started_at_unix_ms":<UNIX_MS>`, and one rewrites `"sandbox":"..."` to `"sandbox":"<SANDBOX>"`. It applies them in sequence and returns the final owned string.

**Call relations**: This helper is called by `format_snapshot_json_string` in redacted and prefix modes so full-body snapshots remain stable across runs.

*Call graph*: called by 1 (format_snapshot_json_string); 1 external calls (new).


##### `tests::full_text_mode_preserves_unredacted_text`  (lines 479–498)

```
fn full_text_mode_preserves_unredacted_text()
```

**Purpose**: Verifies that full-text rendering leaves AGENTS.md content intact instead of replacing it with a placeholder.

**Data flow**: Builds a one-item message array containing AGENTS.md text, formats it with `format_response_items_snapshot` using `ContextSnapshotOptions::default().render_mode(FullText)`, and asserts the exact unredacted rendered string.

**Call relations**: This unit test is run by the test harness and validates the `FullText` branch of `format_snapshot_text` through the main item formatter.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::full_text_mode_normalizes_crlf_line_endings`  (lines 501–517)

```
fn full_text_mode_normalizes_crlf_line_endings()
```

**Purpose**: Verifies that full-text rendering still normalizes CRLF line endings to LF.

**Data flow**: Creates a message item whose text contains `\r\n`, formats it in `FullText` mode, and asserts the output contains normalized `\n` escapes.

**Call relations**: This test exercises `normalize_snapshot_line_endings` as reached through `format_response_items_snapshot` and `format_snapshot_text` in full-text mode.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_keeps_canonical_placeholders`  (lines 520–536)

```
fn redacted_text_mode_keeps_canonical_placeholders()
```

**Purpose**: Verifies that redacted mode replaces AGENTS.md instruction text with the canonical `<AGENTS_MD>` placeholder.

**Data flow**: Builds a message item with AGENTS.md text, formats it with default redacted options, and asserts the rendered snapshot is exactly `00:message/user:<AGENTS_MD>`.

**Call relations**: This test validates the AGENTS.md branch in `canonicalize_snapshot_text` as used by the main item formatter.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_keeps_capability_instruction_placeholders`  (lines 539–568)

```
fn redacted_text_mode_keeps_capability_instruction_placeholders()
```

**Purpose**: Verifies that Apps, Skills, and Plugins instruction blocks are each canonicalized to their dedicated placeholders in redacted mode.

**Data flow**: Creates a developer message with three text parts, one for each capability instruction block, formats it with default redacted options, and asserts the multi-part rendered output contains `<APPS_INSTRUCTIONS>`, `<SKILLS_INSTRUCTIONS>`, and `<PLUGINS_INSTRUCTIONS>` in order.

**Call relations**: This test covers multiple branches of `canonicalize_snapshot_text` and the multi-part message rendering path in `format_response_items_snapshot`.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::strip_capability_instructions_omits_capability_parts_from_developer_messages`  (lines 571–590)

```
fn strip_capability_instructions_omits_capability_parts_from_developer_messages()
```

**Purpose**: Verifies that enabling capability stripping removes Apps/Skills/Plugins instruction parts from developer messages while leaving other parts intact.

**Data flow**: Builds a developer message containing permissions, skills, and plugins text parts, formats it with redacted options plus `.strip_capability_instructions()`, and asserts only the permissions placeholder remains in the output.

**Call relations**: This test exercises the `strip_capability_instructions` option and `is_capability_instruction_text` filtering inside `format_response_items_snapshot`.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::strip_agents_md_user_context_omits_agents_fragment_from_user_messages`  (lines 593–617)

```
fn strip_agents_md_user_context_omits_agents_fragment_from_user_messages()
```

**Purpose**: Verifies that enabling AGENTS.md stripping removes that fragment from user messages while preserving other user-context content.

**Data flow**: Creates a user message with an AGENTS.md text part and an environment-context text part, formats it with redacted options plus `.strip_agents_md_user_context()`, and asserts the output contains only the normalized environment-context placeholder.

**Call relations**: This test covers the `strip_agents_md_user_context` branch in `format_response_items_snapshot`.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_normalizes_environment_context_with_subagents`  (lines 620–639)

```
fn redacted_text_mode_normalizes_environment_context_with_subagents()
```

**Purpose**: Verifies that environment-context text is canonicalized with both cwd redaction and subagent counting.

**Data flow**: Builds a user message containing an `<environment_context>` block with a cwd and two `- ` subagent lines, formats it in default redacted mode, and asserts the output is `<ENVIRONMENT_CONTEXT:cwd=<CWD>:subagents=2>`.

**Call relations**: This test targets the environment-context parsing logic inside `canonicalize_snapshot_text`.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::kind_with_text_prefix_mode_normalizes_crlf_line_endings`  (lines 642–662)

```
fn kind_with_text_prefix_mode_normalizes_crlf_line_endings()
```

**Purpose**: Verifies that prefix mode normalizes line endings and truncates long text to the configured prefix length.

**Data flow**: Creates a developer message with CRLF-containing text, formats it with `KindWithTextPrefix { max_chars: 64 }`, and asserts the output contains normalized `\n` escapes and an ellipsis after the prefix.

**Call relations**: This test exercises the prefix branch of `format_snapshot_text` through the main item formatter.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::image_only_message_is_rendered_as_non_text_span`  (lines 665–678)

```
fn image_only_message_is_rendered_as_non_text_span()
```

**Purpose**: Verifies that a message containing only non-text image content is rendered as a typed span with its extra key names.

**Data flow**: Builds a user message whose content contains one `input_image` object with `image_url`, formats it with default options, and asserts the output is `00:message/user:<input_image:image_url>`.

**Call relations**: This test covers the non-text content-item rendering path in `format_response_items_snapshot`.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::mixed_text_and_image_message_keeps_image_span`  (lines 681–707)

```
fn mixed_text_and_image_message_keeps_image_span()
```

**Purpose**: Verifies that mixed text and image content is preserved as a multi-part message with the image represented as a non-text span between text parts.

**Data flow**: Creates a three-part user message containing text `<image>`, an `input_image` object, and text `</image>`, formats it with default options, and asserts the output is a three-line multi-part rendering with the image shown as `<input_image:image_url>`.

**Call relations**: This test exercises both text and non-text content handling plus the multi-part message formatting branch.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_normalizes_system_skill_temp_paths`  (lines 710–726)

```
fn redacted_text_mode_normalizes_system_skill_temp_paths()
```

**Purpose**: Verifies that environment-specific temporary system-skill file paths are rewritten to the stable `<SYSTEM_SKILLS_ROOT>` placeholder.

**Data flow**: Builds a developer message containing a concrete temp path ending in `/skills/.system/openai-docs/SKILL.md`, formats it with default options, and asserts the path is normalized in the rendered output.

**Call relations**: This test specifically validates `normalize_dynamic_snapshot_paths` as reached through `canonicalize_snapshot_text` and `format_snapshot_text`.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_normalizes_turn_metadata_dynamic_json_strings`  (lines 729–739)

```
fn redacted_text_mode_normalizes_turn_metadata_dynamic_json_strings()
```

**Purpose**: Verifies that JSON-like strings containing dynamic turn metadata are redacted to stable placeholders.

**Data flow**: Calls `format_snapshot_json_string` directly on a JSON string containing a UUID turn ID, sandbox name, and numeric `turn_started_at_unix_ms`, using default options, and asserts the returned string replaces them with `<UUID>`, `<SANDBOX>`, and `<UNIX_MS>`.

**Call relations**: This test directly targets `normalize_snapshot_dynamic_values` through `format_snapshot_json_string`, rather than going through item or request-body formatting.

*Call graph*: calls 2 internal fn (default, format_snapshot_json_string); 1 external calls (assert_eq!).


### `core/tests/common/responses.rs`

`io_transport` · `test request/response simulation`

This file is the main transport-level test toolkit for remote model interactions. It defines `ResponseMock`, which captures `wiremock::Request` values for `/responses` POSTs inside `Arc<Mutex<Vec<ResponsesRequest>>>`, and `ResponsesRequest`, a wrapper with rich JSON inspection helpers. Those helpers decode zstd-compressed bodies when `content-encoding` includes `zstd`, parse JSON, extract instructions, input items, message text/image spans, headers, query params, and specific tool-output records. Several methods intentionally panic when expected structure is absent, making malformed requests fail tests immediately.

The file also provides a large catalog of event constructors for SSE-based Responses API simulations: response lifecycle events, assistant messages, reasoning items and deltas, web search calls, image generation calls, function/custom/local-shell/tool-search calls, and convenience wrappers for shell-command and apply-patch shapes. `sse` serializes these JSON events into `text/event-stream` bodies, omitting `data:` lines for events that contain only a `type` field.

For HTTP mocking, helper builders mount one-shot or sequential responders for `/responses`, `/responses/compact`, and `/models`, including a compaction responder that preserves only user/developer messages and appends a synthetic compaction item. `start_mock_server` always pre-mounts an empty `/models` response to keep tests hermetic.

For websocket coverage, `WebSocketTestServer` spins up a real `TcpListener`, records handshake metadata and per-connection JSON requests, optionally delays handshake acceptance, streams scripted event batches per incoming request, and can either close normally or stay open to simulate incomplete close handshakes. Finally, every captured `/responses` POST is validated by `validate_request_body_invariants`, which enforces symmetry between tool-call items and their corresponding output items and rejects orphan or empty `call_id` outputs except for legacy server-executed tool-search outputs.

#### Function details

##### `ResponseMock::new`  (lines 44–48)

```
fn new() -> Self
```

**Purpose**: Creates an empty request-capturing mock for `/responses` endpoints.

**Data flow**: It allocates a new `Vec<ResponsesRequest>` inside `Arc<Mutex<_>>` and returns a `ResponseMock` holding that shared state.

**Call relations**: This constructor is used by `base_mock` and `compact_mock` when building wiremock matchers that both capture requests and validate them.

*Call graph*: called by 2 (base_mock, compact_mock); 3 external calls (new, new, new).


##### `ResponseMock::single_request`  (lines 50–56)

```
fn single_request(&self) -> ResponsesRequest
```

**Purpose**: Returns the only captured request, panicking unless exactly one request was recorded.

**Data flow**: It locks the internal request vector, checks `len() == 1`, clones the first `ResponsesRequest`, and returns it. It panics with the observed count otherwise.

**Call relations**: Tests use this when they expect a single `/responses` call and want a concise assertion failure if extra or missing calls occurred.

*Call graph*: called by 1 (command_result); 1 external calls (panic!).


##### `ResponseMock::requests`  (lines 58–60)

```
fn requests(&self) -> Vec<ResponsesRequest>
```

**Purpose**: Returns a cloned snapshot of all captured `/responses` requests.

**Data flow**: It locks the internal mutex, clones the `Vec<ResponsesRequest>`, and returns it.

**Call relations**: Many higher-level test assertions build on this method to inspect request history, count calls, or search for specific tool-call patterns.

*Call graph*: called by 7 (wait_for_request_count, function_call_output_text, saw_function_call, capture_from_requests, wait_for_matching_request, wait_for_requests, wait_for_request).


##### `ResponseMock::last_request`  (lines 62–64)

```
fn last_request(&self) -> Option<ResponsesRequest>
```

**Purpose**: Returns the most recently captured request if any exist.

**Data flow**: It locks the internal request vector, clones the last element if present, and returns `Option<ResponsesRequest>`.

**Call relations**: This is a convenience accessor for tests that only care about the latest outbound request.


##### `ResponseMock::saw_function_call`  (lines 68–72)

```
fn saw_function_call(&self, call_id: &str) -> bool
```

**Purpose**: Checks whether any captured request contains a `function_call` input item with the specified `call_id`.

**Data flow**: It takes `call_id`, clones all requests via `requests()`, scans them with `ResponsesRequest::has_function_call`, and returns a boolean.

**Call relations**: Tests use this across multi-request flows to verify that a particular function call was ever emitted, regardless of which turn request contained it.

*Call graph*: calls 1 internal fn (requests).


##### `ResponseMock::function_call_output_text`  (lines 76–80)

```
fn function_call_output_text(&self, call_id: &str) -> Option<String>
```

**Purpose**: Finds the first matching `function_call_output` text across all captured requests for a given `call_id`.

**Data flow**: It takes `call_id`, clones all requests via `requests()`, calls `ResponsesRequest::function_call_output_text` on each, and returns the first non-`None` `String`.

**Call relations**: This helper lets tests inspect tool output across retries or follow-up requests without manually iterating request history.

*Call graph*: calls 1 internal fn (requests).


##### `is_zstd_encoding`  (lines 86–90)

```
fn is_zstd_encoding(value: &str) -> bool
```

**Purpose**: Determines whether a `content-encoding` header value includes `zstd` among possibly comma-separated encodings.

**Data flow**: It takes a header string, splits on commas, trims each entry, compares case-insensitively to `zstd`, and returns `true` if any entry matches.

**Call relations**: This helper is used by `decode_body_bytes` to decide whether request bodies need decompression before JSON parsing.


##### `decode_body_bytes`  (lines 92–99)

```
fn decode_body_bytes(body: &[u8], content_encoding: Option<&str>) -> Vec<u8>
```

**Purpose**: Returns decoded request-body bytes, transparently decompressing zstd-encoded payloads when indicated by headers.

**Data flow**: It takes raw body bytes and an optional content-encoding string. If the encoding contains `zstd`, it decodes the bytes with `zstd::stream::decode_all`; otherwise it clones the original bytes into a `Vec<u8>`.

**Call relations**: Both request-inspection helpers and invariant validation call this so compressed and uncompressed requests are treated uniformly.

*Call graph*: calls 1 internal fn (new); called by 2 (body_json, validate_request_body_invariants); 1 external calls (decode_all).


##### `ResponsesRequest::body_json`  (lines 102–111)

```
fn body_json(&self) -> Value
```

**Purpose**: Parses the captured request body as JSON, decoding zstd compression first when necessary.

**Data flow**: It reads `self.0.body` and the optional `content-encoding` header from `self.0.headers`, decodes bytes via `decode_body_bytes`, parses them with `serde_json::from_slice`, and returns a `serde_json::Value`, panicking on invalid JSON.

**Call relations**: Most higher-level request-inspection methods delegate to this method as their starting point.

*Call graph*: calls 1 internal fn (decode_body_bytes); called by 9 (format_request_body_snapshot, body_contains_text, input, instructions_text, tool_by_name, assert_request_contains_custom_realtime_start, assert_request_contains_realtime_end, assert_request_contains_realtime_start, tool_names); 1 external calls (from_slice).


##### `ResponsesRequest::body_bytes`  (lines 113–115)

```
fn body_bytes(&self) -> Vec<u8>
```

**Purpose**: Returns the raw captured request body bytes without decoding or parsing.

**Data flow**: It clones `self.0.body` and returns the resulting `Vec<u8>`.

**Call relations**: Tests use this when they need exact byte-level assertions rather than JSON inspection.


##### `ResponsesRequest::body_contains_text`  (lines 117–123)

```
fn body_contains_text(&self, text: &str) -> bool
```

**Purpose**: Checks whether the parsed JSON body contains a given text fragment in JSON-escaped form.

**Data flow**: It serializes the target text with `serde_json::to_string`, strips the surrounding quotes, converts the whole body JSON to a string via `body_json().to_string()`, and returns whether that serialized fragment appears.

**Call relations**: This is a loose containment helper for tests that want to assert presence of text anywhere in the request payload.

*Call graph*: calls 1 internal fn (body_json); 1 external calls (to_string).


##### `ResponsesRequest::tool_by_name`  (lines 125–127)

```
fn tool_by_name(&self, namespace: &str, tool_name: &str) -> Option<Value>
```

**Purpose**: Finds a child tool definition by namespace and tool name inside the request body's `tools` array.

**Data flow**: It parses the body with `body_json`, searches via `namespace_child_tool`, clones the matched `Value`, and returns it as `Option<Value>`.

**Call relations**: Tests use this to inspect tool exposure in outbound requests without manually traversing nested namespace-tool JSON.

*Call graph*: calls 2 internal fn (body_json, namespace_child_tool).


##### `ResponsesRequest::instructions_text`  (lines 129–134)

```
fn instructions_text(&self) -> String
```

**Purpose**: Extracts the top-level `instructions` string from the request body.

**Data flow**: It parses the body JSON, indexes `body_json()["instructions"]`, converts it to `&str`, clones it into `String`, and returns it, panicking if absent or non-string.

**Call relations**: Compaction and instruction-related tests call this to inspect the exact instructions sent to the model.

*Call graph*: calls 1 internal fn (body_json); called by 1 (estimate_compact_payload_tokens).


##### `ResponsesRequest::message_input_texts`  (lines 137–146)

```
fn message_input_texts(&self, role: &str) -> Vec<String>
```

**Purpose**: Collects all `input_text` spans from `message` input items for a specific role.

**Data flow**: It filters `inputs_of_type("message")` by `role`, flattens each message's `content` array, keeps spans whose `type` is `input_text`, extracts their `text` strings, and returns them as `Vec<String>`.

**Call relations**: Many tests use this to inspect user, developer, or assistant message text fragments embedded in request history.

*Call graph*: calls 1 internal fn (inputs_of_type); called by 9 (instruction_fragments, message_input_text_contains, instruction_fragments, request_hook_prompt_texts, user_instructions_wrapper_count, permissions_texts, has_subagent_notification, token_budget_texts, phase2_prompt_text).


##### `ResponsesRequest::message_input_text_groups`  (lines 149–162)

```
fn message_input_text_groups(&self, role: &str) -> Vec<Vec<String>>
```

**Purpose**: Returns `input_text` spans grouped per `message` input item for a specific role.

**Data flow**: It filters `inputs_of_type("message")` by role, maps each message's `content` array to a `Vec<String>` of `input_text` span texts, and returns `Vec<Vec<String>>` preserving message grouping.

**Call relations**: This grouped form supports predicates that reason about message boundaries rather than flattened text.

*Call graph*: calls 1 internal fn (inputs_of_type); called by 1 (has_message_with_input_texts).


##### `ResponsesRequest::has_message_with_input_texts`  (lines 164–172)

```
fn has_message_with_input_texts(
        &self,
        role: &str,
        predicate: impl Fn(&[String]) -> bool,
    ) -> bool
```

**Purpose**: Checks whether any message for a given role has a group of input texts satisfying a caller-provided predicate.

**Data flow**: It takes a role and predicate, computes grouped texts with `message_input_text_groups`, applies the predicate to each `&[String]`, and returns whether any group matches.

**Call relations**: Tests use this when they need to assert message-level structure, such as a specific combination of spans in one message.

*Call graph*: calls 1 internal fn (message_input_text_groups).


##### `ResponsesRequest::message_input_image_urls`  (lines 175–188)

```
fn message_input_image_urls(&self, role: &str) -> Vec<String>
```

**Purpose**: Collects all `image_url` values from `input_image` spans inside `message` inputs for a given role.

**Data flow**: It filters `inputs_of_type("message")` by role, flattens `content` arrays, keeps spans with `type == "input_image"`, extracts `image_url` strings, and returns them as `Vec<String>`.

**Call relations**: Image-related tests use this to verify that image inputs were forwarded correctly.

*Call graph*: calls 1 internal fn (inputs_of_type).


##### `ResponsesRequest::input`  (lines 190–195)

```
fn input(&self) -> Vec<Value>
```

**Purpose**: Extracts the request body's top-level `input` array as owned JSON values.

**Data flow**: It parses the body JSON, indexes `body_json()["input"]`, expects an array, clones it, and returns `Vec<Value>`.

**Call relations**: Most item-level inspection helpers build on this method.

*Call graph*: calls 1 internal fn (body_json); called by 6 (format_request_input_snapshot, call_output, function_call_output_text, has_function_call, inputs_of_type, estimate_compact_input_tokens).


##### `ResponsesRequest::inputs_of_type`  (lines 197–203)

```
fn inputs_of_type(&self, ty: &str) -> Vec<Value>
```

**Purpose**: Filters the request `input` array to items whose `type` field matches the requested string.

**Data flow**: It takes a type string, obtains `input()`, filters items by `item.get("type") == Some(ty)`, clones matching items, and returns them.

**Call relations**: Message-text and image helpers use this to isolate message items before deeper traversal.

*Call graph*: calls 1 internal fn (input); called by 3 (message_input_image_urls, message_input_text_groups, message_input_texts).


##### `ResponsesRequest::function_call_output`  (lines 205–207)

```
fn function_call_output(&self, call_id: &str) -> Value
```

**Purpose**: Returns the `function_call_output` item for a specific `call_id`, panicking if absent.

**Data flow**: It takes `call_id`, delegates to `call_output(call_id, "function_call_output")`, and returns the matching `Value`.

**Call relations**: Tests that need the full output item rather than just text use this typed wrapper around `call_output`.

*Call graph*: calls 1 internal fn (call_output); called by 4 (function_tool_output_items, call_output, call_output_content_and_success, call_output).


##### `ResponsesRequest::custom_tool_call_output`  (lines 209–211)

```
fn custom_tool_call_output(&self, call_id: &str) -> Value
```

**Purpose**: Returns the `custom_tool_call_output` item for a specific `call_id`, panicking if absent.

**Data flow**: It takes `call_id`, delegates to `call_output(call_id, "custom_tool_call_output")`, and returns the matching `Value`.

**Call relations**: This is the custom-tool analogue of `function_call_output`.

*Call graph*: calls 1 internal fn (call_output); called by 3 (custom_tool_output_items, custom_tool_output_last_non_empty_text, custom_call_output).


##### `ResponsesRequest::tool_search_output`  (lines 213–215)

```
fn tool_search_output(&self, call_id: &str) -> Value
```

**Purpose**: Returns the `tool_search_output` item for a specific `call_id`, panicking if absent.

**Data flow**: It takes `call_id`, delegates to `call_output(call_id, "tool_search_output")`, and returns the matching `Value`.

**Call relations**: Tool-search tests use this typed wrapper to inspect the exact output item.

*Call graph*: calls 1 internal fn (call_output); called by 1 (tool_search_output_item).


##### `ResponsesRequest::call_output`  (lines 217–225)

```
fn call_output(&self, call_id: &str, call_type: &str) -> Value
```

**Purpose**: Finds and returns a specific output item in the request `input` array by `call_id` and output type.

**Data flow**: It takes `call_id` and `call_type`, scans `input()` for an item whose `type` and `call_id` fields match, clones that item, and returns it, panicking if not found.

**Call relations**: This is the shared implementation behind the typed output-item accessors and content-extraction helpers.

*Call graph*: calls 1 internal fn (input); called by 4 (call_output_content_and_success, custom_tool_call_output, function_call_output, tool_search_output).


##### `ResponsesRequest::has_function_call`  (lines 229–234)

```
fn has_function_call(&self, call_id: &str) -> bool
```

**Purpose**: Checks whether the request `input` contains a `function_call` item with the specified `call_id`.

**Data flow**: It takes `call_id`, scans `input()` for an item with `type == "function_call"` and matching `call_id`, and returns a boolean.

**Call relations**: This method is used by `ResponseMock::saw_function_call` to search across captured requests.

*Call graph*: calls 1 internal fn (input).


##### `ResponsesRequest::function_call_output_text`  (lines 238–247)

```
fn function_call_output_text(&self, call_id: &str) -> Option<String>
```

**Purpose**: Returns the `output` string from a matching `function_call_output` item if present and string-typed.

**Data flow**: It takes `call_id`, scans `input()` for a `function_call_output` item with that ID, then reads `item["output"]` as a string and returns `Option<String>`.

**Call relations**: This is the per-request primitive used by `ResponseMock::function_call_output_text` to search request history.

*Call graph*: calls 1 internal fn (input).


##### `ResponsesRequest::function_call_output_content_and_success`  (lines 249–254)

```
fn function_call_output_content_and_success(
        &self,
        call_id: &str,
    ) -> Option<(Option<String>, Option<bool>)>
```

**Purpose**: Extracts normalized content text and optional success flag from a `function_call_output` item.

**Data flow**: It takes `call_id`, delegates to `call_output_content_and_success(call_id, "function_call_output")`, and returns `Option<(Option<String>, Option<bool>)>`.

**Call relations**: Tests use this when outputs may be encoded either as plain strings, single `input_text` arrays, or structured objects with `content` and `success`.

*Call graph*: calls 1 internal fn (call_output_content_and_success); called by 3 (call_output, call_output_content_and_success, call_output).


##### `ResponsesRequest::custom_tool_call_output_content_and_success`  (lines 256–261)

```
fn custom_tool_call_output_content_and_success(
        &self,
        call_id: &str,
    ) -> Option<(Option<String>, Option<bool>)>
```

**Purpose**: Extracts normalized content text and optional success flag from a `custom_tool_call_output` item.

**Data flow**: It takes `call_id`, delegates to `call_output_content_and_success(call_id, "custom_tool_call_output")`, and returns `Option<(Option<String>, Option<bool>)>`.

**Call relations**: This is the custom-tool analogue of the function-call output normalization helper.

*Call graph*: calls 1 internal fn (call_output_content_and_success); called by 2 (custom_tool_output_body_and_success, custom_call_output).


##### `ResponsesRequest::call_output_content_and_success`  (lines 263–283)

```
fn call_output_content_and_success(
        &self,
        call_id: &str,
        call_type: &str,
    ) -> Option<(Option<String>, Option<bool>)>
```

**Purpose**: Normalizes an output item's `output` field into optional text plus optional success metadata across multiple payload shapes.

**Data flow**: It takes `call_id` and `call_type`, fetches the full item via `call_output`, clones its `output` field or `Null`, and matches on the JSON shape: strings and arrays are converted to text via `output_value_to_text` with no success flag; objects yield `content` and `success`; other shapes return `(None, None)`.

**Call relations**: This shared implementation backs both typed `*_content_and_success` methods.

*Call graph*: calls 2 internal fn (call_output, output_value_to_text); called by 2 (custom_tool_call_output_content_and_success, function_call_output_content_and_success).


##### `ResponsesRequest::header`  (lines 285–291)

```
fn header(&self, name: &str) -> Option<String>
```

**Purpose**: Returns a request header value as a string if present and valid UTF-8.

**Data flow**: It takes a header name, looks it up in `self.0.headers`, converts it with `to_str()`, clones it into `String`, and returns `Option<String>`.

**Call relations**: Tests use this for assertions on custom headers attached to outbound requests.

*Call graph*: called by 1 (window_id_parts).


##### `ResponsesRequest::path`  (lines 293–295)

```
fn path(&self) -> String
```

**Purpose**: Returns the request URL path component.

**Data flow**: It reads `self.0.url.path()`, converts it to `String`, and returns it.

**Call relations**: This is a simple accessor for route-level assertions.


##### `ResponsesRequest::query_param`  (lines 297–303)

```
fn query_param(&self, name: &str) -> Option<String>
```

**Purpose**: Looks up a named query parameter from the request URL.

**Data flow**: It iterates `self.0.url.query_pairs()`, finds the first pair whose key matches `name`, converts the value to `String`, and returns `Option<String>`.

**Call relations**: Tests use this to inspect query-string options on outbound requests.


##### `output_value_to_text`  (lines 306–317)

```
fn output_value_to_text(value: &Value) -> Option<String>
```

**Purpose**: Converts supported output JSON shapes into plain text, accepting either a string or a single `input_text` content item.

**Data flow**: It takes a `&Value` and returns `Some(String)` for `Value::String` or for a one-element array whose sole item has `type == "input_text"` and a `text` field. Arrays of other sizes or shapes and all non-string/object scalar types return `None`.

**Call relations**: This normalization helper is used by output-content extraction code in both this file and the higher-level `test_codex` harness.

*Call graph*: called by 2 (call_output_content_and_success, custom_tool_call_output_text).


##### `namespace_child_tool`  (lines 319–342)

```
fn namespace_child_tool(
    body: &'a Value,
    namespace: &str,
    tool_name: &str,
) -> Option<&'a Value>
```

**Purpose**: Finds a named child tool inside a namespace tool definition in a request body.

**Data flow**: It takes a body `Value`, namespace name, and child tool name; reads `body["tools"]` as an array; finds a tool with matching `name` and `type == "namespace"`; then searches its nested `tools` array for a child with the requested name and returns `Option<&Value>`.

**Call relations**: This is the traversal primitive used by `ResponsesRequest::tool_by_name` and by tests that inspect namespace-tool exposure directly.

*Call graph*: called by 6 (tool_by_name, tool_search_indexes_only_enabled_non_app_mcp_tools, tool_search_output_has_namespace_child, tool_search_returns_deferred_v1_multi_agent_tools, spawn_agent_description, spawn_agent_tool_description_mentions_role_locked_settings); 1 external calls (get).


##### `tests::request_with_input`  (lines 351–361)

```
fn request_with_input(input: Value) -> ResponsesRequest
```

**Purpose**: Builds a synthetic `ResponsesRequest` containing a supplied `input` JSON array for unit tests of request-inspection helpers.

**Data flow**: It takes a JSON `Value` for `input`, constructs a `wiremock::Request` with a fixed `/v1/responses` URL, POST method, empty headers, and a serialized body `{ "input": input }`, then wraps it in `ResponsesRequest`.

**Call relations**: This helper is only used by the local unit tests in this file.

*Call graph*: 3 external calls (new, json!, to_vec).


##### `tests::call_output_content_and_success_returns_only_single_text_content_item`  (lines 364–409)

```
fn call_output_content_and_success_returns_only_single_text_content_item()
```

**Purpose**: Verifies that output normalization returns text only for supported single-text-item shapes and not for mixed or non-text arrays.

**Data flow**: It constructs synthetic requests with `request_with_input`, calls the typed content-and-success helpers, and asserts the returned tuples match expected `Some`/`None` combinations.

**Call relations**: This unit test exercises `ResponsesRequest::call_output_content_and_success` behavior for both function and custom tool outputs.

*Call graph*: 3 external calls (assert_eq!, request_with_input, json!).


##### `WebSocketRequest::body_json`  (lines 418–420)

```
fn body_json(&self) -> Value
```

**Purpose**: Returns the recorded websocket request payload as owned JSON.

**Data flow**: It clones the stored `body: Value` and returns it.

**Call relations**: Tests use this accessor after `WebSocketTestServer` records inbound websocket messages.

*Call graph*: called by 2 (websocket_request_instructions, websocket_request_text); 1 external calls (clone).


##### `WebSocketHandshake::uri`  (lines 430–432)

```
fn uri(&self) -> &str
```

**Purpose**: Returns the URI observed during a websocket handshake.

**Data flow**: It returns `&self.uri`.

**Call relations**: Handshake assertions use this to inspect the requested websocket path and query.


##### `WebSocketHandshake::header`  (lines 434–439)

```
fn header(&self, name: &str) -> Option<String>
```

**Purpose**: Looks up a handshake header value case-insensitively.

**Data flow**: It scans the stored `(String, String)` header pairs, compares names with `eq_ignore_ascii_case`, clones the matching value, and returns `Option<String>`.

**Call relations**: Tests use this to verify websocket handshake headers such as auth or attestation metadata.


##### `WebSocketTestServer::uri`  (lines 468–470)

```
fn uri(&self) -> &str
```

**Purpose**: Returns the websocket server base URI.

**Data flow**: It returns `&self.uri`.

**Call relations**: Harness builders call this to point Codex at the test websocket server.

*Call graph*: called by 1 (remote_realtime_test_codex_builder).


##### `WebSocketTestServer::connections`  (lines 472–474)

```
fn connections(&self) -> Vec<Vec<WebSocketRequest>>
```

**Purpose**: Returns a cloned log of all recorded websocket requests grouped by connection.

**Data flow**: It locks `self.connections`, clones the nested `Vec<Vec<WebSocketRequest>>`, and returns it.

**Call relations**: Tests use this for bulk inspection of websocket traffic after a scenario completes.

*Call graph*: called by 1 (wait_for_matching_websocket_request).


##### `WebSocketTestServer::single_connection`  (lines 476–482)

```
fn single_connection(&self) -> Vec<WebSocketRequest>
```

**Purpose**: Returns the only recorded websocket connection log, panicking unless exactly one connection was observed.

**Data flow**: It locks `self.connections`, checks the length, clones the first connection log or returns an empty default if absent, and panics on any count other than one.

**Call relations**: This is a convenience assertion helper for single-connection websocket tests.

*Call graph*: 1 external calls (panic!).


##### `WebSocketTestServer::wait_for_request`  (lines 484–502)

```
async fn wait_for_request(
        &self,
        connection_index: usize,
        request_index: usize,
    ) -> WebSocketRequest
```

**Purpose**: Asynchronously waits until a specific request index exists within a specific connection log and returns that recorded request.

**Data flow**: It takes `connection_index` and `request_index`, repeatedly locks `self.connections` to look up the requested entry, returns a clone when found, and otherwise awaits `self.request_log_updated.notified()` before retrying.

**Call relations**: Tests that need to synchronize on background websocket traffic use this instead of polling manually.

*Call graph*: called by 2 (sideband_outbound_request, wait_for_websocket_request).


##### `WebSocketTestServer::handshakes`  (lines 504–506)

```
fn handshakes(&self) -> Vec<WebSocketHandshake>
```

**Purpose**: Returns a cloned log of all observed websocket handshakes.

**Data flow**: It locks `self.handshakes`, clones the `Vec<WebSocketHandshake>`, and returns it.

**Call relations**: This accessor supports assertions on handshake count and metadata.


##### `WebSocketTestServer::wait_for_handshakes`  (lines 512–530)

```
async fn wait_for_handshakes(&self, expected: usize, timeout: Duration) -> bool
```

**Purpose**: Polls until at least a target number of websocket handshakes have been recorded or a timeout expires.

**Data flow**: It takes an expected count and timeout, checks the current handshake count, then loops sleeping in 10 ms increments until either the count threshold is reached or the deadline passes, returning `true` on success and `false` on timeout.

**Call relations**: Tests use this to deterministically wait for background websocket connection attempts without busy-spinning.

*Call graph*: 4 external calls (from_millis, min, now, sleep).


##### `WebSocketTestServer::single_handshake`  (lines 531–537)

```
fn single_handshake(&self) -> WebSocketHandshake
```

**Purpose**: Returns the only recorded websocket handshake, panicking unless exactly one handshake was observed.

**Data flow**: It locks `self.handshakes`, checks the length, clones the first handshake, and panics if the count is not one.

**Call relations**: This is the handshake analogue of `single_connection` for simple one-connection tests.

*Call graph*: 1 external calls (panic!).


##### `WebSocketTestServer::shutdown`  (lines 539–549)

```
async fn shutdown(self)
```

**Purpose**: Signals the websocket server task to stop and waits for it to finish, aborting if it does not exit within ten seconds.

**Data flow**: It consumes `self`, sends on the `shutdown` oneshot, then awaits the server task under a ten-second timeout. On timeout it aborts the task and awaits its termination.

**Call relations**: Tests call this during teardown to ensure the background websocket server does not outlive the scenario.

*Call graph*: called by 1 (shutdown); 3 external calls (from_secs, send, timeout).


##### `ModelsMock::new`  (lines 558–562)

```
fn new() -> Self
```

**Purpose**: Creates an empty request-capturing mock for `/models` requests.

**Data flow**: It allocates a new `Vec<wiremock::Request>` inside `Arc<Mutex<_>>` and returns a `ModelsMock`.

**Call relations**: This constructor is used by `models_mock` when mounting `/models` responders.

*Call graph*: called by 1 (models_mock); 3 external calls (new, new, new).


##### `ModelsMock::requests`  (lines 564–566)

```
fn requests(&self) -> Vec<wiremock::Request>
```

**Purpose**: Returns a cloned snapshot of all captured `/models` requests.

**Data flow**: It locks the internal mutex, clones the request vector, and returns it.

**Call relations**: Tests use this to inspect model-catalog fetch behavior.


##### `ModelsMock::single_request_path`  (lines 568–574)

```
fn single_request_path(&self) -> String
```

**Purpose**: Returns the path of the only captured `/models` request, panicking unless exactly one request was recorded.

**Data flow**: It locks the request vector, checks that its length is one, reads the first request's URL path, converts it to `String`, and returns it.

**Call relations**: This is a convenience assertion helper for tests expecting a single models fetch.

*Call graph*: 1 external calls (panic!).


##### `ModelsMock::matches`  (lines 578–581)

```
fn matches(&self, request: &wiremock::Request) -> bool
```

**Purpose**: Implements `wiremock::Match` by recording every incoming `/models` request and always matching it.

**Data flow**: It takes a `&wiremock::Request`, clones it into the internal request log, and returns `true`.

**Call relations**: Wiremock invokes this matcher during request handling so mounted `/models` mocks both capture and accept requests.

*Call graph*: 1 external calls (clone).


##### `ResponseMock::matches`  (lines 585–595)

```
fn matches(&self, request: &wiremock::Request) -> bool
```

**Purpose**: Implements `wiremock::Match` by recording every incoming `/responses` request, validating request-body invariants, and always matching it.

**Data flow**: It takes a `&wiremock::Request`, clones and wraps it as `ResponsesRequest` into the internal log, calls `validate_request_body_invariants(request)`, and returns `true`.

**Call relations**: Wiremock invokes this matcher for mounted `/responses` mocks; it is the enforcement point that turns malformed tool-call request bodies into immediate test failures.

*Call graph*: calls 1 internal fn (validate_request_body_invariants); 1 external calls (clone).


##### `sse`  (lines 599–612)

```
fn sse(events: Vec<Value>) -> String
```

**Purpose**: Serializes a sequence of JSON event objects into an SSE stream body.

**Data flow**: It takes `Vec<Value>`, iterates each event, writes `event: <type>` lines, writes `data: <json>` plus a blank line when the event has fields beyond `type`, or just a blank line for type-only events, and returns the accumulated `String`.

**Call relations**: Most mock-response builders use this serializer to turn event constructors into `text/event-stream` payloads.

*Call graph*: called by 455 (create_mock_responses_server_repeating_assistant, create_apply_patch_sse_response, create_exec_command_sse_response, create_final_assistant_message_sse_response, create_request_permissions_sse_response, create_request_user_input_sse_response, create_shell_command_sse_response, external_auth_refreshes_on_unauthorized, review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_forwards_client_metadata_to_responses_request_v2 (+15 more)); 3 external calls (new, write!, writeln!).


##### `sse_completed`  (lines 614–616)

```
fn sse_completed(id: &str) -> String
```

**Purpose**: Builds a minimal SSE stream containing `response.created` followed by `response.completed` for a given response ID.

**Data flow**: It takes an ID, constructs the two event values with `ev_response_created` and `ev_completed`, passes them to `sse`, and returns the stream string.

**Call relations**: Tests use this convenience helper for simple successful-turn responses.

*Call graph*: calls 1 internal fn (sse); called by 12 (default_service_tier_override_is_omitted_from_http_turn, flex_service_tier_is_applied_to_http_turn, null_service_tier_override_is_omitted_from_http_turn_with_catalog_default, unsupported_service_tier_is_omitted_from_http_turn, config_personality_none_sends_no_personality, config_personality_some_sets_instructions_template, default_personality_is_pragmatic_without_config_toml, remote_model_friendly_personality_instructions_with_feature, user_turn_personality_none_does_not_add_update_message, openai_model_header_casing_only_mismatch_does_not_warn (+2 more)); 1 external calls (vec!).


##### `ev_completed`  (lines 619–627)

```
fn ev_completed(id: &str) -> Value
```

**Purpose**: Constructs a `response.completed` event with zeroed usage counters for a given response ID.

**Data flow**: It takes an ID and returns a JSON `Value` containing the event type and nested response usage fields.

**Call relations**: This event constructor is used directly in SSE sequences and by higher-level convenience wrappers.

*Call graph*: called by 3 (plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done, plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed, unified_exec_prunes_exited_sessions_first); 1 external calls (json!).


##### `ev_response_created`  (lines 630–637)

```
fn ev_response_created(id: &str) -> Value
```

**Purpose**: Constructs a `response.created` event for a given response ID.

**Data flow**: It takes an ID and returns the corresponding JSON `Value`.

**Call relations**: This is commonly paired with completion or tool-call events in SSE streams.

*Call graph*: 1 external calls (json!).


##### `ev_model_verification_metadata`  (lines 639–648)

```
fn ev_model_verification_metadata(id: &str, verifications: Vec<&str>) -> Value
```

**Purpose**: Constructs a `response.metadata` event carrying model-verification recommendation strings.

**Data flow**: It takes a response ID and a vector of verification strings, embeds them under `metadata.openai_verification_recommendation`, and returns the JSON event.

**Call relations**: Tests use this to simulate verification metadata emitted by the remote service.

*Call graph*: 1 external calls (json!).


##### `ev_completed_with_tokens`  (lines 650–664)

```
fn ev_completed_with_tokens(id: &str, total_tokens: i64) -> Value
```

**Purpose**: Constructs a `response.completed` event whose usage totals are set to a caller-specified token count.

**Data flow**: It takes an ID and `total_tokens`, fills both `input_tokens` and `total_tokens` with that value, and returns the JSON event.

**Call relations**: Token-budget and compaction tests use this to simulate responses with nonzero usage.

*Call graph*: 1 external calls (json!).


##### `ev_assistant_message`  (lines 667–677)

```
fn ev_assistant_message(id: &str, text: &str) -> Value
```

**Purpose**: Constructs a completed assistant message output item containing one `output_text` span.

**Data flow**: It takes an item ID and text, embeds them in a `response.output_item.done` event with `type: message` and `role: assistant`, and returns the JSON value.

**Call relations**: This is a common building block for successful assistant-output SSE streams.

*Call graph*: called by 2 (plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done, plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed); 1 external calls (json!).


##### `user_message_item`  (lines 679–689)

```
fn user_message_item(text: &str) -> ResponseItem
```

**Purpose**: Builds a `codex_protocol::models::ResponseItem::Message` representing a user input text item.

**Data flow**: It takes text, constructs a `ResponseItem::Message` with `role = "user"`, one `ContentItem::InputText`, and `None` for optional metadata fields, and returns it.

**Call relations**: Tests use this typed helper when constructing protocol-model values rather than raw JSON.

*Call graph*: 1 external calls (vec!).


##### `ev_message_item_added`  (lines 691–701)

```
fn ev_message_item_added(id: &str, text: &str) -> Value
```

**Purpose**: Constructs an incremental `response.output_item.added` assistant message event.

**Data flow**: It takes an item ID and text and returns the corresponding JSON event with one `output_text` content span.

**Call relations**: Streaming tests use this to simulate partial item addition before later deltas or completion.

*Call graph*: 1 external calls (json!).


##### `ev_output_text_delta`  (lines 703–708)

```
fn ev_output_text_delta(delta: &str) -> Value
```

**Purpose**: Constructs a `response.output_text.delta` event carrying a text fragment.

**Data flow**: It takes a delta string and returns the JSON event.

**Call relations**: Streaming text tests combine this with added/done events to simulate incremental output.

*Call graph*: called by 2 (plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done, plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed); 1 external calls (json!).


##### `ev_reasoning_item`  (lines 710–740)

```
fn ev_reasoning_item(id: &str, summary: &[&str], raw_content: &[&str]) -> Value
```

**Purpose**: Constructs a completed reasoning output item with summary entries, encrypted content, and optional raw reasoning content entries.

**Data flow**: It takes an item ID, summary strings, and raw-content strings; converts summaries into `summary_text` entries; concatenates raw content, prefixes 550 `b` characters as overhead, base64-encodes the result into `encrypted_content`, optionally adds explicit `reasoning_text` content entries when raw content is non-empty, and returns the JSON event.

**Call relations**: Reasoning-related tests use this to simulate the richer reasoning item shape emitted by the Responses API.

*Call graph*: called by 2 (multiple_auto_compact_per_task_runs_after_token_limit_hit, reasoning_item_is_emitted); 2 external calls (Array, json!).


##### `ev_reasoning_item_added`  (lines 742–756)

```
fn ev_reasoning_item_added(id: &str, summary: &[&str]) -> Value
```

**Purpose**: Constructs an incremental reasoning item-added event containing summary entries only.

**Data flow**: It takes an item ID and summary strings, maps them to `summary_text` entries, and returns a `response.output_item.added` JSON event.

**Call relations**: Streaming reasoning tests use this before summary or content deltas.

*Call graph*: 1 external calls (json!).


##### `ev_reasoning_summary_text_delta`  (lines 758–764)

```
fn ev_reasoning_summary_text_delta(delta: &str) -> Value
```

**Purpose**: Constructs a reasoning-summary delta event for summary index 0.

**Data flow**: It takes a delta string and returns the JSON event with `summary_index: 0`.

**Call relations**: This helper supports incremental reasoning-summary streaming scenarios.

*Call graph*: 1 external calls (json!).


##### `ev_reasoning_text_delta`  (lines 766–772)

```
fn ev_reasoning_text_delta(delta: &str) -> Value
```

**Purpose**: Constructs a reasoning-content delta event for content index 0.

**Data flow**: It takes a delta string and returns the JSON event with `content_index: 0`.

**Call relations**: This helper supports incremental raw reasoning-content streaming scenarios.

*Call graph*: 1 external calls (json!).


##### `ev_web_search_call_added_partial`  (lines 774–783)

```
fn ev_web_search_call_added_partial(id: &str, status: &str) -> Value
```

**Purpose**: Constructs an incremental web-search call item with partial status.

**Data flow**: It takes an item ID and status string and returns a `response.output_item.added` JSON event for `type: web_search_call`.

**Call relations**: Web-search tests use this to simulate partial tool-call lifecycle updates.

*Call graph*: called by 1 (web_search_item_is_emitted); 1 external calls (json!).


##### `ev_web_search_call_done`  (lines 785–795)

```
fn ev_web_search_call_done(id: &str, status: &str, query: &str) -> Value
```

**Purpose**: Constructs a completed web-search call item including the search query.

**Data flow**: It takes an item ID, status, and query string and returns a `response.output_item.done` JSON event with an `action` object of type `search`.

**Call relations**: This is the completed counterpart to `ev_web_search_call_added_partial`.

*Call graph*: called by 1 (web_search_item_is_emitted); 1 external calls (json!).


##### `ev_image_generation_call`  (lines 797–813)

```
fn ev_image_generation_call(
    id: &str,
    status: &str,
    revised_prompt: &str,
    result: &str,
) -> Value
```

**Purpose**: Constructs a completed image-generation call item with revised prompt and result payload.

**Data flow**: It takes an item ID, status, revised prompt, and result string and returns the corresponding JSON event.

**Call relations**: Image-generation tests use this to simulate remote tool output.

*Call graph*: 1 external calls (json!).


##### `ev_function_call`  (lines 815–825)

```
fn ev_function_call(call_id: &str, name: &str, arguments: &str) -> Value
```

**Purpose**: Constructs a completed function-call output item with call ID, function name, and serialized arguments.

**Data flow**: It takes `call_id`, `name`, and `arguments` strings and returns a `response.output_item.done` JSON event for `type: function_call`.

**Call relations**: Many higher-level helpers and tests use this as the canonical function-call event constructor.

*Call graph*: called by 18 (ev_apply_patch_shell_command_call_via_heredoc, ev_shell_command_call_with_args, exec_command_event, shell_event_with_prefix_rule, ev_shell_command_call, tool_call, shell_command_call, exec_command_event, exec_command_event_with_missing_additional_permissions, exec_command_event_with_request_permissions (+8 more)); 1 external calls (json!).


##### `ev_function_call_with_namespace`  (lines 827–843)

```
fn ev_function_call_with_namespace(
    call_id: &str,
    namespace: &str,
    name: &str,
    arguments: &str,
) -> Value
```

**Purpose**: Constructs a completed namespaced function-call item.

**Data flow**: It takes `call_id`, namespace, name, and arguments strings and returns the corresponding JSON event including the `namespace` field.

**Call relations**: Tests use this when simulating function calls emitted from namespace tools.

*Call graph*: 1 external calls (json!).


##### `ev_tool_search_call`  (lines 845–855)

```
fn ev_tool_search_call(call_id: &str, arguments: &serde_json::Value) -> Value
```

**Purpose**: Constructs a completed client-executed tool-search call item.

**Data flow**: It takes `call_id` and a JSON arguments value, embeds them with `execution: "client"`, and returns the JSON event.

**Call relations**: Tool-search tests use this to simulate model-emitted search calls.

*Call graph*: 1 external calls (json!).


##### `ev_custom_tool_call`  (lines 857–867)

```
fn ev_custom_tool_call(call_id: &str, name: &str, input: &str) -> Value
```

**Purpose**: Constructs a completed custom-tool call item with textual input.

**Data flow**: It takes `call_id`, tool name, and input string and returns the corresponding JSON event.

**Call relations**: Custom-tool tests use this to simulate direct custom tool invocation.

*Call graph*: 1 external calls (json!).


##### `ev_local_shell_call`  (lines 869–882)

```
fn ev_local_shell_call(call_id: &str, status: &str, command: Vec<&str>) -> Value
```

**Purpose**: Constructs a completed local-shell call item with exec command vector and status.

**Data flow**: It takes `call_id`, status, and command argv as `Vec<&str>`, embeds them under `action.type = "exec"`, and returns the JSON event.

**Call relations**: Shell-execution tests use this to simulate local shell tool calls.

*Call graph*: 1 external calls (json!).


##### `ev_apply_patch_custom_tool_call`  (lines 887–897)

```
fn ev_apply_patch_custom_tool_call(call_id: &str, patch: &str) -> Value
```

**Purpose**: Constructs a custom-tool call event specifically for `apply_patch` with raw patch text as input.

**Data flow**: It takes `call_id` and patch text and returns a `custom_tool_call` JSON event with `name: "apply_patch"`.

**Call relations**: Compatibility tests use this helper to mirror the Responses API shape for direct `apply_patch` invocation.

*Call graph*: called by 1 (prepare); 1 external calls (json!).


##### `ev_shell_command_call`  (lines 899–902)

```
fn ev_shell_command_call(call_id: &str, command: &str) -> Value
```

**Purpose**: Constructs a `shell_command` function-call event from a plain command string.

**Data flow**: It wraps the command in a JSON object `{ "command": command }`, then delegates to `ev_shell_command_call_with_args` and returns the resulting event.

**Call relations**: This is the simple shell-command convenience wrapper used by tests that do not need custom argument objects.

*Call graph*: calls 1 internal fn (ev_shell_command_call_with_args); 1 external calls (json!).


##### `ev_shell_command_call_with_args`  (lines 904–907)

```
fn ev_shell_command_call_with_args(call_id: &str, args: &serde_json::Value) -> Value
```

**Purpose**: Constructs a `shell_command` function-call event from an arbitrary JSON arguments object.

**Data flow**: It serializes the provided JSON args to a string and passes that string to `ev_function_call(call_id, "shell_command", ...)`, returning the resulting event.

**Call relations**: This helper underlies `ev_shell_command_call` and supports tests that need nontrivial shell-command argument payloads.

*Call graph*: calls 1 internal fn (ev_function_call); called by 1 (ev_shell_command_call); 1 external calls (to_string).


##### `ev_apply_patch_shell_command_call_via_heredoc`  (lines 909–914)

```
fn ev_apply_patch_shell_command_call_via_heredoc(call_id: &str, patch: &str) -> Value
```

**Purpose**: Constructs a `shell_command` function-call event whose command runs `apply_patch` via a heredoc.

**Data flow**: It formats a heredoc command string containing the patch text, wraps it in `{ "command": ... }`, serializes that JSON, and returns `ev_function_call(call_id, "shell_command", arguments)`.

**Call relations**: Compatibility tests use this to simulate alternate model output shapes for patch application.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `sse_failed`  (lines 916–924)

```
fn sse_failed(id: &str, code: &str, message: &str) -> String
```

**Purpose**: Builds an SSE stream containing a single `response.failed` event with code and message.

**Data flow**: It takes response ID, error code, and message, constructs the JSON event, passes it to `sse`, and returns the stream string.

**Call relations**: Failure-path tests use this convenience helper to simulate terminal remote errors.

*Call graph*: calls 1 internal fn (sse); called by 5 (thread_read_reports_system_error_idle_flag_after_failed_turn, thread_unsubscribe_preserves_cached_status_before_idle_unload, context_window_error_sets_total_tokens_to_model_window, manual_compact_non_context_failure_retries_then_emits_task_error, manual_compact_retries_after_context_window_error); 1 external calls (vec!).


##### `sse_response`  (lines 926–930)

```
fn sse_response(body: String) -> ResponseTemplate
```

**Purpose**: Wraps a raw SSE body string in a `wiremock::ResponseTemplate` with `text/event-stream` content type.

**Data flow**: It takes a body string, creates `ResponseTemplate::new(200)`, inserts the `content-type` header, sets the raw body, and returns the template.

**Call relations**: Mount helpers use this to turn serialized SSE strings into wiremock responses.

*Call graph*: called by 29 (respond, create_mock_responses_server_repeating_assistant, turn_steer_updates_client_metadata_on_follow_up_responses_request_v2, start_ctrl_c_restart_fixture, respond, model_verification_emits_typed_notification_and_warning_v2, openai_model_header_mismatch_emits_model_rerouted_notification_v2, response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested, turn_moderation_metadata_emits_typed_notification_v2, thread_resume_rejects_history_when_thread_is_running (+15 more)); 1 external calls (new).


##### `mount_response_once`  (lines 932–939)

```
async fn mount_response_once(server: &MockServer, response: ResponseTemplate) -> ResponseMock
```

**Purpose**: Mounts a one-shot `/responses` mock that captures the request and returns a caller-supplied response template.

**Data flow**: It takes a `MockServer` and `ResponseTemplate`, builds `(mock, response_mock)` via `base_mock()`, configures the mock to respond once with the template, mounts it, and returns the `ResponseMock` capture handle.

**Call relations**: Tests use this when they need a single custom HTTP response body rather than an SSE convenience wrapper.

*Call graph*: calls 1 internal fn (base_mock); called by 16 (cyber_policy_response_emits_typed_error_notification_v2, model_verification_emits_typed_notification_and_warning_v2, openai_model_header_mismatch_emits_model_rerouted_notification_v2, response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested, turn_moderation_metadata_emits_typed_notification_v2, thread_resume_rejects_history_when_thread_is_running, thread_resume_rejects_mismatched_path_for_running_thread_id, request_permissions_guardian_review_stops_when_cancelled, renews_cache_ttl_on_matching_models_etag, refresh_models_on_models_etag_mismatch_and_avoid_duplicate_models_fetch (+6 more)).


##### `mount_response_once_match`  (lines 941–956)

```
async fn mount_response_once_match(
    server: &MockServer,
    matcher: M,
    response: ResponseTemplate,
) -> ResponseMock
```

**Purpose**: Mounts a one-shot `/responses` mock gated by an additional matcher and returning a caller-supplied response template.

**Data flow**: It takes a server, extra matcher, and response template, starts from `base_mock()`, chains `.and(matcher)`, mounts the one-shot responder, and returns the `ResponseMock` capture handle.

**Call relations**: This variant is used when tests need to constrain the mock to requests matching extra predicates.

*Call graph*: calls 1 internal fn (base_mock); called by 3 (plaintext_multi_agent_v2_completion_sends_agent_message, setup_turn_one_with_custom_spawned_child, replaces_invalid_local_image_after_bad_request).


##### `base_mock`  (lines 958–964)

```
fn base_mock() -> (MockBuilder, ResponseMock)
```

**Purpose**: Builds the standard wiremock matcher chain for POST requests to `/responses` plus a fresh `ResponseMock` capture handle.

**Data flow**: It creates a new `ResponseMock`, constructs `Mock::given(method("POST")).and(path_regex(".*/responses$")).and(response_mock.clone())`, and returns `(MockBuilder, ResponseMock)`.

**Call relations**: All `/responses` mount helpers start from this shared builder so they consistently capture requests and enforce invariants.

*Call graph*: calls 1 internal fn (new); called by 6 (mount_response_once, mount_response_once_match, mount_response_sequence, mount_sse_once, mount_sse_once_match, mount_sse_sequence); 3 external calls (given, method, path_regex).


##### `compact_mock`  (lines 966–972)

```
fn compact_mock() -> (MockBuilder, ResponseMock)
```

**Purpose**: Builds the standard wiremock matcher chain for POST requests to `/responses/compact` plus a fresh `ResponseMock` capture handle.

**Data flow**: It creates a new `ResponseMock`, constructs a `MockBuilder` matching POST and path regex `.*/responses/compact$`, attaches the capture matcher, and returns both.

**Call relations**: All compact-response mount helpers use this shared builder.

*Call graph*: calls 1 internal fn (new); called by 3 (mount_compact_json_once_match, mount_compact_response_once, mount_compact_user_history_with_summary_sequence); 3 external calls (given, method, path_regex).


##### `models_mock`  (lines 974–980)

```
fn models_mock() -> (MockBuilder, ModelsMock)
```

**Purpose**: Builds the standard wiremock matcher chain for GET requests to `/models` plus a fresh `ModelsMock` capture handle.

**Data flow**: It creates a new `ModelsMock`, constructs `Mock::given(method("GET")).and(path_regex(".*/models$")).and(models_mock.clone())`, and returns both.

**Call relations**: All `/models` mount helpers use this shared builder.

*Call graph*: calls 1 internal fn (new); called by 3 (mount_models_once, mount_models_once_with_delay, mount_models_once_with_etag); 3 external calls (given, method, path_regex).


##### `mount_sse_once_match`  (lines 982–993)

```
async fn mount_sse_once_match(server: &MockServer, matcher: M, body: String) -> ResponseMock
```

**Purpose**: Mounts a one-shot `/responses` mock gated by an extra matcher and serving an SSE body string.

**Data flow**: It takes a server, matcher, and SSE body string, builds `(mock, response_mock)` via `base_mock()`, wraps the body with `sse_response`, mounts the responder once, and returns the capture handle.

**Call relations**: This is the matcher-aware SSE convenience helper used by many integration tests.

*Call graph*: calls 2 internal fn (base_mock, sse_response); called by 27 (direct_input_to_multi_agent_v2_subagent_is_rejected, turn_start_emits_spawn_agent_item_with_effective_role_model_metadata_v2, turn_start_emits_spawn_agent_item_with_model_metadata_v2, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, v2_nested_spawn_checks_shared_active_execution_capacity, run_subagent_global_instruction_case, spawned_subagent_execpolicy_amendment_propagates_to_parent_session, context_window_error_sets_total_tokens_to_model_window, provider_auth_command_supplies_bearer_token (+15 more)).


##### `mount_sse_once`  (lines 995–1002)

```
async fn mount_sse_once(server: &MockServer, body: String) -> ResponseMock
```

**Purpose**: Mounts a one-shot `/responses` mock serving an SSE body string.

**Data flow**: It takes a server and body string, builds `(mock, response_mock)` via `base_mock()`, responds with `sse_response(body)`, mounts once, and returns the capture handle.

**Call relations**: This is the most common helper for simple single-turn SSE response mocking.

*Call graph*: calls 2 internal fn (base_mock, sse_response); called by 352 (review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_forwards_client_metadata_to_responses_request_v2, turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2, selected_executor_root_exposes_plugin_skill, standalone_image_generation_is_exposed_in_code_mode_only, local_executor_does_not_expose_orchestrator_skills, turn_start_accepts_output_schema_v2, turn_start_output_schema_is_per_turn_v2, thread_inject_items_adds_raw_response_items_to_thread_history (+15 more)).


##### `mount_compact_json_once_match`  (lines 1004–1023)

```
async fn mount_compact_json_once_match(
    server: &MockServer,
    matcher: M,
    body: serde_json::Value,
) -> ResponseMock
```

**Purpose**: Mounts a one-shot `/responses/compact` mock gated by an extra matcher and returning a JSON body.

**Data flow**: It takes a server, matcher, and JSON body, builds `(mock, response_mock)` via `compact_mock()`, wraps the body in a 200 JSON `ResponseTemplate`, mounts once, and returns the capture handle.

**Call relations**: Compaction tests use this when they need exact control over the compact endpoint response and request matching.

*Call graph*: calls 1 internal fn (compact_mock); 2 external calls (new, clone).


##### `mount_compact_json_once`  (lines 1025–1033)

```
async fn mount_compact_json_once(server: &MockServer, body: serde_json::Value) -> ResponseMock
```

**Purpose**: Mounts a one-shot `/responses/compact` mock returning a JSON body.

**Data flow**: It takes a server and JSON body, wraps it in a JSON `ResponseTemplate`, delegates to `mount_compact_response_once`, and returns the `ResponseMock`.

**Call relations**: This is the simple compact-endpoint helper used by many compaction tests.

*Call graph*: calls 1 internal fn (mount_compact_response_once); called by 19 (auto_compaction_remote_emits_started_and_completed_items, auto_compact_counts_encrypted_reasoning_before_last_user, auto_compact_runs_after_resume_when_token_usage_is_over_limit, auto_compact_runs_when_reasoning_header_clears_between_turns, auto_remote_compact_failure_stops_agent_loop, remote_compact_and_resume_refresh_stale_developer_instructions, remote_compact_filters_deferred_dynamic_tools, remote_compact_persists_replacement_history_in_rollout, remote_compact_refreshes_stale_developer_instructions_without_resume, remote_compact_replaces_history_for_followups (+9 more)); 1 external calls (new).


##### `mount_compact_user_history_with_summary_once`  (lines 1038–1043)

```
async fn mount_compact_user_history_with_summary_once(
    server: &MockServer,
    summary_text: &str,
) -> ResponseMock
```

**Purpose**: Mounts a one-shot compact responder that preserves user/developer history and appends one synthetic compaction summary item.

**Data flow**: It takes a server and summary text, wraps the text in a one-element vector, delegates to `mount_compact_user_history_with_summary_sequence`, and returns the capture handle.

**Call relations**: This is the convenience entry for the more general sequential summary responder.

*Call graph*: calls 1 internal fn (mount_compact_user_history_with_summary_sequence); called by 12 (assert_remote_manual_compact_request_parity, auto_remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_rewrites_multiple_trailing_function_call_outputs, remote_compact_runs_automatically, remote_compact_trim_estimate_uses_session_base_instructions, remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_trims_tool_search_output_to_empty_tools_array, remote_manual_compact_emits_context_compaction_items, snapshot_request_shape_remote_mid_turn_continuation_compaction, snapshot_request_shape_remote_pre_turn_compaction_including_incoming_user_message (+2 more)); 1 external calls (vec!).


##### `mount_compact_user_history_with_summary_sequence`  (lines 1047–1118)

```
async fn mount_compact_user_history_with_summary_sequence(
    server: &MockServer,
    summary_texts: Vec<String>,
) -> ResponseMock
```

**Purpose**: Mounts a sequential compact responder that, for each request, keeps only user/developer messages from the incoming `input` and appends a synthetic compaction item using the next summary text.

**Data flow**: It takes a server and ordered summary texts, builds a custom `Respond` implementation with an atomic call counter, decodes and parses each incoming request body, filters `input` items to `message` items with role `user` or `developer`, appends `{ "type": "compaction", "encrypted_content": summary_text }`, wraps the result as `{ "output": output }`, mounts the responder with an exact expected call count, and returns the `ResponseMock` capture handle.

**Call relations**: Compaction tests use this helper when they want the mock compact endpoint to behave similarly to the current remote service across one or more compact calls.

*Call graph*: calls 1 internal fn (compact_mock); called by 2 (mount_compact_user_history_with_summary_once, snapshot_request_shape_remote_mid_turn_compaction_multi_summary_reinjects_above_last_summary); 1 external calls (new).


##### `mount_compact_response_once`  (lines 1120–1130)

```
async fn mount_compact_response_once(
    server: &MockServer,
    response: ResponseTemplate,
) -> ResponseMock
```

**Purpose**: Mounts a one-shot `/responses/compact` mock returning an arbitrary response template.

**Data flow**: It takes a server and `ResponseTemplate`, builds `(mock, response_mock)` via `compact_mock()`, mounts the responder once, and returns the capture handle.

**Call relations**: This is the low-level compact-endpoint mounting primitive used by JSON convenience wrappers and tests needing custom status or headers.

*Call graph*: calls 1 internal fn (compact_mock); called by 4 (mount_compact_json_once, remote_mid_turn_compact_v1_sends_turn_state_over_http, remote_pre_turn_compact_response_seeds_turn_state, snapshot_request_shape_remote_pre_turn_compaction_context_window_exceeded).


##### `mount_models_once`  (lines 1132–1143)

```
async fn mount_models_once(server: &MockServer, body: ModelsResponse) -> ModelsMock
```

**Purpose**: Mounts a one-shot `/models` mock returning a JSON `ModelsResponse` and capturing the request.

**Data flow**: It takes a server and `ModelsResponse`, builds `(mock, models_mock)` via `models_mock()`, wraps the body in a 200 JSON response, mounts once, and returns the capture handle.

**Call relations**: This helper is used directly by tests and also by `start_mock_server` to install a default empty models response.

*Call graph*: calls 1 internal fn (models_mock); called by 40 (list_models_uses_chatgpt_remote_catalog_as_source_of_truth, new_uses_active_provider_for_model_refresh, start_mock_server, remote_model_override_uses_catalog_model_for_strict_auto_review, body_after_prefix_model_switch_budget_compacts_with_next_model, pre_sampling_compact_recovers_comp_hash_after_resume, pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model, pre_sampling_compact_runs_on_switch_to_smaller_context_model, pre_sampling_compact_runs_when_comp_hash_changes, pre_sampling_compact_skips_missing_comp_hash_after_resume (+15 more)); 2 external calls (new, clone).


##### `mount_models_once_with_delay`  (lines 1145–1161)

```
async fn mount_models_once_with_delay(
    server: &MockServer,
    body: ModelsResponse,
    delay: Duration,
) -> ModelsMock
```

**Purpose**: Mounts a one-shot `/models` mock returning a delayed JSON `ModelsResponse`.

**Data flow**: It takes a server, body, and delay, builds `(mock, models_mock)`, creates a JSON response template with `.set_delay(delay)`, mounts once, and returns the capture handle.

**Call relations**: Timeout-related tests use this to simulate a slow models endpoint.

*Call graph*: calls 1 internal fn (models_mock); called by 1 (remote_models_request_times_out_after_5s); 2 external calls (new, clone).


##### `mount_models_once_with_etag`  (lines 1163–1180)

```
async fn mount_models_once_with_etag(
    server: &MockServer,
    body: ModelsResponse,
    etag: &str,
) -> ModelsMock
```

**Purpose**: Mounts a one-shot `/models` mock returning a JSON `ModelsResponse` plus an `ETag` header.

**Data flow**: It takes a server, body, and etag string, builds `(mock, models_mock)`, creates a JSON response template with `ETag` and content-type headers, mounts once, and returns the capture handle.

**Call relations**: Cache-refresh tests use this to exercise ETag-based models fetching behavior.

*Call graph*: calls 1 internal fn (models_mock); called by 2 (renews_cache_ttl_on_matching_models_etag, refresh_models_on_models_etag_mismatch_and_avoid_duplicate_models_fetch); 2 external calls (new, clone).


##### `start_mock_server`  (lines 1182–1192)

```
async fn start_mock_server() -> MockServer
```

**Purpose**: Starts a wiremock server configured for large body printing and preinstalls a default empty `/models` response.

**Data flow**: It builds and starts a `MockServer` with `BodyPrintLimit::Limited(80_000)`, mounts `mount_models_once(&server, ModelsResponse { models: Vec::new() })`, and returns the server.

**Call relations**: Most higher-level test harnesses call this first so model-catalog requests remain hermetic even if a test only explicitly mounts `/responses` mocks.

*Call graph*: calls 1 internal fn (mount_models_once); called by 623 (create_mock_responses_server_repeating_assistant, create_mock_responses_server_sequence, create_mock_responses_server_sequence_unchecked, review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_forwards_client_metadata_to_responses_request_v2, turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2, turn_steer_updates_client_metadata_on_follow_up_responses_request_v2, auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items (+15 more)); 3 external calls (Limited, builder, new).


##### `start_websocket_server`  (lines 1199–1210)

```
async fn start_websocket_server(connections: Vec<Vec<Vec<Value>>>) -> WebSocketTestServer
```

**Purpose**: Starts a websocket test server from a simplified nested vector of scripted request-response batches using default connection settings.

**Data flow**: It takes `Vec<Vec<Vec<Value>>>`, maps each connection script into a `WebSocketConnectionConfig` with empty response headers, no accept delay, and `close_after_requests = true`, then delegates to `start_websocket_server_with_headers`.

**Call relations**: This is the convenience entry for websocket tests that do not need handshake delays or custom response headers.

*Call graph*: calls 1 internal fn (start_websocket_server_with_headers); called by 81 (turn_start_forwards_client_metadata_to_responses_websocket_request_body_v2, realtime_conversation_requires_feature_flag, realtime_conversation_stop_emits_closed_notification, realtime_conversation_streams_v2_notifications, realtime_start_can_skip_startup_context, realtime_text_output_modality_requests_text_output_and_final_transcript, realtime_webrtc_start_surfaces_backend_error, websocket_first_turn_uses_startup_prewarm_and_create, websocket_test_codex_shell_chain, websocket_v2_first_turn_drops_fast_tier_after_startup_prewarm (+15 more)).


##### `start_websocket_server_with_headers`  (lines 1212–1385)

```
async fn start_websocket_server_with_headers(
    connections: Vec<WebSocketConnectionConfig>,
) -> WebSocketTestServer
```

**Purpose**: Starts a real websocket server that records handshakes and JSON requests, then streams scripted JSON event batches per request for each queued connection configuration.

**Data flow**: It takes a vector of `WebSocketConnectionConfig`, binds a `TcpListener` on `127.0.0.1:0`, constructs shared logs for connections and handshakes plus a `Notify`, stores pending connection scripts in a `VecDeque`, and spawns an accept loop. For each accepted TCP stream with a queued config, it optionally sleeps for `accept_delay`, performs websocket handshake via `accept_hdr_async_with_config` using a callback that records request URI/headers and injects configured response headers, allocates a connection log slot, then for each scripted request batch waits for one inbound websocket message, parses JSON via `parse_ws_request_body`, records it, notifies waiters, and sends each scripted event as a text frame. After all batches it either closes the websocket or waits for shutdown depending on `close_after_requests`. It returns a `WebSocketTestServer` handle containing the URI, logs, shutdown sender, and task handle.

**Call relations**: This is the core websocket transport simulator used by realtime and websocket-specific tests; `start_websocket_server` is just a convenience wrapper around it.

*Call graph*: calls 2 internal fn (parse_ws_request_body, websocket_accept_config); called by 15 (attestation_generate_round_trip_adds_header_to_responses_websocket_handshake, new_with_main_loop_responses_server_and_sandbox, realtime_webrtc_start_emits_sdp_notification, start_websocket_server, websocket_first_turn_handles_handshake_delay_with_startup_prewarm, responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event, responses_websocket_v2_surfaces_terminal_error_without_close_handshake, conversation_webrtc_close_while_sideband_connecting_drops_pending_join, conversation_webrtc_start_posts_generated_session (+5 more)); 17 external calls (clone, new, new, new, bind, new, from, eprintln!, format!, channel (+7 more)).


##### `parse_ws_request_body`  (lines 1387–1393)

```
fn parse_ws_request_body(message: Message) -> Option<Value>
```

**Purpose**: Parses a websocket message into JSON when it is text or binary and ignores other frame types.

**Data flow**: It takes a `tungstenite::Message`, parses text frames with `serde_json::from_str`, binary frames with `serde_json::from_slice`, and returns `Option<Value>`.

**Call relations**: The websocket server uses this to decide which inbound frames should be recorded as request payloads.

*Call graph*: called by 1 (start_websocket_server_with_headers); 2 external calls (from_slice, from_str).


##### `websocket_accept_config`  (lines 1395–1402)

```
fn websocket_accept_config() -> WebSocketConfig
```

**Purpose**: Builds the websocket accept configuration used by the test server, enabling permessage-deflate compression support.

**Data flow**: It creates default `ExtensionsConfig` and `WebSocketConfig`, sets `extensions.permessage_deflate = Some(DeflateConfig::default())`, assigns the extensions into the config, and returns it.

**Call relations**: This configuration is passed into `accept_hdr_async_with_config` by the websocket server startup path.

*Call graph*: called by 1 (start_websocket_server_with_headers); 3 external calls (default, default, default).


##### `mount_function_call_agent_response`  (lines 1410–1433)

```
async fn mount_function_call_agent_response(
    server: &MockServer,
    call_id: &str,
    arguments: &str,
    tool_name: &str,
) -> FunctionCallResponseMocks
```

**Purpose**: Mounts the common two-step SSE sequence for a tool-calling agent: first a function call, then a follow-up assistant completion.

**Data flow**: It takes a server, `call_id`, serialized arguments, and tool name; builds a first SSE body containing `response.created`, the function call event, and `response.completed`; mounts it once; builds a second SSE body containing an assistant message and completion; mounts that once; and returns both `ResponseMock` handles in `FunctionCallResponseMocks`.

**Call relations**: Tests that exercise tool-call round trips use this helper to install the standard pair of remote responses without repeating boilerplate.

*Call graph*: calls 2 internal fn (mount_sse_once, sse); called by 2 (shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox); 1 external calls (vec!).


##### `mount_sse_sequence`  (lines 1438–1475)

```
async fn mount_sse_sequence(server: &MockServer, bodies: Vec<String>) -> ResponseMock
```

**Purpose**: Mounts a `/responses` mock that serves a fixed sequence of SSE bodies in FIFO order and asserts the exact number of calls.

**Data flow**: It takes a server and vector of SSE body strings, builds a custom `Respond` implementation with an atomic call counter, returns the body at the current index or panics if exhausted, mounts it with `.up_to_n_times(num_calls).expect(num_calls)`, and returns the `ResponseMock` capture handle.

**Call relations**: Tests use this when a scenario performs multiple `/responses` calls and each should receive a different SSE stream.

*Call graph*: calls 1 internal fn (base_mock); called by 263 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items, thread_compact_start_triggers_compaction_and_returns_empty_response, selected_executor_plugin_exposes_its_stdio_mcp_only_to_that_thread, external_agent_config_import_compacts_huge_session_before_first_follow_up, run_image_edit_test, standalone_image_generation_failure_emits_terminal_item, standalone_image_generation_is_callable_from_code_mode_only, standalone_image_generation_returns_saved_path_hint_to_model, orchestrator_skill_can_read_referenced_resource_without_an_executor (+15 more)); 1 external calls (new).


##### `mount_response_sequence`  (lines 1479–1514)

```
async fn mount_response_sequence(
    server: &MockServer,
    responses: Vec<ResponseTemplate>,
) -> ResponseMock
```

**Purpose**: Mounts a `/responses` mock that serves a fixed sequence of arbitrary `ResponseTemplate`s in FIFO order and asserts the exact number of calls.

**Data flow**: It takes a server and vector of response templates, builds a custom responder with an atomic call counter, clones and returns the template at the current index, mounts it with an exact expected call count, and returns the `ResponseMock` capture handle.

**Call relations**: This is the non-SSE analogue of `mount_sse_sequence`, used when tests need varying statuses, headers, or body types across calls.

*Call graph*: calls 1 internal fn (base_mock); called by 18 (external_auth_refresh_error_fails_turn, external_auth_refresh_invalid_access_token_fails_turn, external_auth_refresh_mismatched_workspace_fails_turn, external_auth_refreshes_on_unauthorized, turn_steer_updates_client_metadata_on_follow_up_responses_request_v2, thread_resume_rejoins_running_thread_even_with_override_mismatch, thread_settings_update_while_turn_is_active_emits_notification, turn_start_tracks_turn_event_analytics, guardian_review_surfaces_responses_api_errors_in_rejection_reason, responses_stream_includes_turn_metadata_header_for_git_workspace_e2e (+8 more)); 1 external calls (new).


##### `validate_request_body_invariants`  (lines 1526–1643)

```
fn validate_request_body_invariants(request: &wiremock::Request)
```

**Purpose**: Enforces structural invariants on `/responses` request bodies so tests fail immediately on orphaned or asymmetric tool-call and tool-output items.

**Data flow**: It takes a `wiremock::Request`, ignores non-POST or non-`/responses` paths, decodes and parses the body JSON, extracts the `input` array, gathers sets of `call_id`s for `function_call`, `custom_tool_call`, `tool_search_call`, `local_shell_call`, and their corresponding output item types, rejects missing or empty output `call_id`s except for legacy server-executed `tool_search_output`, then asserts that every output has a matching prior call kind and every call has a matching output. It returns nothing and panics on invariant violations.

**Call relations**: This function is invoked from `ResponseMock::matches` on every captured `/responses` request, making it a central guardrail for all HTTP-based response tests.

*Call graph*: calls 1 internal fn (decode_body_bytes); called by 1 (matches); 2 external calls (assert!, from_slice).


### `core/tests/common/streaming_sse.rs`

`io_transport` · `test streaming transport simulation`

This file implements a minimal bespoke HTTP server tailored for streaming tests. `StreamingSseChunk` represents one outbound SSE chunk plus an optional `oneshot::Receiver<()>` gate; if a gate is present, the server waits for it before writing that chunk. `StreamingSseServer` exposes the server URI, a log of raw request bodies, a notifier for request-count waits, and a shutdown handle.

`start_streaming_sse_server` binds a `TcpListener` on localhost, preallocates one completion channel per queued response stream, and stores queued response chunks plus completion senders in a `StreamingSseState` protected by `TokioMutex`. The accept loop spawns one task per connection. Each connection reads only until the HTTP header terminator, parses the request line, then drains the request body according to `Content-Length`. It supports exactly two useful routes: `GET /v1/models`, which returns a tiny empty-models JSON payload, and `POST /v1/responses`, which records the raw body, pops the next queued stream/completion pair in FIFO order, writes SSE headers, then emits each chunk in order, waiting on gates as needed. After the final chunk it sends a completion timestamp in Unix milliseconds and shuts down the socket.

Helper functions keep the implementation explicit: `read_http_request` stops at `\r\n\r\n`, `content_length` parses headers case-insensitively, `read_request_body` drains any remaining bytes, and `write_http_response` emits simple non-streaming responses. The included tests cover malformed requests, FIFO behavior, gated delivery, body draining, and accept-loop shutdown.

#### Function details

##### `StreamingSseServer::uri`  (lines 30–32)

```
fn uri(&self) -> &str
```

**Purpose**: Returns the base HTTP URI of the streaming SSE test server.

**Data flow**: It returns `&self.uri`.

**Call relations**: Harness builders use this URI to point Codex at the custom streaming server.

*Call graph*: called by 1 (build_with_streaming_server).


##### `StreamingSseServer::requests`  (lines 34–36)

```
async fn requests(&self) -> Vec<Vec<u8>>
```

**Purpose**: Returns a cloned snapshot of all raw request bodies received by the server.

**Data flow**: It asynchronously locks `self.requests`, clones the `Vec<Vec<u8>>`, and returns it.

**Call relations**: Tests use this to inspect exactly what bytes were posted to `/v1/responses`.


##### `StreamingSseServer::wait_for_request_count`  (lines 38–45)

```
async fn wait_for_request_count(&self, count: usize)
```

**Purpose**: Waits until at least a specified number of requests have been recorded.

**Data flow**: It takes a target count, repeatedly locks `self.requests` to compare its length, and awaits `self.request_notify.notified()` until the threshold is reached.

**Call relations**: This helper lets tests synchronize on background request emission before releasing gated chunks or making assertions.


##### `StreamingSseServer::shutdown`  (lines 47–50)

```
async fn shutdown(self)
```

**Purpose**: Signals the server accept loop to stop and waits for the background task to finish.

**Data flow**: It consumes `self`, sends on the shutdown oneshot, awaits the server task, and returns nothing.

**Call relations**: Tests call this during teardown to ensure the custom TCP server exits cleanly.

*Call graph*: 1 external calls (send).


##### `start_streaming_sse_server`  (lines 59–173)

```
async fn start_streaming_sse_server(
    responses: Vec<Vec<StreamingSseChunk>>,
) -> (StreamingSseServer, Vec<oneshot::Receiver<i64>>)
```

**Purpose**: Starts the custom HTTP server with a FIFO queue of scripted SSE response streams and returns both the server handle and per-stream completion receivers.

**Data flow**: It takes `Vec<Vec<StreamingSseChunk>>`, binds a `TcpListener`, constructs the base URI, creates one completion oneshot pair per queued response stream, stores queued responses and completion senders in `StreamingSseState`, initializes shared request logging and shutdown state, and spawns an accept loop. Each accepted connection reads and parses the request, serves `/v1/models` or `/v1/responses` as appropriate, records POST bodies, pops the next queued stream via `take_next_stream`, writes headers, emits gated chunks in order, sends a completion timestamp from `unix_ms_now`, and shuts down the socket. It returns `(StreamingSseServer, Vec<oneshot::Receiver<i64>>)`.

**Call relations**: This is the main entrypoint used by streaming tests and by the `TestCodexBuilder` path that targets a streaming server instead of wiremock.

*Call graph*: called by 28 (thread_unsubscribe_during_turn_keeps_turn_running, gated_chunks_wait_for_signal_and_preserve_order, get_models_returns_empty_list, malformed_request_returns_400, multiple_responses_are_fifo_and_completion_timestamps_monotonic, none_gate_streams_immediately, post_responses_streams_in_order_and_closes, post_responses_with_no_queue_returns_500, responses_post_drains_request_body, shutdown_terminates_accept_loop (+15 more)); 12 external calls (clone, new, new, bind, new, new, with_capacity, from, format!, channel (+2 more)).


##### `take_next_stream`  (lines 180–187)

```
async fn take_next_stream(
    state: &TokioMutex<StreamingSseState>,
) -> Option<(Vec<StreamingSseChunk>, oneshot::Sender<i64>)>
```

**Purpose**: Atomically pops the next queued response stream and its matching completion sender from shared server state.

**Data flow**: It locks the `StreamingSseState`, pops the front element from both `responses` and `completions`, and returns them as `Option<(Vec<StreamingSseChunk>, oneshot::Sender<i64>)>`.

**Call relations**: The connection handler in `start_streaming_sse_server` uses this to ensure response streams and completion channels stay in lockstep FIFO order.

*Call graph*: called by 1 (take_next_stream_consumes_in_lockstep); 1 external calls (lock).


##### `read_http_request`  (lines 189–206)

```
async fn read_http_request(stream: &mut tokio::net::TcpStream) -> (String, Vec<u8>)
```

**Purpose**: Reads from a TCP stream until the HTTP header terminator is seen, returning the header text and any already-read body prefix bytes.

**Data flow**: It takes a mutable `TcpStream`, repeatedly reads into a scratch buffer, appends bytes to an accumulator, checks `header_terminator_index`, and once found returns `(header_string, remaining_bytes_after_headers)`. If EOF arrives first, it returns the whole buffer as header text with an empty body prefix.

**Call relations**: The per-connection task uses this first so later logic can parse the request line and then drain the remaining body bytes separately.

*Call graph*: calls 1 internal fn (header_terminator_index); called by 1 (read_http_request_returns_after_header_terminator); 3 external calls (from_utf8_lossy, read, new).


##### `parse_request_line`  (lines 208–214)

```
fn parse_request_line(request: &str) -> Option<(&str, &str)>
```

**Purpose**: Parses the first HTTP request line into `(method, path)`.

**Data flow**: It takes the raw request header string, reads the first line, splits on whitespace, extracts the first two fields, and returns them as `Option<(&str, &str)>`.

**Call relations**: Connection handling uses this to route requests to `/v1/models`, `/v1/responses`, or error responses.


##### `header_terminator_index`  (lines 216–218)

```
fn header_terminator_index(buf: &[u8]) -> Option<usize>
```

**Purpose**: Finds the byte index where `\r\n\r\n` begins in a buffer.

**Data flow**: It scans `buf.windows(4)` for the header terminator sequence and returns `Option<usize>`.

**Call relations**: This helper is used by `read_http_request` to know when it has read a complete HTTP header block.

*Call graph*: called by 1 (read_http_request).


##### `content_length`  (lines 220–231)

```
fn content_length(headers: &str) -> Option<usize>
```

**Purpose**: Parses the `Content-Length` header from an HTTP header block, case-insensitively.

**Data flow**: It iterates header lines after the request line, splits each on the first colon, trims name and value, and returns `Some(usize)` for the first `content-length` header whose value parses successfully.

**Call relations**: `read_request_body` uses this to determine how many bytes remain to be drained from the stream.

*Call graph*: called by 1 (read_request_body).


##### `read_request_body`  (lines 233–255)

```
async fn read_request_body(
    stream: &mut tokio::net::TcpStream,
    headers: &str,
    mut body_prefix: Vec<u8>,
) -> std::io::Result<Vec<u8>>
```

**Purpose**: Reads the remainder of an HTTP request body based on `Content-Length`, combining it with any bytes already read past the header terminator.

**Data flow**: It takes a mutable `TcpStream`, header string, and `body_prefix` bytes. If no content length is present it returns the prefix unchanged; otherwise it truncates any excess prefix bytes, computes the remaining byte count, reads exactly that many bytes, appends them, and returns the full body.

**Call relations**: The connection handler uses this for both `/v1/models` and `/v1/responses` so request bodies are fully drained before responding.

*Call graph*: calls 1 internal fn (content_length); 2 external calls (read_exact, vec!).


##### `write_sse_headers`  (lines 257–260)

```
async fn write_sse_headers(stream: &mut tokio::net::TcpStream) -> std::io::Result<()>
```

**Purpose**: Writes a minimal HTTP 200 response header block for an SSE stream.

**Data flow**: It takes a mutable `TcpStream`, writes a fixed header string containing `content-type: text/event-stream`, `cache-control: no-cache`, and `connection: close`, and returns the I/O result.

**Call relations**: The `/v1/responses` handler calls this before streaming chunk bodies.

*Call graph*: 1 external calls (write_all).


##### `write_http_response`  (lines 262–275)

```
async fn write_http_response(
    stream: &mut tokio::net::TcpStream,
    status: i64,
    body: &str,
    content_type: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a simple non-streaming HTTP response with status, content type, body, and connection close.

**Data flow**: It takes a mutable `TcpStream`, numeric status, body string, and content type, formats the response headers including `content-length`, writes headers and body, then shuts down the stream.

**Call relations**: The server uses this helper for `/v1/models`, 400 bad request, 404 not found, and 500 no-queued-response cases.

*Call graph*: 3 external calls (shutdown, write_all, format!).


##### `unix_ms_now`  (lines 277–282)

```
fn unix_ms_now() -> i64
```

**Purpose**: Returns the current Unix timestamp in milliseconds as `i64`.

**Data flow**: It reads `SystemTime::now()`, computes duration since `UNIX_EPOCH`, falls back to zero duration on error, converts milliseconds to `i64`, and returns it.

**Call relations**: The streaming server sends this timestamp through completion channels after finishing each queued response stream.

*Call graph*: 1 external calls (now).


##### `tests::split_response`  (lines 293–297)

```
fn split_response(response: &str) -> (&str, &str)
```

**Purpose**: Splits a raw HTTP response string into headers and body at the first header terminator.

**Data flow**: It takes a response string, calls `split_once("\r\n\r\n")`, and returns the pair, panicking if the separator is missing.

**Call relations**: This local test helper is used by multiple unit tests in the module.


##### `tests::status_code`  (lines 299–305)

```
fn status_code(headers: &str) -> u16
```

**Purpose**: Extracts the numeric status code from an HTTP response header block.

**Data flow**: It takes the header string, reads the first line, splits on whitespace, skips the HTTP version token, parses the next token as `u16`, and returns it.

**Call relations**: Module tests use this to assert server responses without a full HTTP client.


##### `tests::header_value`  (lines 307–318)

```
fn header_value(headers: &'a str, name: &str) -> Option<&'a str>
```

**Purpose**: Looks up a header value by name from a raw HTTP response header block.

**Data flow**: It iterates header lines after the status line, splits each on the first colon, trims key and value, compares names case-insensitively, and returns `Option<&str>`.

**Call relations**: This helper supports assertions on content type and other response headers in the module tests.


##### `tests::connect`  (lines 320–325)

```
async fn connect(uri: &str) -> TcpStream
```

**Purpose**: Connects a raw `TcpStream` to the streaming SSE server URI.

**Data flow**: It strips the `http://` prefix from the URI, connects to the resulting socket address with `TcpStream::connect`, and returns the stream.

**Call relations**: Module tests use this helper to exercise the server at the raw TCP level.

*Call graph*: 1 external calls (connect).


##### `tests::read_to_end`  (lines 327–331)

```
async fn read_to_end(stream: &mut TcpStream) -> String
```

**Purpose**: Reads an entire TCP response stream into a UTF-8-lossy string.

**Data flow**: It takes a mutable `TcpStream`, reads all remaining bytes into a `Vec<u8>`, converts them with `String::from_utf8_lossy`, and returns the owned string.

**Call relations**: Many module tests use this after sending a request to capture the full response.

*Call graph*: 3 external calls (from_utf8_lossy, read_to_end, new).


##### `tests::read_until`  (lines 333–354)

```
async fn read_until(stream: &mut TcpStream, needle: &str) -> (String, String)
```

**Purpose**: Reads from a TCP stream until a specified byte sequence appears, returning the consumed prefix and any immediately following remainder.

**Data flow**: It takes a mutable `TcpStream` and needle string, repeatedly reads into a buffer, searches for the needle bytes, and once found returns `(prefix_through_needle, remainder_after_needle)` as strings. If EOF arrives first it returns the whole buffer and an empty remainder.

**Call relations**: Tests use this to stop after HTTP headers or after a gated chunk boundary without consuming the entire stream.

*Call graph*: 4 external calls (from_utf8_lossy, new, read, new).


##### `tests::send_request`  (lines 356–361)

```
async fn send_request(stream: &mut TcpStream, request: &str)
```

**Purpose**: Writes a raw HTTP request string to a TCP stream.

**Data flow**: It takes a mutable `TcpStream` and request string, writes all bytes, and returns nothing.

**Call relations**: This helper is used by the module's raw-socket tests to send handcrafted requests.

*Call graph*: 1 external calls (write_all).


##### `tests::get_models_returns_empty_list`  (lines 364–388)

```
async fn get_models_returns_empty_list()
```

**Purpose**: Verifies that `GET /v1/models` returns a 200 JSON response with an empty model list.

**Data flow**: It starts the server with no queued responses, opens a TCP connection, sends a GET request, reads the full response, splits headers/body, parses the JSON body, and asserts status, content type, and payload shape before shutting down the server.

**Call relations**: This unit test exercises the `/v1/models` branch of `start_streaming_sse_server`.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 7 external calls (new, assert_eq!, connect, read_to_end, send_request, split_response, from_str).


##### `tests::post_responses_streams_in_order_and_closes`  (lines 391–424)

```
async fn post_responses_streams_in_order_and_closes()
```

**Purpose**: Verifies that a queued `/v1/responses` stream emits all chunks in order, closes the connection, and reports a completion timestamp.

**Data flow**: It queues two ungated chunks, starts the server, sends a POST request, reads the full response, asserts SSE headers and concatenated body, confirms EOF on further reads, awaits the completion receiver, and checks the timestamp is positive.

**Call relations**: This test covers the normal happy path for queued SSE streaming.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 7 external calls (assert!, assert_eq!, connect, read_to_end, send_request, split_response, vec!).


##### `tests::none_gate_streams_immediately`  (lines 427–445)

```
async fn none_gate_streams_immediately()
```

**Purpose**: Verifies that chunks with `gate: None` are sent immediately once the SSE response starts.

**Data flow**: It starts the server with one ungated chunk, sends a POST request, reads through the header terminator, then reads the rest of the stream and asserts the chunk body arrived without waiting on any signal.

**Call relations**: This test exercises the no-gate branch in the chunk-sending loop.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 7 external calls (assert_eq!, connect, read_until, send_request, split_response, format!, vec!).


##### `tests::post_responses_with_no_queue_returns_500`  (lines 448–462)

```
async fn post_responses_with_no_queue_returns_500()
```

**Purpose**: Verifies that posting to `/v1/responses` with no queued response streams yields a 500 plain-text error.

**Data flow**: It starts the server with an empty queue, sends a POST request, reads the response, splits headers/body, and asserts status 500, `text/plain`, and body `no responses queued`.

**Call relations**: This test covers the `take_next_stream` failure path.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 6 external calls (new, assert_eq!, connect, read_to_end, send_request, split_response).


##### `tests::gated_chunks_wait_for_signal_and_preserve_order`  (lines 465–514)

```
async fn gated_chunks_wait_for_signal_and_preserve_order()
```

**Purpose**: Verifies that gated chunks are withheld until their oneshot signals fire and still arrive in FIFO order.

**Data flow**: It creates two gate channels, queues two gated chunks, starts the server, sends a POST request, reads headers, asserts no body arrives before the first gate, sends the first gate and reads exactly the first chunk, asserts the second chunk is still blocked, then sends the second gate and reads the remaining body.

**Call relations**: This test exercises the per-chunk gating logic that motivates the custom server.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 11 external calls (from_millis, assert!, assert_eq!, connect, read_to_end, read_until, send_request, split_response, channel, timeout (+1 more)).


##### `tests::multiple_responses_are_fifo_and_completion_timestamps_monotonic`  (lines 517–558)

```
async fn multiple_responses_are_fifo_and_completion_timestamps_monotonic()
```

**Purpose**: Verifies that multiple queued response streams are consumed in FIFO order across separate requests and that completion timestamps are nondecreasing.

**Data flow**: It queues two one-chunk responses, sends two POST requests sequentially, asserts each response body matches the corresponding queued stream, awaits both completion receivers, and checks both timestamps are positive and monotonic.

**Call relations**: This test covers queue ordering and completion-channel pairing.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 7 external calls (assert!, assert_eq!, connect, read_to_end, send_request, split_response, vec!).


##### `tests::unknown_route_returns_404`  (lines 561–575)

```
async fn unknown_route_returns_404()
```

**Purpose**: Verifies that unsupported routes receive a 404 plain-text response.

**Data flow**: It starts the server, sends `GET /v1/unknown`, reads the response, and asserts status 404, `text/plain`, and body `not found`.

**Call relations**: This test covers the fallback route branch in the connection handler.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 6 external calls (new, assert_eq!, connect, read_to_end, send_request, split_response).


##### `tests::malformed_request_returns_400`  (lines 578–588)

```
async fn malformed_request_returns_400()
```

**Purpose**: Verifies that an unparsable request line yields a 400 plain-text response.

**Data flow**: It starts the server, sends the malformed request `BAD\r\n\r\n`, reads the response, and asserts status 400, `text/plain`, and body `bad request`.

**Call relations**: This test covers the `parse_request_line` failure path.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 6 external calls (new, assert_eq!, connect, read_to_end, send_request, split_response).


##### `tests::responses_post_drains_request_body`  (lines 591–626)

```
async fn responses_post_drains_request_body()
```

**Purpose**: Verifies that the server fully drains a JSON POST body before responding with the queued SSE stream.

**Data flow**: It starts the server with one SSE response, sends a real `reqwest` POST containing a JSON payload, asserts the HTTP status and streamed bytes, awaits the completion timestamp, and checks it is positive.

**Call relations**: This test specifically exercises `read_request_body` in the `/v1/responses` path.

*Call graph*: calls 2 internal fn (new, start_streaming_sse_server); 5 external calls (assert!, assert_eq!, format!, json!, vec!).


##### `tests::read_http_request_returns_after_header_terminator`  (lines 629–657)

```
async fn read_http_request_returns_after_header_terminator()
```

**Purpose**: Verifies that `read_http_request` returns as soon as the header terminator is seen and leaves no body bytes when none were sent.

**Data flow**: It creates a temporary listener, spawns a server task that calls `read_http_request`, sends a simple GET request from a client, receives the parsed header/body pair over a oneshot, and asserts the header string matches exactly and the body is empty.

**Call relations**: This unit test isolates the low-level request-reading helper.

*Call graph*: calls 1 internal fn (read_http_request); 8 external calls (from_millis, bind, connect, assert!, assert_eq!, channel, spawn, timeout).


##### `tests::parse_request_line_handles_valid_and_invalid`  (lines 660–667)

```
fn parse_request_line_handles_valid_and_invalid()
```

**Purpose**: Verifies that `parse_request_line` rejects malformed input and parses a valid request line correctly.

**Data flow**: It calls `parse_request_line` with empty, malformed, and valid strings and asserts the returned `Option` values.

**Call relations**: This is a focused unit test for the request-line parser.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::take_next_stream_consumes_in_lockstep`  (lines 670–701)

```
async fn take_next_stream_consumes_in_lockstep()
```

**Purpose**: Verifies that `take_next_stream` pops response streams and completion senders in matching FIFO order.

**Data flow**: It constructs a `StreamingSseState` with two queued streams and two completion senders, calls `take_next_stream` twice, asserts the chunk bodies match the expected order, sends completion values through the returned senders, verifies the paired receivers get those values, and confirms a third call returns `None`.

**Call relations**: This unit test isolates the queue-popping helper used by the server.

*Call graph*: calls 1 internal fn (take_next_stream); 6 external calls (new, from, assert!, assert_eq!, channel, vec!).


##### `tests::shutdown_terminates_accept_loop`  (lines 704–708)

```
async fn shutdown_terminates_accept_loop()
```

**Purpose**: Verifies that calling `StreamingSseServer::shutdown` stops the accept loop promptly.

**Data flow**: It starts the server, wraps `server.shutdown()` in a short timeout, and asserts the shutdown future completes before the timeout.

**Call relations**: This test covers the shutdown signaling path of the background server task.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 4 external calls (from_millis, new, assert!, timeout).


### Harness builders
These harness modules construct the main Codex test fixture and specialized executable or shell-based variants for integration scenarios.

### `core/tests/common/zsh_fork.rs`

`util` · `integration test fixture setup before shell-execution tests`

The central type is `ZshForkRuntime`, which stores two resolved paths: the test `zsh` executable and the `codex-execve-wrapper` helper binary. Its private `apply_to_config` method mutates a `codex_core::config::Config` in a very specific way: it enables `Feature::ShellTool` and `Feature::ShellZshFork`, injects the two executable paths, disables login-shell execution, sets `permissions.approval_policy` via `Constrained::allow_any`, and applies a caller-provided `PermissionProfile`. The helper `restrictive_workspace_write_profile` constructs a sandboxed profile with restricted networking and explicit temp-directory exclusions, matching the expectations of several shell-sandbox tests. Runtime discovery is intentionally defensive. `zsh_fork_runtime` first calls `find_test_zsh_path`, which resolves the repository root, expects a shared DotSlash file at `codex-rs/app-server/tests/suite/zsh`, and fetches the actual binary via `fetch_dotslash_file`; any failure prints a skip reason and returns `Ok(None)`. It then probes the shell with `/usr/bin/true` under `EXEC_WRAPPER=/usr/bin/false`; only a non-success exit proves interception support. Finally it resolves `codex-execve-wrapper` with `cargo_bin`, again skipping cleanly if unavailable. The two async builders wrap `test_codex()` and install either the standard zsh-fork configuration or the unified-exec variant, additionally enabling `Feature::UnifiedExec` and `Feature::UnifiedExecZshFork` and setting `use_experimental_unified_exec_tool = true`.

#### Function details

##### `ZshForkRuntime::apply_to_config`  (lines 22–44)

```
fn apply_to_config(
        &self,
        config: &mut Config,
        approval_policy: AskForApproval,
        permission_profile: PermissionProfile,
    )
```

**Purpose**: Applies the zsh-fork runtime and permission settings to a mutable test `Config`. It turns on the shell-related features and injects the resolved executable paths needed for intercepted shell execution.

**Data flow**: Reads `self.zsh_path` and `self.main_execve_wrapper_exe`, plus `approval_policy` and `permission_profile` arguments → enables `Feature::ShellTool` and `Feature::ShellZshFork`, clones and stores the paths into `config.zsh_path` and `config.main_execve_wrapper_exe`, sets `allow_login_shell = false`, wraps the approval policy with `Constrained::allow_any`, and applies the permission profile through `set_permission_profile` → returns `()` after mutating `config` in place.

**Call relations**: This method is not called directly by tests; it is invoked inside the configuration closures assembled by `build_zsh_fork_test` and `build_unified_exec_zsh_fork_test`. Those builders rely on it to centralize the common zsh-fork configuration before adding any unified-exec-specific flags.

*Call graph*: calls 1 internal fn (allow_any); 1 external calls (clone).


##### `restrictive_workspace_write_profile`  (lines 47–54)

```
fn restrictive_workspace_write_profile() -> PermissionProfile
```

**Purpose**: Constructs the specific `PermissionProfile` used by zsh-fork tests that need workspace-write access but restricted networking and no temp-directory escape hatches. It encodes the sandbox assumptions expected by those tests in one reusable helper.

**Data flow**: Takes no arguments → calls `PermissionProfile::workspace_write_with(&[], NetworkSandboxPolicy::Restricted, true, true)` → returns the resulting `PermissionProfile` value without mutating external state.

**Call relations**: Several zsh-fork integration tests call this during fixture setup to supply a consistent permission profile into the builder helpers. It does not orchestrate test execution itself; it just packages the exact profile constants those callers need.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 6 (env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox, unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule).


##### `zsh_fork_runtime`  (lines 56–77)

```
fn zsh_fork_runtime(test_name: &str) -> Result<Option<ZshForkRuntime>>
```

**Purpose**: Discovers whether the current test environment can run zsh-fork tests and, if so, returns the resolved runtime paths. It converts missing binaries or unsupported interception into clean skips rather than hard failures.

**Data flow**: Accepts `test_name: &str` for skip diagnostics → calls `find_test_zsh_path`; if absent, returns `Ok(None)`. If a path exists, probes it with `supports_exec_wrapper_intercept`; on failure, prints a skip message including the path and returns `Ok(None)`. It then resolves `codex-execve-wrapper` via `cargo_bin`; if that fails, prints another skip message and returns `Ok(None)`. Otherwise it packages `zsh_path` and `main_execve_wrapper_exe` into `Some(ZshForkRuntime)` and returns `Ok(...)`.

**Call relations**: Individual zsh-fork tests call this first to decide whether to proceed or skip. It delegates discovery to `find_test_zsh_path` and capability probing to `supports_exec_wrapper_intercept`, acting as the gatekeeper before either builder function is used.

*Call graph*: calls 2 internal fn (find_test_zsh_path, supports_exec_wrapper_intercept); called by 5 (env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox, build_unified_exec_zsh_fork_test_or_skip); 2 external calls (cargo_bin, eprintln!).


##### `build_zsh_fork_test`  (lines 79–95)

```
async fn build_zsh_fork_test(
    server: &wiremock::MockServer,
    runtime: ZshForkRuntime,
    approval_policy: AskForApproval,
    permission_profile: PermissionProfile,
    pre_build_hook: F,
) -
```

**Purpose**: Builds a `TestCodex` fixture configured for standard zsh-fork execution. It combines a caller-supplied filesystem pre-build hook with the runtime-specific config mutation.

**Data flow**: Consumes a `wiremock::MockServer` reference, a `ZshForkRuntime`, approval and permission settings, and a `pre_build_hook: FnOnce(&Path)` → starts from `test_codex()`, attaches the hook with `with_pre_build_hook`, installs a config closure that calls `runtime.apply_to_config(...)`, then asynchronously builds against the mock server → returns `Result<TestCodex>`.

**Call relations**: Zsh-fork integration tests invoke this after obtaining a runtime from `zsh_fork_runtime`. It delegates all fixture assembly to the `test_codex` builder and uses `apply_to_config` to inject the zsh-specific settings at build time.

*Call graph*: calls 1 internal fn (test_codex); called by 4 (env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox).


##### `build_unified_exec_zsh_fork_test`  (lines 97–122)

```
async fn build_unified_exec_zsh_fork_test(
    server: &wiremock::MockServer,
    runtime: ZshForkRuntime,
    approval_policy: AskForApproval,
    permission_profile: PermissionProfile,
    pre_build
```

**Purpose**: Builds a `TestCodex` fixture for the unified-exec implementation layered on top of zsh-fork interception. It extends the standard zsh-fork config with the experimental unified-exec toggle and feature flags.

**Data flow**: Accepts the same inputs as `build_zsh_fork_test` → creates a `test_codex()` builder, attaches the pre-build hook, and installs a config closure that first calls `runtime.apply_to_config(...)`, then sets `config.use_experimental_unified_exec_tool = true` and enables `Feature::UnifiedExec` plus `Feature::UnifiedExecZshFork` → asynchronously builds and returns `Result<TestCodex>`.

**Call relations**: This helper is called by the unified-exec zsh-fork test path after runtime discovery. It parallels `build_zsh_fork_test` but adds the extra feature wiring needed for the alternate execution stack.

*Call graph*: calls 1 internal fn (test_codex); called by 1 (build_unified_exec_zsh_fork_test_or_skip).


##### `find_test_zsh_path`  (lines 124–142)

```
fn find_test_zsh_path() -> Result<Option<PathBuf>>
```

**Purpose**: Locates and materializes the shared test `zsh` binary referenced by a DotSlash file in the repository. It treats missing files or fetch failures as skippable conditions and reports them to stderr.

**Data flow**: Reads the repository root from `codex_utils_cargo_bin::repo_root()`, joins `codex-rs/app-server/tests/suite/zsh`, checks `is_file()`, and if present calls `crate::fetch_dotslash_file(&dotslash_zsh, None)` → returns `Ok(Some(PathBuf))` on success, `Ok(None)` after printing a skip reason when the file is missing or fetch fails, or propagates repository-root lookup errors.

**Call relations**: Only `zsh_fork_runtime` calls this helper. It isolates the repository-path and DotSlash-fetch logic so the higher-level runtime gatekeeper can focus on capability checks and wrapper resolution.

*Call graph*: called by 1 (zsh_fork_runtime); 3 external calls (repo_root, fetch_dotslash_file, eprintln!).


##### `supports_exec_wrapper_intercept`  (lines 144–154)

```
fn supports_exec_wrapper_intercept(zsh_path: &Path) -> bool
```

**Purpose**: Probes whether a given `zsh` binary honors `EXEC_WRAPPER` interception for non-login command execution. The test is intentionally simple: if wrapping `/usr/bin/true` with `/usr/bin/false` causes failure, interception is considered supported.

**Data flow**: Accepts `zsh_path: &Path` → spawns `std::process::Command::new(zsh_path)` with arguments `-fc` and `/usr/bin/true`, sets environment variable `EXEC_WRAPPER=/usr/bin/false`, and collects the exit status → returns `true` when the command runs and exits unsuccessfully, otherwise `false` on success or process-spawn error.

**Call relations**: This helper is called only from `zsh_fork_runtime` after a candidate shell path has been found. Its boolean result determines whether the runtime is usable or whether the caller should skip the test with an explanatory message.

*Call graph*: called by 1 (zsh_fork_runtime); 1 external calls (new).


### `core/tests/common/test_codex.rs`

`orchestration` · `test harness setup and turn execution`

This file is the main orchestration layer for core integration tests. It defines `TestCodexBuilder`, which accumulates config mutators, auth, pre-build hooks, workspace setup closures, optional temp home, cloud-config fixtures, shell overrides, exec-server URL overrides, extension registries, and user-instructions providers. Builder methods are intentionally composable and mostly mutate internal vectors or optional fields. The build paths differ only in transport/environment selection: wiremock SSE, custom streaming SSE, websocket, local-only execution, remote execution, or mixed remote+local environments.

`prepare_config` constructs a hermetic `Config` rooted in a temp home, points `model_provider.base_url` at the chosen test server, disables websocket transport by default, runs pre-build hooks against the home directory, loads default config (optionally with cloud bundle), sets `config.cwd`, tries several strategies to locate `codex` or `codex-exec` for self-invocation, applies queued config mutators, and injects a synthetic model catalog entry when the special `test-gpt-5.1-codex` model is selected.

`build_with_home_and_base_url` then creates an `EnvironmentManager`, runs queued workspace setup futures against the selected filesystem, and delegates to `build_from_config`. That method initializes the state DB and thread store, resolves installation ID, chooses a user-instructions provider, constructs a `ThreadManager`, and starts or resumes a thread, optionally using a user-shell override. The resulting `TestCodex` stores the temp home/workspace, `Arc<CodexThread>`, session configuration event, config, thread manager, and retained `TestEnv`.

`TestCodex` provides turn-submission helpers that translate permission profiles into legacy sandbox policy fields, submit `Op::UserInput`, wait for `TurnStarted` to capture the turn ID, then wait up to 30 seconds for the matching `TurnComplete`. `TestCodexHarness` wraps a started mock server plus `TestCodex` and adds filesystem helpers implemented through the executor filesystem abstraction, along with request-body inspection helpers that extract function/custom-tool outputs from captured `/responses` requests.

#### Function details

##### `RecordingUserInstructionsProvider::new`  (lines 85–90)

```
fn new(inner: Arc<dyn UserInstructionsProvider>) -> Self
```

**Purpose**: Wraps an existing `UserInstructionsProvider` with a load counter for tests that need to assert how often instructions are fetched.

**Data flow**: It takes `Arc<dyn UserInstructionsProvider>`, stores it in `inner`, initializes `load_count` to zero, and returns the wrapper.

**Call relations**: Tests construct this wrapper around a real provider and then pass it into `TestCodexBuilder::with_user_instructions_provider`.

*Call graph*: called by 2 (loads_user_instructions_without_a_primary_environment, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot); 1 external calls (new).


##### `RecordingUserInstructionsProvider::load_count`  (lines 92–94)

```
fn load_count(&self) -> usize
```

**Purpose**: Returns the number of times `load_user_instructions` has been invoked on the wrapper.

**Data flow**: It atomically reads `self.load_count` with `Ordering::SeqCst` and returns the `usize` count.

**Call relations**: Tests call this after running scenarios to verify instruction-loading behavior.

*Call graph*: 1 external calls (load).


##### `RecordingUserInstructionsProvider::load_user_instructions`  (lines 98–101)

```
fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_>
```

**Purpose**: Implements `UserInstructionsProvider` by incrementing the counter and delegating to the wrapped provider.

**Data flow**: It atomically increments `load_count`, then returns the future from `self.inner.load_user_instructions()`.

**Call relations**: The `ThreadManager` invokes this through the trait when loading user instructions; tests later inspect `load_count()`.

*Call graph*: 1 external calls (fetch_add).


##### `local`  (lines 104–109)

```
fn local(cwd: AbsolutePathBuf) -> TurnEnvironmentSelection
```

**Purpose**: Builds a `TurnEnvironmentSelection` targeting the local executor environment for a given absolute working directory.

**Data flow**: It takes an `AbsolutePathBuf`, fills `environment_id` with `LOCAL_ENVIRONMENT_ID`, converts the cwd to `PathUri`, and returns the selection struct.

**Call relations**: Tests use this helper directly and via `local_selections` when constructing explicit environment selections for a turn.

*Call graph*: calls 1 internal fn (from_abs_path); called by 3 (default_turn_does_not_overlay_legacy_fallback_cwd_onto_stored_thread_environments, exec_command_routes_to_selected_remote_environment, view_image_routes_to_selected_remote_environment).


##### `local_selections`  (lines 111–113)

```
fn local_selections(cwd: AbsolutePathBuf) -> TurnEnvironmentSelections
```

**Purpose**: Builds a `TurnEnvironmentSelections` containing exactly one local environment selection rooted at the given cwd.

**Data flow**: It clones the provided `AbsolutePathBuf`, constructs a single-element vector with `local(cwd)`, and returns `TurnEnvironmentSelections::new(...)`.

**Call relations**: Many tests use this helper to populate thread settings with an explicit local environment set.

*Call graph*: calls 1 internal fn (new); called by 72 (user_turn_updates_approvals_reviewer, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command, submit_turn, remote_model_override_uses_catalog_model_for_strict_auto_review, user_turn_collaboration_mode_overrides_model_and_effort, user_turn_explicit_reasoning_summary_overrides_model_catalog_default, collaboration_instructions_added_on_user_turn, collaboration_instructions_omitted_when_disabled (+15 more)); 2 external calls (clone, vec!).


##### `TestEnv::local`  (lines 125–137)

```
async fn local() -> Result<Self>
```

**Purpose**: Creates a local test execution environment backed by a fresh temporary working directory.

**Data flow**: It allocates a `TempDir`, converts it to `AbsolutePathBuf`, creates a `codex_exec_server::Environment` with no remote exec URL, and returns a `TestEnv` containing the environment, cwd, retained temp dir, and no remote container metadata.

**Call relations**: Builder paths that do not require remote execution call this to obtain the executor environment used during thread startup.

*Call graph*: calls 1 internal fn (create_for_tests); called by 5 (build, build_with_streaming_server, build_with_websocket_server, resume, test_env); 2 external calls (new, new).


##### `TestEnv::cwd`  (lines 139–141)

```
fn cwd(&self) -> &AbsolutePathBuf
```

**Purpose**: Returns the absolute working directory associated with the test environment.

**Data flow**: It returns `&self.cwd`.

**Call relations**: Builder setup reads this when preparing config and workspace setup closures.

*Call graph*: called by 1 (build_with_home_and_base_url).


##### `TestEnv::environment`  (lines 143–145)

```
fn environment(&self) -> &codex_exec_server::Environment
```

**Purpose**: Returns the underlying executor `Environment` for filesystem and execution operations.

**Data flow**: It returns `&self.environment`.

**Call relations**: Higher-level helpers use this to obtain the filesystem and to pass the environment into managers.

*Call graph*: called by 2 (fs, build_with_home_and_base_url).


##### `TestEnv::local_cwd_temp_dir`  (lines 147–149)

```
fn local_cwd_temp_dir(&self) -> Option<Arc<TempDir>>
```

**Purpose**: Returns the retained local temp directory when the environment is local-backed.

**Data flow**: It clones and returns `self.local_cwd_temp_dir` as `Option<Arc<TempDir>>`.

**Call relations**: Builder setup uses this to decide whether the final `TestCodex.cwd` should be the local environment temp dir or the fallback temp dir created during config preparation.

*Call graph*: called by 1 (build_with_home_and_base_url).


##### `TestEnv::drop`  (lines 153–158)

```
fn drop(&mut self)
```

**Purpose**: Cleans up remote test working directories inside Docker containers when a remote-backed `TestEnv` is dropped.

**Data flow**: On drop, if `remote_container_name` is present, it formats `rm -rf <cwd>` and invokes `docker_command_capture_stdout(["exec", container_name, "sh", "-lc", &script])`, ignoring any error.

**Call relations**: This destructor runs automatically at teardown for remote Docker environments so test-created directories do not accumulate inside the container.

*Call graph*: calls 1 internal fn (docker_command_capture_stdout); 1 external calls (format!).


##### `test_env`  (lines 161–190)

```
async fn test_env() -> Result<TestEnv>
```

**Purpose**: Creates either a remote-backed or local-backed `TestEnv` depending on the configured test environment variables.

**Data flow**: It reads `get_remote_test_env()`. For remote environments it resolves the remote exec server URL, creates a remote `Environment`, computes a unique remote cwd from `remote_test_instance_id`, creates that directory through the executor filesystem, converts the path URI back to `AbsolutePathBuf`, and returns a `TestEnv` with remote metadata. If no remote environment is configured, it delegates to `TestEnv::local()`.

**Call relations**: Remote-capable builder paths call this to obtain the execution environment appropriate for the current test process configuration.

*Call graph*: calls 4 internal fn (local, remote_exec_server_url, remote_test_instance_id, create_for_tests); called by 9 (remote_exec_server_rejects_inherited_fd_launches, unified_exec_uses_remote_exec_server_when_configured, build_with_remote_and_local_env, build_with_remote_env, remote_test_env_can_connect_and_use_filesystem, remote_test_env_copy_preserves_symlink_source, remote_test_env_remove_removes_symlink_not_target, remote_test_env_sandboxed_read_allows_readable_root, remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape); 1 external calls (get_remote_test_env).


##### `remote_exec_server_url`  (lines 192–203)

```
fn remote_exec_server_url() -> Result<String>
```

**Purpose**: Reads and validates the remote exec server URL from `CODEX_TEST_REMOTE_EXEC_SERVER_URL`.

**Data flow**: It reads the environment variable, trims whitespace, returns an error if missing or empty, and otherwise returns the URL string.

**Call relations**: This helper is used only by `test_env` when constructing remote-backed environments.

*Call graph*: called by 1 (test_env); 2 external calls (anyhow!, var).


##### `remote_test_instance_id`  (lines 205–208)

```
fn remote_test_instance_id() -> String
```

**Purpose**: Generates a unique per-process, per-call identifier for remote test working directories.

**Data flow**: It atomically increments `REMOTE_TEST_INSTANCE_COUNTER`, combines the current process ID and counter with `format!`, and returns the resulting string.

**Call relations**: Remote environment setup uses this to avoid cwd collisions across tests and shards.

*Call graph*: called by 1 (test_env); 1 external calls (format!).


##### `docker_command_capture_stdout`  (lines 210–224)

```
fn docker_command_capture_stdout(args: [&str; N]) -> Result<String>
```

**Purpose**: Runs a `docker` command, returning UTF-8 stdout on success and a detailed error containing stdout/stderr on failure.

**Data flow**: It takes a fixed-size array of argument strings, executes `docker`, checks the exit status, converts stdout to UTF-8, and returns `Result<String>`, attaching command context and failure details.

**Call relations**: The `TestEnv` destructor uses this to remove remote working directories inside Docker containers.

*Call graph*: called by 1 (drop); 3 external calls (from_utf8, anyhow!, new).


##### `turn_permission_fields`  (lines 240–248)

```
fn turn_permission_fields(
    permission_profile: PermissionProfile,
    cwd: &Path,
) -> (SandboxPolicy, Option<PermissionProfile>)
```

**Purpose**: Converts a `PermissionProfile` into the pair of thread-settings fields expected by tests: legacy `SandboxPolicy` plus optional modern `PermissionProfile`.

**Data flow**: It takes a `PermissionProfile` and cwd path, attempts `to_legacy_sandbox_policy(cwd)`, falls back to `SandboxPolicy::new_read_only_policy()` on conversion failure, and returns `(sandbox_policy, Some(permission_profile))`.

**Call relations**: Turn-submission helpers call this before constructing `ThreadSettingsOverrides` so both legacy and modern permission fields are populated consistently.

*Call graph*: calls 1 internal fn (to_legacy_sandbox_policy); called by 63 (submit_turn_with_context, apply_patch_turn_diff_tracks_local_and_remote_environment_paths, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command, remote_model_override_uses_catalog_model_for_strict_auto_review, code_mode_can_call_hidden_dynamic_tools, disabled_permission_user_turn, execpolicy_blocks_shell_invocation, submit_user_turn (+15 more)).


##### `TestCodexBuilder::with_config`  (lines 264–270)

```
fn with_config(mut self, mutator: T) -> Self
```

**Purpose**: Queues a one-shot config mutator closure to be applied during config preparation.

**Data flow**: It takes ownership of `self` and a `FnOnce(&mut Config)`, boxes the closure, pushes it into `config_mutators`, and returns the updated builder.

**Call relations**: Many other builder helpers, such as `with_model`, are implemented in terms of this generic mutator queue.

*Call graph*: called by 2 (with_model, with_model_info_override); 1 external calls (new).


##### `TestCodexBuilder::with_auth`  (lines 272–275)

```
fn with_auth(mut self, auth: CodexAuth) -> Self
```

**Purpose**: Overrides the auth object that will be used when constructing the thread manager and starting or resuming the thread.

**Data flow**: It takes ownership of `self` and a `CodexAuth`, stores it in `self.auth`, and returns the builder.

**Call relations**: Tests use this when they need non-default authentication behavior.


##### `TestCodexBuilder::with_model`  (lines 277–282)

```
fn with_model(self, model: &str) -> Self
```

**Purpose**: Queues a config mutation that sets `config.model` to a specific model slug.

**Data flow**: It clones the provided model string into an owned `String`, then delegates to `with_config` with a closure that assigns `config.model = Some(new_model)`.

**Call relations**: This is the simplest model-selection helper; `ensure_test_model_catalog` later may inject catalog data for special test models.

*Call graph*: calls 1 internal fn (with_config).


##### `TestCodexBuilder::with_model_info_override`  (lines 284–301)

```
fn with_model_info_override(self, model: &str, override_model_info: T) -> Self
```

**Purpose**: Queues a config mutation that ensures a model catalog exists, finds a specific model entry, mutates its `ModelInfo`, and selects that model.

**Data flow**: It captures the target model slug and override closure, then delegates to `with_config`. The queued closure lazily inserts `bundled_models_response()` into `config.model_catalog` if absent, finds the matching `ModelInfo` by `slug`, applies the caller's mutation, and sets `config.model = Some(model)`.

**Call relations**: Tests use this when they need to tweak catalog metadata for one model without constructing an entire custom catalog.

*Call graph*: calls 1 internal fn (with_config).


##### `TestCodexBuilder::with_pre_build_hook`  (lines 303–309)

```
fn with_pre_build_hook(mut self, hook: F) -> Self
```

**Purpose**: Queues a closure to run against the home directory path before config loading/building begins.

**Data flow**: It boxes the provided `FnOnce(&Path)` hook, pushes it into `pre_build_hooks`, and returns the builder.

**Call relations**: These hooks are drained and executed in `prepare_config`, typically to seed files under the temp home before config load.

*Call graph*: 1 external calls (new).


##### `TestCodexBuilder::with_workspace_setup`  (lines 311–319)

```
fn with_workspace_setup(mut self, setup: F) -> Self
```

**Purpose**: Queues an async workspace-setup closure that will run against the selected cwd and executor filesystem before thread startup.

**Data flow**: It takes a closure returning a future, wraps it into a boxed `WorkspaceSetup` that returns `BoxFuture<'static, Result<()>>`, pushes it into `workspace_setups`, and returns the builder.

**Call relations**: `build_with_home_and_base_url` drains and executes these setups after environment-manager creation and before thread startup.

*Call graph*: 1 external calls (new).


##### `TestCodexBuilder::with_home`  (lines 321–324)

```
fn with_home(mut self, home: Arc<TempDir>) -> Self
```

**Purpose**: Forces the builder to use a caller-supplied temp home directory instead of allocating a new one.

**Data flow**: It stores the provided `Arc<TempDir>` in `self.home` and returns the builder.

**Call relations**: Tests use this when they need to preserve home state across builds or resumes.


##### `TestCodexBuilder::with_cloud_config_bundle`  (lines 326–332)

```
fn with_cloud_config_bundle(
        mut self,
        cloud_config_bundle: CloudConfigBundleLoader,
    ) -> Self
```

**Purpose**: Supplies a cloud-config bundle loader to be used during config construction.

**Data flow**: It stores the provided `CloudConfigBundleLoader` in `self.cloud_config_bundle` and returns the builder.

**Call relations**: `prepare_config` consumes this option to choose between the default config loader and the cloud-bundle-aware variant.


##### `TestCodexBuilder::with_user_shell`  (lines 334–337)

```
fn with_user_shell(mut self, user_shell: Shell) -> Self
```

**Purpose**: Overrides the user shell used when starting or resuming the thread.

**Data flow**: It stores the provided `Shell` in `self.user_shell_override` and returns the builder.

**Call relations**: `build_from_config` consults this option to choose shell-override startup/resume paths.

*Call graph*: called by 1 (with_windows_cmd_shell).


##### `TestCodexBuilder::with_exec_server_url`  (lines 339–342)

```
fn with_exec_server_url(mut self, exec_server_url: impl Into<String>) -> Self
```

**Purpose**: Overrides the exec server URL used when constructing the environment manager.

**Data flow**: It converts the input into `String`, stores it in `self.exec_server_url`, and returns the builder.

**Call relations**: `build_with_home_and_base_url` prefers this explicit override over any URL carried by the selected `TestEnv`.

*Call graph*: 1 external calls (into).


##### `TestCodexBuilder::with_extensions`  (lines 344–347)

```
fn with_extensions(mut self, extensions: Arc<ExtensionRegistry<Config>>) -> Self
```

**Purpose**: Overrides the extension registry passed into the thread manager.

**Data flow**: It stores the provided `Arc<ExtensionRegistry<Config>>` in `self.extensions` and returns the builder.

**Call relations**: Tests use this to inject custom extensions into the started thread.


##### `TestCodexBuilder::with_user_instructions_provider`  (lines 349–355)

```
fn with_user_instructions_provider(
        mut self,
        provider: Arc<dyn UserInstructionsProvider>,
    ) -> Self
```

**Purpose**: Overrides the user-instructions provider used by the thread manager.

**Data flow**: It stores the provided `Arc<dyn UserInstructionsProvider>` in `self.user_instructions_provider` and returns the builder.

**Call relations**: `build_from_config` uses this provider instead of the default `CodexHomeUserInstructionsProvider` when present.


##### `TestCodexBuilder::with_windows_cmd_shell`  (lines 357–363)

```
fn with_windows_cmd_shell(self) -> Self
```

**Purpose**: On Windows, configures the builder to use `cmd.exe` as the user shell; on other platforms it leaves the builder unchanged.

**Data flow**: It checks `cfg!(windows)`, and if true resolves a `Shell` from `PathBuf::from("cmd.exe")` via `get_shell_by_model_provided_path`, then delegates to `with_user_shell`; otherwise it returns `self` unchanged.

**Call relations**: This is a platform-specific convenience wrapper around `with_user_shell`.

*Call graph*: calls 2 internal fn (get_shell_by_model_provided_path, with_user_shell); 2 external calls (from, cfg!).


##### `TestCodexBuilder::build`  (lines 365–377)

```
async fn build(&mut self, server: &wiremock::MockServer) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` using a wiremock server and a local execution environment.

**Data flow**: It ensures a home temp dir exists, formats the server base URL as `<server.uri()>/v1`, creates `TestEnv::local()`, and delegates to `build_with_home_and_base_url` with no resume path and `include_local_environment = false`.

**Call relations**: This is the standard builder entry used by `TestCodexHarness::with_builder` and most local integration tests.

*Call graph*: calls 2 internal fn (build_with_home_and_base_url, local); called by 1 (with_builder); 4 external calls (new, pin, new, format!).


##### `TestCodexBuilder::build_with_remote_env`  (lines 379–394)

```
async fn build_with_remote_env(
        &mut self,
        server: &wiremock::MockServer,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` using a wiremock server and the configured remote-or-local test environment.

**Data flow**: It ensures a home temp dir exists, formats the server base URL, obtains `test_env().await`, and delegates to `build_with_home_and_base_url` with no resume path and no extra local environment.

**Call relations**: Remote-environment harnesses use this when tests should run against the configured remote executor environment.

*Call graph*: calls 2 internal fn (build_with_home_and_base_url, test_env); called by 2 (with_remote_env_builder, agents_instructions); 4 external calls (new, pin, new, format!).


##### `TestCodexBuilder::build_with_remote_and_local_env`  (lines 396–411)

```
async fn build_with_remote_and_local_env(
        &mut self,
        server: &wiremock::MockServer,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` with the configured remote environment plus an additional local environment exposed by the environment manager.

**Data flow**: It ensures a home temp dir exists, formats the server base URL, obtains `test_env().await`, and delegates to `build_with_home_and_base_url` with `include_local_environment = true`.

**Call relations**: Tests that need both remote and local execution targets use this variant.

*Call graph*: calls 2 internal fn (build_with_home_and_base_url, test_env); 4 external calls (new, pin, new, format!).


##### `TestCodexBuilder::build_with_streaming_server`  (lines 413–431)

```
async fn build_with_streaming_server(
        &mut self,
        server: &StreamingSseServer,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` pointed at the custom streaming SSE server instead of wiremock.

**Data flow**: It reads `server.uri()`, ensures a home temp dir exists, creates `TestEnv::local()`, formats the base URL as `<uri>/v1`, and delegates to `build_with_home_and_base_url`.

**Call relations**: Streaming tests use this path so Codex talks to `StreamingSseServer`.

*Call graph*: calls 3 internal fn (uri, build_with_home_and_base_url, local); 4 external calls (new, pin, new, format!).


##### `TestCodexBuilder::build_with_websocket_server`  (lines 433–455)

```
async fn build_with_websocket_server(
        &mut self,
        server: &WebSocketTestServer,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` pointed at the websocket test server and mutates config to enable websocket transport and a realtime test model.

**Data flow**: It formats the websocket base URL as `<server.uri()>/v1`, ensures a home temp dir exists, pushes a config mutator that sets `model_provider.base_url`, `supports_websockets = true`, `experimental_realtime_ws_model = Some("realtime-test-model")`, and `realtime.version = V1`, creates `TestEnv::local()`, and delegates to `build_with_home_and_base_url`.

**Call relations**: Realtime/websocket tests use this specialized build path to flip the necessary transport flags before startup.

*Call graph*: calls 2 internal fn (build_with_home_and_base_url, local); 5 external calls (new, new, pin, new, format!).


##### `TestCodexBuilder::resume`  (lines 457–473)

```
async fn resume(
        &mut self,
        server: &wiremock::MockServer,
        home: Arc<TempDir>,
        rollout_path: PathBuf,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` by resuming from an existing rollout file under a supplied home directory.

**Data flow**: It formats the wiremock base URL, creates `TestEnv::local()`, and delegates to `build_with_home_and_base_url` with `resume_from = Some(rollout_path)` and the caller-provided home.

**Call relations**: Resume-related tests use this path to restart a thread from persisted rollout state.

*Call graph*: calls 2 internal fn (build_with_home_and_base_url, local); called by 1 (resume_until_initial_messages); 2 external calls (pin, format!).


##### `TestCodexBuilder::build_with_home_and_base_url`  (lines 475–530)

```
async fn build_with_home_and_base_url(
        &mut self,
        base_url: String,
        home: Arc<TempDir>,
        resume_from: Option<PathBuf>,
        test_env: TestEnv,
        include_local_e
```

**Purpose**: Shared build pipeline that prepares config, creates environment managers, runs workspace setup hooks, chooses the effective cwd temp dir, and delegates to thread startup/resume.

**Data flow**: It takes base URL, home, optional rollout path, `TestEnv`, and a flag for including a local environment. It calls `prepare_config` to get `(Config, fallback_cwd)`, resolves the exec server URL from builder override or `test_env`, computes local runtime paths including the Linux sandbox binary when applicable, creates an `EnvironmentManager` with or without local environment support, obtains the executor filesystem from `test_env.environment()`, drains and runs queued `workspace_setups` against `config.cwd` and that filesystem, chooses `cwd` as `test_env.local_cwd_temp_dir().unwrap_or(fallback_cwd)`, and calls `build_from_config`.

**Call relations**: All public build variants funnel through this method so transport and environment differences are isolated to a few parameters.

*Call graph*: calls 8 internal fn (build_from_config, prepare_config, cwd, environment, local_cwd_temp_dir, create_for_tests, create_for_tests_with_local, new); called by 6 (build, build_with_remote_and_local_env, build_with_remote_env, build_with_streaming_server, build_with_websocket_server, resume); 7 external calls (clone, new, pin, find_codex_linux_sandbox_exe, current_exe, swap, vec!).


##### `TestCodexBuilder::build_from_config`  (lines 532–613)

```
async fn build_from_config(
        &mut self,
        config: Config,
        cwd: Arc<TempDir>,
        home: Arc<TempDir>,
        resume_from: Option<PathBuf>,
        test_env: TestEnv,
        e
```

**Purpose**: Constructs runtime state from a prepared `Config`, creates the `ThreadManager`, and starts or resumes the thread with optional shell override.

**Data flow**: It takes the prepared `Config`, cwd/home temp dirs, optional rollout path, `TestEnv`, and `EnvironmentManager`. It initializes the state DB, derives the thread store, resolves installation ID, chooses a user-instructions provider, constructs `ThreadManager::new(...)`, wraps it in `Arc`, and then matches on `(resume_from, user_shell_override)` to choose one of four startup paths: resume with shell override, resume normally, start with shell override, or start normally. It returns a `TestCodex` containing the resulting `CodexThread`, `SessionConfiguredEvent`, config, thread manager, and retained environment.

**Call relations**: This is the final assembly step called only by `build_with_home_and_base_url`.

*Call graph*: calls 4 internal fn (auth_manager_from_auth, resume_thread_from_rollout_with_user_shell_override, start_thread_with_user_shell_override, new); called by 1 (build_with_home_and_base_url); 8 external calls (clone, new, pin, clone, init_state_db, resolve_installation_id, thread_store_from_config, clone).


##### `TestCodexBuilder::prepare_config`  (lines 615–665)

```
async fn prepare_config(
        &mut self,
        base_url: String,
        home: &TempDir,
        cwd_override: AbsolutePathBuf,
    ) -> anyhow::Result<(Config, Arc<TempDir>)>
```

**Purpose**: Builds the hermetic test `Config`, points it at the chosen model-provider base URL, runs pre-build hooks and config mutators, and ensures special test-model catalog entries exist.

**Data flow**: It takes the base URL, home temp dir, and cwd override. It constructs a `ModelProviderInfo` from the built-in OpenAI provider with `base_url` set and `supports_websockets = false`, allocates a fallback cwd temp dir, drains and runs `pre_build_hooks` against `home.path()`, loads default config with or without a cloud bundle, sets `config.cwd` and `config.model_provider`, tries to locate `codex` or `codex-exec` binaries for `config.codex_self_exe`, drains and applies queued config mutators, calls `ensure_test_model_catalog`, and returns `(config, cwd_temp_dir)`.

**Call relations**: Every build path calls this first so all later startup logic receives a fully prepared config.

*Call graph*: calls 1 internal fn (ensure_test_model_catalog); called by 1 (build_with_home_and_base_url); 10 external calls (new, new, path, built_in_model_providers, cargo_bin, load_default_config_for_test, load_default_config_for_test_with_cloud_config_bundle, current_exe, swap, vec!).


##### `ensure_test_model_catalog`  (lines 668–689)

```
fn ensure_test_model_catalog(config: &mut Config) -> Result<()>
```

**Purpose**: Injects a synthetic model-catalog entry for the special `test-gpt-5.1-codex` model when that model is selected and no catalog is already configured.

**Data flow**: It takes `&mut Config`, returns early unless `config.model == Some(TEST_MODEL_WITH_EXPERIMENTAL_TOOLS)` and `config.model_catalog.is_none()`, loads bundled models, clones the `gpt-5.2` entry, rewrites its slug and display name to the test model, sets `experimental_supported_tools = ["test_sync_tool"]`, stores a one-model `ModelsResponse` in `config.model_catalog`, and returns `Ok(())`.

**Call relations**: This helper is called from `prepare_config` so tests can select the special model slug without manually constructing a catalog.

*Call graph*: called by 1 (prepare_config); 2 external calls (bundled_models_response, vec!).


##### `TestCodex::cwd_path`  (lines 702–704)

```
fn cwd_path(&self) -> &Path
```

**Purpose**: Returns the filesystem path of the retained workspace temp directory.

**Data flow**: It returns `self.cwd.path()`.

**Call relations**: Other `TestCodex` helpers and tests use this as the base workspace path.

*Call graph*: called by 5 (workspace_path, read_only_user_turn, read_only_text_turn_with_personality, disabled_text_turn, submit_turn_with_policies).


##### `TestCodex::codex_home_path`  (lines 706–708)

```
fn codex_home_path(&self) -> &Path
```

**Purpose**: Returns the filesystem path of the Codex home directory from the active config.

**Data flow**: It returns `self.config.codex_home.as_path()`.

**Call relations**: Tests use this to seed or inspect files under the test home.

*Call graph*: called by 2 (seed_recent_thread, skill_script_command).


##### `TestCodex::workspace_path`  (lines 710–712)

```
fn workspace_path(&self, rel: impl AsRef<Path>) -> PathBuf
```

**Purpose**: Builds a workspace-relative path under the retained cwd temp directory.

**Data flow**: It takes a relative path-like value, joins it onto `cwd_path()`, and returns the resulting `PathBuf`.

**Call relations**: This is a convenience helper for tests that need concrete workspace file paths.

*Call graph*: calls 1 internal fn (cwd_path); called by 1 (seed_recent_thread).


##### `TestCodex::executor_environment`  (lines 714–716)

```
fn executor_environment(&self) -> &TestEnv
```

**Purpose**: Returns the retained `TestEnv` describing the executor environment used by this harness.

**Data flow**: It returns `&self._test_env`.

**Call relations**: Tests use this when they need direct access to environment metadata beyond the filesystem abstraction.


##### `TestCodex::fs`  (lines 718–720)

```
fn fs(&self) -> Arc<dyn ExecutorFileSystem>
```

**Purpose**: Returns the executor filesystem associated with the harness environment.

**Data flow**: It reads `self._test_env.environment()` and returns `Arc<dyn ExecutorFileSystem>` from `get_filesystem()`.

**Call relations**: Filesystem-manipulation helpers in `TestCodexHarness` delegate to this method.

*Call graph*: calls 1 internal fn (environment); called by 8 (abs_path_exists, create_dir_all, read_file_text, remove_abs_path, write_file, create_workspace_directory, create_workspace_directory, write_workspace_file).


##### `TestCodex::submit_turn`  (lines 722–725)

```
async fn submit_turn(&self, prompt: &str) -> Result<()>
```

**Purpose**: Submits a user turn with approvals disabled and the `Disabled` permission profile, then waits for completion.

**Data flow**: It takes a prompt string, delegates to `submit_turn_with_permission_profile(prompt, PermissionProfile::Disabled)`, awaits it, and returns the result.

**Call relations**: This is the simplest turn-submission helper and is used by `TestCodexHarness::submit`.

*Call graph*: calls 1 internal fn (submit_turn_with_permission_profile); called by 1 (submit).


##### `TestCodex::submit_turn_with_permission_profile`  (lines 727–738)

```
async fn submit_turn_with_permission_profile(
        &self,
        prompt: &str,
        permission_profile: PermissionProfile,
    ) -> Result<()>
```

**Purpose**: Submits a user turn with a specific permission profile and no approval prompts, then waits for completion.

**Data flow**: It takes a prompt and `PermissionProfile`, delegates to `submit_turn_with_approval_and_permission_profile` with `AskForApproval::Never`, and returns the result.

**Call relations**: This helper is used directly by tests and by the simpler `submit_turn` wrapper.

*Call graph*: calls 1 internal fn (submit_turn_with_approval_and_permission_profile); called by 2 (submit_turn, submit_with_permission_profile).


##### `TestCodex::submit_turn_with_policy`  (lines 740–747)

```
async fn submit_turn_with_policy(
        &self,
        prompt: &str,
        sandbox_policy: SandboxPolicy,
    ) -> Result<()>
```

**Purpose**: Submits a user turn using an explicit legacy `SandboxPolicy` and no approval prompts, then waits for completion.

**Data flow**: It takes a prompt and sandbox policy, delegates to `submit_turn_with_policies(prompt, AskForApproval::Never, sandbox_policy)`, and returns the result.

**Call relations**: This is the legacy-policy convenience wrapper used by harness methods and tests.

*Call graph*: calls 1 internal fn (submit_turn_with_policies); called by 1 (submit_with_policy).


##### `TestCodex::submit_turn_with_service_tier`  (lines 749–762)

```
async fn submit_turn_with_service_tier(
        &self,
        prompt: &str,
        service_tier: Option<&str>,
    ) -> Result<()>
```

**Purpose**: Submits a user turn while overriding the service tier in thread settings.

**Data flow**: It takes a prompt and optional service-tier string, wraps the tier as `Option<Option<String>>`, delegates to `submit_turn_with_permission_profile_context` with approvals disabled, `PermissionProfile::Disabled`, and no explicit environments, and returns the result.

**Call relations**: Tests use this when asserting service-tier propagation into outbound requests.

*Call graph*: calls 1 internal fn (submit_turn_with_permission_profile_context).


##### `TestCodex::submit_turn_with_policies`  (lines 764–782)

```
async fn submit_turn_with_policies(
        &self,
        prompt: &str,
        approval_policy: AskForApproval,
        sandbox_policy: SandboxPolicy,
    ) -> Result<()>
```

**Purpose**: Submits a user turn using explicit approval and sandbox policies, deriving the corresponding permission profile from the sandbox policy.

**Data flow**: It takes a prompt, `AskForApproval`, and `SandboxPolicy`, derives `PermissionProfile::from_legacy_sandbox_policy_for_cwd(&sandbox_policy, self.config.cwd.as_path())`, then delegates to `submit_turn_with_context` with no service tier or explicit environments.

**Call relations**: This helper bridges legacy sandbox-policy tests into the common turn-submission path.

*Call graph*: calls 2 internal fn (submit_turn_with_context, from_legacy_sandbox_policy_for_cwd); called by 1 (submit_turn_with_policy).


##### `TestCodex::submit_turn_with_approval_and_permission_profile`  (lines 784–798)

```
async fn submit_turn_with_approval_and_permission_profile(
        &self,
        prompt: &str,
        approval_policy: AskForApproval,
        permission_profile: PermissionProfile,
    ) -> Result<
```

**Purpose**: Submits a user turn with explicit approval policy and permission profile, then waits for completion.

**Data flow**: It takes a prompt, approval policy, and permission profile, delegates to `submit_turn_with_permission_profile_context` with no service tier or environments, and returns the result.

**Call relations**: This is the main explicit-permissions wrapper used by tests and by `submit_turn_with_permission_profile`.

*Call graph*: calls 1 internal fn (submit_turn_with_permission_profile_context); called by 2 (submit_turn_with_permission_profile, run_extract_turn).


##### `TestCodex::submit_turn_with_environments`  (lines 800–813)

```
async fn submit_turn_with_environments(
        &self,
        prompt: &str,
        environments: Option<Vec<TurnEnvironmentSelection>>,
    ) -> Result<()>
```

**Purpose**: Submits a user turn with explicit environment selections and default disabled permissions.

**Data flow**: It takes a prompt and optional vector of `TurnEnvironmentSelection`, delegates to `submit_turn_with_permission_profile_context` with approvals disabled, `PermissionProfile::Disabled`, no service tier, and the provided environments.

**Call relations**: Environment-routing tests use this helper to target specific execution environments.

*Call graph*: calls 1 internal fn (submit_turn_with_permission_profile_context); called by 1 (exec_command_routing_output).


##### `TestCodex::submit_turn_with_permission_profile_context`  (lines 815–831)

```
async fn submit_turn_with_permission_profile_context(
        &self,
        prompt: &str,
        approval_policy: AskForApproval,
        permission_profile: PermissionProfile,
        service_tier:
```

**Purpose**: Shared wrapper that forwards prompt, approval policy, permission profile, optional service tier, and optional environments into the common submission path.

**Data flow**: It takes those parameters and delegates directly to `submit_turn_with_context`, awaiting and returning the result.

**Call relations**: Several public submission helpers funnel through this method to avoid duplicating argument plumbing.

*Call graph*: calls 1 internal fn (submit_turn_with_context); called by 3 (submit_turn_with_approval_and_permission_profile, submit_turn_with_environments, submit_turn_with_service_tier).


##### `TestCodex::submit_turn_with_context`  (lines 833–890)

```
async fn submit_turn_with_context(
        &self,
        prompt: &str,
        approval_policy: AskForApproval,
        permission_profile: PermissionProfile,
        service_tier: Option<Option<Stri
```

**Purpose**: Constructs and submits `Op::UserInput` with the requested permissions, service tier, and environment selections, then waits for the matching turn to start and complete.

**Data flow**: It takes prompt text, approval policy, permission profile, optional service tier override, and optional environment selections. It converts the permission profile via `turn_permission_fields`, captures the session model from `session_configured`, wraps explicit environments into `TurnEnvironmentSelections` rooted at `config.cwd`, submits `Op::UserInput` containing one `UserInput::Text` item and `ThreadSettingsOverrides` populated with environments, approval policy, sandbox policy, permission profile, service tier, and a default collaboration mode carrying the session model. After submission it waits for `EventMsg::TurnStarted` to obtain the `turn_id`, then waits up to `SUBMIT_TURN_COMPLETE_TIMEOUT` for `EventMsg::TurnComplete` with the same `turn_id`, and returns `Ok(())`.

**Call relations**: All public turn-submission helpers ultimately delegate here; it is the central synchronization point that turns asynchronous thread execution into a simple test API.

*Call graph*: calls 1 internal fn (turn_permission_fields); called by 2 (submit_turn_with_permission_profile_context, submit_turn_with_policies); 4 external calls (default, wait_for_event_match, wait_for_event_with_timeout, vec!).


##### `TestCodexHarness::new`  (lines 899–901)

```
async fn new() -> Result<Self>
```

**Purpose**: Creates a default harness with a fresh mock server and the default `test_codex()` builder.

**Data flow**: It constructs the default builder via `test_codex()`, delegates to `with_builder`, awaits the result, and returns the harness.

**Call relations**: This is the simplest harness constructor for tests that need no custom configuration.

*Call graph*: calls 1 internal fn (test_codex); 1 external calls (with_builder).


##### `TestCodexHarness::with_config`  (lines 903–905)

```
async fn with_config(mutator: impl FnOnce(&mut Config) + Send + 'static) -> Result<Self>
```

**Purpose**: Creates a harness using the default builder plus one caller-supplied config mutator.

**Data flow**: It builds `test_codex().with_config(mutator)`, delegates to `with_builder`, awaits it, and returns the harness.

**Call relations**: This is a convenience constructor for one-off config tweaks without manually handling the builder.

*Call graph*: calls 1 internal fn (test_codex); 1 external calls (with_builder).


##### `TestCodexHarness::with_builder`  (lines 907–911)

```
async fn with_builder(mut builder: TestCodexBuilder) -> Result<Self>
```

**Purpose**: Starts a default mock server, builds a `TestCodex` from the supplied builder, and returns both as a harness.

**Data flow**: It starts the server with `start_mock_server().await`, calls `builder.build(&server).await`, and returns `TestCodexHarness { server, test }`.

**Call relations**: Most integration tests use this constructor after customizing a `TestCodexBuilder`.

*Call graph*: calls 2 internal fn (start_mock_server, build); called by 33 (assert_remote_manual_compact_request_parity, auto_remote_compact_failure_stops_agent_loop, auto_remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_persists_replacement_history_in_rollout, remote_compact_replaces_history_for_followups, remote_compact_rewrites_multiple_trailing_function_call_outputs, remote_compact_runs_automatically, remote_compact_trim_estimate_uses_session_base_instructions, remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_v2_accepts_additional_output_items_before_compaction (+15 more)).


##### `TestCodexHarness::with_remote_env_builder`  (lines 913–917)

```
async fn with_remote_env_builder(mut builder: TestCodexBuilder) -> Result<Self>
```

**Purpose**: Starts a default mock server and builds a `TestCodex` using the builder's remote-environment path.

**Data flow**: It starts the server, calls `builder.build_with_remote_env(&server).await`, and returns the harness.

**Call relations**: Remote-environment tests use this constructor instead of the local-only `with_builder`.

*Call graph*: calls 2 internal fn (start_mock_server, build_with_remote_env); called by 1 (apply_patch_harness_with).


##### `TestCodexHarness::server`  (lines 919–921)

```
fn server(&self) -> &MockServer
```

**Purpose**: Returns the underlying wiremock server used by the harness.

**Data flow**: It returns `&self.server`.

**Call relations**: Tests use this to mount additional responses or inspect received requests directly.

*Call graph*: called by 6 (mount_apply_patch, mount_apply_patch_model_output, mount_legacy_compact_if_needed, mount_shell_responses, mount_shell_responses_with_timeout, run_tool_turn_on_harness).


##### `TestCodexHarness::test`  (lines 923–925)

```
fn test(&self) -> &TestCodex
```

**Purpose**: Returns the underlying `TestCodex` instance.

**Data flow**: It returns `&self.test`.

**Call relations**: Tests use this when they need lower-level access than the harness convenience methods provide.

*Call graph*: called by 3 (submit_without_wait_with_turn_permissions, rollout_path, run_tool_turn_on_harness).


##### `TestCodexHarness::cwd`  (lines 927–929)

```
fn cwd(&self) -> &Path
```

**Purpose**: Returns the configured cwd path from the harness's active config.

**Data flow**: It returns `self.test.config.cwd.as_path()`.

**Call relations**: This is a convenience accessor for workspace-relative assertions.


##### `TestCodexHarness::cwd_abs`  (lines 931–933)

```
fn cwd_abs(&self) -> AbsolutePathBuf
```

**Purpose**: Returns the configured cwd as an `AbsolutePathBuf`.

**Data flow**: It clones `self.test.config.cwd` and returns it.

**Call relations**: Tests use this when they need the project's absolute-path wrapper rather than a plain `&Path`.


##### `TestCodexHarness::path`  (lines 935–937)

```
fn path(&self, rel: impl AsRef<Path>) -> PathBuf
```

**Purpose**: Builds a workspace-relative path under the configured cwd and returns it as `PathBuf`.

**Data flow**: It takes a relative path-like value, delegates to `path_abs`, converts the result into `PathBuf`, and returns it.

**Call relations**: This is the plain-`PathBuf` convenience wrapper around `path_abs`.

*Call graph*: calls 1 internal fn (path_abs).


##### `TestCodexHarness::path_abs`  (lines 939–941)

```
fn path_abs(&self, rel: impl AsRef<Path>) -> AbsolutePathBuf
```

**Purpose**: Builds a workspace-relative path under the configured cwd and returns it as `AbsolutePathBuf`.

**Data flow**: It takes a relative path-like value, joins it onto `self.test.config.cwd`, and returns the resulting absolute path wrapper.

**Call relations**: Filesystem helpers use this to resolve relative paths before converting them to `PathUri`.

*Call graph*: called by 5 (create_dir_all, path, path_exists, read_file_text, write_file).


##### `TestCodexHarness::write_file`  (lines 943–970)

```
async fn write_file(
        &self,
        rel: impl AsRef<Path>,
        contents: impl AsRef<[u8]>,
    ) -> Result<()>
```

**Purpose**: Creates parent directories as needed and writes bytes to a workspace-relative file through the executor filesystem abstraction.

**Data flow**: It resolves the absolute path with `path_abs`, creates the parent directory via `fs().create_directory` if one exists, converts the file path to `PathUri`, writes the provided bytes with `fs().write_file`, and returns `Result<()>`.

**Call relations**: Tests use this helper to seed workspace files in a way that works for both local and remote executor environments.

*Call graph*: calls 3 internal fn (fs, path_abs, from_path); 1 external calls (as_ref).


##### `TestCodexHarness::read_file_text`  (lines 972–980)

```
async fn read_file_text(&self, rel: impl AsRef<Path>) -> Result<String>
```

**Purpose**: Reads a workspace-relative file as text through the executor filesystem abstraction.

**Data flow**: It resolves the absolute path with `path_abs`, converts it to `PathUri`, calls `fs().read_file_text`, and returns the resulting `String`.

**Call relations**: This complements `write_file` for assertions on workspace contents.

*Call graph*: calls 3 internal fn (fs, path_abs, from_path).


##### `TestCodexHarness::create_dir_all`  (lines 982–994)

```
async fn create_dir_all(&self, rel: impl AsRef<Path>) -> Result<()>
```

**Purpose**: Creates a workspace-relative directory tree through the executor filesystem abstraction.

**Data flow**: It resolves the absolute path with `path_abs`, converts it to `PathUri`, calls `fs().create_directory` with `recursive: true`, and returns `Result<()>`.

**Call relations**: Tests use this to prepare directory structures in local or remote workspaces.

*Call graph*: calls 3 internal fn (fs, path_abs, from_path).


##### `TestCodexHarness::path_exists`  (lines 996–998)

```
async fn path_exists(&self, rel: impl AsRef<Path>) -> Result<bool>
```

**Purpose**: Checks whether a workspace-relative path exists.

**Data flow**: It resolves the path with `path_abs`, delegates to `abs_path_exists`, and returns the boolean result.

**Call relations**: This is the relative-path convenience wrapper around `abs_path_exists`.

*Call graph*: calls 2 internal fn (abs_path_exists, path_abs).


##### `TestCodexHarness::remove_abs_path`  (lines 1000–1014)

```
async fn remove_abs_path(&self, path: &AbsolutePathBuf) -> Result<()>
```

**Purpose**: Removes an absolute path through the executor filesystem abstraction using forceful non-recursive removal.

**Data flow**: It converts the `AbsolutePathBuf` to `PathUri`, calls `fs().remove` with `RemoveOptions { recursive: false, force: true }`, and returns `Result<()>`.

**Call relations**: Tests use this to delete files or links in a transport-agnostic way.

*Call graph*: calls 2 internal fn (fs, from_abs_path).


##### `TestCodexHarness::abs_path_exists`  (lines 1016–1028)

```
async fn abs_path_exists(&self, path: &AbsolutePathBuf) -> Result<bool>
```

**Purpose**: Checks whether an absolute path exists through the executor filesystem abstraction, treating `NotFound` as `false`.

**Data flow**: It converts the path to `PathUri`, calls `fs().get_metadata`, returns `Ok(true)` on success, `Ok(false)` when the I/O error kind is `NotFound`, and propagates other errors.

**Call relations**: This is the underlying existence check used by `path_exists`.

*Call graph*: calls 2 internal fn (fs, from_abs_path); called by 1 (path_exists).


##### `TestCodexHarness::submit`  (lines 1030–1034)

```
async fn submit(&self, prompt: &str) -> Result<()>
```

**Purpose**: Submits a prompt through the underlying `TestCodex` and boxes the future to keep caller async state small.

**Data flow**: It takes a prompt string, boxes `self.test.submit_turn(prompt)`, awaits it, and returns the result.

**Call relations**: This is the harness-level convenience wrapper around the default turn-submission path.

*Call graph*: calls 1 internal fn (submit_turn); 1 external calls (pin).


##### `TestCodexHarness::submit_with_policy`  (lines 1036–1044)

```
async fn submit_with_policy(
        &self,
        prompt: &str,
        sandbox_policy: SandboxPolicy,
    ) -> Result<()>
```

**Purpose**: Submits a prompt with an explicit sandbox policy through the underlying `TestCodex`.

**Data flow**: It takes a prompt and `SandboxPolicy`, delegates to `self.test.submit_turn_with_policy`, awaits it, and returns the result.

**Call relations**: This is the harness-level wrapper for legacy-policy turn submission.

*Call graph*: calls 1 internal fn (submit_turn_with_policy).


##### `TestCodexHarness::submit_with_permission_profile`  (lines 1046–1054)

```
async fn submit_with_permission_profile(
        &self,
        prompt: &str,
        permission_profile: PermissionProfile,
    ) -> Result<()>
```

**Purpose**: Submits a prompt with an explicit permission profile through the underlying `TestCodex`.

**Data flow**: It takes a prompt and `PermissionProfile`, delegates to `self.test.submit_turn_with_permission_profile`, awaits it, and returns the result.

**Call relations**: This is the harness-level wrapper for permission-profile turn submission.

*Call graph*: calls 1 internal fn (submit_turn_with_permission_profile).


##### `TestCodexHarness::request_bodies`  (lines 1056–1069)

```
async fn request_bodies(&self) -> Vec<Value>
```

**Purpose**: Returns parsed JSON bodies for all `/responses` requests received by the harness's wiremock server.

**Data flow**: It builds a path matcher for `.*/responses$`, fetches all received requests from the server, filters them by path, parses each body as `serde_json::Value`, and returns the vector of bodies.

**Call relations**: Higher-level output-inspection helpers use this to search across all outbound response requests.

*Call graph*: called by 2 (custom_tool_call_output, function_call_output_value); 2 external calls (received_requests, path_regex).


##### `TestCodexHarness::function_call_output_value`  (lines 1071–1074)

```
async fn function_call_output_value(&self, call_id: &str) -> Value
```

**Purpose**: Finds the full `function_call_output` item for a given `call_id` across captured request bodies.

**Data flow**: It fetches `request_bodies().await`, delegates to the free helper `function_call_output(&bodies, call_id)`, clones the matched `Value`, and returns it.

**Call relations**: This helper underlies `function_call_stdout` and supports tests that need the full output item.

*Call graph*: calls 2 internal fn (request_bodies, function_call_output); called by 1 (function_call_stdout).


##### `TestCodexHarness::function_call_stdout`  (lines 1076–1083)

```
async fn function_call_stdout(&self, call_id: &str) -> String
```

**Purpose**: Extracts the string `output` field from a captured `function_call_output` item.

**Data flow**: It obtains the full output item via `function_call_output_value(call_id).await`, reads its `output` field as a string, clones it, and returns it.

**Call relations**: Tests use this when function-call outputs are expected to be plain strings.

*Call graph*: calls 1 internal fn (function_call_output_value).


##### `TestCodexHarness::custom_tool_call_output`  (lines 1085–1088)

```
async fn custom_tool_call_output(&self, call_id: &str) -> String
```

**Purpose**: Extracts normalized text from a captured `custom_tool_call_output` item for a given `call_id`.

**Data flow**: It fetches `request_bodies().await`, delegates to `custom_tool_call_output_text(&bodies, call_id)`, and returns the resulting string.

**Call relations**: This helper is the harness-level accessor for custom tool outputs and underlies `apply_patch_output`.

*Call graph*: calls 2 internal fn (request_bodies, custom_tool_call_output_text); called by 1 (apply_patch_output).


##### `TestCodexHarness::apply_patch_output`  (lines 1090–1092)

```
async fn apply_patch_output(&self, call_id: &str) -> String
```

**Purpose**: Returns the text output of an `apply_patch` custom tool call.

**Data flow**: It delegates to `custom_tool_call_output(call_id).await` and returns the string.

**Call relations**: This is a semantic alias used by patch-related tests.

*Call graph*: calls 1 internal fn (custom_tool_call_output).


##### `custom_tool_call_output`  (lines 1095–1106)

```
fn custom_tool_call_output(bodies: &'a [Value], call_id: &str) -> &'a Value
```

**Purpose**: Searches parsed request bodies for the `custom_tool_call_output` item matching a given `call_id` and returns it by reference.

**Data flow**: It takes a slice of JSON bodies and `call_id`, iterates each body's `input` array, finds the first item with `type == "custom_tool_call_output"` and matching `call_id`, and returns `&Value`, panicking with a descriptive message if absent.

**Call relations**: This free helper is used by `custom_tool_call_output_text` and the harness-level custom-tool output accessors.

*Call graph*: called by 1 (custom_tool_call_output_text); 2 external calls (iter, format!).


##### `custom_tool_call_output_text`  (lines 1108–1114)

```
fn custom_tool_call_output_text(bodies: &[Value], call_id: &str) -> String
```

**Purpose**: Extracts normalized text from a `custom_tool_call_output` item across parsed request bodies.

**Data flow**: It takes request bodies and `call_id`, finds the item via `custom_tool_call_output`, reads its `output` field, normalizes it with `output_value_to_text`, and returns the resulting string, panicking if the output field is missing or non-textual.

**Call relations**: This helper is used by `TestCodexHarness::custom_tool_call_output` and by local unit tests in this file.

*Call graph*: calls 2 internal fn (output_value_to_text, custom_tool_call_output); called by 2 (custom_tool_call_output, custom_tool_call_output_text_panics_when_output_is_missing); 1 external calls (format!).


##### `function_call_output`  (lines 1116–1127)

```
fn function_call_output(bodies: &'a [Value], call_id: &str) -> &'a Value
```

**Purpose**: Searches parsed request bodies for the `function_call_output` item matching a given `call_id` and returns it by reference.

**Data flow**: It takes a slice of JSON bodies and `call_id`, iterates each body's `input` array, finds the first item with `type == "function_call_output"` and matching `call_id`, and returns `&Value`, panicking with a descriptive message if absent.

**Call relations**: This free helper is used by `TestCodexHarness::function_call_output_value`.

*Call graph*: called by 1 (function_call_output_value); 2 external calls (iter, format!).


##### `test_codex`  (lines 1129–1147)

```
fn test_codex() -> TestCodexBuilder
```

**Purpose**: Constructs the default `TestCodexBuilder` used by most tests, with Apps disabled and dummy API-key auth.

**Data flow**: It returns a `TestCodexBuilder` initialized with one config mutator that disables `Feature::Apps`, `CodexAuth::from_api_key("dummy")`, empty hook/setup vectors, no home/cloud bundle/shell/exec override, an empty extension registry, and no custom user-instructions provider.

**Call relations**: Most harness constructors and tests start from this builder and then layer additional configuration on top.

*Call graph*: calls 1 internal fn (from_api_key); called by 583 (fork_startup_context_then_first_turn_diff_snapshot, session_configured_reports_permission_profile_for_external_sandbox, apps_enabled_builder, search_capable_apps_builder, new, with_config, build_unified_exec_zsh_fork_test, build_zsh_fork_test, responses_stream_includes_turn_metadata_header_for_git_workspace_e2e, interrupt_long_running_tool_emits_turn_aborted (+15 more)); 2 external calls (empty_extension_registry, vec!).


##### `tests::custom_tool_call_output_text_returns_output_text`  (lines 1156–1166)

```
fn custom_tool_call_output_text_returns_output_text()
```

**Purpose**: Verifies that `custom_tool_call_output_text` returns a plain string output correctly.

**Data flow**: It constructs a synthetic request-body vector containing one `custom_tool_call_output` item with string output, calls `custom_tool_call_output_text`, and asserts the returned string equals `hello`.

**Call relations**: This unit test exercises the happy path of the custom-tool output extraction helper.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::custom_tool_call_output_text_panics_when_output_is_missing`  (lines 1170–1179)

```
fn custom_tool_call_output_text_panics_when_output_is_missing()
```

**Purpose**: Verifies that `custom_tool_call_output_text` panics with the expected message when the output field is absent.

**Data flow**: It constructs a synthetic request-body vector containing a `custom_tool_call_output` item without `output`, calls `custom_tool_call_output_text`, and relies on `#[should_panic]` to assert the panic message.

**Call relations**: This unit test covers the failure path of the custom-tool output extraction helper.

*Call graph*: calls 1 internal fn (custom_tool_call_output_text); 1 external calls (vec!).


### `core/tests/common/test_codex_exec.rs`

`orchestration` · `CLI test setup`

This file provides a minimal harness for CLI-style tests that execute the compiled `codex-exec` binary as a subprocess. `TestCodexExecBuilder` owns two `TempDir`s: one for `CODEX_HOME`/`CODEX_SQLITE_HOME` and one for the process working directory. The main method, `cmd`, resolves the `codex-exec` binary via `codex_utils_cargo_bin::cargo_bin`, constructs an `assert_cmd::Command`, sets the current directory to the temp cwd, and injects the standard environment variables expected by tests, including a dummy API key through `CODEX_API_KEY_ENV_VAR`.

`cmd_with_server` layers one additional runtime configuration override onto that command: it formats the mock server's `/v1` base URL and passes `-c openai_base_url=<quoted>` so the subprocess talks to the test server instead of any real endpoint. The quoting is handled by `toml_string_literal`, which serializes the URL with `serde_json::to_string`; this produces a correctly escaped quoted string suitable for TOML inline configuration syntax.

The remaining accessors expose the temp cwd and home paths for tests that need to seed files or inspect persisted state. `test_codex_exec` is the constructor that allocates both temp directories and returns a ready-to-use builder.

#### Function details

##### `TestCodexExecBuilder::cmd`  (lines 12–22)

```
fn cmd(&self) -> assert_cmd::Command
```

**Purpose**: Builds an `assert_cmd::Command` configured to run the `codex-exec` binary in isolated temp directories with dummy auth.

**Data flow**: It resolves the `codex-exec` binary path, constructs `assert_cmd::Command::new(...)`, sets `current_dir` to `self.cwd.path()`, sets `CODEX_HOME`, `CODEX_SQLITE_HOME`, and `CODEX_API_KEY_ENV_VAR`, and returns the configured command.

**Call relations**: This is the base subprocess-construction method; `cmd_with_server` builds on it to inject a mock server URL.

*Call graph*: called by 1 (cmd_with_server); 3 external calls (path, new, cargo_bin).


##### `TestCodexExecBuilder::cmd_with_server`  (lines 23–29)

```
fn cmd_with_server(&self, server: &MockServer) -> assert_cmd::Command
```

**Purpose**: Builds a `codex-exec` command configured to talk to a specific mock server via an inline config override.

**Data flow**: It starts from `self.cmd()`, formats the server base URL as `<server.uri()>/v1`, serializes that URL with `toml_string_literal`, appends `-c openai_base_url=<quoted>` arguments, and returns the command.

**Call relations**: CLI tests that need remote API interactions use this wrapper instead of `cmd`.

*Call graph*: calls 1 internal fn (cmd); 1 external calls (format!).


##### `TestCodexExecBuilder::cwd_path`  (lines 31–33)

```
fn cwd_path(&self) -> &Path
```

**Purpose**: Returns the temporary working-directory path used by the subprocess.

**Data flow**: It returns `self.cwd.path()`.

**Call relations**: Tests use this to seed workspace files or inspect cwd-relative outputs.

*Call graph*: 1 external calls (path).


##### `TestCodexExecBuilder::home_path`  (lines 34–36)

```
fn home_path(&self) -> &Path
```

**Purpose**: Returns the temporary home-directory path used by the subprocess.

**Data flow**: It returns `self.home.path()`.

**Call relations**: Tests use this to inspect persisted config, rollout, or database state under the isolated home.

*Call graph*: 1 external calls (path).


##### `toml_string_literal`  (lines 39–41)

```
fn toml_string_literal(value: &str) -> String
```

**Purpose**: Serializes a string as a quoted literal suitable for embedding in TOML config override syntax.

**Data flow**: It takes a string slice, serializes it with `serde_json::to_string`, and returns the resulting quoted/escaped `String`.

**Call relations**: `cmd_with_server` uses this to safely embed the mock server URL in the `-c` override argument.

*Call graph*: 1 external calls (to_string).


##### `test_codex_exec`  (lines 43–48)

```
fn test_codex_exec() -> TestCodexExecBuilder
```

**Purpose**: Constructs a fresh `TestCodexExecBuilder` with isolated temp home and cwd directories.

**Data flow**: It allocates two `TempDir`s, stores them in `TestCodexExecBuilder { home, cwd }`, and returns the builder.

**Call relations**: CLI tests call this constructor first, then derive commands with `cmd` or `cmd_with_server`.

*Call graph*: called by 28 (accepts_add_dir_flag, accepts_multiple_add_dir_flags, exec_includes_workspace_agents_md_in_request, exec_prefers_workspace_agents_override_md, run_exec_with_auto_review_config, exec_uses_codex_api_key_env_var, does_not_persist_rollout_file_in_ephemeral_mode, persists_rollout_file_by_default, exec_hook_trust_bypass_runs_session_start_hook, exits_non_zero_when_required_mcp_server_fails_to_initialize (+15 more)); 1 external calls (new).
