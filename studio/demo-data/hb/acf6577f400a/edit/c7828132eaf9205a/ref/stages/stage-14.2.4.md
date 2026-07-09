# Sandbox selection and Unix platform launchers  `stage-14.2.4`

This stage is the system’s “safe launch” layer for Unix-like systems. It sits between a simple “run this tool” request and the actual process that starts. Its job is to decide what kind of sandbox, or safety cage, should be used, rewrite the request into the right command shape, and, when needed, support a shell flow that can ask for more privileges in a controlled way.

The main entry points in sandboxing/src/lib.rs and manager.rs expose this service and turn high-level requests plus permission rules into platform-specific launch commands. On Linux, bwrap.rs checks whether bubblewrap, the main isolation tool, is usable and when to warn if it is not. landlock.rs in both sandboxing and core builds and applies the argument list for the Linux sandbox helper. Inside linux-sandbox, bwrap.rs defines the actual filesystem restrictions, launcher.rs and bundled_bwrap.rs choose and run the right bubblewrap binary, and landlock.rs keeps an older in-process fallback path.

The shell-escalation files add a Unix client/server protocol so shell commands can be intercepted, approved, denied, or relaunched with higher privileges. Finally, the runtime helpers in core/src/tools/runtimes prepare commands and rewrite shell invocations so all of this works cleanly in real tool launches.

## Files in this stage

### Sandboxing API and selection
These files define the public sandboxing surface and the central logic that selects a sandbox strategy and rewrites launch requests into platform-specific execution forms.

### `sandboxing/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the top-level module definition and re-export surface for the sandboxing crate. It conditionally includes Linux-only `bwrap` support and macOS-only `seatbelt` support, always exposes `landlock` and `policy_transforms`, and re-exports the manager layer’s core types such as `SandboxManager`, `SandboxCommand`, `SandboxExecRequest`, `SandboxTransformRequest`, `SandboxType`, and `SandboxTransformError`. That makes this file the stable public boundary through which the rest of the system accesses sandbox selection, policy compatibility checks, and managed CA-root handling.

Beyond module wiring, it contains two pieces of behavior. First, on non-Linux targets it defines a stub `system_bwrap_warning` that always returns `None`, preserving a uniform API even when bubblewrap is unavailable. Second, it implements `From<SandboxTransformError> for CodexErr`, which is the key error-translation bridge from internal sandbox transformation failures into externally visible protocol errors. The mapping is intentionally specific: invalid working-directory conditions become `CodexErr::InvalidRequest`, a missing Linux sandbox executable becomes `CodexErr::LandlockSandboxExecutableNotProvided`, Linux WSL1 bubblewrap incompatibility becomes `UnsupportedOperation` with the crate’s canonical warning text, and non-macOS seatbelt requests become an `UnsupportedOperation` explaining platform unavailability. The design keeps platform conditionals localized at the crate boundary so callers can depend on a consistent exported interface.

#### Function details

##### `system_bwrap_warning`  (lines 27–31)

```
fn system_bwrap_warning(
    _permission_profile: &codex_protocol::models::PermissionProfile,
) -> Option<String>
```

**Purpose**: Provides the non-Linux implementation of the bubblewrap warning hook, returning no warning because system bubblewrap support is not relevant on these targets.

**Data flow**: It accepts a `&codex_protocol::models::PermissionProfile` argument but deliberately ignores it. The function performs no inspection, mutation, or I/O and always returns `Option<String>::None`.

**Call relations**: This definition exists only when the crate is compiled for non-Linux targets, so callers can invoke the same exported symbol regardless of platform. In that configuration it serves as the terminal implementation rather than delegating to Linux `bwrap` logic.


##### `CodexErr::from`  (lines 34–52)

```
fn from(err: SandboxTransformError) -> Self
```

**Purpose**: Converts `SandboxTransformError` values into the protocol-layer `CodexErr` variants expected by higher layers of the system. It preserves user-facing meaning by choosing different protocol errors for invalid input, missing executables, and unsupported platform features.

**Data flow**: It takes ownership of a `SandboxTransformError`, pattern-matches on the variant, and constructs a new `CodexErr`. For `InvalidCommandCwd` and `InvalidSandboxPolicyCwd`, it stringifies the original error and passes that message into `CodexErr::InvalidRequest`; for `MissingLinuxSandboxExecutable`, it returns the dedicated `LandlockSandboxExecutableNotProvided` variant; for Linux-only `Wsl1UnsupportedForBubblewrap`, it reads `crate::bwrap::WSL1_BWRAP_WARNING` and wraps it in `UnsupportedOperation`; for non-macOS `SeatbeltUnavailable`, it emits `UnsupportedOperation` with a fixed explanatory string. It writes no state and returns the constructed protocol error.

**Call relations**: This conversion is used wherever sandbox transformation failures need to cross the crate boundary into protocol/error-reporting code. Within the function, the only delegated construction paths are the `CodexErr::InvalidRequest` and `CodexErr::UnsupportedOperation` constructors used for variants that should surface as client-visible request or capability errors.

*Call graph*: 2 external calls (InvalidRequest, UnsupportedOperation).


### `sandboxing/src/manager.rs`

`orchestration` · `request handling`

This file is the core orchestration point between abstract permissions and concrete process launch parameters. It defines the sandbox taxonomy (`SandboxType`, plus `SandboxablePreference`), the validated execution payload (`SandboxExecRequest`), and the request bundle consumed by transformation (`SandboxTransformRequest`). `SandboxManager::select_initial` decides whether to use no sandbox or the current platform sandbox based on caller preference, Windows sandbox enablement, and whether the effective file-system/network policy requires platform enforcement.

The main work happens in `SandboxManager::transform`. It first converts `PathUri` values for the command working directory and sandbox-policy cwd into `AbsolutePathBuf`, surfacing host-specific URI conversion failures as structured `SandboxTransformError`s. It then merges any per-command `AdditionalPermissionProfile` into the base `PermissionProfile`, optionally augments readable roots with a managed MITM CA bundle path from `NetworkProxy`, derives runtime file-system and network policies, and rewrites the command line according to the selected sandbox. macOS wraps the command with seatbelt arguments; Linux requires a sandbox executable path, checks bubblewrap viability on WSL1, computes Landlock/bubblewrap arguments, and may override `argv[0]`; unsandboxed and Windows paths pass through the original command components.

The file also provides compatibility conversion back to legacy `SandboxPolicy`, including a fallback `WorkspaceWrite` policy that reconstructs writable roots while excluding cwd itself and probing `TMPDIR` and `/tmp` writability. Helper functions normalize `OsString` command components lossily when necessary, preserving launchability even for non-UTF-8 inputs.

#### Function details

##### `SandboxType::as_metric_tag`  (lines 33–40)

```
fn as_metric_tag(self) -> &'static str
```

**Purpose**: Maps each sandbox variant to the fixed metric label used for telemetry and reporting. The mapping is intentionally stable and stringly-typed so callers can emit compact platform-agnostic tags.

**Data flow**: Reads `self` as a `SandboxType` enum variant and returns a `'static` string slice: `none`, `seatbelt`, `seccomp`, or `windows_sandbox`. It does not mutate any state or consult external configuration.

**Call relations**: This is a leaf conversion helper on the enum itself, used wherever sandbox mode needs to be recorded in metrics rather than executed.


##### `get_platform_sandbox`  (lines 50–64)

```
fn get_platform_sandbox(windows_sandbox_enabled: bool) -> Option<SandboxType>
```

**Purpose**: Chooses the sandbox implementation available on the current target OS, with Windows gated by the caller's sandbox-enable flag. It abstracts compile-time platform detection into a single decision point.

**Data flow**: Consumes `windows_sandbox_enabled: bool` and evaluates `cfg!(target_os = ...)` branches. It returns `Some(MacosSeatbelt)`, `Some(LinuxSeccomp)`, `Some(WindowsRestrictedToken)`, or `None` when the platform has no supported sandbox or Windows sandboxing is disabled.

**Call relations**: It is invoked by `SandboxManager::select_initial` after preference and policy checks determine that a platform sandbox should be considered.

*Call graph*: called by 1 (select_initial); 1 external calls (cfg!).


##### `with_managed_mitm_ca_readable_root`  (lines 66–85)

```
fn with_managed_mitm_ca_readable_root(
    permission_profile: PermissionProfile,
    managed_mitm_ca_trust_bundle_path: Option<&AbsolutePathBuf>,
    sandbox_policy_cwd: &Path,
) -> PermissionProfile
```

**Purpose**: Extends a permission profile so a managed MITM CA trust bundle becomes readable inside the sandbox when such a bundle is configured. This prevents managed-network interception from breaking because the launched process cannot read the injected CA file.

**Data flow**: Takes ownership of a `PermissionProfile`, an optional `AbsolutePathBuf` reference for the trust bundle, and the sandbox-policy cwd. If the path is absent it returns the original profile unchanged. Otherwise it splits the profile into runtime file-system and network policies, adds the CA path as an additional readable root relative to `sandbox_policy_cwd`, and rebuilds a new `PermissionProfile` preserving the original enforcement mode.

**Call relations**: Called only from `SandboxManager::transform` after the effective permission profile has been computed and after any network proxy has exposed a managed CA bundle path.

*Call graph*: calls 3 internal fn (enforcement, from_runtime_permissions_with_enforcement, to_runtime_permissions); called by 1 (transform); 1 external calls (from_ref).


##### `SandboxTransformError::fmt`  (lines 152–172)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats each transformation failure into a user-facing error message that includes the invalid URI or platform-specific reason. The messages are concrete enough to explain whether the failure came from cwd conversion, missing Linux sandbox tooling, WSL1 limitations, or unsupported seatbelt usage.

**Data flow**: Reads the enum variant and any embedded fields such as `cwd` and `source`, then writes a formatted string into the provided formatter. It returns the standard formatting result and does not alter error state.

**Call relations**: This is the `Display` implementation for `SandboxTransformError`, used whenever `SandboxManager::transform` errors are surfaced to callers or logs.

*Call graph*: 1 external calls (write!).


##### `SandboxTransformError::source`  (lines 176–186)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Exposes the underlying `io::Error` for cwd-conversion failures while marking synthetic sandbox-selection failures as source-less. This preserves standard error chaining behavior for host path validation problems.

**Data flow**: Matches on `self`; for `InvalidCommandCwd` and `InvalidSandboxPolicyCwd` it returns `Some(&source)`, and for all other variants it returns `None`. No mutation or external I/O occurs.

**Call relations**: This is the `std::error::Error` implementation hook paired with `fmt`, enabling callers of `transform` to inspect nested causes when present.


##### `SandboxManager::new`  (lines 193–195)

```
fn new() -> Self
```

**Purpose**: Constructs the stateless sandbox manager value. Because `SandboxManager` carries no fields, this is effectively a semantic constructor used to make call sites explicit.

**Data flow**: Consumes no inputs and returns `Self`, the zero-sized default manager. It reads and writes no external state.

**Call relations**: It is called by many setup and test paths before they invoke `select_initial` or `transform`, serving as the standard entry into this file's orchestration logic.

*Call graph*: called by 15 (build_exec_request, select_process_exec_tool_sandbox_type, new, file_system_sandbox_context_uses_active_attempt, no_sandbox_attempt_has_no_file_system_context, explicit_escalation_prepares_exec_without_managed_network, prepare_sandboxed_exec, sandbox_exec_request, danger_full_access_defaults_to_no_sandbox_without_network_requirements, danger_full_access_uses_platform_sandbox_with_network_requirements (+5 more)).


##### `SandboxManager::select_initial`  (lines 197–224)

```
fn select_initial(
        &self,
        file_system_policy: &FileSystemSandboxPolicy,
        network_policy: NetworkSandboxPolicy,
        pref: SandboxablePreference,
        windows_sandbox_level
```

**Purpose**: Determines the initial sandbox mode from caller preference and the effective need for platform enforcement. It is the policy gate that decides whether sandboxing is forbidden, mandatory, or automatically inferred from permissions.

**Data flow**: Reads a `FileSystemSandboxPolicy`, `NetworkSandboxPolicy`, `SandboxablePreference`, `WindowsSandboxLevel`, and a boolean indicating managed-network requirements. For `Forbid` it returns `SandboxType::None`; for `Require` it asks `get_platform_sandbox`, treating non-disabled Windows levels as enabled; for `Auto` it first calls `should_require_platform_sandbox` and only then resolves the platform sandbox, defaulting to `None` if unavailable.

**Call relations**: This function is called from the higher-level run flow to choose a sandbox before command transformation. It delegates platform detection to `get_platform_sandbox` and policy necessity checks to `should_require_platform_sandbox`.

*Call graph*: calls 2 internal fn (get_platform_sandbox, should_require_platform_sandbox); called by 1 (run).


##### `SandboxManager::transform`  (lines 226–338)

```
fn transform(
        &self,
        request: SandboxTransformRequest<'_>,
    ) -> Result<SandboxExecRequest, SandboxTransformError>
```

**Purpose**: Validates a high-level sandbox launch request and converts it into a concrete `SandboxExecRequest` ready for execution on the host. It is responsible for path validation, permission-profile merging, managed-network adjustments, and platform-specific command rewriting.

**Data flow**: Consumes a `SandboxTransformRequest` containing the command, base permissions, sandbox choice, network/proxy context, cwd URIs, Linux sandbox executable path, Landlock mode, and Windows sandbox settings. It converts both `PathUri` values to `AbsolutePathBuf` or returns `InvalidCommandCwd`/`InvalidSandboxPolicyCwd`; extracts and removes `additional_permissions` from the command; derives a managed MITM CA path from `network`; computes `effective_permission_profile` via policy transforms and `with_managed_mitm_ca_readable_root`; derives runtime file-system and network policies; builds an `argv` from `program` plus `args`; then rewrites that command depending on `sandbox`. macOS prepends the seatbelt executable and generated seatbelt args; Linux requires `codex_linux_sandbox_exe`, computes whether proxy networking must be allowed, optionally rejects unsupported WSL1+bubblewrap combinations, generates Linux sandbox args, prepends the sandbox executable, and may set `arg0`; unsandboxed and Windows modes keep the original command strings. Finally it returns a `SandboxExecRequest` containing the rewritten command, native cwd values, cloned environment and network proxy, sandbox metadata, effective permissions, and optional `arg0` override.

**Call relations**: This is the file's central execution-preparation routine, called by `env_for` after a sandbox type has already been chosen. It delegates permission shaping to `effective_permission_profile` and `with_managed_mitm_ca_readable_root`, command-string normalization to `os_argv_to_strings`/`os_string_to_command_component`, Linux safety checks to `ensure_linux_bubblewrap_is_supported`, Linux argument generation to `create_linux_sandbox_command_args_for_permission_profile`, and Linux `argv[0]` handling to `linux_sandbox_arg0_override`.

*Call graph*: calls 9 internal fn (is_wsl1, allow_network_for_proxy, create_linux_sandbox_command_args_for_permission_profile, ensure_linux_bubblewrap_is_supported, linux_sandbox_arg0_override, os_argv_to_strings, os_string_to_command_component, with_managed_mitm_ca_readable_root, effective_permission_profile); called by 1 (env_for); 1 external calls (with_capacity).


##### `compatibility_sandbox_policy_for_permission_profile`  (lines 341–351)

```
fn compatibility_sandbox_policy_for_permission_profile(
    permissions: &PermissionProfile,
    cwd: &Path,
) -> SandboxPolicy
```

**Purpose**: Converts a modern `PermissionProfile` into the older `SandboxPolicy` representation expected by compatibility paths. It prefers the profile's native legacy conversion and falls back to a reconstructed workspace-write policy when that conversion fails.

**Data flow**: Reads a `PermissionProfile` and cwd path. It first calls `to_legacy_sandbox_policy(cwd)` and returns that result on success; on error it derives runtime file-system and network policies from the profile and passes them to `compatibility_workspace_write_policy`, returning the synthesized `SandboxPolicy`.

**Call relations**: This function serves compatibility consumers outside the main transform path, bridging newer permission modeling to older protocol-level sandbox policy structures.

*Call graph*: calls 1 internal fn (to_legacy_sandbox_policy).


##### `compatibility_workspace_write_policy`  (lines 353–382)

```
fn compatibility_workspace_write_policy(
    file_system_policy: FileSystemSandboxPolicy,
    network_policy: NetworkSandboxPolicy,
    cwd: &Path,
) -> SandboxPolicy
```

**Purpose**: Builds a conservative legacy `SandboxPolicy::WorkspaceWrite` from runtime file-system and network policies. The fallback preserves writable roots and network enablement while explicitly deciding whether `TMPDIR` and `/tmp` should be excluded.

**Data flow**: Consumes a `FileSystemSandboxPolicy`, `NetworkSandboxPolicy`, and cwd path. It attempts to canonicalize cwd into an `AbsolutePathBuf`, gathers writable roots relative to cwd, strips each root wrapper to its `root` path, filters out a root equal to cwd itself, checks whether the `TMPDIR` environment variable names a writable absolute path, checks whether `/tmp` exists as an absolute directory and is writable, and returns `SandboxPolicy::WorkspaceWrite` with `writable_roots`, `network_access`, and exclusion booleans inverted from those writability checks.

**Call relations**: It is only reached from `compatibility_sandbox_policy_for_permission_profile` when direct legacy conversion fails, acting as the compatibility fallback constructor.

*Call graph*: calls 4 internal fn (can_write_path_with_cwd, get_writable_roots_with_cwd, is_enabled, from_absolute_path); 2 external calls (new, var_os).


##### `ensure_linux_bubblewrap_is_supported`  (lines 385–398)

```
fn ensure_linux_bubblewrap_is_supported(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    use_legacy_landlock: bool,
    allow_network_for_proxy: bool,
    is_wsl1: bool,
) -> Result<(),
```

**Purpose**: Rejects Linux sandbox configurations that would require bubblewrap on WSL1, where that mechanism is unsupported. The check distinguishes configurations that can rely on legacy Landlock/full-disk-write behavior from those that truly need bubblewrap.

**Data flow**: Reads the file-system policy, `use_legacy_landlock`, whether proxy networking requires network allowance, and an `is_wsl1` flag. It computes `requires_bubblewrap` as true when proxy networking must be allowed or when modern Landlock is in use without full disk write access; if both `is_wsl1` and `requires_bubblewrap` are true it returns `Err(Wsl1UnsupportedForBubblewrap)`, otherwise `Ok(())`.

**Call relations**: This Linux-only guard is called from `SandboxManager::transform` immediately before Linux sandbox arguments are generated, preventing construction of an execution request that cannot run on WSL1.

*Call graph*: calls 1 internal fn (has_full_disk_write_access); called by 1 (transform).


##### `os_argv_to_strings`  (lines 400–404)

```
fn os_argv_to_strings(argv: Vec<OsString>) -> Vec<String>
```

**Purpose**: Converts a vector of OS-native command components into UTF-8 `String`s suitable for protocol and launcher layers. It centralizes the lossy conversion policy for non-UTF-8 arguments.

**Data flow**: Consumes `Vec<OsString>`, maps each element through `os_string_to_command_component`, and returns `Vec<String>`. It performs no side effects beyond allocation of the output vector.

**Call relations**: Used by `SandboxManager::transform` in both pass-through and sandbox-wrapping branches so all command construction paths produce the same string representation.

*Call graph*: called by 1 (transform).


##### `os_string_to_command_component`  (lines 406–410)

```
fn os_string_to_command_component(value: OsString) -> String
```

**Purpose**: Turns one `OsString` into a `String`, preserving exact UTF-8 when possible and falling back to lossy conversion otherwise. This avoids panics or hard failures on non-Unicode command components.

**Data flow**: Consumes an `OsString`, attempts `into_string()`, and returns the successful `String` or a `to_string_lossy().into_owned()` fallback. It does not read or write external state.

**Call relations**: This helper underpins `os_argv_to_strings` and is also called directly by Linux command assembly and `linux_sandbox_arg0_override` when executable paths must become command-line strings.

*Call graph*: called by 2 (transform, linux_sandbox_arg0_override); 1 external calls (into_string).


##### `linux_sandbox_arg0_override`  (lines 412–418)

```
fn linux_sandbox_arg0_override(exe: &Path) -> String
```

**Purpose**: Computes the `argv[0]` value that should be presented when launching through the Linux sandbox wrapper. It preserves the actual executable path only when the wrapper binary is already named with the expected sandbox arg0 sentinel; otherwise it forces that sentinel name.

**Data flow**: Reads the sandbox executable `Path`, inspects its file name as UTF-8, and compares it to `CODEX_LINUX_SANDBOX_ARG0`. If they match, it converts the full executable path to a command string via `os_string_to_command_component`; otherwise it returns `CODEX_LINUX_SANDBOX_ARG0.to_string()`.

**Call relations**: Called from the Linux branch of `SandboxManager::transform` after the wrapper executable has been selected, so the resulting `SandboxExecRequest` can carry an explicit `arg0` override for execution.

*Call graph*: calls 1 internal fn (os_string_to_command_component); called by 1 (transform); 2 external calls (as_os_str, file_name).


### `sandboxing/src/bwrap.rs`

`domain_logic` · `sandbox setup`

This file encapsulates the policy and probing logic around using a system-installed `bwrap` binary. It defines user-facing warning strings for three cases: no `bwrap` on `PATH`, inability to create user namespaces, and unsupported WSL1 environments. The top-level `system_bwrap_warning` first asks whether the current `PermissionProfile` actually requires a platform sandbox by converting it to runtime permissions and passing them into `should_require_platform_sandbox`; if not, no warning is produced at all.

When sandboxing is required, the code looks for `bwrap` on `PATH` with `find_system_bwrap_in_path`, which canonicalizes the current working directory and filters out workspace-local `bwrap` binaries unless the cwd is `/`, preventing an untrusted project from shadowing the system tool. `system_bwrap_warning_for_path` then applies environment-specific checks: WSL1 always yields the dedicated warning, a missing path yields the missing-bwrap warning, and an existing path is probed with `system_bwrap_has_user_namespace_access`.

The probe launches `bwrap --unshare-user --unshare-net --ro-bind / / /bin/true`, captures stderr, and polls `try_wait()` until exit or timeout. On exit it switches stderr to nonblocking mode, reads up to 64 KiB, and treats the probe as failed only when the process exited unsuccessfully and stderr matches one of several known namespace-related substrings. Timeouts, spawn failures, and wait errors are intentionally treated as non-fatal (`true`) so Codex avoids warning on ambiguous or transient probe failures. WSL1 detection parses `/proc/version`, recognizing both explicit `WSL1` markers and older Microsoft-kernel signatures while excluding `microsoft-standard` WSL2/native cases.

#### Function details

##### `system_bwrap_warning`  (lines 40–47)

```
fn system_bwrap_warning(permission_profile: &PermissionProfile) -> Option<String>
```

**Purpose**: Returns a user-facing warning string when the current permission profile requires Linux sandboxing but the system `bwrap` is missing or unsuitable.

**Data flow**: Reads a `PermissionProfile`, calls `should_warn_about_system_bwrap`, and if that returns false immediately returns `None`. Otherwise it discovers a candidate path with `find_system_bwrap_in_path`, passes the optional path into `system_bwrap_warning_for_path`, and returns that optional warning string.

**Call relations**: This is the public entry point used by higher-level sandbox setup code. It first gates on policy necessity, then delegates environment/path-specific reasoning to the lower-level helpers.

*Call graph*: calls 3 internal fn (find_system_bwrap_in_path, should_warn_about_system_bwrap, system_bwrap_warning_for_path).


##### `should_warn_about_system_bwrap`  (lines 49–56)

