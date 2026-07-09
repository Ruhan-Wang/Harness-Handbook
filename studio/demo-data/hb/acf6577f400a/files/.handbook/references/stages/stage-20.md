# Cross-cutting observability, analytics, and feedback  `stage-20` (cross-cutting infrastructure)

This stage is the project’s shared “instrument panel.” It runs across startup, normal request handling, streaming, tool use, and shutdown, watching what happens so developers and operators can understand problems and usage without interrupting the main work.

Analytics event modeling turns scattered facts, such as errors, tool runs, settings, and accepted code changes, into safe summary events and sends them in the background. OpenTelemetry setup provides standard observability: logs, traces, and metrics. A trace is a linked timeline for one piece of work; metrics are counted or timed measurements. Session telemetry adds more detailed trip-recording for each conversation, request, tool call, login state, database startup, and feature outcome.

Rollout tracing is the flight recorder. It can save raw events from conversations, tools, model calls, terminals, and threads, then reduce them into a replayable story. Feedback and debug capture gathers recent logs, failed response details, diagnostics, and local evidence, while sanitizing secrets before anything is stored or sent. The Windows sandbox logging file adds a simple daily text trail for sandbox command starts, successes, failures, and debug notes.

## Sub-stages

- [Analytics event modeling, reduction, and emitters](stage-20.1.md) `stage-20.1` — 8 files
- [OpenTelemetry runtime, provider, and metrics foundations](stage-20.2.md) `stage-20.2` — 22 files
- [Session telemetry and feature-specific instrumentation](stage-20.3.md) `stage-20.3` — 16 files
- [Rollout trace recording, schema, and replay reducers](stage-20.4.md) `stage-20.4` — 24 files
- [Feedback capture, debug artifacts, and log persistence](stage-20.5.md) `stage-20.5` — 10 files

## Files in this stage

### Cross-cutting observability, analytics, and feedback
### `windows-sandbox-rs/src/logging.rs`

`io_transport` · `cross-cutting`

This file is the sandbox's small diary. When the sandbox runs a command, the rest of the program can ask this file to write a line such as START, SUCCESS, FAILURE, or DEBUG into a daily log file. Without it, failures would be harder to explain because there would be no durable record of which command ran, when it ran, and what broad result it had.

The log files live in a sandbox log directory and are named by date, like `sandbox.2026-05-21.log`. A rolling appender is used, meaning the logging library opens the right daily file and keeps only a limited number of old log files. This avoids one huge file growing forever.

The file also protects logs from becoming unreadable or unsafe. Long commands are shortened before being logged, and the shortening is careful not to cut a multi-byte UTF-8 character in half. Each normal note gets a timestamp and the current executable name, so the log line says not only what happened but which program wrote it. Debug messages are different: they are written only when `SBX_DEBUG=1`, which keeps everyday logs quiet unless someone is actively investigating a problem.

#### Function details

##### `exe_label`  (lines 15–23)

```
fn exe_label() -> &'static str
```

**Purpose**: Finds a short label for the running program, usually the executable file name. This label is included in log lines so a reader can tell which process wrote them.

**Data flow**: It reads the current executable path from the operating system. If it can get a file name, it stores and reuses that string; if not, it falls back to `proc`. The output is a stable text label for later log messages.

**Call relations**: This is used inside `log_note` when a normal log line is built. It is cached with a one-time storage cell so repeated log writes do not repeatedly ask the operating system for the same executable name.

*Call graph*: 1 external calls (new).


##### `preview`  (lines 25–32)

```
fn preview(command: &[String]) -> String
```

**Purpose**: Creates a safe, shortened version of a command for logging. It keeps log lines readable and prevents very long commands from flooding the log file.

**Data flow**: It takes a list of command words, joins them with spaces, and checks the total length. If the text is short enough, it returns it unchanged; if it is too long, it trims it at a valid character boundary so text like emoji or non-English characters is not broken.

**Call relations**: `log_start`, `log_success`, and `log_failure` call this before writing command-related log lines. It hands those functions a compact command summary that can safely be placed in the log.

*Call graph*: called by 3 (log_failure, log_start, log_success); 1 external calls (take_bytes_at_char_boundary).


##### `log_file_path_for_utc_date`  (lines 34–40)

