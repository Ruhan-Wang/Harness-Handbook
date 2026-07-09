# Shell, command, git, plugin, and execution support utilities  `stage-22.4`

This stage is shared support code that many other parts of the system lean on while doing their real jobs. It is the toolbox behind the scenes for running commands, talking to Git, working with plugins, and keeping shell use safe and predictable.

Several pieces focus on shells, which are programs like bash or PowerShell that run typed commands. The shell-command and core shell files figure out which shell to use, turn that choice into the exact program arguments needed on each operating system, and help parse or safely display commands. The shell-environment code prepares the environment variables passed into those commands, including filtering secrets. The external-editor helper uses the same ideas to launch the user’s editor.

Another group wraps Git. The git-utils files run Git with safety limits, collect repository facts and diffs, choose the right branch comparison point, and block risky helper programs. The TUI diff code turns that into a safe, view-only diff for users.

The remaining files support execution itself: buffering long output without using endless memory, normalizing executable names, preparing low-level process launches on Linux and Windows, tracking child processes, mapping exit codes, packaging plugins, and finding patch locations in files. Together, these utilities make higher-level features reliable and safe.

## Files in this stage

### Shell modeling and command environment
These files define how shells are detected and represented, how shell command environments are built, and the shared command-parsing helpers exposed to the rest of the system.

### `shell-command/src/lib.rs`

`orchestration` · `cross-cutting`

This crate root assembles the shell-command library into a single import point. It exposes modules for shell detection, Bash support, generic command parsing, and PowerShell support, while keeping the `command_safety` module crate-private except for selected re-exports. That split indicates that shell syntax handling is part of the public API, but the internal organization of safety logic is not.

The two top-level re-exports, `is_dangerous_command` and `is_safe_command`, are the main convenience surface for callers that only need command vetting. They are forwarded from the internal `command_safety` subsystem so downstream code does not need to know where the implementation lives. At the same time, callers that need richer parsing or shell-specific behavior can import from `shell_detect`, `bash`, `parse_command`, or `powershell` directly.

This file therefore acts as a façade and dependency boundary for shared command handling. It keeps the crate’s external shape small and intention-revealing: detect the shell, parse commands, and classify them for safety. The absence of executable logic here is deliberate; all behavior lives in submodules, while this root controls visibility and stable naming for the rest of the system.


### `shell-command/src/shell_detect.rs`

`domain_logic` · `startup and command preparation`

This file is the shell-resolution core for the crate. Its two data types are `ShellType`, an enum of the supported shells (`Zsh`, `Bash`, `PowerShell`, `Sh`, `Cmd`), and `DetectedShell`, which pairs a `ShellType` with a concrete `PathBuf` executable path. Both are serializable via Serde, so detected shell choices can be persisted or exchanged.

The main logic starts with `detect_shell_type`, which recognizes shell names from either a bare command name or a filesystem path. It first matches the full path string directly, then recursively strips directory and extension information via `file_stem` so values like `/usr/bin/bash`, `powershell.exe`, and `cmd.exe` still map to the right enum. Resolution of an actual executable path is centralized in `get_shell_path`: it prefers a caller-provided path if it exists as a file, otherwise checks the user's configured login shell (Unix only) but only if that path matches the requested `ShellType`, then searches `PATH` with `which`, and finally tries hard-coded fallback locations.

`get_user_shell_path` is careful on Unix to use `libc::getpwuid_r` rather than `getpwuid`, avoiding unsafe shared libc buffers in concurrent contexts; it retries with larger buffers on `ERANGE` and caps growth at 1 MiB. Higher-level helpers wrap this generic path search for each shell type, choose OS-specific defaults (`PowerShell` on Windows, login shell then Bash/Zsh ordering on Unix, with macOS preferring Zsh before Bash), and provide a last-resort shell (`cmd.exe` or `/bin/sh`) even when detection fails entirely.

#### Function details

##### `ShellType::name`  (lines 16–24)

```
fn name(self) -> &'static str
```

**Purpose**: Returns the canonical lowercase display name for a `ShellType` variant. The mapping is fixed and does not inspect the filesystem or platform.

**Data flow**: It takes `self` by value, matches the enum variant, and returns a `&'static str` such as `"zsh"`, `"bash"`, `"powershell"`, `"sh"`, or `"cmd"`. It reads no external state and writes nothing.

**Call relations**: This is the leaf name-conversion helper used when callers need a stable textual shell identifier. It is reached through `DetectedShell::name` and any direct enum formatting logic built on that method.

*Call graph*: called by 2 (name, name).


##### `DetectedShell::name`  (lines 34–36)

```
fn name(&self) -> &'static str
```

**Purpose**: Exposes the detected shell's canonical name by delegating to its embedded `shell_type`. It gives callers a string view without needing to inspect the enum field directly.

**Data flow**: It reads `self.shell_type`, passes that enum to `ShellType::name`, and returns the resulting `&'static str`. It does not mutate the struct or touch the filesystem.

**Call relations**: This method sits on top of `ShellType::name` as the object-oriented accessor for already-resolved shells. It is invoked by downstream code that has a `DetectedShell` and wants the normalized shell label.

*Call graph*: calls 1 internal fn (name); called by 1 (from).


##### `detect_shell_type`  (lines 39–59)

```
fn detect_shell_type(shell_path: impl AsRef<std::path::Path>) -> Option<ShellType>
```

**Purpose**: Infers a supported `ShellType` from a shell executable name or path. It recognizes both plain names and path-like inputs with directories or executable extensions.

**Data flow**: It accepts any `AsRef<Path>`, converts it to a `Path`, and first tries to match the whole path string via `as_os_str().to_str()`. If that direct match fails, it reads `file_stem()` and recursively retries detection on the stem as a new `Path`, allowing `/bin/zsh`, `powershell.exe`, and similar forms to collapse to known names. It returns `Some(ShellType)` on a recognized shell or `None` otherwise, without writing state.

**Call relations**: This is the first-stage classifier used by `get_shell_by_model_provided_path` and by `get_shell_path` when validating whether the user's configured login shell matches the requested shell type. Its recursive fallback is what lets higher-level resolution accept full executable paths instead of only bare command names.

*Call graph*: called by 2 (get_shell_by_model_provided_path, get_shell_path); 4 external calls (as_os_str, as_ref, file_stem, new).


##### `get_user_shell_path`  (lines 123–125)

```
fn get_user_shell_path() -> Option<PathBuf>
```

**Purpose**: Obtains the current user's configured login shell path on Unix, or yields no value on non-Unix platforms. The Unix implementation is written to be concurrency-safe and resilient to libc buffer sizing requirements.

**Data flow**: On Unix it reads the current UID with `libc::getuid`, asks `sysconf(_SC_GETPW_R_SIZE_MAX)` for a suggested buffer size, allocates a mutable byte buffer, and repeatedly calls `libc::getpwuid_r` into caller-owned storage. On success it reads `pw_shell`, converts the C string to an owned Rust string, and returns it as a `PathBuf`. If no passwd entry exists, `pw_shell` is null, a non-`ERANGE` error occurs, or the retry buffer would exceed 1 MiB, it returns `None`. On non-Unix it always returns `None`.

**Call relations**: This function feeds shell discovery in two places: `default_user_shell` uses it to seed default-shell selection, and `get_shell_path` uses it as a preferred candidate when the user's configured shell already matches the requested `ShellType`. It delegates only to libc and standard conversion helpers because it is the low-level OS boundary for this file.

*Call graph*: called by 2 (default_user_shell, get_shell_path); 9 external calls (from_ptr, uninit, from, getpwuid_r, getuid, sysconf, null_mut, try_from, vec!).


##### `file_exists`  (lines 127–133)

```
fn file_exists(path: &std::path::Path) -> Option<PathBuf>
```

**Purpose**: Checks whether a path exists and is a regular file, returning a cloned `PathBuf` only for valid executable-like file paths. It filters out missing paths and non-files such as directories.

**Data flow**: It takes `&Path`, calls `std::fs::metadata`, and tests `metadata.is_file()`. If that succeeds, it returns `Some(PathBuf::from(path))`; otherwise it returns `None`. It performs filesystem reads but does not modify state.

**Call relations**: This is the small validation primitive used throughout `get_shell_path` to confirm provided paths, user-shell paths, and hard-coded fallback paths before they are accepted as shell executables.

*Call graph*: called by 1 (get_shell_path); 2 external calls (from, metadata).


##### `get_shell_path`  (lines 135–164)

```
fn get_shell_path(
    shell_type: ShellType,
    provided_path: Option<&PathBuf>,
    binary_name: &str,
    fallback_paths: &[&str],
) -> Option<PathBuf>
```

**Purpose**: Resolves the best executable path for a requested `ShellType` using a strict precedence order: caller-provided path, matching user login shell, `PATH` lookup, then hard-coded fallback locations. It centralizes all path selection policy for the shell-specific wrappers.

**Data flow**: It receives the desired `shell_type`, an optional caller-supplied `PathBuf` reference, the binary name to search with `which`, and a slice of fallback path strings. It first validates the provided path with `file_exists`; if present, that wins immediately. Otherwise it reads the user's shell via `get_user_shell_path`, verifies with `detect_shell_type` that the login shell is the same `ShellType`, and accepts it only if `file_exists` confirms the file. Failing that, it runs `which::which(binary_name)` and returns the discovered path if found. As a final step it iterates the fallback strings, converts each to a `Path`, and returns the first existing file. If every source fails, it returns `None`.

**Call relations**: All shell-specific constructors (`get_zsh_shell`, `get_bash_shell`, `get_sh_shell`, `get_powershell_shell`, `get_cmd_shell`) delegate to this function so they share identical precedence and validation rules. Its internal call to `detect_shell_type` is specifically to avoid reusing an unrelated login shell path for the wrong shell kind.

*Call graph*: calls 3 internal fn (detect_shell_type, file_exists, get_user_shell_path); called by 5 (get_bash_shell, get_cmd_shell, get_powershell_shell, get_sh_shell, get_zsh_shell); 2 external calls (new, which).


##### `get_zsh_shell`  (lines 168–175)

```
fn get_zsh_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a `DetectedShell` for Zsh by resolving a path with Zsh-specific binary and fallback settings. It is a thin adapter around the generic path resolver.

**Data flow**: It accepts an optional path reference, calls `get_shell_path(ShellType::Zsh, path, "zsh", ZSH_FALLBACK_PATHS)`, and if a path is found wraps it into `DetectedShell { shell_type: ShellType::Zsh, shell_path }`. If no path is found it returns `None`.

**Call relations**: This function is selected by `get_shell` when the requested enum is `ShellType::Zsh`. It delegates all search behavior to `get_shell_path`, contributing only the Zsh-specific constants.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `get_bash_shell`  (lines 179–186)

```
fn get_bash_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a `DetectedShell` for Bash using Bash-specific executable names and fallback locations. It converts a resolved path into the typed shell record.

**Data flow**: It takes an optional path reference, calls `get_shell_path(ShellType::Bash, path, "bash", BASH_FALLBACK_PATHS)`, and maps a successful `PathBuf` into `DetectedShell { shell_type: ShellType::Bash, shell_path }`. If resolution fails it returns `None`.

**Call relations**: This is the Bash branch behind `get_shell`. It exists so the dispatcher can keep shell-specific constants separate while reusing the common search algorithm.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `get_sh_shell`  (lines 190–197)

```
fn get_sh_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a `DetectedShell` for POSIX `sh` using the generic resolver and `sh`-specific fallback paths. It is the minimal wrapper for the plain shell case.

**Data flow**: It accepts an optional path reference, invokes `get_shell_path(ShellType::Sh, path, "sh", SH_FALLBACK_PATHS)`, and wraps any returned path into `DetectedShell { shell_type: ShellType::Sh, shell_path }`. It returns `None` if no executable can be found.

**Call relations**: This function is reached from `get_shell` for `ShellType::Sh`. It delegates all actual lookup work to `get_shell_path`.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `get_powershell_shell`  (lines 215–230)

```
fn get_powershell_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a `DetectedShell` for PowerShell, trying both modern `pwsh` and legacy `powershell` executable names with platform-specific fallback paths. It treats both binaries as the same logical `ShellType::PowerShell`.

**Data flow**: It takes an optional path reference and first calls `get_shell_path(ShellType::PowerShell, path, "pwsh", PWSH_FALLBACK_PATHS)`. If that returns `None`, it falls back to `get_shell_path(ShellType::PowerShell, path, "powershell", POWERSHELL_FALLBACK_PATHS)`. A successful path is wrapped into `DetectedShell { shell_type: ShellType::PowerShell, shell_path }`; otherwise the function returns `None`.

**Call relations**: This is the PowerShell-specific branch used by `get_shell`. Its two-step delegation is important because the code prefers PowerShell Core (`pwsh`) but still supports Windows PowerShell where that is the only available binary.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `get_cmd_shell`  (lines 232–239)

