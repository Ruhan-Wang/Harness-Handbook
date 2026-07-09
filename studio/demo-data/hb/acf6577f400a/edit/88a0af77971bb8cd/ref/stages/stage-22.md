# Cross-cutting utility and support libraries  `stage-22` (cross-cutting infrastructure)

This stage is the system’s shared toolbox: cross-cutting infrastructure used from build and startup through the main interaction loop and even shutdown-sensitive paths. It provides the low-level types, adapters, and conventions that let higher layers talk about files, text, config, shells, plugins, async state, images, and platform quirks in one consistent way.

Its filesystem/environment utilities define canonical path and URI handling, absolute-path guarantees, filesystem abstraction, file watching, binary resolution, child-process environments, terminal inspection, and platform-specific sandbox support. Text and rendering helpers parse streaming text, sanitize and truncate output, extract structure, and turn ANSI/markdown into terminal-aware layouts. Configuration/auth/network glue normalizes config sources, schemas, URLs, proxy and domain rules, auth headers, and service metadata. Shell/git/plugin execution support parses commands, prepares argv/env, manages subprocess behavior, inspects repositories, and safely stages plugin content. Async, readiness, image, cache, and sandbox-summary helpers support cancellation, redraw pacing, image preparation and terminal protocols, lightweight caching, and concise policy summaries. Build scripts supply native build-time linkage and embedded assets. Direct utility files add shared backoff, tracing feedback tags, CLI and plugin facades, canonical error types, fuzzy matching, and common hook-event normalization rules.

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

`util` · `cross-cutting helper use throughout runtime and retries`

This file collects generic helpers used across unrelated subsystems. The `feedback_tags!` macro emits a tracing `info!` event with target `feedback_tags`, wrapping each supplied value in `tracing::field::debug`; when the feedback metadata layer is installed, those fields become uploadable feedback tags. `Auth401FeedbackSnapshot` is a tiny internal struct used to normalize optional 401/auth-related metadata into empty-string fields so tag emission always has stable keys. `emit_feedback_auth_recovery_tags` uses that snapshot to log a consistent set of auth recovery tags including mode, phase, outcome, request ID, Cloudflare ray, and provider error details.

The remaining helpers are general-purpose. `backoff` computes exponential retry delay from `INITIAL_DELAY_MS` and `BACKOFF_FACTOR`, then applies random jitter in the range `0.9..1.1` before returning a `Duration`. `error_or_panic` panics in debug builds but logs an error in release builds, making invariant violations loud during development without crashing production. `resolve_path` returns an absolute path unchanged or joins a relative path against a base directory. `normalize_thread_name` trims whitespace and converts empty results to `None`, preventing meaningless blank thread names from propagating. None of these functions maintain shared state beyond reading constants and emitting logs, which makes the file a straightforward utility module.

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

**Purpose**: Builds a normalized auth-feedback snapshot from optional string fields, replacing missing values with empty strings.

**Data flow**: Takes four `Option<&str>` inputs (`request_id`, `cf_ray`, `error`, `error_code`), unwraps each with `unwrap_or("")`, stores the resulting borrowed strings in `Auth401FeedbackSnapshot`, and returns it.

**Call relations**: Used only by `emit_feedback_auth_recovery_tags` so feedback-tag emission always has concrete values for every auth-related field.

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

**Purpose**: Emits a structured tracing event containing auth-recovery outcome metadata and normalized 401 details.

**Data flow**: Takes auth recovery mode/phase/outcome strings plus optional request/error metadata, constructs `auth_401` via `Auth401FeedbackSnapshot::from_optional_fields`, then invokes the `feedback_tags!` macro with both the recovery fields and the normalized auth-401 fields. It returns unit.

**Call relations**: Called by `handle_unauthorized` when auth recovery logic wants to attach structured diagnostics to feedback uploads.

*Call graph*: calls 1 internal fn (from_optional_fields); called by 1 (handle_unauthorized); 1 external calls (feedback_tags!).


##### `backoff`  (lines 85–90)

```
fn backoff(attempt: u64) -> Duration
```

**Purpose**: Computes an exponential retry delay with multiplicative jitter.

**Data flow**: Takes an `attempt: u64`, computes `exp = BACKOFF_FACTOR.powi(attempt.saturating_sub(1) as i32)`, multiplies `INITIAL_DELAY_MS` by that exponent to get a base delay, samples jitter from `rand::rng().random_range(0.9..1.1)`, multiplies base by jitter, converts to milliseconds, and returns `Duration::from_millis(...)`.

**Call relations**: Used by multiple retry loops such as reconnect delays, unauthorized handling, request retries, compact-task retries, guardian retries, and retryable stream-error handling.

