# External session import persistence  `stage-21.5`

This stage is shared behind-the-scenes support for bringing in conversation history from another agent tool. It does not run the main chat loop itself. Instead, it helps the import feature answer two questions: “What is inside this outside session file?” and “Have we already imported this exact version?”

The records file is the reader and translator. It opens saved external conversation logs, parses their contents, and reshapes them into this project’s normal conversation format. It also creates short summaries, so the rest of the system can show a safe list of possible sessions before importing them.

The ledger file is the memory book. It stores a small record on disk of external session files that were already imported. If the same file content appears again, the system can skip it and avoid duplicates. If the file has changed, the ledger allows it to be imported again. Together, these parts make external imports repeatable, safe, and understandable.

## Files in this stage

### Import state tracking
The ledger persists and refreshes knowledge about previously imported external session file versions so later import work can quickly decide what is new.

### `external-agent-sessions/src/ledger.rs`

`domain_logic` · `session import detection and recording`

An external agent session is a file produced outside this system, and importing it creates or updates a Codex thread. This file acts like a receipt book for those imports. Each receipt records where the source file was, a SHA-256 content hash (a fingerprint of the file contents), which thread it became, and when the import happened. Without this ledger, the importer would have a hard time knowing whether a session file is truly new or just the same old file seen again.

The ledger is stored as a JSON file named external_agent_session_imports.json inside the Codex home directory. When the system wants to check a session, it loads that JSON file, canonicalizes the source path (turns it into its real absolute path), and hashes the current file contents. A match on both path and hash means this exact version has already been imported.

When an import finishes, this file updates the ledger. If the same path and content were recorded before, it moves that record to the end and refreshes its thread and timestamps. If it is new content, it adds a new record. This is like checking both the label and the contents of a document before deciding whether it is a duplicate.

#### Function details

##### `has_current_session_been_imported`  (lines 46–51)

```
fn has_current_session_been_imported(
    codex_home: &Path,
    source_path: &Path,
) -> io::Result<bool>
```

**Purpose**: Checks whether the current contents of a source session file have already been imported. This is used to avoid importing the same session version more than once.

**Data flow**: It receives the Codex home directory and a source file path. It loads the import ledger from disk, then asks the ledger whether that file path and its current content fingerprint are already present. It returns true or false, or an input/output error if the ledger or source file cannot be read.

**Call relations**: During validated session import preparation, prepare_validated_session_import calls this function before doing the expensive or duplicate work of importing. This function delegates the actual file reading to load_import_ledger and the detailed comparison to the ledger object.

*Call graph*: calls 1 internal fn (load_import_ledger); called by 1 (prepare_validated_session_import).


##### `record_imported_session`  (lines 54–68)

```
fn record_imported_session(
    codex_home: &Path,
    source_path: &Path,
    imported_thread_id: ThreadId,
) -> io::Result<()>
```

**Purpose**: Test-only helper that records one imported session in the same way production code records completed imports. It makes tests easier to read by hiding the details of path cleanup and hashing.

**Data flow**: It receives the Codex home directory, a source path, and the thread id that the source was imported into. It turns the source path into its canonical real path, calculates the source file hash, wraps those values into a completed-import record, and passes that list on for saving.

**Call relations**: Several tests call this helper to set up a ledger state before checking detection behavior. It hands the real work to canonical_source_path and record_completed_session_imports so tests exercise the normal recording path.

*Call graph*: calls 2 internal fn (canonical_source_path, record_completed_session_imports); called by 4 (detects_sessions_in_batches, redetects_sessions_when_source_contents_change_after_import, skips_already_imported_current_session_versions, skips_session_that_was_already_imported); 1 external calls (vec!).


##### `record_completed_session_imports`  (lines 70–101)

```
fn record_completed_session_imports(
    codex_home: &Path,
    imports: Vec<CompletedExternalAgentSessionImport>,
) -> io::Result<()>
```

**Purpose**: Writes completed imports into the ledger after one or more external sessions have been imported. It keeps the ledger up to date so future scans know what has already been handled.

**Data flow**: It receives the Codex home directory and a list of completed imports. If the list is empty, it does nothing. Otherwise it loads the existing ledger, gets the current time, adds or refreshes one record per import, captures the source file's modified time when possible, and saves the updated ledger back to disk.

