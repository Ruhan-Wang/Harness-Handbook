# Early process hardening and runtime bootstrap  `stage-2`

This stage happens at the very start, before Codex begins its real work. It is like locking the workshop, choosing the right power supply, and arranging the tool bench before anyone starts building. The process-hardening code tightens the running program’s defenses. On supported operating systems, it blocks or limits common ways another tool might inspect memory, create crash dumps, or tamper with the process. The rustls-provider code sets up the cryptography engine used by rustls, the library that makes secure TLS network connections. This matters because more than one engine may be available, and the program must choose one global provider early and consistently. The arg0 code shapes how the executable presents itself at launch. A single Codex binary can act like different helper programs depending on the name or hidden startup argument used. It also prepares early environment details, such as PATH aliases and .env variables, so later runtime setup can start from a predictable state.

## Files in this stage

### Process hardening
Apply the earliest OS-level protections and environment sanitization before broader runtime bootstrap begins.

### `process-hardening/src/lib.rs`

`domain_logic` · `startup, before main program logic`

This file is a small security guard that runs at the very beginning of the program, ideally before normal startup code. Its job is to make the process harder to spy on or alter. On Unix-like systems, a “core dump” is a file containing the program’s memory after a crash; this file can include secrets, so the code turns core dumps off. On Linux and Android it also asks the operating system to mark the process as non-dumpable, which helps stop other same-user processes from attaching with ptrace, a system feature used by debuggers to inspect a running program. On macOS it uses a similar ptrace setting to deny debugger attachment. It also removes environment variables such as LD_* or DYLD_*, which can influence how shared libraries are loaded and may be abused to inject code. Think of this file as locking doors and closing blinds before the application begins work. If one of the key hardening calls fails, the process prints an error and exits with a specific code, rather than continuing in a weaker security state. Windows currently has a placeholder, so no comparable hardening is applied there yet.

#### Function details

##### `pre_main_hardening`  (lines 12–25)

```
fn pre_main_hardening()
```

**Purpose**: Runs the right hardening steps for the current operating system. This is the single public starting point for early process protection.

**Data flow**: It takes no input. At compile time, only the branch for the target operating system is included; at runtime it calls that platform’s hardening routine. It returns nothing, but the called routine may change process settings, remove environment variables, or exit if a critical protection cannot be enabled.

**Call relations**: This is the front door for the file’s behavior. It chooses between the Linux, macOS, BSD, and Windows routines, so callers do not need to know the platform details.

*Call graph*: calls 4 internal fn (pre_main_hardening_bsd, pre_main_hardening_linux, pre_main_hardening_macos, pre_main_hardening_windows).


##### `pre_main_hardening_linux`  (lines 44–61)

```
fn pre_main_hardening_linux()
```

**Purpose**: Applies Linux and Android startup protections. It prevents process dumping, disables core dumps, and removes LD_* environment variables that could affect library loading.

**Data flow**: It reads no ordinary input, but it talks to the operating system. First it calls prctl to mark the process as not dumpable; if that fails, it prints the operating system error and exits. Then it sets the core dump size limit to zero. Finally it scans the environment and removes variables whose names start with LD_.

**Call relations**: This is called by pre_main_hardening on Linux and Android builds. It delegates core dump blocking to set_core_file_size_limit_to_zero and environment cleanup to remove_env_vars_with_prefix.

*Call graph*: calls 2 internal fn (remove_env_vars_with_prefix, set_core_file_size_limit_to_zero); called by 1 (pre_main_hardening); 3 external calls (eprintln!, prctl, exit).


##### `disable_process_dumping`  (lines 65–72)

```
fn disable_process_dumping() -> std::io::Result<()>
```

**Purpose**: Marks the current Linux process as non-dumpable and reports success or failure to the caller. This is a reusable Linux-only helper for code that wants the ptrace/dump protection without running all startup cleanup.

**Data flow**: It takes no input. It asks the operating system, through prctl, to disable dumping for this process. It returns Ok if the system accepted the request, or an I/O error containing the last operating system error if it failed.

**Call relations**: Unlike the pre-main Linux routine, this function does not exit the process on failure and does not remove environment variables. It stands alone as a safer, caller-controlled way to request just the dump-protection step.

*Call graph*: 2 external calls (last_os_error, prctl).


##### `pre_main_hardening_bsd`  (lines 75–80)

```
fn pre_main_hardening_bsd()
```