*Call graph*: called by 6 (next_reconnect_delay, handle_unauthorized, retry_after_request_failure, run_compact_task_inner_impl, wait_before_guardian_retry, handle_retryable_response_stream_error); 2 external calls (from_millis, rng).


##### `error_or_panic`  (lines 92–98)

```
fn error_or_panic(message: impl std::string::ToString)
```

**Purpose**: Reports an internal error by panicking in debug builds and logging in release builds.

**Data flow**: Takes any `ToString` message, checks `cfg!(debug_assertions)`, and either calls `panic!(...)` with the stringified message or logs it with `tracing::error!(...)`. Returns unit.

**Call relations**: Used at invariant-boundary sites where developers want crashes during debugging but nonfatal logging in production.

*Call graph*: called by 5 (ensure_call_outputs_present, drain_in_flight, run_turn, try_run_sampling_request, from_tools); 3 external calls (cfg!, error!, panic!).


##### `resolve_path`  (lines 100–106)

```
fn resolve_path(base: &Path, path: &PathBuf) -> PathBuf
```

**Purpose**: Resolves a possibly relative path against a base directory.

**Data flow**: Takes `base: &Path` and `path: &PathBuf`; if `path.is_absolute()` it clones and returns `path`, otherwise it returns `base.join(path)`.

**Call relations**: A generic helper for callers that need consistent absolute-path resolution without duplicating the absolute-vs-relative branch.

*Call graph*: 3 external calls (join, clone, is_absolute).


##### `normalize_thread_name`  (lines 109–116)

```
fn normalize_thread_name(name: &str) -> Option<String>
```

**Purpose**: Trims a thread name and suppresses empty-or-whitespace-only names.

**Data flow**: Takes `&str`, computes `trimmed = name.trim()`, and returns `None` if `trimmed.is_empty()` else `Some(trimmed.to_string())`.

**Call relations**: Called by `thread_set_name_response_inner` before persisting or returning thread names so blank names are treated as absent.

*Call graph*: called by 1 (thread_set_name_response_inner).


### `core/src/utils/mod.rs`

`util` · `cross-cutting`

This module is a minimal utility aggregator. It publicly declares the `path_utils` submodule and does not define any logic of its own. Its purpose is organizational: code elsewhere in `codex-core` can import utility functionality through a stable `core::utils` namespace rather than depending directly on lower-level crates or file paths.

At present the utility surface is intentionally narrow, containing only path helpers. That design suggests the crate prefers to keep generic helpers small and explicit instead of accumulating unrelated convenience functions in a broad catch-all module. Because this file only wires module visibility, it acts as a boundary marker for reusable support code rather than participating in runtime control flow. Any lifecycle impact comes indirectly when callers use the exported path utilities during configuration resolution, filesystem access, or command preparation.


### `utils/cli/src/lib.rs`

`orchestration` · `cross-cutting`

This library root organizes the CLI support crate into a small set of internal modules and then selectively re-exports the pieces intended for downstream consumers. The internal modules cover approval-mode parsing, sandbox-mode parsing, config override assembly, environment-display formatting, resume-command helpers, and shared option definitions. Consumers of the crate do not need to know those module boundaries; they import the public types and functions directly from this root.

The file also re-exports `ProfileV2Name` from `codex_protocol::config_types`, making that protocol-level configuration identifier part of the CLI crate's outward-facing API. That suggests this crate acts as a convenience boundary between low-level protocol/config types and higher-level command-line parsing code. Visibility is intentionally mixed: `format_env_display` is `pub(crate)` as a module but its function is publicly re-exported, which keeps the module namespace private while exposing the utility itself. There is no executable logic here; the important behavior is API curation, dependency shaping, and presenting a coherent CLI toolkit to other crates.


### `utils/plugins/src/lib.rs`

`data_model` · `cross-cutting`

This crate root exposes three plugin-focused submodules: `mcp_connector`, `mention_syntax`, and `plugin_namespace`. It publicly re-exports the plugin namespace discovery constants and lookup helpers so callers can resolve plugin manifests and derive plugin namespaces without depending on the internal module layout. The top-level documentation comment makes the intended scope explicit: plugin path resolution, plaintext mention sigils, and MCP connector helpers shared across the wider system.

The one concrete type defined here is `PluginSkillRoot`, a small data carrier with three fields: `path`, `plugin_id`, and `plugin_root`. Both path fields use `AbsolutePathBuf`, which encodes an invariant that these locations are already normalized to absolute filesystem paths rather than arbitrary relative strings. The struct derives `Debug`, `Clone`, `PartialEq`, `Eq`, and `Hash`, indicating it is meant to be logged, copied, compared, and used as a key in hashed collections. Conceptually, it ties a specific skill path back to the owning plugin identity and root directory. This file itself contains no control flow; its role is to define the crate's public API and one shared plugin-location model type.


