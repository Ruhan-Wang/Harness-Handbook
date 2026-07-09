# Sandbox selection and Unix platform launchers  `stage-14.2.4`

This stage is shared behind-the-scenes support for running commands safely on Unix systems. It sits just before a tool or shell command is launched. Its job is to choose the right sandbox, rewrite the launch request, and, when needed, ask for permission to run with more power.

The sandboxing front door and manager provide the common entry point. They hide Linux and macOS differences, decide if a sandbox is needed, and turn a normal command into a sandbox-ready one. On Linux, the Bubblewrap and Landlock pieces check what sandbox tools are available, build the restricted filesystem and network rules, and start the helper process. The launcher picks a system Bubblewrap if possible, or a bundled copy if not, and reports clear setup problems.

The shell-escalation pieces handle commands that may need extra permission. A patched Unix shell can ask an escalation server what to do. The policy says allow, deny, or escalate. The client and server carry that request and connect it to the real process launcher. The runtime files prepare shells, environments, sandbox inputs, and the special Unix shell path that ties approval and sandboxing together.

## Files in this stage

### Sandboxing API and selection
These files define the public sandboxing surface and the central logic that selects a sandbox strategy and rewrites launch requests into platform-specific execution forms.

### `sandboxing/src/lib.rs`

`orchestration` · `cross-cutting`

This file is like the reception desk for the sandboxing part of the system. Other code does not need to know which internal file implements Linux sandboxing, macOS sandboxing, policy rewriting, or command setup. It imports those pieces and re-exports the important names, so callers can use one stable interface.

The main problem this solves is portability. Sandboxing depends heavily on the operating system: Linux may use tools such as bubblewrap or Landlock, while macOS uses Seatbelt. This file only exposes platform-specific pieces when they make sense on the current operating system. For example, on non-Linux systems it provides a harmless `system_bwrap_warning` function that always says there is no bubblewrap warning, because bubblewrap is not relevant there.

It also connects sandbox-specific failures to the wider Codex error system. If sandbox policy transformation fails because a working directory is invalid, that becomes an invalid user request. If a required Linux sandbox executable is missing, that becomes a specific sandbox executable error. If a platform-only sandbox is requested on the wrong system, the caller gets an unsupported-operation error. Without this file, callers would need to understand many internal sandbox modules and manually turn their errors into user-facing Codex errors.

#### Function details

##### `system_bwrap_warning`  (lines 27–31)

```
fn system_bwrap_warning(
    _permission_profile: &codex_protocol::models::PermissionProfile,
) -> Option<String>
```

**Purpose**: On non-Linux systems, this function answers the question: “Should we warn about the system bubblewrap sandbox tool?” The answer is always no, because bubblewrap is a Linux-specific tool.

**Data flow**: It receives a permission profile, but on non-Linux platforms it does not need to inspect it. It simply returns `None`, meaning there is no warning message to show and nothing else changes.

**Call relations**: This is the fallback version used when the Linux-specific bubblewrap module is not compiled in. Code elsewhere can still call `system_bwrap_warning` without first checking the operating system; on Linux it is supplied by the bubblewrap module, and on other systems this safe no-op version is used.


##### `CodexErr::from`  (lines 34–52)

```
fn from(err: SandboxTransformError) -> Self
```

**Purpose**: This converts sandbox policy setup errors into the broader `CodexErr` error type used by the rest of the application. It lets sandbox code report precise problems while allowing higher-level code to handle errors in one common form.

**Data flow**: It receives a `SandboxTransformError`, looks at what kind of failure it is, and builds the matching `CodexErr`. Invalid directories become invalid-request errors with a readable message. Missing sandbox tools or unsupported platform choices become specific or unsupported-operation errors. The output is a single `CodexErr`; it does not modify any stored state.

**Call relations**: This conversion is used when sandbox setup or policy transformation fails and that failure needs to leave the sandboxing crate. During the conversion it hands some cases to the common `InvalidRequest` or `UnsupportedOperation` error constructors, so the rest of the system can present or route the failure consistently.

*Call graph*: 2 external calls (InvalidRequest, UnsupportedOperation).


### `sandboxing/src/manager.rs`

`orchestration` · `command execution setup`

A sandbox is a safety wrapper around a process. It limits what files the process can touch and whether it can use the network. This file takes the project’s high-level permission choices, such as “read these folders” or “no network,” and turns them into something the current operating system can enforce.

The main type is `SandboxManager`. First, it can choose an initial sandbox type: none, macOS Seatbelt, Linux seccomp/Landlock tooling, or a Windows restricted token. That choice depends on the user’s preference, the requested file and network limits, and whether Windows sandboxing is enabled.

Then `SandboxManager::transform` prepares the real execution request. It checks that URI-style working directories can be converted into native local paths, merges any one-off extra permissions into the base permission profile, and adds read access for a managed network proxy’s certificate bundle when needed. After that it builds the command line. On macOS it wraps the command with the Seatbelt executable. On Linux it wraps it with the Codex Linux sandbox executable and checks for a known WSL1 limitation. On Windows, the command is left in native form but carries Windows sandbox settings onward.

Without this file, the rest of the system would have permission policies but no reliable way to turn them into safe, runnable commands on each platform.

#### Function details

##### `SandboxType::as_metric_tag`  (lines 33–40)

```
fn as_metric_tag(self) -> &'static str
```

**Purpose**: Turns a sandbox choice into a short label suitable for metrics and logs. This lets the system count or report which sandbox style was used without storing Rust enum names directly.

**Data flow**: It starts with one `SandboxType` value, such as no sandbox, macOS Seatbelt, Linux seccomp, or Windows sandbox. It matches that value to a fixed text tag like `none` or `seccomp`. The output is that tag as a string slice; nothing else is changed.

**Call relations**: This is a small reporting helper for code that wants to describe a sandbox decision after it has been made. It does not call other project functions and does not participate in building the sandbox command itself.


##### `get_platform_sandbox`  (lines 50–64)

```
fn get_platform_sandbox(windows_sandbox_enabled: bool) -> Option<SandboxType>
```

**Purpose**: Chooses the sandbox technology that exists on the current operating system. It answers the question, “If we want a platform sandbox here, which one can this machine use?”

**Data flow**: It takes one input: whether Windows sandboxing is enabled. It checks the operating system at compile time. On macOS it returns macOS Seatbelt, on Linux it returns Linux seccomp, on Windows it returns the Windows restricted token sandbox only if enabled, and on unsupported systems it returns no sandbox choice.

**Call relations**: `SandboxManager::select_initial` calls this after deciding that a sandbox may be needed. This function provides the platform-specific answer, while `select_initial` handles the higher-level policy decision.

*Call graph*: called by 1 (select_initial); 1 external calls (cfg!).


##### `with_managed_mitm_ca_readable_root`  (lines 66–85)

```
fn with_managed_mitm_ca_readable_root(
    permission_profile: PermissionProfile,
    managed_mitm_ca_trust_bundle_path: Option<&AbsolutePathBuf>,
    sandbox_policy_cwd: &Path,
) -> PermissionProfile
```

**Purpose**: Adds read permission for the certificate bundle used by the managed network proxy, if such a bundle exists. This matters because a sandboxed command may need to read that certificate file in order to make trusted network connections through the proxy.

**Data flow**: It receives a permission profile, an optional absolute path to the managed certificate bundle, and the directory used for interpreting sandbox paths. If there is no certificate path, it returns the original profile. If there is one, it breaks the profile into file-system and network rules, adds the certificate path as an extra readable root, and rebuilds a permission profile with the same enforcement setting.

**Call relations**: `SandboxManager::transform` calls this while preparing the final execution request. It fits between merging permissions and creating platform-specific sandbox arguments, so the later sandbox setup includes the certificate access.

*Call graph*: calls 3 internal fn (enforcement, from_runtime_permissions_with_enforcement, to_runtime_permissions); called by 1 (transform); 1 external calls (from_ref).


##### `SandboxTransformError::fmt`  (lines 152–172)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Creates clear human-readable messages for the errors that can happen while turning a command into a sandboxed execution request. These messages are what users or logs see when sandbox setup fails.

**Data flow**: It receives one sandbox transformation error and a formatter to write into. It chooses a message based on the error kind, including details like the invalid working-directory URI or the underlying system error. The output is formatted text written into the formatter.

**Call relations**: This is used by Rust’s standard display machinery whenever a `SandboxTransformError` needs to be printed. It does not drive sandbox setup, but it makes failures from `SandboxManager::transform` understandable.

*Call graph*: 1 external calls (write!).


##### `SandboxTransformError::source`  (lines 176–186)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Exposes the underlying cause for errors that wrap another system error. This helps error-reporting tools show the chain of what went wrong.

**Data flow**: It receives one sandbox transformation error. For invalid command or policy working directories, it returns the original I/O error as the source. For errors that are already complete on their own, such as a missing Linux sandbox executable, it returns no source.

**Call relations**: This is part of Rust’s standard error interface. It supports callers of `SandboxManager::transform` when they inspect or report an error, especially for path-conversion failures.


##### `SandboxManager::new`  (lines 193–195)

```
fn new() -> Self
```

**Purpose**: Creates a new `SandboxManager`. The manager has no stored settings, so construction is intentionally simple.

**Data flow**: It takes no input beyond the call itself. It returns a fresh `SandboxManager` value. No files, network state, or global settings are changed.

**Call relations**: Higher-level setup code and tests call this before asking the manager to choose or transform sandbox settings. The returned manager is then used by flows such as selecting a process execution sandbox type or preparing sandboxed execution.

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

**Purpose**: Makes the first decision about whether a command should use a sandbox. It combines user preference with the actual file, network, and managed-network requirements.

**Data flow**: It receives the file-system policy, network policy, the sandbox preference, Windows sandbox settings, and whether managed networking creates extra requirements. If the preference forbids sandboxing, it returns no sandbox. If the preference requires sandboxing, it asks what sandbox the platform supports. In automatic mode, it first asks whether the policies actually require a platform sandbox, and only then chooses the platform sandbox if available.

**Call relations**: The main run flow calls this when it needs an initial sandbox choice. It delegates the policy question to `should_require_platform_sandbox` and the operating-system choice to `get_platform_sandbox`, then hands back a `SandboxType` for later execution setup.

*Call graph*: calls 2 internal fn (get_platform_sandbox, should_require_platform_sandbox); called by 1 (run).


##### `SandboxManager::transform`  (lines 226–338)

```
fn transform(
        &self,
        request: SandboxTransformRequest<'_>,
    ) -> Result<SandboxExecRequest, SandboxTransformError>
```

**Purpose**: Turns a high-level sandbox launch request into a concrete execution request ready for the process-running layer. This is where permissions, paths, network proxy needs, and platform-specific wrapper commands all come together.

**Data flow**: It receives a `SandboxTransformRequest` containing the command, permission profile, selected sandbox type, network proxy information, policy working directory, Linux sandbox executable path, and Windows sandbox options. It converts URI paths into native absolute paths, reports clear errors if that fails, folds in any additional permissions, adds proxy certificate read access when needed, and splits the final permission profile into file and network rules. It then builds the command vector: unchanged for no sandbox, wrapped for macOS Seatbelt, wrapped with the Codex Linux sandbox executable for Linux, and carried forward with Windows sandbox settings for Windows. The result is a `SandboxExecRequest` containing the final command, environment, policies, network proxy clone, sandbox type, and any special `arg0` override.

**Call relations**: `env_for` calls this when it needs a runnable sandbox execution request. Inside, this function calls helpers such as `with_managed_mitm_ca_readable_root`, `os_argv_to_strings`, Linux sandbox argument creation, proxy-network checks, the WSL1 support check, and the Linux `arg0` override helper. It is the main bridge from abstract policy to executable command.

*Call graph*: calls 9 internal fn (is_wsl1, allow_network_for_proxy, create_linux_sandbox_command_args_for_permission_profile, ensure_linux_bubblewrap_is_supported, linux_sandbox_arg0_override, os_argv_to_strings, os_string_to_command_component, with_managed_mitm_ca_readable_root, effective_permission_profile); called by 1 (env_for); 1 external calls (with_capacity).


##### `compatibility_sandbox_policy_for_permission_profile`  (lines 341–351)

```
fn compatibility_sandbox_policy_for_permission_profile(
    permissions: &PermissionProfile,
    cwd: &Path,
) -> SandboxPolicy
```

**Purpose**: Builds an older-style `SandboxPolicy` from a newer permission profile. This keeps compatibility with parts of the system that still expect the legacy sandbox policy shape.

**Data flow**: It receives a permission profile and a current working directory. It first asks the profile to convert itself into a legacy sandbox policy. If that succeeds, it returns that policy. If not, it falls back to building a workspace-write style policy from the runtime file and network permissions.

**Call relations**: This function is a compatibility bridge. It calls the profile’s legacy conversion first, and if that cannot represent the permissions, it relies on `compatibility_workspace_write_policy` to produce a reasonable older-format policy.

*Call graph*: calls 1 internal fn (to_legacy_sandbox_policy).


##### `compatibility_workspace_write_policy`  (lines 353–382)

```
fn compatibility_workspace_write_policy(
    file_system_policy: FileSystemSandboxPolicy,
    network_policy: NetworkSandboxPolicy,
    cwd: &Path,
) -> SandboxPolicy
```

**Purpose**: Creates a legacy workspace-write sandbox policy from newer file and network permission rules. It approximates the newer rules in a format older code can understand.

**Data flow**: It receives file-system rules, network rules, and a current working directory. It gathers writable roots, leaving out the current directory itself when appropriate. It checks whether the `TMPDIR` environment path and `/tmp` are writable under the file policy. It then returns a `SandboxPolicy::WorkspaceWrite` with the writable roots, whether network access is allowed, and whether temporary directories should be excluded.

**Call relations**: `compatibility_sandbox_policy_for_permission_profile` uses this as a fallback when direct legacy conversion fails. It calls into the file-system policy to ask what paths are writable and into the network policy to ask whether network access is enabled.

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

**Purpose**: Prevents the Linux sandbox setup from choosing Bubblewrap-style sandboxing on WSL1 when that combination is known not to work. WSL1 is the first Windows Subsystem for Linux, and it lacks some Linux features needed by this sandbox path.

**Data flow**: It receives the file-system policy, whether legacy Landlock is being used, whether proxy networking must be allowed, and whether the host is WSL1. It decides whether Bubblewrap is required: proxy networking needs it, and non-legacy Landlock with restricted disk access can need it too. If Bubblewrap is required on WSL1, it returns an error; otherwise it returns success.

**Call relations**: `SandboxManager::transform` calls this only on Linux before building the final Linux sandbox command. It acts as a guardrail so the transform step fails early with a clear message instead of launching a sandbox that cannot work.

*Call graph*: calls 1 internal fn (has_full_disk_write_access); called by 1 (transform).


##### `os_argv_to_strings`  (lines 400–404)

```
fn os_argv_to_strings(argv: Vec<OsString>) -> Vec<String>
```

**Purpose**: Converts operating-system command arguments into ordinary strings for sandbox command builders. This is needed because process arguments may contain platform-native string data that is not always clean Unicode text.

**Data flow**: It receives a list of `OsString` values, which are operating-system-native strings. It converts each item with `os_string_to_command_component`, preserving valid text and using a safe lossy conversion when needed. It returns a list of regular `String` values.

**Call relations**: `SandboxManager::transform` uses this when building commands for no sandbox, macOS sandboxing, Linux sandboxing, and Windows passthrough. It delegates the actual one-item conversion to `os_string_to_command_component`.

*Call graph*: called by 1 (transform).


##### `os_string_to_command_component`  (lines 406–410)

```
fn os_string_to_command_component(value: OsString) -> String
```

**Purpose**: Converts one operating-system-native string into a regular Rust string for use in command arrays. It provides a fallback for unusual path or argument bytes that are not valid Unicode.

**Data flow**: It receives one `OsString`. It first tries to turn it into a normal `String` exactly. If that fails, it converts it using a loss-tolerant display form, replacing invalid pieces rather than crashing. The output is always a `String`.

**Call relations**: `os_argv_to_strings` calls this for every command component. `SandboxManager::transform` also calls it directly for the Linux sandbox executable path, and `linux_sandbox_arg0_override` uses it when it needs to preserve the executable path as the displayed program name.

*Call graph*: called by 2 (transform, linux_sandbox_arg0_override); 1 external calls (into_string).


##### `linux_sandbox_arg0_override`  (lines 412–418)

```
fn linux_sandbox_arg0_override(exe: &Path) -> String
```

**Purpose**: Chooses the program name, or `arg0`, that should be presented for the Linux sandbox executable. `arg0` is the first command-line value a program sees as its own name, and some programs use it to decide behavior.

**Data flow**: It receives the path to the Linux sandbox executable. If the file name already matches the special expected Linux sandbox name, it converts and returns the executable path itself. Otherwise, it returns the standard sandbox `arg0` name. The output is a string used as an override in the final execution request.

**Call relations**: `SandboxManager::transform` calls this while building a Linux sandboxed command. It uses `os_string_to_command_component` when the actual executable path should be carried through as the override.

*Call graph*: calls 1 internal fn (os_string_to_command_component); called by 1 (transform); 2 external calls (as_os_str, file_name).


### `sandboxing/src/bwrap.rs`

`domain_logic` · `startup or before running sandboxed shell commands`

Codex uses sandboxing to limit what shell commands can touch, much like putting a messy project inside a sealed workshop instead of letting it spread through the whole house. On Linux, that workshop is built with a program called bubblewrap, or `bwrap`. This file answers a practical question before Codex tries to sandbox a command: “Will the platform sandbox actually work here, and if not, what should we tell the user?”

The main path starts with a permission profile, which describes what a command is allowed to do. If those permissions do not require a platform sandbox, this file stays quiet. If a sandbox is needed, it looks for a system-installed `bwrap` on the user’s `PATH`, avoiding copies that live inside the current working directory. That avoids trusting a project-local executable that could be fake or unsafe.

If Codex is running on WSL1, it warns immediately because WSL1 cannot provide the Linux namespace features bubblewrap needs. If `bwrap` is missing, it warns that Codex will fall back to its bundled copy. If `bwrap` exists, the file runs a tiny probe command to see whether user namespaces are allowed. A namespace is an operating-system isolation feature; without it, bubblewrap cannot build the sandbox. The probe is short, has a timeout, and treats unclear failures cautiously so Codex does not block startup unnecessarily.

#### Function details

##### `system_bwrap_warning`  (lines 40–47)

```
fn system_bwrap_warning(permission_profile: &PermissionProfile) -> Option<String>
```

**Purpose**: This is the main public check for whether Codex should show a bubblewrap-related warning. It only produces a message when the current permission settings need Linux platform sandboxing and something about the local system may prevent that sandbox from working.

**Data flow**: It receives a permission profile. First it asks whether that profile actually needs a platform sandbox; if not, it returns no warning. If sandboxing is needed, it searches for `bwrap` on `PATH`, then passes the result to the warning decision logic and returns either a warning string or nothing.

**Call relations**: This function ties the file together. It calls `should_warn_about_system_bwrap` to decide whether the check matters, `find_system_bwrap_in_path` to locate a trusted system `bwrap`, and `system_bwrap_warning_for_path` to turn the local machine’s situation into a user-facing message.

*Call graph*: calls 3 internal fn (find_system_bwrap_in_path, should_warn_about_system_bwrap, system_bwrap_warning_for_path).


##### `should_warn_about_system_bwrap`  (lines 49–56)

```
fn should_warn_about_system_bwrap(permission_profile: &PermissionProfile) -> bool
```

**Purpose**: This helper decides whether bubblewrap is relevant for the given permission profile. If the requested permissions can be enforced without the platform sandbox, there is no reason to warn about bubblewrap.

**Data flow**: It takes a permission profile and converts it into runtime permissions: the file-system rules and network rules Codex will actually use. It then asks the policy transform code whether those rules require a platform sandbox, and returns that yes-or-no answer.

**Call relations**: It is called by `system_bwrap_warning` at the very beginning of the warning flow. It hands the decision off to `should_require_platform_sandbox`, which knows the broader sandbox policy rules.

*Call graph*: calls 2 internal fn (to_runtime_permissions, should_require_platform_sandbox); called by 1 (system_bwrap_warning).


##### `system_bwrap_warning_for_path`  (lines 58–72)

```
fn system_bwrap_warning_for_path(system_bwrap_path: Option<&Path>) -> Option<String>
```

**Purpose**: This function chooses the exact warning message, if any, after Codex has tried to find system bubblewrap. It separates three user-visible cases: WSL1, missing `bwrap`, and `bwrap` being present but unable to create user namespaces.

**Data flow**: It receives either a path to a discovered `bwrap` program or no path at all. It first checks whether the machine appears to be WSL1; if so, it returns the WSL1 warning. If there is no `bwrap` path, it returns the missing-bubblewrap warning. If there is a path, it probes whether that program can create the needed isolation and returns a namespace warning only when the probe shows that access is blocked.

**Call relations**: It is called by `system_bwrap_warning` after the permission check and path lookup. It calls `is_wsl1` for the special Windows Subsystem for Linux case and `system_bwrap_has_user_namespace_access` for the live bubblewrap capability test.

*Call graph*: calls 2 internal fn (is_wsl1, system_bwrap_has_user_namespace_access); called by 1 (system_bwrap_warning).


##### `system_bwrap_has_user_namespace_access`  (lines 74–136)

```
fn system_bwrap_has_user_namespace_access(system_bwrap_path: &Path, timeout: Duration) -> bool
```

**Purpose**: This function runs a small, time-limited bubblewrap test to see whether the operating system allows the user-namespace feature needed for sandboxing. A user namespace is an operating-system isolation feature that lets an unprivileged process act like it has its own private user IDs inside the sandbox.

**Data flow**: It receives the path to `bwrap` and a timeout. It starts `bwrap` with options that create user and network namespaces, bind the root filesystem read-only, and run `/bin/true`, a command that simply exits successfully. It watches the child process until it exits, fails, or times out. If the command succeeds, it returns true. If it fails with known namespace-related error text, it returns false. If the probe cannot be started, hangs, or errors in an unclear way, it returns true so Codex avoids producing a possibly false warning.

**Call relations**: It is called by `system_bwrap_warning_for_path` only after a candidate `bwrap` has been found and WSL1 has been ruled out. It calls `is_user_namespace_failure` to interpret the probe’s error output and uses standard process and timing tools to run the check safely without blocking for long.

*Call graph*: calls 1 internal fn (is_user_namespace_failure); called by 1 (system_bwrap_warning_for_path); 6 external calls (now, null, piped, new, new, sleep).


##### `is_wsl1`  (lines 138–141)

```
fn is_wsl1() -> bool
```

**Purpose**: This function checks whether Codex appears to be running under WSL1, the first version of Windows Subsystem for Linux. That matters because WSL1 cannot create the namespaces bubblewrap needs for sandboxing.

**Data flow**: It reads `/proc/version`, a Linux system file that describes the running kernel or environment. If the file can be read, it passes the text to `proc_version_indicates_wsl1` and returns that result; if the file cannot be read, it returns false.

**Call relations**: It is called by `system_bwrap_warning_for_path` before any bubblewrap probing, because WSL1 is a known unsupported environment. The call graph also shows it being used by `transform`, so this WSL1 detection is shared with another sandbox-policy path outside this file.

*Call graph*: called by 2 (system_bwrap_warning_for_path, transform); 1 external calls (read_to_string).


##### `proc_version_indicates_wsl1`  (lines 143–159)

```
fn proc_version_indicates_wsl1(proc_version: &str) -> bool
```

**Purpose**: This helper interprets the text from `/proc/version` and decides whether it points to WSL1. It exists so the WSL detection rule can be tested and reasoned about without reading the real system file every time.

**Data flow**: It receives the raw `/proc/version` text, lowercases it, and looks for WSL markers. If it finds a marker like `wsl1`, it parses the following digits and returns true only for version 1. If there is no explicit version, it falls back to an older pattern: text containing `microsoft` but not `microsoft-standard` is treated as WSL1.

**Call relations**: Although the provided call facts do not list an internal caller, this function is the parsing half of `is_wsl1`’s job. In practice it supplies the detailed decision rule that lets file-reading code stay simple.


##### `is_user_namespace_failure`  (lines 161–166)

```
fn is_user_namespace_failure(output: &Output) -> bool
```

**Purpose**: This function looks at bubblewrap’s error message and decides whether it matches known failures caused by missing user-namespace support. It turns messy command-line error text into a simple yes-or-no signal.

