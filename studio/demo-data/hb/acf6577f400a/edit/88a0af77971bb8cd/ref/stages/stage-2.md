# Early process hardening and runtime bootstrap  `stage-2`

This stage is the earliest bootstrap layer, running before the application enters its main logic. Its job is to make the process safe, deterministic, and correctly shaped for everything that follows: it hardens the OS process, fixes global crypto/TLS behavior, and establishes the execution environment and runtime scaffolding that later stages assume already exist.

process-hardening/src/lib.rs runs first to reduce attack surface during startup. It applies platform-specific protections such as disabling core dumps or debugger attachment where supported, and strips dangerous dynamic-loader environment variables so inherited process state cannot redirect libraries or otherwise tamper with execution.

utils/rustls-provider/src/lib.rs then performs a one-time, process-wide rustls initialization, forcing use of the aws-lc-rs provider and checking that the selected backend supports the required signature scheme. This prevents ambiguous crypto backend selection later.

arg0/src/lib.rs ties the bootstrap together at the executable boundary. It interprets argv[0]/argv[1] to dispatch the single binary as multiple helper commands, creates temporary PATH aliases so re-execed subprocesses resolve consistently, and initializes the process environment and Tokio runtime in a way that preserves those aliases for the rest of the program’s lifetime.

## Files in this stage

### Process hardening
Apply the earliest OS-level protections and environment sanitization before broader runtime bootstrap begins.

### `process-hardening/src/lib.rs`

`util` · `startup`

This crate is intended to run as early as possible, ideally from a constructor before `main`, so hostile environment state or debugger attachment opportunities are reduced before the rest of the application initializes. `pre_main_hardening` is the cross-platform dispatcher: compile-time `cfg` gates select Linux/Android, macOS, BSD, or Windows behavior.

On Linux/Android, `pre_main_hardening_linux` calls `libc::prctl(PR_SET_DUMPABLE, 0, ...)` to mark the process non-dumpable, exits with a dedicated code if that fails, then sets `RLIMIT_CORE` to zero and removes all environment variables whose raw byte keys start with `LD_`. macOS uses `ptrace(PT_DENY_ATTACH, ...)` instead, then also zeroes core limits and removes `DYLD_` variables. BSD currently applies the core-limit and `LD_` cleanup subset. Windows is a stub. The separate public `disable_process_dumping` exposes just the Linux non-dumpable operation as a recoverable `std::io::Result<()>` rather than terminating.

The Unix helpers are careful about non-UTF-8 environment keys. `env_keys_with_prefix` operates on `OsString` pairs and checks prefixes using raw bytes via `OsStrExt::as_bytes`, so loader variables with invalid UTF-8 are still detected. `remove_env_vars_with_prefix` first collects matching keys, then removes them, avoiding mutation during iteration. Tests specifically verify both non-UTF-8 handling and exact prefix filtering.

#### Function details

##### `pre_main_hardening`  (lines 12–25)

```
fn pre_main_hardening()
```

**Purpose**: Dispatches to the platform-appropriate hardening routine at process startup. Its behavior is entirely determined by compile-time target OS configuration.

**Data flow**: It takes no arguments and, through `#[cfg]`-guarded branches, invokes exactly the relevant OS-specific function for the current target. It returns `()` and may terminate the process indirectly if a delegated hardening step fails.

**Call relations**: This is the crate’s top-level entry used by pre-main initialization code. It delegates all real work to the OS-specific helpers so each platform’s policy remains isolated.

*Call graph*: calls 4 internal fn (pre_main_hardening_bsd, pre_main_hardening_linux, pre_main_hardening_macos, pre_main_hardening_windows).


##### `pre_main_hardening_linux`  (lines 44–61)

```
fn pre_main_hardening_linux()
```

**Purpose**: Applies Linux/Android hardening by disabling dumpability, zeroing core-dump limits, and clearing `LD_` environment variables. It treats failure of the dumpability or rlimit steps as fatal startup errors.

**Data flow**: It calls `libc::prctl(PR_SET_DUMPABLE, 0, ...)`, checks the return code, and on nonzero prints the last OS error and exits with `PRCTL_FAILED_EXIT_CODE`. On success it calls `set_core_file_size_limit_to_zero()` and `remove_env_vars_with_prefix(b"LD_")`. It mutates process state via kernel syscalls and environment-variable removal.

**Call relations**: Only `pre_main_hardening` invokes this, on Linux/Android builds. It delegates the shared core-limit and environment cleanup work to helper functions after performing the Linux-specific `prctl` step.

*Call graph*: calls 2 internal fn (remove_env_vars_with_prefix, set_core_file_size_limit_to_zero); called by 1 (pre_main_hardening); 3 external calls (eprintln!, prctl, exit).


##### `disable_process_dumping`  (lines 65–72)

```
fn disable_process_dumping() -> std::io::Result<()>
```

