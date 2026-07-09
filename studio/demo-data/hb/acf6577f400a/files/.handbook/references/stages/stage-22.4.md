# Shell, command, git, plugin, and execution support utilities  `stage-22.4`

This stage is behind-the-scenes support used whenever the app must run outside programs, inspect Git, or package plugins. The shell pieces provide one common view of bash, zsh, PowerShell, sh, and cmd: they detect a safe shell, turn a command string into the right arguments, build the variables a program receives while filtering secrets, and format commands for display without changing their meaning. The Git pieces wrap the git program to ask safe, timed questions about repositories, roots, remotes, branches, commits, changes, filesystem monitoring, and diffs, including the TUI /diff view and shared-starting-commit checks.

The plugin pieces package plugin folders into bounded, safe archives, clone marketplace content into a temporary staging area, keep writes inside the install folder, and activate a prepared marketplace only when its recorded source and revision match. The execution pieces are the plumbing for tools and sandboxes: they normalize executable names, prepare Linux arguments and input/output handles, communicate with Windows sandbox runners, track process families, mirror command exit status, open an external editor, and provide a common interface for interactive child processes. Output helpers keep command logs useful by preserving the start and end when text is huge. The patch helper finds matching text flexibly.

## Files in this stage

### Shell modeling and command environment
These files define how shells are detected and represented, how shell command environments are built, and the shared command-parsing helpers exposed to the rest of the system.

### `shell-command/src/lib.rs`

`util` · `cross-cutting`

This file does not contain the command-checking logic itself. Instead, it defines the public shape of the library, like a table of contents for the command-related tools inside this crate. Other Codex crates can import this library when they need to understand shell commands, parse them, or decide whether a command looks dangerous.

The file exposes modules for different shell environments, such as Bash and PowerShell, plus command parsing and shell detection. It keeps the lower-level `command_safety` module private to the crate, but re-exports two important safety functions: `is_dangerous_command` and `is_safe_command`. That means outside code can use those safety checks directly without needing to know where the implementation lives.

In plain terms, this file is the shared doorway to a set of guardrails around shell commands. Without it, each caller would need to know the internal module layout, and the project would have a messier, more fragile way to reach the same safety checks.


### `shell-command/src/shell_detect.rs`

`domain_logic` · `command setup`

When this project needs to run a shell command, it must know which shell program to start. That is trickier than it sounds: different operating systems use different shells, users can configure their own default shell, and some shell paths may not actually exist on the machine. This file is the project’s “find me a usable shell” guide.

It defines the shell kinds the project understands, then provides a small record, DetectedShell, that pairs a shell kind with the path to the program on disk. The main flow is cautious. First it tries any path that was explicitly provided. Then, on Unix-like systems, it looks up the user’s login shell from the operating system account database. Next it searches the system PATH, which is the standard list of places where command-line programs are found. Finally it checks a few well-known fallback locations.

If all of that fails, it still returns a last-resort shell: cmd.exe on Windows, or /bin/sh elsewhere. That matters because shell command execution should not crash just because the preferred shell cannot be found. The file also treats PowerShell carefully, because it may be installed as either pwsh or powershell depending on the platform and version.

#### Function details

##### `ShellType::name`  (lines 16–24)

```
fn name(self) -> &'static str
```

**Purpose**: Returns the plain text name for a known shell type, such as "bash" or "powershell". This is useful when other parts of the program need a human-readable shell name rather than an internal enum value.

**Data flow**: It starts with one ShellType value. It matches that value against the supported shell choices and returns a fixed short string for that shell. It does not read files or change anything.

**Call relations**: When a DetectedShell needs to report its name, it delegates to this function so there is only one place that decides the spelling of each shell name.

*Call graph*: called by 2 (name, name).


##### `DetectedShell::name`  (lines 34–36)

```
fn name(&self) -> &'static str
```

**Purpose**: Returns the display name of a detected shell. It lets callers ask the combined shell record for its name without reaching into the shell_type field directly.

**Data flow**: It reads the DetectedShell’s shell_type field, asks ShellType::name to translate that type into text, and returns that text. The stored shell path is not changed or used for this answer.

**Call relations**: This function is the small bridge between the full detected shell record and the simpler ShellType naming helper. Code that receives a DetectedShell can call this when it needs a simple label.

*Call graph*: calls 1 internal fn (name); called by 1 (from).


##### `detect_shell_type`  (lines 39–59)

```
fn detect_shell_type(shell_path: impl AsRef<std::path::Path>) -> Option<ShellType>
```

**Purpose**: Looks at a shell path or command name and tries to recognize what kind of shell it refers to. For example, it can recognize both "bash" and "/usr/bin/bash" as Bash.

**Data flow**: It receives something path-like. First it checks whether the whole path text is already a known shell name. If not, it strips the path down to the file name without an extension, such as turning "powershell.exe" into "powershell", and tries again. It returns a ShellType when it recognizes the name, or None when it does not.

**Call relations**: This function is used when the program is given a possible shell path and needs to classify it before looking for an executable. get_shell_path uses it to verify the user’s default shell, and get_shell_by_model_provided_path uses it to interpret a path supplied from outside.

*Call graph*: called by 2 (get_shell_by_model_provided_path, get_shell_path); 4 external calls (as_os_str, as_ref, file_stem, new).


##### `get_user_shell_path`  (lines 123–125)

```
fn get_user_shell_path() -> Option<PathBuf>
```

**Purpose**: Finds the current user’s configured login shell when the operating system supports that idea. On Unix-like systems it reads the account database; on non-Unix systems it returns no path.

**Data flow**: On Unix, it asks the operating system for the current user ID, then uses a thread-safe account lookup to find that user’s shell path. It grows a temporary buffer if the operating system says the first buffer is too small. If it finds a shell string, it turns it into a PathBuf; if anything is missing or fails, it returns None. On non-Unix platforms, it simply returns None.

**Call relations**: This is one of the early sources of truth for shell choice. default_user_shell calls it to start from the user’s real login shell, and get_shell_path also consults it before falling back to PATH searches and hard-coded locations.

*Call graph*: called by 2 (default_user_shell, get_shell_path); 9 external calls (from_ptr, uninit, from, getpwuid_r, getuid, sysconf, null_mut, try_from, vec!).


##### `file_exists`  (lines 127–133)

```
fn file_exists(path: &std::path::Path) -> Option<PathBuf>
```

**Purpose**: Checks whether a path points to a real file. It is used to avoid choosing a shell path that looks plausible but is not actually present.

**Data flow**: It receives a path, asks the file system for information about it, and checks whether that information says it is a file. If yes, it returns a PathBuf copy of the path. If the path does not exist, cannot be read, or is not a file, it returns None.

**Call relations**: get_shell_path calls this helper each time it wants to trust a possible shell location. This keeps the shell search from accepting broken paths too early.

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

**Purpose**: Searches for an executable path for one specific shell type. It tries the most trustworthy clues first, then gradually falls back to broader guesses.

**Data flow**: It receives the desired shell type, an optional provided path, the usual executable name, and a list of fallback paths. It first accepts the provided path only if it exists as a file. Then it checks the user’s configured shell and makes sure it is the requested type. Then it searches the system PATH using the binary name. Last, it checks the fallback paths one by one. It returns the first usable path it finds, or None if none work.

**Call relations**: The shell-specific helpers, such as get_bash_shell and get_zsh_shell, call this shared search routine so all shell types follow the same careful order. It relies on detect_shell_type, get_user_shell_path, file_exists, and the external PATH search to narrow guesses into a real executable path.

*Call graph*: calls 3 internal fn (detect_shell_type, file_exists, get_user_shell_path); called by 5 (get_bash_shell, get_cmd_shell, get_powershell_shell, get_sh_shell, get_zsh_shell); 2 external calls (new, which).


##### `get_zsh_shell`  (lines 168–175)

```
fn get_zsh_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a DetectedShell for zsh if a usable zsh executable can be found. zsh is common on macOS and some Unix-like systems.

**Data flow**: It receives an optional preferred path. It asks get_shell_path to find zsh, using "zsh" as the command name and /bin/zsh as a fallback. If a path is found, it wraps that path with ShellType::Zsh. If not, it returns None.

**Call relations**: get_shell calls this when the requested shell type is Zsh. This helper keeps the zsh-specific fallback list separate while reusing the common search behavior.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `get_bash_shell`  (lines 179–186)

```
fn get_bash_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a DetectedShell for Bash if a usable Bash executable can be found. Bash is a common default shell on many Unix-like systems.

**Data flow**: It receives an optional preferred path. It asks get_shell_path to find bash, using "bash" as the command name and common locations such as /bin/bash and /usr/bin/bash as fallbacks. If found, it returns a DetectedShell marked as Bash; otherwise it returns None.

**Call relations**: get_shell calls this when Bash is requested. Like the other shell-specific helpers, it supplies Bash’s names and fallback paths while leaving the search process to get_shell_path.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `get_sh_shell`  (lines 190–197)

```
fn get_sh_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a DetectedShell for the basic sh shell if it can be found. sh is the safest Unix fallback because it is expected to exist on almost every Unix-like system.

**Data flow**: It receives an optional preferred path. It asks get_shell_path to find "sh", with /bin/sh as the fallback location. If a file is found, it returns a DetectedShell marked as Sh; if not, it returns None.

**Call relations**: get_shell calls this when Sh is requested. It is also part of the broader fallback story, because ultimate_fallback_shell uses /bin/sh directly on non-Windows systems if normal detection fails.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `get_powershell_shell`  (lines 215–230)

```
fn get_powershell_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a DetectedShell for PowerShell if either modern PowerShell or Windows PowerShell can be found. It knows that PowerShell may appear under different executable names.

**Data flow**: It receives an optional preferred path. It first searches for "pwsh", the newer cross-platform PowerShell executable. If that fails, it searches for "powershell", the older Windows PowerShell executable. Each search uses platform-appropriate fallback locations. If either search finds a path, it returns a DetectedShell marked as PowerShell; otherwise it returns None.

**Call relations**: get_shell calls this when PowerShell is requested. Internally it calls get_shell_path twice because PowerShell has two common command names, and the first successful search wins.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `get_cmd_shell`  (lines 232–239)

