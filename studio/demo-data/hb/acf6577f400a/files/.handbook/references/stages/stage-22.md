# Cross-cutting utility and support libraries  `stage-22` (cross-cutting infrastructure)

This stage is the shared toolbox used across the whole system, not one user-facing feature. It supports startup, the main work loop, tool execution, display, and build time. Path, filesystem, environment, terminal, and sandbox utilities give safe, portable ways to name files, watch changes, copy text, find programs, and run restricted commands. Text helpers clean, parse, shorten, wrap, style, and render output as it streams in. Configuration, metadata, auth, and network helpers turn user settings, login data, schemas, and proxy rules into safe internal forms. Shell, command, Git, plugin, and execution utilities run external programs, inspect repositories, package plugins, and manage process output. Async, image, sleep, cache, and summary helpers smooth long-running work and terminal display. Build scripts prepare platform-specific pieces before compilation.

The direct files are small entry points and shared vocabularies: core utility helpers, module “front doors” for core, CLI, and plugin utilities, structured errors for execution policy and Git failures, a fuzzy matcher for search-style highlighting, and common hook-event rules so hooks behave consistently.

## Sub-stages

- [Path, filesystem, environment, and sandbox support utilities](stage-22.1.md) `stage-22.1` — 31 files
- [Text, parsing, truncation, and rendering helpers](stage-22.2.md) `stage-22.2` — 57 files
- [Configuration, metadata, schema, auth, and network glue utilities](stage-22.3.md) `stage-22.3` — 26 files
- [Shell, command, git, plugin, and execution support utilities](stage-22.4.md) `stage-22.4` — 24 files
- [Async primitives, image handling, and miscellaneous small support libraries](stage-22.5.md) `stage-22.5` — 25 files
- [Build scripts and build-time asset/platform glue](stage-22.6.md) `stage-22.6` — 4 files

## Files in this stage

### Core utility surfaces
These files define the main shared utility entry points and general-purpose helpers used broadly across the codebase.

### `core/src/util.rs`

`util` · `cross-cutting`

This is a grab-bag of practical helpers that many parts of the program can reuse instead of rewriting the same small rules. One important job is adding structured feedback tags: small named pieces of information that can later be attached to uploaded feedback. For authentication failures, the file gathers details such as request IDs or Cloudflare ray IDs and records them in a consistent shape, using empty strings when a detail is missing so the feedback system receives predictable fields.

It also provides a retry delay helper called `backoff`. When something fails and the program wants to try again, this function waits longer after each attempt, with a little random variation. That is like several people stepping away from a crowded doorway for slightly different amounts of time, so they do not all rush back at once.

The file includes `error_or_panic`, which is deliberately stricter during development: in debug builds it crashes immediately so programmers notice a bug, while in release builds it logs an error instead of stopping the whole program. Finally, it contains small cleanup helpers for turning relative paths into full paths and trimming thread names so blank names are treated as absent.

#### Function details

##### `Auth401FeedbackSnapshot::from_optional_fields`  (lines 44–56)

```
fn from_optional_fields(
        request_id: Option<&'a str>,
        cf_ray: Option<&'a str>,
        error: Option<&'a str>,
        error_code: Option<&'a str>,
    ) -> Self
```

**Purpose**: This builds a small snapshot of details from an authentication failure, especially an HTTP 401 response, which means the server says the request is unauthorized. It makes missing values safe and predictable by replacing each missing field with an empty string.

**Data flow**: It receives four optional text values: request ID, Cloudflare ray ID, error text, and error code. For each one, it keeps the provided text if present, or substitutes an empty string if it is missing. It returns an `Auth401FeedbackSnapshot` that can be logged without repeatedly checking for missing values.

**Call relations**: It is used inside `emit_feedback_auth_recovery_tags` when the system is preparing feedback metadata about an authorization recovery attempt. Its job is to tidy the raw optional fields before they are handed to the feedback tagging macro.

*Call graph*: called by 1 (emit_feedback_auth_recovery_tags).


##### `emit_feedback_auth_recovery_tags`  (lines 59–83)

```
fn emit_feedback_auth_recovery_tags(
    auth_recovery_mode: &str,
    auth_recovery_phase: &str,
    auth_recovery_outcome: &str,
    auth_request_id: Option<&str>,
    auth_cf_ray: Option<&str>,
```

**Purpose**: This records structured feedback information about an authentication recovery attempt. It helps later investigators understand what recovery mode was used, what phase it reached, what the outcome was, and what details came from the original unauthorized response.

**Data flow**: It receives plain text labels for the recovery mode, phase, and outcome, plus optional details from the unauthorized authentication response. It first turns the optional response details into a clean `Auth401FeedbackSnapshot`. Then it emits all of these values as feedback tags, which are named fields that the tracing and feedback system can collect.

**Call relations**: It is called by `handle_unauthorized` when the program has encountered an authentication failure and is trying to recover. It relies on `Auth401FeedbackSnapshot::from_optional_fields` to normalize missing details, then hands the final named values to the `feedback_tags!` macro so the feedback pipeline can capture them.

