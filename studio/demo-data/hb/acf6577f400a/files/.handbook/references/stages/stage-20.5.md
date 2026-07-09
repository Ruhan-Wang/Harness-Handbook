# Feedback capture, debug artifacts, and log persistence  `stage-20.5`

This stage is cross-cutting diagnostics and persistence infrastructure: it sits alongside normal request handling and UI execution, capturing evidence about what happened without becoming part of the critical path. At its center, feedback/src/lib.rs assembles in-memory feedback records—logs, request/auth tags, and optional attachments—and exposes tracing layers and writers so other components can feed data into feedback uploads transparently. feedback_diagnostics.rs and app-server/src/request_processors/feedback_doctor_report.rs contribute optional attachments: narrow proxy-environment diagnostics and a best-effort, redacted doctor report with low-cardinality tags.

To keep captured artifacts safe, response-debug-context/src/lib.rs extracts only non-sensitive HTTP error metadata such as request IDs, Cloudflare ray IDs, and auth failure details, while secrets/src/sanitizer.rs redacts obvious credentials before anything is logged or shown. Several file-backed capture paths preserve raw artifacts for later inspection: responses-api-proxy/src/dump.rs snapshots proxied traffic, analytics/src/analytics_capture.rs records analytics payloads, and tui/src/session_log.rs writes JSONL session activity. Finally, state/src/log_db.rs and state/src/runtime/logs.rs persist tracing events into SQLite with batching, retention, querying, and feedback-log extraction, turning transient runtime telemetry into durable debug history.

## Files in this stage

### Feedback assembly
These files build the feedback capture pipeline, enrich it with optional diagnostics, and add doctor-report attachments and tags before upload packaging.

### `feedback/src/lib.rs`

`orchestration` · `cross-cutting logging, feedback consent, and upload`

This file is the feedback subsystem’s core orchestration and storage layer. `CodexFeedback` owns an `Arc<FeedbackInner>` containing two mutex-protected stores: a byte `RingBuffer` for captured logs and a `BTreeMap<String, String>` for structured tags. It exposes two tracing integrations: `logger_layer()` builds a `tracing_subscriber::fmt` layer that writes full-fidelity logs into the ring buffer regardless of ambient `RUST_LOG`, while `metadata_layer()` installs a custom `FeedbackMetadataLayer` filtered to the `feedback_tags` target so selected tracing events become upload tags.

Structured request/auth telemetry is emitted through `emit_feedback_request_tags` and `emit_feedback_request_tags_with_auth_env`. Both first normalize optional fields into a `FeedbackRequestSnapshot`, converting absent values to empty strings and booleans/integers to strings where needed, then log them as debug fields on a `feedback_tags` event. `FeedbackTagsVisitor` later captures those fields into strings, and `FeedbackMetadataLayer::on_event` merges them into the bounded tag map, preserving existing keys once `MAX_FEEDBACK_TAGS` is reached.

`CodexFeedback::snapshot` freezes the current ring buffer bytes and tags, collects environment-based `FeedbackDiagnostics`, and assigns a thread identifier, generating a synthetic `no-active-thread-...` ID when none is active. The resulting `FeedbackSnapshot` can be saved to a temp file or uploaded directly. `upload_feedback` constructs a Sentry client from the hard-coded DSN, derives upload tags while protecting reserved keys, chooses event severity from the classification, optionally attaches the reason as an exception payload, and appends attachments in a fixed order: logs, in-memory extras, connectivity diagnostics, then file-backed extras. File-backed attachment read failures are logged and skipped rather than aborting the upload. The ring buffer itself is intentionally simple: it keeps only the newest `max` bytes, dropping from the front or replacing the whole buffer with the trailing slice when a single write exceeds capacity.

#### Function details

##### `FeedbackRequestSnapshot::from_tags`  (lines 77–102)

```
fn from_tags(tags: &'a FeedbackRequestTags<'a>) -> Self
```

**Purpose**: Normalizes optional request/auth telemetry fields into a snapshot with concrete string values suitable for tracing and upload tags.

**Data flow**: Reads a borrowed `FeedbackRequestTags`, copies required fields directly, replaces missing optional `&str` fields with `""`, and converts optional booleans and integers into strings via `to_string()` or empty strings when absent. It returns a `FeedbackRequestSnapshot` borrowing the original string slices where possible.

**Call relations**: Used by both request-tag emission functions so they share one normalization policy before logging structured metadata.

*Call graph*: called by 2 (emit_feedback_request_tags, emit_feedback_request_tags_with_auth_env).


##### `emit_feedback_request_tags`  (lines 105–124)

```
fn emit_feedback_request_tags(tags: &FeedbackRequestTags<'_>)
```

**Purpose**: Emits a structured tracing event containing request/auth metadata for later capture by the feedback metadata layer.

**Data flow**: Takes `&FeedbackRequestTags`, builds a normalized `FeedbackRequestSnapshot` via `from_tags`, and logs a `tracing::info!` event targeted at `FEEDBACK_TAGS_TARGET` with each field recorded through `tracing::field::debug`.

**Call relations**: Called by request/auth code paths that want feedback uploads to include structured request context; the event is later consumed by `FeedbackMetadataLayer::on_event`.

*Call graph*: calls 1 internal fn (from_tags); 1 external calls (info!).


##### `emit_feedback_request_tags_with_auth_env`  (lines 126–161)

```
fn emit_feedback_request_tags_with_auth_env(
    tags: &FeedbackRequestTags<'_>,
    auth_env: &AuthEnvTelemetry,
)
```

**Purpose**: Emits the same structured request/auth metadata as `emit_feedback_request_tags`, plus safe buckets describing auth-related environment configuration.

**Data flow**: Builds a `FeedbackRequestSnapshot` from `tags`, reads fields from `AuthEnvTelemetry`, converts optional booleans to strings where needed, and logs one `feedback_tags` tracing event containing both request fields and auth-env fields.

**Call relations**: Used when the caller has additional auth-environment telemetry available and wants it attached to feedback alongside request metadata.

*Call graph*: calls 1 internal fn (from_tags); 1 external calls (info!).


##### `CodexFeedback::default`  (lines 169–171)

```
fn default() -> Self
```

**Purpose**: Provides the default feedback collector using the standard ring-buffer capacity.

**Data flow**: Delegates directly to `CodexFeedback::new()` and returns the resulting instance.

**Call relations**: Implements `Default` so callers and tests can construct feedback capture without specifying capacity.

*Call graph*: 1 external calls (new).


##### `CodexFeedback::new`  (lines 175–177)

```
fn new() -> Self
```

**Purpose**: Creates a feedback collector with the default maximum log-buffer size.

**Data flow**: Calls `with_capacity(DEFAULT_MAX_BYTES)` and returns the resulting `CodexFeedback`.

**Call relations**: This is the normal constructor used throughout the application and tests.

*Call graph*: called by 30 (runtime_start_args_forward_environment_manager, runtime_start_args_use_remote_thread_config_loader_when_configured, start_test_client_with_capacity, start_test_client_with_capacity, build_test_processor, run_main_with_transport_options, get_conversation_summary_by_thread_id_reads_pathless_store_thread, mcp_resource_read_returns_error_for_unknown_thread, start_in_process_client, thread_list_includes_store_thread_without_rollout_path (+15 more)); 1 external calls (with_capacity).


##### `CodexFeedback::with_capacity`  (lines 179–183)

```
fn with_capacity(max_bytes: usize) -> Self
```

**Purpose**: Creates a feedback collector with a caller-specified ring-buffer size.

**Data flow**: Allocates a new `FeedbackInner` with `FeedbackInner::new(max_bytes)`, wraps it in `Arc`, and stores it in `CodexFeedback`.

**Call relations**: Used by tests that need small deterministic capacities to exercise ring-buffer eviction behavior.

*Call graph*: calls 1 internal fn (new); called by 1 (ring_buffer_drops_front_when_full); 1 external calls (new).


##### `CodexFeedback::make_writer`  (lines 185–189)

```
fn make_writer(&self) -> FeedbackMakeWriter
```

**Purpose**: Returns a `MakeWriter` adapter that writes tracing output into this feedback collector’s ring buffer.

**Data flow**: Clones the inner `Arc<FeedbackInner>` into a `FeedbackMakeWriter` and returns it.

**Call relations**: Consumed by `logger_layer()` and any other tracing setup that needs a writer factory.

*Call graph*: called by 1 (logger_layer).


##### `CodexFeedback::logger_layer`  (lines 196–208)

```
fn logger_layer(&self) -> impl Layer<S> + Send + Sync + 'static
```

**Purpose**: Builds a tracing subscriber layer that captures formatted logs into the feedback ring buffer at full verbosity.

**Data flow**: Creates a `tracing_subscriber::fmt::layer()`, configures it with `self.make_writer()`, system-time timestamps, no ANSI, no target field, and a `Targets` filter whose default level is `TRACE`, then returns the configured layer.

**Call relations**: Installed during application initialization so feedback snapshots contain complete logs independent of user logging configuration.

*Call graph*: calls 1 internal fn (make_writer); 2 external calls (new, layer).


##### `CodexFeedback::metadata_layer`  (lines 214–222)

```
fn metadata_layer(&self) -> impl Layer<S> + Send + Sync + 'static
```

**Purpose**: Builds a tracing layer that captures structured `feedback_tags` events into the feedback tag map.

**Data flow**: Constructs `FeedbackMetadataLayer { inner: self.inner.clone() }` and applies a `Targets` filter that only accepts the `FEEDBACK_TAGS_TARGET` target at `TRACE` level.

**Call relations**: Installed alongside `logger_layer()` so request/auth metadata emitted through `emit_feedback_request_tags*` is retained for uploads.

*Call graph*: 1 external calls (new).


##### `CodexFeedback::snapshot`  (lines 224–243)

```
fn snapshot(&self, session_id: Option<ThreadId>) -> FeedbackSnapshot
```

**Purpose**: Freezes the current captured logs, tags, and environment diagnostics into an immutable upload-ready snapshot.

**Data flow**: Locks the ring-buffer mutex and copies bytes via `snapshot_bytes()`, locks the tags mutex and clones the `BTreeMap`, collects `FeedbackDiagnostics::collect_from_env()`, and computes `thread_id` from the optional `ThreadId` argument or a generated `no-active-thread-<new id>` fallback. It returns a `FeedbackSnapshot` containing all of that data.

**Call relations**: Called when opening feedback consent or preparing an upload response so the mutable live collector becomes a stable point-in-time artifact.

*Call graph*: calls 2 internal fn (collect_from_env, new); called by 2 (upload_feedback_response, open_feedback_consent).


##### `FeedbackInner::new`  (lines 252–257)

```
fn new(max_bytes: usize) -> Self
```

**Purpose**: Initializes the shared mutable state behind `CodexFeedback`.

**Data flow**: Creates a `RingBuffer::new(max_bytes)` wrapped in `Mutex`, creates an empty `BTreeMap<String, String>` wrapped in `Mutex`, and returns `FeedbackInner`.

**Call relations**: Used only by `CodexFeedback::with_capacity` during collector construction.

*Call graph*: calls 1 internal fn (new); called by 1 (with_capacity); 2 external calls (new, new).


##### `FeedbackMakeWriter::make_writer`  (lines 268–272)

```
fn make_writer(&'a self) -> Self::Writer
```

**Purpose**: Creates a concrete writer instance for one tracing write stream.

**Data flow**: Clones the shared `Arc<FeedbackInner>` into a new `FeedbackWriter` and returns it.

**Call relations**: Called by tracing subscriber infrastructure whenever it needs a writer for log formatting.


##### `FeedbackWriter::write`  (lines 280–284)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Appends formatted log bytes into the shared feedback ring buffer.

**Data flow**: Locks `self.inner.ring`, maps lock poisoning to `io::ErrorKind::Other`, pushes the provided byte slice into the `RingBuffer` via `push_bytes`, and returns `Ok(buf.len())`.

**Call relations**: This is the sink used by the tracing fmt layer configured in `logger_layer()`.


##### `FeedbackWriter::flush`  (lines 286–288)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Implements a no-op flush for the in-memory feedback writer.

**Data flow**: Ignores all state and returns `Ok(())`.

**Call relations**: Required by the `Write` trait; tracing may call it, but there is no buffered OS resource to flush.


##### `RingBuffer::new`  (lines 297–302)

```
fn new(capacity: usize) -> Self
```

**Purpose**: Creates an empty byte ring buffer with a fixed maximum capacity.

**Data flow**: Stores the requested `capacity` in `max` and allocates a `VecDeque<u8>` with that capacity.

**Call relations**: Used by `FeedbackInner::new` to back log capture.

*Call graph*: called by 1 (new); 1 external calls (with_capacity).


##### `RingBuffer::len`  (lines 304–306)

```
fn len(&self) -> usize
```

**Purpose**: Returns the current number of bytes stored in the ring buffer.

**Data flow**: Reads `self.buf.len()` and returns it.

**Call relations**: Used internally by `push_bytes` when deciding whether eviction is needed.

*Call graph*: called by 1 (push_bytes); 1 external calls (len).


##### `RingBuffer::push_bytes`  (lines 308–331)

```
fn push_bytes(&mut self, data: &[u8])
```

**Purpose**: Appends bytes while preserving only the newest `max` bytes of log data.

**Data flow**: Mutably borrows the buffer and first returns early for empty input. If the incoming slice length is at least `self.max`, it clears the buffer and keeps only the trailing `self.max` bytes from the new slice. Otherwise it computes `needed = self.len() + data.len()`, pops `to_drop = needed - self.max` bytes from the front if necessary, then extends the deque with the new bytes.

**Call relations**: Called by `FeedbackWriter::write`; it is the core retention policy for captured logs.

*Call graph*: calls 1 internal fn (len); 3 external calls (clear, extend, pop_front).


##### `RingBuffer::snapshot_bytes`  (lines 333–335)

```
fn snapshot_bytes(&self) -> Vec<u8>
```

**Purpose**: Copies the current ring-buffer contents into a contiguous `Vec<u8>`.

**Data flow**: Iterates over `self.buf`, copies each byte, collects them into a `Vec<u8>`, and returns it.

**Call relations**: Used by `CodexFeedback::snapshot` to freeze log contents for upload or temp-file persistence.

*Call graph*: 1 external calls (iter).


##### `FeedbackSnapshot::as_bytes`  (lines 388–390)

```
fn as_bytes(&self) -> &[u8]
```

**Purpose**: Exposes the captured log bytes as a borrowed slice.

**Data flow**: Returns `&self.bytes`.

**Call relations**: Used by `save_to_temp_file` and tests that need direct access to the captured log payload.

*Call graph*: called by 1 (save_to_temp_file).


##### `FeedbackSnapshot::feedback_diagnostics`  (lines 392–394)

```
fn feedback_diagnostics(&self) -> &FeedbackDiagnostics
```

**Purpose**: Returns the diagnostics object associated with this snapshot.

**Data flow**: Returns `&self.feedback_diagnostics` without cloning.

**Call relations**: Allows callers to inspect diagnostics separately from upload assembly.


##### `FeedbackSnapshot::with_feedback_diagnostics`  (lines 396–399)

```
fn with_feedback_diagnostics(mut self, feedback_diagnostics: FeedbackDiagnostics) -> Self
```

**Purpose**: Replaces the snapshot’s diagnostics payload and returns the modified snapshot.

**Data flow**: Consumes `self`, overwrites `self.feedback_diagnostics` with the provided `FeedbackDiagnostics`, and returns the updated snapshot.

**Call relations**: Used mainly in tests to inject deterministic diagnostics instead of environment-derived ones.


##### `FeedbackSnapshot::feedback_diagnostics_attachment_text`  (lines 401–407)

```
fn feedback_diagnostics_attachment_text(&self, include_logs: bool) -> Option<String>
```

**Purpose**: Returns the diagnostics attachment body only when logs/diagnostics are allowed to be included.

**Data flow**: If `include_logs` is false, returns `None` immediately. Otherwise delegates to `self.feedback_diagnostics.attachment_text()`.

**Call relations**: Called by `feedback_attachments` so diagnostics obey the same consent gate as logs.

*Call graph*: calls 1 internal fn (attachment_text); called by 1 (feedback_attachments).


##### `FeedbackSnapshot::save_to_temp_file`  (lines 409–415)

```
fn save_to_temp_file(&self) -> io::Result<PathBuf>
```

**Purpose**: Writes the captured log bytes to a temporary file named from the snapshot thread ID.

**Data flow**: Reads the system temp directory, formats `codex-feedback-<thread_id>.log`, joins it into a path, writes `self.as_bytes()` to that path with `fs::write`, and returns the resulting `PathBuf`.

