# Testing, fixtures, and developer verification harnesses  `stage-23` (cross-cutting infrastructure)

This stage is the project’s test workshop. It is not used by normal users during startup, daily work, or shutdown. Instead, developers and automated checks use it to make sure every major part still behaves correctly before changes are shipped.

The app-server tests prove the server starts, speaks the expected message formats, and supports real client workflows. The core runtime tests check conversations, tools, permissions, saved history, recovery, and safe stopping. The CLI, exec, login, and MCP tests run the command-line programs like real users would, including patching files, signing in, streaming results, and handling failures. The exec-server, sandbox, and remote transport tests protect command execution, file access, encrypted connections, relays, and platform-specific safety rules. The TUI tests draw the terminal interface into fake screens and check chat behavior, popups, layout, scrolling, and rendering. The cross-cutting library tests cover shared pieces such as telemetry, configuration, plugins, APIs, persistence, and utilities.

The direct support file, `test-binary-support/lib.rs`, lets tests imitate different installed command names using temporary aliases and a temporary home folder, then cleans everything up afterward.

## Sub-stages

- [App-server test suites and protocol verification](stage-23.1.md) `stage-23.1` — 115 files
- [Core runtime and session test harnesses](stage-23.2.md) `stage-23.2` — 179 files
- [CLI, exec, login, and MCP server developer verification](stage-23.3.md) `stage-23.3` — 73 files
- [Exec-server, sandbox, and remote transport harnesses](stage-23.4.md) `stage-23.4` — 49 files
- [TUI interaction and rendering tests](stage-23.5.md) `stage-23.5` — 52 files
- [Cross-cutting library tests, fixtures, and telemetry or rollout support](stage-23.6.md) `stage-23.6` — 190 files

## Files in this stage

### Testing, fixtures, and developer verification harnesses
### `test-binary-support/lib.rs`

`test` · `test startup`

Some command-line programs choose what to do based on the name they were started with. That name is often called “argv0”, meaning the first command-line value passed to a process. This file provides test-only support for that behavior. It lets a test binary decide whether to do normal alias dispatch, skip setup, or install temporary command aliases for the test run.

The main idea is a safety wrapper called TestBinaryDispatchGuard. Think of it like a hotel key card for a temporary test room: as long as the guard exists, the temporary setup exists too. It keeps a temporary CODEX_HOME directory alive and stores the alias-dispatch setup returned by the lower-level codex_arg0 code.

The setup function first looks at how the current test process was started: the executable name and the first argument. A caller-provided classifier then chooses the mode. In one mode, the file only runs the normal argv0 dispatch and stops. In another, it does nothing. In the full setup mode, it creates a temporary CODEX_HOME, briefly points the environment variable CODEX_HOME at it, asks codex_arg0 to create dispatch aliases, then restores the previous environment value. If temporary directory creation or alias setup fails, it panics, because the test cannot run meaningfully without that setup.

#### Function details

##### `TestBinaryDispatchGuard::paths`  (lines 15–17)

```
fn paths(&self) -> &Arg0DispatchPaths
```

**Purpose**: This gives callers access to the dispatch paths that were created for the test aliases. A test can use these paths to run or inspect the temporary command aliases.

**Data flow**: It starts with an existing TestBinaryDispatchGuard, reads the stored arg0 dispatch guard inside it, and asks that inner guard for its paths. It returns a shared reference to those paths without changing anything.

**Call relations**: After configure_test_binary_dispatch creates a guard, test code can call TestBinaryDispatchGuard::paths to find the alias locations. This method simply passes the request through to the lower-level arg0 guard’s paths method.

*Call graph*: calls 1 internal fn (paths).


##### `configure_test_binary_dispatch`  (lines 26–77)

```
fn configure_test_binary_dispatch(
    codex_home_prefix: &str,
    classify: F,
) -> Option<TestBinaryDispatchGuard>
```

**Purpose**: This sets up command-name dispatch for tests, depending on what kind of test run is being started. It can skip setup, run dispatch immediately, or install temporary aliases that let one test binary act like multiple commands.

**Data flow**: It reads the current process arguments, pulls out the executable name and first argument, and gives those to the caller’s classify function. If the result says to dispatch only, it calls arg0_dispatch and returns no guard. If the result says to skip, it returns no guard. If the result says to install aliases, it creates a temporary CODEX_HOME directory, saves the old CODEX_HOME environment value, temporarily sets CODEX_HOME to the new directory, calls arg0_dispatch to build the aliases, restores the old environment value, and returns a TestBinaryDispatchGuard that keeps the temporary directory and alias setup alive.

**Call relations**: This is the main setup entry used by test binaries or test startup code. It relies on the caller’s classifier to decide the mode, uses standard environment and argument-reading functions to inspect and adjust the process, and hands the actual alias creation to codex_arg0::arg0_dispatch. If setup succeeds, it returns the guard that later lets tests inspect the created paths.

*Call graph*: 8 external calls (new, arg0_dispatch, panic!, args_os, remove_var, set_var, var_os, new).