*Call graph*: calls 1 internal fn (from_optional_fields); called by 1 (handle_unauthorized); 1 external calls (feedback_tags!).


##### `backoff`  (lines 85–90)

```
fn backoff(attempt: u64) -> Duration
```

**Purpose**: This calculates how long to wait before trying an operation again after a failure. It increases the delay with each attempt and adds a small random wobble so repeated retries do not all happen at exactly the same moment.

**Data flow**: It receives an attempt number. It turns that into a growing delay that starts around 200 milliseconds and roughly doubles each time, then multiplies it by a random factor between 0.9 and 1.1. It returns the final wait time as a `Duration`, which is Rust’s standard way to represent a span of time.

**Call relations**: Many retry paths call this when they need a sensible pause before trying again, including reconnect logic, authentication recovery, request-failure retries, compact-task retries, guardian retries, and retryable streaming response errors. It does not perform the waiting itself; it only tells the caller how long the next wait should be.

*Call graph*: called by 6 (next_reconnect_delay, handle_unauthorized, retry_after_request_failure, run_compact_task_inner_impl, wait_before_guardian_retry, handle_retryable_response_stream_error); 2 external calls (from_millis, rng).


##### `error_or_panic`  (lines 92–98)

```
fn error_or_panic(message: impl std::string::ToString)
```

**Purpose**: This reports a serious internal problem differently depending on how the program was built. During development it stops immediately with a panic, while in normal release use it logs an error so the program can keep running if possible.

**Data flow**: It receives a message that can be turned into text. If the program was built with debug checks enabled, it converts the message to a string and panics with it, which stops the current execution path. Otherwise it converts the message to a string and writes it as an error log entry.

**Call relations**: It is called from places that detect unexpected internal states, such as missing tool outputs, draining in-flight work, running a turn, sampling requests, or building tool data. Those callers use it as a shared policy: be loud and crash early in development, but log the problem in production.

*Call graph*: called by 5 (ensure_call_outputs_present, drain_in_flight, run_turn, try_run_sampling_request, from_tools); 3 external calls (cfg!, error!, panic!).


##### `resolve_path`  (lines 100–106)

```
fn resolve_path(base: &Path, path: &PathBuf) -> PathBuf
```

**Purpose**: This turns a path into the right usable path based on a base directory. If the path is already absolute, it leaves it alone; if it is relative, it attaches it to the base path.

**Data flow**: It receives a base path and another path. It checks whether the second path is absolute, meaning it already starts from the filesystem root or drive root. If so, it returns a copy of that path; otherwise, it joins the base and relative path and returns the combined result.

**Call relations**: This helper stands on its own in this file. Other code can call it whenever it accepts a user-provided or configuration-provided path and needs to interpret relative paths consistently against a known base directory.

*Call graph*: 3 external calls (join, clone, is_absolute).


##### `normalize_thread_name`  (lines 109–116)

```
fn normalize_thread_name(name: &str) -> Option<String>
```

**Purpose**: This cleans up a thread name by removing extra spaces at the beginning and end. If nothing meaningful remains, it treats the name as absent instead of keeping an empty string.

**Data flow**: It receives a text string. It trims surrounding whitespace, then checks whether the result is empty. If it is empty, it returns `None`; otherwise, it returns the cleaned name as a new string.

**Call relations**: It is called by `thread_set_name_response_inner` when processing a request or response related to setting a thread name. That caller can then distinguish between a real name and a blank or whitespace-only value without repeating the trimming rule.

*Call graph*: called by 1 (thread_set_name_response_inner).


### `core/src/utils/mod.rs`

`util` · `cross-cutting`

This is a small module index file. In Rust, a `mod.rs` file often acts like a table of contents for a folder: it lists which pieces of code inside that folder are available to the rest of the project. Here, it exposes `path_utils`, which likely contains helper code for working with file paths. Without this line, other parts of the `core` crate would not be able to refer to `utils::path_utils`, even if the actual path utility file existed on disk. There is no runtime behavior here. Nothing is calculated, opened, saved, or changed when the program runs because of this file directly. Its job is structural: it helps organize the codebase and makes the path-related helper module visible in the project’s module tree.


### `utils/cli/src/lib.rs`

`util` · `startup / CLI argument setup`

This file does not contain the command-line logic itself. Instead, it acts like an index desk at the entrance of a library: it points to the shelves where the real material lives, and it makes the most important items easy to pick up from one place.

The crate is split into focused modules for things like approval-mode arguments, sandbox-mode arguments, configuration overrides, environment display formatting, resume commands, and shared command-line options. This file declares those modules so Rust includes them in the crate. It then re-exports selected types and functions, which means outside code can import them from this crate’s top level instead of needing to know the internal file layout.

That matters because command-line code is often used by several binaries or subcommands. Without this file, every caller would need to know which internal module contains each helper, making the project harder to change. With this file, the crate has a stable public face: callers can ask for `SharedCliOptions`, `CliConfigOverrides`, `SandboxModeCliArg`, or `resume_command` from one predictable place while the internal organization can stay tidy.


