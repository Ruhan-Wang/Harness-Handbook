# Feedback capture, debug artifacts, and log persistence  `stage-20.5`

This stage is shared behind-the-scenes support for troubleshooting. It captures clues when something goes wrong, makes them safe to keep or send, and stores them for later inspection. The feedback library gathers recent Codex logs and context into a user feedback report, then packages it for Sentry, an error-reporting service. Feedback diagnostics add network clues, such as proxy settings, and the doctor report can run a diagnostic command and attach only valid JSON results. Response debug context extracts safe details from failed API replies and turns errors into short messages without exposing private response bodies. The secret sanitizer is the safety screen: it removes likely API keys, bearer tokens, and similar credentials before text is logged or shared. Several parts persist raw evidence locally. The response proxy can dump HTTP exchanges as JSON while hiding sensitive headers. Analytics capture writes events as one JSON line per record. The TUI session log records interface traffic when explicitly enabled. Finally, the log database layers collect live tracing logs into SQLite, then store, trim, and read them so debugging data stays useful without growing forever.

## Files in this stage

### Feedback assembly
These files build the feedback capture pipeline, enrich it with optional diagnostics, and add doctor-report attachments and tags before upload packaging.

### `feedback/src/lib.rs`

`domain_logic` · `cross-cutting during runtime; snapshot and upload during feedback reporting`

This file is the feedback box for Codex. While the program runs, it keeps a rolling copy of log text in memory, like a dashboard camera that only remembers the last few minutes. That means feedback can include recent clues without growing forever or writing everything to disk. It also listens for special structured log events called feedback tags, which are key/value facts such as model name, authentication state, or request details.

The main type, CodexFeedback, owns shared feedback state. It can create a logging layer that writes log lines into a fixed-size ring buffer, and a metadata layer that picks up special feedback tag events. Later, snapshot() freezes the current logs, tags, diagnostics, and thread id into a FeedbackSnapshot.

A FeedbackSnapshot can be saved to a temporary file or uploaded to Sentry, an external error and feedback collection service. Uploads include a classification such as bug or good result, a human-readable reason if present, protected reserved tags such as thread id and CLI version, and optional attachments. Attachments may be in-memory diagnostics, captured logs, or files read from disk. If a file attachment cannot be read, it is skipped and a warning is logged instead of failing the whole report.

The file also includes tests for the rolling buffer, tag collection, attachment gating, and reserved upload tags.

#### Function details

##### `FeedbackRequestSnapshot::from_tags`  (lines 77–102)

```
fn from_tags(tags: &'a FeedbackRequestTags<'a>) -> Self
```

**Purpose**: This converts request and authentication feedback fields into a safer, upload-ready snapshot. Optional values are turned into empty strings so later logging can record a complete set of fields without checking every value again.

**Data flow**: It receives a FeedbackRequestTags value with borrowed text, booleans, numbers, and optional fields. It copies references where possible and turns optional booleans or numbers into strings. The result is a FeedbackRequestSnapshot where every field has a concrete value ready to be emitted as structured feedback metadata.

**Call relations**: When request feedback tags need to be emitted, both emit_feedback_request_tags and emit_feedback_request_tags_with_auth_env call this first. It acts as the cleanup step before those functions hand the data to the tracing system.

*Call graph*: called by 2 (emit_feedback_request_tags, emit_feedback_request_tags_with_auth_env).


##### `emit_feedback_request_tags`  (lines 105–124)

```
fn emit_feedback_request_tags(tags: &FeedbackRequestTags<'_>)
```

**Purpose**: This records request and authentication details as special feedback tags. These tags are not ordinary user-facing logs; they are structured facts saved for a future feedback upload.

**Data flow**: It receives request tag data, converts it into a snapshot with defaults for missing fields, then emits a tracing event using the special feedback_tags target. The output is not a return value; the metadata layer can later catch this event and store the fields.

**Call relations**: Callers use this when they want request context to follow a future feedback report. It calls FeedbackRequestSnapshot::from_tags, then hands the fields to the tracing system, where FeedbackMetadataLayer::on_event can collect them.

*Call graph*: calls 1 internal fn (from_tags); 1 external calls (info!).


##### `emit_feedback_request_tags_with_auth_env`  (lines 126–161)

```
fn emit_feedback_request_tags_with_auth_env(
    tags: &FeedbackRequestTags<'_>,
    auth_env: &AuthEnvTelemetry,
)
```

**Purpose**: This records request and authentication details plus safe information about authentication-related environment variables. It helps diagnose login and API-key problems without uploading secret values.

**Data flow**: It receives request tags and an AuthEnvTelemetry value describing whether certain environment settings are present or enabled. It snapshots the request tags, adds safe environment buckets, and emits everything as a structured tracing event. Nothing is returned; the event can be captured later as feedback metadata.

**Call relations**: This is the richer version of emit_feedback_request_tags. It calls FeedbackRequestSnapshot::from_tags, then sends the combined request and environment facts to tracing for FeedbackMetadataLayer::on_event to store.

*Call graph*: calls 1 internal fn (from_tags); 1 external calls (info!).


##### `CodexFeedback::default`  (lines 169–171)

```
fn default() -> Self
```

**Purpose**: This creates a standard feedback collector when code asks for the default value. It uses the normal log memory limit.

**Data flow**: It takes no input. It delegates to CodexFeedback::new and returns a ready-to-use CodexFeedback instance.

**Call relations**: This exists so CodexFeedback can be created through Rust's usual Default pattern. The real setup work is handed off to CodexFeedback::new.

*Call graph*: 1 external calls (new).


##### `CodexFeedback::new`  (lines 175–177)

```
fn new() -> Self
```

**Purpose**: This creates the normal feedback collector used by the application. It keeps up to the default number of recent log bytes in memory.

**Data flow**: It takes no input. It calls CodexFeedback::with_capacity with the default maximum size and returns a collector with an empty ring buffer and empty metadata tags.

**Call relations**: Startup and test helpers call this when they need feedback capture. It delegates to CodexFeedback::with_capacity so the capacity choice stays in one place.

*Call graph*: called by 30 (runtime_start_args_forward_environment_manager, runtime_start_args_use_remote_thread_config_loader_when_configured, start_test_client_with_capacity, start_test_client_with_capacity, build_test_processor, run_main_with_transport_options, get_conversation_summary_by_thread_id_reads_pathless_store_thread, mcp_resource_read_returns_error_for_unknown_thread, start_in_process_client, thread_list_includes_store_thread_without_rollout_path (+15 more)); 1 external calls (with_capacity).


##### `CodexFeedback::with_capacity`  (lines 179–183)

```
fn with_capacity(max_bytes: usize) -> Self
```

**Purpose**: This creates a feedback collector with a custom memory limit for stored logs. It is mainly useful for tests or special cases that need a smaller or larger rolling buffer.

**Data flow**: It receives the maximum number of bytes to keep. It builds a shared FeedbackInner containing a ring buffer of that size and an empty tag map, then returns a CodexFeedback wrapper around it.

**Call relations**: CodexFeedback::new calls this with the standard limit, and the ring buffer test calls it with a tiny limit to prove old log bytes are dropped correctly. It relies on FeedbackInner::new for the actual shared state.

*Call graph*: calls 1 internal fn (new); called by 1 (ring_buffer_drops_front_when_full); 1 external calls (new).


##### `CodexFeedback::make_writer`  (lines 185–189)

```
fn make_writer(&self) -> FeedbackMakeWriter
```

**Purpose**: This creates a writer that log formatting code can write into. The writer sends bytes into the in-memory feedback buffer instead of a file or terminal.

**Data flow**: It reads the shared feedback state from the CodexFeedback object and returns a FeedbackMakeWriter that can create individual FeedbackWriter values later. The underlying log buffer is shared, not copied.

**Call relations**: CodexFeedback::logger_layer calls this when building the tracing layer. The returned object is used by tracing-subscriber whenever it needs a fresh writer for a log event.

*Call graph*: called by 1 (logger_layer).


##### `CodexFeedback::logger_layer`  (lines 196–208)

```
fn logger_layer(&self) -> impl Layer<S> + Send + Sync + 'static
```

**Purpose**: This builds a logging layer that captures full-detail logs into the feedback buffer. It ignores the user's normal log filtering so a feedback report can contain the clues needed to debug a problem.

**Data flow**: It takes the feedback collector, creates a writer for it, and configures a tracing-subscriber formatting layer with timestamps, no color codes, no target text, and trace-level capture. The output is a layer that application startup code can install into the tracing system.

**Call relations**: Initialization code uses this to connect normal logging to feedback capture. It calls CodexFeedback::make_writer, and then later FeedbackMakeWriter::make_writer and FeedbackWriter::write do the actual byte storage.

*Call graph*: calls 1 internal fn (make_writer); 2 external calls (new, layer).


##### `CodexFeedback::metadata_layer`  (lines 214–222)

```
fn metadata_layer(&self) -> impl Layer<S> + Send + Sync + 'static
```

**Purpose**: This builds a tracing layer that listens only for feedback tag events. It collects structured facts that should be attached to a future feedback upload.

**Data flow**: It takes the shared feedback state and wraps it in a FeedbackMetadataLayer. It applies a filter so only events with the special feedback_tags target are seen. The result is a layer that can be installed alongside other tracing layers.

**Call relations**: Startup code installs this so calls such as emit_feedback_request_tags can be captured. When a matching event arrives, FeedbackMetadataLayer::on_event stores the fields.

*Call graph*: 1 external calls (new).


##### `CodexFeedback::snapshot`  (lines 224–243)

```
fn snapshot(&self, session_id: Option<ThreadId>) -> FeedbackSnapshot
```

**Purpose**: This freezes the current feedback state into a standalone report object. It captures the recent logs, current tags, diagnostics from the environment, and the active thread id if there is one.

**Data flow**: It receives an optional ThreadId. It locks the log buffer and copies its bytes, locks the tag map and clones it, collects diagnostics from the environment, and chooses either the provided thread id or a generated no-active-thread id. It returns a FeedbackSnapshot containing all of that.

**Call relations**: Feedback upload and consent flows call this when they need a report. It reads from FeedbackInner's ring buffer and tag map, then hands the frozen data to methods such as save_to_temp_file and upload_feedback.

*Call graph*: calls 2 internal fn (collect_from_env, new); called by 2 (upload_feedback_response, open_feedback_consent).


##### `FeedbackInner::new`  (lines 252–257)

```
fn new(max_bytes: usize) -> Self
```

**Purpose**: This creates the shared internal storage behind CodexFeedback. It holds both recent log bytes and feedback tags, each protected by a mutex, which is a lock that stops two tasks from changing the same data at once.

**Data flow**: It receives a maximum byte size. It creates a RingBuffer with that capacity and an empty ordered map for tags, wraps both in mutexes, and returns the internal state object.

**Call relations**: CodexFeedback::with_capacity calls this while creating a feedback collector. Other parts of the file then share this inner state through Arc, a thread-safe shared pointer.

*Call graph*: calls 1 internal fn (new); called by 1 (with_capacity); 2 external calls (new, new).


##### `FeedbackMakeWriter::make_writer`  (lines 268–272)

```
fn make_writer(&'a self) -> Self::Writer
```

**Purpose**: This produces an actual writer for one logging operation. The writer knows how to append bytes to the shared feedback buffer.

**Data flow**: It receives the reusable writer factory and clones its shared feedback pointer. It returns a FeedbackWriter that points at the same underlying ring buffer.

**Call relations**: The tracing-subscriber logging layer calls this whenever it needs somewhere to write formatted log text. The returned FeedbackWriter then sends the bytes to FeedbackWriter::write.


##### `FeedbackWriter::write`  (lines 280–284)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: This appends log bytes to the rolling in-memory feedback buffer. It reports success for all bytes it was given unless the buffer lock is unusable.

**Data flow**: It receives a byte slice from the logging system. It locks the shared ring buffer, pushes the bytes into it, drops old bytes if needed, and returns the number of bytes accepted. If the lock is poisoned, it returns an I/O error.

**Call relations**: Writers created by FeedbackMakeWriter::make_writer use this during log capture. It hands the actual storage work to RingBuffer::push_bytes.


##### `FeedbackWriter::flush`  (lines 286–288)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: This satisfies the standard writer interface. Because the feedback writer stores bytes immediately in memory, there is nothing extra to flush.

**Data flow**: It receives a mutable writer reference and does no work. It returns success.

**Call relations**: The logging system may call this because all writers are expected to support flushing. In this implementation it is a no-op because FeedbackWriter::write already stores the data.


##### `RingBuffer::new`  (lines 297–302)

```
fn new(capacity: usize) -> Self
```

**Purpose**: This creates an empty fixed-size byte buffer. It is used to remember only the most recent logs.

**Data flow**: It receives a capacity in bytes. It creates an empty VecDeque, which is a double-ended queue, with room for that many bytes, and stores the maximum size beside it. The result is an empty RingBuffer.

**Call relations**: FeedbackInner::new calls this when setting up feedback storage. Later, FeedbackWriter::write fills it through RingBuffer::push_bytes.

*Call graph*: called by 1 (new); 1 external calls (with_capacity).


##### `RingBuffer::len`  (lines 304–306)

```
fn len(&self) -> usize
```

**Purpose**: This reports how many bytes are currently stored in the ring buffer. It is used to decide whether new bytes will overflow the limit.

**Data flow**: It reads the buffer length and returns that number. It does not change the buffer.

**Call relations**: RingBuffer::push_bytes calls this before adding new data. That lets push_bytes calculate how many old bytes must be removed.

*Call graph*: called by 1 (push_bytes); 1 external calls (len).


##### `RingBuffer::push_bytes`  (lines 308–331)

```
fn push_bytes(&mut self, data: &[u8])
```

**Purpose**: This adds new bytes while keeping only the newest data within the fixed capacity. If too much arrives, older bytes are discarded from the front.

**Data flow**: It receives a slice of bytes. If the slice is empty, it does nothing. If the slice alone is larger than the buffer capacity, it clears the buffer and keeps only the tail end of the slice. Otherwise, it removes just enough old bytes to make room, then appends the new bytes.

**Call relations**: FeedbackWriter::write calls this whenever a log line is captured. RingBuffer::snapshot_bytes later copies out the kept bytes for a feedback snapshot.

*Call graph*: calls 1 internal fn (len); 3 external calls (clear, extend, pop_front).


##### `RingBuffer::snapshot_bytes`  (lines 333–335)

```
fn snapshot_bytes(&self) -> Vec<u8>
```

**Purpose**: This copies the current contents of the ring buffer into a regular byte vector. It gives snapshot code a stable copy of the logs.

**Data flow**: It reads the bytes in their stored order from oldest kept byte to newest kept byte. It returns a Vec<u8> containing those bytes and does not change the buffer.

**Call relations**: CodexFeedback::snapshot calls this after locking the ring buffer. The copied bytes become part of a FeedbackSnapshot.

*Call graph*: 1 external calls (iter).


##### `FeedbackSnapshot::as_bytes`  (lines 388–390)

```
fn as_bytes(&self) -> &[u8]
```

**Purpose**: This exposes the captured log bytes inside a feedback snapshot. It is a read-only view, so callers can inspect or write the logs without taking ownership of them.

**Data flow**: It receives a FeedbackSnapshot reference and returns a byte slice pointing at its stored log bytes. Nothing is copied or changed.

**Call relations**: FeedbackSnapshot::save_to_temp_file calls this when writing the captured logs to disk. Tests also use it to check what the ring buffer saved.

*Call graph*: called by 1 (save_to_temp_file).


##### `FeedbackSnapshot::feedback_diagnostics`  (lines 392–394)

```
fn feedback_diagnostics(&self) -> &FeedbackDiagnostics
```

**Purpose**: This exposes the diagnostic information collected with the snapshot. Callers can inspect those diagnostics before deciding what to show or upload.

**Data flow**: It receives a FeedbackSnapshot reference and returns a reference to its FeedbackDiagnostics value. The snapshot is not changed.

**Call relations**: This is a simple access point for code that needs diagnostics collected by CodexFeedback::snapshot. It does not call other helpers.


##### `FeedbackSnapshot::with_feedback_diagnostics`  (lines 396–399)

```
fn with_feedback_diagnostics(mut self, feedback_diagnostics: FeedbackDiagnostics) -> Self
```

**Purpose**: This replaces the diagnostics inside a snapshot and returns the modified snapshot. It is useful for tests or callers that already computed diagnostics another way.