**Purpose**: Provides a recoverable Linux-only API to mark the current process non-dumpable. Unlike the pre-main hardening path, it reports failure as an `io::Result` instead of exiting.

**Data flow**: It performs `libc::prctl(PR_SET_DUMPABLE, 0, ...)`, returning `Ok(())` when the syscall succeeds and `Err(std::io::Error::last_os_error())` otherwise. It changes kernel process state but does not touch environment variables or limits.

**Call relations**: This function stands apart from the startup dispatcher as a reusable runtime primitive for Linux callers that want explicit error handling rather than process termination.

*Call graph*: 2 external calls (last_os_error, prctl).


##### `pre_main_hardening_bsd`  (lines 75–80)

```
fn pre_main_hardening_bsd()
```

**Purpose**: Applies the BSD subset of hardening currently implemented: disabling core dumps and clearing `LD_` environment variables. It omits ptrace-specific logic present on Linux/macOS.

**Data flow**: It calls `set_core_file_size_limit_to_zero()` and `remove_env_vars_with_prefix(b"LD_")`, thereby mutating process resource limits and environment state. It returns `()`.

**Call relations**: The top-level dispatcher calls this on FreeBSD/OpenBSD targets. It reuses the shared Unix helpers rather than implementing BSD-specific low-level syscalls here.

*Call graph*: calls 2 internal fn (remove_env_vars_with_prefix, set_core_file_size_limit_to_zero); called by 1 (pre_main_hardening).


##### `pre_main_hardening_macos`  (lines 83–100)

```
fn pre_main_hardening_macos()
```

**Purpose**: Applies macOS hardening by denying debugger attachment, zeroing core-dump limits, and clearing `DYLD_` environment variables. Failure to deny attach or set limits is treated as fatal.

**Data flow**: It calls `libc::ptrace(PT_DENY_ATTACH, 0, null_mut(), 0)`, checks for `-1`, and on failure prints the last OS error and exits with `PTRACE_DENY_ATTACH_FAILED_EXIT_CODE`. On success it calls `set_core_file_size_limit_to_zero()` and `remove_env_vars_with_prefix(b"DYLD_")`, mutating process state and environment.

**Call relations**: Only `pre_main_hardening` invokes this on macOS builds. It combines a macOS-specific anti-debugging syscall with the shared Unix helpers for core-limit and environment cleanup.

*Call graph*: calls 2 internal fn (remove_env_vars_with_prefix, set_core_file_size_limit_to_zero); called by 1 (pre_main_hardening); 4 external calls (eprintln!, ptrace, exit, null_mut).


##### `set_core_file_size_limit_to_zero`  (lines 103–117)

```
fn set_core_file_size_limit_to_zero()
```

**Purpose**: Sets `RLIMIT_CORE` to zero so the process cannot produce core dumps. It is the shared Unix hardening primitive used across Linux, macOS, and BSD paths.

**Data flow**: It constructs a `libc::rlimit { rlim_cur: 0, rlim_max: 0 }`, passes it to `libc::setrlimit(libc::RLIMIT_CORE, &rlim)`, and if the syscall fails prints the last OS error and exits with `SET_RLIMIT_CORE_FAILED_EXIT_CODE`. On success it returns `()` after mutating the process resource limit.

**Call relations**: All Unix-family pre-main hardening routines delegate here after their platform-specific setup. Centralizing this logic keeps failure handling and exit-code behavior consistent.

*Call graph*: called by 3 (pre_main_hardening_bsd, pre_main_hardening_linux, pre_main_hardening_macos); 3 external calls (eprintln!, setrlimit, exit).


##### `pre_main_hardening_windows`  (lines 120–122)

```
fn pre_main_hardening_windows()
```

**Purpose**: Placeholder for future Windows-specific hardening behavior. It currently performs no actions.

**Data flow**: It takes no inputs, reads no state, writes no state, and returns `()`. The body is intentionally empty aside from a TODO comment.

**Call relations**: The top-level dispatcher calls this on Windows builds so the API surface remains uniform even though no hardening steps are implemented yet.

*Call graph*: called by 1 (pre_main_hardening).


##### `remove_env_vars_with_prefix`  (lines 125–131)

```
fn remove_env_vars_with_prefix(prefix: &[u8])
```

**Purpose**: Removes all environment variables whose raw key bytes start with a given prefix. It is used to clear dynamic-loader injection variables such as `LD_*` and `DYLD_*`.

**Data flow**: It takes a byte-slice prefix, reads the current environment via `std::env::vars_os()`, passes that iterator into `env_keys_with_prefix` to collect matching `OsString` keys, then iterates those keys and calls `std::env::remove_var` on each inside an unsafe block. It mutates process environment state.

**Call relations**: Linux, macOS, and BSD hardening routines all delegate here after deciding which prefix to scrub. It relies on `env_keys_with_prefix` so matching works even for non-UTF-8 keys.