### `utils/plugins/src/lib.rs`

`data_model` · `cross-cutting`

This file acts like the reception desk for the plugin utilities crate. Other parts of the project can import this crate and get access to common plugin helpers without needing to know the internal file layout. The helpers it exposes are about three main jobs: finding plugin manifest files, interpreting plugin-related names and paths, and supporting MCP connector code. A plugin manifest is the small file that describes a plugin, so being able to find it reliably is important; without that, the rest of the system could not discover or identify plugins in a consistent way. The file also defines `PluginSkillRoot`, a small data shape that ties together three facts: where a skill lives on disk, which plugin it belongs to, and where that plugin starts. The paths use `AbsolutePathBuf`, meaning they are full paths rather than paths relative to the current folder, which helps avoid confusion when code runs from different working directories. In short, this file does not do the searching itself; it gathers and exposes the pieces that other code uses to work with plugins safely and consistently.


### Shared error vocabularies
These files establish reusable error types that give supporting crates consistent failure models.

### `execpolicy-legacy/src/error.rs`

`data_model` · `cross-cutting`

This file is the project’s list of things that can go wrong while checking whether a program invocation is allowed. Instead of returning vague text like “bad input,” the code can return a specific error such as “this option is unknown,” “this required option is missing,” or “this file is outside the allowed readable folders.” That matters because execution policy decisions need to be explainable and safe: if a command is blocked, callers need to know exactly why.

The central piece is the `Error` enum, which is a fixed menu of possible failures. Each error carries the details needed to understand it, such as the program name, the option that caused trouble, the arguments that were unexpected, or the path that could not be checked. There is also a `Result<T>` shortcut, meaning “either a successful value of type `T`, or one of these errors.”

The errors cover several areas: command-line parsing, argument pattern matching, safety checks for tools like `sed`, and file path permission checks. The file also marks errors as serializable, meaning they can be turned into a structured format such as JSON. That is useful for reporting errors to another process or displaying them consistently. Think of this file as the system’s official rejection slip template: every denied action gets a known reason and the facts needed to explain it.


### `git-utils/src/errors.rs`

`data_model` · `cross-cutting`

This file is the project’s shared vocabulary for failures in its git-related tools. When code runs git commands, reads command output, checks repository paths, or walks through files, many things can go wrong. Instead of returning vague failures, the code can return a `GitToolingError`, which says what kind of problem happened and carries the details needed to explain it.

The enum is like a set of labeled envelopes for bad news. One envelope is for a git command that exited unsuccessfully, including the command, exit status, and error text. Another is for git output that could not be read as UTF-8 text, which matters because Rust strings must be valid UTF-8. Several variants protect repository boundaries: they report when a path is not inside a git repository, is not relative to the repository root, or tries to escape that root. That helps prevent the tooling from accidentally reading or writing outside the intended checkout.

The file also wraps lower-level errors from path handling, directory walking, and normal file input/output. The `thiserror` crate is used to turn these variants into readable error messages and to preserve original causes where useful. Without this file, callers would have to juggle many unrelated error types, making failures harder to report and harder to handle consistently.


### Event and matching helpers
These files provide reusable matching and normalization logic, from generic fuzzy filtering to hook-event-specific conventions.

### `utils/fuzzy-match/src/lib.rs`

`util` · `cross-cutting, during fuzzy filtering or search ranking`

This file solves a common search-box problem. If a user types “fb”, they may expect it to match “FooBar” because the letters appear in that order. The main function, `fuzzy_match`, does that kind of loose matching without requiring the text to be side by side. It is case-insensitive, so “foo” can match “Foo”. It also returns the original character positions that matched, which lets the caller highlight the matching letters in the displayed text.

A key detail is Unicode text. Some characters change length when lowercased. For example, Turkish “İ” becomes two lowercase pieces: “i” plus a dot mark. The matcher searches in a lowercased copy, but keeps a map back to the original string’s character positions. This is like making a photocopy with notes saying where every copied mark came from in the original page.

The score is smaller when the matched letters are closer together, so “abc” ranks better than “a-b-c”. Matches that start at the beginning get a strong bonus, because users usually expect prefix matches to rank high. The rest of the file is a focused test suite that checks ordinary ASCII text, case-insensitive matching, empty searches, scoring choices, and tricky Unicode cases.

#### Function details

##### `fuzzy_match`  (lines 12–69)

```
fn fuzzy_match(haystack: &str, needle: &str) -> Option<(Vec<usize>, i32)>
```

**Purpose**: Checks whether all characters from `needle` appear in order inside `haystack`, ignoring letter case. If they do, it returns the original character positions to highlight and a score where a lower number means a better match.

**Data flow**: It receives a larger string and a search string. It first treats an empty search as a special match with no positions and the worst possible score. Otherwise, it lowercases the larger string while remembering where each lowercased character came from in the original text, then lowercases the search string. It walks through the lowercased larger string from left to right, looking for each search character in order. If any character cannot be found, it returns no match. If all are found, it converts the matched positions back to original character indexes, removes duplicates caused by Unicode lowercase expansion, computes how spread out the match is, gives a large bonus for starting at the beginning, and returns the positions plus the score.