```
fn should_warn_about_system_bwrap(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: Determines whether the active permission profile actually needs a platform sandbox, which is the prerequisite for any `bwrap` warning.

**Data flow**: Takes a `PermissionProfile`, converts it to `(file_system_policy, network_policy)` via `to_runtime_permissions`, and passes those values plus `false` for managed-network requirements into `should_require_platform_sandbox`. It returns the resulting boolean.

**Call relations**: This helper is called only by `system_bwrap_warning` to avoid probing or warning in profiles that do not require Linux sandbox enforcement.

*Call graph*: calls 2 internal fn (to_runtime_permissions, should_require_platform_sandbox); called by 1 (system_bwrap_warning).


##### `system_bwrap_warning_for_path`  (lines 58–72)

```
fn system_bwrap_warning_for_path(system_bwrap_path: Option<&Path>) -> Option<String>
```

**Purpose**: Maps a discovered `bwrap` path, or lack of one, into the specific warning message that should be shown to the user.

**Data flow**: Accepts `Option<&Path>`. It first checks `is_wsl1`; if true, it returns the WSL1 warning string. Otherwise, if the path is `None`, it returns the missing-bwrap warning. If a path exists, it probes namespace access with `system_bwrap_has_user_namespace_access`; a failed probe returns the user-namespace warning, and a successful probe returns `None`.

**Call relations**: This function is the decision core beneath `system_bwrap_warning`. It delegates environment detection to `is_wsl1` and executable probing to `system_bwrap_has_user_namespace_access`.

*Call graph*: calls 2 internal fn (is_wsl1, system_bwrap_has_user_namespace_access); called by 1 (system_bwrap_warning).


##### `system_bwrap_has_user_namespace_access`  (lines 74–136)

```
fn system_bwrap_has_user_namespace_access(system_bwrap_path: &Path, timeout: Duration) -> bool
```

**Purpose**: Runs a short-lived `bwrap` probe command and decides whether failures indicate missing user-namespace permissions.

**Data flow**: Takes a `bwrap` path and timeout. It spawns `Command::new(system_bwrap_path)` with `--unshare-user`, `--unshare-net`, `--ro-bind / /`, and `/bin/true`, discarding stdout and piping stderr. If spawn fails it returns `true`. It then polls `child.try_wait()` until exit, timeout, or wait error. On exit it takes stderr, marks the fd nonblocking with `libc::fcntl`, reads up to `SYSTEM_BWRAP_PROBE_STDERR_LIMIT_BYTES`, constructs an `Output`, and returns `output.status.success() || !is_user_namespace_failure(&output)`. On timeout or wait error it kills and waits for the child and returns `true`.

**Call relations**: This probe is called from `system_bwrap_warning_for_path` only when a concrete `bwrap` candidate exists. It delegates stderr classification to `is_user_namespace_failure` and intentionally treats ambiguous probe failures as acceptable to avoid false-positive warnings.

*Call graph*: calls 1 internal fn (is_user_namespace_failure); called by 1 (system_bwrap_warning_for_path); 6 external calls (now, null, piped, new, new, sleep).


##### `is_wsl1`  (lines 138–141)

```
fn is_wsl1() -> bool
```

**Purpose**: Detects whether the current Linux environment is WSL1 by inspecting `/proc/version`.

**Data flow**: Reads `/proc/version` as a string and returns `true` only if the read succeeds and `proc_version_indicates_wsl1` reports a WSL1 signature. Read failures yield `false`.

**Call relations**: This helper is used by `system_bwrap_warning_for_path` and other sandbox policy transforms to short-circuit unsupported WSL1 environments before attempting normal `bwrap` probing.

*Call graph*: called by 2 (system_bwrap_warning_for_path, transform); 1 external calls (read_to_string).


##### `proc_version_indicates_wsl1`  (lines 143–159)

```
fn proc_version_indicates_wsl1(proc_version: &str) -> bool
```

**Purpose**: Parses a `/proc/version` string and recognizes WSL1-specific markers while excluding WSL2/native Linux signatures.

**Data flow**: Accepts a proc-version string, lowercases it, then repeatedly searches for `wsl`, parses any immediately following ASCII digits into a version number, and returns true if that version is `1`. If no explicit `wsl1` marker is found, it falls back to checking for `microsoft` without `microsoft-standard`. It returns a boolean and has no side effects.

**Call relations**: This pure parser sits underneath `is_wsl1` and is also directly exercised by tests to cover multiple kernel-version string formats.


##### `is_user_namespace_failure`  (lines 161–166)

```
fn is_user_namespace_failure(output: &Output) -> bool
```

**Purpose**: Classifies a failed `bwrap` probe as a user-namespace permission problem based on known stderr substrings.

**Data flow**: Takes a `std::process::Output`, decodes `output.stderr` lossily as UTF-8, and checks whether any string in the `USER_NAMESPACE_FAILURES` array is contained in that stderr text. It returns `true` on a match.

**Call relations**: This helper is called by `system_bwrap_has_user_namespace_access` after the probe process exits unsuccessfully, separating namespace-related failures from unrelated `bwrap` errors.

*Call graph*: called by 1 (system_bwrap_has_user_namespace_access); 1 external calls (from_utf8_lossy).


##### `find_system_bwrap_in_path`  (lines 168–172)

```
fn find_system_bwrap_in_path() -> Option<PathBuf>
```

**Purpose**: Searches the current `PATH` for a trusted system `bwrap` executable, excluding workspace-local shadow binaries.

**Data flow**: Reads the `PATH` environment variable with `var_os`, obtains the current directory with `current_dir`, splits the path list with `split_paths`, and forwards the iterator plus cwd into `find_system_bwrap_in_search_paths`. Missing `PATH` or cwd causes `None`.

**Call relations**: This is the public discovery helper used by `system_bwrap_warning`. It delegates the actual search and trust filtering to `find_system_bwrap_in_search_paths`.

*Call graph*: calls 1 internal fn (find_system_bwrap_in_search_paths); called by 1 (system_bwrap_warning); 3 external calls (current_dir, split_paths, var_os).


##### `find_system_bwrap_in_search_paths`  (lines 174–191)

```
fn find_system_bwrap_in_search_paths(
    search_paths: impl IntoIterator<Item = PathBuf>,
    cwd: &Path,
) -> Option<PathBuf>
```

**Purpose**: Finds the first executable `bwrap` in a supplied search path list while rejecting candidates inside the current workspace unless the cwd is root.

**Data flow**: Accepts an iterator of `PathBuf` search paths and a cwd path. It joins the search paths into an OS search path, canonicalizes the cwd with fallback to the original path, computes whether cwd is root by checking `parent().is_none()`, then calls `which::which_in_all` for `SYSTEM_BWRAP_PROGRAM`. It canonicalizes each candidate path and returns the first one that is not under the cwd when cwd is non-root; otherwise it returns `None` if no acceptable candidate exists.

**Call relations**: This helper underlies `find_system_bwrap_in_path` and contains the trust policy that prevents a project-local `./bwrap` from being mistaken for the system sandbox binary.

*Call graph*: called by 1 (find_system_bwrap_in_path); 4 external calls (parent, join_paths, canonicalize, which_in_all).


### `sandboxing/src/landlock.rs`

`domain_logic` · `sandbox setup`

This file contains the Linux sandbox helper argument-construction logic and almost no runtime behavior beyond string assembly. It defines `CODEX_LINUX_SANDBOX_ARG0`, the basename used when the main executable reinvokes itself as the sandbox helper, and two related builders for helper argv.

`allow_network_for_proxy` is a tiny policy helper: it simply mirrors the `enforce_managed_network` flag, encoding the rule that proxy-only networking is requested only when managed network requirements are active. The main exported builder, `create_linux_sandbox_command_args_for_permission_profile`, serializes a `PermissionProfile` to JSON, converts both `sandbox_policy_cwd` and `command_cwd` to UTF-8 strings with panic-on-invalid-UTF-8 semantics, and constructs an argument vector beginning with `--sandbox-policy-cwd`, `--command-cwd`, and `--permission-profile`. It then conditionally appends `--use-legacy-landlock` only when legacy landlock is requested and proxy networking is not, because proxy-only networking requires bubblewrap's isolated network namespace. If proxy networking is enabled, it appends `--allow-network-for-proxy` instead. Finally it inserts `--` as an option separator and extends the vector with the original command.

The private `create_linux_sandbox_command_args` performs the same assembly without embedding a permission profile, and exists mainly for tests and non-profile-based call sites. A key invariant across both builders is argv ordering: helper flags always precede `--`, and the permission-profile flag appears before feature flags so the generated CLI matches the helper's parser expectations.

#### Function details

##### `allow_network_for_proxy`  (lines 8–13)

```
fn allow_network_for_proxy(enforce_managed_network: bool) -> bool
```

**Purpose**: Encodes the policy for whether the Linux sandbox helper should permit proxy-only networking.

**Data flow**: Takes a boolean `enforce_managed_network` and returns that same boolean unchanged. It reads and writes no external state.

**Call relations**: Higher-level sandbox launch code calls this helper before building helper argv, using it as the single place that maps managed-network enforcement to the proxy-network flag.

*Call graph*: called by 3 (run_command_under_sandbox, spawn_command_under_linux_sandbox, transform).


##### `create_linux_sandbox_command_args_for_permission_profile`  (lines 23–60)

```
fn create_linux_sandbox_command_args_for_permission_profile(
    command: Vec<String>,
    command_cwd: &Path,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &Path,
    use_legacy
```

**Purpose**: Builds the full `codex-linux-sandbox` argument vector for a command when a serialized `PermissionProfile` must be passed to the helper.

**Data flow**: Consumes the original command vector, borrows `command_cwd`, `permission_profile`, and `sandbox_policy_cwd`, plus booleans for legacy landlock and proxy networking. It serializes the permission profile to JSON, converts both paths to UTF-8 strings or panics, initializes a `Vec<String>` with `--sandbox-policy-cwd`, `--command-cwd`, and `--permission-profile` pairs, conditionally appends `--use-legacy-landlock` only when legacy mode is requested and proxy networking is off, conditionally appends `--allow-network-for-proxy` when proxy networking is on, pushes `--`, extends with the original command, and returns the completed argv vector.

**Call relations**: This is the main builder used by Linux sandbox execution paths such as command running and spawning. It centralizes the precedence rule where proxy networking suppresses the legacy-landlock flag.

*Call graph*: called by 3 (run_command_under_sandbox, spawn_command_under_linux_sandbox, transform); 3 external calls (to_str, to_string, vec!).


##### `create_linux_sandbox_command_args`  (lines 65–103)

```
fn create_linux_sandbox_command_args(
    command: Vec<String>,
    command_cwd: &Path,
    sandbox_policy_cwd: &Path,
    use_legacy_landlock: bool,
    allow_network_for_proxy: bool,
) -> Vec<String
```

**Purpose**: Builds the helper argument vector for a command when no permission-profile JSON needs to be included.

**Data flow**: Consumes the command vector and borrows `command_cwd` and `sandbox_policy_cwd`, plus booleans for legacy landlock and proxy networking. It converts both paths to UTF-8 strings or panics, builds a `Vec<String>` containing `--sandbox-policy-cwd` and `--command-cwd`, conditionally appends `--use-legacy-landlock` or `--allow-network-for-proxy` using the same precedence rule as the profile-based builder, inserts `--`, extends with the original command, and returns the argv vector.

**Call relations**: This private helper mirrors the exported profile-based builder and is exercised by tests to validate flag ordering and precedence independently of permission-profile serialization.

*Call graph*: 2 external calls (to_str, vec!).


### Linux sandbox execution
These files implement the Linux-side sandbox mechanisms and launcher path, from command wrapping through bubblewrap and Landlock enforcement to final executable dispatch.

### `core/src/landlock.rs`

`orchestration` · `tool/process launch`

This file contains a single async adapter, `spawn_command_under_linux_sandbox`, used when shell tools must run under the Linux sandbox helper (`codex-linux-sandbox`). The function derives two separate pieces of sandbox state from the supplied `PermissionProfile`: a `network_sandbox_policy` retained for the child-spawn layer, and the helper command-line arguments produced by `create_linux_sandbox_command_args_for_permission_profile`. Those arguments are built from the requested command vector, the command working directory, the policy working directory, the legacy-Landlock toggle, and a proxy-network allowance computed by `allow_network_for_proxy(false)`.

A subtle design choice is the `arg0` handling. If the provided executable path already ends with the helper alias basename `CODEX_LINUX_SANDBOX_ARG0`, the function preserves that real path string as argv0 so older bubblewrap builds lacking `--argv0` still dispatch correctly. Otherwise it forces argv0 to the canonical helper alias string. Finally it packages everything into `SpawnChildRequest`—program path, helper args, cwd, network policy, optional `NetworkProxy`, stdio policy, and environment map—and delegates to `spawn_child_async`. The result is a `tokio::process::Child` representing the sandboxed helper process, not the raw target command directly.

#### Function details

##### `spawn_command_under_linux_sandbox`  (lines 22–70)

```
async fn spawn_command_under_linux_sandbox(
    codex_linux_sandbox_exe: P,
    command: Vec<String>,
    command_cwd: AbsolutePathBuf,
    permission_profile: &PermissionProfile,
    sandbox_policy_c
```

**Purpose**: Builds and launches a sandbox-helper process that will execute the requested command under Linux filesystem and network restrictions. It centralizes the Linux-specific argument construction and argv0 compatibility behavior.

**Data flow**: Accepts the sandbox helper executable path, target `command: Vec<String>`, `command_cwd: AbsolutePathBuf`, `permission_profile`, sandbox policy cwd, legacy-Landlock flag, `StdioPolicy`, optional `NetworkProxy`, and environment `HashMap<String, String>`. It reads `permission_profile.network_sandbox_policy()`, computes helper args with `create_linux_sandbox_command_args_for_permission_profile(...)`, derives an `arg0` string based on the helper executable basename, then submits a `SpawnChildRequest` to `spawn_child_async`. Returns `std::io::Result<tokio::process::Child>`.

**Call relations**: This function is the Linux sandbox spawning entrypoint for callers that already decided to sandbox a command. It delegates policy translation to `codex_sandboxing::landlock` helpers and actual child-process creation to `spawn_child_async`.

*Call graph*: calls 5 internal fn (spawn_child_async, network_sandbox_policy, allow_network_for_proxy, create_linux_sandbox_command_args_for_permission_profile, as_path); 4 external calls (as_ref, file_name, to_path_buf, to_string_lossy).


### `linux-sandbox/src/landlock.rs`

`domain_logic` · `sandbox setup inside the helper thread before exec`

This module is the Linux restriction layer applied inside the helper process after argument parsing has resolved a `PermissionProfile`. The top-level function, `apply_permission_profile_to_current_thread`, derives runtime filesystem and network policies from the profile, computes whether a network seccomp filter is needed, and conditionally enables `PR_SET_NO_NEW_PRIVS`. That condition is intentionally narrow: many bubblewrap deployments rely on setuid behavior, so `no_new_privs` is only enabled when seccomp must be installed or when the caller explicitly requested the legacy Landlock filesystem path.

Network policy is represented internally by the private `NetworkSeccompMode` enum. `should_install_network_seccomp` and `network_seccomp_mode` encode a subtle design choice: managed proxy sessions remain fail-closed even when the nominal policy says network is enabled. In restricted mode, the seccomp filter denies a broad set of networking and process-inspection syscalls and allows `socket`/`socketpair` only for `AF_UNIX`; in proxy-routed mode, `socket` is limited to `AF_INET`/`AF_INET6` while `socketpair` remains limited to `AF_UNIX` for local IPC.

The legacy filesystem path uses Landlock ABI v5 with best-effort compatibility. It grants read access to `/`, read-write to `/dev/null`, and read-write to the computed writable roots. It explicitly rejects profiles that require restricted read-only carveouts because that shape is unsupported by this backend. If Landlock reports `NotEnforced`, the code converts that into a sandbox error rather than silently proceeding.

#### Function details

##### `apply_permission_profile_to_current_thread`  (lines 42–88)

```
fn apply_permission_profile_to_current_thread(
    permission_profile: &PermissionProfile,
    cwd: &Path,
    apply_landlock_fs: bool,
    allow_network_for_proxy: bool,
    proxy_routed_network: boo
```

**Purpose**: Applies the resolved permission profile to the current thread by enabling `no_new_privs` when needed, installing a network seccomp filter when required, and optionally applying legacy Landlock filesystem rules. It is the single entry point for in-process restriction enforcement.

**Data flow**: Consumes `permission_profile`, `cwd`, `apply_landlock_fs`, `allow_network_for_proxy`, and `proxy_routed_network`. It derives `(file_system_sandbox_policy, network_sandbox_policy)` from `to_runtime_permissions()`, computes an optional `NetworkSeccompMode`, conditionally calls `set_no_new_privs`, conditionally installs seccomp, rejects unsupported legacy read-only filesystem restrictions with `CodexErr::UnsupportedOperation`, computes writable roots from the filesystem policy plus cwd, and may install Landlock rules. Returns `Result<()>`, writing only kernel sandbox state on success.

**Call relations**: Invoked by `run_main` in both the direct-exec path and the inner post-bubblewrap stage. Depending on policy shape, it delegates to `network_seccomp_mode`, `set_no_new_privs`, `install_network_seccomp_filter_on_current_thread`, and `install_filesystem_landlock_rules_on_current_thread` to perform the concrete kernel operations.

*Call graph*: calls 5 internal fn (install_filesystem_landlock_rules_on_current_thread, install_network_seccomp_filter_on_current_thread, network_seccomp_mode, set_no_new_privs, to_runtime_permissions); called by 1 (run_main); 1 external calls (UnsupportedOperation).


##### `should_install_network_seccomp`  (lines 96–103)

```
fn should_install_network_seccomp(
    network_sandbox_policy: NetworkSandboxPolicy,
    allow_network_for_proxy: bool,
) -> bool
```

**Purpose**: Decides whether any network seccomp filter should be installed at all. It treats managed proxy mode as requiring seccomp even when the nominal network policy is fully enabled.

**Data flow**: Reads `network_sandbox_policy` and `allow_network_for_proxy`, checks `network_sandbox_policy.is_enabled()`, and returns `true` when the policy is restricted or when proxy-managed routing should force fail-closed behavior. It does not mutate state.

**Call relations**: This is the first decision point inside `network_seccomp_mode`. The caller uses it to distinguish between 'skip seccomp entirely' and 'install one of the concrete seccomp modes.'

*Call graph*: calls 1 internal fn (is_enabled); called by 1 (network_seccomp_mode).


##### `network_seccomp_mode`  (lines 105–117)

```
fn network_seccomp_mode(
    network_sandbox_policy: NetworkSandboxPolicy,
    allow_network_for_proxy: bool,
    proxy_routed_network: bool,
) -> Option<NetworkSeccompMode>
```

**Purpose**: Maps the external network policy plus proxy-routing flags into an internal seccomp mode or `None`. It separates the 'whether' decision from the 'which filter shape' decision.

**Data flow**: Reads `network_sandbox_policy`, `allow_network_for_proxy`, and `proxy_routed_network`; calls `should_install_network_seccomp`; returns `None` if no filter is needed, `Some(ProxyRouted)` if proxy routing is active, otherwise `Some(Restricted)`. No external state is changed.

**Call relations**: Called by `apply_permission_profile_to_current_thread` before any kernel changes are made. Its output directly controls whether `set_no_new_privs` and `install_network_seccomp_filter_on_current_thread` run, and which syscall rules that installer builds.

*Call graph*: calls 1 internal fn (should_install_network_seccomp); called by 1 (apply_permission_profile_to_current_thread).


##### `set_no_new_privs`  (lines 120–126)

```
fn set_no_new_privs() -> Result<()>
```

**Purpose**: Enables Linux `PR_SET_NO_NEW_PRIVS` on the current thread so seccomp can be installed safely and privilege elevation via setuid is blocked. It wraps the raw `prctl` call in the crate's `Result` type.

**Data flow**: Calls `libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)`, converts a nonzero result into `std::io::Error::last_os_error().into()`, and otherwise returns `Ok(())`. It mutates kernel task state for the current thread.

**Call relations**: Used only from `apply_permission_profile_to_current_thread`, and only when seccomp or legacy Landlock enforcement requires it. It is intentionally isolated so the policy logic can decide when this irreversible process attribute should be set.

*Call graph*: called by 1 (apply_permission_profile_to_current_thread); 2 external calls (last_os_error, prctl).


##### `install_filesystem_landlock_rules_on_current_thread`  (lines 137–163)

```
fn install_filesystem_landlock_rules_on_current_thread(
    writable_roots: Vec<AbsolutePathBuf>,
) -> Result<()>
```

**Purpose**: Builds and applies a Landlock ruleset that allows read access everywhere, grants write access to `/dev/null` and selected writable roots, and then restricts the current thread. It is the legacy filesystem backend retained as a fallback/reference path.

**Data flow**: Takes `writable_roots: Vec<AbsolutePathBuf>`, selects `ABI::V5`, derives read-write and read-only `AccessFs` masks, constructs a `Ruleset` with best-effort compatibility, adds path-beneath rules for `/`, `/dev/null`, and optionally the writable roots, sets `no_new_privs`, calls `restrict_self`, and returns `Ok(())` unless the resulting status reports `NotEnforced`, in which case it returns `CodexErr::Sandbox(SandboxErr::LandlockRestrict)`. It writes Landlock restrictions into current-thread kernel state.

**Call relations**: Reached from `apply_permission_profile_to_current_thread` only when the caller explicitly enables legacy Landlock and the filesystem policy is not full-write. It is skipped entirely in the normal bubblewrap pipeline.

*Call graph*: called by 1 (apply_permission_profile_to_current_thread); 5 external calls (from_all, from_read, default, path_beneath_rules, Sandbox).


##### `install_network_seccomp_filter_on_current_thread`  (lines 169–268)

```
fn install_network_seccomp_filter_on_current_thread(
    mode: NetworkSeccompMode,
) -> std::result::Result<(), SandboxErr>
```

**Purpose**: Constructs a seccomp BPF program for either restricted networking or proxy-routed networking and applies it to the current thread. The filter also blocks several process-inspection and io_uring syscalls regardless of mode.

**Data flow**: Accepts `mode: NetworkSeccompMode`, builds a `BTreeMap<i64, Vec<SeccompRule>>` keyed by syscall number, inserts unconditional deny entries for ptrace/process-vm/io_uring syscalls, then adds mode-specific rules: restricted mode denies many socket operations and allows `socket`/`socketpair` only for `AF_UNIX`; proxy-routed mode allows IP-family `socket` and only `AF_UNIX` `socketpair`. It then creates a `SeccompFilter` with default `Allow` and match action `Errno(EPERM)`, selects `TargetArch` via compile-time cfg, converts to `BpfProgram`, applies it with `apply_filter`, and returns `Result<(), SandboxErr>`. It mutates current-thread seccomp state.

**Call relations**: Called by `apply_permission_profile_to_current_thread` when `network_seccomp_mode` returns `Some`. It is the concrete enforcement step behind both restricted-network sessions and managed proxy-routed sessions.

*Call graph*: called by 1 (apply_permission_profile_to_current_thread); 8 external calls (new, Errno, new, new, cfg!, apply_filter, unimplemented!, vec!).


##### `tests::managed_network_enforces_seccomp_even_for_full_network_policy`  (lines 279–287)

```
fn managed_network_enforces_seccomp_even_for_full_network_policy()
```

**Purpose**: Checks that managed proxy mode forces seccomp installation even when the external network policy is enabled. This protects the fail-closed design for managed networking.

**Data flow**: Calls `should_install_network_seccomp(NetworkSandboxPolicy::Enabled, true)` and asserts the result is `true`. It reads no external state and writes none.

**Call relations**: This test exercises the policy branch where proxy management overrides the usual 'enabled network means no seccomp' behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::full_network_policy_without_managed_network_skips_seccomp`  (lines 290–298)

```
fn full_network_policy_without_managed_network_skips_seccomp()
```

**Purpose**: Verifies that a fully enabled network policy without managed proxy routing does not install network seccomp. It captures the normal unrestricted-network case.

**Data flow**: Calls `should_install_network_seccomp(NetworkSandboxPolicy::Enabled, false)` and asserts the result is `false`. No state is mutated.

**Call relations**: This test covers the opposite branch from the managed-network case, confirming that seccomp is omitted when unrestricted networking is genuinely allowed.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::restricted_network_policy_always_installs_seccomp`  (lines 301–310)

```
fn restricted_network_policy_always_installs_seccomp()
```

**Purpose**: Confirms that restricted network policy always results in seccomp installation, regardless of the proxy-management flag. It validates the invariant that restricted means filtered.

**Data flow**: Invokes `should_install_network_seccomp` twice with `NetworkSandboxPolicy::Restricted` and both boolean values for `allow_network_for_proxy`, asserting both are true. It only reads pure function outputs.

**Call relations**: This test locks down the core restricted-network behavior that `network_seccomp_mode` depends on before choosing a concrete mode.

*Call graph*: 1 external calls (assert!).


##### `tests::managed_proxy_routes_use_proxy_routed_seccomp_mode`  (lines 313–322)

```
fn managed_proxy_routes_use_proxy_routed_seccomp_mode()
```

**Purpose**: Verifies that when managed proxy routing is active, the selected seccomp mode is `ProxyRouted`. This ensures the installer will allow only the socket families needed for the bridge design.

**Data flow**: Calls `network_seccomp_mode(NetworkSandboxPolicy::Enabled, true, true)` and asserts it returns `Some(NetworkSeccompMode::ProxyRouted)`. No state changes occur.

**Call relations**: This test covers the branch where seccomp is required and proxy routing is active, feeding directly into the `ProxyRouted` rule set in the installer.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::restricted_network_without_proxy_routing_uses_restricted_mode`  (lines 325–334)

```
fn restricted_network_without_proxy_routing_uses_restricted_mode()
```

**Purpose**: Checks that ordinary restricted networking selects the `Restricted` seccomp mode. It validates the default deny-network filter path.

**Data flow**: Calls `network_seccomp_mode(NetworkSandboxPolicy::Restricted, false, false)` and asserts it returns `Some(NetworkSeccompMode::Restricted)`. It is pure and side-effect free.

**Call relations**: This test exercises the common restricted-network branch that leads to the broader syscall deny list in `install_network_seccomp_filter_on_current_thread`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::full_network_without_managed_proxy_skips_network_seccomp_mode`  (lines 337–346)

```
fn full_network_without_managed_proxy_skips_network_seccomp_mode()
```

**Purpose**: Verifies that unrestricted networking with no managed proxy routing yields no seccomp mode at all. This confirms the code can intentionally skip seccomp installation.

**Data flow**: Calls `network_seccomp_mode(NetworkSandboxPolicy::Enabled, false, false)` and asserts the result is `None`. No state is modified.

**Call relations**: This test validates the `None` branch consumed by `apply_permission_profile_to_current_thread`, where neither `set_no_new_privs` nor network seccomp should run for networking reasons.

*Call graph*: 1 external calls (assert_eq!).


### `linux-sandbox/src/bwrap.rs`

`domain_logic` · `sandbox setup before launching a Linux command`

This is the main Linux sandbox policy engine. It converts high-level filesystem policy objects into `BwrapArgs`, which contain the bubblewrap argv fragment plus bookkeeping for preserved file descriptors, synthetic mount targets, and protected-create targets. The top-level fast path in `create_bwrap_command_args` skips bubblewrap entirely only when the policy grants full disk write access, there are no unreadable glob patterns to materialize, and network mode is `FullAccess`; otherwise it builds either a full-filesystem wrapper or a split filesystem overlay.

The heart of the file is `create_filesystem_args`. It computes writable roots, readable roots, unreadable roots, and unreadable glob expansions; skips missing writable roots; optionally injects Linux platform-default readable roots for `:minimal`; and then emits mounts in a carefully ordered sequence so later binds override earlier ones correctly. It starts from either `--ro-bind / /` or `--tmpfs /`, always mounts `--dev /dev`, masks unreadable ancestors of writable roots first, rebinds writable roots, reapplies read-only subpaths and protected metadata names (`.git`, `.agents`, `.codex`), then reapplies nested unreadable carveouts and unrelated unreadable roots. Symlink handling is intentionally fail-closed: writable roots may be rebound to canonical targets, but deny-read or read-only carveouts crossing writable symlink components produce fatal errors because a mutable symlink would make target-based masking racy.

The file also handles missing protected paths by synthesizing empty file or empty directory mounts, tracks whether those placeholders correspond to pre-existing empty host paths via `FileIdentity`, expands unreadable glob patterns with ripgrep (falling back to an internal glob walker), and normalizes command cwd to a canonical path when needed so the sandboxed process starts in a mounted location that actually exists. The extensive tests document many subtle invariants: mount ordering, symlink remapping, metadata carveouts, unreadable glob depth limits, and the distinction between transient synthetic targets and real pre-existing empty paths.

#### Function details

##### `BwrapOptions::default`  (lines 76–82)

```
fn default() -> Self
```

**Purpose**: Provides the secure default bubblewrap options used by most callers.

**Data flow**: Reads no inputs → returns `BwrapOptions { mount_proc: true, network_mode: BwrapNetworkMode::FullAccess, glob_scan_max_depth: None }`.

**Call relations**: Used by callers and tests as the baseline option set before overriding specific fields.

*Call graph*: called by 2 (full_disk_write_with_unreadable_glob_still_wraps_and_masks_match, restricted_policy_chdirs_to_canonical_command_cwd).


##### `BwrapNetworkMode::should_unshare_network`  (lines 101–103)

```
fn should_unshare_network(self) -> bool
```

**Purpose**: Reports whether the selected network mode requires `--unshare-net`.

**Data flow**: Reads `self` → returns `false` only for `FullAccess`, `true` for `Isolated` and `ProxyOnly`.

**Call relations**: Consulted by both full-filesystem and split-filesystem bubblewrap argument builders.

*Call graph*: 1 external calls (matches!).


##### `FileIdentity::from_metadata`  (lines 121–126)

```
fn from_metadata(metadata: &Metadata) -> Self
```

**Purpose**: Captures a stable `(dev, ino)` identity for an existing filesystem object.

**Data flow**: Takes `&Metadata` → reads `metadata.dev()` and `metadata.ino()` → returns `FileIdentity { dev, ino }`.

**Call relations**: Used when recording pre-existing empty synthetic mount targets and when later deciding whether cleanup should remove them.

*Call graph*: called by 3 (existing_empty_directory, existing_empty_file, should_remove_after_bwrap); 2 external calls (dev, ino).


##### `ProtectedCreateTarget::missing`  (lines 150–154)

```
fn missing(path: &Path) -> Self
```

**Purpose**: Records a protected metadata path that did not exist at sandbox setup time.

**Data flow**: Takes `&Path` → clones it into `path.to_path_buf()` → returns `ProtectedCreateTarget { path }`.

**Call relations**: Created while processing writable roots so later cleanup/violation detection can watch for forbidden metadata creation.

*Call graph*: called by 3 (append_protected_create_targets_for_writable_root, cleanup_protected_create_targets_removes_created_path_and_reports_violation, cleanup_protected_create_targets_waits_for_other_active_registrations); 1 external calls (to_path_buf).


##### `ProtectedCreateTarget::path`  (lines 156–158)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the filesystem path tracked by a protected-create target.

**Data flow**: Reads `self.path` → returns `&Path`.

**Call relations**: Used by cleanup/removal code outside this file to inspect tracked protected-create targets.

*Call graph*: called by 1 (try_remove_protected_create_target).


##### `SyntheticMountTarget::missing`  (lines 162–168)

```
fn missing(path: &Path) -> Self
```

**Purpose**: Records a synthetic empty-file mount target for a path that was absent on the host.

**Data flow**: Takes `&Path` → clones it into a `PathBuf`, sets kind `EmptyFile`, and leaves `pre_existing_path = None` → returns the target record.

**Call relations**: Created when masking missing read-only or unreadable file paths with `/dev/null` bind data.

*Call graph*: called by 4 (append_missing_empty_file_bind_data_args, cleanup_synthetic_mount_targets_removes_only_empty_mount_targets, cleanup_synthetic_mount_targets_removes_transient_file_after_concurrent_owner_exits, cleanup_synthetic_mount_targets_waits_for_other_active_registrations); 1 external calls (to_path_buf).


##### `SyntheticMountTarget::missing_empty_directory`  (lines 170–176)

```
fn missing_empty_directory(path: &Path) -> Self
```

**Purpose**: Records a synthetic empty-directory mount target for a missing protected metadata directory.

**Data flow**: Takes `&Path` → clones it into a `PathBuf`, sets kind `EmptyDirectory`, and leaves `pre_existing_path = None` → returns the target record.

**Call relations**: Created when missing protected metadata names such as `.git` are masked with read-only tmpfs directories.

*Call graph*: called by 2 (append_missing_read_only_subpath_args, cleanup_synthetic_mount_targets_removes_only_empty_mount_targets); 1 external calls (to_path_buf).


##### `SyntheticMountTarget::existing_empty_file`  (lines 178–184)

```
fn existing_empty_file(path: &Path, metadata: &Metadata) -> Self
```

**Purpose**: Records that an existing empty file is being reused as a synthetic mount target and should be preserved if unchanged.

**Data flow**: Takes a path and its metadata → clones the path, sets kind `EmptyFile`, stores `Some(FileIdentity::from_metadata(metadata))`, and returns the target record.

**Call relations**: Used when a transient empty protected metadata file already exists and should not be treated as a stable bind source.

*Call graph*: calls 1 internal fn (from_metadata); called by 3 (append_existing_empty_file_bind_data_args, cleanup_synthetic_mount_targets_preserves_real_pre_existing_empty_file, cleanup_synthetic_mount_targets_removes_transient_file_after_concurrent_owner_exits); 1 external calls (to_path_buf).


##### `SyntheticMountTarget::existing_empty_directory`  (lines 186–192)

```
fn existing_empty_directory(path: &Path, metadata: &Metadata) -> Self
```

**Purpose**: Records that an existing empty directory is being reused as a synthetic mount target and should be preserved if unchanged.

**Data flow**: Takes a path and metadata → clones the path, sets kind `EmptyDirectory`, stores the pre-existing file identity, and returns the target record.

**Call relations**: Used when a transient empty protected metadata directory already exists and is masked via a synthetic tmpfs mount.

*Call graph*: calls 1 internal fn (from_metadata); called by 1 (append_existing_empty_directory_args); 1 external calls (to_path_buf).


##### `SyntheticMountTarget::preserves_pre_existing_path`  (lines 194–196)

```
fn preserves_pre_existing_path(&self) -> bool
```

**Purpose**: Reports whether the synthetic target corresponds to a real pre-existing host path.

**Data flow**: Checks whether `self.pre_existing_path.is_some()` → returns the boolean.

**Call relations**: Consumed by cleanup/marker code to distinguish transient synthetic paths from preserved real empties.

*Call graph*: called by 1 (synthetic_mount_marker_contents).


##### `SyntheticMountTarget::path`  (lines 198–200)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the filesystem path associated with a synthetic mount target.

**Data flow**: Reads `self.path` → returns `&Path`.

**Call relations**: Used by cleanup code and tests that inspect synthetic target paths.

*Call graph*: called by 1 (remove_synthetic_mount_target).


##### `SyntheticMountTarget::kind`  (lines 202–204)

```
fn kind(&self) -> SyntheticMountTargetKind
```

**Purpose**: Returns whether the synthetic target represents an empty file or empty directory.

**Data flow**: Reads `self.kind` → returns `SyntheticMountTargetKind` by value.

**Call relations**: Used by cleanup logic to choose file versus directory removal behavior.

*Call graph*: called by 1 (remove_synthetic_mount_target).


##### `SyntheticMountTarget::should_remove_after_bwrap`  (lines 206–224)

```
fn should_remove_after_bwrap(&self, metadata: &Metadata) -> bool
```

**Purpose**: Determines whether a host path should be deleted after bubblewrap exits.

**Data flow**: Takes current `Metadata` for the path → first verifies the path still matches the expected empty-file or empty-directory shape; then, if a pre-existing identity was recorded, compares current `(dev, ino)` against it, otherwise returns `true` for synthetic-only paths.

**Call relations**: Called by cleanup code after sandbox execution to avoid deleting real pre-existing empty paths unless they were replaced.

*Call graph*: calls 1 internal fn (from_metadata); called by 1 (remove_synthetic_mount_target); 2 external calls (file_type, len).


##### `create_bwrap_command_args`  (lines 234–265)

```
fn create_bwrap_command_args(
    command: Vec<String>,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    sandbox_policy_cwd: &Path,
    command_cwd: &Path,
    options: BwrapOptions,
) ->
```

**Purpose**: Top-level entry point that decides whether to skip bubblewrap, use a full-filesystem wrapper, or build a split filesystem overlay.

**Data flow**: Takes the command argv, filesystem policy, sandbox-policy cwd, command cwd, and options → computes unreadable globs from the policy; if full disk write and no unreadable globs, returns either the raw command unchanged or `create_bwrap_flags_full_filesystem(command, options)` depending on network mode; otherwise delegates to `create_bwrap_flags(...)`.

**Call relations**: Called by higher-level sandbox orchestration when preparing to launch a command under Linux.

*Call graph*: calls 4 internal fn (create_bwrap_flags, create_bwrap_flags_full_filesystem, get_unreadable_globs_with_cwd, has_full_disk_write_access); called by 5 (full_disk_write_full_network_returns_unwrapped_command, full_disk_write_proxy_only_keeps_full_filesystem_but_unshares_network, full_disk_write_with_unreadable_glob_still_wraps_and_masks_match, restricted_policy_chdirs_to_canonical_command_cwd, build_bwrap_argv); 1 external calls (new).


##### `create_bwrap_flags_full_filesystem`  (lines 267–294)

```
fn create_bwrap_flags_full_filesystem(command: Vec<String>, options: BwrapOptions) -> BwrapArgs
```

**Purpose**: Builds bubblewrap arguments for the special case of full filesystem access with optional namespace isolation.

**Data flow**: Takes command argv and options → constructs args beginning with `--new-session`, `--die-with-parent`, `--bind / /`, `--unshare-user`, `--unshare-pid`, optionally `--unshare-net`, optionally `--proc /proc`, then `--` and the command → returns `BwrapArgs` with empty preserved/synthetic/protected vectors.

**Call relations**: Used only by `create_bwrap_command_args` when filesystem restrictions are unnecessary but network isolation still requires bubblewrap.

*Call graph*: called by 1 (create_bwrap_command_args); 2 external calls (new, vec!).


##### `create_bwrap_flags`  (lines 297–349)

```
fn create_bwrap_flags(
    command: Vec<String>,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    sandbox_policy_cwd: &Path,
    command_cwd: &Path,
    options: BwrapOptions,
) -> Result
```

**Purpose**: Builds the complete bubblewrap argv for a restricted filesystem policy plus process/network namespace options.

**Data flow**: Takes command argv, policy, sandbox-policy cwd, command cwd, and options → gets filesystem mounts and bookkeeping from `create_filesystem_args`, canonicalizes the command cwd with `normalize_command_cwd_for_bwrap`, prepends session/user/pid/network/proc flags, optionally adds `--chdir <canonical cwd>`, appends `--` and the command, and returns the assembled `BwrapArgs`.

**Call relations**: Main wrapper builder used by `create_bwrap_command_args` for all nontrivial sandbox cases.

*Call graph*: calls 3 internal fn (create_filesystem_args, normalize_command_cwd_for_bwrap, path_to_string); called by 1 (create_bwrap_command_args); 1 external calls (new).


##### `create_filesystem_args`  (lines 367–630)

```
fn create_filesystem_args(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
    glob_scan_max_depth: Option<usize>,
) -> Result<BwrapArgs>
```

**Purpose**: Translates a filesystem sandbox policy into ordered bubblewrap mount/mask arguments plus cleanup metadata.

**Data flow**: Reads policy-derived unreadable globs, writable roots, readable roots, unreadable roots, and project-root metadata carveouts relative to `cwd`; expands unreadable globs; chooses either a read-only-root or tmpfs-root baseline; adds readable roots and platform defaults; computes allowed writable paths including canonical symlink targets; sorts writable and unreadable paths by depth; appends masks for unreadable ancestors, writable root binds, read-only subpaths, protected metadata masks, protected-create targets, nested unreadable masks, and rootless unreadable masks; returns `BwrapArgs` containing argv plus preserved `/dev/null` fd(s), synthetic mount targets, and protected-create targets, or a fatal error on unsafe symlink cases or glob expansion failures.

**Call relations**: Core policy compiler called by `create_bwrap_flags`; many helper functions exist solely to keep this mount-ordering logic correct and testable.

*Call graph*: calls 17 internal fn (append_metadata_path_masks_for_writable_root, append_mount_target_parent_dir_args, append_protected_create_targets_for_writable_root, append_read_only_subpath_args, append_unreadable_root_args, canonical_target_if_symlinked_path, expand_unreadable_globs_with_ripgrep, path_to_string, remap_paths_for_symlink_target, get_readable_roots_with_cwd (+7 more)); called by 24 (create_bwrap_flags, ignores_missing_writable_roots, missing_child_git_under_parent_repo_uses_protected_create_target, missing_project_root_metadata_carveouts_use_metadata_path_masks, missing_read_only_subpath_uses_empty_file_bind_data, missing_user_project_root_subpath_rules_are_still_enforced, mounts_dev_before_writable_dev_binds, protected_symlinked_directory_subpaths_fail_closed, restricted_read_only_uses_scoped_read_roots_instead_of_erroring, restricted_read_only_with_platform_defaults_includes_usr_when_present (+14 more)); 3 external calls (new, with_capacity, vec!).


##### `append_protected_create_targets_for_writable_root`  (lines 632–653)

```
fn append_protected_create_targets_for_writable_root(
    bwrap_args: &mut BwrapArgs,
    protected_metadata_names: &[String],
    root: &Path,
    symlink_target: Option<&Path>,
    read_only_subpath
```

**Purpose**: Registers missing protected metadata paths under a writable root so later cleanup can detect forbidden creation.

**Data flow**: Takes mutable `BwrapArgs`, protected metadata names, the logical root, optional symlink target, and already computed read-only subpaths → for each metadata name, builds the effective path (remapped through the symlink target when needed), skips it if already read-only or already exists, and otherwise pushes `ProtectedCreateTarget::missing(&path)`.

**Call relations**: Called from `create_filesystem_args` after metadata carveouts are computed for each writable root.

*Call graph*: calls 1 internal fn (missing); called by 1 (create_filesystem_args); 2 external calls (join, iter).


##### `append_metadata_path_masks_for_writable_root`  (lines 655–670)

```
fn append_metadata_path_masks_for_writable_root(
    read_only_subpaths: &mut Vec<PathBuf>,
    root: &Path,
    mount_root: &Path,
    protected_metadata_names: &[String],
)
```

**Purpose**: Adds default protected metadata names to the read-only subpath list for a writable root.

**Data flow**: Takes mutable `read_only_subpaths`, the logical root, effective mount root, and protected metadata names → for each name, skips missing `.git` when parent-repo discovery should remain visible, otherwise appends `root.join(name)` if not already present.

**Call relations**: Used by `create_filesystem_args` to enforce `.git`, `.agents`, and `.codex` protections under writable roots.

*Call graph*: calls 1 internal fn (should_leave_missing_git_for_parent_repo_discovery); called by 1 (create_filesystem_args); 1 external calls (join).


##### `should_leave_missing_git_for_parent_repo_discovery`  (lines 672–683)

```
fn should_leave_missing_git_for_parent_repo_discovery(mount_root: &Path, name: &str) -> bool
```

**Purpose**: Decides whether a missing child `.git` path should remain unmasked so Git can discover a parent repository.

**Data flow**: Takes the effective mount root and metadata name → checks that the name is `.git`, that `mount_root/.git` is missing, and that some ancestor directory has valid Git metadata according to `ancestor_has_git_metadata` → returns the boolean result.

**Call relations**: Called only from `append_metadata_path_masks_for_writable_root` to preserve parent-repo discovery semantics.

*Call graph*: called by 1 (append_metadata_path_masks_for_writable_root); 3 external calls (ancestors, join, matches!).


##### `ancestor_has_git_metadata`  (lines 685–698)

```
fn ancestor_has_git_metadata(ancestor: &Path) -> bool
```

**Purpose**: Recognizes whether an ancestor directory contains a real Git repository marker.

**Data flow**: Builds `ancestor/.git`, reads symlink metadata, and returns `true` if it is a directory containing `HEAD` or a file whose contents start with `gitdir:`; otherwise returns `false`.

**Call relations**: Helper for `should_leave_missing_git_for_parent_repo_discovery`.

*Call graph*: 2 external calls (join, read_to_string).


##### `expand_unreadable_globs_with_ripgrep`  (lines 700–744)

```
fn expand_unreadable_globs_with_ripgrep(
    patterns: &[String],
    cwd: &Path,
    max_depth: Option<usize>,
) -> Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Expands unreadable glob patterns into concrete existing paths that bubblewrap can actually mask.

**Data flow**: Takes glob pattern strings, cwd, and optional max depth → groups patterns by static search root using `split_pattern_for_ripgrep`, runs `ripgrep_files` per root, inserts both logical matches and canonical symlink targets into a `BTreeSet`, enforces `MAX_UNREADABLE_GLOB_MATCHES`, and returns sorted `Vec<AbsolutePathBuf>` or a fatal error.

**Call relations**: Called by `create_filesystem_args` before unreadable masks are emitted, because bubblewrap cannot express abstract glob patterns directly.

*Call graph*: calls 4 internal fn (canonical_target_if_symlinked_path, ripgrep_files, split_pattern_for_ripgrep, from_absolute_path_checked); called by 1 (create_filesystem_args); 5 external calls (new, new, new, format!, Fatal).


##### `split_pattern_for_ripgrep`  (lines 746–773)

```
fn split_pattern_for_ripgrep(pattern: &str, cwd: &Path) -> Option<(AbsolutePathBuf, String)>
```

**Purpose**: Splits a policy glob into a concrete search root and a ripgrep-compatible relative glob suffix.

**Data flow**: Resolves the pattern against `cwd` to an absolute path string, finds the first glob metacharacter, rejects empty or root-only static prefixes, computes the search-root directory boundary, canonicalizes that root into `AbsolutePathBuf`, escapes unclosed character classes in the suffix, and returns `Some((search_root, glob))` or `None`.

**Call relations**: Used by `expand_unreadable_globs_with_ripgrep` and tested directly for broad-root and unclosed-class behavior.

*Call graph*: calls 3 internal fn (escape_unclosed_glob_classes, from_absolute_path_checked, resolve_path_against_base); called by 2 (expand_unreadable_globs_with_ripgrep, unclosed_character_classes_are_escaped_for_ripgrep); 1 external calls (from).


##### `escape_unclosed_glob_classes`  (lines 775–808)

```
fn escape_unclosed_glob_classes(glob: &str) -> String
```

**Purpose**: Makes policy globs with literal unmatched `[` acceptable to ripgrep/globset parsers.

**Data flow**: Scans the input glob string character by character → copies closed `[...]` classes unchanged, but rewrites an unclosed `[` opener as `\[` followed by the remaining class text → returns the escaped string.

**Call relations**: Called by `split_pattern_for_ripgrep` before handing glob suffixes to ripgrep.

*Call graph*: called by 1 (split_pattern_for_ripgrep); 2 external calls (new, with_capacity).


##### `ripgrep_files`  (lines 810–875)

```
fn ripgrep_files(
    search_root: &Path,
    globs: &[String],
    max_depth: Option<usize>,
) -> Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Uses `rg --files` to enumerate filesystem paths matching unreadable glob patterns under a search root, with a fallback when ripgrep is unavailable.

**Data flow**: Builds a `Command("rg")` with `--files --hidden --no-ignore --null`, optional `--max-depth`, repeated `--glob` arguments, and the search root → on `NotFound`, falls back to `glob_files`; on status 1 with empty stderr, returns no matches; on other failures, returns a fatal error; on success, splits NUL-delimited stdout into absolute paths and converts them to `AbsolutePathBuf`.

**Call relations**: Called by `expand_unreadable_globs_with_ripgrep` for each grouped search root.

*Call graph*: calls 1 internal fn (glob_files); called by 1 (expand_unreadable_globs_with_ripgrep); 5 external calls (from_utf8_lossy, new, new, format!, Fatal).


##### `glob_files`  (lines 877–906)

```
fn glob_files(
    search_root: &Path,
    globs: &[String],
    max_depth: Option<usize>,
) -> Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Fallback unreadable-glob expander implemented with `globset` and recursive directory walking.

**Data flow**: Builds a `GlobSet` from the provided glob strings with literal separators and unclosed-class support, then recursively collects matching files/symlinks under `search_root` via `collect_glob_files` → returns the matched absolute paths or a fatal glob-construction error.

**Call relations**: Used only by `ripgrep_files` when `rg` is not installed.

*Call graph*: calls 1 internal fn (collect_glob_files); called by 1 (ripgrep_files); 3 external calls (new, new, new).


##### `collect_glob_files`  (lines 908–936)

```
fn collect_glob_files(
    search_root: &Path,
    dir: &Path,
    glob_set: &GlobSet,
    remaining_depth: Option<usize>,
    paths: &mut Vec<AbsolutePathBuf>,
) -> Result<()>
```

**Purpose**: Recursively walks a directory tree and records files or symlinks whose relative paths match a compiled `GlobSet`.

**Data flow**: Reads directory entries under `dir`, computes each entry's path relative to `search_root`, pushes matching files/symlinks into `paths`, decrements `remaining_depth` for subdirectories, and recurses into directories until the depth cap is reached.

**Call relations**: Worker used by `glob_files` for the internal unreadable-glob fallback.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 1 (glob_files); 2 external calls (is_match, read_dir).


##### `path_to_string`  (lines 938–940)

```
fn path_to_string(path: &Path) -> String
```

**Purpose**: Converts a path into the lossy UTF-8 string form expected by bubblewrap argv construction and tests.

**Data flow**: Takes `&Path` → returns `path.to_string_lossy().to_string()`.

**Call relations**: Widely used throughout argument construction and test assertions to normalize path formatting.

*Call graph*: called by 29 (append_empty_directory_args, append_empty_file_bind_data_args, append_existing_unreadable_path_args, append_mount_target_parent_dir_args, append_read_only_subpath_args, create_bwrap_flags, create_filesystem_args, assert_empty_directory_mounted_read_only, assert_empty_file_bound_without_perms, assert_file_masked (+15 more)); 1 external calls (to_string_lossy).


##### `path_depth`  (lines 942–944)

```
fn path_depth(path: &Path) -> usize
```

**Purpose**: Computes a simple component-count depth metric for path ordering.

**Data flow**: Takes `&Path` → counts `path.components()` → returns the `usize` depth.

**Call relations**: Used to sort writable roots, unreadable roots, and descendant recreation order from shallow to deep.

*Call graph*: 1 external calls (components).


##### `canonical_target_if_symlinked_path`  (lines 946–980)

```
fn canonical_target_if_symlinked_path(path: &Path) -> Option<PathBuf>
```

**Purpose**: Returns the fully resolved target path only when some component of the logical path is a symlink.

**Data flow**: Walks path components incrementally, checking `fs::symlink_metadata` at each step → if a symlink component is found, canonicalizes the full original path and returns it unless the canonical path equals the original; otherwise returns `None`.

**Call relations**: Used when writable roots or unreadable glob matches need to be rebound/masked at their real target locations without rewriting ordinary non-symlink paths.

*Call graph*: called by 2 (create_filesystem_args, expand_unreadable_globs_with_ripgrep); 5 external calls (components, new, new, canonicalize, symlink_metadata).


##### `remap_paths_for_symlink_target`  (lines 982–993)

```
fn remap_paths_for_symlink_target(paths: Vec<PathBuf>, root: &Path, target: &Path) -> Vec<PathBuf>
```

**Purpose**: Rewrites a list of logical subpaths from a symlinked root onto that root's canonical target.

**Data flow**: Takes owned `Vec<PathBuf>`, logical root, and canonical target → for each path, if it is under `root`, strips the prefix and joins the remainder onto `target`; otherwise leaves it unchanged → returns the remapped vector.

**Call relations**: Used by `create_filesystem_args` when a writable root itself is symlinked and its carveouts must follow the real mount target.

*Call graph*: called by 1 (create_filesystem_args).


##### `normalize_command_cwd_for_bwrap`  (lines 995–999)

```
fn normalize_command_cwd_for_bwrap(command_cwd: &Path) -> PathBuf
```

**Purpose**: Canonicalizes the command working directory when possible so bubblewrap can `--chdir` into a mounted real path.

**Data flow**: Takes `&Path` → returns `command_cwd.canonicalize()` on success or the original path cloned on failure.

**Call relations**: Called by `create_bwrap_flags` before deciding whether to emit an explicit `--chdir`.

*Call graph*: called by 1 (create_bwrap_flags); 1 external calls (canonicalize).


##### `append_mount_target_parent_dir_args`  (lines 1001–1019)

```
fn append_mount_target_parent_dir_args(args: &mut Vec<String>, mount_target: &Path, anchor: &Path)
```

**Purpose**: Emits `--dir` arguments to recreate ancestor directories for a mount target under a masked parent.

**Data flow**: Takes mutable argv, a mount target, and an anchor path → chooses the target directory (the path itself if directory, otherwise its parent), collects ancestors down to but excluding the anchor, reverses them shallow-to-deep, and appends `--dir <path>` for each.

**Call relations**: Used when writable descendants must be recreated inside an unreadable tmpfs mask before later bind mounts can succeed.

*Call graph*: calls 1 internal fn (path_to_string); called by 2 (append_existing_unreadable_path_args, create_filesystem_args); 2 external calls (is_dir, parent).


##### `append_read_only_subpath_args`  (lines 1021–1072)

```
fn append_read_only_subpath_args(
    bwrap_args: &mut BwrapArgs,
    subpath: &Path,
    allowed_write_paths: &[PathBuf],
) -> Result<()>
```

**Purpose**: Adds bubblewrap mounts that make a subpath under a writable root read-only, handling missing and transient-empty cases safely.

**Data flow**: Takes mutable `BwrapArgs`, the subpath, and allowed writable roots → fails closed if the path crosses a writable symlink component; if the path is a transient empty protected metadata file/dir under a writable root, records it as an existing synthetic target; if missing, masks the first missing component when it lies under an allowed writable root; if existing and within allowed writable roots, appends `--ro-bind subpath subpath`.

**Call relations**: Called from `create_filesystem_args` for each read-only carveout after a writable root has been rebound.

*Call graph*: calls 8 internal fn (append_existing_empty_directory_args, append_existing_empty_file_bind_data_args, append_missing_read_only_subpath_args, find_first_non_existent_component, first_writable_symlink_component_in_path, is_within_allowed_write_paths, path_to_string, transient_empty_metadata_path); called by 1 (create_filesystem_args); 3 external calls (exists, format!, Fatal).


##### `append_empty_file_bind_data_args`  (lines 1074–1083)

```
fn append_empty_file_bind_data_args(bwrap_args: &mut BwrapArgs, path: &Path) -> Result<()>
```

**Purpose**: Appends a `--ro-bind-data` mount backed by `/dev/null` for an empty-file mask target.

**Data flow**: Ensures `bwrap_args.preserved_files[0]` contains an open `/dev/null` file, obtains its raw fd as a string, and appends `--ro-bind-data <fd> <path>` to the argv.

**Call relations**: Shared low-level helper used for missing file masks, transient empty file masks, and unreadable existing file masks.

*Call graph*: calls 1 internal fn (path_to_string); called by 3 (append_existing_empty_file_bind_data_args, append_existing_unreadable_path_args, append_missing_empty_file_bind_data_args); 1 external calls (open).


##### `append_empty_directory_args`  (lines 1085–1092)

```
fn append_empty_directory_args(bwrap_args: &mut BwrapArgs, path: &Path)
```

**Purpose**: Appends a read-only empty-directory tmpfs mount sequence for a protected path.

**Data flow**: Takes mutable `BwrapArgs` and a path → appends `--perms 555 --tmpfs <path> --remount-ro <path>`.

**Call relations**: Used when masking missing or transient-empty protected metadata directories.

*Call graph*: calls 1 internal fn (path_to_string); called by 2 (append_existing_empty_directory_args, append_missing_read_only_subpath_args).


##### `append_missing_read_only_subpath_args`  (lines 1094–1104)

```
fn append_missing_read_only_subpath_args(bwrap_args: &mut BwrapArgs, path: &Path) -> Result<()>
```

**Purpose**: Chooses the correct synthetic mask strategy for a missing read-only carveout path.

**Data flow**: Takes mutable `BwrapArgs` and a missing path → if the final component is a protected metadata name, appends an empty-directory mask and records `SyntheticMountTarget::missing_empty_directory`; otherwise delegates to `append_missing_empty_file_bind_data_args`.

**Call relations**: Called by `append_read_only_subpath_args` when the protected subpath does not yet exist on the host.

*Call graph*: calls 3 internal fn (missing_empty_directory, append_empty_directory_args, append_missing_empty_file_bind_data_args); called by 1 (append_read_only_subpath_args); 1 external calls (file_name).


##### `append_missing_empty_file_bind_data_args`  (lines 1106–1112)

```
fn append_missing_empty_file_bind_data_args(bwrap_args: &mut BwrapArgs, path: &Path) -> Result<()>
```

**Purpose**: Masks a missing path with an empty-file bind and records it as a synthetic target.

**Data flow**: Calls `append_empty_file_bind_data_args`, then pushes `SyntheticMountTarget::missing(path)` into `bwrap_args.synthetic_mount_targets`.

**Call relations**: Used for missing read-only carveouts and missing unreadable roots.

*Call graph*: calls 2 internal fn (missing, append_empty_file_bind_data_args); called by 2 (append_missing_read_only_subpath_args, append_unreadable_root_args).


##### `append_existing_empty_file_bind_data_args`  (lines 1114–1124)

```
fn append_existing_empty_file_bind_data_args(
    bwrap_args: &mut BwrapArgs,
    path: &Path,
    metadata: &Metadata,
) -> Result<()>
```

**Purpose**: Masks an existing empty file with `/dev/null` bind data while remembering that the host path pre-existed.

**Data flow**: Calls `append_empty_file_bind_data_args`, then records `SyntheticMountTarget::existing_empty_file(path, metadata)`.

**Call relations**: Used by `append_read_only_subpath_args` for transient empty protected metadata files.

*Call graph*: calls 2 internal fn (existing_empty_file, append_empty_file_bind_data_args); called by 1 (append_read_only_subpath_args).


##### `append_existing_empty_directory_args`  (lines 1126–1137)

```
fn append_existing_empty_directory_args(
    bwrap_args: &mut BwrapArgs,
    path: &Path,
    metadata: &Metadata,
)
```

**Purpose**: Masks an existing empty directory with a read-only tmpfs mount while remembering that the host path pre-existed.

**Data flow**: Calls `append_empty_directory_args`, then records `SyntheticMountTarget::existing_empty_directory(path, metadata)`.

**Call relations**: Used by `append_read_only_subpath_args` for transient empty protected metadata directories.

*Call graph*: calls 2 internal fn (existing_empty_directory, append_empty_directory_args); called by 1 (append_read_only_subpath_args).


##### `append_unreadable_root_args`  (lines 1139–1171)

```
fn append_unreadable_root_args(
    bwrap_args: &mut BwrapArgs,
    unreadable_root: &Path,
    allowed_write_paths: &[PathBuf],
) -> Result<()>
```

**Purpose**: Adds bubblewrap masks that make a path completely unreadable, handling missing paths and unsafe symlink cases.

**Data flow**: Takes mutable `BwrapArgs`, an unreadable root, and allowed writable roots → fails closed if the path crosses a writable symlink component; if missing, finds the first missing component under an allowed writable root and masks it with `append_missing_empty_file_bind_data_args`; otherwise delegates to `append_existing_unreadable_path_args`.

**Call relations**: Called from `create_filesystem_args` for unreadable ancestors, nested unreadable carveouts, and rootless unreadable roots.

*Call graph*: calls 5 internal fn (append_existing_unreadable_path_args, append_missing_empty_file_bind_data_args, find_first_non_existent_component, first_writable_symlink_component_in_path, is_within_allowed_write_paths); called by 1 (create_filesystem_args); 3 external calls (exists, format!, Fatal).


##### `append_existing_unreadable_path_args`  (lines 1173–1215)

```
fn append_existing_unreadable_path_args(
    bwrap_args: &mut BwrapArgs,
    unreadable_root: &Path,
    allowed_write_paths: &[PathBuf],
) -> Result<()>
```

**Purpose**: Emits the concrete bubblewrap mask for an existing unreadable file or directory.

**Data flow**: If `unreadable_root` is a directory, computes writable descendants under it, appends `--perms 000|111 --tmpfs <root>`, recreates descendant mount-target parents with `append_mount_target_parent_dir_args`, then `--remount-ro <root>`; if it is a file, appends `--perms 000` followed by `append_empty_file_bind_data_args`.

**Call relations**: Worker used by `append_unreadable_root_args` once the target path is known to exist.

*Call graph*: calls 3 internal fn (append_empty_file_bind_data_args, append_mount_target_parent_dir_args, path_to_string); called by 1 (append_unreadable_root_args); 2 external calls (is_dir, iter).


##### `is_within_allowed_write_paths`  (lines 1218–1222)

```
fn is_within_allowed_write_paths(path: &Path, allowed_write_paths: &[PathBuf]) -> bool
```

**Purpose**: Checks whether a path lies under any writable root or writable symlink target.

**Data flow**: Takes a path and slice of allowed writable `PathBuf`s → returns `true` if any root is a prefix of the path.

**Call relations**: Used throughout carveout and symlink-safety logic to decide whether a path is mutable from inside the sandbox.

*Call graph*: called by 3 (append_read_only_subpath_args, append_unreadable_root_args, first_writable_symlink_component_in_path); 1 external calls (iter).


##### `transient_empty_metadata_path`  (lines 1229–1244)

```
fn transient_empty_metadata_path(path: &Path) -> Option<EmptyProtectedMetadataPath>
```

**Purpose**: Recognizes empty `.git`/`.agents`/`.codex` paths that should be treated as transient synthetic placeholders rather than stable bind sources.

**Data flow**: Checks whether the file name is a protected metadata name, reads symlink metadata, and returns `Some(File(metadata))` for an empty file, `Some(Directory(metadata))` for an empty directory, or `None` otherwise.

**Call relations**: Called by `append_read_only_subpath_args` before deciding how to mask an existing protected metadata path.

*Call graph*: calls 1 internal fn (directory_is_empty); called by 1 (append_read_only_subpath_args); 4 external calls (file_name, symlink_metadata, Directory, File).


##### `directory_is_empty`  (lines 1246–1251)

```
fn directory_is_empty(path: &Path) -> bool
```

**Purpose**: Checks whether a directory currently contains no entries.

**Data flow**: Attempts `fs::read_dir(path)` → returns `false` on error, otherwise returns whether the iterator yields no first entry.

**Call relations**: Helper for `transient_empty_metadata_path`.

*Call graph*: called by 1 (transient_empty_metadata_path); 1 external calls (read_dir).


##### `first_writable_symlink_component_in_path`  (lines 1253–1294)

```
fn first_writable_symlink_component_in_path(
    target_path: &Path,
    allowed_write_paths: &[PathBuf],
) -> Option<PathBuf>
```

**Purpose**: Finds the first symlink component in a logical path that is itself under a writable root, indicating an unsafe TOCTTOU case.

**Data flow**: Walks path components incrementally, reading `symlink_metadata` for each existing prefix → if a prefix is a symlink and `is_within_allowed_write_paths(&current, allowed_write_paths)` is true, returns that prefix path; otherwise continues until a missing component or the end.

**Call relations**: Used by both read-only and unreadable mask builders to fail closed when a mutable symlink would undermine enforcement.

*Call graph*: calls 1 internal fn (is_within_allowed_write_paths); called by 2 (append_read_only_subpath_args, append_unreadable_root_args); 4 external calls (components, new, new, symlink_metadata).


##### `find_first_non_existent_component`  (lines 1300–1325)

```
fn find_first_non_existent_component(target_path: &Path) -> Option<PathBuf>
```

**Purpose**: Finds the earliest missing component in a path so sandbox setup can block creation at the highest possible point.

**Data flow**: Walks path components from root to leaf, maintaining a cumulative `PathBuf` → returns the first prefix for which `exists()` is false, or `None` if the full path exists.

**Call relations**: Used when masking missing read-only or unreadable paths under writable roots.

*Call graph*: called by 2 (append_read_only_subpath_args, append_unreadable_root_args); 3 external calls (components, new, new).


##### `tests::default_unreadable_glob_scan_has_no_depth_cap`  (lines 1343–1345)

```
fn default_unreadable_glob_scan_has_no_depth_cap()
```

**Purpose**: Verifies the default options leave unreadable glob expansion uncapped by depth.

**Data flow**: Constructs `BwrapOptions::default()` and asserts `glob_scan_max_depth == None`.

**Call relations**: Regression test for the default option contract.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::unreadable_glob_entry`  (lines 1347–1352)

```
fn unreadable_glob_entry(pattern: String) -> FileSystemSandboxEntry
```

**Purpose**: Builds a deny-access sandbox entry for a glob pattern in tests.

**Data flow**: Takes a pattern string → returns `FileSystemSandboxEntry { path: FileSystemPath::GlobPattern { pattern }, access: FileSystemAccessMode::Deny }`.

**Call relations**: Helper used by unreadable-glob policy tests.


##### `tests::default_policy_with_unreadable_glob`  (lines 1354–1358)

```
fn default_policy_with_unreadable_glob(pattern: String) -> FileSystemSandboxPolicy
```

**Purpose**: Creates a default sandbox policy containing one unreadable glob deny rule.

**Data flow**: Starts from `FileSystemSandboxPolicy::default()`, pushes `unreadable_glob_entry(pattern)`, and returns the policy.

**Call relations**: Helper for unreadable-glob expansion tests.

*Call graph*: calls 1 internal fn (default); 1 external calls (unreadable_glob_entry).


##### `tests::full_disk_write_full_network_returns_unwrapped_command`  (lines 1361–1377)

```
fn full_disk_write_full_network_returns_unwrapped_command()
```

**Purpose**: Checks the fast path that skips bubblewrap entirely for unrestricted filesystem and network access.

**Data flow**: Builds an unrestricted policy and default options with full network, calls `create_bwrap_command_args`, and asserts the returned args vector equals the original command.

**Call relations**: Covers the top-level no-sandbox shortcut in `create_bwrap_command_args`.

*Call graph*: calls 2 internal fn (create_bwrap_command_args, unrestricted); 4 external calls (default, new, assert_eq!, vec!).


##### `tests::full_disk_write_proxy_only_keeps_full_filesystem_but_unshares_network`  (lines 1380–1412)

```
fn full_disk_write_proxy_only_keeps_full_filesystem_but_unshares_network()
```

**Purpose**: Verifies that full filesystem access still uses bubblewrap when network isolation is requested.

**Data flow**: Builds an unrestricted policy with `ProxyOnly` network mode, calls `create_bwrap_command_args`, and asserts the exact argv includes `--bind / /`, namespace flags, `--unshare-net`, and `--proc /proc`.

**Call relations**: Covers the `create_bwrap_flags_full_filesystem` branch.

*Call graph*: calls 2 internal fn (create_bwrap_command_args, unrestricted); 4 external calls (default, new, assert_eq!, vec!).


##### `tests::full_disk_write_with_unreadable_glob_still_wraps_and_masks_match`  (lines 1415–1448)

```
fn full_disk_write_with_unreadable_glob_still_wraps_and_masks_match()
```

**Purpose**: Verifies that unreadable glob rules force bubblewrap even under otherwise full-write policies.

**Data flow**: Creates a temp `.env` file, builds a policy granting root write plus a deny glob, calls `create_bwrap_command_args`, asserts the command was wrapped rather than returned unchanged, and checks the matched file is masked.

**Call relations**: Covers the special-case logic that unreadable globs must be materialized into concrete masks.

*Call graph*: calls 3 internal fn (default, create_bwrap_command_args, restricted); 6 external calls (new, assert_ne!, assert_file_masked, ripgrep_available, write, vec!).


##### `tests::restricted_policy_chdirs_to_canonical_command_cwd`  (lines 1452–1526)

```
fn restricted_policy_chdirs_to_canonical_command_cwd()
```

**Purpose**: Checks that restricted sandboxes emit `--chdir` to the canonical command cwd when the logical cwd is symlinked.

**Data flow**: Creates a real directory and symlinked alias, builds a restricted policy, calls `create_bwrap_command_args`, and asserts the argv contains canonical `--chdir` and canonical `--ro-bind` entries but not the symlinked forms.

**Call relations**: Regression test for `normalize_command_cwd_for_bwrap` and symlink-aware mount roots.

*Call graph*: calls 5 internal fn (default, create_bwrap_command_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::symlinked_writable_roots_bind_real_target_and_remap_carveouts`  (lines 1530–1572)

```
fn symlinked_writable_roots_bind_real_target_and_remap_carveouts()
```

**Purpose**: Verifies that a writable root which is itself a symlink is rebound at its canonical target and its deny carveouts are remapped there too.

**Data flow**: Creates a real directory, symlink root, and blocked child, builds a write-plus-deny policy on the symlinked paths, calls `create_filesystem_args`, and asserts the bind and unreadable tmpfs mask target the real paths.

**Call relations**: Covers symlink-target remapping in `create_filesystem_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::writable_roots_under_symlinked_ancestors_bind_real_target`  (lines 1576–1619)

```
fn writable_roots_under_symlinked_ancestors_bind_real_target()
```

**Purpose**: Checks that writable roots nested under a symlinked ancestor are rebound to the real target path.

**Data flow**: Creates a symlinked `.codex` home and a real `memories` directory beneath it, builds a write policy for the logical path, calls `create_filesystem_args`, and asserts only the real path is bound writable.

**Call relations**: Exercises `canonical_target_if_symlinked_path` for nested writable roots.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::protected_symlinked_directory_subpaths_fail_closed`  (lines 1623–1648)

```
fn protected_symlinked_directory_subpaths_fail_closed()
```

**Purpose**: Verifies that protected metadata carveouts crossing writable symlinks are rejected rather than weakly enforced.

**Data flow**: Creates a writable root containing `.agents` as a symlink, builds a write policy for the root, calls `create_filesystem_args`, captures the error, and asserts it mentions inability to enforce a read-only path for the symlinked metadata path.

**Call relations**: Covers the fail-closed branch in `append_read_only_subpath_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::symlinked_writable_roots_nested_symlink_escape_paths_fail_closed`  (lines 1652–1689)

```
fn symlinked_writable_roots_nested_symlink_escape_paths_fail_closed()
```

**Purpose**: Verifies that deny-read carveouts crossing writable symlinks are rejected as unsafe.

**Data flow**: Creates a symlinked writable root whose child points outside the root, builds a write-plus-deny policy, calls `create_filesystem_args`, and asserts the fatal error mentions inability to enforce a deny-read path for the symlink target.

**Call relations**: Covers the fail-closed branch in `append_unreadable_root_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::missing_read_only_subpath_uses_empty_file_bind_data`  (lines 1692–1736)

```
fn missing_read_only_subpath_uses_empty_file_bind_data()
```

**Purpose**: Checks that missing read-only carveouts are enforced by synthetic empty-file or empty-directory mounts rather than host-side path creation.

**Data flow**: Creates a writable workspace with a missing blocked path, builds a write-plus-read policy, calls `create_filesystem_args`, asserts the blocked path uses `--ro-bind-data`, default metadata names use read-only empty directories, one preserved file fd exists, synthetic target paths are recorded, and the blocked host path was not created.

**Call relations**: Exercises missing-path handling and synthetic target bookkeeping.

*Call graph*: calls 3 internal fn (create_filesystem_args, restricted, from_absolute_path); 7 external calls (new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, assert_empty_file_bound_without_perms, create_dir_all, vec!).


##### `tests::transient_empty_preserved_file_uses_empty_file_bind_data`  (lines 1739–1783)

```
fn transient_empty_preserved_file_uses_empty_file_bind_data()
```

**Purpose**: Verifies that an existing empty protected metadata file is treated as a transient synthetic target, not a stable bind source.

**Data flow**: Creates a writable workspace with an empty `.git` file, builds a write policy, calls `create_filesystem_args`, asserts `.git` is masked via `--ro-bind-data` rather than `--ro-bind`, checks synthetic target paths, and confirms cleanup logic would preserve the pre-existing empty file.

**Call relations**: Covers `transient_empty_metadata_path` and `SyntheticMountTarget::existing_empty_file` behavior.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 9 external calls (create, new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, assert_empty_file_bound_without_perms, create_dir_all, symlink_metadata, vec!).


##### `tests::missing_child_git_under_parent_repo_uses_protected_create_target`  (lines 1786–1825)

```
fn missing_child_git_under_parent_repo_uses_protected_create_target()
```

**Purpose**: Checks that a missing child `.git` under a parent repo is not masked with an empty directory, preserving parent repo discovery while still tracking forbidden creation.

**Data flow**: Creates a repo with parent `.git/HEAD` and a writable child workspace lacking `.git`, builds a write policy, calls `create_filesystem_args`, asserts `.agents` and `.codex` are masked, `.git` is not mounted read-only, `.git` is absent from synthetic targets, and it appears in protected-create targets.

**Call relations**: Exercises the special `.git` parent-discovery exception.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 7 external calls (new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, create_dir_all, write, vec!).


##### `tests::symlinked_missing_child_git_under_parent_repo_uses_effective_mount_root`  (lines 1829–1872)

```
fn symlinked_missing_child_git_under_parent_repo_uses_effective_mount_root()
```

**Purpose**: Verifies the same parent-repo `.git` exception when the writable workspace is reached through a symlinked repo root.

**Data flow**: Creates a real repo with parent `.git`, a symlinked repo alias, and a writable workspace under the alias, builds a write policy on the symlinked workspace, calls `create_filesystem_args`, and asserts the missing child `.git` is tracked only as a protected-create target.

**Call relations**: Covers `should_leave_missing_git_for_parent_repo_discovery` with an effective mount root different from the logical root.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 8 external calls (new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, create_dir_all, write, symlink, vec!).


##### `tests::ignores_missing_writable_roots`  (lines 1875–1906)

```
fn ignores_missing_writable_roots()
```

**Purpose**: Checks that nonexistent writable roots are silently skipped rather than breaking sandbox setup.

**Data flow**: Builds a workspace-write policy containing one existing and one missing root, calls `create_filesystem_args`, and asserts only the existing root appears in bind args.

**Call relations**: Regression test for the missing-writable-root filter near the start of `create_filesystem_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, workspace_write, try_from); 3 external calls (new, assert!, create_dir).


##### `tests::missing_project_root_metadata_carveouts_use_metadata_path_masks`  (lines 1909–1964)

```
fn missing_project_root_metadata_carveouts_use_metadata_path_masks()
```

**Purpose**: Verifies that missing `.git`, `.agents`, and `.codex` project-root carveouts are enforced with synthetic metadata path masks.

**Data flow**: Builds a restricted policy with root read, project-root write, and explicit read rules for the three metadata names, calls `create_filesystem_args`, and asserts each path is mounted as a read-only empty directory, synthetic targets are recorded, and no protected-create targets are needed.

**Call relations**: Covers the interaction between explicit project-root metadata rules and automatic metadata masking.

*Call graph*: calls 3 internal fn (create_filesystem_args, path_to_string, restricted); 7 external calls (new, new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, synthetic_mount_target_paths, vec!).


##### `tests::missing_user_project_root_subpath_rules_are_still_enforced`  (lines 1967–2004)

```
fn missing_user_project_root_subpath_rules_are_still_enforced()
```

**Purpose**: Checks that user-authored missing project-root subpath rules outside the automatic metadata set still produce empty-file masks.

**Data flow**: Builds a restricted policy with project-root write plus read/deny rules for `.vscode` and `.secrets`, calls `create_filesystem_args`, and asserts both missing paths are masked via empty-file bind data.

**Call relations**: Ensures only the special metadata names get the directory-mask exception logic.

*Call graph*: calls 3 internal fn (create_filesystem_args, path_to_string, restricted); 4 external calls (new, new, assert_empty_file_bound_without_perms, vec!).


##### `tests::mounts_dev_before_writable_dev_binds`  (lines 2007–2094)

```
fn mounts_dev_before_writable_dev_binds()
```

**Purpose**: Verifies the exact mount ordering when `/dev` itself is writable.

**Data flow**: Builds a workspace-write policy for `/dev`, calls `create_filesystem_args`, and asserts the full argv sequence starts with `--ro-bind / /`, then `--dev /dev`, then writable root binds and metadata masks for both `/` and `/dev` in the expected order.

**Call relations**: Regression test for a subtle ordering invariant documented in `create_filesystem_args`.

*Call graph*: calls 3 internal fn (create_filesystem_args, workspace_write, try_from); 3 external calls (new, assert!, assert_eq!).


##### `tests::restricted_read_only_uses_scoped_read_roots_instead_of_erroring`  (lines 2097–2125)

```
fn restricted_read_only_uses_scoped_read_roots_instead_of_erroring()
```

**Purpose**: Checks that restricted read-only policies start from `--tmpfs /` and add only scoped readable roots.

**Data flow**: Creates a readable directory, builds a restricted read policy for it, calls `create_filesystem_args`, and asserts the args begin with `--tmpfs / --dev /dev` and include a `--ro-bind` for the readable root.

**Call relations**: Covers the non-root restricted-read baseline branch.

*Call graph*: calls 3 internal fn (create_filesystem_args, path_to_string, restricted); 5 external calls (new, assert!, assert_eq!, create_dir, vec!).


##### `tests::restricted_read_only_with_platform_defaults_includes_usr_when_present`  (lines 2128–2153)

```
fn restricted_read_only_with_platform_defaults_includes_usr_when_present()
```

**Purpose**: Verifies that `:minimal` policies include Linux platform-default readable roots such as `/usr` when they exist.

**Data flow**: Builds a restricted policy with `FileSystemSpecialPath::Minimal`, calls `create_filesystem_args`, asserts the tmpfs-root baseline, and conditionally checks for a `/usr` read-only bind if `/usr` exists on the host.

**Call relations**: Covers `include_platform_defaults()` handling.

*Call graph*: calls 2 internal fn (create_filesystem_args, restricted); 4 external calls (new, new, assert!, vec!).


##### `tests::split_policy_reapplies_unreadable_carveouts_after_writable_binds`  (lines 2156–2225)

```
fn split_policy_reapplies_unreadable_carveouts_after_writable_binds()
```

**Purpose**: Checks that unreadable carveouts nested under writable roots are masked after the writable bind is applied.

**Data flow**: Creates a writable workspace with a blocked child, builds a write-plus-deny policy, calls `create_filesystem_args`, finds the writable bind and blocked tmpfs mask positions in argv, and asserts the bind occurs first.

**Call relations**: Regression test for mount ordering in split policies.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_reenables_nested_writable_subpaths_after_read_only_parent`  (lines 2228–2281)

```
fn split_policy_reenables_nested_writable_subpaths_after_read_only_parent()
```

**Purpose**: Verifies that a writable child under a read-only parent carveout is rebound writable after the parent is remounted read-only.

**Data flow**: Creates `workspace/docs/public`, builds a write-root + read-only `docs` + writable `docs/public` policy, calls `create_filesystem_args`, locates the `--ro-bind docs` and `--bind docs/public` entries, and asserts the read-only parent comes first.

**Call relations**: Covers nested writable re-enablement after read-only carveouts.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_reenables_writable_subpaths_after_unreadable_parent`  (lines 2284–2345)

```
fn split_policy_reenables_writable_subpaths_after_unreadable_parent()
```

**Purpose**: Checks that writable descendants under an unreadable directory are recreated and rebound in the correct order.

**Data flow**: Creates `blocked/allowed`, builds a root-read + deny `blocked` + write `allowed` policy, calls `create_filesystem_args`, locates the unreadable tmpfs mount, `--dir allowed`, `--remount-ro blocked`, and `--bind allowed` entries, and asserts the expected ordering.

**Call relations**: Exercises `append_mount_target_parent_dir_args` within unreadable directory masks.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_reenables_writable_files_after_unreadable_parent`  (lines 2348–2426)

```
fn split_policy_reenables_writable_files_after_unreadable_parent()
```

**Purpose**: Verifies the same descendant-recreation logic for writable files under unreadable parents, without incorrectly creating the file itself as a directory.

**Data flow**: Creates `blocked/allowed/note.txt`, builds a root-read + deny `blocked` + write `note.txt` policy, calls `create_filesystem_args`, asserts only the ancestor directory gets `--dir`, not the file path, and checks the unreadable parent mask precedes the writable file bind.

**Call relations**: Regression test for file-versus-directory handling in mount-target recreation.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, write, vec!).


##### `tests::split_policy_reenables_nested_writable_roots_after_unreadable_parent`  (lines 2429–2482)

```
fn split_policy_reenables_nested_writable_roots_after_unreadable_parent()
```

**Purpose**: Checks that nested writable roots under an unreadable parent are recreated and rebound after the parent mask.

**Data flow**: Creates `workspace/blocked/allowed`, builds a write-root + deny `blocked` + write `allowed` policy, calls `create_filesystem_args`, and asserts the unreadable mask precedes `--dir allowed` and the final writable bind.

**Call relations**: Another ordering regression test for nested writable roots.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_masks_root_read_directory_carveouts`  (lines 2485–2525)

```
fn split_policy_masks_root_read_directory_carveouts()
```

**Purpose**: Verifies unreadable directory masking when the baseline is a read-only bind of `/`.

**Data flow**: Creates a blocked directory, builds a root-read + deny policy, calls `create_filesystem_args`, and asserts the args include `--ro-bind / /`, `--perms 000 --tmpfs <blocked>`, and `--remount-ro <blocked>`.

**Call relations**: Covers unreadable directory masks under the full-read baseline.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_masks_root_read_file_carveouts`  (lines 2528–2562)

```
fn split_policy_masks_root_read_file_carveouts()
```

**Purpose**: Verifies unreadable file masking when the baseline is a read-only bind of `/`.

**Data flow**: Creates a blocked file, builds a root-read + deny policy, calls `create_filesystem_args`, and asserts one preserved file exists, no synthetic targets are recorded, and the args contain `--perms 000 --ro-bind-data <fd> <blocked-file>`.

**Call relations**: Covers unreadable existing file masks.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, assert_eq!, write, vec!).


##### `tests::unreadable_globs_expand_existing_matches_with_configured_depth`  (lines 2565–2595)

```
fn unreadable_globs_expand_existing_matches_with_configured_depth()
```

**Purpose**: Checks unreadable glob expansion and max-depth limiting.

**Data flow**: Creates `.env` files at root, one level deep, and too deep, plus a `.gitignore`, builds a policy with a deny glob, calls `create_filesystem_args` with `Some(2)` depth, and asserts the shallow matches are masked while the deeper one is absent from argv.

**Call relations**: Exercises `expand_unreadable_globs_with_ripgrep` and depth propagation.

*Call graph*: calls 1 internal fn (create_filesystem_args); 8 external calls (new, assert!, format!, assert_file_masked, default_policy_with_unreadable_glob, ripgrep_available, create_dir_all, write).


##### `tests::unreadable_globs_add_canonical_targets_for_symlink_matches`  (lines 2599–2618)

```
fn unreadable_globs_add_canonical_targets_for_symlink_matches()
```

**Purpose**: Verifies that unreadable glob expansion also masks canonical targets reached through symlinked search roots.

**Data flow**: Creates a real directory with `secret.env`, a symlink to it, builds a deny glob rooted at the symlink, calls `create_filesystem_args`, and asserts the real target file is masked.

**Call relations**: Covers canonical-target insertion in unreadable glob expansion.

*Call graph*: calls 1 internal fn (create_filesystem_args); 8 external calls (new, format!, assert_file_masked, default_policy_with_unreadable_glob, ripgrep_available, create_dir_all, write, symlink).


##### `tests::root_prefix_unreadable_globs_are_too_broad_for_linux_expansion`  (lines 2621–2626)

```
fn root_prefix_unreadable_globs_are_too_broad_for_linux_expansion()
```

**Purpose**: Checks that root-wide unreadable glob scans are intentionally rejected from startup-time expansion.

**Data flow**: Calls `split_pattern_for_ripgrep("/**/*.env", Path::new("/tmp"))` and asserts it returns `None`.

**Call relations**: Regression test for the broad-scan guard in `split_pattern_for_ripgrep`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::unclosed_character_classes_are_escaped_for_ripgrep`  (lines 2629–2635)

```
fn unclosed_character_classes_are_escaped_for_ripgrep()
```

**Purpose**: Verifies that an unclosed `[` in a glob is escaped rather than treated as invalid syntax.

**Data flow**: Calls `split_pattern_for_ripgrep("/tmp/[*.env", Path::new("/"))`, unwraps the result, and asserts the search root is `/tmp` and the glob suffix is `\[*.env`.

**Call relations**: Direct test of `escape_unclosed_glob_classes` via the public splitting helper.

*Call graph*: calls 1 internal fn (split_pattern_for_ripgrep); 2 external calls (new, assert_eq!).


##### `tests::ripgrep_available`  (lines 2637–2642)

```
fn ripgrep_available() -> bool
```

**Purpose**: Checks whether `rg` is installed and runnable on the test host.

**Data flow**: Runs `Command::new("rg").arg("--version").output()` and returns whether the command succeeded with a successful exit status.

**Call relations**: Used by unreadable-glob tests to skip themselves when ripgrep is unavailable.

*Call graph*: 1 external calls (new).


##### `tests::assert_file_masked`  (lines 2647–2658)

```
fn assert_file_masked(args: &[String], path: &Path)
```

**Purpose**: Asserts that a path is masked by a `--perms 000 --ro-bind-data FD PATH` sequence in bubblewrap args.

**Data flow**: Converts the path to string form and scans `args.windows(5)` for the expected pattern, failing the test if absent.

**Call relations**: Shared assertion helper for tests involving unreadable file masks.

*Call graph*: calls 1 internal fn (path_to_string); 1 external calls (assert!).


##### `tests::assert_empty_file_bound_without_perms`  (lines 2662–2678)

```
fn assert_empty_file_bound_without_perms(args: &[String], path: &Path)
```

**Purpose**: Asserts that a path is masked by an empty-file bind without an explicit preceding `--perms 000`.

**Data flow**: Converts the path to string form, checks for a `--ro-bind-data FD PATH` window, and separately asserts no `--perms 000 --ro-bind-data ... PATH` window exists.

**Call relations**: Shared assertion helper for missing-path and transient-empty-file tests.

*Call graph*: calls 1 internal fn (path_to_string); 1 external calls (assert!).


##### `tests::assert_empty_directory_mounted_read_only`  (lines 2680–2692)

```
fn assert_empty_directory_mounted_read_only(args: &[String], path: &Path)
```

**Purpose**: Asserts that a path is masked by a read-only empty-directory tmpfs mount.

**Data flow**: Converts the path to string form and checks for both `--perms 555 --tmpfs PATH` and `--remount-ro PATH` windows in the args.

**Call relations**: Shared assertion helper for protected metadata directory masks.

*Call graph*: calls 1 internal fn (path_to_string); 1 external calls (assert!).


##### `tests::synthetic_mount_target_paths`  (lines 2694–2699)

```
fn synthetic_mount_target_paths(args: &BwrapArgs) -> Vec<PathBuf>
```

**Purpose**: Extracts just the paths from a `BwrapArgs` synthetic mount target list for easier assertions.

**Data flow**: Iterates `args.synthetic_mount_targets`, maps each target through `target.path().to_path_buf()`, and returns the collected `Vec<PathBuf>`.

**Call relations**: Used by tests that validate which synthetic targets were recorded.


##### `tests::protected_create_target_paths`  (lines 2701–2706)

```
fn protected_create_target_paths(args: &BwrapArgs) -> Vec<PathBuf>
```

**Purpose**: Extracts just the paths from a `BwrapArgs` protected-create target list for easier assertions.

**Data flow**: Iterates `args.protected_create_targets`, maps each target through `target.path().to_path_buf()`, and returns the collected `Vec<PathBuf>`.

**Call relations**: Used by tests that validate protected-create tracking.


### `linux-sandbox/src/bundled_bwrap.rs`

`orchestration` · `sandbox process startup before exec`

This file is the launcher layer for the external bubblewrap executable. `launcher()` is the entry point: it gets the current executable path, asks `InstallContext::current()` for package-aware bundled resources, and falls back to legacy path heuristics if needed. The modern path is `context.bundled_resource("bwrap")`, filtered to executable files. Legacy lookup checks several adjacent locations relative to the current executable: `codex-resources/bwrap` next to the exe, `codex-resources/bwrap` next to the parent target directory (for npm/vendor layouts), a sibling `bwrap`, and finally a Bazel-resolved candidate in debug builds.

`BundledBwrapLauncher::exec` opens the chosen binary, verifies its digest if a nonzero compile-time `CODEX_BWRAP_SHA256` was embedded, marks preserved file descriptors inheritable, and then `execv`s `/proc/self/fd/<fd>` rather than the original path. Executing via the already-open fd avoids races between verification and execution. Arguments are converted to `CString`s, null-terminated for libc, and any failure panics with a detailed message because this path is part of sandbox process setup.

Digest handling is intentionally strict but optional. `expected_sha256()` memoizes the parsed compile-time digest in a `OnceLock`; an all-zero digest disables verification. `verify_digest()` clones the file descriptor, streams the file through `Sha256`, and compares the resulting `[u8; 32]` against the expected bytes, formatting both as lowercase hex on mismatch. Tests cover install-context lookup, legacy path variants, digest success/failure, and hex parsing.

#### Function details

##### `launcher`  (lines 28–33)

```
fn launcher() -> Option<BundledBwrapLauncher>
```

**Purpose**: Finds an executable bundled `bwrap` binary and wraps it in a launcher object.

**Data flow**: Reads `std::env::current_exe().ok()?` → tries `find_for_install_context(InstallContext::current())`, then `find_legacy_for_exe(&current_exe)` if needed → maps the chosen absolute path into `BundledBwrapLauncher { program }` and returns `Option<_>`.

**Call relations**: Top-level discovery function used by sandbox startup code to decide whether a bundled bubblewrap executable is available.

*Call graph*: calls 2 internal fn (current, find_for_install_context); 1 external calls (current_exe).


##### `BundledBwrapLauncher::exec`  (lines 36–69)

```
fn exec(&self, argv: Vec<String>, preserved_files: Vec<File>) -> !
```

**Purpose**: Verifies and then replaces the current process with the bundled bubblewrap executable.

**Data flow**: Takes owned argv strings and preserved `File`s → opens `self.program`, verifies its digest with `verify_digest(&bwrap_file, expected_sha256(), ...)`, marks preserved files inheritable, builds `/proc/self/fd/<fd>` as a `CString`, converts argv to C strings and pointer array, calls `libc::execv`, and panics with `last_os_error()` if `execv` returns.

**Call relations**: Called once the sandbox wrapper has decided to launch bubblewrap; it delegates to digest verification and fd/argv preparation helpers before the final `exec`.

*Call graph*: calls 5 internal fn (expected_sha256, verify_digest, argv_to_cstrings, make_files_inheritable, as_path); 7 external calls (new, open, last_os_error, format!, execv, panic!, null).


##### `find_for_install_context`  (lines 72–76)

```
fn find_for_install_context(context: &InstallContext) -> Option<AbsolutePathBuf>
```

**Purpose**: Looks for `bwrap` in the current install context's bundled resources.

**Data flow**: Takes `&InstallContext` → calls `context.bundled_resource("bwrap")` → filters the result through `is_executable_file` → returns `Option<AbsolutePathBuf>`.

**Call relations**: First lookup step in `launcher`, preferred over legacy adjacent-path heuristics.

*Call graph*: calls 1 internal fn (bundled_resource); called by 1 (launcher).


##### `find_legacy_for_exe`  (lines 78–90)

```
fn find_legacy_for_exe(exe: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Searches older executable-relative locations for a bundled `bwrap` binary.

**Data flow**: Takes the current executable path → gets candidate paths from `legacy_candidates_for_exe`, finds the first executable one with `is_executable_file`, then normalizes it into `AbsolutePathBuf` or panics if normalization unexpectedly fails.

**Call relations**: Fallback path in `launcher` when install-context resource lookup does not find `bwrap`.

*Call graph*: calls 1 internal fn (legacy_candidates_for_exe).


##### `legacy_candidates_for_exe`  (lines 92–107)

```
fn legacy_candidates_for_exe(exe: &Path) -> Vec<PathBuf>
```

**Purpose**: Builds the ordered list of legacy `bwrap` candidate paths relative to the current executable.

**Data flow**: Takes an exe path → if it has no parent, returns an empty vector; otherwise pushes `<exe_dir>/codex-resources/bwrap`, `<exe_dir.parent>/codex-resources/bwrap` when available, `<exe_dir>/bwrap`, and an optional Bazel candidate → returns `Vec<PathBuf>` in search order.

**Call relations**: Used only by `find_legacy_for_exe` to enumerate fallback locations.

*Call graph*: calls 1 internal fn (candidate); called by 1 (find_legacy_for_exe); 2 external calls (parent, new).


##### `is_executable_file`  (lines 109–114)

```
fn is_executable_file(path: &Path) -> bool
```

**Purpose**: Checks whether a path exists as a regular file with any execute bit set.

**Data flow**: Reads filesystem metadata for the path → returns `false` on metadata error; otherwise returns `metadata.is_file() && metadata.permissions().mode() & 0o111 != 0`.

**Call relations**: Applied by both modern and legacy lookup paths to reject missing files and non-executable placeholders.

*Call graph*: 1 external calls (metadata).


##### `expected_sha256`  (lines 116–124)

```
fn expected_sha256() -> Option<[u8; 32]>
```

**Purpose**: Parses and memoizes the compile-time expected SHA-256 digest for bundled bubblewrap verification.

**Data flow**: Uses a `OnceLock<Option<[u8; 32]>>` → on first call, reads `option_env!("CODEX_BWRAP_SHA256")`, parses it with `parse_sha256_hex`, panics on invalid syntax, and returns `None` if the digest is all zeros or absent → subsequent calls reuse the cached value.

**Call relations**: Called by `BundledBwrapLauncher::exec` immediately before digest verification.

*Call graph*: called by 1 (exec); 1 external calls (new).


##### `verify_digest`  (lines 126–160)

```
fn verify_digest(file: &File, expected: Option<[u8; 32]>, path: &Path) -> Result<(), String>
```

**Purpose**: Computes the SHA-256 of an opened `bwrap` file and compares it to the expected digest when verification is enabled.

**Data flow**: Takes a `&File`, optional expected digest, and display path → returns early `Ok(())` if expected is `None`; otherwise clones the file handle, reads it in 8192-byte chunks into a `Sha256` hasher, finalizes to `[u8; 32]`, compares to expected, and returns `Ok(())` or a formatted mismatch/error string.

**Call relations**: Used by `exec` and directly by tests covering skipped, matching, and mismatched verification cases.

*Call graph*: called by 4 (exec, digest_verification_accepts_matching_digest, digest_verification_rejects_mismatched_digest, digest_verification_skips_missing_expected_digest); 4 external calls (read, try_clone, new, format!).


##### `parse_sha256_hex`  (lines 162–177)

```
fn parse_sha256_hex(raw: &str) -> Result<[u8; 32], String>
```

**Purpose**: Parses a 64-character lowercase/uppercase hex digest string into 32 raw bytes.

**Data flow**: Takes `&str` → validates length equals `SHA256_HEX_LEN`, then iterates over 32 byte positions, parsing each two-character slice with `u8::from_str_radix(..., 16)` → returns `Ok([u8; 32])` or a descriptive `Err(String)`.

**Call relations**: Used by `expected_sha256` and tested directly for valid and invalid digest strings.

*Call graph*: 2 external calls (format!, from_str_radix).


##### `bytes_to_hex`  (lines 179–187)

```
fn bytes_to_hex(bytes: &[u8; 32]) -> String
```

**Purpose**: Formats a 32-byte digest as lowercase hexadecimal.

**Data flow**: Takes `&[u8; 32]` → allocates a `String` with capacity 64, emits two hex characters per byte using a static lookup table, and returns the resulting string.

**Call relations**: Used by `verify_digest` to produce readable expected/actual digests in mismatch errors.

*Call graph*: 1 external calls (with_capacity).


##### `tests::finds_package_layout_bwrap_from_install_context`  (lines 201–226)

```
fn finds_package_layout_bwrap_from_install_context()
```

**Purpose**: Verifies that install-context resource lookup finds an executable `bwrap` under `codex-resources` in a package layout.

**Data flow**: Creates a temporary package tree with `bin/` and `codex-resources/bwrap`, constructs an `InstallContext` with a populated `CodexPackageLayout`, and asserts `find_for_install_context` returns the expected absolute path.

**Call relations**: Covers the preferred modern lookup path.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (assert_eq!, create_dir_all, write_executable, tempdir).


##### `tests::finds_legacy_standalone_bundled_bwrap_next_to_exe_resources`  (lines 229–240)

```
fn finds_legacy_standalone_bundled_bwrap_next_to_exe_resources()
```

**Purpose**: Checks the legacy `<exe_dir>/codex-resources/bwrap` fallback.

**Data flow**: Creates a temp executable and adjacent `codex-resources/bwrap`, marks both executable, and asserts `find_legacy_for_exe` returns the resource path.

**Call relations**: Exercises the first legacy candidate path.

*Call graph*: 3 external calls (assert_eq!, write_executable, tempdir).


##### `tests::finds_npm_bundled_bwrap_next_to_target_vendor_dir`  (lines 243–255)

```
fn finds_npm_bundled_bwrap_next_to_target_vendor_dir()
```

**Purpose**: Checks the legacy parent-target `codex-resources/bwrap` fallback used by npm/vendor layouts.

**Data flow**: Creates an exe under `vendor/<triple>/codex/codex` and a sibling `vendor/<triple>/codex-resources/bwrap`, then asserts `find_legacy_for_exe` finds that resource.

**Call relations**: Exercises the second legacy candidate path.

*Call graph*: 3 external calls (assert_eq!, write_executable, tempdir).


##### `tests::finds_adjacent_dev_bwrap`  (lines 258–269)

```
fn finds_adjacent_dev_bwrap()
```

**Purpose**: Checks the direct sibling `bwrap` fallback for development layouts.

**Data flow**: Creates a temp executable and sibling `bwrap`, marks both executable, and asserts `find_legacy_for_exe` returns the sibling path.

**Call relations**: Exercises the third legacy candidate path.

*Call graph*: 3 external calls (assert_eq!, write_executable, tempdir).


##### `tests::digest_verification_skips_missing_expected_digest`  (lines 272–278)

```
fn digest_verification_skips_missing_expected_digest()
```

**Purpose**: Verifies that digest checking is disabled when no expected digest is supplied.

**Data flow**: Creates a temp file with contents, calls `verify_digest(file.as_file(), None, file.path())`, and asserts success.

**Call relations**: Covers the early-return branch in `verify_digest`.

*Call graph*: calls 1 internal fn (verify_digest); 2 external calls (new, write).


##### `tests::digest_verification_accepts_matching_digest`  (lines 281–288)

```
fn digest_verification_accepts_matching_digest()
```

**Purpose**: Verifies that `verify_digest` succeeds when the file's SHA-256 matches the expected bytes.

**Data flow**: Writes known contents to a temp file, computes `Sha256::digest(b"contents")`, passes that digest to `verify_digest`, and asserts success.

**Call relations**: Covers the successful verification branch.

*Call graph*: calls 1 internal fn (verify_digest); 3 external calls (new, digest, write).


##### `tests::digest_verification_rejects_mismatched_digest`  (lines 291–298)

```
fn digest_verification_rejects_mismatched_digest()
```

**Purpose**: Verifies that `verify_digest` returns a descriptive error on digest mismatch.

**Data flow**: Writes known contents to a temp file, calls `verify_digest` with an incorrect `[0xab; 32]` digest, captures the error string, and asserts it mentions a bundled bubblewrap digest mismatch.

**Call relations**: Covers the mismatch branch and error formatting.

*Call graph*: calls 1 internal fn (verify_digest); 3 external calls (new, assert!, write).


##### `tests::parses_sha256_hex_digest`  (lines 301–306)

```
fn parses_sha256_hex_digest()
```

**Purpose**: Checks valid and invalid cases for hex digest parsing.

**Data flow**: Calls `parse_sha256_hex` with repeated `ab`, repeated `00`, a too-short string, and a string containing non-hex suffix bytes → asserts the expected `Ok` or `Err` outcomes.

**Call relations**: Direct unit test for the digest parser used by `expected_sha256`.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::write_executable`  (lines 308–315)

```
fn write_executable(path: &Path)
```

**Purpose**: Creates an empty executable file for lookup tests.

**Data flow**: Ensures the parent directory exists, writes empty bytes to the path, and sets mode `0o755` via `PermissionsExt`.

**Call relations**: Shared test helper used by all bundled-bwrap path discovery tests.

*Call graph*: 5 external calls (parent, from_mode, create_dir_all, set_permissions, write).


### `linux-sandbox/src/launcher.rs`

`orchestration` · `bubblewrap selection and exec during sandbox setup`

This file encapsulates bubblewrap discovery and the compatibility quirks of different `bwrap` builds. The central enum, `BubblewrapLauncher`, distinguishes a probed system binary, a bundled launcher supplied by another module, and total unavailability. For system binaries, `SystemBwrapLauncher` stores the normalized absolute path and whether that binary supports `--argv0`; `SystemBwrapCapabilities` also tracks support for `--perms`, which is treated as mandatory.

`preferred_bwrap_launcher` caches the discovery result in a `OnceLock`, so probing PATH and bundled resources happens only once per process. Discovery first asks `find_system_bwrap_in_path`, then validates the candidate with `system_bwrap_launcher_for_path_with_probe`. That helper rejects non-files, rejects binaries lacking `--perms`, normalizes the path into `AbsolutePathBuf`, and preserves whether `--argv0` is supported. Capability probing itself is intentionally simple: it runs `<bwrap> --help` and scans stdout/stderr text for `--argv0` and `--perms`.

`exec_bwrap` dispatches to the chosen launcher. For a system binary, `exec_system_bwrap` clears `FD_CLOEXEC` on preserved files, converts the program path and argv into C strings, builds a null-terminated pointer array, and calls `libc::execv`. If exec fails, it panics with the resolved path and OS error. The tests focus on launcher selection logic rather than actual process replacement, covering support and rejection cases for `--argv0`, `--perms`, and missing binaries.

#### Function details

##### `exec_bwrap`  (lines 36–49)

```
fn exec_bwrap(argv: Vec<String>, preserved_files: Vec<File>) -> !
```

**Purpose**: Selects the preferred bubblewrap launcher and transfers control to it. It either execs a system `bwrap`, delegates to the bundled launcher, or panics if no launcher exists.

**Data flow**: Consumes `argv: Vec<String>` and `preserved_files: Vec<File>`, reads the cached launcher from `preferred_bwrap_launcher()`, and matches on it. For `System`, it passes the program path plus argv/files to `exec_system_bwrap`; for `Bundled`, it calls the bundled launcher's `exec`; for `Unavailable`, it panics. On success it never returns.

**Call relations**: This is the common launch point used by the child-exec paths in `linux_run_main`. It delegates launcher-specific behavior downward after `run_bwrap_in_child_capture_stderr`, `run_bwrap_in_child_with_synthetic_mount_cleanup`, or `run_or_exec_bwrap` decide that bubblewrap should actually run.

*Call graph*: calls 2 internal fn (exec_system_bwrap, preferred_bwrap_launcher); called by 3 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup, run_or_exec_bwrap); 1 external calls (panic!).


##### `preferred_bwrap_launcher`  (lines 51–67)

```
fn preferred_bwrap_launcher() -> BubblewrapLauncher
```

**Purpose**: Discovers and memoizes the best available bubblewrap launcher for the current process. It prefers a sufficiently capable system binary over the bundled fallback.

**Data flow**: Uses a static `OnceLock<BubblewrapLauncher>`, initializing it on first call by checking `find_system_bwrap_in_path()` and probing that path, otherwise asking `bundled_bwrap::launcher()`, and finally falling back to `Unavailable`. Returns a cloned `BubblewrapLauncher` value without mutating anything after initialization.

**Call relations**: Called by both `exec_bwrap` and `preferred_bwrap_supports_argv0`. It is the top of the launcher-selection flow, and its cached result drives both actual execution and argv-shaping compatibility decisions.

*Call graph*: called by 2 (exec_bwrap, preferred_bwrap_supports_argv0); 1 external calls (new).


##### `system_bwrap_launcher_for_path`  (lines 69–71)

```
fn system_bwrap_launcher_for_path(system_bwrap_path: &Path) -> Option<SystemBwrapLauncher>
```

**Purpose**: Convenience wrapper that probes a specific filesystem path using the real capability detector. It exists to separate production probing from test injection.

**Data flow**: Reads `system_bwrap_path: &Path`, forwards it to `system_bwrap_launcher_for_path_with_probe` together with `system_bwrap_capabilities`, and returns `Option<SystemBwrapLauncher>`. It has no side effects beyond those of the delegated probe.

**Call relations**: This function is the production entry into the path-validation logic. Tests bypass it and call the `_with_probe` variant directly so they can inject synthetic capability results.

*Call graph*: calls 1 internal fn (system_bwrap_launcher_for_path_with_probe).


##### `system_bwrap_launcher_for_path_with_probe`  (lines 73–99)

```
fn system_bwrap_launcher_for_path_with_probe(
    system_bwrap_path: &Path,
    system_bwrap_capabilities: impl FnOnce(&Path) -> Option<SystemBwrapCapabilities>,
) -> Option<SystemBwrapLauncher>
```

**Purpose**: Validates a candidate system bubblewrap path, probes its capabilities, and constructs a launcher only if the binary is usable. It enforces the requirement that system `bwrap` must support `--perms`.

**Data flow**: Takes `system_bwrap_path` and a probe callback. It first checks `is_file()`, then invokes the probe and pattern-matches for `supports_perms: true`; otherwise it returns `None`. If accepted, it normalizes the path with `AbsolutePathBuf::from_absolute_path`, panicking on normalization failure, and returns `Some(SystemBwrapLauncher { program, supports_argv0 })`.

**Call relations**: Used by `system_bwrap_launcher_for_path` in production and directly by tests with fake probe closures. It sits between raw path discovery and the cached launcher selection in `preferred_bwrap_launcher`.

*Call graph*: calls 2 internal fn (system_bwrap_capabilities, from_absolute_path); called by 1 (system_bwrap_launcher_for_path); 2 external calls (is_file, panic!).


##### `preferred_bwrap_supports_argv0`  (lines 101–106)

```
fn preferred_bwrap_supports_argv0() -> bool
```

**Purpose**: Reports whether the chosen launcher can honor bubblewrap's `--argv0` flag. Bundled and unavailable launchers are treated as supporting it for compatibility purposes.

**Data flow**: Reads the current launcher from `preferred_bwrap_launcher()` and returns `launcher.supports_argv0` for system launchers, or `true` for bundled/unavailable cases. It does not mutate state.

**Call relations**: Called by `apply_inner_command_argv0` in `linux_run_main` to decide whether to inject `--argv0` or rewrite the inner command path as a fallback.

*Call graph*: calls 1 internal fn (preferred_bwrap_launcher); called by 1 (apply_inner_command_argv0).


##### `system_bwrap_capabilities`  (lines 108–124)

```
fn system_bwrap_capabilities(system_bwrap_path: &Path) -> Option<SystemBwrapCapabilities>
```

**Purpose**: Probes a system bubblewrap binary by running `--help` and scanning its output for feature flags. It detects support for `--argv0` and `--perms` without depending on version parsing.

**Data flow**: Runs `Command::new(system_bwrap_path).arg("--help").output()`, returns `None` if process creation fails, converts stdout and stderr with `String::from_utf8_lossy`, and returns `Some(SystemBwrapCapabilities { supports_argv0, supports_perms })` based on substring checks. It spawns a subprocess but does not mutate persistent state.

**Call relations**: This is the default probe callback used by `system_bwrap_launcher_for_path_with_probe`. Its output determines whether a system binary is accepted and whether later argv construction may use `--argv0`.

*Call graph*: called by 1 (system_bwrap_launcher_for_path_with_probe); 2 external calls (from_utf8_lossy, new).


##### `exec_system_bwrap`  (lines 126–152)

```
fn exec_system_bwrap(
    program: &AbsolutePathBuf,
    argv: Vec<String>,
    preserved_files: Vec<File>,
) -> !
```

**Purpose**: Execs a specific system bubblewrap binary with the provided argv and preserved file descriptors. It performs the final C-string and fd-inheritance preparation needed for `libc::execv`.

**Data flow**: Consumes `program: &AbsolutePathBuf`, `argv: Vec<String>`, and `preserved_files: Vec<File>`. It first calls `make_files_inheritable(&preserved_files)`, converts the program path bytes into a `CString`, converts argv via `argv_to_cstrings`, maps those to `*const c_char` pointers, appends a trailing null pointer, and calls `libc::execv(program.as_ptr(), argv_ptrs.as_ptr())`. If exec returns, it reads `last_os_error()` and panics. On success it never returns.

**Call relations**: Reached only from `exec_bwrap` when the preferred launcher is a system binary. It is the concrete system-launch path, while bundled launchers implement their own exec behavior elsewhere.

*Call graph*: calls 3 internal fn (argv_to_cstrings, make_files_inheritable, as_path); called by 1 (exec_bwrap); 6 external calls (new, last_os_error, execv, panic!, null, as_ptr).


##### `tests::prefers_system_bwrap_when_help_lists_argv0`  (lines 161–178)

```
fn prefers_system_bwrap_when_help_lists_argv0()
```

**Purpose**: Verifies that a candidate system binary is accepted when the probe reports both `--argv0` and `--perms` support. It also checks that the normalized absolute path is preserved in the launcher.

**Data flow**: Creates a temporary file to stand in for a binary path, computes the expected `AbsolutePathBuf`, calls `system_bwrap_launcher_for_path_with_probe` with a closure returning full capabilities, and asserts the returned `SystemBwrapLauncher` matches the expected path and `supports_argv0: true`.

**Call relations**: This test exercises the successful system-launcher branch of the path/probe logic with the most capable feature set.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (new, assert_eq!).


##### `tests::prefers_system_bwrap_when_system_bwrap_lacks_argv0`  (lines 181–197)

```
fn prefers_system_bwrap_when_system_bwrap_lacks_argv0()
```

**Purpose**: Checks that a system bubblewrap lacking `--argv0` is still accepted as long as it supports `--perms`. This preserves compatibility with older distro builds.

**Data flow**: Creates a temporary file path, invokes `system_bwrap_launcher_for_path_with_probe` with a closure returning `supports_argv0: false` and `supports_perms: true`, and asserts the result is `Some(SystemBwrapLauncher { ... supports_argv0: false })`.

**Call relations**: This test covers the compatibility path that later forces argv rewriting instead of `--argv0` insertion.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::ignores_system_bwrap_when_system_bwrap_lacks_perms`  (lines 200–212)

```
fn ignores_system_bwrap_when_system_bwrap_lacks_perms()
```

**Purpose**: Verifies that a system bubblewrap is rejected if it does not support `--perms`, even if the path exists. This enforces the minimum capability requirement for the sandbox command builder.

**Data flow**: Creates a temporary file path, probes it with a closure returning `supports_perms: false`, and asserts the launcher result is `None`. No external state is changed.

**Call relations**: This test locks down the rejection branch in `system_bwrap_launcher_for_path_with_probe` that causes launcher selection to fall through to bundled or unavailable modes.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::ignores_system_bwrap_when_system_bwrap_is_missing`  (lines 215–220)

```
fn ignores_system_bwrap_when_system_bwrap_is_missing()
```

**Purpose**: Checks that a nonexistent path is not treated as a valid system bubblewrap launcher. It validates the initial filesystem existence gate.

**Data flow**: Calls `system_bwrap_launcher_for_path` on a definitely missing path and asserts the result is `None`. It performs no writes.

**Call relations**: This test covers the earliest rejection path before capability probing is attempted.

*Call graph*: 1 external calls (assert_eq!).


### Unix shell escalation protocol
These files define the Unix shell escalation library surface and its client-server protocol for intercepting execs, consulting policy, and performing escalated launches.

### `shell-escalation/src/lib.rs`

`orchestration` · `compile-time API surface; referenced wherever shell-escalation is integrated`

This file is the top-level facade for the shell-escalation crate. On Unix builds it declares the internal `unix` module and then re-exports the protocol constants, policy traits, server/session types, execution request and result types, wrapper entrypoints, and utility timing type that make up the crate's usable interface. The design keeps all implementation details in `src/unix/*` while presenting a flat crate API to downstream callers, so consumers can import `EscalateServer`, `EscalationPolicy`, `ExecParams`, `main_execve_wrapper`, and related types directly from the crate root without knowing the module layout.

The `#[cfg(unix)]` guards are the key behavior here: the crate only exposes functionality when compiled for Unix, matching the protocol's dependence on Unix process execution, inherited file descriptors, and socket passing. There is no fallback implementation or stub API for non-Unix targets in this file, so platform support is intentionally explicit. The file also distinguishes between protocol-layer types (`EscalateAction`, `EscalationDecision`, `EscalationExecution`), server/runtime types (`EscalateServer`, `EscalationSession`, `PreparedExec`, `ExecResult`), policy abstractions (`EscalationPolicy`, `EscalationPolicyFuture`), and approval/profile types re-exported from the Unix module, making the crate root the canonical import point for the subsystem.


### `shell-escalation/src/unix/mod.rs`

`orchestration` · `compile-time module wiring and shared API surface for Unix builds`

This module file is the Unix-specific hub for the shell-escalation implementation. Its module declarations split the subsystem into transport and protocol pieces (`escalate_client`, `escalate_protocol`, `socket`), server-side execution and session management (`escalate_server`), policy evaluation (`escalation_policy`), wrapper process behavior (`execve_wrapper`), and timing support (`stopwatch`). The extensive module-level documentation is operationally important: it explains that every shell `exec()` attempt is intercepted by a wrapper, which sends an `EscalateRequest` over an inherited socket named by `CODEX_ESCALATE_SOCKET`, and includes a per-request response socket file descriptor so the server can reply independently for concurrent requests.

The file then re-exports the subsystem's public API from those internal modules. Protocol constants and enums such as `ESCALATE_SOCKET_ENV_VAR`, `EscalateAction`, `EscalationDecision`, and `EscalationExecution` are surfaced alongside server-facing types like `EscalateServer`, `EscalationSession`, `ExecParams`, `PreparedExec`, `ExecResult`, and the async executor traits. It also re-exports `EscalationPolicy` and `EscalationPolicyFuture`, the wrapper entrypoints `run_shell_escalation_execve_wrapper` and `main_execve_wrapper`, and approval/profile types from `codex_protocol::approvals`. The result is a single Unix namespace that hides internal file layout while preserving the conceptual separation between protocol, policy, execution, and wrapper concerns.


### `shell-escalation/src/unix/escalation_policy.rs`

`domain_logic` · `request handling, when the server evaluates each intercepted exec request`

This file contains the core abstraction for authorization and routing decisions in the shell-escalation subsystem: the `EscalationPolicy` trait. Implementors receive the absolute executable path as an `AbsolutePathBuf`, the argument vector as `&[String]`, and the working directory as another `AbsolutePathBuf`, and must asynchronously produce an `anyhow::Result<EscalationDecision>`. The returned `EscalationDecision` comes from the protocol layer and encodes the concrete action the server should send back to the exec wrapper.

The trait is constrained with `Send + Sync`, which is an important design choice: policy objects are intended to be shared across concurrent request handling in the server. The associated future type is spelled out as `EscalationPolicyFuture<'a> = Pin<Box<dyn Future<Output = anyhow::Result<EscalationDecision>> + Send + 'a>>`, allowing implementations to capture borrowed request data without forcing a specific async runtime or generic associated type pattern. Boxing and pinning erase the concrete future type, simplifying storage behind trait objects at the cost of one allocation per decision. The lifetime parameter ties the future to the borrowed inputs, preventing implementations from returning futures that outlive the request data they inspect.


### `shell-escalation/src/unix/escalate_client.rs`

`io_transport` · `request handling`

This file is the client half of a Unix domain socket escalation handshake. It begins by reconstructing an inherited datagram socket from the file descriptor number stored in `ESCALATE_SOCKET_ENV_VAR`; that socket is assumed to have been pre-opened by a parent process and is consumed by `AsyncDatagramSocket::from_raw_fd`. The main async routine, `run_shell_escalation_execve_wrapper`, creates a connected socket pair for a reliable follow-up channel, sends one end to the server in a one-byte handshake datagram, then transmits an `EscalateRequest` containing the target executable path, argument vector, current working directory from `AbsolutePathBuf::current_dir()`, and a filtered environment map that deliberately strips both escalation-specific environment variables so they do not leak into the child.

After receiving `EscalateResponse`, control splits on `EscalateAction`. For `Escalate`, the wrapper duplicates stdin/stdout/stderr into fresh `OwnedFd`s before sending them, preserving the wrapper’s own standard streams while transferring duplicates plus their destination fd numbers in `SuperExecMessage`; it then waits for `SuperExecResult` and returns the reported exit code. For `Run`, it bypasses `std::process::Command` and performs a raw `libc::execv`, carefully building NUL-terminated `CString` arguments and returning the OS error only if `execv` fails. For `Deny`, it prints an optional human-readable reason and exits with code 1. The included test verifies the key invariant behind descriptor transfer: duplicating a fd must not invalidate the original when the duplicate is dropped.

#### Function details

##### `get_escalate_client`  (lines 19–28)

```
fn get_escalate_client() -> anyhow::Result<AsyncDatagramSocket>
```

**Purpose**: Reconstructs the inherited escalation datagram socket from the environment and validates that the advertised descriptor number is non-negative before taking ownership of it.

**Data flow**: Reads `ESCALATE_SOCKET_ENV_VAR` from process environment, parses it as `i32`, rejects negative values with an `anyhow!` error, then passes the raw fd into `AsyncDatagramSocket::from_raw_fd`. It returns the resulting `AsyncDatagramSocket` on success or propagates parse/environment/socket-construction failures.

**Call relations**: This helper is only used at the start of `run_shell_escalation_execve_wrapper`, where the wrapper needs the prearranged datagram channel to contact the escalation server before any request-specific socket pair is created.

*Call graph*: calls 1 internal fn (from_raw_fd); called by 1 (run_shell_escalation_execve_wrapper); 2 external calls (anyhow!, var).


##### `duplicate_fd_for_transfer`  (lines 30–34)

```
fn duplicate_fd_for_transfer(fd: impl AsFd, name: &str) -> anyhow::Result<OwnedFd>
```

**Purpose**: Creates an owned duplicate of an existing file descriptor specifically for passing it over a Unix socket without surrendering the caller’s original descriptor.

**Data flow**: Accepts any `impl AsFd` plus a descriptive `name`, borrows the underlying fd with `as_fd()`, clones it into an `OwnedFd` via `try_clone_to_owned()`, and wraps clone failures with context naming the stream being duplicated. It returns the new `OwnedFd` while leaving the original fd open and usable.

**Call relations**: During escalation, `run_shell_escalation_execve_wrapper` calls this three times for stdin, stdout, and stderr before sending descriptors to the server. The unit test invokes it directly to prove the original descriptor survives after the duplicate is dropped.

*Call graph*: called by 2 (run_shell_escalation_execve_wrapper, duplicate_fd_for_transfer_does_not_close_original); 1 external calls (as_fd).


##### `run_shell_escalation_execve_wrapper`  (lines 36–124)

```
async fn run_shell_escalation_execve_wrapper(
    file: String,
    argv: Vec<String>,
) -> anyhow::Result<i32>
```

**Purpose**: Drives the full exec-wrapper protocol: establish a server conversation channel, send the execution request, interpret the server’s decision, and either transfer stdio for privileged execution, directly `execv`, or report denial.

**Data flow**: Consumes `file: String` and `argv: Vec<String>`. It first obtains the inherited datagram client via `get_escalate_client`, creates an `AsyncSocket::pair`, and sends a one-byte handshake plus one socket endpoint to the server. It collects the current environment while filtering out `ESCALATE_SOCKET_ENV_VAR` and `EXEC_WRAPPER_ENV_VAR`, captures the current directory, and sends an `EscalateRequest { file, argv, workdir, env }` over the retained socket. After receiving `EscalateResponse`, it branches: for `Escalate`, it records destination fd numbers for standard streams, duplicates those streams with `duplicate_fd_for_transfer`, sends a `SuperExecMessage` plus the duplicated fds, then receives `SuperExecResult` and returns its `exit_code`; for `Run`, it converts `file` and each argv element into `CString`, builds a null-terminated `argv` pointer array, calls `libc::execv`, and if control returns converts `last_os_error()` into failure; for `Deny`, it prints either `Execution denied` or `Execution denied: <reason>` to stderr and returns `Ok(1)`.

**Call relations**: This is the file’s top-level operational path, invoked when the process is acting as the exec wrapper. It orchestrates all local helpers and socket interactions: it starts with `get_escalate_client`, uses fd duplication only in the escalation branch, and otherwise terminates by replacing the process image with `execv` or by returning a conventional denial exit code.

*Call graph*: calls 4 internal fn (duplicate_fd_for_transfer, get_escalate_client, pair, current_dir); 9 external calls (new, last_os_error, eprintln!, stderr, stdin, stdout, execv, vars, null).


##### `tests::duplicate_fd_for_transfer_does_not_close_original`  (lines 133–143)

```
fn duplicate_fd_for_transfer_does_not_close_original()
```

**Purpose**: Verifies that duplicating a descriptor for transfer yields a distinct fd number and that dropping the duplicate does not close the original socket.

**Data flow**: Creates a `UnixStream::pair`, records the raw fd of one endpoint, calls `duplicate_fd_for_transfer(&left, "test fd")`, asserts the duplicate fd differs from the original, drops the duplicate, then uses `libc::fcntl(..., F_GETFD)` to confirm the original fd is still valid. It produces no value beyond test pass/fail.

**Call relations**: This test exercises `duplicate_fd_for_transfer` in isolation rather than through the full escalation flow, targeting the ownership invariant that `run_shell_escalation_execve_wrapper` depends on before sending stdio descriptors to another process.

*Call graph*: calls 1 internal fn (duplicate_fd_for_transfer); 2 external calls (assert_ne!, pair).


### `shell-escalation/src/unix/escalate_server.rs`

`domain_logic` · `request handling`

This file is the core runtime for shell escalation on Unix. Its public surface is `EscalateServer`, which is configured with a shell path, an execve-wrapper path, and an `EscalationPolicy`; `ExecParams`/`ExecResult` for one-shot shell execution; `PreparedExec` for server-side escalated launches; and the `ShellCommandExecutor` trait that decouples protocol handling from the caller's process-launching environment. `EscalateServer::start_session` creates a Unix datagram socket pair, marks only the client endpoint as inheritable across exec (`FD_CLOEXEC` cleared), spawns a background `escalate_task`, and returns an `EscalationSession` containing just the environment overlay (`ESCALATE_SOCKET_ENV_VAR`, `EXEC_WRAPPER_ENV_VAR`) needed by the wrapper. `EscalateServer::exec` builds the shell command (`-lc` by default, `-c` when `login == Some(false)`), starts a session, and delegates actual shell spawning to the injected executor, passing an `after_spawn` hook that closes the parent's copy of the inherited socket immediately after spawn.

The background task waits for datagram handshakes carrying exactly one passed file descriptor, converts that fd into an `AsyncSocket`, and spawns a per-request worker. `handle_escalate_session_with_policy` receives an `EscalateRequest`, resolves relative executable paths against the request workdir, asks policy for an `EscalationDecision`, and then either replies `Run`, replies `Deny`, or performs the full escalation flow: acknowledge `Escalate`, receive a `SuperExecMessage` plus SCM_RIGHTS fds, verify fd-count consistency, ask the executor to translate the request into a concrete `PreparedExec`, spawn the child with null stdio and `kill_on_drop(true)`, remap received fds in `pre_exec` via `dup2`, wait for completion or cancellation, and send back `SuperExecResult`. Session drop is intentionally aggressive: it closes the client socket, cancels the session token, and aborts the background task so in-flight workers and spawned children are torn down promptly. The tests exercise environment export, path resolution, permission propagation, after-spawn socket closure, overlapping fd remaps, and cancellation-driven child termination.

#### Function details

##### `EscalationSession::env`  (lines 112–114)

```
fn env(&self) -> &HashMap<String, String>
```

**Purpose**: Returns the session's environment overlay map exactly as prepared by `start_session`. The map contains only the escalation socket fd and wrapper path variables, not a full child environment.

**Data flow**: Reads `self.env` by shared reference and returns `&HashMap<String, String>` without cloning or mutation. No external state is touched.

**Call relations**: Used by callers that need to merge the overlay into a child process environment after `EscalateServer::start_session` or inside `EscalateServer::exec`; it is part of the handoff from session setup to shell spawning.

*Call graph*: called by 1 (inherited_fds).


##### `EscalationSession::close_client_socket`  (lines 116–120)

```
fn close_client_socket(&self)
```

**Purpose**: Drops the parent-held client socket endpoint so only the spawned wrapper process retains the inherited descriptor. This prevents the parent from accidentally keeping the escalation channel alive.

**Data flow**: Locks `self.client_socket: Arc<Mutex<Option<Socket>>>`; if locking succeeds, it replaces the inner `Some(Socket)` with `None` via `take()`, dropping the socket. It returns `()` and ignores poisoned-lock errors.

**Call relations**: Invoked explicitly by the `after_spawn` closure installed from `EscalateServer::exec`, and also from `EscalationSession::drop` as a cleanup fallback if the caller never closed it manually.

*Call graph*: called by 2 (after_spawn, drop).


##### `EscalationSession::drop`  (lines 124–128)

```
fn drop(&mut self)
```

**Purpose**: Performs best-effort teardown of a live escalation session when the handle goes out of scope. It ensures the inherited client socket is closed and the background server task is stopped immediately.

**Data flow**: Mutably accesses the session, calls `close_client_socket()`, triggers `self.cancellation_token.cancel()`, and aborts `self.task`. It returns no value and relies on drop side effects.

**Call relations**: Runs automatically at session destruction. It is the final cleanup path after `start_session`, and tests rely on it to abort intercept workers and kill spawned escalated children through task cancellation and `kill_on_drop` child handling.

*Call graph*: calls 1 internal fn (close_client_socket); 2 external calls (cancel, abort).


##### `EscalateServer::new`  (lines 138–147)

```
fn new(shell_path: PathBuf, execve_wrapper: PathBuf, policy: Policy) -> Self
```

**Purpose**: Constructs an escalation server from concrete shell and wrapper paths plus a policy implementation. The policy is type-erased behind `Arc<dyn EscalationPolicy>` for later sharing across worker tasks.

**Data flow**: Consumes `shell_path: PathBuf`, `execve_wrapper: PathBuf`, and a generic `policy`, wraps the policy in `Arc`, and returns a populated `EscalateServer`.

**Call relations**: This is the setup entry used by higher-level execution paths and tests before any session or request handling can occur.

*Call graph*: called by 5 (prepare_unified_exec_zsh_fork, try_run_zsh_fork, dropping_session_aborts_intercept_workers_and_kills_spawned_child, exec_closes_parent_socket_after_shell_spawn, start_session_exposes_wrapper_env_overlay); 1 external calls (new).


##### `EscalateServer::exec`  (lines 149–182)

```
async fn exec(
        &self,
        params: ExecParams,
        cancel_rx: CancellationToken,
        command_executor: Arc<dyn ShellCommandExecutor>,
    ) -> anyhow::Result<ExecResult>
```

**Purpose**: Runs a shell command under an escalation session using the caller-provided executor for actual process creation. It is the one-shot convenience path that combines session setup, shell argv construction, and executor invocation.

**Data flow**: Takes `ExecParams`, a cancellation token, and an `Arc<dyn ShellCommandExecutor>`. It starts a session, clones the exported env overlay and client-socket handle, builds `command = [shell_path, "-c"|"-lc", params.command]`, parses `params.workdir` into `AbsolutePathBuf`, and awaits `command_executor.run(...)`. The `after_spawn` callback closes the parent socket copy. It returns the executor's `ExecResult` or propagates errors from session setup, path parsing, or executor execution.

**Call relations**: Called by higher-level command execution code when a shell command should run with interception enabled. It delegates session creation to `start_session` and relies on the executor to merge the overlay into its own environment and spawn the shell.

*Call graph*: calls 2 internal fn (start_session, try_from); 4 external calls (clone, new, clone, vec!).


##### `EscalateServer::start_session`  (lines 189–223)

```
fn start_session(
        &self,
        parent_cancellation_token: CancellationToken,
        command_executor: Arc<dyn ShellCommandExecutor>,
    ) -> anyhow::Result<EscalationSession>
```

**Purpose**: Creates the socket plumbing and background task needed for a shell wrapper to route intercepted execs back to this process. It returns a session handle rather than spawning the shell itself.

**Data flow**: Accepts a parent cancellation token and a shared command executor. It creates a fresh session cancellation token, allocates an `AsyncDatagramSocket` pair, extracts the raw client `Socket`, records its fd, clears `FD_CLOEXEC` on that endpoint, wraps it in `Arc<Mutex<Option<Socket>>>`, and spawns `escalate_task(...)` with the server endpoint, shared policy, executor, and both cancellation tokens. It then builds an env `HashMap` containing `ESCALATE_SOCKET_ENV_VAR=<fd>` and `EXEC_WRAPPER_ENV_VAR=<wrapper path>` and returns an `EscalationSession` holding that env, the task handle, the client socket, and the session token.

**Call relations**: Used directly by callers that want manual control over shell spawning and indirectly by `EscalateServer::exec`. It is the bridge from static server configuration to a live per-shell interception session.

*Call graph*: calls 2 internal fn (escalate_task, pair); called by 1 (exec); 7 external calls (clone, new, new, new, new, to_string_lossy, spawn).


##### `escalate_task`  (lines 226–262)

```
async fn escalate_task(
    socket: AsyncDatagramSocket,
    policy: Arc<dyn EscalationPolicy>,
    command_executor: Arc<dyn ShellCommandExecutor>,
    parent_cancellation_token: CancellationToken,
```

**Purpose**: Runs the session's background accept loop for escalation handshakes arriving on the datagram socket. Each valid handshake spawns an independent worker for one intercepted exec stream.

**Data flow**: Receives the server `AsyncDatagramSocket`, shared policy and executor, and parent/session cancellation tokens. In a loop it waits on `socket.receive_with_fds()` or either cancellation token. For each datagram it expects exactly one passed fd; otherwise it logs an error and continues. With one fd, it converts it to `AsyncSocket`, clones the shared state and tokens, and spawns an async task that runs `handle_escalate_session_with_policy(...)`, logging any worker error.

**Call relations**: Spawned by `EscalateServer::start_session` and lives for the duration of the session. It delegates all per-request protocol work to `handle_escalate_session_with_policy` after validating the initial handshake shape.

*Call graph*: calls 2 internal fn (handle_escalate_session_with_policy, from_fd); called by 1 (start_session); 5 external calls (clone, clone, select!, spawn, error!).


##### `handle_escalate_session_with_policy`  (lines 264–379)

```
async fn handle_escalate_session_with_policy(
    socket: AsyncSocket,
    policy: Arc<dyn EscalationPolicy>,
    command_executor: Arc<dyn ShellCommandExecutor>,
    parent_cancellation_token: Cancel
```

**Purpose**: Processes one intercepted exec request from start to finish: receive request, resolve the target path, ask policy for a decision, and either allow, deny, or execute an escalated subprocess with fd remapping.

**Data flow**: Consumes an `AsyncSocket`, shared policy and executor, and parent/session cancellation tokens. It first waits for an `EscalateRequest { file, argv, workdir, env }`, resolving `file` against `workdir` with `AbsolutePathBuf::resolve_path_against_base`. It then awaits `policy.determine_action(&program, &argv, &workdir)`. For `Run`, it sends `EscalateResponse { action: Run }`. For `Deny`, it sends `EscalateResponse { action: Deny { reason } }`. For `Escalate(execution)`, it sends `Escalate`, receives `SuperExecMessage` plus SCM_RIGHTS fds, checks `fds.len() == msg.fds.len()`, asks `command_executor.prepare_escalated_exec(...)` for `PreparedExec { command, cwd, env, arg0 }`, splits the command into program and args, builds a `tokio::process::Command` with env/current_dir/null stdio/`kill_on_drop(true)`, installs a `pre_exec` hook that `dup2`s each received fd onto its requested destination fd, spawns the child, waits for exit or cancellation (killing on cancellation), and sends `SuperExecResult { exit_code }`. It returns `Ok(())` on normal completion or cancellation, and errors on protocol mismatches or spawn/IO failures.

**Call relations**: Invoked by `escalate_task` for real traffic and directly by tests. It is the central protocol state machine, delegating policy choice to `EscalationPolicy` and command materialization to `ShellCommandExecutor::prepare_escalated_exec`.

*Call graph*: calls 2 internal fn (send, resolve_path_against_base); called by 6 (escalate_task, handle_escalate_session_accepts_received_fds_that_overlap_destinations, handle_escalate_session_executes_escalated_command, handle_escalate_session_passes_permissions_to_executor, handle_escalate_session_resolves_relative_file_against_request_workdir, handle_escalate_session_respects_run_in_sandbox_decision); 5 external calls (null, anyhow!, new, select!, debug!).


##### `tests::DeterministicEscalationPolicy::determine_action`  (lines 410–417)

```
fn determine_action(
            &'a self,
            _file: &'a AbsolutePathBuf,
            _argv: &'a [String],
            _workdir: &'a AbsolutePathBuf,
        ) -> EscalationPolicyFuture<'a>
```

**Purpose**: Test policy implementation that always returns a preconfigured `EscalationDecision`. It removes policy variability so protocol behavior can be tested deterministically.

**Data flow**: Ignores the incoming file, argv, and workdir, clones `self.decision`, and returns it inside an async future as `Ok(decision)`.

**Call relations**: Used by multiple tests that need the server to unconditionally choose `Run` or a specific `Escalate(...)` path without inspecting request contents.

*Call graph*: 2 external calls (pin, clone).


##### `tests::AssertingEscalationPolicy::determine_action`  (lines 426–437)

```
fn determine_action(
            &'a self,
            file: &'a AbsolutePathBuf,
            _argv: &'a [String],
            workdir: &'a AbsolutePathBuf,
        ) -> EscalationPolicyFuture<'a>
```

**Purpose**: Test policy that verifies the server resolved the executable path and workdir exactly as expected before returning a `Run` decision. It specifically checks relative-path resolution behavior.

**Data flow**: Receives `file` and `workdir`, compares them against `self.expected_file` and `self.expected_workdir` with assertions, ignores argv, and returns `Ok(EscalationDecision::run())` in an async future.

**Call relations**: Used by the relative-path test to validate that `handle_escalate_session_with_policy` calls `resolve_path_against_base` correctly before consulting policy.

*Call graph*: calls 1 internal fn (run); 2 external calls (pin, assert_eq!).


##### `tests::ForwardingShellCommandExecutor::run`  (lines 462–473)

```
fn run(
            &self,
            _command: Vec<String>,
            _cwd: PathBuf,
            _env_overlay: HashMap<String, String>,
            _cancel_rx: CancellationToken,
            _afte
```

**Purpose**: Placeholder `run` implementation for tests that exercise only server-side escalation handling and never call the one-shot shell execution path. It intentionally panics if used.

**Data flow**: Accepts the executor trait arguments but ignores them and returns a boxed future that immediately hits `unreachable!()`.

**Call relations**: Supplies a complete `ShellCommandExecutor` implementation to tests focused on `handle_escalate_session_with_policy`; those tests only use its `prepare_escalated_exec` method.

*Call graph*: 2 external calls (pin, unreachable!).


##### `tests::ForwardingShellCommandExecutor::prepare_escalated_exec`  (lines 475–486)

```
fn prepare_escalated_exec(
            &'a self,
            program: &'a AbsolutePathBuf,
            argv: &'a [String],
            workdir: &'a AbsolutePathBuf,
            env: HashMap<String, St
```

**Purpose**: Builds a `PreparedExec` that forwards the requested program, argv tail, workdir, and environment unchanged into the escalated child. It models the simplest possible executor behavior.

**Data flow**: Takes `program`, `argv`, `workdir`, `env`, and ignores `execution`. It constructs `command` from the absolute program path followed by `argv[1..]`, sets `cwd` from `workdir.to_path_buf()`, preserves `env`, copies `argv.first()` into `arg0`, and returns the assembled `PreparedExec`.

**Call relations**: Used by escalation tests as the executor-side translation step after `handle_escalate_session_with_policy` decides to escalate.

*Call graph*: calls 2 internal fn (to_path_buf, to_string_lossy); 3 external calls (pin, prepare_escalated_exec, once).


##### `tests::PermissionAssertingShellCommandExecutor::run`  (lines 518–529)

```
fn run(
            &self,
            _command: Vec<String>,
            _cwd: PathBuf,
            _env_overlay: HashMap<String, String>,
            _cancel_rx: CancellationToken,
            _afte
```

**Purpose**: Placeholder `run` implementation for tests that only care about escalated execution preparation and permission propagation. It panics if the one-shot shell path is accidentally exercised.

**Data flow**: Ignores all inputs and returns a boxed future that immediately triggers `unreachable!()`.

**Call relations**: Paired with permission-focused tests where only `prepare_escalated_exec` should be called by `handle_escalate_session_with_policy`.

*Call graph*: 2 external calls (pin, unreachable!).


##### `tests::PermissionAssertingShellCommandExecutor::prepare_escalated_exec`  (lines 531–544)

```
fn prepare_escalated_exec(
            &'a self,
            program: &'a AbsolutePathBuf,
            argv: &'a [String],
            workdir: &'a AbsolutePathBuf,
            env: HashMap<String, St
```

**Purpose**: Verifies that the `EscalationExecution` passed from policy reaches the executor unchanged, then constructs a forwarded `PreparedExec`. It specifically checks permission-bearing escalation requests.

**Data flow**: Receives `program`, `argv`, `workdir`, `env`, and `execution`; asserts that `execution` equals `EscalationExecution::Permissions(self.expected_permissions.clone())`; then builds and returns a `PreparedExec` with forwarded command, cwd, env, and original `arg0`.

**Call relations**: Used by the permissions test to confirm that `handle_escalate_session_with_policy` passes policy-selected permission data into executor preparation.

*Call graph*: calls 2 internal fn (to_path_buf, to_string_lossy); 4 external calls (pin, assert_eq!, prepare_escalated_exec, once).


##### `tests::wait_for_pid_file`  (lines 547–561)

```
async fn wait_for_pid_file(pid_file: &std::path::Path) -> anyhow::Result<i32>
```

**Purpose**: Polls for a pid file to appear and parses its integer contents, with a fixed timeout. It supports tests that need to observe a spawned child process after asynchronous startup.

**Data flow**: Takes a filesystem path, computes a deadline five seconds in the future, repeatedly tries `std::fs::read_to_string`, trims and parses the contents to `i32` on success, otherwise sleeps 20 ms between attempts. It returns the parsed pid or an error if the deadline expires.

**Call relations**: Used by the session-drop cleanup test after launching an escalated shell command that writes its pid to disk.

*Call graph*: 6 external calls (from_millis, from_secs, now, anyhow!, read_to_string, sleep).


##### `tests::process_exists`  (lines 563–569)

```
fn process_exists(pid: i32) -> bool
```

**Purpose**: Checks whether a process id still refers to a live process using `kill(pid, 0)`. It treats any error other than `ESRCH` as evidence that the process still exists.

**Data flow**: Takes `pid: i32`, calls `libc::kill(pid, 0)`, returns `true` on success, and on failure inspects `last_os_error().raw_os_error()` to distinguish `ESRCH` from other cases.

**Call relations**: Used by `wait_for_process_exit` and by the session-drop test to verify that the escalated child starts and later disappears.

*Call graph*: 2 external calls (last_os_error, kill).


##### `tests::AfterSpawnAssertingShellCommandExecutor::run`  (lines 600–613)

```
fn run(
            &self,
            _command: Vec<String>,
            _cwd: PathBuf,
            env_overlay: HashMap<String, String>,
            _cancel_rx: CancellationToken,
            after_
```

**Purpose**: Test executor for `EscalateServer::exec` that verifies the exported socket fd is valid before spawn cleanup and that the provided `after_spawn` hook is actually invoked. It then returns a synthetic successful `ExecResult`.

**Data flow**: Reads `ESCALATE_SOCKET_ENV_VAR` from `env_overlay`, parses it to an fd, asserts `fcntl(F_GETFD)` succeeds on that fd, invokes the required `after_spawn` callback, sets `after_spawn_invoked` to `true`, and returns an `ExecResult` with zero exit code, empty outputs, zero duration, and `timed_out = false`.

**Call relations**: Used only by the `exec_closes_parent_socket_after_shell_spawn` test to validate the contract between `EscalateServer::exec` and `ShellCommandExecutor::run`.

*Call graph*: 4 external calls (pin, new, assert_ne!, run).


##### `tests::AfterSpawnAssertingShellCommandExecutor::prepare_escalated_exec`  (lines 615–624)

```
fn prepare_escalated_exec(
            &'a self,
            _program: &'a AbsolutePathBuf,
            _argv: &'a [String],
            _workdir: &'a AbsolutePathBuf,
            _env: HashMap<String
```

**Purpose**: Placeholder escalation-preparation method for a test executor that is only meant to exercise the one-shot shell path. It panics if escalation preparation is attempted.

**Data flow**: Ignores all inputs and returns a boxed future that immediately triggers `unreachable!()`.

**Call relations**: Completes the trait implementation for the after-spawn test while ensuring only `run` is used.

*Call graph*: 2 external calls (pin, unreachable!).


##### `tests::wait_for_process_exit`  (lines 627–638)

```
async fn wait_for_process_exit(pid: i32) -> anyhow::Result<()>
```

**Purpose**: Polls until a process id no longer exists, with a fixed timeout. It is the inverse of `wait_for_pid_file` and supports cleanup assertions.

**Data flow**: Takes `pid: i32`, computes a five-second deadline, repeatedly calls `process_exists(pid)`, returns `Ok(())` once it becomes false, otherwise sleeps 20 ms between checks and errors on timeout.

**Call relations**: Used by the session-drop test to confirm that dropping `EscalationSession` eventually kills the escalated child.

*Call graph*: 6 external calls (from_millis, from_secs, now, anyhow!, process_exists, sleep).


##### `tests::start_session_exposes_wrapper_env_overlay`  (lines 649–688)

```
async fn start_session_exposes_wrapper_env_overlay() -> anyhow::Result<()>
```

**Purpose**: Verifies that `start_session` exports only the wrapper/socket environment overlay, preserves the configured wrapper path string, and keeps the client socket fd valid until explicitly closed.

**Data flow**: Creates a server with sentinel shell and wrapper paths, starts a session, reads `session.env()`, asserts the wrapper env var matches the configured path, parses and validates the exported socket fd, checks that `client_socket` is initially `Some`, calls `session.close_client_socket()`, and then asserts the socket storage becomes `None`.

**Call relations**: Exercises `EscalateServer::new`, `EscalateServer::start_session`, `EscalationSession::env`, and `EscalationSession::close_client_socket` without involving actual shell spawning.

*Call graph*: calls 2 internal fn (run, new); 6 external calls (new, new, from, assert!, assert_eq!, assert_ne!).


##### `tests::exec_closes_parent_socket_after_shell_spawn`  (lines 691–722)

```
async fn exec_closes_parent_socket_after_shell_spawn() -> anyhow::Result<()>
```

**Purpose**: Checks that the one-shot `exec` path passes a valid inherited socket fd to the executor and closes the parent's copy immediately after the executor reports spawn completion via `after_spawn`.

**Data flow**: Builds a server and an `AfterSpawnAssertingShellCommandExecutor`, calls `server.exec(...)` with a trivial command and current directory, awaits the synthetic `ExecResult`, and asserts both zero exit code and that the executor observed `after_spawn` invocation.

**Call relations**: Covers the integration between `EscalateServer::exec`, session creation, env overlay export, and the after-spawn cleanup closure.

*Call graph*: calls 3 internal fn (run, new, current_dir); 7 external calls (clone, new, new, new, from, assert!, assert_eq!).


##### `tests::handle_escalate_session_respects_run_in_sandbox_decision`  (lines 725–761)

```
async fn handle_escalate_session_respects_run_in_sandbox_decision() -> anyhow::Result<()>
```

**Purpose**: Verifies that when policy returns `Run`, the session worker replies with `EscalateAction::Run` and does not attempt escalation-specific protocol steps.

**Data flow**: Creates an `AsyncSocket` pair, spawns `handle_escalate_session_with_policy` with a deterministic `Run` policy, sends an `EscalateRequest` containing a large environment map, receives an `EscalateResponse`, asserts it equals `Run`, and awaits worker completion.

**Call relations**: Directly exercises the `Run` branch of `handle_escalate_session_with_policy` with realistic request payload size.

*Call graph*: calls 4 internal fn (run, handle_escalate_session_with_policy, pair, try_from); 8 external calls (new, new, new, from, assert_eq!, format!, spawn, vec!).


##### `tests::handle_escalate_session_resolves_relative_file_against_request_workdir`  (lines 764–801)

```
async fn handle_escalate_session_resolves_relative_file_against_request_workdir() -> anyhow::Result<()>
```

**Purpose**: Confirms that a relative executable path in `EscalateRequest.file` is resolved against the request workdir before policy evaluation.

**Data flow**: Creates a temporary workspace, computes the expected absolute file path, spawns the worker with `AssertingEscalationPolicy`, sends a request whose `file` is `./bin/tool`, receives the response, asserts it is `Run`, and awaits worker completion.

**Call relations**: Targets the path-resolution step inside `handle_escalate_session_with_policy` before the policy call.

*Call graph*: calls 3 internal fn (handle_escalate_session_with_policy, pair, try_from); 9 external calls (new, new, new, from, assert_eq!, create_dir, new, spawn, vec!).


##### `tests::handle_escalate_session_executes_escalated_command`  (lines 804–846)

```
async fn handle_escalate_session_executes_escalated_command() -> anyhow::Result<()>
```

**Purpose**: Validates the full escalation path by having the worker spawn a real shell command with forwarded environment and report its exit code back over the protocol.

**Data flow**: Spawns the worker with a deterministic `Escalate(Unsandboxed)` policy and forwarding executor, sends an `EscalateRequest` for `/bin/sh -c ...` with `KEY=VALUE` in the env, receives and asserts the `Escalate` response, sends an empty `SuperExecMessage` with no fds, receives `SuperExecResult`, and asserts the child exited with code 42.

**Call relations**: Exercises the `Escalate` branch of `handle_escalate_session_with_policy`, including executor preparation, child spawn, env propagation, and result reporting.

*Call graph*: calls 4 internal fn (escalate, handle_escalate_session_with_policy, pair, current_dir); 8 external calls (new, new, from, from, new, assert_eq!, spawn, vec!).


##### `tests::RestoredFd::close_temporarily`  (lines 864–880)

```
fn close_temporarily(target_fd: i32) -> anyhow::Result<Self>
```

**Purpose**: Temporarily frees a specific descriptor number while preserving its original underlying file description so it can be restored later. This enables deterministic fd-number overlap tests.

**Data flow**: Takes `target_fd`, duplicates it with `dup`, closes the original descriptor number, wraps the duplicate in `OwnedFd`, and returns `RestoredFd { target_fd, original_fd }`. On failure it converts OS errors into `anyhow::Error` and cleans up the duplicate if needed.

**Call relations**: Used by the overlapping-fd regression test to make descriptor 0 available so a received SCM_RIGHTS fd can intentionally land on stdin.

*Call graph*: 4 external calls (last_os_error, close, dup, from_raw_fd).


##### `tests::RestoredFd::drop`  (lines 888–892)

```
fn drop(&mut self)
```

**Purpose**: Restores the saved original file descriptor back onto its original numeric slot when the helper goes out of scope. It undoes the process-wide fd-table mutation performed by `close_temporarily`.

**Data flow**: On drop, calls `dup2(self.original_fd.as_raw_fd(), self.target_fd)` and returns no value. It does not report restoration errors.

**Call relations**: Runs automatically at the end of the overlap test to keep the test process's stdio table intact.

*Call graph*: 2 external calls (as_raw_fd, dup2).


##### `tests::handle_escalate_session_accepts_received_fds_that_overlap_destinations`  (lines 896–966)

```
async fn handle_escalate_session_accepts_received_fds_that_overlap_destinations() -> anyhow::Result<()>
```

**Purpose**: Regression test for the case where a received SCM_RIGHTS fd is allocated onto the same numeric descriptor that the protocol asks the child to use as its destination, such as stdin on fd 0.

**Data flow**: Creates a pipe, temporarily closes stdin via `RestoredFd::close_temporarily(0)`, spawns the worker with an `Escalate` policy, sends an `EscalateRequest` for a shell command that reads one line from stdin, receives and asserts the `Escalate` response, sends `SuperExecMessage { fds: vec![0] }` with the pipe read end attached, writes `overlap-ok` to the pipe write end, receives `SuperExecResult`, and asserts exit code 0 before restoring stdin.

**Call relations**: Directly validates the `pre_exec` `dup2` loop inside `handle_escalate_session_with_policy`, specifically the `src_fd == dst_fd` overlap scenario.

*Call graph*: calls 4 internal fn (escalate, handle_escalate_session_with_policy, pair, current_dir); 12 external calls (new, new, new, from, assert_eq!, last_os_error, pipe, close_temporarily, from_raw_fd, from_raw_fd (+2 more)).


##### `tests::handle_escalate_session_passes_permissions_to_executor`  (lines 969–1023)

```
async fn handle_escalate_session_passes_permissions_to_executor() -> anyhow::Result<()>
```

**Purpose**: Checks that permission-bearing escalation decisions are forwarded unchanged from policy into executor preparation before the child is spawned.

**Data flow**: Builds a deterministic policy returning `Escalate(EscalationExecution::Permissions(...))`, spawns the worker with `PermissionAssertingShellCommandExecutor`, sends a simple shell `EscalateRequest`, receives and asserts the `Escalate` response, sends an empty `SuperExecMessage`, receives `SuperExecResult`, and asserts successful exit.

**Call relations**: Exercises the escalation path with a nontrivial `EscalationExecution` payload and verifies the handoff to `prepare_escalated_exec`.

*Call graph*: calls 4 internal fn (escalate, handle_escalate_session_with_policy, pair, current_dir); 11 external calls (new, new, default, new, from, new, assert_eq!, AdditionalPermissionProfile, Permissions, spawn (+1 more)).


##### `tests::dropping_session_aborts_intercept_workers_and_kills_spawned_child`  (lines 1026–1114)

```
async fn dropping_session_aborts_intercept_workers_and_kills_spawned_child() -> anyhow::Result<()>
```

**Purpose**: End-to-end test that dropping an `EscalationSession` tears down active intercept workers and causes an already spawned escalated child to be killed rather than left running.

**Data flow**: Creates a temp pid file path and a server configured to always escalate, starts a session, duplicates the exported datagram socket fd into a local `AsyncDatagramSocket`, creates a stream socket pair, sends the server end over the handshake socket, sends an `EscalateRequest` that writes its pid file and then `exec`s `/bin/sleep 100`, receives and asserts the `Escalate` response, sends an empty `SuperExecMessage`, waits for the pid file and confirms the process exists, drops the session, then waits until the process exits.

**Call relations**: Combines `EscalateServer::start_session`, `escalate_task`, `handle_escalate_session_with_policy`, and `EscalationSession::drop` to verify cancellation and child cleanup behavior across the full protocol stack.

*Call graph*: calls 5 internal fn (escalate, new, from_raw_fd, pair, current_dir); 13 external calls (new, new, new, from, new, new, assert!, assert_eq!, dup, wait_for_pid_file (+3 more)).


### Runtime integration
These files connect shared runtime command preparation with the Unix escalation backend so tool launches can be rewritten, sandboxed, and escalated when policy requires.

### `core/src/tools/runtimes/mod.rs`

`orchestration` · `request handling`

This module is the common support layer beneath the concrete runtime implementations in `apply_patch`, `shell`, and `unified_exec`. Its helpers convert tokenized command vectors plus an absolute working directory into a `codex_sandboxing::SandboxCommand`, derive execution environments that are safe for a requested `SandboxPermissions` level, and maintain Codex-owned PATH prepends through shell snapshot restore flows.

A key design point is separation between the live execution environment and policy-driven explicit overrides. `maybe_wrap_shell_lc_with_snapshot` uses both: it rewrites POSIX `shell -lc <script>` commands into `session_shell -c <wrapper>` scripts that source a snapshot file, then re-export explicit overrides, proxy variables, `CODEX_THREAD_ID`, and runtime PATH prepends so snapshot restoration does not accidentally erase runtime-only state. The wrapper carefully shell-quotes paths and scripts, preserves trailing argv, and becomes a no-op on Windows, missing snapshots, non-`-lc` commands, or malformed argv.

The module also strips managed proxy variables when elevated permissions would make inherited proxy settings unsafe, with special macOS handling for Codex-owned `GIT_SSH_COMMAND` wrappers. On Unix it tracks PATH entries in `RuntimePathPrepends`, deduplicating and ignoring empty entries so command lookup never gains an implicit current-directory search. On Windows it conditionally injects `-NoProfile` into PowerShell commands for elevated restricted-token sandbox runs to avoid loading user profiles in a mixed-account environment. The included tests lock down that PowerShell rewrite behavior.

#### Function details

##### `build_sandbox_command`  (lines 38–55)

```
fn build_sandbox_command(
    command: &[String],
    cwd: &AbsolutePathBuf,
    env: &HashMap<String, String>,
    additional_permissions: Option<AdditionalPermissionProfile>,
) -> Result<SandboxComm
```

**Purpose**: Builds a `SandboxCommand` from a tokenized command line, absolute cwd, inherited environment, and optional `AdditionalPermissionProfile`. It enforces the invariant that the command vector must contain at least the program name.

**Data flow**: Reads `command`, `cwd`, `env`, and `additional_permissions`. It splits `command` into the first element as `program` and the remainder as `args`; converts `cwd` from `AbsolutePathBuf` to `PathUri`; clones the environment map; and returns `Ok(SandboxCommand { program, args, cwd, env, additional_permissions })`. If `command` is empty, it returns `Err(ToolError::Rejected("command args are empty"))` and writes no state.

**Call relations**: This helper is invoked by runtime execution paths such as `run` and `try_run_zsh_fork` when they need to hand a fully formed command to the sandbox layer. It delegates only the cwd conversion to `PathUri::from_abs_path`, keeping command validation local before sandbox execution proceeds.

*Call graph*: calls 1 internal fn (from_abs_path); called by 3 (run, try_run_zsh_fork, run).


##### `exec_env_for_sandbox_permissions`  (lines 57–68)

```
fn exec_env_for_sandbox_permissions(
    env: &HashMap<String, String>,
    sandbox_permissions: SandboxPermissions,
) -> HashMap<String, String>
```

**Purpose**: Produces the environment map that should be passed into a command after considering the requested sandbox permission level. Its main policy is to remove managed proxy settings when execution requires escalated permissions.

**Data flow**: Takes an input `env` map and a `SandboxPermissions` value. It clones the map, checks `sandbox_permissions.requires_escalated_permissions()`, and if escalation is required and `PROXY_ACTIVE_ENV_KEY` is present, mutates the clone via `strip_managed_proxy_env`. It returns the possibly sanitized clone and does not mutate the caller's original map.

**Call relations**: Execution preparation code such as `run`, `prepare_escalated_exec`, and `try_run_zsh_fork` calls this before constructing or launching commands. It delegates the actual key removal policy to `strip_managed_proxy_env`, using `requires_escalated_permissions` as the gate that decides whether proxy inheritance is unsafe.

*Call graph*: calls 2 internal fn (strip_managed_proxy_env, requires_escalated_permissions); called by 4 (run, prepare_escalated_exec, try_run_zsh_fork, run).


##### `strip_managed_proxy_env`  (lines 70–90)

```
fn strip_managed_proxy_env(env: &mut HashMap<String, String>)
```

**Purpose**: Removes Codex-managed proxy-related environment variables from an environment map, including managed CA bundle references and, on macOS, Codex-owned SSH wrapper commands. It is intentionally selective so unrelated user-provided values survive.

**Data flow**: Mutably reads and writes the provided `HashMap<String, String>`. It removes every key listed in `PROXY_ENV_KEYS`; then iterates `CUSTOM_CA_ENV_KEYS` and removes only those whose current value points at a managed MITM CA trust bundle according to `is_managed_mitm_ca_trust_bundle_path`; on macOS it additionally removes `PROXY_GIT_SSH_COMMAND_ENV_KEY` when its value starts with `CODEX_PROXY_GIT_SSH_COMMAND_MARKER`. It returns `()` after in-place mutation.

**Call relations**: This function is used directly by `execute_user_shell_command` and indirectly through `exec_env_for_sandbox_permissions` when elevated execution should not inherit managed proxy plumbing. It is a leaf policy routine: callers decide when sanitization is needed, and this function performs the concrete removals.

*Call graph*: called by 2 (execute_user_shell_command, exec_env_for_sandbox_permissions).


##### `prepend_path_entry`  (lines 99–116)

```
fn prepend_path_entry(env: &mut HashMap<String, String>, path_entry: &str) -> Option<String>
```

**Purpose**: Prepends one PATH directory on Unix while removing duplicates and ignoring empty entries. It avoids the dangerous shell behavior where an empty PATH segment would implicitly search the current working directory.

**Data flow**: Mutably reads and writes `env` and reads `path_entry`. If `path_entry` is empty, it returns `None` and leaves `env` untouched. Otherwise it reads the current `PATH`, constructs a new colon-separated string with `path_entry` first and all non-empty, non-duplicate existing entries after it, writes that string back to `env["PATH"]`, and returns `Some(updated_path)`.

**Call relations**: This private helper underpins both `RuntimePathPrepends::prepend` and `prepend_zsh_fork_bin_to_path`. Those callers use its `Option` result to distinguish a real prepend from a no-op caused by an empty path.

*Call graph*: called by 2 (prepend, prepend_zsh_fork_bin_to_path); 1 external calls (once).


##### `RuntimePathPrepends::prepend`  (lines 129–135)

```
fn prepend(&mut self, env: &mut HashMap<String, String>, path_entry: &Path)
```

**Purpose**: Applies a Unix PATH prepend to the live environment and records that prepend in `RuntimePathPrepends` so it can later be replayed after restoring a shell snapshot. It keeps the recorded list deduplicated and ordered by most recent application.

**Data flow**: Reads `path_entry` as a `Path`, converts it to a lossy `String`, and passes it plus mutable `env` to `prepend_path_entry`. If the prepend succeeds, it mutates `self.entries` by removing any existing identical entry and pushing the new one to the end; if the prepend is skipped, it leaves `self.entries` unchanged. It returns `()`.

**Call relations**: Higher-level setup helpers `apply_package_path_prepend` and `apply_zsh_fork_path_prepend` call this whenever Codex injects its own PATH directories. Later, `maybe_wrap_shell_lc_with_snapshot` consults the accumulated `entries` through `shell_exports_after_snapshot` to reconstruct those prepends after snapshot sourcing.

*Call graph*: calls 1 internal fn (prepend_path_entry); called by 2 (apply_package_path_prepend, apply_zsh_fork_path_prepend); 1 external calls (to_string_lossy).


##### `RuntimePathPrepends::shell_exports_after_snapshot`  (lines 137–156)

```
fn shell_exports_after_snapshot(
        &self,
        explicit_env_overrides: &HashMap<String, String>,
    ) -> String
```

**Purpose**: Generates shell `export PATH=...` snippets that replay all recorded runtime PATH prepends after a shell snapshot has been sourced. It intentionally emits nothing if the user explicitly overrides `PATH`, letting explicit policy win over runtime replay.

**Data flow**: Reads `self.entries` and `explicit_env_overrides`. If `explicit_env_overrides` contains `PATH`, it returns an empty `String`. Otherwise it filters out empty recorded entries, shell-quotes each one, formats a conditional export snippet that prepends the entry whether or not PATH was previously set, joins all snippets with newlines, and returns the resulting shell script fragment without mutating state.

**Call relations**: This method is only consumed by `maybe_wrap_shell_lc_with_snapshot`, where its output is appended after snapshot restore and explicit env restoration. Its role is to preserve Codex-owned PATH modifications without pretending they were user-specified overrides.

*Call graph*: called by 1 (maybe_wrap_shell_lc_with_snapshot); 1 external calls (new).


##### `apply_package_path_prepend`  (lines 160–173)

```
fn apply_package_path_prepend(
    env: &mut HashMap<String, String>,
    runtime_path_prepends: &mut RuntimePathPrepends,
)
```

**Purpose**: Looks up the current installation's package PATH directory and, when present, prepends it into the runtime environment while recording it for later snapshot replay. It is a no-op when the install context has no package layout or no `path_dir`.

**Data flow**: Mutably reads and writes `env` and `runtime_path_prepends`. It queries `InstallContext::current()`, traverses `package_layout.path_dir`, and if a directory exists passes its path to `runtime_path_prepends.prepend`; otherwise it returns immediately. It returns `()` after optional mutation.

**Call relations**: Runtime `run` paths call this during command setup on Unix so packaged tool binaries become discoverable. It delegates the actual PATH mutation and bookkeeping to `RuntimePathPrepends::prepend`, while `InstallContext::current` supplies the installation-specific directory.

*Call graph*: calls 2 internal fn (prepend, current); called by 2 (run, run).


##### `prepend_zsh_fork_bin_to_path`  (lines 176–184)

```
fn prepend_zsh_fork_bin_to_path(
    env: &mut HashMap<String, String>,
    shell_zsh_path: &Path,
) -> Option<String>
```

**Purpose**: Prepends the parent directory of a zsh executable path into PATH on Unix and returns the resulting PATH string. It is a lightweight helper for one-off zsh fork execution paths that do not need persistent replay bookkeeping.

**Data flow**: Reads `shell_zsh_path`, derives its parent directory, converts that directory to a string, and passes it to `prepend_path_entry` along with mutable `env`. If `shell_zsh_path` has no parent, it returns `None`; otherwise it returns the `Option<String>` from `prepend_path_entry` after mutating `env` as needed.

**Call relations**: The zsh-specific execution path `try_run_zsh_fork` uses this helper when it only needs to adjust the immediate environment. It delegates duplicate removal and empty-entry handling to `prepend_path_entry`.

*Call graph*: calls 1 internal fn (prepend_path_entry); called by 1 (try_run_zsh_fork); 1 external calls (parent).


##### `apply_zsh_fork_path_prepend`  (lines 187–196)

```
fn apply_zsh_fork_path_prepend(
    env: &mut HashMap<String, String>,
    runtime_path_prepends: &mut RuntimePathPrepends,
    shell_zsh_path: &Path,
)
```

**Purpose**: Records and applies the zsh binary directory as a runtime PATH prepend so later snapshot restoration can replay it. Unlike the simpler helper, this one updates both the environment and `RuntimePathPrepends` state.

**Data flow**: Reads `shell_zsh_path`, obtains its parent directory, and if present calls `runtime_path_prepends.prepend(env, zsh_bin_dir)`. If there is no parent directory, it returns without mutation. It returns `()`.

**Call relations**: Unix `run` flows call this when zsh fork support should become part of the runtime environment rather than a transient PATH tweak. It delegates all actual PATH editing and entry tracking to `RuntimePathPrepends::prepend`.

*Call graph*: calls 1 internal fn (prepend); called by 2 (run, run); 1 external calls (parent).


##### `disable_powershell_profile_for_elevated_windows_sandbox`  (lines 198–225)

```
fn disable_powershell_profile_for_elevated_windows_sandbox(
    command: &[String],
    shell_type: Option<&ShellType>,
    sandbox: SandboxType,
    windows_sandbox_level: WindowsSandboxLevel,
) -> V
```

**Purpose**: Rewrites a PowerShell command vector to include `-NoProfile` when running inside the elevated Windows restricted-token sandbox. This prevents PowerShell from loading user profile scripts in a mixed sandbox-account and real-user-profile environment.

**Data flow**: Reads `command`, `shell_type`, `sandbox`, and `windows_sandbox_level`. If the shell is not `ShellType::PowerShell`, the sandbox is not `SandboxType::WindowsRestrictedToken`, the level is not `WindowsSandboxLevel::Elevated`, or the command is empty, it returns `command.to_vec()` unchanged. It also returns the original vector if any argument after argv[0] already equals `-NoProfile` case-insensitively. Otherwise it clones the command, inserts `"-NoProfile"` at index 1, and returns the rewritten vector.

**Call relations**: Windows runtime `run` paths call this just before execution so PowerShell invocations are made safe for elevated sandboxing. The unit tests in this file exercise the positive insertion case and several no-op branches to pin down the rewrite policy.

*Call graph*: called by 8 (inserts_no_profile_before_encoded_command, inserts_no_profile_for_elevated_windows_sandbox, leaves_legacy_restricted_token_backend_alone, leaves_non_powershell_alone, leaves_unsandboxed_attempts_alone, preserves_existing_no_profile, run, run).


##### `maybe_wrap_shell_lc_with_snapshot`  (lines 250–313)

```
fn maybe_wrap_shell_lc_with_snapshot(
    command: &[String],
    session_shell: &Shell,
    shell_snapshot: Option<&AbsolutePathBuf>,
    explicit_env_overrides: &HashMap<String, String>,
    env: &H
```

**Purpose**: On POSIX, rewrites `shell -lc <script>` commands into a wrapper executed by the session shell that sources a shell snapshot, restores selected environment variables, reapplies runtime PATH prepends, and then `exec`s the original shell command. It is the core mechanism that reconciles shell snapshots with runtime-only environment state.

**Data flow**: Reads `command`, `session_shell`, optional `shell_snapshot`, `explicit_env_overrides`, full live `env`, and `runtime_path_prepends`. It returns the original command unchanged on Windows, when no snapshot is configured, when the snapshot file does not exist, when argv has fewer than three elements, or when argv[1] is not `-lc`. Otherwise it shell-quotes the snapshot path, original shell path, original script, and trailing args; clones `explicit_env_overrides` and injects `CODEX_THREAD_ID_ENV_VAR` from `env` if present; builds shell fragments via `build_override_exports`, `build_proxy_env_exports`, and `runtime_path_prepends.shell_exports_after_snapshot`; joins those fragments; and constructs a wrapper script that captures live values, sources the snapshot best-effort with stderr/stdout suppressed, restores overrides and proxy state, then `exec`s the original shell with `-c <original_script>` plus trailing args. It returns a new argv vector `[session_shell.shell_path, "-c", rewritten_script]` without mutating inputs.

**Call relations**: Preparation routines such as `prepare_user_shell_exec_command`, `prepare_user_shell_exec_command_with_path_prepend`, and runtime `run` paths invoke this when launching shell-based commands under a session that may have a saved snapshot. It orchestrates several local helpers—quoting, variable-name validation, override/proxy capture generation, and PATH replay—to preserve runtime semantics across snapshot restoration.

*Call graph*: calls 5 internal fn (shell_exports_after_snapshot, build_override_exports, build_proxy_env_exports, join_shell_blocks, shell_single_quote); called by 4 (prepare_user_shell_exec_command, prepare_user_shell_exec_command_with_path_prepend, run, run); 3 external calls (cfg!, format!, vec!).


##### `build_override_exports`  (lines 315–324)

```
fn build_override_exports(explicit_env_overrides: &HashMap<String, String>) -> (String, String)
```

**Purpose**: Builds shell code that captures and later restores explicit environment override variables across snapshot sourcing. It filters out invalid shell variable names and sorts keys for deterministic script generation.

**Data flow**: Reads `explicit_env_overrides`, extracts its keys, filters them through `is_valid_shell_variable_name`, sorts them, and passes the resulting slice to `build_override_exports_for_keys` with the prefix `__CODEX_SNAPSHOT_OVERRIDE`. It returns a pair `(captures, exports)` of shell script fragments and does not mutate state.

**Call relations**: Only `maybe_wrap_shell_lc_with_snapshot` calls this while assembling its wrapper script. It delegates the repetitive shell-fragment formatting to `build_override_exports_for_keys`, keeping this function focused on key selection and ordering.

*Call graph*: calls 1 internal fn (build_override_exports_for_keys); called by 1 (maybe_wrap_shell_lc_with_snapshot).


##### `build_proxy_env_exports`  (lines 326–350)

```
fn build_proxy_env_exports() -> (String, String)
```

**Purpose**: Builds shell fragments that preserve proxy-related environment variables across snapshot restore, including conditional restoration tied to whether proxy mode was active and platform-specific handling for Codex-managed Git SSH wrappers. It treats proxy variables differently from ordinary overrides because snapshots may legitimately add or remove them.

**Data flow**: Collects keys from `PROXY_ENV_KEYS` and `CUSTOM_CA_ENV_KEYS`, filters them through `is_valid_shell_variable_name`, sorts and deduplicates them, and passes them to `build_override_exports_for_keys` with the prefix `__CODEX_SNAPSHOT_PROXY_OVERRIDE`. It then wraps the resulting capture/restore fragments with additional shell logic keyed on `PROXY_ACTIVE_ENV_KEY` so restoration only occurs when proxy state was or remains relevant, obtains extra fragments from `build_codex_proxy_git_ssh_command_exports`, joins the pieces with `join_shell_blocks`, and returns `(captures, restores)` as strings.

**Call relations**: This helper is used exclusively by `maybe_wrap_shell_lc_with_snapshot` to preserve managed proxy state when a snapshot is sourced. It delegates generic capture/restore generation to `build_override_exports_for_keys`, platform-specific Git SSH handling to `build_codex_proxy_git_ssh_command_exports`, and final formatting cleanup to `join_shell_blocks`.

*Call graph*: calls 3 internal fn (build_codex_proxy_git_ssh_command_exports, build_override_exports_for_keys, join_shell_blocks); called by 1 (maybe_wrap_shell_lc_with_snapshot); 1 external calls (format!).


##### `build_codex_proxy_git_ssh_command_exports`  (lines 367–369)

```
fn build_codex_proxy_git_ssh_command_exports() -> (String, String)
```

**Purpose**: Provides the shell fragments needed to preserve or remove the macOS Codex-managed `GIT_SSH_COMMAND` wrapper correctly across snapshot restore; on non-macOS builds it intentionally emits nothing. The logic distinguishes Codex-marked wrapper values from unrelated user values.

**Data flow**: On macOS, it reads `PROXY_GIT_SSH_COMMAND_ENV_KEY` and `CODEX_PROXY_GIT_SSH_COMMAND_MARKER`, formats a capture block that records whether the live value is set and whether it matches the Codex marker pattern, and formats a restore block that compares the post-snapshot value to the marker pattern to decide whether to restore the live value or unset the variable. On non-macOS, it returns `(String::new(), String::new())`. It mutates no external state.

**Call relations**: Only `build_proxy_env_exports` calls this, folding its platform-specific fragments into the broader proxy preservation script. Its narrow role is to keep Codex-owned SSH wrapper injection from being accidentally lost or incorrectly retained after snapshot sourcing.

*Call graph*: called by 1 (build_proxy_env_exports); 2 external calls (new, format!).


##### `build_override_exports_for_keys`  (lines 371–400)

```
fn build_override_exports_for_keys(variable_prefix: &str, keys: &[&str]) -> (String, String)
```

**Purpose**: Generates generic shell code to capture whether each named variable was set and what its value was, then later restore or unset it exactly. It is the low-level formatter shared by both explicit override and proxy preservation logic.

**Data flow**: Reads `variable_prefix` and ordered `keys`. If `keys` is empty, it returns two empty strings. Otherwise it enumerates the keys, producing a `captures` string that assigns `${key+x}` and `${key-}` into numbered temporary variables under the given prefix, and a `restores` string that exports the saved value when the variable was originally set or unsets it otherwise. It returns `(captures, restores)` without mutating external state.

**Call relations**: This helper is called by both `build_override_exports` and `build_proxy_env_exports`. Those callers decide which keys matter and what prefix namespace to use; this function supplies the deterministic shell snippets they embed into the snapshot wrapper.

*Call graph*: called by 2 (build_override_exports, build_proxy_env_exports); 1 external calls (new).


##### `join_shell_blocks`  (lines 402–408)

```
fn join_shell_blocks(blocks: impl IntoIterator<Item = String>) -> String
```

**Purpose**: Concatenates non-empty shell script fragments with newline separators. It keeps generated wrapper scripts readable and avoids extra blank sections when optional fragments are absent.

**Data flow**: Consumes an iterator of `String` blocks, filters out empty strings, collects the remainder, joins them with `"\n"`, and returns the combined string. It reads no external state and performs no side effects.

**Call relations**: Both `build_proxy_env_exports` and `maybe_wrap_shell_lc_with_snapshot` use this helper while assembling larger shell scripts from optional pieces. It is purely a formatting utility that simplifies conditional script generation.

*Call graph*: called by 2 (build_proxy_env_exports, maybe_wrap_shell_lc_with_snapshot); 1 external calls (into_iter).


##### `is_valid_shell_variable_name`  (lines 410–419)

```
fn is_valid_shell_variable_name(name: &str) -> bool
```

**Purpose**: Checks whether a string is a valid POSIX-style shell variable name accepted by this module's generated export/unset code. It rejects empty names, names starting with digits, and names containing non-alphanumeric/non-underscore characters.

**Data flow**: Reads `name`, inspects its first character to ensure it is `_` or ASCII alphabetic, then verifies all remaining characters are `_` or ASCII alphanumeric. It returns `true` for valid names and `false` otherwise, with no side effects.

**Call relations**: This function is used indirectly by snapshot wrapper generation through `build_override_exports` and `build_proxy_env_exports` to avoid emitting invalid shell syntax for malformed environment keys. It acts as a guardrail before shell code is generated.


##### `shell_single_quote`  (lines 421–423)

```
fn shell_single_quote(input: &str) -> String
```

**Purpose**: Escapes a string for safe inclusion inside a single-quoted POSIX shell literal by replacing embedded single quotes with the standard `'"'"'` sequence. It is the module's basic shell-quoting primitive.

**Data flow**: Reads `input`, performs a string replacement of every `'` with `"'\"'\"'"`, and returns the escaped string. It does not mutate external state.

**Call relations**: The snapshot wrapper builder `maybe_wrap_shell_lc_with_snapshot` calls this for shell paths, snapshot paths, scripts, and trailing arguments before interpolating them into generated shell code. Its role is to prevent quoting breakage or command injection in the rewritten wrapper.

*Call graph*: called by 1 (maybe_wrap_shell_lc_with_snapshot).


##### `disable_powershell_profile_tests::inserts_no_profile_for_elevated_windows_sandbox`  (lines 431–454)

```
fn inserts_no_profile_for_elevated_windows_sandbox()
```

**Purpose**: Verifies that an ordinary PowerShell `-Command` invocation gains `-NoProfile` when the elevated Windows restricted-token sandbox policy applies. It locks down the primary rewrite behavior.

**Data flow**: Constructs a sample `Vec<String>` command, calls `disable_powershell_profile_for_elevated_windows_sandbox` with `ShellType::PowerShell`, `SandboxType::WindowsRestrictedToken`, and `WindowsSandboxLevel::Elevated`, and asserts that the returned vector has `-NoProfile` inserted at index 1. It writes no persistent state.

**Call relations**: This unit test invokes the production rewrite helper directly under the exact condition where insertion should happen. It does not delegate beyond the assertion framework and the function under test.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::inserts_no_profile_before_encoded_command`  (lines 457–480)

```
fn inserts_no_profile_before_encoded_command()
```

**Purpose**: Checks that `-NoProfile` is inserted before `-EncodedCommand`, not after it, preserving PowerShell argument ordering semantics. This covers a second common invocation form.

**Data flow**: Builds an encoded-command argv vector, passes it to `disable_powershell_profile_for_elevated_windows_sandbox` under elevated restricted-token PowerShell conditions, and asserts that the returned vector inserts `-NoProfile` immediately after the executable path. It has no side effects beyond the assertion.

**Call relations**: This test exercises the same production helper as the previous test but with `-EncodedCommand` to ensure the insertion logic is position-based rather than tied to a specific subcommand flag.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::preserves_existing_no_profile`  (lines 483–499)

```
fn preserves_existing_no_profile()
```

**Purpose**: Ensures the rewrite helper does not duplicate `-NoProfile` when the caller already supplied it. This protects command stability and avoids redundant flags.

**Data flow**: Creates a PowerShell command vector that already contains `-NoProfile`, calls `disable_powershell_profile_for_elevated_windows_sandbox` under the elevated restricted-token condition, and asserts that the returned vector is unchanged. It mutates no external state.

**Call relations**: This test covers the helper's early-return branch that scans existing arguments case-insensitively for `-NoProfile`. It confirms the production function is idempotent for already-correct commands.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::leaves_legacy_restricted_token_backend_alone`  (lines 502–517)

```
fn leaves_legacy_restricted_token_backend_alone()
```

**Purpose**: Confirms that the helper does not rewrite commands for the non-elevated `RestrictedToken` sandbox level. The profile suppression policy is intentionally narrower than all Windows sandboxing.

**Data flow**: Builds a PowerShell command, calls `disable_powershell_profile_for_elevated_windows_sandbox` with `WindowsSandboxLevel::RestrictedToken`, and asserts that the original vector is returned unchanged. It performs no side effects.

**Call relations**: This test targets the branch where sandbox backend/level does not match the elevated policy gate. It demonstrates that callers can use the helper broadly without affecting legacy restricted-token runs.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::leaves_unsandboxed_attempts_alone`  (lines 520–535)

```
fn leaves_unsandboxed_attempts_alone()
```

**Purpose**: Verifies that unsandboxed PowerShell executions are not modified. The helper is specifically about elevated sandbox account behavior, not general PowerShell hygiene.

**Data flow**: Constructs a PowerShell command, invokes `disable_powershell_profile_for_elevated_windows_sandbox` with `SandboxType::None`, and asserts that the returned command equals the input. It writes no state.

**Call relations**: This test covers the branch where sandboxing is disabled entirely, confirming the helper's rewrite is conditional on the Windows restricted-token sandbox path used by runtime `run` logic.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::leaves_non_powershell_alone`  (lines 538–553)

```
fn leaves_non_powershell_alone()
```

**Purpose**: Checks that non-PowerShell shells, such as Bash, are never rewritten by the PowerShell-specific helper. This guards against accidental cross-shell argument corruption.

**Data flow**: Creates a Bash-style `-lc` command vector, calls `disable_powershell_profile_for_elevated_windows_sandbox` with `ShellType::Bash`, and asserts that the returned vector is unchanged. It has no side effects.

**Call relations**: This test exercises the helper's first gate on `shell_type`, proving that only PowerShell invocations from runtime execution paths are eligible for `-NoProfile` insertion.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


### `core/src/tools/runtimes/shell/unix_escalation.rs`

`domain_logic` · `tool request handling on Unix when zsh-fork escalation is enabled`

This file contains the Unix-specific implementation behind the shell runtime’s zsh-fork backend and the unified-exec zsh-fork preparation path. Its top-level helpers first normalize shell requests for denied-read-preserving sandbox behavior, then convert a wrapped shell command into a form suitable for execve interception. `try_run_zsh_fork` is the main shell-command path: it verifies feature flags and shell prerequisites, builds a sandboxed `ExecRequest`, extracts the inner `zsh -c/-lc` script, constructs `ExecParams`, and starts an `EscalateServer` with a `CoreShellActionProvider` policy object and a `CoreShellCommandExecutor` execution object. `prepare_unified_exec_zsh_fork` performs the analogous setup for unified exec, but returns a prepared session plus modified `ExecRequest` instead of running immediately.

`CoreShellActionProvider` is the policy brain. It evaluates intercepted execs against the current `Policy`, distinguishes rule-driven decisions from fallback heuristics, preserves the distinction between sandbox approval and rules approval under granular approval settings, and decides whether to run, deny, or escalate. Prompting is layered: permission-request hooks first, then Guardian review if configured, then the normal user approval prompt. Additional permissions can be treated as already approved for policy purposes via `approval_sandbox_permissions`, which downgrades only the approval-time view while preserving actual execution permissions.

`CoreShellCommandExecutor` is the execution side. It can run the original shell command with only escalation socket variables merged into the environment, or prepare a direct exec for unsandboxed/default/additional-permission execution by rebuilding sandbox transforms from permission profiles. Utility functions parse wrapped shell commands, normalize `(program, argv)` pairs for display/policy matching, and map `ExecResult` into `ExecToolCallOutput`, converting timeouts and likely sandbox denials into structured `ToolError::Codex` variants.

#### Function details

##### `approval_sandbox_permissions`  (lines 89–103)

```
fn approval_sandbox_permissions(
    sandbox_permissions: SandboxPermissions,
    additional_permissions_preapproved: bool,
) -> SandboxPermissions
```

**Purpose**: Adjusts the approval-time sandbox permission mode when additional permissions were already preapproved. Its only downgrade is from `WithAdditionalPermissions` to `UseDefault`, preventing a second approval prompt for permissions that were already granted.

**Data flow**: Takes a `SandboxPermissions` value and a boolean `additional_permissions_preapproved`. If the boolean is true and the permission mode is `WithAdditionalPermissions`, returns `UseDefault`; otherwise returns the original permission mode unchanged.

**Call relations**: It is used by both `try_run_zsh_fork` and `prepare_unified_exec_zsh_fork` when constructing `CoreShellActionProvider`, so policy evaluation and prompting reflect preapproved additional permissions without changing the actual execution profile.

*Call graph*: called by 2 (prepare_unified_exec_zsh_fork, try_run_zsh_fork); 1 external calls (matches!).


##### `try_run_zsh_fork`  (lines 105–247)

```
async fn try_run_zsh_fork(
    req: &ShellRequest,
    attempt: &SandboxAttempt<'_>,
    ctx: &ToolCtx,
    command: &[String],
) -> Result<Option<ExecToolCallOutput>, ToolError>
```

**Purpose**: Attempts to execute a shell request through the zsh-fork escalation server instead of the normal shell runtime. It validates prerequisites, builds the sandboxed shell launch context, starts the escalation server, and converts the resulting execution outcome into normal shell output or structured sandbox errors.

**Data flow**: Reads `ShellRequest`, `SandboxAttempt`, `ToolCtx`, and the already-transformed shell command vector. It checks configured zsh path, feature flag, and user shell type; normalizes sandbox permissions to preserve denied reads; derives env with `exec_env_for_sandbox_permissions`; prepends zsh-fork binaries; builds a sandbox command and transforms it via `attempt.env_for`; destructures the resulting `ExecRequest`; parses the inner shell script with `extract_shell_script`; computes timeout and cancellation, combining stopwatch cancellation with optional network-denial cancellation via `cancel_when_either`; clones current exec policy into an `Arc<RwLock<Policy>>`; constructs `CoreShellCommandExecutor`, `CoreShellActionProvider`, and `EscalateServer`; runs `exec`; then maps the `ExecResult` through `map_exec_result` into `ExecToolCallOutput`. It returns `Ok(None)` when prerequisites are missing, `Ok(Some(output))` on successful zsh-fork execution, or `Err(ToolError)` on setup/execution failure.

**Call relations**: This is called by the zsh-fork backend shim when the shell runtime selected the zsh-fork backend. It delegates policy decisions to `CoreShellActionProvider`, execution to `CoreShellCommandExecutor`, and parsing/result conversion to `extract_shell_script` and `map_exec_result`.

*Call graph*: calls 12 internal fn (cancel_when_either, build_sandbox_command, exec_env_for_sandbox_permissions, prepend_zsh_fork_bin_to_path, approval_sandbox_permissions, extract_shell_script, map_exec_result, env_for, managed_network_for_sandbox_permissions, sandbox_permissions_preserving_denied_reads (+2 more)); called by 1 (maybe_run_shell_command); 7 external calls (clone, new, from_millis, new, clone, matches!, warn!).


##### `prepare_unified_exec_zsh_fork`  (lines 249–324)

```
async fn prepare_unified_exec_zsh_fork(
    req: &crate::tools::runtimes::unified_exec::UnifiedExecRequest,
    _attempt: &SandboxAttempt<'_>,
    ctx: &ToolCtx,
    exec_request: ExecRequest,
    she
```

**Purpose**: Prepares a unified-exec launch to run through zsh-fork by starting an escalation session and injecting its environment into the outgoing `ExecRequest`. It is the non-running counterpart to `try_run_zsh_fork` for PTY-backed unified exec.

**Data flow**: Consumes a `UnifiedExecRequest`, `ToolCtx`, an existing `ExecRequest`, and configured zsh/wrapper paths. It parses the command with `extract_shell_script`; if parsing fails or the parsed program does not match the configured zsh path, it logs and returns `Ok(None)`. Otherwise it clones current exec policy into `Arc<RwLock<Policy>>`, builds a `CoreShellCommandExecutor` from the provided `ExecRequest`, constructs a `CoreShellActionProvider` using approval-time sandbox permissions from `approval_sandbox_permissions`, creates an `EscalateServer`, starts an `EscalationSession`, extends `exec_request.env` with `escalation_session.env()`, and returns `PreparedUnifiedExecZshFork { exec_request, escalation_session }` inside `Some`.

**Call relations**: It is invoked by the zsh-fork unified-exec backend shim when unified exec is configured for zsh-fork. The returned session is later wrapped in a spawn lifecycle so the escalation server stays alive across process spawn.

*Call graph*: calls 4 internal fn (approval_sandbox_permissions, extract_shell_script, new, unlimited); called by 1 (maybe_prepare_unified_exec); 7 external calls (clone, new, new, to_path_buf, to_string_lossy, new, warn!).


##### `execve_prompt_is_rejected_by_policy`  (lines 354–372)

```
fn execve_prompt_is_rejected_by_policy(
    approval_policy: AskForApproval,
    decision_source: &DecisionSource,
) -> Option<&'static str>
```

**Purpose**: Determines whether a prompt-style exec-policy decision must be auto-rejected because the current `AskForApproval` policy forbids that class of prompt. It distinguishes prompts caused by explicit policy rules from prompts caused by unmatched-command sandbox fallback.

**Data flow**: Takes `AskForApproval` and a `DecisionSource`. Returns a static rejection reason string for `Never`, for granular policies that disable rules approval when the source is `PrefixRule`, or for granular policies that disable sandbox approval when the source is `UnmatchedCommandFallback`; otherwise returns `None`.

**Call relations**: It is consulted by `CoreShellActionProvider::process_decision` before any user/guardian prompt is attempted, turning some `Decision::Prompt` outcomes into immediate denial.

*Call graph*: called by 1 (process_decision).


##### `CoreShellActionProvider::decision_driven_by_policy`  (lines 375–380)

```
fn decision_driven_by_policy(matched_rules: &[RuleMatch], decision: Decision) -> bool
```

**Purpose**: Checks whether the final exec-policy decision came from a non-heuristic matched rule rather than fallback heuristics. This distinction controls both escalation semantics and which granular approval flag applies.

**Data flow**: Reads a slice of `RuleMatch` and a target `Decision`, iterates through matches, filters out `HeuristicsRuleMatch`, and returns true if any remaining match has the same decision.

**Call relations**: It is used inside `CoreShellActionProvider::determine_action` after policy evaluation to classify the decision source as rule-driven or fallback-driven.

*Call graph*: 1 external calls (iter).


##### `CoreShellActionProvider::shell_request_escalation_execution`  (lines 382–411)

```
fn shell_request_escalation_execution(
        sandbox_permissions: SandboxPermissions,
        permission_profile: &PermissionProfile,
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
```

**Purpose**: Maps shell-request sandbox intent plus permission profiles into the concrete `EscalationExecution` that zsh-fork should request when escalation is needed. It preserves the difference between unsandboxed execution, turn-default sandboxing, and execution under a resolved permission profile.

**Data flow**: Consumes `SandboxPermissions`, a `PermissionProfile`, the active `FileSystemSandboxPolicy`, and optional additional permissions. For `UseDefault` it returns `TurnDefault`; for `RequireEscalated` it returns `Unsandboxed` only if `unsandboxed_execution_allowed` is true, otherwise `TurnDefault`; for `WithAdditionalPermissions` it returns `Permissions(ResolvedPermissionProfile { permission_profile: clone })` when additional permissions are present, else `TurnDefault`.

**Call relations**: This helper is called by `CoreShellActionProvider::determine_action` when the decision source is the unmatched-command fallback path, so shell-request semantics rather than prefix-rule semantics determine the escalation target.

*Call graph*: calls 1 internal fn (unsandboxed_execution_allowed).


##### `CoreShellActionProvider::prompt`  (lines 413–508)

```
async fn prompt(
        &self,
        program: &AbsolutePathBuf,
        argv: &[String],
        workdir: &AbsolutePathBuf,
        stopwatch: &Stopwatch,
        additional_permissions: Option<Add
```

**Purpose**: Runs the full approval prompt pipeline for an intercepted execve request: permission-request hooks first, Guardian review second if configured, and the regular user approval prompt last. The stopwatch pauses while waiting for approval so execution timeout accounting excludes human review time.

**Data flow**: Takes the intercepted program path, argv, workdir, stopwatch, and optional additional permissions. It joins program and argv into a display command, clones session/turn/call metadata, creates a fresh approval id, optionally creates a Guardian review id, and executes an async block under `stopwatch.pause_for`. Inside that block it builds a `PermissionRequestPayload::bash` using `shlex_join`, runs `run_permission_request_hooks`, and may return immediate allow/deny with an optional hook rejection message. If hooks abstain and Guardian routing is enabled, it calls `review_approval_request` with `GuardianApprovalRequest::Execve`; otherwise it calls `session.request_command_approval` with available decisions limited to Approved/Abort. It returns a `PromptDecision` containing the `ReviewDecision`, optional guardian review id, and optional rejection message.

**Call relations**: It is called only from `CoreShellActionProvider::process_decision` when exec policy says `Prompt` and policy settings permit prompting.

*Call graph*: calls 6 internal fn (run_permission_request_hooks, join_program_and_argv, bash, shlex_join, pause_for, to_string_lossy); called by 1 (process_decision); 5 external calls (new_v4, review_approval_request, routes_approval_to_guardian, clone, vec!).


##### `CoreShellActionProvider::process_decision`  (lines 511–594)

```
async fn process_decision(
        &self,
        decision: Decision,
        needs_escalation: bool,
        program: &AbsolutePathBuf,
        argv: &[String],
        workdir: &AbsolutePathBuf,
```

**Purpose**: Converts an exec-policy `Decision` plus escalation context into a final `EscalationDecision` for the zsh-fork server. It centralizes denial reasons, prompt handling, and the distinction between plain run and escalated execution.

**Data flow**: Consumes the policy `Decision`, a `needs_escalation` flag, intercepted command metadata, optional prompt permissions, the target `EscalationExecution`, and the `DecisionSource`. For `Forbidden`, it returns `EscalationDecision::deny`. For `Prompt`, it first checks `execve_prompt_is_rejected_by_policy`; if prompting is allowed, it awaits `prompt` and maps each `ReviewDecision` variant to run/escalate/deny, including Guardian rejection and timeout messages. For `Allow`, it returns `run` or `escalate` depending on `needs_escalation`. It logs the final mapping and returns the `EscalationDecision`.

**Call relations**: This method is the final stage of `CoreShellActionProvider::determine_action`. It delegates human approval work to `prompt` and encapsulates all review-decision-to-escalation-action translation.

*Call graph*: calls 5 internal fn (prompt, execve_prompt_is_rejected_by_policy, deny, escalate, run); called by 1 (determine_action); 4 external calls (guardian_rejection_message, guardian_timeout_message, clone, debug!).


##### `CoreShellActionProvider::determine_action`  (lines 671–680)

```
fn determine_action(
        &'a self,
        program: &'a AbsolutePathBuf,
        argv: &'a [String],
        workdir: &'a AbsolutePathBuf,
    ) -> EscalationPolicyFuture<'a>
```

**Purpose**: Evaluates an intercepted exec against current exec policy and shell-request context, then decides whether zsh-fork should run it directly, deny it, or escalate it with a specific execution mode. It is the core policy callback exposed to the escalation server.

**Data flow**: Reads the current `Policy` under `RwLock`, calls `evaluate_intercepted_exec_policy` with an `InterceptedExecPolicyContext` built from approval policy, permission profile, Windows sandbox level, approval-time sandbox permissions, and shell-wrapper parsing flag. It computes whether the decision was rule-driven via `decision_driven_by_policy`, whether unsandboxed execution is allowed, whether escalation is needed based on original shell-request sandbox permissions, chooses a `DecisionSource`, derives the concrete `EscalationExecution` (prefix-rule decisions prefer unsandboxed or turn-default; fallback decisions use `shell_request_escalation_execution`), and forwards everything to `process_decision`. Returns the resulting `EscalationDecision`.

**Call relations**: This is called by the `EscalationPolicy` trait adapter when the escalation server intercepts an execve. It depends on `evaluate_intercepted_exec_policy` for rule matching and on `process_decision` for final action selection.

*Call graph*: calls 3 internal fn (process_decision, evaluate_intercepted_exec_policy, unsandboxed_execution_allowed); 5 external calls (pin, decision_driven_by_policy, shell_request_escalation_execution, clone, debug!).


##### `evaluate_intercepted_exec_policy`  (lines 683–734)

```
fn evaluate_intercepted_exec_policy(
    policy: &Policy,
    program: &AbsolutePathBuf,
    argv: &[String],
    context: InterceptedExecPolicyContext,
) -> Evaluation
```

**Purpose**: Runs exec-policy evaluation for an intercepted executable invocation, optionally parsing shell-wrapper commands into inner candidate commands before matching rules. It also supplies the unmatched-command fallback renderer used when no explicit rule matches.

**Data flow**: Consumes a `Policy`, normalized `program`, raw `argv`, and `InterceptedExecPolicyContext`. Depending on `enable_shell_wrapper_parsing`, it either calls `commands_for_intercepted_exec_policy` or constructs a single candidate command from `join_program_and_argv`. It builds a fallback closure that calls `crate::exec_policy::render_decision_for_unmatched_command` with approval policy, permission profile, Windows sandbox level, sandbox permissions, parsing complexity flag, and generic command origin. It then calls `policy.check_multiple_with_options` over the candidate commands with host executable resolution enabled, returning an `Evaluation`.

**Call relations**: It is used by `CoreShellActionProvider::determine_action` as the authoritative policy evaluation step for intercepted execs.

*Call graph*: calls 1 internal fn (commands_for_intercepted_exec_policy); called by 1 (determine_action); 2 external calls (check_multiple_with_options, vec!).


##### `commands_for_intercepted_exec_policy`  (lines 750–778)

```
fn commands_for_intercepted_exec_policy(
    program: &AbsolutePathBuf,
    argv: &[String],
) -> CandidateCommands
```

**Purpose**: Extracts candidate inner commands from a shell-wrapper invocation like `bash -lc 'git status && pwd'` so exec policy can match the actual commands rather than only the shell wrapper. If parsing fails or the argv shape is not a simple shell wrapper, it falls back to the normalized outer command.

**Data flow**: Takes normalized `program` and raw `argv`. If `argv` has exactly three elements matching shell wrapper shape, it builds a temporary shell command array and tries `parse_shell_lc_plain_commands`; if that fails, it tries `parse_shell_lc_single_command_prefix`. On success it returns `CandidateCommands` with parsed commands and a `used_complex_parsing` flag indicating whether only prefix parsing succeeded. Otherwise it returns one command from `join_program_and_argv` with `used_complex_parsing: false`.

**Call relations**: This helper is called by `evaluate_intercepted_exec_policy` only when shell-wrapper parsing is enabled.

*Call graph*: calls 3 internal fn (parse_shell_lc_plain_commands, parse_shell_lc_single_command_prefix, to_string_lossy); called by 1 (evaluate_intercepted_exec_policy); 1 external calls (vec!).


##### `CoreShellCommandExecutor::run`  (lines 837–885)

```
async fn run(
        &self,
        env_overlay: HashMap<String, String>,
        cancel_rx: CancellationToken,
        after_spawn: Option<Box<dyn FnOnce() + Send>>,
    ) -> anyhow::Result<ExecResu
```

**Purpose**: Runs the original shell command under the prepared sandbox/execution settings while merging only the escalation-session socket variables from the overlay environment. This preserves the base shell environment and avoids leaking unrelated overlay variables.

**Data flow**: Reads `self.env` as the base environment, then copies only `CODEX_ESCALATE_SOCKET` and `EXEC_WRAPPER` from `env_overlay` into it. It constructs a fresh `crate::sandboxing::ExecRequest` from the executor’s stored command, cwd, network, sandbox, permission profile, filesystem/network policies, Windows settings, and `ExecExpiration::Cancellation(cancel_rx)`, then calls `execute_exec_request_with_after_spawn`. It converts the result into `ExecResult` by extracting exit code, stdout, stderr, aggregated output, duration, and timeout flag.

**Call relations**: This method is invoked by the escalation server through the `ShellCommandExecutor` trait when it wants to run the original wrapped shell command after policy handling.

*Call graph*: calls 1 internal fn (execute_exec_request_with_after_spawn); 5 external calls (pin, Cancellation, clone, clone, clone).


##### `CoreShellCommandExecutor::prepare_escalated_exec`  (lines 887–945)

```
async fn prepare_escalated_exec(
        &self,
        program: &AbsolutePathBuf,
        argv: &[String],
        workdir: &AbsolutePathBuf,
        env: HashMap<String, String>,
        execution:
```

**Purpose**: Builds the direct executable launch that should replace the intercepted shell wrapper when zsh-fork decides to escalate. It supports unsandboxed execution, turn-default sandboxing, additive additional permissions, and fully resolved permission profiles.

**Data flow**: Consumes intercepted `program`, `argv`, `workdir`, an environment map, and an `EscalationExecution`. It normalizes the command with `join_program_and_argv`, requires `argv[0]` to exist, and then branches: `Unsandboxed` returns a `PreparedExec` with env filtered through `exec_env_for_sandbox_permissions(..., RequireEscalated)` and `arg0` set from the original first arg; `TurnDefault` and both permission-bearing variants delegate to `prepare_sandboxed_exec` with the appropriate permission profile and optional additional permissions. Returns the resulting `PreparedExec` or an error if argv is empty.

**Call relations**: The escalation server calls this through the `ShellCommandExecutor` trait when policy chose `EscalationDecision::Escalate(...)`. It delegates sandboxed cases to `prepare_sandboxed_exec`.

*Call graph*: calls 4 internal fn (exec_env_for_sandbox_permissions, prepare_sandboxed_exec, join_program_and_argv, to_path_buf); 2 external calls (pin, anyhow!).


##### `CoreShellCommandExecutor::prepare_sandboxed_exec`  (lines 948–1012)

```
fn prepare_sandboxed_exec(
        &self,
        params: PrepareSandboxedExecParams<'_>,
    ) -> anyhow::Result<PreparedExec>
```

**Purpose**: Recomputes a sandbox-transformed executable launch for an intercepted command under a chosen permission profile. It is the low-level bridge from escalation decisions back into the normal sandbox manager transform pipeline.

**Data flow**: Consumes `PrepareSandboxedExecParams` containing command vector, workdir, env, permission profile, and optional additional permissions. It derives runtime filesystem/network policies from the permission profile, splits command into program and args, selects an initial sandbox with `SandboxManager::select_initial`, converts workdir and sandbox-policy cwd to `PathUri`, builds a `SandboxCommand`, transforms it with `SandboxManager::transform`, converts the result into `crate::sandboxing::ExecRequest::from_sandbox_exec_request`, applies managed-network env vars if a network proxy is present, and returns `PreparedExec` with transformed command/cwd/env/arg0.

**Call relations**: This helper is called only by `CoreShellCommandExecutor::prepare_escalated_exec` for all sandboxed escalation modes.

*Call graph*: calls 3 internal fn (from_sandbox_exec_request, new, from_abs_path); called by 1 (prepare_escalated_exec).


##### `extract_shell_script`  (lines 1022–1045)

```
fn extract_shell_script(command: &[String]) -> Result<ParsedShellCommand, ToolError>
```

**Purpose**: Finds the inner shell program and script text inside a possibly wrapped command vector by searching for the first `program -c script` or `program -lc script` triple anywhere in argv. This makes zsh-fork tolerant of environment and sandbox wrappers inserted ahead of the shell invocation.

**Data flow**: Scans `command.windows(3)` and matches either `-c` or `-lc`. On success it returns `ParsedShellCommand { program, script, login }`, where `login` is true only for `-lc`. If no such triple exists, it returns `ToolError::Rejected("unexpected shell command format for zsh-fork execution")`.

**Call relations**: It is used by both `try_run_zsh_fork` and `prepare_unified_exec_zsh_fork` to verify that the command shape is compatible with zsh-fork interception.

*Call graph*: called by 2 (prepare_unified_exec_zsh_fork, try_run_zsh_fork); 1 external calls (Rejected).


##### `map_exec_result`  (lines 1047–1074)

```
fn map_exec_result(
    sandbox: SandboxType,
    result: ExecResult,
) -> Result<ExecToolCallOutput, ToolError>
```

**Purpose**: Converts a zsh-fork `ExecResult` into the standard `ExecToolCallOutput`, while upgrading timeout and likely sandbox-denial outcomes into structured sandbox errors. This keeps zsh-fork behavior aligned with the rest of the execution stack.

**Data flow**: Consumes the active `SandboxType` and an `ExecResult`. It first builds an `ExecToolCallOutput` by wrapping stdout/stderr/aggregated output strings in `StreamOutput`. If `timed_out` is true, it returns `ToolError::Codex(CodexErr::Sandbox(SandboxErr::Timeout { output }))`. Otherwise, if `is_likely_sandbox_denied` reports denial, it returns `ToolError::Codex(CodexErr::Sandbox(SandboxErr::Denied { output, network_policy_decision: None }))`. If neither condition applies, it returns the output.

**Call relations**: This is the final conversion step in `try_run_zsh_fork` after the escalation server finishes execution.

*Call graph*: calls 2 internal fn (is_likely_sandbox_denied, new); called by 1 (try_run_zsh_fork); 3 external calls (new, Codex, Sandbox).


##### `join_program_and_argv`  (lines 1082–1086)

```
fn join_program_and_argv(program: &AbsolutePathBuf, argv: &[String]) -> Vec<String>
```

**Purpose**: Normalizes an intercepted exec into a display/policy command vector by replacing the original `argv[0]` with the resolved absolute `program` path. This avoids duplicating the executable name as if it were a user argument.

**Data flow**: Takes an absolute `program` path and raw `argv`, converts `program` to string, chains it with `argv.iter().skip(1)`, collects into `Vec<String>`, and returns it.

**Call relations**: It is used by `CoreShellActionProvider::prompt` for approval display and by `CoreShellCommandExecutor::prepare_escalated_exec` when constructing the direct executable command.

*Call graph*: calls 1 internal fn (to_string_lossy); called by 2 (prompt, prepare_escalated_exec); 1 external calls (once).