### Shared error vocabularies
These files establish reusable error types that give supporting crates consistent failure models.

### `execpolicy-legacy/src/error.rs`

`data_model` · `cross-cutting`

This file is the central error vocabulary for the legacy execution-policy subsystem. It introduces a crate-local `Result<T>` alias bound to a single `Error` enum, so all parsing and validation code can return structured failures with consistent serialization. The enum is tagged for Serde output with `#[serde(tag = "type")]`, which means each variant serializes as a discriminated object suitable for machine-readable diagnostics. Several variants embed domain types from the parser and matcher layers—`ArgMatcher` and `PositionalArg`—so callers can report exactly which positional pattern or argument caused a mismatch rather than collapsing everything into strings.

The variants cover multiple phases of the subsystem: command-spec lookup (`NoSpecForProgram`), option scanning (`OptionMissingValue`, `UnknownOption`, `MissingRequiredOptions`), positional matching and varargs invariants (`UnexpectedArguments`, `NotEnoughArgs`, `MultipleVarargPatterns`, `VarargMatcherDidNotMatchAnything`), literal and numeric validation (`LiteralValueDidNotMatch`, `InvalidPositiveInteger`), and filesystem policy enforcement (`ReadablePathNotInReadableFolders`, `WriteablePathNotInWriteableFolders`, `CannotCheckRelativePath`, `CannotCanonicalizePath`). Range and overlap variants encode internal slice/pattern consistency checks, while `InternalInvariantViolation` is an explicit escape hatch for impossible states. A notable serialization detail is `CannotCanonicalizePath.error`, which stores `std::io::ErrorKind` and serializes it via `serde_with::DisplayFromStr`, preserving a stable textual representation for an otherwise non-serializable standard-library type.


### `git-utils/src/errors.rs`

`data_model` · `cross-cutting / error propagation`

This file introduces `GitToolingError`, an enum deriving `thiserror::Error` and `Debug`, used across the git-utils crate to report failures with enough context to diagnose command execution and repository-path issues. The variants are concrete and tailored to the crate’s responsibilities. `GitCommand` captures a failed git subprocess with the exact command string, `ExitStatus`, and stderr text; `GitOutputUtf8` preserves the command whose output could not be decoded as UTF-8 along with the original `FromUtf8Error`; `NotAGitRepository`, `NonRelativePath`, and `PathEscapesRepository` encode repository-shape and path-safety invariants using `PathBuf` payloads.

The remaining variants are wrappers around lower-level errors that arise during traversal and path manipulation: `PathPrefix` converts `StripPrefixError`, `Walkdir` converts `walkdir::Error`, and `Io` converts `std::io::Error`. The `#[from]` annotations make these conversions automatic with `?`, which strongly shapes the rest of the crate’s control flow: helper functions can propagate filesystem and traversal failures without manual mapping, while still returning a domain-specific error type. The enum’s error messages are intentionally user-facing and specific, especially for git command failures and path validation, where preserving the offending command or path is critical.


### Event and matching helpers
These files provide reusable matching and normalization logic, from generic fuzzy filtering to hook-event-specific conventions.

### `utils/fuzzy-match/src/lib.rs`

`domain_logic` · `request handling`

The core of this file is `fuzzy_match`, which matches `needle` as an ordered subsequence of `haystack` after lowercasing both sides. The implementation is careful about Unicode lowercasing expansions: instead of matching directly on the original string, it builds `lowered_chars`, a vector of lowercased haystack characters, and a parallel `lowered_to_orig_char_idx` vector mapping each lowered character position back to the original `haystack.chars().enumerate()` index. This preserves highlight correctness even when one original character lowercases into multiple characters, such as `İ`.

Matching proceeds greedily from left to right. For each lowercased needle character, the function scans forward from the current lowered haystack position until it finds a match; if any character cannot be found, it returns `None`. On success it records the original character index corresponding to each lowered match position. It then computes a score where smaller is better: the score is the extra span between the first and last lowered match positions beyond the needle length, clamped at zero, with a strong `-100` bonus for prefix matches starting at lowered position 0. Finally, it sorts and deduplicates the original indices before returning them with the score.

Important edge cases are explicit: an empty needle always matches with no indices and `i32::MAX`, and multi-character lowercase expansions can collapse to a single original highlight index after deduplication. The tests cover ASCII, case-insensitivity, prefix bonuses, contiguous versus spread matches, empty needles, and Unicode expansion behavior.

#### Function details

##### `fuzzy_match`  (lines 12–69)

```
fn fuzzy_match(haystack: &str, needle: &str) -> Option<(Vec<usize>, i32)>
```

**Purpose**: Performs case-insensitive subsequence matching of `needle` against `haystack`, returning original-character highlight indices and a ranking score. It preserves correct original indices even when Unicode lowercasing expands characters.