**Call relations**: This is the central utility in the file. The test functions call on it with different kinds of input to prove the matcher returns the expected positions, scores, or no-match result. Internally it relies only on standard vector allocation helpers to build its temporary lists.

*Call graph*: called by 7 (ascii_basic_indices, case_insensitive_matching_basic, empty_needle_matches_with_max_score_and_no_indices, indices_are_deduped_for_multichar_lowercase_expansion, prefer_contiguous_match_over_spread, start_of_string_bonus_applies, unicode_dotted_i_istanbul_highlighting); 2 external calls (new, with_capacity).


##### `tests::ascii_basic_indices`  (lines 76–84)

```
fn ascii_basic_indices()
```

**Purpose**: Confirms that the matcher finds simple ASCII letters in order and reports the correct original positions. It also checks the score for a short spread-out match that starts at the beginning.

**Data flow**: It gives `fuzzy_match` the text `hello` and the search `hl`. It expects a successful result, then checks that the matched positions are `0` and `2` and that the score reflects one skipped character plus the start-of-string bonus. If there is no match, the test deliberately fails.

**Call relations**: This test is one of the basic safety checks for `fuzzy_match`. It calls the matcher directly, then uses test assertions to make sure the returned positions and score match the intended behavior.

*Call graph*: calls 1 internal fn (fuzzy_match); 2 external calls (assert_eq!, panic!).


##### `tests::unicode_dotted_i_istanbul_highlighting`  (lines 87–95)

```
fn unicode_dotted_i_istanbul_highlighting()
```

**Purpose**: Checks that matching works for Turkish capital dotted I, a Unicode character whose lowercase form expands into more than one character. This matters because highlighting must point back to the original displayed characters, not to positions in a temporary lowercase copy.

**Data flow**: It passes `İstanbul` and `is` into the matcher. It expects a successful match with original positions `0` and `1`, then checks the score for a prefix match where the lowercase copy has an extra character from the dotted I conversion. If the matcher fails, the test fails immediately.

**Call relations**: This test calls `fuzzy_match` to verify the Unicode mapping promise made by the utility. It then uses assertions to confirm both the highlighting positions and scoring.

*Call graph*: calls 1 internal fn (fuzzy_match); 2 external calls (assert_eq!, panic!).


##### `tests::unicode_german_sharp_s_casefold`  (lines 98–100)

```
fn unicode_german_sharp_s_casefold()
```

**Purpose**: Checks an important Unicode limitation: the matcher lowercases text, but it does not perform full Unicode case folding. In practical terms, it should not treat German `ß` as if it were the two letters `ss` for this test case.

**Data flow**: It checks that searching for `strasse` in `straße` produces no match. The expected before-to-after story is: the text contains `ß`, the search contains `ss`, and this matcher does not expand `ß` into `ss`, so the result should be no match.

**Call relations**: This test belongs to the same test suite that defines the matcher’s expected Unicode behavior. It uses an assertion to lock in the current choice so future changes do not silently alter how this case is treated.

*Call graph*: 1 external calls (assert!).


##### `tests::prefer_contiguous_match_over_spread`  (lines 103–117)

```
fn prefer_contiguous_match_over_spread()
```

**Purpose**: Makes sure close-together matches rank better than matches with gaps. This is important for search results because an exact-looking match should usually appear above a scattered one.

**Data flow**: It compares searching `abc` inside `abc` with searching `abc` inside `a-b-c`. Both should match, but the first match is contiguous and the second is spread over extra characters. The test checks that the contiguous match receives the better, smaller score.

**Call relations**: This test calls `fuzzy_match` twice and compares the scores. It uses assertions to show that the score calculation favors compact matches, which is a core part of how callers can sort fuzzy-search results.

*Call graph*: calls 1 internal fn (fuzzy_match); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::start_of_string_bonus_applies`  (lines 120–134)

```
fn start_of_string_bonus_applies()
```

**Purpose**: Checks that matches at the beginning of a string get a strong ranking bonus. This helps prefix matches, like a filename starting with the user’s query, rise above matches buried later in the text.

**Data flow**: It searches for `file` in `file_name` and in `my_file_name`. Both contain a contiguous `file`, but only the first starts at character zero. The test confirms the prefix match gets the bonus score and therefore ranks better.

**Call relations**: This test calls `fuzzy_match` for a prefix case and a non-prefix case. Its assertions protect the ranking rule that beginning-of-string matches should be preferred.

*Call graph*: calls 1 internal fn (fuzzy_match); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::empty_needle_matches_with_max_score_and_no_indices`  (lines 137–144)

```
fn empty_needle_matches_with_max_score_and_no_indices()
```

**Purpose**: Verifies the special behavior for an empty search string. An empty search matches anything, but it returns no highlight positions and a deliberately very large score.