**Data flow**: It receives a process output object, reads its standard error bytes as text, and searches for several known failure phrases. If any phrase is present, it returns true; otherwise it returns false.

**Call relations**: It is called by `system_bwrap_has_user_namespace_access` after the probe process exits unsuccessfully. Its answer tells the probe whether the failure really means “namespaces are unavailable” or whether the error was something else that should not trigger this warning.

*Call graph*: called by 1 (system_bwrap_has_user_namespace_access); 1 external calls (from_utf8_lossy).


##### `find_system_bwrap_in_path`  (lines 168–172)

```
fn find_system_bwrap_in_path() -> Option<PathBuf>
```

**Purpose**: This function searches the user’s `PATH` for a system-installed `bwrap` executable. It is careful to use the current directory as context so the deeper search helper can avoid trusting a project-local copy.

**Data flow**: It reads the `PATH` environment variable and the current working directory. If either is unavailable, it returns nothing. Otherwise it splits `PATH` into individual search directories and passes them, along with the current directory, to `find_system_bwrap_in_search_paths`.

**Call relations**: It is called by `system_bwrap_warning` when Codex has decided bubblewrap matters. It delegates the actual filtering and executable lookup to `find_system_bwrap_in_search_paths`.

*Call graph*: calls 1 internal fn (find_system_bwrap_in_search_paths); called by 1 (system_bwrap_warning); 3 external calls (current_dir, split_paths, var_os).


##### `find_system_bwrap_in_search_paths`  (lines 174–191)

```
fn find_system_bwrap_in_search_paths(
    search_paths: impl IntoIterator<Item = PathBuf>,
    cwd: &Path,
) -> Option<PathBuf>
```

**Purpose**: This helper performs the actual search for `bwrap` across a set of directories, while ignoring any copy found inside the current working directory. That protects Codex from accidentally trusting a `bwrap` executable supplied by the project being worked on.

**Data flow**: It receives a list of search paths and the current directory. It joins the paths into a search path value, canonicalizes the current directory when possible, then asks the `which` library to find all matching `bwrap` executables. For each match, it canonicalizes the path and skips it if it lives under the current directory, unless the current directory is the filesystem root. It returns the first acceptable path or nothing.

**Call relations**: It is called by `find_system_bwrap_in_path`, which gathers the real environment inputs. It hands back a filtered path that `system_bwrap_warning` can safely pass into the warning and probing flow.

*Call graph*: called by 1 (find_system_bwrap_in_path); 4 external calls (parent, join_paths, canonicalize, which_in_all).


### `sandboxing/src/landlock.rs`

`orchestration` · `command execution`

When Codex runs a tool command on Linux, it may need to put that command inside a sandbox: a controlled space where file access and network access are limited. This file does not build the sandbox itself. Instead, it prepares the exact list of words, called command-line arguments, that will be passed to the helper program named `codex-linux-sandbox`.

Think of it like filling out an instruction card for a security guard. The guard is the sandbox helper. This file writes down where the command should run, which directory the sandbox policy is based on, what permission profile to apply, and whether special network behavior is allowed.

The main function serializes a `PermissionProfile` into JSON, because the helper receives that profile as text. It also converts filesystem paths into UTF-8 strings, because command-line arguments must be text. Then it adds feature flags such as legacy Landlock mode or proxy-only networking. Finally, it inserts `--` before the real user command. That separator is important: it tells the helper, “everything after this belongs to the command being sandboxed, not to you.” Without this file, other parts of Codex would have to duplicate this careful argument-building logic, making sandbox launches easier to get wrong.

#### Function details

##### `allow_network_for_proxy`  (lines 8–13)

```
fn allow_network_for_proxy(enforce_managed_network: bool) -> bool
```

**Purpose**: This small function decides whether the Linux sandbox should allow networking only for a managed proxy path. It preserves the older behavior unless managed network requirements are turned on.

**Data flow**: It receives one yes-or-no input: whether managed network rules are being enforced. It returns the same yes-or-no value as the decision about proxy network access, without changing anything else.

**Call relations**: When command-running code is preparing a sandbox launch, `run_command_under_sandbox`, `spawn_command_under_linux_sandbox`, and `transform` ask this function whether proxy networking should be requested. Its answer is then fed into the argument-building step so the helper gets the right network flag.

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

**Purpose**: This function builds the full argument list for starting `codex-linux-sandbox` when Codex has a structured permission profile. Someone uses it when they need to run a command under Linux sandbox rules and pass those rules to the helper process.

**Data flow**: It takes the command to run, the command’s working directory, the permission profile, the sandbox policy directory, and two yes-or-no options for legacy Landlock and proxy networking. It turns the permission profile into JSON text, turns the paths into command-line text, places those values after the helper’s option names, adds any needed feature flags, adds `--` as a divider, and then appends the original command. The result is a vector of strings ready to pass as the helper program’s arguments.

**Call relations**: During sandbox setup, `run_command_under_sandbox`, `spawn_command_under_linux_sandbox`, and `transform` call this function after deciding which permissions and network behavior apply. This function hands back the completed argument list; the caller can then launch the helper, which performs the actual sandboxing.

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

**Purpose**: This is an older, simpler argument builder for the Linux sandbox helper that does not include a serialized permission profile. It exists for code paths or tests that only need directory and feature-flag options.

**Data flow**: It receives the command, the command’s working directory, the sandbox policy directory, and two yes-or-no options for legacy Landlock and proxy networking. It converts the paths to text, creates the helper options, adds the appropriate network or legacy flag, inserts `--` to protect command arguments that start with a dash, and appends the original command. It returns the finished list of command-line strings.

**Call relations**: This helper is not shown as being called by the main runtime flow in the provided graph, and it is allowed to be unused outside tests. It mirrors the same argument-shaping pattern as the permission-profile version, so tests or legacy callers can exercise the older helper command format.

*Call graph*: 2 external calls (to_str, vec!).


### Linux sandbox execution
These files implement the Linux-side sandbox mechanisms and launcher path, from command wrapping through bubblewrap and Landlock enforcement to final executable dispatch.

### `core/src/landlock.rs`

`orchestration` · `tool execution on Linux`

When Codex runs a tool command, it should not automatically get full access to the user’s computer. On Linux, this file helps put that command inside a sandbox: a restricted space that limits what files it can touch and whether it can use the network. Think of it like giving a worker a locked toolbox and access only to the rooms they are allowed to enter.

The main job here is to prepare a request for the separate Linux sandbox executable, called the sandbox helper. Unlike some systems where the sandbox rules are embedded directly into the command, this Linux path passes the permission profile to a helper program. That helper turns the profile into the lower-level operating-system restrictions.

The file also preserves an important detail about how the helper is invoked. Some sandbox helpers choose their behavior based on the name they were started with, known as `argv0` in Unix-style process launching. This code makes sure the helper sees the expected name, even when the executable path is different.

Finally, it hands everything to the shared async child-spawning code: the command, working directory, environment variables, standard input/output policy, network proxy if any, and the computed sandbox arguments.

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

**Purpose**: Starts a command inside the Linux sandbox helper using the requested permission profile. Callers use it when they want a shell/tool command to run with controlled filesystem and network access instead of running freely on the host machine.

**Data flow**: It receives the sandbox helper path, the command to run, the command’s working directory, the permission profile, sandbox settings, standard input/output rules, optional network proxy information, and environment variables. It asks the permission profile what network rules apply, builds the sandbox-helper argument list from the command and profile, chooses the correct helper startup name, then creates a child-process request. The result is either a running asynchronous child process or an operating-system error if the process could not be started.

**Call relations**: This function sits just before process launch. It gathers policy details from the permission profile, asks the sandboxing library to turn those details into command-line arguments, includes the network allowance needed for proxy support, and then hands the finished launch request to `spawn_child_async`, which performs the actual child-process creation.

*Call graph*: calls 5 internal fn (spawn_child_async, network_sandbox_policy, allow_network_for_proxy, create_linux_sandbox_command_args_for_permission_profile, as_path); 4 external calls (as_ref, file_name, to_path_buf, to_string_lossy).


### `linux-sandbox/src/landlock.rs`

`domain_logic` · `sandbox setup before running the child process`

This file is part of the moment when Codex is about to run something inside a Linux sandbox. Its job is to make sure the child process cannot quietly gain extra powers or use the network in ways the chosen permission profile forbids. Think of it like putting locks on a room before letting a tool run inside it.

The main entry point reads a permission profile and decides which protections are needed. If network access must be restricted, it first enables `no_new_privs`, a Linux promise that this process and its children cannot gain new privileges later. That promise is required before installing `seccomp`, a Linux filter that can block chosen system calls, which are the low-level requests programs make to the operating system.

For network control, the file builds a seccomp rule set. In fully restricted mode, it blocks most network operations and only allows local Unix sockets where needed for child-process coordination. In proxy-routed mode, it allows internet-style sockets only so traffic can go through a controlled local bridge, while blocking other socket families that might bypass the proxy.

There is also Landlock code for file-system permissions. Landlock is a Linux feature for limiting file access from inside a process. Here it is kept as a legacy fallback; the comments make clear that bubblewrap is the normal file-system sandbox now.

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

**Purpose**: Applies the chosen sandbox permissions to the current thread so the future child process inherits them, without locking down the whole CLI program. It decides whether to enable privilege blocking, network filtering, and the legacy Landlock file-system rules.

**Data flow**: It receives a permission profile, the current working directory, and flags saying whether to use legacy file-system Landlock and whether network traffic is proxy-controlled. It turns the profile into runtime file-system and network policies, chooses a network seccomp mode, enables `no_new_privs` if needed, installs the network filter if needed, and optionally installs Landlock write rules. It returns success, or an error if a requested sandbox mode cannot be applied.

**Call relations**: This is called by `run_main` during sandbox startup. It asks `network_seccomp_mode` what kind of network lock is needed, calls `set_no_new_privs` before applying dangerous-to-change restrictions, hands network work to `install_network_seccomp_filter_on_current_thread`, and hands legacy file-system work to `install_filesystem_landlock_rules_on_current_thread`.

*Call graph*: calls 5 internal fn (install_filesystem_landlock_rules_on_current_thread, install_network_seccomp_filter_on_current_thread, network_seccomp_mode, set_no_new_privs, to_runtime_permissions); called by 1 (run_main); 1 external calls (UnsupportedOperation).


##### `should_install_network_seccomp`  (lines 96–103)

```
fn should_install_network_seccomp(
    network_sandbox_policy: NetworkSandboxPolicy,
    allow_network_for_proxy: bool,
) -> bool
```

**Purpose**: Decides whether a seccomp network filter should be installed at all. It treats managed proxy networking as needing a fail-closed filter even when the broader policy would otherwise allow network access.

**Data flow**: It receives the network policy and a flag saying whether network is being allowed only for a proxy path. It checks whether the policy already restricts network access, or whether proxy mode still needs protection. It returns true when seccomp should be installed and false when the process can skip that filter.

**Call relations**: `network_seccomp_mode` calls this as its first decision point. It relies on the policy’s `is_enabled` check to distinguish normal full-network access from restricted access.

*Call graph*: calls 1 internal fn (is_enabled); called by 1 (network_seccomp_mode).


##### `network_seccomp_mode`  (lines 105–117)

```
fn network_seccomp_mode(
    network_sandbox_policy: NetworkSandboxPolicy,
    allow_network_for_proxy: bool,
    proxy_routed_network: bool,
) -> Option<NetworkSeccompMode>
```

**Purpose**: Chooses the exact network filtering mode to use, or chooses no filter if the policy allows normal network access. This keeps the higher-level setup code from needing to understand the detailed decision tree.

**Data flow**: It receives the network policy plus two flags: one for proxy-permitted network access and one for proxy-routed network setup. It first asks `should_install_network_seccomp` whether any filter is needed. If not, it returns no mode; if proxy routing is active, it returns proxy-routed mode; otherwise it returns restricted mode.

**Call relations**: `apply_permission_profile_to_current_thread` calls this before installing sandbox rules. This function delegates the yes-or-no decision to `should_install_network_seccomp`, then returns the mode that `install_network_seccomp_filter_on_current_thread` will later turn into kernel rules.

*Call graph*: calls 1 internal fn (should_install_network_seccomp); called by 1 (apply_permission_profile_to_current_thread).


##### `set_no_new_privs`  (lines 120–126)

```
fn set_no_new_privs() -> Result<()>
```

**Purpose**: Tells Linux that this thread and its future children may not gain new privileges. This is required before installing seccomp filters and also blocks some privilege-escalation paths such as setuid programs.

**Data flow**: It takes no ordinary input, but calls the Linux `prctl` system interface with the `PR_SET_NO_NEW_PRIVS` setting. If Linux accepts the request, it returns success. If Linux rejects it, it reads the operating system error and returns it to the caller.

**Call relations**: `apply_permission_profile_to_current_thread` calls this only when needed: before seccomp filtering or before the legacy Landlock file-system sandbox. It uses the external `prctl` call to make the change in the kernel.

*Call graph*: called by 1 (apply_permission_profile_to_current_thread); 2 external calls (last_os_error, prctl).


##### `install_filesystem_landlock_rules_on_current_thread`  (lines 137–163)

```
fn install_filesystem_landlock_rules_on_current_thread(
    writable_roots: Vec<AbsolutePathBuf>,
) -> Result<()>
```

**Purpose**: Installs legacy Landlock file-system rules that allow reading broadly but restrict writing to `/dev/null` and selected writable directories. This is kept as a backup path because normal file-system sandboxing is handled by bubblewrap.

**Data flow**: It receives a list of absolute writable roots. It builds a Landlock ruleset for read/write access types, grants read access under `/`, grants write access to `/dev/null`, adds write access for the supplied roots, and then asks Linux to restrict the current thread. It returns success if the rules are enforced, or a sandbox error if Linux reports that they were not enforced.

**Call relations**: `apply_permission_profile_to_current_thread` calls this only when legacy Landlock file-system enforcement is requested and the profile does not allow full disk writes. The function uses Landlock library helpers such as access builders and path-beneath rules to translate Codex’s writable roots into kernel restrictions.

*Call graph*: called by 1 (apply_permission_profile_to_current_thread); 5 external calls (from_all, from_read, default, path_beneath_rules, Sandbox).


##### `install_network_seccomp_filter_on_current_thread`  (lines 169–268)

```
fn install_network_seccomp_filter_on_current_thread(
    mode: NetworkSeccompMode,
) -> std::result::Result<(), SandboxErr>
```

**Purpose**: Builds and installs the Linux seccomp filter that blocks unsafe network and process-inspection system calls. This is the core network lockdown mechanism in this file.

**Data flow**: It receives a network mode. It creates a map of system calls to deny, always blocking calls such as `ptrace`, cross-process memory access, and `io_uring` setup. In restricted mode it also blocks most socket and connection calls while allowing Unix-domain sockets where needed. In proxy-routed mode it allows IP sockets for the controlled bridge but blocks other socket families. It turns those rules into a BPF program, which is the small filter program the Linux kernel understands, applies it to the current thread, and returns success or a sandbox error.

**Call relations**: `apply_permission_profile_to_current_thread` calls this after deciding that a network filter is required. Inside, it uses seccompiler builders to create rules and `apply_filter` to hand the finished filter to Linux. If the CPU architecture is unsupported, the function deliberately stops because it cannot safely build the right filter.

*Call graph*: called by 1 (apply_permission_profile_to_current_thread); 8 external calls (new, Errno, new, new, cfg!, apply_filter, unimplemented!, vec!).


##### `tests::managed_network_enforces_seccomp_even_for_full_network_policy`  (lines 279–287)

```
fn managed_network_enforces_seccomp_even_for_full_network_policy()
```

**Purpose**: Checks that managed proxy networking still installs seccomp even when the nominal network policy says network access is enabled. This protects the fail-closed behavior expected for proxy-controlled sessions.

**Data flow**: The test feeds an enabled network policy and the proxy-allowed flag into `should_install_network_seccomp`. It expects the result to be true, meaning the filter will still be installed.

**Call relations**: The Rust test runner calls this during automated tests. It directly exercises `should_install_network_seccomp`, confirming the helper’s behavior before that helper is used by `network_seccomp_mode` in real sandbox setup.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::full_network_policy_without_managed_network_skips_seccomp`  (lines 290–298)

```
fn full_network_policy_without_managed_network_skips_seccomp()
```

**Purpose**: Checks that ordinary full-network access does not install the network seccomp filter when no managed proxy is involved. This avoids unnecessarily restricting processes that are meant to have normal network access.

**Data flow**: The test passes an enabled network policy with the proxy flag set to false into `should_install_network_seccomp`. It expects false, meaning no network seccomp filter is needed.

**Call relations**: The Rust test runner calls this as part of the unit tests. It verifies the no-filter branch that `network_seccomp_mode` depends on.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::restricted_network_policy_always_installs_seccomp`  (lines 301–310)

```
fn restricted_network_policy_always_installs_seccomp()
```

**Purpose**: Checks that restricted network policies always lead to seccomp installation, whether or not proxy access is also allowed. This confirms that a restricted policy cannot accidentally skip the network lock.

**Data flow**: The test calls `should_install_network_seccomp` twice with a restricted policy: once without proxy allowance and once with it. Both calls must return true.

**Call relations**: The Rust test runner invokes this test. It covers the restricted-policy path used by `network_seccomp_mode` before the main sandbox setup installs a filter.

*Call graph*: 1 external calls (assert!).


##### `tests::managed_proxy_routes_use_proxy_routed_seccomp_mode`  (lines 313–322)

```
fn managed_proxy_routes_use_proxy_routed_seccomp_mode()
```

**Purpose**: Checks that managed proxy routing selects the special proxy-routed seccomp mode. This matters because proxy-routed mode allows only the socket behavior needed to reach the controlled network bridge.

**Data flow**: The test passes an enabled network policy, proxy allowance, and proxy routing into `network_seccomp_mode`. It expects the returned mode to be `ProxyRouted`.

**Call relations**: The Rust test runner calls this test. It verifies the mode that `apply_permission_profile_to_current_thread` would later pass to `install_network_seccomp_filter_on_current_thread`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::restricted_network_without_proxy_routing_uses_restricted_mode`  (lines 325–334)

```
fn restricted_network_without_proxy_routing_uses_restricted_mode()
```

**Purpose**: Checks that a restricted network policy without proxy routing chooses the normal restricted seccomp mode. This confirms the default lockdown path.

**Data flow**: The test passes a restricted policy with both proxy-related flags false into `network_seccomp_mode`. It expects `Restricted` as the chosen mode.

**Call relations**: The Rust test runner invokes this test. It confirms the ordinary restricted path that leads from `network_seccomp_mode` into the restricted branch of `install_network_seccomp_filter_on_current_thread`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::full_network_without_managed_proxy_skips_network_seccomp_mode`  (lines 337–346)

```
fn full_network_without_managed_proxy_skips_network_seccomp_mode()
```

**Purpose**: Checks that full network access without managed proxy routing produces no seccomp mode. This protects the intended behavior that unrestricted network sessions are not filtered by this code.

**Data flow**: The test passes an enabled network policy with proxy allowance and proxy routing both false into `network_seccomp_mode`. It expects no mode to be returned.

**Call relations**: The Rust test runner calls this test. It verifies the branch where `apply_permission_profile_to_current_thread` receives no network mode and therefore does not call `install_network_seccomp_filter_on_current_thread`.

*Call graph*: 1 external calls (assert_eq!).


### `linux-sandbox/src/bwrap.rs`

`domain_logic` · `sandbox setup before command execution`

This file is the Linux filesystem-sandbox builder. Before the program runs a requested command, it decides whether Bubblewrap is needed and, if so, writes the list of Bubblewrap flags that create the safe environment. Bubblewrap works a bit like setting up a stage set before an actor walks on: the process sees mounted copies, empty placeholders, and hidden areas rather than the host filesystem directly.

The main job is to translate a high-level filesystem policy into precise mount rules. It can start from a read-only copy of the whole machine, or from an almost empty filesystem with only approved readable roots added back. Then it layers writable roots on top. After that, it re-applies protected read-only and unreadable subpaths so a broad writable directory does not accidentally make `.git`, secrets, or denied folders writable.

The file also handles awkward real-world cases: missing paths that Bubblewrap still needs as mount targets, symlinks that could otherwise bypass protections, unreadable glob patterns expanded with `ripgrep`, and optional network isolation. It records temporary synthetic mount targets so later cleanup code can safely remove only placeholders it created, not real user files.

#### Function details

##### `BwrapOptions::default`  (lines 76–82)

```
fn default() -> Self
```

**Purpose**: Provides the normal Bubblewrap settings used when callers do not ask for anything special. By default it mounts a fresh `/proc`, keeps normal network access, and does not limit glob scanning depth.

**Data flow**: No input is needed. It creates a `BwrapOptions` value with safe, compatibility-focused defaults, then returns it to the caller.

**Call relations**: Tests call this to confirm the defaults and to build sandbox requests without spelling out every option. Production setup can also rely on these defaults before passing options into `create_bwrap_command_args`.

*Call graph*: called by 2 (full_disk_write_with_unreadable_glob_still_wraps_and_masks_match, restricted_policy_chdirs_to_canonical_command_cwd).


##### `BwrapNetworkMode::should_unshare_network`  (lines 101–103)

```
fn should_unshare_network(self) -> bool
```

**Purpose**: Answers whether Bubblewrap should put the sandboxed command in a separate network namespace. A network namespace is a separate view of networking, used here to cut off or proxy network access.

**Data flow**: It receives a network mode. It checks whether the mode is anything other than full access, and returns `true` for isolated or proxy-only modes and `false` for full access.

**Call relations**: The command-building functions ask this before adding Bubblewrap's network isolation flag. This keeps the network decision in one small place.

*Call graph*: 1 external calls (matches!).


##### `FileIdentity::from_metadata`  (lines 121–126)

```
fn from_metadata(metadata: &Metadata) -> Self
```

**Purpose**: Captures the stable identity of a file or directory from filesystem metadata. It uses the device and inode numbers, which together identify a filesystem object on Unix-like systems.

**Data flow**: It receives metadata read from the filesystem. It copies out the device number and inode number, then returns a small identity record.

**Call relations**: Synthetic mount target constructors use this when remembering a pre-existing empty path. Later `SyntheticMountTarget::should_remove_after_bwrap` compares identities so cleanup does not delete a real file that was already there.

*Call graph*: called by 3 (existing_empty_directory, existing_empty_file, should_remove_after_bwrap); 2 external calls (dev, ino).


##### `ProtectedCreateTarget::missing`  (lines 150–154)

```
fn missing(path: &Path) -> Self
```

**Purpose**: Records a protected path that did not exist before sandbox startup but must not be created by the sandboxed process. This is used for special metadata paths where a placeholder mount is not always appropriate.

**Data flow**: It receives a path, copies it into an owned path buffer, and returns a `ProtectedCreateTarget` holding that path.

**Call relations**: The filesystem builder calls this when a missing protected metadata path should be watched for creation. Cleanup code elsewhere later uses the record to remove or report forbidden creations.

*Call graph*: called by 3 (append_protected_create_targets_for_writable_root, cleanup_protected_create_targets_removes_created_path_and_reports_violation, cleanup_protected_create_targets_waits_for_other_active_registrations); 1 external calls (to_path_buf).


##### `ProtectedCreateTarget::path`  (lines 156–158)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the protected path stored in a `ProtectedCreateTarget`. Callers use it when checking or cleaning up a path after Bubblewrap has run.

**Data flow**: It reads the path field from the target and returns a borrowed reference to it. Nothing is changed.

**Call relations**: Cleanup code calls this through `try_remove_protected_create_target` to know exactly which path to inspect.

*Call graph*: called by 1 (try_remove_protected_create_target).


##### `SyntheticMountTarget::missing`  (lines 162–168)

```
fn missing(path: &Path) -> Self
```

**Purpose**: Describes a missing file path that the sandbox will temporarily cover with an empty file mount. This prevents the sandboxed command from creating that protected path.

**Data flow**: It receives a path, copies it, marks the target as an empty file, records that nothing existed there before, and returns the target record.

**Call relations**: The mount-argument builder creates these records when it masks missing protected files. Cleanup code later uses the record to decide whether a temporary placeholder can be removed.

*Call graph*: called by 4 (append_missing_empty_file_bind_data_args, cleanup_synthetic_mount_targets_removes_only_empty_mount_targets, cleanup_synthetic_mount_targets_removes_transient_file_after_concurrent_owner_exits, cleanup_synthetic_mount_targets_waits_for_other_active_registrations); 1 external calls (to_path_buf).


##### `SyntheticMountTarget::missing_empty_directory`  (lines 170–176)

