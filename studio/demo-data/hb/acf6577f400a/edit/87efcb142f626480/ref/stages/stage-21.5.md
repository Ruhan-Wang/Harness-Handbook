# External session import persistence  `stage-21.5`

This stage is shared behind-the-scenes support for bringing session history in from other tools. Its job is to remember what has already been imported and to turn outside session files into a clean, consistent shape that the rest of the system can use.

The ledger file is the memory. It stores a record of imported session file versions using two clues: the file’s real path and a content hash, which is a fingerprint of the file’s contents. That lets the system quickly answer practical questions like “Have we seen this exact version before?” and refresh file details when it scans for imports, so it does not re-import the same material by mistake.

The records file is the translator. It reads JSONL files, which are text files made of one JSON object per line, and can produce either quick summaries or full message streams ready for import. While reading, it smooths out differences in message formats, titles, timestamps, and tool output blocks, turning mixed external data into Codex-friendly text.

Together, these two parts act like a librarian and a translator: one tracks what is already on the shelf, and the other rewrites incoming material into the house style.

## Files in this stage

### Import state tracking
The ledger persists and refreshes knowledge about previously imported external session file versions so later import work can quickly decide what is new.

### `external-agent-sessions/src/ledger.rs`

`io_transport` · `discovery/import bookkeeping`

This file defines the import ledger format and all read/write logic around it. The persisted `ImportedExternalAgentSessionLedger` is a JSON file named `external_agent_session_imports.json` under `codex_home`, containing a vector of `ImportedExternalAgentSessionRecord` entries. Each record stores the canonical source path, SHA-256 of the file contents at import time, the destination `ThreadId`, the import timestamp, and an optional source modification timestamp in nanoseconds.

The ledger serves two related but distinct checks. `contains_current_source` canonicalizes a candidate path, avoids hashing entirely if the ledger is empty or has no record for that path, and otherwise hashes the current file to see whether that exact version was imported. `refresh_current_source` performs the same path/hash match but, when successful, updates `imported_at` and `source_modified_at` in-place so detection can suppress already imported current files without re-importing them. `record_completed_session_imports` is the write path after successful imports: it loads the ledger, stamps all imports with one `now_unix_seconds()` value, updates an existing matching record if present, or appends a new one.

Helper functions isolate path canonicalization, ledger path construction, content hashing with a 64 KiB buffer, and best-effort mtime extraction. Tests in the companion file emphasize an important invariant: empty or path-missing ledgers must not try to read source files, and completed imports can still be recorded even if the source file has already been deleted.

#### Function details

##### `has_current_session_been_imported`  (lines 46–51)

```
fn has_current_session_been_imported(
    codex_home: &Path,
    source_path: &Path,
) -> io::Result<bool>
```

**Purpose**: Answers whether the current on-disk contents of a source session file already exist in the import ledger.

**Data flow**: It takes `codex_home` and `source_path`, loads the ledger from disk with `load_import_ledger`, calls `contains_current_source` on the loaded ledger, and returns the resulting `io::Result<bool>`.

**Call relations**: This is the public query used by `prepare_validated_session_import` before doing any heavier import preparation.

*Call graph*: calls 1 internal fn (load_import_ledger); called by 1 (prepare_validated_session_import).


##### `record_imported_session`  (lines 54–68)

```
fn record_imported_session(
    codex_home: &Path,
    source_path: &Path,
    imported_thread_id: ThreadId,
) -> io::Result<()>
```

**Purpose**: Test-only convenience wrapper that records one imported session by canonicalizing the path and hashing the current file contents.

**Data flow**: It accepts `codex_home`, `source_path`, and `imported_thread_id`, canonicalizes the source path, computes its SHA-256 via `session_content_sha256`, wraps those values into a one-element `Vec<CompletedExternalAgentSessionImport>`, and forwards to `record_completed_session_imports`.

**Call relations**: Used only in tests across this crate to seed or update the ledger before calling detection or validation logic.

*Call graph*: calls 2 internal fn (canonical_source_path, record_completed_session_imports); called by 4 (detects_sessions_in_batches, redetects_sessions_when_source_contents_change_after_import, skips_already_imported_current_session_versions, skips_session_that_was_already_imported); 1 external calls (vec!).