**Data flow**: It passes any text with an empty search string into the matcher. The matcher should return an empty list of positions and `i32::MAX` as the score. The test checks both pieces of the result and fails if the matcher returns no result.

**Call relations**: This test calls `fuzzy_match` to confirm the early-return path before normal matching begins. It protects callers from surprising behavior when a user has not typed a search query yet.

*Call graph*: calls 1 internal fn (fuzzy_match); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::case_insensitive_matching_basic`  (lines 147–155)

```
fn case_insensitive_matching_basic()
```

**Purpose**: Confirms that matching ignores letter case for ordinary text. This lets users find `FooBar` even if they type mixed or different casing such as `foO`.

**Data flow**: It sends `FooBar` and `foO` to the matcher. The expected result is a match at original positions `0`, `1`, and `2`, with the best prefix-contiguous score. If the function reports no match, the test fails.

**Call relations**: This test calls `fuzzy_match` directly and checks its output with assertions. It protects the everyday case-insensitive behavior that most users expect from fuzzy filtering.

*Call graph*: calls 1 internal fn (fuzzy_match); 2 external calls (assert_eq!, panic!).


##### `tests::indices_are_deduped_for_multichar_lowercase_expansion`  (lines 158–167)

```
fn indices_are_deduped_for_multichar_lowercase_expansion()
```

**Purpose**: Checks that one original character is not highlighted twice when lowercasing turns it into multiple characters. This matters for Unicode text such as `İ`, whose lowercase form has two pieces.

**Data flow**: It searches inside `İ` using the two-character lowercase form made from `i` plus a combining dot. The matcher may find two lowercase pieces, but both came from the same original character. The test expects the final index list to contain only `0`, and it checks that the score still reflects a contiguous prefix match.

**Call relations**: This test calls `fuzzy_match` to exercise the duplicate-removal step after matching. Its assertions ensure the returned positions are safe for callers that use them to highlight original text.

*Call graph*: calls 1 internal fn (fuzzy_match); 2 external calls (assert_eq!, panic!).


### `hooks/src/events/common.rs`

`util` · `cross-cutting during hook setup, preview, execution, and result parsing`

Hooks are small pieces of user-configured code that run at important moments, such as before a tool is used or after a session starts. This file is the shared toolbox for those hook events. It does not run hooks by itself. Instead, it supplies common rules that the event-specific code uses so every hook behaves consistently.

Several helpers deal with text that comes back from hooks. They trim blank output, join multiple text blocks with clear spacing, and record “additional context” both as visible hook output and as text that can be fed back to the model. Think of this as keeping two copies of a note: one for the event log and one for the assistant to read later.

Another group of helpers creates failure events when the system cannot even serialize, or prepare, the data needed to call a hook. In that case, each configured hook is reported as failed immediately, with a zero duration and an error message.

The last major piece is matcher logic. A matcher is a pattern that says which tool or event a hook should apply to. This file defines simple “match everything” rules, exact-name matching, pipe-separated alternatives like `Edit|Write`, and regular expressions, which are patterns for matching text.

#### Function details

##### `join_text_chunks`  (lines 18–24)

```
fn join_text_chunks(chunks: Vec<String>) -> Option<String>
```

**Purpose**: Combines several text blocks into one readable block, or returns nothing if there is no text at all. This is useful when multiple hook outputs need to be shown as one message.

**Data flow**: It receives a list of strings. If the list is empty, it produces `None`, meaning there is no text to report. If the list has content, it joins the strings with a blank line between each one and returns that combined text.

**Call relations**: The hook running and result aggregation paths call this when they have collected pieces of text and need to turn them into one final message.

*Call graph*: called by 2 (run, aggregate_results).


##### `trimmed_non_empty`  (lines 26–33)

```
fn trimmed_non_empty(text: &str) -> Option<String>
```

**Purpose**: Cleans up a piece of text and keeps it only if something meaningful remains. This prevents blank or whitespace-only hook output from being treated as real content.

**Data flow**: It receives a text string, removes whitespace from the beginning and end, then checks whether anything is left. It returns the cleaned text if it is non-empty, otherwise it returns `None`.

**Call relations**: Several hook result parsing paths call this while reading completed hook output, so empty messages do not get added to the event stream or model context.

*Call graph*: called by 7 (parse_completed, parse_pre_completed, parse_completed, parse_completed, parse_completed, parse_completed, parse_completed).


##### `append_additional_context`  (lines 35–45)

```
fn append_additional_context(
    entries: &mut Vec<HookOutputEntry>,
    additional_contexts_for_model: &mut Vec<String>,
    additional_context: String,
)
```

**Purpose**: Adds extra context from a hook in two places: the structured hook output log and the list of text that can be passed back to the model. This keeps what the user can inspect and what the model can use in sync.

**Data flow**: It receives a mutable list of hook output entries, a mutable list of context strings for the model, and one new context string. It adds a context entry to the output list and also appends the same text to the model-context list.

**Call relations**: Hook result parsers call this when a hook reports extra context. The parsed result can then both display that context and make it available to later model work.

*Call graph*: called by 4 (parse_completed, parse_completed, parse_completed, parse_completed).


##### `flatten_additional_contexts`  (lines 47–54)

```
fn flatten_additional_contexts(
    additional_contexts: impl IntoIterator<Item = &'a [String]>,
) -> Vec<String>
```

**Purpose**: Turns several groups of additional context into one flat list. This is useful when multiple hooks or phases each produce their own small bundle of context.

**Data flow**: It receives an iterable collection of string slices, where each slice is a group of context strings. It walks through every group, copies each string, and returns one single list containing all of them in order.

**Call relations**: Several hook run paths call this after collecting context from different places, so later code can treat all extra context as one simple list.

*Call graph*: called by 4 (run, run, run, run); 1 external calls (into_iter).


##### `serialization_failure_hook_events`  (lines 56–78)

```
fn serialization_failure_hook_events(
    handlers: Vec<ConfiguredHandler>,
    turn_id: Option<String>,
    error_message: String,
) -> Vec<HookCompletedEvent>
```

**Purpose**: Builds failed hook completion events when the system cannot prepare the data needed to run hooks. Instead of silently dropping the hooks, it records a clear failure for each configured handler.

**Data flow**: It receives configured hook handlers, an optional turn identifier, and an error message. For each handler, it creates a running summary, marks it as failed, sets its completion time and duration to immediate values, attaches the error text, and returns the resulting completed events.

**Call relations**: Pre-run, post-run, and general hook run paths call this when serialization fails. The tool-use-specific helper also calls it first, then adds tool-use information to the generated events.

*Call graph*: called by 6 (serialization_failure_hook_events_for_tool_use, run_post, run_pre, run, run, run).


##### `serialization_failure_hook_events_for_tool_use`  (lines 80–90)

```
fn serialization_failure_hook_events_for_tool_use(
    handlers: Vec<ConfiguredHandler>,
    turn_id: Option<String>,
    error_message: String,
    tool_use_id: &str,
) -> Vec<HookCompletedEvent>
```

**Purpose**: Creates failed hook events for a serialization problem that happened while processing a specific tool use. It makes sure each failure can be traced back to that tool call.

**Data flow**: It receives hook handlers, an optional turn identifier, an error message, and a tool-use identifier. It first creates ordinary serialization failure events, then rewrites each event so its run id includes the tool-use id.

**Call relations**: Tool-use hook run paths call this when they cannot prepare hook input for a particular tool. It delegates the basic failure construction to `serialization_failure_hook_events` and then tags each event through `hook_completed_for_tool_use`.

*Call graph*: calls 1 internal fn (serialization_failure_hook_events); called by 5 (run, run, serialization_failure_run_ids_include_tool_use_id, run, serialization_failure_run_ids_include_tool_use_id).


##### `hook_completed_for_tool_use`  (lines 92–98)

```
fn hook_completed_for_tool_use(
    mut event: HookCompletedEvent,
    tool_use_id: &str,
) -> HookCompletedEvent
```

**Purpose**: Marks an already completed hook event as belonging to a particular tool use. This avoids confusion when the same hook can run for many tool calls.

**Data flow**: It receives a completed hook event and a tool-use identifier. It updates the event's run summary so the run id includes that tool-use id, then returns the modified event.

**Call relations**: Tests and tool-use failure handling use this to make completed hook event ids specific to the tool call. It hands the run-id change to `hook_run_for_tool_use`.

*Call graph*: calls 1 internal fn (hook_run_for_tool_use); called by 2 (preview_and_completed_run_ids_include_tool_use_id, preview_and_completed_run_ids_include_tool_use_id).


##### `hook_run_for_tool_use`  (lines 100–103)

```
fn hook_run_for_tool_use(mut run: HookRunSummary, tool_use_id: &str) -> HookRunSummary
```

**Purpose**: Adds a tool-use identifier to a hook run id. This creates a more specific id, like labeling a receipt with both the cashier and the purchase.

**Data flow**: It receives a hook run summary and a tool-use identifier. It changes the run id to include the old id plus the tool-use id separated by a colon, then returns the updated summary.

**Call relations**: `hook_completed_for_tool_use` calls this when a whole completed event needs to be tied to a specific tool use.

*Call graph*: called by 1 (hook_completed_for_tool_use); 1 external calls (format!).


##### `matcher_pattern_for_event`  (lines 105–120)

```
fn matcher_pattern_for_event(
    event_name: HookEventName,
    matcher: Option<&str>,
) -> Option<&str>
```

**Purpose**: Decides whether a hook event type is allowed to use a matcher pattern. Some events can be narrowed by a matcher, while others always ignore matchers.

**Data flow**: It receives a hook event name and an optional matcher string. For event types that support matching, it returns the matcher unchanged. For user prompt submission and stop events, it returns `None`, meaning no matcher should apply.

**Call relations**: Matcher group setup calls this while building hook configuration. It is the gatekeeper that prevents unsupported event types from accidentally using matcher rules.

*Call graph*: called by 1 (append_matcher_groups).


##### `validate_matcher_pattern`  (lines 122–127)

```
fn validate_matcher_pattern(matcher: &str) -> Result<(), regex::Error>
```

**Purpose**: Checks that a matcher pattern is acceptable before the system stores or uses it. This catches broken regular expressions early instead of failing later during hook execution.

**Data flow**: It receives a matcher string. If the matcher means “match all” or is a simple exact-name matcher, it accepts it immediately. Otherwise, it tries to compile it as a regular expression and returns success or the regex error.

**Call relations**: Matcher group setup calls this when reading hook configuration. It relies on `is_match_all_matcher` and `is_exact_matcher` to avoid treating simple names as regular expressions.

*Call graph*: calls 2 internal fn (is_exact_matcher, is_match_all_matcher); called by 1 (append_matcher_groups); 1 external calls (new).


##### `matches_matcher`  (lines 129–144)

```
fn matches_matcher(matcher: Option<&str>, input: Option<&str>) -> bool
```

**Purpose**: Answers the central question: does this matcher apply to this input name? It supports omitted matchers, wildcard matchers, exact names, pipe-separated alternatives, and regular expressions.

**Data flow**: It receives an optional matcher and an optional input string. No matcher, an empty matcher, or `*` means true. A simple exact matcher is compared directly against the input, with `|` allowing alternatives. Otherwise it tries to use the matcher as a regular expression. It returns true only when the input matches the selected rule.

**Call relations**: This is the shared matching rule used by hook preview and execution code paths when deciding whether a configured hook should run for a particular tool or event input.

*Call graph*: calls 2 internal fn (is_exact_matcher, is_match_all_matcher).


##### `matcher_inputs`  (lines 146–155)

```
fn matcher_inputs(
    tool_name: &'a str,
    matcher_aliases: &'a [String],
) -> Vec<&'a str>
```

**Purpose**: Builds the list of names that a matcher should try for a tool. It keeps the tool's main name first, then includes any alias names.

**Data flow**: It receives a canonical tool name and a list of alias strings. It returns a list of string references beginning with the canonical name, followed by each alias in the original order.

**Call relations**: Hook preview and run paths call this before applying matchers. Keeping the canonical name first makes previews and execution line up with the name that will be serialized into hook input.

*Call graph*: called by 6 (preview, run, preview, run, preview, run); 1 external calls (once).


##### `is_match_all_matcher`  (lines 157–159)

```
fn is_match_all_matcher(matcher: &str) -> bool
```

**Purpose**: Recognizes matcher strings that mean “match everything.” In this file, both an empty string and `*` have that meaning.

**Data flow**: It receives a matcher string and returns true if the string is empty or exactly `*`; otherwise it returns false.

**Call relations**: `validate_matcher_pattern` uses this to accept match-all patterns without regex parsing, and `matches_matcher` uses it to make those patterns match every input.

*Call graph*: called by 2 (matches_matcher, validate_matcher_pattern).


##### `is_exact_matcher`  (lines 161–165)

```
fn is_exact_matcher(matcher: &str) -> bool
```

**Purpose**: Recognizes simple matcher strings that should be treated as exact names rather than regular expressions. This protects names like `Bash` or `mcp__memory` from accidentally matching larger strings.

**Data flow**: It receives a matcher string and checks every character. It returns true only if all characters are letters, numbers, underscores, or the pipe character used for alternatives.

**Call relations**: `validate_matcher_pattern` uses this to approve simple names directly. `matches_matcher` uses it to choose direct equality checks instead of regex matching.

*Call graph*: called by 2 (matches_matcher, validate_matcher_pattern).


##### `tests::matcher_omitted_matches_all_occurrences`  (lines 177–180)

```
fn matcher_omitted_matches_all_occurrences()
```

**Purpose**: Tests that leaving out a matcher means the hook applies to every input. This confirms the default behavior is broad rather than restrictive.

**Data flow**: It calls the matcher logic with no matcher and different tool names. The expected result is true for each name.

**Call relations**: This test exercises `matches_matcher` directly and protects callers that rely on omitted matchers running for all occurrences.

*Call graph*: 1 external calls (assert!).


##### `tests::matcher_star_matches_all_occurrences`  (lines 183–187)

```
fn matcher_star_matches_all_occurrences()
```

**Purpose**: Tests that `*` is accepted and behaves as a match-all pattern. This is the explicit wildcard form users can write in configuration.

**Data flow**: It checks that `*` matches different input names and that validation accepts `*` as a valid matcher.

**Call relations**: This test covers both `matches_matcher` and `validate_matcher_pattern`, confirming they agree about the meaning of `*`.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::matcher_empty_string_matches_all_occurrences`  (lines 190–194)