**Call relations**: Used when feedback workflows need a file-backed log artifact instead of an in-memory upload.

*Call graph*: calls 1 internal fn (as_bytes); 3 external calls (format!, write, temp_dir).


##### `FeedbackSnapshot::upload_feedback`  (lines 418–487)

```
fn upload_feedback(&self, options: FeedbackUploadOptions<'_>) -> Result<()>
```

**Purpose**: Builds and sends a Sentry envelope containing the feedback event plus optional attachments.

**Data flow**: Creates a Sentry `Client` from `SENTRY_DSN`, derives merged tags via `upload_tags`, maps `classification` to a Sentry `Level`, creates an envelope and event title using `display_classification`, optionally adds an exception payload containing `reason`, appends attachments from `feedback_attachments`, sends the envelope, flushes with `UPLOAD_TIMEOUT_SECS`, and returns `Ok(())` or an error if DSN parsing fails.

**Call relations**: This is the top-level upload path invoked after user consent. It orchestrates tag generation, event construction, attachment assembly, and transport.

*Call graph*: calls 2 internal fn (feedback_attachments, upload_tags); 11 external calls (new, default, from_str, from_secs, new, Attachment, Event, from, from_config, format! (+1 more)).


##### `FeedbackSnapshot::upload_tags`  (lines 489–536)

```
fn upload_tags(
        &self,
        classification: &str,
        reason: Option<&str>,
        client_tags: Option<&BTreeMap<String, String>>,
        session_source: Option<&SessionSource>,
    )
```

**Purpose**: Merges reserved upload metadata, caller-supplied tags, and captured feedback tags into the final Sentry tag map.

**Data flow**: Starts a `BTreeMap` with reserved keys `thread_id`, `classification`, and `cli_version`, then conditionally inserts `session_source` and `reason`. It defines a reserved-key list and merges `client_tags` first, skipping reserved keys and preserving first-writer wins via `Entry::Vacant`; it then merges `self.tags` with the same reserved-key and vacancy rules. The final map is returned.

**Call relations**: Called by `upload_feedback` so event metadata is deterministic and reserved fields cannot be overridden by callers or captured tracing tags.

*Call graph*: called by 1 (upload_feedback); 3 external calls (from, from, env!).


##### `FeedbackSnapshot::feedback_attachments`  (lines 538–605)

```
fn feedback_attachments(
        &self,
        include_logs: bool,
        extra_attachments: &[FeedbackAttachment],
        extra_attachment_paths: &[FeedbackAttachmentPath],
        logs_override:
```

**Purpose**: Builds the ordered list of Sentry attachments for one feedback upload.

**Data flow**: Starts with an empty vector. If `include_logs` is true, it pushes `codex-logs.log` using `logs_override` or `self.bytes`. It then clones each in-memory `extra_attachments` into Sentry attachments, optionally adds the diagnostics attachment from `feedback_diagnostics_attachment_text(include_logs)`, and finally iterates `extra_attachment_paths`, reading each file from disk. Read failures emit a warning and skip that attachment; successful reads choose either `attachment_filename_override`, the path basename, or `extra-log.log` as filename. It returns the assembled vector.

**Call relations**: Used by `upload_feedback`; it encapsulates consent gating, attachment ordering, and best-effort handling of file-backed artifacts.

*Call graph*: calls 1 internal fn (feedback_diagnostics_attachment_text); called by 1 (upload_feedback); 5 external calls (from, new, iter, read, warn!).


##### `display_classification`  (lines 608–616)

```
fn display_classification(classification: &str) -> String
```

**Purpose**: Maps internal feedback classification codes to human-readable title text.

**Data flow**: Matches the input string and returns `Bug`, `Bad result`, `Good result`, `Safety check`, or `Other` as a new `String`.

**Call relations**: Used by `upload_feedback` when constructing the Sentry event title.


##### `FeedbackMetadataLayer::on_event`  (lines 627–648)

```
fn on_event(&self, event: &Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>)
```

**Purpose**: Consumes `feedback_tags` tracing events and merges their fields into the shared feedback tag map.

**Data flow**: Checks `event.metadata().target()` and returns early unless it equals `FEEDBACK_TAGS_TARGET`. It records the event into a fresh `FeedbackTagsVisitor`; if no tags were captured it returns. Otherwise it locks `self.inner.tags` and inserts each `(key, value)`, but if the map already has `MAX_FEEDBACK_TAGS` distinct keys it only allows updates to existing keys and skips new ones.

**Call relations**: Runs inside the tracing subscriber pipeline created by `metadata_layer()`, turning emitted request/auth events into uploadable tags.

*Call graph*: 3 external calls (default, metadata, record).


##### `FeedbackTagsVisitor::record_i64`  (lines 657–660)

```
fn record_i64(&mut self, field: &tracing::field::Field, value: i64)
```

**Purpose**: Captures signed integer tracing fields as string tags.

**Data flow**: Reads the field name and integer value, converts the value to `String`, and inserts it into `self.tags` under the field name.

**Call relations**: Called by tracing’s field-recording machinery when `FeedbackMetadataLayer` records an event.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_u64`  (lines 662–665)

```
fn record_u64(&mut self, field: &tracing::field::Field, value: u64)
```

**Purpose**: Captures unsigned integer tracing fields as string tags.

**Data flow**: Converts the `u64` value to string and inserts it into `self.tags` keyed by the field name.

**Call relations**: Part of the visitor implementation used during metadata capture.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_bool`  (lines 667–670)

```
fn record_bool(&mut self, field: &tracing::field::Field, value: bool)
```

**Purpose**: Captures boolean tracing fields as string tags.

**Data flow**: Converts the boolean to `"true"` or `"false"` and inserts it under the field name.

**Call relations**: Used when request/auth metadata includes booleans such as auth-header presence or connection reuse.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_f64`  (lines 672–675)

```
fn record_f64(&mut self, field: &tracing::field::Field, value: f64)
```

**Purpose**: Captures floating-point tracing fields as string tags.

**Data flow**: Converts the `f64` to string and stores it in `self.tags` under the field name.

**Call relations**: Completes numeric field support for generic tracing events.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_str`  (lines 677–680)

```
fn record_str(&mut self, field: &tracing::field::Field, value: &str)
```

**Purpose**: Captures string tracing fields directly as owned string tags.

**Data flow**: Copies the field name and string value into `self.tags`.