```
fn get_cmd_shell(path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Builds a DetectedShell for the Windows cmd shell if it can be found. cmd is the traditional Windows command interpreter.

**Data flow**: It receives an optional preferred path. It asks get_shell_path to find "cmd" without extra hard-coded fallback paths. If found, it wraps the path as ShellType::Cmd. If no usable executable is found, it returns None.

**Call relations**: get_shell calls this when Cmd is requested. If normal detection later fails on Windows, ultimate_fallback_shell can still provide a simple cmd.exe fallback.

*Call graph*: calls 1 internal fn (get_shell_path); called by 1 (get_shell).


##### `ultimate_fallback_shell`  (lines 241–253)

```
fn ultimate_fallback_shell() -> DetectedShell
```

**Purpose**: Provides a last-resort shell when all detection and searching has failed. It keeps the program from being left with no shell choice at all.

**Data flow**: It checks which operating system the program was built for. On Windows it returns a DetectedShell for cmd.exe. On other systems it returns a DetectedShell for /bin/sh. It does not verify the file at that moment; it is the final assumption after safer options have failed.

**Call relations**: Higher-level shell selection uses this when no preferred or discovered shell works. It is the safety net at the end of the decision chain.

*Call graph*: called by 1 (ultimate_fallback_shell); 2 external calls (from, cfg!).


##### `get_shell_by_model_provided_path`  (lines 255–259)

```
fn get_shell_by_model_provided_path(shell_path: &PathBuf) -> DetectedShell
```

**Purpose**: Turns an externally provided shell path into the project’s DetectedShell record. If the path cannot be recognized or resolved, it falls back to the safest default shell.

**Data flow**: It receives a PathBuf, tries to identify the shell type from the path text, then attempts to build a detected shell using that type and path. If any step fails, it returns ultimate_fallback_shell instead. The result is always a DetectedShell, never None.

**Call relations**: This is used when some outside source has already suggested a shell path. It starts by calling detect_shell_type, then follows the normal shell lookup path when possible, with ultimate_fallback_shell as the final backup.

*Call graph*: calls 1 internal fn (detect_shell_type); called by 1 (get_shell_by_model_provided_path).


##### `get_shell`  (lines 261–269)

```
fn get_shell(shell_type: ShellType, path: Option<&PathBuf>) -> Option<DetectedShell>
```

**Purpose**: Dispatches a requested shell type to the right shell-specific finder. It is the common entry point when code already knows whether it wants Bash, zsh, PowerShell, sh, or cmd.

**Data flow**: It receives a ShellType and an optional preferred path. It matches the type and calls the corresponding helper, such as get_bash_shell for Bash or get_powershell_shell for PowerShell. It returns that helper’s DetectedShell result, or None if that shell cannot be found.

**Call relations**: default_user_shell_from_path uses this to turn a chosen shell type into a real executable path. The function itself is the switchboard that routes each shell type to its specialized finder.

*Call graph*: calls 5 internal fn (get_bash_shell, get_cmd_shell, get_powershell_shell, get_sh_shell, get_zsh_shell); called by 2 (get_shell, default_user_shell_from_path).


##### `default_user_shell`  (lines 271–273)

```
fn default_user_shell() -> DetectedShell
```

**Purpose**: Chooses the best default shell for the current user. It is the simple public function to call when the program needs a shell but was not given one.

**Data flow**: It asks the operating system for the current user’s shell path through get_user_shell_path. It then passes that optional path into default_user_shell_from_path, which applies the full platform-specific fallback logic. It returns a DetectedShell every time.

**Call relations**: This function sits near the top of the shell detection flow. Callers that just need a sensible default call this, and it hands the real decision work to default_user_shell_from_path.

*Call graph*: calls 2 internal fn (default_user_shell_from_path, get_user_shell_path); called by 2 (default_user_shell, local).


##### `default_user_shell_from_path`  (lines 275–295)

```
fn default_user_shell_from_path(user_shell_path: Option<PathBuf>) -> DetectedShell
```

**Purpose**: Chooses a default shell starting from an optional user shell path. This is the main fallback policy for turning “maybe we know the user’s shell” into a definite shell choice.

**Data flow**: It receives an optional path. On Windows, it prefers PowerShell and falls back to the ultimate fallback if needed. On other systems, it tries to recognize the user’s shell path and find that shell. If that does not work, it tries common shells in an order that depends on the platform: macOS prefers zsh before Bash, while other Unix-like systems prefer Bash before zsh. If nothing works, it returns ultimate_fallback_shell.

**Call relations**: default_user_shell calls this after reading the user’s configured shell. It repeatedly uses get_shell to test each candidate shell in priority order, then uses the final fallback only if all candidates fail.

*Call graph*: calls 1 internal fn (get_shell); called by 2 (default_user_shell_from_path, default_user_shell); 1 external calls (cfg!).


##### `tests::test_detect_shell_type`  (lines 303–367)

```
fn test_detect_shell_type()
```

**Purpose**: Checks that shell type recognition works for plain names, full paths, and executable names with extensions. It protects the path-recognition behavior from accidental changes.

**Data flow**: The test feeds detect_shell_type many sample inputs, such as "zsh", "/bin/bash", "powershell.exe", and "cmd.exe". For each input, it compares the returned shell type with the expected answer. If any comparison is wrong, the test fails.

**Call relations**: This test focuses on the recognition helper because many higher-level choices depend on that first classification step. It uses assertions to make sure detect_shell_type keeps recognizing the shell names that the rest of the file expects.

*Call graph*: 1 external calls (assert_eq!).


### `core/src/shell.rs`

`domain_logic` · `command execution setup and environment resolution`

When the project needs to run a command, it cannot treat every computer the same. Unix shells like bash and zsh use flags such as `-c`, while PowerShell and Windows cmd use different words and rules. This file is the small adapter that hides those differences behind one `Shell` type.

A `Shell` stores two important facts: what kind of shell it is, and where the shell program lives on disk. From there, it can answer simple questions like “what is this shell called?” and “what arguments should we pass to start it and run this command?” That second job matters because a wrong flag can make a command fail, skip user setup files, or behave differently than expected.

The file also converts shell information coming from other parts of the system into this local `Shell` shape. Some shell detection work is delegated to the `codex_shell_command` crate, which is like a specialist helper for finding shells on the machine. This file wraps those results so the core code can use a consistent type.

A notable detail is login-shell behavior. For bash-like shells, using a login shell changes `-c` into `-lc`. For PowerShell, the choice controls whether `-NoProfile` is added. In plain terms, this decides whether the shell should load more of the user’s normal startup environment before running the command.

#### Function details

##### `Shell::name`  (lines 16–18)

```
fn name(&self) -> &'static str
```

**Purpose**: Returns the short human-readable name of this shell, such as `bash`, `zsh`, or `powershell`. This is useful when other parts of the system need to display or record which shell is being used.

**Data flow**: It starts with a `Shell` that already knows its shell type. It asks that shell type for its standard name, then returns that name as a fixed text value. It does not change the shell.

**Call relations**: When environment reporting or script execution needs a label for the shell, code such as `build_environment_update_item` and `run_script_with_timeout` calls this function. The function delegates the naming detail to the underlying shell type so callers do not need to know each shell’s spelling.

*Call graph*: calls 1 internal fn (name); called by 2 (build_environment_update_item, run_script_with_timeout).


##### `Shell::derive_exec_args`  (lines 22–49)

```
fn derive_exec_args(&self, command: &str, use_login_shell: bool) -> Vec<String>
```

**Purpose**: Builds the exact command-line argument list needed to run a command through this shell. Someone uses it before launching a process, because bash, PowerShell, and cmd all expect different flags.

**Data flow**: It receives a command string and a yes-or-no choice about whether to use a login shell. It combines those with the shell’s path and shell type. The result is a list of strings, starting with the shell program path, followed by the correct flags and then the command text. It does not run the command itself.

**Call relations**: Process-building code calls this when it is ready to turn a script into something the operating system can execute. `run_script_with_timeout` uses it for timed script runs, and `base_command` uses it while constructing the lower-level process command. This function is the translation step between “run this text” and “start this shell with these arguments.”

*Call graph*: called by 2 (run_script_with_timeout, base_command); 1 external calls (vec!).


##### `Shell::from`  (lines 53–58)

```
fn from(detected: DetectedShell) -> Self
```

**Purpose**: Converts a detected shell from the shell-detection helper crate into this file’s `Shell` type. This lets the core code use one local shape even when the information came from another crate.

**Data flow**: It receives a `DetectedShell`, which already contains a shell type and a path. It copies those two pieces into a new `Shell` value and returns it. Nothing else is looked up or changed.

**Call relations**: This conversion is used by the wrapper functions in this file after they ask `codex_shell_command` to find or choose a shell. It is the handoff point from the external detection helper into the core system’s own shell representation.


##### `Shell::from_environment_shell_info`  (lines 62–76)

```
fn from_environment_shell_info(shell_info: ShellInfo) -> anyhow::Result<Self>
```

**Purpose**: Builds a `Shell` from shell information supplied by the execution environment. It also rejects unknown shell names so the rest of the system does not try to run commands with unsupported rules.

**Data flow**: It receives a `ShellInfo` value containing a shell name and a path. It matches the name against the supported shells: zsh, bash, PowerShell, sh, and cmd. If the name is known, it turns the path text into a filesystem path and returns a `Shell`. If the name is unknown, it returns an error instead.

**Call relations**: `resolve_selection` calls this while deciding which shell an environment should use. This function acts like a gatekeeper: it turns environment-provided data into a safe local `Shell`, or stops the flow with a clear error if the shell is not recognized.

*Call graph*: called by 1 (resolve_selection); 2 external calls (from, bail!).


##### `ultimate_fallback_shell`  (lines 80–82)

```
fn ultimate_fallback_shell() -> Shell
```

**Purpose**: Provides a last-resort shell for Unix tests when normal shell detection is not the focus. It exists only in test builds on Unix-like systems.

**Data flow**: It asks the shell-detection helper for its ultimate fallback shell, then converts that detected shell into this file’s `Shell` type. The result is a usable test shell value.

**Call relations**: This is a test-only bridge to the fallback logic in `codex_shell_command`. It helps tests get a predictable shell without duplicating the lower-level detection rules here.

*Call graph*: calls 1 internal fn (ultimate_fallback_shell).


##### `get_shell_by_model_provided_path`  (lines 84–86)

```
fn get_shell_by_model_provided_path(shell_path: &PathBuf) -> Shell
```

**Purpose**: Chooses a shell based on a path that was provided directly, for example when another part of the system already knows where the shell executable is. It wraps the shared shell-detection helper’s answer in the core `Shell` type.

**Data flow**: It receives a filesystem path. It passes that path to the shell-detection helper, which decides what kind of shell the path points to. It then converts the detected result into a `Shell` and returns it.

**Call relations**: Code such as `with_windows_cmd_shell` uses this when it wants to force or test a specific shell path. The detailed path interpretation is handed off to the detection crate, while this function keeps the rest of core working with the local `Shell` type.

*Call graph*: calls 1 internal fn (get_shell_by_model_provided_path); called by 1 (with_windows_cmd_shell).


##### `get_shell`  (lines 88–90)

```
fn get_shell(shell_type: ShellType, path: Option<&PathBuf>) -> Option<Shell>
```

**Purpose**: Looks up a shell of a requested type, optionally using a specific path if one is supplied. It returns nothing if that shell cannot be found or accepted.

**Data flow**: It receives the desired shell type and, optionally, a path. It asks the shell-detection helper to find that shell. If the helper returns a detected shell, this function converts it into a `Shell`; if not, it returns `None`.

**Call relations**: Startup and snapshot-writing paths call this when they need a particular shell choice rather than the default. For example, `new` can use it while setting up state, and `write_shell_snapshot` can use it when recording which shell was selected.

*Call graph*: calls 1 internal fn (get_shell); called by 2 (new, write_shell_snapshot).


##### `default_user_shell`  (lines 92–94)

```
fn default_user_shell() -> Shell
```

**Purpose**: Finds the normal shell for the current user and returns it as a `Shell`. This is the common path when no special shell was requested.

**Data flow**: It asks the shell-detection helper to determine the user’s default shell. The detected shell is then converted into this file’s `Shell` type and returned. The caller receives a ready-to-use shell choice.

**Call relations**: Many parts of the system rely on this as the ordinary shell selection path. It is used during session creation, environment resolution, command-output setup, and several tests that need realistic shell behavior. In the bigger flow, it answers the question “what shell should we use if nobody says otherwise?”

*Call graph*: calls 1 internal fn (default_user_shell); called by 15 (current_shell_output_command, latest_environment_update_wins_while_previous_resolution_is_pending, resolve_turn_environments, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, resolved_environments_for_configuration, test_get_command_rejects_explicit_login_when_disallowed, test_get_command_rejects_explicit_shell_in_zsh_fork_mode, test_get_command_respects_explicit_bash_shell (+5 more)).


##### `default_user_shell_from_path`  (lines 97–99)

```
fn default_user_shell_from_path(user_shell_path: Option<PathBuf>) -> Shell
```

**Purpose**: Builds the default-user-shell choice from an optional path in macOS tests. It lets tests check how default shell selection behaves when the user shell path is known, missing, or unusual.

**Data flow**: It receives either a filesystem path or no path. It passes that value to the shell-detection helper’s macOS-focused default-shell logic, then converts the detected shell into this file’s `Shell` type. The result is a test shell value.

**Call relations**: This function is only compiled for tests on macOS. It connects the core test module to the shared shell-detection behavior without copying macOS-specific shell selection rules into this file.

*Call graph*: calls 1 internal fn (default_user_shell_from_path).


### `protocol/src/shell_environment.rs`

`domain_logic` · `shell command setup`

When this system starts a shell command, it must decide what parts of the parent process environment to pass along. Environment variables are small name-value settings, such as PATH or HOME, that programs use to find tools, locate user folders, or read credentials. Passing everything through can leak secrets. Passing too little can make basic commands fail. This file is the gatekeeper that chooses a safe and useful middle ground.

The main flow starts with either the real process environment or a supplied list of variables, which is useful for tests. A shell environment policy then says whether to inherit all variables, none, or only a small core set needed for normal shell startup. After that, the file removes secret-looking variables by default, using patterns such as names containing KEY, SECRET, or TOKEN. It then applies any custom exclusions, adds user-specified overrides, optionally narrows the result to an allow-list, and finally adds a CODEX_THREAD_ID variable if one was provided.

There is also special Windows behavior. On Windows, PATHEXT tells the shell which file extensions count as runnable commands, such as .EXE or .BAT. If it is missing, this file adds a default value so shell commands work reliably in Windows test and build environments.

#### Function details

##### `create_env`  (lines 10–15)

```
fn create_env(
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<&str>,
) -> HashMap<String, String>
```

**Purpose**: Builds a shell environment from the current process environment. This is the normal entry point when the program is about to run a shell command and needs a filtered, policy-approved set of variables.

**Data flow**: It receives a shell environment policy and an optional thread ID. It reads the current process environment, passes those variables to create_env_from_vars, and returns the final map of variable names to values.

**Call relations**: Higher-level code, including child_env, calls this when preparing a child shell process. create_env does not do the filtering itself; it hands the real environment to create_env_from_vars so the same rules can be reused with test-provided variables.

*Call graph*: calls 1 internal fn (create_env_from_vars); called by 2 (create_env, child_env); 1 external calls (vars).


##### `create_env_from_vars`  (lines 17–44)

```
fn create_env_from_vars(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<&str>,
) -> HashMap<String, String>
```

**Purpose**: Builds a shell environment from a supplied list of variables instead of directly reading the machine's environment. This makes the environment-building rules reusable and easy to test.

**Data flow**: It receives variable name-value pairs, a policy, and an optional thread ID. It first asks populate_env to apply the main inheritance, filtering, override, and thread-ID rules. On Windows, it then checks whether PATHEXT is present, ignoring letter case, and inserts a safe default if it is missing. It returns the finished environment map.

**Call relations**: create_env calls this after collecting the real process variables. Tests and other callers, such as remote_env_policy_effectively_filters_unrequested_vars, call it directly with controlled input so they can check the policy behavior without depending on the host machine.

*Call graph*: calls 1 internal fn (populate_env); called by 4 (create_env_from_vars, create_env, create_env_inserts_pathext_on_windows_when_missing, remote_env_policy_effectively_filters_unrequested_vars); 1 external calls (cfg!).


##### `populate_env`  (lines 46–110)

```
fn populate_env(
    vars: I,
    policy: &ShellEnvironmentPolicy,
    thread_id: Option<&str>,
) -> HashMap<String, String>
```

**Purpose**: Applies the actual environment policy rules. It decides what to inherit, what to remove, what to add, and whether to attach the Codex thread ID.

**Data flow**: It receives an input list of environment variables, a policy, and an optional thread ID. First it chooses the starting set: all variables, no variables, or only platform-specific core variables such as PATH and HOME. Then it removes default secret-like names unless that safety filter is disabled. Next it applies custom excludes, inserts explicit user-set values, optionally keeps only names matching include_only patterns, and finally adds CODEX_THREAD_ID when given. The output is a HashMap containing the environment that should be passed to the shell.

**Call relations**: create_env_from_vars relies on this function for the main policy work before adding any Windows-specific fallback. The platform-specific tests call populate_env directly to confirm that the core inheritance rules keep the right startup variables and compare names without caring about letter case.

*Call graph*: called by 4 (populate_env, create_env_from_vars, core_inherit_preserves_non_windows_core_vars_case_insensitively, core_inherit_preserves_windows_startup_vars_case_insensitively); 3 external calls (new, into_iter, vec!).


##### `windows_tests::make_vars`  (lines 156–161)

```
fn make_vars(pairs: &[(&str, &str)]) -> Vec<(String, String)>
```

**Purpose**: Creates test environment variables in the same shape used by the production functions. It keeps the Windows tests readable by letting each test list simple string pairs.

**Data flow**: It receives a slice of borrowed string pairs like key and value. It copies each pair into owned String values and returns a vector of environment variable pairs ready to pass into populate_env or create_env_from_vars.

**Call relations**: The Windows test for core inheritance calls this helper before calling populate_env. It does not participate in runtime behavior; it only prepares clean test input.


##### `windows_tests::core_inherit_preserves_windows_startup_vars_case_insensitively`  (lines 165–196)

```
fn core_inherit_preserves_windows_startup_vars_case_insensitively()
```

**Purpose**: Checks that Windows core inheritance keeps important startup variables even when their names use different capitalization. This matters because Windows environment variable names are commonly treated without strict case sensitivity.

**Data flow**: It builds a small fake environment containing Windows startup variables with mixed-case names plus a secret-looking API key. It creates a policy that inherits only core variables and disables the default secret filter so the test focuses on core selection. It calls populate_env and compares the result with the expected kept variables.

**Call relations**: This test uses windows_tests::make_vars to prepare input and then calls populate_env directly. Its role is to protect the platform-specific core-variable list and the case-insensitive matching behavior on Windows.

*Call graph*: calls 1 internal fn (populate_env); 4 external calls (default, from, assert_eq!, make_vars).


##### `windows_tests::create_env_inserts_pathext_on_windows_when_missing`  (lines 200–211)

```
fn create_env_inserts_pathext_on_windows_when_missing()
```

**Purpose**: Checks that Windows environments get a default PATHEXT value when none is inherited. This protects command launching, because Windows shells use PATHEXT to know which file extensions can be executed.

**Data flow**: It creates a policy that inherits no variables and disables default exclusions. It passes an empty variable list into create_env_from_vars. The expected result is a map containing only PATHEXT with the default executable extensions.

**Call relations**: This test calls create_env_from_vars rather than populate_env because the PATHEXT fallback is added after the main policy logic. It confirms the Windows-specific safety patch remains in place.

*Call graph*: calls 1 internal fn (create_env_from_vars); 4 external calls (default, from, new, assert_eq!).


##### `non_windows_tests::make_vars`  (lines 219–224)

```
fn make_vars(pairs: &[(&str, &str)]) -> Vec<(String, String)>
```

**Purpose**: Creates test environment variables for non-Windows tests. It lets tests describe input as simple key-value string pairs and converts them into the owned format the environment code expects.

**Data flow**: It receives borrowed key-value pairs, copies each key and value into owned strings, and returns a vector of environment variable pairs.

**Call relations**: The non-Windows core inheritance test calls this helper before calling populate_env. It is test-only support and is not used in normal shell setup.


##### `non_windows_tests::core_inherit_preserves_non_windows_core_vars_case_insensitively`  (lines 227–249)

```
fn core_inherit_preserves_non_windows_core_vars_case_insensitively()
```

**Purpose**: Checks that non-Windows core inheritance keeps important shell variables such as PATH, HOME, and TMPDIR even when capitalization differs. This helps commands start correctly on Unix-like systems.

**Data flow**: It builds a fake environment containing mixed-case core variables and a secret-looking API key. It creates a policy that keeps only core variables and disables the default secret filter so the test is only about core matching. It calls populate_env and compares the output with the expected core variables.

**Call relations**: This test uses non_windows_tests::make_vars for input and then exercises populate_env directly. It guards the Unix-style core-variable list and the case-insensitive matching behavior used by the policy.

*Call graph*: calls 1 internal fn (populate_env); 4 external calls (default, from, assert_eq!, make_vars).


### `tui/src/exec_command.rs`

`util` · `cross-cutting, whenever commands or paths are prepared for display`

When a program runs a command, it often stores it as a list of separate words, such as the program name and its arguments. Humans, however, expect to see one readable command line. This file is the small translation layer between those two views.

Its main job is to format commands safely. For example, if an argument contains a space or a special shell character, `escape_command` quotes it so it still means one argument when shown or reused. Another helper, `strip_bash_lc_and_escape`, recognizes common shell wrappers like `bash -lc "..."` or `zsh -lc "..."`. Instead of showing the wrapper, it shows the actual script inside, which is what the user usually cares about.

The file also does the reverse in a cautious way. `split_command_string` tries to split a command-line string into separate arguments, but only if it can prove the split can be put back together without changing the command. This matters because shell syntax can be tricky, especially on Windows paths such as `C:\Program Files\...`; guessing wrong would be worse than not splitting at all.

Finally, `relativize_to_home` shortens absolute paths inside the user’s home directory, so displays can show a friendlier path relative to home. The tests protect the quoting, shell-wrapper, and Windows-path edge cases.

#### Function details

##### `escape_command`  (lines 8–10)

```
fn escape_command(command: &[String]) -> String
```

**Purpose**: Turns a list of command arguments into one shell-style command line for display. It quotes spaces and special characters where needed, so the shown command keeps the same meaning.

**Data flow**: It receives a slice of strings, where each string is one command argument. It asks the shell-quoting library to join those pieces safely; if that fails, it falls back to simply joining the pieces with spaces. The result is one readable command-line string.

**Call relations**: This is the basic formatter used when no special shell wrapper needs to be removed. `strip_bash_lc_and_escape` calls it as its fallback, and the test `tests::test_escape_command` checks that arguments with spaces and special characters are quoted correctly.

*Call graph*: called by 2 (strip_bash_lc_and_escape, test_escape_command); 1 external calls (try_join).


##### `strip_bash_lc_and_escape`  (lines 12–17)

```
fn strip_bash_lc_and_escape(command: &[String]) -> String
```

**Purpose**: Shows the real command inside common shell wrappers such as `bash -lc` or `zsh -lc`. If there is no such wrapper, it formats the full argument list normally.

**Data flow**: It receives command arguments as separate strings. First it asks `extract_shell_command` whether those arguments represent a shell launching a script. If so, it returns just that script text. If not, it passes the arguments to `escape_command` and returns the safely joined command line.

**Call relations**: This is used by display-building code such as `build_header`, `command_display_lines`, and `transcript_lines`, where users need to read what command was run. It hands off to `extract_shell_command` to detect shell wrappers and to `escape_command` when ordinary formatting is enough. The test `tests::test_strip_bash_lc_and_escape` confirms that bash and zsh wrappers, including absolute shell paths, are hidden from the final display.

*Call graph*: calls 2 internal fn (extract_shell_command, escape_command); called by 4 (build_header, command_display_lines, transcript_lines, test_strip_bash_lc_and_escape).


##### `split_command_string`  (lines 19–33)

```
fn split_command_string(command: &str) -> Vec<String>
```

**Purpose**: Tries to turn one command-line string back into a list of arguments, but only when doing so appears safe. If the command cannot be split reliably, it keeps the whole string as one item.

**Data flow**: It receives a single command string. It first asks the shell-splitting library to parse it into parts. Then it joins those parts back together and checks whether that round trip preserves the original command, or at least parses back into the same parts without looking like a Windows drive path problem. If the check passes, it returns the split parts; otherwise it returns a one-item list containing the original command.

**Call relations**: This function is used by `command_execution_command_and_parsed`, which needs both the original command text and a parsed version when parsing is trustworthy. It relies on shell-splitting and shell-joining helpers, but deliberately refuses to split commands that may be changed by the process, especially Windows-style paths.

*Call graph*: called by 1 (command_execution_command_and_parsed); 3 external calls (split, try_join, vec!).


##### `relativize_to_home`  (lines 38–51)

```
fn relativize_to_home(path: P) -> Option<PathBuf>
```

**Purpose**: Shortens an absolute path that lives inside the user’s home directory by returning only the part after the home directory. This helps the interface show friendlier paths.

**Data flow**: It receives something path-like. If the path is not absolute, it returns nothing because there is no home-directory prefix to remove safely. If it is absolute, it looks up the user’s home directory and checks whether the path starts with it. When it does, it returns the remaining relative path as a `PathBuf`; otherwise it returns nothing.

**Call relations**: Display helpers such as `display_path_for` and `format_directory_display` call this when they want compact path text. It depends on the operating system’s home-directory lookup and on path prefix checking. If the path is exactly the home directory, the remaining path is empty, which is intentional.

*Call graph*: called by 2 (display_path_for, format_directory_display); 4 external calls (as_ref, is_absolute, strip_prefix, home_dir).


##### `tests::test_escape_command`  (lines 58–62)

```
fn test_escape_command()
```

**Purpose**: Checks that `escape_command` produces a safe, readable command line when arguments contain spaces or shell-special characters.

**Data flow**: It builds a small list of arguments: one plain word, one argument with a space, and one with an ampersand. It sends that list into `escape_command`, then compares the returned string with the expected quoted command line.

**Call relations**: This test is run by the Rust test harness. It directly exercises `escape_command`, protecting the behavior that other display code relies on when showing command arguments.

*Call graph*: calls 1 internal fn (escape_command); 2 external calls (assert_eq!, vec!).


##### `tests::test_strip_bash_lc_and_escape`  (lines 65–85)

```
fn test_strip_bash_lc_and_escape()
```

**Purpose**: Checks that shell wrappers are removed from the displayed command for bash and zsh. It covers both plain shell names and absolute paths to those shells.

**Data flow**: It creates several command-argument lists that all mean: run `echo hello` through a shell using `-lc`. Each list is passed to `strip_bash_lc_and_escape`, and the test confirms that the output is just `echo hello` every time.

**Call relations**: This test is run by the Rust test harness. It directly protects `strip_bash_lc_and_escape`, which is later used by header, command-display, and transcript-building code to show users the command they actually care about.

*Call graph*: calls 1 internal fn (strip_bash_lc_and_escape); 2 external calls (assert_eq!, vec!).


##### `tests::split_command_string_round_trips_shell_wrappers`  (lines 88–100)

```
fn split_command_string_round_trips_shell_wrappers()
```

**Purpose**: Checks that a normal shell-wrapper command can be safely split into its original arguments. This protects commands where nested quotes appear inside the shell script.

**Data flow**: It first uses the shell-joining library to build a command string from three intended arguments. It then checks that the splitting behavior produces those same three pieces, including the Python snippet with its inner quotes intact.

**Call relations**: This test is run by the Rust test harness. It uses the same joining style as the production code, then verifies the safe round-trip case that `split_command_string` is designed to allow.

*Call graph*: 2 external calls (assert_eq!, try_join).


##### `tests::split_command_string_preserves_non_roundtrippable_windows_commands`  (lines 103–106)

```
fn split_command_string_preserves_non_roundtrippable_windows_commands()
```

**Purpose**: Checks that a Windows-style command path is not split when splitting could change its meaning. This guards against damaging commands with drive-letter paths and spaces.

**Data flow**: It starts with one command string containing a Windows path like `C:\Program Files\...` and shell arguments after it. The expected result is a one-item list containing the original string unchanged.

**Call relations**: This test is run by the Rust test harness. It protects the cautious behavior in command parsing: when a command does not round-trip safely, the code should leave it alone rather than guess.

*Call graph*: 1 external calls (assert_eq!).


### Git operations and repository inspection
This group builds from the git-utils public surface through safe low-level git invocation into fsmonitor policy, branch logic, repository metadata collection, and user-facing diff generation.

### `git-utils/src/lib.rs`

`orchestration` · `cross-cutting library API`

This file does not contain the Git logic itself. Instead, it acts like a reception desk for the library: the real work is split into focused modules such as applying patches, reading repository information, finding branches, checking baselines, and dealing with platform-specific filesystem behavior. This file declares those modules and then re-exports selected types and functions so callers can import them from one simple place.

That matters because code outside this library should not need to know which internal file contains, for example, patch application, remote URL lookup, or repository root detection. Without this file, every caller would have to reach into the library’s internal layout, making the project harder to change safely. By exposing a clean public surface here, the library can reorganize its internals while keeping the same outside interface.

The exported items cover several common Git tasks: applying and parsing patches, staging files, comparing against a baseline, finding merge bases, collecting repository metadata, checking whether there are local changes, resolving trusted project roots, and creating symlinks in a platform-aware way. It also re-exports the shared Git commit hash type and the library’s error type, so callers can speak the same language when receiving results or failures.


### `git-utils/src/operations.rs`

`io_transport` · `cross-cutting`

This file exists so the rest of the project does not have to run raw `git` commands by hand. Instead, other code can ask clear questions and get clear Rust results back. For example, checking whether a folder is inside a Git working tree becomes a function call, not a scattered shell command.

The file works like a careful receptionist for Git. Higher-level functions prepare a specific Git request, such as `rev-parse --show-toplevel`. They pass that request to a shared runner, which starts the real `git` program in a chosen directory, optionally adds environment variables, collects the output, and reports any failure in a structured way.

One important detail is that every internal Git command disables Git hooks by setting `core.hooksPath` to a harmless location. Git hooks are user-configured scripts that can run during some Git actions. Disabling them here keeps these helper commands predictable and avoids accidentally running user scripts.

The file also separates two common needs: commands where only success or failure matters, and commands where the text printed by Git matters. If Git prints text, the wrapper also checks that the output is valid UTF-8 text before returning it.

#### Function details

##### `ensure_git_repository`  (lines 11–31)

```
fn ensure_git_repository(path: &Path) -> Result<(), GitToolingError>
```

**Purpose**: Checks whether a given folder is inside a Git working tree. Code uses this before doing Git-based work so it can fail early with a friendly “not a Git repository” error instead of producing confusing later errors.

**Data flow**: It receives a filesystem path. It runs `git rev-parse --is-inside-work-tree` in that path and reads Git’s printed answer. If Git says `true`, it returns success. If Git says something else, or Git exits with the common “not a repository” status, it returns a `NotAGitRepository` error containing the path. Other Git failures are passed through unchanged.

**Call relations**: This is called by `merge_base_with_head` before that higher-level flow tries to compare commits. It relies on `run_git_for_stdout` to do the actual Git call and interpret the command output as text.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 2 external calls (to_path_buf, vec!).


##### `resolve_head`  (lines 33–47)

```
fn resolve_head(path: &Path) -> Result<Option<String>, GitToolingError>
```

**Purpose**: Finds the commit ID currently named by `HEAD`, if one exists. `HEAD` is Git’s pointer to the currently checked-out commit or branch tip.

**Data flow**: It receives a path and runs `git rev-parse --verify HEAD` there. If Git returns a commit hash, the function returns it as `Some(text)`. If Git reports the usual error for “there is no HEAD yet,” such as in a brand-new repository with no commits, it returns `None`. Other command errors are returned as failures.

**Call relations**: This is used by `merge_base_with_head` when that flow needs to know the current commit before finding a merge base. It delegates command execution and text decoding to `run_git_for_stdout`.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 1 external calls (vec!).


##### `resolve_repository_root`  (lines 49–59)

```
fn resolve_repository_root(path: &Path) -> Result<PathBuf, GitToolingError>
```

**Purpose**: Finds the top-level folder of the Git repository that contains a given path. This is useful because commands may start in a subfolder, but many Git operations need the repository’s main directory.

**Data flow**: It receives a path, runs `git rev-parse --show-toplevel`, takes Git’s printed path, and turns it into a `PathBuf`, which is Rust’s owned filesystem path type. On success it returns that root path. If Git fails, the error is returned.

**Call relations**: This is called by `merge_base_with_head` as part of setting up repository-aware work. It uses `run_git_for_stdout` to ask Git for the root directory.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 2 external calls (from, vec!).


##### `run_git_for_status`  (lines 61–72)

```
fn run_git_for_status(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<(), GitToolingError>
```

**Purpose**: Runs a Git command when the caller only cares whether it succeeded, not what it printed. This is useful for commands whose effect is the important part.

**Data flow**: It receives a working directory, a list of Git arguments, and optional environment variables. It passes all of that to `run_git`. If the command succeeds, it discards the captured output and returns success. If the command fails, it returns the error from the shared runner.

**Call relations**: This is called by `write_index_from_head`, where the larger task needs a Git command to complete successfully. It is a thin convenience layer over `run_git`.

*Call graph*: calls 1 internal fn (run_git); called by 1 (write_index_from_head).


##### `run_git_for_stdout`  (lines 74–90)

```
fn run_git_for_stdout(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<String, GitToolingError>
```

**Purpose**: Runs a Git command and returns the text that Git printed to standard output. Callers use this for Git questions where the answer is printed text, such as a commit hash or repository path.

**Data flow**: It receives a working directory, Git arguments, and optional environment variables. It asks `run_git` to execute the command. Then it reads the command’s standard output, checks that it is valid UTF-8 text, trims surrounding whitespace, and returns it as a `String`. If the bytes are not valid text, it returns a `GitOutputUtf8` error that includes the command for easier diagnosis.

**Call relations**: Many higher-level Git helpers depend on this function, including `ensure_git_repository`, `resolve_head`, `resolve_repository_root`, `merge_base_with_head`, `resolve_branch_ref`, and `resolve_upstream_if_remote_ahead`. It is the shared “ask Git and read the answer” path, built on top of `run_git`.

*Call graph*: calls 1 internal fn (run_git); called by 6 (merge_base_with_head, resolve_branch_ref, resolve_upstream_if_remote_ahead, ensure_git_repository, resolve_head, resolve_repository_root); 1 external calls (from_utf8).


##### `run_git`  (lines 92–134)

```
fn run_git(
    dir: &Path,
    args: I,
    env: Option<&[(OsString, OsString)]>,
) -> Result<GitRun, GitToolingError>
```

**Purpose**: Runs the actual `git` program and captures its result. This is the central low-level function that all the other helpers use instead of launching Git themselves.

**Data flow**: It receives a directory, Git arguments, and optional environment variables. Before running Git, it adds a configuration option that disables Git hooks, then builds a readable command string for error messages. It starts `git` in the requested directory, applies any environment variables, waits for it to finish, and captures its output. If Git exits successfully, it returns a `GitRun` containing the command string and raw process output. If Git fails, it reads Git’s error text and returns a structured `GitCommand` error.

**Call relations**: This function sits underneath both `run_git_for_status` and `run_git_for_stdout`. It calls `build_command_string` so that any later error can say exactly which Git command was attempted.

*Call graph*: calls 1 internal fn (build_command_string); called by 2 (run_git_for_status, run_git_for_stdout); 6 external calls (into_iter, from, from_utf8_lossy, with_capacity, new, format!).


##### `build_command_string`  (lines 136–146)

```
fn build_command_string(args: &[OsString]) -> String
```

**Purpose**: Creates a human-readable version of the Git command for error messages. This helps people understand what the program tried to run when something goes wrong.

**Data flow**: It receives the list of Git arguments that will be passed to the `git` program. If the list is empty, it returns `git`. Otherwise, it converts each argument into displayable text, joins them with spaces, and prefixes the result with `git`.

**Call relations**: This is called by `run_git` before launching the command. The resulting string is carried into success records and error reports so higher layers can explain failures clearly.

*Call graph*: called by 1 (run_git); 3 external calls (is_empty, iter, format!).


### `git-utils/src/fsmonitor.rs`

`domain_logic` · `before internal Git commands`

Git has a setting called `core.fsmonitor`, which can speed up status checks by telling Git what files changed instead of making it scan everything. But that setting can also point to an executable helper chosen by the repository. Codex does not want repository configuration to make it run arbitrary helper programs, so it overrides the setting for its own Git commands.

This file contains the policy for that override. The safe default is to disable filesystem monitoring. The only exception is Git's own built-in filesystem monitor daemon, which is not a repository-selected executable helper. Keeping that daemon can matter for large repositories because it avoids slow full-directory scans.

The main check, `detect_fsmonitor_override`, asks Git what the effective `core.fsmonitor` value is, carefully treats malformed or surprising answers as unsafe, and only continues if the value really means boolean true. It then asks Git whether this build advertises support for `fsmonitor--daemon`. Only if both checks pass does it allow `core.fsmonitor=true`; otherwise it returns `core.fsmonitor=false`.

A small trait, `FsmonitorProbeRunner`, lets the detection code ask Git questions without knowing exactly how Git commands are launched. That keeps this file focused on the safety decision rather than process-running details.

#### Function details

##### `FsmonitorOverride::git_config_arg`  (lines 24–29)

```
fn git_config_arg(self) -> &'static str
```

**Purpose**: This turns the chosen filesystem monitor policy into the exact Git configuration override string that can be passed to a Git command. Callers use it when preparing Git so the repository's own `core.fsmonitor` setting cannot choose an unsafe helper.

**Data flow**: It starts with an `FsmonitorOverride` value: either `Disabled` or `BuiltIn`. It converts that choice into plain text Git understands: `core.fsmonitor=false` for disabled, or `core.fsmonitor=true` for the built-in daemon. It does not change anything itself; it just returns the string for another part of the system to use.

**Call relations**: After some other code has decided which policy is safe, Git command builders call this function while assembling the arguments for Git. It is used by `run_git_command_with_timeout_from`, `run_git_command`, and `git_command` so all internal Git invocations get a consistent safe override.

*Call graph*: called by 3 (run_git_command_with_timeout_from, run_git_command, git_command).


##### `detect_fsmonitor_override`  (lines 49–125)

```
async fn detect_fsmonitor_override(
    runner: &mut impl FsmonitorProbeRunner,
) -> FsmonitorOverride
```

**Purpose**: This checks whether it is safe to preserve Git's built-in filesystem monitor for the target repository. If anything is missing, malformed, unsupported, or looks like a repository-selected helper, it chooses the safe fallback: disable filesystem monitoring.

**Data flow**: It receives a probe runner, which is an object able to run small Git commands and return their successful output. First it asks Git for the raw effective `core.fsmonitor` value. It rejects failed probes, missing null terminators, embedded null bytes, and non-UTF-8 text. Then it decides whether the value means boolean true, using simple known spellings first and asking Git to normalize less common boolean forms when needed. If the setting is not true, it returns `Disabled`. If it is true, it asks `git version --build-options` whether this Git build has the `fsmonitor--daemon` feature. If that feature line is present, it returns `BuiltIn`; otherwise it returns `Disabled`.

**Call relations**: This function is the safety gate before Codex decides what `core.fsmonitor` override to pass into later Git commands. It delegates all actual Git probing to the runner's `run_probe` method, uses UTF-8 conversion to safely read Git's text response, and checks the boolean probe result with `matches!`. Its result is later turned into a concrete Git config argument by `FsmonitorOverride::git_config_arg`.

*Call graph*: 3 external calls (run_probe, matches!, from_utf8).


### `git-utils/src/branch.rs`

`domain_logic` · `called when code needs to compare the current checkout with another Git branch; tests run during the test suite`

This file answers a practical Git question: “Where did my current work and that branch last share the same history?” Git calls that shared point the “merge base.” Tools use it to compare changes, decide what is new, or understand how two lines of work relate.

The main public function, `merge_base_with_head`, first checks that the path is really inside a Git repository. It then finds the repository’s root folder and resolves `HEAD`, which means the commit currently checked out. If the repository has no commits yet, there is no useful answer, so it returns `None` instead of failing.

Next it tries to resolve the requested branch name into a real commit. If the branch does not exist, it also returns `None`. One important detail is that it may prefer the branch’s upstream remote version, such as `origin/main`, when that remote branch is ahead of the local branch. This matters because a local branch can be stale; using only it could compare against yesterday’s state instead of the latest fetched state.

After choosing the best branch reference, the file asks Git to run `merge-base HEAD <branch>`. Most of the real Git knowledge stays in the Git command-line tool; this Rust code adds safety, friendly missing-case behavior, and project-specific error handling around it. The test code builds temporary repositories to prove the normal, remote-ahead, and missing-branch cases.

#### Function details

##### `merge_base_with_head`  (lines 15–48)

```
fn merge_base_with_head(
    repo_path: &Path,
    branch: &str,
) -> Result<Option<String>, GitToolingError>
```

**Purpose**: Finds the shared ancestor commit between the repository’s current `HEAD` commit and a named branch. It returns `None` for ordinary “not available” situations, such as an empty repository or a branch that cannot be found, instead of treating them as hard failures.

**Data flow**: It receives a repository path and a branch name. It verifies the path is in a Git repository, finds the repository root, resolves the current `HEAD`, resolves the branch, optionally replaces the local branch with its upstream remote branch if the remote is ahead, then runs Git’s `merge-base` command. The result is either the commit hash as `Some(text)`, `None` when there is no sensible merge base to ask for, or an error if the underlying Git work truly fails.

**Call relations**: This is the main function the rest of the file is built around. It calls `resolve_branch_ref` to turn a branch name into a commit, `resolve_upstream_if_remote_ahead` to decide whether a remote branch is more current, and shared repository helpers to validate and locate the Git repo. The three tests call it in different repository setups to check that it returns the expected shared commit or `None`.

*Call graph*: calls 6 internal fn (resolve_branch_ref, resolve_upstream_if_remote_ahead, ensure_git_repository, resolve_head, resolve_repository_root, run_git_for_stdout); called by 3 (merge_base_prefers_upstream_when_remote_ahead, merge_base_returns_none_when_branch_missing, merge_base_returns_shared_commit); 1 external calls (vec!).


##### `resolve_branch_ref`  (lines 50–66)

```
fn resolve_branch_ref(repo_root: &Path, branch: &str) -> Result<Option<String>, GitToolingError>
```

**Purpose**: Checks whether a branch-like name can be resolved by Git and, if so, returns the exact commit it points to. It treats “Git could not verify this name” as a normal missing-branch case.

**Data flow**: It receives the repository root and a branch name. It runs `git rev-parse --verify <branch>` to ask Git for the exact commit reference. If Git succeeds, it returns that text inside `Some`; if Git reports a command failure, it returns `None`; if something else goes wrong, it passes the error upward.

**Call relations**: `merge_base_with_head` uses this helper before attempting a merge-base calculation, because the main flow needs to know whether the target branch exists. It is also used again when an upstream branch is preferred, to turn that upstream name into a concrete commit reference.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 1 external calls (vec!).


##### `resolve_upstream_if_remote_ahead`  (lines 68–117)

```
fn resolve_upstream_if_remote_ahead(
    repo_root: &Path,
    branch: &str,
) -> Result<Option<String>, GitToolingError>
```

**Purpose**: Looks for the branch’s upstream remote branch and decides whether that remote branch has commits the local branch does not have. If the remote is ahead, it returns the remote branch name so the caller can compare against fresher history.

**Data flow**: It receives the repository root and a branch name. First it asks Git for the branch’s upstream name, such as `origin/main`; if there is no upstream, it returns `None`. Then it asks Git to count commits that are only on the local side and only on the upstream side. If the upstream-only count is greater than zero, it returns `Some(upstream_name)`; otherwise it returns `None`. Git command failures that simply mean “not available” are treated as `None`, while other errors are returned.

**Call relations**: `merge_base_with_head` calls this after resolving the local branch. This helper acts like a freshness check: it tells the main function when to use the remote-tracking branch instead of the local branch before running the final merge-base command.

*Call graph*: calls 1 internal fn (run_git_for_stdout); called by 1 (merge_base_with_head); 1 external calls (vec!).


##### `tests::run_git_in`  (lines 128–135)

```
fn run_git_in(repo_path: &Path, args: &[&str])
```

**Purpose**: Runs a Git command inside a test repository and fails the test immediately if the command does not succeed. It is a small test helper that keeps the test cases readable.

**Data flow**: It receives a repository path and a list of Git arguments. It starts the `git` program in that folder with those arguments, waits for it to finish, and checks the exit status. Nothing is returned; the test continues only if Git reports success.

**Call relations**: The test setup and test scenarios use this helper whenever they need to create branches, add files, commit changes, push, fetch, or otherwise shape a temporary Git repository. It is called by `tests::init_test_repo`, `tests::commit`, and the individual test functions.

*Call graph*: 2 external calls (assert!, new).


##### `tests::run_git_stdout`  (lines 137–145)

```
fn run_git_stdout(repo_path: &Path, args: &[&str]) -> String
```

**Purpose**: Runs a Git command in a test repository and returns its printed output as plain text. The tests use it to ask Git directly for the expected answer.

**Data flow**: It receives a repository path and Git arguments. It runs Git, checks that the command succeeded, reads standard output, converts it from bytes into text, trims extra whitespace, and returns the resulting string.

**Call relations**: The merge-base tests call this helper to compute the expected merge-base using Git itself. They then compare that expected value with what `merge_base_with_head` returns.

*Call graph*: 3 external calls (from_utf8_lossy, assert!, new).


##### `tests::init_test_repo`  (lines 147–150)

```
fn init_test_repo(repo_path: &Path)
```

**Purpose**: Creates a clean test Git repository with a predictable initial branch and line-ending behavior. This avoids repeated setup code in the tests.

**Data flow**: It receives a path to an empty temporary folder. It runs `git init --initial-branch=main`, then configures Git not to automatically rewrite line endings. It does not return a value; it changes the folder into a ready-to-use test repository.

**Call relations**: The simpler tests call this helper before creating files and commits. It delegates the actual Git commands to `tests::run_git_in`.

*Call graph*: 1 external calls (run_git_in).


##### `tests::commit`  (lines 152–165)

```
fn commit(repo_path: &Path, message: &str)
```

**Purpose**: Creates a Git commit in a test repository using fixed test author details. This lets tests make commits without relying on the developer’s global Git configuration.

**Data flow**: It receives a repository path and a commit message. It runs `git commit` with temporary `user.name` and `user.email` settings and the given message. It does not return a value; it changes the repository by adding a new commit from whatever is staged.

**Call relations**: The test cases call this after writing and staging files. It uses `tests::run_git_in` to execute the actual Git command.

*Call graph*: 1 external calls (run_git_in).


##### `tests::merge_base_returns_shared_commit`  (lines 168–194)

```
fn merge_base_returns_shared_commit() -> Result<(), GitToolingError>
```

**Purpose**: Tests the normal case where two branches split from a shared commit. It proves that `merge_base_with_head` returns the same common ancestor that Git’s own `merge-base` command reports.

**Data flow**: It creates a temporary repository, makes a base commit, creates a feature branch with its own commit, adds a separate commit on `main`, then checks out `feature`. It asks Git directly for the merge base between `HEAD` and `main`, calls `merge_base_with_head`, and asserts that both answers match.

**Call relations**: This test exercises the main public function in the everyday local-branch case. It uses the test helpers to create the repository story, then calls `merge_base_with_head` as a real caller would.

*Call graph*: calls 1 internal fn (merge_base_with_head); 7 external calls (assert_eq!, commit, init_test_repo, run_git_in, run_git_stdout, write, tempdir).


##### `tests::merge_base_prefers_upstream_when_remote_ahead`  (lines 197–239)

```
fn merge_base_prefers_upstream_when_remote_ahead() -> Result<(), GitToolingError>
```

**Purpose**: Tests the important edge case where the remote branch has moved ahead of the local branch. It proves the code compares against the upstream remote branch when that is the fresher reference.

**Data flow**: It creates both a local repository and a bare remote repository, pushes `main`, creates a feature branch, then rewrites local `main` in a way that makes the fetched remote `origin/main` the meaningful comparison target. After fetching, it asks Git for the merge base with `origin/main`, calls `merge_base_with_head` with `main`, and checks that the function chose the same result.

**Call relations**: This test specifically drives the path through `resolve_upstream_if_remote_ahead`. It confirms that `merge_base_with_head` does not blindly use a stale or misleading local branch when the upstream remote branch is ahead.

*Call graph*: calls 1 internal fn (merge_base_with_head); 7 external calls (assert_eq!, commit, run_git_in, run_git_stdout, create_dir_all, write, tempdir).


##### `tests::merge_base_returns_none_when_branch_missing`  (lines 242–255)

```
fn merge_base_returns_none_when_branch_missing() -> Result<(), GitToolingError>
```

**Purpose**: Tests that asking for a branch that does not exist is treated as a harmless “no answer” case. This prevents callers from having to treat a missing branch as a crash-worthy error.

**Data flow**: It creates a temporary repository with one commit, then calls `merge_base_with_head` using a branch name that was never created. The expected output is `None`, and the test asserts exactly that.

**Call relations**: This test exercises the path where `resolve_branch_ref` cannot verify the branch. It shows how the helper’s missing-branch result flows back through `merge_base_with_head` to the caller.

*Call graph*: calls 1 internal fn (merge_base_with_head); 6 external calls (assert_eq!, commit, init_test_repo, run_git_in, write, tempdir).


### `git-utils/src/info.rs`

`domain_logic` · `cross-cutting`

This file lets Codex understand the Git project it is working in. Git is the version-control tool that tracks changes to source code. Without this file, other parts of the system would have to guess whether a folder is a repository, what commit it is on, which remote server it came from, or what files differ from the shared branch.

It uses two approaches. For simple “is this inside a repo?” checks, it walks up the folder tree looking for a `.git` entry, like checking each parent folder for the project’s front desk. For richer information, it runs the `git` command-line program with a short timeout so a very large or broken repository cannot freeze the app.

It also normalizes remote URLs, so different spellings like `git@github.com:OpenAI/Codex.git` and `https://github.com/openai/codex.git` can be treated as the same repository. For change detection and diffs, it is careful to disable repository hooks and unsafe filesystem-monitor helpers, so project-local Git settings cannot unexpectedly run extra programs. The file includes helpers for default branches, recent commits, current branch names, worktree trust checks, and tests for URL normalization and filesystem-monitor safety.

#### Function details

##### `get_git_repo_root`  (lines 33–40)

```
fn get_git_repo_root(base_dir: &Path) -> Option<PathBuf>
```

**Purpose**: Finds the nearest Git repository root for a local path. Someone uses this when they need to know whether a file or folder belongs to a Git project and where that project starts.

**Data flow**: It receives a path. If the path is a directory, it starts there; otherwise it starts at the parent folder. It then walks upward until it finds a `.git` file or folder, and returns the folder that contained it, or returns nothing if none is found.

**Call relations**: This is the local filesystem version of repository discovery. `git_diff_to_remote` calls it first so it can stop early when there is no Git repository to compare against, and it relies on `find_ancestor_git_entry` to do the actual upward search.

*Call graph*: calls 1 internal fn (find_ancestor_git_entry); called by 1 (git_diff_to_remote); 2 external calls (is_dir, parent).


##### `get_git_repo_root_with_fs`  (lines 46–58)

```
async fn get_git_repo_root_with_fs(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the Git repository root using an abstract filesystem rather than direct local disk access. This matters when the working folder may live in a remote or sandboxed environment.

**Data flow**: It receives a filesystem object and an absolute current directory. It asks the filesystem whether that path is a directory, chooses that path or its parent as the starting point, then searches ancestors for `.git`. It returns the repository root as an absolute path, or nothing if none is found.

**Call relations**: `resolve_root_git_project_for_trust` uses this as its first step before deciding which repository root should be trusted. It delegates the ancestor search to `find_ancestor_git_entry_with_fs`, which uses the same filesystem abstraction.

*Call graph*: calls 3 internal fn (find_ancestor_git_entry_with_fs, parent, from_abs_path); called by 1 (resolve_root_git_project_for_trust); 2 external calls (get_metadata, clone).


##### `collect_git_info`  (lines 87–139)

```
async fn collect_git_info(cwd: &Path) -> Option<GitInfo>
```

**Purpose**: Collects a small summary of the current Git repository: commit hash, branch name, and origin URL. It is useful for reporting “what code are we looking at?” without needing a full Git scan.

**Data flow**: It receives a working directory. It first checks that Git recognizes the folder as a repository. If so, it runs three Git commands in parallel to get the current commit, current branch, and origin remote URL. It converts successful command output into a `GitInfo` value, leaving fields empty when a particular query fails.

**Call relations**: This is a public collection helper for outside callers. It depends on `run_git_command_with_timeout` for every Git call, so all requests are bounded by the shared timeout and safety settings.

*Call graph*: calls 2 internal fn (run_git_command_with_timeout, new); 2 external calls (from_utf8, join!).


##### `get_git_remote_urls`  (lines 142–152)

```
async fn get_git_remote_urls(cwd: &Path) -> Option<BTreeMap<String, String>>
```

**Purpose**: Returns the repository’s fetch remote URLs, such as `origin` mapped to its server URL. It first confirms that the directory is actually inside a Git repository.

**Data flow**: It receives a working directory. It runs a quick Git repository check, and if that succeeds it asks `get_git_remote_urls_assume_git_repo` to read and parse the remotes. It returns a sorted map of remote names to URLs, or nothing if the folder is not a repo or Git fails.

**Call relations**: This is the safer public wrapper around `get_git_remote_urls_assume_git_repo`. It uses `run_git_command_with_timeout` for the initial check so callers do not have to perform that check themselves.

*Call graph*: calls 2 internal fn (get_git_remote_urls_assume_git_repo, run_git_command_with_timeout).


##### `get_git_remote_urls_assume_git_repo`  (lines 155–163)

```
async fn get_git_remote_urls_assume_git_repo(cwd: &Path) -> Option<BTreeMap<String, String>>
```

**Purpose**: Reads fetch remote URLs when the caller already knows the folder is a Git repository. It avoids repeating the repository check.

**Data flow**: It receives a working directory, runs `git remote -v`, turns the command output into text, and passes that text to `parse_git_remote_urls`. The result is a map of remote names to URLs, or nothing if Git fails or the output cannot be read.

**Call relations**: `get_git_remote_urls` calls this after confirming the repository exists. It hands raw Git output to `parse_git_remote_urls`, which understands the text layout.

*Call graph*: calls 2 internal fn (parse_git_remote_urls, run_git_command_with_timeout); called by 1 (get_git_remote_urls); 1 external calls (from_utf8).


##### `get_head_commit_hash`  (lines 166–179)

```
async fn get_head_commit_hash(cwd: &Path) -> Option<GitSha>
```

**Purpose**: Gets the commit hash currently checked out at `HEAD`, which is Git’s name for the current position. This is a quick way to identify the exact code version.

**Data flow**: It receives a working directory, runs `git rev-parse HEAD`, reads the output as text, trims whitespace, and wraps the hash in a `GitSha` value. If the command fails or the output is empty, it returns nothing.

**Call relations**: This is a public helper for callers that only need the current commit. Like most Git command helpers in this file, it goes through `run_git_command_with_timeout` to avoid hanging.

*Call graph*: calls 2 internal fn (run_git_command_with_timeout, new); 1 external calls (from_utf8).


##### `canonicalize_git_remote_url`  (lines 181–197)

```
fn canonicalize_git_remote_url(url: &str) -> Option<String>
```

**Purpose**: Turns many common Git remote URL formats into one consistent repository identity. This helps the system recognize that different URL spellings can point to the same project.

**Data flow**: It receives a URL-like string, trims spaces, removes a trailing slash and `.git`, then decides whether it looks like a normal URL, an SSH scp-style remote, or a host/path value. It returns a normalized `host/owner/repo` style string, or nothing if the input does not look like a repository remote.

**Call relations**: This is the public entry point for URL cleanup. It chooses between `canonicalize_git_url_like_remote`, `parse_scp_like_remote`, and `canonicalize_git_remote_host_path` depending on the shape of the input.

*Call graph*: calls 4 internal fn (canonicalize_git_remote_host_path, canonicalize_git_url_like_remote, parse_scp_like_remote, trim_git_suffix).


##### `canonicalize_git_url_like_remote`  (lines 199–213)

```
fn canonicalize_git_url_like_remote(scheme: &str, rest: &str) -> Option<String>
```

**Purpose**: Normalizes remotes that look like full URLs, such as `https://...` or `ssh://...`. It also knows the default ports for common Git URL schemes.

**Data flow**: It receives a URL scheme and the remaining text after `://`. It rejects unknown schemes, removes query strings or fragments, splits the host from the path, and passes those parts plus the scheme’s default port to the shared host/path normalizer.

**Call relations**: `canonicalize_git_remote_url` calls this when it sees a full URL. It hands the final cleanup to `canonicalize_git_remote_host_path` so all URL styles end up in the same format.

*Call graph*: calls 1 internal fn (canonicalize_git_remote_host_path); called by 1 (canonicalize_git_remote_url).


##### `parse_scp_like_remote`  (lines 215–229)

```
fn parse_scp_like_remote(remote: &str) -> Option<(&str, &str)>
```

**Purpose**: Recognizes Git’s SSH shorthand, such as `git@github.com:owner/repo.git`. This format looks like a shell copy command target rather than a web URL.

**Data flow**: It receives a remote string. It rejects strings where a slash appears before the colon, because those are more likely normal paths. Otherwise it splits at the colon and returns the host part and repository path if both are present.

**Call relations**: `canonicalize_git_remote_url` calls this after ruling out full URLs. If it succeeds, the caller sends the returned host and path into `canonicalize_git_remote_host_path`.

*Call graph*: called by 1 (canonicalize_git_remote_url).


##### `canonicalize_git_remote_host_path`  (lines 231–266)

```
fn canonicalize_git_remote_host_path(
    host_part: &str,
    path: &str,
    default_port: Option<&str>,
) -> Option<String>
```

**Purpose**: Builds the final normalized repository identity from a host and path. It strips user names, default ports, extra slashes, and `.git` suffixes.

**Data flow**: It receives a host part, a repository path, and an optional default port. It normalizes the host, splits the path into pieces, requires at least an owner and repository name, rejects `.` and `..` as unsafe path pieces, and returns `host/path`. GitHub paths are lowercased because GitHub repository names are effectively case-insensitive.

**Call relations**: This is the shared final step for `canonicalize_git_remote_url` and `canonicalize_git_url_like_remote`. It uses `normalize_remote_host` and `trim_git_suffix` for the smaller cleanup steps.

*Call graph*: calls 2 internal fn (normalize_remote_host, trim_git_suffix); called by 2 (canonicalize_git_remote_url, canonicalize_git_url_like_remote); 2 external calls (format!, matches!).


##### `normalize_remote_host`  (lines 268–277)

```
fn normalize_remote_host(host: &str, default_port: Option<&str>) -> String
```

**Purpose**: Cleans up a remote host name so equivalent hosts compare the same. It lowercases the host and removes a port when it is just the scheme’s default port.

**Data flow**: It receives a host string and maybe a default port. It lowercases the host, checks whether it ends with that default port, and returns the host without the port when appropriate. Otherwise it returns the lowercased host unchanged.

**Call relations**: `canonicalize_git_remote_host_path` calls this while building the canonical remote identity. It is a focused helper used only for that normalization path.

*Call graph*: called by 1 (canonicalize_git_remote_host_path).


##### `trim_git_suffix`  (lines 279–281)

```
fn trim_git_suffix(value: &str) -> &str
```

**Purpose**: Removes a trailing `.git` from a string when present. This makes repository names compare the same whether the remote URL includes that common suffix or not.

**Data flow**: It receives a string slice. If the string ends in `.git`, it returns the string without that suffix; otherwise it returns the original string.

**Call relations**: `canonicalize_git_remote_url` uses it early on the whole URL, and `canonicalize_git_remote_host_path` uses it again on the path portion. It is deliberately tiny because this cleanup is needed in more than one place.

*Call graph*: called by 2 (canonicalize_git_remote_host_path, canonicalize_git_remote_url).


##### `get_has_changes`  (lines 283–293)

```
async fn get_has_changes(cwd: &Path) -> Option<bool>
```

**Purpose**: Checks whether the working tree has uncommitted changes. In plain terms, it answers “is there anything different from what Git has recorded?”

**Data flow**: It receives a working directory. It first detects whether Git filesystem monitoring should be overridden for safety, then runs `git status --porcelain`, a machine-readable status command. If Git succeeds, it returns true when the output is non-empty and false when it is empty.

**Call relations**: Outside callers use this when they need a quick dirty-or-clean answer. It calls `detect_local_fsmonitor_override` before using `run_git_command_with_timeout_from`, because status touches the worktree and may be affected by configured filesystem-monitor helpers.

*Call graph*: calls 2 internal fn (detect_local_fsmonitor_override, run_git_command_with_timeout_from); 1 external calls (new).


##### `parse_git_remote_urls`  (lines 295–320)

```
fn parse_git_remote_urls(stdout: &str) -> Option<BTreeMap<String, String>>
```

**Purpose**: Parses the text from `git remote -v` into a map of fetch remote names and URLs. It ignores push-only lines.

**Data flow**: It receives the raw command output as text. For each line ending in ` (fetch)`, it splits out the remote name and URL, trims the URL, and stores it. It returns the map when at least one fetch remote was found, or nothing otherwise.

**Call relations**: `get_git_remote_urls_assume_git_repo` calls this after running Git. Keeping parsing separate makes the command runner and text interpretation easier to reason about.

*Call graph*: called by 1 (get_git_remote_urls_assume_git_repo); 1 external calls (new).


##### `recent_commits`  (lines 335–379)

```
async fn recent_commits(cwd: &Path, limit: usize) -> Vec<CommitLogEntry>
```

**Purpose**: Returns a simple list of recent commits for display in pickers or history views. Each entry includes the commit hash, timestamp, and one-line message.

**Data flow**: It receives a working directory and a limit. It first verifies the folder is a Git repository, then runs `git log` with a custom separator between fields. It reads each output line, splits it into hash, timestamp, and subject, and returns a vector of commit entries. Errors produce an empty list.

**Call relations**: This public helper relies on `run_git_command_with_timeout` for both the repository check and the log query. It does not call deeper branch or diff logic because it only needs a linear recent-history view.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout); 4 external calls (from_utf8_lossy, new, format!, vec!).


##### `git_diff_to_remote`  (lines 382–394)

```
async fn git_diff_to_remote(cwd: &Path) -> Option<GitDiffToRemote>
```

**Purpose**: Finds the closest remote-backed commit related to the current work and returns the diff from that commit. This gives a useful “what changed compared with shared code?” view.

**Data flow**: It receives a working directory. It confirms a Git repository exists, gathers remotes, builds a list of relevant branch names, chooses the closest remote commit, then asks for the diff against that commit. It returns both the base SHA and the diff text, or nothing if any required step fails.

**Call relations**: This is an orchestration point inside the Git info toolbox. It calls `get_git_repo_root`, `get_git_remotes`, `branch_ancestry`, `find_closest_sha`, and `diff_against_sha` in sequence, with each helper answering one part of the comparison question.

*Call graph*: calls 5 internal fn (branch_ancestry, diff_against_sha, find_closest_sha, get_git_remotes, get_git_repo_root).


##### `run_git_command_with_timeout`  (lines 397–407)

```
async fn run_git_command_with_timeout(args: &[&str], cwd: &Path) -> Option<std::process::Output>
```

**Purpose**: Runs a normal `git` command with the file’s standard timeout and safety defaults. It is the common wrapper used by most metadata queries.

**Data flow**: It receives Git arguments and a working directory. It calls the lower-level runner using the `git` executable name and disables custom filesystem monitoring. It returns the process output when the command starts and finishes in time, or nothing on timeout or launch error.

**Call relations**: Many higher-level helpers call this whenever they need Git metadata, including branch, remote, commit, and log queries. It delegates the actual process setup to `run_git_command_with_timeout_from`.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout_from); called by 12 (branch_ancestry, branch_remote_and_distance, collect_git_info, current_branch_name, get_default_branch, get_default_branch_local, get_git_remote_urls, get_git_remote_urls_assume_git_repo, get_git_remotes, get_head_commit_hash (+2 more)); 1 external calls (new).