**Call relations**: The test helper record_imported_session calls this for single-session setup, and production import code can call it after successful imports. It relies on load_import_ledger to get the old receipt book, session_modified_at to add file timing details, and save_import_ledger to persist the new receipt book.

*Call graph*: calls 3 internal fn (load_import_ledger, save_import_ledger, session_modified_at); called by 1 (record_imported_session); 1 external calls (now_unix_seconds).


##### `ImportedExternalAgentSessionLedger::source_states`  (lines 104–116)

```
fn source_states(&self) -> HashMap<&Path, ImportedSourceState>
```

**Purpose**: Builds a quick lookup table showing the latest known timing state for each imported source path. This helps other code compare recently seen files with what the ledger remembers.

**Data flow**: It reads the ledger's list of records. For each record, it stores the source path as a key and the remembered source modified time plus import time as the value. The result is a map from source paths to their saved state.

**Call relations**: This method is part of the ledger's public-in-this-module toolkit. Detection code can use it after loading the ledger when it needs a compact view of known source files instead of scanning the full list repeatedly.

*Call graph*: 1 external calls (new).


##### `ImportedExternalAgentSessionLedger::contains_current_source`  (lines 118–134)

```
fn contains_current_source(&self, source_path: &Path) -> io::Result<bool>
```

**Purpose**: Answers the key duplicate-detection question: has this exact file version already been imported? It checks both the real path and the current file contents.

**Data flow**: It reads the ledger records and receives a source path. If there are no records, or no record for that canonical path, it returns false. If the path exists in the ledger, it hashes the current file contents and returns true only if a record has both the same path and the same hash.

**Call relations**: has_current_session_been_imported loads the ledger and then uses this method to make the final yes-or-no decision. The method depends on canonical_source_path to normalize the path and session_content_sha256 to compute the content fingerprint.

*Call graph*: calls 2 internal fn (canonical_source_path, session_content_sha256).


##### `ImportedExternalAgentSessionLedger::refresh_current_source`  (lines 136–160)

```
fn refresh_current_source(
        &mut self,
        source_path: &Path,
        source_modified_at: i64,
    ) -> io::Result<bool>
```

**Purpose**: Refreshes the ledger entry for a source file when the current contents are already known. This updates the import time and remembered file modified time without creating a new duplicate record.

**Data flow**: It receives a source path and a modified-time value. It canonicalizes the path, checks that the path exists in the ledger, hashes the current file contents, and looks for the most recent matching path-and-hash record. If found, it removes that record, updates its timestamps, appends it to the end, and returns true. If no matching current version is found, it returns false.

**Call relations**: This method is used by ledger-aware detection flows that want to mark an already-imported source as freshly seen. It uses canonical_source_path and session_content_sha256 to make sure it is refreshing the exact current file version, and it uses now_unix_seconds for the new import timestamp.

*Call graph*: calls 2 internal fn (canonical_source_path, session_content_sha256); 1 external calls (now_unix_seconds).


##### `load_import_ledger`  (lines 163–180)

```
fn load_import_ledger(
    codex_home: &Path,
) -> io::Result<ImportedExternalAgentSessionLedger>
```

**Purpose**: Reads the import ledger JSON file from disk and turns it into the in-memory ledger object. If the file does not exist yet, it starts with an empty ledger.

**Data flow**: It receives the Codex home directory, builds the path to external_agent_session_imports.json, and tries to read it as text. Missing file becomes an empty ledger. Existing text is parsed as JSON. Bad JSON becomes an invalid-data input/output error.

**Call relations**: Detection and recording flows call this whenever they need the current receipt book. It is used by detect_recent_sessions, has_current_session_been_imported, and record_completed_session_imports, and it uses import_ledger_path to agree on the ledger file location.

*Call graph*: calls 1 internal fn (import_ledger_path); called by 3 (detect_recent_sessions, has_current_session_been_imported, record_completed_session_imports); 3 external calls (default, read_to_string, from_str).


##### `save_import_ledger`  (lines 182–190)

```
fn save_import_ledger(
    codex_home: &Path,
    ledger: &ImportedExternalAgentSessionLedger,
) -> io::Result<()>
```

**Purpose**: Writes the in-memory ledger back to disk as readable JSON. This is what makes import history survive after the process exits.

**Data flow**: It receives the Codex home directory and a ledger object. It makes sure the Codex home directory exists, converts the ledger to pretty-printed JSON bytes, and writes those bytes to the ledger file path.