**Call relations**: Used for most textual request/auth metadata emitted through `feedback_tags` events.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_debug`  (lines 682–685)

```
fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug)
```

**Purpose**: Captures arbitrary debug-formatted tracing fields as string tags.

**Data flow**: Formats the debug value with `format!("{value:?}")` and inserts it under the field name.

**Call relations**: Acts as the fallback path for fields emitted with `tracing::field::debug(...)` in the request-tag helpers.

*Call graph*: 2 external calls (name, format!).


##### `tests::ring_buffer_drops_front_when_full`  (lines 700–710)

```
fn ring_buffer_drops_front_when_full()
```

**Purpose**: Verifies that the ring buffer retains only the newest bytes once capacity is exceeded.

**Data flow**: Creates a small-capacity `CodexFeedback`, writes ten bytes through its writer, snapshots it, decodes the bytes as UTF-8, and asserts only the trailing eight bytes remain.

**Call relations**: Exercises `FeedbackWriter`, `RingBuffer::push_bytes`, and snapshotting together.

*Call graph*: calls 1 internal fn (with_capacity); 1 external calls (assert_eq!).


##### `tests::metadata_layer_records_tags_from_feedback_target`  (lines 713–724)

```
fn metadata_layer_records_tags_from_feedback_target()
```

**Purpose**: Checks that `feedback_tags` tracing events are captured into snapshot tags.

**Data flow**: Creates a feedback collector, installs its `metadata_layer()` as the default subscriber, emits a `tracing::info!` event targeted at `FEEDBACK_TAGS_TARGET`, snapshots the collector, and asserts the expected tag values are present.

**Call relations**: End-to-end test of `emit`-style metadata capture through the tracing layer.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, info!, registry).


##### `tests::feedback_attachments_gate_connectivity_diagnostics`  (lines 727–795)

```
fn feedback_attachments_gate_connectivity_diagnostics()
```

**Purpose**: Verifies attachment ordering and confirms connectivity diagnostics are included only when logs are included and diagnostics are non-empty.

**Data flow**: Creates a temp file for an extra path-backed attachment, builds a snapshot with injected diagnostics, calls `feedback_attachments` with logs, one in-memory doctor-report attachment, and one path-backed attachment, then asserts filenames and buffers in order. It also builds a snapshot with empty diagnostics and asserts only the log attachment remains. Finally it removes the temp file.

**Call relations**: Exercises the attachment assembly policy in `FeedbackSnapshot::feedback_attachments`.

*Call graph*: calls 2 internal fn (new, new); 8 external calls (assert_eq!, default, format!, remove_file, write, temp_dir, from_ref, vec!).


##### `tests::upload_tags_include_client_tags_and_preserve_reserved_fields`  (lines 798–871)

```
fn upload_tags_include_client_tags_and_preserve_reserved_fields()
```

**Purpose**: Checks that upload tag merging preserves reserved fields from the snapshot/upload call while still accepting non-reserved client and captured tags.

**Data flow**: Constructs a `FeedbackSnapshot` with preexisting tags, a separate `client_tags` map containing both reserved and non-reserved keys, calls `upload_tags`, and asserts reserved keys come from the snapshot or method arguments while non-reserved keys from client tags and snapshot tags are retained.

**Call relations**: Directly validates the merge and precedence rules implemented in `FeedbackSnapshot::upload_tags`.

*Call graph*: 4 external calls (new, new, assert_eq!, default).


### `feedback/src/feedback_diagnostics.rs`

`util` · `feedback snapshot and upload preparation`

This file defines the small data model used to attach connectivity diagnostics to feedback reports. `FeedbackDiagnostics` is a wrapper around a `Vec<FeedbackDiagnostic>`, where each diagnostic has a `headline` and a list of detail lines. The only built-in collector today is proxy-environment inspection: `collect_from_env` reads the process environment and delegates to the generic `collect_from_pairs`, which accepts any iterable of key/value pairs for easy testing.

`collect_from_pairs` first normalizes the input into a `HashMap<String, String>`, then scans the fixed `PROXY_ENV_VARS` list in a stable order. For each present variable it records a detail line of the exact form `KEY = value`. If at least one proxy variable is present, it emits a single `FeedbackDiagnostic` with the headline warning that proxy environment variables may affect connectivity. Missing variables are ignored entirely; present-but-empty or whitespace-containing values are preserved verbatim rather than sanitized or validated.

The formatting path is equally simple. `attachment_text` returns `None` when there are no diagnostics, otherwise it renders a plaintext report beginning with `Connectivity diagnostics`, followed by blank line separation, bullet headlines, and indented bullet details. This makes the attachment deterministic and human-readable while avoiding any parsing complexity.

#### Function details

##### `FeedbackDiagnostics::new`  (lines 25–27)

```
fn new(diagnostics: Vec<FeedbackDiagnostic>) -> Self
```

**Purpose**: Constructs a diagnostics container from an explicit list of diagnostic entries.

**Data flow**: Consumes a `Vec<FeedbackDiagnostic>` and stores it directly in the returned `FeedbackDiagnostics`.

**Call relations**: Used by higher-level feedback tests and callers that already have diagnostics assembled and just need the wrapper type.

*Call graph*: called by 4 (feedback_attachments_gate_connectivity_diagnostics, should_show_feedback_connectivity_details_only_for_non_good_result_with_diagnostics, feedback_good_result_consent_popup_includes_connectivity_diagnostics_filename, feedback_upload_consent_popup_snapshot).


##### `FeedbackDiagnostics::collect_from_env`  (lines 29–31)

```
fn collect_from_env() -> Self
```

**Purpose**: Builds diagnostics from the current process environment.

**Data flow**: Calls `std::env::vars()` to obtain environment key/value pairs, passes them to `collect_from_pairs`, and returns the resulting `FeedbackDiagnostics`.

**Call relations**: Invoked by feedback snapshot creation so uploads automatically include environment-derived connectivity hints.

*Call graph*: called by 1 (snapshot); 2 external calls (collect_from_pairs, vars).


##### `FeedbackDiagnostics::collect_from_pairs`  (lines 33–61)

```
fn collect_from_pairs(pairs: I) -> Self
```

**Purpose**: Scans arbitrary key/value pairs for known proxy environment variables and turns them into one diagnostic entry when present.

**Data flow**: Consumes an iterable of `(K, V)` pairs, converts keys and values into owned `String`s, collects them into a `HashMap`, then iterates `PROXY_ENV_VARS` in order. For each present key it formats `"{key} = {value}"` into `proxy_details`. If that vector is non-empty, it pushes one `FeedbackDiagnostic` with a fixed headline and those details. It returns `FeedbackDiagnostics { diagnostics }`.

**Call relations**: This is the core collector used by `collect_from_env` and all tests; the generic input shape makes it easy to test without mutating real environment state.

*Call graph*: called by 4 (collect_from_pairs_ignores_absent_values, collect_from_pairs_preserves_whitespace_and_empty_values, collect_from_pairs_reports_raw_values_and_attachment, collect_from_pairs_reports_values_verbatim); 2 external calls (into_iter, new).


##### `FeedbackDiagnostics::is_empty`  (lines 63–65)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether any diagnostics were collected.

**Data flow**: Reads `self.diagnostics.is_empty()` and returns the boolean.

**Call relations**: Used by feedback consent logic to decide whether connectivity details should be shown or omitted.

*Call graph*: called by 2 (feedback_upload_consent_params, should_show_feedback_connectivity_details).


##### `FeedbackDiagnostics::diagnostics`  (lines 67–69)

```
fn diagnostics(&self) -> &[FeedbackDiagnostic]
```

**Purpose**: Exposes the collected diagnostics as an immutable slice.

**Data flow**: Returns `&self.diagnostics` without cloning or mutation.

**Call relations**: Allows callers to inspect individual diagnostics when building UI or consent parameters.

*Call graph*: called by 1 (feedback_upload_consent_params).


##### `FeedbackDiagnostics::attachment_text`  (lines 71–88)

```
fn attachment_text(&self) -> Option<String>
```

**Purpose**: Formats the collected diagnostics into the plaintext attachment body used for feedback uploads.

**Data flow**: If `self.diagnostics` is empty, returns `None`. Otherwise it builds a `Vec<String>` starting with `Connectivity diagnostics` and a blank line, appends `- {headline}` for each diagnostic, then appends `  - {detail}` for each detail line, joins with newlines, and returns `Some(String)`.

**Call relations**: Called by feedback upload assembly to create the in-memory diagnostics attachment only when there is something to send.

*Call graph*: called by 1 (feedback_diagnostics_attachment_text); 2 external calls (format!, vec!).


##### `tests::collect_from_pairs_reports_raw_values_and_attachment`  (lines 99–137)

```
fn collect_from_pairs_reports_raw_values_and_attachment()
```

**Purpose**: Verifies proxy variables are reported in deterministic order and rendered into the expected attachment text.

**Data flow**: Calls `collect_from_pairs` with mixed-case proxy keys and raw values, then asserts both the structured `FeedbackDiagnostics` value and the exact `attachment_text()` output.

**Call relations**: Exercises the main collection and formatting path end-to-end.

*Call graph*: calls 1 internal fn (collect_from_pairs); 1 external calls (assert_eq!).


##### `tests::collect_from_pairs_ignores_absent_values`  (lines 140–144)

```
fn collect_from_pairs_ignores_absent_values()
```

**Purpose**: Checks that no diagnostics are produced when no proxy variables are present.

**Data flow**: Passes an empty vector into `collect_from_pairs`, then asserts the result equals `FeedbackDiagnostics::default()` and `attachment_text()` is `None`.

**Call relations**: Covers the empty-input branch of the collector and formatter.

*Call graph*: calls 1 internal fn (collect_from_pairs); 2 external calls (new, assert_eq!).


##### `tests::collect_from_pairs_preserves_whitespace_and_empty_values`  (lines 147–161)

```
fn collect_from_pairs_preserves_whitespace_and_empty_values()
```

**Purpose**: Ensures proxy values are preserved verbatim rather than trimmed or normalized.

**Data flow**: Collects diagnostics from a single `HTTP_PROXY` pair containing leading and trailing spaces, then asserts the stored detail line includes the whitespace exactly.

**Call relations**: Protects the design choice to report raw environment values without sanitization.

*Call graph*: calls 1 internal fn (collect_from_pairs); 1 external calls (assert_eq!).


##### `tests::collect_from_pairs_reports_values_verbatim`  (lines 164–178)

```
fn collect_from_pairs_reports_values_verbatim()
```

**Purpose**: Confirms that even syntactically invalid proxy values are reported exactly as provided.

**Data flow**: Passes `HTTP_PROXY = "not a valid proxy"` into `collect_from_pairs` and asserts the resulting diagnostic detail contains that exact string.

**Call relations**: Reinforces that this module is diagnostic/reporting-only and does not validate proxy syntax.

*Call graph*: calls 1 internal fn (collect_from_pairs); 1 external calls (assert_eq!).


### `app-server/src/request_processors/feedback_doctor_report.rs`

`domain_logic` · `feedback upload`

This module intentionally runs doctor as an external subprocess instead of linking doctor internals into the app-server. `doctor_feedback_report` chooses the executable from `config.codex_self_exe` or falls back to `std::env::current_exe()`, then launches `codex doctor --json` with `kill_on_drop(true)` and a fixed 25-second timeout. Any spawn failure, timeout, missing JSON output, or JSON parse failure is logged with `tracing::warn!` and results in `None`, allowing feedback upload to continue without an attachment.

The parser is defensive about stdout shape: it searches for the first `{` and parses from there, tolerating any leading non-JSON text. If parsing succeeds, it pretty-prints the JSON for upload, falling back to the raw JSON bytes if pretty serialization somehow fails. The returned `DoctorFeedbackReport` contains both the attachment metadata (`codex-doctor-report.json`, `application/json`) and a tag map derived from the report.

`doctor_report_tags` extracts `overallStatus`, counts `ok`, `warning`, and `fail` statuses across checks, and records comma-joined ids for warning/failing checks. It supports both current object-shaped `checks` and older array-shaped reports through `check_values`. Tag values are truncated to 256 Unicode scalar values with an ellipsis to keep Sentry tag cardinality and size bounded. The included test verifies the summary/count behavior on a representative report.

#### Function details

##### `doctor_feedback_report`  (lines 37–98)

```
async fn doctor_feedback_report(config: &Config) -> Option<DoctorFeedbackReport>
```

**Purpose**: Runs the configured Codex executable as `doctor --json`, parses its JSON output, and returns a feedback attachment plus derived tags when successful.

**Data flow**: Takes `&Config`, selects an executable from `config.codex_self_exe` or `current_exe()`, builds a `tokio::process::Command` with `doctor --json` and `kill_on_drop(true)`, awaits `command.output()` under `timeout(DOCTOR_FEEDBACK_REPORT_TIMEOUT, ...)`, and logs/returns `None` on spawn or timeout failure. On success it decodes stdout lossily, finds the first `{`, trims and parses JSON into `serde_json::Value`, logs/returns `None` if no JSON or invalid JSON is found, pretty-serializes the report bytes, computes tags with `doctor_report_tags`, and returns `Some(DoctorFeedbackReport { attachment, tags })`.

**Call relations**: Called by `upload_feedback_response` when assembling feedback uploads. It delegates tag extraction to `doctor_report_tags` and keeps all doctor failures non-fatal by returning `None`.

*Call graph*: calls 1 internal fn (doctor_report_tags); called by 1 (upload_feedback_response); 6 external calls (from_utf8_lossy, new, from_str, to_vec_pretty, timeout, warn!).


##### `doctor_report_tags`  (lines 100–152)

```
fn doctor_report_tags(report: &Value) -> BTreeMap<String, String>
```

**Purpose**: Summarizes a doctor JSON report into low-cardinality tags suitable for feedback/Sentry metadata.

**Data flow**: Takes `&serde_json::Value`, initializes a `BTreeMap<String, String>`, optionally inserts `doctor_overall_status`, iterates checks via `check_values`, counts `ok`/`warning`/`fail` statuses, collects warning and failing check ids, inserts count tags, and inserts comma-joined warning/failing check lists after passing them through `truncate_tag_value`; returns the completed tag map.

**Call relations**: Used by `doctor_feedback_report` for production feedback uploads and by the unit test to verify summarization behavior.

*Call graph*: calls 2 internal fn (check_values, truncate_tag_value); called by 2 (doctor_feedback_report, doctor_report_tags_summarize_status_counts); 3 external calls (new, get, new).


##### `check_values`  (lines 155–161)

```
fn check_values(checks: &Value) -> Box<dyn Iterator<Item = &Value> + '_>
```

**Purpose**: Provides a uniform iterator over doctor checks regardless of whether the JSON report stores them as an array or an object map.

**Data flow**: Consumes `&Value checks`, returns a boxed iterator over `values.iter()` for `Value::Array`, over `values.values()` for `Value::Object`, or an empty iterator for any other JSON shape.

**Call relations**: Called only by `doctor_report_tags` to abstract over old and new doctor report formats.

*Call graph*: called by 1 (doctor_report_tags); 2 external calls (new, empty).


##### `truncate_tag_value`  (lines 163–172)

```
fn truncate_tag_value(value: &str) -> String
```

**Purpose**: Limits tag values to `MAX_DOCTOR_TAG_VALUE_LEN` characters, appending `...` when truncation is necessary.

**Data flow**: Takes `&str`, counts Unicode scalar values with `chars().count()`, returns the original string if within the limit, otherwise collects the first `MAX_DOCTOR_TAG_VALUE_LEN - 3` characters into a prefix and returns `format!("{prefix}...")`.

**Call relations**: Used by `doctor_report_tags` for overall status and comma-joined check-id lists so generated tags stay bounded.

*Call graph*: called by 1 (doctor_report_tags); 1 external calls (format!).


##### `tests::doctor_report_tags_summarize_status_counts`  (lines 181–211)

```
fn doctor_report_tags_summarize_status_counts()
```

**Purpose**: Verifies that doctor report tag extraction produces the expected counts and check-id summaries for mixed-status reports.

**Data flow**: Builds a JSON report with one ok, one warning, and one fail check, calls `doctor_report_tags`, constructs the expected `BTreeMap`, and asserts equality.

**Call relations**: Unit test for `doctor_report_tags`, covering object-shaped `checks` and the count/list aggregation logic.

*Call graph*: calls 1 internal fn (doctor_report_tags); 3 external calls (from, assert_eq!, json!).


### Safe debug extraction
These utilities sanitize sensitive values and extract response metadata so later debug artifacts and telemetry remain useful without leaking secrets.

### `response-debug-context/src/lib.rs`

`util` · `error handling, logging, telemetry enrichment`

This library is a small error-inspection utility focused on two outputs: a structured `ResponseDebugContext` and short telemetry strings. `ResponseDebugContext` stores four optional fields: `request_id`, `cf_ray`, `auth_error`, and `auth_error_code`. The extraction logic only operates on `TransportError::Http`; all other transport variants return the default empty context.

`extract_response_debug_context` uses a local closure to read string headers from an optional `HeaderMap`, preferring `x-request-id` and falling back to `x-oai-request-id`. It also reads `cf-ray` and `x-openai-authorization-error`. The most specialized path is `x-error-json`: the header value is expected to be base64-encoded JSON, which is decoded, parsed as `serde_json::Value`, and traversed at `error.code`. Any failure in decoding, parsing, or field lookup quietly yields `None`, so malformed debug headers never turn into hard errors.

The telemetry helpers intentionally collapse rich error objects into short labels. For HTTP transport errors they emit only `http <status>` and ignore headers/body entirely, preventing accidental inclusion of sensitive payloads in logs or metrics. Non-HTTP transport and API variants preserve only coarse-grained messages such as `timeout`, `quota exceeded`, or the underlying string for network/build/stream errors. The tests emphasize both behaviors: identity-header extraction and omission of secret-bearing HTTP bodies.

#### Function details

##### `extract_response_debug_context`  (lines 19–54)

```
fn extract_response_debug_context(transport: &TransportError) -> ResponseDebugContext
```

**Purpose**: Builds a `ResponseDebugContext` from HTTP transport error headers, including decoding the encoded authorization error payload when present. Non-HTTP transport errors produce an empty context.

**Data flow**: Takes `&TransportError`. It starts from `ResponseDebugContext::default()`, pattern-matches for `TransportError::Http { headers, .. }`, and returns the default immediately for other variants. For HTTP errors it reads string header values from the optional header map, fills `request_id` from `x-request-id` or `x-oai-request-id`, fills `cf_ray` and `auth_error`, and computes `auth_error_code` by base64-decoding `x-error-json`, parsing JSON, and extracting `error.code` as a string. It returns the populated context without mutating external state.

**Call relations**: This is the primary extractor used directly by callers that already have a `TransportError`, and indirectly by `extract_response_debug_context_from_api_error`. Tests invoke it with synthetic HTTP headers to verify fallback and decoding behavior.

*Call graph*: called by 2 (extract_response_debug_context_from_api_error, extract_response_debug_context_decodes_identity_headers); 1 external calls (default).


##### `extract_response_debug_context_from_api_error`  (lines 56–61)

```
fn extract_response_debug_context_from_api_error(error: &ApiError) -> ResponseDebugContext
```

**Purpose**: Adapts the transport-level extractor to the broader `ApiError` enum. It only extracts context from the transport variant and otherwise returns an empty structure.

**Data flow**: Takes `&ApiError`, matches on the variant, forwards `ApiError::Transport(transport)` to `extract_response_debug_context(transport)`, and returns `ResponseDebugContext::default()` for all other API errors.

**Call relations**: This is the convenience entry point for code that handles `ApiError` rather than `TransportError`. It delegates all actual header parsing to `extract_response_debug_context`.

*Call graph*: calls 1 internal fn (extract_response_debug_context); 1 external calls (default).


##### `telemetry_transport_error_message`  (lines 63–71)

```
fn telemetry_transport_error_message(error: &TransportError) -> String
```

**Purpose**: Converts a `TransportError` into a short, telemetry-safe message string. HTTP errors are reduced to status code only so bodies and headers never leak into metrics/log labels.

**Data flow**: Takes `&TransportError` and matches variants: `Http` becomes `format!("http {}", status.as_u16())`; `RetryLimit`, `Timeout`, `Network(err)`, and `Build(err)` become fixed strings or the contained error string. It returns the constructed `String` and writes no state.

**Call relations**: Used by `telemetry_api_error_message` for the transport branch. The tests rely on it to confirm that HTTP body contents are omitted while non-HTTP details are preserved.

*Call graph*: called by 1 (telemetry_api_error_message); 1 external calls (format!).


##### `telemetry_api_error_message`  (lines 73–87)

```
fn telemetry_api_error_message(error: &ApiError) -> String
```

**Purpose**: Produces a compact telemetry label for any `ApiError`, preserving only coarse category information. It distinguishes transport, API-status, stream, and several semantic error variants.

**Data flow**: Takes `&ApiError` and matches variants. `ApiError::Transport` delegates to `telemetry_transport_error_message`; `Api { status, .. }` becomes `api error <status>`; stream/build-like string variants return their contained text; semantic variants such as `ContextWindowExceeded`, `QuotaExceeded`, `UsageNotIncluded`, `Retryable`, `RateLimit`, `InvalidRequest`, `CyberPolicy`, and `ServerOverloaded` map to fixed strings. It returns a `String`.

**Call relations**: This is the top-level telemetry formatter for API-layer failures. It delegates transport formatting downward so HTTP sanitization logic stays centralized in `telemetry_transport_error_message`.

*Call graph*: calls 1 internal fn (telemetry_transport_error_message); 1 external calls (format!).


##### `tests::extract_response_debug_context_decodes_identity_headers`  (lines 103–132)

```
fn extract_response_debug_context_decodes_identity_headers()
```

**Purpose**: Verifies that HTTP headers are extracted into `ResponseDebugContext`, including fallback request ID handling and base64-decoded authorization error codes. It exercises the happy path for all supported debug headers.

**Data flow**: Builds an `http::HeaderMap` with `x-oai-request-id`, `cf-ray`, `x-openai-authorization-error`, and `x-error-json`, wraps it in `TransportError::Http`, passes that to `extract_response_debug_context`, and asserts the returned struct equals the expected populated `ResponseDebugContext`.

**Call relations**: This test directly targets `extract_response_debug_context` to prove the header-reading and nested JSON decoding logic works end to end.

*Call graph*: calls 1 internal fn (extract_response_debug_context); 3 external calls (new, from_static, assert_eq!).


##### `tests::telemetry_error_messages_omit_http_bodies`  (lines 135–148)

```
fn telemetry_error_messages_omit_http_bodies()
```

**Purpose**: Checks that telemetry formatting for HTTP failures uses only the status code and never includes the response body. This guards against accidental leakage of sensitive server messages.

**Data flow**: Constructs a `TransportError::Http` containing a secret-bearing JSON body, then compares `telemetry_transport_error_message(&transport)` and `telemetry_api_error_message(&ApiError::Transport(transport))` against the expected `"http 401"` string.

**Call relations**: This test validates the sanitization contract of both telemetry helpers, especially the delegation path from `telemetry_api_error_message` into `telemetry_transport_error_message`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::telemetry_error_messages_preserve_non_http_details`  (lines 151–165)

```
fn telemetry_error_messages_preserve_non_http_details()
```

**Purpose**: Confirms that non-HTTP transport and stream errors keep their original textual detail instead of being collapsed to generic labels. It distinguishes the privacy rule for HTTP from the behavior for local/client-side failures.

**Data flow**: Creates `TransportError::Network`, `TransportError::Build`, and `ApiError::Stream` values with explicit strings, passes them through the telemetry helpers, and asserts the returned messages equal those original strings.

**Call relations**: This test complements the HTTP-body omission test by showing that only HTTP responses are aggressively sanitized; other variants intentionally preserve their message text.

*Call graph*: 4 external calls (assert_eq!, Stream, Build, Network).


### `secrets/src/sanitizer.rs`

`util` · `cross-cutting logging and display sanitization`

This file is a focused utility for scrubbing sensitive substrings from arbitrary text. It defines four `LazyLock<Regex>` statics: one for OpenAI-style keys beginning with `sk-`, one for AWS access key IDs beginning with `AKIA`, one for case-insensitive `Bearer <token>` headers, and one for assignment-like patterns such as `api_key=...`, `token: ...`, `secret=...`, or `password=...`. The regexes are compiled once on first use through `compile_regex`, which panics immediately if a pattern is invalid; the accompanying test exists specifically to force that compilation path.

`redact_secrets` applies the regexes in sequence to an owned `String`, replacing matched values with fixed placeholders. The replacement strings preserve some surrounding structure where useful: bearer tokens keep the `Bearer ` prefix, and assignment-like matches preserve the key name, separator, and optional opening quote while replacing only the value. This is intentionally heuristic rather than exhaustive; it aims to catch common accidental leaks in logs without claiming full secret detection coverage.

#### Function details

##### `redact_secrets`  (lines 15–22)

```
fn redact_secrets(input: String) -> String
```

**Purpose**: Runs a sequence of regex-based redactions over an input string and returns a sanitized copy. It targets several common secret formats rather than attempting full semantic parsing.

**Data flow**: It takes ownership of an input `String`, applies `replace_all` with `OPENAI_KEY_REGEX`, `AWS_ACCESS_KEY_ID_REGEX`, `BEARER_TOKEN_REGEX`, and `SECRET_ASSIGNMENT_REGEX` in order, and returns the final redacted `String`.

**Call relations**: The test module invokes it to force lazy regex initialization; in production it serves as the top-level sanitization helper for any caller that wants best-effort secret scrubbing.

*Call graph*: called by 1 (load_regex).


##### `compile_regex`  (lines 24–30)

```
fn compile_regex(pattern: &str) -> Regex
```

**Purpose**: Compiles one regex pattern and fails fast if the pattern is invalid. This keeps the static regex definitions concise while surfacing mistakes immediately.

**Data flow**: It takes a pattern `&str`, calls `Regex::new`, returns the compiled `Regex` on success, or panics with the pattern and error details on failure.

**Call relations**: It is used only by the `LazyLock` static initializers so regex compilation happens once per process on first access.

*Call graph*: 2 external calls (new, panic!).


##### `tests::load_regex`  (lines 37–40)

```
fn load_regex()
```

**Purpose**: Forces all lazy regex statics to compile so invalid patterns fail during tests instead of at runtime. It is a smoke test for regex initialization.

**Data flow**: The test passes a trivial string into `redact_secrets` and ignores the result; the important side effect is triggering each `LazyLock` and therefore `compile_regex`.

**Call relations**: It covers the panic-on-invalid-pattern behavior indirectly by exercising the top-level redaction function.

*Call graph*: calls 1 internal fn (redact_secrets).


### Request and payload dumps
These components persist ad hoc debug captures for proxied traffic and analytics payloads into local files for later inspection.

### `responses-api-proxy/src/dump.rs`

`io_transport` · `request forwarding diagnostics, response streaming, post-read cleanup`

This file implements optional exchange dumping for the responses API proxy. `ExchangeDumper` owns a dump directory and an `AtomicU64` sequence counter. `new` ensures the directory exists, and `dump_request` allocates a unique filename prefix from the sequence plus current UNIX timestamp in milliseconds. It writes a `*-request.json` file immediately, containing the HTTP method, URL path, redacted headers, and a body represented as parsed JSON when valid or as a lossy UTF-8 string otherwise.

The returned `ExchangeDump` carries only the future response path. `tee_response_body` turns that into a `ResponseBodyDump<R>`, a generic wrapper around any `Read` implementation. As the proxy streams bytes from upstream to downstream, `ResponseBodyDump::read` forwards reads unchanged while accumulating the bytes in memory. When EOF is reached—or if the wrapper is dropped before EOF—`write_dump_if_needed` serializes a `ResponseDump` with status, redacted response headers, and the captured body. A `dump_written` flag guarantees the response file is emitted at most once.

Header redaction is intentionally broad for secrets: exact case-insensitive `authorization` and any header whose lowercase name contains `cookie` are replaced with `[REDACTED]`. There are two `HeaderDump` conversions, one for `tiny_http::Header` and one for reqwest header pairs, so both inbound requests and upstream responses use the same redaction policy. Dump-writing failures during response capture are non-fatal and only reported to stderr, preserving proxy behavior even when diagnostics fail.

#### Function details

##### `ExchangeDumper::new`  (lines 25–32)

```
fn new(dump_dir: PathBuf) -> io::Result<Self>
```

**Purpose**: Initializes a dumper rooted at a directory and resets the sequence counter to 1. It guarantees the dump directory exists before any request is processed.

**Data flow**: Takes `dump_dir: PathBuf`, calls `fs::create_dir_all(&dump_dir)`, and returns `Ok(ExchangeDumper { dump_dir, next_sequence: AtomicU64::new(1) })` or the underlying `io::Error`.

**Call relations**: Constructed by proxy setup code before request handling begins, and by tests that verify dump contents. Its output is later used by `ExchangeDumper::dump_request` for per-exchange files.

*Call graph*: called by 2 (dump_request_writes_redacted_headers_and_json_body, response_body_dump_streams_body_and_writes_response_file); 2 external calls (new, create_dir_all).


##### `ExchangeDumper::dump_request`  (lines 34–60)

```
fn dump_request(
        &self,
        method: &Method,
        url: &str,
        headers: &[Header],
        body: &[u8],
    ) -> io::Result<ExchangeDump>
```

**Purpose**: Serializes the inbound request to a JSON file and prepares the matching response dump path. It is the entry point for capturing a full request/response exchange.

**Data flow**: Reads `method`, `url`, `headers`, and raw `body`. It atomically fetches and increments `next_sequence`, computes a timestamp-based filename prefix, builds `*-request.json` and `*-response.json` paths under `dump_dir`, constructs a `RequestDump` with `method.as_str()`, cloned URL, `headers.iter().map(HeaderDump::from).collect()`, and `dump_body(body)`, writes it via `write_json_dump`, and returns `ExchangeDump { response_path }`.

**Call relations**: Called from the proxy’s request-forwarding path before the upstream request is sent. It delegates body normalization to `dump_body` and file serialization to `write_json_dump`; the returned `ExchangeDump` is later consumed by `ExchangeDump::tee_response_body`.

*Call graph*: calls 2 internal fn (dump_body, write_json_dump); 6 external calls (fetch_add, iter, as_str, join, now, format!).


##### `ExchangeDump::tee_response_body`  (lines 68–82)

```
fn tee_response_body(
        self,
        status: u16,
        headers: &HeaderMap,
        response_body: R,
    ) -> ResponseBodyDump<R>
```

**Purpose**: Wraps an upstream response body reader so the proxy can stream bytes to the client while simultaneously recording them for a response dump file. It binds response metadata up front and defers file writing until the body is consumed or dropped.

**Data flow**: Consumes `self`, takes `status`, a reqwest `HeaderMap`, and a generic `response_body: R`. It returns `ResponseBodyDump<R>` populated with the original reader, stored `response_path`, numeric status, converted/redacted headers, an empty byte buffer, and `dump_written = false`.

**Call relations**: Used by the proxy only when request dumping is enabled. The returned wrapper participates in downstream I/O through its `Read` impl and eventually calls `ResponseBodyDump::write_dump_if_needed`.

*Call graph*: 2 external calls (iter, new).


##### `ResponseBodyDump::write_dump_if_needed`  (lines 95–114)

```
fn write_dump_if_needed(&mut self)
```

**Purpose**: Materializes the response JSON dump exactly once, regardless of whether the body reached EOF or the wrapper was dropped early. It treats dump failures as diagnostic-only and never propagates them to the caller.

**Data flow**: Mutably borrows `self`, checks `dump_written`, and returns immediately if already true. Otherwise it flips the flag, builds a `ResponseDump { status, headers: std::mem::take(&mut self.headers), body: dump_body(&self.body) }`, and attempts `write_json_dump(&self.response_path, &response_dump)`. On error it prints a message to stderr including the target path.

**Call relations**: This is the shared finalization path invoked by both `ResponseBodyDump::read` at EOF and `ResponseBodyDump::drop` during cleanup, ensuring one response file per exchange.

*Call graph*: calls 2 internal fn (dump_body, write_json_dump); called by 2 (drop, read); 2 external calls (eprintln!, take).


##### `ResponseBodyDump::read`  (lines 118–127)

```
fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>
```

**Purpose**: Implements streaming tee behavior for response bodies: it forwards bytes from the wrapped reader while buffering them for later dumping. EOF triggers immediate dump finalization.

**Data flow**: Takes `&mut self` and an output buffer `buf`. It reads from `self.response_body` into `buf`; if `bytes_read == 0`, it calls `write_dump_if_needed()` and returns `Ok(0)`. Otherwise it appends the newly read slice to `self.body` and returns the byte count unchanged.

**Call relations**: This method is exercised by the proxy when tiny_http drains the upstream response body. It delegates final dump emission to `write_dump_if_needed` once the stream ends.

*Call graph*: calls 1 internal fn (write_dump_if_needed); 1 external calls (read).


##### `ResponseBodyDump::drop`  (lines 131–133)

```
fn drop(&mut self)
```

**Purpose**: Ensures a response dump is still written even if the body reader is abandoned before EOF. This makes diagnostics robust against partial reads or early connection teardown.

**Data flow**: On drop, mutably borrows `self` and calls `write_dump_if_needed()`. It returns no value and ignores any dump-write failure beyond the stderr logging inside that helper.

**Call relations**: Acts as the fallback finalizer for `ResponseBodyDump` when normal `Read`-driven EOF handling does not occur.

*Call graph*: calls 1 internal fn (write_dump_if_needed).


##### `HeaderDump::from`  (lines 171–183)

```
fn from(header: (&reqwest::header::HeaderName, &reqwest::header::HeaderValue)) -> Self
```

**Purpose**: Converts reqwest response headers into serializable `HeaderDump` records while applying the same secret-redaction policy used for request headers. It preserves non-secret values as lossy UTF-8 strings.

**Data flow**: Takes a tuple `(&HeaderName, &HeaderValue)`, reads the lowercase-ish header name via `as_str()`, checks `should_redact_header(name)`, and either stores `[REDACTED]` or `String::from_utf8_lossy(header.1.as_bytes()).into_owned()`. It returns `HeaderDump { name: name.to_string(), value }`.

**Call relations**: Used by `ExchangeDump::tee_response_body` when capturing upstream response metadata. It relies on `should_redact_header` to decide whether to hide the value.

*Call graph*: calls 1 internal fn (should_redact_header); 1 external calls (from_utf8_lossy).


##### `should_redact_header`  (lines 186–189)

```
fn should_redact_header(name: &str) -> bool
```

**Purpose**: Defines which headers are considered sensitive enough to redact in dumps. It catches both authorization credentials and any cookie-related header names.

**Data flow**: Takes `name: &str`, compares it case-insensitively to `authorization`, and also checks whether `name.to_ascii_lowercase()` contains `"cookie"`. It returns `true` for sensitive names and `false` otherwise.

**Call relations**: Called by both `HeaderDump` conversion implementations so request and response dumps share one redaction rule.

*Call graph*: called by 1 (from).


##### `dump_body`  (lines 191–194)

```
fn dump_body(body: &[u8]) -> Value
```

**Purpose**: Normalizes raw body bytes into a JSON value suitable for dump files. It preserves structured JSON bodies as JSON and falls back to a string for everything else.

**Data flow**: Takes `body: &[u8]`, attempts `serde_json::from_slice(body)`, and returns that parsed `Value` on success. If parsing fails, it returns `Value::String(String::from_utf8_lossy(body).into_owned())`.

**Call relations**: Used by both `ExchangeDumper::dump_request` and `ResponseBodyDump::write_dump_if_needed` so request and response bodies are rendered consistently.

*Call graph*: called by 2 (dump_request, write_dump_if_needed); 1 external calls (from_slice).


##### `write_json_dump`  (lines 196–201)

```
fn write_json_dump(path: &PathBuf, dump: &impl Serialize) -> io::Result<()>
```

**Purpose**: Serializes a dump structure as pretty-printed JSON with a trailing newline and writes it to disk. It converts serialization failures into `io::ErrorKind::InvalidData`.

**Data flow**: Takes a `path: &PathBuf` and any `Serialize` value. It runs `serde_json::to_vec_pretty(dump)`, maps serialization errors into `io::Error`, appends `\n`, and writes the bytes with `fs::write(path, bytes)`, returning `io::Result<()>`.

**Call relations**: This is the common file-output primitive used by both request dumping and response finalization.

*Call graph*: called by 2 (dump_request, write_dump_if_needed); 2 external calls (write, to_vec_pretty).


##### `tests::dump_request_writes_redacted_headers_and_json_body`  (lines 225–300)

```
fn dump_request_writes_redacted_headers_and_json_body()
```

**Purpose**: Verifies that request dumps are written immediately, preserve JSON body structure, and redact authorization/cookie headers while leaving ordinary headers intact. It also checks the response dump filename suffix convention.

**Data flow**: Creates a temporary dump directory, constructs an `ExchangeDumper`, builds several `tiny_http::Header` values including sensitive and non-sensitive names, calls `dump_request`, reads the generated `-request.json` file, parses it as JSON, and asserts exact equality with the expected structure. It then inspects `exchange_dump.response_path` and removes the temp directory.

**Call relations**: This test exercises `ExchangeDumper::new`, `ExchangeDumper::dump_request`, header redaction, body parsing via `dump_body`, and the request/response filename pairing.

*Call graph*: calls 1 internal fn (new); 7 external calls (assert!, assert_eq!, read_to_string, remove_dir_all, dump_file_with_suffix, test_dump_dir, vec!).


##### `tests::response_body_dump_streams_body_and_writes_response_file`  (lines 303–355)

```
fn response_body_dump_streams_body_and_writes_response_file()
```

**Purpose**: Checks that the response wrapper both streams bytes through unchanged and writes a redacted response dump after reading completes. It covers the `Read` implementation and EOF-triggered finalization.

**Data flow**: Creates a temp dumper and request dump, builds a reqwest `HeaderMap` with content type plus sensitive authorization and cookie headers, wraps a `Cursor` body using `tee_response_body`, reads it into a `String`, then reads the generated `-response.json` file and asserts both the streamed body and dumped JSON match expectations. Finally it deletes the temp directory.

**Call relations**: This test drives `ExchangeDump::tee_response_body`, `ResponseBodyDump::read`, `ResponseBodyDump::write_dump_if_needed`, and response-side header redaction end to end.

*Call graph*: calls 2 internal fn (new, new); 8 external calls (new, from_static, new, assert_eq!, read_to_string, remove_dir_all, dump_file_with_suffix, test_dump_dir).


##### `tests::test_dump_dir`  (lines 357–365)

```
fn test_dump_dir() -> std::path::PathBuf
```

**Purpose**: Creates a unique temporary directory for dump-related tests. It avoids collisions by combining process ID with an atomic test-local sequence number.

**Data flow**: Fetches and increments `NEXT_TEST_DIR`, builds a path under `std::env::temp_dir()` using `format!`, creates the directory with `fs::create_dir_all`, and returns the resulting `PathBuf`.

**Call relations**: Used by both dump tests as shared setup for isolated filesystem state.

*Call graph*: 3 external calls (format!, create_dir_all, temp_dir).


##### `tests::dump_file_with_suffix`  (lines 367–377)

```
fn dump_file_with_suffix(dump_dir: &std::path::Path, suffix: &str) -> std::path::PathBuf
```

**Purpose**: Finds the single dump file in a directory whose path ends with a given suffix. It enforces the expectation that each test creates exactly one matching file.

**Data flow**: Reads directory entries from `dump_dir`, maps them to paths, filters by `ends_with(suffix)`, collects and sorts the matches, asserts there is exactly one, and returns that path.

**Call relations**: Used by the tests to locate generated `-request.json` and `-response.json` files without depending on the timestamped filename prefix.

*Call graph*: 2 external calls (assert_eq!, read_dir).


### `analytics/src/analytics_capture.rs`

`io_transport` · `debug analytics delivery`

This file is a small I/O utility used when analytics delivery is redirected from the network into a local capture file. The exported constant `ANALYTICS_EVENTS_CAPTURE_FILE_ENV_VAR` names the environment variable checked elsewhere to enable this mode.

The implementation is intentionally minimal and append-only. `initialize` simply opens the target file through `open_capture_file` and drops the handle, which has the side effect of creating the file if it does not already exist. `append_payload` serializes a `TrackEventsRequest` to JSON bytes, converts any serde failure into `io::ErrorKind::InvalidData`, appends a trailing newline so each request occupies one JSONL line, then reopens the file in append mode, writes the bytes, and flushes them.

`open_capture_file` encapsulates the file-opening policy. It uses `OpenOptions` with `create(true)` and `append(true)` so writes never truncate prior captured payloads. On Unix builds it additionally sets mode `0o600`, ensuring the capture file is readable and writable only by the current user. The function returns a `std::fs::File`, leaving all higher-level error handling to callers in the analytics client.

There is no buffering, rotation, or locking logic here; the design assumes low-volume debug capture where one serialized request per line is sufficient and durability after each append is desirable.

#### Function details

##### `initialize`  (lines 11–13)

```
fn initialize(path: &Path) -> io::Result<()>
```

**Purpose**: Creates or opens the analytics capture file so capture mode can be enabled before any payloads are written.

**Data flow**: Accepts a filesystem `Path`, calls `open_capture_file(path)`, discards the returned `File` with `drop`, and returns the resulting `io::Result<()>`.

**Call relations**: Called during analytics destination setup when a capture file path is configured. It delegates all file-opening policy to `open_capture_file`.

*Call graph*: calls 1 internal fn (open_capture_file); called by 1 (from_base_url_and_capture_file).


##### `append_payload`  (lines 15–23)

```
fn append_payload(path: &Path, payload: &TrackEventsRequest) -> io::Result<()>
```

**Purpose**: Appends one serialized analytics request as a single newline-terminated JSONL record to the capture file.

**Data flow**: Takes a `&Path` and `&TrackEventsRequest`, serializes the payload with `serde_json::to_vec`, maps serialization failures into `io::ErrorKind::InvalidData`, pushes a trailing `\n`, opens the file with `open_capture_file`, writes all bytes, flushes the file, and returns `io::Result<()>`.

**Call relations**: Invoked by the analytics client’s debug capture path instead of network delivery. It relies on `open_capture_file` for append/create semantics and secure permissions.

*Call graph*: calls 1 internal fn (open_capture_file); called by 1 (capture_track_events_request); 1 external calls (to_vec).


##### `open_capture_file`  (lines 25–34)

```
fn open_capture_file(path: &Path) -> io::Result<File>
```

**Purpose**: Builds the `OpenOptions` used for analytics capture files and opens the target path in append mode.

**Data flow**: Creates `OpenOptions`, enables `create(true)` and `append(true)`, conditionally sets Unix mode `0o600`, opens the provided path, and returns `io::Result<File>`.

**Call relations**: This private helper is shared by both `initialize` and `append_payload`, ensuring they use identical file-creation and permission behavior.

*Call graph*: called by 2 (append_payload, initialize); 1 external calls (new).


### Persistent log capture
These files provide the local logging backends, from TUI session JSONL capture through tracing-to-database ingestion and durable runtime log storage.

### `tui/src/session_log.rs`

`util` · `cross-cutting`

This module provides lightweight structured logging for TUI sessions. Logging is globally owned by `LOGGER`, a `LazyLock<SessionLogger>` whose `SessionLogger` contains a `OnceLock<Mutex<File>>`. That design means the logger object always exists, but the file is opened at most once and all writes are serialized through a mutex. `open` creates parent directories, truncates any existing file, and on Unix sets mode `0o600` before storing the file handle. `write_json_line` is intentionally best-effort: if logging was never enabled it returns immediately, and if the mutex is poisoned it recovers the inner file handle rather than disabling logging. Serialization, write, newline, and flush failures are reported with `tracing::warn!` but do not propagate.

`maybe_init` is the activation gate. It checks `CODEX_TUI_RECORD_SESSION` for truthy values (`1`, `true`, `TRUE`, `yes`, `YES`), chooses a path from `CODEX_TUI_SESSION_LOG_PATH` or a timestamped file under `config.log_dir`, opens the logger, and writes a `session_start` header record containing cwd and model/provider context. During runtime, `log_inbound_app_event` records selected `AppEvent` variants with custom payloads—such as history-cell line counts, file-search query/result counts, and pet preview/selection success flags—while collapsing noisier variants to just their debug variant name. `log_outbound_op` wraps arbitrary serializable `AppCommand`s in a standard envelope, and `log_session_end` emits a final lifecycle marker. Timestamps are RFC3339 with millisecond precision for readability and machine parsing.

#### Function details

##### `SessionLogger::new`  (lines 23–27)

```
fn new() -> Self
```

**Purpose**: Constructs an unopened session logger with no file handle initialized yet.

**Data flow**: Creates a `SessionLogger` whose `file` field is a fresh `OnceLock<Mutex<File>>` and returns it.

**Call relations**: Used once by the global `LOGGER` lazy initializer.

*Call graph*: 1 external calls (new).


##### `SessionLogger::open`  (lines 29–46)

```
fn open(&self, path: PathBuf) -> std::io::Result<()>
```

**Purpose**: Opens the JSONL log file, creating parent directories and storing the handle exactly once.

**Data flow**: Takes a `PathBuf`, configures `OpenOptions` for create/truncate/write, creates the parent directory tree if needed, applies Unix mode `0o600` when compiled on Unix, opens the file, stores it in `self.file` via `get_or_init(|| Mutex::new(file))`, and returns `std::io::Result<()>`.

**Call relations**: Called from `maybe_init` after environment-based logging has been enabled and a path chosen.

*Call graph*: 4 external calls (get_or_init, new, parent, create_dir_all).


##### `SessionLogger::write_json_line`  (lines 48–72)

```
fn write_json_line(&self, value: serde_json::Value)
```

**Purpose**: Serializes one JSON value and appends it as a single line to the session log file.

**Data flow**: If no file has been opened, returns immediately. Otherwise it locks the file mutex, recovering from poisoning if necessary, serializes the `serde_json::Value` to a string, writes the bytes, writes a trailing newline, flushes the file, and logs warnings on serialization/write/flush errors.

**Call relations**: All higher-level logging helpers funnel through this method after constructing their JSON payloads.

*Call graph*: 3 external calls (get, to_string, warn!).


##### `SessionLogger::is_enabled`  (lines 74–76)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Reports whether session logging has been initialized with an open file.

**Data flow**: Checks whether `self.file.get()` is `Some(_)` and returns that boolean.

**Call relations**: Inbound/outbound/session-end logging helpers use this as a cheap guard before building payloads.

*Call graph*: 1 external calls (get).


##### `now_ts`  (lines 79–82)

```
fn now_ts() -> String
```

**Purpose**: Generates the current timestamp string for log records.

**Data flow**: Reads `chrono::Utc::now()` and formats it as RFC3339 with millisecond precision and a `Z` suffix.

**Call relations**: Used by initialization and all record-writing helpers so every log line carries a consistent timestamp format.

*Call graph*: 1 external calls (now).


##### `maybe_init`  (lines 84–120)

```
fn maybe_init(config: &Config)
```

**Purpose**: Conditionally enables session logging from environment variables and writes the initial session-start metadata record.

**Data flow**: Reads `CODEX_TUI_RECORD_SESSION` and interprets a small set of truthy strings; if disabled, returns. Otherwise it chooses a path from `CODEX_TUI_SESSION_LOG_PATH` or constructs `session-<UTC timestamp>.jsonl` under `config.log_dir`, opens the global logger, logs an error and returns on failure, then builds a JSON header containing timestamp, direction `meta`, kind `session_start`, cwd, model, provider ID, and provider name, and writes it.

**Call relations**: Called during TUI startup before normal event processing begins.

*Call graph*: called by 1 (run_ratatui_app); 5 external calls (from, format!, json!, var, error!).


##### `log_inbound_app_event`  (lines 122–211)

```
fn log_inbound_app_event(event: &AppEvent)
```

**Purpose**: Records selected inbound `AppEvent`s from the app/core side into the session log.

**Data flow**: Returns immediately if logging is disabled. Otherwise it matches the `AppEvent` and constructs variant-specific JSON: simple lifecycle markers for `NewSession` and `ClearUi`, history-cell line counts for `InsertHistoryCell`, query and match counts for file search events, request/result metadata for pet preview/selection events, and for all other variants a generic record containing the debug variant name before any payload tuple/struct formatting. Each record is written via `LOGGER.write_json_line`.

**Call relations**: The app-event delivery path calls this whenever an event is sent toward the TUI.

*Call graph*: called by 1 (send); 1 external calls (json!).


##### `log_outbound_op`  (lines 213–218)

```
fn log_outbound_op(op: &AppCommand)
```

**Purpose**: Records an outbound `AppCommand` sent from the TUI.

**Data flow**: Checks `LOGGER.is_enabled()` and, if true, passes direction `from_tui`, kind `op`, and the serializable command object to `write_record`.

**Call relations**: Command submission paths call this so outbound operations are logged in the same JSONL stream as inbound events.

*Call graph*: calls 1 internal fn (write_record); called by 2 (submit_thread_op, submit_op).


##### `log_session_end`  (lines 220–230)

```
fn log_session_end()
```

**Purpose**: Writes the final session-end marker when the TUI shuts down.

**Data flow**: If logging is enabled, constructs a JSON object with current timestamp, direction `meta`, and kind `session_end`, then writes it as one line.

**Call relations**: Called during TUI teardown to bracket the earlier `session_start` header.

*Call graph*: called by 1 (run_ratatui_app); 1 external calls (json!).


##### `write_record`  (lines 232–243)

```
fn write_record(dir: &str, kind: &str, obj: &T)
```

**Purpose**: Wraps an arbitrary serializable payload in the standard session-log envelope.

**Data flow**: Accepts a direction string, kind string, and `Serialize` payload reference, builds a JSON object containing timestamp, direction, kind, and `payload`, and writes it through `LOGGER.write_json_line`.

**Call relations**: Currently used by `log_outbound_op` to avoid duplicating the common envelope structure.

*Call graph*: called by 1 (log_outbound_op); 1 external calls (json!).


### `state/src/log_db.rs`

`io_transport` · `cross-cutting`

This module is the state crate’s tracing-to-SQLite sink. `LogDbLayer` owns a bounded Tokio MPSC sender and a per-process UUID string; `start` and `start_with_config` create the queue, normalize queue settings, and spawn `run_inserter`, which batches `LogEntry` values and flushes them either when `batch_size` is reached, when a periodic interval ticks, when an explicit flush command arrives, or when the channel closes. Queue overflow is intentionally lossy: `try_send` drops new entries if the queue is full so `Layer::on_event` stays non-blocking.

The layer also tracks span-local logging context. `on_new_span` records initial span fields into `SpanLogContext`, storing the span name, formatted fields, and an optional `thread_id` extracted by `SpanFieldVisitor`. `on_record` updates that context when span fields change, appending newly recorded fields and replacing the stored thread ID if one is newly provided. `on_event` filters out noisy OpenTelemetry SDK TRACE/DEBUG timer events, extracts the event message and optional thread ID with `MessageVisitor`, falls back to `event_thread_id` by walking the current span scope, builds a human-readable `feedback_log_body` by concatenating span names/fields plus event fields, timestamps the event from `SystemTime`, and enqueues a `LogEntry`.

Formatting helpers reuse `tracing_subscriber`’s `DefaultFields` so stored feedback logs match the standard formatter shape. `current_process_log_uuid` memoizes a `pid:<pid>:<uuid>` identifier in a `OnceLock`, allowing rows from one process to be correlated. Tests cover queue overflow, explicit flush semantics, batch and interval flushing, and parity between SQLite feedback logs and the normal tracing formatter output.

#### Function details

##### `LogSinkQueueConfig::default`  (lines 59–65)

```
fn default() -> Self
```

**Purpose**: Provides the standard queue capacity, batch size, and flush interval for the log sink. These defaults balance low logging overhead with periodic persistence.

**Data flow**: It constructs and returns `LogSinkQueueConfig { queue_capacity: 512, batch_size: 128, flush_interval: 2s }` using the module constants.

**Call relations**: It is used by `LogDbLayer::start` so callers who do not care about tuning get the standard inserter behavior.

*Call graph*: called by 1 (start).


##### `LogSinkQueueConfig::normalized`  (lines 69–79)

```
fn normalized(self) -> Self
```

**Purpose**: Sanitizes a queue configuration so invalid zero values become usable runtime settings. It prevents degenerate channels, batches, or timers.

**Data flow**: It consumes `self`, replaces `queue_capacity` and `batch_size` with at least `1`, replaces a zero `flush_interval` with `LOG_FLUSH_INTERVAL`, and returns the normalized config.

**Call relations**: Called by `LogDbLayer::start_with_config` before creating the channel and background inserter.

*Call graph*: called by 1 (start_with_config); 1 external calls (is_zero).


##### `start`  (lines 99–101)

```
fn start(state_db: std::sync::Arc<StateRuntime>) -> LogDbLayer
```

**Purpose**: Convenience free function that starts a `LogDbLayer` with default queue settings. It gives callers a short API surface for the common case.

**Data flow**: It takes `Arc<StateRuntime>`, forwards it to `LogDbLayer::start`, and returns the resulting layer.

**Call relations**: Tests and external callers use this wrapper instead of naming the inherent constructor directly.

*Call graph*: calls 1 internal fn (start); called by 3 (tool_call_logs_include_thread_id, flush_persists_logs_for_query, sqlite_feedback_logs_match_feedback_formatter_shape).


##### `LogDbLayer::clone`  (lines 104–109)

```
fn clone(&self) -> Self
```

**Purpose**: Clones the log layer so it can be installed in subscriber pipelines or moved into async tasks while sharing the same queue. Both the sender and process UUID are duplicated by value.

**Data flow**: It clones `self.sender` and `self.process_uuid` and returns a new `LogDbLayer` containing those clones.

**Call relations**: Cloned layers still feed the same background inserter; tests use cloning when installing the layer and later calling `flush`.

*Call graph*: 1 external calls (clone).


##### `LogDbLayer::start`  (lines 113–115)

```
fn start(state_db: std::sync::Arc<StateRuntime>) -> Self
```

**Purpose**: Constructs a log layer using the default queue configuration. It is the inherent constructor behind the free `start` function.

**Data flow**: It takes `Arc<StateRuntime>`, obtains `LogSinkQueueConfig::default()`, forwards both to `Self::start_with_config`, and returns the resulting layer.

**Call relations**: This method is called by the free `start` wrapper and is the default construction path for production use.

*Call graph*: calls 1 internal fn (default); called by 1 (start); 1 external calls (start_with_config).


##### `LogDbLayer::start_with_config`  (lines 117–128)

```
fn start_with_config(
        state_db: std::sync::Arc<StateRuntime>,
        config: LogSinkQueueConfig,
    ) -> Self
```

**Purpose**: Constructs a log layer with caller-specified queue settings and starts the background inserter task. It is the configurable entry point for tuning batching behavior.

**Data flow**: It takes `Arc<StateRuntime>` and a `LogSinkQueueConfig`, normalizes the config, creates an MPSC channel with the configured capacity, spawns `run_inserter(state_db, receiver, config)`, computes a process UUID string via `current_process_log_uuid()`, and returns `LogDbLayer { sender, process_uuid }`.

**Call relations**: This is the foundational constructor used by `LogDbLayer::start`; tests call it directly to verify batch-size and flush-interval behavior.

*Call graph*: calls 3 internal fn (normalized, current_process_log_uuid, run_inserter); called by 2 (configured_batch_size_flushes_without_explicit_flush, configured_flush_interval_persists_buffered_logs); 2 external calls (channel, spawn).


##### `LogDbLayer::try_send`  (lines 137–139)

```
fn try_send(&self, entry: LogEntry)
```

**Purpose**: Attempts to enqueue a log entry without blocking and silently drops it if the queue is full or closed. This keeps tracing event handling lightweight.

**Data flow**: It takes ownership of a `LogEntry`, boxes it into `LogDbCommand::Entry`, and calls `self.sender.try_send(...)`, discarding the result.

**Call relations**: It is called from `on_event` after a `LogEntry` has been assembled. Queue-drop behavior is validated by tests.

*Call graph*: called by 1 (on_event); 3 external calls (new, try_send, Entry).


##### `LogDbLayer::on_new_span`  (lines 146–162)

```
fn on_new_span(
        &self,
        attrs: &Attributes<'_>,
        id: &Id,
        ctx: tracing_subscriber::layer::Context<'_, S>,
    )
```

**Purpose**: Captures initial span metadata and stores it in the span’s extensions for later event enrichment. It records both formatted fields and an optional `thread_id` field.

**Data flow**: It creates a default `SpanFieldVisitor`, records the span attributes into it, looks up the span in the subscriber context, and inserts a `SpanLogContext` containing the span name, `format_fields(attrs)`, and any extracted `thread_id` into the span’s extensions.

**Call relations**: This tracing-layer callback seeds the per-span context later read by `on_record`, `event_thread_id`, and `format_feedback_log_body`.

*Call graph*: calls 1 internal fn (format_fields); 3 external calls (record, span, default).


##### `LogDbLayer::on_record`  (lines 164–188)

```
fn on_record(
        &self,
        id: &Id,
        values: &Record<'_>,
        ctx: tracing_subscriber::layer::Context<'_, S>,
    )
```

**Purpose**: Updates stored span logging context when additional fields are recorded on an existing span. It preserves accumulated formatted fields and can fill in a thread ID later.

**Data flow**: It records the incoming `Record` into a fresh `SpanFieldVisitor`, looks up the span, and mutably accesses its extensions. If a `SpanLogContext` already exists, it replaces `thread_id` when the visitor found one and appends the newly formatted fields with `append_fields`; otherwise it inserts a new `SpanLogContext` built from the span metadata name, `format_fields(values)`, and the visitor’s thread ID.

**Call relations**: This callback complements `on_new_span` by handling dynamic span field updates before later events consult the stored context.

*Call graph*: calls 2 internal fn (append_fields, format_fields); 3 external calls (span, record, default).


##### `LogDbLayer::on_event`  (lines 190–229)

```
fn on_event(&self, event: &Event<'_>, ctx: tracing_subscriber::layer::Context<'_, S>)
```

**Purpose**: Transforms a tracing event into a `LogEntry`, enriches it with span-derived context, and enqueues it for asynchronous database insertion. It is the core event-capture path of the layer.

**Data flow**: It reads event metadata, immediately returns for noisy `opentelemetry_sdk` TRACE/DEBUG events, records event fields into a default `MessageVisitor`, derives `thread_id` from the event fields or `event_thread_id`, builds `feedback_log_body` with `format_feedback_log_body`, computes the current wall-clock timestamp from `SystemTime::now().duration_since(UNIX_EPOCH)` with a zero fallback on clock skew, constructs a `LogEntry` containing level, target, optional message, feedback body, thread/process IDs, module path, file, and line, and passes it to `try_send`.

**Call relations**: This tracing callback is invoked by the subscriber for every event. It depends on `MessageVisitor`, `event_thread_id`, and `format_feedback_log_body`, and hands off persistence to the queue via `try_send`.

*Call graph*: calls 2 internal fn (try_send, format_feedback_log_body); 5 external calls (now, matches!, metadata, record, default).


##### `LogDbLayer::flush`  (lines 236–238)

```
fn flush(&self) -> impl Future<Output = ()> + Send + '_
```

**Purpose**: Requests that the background inserter persist all entries accepted before the flush command and waits for acknowledgement. It provides a synchronization point for tests and orderly shutdown paths.

**Data flow**: It creates a oneshot channel, asynchronously sends `LogDbCommand::Flush(tx)` on the MPSC sender, and if that send succeeds awaits the reply receiver, ignoring the reply payload itself.

**Call relations**: This method is exposed both directly and through the `LogWriter` trait implementation. Tests use it to ensure queued logs are visible to queries.

*Call graph*: 3 external calls (send, channel, Flush).


##### `SpanFieldVisitor::record_field`  (lines 259–263)

```
fn record_field(&mut self, field: &Field, value: String)
```

**Purpose**: Captures a span field value when the field name is `thread_id` and no thread ID has been recorded yet. It is the shared sink for all typed `Visit` callbacks on spans.

**Data flow**: It takes a `Field` and a stringified value, checks `field.name()`, and if the name is `thread_id` and `self.thread_id` is currently `None`, stores `Some(value)`.

**Call relations**: All `Visit` methods on `SpanFieldVisitor` delegate here after converting their typed values to strings.

*Call graph*: called by 7 (record_bool, record_debug, record_error, record_f64, record_i64, record_str, record_u64); 1 external calls (name).


##### `SpanFieldVisitor::record_i64`  (lines 267–269)

```
fn record_i64(&mut self, field: &Field, value: i64)
```

**Purpose**: Records an `i64` span field by stringifying it and forwarding to `record_field`. It allows numeric thread IDs to be captured uniformly.

**Data flow**: It takes a field and `i64`, converts the value with `to_string()`, and passes both to `record_field`.

**Call relations**: This is one of the typed `Visit` hooks used when tracing records integer span fields.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_u64`  (lines 271–273)

```
fn record_u64(&mut self, field: &Field, value: u64)
```

**Purpose**: Records a `u64` span field through the common thread-ID extraction path. It supports unsigned numeric field values.

**Data flow**: It stringifies the `u64` value and forwards it with the field to `record_field`.

**Call relations**: Like the other typed visitor methods, it feeds `record_field` during span attribute and record processing.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_bool`  (lines 275–277)

```
fn record_bool(&mut self, field: &Field, value: bool)
```

**Purpose**: Records a boolean span field through the common extraction path. It exists to satisfy the `Visit` trait for all primitive field types.

**Data flow**: It converts the boolean to a string and forwards it to `record_field` with the field metadata.

**Call relations**: Used indirectly when tracing spans contain boolean fields.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_f64`  (lines 279–281)

```
fn record_f64(&mut self, field: &Field, value: f64)
```

**Purpose**: Records an `f64` span field through the common extraction path. It supports floating-point field values in spans.

**Data flow**: It stringifies the float and passes it to `record_field`.

**Call relations**: Another typed `Visit` adapter used by `on_new_span` and `on_record`.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_str`  (lines 283–285)

```
fn record_str(&mut self, field: &Field, value: &str)
```

**Purpose**: Records a string span field through the common extraction path. This is the most common path for textual `thread_id` fields.

**Data flow**: It clones the `&str` into an owned `String` and forwards it to `record_field`.

**Call relations**: Used whenever tracing records string-valued span fields.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_error`  (lines 287–289)

```
fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static))
```

**Purpose**: Records an error-valued span field by converting it to a string and forwarding it. It keeps thread-ID extraction generic across field types.

**Data flow**: It takes a trait-object error reference, calls `to_string()`, and passes the result to `record_field`.

**Call relations**: Part of the `Visit` implementation used by span recording callbacks.

*Call graph*: calls 1 internal fn (record_field); 1 external calls (to_string).


##### `SpanFieldVisitor::record_debug`  (lines 291–293)

```
fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug)
```

**Purpose**: Records a debug-formatted span field through the common extraction path. It is the fallback for arbitrary debug-printable values.

**Data flow**: It formats the debug value with `format!("{value:?}")` and forwards the resulting string to `record_field`.

**Call relations**: This fallback visitor method ensures `thread_id` can still be captured from debug-only fields.

*Call graph*: calls 1 internal fn (record_field); 1 external calls (format!).


##### `event_thread_id`  (lines 296–315)

```
fn event_thread_id(
    event: &Event<'_>,
    ctx: &tracing_subscriber::layer::Context<'_, S>,
) -> Option<String>
```

**Purpose**: Finds the most specific thread ID available from the current event’s span scope. It walks from root to leaf and keeps the latest span context that has a thread ID.

**Data flow**: It takes an event and subscriber context, initializes `thread_id` to `None`, obtains `ctx.event_scope(event)`, iterates spans from root, reads each span’s extensions, and whenever a `SpanLogContext` with `Some(thread_id)` is found, clones it into the local variable. It returns the final `Option<String>`.

**Call relations**: Called by `on_event` when the event itself did not carry a `thread_id` field, allowing span-scoped thread IDs to propagate into log rows.

*Call graph*: 1 external calls (event_scope).


##### `format_feedback_log_body`  (lines 317–346)

```
fn format_feedback_log_body(
    event: &Event<'_>,
    ctx: &tracing_subscriber::layer::Context<'_, S>,
) -> String
```

**Purpose**: Builds the human-readable feedback-log string that mirrors tracing formatter output by combining span context and event fields. It is what gets stored in `feedback_log_body` for later retrieval.

**Data flow**: It starts with an empty `String`, walks the event scope from root if present, and for each span appends either the stored span name plus `{formatted_fields}` from `SpanLogContext` or the raw metadata name, followed by `:`. If any span context was added, it appends a separating space, then appends `format_fields(event)` for the event’s own fields. The final string is returned.

**Call relations**: This helper is called by `on_event` when constructing each `LogEntry`, and tests compare its persisted output against the standard tracing formatter shape.

*Call graph*: calls 1 internal fn (format_fields); called by 1 (on_event); 2 external calls (event_scope, new).


##### `format_fields`  (lines 348–356)

```
fn format_fields(fields: R) -> String
```

**Purpose**: Formats tracing fields using `tracing_subscriber`’s default field formatter and returns the resulting field string. It keeps stored span/event formatting aligned with normal subscriber output.

**Data flow**: It takes any `RecordFields`, creates a `DefaultFields` formatter and an empty `FormattedFields<DefaultFields>`, asks the formatter to write into the formatted buffer, and returns the resulting `formatted.fields` string.

**Call relations**: Used by `on_new_span`, `on_record`, and `format_feedback_log_body` whenever fields need to be rendered into the same textual shape as tracing’s formatter.

*Call graph*: called by 3 (on_new_span, on_record, format_feedback_log_body); 3 external calls (default, new, new).


##### `append_fields`  (lines 358–363)

```
fn append_fields(fields: &mut String, values: &Record<'_>)
```

**Purpose**: Appends newly recorded span fields onto an existing formatted field string using tracing’s default field formatter semantics. It preserves prior formatting while incorporating updates.

**Data flow**: It takes a mutable `String` and a `Record`, moves the existing string out with `std::mem::take`, wraps it in `FormattedFields<DefaultFields>`, calls `DefaultFields::add_fields` to append the new record’s fields, and writes the updated formatted string back into `*fields`.

**Call relations**: Called by `on_record` when a span already has `SpanLogContext` and receives additional recorded fields.

*Call graph*: called by 1 (on_record); 3 external calls (default, new, take).


##### `current_process_log_uuid`  (lines 365–372)

```
fn current_process_log_uuid() -> &'static str
```

**Purpose**: Returns a stable per-process identifier used to tag all log rows emitted by the current process. The value is computed once and cached globally.

**Data flow**: It accesses a `static OnceLock<String>`, initializing it on first use by reading the current process ID, generating a random `Uuid::new_v4()`, formatting `pid:<pid>:<uuid>`, and returning a shared `&'static str` reference to the stored string.

**Call relations**: It is called by `LogDbLayer::start_with_config` so every layer instance in the same process shares the same process UUID.

*Call graph*: called by 1 (start_with_config); 1 external calls (new).


##### `run_inserter`  (lines 374–408)

```
async fn run_inserter(
    state_db: std::sync::Arc<StateRuntime>,
    mut receiver: mpsc::Receiver<LogDbCommand>,
    config: LogSinkQueueConfig,
)
```

**Purpose**: Runs the background task that drains queued log commands, batches entries, and flushes them to the database on size, time, explicit flush, or shutdown boundaries. It is the persistence engine behind the layer.

**Data flow**: It takes `Arc<StateRuntime>`, an MPSC receiver of `LogDbCommand`, and normalized config. It allocates a buffer with `batch_size` capacity, creates a periodic ticker for `flush_interval`, consumes the immediate first tick, and enters a `tokio::select!` loop. On `Entry`, it pushes the boxed entry into the buffer and flushes when the batch size is reached. On `Flush(reply)`, it flushes immediately and acknowledges via the oneshot sender. On channel closure, it flushes remaining entries and exits. On ticker ticks, it flushes whatever is buffered.

**Call relations**: Spawned by `LogDbLayer::start_with_config`, it delegates actual database insertion to the `flush` helper.

*Call graph*: called by 1 (start_with_config); 3 external calls (with_capacity, select!, interval).


##### `flush`  (lines 410–416)

```
async fn flush(state_db: &StateRuntime, buffer: &mut Vec<LogEntry>)
```

**Purpose**: Persists the current buffered batch of log entries to the state runtime if any are pending. It is intentionally best-effort and ignores insertion errors.

**Data flow**: It takes a `&StateRuntime` and mutable `Vec<LogEntry>`. If the buffer is empty it returns immediately; otherwise it moves all entries out with `split_off(0)`, awaits `state_db.insert_logs(entries.as_slice())`, and discards the result.

**Call relations**: This helper is called by `run_inserter` on all flush triggers: batch full, timer tick, explicit flush command, and receiver shutdown.

*Call graph*: 1 external calls (insert_logs).


##### `MessageVisitor::record_field`  (lines 425–432)

```
fn record_field(&mut self, field: &Field, value: String)
```

**Purpose**: Captures the first `message` and first `thread_id` fields seen on an event. It is the shared sink for all typed event-field visitor callbacks.

**Data flow**: It takes a field and stringified value, stores `Some(value.clone())` into `self.message` if the field name is `message` and no message has been captured yet, and stores `Some(value)` into `self.thread_id` if the field name is `thread_id` and no thread ID has been captured yet.

**Call relations**: All typed `Visit` methods on `MessageVisitor` delegate here, and `on_event` relies on the captured fields to populate `LogEntry`.

*Call graph*: called by 7 (record_bool, record_debug, record_error, record_f64, record_i64, record_str, record_u64); 1 external calls (name).


##### `MessageVisitor::record_i64`  (lines 436–438)

```
fn record_i64(&mut self, field: &Field, value: i64)
```

**Purpose**: Records an `i64` event field through the common message/thread-ID extraction path. It supports numeric event fields.

**Data flow**: It stringifies the integer and forwards it with the field metadata to `record_field`.

**Call relations**: Used indirectly by `on_event` when tracing records integer-valued event fields.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_u64`  (lines 440–442)

```
fn record_u64(&mut self, field: &Field, value: u64)
```

**Purpose**: Records a `u64` event field through the common extraction path. It supports unsigned numeric event fields.

**Data flow**: It converts the value to a string and passes it to `record_field`.

**Call relations**: Part of the `Visit` implementation used by `on_event`.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_bool`  (lines 444–446)

```
fn record_bool(&mut self, field: &Field, value: bool)
```

**Purpose**: Records a boolean event field through the common extraction path. It exists to satisfy the full `Visit` trait surface.

**Data flow**: It stringifies the boolean and forwards it to `record_field`.

**Call relations**: Used indirectly during event recording in `on_event`.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_f64`  (lines 448–450)

```
fn record_f64(&mut self, field: &Field, value: f64)
```

**Purpose**: Records a floating-point event field through the common extraction path. It supports arbitrary numeric event fields.

**Data flow**: It converts the float to a string and forwards it to `record_field`.

**Call relations**: Another typed visitor adapter used by `on_event`.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_str`  (lines 452–454)

```
fn record_str(&mut self, field: &Field, value: &str)
```

**Purpose**: Records a string event field through the common extraction path. This is the usual path for textual messages and thread IDs.

**Data flow**: It clones the `&str` into an owned `String` and passes it to `record_field`.

**Call relations**: Used by `on_event` when tracing records string-valued event fields.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_error`  (lines 456–458)

```
fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static))
```

**Purpose**: Records an error-valued event field by converting it to a string and forwarding it. It keeps extraction generic across field types.

**Data flow**: It calls `to_string()` on the error trait object and passes the result to `record_field`.

**Call relations**: Part of the `Visit` implementation used during event recording.

*Call graph*: calls 1 internal fn (record_field); 1 external calls (to_string).


##### `MessageVisitor::record_debug`  (lines 460–462)

```
fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug)
```

**Purpose**: Records a debug-formatted event field through the common extraction path. It is the fallback for arbitrary debug-printable values.

**Data flow**: It formats the debug value with `format!("{value:?}")` and forwards the string to `record_field`.

**Call relations**: This fallback visitor method is used by `on_event` for fields without a more specific typed callback.

*Call graph*: calls 1 internal fn (record_field); 1 external calls (format!).


##### `tests::temp_codex_home`  (lines 483–485)

```
fn temp_codex_home() -> std::path::PathBuf
```

**Purpose**: Creates a unique temporary CODEX_HOME path for log database tests. It avoids collisions between test runs by embedding a random UUID.

**Data flow**: It reads `std::env::temp_dir()`, appends a formatted `codex-state-log-db-<uuid>` directory name, and returns the resulting `PathBuf`.

**Call relations**: Most integration-style tests in this module call it before initializing `StateRuntime`.

*Call graph*: 2 external calls (format!, temp_dir).


##### `tests::wait_for_log_count`  (lines 487–504)

```
async fn wait_for_log_count(runtime: &StateRuntime, expected: usize) -> Vec<crate::LogRow>
```

**Purpose**: Polls the runtime until the expected number of log rows are visible or a timeout expires. It smooths over asynchronous batch insertion in tests.

**Data flow**: It takes a runtime and expected count, computes a deadline two seconds in the future, repeatedly queries logs with `LogQuery::default()`, returns the rows once `rows.len() == expected`, otherwise asserts the deadline has not passed and sleeps 10 ms before retrying.

**Call relations**: Batch- and interval-flush tests use it to wait for the background inserter to persist rows without relying on fixed sleeps alone.

*Call graph*: 7 external calls (assert!, default, query_logs, from_millis, from_secs, now, sleep).


##### `tests::test_entry`  (lines 506–520)

```
fn test_entry(message: &str) -> LogEntry
```

**Purpose**: Builds a representative `LogEntry` fixture with caller-supplied message text. It centralizes consistent field values for queue-behavior tests.

**Data flow**: It takes a message string slice and returns a `LogEntry` populated with fixed timestamp, level, target, thread/process IDs, module/file/line, and both `message` and `feedback_log_body` set from the input.

**Call relations**: Queue-focused tests call it before passing entries to `LogDbLayer::try_send`.


##### `tests::SharedWriter::snapshot`  (lines 528–531)

```
fn snapshot(&self) -> String
```

**Purpose**: Returns the accumulated bytes written by the shared test writer as a UTF-8 string. It lets tests compare tracing formatter output against persisted feedback logs.

**Data flow**: It locks the internal `Mutex<Vec<u8>>`, clones the bytes, converts them with `String::from_utf8`, and returns the resulting string.

**Call relations**: Used by the formatter-shape test after tracing output has been captured through the custom writer.

*Call graph*: 1 external calls (from_utf8).


##### `tests::SharedWriter::make_writer`  (lines 541–545)

```
fn make_writer(&'a self) -> Self::Writer
```

**Purpose**: Creates a writer guard that appends into the shared byte buffer. It implements `MakeWriter` so the tracing formatter can write into test-owned memory.

**Data flow**: It clones the internal `Arc<Mutex<Vec<u8>>>` and returns `SharedWriterGuard { bytes }`.

**Call relations**: This method is invoked by tracing’s formatting layer when the test subscriber emits formatted logs.

*Call graph*: 1 external calls (clone).


##### `tests::SharedWriterGuard::write`  (lines 549–555)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Appends written bytes into the shared in-memory buffer and reports all bytes as consumed. It is the concrete sink behind the test formatter writer.

**Data flow**: It locks the shared byte vector, extends it with the provided `buf`, and returns `Ok(buf.len())`.

**Call relations**: Tracing’s formatting layer calls this through the `io::Write` trait while tests capture formatter output.


##### `tests::SharedWriterGuard::flush`  (lines 557–559)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Implements a no-op flush for the in-memory test writer. There is no buffered state beyond the shared byte vector itself.

**Data flow**: It ignores its receiver state and returns `Ok(())`.

**Call relations**: This satisfies the `io::Write` contract for the custom test writer.


##### `tests::sqlite_feedback_logs_match_feedback_formatter_shape`  (lines 563–618)

```
async fn sqlite_feedback_logs_match_feedback_formatter_shape()
```

**Purpose**: Verifies that feedback logs stored in SQLite have the same structural formatting as logs emitted by the standard tracing formatter. It checks the correctness of `format_feedback_log_body` and related span formatting helpers.

**Data flow**: The test creates a temporary runtime, a `SharedWriter`, and a `LogDbLayer`, installs both a normal formatting layer and the DB layer into a subscriber, emits threadless and thread-scoped logs, explicitly flushes the DB layer, captures formatter output from the writer, queries feedback logs for `thread-1` from SQLite, strips timestamps from both outputs, and asserts equality. It then removes the temporary CODEX_HOME directory.

**Call relations**: It exercises the full path from tracing spans/events through `on_new_span`, `on_event`, queue flushing, SQLite persistence, and feedback-log retrieval.

*Call graph*: calls 2 internal fn (start, init); 11 external calls (from_utf8, new, assert_eq!, default, temp_codex_home, remove_dir_all, debug!, info_span!, trace!, layer (+1 more)).


##### `tests::flush_persists_logs_for_query`  (lines 621–649)

```
async fn flush_persists_logs_for_query()
```

**Purpose**: Checks that calling `flush` makes buffered logs visible to subsequent database queries. It validates the explicit flush command path.

**Data flow**: The test initializes a runtime and layer, installs the layer in a subscriber, emits one `tracing::info!` event, awaits `layer.flush()`, drops the subscriber guard, queries logs from the runtime, and asserts that exactly one row exists with message `buffered-log`. It then removes the temporary directory.

**Call relations**: It directly validates `LogDbLayer::flush` and the `run_inserter` handling of `LogDbCommand::Flush`.

*Call graph*: calls 2 internal fn (start, init); 7 external calls (new, assert_eq!, temp_codex_home, default, remove_dir_all, info!, registry).


##### `tests::configured_batch_size_flushes_without_explicit_flush`  (lines 652–698)

```
async fn configured_batch_size_flushes_without_explicit_flush()
```

**Purpose**: Verifies that reaching the configured batch size triggers persistence even without an explicit flush call. It tests the size-based flush branch in the inserter loop.

**Data flow**: The test starts a layer with `batch_size: 2` and a long flush interval, emits one log and confirms no rows are yet persisted, emits a second log, waits for two rows with `wait_for_log_count`, and asserts the stored messages are the two emitted messages in order. It then cleans up the temporary directory.

**Call relations**: It exercises `LogDbLayer::start_with_config`, `run_inserter`’s batch threshold logic, and asynchronous persistence visibility.

*Call graph*: calls 2 internal fn (start_with_config, init); 10 external calls (new, assert_eq!, temp_codex_home, wait_for_log_count, from_millis, from_secs, remove_dir_all, sleep, info!, registry).


##### `tests::configured_flush_interval_persists_buffered_logs`  (lines 701–731)

```
async fn configured_flush_interval_persists_buffered_logs()
```

**Purpose**: Checks that the periodic flush timer persists buffered logs even when the batch size is not reached. It validates the time-based flush branch.

**Data flow**: The test starts a layer with a large batch size and a 10 ms flush interval, waits one tick so the startup tick is consumed, emits one log, waits for one persisted row with `wait_for_log_count`, asserts the message matches, and removes the temporary directory.

**Call relations**: It targets `run_inserter`’s ticker-driven flush behavior and the startup-tick consumption logic.

*Call graph*: calls 2 internal fn (start_with_config, init); 9 external calls (new, assert_eq!, temp_codex_home, wait_for_log_count, from_millis, remove_dir_all, sleep, info!, registry).


##### `tests::event_queue_drops_new_entries_when_full`  (lines 734–751)

```
async fn event_queue_drops_new_entries_when_full()
```

**Purpose**: Ensures that `try_send` drops new log entries when the bounded queue is full instead of blocking. This preserves the non-blocking contract of `on_event`.

**Data flow**: The test creates a channel of capacity 1, constructs a `LogDbLayer` around its sender, calls `try_send` twice with different test entries, receives the first queued command and asserts its message, then asserts that no second command is available.

**Call relations**: It directly validates the lossy queue semantics implemented by `LogDbLayer::try_send`.

*Call graph*: 5 external calls (assert!, assert_eq!, channel, panic!, test_entry).


##### `tests::flush_waits_for_queue_capacity_and_receiver_processing`  (lines 754–791)

```
async fn flush_waits_for_queue_capacity_and_receiver_processing()
```

**Purpose**: Verifies that `flush` waits not only for queue space but also for the receiver to process the flush command and acknowledge it. It checks the synchronization semantics of explicit flushing under backpressure.

**Data flow**: The test creates a capacity-1 channel and a layer using its sender, enqueues one entry to fill the queue, spawns a task awaiting `layer.flush()`, confirms the task is blocked, manually receives the queued entry from the channel, then receives the flush command, confirms the task is still blocked until the reply sender is used, sends the reply, and finally asserts the flush task completes within one second.

**Call relations**: It exercises `LogDbLayer::flush` together with the command ordering and acknowledgement behavior expected from `run_inserter`.

*Call graph*: 10 external calls (assert!, assert_eq!, channel, panic!, test_entry, from_millis, from_secs, spawn, sleep, timeout).


### `state/src/runtime/logs.rs`

`io_transport` · `cross-cutting logging, startup cleanup, and log/feedback retrieval`

This file adds log persistence methods to `StateRuntime` using `self.logs_pool`, separate from the main state database. `insert_log` is a thin wrapper over `insert_logs`, which batches inserts with `QueryBuilder`. Each row stores timestamps, level/target metadata, optional thread and process identifiers, source location fields, and an `estimated_bytes` value derived from the persisted `feedback_log_body` (or legacy `message` fallback) plus selected metadata lengths. Inserts run inside a transaction and immediately call `prune_logs_after_insert` before commit.

Retention is partitioned, not global. Thread-scoped rows (`thread_id IS NOT NULL`) are capped independently per thread id; threadless rows are capped independently per `process_uuid`, with `NULL process_uuid` treated as its own partition. The pruning method first cheaply identifies only partitions over the byte or row limit, then uses window functions (`SUM(...) OVER`, `ROW_NUMBER() OVER`) ordered newest-first to delete every row beyond the retained suffix. Because pruning shares the insert transaction, callers never see “inserted but not yet pruned” rows.

Read APIs include `query_logs`, which builds optional filters for levels, timestamps, module/file substrings, thread/threadless selection, `after_id`, and body substring search; `max_log_id`; and feedback-log extraction. `query_feedback_logs_for_threads` merges requested thread rows with threadless rows from each thread’s latest associated process, bounds SQL results by cumulative estimated bytes, formats lines with RFC3339 timestamps, then enforces an exact whole-line byte cap in memory before returning UTF-8 bytes in chronological order. Startup maintenance deletes rows older than `LOG_RETENTION_DAYS` and runs a passive WAL checkpoint.

#### Function details

##### `StateRuntime::insert_log`  (lines 6–8)

```
async fn insert_log(&self, entry: &LogEntry) -> anyhow::Result<()>
```

**Purpose**: Convenience wrapper that inserts a single `LogEntry` by delegating to the batch insert path. It avoids duplicating insert logic.

**Data flow**: Takes `&LogEntry`, wraps it with `std::slice::from_ref`, and forwards to `insert_logs`, returning that result.

**Call relations**: Used by callers with one log entry; all real work happens in `StateRuntime::insert_logs`.

*Call graph*: calls 1 internal fn (insert_logs); 1 external calls (from_ref).


##### `StateRuntime::insert_logs`  (lines 11–47)

```
async fn insert_logs(&self, entries: &[LogEntry]) -> anyhow::Result<()>
```

**Purpose**: Batch-inserts log rows into the dedicated logs database and prunes any affected partitions before commit. Empty batches are a no-op.

**Data flow**: Consumes a slice of `LogEntry`; if empty, returns immediately. Otherwise it opens a transaction on `self.logs_pool`, builds one multi-row `INSERT INTO logs (...)` statement with `QueryBuilder`, computes `feedback_log_body` fallback and `estimated_bytes` per entry, executes the insert, calls `prune_logs_after_insert(entries, &mut tx)`, commits, and returns `()`.

**Call relations**: This is the main write path for persisted logs. `StateRuntime::insert_log` delegates here, and this method in turn delegates retention enforcement to `StateRuntime::prune_logs_after_insert`.

*Call graph*: calls 1 internal fn (prune_logs_after_insert); called by 1 (insert_log); 2 external calls (new, is_empty).


##### `StateRuntime::prune_logs_after_insert`  (lines 62–286)

```
async fn prune_logs_after_insert(
        &self,
        entries: &[LogEntry],
        tx: &mut SqliteConnection,
    ) -> anyhow::Result<()>
```

**Purpose**: Enforces per-thread and per-threadless-process retention budgets immediately after insertion, deleting older rows beyond byte or row caps. It runs inside the caller’s transaction so retention is atomic with insertion.

**Data flow**: Reads the inserted `entries` to collect affected thread ids, threadless process UUIDs, and whether any threadless null-process rows were inserted. For each affected partition type, it first queries which partitions exceed `LOG_PARTITION_SIZE_LIMIT_BYTES` or `LOG_PARTITION_ROW_LIMIT`, then issues window-function `DELETE` statements that remove rows whose newest-first cumulative bytes or row number exceed the cap. It writes only through the provided mutable `SqliteConnection` transaction.

**Call relations**: Called only by `StateRuntime::insert_logs`. Its partition-specific pruning logic is what guarantees readers never observe over-budget partitions after a successful insert.

*Call graph*: called by 1 (insert_logs); 2 external calls (new, iter).


##### `StateRuntime::delete_logs_before`  (lines 288–294)

```
async fn delete_logs_before(&self, cutoff_ts: i64) -> anyhow::Result<u64>
```

**Purpose**: Deletes all log rows older than a Unix-second cutoff and returns how many rows were removed. This is used for coarse age-based retention.

**Data flow**: Consumes `cutoff_ts`, executes `DELETE FROM logs WHERE ts < ?` against `self.logs_pool`, and returns `rows_affected()` as `u64`.

**Call relations**: This is a maintenance helper invoked by `StateRuntime::run_logs_startup_maintenance`.

*Call graph*: called by 1 (run_logs_startup_maintenance); 1 external calls (query).


##### `StateRuntime::run_logs_startup_maintenance`  (lines 296–310)

```
async fn run_logs_startup_maintenance(&self) -> anyhow::Result<()>
```

**Purpose**: Performs startup cleanup on the logs database by deleting rows older than the configured retention window and issuing a passive WAL checkpoint. It intentionally avoids blocking foreground work.

**Data flow**: Computes a cutoff timestamp as `Utc::now() - LOG_RETENTION_DAYS`, returns early if that subtraction fails, calls `delete_logs_before(cutoff.timestamp())`, then executes `PRAGMA wal_checkpoint(PASSIVE)` on `self.logs_pool`. Returns `()`.

**Call relations**: This is the startup maintenance entry point for the logs subsystem, delegating age-based deletion to `StateRuntime::delete_logs_before`.

*Call graph*: calls 1 internal fn (delete_logs_before); 3 external calls (now, days, query).


##### `StateRuntime::query_logs`  (lines 313–332)

```
async fn query_logs(&self, query: &LogQuery) -> anyhow::Result<Vec<LogRow>>
```

**Purpose**: Returns persisted log rows matching optional filters and ordering. It exposes the general-purpose log browsing API.

**Data flow**: Consumes `&LogQuery`, builds a `SELECT` over log columns with `QueryBuilder`, calls `push_log_filters` to append predicates, adds ascending or descending `ORDER BY id`, optional `LIMIT`, fetches `Vec<LogRow>` from `self.logs_pool`, and returns them.

**Call relations**: This is the main read API for logs. It delegates all predicate construction to `push_log_filters` so `max_log_id` can share the same filtering semantics.

*Call graph*: calls 1 internal fn (push_log_filters); 1 external calls (new).


##### `StateRuntime::query_feedback_logs_for_threads`  (lines 335–431)

```
async fn query_feedback_logs_for_threads(
        &self,
        thread_ids: &[&str],
    ) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Builds a merged feedback-log stream for one or more threads, including threadless rows from each thread’s latest associated process, and returns it as UTF-8 bytes capped to the retention budget. The output is chronological whole lines.

**Data flow**: Consumes a slice of thread-id strings; returns empty bytes immediately if the slice is empty. Otherwise it builds a CTE-based SQL query that materializes requested threads, finds each thread’s latest non-null `process_uuid`, selects matching feedback rows from both thread-scoped and relevant threadless logs, computes newest-first cumulative estimated bytes, and fetches only rows within the byte budget. It then formats each row with `format_feedback_log_line`, applies an exact whole-line byte cap in memory, reverses to chronological order, and returns the concatenated bytes.

**Call relations**: This is the heavy-duty feedback export path. `StateRuntime::query_feedback_logs` is a single-thread wrapper around it, and it relies on `format_feedback_log_line` for output shape.

*Call graph*: calls 1 internal fn (format_feedback_log_line); called by 1 (query_feedback_logs); 4 external calls (new, new, with_capacity, try_from).


##### `StateRuntime::query_feedback_logs`  (lines 434–436)

```
async fn query_feedback_logs(&self, thread_id: &str) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Convenience wrapper that fetches feedback logs for exactly one thread. It preserves the same merged thread/threadless semantics as the multi-thread API.

**Data flow**: Takes `thread_id`, constructs a one-element slice reference, and delegates to `query_feedback_logs_for_threads`, returning its byte vector.

**Call relations**: Used by callers that only need one thread’s feedback stream; all logic lives in `StateRuntime::query_feedback_logs_for_threads`.

*Call graph*: calls 1 internal fn (query_feedback_logs_for_threads).


##### `StateRuntime::max_log_id`  (lines 439–446)

```
async fn max_log_id(&self, query: &LogQuery) -> anyhow::Result<i64>
```

**Purpose**: Returns the maximum log row id matching the same optional filters used by `query_logs`. Empty result sets yield `0`.

**Data flow**: Consumes `&LogQuery`, builds `SELECT MAX(id) AS max_id FROM logs WHERE 1 = 1`, appends predicates via `push_log_filters`, fetches one row, extracts optional `max_id`, and returns `max_id.unwrap_or(0)`.

**Call relations**: This shares filter-building logic with `StateRuntime::query_logs` through `push_log_filters`, making it suitable for incremental polling based on `after_id`.

*Call graph*: calls 1 internal fn (push_log_filters); 1 external calls (new).


##### `format_feedback_log_line`  (lines 457–473)

```
fn format_feedback_log_line(
    ts: i64,
    ts_nanos: i64,
    level: &str,
    feedback_log_body: &str,
) -> String
```

**Purpose**: Formats one feedback log row into the exported line shape with timestamp, right-aligned level, body text, and exactly one trailing newline. It falls back to a raw `secs.nanosZ` string if the timestamp is invalid.

**Data flow**: Consumes `ts`, `ts_nanos`, `level`, and `feedback_log_body`; converts nanos to `u32` with fallback, tries `DateTime::<Utc>::from_timestamp`, formats either RFC3339 micros or a fallback string, appends level and body, ensures the result ends with `\n`, and returns the `String`.

**Call relations**: Called by `StateRuntime::query_feedback_logs_for_threads` for every exported row. Dedicated tests pin down its exact output shape.

*Call graph*: called by 1 (query_feedback_logs_for_threads); 3 external calls (from_timestamp, format!, try_from).


##### `push_log_filters`  (lines 475–521)

```
fn push_log_filters(builder: &mut QueryBuilder<Sqlite>, query: &LogQuery)
```

**Purpose**: Appends all optional `LogQuery` predicates to a `QueryBuilder<Sqlite>`, including level, time range, module/file substring, thread/threadless selection, id cursor, and body substring search. It centralizes query semantics for multiple read APIs.

**Data flow**: Reads fields from `query` and mutates the provided `builder` by pushing SQL fragments and bound values. It delegates module/file substring handling to `push_like_filters` and directly emits predicates for levels, timestamps, thread filters, `after_id`, and `INSTR` search over `feedback_log_body`.

**Call relations**: Used by both `StateRuntime::query_logs` and `StateRuntime::max_log_id` so those APIs stay consistent.

*Call graph*: calls 1 internal fn (push_like_filters); called by 2 (max_log_id, query_logs); 3 external calls (push, push_bind, separated).


##### `push_like_filters`  (lines 523–539)

```
fn push_like_filters(builder: &mut QueryBuilder<Sqlite>, column: &str, filters: &[String])
```

**Purpose**: Adds one or more `%...%` `LIKE` predicates for a specific column, OR-ing multiple filter strings together. Empty filter lists leave the query unchanged.

**Data flow**: Consumes a mutable builder, a column name, and a slice of filter strings; if non-empty, it appends `AND (...)` with one `column LIKE '%' || ? || '%'` clause per filter joined by `OR`.

**Call relations**: This is a small helper used only by `push_log_filters` for `module_path` and `file` substring matching.

*Call graph*: called by 1 (push_log_filters); 1 external calls (push).


##### `tests::open_db_pool`  (lines 558–566)

```
async fn open_db_pool(path: &Path) -> SqlitePool
```

**Purpose**: Opens a raw `SqlitePool` against a specific logs database path for test inspection. It bypasses runtime wrappers so tests can inspect schema and row counts directly.

**Data flow**: Consumes a filesystem `Path`, builds `SqliteConnectOptions` with `create_if_missing(false)`, connects, and returns the pool.

**Call relations**: Used by helper and migration tests that need direct database access outside `StateRuntime`.

*Call graph*: 2 external calls (new, connect_with).


##### `tests::log_row_count`  (lines 568–576)

```
async fn log_row_count(path: &Path) -> i64
```

**Purpose**: Counts rows in the `logs` table at a given database path. It is a small test helper for verifying which database received inserted rows.

**Data flow**: Opens a pool with `open_db_pool`, runs `SELECT COUNT(*) FROM logs`, closes the pool, and returns the count.

**Call relations**: Used by the dedicated-log-database test to confirm inserts land in the logs DB file.

*Call graph*: 1 external calls (open_db_pool).


##### `tests::insert_logs_use_dedicated_log_database`  (lines 579–607)

```
async fn insert_logs_use_dedicated_log_database()
```

**Purpose**: Verifies that persisted logs are written to the separate logs database rather than the main state database. It checks this by counting rows in the logs DB file directly.

**Data flow**: Initializes a runtime, inserts one `LogEntry`, computes the logs DB path, counts rows there with `log_row_count`, asserts the count is one, and removes the temp directory.

**Call relations**: This test covers the basic write path and the architectural separation of the logs database.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (assert_eq!, logs_db_path, log_row_count, remove_dir_all).


##### `tests::init_migrates_message_only_logs_db_to_feedback_log_body_schema`  (lines 610–706)

```
async fn init_migrates_message_only_logs_db_to_feedback_log_body_schema()
```

**Purpose**: Checks that runtime initialization migrates an older logs schema using `message` into the newer `feedback_log_body` schema without losing data. It also verifies the resulting column and index layout.

**Data flow**: Creates an old-schema logs DB with a custom migrator, inserts a legacy row into the old `message` column, initializes `StateRuntime`, queries logs through the runtime to confirm the body is readable, then directly inspects `pragma_table_info` and `pragma_index_list` to assert the migrated schema.

**Call relations**: This test validates compatibility between runtime initialization and historical logs database formats.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 12 external calls (Owned, new, connect_with, now, assert_eq!, logs_db_path, query, default, open_db_pool, create_dir_all (+2 more)).


##### `tests::init_configures_logs_db_with_incremental_auto_vacuum`  (lines 709–724)

```
async fn init_configures_logs_db_with_incremental_auto_vacuum()
```

**Purpose**: Verifies that the logs database is configured with incremental auto-vacuum. This pins down a storage-maintenance setting expected at initialization time.

**Data flow**: Initializes a runtime, opens the logs DB directly, reads `PRAGMA auto_vacuum`, asserts it equals `2`, closes the pool, and removes the temp directory.

**Call relations**: This test covers initialization-time database configuration rather than runtime log operations.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (assert_eq!, logs_db_path, open_db_pool, remove_dir_all).


##### `tests::format_feedback_log_line_matches_feedback_formatter_shape`  (lines 727–737)

```
fn format_feedback_log_line_matches_feedback_formatter_shape()
```

**Purpose**: Asserts the exact textual shape of a formatted feedback log line for a normal timestamp and body. It protects downstream consumers that expect this format.

**Data flow**: Calls `format_feedback_log_line` with fixed inputs and compares the returned string to the expected RFC3339-micros line with newline.

**Call relations**: This is a unit test for the standalone formatter used by feedback-log export.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::format_feedback_log_line_preserves_existing_trailing_newline`  (lines 740–750)

```
fn format_feedback_log_line_preserves_existing_trailing_newline()
```

**Purpose**: Checks that formatting does not duplicate a newline when the body already ends with one. The output should still contain exactly one trailing newline.

**Data flow**: Calls `format_feedback_log_line` with a body ending in `\n` and asserts the returned string has the expected single newline.

**Call relations**: This complements the previous formatter test by covering the newline-normalization edge case.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::query_logs_with_search_matches_rendered_body_substring`  (lines 753–803)

```
async fn query_logs_with_search_matches_rendered_body_substring()
```

**Purpose**: Verifies that `query_logs` search filtering matches substrings in the persisted feedback body. It ensures search is applied to `feedback_log_body`, not just legacy message text.

**Data flow**: Initializes a runtime, inserts two log rows with different bodies, queries with `LogQuery { search: Some("foo=2"), .. }`, and asserts only the matching row is returned.

**Call relations**: This test exercises the `INSTR(COALESCE(feedback_log_body, ''), ?)` predicate emitted by `push_log_filters`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert_eq!, remove_dir_all).


##### `tests::query_logs_filters_level_set_without_rewriting_stored_level`  (lines 806–888)

```
async fn query_logs_filters_level_set_without_rewriting_stored_level()
```

**Purpose**: Checks that level filtering is case-insensitive on query input via `UPPER(level)` but preserves the original stored level strings in results. Filtering should not normalize stored data.

**Data flow**: Inserts rows with mixed-case levels, queries with `levels_upper = ["WARN", "ERROR"]`, maps returned rows to `(level, message)`, and asserts only the warn/error rows are returned with original casing intact.

**Call relations**: This test targets the level-filter branch in `push_log_filters`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert_eq!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_old_rows_when_thread_exceeds_size_limit`  (lines 891–942)

```
async fn insert_logs_prunes_old_rows_when_thread_exceeds_size_limit()
```

**Purpose**: Verifies per-thread byte-budget pruning: when two large rows exceed the thread partition limit, only the newest retained suffix remains. Older rows are deleted immediately after insert.

**Data flow**: Inserts two ~6 MiB thread-scoped rows for the same thread, queries that thread’s logs, and asserts only one row remains and it is the newer timestamp.

**Call relations**: This exercises the thread-partition branch of `StateRuntime::prune_logs_after_insert`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert_eq!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_single_thread_row_when_it_exceeds_size_limit`  (lines 945–980)

```
async fn insert_logs_prunes_single_thread_row_when_it_exceeds_size_limit()
```

**Purpose**: Checks that an oversized single thread-scoped row is pruned entirely when it alone exceeds the partition byte cap. The partition may end up empty.

**Data flow**: Inserts one ~11 MiB thread-scoped row, queries that thread’s logs, and asserts the result set is empty.

**Call relations**: This covers the edge case where the newest row itself is too large to retain under the strict cap.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_threadless_rows_per_process_uuid_only`  (lines 983–1049)

```
async fn insert_logs_prunes_threadless_rows_per_process_uuid_only()
```

**Purpose**: Verifies that threadless retention is partitioned by `process_uuid` and does not interfere with thread-scoped rows from the same process. Only the over-budget threadless partition should be pruned.

**Data flow**: Inserts two large threadless rows for `proc-1` plus one large thread-scoped row for the same process, queries with both thread and threadless inclusion, sorts timestamps, and asserts the retained rows are the newest threadless row and the thread-scoped row.

**Call relations**: This targets the threadless-per-process pruning branch in `StateRuntime::prune_logs_after_insert`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert_eq!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_single_threadless_process_row_when_it_exceeds_size_limit`  (lines 1052–1087)

```
async fn insert_logs_prunes_single_threadless_process_row_when_it_exceeds_size_limit()
```

**Purpose**: Checks that an oversized single threadless row with a non-null process UUID is pruned entirely. No threadless rows should remain for that process.

**Data flow**: Inserts one ~11 MiB threadless row for `proc-oversized`, queries threadless logs, and asserts the result set is empty.

**Call relations**: This covers the oversized-single-row edge case for non-null threadless process partitions.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert!, remove_dir_all).


##### `tests::insert_logs_prunes_threadless_rows_with_null_process_uuid`  (lines 1090–1155)

```
async fn insert_logs_prunes_threadless_rows_with_null_process_uuid()
```

**Purpose**: Verifies that threadless rows with `NULL process_uuid` are retained under their own independent partition budget. Over-budget null-process rows are pruned without affecting other process partitions.

**Data flow**: Inserts two large threadless null-process rows and one small threadless row for `proc-1`, queries threadless logs, sorts timestamps, and asserts only the newest null-process row plus the `proc-1` row remain.

**Call relations**: This exercises the special null-process branch in `StateRuntime::prune_logs_after_insert`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert_eq!, remove_dir_all).


##### `tests::insert_logs_prunes_single_threadless_null_process_row_when_it_exceeds_limit`  (lines 1158–1193)

```
async fn insert_logs_prunes_single_threadless_null_process_row_when_it_exceeds_limit()
```

**Purpose**: Checks that a single oversized threadless row with `NULL process_uuid` is pruned entirely. The null-process partition may become empty.

**Data flow**: Inserts one ~11 MiB threadless null-process row, queries threadless logs, and asserts no rows are returned.

**Call relations**: This is the null-process analogue of the oversized-single-row pruning tests.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert!, remove_dir_all).


##### `tests::insert_logs_prunes_old_rows_when_thread_exceeds_row_limit`  (lines 1196–1236)

```
async fn insert_logs_prunes_old_rows_when_thread_exceeds_row_limit()
```

**Purpose**: Verifies per-thread row-count pruning independent of byte size. When a thread exceeds the row cap, the oldest rows are deleted and the newest 1000 remain.

**Data flow**: Builds and inserts 1001 small thread-scoped rows for one thread, queries them back, and asserts there are 1000 rows spanning timestamps 2 through 1001.

**Call relations**: This covers the `ROW_NUMBER() > LOG_PARTITION_ROW_LIMIT` pruning condition for thread partitions.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert_eq!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_old_threadless_rows_when_process_exceeds_row_limit`  (lines 1239–1283)

```
async fn insert_logs_prunes_old_threadless_rows_when_process_exceeds_row_limit()
```

**Purpose**: Checks row-count pruning for threadless partitions keyed by non-null `process_uuid`. Only the newest 1000 rows for that process should remain.

**Data flow**: Inserts 1001 threadless rows for `proc-row-limit`, queries threadless logs, filters to that process, and asserts timestamps 2 through 1001 remain.

**Call relations**: This exercises row-limit pruning in the threadless non-null process branch.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert_eq!, remove_dir_all).