##### `LocalFsmonitorProbeRunner::run_probe`  (lines 415–424)

```
async fn run_probe(&mut self, args: &[&str]) -> Option<Vec<u8>>
```

**Purpose**: Runs small Git probe commands used to decide how filesystem monitoring should be configured. A filesystem monitor is a Git feature that watches file changes; some configured helpers can run external programs, so the code checks them first.

**Data flow**: It receives probe arguments through the trait method. It starts the configured Git executable in the configured working directory, waits only up to the standard timeout, and returns stdout bytes only if the command succeeds.

**Call relations**: `detect_local_fsmonitor_override` creates this runner and passes it into the shared filesystem-monitor detection logic from elsewhere in the crate. This method is called by that detection logic when it needs Git answers.

*Call graph*: 2 external calls (new, timeout).


##### `detect_local_fsmonitor_override`  (lines 427–430)

```
async fn detect_local_fsmonitor_override(git: &Path, cwd: &Path) -> crate::FsmonitorOverride
```

**Purpose**: Decides what Git filesystem-monitor setting should be forced for a local Git command. This protects status and diff commands from unsafe or unwanted helper programs while preserving safe built-in acceleration.

**Data flow**: It receives the Git executable path and working directory. It builds a `LocalFsmonitorProbeRunner`, lets the shared detection routine inspect Git’s effective configuration, and returns the override setting that later Git commands should use.

**Call relations**: `get_has_changes` and `diff_against_sha` call this before commands that inspect the worktree. The filesystem-monitor tests also call it directly to verify the safety behavior.

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

**Purpose**: Runs a Git command from a chosen executable path with a chosen filesystem-monitor override. This is the lowest-level Git process launcher in the file.

**Data flow**: It receives the Git program path, arguments, working directory, and filesystem-monitor override. It builds a command that disables optional locks, disables hooks by pointing Git’s hooks path at the null device, applies the filesystem-monitor setting, then waits with a timeout. It returns process output or nothing on timeout or startup failure.

**Call relations**: `run_git_command_with_timeout` uses this for ordinary Git calls, while `get_has_changes` and `diff_against_sha` call it directly after detecting filesystem-monitor settings. The tests use it with fake Git executables to confirm the command line is built safely.

*Call graph*: calls 1 internal fn (git_config_arg); called by 5 (diff_against_sha, get_has_changes, run_git_command_with_timeout, fsmonitor_override_rejects_configured_helper, fsmonitor_override_uses_effective_layered_config_value); 3 external calls (new, format!, timeout).


##### `get_git_remotes`  (lines 456–471)

```
async fn get_git_remotes(cwd: &Path) -> Option<Vec<String>>
```

**Purpose**: Returns the repository’s remote names, with `origin` moved to the front when present. `origin` is the common default remote, so prioritizing it usually matches user expectations.