```
fn matcher_empty_string_matches_all_occurrences()
```

**Purpose**: Tests that an empty matcher string is treated as matching everything. This keeps blank matcher configuration from accidentally blocking hooks.

**Data flow**: It passes an empty string matcher with different inputs and expects matches, then checks that validation accepts the empty string.

**Call relations**: This test ties together the validation and matching behavior for empty strings, which is implemented through the shared match-all helper.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::exact_matcher_supports_pipe_alternatives`  (lines 197–202)

```
fn exact_matcher_supports_pipe_alternatives()
```

**Purpose**: Tests that simple exact matchers can name more than one allowed input using `|`. For example, `Edit|Write` should mean exactly Edit or exactly Write.

**Data flow**: It checks that the matcher succeeds for `Edit` and `Write`, fails for `Bash`, and passes validation.

**Call relations**: This test exercises the exact-matcher branch of `matches_matcher` and confirms `validate_matcher_pattern` treats pipe-separated exact names as valid.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::literal_matcher_uses_exact_matching`  (lines 205–217)

```
fn literal_matcher_uses_exact_matching()
```

**Purpose**: Tests that plain names match only the exact same input, not names that merely start with or contain them. This prevents surprising overmatching.

**Data flow**: It compares literal matchers against matching and non-matching inputs, including longer MCP-style tool names, and checks that validation accepts a simple literal matcher.