**Purpose**: Applies the available startup protections on FreeBSD and OpenBSD. It turns off core dumps and removes LD_* environment variables.

**Data flow**: It takes no input. It first sets the process’s core dump limit to zero, then scans environment variable names and removes those beginning with LD_. It returns nothing unless a core-limit failure causes the process to exit.

**Call relations**: This is called by pre_main_hardening on supported BSD systems. It reuses the shared Unix helpers for core dump prevention and environment cleanup.

*Call graph*: calls 2 internal fn (remove_env_vars_with_prefix, set_core_file_size_limit_to_zero); called by 1 (pre_main_hardening).


##### `pre_main_hardening_macos`  (lines 83–100)

```
fn pre_main_hardening_macos()
```

**Purpose**: Applies macOS startup protections. It blocks debugger attachment, prevents core dumps, and removes DYLD_* environment variables that can affect dynamic library loading.

**Data flow**: It takes no input. It asks macOS, through ptrace with the deny-attach option, to prevent debuggers from attaching; if that fails, it prints an error and exits. Then it sets the core dump size limit to zero and removes environment variables whose names start with DYLD_.

**Call relations**: This is called by pre_main_hardening on macOS builds. It hands shared work to set_core_file_size_limit_to_zero and remove_env_vars_with_prefix after performing the macOS-specific deny-attach call.

*Call graph*: calls 2 internal fn (remove_env_vars_with_prefix, set_core_file_size_limit_to_zero); called by 1 (pre_main_hardening); 4 external calls (eprintln!, ptrace, exit, null_mut).


##### `set_core_file_size_limit_to_zero`  (lines 103–117)

```
fn set_core_file_size_limit_to_zero()
```

**Purpose**: Turns off core dump files for the current process. This helps keep memory contents, which may include secrets, from being written to disk after a crash.

**Data flow**: It creates a resource-limit setting where both the current and maximum core file sizes are zero. It gives that setting to the operating system with setrlimit. If the system rejects it, it prints the last operating system error and exits; otherwise it returns nothing after changing the process limit.

**Call relations**: The Linux, macOS, and BSD hardening routines call this as a shared safety step. It is deliberately strict: callers do not continue if the process cannot disable core dumps.

*Call graph*: called by 3 (pre_main_hardening_bsd, pre_main_hardening_linux, pre_main_hardening_macos); 3 external calls (eprintln!, setrlimit, exit).


##### `pre_main_hardening_windows`  (lines 120–122)

```
fn pre_main_hardening_windows()
```

**Purpose**: Acts as the Windows placeholder for startup hardening. It currently does not apply any Windows-specific protections.

**Data flow**: It takes no input and makes no changes. It simply returns immediately.

**Call relations**: pre_main_hardening calls this on Windows builds. Its presence keeps the platform dispatch structure complete, while leaving the actual Windows hardening work to be added later.

*Call graph*: called by 1 (pre_main_hardening).


##### `remove_env_vars_with_prefix`  (lines 125–131)

```
fn remove_env_vars_with_prefix(prefix: &[u8])
```

**Purpose**: Removes environment variables whose names begin with a given byte prefix. This is used to clear variables that can influence dynamic library loading.

**Data flow**: It receives a prefix such as LD_ or DYLD_ as raw bytes. It reads all current environment variables, asks env_keys_with_prefix which names match, and then removes each matching variable from the process environment. It returns nothing, but the process environment is changed.

**Call relations**: The platform hardening routines call this after their operating-system protections are set. It relies on env_keys_with_prefix to find the exact variables to remove, including names that are not valid text.

*Call graph*: calls 1 internal fn (env_keys_with_prefix); called by 3 (pre_main_hardening_bsd, pre_main_hardening_linux, pre_main_hardening_macos); 2 external calls (remove_var, vars_os).


##### `env_keys_with_prefix`  (lines 134–146)

```
fn env_keys_with_prefix(vars: I, prefix: &[u8]) -> Vec<OsString>
```

**Purpose**: Finds environment variable names that start with a chosen byte prefix. It is careful to work even when names are not valid UTF-8 text.

**Data flow**: It receives any collection of environment variable key-value pairs and a byte prefix. It looks only at the keys, compares their raw bytes with the prefix, and collects the matching keys into a list. It returns that list without changing the environment.

**Call relations**: remove_env_vars_with_prefix uses this as its search step before deleting variables. The tests call it directly to prove that matching works both for normal names and unusual non-text names.