```
fn get_cmd_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a `DetectedShell` for Windows `cmd` using the generic resolver without any hard-coded fallback paths. It relies on a provided path or `PATH` lookup.

**Data flow**: It accepts an optional path reference, calls `get_shell_path(ShellType::Cmd, path, "cmd", &[])`, and maps a found path into `DetectedShell { shell_type: ShellType::Cmd, shell_path }`. If no path is found it returns `None`.

**Call relations**: This function is selected by `get_shell` for `ShellType::Cmd`. Unlike the Unix shells and PowerShell, it contributes no fallback path list and leaves all discovery to the generic resolver.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `ultimate_fallback_shell`  (lines 241–253)

```
fn ultimate_fallback_shell() -> DetectedShell
```

**Purpose**: Provides a guaranteed shell choice when all detection and lookup attempts fail. The fallback is intentionally platform-dependent: `cmd.exe` on Windows and `/bin/sh` elsewhere.

**Data flow**: It reads compile-time platform configuration via `cfg!` and constructs a `DetectedShell` directly with a fixed `ShellType` and `PathBuf`. It does not inspect the filesystem or validate that the path exists at runtime.

**Call relations**: This is the terminal fallback used by higher-level selection functions when optional resolution returns `None`, notably `get_shell_by_model_provided_path` and `default_user_shell_from_path`. It does not delegate to other shell lookup helpers because it must always return a value.

*Call graph*: called by 1 (ultimate_fallback_shell); 2 external calls (from, cfg!).


##### `get_shell_by_model_provided_path`  (lines 255–259)

```
fn get_shell_by_model_provided_path(shell_path: &PathBuf) -> DetectedShell
```

**Purpose**: Converts a model-supplied shell path into a validated `DetectedShell`, falling back to a generic platform shell if the path cannot be classified or resolved. It is the bridge from external configuration input to internal shell selection.

**Data flow**: It takes a `&PathBuf`, runs `detect_shell_type` on that path, then if a `ShellType` is recognized calls `get_shell(shell_type, Some(shell_path))` to validate and normalize it. If either detection or lookup fails, it returns `ultimate_fallback_shell()` instead.

**Call relations**: This function is invoked when an upstream model or config already provides a shell path but the system still wants typed detection and existence checks. It delegates classification to `detect_shell_type`, then dispatches through `get_shell` so the same per-shell resolution rules apply.

*Call graph*: calls 1 internal fn (detect_shell_type); called by 1 (get_shell_by_model_provided_path).


##### `get_shell`  (lines 261–269)

```
fn get_shell(shell_type: ShellType, path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Dispatches shell resolution to the shell-specific helper matching a `ShellType`. It is the single enum-based entry point for constructing `DetectedShell` values.

**Data flow**: It accepts a `ShellType` and an optional path reference, matches on the enum, and forwards the same optional path to one of `get_zsh_shell`, `get_bash_shell`, `get_powershell_shell`, `get_sh_shell`, or `get_cmd_shell`. It returns that helper's `Option<DetectedShell>` unchanged.

**Call relations**: This dispatcher is called by `get_shell_by_model_provided_path` and `default_user_shell_from_path` whenever code has already decided which shell family to target. Its role is purely routing; all search policy lives in the delegated helpers.

*Call graph*: calls 5 internal fn (get_bash_shell, get_cmd_shell, get_powershell_shell, get_sh_shell, get_zsh_shell); called by 2 (get_shell, default_user_shell_from_path).


##### `default_user_shell`  (lines 271–273)

```
fn default_user_shell() -> DetectedShell
```

**Purpose**: Computes the default shell for the current process environment by first querying the OS for the user's configured shell path. It is the no-argument convenience entry point for default shell selection.

**Data flow**: It calls `get_user_shell_path()` to obtain an `Option<PathBuf>` and passes that value into `default_user_shell_from_path`. It returns the resulting `DetectedShell` and does not perform additional logic itself.

**Call relations**: This function is the top-level default-shell accessor used by callers that want the environment-derived shell choice. It delegates all policy decisions to `default_user_shell_from_path` after sourcing the optional login-shell path.

*Call graph*: calls 2 internal fn (default_user_shell_from_path, get_user_shell_path); called by 2 (default_user_shell, local).


##### `default_user_shell_from_path`  (lines 275–295)

```
fn default_user_shell_from_path(user_shell_path: Option<PathBuf>) -> DetectedShell
```

**Purpose**: Chooses the effective default shell from an optional user-shell path, applying platform-specific preference order and guaranteed fallback behavior. It encapsulates the policy for what shell the system should use when no explicit shell was requested.

**Data flow**: It accepts `Option<PathBuf>`. On Windows, it ignores the provided path and tries `get_shell(ShellType::PowerShell, None)`, falling back to `ultimate_fallback_shell()` if unavailable. On non-Windows, it attempts to detect a shell type from the provided path with `detect_shell_type` and then resolve that shell via `get_shell(..., None)`. If that fails, it tries additional shells in a platform-specific order: on macOS, Zsh then Bash; on other Unix-like systems, Bash then Zsh. If none resolve, it returns `ultimate_fallback_shell()`.

**Call relations**: This function is called directly by `default_user_shell` and serves as the policy engine for default shell selection. It delegates actual executable lookup to `get_shell`, using compile-time `cfg!` branches to vary the fallback order by operating system.

*Call graph*: calls 1 internal fn (get_shell); called by 2 (default_user_shell_from_path, default_user_shell); 1 external calls (cfg!).


##### `tests::test_detect_shell_type`  (lines 303–367)

```
fn test_detect_shell_type()
```

**Purpose**: Verifies that `detect_shell_type` recognizes supported shell names across bare names, full paths, and executable-extension variants, and rejects unknown shells. The test captures the recursive file-stem behavior that makes path-based detection work.

**Data flow**: It constructs multiple `PathBuf` inputs, calls `detect_shell_type` implicitly inside `assert_eq!` comparisons, and checks for the expected `Some(ShellType::...)` or `None` results. It reads no shared state beyond compile-time platform conditionals used to choose one expected PowerShell path form.

**Call relations**: This test exercises the public classifier directly rather than the higher-level lookup functions. Its assertions document the accepted input shapes that upstream callers can rely on when passing shell names or executable paths.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/shell.rs`

`data_model` · `startup, environment resolution, command execution setup`

This file wraps shell detection from `codex_shell_command::shell_detect` in a local `Shell` struct containing a concrete `ShellType` and executable `PathBuf`. The type is `Debug`, `Clone`, `Serialize`, `Deserialize`, `PartialEq`, and `Eq`, which makes it suitable for persistence, transport, and comparison in tests and session state. The most important behavior is `derive_exec_args`, which encodes shell-specific invocation conventions: POSIX shells (`Zsh`, `Bash`, `Sh`) use `-c` or `-lc`, PowerShell uses `-Command` and conditionally `-NoProfile`, and `Cmd` uses `/c`. That distinction matters because other subsystems rely on login-shell startup files for environment capture but intentionally suppress profile loading in some PowerShell cases.

The file also provides conversion from `DetectedShell`, preserving the detected type and path without reinterpretation. `from_environment_shell_info` is the only place that reconstructs a `Shell` from externally supplied `ShellInfo`; it validates the string shell name against a fixed whitelist and fails fast on unknown names rather than guessing. The remaining free functions are thin adapters over the detection crate: resolve a shell from a model-provided path, request a shell by type and optional path override, or fetch the default user shell. Test-only helpers expose fallback and macOS-specific path-based default-shell behavior.

#### Function details

##### `Shell::name`  (lines 16–18)

```
fn name(&self) -> &'static str
```

**Purpose**: Returns the canonical static display name for the shell by delegating to the underlying `ShellType`.

**Data flow**: Reads `self.shell_type` and calls its `name()` method; returns the resulting `&'static str` without mutating any state.

**Call relations**: Used by higher-level execution and environment code when building user-visible metadata or error messages, including shell snapshot execution paths that need a stable shell label.

*Call graph*: calls 1 internal fn (name); called by 2 (build_environment_update_item, run_script_with_timeout).


##### `Shell::derive_exec_args`  (lines 22–49)

```
fn derive_exec_args(&self, command: &str, use_login_shell: bool) -> Vec<String>
```

**Purpose**: Builds the full argv vector needed to invoke this shell with a command string, honoring whether the caller wants login-shell initialization.

**Data flow**: Consumes `&self`, `command: &str`, and `use_login_shell: bool`; reads `self.shell_type` and `self.shell_path`; emits a `Vec<String>` whose first element is the executable path and remaining elements are shell-specific flags plus the command text.

**Call relations**: Called by command-launching code such as shell snapshot execution and base command construction. It is the single place where callers rely on shell-specific flag selection instead of duplicating per-shell branching.

*Call graph*: called by 2 (run_script_with_timeout, base_command); 1 external calls (vec!).


##### `Shell::from`  (lines 53–58)

```
fn from(detected: DetectedShell) -> Self
```

**Purpose**: Converts a `DetectedShell` from the detection crate into the local `Shell` wrapper.

**Data flow**: Takes ownership of `detected: DetectedShell`, copies out `detected.shell_type` and `detected.shell_path`, and returns a new `Shell` with those fields.

**Call relations**: Acts as the adapter used by all wrapper functions in this file so the rest of the core crate can depend on `Shell` rather than the external detection type.


##### `Shell::from_environment_shell_info`  (lines 62–76)

```
fn from_environment_shell_info(shell_info: ShellInfo) -> anyhow::Result<Self>
```

**Purpose**: Reconstructs a `Shell` from externally supplied `ShellInfo`, validating the shell name string against supported variants.

**Data flow**: Consumes `shell_info: ShellInfo`; matches `shell_info.name.as_str()` to produce a `ShellType`, converts `shell_info.path` into a `PathBuf`, and returns `anyhow::Result<Shell>`. Unknown names trigger `bail!` with a concrete error.

**Call relations**: Invoked during shell selection resolution when environment-provided shell metadata is available. It performs the trust boundary check before downstream code uses the shell for execution.

*Call graph*: called by 1 (resolve_selection); 2 external calls (from, bail!).


##### `ultimate_fallback_shell`  (lines 80–82)

```
fn ultimate_fallback_shell() -> Shell
```

**Purpose**: Exposes the detection crate's last-resort shell choice as a local `Shell` in Unix tests.

**Data flow**: Calls the external fallback detector and converts the returned `DetectedShell` into `Shell`; returns that value directly.

**Call relations**: Only compiled for Unix tests, where shell behavior tests need a guaranteed executable even if preferred shells are unavailable.

*Call graph*: calls 1 internal fn (ultimate_fallback_shell).


##### `get_shell_by_model_provided_path`  (lines 84–86)

```
fn get_shell_by_model_provided_path(shell_path: &PathBuf) -> Shell
```

**Purpose**: Infers a shell type from a model-supplied executable path and returns it as a local `Shell`.

**Data flow**: Reads `shell_path: &PathBuf`, passes it to the detection crate helper, converts the resulting detected shell into `Shell`, and returns it.

**Call relations**: Used when a caller already has a path chosen externally and needs Codex's shell typing and execution conventions applied to it.

*Call graph*: calls 1 internal fn (get_shell_by_model_provided_path); called by 1 (with_windows_cmd_shell).


##### `get_shell`  (lines 88–90)

```
fn get_shell(shell_type: ShellType, path: Option<&PathBuf>) -> Option<Shell>
```

**Purpose**: Looks up an available shell of a requested `ShellType`, optionally constrained to a specific path.

**Data flow**: Takes `shell_type` and optional `path`; delegates to the detection crate; maps `Option<DetectedShell>` into `Option<Shell>` via `Into::into`.

**Call relations**: Called by shell selection and shell snapshot creation to obtain an executable shell instance suitable for running commands.

*Call graph*: calls 1 internal fn (get_shell); called by 2 (new, write_shell_snapshot).


##### `default_user_shell`  (lines 92–94)

```
fn default_user_shell() -> Shell
```

**Purpose**: Returns the current user's default shell as detected by the shell-detection crate.

**Data flow**: Calls the external `default_user_shell()` detector and converts the result into local `Shell`.

**Call relations**: Widely used during session and environment initialization whenever no explicit shell has been selected and Codex should mirror the user's normal shell.

*Call graph*: calls 1 internal fn (default_user_shell); called by 15 (current_shell_output_command, latest_environment_update_wins_while_previous_resolution_is_pending, resolve_turn_environments, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, resolved_environments_for_configuration, test_get_command_rejects_explicit_login_when_disallowed, test_get_command_rejects_explicit_shell_in_zsh_fork_mode, test_get_command_respects_explicit_bash_shell (+5 more)).


##### `default_user_shell_from_path`  (lines 97–99)

```
fn default_user_shell_from_path(user_shell_path: Option<PathBuf>) -> Shell
```

**Purpose**: Test-only macOS helper that derives the effective default shell from an optional user shell path, including fallback behavior.

**Data flow**: Consumes `user_shell_path: Option<PathBuf>`, delegates to the detection crate helper, converts the result into `Shell`, and returns it.

**Call relations**: Compiled only for macOS tests that verify fallback behavior when the configured login shell is unsupported.

*Call graph*: calls 1 internal fn (default_user_shell_from_path).


### `protocol/src/shell_environment.rs`

`util` · `request handling`

This file turns a `ShellEnvironmentPolicy` into the concrete `HashMap<String, String>` used for subprocess execution. The logic is staged and explicit. `create_env` starts from the real process environment (`std::env::vars()`), while `create_env_from_vars` accepts an arbitrary iterator for tests and callers that already have a variable source. Both rely on `populate_env`, which performs the actual policy evaluation.

`populate_env` first chooses the starting variable set based on `policy.inherit`: all variables, none, or only a platform-specific core allowlist. The core allowlist is case-insensitive and differs between Unix and Windows. It then applies the built-in secret scrubber unless `ignore_default_excludes` is set; the default patterns remove names containing `KEY`, `SECRET`, or `TOKEN` regardless of case. After that it applies user-specified excludes, overlays explicit `set` values, optionally narrows the result to `include_only` matches, and finally injects `CODEX_THREAD_ID` when a thread ID is provided.

`create_env_from_vars` adds one extra platform quirk: on Windows, if no variable named `PATHEXT` exists under any casing, it inserts `.COM;.EXE;.BAT;.CMD`. The comment explains this as a CI/Bazel workaround for shell-command failures. The tests are split by platform and focus on case-insensitive core inheritance and the Windows `PATHEXT` insertion behavior.

#### Function details

##### `create_env`  (lines 10–15)

```
fn create_env(
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<&str>,
) -> HashMap<String, String>
```

**Purpose**: Builds a shell environment from the current process environment and a shell-environment policy.

**Data flow**: Takes `policy` and optional `thread_id` → reads `std::env::vars()` from the host process → passes that iterator into `create_env_from_vars` → returns the resulting `HashMap<String, String>`.

**Call relations**: Called by subprocess-launching code that wants policy-filtered environment variables from the real runtime environment. It delegates all policy logic to `create_env_from_vars`.

*Call graph*: calls 1 internal fn (create_env_from_vars); called by 2 (create_env, child_env); 1 external calls (vars).


##### `create_env_from_vars`  (lines 17–44)

```
fn create_env_from_vars(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<&str>,
) -> HashMap<String, String>
```

**Purpose**: Builds a shell environment from an arbitrary variable iterator and policy, then applies the Windows-specific `PATHEXT` fallback if needed.

**Data flow**: Takes `vars`, `policy`, and optional `thread_id` → calls `populate_env(vars, policy, thread_id)` to produce the base map → on Windows, checks keys case-insensitively for `PATHEXT` and inserts `PATHEXT=.COM;.EXE;.BAT;.CMD` if absent → returns the final map.

**Call relations**: Used by `create_env` and tests. It is the outer wrapper around `populate_env`, adding only the Windows compatibility fix.

*Call graph*: calls 1 internal fn (populate_env); called by 4 (create_env_from_vars, create_env, create_env_inserts_pathext_on_windows_when_missing, remote_env_policy_effectively_filters_unrequested_vars); 1 external calls (cfg!).


##### `populate_env`  (lines 46–110)

```
fn populate_env(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<&str>,
) -> HashMap<String, String>
```

**Purpose**: Applies the full shell-environment policy to a variable source: inheritance mode, default secret exclusions, custom exclusions, explicit overrides, include-only filtering, and optional thread-ID injection.

**Data flow**: Takes an iterator of `(String, String)` pairs, a `ShellEnvironmentPolicy`, and optional `thread_id` → initializes `env_map` from all vars, no vars, or a case-insensitive core allowlist depending on `policy.inherit` → if default excludes are enabled, removes keys matching case-insensitive wildcard patterns `*KEY*`, `*SECRET*`, and `*TOKEN*` → removes keys matching `policy.exclude` → inserts/overwrites entries from `policy.r#set` → if `policy.include_only` is nonempty, retains only matching keys → if `thread_id` is present, inserts `CODEX_THREAD_ID` → returns the resulting `HashMap`.

**Call relations**: This is the core implementation used by both production and test entry points. It encapsulates the ordered policy semantics so callers do not need to reimplement filtering rules.

*Call graph*: called by 4 (populate_env, create_env_from_vars, core_inherit_preserves_non_windows_core_vars_case_insensitively, core_inherit_preserves_windows_startup_vars_case_insensitively); 3 external calls (new, into_iter, vec!).


##### `windows_tests::make_vars`  (lines 156–161)

```
fn make_vars(pairs: &[(&str, &str)]) -> Vec<(String, String)>
```

**Purpose**: Test helper that converts borrowed key/value pairs into owned environment-variable tuples.

**Data flow**: Takes `&[(&str, &str)]` → maps each pair to `(String, String)` → collects into `Vec<(String, String)>` and returns it.

**Call relations**: Used by Windows-only tests to build deterministic input environments.


##### `windows_tests::core_inherit_preserves_windows_startup_vars_case_insensitively`  (lines 165–196)

```
fn core_inherit_preserves_windows_startup_vars_case_insensitively()
```

**Purpose**: Verifies that `ShellEnvironmentPolicyInherit::Core` keeps Windows core variables even when their casing differs from the allowlist, while excluding non-core variables.

**Data flow**: Builds a mixed-case variable list including `OPENAI_API_KEY`, constructs a policy with `inherit: Core` and `ignore_default_excludes: true`, calls `populate_env`, and asserts the result contains only the expected core variables with original casing and values.

**Call relations**: Tests the Windows branch of core inheritance and case-insensitive matching.

*Call graph*: calls 1 internal fn (populate_env); 4 external calls (default, from, assert_eq!, make_vars).


##### `windows_tests::create_env_inserts_pathext_on_windows_when_missing`  (lines 200–211)

```
fn create_env_inserts_pathext_on_windows_when_missing()
```

**Purpose**: Verifies the Windows-specific fallback that inserts `PATHEXT` when the filtered environment does not already contain it.

**Data flow**: Constructs a policy inheriting no variables, calls `create_env_from_vars(Vec::new(), ...)`, and asserts the result is a one-entry map containing the default `PATHEXT` value.

**Call relations**: Tests the post-processing logic unique to `create_env_from_vars` on Windows.

*Call graph*: calls 1 internal fn (create_env_from_vars); 4 external calls (default, from, new, assert_eq!).


##### `non_windows_tests::make_vars`  (lines 219–224)

```
fn make_vars(pairs: &[(&str, &str)]) -> Vec<(String, String)>
```

**Purpose**: Test helper that converts borrowed key/value pairs into owned environment-variable tuples for non-Windows tests.

**Data flow**: Takes `&[(&str, &str)]` → maps each pair to owned strings → collects and returns a vector.

**Call relations**: Used by Unix/non-Windows tests to build deterministic input environments.


##### `non_windows_tests::core_inherit_preserves_non_windows_core_vars_case_insensitively`  (lines 227–249)

```
fn core_inherit_preserves_non_windows_core_vars_case_insensitively()
```

**Purpose**: Verifies that `ShellEnvironmentPolicyInherit::Core` keeps Unix core variables case-insensitively and excludes non-core variables.

**Data flow**: Builds a mixed-case variable list including `OPENAI_API_KEY`, constructs a core-inherit policy with default excludes disabled, calls `populate_env`, and asserts the result contains only the expected core variables.

**Call relations**: Tests the non-Windows branch of core inheritance and case-insensitive matching.

*Call graph*: calls 1 internal fn (populate_env); 4 external calls (default, from, assert_eq!, make_vars).


### `tui/src/exec_command.rs`

`util` · `cross-cutting / command formatting and path display`

This file contains utility functions used by exec rendering and command parsing. `escape_command` turns a `Vec<String>`-style argv into a shell-escaped command line using `shlex::try_join`, falling back to a plain space join if quoting fails. `strip_bash_lc_and_escape` improves display quality for shell-wrapper commands by detecting wrappers such as `bash -lc` or `zsh -lc` via `extract_shell_command`; when a wrapper is found it returns just the inner script, otherwise it falls back to `escape_command`.

`split_command_string` performs the inverse operation carefully. It first tries `shlex::split`; if parsing fails, it preserves the original string as a single-element vector. If parsing succeeds, it only returns the split parts when rejoining them round-trips safely back to the original command, or when the rejoined form reparses to the same parts and the original command does not look like a Windows drive-path command containing `:\`. This conservative logic avoids mangling Windows command strings that are not reliably round-trippable through POSIX shell quoting.

The final helper, `relativize_to_home`, shortens absolute paths under the user’s home directory by stripping the home prefix and returning the remainder. It returns `None` for non-absolute paths, missing home directories, or paths outside home. That behavior lets callers decide whether to prepend `~` or fall back to the original absolute path.

#### Function details

##### `escape_command`  (lines 8–10)

```
fn escape_command(command: &[String]) -> String
```

**Purpose**: Formats an argv-style command as a shell-escaped string suitable for display.

**Data flow**: Takes `&[String]`, maps each element to `&str`, tries `shlex::try_join`, and if that fails falls back to `command.join(" ")`.

**Call relations**: Used by `strip_bash_lc_and_escape` and tested directly.

*Call graph*: called by 2 (strip_bash_lc_and_escape, test_escape_command); 1 external calls (try_join).


##### `strip_bash_lc_and_escape`  (lines 12–17)

```
fn strip_bash_lc_and_escape(command: &[String]) -> String
```

**Purpose**: Returns the inner script for shell-wrapper commands like `bash -lc ...`, otherwise returns an escaped command line.

**Data flow**: Calls `extract_shell_command(command)`; if it returns `Some((_, script))`, returns `script.to_string()`, else delegates to `escape_command(command)`.

**Call relations**: Used by exec rendering and header-building code to show cleaner command text.

*Call graph*: calls 2 internal fn (extract_shell_command, escape_command); called by 4 (build_header, command_display_lines, transcript_lines, test_strip_bash_lc_and_escape).


##### `split_command_string`  (lines 19–33)

```
fn split_command_string(command: &str) -> Vec<String>
```

**Purpose**: Splits a command string into argv parts only when doing so is safely round-trippable.

**Data flow**: Attempts `shlex::split(command)`. On failure it returns a one-element vector containing the original string. On success it tries `shlex::try_join(parts)`, and returns `parts` only if the rejoined string exactly matches the original or reparses to the same parts without the original looking like a Windows drive-path command; otherwise it preserves the original string as one element.

**Call relations**: Used by command-parsing code that needs to recover argv without corrupting non-round-trippable command strings.

*Call graph*: called by 1 (command_execution_command_and_parsed); 3 external calls (split, try_join, vec!).


##### `relativize_to_home`  (lines 38–51)

```
fn relativize_to_home(path: P) -> Option<PathBuf>
```

**Purpose**: Returns the portion of an absolute path that lies under the user’s home directory.

**Data flow**: Accepts any `P: AsRef<Path>`, rejects non-absolute paths, queries `dirs::home_dir()`, attempts `path.strip_prefix(&home_dir)`, and returns `Some(rel.to_path_buf())` on success or `None` otherwise.

**Call relations**: Used by path-display helpers to shorten absolute paths under home.

*Call graph*: called by 2 (display_path_for, format_directory_display); 4 external calls (as_ref, is_absolute, strip_prefix, home_dir).


##### `tests::test_escape_command`  (lines 58–62)

```
fn test_escape_command()
```

**Purpose**: Verifies shell escaping for arguments containing spaces and shell metacharacters.

**Data flow**: Builds a sample argv, calls `escape_command`, and asserts the resulting string contains expected quoting.

**Call relations**: Direct unit test for `escape_command`.

*Call graph*: calls 1 internal fn (escape_command); 2 external calls (assert_eq!, vec!).


##### `tests::test_strip_bash_lc_and_escape`  (lines 65–85)

```
fn test_strip_bash_lc_and_escape()
```

**Purpose**: Checks that common shell-wrapper forms return only the inner script.

**Data flow**: Builds several bash/zsh wrapper argv variants, calls `strip_bash_lc_and_escape` on each, and asserts the result is `echo hello`.

**Call relations**: Covers wrapper detection across shell names and absolute shell paths.

*Call graph*: calls 1 internal fn (strip_bash_lc_and_escape); 2 external calls (assert_eq!, vec!).


##### `tests::split_command_string_round_trips_shell_wrappers`  (lines 88–100)

```
fn split_command_string_round_trips_shell_wrappers()
```

**Purpose**: Verifies that a round-trippable shell-wrapper command string is split back into its original argv parts.

**Data flow**: Constructs a quoted command string with `shlex::try_join`, calls `split_command_string`, and asserts the expected three argv elements are returned.

**Call relations**: Covers the successful round-trip branch in `split_command_string`.

*Call graph*: 2 external calls (assert_eq!, try_join).


##### `tests::split_command_string_preserves_non_roundtrippable_windows_commands`  (lines 103–106)

```
fn split_command_string_preserves_non_roundtrippable_windows_commands()
```

**Purpose**: Verifies that Windows-style command strings that are not safely round-trippable are preserved as a single string.

**Data flow**: Calls `split_command_string` on a Windows path-containing command and asserts the result is a one-element vector containing the original string.

**Call relations**: Covers the conservative fallback branch in `split_command_string`.

*Call graph*: 1 external calls (assert_eq!).


### Git operations and repository inspection
This group builds from the git-utils public surface through safe low-level git invocation into fsmonitor policy, branch logic, repository metadata collection, and user-facing diff generation.

### `git-utils/src/lib.rs`

`orchestration` · `compile-time API boundary / cross-cutting`

This crate root organizes the git utility subsystem into focused internal modules—`apply`, `baseline`, `branch`, `errors`, `fsmonitor`, `info`, `operations`, and `platform`—then selectively re-exports the types and functions that callers are meant to use. The exported surface spans several distinct capabilities: applying and staging patches (`ApplyGitRequest`, `ApplyGitResult`, `apply_git_patch`, `extract_paths_from_patch`, `parse_git_apply_output`, `stage_paths`); baseline repository management and diffing (`GitBaselineChange`, `GitBaselineChangeStatus`, `GitBaselineDiff`, `diff_since_latest_init`, `ensure_git_baseline_repository`, `reset_git_repository`); branch and merge-base inspection (`merge_base_with_head`); repository metadata and remote inspection (`GitInfo`, `GitDiffToRemote`, `CommitLogEntry`, branch and remote helpers, commit hash lookup, trust-root resolution, recent commits); fsmonitor probing and override handling; and platform-specific symlink creation.

It also re-exports `GitSha` from `codex_protocol::protocol`, showing that the crate’s public API intentionally aligns with a protocol-level commit identifier type rather than inventing its own. There is no runtime logic here; the file’s significance is API curation. By centralizing exports in one place, it hides implementation modules, presents a coherent toolkit to consumers, and makes the crate root the canonical import path for git-related operations throughout the system.


### `git-utils/src/operations.rs`

`io_transport` · `whenever synchronous git subprocesses are needed`

This module is the shared subprocess foundation for other git utilities. Every command is executed through `run_git`, which prepends `-c core.hooksPath=<null-device>` so internal helper commands cannot trigger repository-configured hooks. It accepts arbitrary argument iterators and optional environment-variable overrides, builds a human-readable command string, executes `git` in a specified directory, and returns either a `GitRun` containing the command string and raw `Output` or a structured `GitToolingError::GitCommand` with stderr text when the exit status is nonzero.

On top of that primitive, `run_git_for_status` discards stdout and only checks success, while `run_git_for_stdout` trims and UTF-8-decodes stdout, converting invalid UTF-8 into `GitToolingError::GitOutputUtf8` that still includes the rendered command. The remaining helpers are small repository queries built from `run_git_for_stdout`: `ensure_git_repository` checks `rev-parse --is-inside-work-tree` and maps false or exit code 128 to `NotAGitRepository`; `resolve_head` resolves `HEAD` but returns `Ok(None)` for unborn repositories; and `resolve_repository_root` returns the top-level path from `rev-parse --show-toplevel`.

The design is intentionally synchronous and minimal, serving as a reusable substrate for higher-level branch and baseline logic.

#### Function details

##### `ensure_git_repository`  (lines 11–31)

```
fn ensure_git_repository(path: &Path) -> Result<(), GitToolingError>
```

**Purpose**: Checks whether a path is inside a git work tree and maps common failure modes to `NotAGitRepository`.

**Data flow**: Runs `git rev-parse --is-inside-work-tree` via `run_git_for_stdout`. If stdout is exactly `true`, it returns `Ok(())`; if stdout is anything else or git exits with status 128, it returns `GitToolingError::NotAGitRepository { path }`; other errors propagate unchanged.

**Call relations**: Used by higher-level branch logic before attempting ref resolution or merge-base computation.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 2 external calls (to_path_buf, vec!).


##### `resolve_head`  (lines 33–47)

```
fn resolve_head(path: &Path) -> Result<Option<String>, GitToolingError>
```

**Purpose**: Resolves `HEAD` to a commit SHA, returning `None` for repositories without a valid HEAD yet.

**Data flow**: Runs `git rev-parse --verify HEAD` via `run_git_for_stdout`. Success becomes `Ok(Some(sha))`; a git-command error with status 128 becomes `Ok(None)`; other errors propagate.

**Call relations**: Used by branch logic to distinguish unborn repositories from hard failures.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 1 external calls (vec!).


##### `resolve_repository_root`  (lines 49–59)

```
fn resolve_repository_root(path: &Path) -> Result<PathBuf, GitToolingError>
```

**Purpose**: Returns the repository’s top-level working-tree path.

**Data flow**: Runs `git rev-parse --show-toplevel` via `run_git_for_stdout` and converts the resulting string into a `PathBuf`.

**Call relations**: Used by higher-level helpers that want to normalize operations to the repository root.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 2 external calls (from, vec!).


##### `run_git_for_status`  (lines 61–72)

```
fn run_git_for_status(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<(), GitToolingError>
```

**Purpose**: Runs a git command and succeeds only if the command exits successfully, discarding stdout.

**Data flow**: Delegates to `run_git(dir, args, env)` and maps a successful `GitRun` to `Ok(())`.

**Call relations**: Used where only success/failure matters, such as resetting the baseline index from HEAD.

*Call graph*: calls 1 internal fn (run_git); called by 1 (write_index_from_head).


##### `run_git_for_stdout`  (lines 74–90)

```
fn run_git_for_stdout(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<String, GitToolingError>
```

**Purpose**: Runs a git command and returns trimmed stdout as UTF-8 text.

**Data flow**: Delegates to `run_git`, then converts `run.output.stdout` with `String::from_utf8`, trims the resulting string, and returns it. Invalid UTF-8 is converted into `GitToolingError::GitOutputUtf8` carrying the rendered command string.

**Call relations**: This is the main text-returning helper used by branch and repository-resolution functions.

*Call graph*: calls 1 internal fn (run_git); called by 6 (merge_base_with_head, resolve_branch_ref, resolve_upstream_if_remote_ahead, ensure_git_repository, resolve_head, resolve_repository_root); 1 external calls (from_utf8).


##### `run_git`  (lines 92–134)

```
fn run_git(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<GitRun, GitToolingError>
```

**Purpose**: Executes the `git` binary with hooks disabled, optional environment overrides, and structured error reporting.

**Data flow**: Consumes `dir`, an argument iterator, and optional env pairs. It preallocates an `args_vec`, prepends `-c core.hooksPath=<null-device>`, copies all provided args into owned `OsString`s, renders a command string with `build_command_string`, builds `Command::new("git")`, applies `current_dir`, optional env vars, and args, then executes it. On non-success it decodes trimmed stderr lossily and returns `GitToolingError::GitCommand { command, status, stderr }`; on success it returns `GitRun { command, output }`.

**Call relations**: This is the module’s core transport primitive. All other functions in the file are wrappers around it.

*Call graph*: calls 1 internal fn (build_command_string); called by 2 (run_git_for_status, run_git_for_stdout); 6 external calls (into_iter, from, from_utf8_lossy, with_capacity, new, format!).


##### `build_command_string`  (lines 136–146)

```
fn build_command_string(args: &[OsString]) -> String
```

**Purpose**: Formats a git command argument vector into a readable command string for diagnostics.

**Data flow**: If `args` is empty it returns `"git"`; otherwise it converts each `OsString` to lossy text, joins them with spaces, and prefixes the result with `git `.

**Call relations**: Used by `run_git` so both success and error paths can report the exact command that was attempted.

*Call graph*: called by 1 (run_git); 3 external calls (is_empty, iter, format!).


### `git-utils/src/fsmonitor.rs`

`config` · `before running internal git worktree/index commands`

This module is a small but security-sensitive policy layer. `FsmonitorOverride` has only two outcomes: force `core.fsmonitor=false`, or preserve the built-in daemon with `core.fsmonitor=true`. The key function, `detect_fsmonitor_override`, probes the target repository through an abstract `FsmonitorProbeRunner` so the logic can be reused with real subprocesses and deterministic tests.

The detection sequence is intentionally conservative. It first asks Git for the raw effective `core.fsmonitor` value using `git config --null --get core.fsmonitor`, because typed queries can fail if a shadowed lower-precedence config layer contains a helper path. The raw result must be a single NUL-terminated UTF-8 string with no embedded NULs. Common boolean spellings (`true/yes/on`, `false/no/off`) are recognized directly, while unusual values such as numeric truthy forms are normalized by a second typed query using `--type=bool --fixed-value --get core.fsmonitor <raw>`. If the effective value is not truthy, the function disables fsmonitor.

Even when configured truthy, the code still requires `git version --build-options` to advertise `feature: fsmonitor--daemon`. Without that capability line, older Git versions may interpret `true` as a hook path or behave unsafely, so the override remains disabled. The result is a strict allowlist for the built-in daemon only.

#### Function details

##### `FsmonitorOverride::git_config_arg`  (lines 24–29)

```
fn git_config_arg(self) -> &'static str
```

**Purpose**: Returns the exact `key=value` git config override string corresponding to the selected fsmonitor policy.

**Data flow**: Matches `self` and returns either `"core.fsmonitor=false"` or `"core.fsmonitor=true"`.

**Call relations**: Used by git command runners to inject the chosen override into `git -c ...` invocations.

*Call graph*: called by 3 (run_git_command_with_timeout_from, run_git_command, git_command).


##### `detect_fsmonitor_override`  (lines 49–125)

```
async fn detect_fsmonitor_override(
    runner: &mut impl FsmonitorProbeRunner,
) -> FsmonitorOverride
```

**Purpose**: Probes Git configuration and capabilities to decide whether Codex should disable fsmonitor entirely or preserve only Git’s built-in daemon.

**Data flow**: Uses the supplied `FsmonitorProbeRunner` to run `config --null --get core.fsmonitor`; malformed, missing, non-UTF-8, or embedded-NUL results immediately yield `Disabled`. It interprets common boolean spellings directly, otherwise runs a typed bool-normalization probe with `--type=bool --fixed-value --get core.fsmonitor <raw>` and treats only `b"true\0"` as enabled. If enabled, it then probes `version --build-options` and scans newline-separated output for the exact trimmed capability line `feature: fsmonitor--daemon`; presence yields `BuiltIn`, absence yields `Disabled`.

**Call relations**: This is the module’s main policy function. Real command runners in `info.rs` and fake runners in tests both invoke it through the shared probe trait.

*Call graph*: 3 external calls (run_probe, matches!, from_utf8).


### `git-utils/src/branch.rs`

`domain_logic` · `on-demand git ancestry queries`

This module is a focused layer over lower-level git command helpers from `operations.rs`. Its main function, `merge_base_with_head`, first verifies that the target path is inside a git repository, resolves the repository root, and resolves `HEAD`. If the repository has no `HEAD` yet, it returns `Ok(None)` instead of treating that as an error. It then resolves the requested branch name with `git rev-parse --verify`; missing branches are also mapped to `Ok(None)`.

A notable design choice is the upstream preference logic. If the named branch has an upstream and `git rev-list --left-right --count branch...upstream` shows the upstream is ahead on the right side, the code resolves and uses the upstream ref instead of the local branch ref when computing the merge base. This makes the result track the latest known remote branch tip rather than a stale local branch. All git command failures that indicate missing refs are downgraded to `None`, while other failures propagate as `GitToolingError`.

The tests build temporary repositories, including a bare remote and rewritten branch history, to verify both ordinary merge-base behavior and the remote-ahead preference path.

#### Function details

##### `merge_base_with_head`  (lines 15–48)

```
fn merge_base_with_head(
    repo_path: &Path,
    branch: &str,
) -> Result<Option<String>, GitToolingError>
```

**Purpose**: Computes the merge-base commit between `HEAD` and a branch, preferring the branch’s upstream remote ref when that upstream is ahead of the local branch.

**Data flow**: Takes `repo_path` and `branch`. It ensures the path is a git repository, resolves the repository root, resolves `HEAD` (returning `Ok(None)` if absent), resolves the branch ref (returning `Ok(None)` if absent), optionally asks `resolve_upstream_if_remote_ahead` for a better upstream name and resolves that ref, then runs `git merge-base <head> <preferred_ref>` and returns the resulting SHA wrapped in `Some`.

**Call relations**: This is the module’s public API and orchestrates both helper functions plus lower-level operations helpers. Tests invoke it directly under shared-history, remote-ahead, and missing-branch conditions.

*Call graph*: calls 6 internal fn (resolve_branch_ref, resolve_upstream_if_remote_ahead, ensure_git_repository, resolve_head, resolve_repository_root, run_git_for_stdout); called by 3 (merge_base_prefers_upstream_when_remote_ahead, merge_base_returns_none_when_branch_missing, merge_base_returns_shared_commit); 1 external calls (vec!).


##### `resolve_branch_ref`  (lines 50–66)

```
fn resolve_branch_ref(repo_root: &Path, branch: &str) -> Result<Option<String>, GitToolingError>
```

**Purpose**: Attempts to resolve a branch or ref name to a verified revision string, treating missing refs as `None` rather than an error.

**Data flow**: Runs `git rev-parse --verify <branch>` in `repo_root`. Successful output becomes `Ok(Some(rev))`; `GitToolingError::GitCommand` is interpreted as a missing ref and mapped to `Ok(None)`; other errors propagate.

**Call relations**: Used by `merge_base_with_head` for both the requested branch and any preferred upstream branch name.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 1 external calls (vec!).


##### `resolve_upstream_if_remote_ahead`  (lines 68–117)

```
fn resolve_upstream_if_remote_ahead(
    repo_root: &Path,
    branch: &str,
) -> Result<Option<String>, GitToolingError>
```

**Purpose**: Determines whether a branch’s configured upstream exists and is ahead of the local branch, returning the upstream name only in that case.

**Data flow**: First runs `git rev-parse --abbrev-ref --symbolic-full-name <branch>@{upstream}`; missing-upstream command failures become `Ok(None)`, while a successful but empty result also yields `None`. It then runs `git rev-list --left-right --count <branch>...<upstream>`, parses the two counts, and returns `Some(upstream)` only when the right-side count is greater than zero.

**Call relations**: Called by `merge_base_with_head` to decide whether to compute the merge base against the local branch or its upstream remote tracking branch.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 1 external calls (vec!).


##### `tests::run_git_in`  (lines 128–135)

```
fn run_git_in(repo_path: &Path, args: &[&str])
```

**Purpose**: Runs a git command in a test repository and asserts that it succeeds.

**Data flow**: Builds a `Command::new("git")`, executes it in `repo_path` with the provided args, and asserts `status.success()`.

**Call relations**: Shared setup helper for branch tests.

*Call graph*: 2 external calls (assert!, new).


##### `tests::run_git_stdout`  (lines 137–145)

```
fn run_git_stdout(repo_path: &Path, args: &[&str]) -> String
```

**Purpose**: Runs a git command in tests, asserting success and returning trimmed stdout.

**Data flow**: Executes `git` in `repo_path`, asserts success, decodes stdout lossily, trims it, and returns the string.

**Call relations**: Used to compute expected merge-base values for comparison against `merge_base_with_head`.

*Call graph*: 3 external calls (from_utf8_lossy, assert!, new).


##### `tests::init_test_repo`  (lines 147–150)

```
fn init_test_repo(repo_path: &Path)
```

**Purpose**: Initializes a test repository with a known initial branch and CRLF behavior.

**Data flow**: Runs `git init --initial-branch=main` and `git config core.autocrlf false` in the repository path.

**Call relations**: Shared repository setup helper for tests.

*Call graph*: 1 external calls (run_git_in).


##### `tests::commit`  (lines 152–165)

```
fn commit(repo_path: &Path, message: &str)
```

**Purpose**: Creates a commit in tests with inline user identity configuration.

**Data flow**: Runs `git -c user.name=Tester -c user.email=test@example.com commit -m <message>` in the repository path.

**Call relations**: Used by tests to build commit graphs without relying on global git config.

*Call graph*: 1 external calls (run_git_in).


##### `tests::merge_base_returns_shared_commit`  (lines 168–194)

```
fn merge_base_returns_shared_commit() -> Result<(), GitToolingError>
```

**Purpose**: Verifies that the helper returns the same merge base as git for two diverged local branches with shared history.

**Data flow**: Creates a repo, commits on `main`, branches to `feature`, commits there, commits again on `main`, checks out `feature`, computes expected output with raw git, calls `merge_base_with_head`, and compares the results.

**Call relations**: Covers the normal local-branch merge-base path.

*Call graph*: calls 1 internal fn (merge_base_with_head); 7 external calls (assert_eq!, commit, init_test_repo, run_git_in, run_git_stdout, write, tempdir).


##### `tests::merge_base_prefers_upstream_when_remote_ahead`  (lines 197–239)

```
fn merge_base_prefers_upstream_when_remote_ahead() -> Result<(), GitToolingError>
```

**Purpose**: Checks that the helper uses the upstream remote branch when it is ahead of the local branch.

**Data flow**: Creates a bare remote and local repo, pushes `main`, creates `feature`, rewrites local `main` history while keeping upstream at the old remote state, fetches, computes expected merge base against `origin/main`, then asserts `merge_base_with_head(&repo, "main")` matches it.

**Call relations**: Exercises the `resolve_upstream_if_remote_ahead` branch-selection logic.

*Call graph*: calls 1 internal fn (merge_base_with_head); 7 external calls (assert_eq!, commit, run_git_in, run_git_stdout, create_dir_all, write, tempdir).


##### `tests::merge_base_returns_none_when_branch_missing`  (lines 242–255)

```
fn merge_base_returns_none_when_branch_missing() -> Result<(), GitToolingError>
```

**Purpose**: Verifies that a missing branch is reported as `None` rather than an error.

**Data flow**: Creates and commits a repo, calls `merge_base_with_head` with a nonexistent branch name, and asserts the result is `None`.

**Call relations**: Covers the missing-ref downgrade behavior in `resolve_branch_ref` and the public API.

*Call graph*: calls 1 internal fn (merge_base_with_head); 6 external calls (assert_eq!, commit, init_test_repo, run_git_in, write, tempdir).


### `git-utils/src/info.rs`

`domain_logic` · `on-demand repository inspection, status checks, and diff generation`

This module is the broad async Git information layer for the system. It includes lightweight repository discovery without invoking git (`get_git_repo_root`, `get_git_repo_root_with_fs`, `resolve_root_git_project_for_trust`), metadata collection (`collect_git_info`, `get_git_remote_urls`, `get_head_commit_hash`, `recent_commits`, `local_git_branches`, `current_branch_name`), and a more involved remote-diff workflow (`git_diff_to_remote`).

All subprocess-based operations run through timeout-bounded helpers built on `tokio::process::Command`. Internal git commands always disable repository-selected hooks via `core.hooksPath=/dev/null` or `NUL`, and worktree-sensitive commands can preserve only the built-in fsmonitor daemon by first probing with `detect_local_fsmonitor_override`. This keeps commands safe while still allowing Git’s own daemon acceleration.

Remote URL handling is normalized aggressively: SCP-like syntax, URL schemes, default ports, `.git` suffixes, and GitHub path casing are canonicalized into a stable `host/path` form. For remote diffs, the code discovers candidate branches from the current branch, default branch, and remote branches containing `HEAD`; for each candidate it finds the first matching remote ref and computes how far `HEAD` is ahead. The closest remote SHA is then diffed with `git diff`, and untracked files are appended using `git diff --no-index /dev/null <file>` in parallel. The module also supports remote filesystem abstractions through `ExecutorFileSystem` and `AbsolutePathBuf` for trust checks and repo-root discovery in non-local environments.

#### Function details

##### `get_git_repo_root`  (lines 33–40)

```
fn get_git_repo_root(base_dir: &Path) -> Option<PathBuf>
```

**Purpose**: Finds the nearest ancestor directory containing a `.git` entry for a local filesystem path.

**Data flow**: If `base_dir` is a directory it uses it directly; otherwise it uses its parent. It then calls `find_ancestor_git_entry` and returns only the repository-root component of the result.

**Call relations**: Used by higher-level logic such as `git_diff_to_remote` to cheaply reject non-repositories before invoking git.

*Call graph*: calls 1 internal fn (find_ancestor_git_entry); called by 1 (git_diff_to_remote); 2 external calls (is_dir, parent).


##### `get_git_repo_root_with_fs`  (lines 46–58)

```
async fn get_git_repo_root_with_fs(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Performs the same ancestor `.git` search as `get_git_repo_root`, but through an abstract executor filesystem for remote/sandboxed environments.

**Data flow**: Converts `cwd` to a `PathUri`, asks the filesystem for metadata, chooses either `cwd` or its parent depending on whether it is a directory, then awaits `find_ancestor_git_entry_with_fs` and returns the repository root if found.

**Call relations**: Used by `resolve_root_git_project_for_trust` when local filesystem inspection is not available.

*Call graph*: calls 3 internal fn (find_ancestor_git_entry_with_fs, parent, from_abs_path); called by 1 (resolve_root_git_project_for_trust); 2 external calls (get_metadata, clone).


##### `collect_git_info`  (lines 87–139)

```
async fn collect_git_info(cwd: &Path) -> Option<GitInfo>
```

**Purpose**: Collects basic repository metadata—HEAD SHA, branch name, and origin URL—in parallel, returning `None` when the directory is not a git repository or commands fail.

**Data flow**: First runs `rev-parse --git-dir` with timeout and checks success. If inside a repo, it concurrently runs `rev-parse HEAD`, `rev-parse --abbrev-ref HEAD`, and `remote get-url origin`. Successful outputs are decoded from UTF-8 and used to populate `GitInfo { commit_hash, branch, repository_url }`, with detached `HEAD` suppressed as a branch name.

**Call relations**: This is a high-level metadata aggregator built on `run_git_command_with_timeout`.

*Call graph*: calls 2 internal fn (run_git_command_with_timeout, new); 2 external calls (from_utf8, join!).


##### `get_git_remote_urls`  (lines 142–152)

```
async fn get_git_remote_urls(cwd: &Path) -> Option<BTreeMap<String, String>>
```

**Purpose**: Returns fetch remote URLs for a repository after first verifying that the path is inside a git repo.

**Data flow**: Runs `rev-parse --git-dir`; on success delegates to `get_git_remote_urls_assume_git_repo`, otherwise returns `None`.

**Call relations**: Thin checked wrapper around the unchecked remote-parsing helper.

*Call graph*: calls 2 internal fn (get_git_remote_urls_assume_git_repo, run_git_command_with_timeout).


##### `get_git_remote_urls_assume_git_repo`  (lines 155–163)

```
async fn get_git_remote_urls_assume_git_repo(cwd: &Path) -> Option<BTreeMap<String, String>>
```

**Purpose**: Parses `git remote -v` output into a map of remote name to fetch URL without first checking repository membership.

**Data flow**: Runs `remote -v`, requires success, decodes stdout as UTF-8, and passes it to `parse_git_remote_urls`.

**Call relations**: Called by `get_git_remote_urls` once repository membership has already been established.

*Call graph*: calls 2 internal fn (parse_git_remote_urls, run_git_command_with_timeout); called by 1 (get_git_remote_urls); 1 external calls (from_utf8).


##### `get_head_commit_hash`  (lines 166–179)

```
async fn get_head_commit_hash(cwd: &Path) -> Option<GitSha>
```

**Purpose**: Returns the current `HEAD` commit hash as `GitSha` without separately checking whether the directory is a git repository.

**Data flow**: Runs `rev-parse HEAD`, requires success, decodes stdout, trims it, and returns `Some(GitSha::new(hash))` unless the trimmed string is empty.

**Call relations**: A focused helper built on the generic timeout runner.

*Call graph*: calls 2 internal fn (run_git_command_with_timeout, new); 1 external calls (from_utf8).


##### `canonicalize_git_remote_url`  (lines 181–197)

```
fn canonicalize_git_remote_url(url: &str) -> Option<String>
```

**Purpose**: Normalizes a git remote URL or SCP-like remote spec into a stable `host/path` form suitable for comparison.

**Data flow**: Trims whitespace, trailing slash, and `.git` suffix; if the string contains `://` it delegates to `canonicalize_git_url_like_remote`, otherwise it tries `parse_scp_like_remote`, and finally falls back to splitting on the first `/` and passing host/path to `canonicalize_git_remote_host_path`.

**Call relations**: Public normalization entrypoint used by callers that need canonical remote identity independent of transport syntax.

*Call graph*: calls 4 internal fn (canonicalize_git_remote_host_path, canonicalize_git_url_like_remote, parse_scp_like_remote, trim_git_suffix).


##### `canonicalize_git_url_like_remote`  (lines 199–213)

```
fn canonicalize_git_url_like_remote(scheme: &str, rest: &str) -> Option<String>
```

**Purpose**: Normalizes scheme-based git remotes by stripping query/fragment parts, removing default ports, and delegating host/path normalization.

**Data flow**: Matches the scheme to a default port (`git`, `http`, `https`, `ssh` only), truncates `rest` before `?` or `#`, splits host and path on the first `/`, and calls `canonicalize_git_remote_host_path`.

**Call relations**: Used by `canonicalize_git_remote_url` for `scheme://...` remotes.

*Call graph*: calls 1 internal fn (canonicalize_git_remote_host_path); called by 1 (canonicalize_git_remote_url).


##### `parse_scp_like_remote`  (lines 215–229)

```
fn parse_scp_like_remote(remote: &str) -> Option<(&str, &str)>
```

**Purpose**: Parses SCP-like git remotes such as `git@host:owner/repo`, while rejecting ordinary slash-containing paths that are not SCP syntax.

**Data flow**: Rejects strings where a `/` appears before any `:` in a way that indicates a path rather than SCP syntax, then splits once on `:`, requiring non-empty host and path parts.

**Call relations**: Used by `canonicalize_git_remote_url` before falling back to plain `host/path` parsing.

*Call graph*: called by 1 (canonicalize_git_remote_url).


##### `canonicalize_git_remote_host_path`  (lines 231–266)

```
fn canonicalize_git_remote_host_path(
    host_part: &str,
    path: &str,
    default_port: Option<&str>,
) -> Option<String>
```

**Purpose**: Normalizes the host and repository path portions of a remote, including user stripping, default-port removal, path validation, and GitHub-specific lowercasing.

**Data flow**: Strips any `user@` prefix from `host_part`, trims and normalizes it with `normalize_remote_host`, trims slashes and `.git` from `path`, splits path components, requires at least owner and repo and rejects `.`/`..` components, rejoins the path, and returns `host/path`, lowercasing the path only for `github.com`.

**Call relations**: Shared normalization helper used by both URL-like and SCP-like remote parsing paths.

*Call graph*: calls 2 internal fn (normalize_remote_host, trim_git_suffix); called by 2 (canonicalize_git_remote_url, canonicalize_git_url_like_remote); 2 external calls (format!, matches!).


##### `normalize_remote_host`  (lines 268–277)

```
fn normalize_remote_host(host: &str, default_port: Option<&str>) -> String
```

**Purpose**: Lowercases a remote host and removes an explicit default port when one is supplied.

**Data flow**: Converts `host` to lowercase; if `default_port` is provided and the host ends with `:<default_port>`, it strips that suffix, otherwise returns the lowercased host unchanged.

**Call relations**: Used by `canonicalize_git_remote_host_path`.

*Call graph*: called by 1 (canonicalize_git_remote_host_path).


##### `trim_git_suffix`  (lines 279–281)

```
fn trim_git_suffix(value: &str) -> &str
```

**Purpose**: Removes a trailing `.git` suffix from a remote URL/path component if present.

**Data flow**: Returns `value` without a `.git` suffix, or the original string otherwise.

**Call relations**: Used during remote URL canonicalization.

*Call graph*: called by 2 (canonicalize_git_remote_host_path, canonicalize_git_remote_url).


##### `get_has_changes`  (lines 283–293)

```
async fn get_has_changes(cwd: &Path) -> Option<bool>
```

**Purpose**: Checks whether the repository has any working-tree or index changes using `git status --porcelain`, with safe fsmonitor handling.

**Data flow**: Builds a `git` path, detects the local fsmonitor override with `detect_local_fsmonitor_override`, runs `status --porcelain` through `run_git_command_with_timeout_from`, requires success, and returns whether stdout is non-empty.

**Call relations**: Uses the lower-level command runner that injects hook and fsmonitor overrides because status inspects the worktree.

*Call graph*: calls 2 internal fn (detect_local_fsmonitor_override, run_git_command_with_timeout_from); 1 external calls (new).


##### `parse_git_remote_urls`  (lines 295–320)

```
fn parse_git_remote_urls(stdout: &str) -> Option<BTreeMap<String, String>>
```

**Purpose**: Parses `git remote -v` output into a map of remote names to fetch URLs only.

**Data flow**: Iterates lines, keeps only those ending in ` (fetch)`, splits each on tab or first space into name and URL, trims leading spaces from the URL, inserts non-empty pairs into a `BTreeMap`, and returns `None` if the map stays empty.

**Call relations**: Used by `get_git_remote_urls_assume_git_repo` after obtaining raw `remote -v` output.

*Call graph*: called by 1 (get_git_remote_urls_assume_git_repo); 1 external calls (new).


##### `recent_commits`  (lines 335–379)

```
async fn recent_commits(cwd: &Path, limit: usize) -> Vec<CommitLogEntry>
```

**Purpose**: Returns recent commits reachable from `HEAD` as lightweight summary entries containing SHA, timestamp, and subject.

**Data flow**: First verifies repository membership with `rev-parse --git-dir`. It then builds `git log` arguments with optional `-n <limit>` and a `%H%x1f%ct%x1f%s` format, runs the command, decodes stdout lossily, splits each line on the unit separator, parses the timestamp, and collects `CommitLogEntry` values, skipping malformed lines.

**Call relations**: A higher-level metadata query built on the generic timeout runner.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout); 4 external calls (from_utf8_lossy, new, format!, vec!).


##### `git_diff_to_remote`  (lines 382–394)

```
async fn git_diff_to_remote(cwd: &Path) -> Option<GitDiffToRemote>
```

**Purpose**: Finds the closest remote-backed base SHA relevant to the current branch context and returns the diff from that SHA to the current workspace.

**Data flow**: Requires that `cwd` is inside a repo via `get_git_repo_root`, then awaits `get_git_remotes`, `branch_ancestry`, `find_closest_sha`, and `diff_against_sha` in sequence. On success it returns `GitDiffToRemote { sha: base_sha, diff }`.

**Call relations**: This is the module’s most composite workflow, orchestrating branch discovery, remote selection, and diff generation.

*Call graph*: calls 5 internal fn (branch_ancestry, diff_against_sha, find_closest_sha, get_git_remotes, get_git_repo_root).


##### `run_git_command_with_timeout`  (lines 397–407)

```
async fn run_git_command_with_timeout(args: &[&str], cwd: &Path) -> Option<std::process::Output>
```

**Purpose**: Runs a git command with the standard timeout and with fsmonitor forcibly disabled, for metadata-only operations.

**Data flow**: Delegates to `run_git_command_with_timeout_from(Path::new("git"), args, cwd, FsmonitorOverride::Disabled)` and returns the resulting `Option<Output>`.

**Call relations**: This is the common subprocess helper used by most metadata queries in the module. Worktree-sensitive callers bypass it to choose fsmonitor policy explicitly.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout_from); called by 12 (branch_ancestry, branch_remote_and_distance, collect_git_info, current_branch_name, get_default_branch, get_default_branch_local, get_git_remote_urls, get_git_remote_urls_assume_git_repo, get_git_remotes, get_head_commit_hash (+2 more)); 1 external calls (new).


##### `LocalFsmonitorProbeRunner::run_probe`  (lines 415–424)

```
async fn run_probe(&mut self, args: &[&str]) -> Option<Vec<u8>>
```

**Purpose**: Implements fsmonitor probing by running bounded local git subprocesses and returning stdout only on successful exit.

**Data flow**: Builds a `tokio::process::Command` for `self.git`, applies `args`, `current_dir`, and `kill_on_drop(true)`, wraps `command.output()` in the module timeout, and returns `Some(output.stdout)` only when the process completes successfully with a success status.

**Call relations**: Used exclusively by `detect_local_fsmonitor_override` as the concrete probe runner for local repositories.

*Call graph*: 2 external calls (new, timeout).


##### `detect_local_fsmonitor_override`  (lines 427–430)

```
async fn detect_local_fsmonitor_override(git: &Path, cwd: &Path) -> crate::FsmonitorOverride
```

**Purpose**: Runs the shared fsmonitor policy detector against a local git executable and working directory.

**Data flow**: Constructs `LocalFsmonitorProbeRunner { git, cwd }` and awaits `crate::detect_fsmonitor_override(&mut runner)`.

**Call relations**: Called before worktree-sensitive commands such as `status`, `diff`, and untracked-file enumeration.

*Call graph*: called by 4 (diff_against_sha, get_has_changes, fsmonitor_override_rejects_configured_helper, fsmonitor_override_uses_effective_layered_config_value); 1 external calls (detect_fsmonitor_override).


##### `run_git_command_with_timeout_from`  (lines 432–454)

```
async fn run_git_command_with_timeout_from(
    git: &Path,
    args: &[&str],
    cwd: &Path,
    fsmonitor: crate::FsmonitorOverride,
) -> Option<std::process::Output>
```

**Purpose**: Runs a git command from a specified git executable path with timeout, disabled hooks, and an explicit fsmonitor override.

**Data flow**: Builds a `Command` for `git`, sets `GIT_OPTIONAL_LOCKS=0`, injects `-c core.hooksPath=<null-device>` and `-c <fsmonitor.git_config_arg()>`, appends `args`, sets `current_dir` and `kill_on_drop(true)`, awaits `command.output()` under the standard timeout, and returns `Some(output)` on process completion or `None` on timeout/error.

**Call relations**: This is the lowest-level async git runner in the module. `run_git_command_with_timeout` wraps it for metadata-only commands, while worktree-sensitive functions call it directly.

*Call graph*: calls 1 internal fn (git_config_arg); called by 5 (diff_against_sha, get_has_changes, run_git_command_with_timeout, fsmonitor_override_rejects_configured_helper, fsmonitor_override_uses_effective_layered_config_value); 3 external calls (new, format!, timeout).


##### `get_git_remotes`  (lines 456–471)

```
async fn get_git_remotes(cwd: &Path) -> Option<Vec<String>>
```

**Purpose**: Returns the list of remote names, prioritizing `origin` first when present.

**Data flow**: Runs `git remote`, requires success, decodes stdout as UTF-8, splits into lines, collects remote names, and if `origin` exists removes and reinserts it at index 0.

**Call relations**: Used by default-branch discovery, branch ancestry expansion, and remote-diff selection.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout); called by 3 (branch_ancestry, get_default_branch, git_diff_to_remote); 1 external calls (from_utf8).


##### `get_default_branch`  (lines 479–522)

```
async fn get_default_branch(cwd: &Path) -> Option<String>
```

**Purpose**: Attempts to determine the repository’s default branch using remote metadata first and local fallbacks second.

**Data flow**: Gets remotes with `get_git_remotes`, then for each remote tries `symbolic-ref --quiet refs/remotes/<remote>/HEAD` and parses the final path component; if that fails, it runs `remote show <remote>` and parses a `HEAD branch:` line. If no remote-derived answer is found, it falls back to `get_default_branch_local`.

**Call relations**: Used by `branch_ancestry` and exposed indirectly through `default_branch_name`.

*Call graph*: calls 3 internal fn (get_default_branch_local, get_git_remotes, run_git_command_with_timeout); called by 2 (branch_ancestry, default_branch_name); 2 external calls (from_utf8, format!).


##### `default_branch_name`  (lines 530–532)

```
async fn default_branch_name(cwd: &Path) -> Option<String>
```

**Purpose**: Public wrapper that returns the repository’s default branch name if it can be determined.

**Data flow**: Simply awaits and returns `get_default_branch(cwd)`.

**Call relations**: Thin public facade over the internal default-branch discovery logic.

*Call graph*: calls 1 internal fn (get_default_branch).


##### `get_default_branch_local`  (lines 535–554)

```
async fn get_default_branch_local(cwd: &Path) -> Option<String>
```

**Purpose**: Determines the default branch from local refs only by checking for `main` and then `master`.

**Data flow**: For each candidate in `["main", "master"]`, runs `rev-parse --verify --quiet refs/heads/<candidate>` and returns the first candidate whose command succeeds; otherwise returns `None`.

**Call relations**: Used as the fallback path in `get_default_branch` and to prioritize branch ordering in `local_git_branches`.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout); called by 2 (get_default_branch, local_git_branches); 1 external calls (format!).


##### `branch_ancestry`  (lines 558–623)

```
async fn branch_ancestry(cwd: &Path) -> Option<Vec<String>>
```

**Purpose**: Builds an ordered list of branch candidates relevant to the current checkout, starting with the current branch, then default branch, then remote branches that already contain `HEAD`.

**Data flow**: Resolves the current branch via `rev-parse --abbrev-ref HEAD`, ignoring detached `HEAD`; resolves the default branch via `get_default_branch`; inserts unique names into `ancestry` and `seen`; then for each remote from `get_git_remotes` runs `for-each-ref --format=%(refname:short) --contains=HEAD refs/remotes/<remote>`, strips the `<remote>/` prefix, and appends unseen branch names.

**Call relations**: Used by `git_diff_to_remote` to generate candidate branches for remote-base selection.

*Call graph*: calls 3 internal fn (get_default_branch, get_git_remotes, run_git_command_with_timeout); called by 1 (git_diff_to_remote); 4 external calls (new, from_utf8, new, format!).


##### `branch_remote_and_distance`  (lines 629–705)

```
async fn branch_remote_and_distance(
    cwd: &Path,
    branch: &str,
    remotes: &[String],
) -> Option<(Option<GitSha>, usize)>
```

**Purpose**: For one branch candidate, finds the first matching remote ref and computes how many commits `HEAD` is ahead of that branch or remote ref.

**Data flow**: Iterates remotes, verifying `refs/remotes/<remote>/<branch>` until one exists and decoding its SHA into `found_remote_sha` and `found_remote_ref`. It then computes ahead distance with `rev-list --count <branch>..HEAD`, falling back to `<remote_ref>..HEAD` if the local branch count command fails and a remote ref exists. It parses the count as `usize` and returns `(Option<GitSha>, distance)`.

**Call relations**: Called by `find_closest_sha` for each candidate branch. It encapsulates both remote-ref discovery and ahead-distance computation.

*Call graph*: calls 2 internal fn (run_git_command_with_timeout, new); called by 1 (find_closest_sha); 2 external calls (from_utf8, format!).


##### `find_closest_sha`  (lines 708–730)

```
async fn find_closest_sha(cwd: &Path, branches: &[String], remotes: &[String]) -> Option<GitSha>
```

**Purpose**: Chooses the remote SHA associated with the candidate branch that is closest to `HEAD` by ahead distance.

**Data flow**: Iterates `branches`, awaits `branch_remote_and_distance` for each, skips branches with no remote SHA, and tracks the `(GitSha, distance)` pair with the smallest distance. It returns only the winning `GitSha`.

**Call relations**: Used by `git_diff_to_remote` after branch ancestry and remote discovery.

*Call graph*: calls 1 internal fn (branch_remote_and_distance); called by 1 (git_diff_to_remote).


##### `diff_against_sha`  (lines 732–796)

```
async fn diff_against_sha(cwd: &Path, sha: &GitSha) -> Option<String>
```

**Purpose**: Builds a textual diff from a chosen base SHA to the current workspace, including untracked files rendered as no-index diffs.

**Data flow**: Detects fsmonitor policy, runs `git diff --no-textconv --no-ext-diff <sha>` via `run_git_command_with_timeout_from`, accepts exit codes 0 or 1, and decodes stdout into `diff`. It then runs `git ls-files --others --exclude-standard`; for each untracked file it launches a parallel `git diff --no-textconv --no-ext-diff --binary --no-index -- <null-device> <file>` future, awaits them with `join_all`, and appends successful diff outputs to the main diff string.

**Call relations**: Called by `git_diff_to_remote` once a base SHA has been selected. It is one of the worktree-sensitive paths that uses fsmonitor detection.

*Call graph*: calls 2 internal fn (detect_local_fsmonitor_override, run_git_command_with_timeout_from); called by 1 (git_diff_to_remote); 4 external calls (new, from_utf8, cfg!, join_all).


##### `resolve_root_git_project_for_trust`  (lines 802–835)

```
async fn resolve_root_git_project_for_trust(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Resolves the main repository root to use for trust checks, including worktree setups where `.git` is a file pointing into `.../worktrees/...`.

**Data flow**: Finds the repo root with `get_git_repo_root_with_fs`, inspects `repo_root/.git` metadata through the executor filesystem, and if it is a directory returns `repo_root`. Otherwise it reads the `.git` file text, parses a `gitdir:` path, resolves it against the repo root, requires that its parent directory is named `worktrees`, and returns the parent of the common git dir.

**Call relations**: Used when trust decisions need the root of the main repository rather than the worktree checkout root.

*Call graph*: calls 4 internal fn (read_file_text, get_git_repo_root_with_fs, resolve_path_against_base, from_abs_path); 2 external calls (new, get_metadata).


##### `find_ancestor_git_entry`  (lines 837–854)

```
fn find_ancestor_git_entry(base_dir: &Path) -> Option<(PathBuf, PathBuf)>
```

**Purpose**: Walks up local filesystem ancestors looking for a `.git` file or directory.

**Data flow**: Starts from `base_dir.to_path_buf()`, repeatedly joins `.git`, returns `(dir, dot_git)` when it exists, and otherwise pops one path component until reaching the filesystem root.

**Call relations**: Used by `get_git_repo_root`.

*Call graph*: called by 1 (get_git_repo_root); 1 external calls (to_path_buf).


##### `find_ancestor_git_entry_with_fs`  (lines 856–872)

```
async fn find_ancestor_git_entry_with_fs(
    fs: &dyn ExecutorFileSystem,
    base_dir: &AbsolutePathBuf,
) -> Option<(AbsolutePathBuf, AbsolutePathBuf)>
```

**Purpose**: Walks up ancestor directories through an abstract filesystem, looking for a `.git` entry.

**Data flow**: Iterates `base_dir.ancestors()`, joins `.git` for each ancestor, converts it to `PathUri`, and returns `(dir, dot_git)` on the first successful metadata lookup.

**Call relations**: Used by `get_git_repo_root_with_fs`.

*Call graph*: calls 2 internal fn (ancestors, from_abs_path); called by 1 (get_git_repo_root_with_fs); 1 external calls (get_metadata).


##### `local_git_branches`  (lines 876–900)

```
async fn local_git_branches(cwd: &Path) -> Vec<String>
```

**Purpose**: Returns local branch names sorted alphabetically, with the local default branch moved to the front when present.

**Data flow**: Runs `git branch --format=%(refname:short)`, decodes stdout lossily into trimmed non-empty branch names, sorts them, then asks `get_default_branch_local` for `main`/`master` and moves that branch to index 0 if found.

**Call relations**: A convenience metadata query for branch pickers or UI lists.

*Call graph*: calls 2 internal fn (get_default_branch_local, run_git_command_with_timeout); 2 external calls (from_utf8_lossy, new).


##### `current_branch_name`  (lines 903–912)

```
async fn current_branch_name(cwd: &Path) -> Option<String>
```

**Purpose**: Returns the currently checked-out branch name, or `None` for detached HEAD or command failure.

**Data flow**: Runs `git branch --show-current`, requires success, decodes stdout as UTF-8, trims it, and filters out empty names.

**Call relations**: A focused helper built on the generic timeout runner.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout); 1 external calls (from_utf8).


##### `tests::canonicalize_git_remote_url_normalizes_github_variants`  (lines 922–937)

```
fn canonicalize_git_remote_url_normalizes_github_variants()
```

**Purpose**: Verifies that multiple GitHub remote syntaxes normalize to the same lowercase canonical form.

**Data flow**: Iterates several GitHub remote strings and asserts `canonicalize_git_remote_url` returns `Some("github.com/openai/codex")` for each.

**Call relations**: Covers the GitHub-specific lowercasing and syntax normalization logic.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::canonicalize_git_remote_url_handles_ghe_without_lowercasing_path`  (lines 940–949)

```
fn canonicalize_git_remote_url_handles_ghe_without_lowercasing_path()
```

**Purpose**: Checks that non-GitHub enterprise hosts preserve path casing while still normalizing host and port details.

**Data flow**: Calls `canonicalize_git_remote_url` on two GHE-style remotes and asserts the expected canonical strings.

**Call relations**: Exercises host-specific behavior in remote canonicalization.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::canonicalize_git_remote_url_rejects_non_repository_values`  (lines 952–956)

```
fn canonicalize_git_remote_url_rejects_non_repository_values()
```

**Purpose**: Ensures malformed or non-repository remote-like strings are rejected.

**Data flow**: Iterates invalid inputs such as empty strings, file URLs, incomplete host/path pairs, and local paths, asserting `canonicalize_git_remote_url` returns `None`.

**Call relations**: Covers validation branches in the canonicalization helpers.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::fsmonitor_override_rejects_configured_helper`  (lines 960–1011)

```
async fn fsmonitor_override_rejects_configured_helper()
```

**Purpose**: Verifies that a repository-configured fsmonitor helper path is not preserved and that worktree commands run with `core.fsmonitor=false`.

**Data flow**: Creates a fake executable `git` script that logs arguments and returns a helper path for `config`, detects fsmonitor policy with `detect_local_fsmonitor_override`, runs `status --porcelain` through `run_git_command_with_timeout_from`, and asserts both the output and the logged command sequence.

**Call relations**: Integration-style test connecting local probe execution with the shared fsmonitor policy.

*Call graph*: calls 2 internal fn (detect_local_fsmonitor_override, run_git_command_with_timeout_from); 6 external calls (assert_eq!, format!, metadata, set_permissions, write, tempdir).


##### `tests::fsmonitor_override_uses_effective_layered_config_value`  (lines 1015–1098)

```
async fn fsmonitor_override_uses_effective_layered_config_value()
```

**Purpose**: Checks that fsmonitor detection respects the effective layered config value and preserves built-in fsmonitor when the local layer sets `true` over a helper-valued global layer.

**Data flow**: Creates a real repo plus a fake `git` wrapper that delegates `config` to real git with a custom global config and reports daemon capability, writes a helper path to the global config and `true` locally, detects fsmonitor policy, runs a worktree command, and asserts the logged probes and final command use `core.fsmonitor=true`.

**Call relations**: Validates the subtle raw-effective-config-first behavior of fsmonitor detection in a layered-config scenario.

*Call graph*: calls 2 internal fn (detect_local_fsmonitor_override, run_git_command_with_timeout_from); 9 external calls (assert_eq!, new, format!, create_dir, metadata, read_to_string, set_permissions, write, tempdir).


### `tui/src/get_git_diff.rs`

`domain_logic` · `request handling`

This file adapts Git command execution onto the TUI’s `WorkspaceCommandExecutor` abstraction. The top-level `get_git_diff` first checks whether `cwd` is inside a Git worktree using `rev-parse --is-inside-work-tree`; outside a repo it returns `Ok((false, String::new()))`. Inside a repo, it probes fsmonitor behavior once through `codex_git_utils::detect_fsmonitor_override` using `WorkspaceFsmonitorProbeRunner`, then reuses that override for all subsequent Git commands.

Before generating diffs, it calls `diff_filter_config_overrides` to inspect configured `filter.*.(clean|process)` keys and synthesize environment-based `GIT_CONFIG_*` overrides that blank out `.clean` and `.process` commands and force `.required=false`. This prevents configured diff/filter helpers from executing. All Git commands also inject `-c <fsmonitor>` and `-c core.hooksPath=/dev/null` (or `NUL` on Windows), use a 30-second timeout, and disable output caps for diff-producing commands.

Tracked changes are collected with `git diff --no-textconv --no-ext-diff --submodule=short --ignore-submodules=dirty --color`, where exit code `1` is treated as success because Git uses it to indicate differences. Untracked files are listed with `git ls-files --others --exclude-standard`, then each file is diffed against the platform null device using `git diff --no-index -- ...`. The final output concatenates tracked and untracked diffs.

The extensive tests verify non-repo behavior, acceptance of diff exit code `1`, rejection of unexpected statuses, preservation of built-in fsmonitor when appropriate, and—most importantly—that configured filters, fsmonitor helpers, hooks, and dirty-submodule inspection do not execute during `/diff`.

#### Function details

##### `WorkspaceFsmonitorProbeRunner::run_probe`  (lines 35–42)

```
async fn run_probe(&mut self, args: &[&str]) -> Option<Vec<u8>>
```

**Purpose**: Executes a lightweight Git probe command through the workspace command abstraction so fsmonitor detection can run in the same environment as normal `/diff` commands. It returns raw stdout bytes only for successful probes.

**Data flow**: It takes a slice of Git argument strings, prepends `git`, builds a `WorkspaceCommand` with `cwd` set to `self.cwd.to_path_buf()`, awaits `self.runner.run(command)`, and returns `Some(output.stdout.into_bytes())` only when the command succeeds according to `output.success()`. Any execution error or non-success status yields `None`.

**Call relations**: The `codex_git_utils::detect_fsmonitor_override` routine calls this through the `FsmonitorProbeRunner` trait. It is the bridge that lets git-utils probe repository fsmonitor configuration without knowing about TUI command execution.

*Call graph*: calls 1 internal fn (new); 2 external calls (to_path_buf, run).


##### `get_git_diff`  (lines 49–120)

```
async fn get_git_diff(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Result<(bool, String), String>
```

**Purpose**: Produces the complete diff payload for `/diff`, combining tracked changes and untracked-file diffs while avoiding side-effecting Git helpers. It also reports whether the cwd is a Git repository at all.

**Data flow**: It takes a `WorkspaceCommandExecutor` and `cwd`. It first calls `inside_git_repo`; if false, it returns `(false, empty string)`. Otherwise it constructs a `WorkspaceFsmonitorProbeRunner`, calls `detect_fsmonitor_override`, obtains filter-disabling overrides from `diff_filter_config_overrides`, concurrently runs `run_git_capture_diff` for tracked changes and `run_git_capture_stdout` for untracked file names, then iterates over each non-empty untracked path and calls `run_git_capture_diff` again with `--no-index` against the platform null device. It concatenates tracked and untracked diff strings and returns `Ok((true, combined_diff))`, or propagates formatted `String` errors from any failing step.

**Call relations**: This is the main exported function under test and the entry point used by the `/diff` feature. It delegates repository detection, fsmonitor probing, safe config override generation, and command execution to the helper functions in this file.

*Call graph*: calls 3 internal fn (diff_filter_config_overrides, inside_git_repo, run_git_capture_diff); called by 7 (get_git_diff_accepts_diff_exit_code_one, get_git_diff_disables_helpers_for_tracked_and_untracked_diffs, get_git_diff_does_not_execute_configured_filters_fsmonitor_or_hooks, get_git_diff_does_not_execute_helpers_while_checking_dirty_submodules, get_git_diff_preserves_builtin_fsmonitor_for_diff_workflow, get_git_diff_rejects_unexpected_git_diff_status, get_git_diff_returns_not_git_for_non_git_cwd); 6 external calls (new, new, cfg!, detect_fsmonitor_override, format!, join!).


##### `run_git_capture_stdout`  (lines 124–139)

```
async fn run_git_capture_stdout(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    fsmonitor: FsmonitorOverride,
    args: &[&str],
) -> Result<String, String>
```

**Purpose**: Runs a Git command and returns stdout only when the exit status is strictly successful. It treats any non-zero status as an error.

**Data flow**: It accepts the runner, cwd, fsmonitor override, and Git args, calls `run_git_command` with no config overrides, checks `output.success()`, and returns either `Ok(output.stdout)` or an error string formatted with the args and exit code. It has no side effects beyond the underlying command execution.

**Call relations**: This helper is used by `get_git_diff` for commands like `ls-files` where exit code `1` is not expected and should not be treated as success.

*Call graph*: calls 1 internal fn (run_git_command); 1 external calls (format!).


##### `run_git_capture_diff`  (lines 143–159)

```
async fn run_git_capture_diff(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    fsmonitor: FsmonitorOverride,
    config_overrides: &[(String, String)],
    args: &[&str],
) -> Result<St
```

**Purpose**: Runs a Git diff-style command and returns stdout, accepting Git’s special exit code `1` as a successful 'differences found' result. It rejects any other non-zero status.

**Data flow**: It takes the runner, cwd, fsmonitor override, config overrides, and Git args, calls `run_git_command`, and returns `Ok(output.stdout)` when `output.success()` or `output.exit_code == 1`; otherwise it returns a formatted error string. It performs no state mutation outside command execution.

**Call relations**: `get_git_diff` uses this helper for both the main tracked diff and each synthetic untracked-file diff because Git reports actual differences with exit code `1`.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (get_git_diff); 1 external calls (format!).


##### `diff_filter_config_overrides`  (lines 163–205)

```
async fn diff_filter_config_overrides(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    fsmonitor: FsmonitorOverride,
) -> Result<Vec<(String, String)>, String>
```

**Purpose**: Discovers configured executable filter drivers and builds temporary Git config overrides that neutralize them during diff generation. This prevents clean/process filters from running as side effects of `/diff`.

**Data flow**: It takes the runner, cwd, and fsmonitor override, runs `git config --null --name-only --get-regexp` for `EXECUTABLE_FILTER_CONFIG_PATTERN` via `run_git_command`, accepts exit codes `0` and `1`, parses `stdout` as NUL-separated keys, strips `.clean` or `.process` suffixes to derive driver names, sorts and deduplicates them, and returns a vector of `(key, value)` overrides setting `<driver>.clean` and `<driver>.process` to empty strings and `<driver>.required` to `false`. Unexpected exit codes become formatted errors.

**Call relations**: This helper is called once by `get_git_diff` before any diff commands run. Its output is then passed into `run_git_capture_diff` so both tracked and untracked diffs inherit the same helper-disabling environment.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (get_git_diff); 1 external calls (format!).


##### `inside_git_repo`  (lines 208–223)

```
async fn inside_git_repo(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Result<bool, String>
```

**Purpose**: Checks whether the current working directory is inside a Git worktree before any more expensive probing or diff generation occurs. It avoids unnecessary Git probing outside repositories.

**Data flow**: It takes the runner and cwd, calls `run_git_command` with `FsmonitorOverride::Disabled`, no config overrides, and `rev-parse --is-inside-work-tree`, then returns `Ok(output.success())`. Errors from command execution are propagated as `String`.

**Call relations**: This is the first helper called by `get_git_diff`, gating the rest of the workflow so fsmonitor probing and diff commands are skipped entirely for non-repository directories.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (get_git_diff).


##### `run_git_command`  (lines 225–254)

```
async fn run_git_command(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    fsmonitor: FsmonitorOverride,
    config_overrides: &[(String, String)],
    args: &[&str],
) -> Result<Workspa
```

**Purpose**: Builds and executes a Git command with the standard `/diff` safety settings: fsmonitor override, hooks disabled, timeout applied, output cap disabled, and optional environment-based config overrides. It is the common execution primitive for all helpers in this module.

**Data flow**: It takes the runner, cwd, an `FsmonitorOverride`, a slice of `(String, String)` config overrides, and Git args. It constructs argv beginning with `git -c <fsmonitor.git_config_arg()> -c <DISABLE_HOOKS_CONFIG>`, appends the provided args, creates a `WorkspaceCommand` with `cwd`, `DIFF_COMMAND_TIMEOUT`, and `disable_output_cap()`, and if overrides are present adds `GIT_CONFIG_COUNT` plus indexed `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` environment variables. It then awaits `runner.run(command)` and maps any executor error to `String`.

**Call relations**: All command-producing helpers in this file call `run_git_command`, making it the central place where safety and execution policy are enforced.

*Call graph*: calls 2 internal fn (git_config_arg, new); called by 4 (diff_filter_config_overrides, inside_git_repo, run_git_capture_diff, run_git_capture_stdout); 3 external calls (to_path_buf, format!, run).


##### `tests::get_git_diff_returns_not_git_for_non_git_cwd`  (lines 275–290)

```
async fn get_git_diff_returns_not_git_for_non_git_cwd()
```

**Purpose**: Verifies that a non-repository cwd yields `(false, empty diff)` rather than an error. It also checks the command metadata used for the probe.

**Data flow**: It builds a fake cwd and `FakeRunner` with a single `rev-parse` response returning exit code 128, awaits `get_git_diff`, asserts the result equals `Ok((false, String::new()))`, and validates recorded command metadata with `assert_command_metadata`. It writes no external state.

**Call relations**: This test exercises the earliest return path in `get_git_diff`, proving that no further probing or diff commands run outside a Git repo.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_disables_helpers_for_tracked_and_untracked_diffs`  (lines 293–387)

```
async fn get_git_diff_disables_helpers_for_tracked_and_untracked_diffs()
```

**Purpose**: Checks that configured filter helpers are neutralized for both tracked and untracked diff commands. It validates the exact environment overrides attached to those commands.

**Data flow**: It seeds a `FakeRunner` with responses for repo detection, fsmonitor probing, filter-driver discovery, tracked diff, untracked listing, and untracked diff. After awaiting `get_git_diff`, it asserts the combined diff text, inspects recorded commands, and checks that the tracked and untracked diff commands carry the expected `GIT_CONFIG_*` environment from `filter_override_env("filter.evil")`.

**Call relations**: This test targets the interaction between `diff_filter_config_overrides`, `run_git_command`, and the two diff-producing branches inside `get_git_diff`.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_preserves_builtin_fsmonitor_for_diff_workflow`  (lines 390–473)

```
async fn get_git_diff_preserves_builtin_fsmonitor_for_diff_workflow()
```

**Purpose**: Ensures that when fsmonitor probing detects the built-in daemon mode, subsequent diff workflow commands preserve that built-in override instead of disabling fsmonitor entirely. It protects performance-sensitive behavior without sacrificing safety.

**Data flow**: It configures a `FakeRunner` to report a Git repo, `core.fsmonitor=true`, build options containing `fsmonitor--daemon`, then successful diff-related responses under `FsmonitorOverride::BuiltIn`. It awaits `get_git_diff`, asserts the combined diff output, and checks command metadata.

**Call relations**: This test covers the branch where `detect_fsmonitor_override` returns `BuiltIn`, confirming that `get_git_diff` threads that override through later helper calls.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_accepts_diff_exit_code_one`  (lines 476–535)

```
async fn get_git_diff_accepts_diff_exit_code_one()
```

**Purpose**: Verifies that Git diff exit code `1` is treated as success when differences are present. It confirms the special-case semantics implemented by `run_git_capture_diff`.

**Data flow**: It sets up fake responses for repo detection, absent fsmonitor config, no filter drivers, a tracked diff returning exit code 1 with output, and an empty untracked listing. It awaits `get_git_diff`, asserts the result contains the tracked diff text, and validates command metadata.

**Call relations**: This test specifically exercises the success condition in `run_git_capture_diff`, as reached through `get_git_diff`.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_rejects_unexpected_git_diff_status`  (lines 538–602)

```
async fn get_git_diff_rejects_unexpected_git_diff_status()
```

**Purpose**: Checks that diff exit codes other than `0` or `1` are surfaced as errors. It prevents silent acceptance of genuinely failing Git commands.

**Data flow**: It prepares fake responses similar to the previous test but returns exit code 2 for the tracked diff. It awaits `get_git_diff`, expects an error, asserts the exact formatted error string, and checks command metadata.

**Call relations**: This test validates the failure branch in `run_git_capture_diff` as propagated by `get_git_diff`.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_does_not_execute_configured_filters_fsmonitor_or_hooks`  (lines 606–683)

```
async fn get_git_diff_does_not_execute_configured_filters_fsmonitor_or_hooks()
```

**Purpose**: Runs against a real Unix Git repository to prove that `/diff` does not execute configured filter helpers, fsmonitor helpers, or hooks. It is an integration-style safety test.

**Data flow**: It creates a temporary repo, configures user identity, writes tracked files and `.gitattributes`, commits them, creates marker helper scripts for filter, fsmonitor, and hooks, configures Git to use them, modifies a tracked file, then awaits `get_git_diff(&LocalRunner, &repo)`. It asserts the diff contains before/after content and that none of the helper marker files were created.

**Call relations**: This test exercises the full real-command path through `get_git_diff`, `diff_filter_config_overrides`, and `run_git_command`, validating the module’s core safety guarantees against actual Git behavior.

*Call graph*: calls 1 internal fn (get_git_diff); 8 external calls (from_secs, assert_eq!, create_dir, write, sleep, tempdir, run_git_setup, write_marker_helper).


##### `tests::get_git_diff_does_not_execute_helpers_while_checking_dirty_submodules`  (lines 687–742)

```
async fn get_git_diff_does_not_execute_helpers_while_checking_dirty_submodules()
```

**Purpose**: Ensures that dirty-submodule handling does not trigger helper execution inside submodule worktrees. It protects the `--ignore-submodules=dirty` behavior from regressing into side effects.

**Data flow**: It creates real parent and child repositories, adds the child as a submodule, configures a marker filter helper inside the submodule checkout, refreshes the tracked file timestamp/content, then awaits `get_git_diff(&LocalRunner, &repo)`. It asserts the resulting diff is empty and that the helper marker file does not exist.

**Call relations**: This integration test covers the submodule-related flags passed by `get_git_diff`, proving they avoid descending into submodule worktrees in a way that would execute configured helpers.

*Call graph*: calls 1 internal fn (get_git_diff); 8 external calls (from_secs, assert_eq!, create_dir, write, sleep, tempdir, run_git_setup, write_marker_helper).


##### `tests::git_command`  (lines 744–756)

```
fn git_command(fsmonitor: FsmonitorOverride, args: &[&str]) -> Vec<String>
```

**Purpose**: Builds the expected argv vector for normal diff-workflow Git commands in tests. It mirrors the production command prefix exactly.

**Data flow**: It takes an `FsmonitorOverride` and Git args, prepends `git -c <fsmonitor.git_config_arg()> -c <DISABLE_HOOKS_CONFIG>`, appends the provided args, converts each element to `String`, and returns `Vec<String>`. It is pure.

**Call relations**: Multiple fake-runner tests use this helper to define the exact argv they expect `run_git_command` to produce.

*Call graph*: calls 1 internal fn (git_config_arg).


##### `tests::git_probe_command`  (lines 758–764)

```
fn git_probe_command(args: &[&str]) -> Vec<String>
```

**Purpose**: Builds the expected argv vector for fsmonitor probe commands, which intentionally omit the normal diff safety prefix. It keeps probe expectations concise in tests.

**Data flow**: It takes Git args, prepends only `git`, appends the provided args, converts them to `String`, and returns the resulting vector. It has no side effects.

**Call relations**: The fsmonitor-related tests use this helper for responses consumed by `WorkspaceFsmonitorProbeRunner::run_probe` during `detect_fsmonitor_override`.


##### `tests::filter_override_env`  (lines 766–785)

```
fn filter_override_env(driver: &str) -> HashMap<String, Option<String>>
```

**Purpose**: Constructs the exact environment map expected when a filter driver is disabled for diff commands. It mirrors the `GIT_CONFIG_*` variables produced by production code.

**Data flow**: It takes a driver name and returns a `HashMap<String, Option<String>>` containing `GIT_CONFIG_COUNT=3` plus keys and values for `<driver>.clean`, `<driver>.process`, and `<driver>.required=false`. It is pure test data construction.

**Call relations**: Tests comparing recorded command environments call this helper to assert that `diff_filter_config_overrides` and `run_git_command` combined to produce the right override set.

*Call graph*: 3 external calls (from, new, format!).


##### `tests::response`  (lines 787–796)

```
fn response(argv: Vec<String>, exit_code: i32, stdout: &str) -> FakeResponse
```

**Purpose**: Packages an expected argv and synthetic command output into a `FakeResponse` for the fake runner queue. It reduces boilerplate in command-sequence tests.

**Data flow**: It takes an argv vector, exit code, and stdout string, constructs a `WorkspaceCommandOutput` with empty stderr, wraps both into `FakeResponse`, and returns it. It performs no side effects.

**Call relations**: All fake-runner tests use this helper to define the ordered responses that `FakeRunner::run` will pop and validate.

*Call graph*: 1 external calls (new).


##### `tests::null_device`  (lines 798–800)

```
fn null_device() -> &'static str
```

**Purpose**: Returns the platform-specific null device path used in expected untracked diff commands. It keeps tests aligned with production’s Windows/Unix branch.

**Data flow**: It checks `cfg!(windows)` and returns either `"NUL"` or `"/dev/null"` as a static string. It is pure.

**Call relations**: Tests that assert the exact argv for `git diff --no-index` use this helper to match the production branch in `get_git_diff`.

*Call graph*: 1 external calls (cfg!).


##### `tests::run_git_setup`  (lines 803–816)

```
fn run_git_setup(cwd: &Path, args: &[&str])
```

**Purpose**: Executes real Git setup commands in integration tests and asserts they succeed. It is used to prepare repositories with specific helper configurations.

**Data flow**: On Unix, it takes a cwd and args, runs `git` via `std::process::Command`, captures output, and asserts the exit code is `0`, including stdout/stderr in the failure message. It mutates the filesystem and repository state as part of test setup.

**Call relations**: The real-repository integration tests call this repeatedly to initialize repos, configure helpers, add submodules, and commit fixtures before invoking `get_git_diff`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::write_marker_helper`  (lines 819–827)

```
fn write_marker_helper(path: &Path)
```

**Purpose**: Creates an executable shell helper that records whether it was run by appending to a `.ran` file. It lets integration tests detect accidental helper execution.

**Data flow**: On Unix, it writes a shell script to `path`, reads and modifies its permissions to mode `0o755`, and writes the updated permissions back. The script itself appends `ran` to `$0.ran` and exits with status 1 when executed.

**Call relations**: The integration tests use this helper to create fake filter, fsmonitor, hook, and submodule helpers whose execution can be detected after `get_git_diff` runs.

*Call graph*: 3 external calls (metadata, set_permissions, write).


##### `tests::assert_command_metadata`  (lines 829–845)

```
fn assert_command_metadata(commands: &[WorkspaceCommand], cwd: &Path)
```

**Purpose**: Checks that recorded workspace commands carry the expected cwd, timeout, output-cap, and environment settings. It verifies execution policy separately from command argv.

**Data flow**: It takes a slice of recorded `WorkspaceCommand` values and the expected cwd, iterates over each command, asserts `command.cwd` matches, and then branches on argv to distinguish probe commands (`config`/`version`) from diff-workflow commands. Probe commands must have empty env, a 5-second timeout, and normal output cap; other commands must use `DIFF_COMMAND_TIMEOUT` and `disable_output_cap=true`.

**Call relations**: Most tests call this after `get_git_diff` to ensure `run_git_command` and probe execution preserve the intended metadata policy.

*Call graph*: 2 external calls (assert_eq!, matches!).


##### `tests::FakeRunner::new`  (lines 858–863)

```
fn new(responses: Vec<FakeResponse>) -> Self
```

**Purpose**: Constructs a fake workspace command executor with a queued response list and empty command log. It is the core test double for deterministic command-sequence tests.

**Data flow**: It takes a vector of `FakeResponse`, converts it into a `VecDeque` inside a `Mutex`, initializes an empty `Vec<WorkspaceCommand>` inside another `Mutex`, and returns `FakeRunner`. It has no external side effects.

**Call relations**: The fake-runner unit tests instantiate this helper before calling `get_git_diff`, then inspect the recorded commands afterward.

*Call graph*: 2 external calls (new, new).


##### `tests::FakeRunner::commands`  (lines 865–872)

```
fn commands(&self) -> Vec<WorkspaceCommand>
```

**Purpose**: Returns the list of commands executed by the fake runner and asserts that all queued responses were consumed. It catches missing or extra command executions in tests.

**Data flow**: It locks the response queue, asserts its length is zero, then locks and clones the recorded command vector and returns it. It reads internal fake-runner state but does not mutate external state.

**Call relations**: Tests call this after `get_git_diff` completes to inspect command metadata and ensure the expected number of commands were issued.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::FakeRunner::run`  (lines 876–893)

```
fn run(
            &self,
            command: WorkspaceCommand,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<WorkspaceCommandOutput, WorkspaceCommandError>>
```

**Purpose**: Implements `WorkspaceCommandExecutor` for the fake runner by validating each incoming command against the next queued expectation and returning the corresponding synthetic output. It makes command ordering and argv exactness part of the tests.

**Data flow**: It takes a `WorkspaceCommand`, returns a boxed future, locks the queued responses, pops the front response, asserts `command.argv == response.argv`, records the command in the command log, and returns `Ok(response.output)`. It mutates the fake runner’s internal queues and logs.

**Call relations**: Production helpers like `run_git_command` call this indirectly during tests through the `WorkspaceCommandExecutor` trait, allowing the tests to verify exact command sequences.

*Call graph*: 2 external calls (pin, assert_eq!).


##### `tests::LocalRunner::run`  (lines 901–933)

```
fn run(
            &self,
            command: WorkspaceCommand,
        ) -> Pin<
            Box<
                dyn Future<Output = Result<WorkspaceCommandOutput, WorkspaceCommandError>>
```

**Purpose**: Implements `WorkspaceCommandExecutor` by actually spawning local processes for integration tests. It lets `get_git_diff` run against real Git repositories without the production executor.

**Data flow**: It takes a `WorkspaceCommand`, returns a boxed future, constructs a `std::process::Command` from `command.argv[0]`, applies remaining args, cwd, and environment mutations, executes `.output()`, and converts the result into `WorkspaceCommandOutput` with UTF-8 stdout/stderr strings and the process exit code. It performs real process execution and filesystem interaction.

**Call relations**: The Unix integration tests pass `LocalRunner` into `get_git_diff` to validate behavior against actual Git rather than fake responses.

*Call graph*: 3 external calls (pin, new, from_utf8).


### Plugin packaging and marketplace updates
These files cover plugin archive transport plus the filesystem and git helpers used to install and activate marketplace content safely.

### `core-plugins/src/plugin_bundle_archive.rs`

`io_transport` · `plugin upload/download packaging`

This file implements both sides of plugin bundle archival with explicit safety limits. `pack_plugin_bundle_tar_gz` first validates that the input path is a directory and contains `.codex-plugin/plugin.json`, then streams a tar archive through a gzip encoder backed by `SizeLimitedBuffer`. That custom writer tracks the compressed byte count and raises a typed `ArchiveSizeLimitExceeded` error once the archive would exceed the configured maximum. Directory traversal during packing is deterministic because `append_plugin_tree` sorts directory entries by filename before recursively appending directories and files; non-file, non-directory entries are rejected.

Unpacking starts by creating the destination directory and wrapping the input bytes in `GzDecoder` and `tar::Archive`. `unpack_plugin_bundle_tar` iterates entries, computes a safe output path with `checked_tar_output_path`, and rejects empty paths, absolute paths, prefixes, and `..` traversal so tar entries cannot escape the extraction root. It also rejects symlinks and hard links outright. For regular files it enforces a cumulative extracted-size limit with overflow protection before creating parent directories and unpacking the entry. Errors are split into contextual I/O failures, invalid-bundle structural problems, and extracted-size-limit violations. The result is a conservative archive format handler suitable for untrusted plugin bundles.

#### Function details

##### `PluginBundleUnpackError::io`  (lines 47–49)

```
fn io(context: &'static str, source: io::Error) -> Self
```

**Purpose**: Constructs the contextual I/O variant of `PluginBundleUnpackError`. It keeps unpacking code concise and consistent.

**Data flow**: Takes a static context string and an `io::Error`, wraps them into `PluginBundleUnpackError::Io`, and returns the enum value.

**Call relations**: Used throughout unpacking paths whenever filesystem or tar-reading operations fail and need a stable human-readable context.


##### `pack_plugin_bundle_tar_gz`  (lines 52–77)

```
fn pack_plugin_bundle_tar_gz(
    plugin_path: &Path,
    max_bytes: usize,
) -> Result<Vec<u8>, PluginBundlePackError>
```

**Purpose**: Creates a gzip-compressed tar archive of a plugin directory while enforcing a maximum compressed size. It also validates that the source path looks like a plugin package before archiving.

**Data flow**: Inputs are `plugin_path` and `max_bytes`. It checks `plugin_path.is_dir()` and that `.codex-plugin/plugin.json` exists as a file, returning `PluginBundlePackError::InvalidPluginPath` otherwise. It then creates a `GzEncoder<SizeLimitedBuffer>`, wraps it in `tar::Builder`, recursively appends the plugin tree with `append_plugin_tree`, extracts the encoder with `into_inner`, finishes compression, converts the buffer into `Vec<u8>`, and maps any `io::Error` through `archive_io_error`.

**Call relations**: Called by higher-level upload code when a local plugin must be archived. It delegates recursive traversal to `append_plugin_tree` and error classification to `archive_io_error`.

*Call graph*: calls 2 internal fn (new, append_plugin_tree); called by 1 (archive_plugin_for_upload_with_limit); 6 external calls (new, is_dir, join, to_path_buf, default, new).


##### `append_plugin_tree`  (lines 79–108)

```
fn append_plugin_tree(
    archive: &mut tar::Builder<W>,
    plugin_root: &Path,
    current: &Path,
) -> io::Result<()>
```

**Purpose**: Recursively appends a plugin directory tree into a tar archive in deterministic filename order. It includes directories and regular files only.

**Data flow**: Receives a mutable tar builder, the plugin root, and the current directory. It reads and collects directory entries, sorts them by filename, computes each entry's path relative to the plugin root, and for directories appends the directory entry then recurses; for files it appends the file contents under the relative path; for any other file type it returns `io::Error::other` describing the unsupported entry.

**Call relations**: Used only by `pack_plugin_bundle_tar_gz` to build the archive contents. Its sorted traversal ensures stable archive ordering across runs.

*Call graph*: called by 1 (pack_plugin_bundle_tar_gz); 5 external calls (append_dir, append_path_with_name, other, format!, read_dir).


##### `archive_io_error`  (lines 110–122)

```
fn archive_io_error(source: io::Error) -> PluginBundlePackError
```

**Purpose**: Maps raw archive-building `io::Error`s into the public packing error enum, preserving size-limit violations as a dedicated variant. It distinguishes ordinary I/O failures from intentional archive-size enforcement.

**Data flow**: Inspects `source.get_ref()` for a downcast `ArchiveSizeLimitExceeded`. If present, it returns `PluginBundlePackError::ArchiveTooLarge` with the embedded byte counts; otherwise it wraps the original error in `PluginBundlePackError::Io`.

**Call relations**: Used by `pack_plugin_bundle_tar_gz` after recursive append, tar finalization, and gzip finish operations.

*Call graph*: 1 external calls (get_ref).


##### `unpack_plugin_bundle_tar_gz`  (lines 124–139)

```
fn unpack_plugin_bundle_tar_gz(
    bytes: &[u8],
    destination: &Path,
    max_total_bytes: u64,
) -> Result<(), PluginBundleUnpackError>
```

**Purpose**: Creates the extraction directory and unpacks a gzip-compressed tar plugin bundle with total-size enforcement. It is the public entrypoint for bundle extraction.

**Data flow**: Takes archive bytes, destination path, and `max_total_bytes`. It creates the destination directory, wraps the bytes in `Cursor`, `GzDecoder`, and `tar::Archive`, then calls `unpack_plugin_bundle_tar`. Directory creation failures become contextual `PluginBundleUnpackError::Io` values.

**Call relations**: Called by higher-level extraction code and tests. It delegates all tar-entry validation and extraction logic to `unpack_plugin_bundle_tar`.

*Call graph*: calls 2 internal fn (unpack_plugin_bundle_tar, new); called by 2 (archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths, extract_plugin_bundle_tar_gz_with_limits); 3 external calls (new, new, create_dir_all).


##### `unpack_plugin_bundle_tar`  (lines 141–203)

```
fn unpack_plugin_bundle_tar(
    archive: &mut Archive<R>,
    destination: &Path,
    max_total_bytes: u64,
) -> Result<(), PluginBundleUnpackError>
```

**Purpose**: Iterates tar entries, validates each path and type, enforces cumulative extracted size, and writes directories/files into the destination. It rejects links and unsupported entry types.

**Data flow**: Accepts a mutable `Archive<R>`, destination path, and max total bytes. It initializes `extracted_bytes`, obtains `archive.entries()`, and loops over entries. For each entry it reads the header type, size, and path, computes a safe output path with `checked_tar_output_path`, then: creates directories for directory entries; for file entries, calls `enforce_total_extracted_size`, ensures the parent exists, and unpacks the file; for symlinks or hard links, returns `InvalidBundle`; for any other type, returns `InvalidBundle` naming the unsupported type. On success it returns `Ok(())`.

**Call relations**: This is the core extraction routine called by `unpack_plugin_bundle_tar_gz`. It relies on `checked_tar_output_path` for path safety and `enforce_total_extracted_size` for resource limits.

*Call graph*: calls 2 internal fn (checked_tar_output_path, enforce_total_extracted_size); called by 1 (unpack_plugin_bundle_tar_gz); 4 external calls (entries, InvalidBundle, format!, create_dir_all).


##### `checked_tar_output_path`  (lines 205–234)

```
fn checked_tar_output_path(
    destination: &Path,
    entry_name: &Path,
) -> Result<PathBuf, PluginBundleUnpackError>
```

**Purpose**: Builds a destination path for a tar entry while ensuring the entry cannot escape the extraction root. It rejects absolute, prefixed, parent-directory, and empty paths.

**Data flow**: Takes the extraction `destination` and tar `entry_name`, starts from `destination.to_path_buf()`, iterates path components, appending only `Normal` components, ignoring `CurDir`, and returning `InvalidBundle` if it sees `ParentDir`, `RootDir`, or a Windows prefix. If no normal component was appended, it returns `InvalidBundle` for an empty path; otherwise it returns the assembled `PathBuf`.

**Call relations**: Called for every tar entry by `unpack_plugin_bundle_tar` before any filesystem writes occur.

*Call graph*: called by 1 (unpack_plugin_bundle_tar); 4 external calls (components, to_path_buf, InvalidBundle, format!).


##### `enforce_total_extracted_size`  (lines 236–255)

```
fn enforce_total_extracted_size(
    entry_size: u64,
    extracted_bytes: &mut u64,
    max_total_bytes: u64,
) -> Result<(), PluginBundleUnpackError>
```

**Purpose**: Tracks cumulative extracted file size and rejects archives whose total extracted bytes would exceed the configured limit. It also guards against integer overflow.

**Data flow**: Receives the current entry size, a mutable running total, and the maximum allowed total. It computes `checked_add`, returning `ExtractedBundleTooLarge` with `u64::MAX` on overflow, then compares the next total to `max_total_bytes`, returning the same error variant if exceeded. Otherwise it updates `*extracted_bytes` and returns `Ok(())`.

**Call relations**: Used by `unpack_plugin_bundle_tar` immediately before unpacking each regular file.

*Call graph*: called by 1 (unpack_plugin_bundle_tar).


##### `SizeLimitedBuffer::new`  (lines 263–268)

```
fn new(max_bytes: usize) -> Self
```

**Purpose**: Constructs the in-memory output buffer used during archive packing with a configured maximum size. It starts empty and records the byte ceiling for later writes.

**Data flow**: Takes `max_bytes`, initializes `bytes` as an empty `Vec<u8>`, stores the limit, and returns `SizeLimitedBuffer`.

**Call relations**: Called by `pack_plugin_bundle_tar_gz` as the sink behind the gzip encoder.

*Call graph*: called by 1 (pack_plugin_bundle_tar_gz); 1 external calls (new).


##### `SizeLimitedBuffer::into_inner`  (lines 270–272)

```
fn into_inner(self) -> Vec<u8>
```

**Purpose**: Extracts the accumulated archive bytes from the size-limited buffer after packing completes. It consumes the wrapper.

**Data flow**: Consumes `self` and returns the owned `Vec<u8>` stored in `bytes`.

**Call relations**: Used at the end of `pack_plugin_bundle_tar_gz` after gzip finalization.


##### `SizeLimitedBuffer::write`  (lines 276–292)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Implements bounded writes for archive packing, failing once the compressed output would exceed the configured maximum. It is the mechanism behind `ArchiveTooLarge` detection.

**Data flow**: Receives a byte slice, computes the next length with `checked_add`, returning `io::Error::other(ArchiveSizeLimitExceeded)` on overflow. If the next length exceeds `max_bytes`, it returns the same typed error with the projected size. Otherwise it appends the bytes to `self.bytes` and returns the number of bytes written.

**Call relations**: Called indirectly by the gzip encoder during `pack_plugin_bundle_tar_gz`. Its typed inner error is later recognized by `archive_io_error`.

*Call graph*: 1 external calls (other).


##### `SizeLimitedBuffer::flush`  (lines 294–296)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Implements the `Write` trait's flush operation for the in-memory buffer. Since the buffer is purely memory-backed, flushing is a no-op.

**Data flow**: Reads no external state, performs no mutation beyond trait compliance, and returns `Ok(())`.

**Call relations**: Used implicitly by the encoder/writer stack during archive creation.


##### `ArchiveSizeLimitExceeded::fmt`  (lines 306–312)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the internal size-limit error into a human-readable message. It provides the text embedded in wrapped I/O errors.

**Data flow**: Reads `self.bytes` and `self.max_bytes` and writes a sentence describing the exceeded archive size into the formatter.

**Call relations**: Used implicitly when `ArchiveSizeLimitExceeded` is wrapped in `io::Error` and later surfaced or downcast by packing code.

*Call graph*: 1 external calls (write!).


### `core-plugins/src/marketplace_add/install.rs`

`util` · `marketplace add`

This helper module contains the imperative install primitives behind `marketplace_add`. `clone_git_source` supports both full clones and sparse checkouts. For ordinary clones it runs `git clone <url> <destination>` and optionally `git checkout <ref>`. For sparse mode it performs a no-checkout clone with blob filtering, configures sparse checkout paths, and then checks out the requested ref or `HEAD`.

The remaining helpers enforce safe installation semantics. `safe_marketplace_dir_name` sanitizes marketplace names into filesystem-safe directory names by replacing non-alphanumeric punctuation with `-`, trimming leading/trailing dots, and rejecting empty or `..` results. `ensure_marketplace_destination_is_inside_install_root` canonicalizes the install root and destination parent and verifies the destination remains under the install root, preventing path-escape bugs. `replace_marketplace_root` creates the destination parent if needed and renames the staged directory into place, giving the caller an atomic-ish install step. `marketplace_staging_root` standardizes the `.staging` subdirectory used for temporary clones. All git command execution flows through `run_git`, which disables terminal prompts and returns detailed stdout/stderr in `MarketplaceAddError::Internal` on failure.

#### Function details

##### `clone_git_source`  (lines 7–43)

```
fn clone_git_source(
    url: &str,
    ref_name: Option<&str>,
    sparse_paths: &[String],
    destination: &Path,
) -> Result<(), MarketplaceAddError>
```

**Purpose**: Clones a git marketplace source into a destination directory, optionally using sparse checkout and an explicit ref. It supports both full and sparse clone workflows.

**Data flow**: Receives a repository `url`, optional `ref_name`, sparse path list, and destination path; converts the destination to a string; if `sparse_paths` is empty it runs `git clone` and optional `git checkout`; otherwise it runs a filtered `git clone --no-checkout`, configures sparse checkout paths, and checks out the requested ref or `HEAD`.

**Call relations**: Injected into `add_marketplace_sync_with_cloner` as the real cloner. It delegates all command execution and error formatting to `run_git`.

*Call graph*: calls 1 internal fn (run_git); 3 external calls (new, to_string_lossy, vec!).


##### `safe_marketplace_dir_name`  (lines 45–65)

```
fn safe_marketplace_dir_name(
    marketplace_name: &str,
) -> Result<String, MarketplaceAddError>
```

**Purpose**: Sanitizes a marketplace name into a safe install-directory name. It prevents problematic names from being used directly as filesystem paths.

**Data flow**: Maps each character of `marketplace_name`, preserving ASCII alphanumerics plus `-`, `_`, and `.`, replacing everything else with `-`; trims leading/trailing dots; rejects empty or `..`; and returns the sanitized string or `InvalidRequest`.

**Call relations**: Called by the add workflow before computing the final install destination under the marketplace install root.

*Call graph*: called by 1 (add_marketplace_sync_with_cloner); 2 external calls (InvalidRequest, format!).


##### `ensure_marketplace_destination_is_inside_install_root`  (lines 67–97)

```
fn ensure_marketplace_destination_is_inside_install_root(
    install_root: &Path,
    destination: &Path,
) -> Result<(), MarketplaceAddError>
```

**Purpose**: Verifies that the computed marketplace destination path stays within the canonical install root. It guards against path traversal or malformed destination construction.

**Data flow**: Canonicalizes `install_root`, obtains and canonicalizes `destination.parent()`, checks `destination_parent.starts_with(install_root)`, and returns `Ok(())` or an `InvalidRequest`/`Internal` error describing the failure.

**Call relations**: Used by `add_marketplace_sync_with_cloner` immediately before installing a staged marketplace.

*Call graph*: called by 1 (add_marketplace_sync_with_cloner); 4 external calls (canonicalize, parent, InvalidRequest, format!).


##### `replace_marketplace_root`  (lines 99–107)

```
fn replace_marketplace_root(
    staged_root: &Path,
    destination: &Path,
) -> std::io::Result<()>
```

**Purpose**: Moves a staged marketplace directory into its final destination, creating parent directories first if necessary. It is the final filesystem install step.

**Data flow**: Checks `destination.parent()`, creates it with `fs::create_dir_all`, then renames `staged_root` to `destination` and returns the underlying `std::io::Result<()>`.

**Call relations**: Called by the add workflow after validation and before config recording.

*Call graph*: called by 1 (add_marketplace_sync_with_cloner); 3 external calls (parent, create_dir_all, rename).


##### `marketplace_staging_root`  (lines 109–111)

```
fn marketplace_staging_root(install_root: &Path) -> PathBuf
```

**Purpose**: Computes the standard staging directory used for temporary marketplace clones. It keeps staging layout consistent across add operations.

**Data flow**: Joins `.staging` onto the provided install root and returns the resulting `PathBuf`.

**Call relations**: Used by `add_marketplace_sync_with_cloner` before creating a temporary staged clone directory.

*Call graph*: called by 1 (add_marketplace_sync_with_cloner); 1 external calls (join).


##### `run_git`  (lines 113–137)

```
fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), MarketplaceAddError>
```

**Purpose**: Executes a git command with prompts disabled and returns a detailed internal error if the command fails. It centralizes subprocess invocation and diagnostics for marketplace cloning.

**Data flow**: Builds a `Command::new("git")`, appends args, sets `GIT_TERMINAL_PROMPT=0`, optionally sets `current_dir`, captures output, returns `Ok(())` on success, and otherwise formats status/stdout/stderr into `MarketplaceAddError::Internal`.

**Call relations**: Used exclusively by `clone_git_source` for all git subprocesses.

*Call graph*: called by 1 (clone_git_source); 4 external calls (from_utf8_lossy, new, Internal, format!).


### `core-plugins/src/marketplace_upgrade/activation.rs`

`io_transport` · `marketplace activation / upgrade commit`

This submodule encapsulates the risky filesystem parts of marketplace upgrade. It defines a private `InstalledMarketplaceMetadata` JSON schema stored as `.codex-marketplace-install.json` inside an activated marketplace root. That metadata captures `MarketplaceSourceType::Git`, the configured source URL, optional ref name, sparse checkout paths, and the resolved revision. The metadata is used both to decide whether an installed marketplace still matches the current configuration and to persist provenance for future no-op checks.

The central function is `activate_marketplace_root`, which performs an atomic-ish staged activation with rollback. It ensures the destination parent exists, then distinguishes between replacing an existing install and activating a brand-new one. When replacing, it first moves the old destination into a temporary backup directory, then renames the staged directory into place. If that rename fails, it attempts to restore the backup. If the caller-supplied `after_activate` closure fails—typically while updating config—it removes the newly activated destination and restores the backup, preserving the previous marketplace when possible. For first-time installs, it simply renames the staged root into place and removes it again if the callback fails. Error messages include destination and backup paths so operators can recover manually when rollback also fails.

#### Function details

##### `installed_marketplace_metadata_matches`  (lines 22–43)

```
fn installed_marketplace_metadata_matches(
    root: &Path,
    marketplace: &ConfiguredGitMarketplace,
    revision: &str,
) -> bool
```

**Purpose**: Checks whether the metadata file inside an installed marketplace exactly matches the expected configured Git marketplace and revision. It is used to decide whether an upgrade can be skipped safely.

**Data flow**: Given an install `root`, a `ConfiguredGitMarketplace`, and a revision string, it reads the metadata JSON file at `installed_marketplace_metadata_path(root)`. Read failure returns `false`. It then parses JSON into `InstalledMarketplaceMetadata`; parse failure logs a warning tagged with the marketplace name and returns `false`. On success it compares the parsed struct to `installed_marketplace_metadata(marketplace, revision)` and returns the equality result.

**Call relations**: Called by `upgrade_configured_git_marketplace` as part of the no-op fast path. It delegates expected-value construction to `installed_marketplace_metadata` and path computation to `installed_marketplace_metadata_path`.

*Call graph*: calls 2 internal fn (installed_marketplace_metadata, installed_marketplace_metadata_path); called by 1 (upgrade_configured_git_marketplace); 2 external calls (read_to_string, warn!).


##### `write_installed_marketplace_metadata`  (lines 45–55)

```
fn write_installed_marketplace_metadata(
    root: &Path,
    marketplace: &ConfiguredGitMarketplace,
    revision: &str,
) -> Result<(), String>
```

**Purpose**: Serializes and writes the install metadata file into a staged marketplace root before activation. This records the exact source/ref/sparse-path/revision combination that produced the installed tree.

**Data flow**: Accepts a root path, configured marketplace, and revision string; builds the metadata struct with `installed_marketplace_metadata`, serializes it with `serde_json::to_string_pretty`, and writes it to `installed_marketplace_metadata_path(root)`. Serialization or write failures are converted into contextual `Err(String)` values.

**Call relations**: Invoked by `upgrade_configured_git_marketplace` after clone and validation but before activation. It pairs with `installed_marketplace_metadata_matches`, which later reads the same file.

*Call graph*: calls 2 internal fn (installed_marketplace_metadata, installed_marketplace_metadata_path); called by 1 (upgrade_configured_git_marketplace); 2 external calls (to_string_pretty, write).


##### `activate_marketplace_root`  (lines 57–150)

```
fn activate_marketplace_root(
    destination: &Path,
    staged_dir: TempDir,
    after_activate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String>
```

**Purpose**: Moves a staged marketplace directory into its final destination and runs a post-activation callback, rolling back to the previous install when possible if activation or callback work fails. It is the transactional boundary of marketplace upgrade.

**Data flow**: Inputs are the final `destination`, a `TempDir` containing the staged root, and an `after_activate` closure. It reads the staged path, ensures the destination parent exists, and branches on whether `destination.exists()`. For replacement installs, it creates a temporary backup dir under the parent, renames the existing destination into `backup_root`, renames the staged root into destination, then runs `after_activate`. If activation rename fails it tries to rename the backup back; if the callback fails it removes the new destination and restores the backup. For fresh installs, it renames staged root into destination and, on callback failure, removes the new destination. It returns `Ok(())` on success or a detailed `Err(String)` describing activation and rollback outcomes.

**Call relations**: Called only by `upgrade_configured_git_marketplace` after staging and metadata write. The callback supplied there performs config consistency checking and config.toml update, so this function owns the rollback semantics around those higher-level side effects.

*Call graph*: called by 1 (upgrade_configured_git_marketplace); 8 external calls (exists, parent, path, format!, create_dir_all, remove_dir_all, rename, new).


##### `installed_marketplace_metadata`  (lines 152–163)

```
fn installed_marketplace_metadata(
    marketplace: &ConfiguredGitMarketplace,
    revision: &str,
) -> InstalledMarketplaceMetadata
```

**Purpose**: Builds the canonical metadata struct representing one installed Git marketplace at a specific revision. It centralizes the exact fields used for persistence and equality checks.

**Data flow**: Takes a `ConfiguredGitMarketplace` and revision string, clones the marketplace's `source`, `ref_name`, and `sparse_paths`, sets `source_type` to `MarketplaceSourceType::Git`, copies the revision into a new `String`, and returns an `InstalledMarketplaceMetadata` value.

**Call relations**: Used by both metadata read/compare and metadata write paths so they share identical field construction.

*Call graph*: called by 2 (installed_marketplace_metadata_matches, write_installed_marketplace_metadata).


##### `installed_marketplace_metadata_path`  (lines 165–167)

```
fn installed_marketplace_metadata_path(root: &Path) -> PathBuf
```

**Purpose**: Computes the path of the metadata file stored inside an installed marketplace root. It hides the fixed filename constant from callers.

**Data flow**: Receives a marketplace root `&Path`, joins `.codex-marketplace-install.json`, and returns the resulting `PathBuf`.

**Call relations**: Called by both `installed_marketplace_metadata_matches` and `write_installed_marketplace_metadata` to ensure they read and write the same file location.

*Call graph*: called by 2 (installed_marketplace_metadata_matches, write_installed_marketplace_metadata); 1 external calls (join).


### Execution and process support
This set provides the shared execution utility layer, process abstractions, output buffering, sandbox exec helpers, and exit-status translation used when launching and supervising commands.

### `core/src/tools/mod.rs`

`util` · `cross-cutting during tool setup, telemetry, and output formatting`

Beyond declaring the tool subsystem’s submodules and re-exporting `ToolRouter`, this file contains several cross-cutting helpers that other tool code relies on. The telemetry constants cap preview size at 2 KiB and 64 lines and provide a fixed truncation notice string, documenting the intent to keep log events below model-budget limits.

`flat_tool_name` is a boundary adapter for legacy consumers that still require a single string rather than structured `ToolName { namespace, name }`. If a namespace exists, it concatenates namespace and name into an owned `String`; otherwise it returns a borrowed view of the plain name. The comment explicitly warns that comparisons and sorting should still happen on `ToolName` itself.

`tool_user_shell_type` maps the crate’s internal `crate::shell::ShellType` enum to the public `codex_tools::ToolUserShellType` enum one-for-one, preserving shell identity for downstream tools.

The two formatting functions turn `ExecToolCallOutput` into model-facing text. Both first call `build_content_with_timeout`, which prepends a timeout line when `timed_out` is true and otherwise returns the aggregated output text unchanged. `format_exec_output_for_model` then computes rounded wall time, counts total lines before truncation, truncates with `truncate_text`, and emits a multi-section string containing exit code, wall time, optional total-line count when truncation removed lines, and the truncated output body. `format_exec_output_str` is a lighter variant that returns only the truncated content string via `formatted_truncate_text`, suitable for contexts that do not need metadata headers.

#### Function details

##### `flat_tool_name`  (lines 36–46)

```
fn flat_tool_name(tool_name: &ToolName) -> Cow<'_, str>
```

**Purpose**: Flattens a structured `ToolName` into the legacy single-string form expected by telemetry, hooks, approval prompts, and similar boundaries. It avoids allocation when the tool has no namespace.

**Data flow**: Reads `tool_name: &ToolName` → if `namespace` is `Some`, allocates a `String` sized for namespace plus name, appends both pieces, and returns `Cow::Owned`; otherwise returns `Cow::Borrowed(tool_name.name.as_str())` → does not mutate external state.

**Call relations**: Many higher-level flows call this before crossing APIs that cannot carry structured names, including telemetry emission, approval requests, orchestration, and hook naming. It is a leaf helper that performs the flattening directly.

*Call graph*: called by 7 (emit_metric_for_tool_read, request_approval, run, dispatch_any_with_terminal_outcome, function_hook_tool_name, network_approval_spec, network_approval_spec); 3 external calls (Borrowed, Owned, with_capacity).


##### `tool_user_shell_type`  (lines 48–58)

```
fn tool_user_shell_type(
    user_shell: &crate::shell::Shell,
) -> codex_tools::ToolUserShellType
```

**Purpose**: Converts the runtime’s shell descriptor into the tool-facing shell-type enum. This keeps shell-specific behavior aligned across internal and external representations.

**Data flow**: Reads `user_shell: &crate::shell::Shell`, specifically `user_shell.shell_type` → matches each internal `ShellType` variant (`Zsh`, `Bash`, `PowerShell`, `Sh`, `Cmd`) to the corresponding `codex_tools::ToolUserShellType` variant → returns the mapped enum.

**Call relations**: Session and review-thread setup code call this when they need to expose the user’s shell type to tool-related logic. It does not delegate further and serves as a pure enum translation point.

*Call graph*: called by 2 (spawn_review_thread, make_turn_context).


##### `format_exec_output_for_model`  (lines 62–87)

```
fn format_exec_output_for_model(
    exec_output: &ExecToolCallOutput,
    truncation_policy: TruncationPolicy,
) -> String
```

**Purpose**: Formats command execution results into a model-facing report with metadata headers and safely truncated output. It is the richer presentation used when the model should see exit code and timing context alongside command output.

**Data flow**: Reads `exec_output: &ExecToolCallOutput` and a `TruncationPolicy` → computes rounded duration in seconds from `exec_output.duration` → gets raw content from `build_content_with_timeout` → counts original lines, truncates content with `truncate_text`, builds a `Vec<String>` containing exit code, wall time, optional total-line count when truncation reduced line count, an `Output:` header, and the truncated body → joins sections with newlines and returns the final `String`.

**Call relations**: This helper is used where command results are packaged for model consumption with explicit metadata. It delegates content extraction and timeout-prefix logic to `build_content_with_timeout`, then performs truncation and report assembly itself.

*Call graph*: calls 1 internal fn (build_content_with_timeout); 3 external calls (new, truncate_text, format!).


##### `format_exec_output_str`  (lines 89–97)

```
fn format_exec_output_str(
    exec_output: &ExecToolCallOutput,
    truncation_policy: TruncationPolicy,
) -> String
```

**Purpose**: Produces a truncated output string for model consumption without adding exit-code or timing headers. It is the compact serialization path for callers that only need the textual body.

**Data flow**: Reads `exec_output` and `truncation_policy` → obtains content from `build_content_with_timeout` → truncates and formats it with `formatted_truncate_text` → returns the resulting `String`.

**Call relations**: Shell-command execution and related tests call this when they need the output body alone. It shares timeout handling with `format_exec_output_for_model` by delegating to `build_content_with_timeout` first.

*Call graph*: calls 1 internal fn (build_content_with_timeout); called by 3 (includes_timed_out_message, execute_user_shell_command, user_shell_command_fragment); 1 external calls (formatted_truncate_text).


##### `build_content_with_timeout`  (lines 100–110)

```
fn build_content_with_timeout(exec_output: &ExecToolCallOutput) -> String
```

**Purpose**: Extracts the aggregated command output and prepends a timeout notice when the command exceeded its time limit. It centralizes the timeout-message convention used by both formatting helpers.

**Data flow**: Reads `exec_output.timed_out`, `exec_output.duration.as_millis()`, and `exec_output.aggregated_output.text` → if timed out, returns a new formatted string beginning with `command timed out after ... milliseconds` followed by the original text; otherwise clones and returns the aggregated text unchanged.

**Call relations**: Both output-formatting functions call this first so timeout messaging stays consistent across metadata-rich and body-only renderings. It is intentionally private because it exists only to support those two public helpers.

*Call graph*: called by 2 (format_exec_output_for_model, format_exec_output_str); 1 external calls (format!).


### `core/src/unified_exec/head_tail_buffer.rs`

`domain_logic` · `process output retention during streaming and final aggregation`

This file defines `HeadTailBuffer`, a transcript-retention structure optimized for long-running process output. The buffer splits a fixed `max_bytes` budget into a stable prefix budget (`head_budget`) and suffix budget (`tail_budget`), storing chunks in two `VecDeque<Vec<u8>>` collections plus counters for retained head bytes, retained tail bytes, and omitted middle bytes. `Default` uses the subsystem-wide `UNIFIED_EXEC_OUTPUT_MAX_BYTES` cap.

`push_chunk` is the main mutation path. It first handles the degenerate zero-capacity case by counting all incoming bytes as omitted. Otherwise it fills the head until `head_budget` is exhausted; if a chunk crosses that boundary, it is split so the prefix remains permanently in `head` and the remainder is forwarded to `push_to_tail`. Once the head is full, all new bytes go to the tail. `push_to_tail` either drops everything when the tail budget is zero, replaces the entire tail with the last `tail_budget` bytes of an oversized chunk, or appends a normal chunk and then calls `trim_tail_to_budget` to evict the oldest tail bytes from the front. This means the retained transcript is always `head` followed by the newest suffix, with omitted bytes counted but not represented.

Readout methods expose the retained state as chunk snapshots or a concatenated byte vector, and `drain_chunks` empties both deques while resetting all counters. The implementation carefully uses saturating arithmetic and partial front-drains so accounting remains stable even under repeated over-budget writes.

#### Function details

##### `HeadTailBuffer::default`  (lines 21–23)

```
fn default() -> Self
```

**Purpose**: Creates a buffer using the subsystem’s standard unified-exec output cap. It is the convenience constructor used by production code and some tests.

**Data flow**: Takes no arguments and returns `HeadTailBuffer::new(UNIFIED_EXEC_OUTPUT_MAX_BYTES)`, initializing budgets and counters through `new`.

**Call relations**: It is used by tests and by unified-exec code paths such as `exec_command` and fallback end-event handling when a standard transcript buffer is needed. It delegates all initialization details to `HeadTailBuffer::new`.

*Call graph*: called by 5 (head_tail_buffer_default_preserves_prefix_and_suffix, push_chunk_preserves_prefix_and_suffix, new, exec_command, failed_initial_end_for_unstored_process_uses_fallback_output); 1 external calls (new).


##### `HeadTailBuffer::new`  (lines 31–44)

```
fn new(max_bytes: usize) -> Self
```

**Purpose**: Initializes a head/tail transcript buffer with a caller-specified byte cap. It deterministically splits the cap into prefix and suffix budgets.

**Data flow**: Accepts `max_bytes`, computes `head_budget = max_bytes / 2` and `tail_budget = max_bytes.saturating_sub(head_budget)`, and returns a `HeadTailBuffer` with empty `VecDeque`s and zeroed byte counters.

**Call relations**: It is the foundational constructor called by `default` and directly by tests. Other methods assume the budget invariants established here.

*Call graph*: called by 6 (chunk_larger_than_tail_budget_keeps_only_tail_end, draining_resets_state, fills_head_then_tail_across_multiple_chunks, head_budget_zero_keeps_only_last_byte_in_tail, keeps_prefix_and_suffix_when_over_budget, max_bytes_zero_drops_everything); 1 external calls (new).


##### `HeadTailBuffer::retained_bytes`  (lines 49–51)

```
fn retained_bytes(&self) -> usize
```

**Purpose**: Reports how many bytes are currently stored across the head and tail segments. It is mainly used for inspection and sizing.

**Data flow**: Reads `head_bytes` and `tail_bytes`, combines them with `saturating_add`, and returns the resulting `usize` without mutating state.

**Call relations**: It is called by `to_bytes` to preallocate the output vector and by tests to assert retention behavior. It provides a cheap summary of current buffer occupancy.

*Call graph*: called by 1 (to_bytes).


##### `HeadTailBuffer::omitted_bytes`  (lines 56–58)

```
fn omitted_bytes(&self) -> usize
```

**Purpose**: Returns the cumulative number of bytes dropped from the middle or discarded due to zero capacity. It exposes truncation severity for tests and diagnostics.

**Data flow**: Reads the `omitted_bytes` counter and returns it unchanged.

**Call relations**: This accessor is used primarily by tests to verify truncation accounting. It reflects mutations performed by `push_chunk`, `push_to_tail`, and `trim_tail_to_budget`.


##### `HeadTailBuffer::push_chunk`  (lines 65–91)

```
fn push_chunk(&mut self, chunk: Vec<u8>)
```

**Purpose**: Appends a new output chunk into the capped transcript, preserving the earliest bytes in the head and the latest bytes in the tail. It is the main ingestion method for process output.

**Data flow**: Consumes an owned `Vec<u8>` chunk and mutates internal deques and counters. If `max_bytes == 0`, it increments `omitted_bytes` by the chunk length and returns. If head space remains, it either stores the whole chunk in `head` and increments `head_bytes`, or splits the chunk at the remaining head capacity, stores the prefix in `head`, and forwards the remainder to `push_to_tail`. If the head is already full, it sends the entire chunk to `push_to_tail`.

**Call relations**: It is called by the async watcher when output arrives and by tests constructing transcript scenarios. It delegates all suffix retention and eviction logic to `push_to_tail` once head capacity is exhausted.

*Call graph*: calls 1 internal fn (push_to_tail); 1 external calls (push_back).


##### `HeadTailBuffer::snapshot_chunks`  (lines 97–102)

```
fn snapshot_chunks(&self) -> Vec<Vec<u8>>
```

**Purpose**: Returns the retained transcript as a vector of chunk boundaries in head-then-tail order. It preserves chunk segmentation rather than flattening bytes.

**Data flow**: Reads `head` and `tail`, clones each stored `Vec<u8>` into a new `Vec<Vec<u8>>`, and returns that snapshot without mutating the buffer.

**Call relations**: This method is used by tests that want to inspect chunk placement directly. It complements `to_bytes`, which instead concatenates all retained chunks.

*Call graph*: 2 external calls (new, iter).


##### `HeadTailBuffer::to_bytes`  (lines 108–117)

```
fn to_bytes(&self) -> Vec<u8>
```

**Purpose**: Flattens the retained head and tail chunks into a single byte vector suitable for final transcript rendering. It omits any dropped middle bytes.

**Data flow**: Allocates a `Vec<u8>` with capacity `retained_bytes()`, iterates over `head` then `tail`, extends the output with each chunk’s bytes, and returns the concatenated vector.

**Call relations**: It is used by transcript consumers such as final output resolution and by tests asserting rendered content. It depends on `retained_bytes` for efficient allocation.

*Call graph*: calls 1 internal fn (retained_bytes); 2 external calls (with_capacity, iter).


##### `HeadTailBuffer::drain_chunks`  (lines 123–130)

```
fn drain_chunks(&mut self) -> Vec<Vec<u8>>
```

**Purpose**: Removes and returns all retained chunks, resetting the buffer to an empty state. It also clears omitted-byte accounting.

**Data flow**: Drains all `head` chunks into an output vector, extends it with drained `tail` chunks, then sets `head_bytes`, `tail_bytes`, and `omitted_bytes` back to zero before returning the drained chunks.

**Call relations**: This method is used in tests and any code that needs to consume and reset transcript state. It is the destructive counterpart to `snapshot_chunks`.

*Call graph*: 1 external calls (drain).


##### `HeadTailBuffer::push_to_tail`  (lines 132–157)

```
fn push_to_tail(&mut self, chunk: Vec<u8>)
```

**Purpose**: Appends bytes into the suffix-retention region and enforces the tail budget, replacing or trimming older tail content as needed. It centralizes all tail-side truncation logic.

**Data flow**: Consumes an owned `Vec<u8>` chunk and mutates `tail`, `tail_bytes`, and `omitted_bytes`. If `tail_budget == 0`, it counts the whole chunk as omitted. If the chunk length is at least the full tail budget, it keeps only the last `tail_budget` bytes, adds both previously retained tail bytes and newly dropped bytes to `omitted_bytes`, clears the old tail, and stores the kept suffix as the sole tail chunk. Otherwise it appends the chunk, increments `tail_bytes`, and calls `trim_tail_to_budget`.

**Call relations**: It is called only by `push_chunk` after head handling is complete. It delegates incremental over-budget eviction to `trim_tail_to_budget` for the normal append case.

*Call graph*: calls 1 internal fn (trim_tail_to_budget); called by 1 (push_chunk); 2 external calls (clear, push_back).


##### `HeadTailBuffer::trim_tail_to_budget`  (lines 159–178)

```
fn trim_tail_to_budget(&mut self)
```

**Purpose**: Shrinks the tail from the front until its retained byte count fits within `tail_budget`. It preserves the newest suffix bytes by discarding the oldest tail content first.

**Data flow**: Computes `excess = tail_bytes.saturating_sub(tail_budget)` and, while excess remains, mutates the front tail chunk: if the whole front chunk is excess, it subtracts its length from `tail_bytes`, adds that length to `omitted_bytes`, and pops it; otherwise it drains only the first `excess` bytes from that chunk, updates counters accordingly, and stops.

**Call relations**: This helper is called by `push_to_tail` after appending a normal-sized chunk. It is the low-level eviction loop that maintains the tail-budget invariant.

*Call graph*: called by 1 (push_to_tail); 2 external calls (front_mut, pop_front).


### `execpolicy/src/executable_name.rs`

`util` · `command matching helper`

This utility module reduces executable identifiers to the canonical string form used by host-executable lookup logic. The normalization is intentionally platform-sensitive. On Windows, `executable_lookup_key` lowercases the input and strips one of the standard executable suffixes (`.exe`, `.cmd`, `.bat`, `.com`) if present, so names like `GIT.EXE` and `git` collapse to the same key. On non-Windows platforms, it returns the input unchanged because executable suffix conventions do not apply in the same way.

The second helper, `executable_path_lookup_key`, adapts that normalization to filesystem paths. It extracts the final path component with `file_name`, converts it to UTF-8 with `to_str`, and then feeds the resulting string into `executable_lookup_key`. If the path has no filename or the filename is not valid UTF-8, it returns `None` rather than guessing. The module is deliberately narrow in scope: it does not inspect directories, resolve symlinks, or touch the filesystem. Its only job is to produce stable string keys for later matching logic, especially when absolute host executable paths need to be compared against basename-oriented policy rules.

#### Function details

##### `executable_lookup_key`  (lines 6–23)

```
fn executable_lookup_key(raw: &str) -> String
```

**Purpose**: Normalizes a raw executable name into the canonical lookup key used for matching. The normalization strips Windows-specific executable suffixes and lowercases on Windows, while leaving names unchanged on other platforms.

**Data flow**: It takes `raw: &str` and returns a new `String`. On Windows it first computes `raw.to_ascii_lowercase()`, then checks whether the lowered string ends with any suffix in `WINDOWS_EXECUTABLE_SUFFIXES`; if so it returns the string without that suffix, otherwise it returns the lowered string. On non-Windows builds it simply clones `raw` into an owned `String`.

**Call relations**: This is a low-level helper used indirectly by path-based normalization and executable matching code. It contains the platform-conditional normalization policy that higher-level matching relies on.


##### `executable_path_lookup_key`  (lines 25–29)

```
fn executable_path_lookup_key(path: &Path) -> Option<String>
```

**Purpose**: Extracts and normalizes the executable basename from a filesystem path. It safely returns no key when the path lacks a valid UTF-8 filename.

**Data flow**: It accepts `path: &Path`, calls `path.file_name()`, converts the resulting `OsStr` with `to_str()`, and if both steps succeed maps the filename through `executable_lookup_key`. The return value is `Option<String>`, with `None` for paths without a filename or with non-UTF-8 names.

**Call relations**: This helper is called by host-executable rule matching code when it needs a basename-oriented key from an absolute path. It delegates the actual normalization policy to `executable_lookup_key` after extracting the filename component.

*Call graph*: called by 1 (match_host_executable_rules); 1 external calls (file_name).


### `linux-sandbox/src/exec_util.rs`

`util` · `just before exec of bubblewrap or the final command`

This file contains the small but critical glue used immediately before replacing the current process image. `argv_to_cstrings` walks a `&[String]`, allocates a `Vec<CString>` with matching capacity, and converts each argument into a NUL-terminated C string, panicking if any argument contains an interior NUL byte because such values cannot be passed to `execv`/`execvp`. `make_files_inheritable` is the companion for preserved file descriptors: it iterates over borrowed `std::fs::File` handles and invokes the private `clear_cloexec` helper on each raw fd.

`clear_cloexec` uses `libc::fcntl` twice: first with `F_GETFD` to read descriptor flags, then, only if `FD_CLOEXEC` is currently set, with `F_SETFD` to write back the same flags minus `FD_CLOEXEC`. The function treats any syscall failure as fatal and includes the fd number in panic messages, which is important because these descriptors are bubblewrap-preserved resources and losing them across exec would silently break later sandbox setup. The implementation deliberately avoids unnecessary writes when the flag is already clear.

The test module validates the exact inheritance behavior by creating a temporary file, force-setting `FD_CLOEXEC`, calling `make_files_inheritable`, and asserting that the flag bit is cleared. Test-only helpers mirror the production `fcntl` logic for setting and reading descriptor flags.

#### Function details

##### `argv_to_cstrings`  (lines 5–14)

```
fn argv_to_cstrings(argv: &[String]) -> Vec<CString>
```

**Purpose**: Converts a Rust slice of command-line arguments into owned `CString` values suitable for building an argv array for libc exec calls. It fails fast if any argument contains an interior NUL byte.

**Data flow**: Reads `argv: &[String]`, preallocates a `Vec<CString>` sized to `argv.len()`, converts each `String` via `CString::new(arg.as_str())`, pushes successful conversions, and panics on conversion error. Returns the populated `Vec<CString>` without mutating external state.

**Call relations**: This helper is used by the exec paths that cross into a new process image. When `exec` or `exec_system_bwrap` need a C argv, they delegate here so the conversion and NUL validation happen in one place before passing pointers to libc.

*Call graph*: called by 2 (exec, exec_system_bwrap); 3 external calls (new, with_capacity, panic!).


##### `make_files_inheritable`  (lines 16–20)

```
fn make_files_inheritable(files: &[File])
```

**Purpose**: Ensures a set of open files remain available after an exec by clearing `FD_CLOEXEC` on each descriptor. It is specifically for preserved descriptors that bubblewrap or child processes must inherit.

**Data flow**: Reads `files: &[File]`, extracts each raw fd with `AsRawFd`, and passes it to `clear_cloexec`. It returns `()` and mutates kernel fd flag state for each descriptor.

**Call relations**: Called from the main exec paths before invoking bubblewrap, and exercised directly by the inheritance test. It is a thin loop whose only delegation is to `clear_cloexec`, centralizing the actual `fcntl` logic there.

*Call graph*: calls 1 internal fn (clear_cloexec); called by 3 (exec, preserved_files_are_made_inheritable, exec_system_bwrap).


##### `clear_cloexec`  (lines 22–40)

```
fn clear_cloexec(fd: libc::c_int)
```

**Purpose**: Reads descriptor flags for one fd and removes the `FD_CLOEXEC` bit if present. It preserves all other descriptor flags unchanged.

**Data flow**: Takes `fd: libc::c_int`, calls `fcntl(fd, F_GETFD)` to fetch current flags, computes `cleared_flags = flags & !FD_CLOEXEC`, returns early if no change is needed, otherwise calls `fcntl(fd, F_SETFD, cleared_flags)`. On syscall failure it reads `last_os_error()` and panics; on success it returns `()` after updating kernel fd state.

**Call relations**: This is the private worker behind `make_files_inheritable`. It is not called directly elsewhere; the public helper batches multiple files while this function encapsulates the exact read-modify-write sequence and error reporting.

*Call graph*: called by 1 (make_files_inheritable); 3 external calls (last_os_error, fcntl, panic!).


##### `tests::preserved_files_are_made_inheritable`  (lines 49–56)

```
fn preserved_files_are_made_inheritable()
```

**Purpose**: Verifies that the production helper actually clears `FD_CLOEXEC` on a preserved file descriptor. The test uses a temporary file to exercise the same raw-fd path as runtime code.

**Data flow**: Creates a `NamedTempFile`, reads its fd, sets `FD_CLOEXEC` via the test helper, calls `make_files_inheritable` on a one-element slice, then reads flags again and asserts the `FD_CLOEXEC` bit is zero. It writes only test-local fd flag state.

**Call relations**: This test drives the production `make_files_inheritable` path under the precondition that the descriptor starts with close-on-exec enabled. It relies on `set_cloexec` to establish that condition before asserting the postcondition.

*Call graph*: calls 1 internal fn (make_files_inheritable); 4 external calls (new, assert_eq!, set_cloexec, from_ref).


##### `tests::set_cloexec`  (lines 58–66)

```
fn set_cloexec(fd: libc::c_int)
```

**Purpose**: Test-only helper that force-enables `FD_CLOEXEC` on a descriptor so inheritance-clearing behavior can be validated. It mirrors the production `fcntl` pattern in the opposite direction.

**Data flow**: Takes `fd`, reads current flags through `fd_flags`, ORs in `FD_CLOEXEC`, and writes the result with `fcntl(fd, F_SETFD, ...)`. On failure it panics with the OS error; otherwise it returns `()` after mutating descriptor flags.

**Call relations**: Used by `tests::preserved_files_are_made_inheritable` to create the exact starting state the production helper is supposed to undo. It delegates flag retrieval to `fd_flags` so tests share one read path.

*Call graph*: 4 external calls (last_os_error, fcntl, fd_flags, panic!).


##### `tests::fd_flags`  (lines 68–76)

```
fn fd_flags(fd: libc::c_int) -> libc::c_int
```

**Purpose**: Reads and returns the current descriptor flags for a test fd. It provides a small assertion-friendly wrapper around `fcntl(F_GETFD)`.

**Data flow**: Accepts `fd`, calls `fcntl(fd, F_GETFD)`, panics on negative return after consulting `last_os_error()`, and otherwise returns the raw `libc::c_int` flags value. It does not modify state.

**Call relations**: This helper supports the test setup and verification helpers by centralizing descriptor-flag reads. `tests::set_cloexec` uses it before writing flags, and the main inheritance test uses it to assert the final bitmask.

*Call graph*: 3 external calls (last_os_error, fcntl, panic!).


### `utils/pty/src/process.rs`

`domain_logic` · `cross-cutting process/session lifetime`

This file is the central data model and control surface for spawned processes. It defines `ProcessSignal` (currently only `Interrupt`), the `ChildTerminator` trait used by backend-specific kill/signal implementations, `TerminalSize`, PTY handle wrappers, and the `ProcessHandle` struct that owns all runtime coordination state. `ProcessHandle` stores optional stdin sender, optional terminator, reader/writer/wait task handles, abort handles for detached readers, shared exit flags (`Arc<AtomicBool>`) and cached exit code (`Arc<StdMutex<Option<i32>>>`), optional retained `PtyHandles`, and an optional resize callback for driver-backed sessions.

The methods expose a uniform API regardless of backend: clone a writer sender, query exit state, fetch cached exit code, resize a PTY either through a concrete `MasterPty`, a raw Unix fd, or a callback, close stdin by dropping the sender, send a soft signal, request termination without aborting readers, or fully terminate by killing the child and aborting helper tasks. `Drop` always calls `terminate`, making cleanup best-effort and automatic.

The file also provides utility conversions and adapters: `unsupported_signal` standardizes backend error messages, `exit_code_from_status` maps platform-specific `ExitStatus` values into an `i32`, `combine_output_receivers` merges split stdout/stderr channels into a broadcast stream, and `spawn_from_driver` wraps externally supplied channels and callbacks into the same `SpawnedProcess` shape. A subtle design choice in `spawn_from_driver` is that after exit is observed it keeps draining broadcast output until the sender closes, preventing tail output loss from backends that publish exit before their final bytes.

#### Function details

##### `unsupported_signal`  (lines 26–33)

```
fn unsupported_signal(signal: ProcessSignal) -> io::Error
```

**Purpose**: Builds a consistent `io::Error` for signals that a backend cannot implement. It currently formats the unsupported `Interrupt` case with a backend-neutral message.

**Data flow**: Takes a `ProcessSignal`, matches it, and returns a freshly constructed `io::Error` with kind `Unsupported` and a fixed explanatory string. It reads no external state and writes nothing.

**Call relations**: This helper is used by multiple `ChildTerminator::signal` implementations when a backend cannot deliver `Interrupt`. It centralizes the exact error wording so callers see the same failure across backends.

*Call graph*: called by 3 (signal, signal, signal); 1 external calls (new).


##### `exit_code_from_status`  (lines 35–49)

```
fn exit_code_from_status(status: ExitStatus) -> i32
```

**Purpose**: Normalizes a platform `ExitStatus` into the crate's integer exit-code convention. It prefers an explicit exit code, falls back to `128 + signal` on Unix signal termination, and uses `-1` when neither is available.

**Data flow**: Consumes an `ExitStatus`, first reads `status.code()`, then on Unix may read `status.signal()`. It transforms those optional values into a single `i32` and returns it without side effects.

**Call relations**: This conversion is used by the pipe backend and the Unix raw-PTY backend when their wait tasks complete. It ensures all spawn paths report exit in the same integer form.

*Call graph*: called by 1 (spawn_process_with_stdin_mode); 2 external calls (code, signal).


##### `TerminalSize::default`  (lines 64–66)

```
fn default() -> Self
```

**Purpose**: Provides the default terminal geometry used when callers do not specify one. The chosen size is 24 rows by 80 columns.

**Data flow**: Takes no input and returns `TerminalSize { rows: 24, cols: 80 }`. It does not read or mutate any shared state.

**Call relations**: This default is consumed by session startup code and many tests that need a baseline PTY size. It keeps PTY-related APIs ergonomic without forcing every caller to specify dimensions.

*Call graph*: called by 8 (open_session_with_exec_env, start_process, pipe_and_pty_share_interface, pty_preserving_inherited_fds_keeps_python_repl_running, pty_python_repl_emits_output_and_exits, pty_spawn_can_preserve_inherited_fds, pty_spawn_with_inherited_fds_reports_exec_failures, pty_terminate_kills_background_children_in_same_process_group).


##### `PtySize::from`  (lines 70–77)

```
fn from(value: TerminalSize) -> Self
```

**Purpose**: Converts the crate's lightweight `TerminalSize` into `portable_pty::PtySize`. It preserves rows and columns and zeroes pixel dimensions.

**Data flow**: Accepts a `TerminalSize`, copies `rows` and `cols`, sets `pixel_width` and `pixel_height` to `0`, and returns the resulting `PtySize`.

**Call relations**: This conversion is used wherever PTY backends need the portable-pty size type, especially during spawn and resize operations.


##### `PtyHandles::fmt`  (lines 101–103)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Implements a deliberately minimal `Debug` view for `PtyHandles`. It avoids exposing internal PTY objects while still identifying the struct in logs or test failures.

**Data flow**: Reads `self` only to satisfy the trait and writes a `debug_struct("PtyHandles")` representation into the provided formatter. It returns the formatter result.

**Call relations**: This trait impl supports debugging of higher-level structs that may contain `PtyHandles` without requiring the underlying PTY trait objects to be printable.

*Call graph*: 1 external calls (debug_struct).


##### `ProcessHandle::fmt`  (lines 129–131)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Implements a minimal `Debug` representation for `ProcessHandle`. It intentionally omits internal channels, locks, and task handles.

**Data flow**: Consumes `&self` and a formatter, emits `debug_struct("ProcessHandle")`, and returns the formatting result.

**Call relations**: This is used implicitly by any debug printing of `ProcessHandle` or structs containing it, keeping diagnostics simple and avoiding trait-object formatting issues.

*Call graph*: 1 external calls (debug_struct).


##### `ProcessHandle::new`  (lines 136–160)

```
fn new(
        writer_tx: mpsc::Sender<Vec<u8>>,
        killer: Box<dyn ChildTerminator>,
        reader_handle: JoinHandle<()>,
        reader_abort_handles: Vec<AbortHandle>,
        writer_handle
```

**Purpose**: Constructs the shared session handle from backend-supplied channels, task handles, exit state, optional PTY handles, and optional resize callback. It wraps mutable pieces in `StdMutex<Option<...>>` so later methods can take ownership exactly once.

**Data flow**: Takes the stdin sender, boxed `ChildTerminator`, reader/writer/wait `JoinHandle`s, reader abort handles, shared exit flag/code Arcs, optional `PtyHandles`, and optional resize closure. It stores them into a new `ProcessHandle`, wrapping sender and handles in `Some(...)` inside mutexes, and returns that struct.

**Call relations**: All spawn backends call this constructor after they have created their helper tasks and termination hooks. It is the single point where backend-specific pieces become the uniform session object exposed to callers.

*Call graph*: 1 external calls (new).


##### `ProcessHandle::writer_sender`  (lines 163–173)

```
fn writer_sender(&self) -> mpsc::Sender<Vec<u8>>
```

**Purpose**: Returns a cloneable sender for raw stdin bytes when stdin is still open. If the sender has already been removed or the mutex is poisoned, it returns a disconnected fallback sender instead of panicking.

**Data flow**: Locks `writer_tx`, checks whether an `mpsc::Sender<Vec<u8>>` is still present, and clones it if so. Otherwise it creates a new one-slot channel, drops the receiver immediately to make sends fail, and returns that sender.

**Call relations**: Callers use this to obtain a write handle without direct access to internal state. The disconnected fallback preserves API stability after stdin closure or teardown.

*Call graph*: 2 external calls (lock, channel).


##### `ProcessHandle::has_exited`  (lines 176–178)

```
fn has_exited(&self) -> bool
```

**Purpose**: Reports whether the wait task has observed child exit. It is a cheap atomic read suitable for polling.

**Data flow**: Reads the `exit_status` `AtomicBool` with `SeqCst` ordering and returns the resulting `bool`.

**Call relations**: This method is used by higher-level code that wants a non-blocking exit check instead of awaiting the oneshot receiver.


##### `ProcessHandle::exit_code`  (lines 181–183)

```
fn exit_code(&self) -> Option<i32>
```

**Purpose**: Returns the cached integer exit code if the wait task has stored one. It tolerates lock poisoning by returning `None`.

**Data flow**: Locks `exit_code`, extracts the inner `Option<i32>` if locking succeeds, and returns that optional value.

**Call relations**: This complements `has_exited` by exposing the normalized exit code after process completion.


##### `ProcessHandle::resize`  (lines 186–210)

```
fn resize(&self, size: TerminalSize) -> anyhow::Result<()>
```

**Purpose**: Resizes the attached PTY or PTY-like backend in character cells. It first prefers locally owned PTY handles, then falls back to an injected resize callback for driver-backed sessions.

**Data flow**: Takes a `TerminalSize`, locks `_pty_handles`, and if present dispatches either to `MasterPty::resize(size.into())` for `PtyMasterHandle::Resizable` or to `resize_raw_pty(raw_fd, size)` for `Opaque` Unix handles. If no local PTY exists, it locks `resizer` and invokes the stored closure if present; otherwise it returns an `anyhow!` error indicating the process is not attached to a PTY.

**Call relations**: This method is called by code that needs terminal resizing independent of backend. It delegates to `resize_raw_pty` only for Unix opaque PTYs and otherwise routes through the backend-specific object or callback.

*Call graph*: calls 1 internal fn (resize_raw_pty); 3 external calls (lock, anyhow!, into).


##### `ProcessHandle::close_stdin`  (lines 213–217)

```
fn close_stdin(&self)
```

**Purpose**: Closes the logical stdin channel to the child by dropping the stored sender. This causes backend writer tasks to observe channel closure and stop forwarding input.

**Data flow**: Locks `writer_tx` and replaces the inner `Option<mpsc::Sender<Vec<u8>>>` with `None` via `take()`. It returns `()` and ignores lock failures.

**Call relations**: Callers use this after sending their final input so the child can observe EOF. It affects later `writer_sender()` calls, which will then return a disconnected fallback sender.

*Call graph*: 1 external calls (lock).


##### `ProcessHandle::request_terminate`  (lines 221–227)

```
fn request_terminate(&self)
```

**Purpose**: Performs the kill step without aborting helper tasks, allowing output-draining tasks to continue until EOF. It consumes the stored terminator so the kill path runs at most once.

**Data flow**: Locks `killer`, takes the boxed `ChildTerminator` out of its `Option`, invokes `kill()` if present, discards the result, and returns `()`. No other state is modified.

**Call relations**: This is the first phase of `ProcessHandle::terminate`. It exists separately so callers can request process death while still letting stdout/stderr readers finish naturally.

*Call graph*: called by 1 (terminate); 1 external calls (lock).


##### `ProcessHandle::signal`  (lines 229–238)

```
fn signal(&self, signal: ProcessSignal) -> io::Result<()>
```

**Purpose**: Attempts to send a soft signal such as `Interrupt` to the child through the backend-specific terminator. If the terminator is unavailable or the lock is poisoned, it quietly returns success.

**Data flow**: Locks `killer`, borrows the boxed `ChildTerminator` mutably if still present, forwards the provided `ProcessSignal`, and returns that `io::Result<()>`. If locking fails or the terminator has already been taken, it returns `Ok(())`.

**Call relations**: Higher-level code calls this when it wants an interrupt rather than a hard kill. It delegates to the backend-specific `signal` implementation, which may in turn use process-group helpers or report `unsupported_signal`.

*Call graph*: 1 external calls (lock).


##### `ProcessHandle::terminate`  (lines 241–264)

```
fn terminate(&self)
```

**Purpose**: Fully tears down a session by killing the child and aborting all helper tasks that might otherwise continue running. It is the aggressive shutdown path used during explicit termination and drop cleanup.

**Data flow**: First calls `request_terminate()` to consume and invoke the terminator. It then locks and `take()`s `reader_handle`, aborts it if present, drains and aborts all `reader_abort_handles`, locks and aborts `writer_handle` if present, and finally locks and aborts `wait_handle` if present.

**Call relations**: This method is called directly by users who want immediate teardown and indirectly by `Drop`. It builds on `request_terminate` and then cleans up all spawned tasks so detached readers cannot keep channels alive.

*Call graph*: calls 1 internal fn (request_terminate); called by 1 (drop); 1 external calls (lock).


##### `ProcessHandle::drop`  (lines 268–270)

```
fn drop(&mut self)
```

**Purpose**: Ensures session teardown happens automatically when the handle is dropped. It simply routes destruction through the same explicit termination logic.

**Data flow**: Consumes `&mut self` during drop and calls `self.terminate()`. It returns no value.

**Call relations**: Rust invokes this when the last `ProcessHandle` owner goes away. It guarantees best-effort child cleanup even if callers forget to terminate explicitly.

*Call graph*: calls 1 internal fn (terminate).


##### `ClosureTerminator::signal`  (lines 279–281)

```
fn signal(&mut self, signal: ProcessSignal) -> io::Result<()>
```

**Purpose**: Implements the signal half of `ChildTerminator` for closure-backed drivers by always rejecting signals. Closure-backed drivers only support kill semantics, not typed signals.

**Data flow**: Accepts a `ProcessSignal`, ignores internal state, and returns the standardized `unsupported_signal` error.

**Call relations**: This adapter is used by `spawn_from_driver` when a driver supplies only a termination closure. It keeps the `ChildTerminator` trait satisfied while making unsupported signaling explicit.

*Call graph*: calls 1 internal fn (unsupported_signal).


##### `ClosureTerminator::kill`  (lines 283–288)

```
fn kill(&mut self) -> io::Result<()>
```

**Purpose**: Runs the stored termination closure if one exists. It treats the closure as best-effort and always reports success.

**Data flow**: Mutably accesses `self.inner`, invokes the boxed `FnMut()` if present, leaves it stored for potential future calls, and returns `Ok(())`.

**Call relations**: This kill implementation is wrapped into `ProcessHandle` by `spawn_from_driver`. It lets nonstandard backends plug in custom shutdown behavior without implementing a full terminator type.


##### `resize_raw_pty`  (lines 292–304)

```
fn resize_raw_pty(raw_fd: RawFd, size: TerminalSize) -> anyhow::Result<()>
```

**Purpose**: Performs a Unix `ioctl(TIOCSWINSZ)` against a raw PTY file descriptor. It is the fallback resize path when the code only has an opaque fd rather than a `MasterPty` object.

**Data flow**: Takes a `RawFd` and `TerminalSize`, builds a `libc::winsize` with zero pixel dimensions, passes it to `libc::ioctl`, and returns `Ok(())` on success or converts `last_os_error()` into `anyhow::Error` on failure.

**Call relations**: This helper is called only from `ProcessHandle::resize` when the stored PTY master is `PtyMasterHandle::Opaque`.

*Call graph*: called by 1 (resize); 2 external calls (last_os_error, ioctl).


##### `combine_output_receivers`  (lines 307–339)

```
fn combine_output_receivers(
    mut stdout_rx: mpsc::Receiver<Vec<u8>>,
    mut stderr_rx: mpsc::Receiver<Vec<u8>>,
) -> broadcast::Receiver<Vec<u8>>
```

**Purpose**: Merges separate stdout and stderr `mpsc` receivers into a single broadcast stream of raw byte chunks. It preserves chunk boundaries but not source labeling.

**Data flow**: Consumes `stdout_rx` and `stderr_rx`, creates a `broadcast::channel(256)`, and spawns a task that `tokio::select!`s over both receivers while each remains open. Each received `Vec<u8>` is forwarded with `combined_tx.send(...)`; when both inputs close, the task exits and the returned `broadcast::Receiver<Vec<u8>>` eventually observes closure.

**Call relations**: Tests and higher-level code use this when they want a unified output stream from backends that naturally expose split stdout/stderr. The spawned task is the bridge between per-stream channels and fan-out broadcast consumers.

*Call graph*: 3 external calls (channel, select!, spawn).


##### `spawn_from_driver`  (lines 362–456)

```
fn spawn_from_driver(driver: ProcessDriver) -> SpawnedProcess
```

**Purpose**: Wraps an externally driven process backend into the crate's standard `SpawnedProcess` shape. It converts broadcast output streams into `mpsc` receivers, tracks exit state, and installs optional termination and resize hooks into a `ProcessHandle`.

**Data flow**: Consumes a `ProcessDriver` containing stdin sender, broadcast stdout and optional stderr receivers, exit oneshot, optional terminator closure, optional writer task handle, and optional resizer. It creates `mpsc` channels for stdout/stderr, a `watch<bool>` to indicate exit observation, spawns one or two stream-forwarding tasks that keep draining broadcast output even after exit until the sender closes, creates shared exit-state Arcs and a wait task that awaits the driver's exit code and updates those Arcs plus the watch channel, then constructs a `ProcessHandle` with a `ClosureTerminator` and returns `SpawnedProcess { session, stdout_rx, stderr_rx, exit_rx }`.

**Call relations**: This function is the adapter used by tests and any nonstandard backend that already has its own channels. It delegates termination to `ClosureTerminator`, output fan-in to locally spawned stream readers, and session construction to `ProcessHandle::new`.

*Call graph*: 8 external calls (clone, new, new, new, new, new, spawn, channel).


### `windows-sandbox-rs/src/unified_exec/backends/windows_common.rs`

`util` · `cross-cutting session I/O adaptation`

This file contains the backend-neutral glue that lets both the elevated runner backend and the legacy direct-process backend expose the same `codex_utils_pty::SpawnedProcess` interface. `finish_driver_spawn` is the final adapter: it calls `spawn_from_driver` and immediately closes the session stdin if the caller declared `stdin_open = false`, ensuring the session cannot accept writes later.

For TTY input, `normalize_windows_tty_input` performs CRLF normalization while preserving existing `\r\n` pairs across chunk boundaries using a mutable `previous_was_cr` flag. The elevated backend uses the remaining helpers to speak the framed IPC protocol. `start_runner_pipe_writer` creates a standard-library MPSC channel and a blocking task that serializes each `FramedMessage` to the runner pipe with `write_frame`. `start_runner_stdin_writer` drains Tokio stdin chunks, optionally normalizes them, base64-encodes the bytes into `Message::Stdin`, and sends a final `Message::CloseStdin` when the input stream ends and stdin had been declared open.

`start_runner_stdout_reader` runs in a dedicated thread, repeatedly reading framed messages from the runner pipe. It decodes `Message::Output` payloads and routes them to stdout or stderr broadcast channels, sends the exit code on `Message::Exit`, and converts premature EOF, read failures, or explicit `Message::Error` into a formatted `runner error: ...` line plus exit code `-1`. `make_runner_resizer` packages terminal resize requests into `Message::Resize` frames.

#### Function details

##### `finish_driver_spawn`  (lines 20–26)

```
fn finish_driver_spawn(driver: ProcessDriver, stdin_open: bool) -> SpawnedProcess
```

**Purpose**: Converts a prepared `ProcessDriver` into a `SpawnedProcess` and enforces the requested initial stdin-open policy.

**Data flow**: Takes ownership of a `ProcessDriver` and a `bool` flag. It calls `spawn_from_driver(driver)` to obtain a `SpawnedProcess`; if `stdin_open` is false it immediately calls `spawned.session.close_stdin()`, then returns the `SpawnedProcess`.

**Call relations**: Both backend entrypoints call this as their final step. It centralizes the subtle invariant that a session with disabled streaming input must expose a closed writer channel from the start.

*Call graph*: called by 2 (spawn_windows_sandbox_session_elevated_for_permission_profile, spawn_windows_sandbox_session_legacy); 1 external calls (spawn_from_driver).


##### `normalize_windows_tty_input`  (lines 28–43)

```
fn normalize_windows_tty_input(bytes: &[u8], previous_was_cr: &mut bool) -> Vec<u8>
```

**Purpose**: Transforms LF line endings into CRLF for Windows TTY input while avoiding duplicate CR insertion when a CR already precedes the LF.

**Data flow**: Accepts a byte slice and a mutable `previous_was_cr` flag. It allocates an output `Vec<u8>` with input-length capacity, iterates byte-by-byte, inserts `\r` before `\n` only when the previous byte was not `\r`, copies all other bytes unchanged, updates `previous_was_cr` after each byte, and returns the normalized vector.

**Call relations**: This helper is used by the legacy backend's `spawn_input_writer` and the elevated backend's `start_runner_stdin_writer` when TTY mode is active, ensuring consistent newline behavior across both implementations.

*Call graph*: 1 external calls (with_capacity).


##### `start_runner_pipe_writer`  (lines 45–57)

```
fn start_runner_pipe_writer(
    mut pipe_write: File,
) -> std::sync::mpsc::Sender<FramedMessage>
```

**Purpose**: Starts the outbound side of the elevated runner IPC channel by serializing framed messages to a writable file on a blocking thread.

**Data flow**: Takes ownership of a `std::fs::File`, creates a `std::sync::mpsc::channel<FramedMessage>`, and spawns a blocking task that repeatedly receives messages from the channel and writes each one with `crate::ipc_framed::write_frame(&mut pipe_write, &msg)`. The loop stops on channel closure or write failure, and the function returns the sender half.

**Call relations**: It is called by the elevated backend before stdin and resize handling are set up. The returned sender is shared by `start_runner_stdin_writer`, the terminate closure, and the resize closure.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 1 external calls (spawn_blocking).


##### `start_runner_stdin_writer`  (lines 59–94)

```
fn start_runner_stdin_writer(
    mut writer_rx: mpsc::Receiver<Vec<u8>>,
    outbound_tx: std::sync::mpsc::Sender<FramedMessage>,
    normalize_newlines: bool,
    stdin_open: bool,
) -> tokio::task:
```

**Purpose**: Consumes session stdin chunks and converts them into framed runner `Stdin` messages, optionally followed by a `CloseStdin` control message.

**Data flow**: Accepts a Tokio `mpsc::Receiver<Vec<u8>>`, a standard MPSC sender for `FramedMessage`, a newline-normalization flag, and the original `stdin_open` flag. In a blocking task it drains chunks with `blocking_recv`, optionally normalizes them via `normalize_windows_tty_input`, base64-encodes the bytes with `encode_bytes`, wraps them in `Message::Stdin`, and sends them over the outbound channel. When the input channel closes, it conditionally sends a final `Message::CloseStdin` if `stdin_open` was true.

**Call relations**: The elevated backend calls this immediately after creating the outbound pipe writer. It sits between the generic session writer channel and the runner protocol, mirroring the role `spawn_input_writer` plays in the legacy backend.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 1 external calls (spawn_blocking).


##### `start_runner_stdout_reader`  (lines 96–161)

```
fn start_runner_stdout_reader(
    mut pipe_read: File,
    stdout_tx: broadcast::Sender<Vec<u8>>,
    stderr_tx: Option<broadcast::Sender<Vec<u8>>>,
    exit_tx: oneshot::Sender<i32>,
)
```

**Purpose**: Reads framed messages from the elevated runner and translates them into stdout/stderr broadcasts and a final exit code.

**Data flow**: Takes a readable `File`, stdout and optional stderr broadcast senders, and an exit-code oneshot sender. In a dedicated thread it loops on `read_frame(&mut pipe_read)`. On `Ok(Some(msg))`, it matches `msg.message`: `Message::Output` is base64-decoded with `decode_bytes` and routed by `OutputStream`; `Message::Exit` sends the exit code and breaks; `Message::Error` emits a formatted runner error and sends `-1`; protocol messages that should not arrive on this side are ignored. On `Ok(None)` or read error, it emits a runner error message, sends `-1`, and exits.

**Call relations**: This helper is started by the elevated backend after transport setup. It is the inbound half of the runner protocol and the only place where framed runner messages become the backend-neutral stdout/stderr/exit channels.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 1 external calls (spawn).


##### `make_runner_resizer`  (lines 163–179)

```
fn make_runner_resizer(
    outbound_tx: std::sync::mpsc::Sender<FramedMessage>,
) -> Box<dyn FnMut(TerminalSize) -> Result<()> + Send>
```

**Purpose**: Builds a closure that sends terminal resize requests to the elevated runner over the outbound framed-message channel.

**Data flow**: Takes a standard MPSC sender for `FramedMessage` and returns a boxed `FnMut(TerminalSize) -> Result<()> + Send`. Each invocation packages the supplied rows and cols into `Message::Resize { payload: ResizePayload { ... } }` with the current protocol version and sends it; if the channel is closed it returns an `anyhow` error.

**Call relations**: The elevated backend installs this closure into `ProcessDriver.resizer` only for TTY sessions. It complements `start_runner_stdin_writer` and `start_runner_stdout_reader` by covering the terminal-control side channel.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 1 external calls (new).


##### `send_runner_error`  (lines 181–192)

```
fn send_runner_error(
    message: &str,
    stdout_tx: &broadcast::Sender<Vec<u8>>,
    stderr_tx: Option<&broadcast::Sender<Vec<u8>>>,
)
```

**Purpose**: Formats a runner-side failure as a human-readable line and emits it on stderr when available, otherwise stdout.

**Data flow**: Accepts an error message string plus stdout and optional stderr broadcast senders. It prefixes the message with `runner error: `, appends a newline, converts it to bytes, and sends the bytes to stderr if provided or stdout otherwise.

**Call relations**: This private helper is used only inside `start_runner_stdout_reader` for premature pipe closure, frame read failures, and explicit `Message::Error` frames, keeping error reporting consistent across those branches.

*Call graph*: 2 external calls (send, format!).


### `cli/src/exit_status.rs`

`util` · `subprocess completion`

This file contains the small but important bridge between subprocess termination and Codex's own process exit. It is split by platform with `#[cfg(unix)]` and `#[cfg(windows)]`, but both variants expose the same `handle_exit_status` signature returning `!`, meaning they never return.

The Unix implementation imports `std::os::unix::process::ExitStatusExt` so it can inspect both ordinary exit codes and terminating signals. It first prefers `status.code()`, exiting with that exact code when present. If there is no code but `status.signal()` is available, it exits with `128 + signal`, matching common shell conventions for signal deaths. If neither is available, it falls back to exit code `1`.

The Windows implementation is simpler because signal-style termination is not normally represented the same way. It exits with `status.code()` when present and otherwise uses a conservative fallback of `1`. This helper is used when sandbox-launch code wants the parent Codex process to mirror the child command's termination outcome as closely as the host platform allows.

#### Function details

##### `handle_exit_status`  (lines 16–23)

```
fn handle_exit_status(status: std::process::ExitStatus) -> !
```

**Purpose**: Terminates the current process with an exit code derived from a child `ExitStatus`. It preserves normal exit codes and, on Unix, maps signals to shell-style codes.

**Data flow**: Consumes a `std::process::ExitStatus`, reads `status.code()`, and on Unix also reads `status.signal()` via `ExitStatusExt`. It then calls `std::process::exit` with the child code, `128 + signal`, or fallback `1`, never returning.

**Call relations**: This helper is called by `run_command_under_sandbox` after a sandboxed child process exits so the wrapper process propagates the child's termination result to the caller.

*Call graph*: called by 1 (run_command_under_sandbox); 3 external calls (code, signal, exit).


### `cli/src/debug_sandbox/pid_tracker.rs`

`util` · `during macOS sandbox child execution and denial-log collection`

This file implements `PidTracker`, a small asynchronous wrapper around a blocking descendant-tracking loop. `PidTracker::new` rejects nonpositive PIDs, creates a `kqueue`, and spawns `track_descendants` on a blocking Tokio task; `stop` triggers a synthetic user event and awaits the collected `HashSet<i32>`. The lower-level helpers wrap macOS primitives: `list_child_pids` repeatedly calls the unsafe `proc_listchildpids` FFI, growing a buffer until all child PIDs fit; `pid_is_alive` probes liveness with `kill(pid, 0)` and treats `EPERM` as alive; `watch_pid` registers `EVFILT_PROC` notifications for fork, exec, and exit and distinguishes `ESRCH` from other errors.

The tracking algorithm maintains `seen` and `active` PID sets. `add_pid_watch` inserts a PID, attempts to watch it, and recursively discovers current children; `watch_children` enumerates and adds each child. `track_descendants` first handles degraded cases where `kqueue` or stop-event registration fails by returning at least the root PID. In the normal loop it re-adds the root if all active watches disappear but the root still lives, blocks in `kevent`, handles interrupts, reacts to `NOTE_FORK` by discovering new children, removes exited PIDs on `NOTE_EXIT`, and stops when the synthetic stop event arrives. Tests cover current-process liveness, child enumeration, direct child tracking, and descendant tracking through a Bash subshell.

#### Function details

##### `PidTracker::new`  (lines 13–22)

```
fn new(root_pid: i32) -> Option<Self>
```

**Purpose**: Creates a tracker for a root PID by opening a `kqueue` and launching the blocking descendant-tracking loop. It returns `None` for invalid root PIDs.

**Data flow**: The method takes `root_pid: i32`, returns `None` immediately if it is `<= 0`, otherwise calls `libc::kqueue()` to obtain a queue descriptor and spawns `track_descendants(kq, root_pid)` on a Tokio blocking task. It packages the descriptor and `JoinHandle<HashSet<i32>>` into `PidTracker` and returns `Some(Self)`.

**Call relations**: Tests call this constructor directly, and `DenialLogger::on_child_spawn` uses it to begin tracking the sandboxed child process tree. It delegates the actual recursive tracking work to `track_descendants` running off-thread.

*Call graph*: called by 3 (pid_tracker_collects_bash_subshell_descendants, pid_tracker_collects_spawned_children, on_child_spawn); 2 external calls (kqueue, spawn_blocking).


##### `PidTracker::stop`  (lines 24–27)

```
async fn stop(self) -> HashSet<i32>
```

**Purpose**: Stops tracking and returns the set of PIDs observed so far. It is the asynchronous shutdown point for the tracker.

**Data flow**: The method consumes `self`, sends a synthetic stop event to the stored `kqueue` via `trigger_stop_event`, awaits the background task handle, and returns the resulting `HashSet<i32>`, defaulting to an empty set if the task join fails. It writes only the stop signal into the kernel event queue.

**Call relations**: Callers use this after the tracked process has finished or when log collection is ending. It coordinates with `track_descendants` indirectly through `trigger_stop_event`.

*Call graph*: calls 1 internal fn (trigger_stop_event).


##### `list_child_pids`  (lines 39–60)

```
fn list_child_pids(parent: i32) -> Vec<i32>
```

**Purpose**: Wraps the unsafe `proc_listchildpids` API and returns the current direct children of a parent PID. It dynamically resizes its buffer until the kernel reports a stable count.

**Data flow**: Given `parent: i32`, the function enters an unsafe loop starting with capacity 16, allocates a `Vec<i32>` of zeros, calls `proc_listchildpids` into that buffer, and interprets the returned count. If the count is nonpositive it returns an empty vector; if the returned count fits within the current capacity it truncates the buffer to that count and returns it; otherwise it increases capacity and retries.

**Call relations**: This helper is used by `watch_children` during recursive process discovery and by a dedicated test that verifies a spawned child appears in the parent's child list.

*Call graph*: called by 2 (list_child_pids_includes_spawned_child, watch_children); 2 external calls (new, vec!).


##### `pid_is_alive`  (lines 62–75)

```
fn pid_is_alive(pid: i32) -> bool
```

**Purpose**: Checks whether a PID still refers to a live process using the conventional `kill(pid, 0)` probe. It treats permission-denied as evidence that the process exists.

**Data flow**: The function returns `false` immediately for nonpositive PIDs. For positive PIDs it calls `libc::kill(pid, 0)`; a zero result yields `true`, and a nonzero result yields `true` only when `last_os_error().raw_os_error()` is `EPERM`, otherwise `false`.

**Call relations**: Only `track_descendants` calls this helper, using it when no active watches remain to decide whether the root process has truly exited or should be re-watched.

*Call graph*: called by 1 (track_descendants); 2 external calls (kill, matches!).


##### `watch_pid`  (lines 83–108)

```
fn watch_pid(kq: libc::c_int, pid: i32) -> Result<(), WatchPidError>
```

**Purpose**: Registers a process with `kqueue` for fork, exec, and exit notifications. It converts kernel errors into a small domain-specific error enum.

**Data flow**: The function takes a queue descriptor and PID, rejects nonpositive PIDs as `WatchPidError::ProcessGone`, constructs a `libc::kevent` with `EVFILT_PROC`, `EV_ADD | EV_CLEAR`, and `NOTE_FORK | NOTE_EXEC | NOTE_EXIT`, and submits it with `libc::kevent`. On success it returns `Ok(())`; on failure it reads `last_os_error()` and maps `ESRCH` to `ProcessGone` and all other errors to `Other(std::io::Error)`.

**Call relations**: `add_pid_watch` calls this helper whenever it tries to activate tracking for a PID. The distinction between `ProcessGone` and `Other` drives whether the caller silently drops the PID or logs a warning.

*Call graph*: called by 1 (add_pid_watch); 5 external calls (Other, last_os_error, kevent, null, null_mut).


##### `watch_children`  (lines 110–119)

```
fn watch_children(
    kq: libc::c_int,
    parent: i32,
    seen: &mut HashSet<i32>,
    active: &mut HashSet<i32>,
)
```

**Purpose**: Discovers a parent's current direct children and adds watches for each one. It is the bridge between child enumeration and recursive watch registration.

**Data flow**: The function reads the current child PID list from `list_child_pids(parent)` and iterates over it, passing each child into `add_pid_watch` along with the mutable `seen` and `active` sets. It returns unit after mutating those sets in place.

**Call relations**: Both `add_pid_watch` and `track_descendants` call this helper when they need to expand the tracked process tree after discovering or revisiting a PID.

*Call graph*: calls 2 internal fn (add_pid_watch, list_child_pids); called by 2 (add_pid_watch, track_descendants).


##### `add_pid_watch`  (lines 122–150)

```
fn add_pid_watch(kq: libc::c_int, pid: i32, seen: &mut HashSet<i32>, active: &mut HashSet<i32>)
```

**Purpose**: Adds a PID to the seen/active sets, attempts to register kernel notifications for it, and recursively discovers its descendants when appropriate. It is the core state-transition helper for the tracker.

**Data flow**: Inputs are the queue descriptor, a PID, and mutable `seen` and `active` `HashSet<i32>`s. The function ignores nonpositive PIDs, inserts the PID into `seen`, tracks whether it was newly seen, inserts it into `active`, and if newly active calls `watch_pid`. On successful watch registration it forces recursion; on `ProcessGone` or other errors it removes the PID from `active`, logging a warning for non-ESRCH errors. If recursion is warranted, it calls `watch_children` to discover descendants. It returns unit while mutating both sets.

**Call relations**: This helper is called from `track_descendants` for the root and from `watch_children` for each discovered child. It delegates kernel registration to `watch_pid` and recursive expansion to `watch_children`.

*Call graph*: calls 2 internal fn (watch_children, watch_pid); called by 2 (track_descendants, watch_children); 1 external calls (warn!).


##### `register_stop_event`  (lines 153–165)

```
fn register_stop_event(kq: libc::c_int) -> bool
```

**Purpose**: Registers a user-triggerable `EVFILT_USER` event in the `kqueue` so the background tracking loop can be interrupted cleanly. It is part of the tracker's shutdown mechanism.

**Data flow**: The function constructs a `libc::kevent` for `STOP_IDENT` with `EVFILT_USER` and `EV_ADD | EV_CLEAR`, submits it with `libc::kevent`, and returns `true` if the syscall result is nonnegative. It mutates only kernel queue state.

**Call relations**: Only `track_descendants` calls this helper during initialization. If registration fails, the tracker falls back to returning a minimal set containing just the root PID.

*Call graph*: called by 1 (track_descendants); 3 external calls (kevent, null, null_mut).


##### `trigger_stop_event`  (lines 167–182)

```
fn trigger_stop_event(kq: libc::c_int)
```

**Purpose**: Signals the registered user event to wake the blocking `kevent` loop and request termination. It is the active half of the stop mechanism.

**Data flow**: The function takes a queue descriptor, returns immediately if it is negative, otherwise constructs a `libc::kevent` for `STOP_IDENT` with `EVFILT_USER` and `NOTE_TRIGGER`, and submits it with `libc::kevent`, ignoring the result. It writes a trigger into the kernel event queue.

**Call relations**: `PidTracker::stop` calls this helper before awaiting the background task. `track_descendants` recognizes the resulting event and breaks out of its loop.

*Call graph*: called by 1 (stop); 3 external calls (kevent, null, null_mut).


##### `track_descendants`  (lines 185–275)

```
fn track_descendants(kq: libc::c_int, root_pid: i32) -> HashSet<i32>
```

**Purpose**: Runs the blocking event loop that accumulates every PID in the root process's descendant tree until stopped. It combines initial discovery, event-driven updates, and graceful degradation when kernel facilities fail.

**Data flow**: The function receives a `kqueue` descriptor and `root_pid`. If the descriptor is invalid or stop-event registration fails, it returns a `HashSet` containing at least `root_pid`, closing the queue in the latter case. Otherwise it initializes empty `seen` and `active` sets, seeds them with `add_pid_watch(root_pid, ...)`, allocates a fixed event buffer, and loops: if `active` is empty it checks `pid_is_alive(root_pid)` and may re-add the root; it then blocks in `libc::kevent`, retrying on `Interrupted`, skipping zero events, and processing each event by stopping on the user stop event, removing PIDs on `EV_ERROR`/`ESRCH` or `NOTE_EXIT`, and calling `watch_children` on `NOTE_FORK`. At loop end it closes the queue and returns `seen`.

**Call relations**: This function is launched by `PidTracker::new` on a blocking task and coordinated by `PidTracker::stop`. It relies on `register_stop_event`, `add_pid_watch`, `watch_children`, and `pid_is_alive` to maintain the descendant set.

*Call graph*: calls 4 internal fn (add_pid_watch, pid_is_alive, register_stop_event, watch_children); 6 external calls (new, last_os_error, close, kevent, zeroed, null).


##### `tests::pid_is_alive_detects_current_process`  (lines 285–288)

```
fn pid_is_alive_detects_current_process()
```

**Purpose**: Sanity-checks that `pid_is_alive` reports the current process as alive. It validates the basic liveness probe used by the tracker loop.

**Data flow**: The test obtains the current process ID with `std::process::id() as i32`, passes it to `pid_is_alive`, and asserts the result is true. It reads only process metadata and performs no mutation.

**Call relations**: This standalone unit test is invoked by the test harness and directly exercises the helper used internally by `track_descendants`.

*Call graph*: 2 external calls (assert!, id).


##### `tests::list_child_pids_includes_spawned_child`  (lines 292–315)

```
fn list_child_pids_includes_spawned_child()
```

**Purpose**: Verifies that `list_child_pids` can observe a newly spawned direct child process. It checks the FFI wrapper against a real `/bin/sleep` subprocess.

**Data flow**: The test spawns `/bin/sleep 5` with null stdin, captures the child PID and current process PID, then polls up to 100 times with 10 ms sleeps until `list_child_pids(parent_pid)` contains the child PID. It kills and waits for the child afterward and asserts that the PID was found.

**Call relations**: This test is run by the harness on macOS and directly validates the child-enumeration primitive that `watch_children` depends on.

*Call graph*: calls 1 internal fn (list_child_pids); 6 external calls (from_millis, null, assert!, new, id, sleep).


##### `tests::pid_tracker_collects_spawned_children`  (lines 319–343)

```
async fn pid_tracker_collects_spawned_children()
```

**Purpose**: Checks that `PidTracker` records a direct child spawned while tracking is active. It validates the end-to-end path from tracker creation through stop.

**Data flow**: The test creates a tracker rooted at the current process, spawns `/bin/sleep 0.1`, records the child and parent PIDs, waits for the child to exit, then awaits `tracker.stop()` to obtain the seen PID set. It asserts that both parent and child PIDs are present.

**Call relations**: This macOS Tokio test exercises `PidTracker::new` and `PidTracker::stop`, thereby indirectly driving `track_descendants` and its watch-registration logic.

*Call graph*: calls 1 internal fn (new); 4 external calls (null, assert!, new, id).


##### `tests::pid_tracker_collects_bash_subshell_descendants`  (lines 347–371)

```
async fn pid_tracker_collects_bash_subshell_descendants()
```

**Purpose**: Verifies that the tracker captures not just direct children but descendants created by an intermediate shell process. It specifically tests recursive discovery through a Bash subshell.

**Data flow**: The test starts a tracker on the current process, spawns `/bin/bash -c '(sleep 0.1 & echo $!; wait)'` with piped stdout, waits for output, parses the printed background subshell PID from UTF-8 text, then stops the tracker and asserts that the descendant PID is included in the seen set.

**Call relations**: This test is the strongest recursive-coverage case for the tracker. It uses `PidTracker::new` and `stop` to validate that `NOTE_FORK` handling plus child enumeration reaches beyond direct children.

*Call graph*: calls 1 internal fn (new); 6 external calls (null, piped, from_utf8_lossy, assert!, new, id).


### Editing and patch application helpers
These utilities support interactive editing workflows and fuzzy patch-context matching used by higher-level file update flows.

### `tui/src/external_editor.rs`

`io_transport` · `interactive editing`

This file provides the TUI’s external-editor integration. `EditorError` captures command-resolution failures: neither `VISUAL` nor `EDITOR` is set, parsing failed on non-Windows platforms, or the parsed command is empty. On Windows, `resolve_windows_program` compensates for `tokio::process::Command` not resolving `.cmd`/`.bat` shims from `PATH` by using `which` and `PATHEXT` semantics.

`resolve_editor_command` reads `VISUAL` first and falls back to `EDITOR`, then splits the raw command string into argv components using `winsplit` on Windows or `shlex` elsewhere. It rejects an empty argv even if the environment variable exists. `run_editor` then writes the seed text to a temporary `.md` file, converts it immediately to a `TempPath` so no file handle remains open on Windows, constructs a `tokio::process::Command` from the first argv element plus any remaining args, inherits stdin/stdout/stderr so the editor is interactive, appends the temp file path as the final argument, and awaits process completion. Non-zero exit status becomes an eyre error; otherwise the file is read back and returned.

The tests use an `EnvGuard` drop helper to restore `VISUAL` and `EDITOR`, serialize environment-sensitive tests, and on Unix create a tiny shell script that overwrites the temp file to verify `run_editor` returns edited content.

#### Function details

##### `resolve_windows_program`  (lines 25–29)

```
fn resolve_windows_program(program: &str) -> std::path::PathBuf
```

**Purpose**: Finds the executable path for a Windows editor command while honoring `PATH` and `PATHEXT`, so commands like `code` can resolve to `code.cmd`. If lookup fails, it preserves the original program string.

**Data flow**: It takes a program name string, calls `which::which(program)`, and returns either the resolved `PathBuf` or `PathBuf::from(program)` on error. It reads no global state directly beyond what `which` consults from the environment.

**Call relations**: This helper is used only by `run_editor` on Windows when constructing the child process command, specifically to handle shell-shim executables that `Command::new` would otherwise miss.

*Call graph*: called by 1 (run_editor); 1 external calls (which).


##### `resolve_editor_command`  (lines 33–51)

```
fn resolve_editor_command() -> std::result::Result<Vec<String>, EditorError>
```

**Purpose**: Parses the preferred editor command from environment variables into an argv vector. It enforces `VISUAL` precedence over `EDITOR` and validates that parsing produced at least one token.

**Data flow**: It reads `VISUAL` with `env::var`, falls back to `EDITOR`, maps missing variables to `EditorError::MissingEditor`, splits the raw string with `winsplit::split` on Windows or `shlex::split` elsewhere, converts parse failure on non-Windows to `EditorError::ParseFailed`, checks for an empty parts vector, and returns `Ok(Vec<String>)` or an `EditorError`. It does not mutate environment state.

**Call relations**: Production code calls this from the external-editor launch path, and the test `tests::resolve_editor_prefers_visual` invokes it directly to verify precedence and parsing behavior.

*Call graph*: called by 2 (launch_external_editor, resolve_editor_prefers_visual); 3 external calls (var, split, split).


##### `run_editor`  (lines 54–91)

```
async fn run_editor(seed: &str, editor_cmd: &[String]) -> Result<String>
```

**Purpose**: Launches the resolved editor command on a temporary markdown file seeded with initial text, then returns the file’s final contents after the editor exits. It is the execution half of the external-editor feature.

**Data flow**: It takes `seed` text and an `editor_cmd` argv slice. It rejects an empty argv with an eyre `Report`, creates a temporary `.md` file via `tempfile::Builder`, writes `seed` into it with `fs::write`, constructs a `tokio::process::Command` from the first argv element (using `resolve_windows_program` on Windows), appends any extra args and then the temp path, inherits stdio, awaits `.status()`, errors if the exit status is unsuccessful, and finally reads the file back with `fs::read_to_string`. It returns `Result<String>` and writes only the temp file and child-process I/O.

**Call relations**: This function is exercised directly by `tests::run_editor_returns_updated_content`. In production it is the lower-level executor used after command resolution has already produced an argv vector.

*Call graph*: calls 1 internal fn (resolve_windows_program); called by 1 (run_editor_returns_updated_content); 7 external calls (new, msg, inherit, new, format!, read_to_string, write).


##### `tests::EnvGuard::new`  (lines 107–112)

```
fn new() -> Self
```

**Purpose**: Captures the current `VISUAL` and `EDITOR` environment values so tests can restore them afterward. It isolates environment-sensitive tests from one another.

**Data flow**: It reads `env::var("VISUAL")` and `env::var("EDITOR")`, converts successes to `Option<String>`, and returns an `EnvGuard` holding those snapshots. It performs no writes.

**Call relations**: The environment-manipulating tests construct this guard at the start of each test so its `Drop` implementation can restore prior state automatically.

*Call graph*: 1 external calls (var).


##### `tests::EnvGuard::drop`  (lines 116–119)

```
fn drop(&mut self)
```

**Purpose**: Restores the saved editor-related environment variables when a test guard goes out of scope. It ensures tests leave process-global environment state unchanged.

**Data flow**: It takes mutable access to the guard, extracts the stored `visual` and `editor` values with `take()`, and passes them to `restore_env` for `VISUAL` and `EDITOR`. It writes process environment variables as a side effect and returns nothing.

**Call relations**: Rust calls this automatically at scope exit for `EnvGuard` instances created by the editor tests. It delegates the actual set/remove logic to `tests::restore_env`.

*Call graph*: 1 external calls (restore_env).


##### `tests::restore_env`  (lines 122–127)

```
fn restore_env(key: &str, value: Option<String>)
```

**Purpose**: Sets or removes a single environment variable based on an optional saved value. It is a tiny helper used by the test guard.

**Data flow**: It takes a key and `Option<String>`. If `Some`, it writes the variable with `env::set_var`; if `None`, it removes it with `env::remove_var`. It returns no value and mutates process environment state.

**Call relations**: Only `tests::EnvGuard::drop` calls this helper, using it to restore both `VISUAL` and `EDITOR` after each serialized test.

*Call graph*: 2 external calls (remove_var, set_var).


##### `tests::resolve_editor_prefers_visual`  (lines 131–139)

```
fn resolve_editor_prefers_visual()
```

**Purpose**: Checks that `resolve_editor_command` chooses `VISUAL` over `EDITOR` when both are set. It verifies the precedence rule directly.

**Data flow**: It creates an `EnvGuard`, sets `VISUAL=vis` and `EDITOR=ed`, calls `resolve_editor_command().unwrap()`, and asserts the returned argv is exactly `["vis"]`. It mutates environment variables during the test and relies on the guard to restore them.

**Call relations**: This unit test targets `resolve_editor_command` specifically, covering the happy path where both variables exist and precedence matters.

*Call graph*: calls 1 internal fn (resolve_editor_command); 3 external calls (assert_eq!, set_var, new).


##### `tests::resolve_editor_errors_when_unset`  (lines 143–153)

```
fn resolve_editor_errors_when_unset()
```

**Purpose**: Verifies that command resolution fails with `MissingEditor` when neither `VISUAL` nor `EDITOR` is present. It covers the no-configuration branch.

**Data flow**: It creates an `EnvGuard`, removes both environment variables, calls `resolve_editor_command()`, and asserts the result matches `Err(EditorError::MissingEditor)`. It writes environment state temporarily and returns nothing.

**Call relations**: This test exercises the early error path in `resolve_editor_command`, complementing the precedence test.

*Call graph*: 3 external calls (assert!, remove_var, new).


##### `tests::run_editor_returns_updated_content`  (lines 157–170)

```
async fn run_editor_returns_updated_content()
```

**Purpose**: Confirms that `run_editor` writes the seed to a temp file, runs the editor command, and returns the file’s modified contents. It uses a shell script as a deterministic fake editor.

**Data flow**: On Unix, it creates a temporary directory, writes an executable `edit.sh` script that overwrites its first argument with `edited`, marks it executable, builds a one-element command vector from the script path, awaits `run_editor("seed", &cmd)`, and asserts the returned string is `edited`. It writes files and permissions in the temp directory as test setup.

**Call relations**: This is the direct execution test for `run_editor`, validating the full temp-file and child-process round trip rather than only command parsing.

*Call graph*: calls 1 internal fn (run_editor); 6 external calls (assert_eq!, metadata, set_permissions, write, tempdir, vec!).


### `apply-patch/src/seek_sequence.rs`

`util` · `during update hunk matching`

This utility file contains one core algorithm, `seek_sequence`, plus focused tests. The function searches for a contiguous `pattern` slice inside a larger `lines` slice beginning at `start`, with optional end-of-file bias when `eof` is true. It is defensive about edge cases: an empty pattern is treated as a no-op match at `start`, and a pattern longer than the input returns `None` immediately to avoid slicing past the end.

The search proceeds in ordered passes. First it tries exact `Vec<String>` slice equality. If that fails, it retries while ignoring trailing whitespace on each line via `trim_end()`. If still unmatched, it trims both leading and trailing whitespace with `trim()`. As a final fuzzy pass, it normalizes common Unicode punctuation and spacing variants—typographic dashes to `-`, curly quotes to ASCII quotes, and several non-breaking or wide spaces to a normal space—then compares normalized trimmed strings. When `eof` is set and the pattern can fit, the initial search window starts at `lines.len() - pattern.len()` so EOF-marked hunks preferentially match the file ending before falling back to the normal range.

The tests demonstrate exact matching, trailing-whitespace tolerance, full trim tolerance, and the non-panicking oversized-pattern case.

#### Function details

##### `seek_sequence`  (lines 12–110)

```
fn seek_sequence(
    lines: &[String],
    pattern: &[String],
    start: usize,
    eof: bool,
) -> Option<usize>
```

**Purpose**: Finds the first location where a sequence of patch lines matches a file segment under progressively looser comparison rules.

**Data flow**: It takes `lines`, `pattern`, a starting index, and an `eof` flag. It returns `Some(index)` for the first successful match after trying exact equality, `trim_end()` equality, full `trim()` equality, and normalized-Unicode equality; otherwise it returns `None`. It does not mutate external state.

**Call relations**: This helper is called by `compute_replacements` when applying update hunks to existing file contents. Its staged matching strategy lets higher-level patch application remain deterministic while still tolerating common formatting drift.

*Call graph*: called by 1 (compute_replacements).


##### `tests::to_vec`  (lines 117–119)

```
fn to_vec(strings: &[&str]) -> Vec<String>
```

**Purpose**: Converts a slice of string literals into owned `Vec<String>` values for concise test setup.

**Data flow**: It accepts `&[&str]`, maps each element through `ToString::to_string`, collects into `Vec<String>`, and returns the new vector.

**Call relations**: This helper is used by all tests in the module to keep the search inputs readable and avoid repetitive allocation code.


##### `tests::test_exact_match_finds_sequence`  (lines 122–129)

```
fn test_exact_match_finds_sequence()
```

**Purpose**: Checks that the search returns the correct index when the pattern appears exactly in the input.

**Data flow**: It builds `lines` and `pattern` vectors with `to_vec`, calls `seek_sequence` with `start = 0` and `eof = false`, and asserts that the result is `Some(1)`.

**Call relations**: This is the baseline correctness test for the first, strictest search pass.

*Call graph*: 2 external calls (to_vec, assert_eq!).


##### `tests::test_rstrip_match_ignores_trailing_whitespace`  (lines 132–140)

```
fn test_rstrip_match_ignores_trailing_whitespace()
```

**Purpose**: Verifies that trailing whitespace differences do not prevent a match.

**Data flow**: It constructs input lines containing extra spaces and tabs, searches with a whitespace-stripped pattern, and asserts that `seek_sequence` still returns the starting index.

**Call relations**: This test exercises the second search pass, where each line is compared after `trim_end()`.

*Call graph*: 2 external calls (to_vec, assert_eq!).


##### `tests::test_trim_match_ignores_leading_and_trailing_whitespace`  (lines 143–151)

```
fn test_trim_match_ignores_leading_and_trailing_whitespace()
```

**Purpose**: Verifies that leading indentation differences are tolerated in the more permissive trim-based pass.

**Data flow**: It creates lines with both leading and trailing whitespace, searches using unindented pattern lines, and asserts a successful match at index 0.

**Call relations**: This test covers the third search pass, confirming that full `trim()` comparison is used after stricter modes fail.

*Call graph*: 2 external calls (to_vec, assert_eq!).


##### `tests::test_pattern_longer_than_input_returns_none`  (lines 154–162)

```
fn test_pattern_longer_than_input_returns_none()
```

**Purpose**: Ensures oversized patterns fail safely instead of panicking on out-of-bounds slicing.

**Data flow**: It builds a one-line input and a three-line pattern, calls `seek_sequence`, and asserts that the result is `None`.

**Call relations**: This test protects the early-return guard that prevents the historical panic mentioned in the file comments.

*Call graph*: 2 external calls (to_vec, assert_eq!).