**Call relations**: This test protects the behavior chosen by `is_exact_matcher`: simple names are checked by equality, not by regular expression searching.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::matcher_uses_regex_when_it_contains_regex_characters`  (lines 220–223)

```
fn matcher_uses_regex_when_it_contains_regex_characters()
```

**Purpose**: Tests that a matcher containing regular expression syntax is treated as a regular expression. This lets users write more flexible patterns when they need them.

**Data flow**: It uses `^Bash`, a regex-style pattern meaning text that starts with Bash, and confirms it matches `BashOutput`. It also checks that validation accepts the pattern.

**Call relations**: This test verifies that matchers outside the exact-name rules are passed through regex validation and regex matching.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::mcp_matchers_support_regex_wildcards`  (lines 226–240)

```
fn mcp_matchers_support_regex_wildcards()
```

**Purpose**: Tests that MCP-style tool names can be matched with regex wildcards. MCP means Model Context Protocol, a way external tools can be exposed to the system.

**Data flow**: It tries patterns such as `mcp__memory__.*` and `mcp__.*__write.*` against matching and non-matching tool names, then checks that the regex pattern validates.

**Call relations**: This test protects flexible matching for generated or namespaced tool names, using the regex path in `matches_matcher` and `validate_matcher_pattern`.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::matcher_supports_anchored_regexes`  (lines 243–247)

```
fn matcher_supports_anchored_regexes()
```

**Purpose**: Tests that fully anchored regular expressions work. An anchored regex such as `^Bash$` means the whole input must be exactly Bash.

**Data flow**: It checks that `^Bash$` matches `Bash`, does not match `BashOutput`, and passes validation.

**Call relations**: This test confirms that regex users can control whether they want partial or whole-string matching.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::invalid_regex_is_rejected`  (lines 250–253)

