# Testing, fixtures, and developer verification harnesses  `stage-23` (cross-cutting infrastructure)

This stage is the repository’s verification perimeter: it sits outside normal startup, request handling, and teardown, and supplies the tests, fixtures, fake services, and helper binaries that prove every major lifecycle path works as intended. It is where developers validate behavior end to end before changes reach production code paths.

The app-server suites verify protocol schemas, JSON-RPC and remote-control boundaries, daemon/update behavior, transports, and full server integrations. Core runtime and session harnesses exercise turn processing, tools, approvals, persistence, replay, and complete conversation flows using reusable hermetic fixtures. CLI, exec, login, and MCP server tests cover the developer-facing executables and auth flows, including command parsing, streaming execution, patch application, policy checks, and real JSON-RPC exchanges. Exec-server, sandbox, and remote transport harnesses launch real subprocesses and sockets to validate RPC handshakes, filesystem behavior, relay security, reconnects, and platform-specific sandbox execution. TUI tests render the terminal interface in controlled backends to check interaction, layout, replay, and integration regressions. Cross-cutting library suites lock down telemetry, config, plugins, protocol/client plumbing, persistence, and utility behavior. The direct support crate, test-binary-support/lib.rs, underpins these suites by dispatching test binary aliases and isolating temporary CODEX_HOME environments.

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

`orchestration` · `test startup`

This small support crate exists for test binaries that need to behave like installed multi-call executables. Its main type, `TestBinaryDispatchGuard`, owns a temporary `TempDir` used as synthetic `CODEX_HOME`, an `Arg0PathEntryGuard` returned by `codex_arg0::arg0_dispatch`, and the previous `CODEX_HOME` value so the environment can be restored after alias installation. The guard intentionally keeps the temp directory alive for as long as the alias path entries are needed.

The core function, `configure_test_binary_dispatch`, inspects `argv[0]` and optionally `argv[1]`, then delegates the decision to a caller-provided classifier closure that returns one of three `TestBinaryDispatchMode` values. In `DispatchArg0Only`, it immediately invokes `arg0_dispatch()` and returns `None`, allowing the process to behave as the dispatched alias without installing test fixtures. In `Skip`, it does nothing. In `InstallAliases`, it creates a temporary CODEX_HOME directory with a caller-supplied prefix, temporarily sets the `CODEX_HOME` environment variable before calling `arg0_dispatch()` so alias installation lands in that temp home, restores the previous environment variable afterward, and returns a guard holding the temp directory and dispatch path entry. Failures to create the temp directory or configure aliases are treated as hard test setup errors via `panic!`.

#### Function details

##### `TestBinaryDispatchGuard::paths`  (lines 15–17)

```
fn paths(&self) -> &Arg0DispatchPaths
```

**Purpose**: Exposes the installed arg0 dispatch paths held by the guard. This lets tests inspect where aliases and executables were configured.

**Data flow**: Reads `self.arg0`, calls its `paths()` accessor, and returns a shared reference to `Arg0DispatchPaths` without modifying guard state.

**Call relations**: This is a simple accessor used after `configure_test_binary_dispatch` returns a guard in `InstallAliases` mode.

*Call graph*: calls 1 internal fn (paths).


##### `configure_test_binary_dispatch`  (lines 26–77)

```
fn configure_test_binary_dispatch(
    codex_home_prefix: &str,
    classify: F,
) -> Option<TestBinaryDispatchGuard>
```

**Purpose**: Determines whether a test binary should dispatch immediately, skip dispatch setup, or install temporary arg0 aliases under a synthetic `CODEX_HOME`. It centralizes all environment and temp-directory manipulation needed for those modes.

**Data flow**: Reads process arguments via `std::env::args_os`, derives `exe_name` from `argv[0]` and an optional UTF-8 `argv[1]`, and passes them to the `classify` closure. For `DispatchArg0Only`, it invokes `arg0_dispatch()` and returns `None`. For `Skip`, it returns `None` unchanged. For `InstallAliases`, it creates a prefixed `TempDir`, snapshots `CODEX_HOME` with `var_os`, unsafely sets `CODEX_HOME` to the temp path, calls `arg0_dispatch()` expecting an `Arg0PathEntryGuard`, restores the previous `CODEX_HOME` with `set_var` or `remove_var`, and returns `Some(TestBinaryDispatchGuard { ... })`.

**Call relations**: This is the file’s orchestration entry point, intended to be called from test initialization code before parallel test threads begin so the temporary environment mutation remains safe.

*Call graph*: 8 external calls (new, arg0_dispatch, panic!, args_os, remove_var, set_var, var_os, new).
