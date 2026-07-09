# Installation context, home discovery, and local environment probing  `stage-3`

This stage is the system’s “figure out where am I and what do I have?” step near startup. Before loading settings or making decisions, Codex needs a clear picture of its home folder, its installation layout, the machine it is on, and any helper tools it can use.

The home-dir code chooses the Codex home directory, either from CODEX_HOME or the user’s normal home folder, and checks that an explicitly supplied path is valid. install-context then works out how this copy of Codex was installed, where bundled files live, and where to find helper programs such as rg (ripgrep, a fast text search tool) or a bundled zsh shell. managed_install adds details for standalone installs, including version lookup and fingerprinting the executable so updaters can tell builds apart. On Windows, helper_materialization copies packaged helper programs into a shared sandbox bin folder and reuses cached results.

The rest describes the running environment. shell_snapshot captures a shell’s exported variables, aliases, and options into temporary files. environment and environment_provider turn that into reusable local or remote execution environments. host_name normalizes the machine name. The doctor and cloud-detection files report Git, OS, locale, editor, runtime, and likely cloud environment information for troubleshooting and automatic selection.

## Files in this stage

### Installation layout discovery
These files establish where Codex is installed, where its home directory and bundled resources live, and how managed installs are identified.

### `app-server-daemon/src/managed_install.rs`

`util` · `startup validation, version reporting, updater comparison`

This module is the daemon’s view of the installer-managed Codex binary. `managed_codex_bin` deterministically constructs the expected path under `CODEX_HOME/packages/standalone/current/`, using `managed_codex_file_name` to choose `codex` versus `codex.exe`. On Unix, `resolved_managed_codex_bin` canonicalizes that path so updater logic can compare or execute the real target rather than a symlink path.

`managed_codex_version` shells out to the managed binary with `--version`, checks for successful exit status, decodes stdout as UTF-8, and parses the version token with `parse_codex_version`. The parser is intentionally strict: it expects whitespace-separated output where the second token is the version, and rejects malformed output. This keeps daemon status reporting and updater comparisons tied to the binary’s own reported version.

For binary identity comparisons, the file defines `ExecutableIdentity`, a SHA-256 digest wrapper over executable bytes. `executable_identity` reads a file asynchronously and hashes it via `executable_identity_from_bytes`; updater code can use this to detect whether the managed binary or updater executable has materially changed even if paths remain stable. Overall, this file contains no lifecycle orchestration; it provides concrete filesystem/process helpers for locating, identifying, and interrogating the managed installation.

#### Function details

##### `managed_codex_bin`  (lines 19–25)

```
fn managed_codex_bin(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the expected path to the installer-managed Codex executable under the Codex home directory. It encodes the daemon’s fixed installation layout.

**Data flow**: Takes `codex_home`, joins `packages/standalone/current/`, appends the platform-specific executable filename from `managed_codex_file_name`, and returns the resulting `PathBuf`.

**Call relations**: Daemon environment construction uses this helper to populate `Daemon.managed_codex_bin`, which later lifecycle methods validate or execute.

*Call graph*: calls 1 internal fn (managed_codex_file_name); called by 1 (from_environment); 1 external calls (join).


##### `resolved_managed_codex_bin`  (lines 28–35)

```
async fn resolved_managed_codex_bin(codex_bin: &Path) -> Result<PathBuf>
```

**Purpose**: Canonicalizes the managed binary path to its resolved filesystem target. This is useful when symlinked installation paths should be compared by real location.

**Data flow**: Accepts a binary path, awaits `tokio::fs::canonicalize`, and returns the resolved `PathBuf` or a contextualized error naming the original path.

**Call relations**: Updater logic calls this when it needs a stable resolved binary path rather than the nominal managed-install symlink path.

*Call graph*: called by 1 (update_once); 1 external calls (canonicalize).


##### `managed_codex_version`  (lines 38–64)

```
async fn managed_codex_version(codex_bin: &Path) -> Result<String>
```

**Purpose**: Runs the managed Codex binary with `--version` and parses the reported version string. It treats nonzero exit status and malformed output as errors.

**Data flow**: Spawns `Command::new(codex_bin).arg("--version").output()`, checks `output.status.success()`, decodes `output.stdout` as UTF-8, and passes the resulting text to `parse_codex_version`, returning the parsed version string.

**Call relations**: Daemon status reporting and updater restart decisions use this helper when they need the managed binary’s own version rather than a path or digest.

*Call graph*: calls 1 internal fn (parse_codex_version); called by 2 (managed_codex_version_best_effort, try_restart_if_running); 3 external calls (from_utf8, anyhow!, new).


##### `executable_identity`  (lines 73–78)

```
async fn executable_identity(executable: &Path) -> Result<ExecutableIdentity>
```

**Purpose**: Computes a content-based identity for an executable file by hashing its bytes. It is the async filesystem wrapper around the pure hashing helper.

**Data flow**: Reads the entire file at `executable` with `tokio::fs::read`, passes the bytes to `executable_identity_from_bytes`, and returns the resulting `ExecutableIdentity`.

**Call relations**: Updater code uses this to compare current and candidate executables without relying on timestamps or paths.

*Call graph*: calls 1 internal fn (executable_identity_from_bytes); called by 2 (current_updater_identity, update_once); 1 external calls (read).


##### `executable_identity_from_bytes`  (lines 81–85)

```
fn executable_identity_from_bytes(bytes: &[u8]) -> ExecutableIdentity
```

**Purpose**: Hashes arbitrary bytes with SHA-256 and wraps the digest in `ExecutableIdentity`. It is the pure, testable core of executable fingerprinting.

**Data flow**: Accepts a byte slice, computes `Sha256::digest(bytes)`, converts the digest into `[u8; 32]`, and returns `ExecutableIdentity { digest }`.

**Call relations**: The async file-reading helper delegates here, and tests call it directly to verify that identity depends only on contents.

*Call graph*: called by 1 (executable_identity); 1 external calls (digest).


##### `managed_codex_file_name`  (lines 87–89)

```
fn managed_codex_file_name() -> &'static str
```

**Purpose**: Returns the platform-specific executable filename for the managed Codex binary. Windows uses `codex.exe`; all other platforms use `codex`.

**Data flow**: Evaluates `cfg!(windows)` and returns a static string accordingly.

**Call relations**: Only `managed_codex_bin` uses this helper when constructing the managed binary path.

*Call graph*: called by 1 (managed_codex_bin); 1 external calls (cfg!).


##### `parse_codex_version`  (lines 92–99)

```
fn parse_codex_version(output: &str) -> Result<String>
```

**Purpose**: Parses the version token from `codex --version` output. It expects the second whitespace-separated token to be the version string.

**Data flow**: Splits the input string on whitespace, takes `.nth(1)`, rejects missing or empty values with an error, and returns the version as an owned `String`.

**Call relations**: Only `managed_codex_version` calls this parser in production; tests cover both valid and malformed output.

*Call graph*: called by 1 (managed_codex_version).


### `utils/home-dir/src/lib.rs`

`config` · `config load`

This file provides `find_codex_home`, the public entry point for locating Codex's configuration directory, and a testable helper `find_codex_home_from_env` that contains the real logic. The public function reads `CODEX_HOME` from the process environment, discards unset or empty values, and forwards the optional string slice to the helper.

When an explicit `CODEX_HOME` value is present, the helper treats it as authoritative and validates it aggressively. It constructs a `PathBuf`, reads filesystem metadata, and rewrites metadata errors into clearer messages that mention `CODEX_HOME`; a missing path becomes `ErrorKind::NotFound`, while other metadata failures preserve their original kind. It then rejects non-directory paths with `InvalidInput`. For valid directories, it canonicalizes the path and wraps the canonical absolute path in `AbsolutePathBuf`, again enriching canonicalization failures with context.

When no environment override is supplied, the helper asks `dirs::home_dir()` for the user's home directory, errors with `NotFound` if unavailable, appends `.codex`, and wraps that path as an `AbsolutePathBuf` without checking whether it exists. That asymmetry is intentional: explicit overrides must already point to a real directory, while the default location may be created later. The tests cover missing, file, valid-directory, and default-home cases.

#### Function details

##### `find_codex_home`  (lines 13–18)

```
fn find_codex_home() -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Public API that resolves the Codex home directory using the current process environment. It normalizes the `CODEX_HOME` variable into an optional non-empty string before delegating to the helper.

**Data flow**: It reads `std::env::var("CODEX_HOME")`, converts success to `Option<String>`, filters out empty strings, then passes `codex_home_env.as_deref()` into `find_codex_home_from_env`. It returns the helper's `std::io::Result<AbsolutePathBuf>` unchanged.

**Call relations**: This is the exported entry point used by runtime code. It delegates all path validation and fallback behavior to `find_codex_home_from_env`.

*Call graph*: calls 1 internal fn (find_codex_home_from_env); 1 external calls (var).


##### `find_codex_home_from_env`  (lines 20–63)

```
fn find_codex_home_from_env(codex_home_env: Option<&str>) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Implements Codex home resolution from an optional environment override, including validation, canonicalization, and fallback to `~/.codex`. It is stricter for explicit overrides than for the implicit default path.

**Data flow**: It takes `codex_home_env: Option<&str>`. For `Some(val)`, it builds a `PathBuf` from `val`, reads metadata, maps metadata failures into contextual `std::io::Error`s, rejects non-directories with `InvalidInput`, canonicalizes the directory with contextual error mapping, and converts the canonical path into `AbsolutePathBuf`. For `None`, it obtains the user's home directory via `dirs::home_dir()`, returns a `NotFound` error if unavailable, appends `.codex`, and converts that path into `AbsolutePathBuf` without checking existence.

**Call relations**: This helper is called by the public `find_codex_home` and directly by all tests so the environment-dependent logic can be exercised deterministically. It is the file's core implementation.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 5 (find_codex_home, find_codex_home_env_file_path_is_fatal, find_codex_home_env_missing_path_is_fatal, find_codex_home_env_valid_directory_canonicalizes, find_codex_home_without_env_uses_default_home_dir); 5 external calls (from, new, home_dir, format!, metadata).


##### `tests::find_codex_home_env_missing_path_is_fatal`  (lines 76–89)

```
fn find_codex_home_env_missing_path_is_fatal()
```

**Purpose**: Verifies that an explicit `CODEX_HOME` pointing to a nonexistent path fails with `NotFound` and mentions `CODEX_HOME` in the error text. This confirms that invalid overrides are treated as fatal configuration errors.

**Data flow**: The test creates a temporary directory, derives a missing child path, converts it to UTF-8, calls `find_codex_home_from_env(Some(missing_str))`, captures the expected error, and asserts its kind and message contents.

**Call relations**: It exercises the metadata-error mapping branch in `find_codex_home_from_env` for missing explicit paths.

*Call graph*: calls 1 internal fn (find_codex_home_from_env); 3 external calls (new, assert!, assert_eq!).


##### `tests::find_codex_home_env_file_path_is_fatal`  (lines 92–106)

```
fn find_codex_home_env_file_path_is_fatal()
```

**Purpose**: Checks that an explicit `CODEX_HOME` pointing to a regular file is rejected as invalid input. This distinguishes wrong-type paths from missing paths.

**Data flow**: The test creates a temporary directory, writes a file inside it, converts that file path to UTF-8, calls `find_codex_home_from_env(Some(file_str))`, and asserts that the resulting error has kind `InvalidInput` and mentions `not a directory`.

**Call relations**: It covers the `metadata.is_dir()` validation branch in `find_codex_home_from_env`.

*Call graph*: calls 1 internal fn (find_codex_home_from_env); 4 external calls (new, assert!, assert_eq!, write).


##### `tests::find_codex_home_env_valid_directory_canonicalizes`  (lines 109–123)

```
fn find_codex_home_env_valid_directory_canonicalizes()
```

**Purpose**: Verifies that a valid explicit `CODEX_HOME` directory is canonicalized before being returned. This ensures callers receive a normalized absolute path.

**Data flow**: The test creates a temporary directory, converts its path to UTF-8, calls `find_codex_home_from_env(Some(temp_str))`, computes the expected canonical path, wraps it in `AbsolutePathBuf`, and asserts equality with the resolved result.

**Call relations**: It exercises the successful explicit-override path in `find_codex_home_from_env`, including canonicalization and absolute-path wrapping.

*Call graph*: calls 2 internal fn (from_absolute_path, find_codex_home_from_env); 2 external calls (new, assert_eq!).


##### `tests::find_codex_home_without_env_uses_default_home_dir`  (lines 126–133)

```
fn find_codex_home_without_env_uses_default_home_dir()
```

**Purpose**: Checks that when no override is provided, the helper returns `$HOME/.codex`. It confirms the default-path construction logic and the absence of existence checks in this branch.

**Data flow**: The test calls `find_codex_home_from_env(None)`, computes `home_dir()/".codex"`, wraps that path in `AbsolutePathBuf`, and asserts equality with the resolved result.

**Call relations**: It covers the fallback branch of `find_codex_home_from_env` that uses `dirs::home_dir()` and appends `.codex`.

*Call graph*: calls 2 internal fn (from_absolute_path, find_codex_home_from_env); 2 external calls (assert_eq!, home_dir).


### `install-context/src/lib.rs`

`config` · `startup and cross-cutting runtime resource lookup`

This file models the runtime installation environment. `InstallMethod` distinguishes standalone managed releases, npm/bun shim launches, Homebrew installs on macOS, and an `Other` catch-all. `CodexPackageLayout` captures the newer package-root layout containing `bin/`, optional `codex-resources/`, optional `codex-path/`, and a required `codex-package.json` marker. `InstallContext` combines the detected method with any discovered package layout.

Detection starts from the current executable path. `InstallContext::from_exe` resolves the Codex home directory and delegates to `from_exe_with_codex_home`, which first tries `CodexPackageLayout::from_exe` and then chooses the install method with explicit precedence: npm beats bun, both beat path-based inference. Path-based inference first checks whether the executable belongs to a standalone release under `<codex_home>/packages/standalone/releases/...`; if not, macOS binaries under `/opt/homebrew` or `/usr/local` are classified as Brew; everything else is `Other`. `InstallContext::current` memoizes this once in a `OnceLock` using `current_exe` and environment flags.

The lookup helpers prefer package-layout resources over legacy standalone locations. `rg_command` first checks `codex-path/<rg>` for an executable file, then standalone `codex-resources/<rg>`, then falls back to plain `rg` or `rg.exe`. `bundled_resource` similarly returns only existing files, not directories. `bundled_zsh_path` is disabled on Windows and otherwise resolves `codex-resources/zsh/bin/zsh`; `bundled_zsh_bin_dir` returns its parent. Tests cover precedence rules, package-layout detection independent of install method, and the distinction between missing files and directories.

#### Function details

##### `InstallContext::from_exe`  (lines 69–83)

```
fn from_exe(
        is_macos: bool,
        current_exe: Option<&Path>,
        managed_by_npm: bool,
        managed_by_bun: bool,
    ) -> Self
```

**Purpose**: Builds an install context from executable metadata plus npm/bun management flags.

**Data flow**: Takes `is_macos`, optional current executable path, and booleans for npm/bun management → tries `codex_utils_home_dir::find_codex_home().ok()` and passes the resulting optional path into `from_exe_with_codex_home` → returns the computed `InstallContext`.

**Call relations**: Public entry for install detection when callers do not already have a resolved Codex home path.

*Call graph*: 2 external calls (from_exe_with_codex_home, find_codex_home).


##### `InstallContext::from_exe_with_codex_home`  (lines 85–107)

```
fn from_exe_with_codex_home(
        is_macos: bool,
        current_exe: Option<&Path>,
        managed_by_npm: bool,
        managed_by_bun: bool,
        codex_home: Option<&Path>,
    ) -> Self
```

**Purpose**: Performs the actual install-method and package-layout inference using an optional Codex home root.

**Data flow**: Accepts platform flag, optional exe path, npm/bun flags, and optional codex-home path → derives `package_layout` via `current_exe.and_then(CodexPackageLayout::from_exe)` → chooses `method` by npm/bun precedence or `install_method_from_exe`, defaulting to `Other` when no exe is available → returns `InstallContext { method, package_layout }`.

**Call relations**: Internal detection core used by `from_exe` and extensively by tests to exercise specific path layouts and precedence cases.

*Call graph*: calls 1 internal fn (install_method_from_exe); called by 9 (brew_is_detected_on_macos_prefixes, bundled_file_lookups_ignore_directories, detects_package_layout_independently_from_install_method, detects_standalone_install_from_release_layout, npm_and_bun_take_precedence, npm_managed_package_keeps_package_layout, standalone_package_layout_keeps_standalone_install_method, standalone_package_rg_falls_back_when_codex_path_is_missing, standalone_rg_falls_back_when_resources_are_missing).


##### `InstallContext::current`  (lines 109–121)

```
fn current() -> &'static Self
```

**Purpose**: Returns the process-wide lazily initialized install context for the running binary.

**Data flow**: Reads the `INSTALL_CONTEXT` `OnceLock` → on first access, captures `std::env::current_exe().ok()`, checks `CODEX_MANAGED_BY_NPM` and `CODEX_MANAGED_BY_BUN`, and computes the context with `from_exe` → returns a shared `&'static InstallContext`.

**Call relations**: Used by multiple runtime subsystems that need installation-aware behavior without recomputing detection logic.

*Call graph*: called by 7 (arg0_dispatch, doctor_install_context, standalone_release_cache_details, apply_package_path_prepend, launcher, search_threads, get_update_action).


##### `InstallContext::rg_command`  (lines 123–145)

```
fn rg_command(&self) -> PathBuf
```

**Purpose**: Chooses the ripgrep executable path, preferring bundled copies when present.

**Data flow**: Reads `self.package_layout.path_dir` first and checks for `path_dir/default_rg_command()` as a file; if absent, checks standalone `resources_dir/default_rg_command()` from `self.method`; otherwise returns the fallback command name/path from `default_rg_command()`.

**Call relations**: Called by search-related code so packaged installs can use their managed ripgrep binary instead of relying on PATH.

*Call graph*: calls 1 internal fn (default_rg_command); called by 1 (search_provider).


##### `InstallContext::bundled_resource`  (lines 147–169)

```
fn bundled_resource(&self, file_name: impl AsRef<Path>) -> Option<AbsolutePathBuf>
```

**Purpose**: Looks up a named bundled resource file from package-layout or standalone resource directories.

**Data flow**: Takes a file name/path-like argument → if package layout has `resources_dir`, joins and returns it only if it is a file; otherwise, if install method is standalone with `resources_dir`, joins there and returns it only if it is a file; else returns `None`.

**Call relations**: Shared helper for resource consumers such as bundled zsh lookup and other install-context-aware file discovery.

*Call graph*: called by 2 (bundled_zsh_path, find_for_install_context); 1 external calls (as_ref).


##### `InstallContext::bundled_zsh_path`  (lines 171–177)