```
fn log_file_path_for_utc_date(base_dir: &Path, date: chrono::NaiveDate) -> PathBuf
```

**Purpose**: Builds the expected log file path for a specific UTC date. This gives other code and tests a predictable way to know what the daily log file should be called.

**Data flow**: It receives a base directory and a calendar date. It formats the date into the standard file name pattern, then joins that name onto the directory path. The result is a full path such as `logs/sandbox.2026-05-21.log`.

**Call relations**: `current_log_file_path` uses this after choosing today's date. The function mirrors the naming scheme used by the rolling log writer, so callers can locate the same file that logging will write to.

*Call graph*: called by 1 (current_log_file_path); 2 external calls (join, format!).


##### `current_log_file_path`  (lines 42–44)

```
fn current_log_file_path(base_dir: &Path) -> PathBuf
```

**Purpose**: Returns the path where today's sandbox log file should be. It is useful when another part of the program wants to show or refer to the current log file.

**Data flow**: It takes a base log directory, reads the current UTC date, and passes both to `log_file_path_for_utc_date`. It returns the resulting path for today's daily log.

**Call relations**: `current_log_file_path_for_codex_home` calls this after finding the sandbox directory under a Codex home. Setup-related code such as `run_setup_refresh_inner` also calls it when it needs the current log path.

*Call graph*: calls 1 internal fn (log_file_path_for_utc_date); called by 2 (current_log_file_path_for_codex_home, run_setup_refresh_inner); 1 external calls (now).


##### `current_log_file_path_for_codex_home`  (lines 46–48)

```
fn current_log_file_path_for_codex_home(codex_home: &Path) -> PathBuf
```

**Purpose**: Finds today's log file path when the caller only knows the Codex home directory. It hides the detail that sandbox logs live under the sandbox subdirectory.

**Data flow**: It receives a Codex home path, turns that into the sandbox directory path, then asks `current_log_file_path` for today's log file inside that directory. The output is the expected daily log path.

**Call relations**: This is a convenience wrapper around `current_log_file_path`. It relies on the crate-level sandbox directory helper so all code uses the same location convention.

*Call graph*: calls 1 internal fn (current_log_file_path); 1 external calls (sandbox_dir).


##### `log_writer`  (lines 50–62)

```
fn log_writer(base_dir: &Path) -> Option<RollingFileAppender>
```

**Purpose**: Creates a writer that appends to the daily sandbox log file. It also sets the rotation rule, which means logs are split by day and old files are capped.

**Data flow**: It receives a base directory. If that directory does not exist, it returns nothing; otherwise it builds a rolling file appender with the sandbox file prefix, log suffix, daily rotation, and maximum file count. The output is an optional writer ready to receive log text.

**Call relations**: `append_line` calls this whenever a line needs to be written. By keeping the file-opening details here, the rest of the logging functions only have to think in terms of messages.

*Call graph*: called by 1 (append_line); 2 external calls (is_dir, builder).


##### `append_line`  (lines 64–70)

```
fn append_line(line: &str, base_dir: Option<&Path>)
```

**Purpose**: Writes one finished line of text to the sandbox log, if a log directory is available. It is the final step between a prepared message and bytes on disk.

**Data flow**: It receives a complete log line and an optional base directory. If there is no directory, or if a writer cannot be made, it silently does nothing; otherwise it writes the line plus a newline to the current rolling log file.

**Call relations**: `debug_log` and `log_note` both send their finished messages here. This function then asks `log_writer` for the actual file writer and performs the write.

*Call graph*: calls 1 internal fn (log_writer); called by 2 (debug_log, log_note); 1 external calls (writeln!).


##### `log_start`  (lines 72–75)

```
fn log_start(command: &[String], base_dir: Option<&Path>)
```

**Purpose**: Records that a sandbox command is beginning. This helps a later reader match an attempted action with its final success or failure.

**Data flow**: It receives the command as a list of strings and an optional log directory. It makes a shortened command preview, prefixes it with `START:`, and passes that note to `log_note`, which adds time and process details before writing.

**Call relations**: This is called by sandbox launch preparation paths, including permission-profile and spawn-context setup. It marks the beginning of work before those flows continue into actually running or preparing a sandboxed process.