*Call graph*: calls 1 internal fn (env_keys_with_prefix); called by 3 (pre_main_hardening_bsd, pre_main_hardening_linux, pre_main_hardening_macos); 2 external calls (remove_var, vars_os).


##### `env_keys_with_prefix`  (lines 134–146)

```
fn env_keys_with_prefix(vars: I, prefix: &[u8]) -> Vec<OsString>
```

**Purpose**: Filters an iterator of environment entries down to keys whose raw bytes begin with a specified prefix. It is careful to operate on `OsString` values without requiring UTF-8 decoding.

**Data flow**: It accepts any iterator yielding `(OsString, OsString)` pairs plus a byte-slice prefix. It iterates entries, inspects each key’s bytes via `key.as_os_str().as_bytes()`, retains keys whose bytes start with the prefix, collects those keys into `Vec<OsString>`, and returns the vector.

**Call relations**: The environment-removal helper uses this to find keys to delete, and the unit tests call it directly to verify matching behavior for both ordinary and non-UTF-8 keys.

*Call graph*: called by 3 (remove_env_vars_with_prefix, env_keys_with_prefix_filters_only_matching_keys, env_keys_with_prefix_handles_non_utf8_entries); 1 external calls (into_iter).


##### `tests::env_keys_with_prefix_handles_non_utf8_entries`  (lines 157–178)

```
fn env_keys_with_prefix_handles_non_utf8_entries()
```

**Purpose**: Verifies that prefix filtering works on non-UTF-8 environment keys and does not accidentally drop matching loader variables just because they are not valid Unicode. It specifically checks that only the non-UTF-8 key beginning with `LD_` is retained.

**Data flow**: It constructs two non-UTF-8 `OsString` keys and a non-UTF-8 value, asserts that the keys cannot be converted into UTF-8 strings, passes the key/value pairs into `env_keys_with_prefix(..., b"LD_")`, and asserts that the returned vector contains exactly the matching `LD_` key.

**Call relations**: This test directly exercises the raw-byte matching logic in `env_keys_with_prefix`, guarding the Unix hardening path against regressions in non-UTF-8 environment handling.

*Call graph*: calls 1 internal fn (env_keys_with_prefix); 5 external calls (from_bytes, from_vec, assert!, assert_eq!, vec!).


##### `tests::env_keys_with_prefix_filters_only_matching_keys`  (lines 181–192)

```
fn env_keys_with_prefix_filters_only_matching_keys()
```

**Purpose**: Verifies that prefix filtering returns only keys with the requested prefix and ignores unrelated variables. It checks both the count and the exact retained key.

**Data flow**: It builds a small vector of UTF-8-compatible `OsString` environment entries including `PATH`, `LD_TEST`, and `DYLD_FOO`, calls `env_keys_with_prefix(vars, b"LD_")`, and asserts that the result length is one and that the sole key equals `LD_TEST`.

**Call relations**: This test complements the non-UTF-8 case by validating ordinary matching semantics for the helper used by environment scrubbing.

*Call graph*: calls 1 internal fn (env_keys_with_prefix); 3 external calls (from_bytes, assert_eq!, vec!).


### Global crypto provider setup
Install and validate the process-wide rustls crypto backend so later TLS use is deterministic.

### `utils/rustls-provider/src/lib.rs`

`orchestration` · `startup or first TLS use`

This file contains a tiny but important compatibility shim for rustls provider initialization. The constant `REQUIRED_SIGNATURE_SCHEME` is set to `rustls::SignatureScheme::ECDSA_NISTP521_SHA512`, reflecting a capability needed for some enterprise TLS proxy certificates. `ensure_rustls_crypto_provider` uses a process-global `Once` to guarantee that initialization logic runs at most once. Inside that one-time block it attempts to install `rustls::crypto::aws_lc_rs::default_provider()` as the default provider. If installation fails, the function deliberately returns without panicking so that embedded hosts that already installed a provider keep working unchanged.

When installation succeeds, the code fetches the active default provider and asserts that it supports the required signature scheme by inspecting `signature_verification_algorithms.supported_schemes()`. The helper `provider_supports_required_signature_scheme` encapsulates that capability check. The overall design is intentionally best-effort with respect to preinstalled providers, but strict when this crate itself successfully installs aws-lc-rs: in that case the provider must expose P-521/SHA-512 verification support or the process aborts. This makes TLS behavior predictable across mixed dependency graphs where rustls cannot auto-select between `ring` and `aws-lc-rs`.

#### Function details

##### `ensure_rustls_crypto_provider`  (lines 10–32)

```
fn ensure_rustls_crypto_provider()
```

**Purpose**: Installs the aws-lc-rs rustls crypto provider once per process and validates that the installed provider supports ECDSA P-521/SHA-512 verification. It preserves any provider that was already installed by someone else.