**Data flow**: It takes `haystack: &str` and `needle: &str`. If `needle` is empty, it immediately returns `Some((Vec::new(), i32::MAX))`. Otherwise it iterates over `haystack.chars().enumerate()`, lowercases each character, pushes each lowered character into `lowered_chars`, and pushes the corresponding original character index into `lowered_to_orig_char_idx`. It lowercases `needle` into `lowered_needle`, then greedily scans `lowered_chars` left-to-right to find each needle character in order, collecting mapped original indices and tracking the last lowered match position; failure to find any character returns `None`. After matching, it derives the first lowered position from the first original hit, computes a nonnegative span-based `window`, subtracts 100 from the score for prefix matches, sorts and deduplicates the original indices, and returns `Some((indices, score))`.

**Call relations**: This is the crate's sole exported algorithm and is called directly by the tests to validate matching, scoring, and Unicode-index behavior. It is self-contained and does not delegate to other local helpers.

*Call graph*: called by 7 (ascii_basic_indices, case_insensitive_matching_basic, empty_needle_matches_with_max_score_and_no_indices, indices_are_deduped_for_multichar_lowercase_expansion, prefer_contiguous_match_over_spread, start_of_string_bonus_applies, unicode_dotted_i_istanbul_highlighting); 2 external calls (new, with_capacity).


##### `tests::ascii_basic_indices`  (lines 76–84)

```
fn ascii_basic_indices()
```

**Purpose**: Verifies basic ASCII subsequence matching, returned indices, and the prefix-match score bonus. It demonstrates the expected score calculation on a simple non-contiguous match.

**Data flow**: The test calls `fuzzy_match("hello", "hl")`, destructures the `Some` result or panics if absent, then asserts indices `[0, 2]` and score `-99`.

**Call relations**: It exercises the normal successful-match path of `fuzzy_match`, including score computation with a start-of-string bonus.

*Call graph*: calls 1 internal fn (fuzzy_match); 2 external calls (assert_eq!, panic!).


##### `tests::unicode_dotted_i_istanbul_highlighting`  (lines 87–95)

```
fn unicode_dotted_i_istanbul_highlighting()
```

**Purpose**: Checks that Unicode lowercasing expansion for `İ` still yields correct original highlight indices. It ensures matching is done on lowered text while highlights remain aligned to original character positions.

**Data flow**: The test calls `fuzzy_match("İstanbul", "is")`, unwraps the `Some` result or panics, and asserts indices `[0, 1]` and score `-99`.

**Call relations**: It targets the Unicode mapping logic inside `fuzzy_match`, specifically the parallel lowered-to-original index tracking.

*Call graph*: calls 1 internal fn (fuzzy_match); 2 external calls (assert_eq!, panic!).


##### `tests::unicode_german_sharp_s_casefold`  (lines 98–100)

```
fn unicode_german_sharp_s_casefold()
```

**Purpose**: Documents that the matcher does not implement full Unicode case folding for German sharp-s equivalence. The test asserts that `straße` does not match `strasse`.

**Data flow**: The test calls `fuzzy_match("straße", "strasse")` and asserts that the result is `None` via `is_none()`. No state is mutated.

**Call relations**: It captures a deliberate limitation of the algorithm: lowercasing support is present, but full case-fold equivalence is not.

*Call graph*: 1 external calls (assert!).


##### `tests::prefer_contiguous_match_over_spread`  (lines 103–117)

```
fn prefer_contiguous_match_over_spread()
```

**Purpose**: Verifies that the scoring function prefers tighter match windows over spread-out subsequences. Lower scores indicate better matches.

**Data flow**: The test computes scores from `fuzzy_match("abc", "abc")` and `fuzzy_match("a-b-c", "abc")`, panicking if either unexpectedly fails. It asserts scores `-100` and `-98`, then asserts the contiguous score is lower.

**Call relations**: It exercises the score-window calculation in `fuzzy_match`, showing how extra span increases the score while the prefix bonus applies to both examples.

*Call graph*: calls 1 internal fn (fuzzy_match); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::start_of_string_bonus_applies`  (lines 120–134)

```
fn start_of_string_bonus_applies()
```

**Purpose**: Checks that otherwise equivalent contiguous matches are ranked differently depending on whether they start at the beginning of the string. This locks in the strong prefix preference.

**Data flow**: The test calls `fuzzy_match("file_name", "file")` and `fuzzy_match("my_file_name", "file")`, unwraps both results, and asserts scores `-100` and `0`, plus the ordering relation.

**Call relations**: It specifically validates the branch in `fuzzy_match` that subtracts 100 when the first lowered match position is zero.

*Call graph*: calls 1 internal fn (fuzzy_match); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::empty_needle_matches_with_max_score_and_no_indices`  (lines 137–144)