*Call graph*: calls 2 internal fn (log_note, preview); called by 3 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common); 1 external calls (format!).


##### `log_success`  (lines 77–80)

```
fn log_success(command: &[String], base_dir: Option<&Path>)
```

**Purpose**: Records that a sandbox command completed successfully. It gives the log a clear positive end marker for a command that was started earlier.

**Data flow**: It receives the command and optional log directory, shortens the command text with `preview`, formats it as `SUCCESS: ...`, and sends it through `log_note` for timestamped writing.

**Call relations**: Exit-finalizing code and sandbox capture code call this when a run ends cleanly. It pairs with `log_start` and contrasts with `log_failure`, making the command lifecycle easy to read in the log.

*Call graph*: calls 2 internal fn (log_note, preview); called by 2 (finalize_exit, run_windows_sandbox_capture_with_filesystem_overrides); 1 external calls (format!).


##### `log_failure`  (lines 82–85)

```
fn log_failure(command: &[String], detail: &str, base_dir: Option<&Path>)
```

**Purpose**: Records that a sandbox command failed, along with a short reason. This is the main breadcrumb someone checks when investigating why a sandbox run did not work.

**Data flow**: It receives the command, a failure detail string, and an optional log directory. It shortens the command preview, combines it with `FAILURE:` and the detail, then gives the message to `log_note` for final formatting and writing.

**Call relations**: Exit-finalizing code and sandbox capture code call this when a run ends badly. Like `log_success`, it relies on `preview` for readable command text and `log_note` for the shared log-line format.

*Call graph*: calls 2 internal fn (log_note, preview); called by 2 (finalize_exit, run_windows_sandbox_capture_with_filesystem_overrides); 1 external calls (format!).


##### `debug_log`  (lines 88–93)

```
fn debug_log(msg: &str, base_dir: Option<&Path>)
```

**Purpose**: Writes extra troubleshooting messages only when debugging is explicitly turned on. This keeps normal logs from becoming noisy while still giving developers a way to inspect detailed behavior.

**Data flow**: It reads the `SBX_DEBUG` environment variable. If the value is exactly `1`, it writes a `DEBUG:` line to the log and also prints the message to standard error; otherwise it does nothing.

**Call relations**: Lower-level operations such as user loading, marker loading, desktop access grants, and process creation call this when they have useful diagnostic details. It hands enabled debug messages to `append_line`, bypassing the normal timestamped `log_note` format.

*Call graph*: calls 1 internal fn (append_line); called by 6 (create, grant_desktop_access, load_marker, load_users, remove_sandbox_users_file, create_process_as_user); 3 external calls (eprintln!, format!, var).


##### `log_note`  (lines 96–99)

```
fn log_note(msg: &str, base_dir: Option<&Path>)
```

**Purpose**: Writes a normal timestamped note to the daily sandbox log. Most non-debug logging flows pass through this function so log entries share one consistent shape.

**Data flow**: It receives a message and an optional log directory. It gets the local time, gets the executable label, formats a line like `[time exe] message`, and sends that finished line to `append_line` for writing.

**Call relations**: Command logging functions call this, and many sandbox operations call it directly when they need to record important actions such as permission changes, helper resolution, profile hiding, or writable-directory audits. It is the central formatter for ordinary log entries.

*Call graph*: calls 1 internal fn (append_line); called by 16 (apply_capability_denies_for_world_writable_for_permissions, apply_world_writable_scan_and_denies_for_permissions, audit_everyone_writable, copy_helper_if_needed, resolve_current_exe_for_launch, resolve_helper_for_launch, hide_current_user_profile_dir, hide_newly_created_users, hide_users_in_winlogon, require_logon_sandbox_creds (+6 more)); 2 external calls (now, format!).


##### `tests::preview_does_not_panic_on_utf8_boundary`  (lines 106–114)

```
fn preview_does_not_panic_on_utf8_boundary()
```

**Purpose**: Checks that command preview shortening does not crash when a long command contains a multi-byte character. This protects against a common text-cutting bug where bytes are split in the middle of one visible character.

**Data flow**: It builds a command string that places an emoji right where unsafe byte trimming would fail. It runs `preview` inside a panic catcher, then verifies the call succeeded and the result stayed within the preview limit.