##### `tests::insert_logs_prunes_old_threadless_null_process_rows_when_row_limit_exceeded`  (lines 1286–1330)

```
async fn insert_logs_prunes_old_threadless_null_process_rows_when_row_limit_exceeded()
```

**Purpose**: Verifies row-count pruning for the special threadless `NULL process_uuid` partition. The oldest null-process row should be dropped once the cap is exceeded.

**Data flow**: Inserts 1001 threadless null-process rows, queries threadless logs, filters to rows with `process_uuid.is_none()`, and asserts timestamps 2 through 1001 remain.

**Call relations**: This covers the row-limit path in the null-process pruning branch.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_returns_newest_lines_within_limit_in_order`  (lines 1333–1400)

```
async fn query_feedback_logs_returns_newest_lines_within_limit_in_order()
```

**Purpose**: Checks that feedback-log export returns chronological lines for a thread’s retained feedback rows. The output should be concatenated in oldest-to-newest order even though SQL fetches newest-first.

**Data flow**: Inserts three thread-scoped rows, calls `query_feedback_logs("thread-1")`, decodes the bytes as UTF-8, and compares the result to the concatenation of three `format_feedback_log_line` outputs in chronological order.

**Call relations**: This test validates both the SQL selection and the final reverse-order assembly in `StateRuntime::query_feedback_logs_for_threads`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_excludes_oversized_newest_row`  (lines 1403–1450)