##### `record_completed_session_imports`  (lines 70–101)

```
fn record_completed_session_imports(
    codex_home: &Path,
    imports: Vec<CompletedExternalAgentSessionImport>,
) -> io::Result<()>
```

**Purpose**: Writes one or more completed imports into the ledger, replacing metadata on an existing identical source-path/content-hash record when necessary.

**Data flow**: It takes `codex_home` and a vector of completed imports. If the vector is empty it returns immediately. Otherwise it loads the current ledger, captures one `imported_at` timestamp, and for each import tries to read the source file's modified time with `session_modified_at`. If a record with the same canonical source path and content hash already exists, it removes that record, updates its thread ID, import time, and `source_modified_at` (preferring the new value when available), then pushes it back. If no match exists, it appends a new `ImportedExternalAgentSessionRecord`. Finally it persists the ledger with `save_import_ledger`.

**Call relations**: This is the main ledger mutation path, called by the test helper `record_imported_session`. It delegates persistence and metadata extraction to `load_import_ledger`, `session_modified_at`, and `save_import_ledger`.

*Call graph*: calls 3 internal fn (load_import_ledger, save_import_ledger, session_modified_at); called by 1 (record_imported_session); 1 external calls (now_unix_seconds).


##### `ImportedExternalAgentSessionLedger::source_states`  (lines 104–116)

```
fn source_states(&self) -> HashMap<&Path, ImportedSourceState>
```

**Purpose**: Builds a path-indexed snapshot of the latest known import metadata for each recorded source path.

**Data flow**: It reads `self.records`, inserts each record into a new `HashMap<&Path, ImportedSourceState>`, and returns that map. Later records for the same path overwrite earlier ones because insertion uses the same key.

**Call relations**: Used by `detect_recent_sessions` to cheaply compare candidate files against prior imported mtimes/import times before doing content hashing.

*Call graph*: 1 external calls (new).


##### `ImportedExternalAgentSessionLedger::contains_current_source`  (lines 118–134)

```
fn contains_current_source(&self, source_path: &Path) -> io::Result<bool>
```

**Purpose**: Checks whether the ledger contains an entry for the canonical source path whose stored content hash matches the file's current contents.

**Data flow**: It first returns `false` if `self.records` is empty. Otherwise it canonicalizes `source_path`; if no record exists for that canonical path it returns `false` without hashing. If the path is present, it computes the current SHA-256 with `session_content_sha256` and returns whether any record matches both path and hash.

**Call relations**: Called by `has_current_session_been_imported`. Its early exits are important for avoiding unnecessary filesystem reads and for the empty-ledger test case.

*Call graph*: calls 2 internal fn (canonical_source_path, session_content_sha256).


##### `ImportedExternalAgentSessionLedger::refresh_current_source`  (lines 136–160)

```
fn refresh_current_source(
        &mut self,
        source_path: &Path,
        source_modified_at: i64,
    ) -> io::Result<bool>
```

**Purpose**: Refreshes ledger metadata for a source file when its current contents already match an imported record.

**Data flow**: It takes a mutable ledger, a source path, and the caller-supplied source modified time in nanoseconds. It canonicalizes the path, returns `false` if no record exists for that path, hashes the current file, finds the most recent matching record by path and hash, removes it, updates `imported_at` to now and `source_modified_at` to the supplied value, pushes it back, and returns `true`.

**Call relations**: Used by `detect_recent_sessions` during candidate processing. A `true` result means the detector should skip summarization and later persist the refreshed ledger.

*Call graph*: calls 2 internal fn (canonical_source_path, session_content_sha256); 1 external calls (now_unix_seconds).


##### `load_import_ledger`  (lines 163–180)

```
fn load_import_ledger(
    codex_home: &Path,
) -> io::Result<ImportedExternalAgentSessionLedger>
```

**Purpose**: Loads the JSON ledger file from disk, treating a missing file as an empty ledger and malformed JSON as invalid data.

**Data flow**: It derives the ledger path with `import_ledger_path`, reads the file as a string, returns `ImportedExternalAgentSessionLedger::default()` on `NotFound`, otherwise deserializes with `serde_json::from_str`, mapping parse failures into `io::ErrorKind::InvalidData` with a descriptive message.

**Call relations**: This function is the shared read entry used by detection, import validation, and ledger mutation paths.

