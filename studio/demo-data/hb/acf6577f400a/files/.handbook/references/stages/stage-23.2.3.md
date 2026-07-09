# Core integration harness and common test support  `stage-23.2.3`

This stage is shared behind-the-scenes support for testing the core crate. It is not a feature being tested; it is the workshop that lets all the feature tests run safely and repeatably. The main entry files, `all.rs` and `suite/mod.rs`, gather the integration tests into one runnable test program and let that program pretend to be helper binaries when needed. The common toolbox supplies temporary folders, default settings, sandbox checks, hook approval setup, tracing setup, and helpers for waiting on background processes. Other helpers decide whether tests run locally, in Docker, or through Wine, and prepare special zsh fork tests when that path is available. Several files build fake outside services: mock Codex Apps, OpenAI Responses and Models APIs, WebSocket or HTTP replies, and controlled Server-Sent Event streams. Snapshot helpers turn large request data into stable readable text. The Codex test builders create a complete fake conversation world, while the exec helper runs `codex-exec` without touching real user files. Together, these pieces make end-to-end tests reliable, isolated, and understandable.

## Files in this stage

### Test suite entrypoints
These files define the integration-test binary and top-level suite aggregation that all shared support code serves.

### `core/tests/all.rs`

`test` · `test run`

This file exists to make the integration tests easy for Rust’s test system to find and run. Instead of scattering separate test binaries across many files, the project uses one main test file that pulls in the actual test suite from a submodule named `suite`.

The line allowing `clippy::expect_used` relaxes one lint rule for tests. In normal production code, using `expect` can be discouraged because it crashes if something goes wrong. In tests, that is often useful: a failed assumption should stop the test clearly, with a helpful message.

It also publicly re-exports `codex_protocol::error`. That makes the protocol error type available to the test modules through this shared test crate, so tests can refer to it consistently.

Without this file, the test modules under `tests/all/` would not be collected into this integration test binary in the same way. Think of it like the cover page and table of contents for a test booklet: it does not contain the questions itself, but it tells the runner which section to open.


### `core/tests/suite/mod.rs`

`test` · `test startup and test discovery`

This file brings many former standalone integration tests together under one Rust test suite. Each `mod ...` line points Rust at another test file, so those tests are compiled and run as part of the same test binary. Without this file, large parts of the core behavior would not be included when the suite runs.

Before the tests start, it also configures command dispatch for the test binary. Some code under test expects to launch helper executables such as `apply_patch`, a filesystem helper, or the Linux sandbox tool. In real use, those are separate command names. In the test environment, this file lets one test binary wear different “name tags,” like one actor playing several roles depending on how it is invoked. That makes tests closer to real behavior without needing to build and locate many separate binaries.

A few test modules are included only on certain operating systems. For example, sandbox and permission tests that depend on Unix or Linux features are skipped on Windows. This keeps the suite portable while still testing platform-specific behavior where it exists.


### Core test wiring
These modules provide the foundational shared utilities, internal test-only constructors, and environment/config helpers used to assemble hermetic integration fixtures.

### `core/tests/common/lib.rs`

`test` · `test startup and test execution`

Tests need a controlled world. This file builds that world for many Codex test crates, so each test does not have to repeat the same setup or guess how the host machine behaves. At process startup, it switches Codex into deterministic test behavior, such as stable process IDs, and prepares special binary lookup and snapshot-test paths. That makes test results repeatable instead of depending on timing or a developer’s machine.

The file also offers path helpers that hide operating-system differences. A test can ask for “/tmp” or another Unix-style path and get a sensible Windows path when running on Windows. It provides helpers for absolute paths, temporary directories, and directory symlinks.

For tests that start a Codex thread, this file supplies waiting functions. They read Codex events until the expected message appears, with timeouts so a broken test fails instead of hanging forever. Other helpers build an isolated default configuration in a temporary Codex home, locate test binaries, fetch DotSlash resources, and format shell commands the same way Codex would.

The nested `fs_wait` module is like a lookout watching the file system: it waits until a path or matching file appears. The exported skip macros let tests politely exit when the current sandbox, network, Windows, remote, or Wine environment cannot support them.

#### Function details

##### `enable_deterministic_unified_exec_process_ids_for_tests`  (lines 46–49)

```
fn enable_deterministic_unified_exec_process_ids_for_tests()
```

**Purpose**: Turns on test-only deterministic behavior for Codex process handling. This keeps tests from depending on random or timing-sensitive process IDs.

**Data flow**: It takes no input. At test process startup, it tells Codex test support to use the test thread manager mode and deterministic process IDs. It returns nothing, but it changes global test settings for the whole process.

**Call relations**: This runs automatically as a startup constructor before tests begin. It hands the work to `set_thread_manager_test_mode` and `set_deterministic_process_ids`, so later tests see predictable execution behavior.

*Call graph*: calls 2 internal fn (set_deterministic_process_ids, set_thread_manager_test_mode).


##### `configure_arg0_dispatch_for_test_binaries`  (lines 52–54)

```
fn configure_arg0_dispatch_for_test_binaries()
```

**Purpose**: Sets up test binaries so they can find related Codex helper programs through the special `arg0` dispatch mechanism. This helps tests launch the right helper executable without hard-coding paths everywhere.

**Data flow**: It takes no direct input. It initializes a shared one-time value with the result of `codex_arg0::arg0_dispatch`, if that has not already happened. It returns nothing, but stores the guard that keeps the temporary path setup alive.

**Call relations**: This also runs automatically at process startup. Later, `find_codex_linux_sandbox_exe` can read the stored dispatch information to locate the sandbox helper binary.


##### `configure_insta_workspace_root_for_snapshot_tests`  (lines 57–74)

```
fn configure_insta_workspace_root_for_snapshot_tests()
```

**Purpose**: Makes snapshot tests find the project workspace reliably. Snapshot tests compare output against saved reference files, so they need a stable root folder.

**Data flow**: It first checks whether `INSTA_WORKSPACE_ROOT` is already set. If not, it asks for the repository root, appends `codex-rs`, canonicalizes that path, and writes it into the environment. It returns nothing, but may set an environment variable.

**Call relations**: This startup constructor prepares the process before snapshot tests run. It relies on the external repository-root helper and only sets the environment when the caller has not already chosen one.

*Call graph*: 3 external calls (repo_root, set_var, var_os).


##### `assert_regex_match`  (lines 77–82)

```
fn assert_regex_match(pattern: &str, actual: &'s str) -> regex_lite::Captures<'s>
```

**Purpose**: Checks that a piece of text matches a regular expression, and returns the captured parts. Tests use it when exact text may vary but must follow a known pattern.

**Data flow**: It receives a pattern string and the actual text. It compiles the pattern, tries to match it against the text, and either returns the match captures or fails the test with a clear expectation message.

**Call relations**: Individual tests call this helper directly. It delegates pattern compilation to the regex library and is marked so failures point at the test line that called it.

*Call graph*: 1 external calls (new).


##### `test_path_buf_with_windows`  (lines 84–101)

```
fn test_path_buf_with_windows(unix_path: &str, windows_path: Option<&str>) -> PathBuf
```

**Purpose**: Builds a test path that works on both Unix-like systems and Windows. This lets tests describe paths once while still running on different operating systems.