*Call graph*: called by 3 (remove_env_vars_with_prefix, env_keys_with_prefix_filters_only_matching_keys, env_keys_with_prefix_handles_non_utf8_entries); 1 external calls (into_iter).


##### `tests::env_keys_with_prefix_handles_non_utf8_entries`  (lines 157–178)

```
fn env_keys_with_prefix_handles_non_utf8_entries()
```

**Purpose**: Tests that environment variable filtering still works when variable names or values are not valid UTF-8 text. This matters because Unix environment data is bytes, not guaranteed human-readable strings.

**Data flow**: It builds sample environment entries with non-UTF-8 bytes, including one key that starts with LD_. It passes them to env_keys_with_prefix and checks that only the matching LD_ key is returned. It changes no real process environment.

**Call relations**: This test exercises env_keys_with_prefix directly. It protects the cleanup logic from accidentally assuming all environment names can be converted into normal strings.

*Call graph*: calls 1 internal fn (env_keys_with_prefix); 5 external calls (from_bytes, from_vec, assert!, assert_eq!, vec!).


##### `tests::env_keys_with_prefix_filters_only_matching_keys`  (lines 181–192)

```
fn env_keys_with_prefix_filters_only_matching_keys()
```

**Purpose**: Tests that the prefix filter returns only keys with the requested prefix. It makes sure an LD_ search does not accidentally match unrelated names such as PATH or DYLD_FOO.

**Data flow**: It creates a small fake environment with PATH, LD_TEST, and DYLD_FOO. It asks env_keys_with_prefix for LD_ matches, then checks that the result contains exactly LD_TEST. It does not touch the real environment.

**Call relations**: This test calls env_keys_with_prefix directly. It verifies the basic selection behavior that remove_env_vars_with_prefix depends on before deleting real environment variables.

*Call graph*: calls 1 internal fn (env_keys_with_prefix); 3 external calls (from_bytes, assert_eq!, vec!).


### Global crypto provider setup
Install and validate the process-wide rustls crypto backend so later TLS use is deterministic.

### `utils/rustls-provider/src/lib.rs`

`orchestration` · `startup or before making TLS connections`

Secure network connections need low-level cryptography code to check certificates and encrypt traffic. In this project, rustls can be built with more than one possible crypto provider, which is like having two different sets of tools in the same toolbox. When both are available, rustls refuses to guess which one to use.

This file gives the program a clear answer: use the aws-lc-rs provider if possible. That choice matters because aws-lc-rs supports some certificate signature types that the ring provider does not, including ECDSA P-521 with SHA-512. Some company TLS inspection proxies use certificates with that signature type, so choosing the narrower provider could make otherwise valid network connections fail.

The main public function, ensure_rustls_crypto_provider, is safe to call many times. Internally it uses a Once, which is a small lock-like guard that makes sure setup runs only one time for the whole process. If another part of the host program already installed a rustls provider, this file does not overwrite it. But when it successfully installs aws-lc-rs itself, it immediately checks that the installed provider really supports the required certificate signature scheme. That turns a hidden TLS compatibility problem into an early, clear failure.

#### Function details

##### `ensure_rustls_crypto_provider`  (lines 10–32)

```
fn ensure_rustls_crypto_provider()
```

**Purpose**: This function makes sure rustls has a process-wide crypto provider selected. Callers use it before doing TLS work so secure connections do not fail later because rustls could not choose between available providers.

**Data flow**: It takes no input from the caller. It creates a one-time setup guard, then on the first call tries to install the aws-lc-rs rustls provider as the global default. If installation fails because something else already installed a provider, it leaves that existing choice alone. If installation succeeds, it reads back the installed provider and checks that it supports the required ECDSA P-521/SHA-512 certificate signature scheme; if that check fails, the program stops with a clear error.

**Call relations**: This is the public doorway for the file. Code elsewhere should call it before rustls is used. During its one-time setup it relies on the standard library's Once creation, then uses the helper provider_supports_required_signature_scheme to verify that the chosen provider has the certificate support this project expects.

*Call graph*: 1 external calls (new).


##### `provider_supports_required_signature_scheme`  (lines 34–39)

```
fn provider_supports_required_signature_scheme(provider: &rustls::crypto::CryptoProvider) -> bool
```

**Purpose**: This helper answers one focused question: does this rustls crypto provider support the certificate signature scheme the project requires? It keeps the compatibility check small and easy to read.