**Call relations**: After import detection or recording changes the ledger, detect_recent_sessions and record_completed_session_imports call this to persist those changes. It uses import_ledger_path so it writes to the same place that load_import_ledger reads from.

*Call graph*: calls 1 internal fn (import_ledger_path); called by 2 (detect_recent_sessions, record_completed_session_imports); 3 external calls (create_dir_all, write, to_vec_pretty).


##### `import_ledger_path`  (lines 192–194)

```
fn import_ledger_path(codex_home: &Path) -> PathBuf
```

**Purpose**: Builds the full filesystem path to the ledger file inside the Codex home directory. This keeps the filename choice in one place.

**Data flow**: It receives the Codex home directory path and appends external_agent_session_imports.json to it. It returns that combined path.

**Call relations**: Both load_import_ledger and save_import_ledger call this so reading and writing always refer to the same ledger file.

*Call graph*: called by 2 (load_import_ledger, save_import_ledger); 1 external calls (join).


##### `canonical_source_path`  (lines 196–198)

```
fn canonical_source_path(path: &Path) -> io::Result<PathBuf>
```

**Purpose**: Turns a source file path into its real, canonical filesystem path. This avoids treating different spellings of the same file as different sources.

**Data flow**: It receives a path, asks the operating system to resolve it, and returns the canonical path. If the path does not exist or cannot be resolved, it returns an input/output error.

**Call relations**: The duplicate-checking and refresh methods use this before comparing paths, and the test helper uses it before recording. This makes ledger entries consistent even if callers pass relative paths or paths with symbolic links.

*Call graph*: called by 3 (contains_current_source, refresh_current_source, record_imported_session); 1 external calls (canonicalize).


##### `session_content_sha256`  (lines 200–213)

```
fn session_content_sha256(path: &Path) -> io::Result<String>
```

**Purpose**: Computes a SHA-256 hash for a session file, which serves as a stable fingerprint of its contents. If even a small part of the file changes, the fingerprint changes.

**Data flow**: It receives a file path, opens the file, reads it in 64 KB chunks, feeds each chunk into a SHA-256 hasher, and returns the final hash as a lowercase hexadecimal string. Reading or opening failures become input/output errors.

**Call relations**: contains_current_source and refresh_current_source use this when they need to know whether the file currently on disk matches a ledger record. It is central to distinguishing 'same file path, same contents' from 'same file path, changed contents.'

*Call graph*: called by 2 (contains_current_source, refresh_current_source); 3 external calls (open, new, format!).


##### `session_modified_at`  (lines 215–221)

```
fn session_modified_at(path: &Path) -> io::Result<Option<i64>>
```

**Purpose**: Reads the source file's last modified time so the ledger can remember when the file itself changed. This gives later detection code another clue about whether a source is fresh or stale.

**Data flow**: It receives a file path, reads the file metadata, asks for the modified time, measures that time since the Unix epoch, and tries to store it as an i64 number of nanoseconds. It returns that value inside an option, or None if the timestamp cannot be represented that way.

**Call relations**: record_completed_session_imports calls this while writing import records. If the timestamp is available, it is stored alongside the content hash and import time; if not, recording can still continue without that optional field.

*Call graph*: called by 1 (record_completed_session_imports); 1 external calls (metadata).


### Session record normalization
The record reader parses external-agent JSONL sessions into summaries or full message streams and normalizes their content into Codex-ready form.

### `external-agent-sessions/src/records.rs`

`io_transport` · `session discovery and import`

External agent sessions are stored as line-by-line JSON records, often called JSONL: each line is one small JSON object. This file is the translator for those records. Without it, the project could not reliably discover old external sessions, choose a useful title for them, or import their messages into the local conversation model.

The main flow is simple. First, the file opens a session log and reads it one line at a time, so even large logs do not need to be loaded all at once. It ignores blank lines and broken JSON lines rather than failing the whole import. It looks for the working directory, title records, timestamps, and real user or assistant messages. Meta records and sidechain records are skipped because they are not part of the main conversation.

Messages can be plain text or structured blocks. Structured blocks are flattened into readable text. Tool calls and tool results are wrapped in clear tags, like labels on a package, so later code can see that this text came from an external tool interaction. Long tool notes are shortened to protect the imported conversation from huge outputs. The file can either produce a lightweight session summary or a fuller import result with all parsed messages and a SHA-256 content hash, which is a fingerprint used to recognize the exact file contents.