**Data flow**: It takes no arguments and executes its body inside a static `Once`. Within that closure it obtains `rustls::crypto::aws_lc_rs::default_provider()` and calls `install_default()`. If installation returns an error, the function exits early without changing global state. If installation succeeds, it reads the process-global provider via `CryptoProvider::get_default()`, panics if none is present, then asserts via `provider_supports_required_signature_scheme` that the provider's supported verification schemes include `REQUIRED_SIGNATURE_SCHEME`.

**Call relations**: This is the public entrypoint used by tests and by any runtime code that needs rustls initialized deterministically. It delegates the capability check to `provider_supports_required_signature_scheme` after successful installation.

*Call graph*: 1 external calls (new).


##### `provider_supports_required_signature_scheme`  (lines 34–39)

```
fn provider_supports_required_signature_scheme(provider: &rustls::crypto::CryptoProvider) -> bool
```

**Purpose**: Checks whether a rustls crypto provider advertises support for the required signature verification scheme. It is a narrow predicate over provider capabilities.

**Data flow**: It takes a borrowed `rustls::crypto::CryptoProvider`, reads `provider.signature_verification_algorithms.supported_schemes()`, tests whether that slice contains `REQUIRED_SIGNATURE_SCHEME`, and returns the resulting boolean.

**Call relations**: This helper is called only from `ensure_rustls_crypto_provider` to enforce the postcondition that the installed provider can verify P-521/SHA-512 signatures.


### Dispatch and runtime bootstrap
Set up argv-based command dispatch, PATH aliasing, process environment, and Tokio runtime scaffolding for the rest of the application.

### `arg0/src/lib.rs`

`orchestration` · `startup`

This file is the startup shim for binaries that need Codex’s helper CLIs without shipping multiple binaries. Its core data model is `Arg0DispatchPaths`, which records stable executable paths for the current binary, the Linux sandbox alias, and the Unix execve wrapper alias. `Arg0PathEntryGuard` owns the temporary directory and lock file backing those aliases so they are not deleted while the process is still running.

The top-level flow begins in `arg0_dispatch`: it inspects `argv[0]` to directly jump into special modes such as `codex-linux-sandbox`, `apply_patch`, the misspelled compatibility alias, and on Unix the `codex-execve-wrapper`. It also inspects `argv[1]` for hidden helper modes like filesystem helper, Windows sandbox wrapper, and core apply-patch execution. Only after those early exits does it load `~/.codex/.env`, explicitly filtering out any variable whose name starts with `CODEX_` as a security invariant.

Alias setup is done by creating a per-session temp directory under `CODEX_HOME/tmp/arg0`, locking it with `.lock`, cleaning stale unlocked siblings, and creating symlinks (Unix) or batch wrappers (Windows). PATH is rebuilt by prepending package-managed path entries and then the alias directory. `arg0_dispatch_or_else` then runs the caller’s async main inside a dedicated thread with a 16 MiB stack and a multi-thread Tokio runtime, ensuring the alias guard stays alive until the future completes. Linux-specific re-exec logic prefers the `codex-linux-sandbox` alias over `current_exe()` so basename-based dispatch still works on systems lacking `--argv0` support.

#### Function details

##### `Arg0PathEntryGuard::new`  (lines 45–51)

```
fn new(temp_dir: TempDir, lock_file: File, paths: Arg0DispatchPaths) -> Self
```

**Purpose**: Constructs the guard object that owns the temporary alias directory, its lock file, and the derived dispatch paths. Keeping this value alive is what prevents cleanup of the alias directory during process execution.

**Data flow**: Consumes a `TempDir`, an opened and locked `File`, and an `Arg0DispatchPaths` value; stores them unchanged into the struct fields; returns a fully initialized `Arg0PathEntryGuard`.

**Call relations**: It is created during real alias setup in `prepare_path_entry_for_codex_aliases`, and also by tests that need to simulate a live alias directory. Later code reads the embedded paths through `Arg0PathEntryGuard::paths` while relying on ownership of the temp dir and lock file to preserve filesystem state.

*Call graph*: called by 3 (prepare_path_entry_for_codex_aliases, linux_sandbox_exe_path_prefers_codex_linux_sandbox_alias, run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns).


##### `Arg0PathEntryGuard::paths`  (lines 53–55)

```
fn paths(&self) -> &Arg0DispatchPaths
```

**Purpose**: Exposes the precomputed helper executable paths stored in the guard. It is the read-only accessor used after startup to derive child re-exec paths.

**Data flow**: Reads `self.paths` and returns a shared reference `&Arg0DispatchPaths` without mutation.

**Call relations**: It is used when runtime setup needs to extract alias paths from a live guard, notably in the path selection logic reached from `run_main_with_arg0_guard`.

*Call graph*: called by 1 (paths).


##### `arg0_dispatch`  (lines 58–162)