```
fn missing_empty_directory(path: &Path) -> Self
```

**Purpose**: Describes a missing directory path that the sandbox will temporarily cover with an empty read-only directory. This is mainly used for protected metadata directory names.

**Data flow**: It receives a path, copies it, marks the target as an empty directory, records that it did not pre-exist, and returns the target record.

**Call relations**: Read-only subpath handling calls this when a missing protected metadata name needs to appear as an empty directory inside the sandbox. Cleanup later treats it as a synthetic directory.

*Call graph*: called by 2 (append_missing_read_only_subpath_args, cleanup_synthetic_mount_targets_removes_only_empty_mount_targets); 1 external calls (to_path_buf).


##### `SyntheticMountTarget::existing_empty_file`  (lines 178–184)

```
fn existing_empty_file(path: &Path, metadata: &Metadata) -> Self
```

**Purpose**: Describes an already existing empty file that is being used as a temporary protected mount target. It remembers the file's identity so cleanup will not remove it by mistake.

**Data flow**: It receives a path and metadata, copies the path, extracts the file identity from metadata, and returns a target marked as an empty file with a pre-existing identity.

**Call relations**: The read-only subpath code uses this when it sees a transient empty protected file. Cleanup compares the stored identity with current metadata before deciding whether removal is safe.

*Call graph*: calls 1 internal fn (from_metadata); called by 3 (append_existing_empty_file_bind_data_args, cleanup_synthetic_mount_targets_preserves_real_pre_existing_empty_file, cleanup_synthetic_mount_targets_removes_transient_file_after_concurrent_owner_exits); 1 external calls (to_path_buf).


##### `SyntheticMountTarget::existing_empty_directory`  (lines 186–192)

```
fn existing_empty_directory(path: &Path, metadata: &Metadata) -> Self
```

**Purpose**: Describes an already existing empty directory that is being reused as a read-only placeholder. It records the directory identity to protect real pre-existing content from cleanup.

**Data flow**: It receives a path and metadata, copies the path, extracts identity information, and returns a target marked as an empty directory.

**Call relations**: The existing-empty-directory mount helper calls this after adding Bubblewrap flags. Cleanup later uses the record to avoid deleting a directory that was not created by this sandbox setup.

*Call graph*: calls 1 internal fn (from_metadata); called by 1 (append_existing_empty_directory_args); 1 external calls (to_path_buf).


##### `SyntheticMountTarget::preserves_pre_existing_path`  (lines 194–196)

```
fn preserves_pre_existing_path(&self) -> bool
```

**Purpose**: Tells whether this synthetic target represents something that already existed before Bubblewrap setup. That matters because pre-existing paths deserve extra care during cleanup.

**Data flow**: It reads whether a stored pre-existing identity is present and returns a boolean. It does not touch the filesystem.

**Call relations**: Marker-writing cleanup support uses this to record whether a target was preserving an existing path.

*Call graph*: called by 1 (synthetic_mount_marker_contents).


##### `SyntheticMountTarget::path`  (lines 198–200)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the filesystem path for a synthetic mount target. Cleanup code uses it to find the placeholder after the sandbox exits.

**Data flow**: It reads the target's stored path and returns it by reference. Nothing is modified.

**Call relations**: The removal path calls this before inspecting or deleting a synthetic mount target.

*Call graph*: called by 1 (remove_synthetic_mount_target).


##### `SyntheticMountTarget::kind`  (lines 202–204)

```
fn kind(&self) -> SyntheticMountTargetKind
```

**Purpose**: Returns whether the synthetic target is an empty file or an empty directory. Cleanup needs this so it can apply the right safety checks.

**Data flow**: It reads the target's kind field and returns that value. No filesystem access happens.

**Call relations**: Synthetic-target cleanup calls this while deciding how to remove a placeholder.

*Call graph*: called by 1 (remove_synthetic_mount_target).


##### `SyntheticMountTarget::should_remove_after_bwrap`  (lines 206–224)

```
fn should_remove_after_bwrap(&self, metadata: &Metadata) -> bool
```

**Purpose**: Decides whether a synthetic placeholder is safe to remove after Bubblewrap finishes. It prevents cleanup from deleting real user files or directories.

**Data flow**: It receives current metadata for the path. It first checks that the path still looks like the expected empty file or directory, then compares identity information if the path existed before; it returns `true` only when removal is safe.

**Call relations**: Cleanup code calls this before deleting synthetic mount targets. It relies on `FileIdentity::from_metadata` to recognize whether the current path is still the same pre-existing object.

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

**Purpose**: This is the main public builder for Bubblewrap command arguments. It decides whether to leave the command alone or wrap it with filesystem and network sandbox flags.

**Data flow**: It receives the command, the filesystem policy, two working-directory paths, and Bubblewrap options. It checks for full disk write access and unreadable glob rules, then either returns the original command, builds a full-filesystem network wrapper, or builds the full sandbox argument list.

**Call relations**: Higher-level command launch code calls this through `build_bwrap_argv`. It delegates to `create_bwrap_flags_full_filesystem` for network-only wrapping and to `create_bwrap_flags` for real filesystem sandboxing.

*Call graph*: calls 4 internal fn (create_bwrap_flags, create_bwrap_flags_full_filesystem, get_unreadable_globs_with_cwd, has_full_disk_write_access); called by 5 (full_disk_write_full_network_returns_unwrapped_command, full_disk_write_proxy_only_keeps_full_filesystem_but_unshares_network, full_disk_write_with_unreadable_glob_still_wraps_and_masks_match, restricted_policy_chdirs_to_canonical_command_cwd, build_bwrap_argv); 1 external calls (new).


##### `create_bwrap_flags_full_filesystem`  (lines 267–294)

```
fn create_bwrap_flags_full_filesystem(command: Vec<String>, options: BwrapOptions) -> BwrapArgs
```

**Purpose**: Builds Bubblewrap flags for the case where the process should still see and write the full filesystem but needs Bubblewrap for namespace setup, especially network isolation.

**Data flow**: It receives the original command and options. It creates flags that bind `/` to `/`, set up process/user namespaces, optionally isolate networking and mount `/proc`, then appends the command.

**Call relations**: Only `create_bwrap_command_args` calls this, when disk access is unrestricted but network isolation or proxy-only mode still requires Bubblewrap.

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

**Purpose**: Builds the complete Bubblewrap argument list for a sandboxed command. It combines filesystem mounts, process isolation, optional network isolation, `/proc`, and the command itself.

**Data flow**: It receives the command, policy, working directories, and options. It asks `create_filesystem_args` for mount rules, normalizes the command working directory if needed, adds namespace and runtime flags, then returns all arguments plus cleanup records.

**Call relations**: This is called by `create_bwrap_command_args` for restricted filesystem cases. It hands most mount complexity to `create_filesystem_args` and uses helpers to format paths safely.

*Call graph*: calls 3 internal fn (create_filesystem_args, normalize_command_cwd_for_bwrap, path_to_string); called by 1 (create_bwrap_command_args); 1 external calls (new).


##### `create_filesystem_args`  (lines 367–630)

```
fn create_filesystem_args(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
    glob_scan_max_depth: Option<usize>,
) -> Result<BwrapArgs>
```

**Purpose**: Translates a filesystem sandbox policy into Bubblewrap mount flags. This is the heart of the file: it decides what is readable, writable, hidden, or protected.

**Data flow**: It reads writable roots, readable roots, denied roots, unreadable glob matches, protected metadata names, and the current working directory. It builds a carefully ordered list of Bubblewrap mount operations and records any temporary mount targets or protected missing paths that cleanup must know about.

**Call relations**: `create_bwrap_flags` calls this before adding non-filesystem Bubblewrap flags. It coordinates many smaller helpers for symlink resolution, glob expansion, read-only carveouts, unreadable masks, missing path placeholders, and metadata protections.

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

**Purpose**: Records missing protected metadata paths that should not be created under a writable root. This covers cases where mounting an empty placeholder would interfere with parent repository discovery.

**Data flow**: It receives the current Bubblewrap result, protected names, a root path, an optional symlink target, and read-only subpaths. For each protected name, it computes the effective path and, if it is missing and not already mounted read-only, adds a protected-create record.

**Call relations**: `create_filesystem_args` calls this while processing each writable root. It uses `ProtectedCreateTarget::missing` to create records that cleanup code later enforces.

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

**Purpose**: Adds protected metadata names, such as `.git`, `.agents`, and `.codex`, to the list of paths that must stay read-only under a writable root. This keeps repository and agent metadata from becoming writable just because the project root is writable.

**Data flow**: It receives a mutable list of read-only subpaths, the logical root, the actual mount root, and protected names. For each name, it decides whether to add the root/name path, except for a special missing `.git` case used for parent repository discovery.

**Call relations**: `create_filesystem_args` calls this before applying read-only subpath mounts. It asks `should_leave_missing_git_for_parent_repo_discovery` whether a missing child `.git` should be left absent instead of masked.

*Call graph*: calls 1 internal fn (should_leave_missing_git_for_parent_repo_discovery); called by 1 (create_filesystem_args); 1 external calls (join).


##### `should_leave_missing_git_for_parent_repo_discovery`  (lines 672–683)

```
fn should_leave_missing_git_for_parent_repo_discovery(mount_root: &Path, name: &str) -> bool
```

**Purpose**: Decides whether a missing `.git` under a writable root should remain missing so Git can discover a parent repository. Without this, an empty `.git` placeholder could hide the real repository above it.

**Data flow**: It receives the effective mount root and a metadata name. It checks that the name is `.git`, that the `.git` path is missing, and that some ancestor has Git metadata; it returns `true` only in that case.

**Call relations**: `append_metadata_path_masks_for_writable_root` calls this before adding `.git` to read-only masks. It uses `ancestor_has_git_metadata` as the ancestor check.

*Call graph*: called by 1 (append_metadata_path_masks_for_writable_root); 3 external calls (ancestors, join, matches!).


##### `ancestor_has_git_metadata`  (lines 685–698)

```
fn ancestor_has_git_metadata(ancestor: &Path) -> bool
```

**Purpose**: Checks whether a directory appears to contain Git repository metadata. It recognizes both normal `.git` directories and `.git` files that point to another Git directory.

**Data flow**: It receives an ancestor path. It looks for `.git`; if it is a directory, it checks for `HEAD`, and if it is a file, it checks whether the file starts with `gitdir:`; it returns a boolean.

**Call relations**: It is used during the missing-child-`.git` decision so the sandbox does not accidentally block Git's normal walk up to a parent repository.

*Call graph*: 2 external calls (join, read_to_string).


##### `expand_unreadable_globs_with_ripgrep`  (lines 700–744)

```
fn expand_unreadable_globs_with_ripgrep(
    patterns: &[String],
    cwd: &Path,
    max_depth: Option<usize>,
) -> Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Turns deny-read glob patterns into concrete paths that Bubblewrap can mask. Bubblewrap cannot directly understand globs, so the code must find current matching files before launch.

**Data flow**: It receives glob patterns, a working directory, and an optional depth limit. It groups patterns by safe search roots, runs `ripgrep_files`, adds symlink targets when needed, enforces a maximum match count, and returns absolute matching paths.

**Call relations**: `create_filesystem_args` calls this before building unreadable masks. It delegates pattern splitting to `split_pattern_for_ripgrep` and actual scanning to `ripgrep_files`.

*Call graph*: calls 4 internal fn (canonical_target_if_symlinked_path, ripgrep_files, split_pattern_for_ripgrep, from_absolute_path_checked); called by 1 (create_filesystem_args); 5 external calls (new, new, new, format!, Fatal).


##### `split_pattern_for_ripgrep`  (lines 746–773)

```
fn split_pattern_for_ripgrep(pattern: &str, cwd: &Path) -> Option<(AbsolutePathBuf, String)>
```

**Purpose**: Splits a glob pattern into a directory to search and a glob expression for ripgrep. This avoids scanning from `/`, which would be too broad and slow during sandbox startup.

**Data flow**: It receives a pattern and a base directory. It resolves relative patterns to absolute form, finds the first glob character, chooses the static prefix as the search root, escapes unclosed bracket syntax, and returns the pair when safe.

**Call relations**: `expand_unreadable_globs_with_ripgrep` calls this for each deny-read glob. A test also calls it directly to check unclosed bracket handling.

*Call graph*: calls 3 internal fn (escape_unclosed_glob_classes, from_absolute_path_checked, resolve_path_against_base); called by 2 (expand_unreadable_globs_with_ripgrep, unclosed_character_classes_are_escaped_for_ripgrep); 1 external calls (from).


##### `escape_unclosed_glob_classes`  (lines 775–808)

```
fn escape_unclosed_glob_classes(glob: &str) -> String
```

**Purpose**: Makes glob text acceptable to ripgrep when the policy treats an unmatched `[` as a literal character. Ripgrep would otherwise reject that pattern as invalid syntax.

**Data flow**: It receives a glob string, walks through its characters, and escapes only bracket openings that never close. It returns the adjusted glob string.

**Call relations**: `split_pattern_for_ripgrep` calls this just before handing a glob to ripgrep.

*Call graph*: called by 1 (split_pattern_for_ripgrep); 2 external calls (new, with_capacity).


##### `ripgrep_files`  (lines 810–875)

```
fn ripgrep_files(
    search_root: &Path,
    globs: &[String],
    max_depth: Option<usize>,
) -> Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Uses `rg --files` to find files matching one or more glob patterns under a search root. It includes hidden and ignored files so deny-read rules do not miss secrets hidden by ignore files.

**Data flow**: It receives a search root, globs, and an optional maximum depth. It runs ripgrep with null-separated output, converts each result to an absolute path, returns no matches for ripgrep's normal no-match status, and falls back to an internal walker if ripgrep is not installed.

**Call relations**: `expand_unreadable_globs_with_ripgrep` calls this for each grouped search root. On missing `rg`, it calls `glob_files`; on other scan errors, it reports a fatal sandbox-construction error.

*Call graph*: calls 1 internal fn (glob_files); called by 1 (expand_unreadable_globs_with_ripgrep); 5 external calls (from_utf8_lossy, new, new, format!, Fatal).


##### `glob_files`  (lines 877–906)

```
fn glob_files(
    search_root: &Path,
    globs: &[String],
    max_depth: Option<usize>,
) -> Result<Vec<AbsolutePathBuf>>
```

**Purpose**: Provides an internal fallback file scanner when ripgrep is not available. It applies the same glob rules closely enough that deny-read masks are still built.

**Data flow**: It receives a search root, glob strings, and an optional depth limit. It builds a `GlobSet` matcher, walks the tree through `collect_glob_files`, and returns matching absolute paths.

**Call relations**: `ripgrep_files` calls this only when launching `rg` fails because the program is not installed.

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

**Purpose**: Walks directories and collects files or symlinks that match the compiled glob set. It is the recursive worker behind the ripgrep fallback.

**Data flow**: It receives the search root, current directory, compiled matcher, remaining depth, and an output list. It reads directory entries, adds matching files and symlinks, recurses into real directories while respecting depth, and updates the output list.

**Call relations**: `glob_files` calls this after building the glob matcher. It does the actual filesystem traversal.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); called by 1 (glob_files); 2 external calls (is_match, read_dir).


##### `path_to_string`  (lines 938–940)

```
fn path_to_string(path: &Path) -> String
```

**Purpose**: Converts a filesystem path into a string suitable for Bubblewrap arguments. It uses a lossy conversion so unusual bytes do not crash argument building.

**Data flow**: It receives a path reference, converts it to displayable string form, and returns the string.

**Call relations**: Many argument-building helpers call this whenever they need to place a path into the Bubblewrap argument vector. Tests also use it to compare expected arguments.

*Call graph*: called by 29 (append_empty_directory_args, append_empty_file_bind_data_args, append_existing_unreadable_path_args, append_mount_target_parent_dir_args, append_read_only_subpath_args, create_bwrap_flags, create_filesystem_args, assert_empty_directory_mounted_read_only, assert_empty_file_bound_without_perms, assert_file_masked (+15 more)); 1 external calls (to_string_lossy).


##### `path_depth`  (lines 942–944)

```
fn path_depth(path: &Path) -> usize
```

**Purpose**: Measures how deep a path is by counting its components. This helps apply mount rules from parent paths before child paths.

**Data flow**: It receives a path, counts its components, and returns that count as a number.

**Call relations**: `create_filesystem_args` and unreadable-path helpers use it for sorting, so nested mount rules are added in a safe order.

*Call graph*: 1 external calls (components).


##### `canonical_target_if_symlinked_path`  (lines 946–980)

```
fn canonical_target_if_symlinked_path(path: &Path) -> Option<PathBuf>
```

**Purpose**: Finds the real target of a path only when some part of that path goes through a symbolic link. A symbolic link is a filesystem shortcut that can point somewhere else.

**Data flow**: It receives a path and walks each component, checking for symlinks. If it finds one, it canonicalizes the full path and returns the real target when different; otherwise it returns nothing.

**Call relations**: `create_filesystem_args` uses this to bind and mask real locations for symlinked writable roots. Glob expansion also uses it so symlink matches cannot bypass deny-read masks.

*Call graph*: called by 2 (create_filesystem_args, expand_unreadable_globs_with_ripgrep); 5 external calls (components, new, new, canonicalize, symlink_metadata).


##### `remap_paths_for_symlink_target`  (lines 982–993)

```
fn remap_paths_for_symlink_target(paths: Vec<PathBuf>, root: &Path, target: &Path) -> Vec<PathBuf>
```

**Purpose**: Rewrites paths under a logical symlinked root so they point under the real target instead. This keeps protections aligned with the actual mount location.

**Data flow**: It receives a list of paths, the original root, and the real target. For each path under the original root, it replaces that prefix with the target; other paths pass through unchanged.

**Call relations**: `create_filesystem_args` calls this after detecting that a writable root is symlinked, before applying read-only or unreadable carveouts.

*Call graph*: called by 1 (create_filesystem_args).


##### `normalize_command_cwd_for_bwrap`  (lines 995–999)

```
fn normalize_command_cwd_for_bwrap(command_cwd: &Path) -> PathBuf
```

**Purpose**: Turns the command's working directory into its canonical, real path when possible. This avoids starting inside a symlink name that may not exist in Bubblewrap's mounted view.

**Data flow**: It receives the command working directory. It tries to canonicalize it and returns the real path, or the original path if canonicalization fails.

**Call relations**: `create_bwrap_flags` calls this before optionally adding a Bubblewrap `--chdir` flag.

*Call graph*: called by 1 (create_bwrap_flags); 1 external calls (canonicalize).


##### `append_mount_target_parent_dir_args`  (lines 1001–1019)

```
fn append_mount_target_parent_dir_args(args: &mut Vec<String>, mount_target: &Path, anchor: &Path)
```

**Purpose**: Adds Bubblewrap instructions to create parent directories needed for a later mount target. This is needed when a parent was masked and the child must be reopened.

**Data flow**: It receives the argument list, the desired mount target, and an anchor path where creation should stop. It walks the target's ancestor directories, orders them from top to bottom, and appends `--dir` flags.

**Call relations**: `create_filesystem_args` and `append_existing_unreadable_path_args` call this when writable children must be mounted inside an otherwise hidden or read-only parent.

*Call graph*: calls 1 internal fn (path_to_string); called by 2 (append_existing_unreadable_path_args, create_filesystem_args); 2 external calls (is_dir, parent).


##### `append_read_only_subpath_args`  (lines 1021–1072)

```
fn append_read_only_subpath_args(
    bwrap_args: &mut BwrapArgs,
    subpath: &Path,
    allowed_write_paths: &[PathBuf],
) -> Result<()>
```

**Purpose**: Adds Bubblewrap rules that make one subpath read-only inside an otherwise writable area. It also handles missing protected paths safely.

**Data flow**: It receives the current Bubblewrap result, a subpath, and allowed writable paths. It rejects unsafe writable symlink crossings, detects transient empty metadata placeholders, masks missing first components, or adds a read-only bind for existing paths.

**Call relations**: `create_filesystem_args` calls this for each protected read-only subpath under a writable root. It delegates to missing, existing-empty-file, and existing-empty-directory helpers depending on what it finds.

*Call graph*: calls 8 internal fn (append_existing_empty_directory_args, append_existing_empty_file_bind_data_args, append_missing_read_only_subpath_args, find_first_non_existent_component, first_writable_symlink_component_in_path, is_within_allowed_write_paths, path_to_string, transient_empty_metadata_path); called by 1 (create_filesystem_args); 3 external calls (exists, format!, Fatal).


##### `append_empty_file_bind_data_args`  (lines 1074–1083)

```
fn append_empty_file_bind_data_args(bwrap_args: &mut BwrapArgs, path: &Path) -> Result<()>
```

**Purpose**: Adds Bubblewrap flags that mount an empty read-only file at a path, using `/dev/null` as the file data source. This is how the sandbox blocks creation or reading of protected file paths.

**Data flow**: It receives the Bubblewrap result and target path. It opens and preserves `/dev/null` if needed, appends `--ro-bind-data` with that file descriptor and the target path, and updates the arguments.

**Call relations**: Several higher-level helpers call this when masking missing files, existing empty files, or unreadable files.

*Call graph*: calls 1 internal fn (path_to_string); called by 3 (append_existing_empty_file_bind_data_args, append_existing_unreadable_path_args, append_missing_empty_file_bind_data_args); 1 external calls (open).


##### `append_empty_directory_args`  (lines 1085–1092)

```
fn append_empty_directory_args(bwrap_args: &mut BwrapArgs, path: &Path)
```

**Purpose**: Adds Bubblewrap flags that create an empty directory, make it searchable/readable, and then remount it read-only. This is used for protected metadata directories.

**Data flow**: It receives the Bubblewrap result and target path. It appends permission, temporary filesystem, and read-only remount flags for that path.

**Call relations**: Missing and existing empty-directory helpers call this when a protected directory placeholder is needed.

*Call graph*: calls 1 internal fn (path_to_string); called by 2 (append_existing_empty_directory_args, append_missing_read_only_subpath_args).


##### `append_missing_read_only_subpath_args`  (lines 1094–1104)

```
fn append_missing_read_only_subpath_args(bwrap_args: &mut BwrapArgs, path: &Path) -> Result<()>
```

**Purpose**: Adds protection for a read-only subpath that does not currently exist. It blocks the sandboxed process from creating that path.

**Data flow**: It receives the Bubblewrap result and missing path. If the final name is a protected metadata name, it creates an empty read-only directory record; otherwise it mounts an empty file placeholder and records it.

**Call relations**: `append_read_only_subpath_args` calls this after finding the first missing path component under a writable area.

*Call graph*: calls 3 internal fn (missing_empty_directory, append_empty_directory_args, append_missing_empty_file_bind_data_args); called by 1 (append_read_only_subpath_args); 1 external calls (file_name).


##### `append_missing_empty_file_bind_data_args`  (lines 1106–1112)

```
fn append_missing_empty_file_bind_data_args(bwrap_args: &mut BwrapArgs, path: &Path) -> Result<()>
```

**Purpose**: Masks a missing path with an empty file and records that the path is synthetic. This lets cleanup later remove only the placeholder if it appears on the host.

**Data flow**: It receives the Bubblewrap result and path. It appends empty-file bind-data flags, then adds a `SyntheticMountTarget` for the missing file path.

**Call relations**: Read-only and unreadable-path handling call this whenever a missing non-directory path must be blocked.

*Call graph*: calls 2 internal fn (missing, append_empty_file_bind_data_args); called by 2 (append_missing_read_only_subpath_args, append_unreadable_root_args).


##### `append_existing_empty_file_bind_data_args`  (lines 1114–1124)

```
fn append_existing_empty_file_bind_data_args(
    bwrap_args: &mut BwrapArgs,
    path: &Path,
    metadata: &Metadata,
) -> Result<()>
```

**Purpose**: Masks an existing empty protected file without treating it as a permanent source file. It records the file identity so cleanup can preserve genuine pre-existing files.

**Data flow**: It receives the Bubblewrap result, path, and metadata. It appends empty-file bind-data flags, then records a synthetic target that remembers the existing file identity.

**Call relations**: `append_read_only_subpath_args` calls this when it detects an existing empty protected metadata file.

*Call graph*: calls 2 internal fn (existing_empty_file, append_empty_file_bind_data_args); called by 1 (append_read_only_subpath_args).


##### `append_existing_empty_directory_args`  (lines 1126–1137)

```
fn append_existing_empty_directory_args(
    bwrap_args: &mut BwrapArgs,
    path: &Path,
    metadata: &Metadata,
)
```

