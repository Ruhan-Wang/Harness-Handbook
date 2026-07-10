# Cross-cutting observability, analytics, and feedback  `stage-20` (cross-cutting infrastructure)

This stage is the system’s shared “flight recorder and dashboard.” It is not one single step like startup or shutdown. Instead, it runs across the whole app, quietly watching what happens, measuring it, and saving useful clues for later.

One part turns raw observations into analytics events and sends them out in a cleaner, safer form. Another sets up the OpenTelemetry instrument panel, which provides traces, logs, and metrics: linked activity records, text notes, and numeric measurements. Session telemetry then stamps those signals with session and feature details, so one user turn or tool call can be followed end to end.

Rollout tracing keeps a richer black-box recording of important runtime events and can later replay them into a readable story of what happened. Feedback and debug capture gather logs, safe diagnostics, and redacted artifacts for bug reports, while local log persistence stores tracing data in SQLite and trims old entries.

Finally, windows-sandbox-rs/src/logging.rs adds simple rolling daily logs for sandbox commands, recording starts, successes, failures, and optional debug notes. Together, these parts make the system observable and debuggable without carelessly exposing secrets.

## Sub-stages

- [Analytics event modeling, reduction, and emitters](stage-20.1.md) `stage-20.1` — 8 files
- [OpenTelemetry runtime, provider, and metrics foundations](stage-20.2.md) `stage-20.2` — 22 files
- [Session telemetry and feature-specific instrumentation](stage-20.3.md) `stage-20.3` — 16 files
- [Rollout trace recording, schema, and replay reducers](stage-20.4.md) `stage-20.4` — 24 files
- [Feedback capture, debug artifacts, and log persistence](stage-20.5.md) `stage-20.5` — 10 files

## Files in this stage

### Cross-cutting observability, analytics, and feedback
### `windows-sandbox-rs/src/logging.rs`

`util` · `cross-cutting during setup, launch, and runtime diagnostics`

This file is the sandbox crate's small logging layer. It writes plain text lines into daily-rotated files using `tracing_appender::rolling::RollingFileAppender`, with filenames like `sandbox.YYYY-MM-DD.log` and a retention cap of 90 files. `log_file_path_for_utc_date`, `current_log_file_path`, and `current_log_file_path_for_codex_home` expose the naming convention and the default `.sandbox` log directory under `codex_home`.

For message formatting, `exe_label` lazily caches the current executable's filename in a `OnceLock<String>` and falls back to `proc` if discovery fails. `preview` joins a command vector into a single string and truncates it to `LOG_COMMAND_PREVIEW_LIMIT` bytes using `take_bytes_at_char_boundary`, which avoids splitting UTF-8 code points. `append_line` is the low-level writer: if the base directory exists and a rolling appender can be built, it appends a single line and ignores write failures.

The public logging API is intentionally narrow. `log_start`, `log_success`, and `log_failure` format command-oriented messages using `preview` and route them through `log_note`. `log_note` always writes a timestamped line with local time and the executable label. `debug_log` is gated by `SBX_DEBUG=1`; when enabled it writes a `DEBUG:` line to the log and also echoes the raw message to stderr. Tests verify UTF-8-safe preview truncation, actual file creation for `log_note`, and path naming helpers.

#### Function details

##### `exe_label`  (lines 15–23)

```
fn exe_label() -> &'static str
```

**Purpose**: Computes and caches the current executable's filename for inclusion in log lines. It falls back to `proc` if the executable path cannot be determined.

**Data flow**: It uses a `OnceLock<String>` to initialize the label once per process. During initialization it calls `std::env::current_exe()`, extracts the file name if possible, converts it to an owned string, and stores it; subsequent calls return the cached string reference.

**Call relations**: It is used by `log_note` to annotate every log line with the emitting executable. Caching avoids repeated filesystem/process queries during frequent logging.

*Call graph*: 1 external calls (new).


##### `preview`  (lines 25–32)

```
fn preview(command: &[String]) -> String
```

**Purpose**: Builds a bounded-length printable preview of a command vector for log messages. It preserves UTF-8 validity when truncating long commands.

**Data flow**: It takes a slice of command strings, joins them with spaces, and compares the resulting string length to `LOG_COMMAND_PREVIEW_LIMIT`. If short enough it returns the full joined string; otherwise it truncates at a character boundary using `take_bytes_at_char_boundary` and returns the shortened string.