```
fn empty_needle_matches_with_max_score_and_no_indices()
```

**Purpose**: Verifies the special-case behavior for an empty needle. The matcher treats it as a successful match with no highlights and the maximal score.

**Data flow**: The test calls `fuzzy_match("anything", "")`, unwraps the `Some` result or panics, then asserts that the indices vector is empty and the score equals `i32::MAX`.

**Call relations**: It covers the early-return branch at the top of `fuzzy_match` for empty needles.

*Call graph*: calls 1 internal fn (fuzzy_match); 3 external calls (assert!, assert_eq!, panic!).


##### `tests::case_insensitive_matching_basic`  (lines 147–155)

```
fn case_insensitive_matching_basic()
```

**Purpose**: Confirms that matching ignores case differences while still returning original-character indices. It also checks that a contiguous prefix match gets the strongest score.

**Data flow**: The test calls `fuzzy_match("FooBar", "foO")`, unwraps the result or panics, and asserts indices `[0, 1, 2]` and score `-100`.

**Call relations**: It exercises the lowercasing-based matching path in `fuzzy_match` on ordinary ASCII case differences.

*Call graph*: calls 1 internal fn (fuzzy_match); 2 external calls (assert_eq!, panic!).


##### `tests::indices_are_deduped_for_multichar_lowercase_expansion`  (lines 158–167)

```
fn indices_are_deduped_for_multichar_lowercase_expansion()
```

**Purpose**: Verifies that when one original character lowercases into multiple characters and both are matched, the returned highlight indices are deduplicated. This prevents duplicate highlighting of the same original character.

**Data flow**: The test builds a needle consisting of `i` plus combining dot above, calls `fuzzy_match("İ", needle)`, unwraps the result or panics, and asserts indices `[0]` and score `-100`.

**Call relations**: It targets the final `sort_unstable` and `dedup` steps in `fuzzy_match`, which collapse multiple lowered hits back to one original character index.

*Call graph*: calls 1 internal fn (fuzzy_match); 2 external calls (assert_eq!, panic!).


### `hooks/src/events/common.rs`

`util` · `cross-cutting during hook selection, execution, and result aggregation`

This module contains cross-cutting event utilities rather than one event’s business logic. `SubagentHookContext` carries `agent_id` and `agent_type` so normal hooks can serialize subagent metadata when running inside a spawned thread. Several helpers normalize text and transcript output: `join_text_chunks` joins multiple feedback strings with blank lines, `trimmed_non_empty` discards whitespace-only messages, `append_additional_context` records model-facing context both in transcript entries and in an accumulator vector, and `flatten_additional_contexts` merges per-handler context slices into one ordered list.

The file also standardizes synthetic failure reporting. `serialization_failure_hook_events` creates `HookCompletedEvent` values for handlers whose stdin could not be serialized, marking runs failed with zero duration and one `Error` entry; the tool-use variant appends the tool-use suffix to run IDs via `hook_completed_for_tool_use` and `hook_run_for_tool_use`. This keeps preview IDs and completed IDs aligned.

Matcher logic is another key responsibility. `matcher_pattern_for_event` strips matchers from unsupported events (`UserPromptSubmit`, `Stop`) while preserving them for tool, session, subagent, and compact events. `validate_matcher_pattern` fast-paths exact and match-all forms before compiling regexes. `matches_matcher` distinguishes omitted matchers, `*`/empty match-all, exact literal-or-pipe alternatives, and full regex matching. `matcher_inputs` preserves canonical tool name first, then aliases, so preview and execution use the same stable identity while still matching aliases.

#### Function details

##### `join_text_chunks`  (lines 18–24)

```
fn join_text_chunks(chunks: Vec<String>) -> Option<String>
```

**Purpose**: Combines multiple feedback/context strings into one transcript/model message separated by blank lines. Empty input yields no message.

**Data flow**: Takes `Vec<String>` → if empty returns `None`; otherwise joins elements with `"\n\n"` and returns `Some(joined)`.

**Call relations**: Used by event runners when aggregating multiple handler feedback strings into one outward-facing message.

*Call graph*: called by 2 (run, aggregate_results).


##### `trimmed_non_empty`  (lines 26–33)

```
fn trimmed_non_empty(text: &str) -> Option<String>
```

**Purpose**: Normalizes stderr or reason text by trimming whitespace and rejecting empty results. It prevents blank strings from being treated as meaningful feedback.

**Data flow**: Reads `&str`, trims it, and returns `Some(trimmed.to_string())` only if non-empty; otherwise returns `None`.

**Call relations**: Called by multiple completion parsers when interpreting stderr-based block/deny messages or optional reason fields.

*Call graph*: called by 7 (parse_completed, parse_pre_completed, parse_completed, parse_completed, parse_completed, parse_completed, parse_completed).