#### Function details

##### `summarize_session`  (lines 33–94)

```
fn summarize_session(path: &Path) -> io::Result<Option<SessionSummary>>
```

**Purpose**: Reads a session file just enough to decide whether it is a usable conversation and to build a short summary for listing or migration. It finds the working directory, best available title, and latest message time.

**Data flow**: It receives a file path, opens the file, then reads each line as a possible JSON record. From those records it gathers the first working directory, any custom or AI-generated title, user/assistant messages, and message timestamps. It returns no summary if the file has no working directory, no usable messages, or no timestamp; otherwise it returns a SessionSummary containing the latest timestamp and migration information.

**Call relations**: This is a top-level reader for quick scanning. As it walks through records, it asks custom_title_from_record and ai_title_from_record to recognize title records, and conversation_message_from_owned_record to turn message records into local ConversationMessage values. When the first user message has no better title, it hands that text to summarize_for_label to make a readable label.

*Call graph*: calls 3 internal fn (ai_title_from_record, conversation_message_from_owned_record, custom_title_from_record); 4 external calls (new, open, to_path_buf, summarize_for_label).


##### `read_session_import`  (lines 96–140)

```
fn read_session_import(path: &Path) -> io::Result<ParsedSessionImport>
```

**Purpose**: Fully reads an external session file for import. It collects the parsed messages, the best source title, the working directory if present, and a hash of the exact file contents.

**Data flow**: It receives a file path, opens the file, and reads it line by line. Each raw line is fed into a SHA-256 hasher before parsing, so the final result reflects the exact original content. Valid JSON records may add a working directory, titles, or conversation messages; invalid and blank lines are skipped. It returns a ParsedSessionImport with the collected data and the final hexadecimal content hash.

**Call relations**: This is used by load_session_for_import_with_content_sha256 when the system actually imports a session, and by its test to prove the one-pass behavior. During the read, it delegates title recognition to custom_title_from_record and ai_title_from_record, and message conversion to conversation_message_from_owned_record.

*Call graph*: calls 3 internal fn (ai_title_from_record, conversation_message_from_owned_record, custom_title_from_record); called by 2 (load_session_for_import_with_content_sha256, reads_session_import_in_one_pass); 6 external calls (new, open, new, new, new, format!).


##### `custom_title_from_record`  (lines 142–144)

```
fn custom_title_from_record(record: &JsonValue) -> Option<&str>
```

**Purpose**: Checks whether a JSON record is a user-supplied custom title. Custom titles are preferred because they usually reflect what the user intentionally named the session.

**Data flow**: It receives one JSON record and asks title_from_record to look for a record of type custom-title with a customTitle field. If the field exists after trimming whitespace and is not empty, it returns that title text; otherwise it returns nothing.

**Call relations**: Both summarize_session and read_session_import call this while scanning records. It is a thin, named wrapper around title_from_record so the title priority rules stay easy to read.

*Call graph*: calls 1 internal fn (title_from_record); called by 2 (read_session_import, summarize_session).


##### `ai_title_from_record`  (lines 146–148)

```
fn ai_title_from_record(record: &JsonValue) -> Option<&str>
```

**Purpose**: Checks whether a JSON record contains an AI-generated title. This gives the importer a useful fallback title when there is no custom title.

**Data flow**: It receives one JSON record and asks title_from_record to look for a record of type ai-title with an aiTitle field. If the value is present, trimmed, and non-empty, that title is returned; otherwise the result is empty.

**Call relations**: summarize_session and read_session_import call this beside custom_title_from_record while walking through the file. It relies on title_from_record for the shared title-extraction rules.

*Call graph*: calls 1 internal fn (title_from_record); called by 2 (read_session_import, summarize_session).


##### `title_from_record`  (lines 150–156)

```
fn title_from_record(record: &'a JsonValue, record_type: &str, field: &str) -> Option<&'a str>
```

**Purpose**: Contains the common rule for pulling a title out of a JSON record. It prevents empty or whitespace-only titles from being treated as real names.

**Data flow**: It receives a JSON record, the expected record type, and the field name where the title should live. It checks that the record type matches, reads the requested field as text, trims spaces, rejects empty results, and returns the cleaned title if all checks pass.