**Data flow**: It receives a rustls CryptoProvider. It looks at the provider's supported certificate signature schemes and checks whether the required ECDSA NIST P-521 with SHA-512 scheme is present. It returns true if the provider supports it and false if it does not; it does not change anything.

**Call relations**: This helper is used as part of the provider setup check in ensure_rustls_crypto_provider. After the global provider is installed and read back, this function supplies the yes-or-no answer that decides whether setup can continue or should fail loudly.


### Dispatch and runtime bootstrap
Set up argv-based command dispatch, PATH aliasing, process environment, and Tokio runtime scaffolding for the rest of the application.

### `arg0/src/lib.rs`

`orchestration` · `startup`

Codex is shipped mostly as one executable, but parts of the system need to call tools that look like separate commands, such as apply_patch or the Linux sandbox helper. This file solves that by using the “argv0 trick”: a program can inspect the name it was launched under, and choose a different behavior when that name is a special alias. It is like one worker wearing different name badges at different service counters.

At startup, the file first checks whether Codex was invoked as one of those helper names or with a hidden helper argument. If so, it immediately runs the matching helper and exits. If not, it loads safe user environment variables from ~/.codex/.env, refusing CODEX_ variables so a local file cannot override protected internal settings.

It then creates a per-session temporary directory containing aliases, such as apply_patch and, on Linux, codex-linux-sandbox. That directory is prepended to PATH so child processes can find those helper commands. A lock file keeps the directory alive while Codex is running, and a cleanup step removes old unlocked directories from earlier sessions.

Finally, it starts the real asynchronous Codex main function on a Tokio runtime, which is Rust’s async task executor, with a larger stack size to avoid stack overflows in deep work.

#### Function details

##### `Arg0PathEntryGuard::new`  (lines 45–51)

```
fn new(temp_dir: TempDir, lock_file: File, paths: Arg0DispatchPaths) -> Self
```

**Purpose**: Creates the guard object that keeps a temporary alias directory and its lock file alive. Without this guard, the helper command paths could disappear while Codex or its child processes still need them.

**Data flow**: It receives a temporary directory, an open lock file, and the helper paths discovered or created for this run. It stores all three inside one object. The returned guard owns those resources until it is dropped.

**Call relations**: The alias setup code calls this after creating the temporary helper directory. Tests also call it to build fake guards when checking sandbox path selection and whether aliases stay alive during the main async work.

*Call graph*: called by 3 (prepare_path_entry_for_codex_aliases, linux_sandbox_exe_path_prefers_codex_linux_sandbox_alias, run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns).


##### `Arg0PathEntryGuard::paths`  (lines 53–55)

```
fn paths(&self) -> &Arg0DispatchPaths
```

**Purpose**: Gives read-only access to the helper executable paths stored in the guard. Code uses this when it needs to know where the temporary aliases are.

**Data flow**: It reads the paths field inside the guard and returns a shared reference to it. Nothing is changed.

**Call relations**: It is used when later startup code needs to copy out paths, such as the Linux sandbox alias or the exec wrapper alias, while the guard continues to own the directory and lock.

*Call graph*: called by 1 (paths).


##### `arg0_dispatch`  (lines 58–162)

```
fn arg0_dispatch() -> Option<Arg0PathEntryGuard>
```

**Purpose**: Performs the early startup check that decides whether this process should behave as the main Codex CLI or as one of its helper commands. It also prepares the environment and PATH aliases for a normal Codex run.

**Data flow**: It reads the process arguments, especially the executable name and first argument. If they match a helper mode, it runs that helper and exits the process. Otherwise it loads allowed .env variables, creates helper aliases, updates PATH if needed, and returns a guard that keeps those aliases alive.

**Call relations**: arg0_dispatch_or_else calls this before the real main function starts. This function may hand off directly to helper implementations such as apply_patch, the file-system helper, the sandbox wrapper, or the execve wrapper, and otherwise hands back an Arg0PathEntryGuard for the normal startup path.

*Call graph*: calls 4 internal fn (load_dotenv, prepare_path_env_var_with_aliases, current, current_dir); called by 1 (arg0_dispatch_or_else); 16 external calls (new, apply_patch, main, run_fs_helper_main, run_main, run_shell_escalation_execve_wrapper, run_windows_sandbox_wrapper_main, eprintln!, args, args_os (+6 more)).


##### `prepare_path_env_var_with_aliases`  (lines 164–181)