*Call graph*: calls 1 internal fn (import_ledger_path); called by 3 (detect_recent_sessions, has_current_session_been_imported, record_completed_session_imports); 3 external calls (default, read_to_string, from_str).


##### `save_import_ledger`  (lines 182–190)

```
fn save_import_ledger(
    codex_home: &Path,
    ledger: &ImportedExternalAgentSessionLedger,
) -> io::Result<()>
```

**Purpose**: Serializes the ledger to pretty JSON and writes it under the Codex home directory.

**Data flow**: It ensures `codex_home` exists with `create_dir_all`, computes the ledger file path, serializes `ledger` with `serde_json::to_vec_pretty`, maps serialization errors to `io::Error`, writes the bytes to disk, and returns the write result.

**Call relations**: Called after ledger mutations from `record_completed_session_imports` and after metadata refreshes from `detect_recent_sessions`.

*Call graph*: calls 1 internal fn (import_ledger_path); called by 2 (detect_recent_sessions, record_completed_session_imports); 3 external calls (create_dir_all, write, to_vec_pretty).


##### `import_ledger_path`  (lines 192–194)

```
fn import_ledger_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Computes the full path to the ledger JSON file under the Codex home directory.

**Data flow**: It joins `codex_home` with the constant filename `external_agent_session_imports.json` and returns the resulting `PathBuf`.

**Call relations**: A small helper shared by both ledger load and save operations so they target the same file.

*Call graph*: called by 2 (load_import_ledger, save_import_ledger); 1 external calls (join).


##### `canonical_source_path`  (lines 196–198)

```
fn canonical_source_path(path: &Path) -> io::Result<PathBuf>
```

**Purpose**: Normalizes a source session path to its canonical filesystem path.

**Data flow**: It takes a `&Path`, calls `fs::canonicalize`, and returns the canonical `PathBuf` or the underlying I/O error.

**Call relations**: Used before recording imports and before path-based ledger lookups so equivalent paths compare consistently.

*Call graph*: called by 3 (contains_current_source, refresh_current_source, record_imported_session); 1 external calls (canonicalize).


##### `session_content_sha256`  (lines 200–213)

```
fn session_content_sha256(path: &Path) -> io::Result<String>
```

**Purpose**: Computes the lowercase hexadecimal SHA-256 digest of a session file's raw bytes.

**Data flow**: It opens the file, allocates a fixed 64 KiB buffer, repeatedly reads chunks until EOF, feeds each chunk into a `Sha256` hasher, finalizes the digest, formats it as hex, and returns the string.

**Call relations**: This helper underpins content-version matching in `contains_current_source`, `refresh_current_source`, and the test-only `record_imported_session` wrapper.

*Call graph*: called by 2 (contains_current_source, refresh_current_source); 3 external calls (open, new, format!).


##### `session_modified_at`  (lines 215–221)

```
fn session_modified_at(path: &Path) -> io::Result<Option<i64>>
```

**Purpose**: Extracts a file's modification time as nanoseconds since the Unix epoch when representable.

**Data flow**: It reads filesystem metadata, gets the modified `SystemTime`, computes duration since `UNIX_EPOCH`, converts nanoseconds to `i64` if possible, and returns `Ok(Some(value))`; if the duration is before the epoch or the conversion overflows, it returns `Ok(None)`.

**Call relations**: Used by `record_completed_session_imports` to capture source mtime opportunistically without failing the whole ledger write when the timestamp cannot be represented.

*Call graph*: called by 1 (record_completed_session_imports); 1 external calls (metadata).


### Session record normalization
The record reader parses external-agent JSONL sessions into summaries or full message streams and normalizes their content into Codex-ready form.

### `external-agent-sessions/src/records.rs`

`domain_logic` · `session file parsing during discovery and import`

This file contains the low-level JSONL parser for external-agent session records. It supports two passes with different outputs: `summarize_session` scans for enough information to advertise a migration candidate, while `read_session_import` performs a single full read that also computes a SHA-256 over the raw file contents for ledgering. Both functions tolerate malformed or irrelevant lines by skipping them rather than failing the whole file.

Record parsing recognizes `custom-title` and `ai-title` metadata, with custom titles taking precedence over AI titles and both outranking the fallback title derived from the first user message. `conversation_message_from_owned_record` accepts only `user` and `assistant` records, rejects meta and sidechain entries, parses RFC3339 timestamps, and extracts message text from either a plain string or a structured content array. Structured content is flattened by `extract_message_text`: text blocks are copied, `tool_use` blocks become bounded note sections tagged with `external_agent_tool_call`, `tool_result` blocks become bounded note sections tagged with `external_agent_tool_result`, `thinking` blocks are dropped, and unknown block types are rendered as explicit placeholder text.

A notable nuance is `only_tool_result`: if a nominal user record contains only tool-result blocks, it is reclassified as an assistant message so imported history reads naturally. Tool-call and tool-result payloads are truncated to fixed limits to avoid exploding imported transcripts. Tests cover one-pass import parsing and the exact formatting of tool annotations.

#### Function details

##### `summarize_session`  (lines 33–94)

```
fn summarize_session(path: &Path) -> io::Result<Option<SessionSummary>>
```

**Purpose**: Reads a session file and extracts just enough information to decide whether it is importable and how it should be labeled in discovery results.

**Data flow**: It opens the file, iterates line by line through a `BufReader`, trims and skips empty lines, attempts to parse each line as `serde_json::Value`, captures the first available `cwd`, updates `custom_title` and `ai_title` when matching records appear, converts message records with `conversation_message_from_owned_record`, tracks whether any message was seen, derives a fallback title from the first user message via `summarize_for_label`, and keeps the maximum parsed timestamp. It returns `Ok(None)` if cwd is missing, no message was found, or no timestamp was parsed; otherwise it returns `SessionSummary { latest_timestamp, migration: ExternalAgentSessionMigration { path, cwd, title } }` where title preference is custom > AI > first user message.

**Call relations**: Called by `detect_recent_sessions` after filesystem and ledger filtering. It delegates title extraction and message normalization to the helper functions in this file.

*Call graph*: calls 3 internal fn (ai_title_from_record, conversation_message_from_owned_record, custom_title_from_record); 4 external calls (new, open, to_path_buf, summarize_for_label).


##### `read_session_import`  (lines 96–140)

```
fn read_session_import(path: &Path) -> io::Result<ParsedSessionImport>
```

**Purpose**: Performs a single pass over a session file to collect cwd, preferred source title, normalized conversation messages, and a SHA-256 of the raw file contents.

**Data flow**: It opens the file, wraps it in a `BufReader`, repeatedly reads each raw line into a reusable `String`, updates a `Sha256` hasher with the exact bytes read, trims and skips empty lines, parses JSON values when possible, captures the first cwd, updates custom and AI titles, converts message records with `conversation_message_from_owned_record`, and pushes successful messages into a vector. At EOF it returns `ParsedSessionImport { cwd, source_title: custom_title.or(ai_title), messages, content_sha256 }` where the hash is the hex digest of the full raw file.

**Call relations**: This is the parser used by the export layer's `load_session_for_import_with_content_sha256`, and it is directly exercised by the one-pass parsing test.

*Call graph*: calls 3 internal fn (ai_title_from_record, conversation_message_from_owned_record, custom_title_from_record); called by 2 (load_session_for_import_with_content_sha256, reads_session_import_in_one_pass); 6 external calls (new, open, new, new, new, format!).


##### `custom_title_from_record`  (lines 142–144)

```
fn custom_title_from_record(record: &JsonValue) -> Option<&str>
```

**Purpose**: Extracts a non-empty trimmed custom title from a JSON record when the record type is `custom-title`.

**Data flow**: It takes a `JsonValue`, forwards to `title_from_record(record, "custom-title", "customTitle")`, and returns the resulting optional string slice.

**Call relations**: Used by both `summarize_session` and `read_session_import` as part of title precedence tracking.

*Call graph*: calls 1 internal fn (title_from_record); called by 2 (read_session_import, summarize_session).


##### `ai_title_from_record`  (lines 146–148)

```
fn ai_title_from_record(record: &JsonValue) -> Option<&str>
```

**Purpose**: Extracts a non-empty trimmed AI-generated title from a JSON record when the record type is `ai-title`.

**Data flow**: It takes a `JsonValue`, forwards to `title_from_record(record, "ai-title", "aiTitle")`, and returns the resulting optional string slice.

**Call relations**: Used alongside `custom_title_from_record` in both summary and full-import parsing.

*Call graph*: calls 1 internal fn (title_from_record); called by 2 (read_session_import, summarize_session).


##### `title_from_record`  (lines 150–156)

```
fn title_from_record(record: &'a JsonValue, record_type: &str, field: &str) -> Option<&'a str>
```

**Purpose**: Implements the common logic for matching a record type and pulling a non-empty title field from it.

**Data flow**: It reads `record["type"]` as a string, compares it to `record_type`, and if equal, reads `record[field]` as a string, trims whitespace, filters out empty results, and returns `Option<&str>`.

**Call relations**: Shared helper behind both title extractors so title parsing rules stay identical for custom and AI titles.

*Call graph*: called by 2 (ai_title_from_record, custom_title_from_record); 1 external calls (get).


##### `conversation_message_from_owned_record`  (lines 158–196)

```
fn conversation_message_from_owned_record(record: &mut JsonValue) -> Option<ConversationMessage>
```

**Purpose**: Converts a mutable JSON record into a normalized `ConversationMessage`, filtering out unsupported record kinds and extracting text from nested message content.

**Data flow**: It reads the record `type`, returns `None` unless it is `assistant` or `user`, rejects records marked `isMeta` or `isSidechain`, parses the optional RFC3339 timestamp with `parse_timestamp`, takes ownership of `message.content` via `get_mut(...).take()`, and then either accepts a non-empty string directly or delegates structured content to `extract_message_text`. It returns `ConversationMessage { role, text, timestamp }`, where role is assistant if the original type was assistant or if the extracted content consisted only of tool-result blocks; otherwise role is user.

**Call relations**: This is the core normalization helper used by both `summarize_session` and `read_session_import`.

*Call graph*: calls 1 internal fn (extract_message_text); called by 2 (read_session_import, summarize_session); 2 external calls (get, get_mut).


##### `extract_message_text`  (lines 203–248)

```
fn extract_message_text(content: &JsonValue) -> Option<ExtractedMessage>
```

**Purpose**: Flattens structured message content blocks into one displayable text string while preserving tool activity as bounded note sections.

**Data flow**: It converts the input content into a vector of blocks with `content_blocks`, initializes `parts` and an `only_tool_result` flag, then iterates each block by `type`: `text` appends non-empty text and clears the flag, `tool_use` appends `tool_call_note` and clears the flag, `tool_result` appends `tool_result_note`, `thinking` is ignored, unknown types append a placeholder string and clear the flag, and missing types are skipped. It joins non-empty parts with blank lines and returns `Some(ExtractedMessage { text, only_tool_result })` unless the final text is empty.

**Call relations**: Called only by `conversation_message_from_owned_record` when `message.content` is not a plain string.

*Call graph*: calls 3 internal fn (content_blocks, tool_call_note, tool_result_note); called by 1 (conversation_message_from_owned_record); 2 external calls (new, format!).


##### `content_blocks`  (lines 250–267)

```
fn content_blocks(content: &JsonValue) -> Vec<JsonValue>
```

**Purpose**: Normalizes message content into a vector of object-like blocks regardless of whether the source stored it as a string or an array.

**Data flow**: If `content` is a string, it wraps it into a synthetic one-element array containing a `{type: "text", text: ...}` JSON object. Otherwise it reads `content` as an array, filters to object values, clones them into a `Vec<JsonValue>`, and returns an empty vector when neither form applies.

**Call relations**: Used by `extract_message_text` to unify downstream block handling.

*Call graph*: called by 1 (extract_message_text); 3 external calls (as_array, as_str, vec!).


##### `tool_call_note`  (lines 269–303)

```
fn tool_call_note(block: &JsonValue) -> String
```

**Purpose**: Formats a `tool_use` block into a bounded textual note with explicit opening and closing tags and selected structured fields.

**Data flow**: It reads the tool `name` with fallback `unknown`, starts a line vector with `[external_agent_tool_call: name]`, then inspects `input`. For object inputs it preferentially emits `description`, `command`, and `file`/`file_path`; if none of those fields are present it serializes the whole object and truncates it to `NOTE_MAX_LEN`. For non-object inputs it serializes and truncates the raw input value. It appends the closing tag and joins lines with newlines.

**Call relations**: Called by `extract_message_text` for `tool_use` blocks so tool invocations survive import as readable annotations.

*Call graph*: called by 1 (extract_message_text); 3 external calls (get, format!, vec!).


##### `tool_result_note`  (lines 305–320)

```
fn tool_result_note(block: &JsonValue) -> String
```

**Purpose**: Formats a `tool_result` block into a bounded tagged note, distinguishing error results from normal ones.

**Data flow**: It checks `is_error` to choose either `[external_agent_tool_result]` or `[external_agent_tool_result: error]`, obtains the textual payload from `tool_result_text(block.get("content"))`, and returns either an empty-body tagged block or a block containing the truncated text limited by `TOOL_RESULT_MAX_LEN`.

**Call relations**: Called by `extract_message_text` for `tool_result` blocks.

*Call graph*: calls 1 internal fn (tool_result_text); called by 1 (extract_message_text); 2 external calls (get, format!).


##### `tool_result_text`  (lines 322–333)

```
fn tool_result_text(content: Option<&JsonValue>) -> String
```

**Purpose**: Extracts plain text from the `content` field of a tool-result block.

**Data flow**: If content is a string, it clones and returns it. If content is an array, it collects non-empty `text` fields from each item and joins them with newlines. For any other shape or missing content, it returns an empty string.

**Call relations**: Used only by `tool_result_note` to isolate the shape-specific extraction logic.

*Call graph*: called by 1 (tool_result_note); 1 external calls (new).


##### `parse_timestamp`  (lines 335–339)

```
fn parse_timestamp(timestamp: &str) -> Option<i64>
```

**Purpose**: Parses an RFC3339 timestamp string into Unix seconds.

**Data flow**: It calls `chrono::DateTime::parse_from_rfc3339`, converts a successful parse to `timestamp()`, and returns `Option<i64>`.

**Call relations**: Used by `conversation_message_from_owned_record` when normalizing message records.

*Call graph*: 1 external calls (parse_from_rfc3339).


##### `tests::reads_session_import_in_one_pass`  (lines 347–383)

```
fn reads_session_import_in_one_pass()
```

**Purpose**: Verifies that full import parsing collects cwd, title, messages, and content hash correctly while skipping malformed lines.

**Data flow**: It writes a session file containing a valid user record, an invalid JSON line, an AI title, and a custom title; calls `read_session_import`; and asserts the parsed cwd, preferred title, message count/text, and SHA-256 of the raw contents.

**Call relations**: This test directly exercises `read_session_import` and documents its tolerance for malformed lines plus custom-over-AI title precedence.

*Call graph*: calls 1 internal fn (read_session_import); 4 external calls (new, assert_eq!, json!, write).


##### `tests::converts_tool_use_blocks_to_bounded_external_agent_tags`  (lines 386–403)

```
fn converts_tool_use_blocks_to_bounded_external_agent_tags()
```

**Purpose**: Checks the exact textual rendering of a structured tool-use block.

**Data flow**: It constructs a JSON `tool_use` block with name, description, and command, calls `tool_call_note`, and asserts the returned multiline string matches the expected tagged format.

**Call relations**: This test targets the formatting helper used by `extract_message_text`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::converts_tool_result_blocks_to_bounded_external_agent_tags`  (lines 406–418)

```
fn converts_tool_result_blocks_to_bounded_external_agent_tags()
```

**Purpose**: Checks the exact textual rendering of a normal tool-result block.

**Data flow**: It constructs a JSON `tool_result` block with string content, calls `tool_result_note`, and asserts the returned tagged string matches the expected format.

**Call relations**: This test validates the non-error branch of `tool_result_note`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::converts_error_tool_result_blocks_to_bounded_external_agent_tags`  (lines 421–434)

```
fn converts_error_tool_result_blocks_to_bounded_external_agent_tags()
```

**Purpose**: Checks the exact textual rendering of an error tool-result block.

**Data flow**: It constructs a JSON `tool_result` block with `is_error: true`, calls `tool_result_note`, and asserts the returned string uses the error-tag variant.

**Call relations**: This test validates the error-label branch of `tool_result_note`.

*Call graph*: 2 external calls (assert_eq!, json!).