**Data flow**: It receives a snapshot by value and a FeedbackDiagnostics value. It swaps the snapshot's diagnostics for the provided one and returns the snapshot.

**Call relations**: Tests use this to create controlled snapshots with or without diagnostics. Later methods such as feedback_diagnostics_attachment_text and feedback_attachments read the updated diagnostics.


##### `FeedbackSnapshot::feedback_diagnostics_attachment_text`  (lines 401–407)

```
fn feedback_diagnostics_attachment_text(&self, include_logs: bool) -> Option<String>
```

**Purpose**: This decides whether diagnostic text should be attached to feedback and, if so, creates that text. Diagnostics are only included when logs are also allowed.

**Data flow**: It receives a boolean saying whether logs may be included. If logs are not included, it returns None. If logs are included, it asks the FeedbackDiagnostics object for attachment text and returns that optional text.

**Call relations**: FeedbackSnapshot::feedback_attachments calls this while building upload attachments. This keeps the consent rule in one place: diagnostics travel with log permission.

*Call graph*: calls 1 internal fn (attachment_text); called by 1 (feedback_attachments).


##### `FeedbackSnapshot::save_to_temp_file`  (lines 409–415)

```
fn save_to_temp_file(&self) -> io::Result<PathBuf>
```

**Purpose**: This writes the captured logs to a temporary file. It is useful when feedback logs need to be handed to another process or shown as a file path.

**Data flow**: It builds a filename using the snapshot's thread id inside the system temporary directory. It writes the snapshot's log bytes to that path and returns the path if successful, or an I/O error if writing fails.

**Call relations**: It calls FeedbackSnapshot::as_bytes to get the log contents. It is separate from upload_feedback because saving locally and uploading to Sentry are different uses of the same snapshot.

*Call graph*: calls 1 internal fn (as_bytes); 3 external calls (format!, write, temp_dir).


##### `FeedbackSnapshot::upload_feedback`  (lines 418–487)

```
fn upload_feedback(&self, options: FeedbackUploadOptions<'_>) -> Result<()>
```

**Purpose**: This sends a feedback report to Sentry. It builds the event, tags it with useful context, adds allowed attachments, sends it, and waits briefly for the upload to finish.

**Data flow**: It receives upload options such as classification, reason, tags, whether logs may be included, attachments, session source, and optional replacement log bytes. It creates a Sentry client, builds upload tags, chooses an error or info severity, creates a Sentry envelope with one event and any attachments, sends it, flushes for up to the timeout, and returns success or an error from setup.

**Call relations**: Feedback flows call this after user consent and snapshot creation. It calls FeedbackSnapshot::upload_tags to prepare tags, display_classification for the title, and FeedbackSnapshot::feedback_attachments to gather files and buffers.

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

**Purpose**: This builds the final tag map sent with a feedback upload. It protects important reserved fields so callers cannot accidentally replace the real thread id, classification, CLI version, session source, or reason.

**Data flow**: It receives the classification, optional reason, optional caller-provided tags, and optional session source. It starts with reserved tags from the snapshot and package version, adds session source and reason when present, then fills in non-reserved tags from client tags and snapshot tags without overwriting existing keys. It returns the final ordered map.

**Call relations**: FeedbackSnapshot::upload_feedback calls this before building the Sentry event. The upload tag test checks that reserved fields stay trustworthy while useful custom tags are preserved.

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

**Purpose**: This builds the list of files and buffers to attach to a feedback upload. It respects the log-inclusion choice and skips unreadable file attachments instead of stopping the whole upload.

**Data flow**: It receives whether logs may be included, in-memory attachments, file-backed attachment paths, and optional replacement log bytes. It adds codex-logs.log if allowed, copies in-memory attachments, adds diagnostic text if allowed and available, then reads each path-backed file and attaches it with either an override name or its file name. It returns a vector of Sentry attachment objects.

**Call relations**: FeedbackSnapshot::upload_feedback calls this when filling the Sentry envelope. It calls FeedbackSnapshot::feedback_diagnostics_attachment_text for diagnostics and logs a warning if a path-backed attachment cannot be read.

*Call graph*: calls 1 internal fn (feedback_diagnostics_attachment_text); called by 1 (upload_feedback); 5 external calls (from, new, iter, read, warn!).


##### `display_classification`  (lines 608–616)

```
fn display_classification(classification: &str) -> String
```

**Purpose**: This turns an internal feedback classification code into a friendly label. It makes Sentry event titles easier for humans to read.

**Data flow**: It receives a classification string such as bug or bad_result. It matches known values to labels like Bug or Bad result, and returns Other for anything unknown.

**Call relations**: FeedbackSnapshot::upload_feedback uses this while composing the Sentry event title. It is a small formatting helper with no side effects.


##### `FeedbackMetadataLayer::on_event`  (lines 627–648)

```
fn on_event(&self, event: &Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>)
```

**Purpose**: This catches special feedback tag tracing events and stores their fields for later upload. It enforces a maximum number of distinct tags so feedback metadata cannot grow without limit.

**Data flow**: It receives a tracing event. If the event target is not feedback_tags, it ignores it. Otherwise it records the event fields into a FeedbackTagsVisitor, locks the shared tag map, and inserts or updates each tag, skipping new keys once the tag limit has been reached.

**Call relations**: The tracing system calls this for events seen by the metadata layer made by CodexFeedback::metadata_layer. It uses FeedbackTagsVisitor to turn event fields into strings, and CodexFeedback::snapshot later copies the stored tags.

*Call graph*: 3 external calls (default, metadata, record).


##### `FeedbackTagsVisitor::record_i64`  (lines 657–660)

```
fn record_i64(&mut self, field: &tracing::field::Field, value: i64)
```

**Purpose**: This records a signed integer field from a feedback tag event. It stores the number as text so all tags share one simple string format.

**Data flow**: It receives a tracing field and an i64 value. It uses the field name as the tag key, converts the number to a string, and inserts it into the visitor's tag map.

**Call relations**: Tracing calls this through event.record when FeedbackMetadataLayer::on_event is reading an event. The collected tag map is then merged into the shared feedback tags.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_u64`  (lines 662–665)

```
fn record_u64(&mut self, field: &tracing::field::Field, value: u64)
```

**Purpose**: This records an unsigned integer field from a feedback tag event. It converts the value to text for consistent tag storage.

**Data flow**: It receives a field and a u64 value. It stores the field name and stringified value in the visitor's tag map.

**Call relations**: Tracing may call this while FeedbackMetadataLayer::on_event records an event. The resulting key/value pair can later appear in upload tags.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_bool`  (lines 667–670)

```
fn record_bool(&mut self, field: &tracing::field::Field, value: bool)
```

**Purpose**: This records a true-or-false field from a feedback tag event. It makes boolean context available as ordinary string tags.

**Data flow**: It receives a field and a boolean value. It stores the field name with the value converted to true or false text.

**Call relations**: Tracing calls this during FeedbackMetadataLayer::on_event when an event contains a boolean field. This is how fields like cached = true become feedback tags.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_f64`  (lines 672–675)

```
fn record_f64(&mut self, field: &tracing::field::Field, value: f64)
```

**Purpose**: This records a floating-point number field from a feedback tag event. It converts the number into text for later upload.

**Data flow**: It receives a field and an f64 value. It stores the field name and the value's string form in the visitor's tag map.

**Call relations**: Tracing calls this through the Visit interface while FeedbackMetadataLayer::on_event is collecting event fields. The stored value can then be copied into the shared tag map.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_str`  (lines 677–680)

```
fn record_str(&mut self, field: &tracing::field::Field, value: &str)
```

**Purpose**: This records a text field from a feedback tag event. It is the direct path for string metadata such as model names or request ids.

**Data flow**: It receives a field and a string slice. It copies the field name and value into the visitor's tag map.

**Call relations**: Tracing calls this when FeedbackMetadataLayer::on_event records string fields. The visitor later hands these tags back to the metadata layer for storage.

*Call graph*: 1 external calls (name).


##### `FeedbackTagsVisitor::record_debug`  (lines 682–685)

```
fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug)
```

**Purpose**: This records any field that is supplied in debug form. Debug form means Rust's general-purpose printable representation, used when a value does not have a more specific visitor method.

**Data flow**: It receives a field and a value that can be formatted for debugging. It formats the value with debug formatting and stores it under the field name in the visitor's tag map.

**Call relations**: The emit_feedback_request_tags functions intentionally emit many fields using debug formatting, so tracing may call this while FeedbackMetadataLayer::on_event collects them. The result becomes ordinary string metadata.

*Call graph*: 2 external calls (name, format!).


##### `tests::ring_buffer_drops_front_when_full`  (lines 700–710)

```
fn ring_buffer_drops_front_when_full()
```

**Purpose**: This test proves that the log buffer keeps the newest bytes when it runs out of space. It protects the dashboard-camera behavior of the feedback log.

**Data flow**: It creates a feedback collector with room for only eight bytes, writes ten bytes through the feedback writer, takes a snapshot, and checks that the stored bytes are the final eight characters. The test passes only if the oldest two bytes were dropped.

**Call relations**: The test calls CodexFeedback::with_capacity to force a tiny buffer and exercises the same writer path used by logging. It verifies RingBuffer::push_bytes indirectly through the public feedback flow.

*Call graph*: calls 1 internal fn (with_capacity); 1 external calls (assert_eq!).


##### `tests::metadata_layer_records_tags_from_feedback_target`  (lines 713–724)

```
fn metadata_layer_records_tags_from_feedback_target()
```

**Purpose**: This test proves that the metadata layer captures fields from feedback tag events. It checks that both string and boolean fields are saved as tags.

**Data flow**: It creates a feedback collector, installs its metadata layer as the active tracing subscriber, emits a feedback_tags event with model and cached fields, then snapshots the collector. It checks that the snapshot's tag map contains model = gpt-5 and cached = true.

**Call relations**: The test uses CodexFeedback::metadata_layer and a tracing info event to drive FeedbackMetadataLayer::on_event and FeedbackTagsVisitor. It confirms that CodexFeedback::snapshot can later see the collected tags.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, info!, registry).


##### `tests::feedback_attachments_gate_connectivity_diagnostics`  (lines 727–795)

```
fn feedback_attachments_gate_connectivity_diagnostics()
```

**Purpose**: This test checks how upload attachments are assembled, especially that diagnostics are included only when logs are included and only when diagnostics exist. It also checks extra in-memory and file-backed attachments.

**Data flow**: It writes a temporary extra attachment file, creates a snapshot with a known diagnostic, builds attachments with logs enabled and a log override, and checks the filenames and byte contents. Then it creates a snapshot without diagnostics and checks that only the log attachment remains. Finally it removes the temporary file.

**Call relations**: The test calls CodexFeedback::new, FeedbackSnapshot::with_feedback_diagnostics, and FeedbackSnapshot::feedback_attachments. It protects the consent-related attachment behavior used by FeedbackSnapshot::upload_feedback.

*Call graph*: calls 2 internal fn (new, new); 8 external calls (assert_eq!, default, format!, remove_file, write, temp_dir, from_ref, vec!).


##### `tests::upload_tags_include_client_tags_and_preserve_reserved_fields`  (lines 798–871)

```
fn upload_tags_include_client_tags_and_preserve_reserved_fields()
```

**Purpose**: This test proves that upload tags include useful custom fields but do not let callers overwrite reserved fields. Reserved fields are important because they identify what session and version the report really came from.

**Data flow**: It builds a snapshot with some deliberately wrong reserved tag values plus valid custom tags, then builds client tags with more wrong reserved values and useful extras. It calls upload_tags for a bug report and checks that reserved values come from the trusted inputs while non-reserved tags are kept.

**Call relations**: The test exercises FeedbackSnapshot::upload_tags directly. It confirms the tag rules that FeedbackSnapshot::upload_feedback relies on before sending a Sentry event.

*Call graph*: 4 external calls (new, new, assert_eq!, default).


### `feedback/src/feedback_diagnostics.rs`

`domain_logic` · `feedback submission`

When a user reports a connectivity problem, the support team needs hints about what might be interfering with network traffic. One common cause is a proxy: a server or setting that routes web requests through another place, often used by companies or VPN-like setups. This file looks for well-known proxy environment variables, such as HTTP_PROXY and HTTPS_PROXY, and records any that are present.

The main type, FeedbackDiagnostics, is a small container for one or more FeedbackDiagnostic items. Each item has a headline, which explains the issue in human language, and detail lines, which show the exact environment variables found. If no relevant variables are found, the diagnostics stay empty and no attachment text is produced.

The file can collect diagnostics directly from the running process environment, or from a supplied list of key-value pairs. That second path makes the behavior easy to test without changing the real computer environment. It also formats the diagnostics into plain text headed "Connectivity diagnostics", suitable for saving as the feedback attachment named by FEEDBACK_DIAGNOSTICS_ATTACHMENT_FILENAME.

An important detail is that values are reported exactly as found. The code does not validate, trim, or hide passwords or tokens inside proxy URLs. That makes the diagnostics faithful, but it also means callers must be careful about user consent before uploading them.

#### Function details

##### `FeedbackDiagnostics::new`  (lines 25–27)

```
fn new(diagnostics: Vec<FeedbackDiagnostic>) -> Self
```

**Purpose**: Creates a FeedbackDiagnostics value from diagnostics that were already built elsewhere. This is useful when another part of the feedback flow already knows what diagnostic messages should be shown or attached.

**Data flow**: It receives a list of FeedbackDiagnostic records. It stores that list inside a new FeedbackDiagnostics object and returns it without changing the records.

**Call relations**: Several feedback consent and attachment flows call this when they need a ready-made diagnostics object for display, gating, or snapshot testing. It does not call out to any other logic; it is the simple doorway for packaging existing diagnostic data.

*Call graph*: called by 4 (feedback_attachments_gate_connectivity_diagnostics, should_show_feedback_connectivity_details_only_for_non_good_result_with_diagnostics, feedback_good_result_consent_popup_includes_connectivity_diagnostics_filename, feedback_upload_consent_popup_snapshot).


##### `FeedbackDiagnostics::collect_from_env`  (lines 29–31)

```
fn collect_from_env() -> Self
```

**Purpose**: Collects connectivity diagnostics from the current process environment. Someone would use this when preparing real feedback from a running Codex session.

**Data flow**: It reads all environment variables from the operating system, then passes those key-value pairs into the shared collection routine. The result is a FeedbackDiagnostics object containing any proxy-related findings.

**Call relations**: The snapshot flow calls this to capture the real environment state. This function delegates the actual filtering and formatting work to FeedbackDiagnostics::collect_from_pairs so the same rules are used for real runs and tests.

*Call graph*: called by 1 (snapshot); 2 external calls (collect_from_pairs, vars).


##### `FeedbackDiagnostics::collect_from_pairs`  (lines 33–61)

```
fn collect_from_pairs(pairs: I) -> Self
```

**Purpose**: Builds diagnostics from a supplied set of environment-style key-value pairs. It looks only for known proxy variable names and reports them as possible causes of connectivity trouble.

**Data flow**: It takes incoming pairs, converts keys and values into strings, and puts them in a lookup table. It checks the known proxy variable names in a fixed order. For every matching variable, it creates a detail line like "HTTP_PROXY = value". If at least one detail exists, it returns a FeedbackDiagnostics object with one warning-style diagnostic; otherwise it returns an empty one.

**Call relations**: FeedbackDiagnostics::collect_from_env uses this after reading the real environment. The test functions also call it directly with fake variables, which lets them verify the rules without depending on the developer machine running the tests.

*Call graph*: called by 4 (collect_from_pairs_ignores_absent_values, collect_from_pairs_preserves_whitespace_and_empty_values, collect_from_pairs_reports_raw_values_and_attachment, collect_from_pairs_reports_values_verbatim); 2 external calls (into_iter, new).


##### `FeedbackDiagnostics::is_empty`  (lines 63–65)

```
fn is_empty(&self) -> bool
```

**Purpose**: Answers whether there are any diagnostics to show or upload. Callers use it to avoid showing empty connectivity sections.

**Data flow**: It reads the stored diagnostics list. If the list has no items, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: Feedback upload consent code and connectivity-detail display logic call this before deciding whether diagnostics should appear. It acts like a quick yes-or-no check before the rest of the feedback UI does more work.

*Call graph*: called by 2 (feedback_upload_consent_params, should_show_feedback_connectivity_details).