```
fn prepare_path_env_var_with_aliases(
    install_context: &InstallContext,
    existing_path: Option<OsString>,
    prepare_aliases: impl FnOnce(Option<OsString>) -> std::io::Result<(Arg0PathEntryGua
```

**Purpose**: Builds the PATH value Codex should use at startup, combining any package-provided command directory with the temporary helper alias directory. If alias creation fails, it keeps going when possible so Codex can still start.

**Data flow**: It receives the install context, the existing PATH, and a function that tries to create aliases. It first adds the package path directory if one exists, then asks the alias-creation function to add the per-session alias directory. It returns an optional guard for aliases and an optional new PATH value.

**Call relations**: arg0_dispatch calls this while preparing startup. It calls path_env_with_package_path_dir first, then invokes the supplied alias preparation function, and warns the user if aliases could not be made.

*Call graph*: calls 1 internal fn (path_env_with_package_path_dir); called by 1 (arg0_dispatch); 1 external calls (eprintln!).


##### `arg0_dispatch_or_else`  (lines 207–236)

```
fn arg0_dispatch_or_else(main_fn: F) -> anyhow::Result<()>
```

**Purpose**: Wraps a binary crate’s real async main function with all the Codex startup work from this file. It is the usual entry wrapper for Codex executables that need helper dispatch and runtime setup.

**Data flow**: It receives an async main function. It runs arg0_dispatch, records the current executable path, starts a dedicated main thread with a large stack, builds a Tokio runtime there, and runs the main function with the helper paths. It returns success or an error from that main function, or rethrows a panic if the thread panicked.

**Call relations**: Binary entry points call this instead of directly building their own runtime. It calls arg0_dispatch first, then delegates the async portion to run_main_with_arg0_guard inside the newly built runtime.

*Call graph*: calls 1 internal fn (arg0_dispatch); 3 external calls (current_exe, resume_unwind, new).


##### `run_main_with_arg0_guard`  (lines 238–264)

```
async fn run_main_with_arg0_guard(
    path_entry_guard: Option<Arg0PathEntryGuard>,
    current_exe: Option<PathBuf>,
    main_fn: F,
) -> anyhow::Result<()>
```

**Purpose**: Runs the real async Codex main function while keeping the temporary helper aliases alive for the whole run. It also assembles the path information that the rest of Codex needs for re-running itself or launching helpers.

**Data flow**: It receives the optional alias guard, the current executable path, and the async main function. It builds an Arg0DispatchPaths value, choosing the Linux sandbox path when appropriate, then awaits the main function. Only after the main function finishes does it drop the guard.

**Call relations**: arg0_dispatch_or_else runs this inside the Tokio runtime. It calls linux_sandbox_exe_path to choose the best sandbox executable path, then hands the completed path bundle to the caller’s main function.

*Call graph*: calls 1 internal fn (linux_sandbox_exe_path); called by 1 (run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns); 1 external calls (cfg!).


##### `linux_sandbox_exe_path`  (lines 266–276)

```
fn linux_sandbox_exe_path(
    path_entry_guard: Option<&Arg0PathEntryGuard>,
    current_exe: Option<PathBuf>,
) -> Option<PathBuf>
```

**Purpose**: Chooses the executable path child processes should use when they need to start the Linux sandbox helper. It prefers the special alias because its file name triggers the right helper behavior.

**Data flow**: It receives an optional alias guard and an optional current executable path. If the guard contains a codex-linux-sandbox alias, it returns that. Otherwise it returns the current executable path if available.

**Call relations**: run_main_with_arg0_guard calls this while building the path bundle for the real main function. A unit test verifies that the alias wins over the plain Codex executable path.

*Call graph*: called by 1 (run_main_with_arg0_guard).


##### `build_runtime`  (lines 278–283)

```
fn build_runtime() -> anyhow::Result<tokio::runtime::Runtime>
```

**Purpose**: Creates the Tokio async runtime used to run Codex’s main async work. Tokio is the task engine that lets Rust run many waiting operations, such as I/O, without blocking one thread per task.

**Data flow**: It creates a multi-thread Tokio runtime builder, enables the standard runtime features, sets a larger stack size for worker threads, and returns the built runtime or an error.

**Call relations**: arg0_dispatch_or_else uses this inside the main runtime thread before running the real async entry point. Tests also use it when checking async guard lifetime behavior.

*Call graph*: 1 external calls (new_multi_thread).


##### `load_dotenv`  (lines 291–297)

```
fn load_dotenv()
```