**Call relations**: custom_title_from_record and ai_title_from_record both call this so they do not duplicate the same checking logic. It sits underneath the higher-level session readers as a small title filter.

*Call graph*: called by 2 (ai_title_from_record, custom_title_from_record); 1 external calls (get).


##### `conversation_message_from_owned_record`  (lines 158–196)

```
fn conversation_message_from_owned_record(record: &mut JsonValue) -> Option<ConversationMessage>
```

**Purpose**: Turns one external JSON message record into the project’s ConversationMessage type. It filters out records that are not real main-thread user or assistant messages.

**Data flow**: It receives a mutable JSON record. It first checks that the type is user or assistant, then skips meta and sidechain records. It reads the timestamp if one is present, takes the message content out of the JSON, and either uses plain text directly or asks extract_message_text to flatten structured content. It returns a ConversationMessage with a role, text, and optional timestamp, or nothing if the record is not usable.

**Call relations**: summarize_session uses this to know whether a file contains messages and to find timestamps and possible label text. read_session_import uses it to build the imported message list. For structured content, it hands the hard part to extract_message_text.

*Call graph*: calls 1 internal fn (extract_message_text); called by 2 (read_session_import, summarize_session); 2 external calls (get, get_mut).


##### `extract_message_text`  (lines 203–248)

```
fn extract_message_text(content: &JsonValue) -> Option<ExtractedMessage>
```

**Purpose**: Converts structured message content into a single readable text string. This is needed because external agent messages can contain text, tool calls, tool results, and other block types rather than just one plain sentence.

**Data flow**: It receives JSON content and first turns it into a list of content blocks using content_blocks. It walks those blocks, keeping normal text, converting tool calls with tool_call_note, converting tool results with tool_result_note, ignoring hidden thinking blocks, and marking unsupported block types with a clear warning. It joins the non-empty pieces with blank lines and returns the text plus a flag saying whether the message contained only tool results.

**Call relations**: conversation_message_from_owned_record calls this whenever the message content is not already a simple string. It coordinates the smaller block helpers so imported structured messages become readable local messages.

*Call graph*: calls 3 internal fn (content_blocks, tool_call_note, tool_result_note); called by 1 (conversation_message_from_owned_record); 2 external calls (new, format!).


##### `content_blocks`  (lines 250–267)

```
fn content_blocks(content: &JsonValue) -> Vec<JsonValue>
```

**Purpose**: Normalizes message content into a list of object-shaped blocks. This lets later code treat plain strings and arrays of blocks in a consistent way.

**Data flow**: It receives a JSON value. If the value is a string, it wraps it in a simple text block. If it is an array, it keeps only the items that are JSON objects and clones them into a new list. Anything else becomes an empty list.

**Call relations**: extract_message_text calls this before examining individual message parts. It acts like a sorter at the start of an assembly line, making sure the next stage sees a predictable shape.

*Call graph*: called by 1 (extract_message_text); 3 external calls (as_array, as_str, vec!).


##### `tool_call_note`  (lines 269–303)

```
fn tool_call_note(block: &JsonValue) -> String
```

**Purpose**: Turns an external tool-use block into a short, tagged note that can be stored as conversation text. The tag makes it clear that this part of the message represents a tool call, not ordinary chat.

**Data flow**: It receives one JSON tool-use block. It reads the tool name, then tries to extract friendly fields such as description, command, and file path from the tool input. If no friendly fields are available, it includes a shortened JSON version of the input. It returns a multi-line note wrapped in external_agent_tool_call start and end tags.

**Call relations**: extract_message_text calls this when it sees a tool_use content block. The produced note is inserted into the flattened message text alongside normal text and tool results.

*Call graph*: called by 1 (extract_message_text); 3 external calls (get, format!, vec!).


##### `tool_result_note`  (lines 305–320)

```
fn tool_result_note(block: &JsonValue) -> String
```

**Purpose**: Turns an external tool-result block into a tagged note, including a special label when the tool result represents an error. This keeps tool output understandable after import.

**Data flow**: It receives one JSON tool-result block. It chooses a normal or error tag, asks tool_result_text to pull out readable result text, shortens that text if needed, and returns a multi-line note wrapped in external_agent_tool_result tags. If there is no readable content, it returns just the opening and closing tags.