##### `append_additional_context`  (lines 35–45)

```
fn append_additional_context(
    entries: &mut Vec<HookOutputEntry>,
    additional_contexts_for_model: &mut Vec<String>,
    additional_context: String,
)
```

**Purpose**: Records one additional-context string in both transcript-visible entries and the model-facing accumulator. It keeps those two outputs synchronized.

**Data flow**: Takes mutable `entries`, mutable `additional_contexts_for_model`, and an owned context string → pushes a `HookOutputEntry { kind: Context, text: clone }` into `entries` and the original string into the model accumulator.

**Call relations**: Used by event completion parsers that support `additionalContext`, so they emit the same context to transcript and downstream model state.

*Call graph*: called by 4 (parse_completed, parse_completed, parse_completed, parse_completed).


##### `flatten_additional_contexts`  (lines 47–54)

```
fn flatten_additional_contexts(
    additional_contexts: impl IntoIterator<Item = &'a [String]>,
) -> Vec<String>
```

**Purpose**: Flattens per-handler additional-context slices into one ordered vector. It preserves handler order while removing one level of grouping.

**Data flow**: Consumes any iterator of `&[String]` slices → iterates each slice, clones each string, and collects them into a single `Vec<String>`.

**Call relations**: Called by event runners after all handlers complete to build the final outcome’s `additional_contexts` field.

*Call graph*: called by 4 (run, run, run, run); 1 external calls (into_iter).


##### `serialization_failure_hook_events`  (lines 56–78)

```
fn serialization_failure_hook_events(
    handlers: Vec<ConfiguredHandler>,
    turn_id: Option<String>,
    error_message: String,
) -> Vec<HookCompletedEvent>
```

**Purpose**: Synthesizes failed `HookCompletedEvent` values for handlers that could not be executed because stdin serialization failed. It mirrors a normal completed run summary closely enough for UI/transcript consumers.

**Data flow**: Takes matched `ConfiguredHandler`s, optional `turn_id`, and an error message → for each handler creates a running summary, mutates it to `Failed`, sets `completed_at = started_at`, `duration_ms = 0`, and one `Error` entry with the shared message → wraps each run in `HookCompletedEvent` and returns the vector.

**Call relations**: Used by several event runners on the early-return path when building command input JSON fails before process execution.

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

**Purpose**: Adds tool-use-specific run ID suffixing to synthetic serialization-failure events. This keeps failed pre/post/permission-request runs aligned with preview IDs.

**Data flow**: Calls `serialization_failure_hook_events` with handlers, turn ID, and error message → maps each event through `hook_completed_for_tool_use(tool_use_id)` → returns the rewritten events.

**Call relations**: Used by tool-use-related event runners and corresponding tests that verify run ID consistency.

*Call graph*: calls 1 internal fn (serialization_failure_hook_events); called by 5 (run, run, serialization_failure_run_ids_include_tool_use_id, run, serialization_failure_run_ids_include_tool_use_id).


##### `hook_completed_for_tool_use`  (lines 92–98)

```
fn hook_completed_for_tool_use(
    mut event: HookCompletedEvent,
    tool_use_id: &str,
) -> HookCompletedEvent
```

**Purpose**: Rewrites a completed hook event so its run ID includes the tool-use suffix. It mutates only the nested run summary.

**Data flow**: Takes a `HookCompletedEvent` and `tool_use_id` → replaces `event.run` with `hook_run_for_tool_use(event.run, tool_use_id)` → returns the modified event.

**Call relations**: Called when converting parsed handler completions into final tool-use event outputs and by tests checking preview/completed ID parity.

*Call graph*: calls 1 internal fn (hook_run_for_tool_use); called by 2 (preview_and_completed_run_ids_include_tool_use_id, preview_and_completed_run_ids_include_tool_use_id).


##### `hook_run_for_tool_use`  (lines 100–103)

```
fn hook_run_for_tool_use(mut run: HookRunSummary, tool_use_id: &str) -> HookRunSummary
```

**Purpose**: Appends `:<tool_use_id>` to a `HookRunSummary` ID. This disambiguates repeated hook executions tied to different tool calls.

**Data flow**: Takes a mutable `HookRunSummary` and tool-use ID → formats `run.id = "{old_id}:{tool_use_id}"` → returns the updated run.

**Call relations**: Used by both preview and completed-event rewriting for tool-use-scoped hook events.

*Call graph*: called by 1 (hook_completed_for_tool_use); 1 external calls (format!).


##### `matcher_pattern_for_event`  (lines 105–120)

```
fn matcher_pattern_for_event(
    event_name: HookEventName,
    matcher: Option<&str>,
) -> Option<&str>
```