##### `FeedbackDiagnostics::diagnostics`  (lines 67–69)

```
fn diagnostics(&self) -> &[FeedbackDiagnostic]
```

**Purpose**: Gives read-only access to the collected diagnostic records. This lets other feedback code display or inspect the messages without taking ownership of them.

**Data flow**: It receives the FeedbackDiagnostics object by reference, reads its internal list, and returns a read-only slice of that same list. Nothing is copied or modified.

**Call relations**: The feedback upload consent parameter builder calls this when it needs the actual diagnostic headlines and details. This function keeps the stored data protected while still making it available for presentation.

*Call graph*: called by 1 (feedback_upload_consent_params).


##### `FeedbackDiagnostics::attachment_text`  (lines 71–88)

```
fn attachment_text(&self) -> Option<String>
```

**Purpose**: Formats the diagnostics as plain text for a feedback attachment. It returns no text when there is nothing useful to attach.

**Data flow**: It first checks whether the diagnostics list is empty. If it is empty, it returns None. Otherwise it builds lines beginning with "Connectivity diagnostics", adds each diagnostic headline as a bullet, adds each detail as an indented bullet, joins the lines with newline characters, and returns that text.

**Call relations**: The feedback diagnostics attachment code calls this when it needs the body of the diagnostic attachment. This function turns the structured records created earlier into the human-readable file content that can travel with a feedback report.

*Call graph*: called by 1 (feedback_diagnostics_attachment_text); 2 external calls (format!, vec!).


##### `tests::collect_from_pairs_reports_raw_values_and_attachment`  (lines 99–137)

```
fn collect_from_pairs_reports_raw_values_and_attachment()
```

**Purpose**: Checks that proxy variables are reported with their exact raw values and that the attachment text is formatted as expected. It confirms that even sensitive-looking URL parts are not hidden by this code.

**Data flow**: It supplies fake HTTPS, lowercase http, and lowercase all-proxy variables to FeedbackDiagnostics::collect_from_pairs. It then compares the returned diagnostics and the generated attachment text against exact expected strings.

**Call relations**: The test runner calls this during automated testing. It exercises FeedbackDiagnostics::collect_from_pairs and attachment_text together, proving that collection order and final text formatting match the intended feedback attachment behavior.

*Call graph*: calls 1 internal fn (collect_from_pairs); 1 external calls (assert_eq!).


##### `tests::collect_from_pairs_ignores_absent_values`  (lines 140–144)

```
fn collect_from_pairs_ignores_absent_values()
```

**Purpose**: Checks that no diagnostics are produced when no relevant environment variables are present. This protects users from seeing or uploading an empty diagnostics attachment.

**Data flow**: It passes an empty list of pairs into FeedbackDiagnostics::collect_from_pairs. It expects the result to equal the default empty diagnostics object and expects attachment_text to return None.

**Call relations**: The test runner calls this as part of the file’s automated checks. It focuses on the quiet path used when there are no proxy clues to report.

*Call graph*: calls 1 internal fn (collect_from_pairs); 2 external calls (new, assert_eq!).


##### `tests::collect_from_pairs_preserves_whitespace_and_empty_values`  (lines 147–161)

```
fn collect_from_pairs_preserves_whitespace_and_empty_values()
```

**Purpose**: Checks that proxy values are preserved exactly, including surrounding spaces. This documents that the diagnostics are a raw report, not cleaned-up or interpreted settings.

**Data flow**: It passes a fake HTTP_PROXY value containing leading and trailing spaces into FeedbackDiagnostics::collect_from_pairs. It then verifies that the resulting detail line keeps those spaces intact.

**Call relations**: The test runner calls this to guard against future changes that might trim or normalize values. It supports the broader rule that this file reports what it sees.

*Call graph*: calls 1 internal fn (collect_from_pairs); 1 external calls (assert_eq!).


##### `tests::collect_from_pairs_reports_values_verbatim`  (lines 164–178)

```
fn collect_from_pairs_reports_values_verbatim()
```

**Purpose**: Checks that even invalid-looking proxy values are still reported exactly. The diagnostics are meant to show environment state, not decide whether the state is correct.

**Data flow**: It passes HTTP_PROXY with the value "not a valid proxy" into FeedbackDiagnostics::collect_from_pairs. It verifies that the output includes that same text unchanged in the detail line.

**Call relations**: The test runner calls this during automated testing. It reinforces that FeedbackDiagnostics::collect_from_pairs does not parse or reject proxy values; it simply records them for feedback context.

*Call graph*: calls 1 internal fn (collect_from_pairs); 1 external calls (assert_eq!).


### `app-server/src/request_processors/feedback_doctor_report.rs`

`domain_logic` · `feedback upload`

When a user sends feedback, the system can include extra diagnostic information, much like attaching a mechanic’s inspection sheet when reporting a car problem. This file creates that attachment by running `codex doctor --json`, which is Codex’s own health-check command in a machine-readable form.

The important rule is that feedback must still work even if the doctor report fails. So this code treats the report as “best effort.” It tries to find the Codex executable, starts it as a separate process, waits up to 25 seconds, and then accepts the output only if it contains valid JSON. If the command cannot run, takes too long, or prints invalid data, the file logs a warning and returns nothing. That prevents a diagnostic helper from breaking the main feedback path.

When the JSON is valid, the file pretty-prints it into a feedback attachment named like the standard doctor report. It also extracts small summary labels called Sentry tags. Sentry is an error-reporting service, and tags help group reports without storing large or highly variable data. The tags include the overall doctor status, counts of checks that passed, warned, or failed, and shortened lists of warning or failed check IDs.

#### Function details

##### `doctor_feedback_report`  (lines 37–98)

```
async fn doctor_feedback_report(config: &Config) -> Option<DoctorFeedbackReport>
```

**Purpose**: This is the main entry point for building the optional doctor-report attachment. It runs the Codex diagnostic command, checks that the result is usable JSON, and packages it for a feedback upload.

**Data flow**: It takes the current configuration, looks for the Codex executable path, and starts that executable with `doctor --json`. It waits for the process with a timeout, reads the command’s output, finds and parses the JSON, and then creates two outputs: a JSON attachment and a map of short summary tags. If any step fails, it returns no report and leaves the feedback upload free to continue without it.

**Call relations**: The feedback upload flow calls this when preparing a response. After it successfully parses the doctor JSON, it hands the parsed report to `doctor_report_tags` to make compact Sentry-friendly labels, then returns both the labels and the attachment to the caller.

*Call graph*: calls 1 internal fn (doctor_report_tags); called by 1 (upload_feedback_response); 6 external calls (from_utf8_lossy, new, from_str, to_vec_pretty, timeout, warn!).


##### `doctor_report_tags`  (lines 100–152)

```
fn doctor_report_tags(report: &Value) -> BTreeMap<String, String>
```

**Purpose**: This function turns a full doctor JSON report into a small set of searchable summary tags. The goal is to keep useful diagnostic clues without attaching large or overly detailed values as tags.

**Data flow**: It receives parsed JSON. It reads the overall status, walks through the report’s checks, counts how many are `ok`, `warning`, or `fail`, and collects the IDs of warning and failed checks. It returns a sorted map of tag names to string values, shortening long values so they stay within the tag length limit.

**Call relations**: It is used by `doctor_feedback_report` after the doctor command has produced valid JSON. The unit test also calls it directly to prove that it summarizes statuses correctly. While building the tags, it asks `check_values` how to iterate through the checks and uses `truncate_tag_value` before storing tag values that might be too long.

*Call graph*: calls 2 internal fn (check_values, truncate_tag_value); called by 2 (doctor_feedback_report, doctor_report_tags_summarize_status_counts); 3 external calls (new, get, new).


##### `check_values`  (lines 155–161)

```
fn check_values(checks: &Value) -> Box<dyn Iterator<Item = &Value> + '_>
```

**Purpose**: This helper lets the tag-building code read doctor checks from both old and new JSON layouts. It hides the difference between a list of checks and an object keyed by check name.

**Data flow**: It receives the `checks` part of the JSON report. If that value is an array, it returns an iterator over the array items; if it is an object, it returns an iterator over the object’s values; otherwise, it returns an empty iterator. Nothing is changed in the original JSON.

**Call relations**: Only `doctor_report_tags` calls this helper. That lets the main tag-building function stay focused on counting statuses instead of caring which report format produced the checks.

*Call graph*: called by 1 (doctor_report_tags); 2 external calls (new, empty).


##### `truncate_tag_value`  (lines 163–172)

```
fn truncate_tag_value(value: &str) -> String
```

**Purpose**: This helper makes sure a tag value is not too long. Long values are shortened and marked with `...` so error-tracking tags stay within the expected size.

**Data flow**: It receives a text value. If the value is already short enough, it returns it unchanged as a new string. If it is too long, it keeps the allowed prefix, adds an ellipsis, and returns that shortened string.

**Call relations**: It is called by `doctor_report_tags` when storing the overall status and the comma-separated lists of failed or warning check IDs. This keeps the tags safe and predictable before they are returned to the feedback upload path.

*Call graph*: called by 1 (doctor_report_tags); 1 external calls (format!).


##### `tests::doctor_report_tags_summarize_status_counts`  (lines 181–211)

```
fn doctor_report_tags_summarize_status_counts()
```

**Purpose**: This test checks that doctor-report JSON is summarized into the expected tags. It protects the counting and check-ID extraction behavior from accidental changes.

**Data flow**: It builds a sample JSON report with one passing check, one warning check, and one failing check. It sends that report into `doctor_report_tags`, then compares the returned map against the exact tag set that should come out.

**Call relations**: The test calls `doctor_report_tags` directly, without running the external doctor command. This keeps the test focused on the summary logic rather than process launching, timeouts, or JSON output from the real CLI.

*Call graph*: calls 1 internal fn (doctor_report_tags); 3 external calls (from, assert_eq!, json!).


### Safe debug extraction
These utilities sanitize sensitive values and extract response metadata so later debug artifacts and telemetry remain useful without leaking secrets.

### `response-debug-context/src/lib.rs`

`util` · `cross-cutting error reporting`

When a request to the API fails, the raw error can contain two very different kinds of information: helpful tracking details, and private or unsafe details. This file separates those. It looks at HTTP response headers, which are small name-value labels returned with a response, and extracts identifiers such as a request ID, Cloudflare ray ID, and authorization error code. These are useful when asking support or checking logs, much like writing down a receipt number after a failed purchase.

The main type, ResponseDebugContext, is a small bundle of optional fields. The extraction code only fills fields when the error is an HTTP transport error and the expected headers are present. It also understands one special header, x-error-json, which contains base64-encoded JSON. Base64 is a text-safe wrapping format; JSON is a common structured text format. The code decodes that header and reads an error.code value if it exists.

The other half of the file creates short telemetry strings for errors. For HTTP failures, it records only the status code, such as "http 401", and deliberately leaves out the response body. This matters because a body might contain secrets, tokens, or user data. Tests in the file lock in both behaviors: useful debug details are kept, and sensitive body text is not reported.

#### Function details

##### `extract_response_debug_context`  (lines 19–54)

```
fn extract_response_debug_context(transport: &TransportError) -> ResponseDebugContext
```

**Purpose**: This function reads an HTTP transport error and gathers safe debugging clues from its headers. Someone would use it after a failed network request to capture IDs and authorization hints without keeping the whole response.

**Data flow**: It receives a TransportError. If that error is not an HTTP response, it returns an empty ResponseDebugContext. If it is an HTTP response, it reads the headers, copies request ID and Cloudflare ray values when present, copies the authorization error header when present, and tries to decode the x-error-json header to find an error code. The result is a ResponseDebugContext with only the fields it could safely find.

**Call relations**: This is the core extractor. extract_response_debug_context_from_api_error calls it when a broader ApiError turns out to contain a transport error. The test tests::extract_response_debug_context_decodes_identity_headers also calls it to prove that the expected headers are turned into the expected debug context.

*Call graph*: called by 2 (extract_response_debug_context_from_api_error, extract_response_debug_context_decodes_identity_headers); 1 external calls (default).


##### `extract_response_debug_context_from_api_error`  (lines 56–61)

```
fn extract_response_debug_context_from_api_error(error: &ApiError) -> ResponseDebugContext
```

**Purpose**: This function is a convenience wrapper for callers that have an ApiError instead of a lower-level TransportError. It gives them the same debug context when the API error came from transport, and an empty context otherwise.

**Data flow**: It receives an ApiError. If the error is the Transport variant, it passes the contained TransportError into extract_response_debug_context and returns that result. For every other kind of API error, it returns a default, empty ResponseDebugContext.

**Call relations**: This function sits one level above extract_response_debug_context. It decides whether the broader API error has the right kind of inner error to inspect, then hands that inner error to the lower-level extractor.

*Call graph*: calls 1 internal fn (extract_response_debug_context); 1 external calls (default).


##### `telemetry_transport_error_message`  (lines 63–71)

```
fn telemetry_transport_error_message(error: &TransportError) -> String
```

**Purpose**: This function turns a low-level transport error into a short message suitable for telemetry, which is operational reporting. It is careful not to include HTTP response bodies, because those bodies may contain private data.

**Data flow**: It receives a TransportError. For HTTP errors, it keeps only the numeric status code and formats it as text like "http 401". For retry limits and timeouts, it returns fixed plain-language messages. For network and request-building errors, it returns the existing error text. The output is a single String.

**Call relations**: This is the transport-specific formatter. telemetry_api_error_message calls it whenever an ApiError contains a TransportError, so the same privacy rule is used whether code starts from the low-level or high-level error type.

*Call graph*: called by 1 (telemetry_api_error_message); 1 external calls (format!).


##### `telemetry_api_error_message`  (lines 73–87)

```
fn telemetry_api_error_message(error: &ApiError) -> String
```

**Purpose**: This function turns a higher-level API error into a short telemetry message. It gives operators enough information to classify the failure without copying full server responses or sensitive details.

**Data flow**: It receives an ApiError. If the error wraps a TransportError, it sends that inner error to telemetry_transport_error_message. For API status errors, it keeps the status code. For known categories such as quota exceeded, rate limit, invalid request, or server overloaded, it returns a fixed label. For stream errors, it returns the stream error text. The output is a concise String.

**Call relations**: This is the broader error formatter used when code is working with ApiError values. It delegates transport-specific cases to telemetry_transport_error_message and formats the other API-level cases itself.

*Call graph*: calls 1 internal fn (telemetry_transport_error_message); 1 external calls (format!).


##### `tests::extract_response_debug_context_decodes_identity_headers`  (lines 103–132)

```
fn extract_response_debug_context_decodes_identity_headers()
```

**Purpose**: This test proves that the extractor can read the important identity and authorization headers from an HTTP error. It also checks that the base64-wrapped JSON error code is decoded correctly.

**Data flow**: The test builds a fake set of HTTP headers containing a request ID, Cloudflare ray ID, authorization error, and encoded JSON error code. It wraps those headers in a simulated unauthorized HTTP transport error, sends that error into extract_response_debug_context, and compares the returned ResponseDebugContext with the exact expected values.

**Call relations**: The test harness runs this function during testing. Inside the test, it calls extract_response_debug_context and uses assertions to make sure the core extraction behavior does not accidentally change.

*Call graph*: calls 1 internal fn (extract_response_debug_context); 3 external calls (new, from_static, assert_eq!).


##### `tests::telemetry_error_messages_omit_http_bodies`  (lines 135–148)

```
fn telemetry_error_messages_omit_http_bodies()
```

**Purpose**: This test protects the privacy rule for telemetry: HTTP response bodies must not appear in telemetry messages. It uses a fake body containing secret-looking text to make the risk obvious.

**Data flow**: The test creates an HTTP transport error with status 401 and a response body that says a secret token leaked. It checks that the transport-level telemetry message is only "http 401", and that the API-level wrapper produces the same safe message. The dangerous body text does not come out.