```
fn arg0_dispatch() -> Option<Arg0PathEntryGuard>
```

**Purpose**: Performs all early-process dispatch and environment mutation before any threads are spawned. It either transfers control into helper modes and exits, or prepares PATH aliases and returns the guard that keeps them alive.

**Data flow**: Reads process arguments, `PATH`, current install context, current executable path, current directory, and `~/.codex/.env`. Depending on `argv[0]`/`argv[1]`, it may invoke helper entrypoints, build a single-thread Tokio runtime for wrapper tasks, run patch application, print warnings/errors, mutate `PATH`, and finally return `Option<Arg0PathEntryGuard>`.

**Call relations**: This is the first step inside `arg0_dispatch_or_else`. In helper-mode branches it delegates directly to external helper mains or async wrappers and terminates the process. In normal mode it calls `load_dotenv` and `prepare_path_env_var_with_aliases`, then hands the resulting guard to later runtime setup.

*Call graph*: calls 4 internal fn (load_dotenv, prepare_path_env_var_with_aliases, current, current_dir); called by 1 (arg0_dispatch_or_else); 16 external calls (new, apply_patch, main, run_fs_helper_main, run_main, run_shell_escalation_execve_wrapper, run_windows_sandbox_wrapper_main, eprintln!, args, args_os (+6 more)).


##### `prepare_path_env_var_with_aliases`  (lines 164–181)

```
fn prepare_path_env_var_with_aliases(
    install_context: &InstallContext,
    existing_path: Option<OsString>,
    prepare_aliases: impl FnOnce(Option<OsString>) -> std::io::Result<(Arg0PathEntryGua
```

**Purpose**: Combines package-managed PATH injection with best-effort temporary alias creation. It preserves package PATH updates even if alias creation fails.

**Data flow**: Takes an `InstallContext`, an optional existing PATH value, and a closure that creates aliases. It computes a package-prefixed PATH via `path_env_with_package_path_dir`, passes that PATH into the alias-preparation closure, and returns a pair of optional guard and optional updated PATH. On alias failure it emits a warning and falls back to package PATH only.

**Call relations**: It is called from `arg0_dispatch` after dotenv loading. Its closure parameter is normally `prepare_path_entry_for_codex_aliases`, but tests inject failing closures to verify fallback behavior.

*Call graph*: calls 1 internal fn (path_env_with_package_path_dir); called by 1 (arg0_dispatch); 1 external calls (eprintln!).


##### `arg0_dispatch_or_else`  (lines 207–236)

```
fn arg0_dispatch_or_else(main_fn: F) -> anyhow::Result<()>
```

**Purpose**: Wraps a binary crate’s async main with arg0 dispatch, PATH alias lifetime management, and Tokio runtime creation on a controlled-stack thread. It is the intended public entry wrapper for binaries in this workspace.

**Data flow**: Accepts a `main_fn` closure from `Arg0DispatchPaths` to an async result. It calls `arg0_dispatch`, captures `current_exe`, spawns a named OS thread with a 16 MiB stack, builds a Tokio runtime inside that thread, runs `run_main_with_arg0_guard`, joins the thread, and returns the propagated `anyhow::Result<()>` or resumes a panic payload.

**Call relations**: This is the orchestration entry used by binaries. It delegates startup probing to `arg0_dispatch`, runtime construction to `build_runtime`, and path-lifetime-sensitive execution to `run_main_with_arg0_guard`.

*Call graph*: calls 1 internal fn (arg0_dispatch); 3 external calls (current_exe, resume_unwind, new).


##### `run_main_with_arg0_guard`  (lines 238–264)

```
async fn run_main_with_arg0_guard(
    path_entry_guard: Option<Arg0PathEntryGuard>,
    current_exe: Option<PathBuf>,
    main_fn: F,
) -> anyhow::Result<()>
```

**Purpose**: Builds the final `Arg0DispatchPaths` passed to the caller’s async main and ensures the alias guard is dropped only after that future finishes. This is the point where startup filesystem state becomes runtime configuration.

**Data flow**: Consumes an optional `Arg0PathEntryGuard`, an optional `current_exe`, and a `main_fn`. It derives `codex_self_exe`, conditionally computes `codex_linux_sandbox_exe` on Linux via `linux_sandbox_exe_path`, extracts `main_execve_wrapper_exe` from the guard, awaits `main_fn(paths)`, then explicitly drops the guard and returns the async result.

**Call relations**: It is invoked from the thread created by `arg0_dispatch_or_else`. It delegates Linux alias selection to `linux_sandbox_exe_path`; tests call it directly to verify aliases remain present across suspension points.

*Call graph*: calls 1 internal fn (linux_sandbox_exe_path); called by 1 (run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns); 1 external calls (cfg!).


##### `linux_sandbox_exe_path`  (lines 266–276)