**Call relations**: It is called by `log_start`, `log_success`, and `log_failure` before those functions format their final messages. This keeps command-oriented logs compact and safe for arbitrary Unicode input.

*Call graph*: called by 3 (log_failure, log_start, log_success); 1 external calls (take_bytes_at_char_boundary).


##### `log_file_path_for_utc_date`  (lines 34–40)

```
fn log_file_path_for_utc_date(base_dir: &Path, date: chrono::NaiveDate) -> PathBuf
```

**Purpose**: Constructs the exact daily log filename for a given UTC date under a base directory. It encodes the crate's rolling log naming convention.

**Data flow**: It takes a base directory path and a `chrono::NaiveDate`, formats the filename as `sandbox.<YYYY-MM-DD>.log`, joins it to `base_dir`, and returns the resulting `PathBuf`.

**Call relations**: It is used by `current_log_file_path` and tested directly against the expected filename format. This helper keeps path construction consistent with the rolling appender configuration.

*Call graph*: called by 1 (current_log_file_path); 2 external calls (join, format!).


##### `current_log_file_path`  (lines 42–44)

```
fn current_log_file_path(base_dir: &Path) -> PathBuf
```

**Purpose**: Returns the path of today's sandbox log file in a given directory. It is a convenience wrapper around the date-specific path helper.

**Data flow**: It takes a base directory path, obtains the current UTC date via `chrono::Utc::now().date_naive()`, passes that date to `log_file_path_for_utc_date`, and returns the resulting `PathBuf`.

**Call relations**: It is used by `current_log_file_path_for_codex_home` and other setup code that needs to know where today's log file should live. It does not itself create the file.

*Call graph*: calls 1 internal fn (log_file_path_for_utc_date); called by 2 (current_log_file_path_for_codex_home, run_setup_refresh_inner); 1 external calls (now).


##### `current_log_file_path_for_codex_home`  (lines 46–48)