**Call relations**: The test harness runs this during testing. Its assertions guard the formatting behavior so future changes do not accidentally include HTTP bodies in telemetry output.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::telemetry_error_messages_preserve_non_http_details`  (lines 151–165)

```
fn telemetry_error_messages_preserve_non_http_details()
```

**Purpose**: This test checks the other side of the telemetry rule: non-HTTP error details, such as network or stream failure text, are still kept. These messages are usually the useful error itself, not a server response body.

**Data flow**: The test creates sample network, build, and stream errors with simple text messages. It then checks that the telemetry helpers return those same messages. The before-and-after story is that ordinary local error text stays visible for debugging.

**Call relations**: The test harness runs this during testing. It constructs representative Network, Build, and Stream errors and uses assertions to make sure the telemetry helpers still preserve useful non-HTTP details.

*Call graph*: 4 external calls (assert_eq!, Stream, Build, Network).


### `secrets/src/sanitizer.rs`

`util` · `cross-cutting`

This file is a simple secret scrubber. Its job is to look through a piece of text and replace things that look like private credentials with a safe placeholder. Without it, logs, error messages, or other copied text could accidentally include real keys that let someone access paid services or private systems.

It uses regular expressions, which are search patterns for text, to recognize several common secret shapes: OpenAI-style keys, AWS access key IDs, bearer tokens used in web authentication, and assignments such as `api_key = ...` or `password: ...`. The patterns are stored in `LazyLock` values, meaning each pattern is compiled only when it is first needed and then reused. That is like keeping a stencil after making it once, instead of cutting a new stencil every time.

The main function, `redact_secrets`, runs the input text through these patterns one after another. When it finds a match, it replaces the sensitive part with `[REDACTED_SECRET]`, while preserving useful surrounding words like `Bearer` or `password =`. This is intentionally “best effort”: it catches common formats, but it cannot prove that every possible secret has been removed. A small test exists to make sure the patterns are valid and can be loaded without crashing.

#### Function details

##### `redact_secrets`  (lines 15–22)

```
fn redact_secrets(input: String) -> String
```

**Purpose**: This function takes a string and returns a safer version with likely secrets hidden. It is meant for any place that needs to display or record text without exposing credentials.

**Data flow**: It receives the original text as input. It checks that text against several known secret patterns in order, replacing matches with `[REDACTED_SECRET]` or, for bearer tokens, `Bearer [REDACTED_SECRET]`. It returns a new string containing the redacted text and does not change anything outside the function.

**Call relations**: In normal use, other parts of the system would call this before printing, logging, or otherwise sharing text that may contain secrets. In this file’s test flow, `tests::load_regex` calls it once with a simple string to force the regular expression patterns to load and prove they are valid.

*Call graph*: called by 1 (load_regex).


##### `compile_regex`  (lines 24–30)

```
fn compile_regex(pattern: &str) -> Regex
```

**Purpose**: This helper turns a text search pattern into a compiled regular expression that can be reused efficiently. If a pattern is written incorrectly, it stops the program immediately with a clear error, because that would be a programmer mistake.

**Data flow**: It receives a pattern string. It asks the regex library to compile that pattern. If compilation works, it returns the compiled matcher; if compilation fails, it panics with an error message explaining which pattern was invalid.

**Call relations**: The file’s lazily initialized secret patterns call this helper when they are first used. It hands back ready-to-use regular expressions to `redact_secrets`, which then uses them to find and replace likely credentials.

*Call graph*: 2 external calls (new, panic!).


##### `tests::load_regex`  (lines 37–40)

```
fn load_regex()
```

**Purpose**: This test checks that all secret-matching patterns can be compiled successfully. It is not testing a particular redaction result; it is guarding against broken pattern syntax being committed.

**Data flow**: It starts with the harmless string `secret`, passes it into `redact_secrets`, and ignores the returned text. The important effect is that calling `redact_secrets` forces the lazy regular expressions to compile, so any invalid pattern would cause the test to fail.

**Call relations**: During the test run, this function calls `redact_secrets` specifically to exercise the pattern-loading path. That in turn causes the lazy regex setup to use `compile_regex`, catching mistakes early before the sanitizer is used in real output paths.

*Call graph*: calls 1 internal fn (redact_secrets).


### Request and payload dumps
These components persist ad hoc debug captures for proxied traffic and analytics payloads into local files for later inspection.

### `responses-api-proxy/src/dump.rs`

`io_transport` · `request handling and debug dumping`

This file is like a flight recorder for the proxy. When the proxy sends a request onward and receives a response back, this code can write both sides of that exchange into a dump directory. Without it, a developer trying to understand what the proxy actually sent or received would have to rely on logs or reproduce the problem by hand.

The main piece is `ExchangeDumper`. It creates the dump folder, gives each exchange a unique numbered filename, and writes the request file immediately. It stores the method, URL, headers, and body. If the body is valid JSON, it keeps it as JSON; otherwise it saves it as readable text as best it can.

The response is saved later through `ExchangeDump` and `ResponseBodyDump`. `ResponseBodyDump` wraps the real response body reader. As callers read the response normally, this wrapper copies the bytes into memory too, like putting carbon paper under a form. When the stream reaches the end, or if the wrapper is dropped before that, it writes the response dump file.

A very important safety detail is header redaction. Any `authorization` header or anything with `cookie` in its name is replaced with `[REDACTED]`, so debug dumps do not casually leak credentials.

#### Function details

##### `ExchangeDumper::new`  (lines 25–32)

```
fn new(dump_dir: PathBuf) -> io::Result<Self>
```

**Purpose**: Creates a new dumper tied to a folder on disk. It also makes sure that folder exists before any request or response files are written there.

**Data flow**: It receives a folder path. It creates that folder and any missing parent folders, then returns an `ExchangeDumper` that remembers the folder and starts numbering exchanges from 1. If the folder cannot be created, it returns an input/output error instead.

**Call relations**: The test cases call this first to set up dumping. In normal use, other proxy code would do the same before calling `ExchangeDumper::dump_request` for each exchange.

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

**Purpose**: Writes the request side of an HTTP exchange to a JSON file and prepares a matching response dump file path. Someone uses this when a request is about to be forwarded and they want a durable record of what was sent.

**Data flow**: It receives the HTTP method, URL, request headers, and raw body bytes. It picks the next sequence number, adds the current time, builds request and response filenames, converts the request into a safe JSON-friendly shape, redacts sensitive headers, and writes the request file. It returns an `ExchangeDump` containing the future response file path.

**Call relations**: This is the first half of the dump flow. It calls `dump_body` to make the body readable and `write_json_dump` to write the file. The returned `ExchangeDump` is then used to wrap and record the response through `ExchangeDump::tee_response_body`.

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

**Purpose**: Wraps a response body so it can be read normally while also being copied for the response dump. This lets the proxy keep streaming the response without needing a separate second read.

**Data flow**: It takes the response status code, response headers, and the original response body reader. It turns the headers into dump-safe header records, stores an empty buffer for body bytes, and returns a `ResponseBodyDump` wrapper around the original reader.

**Call relations**: This starts the second half of the exchange dump. It is used after `ExchangeDumper::dump_request` has returned an `ExchangeDump`, and it hands control to `ResponseBodyDump::read`, which copies bytes as the response is consumed.

*Call graph*: 2 external calls (iter, new).


##### `ResponseBodyDump::write_dump_if_needed`  (lines 95–114)

```
fn write_dump_if_needed(&mut self)
```

**Purpose**: Writes the response JSON file once, and only once. It exists so the response is saved whether the stream is fully read or the wrapper is dropped early.

**Data flow**: It checks whether the dump has already been written. If not, it marks it as written, builds a response record from the status, headers, and bytes collected so far, converts the body into JSON or text with `dump_body`, and writes the file with `write_json_dump`. If writing fails, it prints an error message instead of interrupting the response flow.

**Call relations**: `ResponseBodyDump::read` calls this when it reaches the end of the response stream. `ResponseBodyDump::drop` also calls it as a safety net when the wrapper goes away.

*Call graph*: calls 2 internal fn (dump_body, write_json_dump); called by 2 (drop, read); 2 external calls (eprintln!, take).


##### `ResponseBodyDump::read`  (lines 118–127)

```
fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>
```

**Purpose**: Reads bytes from the real response body while secretly saving a copy for the dump file. It makes the wrapper behave like a normal reader to the rest of the proxy.

**Data flow**: It receives a caller-provided buffer. It asks the wrapped response body to fill that buffer. If bytes were read, it appends those bytes to its internal copy and returns the byte count. If zero bytes were read, meaning the stream ended, it writes the response dump if needed and returns zero.

**Call relations**: Callers read from `ResponseBodyDump` just as they would read from the original response stream. When reading reaches the end, this function hands off to `ResponseBodyDump::write_dump_if_needed` to persist the collected response.

*Call graph*: calls 1 internal fn (write_dump_if_needed); 1 external calls (read).


##### `ResponseBodyDump::drop`  (lines 131–133)

```
fn drop(&mut self)
```

**Purpose**: Acts as a cleanup safety net that writes the response dump when the wrapper is destroyed. This prevents losing the response record if the caller stops reading before the stream naturally ends.

**Data flow**: It receives the existing `ResponseBodyDump` as it is being cleaned up. It does not return anything. It simply asks `write_dump_if_needed` to save whatever response bytes have been collected so far.

**Call relations**: Rust calls this automatically when the wrapper goes out of scope. It uses the same write path as `ResponseBodyDump::read`, so the response file is produced either at end-of-stream or during cleanup.

*Call graph*: calls 1 internal fn (write_dump_if_needed).


##### `HeaderDump::from`  (lines 171–183)

```
fn from(header: (&reqwest::header::HeaderName, &reqwest::header::HeaderValue)) -> Self
```

**Purpose**: Converts a response header into the simple name-and-value form used in dump files, while hiding secrets. This keeps dumps useful without exposing tokens or cookies.

**Data flow**: It receives a header name and value from the response library. It checks the name with `should_redact_header`. If the header is sensitive, it stores `[REDACTED]`; otherwise it converts the raw header bytes into a readable string. It returns a `HeaderDump` with the safe name and value.

**Call relations**: This conversion is used when response headers are collected for `ExchangeDump::tee_response_body`. It relies on `should_redact_header` to decide which values must not be written plainly.

*Call graph*: calls 1 internal fn (should_redact_header); 1 external calls (from_utf8_lossy).


##### `should_redact_header`  (lines 186–189)

```
fn should_redact_header(name: &str) -> bool
```

**Purpose**: Decides whether a header value is too sensitive to write into a dump file. It currently treats authorization headers and cookie-related headers as secret.

**Data flow**: It receives a header name as text. It compares it case-insensitively with `authorization` and also checks whether the lowercase name contains `cookie`. It returns `true` when the value should be replaced with `[REDACTED]`, otherwise `false`.

**Call relations**: `HeaderDump::from` calls this before storing header values. That makes this function the central rule for keeping credentials out of request and response dumps.

*Call graph*: called by 1 (from).


##### `dump_body`  (lines 191–194)

```
fn dump_body(body: &[u8]) -> Value
```

**Purpose**: Turns raw body bytes into something that can be placed in a JSON dump. It preserves real JSON bodies as structured JSON and falls back to readable text for other bodies.

**Data flow**: It receives a byte slice. It first tries to parse those bytes as JSON. If parsing works, it returns that JSON value. If parsing fails, it converts the bytes into a string, replacing invalid text as needed, and returns that string as a JSON value.

**Call relations**: `ExchangeDumper::dump_request` uses this for request bodies, and `ResponseBodyDump::write_dump_if_needed` uses it for response bodies. This keeps both dump files consistent and readable.

*Call graph*: called by 2 (dump_request, write_dump_if_needed); 1 external calls (from_slice).


##### `write_json_dump`  (lines 196–201)

```
fn write_json_dump(path: &PathBuf, dump: &impl Serialize) -> io::Result<()>
```

**Purpose**: Writes a dump record to disk as pretty-printed JSON. It is the shared file-writing step for both request and response dumps.

**Data flow**: It receives a file path and any serializable dump object. It converts the object into nicely formatted JSON bytes, adds a final newline, and writes those bytes to the given path. It returns success or an input/output error.

**Call relations**: `ExchangeDumper::dump_request` calls this to save the request file. `ResponseBodyDump::write_dump_if_needed` calls it to save the response file.

*Call graph*: called by 2 (dump_request, write_dump_if_needed); 2 external calls (write, to_vec_pretty).


##### `tests::dump_request_writes_redacted_headers_and_json_body`  (lines 225–300)

```
fn dump_request_writes_redacted_headers_and_json_body()
```

**Purpose**: Checks that request dumping writes the expected JSON and hides sensitive request headers. It protects against accidentally leaking authorization or cookie values in debug files.

**Data flow**: It creates a temporary dump folder, builds a dumper, prepares a POST request with several headers and a JSON body, and asks the dumper to write it. It then reads the produced request file and compares it with the expected JSON, including redacted secrets and preserved non-secret headers. Finally, it removes the temporary folder.

**Call relations**: This test exercises `ExchangeDumper::new` and the request side of the dump flow. It also uses helper functions to create a test directory and find the generated request dump file.

*Call graph*: calls 1 internal fn (new); 7 external calls (assert!, assert_eq!, read_to_string, remove_dir_all, dump_file_with_suffix, test_dump_dir, vec!).


##### `tests::response_body_dump_streams_body_and_writes_response_file`  (lines 303–355)

```
fn response_body_dump_streams_body_and_writes_response_file()
```

**Purpose**: Checks that response dumping does not interfere with reading the response body and still writes a safe response dump. It proves the wrapper behaves like a normal stream while recording a copy.

**Data flow**: It creates a temporary dumper, writes a matching request dump, builds response headers with both safe and sensitive values, and wraps a small response body. It reads the wrapped body into a string, then reads the response dump file and compares it with the expected status, headers, and body. Sensitive response headers must be redacted.

**Call relations**: This test covers the full response path that starts after `ExchangeDumper::dump_request`. It uses `ExchangeDump::tee_response_body`, then reading the wrapper triggers `ResponseBodyDump::read` and the response dump write.

*Call graph*: calls 2 internal fn (new, new); 8 external calls (new, from_static, new, assert_eq!, read_to_string, remove_dir_all, dump_file_with_suffix, test_dump_dir).


##### `tests::test_dump_dir`  (lines 357–365)

```
fn test_dump_dir() -> std::path::PathBuf
```

**Purpose**: Creates a unique temporary folder for one test run. This keeps tests from overwriting each other’s dump files.

**Data flow**: It increments a shared test counter, combines that counter with the current process ID, and builds a folder path under the system temporary directory. It creates the folder and returns the path.

**Call relations**: The dump-related tests call this before creating an `ExchangeDumper`. It gives each test an isolated place to write files.

*Call graph*: 3 external calls (format!, create_dir_all, temp_dir).


##### `tests::dump_file_with_suffix`  (lines 367–377)

```
fn dump_file_with_suffix(dump_dir: &std::path::Path, suffix: &str) -> std::path::PathBuf
```

**Purpose**: Finds the one dump file in a test folder that ends with a requested suffix, such as `-request.json` or `-response.json`. It makes the tests independent of the timestamped filename prefix.

**Data flow**: It receives a dump directory and a filename suffix. It reads all files in the directory, keeps only paths whose names end with that suffix, sorts them, checks that there is exactly one match, and returns that path.

**Call relations**: The tests use this after dumping an exchange so they can read the generated file without knowing its sequence number or timestamp.

*Call graph*: 2 external calls (assert_eq!, read_dir).


### `analytics/src/analytics_capture.rs`

`io_transport` · `analytics capture setup and event writing`

This file is a small recording tool for analytics events. When a capture file is configured through the `CODEX_ANALYTICS_EVENTS_CAPTURE_FILE` environment variable, the analytics system can save every outgoing event request to disk. That is useful for debugging, testing, or auditing what the program would have reported.

The file works like a notebook where each analytics request is written on a new line. First, `initialize` checks that the notebook can be opened, creating it if it does not exist. Later, `append_payload` turns an event request into JSON, adds a newline, opens the same file in append mode, writes the line, and flushes it so the data is pushed out promptly.

The helper `open_capture_file` centralizes the file-opening rules. It always opens the file for appending and creates it if missing. On Unix systems, it also sets the file permissions to `0600`, meaning only the current user can read or write it. That matters because analytics payloads may contain details that should not be visible to other users on the same machine.

Without this file, the project would lose this simple local record of analytics traffic, making it harder to verify what was captured or diagnose analytics behavior.

#### Function details

##### `initialize`  (lines 11–13)

```
fn initialize(path: &Path) -> io::Result<()>
```

**Purpose**: This function makes sure the analytics capture file can be opened before events are written to it. It is a lightweight readiness check that also creates the file if it does not already exist.

**Data flow**: It receives a file path. It asks `open_capture_file` to open or create that path using the project’s capture-file rules, then immediately drops the opened file because it only needed to confirm access. It returns success if the file is usable, or an input/output error if the operating system refuses the operation.

**Call relations**: When higher-level setup code builds analytics settings from a base URL and capture-file option, it calls `initialize` to confirm the capture destination is valid. `initialize` delegates the real file-opening work to `open_capture_file` so setup and later writes use the same rules.

*Call graph*: calls 1 internal fn (open_capture_file); called by 1 (from_base_url_and_capture_file).


##### `append_payload`  (lines 15–23)

```
fn append_payload(path: &Path, payload: &TrackEventsRequest) -> io::Result<()>
```

**Purpose**: This function records one analytics request in the capture file. It writes the request as a single JSON line, which makes the file easy for both humans and tools to read one event batch at a time.

**Data flow**: It receives a file path and a `TrackEventsRequest`, which is the analytics payload to save. It converts the payload to JSON bytes, adds a newline byte, opens the capture file for appending, writes the bytes, and flushes the file so the write is pushed out. It returns success when the line is safely written, or an input/output style error if JSON conversion or file writing fails.

**Call relations**: When the analytics layer decides to capture a track-events request locally, it calls `append_payload`. This function uses JSON serialization to turn the request into stored text, then calls `open_capture_file` so every write uses the same create, append, and permission behavior.

*Call graph*: calls 1 internal fn (open_capture_file); called by 1 (capture_track_events_request); 1 external calls (to_vec).


##### `open_capture_file`  (lines 25–34)

```
fn open_capture_file(path: &Path) -> io::Result<File>
```

**Purpose**: This helper opens the capture file in the exact way analytics recording needs: create it if missing, add new data to the end, and keep it private on Unix-like systems.

**Data flow**: It receives a file path. It builds file-opening options, sets them to create the file and append to it, and on Unix sets permissions so only the owner can access it. It then asks the operating system to open the file and returns the opened file object or an error.

**Call relations**: Both setup and event-writing paths rely on this helper. `initialize` uses it to test that the file is available, while `append_payload` uses it just before writing each captured payload. Keeping this in one place prevents the setup path and write path from accidentally using different file rules.

*Call graph*: called by 2 (append_payload, initialize); 1 external calls (new).


### Persistent log capture
These files provide the local logging backends, from TUI session JSONL capture through tracing-to-database ingestion and durable runtime log storage.

### `tui/src/session_log.rs`

`io_transport` · `startup, request handling, shutdown`

This file is like a black box recorder for the terminal user interface. Most of the time it does nothing. If the user sets CODEX_TUI_RECORD_SESSION to a true-like value, it opens a log file and writes one JSON object per line. JSON is a common text format for structured data, and the “one object per line” style makes the file easy to scan, process, or replay later.

The logger first decides where to write the file. A user can provide CODEX_TUI_SESSION_LOG_PATH, or the code creates a timestamped file inside the configured log directory. On Unix systems it creates the file with private permissions, so only the owner can read and write it. That matters because session logs may contain paths, model names, user actions, or other context.

After opening the file, it writes a session_start record with basic context such as the working directory and model provider. During the run, inbound AppEvent values are summarized as records going “to_tui”, while outbound AppCommand values are written as records going “from_tui”. At shutdown it writes session_end.

The actual file handle is stored globally behind a mutex, which is a lock that stops two parts of the program writing to the file at the same time. If logging was not enabled or opening failed, all later logging calls quietly return.

#### Function details

##### `SessionLogger::new`  (lines 23–27)

```
fn new() -> Self
```

**Purpose**: Creates an empty session logger that does not yet point at a file. This is the starting state used by the global logger before session recording is enabled.

**Data flow**: Nothing is passed in. The function builds a SessionLogger whose file slot is empty. The result is a logger that can later be opened exactly once with a real file.

**Call relations**: This is used when the global LOGGER is first created. Later, startup code can ask that logger to open a file, and all logging functions share that same logger.

*Call graph*: 1 external calls (new).


##### `SessionLogger::open`  (lines 29–46)

```
fn open(&self, path: PathBuf) -> std::io::Result<()>
```

**Purpose**: Opens the session log file and prepares it for writing. It also creates any missing parent folders so recording does not fail just because the log directory does not exist.

**Data flow**: It receives a file path. It sets up file-opening options to create or replace the file, makes the parent directory if needed, applies private file permissions on Unix, then opens the file and stores it behind a lock. It returns success or an input/output error if the file cannot be prepared.

**Call relations**: maybe_init calls this during startup after recording has been enabled and a path has been chosen. Once this succeeds, later logging calls can find the file through the shared LOGGER and append JSON lines to it.

*Call graph*: 4 external calls (get_or_init, new, parent, create_dir_all).


##### `SessionLogger::write_json_line`  (lines 48–72)

```
fn write_json_line(&self, value: serde_json::Value)
```

**Purpose**: Writes one JSON record to the session log as a single line. This is the common final step for all session records, whether they describe startup, an incoming event, an outgoing command, or shutdown.

**Data flow**: It receives a JSON value. If no file has been opened, it returns without doing anything. If a file exists, it locks the file, turns the JSON value into text, writes that text, writes a newline, and flushes the file so the record is actually pushed out. If serialization or writing fails, it logs a warning instead of crashing the app.

**Call relations**: maybe_init, log_inbound_app_event, log_session_end, and write_record all hand their prepared JSON records to this function. It is the narrow doorway where structured session information becomes bytes in the log file.

*Call graph*: 3 external calls (get, to_string, warn!).


##### `SessionLogger::is_enabled`  (lines 74–76)

```
fn is_enabled(&self) -> bool
```

**Purpose**: Checks whether session recording is active. Callers use it to avoid doing extra work when no log file was opened.

**Data flow**: It reads the logger’s file slot. If a file has been stored there, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: The public logging functions call this before building records. That keeps normal runs cheap, because when recording is off they return immediately.

*Call graph*: 1 external calls (get).


##### `now_ts`  (lines 79–82)

```
fn now_ts() -> String
```

**Purpose**: Creates a readable timestamp for each log entry. The timestamp uses RFC3339 format, a standard date-and-time format that tools can parse easily.

**Data flow**: It reads the current UTC time from the system clock. It formats that time with millisecond precision and returns it as a string.

**Call relations**: Every record-building function uses this timestamp helper so all session log lines share the same time format.

*Call graph*: 1 external calls (now).


##### `maybe_init`  (lines 84–120)

```
fn maybe_init(config: &Config)
```

**Purpose**: Turns session logging on at application startup if the right environment variable is set. It chooses the log file path, opens the file, and writes the first header record.

**Data flow**: It receives the application Config, which includes things like the log directory, current working directory, and model information. It reads environment variables to decide whether recording is enabled and where the file should go. If enabled and the file opens successfully, it writes a session_start JSON record containing useful context. If recording is off or opening fails, it leaves logging disabled.

**Call relations**: run_ratatui_app calls this early in the terminal app’s life. After it succeeds, later calls from event sending, command submission, and shutdown can all add records to the same session log.

*Call graph*: called by 1 (run_ratatui_app); 5 external calls (from, format!, json!, var, error!).


##### `log_inbound_app_event`  (lines 122–211)

```
fn log_inbound_app_event(event: &AppEvent)
```

**Purpose**: Records an event that is being delivered into the terminal interface. It captures the kind of event and, for some events, a small safe summary such as a query string or match count.

**Data flow**: It receives an AppEvent. If logging is off, it returns immediately. Otherwise it matches the event type, builds a JSON record marked as going “to_tui”, adds the timestamp and relevant summary fields, then writes that record to the log. For many less important or noisy events, it records only the variant name rather than the full contents.

**Call relations**: send calls this when events move into the TUI. This gives the session log one side of the conversation: what the rest of the app told the interface to show or react to.

*Call graph*: called by 1 (send); 1 external calls (json!).


##### `log_outbound_op`  (lines 213–218)

```
fn log_outbound_op(op: &AppCommand)
```

**Purpose**: Records a command sent out from the terminal interface. This shows what the user interface asked the rest of the application to do.

**Data flow**: It receives an AppCommand. If no log file is open, it returns. If logging is active, it passes the command to write_record with labels saying the direction is “from_tui” and the kind is “op”.

**Call relations**: submit_thread_op and submit_op call this when the TUI submits work outward. It delegates the actual JSON wrapping to write_record, so outbound command logging uses the same shape each time.

*Call graph*: calls 1 internal fn (write_record); called by 2 (submit_thread_op, submit_op).


##### `log_session_end`  (lines 220–230)

```
fn log_session_end()
```

**Purpose**: Writes the final record showing that the recorded session ended. This gives log readers a clear closing marker.

**Data flow**: It checks whether logging is active. If so, it builds a small JSON object with the current timestamp, a meta direction, and the kind session_end, then writes it as one line. It does not return any data.

**Call relations**: run_ratatui_app calls this near shutdown. Together with maybe_init’s session_start record, it brackets the useful part of the session log.

*Call graph*: called by 1 (run_ratatui_app); 1 external calls (json!).


##### `write_record`  (lines 232–243)

```
fn write_record(dir: &str, kind: &str, obj: &T)
```

**Purpose**: Wraps any serializable object in the standard session-log shape. It is used when the full payload should be included rather than only a hand-written summary.

**Data flow**: It receives a direction label, a kind label, and an object that can be converted to JSON. It builds a JSON record containing the current timestamp, those labels, and the object as the payload. It then sends that record to the logger for writing.

**Call relations**: log_outbound_op calls this to record AppCommand values. This helper keeps outbound records consistent and leaves the actual file writing to SessionLogger::write_json_line.

*Call graph*: called by 1 (log_outbound_op); 1 external calls (json!).


### `state/src/log_db.rs`

`io_transport` · `cross-cutting during runtime logging`

This file is the bridge between Rust tracing events and the project’s local log database. A tracing event is a structured log message: it can include a level, text, file location, and extra fields such as a thread id. Instead of writing each event directly to SQLite, which could slow the application, this file puts log entries into a bounded queue and lets a background task write them in batches. Think of it like dropping letters into an outgoing mail tray: the caller does not wait for every letter to be delivered, but a postal worker periodically takes a stack and sends them.

The main piece is `LogDbLayer`, a tracing subscriber layer. It watches spans, which are named sections of work, remembers useful span fields, and then combines that context with each event. It also creates a feedback-style log body that matches the normal text formatter closely enough that logs can later be queried by thread and shown in a familiar shape.

The queue is deliberately bounded. If ordinary log events arrive faster than the database writer can accept them, new log entries may be dropped rather than blocking the running program. Explicit flush requests are different: they wait until accepted queued entries have been written. The file also filters out very noisy low-level OpenTelemetry timer messages to avoid filling the database with unhelpful logs.

#### Function details

##### `LogSinkQueueConfig::default`  (lines 59–65)

```
fn default() -> Self
```

**Purpose**: Provides the standard queue settings for log database writing. These defaults decide how many log commands can wait, how many entries are written at once, and how often buffered logs are written even if the batch is not full.

**Data flow**: It takes no input. It returns a `LogSinkQueueConfig` filled with the file’s built-in capacity, batch size, and flush interval.

**Call relations**: When normal logging is started without custom settings, `LogDbLayer::start` asks this function for the default configuration before building the background writer.

*Call graph*: called by 1 (start).


##### `LogSinkQueueConfig::normalized`  (lines 69–79)

```
fn normalized(self) -> Self
```

**Purpose**: Makes a queue configuration safe to use. It prevents impossible settings such as a zero-capacity queue, a zero-size batch, or a zero-time flush interval.

**Data flow**: It receives a proposed `LogSinkQueueConfig`. It raises capacity and batch size to at least 1, replaces a zero flush interval with the default interval, and returns the corrected configuration.

**Call relations**: Custom startup goes through this function inside `LogDbLayer::start_with_config`, so the rest of the logging code can assume the configuration is usable.

*Call graph*: called by 1 (start_with_config); 1 external calls (is_zero).


##### `start`  (lines 99–101)

```
fn start(state_db: std::sync::Arc<StateRuntime>) -> LogDbLayer
```

**Purpose**: Starts log capture for a given state database using the standard settings. It is a small convenience wrapper for callers that do not need custom queue behavior.

**Data flow**: It receives the shared `StateRuntime`, which knows how to write to the state databases. It passes that runtime into `LogDbLayer::start` and returns the resulting logging layer.

**Call relations**: Application setup and several tests call this top-level helper when they want a ready-to-use tracing layer backed by SQLite.

*Call graph*: calls 1 internal fn (start); called by 3 (tool_call_logs_include_thread_id, flush_persists_logs_for_query, sqlite_feedback_logs_match_feedback_formatter_shape).


##### `LogDbLayer::clone`  (lines 104–109)

```
fn clone(&self) -> Self
```

**Purpose**: Creates another handle to the same logging layer. This lets the layer be installed in tracing while another copy is kept for actions such as flushing.

**Data flow**: It reads the existing sender and process id string, clones them, and returns a new `LogDbLayer` that talks to the same background queue.

**Call relations**: Tracing setup code can clone the layer before installing it, so later code still has a handle that can request a flush.

*Call graph*: 1 external calls (clone).


##### `LogDbLayer::start`  (lines 113–115)

```
fn start(state_db: std::sync::Arc<StateRuntime>) -> Self
```

**Purpose**: Builds a `LogDbLayer` with the standard queue settings. This is the normal constructor for database-backed logging.

**Data flow**: It receives the shared state runtime, fetches the default queue configuration, and passes both into `LogDbLayer::start_with_config`. The result is a layer ready to receive tracing events.

**Call relations**: The public `start` helper delegates here, keeping the simple startup path short while the configurable startup path holds the real setup work.

*Call graph*: calls 1 internal fn (default); called by 1 (start); 1 external calls (start_with_config).


##### `LogDbLayer::start_with_config`  (lines 117–128)

```
fn start_with_config(
        state_db: std::sync::Arc<StateRuntime>,
        config: LogSinkQueueConfig,
    ) -> Self