```
fn linux_sandbox_exe_path(
    path_entry_guard: Option<&Arg0PathEntryGuard>,
    current_exe: Option<PathBuf>,
) -> Option<PathBuf>
```

**Purpose**: Chooses the best executable path for Linux sandbox re-exec. It prefers the basename-preserving alias over the raw current executable path.

**Data flow**: Reads an optional guard reference and optional current executable path. It first tries `path_entry_guard.paths().codex_linux_sandbox_exe.clone()`, and if absent falls back to `current_exe`; returns `Option<PathBuf>`.

**Call relations**: It is only used while assembling `Arg0DispatchPaths` in `run_main_with_arg0_guard`, where preserving arg0 semantics for child processes matters.

*Call graph*: called by 1 (run_main_with_arg0_guard).


##### `build_runtime`  (lines 278–283)

```
fn build_runtime() -> anyhow::Result<tokio::runtime::Runtime>
```

**Purpose**: Creates the standard Tokio runtime used by wrapped binaries. The runtime is configured so worker threads use the same enlarged stack budget as the top-level main thread.

**Data flow**: Constructs a multi-thread Tokio runtime builder, enables all Tokio subsystems, sets worker thread stack size to `TOKIO_WORKER_STACK_SIZE_BYTES`, builds the runtime, and returns it as `anyhow::Result<Runtime>`.

**Call relations**: It is called from the dedicated thread inside `arg0_dispatch_or_else`, and also from a test that exercises `run_main_with_arg0_guard` under a real runtime.

*Call graph*: 1 external calls (new_multi_thread).


##### `load_dotenv`  (lines 291–297)

```
fn load_dotenv()
```

**Purpose**: Loads environment variables from `~/.codex/.env` before any threads exist, while enforcing that `.env` cannot define internal `CODEX_` variables. Missing home directory or missing file are silently ignored.

**Data flow**: Reads the Codex home path via `find_codex_home`, attempts to create a dotenv iterator for `<codex_home>/.env`, and if successful passes it to `set_filtered`. It returns no value and mutates process environment only through that helper.

**Call relations**: It is called during normal startup from `arg0_dispatch`, before PATH mutation and before Tokio/thread creation because environment mutation is process-global and not thread-safe.

*Call graph*: calls 1 internal fn (set_filtered); called by 1 (arg0_dispatch); 2 external calls (find_codex_home, from_path_iter).


##### `set_filtered`  (lines 300–311)

```
fn set_filtered(iter: I)
```

**Purpose**: Applies dotenv key/value pairs to the process environment while rejecting any key whose uppercase form starts with `CODEX_`. This preserves a security boundary between user dotenv files and internal control variables.

**Data flow**: Consumes any iterator of `Result<(String, String), dotenvy::Error>`, flattens away parse errors, uppercases each key for prefix checking, and for allowed keys calls `std::env::set_var`. It returns unit and writes to process environment.

**Call relations**: It is the filtering worker used exclusively by `load_dotenv`.

*Call graph*: called by 1 (load_dotenv); 2 external calls (into_iter, set_var).


##### `prepare_path_entry_for_codex_aliases`  (lines 326–436)

```
fn prepare_path_entry_for_codex_aliases(
    existing_path: Option<OsString>,
) -> std::io::Result<(Arg0PathEntryGuard, OsString)>
```

**Purpose**: Creates the temporary PATH directory containing helper aliases and returns both the lifetime guard and the new PATH value with that directory prepended. It also enforces filesystem safety constraints around where those helpers may be created.

**Data flow**: Reads Codex home, temp dir root, current executable path, and existing PATH. It rejects non-debug setups where `codex_home` lives under the system temp directory, creates `~/.codex/tmp/arg0`, tightens Unix permissions to `0700`, runs `janitor_cleanup`, creates a unique temp subdirectory, opens and locks `.lock`, creates symlinks or batch scripts for helper names, computes the updated PATH via `path_env_with_entry`, builds `Arg0DispatchPaths`, and returns `(Arg0PathEntryGuard, OsString)`.

**Call relations**: It is normally passed as the alias-preparation closure into `prepare_path_env_var_with_aliases`. Internally it delegates stale-directory cleanup to `janitor_cleanup` and PATH string assembly to `path_env_with_entry`.

*Call graph*: calls 3 internal fn (new, janitor_cleanup, path_env_with_entry); 13 external calls (options, new, find_codex_home, from_mode, eprintln!, format!, current_exe, temp_dir, create_dir_all, set_permissions (+3 more)).


##### `path_env_with_package_path_dir`  (lines 438–447)

```
fn path_env_with_package_path_dir(
    install_context: &InstallContext,
    existing_path: Option<OsString>,
) -> Option<OsString>
```

**Purpose**: Prepends the package layout’s optional `path_dir` to an existing PATH value. This lets packaged helper binaries participate in PATH ordering before temporary arg0 aliases are added.