```
fn current_log_file_path_for_codex_home(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes today's sandbox log file path for a given `codex_home`. It anchors logging under the crate's standard sandbox directory.

**Data flow**: It takes `codex_home`, computes `crate::sandbox_dir(codex_home)`, passes that directory to `current_log_file_path`, and returns the resulting path.

**Call relations**: It is a convenience helper for callers that know only `codex_home`. This keeps log-path derivation aligned with the rest of the sandbox directory layout.

*Call graph*: calls 1 internal fn (current_log_file_path); 1 external calls (sandbox_dir).


##### `log_writer`  (lines 50–62)

```
fn log_writer(base_dir: &Path) -> Option<RollingFileAppender>
```

**Purpose**: Builds a daily rolling file appender for a log directory if that directory already exists. It returns `None` instead of creating directories or surfacing builder errors.

**Data flow**: It takes a base directory path, checks `is_dir()`, and if true configures a `RollingFileAppender` builder with daily rotation, the `sandbox` prefix, `log` suffix, and `MAX_LOG_FILES` retention. It returns `Some(appender)` on successful build or `None` if the directory is absent or appender construction fails.

**Call relations**: It is used only by `append_line`. By returning `Option`, it lets higher-level logging stay best-effort and side-effect-light.

*Call graph*: called by 1 (append_line); 2 external calls (is_dir, builder).


##### `append_line`  (lines 64–70)

```
fn append_line(line: &str, base_dir: Option<&Path>)
```

**Purpose**: Appends a single formatted line to the rolling sandbox log if logging is possible. It is the low-level sink behind note and debug logging.

**Data flow**: It takes a line string and an optional base directory. If a directory is provided and `log_writer(dir)` succeeds, it writes the line plus newline with `writeln!`; any write failure is ignored. It returns no value.

**Call relations**: It is called by `debug_log` and `log_note`. Those higher-level functions are responsible for formatting timestamps and prefixes before handing off to this sink.

*Call graph*: calls 1 internal fn (log_writer); called by 2 (debug_log, log_note); 1 external calls (writeln!).


##### `log_start`  (lines 72–75)

```
fn log_start(command: &[String], base_dir: Option<&Path>)
```

**Purpose**: Logs a standardized `START:` line for a command invocation. It uses the bounded command preview rather than the full command vector.

**Data flow**: It takes a command slice and optional base directory, computes `preview(command)`, formats `START: <preview>`, and passes that message to `log_note`.

**Call relations**: It is called by spawn-preparation and elevated capture code at the beginning of command execution. It delegates all timestamping and file writing to `log_note`.

*Call graph*: calls 2 internal fn (log_note, preview); called by 3 (run_windows_sandbox_capture_for_permission_profile, prepare_elevated_spawn_context_for_permissions, prepare_spawn_context_common); 1 external calls (format!).


##### `log_success`  (lines 77–80)

```
fn log_success(command: &[String], base_dir: Option<&Path>)
```

**Purpose**: Logs a standardized `SUCCESS:` line for a command that exited successfully. It mirrors `log_start` and `log_failure` formatting.

**Data flow**: It takes a command slice and optional base directory, computes the preview string, formats `SUCCESS: <preview>`, and sends it to `log_note`.

**Call relations**: It is called by capture/finalization code when a sandboxed command exits with code 0. It is the success-side counterpart to `log_failure`.

*Call graph*: calls 2 internal fn (log_note, preview); called by 2 (finalize_exit, run_windows_sandbox_capture_with_filesystem_overrides); 1 external calls (format!).


##### `log_failure`  (lines 82–85)

```
fn log_failure(command: &[String], detail: &str, base_dir: Option<&Path>)
```

**Purpose**: Logs a standardized `FAILURE:` line for a command that failed, including a caller-supplied detail string such as an exit code. It keeps failure formatting consistent across backends.

**Data flow**: It takes a command slice, a detail string, and an optional base directory, computes the preview string, formats `FAILURE: <preview> (<detail>)`, and passes it to `log_note`.

**Call relations**: It is called by capture/finalization code when a sandboxed command exits nonzero or otherwise fails. It shares the same preview path as `log_start` and `log_success`.

*Call graph*: calls 2 internal fn (log_note, preview); called by 2 (finalize_exit, run_windows_sandbox_capture_with_filesystem_overrides); 1 external calls (format!).


##### `debug_log`  (lines 88–93)

```
fn debug_log(msg: &str, base_dir: Option<&Path>)
```

**Purpose**: Emits debug-only diagnostics to both the sandbox log and stderr when `SBX_DEBUG=1`. It is intentionally silent unless explicitly enabled.

**Data flow**: It takes a message string and optional base directory, reads `SBX_DEBUG` from the process environment, and if the value is exactly `1` formats `DEBUG: <msg>`, appends it via `append_line`, and writes the raw message to stderr with `eprintln!`. Otherwise it does nothing.

**Call relations**: It is used by setup, process creation, and state-loading code for noisy diagnostics that should not appear in normal logs. It delegates file output to `append_line` and supplements it with stderr for immediate visibility.

*Call graph*: calls 1 internal fn (append_line); called by 6 (create, grant_desktop_access, load_marker, load_users, remove_sandbox_users_file, create_process_as_user); 3 external calls (eprintln!, format!, var).


##### `log_note`  (lines 96–99)

```
fn log_note(msg: &str, base_dir: Option<&Path>)
```

**Purpose**: Writes an unconditional timestamped note line to the sandbox log. It is the common sink for most human-readable operational messages.

**Data flow**: It takes a message string and optional base directory, computes a local timestamp with millisecond precision, obtains the executable label from `exe_label()`, formats `[<timestamp> <exe>] <msg>`, and passes the line to `append_line`.

**Call relations**: It is called widely across the crate, including helper materialization, user hiding, setup, and command lifecycle logging. Higher-level helpers like `log_start` and `log_failure` build on it rather than writing directly.

*Call graph*: calls 1 internal fn (append_line); called by 16 (apply_capability_denies_for_world_writable_for_permissions, apply_world_writable_scan_and_denies_for_permissions, audit_everyone_writable, copy_helper_if_needed, resolve_current_exe_for_launch, resolve_helper_for_launch, hide_current_user_profile_dir, hide_newly_created_users, hide_users_in_winlogon, require_logon_sandbox_creds (+6 more)); 2 external calls (now, format!).


##### `tests::preview_does_not_panic_on_utf8_boundary`  (lines 106–114)

```
fn preview_does_not_panic_on_utf8_boundary()
```

**Purpose**: Verifies that command preview truncation never panics when the truncation point would otherwise split a multibyte UTF-8 character. It specifically targets the byte-boundary safety guarantee.

**Data flow**: The test constructs a command string whose final character is a 4-byte emoji positioned at the preview limit boundary, runs `preview` inside `catch_unwind`, asserts that no panic occurred, unwraps the result, and asserts that the preview length does not exceed the configured limit.

**Call relations**: It directly validates the use of `take_bytes_at_char_boundary` inside `preview`. This protects logging from malformed truncation on Unicode-heavy commands.

*Call graph*: 3 external calls (assert!, catch_unwind, vec!).


##### `tests::log_note_writes_to_daily_rolling_log`  (lines 117–138)

```
fn log_note_writes_to_daily_rolling_log()
```

**Purpose**: Checks that `log_note` actually creates a daily log file and writes the provided message into it. It exercises the rolling-appender path end to end.

**Data flow**: The test creates a temporary directory, calls `log_note("hello daily log", Some(tempdir.path()))`, reads the directory entries, asserts that exactly one log file exists with the expected prefix/suffix pattern, reads the file contents, and asserts that the message text is present.

**Call relations**: It validates the interaction between `log_note`, `append_line`, and `log_writer`. This ensures the best-effort logging path works when given a valid directory.

*Call graph*: calls 1 internal fn (log_note); 5 external calls (assert!, assert_eq!, read_dir, read_to_string, tempdir).


##### `tests::log_file_path_for_utc_date_matches_rolling_appender_name`  (lines 141–148)

```
fn log_file_path_for_utc_date_matches_rolling_appender_name()
```

**Purpose**: Verifies that the helper for computing log file paths matches the naming convention used by the rolling appender. It pins down the exact filename format.

**Data flow**: The test constructs a fixed `NaiveDate`, calls `log_file_path_for_utc_date(Path::new("logs"), date)`, and asserts that the result equals `logs/sandbox.2026-05-21.log`.

**Call relations**: It directly covers `log_file_path_for_utc_date`. This keeps path helpers and appender configuration from drifting apart.

*Call graph*: 2 external calls (assert_eq!, from_ymd_opt).


##### `tests::current_log_file_path_for_codex_home_uses_sandbox_dir`  (lines 151–158)

```
fn current_log_file_path_for_codex_home_uses_sandbox_dir()
```

**Purpose**: Checks that codex-home-based log path resolution uses the `.sandbox` directory. It validates the directory-layout assumption behind sandbox logging.

**Data flow**: The test creates a sample `codex_home` path, calls `current_log_file_path_for_codex_home(codex_home)`, and asserts that it equals `current_log_file_path(&codex_home.join(".sandbox"))`.

**Call relations**: It covers the wrapper around `sandbox_dir` plus `current_log_file_path`. This ensures callers using only `codex_home` land in the expected log directory.

*Call graph*: 2 external calls (new, assert_eq!).

## 📊 State Registers Touched

- `reg-installation-id` — A stable local identifier for this installation that lets services and logs recognize the same app install over time.
- `reg-state-runtime` — The shared local database runtime that gives the rest of the system access to its SQLite-backed state services.
- `reg-telemetry-context` — The shared tracing and session-telemetry context that stamps logs, traces, and metrics with the right runtime identity.
- `reg-rollout-trace-log` — The richer event recording stream that keeps a replayable story of important runtime activity.
- `reg-local-log-store` — The persisted local logs and tracing database used for diagnostics, replay, trimming, and bug-report capture.
- `reg-feedback-and-debug-bundles` — The collected redacted logs, diagnostics, and thread context prepared for feedback reports and debugging.
- `reg-analytics-event-buffer` — The in-memory stream/buffer of normalized analytics facts and pending analytics events awaiting reduction, batching, or emission.
- `reg-opentelemetry-runtime` — The global OpenTelemetry exporter/runtime setup that holds active log, trace, and metric pipelines across the process.
- `reg-rolling-sandbox-logs` — The rolling daily log state for Windows sandbox command activity, recording starts, outcomes, and optional debug notes across runs.
- `reg-analytics-review-context` — The carried guardian-review analytics timing and session context that spans review/tool phases until analytics emission.