**Purpose**: Loads user-defined environment variables from ~/.codex/.env during startup. This gives users a convenient place to set ordinary settings without editing their shell profile.

**Data flow**: It looks up the Codex home directory, tries to open the .env file there, and if successful passes the parsed key-value entries to set_filtered. If the home directory or file cannot be read, it silently does nothing.

**Call relations**: arg0_dispatch calls this before any threads are created, because changing process environment variables is only safe at that early single-threaded point. It delegates the safety filtering to set_filtered.

*Call graph*: calls 1 internal fn (set_filtered); called by 1 (arg0_dispatch); 2 external calls (find_codex_home, from_path_iter).


##### `set_filtered`  (lines 300–311)

```
fn set_filtered(iter: I)
```

**Purpose**: Sets environment variables from a .env iterator, but refuses any variable whose name starts with CODEX_. This protects internal Codex settings from being changed by a local .env file.

**Data flow**: It receives parsed .env entries. For each successfully parsed key and value, it uppercases the key for checking, skips CODEX_ keys, and sets all other variables in the process environment.

**Call relations**: load_dotenv calls this after reading ~/.codex/.env. It is the safety gate between user-provided environment data and the process-wide environment.

*Call graph*: called by 1 (load_dotenv); 2 external calls (into_iter, set_var).


##### `prepare_path_entry_for_codex_aliases`  (lines 326–436)

```
fn prepare_path_entry_for_codex_aliases(
    existing_path: Option<OsString>,
) -> std::io::Result<(Arg0PathEntryGuard, OsString)>
```

**Purpose**: Creates the temporary command aliases that let Codex expose helper tools without installing separate executables. It returns both the guard that keeps those aliases alive and the PATH value that makes them discoverable.

**Data flow**: It finds the Codex home directory, creates a secure temporary root, cleans up stale old alias directories, creates a fresh per-session directory, locks it, and writes aliases inside it. On Unix these are symbolic links, which are shortcut-like filesystem entries; on Windows it writes batch scripts for supported helpers. It then prepends that directory to PATH and returns the guard plus the new PATH.

**Call relations**: prepare_path_env_var_with_aliases receives this as the alias setup function during normal startup. It uses janitor_cleanup to remove old directories, path_env_with_entry to build PATH, and Arg0PathEntryGuard::new to package the live directory and lock.

*Call graph*: calls 3 internal fn (new, janitor_cleanup, path_env_with_entry); 13 external calls (options, new, find_codex_home, from_mode, eprintln!, format!, current_exe, temp_dir, create_dir_all, set_permissions (+3 more)).


##### `path_env_with_package_path_dir`  (lines 438–447)

```
fn path_env_with_package_path_dir(
    install_context: &InstallContext,
    existing_path: Option<OsString>,
) -> Option<OsString>
```

**Purpose**: Adds Codex’s package-provided command directory to PATH when the install layout says one exists. This helps packaged installs expose bundled helper commands in a predictable place.

**Data flow**: It reads the install context, looks for a package layout with a path_dir, and if present prepends that directory to the existing PATH. If no such directory is known, it returns nothing.

**Call relations**: prepare_path_env_var_with_aliases calls this before creating temporary aliases. It uses path_env_with_entry to do the actual PATH string construction.

*Call graph*: calls 1 internal fn (path_env_with_entry); called by 1 (prepare_path_env_var_with_aliases).


##### `path_env_with_entry`  (lines 449–467)

```
fn path_env_with_entry(path_entry: &Path, existing_path: Option<OsString>) -> OsString
```

**Purpose**: Builds a PATH environment variable with one directory placed at the front. Putting a directory first means the operating system looks there first when resolving command names.

**Data flow**: It receives a directory path and an optional existing PATH. It creates a new OS string starting with the new directory, then appends the platform’s PATH separator and the old PATH if there was one. It returns the combined PATH value.

**Call relations**: path_env_with_package_path_dir uses this for package paths, and prepare_path_entry_for_codex_aliases uses it for the temporary alias directory. Tests check that the order stays correct.

*Call graph*: called by 2 (path_env_with_package_path_dir, prepare_path_entry_for_codex_aliases); 2 external calls (with_capacity, as_os_str).


##### `janitor_cleanup`  (lines 469–496)

```
fn janitor_cleanup(temp_root: &Path) -> std::io::Result<()>
```

**Purpose**: Removes old per-session alias directories that are no longer in use. This prevents Codex’s home directory from filling up with stale temporary folders.