```
async fn query_feedback_logs_excludes_oversized_newest_row()
```

**Purpose**: Verifies that if the newest retained candidate line alone exceeds the byte budget, feedback export returns nothing rather than a partial line or older suffix. The in-memory exact cap is strict.

**Data flow**: Inserts one small and one oversized newer row for the same thread, calls `query_feedback_logs`, and asserts the returned byte vector is empty.

**Call relations**: This targets the exact whole-line byte-cap loop in `StateRuntime::query_feedback_logs_for_threads`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_includes_threadless_rows_from_same_process`  (lines 1453–1548)

```
async fn query_feedback_logs_includes_threadless_rows_from_same_process()
```

**Purpose**: Checks that feedback export for a thread includes threadless rows from that thread’s latest associated process UUID, but not from other processes. This is the intended merged feedback view.

**Data flow**: Inserts threadless and thread-scoped rows across two processes, queries feedback logs for `thread-1`, decodes the bytes, and asserts the output contains the thread row plus threadless rows from `proc-1` only.

**Call relations**: This exercises the `latest_processes` and merged `feedback_logs` CTE logic in `StateRuntime::query_feedback_logs_for_threads`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_excludes_threadless_rows_from_prior_processes`  (lines 1551–1646)

```
async fn query_feedback_logs_excludes_threadless_rows_from_prior_processes()
```