**Data flow**: It receives a working directory, runs `git remote`, reads each output line as a remote name, and reorders the list so `origin` comes first. It returns the list or nothing if Git fails or the output is not valid text.

**Call relations**: `git_diff_to_remote`, `get_default_branch`, and `branch_ancestry` use this when they need to compare local branches with remote branches. It relies on `run_git_command_with_timeout` for the Git call.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout); called by 3 (branch_ancestry, get_default_branch, git_diff_to_remote); 1 external calls (from_utf8).


##### `get_default_branch`  (lines 479–522)

```
async fn get_default_branch(cwd: &Path) -> Option<String>
```

**Purpose**: Tries to determine the repository’s default branch, such as `main` or `master`. This is important when deciding what branch current work should be compared against.

**Data flow**: It receives a working directory. It looks through remotes, preferring `origin`, first by checking each remote’s symbolic `HEAD` reference, then by parsing `git remote show`. If those do not work, it falls back to local `main` or `master` branches.

**Call relations**: `default_branch_name` exposes this behavior publicly, and `branch_ancestry` uses it to build comparison candidates. It calls `get_git_remotes`, `run_git_command_with_timeout`, and finally `get_default_branch_local` as a fallback.

*Call graph*: calls 3 internal fn (get_default_branch_local, get_git_remotes, run_git_command_with_timeout); called by 2 (branch_ancestry, default_branch_name); 2 external calls (from_utf8, format!).


##### `default_branch_name`  (lines 530–532)

```
async fn default_branch_name(cwd: &Path) -> Option<String>
```

**Purpose**: Public wrapper that returns the repository’s default branch name when it can be discovered. It gives callers a simple API without exposing the multi-step lookup.

**Data flow**: It receives a working directory and passes it to `get_default_branch`. Whatever branch name that helper finds is returned directly, or nothing if no reliable answer is available.

**Call relations**: This is the outside-facing entry point for default-branch discovery. The actual remote and local probing happens inside `get_default_branch`.

*Call graph*: calls 1 internal fn (get_default_branch).


##### `get_default_branch_local`  (lines 535–554)

```
async fn get_default_branch_local(cwd: &Path) -> Option<String>
```

**Purpose**: Looks for common default branch names among local branches only. It is a fallback for repositories where remote information is missing or unavailable.

**Data flow**: It receives a working directory. It checks whether `refs/heads/main` exists, then whether `refs/heads/master` exists. It returns the first matching name, or nothing if neither branch exists.

**Call relations**: `get_default_branch` calls this after remote-based discovery fails. `local_git_branches` also uses it so it can place the default branch first in its returned list.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout); called by 2 (get_default_branch, local_git_branches); 1 external calls (format!).


##### `branch_ancestry`  (lines 558–623)

```
async fn branch_ancestry(cwd: &Path) -> Option<Vec<String>>
```

**Purpose**: Builds a list of branch names that are good candidates for finding a remote comparison point. It starts with the current branch and the default branch, then adds remote branches that contain the current commit.

**Data flow**: It receives a working directory. It asks Git for the current branch, asks `get_default_branch` for the default branch, avoids duplicates, then checks each remote for branches that already contain `HEAD`. It returns the ordered list, possibly empty.

**Call relations**: `git_diff_to_remote` calls this before choosing a base SHA. It uses `get_git_remotes` and `run_git_command_with_timeout` to discover remote branches, and its result is later consumed by `find_closest_sha`.

*Call graph*: calls 3 internal fn (get_default_branch, get_git_remotes, run_git_command_with_timeout); called by 1 (git_diff_to_remote); 4 external calls (new, from_utf8, new, format!).


##### `branch_remote_and_distance`  (lines 629–705)

```
async fn branch_remote_and_distance(
    cwd: &Path,
    branch: &str,
    remotes: &[String],
) -> Option<(Option<GitSha>, usize)>
```

**Purpose**: For one branch, finds whether that branch exists on a remote and how far the current `HEAD` is ahead of it. The distance helps choose the closest shared base.

**Data flow**: It receives a working directory, branch name, and ordered remote list. It searches remotes for the first matching remote branch and records its SHA. Then it counts commits from that branch to `HEAD`, using the local branch if possible and the remote ref otherwise. It returns the optional remote SHA plus the numeric distance, or nothing if Git cannot compute it.

**Call relations**: `find_closest_sha` calls this for each candidate branch. This helper does the detailed Git probing while the caller compares the results.

*Call graph*: calls 2 internal fn (run_git_command_with_timeout, new); called by 1 (find_closest_sha); 2 external calls (from_utf8, format!).


##### `find_closest_sha`  (lines 708–730)

```
async fn find_closest_sha(cwd: &Path, branches: &[String], remotes: &[String]) -> Option<GitSha>
```

**Purpose**: Chooses the remote commit closest to the current work among candidate branches. This gives the diff logic a sensible base point.

**Data flow**: It receives a working directory, candidate branch names, and remote names. For each branch, it asks `branch_remote_and_distance` for a remote SHA and distance. It keeps the SHA with the smallest distance and returns it, or nothing if no usable remote branch is found.

**Call relations**: `git_diff_to_remote` calls this after gathering remotes and branch ancestry. It delegates per-branch Git details to `branch_remote_and_distance` and returns the chosen SHA to `diff_against_sha`.

*Call graph*: calls 1 internal fn (branch_remote_and_distance); called by 1 (git_diff_to_remote).


##### `diff_against_sha`  (lines 732–796)

```
async fn diff_against_sha(cwd: &Path, sha: &GitSha) -> Option<String>
```

**Purpose**: Builds the actual diff text between the working tree and a chosen commit SHA. It also includes untracked files, which plain `git diff <sha>` would not show.

**Data flow**: It receives a working directory and base SHA. It detects the safe filesystem-monitor override, runs `git diff` against the SHA, then asks Git for untracked files. For each untracked file, it runs a no-index diff against the platform’s null device and appends that output. It returns the combined diff text or nothing if required Git commands fail.

**Call relations**: `git_diff_to_remote` calls this after `find_closest_sha` picks the base commit. It uses `detect_local_fsmonitor_override` and the lower-level `run_git_command_with_timeout_from` because diff commands inspect the worktree.

*Call graph*: calls 2 internal fn (detect_local_fsmonitor_override, run_git_command_with_timeout_from); called by 1 (git_diff_to_remote); 4 external calls (new, from_utf8, cfg!, join_all).


##### `resolve_root_git_project_for_trust`  (lines 802–835)

```
async fn resolve_root_git_project_for_trust(
    fs: &dyn ExecutorFileSystem,
    cwd: &AbsolutePathBuf,
) -> Option<AbsolutePathBuf>
```

**Purpose**: Finds the repository path that should be used for trust decisions, including Git worktrees. A worktree is an extra checkout linked back to a main repository.

**Data flow**: It receives an abstract filesystem and current directory. It finds the nearest Git root, checks whether `.git` is a real directory, and returns that root if so. If `.git` is a file pointing to a worktree Git directory, it follows that pointer back to the common repository and returns the main project root.

**Call relations**: This public helper starts with `get_git_repo_root_with_fs`, then reads filesystem metadata and `.git` file text through the provided filesystem. It exists so trust checks use the main repository identity even when the user is inside a linked worktree.

*Call graph*: calls 4 internal fn (read_file_text, get_git_repo_root_with_fs, resolve_path_against_base, from_abs_path); 2 external calls (new, get_metadata).


##### `find_ancestor_git_entry`  (lines 837–854)

```
fn find_ancestor_git_entry(base_dir: &Path) -> Option<(PathBuf, PathBuf)>
```

**Purpose**: Searches upward from a local directory until it finds a `.git` entry. This is the basic local repository-root search.

**Data flow**: It receives a starting directory. It checks that directory for `.git`; if not found, it moves to the parent and repeats until it reaches the filesystem root. It returns both the repository root and the `.git` path when found.

**Call relations**: `get_git_repo_root` calls this after choosing the correct starting directory. It is intentionally filesystem-simple and does not run the Git program.

*Call graph*: called by 1 (get_git_repo_root); 1 external calls (to_path_buf).


##### `find_ancestor_git_entry_with_fs`  (lines 856–872)

```
async fn find_ancestor_git_entry_with_fs(
    fs: &dyn ExecutorFileSystem,
    base_dir: &AbsolutePathBuf,
) -> Option<(AbsolutePathBuf, AbsolutePathBuf)>
```

**Purpose**: Searches upward for a `.git` entry using an abstract filesystem. This supports remote or sandboxed filesystems where normal local path checks are not enough.

**Data flow**: It receives a filesystem object and a starting absolute directory. For each ancestor directory, it builds the `.git` path and asks the filesystem for metadata. The first successful metadata lookup becomes the repository root result.

**Call relations**: `get_git_repo_root_with_fs` calls this as the remote-aware counterpart to `find_ancestor_git_entry`. It uses `PathUri` values because the filesystem API works with URI-style paths.

*Call graph*: calls 2 internal fn (ancestors, from_abs_path); called by 1 (get_git_repo_root_with_fs); 1 external calls (get_metadata).


##### `local_git_branches`  (lines 876–900)

```
async fn local_git_branches(cwd: &Path) -> Vec<String>
```

**Purpose**: Returns the local branch names in a repository, with the local default branch first if it exists. This is useful for branch pickers or branch-related UI.

**Data flow**: It receives a working directory, runs `git branch --format=%(refname:short)`, trims and collects non-empty names, then sorts them. If `main` or `master` exists locally, it moves that branch to the front. Errors produce an empty list.

**Call relations**: This public helper uses `run_git_command_with_timeout` for branch listing and `get_default_branch_local` for the preferred branch. It does not inspect remotes, so it stays quick and local.

*Call graph*: calls 2 internal fn (get_default_branch_local, run_git_command_with_timeout); 2 external calls (from_utf8_lossy, new).


##### `current_branch_name`  (lines 903–912)

```
async fn current_branch_name(cwd: &Path) -> Option<String>
```

**Purpose**: Returns the name of the currently checked-out branch. It gives callers a simple answer for “what branch am I on?”

**Data flow**: It receives a working directory, runs `git branch --show-current`, converts stdout to text, trims it, and returns the name if non-empty. If Git fails, the output is invalid, or the repository is detached from a branch, it returns nothing.

**Call relations**: This public helper uses the shared `run_git_command_with_timeout` wrapper. It is independent from the more complex `branch_ancestry` logic, which does its own current-branch lookup as part of diff-base selection.

*Call graph*: calls 1 internal fn (run_git_command_with_timeout); 1 external calls (from_utf8).


##### `tests::canonicalize_git_remote_url_normalizes_github_variants`  (lines 922–937)

```
fn canonicalize_git_remote_url_normalizes_github_variants()
```

**Purpose**: Verifies that many common GitHub remote URL spellings normalize to the same identity. This protects comparisons from being fooled by harmless URL differences.

**Data flow**: It feeds several GitHub-style remotes into `canonicalize_git_remote_url` and checks that each produces `github.com/openai/codex`. The test changes no shared state.

**Call relations**: This test exercises the public URL-normalization entry point. It indirectly covers the helper functions used for full URLs, SSH shorthand, host cleanup, and `.git` suffix trimming.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::canonicalize_git_remote_url_handles_ghe_without_lowercasing_path`  (lines 940–949)

```
fn canonicalize_git_remote_url_handles_ghe_without_lowercasing_path()
```

**Purpose**: Verifies that GitHub Enterprise-style hosts are normalized without lowercasing the owner and repository path. That matters because non-GitHub servers may treat path case differently.

**Data flow**: It passes two enterprise-host remote URLs into `canonicalize_git_remote_url` and checks the exact normalized results. One uses SSH shorthand and the other uses an SSH URL with a non-default port.

**Call relations**: This test focuses on the branch inside `canonicalize_git_remote_host_path` that lowercases paths only for `github.com`. It helps prevent accidental broadening of GitHub-specific behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::canonicalize_git_remote_url_rejects_non_repository_values`  (lines 952–956)

```
fn canonicalize_git_remote_url_rejects_non_repository_values()
```

**Purpose**: Verifies that URL normalization rejects empty strings, local file URLs, and incomplete repository paths. This prevents bad inputs from being treated as real repository identities.

**Data flow**: It sends several invalid remote-like strings to `canonicalize_git_remote_url` and checks that each returns nothing. No files or Git commands are involved.