```

**Purpose**: Builds a `LogDbLayer` with caller-provided queue and flushing settings. Tests and specialized callers use this to force small batches or short flush intervals.

**Data flow**: It receives the shared state runtime and a queue configuration. It normalizes the configuration, creates a bounded message channel, starts the background inserter task, assigns a stable id for this process, and returns the layer that sends work into that channel.

**Call relations**: This is the main setup point. Constructors feed into it, and it hands the receiving side of the queue to `run_inserter`, which performs the actual database writes.

*Call graph*: calls 3 internal fn (normalized, current_process_log_uuid, run_inserter); called by 2 (configured_batch_size_flushes_without_explicit_flush, configured_flush_interval_persists_buffered_logs); 2 external calls (channel, spawn).


##### `LogDbLayer::try_send`  (lines 137–139)

```
fn try_send(&self, entry: LogEntry)
```

**Purpose**: Attempts to put one finished log entry onto the background queue without waiting. It protects the application from being slowed down by a full log queue.

**Data flow**: It receives a `LogEntry`. It wraps it as an `Entry` command and tries to send it immediately; if the queue is full or closed, the entry is silently discarded.

**Call relations**: `LogDbLayer::on_event` calls this after converting a tracing event into a database row. This is why ordinary logging stays non-blocking.

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

**Purpose**: Records useful context when a new tracing span starts. A span is a named block of work, and this function saves its name, formatted fields, and any `thread_id` field for later log events.

**Data flow**: It receives span attributes, the span id, and tracing context. It scans the attributes, formats them as text, and stores a `SpanLogContext` inside the span if the span can be found.

**Call relations**: Tracing calls this automatically when code enters a new span. Later, `on_event` uses the stored span context indirectly through helper functions to build richer log rows.

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

**Purpose**: Updates saved span context when fields are added to an existing span. This keeps later log events from using stale span information.

**Data flow**: It receives the span id, newly recorded field values, and tracing context. It extracts any new `thread_id`, appends new formatted fields to the saved span text, or creates span context if none was saved yet.

**Call relations**: Tracing calls this when span fields change. It works with `append_fields` and `format_fields` so later event formatting sees the latest span data.

*Call graph*: calls 2 internal fn (append_fields, format_fields); 3 external calls (span, record, default).


##### `LogDbLayer::on_event`  (lines 190–229)

```
fn on_event(&self, event: &Event<'_>, ctx: tracing_subscriber::layer::Context<'_, S>)
```

**Purpose**: Converts a live tracing event into a `LogEntry` for the database. It gathers the message, level, target, source location, thread context, process id, and feedback-style body.

**Data flow**: It receives a tracing event and context. It skips noisy low-level OpenTelemetry debug and trace events, extracts message and thread fields, looks at surrounding spans for thread and formatting context, adds the current timestamp, builds a `LogEntry`, and tries to queue it.

**Call relations**: Tracing calls this for each log event seen by the layer. After preparing the row, it hands the entry to `try_send`, which passes it toward the background inserter if there is queue space.

*Call graph*: calls 2 internal fn (try_send, format_feedback_log_body); 5 external calls (now, matches!, metadata, record, default).


##### `LogDbLayer::flush`  (lines 236–238)

```
fn flush(&self) -> impl Future<Output = ()> + Send + '_
```

**Purpose**: Waits until log entries already accepted before the flush request have been processed by the background writer. Callers use it in tests or before reading logs to make buffered data visible.

**Data flow**: It creates a one-time reply channel, sends a `Flush` command to the background queue, and waits for the reply. If the command cannot be sent because the queue is gone, it simply returns.

**Call relations**: Code that needs durable, queryable logs calls this on a cloned layer. The background inserter receives the flush command, writes the current buffer, and replies.

*Call graph*: 3 external calls (send, channel, Flush).


##### `SpanFieldVisitor::record_field`  (lines 259–263)

```
fn record_field(&mut self, field: &Field, value: String)
```

**Purpose**: Looks at one span field and remembers it if it is the first `thread_id` field seen. This gives events inside the span a thread identity even if the event itself does not include one.

**Data flow**: It receives a field description and the field value as text. If the field is named `thread_id` and no thread id has already been stored, it saves that value.

**Call relations**: All typed `SpanFieldVisitor` recording methods convert their values to text and call this shared helper, so thread-id extraction behaves the same for numbers, strings, booleans, errors, and debug values.

*Call graph*: called by 7 (record_bool, record_debug, record_error, record_f64, record_i64, record_str, record_u64); 1 external calls (name).


##### `SpanFieldVisitor::record_i64`  (lines 267–269)

```
fn record_i64(&mut self, field: &Field, value: i64)
```

**Purpose**: Accepts a signed integer span field and lets the visitor check whether it is a `thread_id`. This supports thread ids written as integer fields.

**Data flow**: It receives the field and an `i64` value, converts the number to text, and passes it to `record_field`. It changes the visitor only if the field name is `thread_id` and no thread id was already saved.

**Call relations**: Tracing calls this through the `Visit` interface while span fields are being scanned. It funnels the work into the common `record_field` path.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_u64`  (lines 271–273)