**Data flow**: It receives the temporary root directory, lists its entries, and looks only at subdirectories. For each directory, it tries to lock that directory’s lock file. If the lock is missing or currently held, it skips the directory; if the lock is available, it removes the whole directory.

**Call relations**: prepare_path_entry_for_codex_aliases calls this before making a new alias directory. It relies on try_lock_dir to decide whether a directory is safe to delete, and tests cover the cases of missing, held, and unlocked lock files.

*Call graph*: calls 1 internal fn (try_lock_dir); called by 4 (prepare_path_entry_for_codex_aliases, janitor_removes_dirs_with_unlocked_lock, janitor_skips_dirs_with_held_lock, janitor_skips_dirs_without_lock_file); 2 external calls (read_dir, remove_dir_all).


##### `try_lock_dir`  (lines 498–511)

```
fn try_lock_dir(dir: &Path) -> std::io::Result<Option<File>>
```

**Purpose**: Checks whether an alias directory appears unused by trying to lock its .lock file. A held lock means another Codex process is still using that directory.

**Data flow**: It receives a directory path, opens its .lock file if it exists, and tries to take a file lock. It returns an open locked file when successful, returns none when there is no lock file or the lock is already held, and returns an error for other failures.

**Call relations**: janitor_cleanup calls this for each candidate stale directory. The returned locked file is kept briefly so the cleanup code knows it has exclusive access while deleting.

*Call graph*: called by 1 (janitor_cleanup); 2 external calls (options, join).


##### `tests::create_lock`  (lines 543–551)

```
fn create_lock(dir: &Path) -> std::io::Result<File>
```

**Purpose**: Creates or opens the .lock file used by tests to simulate live or stale alias directories. It is a small test helper, not part of normal Codex startup.

**Data flow**: It receives a directory path, appends the lock file name, and opens the file for reading and writing, creating it if needed. It returns the open file to the test.

**Call relations**: Several tests call this before constructing guards or before running janitor_cleanup. It lets tests control whether a directory has no lock, an unlocked lock, or a held lock.

*Call graph*: 2 external calls (options, join).


##### `tests::package_path_test_fixture`  (lines 553–582)

```
fn package_path_test_fixture() -> anyhow::Result<PackagePathTestFixture>
```

**Purpose**: Builds a temporary fake install layout for tests that check PATH construction. It gives the tests real directories without touching the user’s machine.

**Data flow**: It creates a temporary directory tree with package, bin, package PATH, alias, and existing PATH directories. It converts the relevant paths into the project’s absolute path type and returns them bundled with an InstallContext.

**Call relations**: The PATH-related tests call this to avoid repeating setup. Those tests then pass its install context into path_env_with_package_path_dir or prepare_path_env_var_with_aliases.

*Call graph*: calls 1 internal fn (from_absolute_path); 2 external calls (new, create_dir_all).


##### `tests::linux_sandbox_exe_path_prefers_codex_linux_sandbox_alias`  (lines 585–604)

```
fn linux_sandbox_exe_path_prefers_codex_linux_sandbox_alias() -> std::io::Result<()>
```

**Purpose**: Verifies that Linux sandbox path selection prefers the temporary alias over the plain Codex executable. This matters because the alias name is what triggers sandbox helper dispatch.

**Data flow**: It creates a temporary guard containing a fake codex-linux-sandbox alias and a fake current Codex path. It calls linux_sandbox_exe_path and checks that the alias path is returned.

**Call relations**: This test directly exercises linux_sandbox_exe_path and uses Arg0PathEntryGuard::new plus create_lock to build the needed fake guard.

*Call graph*: calls 1 internal fn (new); 4 external calls (from, new, create_lock, assert_eq!).


##### `tests::path_env_can_prepend_package_path_before_arg0_alias_dir`  (lines 607–626)

```
fn path_env_can_prepend_package_path_before_arg0_alias_dir() -> anyhow::Result<()>
```

**Purpose**: Checks that PATH is built in the intended order when both a package path and an arg0 alias directory are present. The final search order should put temporary aliases first, then package commands, then the user’s existing PATH.

**Data flow**: It builds a fake install fixture, prepends the package path to an existing PATH, then prepends the arg0 alias directory. It splits the resulting PATH and compares the directory order with the expected list.

**Call relations**: This test exercises path_env_with_package_path_dir and path_env_with_entry together. It protects the startup ordering used by prepare_path_env_var_with_aliases.