**Purpose**: Masks an existing empty protected directory with an empty read-only directory mount while remembering its identity. This avoids deleting a real empty directory after the run.

**Data flow**: It receives the Bubblewrap result, path, and metadata. It appends empty-directory mount flags, then records a synthetic target with the directory identity.

**Call relations**: `append_read_only_subpath_args` calls this when it detects an existing empty protected metadata directory.

*Call graph*: calls 2 internal fn (existing_empty_directory, append_empty_directory_args); called by 1 (append_read_only_subpath_args).


##### `append_unreadable_root_args`  (lines 1139–1171)

```
fn append_unreadable_root_args(
    bwrap_args: &mut BwrapArgs,
    unreadable_root: &Path,
    allowed_write_paths: &[PathBuf],
) -> Result<()>
```

**Purpose**: Adds Bubblewrap rules that make a path unreadable. It also handles missing denied paths so the sandboxed process cannot create them later.

**Data flow**: It receives the Bubblewrap result, the denied path, and writable roots. It rejects unsafe writable symlink crossings, masks the first missing component when needed, or delegates existing-path masking to `append_existing_unreadable_path_args`.

**Call relations**: `create_filesystem_args` calls this for unreadable ancestors, nested unreadable carveouts, and unrelated denied roots.

*Call graph*: calls 5 internal fn (append_existing_unreadable_path_args, append_missing_empty_file_bind_data_args, find_first_non_existent_component, first_writable_symlink_component_in_path, is_within_allowed_write_paths); called by 1 (create_filesystem_args); 3 external calls (exists, format!, Fatal).


##### `append_existing_unreadable_path_args`  (lines 1173–1215)

```
fn append_existing_unreadable_path_args(
    bwrap_args: &mut BwrapArgs,
    unreadable_root: &Path,
    allowed_write_paths: &[PathBuf],
) -> Result<()>
```

**Purpose**: Masks a denied path that already exists. Directories become empty temporary mounts with no access, while files are replaced by an unreadable empty file mount.

**Data flow**: It receives the Bubblewrap result, an existing denied path, and writable roots. If the path is a directory, it chooses permissions that either hide it fully or allow traversal to reopened writable children, creates needed child mount targets, and remounts it read-only. If it is a file, it adds a `000` empty-file bind.

**Call relations**: `append_unreadable_root_args` calls this once it knows the denied path exists. It uses `append_mount_target_parent_dir_args` for writable descendants.

*Call graph*: calls 3 internal fn (append_empty_file_bind_data_args, append_mount_target_parent_dir_args, path_to_string); called by 1 (append_unreadable_root_args); 2 external calls (is_dir, iter).


##### `is_within_allowed_write_paths`  (lines 1218–1222)

```
fn is_within_allowed_write_paths(path: &Path, allowed_write_paths: &[PathBuf]) -> bool
```

**Purpose**: Checks whether a path lies inside any writable root. This is a basic safety question used before allowing or blocking certain mount tricks.

**Data flow**: It receives a path and a list of writable roots. It returns `true` if the path starts with any writable root, otherwise `false`.

**Call relations**: Read-only, unreadable, and symlink-safety helpers call this to decide whether a path can be changed by the sandboxed process.

*Call graph*: called by 3 (append_read_only_subpath_args, append_unreadable_root_args, first_writable_symlink_component_in_path); 1 external calls (iter).


##### `transient_empty_metadata_path`  (lines 1229–1244)

```
fn transient_empty_metadata_path(path: &Path) -> Option<EmptyProtectedMetadataPath>
```

**Purpose**: Detects an empty protected metadata path that may have been left by another concurrent sandbox setup. This prevents the code from treating that temporary placeholder as real user data.

**Data flow**: It receives a path. If the filename is protected, it reads metadata and returns whether the path is an empty file or empty directory; otherwise it returns nothing.

**Call relations**: `append_read_only_subpath_args` calls this before deciding how to mount a protected metadata path.

*Call graph*: calls 1 internal fn (directory_is_empty); called by 1 (append_read_only_subpath_args); 4 external calls (file_name, symlink_metadata, Directory, File).


##### `directory_is_empty`  (lines 1246–1251)

```
fn directory_is_empty(path: &Path) -> bool
```

**Purpose**: Checks whether a directory contains no entries. It is a small safety check for deciding if an existing protected metadata directory is only a placeholder.

**Data flow**: It receives a path, tries to read the directory, and returns `true` only if reading succeeds and no first entry exists.

**Call relations**: `transient_empty_metadata_path` calls this when evaluating protected metadata directories.

*Call graph*: called by 1 (transient_empty_metadata_path); 1 external calls (read_dir).


##### `first_writable_symlink_component_in_path`  (lines 1253–1294)

```
fn first_writable_symlink_component_in_path(
    target_path: &Path,
    allowed_write_paths: &[PathBuf],
) -> Option<PathBuf>
```

**Purpose**: Finds the first symlink in a path that lives under a writable root. Such symlinks are unsafe for enforcement because the sandboxed process could change where they point.

**Data flow**: It receives a target path and writable roots. It walks the path one component at a time, reads symlink metadata, and returns the first symlink path that is inside a writable root, or nothing.

**Call relations**: Read-only and unreadable mask builders call this before enforcing a path. If it finds a risky symlink, those builders fail closed with an error instead of creating a weak sandbox.

*Call graph*: calls 1 internal fn (is_within_allowed_write_paths); called by 2 (append_read_only_subpath_args, append_unreadable_root_args); 4 external calls (components, new, new, symlink_metadata).


##### `find_first_non_existent_component`  (lines 1300–1325)

```
fn find_first_non_existent_component(target_path: &Path) -> Option<PathBuf>
```

**Purpose**: Finds the earliest missing component in a path. Masking that first missing component stops the sandboxed process from creating the protected path hierarchy.

**Data flow**: It receives a target path and walks it from root to leaf. As soon as a component does not exist, it returns that component path; if all exist, it returns nothing.

**Call relations**: Read-only and unreadable mask builders use this when the exact protected path is missing.

*Call graph*: called by 2 (append_read_only_subpath_args, append_unreadable_root_args); 3 external calls (components, new, new).


##### `tests::default_unreadable_glob_scan_has_no_depth_cap`  (lines 1343–1345)

```
fn default_unreadable_glob_scan_has_no_depth_cap()
```

**Purpose**: Checks that the default options do not limit unreadable glob scanning depth. This protects the expected behavior that deeply nested deny-read matches are found.

**Data flow**: It creates default options, reads the glob depth setting, and asserts that it is `None`.

**Call relations**: This test guards `BwrapOptions::default`, which is used by sandbox argument construction.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::unreadable_glob_entry`  (lines 1347–1352)

```
fn unreadable_glob_entry(pattern: String) -> FileSystemSandboxEntry
```

**Purpose**: Creates a test policy entry that denies access to a glob pattern. It keeps several glob-related tests short and readable.

**Data flow**: It receives a pattern string and returns a filesystem sandbox entry with deny access for that pattern.

**Call relations**: The test helper `default_policy_with_unreadable_glob` uses this to build policies for glob expansion tests.


##### `tests::default_policy_with_unreadable_glob`  (lines 1354–1358)

```
fn default_policy_with_unreadable_glob(pattern: String) -> FileSystemSandboxPolicy
```

**Purpose**: Builds a default test filesystem policy with one unreadable glob rule added. This is a convenience helper for tests focused on glob masking.

**Data flow**: It receives a pattern, creates a default policy, appends a deny-glob entry, and returns the policy.

**Call relations**: Glob-related tests call this before passing the policy into `create_filesystem_args` or `create_bwrap_command_args`.

*Call graph*: calls 1 internal fn (default); 1 external calls (unreadable_glob_entry).


##### `tests::full_disk_write_full_network_returns_unwrapped_command`  (lines 1361–1377)

```
fn full_disk_write_full_network_returns_unwrapped_command()
```

**Purpose**: Verifies that no Bubblewrap overhead is added when both disk and network access are unrestricted. In that case sandboxing would not change behavior.

**Data flow**: It builds an unrestricted policy and full-network options, calls `create_bwrap_command_args`, and asserts the returned arguments equal the original command.

**Call relations**: This test covers the early-exit path in `create_bwrap_command_args`.

*Call graph*: calls 2 internal fn (create_bwrap_command_args, unrestricted); 4 external calls (default, new, assert_eq!, vec!).


##### `tests::full_disk_write_proxy_only_keeps_full_filesystem_but_unshares_network`  (lines 1380–1412)

```
fn full_disk_write_proxy_only_keeps_full_filesystem_but_unshares_network()
```

**Purpose**: Verifies that proxy-only networking still uses Bubblewrap even when filesystem access is unrestricted. The filesystem stays fully bound, but the network namespace is separated.

**Data flow**: It builds an unrestricted policy with proxy-only network mode, calls `create_bwrap_command_args`, and checks for full filesystem bind plus network unshare flags.

**Call relations**: This test covers the handoff from `create_bwrap_command_args` to `create_bwrap_flags_full_filesystem`.

*Call graph*: calls 2 internal fn (create_bwrap_command_args, unrestricted); 4 external calls (default, new, assert_eq!, vec!).


##### `tests::full_disk_write_with_unreadable_glob_still_wraps_and_masks_match`  (lines 1415–1448)

```
fn full_disk_write_with_unreadable_glob_still_wraps_and_masks_match()
```

**Purpose**: Verifies that unreadable glob rules still force Bubblewrap even when disk write access is otherwise full. A deny-read rule must not be skipped.

**Data flow**: It creates a temporary `.env` file, builds a full-write policy with a deny glob, calls `create_bwrap_command_args`, and checks that the command is wrapped and the file is masked.

**Call relations**: This test exercises `create_bwrap_command_args`, glob expansion, and file-mask argument creation.

*Call graph*: calls 3 internal fn (default, create_bwrap_command_args, restricted); 6 external calls (new, assert_ne!, assert_file_masked, ripgrep_available, write, vec!).


##### `tests::restricted_policy_chdirs_to_canonical_command_cwd`  (lines 1452–1526)

```
fn restricted_policy_chdirs_to_canonical_command_cwd()
```

**Purpose**: Checks that a command starting inside a symlinked directory is told to `chdir` to the real path inside Bubblewrap. This keeps relative paths working after canonical mounts are used.

**Data flow**: It creates a real directory and symlink, builds a restricted policy, calls `create_bwrap_command_args`, and asserts the arguments use canonical paths rather than the symlink aliases.

**Call relations**: This test covers `normalize_command_cwd_for_bwrap`, symlinked root handling, and `create_bwrap_flags`.

*Call graph*: calls 5 internal fn (default, create_bwrap_command_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::symlinked_writable_roots_bind_real_target_and_remap_carveouts`  (lines 1530–1572)

```
fn symlinked_writable_roots_bind_real_target_and_remap_carveouts()
```

**Purpose**: Ensures that writable roots reached through symlinks are mounted at their real target and that denied subpaths are remapped too. This prevents symlink paths from bypassing restrictions.

**Data flow**: It creates a symlinked root with a blocked directory, builds a policy, calls `create_filesystem_args`, and asserts the real root is bound and the real blocked path is masked.

**Call relations**: This test exercises `canonical_target_if_symlinked_path` and `remap_paths_for_symlink_target` through `create_filesystem_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::writable_roots_under_symlinked_ancestors_bind_real_target`  (lines 1576–1619)

```
fn writable_roots_under_symlinked_ancestors_bind_real_target()
```

**Purpose**: Checks that a writable root below a symlinked ancestor is bound using its real filesystem location. This matters for paths such as a symlinked `.codex` directory.

**Data flow**: It creates a symlinked ancestor, builds a writable policy for a child path, calls `create_filesystem_args`, and asserts only the real target is bound.

**Call relations**: This test covers symlink detection inside `canonical_target_if_symlinked_path` as used by `create_filesystem_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::protected_symlinked_directory_subpaths_fail_closed`  (lines 1623–1648)

```
fn protected_symlinked_directory_subpaths_fail_closed()
```

**Purpose**: Verifies that the sandbox refuses a protected read-only path that crosses a writable symlink. Refusing is safer than pretending to protect a path whose target can change.

**Data flow**: It creates a writable root with `.agents` as a symlink, calls `create_filesystem_args`, expects an error, and checks the error names the unsafe path.

**Call relations**: This test covers `first_writable_symlink_component_in_path` through `append_read_only_subpath_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::symlinked_writable_roots_nested_symlink_escape_paths_fail_closed`  (lines 1652–1689)

```
fn symlinked_writable_roots_nested_symlink_escape_paths_fail_closed()
```

**Purpose**: Verifies that deny-read paths crossing writable symlinks fail closed. This prevents a sandboxed process from changing a symlink after startup to escape a deny-read mask.

**Data flow**: It creates a symlinked writable root containing another symlink to a private directory, builds a deny policy, and asserts `create_filesystem_args` returns a protective error.

**Call relations**: This test covers symlink safety in `append_unreadable_root_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, symlink, vec!).


##### `tests::missing_read_only_subpath_uses_empty_file_bind_data`  (lines 1692–1736)

```
fn missing_read_only_subpath_uses_empty_file_bind_data()
```

**Purpose**: Checks that a missing read-only subpath is blocked with an empty file mount and that default metadata names become empty read-only directories.

**Data flow**: It creates a writable workspace with a missing blocked path, builds a policy, calls `create_filesystem_args`, and asserts the expected placeholder mounts and synthetic target records exist.

**Call relations**: This test exercises `append_read_only_subpath_args`, `append_missing_read_only_subpath_args`, and synthetic target recording.

*Call graph*: calls 3 internal fn (create_filesystem_args, restricted, from_absolute_path); 7 external calls (new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, assert_empty_file_bound_without_perms, create_dir_all, vec!).


##### `tests::transient_empty_preserved_file_uses_empty_file_bind_data`  (lines 1739–1783)

```
fn transient_empty_preserved_file_uses_empty_file_bind_data()
```

**Purpose**: Checks that an existing empty `.git` file is treated as a transient placeholder, not as a stable source to bind. Cleanup must preserve it if it really pre-existed.

**Data flow**: It creates an empty `.git` file, builds a writable policy, calls `create_filesystem_args`, and verifies empty-file bind behavior plus identity-preserving synthetic target state.

**Call relations**: This test covers `transient_empty_metadata_path`, `append_existing_empty_file_bind_data_args`, and `SyntheticMountTarget::should_remove_after_bwrap`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 9 external calls (create, new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, assert_empty_file_bound_without_perms, create_dir_all, symlink_metadata, vec!).


##### `tests::missing_child_git_under_parent_repo_uses_protected_create_target`  (lines 1786–1825)

```
fn missing_child_git_under_parent_repo_uses_protected_create_target()
```

**Purpose**: Ensures a missing child `.git` inside a parent Git repository is not replaced by an empty directory. That would break Git's normal parent repository discovery.

**Data flow**: It creates a parent repo and child workspace, builds a writable policy, calls `create_filesystem_args`, and checks `.git` is recorded as a protected create target instead of a synthetic mount.

**Call relations**: This test covers `should_leave_missing_git_for_parent_repo_discovery` and protected-create target recording.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 7 external calls (new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, create_dir_all, write, vec!).


##### `tests::symlinked_missing_child_git_under_parent_repo_uses_effective_mount_root`  (lines 1829–1872)

```
fn symlinked_missing_child_git_under_parent_repo_uses_effective_mount_root()
```

**Purpose**: Checks the same missing-child-`.git` behavior when the workspace path goes through a symlink. The decision must use the effective real mount root.

**Data flow**: It creates a parent repo, a symlink to it, and a workspace through the symlink, then calls `create_filesystem_args` and checks `.git` becomes a protected create target.

**Call relations**: This test combines symlink root handling with `should_leave_missing_git_for_parent_repo_discovery`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 8 external calls (new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, create_dir_all, write, symlink, vec!).


##### `tests::ignores_missing_writable_roots`  (lines 1875–1906)

```
fn ignores_missing_writable_roots()
```

**Purpose**: Verifies that missing writable roots are skipped instead of causing sandbox startup to fail. This allows shared configurations that mention paths not present on every machine.

**Data flow**: It creates one existing and one missing root, builds a workspace-write policy, calls `create_filesystem_args`, and asserts only the existing root appears in Bubblewrap arguments.

**Call relations**: This test covers the writable-root filtering inside `create_filesystem_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, workspace_write, try_from); 3 external calls (new, assert!, create_dir).


##### `tests::missing_project_root_metadata_carveouts_use_metadata_path_masks`  (lines 1909–1964)

```
fn missing_project_root_metadata_carveouts_use_metadata_path_masks()
```

**Purpose**: Checks that missing automatic metadata carveouts under project roots become read-only metadata masks. This keeps `.git`, `.agents`, and `.codex` protected even when absent.

**Data flow**: It builds a policy with project-root write access and metadata read rules, calls `create_filesystem_args`, and verifies empty read-only directory masks and synthetic targets.

**Call relations**: This test covers metadata handling in `create_filesystem_args` and `append_metadata_path_masks_for_writable_root`.

*Call graph*: calls 3 internal fn (create_filesystem_args, path_to_string, restricted); 7 external calls (new, new, assert!, assert_eq!, assert_empty_directory_mounted_read_only, synthetic_mount_target_paths, vec!).


##### `tests::missing_user_project_root_subpath_rules_are_still_enforced`  (lines 1967–2004)

```
fn missing_user_project_root_subpath_rules_are_still_enforced()
```

**Purpose**: Verifies that user-authored missing project subpath rules, unlike automatic metadata masks, still create blocking placeholders. Custom rules should not be silently skipped.

**Data flow**: It builds a policy with missing `.vscode` read and `.secrets` deny rules, calls `create_filesystem_args`, and checks both are blocked with empty file binds.

**Call relations**: This test protects the special-case logic in `create_filesystem_args` that treats automatic metadata names differently from user rules.

*Call graph*: calls 3 internal fn (create_filesystem_args, path_to_string, restricted); 4 external calls (new, new, assert_empty_file_bound_without_perms, vec!).


##### `tests::mounts_dev_before_writable_dev_binds`  (lines 2007–2094)

```
fn mounts_dev_before_writable_dev_binds()
```

**Purpose**: Checks that Bubblewrap mounts its minimal `/dev` before rebinding writable `/dev` paths. Device setup order matters so standard device files remain usable.

**Data flow**: It builds a policy that makes `/dev` writable, calls `create_filesystem_args`, and compares the complete expected mount order and synthetic metadata target list.

**Call relations**: This test verifies the mount ordering encoded in `create_filesystem_args`.

*Call graph*: calls 3 internal fn (create_filesystem_args, workspace_write, try_from); 3 external calls (new, assert!, assert_eq!).


##### `tests::restricted_read_only_uses_scoped_read_roots_instead_of_erroring`  (lines 2097–2125)

```
fn restricted_read_only_uses_scoped_read_roots_instead_of_erroring()
```

**Purpose**: Verifies that a restricted read-only policy starts from an empty filesystem and adds approved readable roots, instead of failing. This supports narrow read access.

**Data flow**: It creates a readable directory, builds a read-only restricted policy, calls `create_filesystem_args`, and checks the output starts with `--tmpfs /` plus a read-only bind for that directory.

**Call relations**: This test covers the restricted-read branch of `create_filesystem_args`.

*Call graph*: calls 3 internal fn (create_filesystem_args, path_to_string, restricted); 5 external calls (new, assert!, assert_eq!, create_dir, vec!).


##### `tests::restricted_read_only_with_platform_defaults_includes_usr_when_present`  (lines 2128–2153)

```
fn restricted_read_only_with_platform_defaults_includes_usr_when_present()
```

**Purpose**: Checks that minimal restricted policies include common Linux system paths such as `/usr` when platform defaults are requested. This lets basic binaries and libraries remain readable.

**Data flow**: It builds a minimal read policy, calls `create_filesystem_args`, and asserts the sandbox starts from an empty root and includes `/usr` if it exists.

**Call relations**: This test covers `LINUX_PLATFORM_DEFAULT_READ_ROOTS` integration in `create_filesystem_args`.

*Call graph*: calls 2 internal fn (create_filesystem_args, restricted); 4 external calls (new, new, assert!, vec!).


##### `tests::split_policy_reapplies_unreadable_carveouts_after_writable_binds`  (lines 2156–2225)

```
fn split_policy_reapplies_unreadable_carveouts_after_writable_binds()
```

**Purpose**: Ensures denied subpaths inside a writable root are masked after the writable root is bound. Otherwise the broad writable bind would reopen the denied path.

**Data flow**: It creates a writable workspace with a blocked directory, builds a policy, calls `create_filesystem_args`, and compares the positions of writable bind and denied mask arguments.

**Call relations**: This test checks ordering in `create_filesystem_args` and `append_unreadable_root_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_reenables_nested_writable_subpaths_after_read_only_parent`  (lines 2228–2281)

```
fn split_policy_reenables_nested_writable_subpaths_after_read_only_parent()
```

**Purpose**: Verifies that a nested writable child can be reopened after its parent has been made read-only. This supports policies like writable project root, read-only docs, writable docs/public.

**Data flow**: It creates nested directories, builds a mixed write/read/write policy, calls `create_filesystem_args`, and asserts the parent read-only mount comes before the child writable bind.

**Call relations**: This test covers depth ordering of writable roots and read-only subpaths inside `create_filesystem_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_reenables_writable_subpaths_after_unreadable_parent`  (lines 2284–2345)

```
fn split_policy_reenables_writable_subpaths_after_unreadable_parent()
```

**Purpose**: Checks that a writable child under an unreadable parent can still be mounted safely. The parent is hidden but made traversable enough to reach the approved child.

**Data flow**: It creates a blocked directory with an allowed child, builds a read/deny/write policy, calls `create_filesystem_args`, and verifies the order: mask parent, create child target, freeze parent, bind child.

**Call relations**: This test covers `append_existing_unreadable_path_args` and `append_mount_target_parent_dir_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_reenables_writable_files_after_unreadable_parent`  (lines 2348–2426)

```
fn split_policy_reenables_writable_files_after_unreadable_parent()
```

**Purpose**: Checks that a writable file under an unreadable parent is reopened without accidentally creating the file path as a directory. Only parent directories should be recreated.

**Data flow**: It creates a blocked directory containing an allowed file, builds a policy, calls `create_filesystem_args`, and verifies parent directory creation plus writable file bind ordering.

**Call relations**: This test protects `append_mount_target_parent_dir_args` behavior for file mount targets.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, create_dir_all, write, vec!).


##### `tests::split_policy_reenables_nested_writable_roots_after_unreadable_parent`  (lines 2429–2482)

```
fn split_policy_reenables_nested_writable_roots_after_unreadable_parent()
```

**Purpose**: Verifies that a deeper writable root inside a denied area is reopened after the denied parent is masked. This supports precise carveouts.

**Data flow**: It creates a writable workspace, blocked subdirectory, and allowed nested directory, then calls `create_filesystem_args` and checks mask, directory creation, and bind ordering.

**Call relations**: This test covers the nested unreadable-root handling in `create_filesystem_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_masks_root_read_directory_carveouts`  (lines 2485–2525)

```
fn split_policy_masks_root_read_directory_carveouts()
```

**Purpose**: Checks that when the full filesystem is readable, a denied directory is still hidden with a temporary mount. Full read access should not override explicit deny rules.

**Data flow**: It creates a blocked directory, builds a root-read plus deny policy, calls `create_filesystem_args`, and asserts the root is read-only bound while the blocked directory is masked and remounted read-only.

**Call relations**: This test covers the full-read branch plus unreadable directory masking.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 4 external calls (new, assert!, create_dir_all, vec!).


##### `tests::split_policy_masks_root_read_file_carveouts`  (lines 2528–2562)

```
fn split_policy_masks_root_read_file_carveouts()
```

**Purpose**: Checks that a denied file under a full-read policy is masked with an unreadable empty file. This protects secrets even when the rest of the disk is readable.

**Data flow**: It creates a blocked file, builds a root-read plus deny policy, calls `create_filesystem_args`, and asserts a `000` empty-file bind is present.

**Call relations**: This test covers file handling in `append_existing_unreadable_path_args`.

*Call graph*: calls 4 internal fn (create_filesystem_args, path_to_string, restricted, from_absolute_path); 5 external calls (new, assert!, assert_eq!, write, vec!).


##### `tests::unreadable_globs_expand_existing_matches_with_configured_depth`  (lines 2565–2595)

```
fn unreadable_globs_expand_existing_matches_with_configured_depth()
```

**Purpose**: Verifies that unreadable glob expansion respects the configured maximum scan depth. This avoids masking files deeper than the caller chose to scan.