**Data flow**: Reads `install_context.package_layout.path_dir`; if absent returns `None`, otherwise calls `path_env_with_entry` with that directory and the existing PATH and returns the resulting `OsString`.

**Call relations**: It is used by `prepare_path_env_var_with_aliases` as the first PATH transformation before alias setup is attempted.

*Call graph*: calls 1 internal fn (path_env_with_entry); called by 1 (prepare_path_env_var_with_aliases).


##### `path_env_with_entry`  (lines 449–467)

```
fn path_env_with_entry(path_entry: &Path, existing_path: Option<OsString>) -> OsString
```

**Purpose**: Builds a new PATH string by prepending one filesystem entry to an optional existing PATH. It avoids repeated reallocations by precomputing capacity.

**Data flow**: Takes a `&Path` and optional `OsString`, chooses `:` on Unix or `;` on Windows, allocates an `OsString` with enough capacity for both parts plus separator, pushes the new entry first, then appends separator and old PATH if present, and returns the combined PATH value.

**Call relations**: It is the low-level PATH builder used both for package path insertion and for prepending the temporary alias directory.

*Call graph*: called by 2 (path_env_with_package_path_dir, prepare_path_entry_for_codex_aliases); 2 external calls (with_capacity, as_os_str).


##### `janitor_cleanup`  (lines 469–496)

```
fn janitor_cleanup(temp_root: &Path) -> std::io::Result<()>
```

**Purpose**: Best-effort removes stale per-session alias directories under the arg0 temp root. It only deletes directories whose lock file exists and can be locked, so active sessions are preserved.

**Data flow**: Reads directory entries under `temp_root`; if the root is missing it returns success. For each child directory it calls `try_lock_dir`; unlocked directories are removed with `remove_dir_all`, missing directories after the fact are tolerated as TOCTOU races, and any other filesystem error aborts with `Err`.

**Call relations**: It is called during alias setup from `prepare_path_entry_for_codex_aliases` and directly by tests covering no-lock, held-lock, and stale-lock cases. It delegates lock probing to `try_lock_dir`.

*Call graph*: calls 1 internal fn (try_lock_dir); called by 4 (prepare_path_entry_for_codex_aliases, janitor_removes_dirs_with_unlocked_lock, janitor_skips_dirs_with_held_lock, janitor_skips_dirs_without_lock_file); 2 external calls (read_dir, remove_dir_all).


##### `try_lock_dir`  (lines 498–511)

```
fn try_lock_dir(dir: &Path) -> std::io::Result<Option<File>>
```

**Purpose**: Attempts to open and lock a session directory’s `.lock` file to determine whether that directory is stale. It distinguishes missing lock files, active locks, and real I/O failures.

**Data flow**: Builds `<dir>/.lock`, opens it read/write, returns `Ok(None)` if the file is absent, otherwise tries `try_lock()`. A successful lock returns `Ok(Some(File))`, `WouldBlock` returns `Ok(None)`, and other errors are propagated.

**Call relations**: It is only used by `janitor_cleanup` to decide whether a candidate directory may be safely deleted.

*Call graph*: called by 1 (janitor_cleanup); 2 external calls (options, join).


##### `tests::create_lock`  (lines 543–551)

```
fn create_lock(dir: &Path) -> std::io::Result<File>
```

**Purpose**: Creates or opens the `.lock` file inside a test directory. Tests use it to simulate stale and active arg0 session directories.

**Data flow**: Takes a directory path, joins `LOCK_FILENAME`, opens the file with read/write/create and no truncation, and returns the resulting `File`.

**Call relations**: It supports multiple tests that need a lock file, including guard construction and janitor behavior checks.

*Call graph*: 2 external calls (options, join).


##### `tests::package_path_test_fixture`  (lines 553–582)

```
fn package_path_test_fixture() -> anyhow::Result<PackagePathTestFixture>
```

**Purpose**: Builds a temporary package-layout fixture with separate arg0, package, path, and existing PATH directories. It centralizes the filesystem setup needed by PATH-ordering tests.

**Data flow**: Creates a `TempDir`, several subdirectories, canonicalizes package paths into `AbsolutePathBuf`, constructs an `InstallContext` with a `CodexPackageLayout`, and returns a `PackagePathTestFixture` containing both raw paths and the install context.

**Call relations**: It is called by tests that verify package PATH insertion and fallback behavior when alias setup fails.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (new, create_dir_all).


##### `tests::linux_sandbox_exe_path_prefers_codex_linux_sandbox_alias`  (lines 585–604)

```
fn linux_sandbox_exe_path_prefers_codex_linux_sandbox_alias() -> std::io::Result<()>
```

**Purpose**: Verifies that Linux sandbox path selection prefers the alias path stored in the guard over the plain executable path. This protects basename-based redispatch behavior.