**Call relations**: This test exercises `preview` directly. It exists because `log_start`, `log_success`, and `log_failure` depend on `preview` to safely shorten command text before logging.

*Call graph*: 3 external calls (assert!, catch_unwind, vec!).


##### `tests::log_note_writes_to_daily_rolling_log`  (lines 117–138)

```
fn log_note_writes_to_daily_rolling_log()
```

**Purpose**: Checks that a normal note really creates a daily log file and writes the message into it. This proves the logging path works end to end on disk.

**Data flow**: It creates a temporary directory, calls `log_note` with a sample message, reads the directory entries, checks that one log file was created with the expected name shape, then reads the file and confirms the message is present.

**Call relations**: This test drives `log_note`, which in turn uses `append_line` and `log_writer`. It verifies that the formatting and rolling-file writer cooperate to produce an actual readable log file.

*Call graph*: calls 1 internal fn (log_note); 5 external calls (assert!, assert_eq!, read_dir, read_to_string, tempdir).


##### `tests::log_file_path_for_utc_date_matches_rolling_appender_name`  (lines 141–148)

```
fn log_file_path_for_utc_date_matches_rolling_appender_name()
```

**Purpose**: Checks that the helper for building a dated log path uses the same naming pattern as the rolling log writer. This prevents code from looking for a file under a name that logging would never create.

**Data flow**: It creates a fixed date, asks `log_file_path_for_utc_date` for the path under `logs`, and compares the result to the expected `logs/sandbox.2026-05-21.log` path.

**Call relations**: This test covers `log_file_path_for_utc_date`, the helper used by `current_log_file_path`. It guards the shared file naming convention used across the logging code.

*Call graph*: 2 external calls (assert_eq!, from_ymd_opt).


##### `tests::current_log_file_path_for_codex_home_uses_sandbox_dir`  (lines 151–158)

```
fn current_log_file_path_for_codex_home_uses_sandbox_dir()
```

**Purpose**: Checks that a Codex home directory is converted into the sandbox subdirectory before choosing the current log file path. This protects the expected log location convention.

**Data flow**: It starts with a sample Codex home path. It compares `current_log_file_path_for_codex_home` against the path produced by calling `current_log_file_path` on `codex-home/.sandbox`.

**Call relations**: This test exercises the wrapper `current_log_file_path_for_codex_home`. It confirms that the wrapper delegates to the common current-log-path helper after applying the sandbox directory rule.

*Call graph*: 2 external calls (new, assert_eq!).

## 📊 State Registers Touched

- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-rate-limit-quota` — The current account limits, credit status, token usage, and reset information used to avoid overusing backend services.
- `reg-state-databases` — The opened local SQLite stores and migration state that hold structured runtime data for threads, agents, goals, jobs, and summaries.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-remote-control-relay` — The remote-control, relay, socket, WebSocket, and encrypted connection state used to connect clients and helper processes.
- `reg-network-proxy-policy` — The managed proxy and network-forwarding state that decides what network traffic is allowed, forwarded, or blocked.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-process-registry` — The shared record of running or tracked external processes, their identifiers, input/output streams, terminal sizes, and completion state.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-turn-state` — The shared clipboard for one active assistant turn, tracking the current task, pending replies, granted permissions, cancellations, and bookkeeping.
- `reg-conversation-history-budget` — The accumulated messages, compacted summaries, token counts, and trimming decisions that determine what conversation context still fits.
- `reg-prompt-context-stack` — The assembled prompt ingredients, including project instructions, permissions text, goals, memories, skills, plugin text, IDE details, warnings, and changed context.
- `reg-tool-catalog` — The current set of tools the model may call, with schemas, names, MCP conversions, plugin additions, and execution handlers.
- `reg-hook-rules` — The configured hooks and hook schemas that let external commands inspect or affect session starts, turns, tool calls, and other lifecycle events.
- `reg-agent-registry-graph` — The live and persisted map of parent agents, child agents, thread names, statuses, and which helper agents are still open.
- `reg-background-work-queues` — The shared set of background tasks such as cloud refreshes, cleanup jobs, memory jobs, skill watchers, agent jobs, update checks, and session maintenance.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-launch-invocation-context` — The raw launch context, including invoked binary/arg0, selected subcommand or runtime mode, startup flags, and output/interaction mode chosen before dispatch.