**Data flow**: It creates `.env` files at several depths, builds a deny glob policy, calls `create_filesystem_args` with depth two, and checks only shallow matches are masked.

**Call relations**: This test covers `expand_unreadable_globs_with_ripgrep` and `ripgrep_files` when ripgrep is available.

*Call graph*: calls 1 internal fn (create_filesystem_args); 8 external calls (new, assert!, format!, assert_file_masked, default_policy_with_unreadable_glob, ripgrep_available, create_dir_all, write).


##### `tests::unreadable_globs_add_canonical_targets_for_symlink_matches`  (lines 2599–2618)

```
fn unreadable_globs_add_canonical_targets_for_symlink_matches()
```

**Purpose**: Checks that when a glob match is found through a symlink, the real target is also masked. This closes a possible bypass through canonical paths.

**Data flow**: It creates a real directory, a symlink to it, and a matching secret file, then calls `create_filesystem_args` and checks the real secret path is masked.

**Call relations**: This test covers the symlink-target addition in `expand_unreadable_globs_with_ripgrep`.

*Call graph*: calls 1 internal fn (create_filesystem_args); 8 external calls (new, format!, assert_file_masked, default_policy_with_unreadable_glob, ripgrep_available, create_dir_all, write, symlink).


##### `tests::root_prefix_unreadable_globs_are_too_broad_for_linux_expansion`  (lines 2621–2626)

```
fn root_prefix_unreadable_globs_are_too_broad_for_linux_expansion()
```

**Purpose**: Verifies that glob expansion refuses patterns whose static search root is `/`. Scanning the whole filesystem during sandbox setup would be too expensive and broad.

**Data flow**: It passes a root-level glob to `split_pattern_for_ripgrep` and asserts no search plan is returned.