*Call graph*: 4 external calls (package_path_test_fixture, assert_eq!, path_env_with_entry, path_env_with_package_path_dir).


##### `tests::package_path_survives_arg0_alias_setup_failure`  (lines 629–661)

```
fn package_path_survives_arg0_alias_setup_failure() -> anyhow::Result<()>
```

**Purpose**: Checks that Codex still keeps the package PATH update even if creating temporary aliases fails. This makes startup more forgiving when alias creation has a filesystem problem.

**Data flow**: It builds a fake install fixture and calls prepare_path_env_var_with_aliases with a deliberately failing alias setup function. It confirms no alias guard is returned, but the updated PATH still contains the package path before the existing path.

**Call relations**: This test directly covers the failure branch in prepare_path_env_var_with_aliases. It ensures the warning-and-continue behavior does not throw away useful package PATH information.

*Call graph*: 4 external calls (package_path_test_fixture, assert!, assert_eq!, prepare_path_env_var_with_aliases).


##### `tests::run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns`  (lines 665–704)

```
fn run_main_with_arg0_guard_keeps_aliases_alive_until_main_returns() -> anyhow::Result<()>
```

**Purpose**: Verifies that temporary alias files remain present while the async main function is running. This protects against a bug where the temporary directory could be deleted too early.

**Data flow**: It creates a temporary alias file and guard, then runs run_main_with_arg0_guard inside a runtime. The supplied async function checks that the alias exists before and after yielding to the task scheduler.

**Call relations**: This test uses build_runtime, Arg0PathEntryGuard::new, create_lock, and run_main_with_arg0_guard. It confirms the guard is intentionally dropped only after the main future completes.

*Call graph*: calls 2 internal fn (new, run_main_with_arg0_guard); 5 external calls (from, new, create_lock, write, build_runtime).


##### `tests::janitor_skips_dirs_without_lock_file`  (lines 707–716)

```
fn janitor_skips_dirs_without_lock_file() -> std::io::Result<()>
```

**Purpose**: Checks that cleanup does not delete directories that lack a .lock file. Such directories may not be safe to identify as old Codex alias directories.

**Data flow**: It creates a temporary root with one subdirectory and no lock file, runs janitor_cleanup, and verifies the subdirectory still exists.

**Call relations**: This test exercises janitor_cleanup’s missing-lock path, which depends on try_lock_dir returning none when the lock file is absent.

*Call graph*: calls 1 internal fn (janitor_cleanup); 3 external calls (assert!, create_dir, tempdir).


##### `tests::janitor_skips_dirs_with_held_lock`  (lines 719–730)

```
fn janitor_skips_dirs_with_held_lock() -> std::io::Result<()>
```

**Purpose**: Checks that cleanup does not delete an alias directory currently locked by another live process. This protects active Codex sessions.

**Data flow**: It creates a subdirectory, creates and holds its lock file, runs janitor_cleanup, and verifies the directory is still there.

**Call relations**: This test uses create_lock to hold a lock before calling janitor_cleanup. It covers the path where try_lock_dir sees that the lock would block.

*Call graph*: calls 1 internal fn (janitor_cleanup); 4 external calls (create_lock, assert!, create_dir, tempdir).


##### `tests::janitor_removes_dirs_with_unlocked_lock`  (lines 733–743)

```
fn janitor_removes_dirs_with_unlocked_lock() -> std::io::Result<()>
```

**Purpose**: Checks that cleanup removes a stale alias directory when its lock file exists but is not held. That is the sign of an old session that has ended.

**Data flow**: It creates a subdirectory with a lock file, leaves the lock unheld, runs janitor_cleanup, and verifies the directory was removed.

**Call relations**: This test covers the successful cleanup path through janitor_cleanup and try_lock_dir. It confirms the janitor can reclaim old per-session alias directories.

*Call graph*: calls 1 internal fn (janitor_cleanup); 4 external calls (create_lock, assert!, create_dir, tempdir).

## 📊 State Registers Touched

- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-tls-crypto-provider` — The one process-wide cryptography provider chosen early so HTTPS and other TLS connections use the same security engine.
- `reg-launch-invocation-context` — The raw launch context, including invoked binary/arg0, selected subcommand or runtime mode, startup flags, and output/interaction mode chosen before dispatch.
- `reg-process-hardening-state` — Process-wide hardening status and OS security settings applied at bootstrap, such as dump/inspection/tamper restrictions that affect the rest of the run.