**Call relations**: extract_message_text calls this for tool_result blocks. It delegates the details of reading result content to tool_result_text, then formats the result for inclusion in the imported message.

*Call graph*: calls 1 internal fn (tool_result_text); called by 1 (extract_message_text); 2 external calls (get, format!).


##### `tool_result_text`  (lines 322–333)

```
fn tool_result_text(content: Option<&JsonValue>) -> String
```

**Purpose**: Extracts plain text from the content field of a tool result. It supports both simple string results and arrays of smaller text items.

**Data flow**: It receives an optional JSON value. If the value is a string, it returns that string. If it is an array, it collects each item’s non-empty text field and joins them with newlines. If the content is missing or in another shape, it returns an empty string.

**Call relations**: tool_result_note calls this before adding tags and length limits. This keeps content extraction separate from presentation.

*Call graph*: called by 1 (tool_result_note); 1 external calls (new).


##### `parse_timestamp`  (lines 335–339)

```
fn parse_timestamp(timestamp: &str) -> Option<i64>
```

**Purpose**: Converts an RFC 3339 timestamp string, such as 2026-06-03T12:00:00Z, into a Unix timestamp in seconds. A Unix timestamp is a standard count of seconds since January 1, 1970.

**Data flow**: It receives a timestamp string. It asks the date-time library to parse the string using RFC 3339 rules, and if that succeeds it returns the timestamp as seconds. If parsing fails, it returns nothing.

**Call relations**: conversation_message_from_owned_record uses this when it finds a timestamp field on a message record. The resulting number is later used by summarize_session to choose the latest message time.

*Call graph*: 1 external calls (parse_from_rfc3339).


##### `tests::reads_session_import_in_one_pass`  (lines 347–383)

```
fn reads_session_import_in_one_pass()
```

**Purpose**: Tests that read_session_import can read a mixed session file correctly while computing the hash of the original contents. It also checks that custom titles override AI titles.

**Data flow**: The test creates a temporary session file containing a valid user message, an invalid line, an AI title, and a custom title. It calls read_session_import, then checks the parsed working directory, chosen title, message text, and SHA-256 hash. The before state is a small fake file; the after state is proof that the parser extracted the intended data.

**Call relations**: This test directly calls read_session_import as a safety check for the import path. It uses JSON-building and file-writing helpers to create realistic input without needing an actual external session.

*Call graph*: calls 1 internal fn (read_session_import); 4 external calls (new, assert_eq!, json!, write).


##### `tests::converts_tool_use_blocks_to_bounded_external_agent_tags`  (lines 386–403)

```
fn converts_tool_use_blocks_to_bounded_external_agent_tags()
```

**Purpose**: Tests that a tool-use block becomes the expected tagged note. This protects the readable format used for imported external tool calls.

**Data flow**: The test builds a fake tool_use JSON block with a tool name, description, and command. It compares the produced note against the exact expected multi-line string. The result confirms that key tool-call details are preserved in a predictable form.

**Call relations**: Although the call graph only records JSON construction and assertion helpers here, the test is meant to exercise tool_call_note. It supports the larger extract_message_text flow, which relies on that formatting.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::converts_tool_result_blocks_to_bounded_external_agent_tags`  (lines 406–418)

```
fn converts_tool_result_blocks_to_bounded_external_agent_tags()
```

**Purpose**: Tests that a normal tool-result block is converted into the expected tagged note. This ensures imported tool output remains clearly marked.

**Data flow**: The test builds a fake tool_result JSON block containing a string result. It checks that the note uses the normal external_agent_tool_result tag and includes the result text between the opening and closing tags.

**Call relations**: Although the call graph lists only helper macro calls, the test is intended to verify tool_result_note. That helper is used by extract_message_text when flattening structured external messages.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::converts_error_tool_result_blocks_to_bounded_external_agent_tags`  (lines 421–434)

```
fn converts_error_tool_result_blocks_to_bounded_external_agent_tags()
```

**Purpose**: Tests that an error tool-result block is labeled as an error in the imported note. This matters because failed tool output should not look the same as successful output.

**Data flow**: The test builds a fake tool_result JSON block with is_error set to true and content saying the command failed. It checks that the formatted note uses the error label and includes the failure text.

**Call relations**: This test protects the error branch of tool_result_note, which extract_message_text depends on when importing structured tool-result blocks.

*Call graph*: 2 external calls (assert_eq!, json!).