**Purpose**: Determines whether a matcher string is meaningful for a given hook event. Some events ignore matchers entirely.

**Data flow**: Takes `HookEventName` and optional matcher string → returns the matcher unchanged for tool/session/subagent/compact events, but returns `None` for `UserPromptSubmit` and `Stop`.

**Call relations**: Used during handler discovery/append logic so unsupported events do not retain meaningless matcher patterns.

*Call graph*: called by 1 (append_matcher_groups).


##### `validate_matcher_pattern`  (lines 122–127)

```
fn validate_matcher_pattern(matcher: &str) -> Result<(), regex::Error>
```

**Purpose**: Validates a matcher string according to the engine’s matcher grammar. Exact and match-all forms are accepted without regex compilation.

**Data flow**: Reads matcher text → if `is_match_all_matcher` or `is_exact_matcher`, returns `Ok(())` immediately → otherwise attempts `regex::Regex::new(matcher)` and maps success to `Ok(())` or returns the regex error.

**Call relations**: Called during handler discovery when matcher patterns are loaded from config or plugin sources.

*Call graph*: calls 2 internal fn (is_exact_matcher, is_match_all_matcher); called by 1 (append_matcher_groups); 1 external calls (new).


##### `matches_matcher`  (lines 129–144)

```
fn matches_matcher(matcher: Option<&str>, input: Option<&str>) -> bool
```

**Purpose**: Evaluates whether one candidate input matches a configured matcher using the engine’s exact/match-all/regex rules. Invalid regexes fail closed.

**Data flow**: Takes optional matcher and optional input → returns true for `None`, empty string, or `*`; for exact matchers, splits on `|` and compares candidates literally; otherwise compiles the matcher as regex and tests `is_match(input)` if both regex compilation and input are present → returns false on missing input or invalid regex.

**Call relations**: Used by selection logic to decide whether a handler applies to a tool/event input.

*Call graph*: calls 2 internal fn (is_exact_matcher, is_match_all_matcher).


##### `matcher_inputs`  (lines 146–155)

```
fn matcher_inputs(
    tool_name: &'a str,
    matcher_aliases: &'a [String],
) -> Vec<&'a str>
```

**Purpose**: Builds the ordered list of matcher candidates for a tool invocation, keeping the canonical tool name first and aliases after it. This preserves stable identity while still allowing alias matches.

**Data flow**: Takes `tool_name` and slice of alias strings → creates an iterator starting with `tool_name`, chains alias `&str`s, collects into `Vec<&str>`, and returns it.

**Call relations**: Called by preview and run paths for tool-related events before delegating to dispatcher selection over matcher inputs.

*Call graph*: called by 6 (preview, run, preview, run, preview, run); 1 external calls (once).


##### `is_match_all_matcher`  (lines 157–159)

```
fn is_match_all_matcher(matcher: &str) -> bool
```

**Purpose**: Recognizes the special matcher forms that mean 'match everything'. These are the empty string and `*`.

**Data flow**: Checks whether the matcher string is empty or exactly `*` → returns a boolean.

**Call relations**: Used internally by matcher validation and matching to fast-path universal matchers.

*Call graph*: called by 2 (matches_matcher, validate_matcher_pattern).


##### `is_exact_matcher`  (lines 161–165)

```
fn is_exact_matcher(matcher: &str) -> bool
```

**Purpose**: Recognizes literal matcher syntax that should use exact string comparison instead of regex semantics. Allowed characters are ASCII alphanumerics, underscore, and pipe.

**Data flow**: Iterates matcher characters and returns true only if every character is ASCII alphanumeric, `_`, or `|`.

**Call relations**: Used by matcher validation and matching to distinguish exact-match syntax from regex syntax.

*Call graph*: called by 2 (matches_matcher, validate_matcher_pattern).


##### `tests::matcher_omitted_matches_all_occurrences`  (lines 177–180)

```
fn matcher_omitted_matches_all_occurrences()
```

**Purpose**: Tests that an omitted matcher applies to any input. This is the default matching behavior.

**Data flow**: Calls `matches_matcher(None, Some(...))` for two tool names → asserts both are true.

**Call relations**: Covers the `None` branch of `matches_matcher`.

*Call graph*: 1 external calls (assert!).


##### `tests::matcher_star_matches_all_occurrences`  (lines 183–187)

```
fn matcher_star_matches_all_occurrences()
```

**Purpose**: Tests that `*` matches all inputs and validates successfully. It covers the explicit match-all syntax.

**Data flow**: Calls `matches_matcher(Some("*"), ...)` for two inputs and `validate_matcher_pattern("*")` → asserts both matches are true and validation returns `Ok(())`.