**Purpose**: Verifies that when a thread has logs in multiple processes over time, feedback export includes threadless rows only from the latest process, not older ones. Process association is intentionally latest-only.

**Data flow**: Inserts thread and threadless rows for `thread-1` in an old process and a new process, queries feedback logs, decodes the bytes, and asserts only the thread row from the old process plus the thread and threadless rows from the new process appear.

**Call relations**: This pins down the semantics of the `latest_processes` subquery used during feedback export.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_keeps_newest_suffix_across_thread_and_threadless_logs`  (lines 1649–1721)

```
async fn query_feedback_logs_keeps_newest_suffix_across_thread_and_threadless_logs()
```

**Purpose**: Checks that the feedback export byte budget is applied across the merged thread and threadless stream, keeping the newest suffix regardless of source. Older thread-scoped lines may be dropped in favor of newer threadless lines.

**Data flow**: Inserts one older thread-scoped ~1 MiB row and two newer threadless rows totaling near the budget, exports feedback logs, decodes them, and asserts the older thread marker is absent while both newer threadless markers remain.

**Call relations**: This test validates the newest-first cumulative-byte selection across the merged feedback stream.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 5 external calls (from_utf8, assert!, assert_eq!, format!, remove_dir_all).


##### `tests::query_feedback_logs_for_threads_merges_requested_threads_and_threadless_rows`  (lines 1724–1841)

```
async fn query_feedback_logs_for_threads_merges_requested_threads_and_threadless_rows()
```

**Purpose**: Verifies the multi-thread feedback API merges rows from all requested threads plus threadless rows from each requested thread’s latest process. Unrequested threads and their threadless rows are excluded.

**Data flow**: Inserts thread-scoped and threadless rows for three processes, calls `query_feedback_logs_for_threads(&["thread-1", "thread-2"])`, decodes the bytes, and asserts the output contains thread-1, thread-2, and threadless rows for proc-1 and proc-2 only.

**Call relations**: This covers the multi-thread variant of the feedback export logic.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_for_threads_returns_empty_for_empty_thread_list`  (lines 1844–1858)

```
async fn query_feedback_logs_for_threads_returns_empty_for_empty_thread_list()
```

**Purpose**: Checks the fast-path behavior for an empty thread list. No SQL work should be needed and the result should be empty bytes.

**Data flow**: Initializes a runtime, calls `query_feedback_logs_for_threads(&[])`, and asserts the returned vector is empty.

**Call relations**: This test covers the explicit early return at the top of `StateRuntime::query_feedback_logs_for_threads`.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).