```
fn record_u64(&mut self, field: &Field, value: u64)
```

**Purpose**: Accepts an unsigned integer span field and checks whether it represents a `thread_id`.

**Data flow**: It receives the field and a `u64` value, turns the value into text, and gives it to `record_field`. The visitor may then store it as the span thread id.

**Call relations**: This is one of the typed entry points used by tracing field recording, all sharing the same thread-id detection logic.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_bool`  (lines 275–277)

```
fn record_bool(&mut self, field: &Field, value: bool)
```

**Purpose**: Accepts a boolean span field and checks whether it is named `thread_id`. This keeps extraction generic across field types.

**Data flow**: It receives the field and a true-or-false value, converts the value to text, and passes it to `record_field`. The stored thread id changes only if appropriate.

**Call relations**: Tracing can call this while recording span attributes. It delegates the real decision to `record_field`.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_f64`  (lines 279–281)

```
fn record_f64(&mut self, field: &Field, value: f64)
```

**Purpose**: Accepts a floating-point span field and checks whether it is the span’s `thread_id`.

**Data flow**: It receives the field and a decimal number, converts the number to text, and passes it to `record_field`. The visitor may save the value as a thread id.

**Call relations**: It is part of the visitor interface used during span recording and shares behavior with the other typed record methods.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_str`  (lines 283–285)

```
fn record_str(&mut self, field: &Field, value: &str)
```

**Purpose**: Accepts a string span field and checks whether it is the `thread_id`. This is likely the common case for thread ids.

**Data flow**: It receives the field and string value, copies the value into owned text, and passes it to `record_field`. If it is the first `thread_id`, the visitor stores it.

**Call relations**: Tracing calls this for string span fields. It feeds the common field-inspection helper used by `on_new_span` and `on_record`.

*Call graph*: calls 1 internal fn (record_field).


##### `SpanFieldVisitor::record_error`  (lines 287–289)

```
fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static))
```

**Purpose**: Accepts an error-valued span field and checks whether it is named `thread_id`. Although unusual, this keeps the visitor complete for all tracing field types.

**Data flow**: It receives the field and error value, converts the error to text, and passes it to `record_field`. The visitor may save that text as the thread id.

**Call relations**: Tracing calls this through the visitor interface when a span field is an error. The actual filtering remains centralized in `record_field`.

*Call graph*: calls 1 internal fn (record_field); 1 external calls (to_string).


##### `SpanFieldVisitor::record_debug`  (lines 291–293)

```
fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug)
```

**Purpose**: Accepts any span field recorded only in debug form and checks whether it is the `thread_id`. Debug form means the value is turned into developer-readable text.

**Data flow**: It receives the field and debug-printable value, formats the value as text, and sends it to `record_field`. The visitor stores it only if the field name matches and no thread id exists yet.

**Call relations**: This catches span fields whose exact type does not have a more specific visitor method, while still reusing the same thread-id extraction rule.

*Call graph*: calls 1 internal fn (record_field); 1 external calls (format!).


##### `event_thread_id`  (lines 296–315)

```
fn event_thread_id(
    event: &Event<'_>,
    ctx: &tracing_subscriber::layer::Context<'_, S>,
) -> Option<String>
```

**Purpose**: Finds the best thread id for an event by looking through the spans around it. This lets an event inherit a thread id from its surrounding work context.

**Data flow**: It receives an event and tracing context. It walks the event’s span stack from the outermost span inward, remembers any stored span thread id it finds, and returns the last matching thread id or nothing.

**Call relations**: `on_event` uses this when the event itself did not include a `thread_id`. The span data it reads was stored earlier by `on_new_span` or updated by `on_record`.

*Call graph*: 1 external calls (event_scope).


##### `format_feedback_log_body`  (lines 317–346)

```
fn format_feedback_log_body(
    event: &Event<'_>,
    ctx: &tracing_subscriber::layer::Context<'_, S>,
) -> String
```

**Purpose**: Builds the human-readable log body stored for feedback logs. It combines span names and fields with the event fields so database logs resemble the normal text output.

**Data flow**: It receives an event and tracing context. It walks surrounding spans, adds each span name and formatted fields, then appends the event’s formatted fields, and returns the final string.

**Call relations**: `on_event` calls this while creating each `LogEntry`. It uses `format_fields` for consistent field text and relies on span context saved earlier.

*Call graph*: calls 1 internal fn (format_fields); called by 1 (on_event); 2 external calls (event_scope, new).


##### `format_fields`  (lines 348–356)

```
fn format_fields(fields: R) -> String
```

**Purpose**: Turns structured tracing fields into the standard text form used by the tracing formatter. This avoids inventing a separate database-only log format.

**Data flow**: It receives any value that can record tracing fields. It asks the default tracing field formatter to write those fields into a string and returns that string.

**Call relations**: Span creation, span updates, and feedback body formatting all call this so stored database logs line up with regular formatted logs.

*Call graph*: called by 3 (on_new_span, on_record, format_feedback_log_body); 3 external calls (default, new, new).


##### `append_fields`  (lines 358–363)

```
fn append_fields(fields: &mut String, values: &Record<'_>)
```

**Purpose**: Adds newly recorded span fields to the existing formatted field string for that span. It preserves the formatter’s normal way of joining old and new fields.

**Data flow**: It receives a mutable field string and new recorded values. It temporarily takes the old string, asks the default formatter to add the new values, and puts the updated string back.

**Call relations**: `on_record` calls this when span fields are updated after the span was created, keeping the saved span context current for future events.

*Call graph*: called by 1 (on_record); 3 external calls (default, new, take).


##### `current_process_log_uuid`  (lines 365–372)

```
fn current_process_log_uuid() -> &'static str
```

**Purpose**: Creates and returns a stable identifier for this running process’s logs. The id includes the process id and a random UUID so log rows from different runs can be distinguished.

**Data flow**: On first use, it reads the operating-system process id, creates a random UUID, combines them into a string, and stores it. Later calls return the same stored string.

**Call relations**: `LogDbLayer::start_with_config` uses this once when building a layer, and every `LogEntry` produced by that layer carries the same process identifier.

*Call graph*: called by 1 (start_with_config); 1 external calls (new).


##### `run_inserter`  (lines 374–408)

```
async fn run_inserter(
    state_db: std::sync::Arc<StateRuntime>,
    mut receiver: mpsc::Receiver<LogDbCommand>,
    config: LogSinkQueueConfig,
)
```

**Purpose**: Runs the background task that writes queued log entries into SQLite in batches. It is the worker that turns queued log commands into database rows.

**Data flow**: It receives the shared state runtime, the receiving side of the command queue, and the queue configuration. It collects entries in memory, writes them when the batch fills, when the timer ticks, when a flush command arrives, or when the sender closes, and replies to flush requests after writing.

**Call relations**: `LogDbLayer::start_with_config` starts this task. `try_send` supplies entry commands, `LogDbLayer::flush` supplies flush commands, and this function hands actual database writes to the file-level `flush` helper.

*Call graph*: called by 1 (start_with_config); 3 external calls (with_capacity, select!, interval).


##### `flush`  (lines 410–416)

```
async fn flush(state_db: &StateRuntime, buffer: &mut Vec<LogEntry>)
```

**Purpose**: Writes the current in-memory batch of log entries to the state runtime’s log database. It is the final step before logs become queryable from SQLite.

**Data flow**: It receives the state runtime and a mutable buffer of `LogEntry` values. If the buffer is empty it does nothing; otherwise it removes all current entries from the buffer and asks the runtime to insert them.

**Call relations**: The background inserter calls this whenever it needs to persist buffered logs: full batches, timer ticks, explicit flush commands, and shutdown all go through this helper.

*Call graph*: 1 external calls (insert_logs).


##### `MessageVisitor::record_field`  (lines 425–432)

```
fn record_field(&mut self, field: &Field, value: String)
```

**Purpose**: Extracts the two event fields this layer especially cares about: `message` and `thread_id`. It keeps the first value seen for each.

**Data flow**: It receives a field and its value as text. If the field is `message`, it saves a copy as the event message; if the field is `thread_id`, it saves it as the event’s direct thread id.

**Call relations**: All typed `MessageVisitor` record methods call this helper after converting their value to text, so event extraction is consistent regardless of field type.

*Call graph*: called by 7 (record_bool, record_debug, record_error, record_f64, record_i64, record_str, record_u64); 1 external calls (name).


##### `MessageVisitor::record_i64`  (lines 436–438)

```
fn record_i64(&mut self, field: &Field, value: i64)
```

**Purpose**: Accepts a signed integer event field and checks whether it is the message or thread id. This supports structured logs where those fields are numeric.

**Data flow**: It receives the field and integer value, converts the value to text, and passes it to `record_field`. The visitor may then store it as the event message or thread id.

**Call relations**: Tracing calls this while recording an event into `MessageVisitor`; the shared helper performs the actual selection.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_u64`  (lines 440–442)

```
fn record_u64(&mut self, field: &Field, value: u64)
```

**Purpose**: Accepts an unsigned integer event field and checks whether it should become the stored message or thread id.

**Data flow**: It receives the field and number, converts the number to text, and passes it to `record_field`. The visitor updates only the relevant saved value.

**Call relations**: This is one typed entry point in the tracing visitor interface used by `on_event`.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_bool`  (lines 444–446)

```
fn record_bool(&mut self, field: &Field, value: bool)
```

**Purpose**: Accepts a boolean event field and checks whether it is named `message` or `thread_id`.

**Data flow**: It receives the field and boolean value, turns the value into text, and passes it to `record_field`. The visitor may save that text in its message or thread id slot.

**Call relations**: Tracing can call this during event recording, and it delegates to the common extraction rule.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_f64`  (lines 448–450)

```
fn record_f64(&mut self, field: &Field, value: f64)
```

**Purpose**: Accepts a floating-point event field and checks whether it is the message or thread id.

**Data flow**: It receives the field and decimal value, converts it to text, and passes it to `record_field`. The visitor stores the value only if the field name matches.

**Call relations**: It is part of the visitor implementation used by `on_event` to inspect structured log fields.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_str`  (lines 452–454)

```
fn record_str(&mut self, field: &Field, value: &str)
```

**Purpose**: Accepts a string event field and checks whether it is the log message or thread id. This is the common path for normal log messages.

**Data flow**: It receives the field and string value, copies the value into owned text, and sends it to `record_field`. The visitor may save it as `message` or `thread_id`.

**Call relations**: `on_event` records events into this visitor, and tracing calls this for string fields produced by ordinary log macros.

*Call graph*: calls 1 internal fn (record_field).


##### `MessageVisitor::record_error`  (lines 456–458)

```
fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static))
```

**Purpose**: Accepts an error event field and checks whether it should be stored as the message or thread id. This keeps event scanning complete for error values.

**Data flow**: It receives the field and error value, converts the error to text, and passes it to `record_field`. The visitor saves it only for the names it recognizes.

**Call relations**: Tracing calls this when an event contains an error field; the same central extraction helper decides what to keep.

*Call graph*: calls 1 internal fn (record_field); 1 external calls (to_string).


##### `MessageVisitor::record_debug`  (lines 460–462)

```
fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug)
```

**Purpose**: Accepts a debug-form event field and checks whether it is the message or thread id. Debug form is used when a value is recorded as developer-readable text.

**Data flow**: It receives the field and debug-printable value, formats the value into text, and passes it to `record_field`. The visitor may save that text as the event message or thread id.

**Call relations**: This catches event fields without a more specific visitor method while keeping `on_event`’s extraction behavior consistent.

*Call graph*: calls 1 internal fn (record_field); 1 external calls (format!).


##### `tests::temp_codex_home`  (lines 483–485)

```
fn temp_codex_home() -> std::path::PathBuf
```

**Purpose**: Creates a unique temporary directory path for a test run. This keeps test databases separate so one test’s logs do not affect another test.

**Data flow**: It reads the system temporary directory, appends a random UUID-based folder name, and returns the path. It does not create the directory itself.

**Call relations**: The database-related tests call this before initializing `StateRuntime`, then remove the directory at the end of the test.

*Call graph*: 2 external calls (format!, temp_dir).


##### `tests::wait_for_log_count`  (lines 487–504)

```
async fn wait_for_log_count(runtime: &StateRuntime, expected: usize) -> Vec<crate::LogRow>
```

**Purpose**: Polls the test database until it contains the expected number of log rows. This accounts for the fact that log insertion happens in a background task.

**Data flow**: It receives a state runtime and an expected count. It repeatedly queries logs until the count matches or a two-second deadline is reached, sleeping briefly between tries, and returns the rows when successful.

**Call relations**: Batch and interval tests use this helper after emitting logs, because those logs may not be visible immediately.

*Call graph*: 7 external calls (assert!, default, query_logs, from_millis, from_secs, now, sleep).


##### `tests::test_entry`  (lines 506–520)

```
fn test_entry(message: &str) -> LogEntry
```

**Purpose**: Builds a simple `LogEntry` with predictable values for queue behavior tests. It avoids repeating boilerplate row data in those tests.

**Data flow**: It receives a message string. It returns a `LogEntry` whose message and feedback body use that string and whose other fields are fixed test values.

**Call relations**: Queue-focused tests call this to create entries for `LogDbLayer::try_send` without needing a full tracing subscriber or database runtime.


##### `tests::SharedWriter::snapshot`  (lines 528–531)

```
fn snapshot(&self) -> String
```

**Purpose**: Reads all bytes written to the shared test writer as a UTF-8 string. Tests use it to compare normal formatted logs with logs saved in SQLite.

**Data flow**: It locks the shared byte buffer, clones the bytes, converts them to text, and returns the resulting string.

**Call relations**: The feedback-format test writes normal tracing output into `SharedWriter`, then calls this method to compare that output with database feedback logs.

*Call graph*: 1 external calls (from_utf8).


##### `tests::SharedWriter::make_writer`  (lines 541–545)

```
fn make_writer(&'a self) -> Self::Writer
```

**Purpose**: Creates a write guard for the shared in-memory test writer. This lets tracing’s formatter write output into a buffer instead of the terminal.

**Data flow**: It receives the shared writer by reference, clones the shared byte-buffer handle, and returns a `SharedWriterGuard` that writes into the same buffer.

**Call relations**: Tracing’s formatting layer calls this when it needs somewhere to write a log line during the feedback-format test.

*Call graph*: 1 external calls (clone).


##### `tests::SharedWriterGuard::write`  (lines 549–555)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Appends formatted log bytes to the shared in-memory buffer used by tests.

**Data flow**: It receives a byte slice, locks the shared buffer, appends the bytes, and reports that all bytes were written.

**Call relations**: The tracing formatter uses this through Rust’s standard writing interface when the feedback-format test captures normal log output.


##### `tests::SharedWriterGuard::flush`  (lines 557–559)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Satisfies the writer interface for the in-memory test writer. Since the writer stores bytes immediately, flushing has no extra work to do.

**Data flow**: It receives the writer guard and returns success without changing anything.

**Call relations**: The tracing formatter may call this as part of normal writing. The no-op behavior is correct because there is no external file or stream to flush.


##### `tests::sqlite_feedback_logs_match_feedback_formatter_shape`  (lines 563–618)

```
async fn sqlite_feedback_logs_match_feedback_formatter_shape()
```

**Purpose**: Checks that feedback logs stored in SQLite have the same shape as the normal formatted tracing output. This protects users from seeing two different log formats for the same events.

**Data flow**: It creates a temporary runtime, installs both a normal formatting layer and the database layer, emits logs inside and outside a thread-tagged span, flushes the database layer, then compares the stored feedback logs with the captured formatted output after ignoring timestamps.

**Call relations**: This test exercises `start`, span tracking, event formatting, flushing, and feedback-log querying together as one end-to-end flow.

*Call graph*: calls 2 internal fn (start, init); 11 external calls (from_utf8, new, assert_eq!, default, temp_codex_home, remove_dir_all, debug!, info_span!, trace!, layer (+1 more)).


##### `tests::flush_persists_logs_for_query`  (lines 621–649)

```
async fn flush_persists_logs_for_query()
```

**Purpose**: Verifies that an explicit flush makes a buffered log visible to database queries. This confirms the flush command is useful for callers that need immediate consistency.

**Data flow**: It creates a runtime and layer, installs the layer, emits one log, calls `flush`, queries logs, and checks that exactly one row with the expected message exists.

**Call relations**: This test covers the path from tracing event to queue to flush command to SQLite row, using the public `start` helper.

*Call graph*: calls 2 internal fn (start, init); 7 external calls (new, assert_eq!, temp_codex_home, default, remove_dir_all, info!, registry).


##### `tests::configured_batch_size_flushes_without_explicit_flush`  (lines 652–698)

```
async fn configured_batch_size_flushes_without_explicit_flush()
```

**Purpose**: Verifies that reaching the configured batch size writes logs even without an explicit flush. This proves the background writer does not rely only on manual flushing.

**Data flow**: It starts a layer with batch size two and a long timer interval, emits one log and confirms it is not written yet, emits a second log, waits for two rows, and checks their messages.

**Call relations**: This test uses `LogDbLayer::start_with_config` and `wait_for_log_count` to exercise the batch-full branch of the background inserter.

*Call graph*: calls 2 internal fn (start_with_config, init); 10 external calls (new, assert_eq!, temp_codex_home, wait_for_log_count, from_millis, from_secs, remove_dir_all, sleep, info!, registry).


##### `tests::configured_flush_interval_persists_buffered_logs`  (lines 701–731)

```
async fn configured_flush_interval_persists_buffered_logs()
```

**Purpose**: Verifies that the timer-based flush writes logs even when the batch is not full. This prevents low-volume logs from sitting in memory forever.

**Data flow**: It starts a layer with a short flush interval and large batch size, emits one log, waits until one row appears in the database, and checks the message.

**Call relations**: This test exercises the timed branch of `run_inserter`, again using `start_with_config` to make the behavior happen quickly.

*Call graph*: calls 2 internal fn (start_with_config, init); 9 external calls (new, assert_eq!, temp_codex_home, wait_for_log_count, from_millis, remove_dir_all, sleep, info!, registry).


##### `tests::event_queue_drops_new_entries_when_full`  (lines 734–751)

```
async fn event_queue_drops_new_entries_when_full()
```

**Purpose**: Checks that ordinary log entries are dropped when the bounded queue is full. This confirms logging will not block application work under pressure.

**Data flow**: It creates a queue with room for one command, builds a layer around it, tries to send two test entries, then confirms only the first entry is waiting in the receiver.

**Call relations**: This test directly exercises `LogDbLayer::try_send` and the queue policy without involving tracing or SQLite.

*Call graph*: 5 external calls (assert!, assert_eq!, channel, panic!, test_entry).


##### `tests::flush_waits_for_queue_capacity_and_receiver_processing`  (lines 754–791)

```
async fn flush_waits_for_queue_capacity_and_receiver_processing()
```

**Purpose**: Checks that a flush waits until earlier queued entries and the flush command itself are processed. This protects callers who depend on `flush` as a synchronization point.

**Data flow**: It fills a one-item queue with a test entry, starts a task that calls `flush`, confirms the task waits, manually receives the entry and then the flush command, sends the flush reply, and confirms the task completes.

**Call relations**: This test focuses on the command-queue contract between `LogDbLayer::flush` and the background receiver, without starting the real inserter.

*Call graph*: 10 external calls (assert!, assert_eq!, channel, panic!, test_entry, from_millis, from_secs, spawn, sleep, timeout).


### `state/src/runtime/logs.rs`

`io_transport` · `startup, log writing, log querying, feedback collection, tests`

This file is the logbook for StateRuntime. When the app writes log entries, this code saves them to a separate SQLite database, which is a small file-based database. It also decides what old log lines must be removed so the logbook does not become too large.

The main write path is simple: accept one or many LogEntry records, insert them into the logs table, estimate how much visible text each row adds, then prune older rows in the same database transaction. A transaction is like writing on a receipt before handing it over: outsiders either see the whole finished change or none of it. Pruning is done per conversation thread, and also for logs that are not tied to a thread but are tied to a process. This prevents one noisy thread or process from crowding out everything else.

The read side supports ordinary log searches with filters such as time range, level, file, thread, and text search. It also formats feedback logs as plain text bytes, keeping the newest useful slice within the retention budget. Startup maintenance removes logs older than ten days and asks SQLite to checkpoint its write-ahead log, which helps keep disk files tidy without blocking normal work.

The bottom half of the file is tests. They protect important promises: logs use the dedicated database, old schemas migrate correctly, pruning obeys size and row limits, and feedback output includes the right lines in the right order.

#### Function details

##### `StateRuntime::insert_log`  (lines 6–8)

```
async fn insert_log(&self, entry: &LogEntry) -> anyhow::Result<()>
```

**Purpose**: This is the convenience path for saving a single log entry. Callers use it when they have one LogEntry and do not want to build a one-item list themselves.

**Data flow**: It receives one LogEntry by reference, wraps that one entry as a tiny slice, and passes it into the batch insert path. It returns success or the database error reported by that shared insert path.

**Call relations**: This function is a small front door into StateRuntime::insert_logs. It does no database work itself; it hands the single entry to the batch writer so all log insertion follows the same rules.

*Call graph*: calls 1 internal fn (insert_logs); 1 external calls (from_ref).


##### `StateRuntime::insert_logs`  (lines 11–47)

```
async fn insert_logs(&self, entries: &[LogEntry]) -> anyhow::Result<()>
```

**Purpose**: This saves a batch of log entries into the logs database and immediately enforces the retention limits. Without it, new logs would not be persisted, and noisy logs could grow the database without bounds.

**Data flow**: It receives a list of LogEntry values. If the list is empty, it does nothing. Otherwise it opens a database transaction, builds one multi-row INSERT statement, chooses the feedback-visible body for each row, estimates each row’s visible byte size, writes the rows, asks the pruning helper to remove excess old rows, commits the transaction, and returns success or an error.

**Call relations**: StateRuntime::insert_log calls this for the single-log case. After inserting, it calls StateRuntime::prune_logs_after_insert before committing, so readers never see a state where fresh rows were added but old over-budget rows were not yet removed.

*Call graph*: calls 1 internal fn (prune_logs_after_insert); called by 1 (insert_log); 2 external calls (new, is_empty).


##### `StateRuntime::prune_logs_after_insert`  (lines 62–286)

```
async fn prune_logs_after_insert(
        &self,
        entries: &[LogEntry],
        tx: &mut SqliteConnection,
    ) -> anyhow::Result<()>
```

**Purpose**: This trims old log rows after new ones are inserted, keeping each thread or threadless process within size and row-count budgets. It is the safeguard that keeps the log database from becoming an unbounded pile of old messages.

**Data flow**: It receives the just-inserted entries and the open SQLite transaction. It looks only at the thread IDs and process IDs touched by those entries, checks whether those partitions are over the byte or row limit, and deletes the oldest rows beyond the budget. It treats thread logs, threadless logs with a process UUID, and threadless logs with no process UUID as separate buckets.

**Call relations**: Only StateRuntime::insert_logs calls this, and it runs inside the same transaction as the insert. It uses SQL window calculations to count from newest to oldest, keeping the newest allowed rows and deleting the rest.

*Call graph*: called by 1 (insert_logs); 2 external calls (new, iter).


##### `StateRuntime::delete_logs_before`  (lines 288–294)

```
async fn delete_logs_before(&self, cutoff_ts: i64) -> anyhow::Result<u64>
```

**Purpose**: This deletes every log row older than a given timestamp. It is used for broad time-based cleanup, separate from the per-thread and per-process size caps.

**Data flow**: It receives a cutoff timestamp in seconds. It sends a DELETE query to the logs database for rows whose timestamp is earlier than the cutoff, then returns how many rows SQLite says were removed.

**Call relations**: StateRuntime::run_logs_startup_maintenance calls this during startup cleanup. It is the focused database action behind the higher-level maintenance routine.

*Call graph*: called by 1 (run_logs_startup_maintenance); 1 external calls (query).


##### `StateRuntime::run_logs_startup_maintenance`  (lines 296–310)

```
async fn run_logs_startup_maintenance(&self) -> anyhow::Result<()>
```

**Purpose**: This performs housekeeping on the logs database when the runtime starts. It removes logs older than the configured retention period and nudges SQLite to tidy its write-ahead log without delaying foreground work.

**Data flow**: It reads the current UTC time, subtracts ten days, and uses that as the cutoff for StateRuntime::delete_logs_before. After deletion, it runs a passive SQLite checkpoint, which copies safe pending database changes from the write-ahead log into the main database file without waiting on busy readers or writers.

**Call relations**: This routine calls StateRuntime::delete_logs_before for age-based cleanup, then runs the SQLite maintenance command directly. It is meant to be invoked by startup code, not by each log write.

*Call graph*: calls 1 internal fn (delete_logs_before); 3 external calls (now, days, query).


##### `StateRuntime::query_logs`  (lines 313–332)

```
async fn query_logs(&self, query: &LogQuery) -> anyhow::Result<Vec<LogRow>>
```

**Purpose**: This reads log rows for display or inspection, using optional filters from a LogQuery. It is the general-purpose search path for persisted logs.

**Data flow**: It receives a LogQuery describing filters such as level, time range, module, file, thread, search text, order, and limit. It builds a SELECT statement, adds filter clauses with push_log_filters, applies ordering and an optional limit, runs the query, and returns matching LogRow values.

**Call relations**: This function relies on push_log_filters to keep filtering rules shared with StateRuntime::max_log_id. It is called by code that wants actual log rows, while max_log_id uses the same filters to find a boundary ID.

*Call graph*: calls 1 internal fn (push_log_filters); 1 external calls (new).


##### `StateRuntime::query_feedback_logs_for_threads`  (lines 335–431)

```
async fn query_feedback_logs_for_threads(
        &self,
        thread_ids: &[&str],
    ) -> anyhow::Result<Vec<u8>>
```

**Purpose**: This gathers feedback-ready log text for one or more conversation threads. It includes the requested thread logs plus relevant threadless process logs, then returns a byte buffer suitable for attaching or sending as feedback context.

**Data flow**: It receives a list of thread ID strings. If the list is empty, it returns empty bytes. Otherwise it asks SQLite for the newest feedback-visible rows within the retention budget, including threadless rows from the latest process associated with each requested thread. It formats each row into a timestamped line, stops before exceeding the byte budget, reverses the newest-first query result back into chronological order, and returns the combined UTF-8 bytes.

**Call relations**: StateRuntime::query_feedback_logs calls this for the one-thread case. This function calls format_feedback_log_line for the final human-readable line shape and uses SQL to do the first round of bounding before applying an exact whole-line byte cap in Rust.

*Call graph*: calls 1 internal fn (format_feedback_log_line); called by 1 (query_feedback_logs); 4 external calls (new, new, with_capacity, try_from).


##### `StateRuntime::query_feedback_logs`  (lines 434–436)

```
async fn query_feedback_logs(&self, thread_id: &str) -> anyhow::Result<Vec<u8>>
```

**Purpose**: This is the one-thread shortcut for collecting feedback logs. Callers use it when feedback is tied to a single conversation thread.

**Data flow**: It receives one thread ID, places it into a one-item list, and passes that list to StateRuntime::query_feedback_logs_for_threads. It returns the byte buffer or error from that shared multi-thread path.

**Call relations**: This function is a small wrapper around StateRuntime::query_feedback_logs_for_threads, ensuring single-thread and multi-thread feedback export follow the same inclusion and size rules.

*Call graph*: calls 1 internal fn (query_feedback_logs_for_threads).


##### `StateRuntime::max_log_id`  (lines 439–446)

```
async fn max_log_id(&self, query: &LogQuery) -> anyhow::Result<i64>
```

**Purpose**: This finds the largest database ID among logs matching a query. It is useful for polling or pagination, where a caller needs to know the newest log currently available under the same filters.

**Data flow**: It receives a LogQuery, builds a SELECT MAX(id) query, applies the same filters used by query_logs, runs it, and returns the maximum ID. If no row matches, it returns 0.

**Call relations**: Like StateRuntime::query_logs, it calls push_log_filters so both functions agree on what a filter means. Instead of returning rows, it returns only the highest matching ID.

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

**Purpose**: This turns one stored feedback log row into a single plain-text line. It gives feedback exports a stable, readable format with timestamp, level, and message body.

**Data flow**: It receives seconds, nanoseconds, a log level, and the feedback body text. It converts the time into an RFC 3339 timestamp when possible, falls back to a raw timestamp string if needed, builds a line with the level right-aligned, and ensures the line ends with exactly at least one newline.

**Call relations**: StateRuntime::query_feedback_logs_for_threads calls this while assembling the feedback byte buffer. The tests also check it directly because small formatting changes would affect feedback output.

*Call graph*: called by 1 (query_feedback_logs_for_threads); 3 external calls (from_timestamp, format!, try_from).


##### `push_log_filters`  (lines 475–521)

```
fn push_log_filters(builder: &mut QueryBuilder<Sqlite>, query: &LogQuery)
```

**Purpose**: This adds the WHERE-clause pieces for a LogQuery to a SQL query builder. It keeps all log filtering rules in one place so different reads interpret queries the same way.

**Data flow**: It receives a mutable SQL query builder and a LogQuery. It appends conditions for levels, time range, module substring, file substring, thread IDs, optional threadless logs, minimum ID, and body text search. It changes the builder in place and returns nothing.

**Call relations**: StateRuntime::query_logs and StateRuntime::max_log_id both call this. For substring filters on module and file columns, it delegates to push_like_filters.

*Call graph*: calls 1 internal fn (push_like_filters); called by 2 (max_log_id, query_logs); 3 external calls (push, push_bind, separated).


##### `push_like_filters`  (lines 523–539)

```
fn push_like_filters(builder: &mut QueryBuilder<Sqlite>, column: &str, filters: &[String])
```

**Purpose**: This adds one or more SQL LIKE substring checks for a single column. It is used when a query wants logs whose module path or file name contains certain text.

**Data flow**: It receives a query builder, a column name, and a list of filter strings. If the list is empty, it leaves the builder unchanged. Otherwise it appends an AND group where the column may match any of the provided substrings.

**Call relations**: push_log_filters calls this for module_path and file filters. It is a helper that keeps the repeated SQL pattern out of the larger filter-building function.

*Call graph*: called by 1 (push_log_filters); 1 external calls (push).


##### `tests::open_db_pool`  (lines 558–566)

```
async fn open_db_pool(path: &Path) -> SqlitePool
```

**Purpose**: This test helper opens a SQLite connection pool for an existing database file. Tests use it to inspect the log database directly.

**Data flow**: It receives a filesystem path, builds SQLite connection options for that path without creating a missing file, opens the pool, and returns it. If opening fails, the test fails immediately.

**Call relations**: Tests such as tests::log_row_count and the migration and auto-vacuum checks call this helper when they need direct database access outside StateRuntime.

*Call graph*: 2 external calls (new, connect_with).


##### `tests::log_row_count`  (lines 568–576)

```
async fn log_row_count(path: &Path) -> i64
```

**Purpose**: This test helper counts how many rows are in the logs table. It gives tests a quick way to confirm that inserts landed in the expected database.

**Data flow**: It receives a database path, opens a pool with tests::open_db_pool, runs SELECT COUNT(*) FROM logs, closes the pool, and returns the count.

**Call relations**: tests::insert_logs_use_dedicated_log_database calls this after writing a log through StateRuntime, so the test can verify the dedicated logs database contains the row.

*Call graph*: 1 external calls (open_db_pool).


##### `tests::insert_logs_use_dedicated_log_database`  (lines 579–607)

```
async fn insert_logs_use_dedicated_log_database()
```

**Purpose**: This test proves that log writes go to the separate logs database, not some other runtime database. That matters because logs have their own schema and cleanup rules.

**Data flow**: It creates a temporary runtime home, initializes StateRuntime, inserts one log entry, opens the expected logs database path, counts rows, checks that exactly one row exists, and removes the temporary directory.

**Call relations**: The test runner calls this test. It exercises StateRuntime::insert_logs through a real initialized runtime and uses tests::log_row_count to inspect the database file.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (assert_eq!, logs_db_path, log_row_count, remove_dir_all).


##### `tests::init_migrates_message_only_logs_db_to_feedback_log_body_schema`  (lines 610–706)

```
async fn init_migrates_message_only_logs_db_to_feedback_log_body_schema()
```

**Purpose**: This test checks that an old logs database using the former message column is upgraded to the newer feedback_log_body schema. It protects users who already have older local log databases.

**Data flow**: It creates a temporary old-style logs database, applies only the first migration, inserts a legacy row, initializes StateRuntime, queries logs through the runtime, and verifies the legacy text appears in the new message field. It also checks the final column and index names.

**Call relations**: The test runner calls this test. It uses StateRuntime::init to trigger migrations and StateRuntime::query_logs to confirm migrated data remains readable.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 12 external calls (Owned, new, connect_with, now, assert_eq!, logs_db_path, query, default, open_db_pool, create_dir_all (+2 more)).


##### `tests::init_configures_logs_db_with_incremental_auto_vacuum`  (lines 709–724)

```
async fn init_configures_logs_db_with_incremental_auto_vacuum()
```

**Purpose**: This test verifies that the logs database is configured to reclaim freed pages incrementally. That setting helps keep disk usage under control after pruning deletes rows.

**Data flow**: It creates a temporary runtime, initializes StateRuntime, opens the logs database directly, reads SQLite’s auto_vacuum setting, checks that it is the incremental mode value, closes the pool, and removes the temporary directory.

**Call relations**: The test runner calls this test. It relies on StateRuntime::init to create and configure the database, and tests::open_db_pool to inspect the SQLite setting.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (assert_eq!, logs_db_path, open_db_pool, remove_dir_all).


##### `tests::format_feedback_log_line_matches_feedback_formatter_shape`  (lines 727–737)

```
fn format_feedback_log_line_matches_feedback_formatter_shape()
```

**Purpose**: This test locks down the normal formatting of one feedback log line. It makes sure timestamps, log level spacing, message text, and newline behavior stay stable.

**Data flow**: It calls format_feedback_log_line with a known timestamp, level, and message, then compares the returned string to the expected text.

**Call relations**: The test runner calls this test. It directly protects format_feedback_log_line, which is used by feedback log export.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::format_feedback_log_line_preserves_existing_trailing_newline`  (lines 740–750)

```
fn format_feedback_log_line_preserves_existing_trailing_newline()
```

**Purpose**: This test checks that formatting does not add an extra blank line when the feedback body already ends with a newline.

**Data flow**: It calls format_feedback_log_line with message text that already has a trailing newline and checks that the result has only the expected single line ending.

**Call relations**: The test runner calls this test. It covers a small but visible behavior of format_feedback_log_line used by feedback exports.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::query_logs_with_search_matches_rendered_body_substring`  (lines 753–803)

```
async fn query_logs_with_search_matches_rendered_body_substring()
```

**Purpose**: This test confirms that log search looks inside the feedback-visible body, not just the older message fallback. Users searching logs should find the text they would actually see.

**Data flow**: It initializes a temporary runtime, inserts two logs with different feedback bodies, queries with a search string that matches only one body, checks that one row comes back with the expected message, and removes the temporary directory.

**Call relations**: The test runner calls this test. It exercises StateRuntime::insert_logs and StateRuntime::query_logs, including the search clause built by push_log_filters.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert_eq!, remove_dir_all).


##### `tests::query_logs_filters_level_set_without_rewriting_stored_level`  (lines 806–888)

```
async fn query_logs_filters_level_set_without_rewriting_stored_level()
```

**Purpose**: This test checks that level filtering is case-insensitive while preserving the original stored level text. For example, a stored lowercase warn should still be returned as warn.

**Data flow**: It inserts logs with several levels, including mixed case, queries for WARN and ERROR, and compares the returned levels and messages to the expected rows.

**Call relations**: The test runner calls this test. It exercises StateRuntime::query_logs and the level filtering added by push_log_filters.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert_eq!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_old_rows_when_thread_exceeds_size_limit`  (lines 891–942)

```
async fn insert_logs_prunes_old_rows_when_thread_exceeds_size_limit()
```

**Purpose**: This test proves that a thread that exceeds its byte budget loses older rows first. It protects the rule that the newest useful thread logs are kept.

**Data flow**: It inserts two large log entries for the same thread whose combined estimated size is too large, queries that thread, and checks that only the newer row remains.

**Call relations**: The test runner calls this test. It exercises StateRuntime::insert_logs and the thread branch of StateRuntime::prune_logs_after_insert.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert_eq!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_single_thread_row_when_it_exceeds_size_limit`  (lines 945–980)

```
async fn insert_logs_prunes_single_thread_row_when_it_exceeds_size_limit()
```

**Purpose**: This test checks the edge case where one thread log row is larger than the entire partition budget. Such a row must be deleted rather than allowed to break the cap.

**Data flow**: It inserts one oversized row for a thread, queries that thread, and confirms no rows remain.

**Call relations**: The test runner calls this test. It focuses on the strict size enforcement inside StateRuntime::prune_logs_after_insert after StateRuntime::insert_logs writes the row.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_threadless_rows_per_process_uuid_only`  (lines 983–1049)

```
async fn insert_logs_prunes_threadless_rows_per_process_uuid_only()
```

**Purpose**: This test verifies that logs without a thread are pruned by process UUID and do not delete thread-scoped logs from the same process. It keeps the separate budget rules honest.

**Data flow**: It inserts two large threadless logs for one process and one thread log for the same process, queries thread plus threadless logs, and checks that the older threadless row was removed while the thread row remains.

**Call relations**: The test runner calls this test. It exercises the threadless-with-process branch of StateRuntime::prune_logs_after_insert.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert_eq!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_single_threadless_process_row_when_it_exceeds_size_limit`  (lines 1052–1087)

```
async fn insert_logs_prunes_single_threadless_process_row_when_it_exceeds_size_limit()
```

**Purpose**: This test checks that one oversized threadless log with a process UUID is removed. The process-level budget should be just as strict as the thread budget.

**Data flow**: It inserts one oversized threadless process log, queries threadless logs, and confirms the result is empty.

**Call relations**: The test runner calls this test. It verifies StateRuntime::insert_logs and StateRuntime::prune_logs_after_insert for oversized process-partition rows.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert!, remove_dir_all).


##### `tests::insert_logs_prunes_threadless_rows_with_null_process_uuid`  (lines 1090–1155)

```
async fn insert_logs_prunes_threadless_rows_with_null_process_uuid()
```

**Purpose**: This test verifies that threadless logs with no process UUID still have their own retention bucket. Without this, anonymous threadless logs could grow unchecked.

**Data flow**: It inserts two large threadless logs with no process UUID and one small threadless log with a process UUID, queries threadless logs, and checks that only the newer null-process row plus the separate process row remain.

**Call relations**: The test runner calls this test. It exercises the null-process branch of StateRuntime::prune_logs_after_insert.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert_eq!, remove_dir_all).


##### `tests::insert_logs_prunes_single_threadless_null_process_row_when_it_exceeds_limit`  (lines 1158–1193)

```
async fn insert_logs_prunes_single_threadless_null_process_row_when_it_exceeds_limit()
```

**Purpose**: This test checks that one oversized threadless log without a process UUID is removed. It protects the strict cap for the null-process bucket.

**Data flow**: It inserts one very large threadless log with no process UUID, queries threadless logs, and confirms no row remains.

**Call relations**: The test runner calls this test. It covers the oversized-row case in the null-process branch of StateRuntime::prune_logs_after_insert.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert!, remove_dir_all).


##### `tests::insert_logs_prunes_old_rows_when_thread_exceeds_row_limit`  (lines 1196–1236)

```
async fn insert_logs_prunes_old_rows_when_thread_exceeds_row_limit()
```

**Purpose**: This test proves that thread logs are also capped by row count, not only by byte size. It keeps a flood of tiny messages from accumulating forever.

**Data flow**: It inserts 1,001 small rows for one thread, queries that thread, and checks that 1,000 rows remain, starting from the second timestamp through the newest timestamp.

**Call relations**: The test runner calls this test. It exercises the row-count part of StateRuntime::prune_logs_after_insert for thread partitions.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 4 external calls (default, assert_eq!, remove_dir_all, vec!).


##### `tests::insert_logs_prunes_old_threadless_rows_when_process_exceeds_row_limit`  (lines 1239–1283)

```
async fn insert_logs_prunes_old_threadless_rows_when_process_exceeds_row_limit()
```

**Purpose**: This test confirms that threadless logs for a process UUID obey the row-count limit. Tiny process logs should be trimmed just like large ones.

**Data flow**: It inserts 1,001 threadless rows for one process, queries threadless logs, filters the result to that process, and checks that the oldest row was removed while the newest 1,000 remain.

**Call relations**: The test runner calls this test. It exercises the process UUID row-count pruning path in StateRuntime::prune_logs_after_insert.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert_eq!, remove_dir_all).


##### `tests::insert_logs_prunes_old_threadless_null_process_rows_when_row_limit_exceeded`  (lines 1286–1330)

```
async fn insert_logs_prunes_old_threadless_null_process_rows_when_row_limit_exceeded()
```

**Purpose**: This test checks row-count pruning for threadless logs that have no process UUID. It ensures the anonymous bucket also cannot grow forever.

**Data flow**: It inserts 1,001 threadless rows with no process UUID, queries threadless logs, filters to rows still lacking a process UUID, and checks that the newest 1,000 remain.

**Call relations**: The test runner calls this test. It exercises the null-process row-count pruning path in StateRuntime::prune_logs_after_insert.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 3 external calls (default, assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_returns_newest_lines_within_limit_in_order`  (lines 1333–1400)

```
async fn query_feedback_logs_returns_newest_lines_within_limit_in_order()
```

**Purpose**: This test checks that feedback log export returns the selected lines in chronological reading order. Even though selection favors newest rows, the final text should read oldest to newest.

**Data flow**: It inserts three logs for one thread, requests feedback logs for that thread, converts the returned bytes to text, and compares them to three formatted lines in timestamp order.

**Call relations**: The test runner calls this test. It exercises StateRuntime::query_feedback_logs, which delegates to StateRuntime::query_feedback_logs_for_threads and uses format_feedback_log_line.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_excludes_oversized_newest_row`  (lines 1403–1450)

```
async fn query_feedback_logs_excludes_oversized_newest_row()
```

**Purpose**: This test verifies that feedback export refuses a newest row that is larger than the byte budget. It should return nothing rather than include a partial or over-budget line.

**Data flow**: It inserts a small older row and an oversized newer row for one thread, asks for feedback logs, and checks that the returned byte buffer is empty.

**Call relations**: The test runner calls this test. It exercises the size-bounding behavior in StateRuntime::query_feedback_logs_for_threads through the single-thread wrapper.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_includes_threadless_rows_from_same_process`  (lines 1453–1548)

```
async fn query_feedback_logs_includes_threadless_rows_from_same_process()
```

**Purpose**: This test confirms that feedback for a thread includes threadless logs from the same process. Those logs can contain important context even though they are not tied to the thread ID.

**Data flow**: It inserts threadless and thread-scoped logs for one process plus an unrelated threadless log for another process, exports feedback for the thread, and checks that only the same-process context is included.

**Call relations**: The test runner calls this test. It exercises the process-context logic inside StateRuntime::query_feedback_logs_for_threads.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_excludes_threadless_rows_from_prior_processes`  (lines 1551–1646)

```
async fn query_feedback_logs_excludes_threadless_rows_from_prior_processes()
```

**Purpose**: This test checks that threadless feedback context comes from the latest process associated with the thread, not from older processes. That prevents stale process-wide noise from being attached to current feedback.

**Data flow**: It inserts thread logs for the same thread across an old and new process, plus threadless logs for both processes. It exports feedback and checks that the old thread-scoped row remains but old-process threadless context is excluded, while new-process threadless context is included.

**Call relations**: The test runner calls this test. It focuses on the latest-process lookup inside StateRuntime::query_feedback_logs_for_threads.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_keeps_newest_suffix_across_thread_and_threadless_logs`  (lines 1649–1721)

```
async fn query_feedback_logs_keeps_newest_suffix_across_thread_and_threadless_logs()
```

**Purpose**: This test verifies that feedback export applies one combined byte budget across thread and threadless logs, keeping the newest suffix that fits. It prevents older context from crowding out newer, more relevant context.

**Data flow**: It inserts an older thread log and two newer large threadless logs for the same process, exports feedback, converts bytes to text, and checks that the older marker is absent while the newer markers are present.

**Call relations**: The test runner calls this test. It exercises the combined ordering and byte cap in StateRuntime::query_feedback_logs_for_threads.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 5 external calls (from_utf8, assert!, assert_eq!, format!, remove_dir_all).


##### `tests::query_feedback_logs_for_threads_merges_requested_threads_and_threadless_rows`  (lines 1724–1841)

```
async fn query_feedback_logs_for_threads_merges_requested_threads_and_threadless_rows()
```

**Purpose**: This test checks multi-thread feedback export. It should merge logs for the requested threads and include threadless rows from their associated processes, while ignoring unrequested threads.

**Data flow**: It inserts logs for three threads and threadless logs for three processes, requests feedback for only the first two threads, and compares the returned text to the expected four lines.

**Call relations**: The test runner calls this test. It directly exercises StateRuntime::query_feedback_logs_for_threads with more than one thread ID.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).


##### `tests::query_feedback_logs_for_threads_returns_empty_for_empty_thread_list`  (lines 1844–1858)

```
async fn query_feedback_logs_for_threads_returns_empty_for_empty_thread_list()
```

**Purpose**: This test confirms that asking for feedback logs with no thread IDs returns an empty result. It avoids unnecessary SQL work and gives callers a predictable answer.

**Data flow**: It initializes a temporary runtime, calls StateRuntime::query_feedback_logs_for_threads with an empty slice, checks that the returned bytes are empty, and removes the temporary directory.

**Call relations**: The test runner calls this test. It protects the early-return path in StateRuntime::query_feedback_logs_for_threads.

*Call graph*: calls 2 internal fn (init, unique_temp_dir); 2 external calls (assert_eq!, remove_dir_all).