**Data flow**: It receives a Unix-style path and, optionally, a Windows-specific replacement. On Windows it uses the replacement if provided, otherwise it converts path segments under `C:\`; elsewhere it returns the Unix path unchanged. The output is a `PathBuf`, Rust’s owned path value.

**Call relations**: This is the base path-conversion helper. `test_path_buf` uses it for ordinary paths, and `test_absolute_path_with_windows` uses it before checking that a path is absolute.

*Call graph*: called by 2 (test_absolute_path_with_windows, test_path_buf); 2 external calls (from, cfg!).


##### `test_path_buf`  (lines 103–105)

```
fn test_path_buf(unix_path: &str) -> PathBuf
```

**Purpose**: Creates an operating-system-appropriate test path from a Unix-style path. It is the simple version for cases that do not need a custom Windows spelling.

**Data flow**: It receives a Unix-style path string and passes it to `test_path_buf_with_windows` with no Windows override. It returns the resulting `PathBuf`.

**Call relations**: Tests call this when they need a plain path value. It is a thin wrapper around `test_path_buf_with_windows`.

*Call graph*: calls 1 internal fn (test_path_buf_with_windows).


##### `test_absolute_path_with_windows`  (lines 107–113)

```
fn test_absolute_path_with_windows(
    unix_path: &str,
    windows_path: Option<&str>,
) -> AbsolutePathBuf
```

**Purpose**: Creates an absolute test path that works across operating systems. It also checks that the resulting path really is absolute, which catches bad test setup early.

**Data flow**: It receives a Unix-style path and an optional Windows-specific path. It first builds a platform-correct `PathBuf`, then converts it into `AbsolutePathBuf`, a path type that promises the path is absolute. It returns that absolute path or fails if the path is not absolute.

**Call relations**: This builds on `test_path_buf_with_windows`. `test_absolute_path` and `test_tmp_path` call it for common absolute-path needs.

*Call graph*: calls 2 internal fn (test_path_buf_with_windows, from_absolute_path); called by 2 (test_absolute_path, test_tmp_path).


##### `test_absolute_path`  (lines 115–117)

```
fn test_absolute_path(unix_path: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an absolute test path from a Unix-style string. It is the convenient version when no Windows-specific spelling is needed.

**Data flow**: It receives a Unix-style path string, calls `test_absolute_path_with_windows` without a Windows override, and returns an `AbsolutePathBuf`.

**Call relations**: Tests use this as the common absolute-path helper. The real platform adjustment is done by `test_absolute_path_with_windows`.

*Call graph*: calls 1 internal fn (test_absolute_path_with_windows).


##### `create_directory_symlink`  (lines 127–131)

```
fn create_directory_symlink(source: &Path, link: &Path)
```

**Purpose**: Creates a directory symbolic link for tests. A symbolic link is like a shortcut in the file system that points to another directory.

**Data flow**: It receives the real directory path and the link path to create. On Unix it calls the Unix symlink function; on Windows it calls the Windows directory-symlink function. It returns nothing, but creates a link on disk or fails the test if creation is not allowed.

**Call relations**: Tests call this when they need to exercise behavior around linked directories. The function hides the platform-specific system call differences.

*Call graph*: 2 external calls (symlink, symlink_dir).


##### `TempDir::abs`  (lines 138–140)

```
fn abs(&self) -> AbsolutePathBuf
```

**Purpose**: Adds a convenient way to get a temporary directory as an absolute path. Tests use it to pass temp directories into code that requires absolute paths.

**Data flow**: It reads the path stored inside a `TempDir`, converts that path using the project’s absolute-path test helper, and returns an `AbsolutePathBuf`. It does not change the temporary directory.

**Call relations**: This method comes from the local `TempDirExt` trait implemented for `TempDir`. Any test that imports the trait can call `.abs()` directly on a temporary directory.


##### `test_tmp_path`  (lines 143–145)

```
fn test_tmp_path() -> AbsolutePathBuf
```

**Purpose**: Returns a believable temporary-directory path for the current operating system. It is useful for tests that need to compare or construct temp paths without using the real environment.

**Data flow**: It supplies `/tmp` for Unix-like systems and a Windows temp-folder path for Windows, then turns that into an absolute path. The output is an `AbsolutePathBuf`.

**Call relations**: It uses `test_absolute_path_with_windows` for the platform conversion. `test_tmp_path_buf` calls it when a regular `PathBuf` is needed instead.

*Call graph*: calls 1 internal fn (test_absolute_path_with_windows); called by 1 (test_tmp_path_buf).


##### `test_tmp_path_buf`  (lines 147–149)

```
fn test_tmp_path_buf() -> PathBuf
```

**Purpose**: Returns the test temporary-directory path as a regular owned path value. This is for APIs that do not require the stricter absolute-path type.

**Data flow**: It calls `test_tmp_path` to get the absolute test temp path, then converts it into a `PathBuf`. It returns that path and changes nothing else.

**Call relations**: This is a small adapter around `test_tmp_path`, used by tests that need the more general path type.

*Call graph*: calls 1 internal fn (test_tmp_path).


##### `fetch_dotslash_file`  (lines 152–185)

```
fn fetch_dotslash_file(
    dotslash_file: &std::path::Path,
    dotslash_cache: Option<&std::path::Path>,
) -> anyhow::Result<PathBuf>
```

**Purpose**: Runs the `dotslash` tool to fetch a declared resource and returns the actual file path that was downloaded or resolved. DotSlash is a tool for making external files or executables available in a repeatable way.

**Data flow**: It receives the DotSlash file to fetch and an optional cache directory. It builds a `dotslash -- fetch ...` command, optionally sets `DOTSLASH_CACHE`, runs the command, checks that it succeeded, reads the returned path from standard output, verifies that the path is non-empty and points to a file, and returns that file path. Errors include context about what went wrong.

**Call relations**: Tests call this when they need a DotSlash-managed fixture or executable. It hands the actual fetching to the external `dotslash` command and validates the result before giving it back.

*Call graph*: 4 external calls (from, from_utf8, new, ensure!).


##### `load_default_config_for_test`  (lines 190–196)

```
async fn load_default_config_for_test(codex_home: &TempDir) -> Config
```

**Purpose**: Builds a default Codex configuration whose files live inside a test temporary directory. This prevents tests from reading or modifying a developer’s real Codex home folder.

**Data flow**: It receives a temporary directory representing the test Codex home. It creates the default cloud-config bundle loader and passes both values to the more detailed config-loading helper. It returns the completed `Config`.

**Call relations**: Tests use this common helper for ordinary configuration setup. It delegates the real construction to `load_default_config_for_test_with_cloud_config_bundle`.

*Call graph*: calls 2 internal fn (default, load_default_config_for_test_with_cloud_config_bundle).


##### `load_default_config_for_test_with_cloud_config_bundle`  (lines 200–212)

```
async fn load_default_config_for_test_with_cloud_config_bundle(
    codex_home: &TempDir,
    cloud_config_bundle: CloudConfigBundleLoader,
) -> Config
```

**Purpose**: Builds a test Codex configuration while allowing the test to supply cloud configuration requirements. This is used when a test needs special managed or enterprise-like settings.

**Data flow**: It receives a temporary Codex home and a cloud-config bundle loader. It starts a default `ConfigBuilder`, disables managed config loading for tests, points Codex home at the temp directory, applies test overrides, attaches the cloud bundle loader, builds the config asynchronously, and returns it. If this default test setup fails, the test fails.

**Call relations**: `load_default_config_for_test` calls this for the normal case. Internally it asks `default_test_overrides` for platform-specific overrides, such as the Linux sandbox helper path.

*Call graph*: calls 2 internal fn (without_managed_config_for_tests, default_test_overrides); called by 1 (load_default_config_for_test); 2 external calls (path, default).


##### `managed_network_requirements_loader`  (lines 214–222)

```
fn managed_network_requirements_loader() -> CloudConfigBundleLoader
```

**Purpose**: Creates a test cloud-config loader that says managed network requirements are enabled and local binding is allowed. Tests use this to simulate an enterprise configuration that affects networking behavior.

**Data flow**: It contains a small TOML configuration text block and passes it to the cloud-config fixture builder. It returns a `CloudConfigBundleLoader` ready to be used during config construction.

**Call relations**: Tests can pass this loader into `load_default_config_for_test_with_cloud_config_bundle` when they need those network requirements applied.

*Call graph*: calls 1 internal fn (loader_with_enterprise_requirement).


##### `default_test_overrides`  (lines 235–237)

```
fn default_test_overrides() -> ConfigOverrides
```

**Purpose**: Provides configuration overrides that are useful in tests, especially for finding the Linux sandbox executable on Linux. On non-Linux systems it leaves the defaults unchanged.

**Data flow**: On Linux, it tries to find the `codex-linux-sandbox` helper and stores that path in `ConfigOverrides`; all other fields keep their defaults. On other operating systems, it returns default overrides. The output is a `ConfigOverrides` value.

**Call relations**: `load_default_config_for_test_with_cloud_config_bundle` calls this while building test configuration. On Linux it depends on `find_codex_linux_sandbox_exe` to locate the helper binary.

*Call graph*: calls 1 internal fn (find_codex_linux_sandbox_exe); called by 1 (load_default_config_for_test_with_cloud_config_bundle); 1 external calls (default).


##### `find_codex_linux_sandbox_exe`  (lines 240–254)

```
fn find_codex_linux_sandbox_exe() -> Result<PathBuf, CargoBinError>
```

**Purpose**: Finds the executable path for the Linux sandbox helper used by tests. The sandbox helper is a separate program that runs commands with Linux restrictions.

**Data flow**: It first checks whether the startup `arg0` dispatch setup already knows the helper path. If not, it tries the current test executable path, and if that fails, asks Cargo’s binary helper for `codex-linux-sandbox`. It returns the path or an error from the binary lookup.

**Call relations**: `default_test_overrides` calls this when building Linux test configuration. Skip macros may also use it indirectly when deciding whether sandbox-dependent tests can run.

*Call graph*: called by 1 (default_test_overrides); 2 external calls (cargo_bin, current_exe).


##### `wait_for_event`  (lines 256–265)

```
async fn wait_for_event(
    codex: &CodexThread,
    predicate: F,
) -> codex_protocol::protocol::EventMsg
```

**Purpose**: Waits until a Codex thread emits an event that matches a test’s condition. It gives tests a simple way to wait for asynchronous work without sleeping blindly.

**Data flow**: It receives a `CodexThread` and a predicate function that says whether an event is the desired one. It calls the timeout-aware waiting helper with a one-second requested wait, and returns the first matching event message.

**Call relations**: `wait_for_event_match` uses this as its event-waiting base. The real loop and timeout behavior live in `wait_for_event_with_timeout`.

*Call graph*: calls 1 internal fn (wait_for_event_with_timeout); called by 1 (wait_for_event_match); 1 external calls (from_secs).


##### `wait_for_mcp_server`  (lines 268–298)

```
async fn wait_for_mcp_server(codex: &CodexThread, server_name: &str) -> anyhow::Result<()>
```

**Purpose**: Waits for Codex to finish starting an MCP server and checks that a named server became ready. MCP means Model Context Protocol, a way for Codex to talk to external tool servers.

**Data flow**: It receives a Codex thread and a server name. It reads events until it sees the MCP startup summary, then looks for the named server in the failed, cancelled, and ready lists. It returns success if the server is ready, or an error or assertion failure if startup did not produce the expected result.

**Call relations**: Tests call this after configuring MCP servers. It reads events directly from the Codex thread and interprets the startup-complete message for the specific server under test.

*Call graph*: calls 1 internal fn (next_event); 2 external calls (bail!, assert!).


##### `submit_thread_settings`  (lines 300–323)

```
async fn submit_thread_settings(
    codex: &CodexThread,
    thread_settings: codex_protocol::protocol::ThreadSettingsOverrides,
) -> anyhow::Result<()>
```

**Purpose**: Sends new thread settings to a running Codex thread and waits until Codex confirms that they were applied. This lets tests change settings and know when the change has taken effect.

**Data flow**: It receives a Codex thread and setting overrides. It submits a `ThreadSettings` operation, remembers the returned submission ID, then reads events with a timeout until it finds a response with that same ID. It returns success on `ThreadSettingsApplied`, panics on an error event or an unexpected event, and propagates submission errors.

**Call relations**: Tests call this when they need to adjust a live Codex thread. It hands the request to `submit` and then uses `next_event` to wait for the matching acknowledgement.

*Call graph*: calls 2 internal fn (next_event, submit); 2 external calls (from_secs, panic!).


##### `wait_for_event_match`  (lines 325–331)

```
async fn wait_for_event_match(codex: &CodexThread, matcher: F) -> T
```

**Purpose**: Waits for an event and extracts a useful value from it at the same time. This avoids making tests wait once and then separately unpack the event.

**Data flow**: It receives a Codex thread and a matcher function that returns `Some(value)` for the desired event or `None` otherwise. It waits for any event where the matcher succeeds, then runs the matcher again on that event and returns the extracted value.

**Call relations**: This is built on top of `wait_for_event`. Tests use it when they care about data inside an event, not just the fact that the event happened.

*Call graph*: calls 1 internal fn (wait_for_event).


##### `wait_for_event_with_timeout`  (lines 333–353)

```
async fn wait_for_event_with_timeout(
    codex: &CodexThread,
    mut predicate: F,
    wait_time: tokio::time::Duration,
) -> codex_protocol::protocol::EventMsg
```

**Purpose**: Repeatedly reads Codex events until one matches a condition, with a timeout so tests do not hang forever. It is the core event-waiting loop for asynchronous Codex tests.

**Data flow**: It receives a Codex thread, a predicate, and a wait duration. In a loop, it waits for the next event using at least ten seconds to allow startup work, fails if the wait times out or the event stream ends, and returns the first event message that satisfies the predicate.

**Call relations**: `wait_for_event` calls this with its default timeout. This function talks directly to `CodexThread::next_event`, so it is the main bridge between tests and Codex’s event stream.

*Call graph*: calls 1 internal fn (next_event); called by 1 (wait_for_event); 2 external calls (from_secs, max).


##### `sandbox_env_var`  (lines 355–357)

```
fn sandbox_env_var() -> &'static str
```

**Purpose**: Returns the name of the environment variable that tells Codex what sandbox mode is active. Tests and skip macros use the shared constant instead of duplicating the string.

**Data flow**: It takes no input and returns a static string borrowed from Codex core. It does not read the environment itself.

**Call relations**: The `skip_if_sandbox` macro uses this function when deciding whether a test should exit early in the seatbelt sandbox.


##### `sandbox_network_env_var`  (lines 359–361)

```
fn sandbox_network_env_var() -> &'static str
```

**Purpose**: Returns the name of the environment variable that means network access is disabled in the Codex sandbox. This keeps network-related test skipping tied to the same constant as production code.

**Data flow**: It takes no input and returns a static string from Codex core. It does not inspect the environment or change anything.

**Call relations**: The `skip_if_no_network` macro uses this value to check whether a test should skip itself because networking is unavailable.


##### `format_with_current_shell`  (lines 363–365)

```
fn format_with_current_shell(command: &str) -> Vec<String>
```

**Purpose**: Formats a command as arguments for the user’s default shell, using a login shell. A login shell is started as if the user had just logged in, so it may load profile files.

**Data flow**: It receives a command string. It asks Codex core what the default user shell is, asks that shell how to run the command with login-shell behavior, and returns the argument list as strings.

**Call relations**: Tests use this to compare against Codex’s real shell command formatting. `format_with_current_shell_display` calls it when it needs a printable version.

*Call graph*: calls 1 internal fn (default_user_shell); called by 1 (format_with_current_shell_display).


##### `format_with_current_shell_display`  (lines 367–370)

```
fn format_with_current_shell_display(command: &str) -> String
```

**Purpose**: Formats a command for the current shell and turns the argument list into a readable shell-style string. This is handy for snapshot tests or error-message comparisons.

**Data flow**: It receives a command string, gets the login-shell argument list from `format_with_current_shell`, then quotes and joins those arguments using shell escaping. It returns one display string.

**Call relations**: This is a display wrapper around `format_with_current_shell`. It relies on `shlex` joining so arguments with spaces or special characters are shown safely.

*Call graph*: calls 1 internal fn (format_with_current_shell); 1 external calls (try_join).


##### `format_with_current_shell_non_login`  (lines 372–375)

```
fn format_with_current_shell_non_login(command: &str) -> Vec<String>
```

**Purpose**: Formats a command as arguments for the user’s default shell without using login-shell behavior. Tests use this when they need the non-login command form Codex would run.

**Data flow**: It receives a command string. It asks the default user shell to build execution arguments with `use_login_shell` set to false, and returns the resulting list of strings.

**Call relations**: This parallels `format_with_current_shell` but chooses non-login behavior. `format_with_current_shell_display_non_login` calls it to make a printable string.

*Call graph*: calls 1 internal fn (default_user_shell); called by 1 (format_with_current_shell_display_non_login).


##### `format_with_current_shell_display_non_login`  (lines 377–381)

```
fn format_with_current_shell_display_non_login(command: &str) -> String
```

**Purpose**: Formats a non-login shell command and returns it as a readable string. This helps tests compare displayed commands without manually quoting arguments.

**Data flow**: It receives a command string, gets the non-login argument list from `format_with_current_shell_non_login`, quotes and joins the arguments, and returns the joined string.

**Call relations**: This is the display companion to `format_with_current_shell_non_login`, just as `format_with_current_shell_display` is for login-shell commands.

*Call graph*: calls 1 internal fn (format_with_current_shell_non_login); 1 external calls (try_join).


##### `stdio_server_bin`  (lines 383–385)

```
fn stdio_server_bin() -> Result<String, CargoBinError>
```

**Purpose**: Finds the test `test_stdio_server` binary and returns its path as text. Tests use that helper server when checking communication over standard input and output.

**Data flow**: It asks the Cargo binary helper for the `test_stdio_server` executable path, converts that path to a string, and returns it. If the binary cannot be found, it returns the lookup error.

**Call relations**: Tests that launch the stdio test server call this before spawning it. The actual binary discovery is delegated to the shared Cargo helper.

*Call graph*: 1 external calls (cargo_bin).


##### `fs_wait::wait_for_path_exists`  (lines 401–407)

```
async fn wait_for_path_exists(
        path: impl Into<PathBuf>,
        timeout: Duration,
    ) -> Result<PathBuf>
```

**Purpose**: Asynchronously waits for a specific file-system path to appear. This is useful when a test triggers another task to create a file or directory and needs to wait for it reliably.

**Data flow**: It receives a path-like value and a timeout. It converts the path into an owned `PathBuf`, runs the blocking file-wait logic on a background blocking task, and returns the found path or an error.

**Call relations**: Async tests call this public helper. It keeps blocking file-system watching out of the async runtime by handing the real work to `wait_for_path_exists_blocking` inside `spawn_blocking`.

*Call graph*: 2 external calls (into, spawn_blocking).


##### `fs_wait::wait_for_matching_file`  (lines 409–420)

```
async fn wait_for_matching_file(
        root: impl Into<PathBuf>,
        timeout: Duration,
        predicate: impl FnMut(&Path) -> bool + Send + 'static,
    ) -> Result<PathBuf>
```

**Purpose**: Asynchronously waits until some file under a root directory satisfies a test-provided condition. For example, a test can wait for the first log file whose name matches a pattern.

**Data flow**: It receives a root path, a timeout, and a predicate function for candidate file paths. It moves the work to a blocking task, waits for the root to exist, scans and watches for matching files, and returns the matching path or an error.

**Call relations**: Async tests call this when the exact file name may not be known up front. It delegates to `blocking_find_matching_file` so file-system watching does not block async execution.

*Call graph*: 2 external calls (into, spawn_blocking).


##### `fs_wait::wait_for_path_exists_blocking`  (lines 422–461)

```
fn wait_for_path_exists_blocking(path: PathBuf, timeout: Duration) -> Result<PathBuf>
```

**Purpose**: Waits in a blocking way for one exact path to exist. Blocking means the current thread waits, which is why async callers run it on a special blocking thread.

**Data flow**: It receives a path and timeout. If the path already exists, it returns immediately. Otherwise it finds the nearest existing parent, starts a file-system watcher there, and checks after each notification until the path appears or the deadline passes. It returns the path on success or a timeout/watcher error.

**Call relations**: `fs_wait::wait_for_path_exists` calls this from a blocking task, and `fs_wait::blocking_find_matching_file` uses it to make sure the root directory exists before scanning. It relies on `nearest_existing_ancestor` to choose a watchable starting point.

*Call graph*: 6 external calls (now, exists, anyhow!, nearest_existing_ancestor, channel, recommended_watcher).


##### `fs_wait::blocking_find_matching_file`  (lines 463–501)

```
fn blocking_find_matching_file(
        root: PathBuf,
        timeout: Duration,
        predicate: &mut impl FnMut(&Path) -> bool,
    ) -> Result<PathBuf>
```

**Purpose**: Searches and watches a directory tree until a file matching a predicate appears. It combines an immediate scan with live file-system notifications.

**Data flow**: It receives a root path, timeout, and mutable predicate. It first waits for the root path to exist, scans all files under it, and returns the first match if found. If not, it watches the tree recursively, rescanning after changes until a match appears or time runs out. It returns the matching file path or an error.

**Call relations**: `fs_wait::wait_for_matching_file` runs this inside a blocking task. It uses `wait_for_path_exists_blocking` before watching and `scan_for_match` both before and after notifications.

*Call graph*: 6 external calls (now, anyhow!, scan_for_match, wait_for_path_exists_blocking, channel, recommended_watcher).


##### `fs_wait::scan_for_match`  (lines 503–514)

```
fn scan_for_match(root: &Path, predicate: &mut impl FnMut(&Path) -> bool) -> Option<PathBuf>
```

**Purpose**: Walks through a directory tree and finds the first regular file accepted by a predicate. It is the simple scanning part used by the file-wait helpers.

**Data flow**: It receives a root directory and a mutable predicate. It walks every entry below the root, skips anything that is not a file, tests file paths with the predicate, and returns the first matching path. If no file matches, it returns nothing.

**Call relations**: `fs_wait::blocking_find_matching_file` calls this before setting up a watcher, after watcher events, and once more at the end. It does not watch for changes itself; it only scans the current state.

*Call graph*: 1 external calls (new).


##### `fs_wait::nearest_existing_ancestor`  (lines 516–527)

```
fn nearest_existing_ancestor(path: &Path) -> PathBuf
```

**Purpose**: Finds the closest existing parent path for a path that may not exist yet. File watchers need something real to watch, so this gives them a safe starting point.

**Data flow**: It receives a path and walks upward through its parents until it finds one that exists. If it reaches the top without finding one, it returns the current directory `.`. The output is a `PathBuf` for an existing or fallback watch root.

**Call relations**: `fs_wait::wait_for_path_exists_blocking` calls this before creating a file-system watcher. It makes waiting for not-yet-created paths possible by watching the nearest existing folder instead.

*Call graph*: 1 external calls (from).


### `core/src/test_support.rs`

`test` · `test setup and test execution`

This file is like a box of safe shortcuts for integration tests. Many tests need real-looking pieces of the Codex system: an authentication manager, a thread manager, model information, response metadata, or built-in model presets. Creating those through the normal production path would require more setup than a test cares about, and could make tests slow or brittle. This module gives tests direct, controlled ways to create those pieces.

It also contains a simple user-instructions provider, EmptyUserInstructionsProvider, which always says there are no saved user instructions. That is useful when a test wants to remove personal configuration from the equation and focus on one behavior.

Most functions here are thin wrappers around internal “for testing” constructors. The value of the file is not complex logic; it is controlled access. It lets cross-crate tests use private-ish setup paths without enabling separate build features or changing production behavior. It also provides stable offline model data, so tests do not need to contact a live service just to know what a model is. Finally, it can build Codex response metadata in the same shape production code expects, while letting tests choose whether the request is a normal turn, prewarm request, or websocket connection.

#### Function details

##### `EmptyUserInstructionsProvider::load_user_instructions`  (lines 53–55)

```
fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_>
```

**Purpose**: This returns an empty set of user instructions for tests. It is useful when a test needs a user-instructions provider but wants to make sure no real user preferences affect the result.

**Data flow**: It takes no meaningful input beyond the provider itself. It creates the default LoadedUserInstructions value, which means “nothing loaded,” wraps it in an asynchronous future, and returns that future to the caller.

**Call relations**: Tests can pass EmptyUserInstructionsProvider into code that expects a UserInstructionsProvider. When that code asks for instructions, this method answers immediately with an empty result instead of reading from a real source.

*Call graph*: 2 external calls (pin, default).


##### `set_thread_manager_test_mode`  (lines 58–60)

```
fn set_thread_manager_test_mode(enabled: bool)
```

**Purpose**: This turns the thread manager’s test mode on or off. Tests use it when they need the thread manager to behave in a more predictable or test-friendly way than it would in production.

**Data flow**: It receives a true-or-false flag. It passes that flag to the internal test-mode switch for the thread manager, changing global test behavior and returning nothing.

**Call relations**: A higher-level test helper, enable_deterministic_unified_exec_process_ids_for_tests, calls this as part of preparing a deterministic test environment. This function hands the request off to the thread manager’s internal test hook.

*Call graph*: calls 1 internal fn (set_thread_manager_test_mode_for_tests); called by 1 (enable_deterministic_unified_exec_process_ids_for_tests).


##### `set_deterministic_process_ids`  (lines 62–64)

```
fn set_deterministic_process_ids(enabled: bool)
```

**Purpose**: This tells the execution system whether to use predictable process IDs in tests. Predictable IDs make test output stable, so snapshots and assertions do not change from run to run.

**Data flow**: It receives a true-or-false flag. It forwards that flag to the unified execution test hook, which changes how process IDs are produced, and returns nothing.

**Call relations**: It is used by enable_deterministic_unified_exec_process_ids_for_tests when a test wants repeatable execution details. This function is the public test-support doorway into the lower-level execution setting.

*Call graph*: calls 1 internal fn (set_deterministic_process_ids_for_tests); called by 1 (enable_deterministic_unified_exec_process_ids_for_tests).


##### `auth_manager_from_auth`  (lines 66–68)

```
fn auth_manager_from_auth(auth: CodexAuth) -> Arc<AuthManager>
```

**Purpose**: This builds an AuthManager from a supplied CodexAuth value for tests. Tests use it to simulate a logged-in user or API-key setup without performing a real login flow.

**Data flow**: It receives a CodexAuth object containing the test authentication state. It gives that to the authentication module’s testing constructor and returns a shared AuthManager wrapped in Arc, which is a thread-safe shared pointer.

**Call relations**: Many integration tests call this when they need authentication available to model requests, remote control flows, configuration building, or provider calls. It delegates the actual construction to AuthManager::from_auth_for_testing.

*Call graph*: calls 1 internal fn (from_auth_for_testing); called by 25 (remote_control_auth_manager, remote_control_auth_manager, rewrite_mcp_tool_arguments_for_openai_files_surfaces_upload_failures, approve_mode_skips_guardian_in_every_permission_mode, build_from_config, responses_respects_model_info_overrides_from_config, azure_responses_request_includes_store_and_reasoning_ids, prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens, websocket_harness_with_provider_options, code_mode_can_call_standalone_web_search (+15 more)).


##### `auth_manager_from_auth_with_home`  (lines 70–72)

```
fn auth_manager_from_auth_with_home(auth: CodexAuth, codex_home: PathBuf) -> Arc<AuthManager>
```

**Purpose**: This builds a test AuthManager and pins it to a specific Codex home folder. That lets tests control where authentication-related files would live.

**Data flow**: It receives a CodexAuth value and a PathBuf pointing to the test Codex home directory. It passes both to the testing constructor and returns a shared AuthManager.

**Call relations**: remote_control_auth_manager_with_home calls this when a test needs both fake authentication and a controlled home directory. The function forwards the setup to AuthManager::from_auth_for_testing_with_home.

*Call graph*: calls 1 internal fn (from_auth_for_testing_with_home); called by 1 (remote_control_auth_manager_with_home).


##### `thread_manager_with_models_provider`  (lines 74–79)

```
fn thread_manager_with_models_provider(
    auth: CodexAuth,
    provider: ModelProviderInfo,
) -> ThreadManager
```

**Purpose**: This creates a ThreadManager for tests using a chosen model provider. Tests use it when they need to start or inspect Codex threads without relying on the default provider setup.

**Data flow**: It receives test authentication and model-provider information. It passes both into the ThreadManager testing constructor and returns a ready-to-use ThreadManager.

**Call relations**: Tests about warnings and model configuration call this to get a thread manager with known model behavior. The real setup work is handed to ThreadManager::with_models_provider_for_tests.

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

**Purpose**: This creates a test ThreadManager using a chosen model provider, a chosen Codex home directory, and an environment manager. It is useful when a test needs control over both model setup and the filesystem-like environment.

**Data flow**: It receives authentication, provider information, a home path, and a shared EnvironmentManager. It forwards those inputs to the ThreadManager testing constructor and returns the constructed ThreadManager.

**Call relations**: Tests around guardian review behavior, subagent activity, and turn snapshots call this when they need a more complete thread-manager setup. This function acts as the test-support bridge to ThreadManager::with_models_provider_and_home_for_tests.

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

**Purpose**: This creates a test ThreadManager with model provider settings, a Codex home directory, an environment manager, and an optional state database. Tests use it when they need to include or omit persistent state on purpose.

**Data flow**: It receives authentication, provider information, a home path, an EnvironmentManager, and optionally a StateDbHandle. It passes all of that to the ThreadManager testing constructor and returns the configured ThreadManager.

**Call relations**: This is the most configurable thread-manager constructor in this file. It hands setup off to ThreadManager::with_models_provider_home_and_state_for_tests for tests that need to exercise state-aware behavior.

*Call graph*: calls 1 internal fn (with_models_provider_home_and_state_for_tests).


##### `start_thread_with_user_shell_override`  (lines 111–119)

```
async fn start_thread_with_user_shell_override(
    thread_manager: &ThreadManager,
    config: Config,
    user_shell_override: crate::shell::Shell,
) -> codex_protocol::error::Result<crate::NewThrea
```

**Purpose**: This starts a new test thread while forcing the user shell to a specific value. A shell is the command-line program used to run commands, and overriding it lets tests avoid depending on the machine they run on.

**Data flow**: It receives a ThreadManager reference, a Config, and a Shell value chosen by the test. It asks the thread manager to start a thread with that shell override, waits for the asynchronous work to finish, and returns either a NewThread or an error.

**Call relations**: build_from_config calls this when a test needs to start a thread from configuration but with a controlled shell. This wrapper delegates to the thread manager’s test-only start method.

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

**Purpose**: This resumes a saved thread rollout in a test while forcing a specific user shell. It lets tests replay an existing conversation state without depending on the host computer’s default shell.

**Data flow**: It receives a ThreadManager, configuration, the path to a rollout file, an AuthManager, and the shell override. It asks the thread manager to resume the thread using those inputs, waits for completion, and returns a NewThread or an error.

**Call relations**: build_from_config calls this when testing resume behavior from a saved rollout. The function hands the real resume operation to ThreadManager::resume_thread_from_rollout_with_user_shell_override_for_tests.

*Call graph*: calls 1 internal fn (resume_thread_from_rollout_with_user_shell_override_for_tests); called by 1 (build_from_config).


##### `models_manager_with_provider`  (lines 138–145)

```
fn models_manager_with_provider(
    codex_home: PathBuf,
    auth_manager: Arc<AuthManager>,
    provider: ModelProviderInfo,
) -> SharedModelsManager
```

**Purpose**: This builds a shared models manager for tests using a specific model provider. A models manager is the component that knows what models are available and how they should be described.

**Data flow**: It receives a Codex home path, a shared AuthManager, and provider information. It first creates a model provider using the authentication manager, then asks that provider to create a models manager for the given home directory, and returns the shared manager.

**Call relations**: Many guardian and provider tests call this when they need realistic model lookup behavior without using the application’s normal startup path. It connects the external create_model_provider helper to the provider’s models_manager method.

*Call graph*: called by 24 (guardian_review_request_layout_matches_model_visible_request_snapshot, guardian_review_surfaces_responses_api_errors_in_rejection_reason, guardian_test_session_and_turn_with_base_url, guardian_test_session_turn_and_rx, approve_mode_skips_guardian_in_every_permission_mode, guardian_mode_mcp_denial_returns_rationale_message, guardian_mode_skips_auto_when_annotations_do_not_require_approval, guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, guardian_subagent_does_not_inherit_parent_exec_policy_rules, request_permissions_guardian_review_stops_when_cancelled (+14 more)); 2 external calls (create_model_provider, models_manager).


##### `get_model_offline`  (lines 147–149)

```
fn get_model_offline(model: Option<&str>) -> String
```

**Purpose**: This returns a model name suitable for offline tests. It keeps tests from needing a network call just to choose a model.

**Data flow**: It receives an optional model name. It passes that choice to the models-manager test helper, which either uses the requested model or picks an offline test default, then returns the model string.

**Call relations**: Tests for responses streams, Azure request details, and provider authentication call this when they need a stable model identifier. This function simply exposes get_model_offline_for_tests across crate boundaries.

*Call graph*: calls 1 internal fn (get_model_offline_for_tests); called by 4 (responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids, send_provider_auth_request).


##### `construct_model_info_offline`  (lines 151–153)

```
fn construct_model_info_offline(model: &str, config: &Config) -> ModelInfo
```

**Purpose**: This builds offline ModelInfo for a named model using the current test configuration. ModelInfo is the structured description of a model, such as its capabilities and settings.

**Data flow**: It receives a model name and a Config. It converts the Config into the form expected by the models manager, then asks the offline test helper to construct the ModelInfo, and returns that description.

**Call relations**: Tests that need exact model capability data call this before making response requests or checking instruction behavior. It bridges Config to construct_model_info_offline_for_tests.

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

**Purpose**: This builds Codex response metadata for tests. Metadata is the extra identifying information attached to a model request, such as session ID, thread ID, turn ID, and subagent details.

**Data flow**: It receives IDs, window information, session source, an optional parent thread ID, and a test request kind. It converts the test request kind into the production request kind, fills in turn and subagent fields only when appropriate, creates the base metadata, and returns the completed CodexResponsesMetadata value.

**Call relations**: test_responses_metadata_for_client calls this to produce metadata shaped like real client requests. Inside, it uses CodexResponsesMetadata::new for the base object and helper functions to derive subagent header and subagent kind from the session source.

*Call graph*: calls 2 internal fn (new, subagent_header_value); called by 1 (test_responses_metadata_for_client); 2 external calls (and, and_then).


##### `all_model_presets`  (lines 193–195)

```
fn all_model_presets() -> &'static Vec<ModelPreset>
```

**Purpose**: This returns the built-in model presets prepared for tests. Presets are ready-made model choices shown or used by the system.

**Data flow**: It takes no input. It returns a shared reference to a lazily initialized static list that was built from bundled model data, sorted by priority, converted into presets, and marked with the default picker visibility.

**Call relations**: Tests about model cache writing, visible models, service tiers, and default model selection call this when they need the same preset list every time. The expensive setup happens once in TEST_MODEL_PRESETS, and this function simply lends it out.

*Call graph*: called by 5 (write_models_cache, expected_visible_models, service_tier_model_and_tier_id, turn_start_sends_service_tier_id_to_model_request, bundled_default_model_slug).


##### `builtin_collaboration_mode_presets`  (lines 197–199)

```
fn builtin_collaboration_mode_presets() -> Vec<CollaborationModeMask>
```

**Purpose**: This returns the built-in collaboration mode presets for tests. Collaboration modes describe allowed combinations of how Codex can work with the user.

**Data flow**: It takes no input. It calls the collaboration-mode preset provider and returns the resulting list of CollaborationModeMask values.

**Call relations**: list_collaboration_modes_returns_presets calls this to compare API output against the built-in preset list. This function exposes the production preset source through the test-support module.

*Call graph*: calls 1 internal fn (builtin_collaboration_mode_presets); called by 1 (list_collaboration_modes_returns_presets).


### `core/tests/common/test_environment.rs`

`test` · `test setup`

Tests in this project can run in more than one place. Most run locally, but some run in a Docker container, and some run through Wine, which lets Linux run Windows-style programs. This file turns environment variables into a small, reliable description of that choice.

The central type is `TestEnvironment`, which has three possibilities: `Local`, `Docker`, or `WineExec`. Other test code can ask simple questions such as “is this remote?” or “what Docker container should I use?” without needing to know which environment variables were set.

The file also protects against bad setup. For example, Docker tests need a non-empty container name, and all names must be valid UTF-8 text. If the setup is invalid, the code fails early with a clear error instead of letting a later test fail in a confusing way.

One important detail is path style. A path inside Docker should look like a Unix path, while Wine uses Windows-style paths such as `C:/...`. The `remote_cwd` helper builds an isolated working directory for each test instance, like giving every test its own temporary desk so they do not bump into each other.

#### Function details

##### `TestEnvironment::is_remote`  (lines 20–22)

```
fn is_remote(&self) -> bool
```

**Purpose**: This answers whether the test environment is somewhere other than the local machine. It treats Docker and Wine execution as remote-style environments because tests need special path or execution setup there.

**Data flow**: It reads the current `TestEnvironment` value. If the value is `Local`, it returns `false`; for `Docker` or `WineExec`, it returns `true`. It does not change anything.

**Call relations**: This is used by `get_remote_test_env` after the full environment has been read. It acts as the simple yes-or-no filter that decides whether to return a remote test environment at all.

*Call graph*: 1 external calls (matches!).


##### `TestEnvironment::docker_container_name`  (lines 24–29)

```
fn docker_container_name(&self) -> Option<&str>
```

**Purpose**: This returns the Docker container name when the test environment is Docker. It lets callers get the container name without manually checking the enum themselves.

**Data flow**: It reads the current `TestEnvironment`. If it is `Docker`, it gives back the stored container name as text; if it is `Local` or `WineExec`, it gives back nothing. It does not modify the environment.

**Call relations**: This is a convenience method for test code that only needs Docker-specific information. It sits on top of the parsed environment choice and avoids spreading Docker pattern checks throughout the test helpers.


##### `TestEnvironment::remote_cwd`  (lines 31–47)

```
fn remote_cwd(&self, instance_id: &str) -> Result<Option<LegacyAppPathString>>
```

**Purpose**: This builds the working directory path that a remote-style test should use. It returns no path for local tests, but gives Docker and Wine tests an isolated directory name based on the test instance ID.

**Data flow**: It takes the current environment and an `instance_id`. For local tests, it immediately returns `None`. For Docker, it creates a Unix-style file URI under `/tmp`; for Wine, it creates a Windows-style file URI under `C:/`. It then converts that URI into the path string format expected by the application, using the environment’s path convention, and returns it wrapped in `Some`.

**Call relations**: When test setup needs a current working directory for a remote run, it calls this method. The method asks `TestEnvironment::path_convention` which path style to use, then hands the URI to path conversion utilities so the result matches what the tested code expects.

*Call graph*: calls 3 internal fn (path_convention, parse, from_path_uri); 1 external calls (format!).


##### `TestEnvironment::path_convention`  (lines 49–55)

```
fn path_convention(&self) -> PathConvention
```

**Purpose**: This tells the rest of the test code which path style belongs to the current environment. Local tests use the machine’s native style, Docker uses Unix-style paths, and Wine uses Windows-style paths.

**Data flow**: It reads the `TestEnvironment` value and returns a `PathConvention`, which is a small description of how file paths should look. Nothing is changed; it only translates an environment choice into a path-format choice.

**Call relations**: This is called by `TestEnvironment::remote_cwd` when building a remote working directory path. It supplies the path rules needed before the path URI can be converted into the application’s legacy path string format.

*Call graph*: calls 1 internal fn (native); called by 1 (remote_cwd).


##### `test_environment`  (lines 58–71)

```
fn test_environment() -> TestEnvironment
```

**Purpose**: This is the main public way for tests to find out which environment they should run in. It reads the relevant environment variables, validates them, and returns a `TestEnvironment` value.

**Data flow**: It reads three operating-system environment variables: the main test environment setting, the older remote-environment setting, and the Docker container name setting. It passes those raw values to `parse_test_environment`. If parsing succeeds, it checks one extra rule: `wine-exec` is only allowed on Linux. It returns the final environment or stops the test run with a clear failure if the setup is invalid.

**Call relations**: This is the front door for environment detection. `get_remote_test_env` calls it when it wants the same information but only cares about remote environments. Internally, it delegates the detailed interpretation of environment variables to `parse_test_environment`.

*Call graph*: calls 1 internal fn (parse_test_environment); called by 1 (get_remote_test_env); 4 external calls (cfg!, matches!, panic!, var_os).


##### `get_remote_test_env`  (lines 73–76)

```
fn get_remote_test_env() -> Option<TestEnvironment>
```

**Purpose**: This returns the current test environment only if it is remote-style, meaning Docker or Wine. It is useful for code that should do extra setup only when tests are not purely local.

**Data flow**: It first calls `test_environment` to get the validated environment. Then it asks that environment whether it is remote. If yes, it returns the environment inside `Some`; if no, it returns `None`.

**Call relations**: This is a small wrapper around `test_environment`. It relies on `TestEnvironment::is_remote` to decide whether the parsed environment should be passed along or ignored.

*Call graph*: calls 1 internal fn (test_environment).


##### `parse_test_environment`  (lines 78–120)

```
fn parse_test_environment(
    configured_environment: Option<&OsStr>,
    legacy_remote_environment: Option<&OsStr>,
    docker_container: Option<&OsStr>,
) -> Result<TestEnvironment, String>
```

**Purpose**: This turns raw environment-variable values into a valid `TestEnvironment`. It contains the rules for modern and legacy configuration, including how Docker container names are found.

**Data flow**: It receives optional raw operating-system strings for the configured environment, the legacy remote setting, and the Docker container setting. It first makes sure the main environment value, if present, is valid UTF-8 text. Then it chooses the environment: missing means local unless the legacy remote variable is present; `local` means local; `docker` means Docker and requires a non-empty container name; `wine-exec` means Wine. If anything is invalid or unsupported, it returns an error message.

**Call relations**: This is called by `test_environment` after the raw environment variables are read. Whenever it needs to validate a container name, it hands that value to `non_empty_utf8`, so the detailed text checks stay in one helper.

*Call graph*: calls 1 internal fn (non_empty_utf8); called by 1 (test_environment); 1 external calls (format!).


##### `non_empty_utf8`  (lines 122–130)

```
fn non_empty_utf8(name: &str, value: &OsStr) -> Result<String, String>
```

**Purpose**: This checks that an environment-variable value is usable text and not blank. It gives clear error messages naming the variable that caused the problem.

**Data flow**: It receives the variable name and its raw operating-system value. It tries to convert the value to UTF-8 text, trims whitespace to check whether anything meaningful remains, and then returns the original text as a `String`. If the value is not valid text or is empty after trimming, it returns an error message.

**Call relations**: This is used by `parse_test_environment` when reading Docker container names from either the current or legacy environment variable. It acts as the final gatekeeper before a container name is stored in `TestEnvironment::Docker`.

*Call graph*: called by 1 (parse_test_environment); 4 external calls (to_str, to_string, trim, format!).


### `core/tests/common/hooks.rs`

`test` · `test setup`

Codex hooks are small pieces of extra behavior that can be discovered from configuration or the filesystem. Because hooks can run code, the system tracks whether each hook is trusted, using a stored hash of its current contents. In normal use, that protects people from silently running changed or unexpected hook code. In tests, though, that safety check can get in the way: a test fixture hook may be correctly present, but still need to be marked trusted before the feature under test can proceed.

This file provides shared helpers for tests that need that setup. It can turn on the hooks feature for a test `Config`, ask the hooks system which hooks are currently visible, and then write trust records for those hooks into the user configuration layer. Think of it like stamping each discovered hook with an “approved as of this exact version” label.

The important detail is that it does not write a real user config file directly. Instead, it builds a new `ConfigLayerStack`, which is the layered view of settings used by Codex, and replaces the test config’s stack with one whose user layer contains `hooks.state.<hook>.trusted_hash`. That keeps tests realistic while still staying contained inside the test configuration.

#### Function details

##### `trust_discovered_hooks`  (lines 9–25)

```
fn trust_discovered_hooks(config: &mut Config)
```

**Purpose**: Turns on the hooks feature in a test configuration, discovers the hooks that are currently available, and marks all of them as trusted. Tests use this when they want hook behavior enabled without being blocked by trust checks.

**Data flow**: It receives a mutable test `Config`. First it enables the `CodexHooks` feature flag, then asks the hooks library to list hooks using the config’s current layer stack. If no hooks are found, it stops the test with an assertion because the fixture setup is not what the test expected. If hooks are found, it passes the list onward so the config can be rewritten with trust records.

**Call relations**: Higher-level test setup code, such as `configure` and `enable_hooks_and_rmcp_server`, calls this when a test needs hooks to be active and pre-approved. After discovery, it hands the actual trust-writing work to `trust_hooks`, keeping this function focused on “find what needs trusting first.”

*Call graph*: calls 1 internal fn (trust_hooks); called by 2 (configure, enable_hooks_and_rmcp_server); 3 external calls (assert!, list_hooks, default).


##### `trust_hooks`  (lines 27–30)

```
fn trust_hooks(config: &mut Config, hooks: Vec<HookListEntry>)
```

**Purpose**: Marks a supplied list of hooks as trusted inside a mutable test configuration. Use this when a test already knows which hooks should be approved.

**Data flow**: It takes the current `Config` and a list of `HookListEntry` values, where each entry includes a hook key and its current hash. It builds a replacement configuration layer stack that contains those trust records, then stores that new stack back into the config. The main visible change is that later hook checks see those hooks as trusted.

**Call relations**: It is called by `trust_discovered_hooks` after hooks have been found automatically, and by other test helpers such as `trust_plugin_hooks` when the hook list is already known. It delegates the careful editing of the layered configuration data to `trusted_config_layer_stack`.

*Call graph*: calls 1 internal fn (trusted_config_layer_stack); called by 2 (trust_discovered_hooks, trust_plugin_hooks).


##### `trusted_config_layer_stack`  (lines 32–67)

```
fn trusted_config_layer_stack(
    config_layer_stack: &ConfigLayerStack,
    codex_home: &AbsolutePathBuf,
    hooks: Vec<HookListEntry>,
) -> ConfigLayerStack
```

**Purpose**: Creates a new configuration layer stack whose user config says that the given hooks are trusted. This is the low-level helper that writes the trust information into the same shape the real config system expects.

**Data flow**: It starts with an existing `ConfigLayerStack`, the Codex home directory, and a list of hooks. It copies the active user config if one exists, or starts with an empty TOML table if not. Then it makes sure the nested `hooks.state` tables exist, and for each hook stores its `current_hash` under `trusted_hash`. Finally it returns a new layer stack with that updated user config attached at the normal config file path under the test Codex home.

**Call relations**: This function is used whenever a test helper needs the exact config-layer rewrite rather than just a simple flag change. `trust_hooks` uses it for general hook approval, and `install_mcp_permission_request_hook` uses it when installing and trusting a specific hook. It relies on the config stack’s own methods to read the active user layer and produce a modified stack, so the result still behaves like normal Codex configuration.

*Call graph*: calls 3 internal fn (get_active_user_layer, with_user_config, join); called by 2 (install_mcp_permission_request_hook, trust_hooks); 3 external calls (default, String, Table).


### `core/tests/common/tracing.rs`

`test` · `test setup`

Modern systems often attach a trace ID to a piece of work, so logs and events from different parts of the program can be tied back to the same original action. This file sets up that tracing machinery for tests. Without it, tests that check whether trace information is captured, inherited, or sent along would not have a real tracing environment to run inside.

The main helper, `install_test_tracing`, prepares two things. First, it installs a W3C trace context propagator. In plain terms, that is the standard rulebook for how trace IDs are packed into and read from text-based metadata, such as request headers. Second, it creates an OpenTelemetry tracer provider and connects it to Rust's `tracing` system through a subscriber. A subscriber is the part that listens for tracing spans and events, like a microphone listening to what the code says it is doing.

The returned `TestTracingContext` keeps the tracing provider and the default subscriber guard alive. This matters because the tracing setup is scoped: when the returned value is dropped, the default subscriber guard is dropped too, which ends that test's tracing setup. This keeps tests from leaking tracing state more than necessary.

#### Function details

##### `install_test_tracing`  (lines 14–26)

```
fn install_test_tracing(tracer_name: &str) -> TestTracingContext
```

**Purpose**: This function turns on a test tracing environment with the given tracer name. Tests use it when they need spans, trace IDs, and trace-context propagation to behave like they would in a real instrumented run.

**Data flow**: It takes a `tracer_name`, which is a label for the tracer being created. It installs the standard trace-context propagator, builds a tracer provider, creates a tracer from that provider, and connects that tracer to the current `tracing` subscriber. It returns a `TestTracingContext`, which keeps the provider and the active default-subscriber guard alive for as long as the test needs them.

**Call relations**: Several tracing-focused tests call this at the start of their scenario, before they create spans, submit work, or check trace payloads. Inside, it relies on OpenTelemetry and tracing-subscriber setup helpers to build the provider, create the propagation rulebook, create the tracing layer, and make the subscriber the default for the current scope.

*Call graph*: called by 8 (new_default_turn_captures_current_span_trace_id, regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm, spawn_task_turn_span_inherits_dispatch_trace_context, submission_dispatch_span_prefers_submission_trace_context, submission_dispatch_span_uses_debug_for_realtime_audio, submit_with_id_captures_current_span_trace_context, responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_reuses_connection_with_per_turn_trace_payloads); 5 external calls (builder, new, set_text_map_propagator, layer, registry).


### `core/tests/common/process.rs`

`test` · `test execution`

Some tests in this project start a real operating-system process, then need to observe it from the outside. That can be fragile: the test may look for the process before it has written its process ID file, or it may check for shutdown before the operating system has fully removed it. This file provides small waiting helpers to make those checks reliable.

The first helper waits until a PID file appears and contains text. A PID is a process ID, the number the operating system uses to identify a running program. The helper keeps checking the file every few milliseconds, but gives up after two seconds so a broken test does not hang forever.

The second helper asks the operating system whether a process is still alive. It does this with `kill -0`, a common Unix-style probe that does not actually kill the process; it only checks whether the process can be signaled.

The final helpers wait for a process to disappear, again polling briefly and using a two-second timeout. Together, these functions act like a cautious observer: wait for the note saying “the process is here,” then later keep checking until the process is gone.

#### Function details

##### `wait_for_pid_file`  (lines 6–22)

```
async fn wait_for_pid_file(path: &Path) -> anyhow::Result<String>
```

**Purpose**: Waits for a file to contain a process ID and returns that ID as text. Tests use it after starting a background process, so they do not continue until the process has announced itself.

**Data flow**: It receives a file path. It repeatedly tries to read that file, trims whitespace from the contents, and accepts the first non-empty value it finds. If that happens within two seconds, it returns the process ID string; if not, it returns an error explaining that waiting for the PID file timed out.

**Call relations**: The long-running session tests call this after launching a process that writes its PID to disk. Inside, it relies on file reading and short asynchronous sleeps so the test can wait patiently without blocking everything else.

*Call graph*: called by 2 (unified_exec_interrupt_preserves_long_running_session, unified_exec_keeps_long_running_session_after_turn_end); 5 external calls (from_millis, from_secs, read_to_string, sleep, timeout).


##### `process_is_alive`  (lines 24–30)

```
fn process_is_alive(pid: &str) -> anyhow::Result<bool>
```

**Purpose**: Checks whether a process with a given process ID still appears to be running. It is a small wrapper around the operating system’s process-probing behavior.

**Data flow**: It receives a process ID as text. It runs `kill -0 <pid>`, which asks the operating system whether that process can be signaled without sending a real signal. It returns `true` if the command succeeds, `false` if the process is not considered alive, or an error if the probe command itself could not be run.

**Call relations**: This function is called by `wait_for_process_exit_inner` during repeated shutdown checks. It provides the yes-or-no answer that lets the waiting loop decide whether to keep sleeping or finish.

*Call graph*: called by 1 (wait_for_process_exit_inner); 1 external calls (new).


##### `wait_for_process_exit_inner`  (lines 32–39)

```
async fn wait_for_process_exit_inner(pid: String) -> anyhow::Result<()>
```

**Purpose**: Repeatedly checks a process until it is no longer alive. This is the core polling loop used when a test expects a background process to stop.

**Data flow**: It receives a process ID string. In a loop, it asks `process_is_alive` whether that process still exists. If the process is gone, it returns success; otherwise, it waits 25 milliseconds and checks again.

**Call relations**: This helper is called by `wait_for_process_exit`, which wraps it in a timeout. It delegates the actual liveness check to `process_is_alive`, keeping this function focused on the wait-and-retry pattern.

*Call graph*: calls 1 internal fn (process_is_alive); called by 1 (wait_for_process_exit); 2 external calls (from_millis, sleep).


##### `wait_for_process_exit`  (lines 41–48)

```
async fn wait_for_process_exit(pid: &str) -> anyhow::Result<()>
```

**Purpose**: Waits for a process to exit, but only for a limited time. Tests use it to confirm that a process ended without risking an endless wait if something goes wrong.

**Data flow**: It receives a process ID as borrowed text, copies it into an owned string for the asynchronous wait, and runs the inner waiting loop. If the process exits within two seconds, it returns success; if the timeout is reached or the inner check fails, it returns an error.

**Call relations**: The long-running session tests call this when they expect a launched process to be gone. It hands the repeated checking work to `wait_for_process_exit_inner` and adds the safety guard of a two-second timeout around it.

*Call graph*: calls 1 internal fn (wait_for_process_exit_inner); called by 2 (unified_exec_interrupt_preserves_long_running_session, unified_exec_keeps_long_running_session_after_turn_end); 2 external calls (from_secs, timeout).


### Transport and mock servers
These files supply reusable mock HTTP/SSE infrastructure and fake external services that underpin end-to-end request and streaming tests.

### `core/tests/common/apps_test_server.rs`

`test` · `test setup and fake request handling`

This test helper gives the rest of the test suite a small, predictable “app store and app server” to talk to. Without it, tests for Codex Apps would need real ChatGPT connector services, real OAuth metadata, and real tool responses, which would make them slow, fragile, and hard to run offline.

The file sets up a wiremock server, which is a pretend HTTP server used in tests. It teaches that server to answer a few important routes: OAuth discovery information, a connectors directory, and the main Codex Apps endpoint. The main endpoint speaks JSON-RPC, a request-and-response format where each message names a method such as “initialize”, “tools/list”, or “tools/call”.

The fake app is mostly a calendar connector. It can advertise tools like creating an event, listing events, or extracting text from an uploaded document. Some setup modes make the tools “searchable”, meaning tests can check behavior when there are many tools and the system must find the right one by search. Another mode adds an “app-only” tool, used to verify that tools meant only for a visual app surface are not exposed to code-mode models.

The file also provides small helpers for configuring test Codex instances and for inspecting which fake tool calls were actually sent.

#### Function details

##### `AppsTestServer::mount`  (lines 62–64)

```
async fn mount(server: &MockServer) -> Result<Self>
```

**Purpose**: Starts the standard fake Apps server using the default Calendar connector name. Tests use this when they need the normal calendar app behavior without special variations.

**Data flow**: It receives a mock server that already exists. It passes that server and the default connector name into the more general setup path. It returns an AppsTestServer containing the mock server’s base URL, so test Codex instances know where to send app requests.

**Call relations**: This is the simple entry point used by many tests that need Apps enabled. It delegates the real setup to AppsTestServer::mount_with_connector_name, so all the OAuth, directory, and JSON-RPC routes are installed in one shared way.

*Call graph*: called by 12 (includes_apps_guidance_as_developer_message_for_chatgpt_auth, omits_apps_guidance_for_api_key_auth_even_when_feature_enabled, omits_apps_guidance_when_configured_off, approved_mcp_tool_call_metadata_records_prior_user_input_request, apps_default_auto_review_routes_actual_mcp_approval_to_guardian, mcp_tool_call_metadata_records_prior_request_user_input_tool, codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook, codex_apps_file_params_upload_environment_files_before_mcp_tool_call, request_plugin_install_is_available_without_search_tool_after_discovery_attempts, always_defer_feature_hides_small_app_tool_sets (+2 more)); 1 external calls (mount_with_connector_name).


##### `AppsTestServer::mount_searchable`  (lines 66–80)

```
async fn mount_searchable(server: &MockServer) -> Result<Self>
```

**Purpose**: Starts a fake Apps server whose calendar tools are meant to be found through tool search. Tests use it to check behavior when the model should search for tools instead of seeing every tool directly.

**Data flow**: It takes a mock server, mounts OAuth metadata, mounts the connectors directory, then mounts the fake JSON-RPC app endpoint with the searchable option turned on and app-only tools turned off. It returns the server wrapper with the base URL for later configuration.

**Call relations**: Search-related tests call this when they need a large searchable tool set. It hands setup work to mount_oauth_metadata, mount_connectors_directory, and mount_streamable_http_json_rpc, then exposes the resulting server URL to the test.

*Call graph*: calls 3 internal fn (mount_connectors_directory, mount_oauth_metadata, mount_streamable_http_json_rpc); called by 9 (code_mode_only_guides_all_tools_search_and_calls_deferred_app_tools, search_tool_adds_discovery_instructions_to_tool_description, search_tool_enabled_by_default_adds_tool_search, search_tool_hides_apps_tools_without_search, tool_search_indexes_only_enabled_non_app_mcp_tools, tool_search_matches_mcp_tools_by_distinct_name_description_and_schema_terms, tool_search_returns_deferred_tools_without_follow_up_tool_injection, tool_search_surfaced_mcp_tool_errors_are_returned_to_model, tool_search_uses_non_app_mcp_server_instructions_as_namespace_description); 1 external calls (uri).


##### `AppsTestServer::mount_with_connector_name`  (lines 82–99)

```
async fn mount_with_connector_name(
        server: &MockServer,
        connector_name: &str,
    ) -> Result<Self>
```

**Purpose**: Starts the fake Apps server while allowing a test to choose the connector’s display name. This is useful for tests that check how connector names appear in prompts or conflict resolution.

**Data flow**: It receives a mock server and a connector name string. It installs the OAuth route, connector directory routes, and JSON-RPC app route using that name and the standard calendar description. It returns an AppsTestServer pointing at the mock server’s URL.

**Call relations**: The default mount path calls this with the normal Calendar name, while some tests call it directly with a custom name. It uses the shared mounting helpers so the only changed piece is the human-visible connector name.

*Call graph*: calls 3 internal fn (mount_connectors_directory, mount_oauth_metadata, mount_streamable_http_json_rpc); called by 3 (capability_sections_render_in_developer_message_in_order, explicit_plugin_mentions_keep_non_conflicting_mcp_for_chatgpt_auth, explicit_plugin_mentions_use_apps_for_chatgpt_dual_surface_plugins); 1 external calls (uri).


##### `AppsTestServer::mount_with_app_only_tool`  (lines 101–118)

```
async fn mount_with_app_only_tool(
        server: &MockServer,
        tool_loading: AppsTestToolLoading,
    ) -> Result<Self>
```

**Purpose**: Starts the fake Apps server with an extra tool that should only be visible inside the app user interface. Tests use this to make sure such tools are hidden from model-facing tool lists and cannot be called directly by mistake.

**Data flow**: It receives a mock server and a choice of direct versus searchable loading. It mounts the standard fake routes, tells the JSON-RPC responder whether to make tools searchable, and asks it to include the app-only tool. It returns the server wrapper with the mock server URL.

**Call relations**: App-only visibility tests call this setup path. It relies on the same route-mounting helpers as the other setup methods, but passes a flag into mount_streamable_http_json_rpc so the responder advertises the special app-only tool.

*Call graph*: calls 3 internal fn (mount_connectors_directory, mount_oauth_metadata, mount_streamable_http_json_rpc); called by 2 (app_only_tools_are_not_visible_or_runnable_by_code_mode_model, app_only_tools_are_not_visible_or_runnable_by_direct_model_calls); 2 external calls (uri, matches!).


##### `configure_search_capable_model`  (lines 121–131)

```
fn configure_search_capable_model(config: &mut Config)
```

**Purpose**: Changes a test configuration so it uses a model that is marked as able to use tool search. This lets tests exercise search behavior even if the default model catalog would not allow it.

**Data flow**: It receives a mutable Config. It loads the bundled model catalog, finds the gpt-5.4 model, marks that model as supporting the search tool, sets the config’s selected model to gpt-5.4, and stores the modified catalog back into the config.

**Call relations**: configure_search_capable_apps calls this after enabling Apps. It depends on the bundled model list and intentionally edits it for tests, so downstream test Codex instances believe they are using a search-capable model.

*Call graph*: called by 1 (configure_search_capable_apps); 1 external calls (bundled_models_response).


##### `configure_apps`  (lines 133–139)

```
fn configure_apps(config: &mut Config, apps_base_url: &str)
```

**Purpose**: Turns on the Apps feature in a test configuration and points it at the fake Apps server. This is the basic switch that makes Codex talk to the test server instead of a real service.

**Data flow**: It receives a mutable Config and a base URL string. It enables the Apps feature flag and stores the fake server URL as the ChatGPT base URL. The config is changed in place and no separate value is returned.

**Call relations**: This private helper is used by both normal and search-capable test setup. configure_search_capable_apps builds on it, while apps_enabled_builder installs it into a TestCodexBuilder callback.

*Call graph*: called by 1 (configure_search_capable_apps).


##### `configure_search_capable_apps`  (lines 141–144)

```
fn configure_search_capable_apps(config: &mut Config, apps_base_url: &str)
```

**Purpose**: Prepares a test configuration for Apps plus tool search. It combines the fake Apps server settings with a model configuration that allows search.

**Data flow**: It receives a mutable Config and the fake Apps server URL. First it enables Apps and sets the base URL. Then it edits the model catalog so the selected model supports search. The Config is updated in place.

**Call relations**: search_capable_apps_builder uses this as its configuration callback. It is a small orchestration helper that chains configure_apps and configure_search_capable_model in the order tests need.

*Call graph*: calls 2 internal fn (configure_apps, configure_search_capable_model).


##### `apps_enabled_builder`  (lines 146–151)

```
fn apps_enabled_builder(apps_base_url: impl Into<String>) -> TestCodexBuilder
```

**Purpose**: Creates a TestCodexBuilder for tests that need Apps enabled with fake ChatGPT authentication. It saves test authors from repeating the same authentication and configuration setup.

**Data flow**: It receives an Apps base URL, converts it into an owned string, starts from the standard test_codex builder, attaches dummy ChatGPT authentication, and registers a config callback that enables Apps and points them at that URL. It returns the prepared builder.

**Call relations**: Tests that only need normal Apps behavior call this before creating a test Codex instance. Internally it uses test_codex as the base, creates dummy ChatGPT auth, and hands configuration changes to configure_apps.

*Call graph*: calls 2 internal fn (test_codex, create_dummy_chatgpt_auth_for_testing); called by 3 (codex_apps_file_params_pass_uploaded_file_to_post_tool_use_hook, codex_apps_file_params_upload_environment_files_before_mcp_tool_call, app_only_tools_are_not_visible_or_runnable_by_direct_model_calls); 1 external calls (into).


##### `search_capable_apps_builder`  (lines 153–158)

```
fn search_capable_apps_builder(apps_base_url: impl Into<String>) -> TestCodexBuilder
```

**Purpose**: Creates a TestCodexBuilder for tests that need Apps and tool search at the same time. It is the search-enabled version of apps_enabled_builder.

**Data flow**: It receives the fake Apps server URL, stores it as an owned string, starts a standard test Codex builder, adds dummy ChatGPT authentication, and registers a config callback that enables Apps and marks the model as search-capable. It returns the prepared builder.

**Call relations**: Many search and deferred-tool tests call this to get a Codex instance with the right feature flags, authentication, server URL, and model catalog. It hands the detailed config edits to configure_search_capable_apps.

*Call graph*: calls 2 internal fn (test_codex, create_dummy_chatgpt_auth_for_testing); called by 14 (app_only_tools_are_not_visible_or_runnable_by_code_mode_model, approved_mcp_tool_call_metadata_records_prior_user_input_request, apps_default_auto_review_routes_actual_mcp_approval_to_guardian, mcp_tool_call_metadata_records_prior_request_user_input_tool, always_defer_feature_hides_small_app_tool_sets, explicit_app_mentions_respect_always_defer, search_tool_adds_discovery_instructions_to_tool_description, search_tool_enabled_by_default_adds_tool_search, search_tool_hides_apps_tools_without_search, tool_search_indexes_only_enabled_non_app_mcp_tools (+4 more)); 1 external calls (into).


##### `apps_tool_call_id`  (lines 160–166)

```
fn apps_tool_call_id(body: &Value) -> Option<&str>
```

**Purpose**: Pulls the Codex Apps call ID out of a recorded JSON tool-call request. Tests use that call ID to match a specific model-side tool call with the HTTP request sent to the fake server.

**Data flow**: It receives a JSON value representing a request body. It walks through params, then _meta, then the _codex_apps metadata, then call_id. If that field exists and is a string, it returns it; otherwise it returns nothing.

**Call relations**: This is a small inspection helper for the request-recording checks. recorded_apps_tool_call_by_call_id uses this kind of extraction when narrowing the recorded fake-server traffic down to the one request a test expects.

*Call graph*: 1 external calls (get).


##### `recorded_apps_tool_calls`  (lines 168–181)

```
async fn recorded_apps_tool_calls(server: &MockServer) -> Vec<Value>
```

**Purpose**: Collects all Apps tool-call requests that the fake server received. This lets tests verify what Codex actually sent over HTTP after a tool was approved or invoked.

**Data flow**: It asks the mock server for every recorded request. For each one, it tries to parse the body as JSON, keeps only requests sent to /api/codex/apps with method tools/call, and returns those JSON bodies as a list.

**Call relations**: The more specific lookup helpers call this first, then filter the returned list by call ID or tool name. It is the broad “show me all app tool calls” inspection point for tests.

*Call graph*: called by 2 (recorded_apps_tool_call_by_call_id, recorded_apps_tool_call_by_name); 1 external calls (received_requests).


##### `recorded_apps_tool_call_by_call_id`  (lines 183–198)

```
async fn recorded_apps_tool_call_by_call_id(server: &MockServer, call_id: &str) -> Value
```

**Purpose**: Finds exactly one recorded Apps tool call with a given call ID. It fails the test if there are none or more than one, which catches missing calls and duplicate calls.

**Data flow**: It receives the mock server and the expected call ID. It gathers all recorded Apps tool calls, keeps only the ones whose metadata call_id matches, asserts there is exactly one, and returns that matching JSON body.

**Call relations**: Tests that track approval metadata or prior user input call this after exercising Codex. It builds on recorded_apps_tool_calls and uses the call ID extraction logic to prove the right HTTP request was made.

*Call graph*: calls 1 internal fn (recorded_apps_tool_calls); called by 4 (approved_mcp_tool_call_metadata_records_prior_user_input_request, apps_default_auto_review_routes_actual_mcp_approval_to_guardian, mcp_tool_call_metadata_records_prior_request_user_input_tool, tool_search_returns_deferred_tools_without_follow_up_tool_injection); 1 external calls (assert_eq!).


##### `recorded_apps_tool_call_by_name`  (lines 200–215)

```
async fn recorded_apps_tool_call_by_name(server: &MockServer, tool_name: &str) -> Value
```

**Purpose**: Finds exactly one recorded Apps tool call for a given tool name. This is useful when a test cares which tool was invoked, not which internal call ID was used.

**Data flow**: It receives the mock server and a tool name. It gathers all recorded Apps tool-call JSON bodies, filters them by params.name, asserts that exactly one remains, and returns that request body.

**Call relations**: File-upload related tests use this to inspect the request sent for a particular tool. It reuses recorded_apps_tool_calls for the broad collection step, then applies the tool-name check.

*Call graph*: calls 1 internal fn (recorded_apps_tool_calls); called by 1 (codex_apps_file_params_upload_environment_files_before_mcp_tool_call); 1 external calls (assert_eq!).


##### `mount_oauth_metadata`  (lines 217–227)

```
async fn mount_oauth_metadata(server: &MockServer)
```

**Purpose**: Adds a fake OAuth discovery endpoint to the mock server. OAuth is the login and permission system; this endpoint tells clients where authorization and token URLs would be.

**Data flow**: It receives the mock server. It registers a GET response for the well-known OAuth metadata path, returning JSON with authorization and token endpoints based on the mock server’s own URL. It changes the server by adding that route.

**Call relations**: All Apps server setup paths call this before tests talk to the fake server. It gives Codex enough login metadata to proceed as if a real ChatGPT Apps service had advertised OAuth support.

*Call graph*: called by 3 (mount_searchable, mount_with_app_only_tool, mount_with_connector_name); 5 external calls (given, new, json!, method, path).


##### `mount_connectors_directory`  (lines 229–258)

```
async fn mount_connectors_directory(server: &MockServer)
```

**Purpose**: Adds fake connector-directory endpoints to the mock server. These endpoints act like a small app catalog, listing discoverable apps such as Google Calendar and Gmail.

**Data flow**: It receives the mock server. It registers one GET route that returns two public apps and another workspace-list route that returns no apps. The mock server is updated so later requests to those paths get predictable JSON.

**Call relations**: Every Apps mounting path calls this as part of test setup. Tests that check app discovery or connector guidance rely on these directory responses being stable.

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

**Purpose**: Adds the main fake Codex Apps JSON-RPC endpoint to the mock server. This is where initialization, tool listing, and tool calls are answered during tests.

**Data flow**: It receives the mock server, connector display information, and flags for searchable and app-only behavior. It registers a POST route for /api/codex/apps and attaches a CodexAppsJsonRpcResponder containing those settings. The server is then ready to answer app protocol requests.

**Call relations**: The different AppsTestServer mounting methods call this after installing OAuth and directory routes. It hands actual request decisions to CodexAppsJsonRpcResponder::respond, which builds the JSON-RPC responses.

*Call graph*: called by 3 (mount_searchable, mount_with_app_only_tool, mount_with_connector_name); 3 external calls (given, method, path_regex).


##### `CodexAppsJsonRpcResponder::respond`  (lines 287–527)

```
fn respond(&self, request: &Request) -> ResponseTemplate
```

**Purpose**: Builds fake JSON-RPC responses for the Codex Apps endpoint. It lets tests exercise the same kinds of messages a real Apps server would send, but with fixed calendar-focused data.

**Data flow**: It receives an HTTP request from the mock server. It parses the body as JSON, checks the method field, and returns a response: initialization metadata, an accepted notification, a list of tools, a successful tool-call result, a generic notification acknowledgement, or a JSON-RPC “method not found” error. If the body is not valid JSON or has no method, it returns a bad-request response.

**Call relations**: mount_streamable_http_json_rpc installs this responder on the fake Apps endpoint. During tests, Codex sends POST requests there, and this method supplies the protocol-level answers that drive app discovery, tool listing, and tool-call verification.

*Call graph*: 3 external calls (new, json!, from_slice).


### `core/tests/common/context_snapshot.rs`

`test` · `test assertion and snapshot comparison`

Tests often need to compare what the system sent to the model. Raw JSON is hard to read and contains unstable details like temporary paths, timestamps, UUIDs (random-looking unique IDs), and long instruction blocks. This file acts like a camera with filters: it takes a snapshot of request items, labels each item clearly, and replaces distracting or private details with simple placeholders such as `<AGENTS_MD>` or `<UUID>`.

The main options let tests choose how much text to show. They can keep redacted text, show full text, show only the kind of each item, or show only a short prefix. The formatter understands common item types: user/developer messages, function calls, shell commands, reasoning summaries, and compaction records. For messages with multiple parts, such as text plus an image, it prints each part separately so the shape of the request remains visible.

The file also formats whole request bodies and produces compact diffs that show only changed JSON lines. Before printing JSON, it sorts object keys and normalizes strings so output is consistent across machines and runs. Without this helper, snapshot tests would be noisy, fragile, and much harder for humans to inspect.

#### Function details

##### `ContextSnapshotOptions::default`  (lines 31–37)

```
fn default() -> Self
```

**Purpose**: Creates the standard snapshot settings used by most tests. By default, text is redacted into stable placeholders, and no optional instruction blocks are stripped out.

**Data flow**: It takes no input. It builds a `ContextSnapshotOptions` value with redacted-text rendering and both stripping switches turned off, then returns that value for a test or helper to customize.

**Call relations**: Many snapshot tests and helper setup paths start here so they all share the same baseline behavior. Callers can then chain option methods when a test needs full text, kind-only output, or stripped instruction sections.

*Call graph*: called by 19 (guardian_snapshot_options, fork_startup_context_then_first_turn_diff_snapshot, full_text_mode_normalizes_crlf_line_endings, full_text_mode_preserves_unredacted_text, image_only_message_is_rendered_as_non_text_span, kind_with_text_prefix_mode_normalizes_crlf_line_endings, mixed_text_and_image_message_keeps_image_span, redacted_text_mode_keeps_canonical_placeholders, redacted_text_mode_keeps_capability_instruction_placeholders, redacted_text_mode_normalizes_environment_context_with_subagents (+9 more)).


##### `ContextSnapshotOptions::render_mode`  (lines 41–44)

```
fn render_mode(mut self, render_mode: ContextSnapshotRenderMode) -> Self
```

**Purpose**: Changes how much text a snapshot should show. A test uses it when it needs full text, only item kinds, or a shortened text prefix instead of the default redacted view.

**Data flow**: It receives an existing options value and the desired render mode. It updates the render mode inside that options value and returns the updated options so calls can be chained.

**Call relations**: Tests call this after `ContextSnapshotOptions::default` when the standard redacted output is not right for the case being checked. The resulting options are passed into the snapshot formatting functions.


##### `ContextSnapshotOptions::strip_capability_instructions`  (lines 46–49)

```
fn strip_capability_instructions(mut self) -> Self
```

**Purpose**: Tells snapshot rendering to omit app, skill, and plugin instruction blocks from developer messages. This is useful when a test cares about the rest of the context and not those large repeated capability instructions.

**Data flow**: It receives an options value, turns on the `strip_capability_instructions` flag, and returns the changed options value.

**Call relations**: Tests or shared snapshot setup can chain this after the default options. Later, `format_response_items_snapshot` reads the flag while walking message content and skips matching developer-message parts.


##### `ContextSnapshotOptions::strip_agents_md_user_context`  (lines 51–54)

```
fn strip_agents_md_user_context(mut self) -> Self
```

**Purpose**: Tells snapshot rendering to omit `AGENTS.md` instruction text from user messages. This keeps snapshots focused when that project-guidance block is not the thing under test.

**Data flow**: It receives an options value, turns on the `strip_agents_md_user_context` flag, and returns the changed options value.

**Call relations**: Callers set this option before formatting request items. During message formatting, the snapshot renderer checks the flag and drops matching user-message content.


##### `format_request_input_snapshot`  (lines 57–63)

```
fn format_request_input_snapshot(
    request: &ResponsesRequest,
    options: &ContextSnapshotOptions,
) -> String
```

**Purpose**: Formats the input items from a `ResponsesRequest` into the compact snapshot text used by tests. It is the request-level wrapper around the item formatter.

**Data flow**: It receives a request and snapshot options. It reads the request's input list, passes those JSON items to `format_response_items_snapshot`, and returns the resulting multi-line text.

**Call relations**: Higher-level test helpers call this when they have a full request object rather than a raw list of JSON items. It hands the actual rendering work to `format_response_items_snapshot`.

*Call graph*: calls 2 internal fn (format_response_items_snapshot, input).


##### `format_response_items_snapshot`  (lines 65–209)

```
fn format_response_items_snapshot(items: &[Value], options: &ContextSnapshotOptions) -> String
```

**Purpose**: Turns a list of response/request items into readable lines that show their order, kind, role, and important content. This is the central formatter for context snapshots.

**Data flow**: It receives JSON items plus rendering options. For each item, it reads fields such as `type`, `role`, `content`, `name`, `output`, or command data, redacts or shortens text as requested, and produces one line or a small block of lines. It returns all rendered items joined with newlines.

**Call relations**: This function is called by `format_request_input_snapshot` and many tests. The rest of the snapshot helper code depends on it to give a stable human-readable view of messages, function calls, shell calls, reasoning, and other request parts.

*Call graph*: called by 13 (format_request_input_snapshot, full_text_mode_normalizes_crlf_line_endings, full_text_mode_preserves_unredacted_text, image_only_message_is_rendered_as_non_text_span, kind_with_text_prefix_mode_normalizes_crlf_line_endings, mixed_text_and_image_message_keeps_image_span, redacted_text_mode_keeps_canonical_placeholders, redacted_text_mode_keeps_capability_instruction_placeholders, redacted_text_mode_normalizes_environment_context_with_subagents, redacted_text_mode_normalizes_system_skill_temp_paths (+3 more)); 1 external calls (iter).


##### `format_labeled_requests_snapshot`  (lines 211–227)

```
fn format_labeled_requests_snapshot(
    scenario: &str,
    sections: &[(&str, &ResponsesRequest)],
    options: &ContextSnapshotOptions,
) -> String
```

**Purpose**: Builds a larger snapshot with a scenario name and several titled request sections. It helps tests compare multiple stages of a scenario in one readable block.

**Data flow**: It receives a scenario label, a list of section titles paired with requests, and snapshot options. For each section, it formats the request input, adds a markdown-style heading, and returns one combined text document.

**Call relations**: Scenario-style tests call this when they want to show more than one request side by side, such as startup context followed by a later turn. It uses the request input snapshot formatter for each section.

*Call graph*: called by 5 (fork_startup_context_then_first_turn_diff_snapshot, format_labeled_requests_snapshot, format_labeled_requests_snapshot, format_labeled_requests_snapshot, new_context_tool_starts_new_window_before_follow_up); 2 external calls (iter, format!).


##### `format_labeled_items_snapshot`  (lines 229–245)

```
fn format_labeled_items_snapshot(
    scenario: &str,
    sections: &[(&str, &[Value])],
    options: &ContextSnapshotOptions,
) -> String
```

**Purpose**: Builds a scenario snapshot from already-extracted item lists rather than full request objects. It is useful for tests that collect or compare raw response items directly.

**Data flow**: It receives a scenario label, titled sections of JSON item slices, and options. It formats each item slice, places it under its title, and returns one combined text document.

**Call relations**: A higher-level assertion helper calls this when it already has item arrays to compare. It delegates the item-by-item rendering to `format_response_items_snapshot`.

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

**Purpose**: Shows what changed between two complete `/responses` request bodies while keeping the output short. It is meant for tests that need request parity checks without dumping the whole JSON payload.

**Data flow**: It receives a scenario name, titles for the before and after requests, the two requests, and options. It converts each request body into a normalized pretty JSON string, computes only the changed lines, and returns the scenario header plus that diff.

**Call relations**: Tests use this when comparing two full request payloads. It calls `format_request_body_snapshot` for each side, then passes both rendered bodies to `format_changed_lines_diff`.

*Call graph*: calls 2 internal fn (format_changed_lines_diff, format_request_body_snapshot); 1 external calls (format!).


##### `format_request_body_snapshot`  (lines 265–272)

```
fn format_request_body_snapshot(
    request: &ResponsesRequest,
    options: &ContextSnapshotOptions,
) -> String
```

**Purpose**: Converts a full request body into stable, pretty-printed JSON for snapshot comparison. It prepares the data so later diffs are about real changes, not random ordering or run-specific values.

**Data flow**: It receives a request and options. It reads the request body as JSON, normalizes the JSON values in place, serializes the result with indentation, and returns that string.

**Call relations**: `format_request_body_diff_snapshot` calls this once for the before request and once for the after request. It relies on `canonicalize_json_snapshot_value` to clean and stabilize the JSON before printing.

*Call graph*: calls 2 internal fn (canonicalize_json_snapshot_value, body_json); called by 1 (format_request_body_diff_snapshot); 1 external calls (to_string_pretty).


##### `canonicalize_json_snapshot_value`  (lines 274–295)

```
fn canonicalize_json_snapshot_value(value: &mut Value, options: &ContextSnapshotOptions)
```

**Purpose**: Walks through a JSON value and makes it stable for snapshots. It sorts object keys and normalizes every string it finds.

**Data flow**: It receives a mutable JSON value and options. If the value is an array, it processes each element; if it is an object, it sorts keys and processes each field; if it is a string, it replaces the string with its snapshot-safe version. It changes the JSON value in place and returns nothing.

**Call relations**: `format_request_body_snapshot` calls this before pretty-printing JSON. When it reaches strings, it hands them to `format_snapshot_json_string` so text redaction and dynamic-value cleanup are applied consistently.

*Call graph*: calls 1 internal fn (format_snapshot_json_string); called by 1 (format_request_body_snapshot); 1 external calls (take).


##### `format_snapshot_json_string`  (lines 297–320)

```
fn format_snapshot_json_string(text: &str, options: &ContextSnapshotOptions) -> String
```

**Purpose**: Normalizes one JSON string for stable snapshot output. It can redact known large context blocks, clean line endings, replace dynamic values, and optionally shorten long text.

**Data flow**: It receives a text string and options. Depending on the render mode, it canonicalizes known text patterns, normalizes line endings, replaces dynamic values like UUIDs and timestamps, and may truncate to a maximum character count. It returns the cleaned string.

**Call relations**: `canonicalize_json_snapshot_value` uses this for every string inside a request body. A focused unit test also calls it directly to prove dynamic metadata is replaced as expected.

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

**Purpose**: Creates a small diff showing only inserted and deleted lines between two text blocks. Equal lines are left out so the reader sees only what changed.

**Data flow**: It receives titles and two text bodies. It starts with diff headers, compares the bodies line by line, appends deleted lines with `-` and inserted lines with `+`, and returns the resulting diff text.

**Call relations**: `format_request_body_diff_snapshot` calls this after preparing the before and after request-body snapshots. It is the final step that turns two full JSON documents into a concise test failure display.

*Call graph*: called by 1 (format_request_body_diff_snapshot); 2 external calls (from_lines, format!).


##### `format_snapshot_text`  (lines 345–365)

```
fn format_snapshot_text(text: &str, options: &ContextSnapshotOptions) -> String
```

**Purpose**: Formats ordinary message text for item snapshots. It applies the chosen render mode and turns real newlines into visible `\n` text so each snapshot item can stay on one line when possible.

**Data flow**: It receives message text and options. In redacted mode it replaces known context blocks with placeholders; in full mode it keeps the text; in prefix mode it normalizes and shortens the text. It returns the display-ready string.

**Call relations**: The item formatter uses this whenever it needs to print message text, function-call output, shell commands, or reasoning summaries. It depends on the lower-level text normalization helpers.

*Call graph*: calls 2 internal fn (canonicalize_snapshot_text, normalize_snapshot_line_endings); 2 external calls (format!, unreachable!).


##### `normalize_snapshot_line_endings`  (lines 367–369)

```
fn normalize_snapshot_line_endings(text: &str) -> String
```

**Purpose**: Makes line endings consistent across operating systems. It converts Windows-style and old Mac-style line breaks into normal newline characters.

**Data flow**: It receives text that may contain `\r\n` or `\r`. It replaces those line endings with `\n` and returns the normalized text.

**Call relations**: Both `format_snapshot_json_string` and `format_snapshot_text` call this before comparing or printing text. This prevents snapshots from changing just because a file or system used different newline conventions.

*Call graph*: called by 2 (format_snapshot_json_string, format_snapshot_text).


##### `canonicalize_snapshot_text`  (lines 371–426)

```
fn canonicalize_snapshot_text(text: &str) -> String
```

**Purpose**: Replaces known bulky or machine-specific context text with short, meaningful placeholders. This keeps snapshots readable while still showing what kind of context was present.

**Data flow**: It receives raw text. It checks for known prefixes such as permissions instructions, apps/skills/plugins instructions, `AGENTS.md`, environment context, summarization prompts, and compaction summaries. It returns a placeholder or normalized version of the text, including normalized skill file paths when needed.

**Call relations**: `format_snapshot_text` and `format_snapshot_json_string` call this when redacted or prefix rendering is requested. If no special block is recognized, it hands the text to `normalize_dynamic_snapshot_paths` to clean temporary system-skill paths.

*Call graph*: calls 1 internal fn (normalize_dynamic_snapshot_paths); called by 2 (format_snapshot_json_string, format_snapshot_text); 2 external calls (new, format!).


##### `is_capability_instruction_text`  (lines 428–432)

```
fn is_capability_instruction_text(text: &str) -> bool
```

**Purpose**: Recognizes app, skill, and plugin instruction blocks. It is used when tests ask to remove those capability instructions from developer-message snapshots.

**Data flow**: It receives a text string. It checks whether the string starts with one of the known capability instruction opening tags and returns true or false.

**Call relations**: `format_response_items_snapshot` uses this while processing developer message parts. When the strip option is enabled and this function returns true, that message part is omitted from the rendered snapshot.


##### `normalize_dynamic_snapshot_paths`  (lines 434–443)

```
fn normalize_dynamic_snapshot_paths(text: &str) -> String
```

**Purpose**: Replaces temporary system-skill file paths with a stable placeholder. This prevents snapshots from depending on a machine's random temporary directory names.

**Data flow**: It receives text that may include a path to `skills/.system/.../SKILL.md`. It uses a cached regular expression, which is a reusable text-matching pattern, to replace the changing root path with `<SYSTEM_SKILLS_ROOT>`. It returns the cleaned text.

**Call relations**: `canonicalize_snapshot_text` calls this when the text is not one of the larger recognized context blocks. It is the path-cleanup fallback for ordinary text.

*Call graph*: called by 1 (canonicalize_snapshot_text); 1 external calls (new).


##### `normalize_snapshot_dynamic_values`  (lines 445–467)

```
fn normalize_snapshot_dynamic_values(text: &str) -> String
```

**Purpose**: Replaces run-specific values inside snapshot text, such as UUIDs, timestamps, and sandbox names. This keeps tests from failing just because a new run generated different metadata.

**Data flow**: It receives text. It applies cached regular expressions that find UUID-shaped strings, `turn_started_at_unix_ms` values, and `sandbox` values, replacing them with fixed placeholders. It returns the normalized text.

**Call relations**: `format_snapshot_json_string` calls this after canonicalizing text for JSON snapshots. It is especially important for full request-body comparisons where metadata changes every run.

*Call graph*: called by 1 (format_snapshot_json_string); 1 external calls (new).


##### `tests::full_text_mode_preserves_unredacted_text`  (lines 479–498)

```
fn full_text_mode_preserves_unredacted_text()
```

**Purpose**: Checks that full-text mode does not replace `AGENTS.md` content with a placeholder. This protects the mode that is meant to show the original text.

**Data flow**: It builds a sample user message containing `AGENTS.md` instructions, creates default options changed to full-text mode, formats the item list, and compares the result with the expected unredacted string.

**Call relations**: This test calls `ContextSnapshotOptions::default` and `format_response_items_snapshot`. It verifies that the central item formatter respects the full-text option.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::full_text_mode_normalizes_crlf_line_endings`  (lines 501–517)

```
fn full_text_mode_normalizes_crlf_line_endings()
```

**Purpose**: Checks that full-text mode still normalizes Windows-style line endings. Full text means unredacted content, not platform-dependent newline output.

**Data flow**: It builds a message containing `\r\n` line breaks, formats it in full-text mode, and asserts that the output uses normalized `\n` line breaks displayed in the snapshot string.

**Call relations**: This test exercises `format_response_items_snapshot` through the full-text path. It indirectly protects the line-ending normalization used by snapshot text formatting.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_keeps_canonical_placeholders`  (lines 520–536)

```
fn redacted_text_mode_keeps_canonical_placeholders()
```

**Purpose**: Checks that redacted mode replaces `AGENTS.md` instructions with the standard `<AGENTS_MD>` placeholder. This confirms that large project guidance is hidden consistently.

**Data flow**: It builds a user message containing `AGENTS.md` instructions, formats it with default redacted options, and compares the output to the expected placeholder line.

**Call relations**: This test calls the default options and the main item formatter. It protects the redaction path used by most snapshots.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_keeps_capability_instruction_placeholders`  (lines 539–568)

```
fn redacted_text_mode_keeps_capability_instruction_placeholders()
```

**Purpose**: Checks that app, skill, and plugin instruction blocks become clear placeholders in redacted mode. The snapshot should show that those blocks existed without printing their full contents.

**Data flow**: It builds a developer message with three instruction text parts, formats it with default redacted options, and asserts that each part is shown as its matching placeholder in a multi-part message block.

**Call relations**: This test drives `format_response_items_snapshot` with a multi-part developer message. It protects the canonicalization rules for capability instruction text.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::strip_capability_instructions_omits_capability_parts_from_developer_messages`  (lines 571–590)

```
fn strip_capability_instructions_omits_capability_parts_from_developer_messages()
```

**Purpose**: Checks that the strip option removes app, skill, and plugin instruction parts from developer messages. It also confirms that permissions instructions are not removed by that specific option.

**Data flow**: It builds a developer message containing permissions, skills, and plugins instruction parts. It enables capability-instruction stripping, formats the items, and expects only the permissions placeholder to remain.

**Call relations**: This test chains `strip_capability_instructions` onto default options before calling `format_response_items_snapshot`. It verifies the interaction between the option flag and capability-text detection.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::strip_agents_md_user_context_omits_agents_fragment_from_user_messages`  (lines 593–617)

```
fn strip_agents_md_user_context_omits_agents_fragment_from_user_messages()
```

**Purpose**: Checks that the strip option removes `AGENTS.md` user context while keeping other user context. This helps tests focus on environment details without repeated project instructions.

**Data flow**: It builds a user message with an `AGENTS.md` part and an environment-context part. It enables `AGENTS.md` stripping, formats the items, and expects only the normalized environment context to appear.

**Call relations**: This test uses the option setter and then calls the main item formatter. It protects the user-message filtering path controlled by `strip_agents_md_user_context`.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_normalizes_environment_context_with_subagents`  (lines 620–639)

```
fn redacted_text_mode_normalizes_environment_context_with_subagents()
```

**Purpose**: Checks that environment context is summarized and includes the number of subagents. This keeps the snapshot short while preserving an important fact about the request setup.

**Data flow**: It builds a user message containing environment context with a current working directory and two subagent lines. It formats the items in default redacted mode and expects a placeholder that includes `cwd=<CWD>` and `subagents=2`.

**Call relations**: This test calls the main item formatter with default options. It protects the special environment-context logic inside text canonicalization.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::kind_with_text_prefix_mode_normalizes_crlf_line_endings`  (lines 642–662)

```
fn kind_with_text_prefix_mode_normalizes_crlf_line_endings()
```

**Purpose**: Checks that prefix mode both normalizes line endings and shortens long text. Prefix mode is useful when tests need a hint of the text without printing everything.

**Data flow**: It builds a developer message with Windows-style line endings, sets render mode to a 64-character prefix, formats the items, and compares the output with the expected shortened normalized text.

**Call relations**: This test starts from default options, changes the render mode, and calls `format_response_items_snapshot`. It protects the prefix-rendering branch of snapshot text formatting.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::image_only_message_is_rendered_as_non_text_span`  (lines 665–678)

```
fn image_only_message_is_rendered_as_non_text_span()
```

**Purpose**: Checks that an image-only message is still represented clearly in the snapshot. The formatter should not lose non-text content just because there is no text field.

**Data flow**: It builds a user message whose content is an image item with an image URL. It formats the items with default options and expects a compact marker showing an `input_image` with the `image_url` extra field.

**Call relations**: This test calls `format_response_items_snapshot` directly. It protects the branch that renders non-text message content as angle-bracket markers.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::mixed_text_and_image_message_keeps_image_span`  (lines 681–707)

```
fn mixed_text_and_image_message_keeps_image_span()
```

**Purpose**: Checks that a message containing both text and an image keeps all parts in order. This matters because the structure of a multi-part message can affect what the model sees.

**Data flow**: It builds a user message with text, an image item, and more text. It formats the items and asserts that the snapshot shows a three-part message with the image marker in the middle.

**Call relations**: This test exercises the multi-part path in `format_response_items_snapshot`. It verifies that text rendering and non-text markers work together.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_normalizes_system_skill_temp_paths`  (lines 710–726)

```
fn redacted_text_mode_normalizes_system_skill_temp_paths()
```

**Purpose**: Checks that temporary system-skill paths are replaced with a stable root placeholder. This prevents snapshots from depending on random temporary folder names.

**Data flow**: It builds a developer message containing a long temporary path to a system skill file. It formats the item with default redacted options and expects the path root to become `<SYSTEM_SKILLS_ROOT>` while keeping the skill name and file name.

**Call relations**: This test calls the main item formatter. It protects the dynamic path normalization used by text canonicalization.

*Call graph*: calls 2 internal fn (default, format_response_items_snapshot); 2 external calls (assert_eq!, vec!).


##### `tests::redacted_text_mode_normalizes_turn_metadata_dynamic_json_strings`  (lines 729–739)

```
fn redacted_text_mode_normalizes_turn_metadata_dynamic_json_strings()
```

**Purpose**: Checks that dynamic metadata inside a JSON-looking string is replaced with placeholders. This covers UUIDs, sandbox names, and millisecond timestamps.

**Data flow**: It passes a string containing a turn ID, sandbox value, and start time into `format_snapshot_json_string` using default options. It asserts that those unstable values become `<UUID>`, `<SANDBOX>`, and `<UNIX_MS>`.

**Call relations**: Unlike most tests here, this one calls the JSON-string formatter directly. It protects the dynamic-value cleanup used during full request-body snapshot formatting.

*Call graph*: calls 2 internal fn (default, format_snapshot_json_string); 1 external calls (assert_eq!).


### `core/tests/common/responses.rs`

`test` · `test setup and mocked request handling`

Tests for an API client need a safe, predictable stand-in for the real service. This file provides that stand-in. It builds mock `/responses`, `/responses/compact`, and `/models` endpoints, plus a small WebSocket server for realtime tests. Tests can say, “when the client sends a request, answer with these stream events,” then inspect the exact request body, headers, path, query string, messages, images, tools, or tool-call outputs the client sent.

A big part of the file is convenience builders for Server-Sent Events, or SSE: a simple text format where the server sends named events one after another. These helpers create realistic events such as “response created,” “assistant message,” “function call,” “tool search,” “reasoning text,” or “failure.” That keeps tests short and readable.

The file also protects tests from accidentally accepting bad request history. Every captured `/responses` POST is checked for matching tool calls and tool outputs. For example, if the client sends a tool result without the original tool call, the mock panics immediately. Think of it like a rehearsal stage with a strict script supervisor: it not only performs the fake server role, it also catches continuity errors before they reach production.

#### Function details

##### `ResponseMock::new`  (lines 44–48)

```
fn new() -> Self
```

**Purpose**: Creates an empty recorder for `/responses` requests. Tests use it so they can later inspect what the client sent.

**Data flow**: It starts with no inputs, creates a shared list protected by a mutex (a lock that stops two test tasks changing the list at once), and returns a `ResponseMock` that owns that shared recorder.

**Call relations**: The mock-building helpers create this recorder before mounting fake `/responses` or `/responses/compact` endpoints, then wire it into Wiremock so every matching request is saved.

*Call graph*: called by 2 (base_mock, compact_mock); 3 external calls (new, new, new).


##### `ResponseMock::single_request`  (lines 50–56)

```
fn single_request(&self) -> ResponsesRequest
```

**Purpose**: Returns the only captured `/responses` request, and fails the test if there were zero or more than one. This is useful when a test expects exactly one API call.

**Data flow**: It reads the shared request list, checks its length, and returns a cloned request if the length is exactly one. If the count is wrong, it panics with a clear count.

**Call relations**: Higher-level test helpers call this after a mocked turn completes to examine the single request body without manually checking the list.

*Call graph*: called by 1 (command_result); 1 external calls (panic!).


##### `ResponseMock::requests`  (lines 58–60)

```
fn requests(&self) -> Vec<ResponsesRequest>
```

**Purpose**: Returns all captured `/responses` requests. Tests use it when they expect multiple calls or need to search the history.

**Data flow**: It locks the shared list, clones the saved `ResponsesRequest` values, and gives the caller an independent snapshot.

**Call relations**: Many waiting and assertion helpers call this repeatedly while polling for expected requests or scanning request contents.

*Call graph*: called by 7 (wait_for_request_count, function_call_output_text, saw_function_call, capture_from_requests, wait_for_matching_request, wait_for_requests, wait_for_request).


##### `ResponseMock::last_request`  (lines 62–64)

```
fn last_request(&self) -> Option<ResponsesRequest>
```

**Purpose**: Returns the most recent captured request, if any. It is a quick way to inspect the latest API call without caring about earlier ones.

**Data flow**: It reads the shared request list, clones the last item when present, and returns `None` if no request has arrived.

**Call relations**: This is a direct inspection helper for tests that care about the latest request state.


##### `ResponseMock::saw_function_call`  (lines 68–72)

```
fn saw_function_call(&self, call_id: &str) -> bool
```

**Purpose**: Checks whether any captured request includes a function call with a given call id. Tests use it to prove the client preserved or resent a specific tool call.

**Data flow**: It receives a call id, takes a snapshot of all requests, asks each request whether it contains that function call, and returns true as soon as one matches.

**Call relations**: It builds on `ResponseMock::requests` and `ResponsesRequest::has_function_call`, giving tests a one-line search across request history.

*Call graph*: calls 1 internal fn (requests).


##### `ResponseMock::function_call_output_text`  (lines 76–80)

```
fn function_call_output_text(&self, call_id: &str) -> Option<String>
```

**Purpose**: Finds the output text for a particular function call result across all captured requests. This helps tests confirm that tool results were sent back to the model correctly.

**Data flow**: It receives a call id, scans saved requests in order, and returns the first matching output string. If no matching output exists, it returns `None`.

**Call relations**: It uses `ResponseMock::requests` and each request’s own function-output lookup to hide the repeated search work from test code.

*Call graph*: calls 1 internal fn (requests).


##### `is_zstd_encoding`  (lines 86–90)

```
fn is_zstd_encoding(value: &str) -> bool
```

**Purpose**: Checks whether a `Content-Encoding` header says the body is compressed with zstd. zstd is a compression format, like a zip file for request bodies.

**Data flow**: It receives a header string, splits comma-separated encoding names, trims spaces, compares each name case-insensitively with `zstd`, and returns true if found.

**Call relations**: Body-decoding code uses this before trying to read JSON from a request, so tests can inspect both plain and compressed requests.


##### `decode_body_bytes`  (lines 92–99)

```
fn decode_body_bytes(body: &[u8], content_encoding: Option<&str>) -> Vec<u8>
```

**Purpose**: Turns a captured request body into readable bytes, decompressing it if the client used zstd compression.

**Data flow**: It receives raw body bytes and an optional encoding header. If the header includes zstd, it decompresses the bytes; otherwise it copies them unchanged.

**Call relations**: Request inspection and invariant validation call this before parsing JSON, so the rest of the test helpers do not need to care whether the client compressed the request.

*Call graph*: calls 1 internal fn (new); called by 2 (body_json, validate_request_body_invariants); 1 external calls (decode_all).


##### `ResponsesRequest::body_json`  (lines 102–111)

```
fn body_json(&self) -> Value
```

**Purpose**: Parses the captured request body as JSON. Tests use this as the main doorway into the request payload.

**Data flow**: It reads the raw body and `content-encoding` header, decodes compression when needed, parses the bytes as JSON, and returns a `serde_json::Value` tree.

**Call relations**: Most request-inspection helpers build on this, including checks for instructions, input items, tools, and text fragments.

*Call graph*: calls 1 internal fn (decode_body_bytes); called by 9 (format_request_body_snapshot, body_contains_text, input, instructions_text, tool_by_name, assert_request_contains_custom_realtime_start, assert_request_contains_realtime_end, assert_request_contains_realtime_start, tool_names); 1 external calls (from_slice).


##### `ResponsesRequest::body_bytes`  (lines 113–115)

```
fn body_bytes(&self) -> Vec<u8>
```

**Purpose**: Returns the original raw request body bytes exactly as captured. This is useful when a test needs to inspect compression or low-level payload data.

**Data flow**: It clones the stored byte buffer from the Wiremock request and returns it unchanged.

**Call relations**: This sits beside the JSON helpers for tests that need the body before parsing.


##### `ResponsesRequest::body_contains_text`  (lines 117–123)

```
fn body_contains_text(&self, text: &str) -> bool
```

**Purpose**: Checks whether the request JSON contains a particular text fragment. It accounts for JSON escaping so tests can search for text reliably.

**Data flow**: It receives text, converts it to its JSON string form, removes the outer quotes, turns the full body JSON into a string, and checks for the fragment.

**Call relations**: It builds on `body_json` and is used by assertions that only need to know whether text appears somewhere in the request.

*Call graph*: calls 1 internal fn (body_json); 1 external calls (to_string).


##### `ResponsesRequest::tool_by_name`  (lines 125–127)

```
fn tool_by_name(&self, namespace: &str, tool_name: &str) -> Option<Value>
```

**Purpose**: Finds a tool nested inside a named tool namespace in the request. A namespace is a grouping, like a folder containing related tools.

**Data flow**: It parses the body JSON, searches the `tools` array for a namespace with the requested name, then searches that namespace’s child tools for the requested tool name.

**Call relations**: It delegates the search to `namespace_child_tool`, making request assertions about nested tools concise.

*Call graph*: calls 2 internal fn (body_json, namespace_child_tool).


##### `ResponsesRequest::instructions_text`  (lines 129–134)

```
fn instructions_text(&self) -> String
```

**Purpose**: Returns the request’s top-level instructions text. Tests use this to verify the prompt or developer instructions sent to the model.

**Data flow**: It parses the body JSON, reads the `instructions` field as a string, and returns an owned copy.

**Call relations**: Token-estimation and prompt-checking helpers call this when they need the exact instruction text from a captured request.

*Call graph*: calls 1 internal fn (body_json); called by 1 (estimate_compact_payload_tokens).


##### `ResponsesRequest::message_input_texts`  (lines 137–146)

```
fn message_input_texts(&self, role: &str) -> Vec<String>
```

**Purpose**: Collects all text spans from message inputs with a chosen role, such as user or developer. This lets tests focus on human-readable message text.

**Data flow**: It receives a role, filters request input items to messages with that role, walks their content array, keeps `input_text` spans, and returns their text strings.

**Call relations**: Many prompt and instruction assertion helpers call this after a request is captured to verify what text the client sent.

*Call graph*: calls 1 internal fn (inputs_of_type); called by 9 (instruction_fragments, message_input_text_contains, instruction_fragments, request_hook_prompt_texts, user_instructions_wrapper_count, permissions_texts, has_subagent_notification, token_budget_texts, phase2_prompt_text).


##### `ResponsesRequest::message_input_text_groups`  (lines 149–162)

```
fn message_input_text_groups(&self, role: &str) -> Vec<Vec<String>>
```

**Purpose**: Collects input text spans by message instead of flattening them all together. This preserves which text pieces belonged to the same message.

**Data flow**: It filters message inputs by role, then for each message gathers its `input_text` content into a separate list. The result is a list of message-sized text groups.

**Call relations**: The predicate-based helper `has_message_with_input_texts` uses this when tests need to check whole messages, not just individual spans.

*Call graph*: calls 1 internal fn (inputs_of_type); called by 1 (has_message_with_input_texts).


##### `ResponsesRequest::has_message_with_input_texts`  (lines 164–172)

```
fn has_message_with_input_texts(
        &self,
        role: &str,
        predicate: impl Fn(&[String]) -> bool,
    ) -> bool
```

**Purpose**: Checks whether any message for a role satisfies a custom condition over its text spans. This gives tests flexible matching without repeating JSON walking code.

**Data flow**: It receives a role and a predicate function, groups message text by message, applies the predicate to each group, and returns true if any group matches.

**Call relations**: It wraps `message_input_text_groups` for tests that need more expressive checks than simple text containment.

*Call graph*: calls 1 internal fn (message_input_text_groups).


##### `ResponsesRequest::message_input_image_urls`  (lines 175–188)

```
fn message_input_image_urls(&self, role: &str) -> Vec<String>
```

**Purpose**: Collects image URLs from message inputs with a chosen role. Tests use it to verify that image inputs were sent correctly.

**Data flow**: It filters message inputs by role, walks content spans, keeps `input_image` spans, extracts their `image_url` strings, and returns them.

**Call relations**: It shares the same input-filtering path as the text helpers, but focuses on image content instead.

*Call graph*: calls 1 internal fn (inputs_of_type).


##### `ResponsesRequest::input`  (lines 190–195)

```
fn input(&self) -> Vec<Value>
```

**Purpose**: Returns the request’s `input` array. In Responses API calls, this array is the main history sent to the model.

**Data flow**: It parses the body JSON, reads `input` as an array, clones it, and fails the test if the field is missing or not an array.

**Call relations**: Almost every helper that inspects messages, calls, or outputs starts here, because those items live inside `input`.

*Call graph*: calls 1 internal fn (body_json); called by 6 (format_request_input_snapshot, call_output, function_call_output_text, has_function_call, inputs_of_type, estimate_compact_input_tokens).


##### `ResponsesRequest::inputs_of_type`  (lines 197–203)

```
fn inputs_of_type(&self, ty: &str) -> Vec<Value>
```

**Purpose**: Filters the request input array to items of one specific `type`. Tests use this to find messages, function calls, or other item kinds.

**Data flow**: It receives a type string, reads the full input array, keeps items whose `type` field matches, clones them, and returns the filtered list.

**Call relations**: Message text and image helpers call this first so they can work only with message items.

*Call graph*: calls 1 internal fn (input); called by 3 (message_input_image_urls, message_input_text_groups, message_input_texts).


##### `ResponsesRequest::function_call_output`  (lines 205–207)

```
fn function_call_output(&self, call_id: &str) -> Value
```

**Purpose**: Returns the `function_call_output` item for a given call id. This helps tests verify the result sent back for a normal function/tool call.

**Data flow**: It receives a call id, asks the generic call-output finder for type `function_call_output`, and returns the matching JSON item or fails if missing.

**Call relations**: It is a typed wrapper around `call_output`, used by test assertions that know they are checking normal function-call results.

*Call graph*: calls 1 internal fn (call_output); called by 4 (function_tool_output_items, call_output, call_output_content_and_success, call_output).


##### `ResponsesRequest::custom_tool_call_output`  (lines 209–211)

```
fn custom_tool_call_output(&self, call_id: &str) -> Value
```

**Purpose**: Returns the `custom_tool_call_output` item for a given call id. Tests use it for custom tools whose output format differs from normal functions.

**Data flow**: It receives a call id, searches the input array for a matching custom tool output item, and returns the JSON item or fails if it cannot be found.

**Call relations**: It narrows `call_output` to the custom-tool case so callers do not have to pass the type string themselves.

*Call graph*: calls 1 internal fn (call_output); called by 3 (custom_tool_output_items, custom_tool_output_last_non_empty_text, custom_call_output).


##### `ResponsesRequest::tool_search_output`  (lines 213–215)

```
fn tool_search_output(&self, call_id: &str) -> Value
```

**Purpose**: Returns the `tool_search_output` item for a given call id. Tests use it to inspect search results returned to the model.

**Data flow**: It receives a call id, searches the request input for a matching tool-search output item, and returns the JSON object or fails if absent.

**Call relations**: It is another typed wrapper over `call_output`, focused on tool-search tests.

*Call graph*: calls 1 internal fn (call_output); called by 1 (tool_search_output_item).


##### `ResponsesRequest::call_output`  (lines 217–225)

```
fn call_output(&self, call_id: &str, call_type: &str) -> Value
```

**Purpose**: Finds one output item in the request input by call id and output type. It is the shared lookup behind the specific output helpers.

**Data flow**: It receives a call id and an item type, scans the `input` array for an item whose `type` and `call_id` both match, clones it, and fails the test if no match exists.

**Call relations**: Function, custom tool, and tool-search output helpers all delegate to this to avoid repeating the same JSON search.

*Call graph*: calls 1 internal fn (input); called by 4 (call_output_content_and_success, custom_tool_call_output, function_call_output, tool_search_output).


##### `ResponsesRequest::has_function_call`  (lines 229–234)

```
fn has_function_call(&self, call_id: &str) -> bool
```

**Purpose**: Checks whether this request contains a `function_call` with a given call id. It answers whether the model call history includes that tool call.

**Data flow**: It reads the input array, checks each item’s `type` and `call_id`, and returns true if one is a matching function call.

**Call relations**: The broader `ResponseMock::saw_function_call` helper uses this across all captured requests.

*Call graph*: calls 1 internal fn (input).


##### `ResponsesRequest::function_call_output_text`  (lines 238–247)

```
fn function_call_output_text(&self, call_id: &str) -> Option<String>
```

**Purpose**: Returns the plain output string for a matching function-call result, if it exists. It is useful for simple text tool outputs.

**Data flow**: It receives a call id, finds a `function_call_output` item with that id, reads its `output` field as a string, and returns it as `Some`; missing or non-string output becomes `None`.

**Call relations**: The response-wide lookup helper calls this on each captured request while searching for a tool result.

*Call graph*: calls 1 internal fn (input).


##### `ResponsesRequest::function_call_output_content_and_success`  (lines 249–254)

```
fn function_call_output_content_and_success(
        &self,
        call_id: &str,
    ) -> Option<(Option<String>, Option<bool>)>
```

**Purpose**: Extracts a function-call result’s content text and optional success flag in a normalized form. This covers both older simple outputs and newer object-shaped outputs.

**Data flow**: It receives a call id, delegates to the shared output normalizer for `function_call_output`, and returns optional content plus optional success status.

**Call relations**: Test assertion helpers use this when they need to compare both the body of a function result and whether it was marked successful.

*Call graph*: calls 1 internal fn (call_output_content_and_success); called by 3 (call_output, call_output_content_and_success, call_output).


##### `ResponsesRequest::custom_tool_call_output_content_and_success`  (lines 256–261)

```
fn custom_tool_call_output_content_and_success(
        &self,
        call_id: &str,
    ) -> Option<(Option<String>, Option<bool>)>
```

**Purpose**: Extracts content text and optional success status from a custom tool result. It gives custom-tool tests the same normalized view as normal function-call tests.

**Data flow**: It receives a call id, delegates to the shared output normalizer for `custom_tool_call_output`, and returns optional content plus optional success status.

**Call relations**: It shares the normalization logic with function-call outputs while keeping the public helper specific to custom tools.

*Call graph*: calls 1 internal fn (call_output_content_and_success); called by 2 (custom_tool_output_body_and_success, custom_call_output).


##### `ResponsesRequest::call_output_content_and_success`  (lines 263–283)

```
fn call_output_content_and_success(
        &self,
        call_id: &str,
        call_type: &str,
    ) -> Option<(Option<String>, Option<bool>)>
```

**Purpose**: Normalizes different output shapes into “content text” and “success flag.” This hides whether the JSON output was a string, a single text content item, or an object.

**Data flow**: It finds the matching output item, reads its `output` field, then interprets strings and single text arrays as content without success, objects as `content` plus `success`, and other shapes as empty values.

**Call relations**: Both function-call and custom-tool content helpers rely on this shared parser, and the local unit test checks its edge cases.

*Call graph*: calls 2 internal fn (call_output, output_value_to_text); called by 2 (custom_tool_call_output_content_and_success, function_call_output_content_and_success).


##### `ResponsesRequest::header`  (lines 285–291)

```
fn header(&self, name: &str) -> Option<String>
```

**Purpose**: Reads one HTTP header from the captured request. Tests use it to check metadata sent alongside the JSON body.

**Data flow**: It receives a header name, looks it up in the request headers, converts it to text if possible, and returns an owned string or `None`.

**Call relations**: Header-specific assertions call this when they need a simple string view of a captured request header.

*Call graph*: called by 1 (window_id_parts).


##### `ResponsesRequest::path`  (lines 293–295)

```
fn path(&self) -> String
```

**Purpose**: Returns the URL path of the captured request. This helps tests confirm which endpoint was called.

**Data flow**: It reads the request URL path and returns it as a string.

**Call relations**: It is a small inspection helper available after Wiremock captures a request.


##### `ResponsesRequest::query_param`  (lines 297–303)

```
fn query_param(&self, name: &str) -> Option<String>
```

**Purpose**: Reads one query-string parameter from the request URL. Tests use it when behavior is controlled by URL parameters.

**Data flow**: It receives a parameter name, searches the URL query pairs, and returns the matching value as a string if present.

**Call relations**: It complements body and header inspection by exposing the request’s URL parameters.


##### `output_value_to_text`  (lines 306–317)

```
fn output_value_to_text(value: &Value) -> Option<String>
```

**Purpose**: Turns supported output JSON shapes into plain text. It accepts either a string or one single `input_text` content item.

**Data flow**: It receives a JSON value. If it is a string, it returns that string; if it is an array with exactly one `input_text` item, it returns that item’s text; all other shapes return `None`.

**Call relations**: Output normalizers and custom output helpers use this to avoid treating mixed text-and-image output as plain text by mistake.

*Call graph*: called by 2 (call_output_content_and_success, custom_tool_call_output_text).


##### `namespace_child_tool`  (lines 319–342)

```
fn namespace_child_tool(
    body: &'a Value,
    namespace: &str,
    tool_name: &str,
) -> Option<&'a Value>
```

**Purpose**: Finds a named child tool inside a named namespace in a request body. This supports tests for grouped tools.

**Data flow**: It receives a body JSON value, namespace name, and tool name. It walks the top-level `tools` array, locates the namespace entry, then returns a reference to the matching child tool if present.

**Call relations**: Request helpers and tool-search tests call this instead of duplicating the nested JSON search.

*Call graph*: called by 6 (tool_by_name, tool_search_indexes_only_enabled_non_app_mcp_tools, tool_search_output_has_namespace_child, tool_search_returns_deferred_v1_multi_agent_tools, spawn_agent_description, spawn_agent_tool_description_mentions_role_locked_settings); 1 external calls (get).


##### `tests::request_with_input`  (lines 351–361)

```
fn request_with_input(input: Value) -> ResponsesRequest
```

**Purpose**: Builds a minimal fake `ResponsesRequest` around a supplied `input` JSON value. The unit test uses it to exercise request-parsing helpers without running a server.

**Data flow**: It receives an input JSON value, wraps it in a request body shaped like `{ input: ... }`, creates a dummy POST request to `/v1/responses`, and returns it as `ResponsesRequest`.

**Call relations**: The local unit test calls this to feed controlled inputs into output-normalization methods.

*Call graph*: 3 external calls (new, json!, to_vec).


##### `tests::call_output_content_and_success_returns_only_single_text_content_item`  (lines 364–409)

```
fn call_output_content_and_success_returns_only_single_text_content_item()
```

**Purpose**: Verifies that output normalization only accepts a single text content item as plain text. It protects against accidentally treating mixed media output as text.

**Data flow**: It builds fake requests with single-text outputs and mixed/image outputs, calls the function and custom-tool normalizers, and asserts the expected results.

**Call relations**: This test directly covers the behavior of `call_output_content_and_success` and `output_value_to_text` through the public request helpers.

*Call graph*: 3 external calls (assert_eq!, request_with_input, json!).


##### `WebSocketRequest::body_json`  (lines 418–420)

```
fn body_json(&self) -> Value
```

**Purpose**: Returns the JSON body of a captured WebSocket message. Realtime tests use it to inspect what the client sent over the socket.

**Data flow**: It clones the stored JSON value and returns it to the caller.

**Call relations**: WebSocket assertion helpers call this after retrieving messages from `WebSocketTestServer`.

*Call graph*: called by 2 (websocket_request_instructions, websocket_request_text); 1 external calls (clone).


##### `WebSocketHandshake::uri`  (lines 430–432)

```
fn uri(&self) -> &str
```

**Purpose**: Returns the URI used during the WebSocket handshake. Tests use it to verify that the client connected to the expected path or query.

**Data flow**: It borrows the stored URI string and returns it as text.

**Call relations**: Handshake inspection code calls this after the fake WebSocket server records a connection attempt.


##### `WebSocketHandshake::header`  (lines 434–439)

```
fn header(&self, name: &str) -> Option<String>
```

**Purpose**: Looks up one header from the WebSocket handshake, ignoring letter case. This helps tests verify authentication or feature headers.

**Data flow**: It receives a header name, searches the saved header list case-insensitively, and returns the matching value as a string if found.

**Call relations**: Tests that inspect WebSocket setup use this after `WebSocketTestServer` records handshakes.


##### `WebSocketTestServer::uri`  (lines 468–470)

```
fn uri(&self) -> &str
```

**Purpose**: Returns the address clients should connect to for the fake WebSocket server.

**Data flow**: It borrows the stored `ws://...` URI and returns it as text.

**Call relations**: Test builders use this URI when configuring the client to talk to the local fake realtime server.

*Call graph*: called by 1 (remote_realtime_test_codex_builder).


##### `WebSocketTestServer::connections`  (lines 472–474)

```
fn connections(&self) -> Vec<Vec<WebSocketRequest>>
```

**Purpose**: Returns all recorded WebSocket connections and their received messages. Tests use it to inspect multi-connection behavior.

**Data flow**: It locks the connection log, clones the list of per-connection request lists, and returns the snapshot.

**Call relations**: Polling helpers call this while waiting for a matching WebSocket request to arrive.

*Call graph*: called by 1 (wait_for_matching_websocket_request).


##### `WebSocketTestServer::single_connection`  (lines 476–482)

```
fn single_connection(&self) -> Vec<WebSocketRequest>
```

**Purpose**: Returns the only recorded WebSocket connection, failing if the test saw a different number. This is for tests expecting exactly one connection.

**Data flow**: It reads the connection log, checks that there is exactly one entry, and returns that connection’s messages. If the count differs, it panics.

**Call relations**: Realtime tests can call this after a scenario ends to inspect the one expected connection without extra bookkeeping.

*Call graph*: 1 external calls (panic!).


##### `WebSocketTestServer::wait_for_request`  (lines 484–502)

```
async fn wait_for_request(
        &self,
        connection_index: usize,
        request_index: usize,
    ) -> WebSocketRequest
```

**Purpose**: Waits until a specific WebSocket request has been recorded. This avoids race conditions where the test checks the log before the background server receives the message.

**Data flow**: It receives a connection index and request index, repeatedly checks the log, and waits on a notification when the request is not yet present. Once found, it returns a cloned request.

**Call relations**: WebSocket request assertion helpers call this while the fake server task is receiving messages in the background.

*Call graph*: called by 2 (sideband_outbound_request, wait_for_websocket_request).


##### `WebSocketTestServer::handshakes`  (lines 504–506)

```
fn handshakes(&self) -> Vec<WebSocketHandshake>
```

**Purpose**: Returns all recorded WebSocket handshake attempts. Tests use it to inspect connection metadata.

**Data flow**: It locks the handshake log, clones the saved handshakes, and returns them.

**Call relations**: Handshake assertions call this after starting or waiting for realtime client activity.


##### `WebSocketTestServer::wait_for_handshakes`  (lines 512–530)

```
async fn wait_for_handshakes(&self, expected: usize, timeout: Duration) -> bool
```

**Purpose**: Waits until a minimum number of WebSocket handshakes have been observed, or until a timeout expires. This makes asynchronous connection tests deterministic.

**Data flow**: It receives an expected count and timeout, checks the handshake log, sleeps in short intervals, and returns true if enough handshakes appear before the deadline.

**Call relations**: Realtime tests use this when connection setup happens in a background task and needs a bounded wait instead of a blind sleep.

*Call graph*: 4 external calls (from_millis, min, now, sleep).


##### `WebSocketTestServer::single_handshake`  (lines 531–537)

```
fn single_handshake(&self) -> WebSocketHandshake
```

**Purpose**: Returns the only recorded WebSocket handshake, failing if there was not exactly one. It is the handshake counterpart to `single_connection`.

**Data flow**: It reads the handshake log, checks the count, clones the first handshake when exactly one exists, and panics otherwise.

**Call relations**: Tests call this after a simple one-connection scenario to inspect URI and headers.

*Call graph*: 1 external calls (panic!).


##### `WebSocketTestServer::shutdown`  (lines 539–549)

```
async fn shutdown(self)
```

**Purpose**: Stops the fake WebSocket server task cleanly. If it does not stop quickly, it aborts the task so the test cannot hang forever.

**Data flow**: It sends a shutdown signal, waits up to ten seconds for the background task to finish, and aborts it if the timeout is reached.

**Call relations**: Test teardown paths call this to clean up a running realtime mock server.

*Call graph*: called by 1 (shutdown); 3 external calls (from_secs, send, timeout).


##### `ModelsMock::new`  (lines 558–562)

```
fn new() -> Self
```

**Purpose**: Creates an empty recorder for `/models` requests. Tests use it to verify model-catalog fetches.

**Data flow**: It creates a shared, mutex-protected list of raw Wiremock requests and returns a `ModelsMock` pointing at that list.

**Call relations**: The `models_mock` builder creates this before mounting fake `/models` endpoints.

*Call graph*: called by 1 (models_mock); 3 external calls (new, new, new).


##### `ModelsMock::requests`  (lines 564–566)

```
fn requests(&self) -> Vec<wiremock::Request>
```

**Purpose**: Returns all captured `/models` requests. This lets tests inspect how often and how the client queried the model catalog.

**Data flow**: It locks the shared list, clones the saved requests, and returns the snapshot.

**Call relations**: Tests can call this directly after a fake `/models` endpoint has been exercised.


##### `ModelsMock::single_request_path`  (lines 568–574)

```
fn single_request_path(&self) -> String
```

**Purpose**: Returns the path of the only captured `/models` request, failing if the count is not exactly one.

**Data flow**: It reads the request list, checks that it contains one request, and returns that request’s URL path as a string.

**Call relations**: Model-catalog tests use this when they expect one fetch and want to confirm the endpoint path.

*Call graph*: 1 external calls (panic!).


##### `ModelsMock::matches`  (lines 578–581)

```
fn matches(&self, request: &wiremock::Request) -> bool
```

**Purpose**: Records every request that matches the `/models` mock and always allows the mock to match. This is how Wiremock captures model-catalog calls.

**Data flow**: Wiremock passes in a request, the function clones and stores it, then returns true so the configured response can be served.

**Call relations**: Wiremock invokes this automatically for `/models` mocks built by `models_mock`.

*Call graph*: 1 external calls (clone).


##### `ResponseMock::matches`  (lines 585–595)

```
fn matches(&self, request: &wiremock::Request) -> bool
```

**Purpose**: Records every matching `/responses` request and checks its tool-call history for consistency. It both captures the request and acts as a guardrail.

**Data flow**: Wiremock passes in a request, the function clones it into a `ResponsesRequest`, saves it, validates the body invariants, and returns true so the fake response is served.

**Call relations**: Wiremock invokes this for mocks built by `base_mock` and `compact_mock`; it hands each captured request to `validate_request_body_invariants`.

*Call graph*: calls 1 internal fn (validate_request_body_invariants); 1 external calls (clone).


##### `sse`  (lines 599–612)

```
fn sse(events: Vec<Value>) -> String
```

**Purpose**: Builds a Server-Sent Events response body from JSON event objects. SSE is a text stream where each event has an `event:` line and optional `data:` JSON.

**Data flow**: It receives a list of JSON events, reads each event’s `type`, writes the SSE event name, writes the JSON data when the object has more than just `type`, and returns the combined text body.

**Call relations**: Nearly all event-response helpers and many tests use this to turn realistic JSON events into a stream response body.

*Call graph*: called by 455 (create_mock_responses_server_repeating_assistant, create_apply_patch_sse_response, create_exec_command_sse_response, create_final_assistant_message_sse_response, create_request_permissions_sse_response, create_request_user_input_sse_response, create_shell_command_sse_response, external_auth_refreshes_on_unauthorized, review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_forwards_client_metadata_to_responses_request_v2 (+15 more)); 3 external calls (new, write!, writeln!).


##### `sse_completed`  (lines 614–616)

```
fn sse_completed(id: &str) -> String
```

**Purpose**: Creates a minimal successful SSE stream: response created, then response completed. Tests use it when the content of the response is not important.

**Data flow**: It receives a response id, builds created and completed event JSON objects, passes them to `sse`, and returns the stream text.

**Call relations**: Simple request-shape tests call this to give the client a valid, finished response.

*Call graph*: calls 1 internal fn (sse); called by 12 (default_service_tier_override_is_omitted_from_http_turn, flex_service_tier_is_applied_to_http_turn, null_service_tier_override_is_omitted_from_http_turn_with_catalog_default, unsupported_service_tier_is_omitted_from_http_turn, config_personality_none_sends_no_personality, config_personality_some_sets_instructions_template, default_personality_is_pragmatic_without_config_toml, remote_model_friendly_personality_instructions_with_feature, user_turn_personality_none_does_not_add_update_message, openai_model_header_casing_only_mismatch_does_not_warn (+2 more)); 1 external calls (vec!).


##### `ev_completed`  (lines 619–627)

```
fn ev_completed(id: &str) -> Value
```

**Purpose**: Builds a JSON event meaning the response finished successfully with zero token usage. It is a reusable piece for fake streams.

**Data flow**: It receives a response id and returns a JSON object with type `response.completed`, response id, and zeroed usage fields.

**Call relations**: SSE builders and tests combine this with other event helpers to script successful turns.

*Call graph*: called by 3 (plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done, plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed, unified_exec_prunes_exited_sessions_first); 1 external calls (json!).


##### `ev_response_created`  (lines 630–637)

```
fn ev_response_created(id: &str) -> Value
```

**Purpose**: Builds a JSON event meaning the service created a response. This starts many fake response streams.

**Data flow**: It receives a response id and returns a `response.created` JSON object containing that id.

**Call relations**: Higher-level stream helpers include this before completion or output events.

*Call graph*: 1 external calls (json!).


##### `ev_model_verification_metadata`  (lines 639–648)

```
fn ev_model_verification_metadata(id: &str, verifications: Vec<&str>) -> Value
```

**Purpose**: Builds a metadata event carrying model verification recommendations. Tests use it to simulate backend guidance or warnings.

**Data flow**: It receives a response id and a list of verification strings, then returns a `response.metadata` JSON object containing those values.

**Call relations**: Tests can place this event in an SSE stream to check how the client surfaces model verification metadata.

*Call graph*: 1 external calls (json!).


##### `ev_completed_with_tokens`  (lines 650–664)

```
fn ev_completed_with_tokens(id: &str, total_tokens: i64) -> Value
```

**Purpose**: Builds a completion event with a chosen token count. Tokens are chunks of text counted for model context and billing-like limits.

**Data flow**: It receives a response id and total token count, then returns a `response.completed` event whose input and total usage fields equal that count.

**Call relations**: Compaction and context-window tests use this to simulate responses that report specific usage.

*Call graph*: 1 external calls (json!).


##### `ev_assistant_message`  (lines 667–677)

```
fn ev_assistant_message(id: &str, text: &str) -> Value
```

**Purpose**: Builds an event for a finished assistant message containing text. This simulates the model producing a final message item.

**Data flow**: It receives an item id and text, then returns a `response.output_item.done` JSON object with a message item and `output_text` content.

**Call relations**: Tests combine this with stream helpers to make the fake model answer in natural language.

*Call graph*: called by 2 (plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done, plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed); 1 external calls (json!).


##### `user_message_item`  (lines 679–689)

```
fn user_message_item(text: &str) -> ResponseItem
```

**Purpose**: Creates a protocol-level user message item from plain text. Unlike most helpers here, it returns the project’s typed `ResponseItem` model, not raw JSON.

**Data flow**: It receives text, wraps it as an input text content item with role `user`, leaves optional fields empty, and returns the typed response item.

**Call relations**: Tests that need typed protocol objects rather than wire JSON use this helper.

*Call graph*: 1 external calls (vec!).


##### `ev_message_item_added`  (lines 691–701)

```
fn ev_message_item_added(id: &str, text: &str) -> Value
```

**Purpose**: Builds an event saying an assistant message item was added to the response stream. This represents the start or announcement of an output item.

**Data flow**: It receives an item id and text, then returns a `response.output_item.added` JSON object for an assistant message with output text content.

**Call relations**: Streaming tests use this with delta events and done events to mimic incremental model output.

*Call graph*: 1 external calls (json!).


##### `ev_output_text_delta`  (lines 703–708)

```
fn ev_output_text_delta(delta: &str) -> Value
```

**Purpose**: Builds a text-delta event, meaning the model streamed another piece of output text.

**Data flow**: It receives a text fragment and returns a `response.output_text.delta` JSON object containing that fragment.

**Call relations**: Streaming-output tests place this between item-added and completion events to verify incremental rendering.

*Call graph*: called by 2 (plan_mode_streaming_citations_are_stripped_across_added_deltas_and_done, plan_mode_streaming_proposed_plan_tag_split_across_added_and_delta_is_parsed); 1 external calls (json!).


##### `ev_reasoning_item`  (lines 710–740)

```
fn ev_reasoning_item(id: &str, summary: &[&str], raw_content: &[&str]) -> Value
```

**Purpose**: Builds a completed reasoning item, including summary text and optionally raw reasoning text. It also includes encoded `encrypted_content` to resemble real backend payloads.

**Data flow**: It receives an id, summary strings, and raw content strings. It turns summaries into JSON entries, base64-encodes padded raw content, optionally adds raw reasoning content entries, and returns the event JSON.

**Call relations**: Reasoning and compaction tests use this to simulate model reasoning items in the response stream.

*Call graph*: called by 2 (multiple_auto_compact_per_task_runs_after_token_limit_hit, reasoning_item_is_emitted); 2 external calls (Array, json!).


##### `ev_reasoning_item_added`  (lines 742–756)

```
fn ev_reasoning_item_added(id: &str, summary: &[&str]) -> Value
```

**Purpose**: Builds an event saying a reasoning item was added. This supports tests for streaming reasoning output before it is complete.

**Data flow**: It receives an id and summary strings, converts each summary into a JSON summary entry, and returns a `response.output_item.added` event.

**Call relations**: Streaming reasoning tests can combine it with reasoning delta helpers.

*Call graph*: 1 external calls (json!).


##### `ev_reasoning_summary_text_delta`  (lines 758–764)

```
fn ev_reasoning_summary_text_delta(delta: &str) -> Value
```

**Purpose**: Builds a delta event for reasoning summary text. This simulates the model streaming a piece of its reasoning summary.

**Data flow**: It receives a text fragment and returns a JSON event with that fragment and summary index zero.

**Call relations**: Realtime or streaming tests use it when checking incremental reasoning summary handling.

*Call graph*: 1 external calls (json!).


##### `ev_reasoning_text_delta`  (lines 766–772)

```
fn ev_reasoning_text_delta(delta: &str) -> Value
```

**Purpose**: Builds a delta event for raw reasoning text. This simulates incremental reasoning content.

**Data flow**: It receives a text fragment and returns a JSON event with that fragment and content index zero.

**Call relations**: Reasoning stream tests use it alongside reasoning item events.

*Call graph*: 1 external calls (json!).


##### `ev_web_search_call_added_partial`  (lines 774–783)

```
fn ev_web_search_call_added_partial(id: &str, status: &str) -> Value
```

**Purpose**: Builds an event for a web search call that has been added but is not fully described yet. This supports tests of partial tool status updates.

**Data flow**: It receives an id and status, then returns a `response.output_item.added` event with a `web_search_call` item.

**Call relations**: Web-search item tests pair this with the completed web-search helper.

*Call graph*: called by 1 (web_search_item_is_emitted); 1 external calls (json!).


##### `ev_web_search_call_done`  (lines 785–795)

```
fn ev_web_search_call_done(id: &str, status: &str, query: &str) -> Value
```

**Purpose**: Builds a completed web search call event with the search query included.

**Data flow**: It receives an id, status, and query, then returns a `response.output_item.done` event with a search action containing the query.

**Call relations**: Web-search tests use this to simulate the final form of a search tool call.

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

**Purpose**: Builds an image generation call event. It simulates a model tool call that produced an image result.

**Data flow**: It receives an id, status, revised prompt, and result string, then returns a completed `image_generation_call` event.

**Call relations**: Image-generation tests can include this event in fake response streams.

*Call graph*: 1 external calls (json!).


##### `ev_function_call`  (lines 815–825)

```
fn ev_function_call(call_id: &str, name: &str, arguments: &str) -> Value
```

**Purpose**: Builds a completed function-call event. Function calls are model requests for the client to run a named tool with JSON arguments.

**Data flow**: It receives a call id, tool name, and argument string, then returns a `response.output_item.done` event with a `function_call` item.

**Call relations**: Shell-command helpers, agent-response helpers, and many tests use this as the base tool-call event.

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

**Purpose**: Builds a function-call event that also names a namespace. This represents a tool call inside a grouped tool collection.

**Data flow**: It receives a call id, namespace, tool name, and argument string, then returns a completed function-call JSON event with all those fields.

**Call relations**: Namespace-related tool tests use this when the client must distinguish similarly named tools in different groups.

*Call graph*: 1 external calls (json!).


##### `ev_tool_search_call`  (lines 845–855)

```
fn ev_tool_search_call(call_id: &str, arguments: &serde_json::Value) -> Value
```

**Purpose**: Builds a tool-search call event. This asks the client to perform or respond to a search over available tools.

**Data flow**: It receives a call id and arguments JSON, then returns a completed `tool_search_call` event marked for client execution.

**Call relations**: Tool-search tests place this in fake streams, then inspect the client’s matching `tool_search_output` request.

*Call graph*: 1 external calls (json!).


##### `ev_custom_tool_call`  (lines 857–867)

```
fn ev_custom_tool_call(call_id: &str, name: &str, input: &str) -> Value
```

**Purpose**: Builds a custom tool-call event. Custom tools carry raw input rather than the normal function-call arguments string.

**Data flow**: It receives a call id, tool name, and input string, then returns a completed `custom_tool_call` event.

**Call relations**: Custom-tool tests use this to trigger client behavior and later verify custom tool outputs.

*Call graph*: 1 external calls (json!).


##### `ev_local_shell_call`  (lines 869–882)

```
fn ev_local_shell_call(call_id: &str, status: &str, command: Vec<&str>) -> Value
```

**Purpose**: Builds a local shell call event with a command array. This simulates the model asking for a shell action represented in the newer local-shell format.

**Data flow**: It receives a call id, status, and command parts, then returns a completed `local_shell_call` event with an exec action.

**Call relations**: Shell-related tests can use it when validating local shell call handling and matching outputs.

*Call graph*: 1 external calls (json!).


##### `ev_apply_patch_custom_tool_call`  (lines 887–897)

```
fn ev_apply_patch_custom_tool_call(call_id: &str, patch: &str) -> Value
```

**Purpose**: Builds a custom tool-call event for `apply_patch`, carrying raw patch text. This mirrors the service shape when the model directly invokes patch application.

**Data flow**: It receives a call id and patch text, then returns a completed `custom_tool_call` event named `apply_patch` with the patch as input.

**Call relations**: Patch tests use this to simulate model-driven file edits through the custom tool path.

*Call graph*: called by 1 (prepare); 1 external calls (json!).


##### `ev_shell_command_call`  (lines 899–902)

```
fn ev_shell_command_call(call_id: &str, command: &str) -> Value
```

**Purpose**: Builds a shell-command function call from a plain command string. It is a convenience wrapper for the common shell tool case.

**Data flow**: It receives a call id and command, wraps the command in JSON arguments, and hands those arguments to `ev_shell_command_call_with_args`.

**Call relations**: Shell tests call this when they do not need custom argument objects.

*Call graph*: calls 1 internal fn (ev_shell_command_call_with_args); 1 external calls (json!).


##### `ev_shell_command_call_with_args`  (lines 904–907)

```
fn ev_shell_command_call_with_args(call_id: &str, args: &serde_json::Value) -> Value
```

**Purpose**: Builds a shell-command function call from a supplied JSON arguments object.

**Data flow**: It receives a call id and arguments JSON, serializes the arguments to a string, and creates a `shell_command` function-call event.

**Call relations**: The plain command helper delegates here, and this helper delegates to the generic `ev_function_call` builder.

*Call graph*: calls 1 internal fn (ev_function_call); called by 1 (ev_shell_command_call); 1 external calls (to_string).


##### `ev_apply_patch_shell_command_call_via_heredoc`  (lines 909–914)

```
fn ev_apply_patch_shell_command_call_via_heredoc(call_id: &str, patch: &str) -> Value
```

**Purpose**: Builds a shell-command function call that runs `apply_patch` through a heredoc. A heredoc is a shell way to pass a block of text to a command.

**Data flow**: It receives a call id and patch text, formats a shell command containing the patch between `EOF` markers, serializes it as shell-command arguments, and returns a function-call event.

**Call relations**: Patch-through-shell tests use this to exercise the shell command path rather than the custom tool path.

*Call graph*: calls 1 internal fn (ev_function_call); 2 external calls (json!, to_string).


##### `sse_failed`  (lines 916–924)

```
fn sse_failed(id: &str, code: &str, message: &str) -> String
```

**Purpose**: Builds an SSE stream containing a failed response event. Tests use it to simulate backend errors.

**Data flow**: It receives a response id, error code, and message, builds a `response.failed` JSON event, passes it to `sse`, and returns the stream body.

**Call relations**: Error-handling and retry tests mount this stream to check how the client reacts to failures.

*Call graph*: calls 1 internal fn (sse); called by 5 (thread_read_reports_system_error_idle_flag_after_failed_turn, thread_unsubscribe_preserves_cached_status_before_idle_unload, context_window_error_sets_total_tokens_to_model_window, manual_compact_non_context_failure_retries_then_emits_task_error, manual_compact_retries_after_context_window_error); 1 external calls (vec!).


##### `sse_response`  (lines 926–930)

```
fn sse_response(body: String) -> ResponseTemplate
```

**Purpose**: Wraps an SSE text body in an HTTP response template with the right content type. This makes Wiremock serve it like a real event stream.

**Data flow**: It receives a string body, creates a 200 response, sets `content-type` to `text/event-stream`, attaches the raw body, and returns the template.

**Call relations**: Mount helpers and custom responders call this when they need a ready-to-serve SSE response.

*Call graph*: called by 29 (respond, create_mock_responses_server_repeating_assistant, turn_steer_updates_client_metadata_on_follow_up_responses_request_v2, start_ctrl_c_restart_fixture, respond, model_verification_emits_typed_notification_and_warning_v2, openai_model_header_mismatch_emits_model_rerouted_notification_v2, response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested, turn_moderation_metadata_emits_typed_notification_v2, thread_resume_rejects_history_when_thread_is_running (+15 more)); 1 external calls (new).


##### `mount_response_once`  (lines 932–939)

```
async fn mount_response_once(server: &MockServer, response: ResponseTemplate) -> ResponseMock
```

**Purpose**: Mounts one fake `/responses` POST response on a mock server and returns the request recorder.

**Data flow**: It receives a server and response template, builds the base `/responses` mock, configures it to answer once, mounts it, and returns the `ResponseMock` that will record the request.

**Call relations**: Many tests use this when they need one non-streaming or custom response from the fake Responses API.

*Call graph*: calls 1 internal fn (base_mock); called by 16 (cyber_policy_response_emits_typed_error_notification_v2, model_verification_emits_typed_notification_and_warning_v2, openai_model_header_mismatch_emits_model_rerouted_notification_v2, response_model_field_mismatch_emits_model_rerouted_notification_v2_when_header_matches_requested, turn_moderation_metadata_emits_typed_notification_v2, thread_resume_rejects_history_when_thread_is_running, thread_resume_rejects_mismatched_path_for_running_thread_id, request_permissions_guardian_review_stops_when_cancelled, renews_cache_ttl_on_matching_models_etag, refresh_models_on_models_etag_mismatch_and_avoid_duplicate_models_fetch (+6 more)).


##### `mount_response_once_match`  (lines 941–956)

```
async fn mount_response_once_match(
    server: &MockServer,
    matcher: M,
    response: ResponseTemplate,
) -> ResponseMock
```

**Purpose**: Mounts one fake `/responses` response with an extra request matcher. This lets tests only respond when the request satisfies a custom condition.

**Data flow**: It receives a server, matcher, and response template, builds the base mock, adds the matcher, limits it to one use, mounts it, and returns the recorder.

**Call relations**: Tests with more specific request expectations use this instead of the simpler one-response mount.

*Call graph*: calls 1 internal fn (base_mock); called by 3 (plaintext_multi_agent_v2_completion_sends_agent_message, setup_turn_one_with_custom_spawned_child, replaces_invalid_local_image_after_bad_request).


##### `base_mock`  (lines 958–964)

```
fn base_mock() -> (MockBuilder, ResponseMock)
```

**Purpose**: Creates the common Wiremock setup for POST requests ending in `/responses`. It also attaches a fresh request recorder.

**Data flow**: It creates a `ResponseMock`, builds a Wiremock matcher for POST plus a path regex, adds the recorder as another matcher, and returns both the builder and recorder.

**Call relations**: All normal `/responses` mount helpers start here, so they share request capture and invariant validation.

*Call graph*: calls 1 internal fn (new); called by 6 (mount_response_once, mount_response_once_match, mount_response_sequence, mount_sse_once, mount_sse_once_match, mount_sse_sequence); 3 external calls (given, method, path_regex).


##### `compact_mock`  (lines 966–972)

```
fn compact_mock() -> (MockBuilder, ResponseMock)
```

**Purpose**: Creates the common Wiremock setup for POST requests ending in `/responses/compact`. This is the compaction endpoint used in history-shortening tests.

**Data flow**: It creates a `ResponseMock`, builds a POST/path matcher for the compact endpoint, attaches the recorder, and returns the builder plus recorder.

**Call relations**: Compaction-specific mount helpers call this before adding JSON responses or custom responders.

*Call graph*: calls 1 internal fn (new); called by 3 (mount_compact_json_once_match, mount_compact_response_once, mount_compact_user_history_with_summary_sequence); 3 external calls (given, method, path_regex).


##### `models_mock`  (lines 974–980)

```
fn models_mock() -> (MockBuilder, ModelsMock)
```

**Purpose**: Creates the common Wiremock setup for GET requests ending in `/models`. It records model-catalog requests.

**Data flow**: It creates a `ModelsMock`, builds a GET/path matcher for `/models`, attaches the recorder, and returns both.

**Call relations**: All model-catalog mount helpers call this before adding their response body, delay, or ETag header.

*Call graph*: calls 1 internal fn (new); called by 3 (mount_models_once, mount_models_once_with_delay, mount_models_once_with_etag); 3 external calls (given, method, path_regex).


##### `mount_sse_once_match`  (lines 982–993)

```
async fn mount_sse_once_match(server: &MockServer, matcher: M, body: String) -> ResponseMock
```

**Purpose**: Mounts one SSE response for `/responses` with an extra matcher. It is for tests that need both stream behavior and request filtering.

**Data flow**: It receives a server, matcher, and SSE body string, builds the base mock, adds the matcher, wraps the body as an SSE HTTP response, mounts it for one use, and returns the recorder.

**Call relations**: Specialized streaming tests call this when only certain requests should consume the scripted stream.

*Call graph*: calls 2 internal fn (base_mock, sse_response); called by 27 (direct_input_to_multi_agent_v2_subagent_is_rejected, turn_start_emits_spawn_agent_item_with_effective_role_model_metadata_v2, turn_start_emits_spawn_agent_item_with_model_metadata_v2, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, v2_nested_spawn_checks_shared_active_execution_capacity, run_subagent_global_instruction_case, spawned_subagent_execpolicy_amendment_propagates_to_parent_session, context_window_error_sets_total_tokens_to_model_window, provider_auth_command_supplies_bearer_token (+15 more)).


##### `mount_sse_once`  (lines 995–1002)

```
async fn mount_sse_once(server: &MockServer, body: String) -> ResponseMock
```

**Purpose**: Mounts one SSE response for the next `/responses` POST. This is the most common way tests script one model turn.

**Data flow**: It receives a server and SSE body, builds the base mock, wraps the body as an SSE response, mounts it for one use, and returns the request recorder.

**Call relations**: Many test scenarios and higher-level helpers use this to serve a single fake stream.

*Call graph*: calls 2 internal fn (base_mock, sse_response); called by 352 (review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_forwards_client_metadata_to_responses_request_v2, turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2, selected_executor_root_exposes_plugin_skill, standalone_image_generation_is_exposed_in_code_mode_only, local_executor_does_not_expose_orchestrator_skills, turn_start_accepts_output_schema_v2, turn_start_output_schema_is_per_turn_v2, thread_inject_items_adds_raw_response_items_to_thread_history (+15 more)).


##### `mount_compact_json_once_match`  (lines 1004–1023)

```
async fn mount_compact_json_once_match(
    server: &MockServer,
    matcher: M,
    body: serde_json::Value,
) -> ResponseMock
```

**Purpose**: Mounts one JSON response for `/responses/compact` with an extra matcher. Tests use it to check compaction requests precisely.

**Data flow**: It receives a server, matcher, and JSON body, builds the compact mock, adds the matcher, creates a 200 JSON response, mounts it for one use, and returns the recorder.

**Call relations**: Compaction tests call this when the fake compact endpoint should only match a certain request shape.

*Call graph*: calls 1 internal fn (compact_mock); 2 external calls (new, clone).


##### `mount_compact_json_once`  (lines 1025–1033)

```
async fn mount_compact_json_once(server: &MockServer, body: serde_json::Value) -> ResponseMock
```

**Purpose**: Mounts one simple JSON response for `/responses/compact`. It is a shortcut for common compaction tests.

**Data flow**: It receives a server and JSON body, creates a 200 JSON response template, delegates to `mount_compact_response_once`, and returns the recorder.

**Call relations**: Remote compaction tests use this when they already know the exact compact response body.

*Call graph*: calls 1 internal fn (mount_compact_response_once); called by 19 (auto_compaction_remote_emits_started_and_completed_items, auto_compact_counts_encrypted_reasoning_before_last_user, auto_compact_runs_after_resume_when_token_usage_is_over_limit, auto_compact_runs_when_reasoning_header_clears_between_turns, auto_remote_compact_failure_stops_agent_loop, remote_compact_and_resume_refresh_stale_developer_instructions, remote_compact_filters_deferred_dynamic_tools, remote_compact_persists_replacement_history_in_rollout, remote_compact_refreshes_stale_developer_instructions_without_resume, remote_compact_replaces_history_for_followups (+9 more)); 1 external calls (new).


##### `mount_compact_user_history_with_summary_once`  (lines 1038–1043)

```
async fn mount_compact_user_history_with_summary_once(
    server: &MockServer,
    summary_text: &str,
) -> ResponseMock
```

**Purpose**: Mounts a compact endpoint that returns filtered user/developer history plus one summary item. It simulates the default remote compaction shape for one call.

**Data flow**: It receives summary text, wraps it into a one-element list, delegates to the sequence version, and returns the recorder.

**Call relations**: Compaction tests call this when one compact request should produce a realistic summary response.

*Call graph*: calls 1 internal fn (mount_compact_user_history_with_summary_sequence); called by 12 (assert_remote_manual_compact_request_parity, auto_remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_rewrites_multiple_trailing_function_call_outputs, remote_compact_runs_automatically, remote_compact_trim_estimate_uses_session_base_instructions, remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_trims_tool_search_output_to_empty_tools_array, remote_manual_compact_emits_context_compaction_items, snapshot_request_shape_remote_mid_turn_continuation_compaction, snapshot_request_shape_remote_pre_turn_compaction_including_incoming_user_message (+2 more)); 1 external calls (vec!).


##### `mount_compact_user_history_with_summary_sequence`  (lines 1047–1118)

```
async fn mount_compact_user_history_with_summary_sequence(
    server: &MockServer,
    summary_texts: Vec<String>,
) -> ResponseMock
```

**Purpose**: Mounts a compact endpoint that answers multiple compact requests with successive summary texts. It also mimics how remote compaction drops assistant and tool history.

**Data flow**: It receives a list of summaries, installs a responder that counts calls, decodes and parses each compact request, keeps only user and developer messages from its input, appends a synthetic compaction item with the next summary, and returns that JSON output.

**Call relations**: The one-summary helper delegates here, and multi-compaction tests use it directly to script several compact responses in order.

*Call graph*: calls 1 internal fn (compact_mock); called by 2 (mount_compact_user_history_with_summary_once, snapshot_request_shape_remote_mid_turn_compaction_multi_summary_reinjects_above_last_summary); 1 external calls (new).


##### `mount_compact_response_once`  (lines 1120–1130)

```
async fn mount_compact_response_once(
    server: &MockServer,
    response: ResponseTemplate,
) -> ResponseMock
```

**Purpose**: Mounts one arbitrary response template for `/responses/compact`. It is the lower-level compact-response mount helper.

**Data flow**: It receives a server and response template, builds the compact mock, serves the response once, mounts it, and returns the request recorder.

**Call relations**: Higher-level compact JSON helpers call this when they want to reuse the common compact endpoint setup.

*Call graph*: calls 1 internal fn (compact_mock); called by 4 (mount_compact_json_once, remote_mid_turn_compact_v1_sends_turn_state_over_http, remote_pre_turn_compact_response_seeds_turn_state, snapshot_request_shape_remote_pre_turn_compaction_context_window_exceeded).


##### `mount_models_once`  (lines 1132–1143)

```
async fn mount_models_once(server: &MockServer, body: ModelsResponse) -> ModelsMock
```

**Purpose**: Mounts one successful `/models` response. Tests use it to provide a fake model catalog.

**Data flow**: It receives a server and typed models response, builds the models mock, creates a JSON response, mounts it for one use, and returns the models request recorder.

**Call relations**: The general `start_mock_server` installs this by default, and model-catalog tests call it with specific catalog contents.

*Call graph*: calls 1 internal fn (models_mock); called by 40 (list_models_uses_chatgpt_remote_catalog_as_source_of_truth, new_uses_active_provider_for_model_refresh, start_mock_server, remote_model_override_uses_catalog_model_for_strict_auto_review, body_after_prefix_model_switch_budget_compacts_with_next_model, pre_sampling_compact_recovers_comp_hash_after_resume, pre_sampling_compact_runs_after_resume_and_switch_to_smaller_model, pre_sampling_compact_runs_on_switch_to_smaller_context_model, pre_sampling_compact_runs_when_comp_hash_changes, pre_sampling_compact_skips_missing_comp_hash_after_resume (+15 more)); 2 external calls (new, clone).


##### `mount_models_once_with_delay`  (lines 1145–1161)

```
async fn mount_models_once_with_delay(
    server: &MockServer,
    body: ModelsResponse,
    delay: Duration,
) -> ModelsMock
```

**Purpose**: Mounts one `/models` response that waits before replying. Tests use it to exercise timeout behavior.

**Data flow**: It receives a server, models body, and delay duration, builds the models mock, creates a delayed JSON response, mounts it once, and returns the recorder.

**Call relations**: Timeout tests use this to make the fake model catalog deliberately slow.

*Call graph*: calls 1 internal fn (models_mock); called by 1 (remote_models_request_times_out_after_5s); 2 external calls (new, clone).


##### `mount_models_once_with_etag`  (lines 1163–1180)

```
async fn mount_models_once_with_etag(
    server: &MockServer,
    body: ModelsResponse,
    etag: &str,
) -> ModelsMock
```

**Purpose**: Mounts one `/models` response with an ETag header. An ETag is a server-provided version label used for cache validation.

**Data flow**: It receives a server, models body, and ETag string, builds the models mock, creates a JSON response with the ETag header, mounts it once, and returns the recorder.

**Call relations**: Cache-refresh tests use this to verify how the client reacts to matching or changed model-catalog versions.

*Call graph*: calls 1 internal fn (models_mock); called by 2 (renews_cache_ttl_on_matching_models_etag, refresh_models_on_models_etag_mismatch_and_avoid_duplicate_models_fetch); 2 external calls (new, clone).


##### `start_mock_server`  (lines 1182–1192)

```
async fn start_mock_server() -> MockServer
```

**Purpose**: Starts a Wiremock HTTP server configured for these API tests. It also installs a default empty `/models` response so tests do not accidentally reach the network.

**Data flow**: It builds and starts a mock server with a large body print limit, mounts a one-time empty models response, and returns the server.

**Call relations**: Many integration tests call this first, then mount the specific `/responses` behavior they need.

*Call graph*: calls 1 internal fn (mount_models_once); called by 623 (create_mock_responses_server_repeating_assistant, create_mock_responses_server_sequence, create_mock_responses_server_sequence_unchecked, review_start_sends_parent_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_forwards_client_metadata_to_responses_request_v2, turn_start_sends_fork_lineage_in_turn_metadata_for_thread_fork_v2, turn_start_sends_other_subagent_lineage_after_cold_thread_resume_v2, turn_steer_updates_client_metadata_on_follow_up_responses_request_v2, auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items (+15 more)); 3 external calls (Limited, builder, new).


##### `start_websocket_server`  (lines 1199–1210)

```
async fn start_websocket_server(connections: Vec<Vec<Vec<Value>>>) -> WebSocketTestServer
```

**Purpose**: Starts a lightweight fake WebSocket server using a simple list of scripted response-event batches. It is the easy entry point for realtime tests.

**Data flow**: It receives nested lists of event batches, wraps each connection in a default `WebSocketConnectionConfig`, and delegates to the configurable server starter.

**Call relations**: Most realtime tests call this simpler helper unless they need custom headers, handshake delay, or close behavior.

*Call graph*: calls 1 internal fn (start_websocket_server_with_headers); called by 81 (turn_start_forwards_client_metadata_to_responses_websocket_request_body_v2, realtime_conversation_requires_feature_flag, realtime_conversation_stop_emits_closed_notification, realtime_conversation_streams_v2_notifications, realtime_start_can_skip_startup_context, realtime_text_output_modality_requests_text_output_and_final_transcript, realtime_webrtc_start_surfaces_backend_error, websocket_first_turn_uses_startup_prewarm_and_create, websocket_test_codex_shell_chain, websocket_v2_first_turn_drops_fast_tier_after_startup_prewarm (+15 more)).


##### `start_websocket_server_with_headers`  (lines 1212–1385)

```
async fn start_websocket_server_with_headers(
    connections: Vec<WebSocketConnectionConfig>,
) -> WebSocketTestServer
```

**Purpose**: Starts the full-featured fake WebSocket server. It records handshakes and requests, sends scripted JSON events as text frames, and can add response headers or delay accepting a connection.

**Data flow**: It binds a local TCP port, prepares shared logs and a shutdown channel, spawns a background task that accepts connections, records handshake URI and headers, reads each client message as JSON, logs it, sends the scripted events for that request, optionally closes the socket, and returns a `WebSocketTestServer` handle.

**Call relations**: The simpler WebSocket starter delegates here, and realtime tests use it directly when they need custom handshake behavior or unusual close-handshake scenarios.

*Call graph*: calls 2 internal fn (parse_ws_request_body, websocket_accept_config); called by 15 (attestation_generate_round_trip_adds_header_to_responses_websocket_handshake, new_with_main_loop_responses_server_and_sandbox, realtime_webrtc_start_emits_sdp_notification, start_websocket_server, websocket_first_turn_handles_handshake_delay_with_startup_prewarm, responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event, responses_websocket_v2_surfaces_terminal_error_without_close_handshake, conversation_webrtc_close_while_sideband_connecting_drops_pending_join, conversation_webrtc_start_posts_generated_session (+5 more)); 17 external calls (clone, new, new, new, bind, new, from, eprintln!, format!, channel (+7 more)).


##### `parse_ws_request_body`  (lines 1387–1393)

```
fn parse_ws_request_body(message: Message) -> Option<Value>
```

**Purpose**: Parses a WebSocket message into JSON if it is text or binary JSON. Non-data control messages are ignored.

**Data flow**: It receives a WebSocket message, tries JSON parsing from text or bytes for text/binary messages, and returns `Some` JSON on success or `None` otherwise.

**Call relations**: The WebSocket server task calls this for every incoming client message before recording it in the request log.

*Call graph*: called by 1 (start_websocket_server_with_headers); 2 external calls (from_slice, from_str).


##### `websocket_accept_config`  (lines 1395–1402)

```
fn websocket_accept_config() -> WebSocketConfig
```

**Purpose**: Creates the WebSocket accept configuration used by the fake server, including per-message deflate compression support.

**Data flow**: It starts from default extension settings, enables deflate compression, places those settings into a default WebSocket config, and returns it.

**Call relations**: The WebSocket server uses this config when accepting client handshakes, so tests can cover clients that negotiate compression.

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

**Purpose**: Mounts a two-step fake agent interaction: first the model asks for a tool call, then it returns a final assistant message after the tool result.

**Data flow**: It receives a server, call id, arguments, and tool name. It builds and mounts one SSE stream containing a function call, then builds and mounts a second stream containing `done`, and returns both request recorders.

**Call relations**: Shell and sandbox tests use this when they need the agent loop to perform a tool call and then finish.

*Call graph*: calls 2 internal fn (mount_sse_once, sse); called by 2 (shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox); 1 external calls (vec!).


##### `mount_sse_sequence`  (lines 1438–1475)

```
async fn mount_sse_sequence(server: &MockServer, bodies: Vec<String>) -> ResponseMock
```

**Purpose**: Mounts a sequence of SSE response bodies for successive `/responses` POSTs. It fails if the client makes more calls than scripted.

**Data flow**: It receives a server and list of SSE bodies, installs a responder with an atomic call counter, serves the next body for each request, and configures Wiremock to expect exactly that many calls.

**Call relations**: Multi-turn, retry, compaction, and tool-loop tests use this to script a whole conversation in order.

*Call graph*: calls 1 internal fn (base_mock); called by 263 (auto_compaction_local_emits_started_and_completed_items, auto_compaction_remote_emits_started_and_completed_items, thread_compact_start_triggers_compaction_and_returns_empty_response, selected_executor_plugin_exposes_its_stdio_mcp_only_to_that_thread, external_agent_config_import_compacts_huge_session_before_first_follow_up, run_image_edit_test, standalone_image_generation_failure_emits_terminal_item, standalone_image_generation_is_callable_from_code_mode_only, standalone_image_generation_returns_saved_path_hint_to_model, orchestrator_skill_can_read_referenced_resource_without_an_executor (+15 more)); 1 external calls (new).


##### `mount_response_sequence`  (lines 1479–1514)

```
async fn mount_response_sequence(
    server: &MockServer,
    responses: Vec<ResponseTemplate>,
) -> ResponseMock
```

**Purpose**: Mounts a sequence of arbitrary HTTP response templates for successive `/responses` POSTs. This is the non-SSE version of the ordered response helper.

**Data flow**: It receives a server and response templates, installs a counter-based responder that clones the next template per request, and tells Wiremock to expect exactly the provided number of calls.

**Call relations**: Tests that need mixed status codes, headers, or custom bodies use this ordered response helper.

*Call graph*: calls 1 internal fn (base_mock); called by 18 (external_auth_refresh_error_fails_turn, external_auth_refresh_invalid_access_token_fails_turn, external_auth_refresh_mismatched_workspace_fails_turn, external_auth_refreshes_on_unauthorized, turn_steer_updates_client_metadata_on_follow_up_responses_request_v2, thread_resume_rejoins_running_thread_even_with_override_mismatch, thread_settings_update_while_turn_is_active_emits_notification, turn_start_tracks_turn_event_analytics, guardian_review_surfaces_responses_api_errors_in_rejection_reason, responses_stream_includes_turn_metadata_header_for_git_workspace_e2e (+8 more)); 1 external calls (new).


##### `validate_request_body_invariants`  (lines 1526–1643)

```
fn validate_request_body_invariants(request: &wiremock::Request)
```

**Purpose**: Checks that a captured `/responses` request has consistent tool-call history. It catches orphan outputs, missing call ids, and calls without matching outputs.

**Data flow**: It ignores non-POST or non-`/responses` requests, decodes and parses the body, reads the `input` array, gathers call ids for function, custom tool, tool search, and local shell calls and outputs, then asserts that outputs match prior calls and calls have matching outputs.

**Call relations**: `ResponseMock::matches` runs this automatically on every captured `/responses` POST, so tests fail at the moment bad request history is sent.

*Call graph*: calls 1 internal fn (decode_body_bytes); called by 1 (matches); 2 external calls (assert!, from_slice).


### `core/tests/common/streaming_sse.rs`

`test` · `test setup, test request handling, and test teardown`

Real streaming APIs do not send a full answer all at once. They send small pieces over time, and clients must behave correctly while waiting, reading, cancelling, or receiving the final event. This file builds a small local test server that copies just enough of that behavior to test the rest of the system without calling a real external service.

The server listens on a random local port. It understands two routes. A GET request to `/v1/models` returns an empty JSON model list. A POST request to `/v1/responses` records the request body, then sends one queued SSE response stream. Each stream is a list of chunks. A chunk may have a “gate”, which is a one-time signal; if present, the server waits until the test opens that gate before writing the chunk. This is like a test-controlled turnstile in front of each piece of output.

The file also gives tests ways to inspect which request bodies arrived, wait until enough requests have been seen, and shut the server down cleanly. The built-in tests prove the helper behaves predictably: routes return the right status codes, chunks stay in order, gated chunks wait, queued responses are used first-in-first-out, and shutdown stops the accept loop.

#### Function details

##### `StreamingSseServer::uri`  (lines 30–32)

```
fn uri(&self) -> &str
```

**Purpose**: Returns the base web address of the local test server. Tests use this address when they need to point a client at the fake streaming service.

**Data flow**: It reads the server handle’s stored URI string and returns it as borrowed text. Nothing is changed.

**Call relations**: Higher-level test setup, including `build_with_streaming_server`, calls this after the server has started so the code under test can connect to the fake service.

*Call graph*: called by 1 (build_with_streaming_server).


##### `StreamingSseServer::requests`  (lines 34–36)

```
async fn requests(&self) -> Vec<Vec<u8>>
```

**Purpose**: Returns a snapshot of all request bodies the fake server has received on `/v1/responses`. This lets a test check what the client actually sent.

**Data flow**: It locks the shared request list, copies the stored byte arrays, and returns the copy. The original list remains in the server for later checks.

**Call relations**: This is part of the server handle that tests can call after making requests. It reads the same shared list that the server’s POST handling code appends to.


##### `StreamingSseServer::wait_for_request_count`  (lines 38–45)

```
async fn wait_for_request_count(&self, count: usize)
```

**Purpose**: Waits until the fake server has received at least a chosen number of response requests. This helps tests pause until the client has really contacted the server.

**Data flow**: It repeatedly checks the shared request list length. If there are not enough requests yet, it waits for a notification from the server task, then checks again. It returns only when the count is reached.

**Call relations**: The server’s POST path notifies this waiter after recording a request body. Tests use it to avoid races where they inspect the server before the client has sent anything.


##### `StreamingSseServer::shutdown`  (lines 47–50)

```
async fn shutdown(self)
```

**Purpose**: Stops the local test server and waits for its background task to finish. This prevents leftover test servers from continuing to accept connections after a test ends.

**Data flow**: It consumes the server handle, sends a one-time shutdown signal, then waits for the spawned server task to exit. It ignores errors, because shutdown may already have happened.

**Call relations**: Many tests call this at the end of their flow. It uses the one-shot sender created by `start_streaming_sse_server` to tell the accept loop to break.

*Call graph*: 1 external calls (send).


##### `start_streaming_sse_server`  (lines 59–173)

```
async fn start_streaming_sse_server(
    responses: Vec<Vec<StreamingSseChunk>>,
) -> (StreamingSseServer, Vec<oneshot::Receiver<i64>>)
```

**Purpose**: Starts the fake streaming server and preloads the SSE responses it should send. Tests call this when they need a controllable stand-in for the real streaming API.

**Data flow**: It receives a list of response streams, where each stream is a list of chunks. It binds a local TCP listener, stores the streams and completion signals in shared queues, starts a background accept loop, and returns a server handle plus receivers that fire when each stream finishes.

**Call relations**: This is the main setup function used by many tests, including checks for normal streaming, gated chunks, missing response queues, bad requests, unknown routes, request-body draining, and shutdown. The background task it creates calls helper routines to read HTTP requests, parse routes, read bodies, choose the next queued stream, write HTTP or SSE responses, and timestamp completions.

*Call graph*: called by 28 (thread_unsubscribe_during_turn_keeps_turn_running, gated_chunks_wait_for_signal_and_preserve_order, get_models_returns_empty_list, malformed_request_returns_400, multiple_responses_are_fifo_and_completion_timestamps_monotonic, none_gate_streams_immediately, post_responses_streams_in_order_and_closes, post_responses_with_no_queue_returns_500, responses_post_drains_request_body, shutdown_terminates_accept_loop (+15 more)); 12 external calls (clone, new, new, bind, new, new, with_capacity, from, format!, channel (+2 more)).


##### `take_next_stream`  (lines 180–187)

```
async fn take_next_stream(
    state: &TokioMutex<StreamingSseState>,
) -> Option<(Vec<StreamingSseChunk>, oneshot::Sender<i64>)>
```

**Purpose**: Takes the next queued response stream and its matching completion sender. It keeps response data and completion notification paired together.

**Data flow**: It locks the shared server state, removes the first stream from the response queue, removes the first completion sender from the completion queue, and returns them together. If either queue is empty, it returns nothing.

**Call relations**: The POST `/v1/responses` handling code uses this when a client asks for a stream. The test `tests::take_next_stream_consumes_in_lockstep` calls it directly to confirm streams and completion signals are consumed in matching first-in-first-out order.

*Call graph*: called by 1 (take_next_stream_consumes_in_lockstep); 1 external calls (lock).


##### `read_http_request`  (lines 189–206)

```
async fn read_http_request(stream: &mut tokio::net::TcpStream) -> (String, Vec<u8>)
```

**Purpose**: Reads just the HTTP request headers from a TCP connection, while preserving any body bytes that were already received. This matters because network reads may grab both headers and part of the body at once.

**Data flow**: It reads bytes from the stream into a buffer until it finds the blank line that ends HTTP headers. It returns the header text and any extra bytes after that separator as the first part of the body.

**Call relations**: The connection task created by `start_streaming_sse_server` uses this before deciding which route was requested. The test `tests::read_http_request_returns_after_header_terminator` calls it directly to prove it stops as soon as headers are complete.

*Call graph*: calls 1 internal fn (header_terminator_index); called by 1 (read_http_request_returns_after_header_terminator); 3 external calls (from_utf8_lossy, read, new).


##### `parse_request_line`  (lines 208–214)

```
fn parse_request_line(request: &str) -> Option<(&str, &str)>
```

**Purpose**: Pulls the HTTP method and path from the first line of a request. For example, it can turn `GET /v1/models HTTP/1.1` into `GET` and `/v1/models`.

**Data flow**: It reads the first line of the request text, splits it on whitespace, and returns the first two parts if both exist. If the line is missing or incomplete, it returns nothing.

**Call relations**: The server’s per-connection code uses this after reading headers to decide whether to serve models, stream responses, reject a bad request, or return not found. The test `tests::parse_request_line_handles_valid_and_invalid` checks both valid and invalid examples.


##### `header_terminator_index`  (lines 216–218)

```
fn header_terminator_index(buf: &[u8]) -> Option<usize>
```

**Purpose**: Finds where the HTTP headers end inside a byte buffer. HTTP marks that point with a blank line, written as `\r\n\r\n`.

**Data flow**: It scans the bytes for the four-byte header-ending pattern. It returns the starting position of that pattern, or nothing if the headers are not complete yet.

**Call relations**: `read_http_request` calls this after each network read to know when it can stop reading headers and hand back any leftover body bytes.

*Call graph*: called by 1 (read_http_request).


##### `content_length`  (lines 220–231)

```
fn content_length(headers: &str) -> Option<usize>
```

**Purpose**: Reads the `Content-Length` header from HTTP request headers. That number tells the server how many body bytes it should expect.

**Data flow**: It skips the request line, checks each header line, compares the header name without caring about letter case, and parses the value as a number. It returns that number if present and valid.

**Call relations**: `read_request_body` calls this before deciding whether more bytes must be read from the stream.

*Call graph*: called by 1 (read_request_body).


##### `read_request_body`  (lines 233–255)

```
async fn read_request_body(
    stream: &mut tokio::net::TcpStream,
    headers: &str,
    mut body_prefix: Vec<u8>,
) -> std::io::Result<Vec<u8>>
```

**Purpose**: Reads the full HTTP request body, including any body bytes that were already captured while reading headers. This lets the fake server store the exact POST payload sent by the client.

**Data flow**: It receives the stream, header text, and an initial body prefix. If there is no content length, it returns the prefix. If the prefix is too long, it trims it. If more bytes are needed, it reads exactly the remaining amount and appends them, then returns the complete body.

**Call relations**: The server’s GET and POST route handling uses this to drain request bodies before replying. It relies on `content_length` to know how much body data to read.

*Call graph*: calls 1 internal fn (content_length); 2 external calls (read_exact, vec!).


##### `write_sse_headers`  (lines 257–260)

```
async fn write_sse_headers(stream: &mut tokio::net::TcpStream) -> std::io::Result<()>
```

**Purpose**: Writes the HTTP headers that announce an SSE stream. These headers tell the client that the response body will be event-stream text and that the connection will close when done.

**Data flow**: It sends a fixed HTTP 200 header block to the TCP stream. It returns success or an I/O error from the write.

**Call relations**: The POST `/v1/responses` handler calls this before writing the queued chunks. If writing these headers fails, that connection task stops early.

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

**Purpose**: Writes a complete non-streaming HTTP response, including status, content type, body length, body text, and connection close. It is used for simple JSON or error replies.

**Data flow**: It receives a stream, status number, body text, and content type. It formats headers using the body length, writes headers and body to the stream, then shuts down the connection.

**Call relations**: The server’s route handling uses this for `/v1/models`, bad requests, missing queued responses, and unknown routes.

*Call graph*: 3 external calls (shutdown, write_all, format!).


##### `unix_ms_now`  (lines 277–282)

```
fn unix_ms_now() -> i64
```

**Purpose**: Returns the current time as milliseconds since the Unix epoch, which is the common timestamp starting point of 1970-01-01 UTC. The fake server uses it to mark when a stream finished sending.

**Data flow**: It reads the system clock, measures the duration since the Unix epoch, converts that duration to milliseconds, and returns it as a signed integer. If the clock is somehow before the epoch, it falls back to zero.

**Call relations**: After the POST stream loop sends the final chunk, the server calls this and sends the timestamp through the stream’s completion channel.

*Call graph*: 1 external calls (now).


##### `tests::split_response`  (lines 293–297)

```
fn split_response(response: &str) -> (&str, &str)
```

**Purpose**: Splits a raw HTTP response string into headers and body. Test assertions use it so they can check status and content separately.

**Data flow**: It receives the whole response text, looks for the blank line between headers and body, and returns the two pieces. If the separator is missing, the test fails immediately.

**Call relations**: Many tests call this after `tests::read_to_end` gathers a full response from the fake server.


##### `tests::status_code`  (lines 299–305)

```
fn status_code(headers: &str) -> u16
```

**Purpose**: Extracts the numeric HTTP status code from response headers. This keeps tests focused on expected results like 200, 400, 404, or 500.

**Data flow**: It reads the first header line, splits it into words, takes the second word as the status code, parses it as a number, and returns it. Bad formatting causes the test to fail.

**Call relations**: Route-behavior tests call this after `tests::split_response` to verify the server returned the expected kind of response.


##### `tests::header_value`  (lines 307–318)

```
fn header_value(headers: &'a str, name: &str) -> Option<&'a str>
```

**Purpose**: Finds one named header in a block of HTTP response headers. Tests use it to confirm the server marks JSON, plain text, and SSE responses correctly.

**Data flow**: It scans header lines after the status line, splits each at the first colon, compares the name without caring about letter case, and returns the trimmed value if found.

**Call relations**: Several response tests call this after splitting the response, especially to check `content-type`.


##### `tests::connect`  (lines 320–325)

```
async fn connect(uri: &str) -> TcpStream
```

**Purpose**: Opens a raw TCP connection to the fake server from its URI. This lets tests send hand-written HTTP requests and inspect exact bytes.

**Data flow**: It receives a URI like `http://127.0.0.1:port`, removes the `http://` prefix, connects a TCP stream to that address, and returns the stream.

**Call relations**: Most server behavior tests call this after `start_streaming_sse_server` so they can drive the fake server directly.

*Call graph*: 1 external calls (connect).


##### `tests::read_to_end`  (lines 327–331)

```
async fn read_to_end(stream: &mut TcpStream) -> String
```

**Purpose**: Reads everything left on a TCP stream until the server closes the connection. Tests use it when they expect a complete response and no more data.

**Data flow**: It creates a byte buffer, reads all remaining bytes from the stream into it, converts the bytes to text, and returns that text.

**Call relations**: Many tests call this after `tests::send_request` to collect the server’s full reply before splitting and checking it.

*Call graph*: 3 external calls (from_utf8_lossy, read_to_end, new).


##### `tests::read_until`  (lines 333–354)

```
async fn read_until(stream: &mut TcpStream, needle: &str) -> (String, String)
```

**Purpose**: Reads from a TCP stream until a chosen marker appears. Tests use it to stop right after response headers, before later streamed chunks arrive.

**Data flow**: It reads chunks of bytes into a buffer, searches for the marker text, and when found returns the text up through the marker plus any bytes that came after it. If the stream ends first, it returns what it has and an empty remainder.

**Call relations**: Streaming timing tests call this to verify that headers are sent immediately while gated body chunks are still waiting.

*Call graph*: 4 external calls (from_utf8_lossy, new, read, new).


##### `tests::send_request`  (lines 356–361)

```
async fn send_request(stream: &mut TcpStream, request: &str)
```

**Purpose**: Writes a raw HTTP request string to a TCP stream. This gives tests precise control over request method, path, and headers.

**Data flow**: It receives an open stream and request text, writes the request bytes to the stream, and fails the test if the write does not complete.

**Call relations**: Most tests call this after `tests::connect` and before reading the server response.

*Call graph*: 1 external calls (write_all).


##### `tests::get_models_returns_empty_list`  (lines 364–388)

```
async fn get_models_returns_empty_list()
```

**Purpose**: Checks that the fake server’s `/v1/models` endpoint returns a successful empty model list. This proves the helper can satisfy code that probes available models before streaming.

**Data flow**: It starts the server with no queued streams, sends a raw GET request, reads the response, checks the status and content type, parses the JSON body, and shuts the server down.

**Call relations**: It exercises `start_streaming_sse_server`, `tests::connect`, `tests::send_request`, `tests::read_to_end`, and `tests::split_response` together as a basic route test.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 7 external calls (new, assert_eq!, connect, read_to_end, send_request, split_response, from_str).


##### `tests::post_responses_streams_in_order_and_closes`  (lines 391–424)

```
async fn post_responses_streams_in_order_and_closes()
```

**Purpose**: Checks that a queued response stream is sent chunk by chunk in the original order and that the connection closes afterward. It also confirms a completion timestamp is sent.

**Data flow**: It queues two chunks, starts the server, sends a POST with an empty body, reads the full response, checks the SSE headers and combined body text, verifies end-of-file, waits for the completion timestamp, and shuts down.

**Call relations**: It exercises the normal POST streaming path created by `start_streaming_sse_server` and uses the shared test helpers for connection, sending, reading, and response splitting.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 7 external calls (assert!, assert_eq!, connect, read_to_end, send_request, split_response, vec!).


##### `tests::none_gate_streams_immediately`  (lines 427–445)

```
async fn none_gate_streams_immediately()
```

**Purpose**: Confirms that a chunk without a gate is sent right away. This protects the meaning of `gate: None`: no artificial waiting.

**Data flow**: It queues one ungated chunk, sends a POST, reads through the response headers, then reads the body and checks that the chunk arrived immediately.

**Call relations**: It uses `start_streaming_sse_server`, `tests::connect`, `tests::send_request`, `tests::read_until`, and `tests::split_response` to focus on timing at the start of a stream.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 7 external calls (assert_eq!, connect, read_until, send_request, split_response, format!, vec!).


##### `tests::post_responses_with_no_queue_returns_500`  (lines 448–462)

```
async fn post_responses_with_no_queue_returns_500()
```

**Purpose**: Checks that a POST to `/v1/responses` fails clearly when no response stream was queued. This helps catch test setup mistakes.

**Data flow**: It starts the server with an empty response queue, sends a POST, reads the reply, and verifies a 500 plain-text response saying there are no queued responses.

**Call relations**: It exercises the path where `take_next_stream` cannot supply a stream inside the server started by `start_streaming_sse_server`.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 6 external calls (new, assert_eq!, connect, read_to_end, send_request, split_response).


##### `tests::gated_chunks_wait_for_signal_and_preserve_order`  (lines 465–514)

```
async fn gated_chunks_wait_for_signal_and_preserve_order()
```

**Purpose**: Checks that gated chunks do not appear until their matching signal is sent, and that later chunks cannot jump ahead of earlier ones. This is the core timing behavior this helper exists to provide.

**Data flow**: It creates two one-time gate signals, queues two gated chunks, sends a POST, confirms headers arrive but no body arrives early, opens the first gate and reads the first chunk, confirms the second still waits, then opens the second gate and reads the rest.

**Call relations**: It uses `start_streaming_sse_server` and the stream-reading helpers to prove the server’s per-chunk gate logic works in realistic network conditions.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 11 external calls (from_millis, assert!, assert_eq!, connect, read_to_end, read_until, send_request, split_response, channel, timeout (+1 more)).


##### `tests::multiple_responses_are_fifo_and_completion_timestamps_monotonic`  (lines 517–558)

```
async fn multiple_responses_are_fifo_and_completion_timestamps_monotonic()
```

**Purpose**: Checks that multiple queued response streams are served first-in-first-out and that completion timestamps are sensible. FIFO means the first queued item is the first one used.

**Data flow**: It queues two separate streams, sends two POST requests in sequence, verifies the first response gets the first body and the second gets the second body, then waits for both completion timestamps and checks they are positive and nondecreasing.

**Call relations**: It exercises the shared stream queue created by `start_streaming_sse_server`, indirectly relying on `take_next_stream` to keep responses and completions paired.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 7 external calls (assert!, assert_eq!, connect, read_to_end, send_request, split_response, vec!).


##### `tests::unknown_route_returns_404`  (lines 561–575)

```
async fn unknown_route_returns_404()
```

**Purpose**: Checks that the fake server returns a plain 404 response for paths it does not recognize. This proves unexpected routes do not accidentally look successful.

**Data flow**: It starts the server, sends a GET request to an unknown path, reads the response, and checks the status, content type, and body text.

**Call relations**: It uses the same raw TCP helpers as other route tests and exercises the fallback branch in the server started by `start_streaming_sse_server`.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 6 external calls (new, assert_eq!, connect, read_to_end, send_request, split_response).


##### `tests::malformed_request_returns_400`  (lines 578–588)

```
async fn malformed_request_returns_400()
```

**Purpose**: Checks that a badly formed HTTP request is rejected with a 400 response. This verifies the helper does not crash or behave unpredictably on invalid input.

**Data flow**: It starts the server, sends the invalid text `BAD` as a request, reads the response, and verifies the plain-text `bad request` result.

**Call relations**: It exercises the server path where `parse_request_line` cannot find both a method and path.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 6 external calls (new, assert_eq!, connect, read_to_end, send_request, split_response).


##### `tests::responses_post_drains_request_body`  (lines 591–626)

```
async fn responses_post_drains_request_body()
```

**Purpose**: Checks that the server reads the full POST body before streaming its response. This matters for real HTTP clients, which expect the server to consume the request payload properly.

**Data flow**: It starts the server with one SSE response, sends a JSON POST using a normal HTTP client, verifies the status is OK, reads the streamed bytes, checks they match the queued body, waits for the completion timestamp, and shuts down.

**Call relations**: It exercises `start_streaming_sse_server` through `reqwest`, a real HTTP client library, rather than the file’s raw TCP test helpers. This specifically verifies the `read_request_body` behavior in the POST route.

*Call graph*: calls 2 internal fn (new, start_streaming_sse_server); 5 external calls (assert!, assert_eq!, format!, json!, vec!).


##### `tests::read_http_request_returns_after_header_terminator`  (lines 629–657)

```
async fn read_http_request_returns_after_header_terminator()
```

**Purpose**: Checks that `read_http_request` returns as soon as it sees the end of headers. This prevents tests from hanging while waiting for a body that is not coming.

**Data flow**: It starts a temporary listener, accepts one connection, calls `read_http_request`, sends a header-only GET request from a client, and verifies the function returns the complete headers with an empty body prefix within a short timeout.

**Call relations**: This test calls `read_http_request` directly rather than going through `start_streaming_sse_server`, so it isolates the low-level header-reading behavior.

*Call graph*: calls 1 internal fn (read_http_request); 8 external calls (from_millis, bind, connect, assert!, assert_eq!, channel, spawn, timeout).


##### `tests::parse_request_line_handles_valid_and_invalid`  (lines 660–667)

```
fn parse_request_line_handles_valid_and_invalid()
```

**Purpose**: Checks that request-line parsing accepts a normal HTTP request line and rejects empty or incomplete ones. This protects the server’s bad-request behavior.

**Data flow**: It passes three strings into `parse_request_line`: empty text, incomplete text, and a valid GET line. It verifies the first two return nothing and the valid one returns the expected method and path.

**Call relations**: This test directly covers `parse_request_line`, which the server uses before routing each request.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::take_next_stream_consumes_in_lockstep`  (lines 670–701)

```
async fn take_next_stream_consumes_in_lockstep()
```

**Purpose**: Checks that queued streams and their completion senders are removed together in matching order. This prevents a completion signal for one stream from being attached to another stream by mistake.

**Data flow**: It builds a test state with two streams and two completion senders, calls `take_next_stream` twice, verifies the returned stream bodies, sends test completion values through the returned senders, and confirms the matching receivers get those values. A third call correctly returns nothing.

**Call relations**: This test calls `take_next_stream` directly to isolate the queue behavior used by the POST streaming path.

*Call graph*: calls 1 internal fn (take_next_stream); 6 external calls (new, from, assert!, assert_eq!, channel, vec!).


##### `tests::shutdown_terminates_accept_loop`  (lines 704–708)

```
async fn shutdown_terminates_accept_loop()
```

**Purpose**: Checks that calling shutdown actually stops the server’s background accept loop promptly. This keeps tests from leaking background tasks.

**Data flow**: It starts the fake server, calls `server.shutdown()` inside a short timeout, and verifies shutdown completes before the timeout expires.

**Call relations**: It exercises `start_streaming_sse_server` and `StreamingSseServer::shutdown` together, focusing on teardown rather than request handling.

*Call graph*: calls 1 internal fn (start_streaming_sse_server); 4 external calls (from_millis, new, assert!, timeout).


### Harness builders
These harness modules construct the main Codex test fixture and specialized executable or shell-based variants for integration scenarios.

### `core/tests/common/zsh_fork.rs`

`test` · `test setup`

These helpers exist so several tests can all ask the same question in the same way: “Can this machine run the zsh-fork shell tests, and if so, how do we configure Codex for them?” The zsh-fork mode depends on a particular zsh binary and on an exec wrapper, which is a small program used to intercept process launches. If either piece is missing or the zsh build does not support the needed interception behavior, the tests should be skipped rather than fail for the wrong reason.

The file centers on `ZshForkRuntime`, a small bundle of paths: where the test zsh lives and where the exec wrapper binary lives. Once that bundle is available, it can be applied to a test `Config`. Applying it turns on the shell tool, turns on the zsh-fork feature, points Codex at the test zsh and wrapper, disables login-shell behavior, and installs the requested approval and permission settings.

The builder functions then use the common `test_codex` test harness to create a ready-to-run `TestCodex`. One builder sets up the normal shell tool path. The other also enables the newer “unified exec” path, which is an experimental execution route used by separate tests. In short, this file is like a test kitchen prep station: it gathers ingredients, checks they are usable, and hands each test a correctly prepared Codex instance.

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

**Purpose**: This method edits a test configuration so Codex will run shell commands through the zsh-fork path. Tests use it to make sure the same zsh binary, wrapper program, approval rule, and permission profile are all installed together.

**Data flow**: It starts with a mutable `Config`, an approval policy, and a permission profile. It turns on the shell and zsh-fork features, copies in the stored zsh and wrapper paths, disables login-shell permission, sets how approvals should work, and applies the chosen permission profile. The result is not returned as a new value; the original config is changed in place.

**Call relations**: The two test-builder functions call this inside their configuration callback while constructing a `TestCodex`. It uses `allow_any` to wrap the requested approval policy in a form the config accepts, and it clones the stored paths so the runtime object can safely supply them to the config.

*Call graph*: calls 1 internal fn (allow_any); 1 external calls (clone).


##### `restrictive_workspace_write_profile`  (lines 47–54)

```
fn restrictive_workspace_write_profile() -> PermissionProfile
```

**Purpose**: This function creates a strict permission profile for tests that should allow writing in the workspace but keep network access and temporary-directory shortcuts restricted. It gives tests a consistent “locked down but writable project folder” setup.

**Data flow**: It takes no input. It asks `PermissionProfile::workspace_write_with` to build a workspace-write profile with no extra writable roots, restricted network access, and exclusions for both the temp-directory environment variable and `/tmp`. It returns that finished `PermissionProfile` to the caller.

**Call relations**: Several zsh-fork tests call this when they need the same restrictive sandbox rules. It hands the resulting profile to the test setup path, usually through `build_zsh_fork_test` or the unified-exec variant, so the test Codex instance enforces those limits.

*Call graph*: calls 1 internal fn (workspace_write_with); called by 6 (env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, shell_zsh_fork_skill_scripts_ignore_declared_permissions, shell_zsh_fork_still_enforces_workspace_write_sandbox, unified_exec_zsh_fork_parent_approval_escalates_intercepted_exec, unified_exec_zsh_fork_parent_approval_keeps_explicit_prompt_rule).


##### `zsh_fork_runtime`  (lines 56–77)

```
fn zsh_fork_runtime(test_name: &str) -> Result<Option<ZshForkRuntime>>
```

**Purpose**: This function decides whether a zsh-fork test can run on the current machine and, if it can, returns the runtime paths needed for that test. If the environment is not ready, it returns `None` so the test can skip cleanly.

**Data flow**: It receives the test name, mainly so skip messages can say which test was skipped. It first looks for the test zsh path. If that is missing, it returns `Ok(None)`. Then it checks whether that zsh supports the needed exec-wrapper interception behavior. If not, it prints a skip message and returns `Ok(None)`. Finally, it tries to find the `codex-execve-wrapper` binary. If that is unavailable, it also prints a skip message and returns `Ok(None)`. When all checks pass, it returns `Ok(Some(ZshForkRuntime { ... }))` containing both paths.

**Call relations**: Individual zsh-fork tests call this near the start of their setup. Internally it relies on `find_test_zsh_path` to locate and fetch the shared zsh binary, on `supports_exec_wrapper_intercept` to prove the binary behaves as needed, and on `cargo_bin` to locate the wrapper executable.

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

**Purpose**: This asynchronous helper builds a normal zsh-fork `TestCodex` instance. Tests use it after they already have a valid `ZshForkRuntime` and want a configured Codex test harness connected to a mock server.

**Data flow**: It receives a mock server, the runtime paths, an approval policy, a permission profile, and a pre-build hook that can prepare the test directory. It creates a `test_codex` builder, attaches the pre-build hook, and adds a config-editing callback that applies the zsh-fork runtime settings. It then builds the test Codex instance asynchronously and returns it as a `Result<TestCodex>`.

**Call relations**: Several zsh-fork tests call this after `zsh_fork_runtime` says the environment is usable. It hands configuration work to `ZshForkRuntime::apply_to_config`, then hands the completed builder to the shared test harness so the actual `TestCodex` can be created.

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

**Purpose**: This asynchronous helper builds a zsh-fork `TestCodex` instance that also uses the experimental unified execution path. It is for tests that need to check how zsh-fork behavior works under that newer execution system.

**Data flow**: It receives the same inputs as the normal builder: a mock server, runtime paths, approval policy, permission profile, and pre-build hook. It creates a `test_codex` builder, installs the hook, applies the normal zsh-fork config, then additionally turns on the experimental unified exec flag and enables the unified exec features. It builds and returns the finished `TestCodex` asynchronously.

**Call relations**: The helper `build_unified_exec_zsh_fork_test_or_skip` calls this when it has a usable runtime. This function first reuses `ZshForkRuntime::apply_to_config` for the common zsh-fork setup, then layers on the unified-exec-specific feature switches before handing control to the shared test builder.

*Call graph*: calls 1 internal fn (test_codex); called by 1 (build_unified_exec_zsh_fork_test_or_skip).


##### `find_test_zsh_path`  (lines 124–142)

```
fn find_test_zsh_path() -> Result<Option<PathBuf>>
```

**Purpose**: This private helper finds the zsh binary that the zsh-fork tests are supposed to use. It hides the details of locating the repository file and fetching it through DotSlash, a tool-style indirection that can download or resolve the real executable.

**Data flow**: It starts with no direct input. It asks for the repository root, builds the expected path to the shared zsh DotSlash file, and checks that the file exists. If it does not exist, it prints a skip message and returns `Ok(None)`. If the file exists, it tries to fetch or resolve it with `fetch_dotslash_file`. On success it returns `Ok(Some(path))`; on failure it prints the error and returns `Ok(None)`.

**Call relations**: `zsh_fork_runtime` calls this as its first readiness check. This helper does not build the full runtime by itself; it only supplies the zsh path, which `zsh_fork_runtime` then validates further with `supports_exec_wrapper_intercept`.

*Call graph*: called by 1 (zsh_fork_runtime); 3 external calls (repo_root, fetch_dotslash_file, eprintln!).


##### `supports_exec_wrapper_intercept`  (lines 144–154)

```
fn supports_exec_wrapper_intercept(zsh_path: &Path) -> bool
```

**Purpose**: This private helper checks whether a given zsh binary honors the `EXEC_WRAPPER` interception mechanism needed by the tests. In plain terms, it makes sure zsh will let the wrapper stand in front of programs that zsh launches.

**Data flow**: It receives a path to a zsh executable. It runs that zsh with a simple command that would normally execute `/usr/bin/true`, but it sets the `EXEC_WRAPPER` environment variable to `/usr/bin/false`. If interception works, the wrapper causes the command to fail, so the function returns `true` when the process exits unsuccessfully. If the command succeeds or cannot be run, it returns `false`.

**Call relations**: `zsh_fork_runtime` calls this after finding the zsh path and before looking for the wrapper binary. Its answer decides whether tests using that zsh should continue or be skipped with an explanatory message.

*Call graph*: called by 1 (zsh_fork_runtime); 1 external calls (new).


### `core/tests/common/test_codex.rs`

`test` · `test setup and test turn execution`

Most Codex tests need the same stage set: a temporary home folder, a temporary project folder, fake authentication, a mock OpenAI-style server, and a running Codex thread that can accept user prompts. This file builds that stage so individual tests can focus on the behavior they care about instead of repeating setup code.

The main idea is like a theatre rehearsal room. `TestCodexBuilder` chooses the props: model name, config changes, shell choice, cloud config, extensions, and workspace files. It then creates a `TestCodex`, which wraps the live Codex thread plus its temporary folders and execution environment. `TestCodexHarness` adds an HTTP mock server and convenience methods for writing files, submitting prompts, and reading what Codex sent back to the model.

The file also supports remote execution tests. When a remote test environment is configured, it creates a per-test remote working directory and cleans it up later, including Docker cleanup when needed. The submit helpers do more than send text: they attach approval and sandbox settings, wait for a turn to start, then wait for that same turn to finish. This prevents tests from racing ahead before Codex has completed its work.

#### Function details

##### `RecordingUserInstructionsProvider::new`  (lines 85–90)

```
fn new(inner: Arc<dyn UserInstructionsProvider>) -> Self
```

**Purpose**: Creates a wrapper around another user-instructions provider so tests can count how many times instructions are loaded. This is useful when a test needs to prove that instructions are not reloaded too often or are loaded at the right moments.

**Data flow**: It receives an existing provider, stores it, and starts a counter at zero. The result is a new recording provider that behaves like the original provider but keeps a load count.

**Call relations**: Tests that check instruction-loading behavior call this before building Codex. Later, when Codex asks for instructions, the wrapper forwards the request to the inner provider.

*Call graph*: called by 2 (loads_user_instructions_without_a_primary_environment, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot); 1 external calls (new).


##### `RecordingUserInstructionsProvider::load_count`  (lines 92–94)

```
fn load_count(&self) -> usize
```

**Purpose**: Returns how many times the wrapped instruction provider has been asked to load instructions. Tests use this as an observable counter.

**Data flow**: It reads the internal atomic counter, which is safe to read even when multiple tasks are running, and returns the number as a normal integer.

**Call relations**: After a test runs one or more Codex turns, it can call this to confirm how often `load_user_instructions` was triggered.

*Call graph*: 1 external calls (load).


##### `RecordingUserInstructionsProvider::load_user_instructions`  (lines 98–101)

```
fn load_user_instructions(&self) -> LoadUserInstructionsFuture<'_>
```

**Purpose**: Implements the instruction-loading behavior while recording that a load happened. It keeps the test-visible count accurate without changing the real instructions returned.

**Data flow**: A Codex thread calls it with no explicit input. It increments the counter, then delegates to the wrapped provider and returns that provider's future result.

**Call relations**: This is called by Codex wherever a normal `UserInstructionsProvider` would be used. It hands off to the inner provider so the rest of the system sees the same instruction content.

*Call graph*: 1 external calls (fetch_add).


##### `local`  (lines 104–109)

```
fn local(cwd: AbsolutePathBuf) -> TurnEnvironmentSelection
```

**Purpose**: Builds a turn-environment selection that points at the local execution environment and a chosen working directory. Tests use it when they need to say, "run this turn here."

**Data flow**: It receives an absolute path, converts it into a path URI, and combines it with the known local environment identifier. It returns one environment selection.

**Call relations**: Higher-level helpers and tests use this when constructing environment choices for a turn, especially when comparing local and remote execution routing.

*Call graph*: calls 1 internal fn (from_abs_path); called by 3 (default_turn_does_not_overlay_legacy_fallback_cwd_onto_stored_thread_environments, exec_command_routes_to_selected_remote_environment, view_image_routes_to_selected_remote_environment).


##### `local_selections`  (lines 111–113)

```
fn local_selections(cwd: AbsolutePathBuf) -> TurnEnvironmentSelections
```

**Purpose**: Builds the full environment-selection object for a turn that should use the local workspace. It wraps the single local selection in the collection format the protocol expects.

**Data flow**: It receives a working directory path, clones it, creates a `local` selection from it, and returns a `TurnEnvironmentSelections` value.

**Call relations**: Many tests use this helper when they need explicit local-environment settings instead of relying on defaults.

*Call graph*: calls 1 internal fn (new); called by 72 (user_turn_updates_approvals_reviewer, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command, submit_turn, remote_model_override_uses_catalog_model_for_strict_auto_review, user_turn_collaboration_mode_overrides_model_and_effort, user_turn_explicit_reasoning_summary_overrides_model_catalog_default, collaboration_instructions_added_on_user_turn, collaboration_instructions_omitted_when_disabled (+15 more)); 2 external calls (clone, vec!).


##### `TestEnv::local`  (lines 125–137)

```
async fn local() -> Result<Self>
```

**Purpose**: Creates a purely local test execution environment with a fresh temporary working directory. This is the common path for tests that do not need a remote executor.

**Data flow**: It creates a temporary directory, turns it into an absolute path, asks the execution server library for a test environment, and returns a `TestEnv` containing those pieces.

**Call relations**: Builder methods call this when creating local Codex instances. The resulting environment later supplies the filesystem used by test helpers.

*Call graph*: calls 1 internal fn (create_for_tests); called by 5 (build, build_with_streaming_server, build_with_websocket_server, resume, test_env); 2 external calls (new, new).


##### `TestEnv::cwd`  (lines 139–141)

```
fn cwd(&self) -> &AbsolutePathBuf
```

**Purpose**: Returns the working directory for this test environment. Callers use it as the project folder for Codex.

**Data flow**: It reads the stored absolute path and returns a reference to it without changing anything.

**Call relations**: The builder calls this while preparing the Codex config so the configured current directory matches the test environment.

*Call graph*: called by 1 (build_with_home_and_base_url).


##### `TestEnv::environment`  (lines 143–145)

```
fn environment(&self) -> &codex_exec_server::Environment
```

**Purpose**: Returns the execution environment object behind this test environment. This gives callers access to the filesystem and execution setup.

**Data flow**: It reads the stored environment and returns a reference to it. Nothing is created or modified.

**Call relations**: The builder and `TestCodex::fs` call this when they need the environment's filesystem or runtime details.

*Call graph*: called by 2 (fs, build_with_home_and_base_url).


##### `TestEnv::local_cwd_temp_dir`  (lines 147–149)

```
fn local_cwd_temp_dir(&self) -> Option<Arc<TempDir>>
```

**Purpose**: Returns the temporary local working directory, if this environment has one. Remote environments do not have a local temp directory for the remote workspace.

**Data flow**: It clones the stored shared pointer to the temporary directory, if present, and returns it. This keeps the directory alive for as long as the clone exists.

**Call relations**: The builder uses this to decide which temporary directory should be stored in `TestCodex` as its local `cwd` holder.

*Call graph*: called by 1 (build_with_home_and_base_url).


##### `TestEnv::drop`  (lines 153–158)

```
fn drop(&mut self)
```

**Purpose**: Cleans up remote test workspace files when a remote Docker-backed environment was used. This prevents leftover per-test directories from piling up in the container.

**Data flow**: When `TestEnv` is being destroyed, it checks for a remote container name. If one exists, it builds a shell command to remove the remote working directory and runs it through Docker, ignoring cleanup errors.

**Call relations**: This runs automatically at teardown when the test environment is dropped. It calls `docker_command_capture_stdout` to perform the Docker command.

*Call graph*: calls 1 internal fn (docker_command_capture_stdout); 1 external calls (format!).


##### `test_env`  (lines 161–190)

```
async fn test_env() -> Result<TestEnv>
```

**Purpose**: Chooses between a remote test environment and a local one. Tests can run the same setup either on the local machine or against a configured remote execution server.

**Data flow**: It checks whether remote-test settings exist. If they do, it reads the remote server URL, creates a unique remote working directory, creates that directory through the remote filesystem, and returns a remote `TestEnv`; otherwise it returns `TestEnv::local`.

**Call relations**: Remote-aware builder paths and remote execution tests call this. It relies on `remote_exec_server_url` and `remote_test_instance_id` when remote mode is active.

*Call graph*: calls 4 internal fn (local, remote_exec_server_url, remote_test_instance_id, create_for_tests); called by 9 (remote_exec_server_rejects_inherited_fd_launches, unified_exec_uses_remote_exec_server_when_configured, build_with_remote_and_local_env, build_with_remote_env, remote_test_env_can_connect_and_use_filesystem, remote_test_env_copy_preserves_symlink_source, remote_test_env_remove_removes_symlink_not_target, remote_test_env_sandboxed_read_allows_readable_root, remote_test_env_sandboxed_read_rejects_symlink_parent_dotdot_escape); 1 external calls (get_remote_test_env).


##### `remote_exec_server_url`  (lines 192–203)

```
fn remote_exec_server_url() -> Result<String>
```

**Purpose**: Reads the remote execution server URL from the environment. It fails clearly if the required setting is missing or blank.

**Data flow**: It reads `CODEX_TEST_REMOTE_EXEC_SERVER_URL`, trims whitespace, checks it is not empty, and returns the URL string or an error.

**Call relations**: `test_env` calls this only when remote tests are enabled, so remote setup can connect to the right execution server.

*Call graph*: called by 1 (test_env); 2 external calls (anyhow!, var).


##### `remote_test_instance_id`  (lines 205–208)

```
fn remote_test_instance_id() -> String
```

**Purpose**: Creates a unique-ish identifier for one remote test instance. This helps separate remote working directories created by concurrent tests.

**Data flow**: It increments a process-wide counter and combines the current process id with that counter. The output is a string such as `12345-0`.

**Call relations**: `test_env` uses this identifier when asking the remote-test configuration for a per-test working directory.

*Call graph*: called by 1 (test_env); 1 external calls (format!).


##### `docker_command_capture_stdout`  (lines 210–224)

```
fn docker_command_capture_stdout(args: [&str; N]) -> Result<String>
```

**Purpose**: Runs a Docker command and returns its standard output as text. It is used for cleanup commands in remote Docker test environments.

**Data flow**: It receives Docker command arguments, runs `docker` with those arguments, checks the exit status, and returns UTF-8 stdout. If Docker fails or output is not valid UTF-8, it returns an error with useful details.

**Call relations**: `TestEnv::drop` calls this during remote workspace cleanup.

*Call graph*: called by 1 (drop); 3 external calls (from_utf8, anyhow!, new).


##### `turn_permission_fields`  (lines 240–248)

```
fn turn_permission_fields(
    permission_profile: PermissionProfile,
    cwd: &Path,
) -> (SandboxPolicy, Option<PermissionProfile>)
```

**Purpose**: Converts a modern permission profile into the older sandbox-policy fields still expected in turn settings. This keeps tests compatible with both representations.

**Data flow**: It receives a permission profile and current directory, asks the profile for an equivalent sandbox policy, falls back to read-only if conversion fails, and returns both the sandbox policy and the original profile.

**Call relations**: `TestCodex::submit_turn_with_context` uses this before sending a user turn. Many tests also call it directly when preparing expected thread settings.

*Call graph*: calls 1 internal fn (to_legacy_sandbox_policy); called by 63 (submit_turn_with_context, apply_patch_turn_diff_tracks_local_and_remote_environment_paths, env_zsh_script_spawned_by_python_can_request_escalation_under_zsh_fork, matched_prefix_rule_runs_unsandboxed_under_zsh_fork, network_approval_retry_keeps_deny_read_sandbox_for_escalated_command, remote_model_override_uses_catalog_model_for_strict_auto_review, code_mode_can_call_hidden_dynamic_tools, disabled_permission_user_turn, execpolicy_blocks_shell_invocation, submit_user_turn (+15 more)).


##### `TestCodexBuilder::with_config`  (lines 264–270)

```
fn with_config(mut self, mutator: T) -> Self
```

**Purpose**: Adds a one-time config-editing function to the builder. Tests use it to tweak Codex settings before the test thread starts.

**Data flow**: It receives a function that mutates a `Config`, stores it in the builder, and returns the builder for chaining.

**Call relations**: Convenience methods such as `with_model` and `with_model_info_override` build on this. Later, `prepare_config` runs all stored mutators.

*Call graph*: called by 2 (with_model, with_model_info_override); 1 external calls (new).


##### `TestCodexBuilder::with_auth`  (lines 272–275)

```
fn with_auth(mut self, auth: CodexAuth) -> Self
```

**Purpose**: Sets the authentication object the test Codex instance should use. This lets tests swap the default dummy API key for another auth setup.

**Data flow**: It receives a `CodexAuth`, stores it on the builder, and returns the builder.

**Call relations**: `build_from_config` later clones this auth value and gives it to the test thread manager.


##### `TestCodexBuilder::with_model`  (lines 277–282)

```
fn with_model(self, model: &str) -> Self
```

**Purpose**: Configures the test to use a specific model name. This is a simple shortcut for changing `config.model`.

**Data flow**: It receives a model string, copies it into an owned string, and adds a config mutator that sets the model field.

**Call relations**: It delegates to `with_config`; `prepare_config` applies the stored mutator during build.

*Call graph*: calls 1 internal fn (with_config).


##### `TestCodexBuilder::with_model_info_override`  (lines 284–301)

```
fn with_model_info_override(self, model: &str, override_model_info: T) -> Self
```

**Purpose**: Lets a test modify the catalog entry for a particular model before Codex starts. This is useful for testing model capabilities without changing the shared model catalog.

**Data flow**: It receives a model name and a function that edits that model's `ModelInfo`. During config preparation, it ensures a model catalog exists, finds the requested model, applies the override, and selects that model.

**Call relations**: It is implemented through `with_config`, so its changes are applied in `prepare_config` along with other config mutators.

*Call graph*: calls 1 internal fn (with_config).


##### `TestCodexBuilder::with_pre_build_hook`  (lines 303–309)

```
fn with_pre_build_hook(mut self, hook: F) -> Self
```

**Purpose**: Registers a hook that runs after the temporary home directory exists but before the config is loaded. Tests use this to place files in the fake home directory before Codex reads them.

**Data flow**: It receives a function that takes the home path, stores it, and returns the builder.

**Call relations**: `prepare_config` drains and runs these hooks before loading the default test config.

*Call graph*: 1 external calls (new).


##### `TestCodexBuilder::with_workspace_setup`  (lines 311–319)

```
fn with_workspace_setup(mut self, setup: F) -> Self
```

**Purpose**: Registers asynchronous setup work for the workspace filesystem. This allows tests to create files or directories in either local or remote workspaces through the same filesystem interface.

**Data flow**: It receives a setup function, wraps its future in a boxed future, stores it, and returns the builder. Later the setup receives the configured working directory and filesystem.

**Call relations**: `build_with_home_and_base_url` runs all stored workspace setup functions after the environment and config are ready.

*Call graph*: 1 external calls (new).


##### `TestCodexBuilder::with_home`  (lines 321–324)

```
fn with_home(mut self, home: Arc<TempDir>) -> Self
```

**Purpose**: Tells the builder to use a specific temporary Codex home directory. This is needed when a test wants to seed or reuse home-state across builds.

**Data flow**: It receives a shared temporary directory, stores it, and returns the builder.

**Call relations**: Build methods use this stored home instead of creating a new one.


##### `TestCodexBuilder::with_cloud_config_bundle`  (lines 326–332)

```
fn with_cloud_config_bundle(
        mut self,
        cloud_config_bundle: CloudConfigBundleLoader,
    ) -> Self
```

**Purpose**: Supplies a cloud configuration bundle for tests that need cloud-provided settings. This changes how the default test config is loaded.

**Data flow**: It receives a bundle loader, stores it, and returns the builder.

**Call relations**: `prepare_config` consumes this value and calls the cloud-aware config loader when present.


##### `TestCodexBuilder::with_user_shell`  (lines 334–337)

```
fn with_user_shell(mut self, user_shell: Shell) -> Self
```

**Purpose**: Overrides the shell that Codex should believe the user is using. Tests use this to exercise shell-specific behavior.

**Data flow**: It receives a shell description, stores it, and returns the builder.

**Call relations**: `build_from_config` later chooses special thread-start or resume helpers when this override is present.

*Call graph*: called by 1 (with_windows_cmd_shell).


##### `TestCodexBuilder::with_exec_server_url`  (lines 339–342)

```
fn with_exec_server_url(mut self, exec_server_url: impl Into<String>) -> Self
```

**Purpose**: Configures the builder to use a specific execution server URL. This lets tests direct commands to a chosen executor instead of the default test environment.

**Data flow**: It receives a URL-like value, converts it into a string, stores it, and returns the builder.

**Call relations**: `build_with_home_and_base_url` prefers this explicit URL over the URL carried by `TestEnv`.

*Call graph*: 1 external calls (into).


##### `TestCodexBuilder::with_extensions`  (lines 344–347)

```
fn with_extensions(mut self, extensions: Arc<ExtensionRegistry<Config>>) -> Self
```

**Purpose**: Installs an extension registry for the test Codex instance. Tests use this when they need custom tools or extension-provided behavior.

**Data flow**: It receives a shared registry, stores it, and returns the builder.

**Call relations**: `build_from_config` passes this registry into `ThreadManager::new`.


##### `TestCodexBuilder::with_user_instructions_provider`  (lines 349–355)

```
fn with_user_instructions_provider(
        mut self,
        provider: Arc<dyn UserInstructionsProvider>,
    ) -> Self
```

**Purpose**: Sets a custom source for user instructions. This lets tests replace the normal Codex-home instruction loader with a fake or recording provider.

**Data flow**: It receives a provider, stores it, and returns the builder.

**Call relations**: `build_from_config` uses this provider if present; otherwise it creates the normal home-directory provider.


##### `TestCodexBuilder::with_windows_cmd_shell`  (lines 357–363)

```
fn with_windows_cmd_shell(self) -> Self
```

**Purpose**: On Windows, configures the test to use `cmd.exe` as the user shell. On other operating systems, it leaves the builder unchanged.

**Data flow**: It checks the target operating system. If running on Windows, it converts `cmd.exe` into a `Shell` and stores it through `with_user_shell`; otherwise it returns the same builder.

**Call relations**: Tests that need Windows command-shell behavior can call this without adding platform-specific branching themselves.

*Call graph*: calls 2 internal fn (get_shell_by_model_provided_path, with_user_shell); 2 external calls (from, cfg!).


##### `TestCodexBuilder::build`  (lines 365–377)

```
async fn build(&mut self, server: &wiremock::MockServer) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a normal local `TestCodex` connected to a wiremock HTTP server. This is the standard setup path for most tests.

**Data flow**: It chooses or creates a home directory, constructs the mock server `/v1` base URL, creates a local `TestEnv`, and delegates to `build_with_home_and_base_url`.

**Call relations**: `TestCodexHarness::with_builder` calls this after starting the mock server.

*Call graph*: calls 2 internal fn (build_with_home_and_base_url, local); called by 1 (with_builder); 4 external calls (new, pin, new, format!).


##### `TestCodexBuilder::build_with_remote_env`  (lines 379–394)

```
async fn build_with_remote_env(
        &mut self,
        server: &wiremock::MockServer,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` whose workspace may live in a remote test environment. This is for tests that need to exercise remote execution behavior.

**Data flow**: It chooses or creates a home directory, builds the mock model base URL, obtains `test_env`, and delegates to the shared build path without also adding a local environment.

**Call relations**: `TestCodexHarness::with_remote_env_builder` and remote-environment tests use this.

*Call graph*: calls 2 internal fn (build_with_home_and_base_url, test_env); called by 2 (with_remote_env_builder, agents_instructions); 4 external calls (new, pin, new, format!).


##### `TestCodexBuilder::build_with_remote_and_local_env`  (lines 396–411)

```
async fn build_with_remote_and_local_env(
        &mut self,
        server: &wiremock::MockServer,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a `TestCodex` with both remote and local environments available. Tests use this when they need to verify routing between the two.

**Data flow**: It creates or reuses the home directory, gets the mock server base URL, creates a local-or-remote `TestEnv`, and delegates to the shared build path with local inclusion enabled.

**Call relations**: It shares most work with the other build methods through `build_with_home_and_base_url`.

*Call graph*: calls 2 internal fn (build_with_home_and_base_url, test_env); 4 external calls (new, pin, new, format!).


##### `TestCodexBuilder::build_with_streaming_server`  (lines 413–431)

```
async fn build_with_streaming_server(
        &mut self,
        server: &StreamingSseServer,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a local `TestCodex` connected to a streaming Server-Sent Events test server. Server-Sent Events are a web streaming format where the server pushes chunks over one HTTP response.

**Data flow**: It reads the streaming server URI, prepares a home directory, creates a local environment, formats the `/v1` base URL, and delegates to the common build method.

**Call relations**: Streaming response tests call this when wiremock is not the right kind of server.

*Call graph*: calls 3 internal fn (uri, build_with_home_and_base_url, local); 4 external calls (new, pin, new, format!).


##### `TestCodexBuilder::build_with_websocket_server`  (lines 433–455)

```
async fn build_with_websocket_server(
        &mut self,
        server: &WebSocketTestServer,
    ) -> anyhow::Result<TestCodex>
```

**Purpose**: Builds a local `TestCodex` configured for realtime WebSocket testing. A WebSocket is a long-lived two-way connection between client and server.

**Data flow**: It builds the server base URL, prepares a home directory, adds a config mutator that enables websocket support and realtime model settings, creates a local environment, and delegates to the common build method.

**Call relations**: Realtime tests call this to make the config match the WebSocket test server.

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

**Purpose**: Builds a `TestCodex` by resuming an existing conversation from a rollout file. A rollout file is saved conversation state used to continue a prior thread.

**Data flow**: It receives a mock server, existing home directory, and rollout path. It creates the model base URL and local environment, then delegates to the common build path with `resume_from` set.

**Call relations**: Resume tests call this; `build_from_config` later chooses the resume code path.

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

**Purpose**: Performs the shared build steps that are common to local, remote, streaming, websocket, and resume setups. It connects config, filesystem, execution manager, and final Codex thread creation.

**Data flow**: It prepares the config, chooses the execution server URL, finds runtime helper binaries, creates an environment manager, runs workspace setup functions, chooses the temporary cwd holder, and then calls `build_from_config`.

**Call relations**: All public build methods funnel into this function. It hands prepared pieces to `build_from_config`, which actually starts or resumes the Codex thread.

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

**Purpose**: Starts or resumes the actual Codex thread from an already prepared config. This is where the test harness becomes a live Codex conversation.

**Data flow**: It initializes state storage, creates a thread store and installation id, chooses a user-instructions provider, builds a `ThreadManager`, then either starts a new thread or resumes from a rollout, with optional shell override. It returns a `TestCodex` containing the live thread and test resources.

**Call relations**: `build_with_home_and_base_url` calls this after setup is complete. It delegates thread creation to `ThreadManager` or test-support helpers depending on resume and shell options.

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

**Purpose**: Loads and edits the test configuration before Codex starts. It makes sure the config points at the mock model server and the chosen test workspace.

**Data flow**: It creates a test model provider, creates a fallback temp cwd, runs pre-build hooks, loads default config, sets cwd and provider fields, tries to locate the Codex executable, applies stored config mutators, ensures special test model catalog data when needed, and returns the config plus fallback cwd holder.

**Call relations**: `build_with_home_and_base_url` calls this first. It calls `ensure_test_model_catalog` after test-specific config edits.

*Call graph*: calls 1 internal fn (ensure_test_model_catalog); called by 1 (build_with_home_and_base_url); 10 external calls (new, new, path, built_in_model_providers, cargo_bin, load_default_config_for_test, load_default_config_for_test_with_cloud_config_bundle, current_exe, swap, vec!).


##### `ensure_test_model_catalog`  (lines 668–689)

```
fn ensure_test_model_catalog(config: &mut Config) -> Result<()>
```

**Purpose**: Adds a synthetic model catalog entry for a special experimental-tools test model when needed. This keeps tests from depending on that fake model existing in the bundled catalog.

**Data flow**: It checks whether the selected model is the special test model and whether a catalog is already present. If needed, it clones the bundled `gpt-5.2` entry, renames it, adds a test experimental tool, and stores a one-model catalog in the config.

**Call relations**: `prepare_config` calls this after config mutators, so tests can request the special model by name and still get a valid catalog entry.

*Call graph*: called by 1 (prepare_config); 2 external calls (bundled_models_response, vec!).


##### `TestCodex::cwd_path`  (lines 702–704)

```
fn cwd_path(&self) -> &Path
```

**Purpose**: Returns the local temporary directory path stored as the test's current working directory holder. Tests use it for local filesystem assertions.

**Data flow**: It reads the stored temporary directory and returns its filesystem path.

**Call relations**: `workspace_path` and several tests call this when they need a normal `Path` rather than the absolute-path wrapper in config.

*Call graph*: called by 5 (workspace_path, read_only_user_turn, read_only_text_turn_with_personality, disabled_text_turn, submit_turn_with_policies).


##### `TestCodex::codex_home_path`  (lines 706–708)

```
fn codex_home_path(&self) -> &Path
```

**Purpose**: Returns the path to the fake Codex home directory used by this test. Tests use it to inspect or seed home-level files.

**Data flow**: It reads `config.codex_home` and returns it as a path reference.

**Call relations**: Tests that work with saved threads, skills, or home configuration call this directly.

*Call graph*: called by 2 (seed_recent_thread, skill_script_command).


##### `TestCodex::workspace_path`  (lines 710–712)

```
fn workspace_path(&self, rel: impl AsRef<Path>) -> PathBuf
```

**Purpose**: Builds a path inside the test workspace from a relative path. This avoids repeated path joining in tests.

**Data flow**: It receives a relative path, gets the workspace root through `cwd_path`, joins the two, and returns the resulting path.

**Call relations**: Tests call this when they need to refer to files under the test workspace.

*Call graph*: calls 1 internal fn (cwd_path); called by 1 (seed_recent_thread).


##### `TestCodex::executor_environment`  (lines 714–716)

```
fn executor_environment(&self) -> &TestEnv
```

**Purpose**: Exposes the underlying test execution environment. Tests use this when they need details beyond the simpler filesystem helper.

**Data flow**: It returns a reference to the stored `TestEnv` without changing it.

**Call relations**: This is a direct escape hatch for tests that need environment-level access.


##### `TestCodex::fs`  (lines 718–720)

```
fn fs(&self) -> Arc<dyn ExecutorFileSystem>
```

**Purpose**: Returns the filesystem interface for the test environment. This lets tests read and write files whether the workspace is local or remote.

**Data flow**: It gets the environment from `TestEnv`, asks it for its filesystem object, and returns a shared filesystem handle.

**Call relations**: `TestCodexHarness` file helpers call this so their code works with both local and remote execution environments.

*Call graph*: calls 1 internal fn (environment); called by 8 (abs_path_exists, create_dir_all, read_file_text, remove_abs_path, write_file, create_workspace_directory, create_workspace_directory, write_workspace_file).


##### `TestCodex::submit_turn`  (lines 722–725)

```
async fn submit_turn(&self, prompt: &str) -> Result<()>
```

**Purpose**: Submits a user prompt with permissions disabled and waits for the turn to finish. This is the simplest way for tests to ask Codex something.

**Data flow**: It receives prompt text and passes it to `submit_turn_with_permission_profile` using the disabled permission profile.

**Call relations**: `TestCodexHarness::submit` calls this as its basic submit helper.

*Call graph*: calls 1 internal fn (submit_turn_with_permission_profile); called by 1 (submit).


##### `TestCodex::submit_turn_with_permission_profile`  (lines 727–738)

```
async fn submit_turn_with_permission_profile(
        &self,
        prompt: &str,
        permission_profile: PermissionProfile,
    ) -> Result<()>
```

**Purpose**: Submits a prompt with a chosen permission profile and no approval prompts. A permission profile describes what filesystem or command access is allowed.

**Data flow**: It receives prompt text and a permission profile, pairs them with `AskForApproval::Never`, and delegates to the approval-aware helper.

**Call relations**: Used by the basic submit path and by harness methods that need explicit permission profiles.

*Call graph*: calls 1 internal fn (submit_turn_with_approval_and_permission_profile); called by 2 (submit_turn, submit_with_permission_profile).


##### `TestCodex::submit_turn_with_policy`  (lines 740–747)

```
async fn submit_turn_with_policy(
        &self,
        prompt: &str,
        sandbox_policy: SandboxPolicy,
    ) -> Result<()>
```

**Purpose**: Submits a prompt using an explicit sandbox policy and no approval prompts. A sandbox policy is the set of restrictions placed on code or shell execution.

**Data flow**: It receives prompt text and a sandbox policy, adds `AskForApproval::Never`, and delegates to `submit_turn_with_policies`.

**Call relations**: `TestCodexHarness::submit_with_policy` calls this for tests that still express permissions in legacy sandbox terms.

*Call graph*: calls 1 internal fn (submit_turn_with_policies); called by 1 (submit_with_policy).


##### `TestCodex::submit_turn_with_service_tier`  (lines 749–762)

```
async fn submit_turn_with_service_tier(
        &self,
        prompt: &str,
        service_tier: Option<&str>,
    ) -> Result<()>
```

**Purpose**: Submits a prompt while overriding the requested service tier. Tests use this to check how tier settings are passed into model requests.

**Data flow**: It receives prompt text and an optional tier string, wraps the tier in the thread-settings shape, uses disabled permissions and no approval, and delegates to the context submitter.

**Call relations**: This is a specialized submit helper that funnels into `submit_turn_with_permission_profile_context`.

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

**Purpose**: Submits a prompt with explicit approval and sandbox settings. It bridges old sandbox-policy settings into the newer permission-profile field.

**Data flow**: It receives prompt text, approval policy, and sandbox policy. It derives a permission profile from the sandbox policy for the configured cwd, then delegates to `submit_turn_with_context`.

**Call relations**: `submit_turn_with_policy` calls this. The final send and wait logic lives in `submit_turn_with_context`.

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

**Purpose**: Submits a prompt with both an approval policy and a permission profile. Tests use this when they need to model approval-sensitive turns.

**Data flow**: It receives the prompt, approval policy, and permission profile, then passes them on with no service tier or environment override.

**Call relations**: It is called by `submit_turn_with_permission_profile` and by tests that need approval control. It delegates to `submit_turn_with_permission_profile_context`.

*Call graph*: calls 1 internal fn (submit_turn_with_permission_profile_context); called by 2 (submit_turn_with_permission_profile, run_extract_turn).


##### `TestCodex::submit_turn_with_environments`  (lines 800–813)

```
async fn submit_turn_with_environments(
        &self,
        prompt: &str,
        environments: Option<Vec<TurnEnvironmentSelection>>,
    ) -> Result<()>
```

**Purpose**: Submits a prompt while selecting specific execution environments for the turn. This is used to test local versus remote routing.

**Data flow**: It receives prompt text and optional environment selections, uses disabled permissions and no approval, and delegates to the context submitter.

**Call relations**: Environment-routing tests call this; it funnels into the same final submit path as other helpers.

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

**Purpose**: Combines permission, approval, optional service tier, and optional environment settings before the final submit. It is a small shared bridge for several public helpers.

**Data flow**: It receives all these turn options and passes them unchanged to `submit_turn_with_context`.

**Call relations**: Several submit helpers call this so they do not each duplicate the final turn-building logic.

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

**Purpose**: Sends a user turn to the live Codex thread and waits until that exact turn completes. This prevents tests from continuing while Codex is still working.

**Data flow**: It receives prompt text and turn settings, converts permission fields, builds a `UserInput` operation with text and thread-setting overrides, submits it to Codex, waits for a `TurnStarted` event to get the turn id, then waits for the matching `TurnComplete` event or timeout.

**Call relations**: All submit helpers eventually call this. It uses `turn_permission_fields` for compatibility and test waiting helpers to synchronize with Codex events.

*Call graph*: calls 1 internal fn (turn_permission_fields); called by 2 (submit_turn_with_permission_profile_context, submit_turn_with_policies); 4 external calls (default, wait_for_event_match, wait_for_event_with_timeout, vec!).


##### `TestCodexHarness::new`  (lines 899–901)

```
async fn new() -> Result<Self>
```

**Purpose**: Creates a full default test harness with a mock server and default Codex builder. This is the fastest path for ordinary tests.

**Data flow**: It creates the default builder through `test_codex` and passes it to `with_builder`, returning the finished harness.

**Call relations**: Tests call this when they do not need custom configuration.

*Call graph*: calls 1 internal fn (test_codex); 1 external calls (with_builder).


##### `TestCodexHarness::with_config`  (lines 903–905)

```
async fn with_config(mutator: impl FnOnce(&mut Config) + Send + 'static) -> Result<Self>
```

**Purpose**: Creates a harness after applying one config mutation. This is a convenient one-line setup for tests that only need to tweak config.

**Data flow**: It starts from `test_codex`, adds the provided config mutator, and delegates to `with_builder`.

**Call relations**: Tests call this instead of manually creating a builder when only config differs.

*Call graph*: calls 1 internal fn (test_codex); 1 external calls (with_builder).


##### `TestCodexHarness::with_builder`  (lines 907–911)

```
async fn with_builder(mut builder: TestCodexBuilder) -> Result<Self>
```

**Purpose**: Creates a full harness from a prepared builder. It starts the mock model server and builds Codex against it.

**Data flow**: It starts a mock server, asks the builder to build a `TestCodex` using that server, and returns both bundled in a harness.

**Call relations**: Most harness constructors call this. Many tests use it directly after customizing `TestCodexBuilder`.

*Call graph*: calls 2 internal fn (start_mock_server, build); called by 33 (assert_remote_manual_compact_request_parity, auto_remote_compact_failure_stops_agent_loop, auto_remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_persists_replacement_history_in_rollout, remote_compact_replaces_history_for_followups, remote_compact_rewrites_multiple_trailing_function_call_outputs, remote_compact_runs_automatically, remote_compact_trim_estimate_uses_session_base_instructions, remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_v2_accepts_additional_output_items_before_compaction (+15 more)).


##### `TestCodexHarness::with_remote_env_builder`  (lines 913–917)

```
async fn with_remote_env_builder(mut builder: TestCodexBuilder) -> Result<Self>
```

**Purpose**: Creates a harness using a builder that should run against a remote-capable test environment. It is the remote version of `with_builder`.

**Data flow**: It starts the mock server, asks the builder to build with a remote environment, and returns the server and test Codex together.

**Call relations**: Remote apply-patch and remote execution tests call this.

*Call graph*: calls 2 internal fn (start_mock_server, build_with_remote_env); called by 1 (apply_patch_harness_with).


##### `TestCodexHarness::server`  (lines 919–921)

```
fn server(&self) -> &MockServer
```

**Purpose**: Returns the mock server used by this harness. Tests use it to mount fake model responses or inspect requests.

**Data flow**: It returns a reference to the stored `MockServer`.

**Call relations**: Response-mounting helpers call this before configuring expected model-server behavior.

*Call graph*: called by 6 (mount_apply_patch, mount_apply_patch_model_output, mount_legacy_compact_if_needed, mount_shell_responses, mount_shell_responses_with_timeout, run_tool_turn_on_harness).


##### `TestCodexHarness::test`  (lines 923–925)

```
fn test(&self) -> &TestCodex
```

**Purpose**: Returns the underlying `TestCodex` object. This gives tests access to lower-level thread and config details.

**Data flow**: It returns a reference to the stored `TestCodex`.

**Call relations**: Tests and helper functions call this when the harness convenience methods are not enough.

*Call graph*: called by 3 (submit_without_wait_with_turn_permissions, rollout_path, run_tool_turn_on_harness).


##### `TestCodexHarness::cwd`  (lines 927–929)

```
fn cwd(&self) -> &Path
```

**Purpose**: Returns the configured working directory as a normal path reference. This is useful for path assertions and setup code.

**Data flow**: It reads `test.config.cwd` and returns it as a path.

**Call relations**: Tests can call this directly when they need the root workspace path.


##### `TestCodexHarness::cwd_abs`  (lines 931–933)

```
fn cwd_abs(&self) -> AbsolutePathBuf
```

**Purpose**: Returns the configured working directory as an absolute-path wrapper. This keeps type safety for helpers that require absolute paths.

**Data flow**: It clones the absolute cwd stored in the test config and returns it.

**Call relations**: Tests use this when building environment selections or filesystem paths that require `AbsolutePathBuf`.


##### `TestCodexHarness::path`  (lines 935–937)

```
fn path(&self, rel: impl AsRef<Path>) -> PathBuf
```

**Purpose**: Builds a normal filesystem path inside the harness workspace. It is a convenience wrapper around `path_abs`.

**Data flow**: It receives a relative path, turns it into an absolute workspace path with `path_abs`, then converts that wrapper into a normal `PathBuf`.

**Call relations**: Tests call this when they need a standard path object.

*Call graph*: calls 1 internal fn (path_abs).


##### `TestCodexHarness::path_abs`  (lines 939–941)

```
fn path_abs(&self, rel: impl AsRef<Path>) -> AbsolutePathBuf
```

**Purpose**: Builds an absolute path inside the harness workspace. This is the base path helper used by file operations.

**Data flow**: It receives a relative path and joins it to the configured cwd, returning an `AbsolutePathBuf`.

**Call relations**: `path`, `write_file`, `read_file_text`, `create_dir_all`, and `path_exists` call this.

*Call graph*: called by 5 (create_dir_all, path, path_exists, read_file_text, write_file).


##### `TestCodexHarness::write_file`  (lines 943–970)

```
async fn write_file(
        &self,
        rel: impl AsRef<Path>,
        contents: impl AsRef<[u8]>,
    ) -> Result<()>
```

**Purpose**: Writes a file into the test workspace through the executor filesystem. It works for both local and remote workspaces.

**Data flow**: It receives a relative path and bytes, computes the absolute path, creates the parent directory if needed, converts paths to URIs, and writes the file contents through `TestCodex::fs`.

**Call relations**: Tests call this to seed workspace files before submitting prompts. It uses `path_abs` and the environment filesystem.

*Call graph*: calls 3 internal fn (fs, path_abs, from_path); 1 external calls (as_ref).


##### `TestCodexHarness::read_file_text`  (lines 972–980)

```
async fn read_file_text(&self, rel: impl AsRef<Path>) -> Result<String>
```

**Purpose**: Reads a UTF-8 text file from the test workspace through the executor filesystem. It hides whether the workspace is local or remote.

**Data flow**: It receives a relative path, computes its absolute path, converts it to a URI, reads text through the filesystem, and returns the string.

**Call relations**: Tests call this after Codex actions to verify file contents.

*Call graph*: calls 3 internal fn (fs, path_abs, from_path).


##### `TestCodexHarness::create_dir_all`  (lines 982–994)

```
async fn create_dir_all(&self, rel: impl AsRef<Path>) -> Result<()>
```

**Purpose**: Creates a directory and any missing parent directories inside the test workspace. This mirrors the common `mkdir -p` behavior.

**Data flow**: It receives a relative path, converts the absolute workspace path to a URI, and asks the executor filesystem to create it recursively.

**Call relations**: Tests use this for workspace setup before running Codex.

*Call graph*: calls 3 internal fn (fs, path_abs, from_path).


##### `TestCodexHarness::path_exists`  (lines 996–998)

```
async fn path_exists(&self, rel: impl AsRef<Path>) -> Result<bool>
```

**Purpose**: Checks whether a relative workspace path exists. It is a convenience wrapper around the absolute-path version.

**Data flow**: It receives a relative path, converts it to an absolute workspace path, and delegates to `abs_path_exists`.

**Call relations**: Tests call this for simple existence checks after Codex actions.

*Call graph*: calls 2 internal fn (abs_path_exists, path_abs).


##### `TestCodexHarness::remove_abs_path`  (lines 1000–1014)

```
async fn remove_abs_path(&self, path: &AbsolutePathBuf) -> Result<()>
```

**Purpose**: Removes a specific absolute path through the executor filesystem. It uses force mode but does not request recursive removal.

**Data flow**: It receives an absolute path, converts it to a path URI, asks the filesystem to remove it, and returns success or an error.

**Call relations**: Tests use this when they need to delete a known absolute file or directory path.

*Call graph*: calls 2 internal fn (fs, from_abs_path).


##### `TestCodexHarness::abs_path_exists`  (lines 1016–1028)

```
async fn abs_path_exists(&self, path: &AbsolutePathBuf) -> Result<bool>
```

**Purpose**: Checks whether an absolute path exists through the executor filesystem. It treats "not found" as `false` and other errors as real failures.

**Data flow**: It receives an absolute path, asks the filesystem for metadata, returns `true` on success, `false` on not-found, or an error for anything else.

**Call relations**: `path_exists` delegates to this after building an absolute path.

*Call graph*: calls 2 internal fn (fs, from_abs_path); called by 1 (path_exists).


##### `TestCodexHarness::submit`  (lines 1030–1034)

```
async fn submit(&self, prompt: &str) -> Result<()>
```

**Purpose**: Submits a prompt through the harness and waits for Codex to finish the turn. It is the harness-level version of the basic submit helper.

**Data flow**: It receives prompt text, calls `TestCodex::submit_turn`, boxes the future to keep caller async state smaller, and returns the result.

**Call relations**: Tests commonly call this after mounting mock responses on the server.

*Call graph*: calls 1 internal fn (submit_turn); 1 external calls (pin).


##### `TestCodexHarness::submit_with_policy`  (lines 1036–1044)

```
async fn submit_with_policy(
        &self,
        prompt: &str,
        sandbox_policy: SandboxPolicy,
    ) -> Result<()>
```

**Purpose**: Submits a prompt with a specific sandbox policy through the harness. This lets tests check behavior under different execution restrictions.

**Data flow**: It receives prompt text and a sandbox policy, passes them to `TestCodex::submit_turn_with_policy`, and returns the result.

**Call relations**: Policy-sensitive tests call this instead of the default `submit`.

*Call graph*: calls 1 internal fn (submit_turn_with_policy).


##### `TestCodexHarness::submit_with_permission_profile`  (lines 1046–1054)

```
async fn submit_with_permission_profile(
        &self,
        prompt: &str,
        permission_profile: PermissionProfile,
    ) -> Result<()>
```

**Purpose**: Submits a prompt with a specific permission profile through the harness. This uses the newer permission-profile form of access control.

**Data flow**: It receives prompt text and a permission profile, passes them to `TestCodex::submit_turn_with_permission_profile`, and returns the result.

**Call relations**: Tests that care about permission profiles call this convenience method.

*Call graph*: calls 1 internal fn (submit_turn_with_permission_profile).


##### `TestCodexHarness::request_bodies`  (lines 1056–1069)

```
async fn request_bodies(&self) -> Vec<Value>
```

**Purpose**: Collects JSON bodies of model requests sent to the mock `/responses` endpoint. Tests use this to inspect exactly what Codex sent to the model server.

**Data flow**: It asks the mock server for received requests, filters to paths ending in `/responses`, parses each request body as JSON, and returns the list.

**Call relations**: Output-inspection helpers call this before searching for function-call or custom-tool results.

*Call graph*: called by 2 (custom_tool_call_output, function_call_output_value); 2 external calls (received_requests, path_regex).


##### `TestCodexHarness::function_call_output_value`  (lines 1071–1074)

```
async fn function_call_output_value(&self, call_id: &str) -> Value
```

**Purpose**: Finds the JSON output sent for a specific function-call id. Tests use it to assert tool results included in later model requests.

**Data flow**: It loads all request bodies, searches them with `function_call_output`, clones the matching JSON value, and returns it.

**Call relations**: `function_call_stdout` calls this when it only needs the text stored under the `output` field.

*Call graph*: calls 2 internal fn (request_bodies, function_call_output); called by 1 (function_call_stdout).


##### `TestCodexHarness::function_call_stdout`  (lines 1076–1083)

```
async fn function_call_stdout(&self, call_id: &str) -> String
```

**Purpose**: Returns the text output for a specific function-call id. It is a shortcut for the common case where the function output has an `output` string.

**Data flow**: It gets the matching function-call output value, extracts its `output` field as a string, and returns that string.

**Call relations**: Tests call this when verifying command stdout or similar function-call output.

*Call graph*: calls 1 internal fn (function_call_output_value).


##### `TestCodexHarness::custom_tool_call_output`  (lines 1085–1088)

```
async fn custom_tool_call_output(&self, call_id: &str) -> String
```

**Purpose**: Returns the text output for a specific custom-tool call id. Custom tools are nonstandard tool calls such as apply-patch style actions.

**Data flow**: It loads request bodies, passes them to `custom_tool_call_output_text`, and returns the extracted text.

**Call relations**: `apply_patch_output` delegates to this because apply-patch output is represented as custom-tool output.

*Call graph*: calls 2 internal fn (request_bodies, custom_tool_call_output_text); called by 1 (apply_patch_output).


##### `TestCodexHarness::apply_patch_output`  (lines 1090–1092)

```
async fn apply_patch_output(&self, call_id: &str) -> String
```

**Purpose**: Returns the output text for an apply-patch call. It is a named convenience method for tests focused on patch behavior.

**Data flow**: It receives a call id and delegates to `custom_tool_call_output`.

**Call relations**: Apply-patch tests call this to check what Codex reported back to the model.

*Call graph*: calls 1 internal fn (custom_tool_call_output).


##### `custom_tool_call_output`  (lines 1095–1106)

```
fn custom_tool_call_output(bodies: &'a [Value], call_id: &str) -> &'a Value
```

**Purpose**: Searches request-body JSON for the custom-tool output item with a given call id. It panics with a clear message if the expected item is absent.

**Data flow**: It receives a slice of JSON request bodies and a call id, walks each body's `input` array, finds an item whose type is `custom_tool_call_output` and whose `call_id` matches, and returns that JSON item by reference.

**Call relations**: `custom_tool_call_output_text` calls this before extracting the actual output text.

*Call graph*: called by 1 (custom_tool_call_output_text); 2 external calls (iter, format!).


##### `custom_tool_call_output_text`  (lines 1108–1114)

```
fn custom_tool_call_output_text(bodies: &[Value], call_id: &str) -> String
```

**Purpose**: Extracts plain text from a custom-tool output item in model request bodies. It supports the output shape used by custom tool calls.

**Data flow**: It receives request bodies and a call id, finds the matching custom-tool item, reads its `output` field, converts that JSON value to text, and returns the text. If the field or text is missing, it panics with a targeted message.

**Call relations**: Harness custom-tool helpers and the unit tests in this file call it.

*Call graph*: calls 2 internal fn (output_value_to_text, custom_tool_call_output); called by 2 (custom_tool_call_output, custom_tool_call_output_text_panics_when_output_is_missing); 1 external calls (format!).


##### `function_call_output`  (lines 1116–1127)

```
fn function_call_output(bodies: &'a [Value], call_id: &str) -> &'a Value
```

**Purpose**: Searches request-body JSON for a normal function-call output item with a given call id. It gives tests a direct reference to the matching JSON object.

**Data flow**: It receives request bodies and a call id, walks each body's `input` array, finds an item whose type is `function_call_output` and whose `call_id` matches, and returns that item by reference.

**Call relations**: `TestCodexHarness::function_call_output_value` calls this after collecting mock-server request bodies.

*Call graph*: called by 1 (function_call_output_value); 2 external calls (iter, format!).


##### `test_codex`  (lines 1129–1147)

```
fn test_codex() -> TestCodexBuilder
```

**Purpose**: Creates the default `TestCodexBuilder`. It sets sensible test defaults such as dummy API-key auth, no extensions, and the Apps feature disabled.

**Data flow**: It constructs a builder with one config mutator that disables Apps, dummy auth, empty hook lists, no custom home or cloud bundle, no shell override, no executor URL, an empty extension registry, and no custom instructions provider.

**Call relations**: Most tests and harness constructors start from this builder, then add only the differences they need.

*Call graph*: calls 1 internal fn (from_api_key); called by 583 (fork_startup_context_then_first_turn_diff_snapshot, session_configured_reports_permission_profile_for_external_sandbox, apps_enabled_builder, search_capable_apps_builder, new, with_config, build_unified_exec_zsh_fork_test, build_zsh_fork_test, responses_stream_includes_turn_metadata_header_for_git_workspace_e2e, interrupt_long_running_tool_emits_turn_aborted (+15 more)); 2 external calls (empty_extension_registry, vec!).


##### `tests::custom_tool_call_output_text_returns_output_text`  (lines 1156–1166)

```
fn custom_tool_call_output_text_returns_output_text()
```

**Purpose**: Checks that `custom_tool_call_output_text` returns the expected text when a matching custom-tool output contains an `output` field.

**Data flow**: It builds a small fake request body with one custom-tool output item, calls the helper with its call id, and asserts the returned text is `hello`.

**Call relations**: This is a unit test for the JSON-search helper in this same file.

*Call graph*: 2 external calls (assert_eq!, vec!).


##### `tests::custom_tool_call_output_text_panics_when_output_is_missing`  (lines 1170–1179)

```
fn custom_tool_call_output_text_panics_when_output_is_missing()
```

**Purpose**: Checks that `custom_tool_call_output_text` fails with a useful panic message when the matching custom-tool item has no `output` field.

**Data flow**: It builds a fake request body with a matching call id but no output, then calls the helper. The test expects a panic containing the missing-output message.

**Call relations**: This guards the helper's failure behavior so future changes keep the error message useful.

*Call graph*: calls 1 internal fn (custom_tool_call_output_text); 1 external calls (vec!).


### `core/tests/common/test_codex_exec.rs`

`test` · `test setup and command execution`

Tests that launch a real command-line program need a clean little world to run in. This file builds that world for `codex-exec`. It creates two temporary directories: one acts like the user’s home for Codex settings and database files, and the other acts like the current working folder where the command is run. That keeps tests isolated, like giving each test its own disposable desk instead of letting it write on the shared office table.

The main piece is `TestCodexExecBuilder`. Its `cmd` method prepares an `assert_cmd::Command`, which is a testing tool for starting a program and checking what it prints or how it exits. The command is pointed at the compiled `codex-exec` binary, given the temporary working directory, and supplied with environment variables such as `CODEX_HOME`, `CODEX_SQLITE_HOME`, and a dummy API key.

Some tests also need `codex-exec` to talk to a fake HTTP server instead of the real OpenAI service. `cmd_with_server` adds a configuration override that points the command at a `wiremock` server. The helper also exposes the temporary paths so tests can inspect files afterward. Without this file, many tests would repeat fragile setup code and might accidentally depend on, or damage, real local state.

#### Function details

##### `TestCodexExecBuilder::cmd`  (lines 12–22)

```
fn cmd(&self) -> assert_cmd::Command
```

**Purpose**: Builds a ready-to-run test command for the `codex-exec` binary. It sets the command’s working folder and environment so the program behaves as if it has its own private home and configuration area.

**Data flow**: It reads the builder’s temporary home and current-working-directory paths. It finds the compiled `codex-exec` binary, creates a command object for it, then attaches the temporary paths and a dummy API key as environment variables. The result is a command object that a test can add arguments to and then run.

**Call relations**: This is the basic command factory used by tests directly or indirectly. `TestCodexExecBuilder::cmd_with_server` starts by calling it, then adds extra settings for tests that need a fake server.

*Call graph*: called by 1 (cmd_with_server); 3 external calls (path, new, cargo_bin).


##### `TestCodexExecBuilder::cmd_with_server`  (lines 23–29)

```
fn cmd_with_server(&self, server: &MockServer) -> assert_cmd::Command
```

**Purpose**: Builds a `codex-exec` test command that talks to a fake HTTP server instead of the normal API endpoint. This lets tests control the server responses and avoid real network calls.

**Data flow**: It takes a `MockServer`, asks `cmd` for the standard isolated command, then builds a base URL from the mock server’s address with `/v1` added. It appends command-line configuration arguments that set `openai_base_url` to that mock URL. The output is the same kind of command object, but preconfigured to use the test server.

**Call relations**: It extends the setup done by `TestCodexExecBuilder::cmd`. Tests use it when they need to verify how `codex-exec` behaves while sending requests to a controlled fake server.

*Call graph*: calls 1 internal fn (cmd); 1 external calls (format!).


##### `TestCodexExecBuilder::cwd_path`  (lines 31–33)

```
fn cwd_path(&self) -> &Path
```

**Purpose**: Returns the temporary current working directory used by this test setup. Tests use this when they need to create input files before running `codex-exec` or inspect files afterward.

**Data flow**: It reads the builder’s temporary working-directory object and returns its filesystem path. It does not create, delete, or modify anything.

**Call relations**: This is a small access point for tests that need to interact with the command’s workspace. It supports the wider test flow by letting callers prepare or check the same folder that `cmd` uses as the command’s current directory.

*Call graph*: 1 external calls (path).


##### `TestCodexExecBuilder::home_path`  (lines 34–36)

```
fn home_path(&self) -> &Path
```

**Purpose**: Returns the temporary home directory used for Codex state in this test setup. Tests use it to check configuration, database, or rollout files without looking in a real user home directory.

**Data flow**: It reads the builder’s temporary home object and returns its filesystem path. Nothing is changed; it simply exposes the path for the test to use.

**Call relations**: This complements `cmd`, which passes this same path through environment variables. Tests can run the command and then use `home_path` to inspect whatever the command wrote into its isolated home.

*Call graph*: 1 external calls (path).


##### `toml_string_literal`  (lines 39–41)

```
fn toml_string_literal(value: &str) -> String
```

**Purpose**: Turns a plain string into a quoted string literal suitable for putting into a TOML configuration value. TOML is a common configuration-file format, and this avoids hand-writing quotes and escapes incorrectly.

**Data flow**: It receives a string value, serializes it using JSON string rules, and returns the quoted result. For ordinary strings, this produces the same kind of escaped text needed here for the command-line configuration override.

**Call relations**: This helper is used by `TestCodexExecBuilder::cmd_with_server` when inserting the mock server URL into the `openai_base_url` configuration argument. It keeps that generated argument safe even if the URL contains characters that need quoting.

*Call graph*: 1 external calls (to_string).


##### `test_codex_exec`  (lines 43–48)

```
fn test_codex_exec() -> TestCodexExecBuilder
```

**Purpose**: Creates a fresh `TestCodexExecBuilder` for a test. Each call gives the test its own temporary home and working directory.

**Data flow**: It creates two new temporary directories: one for Codex home/state and one for the command’s working folder. It stores them in a `TestCodexExecBuilder` and returns that builder to the caller. The temporary directories live as long as the builder lives and are cleaned up afterward by the temporary-directory library.

**Call relations**: This is the main entry point used by many `codex-exec` tests. Those tests call it first, then use methods such as `cmd`, `cmd_with_server`, `cwd_path`, and `home_path` to prepare, run, and inspect isolated command executions.

*Call graph*: called by 28 (accepts_add_dir_flag, accepts_multiple_add_dir_flags, exec_includes_workspace_agents_md_in_request, exec_prefers_workspace_agents_override_md, run_exec_with_auto_review_config, exec_uses_codex_api_key_env_var, does_not_persist_rollout_file_in_ephemeral_mode, persists_rollout_file_by_default, exec_hook_trust_bypass_runs_session_start_hook, exits_non_zero_when_required_mcp_server_fails_to_initialize (+15 more)); 1 external calls (new).