**Data flow**: Creates a temp directory and lock file, constructs an `Arg0PathEntryGuard` with both self and alias paths, calls `linux_sandbox_exe_path`, and asserts that the alias path is returned.

**Call relations**: This test directly exercises the helper used by `run_main_with_arg0_guard`.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, new, create_lock, assert_eq!).


##### `tests::path_env_can_prepend_package_path_before_arg0_alias_dir`  (lines 607–626)

```
fn path_env_can_prepend_package_path_before_arg0_alias_dir() -> anyhow::Result<()>
```

**Purpose**: Checks PATH ordering when both package path and arg0 alias directory are prepended. The expected order is alias dir first, then package path dir, then the original PATH.

**Data flow**: Builds a fixture, computes package-prefixed PATH with `path_env_with_package_path_dir`, prepends the arg0 dir with `path_env_with_entry`, splits the resulting PATH, and asserts the exact sequence of directories.

**Call relations**: It validates the composition strategy used by `prepare_path_env_var_with_aliases`.

*Call graph*: 4 external calls (package_path_test_fixture, assert_eq!, path_env_with_entry, path_env_with_package_path_dir).


##### `tests::package_path_survives_arg0_alias_setup_failure`  (lines 629–661)

```
fn package_path_survives_arg0_alias_setup_failure() -> anyhow::Result<()>
```

**Purpose**: Ensures that failure to create temporary aliases does not discard package PATH injection. Startup should continue with package PATH only.

**Data flow**: Builds a fixture, calls `prepare_path_env_var_with_aliases` with a closure that inspects the incoming PATH and then returns an error, and asserts that no guard is returned while the updated PATH still contains package path followed by existing PATH.

**Call relations**: This test targets the fallback branch in `prepare_path_env_var_with_aliases`.

*Call graph*: 4 external calls (package_path_test_fixture, assert!, assert_eq!, prepare_path_env_var_with_aliases).


##### `tests::run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns`  (lines 665–704)

```
fn run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns() -> anyhow::Result<()>
```

**Purpose**: Confirms that the alias temp directory is not dropped while the async main future is still running, even across an await point. This guards against child-path invalidation during execution.

**Data flow**: Creates a temp alias file and guard, runs `run_main_with_arg0_guard` inside a real Tokio runtime, and inside the async closure checks that the alias path exists both before and after `yield_now()`. The test returns success only if the file remains present throughout.

**Call relations**: It directly exercises `run_main_with_arg0_guard` and indirectly the guard-lifetime design used by `arg0_dispatch_or_else`.

*Call graph*: calls 2 internal fn (new, run_main_with_arg0_guard); 5 external calls (from, new, create_lock, write, build_runtime).


##### `tests::janitor_skips_dirs_without_lock_file`  (lines 707–716)

```
fn janitor_skips_dirs_without_lock_file() -> std::io::Result<()>
```

**Purpose**: Verifies that cleanup does not remove directories lacking a `.lock` file. Such directories are treated as ineligible rather than stale.

**Data flow**: Creates a temp root and child directory without a lock file, runs `janitor_cleanup`, and asserts the directory still exists.

**Call relations**: It covers the `try_lock_dir` branch where missing lock files yield `Ok(None)`.

*Call graph*: calls 1 internal fn (janitor_cleanup); 3 external calls (assert!, create_dir, tempdir).


##### `tests::janitor_skips_dirs_with_held_lock`  (lines 719–730)

```
fn janitor_skips_dirs_with_held_lock() -> std::io::Result<()>
```

**Purpose**: Verifies that cleanup leaves directories alone when their lock file is currently held. This protects active sessions from accidental deletion.

**Data flow**: Creates a temp root and child directory, creates and locks its `.lock` file, runs `janitor_cleanup`, and asserts the directory still exists.

**Call relations**: It covers the `WouldBlock` path returned by `try_lock_dir` and consumed by `janitor_cleanup`.

*Call graph*: calls 1 internal fn (janitor_cleanup); 4 external calls (create_lock, assert!, create_dir, tempdir).


##### `tests::janitor_removes_dirs_with_unlocked_lock`  (lines 733–743)

```
fn janitor_removes_dirs_with_unlocked_lock() -> std::io::Result<()>
```

**Purpose**: Verifies that cleanup removes stale directories whose lock file exists but is not held. This is the intended reclamation path for abandoned session dirs.

**Data flow**: Creates a temp root and child directory, creates but does not lock `.lock`, runs `janitor_cleanup`, and asserts the directory has been deleted.

**Call relations**: It covers the successful-lock branch in `try_lock_dir` followed by deletion in `janitor_cleanup`.

*Call graph*: calls 1 internal fn (janitor_cleanup); 4 external calls (create_lock, assert!, create_dir, tempdir).

## 📊 State Registers Touched

- `reg-process-environment` — The process-wide environment and argv/arg0-derived execution context that shapes binary dispatch, bootstrap aliases, and inherited subprocess state.