**Call relations**: Exercises both matching and validation fast paths for match-all syntax.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::matcher_empty_string_matches_all_occurrences`  (lines 190–194)

```
fn matcher_empty_string_matches_all_occurrences()
```

**Purpose**: Tests that the empty-string matcher also means match-all. This mirrors the `*` behavior.

**Data flow**: Calls `matches_matcher(Some(""), ...)` for two inputs and validates the empty string → asserts universal matching and successful validation.

**Call relations**: Covers the alternate match-all representation.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::exact_matcher_supports_pipe_alternatives`  (lines 197–202)

```
fn exact_matcher_supports_pipe_alternatives()
```

**Purpose**: Tests exact-match syntax with `|` alternatives. It should match listed literals only and validate without regex compilation.

**Data flow**: Evaluates `matches_matcher(Some("Edit|Write"), ...)` against matching and non-matching inputs and validates the pattern → asserts expected booleans and `Ok(())`.

**Call relations**: Exercises the exact-matcher branch that splits on `|`.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::literal_matcher_uses_exact_matching`  (lines 205–217)

```
fn literal_matcher_uses_exact_matching()
```

**Purpose**: Tests that plain literal matchers do not behave like prefix regexes. Exact equality is required, including for MCP-style names.

**Data flow**: Runs `matches_matcher` with literal patterns like `Bash` and `mcp__memory` against exact and longer inputs, then validates one literal pattern → asserts exact-only behavior.

**Call relations**: Covers the exact-literal branch and guards against accidental regex interpretation.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::matcher_uses_regex_when_it_contains_regex_characters`  (lines 220–223)

```
fn matcher_uses_regex_when_it_contains_regex_characters()
```

**Purpose**: Tests that patterns containing regex metacharacters are treated as regexes. Prefix regex matching should work.

**Data flow**: Calls `matches_matcher(Some("^Bash"), Some("BashOutput"))` and validates the same pattern → asserts regex matching and successful validation.

**Call relations**: Exercises the regex branch of matcher handling.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::mcp_matchers_support_regex_wildcards`  (lines 226–240)

```
fn mcp_matchers_support_regex_wildcards()
```

**Purpose**: Tests regex matching for MCP-style tool names with wildcard segments. It verifies both positive and negative cases.

**Data flow**: Evaluates regex patterns like `mcp__memory__.*` and `mcp__.*__write.*` against matching and non-matching MCP tool names, then validates one pattern → asserts expected results.

**Call relations**: Further covers regex matcher behavior on realistic MCP naming patterns.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::matcher_supports_anchored_regexes`  (lines 243–247)

```
fn matcher_supports_anchored_regexes()
```

**Purpose**: Tests anchored regex matching so exact regexes like `^Bash$` behave as expected. It distinguishes exact regex from prefix matching.

**Data flow**: Calls `matches_matcher(Some("^Bash$"), ...)` for exact and non-exact inputs and validates the pattern → asserts only the exact input matches.

**Call relations**: Exercises anchored regex semantics in the regex branch.

*Call graph*: 2 external calls (assert!, assert_eq!).


##### `tests::invalid_regex_is_rejected`  (lines 250–253)

```
fn invalid_regex_is_rejected()
```

**Purpose**: Tests that invalid regex syntax is rejected by validation and does not match at runtime. Invalid patterns fail closed.

**Data flow**: Calls `validate_matcher_pattern("[")` and `matches_matcher(Some("["), Some("Bash"))` → asserts validation errors and runtime non-match.

**Call relations**: Covers the invalid-regex path in both validation and matching.

*Call graph*: 1 external calls (assert!).


##### `tests::unsupported_events_ignore_matchers`  (lines 256–265)

```
fn unsupported_events_ignore_matchers()
```

**Purpose**: Tests that `UserPromptSubmit` and `Stop` discard configured matcher patterns. These events are intentionally unmatchered.

**Data flow**: Calls `matcher_pattern_for_event` with unsupported event names and non-empty matcher strings → asserts the result is `None` in both cases.

**Call relations**: Exercises the event-filtering logic used during handler discovery.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::supported_events_keep_matchers`  (lines 268–289)

```
fn supported_events_keep_matchers()
```

**Purpose**: Tests that supported events preserve their matcher strings unchanged. This includes tool, session, and compact events.

**Data flow**: Calls `matcher_pattern_for_event` for several supported `HookEventName` values with representative matcher strings → asserts each returns `Some(original_matcher)`.

**Call relations**: Complements the unsupported-events test by covering the pass-through branches.

*Call graph*: 1 external calls (assert_eq!).

## 📊 State Registers Touched

- `reg-process-environment` — The process-wide environment and argv/arg0-derived execution context that shapes binary dispatch, bootstrap aliases, and inherited subprocess state.
- `reg-file-watch-state` — The long-lived filesystem watch registrations and invalidation state used by skill/plugin/runtime watchers to refresh cached resources when local files change.