**Call relations**: This test covers the validation paths in `canonicalize_git_remote_url` and its parsing helpers. It complements the positive URL-normalization tests.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::fsmonitor_override_rejects_configured_helper`  (lines 960–1011)

```
async fn fsmonitor_override_rejects_configured_helper()
```

**Purpose**: Checks that a configured external filesystem-monitor helper is rejected for worktree commands. This is a safety test: project configuration should not cause these internal Git commands to run unexpected helper programs.

**Data flow**: It creates a temporary fake `git` script that reports a configured helper and logs its arguments. The test detects the filesystem-monitor override, runs a status command through the low-level runner, then checks both the command output and the logged arguments. The expected final Git command forces `core.fsmonitor=false`.

**Call relations**: This test calls `detect_local_fsmonitor_override` and `run_git_command_with_timeout_from` directly. It verifies the same path used by `get_has_changes` and `diff_against_sha` when they inspect the worktree.

*Call graph*: calls 2 internal fn (detect_local_fsmonitor_override, run_git_command_with_timeout_from); 6 external calls (assert_eq!, format!, metadata, set_permissions, write, tempdir).


##### `tests::fsmonitor_override_uses_effective_layered_config_value`  (lines 1015–1098)

```
async fn fsmonitor_override_uses_effective_layered_config_value()
```

**Purpose**: Checks that filesystem-monitor detection respects Git’s layered configuration, meaning local settings can override global settings. It ensures the code keeps safe built-in monitoring enabled when Git says it is effective.

**Data flow**: It creates a real temporary repository, writes a global config with an external helper, then writes a local config setting `core.fsmonitor` to true. A fake Git wrapper logs commands and delegates config checks to real Git. The test confirms the final command uses `core.fsmonitor=true` rather than disabling it.

**Call relations**: Like the other filesystem-monitor test, it directly exercises `detect_local_fsmonitor_override` and `run_git_command_with_timeout_from`. It proves the detection path used by worktree-inspecting commands reads Git’s effective configuration, not just one config file.

*Call graph*: calls 2 internal fn (detect_local_fsmonitor_override, run_git_command_with_timeout_from); 9 external calls (assert_eq!, new, format!, create_dir, metadata, read_to_string, set_permissions, write, tempdir).


### `tui/src/get_git_diff.rs`

`domain_logic` · `request handling`

This file exists so the app can safely show “what changed?” for a workspace. It first checks whether the current directory is actually inside a Git repository. If not, it quietly reports that there is no Git diff instead of treating that as a crash.

When it is in a repository, it asks Git for two kinds of changes: normal tracked-file changes, and untracked files that Git does not yet know about. Git’s regular diff does not include untracked files, so the file creates a separate “diff against nothing” for each untracked file, using the system’s null device like an empty placeholder file.

A major theme here is safety. Git can be configured to run external programs for filters, hooks, diff helpers, or filesystem monitoring. For a read-only informational command like `/diff`, that would be surprising and risky. So this code disables hooks, disables external diff behavior, turns off executable filter drivers while diffing, and uses a filesystem-monitor policy chosen by the shared Git utility code.

The tests use fake command runners and real temporary repositories to prove both the visible behavior and the safety guarantees: correct output, correct Git exit-code handling, and no accidental execution of configured helpers.

#### Function details

##### `WorkspaceFsmonitorProbeRunner::run_probe`  (lines 35–42)

```
async fn run_probe(&mut self, args: &[&str]) -> Option<Vec<u8>>
```

**Purpose**: This lets the shared Git utility code run small Git probe commands through the TUI’s workspace command system. It is used only to inspect filesystem-monitor settings, not to produce the final diff.

**Data flow**: It receives a short list of Git arguments, adds `git` in front, sets the working directory, and asks the workspace command runner to execute it. If the command succeeds, it returns the command’s standard output as bytes; if it fails, it returns nothing.

**Call relations**: During `get_git_diff`, this adapter is passed to `detect_fsmonitor_override`. That shared detector calls `run_probe` when it needs to ask Git about filesystem-monitor configuration, while the actual command execution still stays inside the TUI workspace layer.

*Call graph*: calls 1 internal fn (new); 2 external calls (to_path_buf, run).


##### `get_git_diff`  (lines 49–120)

```
async fn get_git_diff(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Result<(bool, String), String>
```

**Purpose**: This is the main function for collecting the current Git diff. It returns whether the folder is a Git repository and, if it is, the combined diff text for tracked and untracked changes.

**Data flow**: It takes a command runner and a working directory. It first checks whether the directory is inside a Git work tree; if not, it returns `false` with empty text. Otherwise it detects the filesystem-monitor setting, prepares safe configuration overrides, runs Git commands for tracked changes and untracked filenames, then creates diff text for each untracked file and concatenates everything into one string.

**Call relations**: The `/diff` flow calls this as its top-level helper. Inside, it delegates the repository check to `inside_git_repo`, safety configuration to `diff_filter_config_overrides`, and Git command output collection to `run_git_capture_diff` and `run_git_capture_stdout`. The test functions call it under many fake and real Git scenarios.

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

**Purpose**: This runs a Git command where only a zero exit status counts as success, then returns Git’s standard output as text. It is used for commands that are expected to either succeed cleanly or fail.

**Data flow**: It receives the runner, working directory, filesystem-monitor choice, and Git arguments. It sends those through `run_git_command`, checks the exit code, and returns the output text on success or an error message on failure.

**Call relations**: It is a stricter wrapper around `run_git_command`. `get_git_diff` uses it for `git ls-files --others --exclude-standard`, where a non-zero status should stop the diff operation.

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

**Purpose**: This runs a Git diff command and returns the diff text. It treats Git exit code 1 as normal, because Git uses that code to mean “there are differences,” not “the command broke.”

**Data flow**: It receives the runner, working directory, filesystem-monitor choice, optional Git configuration overrides, and Git diff arguments. It runs the command, accepts exit code 0 or 1, and returns standard output; any other code becomes a readable error string.

**Call relations**: This is the diff-specific wrapper used by `get_git_diff` for both tracked-file diffs and untracked-file diffs. It relies on `run_git_command` to build and execute the safe Git command.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (get_git_diff); 1 external calls (format!).


##### `diff_filter_config_overrides`  (lines 163–205)

```
async fn diff_filter_config_overrides(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
    fsmonitor: FsmonitorOverride,
) -> Result<Vec<(String, String)>, String>
```

**Purpose**: This finds Git filter drivers that could run external programs while making a diff, and prepares temporary settings that turn those programs off. It keeps `/diff` informational rather than letting repository configuration execute code.

**Data flow**: It asks Git for configuration keys matching executable filter settings. From keys like `filter.name.clean` or `filter.name.process`, it extracts each filter driver name, removes duplicates, and produces temporary override pairs that blank out the executable commands and mark the filter as not required.

**Call relations**: The main `get_git_diff` flow calls this once after filesystem-monitor detection. Its returned overrides are then passed into `run_git_capture_diff` so tracked and untracked diffs are generated with those filters disabled.

*Call graph*: calls 1 internal fn (run_git_command); called by 1 (get_git_diff); 1 external calls (format!).


##### `inside_git_repo`  (lines 208–223)

```
async fn inside_git_repo(
    runner: &dyn WorkspaceCommandExecutor,
    cwd: &Path,
) -> Result<bool, String>
```

**Purpose**: This answers the simple question: is the chosen folder inside a Git working tree? It prevents `/diff` from running a pile of Git commands in a non-Git folder.

**Data flow**: It runs `git rev-parse --is-inside-work-tree` in the requested directory with filesystem monitoring disabled. If Git succeeds, it returns `true`; otherwise it returns `false`, unless the command runner itself reports an execution error.

**Call relations**: This is the first check made by `get_git_diff`. Only if it returns `true` does the rest of the diff workflow continue.

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

**Purpose**: This is the common command builder for all Git calls in this file. It adds safety-related Git configuration, sets the working directory and timeout, applies temporary config overrides when needed, and sends the command to the workspace runner.

**Data flow**: It receives the command runner, directory, filesystem-monitor setting, optional config override pairs, and Git arguments. It builds a `WorkspaceCommand` starting with `git`, adds `-c` options to control filesystem monitoring and disable hooks, sets a 30-second timeout, removes the output cap for diff text, adds environment variables for config overrides, then returns the command output or an error string.

**Call relations**: All higher-level Git helpers in this file call this function. It is the narrow doorway through which `inside_git_repo`, `diff_filter_config_overrides`, `run_git_capture_stdout`, and `run_git_capture_diff` actually execute Git.

*Call graph*: calls 2 internal fn (git_config_arg, new); called by 4 (diff_filter_config_overrides, inside_git_repo, run_git_capture_diff, run_git_capture_stdout); 3 external calls (to_path_buf, format!, run).


##### `tests::get_git_diff_returns_not_git_for_non_git_cwd`  (lines 275–290)

```
async fn get_git_diff_returns_not_git_for_non_git_cwd()
```

**Purpose**: This test proves that a non-Git directory is reported calmly as “not a Git repo” with no diff text. That matters because users may run the TUI anywhere.

**Data flow**: It gives a fake runner one response: `git rev-parse` fails like it would outside a repository. It calls `get_git_diff` and checks that the result is `false` plus an empty string, then verifies the command metadata.

**Call relations**: This test calls the main `get_git_diff` path and uses `FakeRunner` to make the first Git check fail. It also calls `assert_command_metadata` to confirm the command was shaped correctly.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_disables_helpers_for_tracked_and_untracked_diffs`  (lines 293–387)

```
async fn get_git_diff_disables_helpers_for_tracked_and_untracked_diffs()
```

**Purpose**: This test proves that configured Git filter helpers are disabled for both normal tracked diffs and untracked-file diffs. It protects against `/diff` accidentally running repository-specified programs.

**Data flow**: It sets up fake Git responses showing a repository, a configured filesystem-monitor helper that should be disabled, one dangerous filter driver, a tracked diff, one untracked file, and that file’s diff. It checks that the combined output contains both diff parts and that the diff commands received environment overrides disabling the filter.

**Call relations**: This test drives `get_git_diff` through its full fake-command workflow. It uses helper functions such as `git_command`, `git_probe_command`, `filter_override_env`, `response`, and `null_device` to describe the expected commands.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_preserves_builtin_fsmonitor_for_diff_workflow`  (lines 390–473)

```
async fn get_git_diff_preserves_builtin_fsmonitor_for_diff_workflow()
```

**Purpose**: This test proves that Git’s built-in filesystem monitor can stay enabled when it is safe and supported. The code should not blindly disable every filesystem-monitor setting.

**Data flow**: It fakes a repository where `core.fsmonitor` is set to `true` and Git reports support for the built-in monitor. It then provides fake outputs for config scanning, tracked diff, untracked files, and untracked diff, and checks that the final combined diff is correct.

**Call relations**: This test calls `get_git_diff` and confirms that the filesystem-monitor detection result flows into later Git commands. It relies on `assert_command_metadata` to verify command setup.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_accepts_diff_exit_code_one`  (lines 476–535)

```
async fn get_git_diff_accepts_diff_exit_code_one()
```

**Purpose**: This test documents an important Git quirk: exit code 1 from `git diff` means differences were found, not that the command failed. The diff command must accept that code.

**Data flow**: It fakes a valid repository, no special filesystem-monitor setting, no filter drivers, a tracked diff returning exit code 1, and no untracked files. It checks that `get_git_diff` returns the tracked diff text successfully.

**Call relations**: This test exercises `get_git_diff`, specifically the path through `run_git_capture_diff` that treats exit code 1 as okay.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_rejects_unexpected_git_diff_status`  (lines 538–602)

```
async fn get_git_diff_rejects_unexpected_git_diff_status()
```

**Purpose**: This test proves that real Git failures still surface as errors. Only the special diff exit code 1 is accepted; other non-zero statuses should stop the workflow.

**Data flow**: It fakes a repository and then makes the tracked diff command return exit code 2. It calls `get_git_diff`, expects an error, and checks the exact error message.

**Call relations**: This test calls `get_git_diff` and reaches `run_git_capture_diff`, showing that the wrapper accepts only success or the known “differences found” code.

*Call graph*: calls 1 internal fn (get_git_diff); 5 external calls (from, assert_eq!, new, assert_command_metadata, vec!).


##### `tests::get_git_diff_does_not_execute_configured_filters_fsmonitor_or_hooks`  (lines 606–683)

```
async fn get_git_diff_does_not_execute_configured_filters_fsmonitor_or_hooks()
```

**Purpose**: This Unix-only integration test proves the safety behavior against a real Git repository. It checks that filter helpers, filesystem-monitor helpers, and hooks are not executed while generating the diff.

**Data flow**: It creates a temporary repository, commits files, configures helper scripts that would leave marker files if run, changes a tracked file, and calls `get_git_diff` with a real local command runner. It verifies that the diff contains the old and new file contents, while none of the marker files were created.

**Call relations**: Unlike the fake-runner tests, this uses `LocalRunner` to run real Git commands. It depends on `run_git_setup` for repository setup and `write_marker_helper` for helper scripts that reveal accidental execution.

*Call graph*: calls 1 internal fn (get_git_diff); 8 external calls (from_secs, assert_eq!, create_dir, write, sleep, tempdir, run_git_setup, write_marker_helper).


##### `tests::get_git_diff_does_not_execute_helpers_while_checking_dirty_submodules`  (lines 687–742)

```
async fn get_git_diff_does_not_execute_helpers_while_checking_dirty_submodules()
```

**Purpose**: This Unix-only integration test proves that checking submodules does not accidentally inspect their dirty worktrees in a way that runs helper programs. Submodules are separate Git repositories nested inside another one.

**Data flow**: It creates a child repository, adds it as a submodule to a parent repository, configures a filter helper inside the submodule checkout, and refreshes a tracked file. It calls `get_git_diff` on the parent and verifies that no diff is produced and the helper marker file was not created.

**Call relations**: This test uses real Git through `LocalRunner`. It supports the main diff command’s use of `--ignore-submodules=dirty`, which keeps the parent diff from poking into submodule worktrees.

*Call graph*: calls 1 internal fn (get_git_diff); 8 external calls (from_secs, assert_eq!, create_dir, write, sleep, tempdir, run_git_setup, write_marker_helper).


##### `tests::git_command`  (lines 744–756)

```
fn git_command(fsmonitor: FsmonitorOverride, args: &[&str]) -> Vec<String>
```

**Purpose**: This helper builds the exact Git command line that production code is expected to create for normal Git operations. It keeps fake-runner tests readable and precise.

**Data flow**: It receives a filesystem-monitor override and a list of Git arguments. It returns a vector of strings starting with `git`, adding the same `-c` settings for filesystem monitoring and disabled hooks that production uses, followed by the supplied arguments.

**Call relations**: The fake tests use this to construct expected command lines for `FakeRunner`. It mirrors `run_git_command`, so mismatches reveal changes in production command construction.

*Call graph*: calls 1 internal fn (git_config_arg).


##### `tests::git_probe_command`  (lines 758–764)

```
fn git_probe_command(args: &[&str]) -> Vec<String>
```

**Purpose**: This helper builds the exact command line expected for filesystem-monitor probe commands. Probe commands are deliberately simpler than full diff commands.

**Data flow**: It receives Git arguments and returns a vector of strings beginning with `git` followed by those arguments. It does not add the safety flags used by full diff commands.

**Call relations**: Tests use this for commands run through `WorkspaceFsmonitorProbeRunner::run_probe`, which are called by filesystem-monitor detection rather than by `run_git_command`.


##### `tests::filter_override_env`  (lines 766–785)

```
fn filter_override_env(driver: &str) -> HashMap<String, Option<String>>
```

**Purpose**: This helper builds the environment variables expected when a filter driver is disabled for a diff command. It lets tests check that dangerous filters are actually neutralized.

**Data flow**: It receives a filter driver name such as `filter.evil`. It returns a map of `GIT_CONFIG_*` environment variables that blank the driver’s `clean` and `process` commands and set `required` to `false`.

**Call relations**: The filter-safety test compares command environments against this helper’s result. It mirrors the output of `diff_filter_config_overrides` as applied by `run_git_command`.

*Call graph*: 3 external calls (from, new, format!).


##### `tests::response`  (lines 787–796)

```
fn response(argv: Vec<String>, exit_code: i32, stdout: &str) -> FakeResponse
```

**Purpose**: This helper packages an expected command and its fake output for `FakeRunner`. It makes each test scenario read like a script of Git conversations.

**Data flow**: It receives an expected argument vector, an exit code, and standard output text. It returns a `FakeResponse` containing those expected inputs and a `WorkspaceCommandOutput` with empty standard error.

**Call relations**: Most fake-runner tests build a queue of these responses and pass them into `FakeRunner::new`. `FakeRunner::run` consumes them one by one.

*Call graph*: 1 external calls (new).


##### `tests::null_device`  (lines 798–800)

```
fn null_device() -> &'static str
```

**Purpose**: This helper returns the platform’s name for the special empty device used when diffing an untracked file against nothing. Unix uses `/dev/null`; Windows uses `NUL`.

**Data flow**: It checks the target operating system at compile time and returns the correct string for that platform.

**Call relations**: Tests use this when describing the expected `git diff --no-index` command for untracked files. It matches the platform choice made inside `get_git_diff`.

*Call graph*: 1 external calls (cfg!).


##### `tests::run_git_setup`  (lines 803–816)

```
fn run_git_setup(cwd: &Path, args: &[&str])
```

**Purpose**: This Unix-only helper runs real Git commands while preparing integration-test repositories. It fails the test immediately if setup Git commands do not succeed.

**Data flow**: It receives a working directory and Git arguments, runs `git` there, captures output, and asserts that the exit code is zero. If setup fails, it prints the command’s output to make the failure understandable.

**Call relations**: The real-repository tests call this repeatedly to initialize repositories, configure Git, add files, commit, and create submodules before calling `get_git_diff`.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::write_marker_helper`  (lines 819–827)

```
fn write_marker_helper(path: &Path)
```

**Purpose**: This Unix-only helper writes a tiny executable script that leaves a marker file if it is run. Tests use it as a tripwire for accidental helper execution.

**Data flow**: It receives a script path, writes shell-script contents that append `ran` to a sibling marker file, reads the file permissions, makes the script executable, and saves the permissions.

**Call relations**: The integration tests install these scripts as Git filters, filesystem monitors, or hooks. After `get_git_diff` runs, the tests check whether marker files appeared.

*Call graph*: 3 external calls (metadata, set_permissions, write).


##### `tests::assert_command_metadata`  (lines 829–845)

```
fn assert_command_metadata(commands: &[WorkspaceCommand], cwd: &Path)
```

**Purpose**: This helper checks that every fake command was launched with the expected working directory, timeout, and output-cap settings. It catches accidental changes to command safety and resource limits.

**Data flow**: It receives the recorded commands and expected current directory. For each command, it verifies the directory. Probe commands are expected to use a shorter timeout and output cap, while full diff commands are expected to use the diff timeout and no output cap.

**Call relations**: Fake-runner tests call this after `get_git_diff` finishes. It checks the command objects recorded by `FakeRunner::run`.

*Call graph*: 2 external calls (assert_eq!, matches!).


##### `tests::FakeRunner::new`  (lines 858–863)

```
fn new(responses: Vec<FakeResponse>) -> Self
```

**Purpose**: This creates a fake workspace command runner loaded with the Git responses a test expects. It lets tests run without invoking real Git.

**Data flow**: It receives a list of fake responses, stores them in a queue protected by a mutex, and creates an empty list for recording commands that are run.

**Call relations**: Fake tests call this before `get_git_diff`. Later, `FakeRunner::run` consumes the queued responses and records the actual commands for verification.

*Call graph*: 2 external calls (new, new).


##### `tests::FakeRunner::commands`  (lines 865–872)

```
fn commands(&self) -> Vec<WorkspaceCommand>
```

**Purpose**: This returns the commands that the fake runner recorded, after checking that all expected fake responses were used. It helps tests prove the command sequence was complete.

**Data flow**: It locks the response queue and asserts that it is empty. Then it locks and clones the recorded command list and returns it to the test.

**Call relations**: Fake tests call this after `get_git_diff` to inspect what commands were issued. `assert_command_metadata` and some tests’ direct environment checks use its result.

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

**Purpose**: This is the fake implementation of the workspace command executor. It checks that the production code runs exactly the command the test expected, then returns the matching fake output.

**Data flow**: It receives a `WorkspaceCommand`, removes the next fake response from the queue, asserts that the command arguments match the expected arguments, records the command, and returns the fake output.

**Call relations**: Production code calls this through the `WorkspaceCommandExecutor` interface while tests call `get_git_diff`. It stands in for real command execution in most unit tests.

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

**Purpose**: This Unix-only test runner executes real local commands for integration tests. It lets the tests confirm behavior against actual Git instead of only simulated responses.

**Data flow**: It receives a `WorkspaceCommand`, starts a real process with the command’s program and arguments, sets the working directory and environment changes, waits for output, converts stdout and stderr from UTF-8 bytes into strings, and returns a `WorkspaceCommandOutput`.

**Call relations**: The real-repository safety tests pass `LocalRunner` into `get_git_diff`. Through the same `WorkspaceCommandExecutor` interface, production code runs real Git commands while the tests check that dangerous helpers were not triggered.

*Call graph*: 3 external calls (pin, new, from_utf8).


### Plugin packaging and marketplace updates
These files cover plugin archive transport plus the filesystem and git helpers used to install and activate marketplace content safely.

### `core-plugins/src/plugin_bundle_archive.rs`

`io_transport` · `plugin packaging and plugin bundle extraction`

A plugin bundle is a directory of files that needs to travel as one object, much like putting papers into a sealed envelope. This file creates that envelope using a tar archive, which stores many files together, wrapped in gzip compression, which makes it smaller. Before packing, it checks that the path is really a plugin directory and that it contains the required `.codex-plugin/plugin.json` file.

The file is careful about limits. While creating the archive, it writes into a special in-memory buffer that refuses to grow beyond a configured maximum. While unpacking, it counts the total declared size of extracted files and stops if the bundle would exceed the allowed size.

It is also careful about safety. Archive entries can contain odd paths such as `../outside`, absolute paths, or links. If accepted blindly, those could write files outside the destination directory, like letting a moving box unpack itself into the neighbor’s house. This file rejects those paths and rejects symbolic links and hard links. Only normal directories and regular files are unpacked.

Without this file, plugin upload and extraction would either need to duplicate archive code elsewhere or risk oversized, malformed, or unsafe plugin bundles.

#### Function details

##### `PluginBundleUnpackError::io`  (lines 47–49)

```
fn io(context: &'static str, source: io::Error) -> Self
```

**Purpose**: This small helper wraps a low-level input/output error with a short explanation of what the code was trying to do. It makes unpacking failures easier to understand than a bare operating-system error.

**Data flow**: It receives a fixed context message and an `io::Error`, which is an operating-system or file-reading/writing error. It combines them into a `PluginBundleUnpackError::Io` value. The output is an error that says both where the failure happened and what the original error was.

**Call relations**: The unpacking code calls this whenever reading the archive or creating files fails. It is part of the error-reporting path used by `unpack_plugin_bundle_tar_gz` and `unpack_plugin_bundle_tar` so callers get useful failure messages.


##### `pack_plugin_bundle_tar_gz`  (lines 52–77)

```
fn pack_plugin_bundle_tar_gz(
    plugin_path: &Path,
    max_bytes: usize,
) -> Result<Vec<u8>, PluginBundlePackError>
```

**Purpose**: This is the main packing function. It takes a plugin directory and produces a compressed `tar.gz` byte array that can be uploaded or stored, while refusing invalid plugin folders and archives that would be too large.

**Data flow**: It receives a path to a plugin folder and a maximum allowed archive size. First it checks that the path is a directory and that `.codex-plugin/plugin.json` exists. Then it creates a gzip compressor that writes into a size-limited memory buffer, adds the plugin files to a tar archive, finishes compression, and returns the final bytes. If any check or file operation fails, it returns a clear packing error instead.

**Call relations**: This function is called by `archive_plugin_for_upload_with_limit` when a plugin needs to be prepared for upload. It delegates the directory walk to `append_plugin_tree`, uses `SizeLimitedBuffer::new` to enforce the byte limit, and sends low-level archive errors through `archive_io_error` so size-limit failures become a specific user-facing error.

*Call graph*: calls 2 internal fn (new, append_plugin_tree); called by 1 (archive_plugin_for_upload_with_limit); 6 external calls (new, is_dir, join, to_path_buf, default, new).


##### `append_plugin_tree`  (lines 79–108)

```
fn append_plugin_tree(
    archive: &mut tar::Builder<W>,
    plugin_root: &Path,
    current: &Path,
) -> io::Result<()>
```

**Purpose**: This function adds every supported file and folder inside a plugin directory to an open tar archive. It keeps paths relative to the plugin root so the archive contains the plugin contents, not the machine’s full local file paths.

**Data flow**: It receives an archive writer, the plugin root path, and the current folder being scanned. It reads the current folder, sorts entries by name for stable output, and for each item adds a directory entry or a file entry under its relative path. If it sees something other than a normal file or directory, it returns an error.

**Call relations**: It is used by `pack_plugin_bundle_tar_gz` during archive creation. For directories, it calls itself again, so it walks the whole plugin tree from top to bottom before handing control back to the packer.

*Call graph*: called by 1 (pack_plugin_bundle_tar_gz); 5 external calls (append_dir, append_path_with_name, other, format!, read_dir).


##### `archive_io_error`  (lines 110–122)

```
fn archive_io_error(source: io::Error) -> PluginBundlePackError
```

**Purpose**: This function translates raw archive-writing errors into the higher-level packing errors used by this file. Its special job is to recognize when the size-limited buffer stopped the archive because it got too big.

**Data flow**: It receives an `io::Error`. It looks inside that error to see whether it contains an `ArchiveSizeLimitExceeded` marker. If it does, it returns `PluginBundlePackError::ArchiveTooLarge` with the attempted size and the limit. Otherwise, it wraps the original error as a general archive input/output failure.

**Call relations**: The packing flow calls this after tar or gzip operations fail. This lets `pack_plugin_bundle_tar_gz` report a helpful archive-size error instead of a vague write failure.

*Call graph*: 1 external calls (get_ref).


##### `unpack_plugin_bundle_tar_gz`  (lines 124–139)

```
fn unpack_plugin_bundle_tar_gz(
    bytes: &[u8],
    destination: &Path,
    max_total_bytes: u64,
) -> Result<(), PluginBundleUnpackError>
```

**Purpose**: This is the main unpacking function for compressed plugin bundles. It creates the destination folder, opens the gzip-compressed tar data, and extracts it safely with a total size limit.

**Data flow**: It receives compressed archive bytes, a destination path, and the maximum total extracted size. It makes sure the destination directory exists, wraps the bytes in a gzip decoder, treats the decoded stream as a tar archive, and passes that archive to the safer tar-unpacking routine. It returns success when extraction completes, or a detailed unpacking error if something goes wrong.

**Call relations**: This function is used by code and tests that need to extract a plugin bundle, including `extract_plugin_bundle_tar_gz_with_limits` and a round-trip archive test. It hands the detailed work to `unpack_plugin_bundle_tar`, which checks paths, entry types, and size limits.

*Call graph*: calls 2 internal fn (unpack_plugin_bundle_tar, new); called by 2 (archive_plugin_for_upload_round_trips_through_plugin_bundle_archive_with_long_paths, extract_plugin_bundle_tar_gz_with_limits); 3 external calls (new, new, create_dir_all).


##### `unpack_plugin_bundle_tar`  (lines 141–203)

```
fn unpack_plugin_bundle_tar(
    archive: &mut Archive<R>,
    destination: &Path,
    max_total_bytes: u64,
) -> Result<(), PluginBundleUnpackError>
```

**Purpose**: This function does the detailed, safety-conscious extraction of a tar archive. It only allows normal files and directories, checks every output path, and stops if the extracted files would exceed the allowed total size.

**Data flow**: It receives an open tar archive, a destination directory, and a maximum total byte count. It reads each archive entry, computes the safe destination path, creates directories as needed, counts file sizes before extracting files, and writes files to disk. It rejects links, unsupported entry types, empty or escaping paths, and oversized bundles.

**Call relations**: It is called by `unpack_plugin_bundle_tar_gz` after gzip decoding has been set up. During extraction it calls `checked_tar_output_path` to prevent files from escaping the destination and `enforce_total_extracted_size` to keep the bundle within its allowed size.

*Call graph*: calls 2 internal fn (checked_tar_output_path, enforce_total_extracted_size); called by 1 (unpack_plugin_bundle_tar_gz); 4 external calls (entries, InvalidBundle, format!, create_dir_all).


##### `checked_tar_output_path`  (lines 205–234)

```
fn checked_tar_output_path(
    destination: &Path,
    entry_name: &Path,
) -> Result<PathBuf, PluginBundleUnpackError>
```

**Purpose**: This function converts an archive entry name into a safe path under the chosen destination directory. It protects against archive paths that try to write somewhere else on the filesystem.

**Data flow**: It receives the destination directory and an entry path from the tar archive. It walks through the path piece by piece, accepting only normal path components and ignoring `.` components. If it sees `..`, an absolute-root marker, a Windows-style prefix, or no real component at all, it returns an invalid-bundle error. Otherwise it returns the safe full output path.

**Call relations**: The tar extraction loop calls this before creating any directory or file. Its result decides where `unpack_plugin_bundle_tar` may write; if the path is unsafe, extraction stops before touching that entry.

*Call graph*: called by 1 (unpack_plugin_bundle_tar); 4 external calls (components, to_path_buf, InvalidBundle, format!).


##### `enforce_total_extracted_size`  (lines 236–255)

```
fn enforce_total_extracted_size(
    entry_size: u64,
    extracted_bytes: &mut u64,
    max_total_bytes: u64,
) -> Result<(), PluginBundleUnpackError>
```

**Purpose**: This function keeps a running total of how many file bytes the archive wants to extract. It prevents a bundle from expanding beyond the configured maximum.

**Data flow**: It receives the next file’s size, a mutable running total, and the maximum allowed total. It adds the next size to the total, carefully checking for number overflow. If the new total is too large, it returns an `ExtractedBundleTooLarge` error. Otherwise it updates the running total and returns success.

**Call relations**: The extraction loop in `unpack_plugin_bundle_tar` calls this before unpacking each regular file. It acts as the gatekeeper that must approve the file’s size before the file is written to disk.

*Call graph*: called by 1 (unpack_plugin_bundle_tar).


##### `SizeLimitedBuffer::new`  (lines 263–268)

```
fn new(max_bytes: usize) -> Self
```

**Purpose**: This creates an empty in-memory byte buffer with a maximum allowed size. It is used so archive creation can fail early if the compressed bundle grows too large.

**Data flow**: It receives the maximum byte count. It creates a `SizeLimitedBuffer` with an empty `Vec<u8>`, which is Rust’s growable byte array, and stores the limit beside it. The result is a buffer ready to receive compressed archive bytes.

**Call relations**: The packing function `pack_plugin_bundle_tar_gz` creates this buffer before starting gzip compression. Later, gzip and tar writing call the buffer’s `write` method, which enforces the limit.

*Call graph*: called by 1 (pack_plugin_bundle_tar_gz); 1 external calls (new).


##### `SizeLimitedBuffer::into_inner`  (lines 270–272)

```
fn into_inner(self) -> Vec<u8>
```

**Purpose**: This returns the finished bytes from a size-limited buffer after archive writing has completed. It is the final step that exposes the packed archive data to the caller.

**Data flow**: It takes ownership of the `SizeLimitedBuffer`, removes the stored byte vector from it, and returns that vector. Nothing else is changed because the buffer is consumed.

**Call relations**: After `pack_plugin_bundle_tar_gz` finishes the tar and gzip writers successfully, it calls this function to get the completed compressed archive bytes.


##### `SizeLimitedBuffer::write`  (lines 276–292)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: This is the actual size-checking write operation for the in-memory archive buffer. It behaves like a normal writer until the next write would go over the allowed limit, then it refuses the write with a special error.

**Data flow**: It receives a slice of bytes to append. It calculates what the buffer length would become, including a check for arithmetic overflow. If the new length would exceed the maximum, it returns an error containing `ArchiveSizeLimitExceeded`. If the write fits, it appends the bytes and reports that all input bytes were written.

**Call relations**: Gzip compression writes into this method during `pack_plugin_bundle_tar_gz`. If it returns the size-limit error, `archive_io_error` later recognizes that marker and turns it into `PluginBundlePackError::ArchiveTooLarge`.

*Call graph*: 1 external calls (other).


##### `SizeLimitedBuffer::flush`  (lines 294–296)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: This completes the writer interface for `SizeLimitedBuffer`. Because the buffer is only memory, there is nothing to push out to disk or the network.

**Data flow**: It receives the buffer by mutable reference and does not change it. It simply returns success, meaning there is no pending external output to flush.

**Call relations**: Compression and archive-writing code may call this because they work with the standard `Write` interface. It lets `SizeLimitedBuffer` be used anywhere a normal writer is expected.


##### `ArchiveSizeLimitExceeded::fmt`  (lines 306–312)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This formats the size-limit marker as a human-readable message. It explains how large the archive would have become and what the configured maximum was.

**Data flow**: It receives the error object and a formatter. It writes a sentence containing the attempted byte count and the maximum byte count into that formatter. The result is formatted text for logs, error chains, or debugging output.

**Call relations**: This supports the custom error type used by `SizeLimitedBuffer::write`. When that marker is displayed directly or included inside a larger input/output error, this function provides the readable message.

*Call graph*: 1 external calls (write!).


### `core-plugins/src/marketplace_add/install.rs`

`io_transport` · `request handling during marketplace add/install`

When a user adds a marketplace, the system needs to fetch code from Git and put it in the right local folder without accidentally writing somewhere unsafe. This file is the toolbox for that job. It is like a careful delivery process: first choose a safe package label, then unpack into a staging area, then verify the final address is allowed, and finally move the package into place.

The Git work is done by `clone_git_source`. It can either clone a whole repository, or do a sparse checkout, which means downloading only selected paths from the repository instead of everything. It can also check out a specific branch, tag, or commit-like reference.

The safety helpers protect the filesystem. `safe_marketplace_dir_name` turns a marketplace name into a folder-safe name by replacing risky characters. `ensure_marketplace_destination_is_inside_install_root` resolves real filesystem paths and rejects any destination whose parent folder is outside the install root. This matters because paths can contain tricks like `..` or links that point elsewhere.

The final install step uses a staging folder under the install root, then renames that staged folder into its final destination. Git commands are run through `run_git`, which disables interactive prompts and turns Git failures into clear project errors.

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

**Purpose**: Fetches marketplace files from a Git repository into a destination folder. It supports both normal full clones and sparse checkouts, where only selected paths are checked out.

**Data flow**: It receives a Git URL, an optional reference name such as a branch or tag, a list of sparse paths, and a destination path. If no sparse paths are given, it runs `git clone` and optionally checks out the requested reference inside the new folder. If sparse paths are given, it performs a no-checkout clone, configures sparse checkout for those paths, then checks out the requested reference or `HEAD`. It returns success when all Git steps work, or a marketplace add error when Git fails.

**Call relations**: This is the higher-level Git cloning helper. It delegates each actual Git command to `run_git`, so the details of starting the `git` program and interpreting failures stay in one place.

*Call graph*: calls 1 internal fn (run_git); 3 external calls (new, to_string_lossy, vec!).


##### `safe_marketplace_dir_name`  (lines 45–65)

```
fn safe_marketplace_dir_name(
    marketplace_name: &str,
) -> Result<String, MarketplaceAddError>
```

**Purpose**: Turns a marketplace name into a safe local folder name. This prevents user-provided names from becoming awkward or dangerous filesystem paths.

**Data flow**: It receives the original marketplace name as text. It keeps letters, numbers, hyphens, underscores, and dots, and replaces other characters with hyphens. Then it removes dots from the beginning and end. If the result is empty or would be `..`, it returns an invalid request error; otherwise it returns the cleaned folder name.

**Call relations**: `add_marketplace_sync_with_cloner` calls this before choosing where the marketplace will be installed. The cleaned name becomes part of the later destination path used by the install flow.

*Call graph*: called by 1 (add_marketplace_sync_with_cloner); 2 external calls (InvalidRequest, format!).


##### `ensure_marketplace_destination_is_inside_install_root`  (lines 67–97)

```
fn ensure_marketplace_destination_is_inside_install_root(
    install_root: &Path,
    destination: &Path,
) -> Result<(), MarketplaceAddError>
```

**Purpose**: Checks that the marketplace destination really sits inside the approved install root. This is a guardrail against writing marketplace files somewhere else on the machine.

**Data flow**: It receives the install root and the intended marketplace destination. It resolves the install root to its real filesystem path, finds and resolves the destination's parent folder, then checks whether that parent starts with the install root path. If not, it returns an invalid request error; otherwise it returns success without changing anything.

**Call relations**: `add_marketplace_sync_with_cloner` calls this before replacing the installed marketplace folder. It protects the later filesystem move performed by `replace_marketplace_root`.

*Call graph*: called by 1 (add_marketplace_sync_with_cloner); 4 external calls (canonicalize, parent, InvalidRequest, format!).


##### `replace_marketplace_root`  (lines 99–107)

```
fn replace_marketplace_root(
    staged_root: &Path,
    destination: &Path,
) -> std::io::Result<()>
```

**Purpose**: Moves a fully prepared staged marketplace folder into its final installation location. This is the final handoff from temporary staging to the live install directory.

**Data flow**: It receives the path to the staged folder and the final destination path. If the destination has a parent folder, it creates that parent folder and any missing ancestors. Then it renames the staged folder to the destination. It returns a standard input/output result showing whether the filesystem operations succeeded.

**Call relations**: `add_marketplace_sync_with_cloner` calls this after staging and validation are complete. It relies on earlier checks, especially `ensure_marketplace_destination_is_inside_install_root`, to make sure the destination is safe.

*Call graph*: called by 1 (add_marketplace_sync_with_cloner); 3 external calls (parent, create_dir_all, rename).


##### `marketplace_staging_root`  (lines 109–111)

```
fn marketplace_staging_root(install_root: &Path) -> PathBuf
```

**Purpose**: Builds the path for the staging area used while installing marketplaces. Staging lets the system prepare files before making them the active marketplace install.

**Data flow**: It receives the marketplace install root path. It appends `.staging` to that path and returns the resulting path.

**Call relations**: `add_marketplace_sync_with_cloner` calls this while setting up the install process. The returned staging root is where the marketplace can be cloned or prepared before `replace_marketplace_root` moves it into place.

*Call graph*: called by 1 (add_marketplace_sync_with_cloner); 1 external calls (join).


##### `run_git`  (lines 113–137)

```
fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<(), MarketplaceAddError>
```

**Purpose**: Runs one Git command and turns its result into the marketplace add error type used by this feature. It also prevents Git from stopping to ask the user questions in the terminal.

**Data flow**: It receives Git command arguments and an optional working directory. It starts the `git` program with those arguments, sets `GIT_TERMINAL_PROMPT=0` so Git will not wait for interactive input, and runs it in the given directory if one is provided. If Git exits successfully, it returns success. If starting Git fails or Git exits with an error, it returns an internal error that includes the command, exit status, and trimmed standard output and error text.

**Call relations**: `clone_git_source` calls this for every Git operation: cloning, setting sparse checkout paths, and checking out a reference. Keeping Git execution here gives the clone logic a simple yes-or-error result while preserving useful failure messages.

*Call graph*: called by 1 (clone_git_source); 4 external calls (from_utf8_lossy, new, Internal, format!).


### `core-plugins/src/marketplace_upgrade/activation.rs`

`domain_logic` · `marketplace upgrade activation`

This file is about making marketplace upgrades safe. A marketplace here is a set of plugin content pulled from a Git source, and an upgrade is first prepared in a temporary staging folder. This file then moves that staged folder into the real install location. If something is already installed there, it first moves the old version aside as a backup, like taking a photo before rearranging a room. If the new version cannot be moved into place, or if a follow-up step fails, it tries to restore the old version so the user is not left with a broken marketplace.

The file also writes a hidden JSON file named `.codex-marketplace-install.json` inside the installed marketplace. That file records where the marketplace came from, which Git reference was used, which sparse paths were selected, and the exact revision installed. Later, the upgrade code can read this file and compare it with the desired marketplace. If everything matches, it can avoid doing unnecessary work.

The important behavior is its rollback logic. Activation is not just a simple folder rename. It carefully creates parent folders, backs up existing installs, moves the new folder into place, runs a caller-provided final step, and cleans up or restores if that final step fails.

#### Function details

##### `installed_marketplace_metadata_matches`  (lines 22–43)

```
fn installed_marketplace_metadata_matches(
    root: &Path,
    marketplace: &ConfiguredGitMarketplace,
    revision: &str,
) -> bool
```

**Purpose**: Checks whether an installed marketplace already matches the requested Git marketplace and revision. This is used to decide whether an upgrade can be skipped because the right content is already active.

**Data flow**: It takes the installed marketplace root folder, the desired marketplace configuration, and the expected revision. It reads the hidden metadata JSON file from that root, parses it, builds the metadata that would be expected for the requested marketplace, and compares the two. It returns `true` only when the file exists, can be understood, and exactly matches; otherwise it returns `false` and logs a warning if the JSON was malformed.

**Call relations**: During `upgrade_configured_git_marketplace`, the upgrader calls this before doing heavier work. This function asks `installed_marketplace_metadata_path` where the marker file should be and uses `installed_marketplace_metadata` to build the expected record for comparison.

*Call graph*: calls 2 internal fn (installed_marketplace_metadata, installed_marketplace_metadata_path); called by 1 (upgrade_configured_git_marketplace); 2 external calls (read_to_string, warn!).


##### `write_installed_marketplace_metadata`  (lines 45–55)

```
fn write_installed_marketplace_metadata(
    root: &Path,
    marketplace: &ConfiguredGitMarketplace,
    revision: &str,
) -> Result<(), String>
```

**Purpose**: Writes the hidden metadata file that describes what marketplace was just installed. This gives future upgrade runs a reliable receipt of what is currently active.

**Data flow**: It receives the marketplace root folder, the marketplace configuration, and the installed revision. It turns those into an `InstalledMarketplaceMetadata` value, converts that value into neatly formatted JSON, and writes it to `.codex-marketplace-install.json` inside the root. On success it returns nothing; on failure it returns a readable error message.

**Call relations**: After `upgrade_configured_git_marketplace` has prepared or activated a marketplace, it calls this to leave behind the install record. This function relies on `installed_marketplace_metadata` to assemble the record and `installed_marketplace_metadata_path` to choose the exact file path.

*Call graph*: calls 2 internal fn (installed_marketplace_metadata, installed_marketplace_metadata_path); called by 1 (upgrade_configured_git_marketplace); 2 external calls (to_string_pretty, write).


##### `activate_marketplace_root`  (lines 57–150)

```
fn activate_marketplace_root(
    destination: &Path,
    staged_dir: TempDir,
    after_activate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String>
```

**Purpose**: Moves a staged marketplace folder into its final install location, while trying hard not to destroy the previous installation if anything goes wrong. It is the safety-critical step of marketplace activation.

**Data flow**: It receives the final destination path, a temporary staged directory, and a callback to run after the new folder is in place. First it finds or creates the destination's parent folder. If an old marketplace already exists, it moves that old folder into a temporary backup, then renames the staged folder into the destination. If moving the new folder or running the callback fails, it attempts to put the backup back. If no old marketplace exists, it simply moves the staged folder into place, and removes it again if the callback fails. It returns success only when activation and the after-activation step both succeed.

**Call relations**: `upgrade_configured_git_marketplace` calls this when the new marketplace content has already been prepared elsewhere. The caller supplies `after_activate` for final work that must happen only after the new root is visible, such as writing metadata. This function does the filesystem switching and rollback around that caller-provided step.

*Call graph*: called by 1 (upgrade_configured_git_marketplace); 8 external calls (exists, parent, path, format!, create_dir_all, remove_dir_all, rename, new).


##### `installed_marketplace_metadata`  (lines 152–163)

```
fn installed_marketplace_metadata(
    marketplace: &ConfiguredGitMarketplace,
    revision: &str,
) -> InstalledMarketplaceMetadata
```

**Purpose**: Builds the metadata record that represents a particular configured Git marketplace at a particular revision. It is the shared definition of what the install receipt should contain.

**Data flow**: It takes the configured marketplace and revision string. It copies the source URL or path, optional Git reference name, sparse path list, and revision into an `InstalledMarketplaceMetadata` structure, and marks the source type as Git. The result is an in-memory record ready to compare or write to disk.

**Call relations**: Both metadata comparison and metadata writing call this helper so they use the same exact shape and values. That keeps `installed_marketplace_metadata_matches` and `write_installed_marketplace_metadata` from drifting apart.

*Call graph*: called by 2 (installed_marketplace_metadata_matches, write_installed_marketplace_metadata).


##### `installed_marketplace_metadata_path`  (lines 165–167)

```
fn installed_marketplace_metadata_path(root: &Path) -> PathBuf
```

**Purpose**: Returns the path to the hidden metadata file inside an installed marketplace root. It keeps the filename choice in one place.

**Data flow**: It receives a marketplace root folder path and appends `.codex-marketplace-install.json` to it. The output is the full path that should be read from or written to.

**Call relations**: `installed_marketplace_metadata_matches` uses this path before reading the install receipt, and `write_installed_marketplace_metadata` uses it before writing the receipt. This small helper ensures both operations look at the same file.

*Call graph*: called by 2 (installed_marketplace_metadata_matches, write_installed_marketplace_metadata); 1 external calls (join).


### Execution and process support
This set provides the shared execution utility layer, process abstractions, output buffering, sandbox exec helpers, and exit-status translation used when launching and supervising commands.

### `core/src/tools/mod.rs`

`util` · `cross-cutting during tool setup and command-result reporting`

Tools are the actions the system can ask for, such as running a shell command or checking network access. This file acts like the table of contents for that tool area, making many tool modules available from one place. It also contains small but important shared helpers.

One helper turns a structured tool name into an older, single-string form. Newer code can keep a tool name split into parts, such as an optional namespace plus a name, but some older boundaries still expect one flat string. Another helper translates the user’s shell type, such as Bash or PowerShell, into the matching type used by the tool layer.

The other main job is preparing command output. Raw command results can include an exit code, running time, standard output, error text, and possibly thousands of lines. Before sending that back to the model, this file adds useful context like “Exit code” and “Wall time,” includes a timeout warning when needed, and truncates very large output according to a chosen policy. Think of it like a report formatter: it takes a messy receipt from a command run and turns it into a compact, readable summary.

#### Function details

##### `flat_tool_name`  (lines 36–46)

```
fn flat_tool_name(tool_name: &ToolName) -> Cow<'_, str>
```

**Purpose**: Turns a structured tool name into the older single-string form required by legacy places such as telemetry labels, hook payloads, and response tool names. It preserves the newer structured name for normal use, but creates a flat version only when crossing those older boundaries.

**Data flow**: It receives a ToolName, which has a main name and may have a namespace. If there is a namespace, it joins the namespace and name into a newly built string. If there is no namespace, it simply borrows the existing name text without copying it. The result is text that callers can pass to older systems that only understand one string.

**Call relations**: This helper is called when tool names leave the newer tool system and enter older interfaces. Metric emission, approval requests, tool dispatch, hook naming, and network approval setup all call on it when they need the flat spelling of a tool name.

*Call graph*: called by 7 (emit_metric_for_tool_read, request_approval, run, dispatch_any_with_terminal_outcome, function_hook_tool_name, network_approval_spec, network_approval_spec); 3 external calls (Borrowed, Owned, with_capacity).


##### `tool_user_shell_type`  (lines 48–58)

```
fn tool_user_shell_type(
    user_shell: &crate::shell::Shell,
) -> codex_tools::ToolUserShellType
```

**Purpose**: Converts the project’s internal idea of the user’s shell into the equivalent shell type used by the tool library. This keeps different parts of the code speaking the same language about whether the user is using Bash, Zsh, PowerShell, Sh, or Cmd.

**Data flow**: It receives a Shell value from the core shell module. It reads the shell_type field and matches it to the corresponding codex_tools ToolUserShellType value. Nothing is changed; the function only returns the translated shell type.

**Call relations**: This is used while preparing contexts that need to know the user’s shell. The review-thread setup and turn-context creation call it so the tool layer receives shell information in the form it expects.

*Call graph*: called by 2 (spawn_review_thread, make_turn_context).


##### `format_exec_output_for_model`  (lines 62–87)

```
fn format_exec_output_for_model(
    exec_output: &ExecToolCallOutput,
    truncation_policy: TruncationPolicy,
) -> String
```

**Purpose**: Builds a readable command-result report for the model. It includes the exit code, wall-clock running time, optional total line count, and safely shortened command output.

**Data flow**: It receives an ExecToolCallOutput, which contains the command’s result, duration, timeout flag, and collected text, plus a truncation policy that says how much output is allowed. It first builds the output text, adding a timeout warning if needed. It counts the original lines, truncates the text for safe model use, then assembles a final multi-line report. The returned string is ready to send to the model.

**Call relations**: This function relies on build_content_with_timeout to create the body text and on the shared truncation utility to keep that body within limits. It is the fuller formatter in this file, meant for model-facing output that should include metadata as well as the command text.

*Call graph*: calls 1 internal fn (build_content_with_timeout); 3 external calls (new, truncate_text, format!).


##### `format_exec_output_str`  (lines 89–97)

```
fn format_exec_output_str(
    exec_output: &ExecToolCallOutput,
    truncation_policy: TruncationPolicy,
) -> String
```

**Purpose**: Produces a compact, truncated version of command output text. It is useful in places that need the command’s content, including timeout text when relevant, but not the full exit-code and wall-time report.

**Data flow**: It receives an ExecToolCallOutput and a truncation policy. It asks build_content_with_timeout for the command text, including a timeout message if the command exceeded its limit. Then it applies formatted truncation and returns the shortened string.

**Call relations**: This helper is used by code that displays or embeds shell-command output in smaller contexts, such as user shell command execution and command fragments. It shares the same timeout-body builder as format_exec_output_for_model, so both output styles treat timeouts consistently.

*Call graph*: calls 1 internal fn (build_content_with_timeout); called by 3 (includes_timed_out_message, execute_user_shell_command, user_shell_command_fragment); 1 external calls (formatted_truncate_text).


##### `build_content_with_timeout`  (lines 100–110)

```
fn build_content_with_timeout(exec_output: &ExecToolCallOutput) -> String
```

**Purpose**: Creates the raw command-output body and adds a clear timeout warning when the command ran too long. This keeps timeout wording consistent for all command-output formatters in this file.

**Data flow**: It receives an ExecToolCallOutput. If the timed_out flag is true, it creates text that starts with “command timed out after ... milliseconds” and then appends the captured command output. If the command did not time out, it returns a copy of the captured output text unchanged.

**Call relations**: This is the shared first step for both command-output formatters. format_exec_output_for_model uses it before adding metadata like exit code and wall time, while format_exec_output_str uses it before returning a shorter content-only string.

*Call graph*: called by 2 (format_exec_output_for_model, format_exec_output_str); 1 external calls (format!).


### `core/src/unified_exec/head_tail_buffer.rs`

`domain_logic` · `during command execution output capture`

When a command prints a lot of text, keeping all of it can waste memory or make error reports huge. This file solves that by using a “head and tail” buffer: it preserves the first part of the output, preserves the most recent part, and counts how much was skipped in between. The idea is like saving the first page and last page of a very long receipt, because those are often the most useful parts.

The buffer splits its allowed space in half. The “head” half is filled first and then never changed. After that, new bytes go into the “tail” half. If the tail grows too large, the oldest bytes in the tail are removed so the newest ending stays available. This is useful for command execution because the start of output may show setup information, while the end often contains the actual failure message.

The file also provides ways to look at the retained bytes without changing the buffer, combine them into one byte list, or drain and reset the buffer. It tracks dropped bytes separately, so tests or callers can tell that some output was omitted even though the retained snapshot only contains the saved beginning and ending.

#### Function details

##### `HeadTailBuffer::default`  (lines 21–23)

```
fn default() -> Self
```

**Purpose**: Creates a buffer using the project’s standard maximum output size. This is the convenient choice when callers do not need a custom limit.

**Data flow**: It starts with no caller-provided size, reads the shared default byte limit for unified command output, and passes that limit into the normal constructor. The result is a fresh empty buffer with the standard head and tail budgets.

**Call relations**: This is the path used by higher-level command execution code, such as when running a command or preparing fallback output for a failed unstored process. Tests also use it to confirm that the default setting still keeps both the beginning and the end.

*Call graph*: called by 5 (head_tail_buffer_default_preserves_prefix_and_suffix, push_chunk_preserves_prefix_and_suffix, new, exec_command, failed_initial_end_for_unstored_process_uses_fallback_output); 1 external calls (new).


##### `HeadTailBuffer::new`  (lines 31–44)

```
fn new(max_bytes: usize) -> Self
```

**Purpose**: Builds a new empty head-and-tail buffer with a caller-chosen maximum size. Use this when code or tests need to control exactly how many bytes can be retained.

**Data flow**: It receives a maximum byte count, divides that space into a head budget and a tail budget, creates two empty queues for saved chunks, and sets all byte counters to zero. The returned buffer is ready to accept output chunks.

**Call relations**: The default constructor uses this same setup path with the project-wide limit. Tests call it directly with small limits to check edge cases, such as a zero-byte limit, a one-byte tail, or a chunk larger than the whole tail budget.

*Call graph*: called by 6 (chunk_larger_than_tail_budget_keeps_only_tail_end, draining_resets_state, fills_head_then_tail_across_multiple_chunks, head_budget_zero_keeps_only_last_byte_in_tail, keeps_prefix_and_suffix_when_over_budget, max_bytes_zero_drops_everything); 1 external calls (new).


##### `HeadTailBuffer::retained_bytes`  (lines 49–51)

```
fn retained_bytes(&self) -> usize
```

**Purpose**: Reports how many bytes are currently saved in the buffer. It counts only the kept head and tail bytes, not the bytes that were dropped.

**Data flow**: It reads the stored head byte count and tail byte count, adds them safely, and returns the total. It does not change the buffer.

**Call relations**: The byte-flattening function uses this value to reserve enough space before copying data into one continuous byte list. That makes conversion more direct because the destination size is known up front.

*Call graph*: called by 1 (to_bytes).


##### `HeadTailBuffer::omitted_bytes`  (lines 56–58)

```
fn omitted_bytes(&self) -> usize
```

**Purpose**: Reports how many bytes have been dropped because the buffer hit its size cap. This is mainly useful for checking or explaining that the saved output is incomplete.

**Data flow**: It reads the internal omitted-byte counter and returns it unchanged. No saved output is added, removed, or rearranged.

**Call relations**: This is an observer method. It does not drive the buffering process, but tests and diagnostic code can use it to confirm that middle content was dropped when expected.


##### `HeadTailBuffer::push_chunk`  (lines 65–91)

```
fn push_chunk(&mut self, chunk: Vec<u8>)
```

**Purpose**: Adds a new piece of output to the buffer while respecting the maximum size. It decides whether the bytes belong in the preserved beginning or the rolling ending.

**Data flow**: It receives a vector of bytes. If the buffer has no capacity, all bytes are counted as omitted. If the head still has room, the chunk fills that space first; if the chunk is too large, it is split so the first part goes to the head and the rest goes to the tail. Once the head is full, the whole chunk goes to the tail, where older tail bytes may be dropped.

**Call relations**: This is the main entry point for feeding command output into the buffer. When it needs tail behavior, it hands bytes to the private tail helper, which is responsible for keeping only the newest tail-sized ending.

*Call graph*: calls 1 internal fn (push_to_tail); 1 external calls (push_back).


##### `HeadTailBuffer::snapshot_chunks`  (lines 97–102)

```
fn snapshot_chunks(&self) -> Vec<Vec<u8>>
```

**Purpose**: Returns a copy of the currently retained output as separate chunks. This is useful when a caller wants the saved pieces without merging them into one large byte array.

**Data flow**: It reads the head queue and tail queue, clones each stored chunk, places head chunks first and tail chunks after them, and returns that list. The buffer itself remains unchanged, and omitted bytes are not included.

**Call relations**: This function is a read-only view of the buffer’s current contents. It sits after output has been pushed in, giving callers a chunk-by-chunk snapshot without draining or resetting anything.

*Call graph*: 2 external calls (new, iter).


##### `HeadTailBuffer::to_bytes`  (lines 108–117)

```
fn to_bytes(&self) -> Vec<u8>
```

**Purpose**: Returns the retained output as one continuous byte vector. Use this when the saved output needs to be displayed, stored, or passed along as a single byte sequence.

**Data flow**: It first asks how many bytes are retained so it can create an output vector of the right size. Then it copies every head chunk followed by every tail chunk into that vector. The returned bytes contain only the saved beginning and ending; any dropped middle bytes are absent.

**Call relations**: This is a read-only conversion step after chunks have been collected. It relies on the retained-byte counter for efficient allocation, then walks through the saved head and tail chunks in their final output order.

*Call graph*: calls 1 internal fn (retained_bytes); 2 external calls (with_capacity, iter).


##### `HeadTailBuffer::drain_chunks`  (lines 123–130)

```
fn drain_chunks(&mut self) -> Vec<Vec<u8>>
```

**Purpose**: Removes all retained chunks and returns them in output order. This is useful when the caller is done collecting output and wants to take ownership of the saved data while clearing the buffer for reuse.

**Data flow**: It pulls all chunks out of the head queue, then all chunks out of the tail queue, and returns them as one list. Afterward it resets the head byte count, tail byte count, and omitted-byte count to zero.

**Call relations**: This is the cleanup or handoff path for retained output. Unlike snapshotting, it empties the buffer, so later pushes start again from a clean state.

*Call graph*: 1 external calls (drain).


##### `HeadTailBuffer::push_to_tail`  (lines 132–157)

```
fn push_to_tail(&mut self, chunk: Vec<u8>)
```

**Purpose**: Adds bytes to the rolling tail section, keeping only the newest bytes that fit in the tail budget. This helper protects the buffer from growing after the head is full.

**Data flow**: It receives a byte chunk meant for the tail. If the tail has no space, the whole chunk is counted as omitted. If the chunk alone is larger than the tail budget, it keeps only the last allowed bytes and drops everything older, including the previous tail. Otherwise it appends the chunk and then trims any excess from the old front of the tail.

**Call relations**: The main push function calls this whenever incoming output no longer belongs in the fixed head. If appending a normal-sized chunk makes the tail too big, this helper passes control to the trimming helper to remove the oldest tail bytes.

*Call graph*: calls 1 internal fn (trim_tail_to_budget); called by 1 (push_chunk); 2 external calls (clear, push_back).


##### `HeadTailBuffer::trim_tail_to_budget`  (lines 159–178)

```
fn trim_tail_to_budget(&mut self)
```

**Purpose**: Shrinks the tail back down to its allowed size by removing the oldest tail bytes first. This is what makes the tail represent the latest ending of the output.

**Data flow**: It compares the current tail size with the tail budget. While there are too many bytes, it looks at the oldest stored tail chunk. It either removes that whole chunk or cuts bytes from its front, updates the retained and omitted byte counters, and stops once the tail fits.

**Call relations**: This private helper is called only after tail bytes have been appended and the tail may be too large. It completes the rolling-window behavior that lets the buffer keep the newest output while discarding the middle.

*Call graph*: called by 1 (push_to_tail); 2 external calls (front_mut, pop_front).


### `execpolicy/src/executable_name.rs`

`util` · `cross-cutting during executable policy matching`

This file solves a small but important matching problem: executable names are not always written the same way on every operating system. On Windows, users often type or see programs with suffixes such as `.exe`, `.cmd`, `.bat`, or `.com`, and Windows is not picky about upper- versus lower-case names. If policy rules compared these names exactly as written, `Git.EXE`, `git.exe`, and `git` might look like different programs even though they should match the same rule.

The file provides two helper functions. One takes a raw executable name and turns it into the form used for lookups. On Windows, it lowercases the name and removes a known executable suffix if present. On non-Windows systems, it leaves the name alone, because case and file endings are usually meaningful there. The other helper starts with a full filesystem path, pulls out only the final file name, and then applies the same lookup-key conversion.

An everyday analogy is checking names on a guest list: before comparing, you might ignore capitalization and remove titles like “Mr.” so the same person is not missed. Without this normalization, executable policy matching could be inconsistent across platforms, especially on Windows.

#### Function details

##### `executable_lookup_key`  (lines 6–23)

```
fn executable_lookup_key(raw: &str) -> String
```

**Purpose**: This function converts a program name into the standard form used for policy lookups. On Windows it makes the name lowercase and removes common executable endings; on other systems it keeps the name exactly as given.

**Data flow**: It receives a text name such as `Git.EXE` or `python`. On Windows, it first lowercases the text, then checks whether it ends in one of the known Windows executable suffixes and removes that suffix if found. On non-Windows systems, it simply copies the input into a new string. The result is the lookup key that policy code can compare against rules.

**Call relations**: This is the basic normalizing step used when an executable name needs to be compared in a platform-aware way. `executable_path_lookup_key` feeds it the file-name part of a path so paths and plain names are treated consistently.


##### `executable_path_lookup_key`  (lines 25–29)

```
fn executable_path_lookup_key(path: &Path) -> Option<String>
```

**Purpose**: This function creates a policy lookup key from a full filesystem path. It ignores the directory parts and uses only the executable file name, because rules usually care about the program being run, not every folder in its path.

**Data flow**: It receives a filesystem path. It asks the path for its final file-name piece, then tries to read that piece as normal text. If either step fails, it returns no key. If it gets a usable name, it passes that name to `executable_lookup_key` and returns the normalized key.

**Call relations**: When `match_host_executable_rules` needs to decide whether a host executable matches configured rules, it calls this function to turn the executable path into the same kind of key used by the rules. This function relies on the standard path `file_name` operation to isolate the last path component, then hands that name to `executable_lookup_key` for platform-specific cleanup.

*Call graph*: called by 1 (match_host_executable_rules); 1 external calls (file_name).


### `linux-sandbox/src/exec_util.rs`

`util` · `process launch and sandbox setup`

Starting a program on Linux is not just a matter of passing a Rust list of strings to a function. The low-level operating system call expects C-style strings, which are bytes ending in a special zero byte. It also treats open files carefully: many file descriptors are marked “close on exec,” meaning they are automatically closed when the current process becomes a new program. This is usually a safety feature, but it is a problem when the sandbox deliberately needs to pass certain already-open files into the new process.

This file solves those two practical problems. First, it turns normal Rust command arguments into `CString` values, the form expected by C and Linux system calls. If an argument contains an embedded zero byte, it cannot be represented safely as a C string, so the helper stops immediately with a clear error.

Second, it makes selected files inheritable by clearing the `FD_CLOEXEC` flag. A file descriptor is like a numbered ticket for an open file; `FD_CLOEXEC` says “throw this ticket away when launching the next program.” Clearing it says “keep this ticket and give it to the new program too.” This is important for launching tools such as bubblewrap, where some files must survive across the program handoff.

#### Function details

##### `argv_to_cstrings`  (lines 5–14)

```
fn argv_to_cstrings(argv: &[String]) -> Vec<CString>
```

**Purpose**: Converts a list of Rust command-line argument strings into C-compatible strings. This is needed because the Linux execution layer expects arguments in the older C string format, not Rust’s safer string type.

**Data flow**: It receives a slice of `String` values. It walks through each argument, tries to turn it into a `CString`, and collects the successful conversions into a new vector. The result is a vector ready to be passed toward a low-level program-launch call; if any argument cannot be represented as a C string, the function stops with an error instead of producing unsafe data.

**Call relations**: When the higher-level launch routines `exec` and `exec_system_bwrap` are ready to start a program, they call this helper to translate their argument list into the form the operating system expects. This function does only the conversion step and hands the prepared strings back to those launch routines.

*Call graph*: called by 2 (exec, exec_system_bwrap); 3 external calls (new, with_capacity, panic!).


##### `make_files_inheritable`  (lines 16–20)

```
fn make_files_inheritable(files: &[File])
```

**Purpose**: Makes a chosen set of open files survive when the current process starts another program. This is used when the sandbox launcher intentionally needs to pass specific files into the next program.

**Data flow**: It receives a slice of open `File` objects. For each file, it takes the underlying Linux file descriptor number and asks `clear_cloexec` to remove the flag that would otherwise close that descriptor during program launch. It returns no value, but it changes the operating-system state of those file descriptors.

**Call relations**: The launch paths `exec` and `exec_system_bwrap` call this before handing control to another executable, so the selected files are still open afterward. The test `tests::preserved_files_are_made_inheritable` also calls it to prove that it clears the expected flag. This function is the public helper; it delegates the low-level flag editing to `clear_cloexec`.

*Call graph*: calls 1 internal fn (clear_cloexec); called by 3 (exec, preserved_files_are_made_inheritable, exec_system_bwrap).


##### `clear_cloexec`  (lines 22–40)

```
fn clear_cloexec(fd: libc::c_int)
```

**Purpose**: Clears the Linux `close-on-exec` flag from one file descriptor. In plain terms, it changes one open-file ticket from “discard on program launch” to “keep for the launched program.”

**Data flow**: It receives a raw file descriptor number. It asks the operating system for the descriptor’s current flags, removes only the `FD_CLOEXEC` bit, and writes the updated flags back if anything changed. It returns nothing; on failure to read or update the flags, it stops with an error message based on the last operating-system error.

**Call relations**: This is called only by `make_files_inheritable`, which loops over the files that need to be preserved. `clear_cloexec` is the small low-level worker that talks directly to Linux through `fcntl`, while its caller decides which descriptors need that treatment.

*Call graph*: called by 1 (make_files_inheritable); 3 external calls (last_os_error, fcntl, panic!).


##### `tests::preserved_files_are_made_inheritable`  (lines 49–56)

```
fn preserved_files_are_made_inheritable()
```

**Purpose**: Checks that `make_files_inheritable` really removes the close-on-exec flag from a file. This protects the sandbox-launch behavior from silently breaking.

**Data flow**: The test creates a temporary file, deliberately marks its descriptor as close-on-exec, then passes that file to `make_files_inheritable`. Afterward it reads the descriptor flags and asserts that the close-on-exec bit is no longer set.

**Call relations**: This test drives the same helper used by the real launch paths. It uses `tests::set_cloexec` to create the starting condition and `tests::fd_flags` to inspect the result, then verifies the behavior with an assertion.

*Call graph*: calls 1 internal fn (make_files_inheritable); 4 external calls (new, assert_eq!, set_cloexec, from_ref).


##### `tests::set_cloexec`  (lines 58–66)

```
fn set_cloexec(fd: libc::c_int)
```

**Purpose**: Sets the close-on-exec flag on a file descriptor during the test. It creates a known starting point so the test can prove that the production helper removes the flag.

**Data flow**: It receives a raw file descriptor number. It reads the current descriptor flags with `tests::fd_flags`, adds the `FD_CLOEXEC` bit, and writes the flags back to the operating system. It returns nothing, but it changes the descriptor’s flag state for the test.

**Call relations**: The test `tests::preserved_files_are_made_inheritable` calls this before calling the production function. It prepares the file descriptor so the test is meaningful: without first setting the flag, there would be nothing to clear.

*Call graph*: 4 external calls (last_os_error, fcntl, fd_flags, panic!).


##### `tests::fd_flags`  (lines 68–76)

```
fn fd_flags(fd: libc::c_int) -> libc::c_int
```

**Purpose**: Reads the current Linux flags for a file descriptor during tests. It is a small inspection tool used to check whether the close-on-exec bit is present.

**Data flow**: It receives a raw file descriptor number, asks the operating system for that descriptor’s flags, and returns the flag value as an integer. If the operating system reports an error, it stops the test with a clear failure message.

**Call relations**: This helper supports the test-only flow. `tests::set_cloexec` calls it before changing flags, and `tests::preserved_files_are_made_inheritable` uses it afterward to confirm that `make_files_inheritable` produced the expected state.

*Call graph*: 3 external calls (last_os_error, fcntl, panic!).


### `utils/pty/src/process.rs`

`orchestration` · `active while an interactive process session is running; also during shutdown cleanup`

An interactive command is more than just a program that starts and stops. The system needs a way to feed it bytes, collect its output, resize its terminal window, send stop signals, and clean up helper tasks when it is done. This file provides that shared machinery.

The main idea is `ProcessHandle`, which is like the remote control for a running process. It keeps the channel used to write to the child’s standard input, the object that knows how to kill or signal the child, the background tasks that copy input and output, and the saved exit code. It also deliberately keeps PTY handles alive. That matters because closing the slave side of a PTY can accidentally send Control+C-like behavior to the child.

The file also defines small supporting pieces: `TerminalSize` for rows and columns, `ProcessSignal` for requests such as interrupt, and `PtyHandles` for the terminal endpoints. For unusual backends that do not own a local PTY, `ProcessDriver` and `spawn_from_driver` adapt their channels into the same `SpawnedProcess` shape used by normal PTY or pipe launches.

A key safety theme is cleanup. Dropping a `ProcessHandle` automatically tries to stop the child and abort background tasks, so abandoned sessions do not linger.

#### Function details

##### `unsupported_signal`  (lines 26–33)

```
fn unsupported_signal(signal: ProcessSignal) -> io::Error
```

**Purpose**: Builds a clear error for a process signal that this backend cannot send. It is used when the caller asks for something like an interrupt, but the current kind of process controller has no way to perform it.

**Data flow**: It receives a `ProcessSignal` value. It matches the signal and turns it into an `io::Error` with the kind `Unsupported` and a human-readable message. The result is an error object that callers can return to explain why the request failed.

**Call relations**: Signal implementations call this when they cannot honor a requested signal. In this file, `ClosureTerminator::signal` uses it so driver-backed processes that only provide a kill callback can still report unsupported interrupt requests honestly.

*Call graph*: called by 3 (signal, signal, signal); 1 external calls (new).


##### `exit_code_from_status`  (lines 35–49)

```
fn exit_code_from_status(status: ExitStatus) -> i32
```

**Purpose**: Converts the operating system’s process exit information into a single integer exit code. This gives the rest of the program one simple value to work with.

**Data flow**: It receives an `ExitStatus` from a finished child process. If the process exited normally, it returns that normal code. On Unix, if the process was ended by a signal, it returns `128 + signal number`, which is a common shell convention. If no useful value is available, it returns `-1`.

**Call relations**: Process-spawning code calls this after waiting for a child process to finish. It bridges low-level operating system status details into the exit code stored and reported by the higher-level process session.

*Call graph*: called by 1 (spawn_process_with_stdin_mode); 2 external calls (code, signal).


##### `TerminalSize::default`  (lines 64–66)

```
fn default() -> Self
```

**Purpose**: Provides the usual starting terminal size when no explicit size is given. The default is 24 rows by 80 columns, a long-standing conventional terminal shape.

**Data flow**: It takes no input. It creates and returns a `TerminalSize` with `rows` set to 24 and `cols` set to 80. It does not change any existing state.

**Call relations**: Session-starting code and tests call this when they need a sensible PTY size without caring about exact dimensions. It keeps callers from repeating the same fallback values in many places.

*Call graph*: called by 8 (open_session_with_exec_env, start_process, pipe_and_pty_share_interface, pty_preserving_inherited_fds_keeps_python_repl_running, pty_python_repl_emits_output_and_exits, pty_spawn_can_preserve_inherited_fds, pty_spawn_with_inherited_fds_reports_exec_failures, pty_terminate_kills_background_children_in_same_process_group).


##### `PtySize::from`  (lines 70–77)

```
fn from(value: TerminalSize) -> Self
```

**Purpose**: Converts this project’s simple terminal size type into the size type expected by the `portable_pty` library. This lets the project talk in rows and columns while the library receives its own full structure.

**Data flow**: It receives a `TerminalSize` containing rows and columns. It copies those values into a `PtySize` and sets pixel dimensions to zero, meaning pixel-level sizing is not being used. It returns the converted `PtySize`.

**Call relations**: The resize path uses this conversion before calling the PTY library’s resize operation. It is the adapter between the project’s small public type and the external library’s type.


##### `PtyHandles::fmt`  (lines 101–103)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides a safe debug printout for `PtyHandles`. It identifies the value as `PtyHandles` without exposing or trying to print the underlying operating system handles.

**Data flow**: It receives a formatter from Rust’s debug-printing system. It writes a minimal debug structure name into that formatter. It returns whether formatting succeeded.

**Call relations**: Rust’s debugging tools call this when code asks to print `PtyHandles` with debug formatting. Keeping the output minimal avoids noisy or unsafe details from terminal handles.

*Call graph*: 1 external calls (debug_struct).


##### `ProcessHandle::fmt`  (lines 129–131)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Provides a safe debug printout for `ProcessHandle`. It confirms that a process handle exists without dumping channels, locks, task handles, or platform resources.

**Data flow**: It receives a formatter from Rust’s debug-printing system. It writes a minimal `ProcessHandle` debug structure into that formatter. It returns the formatting result.

**Call relations**: Rust’s debug formatting calls this when a `ProcessHandle` is printed. It supports troubleshooting while avoiding deep internal details that are not helpful or may not be printable.

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

**Purpose**: Assembles all the pieces needed to control one running process into a single `ProcessHandle`. Callers use it after a process has been spawned and the input, output, wait, and cleanup tasks have been created.

**Data flow**: It receives the stdin-writing channel, the terminator object, background task handles, shared exit-state storage, optional PTY handles, and an optional resize callback. It wraps the mutable pieces in locks so they can be safely accessed later. It returns a ready-to-use `ProcessHandle`.

**Call relations**: Spawner code calls this at the end of setup. In this file, `spawn_from_driver` uses it to turn a driver-provided backend into the same kind of session handle that normal process spawners produce.

*Call graph*: 1 external calls (new).


##### `ProcessHandle::writer_sender`  (lines 163–173)

```
fn writer_sender(&self) -> mpsc::Sender<Vec<u8>>
```

**Purpose**: Returns a sender that callers can use to write raw bytes to the child process’s input. This is how higher-level code types into the running command.

**Data flow**: It reads the stored writer channel from behind a lock. If the real channel is still available, it clones and returns it. If stdin has already been closed or the lock cannot be taken, it returns a new already-disconnected channel so callers get a harmless sender that will fail when used.

**Call relations**: Code that wants to send input to the process calls this during an active session. It does not itself write bytes; it hands out the pipe that another part of the system can send bytes through.

*Call graph*: 2 external calls (lock, channel).


##### `ProcessHandle::has_exited`  (lines 176–178)

```
fn has_exited(&self) -> bool
```

**Purpose**: Answers whether the child process has finished. This lets callers quickly check the session’s state without waiting for the exit notification channel.

**Data flow**: It reads an atomic boolean, which is a small shared value safe to read from multiple tasks at once. It returns `true` if the wait task has recorded that the child exited, otherwise `false`.

**Call relations**: Any code holding a `ProcessHandle` can call this as a lightweight status check. The value is set by the wait path, such as the wait task created inside `spawn_from_driver`.


##### `ProcessHandle::exit_code`  (lines 181–183)

```
fn exit_code(&self) -> Option<i32>
```

**Purpose**: Returns the child process’s exit code if it has already been recorded. This is useful when code wants the final result but does not want to block waiting.

**Data flow**: It locks the shared exit-code storage. If locking succeeds, it copies out the optional integer stored there. If the code is not known yet, or the lock cannot be taken, it returns `None`.

**Call relations**: Callers use this after or near process completion. The wait task writes the code into this storage once the backend reports that the process has exited.


##### `ProcessHandle::resize`  (lines 186–210)

```
fn resize(&self, size: TerminalSize) -> anyhow::Result<()>
```

**Purpose**: Changes the terminal size seen by the running process. This matters for full-screen programs, shells, and commands that format output based on the window size.

**Data flow**: It receives a `TerminalSize` with new rows and columns. First it looks for local PTY handles and resizes the master side, using either the `portable_pty` resize method or a raw Unix resize call. If there are no local handles, it tries an optional backend-provided resize callback. It returns success or an explanatory error.

**Call relations**: User-interface or session code calls this when the visible terminal area changes. It hands the resize request either to the owned PTY, to `resize_raw_pty` for Unix file descriptors, or to the driver callback for remote or non-standard backends.

*Call graph*: calls 1 internal fn (resize_raw_pty); 3 external calls (lock, anyhow!, into).


##### `ProcessHandle::close_stdin`  (lines 213–217)

```
fn close_stdin(&self)
```

**Purpose**: Closes the input channel to the child process. This is how the session tells the child there will be no more input, similar to pressing end-of-file in a terminal or closing a pipe.

**Data flow**: It locks the stored writer sender and removes it. Dropping that sender allows the writing side to shut down once no other clones remain. It returns nothing.

**Call relations**: Callers use this when they are done sending input but may still want to read output. It affects only the stdin path; it does not kill the process or abort reader tasks.

*Call graph*: 1 external calls (lock).


##### `ProcessHandle::request_terminate`  (lines 221–227)

```
fn request_terminate(&self)
```

**Purpose**: Asks the child process to stop while leaving output-reading tasks alive. This lets callers kill the process but still drain any final output until the streams close.

**Data flow**: It locks the stored terminator, removes it so the kill request is only sent once, and calls its `kill` method. Any kill error is ignored here. It does not abort reader, writer, or wait tasks.

**Call relations**: `ProcessHandle::terminate` calls this as its first step during full cleanup. Code can also call it directly when it wants a gentler shutdown that preserves output collection.

*Call graph*: called by 1 (terminate); 1 external calls (lock).


##### `ProcessHandle::signal`  (lines 229–238)

```
fn signal(&self, signal: ProcessSignal) -> io::Result<()>
```

**Purpose**: Sends a specific signal request, such as an interrupt, to the child process if the backend supports it. A signal is a small operating-system-style message asking a process to react in a certain way.

**Data flow**: It receives a `ProcessSignal`. It locks the stored terminator and, if one is still present, forwards the signal to it. If the terminator is gone or the lock cannot be taken, it treats that as a no-op success. Otherwise it returns the backend’s success or error.

**Call relations**: Higher-level code calls this for actions like sending an interrupt. The actual behavior depends on the concrete `ChildTerminator`; for closure-only terminators, the request flows to `unsupported_signal` and becomes an unsupported-operation error.

*Call graph*: 1 external calls (lock).


##### `ProcessHandle::terminate`  (lines 241–264)

```
fn terminate(&self)
```

**Purpose**: Fully cleans up the process session. It tries to kill the child and stops the helper tasks that were moving data or waiting for exit.

**Data flow**: It first calls `request_terminate` to ask the child to die. Then it takes and aborts the reader task, any extra reader abort handles, the writer task, and the wait task. Each task handle is removed so cleanup is not repeated. It returns nothing.

**Call relations**: This is the main cleanup routine for `ProcessHandle`. It is called automatically by `ProcessHandle::drop`, and callers may also invoke it directly when they want to end the session immediately.

*Call graph*: calls 1 internal fn (request_terminate); called by 1 (drop); 1 external calls (lock).


##### `ProcessHandle::drop`  (lines 268–270)

```
fn drop(&mut self)
```

**Purpose**: Automatically cleans up a process session when its handle is discarded. This prevents abandoned child processes and background tasks from being left behind.

**Data flow**: It receives the mutable `ProcessHandle` during Rust’s automatic destruction step. It calls `terminate`, which kills the process and aborts helper tasks. It returns nothing because destructors do not return values.

**Call relations**: Rust calls this when the last owner of a `ProcessHandle` goes away. It is the safety net that makes cleanup happen even if the caller forgets to call `terminate` explicitly.

*Call graph*: calls 1 internal fn (terminate).


##### `ClosureTerminator::signal`  (lines 279–281)

```
fn signal(&mut self, signal: ProcessSignal) -> io::Result<()>
```

**Purpose**: Reports that this simple terminator cannot send detailed signals. A closure terminator only knows how to run a kill callback, not how to deliver an interrupt or other signal.

**Data flow**: It receives the requested `ProcessSignal`. Instead of changing the process, it passes the signal to `unsupported_signal` and returns that error. No internal state is changed.

**Call relations**: `ProcessHandle::signal` reaches this method when the session was built with `ClosureTerminator`, such as in `spawn_from_driver`. It provides a clear failure path for unsupported signal requests.

*Call graph*: calls 1 internal fn (unsupported_signal).


##### `ClosureTerminator::kill`  (lines 283–288)

```
fn kill(&mut self) -> io::Result<()>
```

**Purpose**: Runs the stored kill callback for a driver-backed process. This lets a custom backend provide its own way to stop the process while still fitting the common `ChildTerminator` interface.

**Data flow**: It looks inside its optional callback. If a callback is present, it calls it. It then returns success. The callback itself performs whatever stopping action the backend supplied.

**Call relations**: `ProcessHandle::request_terminate` calls this through the `ChildTerminator` trait. In sessions created by `spawn_from_driver`, this is how the common process handle tells the custom driver to stop.


##### `resize_raw_pty`  (lines 292–304)

```
fn resize_raw_pty(raw_fd: RawFd, size: TerminalSize) -> anyhow::Result<()>
```

**Purpose**: On Unix systems, resizes a PTY when the code only has a raw file descriptor instead of a higher-level PTY object. A file descriptor is the operating system’s small numeric handle for an open resource.

**Data flow**: It receives a raw PTY file descriptor and a `TerminalSize`. It builds a Unix `winsize` structure and calls `ioctl`, the Unix system call used for device-specific control operations, with the terminal-resize command. It returns success or the operating system error.

**Call relations**: `ProcessHandle::resize` calls this when the stored PTY master is an opaque Unix handle. It is the platform-specific escape hatch for resizing terminal-like resources that cannot be resized through the portable library interface.

*Call graph*: called by 1 (resize); 2 external calls (last_os_error, ioctl).


##### `combine_output_receivers`  (lines 307–339)

```
fn combine_output_receivers(
    mut stdout_rx: mpsc::Receiver<Vec<u8>>,
    mut stderr_rx: mpsc::Receiver<Vec<u8>>,
) -> broadcast::Receiver<Vec<u8>>
```

**Purpose**: Merges separate stdout and stderr byte streams into one broadcast stream. This is useful when a caller wants to see all process output in one place.

**Data flow**: It receives two input channels, one for stdout and one for stderr. It creates a broadcast channel, starts a background task, and forwards each chunk from either input into the shared output channel until both inputs close. It returns a receiver for the combined stream.

**Call relations**: Output-handling code can call this after a process is spawned if it wants one mixed output feed. The spawned task watches both input streams at the same time and sends each arriving chunk onward.

*Call graph*: 3 external calls (channel, select!, spawn).


##### `spawn_from_driver`  (lines 362–456)

```
fn spawn_from_driver(driver: ProcessDriver) -> SpawnedProcess
```

**Purpose**: Adapts a custom process backend into the standard `SpawnedProcess` shape used by the rest of the PTY utility code. This lets non-standard drivers plug into the same input, output, exit, resize, and termination interface.

**Data flow**: It receives a `ProcessDriver` containing stdin, broadcast output receivers, an exit-code receiver, an optional terminator callback, an optional writer task, and an optional resize callback. It creates normal stdout and stderr channels, starts background reader tasks that copy driver output into those channels, starts a wait task that records the exit code, and builds a `ProcessHandle`. It returns a `SpawnedProcess` with the session handle, output receivers, and final exit receiver.

**Call relations**: Driver-backed spawn code calls this after creating its own backend-specific channels. Internally it uses `ProcessHandle::new` and `ClosureTerminator` so the rest of the system can treat the driver-backed process like any other spawned PTY or pipe process.

*Call graph*: 8 external calls (clone, new, new, new, new, new, spawn, channel).


### `windows-sandbox-rs/src/unified_exec/backends/windows_common.rs`

`io_transport` · `session runtime`

This file is the communication bridge between the main program and a Windows sandbox runner process. The runner is separate, so the two sides cannot just call each other directly. Instead, they pass small structured messages through pipes, a bit like sending labeled envelopes through a mail slot.

The file covers the everyday parts of an interactive terminal session. It can finish starting a process from a prepared process driver, optionally closing standard input if the session should not accept typing. It can write outgoing messages to the runner pipe, including typed input and terminal resize events. It can also read incoming messages from the runner pipe and forward output bytes to stdout or stderr listeners, then report the process exit code when the runner finishes.

A Windows-specific detail here is newline handling. Windows terminals often expect carriage-return plus newline, written as CRLF, instead of just newline. The helper for normalizing input carefully adds the missing carriage return without duplicating one that is already present.

The important behavior to know is that pipe failures are turned into visible runner error messages and an exit code of -1. That gives the rest of the system one clear signal when the sandbox runner disappears or sends an error.

#### Function details

##### `finish_driver_spawn`  (lines 20–26)

```
fn finish_driver_spawn(driver: ProcessDriver, stdin_open: bool) -> SpawnedProcess
```

**Purpose**: This function completes the launch of a process from an already prepared process driver. If the caller says standard input should not remain open, it closes input right after spawning so the child process sees no more typing coming.

**Data flow**: It receives a process driver and a flag saying whether stdin should stay open. It asks the PTY utility to spawn the process from that driver, then optionally closes the spawned session’s stdin. It returns the fully spawned process object to the caller.

**Call relations**: The Windows sandbox spawning paths call this after they have built the process setup they want. It hands the final work to the external PTY spawning helper, then gives the resulting process back to the sandbox session setup code.

*Call graph*: called by 2 (spawn_windows_sandbox_session_elevated_for_permission_profile, spawn_windows_sandbox_session_legacy); 1 external calls (spawn_from_driver).


##### `normalize_windows_tty_input`  (lines 28–43)

```
fn normalize_windows_tty_input(bytes: &[u8], previous_was_cr: &mut bool) -> Vec<u8>
```

**Purpose**: This function adjusts typed terminal input so newlines are in the form Windows terminal programs usually expect. It prevents plain line-feed characters from being sent alone when they should be carriage-return plus line-feed.

**Data flow**: It receives a slice of input bytes and a small memory flag telling whether the previous byte was a carriage return. It walks through the bytes, inserting a carriage return before a newline only when one was not already there. It returns a new byte list and updates the memory flag so the next chunk of input continues correctly.

**Call relations**: The stdin writer uses this before packaging typed input for the runner when newline normalization is enabled. Its job is small but important: it makes input sent in separate chunks behave like one continuous terminal stream.

*Call graph*: 1 external calls (with_capacity).


##### `start_runner_pipe_writer`  (lines 45–57)

```
fn start_runner_pipe_writer(
    mut pipe_write: File,
) -> std::sync::mpsc::Sender<FramedMessage>
```

**Purpose**: This function starts a background writer that sends framed messages to the sandbox runner through a pipe. Other parts of the program can then send messages into a normal channel instead of writing to the pipe themselves.

**Data flow**: It receives the writable end of a pipe. It creates a channel for outgoing framed messages, starts a blocking background task, and has that task read messages from the channel and write each one as a frame to the pipe. It returns the sending side of the channel so callers can queue messages for the runner.

**Call relations**: The elevated Windows sandbox session setup calls this when it needs a reliable outgoing path to the runner. Later helpers, such as stdin writing and resizing, use the returned sender so all runner-bound messages go through the same pipe-writing worker.

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

**Purpose**: This function starts a background task that turns user input bytes into runner stdin messages. When input ends, it can also tell the runner that stdin is closed.

**Data flow**: It receives a channel of raw input bytes, a sender for framed runner messages, and two flags: whether to normalize Windows newlines and whether stdin is considered open. The background task reads input chunks, optionally rewrites newline bytes, encodes the bytes safely for the message format, and sends a Stdin message to the runner. When no more input arrives, it sends a CloseStdin message if needed.

**Call relations**: The elevated Windows sandbox session setup starts this alongside the pipe writer. It depends on the outgoing message sender created for the runner pipe, and it uses the newline normalizer when the session needs Windows terminal-style input.

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

**Purpose**: This function starts a thread that listens for messages coming back from the sandbox runner. It turns runner output into stdout or stderr broadcasts and reports the final exit code when the runner is done.

**Data flow**: It receives the readable end of the runner pipe, broadcast channels for stdout and optionally stderr, and a one-time channel for the exit code. The thread repeatedly reads framed messages. Output messages are decoded from their encoded byte form and sent to the right output stream. Exit messages send the real exit code. Pipe failures or runner error messages send a visible error line and report -1.

**Call relations**: The elevated Windows sandbox session setup starts this so the rest of the program can observe the running sandbox process. It calls the shared error-reporting helper when the pipe closes too early, a read fails, or the runner explicitly reports an error.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 1 external calls (spawn).


##### `make_runner_resizer`  (lines 163–179)

```
fn make_runner_resizer(
    outbound_tx: std::sync::mpsc::Sender<FramedMessage>,
) -> Box<dyn FnMut(TerminalSize) -> Result<()> + Send>
```

**Purpose**: This function builds a small callback that tells the sandbox runner when the terminal window size changes. Callers can keep this callback and invoke it whenever rows or columns change.

**Data flow**: It receives the outgoing runner message sender. It returns a boxed function. Each time that function is called with a terminal size, it wraps the row and column counts in a Resize message and sends it to the runner. If the pipe-writing side is gone, it returns an error explaining that the resize pipe is closed.

**Call relations**: The elevated Windows sandbox session setup uses this to connect terminal resize events to the runner. The callback sends through the same outbound pipe path as stdin and other control messages, keeping communication with the runner in one channel.

*Call graph*: called by 1 (spawn_windows_sandbox_session_elevated_for_permission_profile); 1 external calls (new).


##### `send_runner_error`  (lines 181–192)

```
fn send_runner_error(
    message: &str,
    stdout_tx: &broadcast::Sender<Vec<u8>>,
    stderr_tx: Option<&broadcast::Sender<Vec<u8>>>,
)
```

**Purpose**: This helper turns an internal runner communication problem into a user-visible error line. It sends that line to stderr when stderr is available, or to stdout as a fallback.

**Data flow**: It receives an error message plus output broadcast channels. It prefixes the text with "runner error:", adds a newline, converts it to bytes, and sends it through stderr if possible. If there is no stderr channel, it sends the same bytes through stdout instead.

**Call relations**: The runner stdout reader uses this whenever reading from the runner fails, the pipe closes before an exit message, or the runner sends an error message. It keeps error formatting consistent and makes sure failures are visible even when a separate stderr stream is not present.

*Call graph*: 2 external calls (send, format!).


### `cli/src/exit_status.rs`

`io_transport` · `teardown`

When this CLI runs another program, that program eventually stops and returns an exit status: a small piece of information that says whether it succeeded, failed, or was stopped by the operating system. This file translates that result into the CLI's own final exit code.

That matters because command-line tools are often used in scripts. A script may ask, “Did this command pass?” If the sandboxed command failed but the wrapper CLI still exited successfully, later steps could run when they should not.

The file has platform-specific behavior. On Unix-like systems, a process may end with a normal numeric exit code, or it may be killed by a signal, which is an operating-system interruption such as “terminate now.” If there is a normal code, the CLI exits with that exact code. If there is a signal, it follows the common Unix convention of exiting with 128 plus the signal number. If neither detail is available, it uses 1, a general failure code. On Windows, signal-style termination is not normally used, so it copies the normal exit code when possible and otherwise falls back to 1.

In short, this file is the “pass along the final result” adapter between a child command and the outer CLI process.

#### Function details

##### `handle_exit_status`  (lines 16–23)

```
fn handle_exit_status(status: std::process::ExitStatus) -> !
```

**Purpose**: This function ends the current CLI process using the result from a command the CLI just ran. Someone uses it when the wrapper should report the child command's outcome as its own outcome.

**Data flow**: It receives an ExitStatus value, which is the operating system's record of how the child process ended. It first tries to read a normal numeric exit code and exits with that. On Unix, if there is no normal code, it checks whether the process was stopped by a signal and turns that into the conventional 128-plus-signal exit code. If no useful detail is available, it exits with 1, meaning general failure. Nothing is returned, because the function deliberately terminates the process.

**Call relations**: After run_command_under_sandbox has run the requested command, it calls handle_exit_status to make the outer CLI finish in the same spirit as the command inside the sandbox. handle_exit_status then hands the final number to the operating system's process-exit call, which stops the CLI immediately.

*Call graph*: called by 1 (run_command_under_sandbox); 3 external calls (code, signal, exit).


### `cli/src/debug_sandbox/pid_tracker.rs`

`domain_logic` · `after child process spawn until sandbox cleanup`

When a program runs, it may start other programs, and those may start more programs. If the sandbox only knew the first process ID, it could miss work happening in the children. This file solves that by keeping a live guest list for a whole process family.

It is macOS-oriented code. It uses kqueue, a macOS system service that can wait for process events such as “this process forked” or “this process exited.” Think of kqueue like a doorbell system: instead of constantly checking every door, the code asks the operating system to ring when something important happens. It also uses proc_listchildpids, another macOS call, to ask “who are this process’s current children?”

PidTracker is the small public wrapper. Starting it creates a kqueue and runs the blocking watcher on a separate Tokio blocking task, so the main async program is not stuck waiting. Stopping it sends a custom stop event into the same kqueue, waits for the watcher to finish, and returns the set of all process IDs it saw.

The core loop keeps two sets: “seen” means every process ever discovered, and “active” means processes still being watched. Fork events cause it to scan for new children. Exit events remove processes from the active set. It also handles races where a process disappears before it can be watched.

#### Function details

##### `PidTracker::new`  (lines 13–22)

```
fn new(root_pid: i32) -> Option<Self>
```

**Purpose**: Starts tracking the descendants of one root process. It returns no tracker if the given process ID is invalid, because there is no real process family to follow.

**Data flow**: It receives a root process ID. If the ID is positive, it opens a kqueue event queue and starts a blocking background task that will watch the root process and its descendants. It returns a PidTracker containing the event queue handle and the background task handle.

**Call relations**: The sandbox flow calls this when a child process is spawned, and the tests call it to prove tracking works. It relies on the operating system to create the kqueue and on Tokio to run the watcher without blocking the async caller.

*Call graph*: called by 3 (pid_tracker_collects_bash_subshell_descendants, pid_tracker_collects_spawned_children, on_child_spawn); 2 external calls (kqueue, spawn_blocking).


##### `PidTracker::stop`  (lines 24–27)

```
async fn stop(self) -> HashSet<i32>
```

**Purpose**: Stops the background process watcher and returns the process IDs it discovered. This is the clean way to end tracking and collect the final result.

**Data flow**: It consumes the PidTracker, sends a stop signal into its kqueue, then waits for the background task to finish. The output is the set of seen process IDs, or an empty set if the task failed unexpectedly.

**Call relations**: This is called when the owner no longer needs live tracking. It hands off to trigger_stop_event so the blocking watcher can wake up and exit instead of waiting forever.

*Call graph*: calls 1 internal fn (trigger_stop_event).


##### `list_child_pids`  (lines 39–60)

```
fn list_child_pids(parent: i32) -> Vec<i32>
```

**Purpose**: Asks macOS for the direct child processes of a given parent process. It is used to discover new processes after a fork and also to catch children that already existed before watching began.

**Data flow**: It receives a parent process ID, allocates a buffer for child IDs, and calls proc_listchildpids. If the buffer was too small, it grows the buffer and tries again. It returns a list of child process IDs, or an empty list if none are found or the system call says there are no children.

**Call relations**: watch_children calls this whenever it needs to scan a process for children. A test also calls it directly by spawning a short-lived child process and checking that the child appears in the returned list.

*Call graph*: called by 2 (list_child_pids_includes_spawned_child, watch_children); 2 external calls (new, vec!).


##### `pid_is_alive`  (lines 62–75)

```
fn pid_is_alive(pid: i32) -> bool
```

**Purpose**: Checks whether a process ID still refers to a running process. This helps the tracker decide whether it should keep trying to watch the root process or give up.

**Data flow**: It receives a process ID. Invalid IDs immediately count as not alive. For valid IDs, it uses the common kill(pid, 0) check, which does not actually kill anything; it only asks the operating system whether the process exists. It returns true if the process exists, including the case where it exists but permission is denied.

**Call relations**: track_descendants uses this when its active watch list becomes empty. The direct unit test checks that the current process is reported as alive.

*Call graph*: called by 1 (track_descendants); 2 external calls (kill, matches!).


##### `watch_pid`  (lines 83–108)

```
fn watch_pid(kq: libc::c_int, pid: i32) -> Result<(), WatchPidError>
```

**Purpose**: Registers one process with kqueue so the code can be notified when that process forks, executes a new program, or exits. This is how the tracker gets live updates instead of only taking snapshots.

**Data flow**: It receives a kqueue handle and a process ID. It builds a kqueue process event request and submits it to macOS. It returns success, a “process already gone” error, or another operating-system error.

**Call relations**: add_pid_watch calls this when a process should become actively watched. If the process vanished before registration, add_pid_watch removes it from the active set; if another error occurs, add_pid_watch logs a warning.

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

**Purpose**: Finds all direct children of a process and makes sure each one is added to the tracker. This is the bridge from “I saw this process fork” to “now follow its children too.”

**Data flow**: It receives a kqueue handle, a parent process ID, and the shared seen and active sets. It asks list_child_pids for the parent’s children, then passes each child to add_pid_watch. The sets are updated in place.

**Call relations**: track_descendants calls this after fork events, and add_pid_watch calls it recursively when a newly watched process may already have children. It depends on list_child_pids for the snapshot and add_pid_watch for the actual registration.

*Call graph*: calls 2 internal fn (add_pid_watch, list_child_pids); called by 2 (add_pid_watch, track_descendants).


##### `add_pid_watch`  (lines 122–150)

```
fn add_pid_watch(kq: libc::c_int, pid: i32, seen: &mut HashSet<i32>, active: &mut HashSet<i32>)
```

**Purpose**: Adds a process to the tracker’s records and, when possible, starts watching it for future process events. It also recursively discovers that process’s existing children.

**Data flow**: It receives a kqueue handle, a process ID, and mutable seen and active sets. It ignores invalid IDs. It records the ID as seen, tries to put it in the active watch set, and calls watch_pid. If watching succeeds, it scans the process’s children; if the process is gone or cannot be watched, it removes it from active.

**Call relations**: track_descendants uses this to start with the root process and to retry watching when needed. watch_children uses it for every child it finds, which lets discovery spread through the whole descendant tree. It calls watch_pid for live event registration and watch_children for recursive discovery.

*Call graph*: calls 2 internal fn (watch_children, watch_pid); called by 2 (track_descendants, watch_children); 1 external calls (warn!).


##### `register_stop_event`  (lines 153–165)

```
fn register_stop_event(kq: libc::c_int) -> bool
```

**Purpose**: Adds a custom user event to the kqueue so another part of the code can wake the watcher and tell it to stop. Without this, the watcher might sit blocked waiting for process events.

**Data flow**: It receives a kqueue handle, creates a user-event registration with a fixed identifier, and submits it to macOS. It returns true if registration worked and false otherwise.

**Call relations**: track_descendants calls this before entering its main wait loop. Later, PidTracker::stop uses trigger_stop_event to fire the event that was registered here.

*Call graph*: called by 1 (track_descendants); 3 external calls (kevent, null, null_mut).


##### `trigger_stop_event`  (lines 167–182)

```
fn trigger_stop_event(kq: libc::c_int)
```

**Purpose**: Signals the watcher’s custom stop event. This is the shutdown bell for the blocking tracking loop.

**Data flow**: It receives a kqueue handle. If the handle is invalid, it does nothing. Otherwise, it submits a kqueue user event trigger and ignores any error, because stopping is best-effort at this point.

**Call relations**: PidTracker::stop calls this before waiting for the background watcher. The watcher in track_descendants notices the event and breaks out of its loop.

*Call graph*: called by 1 (stop); 3 external calls (kevent, null, null_mut).


##### `track_descendants`  (lines 185–275)

```
fn track_descendants(kq: libc::c_int, root_pid: i32) -> HashSet<i32>
```

**Purpose**: Runs the actual process-family tracking loop. It returns every process ID it discovered under the root process.

**Data flow**: It receives a kqueue handle and a root process ID. If the event queue cannot be used, it returns a set containing only the root. Otherwise it registers the stop event, starts watching the root, then waits for kqueue events. Fork events cause child scans, exit events remove processes from the active set, stop events end the loop, and operating-system interruption is retried. Before returning, it closes the kqueue and outputs the seen set.

**Call relations**: PidTracker::new runs this in a blocking background task. Inside the loop it coordinates the helper functions: register_stop_event prepares shutdown, add_pid_watch starts tracking, watch_children follows forks, pid_is_alive decides whether to retry or finish, and kqueue provides the incoming event stream.

*Call graph*: calls 4 internal fn (add_pid_watch, pid_is_alive, register_stop_event, watch_children); 6 external calls (new, last_os_error, close, kevent, zeroed, null).


##### `tests::pid_is_alive_detects_current_process`  (lines 285–288)

```
fn pid_is_alive_detects_current_process()
```

**Purpose**: Checks the simplest health check: the current program’s own process ID should be reported as alive.

**Data flow**: It reads the current process ID, passes it to pid_is_alive, and asserts that the answer is true. It does not change system state.

**Call relations**: This test directly protects pid_is_alive, which track_descendants relies on when deciding whether the root process is still around.

*Call graph*: 2 external calls (assert!, id).


##### `tests::list_child_pids_includes_spawned_child`  (lines 292–315)

```
fn list_child_pids_includes_spawned_child()
```

**Purpose**: Checks that list_child_pids can see a real child process on macOS. It proves the wrapper around the macOS child-listing call works in a normal case.

**Data flow**: It starts a /bin/sleep child process, remembers the child ID and the current parent ID, then repeatedly asks list_child_pids for the parent’s children for a short time. It kills and waits for the child, then asserts that the child ID was found.

**Call relations**: This test calls list_child_pids directly. That same helper is used by watch_children during real tracking.

*Call graph*: calls 1 internal fn (list_child_pids); 6 external calls (from_millis, null, assert!, new, id, sleep).


##### `tests::pid_tracker_collects_spawned_children`  (lines 319–343)

```
async fn pid_tracker_collects_spawned_children()
```

**Purpose**: Checks that PidTracker records a direct child process that appears while tracking is running. This covers the main public behavior at a small scale.

**Data flow**: It starts a tracker for the current process, spawns a short /bin/sleep child, waits for that child to finish, then stops the tracker. It asserts that the returned seen set contains both the parent process and the child process.

**Call relations**: This test uses PidTracker::new and PidTracker::stop the way production code does. Through those calls, it exercises the background track_descendants loop and its child-discovery helpers.

*Call graph*: calls 1 internal fn (new); 4 external calls (null, assert!, new, id).


##### `tests::pid_tracker_collects_bash_subshell_descendants`  (lines 347–371)

```
async fn pid_tracker_collects_bash_subshell_descendants()
```

**Purpose**: Checks that PidTracker can record a deeper descendant, not just an immediate child. It uses bash to create a process below the first spawned process.

**Data flow**: It starts a tracker for the current process, runs bash with a command that starts a background sleep process and prints that sleep process’s ID, then waits for bash output. After stopping the tracker, it parses the printed descendant ID and asserts that the seen set contains it.

**Call relations**: This test calls PidTracker::new and later stops the tracker, exercising the recursive path where watch_children and add_pid_watch spread tracking from a parent to its children and grandchildren.

*Call graph*: calls 1 internal fn (new); 6 external calls (null, piped, from_utf8_lossy, assert!, new, id).


### Editing and patch application helpers
These utilities support interactive editing workflows and fuzzy patch-context matching used by higher-level file update flows.

### `tui/src/external_editor.rs`

`io_transport` · `active when the user invokes external editing`

This file solves a simple but important problem: some text is easier to write or revise in a real editor than inside a terminal prompt. It acts like a notepad handoff. The app writes some starting text into a temporary file, opens the user's chosen editor on that file, waits until the editor closes, then reads the edited text back.

The editor choice comes from environment variables, which are settings the user's shell can provide. VISUAL is preferred over EDITOR because it usually means a full-screen or graphical editor, while EDITOR is the older fallback. The command string is split into a program plus its arguments, so settings like `code --wait` can work.

There is special Windows behavior because launching commands is trickier there. A command such as `code` may actually be a `code.cmd` helper found through PATH and PATHEXT, so the file tries to resolve that before launching.

The temporary file is given a `.md` suffix, which helps editors recognize it as Markdown. The editor inherits the terminal input, output, and error streams, so the user interacts with it normally. If the editor exits with an error, this file returns an error instead of silently accepting bad or missing edits. The tests protect the environment-variable behavior and confirm that edited file contents are read back correctly.

#### Function details

##### `resolve_windows_program`  (lines 25–29)

```
fn resolve_windows_program(program: &str) -> std::path::PathBuf
```

**Purpose**: On Windows, this finds the actual program file that should be launched for a command name. It matters because a command like `code` may really be a `code.cmd` file on the user's PATH, and the normal process launcher may not find that helper by itself.

**Data flow**: It receives a program name as text. It asks the system-path lookup library to find the matching executable while respecting Windows filename extensions. It returns the found path, or if lookup fails, it returns the original program name as a path so launching can still be attempted.

**Call relations**: This helper is used by run_editor only on Windows, right before starting the editor process. It hands run_editor a launchable program path so the rest of the editor-running flow can stay the same.

*Call graph*: called by 1 (run_editor); 1 external calls (which).


##### `resolve_editor_command`  (lines 33–51)

```
fn resolve_editor_command() -> std::result::Result<Vec<String>, EditorError>
```

**Purpose**: This chooses the editor command the app should use. It reads VISUAL first, then EDITOR, and turns the chosen setting into a list where the first item is the program and the rest are command-line options.

**Data flow**: It reads the VISUAL and EDITOR environment variables. If neither exists, it returns a MissingEditor error. If it finds a value, it splits the command text using platform-appropriate rules, checks that at least one command part exists, and returns the parts as a list of strings.

**Call relations**: The wider editor-launch flow, represented by launch_external_editor, calls this when it needs to know what editor to start. The resolve_editor_prefers_visual test also calls it to prove VISUAL wins over EDITOR.

*Call graph*: called by 2 (launch_external_editor, resolve_editor_prefers_visual); 3 external calls (var, split, split).


##### `run_editor`  (lines 54–91)

```
async fn run_editor(seed: &str, editor_cmd: &[String]) -> Result<String>
```

**Purpose**: This performs the full edit handoff: create a temporary file, put the starting text in it, open the editor, wait for the user to finish, and return the final file contents.

**Data flow**: It receives the starting text and an already-split editor command. If the command is empty, it returns an error. Otherwise it creates a temporary `.md` file, writes the starting text into it, builds a process command for the editor, appends the temp file path as the file to edit, and runs it with normal terminal input and output. If the editor succeeds, it reads the file back and returns the edited text. If the editor fails, it returns an error with the exit status.

**Call relations**: This is the core worker used after an editor command has been resolved. On Windows it calls resolve_windows_program before launching. The run_editor_returns_updated_content test calls it with a tiny shell script standing in for a real editor, then checks that the changed text comes back.

*Call graph*: calls 1 internal fn (resolve_windows_program); called by 1 (run_editor_returns_updated_content); 7 external calls (new, msg, inherit, new, format!, read_to_string, write).


##### `tests::EnvGuard::new`  (lines 107–112)

```
fn new() -> Self
```

**Purpose**: This test helper remembers the current VISUAL and EDITOR environment variables before a test changes them. It prevents tests from permanently altering the developer's or test runner's environment.

**Data flow**: It reads VISUAL and EDITOR from the environment and stores each original value, or records that it was absent. It returns an EnvGuard value holding that snapshot.

**Call relations**: The environment-variable tests create this guard before changing VISUAL or EDITOR. Later, when the guard is dropped, tests::EnvGuard::drop restores what tests::EnvGuard::new saved.

*Call graph*: 1 external calls (var).


##### `tests::EnvGuard::drop`  (lines 116–119)

```
fn drop(&mut self)
```

**Purpose**: This automatically restores VISUAL and EDITOR after a test finishes. It is cleanup code that runs even if the test exits early because the guard value goes out of scope.

**Data flow**: It takes the saved VISUAL and EDITOR values from the guard. For each one, it calls the restore helper to either put the old value back or remove the variable if it did not exist before.

**Call relations**: This is the second half of the EnvGuard test pattern. The tests create the guard with tests::EnvGuard::new, and Rust calls this drop function at the end of the test scope so tests do not leak environment changes into one another.

*Call graph*: 1 external calls (restore_env).


##### `tests::restore_env`  (lines 122–127)

```
fn restore_env(key: &str, value: Option<String>)
```

**Purpose**: This small test helper puts one environment variable back the way it was. It either restores a saved value or removes the variable if there was no saved value.

**Data flow**: It receives an environment variable name and an optional saved value. If there is a saved value, it writes that value back into the environment. If there is no saved value, it removes the variable.

**Call relations**: tests::EnvGuard::drop calls this for VISUAL and EDITOR during test cleanup. It is not part of the app's editor behavior; it exists to keep the tests isolated and reliable.

*Call graph*: 2 external calls (remove_var, set_var).


##### `tests::resolve_editor_prefers_visual`  (lines 131–139)

```
fn resolve_editor_prefers_visual()
```

**Purpose**: This test proves that VISUAL is chosen before EDITOR when both are set. That matters because users often set VISUAL to their preferred interactive editor.

**Data flow**: It saves the current environment with EnvGuard, sets VISUAL to `vis` and EDITOR to `ed`, then calls resolve_editor_command. It checks that the returned command is only `vis`, showing that EDITOR was ignored in this situation.

**Call relations**: This test directly exercises resolve_editor_command. EnvGuard protects the surrounding test environment before and after the test changes environment variables.

*Call graph*: calls 1 internal fn (resolve_editor_command); 3 external calls (assert_eq!, set_var, new).


##### `tests::resolve_editor_errors_when_unset`  (lines 143–153)

```
fn resolve_editor_errors_when_unset()
```

**Purpose**: This test proves that the code reports a clear error when no editor is configured. Without this, the app might fail later with a confusing process-launch error.

**Data flow**: It saves the current environment, removes VISUAL and EDITOR, then calls resolve_editor_command. It checks that the result is the MissingEditor error.

**Call relations**: This test exercises the failure path of resolve_editor_command. Like the other environment test, it uses EnvGuard so removing the variables affects only this test.

*Call graph*: 3 external calls (assert!, remove_var, new).


##### `tests::run_editor_returns_updated_content`  (lines 157–170)

```
async fn run_editor_returns_updated_content()
```

**Purpose**: This Unix-only test proves that run_editor really reads back what the external command writes into the temporary file. It uses a tiny script as a fake editor.

**Data flow**: It creates a temporary directory, writes an executable shell script that replaces the file contents with `edited`, and passes that script as the editor command to run_editor with `seed` as the starting text. It then checks that the returned text is `edited`.

**Call relations**: This test calls run_editor in the same shape a real editor launch would use, but with a predictable script instead of a human editor. It also uses filesystem calls to create and mark the script executable before handing it to run_editor.

*Call graph*: calls 1 internal fn (run_editor); 6 external calls (assert_eq!, metadata, set_permissions, write, tempdir, vec!).


### `apply-patch/src/seek_sequence.rs`

`domain_logic` · `patch application`

When applying a patch, the program often needs to answer a simple but important question: “Where in this file is the group of lines this patch is talking about?” This file provides that search. Without it, patch application would be brittle: a few extra spaces, tabs, or curly quotes could stop an otherwise valid patch from being applied.

The main function, `seek_sequence`, looks for a sequence of pattern lines inside a larger list of file lines. It starts with the strictest check: every line must match exactly. If that fails, it tries again while ignoring whitespace at the ends of lines. If that still fails, it ignores whitespace at both the beginning and end. As a final fallback, it also treats some common Unicode punctuation as equivalent to plain ASCII punctuation, such as turning typographic dashes into `-` and curly quotes into straight quotes.

There is also special behavior for end-of-file matches. If the caller says the patch is meant for the end of the file, the search first tries the position where the pattern would end exactly at the file end, then searches normally if needed.

The file includes tests for the key promises: exact matching works, whitespace-tolerant matching works, and an overlong pattern safely returns “not found” instead of crashing.

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

**Purpose**: Finds the first place where a group of lines appears inside a larger file, starting at a requested position. It is used when applying a patch to locate the existing text that the patch expects to change, and it allows small formatting differences so patches are less fragile.

**Data flow**: It receives the file lines, the pattern lines to find, a starting index, and a flag saying whether the match is intended for the end of the file. If the pattern is empty, it immediately reports the starting index as a harmless no-op match. If the pattern is longer than the file, it returns no match. Otherwise it searches in several passes: exact text, then ignoring trailing whitespace, then ignoring leading and trailing whitespace, then after converting common fancy punctuation and unusual spaces into simpler forms. It returns the index where the pattern starts, or `None` if no acceptable match is found.

**Call relations**: During patch application, `compute_replacements` calls this function when it needs to locate the context lines for a replacement. `seek_sequence` does the careful searching and hands back either the matching line position or a clear “not found” result, allowing the replacement logic to decide what to do next.

*Call graph*: called by 1 (compute_replacements).


##### `tests::to_vec`  (lines 117–119)

```
fn to_vec(strings: &[&str]) -> Vec<String>
```

**Purpose**: Builds test input in the same shape that `seek_sequence` expects: a list of owned strings. It keeps the tests short and readable by turning simple string slices into `Vec<String>` values.

**Data flow**: It receives a small list of borrowed text snippets used in a test. It copies each snippet into a `String` and returns a vector containing those strings. It does not change anything outside itself.

**Call relations**: The test functions call this helper before calling `seek_sequence`. It is only test support, so it exists to make the examples easier to read rather than to take part in patch application.


##### `tests::test_exact_match_finds_sequence`  (lines 122–129)

```
fn test_exact_match_finds_sequence()
```

**Purpose**: Checks that the search can find a plain, exact sequence of lines. This proves the basic “find these lines in this file” behavior works.

**Data flow**: It creates file lines `foo`, `bar`, `baz` and a pattern `bar`, `baz`. It asks `seek_sequence` to search from the beginning, then checks that the answer is index `1`, where `bar` starts.

**Call relations**: This test uses `tests::to_vec` to prepare readable test data, then calls `seek_sequence` directly. Its assertion confirms the simplest path through the search logic before the more forgiving fallback behavior is needed.

*Call graph*: 2 external calls (to_vec, assert_eq!).


##### `tests::test_rstrip_match_ignores_trailing_whitespace`  (lines 132–140)

```
fn test_rstrip_match_ignores_trailing_whitespace()
```

**Purpose**: Checks that the search still succeeds when the file has extra spaces or tabs at the ends of lines. This matters because patches should not fail just because trailing whitespace differs.

**Data flow**: It creates file lines with trailing spaces and tabs, and a pattern that omits that trailing whitespace. It calls `seek_sequence` from the start of the file and checks that the match is found at index `0`.

**Call relations**: This test prepares its inputs with `tests::to_vec`, then exercises the second search pass inside `seek_sequence`, the one that compares lines after removing whitespace from the right side. The assertion verifies that this fallback is actually used successfully.

*Call graph*: 2 external calls (to_vec, assert_eq!).


##### `tests::test_trim_match_ignores_leading_and_trailing_whitespace`  (lines 143–151)

```
fn test_trim_match_ignores_leading_and_trailing_whitespace()
```

**Purpose**: Checks that the search can also ignore extra whitespace at both the beginning and end of lines. This makes patch matching more tolerant when indentation or surrounding spacing has changed.

**Data flow**: It creates file lines with leading spaces and trailing spaces or tabs, and a clean pattern without those extras. It sends both into `seek_sequence` and checks that the pattern is found at index `0`.

**Call relations**: This test uses `tests::to_vec` for setup, then calls `seek_sequence` to reach the more lenient whitespace comparison pass. It confirms that the function can still locate context lines when exact and trailing-only comparisons are not enough.

*Call graph*: 2 external calls (to_vec, assert_eq!).


##### `tests::test_pattern_longer_than_input_returns_none`  (lines 154–162)

```
fn test_pattern_longer_than_input_returns_none()
```

**Purpose**: Checks that asking for a pattern longer than the file safely reports no match. This guards against a past kind of bug where such a request could try to read beyond the available lines and crash.

**Data flow**: It creates a one-line file and a three-line pattern. It calls `seek_sequence` and checks that the result is `None`, meaning the match cannot fit anywhere.

**Call relations**: This test uses `tests::to_vec` to build the inputs, then calls `seek_sequence` on an impossible case. Its assertion protects the defensive early-return behavior that keeps the patching code stable instead of panicking.

*Call graph*: 2 external calls (to_vec, assert_eq!).