```
fn invalid_regex_is_rejected()
```

**Purpose**: Tests that broken regular expressions are not accepted and do not match anything. This prevents invalid configuration from acting unpredictably.

**Data flow**: It passes `[` as a matcher, which is not a valid regex. It expects validation to return an error and matching to return false.

**Call relations**: This test covers the error path in both `validate_matcher_pattern` and the regex branch of `matches_matcher`.

*Call graph*: 1 external calls (assert!).


##### `tests::unsupported_events_ignore_matchers`  (lines 256–265)

```
fn unsupported_events_ignore_matchers()
```

**Purpose**: Tests that event types which do not support matchers drop matcher patterns. This keeps matcher behavior limited to events where it makes sense.

**Data flow**: It passes matcher strings for user prompt submission and stop events. In both cases it expects the result to be `None`, meaning the matcher is ignored.

**Call relations**: This test directly checks `matcher_pattern_for_event` for unsupported event types and protects configuration setup from applying matchers too broadly.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::supported_events_keep_matchers`  (lines 268–289)

```
fn supported_events_keep_matchers()
```

**Purpose**: Tests that event types which support matchers preserve the matcher string. This confirms that narrowing hooks by tool or event detail remains available where intended.

**Data flow**: It passes matcher strings for supported events such as pre-tool-use, post-tool-use, session start, pre-compact, and post-compact. It expects each matcher to come back unchanged.

**Call relations**: This test directly checks `matcher_pattern_for_event` for supported event types, complementing the test that unsupported events ignore matchers.

*Call graph*: 1 external calls (assert_eq!).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-network-proxy-policy` — The managed proxy and network-forwarding state that decides what network traffic is allowed, forwarded, or blocked.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-hook-rules` — The configured hooks and hook schemas that let external commands inspect or affect session starts, turns, tool calls, and other lifecycle events.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-filesystem-watch-subscriptions` — Active file and directory watch subscriptions, invalidation signals, and watcher-to-client mappings used for skills, plugin/config refreshes, and app-server file APIs.
- `reg-terminal-runtime-state` — Live terminal control state such as raw mode, alternate screen ownership, resize/suspend handling, input streams, and restoration obligations.