```
fn bundled_zsh_path(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the bundled zsh executable path on non-Windows platforms.

**Data flow**: Checks `cfg!(windows)` → returns `None` on Windows, otherwise delegates to `bundled_resource(zsh_resource_path())`.

**Call relations**: Thin convenience wrapper used when shell integration needs the packaged zsh binary.

*Call graph*: calls 2 internal fn (bundled_resource, zsh_resource_path); called by 1 (bundled_zsh_bin_dir); 1 external calls (cfg!).


##### `InstallContext::bundled_zsh_bin_dir`  (lines 179–181)

```
fn bundled_zsh_bin_dir(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the directory containing the bundled zsh executable, if available.

**Data flow**: Calls `self.bundled_zsh_path()?` and then returns its parent directory as an `AbsolutePathBuf` via `parent()`.

**Call relations**: Builds on `bundled_zsh_path` for callers that need the containing `bin` directory rather than the executable itself.

*Call graph*: calls 1 internal fn (bundled_zsh_path).


##### `CodexPackageLayout::from_exe`  (lines 185–192)

```
fn from_exe(exe_path: &Path) -> Option<Self>
```

**Purpose**: Detects the package-layout install structure from an executable path under a `bin/` directory.

**Data flow**: Canonicalizes the executable path with `canonical_absolute_path`, gets its parent directory, and checks whether that directory's file name is exactly `bin` → if so, delegates to `from_package_bin_dir`; otherwise returns `None`.

**Call relations**: Used during install-context construction to discover package metadata independently of the broader install method.

*Call graph*: calls 1 internal fn (canonical_absolute_path); 2 external calls (new, from_package_bin_dir).


##### `CodexPackageLayout::from_package_bin_dir`  (lines 194–206)

```
fn from_package_bin_dir(bin_dir: AbsolutePathBuf) -> Option<Self>
```

**Purpose**: Builds a package-layout description from a canonical `bin/` directory if the package marker file exists.

**Data flow**: Takes an absolute `bin_dir` → gets `package_dir = bin_dir.parent()?` → requires `package_dir/codex-package.json` to be a file → populates optional `resources_dir` and `path_dir` via `existing_dir` and returns `CodexPackageLayout`.

**Call relations**: Called only from `from_exe` after the enclosing `bin/` directory shape has been recognized.

*Call graph*: calls 2 internal fn (existing_dir, parent).


##### `install_method_from_exe`  (lines 209–225)

```
fn install_method_from_exe(
    exe_path: &Path,
    codex_home: Option<&Path>,
    package_layout: Option<&CodexPackageLayout>,
    is_macos: bool,
) -> InstallMethod
```

**Purpose**: Classifies an executable path as standalone, brew, or other when npm/bun do not already apply.

**Data flow**: Takes the exe path, optional codex-home, optional package layout, and macOS flag → first tries `standalone_install_method`; if that returns `Some`, returns it immediately; otherwise on macOS checks Homebrew prefixes `/opt/homebrew` and `/usr/local`, else returns `InstallMethod::Other`.

**Call relations**: Invoked by `InstallContext::from_exe_with_codex_home` as the path-based fallback after npm/bun precedence is resolved.

*Call graph*: calls 1 internal fn (standalone_install_method); called by 1 (from_exe_with_codex_home); 1 external calls (starts_with).


##### `standalone_install_method`  (lines 227–252)

```
fn standalone_install_method(
    exe_path: &Path,
    codex_home: Option<&Path>,
    package_layout: Option<&CodexPackageLayout>,
) -> Option<InstallMethod>
```

**Purpose**: Recognizes managed standalone installs rooted under the Codex home releases directory.

**Data flow**: Requires a codex-home path and canonicalizes it; chooses `release_dir` as either the package-layout root or the canonical parent of the executable; computes `<codex_home>/packages/standalone/releases`; if `release_dir` is under that root, returns `InstallMethod::Standalone { release_dir, resources_dir: optional existing codex-resources dir, platform: standalone_platform() }`, otherwise `None`.

**Call relations**: Called by `install_method_from_exe` before brew/other detection so managed standalone installs win.

*Call graph*: calls 2 internal fn (canonical_absolute_path, standalone_platform); called by 1 (install_method_from_exe).


##### `canonical_absolute_path`  (lines 254–257)

```
fn canonical_absolute_path(path: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Canonicalizes a path and converts it into the project's absolute-path wrapper type.

**Data flow**: Takes `&Path` → runs `std::fs::canonicalize(path).ok()?` → converts the result with `AbsolutePathBuf::from_absolute_path(...).ok()` → returns `Option<AbsolutePathBuf>`.

**Call relations**: Shared helper for package-layout and standalone detection so comparisons use normalized absolute paths.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (from_exe, standalone_install_method); 1 external calls (canonicalize).


##### `standalone_platform`  (lines 259–265)

```
fn standalone_platform() -> StandalonePlatform
```

**Purpose**: Maps the compile target to the standalone platform enum.

**Data flow**: Reads `cfg!(windows)` → returns `StandalonePlatform::Windows` on Windows, otherwise `StandalonePlatform::Unix`.

**Call relations**: Used when constructing `InstallMethod::Standalone`.

*Call graph*: called by 1 (standalone_install_method); 1 external calls (cfg!).


##### `existing_dir`  (lines 267–269)

```
fn existing_dir(path: AbsolutePathBuf) -> Option<AbsolutePathBuf>
```

**Purpose**: Keeps an absolute path only if it currently exists as a directory.

**Data flow**: Takes an `AbsolutePathBuf` → checks `is_dir()` → returns `Some(path)` if true, else `None`.

**Call relations**: Used while building `CodexPackageLayout` to make `resources_dir` and `path_dir` optional.

*Call graph*: called by 1 (from_package_bin_dir); 1 external calls (is_dir).


##### `default_rg_command`  (lines 271–277)

```
fn default_rg_command() -> PathBuf
```

**Purpose**: Returns the platform-appropriate fallback ripgrep executable name.

**Data flow**: Reads `cfg!(windows)` → returns `PathBuf::from("rg.exe")` on Windows or `PathBuf::from("rg")` otherwise.

**Call relations**: Used by `rg_command` and many tests as the canonical fallback executable name.

*Call graph*: called by 6 (rg_command, bundled_file_lookups_ignore_directories, detects_package_layout_independently_from_install_method, detects_standalone_install_from_release_layout, npm_managed_package_keeps_package_layout, standalone_package_layout_keeps_standalone_install_method); 2 external calls (from, cfg!).


##### `zsh_resource_path`  (lines 279–281)

```
fn zsh_resource_path() -> PathBuf
```

**Purpose**: Builds the relative resource path to the bundled zsh executable inside a package resource tree.

**Data flow**: Constructs `PathBuf::from("zsh").join("bin").join("zsh")` and returns it.

**Call relations**: Used by `bundled_zsh_path` and tests that validate zsh resource discovery.

*Call graph*: called by 2 (bundled_zsh_path, detects_package_layout_independently_from_install_method); 1 external calls (from).


##### `tests::detects_standalone_install_from_release_layout`  (lines 292–331)

```
fn detects_standalone_install_from_release_layout() -> std::io::Result<()>
```

**Purpose**: Verifies standalone release detection and bundled resource lookup for the legacy release directory layout.

**Data flow**: Creates a temporary codex-home tree with `packages/standalone/releases/...`, writes an executable and resource files, computes canonical expected paths, builds a context with `from_exe_with_codex_home`, and asserts both the detected `InstallMethod::Standalone` and `bundled_resource` result.

**Call relations**: Exercises the standalone path classifier and resource lookup fallback together.

*Call graph*: calls 3 internal fn (from_exe_with_codex_home, default_rg_command, from_absolute_path); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::standalone_rg_falls_back_when_resources_are_missing`  (lines 334–352)

```
fn standalone_rg_falls_back_when_resources_are_missing() -> std::io::Result<()>
```

**Purpose**: Checks that standalone installs without a resources directory fall back to the default `rg` command.

**Data flow**: Creates a release directory containing only the executable, builds the context, and asserts `context.rg_command() == default_rg_command()`.

**Call relations**: Regression test for the absence path in `rg_command`.

*Call graph*: calls 1 internal fn (from_exe_with_codex_home); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::detects_package_layout_independently_from_install_method`  (lines 355–424)

```
fn detects_package_layout_independently_from_install_method() -> std::io::Result<()>
```

**Purpose**: Shows that package-layout discovery works even when the broader install method is classified as `Other`.

**Data flow**: Creates a package root with `bin`, `codex-resources`, `codex-path`, and metadata file; writes test resources and optional zsh; builds the context without codex-home; asserts `method == Other`, `package_layout` contents, `rg_command`, `bundled_resource`, and zsh lookup behavior.

**Call relations**: Covers the separation between package-layout detection and install-method classification.

*Call graph*: calls 4 internal fn (from_exe_with_codex_home, default_rg_command, zsh_resource_path, from_absolute_path); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::standalone_package_layout_keeps_standalone_install_method`  (lines 427–484)

```
fn standalone_package_layout_keeps_standalone_install_method() -> std::io::Result<()>
```

**Purpose**: Verifies that a package-layout install inside the standalone releases tree is classified as both package-layout and standalone.

**Data flow**: Creates a package-layout tree under `<codex_home>/packages/standalone/releases/...`, writes executable/resources/path helper, builds the context with codex-home, and asserts both `InstallMethod::Standalone` and populated `package_layout`, plus resource lookups.

**Call relations**: Tests the interaction between the two detection mechanisms when both apply.

*Call graph*: calls 3 internal fn (from_exe_with_codex_home, default_rg_command, from_absolute_path); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::npm_managed_package_keeps_package_layout`  (lines 487–515)

```
fn npm_managed_package_keeps_package_layout() -> std::io::Result<()>
```

**Purpose**: Checks that npm management takes precedence for `method` while preserving package-layout-derived helper paths.

**Data flow**: Creates a package-layout tree, marks the context as npm-managed, builds it, and asserts `method == Npm`, `package_layout.is_some()`, and `rg_command` uses the packaged `codex-path` binary.

**Call relations**: Regression test for precedence ordering in `from_exe_with_codex_home`.

*Call graph*: calls 3 internal fn (from_exe_with_codex_home, default_rg_command, from_absolute_path); 6 external calls (assert!, assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::standalone_package_rg_falls_back_when_codex_path_is_missing`  (lines 518–535)

```
fn standalone_package_rg_falls_back_when_codex_path_is_missing() -> std::io::Result<()>
```

**Purpose**: Ensures package-layout installs without `codex-path` do not invent a bundled ripgrep path.

**Data flow**: Creates only `bin/` plus metadata, builds the context, and asserts `rg_command()` falls back to `default_rg_command()`.

**Call relations**: Covers the package-layout branch of `rg_command` when the helper binary is absent.

*Call graph*: calls 1 internal fn (from_exe_with_codex_home); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::bundled_file_lookups_ignore_directories`  (lines 538–560)

```
fn bundled_file_lookups_ignore_directories() -> std::io::Result<()>
```

**Purpose**: Verifies that helper/resource lookup requires files and ignores directories with matching names.

**Data flow**: Creates directory-shaped placeholders where a resource file and `rg` executable would normally be, builds the context, and asserts `rg_command()` falls back and `bundled_resource(TEST_RESOURCE_NAME)` returns `None`.

**Call relations**: Protects against false positives from `is_dir`/`is_file` confusion.

*Call graph*: calls 2 internal fn (from_exe_with_codex_home, default_rg_command); 5 external calls (assert_eq!, cfg!, create_dir_all, write, tempdir).


##### `tests::npm_and_bun_take_precedence`  (lines 563–593)

```
fn npm_and_bun_take_precedence()
```

**Purpose**: Checks that explicit npm or bun management flags override path-based install inference.

**Data flow**: Builds one context with `managed_by_npm = true` and another with `managed_by_bun = true` for the same arbitrary exe path, then asserts the resulting methods are `Npm` and `Bun` with no package layout.

**Call relations**: Directly validates the precedence chain in `from_exe_with_codex_home`.

*Call graph*: calls 1 internal fn (from_exe_with_codex_home); 2 external calls (new, assert_eq!).


##### `tests::brew_is_detected_on_macos_prefixes`  (lines 596–611)

```
fn brew_is_detected_on_macos_prefixes()
```

**Purpose**: Verifies Homebrew detection for macOS executable prefixes.

**Data flow**: Builds a context for `/opt/homebrew/bin/codex` with `is_macos = true` and no npm/bun/codex-home hints, then asserts the result is `InstallMethod::Brew`.

**Call relations**: Covers the final path-based classification branch after standalone detection fails.

*Call graph*: calls 1 internal fn (from_exe_with_codex_home); 2 external calls (new, assert_eq!).


### `windows-sandbox-rs/src/helper_materialization.rs`

`util` · `helper resolution during setup and process launch`

This file exists to make helper binaries—currently `codex-command-runner.exe`—available from a stable, sandbox-owned location with inherited ACLs. `HelperExecutable` names the supported helper kinds and provides both the on-disk filename and a human-readable label for logging. The destination directory is `sandbox_bin_dir(codex_home)`, exposed here as `helper_bin_dir`.

Resolution starts by finding the source helper next to the current executable or in packaged resource directories. `bundled_executable_path_for_exe` checks three locations in order: a direct sibling of the current exe, `../codex-resources` when the exe lives in a `bin` directory, and finally `./codex-resources`. `legacy_lookup` uses that search but falls back to a bare filename if current-exe discovery fails.

The preferred path is `resolve_helper_for_launch`, which calls `copy_helper_if_needed`. That function caches successful resolutions in a `OnceLock<Mutex<HashMap<String, PathBuf>>>` keyed by helper filename plus `codex_home`, computes a versioned destination name using either `CARGO_PKG_VERSION` or a dev-build suffix derived from source file size and mtime, and then copies only when the destination is stale. Copying is done through a temporary file created inside the destination directory so the resulting file inherits the sandbox bin directory's ACLs rather than preserving source-file security metadata. If rename races with another process, the code rechecks freshness and treats an already-updated destination as success. The tests exercise missing/fresh destination behavior, helper lookup precedence, and filename/version generation.

#### Function details

##### `HelperExecutable::file_name`  (lines 28–32)

```
fn file_name(self) -> &'static str
```

**Purpose**: Returns the concrete executable filename for a helper kind. For the current enum variant, it maps `CommandRunner` to `codex-command-runner.exe`.

**Data flow**: It takes `self` by value and matches on the enum variant. The function returns a `'static` string slice naming the helper executable and does not mutate any state.

**Call relations**: It is used wherever helper paths or materialized filenames are built, including source lookup and destination naming. Other functions rely on it as the canonical filename source rather than hardcoding names repeatedly.

*Call graph*: called by 3 (legacy_lookup, materialized_file_name, sibling_source_path).


##### `HelperExecutable::label`  (lines 34–38)

```
fn label(self) -> &'static str
```

**Purpose**: Returns a short human-readable label for logging and diagnostics. For `CommandRunner`, the label is `command-runner`.

**Data flow**: It matches on the enum variant and returns a `'static` string slice. No external state is read or written.

**Call relations**: It is consumed by logging-heavy helper resolution functions so log messages can describe which helper was reused, recopied, or failed to copy.


##### `helper_bin_dir`  (lines 49–51)

```
fn helper_bin_dir(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the shared sandbox bin directory under `codex_home` where copied helpers are materialized. It is a thin wrapper around the crate-level sandbox-bin path helper.

**Data flow**: It takes `codex_home: &Path`, passes it to `sandbox_bin_dir`, and returns the resulting `PathBuf`. It performs no mutation.

**Call relations**: It is used by destination-building and current-exe materialization paths, and tests assert that it points under `.sandbox-bin`. It provides a single local naming point for helper destination layout.

*Call graph*: called by 7 (helper_destination_for_source, resolve_current_exe_for_launch, copy_runner_into_shared_bin_dir, gather_helper_read_roots, build_payload_roots_preserves_helper_roots_when_read_override_is_provided, build_payload_roots_replaces_full_read_policy_when_read_override_is_provided, gather_read_roots_includes_helper_bin_dir); 1 external calls (sandbox_bin_dir).


##### `legacy_lookup`  (lines 53–60)

```
fn legacy_lookup(kind: HelperExecutable) -> PathBuf
```

**Purpose**: Finds a helper executable without copying it into the sandbox bin directory, preferring packaged sibling/resource locations and otherwise falling back to a bare filename. This is the compatibility fallback when materialization fails.

**Data flow**: It takes a `HelperExecutable`, tries `std::env::current_exe()`, and if successful asks `bundled_executable_path_for_exe` for the helper path using `kind.file_name()`. If that search succeeds it returns the discovered path; otherwise it returns `PathBuf::from(kind.file_name())`.

**Call relations**: It is called only by `resolve_helper_for_launch` when copying the helper fails. Its role is to preserve launchability even if the preferred sandbox-owned copy path cannot be prepared.

*Call graph*: calls 2 internal fn (file_name, bundled_executable_path_for_exe); called by 1 (resolve_helper_for_launch); 2 external calls (from, current_exe).


##### `resolve_helper_for_launch`  (lines 62–92)

```
fn resolve_helper_for_launch(
    kind: HelperExecutable,
    codex_home: &Path,
    log_dir: Option<&Path>,
) -> PathBuf
```

**Purpose**: Resolves the executable path that should actually be launched for a helper, preferring a copied sandbox-bin version and logging either success or fallback. It is the main public helper-resolution entry point in this file.

**Data flow**: It takes a helper kind, `codex_home`, and an optional log directory. The function calls `copy_helper_if_needed`; on success it logs that the copied helper path will be used and returns that path, while on error it computes `legacy_lookup(kind)`, logs the copy failure plus fallback path, and returns the fallback.

**Call relations**: It is called by higher-level launch code that needs the command-runner executable path. It delegates the actual copy/cache/version logic to `copy_helper_if_needed` and uses `legacy_lookup` only as a resilience path.

*Call graph*: calls 3 internal fn (copy_helper_if_needed, legacy_lookup, log_note); called by 1 (find_runner_exe); 1 external calls (format!).


##### `resolve_current_exe_for_launch`  (lines 94–117)

```
fn resolve_current_exe_for_launch(codex_home: &Path, fallback_executable: &str) -> PathBuf
```

**Purpose**: Copies the current executable itself into the sandbox bin directory when possible and returns the copied path, falling back to the original executable path or a caller-provided fallback name. This is used when the launcher binary, not just a helper, must be materialized into sandbox-owned storage.

**Data flow**: It takes `codex_home` and a fallback executable name. The function reads `std::env::current_exe`; if that fails it returns `PathBuf::from(fallback_executable)`. Otherwise it derives the destination as `helper_bin_dir(codex_home).join(current_file_name)`, calls `copy_from_source_if_needed`, and returns the destination on success. On copy failure it logs to `sandbox_dir(codex_home)` and returns the original source path.

**Call relations**: It is used by callers that need a launchable path for the current binary under sandbox-controlled ACLs. Internally it reuses the same freshness-aware copy primitive as helper materialization.

*Call graph*: calls 3 internal fn (copy_from_source_if_needed, helper_bin_dir, log_note); 4 external calls (from, sandbox_dir, format!, current_exe).


##### `copy_helper_if_needed`  (lines 119–165)

```
fn copy_helper_if_needed(
    kind: HelperExecutable,
    codex_home: &Path,
    log_dir: Option<&Path>,
) -> Result<PathBuf>
```

**Purpose**: Ensures a specific helper executable has been copied into the versioned sandbox bin location and returns that destination path. It avoids repeated work through an in-memory cache and freshness checks.

**Data flow**: It takes a helper kind, `codex_home`, and optional log directory. The function builds a cache key from helper filename and `codex_home`; if `cached_helper_path` returns a path, it logs cache reuse and returns it. Otherwise it resolves the source via `sibling_source_path`, computes the destination via `helper_destination_for_source`, logs validation details, copies or reuses the destination through `copy_from_source_if_needed`, logs whether the file was reused or recopied, stores the destination in the cache with `store_helper_path`, and returns the destination path.

**Call relations**: It is the core worker behind `resolve_helper_for_launch`. It orchestrates source discovery, destination naming, copy freshness, logging, and cache population so repeated launches do not repeatedly touch the filesystem.

*Call graph*: calls 6 internal fn (cached_helper_path, copy_from_source_if_needed, helper_destination_for_source, sibling_source_path, store_helper_path, log_note); called by 1 (resolve_helper_for_launch); 1 external calls (format!).


##### `cached_helper_path`  (lines 167–171)

```
fn cached_helper_path(cache_key: &str) -> Option<PathBuf>
```

**Purpose**: Looks up a previously resolved helper destination path from the process-wide cache. It returns `None` if the cache is uninitialized, poisoned, or missing the key.

**Data flow**: It takes a cache-key string slice, initializes `HELPER_PATH_CACHE` to a `Mutex<HashMap<...>>` if needed, attempts to lock the mutex, and clones the stored `PathBuf` for the key if present. It returns `Option<PathBuf>` and does not mutate the cache.

**Call relations**: It is used only by `copy_helper_if_needed` as the fast path before any source lookup or filesystem work. Its existence makes helper resolution effectively idempotent within a process for a given helper and `codex_home`.

*Call graph*: called by 1 (copy_helper_if_needed).


##### `store_helper_path`  (lines 173–178)

```
fn store_helper_path(cache_key: String, path: PathBuf)
```

**Purpose**: Records a resolved helper destination path in the process-wide cache. Failures to lock the cache are silently ignored.

**Data flow**: It takes an owned cache key and destination `PathBuf`, initializes the global cache if needed, locks the mutex if possible, and inserts the key/path pair into the underlying `HashMap`. It returns no value.

**Call relations**: It is called by `copy_helper_if_needed` after a helper destination has been validated and copied or reused. This write enables later calls to skip source lookup and freshness checks.

*Call graph*: called by 1 (copy_helper_if_needed).


##### `sibling_source_path`  (lines 180–188)

```
fn sibling_source_path(kind: HelperExecutable) -> Result<PathBuf>
```

**Purpose**: Finds the packaged source path for a helper relative to the current executable and errors if no packaged helper can be found. It is stricter than `legacy_lookup` because it is used by the copy path.

**Data flow**: It takes a helper kind, resolves `std::env::current_exe()`, and passes that path plus `kind.file_name()` into `bundled_executable_path_for_exe`. If a candidate is found it returns the `PathBuf`; otherwise it returns an `anyhow!` error describing the missing helper and the current executable location.

**Call relations**: It is called by `copy_helper_if_needed` before destination naming and copying. Unlike `legacy_lookup`, it does not fall back to a bare filename because copying requires a concrete source file.

*Call graph*: calls 2 internal fn (file_name, bundled_executable_path_for_exe); called by 1 (copy_helper_if_needed); 1 external calls (current_exe).


##### `bundled_executable_path_for_exe`  (lines 190–208)

```
fn bundled_executable_path_for_exe(exe: &Path, file_name: &str) -> Option<PathBuf>
```

**Purpose**: Searches for a helper executable in the packaging layouts supported by the project. It encodes the precedence rules between direct siblings and resource directories.

**Data flow**: It takes an executable path and a helper filename. The function gets the executable's parent directory, checks for a direct sibling file there, then if the parent directory is named `bin` checks the package-level `codex-resources/<file_name>`, and finally checks `<exe_dir>/codex-resources/<file_name>`. It returns the first existing file as `Some(PathBuf)` or `None` if none exist.

**Call relations**: It is used by both fallback lookup and strict source discovery, and tests cover its precedence rules. This function is the central definition of how packaged helper binaries are discovered on disk.

*Call graph*: called by 7 (legacy_lookup, sibling_source_path, helper_source_lookup_checks_package_resource_dir_for_bin_exe, helper_source_lookup_checks_resource_dir, helper_source_lookup_prefers_direct_sibling_over_resource_dir, helper_source_lookup_prefers_package_resource_dir_over_bin_resource_dir, find_setup_exe_for_current_exe); 2 external calls (new, parent).


##### `helper_destination_for_source`  (lines 210–218)

```
fn helper_destination_for_source(
    kind: HelperExecutable,
    codex_home: &Path,
    source: &Path,
) -> Result<PathBuf>
```

**Purpose**: Computes the versioned destination path in the sandbox bin directory for a given helper source file. The destination filename includes a suffix derived from build version or source metadata.

**Data flow**: It takes a helper kind, `codex_home`, and source path. The function computes a suffix with `helper_version_suffix`, builds the final filename with `materialized_file_name`, joins it under `helper_bin_dir(codex_home)`, and returns the resulting `PathBuf`.

**Call relations**: It is called by `copy_helper_if_needed` after source discovery. By separating destination naming from copying, it keeps versioning logic reusable and testable.

*Call graph*: calls 3 internal fn (helper_bin_dir, helper_version_suffix, materialized_file_name); called by 1 (copy_helper_if_needed).


##### `materialized_file_name`  (lines 220–233)

```
fn materialized_file_name(kind: HelperExecutable, suffix: &str) -> String
```

**Purpose**: Builds the copied helper filename by inserting a suffix before the original extension. This preserves the executable extension while making different helper versions coexist safely.

**Data flow**: It takes a helper kind and suffix string, obtains the source filename from `kind.file_name()`, parses stem and extension with `Path`, and returns a new `String` of the form `<stem>-<suffix><extension>`. If stem or extension parsing fails, it falls back to the original source name semantics.

**Call relations**: It is used by `helper_destination_for_source` and directly in tests. Its output determines the stable on-disk naming convention for materialized helpers.

*Call graph*: calls 1 internal fn (file_name); called by 3 (helper_destination_for_source, copy_runner_into_shared_bin_dir, materialized_file_name_adds_suffix_before_extension); 2 external calls (new, format!).


##### `helper_version_suffix`  (lines 235–242)

```
fn helper_version_suffix(source: &Path) -> Result<String>
```

**Purpose**: Chooses the suffix used in materialized helper filenames. Release builds use the crate version, while dev builds use source-file metadata so changed binaries get new names.

**Data flow**: It takes a source path, reads `env!("CARGO_PKG_VERSION")`, and compares it to the sentinel `0.0.0`. If the version is not the sentinel it returns that version string; otherwise it delegates to `dev_build_suffix(source)` and returns the computed metadata-based suffix.

**Call relations**: It is called during destination naming and tested explicitly. This split avoids stale helper reuse in development while keeping release filenames predictable.

*Call graph*: calls 1 internal fn (dev_build_suffix); called by 3 (helper_destination_for_source, copy_runner_into_shared_bin_dir, helper_version_suffix_uses_cli_version_or_dev_build_metadata); 1 external calls (env!).


##### `dev_build_suffix`  (lines 244–254)

```
fn dev_build_suffix(source: &Path) -> Result<String>
```

**Purpose**: Computes a development-build suffix from the helper source file's size and modification time. This gives a cheap content-change proxy without hashing the file.

**Data flow**: It takes a source path, reads filesystem metadata, extracts the modified timestamp, converts it to a duration since `UNIX_EPOCH`, and formats a string `<len>-<mtime_secs_hex>`. Errors from metadata or time conversion are wrapped with source-path context and returned.

**Call relations**: It is used only by `helper_version_suffix` when the crate version equals the development sentinel. Its output feeds directly into materialized helper filenames.

*Call graph*: called by 1 (helper_version_suffix); 2 external calls (format!, metadata).


##### `copy_from_source_if_needed`  (lines 256–328)

```
fn copy_from_source_if_needed(source: &Path, destination: &Path) -> Result<CopyOutcome>
```

**Purpose**: Copies a source executable into a destination path only when the destination is missing or stale, using a temp-file-and-rename strategy inside the destination directory. It preserves destination-directory ACL inheritance and tolerates concurrent copies.

**Data flow**: It takes source and destination paths. The function first calls `destination_is_fresh`; if true it returns `CopyOutcome::Reused`. Otherwise it ensures the destination parent directory exists, creates a `NamedTempFile` in that directory, opens the source for reading and the temp path for writing, copies bytes with `std::io::copy`, flushes the temp file, removes any existing destination file, and attempts `fs::rename(temp, destination)`. If rename fails, it rechecks `destination_is_fresh`; if another process already produced a fresh destination it returns `Reused`, otherwise it returns the rename error with context. Successful copy-and-rename returns `CopyOutcome::ReCopied`.

**Call relations**: It is the low-level copy primitive used by both helper materialization and current-exe materialization, and several tests exercise its behavior. The temp-file placement inside the destination directory is a deliberate design choice so copied helpers inherit the sandbox bin directory's ACLs.

*Call graph*: calls 1 internal fn (destination_is_fresh); called by 5 (copy_helper_if_needed, resolve_current_exe_for_launch, copy_from_source_if_needed_copies_missing_destination, copy_from_source_if_needed_reuses_fresh_destination, copy_runner_into_shared_bin_dir); 9 external calls (new_in, exists, parent, open, new, create_dir_all, remove_file, rename, copy).


##### `destination_is_fresh`  (lines 330–355)

```
fn destination_is_fresh(source: &Path, destination: &Path) -> Result<bool>
```

**Purpose**: Determines whether an existing destination file is fresh enough to reuse instead of copying again. Freshness is defined by equal file size and destination mtime not older than source mtime.

**Data flow**: It takes source and destination paths, reads source metadata, then reads destination metadata. If the destination is missing it returns `Ok(false)`; other metadata errors are propagated with context. It compares file lengths first, then compares modified timestamps, and returns `Ok(true)` only when sizes match and destination modified time is greater than or equal to source modified time.

**Call relations**: It is used exclusively by `copy_from_source_if_needed` both before copying and after a failed rename race. This makes copy behavior efficient in the common case and safe under concurrent materialization.

*Call graph*: called by 1 (copy_from_source_if_needed); 1 external calls (metadata).


##### `tests::copy_from_source_if_needed_copies_missing_destination`  (lines 378–392)

```
fn copy_from_source_if_needed_copies_missing_destination()
```

**Purpose**: Verifies that a missing destination causes the helper copy routine to create the destination file and report a recopy. It checks both the returned `CopyOutcome` and the copied bytes.

**Data flow**: The test creates a temporary directory, writes a source file, calls `copy_from_source_if_needed`, then reads the destination file and asserts that the outcome is `CopyOutcome::ReCopied` and the contents match the source bytes.

**Call relations**: This test directly exercises the initial-copy branch of `copy_from_source_if_needed`. It serves as regression coverage for destination creation and byte-for-byte copying.

*Call graph*: calls 1 internal fn (copy_from_source_if_needed); 3 external calls (new, assert_eq!, write).


##### `tests::destination_is_fresh_uses_size_and_mtime`  (lines 395–407)

```
fn destination_is_fresh_uses_size_and_mtime()
```

**Purpose**: Checks that freshness depends on both file size and modification time ordering. It demonstrates that equal size alone is insufficient when the destination is older than the source.

**Data flow**: The test writes a destination file, sleeps to create a timestamp gap, writes a same-sized source file, asserts that `destination_is_fresh` is false, then rewrites the destination and asserts that freshness becomes true.

**Call relations**: It validates the exact freshness predicate used by `copy_from_source_if_needed`. This protects against accidental regressions that would reuse stale helper binaries.

*Call graph*: 5 external calls (new, assert!, write, sleep, from_secs).


##### `tests::copy_from_source_if_needed_reuses_fresh_destination`  (lines 410–425)

```
fn copy_from_source_if_needed_reuses_fresh_destination()
```

**Purpose**: Verifies that the copy routine does not rewrite a destination that is already fresh. It confirms both the returned outcome and the preserved file contents.

**Data flow**: The test writes a source file, performs an initial copy to create the destination, calls `copy_from_source_if_needed` again, and asserts that the second call returns `CopyOutcome::Reused` while the destination bytes remain unchanged.

**Call relations**: This test covers the fast-path reuse branch of `copy_from_source_if_needed`. It complements the missing-destination test by proving the function is incremental rather than always copying.

*Call graph*: calls 1 internal fn (copy_from_source_if_needed); 3 external calls (new, assert_eq!, write).


##### `tests::helper_bin_dir_is_under_sandbox_bin`  (lines 428–435)

```
fn helper_bin_dir_is_under_sandbox_bin()
```

**Purpose**: Asserts the path layout contract for helper materialization. It ensures helper binaries are placed under `.sandbox-bin` beneath `codex_home`.

**Data flow**: The test constructs a sample `codex_home` path, calls `helper_bin_dir`, and compares the result to the expected `codex_home/.sandbox-bin` path.

**Call relations**: It validates the wrapper around `sandbox_bin_dir`. This keeps downstream assumptions about helper placement explicit in test coverage.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::copy_runner_into_shared_bin_dir`  (lines 438–459)

```
fn copy_runner_into_shared_bin_dir()
```

**Purpose**: Exercises the end-to-end destination naming and copy flow for the command-runner helper in a temporary directory. It confirms that a version-suffixed destination under the helper bin directory is populated correctly.

**Data flow**: The test creates temporary source and codex-home directories, writes a fake `codex-command-runner.exe`, computes its suffix with `helper_version_suffix`, builds the destination filename with `materialized_file_name`, copies via `copy_from_source_if_needed`, and asserts `ReCopied` plus matching destination bytes.

**Call relations**: It ties together `helper_bin_dir`, `helper_version_suffix`, `materialized_file_name`, and the copy primitive. This gives integration-style coverage for the materialization naming convention.

*Call graph*: calls 4 internal fn (copy_from_source_if_needed, helper_bin_dir, helper_version_suffix, materialized_file_name); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_source_lookup_checks_resource_dir`  (lines 462–477)

```
fn helper_source_lookup_checks_resource_dir()
```

**Purpose**: Verifies that helper lookup finds a helper under a sibling `codex-resources` directory when no direct sibling helper exists. This models one supported packaging layout.

**Data flow**: The test creates a fake release directory with `codex.exe` and `codex-resources/codex-command-runner.exe`, calls `bundled_executable_path_for_exe`, and asserts that the returned path is the resource-directory helper.

**Call relations**: It exercises one branch of `bundled_executable_path_for_exe`. The test documents expected lookup behavior for packaged releases.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_source_lookup_checks_package_resource_dir_for_bin_exe`  (lines 480–497)

```
fn helper_source_lookup_checks_package_resource_dir_for_bin_exe()
```

**Purpose**: Verifies that when the current executable lives in a `bin` directory, helper lookup checks the package-level `codex-resources` directory one level up. This models another supported packaging layout.

**Data flow**: The test creates `package/bin/codex.exe` and `package/codex-resources/codex-command-runner.exe`, calls `bundled_executable_path_for_exe`, and asserts that the package resource helper is returned.

**Call relations**: It covers the special `bin`-directory branch in `bundled_executable_path_for_exe`. This ensures package layouts with separate `bin` and resource directories resolve correctly.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_source_lookup_prefers_package_resource_dir_over_bin_resource_dir`  (lines 500–520)

```
fn helper_source_lookup_prefers_package_resource_dir_over_bin_resource_dir()
```

**Purpose**: Checks the precedence rule between package-level and bin-local resource directories for executables under `bin`. The package-level resource directory must win.

**Data flow**: The test creates both `package/codex-resources/...` and `package/bin/codex-resources/...` helper files, calls `bundled_executable_path_for_exe` for `package/bin/codex.exe`, and asserts that the package-level helper path is chosen.

**Call relations**: It validates the ordering encoded in `bundled_executable_path_for_exe`. This prevents ambiguous packaging layouts from selecting the wrong helper binary.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_source_lookup_prefers_direct_sibling_over_resource_dir`  (lines 523–540)

```
fn helper_source_lookup_prefers_direct_sibling_over_resource_dir()
```

**Purpose**: Verifies that a helper executable placed directly next to the current executable outranks any helper in a resource directory. This is the highest-precedence lookup rule.

**Data flow**: The test creates a release directory containing `codex.exe`, a sibling `codex-command-runner.exe`, and a `codex-resources` helper, then calls `bundled_executable_path_for_exe` and asserts that the sibling helper path is returned.

**Call relations**: It covers the first branch of helper lookup precedence. This test documents that direct sibling helpers override packaged resource copies.

*Call graph*: calls 1 internal fn (bundled_executable_path_for_exe); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `tests::helper_version_suffix_uses_cli_version_or_dev_build_metadata`  (lines 543–554)

```
fn helper_version_suffix_uses_cli_version_or_dev_build_metadata()
```

**Purpose**: Confirms that helper version suffixing follows the release-vs-dev rule. Release builds use `CARGO_PKG_VERSION`; dev builds use the metadata-derived suffix.

**Data flow**: The test writes a temporary source file, calls `helper_version_suffix`, then compares the result either to `dev_build_suffix(source)` or to `env!("CARGO_PKG_VERSION")` depending on whether the build version equals the development sentinel.

**Call relations**: It directly validates the branching logic in `helper_version_suffix`. This protects the naming scheme that determines whether helpers are recopied after rebuilds.

*Call graph*: calls 1 internal fn (helper_version_suffix); 4 external calls (new, assert_eq!, env!, write).


##### `tests::materialized_file_name_adds_suffix_before_extension`  (lines 557–561)

```
fn materialized_file_name_adds_suffix_before_extension()
```

**Purpose**: Checks the exact filename formatting used for materialized helpers. The suffix must appear between the stem and `.exe` extension.

**Data flow**: The test calls `materialized_file_name(HelperExecutable::CommandRunner, "test-suffix")` and asserts that the returned string is `codex-command-runner-test-suffix.exe`.

**Call relations**: It provides focused coverage for the filename-construction helper. This keeps the on-disk naming convention stable and explicit.

*Call graph*: calls 1 internal fn (materialized_file_name); 1 external calls (assert_eq!).


### Execution environment modeling
These files define how startup environments are provided, selected, validated, and captured for local execution contexts.

### `core/src/shell_snapshot.rs`

`domain_logic` · `environment resolution and local shell snapshot generation; background cleanup`

This file implements a small snapshot subsystem around `ShellSnapshot` and `ShellSnapshotFile`. `ShellSnapshot` is a clonable façade that may be enabled with configuration (`codex_home`, `session_id`, telemetry, optional state DB) or disabled entirely. `build` refuses remote environments, requires a resolved local `Shell`, converts the turn working directory to an `AbsolutePathBuf`, and then delegates to `build_for_cwd`, which wraps creation in a tracing span and emits duration/counter telemetry tagged with success or failure reason.

Actual snapshot creation happens in `try_create`. It chooses a file extension from `ShellType`, generates a nonce-based temp and final path under `shell_snapshots/`, asynchronously launches stale-file cleanup, writes a fresh snapshot script output to the temp file, validates that sourcing the file succeeds, and atomically renames it into place. Failures remove the temp file and return a stable string reason (`write_failed`, `validation_failed`) for telemetry. `ShellSnapshotFile` owns the final path and deletes it on `Drop`, making snapshots ephemeral by default.

The snapshot contents are produced by shell-specific scripts for zsh, bash, sh, and PowerShell. POSIX scripts source startup files, print a `# Snapshot file` marker, clear aliases, dump functions, enabled shell options, aliases, and filtered exports while excluding unstable variables like `PWD` and `OLDPWD` and rejecting invalid environment names. Validation re-sources the generated file in a non-login shell with a timeout. Cleanup scans the snapshot directory, parses session IDs from legacy and nonce-suffixed filenames, preserves the active session, removes malformed/orphaned files, and deletes snapshots whose corresponding rollout file is older than the three-day retention window.

#### Function details

##### `ShellSnapshot::new`  (lines 49–63)

```
fn new(
        codex_home: AbsolutePathBuf,
        session_id: ThreadId,
        session_telemetry: SessionTelemetry,
        state_db: Option<StateDbHandle>,
    ) -> Self
```

**Purpose**: Constructs an enabled snapshot builder with all configuration needed to create and track shell snapshots for a session.

**Data flow**: Consumes `codex_home`, `session_id`, `session_telemetry`, and optional `state_db`; wraps them in `ShellSnapshotConfig` inside an `Arc`; stores that in `config: Some(...)`; returns the new `ShellSnapshot`.

**Call relations**: Called during session/setup orchestration when snapshotting is enabled so later environment resolution can request snapshot files.

*Call graph*: called by 1 (new); 1 external calls (new).


##### `ShellSnapshot::disabled`  (lines 65–67)

```
fn disabled() -> Self
```

**Purpose**: Constructs a no-op snapshot builder that never creates snapshot files.

**Data flow**: Returns `ShellSnapshot { config: None }` with no external effects.

**Call relations**: Used by configuration and tests when shell snapshotting should be skipped; downstream `build` short-circuits on this state.

*Call graph*: called by 7 (latest_environment_update_wins_while_previous_resolution_is_pending, local_environment_uses_configured_shell, resolve_turn_environments, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, resolved_environments_for_configuration).


##### `ShellSnapshot::build`  (lines 69–83)

```
async fn build(
        self,
        environment: TurnEnvironment,
    ) -> Option<Arc<ShellSnapshotFile>>
```

**Purpose**: Attempts to create a snapshot file for a turn environment, but only for local environments with a resolved shell and absolute working directory.

**Data flow**: Consumes `self` and `environment: TurnEnvironment`; reads `self.config`, `environment.environment.is_remote()`, `environment.shell`, and `environment.cwd()`; returns `None` if disabled, remote, shell-less, or cwd conversion fails; otherwise awaits `build_for_cwd` and returns `Option<Arc<ShellSnapshotFile>>`.

**Call relations**: Invoked by environment-resolution code after a turn environment is assembled. It is the gatekeeper that prevents snapshotting for unsupported contexts.

*Call graph*: calls 1 internal fn (cwd); 2 external calls (clone, build_for_cwd).


##### `ShellSnapshot::build_for_cwd`  (lines 85–116)

```
async fn build_for_cwd(
        config: Arc<ShellSnapshotConfig>,
        cwd: AbsolutePathBuf,
        shell: Shell,
    ) -> Option<Arc<ShellSnapshotFile>>
```

**Purpose**: Runs snapshot creation for a specific local cwd under tracing and telemetry instrumentation.

**Data flow**: Takes shared `config`, concrete `cwd`, and `shell`; starts a telemetry timer and tracing span keyed by session/thread id; awaits `try_create`; records duration and counter metrics with success/failure tags; converts a successful `ShellSnapshotFile` into `Arc<ShellSnapshotFile>` and returns it as `Option`.

**Call relations**: Reached only from `ShellSnapshot::build` after environment checks pass. It delegates the filesystem/process work to `try_create` and adds observability around that operation.

*Call graph*: calls 1 internal fn (try_create); 2 external calls (info_span!, vec!).


##### `ShellSnapshot::try_create`  (lines 118–178)

```
async fn try_create(
        codex_home: &AbsolutePathBuf,
        session_id: ThreadId,
        session_cwd: &AbsolutePathBuf,
        shell: &Shell,
        state_db: Option<StateDbHandle>,
    ) ->
```

**Purpose**: Creates one snapshot file on disk using a temp path, validates it, schedules stale cleanup, and finalizes it with an atomic rename.

**Data flow**: Reads `codex_home`, `session_id`, `session_cwd`, `shell`, and optional `state_db`; derives extension (`sh` or `ps1`), nonce, temp/final paths; spawns `cleanup_stale_snapshots`; awaits `write_shell_snapshot`; on success validates by sourcing the temp file; renames temp to final path; returns `Result<ShellSnapshotFile, &'static str>` with stable error codes and removes temp files on failure.

**Call relations**: Called from `build_for_cwd` and directly by tests. It orchestrates the full snapshot lifecycle and delegates content generation, validation, and cleanup helpers.

*Call graph*: calls 5 internal fn (cleanup_stale_snapshots, remove_snapshot_file, validate_snapshot, write_shell_snapshot, join); called by 3 (build_for_cwd, try_create_creates_and_deletes_snapshot_file, try_create_uses_distinct_generation_paths); 8 external calls (now, format!, rename, spawn, error!, info!, warn!, clone).


##### `ShellSnapshotFile::path`  (lines 182–184)

```
fn path(&self) -> AbsolutePathBuf
```

**Purpose**: Returns a clone of the owned absolute path to the snapshot file.

**Data flow**: Reads `self.path`, clones it, and returns the cloned `AbsolutePathBuf`.

**Call relations**: Used by callers that need to pass the snapshot file path onward without taking ownership of the `ShellSnapshotFile` guard.

*Call graph*: 1 external calls (clone).


##### `ShellSnapshotFile::drop`  (lines 188–195)

```
fn drop(&mut self)
```

**Purpose**: Deletes the snapshot file from disk when the owning guard is dropped.

**Data flow**: On drop, calls synchronous `std::fs::remove_file(&self.path)`; logs a warning if deletion fails; does not return a value.

**Call relations**: Runs automatically at the end of the snapshot file's lifetime, enforcing the design that snapshots are temporary artifacts tied to an owning handle.

*Call graph*: 2 external calls (remove_file, warn!).


##### `write_shell_snapshot`  (lines 198–225)

```
async fn write_shell_snapshot(
    shell_type: ShellType,
    output_path: &AbsolutePathBuf,
    cwd: &AbsolutePathBuf,
) -> Result<()>
```

**Purpose**: Generates snapshot text for a shell, strips any startup noise before the marker, ensures the destination directory exists, and writes the cleaned snapshot file.

**Data flow**: Consumes `shell_type`, `output_path`, and `cwd`; rejects `PowerShell` and `Cmd` immediately as unsupported for file creation; resolves a concrete shell via `get_shell`; awaits `capture_snapshot`; passes stdout through `strip_snapshot_preamble`; creates parent directories if needed; writes the final text to `output_path`; returns `anyhow::Result<()>`.

**Call relations**: Called only by `try_create`. It bridges shell execution output into a persisted snapshot file and is where unsupported shell types are rejected.

*Call graph*: calls 5 internal fn (get_shell, capture_snapshot, strip_snapshot_preamble, display, parent); called by 1 (try_create); 3 external calls (bail!, create_dir_all, write).


##### `capture_snapshot`  (lines 227–236)

```
async fn capture_snapshot(shell: &Shell, cwd: &AbsolutePathBuf) -> Result<String>
```

**Purpose**: Selects the shell-specific snapshot script and executes it in the target working directory.

**Data flow**: Reads `shell.shell_type`; chooses one of `zsh_snapshot_script`, `bash_snapshot_script`, `sh_snapshot_script`, or `powershell_snapshot_script`; passes the script to `run_shell_script`; returns the captured stdout as `Result<String>`. `Cmd` returns an error immediately.

**Call relations**: Used by `write_shell_snapshot` after a concrete shell executable has been resolved. It isolates shell-type dispatch from the rest of snapshot creation.

*Call graph*: calls 5 internal fn (bash_snapshot_script, powershell_snapshot_script, run_shell_script, sh_snapshot_script, zsh_snapshot_script); called by 1 (write_shell_snapshot); 1 external calls (bail!).


##### `strip_snapshot_preamble`  (lines 238–245)

```
fn strip_snapshot_preamble(snapshot: &str) -> Result<String>
```

**Purpose**: Removes any leading shell startup noise and keeps only the snapshot content beginning at the required marker line.

**Data flow**: Scans `snapshot: &str` for the substring `# Snapshot file`; if found, returns `snapshot[start..].to_string()`; otherwise returns an error via `bail!`.

**Call relations**: Called by `write_shell_snapshot` because login shells may emit prompts or other startup output before the generated snapshot body.

*Call graph*: called by 1 (write_shell_snapshot); 1 external calls (bail!).


##### `validate_snapshot`  (lines 247–263)

```
async fn validate_snapshot(
    shell: &Shell,
    snapshot_path: &AbsolutePathBuf,
    cwd: &AbsolutePathBuf,
) -> Result<()>
```

**Purpose**: Checks that the generated snapshot file can be sourced successfully by the target shell within the timeout budget.

**Data flow**: Builds a script `set -e; . "<snapshot_path>"` from `snapshot_path.display()`; calls `run_script_with_timeout` with `use_login_shell = false`; maps successful stdout to `()` and propagates errors.

**Call relations**: Invoked by `try_create` after writing the temp file and before renaming it into place, preventing invalid snapshot files from being finalized.

*Call graph*: calls 2 internal fn (run_script_with_timeout, display); called by 1 (try_create); 1 external calls (format!).


##### `run_shell_script`  (lines 265–274)

```
async fn run_shell_script(shell: &Shell, script: &str, cwd: &AbsolutePathBuf) -> Result<String>
```

**Purpose**: Runs a shell script using login-shell startup behavior and the standard snapshot timeout.

**Data flow**: Takes `shell`, `script`, and `cwd`; forwards them to `run_script_with_timeout` with `SNAPSHOT_TIMEOUT` and `use_login_shell = true`; returns the captured stdout string.

**Call relations**: Used by `capture_snapshot` so snapshot scripts execute in the same startup mode expected for environment capture.

*Call graph*: calls 1 internal fn (run_script_with_timeout); called by 1 (capture_snapshot).


##### `run_script_with_timeout`  (lines 276–312)

```
async fn run_script_with_timeout(
    shell: &Shell,
    script: &str,
    snapshot_timeout: Duration,
    use_login_shell: bool,
    cwd: &AbsolutePathBuf,
) -> Result<String>
```

**Purpose**: Executes a shell command with controlled stdio, cwd, timeout, and Unix process-group detachment, then returns stdout or a detailed error.

**Data flow**: Consumes `shell`, `script`, `snapshot_timeout`, `use_login_shell`, and `cwd`; derives argv via `shell.derive_exec_args`; builds a `tokio::process::Command`; sets stdin to null, cwd, Unix `pre_exec` detachment, and `kill_on_drop(true)`; awaits `handler.output()` under `tokio::time::timeout`; on timeout or spawn failure returns contextual errors; on non-zero exit includes status and stderr; on success returns UTF-8-lossy stdout as `String`.

**Call relations**: Shared by `run_shell_script` and `validate_snapshot`. It is the low-level execution primitive for all snapshot-related shell subprocesses.

*Call graph*: calls 2 internal fn (derive_exec_args, name); called by 2 (run_shell_script, validate_snapshot); 5 external calls (null, from_utf8_lossy, bail!, new, timeout).


##### `excluded_exports_regex`  (lines 314–316)

```
fn excluded_exports_regex() -> String
```

**Purpose**: Builds the alternation pattern used inside generated shell scripts to skip unstable exported variables.

**Data flow**: Reads the static `EXCLUDED_EXPORT_VARS` slice and joins it with `|`; returns the resulting `String`.

**Call relations**: Called by the POSIX snapshot script generators to splice the exclusion list into embedded shell/awk code.

*Call graph*: called by 3 (bash_snapshot_script, sh_snapshot_script, zsh_snapshot_script).


##### `zsh_snapshot_script`  (lines 318–360)

```
fn zsh_snapshot_script() -> String
```

**Purpose**: Generates the zsh script that sources `.zshrc` and prints a replayable snapshot of functions, options, aliases, and filtered exports.

**Data flow**: Calls `excluded_exports_regex()`; interpolates the resulting pattern into a raw zsh script string; returns the final `String`.

**Call relations**: Selected by `capture_snapshot` when the shell type is `Zsh`.

*Call graph*: calls 1 internal fn (excluded_exports_regex); called by 1 (capture_snapshot).


##### `bash_snapshot_script`  (lines 362–402)

```
fn bash_snapshot_script() -> String
```

**Purpose**: Generates the bash script that sources `.bashrc` when appropriate and emits replayable shell state, preserving multiline exports and filtering invalid names.

**Data flow**: Calls `excluded_exports_regex()`; substitutes the exclusion pattern into a raw bash script template; returns the completed `String`.

**Call relations**: Selected by `capture_snapshot` for `Bash`; tests specifically exercise its export filtering and multiline-value behavior.

*Call graph*: calls 1 internal fn (excluded_exports_regex); called by 1 (capture_snapshot).


##### `sh_snapshot_script`  (lines 404–470)

```
fn sh_snapshot_script() -> String
```

**Purpose**: Generates a portable `sh` snapshot script that tolerates missing shell features and falls back to `env` when `export -p` is unavailable.

**Data flow**: Calls `excluded_exports_regex()`; injects the exclusion pattern into a raw POSIX shell script; returns the resulting `String`.

**Call relations**: Selected by `capture_snapshot` for `Sh`, covering the least-capable POSIX shell path.

*Call graph*: calls 1 internal fn (excluded_exports_regex); called by 1 (capture_snapshot).


##### `powershell_snapshot_script`  (lines 472–495)

```
fn powershell_snapshot_script() -> &'static str
```

**Purpose**: Returns the PowerShell script text that emits functions, aliases, and environment variables in replayable form.

**Data flow**: Returns a static `&'static str` script literal; no inputs or mutable state.

**Call relations**: Selected by `capture_snapshot` for `PowerShell`, though file-based snapshot creation currently rejects PowerShell earlier in `write_shell_snapshot`.

*Call graph*: called by 1 (capture_snapshot).


##### `cleanup_stale_snapshots`  (lines 500–561)

```
async fn cleanup_stale_snapshots(
    codex_home: &AbsolutePathBuf,
    active_session_id: ThreadId,
    state_db: Option<StateDbHandle>,
) -> Result<()>
```

**Purpose**: Scans the snapshot directory and removes malformed, orphaned, or expired snapshot files while preserving the active session's snapshots.

**Data flow**: Reads `codex_home`, `active_session_id`, and optional `state_db`; opens `codex_home/shell_snapshots`; returns early if the directory is absent; iterates files, parses session ids with `snapshot_session_id_from_file_name`, skips non-files and active-session files, resolves rollout paths via `find_thread_path_by_id_str`, removes files with no matching rollout, checks rollout modification time, and removes snapshots whose rollout age exceeds `SNAPSHOT_RETENTION`; returns `Result<()>`.

**Call relations**: Spawned asynchronously by `try_create` so cleanup does not block snapshot creation. It depends on rollout discovery to decide whether a snapshot still belongs to a live or recently active session.

*Call graph*: calls 4 internal fn (remove_snapshot_file, snapshot_session_id_from_file_name, find_thread_path_by_id_str, join); called by 1 (try_create); 5 external calls (now, metadata, read_dir, to_string, warn!).


##### `remove_snapshot_file`  (lines 563–567)

```
async fn remove_snapshot_file(path: &Path)
```

**Purpose**: Best-effort asynchronous deletion helper for snapshot files with warning-only failure handling.

**Data flow**: Consumes `path: &Path`; awaits `fs::remove_file(path)`; logs a warning if deletion fails; returns `()`.

**Call relations**: Used by both `try_create` and `cleanup_stale_snapshots` to centralize deletion behavior and warning logging.

*Call graph*: called by 2 (try_create, cleanup_stale_snapshots); 2 external calls (remove_file, warn!).


##### `snapshot_session_id_from_file_name`  (lines 569–579)

```
fn snapshot_session_id_from_file_name(file_name: &str) -> Option<&str>
```

**Purpose**: Extracts the session id portion from supported snapshot filenames, including legacy names, nonce-suffixed names, and temp files.

**Data flow**: Parses `file_name: &str` by splitting on the last `.`; for `sh` and `ps1` extensions returns the stem before any generation suffix; for `tmp-*` extensions returns the stem directly; otherwise returns `None`.

**Call relations**: Called by `cleanup_stale_snapshots` to decide whether a file belongs to a session snapshot and which session it should be associated with.

*Call graph*: called by 1 (cleanup_stale_snapshots).


### `exec-server/src/environment.rs`

`domain_logic` · `startup / environment selection / session setup`

This file is the core environment registry and environment object model. `EnvironmentManager` owns a `RwLock<HashMap<String, Arc<Environment>>>`, an optional default environment id, an optional cached local environment, and optional `ExecServerRuntimePaths` needed for local sandbox-aware filesystem helpers. Its constructors cover several sources: test defaults, an empty manager, legacy `CODEX_EXEC_SERVER_URL`, and provider snapshots loaded from config. The central `from_snapshot` routine enforces invariants that are easy to miss: environment ids cannot be empty, provider-supplied `local` is forbidden because that id is reserved, duplicates are rejected, and a configured default must refer to an actually present environment. If `include_local` is true, local runtime paths are mandatory.

`Environment` itself bundles metadata and backend implementations: optional `exec_server_url`, optional `ExecServerTransportParams`, an `EnvironmentInfoProvider`, an `ExecBackend`, an `ExecutorFileSystem`, an `HttpClient`, and optional local runtime paths. Local environments use `LocalProcess`, `LocalFileSystem::with_runtime_paths`, and a trivial info provider that returns `EnvironmentInfo::local()` without network access. Remote environments are intentionally lazy: `remote_with_transport` constructs a `LazyRemoteExecServerClient`, then wraps it in `RemoteProcess`, `RemoteFileSystem`, and `RemoteEnvironmentInfoProvider`, but does not connect until one of those components is used.

The file also supports dynamic insertion of remote environments after startup. `upsert_environment` normalizes and validates a URL-backed remote environment, while `upsert_noise_environment` creates an authenticated rendezvous transport with a freshly generated `NoiseChannelIdentity`. Tests emphasize pointer stability for cached environments, disabled/default semantics, local-runtime-path propagation, and the fact that local environments do not eagerly connect anywhere.

#### Function details

##### `EnvironmentManager::default_for_tests`  (lines 61–71)

```
fn default_for_tests() -> Self
```

**Purpose**: Builds a minimal manager containing only a local test environment and marks it as the default.

**Data flow**: Creates two `Arc<Environment::default_for_tests()>` values, stores one in the `environments` map under `local`, stores one in `local_environment`, sets `default_environment` to `Some("local")`, and leaves `local_runtime_paths` unset.

**Call relations**: Used broadly by tests that need a ready local environment without filesystem sandbox helper paths; it bypasses provider loading entirely.

*Call graph*: calls 1 internal fn (default_for_tests); called by 73 (runtime_start_args_use_remote_thread_config_loader_when_configured, start_test_client_with_capacity, guardian_command_execution_notifications_wrap_review_lifecycle, interrupted_subagent_activity_removes_missing_thread_watch, turn_started_omits_active_snapshot_items, start_test_client_with_capacity, refresh_test_state, build_test_processor, get_conversation_summary_by_thread_id_reads_pathless_store_thread, mcp_resource_read_returns_error_for_unknown_thread (+15 more)); 3 external calls (new, from, new).


##### `EnvironmentManager::without_environments`  (lines 74–81)

```
fn without_environments() -> Self
```

**Purpose**: Constructs a manager with no default, no local environment, and an empty registry.

**Data flow**: Initializes `default_environment` and `local_environment` to `None`, creates an empty `RwLock<HashMap<...>>`, and sets `local_runtime_paths` to `None`.

**Call relations**: Used by tests and code paths that need to model disabled environment access or start from an empty registry before upserts.

*Call graph*: called by 10 (no_local_runtime_fails_local_stdio_but_keeps_local_http_server, local_http_does_not_require_local_stdio_availability, local_stdio_requires_local_stdio_availability, unknown_explicit_environment_is_rejected, unavailable_environment_does_not_fall_back_to_host_filesystem, default_thread_environment_selections_empty_when_default_disabled, disabled_environment_manager_has_no_default_or_local_environment, environment_manager_rejects_empty_remote_environment_url, environment_manager_upserts_named_remote_environment, noise_environment_refreshes_bundle_for_each_connection_attempt); 2 external calls (new, new).


##### `EnvironmentManager::create_for_tests`  (lines 84–89)

```
async fn create_for_tests(
        exec_server_url: Option<String>,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Self
```

**Purpose**: Builds a test manager from a raw exec-server URL value using the same legacy-provider logic as production.

**Data flow**: Accepts an optional URL string and optional runtime paths → awaits `from_default_provider_url` → returns the resulting manager.

**Call relations**: Thin async wrapper used by many tests to exercise default-provider behavior without reading process environment variables.

*Call graph*: called by 12 (runtime_start_args_forward_environment_manager, explicit_remote_stdio_and_http_accept_named_environment, remote_stdio_requires_absolute_cwd, default_thread_environment_selections_use_manager_default_id, matching_environment_id_and_cwd_reuse_resolved_environment, build_with_home_and_base_url, environment_manager_carries_local_runtime_paths, environment_manager_includes_local_for_default_provider_without_url, environment_manager_normalizes_empty_url, environment_manager_omits_default_provider_local_lookup_when_default_disabled (+2 more)); 1 external calls (from_default_provider_url).


##### `EnvironmentManager::from_codex_home`  (lines 97–103)

```
async fn from_codex_home(
        codex_home: impl AsRef<std::path::Path>,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Loads environment configuration from `CODEX_HOME`, preferring `environments.toml` when present and otherwise falling back to legacy environment-variable behavior.

**Data flow**: Takes a filesystem path and optional runtime paths → builds an `EnvironmentProvider` via `environment_provider_from_codex_home`, awaits its snapshot, then validates/builds the manager with `from_snapshot`.

**Call relations**: Used by top-level startup flows; it delegates config-source selection to `environment_toml.rs` and structural validation to `from_snapshot`.

*Call graph*: calls 1 internal fn (environment_provider_from_codex_home); called by 8 (run_main_with_transport_options, list_accessible_connectors_from_mcp_tools_with_options_and_status, toml_default_thread_environment_selections_include_local_and_remote, build_prompt_input, run_main, run_main, run_main, run_main); 2 external calls (as_ref, from_snapshot).


##### `EnvironmentManager::from_env`  (lines 107–112)

```
async fn from_env(
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Builds a manager directly from the legacy `CODEX_EXEC_SERVER_URL` provider without consulting config files.

**Data flow**: Creates `DefaultEnvironmentProvider::from_env()`, awaits its snapshot, and passes the snapshot plus optional runtime paths into `from_snapshot`.

**Call relations**: Used by startup paths that intentionally skip `CODEX_HOME` config discovery.

*Call graph*: calls 1 internal fn (from_env); called by 4 (run_main_with_transport_options, run_main, run_main, start_app_server_for_archive_command); 1 external calls (from_snapshot).


##### `EnvironmentManager::from_default_provider_url`  (lines 114–123)

```
async fn from_default_provider_url(
        exec_server_url: Option<String>,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Self
```

**Purpose**: Internal helper that runs the default provider against an explicit raw URL value and assumes the resulting snapshot is always valid.

**Data flow**: Constructs `DefaultEnvironmentProvider::new(exec_server_url)`, obtains its synchronous `snapshot_inner()`, feeds that into `from_snapshot`, and either returns the manager or panics if validation somehow fails.

**Call relations**: Used only by test-oriented constructors; it centralizes the legacy-provider path without async provider boxing.

*Call graph*: calls 1 internal fn (new); 2 external calls (from_snapshot, panic!).


##### `EnvironmentManager::create_for_tests_with_local`  (lines 127–137)

```
async fn create_for_tests_with_local(
        exec_server_url: Option<String>,
        local_runtime_paths: ExecServerRuntimePaths,
    ) -> Self
```

**Purpose**: Builds a test manager from the default provider while forcibly including the local environment alongside whatever default the provider would choose.

**Data flow**: Creates a default-provider snapshot from the raw URL, mutates `snapshot.include_local = true`, then validates/builds via `from_snapshot`, panicking on unexpected validation failure.

**Call relations**: Used by tests that need both provider-driven remote configuration and explicit access to the local environment.

*Call graph*: calls 1 internal fn (new); called by 2 (latest_environment_update_wins_while_previous_resolution_is_pending, build_with_home_and_base_url); 2 external calls (from_snapshot, panic!).


##### `EnvironmentManager::from_snapshot`  (lines 139–202)

```
fn from_snapshot(
        snapshot: EnvironmentProviderSnapshot,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Validates a provider snapshot and turns it into the manager’s canonical environment registry and default selection.

**Data flow**: Consumes `EnvironmentProviderSnapshot { environments, default, include_local }` plus optional runtime paths → preallocates a map, optionally creates and inserts a local environment (requiring runtime paths), iterates provider environments rejecting empty ids, reserved `local`, and duplicates, then resolves `EnvironmentDefault` into `Option<String>` while rejecting unknown defaults → returns a fully initialized `EnvironmentManager` or `ExecServerError::Protocol`.

**Call relations**: This is the central constructor used by provider-based startup paths and many tests; all provider snapshots flow through its validation rules.

*Call graph*: calls 1 internal fn (local); called by 7 (environment_manager_builds_from_snapshot, environment_manager_disables_provider_default, environment_manager_rejects_empty_environment_id, environment_manager_rejects_provider_supplied_local_environment, environment_manager_rejects_unknown_provider_default, environment_manager_snapshot_without_local_environment_disables_local_default, environment_manager_uses_explicit_provider_default); 7 external calls (clone, new, with_capacity, new, Protocol, format!, from).


##### `EnvironmentManager::default_environment`  (lines 205–209)

```
fn default_environment(&self) -> Option<Arc<Environment>>
```

**Purpose**: Returns the current default environment instance, if one is configured.

**Data flow**: Reads `self.default_environment`, converts it to `&str`, looks up that id through `get_environment`, and returns a cloned `Arc<Environment>` or `None`.

**Call relations**: Used by callers that need the actual environment object rather than just the id; `default_or_local_environment` builds on it.

*Call graph*: called by 2 (default_or_local_environment, config_cwd_for_app_server_target).


##### `EnvironmentManager::default_environment_id`  (lines 212–214)

```
fn default_environment_id(&self) -> Option<&str>
```

**Purpose**: Exposes the configured default environment id as a borrowed string slice.

**Data flow**: Reads `self.default_environment` and returns `Option<&str>` via `as_deref()`.

**Call relations**: Used by selection and startup logic that only needs the identifier.


##### `EnvironmentManager::default_environment_ids`  (lines 217–234)

```
fn default_environment_ids(&self) -> Vec<String>
```

**Purpose**: Returns environment ids ordered for thread startup, with the default first and all other configured environments following in map iteration order.

**Data flow**: If no default exists, returns an empty `Vec`; otherwise reads the environment map under the lock, allocates a vector sized to the map, pushes the default id first, then extends it with all other keys except the default.

**Call relations**: Used by thread-startup selection logic to seed environment preference order.

*Call graph*: called by 1 (default_thread_environment_selections); 2 external calls (new, with_capacity).


##### `EnvironmentManager::try_local_environment`  (lines 237–239)

```
fn try_local_environment(&self) -> Option<Arc<Environment>>
```

**Purpose**: Returns the explicitly configured local environment, if one exists.

**Data flow**: Reads `self.local_environment` and clones the stored `Arc<Environment>` when present.

**Call relations**: Used by callers that specifically want host-local execution/filesystem access rather than the provider default.


##### `EnvironmentManager::default_or_local_environment`  (lines 242–245)

```
fn default_or_local_environment(&self) -> Option<Arc<Environment>>
```

**Purpose**: Returns the default environment if configured, otherwise falls back to the local environment if available.

**Data flow**: Calls `default_environment()` and, if that yields `None`, calls `try_local_environment()` → returns the first available `Arc<Environment>`.

**Call relations**: Provides the common fallback policy for code that can operate with either a configured default or local host access.

*Call graph*: calls 1 internal fn (default_environment).


##### `EnvironmentManager::get_environment`  (lines 248–254)

```
fn get_environment(&self, environment_id: &str) -> Option<Arc<Environment>>
```

**Purpose**: Looks up a named environment by id from the registry.

**Data flow**: Acquires a read lock on `self.environments`, recovers from poisoning with `into_inner`, clones the `Arc<Environment>` for the requested key if present, and returns it.

**Call relations**: Used by selection logic and by `default_environment`; it is the direct map access point.

*Call graph*: called by 1 (resolve_selection).


##### `EnvironmentManager::upsert_environment`  (lines 258–286)

```
fn upsert_environment(
        &self,
        environment_id: String,
        exec_server_url: String,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Adds or replaces a named URL-backed remote environment without changing the manager’s default selection.

**Data flow**: Validates that `environment_id` is non-empty, normalizes the supplied URL with `normalize_exec_server_url`, rejects disabled mode and missing URLs, constructs `Environment::remote_inner(exec_server_url, self.local_runtime_paths.clone())`, and inserts a new `Arc<Environment>` into the write-locked map.

**Call relations**: Used by dynamic configuration/update flows; it reuses the same URL normalization rules as the default provider and environment constructors.

*Call graph*: calls 2 internal fn (remote_inner, normalize_exec_server_url); 2 external calls (new, Protocol).


##### `EnvironmentManager::upsert_noise_environment`  (lines 293–317)

```
fn upsert_noise_environment(
        &self,
        environment_id: String,
        provider: Arc<dyn NoiseRendezvousConnectProvider>,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Adds or replaces a named remote environment that connects through a Noise-authenticated rendezvous transport.

**Data flow**: Validates non-empty `environment_id`, generates a fresh `NoiseChannelIdentity`, wraps the supplied provider and identity in `ExecServerTransportParams::NoiseRendezvous`, constructs `Environment::remote_with_transport(..., self.local_runtime_paths.clone())`, and inserts it into the registry.

**Call relations**: Used when dynamic remote environments must use authenticated rendezvous rather than plain URL transport; it delegates backend construction to `Environment::remote_with_transport`.

*Call graph*: calls 2 internal fn (remote_with_transport, generate); 2 external calls (new, Protocol).


##### `LocalEnvironmentInfoProvider::info`  (lines 343–345)

```
fn info(&self) -> BoxFuture<'_, Result<EnvironmentInfo, ExecServerError>>
```

**Purpose**: Returns local environment metadata immediately without any I/O.

**Data flow**: Constructs `EnvironmentInfo::local()`, wraps it in `Ok(...)`, then in a ready boxed future.

**Call relations**: Installed into local and test environments as the metadata provider consumed by `Environment::info`.

*Call graph*: 2 external calls (local, ready).


##### `RemoteEnvironmentInfoProvider::new`  (lines 353–355)

```
fn new(client: LazyRemoteExecServerClient) -> Self
```

**Purpose**: Creates the remote metadata provider around a lazy remote exec-server client.

**Data flow**: Takes a `LazyRemoteExecServerClient` and stores it in the provider struct.

**Call relations**: Called only from `Environment::remote_with_transport` when assembling a remote environment.

*Call graph*: called by 1 (remote_with_transport).


##### `RemoteEnvironmentInfoProvider::info`  (lines 359–361)

```
fn info(&self) -> BoxFuture<'_, Result<EnvironmentInfo, ExecServerError>>
```

**Purpose**: Fetches environment metadata from the remote exec-server on demand.

**Data flow**: Borrows `self.client`, awaits `environment_info()`, and returns the resulting `Result<EnvironmentInfo, ExecServerError>` boxed as a future.

**Call relations**: Used by `Environment::info` for remote environments; unlike the local provider, this may trigger lazy connection establishment.

*Call graph*: calls 1 internal fn (environment_info).


##### `Environment::default_for_tests`  (lines 366–376)

```
fn default_for_tests() -> Self
```

**Purpose**: Builds a local environment suitable for tests, with unsandboxed filesystem access and no configured runtime helper paths.

**Data flow**: Creates an `Environment` with `exec_server_url` and `remote_transport` set to `None`, `LocalEnvironmentInfoProvider`, `LocalProcess::default()`, `LocalFileSystem::unsandboxed()`, `ReqwestHttpClient`, and `local_runtime_paths: None`.

**Call relations**: Used by test managers and direct tests that need a local executor/filesystem without sandbox helper setup.

*Call graph*: calls 2 internal fn (unsandboxed, default); called by 12 (shell_mode_for_environment_uses_direct_mode_for_remote_environments, test_turn_environment, test_turn_environment, completed_pipe_commands_preserve_exit_code, default_for_tests, default_environment_has_ready_local_executor, test_environment_rejects_sandboxed_filesystem_without_runtime_paths, remote_environment_fetches_info_from_exec_server, oauth_startup_child, streamable_http_initialize_retries_remote_no_response_error (+2 more)); 1 external calls (new).


##### `Environment::fmt`  (lines 380–384)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a non-exhaustive debug representation that exposes only the remote URL field.

**Data flow**: Writes a `DebugStruct("Environment")`, includes `exec_server_url`, marks it non-exhaustive, and returns the formatter result.

**Call relations**: Supports diagnostics without dumping backend internals or trait-object fields.

*Call graph*: 1 external calls (debug_struct).


##### `Environment::create`  (lines 389–394)

```
fn create(
        exec_server_url: Option<String>,
        local_runtime_paths: ExecServerRuntimePaths,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Builds an environment from a raw legacy exec-server URL plus required local runtime paths.

**Data flow**: Forwards the optional URL and `Some(local_runtime_paths)` into `create_inner` and returns its validated result.

**Call relations**: Used by production-style callers that want one environment object rather than a manager.

*Call graph*: called by 1 (create_local_environment_does_not_connect); 1 external calls (create_inner).


##### `Environment::create_for_tests`  (lines 397–399)

```
fn create_for_tests(exec_server_url: Option<String>) -> Result<Self, ExecServerError>
```

**Purpose**: Builds an environment from a raw legacy exec-server URL without requiring local runtime paths.

**Data flow**: Forwards the optional URL and `None` runtime paths into `create_inner` and returns the result.

**Call relations**: Used by tests that need either a remote environment shell or a local test environment without sandbox helper configuration.

*Call graph*: called by 10 (single_local_environment_cwd_requires_exactly_one_local_environment, shell_mode_for_environment_uses_direct_mode_for_remote_environments, local, test_env, wait_for_remote_streamable_http_server, create_process_context, connect_file_system, create_file_system_context, sandboxed_file_system_helper_finds_bwrap_on_preserved_path, remote_environment_fetches_info_from_exec_server); 1 external calls (create_inner).


##### `Environment::create_inner`  (lines 403–421)

```
fn create_inner(
        exec_server_url: Option<String>,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Implements the shared legacy URL interpretation for environment construction, including disabled mode and local fallback.

**Data flow**: Normalizes the optional URL with `normalize_exec_server_url` → returns a protocol error if disabled mode was requested, otherwise constructs `remote_inner` when a URL remains, `local` when runtime paths are available and no URL is set, or `default_for_tests` when neither is present.

**Call relations**: Shared by `create` and `create_for_tests`; it mirrors the default provider’s URL semantics at the single-environment level.

*Call graph*: calls 1 internal fn (normalize_exec_server_url); 4 external calls (default_for_tests, local, remote_inner, Protocol).


##### `Environment::local`  (lines 423–435)

```
fn local(local_runtime_paths: ExecServerRuntimePaths) -> Self
```

**Purpose**: Builds a fully configured local environment with runtime paths available for sandbox-aware filesystem helpers.

**Data flow**: Consumes `ExecServerRuntimePaths` → creates an environment with local info provider, `LocalProcess::default()`, `LocalFileSystem::with_runtime_paths(local_runtime_paths.clone())`, `ReqwestHttpClient`, and stores `Some(local_runtime_paths)`.

**Call relations**: Used by `EnvironmentManager::from_snapshot` when `include_local` is true and by `create_inner` when no remote URL is configured.

*Call graph*: calls 2 internal fn (with_runtime_paths, default); called by 1 (from_snapshot); 2 external calls (new, clone).


##### `Environment::remote_inner`  (lines 437–445)

```
fn remote_inner(
        exec_server_url: String,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Self
```

**Purpose**: Builds a remote environment from a plain WebSocket URL.

**Data flow**: Wraps the URL in `ExecServerTransportParams::websocket_url(exec_server_url)` and forwards it plus optional runtime paths to `remote_with_transport`.

**Call relations**: Used by the default provider, manager upsert logic, and single-environment constructors for URL-backed remotes.

*Call graph*: calls 1 internal fn (websocket_url); called by 2 (upsert_environment, snapshot_inner); 1 external calls (remote_with_transport).


##### `Environment::remote_with_transport`  (lines 447–473)

```
fn remote_with_transport(
        remote_transport: ExecServerTransportParams,
        local_runtime_paths: Option<ExecServerRuntimePaths>,
    ) -> Self
```

**Purpose**: Builds a remote environment around an arbitrary transport description while keeping all remote backends lazily connected.

**Data flow**: Takes `ExecServerTransportParams` and optional runtime paths → derives `exec_server_url` only for `WebSocketUrl` transports, creates one `LazyRemoteExecServerClient`, wraps clones of it in `RemoteProcess`, `RemoteFileSystem`, `RemoteEnvironmentInfoProvider`, and also stores it as the `HttpClient` implementation → returns the assembled `Environment` with `remote_transport: Some(...)`.

**Call relations**: Used by URL-backed remotes, Noise rendezvous remotes, and TOML-configured environments; it is the canonical remote-environment constructor.

*Call graph*: calls 4 internal fn (new, new, new, new); called by 2 (upsert_noise_environment, snapshot); 2 external calls (new, clone).


##### `Environment::is_remote`  (lines 475–477)

```
fn is_remote(&self) -> bool
```

**Purpose**: Reports whether this environment uses any remote transport.

**Data flow**: Checks whether `self.remote_transport` is `Some` and returns the boolean.

**Call relations**: Used by session-opening and shell-mode logic to branch between local and remote behavior.

*Call graph*: called by 2 (shell_mode_for_environment, open_session_with_exec_env).


##### `Environment::exec_server_url`  (lines 480–482)

```
fn exec_server_url(&self) -> Option<&str>
```

**Purpose**: Returns the stored remote exec-server URL for URL-backed remote environments.

**Data flow**: Reads `self.exec_server_url` and returns `Option<&str>` via `as_deref()`.

**Call relations**: Used by diagnostics and tests; Noise and stdio transports intentionally report `None`.


##### `Environment::local_runtime_paths`  (lines 484–486)

```
fn local_runtime_paths(&self) -> Option<&ExecServerRuntimePaths>
```

**Purpose**: Exposes the runtime helper paths associated with this environment, when present.

**Data flow**: Returns `self.local_runtime_paths.as_ref()`.

**Call relations**: Used by code and tests that need to know whether sandboxed local filesystem helpers can be launched.


##### `Environment::info`  (lines 489–491)

```
async fn info(&self) -> Result<EnvironmentInfo, ExecServerError>
```

**Purpose**: Fetches environment metadata from the configured info provider.

**Data flow**: Calls `self.info_provider.info().await` and returns the resulting `EnvironmentInfo` or `ExecServerError`.

**Call relations**: Abstracts over local immediate metadata and remote RPC-backed metadata.


##### `Environment::get_exec_backend`  (lines 493–495)

```
fn get_exec_backend(&self) -> Arc<dyn ExecBackend>
```

**Purpose**: Returns the execution backend trait object for this environment.

**Data flow**: Clones and returns `Arc<dyn ExecBackend>` from `self.exec_backend`.

**Call relations**: Used when opening sessions or starting processes in the selected environment.

*Call graph*: called by 1 (open_session_with_exec_env); 1 external calls (clone).


##### `Environment::get_http_client`  (lines 497–499)

```
fn get_http_client(&self) -> Arc<dyn HttpClient>
```

**Purpose**: Returns the HTTP client trait object associated with this environment.

**Data flow**: Clones and returns `Arc<dyn HttpClient>` from `self.http_client`.

**Call relations**: Used by callers that need environment-scoped HTTP access, especially remote environments backed by the lazy client.

*Call graph*: 1 external calls (clone).


##### `Environment::get_filesystem`  (lines 501–503)

```
fn get_filesystem(&self) -> Arc<dyn ExecutorFileSystem>
```

**Purpose**: Returns the filesystem backend trait object for this environment.

**Data flow**: Clones and returns `Arc<dyn ExecutorFileSystem>` from `self.filesystem`.

**Call relations**: Used by filesystem operations after environment selection.

*Call graph*: 1 external calls (clone).


##### `EnvironmentInfo::local`  (lines 507–511)

```
fn local() -> Self
```

**Purpose**: Constructs local environment metadata using the detected default user shell.

**Data flow**: Calls `codex_shell_command::shell_detect::default_user_shell()`, converts it into `ShellInfo`, and returns `EnvironmentInfo { shell }`.

**Call relations**: Used by `LocalEnvironmentInfoProvider::info` to avoid any remote call.

*Call graph*: calls 1 internal fn (default_user_shell).


##### `ShellInfo::from`  (lines 515–520)

```
fn from(shell: DetectedShell) -> Self
```

**Purpose**: Converts a detected shell description into the protocol-facing `ShellInfo` structure.

**Data flow**: Takes `DetectedShell`, reads its display name and `shell_path`, converts both to owned strings, and returns `ShellInfo { name, path }`.

**Call relations**: Used by `EnvironmentInfo::local` when packaging shell detection results.

*Call graph*: calls 1 internal fn (name).


##### `tests::test_runtime_paths`  (lines 538–544)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Builds `ExecServerRuntimePaths` for tests from the current executable.

**Data flow**: Reads `std::env::current_exe()`, passes it with no Linux sandbox helper path into `ExecServerRuntimePaths::new`, and returns the validated paths.

**Call relations**: Shared helper for tests that need a local environment with runtime paths.

*Call graph*: calls 1 internal fn (new); 1 external calls (current_exe).


##### `tests::assert_local_environment_unavailable`  (lines 546–548)

```
fn assert_local_environment_unavailable(manager: &EnvironmentManager)
```

**Purpose**: Asserts that a manager has no configured local environment.

**Data flow**: Reads `manager.try_local_environment()` and asserts it is `None`.

**Call relations**: Used by multiple tests to make disabled/no-local expectations concise.

*Call graph*: 1 external calls (assert!).


##### `tests::create_local_environment_does_not_connect`  (lines 551–558)

```
async fn create_local_environment_does_not_connect()
```

**Purpose**: Verifies that constructing a local environment does not attempt any remote connection and still returns local metadata successfully.

**Data flow**: Creates a local environment with `Environment::create(None, test_runtime_paths())`, then asserts `exec_server_url()` is `None`, `is_remote()` is false, and `info().await` succeeds.

**Call relations**: Exercises the local branch of `Environment::create_inner`.

*Call graph*: calls 1 internal fn (create); 3 external calls (assert!, assert_eq!, test_runtime_paths).


##### `tests::environment_manager_normalizes_empty_url`  (lines 561–581)

```
async fn environment_manager_normalizes_empty_url()
```

**Purpose**: Checks that an empty legacy URL is treated as no remote URL, causing the manager to expose local as the default environment.

**Data flow**: Builds a manager from `Some(String::new())`, then asserts default id is `local`, the default/local lookups point to the same `Arc`, no remote environment exists, and the environment is not remote.

**Call relations**: Validates interaction between default-provider URL normalization and manager snapshot construction.

*Call graph*: calls 1 internal fn (create_for_tests); 4 external calls (new, assert!, assert_eq!, test_runtime_paths).


##### `tests::disabled_environment_manager_has_no_default_or_local_environment`  (lines 584–592)

```
async fn disabled_environment_manager_has_no_default_or_local_environment()
```

**Purpose**: Confirms that the explicit no-environments manager exposes neither default nor local environments.

**Data flow**: Constructs `EnvironmentManager::without_environments()` and asserts all default/local lookups return `None`.

**Call relations**: Covers the disabled baseline constructor.

*Call graph*: calls 1 internal fn (without_environments); 3 external calls (assert!, assert_eq!, assert_local_environment_unavailable).


##### `tests::environment_manager_reports_remote_url`  (lines 595–617)

```
async fn environment_manager_reports_remote_url()
```

**Purpose**: Verifies that a URL-backed remote default environment is created and reports its configured URL.

**Data flow**: Builds a manager from a WebSocket URL, fetches the default environment, and asserts the default id is `remote`, `is_remote()` is true, `exec_server_url()` matches, and no local environment is present.

**Call relations**: Exercises the remote branch of default-provider snapshot generation and manager construction.

*Call graph*: calls 1 internal fn (create_for_tests); 4 external calls (assert!, assert_eq!, assert_local_environment_unavailable, test_runtime_paths).


##### `tests::environment_manager_default_environment_caches_environment`  (lines 620–631)

```
async fn environment_manager_default_environment_caches_environment()
```

**Purpose**: Checks that repeated default-environment lookups return the same shared `Arc` and backend instances.

**Data flow**: Creates `default_for_tests()`, calls `default_environment()` twice, and asserts pointer equality for both the environment and its filesystem backend.

**Call relations**: Documents the manager’s caching behavior rather than rebuilding environments on each lookup.

*Call graph*: calls 1 internal fn (default_for_tests); 1 external calls (assert!).


##### `tests::environment_manager_builds_from_snapshot`  (lines 634–659)

```
async fn environment_manager_builds_from_snapshot()
```

**Purpose**: Verifies successful manager construction from an explicit provider snapshot containing one remote environment.

**Data flow**: Creates a snapshot with one remote environment and remote default, builds the manager with runtime paths, and asserts the default id and remote/local availability match the snapshot.

**Call relations**: Directly exercises `EnvironmentManager::from_snapshot`.

*Call graph*: calls 1 internal fn (from_snapshot); 6 external calls (assert!, assert_eq!, assert_local_environment_unavailable, test_runtime_paths, EnvironmentId, vec!).


##### `tests::environment_manager_rejects_empty_environment_id`  (lines 662–675)

```
async fn environment_manager_rejects_empty_environment_id()
```

**Purpose**: Ensures provider snapshots with empty environment ids are rejected.

**Data flow**: Builds a snapshot containing `""` as an id, calls `from_snapshot`, captures the error, and asserts the protocol-error message text.

**Call relations**: Covers one of the key validation branches in `from_snapshot`.

*Call graph*: calls 1 internal fn (from_snapshot); 3 external calls (assert_eq!, test_runtime_paths, vec!).


##### `tests::environment_manager_rejects_provider_supplied_local_environment`  (lines 678–694)

```
async fn environment_manager_rejects_provider_supplied_local_environment()
```

**Purpose**: Ensures providers cannot define an environment with the reserved `local` id.

**Data flow**: Builds a snapshot containing `LOCAL_ENVIRONMENT_ID`, calls `from_snapshot`, and asserts the returned protocol error message.

**Call relations**: Covers the reserved-id invariant enforced by `from_snapshot`.

*Call graph*: calls 1 internal fn (from_snapshot); 3 external calls (assert_eq!, test_runtime_paths, vec!).


##### `tests::environment_manager_uses_explicit_provider_default`  (lines 697–716)

```
async fn environment_manager_uses_explicit_provider_default()
```

**Purpose**: Checks that a provider-specified default environment id is preserved even when local is also included.

**Data flow**: Builds a snapshot with remote `devbox`, `include_local = true`, and default `devbox`, then asserts the manager reports that default id, orders ids with `devbox` first, and returns a remote default environment.

**Call relations**: Exercises default-resolution logic in `from_snapshot` and ordering logic in `default_environment_ids`.

*Call graph*: calls 1 internal fn (from_snapshot); 5 external calls (assert!, assert_eq!, test_runtime_paths, EnvironmentId, vec!).


##### `tests::environment_manager_disables_provider_default`  (lines 719–740)

```
async fn environment_manager_disables_provider_default()
```

**Purpose**: Verifies that a snapshot can include local while still disabling the default environment selection.

**Data flow**: Builds a snapshot with one remote environment, `include_local = true`, and `default = Disabled`, then asserts no default exists while local remains accessible and cached.

**Call relations**: Covers the `EnvironmentDefault::Disabled` branch in `from_snapshot`.

*Call graph*: calls 1 internal fn (from_snapshot); 4 external calls (assert!, assert_eq!, test_runtime_paths, vec!).


##### `tests::environment_manager_rejects_unknown_provider_default`  (lines 743–760)

```
async fn environment_manager_rejects_unknown_provider_default()
```

**Purpose**: Ensures a snapshot default id must refer to a configured environment.

**Data flow**: Builds a snapshot whose default is `missing`, calls `from_snapshot`, and asserts the resulting protocol error message.

**Call relations**: Covers the unknown-default validation branch.

*Call graph*: calls 1 internal fn (from_snapshot); 4 external calls (assert_eq!, test_runtime_paths, EnvironmentId, vec!).


##### `tests::environment_manager_includes_local_for_default_provider_without_url`  (lines 763–783)

```
async fn environment_manager_includes_local_for_default_provider_without_url()
```

**Purpose**: Checks that the default provider requests and yields a local default environment when no exec-server URL is configured.

**Data flow**: Builds a manager from `None`, then asserts default id is `local`, default/local lookups share the same `Arc`, and the environment is local.

**Call relations**: Validates the no-URL branch of the default provider plus manager construction.

*Call graph*: calls 1 internal fn (create_for_tests); 3 external calls (assert!, assert_eq!, test_runtime_paths).


##### `tests::environment_manager_carries_local_runtime_paths`  (lines 786–809)

```
async fn environment_manager_carries_local_runtime_paths()
```

**Purpose**: Verifies that local runtime paths are stored on local environments and survive reconstruction through manager creation.

**Data flow**: Creates a manager with runtime paths, reads them back from the local environment, reconstructs another manager using those values, and asserts the paths remain equal.

**Call relations**: Documents propagation of `ExecServerRuntimePaths` through manager/environment constructors.

*Call graph*: calls 1 internal fn (create_for_tests); 2 external calls (assert_eq!, test_runtime_paths).


##### `tests::environment_manager_omits_default_provider_local_lookup_when_default_disabled`  (lines 812–824)

```
async fn environment_manager_omits_default_provider_local_lookup_when_default_disabled()
```

**Purpose**: Checks that legacy disabled mode (`CODEX_EXEC_SERVER_URL=none`) yields no default and no local environment.

**Data flow**: Builds a manager from `Some("none")`, then asserts all default/local/remote lookups are absent.

**Call relations**: Exercises the disabled branch of default-provider URL normalization.

*Call graph*: calls 1 internal fn (create_for_tests); 4 external calls (assert!, assert_eq!, assert_local_environment_unavailable, test_runtime_paths).


##### `tests::environment_manager_snapshot_without_local_environment_disables_local_default`  (lines 827–843)

```
async fn environment_manager_snapshot_without_local_environment_disables_local_default()
```

**Purpose**: Verifies that when local inclusion is removed from a snapshot, the manager ends up with no local default or local environment.

**Data flow**: Starts from a snapshot that initially referenced local, mutates it to `include_local = false` and `default = Disabled`, builds the manager, and asserts all local/default lookups are absent.

**Call relations**: Covers the interaction between `include_local` and default resolution.

*Call graph*: calls 1 internal fn (from_snapshot); 5 external calls (new, assert!, assert_eq!, assert_local_environment_unavailable, EnvironmentId).


##### `tests::get_environment_returns_none_for_unknown_id`  (lines 846–850)

```
async fn get_environment_returns_none_for_unknown_id()
```

**Purpose**: Confirms that unknown environment ids simply return `None`.

**Data flow**: Creates `default_for_tests()` and asserts `get_environment("does-not-exist")` is `None`.

**Call relations**: Covers the straightforward miss path in `get_environment`.

*Call graph*: calls 1 internal fn (default_for_tests); 1 external calls (assert!).


##### `tests::environment_manager_upserts_named_remote_environment`  (lines 853–875)

```
async fn environment_manager_upserts_named_remote_environment()
```

**Purpose**: Verifies that named remote environments can be inserted and replaced without affecting the default selection.

**Data flow**: Starts from an empty manager, upserts `executor-a` with one URL and asserts it is remote, then upserts the same id with a different URL and asserts the new environment differs by pointer and reports the updated URL while default remains unset.

**Call relations**: Exercises `upsert_environment` replacement semantics.

*Call graph*: calls 1 internal fn (without_environments); 2 external calls (assert!, assert_eq!).


##### `tests::environment_manager_rejects_empty_remote_environment_url`  (lines 878–889)

```
async fn environment_manager_rejects_empty_remote_environment_url()
```

**Purpose**: Ensures dynamic remote upserts reject empty URLs after normalization.

**Data flow**: Calls `upsert_environment` with an empty URL on an empty manager, captures the error, and asserts the protocol-error message.

**Call relations**: Covers URL validation in `upsert_environment`.

*Call graph*: calls 1 internal fn (without_environments); 2 external calls (new, assert_eq!).


##### `tests::default_environment_has_ready_local_executor`  (lines 892–912)

```
async fn default_environment_has_ready_local_executor()
```

**Purpose**: Checks that the default test environment’s local executor can immediately start a simple process.

**Data flow**: Builds `Environment::default_for_tests()`, obtains its exec backend, starts a `true` process with a fixed `ProcessId`, and asserts the returned process id matches.

**Call relations**: Demonstrates that the local backend wiring in `default_for_tests` is functional.

*Call graph*: calls 3 internal fn (default_for_tests, from, from_path); 4 external calls (default, assert_eq!, current_dir, vec!).


##### `tests::test_environment_rejects_sandboxed_filesystem_without_runtime_paths`  (lines 915–939)

```
async fn test_environment_rejects_sandboxed_filesystem_without_runtime_paths()
```

**Purpose**: Verifies that sandboxed filesystem operations fail in test environments that lack configured runtime helper paths.

**Data flow**: Builds `Environment::default_for_tests()`, constructs a restricted sandbox context and a path URI, attempts `read_file` through the environment filesystem, captures the error, and asserts the message requires configured runtime paths.

**Call relations**: Documents an important invariant of local filesystem sandboxing: unsandboxed test environments cannot launch helper processes.

*Call graph*: calls 6 internal fn (default_for_tests, from_permission_profile, from_runtime_permissions, restricted, from_absolute_path, from_abs_path); 3 external calls (new, assert_eq!, current_exe).


### `exec-server/src/environment_provider.rs`

`config` · `config load`

This file is the small configuration bridge between raw startup inputs and the validated `EnvironmentManager`. The `EnvironmentProvider` trait returns an async `EnvironmentProviderSnapshot`, which contains provider-owned remote environments, a default selection encoded as `EnvironmentDefault`, and an `include_local` flag telling the manager whether it should synthesize the reserved local environment itself. That separation is deliberate: providers never insert `local` directly.

`DefaultEnvironmentProvider` preserves the historical single-variable behavior of `CODEX_EXEC_SERVER_URL`. Its `snapshot_inner` first normalizes the raw optional string with `normalize_exec_server_url`, which trims whitespace, treats missing or empty values as “no remote URL”, and treats case-insensitive `none` as explicit disabled mode. If a URL remains, the provider creates exactly one remote environment under the reserved id `remote` using `Environment::remote_inner`. It then derives two pieces of policy from that state: `include_local` is true only when the system is not disabled and no remote environment was created, and `default` becomes `Disabled`, `EnvironmentId("remote")`, or `EnvironmentId("local")` accordingly.

The async `snapshot` method simply boxes `snapshot_inner`, so callers can use the provider through the trait uniformly with TOML-backed providers. Tests focus on the subtle normalization rules: empty strings become local-default mode, `none` disables all environments, and surrounding whitespace around a WebSocket URL is stripped before the remote environment is built.

#### Function details

##### `DefaultEnvironmentProvider::new`  (lines 46–48)

```
fn new(exec_server_url: Option<String>) -> Self
```

**Purpose**: Stores an already-read raw exec-server URL value for later snapshot generation.

**Data flow**: Takes `Option<String>` and returns `DefaultEnvironmentProvider { exec_server_url }` unchanged.

**Call relations**: Used by production and test constructors before snapshot generation; all legacy-provider behavior flows from this stored raw value.

*Call graph*: called by 7 (create_for_tests_with_local, from_default_provider_url, default_provider_adds_remote_environment_for_websocket_url, default_provider_normalizes_exec_server_url, default_provider_omits_local_environment_for_none_value, default_provider_requests_local_environment_when_url_is_empty, default_provider_requests_local_environment_when_url_is_missing).


##### `DefaultEnvironmentProvider::from_env`  (lines 51–53)

```
fn from_env() -> Self
```

**Purpose**: Builds the legacy provider by reading `CODEX_EXEC_SERVER_URL` from the process environment.

**Data flow**: Reads `std::env::var(CODEX_EXEC_SERVER_URL_ENV_VAR).ok()`, forwards the optional string to `new`, and returns the provider.

**Call relations**: Used by environment-manager startup and by TOML fallback when no `environments.toml` file exists.

*Call graph*: called by 2 (from_env, environment_provider_from_codex_home); 2 external calls (new, var).


##### `DefaultEnvironmentProvider::snapshot_inner`  (lines 55–83)

```
fn snapshot_inner(&self) -> EnvironmentProviderSnapshot
```

**Purpose**: Computes the legacy startup snapshot from the raw URL value, deciding whether to expose a remote environment, request local inclusion, or disable environments entirely.

**Data flow**: Clones and normalizes `self.exec_server_url` → optionally pushes one `(REMOTE_ENVIRONMENT_ID, Environment::remote_inner(...))` into `environments` → computes `has_remote`, `include_local`, and `default` based on normalized URL and disabled flag → returns `EnvironmentProviderSnapshot`.

**Call relations**: This is the core logic behind both the async trait method and several test-only manager constructors.

*Call graph*: calls 2 internal fn (remote_inner, normalize_exec_server_url); called by 1 (snapshot); 2 external calls (new, EnvironmentId).


##### `DefaultEnvironmentProvider::snapshot`  (lines 87–89)

```
fn snapshot(&self) -> EnvironmentProviderFuture<'_>
```

**Purpose**: Implements the provider trait by returning the legacy snapshot in a boxed async future.

**Data flow**: Captures `&self`, boxes an async block that returns `Ok(self.snapshot_inner())`, and yields `EnvironmentProviderFuture<'_>`.

**Call relations**: Called through the `EnvironmentProvider` trait by environment-manager startup code.

*Call graph*: calls 1 internal fn (snapshot_inner); 1 external calls (pin).


##### `normalize_exec_server_url`  (lines 92–98)

```
fn normalize_exec_server_url(exec_server_url: Option<String>) -> (Option<String>, bool)
```

**Purpose**: Normalizes raw legacy URL input into either a trimmed URL, an explicit disabled flag, or absence of a URL.

**Data flow**: Takes `Option<String>` → trims via `as_deref().map(str::trim)` → returns `(None, false)` for missing/empty, `(None, true)` for case-insensitive `none`, or `(Some(trimmed_url.to_string()), false)` otherwise.

**Call relations**: Shared by the default provider, single-environment construction, and dynamic remote upsert logic so all legacy URL handling is consistent.

*Call graph*: called by 3 (create_inner, upsert_environment, snapshot_inner).


##### `tests::default_provider_requests_local_environment_when_url_is_missing`  (lines 109–126)

```
async fn default_provider_requests_local_environment_when_url_is_missing()
```

**Purpose**: Verifies that a missing URL yields no provider-owned environments, requests local inclusion, and selects `local` as default.

**Data flow**: Builds a provider with `None`, awaits its snapshot, converts environments to a `HashMap`, and asserts `include_local`, absence of `local`/`remote` entries, and default `EnvironmentId("local")`.

**Call relations**: Exercises the missing-value branch of `snapshot_inner`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::default_provider_requests_local_environment_when_url_is_empty`  (lines 129–146)

```
async fn default_provider_requests_local_environment_when_url_is_empty()
```

**Purpose**: Verifies that an empty string is normalized the same as a missing URL.

**Data flow**: Builds a provider with `Some(String::new())`, awaits the snapshot, and asserts the same local-default/no-remote state as the missing-value case.

**Call relations**: Covers the empty-string normalization branch in `normalize_exec_server_url`.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert!, assert_eq!).


##### `tests::default_provider_omits_local_environment_for_none_value`  (lines 149–163)

```
async fn default_provider_omits_local_environment_for_none_value()
```

**Purpose**: Checks that the special value `none` disables both local inclusion and remote environment creation.

**Data flow**: Builds a provider with `Some("none")`, awaits the snapshot, and asserts `include_local` is false, no environments are present, and default is `Disabled`.

**Call relations**: Exercises the explicit disabled-mode branch.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::default_provider_adds_remote_environment_for_websocket_url`  (lines 166–188)

```
async fn default_provider_adds_remote_environment_for_websocket_url()
```

**Purpose**: Verifies that a concrete WebSocket URL produces a single remote environment and selects it as default.

**Data flow**: Builds a provider with a `ws://...` URL, awaits the snapshot, converts environments to a map, and asserts no local inclusion, presence of `remote`, `is_remote() == true`, matching `exec_server_url()`, and default `EnvironmentId("remote")`.

**Call relations**: Exercises the remote-environment branch of `snapshot_inner`.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert!, assert_eq!).


##### `tests::default_provider_normalizes_exec_server_url`  (lines 191–200)

```
async fn default_provider_normalizes_exec_server_url()
```

**Purpose**: Checks that surrounding whitespace is trimmed from configured remote URLs.

**Data flow**: Builds a provider with a padded URL string, awaits the snapshot, collects environments into a map, and asserts the remote environment reports the trimmed URL.

**Call relations**: Directly validates the trimming behavior in `normalize_exec_server_url` as observed through snapshot generation.

*Call graph*: calls 1 internal fn (new); 1 external calls (assert_eq!).


### Host and platform probing
These files detect local machine identity and surrounding OS or cloud context that influences configuration and startup behavior.

### `cli/src/doctor/git.rs`

`domain_logic` · `request handling`

This module gathers Git-related diagnostics for the current working directory. `git_check` first resolves the selected `git` executable with `which::which`, enumerates all PATH candidates with `git_candidates`, and detects whether the current directory is inside a repository using `codex_git_utils::get_git_repo_root`. If a selected Git exists, it concurrently runs five short-lived subprocesses with a 2-second timeout each: `git --version`, `git --exec-path`, `git version --build-options`, `git rev-parse --abbrev-ref HEAD`, and `git config --get core.fsmonitor`. Those outputs, plus repository-root and `.git` entry metadata, are assembled into `GitCheckInputs` and evaluated by `git_check_from_inputs`.

The evaluator builds a detailed row listing the selected Git path, all PATH candidates, version/build metadata, repo detection, branch, and fsmonitor setting. It starts optimistic with `CheckStatus::Ok`, then downgrades to `Warning` in three concrete cases: a Git executable exists but cannot report a version, a repository is present but no Git executable was found, or the selected Git on Windows is an old `msysgit`/pre-2.35 Git for Windows version. That last case is detected by `old_windows_git_warning`, which parses version strings with `parse_git_version`. Output normalization is intentionally forgiving: command failures simply yield `None`, and `command_output_text` trims and joins multiline stdout with `; ` so details remain compact.

#### Function details

##### `git_check`  (lines 30–60)

```
async fn git_check(cwd: &Path) -> DoctorCheck
```

**Purpose**: Collects Git executable and repository metadata for the current working directory and converts it into a doctor check.

**Data flow**: Accepts `cwd: &Path`, resolves `selected_git` with `which::which`, gathers all PATH candidates with `git_candidates`, and finds `repo_root` with `get_git_repo_root`. If a selected Git exists, it concurrently awaits `git_output` for version, exec path, build options, branch, and `core.fsmonitor`; otherwise those fields stay `None`. It then constructs `GitCheckInputs`, including `.git` entry summary when a repo root exists, and passes them to `git_check_from_inputs`.

**Call relations**: It is invoked by the main doctor orchestration as an async check. It delegates all interpretation to `git_check_from_inputs` after gathering subprocess outputs.

*Call graph*: calls 2 internal fn (git_candidates, git_check_from_inputs); 3 external calls (get_git_repo_root, join!, which).


##### `git_check_from_inputs`  (lines 62–156)

```
fn git_check_from_inputs(inputs: GitCheckInputs) -> DoctorCheck
```

**Purpose**: Turns collected Git inputs into a `DoctorCheck`, including warnings for missing/unrunnable Git and old Git for Windows versions.

**Data flow**: Consumes `GitCheckInputs`, builds detail lines for selected Git, PATH entries, optional version/exec/build metadata, repo detection, `.git` entry, normalized branch, and `core.fsmonitor`. It creates an initial ok `DoctorCheck` using `git_summary(&inputs)`, then mutates status/summary and appends a structured `DoctorIssue` when Git is found but unrunnable, when a repo exists without Git on PATH, or when `old_windows_git_warning(...)` returns a cause string.

**Call relations**: It is called by `git_check` in production and directly by tests with synthetic inputs. It delegates summary generation to `git_summary`, optional detail insertion to `push_optional_detail`, branch normalization to `normalized_branch`, and Windows-version warning detection to `old_windows_git_warning`.

*Call graph*: calls 6 internal fn (new, new, git_summary, normalized_branch, old_windows_git_warning, push_optional_detail); called by 4 (git_check, reports_git_candidates_and_repo_metadata, warns_when_git_repo_has_no_git_executable, warns_when_selected_git_cannot_report_version); 3 external calls (new, cfg!, format!).


##### `git_summary`  (lines 158–166)

```
fn git_summary(inputs: &GitCheckInputs) -> String
```

**Purpose**: Chooses the top-level summary string for the Git check based on whether a version string was obtained.

**Data flow**: Reads `inputs.git_version` and `inputs.selected_git`; returns the version string when present, `git executable found; version unavailable` when Git exists but version is missing, or `git executable not found` otherwise.

**Call relations**: It is used by `git_check_from_inputs` for the initial check summary before warning-specific overrides.

*Call graph*: called by 1 (git_check_from_inputs).


##### `push_optional_detail`  (lines 168–172)

```
fn push_optional_detail(details: &mut Vec<String>, label: &str, value: Option<&str>)
```

**Purpose**: Adds a labeled detail line only when an optional string value is present.

**Data flow**: If `value: Option<&str>` is `Some`, pushes `<label>: <value>` into the mutable details vector; otherwise does nothing.

**Call relations**: Used repeatedly by `git_check_from_inputs` to avoid emitting empty metadata rows.

*Call graph*: called by 1 (git_check_from_inputs); 1 external calls (format!).


##### `normalized_branch`  (lines 174–180)

```
fn normalized_branch(branch: Option<&str>) -> Option<&str>
```

**Purpose**: Normalizes raw branch output so detached HEAD is displayed explicitly and empty values disappear.

**Data flow**: Maps `Some("HEAD")` to `Some("detached HEAD")`, preserves nonempty branch names, and returns `None` for empty or absent values.

**Call relations**: It is used by `git_check_from_inputs` before adding the branch detail.

*Call graph*: called by 1 (git_check_from_inputs).


##### `git_candidates`  (lines 182–190)

```
fn git_candidates() -> Vec<PathBuf>
```

**Purpose**: Enumerates all distinct `git` executables visible on PATH.

**Data flow**: Calls `which::which_all("git")`; on failure returns an empty vector. On success it filters duplicates through a `BTreeSet` and collects unique `PathBuf`s in discovery order.

**Call relations**: It is called by `git_check` to populate PATH candidate details.

*Call graph*: called by 1 (git_check); 3 external calls (new, new, which_all).


##### `git_output`  (lines 192–204)

```
async fn git_output(git_path: &Path, cwd: &Path, args: &[&str]) -> Option<String>
```

**Purpose**: Runs one Git subprocess with a short timeout and returns normalized stdout text on success.

**Data flow**: Builds a `tokio::process::Command` for `git_path`, sets `GIT_OPTIONAL_LOCKS=0`, applies `args`, `current_dir(cwd)`, and `kill_on_drop(true)`, then awaits `command.output()` under `timeout(GIT_COMMAND_TIMEOUT, ...)`. Any timeout, spawn error, or command error yields `None`; successful output is passed to `command_output_text`.

**Call relations**: It is used by `git_check` for all Git subprocess probes.

*Call graph*: calls 1 internal fn (command_output_text); 2 external calls (new, timeout).


##### `command_output_text`  (lines 206–222)

```
fn command_output_text(output: Output) -> Option<String>
```

**Purpose**: Normalizes successful subprocess stdout into a compact single-line string.

**Data flow**: Accepts `std::process::Output`; if the exit status is non-success it returns `None`. Otherwise it decodes stdout lossily, trims each line, drops empty lines, joins remaining lines with `; `, and returns `Some(normalized)` unless the result is empty.

**Call relations**: It is used only by `git_output`.

*Call graph*: called by 1 (git_output); 1 external calls (from_utf8_lossy).


##### `git_entry_summary`  (lines 224–241)

```
fn git_entry_summary(repo_root: &Path) -> String
```

**Purpose**: Describes the repository’s `.git` entry as a directory, a gitdir indirection file, another file, missing, or unreadable.

**Data flow**: Builds `repo_root/.git`, reads metadata, and returns `directory` for directories. For files, it tries to read the contents and parse a `gitdir:` prefix into `file -> <path>`; otherwise it returns `file`. Other object types become `other`, missing becomes `missing`, and read/metadata errors become `unreadable (<err>)`.

**Call relations**: It is used by `git_check` when a repository root was detected.

*Call graph*: 4 external calls (join, format!, metadata, read_to_string).


##### `old_windows_git_warning`  (lines 243–256)

```
fn old_windows_git_warning(version: Option<&str>, is_windows: bool) -> Option<String>
```

**Purpose**: Detects Git for Windows versions old enough to risk corrupting Windows TUI rendering.

**Data flow**: If `is_windows` is false, returns `None`. Otherwise it requires a version string, warns immediately when it contains `msysgit`, or parses the version with `parse_git_version` and returns a warning string when the version is below 2.35 (implemented as major < 2 or major == 2 and minor <= 34).

**Call relations**: It is called by `git_check_from_inputs` after other warning cases are ruled out.

*Call graph*: calls 1 internal fn (parse_git_version); called by 1 (git_check_from_inputs).


##### `parse_git_version`  (lines 265–279)

```
fn parse_git_version(version: &str) -> Option<ParsedGitVersion>
```

**Purpose**: Extracts numeric major/minor/patch components from `git version ...` strings, including Git for Windows suffixes.

**Data flow**: Strips the `git version ` prefix, takes the first whitespace-delimited token, removes any `.windows.` suffix segment, splits on `.`, parses major/minor/optional patch as `u32`, and returns `Some(ParsedGitVersion)` or `None` on any parse failure.

**Call relations**: It is used by `old_windows_git_warning` and directly unit-tested with Git for Windows version strings.

*Call graph*: called by 1 (old_windows_git_warning).


##### `tests::parses_git_for_windows_version`  (lines 288–305)

```
fn parses_git_for_windows_version()
```

**Purpose**: Verifies that Git for Windows version strings are parsed into numeric components correctly.

**Data flow**: Calls `parse_git_version` with representative version strings and asserts the resulting `ParsedGitVersion` values.

**Call relations**: Direct unit test for version parsing.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::classifies_old_windows_git`  (lines 308–331)

```
fn classifies_old_windows_git()
```

**Purpose**: Verifies warning classification for old vs current Git for Windows and for non-Windows platforms.

**Data flow**: Calls `old_windows_git_warning` with old/new version strings and different `is_windows` flags, asserting warning presence or absence.

**Call relations**: Direct unit test for Windows Git warning logic.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::warns_when_git_repo_has_no_git_executable`  (lines 334–345)

```
fn warns_when_git_repo_has_no_git_executable()
```

**Purpose**: Verifies that detecting a repository without any Git executable produces a warning.

**Data flow**: Builds `GitCheckInputs` with only `repo_root` set, calls `git_check_from_inputs`, and asserts warning status and summary.

**Call relations**: Tests one warning branch in `git_check_from_inputs`.

*Call graph*: calls 1 internal fn (git_check_from_inputs); 3 external calls (from, assert_eq!, default).


##### `tests::warns_when_selected_git_cannot_report_version`  (lines 348–357)

```
fn warns_when_selected_git_cannot_report_version()
```

**Purpose**: Verifies that a selected Git path without version output produces a warning.

**Data flow**: Builds `GitCheckInputs` with `selected_git` and `repo_root` but no version, calls `git_check_from_inputs`, and asserts warning status and summary.

**Call relations**: Tests the unrunnable-Git warning branch.

*Call graph*: calls 1 internal fn (git_check_from_inputs); 3 external calls (from, assert_eq!, default).


##### `tests::reports_git_candidates_and_repo_metadata`  (lines 360–377)

```
fn reports_git_candidates_and_repo_metadata()
```

**Purpose**: Verifies that successful Git inputs are rendered into expected detail lines without warnings.

**Data flow**: Builds a populated `GitCheckInputs`, calls `git_check_from_inputs`, and asserts ok status plus presence of PATH-entry count, branch, and `core.fsmonitor` details.

**Call relations**: Tests the normal successful path through `git_check_from_inputs`.

*Call graph*: calls 1 internal fn (git_check_from_inputs); 5 external calls (from, assert!, assert_eq!, default, vec!).


### `cli/src/doctor/system.rs`

`domain_logic` · `doctor request handling`

This file defines a small input model, `SystemCheckInputs`, and turns it into a single doctor row describing the host environment. `SystemCheckInputs::detect` gathers OS metadata from `os_info::get`, locale information from `sys_locale::get_locale`, and selected environment variables into `BTreeMap`s. Locale variables come only from `LOCALE_ENV_VARS` and are included when set; editor variables (`VISUAL`, `EDITOR`) are always represented, defaulting to the literal string `not set`; pager variables are included only when present. Using ordered maps keeps test output deterministic.

`system_check` is the production entry that detects inputs and forwards them to `system_check_from_inputs`, while tests call the latter directly with synthetic data. The formatter emits details in a fixed sequence: OS summary fields first, then OS language or `unavailable`, then locale vars in `LOCALE_ENV_VARS` order, editor vars in `EDITOR_ENV_VARS` order, and pager vars in `PAGER_ENV_VARS` order. The summary is derived solely from `os_language`, producing either `OS language <value>` or `OS language unavailable`. The check always reports `CheckStatus::Ok`; this module is descriptive support context rather than a validator.

#### Function details

##### `SystemCheckInputs::detect`  (lines 22–57)

```
fn detect() -> Self
```

**Purpose**: Builds a snapshot of host OS and selected environment variables for the system doctor check. It normalizes missing editor variables to `not set` while leaving locale and pager maps sparse.

**Data flow**: Reads OS identity and version from `os_info::get`, locale from `sys_locale::get_locale`, and environment variables from `std::env`. It collects locale vars only when `env::var` succeeds, editor vars always with lossy OS-string conversion or `not set`, and pager vars only when `env::var_os` returns a value. It returns a populated `SystemCheckInputs` struct.

**Call relations**: This is the detection phase used by `system_check`. By separating collection from formatting, the file can unit-test `system_check_from_inputs` deterministically without mutating process environment.

*Call graph*: called by 1 (system_check); 2 external calls (get, get_locale).


##### `system_check`  (lines 60–62)

```
fn system_check() -> DoctorCheck
```

**Purpose**: Runs the production system-environment doctor check using live process inputs. It is a thin wrapper around detection plus formatting.

**Data flow**: Calls `SystemCheckInputs::detect` to gather runtime state, passes the resulting struct into `system_check_from_inputs`, and returns the resulting `DoctorCheck`.

**Call relations**: This is the entry used by the doctor subsystem. It delegates all concrete formatting and summary logic to `system_check_from_inputs`.

*Call graph*: calls 2 internal fn (detect, system_check_from_inputs).


##### `system_check_from_inputs`  (lines 64–103)

```
fn system_check_from_inputs(inputs: SystemCheckInputs) -> DoctorCheck
```

**Purpose**: Formats a `SystemCheckInputs` snapshot into a stable doctor row. It emits ordered details for OS identity, language, locale variables, editor variables, and pager variables.

**Data flow**: Consumes a `SystemCheckInputs` value, initializes a details vector with `os`, `os_type`, and `os_version`, appends either `os language: <value>` or `os language: unavailable`, then iterates through the predefined locale, editor, and pager variable name arrays and looks up matching values in the corresponding maps. It derives the summary from `os_language` and returns a `DoctorCheck` with `CheckStatus::Ok` and the assembled details.

**Call relations**: This function is called by `system_check` in production and directly by both tests. It centralizes all output ordering so tests can assert exact strings and sequence.

*Call graph*: calls 1 internal fn (new); called by 3 (system_check, system_check_handles_missing_os_language, system_check_reports_os_language_locale_editor_and_pager_env); 2 external calls (format!, vec!).


##### `tests::system_check_reports_os_language_locale_editor_and_pager_env`  (lines 112–152)

```
fn system_check_reports_os_language_locale_editor_and_pager_env()
```

**Purpose**: Verifies that a fully populated input snapshot produces the expected summary and exact detail ordering. It checks locale, editor, and pager sections together.

**Data flow**: Constructs `BTreeMap` inputs for locale, editor, and pager variables plus explicit OS fields, passes them to `system_check_from_inputs`, and asserts that the returned `DoctorCheck` summary and `details` vector exactly match the expected strings.

**Call relations**: This test exercises the main formatting path with all optional sections present, ensuring `system_check_from_inputs` preserves the intended field order and labels.

*Call graph*: calls 1 internal fn (system_check_from_inputs); 3 external calls (from, new, assert_eq!).


##### `tests::system_check_handles_missing_os_language`  (lines 155–181)

```
fn system_check_handles_missing_os_language()
```

**Purpose**: Verifies the fallback behavior when OS language is unavailable. It also confirms that unset editor variables still appear as `not set` while absent pager and locale variables are omitted.

**Data flow**: Builds a `SystemCheckInputs` value with `os_language: None`, empty locale and pager maps, and editor entries set to `not set`, then calls `system_check_from_inputs` and asserts the summary and details against the expected fallback strings.

**Call relations**: This test covers the branch in `system_check_from_inputs` that emits `OS language unavailable` and ensures sparse maps do not create extra detail lines.

*Call graph*: calls 1 internal fn (system_check_from_inputs); 3 external calls (from, new, assert_eq!).


### `cloud-tasks/src/env_detect.rs`

`domain_logic` · `startup and environment selection`

This file implements environment discovery against the Codex/ChatGPT backend. It defines a private `CodeEnvironment` shape matching the backend JSON and a public `AutodetectSelection` used by startup logic. The main flow in `autodetect_environment_id` first inspects local git remotes, extracts GitHub owner/repo pairs, queries the backend’s `by-repo` environment endpoint for each origin, and tries to choose a best match. If no repo-specific match is suitable, it falls back to fetching the full environment list, logs the raw or pretty-printed JSON for debugging, and applies the same selection heuristic.

Selection is centralized in `pick_environment_row`: exact case-insensitive label match wins, then a single available environment, then any pinned environment, then the highest `task_count`, then first entry. This makes startup behavior deterministic even when multiple environments exist.

The file also exposes `list_environments`, which merges repo-specific and global environment lists into de-duplicated `EnvironmentRow` values for the TUI. Merge logic preserves labels when available, ORs pinned flags, and records one repo hint. Final sorting puts pinned environments first, then sorts case-insensitively by label and finally by ID.

Supporting helpers fetch JSON with shared headers and custom CA support, enumerate git origins via two command strategies, deduplicate URLs, and parse common GitHub SSH/HTTPS remote formats.

#### Function details

##### `autodetect_environment_id`  (lines 25–108)

```
async fn autodetect_environment_id(
    base_url: &str,
    headers: &HeaderMap,
    desired_label: Option<String>,
) -> anyhow::Result<AutodetectSelection>
```

**Purpose**: Attempts to choose the most relevant environment for the current workspace by combining local git-origin inspection with backend environment queries.

**Data flow**: It takes a normalized base URL, request headers, and an optional desired label. It gathers git origins via `get_git_origins`, logs them, parses each origin with `parse_owner_repo`, queries the repo-specific environments endpoint with `get_json`, accumulates all returned `CodeEnvironment` rows, and asks `pick_environment_row` to choose one. If none is chosen, it fetches the global environments endpoint manually, logs status/content-type and the full JSON body, decodes it into `Vec<CodeEnvironment>`, runs `pick_environment_row` again, and returns `AutodetectSelection { id, label }` or an error if no environments exist.

**Call relations**: Startup TUI logic calls this in the background to preselect an environment filter. It delegates origin parsing, HTTP fetches, and heuristic selection to `get_git_origins`, `parse_owner_repo`, `get_json`, and `pick_environment_row`.

*Call graph*: calls 3 internal fn (get_git_origins, parse_owner_repo, pick_environment_row); called by 1 (run_main); 9 external calls (clone, new, bail!, builder, build_reqwest_client_with_custom_ca, append_error_log, format!, from_str, to_string_pretty).


##### `pick_environment_row`  (lines 110–145)

```
fn pick_environment_row(
    envs: &[CodeEnvironment],
    desired_label: Option<&str>,
) -> Option<CodeEnvironment>
```

**Purpose**: Chooses one environment from a candidate list using label match, singleton, pinned, and task-count heuristics in that order.

**Data flow**: It takes a slice of `CodeEnvironment` and an optional desired label. It returns `None` for an empty slice; otherwise it first searches for a case-insensitive exact label match, then returns the sole environment if only one exists, then the first pinned environment, then the environment with the highest `task_count` or the first row. Each successful branch logs the reason to `error.log` and returns a cloned `CodeEnvironment`.

**Call relations**: This helper is used by `autodetect_environment_id` for both repo-specific and global environment lists.

*Call graph*: called by 1 (autodetect_environment_id); 5 external calls (is_empty, iter, len, append_error_log, format!).


##### `get_json`  (lines 147–169)

```
async fn get_json(
    url: &str,
    headers: &HeaderMap,
) -> anyhow::Result<T>
```

**Purpose**: Performs an authenticated GET request, validates success, logs response metadata, and deserializes the body into the requested type.

**Data flow**: It takes a URL and headers, builds a reqwest client with custom CA support, sends a GET with cloned headers, captures status/content-type/body, logs status and content type, returns an error for non-success HTTP statuses including the raw body, otherwise deserializes the body into `T` and returns it or a decode error containing the body.

**Call relations**: Used by both autodetection and environment-listing flows for typed backend fetches.

*Call graph*: 6 external calls (clone, bail!, builder, build_reqwest_client_with_custom_ca, append_error_log, format!).


##### `get_git_origins`  (lines 171–210)

```
fn get_git_origins() -> Vec<String>
```

**Purpose**: Collects remote repository URLs from the local git configuration using two command strategies and returns a deduplicated list.

**Data flow**: It first runs `git config --get-regexp remote\..*\.url`, parses each output line after the first space into a URL list, and returns `uniq(urls)` if any were found. If that fails or yields nothing, it runs `git remote -v`, takes the second whitespace-separated field from each line, deduplicates with `uniq`, and returns the result. If both strategies fail, it returns an empty vector.

**Call relations**: Called by both `autodetect_environment_id` and `list_environments` as the source of repo hints.

*Call graph*: calls 1 internal fn (uniq); called by 2 (autodetect_environment_id, list_environments); 3 external calls (from_utf8_lossy, new, new).


##### `uniq`  (lines 212–216)

```
fn uniq(mut v: Vec<String>) -> Vec<String>
```

**Purpose**: Sorts and deduplicates a vector of strings in place.

**Data flow**: It takes ownership of a `Vec<String>`, sorts it lexicographically, removes adjacent duplicates with `dedup`, and returns the resulting vector.

**Call relations**: Used only by `get_git_origins` to normalize remote URL lists.

*Call graph*: called by 1 (get_git_origins).


##### `parse_owner_repo`  (lines 218–252)

```
fn parse_owner_repo(url: &str) -> Option<(String, String)>
```

**Purpose**: Extracts a GitHub `owner/repo` pair from common SSH and HTTP remote URL formats.

**Data flow**: It trims the input URL, strips an `ssh://` prefix if present, checks for any `@github.com:` SSH form, otherwise tries several HTTP/git prefixes, trims leading slashes and trailing `.git`, splits the remainder into two path components, logs the parsed owner/repo, and returns `Some((owner, repo))` or `None` if the URL is not a recognized GitHub remote.

**Call relations**: Used by both autodetection and environment-listing flows before querying repo-specific backend endpoints.

*Call graph*: called by 2 (autodetect_environment_id, list_environments); 2 external calls (append_error_log, format!).


##### `list_environments`  (lines 256–362)

```
async fn list_environments(
    base_url: &str,
    headers: &HeaderMap,
) -> anyhow::Result<Vec<crate::app::EnvironmentRow>>
```

**Purpose**: Builds the environment list shown in the TUI by merging repo-specific and global backend environment results into sorted, de-duplicated `EnvironmentRow` values.

**Data flow**: It takes a base URL and headers, initializes a `HashMap<String, EnvironmentRow>`, gathers git origins, parses GitHub owner/repo pairs, queries each repo-specific environments endpoint, and inserts or merges rows keyed by environment ID while preserving labels, OR-ing pinned flags, and recording repo hints. It then fetches the global environments list, merges those rows similarly, or returns the repo-only results if the global fetch fails and the map is non-empty. Finally it collects the map values into a vector, sorts pinned-first then by lowercase label then ID, and returns the rows.

**Call relations**: Called by startup and explicit environment-resolution flows to populate the environment picker and to resolve user-provided environment labels/IDs.

*Call graph*: calls 2 internal fn (get_git_origins, parse_owner_repo); called by 2 (resolve_environment_id, run_main); 4 external calls (new, format!, info!, warn!).


### `config/src/host_name.rs`

`util` · `startup`

This file provides a small hostname utility with process-wide caching. `HOST_NAME` is a `LazyLock<Option<String>>` initialized by `compute_host_name`, so the potentially blocking hostname/FQDN lookup happens at most once per process. `host_name()` simply clones and returns that cached result.

`compute_host_name` starts from the kernel hostname via `gethostname`, normalizes it by trimming whitespace, removing a trailing dot, rejecting empties, and lowercasing ASCII. It then tries to upgrade that short hostname to a canonical fully qualified domain name using `local_fqdn_for_hostname`. On Unix, that means calling `getaddrinfo` with `AI_CANONNAME` and scanning successful results for a canonical name that still looks DNS-qualified; on Windows, it asks the OS for `PhysicalDnsFullyQualified`. If no FQDN is available, it falls back to the normalized kernel hostname instead of returning `None`, because hostname-based matching is best-effort classification rather than authenticated identity.

`normalize_fqdn_candidate` reuses the base normalization and then requires the result to contain a dot, filtering out short hostnames that some resolvers may still report as canonical names. The tests cover acceptance of DNS-qualified names, rejection of short names, and normalization of case plus trailing dots.

#### Function details

##### `host_name`  (lines 15–17)

```
fn host_name() -> Option<String>
```

**Purpose**: Returns the process-cached normalized hostname or FQDN.

**Data flow**: Clones the `Option<String>` stored in the `HOST_NAME` `LazyLock` and returns it.

**Call relations**: Called by higher-level config logic that needs a stable hostname for matching remote-sandbox requirements or similar host-sensitive behavior.


##### `compute_host_name`  (lines 19–34)

```
fn compute_host_name() -> Option<String>
```

**Purpose**: Computes the cached hostname value by normalizing the kernel hostname and, when possible, replacing it with a canonical local FQDN.

**Data flow**: Reads the kernel hostname from `gethostname::gethostname()`, normalizes it with `normalize_host_name`, then calls `local_fqdn_for_hostname(&kernel_hostname)`. If that returns `Some(fqdn)`, it returns the FQDN; otherwise it returns the normalized kernel hostname.

**Call relations**: Used only to initialize the `HOST_NAME` cache on first access.

*Call graph*: calls 2 internal fn (local_fqdn_for_hostname, normalize_host_name); 1 external calls (gethostname).


##### `normalize_host_name`  (lines 36–39)

```
fn normalize_host_name(hostname: &str) -> Option<String>
```

**Purpose**: Normalizes a hostname by trimming whitespace, removing a trailing dot, rejecting empties, and lowercasing ASCII.

**Data flow**: Consumes `&str`, applies trimming and `trim_end_matches('.')`, and returns `Some(lowercased)` unless the cleaned string is empty.

**Call relations**: Used by both `compute_host_name` and `normalize_fqdn_candidate` so all hostname handling shares the same normalization rules.

*Call graph*: called by 2 (compute_host_name, normalize_fqdn_candidate).


##### `local_fqdn_for_hostname`  (lines 66–68)

```
fn local_fqdn_for_hostname(_hostname: &str) -> Option<String>
```

**Purpose**: Per-platform helper that tries to obtain a DNS-qualified canonical hostname for the local machine.

**Data flow**: On Unix, it builds `AddrInfoHints { flags: AI_CANONNAME, ..default() }`, calls `getaddrinfo(Some(hostname), None, Some(hints))`, filters successful results, extracts `canonname`, and returns the first candidate accepted by `normalize_fqdn_candidate`. On Windows, it calls `get_computer_name(PhysicalDnsFullyQualified)`, converts the OS string, and normalizes it the same way. On unsupported platforms it returns `None`.

**Call relations**: Called by `compute_host_name` as the best-effort FQDN upgrade step.

*Call graph*: called by 1 (compute_host_name); 3 external calls (default, getaddrinfo, get_computer_name).


##### `normalize_fqdn_candidate`  (lines 70–72)

```
fn normalize_fqdn_candidate(hostname: &str) -> Option<String>
```

**Purpose**: Normalizes a hostname candidate and accepts it only if it is DNS-qualified.

**Data flow**: Calls `normalize_host_name(hostname)` and then filters the result to strings containing `.`.

**Call relations**: Used by platform-specific FQDN lookup code to reject short hostnames that are not useful for DNS-style matching.

*Call graph*: calls 1 internal fn (normalize_host_name).


##### `tests::normalize_fqdn_candidate_accepts_dns_qualified_name`  (lines 80–85)

```
fn normalize_fqdn_candidate_accepts_dns_qualified_name()
```

**Purpose**: Verifies that a fully qualified hostname is accepted unchanged after normalization.

**Data flow**: Calls `normalize_fqdn_candidate` with a DNS-qualified name and asserts the expected `Some(String)` result.

**Call relations**: Covers the positive path for FQDN candidate filtering.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_fqdn_candidate_rejects_short_name`  (lines 88–90)

```
fn normalize_fqdn_candidate_rejects_short_name()
```

**Purpose**: Ensures short hostnames without dots are rejected as FQDN candidates.

**Data flow**: Calls `normalize_fqdn_candidate` with a short hostname and asserts the result is `None`.

**Call relations**: Covers the dot-required filter.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_fqdn_candidate_trims_trailing_dot_and_normalizes_case`  (lines 93–98)

```
fn normalize_fqdn_candidate_trims_trailing_dot_and_normalizes_case()
```

**Purpose**: Checks that FQDN candidates are lowercased and stripped of a trailing dot before acceptance.

**Data flow**: Calls `normalize_fqdn_candidate` with an uppercase dotted hostname ending in `.`, then asserts the normalized lowercase result.

**Call relations**: Covers normalization behavior shared with the main hostname computation path.

*Call graph*: 1 external calls (assert_eq!).


### Runtime provenance checks
This file reports which Codex binary is running and whether key bundled helper resolution, especially ripgrep, is working.

### `cli/src/doctor/runtime.rs`

`domain_logic` · `doctor request handling`

This file contributes two informational doctor checks. `runtime_check` captures launch provenance for the current process by reading `std::env::current_exe`, deriving an `InstallContext` with `doctor_install_context`, and assembling concrete details such as the compiled package version, `OS-ARCH` platform string, human-readable install method, build commit, and the resolved executable path. The check is always emitted with `CheckStatus::Ok`; mismatched install state is intentionally left to other doctor modules.

`search_check` inspects the ripgrep command selected by the same `InstallContext`. It distinguishes bundled versus system search via `search_provider`, then verifies readiness differently depending on whether the command is a path-like executable or a bare command name. Path commands are checked with filesystem metadata and must exist as a regular file; bare commands are probed by spawning `rg --version` and parsing the first stdout line. Any missing file, non-file path, nonzero exit, or spawn error downgrades the row to `Warning` and adds a remediation telling the user to install ripgrep or repair the package. Helper functions encode install-method labels, bundled/system classification based on package layout or legacy standalone resources, and compile-time commit selection from `CODEX_BUILD_COMMIT` or `GIT_COMMIT`.

#### Function details

##### `runtime_check`  (lines 24–49)

```
fn runtime_check() -> DoctorCheck
```

**Purpose**: Constructs the runtime provenance doctor row for the currently running executable. It reports version, platform, install context, build commit, and executable path without treating inconsistencies as a failure.

**Data flow**: Reads the current executable path from `env::current_exe`, derives an `InstallContext` from that optional path, reads compile-time package version and runtime OS/ARCH constants, converts the install context into both a short install-method label and a detailed description, appends the executable path via `push_path_detail`, and returns a populated `DoctorCheck` with `CheckStatus::Ok` and a details vector.

**Call relations**: This function is invoked by the surrounding doctor subsystem when assembling runtime diagnostics. It delegates install-context interpretation to `doctor_install_context`, `install_method_name`, and `describe_install_context`, and uses `push_path_detail` so path formatting stays consistent with other doctor checks.

*Call graph*: calls 2 internal fn (new, install_method_name); 5 external calls (current_exe, format!, doctor_install_context, push_path_detail, vec!).


##### `search_check`  (lines 57–117)

```
fn search_check() -> DoctorCheck
```

**Purpose**: Builds a doctor row that verifies the ripgrep command chosen for this installation can actually be used. It distinguishes bundled package binaries from PATH lookups and warns when the command cannot be validated.

**Data flow**: Reads the current executable path, derives `InstallContext`, obtains `rg_command` from that context, computes a provider label with `search_provider`, and initializes details with the command path and provider. If the command has multiple path components, it reads filesystem metadata and classifies the path as existing file, non-file, or missing/error; otherwise it runs `<rg_command> --version`, inspects process success, and extracts the first stdout line as a readiness detail. It then returns a `DoctorCheck` whose status is `Ok` or `Warning`, optionally attaching remediation text when verification failed.

**Call relations**: This check is called by the doctor runner as part of runtime diagnostics. It depends on `doctor_install_context` to choose the search command and on `search_provider` to explain whether that command comes from the package layout or the system environment; it performs the final verification itself via filesystem inspection or subprocess execution.

*Call graph*: calls 2 internal fn (new, search_provider); 8 external calls (from_utf8_lossy, new, current_exe, format!, metadata, doctor_install_context, unreachable!, vec!).


##### `install_method_name`  (lines 119–127)

```
fn install_method_name(context: &InstallContext) -> &'static str
```

**Purpose**: Maps an `InstallContext`'s `InstallMethod` enum to a short stable label used in runtime summaries. The labels are intentionally coarse: standalone, npm, bun, brew, or local build.

**Data flow**: Consumes a shared reference to `InstallContext`, pattern-matches on `context.method`, and returns a static string literal corresponding to the variant.

**Call relations**: This helper is only used from `runtime_check` to produce the concise summary text `running <method> on <platform>`, separating summary wording from the more detailed install-context description.

*Call graph*: called by 1 (runtime_check).


##### `search_provider`  (lines 129–149)

```
fn search_provider(context: &InstallContext) -> &'static str
```

**Purpose**: Classifies the selected ripgrep command as either bundled with Codex or supplied by the system. It recognizes both current package-layout installs and legacy standalone resource layouts.

**Data flow**: Reads `context.rg_command()` and compares it against `context.package_layout.path_dir` when present, then separately checks whether a standalone install's `resources_dir` prefixes the command path. It returns the static label `bundled` if either package-root test matches, otherwise `system`.

**Call relations**: This helper is called by `search_check` before readiness probing so the resulting doctor row can explain where the search command came from. It encapsulates install-layout-specific path logic that would otherwise clutter the check body.

*Call graph*: calls 1 internal fn (rg_command); called by 1 (search_check); 1 external calls (matches!).


##### `build_commit`  (lines 151–155)

```
fn build_commit() -> &'static str
```

**Purpose**: Returns the compile-time commit identifier embedded in the binary, if available. It falls back through two environment variable names before reporting `unknown`.

**Data flow**: Reads compile-time optional environment values via `option_env!` for `CODEX_BUILD_COMMIT` and then `GIT_COMMIT`, returning the first present value or the literal `unknown`.

**Call relations**: This helper is used only by `runtime_check` to include build provenance in the details list without introducing runtime I/O.

*Call graph*: 1 external calls (option_env!).

## 📊 State Registers Touched

- `reg-codex-home-and-install-context` — The discovered home folder, install layout, bundled asset paths, and helper binary locations that other parts of the app reuse.
- `reg-execution-environment-snapshot` — The captured shell and machine environment details that threads and tools use to run commands consistently.
- `reg-host-environment-facts` — The normalized facts about the current machine, OS, editor, locale, cloud status, and helper tools that the system keeps reusing.
- `reg-proxy-and-network-routing` — The current proxy rules, local-address safety checks, and routing choices that decide where network traffic is allowed to go.
- `reg-helper-binary-materialization-cache` — The cached result of copying or preparing bundled helper binaries into reusable sandbox/bin locations so later runs can reuse them without rematerializing.
- `reg-managed-install-fingerprint-and-version` — The discovered standalone-install fingerprint and current installed version metadata reused by updater and install-management paths.