**Call relations**: This test directly covers the safety guard in `split_pattern_for_ripgrep`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::unclosed_character_classes_are_escaped_for_ripgrep`  (lines 2629–2635)

```
fn unclosed_character_classes_are_escaped_for_ripgrep()
```

**Purpose**: Checks that an unmatched `[` in a glob is treated as a literal for ripgrep. This preserves the policy language's accepted syntax.

**Data flow**: It splits a pattern containing an unclosed bracket class and asserts the search root and escaped glob are as expected.

**Call relations**: This test directly covers `split_pattern_for_ripgrep` and `escape_unclosed_glob_classes`.

*Call graph*: calls 1 internal fn (split_pattern_for_ripgrep); 2 external calls (new, assert_eq!).


##### `tests::ripgrep_available`  (lines 2637–2642)

```
fn ripgrep_available() -> bool
```

**Purpose**: Reports whether the `rg` command is installed and runnable in the test environment. Some tests skip themselves when ripgrep is unavailable.

**Data flow**: It runs `rg --version` and returns `true` only if the command starts and exits successfully.

**Call relations**: Glob-expansion tests call this before relying on ripgrep-specific behavior.

*Call graph*: 1 external calls (new).


##### `tests::assert_file_masked`  (lines 2647–2658)

```
fn assert_file_masked(args: &[String], path: &Path)
```

**Purpose**: Test helper that checks a path is masked as an unreadable file in Bubblewrap arguments. It makes tests clearer by hiding the exact argument-window search.

**Data flow**: It receives an argument list and path, converts the path to a string, and asserts the expected `--perms 000 --ro-bind-data ... path` sequence exists.

**Call relations**: Several tests call this after `create_filesystem_args` or `create_bwrap_command_args` to verify deny-read file masking.

*Call graph*: calls 1 internal fn (path_to_string); 1 external calls (assert!).


##### `tests::assert_empty_file_bound_without_perms`  (lines 2662–2678)

```
fn assert_empty_file_bound_without_perms(args: &[String], path: &Path)
```

**Purpose**: Test helper that checks a path is backed by an empty file mount without an explicit `000` permission setting. This distinguishes missing-path blocking from unreadable-file masking.

**Data flow**: It receives arguments and a path, converts the path to a string, asserts an empty bind-data mount exists, and asserts the unreadable-file permission sequence is absent.

**Call relations**: Tests for missing read-only subpaths and user project subpath rules call this.

*Call graph*: calls 1 internal fn (path_to_string); 1 external calls (assert!).


##### `tests::assert_empty_directory_mounted_read_only`  (lines 2680–2692)

```
fn assert_empty_directory_mounted_read_only(args: &[String], path: &Path)
```

**Purpose**: Test helper that checks a path is mounted as an empty read-only directory. It is used for protected metadata directory masks.

**Data flow**: It receives arguments and a path, converts the path to a string, and asserts both the temporary directory mount and read-only remount flags are present.

**Call relations**: Metadata protection tests call this to verify `.git`, `.agents`, and `.codex` behavior.

*Call graph*: calls 1 internal fn (path_to_string); 1 external calls (assert!).


##### `tests::synthetic_mount_target_paths`  (lines 2694–2699)

```
fn synthetic_mount_target_paths(args: &BwrapArgs) -> Vec<PathBuf>
```

**Purpose**: Extracts just the paths from synthetic mount target records in tests. This makes expected cleanup records easy to compare.

**Data flow**: It receives a `BwrapArgs` value, maps each synthetic target to its path, copies the paths into a vector, and returns it.

**Call relations**: Tests call this after filesystem argument construction to check which temporary placeholders were recorded.


##### `tests::protected_create_target_paths`  (lines 2701–2706)

```
fn protected_create_target_paths(args: &BwrapArgs) -> Vec<PathBuf>
```

**Purpose**: Extracts just the paths from protected-create target records in tests. This makes it easy to assert which missing paths are watched instead of mounted.

**Data flow**: It receives a `BwrapArgs` value, maps each protected-create target to its path, copies the paths into a vector, and returns it.

**Call relations**: Tests for missing child `.git` behavior call this after `create_filesystem_args`.


### `linux-sandbox/src/bundled_bwrap.rs`

`orchestration` · `sandbox startup`

Codex needs a trusted Bubblewrap executable before it can create a Linux sandbox. This file answers three practical questions: where is the bundled `bwrap` file, is it actually runnable, and is it the file Codex expected to ship? It first looks in the install layout known to Codex, then falls back to older layouts used by standalone, npm, development, or Bazel builds. Think of it like checking several likely pockets for the same key.

Once a suitable `bwrap` is found, `BundledBwrapLauncher::exec` opens it, optionally verifies its SHA-256 digest (a cryptographic fingerprint of the file), marks selected file descriptors as safe to pass into the next process, and then replaces the current process with Bubblewrap using `execv`. Replacing the current process means this function does not return if it succeeds; Codex hands control directly to Bubblewrap.

The digest check is important when a build embeds an expected `CODEX_BWRAP_SHA256` value. If the file on disk does not match, Codex refuses to run it, which helps catch corruption or packaging mistakes. The bottom of the file contains tests for the search paths, digest verification, and digest parsing.

#### Function details

##### `launcher`  (lines 28–33)

```
fn launcher() -> Option<BundledBwrapLauncher>
```

**Purpose**: Builds a launcher for the bundled Bubblewrap executable if one can be found. It is the main entry point other code uses when it wants to run the packaged sandbox helper instead of relying on a system-installed one.

**Data flow**: It starts with the current executable path and the current install context. It looks for a runnable `bwrap` in the modern install layout, then falls back to legacy locations near the executable. If a valid path is found, it wraps that path in a `BundledBwrapLauncher`; otherwise it returns nothing.

**Call relations**: This function begins the bundled-Bubblewrap flow. It asks `find_for_install_context` to search the known install layout and, if needed, uses the legacy search path logic before handing back a launcher whose `exec` method can later start Bubblewrap.

*Call graph*: calls 2 internal fn (current, find_for_install_context); 1 external calls (current_exe).


##### `BundledBwrapLauncher::exec`  (lines 36–69)

```
fn exec(&self, argv: Vec<String>, preserved_files: Vec<File>) -> !
```

**Purpose**: Runs the bundled Bubblewrap program and replaces the current process with it. This is used when Codex is ready to enter the sandbox setup step.

**Data flow**: It receives command-line arguments for Bubblewrap and a list of open files that must survive into the new process. It opens the bundled executable, checks its SHA-256 fingerprint if an expected one is configured, makes the preserved files inheritable, converts Rust strings into C-style strings, and calls the operating system's `execv`. On success, there is no returned value because the current process has become Bubblewrap; on failure, it reports the operating-system error by panicking.

**Call relations**: After `launcher` has found a usable bundled executable, this method performs the handoff. It calls `expected_sha256` and `verify_digest` before execution, uses `make_files_inheritable` so required file descriptors are not closed, and uses `argv_to_cstrings` because the low-level Unix exec call expects C-compatible strings.

*Call graph*: calls 5 internal fn (expected_sha256, verify_digest, argv_to_cstrings, make_files_inheritable, as_path); 7 external calls (new, open, last_os_error, format!, execv, panic!, null).


##### `find_for_install_context`  (lines 72–76)

```
fn find_for_install_context(context: &InstallContext) -> Option<AbsolutePathBuf>
```

**Purpose**: Looks for `bwrap` in the install layout that Codex already knows about. This is the preferred path because it follows the current packaging model.

**Data flow**: It receives an `InstallContext`, asks it for the bundled resource named `bwrap`, and checks whether that path points to an executable file. If so, it returns the absolute path; if not, it returns nothing.

**Call relations**: `launcher` calls this first because the install context is the most reliable source of packaged resources. It relies on `is_executable_file` to avoid accepting a missing file, directory, or non-runnable file.

*Call graph*: calls 1 internal fn (bundled_resource); called by 1 (launcher).


##### `find_legacy_for_exe`  (lines 78–90)

```
fn find_legacy_for_exe(exe: &Path) -> Option<AbsolutePathBuf>
```

**Purpose**: Searches older or development-time locations for a bundled Bubblewrap executable. This keeps Codex working across package layouts that predate the current install context system.

**Data flow**: It receives the path to the running Codex executable. It builds a list of possible nearby `bwrap` paths, picks the first one that is an executable file, and converts it into the absolute-path type used by the rest of the code.

**Call relations**: This is the fallback search used after the install-context lookup fails. It gets its possible paths from `legacy_candidates_for_exe` and filters them with `is_executable_file` before returning a path that `launcher` can place into a `BundledBwrapLauncher`.

*Call graph*: calls 1 internal fn (legacy_candidates_for_exe).


##### `legacy_candidates_for_exe`  (lines 92–107)

```
fn legacy_candidates_for_exe(exe: &Path) -> Vec<PathBuf>
```

**Purpose**: Builds the list of old-style places where `bwrap` might live relative to the Codex executable. It does not decide whether the files are valid; it only names the places to check.

**Data flow**: It receives the executable path, finds its parent directory, and creates candidate paths such as `codex-resources/bwrap` next to the executable, `codex-resources/bwrap` one level up, an adjacent `bwrap`, and a Bazel-provided candidate if one exists. It returns this list in priority order.

**Call relations**: `find_legacy_for_exe` calls this when it needs fallback locations. It also asks `bazel_bwrap::candidate` for a build-system-specific option, so development and test builds can participate in the same lookup flow.

*Call graph*: calls 1 internal fn (candidate); called by 1 (find_legacy_for_exe); 2 external calls (parent, new).


##### `is_executable_file`  (lines 109–114)

```
fn is_executable_file(path: &Path) -> bool
```

**Purpose**: Checks whether a path points to a real file that has execute permission. This prevents Codex from trying to run a directory, missing file, or non-executable resource as Bubblewrap.

**Data flow**: It receives a filesystem path and reads its metadata. If the metadata says the path is a regular file and at least one Unix execute bit is set, it returns true; otherwise it returns false.

**Call relations**: Both modern and legacy search paths depend on this check before accepting a `bwrap` candidate. It is the small gatekeeper that keeps the launcher from being built around an unusable file.

*Call graph*: 1 external calls (metadata).


##### `expected_sha256`  (lines 116–124)

```
fn expected_sha256() -> Option<[u8; 32]>
```

**Purpose**: Reads the expected SHA-256 fingerprint for the bundled Bubblewrap executable, if the build provided one. It caches the answer so the environment-derived value is parsed only once.

**Data flow**: It looks at the compile-time environment value `CODEX_BWRAP_SHA256`. If the value is absent, or if it is the all-zero placeholder digest, it returns no expected digest. If present, it parses the 64-character hex string into 32 bytes and returns that digest.

**Call relations**: `BundledBwrapLauncher::exec` calls this immediately before verifying the file. It uses `parse_sha256_hex` to turn the human-readable hex value into bytes that `verify_digest` can compare.

*Call graph*: called by 1 (exec); 1 external calls (new).


##### `verify_digest`  (lines 126–160)

```
fn verify_digest(file: &File, expected: Option<[u8; 32]>, path: &Path) -> Result<(), String>
```

**Purpose**: Confirms that the bundled Bubblewrap file matches the expected SHA-256 fingerprint. This protects the launch step from running the wrong binary when a digest is configured.

**Data flow**: It receives an already-open file, an optional expected digest, and the file path used for error messages. If there is no expected digest, it accepts the file immediately. Otherwise it clones the file handle, reads the file in chunks, computes its SHA-256 digest, and compares the result with the expected bytes. It returns success for a match and a readable error string for read failures or mismatches.

**Call relations**: `BundledBwrapLauncher::exec` calls this before handing control to Bubblewrap. The digest tests also call it directly to prove that missing, matching, and mismatched digests behave correctly. When reporting a mismatch, it uses `bytes_to_hex` so both expected and actual fingerprints are shown in the familiar hex form.

*Call graph*: called by 4 (exec, digest_verification_accepts_matching_digest, digest_verification_rejects_mismatched_digest, digest_verification_skips_missing_expected_digest); 4 external calls (read, try_clone, new, format!).


##### `parse_sha256_hex`  (lines 162–177)

```
fn parse_sha256_hex(raw: &str) -> Result<[u8; 32], String>
```

**Purpose**: Converts a 64-character SHA-256 hex string into the 32 raw bytes used for comparison. It also gives clear errors when the configured value is malformed.

**Data flow**: It receives a string. It first checks that the length is exactly 64 characters, then reads two hex characters at a time into one byte. It returns the completed 32-byte digest or an error describing the bad length or invalid byte.

**Call relations**: `expected_sha256` uses this when a build-time `CODEX_BWRAP_SHA256` value exists. The parsing test calls it directly to check valid digests, the all-zero digest, too-short input, and invalid hex characters.

*Call graph*: 2 external calls (format!, from_str_radix).


##### `bytes_to_hex`  (lines 179–187)

```
fn bytes_to_hex(bytes: &[u8; 32]) -> String
```

**Purpose**: Turns a 32-byte digest into a lowercase hex string that people can read in an error message. This is the reverse of parsing a SHA-256 hex value.

**Data flow**: It receives 32 bytes. For each byte, it writes two characters: one for the high half of the byte and one for the low half. It returns a 64-character lowercase hex string.

**Call relations**: `verify_digest` uses this only when a digest mismatch needs to be explained. It makes the expected and actual fingerprints easy to compare in logs or panic messages.

*Call graph*: 1 external calls (with_capacity).


##### `tests::finds_package_layout_bwrap_from_install_context`  (lines 201–226)

```
fn finds_package_layout_bwrap_from_install_context()
```

**Purpose**: Tests that the modern install-context lookup finds `bwrap` in the package resources directory. This protects the preferred packaging path from regressions.

**Data flow**: It creates a temporary package-like directory with a `bin` directory and a `codex-resources/bwrap` executable. It builds an `InstallContext` pointing at those directories, calls the install-context finder, and checks that the returned path is the expected `bwrap` path.

**Call relations**: This test exercises `find_for_install_context` through a realistic package layout. It uses `tests::write_executable` to create a runnable fake `bwrap` file before making the assertion.

*Call graph*: calls 1 internal fn (from_absolute_path); 4 external calls (assert_eq!, create_dir_all, write_executable, tempdir).


##### `tests::finds_legacy_standalone_bundled_bwrap_next_to_exe_resources`  (lines 229–240)

```
fn finds_legacy_standalone_bundled_bwrap_next_to_exe_resources()
```

**Purpose**: Tests that the legacy standalone layout is still supported. In that layout, `bwrap` lives under `codex-resources` next to the Codex executable.

**Data flow**: It creates a temporary executable path and a neighboring `codex-resources/bwrap` file with execute permission. It calls the legacy finder with the executable path and checks that the resource path is returned.

**Call relations**: This test exercises `find_legacy_for_exe`, which in turn depends on `legacy_candidates_for_exe` and the executable-file check. It uses `tests::write_executable` to prepare both the fake executable and fake `bwrap`.

*Call graph*: 3 external calls (assert_eq!, write_executable, tempdir).


##### `tests::finds_npm_bundled_bwrap_next_to_target_vendor_dir`  (lines 243–255)

```
fn finds_npm_bundled_bwrap_next_to_target_vendor_dir()
```

**Purpose**: Tests that an npm-style packaged layout can still locate bundled Bubblewrap. This matters for distributions where the executable is nested under a target-specific vendor directory.

**Data flow**: It creates a temporary nested path like a vendor target directory, places a fake Codex executable inside it, and places `codex-resources/bwrap` at the target directory level. It then asks the legacy finder for `bwrap` and checks that it finds the target-level resource.

**Call relations**: This test guards one of the fallback paths generated by `legacy_candidates_for_exe`. Like the other layout tests, it uses `tests::write_executable` to make the fake files pass the executable check.

*Call graph*: 3 external calls (assert_eq!, write_executable, tempdir).


##### `tests::finds_adjacent_dev_bwrap`  (lines 258–269)

```
fn finds_adjacent_dev_bwrap()
```

**Purpose**: Tests the development layout where `bwrap` sits directly next to the Codex executable. This makes local builds easier to run without a full package layout.

**Data flow**: It creates a temporary fake executable and a sibling `bwrap` file, both executable. It calls the legacy finder and checks that the adjacent `bwrap` path is selected.

**Call relations**: This test covers another candidate path produced by `legacy_candidates_for_exe`. It depends on `tests::write_executable` to create files that `is_executable_file` will accept.

*Call graph*: 3 external calls (assert_eq!, write_executable, tempdir).


##### `tests::digest_verification_skips_missing_expected_digest`  (lines 272–278)

```
fn digest_verification_skips_missing_expected_digest()
```

**Purpose**: Tests that digest verification is skipped when no expected fingerprint is configured. This allows builds that do not provide a `CODEX_BWRAP_SHA256` value to still run.

**Data flow**: It creates a temporary file, writes some contents to it, and calls `verify_digest` with no expected digest. The expected result is success, regardless of the file contents.

**Call relations**: This test calls `verify_digest` directly to cover the early-exit path that `BundledBwrapLauncher::exec` would use when `expected_sha256` returns nothing.

*Call graph*: calls 1 internal fn (verify_digest); 2 external calls (new, write).


##### `tests::digest_verification_accepts_matching_digest`  (lines 281–288)

```
fn digest_verification_accepts_matching_digest()
```

**Purpose**: Tests that digest verification succeeds when the file contents match the expected SHA-256 fingerprint.

**Data flow**: It creates a temporary file containing `contents`, computes the SHA-256 digest of that same byte string, and passes the digest to `verify_digest`. The expected result is success.

**Call relations**: This test calls `verify_digest` directly and checks the success path that `BundledBwrapLauncher::exec` relies on before launching Bubblewrap.

*Call graph*: calls 1 internal fn (verify_digest); 3 external calls (new, digest, write).


##### `tests::digest_verification_rejects_mismatched_digest`  (lines 291–298)

```
fn digest_verification_rejects_mismatched_digest()
```

**Purpose**: Tests that digest verification fails when the file does not match the expected fingerprint. This confirms that the safety check actually blocks the wrong binary.

**Data flow**: It creates a temporary file containing `contents`, but passes a deliberately wrong 32-byte digest. It expects `verify_digest` to return an error, then checks that the error mentions a bundled Bubblewrap digest mismatch.

**Call relations**: This test calls `verify_digest` directly to cover the failure path. That is the same path `BundledBwrapLauncher::exec` would turn into a panic instead of running an unexpected executable.

*Call graph*: calls 1 internal fn (verify_digest); 3 external calls (new, assert!, write).


##### `tests::parses_sha256_hex_digest`  (lines 301–306)

```
fn parses_sha256_hex_digest()
```

**Purpose**: Tests the SHA-256 hex parser with valid and invalid inputs. This keeps build-time digest configuration errors clear and predictable.

**Data flow**: It sends the parser a valid repeated `ab` digest, the all-zero digest, a too-short string, and a string containing invalid hex characters. It checks that the valid inputs produce the expected byte arrays and the invalid inputs produce errors.

**Call relations**: This test calls `parse_sha256_hex` directly because `expected_sha256` depends on that parser when reading `CODEX_BWRAP_SHA256`.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::write_executable`  (lines 308–315)

```
fn write_executable(path: &Path)
```

**Purpose**: Creates a fake executable file for the tests. It saves each test from repeating the same setup steps.

**Data flow**: It receives a path, creates the parent directory if needed, writes an empty file there, and sets Unix permissions to `755`, meaning the owner can read/write/execute and others can read/execute. It returns nothing but changes the filesystem inside the temporary test directory.

**Call relations**: The path-finding tests call this helper before invoking the real lookup functions. Without it, `is_executable_file` would reject the fake files and the tests would not model a runnable `bwrap`.

*Call graph*: 5 external calls (parent, from_mode, create_dir_all, set_permissions, write).


### `linux-sandbox/src/launcher.rs`

`orchestration` · `sandbox startup`

Bubblewrap is the tool this project uses to create a locked-down Linux environment, a bit like putting a command inside a temporary room with only the doors and shelves it is allowed to use. This file is the gatekeeper for launching that room.

Its first job is to decide which Bubblewrap executable should be used. It looks for a system `bwrap` on the user's `PATH`. If it finds one, it checks whether that binary is usable for this project by asking it for `--help` and looking for required options. In particular, `--perms` must be supported, while `--argv0` is optional because older Linux distributions may not have it. If the system copy is not good enough, the code tries a bundled Bubblewrap shipped next to Codex. If neither exists, sandbox startup fails with a clear panic message.

The chosen launcher is cached with `OnceLock`, which means the search happens only once per process. That avoids repeated probing and keeps later decisions consistent.

When it actually launches a system Bubblewrap, this file prepares file descriptors that must stay open, converts Rust strings into C-style strings, and calls `execv`. `execv` replaces the current process entirely; on success, this Rust code never returns. If it does return, that means the launch failed, so the code turns the operating system error into a panic.

#### Function details

##### `exec_bwrap`  (lines 36–49)

```
fn exec_bwrap(argv: Vec<String>, preserved_files: Vec<File>) -> !
```

**Purpose**: Starts Bubblewrap using the best available launcher. Callers use this when they are ready to enter the sandbox setup program and do not expect to come back.

**Data flow**: It receives the command-line arguments meant for Bubblewrap and a list of open files that must remain usable. It asks which launcher is preferred, then either executes the system Bubblewrap, asks the bundled launcher to execute, or stops with an error if no launcher exists. On success it never returns because the current process is replaced.

**Call relations**: This is the main launch point used by higher-level sandbox flows such as `run_bwrap_in_child_capture_stderr`, `run_bwrap_in_child_with_synthetic_mount_cleanup`, and `run_or_exec_bwrap`. It first calls `preferred_bwrap_launcher` to choose the route, then hands off to `exec_system_bwrap` for a system binary or to the bundled launcher for the bundled binary.

*Call graph*: calls 2 internal fn (exec_system_bwrap, preferred_bwrap_launcher); called by 3 (run_bwrap_in_child_capture_stderr, run_bwrap_in_child_with_synthetic_mount_cleanup, run_or_exec_bwrap); 1 external calls (panic!).


##### `preferred_bwrap_launcher`  (lines 51–67)

```
fn preferred_bwrap_launcher() -> BubblewrapLauncher
```

**Purpose**: Chooses and remembers the Bubblewrap launcher to use. It gives priority to a compatible system-installed Bubblewrap, then falls back to the bundled one.

**Data flow**: It reads no direct input from its caller. Internally, it searches for system Bubblewrap, checks whether that path can be used, and if not asks the bundled Bubblewrap code for a launcher. It stores the result so future calls get the same answer without repeating the search, then returns a clone of that decision.

**Call relations**: This function sits behind both launching and feature checks. `exec_bwrap` calls it before starting Bubblewrap, while `preferred_bwrap_supports_argv0` calls it to decide whether later argument construction may use the `--argv0` option.

*Call graph*: called by 2 (exec_bwrap, preferred_bwrap_supports_argv0); 1 external calls (new).


##### `system_bwrap_launcher_for_path`  (lines 69–71)

```
fn system_bwrap_launcher_for_path(system_bwrap_path: &Path) -> Option<SystemBwrapLauncher>
```

**Purpose**: Checks whether a specific path points to a usable system Bubblewrap. It is the normal wrapper around the more testable probing function.

**Data flow**: It takes a filesystem path. It passes that path to `system_bwrap_launcher_for_path_with_probe` along with the real capability-checking function, and returns either a ready-to-use system launcher or nothing.

**Call relations**: This is used when `preferred_bwrap_launcher` has found a possible `bwrap` path on `PATH`. It delegates the real decision to `system_bwrap_launcher_for_path_with_probe`, which also lets tests substitute fake capability results.

*Call graph*: calls 1 internal fn (system_bwrap_launcher_for_path_with_probe).


##### `system_bwrap_launcher_for_path_with_probe`  (lines 73–99)

```
fn system_bwrap_launcher_for_path_with_probe(
    system_bwrap_path: &Path,
    system_bwrap_capabilities: impl FnOnce(&Path) -> Option<SystemBwrapCapabilities>,
) -> Option<SystemBwrapLauncher>
```

**Purpose**: Decides whether a candidate system Bubblewrap binary is acceptable. It verifies that the file exists, that it supports required features, and that its path can be stored as an absolute path.

**Data flow**: It receives a path and a probing function. First it rejects the path if it is not a file. Then it asks the probing function what features the binary supports. It requires `--perms`, records whether `--argv0` is supported, converts the path into the project's absolute-path type, and returns a `SystemBwrapLauncher`. If any required check fails, it returns nothing.

**Call relations**: The normal path into this function is through `system_bwrap_launcher_for_path`, which supplies the real `system_bwrap_capabilities` probe. The tests call it indirectly with fake probes so they can check the decision rules without running a real Bubblewrap binary.

*Call graph*: calls 2 internal fn (system_bwrap_capabilities, from_absolute_path); called by 1 (system_bwrap_launcher_for_path); 2 external calls (is_file, panic!).


##### `preferred_bwrap_supports_argv0`  (lines 101–106)

```
fn preferred_bwrap_supports_argv0() -> bool
```

**Purpose**: Tells the rest of the sandbox code whether the chosen Bubblewrap supports the `--argv0` option. `argv0` is the name a program sees for itself as argument zero, and older Bubblewrap versions may not let callers set it.

**Data flow**: It asks for the preferred launcher. If that launcher is a system Bubblewrap, it returns the feature flag discovered earlier. If the launcher is bundled or unavailable, it returns true, matching the bundled/newer expectation used by the rest of the code.

**Call relations**: `apply_inner_command_argv0` calls this when building Bubblewrap arguments. This function relies on `preferred_bwrap_launcher` so the feature answer matches the actual launcher that will later be used.

*Call graph*: calls 1 internal fn (preferred_bwrap_launcher); called by 1 (apply_inner_command_argv0).


##### `system_bwrap_capabilities`  (lines 108–124)

```
fn system_bwrap_capabilities(system_bwrap_path: &Path) -> Option<SystemBwrapCapabilities>
```

**Purpose**: Finds out which important command-line options a system Bubblewrap binary supports. It does this by running `bwrap --help` and reading the help text.

**Data flow**: It receives the path to a candidate Bubblewrap executable. It runs that program with `--help`; if running it fails, it returns nothing. Otherwise it reads both standard output and standard error as text, looks for `--argv0` and `--perms`, and returns those two yes-or-no capability flags.

**Call relations**: `system_bwrap_launcher_for_path_with_probe` uses this as the real-world probe when deciding whether a discovered system binary is good enough. The capability result feeds directly into whether the system launcher is accepted or ignored.

*Call graph*: called by 1 (system_bwrap_launcher_for_path_with_probe); 2 external calls (from_utf8_lossy, new).


##### `exec_system_bwrap`  (lines 126–152)

```
fn exec_system_bwrap(
    program: &AbsolutePathBuf,
    argv: Vec<String>,
    preserved_files: Vec<File>,
) -> !
```

**Purpose**: Replaces the current process with the system Bubblewrap executable. This is the final handoff from Rust code into the operating system's process launcher.

**Data flow**: It receives the absolute path to the system Bubblewrap, the arguments to pass to it, and files that must stay open. It marks those files as inheritable so they survive the process replacement, converts the program path and arguments into C-style strings required by the low-level `execv` system call, and calls `execv`. If `execv` succeeds, there is no return value because this process has become Bubblewrap; if it fails, it reads the OS error and panics.

**Call relations**: `exec_bwrap` calls this when the preferred launcher is a system-installed Bubblewrap. Before the low-level handoff, it uses `make_files_inheritable` and `argv_to_cstrings` to prepare data in the exact form the operating system expects.

*Call graph*: calls 3 internal fn (argv_to_cstrings, make_files_inheritable, as_path); called by 1 (exec_bwrap); 6 external calls (new, last_os_error, execv, panic!, null, as_ptr).


##### `tests::prefers_system_bwrap_when_help_lists_argv0`  (lines 161–178)

```
fn prefers_system_bwrap_when_help_lists_argv0()
```

**Purpose**: Checks that a system Bubblewrap is accepted when it supports both required permissions handling and the newer `--argv0` option.

**Data flow**: It creates a temporary file to stand in for a Bubblewrap binary and prepares the expected absolute path. It calls the launcher-selection helper with a fake probe that reports `supports_argv0: true` and `supports_perms: true`, then compares the returned launcher with the expected one.

**Call relations**: This test exercises the decision logic in `system_bwrap_launcher_for_path_with_probe` without depending on any real installed Bubblewrap. It proves that a fully capable system binary is preferred and that the `argv0` support flag is preserved.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (new, assert_eq!).


##### `tests::prefers_system_bwrap_when_system_bwrap_lacks_argv0`  (lines 181–197)

```
fn prefers_system_bwrap_when_system_bwrap_lacks_argv0()
```

**Purpose**: Checks that an older system Bubblewrap is still accepted if it lacks `--argv0` but has the required `--perms` option.

**Data flow**: It creates a temporary file as a fake binary. It supplies a fake capability probe reporting no `--argv0` support but yes `--perms` support, then verifies that the helper still returns a system launcher with `supports_argv0` set to false.

**Call relations**: This test protects compatibility with older Linux distribution packages. It confirms that `system_bwrap_launcher_for_path_with_probe` treats `--argv0` as optional, while still recording its absence for callers such as `preferred_bwrap_supports_argv0`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::ignores_system_bwrap_when_system_bwrap_lacks_perms`  (lines 200–212)

```
fn ignores_system_bwrap_when_system_bwrap_lacks_perms()
```

**Purpose**: Checks that a system Bubblewrap is rejected if it does not support `--perms`, which this sandbox needs.

**Data flow**: It creates a temporary file as a fake binary. It supplies a fake probe that reports `supports_perms: false`, then verifies that the helper returns nothing instead of a launcher.

**Call relations**: This test focuses on the required-feature gate inside `system_bwrap_launcher_for_path_with_probe`. It ensures the launcher-selection flow will fall back to the bundled Bubblewrap instead of using a system binary that cannot express needed file permissions.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::ignores_system_bwrap_when_system_bwrap_is_missing`  (lines 215–220)

```
fn ignores_system_bwrap_when_system_bwrap_is_missing()
```

**Purpose**: Checks that a nonexistent path is not treated as a usable Bubblewrap binary.

**Data flow**: It passes a path that should not exist into `system_bwrap_launcher_for_path`. The expected result is nothing, meaning no launcher is created.

**Call relations**: This test covers the first, simplest rejection case in the system-launcher path. It makes sure `system_bwrap_launcher_for_path` and its helper do not try to probe or normalize a missing file.

*Call graph*: 1 external calls (assert_eq!).


### Unix shell escalation protocol
These files define the Unix shell escalation library surface and its client-server protocol for intercepting execs, consulting policy, and performing escalated launches.

### `shell-escalation/src/lib.rs`

`other` · `cross-cutting`

This file does not contain the shell-escalation logic itself. Instead, it acts like a clean reception desk for the rest of the crate: outside code imports names from here, while the real Unix-specific implementation lives in the internal `unix` module. The `#[cfg(unix)]` lines mean all of this only exists when the code is compiled for a Unix-like operating system, such as Linux or macOS. That matters because privilege escalation, sockets, and process execution are highly operating-system-specific.

The file re-exports the important building blocks from the Unix implementation: policy types that decide whether escalation is allowed, session and server types that coordinate escalation, executor types that run shell commands, result and parameter types for execution, and wrapper entry points related to `execve` (a Unix system call that replaces the current process with another program). By re-exporting them here, the crate gives users one stable place to import from, instead of forcing them to know the internal file layout.

Without this file, callers would either be unable to access the library’s public API or would have to reach directly into the Unix module, making the project harder to use and easier to break when internals change.


### `shell-escalation/src/unix/mod.rs`

`orchestration` · `cross-cutting during shell command execution`

This module ties together the Unix shell-escalation protocol. The problem it solves is subtle: when a shell tries to run a command, the system may need to decide whether that command can run directly or must be escalated, meaning run by a trusted server process that has permission to do more. Without this layer, every command execution would either have to be trusted blindly or blocked without a clean way to ask for approval.

The design works like a staffed security desk. A patched shell does not simply execute every command on its own. Instead, an exec wrapper is invoked whenever the shell attempts an exec, which is the Unix operation that replaces the current process with a new program. The wrapper sends an escalation request through a Unix socket, which is a local communication channel between processes. The server reads the request and replies with either “Run” or “Escalate.”

A key detail is that each request carries its own response socket file descriptor. A file descriptor is a small operating-system handle for something like a socket or file. This lets many child processes share the same request socket while still receiving separate replies, so concurrent command attempts do not get their answers mixed up.

This file does not implement the protocol itself. Instead, it declares the submodules that do and re-exports the main types and entry points so the rest of the project can use the Unix escalation system through one clear module.


### `shell-escalation/src/unix/escalation_policy.rs`

`data_model` · `request handling`

When a client asks this system to run a program, the system must decide what to do before calling `execve`, the Unix operation that replaces the current process with another program. This file defines that decision-making doorway. It does not contain the rules itself; instead, it defines an `EscalationPolicy` trait, which is like a promise: any policy implementation must be able to look at the requested program path, the command-line arguments, and the working directory, then return an `EscalationDecision`.

The decision is returned asynchronously through `EscalationPolicyFuture`. In plain terms, that means the answer may not be ready immediately. A policy might need to ask a user, check another service, or wait on some other task. The boxed future type gives different policy implementations a common shape, so callers can treat them all the same.

This file matters because it separates “asking what should happen” from “how the answer is chosen.” Without this boundary, the command-running code would be tangled together with approval rules, making it harder to test, replace, or extend.


### `shell-escalation/src/unix/escalate_client.rs`

`io_transport` · `exec wrapper startup and command launch`

This code is used when a command is launched through the shell-escalation wrapper. The wrapper does not decide by itself whether to run the command. Instead, it connects back to a supervising process through a Unix socket, which is a local machine communication channel. Think of it like a private phone line between the wrapper and the supervisor.

First, the wrapper finds a socket file descriptor in an environment variable. A file descriptor is the operating system’s small number for an open file, socket, or similar resource. It then sends a handshake and opens a second connected socket pair for the real conversation. Over that connection, it sends the command to run, its arguments, the current working directory, and the environment variables, excluding the special variables used only for escalation.

The supervisor replies with one of three choices. If it says “run,” this wrapper directly replaces itself with the requested program using Unix `execv`, so the new program takes over the same process. If it says “escalate,” the wrapper sends duplicated copies of stdin, stdout, and stderr to the supervisor so an elevated child can use the same terminal streams. If it says “deny,” the wrapper prints a short message and exits with failure. The important detail is that standard input and output are duplicated before being sent away, so the wrapper does not accidentally close its own terminal handles too early.

#### Function details

##### `get_escalate_client`  (lines 19–28)

```
fn get_escalate_client() -> anyhow::Result<AsyncDatagramSocket>
```

**Purpose**: This function finds the already-open escalation socket that was passed to the process through an environment variable. It turns that raw operating-system file descriptor into an async datagram socket, which the wrapper can use to start talking to the supervisor.

**Data flow**: It reads the environment variable named by `ESCALATE_SOCKET_ENV_VAR`, parses its text value as a file descriptor number, checks that the number is not negative, and then wraps that number as an `AsyncDatagramSocket`. If the variable is missing, not a number, invalid, or cannot be turned into a socket, it returns an error instead.

**Call relations**: The main wrapper flow in `run_shell_escalation_execve_wrapper` calls this first, before it can send its handshake to the supervisor. Internally it relies on environment lookup and the socket constructor that takes ownership of a raw file descriptor.

*Call graph*: calls 1 internal fn (from_raw_fd); called by 1 (run_shell_escalation_execve_wrapper); 2 external calls (anyhow!, var).


##### `duplicate_fd_for_transfer`  (lines 30–34)

```
fn duplicate_fd_for_transfer(fd: impl AsFd, name: &str) -> anyhow::Result<OwnedFd>
```

**Purpose**: This function makes a safe duplicate of an open file descriptor before sending it to another process. It is used so the wrapper can hand a copy of stdin, stdout, or stderr to the supervisor without giving away the original handle it is still using.

**Data flow**: It receives something that can be viewed as a file descriptor, plus a friendly name used in error messages. It asks the operating system to clone that descriptor into a new owned descriptor. On success, the output is the duplicate; on failure, the error says which stream or descriptor could not be duplicated.

**Call relations**: When escalation is approved, `run_shell_escalation_execve_wrapper` calls this three times for stdin, stdout, and stderr before sending those copies across the socket. The test `tests::duplicate_fd_for_transfer_does_not_close_original` also calls it to prove that dropping the duplicate does not close the original.

*Call graph*: called by 2 (run_shell_escalation_execve_wrapper, duplicate_fd_for_transfer_does_not_close_original); 1 external calls (as_fd).


##### `run_shell_escalation_execve_wrapper`  (lines 36–124)

```
async fn run_shell_escalation_execve_wrapper(
    file: String,
    argv: Vec<String>,
) -> anyhow::Result<i32>
```

**Purpose**: This is the main client workflow for the shell-escalation exec wrapper. It asks the supervisor what to do with a requested command, then either forwards the command to an elevated runner, directly runs it in place, or reports that it was denied.

**Data flow**: It starts with the program path and argument list that the wrapper was asked to run. It gets the escalation socket, creates a connected socket pair, sends one end to the supervisor as a handshake, and sends an `EscalateRequest` containing the file, arguments, current directory, and cleaned environment. After receiving an `EscalateResponse`, it follows the requested action: for escalation, it sends duplicated terminal file descriptors and returns the elevated child’s exit code; for normal running, it converts the command and arguments to C strings and calls `execv`, which replaces the current process; for denial, it prints a message and returns exit code 1.

**Call relations**: This is the function that ties the whole file together. It calls `get_escalate_client` to open the first communication path, uses socket-pair creation and current-directory lookup to build the request, calls `duplicate_fd_for_transfer` when it must pass terminal streams onward, and uses low-level Unix execution if the supervisor says no escalation is needed.

*Call graph*: calls 4 internal fn (duplicate_fd_for_transfer, get_escalate_client, pair, current_dir); 9 external calls (new, last_os_error, eprintln!, stderr, stdin, stdout, execv, vars, null).


##### `tests::duplicate_fd_for_transfer_does_not_close_original`  (lines 133–143)

```
fn duplicate_fd_for_transfer_does_not_close_original()
```

**Purpose**: This test checks an important safety promise: duplicating a file descriptor for transfer must not make the original descriptor fragile or close it by accident.

**Data flow**: It creates a pair of connected Unix streams, records the raw file descriptor number for one side, duplicates that descriptor with `duplicate_fd_for_transfer`, and confirms the duplicate has a different descriptor number. It then drops the duplicate and asks the operating system whether the original descriptor is still valid. The expected result is that the original is still open.

**Call relations**: This test directly exercises `duplicate_fd_for_transfer`, because that helper is critical to the escalation path in `run_shell_escalation_execve_wrapper`. It protects against a bug where sending or dropping a copied descriptor could accidentally break the wrapper’s own stdin, stdout, stderr, or other live descriptor.

*Call graph*: calls 1 internal fn (duplicate_fd_for_transfer); 2 external calls (assert_ne!, pair).


### `shell-escalation/src/unix/escalate_server.rs`

`orchestration` · `during shell command execution and intercepted child-process launches`

This file exists because a shell may start many programs, and some of those programs may need permission that the original shell does not have. Instead of letting every intercepted program decide for itself, the shell is given a small environment overlay: a socket number and the path to an exec wrapper. The wrapper talks back to this server whenever a program is about to be run. Think of it like a checkpoint booth: each attempted program comes to the booth, asks “may I pass, should I be upgraded, or should I be stopped?”, and then follows the answer.

The main server creates a private Unix socket pair, starts a background task, and returns an `EscalationSession`. The caller then launches the shell using the session’s environment variables. When the shell’s wrapper contacts the server, the server reads the requested program, resolves relative paths against the working directory, asks an `EscalationPolicy` for a decision, and sends the wrapper a response. If escalation is approved, it receives any file descriptors, meaning open operating-system handles such as stdin or stdout, prepares a new command through `ShellCommandExecutor`, starts it, waits for it, and returns its exit code.

Cleanup is important here. Dropping the session closes the inherited socket, cancels background work, and aborts the task so leftover child processes do not survive unexpectedly.

#### Function details

##### `EscalationSession::env`  (lines 112–114)

```
fn env(&self) -> &HashMap<String, String>
```

**Purpose**: Returns the small set of environment variables that must be added to the shell process so intercepted exec calls can find this server. It is not a full environment, only the extra socket and wrapper settings.

**Data flow**: It reads the session’s stored environment map and gives the caller a shared view of it. Nothing is copied or changed; the caller can inspect it and merge it into the environment used for the shell.

**Call relations**: This is used when the process-launching side needs to inherit the session’s socket information. In the larger flow, `EscalateServer::start_session` creates the map, and callers such as the shell execution path read it before spawning the shell.

*Call graph*: called by 1 (inherited_fds).


##### `EscalationSession::close_client_socket`  (lines 116–120)

```
fn close_client_socket(&self)
```

**Purpose**: Closes the parent process’s copy of the client socket after the shell has inherited it. This prevents the parent from accidentally keeping the communication channel alive longer than intended.

**Data flow**: It locks the optional socket holder, takes the socket out if it is still present, and then lets it be dropped. Afterward, the session no longer owns that client socket copy.

**Call relations**: It is called both by the after-spawn hook used during shell launch and by session cleanup. This makes sure the socket stays open long enough for the shell to inherit it, but not longer.

*Call graph*: called by 2 (after_spawn, drop).


##### `EscalationSession::drop`  (lines 124–128)

```
fn drop(&mut self)
```

**Purpose**: Cleans up an escalation session when it goes out of scope. This is the safety net that stops background server work and closes inherited resources.

**Data flow**: It closes the client socket, signals cancellation to session workers, and aborts the background task. The before state is an active session; the after state is a session being torn down with its local resources released.

**Call relations**: Rust calls this automatically when an `EscalationSession` is dropped. It relies on `EscalationSession::close_client_socket` first, then uses cancellation and task abortion to stop work started by `EscalateServer::start_session`.

*Call graph*: calls 1 internal fn (close_client_socket); 2 external calls (cancel, abort).


##### `EscalateServer::new`  (lines 138–147)

```
fn new(shell_path: PathBuf, execve_wrapper: PathBuf, policy: Policy) -> Self
```

**Purpose**: Builds a server configuration from the shell path, the exec-wrapper path, and the policy that decides what may run. Callers use this once before starting sessions or running shell commands.

**Data flow**: It receives paths and a policy object, wraps the policy in shared ownership so background tasks can use it, and returns an `EscalateServer` ready to create sessions.

**Call relations**: Higher-level shell execution code and tests call this before using `exec` or `start_session`. The returned server later shares its policy with `escalate_task`.

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

**Purpose**: Runs one shell command while also enabling escalation checks for any programs that shell starts. It is the convenient one-shot path for “start a session, launch the shell, return the result.”

**Data flow**: It takes command parameters, a cancellation token, and a command executor. It starts an escalation session, builds a shell command such as `/bin/sh -lc ...`, validates the working directory as absolute, passes the session environment to the executor, and returns the captured command result.

**Call relations**: This function calls `EscalateServer::start_session` to set up the protocol first. It then hands actual process spawning to `ShellCommandExecutor::run`, and installs an after-spawn callback so `EscalationSession::close_client_socket` can release the parent socket copy.

*Call graph*: calls 2 internal fn (start_session, try_from); 4 external calls (clone, new, clone, vec!).


##### `EscalateServer::start_session`  (lines 189–223)

```
fn start_session(
        &self,
        parent_cancellation_token: CancellationToken,
        command_executor: Arc<dyn ShellCommandExecutor>,
    ) -> anyhow::Result<EscalationSession>
```

**Purpose**: Starts the background escalation service for one shell run and returns the environment overlay the shell needs. It does not launch the shell itself.

**Data flow**: It creates a connected socket pair, marks the client side as safe to pass through `exec`, starts `escalate_task` on the server side, and builds environment variables containing the client socket file descriptor and wrapper path. It returns an `EscalationSession` holding those pieces and cleanup controls.

**Call relations**: `EscalateServer::exec` calls this for the one-shot command path, and callers may also use it directly if they want to spawn the shell themselves. The background task it starts is `escalate_task`, which listens for intercepted exec requests.

*Call graph*: calls 2 internal fn (escalate_task, pair); called by 1 (exec); 7 external calls (clone, new, new, new, new, to_string_lossy, spawn).


##### `escalate_task`  (lines 226–262)

```
async fn escalate_task(
    socket: AsyncDatagramSocket,
    policy: Arc<dyn EscalationPolicy>,
    command_executor: Arc<dyn ShellCommandExecutor>,
    parent_cancellation_token: CancellationToken,
```

**Purpose**: Listens for new intercepted-exec connections from the wrapper and starts a worker for each one. It is the background receptionist for a session.

**Data flow**: It repeatedly waits on the datagram socket for exactly one transferred file descriptor, turns that descriptor into a stream socket, clones shared policy and executor references, and spawns a worker task. If cancellation is requested, it exits cleanly.

**Call relations**: `EscalateServer::start_session` starts this task. For each incoming connection, it hands the stream to `handle_escalate_session_with_policy`, which performs the actual decision and response.

*Call graph*: calls 2 internal fn (handle_escalate_session_with_policy, from_fd); called by 1 (start_session); 5 external calls (clone, clone, select!, spawn, error!).


##### `handle_escalate_session_with_policy`  (lines 264–379)

```
async fn handle_escalate_session_with_policy(
    socket: AsyncSocket,
    policy: Arc<dyn EscalationPolicy>,
    command_executor: Arc<dyn ShellCommandExecutor>,
    parent_cancellation_token: Cancel
```

**Purpose**: Processes one intercepted attempt to run a program. It decides whether the program runs normally, is denied, or is launched through an escalated path.

**Data flow**: It receives an `EscalateRequest` from the socket, resolves the program path, asks the policy for a decision, and sends a response. For escalation, it receives a second message with any file descriptors, asks the executor to prepare the command, spawns the child with the requested environment and descriptor mapping, waits for it, and sends back the exit code.

**Call relations**: `escalate_task` calls this for each wrapper connection. Tests also call it directly to verify each branch: normal run, denial-style response, escalation, relative path resolution, passed permissions, and file descriptor edge cases.

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

**Purpose**: Provides a test policy that always returns the same decision. This lets tests force the server down a specific path without depending on real policy rules.

**Data flow**: It ignores the requested program, arguments, and working directory, clones its stored decision, and returns it asynchronously. Nothing outside the policy is changed.

**Call relations**: Many tests install this policy through `EscalateServer::new` or direct calls to `handle_escalate_session_with_policy` so they can test server behavior for `Run` or `Escalate` decisions predictably.

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

**Purpose**: Checks that the server passes the expected resolved program path and working directory to the policy. It is used to prove relative paths are interpreted correctly.

**Data flow**: It receives the program and working directory, compares them with expected values, and then returns a normal-run decision. If the values are wrong, the test fails.

**Call relations**: The relative-path test uses this policy when calling `handle_escalate_session_with_policy`. That worker resolves the path first, then this policy confirms the result.

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

**Purpose**: Marks the normal shell-running path as unused in tests that only exercise escalated subcommands. If it is called, the test should fail.

**Data flow**: It receives the would-be shell command inputs but does not process them. It returns a future that panics as unreachable because those tests should never call this method.

**Call relations**: This executor is passed into `handle_escalate_session_with_policy` tests. Those tests only need `prepare_escalated_exec`, so any call to `run` would reveal that the wrong part of the flow was used.

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

**Purpose**: Prepares an escalated command by running exactly the requested program with its original arguments, directory, and environment. It keeps tests focused on the server’s protocol rather than sandbox-specific rewriting.

**Data flow**: It receives the program path, argument list, working directory, and environment. It builds a `PreparedExec` whose command starts with the program and then the original arguments after argv[0], keeps the working directory, keeps the environment, and preserves argv[0] as the process name.

**Call relations**: `handle_escalate_session_with_policy` calls this when a test policy chooses escalation. This helper hands back a straightforward command so the worker can spawn it and report its exit code.

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

**Purpose**: Marks the shell-running path as unused for permission-passing tests. Calling it would mean the test is exercising the wrong path.

**Data flow**: It receives shell launch inputs but ignores them and returns a future that panics as unreachable. No command is run and no state is changed.

**Call relations**: The permission test passes this executor into `handle_escalate_session_with_policy`, where only the escalated preparation method should be used.

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

**Purpose**: Verifies that the escalation permission details chosen by the policy reach the command executor unchanged. It then prepares a simple forwarded command for the test child process.

**Data flow**: It receives the program, arguments, working directory, environment, and requested execution mode. It compares the execution mode with the expected permissions, then returns a `PreparedExec` that forwards the original command.

**Call relations**: `handle_escalate_session_with_policy` calls this in the permission-passing test after the policy returns an escalation decision. The assertion proves the server did not drop or alter the permission request.

*Call graph*: calls 2 internal fn (to_path_buf, to_string_lossy); 4 external calls (pin, assert_eq!, prepare_escalated_exec, once).


##### `tests::wait_for_pid_file`  (lines 547–561)

```
async fn wait_for_pid_file(pid_file: &std::path::Path) -> anyhow::Result<i32>
```

**Purpose**: Waits until a child process writes its process ID to a file. This helps tests know when an escalated child has actually started.

**Data flow**: It receives a file path, repeatedly tries to read and parse it until a short deadline, and returns the parsed process ID. If the file never appears or cannot be parsed before the deadline, it returns an error.

**Call relations**: The session-drop test uses this after launching a long-running child. Once the PID is known, the test can check that dropping the session kills that child.

*Call graph*: 6 external calls (from_millis, from_secs, now, anyhow!, read_to_string, sleep).


##### `tests::process_exists`  (lines 563–569)

```
fn process_exists(pid: i32) -> bool
```

**Purpose**: Checks whether a process with a given process ID still exists. It uses the operating system’s signal check without actually killing the process.

**Data flow**: It receives a PID, calls `kill(pid, 0)`, and interprets the result. It returns true if the process exists or access is merely denied, and false if the system says there is no such process.

**Call relations**: `tests::wait_for_process_exit` uses this in a loop, and the session-drop test uses it to confirm the child starts before verifying cleanup.

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

**Purpose**: Tests that the one-shot `exec` path keeps the escalation socket open until the shell has been spawned, then runs the after-spawn cleanup hook. It fakes a successful shell command.

**Data flow**: It receives the environment overlay and after-spawn callback. It reads the socket file descriptor, verifies that it is open, invokes the callback, records that the callback ran, and returns a successful empty `ExecResult`.

**Call relations**: `EscalateServer::exec` calls this through the `ShellCommandExecutor` trait in the after-spawn test. The function proves that `exec` supplies the hook that closes the parent socket copy after spawning.

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

**Purpose**: Marks escalated subcommand preparation as unused in the `exec` after-spawn test. If called, the test should fail.

**Data flow**: It receives escalated-exec inputs but ignores them and returns a future that panics as unreachable. No prepared command is produced.

**Call relations**: The after-spawn test only exercises `EscalateServer::exec` and the shell-launch method. A call here would show that the test unexpectedly entered the intercepted escalation path.

*Call graph*: 2 external calls (pin, unreachable!).


##### `tests::wait_for_process_exit`  (lines 627–638)

```
async fn wait_for_process_exit(pid: i32) -> anyhow::Result<()>
```

**Purpose**: Waits for a process to disappear, with a timeout. It is used to prove cleanup actually kills a child rather than just requesting cancellation.

**Data flow**: It receives a PID, repeatedly checks whether that process still exists, and returns success when it is gone. If it remains alive past the deadline, it returns an error.

**Call relations**: The session-drop test calls this after dropping the `EscalationSession`. It depends on `tests::process_exists` to poll the operating system.

*Call graph*: 6 external calls (from_millis, from_secs, now, anyhow!, process_exists, sleep).


##### `tests::start_session_exposes_wrapper_env_overlay`  (lines 649–688)

```
async fn start_session_exposes_wrapper_env_overlay() -> anyhow::Result<()>
```

**Purpose**: Tests that starting a session returns only the wrapper and socket environment values, and that the socket stays valid until explicitly closed.

**Data flow**: It creates a server with sentinel paths, starts a session, reads the exported environment, checks the wrapper path and socket descriptor, then calls `close_client_socket` and confirms the socket holder is empty.

**Call relations**: This test uses `EscalateServer::new` and `EscalateServer::start_session` directly. It verifies the environment that later callers read through `EscalationSession::env`.

*Call graph*: calls 2 internal fn (run, new); 6 external calls (new, new, from, assert!, assert_eq!, assert_ne!).


##### `tests::exec_closes_parent_socket_after_shell_spawn`  (lines 691–722)

```
async fn exec_closes_parent_socket_after_shell_spawn() -> anyhow::Result<()>
```

**Purpose**: Tests that `EscalateServer::exec` closes the parent copy of the escalation socket immediately after spawning the shell. This avoids keeping the socket alive accidentally.

**Data flow**: It builds a server and a fake executor that checks the socket is open before the after-spawn hook. It runs a simple command through `exec`, receives a successful result, and confirms the hook was invoked.

**Call relations**: This test calls `EscalateServer::new` and `EscalateServer::exec`. Inside that flow, the fake executor’s `run` method validates the after-spawn behavior.

*Call graph*: calls 3 internal fn (run, new, current_dir); 7 external calls (clone, new, new, new, from, assert!, assert_eq!).


##### `tests::handle_escalate_session_respects_run_in_sandbox_decision`  (lines 725–761)

```
async fn handle_escalate_session_respects_run_in_sandbox_decision() -> anyhow::Result<()>
```

**Purpose**: Tests the normal-run decision path. When policy says to run without escalation, the server should simply tell the wrapper to continue.

**Data flow**: It creates a socket pair, starts `handle_escalate_session_with_policy` with a policy that always returns `Run`, sends an `EscalateRequest`, receives an `EscalateResponse`, and checks that the action is `Run`.

**Call relations**: This test calls the session handler directly rather than going through `escalate_task`. It verifies one branch of the handler’s policy decision logic.

*Call graph*: calls 4 internal fn (run, handle_escalate_session_with_policy, pair, try_from); 8 external calls (new, new, new, from, assert_eq!, format!, spawn, vec!).


##### `tests::handle_escalate_session_resolves_relative_file_against_request_workdir`  (lines 764–801)

```
async fn handle_escalate_session_resolves_relative_file_against_request_workdir() -> anyhow::Result<()>
```

**Purpose**: Tests that a relative program path in an intercepted request is resolved against the request’s working directory. This prevents policy checks from seeing misleading paths.

**Data flow**: It creates a temporary workspace, sends a request for `./bin/tool`, and uses an asserting policy to check that the handler converts it to the expected absolute path. The response is then checked as a normal-run response.

**Call relations**: This test calls `handle_escalate_session_with_policy` with `tests::AssertingEscalationPolicy`. The policy assertion happens after the handler resolves the path.

*Call graph*: calls 3 internal fn (handle_escalate_session_with_policy, pair, try_from); 9 external calls (new, new, new, from, assert_eq!, create_dir, new, spawn, vec!).


##### `tests::handle_escalate_session_executes_escalated_command`  (lines 804–846)

```
async fn handle_escalate_session_executes_escalated_command() -> anyhow::Result<()>
```

**Purpose**: Tests that the escalation branch actually launches the prepared command and returns its exit code. It proves the protocol goes beyond just sending an approval message.

**Data flow**: It sends an intercepted `/bin/sh` request with an environment variable, receives an escalation response, sends the follow-up super-exec message, and then receives the child’s exit code. The shell exits with a special code only if the environment was passed correctly.

**Call relations**: This test calls `handle_escalate_session_with_policy` with a deterministic escalate policy and the forwarding executor. The handler asks the executor for a command, spawns it, and returns the result.

*Call graph*: calls 4 internal fn (escalate, handle_escalate_session_with_policy, pair, current_dir); 8 external calls (new, new, from, from, new, assert_eq!, spawn, vec!).


##### `tests::RestoredFd::close_temporarily`  (lines 864–880)

```
fn close_temporarily(target_fd: i32) -> anyhow::Result<Self>
```

**Purpose**: Temporarily closes a chosen file descriptor while saving a duplicate so it can be restored later. This lets a test force the operating system to reuse a specific descriptor number.

**Data flow**: It receives a target descriptor number, duplicates it, closes the original descriptor number, and stores both the target number and saved duplicate. If duplication or closing fails, it returns an error.

**Call relations**: The file-descriptor overlap test calls this before receiving descriptors. Its companion `tests::RestoredFd::drop` restores the descriptor afterward.

*Call graph*: 4 external calls (last_os_error, close, dup, from_raw_fd).


##### `tests::RestoredFd::drop`  (lines 888–892)

```
fn drop(&mut self)
```

**Purpose**: Restores a temporarily closed file descriptor when the helper object is dropped. This keeps the test from leaving the process’s standard input or other descriptors broken.

**Data flow**: It takes the saved duplicate descriptor and copies it back onto the original target descriptor number. The process’s descriptor table is restored as closely as possible to its earlier state.

**Call relations**: Rust calls this automatically at the end of the overlap test or on early exit. It completes the setup started by `tests::RestoredFd::close_temporarily`.

*Call graph*: 2 external calls (as_raw_fd, dup2).


##### `tests::handle_escalate_session_accepts_received_fds_that_overlap_destinations`  (lines 896–966)

```
async fn handle_escalate_session_accepts_received_fds_that_overlap_destinations() -> anyhow::Result<()>
```

**Purpose**: Tests a tricky file-descriptor case where a received descriptor number is the same as the destination descriptor number. The server must still wire the child process’s stdin correctly.

**Data flow**: It creates a pipe, temporarily frees standard input, sends the pipe read end as a descriptor to be mapped to stdin, writes test data to the pipe, and checks that the escalated child reads it successfully. A zero exit code proves the descriptor mapping worked.

**Call relations**: This test calls `handle_escalate_session_with_policy` with escalation enabled. It uses `tests::RestoredFd::close_temporarily` to force the overlap case and relies on the handler’s pre-exec descriptor duplication loop.

*Call graph*: calls 4 internal fn (escalate, handle_escalate_session_with_policy, pair, current_dir); 12 external calls (new, new, new, from, assert_eq!, last_os_error, pipe, close_temporarily, from_raw_fd, from_raw_fd (+2 more)).


##### `tests::handle_escalate_session_passes_permissions_to_executor`  (lines 969–1023)

```
async fn handle_escalate_session_passes_permissions_to_executor() -> anyhow::Result<()>
```

**Purpose**: Tests that detailed permission requests from an escalation decision are passed to the shell command executor. This matters because the executor may need those permissions to choose the right sandbox or launch mode.

**Data flow**: It creates a policy decision containing additional network permission, sends an intercepted request, follows the escalation handshake, and checks for a successful child exit. The custom executor asserts that it received the same permission data.

**Call relations**: This test calls `handle_escalate_session_with_policy` with `tests::PermissionAssertingShellCommandExecutor`. The handler receives the policy’s execution details and hands them to the executor for verification.

*Call graph*: calls 4 internal fn (escalate, handle_escalate_session_with_policy, pair, current_dir); 11 external calls (new, new, default, new, from, new, assert_eq!, AdditionalPermissionProfile, Permissions, spawn (+1 more)).


##### `tests::dropping_session_aborts_intercept_workers_and_kills_spawned_child`  (lines 1026–1114)

```
async fn dropping_session_aborts_intercept_workers_and_kills_spawned_child() -> anyhow::Result<()>
```

**Purpose**: Tests that dropping an active escalation session stops worker tasks and kills an escalated child process. This guards against leaked long-running processes.

**Data flow**: It starts a session, manually performs the socket handshake, requests an escalated shell command that writes its PID and sleeps, waits until the child is alive, then drops the session. Finally it waits until the child process exits.

**Call relations**: This test uses `EscalateServer::new` and `EscalateServer::start_session`, then drives the same protocol that `escalate_task` and `handle_escalate_session_with_policy` serve. It confirms that `EscalationSession::drop` cancellation reaches spawned children.

*Call graph*: calls 5 internal fn (escalate, new, from_raw_fd, pair, current_dir); 13 external calls (new, new, new, from, new, new, assert!, assert_eq!, dup, wait_for_pid_file (+3 more)).


### Runtime integration
These files connect shared runtime command preparation with the Unix escalation backend so tool launches can be rewritten, sandboxed, and escalated when policy requires.

### `core/src/tools/runtimes/mod.rs`

`orchestration` · `command execution preparation`

When Codex runs a command for a user, it cannot simply pass the command straight to the operating system. It may need to run inside a sandbox, use a carefully prepared environment, preserve network proxy settings, or restore a saved shell state. This file is the shared toolbox for that preparation.

A useful way to think about it is a backstage crew before a performance. The command is the actor, but this file checks the stage: which directory it starts in, which environment variables are present, whether special PATH entries should be added, whether proxy settings should be removed for elevated runs, and whether a saved shell setup should be replayed first.

The file also protects against subtle platform problems. On Windows, elevated PowerShell sandbox runs are forced to skip user profiles, because the sandbox user and the real user profile can be mixed in an unsafe or invalid way. On Unix-like systems, shell commands may be wrapped so they first source a shell snapshot, then restore Codex-controlled environment values that the snapshot might overwrite.

Most functions here do not execute commands themselves. Instead, they produce safer command descriptions or rewritten argument lists that later runtime code can run.

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

**Purpose**: Turns a normal command line into the structured form expected by the sandbox system. It also rejects an empty command, because a sandbox cannot run “nothing.”

**Data flow**: It receives a list of command words, a working directory, environment variables, and optional extra permission settings. It takes the first word as the program, keeps the remaining words as arguments, converts the working directory into a URI-style path, copies the environment, and returns a sandbox-ready command object. If the command list is empty, it returns a rejection error instead.

**Call relations**: Tool runtime code calls this when it is about to run a command through sandboxing, including normal runs and zsh-fork attempts. It hands the sandbox layer a clean, validated command package rather than loose pieces.

*Call graph*: calls 1 internal fn (from_abs_path); called by 3 (run, try_run_zsh_fork, run).


##### `exec_env_for_sandbox_permissions`  (lines 57–68)

```
fn exec_env_for_sandbox_permissions(
    env: &HashMap<String, String>,
    sandbox_permissions: SandboxPermissions,
) -> HashMap<String, String>
```

**Purpose**: Adjusts the environment variables for the level of sandbox permission being used. In particular, it removes Codex-managed proxy settings when a command is being run with escalated permissions.

**Data flow**: It receives the current environment and the sandbox permission choice. It copies the environment, checks whether those permissions require escalation, and if a managed proxy is active, removes the proxy-related variables. It returns the cleaned environment copy.

**Call relations**: Runtime paths call this before launching commands, including elevated execution and zsh-fork flows. When proxy variables need to be removed, it delegates that cleanup to strip_managed_proxy_env.

*Call graph*: calls 2 internal fn (strip_managed_proxy_env, requires_escalated_permissions); called by 4 (run, prepare_escalated_exec, try_run_zsh_fork, run).


##### `strip_managed_proxy_env`  (lines 70–90)

```
fn strip_managed_proxy_env(env: &mut HashMap<String, String>)
```

**Purpose**: Removes Codex-owned network proxy settings from an environment map. This prevents a command from accidentally using Codex’s managed proxy in situations where that should not happen.

**Data flow**: It receives a mutable environment map. It deletes known proxy variables, removes custom certificate variables only when they point to Codex’s managed certificate bundle, and on macOS also removes Codex’s Git SSH proxy wrapper if it recognizes it. The same map is changed in place.

**Call relations**: exec_env_for_sandbox_permissions calls this when elevated permissions and a managed proxy are both present. User shell command execution can also call it directly when it needs to strip these proxy settings.

*Call graph*: called by 2 (execute_user_shell_command, exec_env_for_sandbox_permissions).


##### `prepend_path_entry`  (lines 99–116)

```
fn prepend_path_entry(env: &mut HashMap<String, String>, path_entry: &str) -> Option<String>
```

**Purpose**: Adds one directory to the front of PATH on Unix, while avoiding duplicates and empty entries. PATH is the list of folders the shell searches when you type a command name.

**Data flow**: It receives an environment map and a path string. If the new path is empty, it leaves everything unchanged. Otherwise, it builds a new PATH where the new directory comes first, removes old copies of that same directory and blank entries, stores the result back into the environment, and returns the new PATH value.

**Call relations**: RuntimePathPrepends::prepend uses this to record Codex-owned PATH additions, and prepend_zsh_fork_bin_to_path uses it for a temporary zsh-related path change.

*Call graph*: called by 2 (prepend, prepend_zsh_fork_bin_to_path); 1 external calls (once).


##### `RuntimePathPrepends::prepend`  (lines 129–135)

```
fn prepend(&mut self, env: &mut HashMap<String, String>, path_entry: &Path)
```

**Purpose**: Adds a Codex-owned directory to PATH and remembers that it was added. Remembering matters because the same PATH addition may need to be replayed after restoring a saved shell snapshot.

**Data flow**: It receives the tracked prepend list, the live environment map, and a filesystem path. It turns the path into text, prepends it to PATH using prepend_path_entry, removes any older record of the same entry, and stores it as the newest Codex-owned prepend.

**Call relations**: apply_package_path_prepend and apply_zsh_fork_path_prepend call this when runtime setup needs Codex tools or a zsh fork directory to appear first in command lookup.

*Call graph*: calls 1 internal fn (prepend_path_entry); called by 2 (apply_package_path_prepend, apply_zsh_fork_path_prepend); 1 external calls (to_string_lossy).


##### `RuntimePathPrepends::shell_exports_after_snapshot`  (lines 137–156)

```
fn shell_exports_after_snapshot(
        &self,
        explicit_env_overrides: &HashMap<String, String>,
    ) -> String
```

**Purpose**: Creates shell commands that reapply Codex-owned PATH entries after a shell snapshot has been loaded. It skips this if the user explicitly chose a PATH, because user intent should win.

**Data flow**: It reads the remembered PATH entries and the explicit environment overrides. If PATH is explicitly overridden, it returns an empty string. Otherwise, it builds shell export lines that put each remembered directory back at the front of PATH, safely quoted for the shell.

**Call relations**: maybe_wrap_shell_lc_with_snapshot calls this while building a wrapper script, so a restored shell snapshot does not accidentally erase PATH entries that Codex added for runtime setup.

*Call graph*: called by 1 (maybe_wrap_shell_lc_with_snapshot); 1 external calls (new).


##### `apply_package_path_prepend`  (lines 160–173)

```
fn apply_package_path_prepend(
    env: &mut HashMap<String, String>,
    runtime_path_prepends: &mut RuntimePathPrepends,
)
```

**Purpose**: Adds the installed package’s command directory to PATH when such a directory exists. This lets commands find tools shipped with the Codex package.

**Data flow**: It receives the live environment and the RuntimePathPrepends tracker. It looks up the current install context, checks whether the package layout has a PATH directory, and if so prepends that directory to PATH and records it. If no such directory exists, it does nothing.

**Call relations**: Runtime execution setup calls this before running commands. It uses RuntimePathPrepends::prepend so the PATH change is both applied now and remembered for possible shell snapshot restoration later.

*Call graph*: calls 2 internal fn (prepend, current); called by 2 (run, run).


##### `prepend_zsh_fork_bin_to_path`  (lines 176–184)

```
fn prepend_zsh_fork_bin_to_path(
    env: &mut HashMap<String, String>,
    shell_zsh_path: &Path,
) -> Option<String>
```

**Purpose**: Temporarily puts the directory containing a zsh fork binary at the front of PATH. This helps later command lookup find the intended zsh-related executable first.

**Data flow**: It receives an environment map and the path to a zsh executable. It finds that executable’s parent directory, prepends that directory to PATH, and returns the updated PATH. If the executable has no parent directory, it returns nothing and leaves PATH unchanged.

**Call relations**: try_run_zsh_fork calls this during its special zsh execution path. It relies on prepend_path_entry for the actual PATH rewriting.

*Call graph*: calls 1 internal fn (prepend_path_entry); called by 1 (try_run_zsh_fork); 1 external calls (parent).


##### `apply_zsh_fork_path_prepend`  (lines 187–196)

```
fn apply_zsh_fork_path_prepend(
    env: &mut HashMap<String, String>,
    runtime_path_prepends: &mut RuntimePathPrepends,
    shell_zsh_path: &Path,
)
```

**Purpose**: Adds the directory of a zsh fork executable to PATH and remembers that Codex added it. This is the tracked version used when the change must survive shell snapshot restoration.

**Data flow**: It receives the live environment, the RuntimePathPrepends tracker, and a zsh executable path. It finds the executable’s parent directory and asks the tracker to prepend it. If there is no parent directory, it does nothing.

**Call relations**: Runtime setup calls this before command runs that need the zsh fork path. It delegates to RuntimePathPrepends::prepend so later snapshot wrapping can replay the PATH entry.

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

**Purpose**: Adds PowerShell’s -NoProfile flag for elevated Windows sandbox runs when it is missing. This stops PowerShell from loading user profile scripts in a sandbox account that may still point at the real user’s profile folder.

**Data flow**: It receives the command arguments, the shell type, the sandbox type, and the Windows sandbox level. If the run is not elevated PowerShell inside the Windows restricted-token sandbox, it returns the command unchanged. If -NoProfile is already present, it also leaves it unchanged. Otherwise, it inserts -NoProfile immediately after the program name and returns the rewritten command.

**Call relations**: Runtime command preparation calls this before launching Windows PowerShell commands. The tests in this file call it with several command shapes to prove it changes only the elevated PowerShell sandbox case.

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

**Purpose**: On Unix-like systems, rewrites a shell command so it first loads a saved shell snapshot, then runs the original script. This lets a command start with the user’s expected shell state while still preserving Codex-required environment values.

**Data flow**: It receives the command arguments, session shell, optional snapshot path, explicit environment overrides, full live environment, and remembered PATH prepends. If the platform, snapshot, or command shape does not match, it returns the original command. Otherwise, it builds a new shell script that captures important environment values, sources the snapshot, restores overrides and proxy variables, reapplies Codex PATH additions when allowed, and finally execs the original shell command.

**Call relations**: User-shell command preparation and runtime execution call this when a shell snapshot may be active. It pulls together quoting, override export generation, proxy export generation, block joining, and remembered PATH prepend replay to produce one safe wrapper command.

*Call graph*: calls 5 internal fn (shell_exports_after_snapshot, build_override_exports, build_proxy_env_exports, join_shell_blocks, shell_single_quote); called by 4 (prepare_user_shell_exec_command, prepare_user_shell_exec_command_with_path_prepend, run, run); 3 external calls (cfg!, format!, vec!).


##### `build_override_exports`  (lines 315–324)

```
fn build_override_exports(explicit_env_overrides: &HashMap<String, String>) -> (String, String)
```

**Purpose**: Builds shell snippets that preserve explicit environment overrides across snapshot loading. Explicit overrides are policy choices, so a snapshot should not erase them.

**Data flow**: It receives a map of explicit environment overrides. It keeps only names that are safe shell variable names, sorts them for stable output, and asks build_override_exports_for_keys to create capture-and-restore shell code. It returns two strings: one to save values before the snapshot and one to restore them after.

**Call relations**: maybe_wrap_shell_lc_with_snapshot calls this while constructing its wrapper script. It delegates the repeated shell-code pattern to build_override_exports_for_keys.

*Call graph*: calls 1 internal fn (build_override_exports_for_keys); called by 1 (maybe_wrap_shell_lc_with_snapshot).


##### `build_proxy_env_exports`  (lines 326–350)

```
fn build_proxy_env_exports() -> (String, String)
```

**Purpose**: Builds shell snippets that preserve Codex-managed proxy environment variables across snapshot loading, but only when proxy state is relevant. This avoids a saved shell snapshot accidentally turning the proxy on or off incorrectly.

**Data flow**: It gathers known proxy and custom certificate variable names, filters them to safe shell variable names, sorts and deduplicates them, and creates capture-and-restore shell code. It also adds logic keyed on the proxy-active flag, plus platform-specific Git SSH proxy handling. It returns capture code and restore code as strings.

**Call relations**: maybe_wrap_shell_lc_with_snapshot calls this when building a snapshot wrapper. It uses build_override_exports_for_keys for the common variable-preservation pattern, build_codex_proxy_git_ssh_command_exports for Git SSH proxy details, and join_shell_blocks to combine optional script pieces.

*Call graph*: calls 3 internal fn (build_codex_proxy_git_ssh_command_exports, build_override_exports_for_keys, join_shell_blocks); called by 1 (maybe_wrap_shell_lc_with_snapshot); 1 external calls (format!).


##### `build_codex_proxy_git_ssh_command_exports`  (lines 367–369)

```
fn build_codex_proxy_git_ssh_command_exports() -> (String, String)
```

**Purpose**: Builds shell snippets for preserving Codex’s Git SSH proxy command when that feature exists. On macOS this protects a Codex-owned SSH wrapper; on other platforms it contributes no shell code.

**Data flow**: On macOS, it produces one shell block that records whether the Git SSH command variable was set and whether it had Codex’s marker, and another block that restores or unsets it carefully after a snapshot. On non-macOS builds, it returns two empty strings.

**Call relations**: build_proxy_env_exports calls this as part of assembling proxy preservation logic. Its output is then combined with the broader proxy capture and restore blocks.

*Call graph*: called by 1 (build_proxy_env_exports); 2 external calls (new, format!).


##### `build_override_exports_for_keys`  (lines 371–400)

```
fn build_override_exports_for_keys(variable_prefix: &str, keys: &[&str]) -> (String, String)
```

**Purpose**: Creates reusable shell code for saving and restoring a list of environment variables. It is the shared template behind both explicit override preservation and proxy variable preservation.

**Data flow**: It receives a prefix for temporary variable names and a list of environment variable names. If the list is empty, it returns empty strings. Otherwise, it builds capture lines that remember whether each variable was set and what its value was, plus restore lines that either export the old value or unset the variable.

**Call relations**: build_override_exports and build_proxy_env_exports call this so they do not each have to hand-write the same capture-and-restore shell pattern.

*Call graph*: called by 2 (build_override_exports, build_proxy_env_exports); 1 external calls (new).


##### `join_shell_blocks`  (lines 402–408)

```
fn join_shell_blocks(blocks: impl IntoIterator<Item = String>) -> String
```

**Purpose**: Combines optional shell script fragments into one clean script section. Empty fragments are skipped so the generated script does not collect unnecessary blank pieces.

**Data flow**: It receives a collection of strings. It drops empty strings, joins the remaining blocks with newline characters, and returns the combined string.

**Call relations**: maybe_wrap_shell_lc_with_snapshot and build_proxy_env_exports use this when several pieces of generated shell code may or may not be present depending on platform and settings.

*Call graph*: called by 2 (build_proxy_env_exports, maybe_wrap_shell_lc_with_snapshot); 1 external calls (into_iter).


##### `is_valid_shell_variable_name`  (lines 410–419)

```
fn is_valid_shell_variable_name(name: &str) -> bool
```

**Purpose**: Checks whether a string is safe to use as a shell variable name. This prevents generated shell code from treating invalid or dangerous text as a variable.

**Data flow**: It receives a name string. It rejects an empty name, requires the first character to be a letter or underscore, and requires the rest to be letters, digits, or underscores. It returns true only when the name fits those shell-variable rules.

**Call relations**: The export-building helpers use this check before generating shell code for environment variable names, so only safe names are included in wrapper scripts.


##### `shell_single_quote`  (lines 421–423)

```
fn shell_single_quote(input: &str) -> String
```

**Purpose**: Escapes text so it can be safely placed inside single quotes in a shell script. This matters because paths and command text may contain quote characters.

**Data flow**: It receives a text string and replaces each single quote with the standard shell-safe sequence that closes the quote, inserts a literal quote, and reopens the quote. It returns the escaped text.

**Call relations**: maybe_wrap_shell_lc_with_snapshot calls this when embedding paths, shell names, scripts, and trailing arguments into the generated wrapper script.

*Call graph*: called by 1 (maybe_wrap_shell_lc_with_snapshot).


##### `disable_powershell_profile_tests::inserts_no_profile_for_elevated_windows_sandbox`  (lines 431–454)

```
fn inserts_no_profile_for_elevated_windows_sandbox()
```

**Purpose**: Tests that an elevated Windows PowerShell sandbox command gets -NoProfile inserted. This confirms the main safety rewrite happens in the expected case.

**Data flow**: It builds a PowerShell command without -NoProfile, passes it with elevated Windows sandbox settings into disable_powershell_profile_for_elevated_windows_sandbox, and checks that the returned command has -NoProfile immediately after the executable.

**Call relations**: The Rust test runner calls this test. The test exercises disable_powershell_profile_for_elevated_windows_sandbox directly and verifies its output.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::inserts_no_profile_before_encoded_command`  (lines 457–480)

```
fn inserts_no_profile_before_encoded_command()
```

**Purpose**: Tests that -NoProfile is inserted before PowerShell’s -EncodedCommand option. This matters because encoded commands are another common way to pass scripts to PowerShell.

**Data flow**: It creates a PowerShell command using -EncodedCommand, runs it through the rewrite function with elevated Windows sandbox settings, and checks that -NoProfile was inserted before the encoded-command flag.

**Call relations**: The Rust test runner calls this test. It focuses on disable_powershell_profile_for_elevated_windows_sandbox and proves the insertion point is correct for encoded commands.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::preserves_existing_no_profile`  (lines 483–499)

```
fn preserves_existing_no_profile()
```

**Purpose**: Tests that the rewrite does not add a duplicate -NoProfile flag. A command that already asks PowerShell to skip profiles should be left alone.

**Data flow**: It builds a PowerShell command that already contains -NoProfile, passes it to the rewrite function with elevated Windows sandbox settings, and checks that the returned command is exactly the original command.

**Call relations**: The Rust test runner calls this test. It protects disable_powershell_profile_for_elevated_windows_sandbox from producing redundant or surprising command arguments.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::leaves_legacy_restricted_token_backend_alone`  (lines 502–517)

```
fn leaves_legacy_restricted_token_backend_alone()
```

**Purpose**: Tests that the old restricted-token Windows sandbox level is not changed. The -NoProfile insertion is only intended for the elevated sandbox mode.

**Data flow**: It creates a normal PowerShell command, passes it with the restricted-token sandbox level rather than elevated, and checks that the command comes back unchanged.

**Call relations**: The Rust test runner calls this test. It verifies that disable_powershell_profile_for_elevated_windows_sandbox is narrowly targeted and does not alter older sandbox behavior.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::leaves_unsandboxed_attempts_alone`  (lines 520–535)

```
fn leaves_unsandboxed_attempts_alone()
```

**Purpose**: Tests that unsandboxed PowerShell commands are not rewritten. The special profile problem only applies to the elevated Windows sandbox case.

**Data flow**: It builds a PowerShell command, passes it with no sandbox but with the elevated level value, and checks that the command remains unchanged.

**Call relations**: The Rust test runner calls this test. It confirms disable_powershell_profile_for_elevated_windows_sandbox requires the specific Windows sandbox type before changing anything.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


##### `disable_powershell_profile_tests::leaves_non_powershell_alone`  (lines 538–553)

```
fn leaves_non_powershell_alone()
```

**Purpose**: Tests that non-PowerShell commands are not given PowerShell-only flags. This prevents the rewrite from breaking Bash or other shells.

**Data flow**: It builds a Bash command, passes it with Windows restricted-token sandbox settings, and checks that the command is returned unchanged.

**Call relations**: The Rust test runner calls this test. It verifies that disable_powershell_profile_for_elevated_windows_sandbox first checks the shell type before inserting PowerShell-specific arguments.

*Call graph*: calls 1 internal fn (disable_powershell_profile_for_elevated_windows_sandbox); 2 external calls (assert_eq!, vec!).


### `core/src/tools/runtimes/shell/unix_escalation.rs`

`orchestration` · `request handling`

This file exists because shell commands are tricky: a harmless-looking shell script can start other programs, touch files, or use the network. The code here uses a Zsh fork backend, meaning a controlled Zsh process plus an exec wrapper watches each program the shell tries to start. Before that program actually runs, Codex can check policy, ask a human or Guardian service for approval, and decide whether to run it normally, run it with broader permissions, or block it.

The main flow starts by checking whether the Zsh fork feature is available and appropriate for the user’s shell. It then builds a sandboxed command, prepares the environment, and starts an escalation server. Think of the escalation server like a checkpoint booth: every executable the shell tries to launch must stop there first.

`CoreShellActionProvider` decides what should happen at the checkpoint. It compares the command against execution policy rules, respects the current approval settings, and may run hooks, ask Guardian, or prompt the user. `CoreShellCommandExecutor` is the part that actually runs commands, either inside the sandbox or with an approved permission change. The file also converts execution results into the shell tool’s normal output format and turns timeouts or sandbox denials into clear errors.

#### Function details

##### `approval_sandbox_permissions`  (lines 89–103)

```
fn approval_sandbox_permissions(
    sandbox_permissions: SandboxPermissions,
    additional_permissions_preapproved: bool,
) -> SandboxPermissions
```

**Purpose**: This helper adjusts which sandbox permission mode should be used when asking for approval. If extra permissions were already approved ahead of time, it treats that request like the normal default mode instead of asking again for the same thing.

**Data flow**: It receives the requested sandbox permission mode and a yes-or-no flag saying whether extra permissions are already preapproved. If the mode is “with additional permissions” and the flag is true, it changes the mode to “use default”; otherwise it leaves the mode unchanged. It returns the permission mode that later approval logic should consider.

**Call relations**: Both `try_run_zsh_fork` and `prepare_unified_exec_zsh_fork` call this while setting up the approval policy for a shell run. Its result is stored in `CoreShellActionProvider`, which later uses it when deciding whether a command needs more permission.

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

**Purpose**: This is the main path for running a shell command through the Zsh fork escalation system. It checks that the feature can be used, prepares the sandboxed command, starts the escalation server, runs the command, and returns the command output.

**Data flow**: It takes the shell request, the current sandbox attempt, the tool context, and the command arguments. It verifies that Zsh fork is configured, enabled, and being used with a Zsh user shell. It then builds the sandbox command and environment, extracts the shell script from the command line, creates a command executor and approval policy, starts the escalation server, waits for execution, and converts the result into normal tool output. If setup is not suitable, it returns `None`; if the run fails or is rejected, it returns an error.

**Call relations**: `maybe_run_shell_command` calls this when it wants to try the Zsh fork backend. This function ties together helpers such as `extract_shell_script`, `approval_sandbox_permissions`, and `map_exec_result`, and it creates the two central collaborators: `CoreShellActionProvider` for approval decisions and `CoreShellCommandExecutor` for actual process execution.

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

**Purpose**: This prepares the Zsh fork escalation machinery for the unified exec path, without immediately running the command. It creates an escalation session and adds the session’s environment variables to the execution request.

**Data flow**: It receives a unified execution request, an existing low-level execution request, tool context, and paths to the Zsh and exec-wrapper programs. It checks that the command is really invoking the configured Zsh path, builds the command executor and approval policy, starts an escalation session, then copies the session’s environment variables into the execution request. It returns a prepared request plus the live escalation session, or `None` if this command should fall back to another backend.

**Call relations**: `maybe_prepare_unified_exec` calls this while preparing a unified execution. Like `try_run_zsh_fork`, it uses `extract_shell_script` and `approval_sandbox_permissions`, but instead of running immediately it hands back `PreparedUnifiedExecZshFork` so the caller can continue the broader unified exec flow.

*Call graph*: calls 4 internal fn (approval_sandbox_permissions, extract_shell_script, new, unlimited); called by 1 (maybe_prepare_unified_exec); 7 external calls (clone, new, new, to_path_buf, to_string_lossy, new, warn!).


##### `execve_prompt_is_rejected_by_policy`  (lines 354–372)

```
fn execve_prompt_is_rejected_by_policy(
    approval_policy: AskForApproval,
    decision_source: &DecisionSource,
) -> Option<&'static str>
```

**Purpose**: This checks whether the current approval settings forbid asking for approval at all. It prevents the system from prompting the user when configuration says prompts are not allowed.

**Data flow**: It receives the approval policy and the reason a prompt would be needed. If approval is set to never, or if granular approval settings disallow this kind of prompt, it returns a fixed rejection reason. Otherwise it returns nothing, meaning a prompt is allowed.

**Call relations**: `CoreShellActionProvider::process_decision` calls this when policy says a command needs a prompt. If this helper says prompting is forbidden, the command is denied instead of showing a prompt.

*Call graph*: called by 1 (process_decision).


##### `CoreShellActionProvider::decision_driven_by_policy`  (lines 375–380)

```
fn decision_driven_by_policy(matched_rules: &[RuleMatch], decision: Decision) -> bool
```

**Purpose**: This tells whether a policy decision came from an explicit policy rule rather than a built-in fallback guess. That distinction matters because explicit rules can justify different escalation behavior.

**Data flow**: It receives the list of matched policy rules and the final allow, prompt, or forbid decision. It scans the rules and returns true if any non-heuristic rule produced that same decision. It does not change anything.

**Call relations**: `CoreShellActionProvider::determine_action` uses this after evaluating policy. The result helps it decide whether the command was covered by a real rule and whether escalation should mean unsandboxed execution or the normal turn settings.

*Call graph*: 1 external calls (iter).


##### `CoreShellActionProvider::shell_request_escalation_execution`  (lines 382–411)

```
fn shell_request_escalation_execution(
        sandbox_permissions: SandboxPermissions,
        permission_profile: &PermissionProfile,
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
```

**Purpose**: This translates a shell request’s sandbox permission setting into the kind of execution the escalation system should perform. In plain terms, it decides what “run with more permission” actually means for this request.

**Data flow**: It receives the requested sandbox permission mode, the current permission profile, the file-system sandbox policy, and any extra requested permissions. For default permissions it returns the turn’s default execution. For required escalation it chooses unsandboxed execution only if the current policy allows that. For additional permissions it returns a resolved permission profile when extra permissions exist, otherwise it falls back to the turn default.

**Call relations**: `CoreShellActionProvider::determine_action` calls this when the command was not matched by an explicit policy rule and needs the request’s own escalation semantics. It relies on `unsandboxed_execution_allowed` to avoid promising unsandboxed execution when the sandbox policy forbids it.

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

**Purpose**: This asks for permission to run a command when policy requires a human or external approval step. It first gives automation hooks a chance to allow or deny, then routes to Guardian if configured, and finally falls back to the normal user prompt.

**Data flow**: It receives the executable path, arguments, working directory, a stopwatch for timeout accounting, and any extra permissions being requested. It builds a displayable command, pauses the execution timer while waiting for approval, runs permission-request hooks, optionally sends a Guardian approval request, or asks the session to prompt the user. It returns the review decision, plus any Guardian review id or rejection message needed later.

**Call relations**: `CoreShellActionProvider::process_decision` calls this only when the execution policy says the command should be prompted and prompting is allowed. This function hands back the decision that `process_decision` converts into run, escalate, deny, timeout, or abort behavior.

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

**Purpose**: This converts a policy result into an actual action for the intercepted command. It is where “allow,” “prompt,” and “forbid” become “run now,” “run with approved permissions,” or “deny.”

**Data flow**: It receives the policy decision, whether more permission is needed, command details, prompt permissions, the planned escalation style, and where the decision came from. If the decision forbids execution, it denies. If the decision asks for a prompt, it checks whether prompting is allowed, asks for approval when possible, and then interprets the review result. If the decision allows execution, it either runs normally or escalates depending on the `needs_escalation` flag. It returns an `EscalationDecision`.

**Call relations**: `CoreShellActionProvider::determine_action` calls this after it has evaluated policy and calculated the escalation mode. It calls `execve_prompt_is_rejected_by_policy` before prompting and `CoreShellActionProvider::prompt` when approval is needed.

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

**Purpose**: This is the escalation policy’s main decision point. Whenever the wrapped shell tries to start a program, this function decides whether that program may run, needs approval, needs broader permissions, or must be blocked.

**Data flow**: It receives the program path, command arguments, and working directory for an intercepted execution. It reads the current execution policy, evaluates the command, checks whether the decision came from an explicit rule, checks what sandbox escalation is possible, chooses the right escalation style, and passes everything to `process_decision`. It returns the final escalation decision used by the shell escalation server.

**Call relations**: The escalation server calls this through the `EscalationPolicy` interface whenever a child process is intercepted. It uses `evaluate_intercepted_exec_policy`, `decision_driven_by_policy`, `shell_request_escalation_execution`, and `process_decision` to move from raw command details to an enforceable action.

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

**Purpose**: This checks an intercepted command against the execution policy. It prepares one or more possible command forms for policy matching, then asks the policy engine for an allow, prompt, or forbid result.

**Data flow**: It receives the policy, program path, arguments, and context such as approval settings and sandbox permissions. Depending on a feature flag, it either uses the exact intercepted executable or tries to parse shell-wrapper text into candidate commands. It also provides a fallback decision for commands that match no explicit rule. It returns a full policy evaluation, including the decision and matched rules.

**Call relations**: `CoreShellActionProvider::determine_action` calls this before making any escalation choice. If shell-wrapper parsing is enabled, it calls `commands_for_intercepted_exec_policy`; otherwise it evaluates the single normalized program-and-arguments command.

*Call graph*: calls 1 internal fn (commands_for_intercepted_exec_policy); called by 1 (determine_action); 2 external calls (check_multiple_with_options, vec!).


##### `commands_for_intercepted_exec_policy`  (lines 750–778)

```
fn commands_for_intercepted_exec_policy(
    program: &AbsolutePathBuf,
    argv: &[String],
) -> CandidateCommands
```

**Purpose**: This tries to turn a shell invocation like `zsh -lc "some command"` into the actual command or commands inside the shell script. That can make policy checks more precise when shell parsing is enabled.

**Data flow**: It receives the shell program path and its arguments. If the arguments look like a simple `-c` or `-lc` shell script, it tries first to parse plain commands, then to parse a single command prefix. If parsing succeeds, it returns those command candidates and records whether complex parsing was used. If not, it returns the original program and arguments as one command.

**Call relations**: `evaluate_intercepted_exec_policy` calls this only when shell-wrapper parsing is enabled. The file deliberately keeps that mode disabled by default because direct exec interception is more reliable than guessing from shell text.

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

**Purpose**: This runs the original shell command inside the configured sandbox, with the escalation session’s wrapper variables added to the environment. It is the actual process-launch step for the Zsh fork path.

**Data flow**: It receives a small environment overlay, a cancellation token, and an optional callback to run after spawning the process. It starts from the executor’s stored environment, copies in only the wrapper-related variables, builds an execution request with sandbox, network, permission, and timeout settings, and asks the sandboxing layer to run it. It returns an `ExecResult` containing exit code, output text, duration, and timeout status.

**Call relations**: The escalation server calls this through the `ShellCommandExecutor` interface when it is ready to start the shell process. The result later flows back to `try_run_zsh_fork`, which converts it with `map_exec_result`.

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

**Purpose**: This prepares a specific intercepted child command to run with the permission level chosen by the policy decision. It does not decide whether escalation is allowed; it builds the command shape for the already-approved execution style.

**Data flow**: It receives the intercepted program, arguments, working directory, environment, and requested escalation execution mode. It combines the program and arguments into a clean command vector, validates that `argv[0]` exists, then either prepares an unsandboxed command environment or delegates to `prepare_sandboxed_exec` for sandboxed execution with default, additional, or resolved permissions. It returns a `PreparedExec` containing command, directory, environment, and optional `arg0`.

**Call relations**: The escalation server calls this through the `ShellCommandExecutor` interface after `CoreShellActionProvider::determine_action` has approved an escalated run. For sandboxed forms, it hands the details to `CoreShellCommandExecutor::prepare_sandboxed_exec`.

*Call graph*: calls 4 internal fn (exec_env_for_sandbox_permissions, prepare_sandboxed_exec, join_program_and_argv, to_path_buf); 2 external calls (pin, anyhow!).


##### `CoreShellCommandExecutor::prepare_sandboxed_exec`  (lines 948–1012)

```
fn prepare_sandboxed_exec(
        &self,
        params: PrepareSandboxedExecParams<'_>,
    ) -> anyhow::Result<PreparedExec>
```

**Purpose**: This builds the exact command line and environment needed to run an approved command inside the selected sandbox. It translates a permission profile into a concrete sandbox execution request.

**Data flow**: It receives a command, working directory, environment, permission profile, and optional extra permissions. It converts the permission profile into file-system and network sandbox policies, selects the appropriate sandbox backend, packages the command with its directory and environment, asks the sandbox manager to transform it into a runnable form, applies network proxy environment variables if needed, and returns a prepared command.

**Call relations**: `CoreShellCommandExecutor::prepare_escalated_exec` calls this for all escalation modes that still run inside a sandbox. This function is the bridge from high-level permission choices to the low-level sandbox command format.

*Call graph*: calls 3 internal fn (from_sandbox_exec_request, new, from_abs_path); called by 1 (prepare_escalated_exec).


##### `extract_shell_script`  (lines 1022–1045)

```
fn extract_shell_script(command: &[String]) -> Result<ParsedShellCommand, ToolError>
```

**Purpose**: This finds the actual shell script text inside a command line intended for Zsh fork execution. It also records whether the shell was invoked as a login shell.

**Data flow**: It receives the full command argument list. Because sandbox wrappers may add extra arguments before the shell, it scans every three-argument window looking for `program -c script` or `program -lc script`. If found, it returns the program path, script text, and login-shell flag. If not found, it rejects the command as an unexpected format.

**Call relations**: `try_run_zsh_fork` uses this before starting the escalation server, and `prepare_unified_exec_zsh_fork` uses it to confirm the unified exec command is suitable for Zsh fork handling.

*Call graph*: called by 2 (prepare_unified_exec_zsh_fork, try_run_zsh_fork); 1 external calls (Rejected).


##### `map_exec_result`  (lines 1047–1074)

```
fn map_exec_result(
    sandbox: SandboxType,
    result: ExecResult,
) -> Result<ExecToolCallOutput, ToolError>
```

**Purpose**: This converts the Zsh fork executor’s raw result into the normal shell tool output format. It also turns timeouts and likely sandbox denials into structured errors.

**Data flow**: It receives the sandbox type and an execution result containing exit code, output text, duration, and timeout status. It builds an `ExecToolCallOutput`. If the command timed out, it returns a timeout error containing the captured output. If the output looks like a sandbox denial, it returns a sandbox-denied error. Otherwise it returns the normal output.

**Call relations**: `try_run_zsh_fork` calls this after the escalation server finishes running the command. It is the final cleanup step before the shell runtime reports success or failure to its caller.

*Call graph*: calls 2 internal fn (is_likely_sandbox_denied, new); called by 1 (try_run_zsh_fork); 3 external calls (new, Codex, Sandbox).


##### `join_program_and_argv`  (lines 1082–1086)

```
fn join_program_and_argv(program: &AbsolutePathBuf, argv: &[String]) -> Vec<String>
```

**Purpose**: This makes a clean display and policy command from an intercepted executable path and its argument vector. It avoids showing the original `argv[0]` twice.

**Data flow**: It receives the normalized executable path and the intercepted argument list, where the first argument is normally the program name as the process saw it. It creates a new vector starting with the normalized path, then appends all arguments after `argv[0]`. The result is a command vector suitable for prompts, policy checks, and prepared execution.

**Call relations**: `CoreShellActionProvider::prompt` uses this to show the user or Guardian the command being requested. `CoreShellCommandExecutor::prepare_escalated_exec` uses it to build the command that will actually be prepared for escalated execution.

*Call graph*: calls 1 internal fn (to_string_lossy); called by 2 (prompt, prepare_escalated_exec); 1 external calls (once).
