# Model request shaping, prompt assembly, and runtime model-selection suites  `stage-23.2.4.3`

This stage is the “packing and routing” part of the system. Before Codex asks a model for help, it must decide what to send, how to lay it out, and sometimes which model should answer. These tests check that the request is built correctly and stays correct as settings, threads, and models change.

Several files focus on what gets injected into the prompt, meaning the text and structured input the model actually sees. That includes extra context, AGENTS.md instruction files, collaboration guidance, hierarchical child-agent rules, selected repository skills, personality settings, permission messages, and token-budget notes. Prompt layout and debugging tests make sure all these pieces appear in the right order and survive resume, fork, and multi-environment flows. Prompt-caching tests check that reusable prefixes stay stable instead of being rebuilt unnecessarily.

Other files check provider-facing request shaping. They verify JSON schema output requests, web-search tool configuration, and the exact request payload sent over the network. Finally, remote-model, runtime-selector, auto-review, and model-switching tests make sure metadata from a remote catalog can change behavior safely, including tool modes, review-model overrides, and how history is rewritten when switching models.

## Files in this stage

### Context and instruction injection
These tests cover how supplemental instructions and repository-derived context are discovered, merged, and injected into model-visible prompts across turns and thread lifecycles.

### `core/tests/suite/additional_context.rs`

`test` · `integration test execution during turn submission and request assembly`

Each test builds a `TestCodex` fixture with `include_environment_context = false` so only the explicitly supplied `additional_context` affects the request. The suite distinguishes between conversation history items and model-only context injection. In the first test, a turn includes both untrusted (`browser_info`) and application (`automation_info`) context; the emitted `TurnItem::UserMessage` contains only the actual user text, while the captured request shows `<external_browser_info>...` inserted as a user-role message and `<automation_info>...` inserted as a developer-role message before the user prompt. A companion test proves that literal user text like `<external_api>` remains ordinary user content when passed as `UserInput`, preventing accidental reinterpretation. The trust-role mapping is then rechecked directly. Two multi-turn tests pin retention semantics: repeated identical context is not duplicated between turns while still retained in history, but removing one key and adding another causes only the newly introduced value to be inserted on the next turn; if a previously removed value reappears later, it is reinserted. The final test stresses truncation by sending 40 KB values for both application and untrusted context and asserting the serialized tags preserve head and tail fragments, include a `tokens truncated` marker, and stay under a 5 KiB cap. Together these tests define the exact model-visible shape of additional context over time.

#### Function details

##### `additional_context_is_model_visible_but_not_a_user_message_item`  (lines 24–115)

```
async fn additional_context_is_model_visible_but_not_a_user_message_item() -> Result<()>
```

**Purpose**: Shows that `additional_context` is injected into the model request but does not become part of the persisted `TurnItem::UserMessage`. It also verifies the split between developer-role application context and user-role untrusted external context.

**Data flow**: Starts a mock SSE server and one-shot response, builds a `TestCodex` with environment context disabled, submits `Op::UserInput` containing one text item plus a `BTreeMap` with `browser_info` as `Untrusted` and `automation_info` as `Application`, waits for an `ItemCompletedEvent` carrying `TurnItem::UserMessage`, asserts that item contains only the original user text, waits for `TurnComplete`, then inspects the recorded request, snapshots it, filters developer texts for `<automation_info>...`, and asserts exact developer and user message sequences → returns `Result<()>`.

**Call relations**: The Tokio test harness invokes this as the foundational additional-context behavior test. It uses `wait_for_event_match` both to inspect the internal item stream and to synchronize until the outbound request has been fully produced.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (from, default, assert_eq!, wait_for_event_match, assert_snapshot!, skip_if_no_network!, vec!).


##### `external_context_like_user_text_remains_a_user_message_item`  (lines 118–164)

```
async fn external_context_like_user_text_remains_a_user_message_item() -> Result<()>
```

**Purpose**: Ensures that user text which merely resembles an external-context tag is not reclassified as additional context. This protects literal user input from being rewritten based on tag-like syntax.

**Data flow**: Creates a mock server and response, builds a `TestCodex` with environment context disabled, defines `user_input = UserInput::Text { text: "<external_api>", ... }`, submits it with an empty `additional_context` map, waits for the completed `TurnItem::UserMessage`, asserts the item content equals the original `user_input`, waits for `TurnComplete`, and then asserts the recorded request's user texts are exactly `["<external_api>"]` → returns `Result<()>`.

**Call relations**: This direct harness test complements the first one by covering the negative case: only explicit `additional_context` entries are transformed into tagged context messages, while ordinary user input remains untouched.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (new, default, new, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `additional_context_trust_controls_message_role`  (lines 167–232)

```
async fn additional_context_trust_controls_message_role() -> Result<()>
```

**Purpose**: Verifies that `AdditionalContextKind` determines which message role receives the injected context. Untrusted values must appear as user-role external context, while application values must appear as developer-role context.

**Data flow**: Starts a mock server, mounts a one-shot SSE response, builds a `TestCodex`, submits a turn with one user text plus `browser_info` as `Untrusted` and `automation_info` as `Application`, waits for `TurnComplete`, then inspects the single recorded request and asserts the developer texts contain `<automation_info>run one</automation_info>` while the user texts contain `<external_browser_info>tab one</external_browser_info>` followed by the actual prompt → returns `Result<()>`.

**Call relations**: The harness invokes this as a narrower role-mapping test. It overlaps with the first test's assertions but omits internal item inspection, focusing purely on the outbound request shape.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (from, default, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `additional_context_is_deduplicated_between_turns_while_retained`  (lines 235–312)

```
async fn additional_context_is_deduplicated_between_turns_while_retained() -> Result<()>
```

**Purpose**: Checks that identical additional-context values are retained across turns without being reinserted redundantly. The second turn should still include the earlier context in history, but only once.

**Data flow**: Mounts two one-shot SSE responses, builds a `TestCodex`, prepares a reusable `BTreeMap` containing one untrusted `browser_info` entry, submits a first turn with that context and waits for completion, then submits a second turn with the same context and waits again. Finally it inspects both recorded requests: the first must contain external browser context plus `first turn`, and the second must contain the same external browser context once, followed by `first turn` and `second turn` → returns `Result<()>`.

**Call relations**: This test is called directly by the harness to pin multi-turn retention semantics. It depends on sequential request capture to compare how the same context key/value is represented across turns.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (from, default, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `additional_context_removes_one_value_while_adding_another`  (lines 315–474)

```
async fn additional_context_removes_one_value_while_adding_another() -> Result<()>
```

**Purpose**: Exercises the incremental update rules when the set of additional-context entries changes between turns. It proves that newly introduced values are inserted, removed values are not repeated, and reintroduced values appear again when they come back.

**Data flow**: Mounts three one-shot SSE responses, builds a `TestCodex`, submits a first turn with untrusted `automation_info` and `browser_info`, waits for completion, submits a second turn with `automation_info` retained but `browser_info` removed and `terminal_info` added, waits again, then submits a third turn with all three entries present and waits again. It inspects each recorded request and asserts the exact user-text sequences, showing initial insertion of automation/browser, later insertion of terminal only, and reinsertion of browser on the third turn → returns `Result<()>`.

**Call relations**: The harness invokes this as the most detailed state-transition test in the file. It extends the deduplication case by covering both removal and re-addition, using three captured requests to make the history evolution explicit.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (from, default, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `additional_context_values_are_truncated_before_model_input`  (lines 477–572)

```
async fn additional_context_values_are_truncated_before_model_input() -> Result<()>
```

**Purpose**: Verifies that oversized additional-context values are truncated before being sent to the model, while preserving recognizable prefixes and suffixes and marking the truncation. It checks both developer-role application context and user-role untrusted context against a byte-size cap.

**Data flow**: Starts a mock server and response, builds a `TestCodex`, constructs two very long strings (`long_browser_value` and `long_automation_value`) plus their untruncated tagged forms for comparison, submits a turn with those values as `browser_info` (`Untrusted`) and `automation_info` (`Application`), waits for `TurnComplete`, then inspects the recorded request. It extracts the developer `<automation_info>` text and user `<external_browser_info>` text, asserting each starts with the expected head fragment, contains `tokens truncated`, ends with the original tail fragment, is shorter than the untruncated version, and does not exceed `MAX_EXPECTED_EXTERNAL_CONTEXT_TEXT_BYTES`; it also asserts the actual user prompt remains present → returns `Result<()>`.

**Call relations**: This direct harness test covers the size-limiting branch of additional-context serialization. It complements the earlier semantic tests by proving that context injection is bounded before request transmission.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 9 external calls (from, default, assert!, assert_eq!, wait_for_event_match, format!, panic!, skip_if_no_network!, vec!).


### `core/tests/suite/agents_md.rs`

`test` · `thread creation, turn submission, resume/fork, and subagent spawning during integration tests`

This file is a dense integration suite for instruction-source behavior. It defines constants for global/project instruction text and helper functions to write global files, extract rendered `# AGENTS.md instructions` fragments from captured requests, build expected fragments, and submit turns directly to `CodexThread`. The central pattern is to stand up a mock SSE server, build a `TestCodexBuilder` with specific home/workspace/environment setup, submit one or more turns, and inspect either `instruction_sources()` or the actual request payload sent to the model.

Coverage spans precedence (`AGENTS.override.md` over `AGENTS.md`), fallback filenames when `AGENTS.md` is a directory, concatenation from project root to nested cwd, and lexical-parent discovery when cwd is a symlink. It also checks environment-sensitive composition: global instructions plus selected project docs, including threads with no primary environment and threads spanning remote and local environments. A major design invariant under test is snapshotting: fresh threads cache creation-time rendered instructions and source ordering, so later file mutations do not alter ordinary subsequent turns; cold resume and fork intentionally diverge, reporting newly loaded source paths while replaying the original structured instruction prefix from history. The subagent tests extend that invariant to spawned children, asserting exactly one inherited global-instruction fragment and distinguishing forked-context children from fresh-context children. Helpers like `request_body_contains` transparently decode zstd-compressed requests so matcher closures remain robust.

#### Function details

##### `agents_instructions`  (lines 53–70)

```
async fn agents_instructions(mut builder: TestCodexBuilder) -> Result<String>
```

**Purpose**: Builds a test Codex instance, submits one turn, and returns the rendered AGENTS instruction message that was sent to the model. It is a convenience wrapper for tests that only care about the final instruction text.

**Data flow**: Accepts a configured `TestCodexBuilder`, starts a mock server, mounts a one-shot empty SSE completion, builds the harness with a remote environment, submits `hello`, then inspects the single captured request. From the request’s user messages it finds the first text starting with `# AGENTS.md instructions` and returns it as `String`, or returns an `anyhow!` error if absent.

**Call relations**: Several simpler discovery tests call this helper instead of repeating server setup and request extraction. It delegates the actual instruction rendering to the system under test and only extracts the resulting message.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, build_with_remote_env); called by 3 (agents_docs_are_concatenated_from_project_root_to_cwd, agents_override_is_preferred_over_agents_md, configured_fallback_is_used_when_agents_candidate_is_directory); 1 external calls (vec!).


##### `write_global_file`  (lines 72–80)

```
fn write_global_file(
    home: &TempDir,
    filename: &str,
    contents: impl AsRef<[u8]>,
) -> Result<AbsolutePathBuf>
```

**Purpose**: Writes a named instruction file into the temporary Codex home and returns its absolute path. Tests use it to create or mutate global AGENTS sources while preserving path identity.

**Data flow**: Takes a `TempDir`, a filename, and arbitrary byte-like contents, joins the filename under `home.path()`, writes the bytes with `std::fs::write`, converts the resulting path to `AbsolutePathBuf`, and returns it.

**Call relations**: Many tests call this helper when setting up global `AGENTS.md` or `AGENTS.override.md` files, especially snapshotting tests that later compare source paths before and after in-place rewrites.

*Call graph*: called by 7 (cold_resume_replays_rendered_instructions_but_reports_current_config_sources, fork_replays_rendered_instructions_from_shared_history, fresh_thread_composes_global_before_project_and_reports_sources, invalid_utf8_global_instructions_are_lossy, loads_user_instructions_without_a_primary_environment, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot, run_subagent_global_instruction_case); 2 external calls (path, write).


##### `instruction_fragments`  (lines 82–88)

```
fn instruction_fragments(request: &responses::ResponsesRequest) -> Vec<String>
```

**Purpose**: Extracts all rendered AGENTS instruction fragments from a captured Responses request. It filters only the structured user messages that begin with the AGENTS heading.

**Data flow**: Reads all user message texts from a `responses::ResponsesRequest`, keeps only those starting with `# AGENTS.md instructions`, and returns them as a `Vec<String>`.

**Call relations**: Used by tests that need to count or compare exact rendered instruction fragments across multiple turns, especially snapshot and no-primary-environment cases.

*Call graph*: calls 1 internal fn (message_input_texts); called by 2 (fresh_thread_composes_global_before_project_and_reports_sources, loads_user_instructions_without_a_primary_environment).


##### `expected_instruction_fragment`  (lines 90–93)

```
fn expected_instruction_fragment(cwd: &AbsolutePathBuf, contents: &str) -> String
```

**Purpose**: Builds the exact structured instruction fragment expected for cwd-scoped AGENTS rendering. It includes the cwd path in the heading and wraps contents in `<INSTRUCTIONS>` tags.

**Data flow**: Accepts a cwd `AbsolutePathBuf` and instruction contents string, formats `# AGENTS.md instructions for {cwd}\n\n<INSTRUCTIONS>\n{contents}\n</INSTRUCTIONS>`, and returns the resulting `String`.

**Call relations**: Snapshot tests use this helper to compare captured request fragments against the precise serialized format the model should see.

*Call graph*: calls 1 internal fn (as_path); called by 1 (fresh_thread_composes_global_before_project_and_reports_sources); 1 external calls (format!).


##### `expected_provider_only_instruction_fragment`  (lines 95–97)

```
fn expected_provider_only_instruction_fragment(contents: &str) -> String
```

**Purpose**: Builds the exact structured instruction fragment expected when only provider/global instructions are present and no cwd-specific heading is used.

**Data flow**: Formats `# AGENTS.md instructions\n\n<INSTRUCTIONS>\n{contents}\n</INSTRUCTIONS>` from the supplied contents string and returns it.

**Call relations**: Used by tests covering provider-only global instructions, lossy UTF-8 decoding, resume/fork replay, and subagent inheritance.

*Call graph*: called by 4 (cold_resume_replays_rendered_instructions_but_reports_current_config_sources, fork_replays_rendered_instructions_from_shared_history, invalid_utf8_global_instructions_are_lossy, run_subagent_global_instruction_case); 1 external calls (format!).


##### `assert_single_instruction_fragment`  (lines 99–101)

```
fn assert_single_instruction_fragment(request: &responses::ResponsesRequest, expected: &str)
```

**Purpose**: Asserts that a captured request contains exactly one AGENTS instruction fragment and that it matches an expected string exactly.

**Data flow**: Calls `instruction_fragments` indirectly via the request helper path and compares the resulting vector to a one-element vector containing `expected.to_string()` using `assert_eq!`.

**Call relations**: Many tests use this as a concise assertion for the invariant that AGENTS instructions should appear exactly once in model-visible input.

*Call graph*: called by 6 (cold_resume_replays_rendered_instructions_but_reports_current_config_sources, fork_replays_rendered_instructions_from_shared_history, fresh_thread_composes_global_before_project_and_reports_sources, invalid_utf8_global_instructions_are_lossy, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot, run_subagent_global_instruction_case); 1 external calls (assert_eq!).


##### `submit_thread_turn`  (lines 103–118)

```
async fn submit_thread_turn(thread: &Arc<codex_core::CodexThread>, prompt: &str) -> Result<()>
```

**Purpose**: Submits a plain text user turn directly to an existing `CodexThread` and waits for completion. It avoids rebuilding the full harness when tests already hold a thread handle.

**Data flow**: Takes an `Arc<CodexThread>` and prompt text, submits `Op::UserInput` with one `UserInput::Text`, default additional context and thread settings, awaits the submit future, then waits until `wait_for_event` observes `EventMsg::TurnComplete(_)`, returning `Ok(())`.

**Call relations**: The multi-environment snapshot test uses this helper to drive repeated turns on a manually created thread after asserting its initial instruction sources.

*Call graph*: called by 1 (multi_environment_thread_loads_every_project_and_keeps_creation_snapshot); 3 external calls (default, wait_for_event, vec!).


##### `request_body_contains`  (lines 120–137)

```
fn request_body_contains(request: &wiremock::Request, text: &str) -> bool
```

**Purpose**: Checks whether a raw wiremock request body contains a given substring, transparently handling optional zstd compression. It is used by matcher closures that route different mocked SSE responses to different prompts.

**Data flow**: Inspects the `content-encoding` header for `zstd`, optionally decodes the body bytes with `zstd::stream::decode_all`, converts the resulting bytes to UTF-8 `String` if possible, and returns whether that string contains the target substring.

**Call relations**: Only matcher-based subagent tests use this helper, because they need to distinguish parent seed, spawn, child, and follow-up requests by body content.

*Call graph*: calls 1 internal fn (new); 1 external calls (decode_all).


##### `agents_override_is_preferred_over_agents_md`  (lines 140–171)

```
async fn agents_override_is_preferred_over_agents_md() -> Result<()>
```

**Purpose**: Verifies that `AGENTS.override.md` wins over `AGENTS.md` when both exist in the workspace. The model-visible instructions should include only the override contents.

**Data flow**: Builds a workspace setup that writes both files, calls `agents_instructions`, then asserts the returned instruction text contains `override doc` and does not contain `base doc`.

**Call relations**: This top-level test delegates setup and extraction to `agents_instructions`; its role is to validate precedence rules in instruction discovery.

*Call graph*: calls 2 internal fn (test_codex, agents_instructions); 2 external calls (assert!, skip_if_wine_exec!).


##### `configured_fallback_is_used_when_agents_candidate_is_directory`  (lines 174–210)

```
async fn configured_fallback_is_used_when_agents_candidate_is_directory() -> Result<()>
```

**Purpose**: Checks that when `AGENTS.md` exists as a directory rather than a file, discovery falls back to a configured alternate filename. It confirms the fallback file’s contents reach the model.

**Data flow**: Configures `project_doc_fallback_filenames = ["WORKFLOW.md"]`, creates a directory at `AGENTS.md` and a file `WORKFLOW.md`, calls `agents_instructions`, and asserts the resulting instruction text contains `fallback doc`.

**Call relations**: This test uses the shared helper to focus specifically on the edge case where the preferred candidate path is not a readable file.

*Call graph*: calls 2 internal fn (test_codex, agents_instructions); 2 external calls (assert!, skip_if_wine_exec!).


##### `agents_docs_are_concatenated_from_project_root_to_cwd`  (lines 213–274)

```
async fn agents_docs_are_concatenated_from_project_root_to_cwd() -> Result<()>
```

**Purpose**: Verifies that project instruction files are discovered from repository root down to the current working directory and concatenated in that order. Root instructions must precede nested instructions.

**Data flow**: Configures a nested cwd, creates the nested directory tree, writes a root `.git` marker plus root and nested `AGENTS.md` files, calls `agents_instructions`, finds the positions of `root doc` and `child doc` in the returned string, and asserts the root position is earlier.

**Call relations**: This top-level test exercises hierarchical discovery order using the helper that returns the final rendered instruction message.

*Call graph*: calls 2 internal fn (test_codex, agents_instructions); 1 external calls (assert!).


##### `symlinked_cwd_uses_logical_parent_for_agents_discovery`  (lines 277–354)

```
async fn symlinked_cwd_uses_logical_parent_for_agents_discovery() -> Result<()>
```

**Purpose**: Ensures AGENTS discovery walks the lexical/logical cwd path rather than the physical symlink target’s parent chain. It also confirms opening the cwd-local AGENTS file still follows the symlink into the physical workspace.

**Data flow**: Creates a logical repo and a physical repo, writes `.git` and `AGENTS.md` files in both, creates a directory symlink from `logical-repo/workspace` to `physical-repo/workspace`, builds the harness with cwd set to the logical path, and asserts `instruction_sources()` contains only the logical parent AGENTS file and the cwd AGENTS file. After submitting a turn, it extracts the instruction message from the captured request and asserts it contains `logical parent doc` and `workspace doc` but not `physical parent doc`.

**Call relations**: This test directly inspects both the API-level source list and the model-visible rendered text to prove the distinction between discovery path traversal and file opening semantics.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (assert!, assert_eq!, vec!).


##### `selected_environment_sources_match_model_visible_instructions`  (lines 357–401)

```
async fn selected_environment_sources_match_model_visible_instructions() -> Result<()>
```

**Purpose**: Checks that the instruction source list reported by the thread matches the actual global-plus-project instructions visible to the model for the selected environment. It validates both ordering and concatenation separator behavior.

**Data flow**: Creates a temporary home with global `AGENTS.md`, writes a project `AGENTS.md` in the workspace, builds with a remote environment, computes the expected absolute global and project source paths, asserts `instruction_sources()` returns them in order, submits a turn, extracts the rendered instruction message from the captured request, and asserts it contains `global doc\n\n--- project-doc ---\n\nproject doc`.

**Call relations**: This test bridges the structured API (`instruction_sources`) and the serialized prompt content to ensure they describe the same selected sources.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (new, new, assert!, assert_eq!, skip_if_wine_exec!, write, vec!).


##### `loads_user_instructions_without_a_primary_environment`  (lines 404–483)

```
async fn loads_user_instructions_without_a_primary_environment() -> Result<()>
```

**Purpose**: Verifies that threads started without any environments still load global user instructions from the configured provider, and do not include project instructions. It also checks provider load counts.

**Data flow**: Creates a temp home with global instructions, wraps `CodexHomeUserInstructionsProvider` in a recording provider, builds a harness whose workspace also contains a project AGENTS file, and asserts the provider was loaded once during build. It then starts a thread with `environments: Vec::new()`, asserts the provider load count increased and `instruction_sources()` contains only the global source, submits a direct `Op::UserInput` to that thread, waits for completion, extracts instruction fragments from the captured request, and asserts there is exactly one fragment containing global but not project instructions.

**Call relations**: This test bypasses the default session thread by manually starting a thread with no environments, specifically to exercise the no-primary-environment path in instruction loading.

*Call graph*: calls 9 internal fn (new, mount_sse_once, sse, start_mock_server, new, test_codex, instruction_fragments, write_global_file, try_from); 9 external calls (clone, new, default, new, new, assert!, assert_eq!, wait_for_event, vec!).


##### `fresh_thread_composes_global_before_project_and_reports_sources`  (lines 486–595)

```
async fn fresh_thread_composes_global_before_project_and_reports_sources() -> Result<()>
```

**Purpose**: Checks that a fresh thread snapshots global instructions before project instructions, reports both source paths in that order, and keeps the original rendered prefix across later ordinary turns even if the files are mutated in place.

**Data flow**: Creates a home/global source and workspace/project source, mounts two empty SSE responses, builds the harness, records the expected creation-time source list, submits a first turn, rewrites both source files with new contents while preserving paths, submits a second turn, then inspects both captured requests. It builds the expected original fragment, asserts both requests contain exactly that fragment, verifies global text appears before project text with the separator, confirms `instruction_sources()` still reports the original paths, and checks the second request’s input begins with the first request’s entire input prefix.

**Call relations**: This is a core snapshotting test: it proves ordinary turns reuse the creation-time rendered instruction prefix and source ordering rather than re-reading mutated files.

*Call graph*: calls 8 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_instruction_fragment, instruction_fragments, write_global_file, from_path); 8 external calls (clone, new, new, assert!, assert_eq!, format!, skip_if_wine_exec!, vec!).


##### `multi_environment_thread_loads_every_project_and_keeps_creation_snapshot`  (lines 598–717)

```
async fn multi_environment_thread_loads_every_project_and_keeps_creation_snapshot() -> Result<()>
```

**Purpose**: Verifies that a thread spanning remote and local environments loads global plus each environment’s project instructions, snapshots them at creation time, and keeps that snapshot stable across later file changes.

**Data flow**: Creates global instructions in home, remote project instructions in the harness workspace, and local project instructions in a separate temp dir; wraps the provider to count loads; builds remote+local environments; manually starts a thread with explicit `TurnEnvironmentSelection`s for remote and local roots; asserts provider load count and `instruction_sources()` include global, remote, and local sources in order; submits one turn; rewrites all three locations using override files/new contents; submits a second turn; then asserts both captured requests contain the same expected combined fragment naming each environment root and original contents, provider load count did not increase, and `instruction_sources()` still reports the original creation-time paths.

**Call relations**: This test extends the snapshot invariant to multi-environment threads created manually through `thread_manager.start_thread_with_options`.

*Call graph*: calls 10 internal fn (new, mount_sse_sequence, start_mock_server, new, test_codex, assert_single_instruction_fragment, submit_thread_turn, write_global_file, try_from, from_path); 12 external calls (clone, new, default, new, new, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec! (+2 more)).


##### `invalid_utf8_global_instructions_are_lossy`  (lines 720–748)

```
async fn invalid_utf8_global_instructions_are_lossy() -> Result<()>
```

**Purpose**: Ensures invalid UTF-8 in global instruction files is decoded lossily rather than causing failure. The replacement character should appear in the rendered instruction fragment.

**Data flow**: Writes a global `AGENTS.md` containing invalid byte `0xFF`, builds a harness, submits a turn, asserts `instruction_sources()` contains that source path, constructs the expected provider-only fragment with `global�instructions`, and asserts the captured request contains exactly that fragment.

**Call relations**: This top-level test focuses on text-decoding robustness in the instruction provider path.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_single_instruction_fragment, expected_provider_only_instruction_fragment, write_global_file); 4 external calls (new, new, assert_eq!, vec!).


##### `cold_resume_replays_rendered_instructions_but_reports_current_config_sources`  (lines 753–835)

```
async fn cold_resume_replays_rendered_instructions_but_reports_current_config_sources() -> Result<()>
```

**Purpose**: Checks the intentional mismatch during cold resume: the resumed thread reports newly loaded instruction source paths from current config, but replays the original rendered instruction prefix from persisted history. It documents this current behavior explicitly.

**Data flow**: Creates an initial home with old global instructions, builds an initial harness, asserts its `instruction_sources()` reports the old source, submits a turn to persist the snapshot, captures the rollout path, shuts the thread down, writes a new preferred override source, resumes from the rollout with freshly loaded config, asserts the resumed thread now reports only the new source path, submits another turn, and compares the two captured requests. It asserts the resumed request begins with the initial request’s input prefix and that both requests contain the old provider-only instruction fragment.

**Call relations**: This test exercises the resume path rather than ordinary turns, showing that source reporting is recomputed from config while model-visible history is replayed from persisted rollout data.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_provider_only_instruction_fragment, write_global_file); 7 external calls (clone, new, new, assert_eq!, assert_ne!, wait_for_event, vec!).


##### `fork_replays_rendered_instructions_from_shared_history`  (lines 838–941)

```
async fn fork_replays_rendered_instructions_from_shared_history() -> Result<()>
```

**Purpose**: Verifies the analogous behavior for thread forks: the fork reports current instruction sources from fresh config, but the first forked turn replays the parent’s original rendered instruction prefix from shared history.

**Data flow**: Creates a parent thread with old global instructions, asserts its source list, submits a turn, materializes and flushes rollout, writes a new override source, loads a fresh config mirroring the parent’s runtime settings, forks the thread from the rollout, asserts the fork reports the new source path, submits a user turn directly to the forked thread, and then compares the parent and fork requests. It asserts the fork request begins with the parent request’s input prefix and that both requests contain the old provider-only instruction fragment.

**Call relations**: This test targets `thread_manager.fork_thread`, proving that forked history replay preserves the parent’s creation-time rendered instructions even when the fork’s current config points at different source files.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_provider_only_instruction_fragment, write_global_file); 9 external calls (clone, new, default, new, assert_eq!, assert_ne!, load_default_config_for_test, wait_for_event, vec!).


##### `forked_subagent_replays_one_creation_time_global_instruction_fragment`  (lines 944–947)

```
async fn forked_subagent_replays_one_creation_time_global_instruction_fragment() -> Result<()>
```

**Purpose**: Runs the shared subagent inheritance scenario in fork-context mode. The child should inherit the parent’s creation-time instruction snapshot and replay parent history.

**Data flow**: Skips when network is unavailable, then calls `run_subagent_global_instruction_case(true)` and returns its result.

**Call relations**: This is a thin wrapper test selecting the fork-context branch of the shared subagent scenario helper.

*Call graph*: calls 1 internal fn (run_subagent_global_instruction_case); 1 external calls (skip_if_no_network!).


##### `fresh_subagent_uses_creation_time_instructions_without_parent_history`  (lines 950–953)

```
async fn fresh_subagent_uses_creation_time_instructions_without_parent_history() -> Result<()>
```

**Purpose**: Runs the shared subagent inheritance scenario in fresh-context mode. The child should inherit the parent’s creation-time instruction snapshot but omit parent conversational history.

**Data flow**: Skips when network is unavailable, then calls `run_subagent_global_instruction_case(false)` and returns its result.

**Call relations**: This is the companion wrapper selecting the fresh-context branch of the shared subagent scenario helper.

*Call graph*: calls 1 internal fn (run_subagent_global_instruction_case); 1 external calls (skip_if_no_network!).


##### `run_subagent_global_instruction_case`  (lines 955–1114)

```
async fn run_subagent_global_instruction_case(fork_context: bool) -> Result<()>
```

**Purpose**: Implements the full parent/subagent inheritance scenario for both forked-context and fresh-context children. It verifies that parent and child each render exactly one creation-time global instruction fragment and that child history replay depends on `fork_context`.

**Data flow**: Starts a mock server and mounts four matcher-based SSE responses: one for a seed parent turn, one for the parent spawn turn that emits `multi_agent_v1.spawn_agent`, one for the child turn, and one for the parent follow-up carrying the spawn call output. It writes old global instructions, builds a harness with collaboration enabled and request compression disabled, asserts the parent source list, submits the seed prompt and captures that request, writes a new override source, subscribes to thread-created events, submits the parent spawn prompt, waits for the child thread ID and child request, and captures the spawn request. It then builds the expected provider-only fragment and asserts the seed, spawn, and child requests each contain exactly one copy; asserts the parent and child `instruction_sources()` both still report the original source; and finally either checks that the child input begins with the seed input prefix (`fork_context == true`) or that the child user texts omit the seed prompt and contain the child prompt exactly once (`fork_context == false`).

**Call relations**: Both subagent wrapper tests delegate here. This helper orchestrates the entire multi-turn parent/child flow and ties together request matching, thread creation observation, and instruction/history assertions.

*Call graph*: calls 7 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, assert_single_instruction_fragment, expected_provider_only_instruction_fragment, write_global_file); called by 2 (forked_subagent_replays_one_creation_time_global_instruction_fragment, fresh_subagent_uses_creation_time_instructions_without_parent_history); 12 external calls (clone, new, from_millis, from_secs, new, assert_eq!, assert_ne!, json!, to_string, sleep (+2 more)).


### `core/tests/suite/collaboration_instructions.rs`

`test` · `request handling`

This file tests the prompt-construction rules around `CollaborationMode`. Small helpers build `CollaborationMode` values with a chosen `ModeKind` and optional developer instructions, extract developer-role text spans from a request body, wrap expected instruction text in the protocol’s collaboration XML tags, and count how many developer messages contain a target fragment. The tests then build a `TestCodex`, submit either thread-setting overrides or per-turn `ThreadSettingsOverrides`, and inspect the captured request input sent to the model.

The suite covers several state transitions. By default, no collaboration instructions should be present, though normal permissions instructions still should. A thread-level override should affect later user turns, while a per-turn override should supersede any previously stored thread override. If `include_collaboration_mode_instructions` is disabled in config, the collaboration XML should be omitted entirely. Updating collaboration mode between turns should append a new instruction message only when the effective mode or instruction text changes; no-op updates must not duplicate the message. Resume behavior is also checked: after persisting a thread with collaboration instructions and resuming from rollout, the next request should replay the same collaboration instruction fragment. Finally, empty developer-instruction strings are treated as absent and should not produce an empty tagged message.

#### Function details

##### `collab_mode_with_mode_and_instructions`  (lines 22–34)

```
fn collab_mode_with_mode_and_instructions(
    mode: ModeKind,
    instructions: Option<&str>,
) -> CollaborationMode
```

**Purpose**: Constructs a `CollaborationMode` value with a specific mode and optional developer-instruction text.

**Data flow**: It takes a `ModeKind` and optional `&str`, builds a `CollaborationMode` whose `Settings` contain model `gpt-5.4`, no reasoning effort, and an owned `developer_instructions` string when provided, then returns it.

**Call relations**: This is the base constructor used by the simpler instruction-only helper and by tests that need to vary the collaboration mode itself.

*Call graph*: called by 3 (collab_mode_with_instructions, collaboration_mode_update_emits_new_instruction_message_when_mode_changes, collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged).


##### `collab_mode_with_instructions`  (lines 36–38)

```
fn collab_mode_with_instructions(instructions: Option<&str>) -> CollaborationMode
```

**Purpose**: Constructs a default-mode `CollaborationMode` with optional developer instructions.

**Data flow**: It forwards the optional instruction text to `collab_mode_with_mode_and_instructions` using `ModeKind::Default` and returns the result.

**Call relations**: Most tests use this helper when they only care about instruction text and not mode changes.

*Call graph*: calls 1 internal fn (collab_mode_with_mode_and_instructions); called by 8 (collaboration_instructions_added_on_user_turn, collaboration_instructions_omitted_when_disabled, collaboration_mode_update_emits_new_instruction_message, collaboration_mode_update_noop_does_not_append, override_then_next_turn_uses_updated_collaboration_instructions, resume_replays_collaboration_instructions, user_input_includes_collaboration_instructions_after_override, user_turn_overrides_collaboration_instructions_after_override).


##### `developer_texts`  (lines 40–51)

```
fn developer_texts(input: &[Value]) -> Vec<String>
```

**Purpose**: Extracts all developer-role text spans from a request input array.

**Data flow**: It iterates the input items, filters to `role == "developer"`, flattens each item’s `content` array, reads each `text` field, and returns the collected strings.

**Call relations**: Every assertion in this file uses this helper to inspect the developer messages that the prompt builder emitted.

*Call graph*: called by 12 (collaboration_instructions_added_on_user_turn, collaboration_instructions_omitted_when_disabled, collaboration_mode_update_emits_new_instruction_message, collaboration_mode_update_emits_new_instruction_message_when_mode_changes, collaboration_mode_update_noop_does_not_append, collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged, empty_collaboration_instructions_are_ignored, no_collaboration_instructions_by_default, override_then_next_turn_uses_updated_collaboration_instructions, resume_replays_collaboration_instructions (+2 more)); 1 external calls (iter).


##### `collab_xml`  (lines 53–55)

```
fn collab_xml(text: &str) -> String
```

**Purpose**: Wraps plain collaboration instruction text in the protocol’s collaboration-mode open/close tags.

**Data flow**: It formats a string as `COLLABORATION_MODE_OPEN_TAG + text + COLLABORATION_MODE_CLOSE_TAG` and returns it.

**Call relations**: Tests use this helper to build the exact tagged fragment they expect to find in developer messages.

*Call graph*: called by 10 (collaboration_instructions_added_on_user_turn, collaboration_mode_update_emits_new_instruction_message, collaboration_mode_update_emits_new_instruction_message_when_mode_changes, collaboration_mode_update_noop_does_not_append, collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged, empty_collaboration_instructions_are_ignored, override_then_next_turn_uses_updated_collaboration_instructions, resume_replays_collaboration_instructions, user_input_includes_collaboration_instructions_after_override, user_turn_overrides_collaboration_instructions_after_override); 1 external calls (format!).


##### `count_messages_containing`  (lines 57–59)

```
fn count_messages_containing(texts: &[String], target: &str) -> usize
```

**Purpose**: Counts how many extracted developer messages contain a target substring.

**Data flow**: It scans a slice of strings, filters those containing the target, and returns the count.

**Call relations**: This helper supports the file’s main invariant style: collaboration instructions should appear zero, one, or two times depending on update behavior.


##### `no_collaboration_instructions_by_default`  (lines 62–102)

```
async fn no_collaboration_instructions_by_default() -> Result<()>
```

**Purpose**: Verifies that default requests include permissions instructions but no collaboration-mode instruction fragment.

**Data flow**: It mounts a minimal response, builds a default `TestCodex`, submits a user turn, waits for completion, extracts developer texts from the captured request, asserts one of them contains permissions instructions, and asserts none contain the collaboration open tag.

**Call relations**: This is the baseline test for the file and establishes the default prompt state before any collaboration overrides.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, developer_texts); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `user_input_includes_collaboration_instructions_after_override`  (lines 105–148)

```
async fn user_input_includes_collaboration_instructions_after_override() -> Result<()>
```

**Purpose**: Checks that a thread-settings override applied before a user turn causes the next request to include the collaboration instruction fragment once.

**Data flow**: It builds a default `TestCodex`, submits thread settings with a `CollaborationMode`, submits a user turn, waits for completion, extracts developer texts, wraps the expected text with `collab_xml`, and asserts it appears exactly once.

**Call relations**: This test covers persistent thread-level override behavior using `submit_thread_settings` before the turn.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_instructions_added_on_user_turn`  (lines 151–196)

```
async fn collaboration_instructions_added_on_user_turn() -> Result<()>
```

**Purpose**: Verifies that per-turn thread settings can inject collaboration instructions directly on that user turn.

**Data flow**: It builds a default `TestCodex`, submits a `UserInput` op whose `thread_settings` include environment, approval, sandbox, summary, and a `CollaborationMode`, waits for completion, then asserts the tagged collaboration text appears once in developer messages.

**Call relations**: This test exercises the per-turn override path rather than the persistent thread-settings path.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_instructions_omitted_when_disabled`  (lines 199–248)

```
async fn collaboration_instructions_omitted_when_disabled() -> Result<()>
```

**Purpose**: Checks that collaboration instructions are suppressed entirely when config disables their inclusion.

**Data flow**: It builds a `TestCodex` with `include_collaboration_mode_instructions = false`, submits a user turn carrying collaboration-mode thread settings, waits for completion, extracts developer texts, and asserts none contain the collaboration open tag.

**Call relations**: This is the feature-toggle negative case for collaboration instruction injection.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, collab_mode_with_instructions, developer_texts); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `override_then_next_turn_uses_updated_collaboration_instructions`  (lines 251–294)

```
async fn override_then_next_turn_uses_updated_collaboration_instructions() -> Result<()>
```

**Purpose**: Verifies that after a thread-level collaboration override is stored, the next ordinary user turn uses that updated instruction text.

**Data flow**: It submits thread settings with a collaboration mode, then a normal user turn, waits for completion, extracts developer texts, and asserts the tagged override text appears once.

**Call relations**: This is similar to the earlier override test but emphasizes that the following turn can use default per-turn settings and still inherit the stored collaboration mode.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `user_turn_overrides_collaboration_instructions_after_override`  (lines 297–355)

```
async fn user_turn_overrides_collaboration_instructions_after_override() -> Result<()>
```

**Purpose**: Checks that a per-turn collaboration override supersedes an already stored thread-level collaboration mode.

**Data flow**: It first stores a base collaboration mode via thread settings, then submits a user turn whose `thread_settings` carry a different collaboration mode, waits for completion, and asserts the base tagged text appears zero times while the turn override appears once.

**Call relations**: This test covers precedence between persistent thread settings and per-turn overrides.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_mode_update_emits_new_instruction_message`  (lines 358–431)

```
async fn collaboration_mode_update_emits_new_instruction_message() -> Result<()>
```

**Purpose**: Verifies that changing collaboration instruction text between turns appends a new instruction message rather than replacing history invisibly.

**Data flow**: It stores one collaboration mode, submits a first turn, stores a second collaboration mode, submits a second turn, then inspects the second request’s developer texts and asserts both the first and second tagged instruction fragments appear once.

**Call relations**: This test checks append-on-change behavior for instruction text updates across turns.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_mode_update_noop_does_not_append`  (lines 434–504)

```
async fn collaboration_mode_update_noop_does_not_append() -> Result<()>
```

**Purpose**: Checks that reapplying the same collaboration instruction text does not append a duplicate instruction message.

**Data flow**: It stores a collaboration mode, submits a first turn, stores the same collaboration mode again, submits a second turn, and asserts the tagged instruction fragment appears only once in the second request.

**Call relations**: This is the no-op counterpart to the update-appends test.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_mode_update_emits_new_instruction_message_when_mode_changes`  (lines 507–586)

```
async fn collaboration_mode_update_emits_new_instruction_message_when_mode_changes() -> Result<()>
```

**Purpose**: Verifies that changing the collaboration `ModeKind` also appends a new instruction message, even if the mechanism is otherwise the same.

**Data flow**: It stores a default-mode collaboration setting, submits a turn, stores a plan-mode collaboration setting, submits another turn, and asserts both tagged instruction fragments appear once in the second request.

**Call relations**: This extends update detection from instruction-text changes to mode changes.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_mode_and_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged`  (lines 589–665)

```
async fn collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged() -> Result<()>
```

**Purpose**: Checks that reapplying the same mode and instruction text does not append a duplicate collaboration message.

**Data flow**: It stores a default-mode collaboration setting, submits a turn, stores the same setting again, submits another turn, and asserts the tagged fragment appears only once in the second request.

**Call relations**: This is the no-op counterpart to the mode-change append test.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_mode_and_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `resume_replays_collaboration_instructions`  (lines 668–739)

```
async fn resume_replays_collaboration_instructions() -> Result<()>
```

**Purpose**: Verifies that collaboration instructions persisted in rollout are replayed after resuming the thread.

**Data flow**: It builds an initial thread, records its rollout path and home, stores collaboration settings, submits a turn, resumes from rollout, submits another turn on the resumed thread, and asserts the resumed request’s developer texts contain the tagged collaboration fragment once.

**Call relations**: This is the persistence/resume regression test for collaboration-mode prompt state.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `empty_collaboration_instructions_are_ignored`  (lines 742–791)

```
async fn empty_collaboration_instructions_are_ignored() -> Result<()>
```

**Purpose**: Checks that an empty developer-instructions string does not produce an empty collaboration XML message.

**Data flow**: It stores a `CollaborationMode` whose `developer_instructions` is `Some("")`, submits a user turn, waits for completion, extracts developer texts, builds the empty tagged fragment, and asserts it appears zero times.

**Call relations**: This guards the edge case where an explicit but empty string should behave like no collaboration instructions at all.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/hierarchical_agents.rs`

`test` · `request construction / instruction injection`

This file contains two focused integration tests around instruction-source assembly. Both start a mock server, mount a single completed SSE response, enable `Feature::ChildAgentsMd`, build a remote-environment `TestCodex`, submit a simple turn, and inspect the outbound request’s user messages. The constant `HIERARCHICAL_AGENTS_SNIPPET` captures a distinctive phrase from the built-in hierarchical-agents guidance so the tests can locate it reliably. In the first test, a workspace setup hook creates a root `AGENTS.md` file containing `be nice` using `PathUri` and the test filesystem abstraction; after the turn, the request must contain a user instruction message beginning with `# AGENTS.md instructions`, include the project document text, and place the hierarchical-agents snippet after that base content. This checks append order rather than mere presence. The second test omits any project `AGENTS.md` file and asserts that the generated instructions message still exists and contains the built-in hierarchical snippet. The notable design point is that these tests validate the exact prompt assembly visible to the model, not just internal instruction-source bookkeeping.

#### Function details

##### `hierarchical_agents_appends_to_project_doc_in_user_instructions`  (lines 15–66)

```
async fn hierarchical_agents_appends_to_project_doc_in_user_instructions()
```

**Purpose**: Verifies that when a project `AGENTS.md` exists, its contents appear in the generated instructions message and the hierarchical-agents guidance is appended afterward. It checks both inclusion and ordering.

**Data flow**: It first skips under Wine-based cross-OS execution, then starts a mock server and mounts a one-shot SSE completion. The test builder enables `Feature::ChildAgentsMd` and installs a workspace setup closure that creates `<cwd>/AGENTS.md`, converts the path to `PathUri`, and writes `be nice` through the provided filesystem API. After building with remote env and submitting `hello`, it reads the single recorded request, extracts user message texts, finds the one starting with `# AGENTS.md instructions`, asserts it contains `be nice`, computes the positions of `be nice` and `HIERARCHICAL_AGENTS_SNIPPET`, and asserts the snippet position is greater than the base document position.

**Call relations**: This harness test uses `test_codex` setup hooks to create the workspace fixture, then inspects the request captured by `mount_sse_once` to validate prompt assembly.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (assert!, skip_if_wine_exec!, vec!).


##### `hierarchical_agents_emits_when_no_project_doc`  (lines 69–100)

```
async fn hierarchical_agents_emits_when_no_project_doc()
```

**Purpose**: Checks that enabling hierarchical agents still emits an instructions message even when no project `AGENTS.md` file is present. The built-in hierarchical guidance should stand on its own.

**Data flow**: It starts a mock server, mounts a one-shot SSE completion, builds a remote-environment test instance with `Feature::ChildAgentsMd` enabled and no workspace setup, submits `hello`, reads the captured request, extracts user message texts, finds the message beginning with `# AGENTS.md instructions`, and asserts that it contains `HIERARCHICAL_AGENTS_SNIPPET`.

**Call relations**: This is the simpler companion to the first test: it follows the same request-capture path through `mount_sse_once` and `test_codex`, but omits the workspace fixture to validate the no-project-doc branch.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 2 external calls (assert!, vec!).


### `core/tests/suite/skills.rs`

`test` · `request handling`

This non-Windows test file contains one setup helper and one integration test focused on repo-scoped skills stored under `.agents/skills`. `write_repo_skill` uses the abstract `ExecutorFileSystem` rather than direct host filesystem calls so the workspace setup runs through the same execution abstraction as the rest of the system. It creates `.agents/skills/<name>`, writes a `SKILL.md` file with YAML frontmatter (`name`, `description`) followed by the supplied body, and leaves the skill ready for discovery.

The test itself builds a Codex instance with a workspace setup hook that installs a `demo` skill. After startup it computes the canonical path to `.agents/skills/demo/SKILL.md`, mounts a single assistant-only SSE response, and submits a turn containing both ordinary text (`please use $demo`) and an explicit `UserInput::Skill` item naming the skill and its path. It waits for `TurnComplete`, then inspects the recorded request body sent to the mock server. Rather than checking internal state, it asserts on the actual user message texts delivered to the model: one of them must contain a `<skill>` block with the skill name, path, and body text. This makes the test a direct specification of how skill instructions are serialized into model-facing prompt content.

#### Function details

##### `write_repo_skill`  (lines 26–47)

```
async fn write_repo_skill(
    cwd: AbsolutePathBuf,
    fs: Arc<dyn ExecutorFileSystem>,
    name: &str,
    description: &str,
    body: &str,
) -> Result<()>
```

**Purpose**: Creates a repository-local skill under `.agents/skills/<name>` using the executor filesystem abstraction.

**Data flow**: Accepts the workspace `cwd`, an `Arc<dyn ExecutorFileSystem>`, skill `name`, `description`, and markdown `body`. It computes the skill directory path, converts it and the final `SKILL.md` path to `PathUri`, creates the directory recursively, formats the frontmatter-plus-body contents, writes the file bytes through the executor filesystem, and returns `Ok(())`.

**Call relations**: Used as the workspace setup hook in the file’s only test so the skill exists before the Codex instance starts processing turns.

*Call graph*: calls 2 internal fn (join, from_path); 1 external calls (format!).


##### `user_turn_includes_skill_instructions`  (lines 50–135)

```
async fn user_turn_includes_skill_instructions() -> Result<()>
```

**Purpose**: Verifies that when a user turn includes a selected skill, the outbound model request contains serialized skill instructions including name, path, and body.

**Data flow**: Skips under Wine and without network, starts a mock server, defines `skill_body`, builds a test Codex with a workspace setup hook that calls `write_repo_skill`, computes the canonical skill path, mounts a one-shot assistant response, derives sandbox and permission fields, submits an `Op::UserInput` containing both a text item and `UserInput::Skill { name, path }`, waits for `TurnComplete`, then inspects the mock request’s user text messages. It asserts at least one text contains the `<skill>` wrapper, `<name>demo</name>`, a `<path>` section, the skill body, and the actual skill path string.

**Call relations**: This is the sole integration test in the file and directly validates the prompt-construction path from selected skill input to model-facing request payload.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 6 external calls (default, assert!, wait_for_event, skip_if_no_network!, skip_if_wine_exec!, vec!).


### Prompt layout and request assembly
These files validate the exact structure of assembled model input, including visible layout, permissions and personality messaging, caching behavior, and token-budget annotations.

### `core/tests/suite/model_visible_layout.rs`

`test` · `request serialization and resume-time history reconstruction`

This module is a request-layout regression suite built around snapshot rendering helpers from `core_test_support::context_snapshot`. Rather than asserting individual fields only, it formats labeled request snapshots with a stable rendering mode (`KindWithTextPrefix { max_chars: 96 }`) so changes in model-visible history are easy to review. The tests construct explicit `Op::UserInput` payloads with concrete `ThreadSettingsOverrides`, including cwd/environment selections, approval policy, sandbox policy, permission profile, personality, and collaboration mode.

The first two tests compare successive requests within a session. One snapshots how changing cwd, approval policy, and personality while keeping the model constant affects the second request. The other documents current behavior that AGENTS.md content is session-scoped rather than refreshed on cwd-only changes; it creates two directories with different `AGENTS.md` files and asserts that neither request contains the serialized `# AGENTS.md instructions` wrapper. Two resume tests compare the last pre-resume request with the first post-resume request, covering both a resumed config whose model differs from rollout and a case where a pre-turn override restores the rollout model so no model-switch update should appear. The final snapshot helpers render synthetic `<environment_context>` messages to verify formatting of zero, one, or two subagent lines.

#### Function details

##### `context_snapshot_options`  (lines 33–36)

```
fn context_snapshot_options() -> ContextSnapshotOptions
```

**Purpose**: Builds the shared snapshot-rendering configuration used by this file’s formatting helpers. It selects a compact rendering mode that preserves item kind and a text prefix up to 96 characters.

**Data flow**: It takes no arguments, starts from `ContextSnapshotOptions::default()`, applies `.render_mode(ContextSnapshotRenderMode::KindWithTextPrefix { max_chars: 96 })`, and returns the configured options value.

**Call relations**: Both snapshot-formatting helpers call this function so all snapshots in the file use the same redaction and rendering policy.

*Call graph*: calls 1 internal fn (default); called by 2 (format_environment_context_subagents_snapshot, format_labeled_requests_snapshot).


##### `format_labeled_requests_snapshot`  (lines 38–47)

```
fn format_labeled_requests_snapshot(
    scenario: &str,
    sections: &[(&str, &ResponsesRequest)],
) -> String
```

**Purpose**: Formats a human-readable snapshot for one or more labeled `ResponsesRequest` values under a scenario description. It is a thin wrapper that injects this file’s standard snapshot options.

**Data flow**: Inputs are a scenario string and a slice of `(label, &ResponsesRequest)` pairs. It calls `context_snapshot::format_labeled_requests_snapshot` with those sections plus `context_snapshot_options()`, and returns the resulting formatted string.

**Call relations**: The multi-request snapshot tests call this helper immediately before `insta::assert_snapshot!` so the snapshot text stays consistent across scenarios.

*Call graph*: calls 2 internal fn (format_labeled_requests_snapshot, context_snapshot_options).


##### `user_instructions_wrapper_count`  (lines 49–55)

```
fn user_instructions_wrapper_count(request: &ResponsesRequest) -> usize
```

**Purpose**: Counts how many serialized user-message spans in a request begin with the AGENTS wrapper heading. It is used to assert that AGENTS.md instructions are not being re-emitted in the cwd-change scenario.

**Data flow**: It takes a `ResponsesRequest`, extracts all user-role input texts via `message_input_texts("user")`, filters texts starting with `# AGENTS.md instructions`, and returns the count.

**Call relations**: Only the AGENTS refresh regression test uses this helper, where it provides a precise numeric assertion in addition to the broader snapshot.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `format_environment_context_subagents_snapshot`  (lines 57–79)

```
fn format_environment_context_subagents_snapshot(subagents: &[&str]) -> String
```

**Purpose**: Synthesizes and renders a single model-visible `<environment_context>` message containing an optional `<subagents>` block. It exists to snapshot the exact textual layout of subagent listings.

**Data flow**: Input is a slice of subagent lines like `- agent-1: Atlas`. It conditionally builds a newline-indented `<subagents>` block, embeds it into a JSON message item with cwd `/tmp/example` and shell `bash`, wraps that item in a one-element vector, and passes the slice to `context_snapshot::format_response_items_snapshot` with the shared options. The returned string is the snapshot body.

**Call relations**: The one-subagent and two-subagent snapshot tests call this helper directly. It isolates the formatting logic so those tests only specify the subagent lines they care about.

*Call graph*: calls 2 internal fn (format_response_items_snapshot, context_snapshot_options); 3 external calls (new, format!, vec!).


##### `snapshot_model_visible_layout_turn_overrides`  (lines 82–201)

```
async fn snapshot_model_visible_layout_turn_overrides() -> Result<()>
```

**Purpose**: Snapshots how the second request changes when a turn overrides cwd, approval policy, and personality while keeping the model constant. It serves as a regression fixture for the exact model-visible diff emitted across turns.

**Data flow**: The test mounts two SSE conversations, enables the personality feature with initial `Pragmatic` personality, creates a second cwd directory, and submits two explicit `Op::UserInput` turns with different `ThreadSettingsOverrides`. After both turns complete, it collects the two captured requests, asserts there are two, formats them with labels `First Request (Baseline)` and `Second Request (Turn Overrides)`, and snapshots the result.

**Call relations**: It is a top-level snapshot test that uses `local_selections` and `turn_permission_fields` to make both turns explicit. The formatting step delegates to `format_labeled_requests_snapshot`.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, read_only); 7 external calls (default, assert_eq!, wait_for_event, create_dir_all, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_model_visible_layout_cwd_change_does_not_refresh_agents`  (lines 206–334)

```
async fn snapshot_model_visible_layout_cwd_change_does_not_refresh_agents() -> Result<()>
```

**Purpose**: Documents current behavior that changing cwd to a directory with a different `AGENTS.md` does not refresh serialized AGENTS instructions in model-visible history. The test intentionally locks in this limitation until the TODO is implemented.

**Data flow**: The test creates two directories, writes distinct `AGENTS.md` files into each, submits one turn in `agents_one` and a second in `agents_two`, then inspects the two captured requests. It asserts both requests have zero AGENTS wrapper messages via `user_instructions_wrapper_count`, then snapshots the labeled requests for visual regression coverage.

**Call relations**: This test combines direct numeric assertions with a snapshot. It uses the same explicit `Op::UserInput` construction pattern as the turn-overrides test, but its distinguishing setup is the per-cwd project-doc fixtures.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, read_only); 8 external calls (default, assert_eq!, wait_for_event, create_dir_all, write, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_model_visible_layout_resume_with_personality_change`  (lines 337–449)

```
async fn snapshot_model_visible_layout_resume_with_personality_change() -> Result<()>
```

**Purpose**: Snapshots the first request after resuming a session when the resumed config model differs from the rollout model and the turn also changes personality. It compares the last request before resume with the first request after resume.

**Data flow**: The test first builds an initial session with model `gpt-5.2`, records one turn, and saves `home` plus `rollout_path`. It then mounts a second response, resumes from the saved rollout using config model `gpt-5.3-codex` with personality feature enabled and default `Pragmatic`, creates an override cwd, submits a resumed turn overriding personality to `Friendly`, and snapshots the pair `(initial_request, resumed_request)`.

**Call relations**: It is a resume-flow regression test. The initial and resumed sessions are built separately, and the final snapshot is produced through `format_labeled_requests_snapshot` to expose any model-switch or personality-update messages inserted during resume.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, read_only); 7 external calls (clone, default, wait_for_event, create_dir_all, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_model_visible_layout_resume_override_matches_rollout_model`  (lines 452–549)

```
async fn snapshot_model_visible_layout_resume_override_matches_rollout_model() -> Result<()>
```

**Purpose**: Verifies via snapshot that if a resumed session’s config model differs from rollout but a pre-turn thread override sets the model back to the rollout model, no model-switch update should appear. It captures the subtle interaction between resume-time config drift and explicit per-turn overrides.

**Data flow**: Like the previous test, it seeds an initial session with one request under `gpt-5.2`, then resumes with config model `gpt-5.3-codex`. Before the first resumed turn, it submits thread settings overriding `environments` and `model = gpt-5.2`, then submits a default `Op::UserInput`, waits for completion, and snapshots the last pre-resume request against the first resumed request.

**Call relations**: This test differs from the personality-change resume case by using `submit_thread_settings` before the resumed turn. Its snapshot is intended to prove that the override suppresses an otherwise expected model-switch annotation.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex); 8 external calls (clone, default, submit_thread_settings, wait_for_event, create_dir_all, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_model_visible_layout_environment_context_includes_one_subagent`  (lines 552–559)

```
async fn snapshot_model_visible_layout_environment_context_includes_one_subagent() -> Result<()>
```

**Purpose**: Snapshots the rendered `<environment_context>` message when exactly one subagent line is present. It is a focused formatting regression test.

**Data flow**: The test passes a one-element slice containing `- agent-1: Atlas` to `format_environment_context_subagents_snapshot` and snapshots the returned string.

**Call relations**: It is a minimal top-level snapshot test that exists solely to pin the formatting helper’s output for the one-subagent case.

*Call graph*: 1 external calls (assert_snapshot!).


##### `snapshot_model_visible_layout_environment_context_includes_two_subagents`  (lines 562–569)

```
async fn snapshot_model_visible_layout_environment_context_includes_two_subagents() -> Result<()>
```

**Purpose**: Snapshots the rendered `<environment_context>` message when two subagent lines are present. This complements the one-subagent case and guards indentation/newline formatting.

**Data flow**: The test passes two subagent lines, `- agent-1: Atlas` and `- agent-2: Juniper`, to `format_environment_context_subagents_snapshot` and snapshots the resulting formatted string.

**Call relations**: It is the second direct consumer of the environment-context formatting helper and serves as the multi-line regression fixture.

*Call graph*: 1 external calls (assert_snapshot!).


### `core/tests/suite/permissions_messages.rs`

`test` · `request handling and session resume/fork regression coverage`

This test module builds end-to-end conversations against the mock Responses API and inspects the outgoing developer messages for fragments tagged with `<permissions instructions>`. Its central helper, `permissions_texts`, extracts only those developer-input texts from a captured request so each test can reason about count, ordering, and uniqueness without parsing unrelated prompt content.

The tests cover the lifecycle of permissions messaging. On a fresh thread, the first user turn should include exactly one permissions message. A later thread-settings override that changes approval policy should cause a second, distinct permissions message to be appended on the next request, while a second turn with no effective settings change should reuse the prior prompt prefix and avoid adding another copy. A configuration flag, `include_permissions_instructions = false`, suppresses these messages entirely even when approval policy changes.

The resume and fork tests verify persistence semantics: when a thread is resumed, prior permissions messages are replayed into the next request so the model sees the same historical context, and if the resumed or forked configuration changes approval policy again, exactly one new permissions message is appended after the replayed history. The final test constructs a managed `PermissionProfile::workspace_write_with(...)`, updates workspace roots and config-layer state, computes the expected `PermissionsInstructions::from_permission_profile(...).render()` output, normalizes line endings, and asserts the emitted developer message matches the renderer exactly.

#### Function details

##### `permissions_texts`  (lines 28–34)

```
fn permissions_texts(request: &ResponsesRequest) -> Vec<String>
```

**Purpose**: Extracts only developer-role prompt fragments that are permissions instruction messages from a captured Responses API request. It gives the tests a stable view of the emitted permissions text without depending on the full prompt layout.

**Data flow**: Takes a `ResponsesRequest`, reads its developer message texts via `message_input_texts("developer")`, filters to strings containing `<permissions instructions>`, and returns those matching texts as `Vec<String>`. It does not mutate external state.

**Call relations**: This helper is used by the tests that compare first and later requests, resumed requests, and exact rendered output. Those callers invoke it after waiting for `TurnComplete`, once the mock server has captured the outbound request body.

*Call graph*: calls 1 internal fn (message_input_texts); called by 5 (permissions_message_added_on_override_change, permissions_message_includes_writable_roots, permissions_message_not_added_when_no_change, resume_and_fork_append_permissions_messages, resume_replays_permissions_messages).


##### `permissions_message_sent_once_on_start`  (lines 37–69)

```
async fn permissions_message_sent_once_on_start() -> Result<()>
```

**Purpose**: Verifies that the first user turn on a new thread emits exactly one permissions instruction message when approvals are enabled on request. It checks the baseline behavior before any overrides or resume logic are involved.

**Data flow**: Creates a mock SSE server, configures the test Codex instance with `approval_policy = OnRequest`, submits a text `Op::UserInput`, waits for `EventMsg::TurnComplete`, then inspects the single captured request and asserts the filtered permissions-message count is `1`.

**Call relations**: This is a top-level async test invoked by the test runner. It drives the standard startup path—mock server setup, builder configuration, turn submission, completion wait—and then performs a direct assertion on the captured request.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `permissions_message_added_on_override_change`  (lines 72–138)

```
async fn permissions_message_added_on_override_change() -> Result<()>
```

**Purpose**: Checks that changing thread approval policy between turns causes a new permissions instruction message to be appended on the next request. It also confirms the two permissions messages are distinct.

**Data flow**: Builds a thread with initial `OnRequest` approval policy, sends one user turn, applies `ThreadSettingsOverrides { approval_policy: Some(Never), .. }`, sends a second turn, then extracts permissions texts from both captured requests. It asserts the first request has one message, the second has two, and the second request contains two unique permissions strings.

**Call relations**: The test runner invokes this test directly. Within the flow it uses `submit_thread_settings` between two normal user turns, then delegates request inspection to `permissions_texts` to prove that an effective override change invalidates the cached permissions prefix.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, permissions_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `permissions_message_not_added_when_no_change`  (lines 141–197)

```
async fn permissions_message_not_added_when_no_change() -> Result<()>
```

**Purpose**: Ensures that a second turn with unchanged effective permissions does not append another permissions instruction message. The test guards the prompt-cache invariant that stable settings should reuse the same permissions prefix.

**Data flow**: Starts a mock server, builds Codex with `OnRequest` approval policy, submits two plain text turns without any thread-settings update, waits for completion after each, then compares `permissions_texts` from the two captured requests. It asserts both requests contain exactly one permissions message and that the message contents are identical.

**Call relations**: This test is called by the test harness and follows the same two-turn pattern as the override test, but intentionally omits `submit_thread_settings`. Its assertions demonstrate the no-change branch of the permissions-message emission logic.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, permissions_texts); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `permissions_message_omitted_when_disabled`  (lines 200–268)

```
async fn permissions_message_omitted_when_disabled() -> Result<()>
```

**Purpose**: Verifies that the global configuration switch disabling permissions instructions suppresses these developer messages entirely, even when approval policy changes mid-thread. It confirms the feature gate wins over change detection.

**Data flow**: Builds Codex with `include_permissions_instructions = false` and initial `OnRequest` approval policy, sends one turn, applies an override to `Never`, sends a second turn, waits for completion after each, and asserts that `permissions_texts` for both captured requests are empty vectors.

**Call relations**: The test runner invokes this test directly. It mirrors the override-change scenario but changes configuration up front so the later request inspection proves the permissions-message generation path is fully bypassed.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `resume_replays_permissions_messages`  (lines 271–363)

```
async fn resume_replays_permissions_messages() -> Result<()>
```

**Purpose**: Checks that resuming a thread replays previously emitted permissions messages into the next outbound request. It validates that prompt history reconstruction preserves permissions context across process restarts.

**Data flow**: Creates an initial thread with `OnRequest`, sends one turn, changes approval policy to `Never`, sends a second turn, captures the rollout path and home directory, resumes the thread from disk, sends a post-resume turn, then extracts permissions texts from the resumed request. It asserts the resumed request contains three permissions-message entries total and only two unique strings, meaning prior messages were replayed and not collapsed.

**Call relations**: This test is driven by the test harness and exercises both `build` and `resume` on the same builder. It uses `permissions_texts` only on the resumed request because the key behavior under test is replay of historical permissions messages after session restoration.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, permissions_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `resume_and_fork_append_permissions_messages`  (lines 366–510)

```
async fn resume_and_fork_append_permissions_messages() -> Result<()>
```

**Purpose**: Verifies that both resumed threads and forked threads preserve the base permissions-message history and append exactly one new message when the effective approval policy changes in the new branch. It compares resume and fork behavior for consistency.

**Data flow**: Builds an initial thread with `OnRequest`, sends two turns with an intervening override to `Never`, records the second request's permissions texts as the base history, then resumes with config changed to `UnlessTrusted` and sends another turn. It asserts the resumed request starts with the base history and ends with one new permissions message. It then forks the original thread using `thread_manager.fork_thread(ForkSnapshot::Interrupted, ...)` with the same changed config, sends a turn on the fork, and asserts the forked request has the same base prefix and same single appended permissions message as the resumed request.

**Call relations**: The test runner invokes this test directly. It first establishes a baseline history, then drives two branching mechanisms—resume and fork—and uses `permissions_texts` to prove both branches append rather than rewrite prior permissions context.

*Call graph*: calls 6 internal fn (allow_any, mount_sse_once, sse, start_mock_server, test_codex, permissions_texts); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `permissions_message_includes_writable_roots`  (lines 513–581)

```
async fn permissions_message_includes_writable_roots() -> Result<()>
```

**Purpose**: Asserts that the emitted permissions instructions exactly reflect a managed permission profile with explicit writable roots. This is the strongest content-level test in the file because it compares the full rendered instructions string.

**Data flow**: Creates a temporary writable directory, converts it to `AbsolutePathBuf`, builds a `PermissionProfile::workspace_write_with(...)` using restricted network policy, injects that profile plus matching `workspace_roots` and a reset `ConfigLayerStack` into the test config, sends one user turn, and extracts the permissions text from the captured request. It then loads execution policy with `load_exec_policy`, computes the effective permission profile from the built config, renders expected text via `PermissionsInstructions::from_permission_profile(...).render()`, normalizes CRLF to LF on both expected and actual strings, and asserts exact equality.

**Call relations**: This test is called by the test harness and uses `permissions_texts` for extraction, but unlike the count-based tests it reconstructs the same renderer inputs the production code uses. That makes it an end-to-end regression test for writable-root serialization and permissions-instruction formatting.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, permissions_texts, from_permission_profile, workspace_write_with, try_from); 8 external calls (default, new, assert_eq!, load_exec_policy, wait_for_event, skip_if_no_network!, from_ref, vec!).


### `core/tests/suite/personality.rs`

`test` · `prompt construction and per-turn settings-change regression coverage`

This suite focuses on the `Personality` feature from two angles: static instruction generation and dynamic turn-time updates. Two small helpers build `Op::UserInput` payloads for read-only turns. `read_only_text_turn_with_personality` derives a read-only `PermissionProfile`, converts it into sandbox and permission fields with `turn_permission_fields`, and fills `ThreadSettingsOverrides` with local environment selections, approval policy, optional personality, and a `CollaborationMode` carrying the chosen model and reasoning effort. `read_only_text_turn` is the convenience wrapper that leaves personality unset.

The first group of tests works offline against `construct_model_info_offline(...)`. They prove that personality does not mutate `base_instructions` unless the model template supports it, that an explicit `base_instructions` override disables personality templating, and that disabling the feature falls back to base instructions even if a personality is configured.

The networked tests inspect actual outbound requests. For local models, a configured personality should be baked into the top-level instructions text, while `Personality::None` or `None` should remove both local templates and any `{{ personality }}` placeholder. For models that support runtime personality changes, changing thread settings to a new personality should inject a developer message containing `<personality_spec>` and the rendered template; repeating the same value or disabling the feature suppresses that update. Two remote-model tests mount a synthetic `ModelsResponse` with `ModelMessages` and `ModelInstructionsVariables`, wait for the model manager to fetch it, and then verify that both initial instructions and runtime update messages use the remote friendly/pragmatic strings rather than local defaults.

#### Function details

##### `read_only_text_turn`  (lines 45–53)

```
fn read_only_text_turn(
    test: &TestCodex,
    text: &str,
    model: String,
    approval_policy: AskForApproval,
) -> Op
```

**Purpose**: Builds a standard read-only text-turn operation without an explicit personality override. It exists to keep the tests concise when they want the thread or config personality to drive behavior.

**Data flow**: Accepts a `TestCodex`, user text, model slug, and approval policy; sets `personality = None`; forwards all arguments to `read_only_text_turn_with_personality`; and returns the resulting `Op` unchanged.

**Call relations**: Most request-level tests call this helper before submitting to `test.codex`. It delegates all real construction work to `read_only_text_turn_with_personality`, which centralizes the thread-settings shape used throughout the suite.

*Call graph*: calls 1 internal fn (read_only_text_turn_with_personality); called by 8 (config_personality_none_sends_no_personality, config_personality_some_sets_instructions_template, default_personality_is_pragmatic_without_config_toml, user_turn_personality_none_does_not_add_update_message, user_turn_personality_remote_model_template_includes_update_message, user_turn_personality_same_value_does_not_add_update_message, user_turn_personality_skips_if_feature_disabled, user_turn_personality_some_adds_update_message).


##### `read_only_text_turn_with_personality`  (lines 55–89)

```
fn read_only_text_turn_with_personality(
    test: &TestCodex,
    text: &str,
    model: String,
    approval_policy: AskForApproval,
    personality: Option<Personality>,
) -> Op
```

**Purpose**: Constructs a complete `Op::UserInput` for a read-only turn, including environment selections, permission fields, collaboration mode, and an optional personality override. It standardizes the exact thread-settings payload used across local and remote personality tests.

**Data flow**: Takes the test harness, input text, model slug, approval policy, and optional `Personality`. It computes `(sandbox_policy, permission_profile)` from `PermissionProfile::read_only()` and the test cwd, then returns `Op::UserInput` with one `UserInput::Text` item and `ThreadSettingsOverrides` populated with local environments, approval policy, sandbox policy, permission profile, optional personality, and a `CollaborationMode` whose settings include the supplied model and the test config's reasoning effort.

**Call relations**: Called by `read_only_text_turn` and directly by the remote-model instruction test that wants to force a personality on the turn. It is the common setup path that ensures all tests differ only in the personality inputs they are trying to validate.

*Call graph*: calls 4 internal fn (cwd_path, local_selections, turn_permission_fields, read_only); called by 2 (read_only_text_turn, remote_model_friendly_personality_instructions_with_feature); 2 external calls (default, vec!).


##### `personality_does_not_mutate_base_instructions_without_template`  (lines 92–106)

```
async fn personality_does_not_mutate_base_instructions_without_template()
```

**Purpose**: Proves that enabling the personality feature and setting a personality does not alter model instructions when the model lacks a personality-aware template. The invariant is that `base_instructions` remain authoritative in that case.

**Data flow**: Creates a temporary Codex home, loads default config, enables `Feature::Personality`, sets `config.personality = Some(Personality::Friendly)`, constructs offline model info for `gpt-5.4`, and asserts `get_model_instructions(config.personality)` equals `model_info.base_instructions`.

**Call relations**: This offline unit-style test is invoked directly by the test runner. It does not submit turns; instead it isolates the model-info rendering path used later by request-building code.

*Call graph*: calls 1 internal fn (construct_model_info_offline); 3 external calls (new, assert_eq!, load_default_config_for_test).


##### `base_instructions_override_disables_personality_template`  (lines 109–127)

```
async fn base_instructions_override_disables_personality_template()
```

**Purpose**: Checks that an explicit `base_instructions` override suppresses personality templating even when the feature is enabled and a personality is configured. It protects the precedence rule that user overrides beat model templates.

**Data flow**: Loads default config in a temp home, enables the personality feature, sets `personality = Friendly` and `base_instructions = Some("override instructions")`, constructs offline model info for `gpt-5.3-codex`, and asserts both `base_instructions` and `get_model_instructions(...)` equal the override string.

**Call relations**: The test runner invokes this directly. It complements the previous offline test by covering the explicit-override branch rather than the no-template branch.

*Call graph*: calls 1 internal fn (construct_model_info_offline); 3 external calls (new, assert_eq!, load_default_config_for_test).


##### `user_turn_personality_none_does_not_add_update_message`  (lines 130–166)

```
async fn user_turn_personality_none_does_not_add_update_message() -> anyhow::Result<()>
```

**Purpose**: Verifies that a normal user turn does not inject a developer personality update message when no personality is set. It checks the runtime prompt path rather than offline instruction rendering.

**Data flow**: Starts a mock server and one completed SSE response, builds Codex with the personality feature enabled but no configured personality, submits a read-only text turn via `read_only_text_turn`, waits for `TurnComplete`, then inspects developer texts in the captured request and asserts none contain `<personality_spec>`.

**Call relations**: This test is run by the harness and uses the shared turn-construction helper. It exercises the first-turn request path and confirms that absence of personality does not create a synthetic developer update.

*Call graph*: calls 5 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, read_only_text_turn); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `config_personality_some_sets_instructions_template`  (lines 169–213)

```
async fn config_personality_some_sets_instructions_template() -> anyhow::Result<()>
```

**Purpose**: Checks that a configured personality is folded into the top-level instructions text for a local model, rather than being sent as a separate developer update message. It specifically expects the local friendly template string.

**Data flow**: Builds Codex with `Feature::Personality` enabled and `config.personality = Some(Personality::Friendly)`, submits a read-only turn, waits for completion, reads `instructions_text()` from the captured request, and asserts it contains `LOCAL_FRIENDLY_TEMPLATE`. It then iterates developer texts and asserts none contain `<personality_spec>`.

**Call relations**: Invoked directly by the test runner. It contrasts with the runtime-update tests by proving that initial config personality is embedded in instructions for the first request.

*Call graph*: calls 5 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, read_only_text_turn); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `config_personality_none_sends_no_personality`  (lines 216–267)

```
async fn config_personality_none_sends_no_personality() -> anyhow::Result<()>
```

**Purpose**: Ensures that explicitly configuring `Personality::None` removes personality content entirely from instructions and avoids any developer update message. It also checks that template placeholders are stripped rather than leaked.

**Data flow**: Builds Codex with the personality feature enabled and `config.personality = Some(Personality::None)`, submits a read-only turn, waits for completion, then asserts the captured instructions text contains neither local friendly nor pragmatic templates nor the literal `{{ personality }}` placeholder. It also asserts developer texts contain no `<personality_spec>` message.

**Call relations**: This test is called by the harness and uses the same request path as the previous config-based test, but validates the explicit-none branch of personality rendering.

*Call graph*: calls 5 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, read_only_text_turn); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `default_personality_is_pragmatic_without_config_toml`  (lines 270–304)

```
async fn default_personality_is_pragmatic_without_config_toml() -> anyhow::Result<()>
```

**Purpose**: Verifies the default personality behavior when the feature is enabled but no explicit personality is configured in config. The expected default for local models is the pragmatic template.

**Data flow**: Builds Codex with `Feature::Personality` enabled and no `config.personality`, submits a read-only turn, waits for completion, reads the request instructions text, and asserts it contains `LOCAL_PRAGMATIC_TEMPLATE`.

**Call relations**: The test runner invokes this directly. It covers the implicit-default branch that sits between explicit personality selection and explicit `None`.

*Call graph*: calls 5 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, read_only_text_turn); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `user_turn_personality_some_adds_update_message`  (lines 307–379)

```
async fn user_turn_personality_some_adds_update_message() -> anyhow::Result<()>
```

**Purpose**: Checks that changing personality at runtime via thread settings adds a developer update message on the next turn for a model that supports personality updates. The message must include both a preamble and the rendered friendly template.

**Data flow**: Builds Codex on model `exp-codex-personality` with the feature enabled, submits an initial read-only turn, applies `submit_thread_settings` with `personality: Some(Personality::Friendly)`, submits a second turn, waits for both completions, then inspects the second captured request. It finds the developer text containing `<personality_spec>` and asserts it includes the communication-style preamble and `LOCAL_FRIENDLY_TEMPLATE`.

**Call relations**: This test is invoked by the harness and follows a two-turn flow with an intervening settings update. It demonstrates the branch where personality changes are communicated incrementally instead of only through base instructions.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only_text_turn); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `user_turn_personality_same_value_does_not_add_update_message`  (lines 382–449)

```
async fn user_turn_personality_same_value_does_not_add_update_message() -> anyhow::Result<()>
```

**Purpose**: Ensures that reapplying the same personality value does not emit a redundant developer update message. It protects prompt stability and avoids duplicate personality-change chatter.

**Data flow**: Builds Codex with `config.personality = Some(Personality::Pragmatic)`, sends one read-only turn, submits thread settings with the same pragmatic personality, sends a second turn, waits for completion, and inspects the second request's developer texts. It asserts no text containing `<personality_spec>` is present.

**Call relations**: The test runner invokes this directly. It mirrors the runtime-change test but keeps the effective value unchanged, validating the no-op branch of personality diffing.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only_text_turn); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `instructions_uses_base_if_feature_disabled`  (lines 452–469)

```
async fn instructions_uses_base_if_feature_disabled() -> anyhow::Result<()>
```

**Purpose**: Confirms that disabling the personality feature forces instruction generation back to plain base instructions, even if a personality value is present in config. This is the feature-gate counterpart to the earlier offline tests.

**Data flow**: Loads default config in a temp home, disables `Feature::Personality`, sets `config.personality = Some(Personality::Friendly)`, constructs offline model info for `gpt-5.3-codex`, and asserts `get_model_instructions(config.personality)` equals `base_instructions`.

**Call relations**: This offline test is called directly by the harness. It isolates feature gating in the instruction-rendering layer without involving network requests.

*Call graph*: calls 1 internal fn (construct_model_info_offline); 3 external calls (new, assert_eq!, load_default_config_for_test).


##### `user_turn_personality_skips_if_feature_disabled`  (lines 472–537)

```
async fn user_turn_personality_skips_if_feature_disabled() -> anyhow::Result<()>
```

**Purpose**: Verifies that runtime personality overrides are ignored when the personality feature is disabled. No developer update message should be emitted on the second turn.

**Data flow**: Builds Codex on `exp-codex-personality` with `Feature::Personality` disabled, sends one read-only turn, submits thread settings with `personality: Some(Personality::Pragmatic)`, sends a second turn, waits for completion, and asserts the second request contains no developer text with `<personality_spec>`.

**Call relations**: This test is invoked by the harness and mirrors the runtime-update scenario, but with the feature disabled to prove the update path is gated off.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only_text_turn); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `remote_model_friendly_personality_instructions_with_feature`  (lines 540–651)

```
async fn remote_model_friendly_personality_instructions_with_feature() -> anyhow::Result<()>
```

**Purpose**: Checks that a remotely fetched model's personality template variables are used for initial instructions when the feature is enabled and a friendly personality is selected. It ensures remote metadata overrides local template strings.

**Data flow**: Starts a mock server with a mounted `ModelsResponse` containing a synthetic `ModelInfo` whose `model_messages.instructions_template` includes `{{ personality }}` and whose variables define default/friendly/pragmatic strings. It builds Codex with ChatGPT auth, enables the personality feature, selects the remote model and friendly personality, waits for the models manager to expose the remote slug, submits a read-only turn with explicit friendly personality, waits for completion, and asserts the captured instructions contain the remote friendly string but not the remote default string.

**Call relations**: The test runner invokes this directly. It depends on `wait_for_model_available` to synchronize with asynchronous model refresh before submitting the turn, then uses the shared turn helper to exercise the normal request path.

*Call graph*: calls 9 internal fn (mount_models_once, mount_sse_once, sse_completed, test_codex, read_only_text_turn_with_personality, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 8 external calls (Limited, default, builder, new, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `user_turn_personality_remote_model_template_includes_update_message`  (lines 654–796)

```
async fn user_turn_personality_remote_model_template_includes_update_message() -> anyhow::Result<()>
```

**Purpose**: Verifies that runtime personality updates for a remote model use the remote template text inside the developer update message. It covers the dynamic-update path for remotely supplied personality variables.

**Data flow**: Mounts a remote `ModelInfo` with friendly and pragmatic remote strings, builds Codex with ChatGPT auth and the personality feature enabled, waits for the remote model to appear, submits an initial read-only turn targeting that remote model, applies thread settings with `personality: Some(Personality::Friendly)`, submits a second turn, and inspects the second request's developer texts. It finds the text containing the remote friendly message and asserts it also contains the standard communication-style preamble.

**Call relations**: This test is called by the harness and combines `wait_for_model_available`, `read_only_text_turn`, and `submit_thread_settings`. It is the remote-model analogue of the local runtime personality-update test.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, read_only_text_turn, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 10 external calls (Limited, default, builder, new, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `wait_for_model_available`  (lines 798–810)

```
async fn wait_for_model_available(manager: &SharedModelsManager, slug: &str)
```

**Purpose**: Polls the shared models manager until a given model slug appears in the online model list or a short deadline expires. It hides asynchronous model-refresh timing from the remote-model tests.

**Data flow**: Accepts a `SharedModelsManager` reference and target slug, repeatedly calls `list_models(RefreshStrategy::OnlineIfUncached).await`, scans for a model whose `model` field matches the slug, and returns `()` once found. If two seconds elapse first, it panics with a timeout message; between polls it sleeps for 25 ms.

**Call relations**: Used only by the two remote-model tests before they submit turns. It sits between mock model mounting and request submission so those tests can rely on the remote slug being selectable.

*Call graph*: called by 2 (remote_model_friendly_personality_instructions_with_feature, user_turn_personality_remote_model_template_includes_update_message); 6 external calls (from_millis, from_secs, now, list_models, panic!, sleep).


### `core/tests/suite/prompt_caching.rs`

`test` · `prompt assembly and cache-key regression coverage`

This suite inspects raw request JSON to ensure Codex builds cache-friendly prompts. Several small helpers make those assertions concrete: `write_global_instructions` writes `AGENTS.md` into the test home; `text_user_input` and `text_user_input_parts` construct the exact JSON shape expected for user messages; `assert_env_context_fragment` and `assert_default_env_context` validate the XML-like environment context block, including current date, timezone, cwd, and shell; `assert_tool_names` checks the exact ordered tool list; and `normalize_newlines` removes CRLF/LF differences when comparing instruction strings.

The tests cover both stable and changing prompt prefixes. The first two verify that repeated requests keep the same instructions and tool list, including the `apply_patch` instruction behavior for GPT-5 tool configurations. The next group checks that the initial cached contextual user message contains global instructions plus environment context exactly once, and that later turns reuse that prefix unchanged. When thread settings change after the first turn—or are supplied per-turn—the `prompt_cache_key` must remain constant, the original prefix must remain intact, and only appended update messages should describe changed permissions/model settings and new environment context. Conversely, if per-turn overrides restate the defaults, no extra environment context should be emitted and the second request should simply append the new user message after the cached prefix and prior user turn. There is also a first-turn override test proving that environment context and overridden approval/model/reasoning settings are emitted even before any baseline turn exists.

#### Function details

##### `write_global_instructions`  (lines 37–40)

```
fn write_global_instructions(home: &Path)
```

**Purpose**: Creates a global `AGENTS.md` file in the test home with fixed instructions text. Tests use it to ensure user instructions are incorporated into the cached prompt prefix.

**Data flow**: Accepts a home `&Path`, writes `be consistent and helpful` to `home.join("AGENTS.md")`, and panics on failure via `expect`.

**Call relations**: Used as a pre-build hook by several tests so the built `TestCodex` sees stable global instructions during prompt construction.

*Call graph*: 2 external calls (join, write).


##### `text_user_input`  (lines 42–44)

```
fn text_user_input(text: String) -> serde_json::Value
```

**Purpose**: Builds the expected JSON representation of a single-part user message. It is a convenience wrapper around the multi-part constructor.

**Data flow**: Takes a `String`, wraps it in a one-element vector, delegates to `text_user_input_parts`, and returns the resulting `serde_json::Value`.

**Call relations**: Called by tests that compare captured `input` arrays against exact expected JSON for user messages.

*Call graph*: calls 1 internal fn (text_user_input_parts); called by 2 (send_user_turn_with_changes_sends_environment_context, send_user_turn_with_no_changes_does_not_send_environment_context); 1 external calls (vec!).


##### `text_user_input_parts`  (lines 46–55)

```
fn text_user_input_parts(texts: Vec<String>) -> serde_json::Value
```

**Purpose**: Builds the exact JSON shape used for a user message containing one or more `input_text` content items. It lets tests compare prompt bodies structurally instead of by substring.

**Data flow**: Accepts `Vec<String>`, maps each string into `{ "type": "input_text", "text": ... }`, wraps them in a `{ "type": "message", "role": "user", "content": ... }` JSON object, and returns it as `serde_json::Value`.

**Call relations**: Used by `text_user_input` and by tests that reconstruct the cached contextual user message containing both instructions and environment context.

*Call graph*: called by 3 (send_user_turn_with_changes_sends_environment_context, send_user_turn_with_no_changes_does_not_send_environment_context, text_user_input); 1 external calls (json!).


##### `assert_default_env_context`  (lines 57–67)

```
fn assert_default_env_context(text: &str, cwd: &str)
```

**Purpose**: Checks that an environment-context string has the standard structure and includes the expected cwd and default shell. It is the stricter validator used when no custom permission-profile details are under test.

**Data flow**: Accepts the environment-context text and expected cwd string, first delegates to `assert_env_context_fragment` for generic structure checks, then asserts the text contains `<cwd>...</cwd>` and `<shell>...</shell>` using `default_user_shell().name()`.

**Call relations**: Called by tests that inspect cached or updated environment context blocks in request bodies. It builds on the more generic fragment validator.

*Call graph*: calls 1 internal fn (assert_env_context_fragment); called by 4 (per_turn_overrides_keep_cached_prefix_and_key_constant, prefixes_context_and_instructions_once_and_consistently_across_requests, send_user_turn_with_changes_sends_environment_context, send_user_turn_with_no_changes_does_not_send_environment_context); 1 external calls (assert!).


##### `assert_env_context_fragment`  (lines 69–86)

```
fn assert_env_context_fragment(text: &str)
```

**Purpose**: Validates the generic XML-like framing of an environment-context block. It ensures the block starts and ends correctly and includes current date and timezone tags.

**Data flow**: Takes a text slice and asserts it starts with `ENVIRONMENT_CONTEXT_OPEN_TAG`, contains both opening and closing `current_date` and `timezone` tags, and ends with `</environment_context>`.

**Call relations**: Used directly by tests that inspect custom environment context details and indirectly by `assert_default_env_context`.

*Call graph*: called by 3 (assert_default_env_context, overrides_turn_context_but_keeps_cached_prefix_and_key_constant, send_user_turn_with_changes_sends_environment_context); 1 external calls (assert!).


##### `assert_tool_names`  (lines 88–104)

```
fn assert_tool_names(body: &serde_json::Value, expected_names: &[&str])
```

**Purpose**: Asserts the exact ordered list of tool names/types in a request body. It normalizes over tools represented by either `name` or `type` fields.

**Data flow**: Reads `body["tools"]` as an array, maps each tool to its `name` or fallback `type` string, collects those into a vector, and compares that vector to the provided expected slice with `assert_eq!`.

**Call relations**: Used by the tool-consistency test after it captures request bodies from two turns.

*Call graph*: called by 1 (prompt_tools_are_consistent_across_requests); 1 external calls (assert_eq!).


##### `normalize_newlines`  (lines 106–108)

```
fn normalize_newlines(text: &str) -> String
```

**Purpose**: Normalizes CRLF line endings to LF for stable string comparisons across platforms. It is used when comparing instruction text emitted in multiple requests.

**Data flow**: Accepts a string slice, replaces all `\r\n` with `\n`, and returns the normalized `String`.

**Call relations**: Used by the GPT-5 instructions consistency test to avoid platform-specific newline noise.


##### `prompt_tools_are_consistent_across_requests`  (lines 111–223)

```
async fn prompt_tools_are_consistent_across_requests() -> anyhow::Result<()>
```

**Purpose**: Verifies that repeated turns produce identical instructions and tool lists, preserving prompt-cache friendliness. It also checks whether `APPLY_PATCH_TOOL_INSTRUCTIONS` should be appended based on the visible tool set.

**Data flow**: Starts a mock server with two SSE responses, builds `TestCodex` with global instructions, model `gpt-5.2`, cached web search mode, and collaboration modes enabled, fetches the model's `base_instructions` from the models manager, submits two text turns, waits for completion after each, computes the expected tool names based on platform, derives expected instructions depending on whether `apply_patch` is present, then asserts both captured request bodies have the same `instructions` and exact tool list.

**Call relations**: This direct test drives two ordinary turns and uses `assert_tool_names` for structural verification. It covers the stable-prefix branch where nothing about the thread changes between requests.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_tool_names); 6 external calls (default, assert_eq!, cfg!, wait_for_event, skip_if_no_network!, vec!).


##### `gpt_5_tools_without_apply_patch_append_apply_patch_instructions`  (lines 226–302)

```
async fn gpt_5_tools_without_apply_patch_append_apply_patch_instructions() -> anyhow::Result<()>
```

**Purpose**: Checks that GPT-5 instruction text remains stable across requests in the tool configuration under test, including any apply-patch instruction augmentation. It is a lighter regression test focused on instruction-string consistency.

**Data flow**: Starts a mock server with two SSE responses, builds `TestCodex` with global instructions, collaboration modes enabled, and model `gpt-5.2`, submits two text turns, waits for completion, extracts `instructions` strings from both captured request bodies, asserts the first is non-empty, and compares the normalized strings for equality.

**Call relations**: Invoked directly by the test runner. It complements the previous test by focusing on instruction text rather than enumerating the full tool list.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `prefixes_context_and_instructions_once_and_consistently_across_requests`  (lines 305–399)

```
async fn prefixes_context_and_instructions_once_and_consistently_across_requests() -> anyhow::Result<()>
```

**Purpose**: Verifies that the initial prompt prefix contains permissions plus one cached contextual user message bundling global instructions and environment context, and that this prefix is reused unchanged on later turns. It checks the core prompt-caching layout.

**Data flow**: Starts a mock server with two SSE responses, builds `TestCodex` with global instructions and collaboration modes enabled, submits two text turns, waits for completion, then inspects the first request's `input` array. It asserts the array length is three, validates the cached contextual user message content and environment context via `assert_default_env_context`, checks the first request's final item equals the expected user message JSON, then asserts the second request begins with the exact same prefix and appends only the second user message.

**Call relations**: This direct test uses the JSON-construction helpers and environment-context assertions to prove prefix reuse across turns with no settings changes.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_default_env_context); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `overrides_turn_context_but_keeps_cached_prefix_and_key_constant`  (lines 402–529)

```
async fn overrides_turn_context_but_keeps_cached_prefix_and_key_constant() -> anyhow::Result<()>
```

**Purpose**: Checks that thread-level settings changes after the first turn do not alter the original prompt-cache key or cached prefix, but instead append one updated permissions/settings message and one updated environment-context message before the new user input. It validates cache-preserving incremental updates.

**Data flow**: Starts a mock server with two SSE responses, builds `TestCodex` with global instructions and collaboration modes enabled, submits a first text turn, then creates a writable temp dir and managed workspace-write `PermissionProfile`, derives a legacy sandbox policy, submits thread settings overriding approval policy, sandbox/profile, reasoning effort, and summary, submits a second text turn, and waits for completion. It compares the two request bodies, asserting identical `prompt_cache_key`, identical reused prefix from request one, a distinct appended permissions/settings message in request two, and an appended environment-context message whose text passes `assert_env_context_fragment` and contains the managed restricted filesystem profile with the writable path.

**Call relations**: This direct test exercises the persistent thread-settings override path via `submit_thread_settings`. It is the main regression test for 'append updates, do not rewrite prefix' behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_env_context_fragment, workspace_write_with); 10 external calls (default, new, assert!, assert_eq!, assert_ne!, submit_thread_settings, wait_for_event, json!, skip_if_no_network!, vec!).


##### `override_before_first_turn_emits_environment_context`  (lines 532–688)

```
async fn override_before_first_turn_emits_environment_context() -> anyhow::Result<()>
```

**Purpose**: Verifies that if thread settings are overridden before any user turn, the first outbound request still includes environment context and reflects the overridden approval/model/reasoning settings. It covers the no-baseline branch of prompt assembly.

**Data flow**: Starts a mock server with one SSE response, builds a default `TestCodex`, constructs a `CollaborationMode` selecting model `gpt-5.4` with high reasoning effort, submits thread settings overriding approval policy to `Never`, model to `gpt-5.4`, effort to low, and collaboration mode to the high-effort settings, then submits the first text turn and waits for completion. It inspects the captured request body, asserting model `gpt-5.4`, reasoning effort `high` from collaboration mode, presence of at least one environment-context fragment, presence of a developer permissions message reflecting approval policy `never`, and inclusion of the user text.

**Call relations**: Called directly by the test runner. Unlike the later override tests, it applies settings before any turn exists, proving the first request still emits the necessary context and settings-derived prompt fragments.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `per_turn_overrides_keep_cached_prefix_and_key_constant`  (lines 691–816)

```
async fn per_turn_overrides_keep_cached_prefix_and_key_constant() -> anyhow::Result<()>
```

**Purpose**: Checks that per-turn `thread_settings` overrides behave like persistent overrides with respect to prompt caching: the original prefix and cache key stay constant, and only appended update/context messages describe the changed turn settings. It also verifies model-switch signaling.

**Data flow**: Starts a mock server with two SSE responses, builds `TestCodex` with global instructions and collaboration modes enabled, submits a first plain text turn, then creates new cwd and writable temp dirs, builds a workspace-write permission profile, converts it with `turn_permission_fields`, and submits a second `Op::UserInput` whose `thread_settings` override environments, approval policy, sandbox/profile, model `o3`, reasoning effort, and summary. After completion it compares request bodies, asserting equal `prompt_cache_key`, identical reused prefix from request one, an appended developer settings-update message containing `<model_switch>`, an appended user-role environment-context message validated by `assert_default_env_context` against the new cwd, and the final second user message.

**Call relations**: This direct test differs from the persistent-override test by embedding overrides in the second turn itself rather than calling `submit_thread_settings`. It proves both paths preserve cache-friendly prefix reuse.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, assert_default_env_context, workspace_write_with); 9 external calls (default, new, assert!, assert_eq!, assert_ne!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `send_user_turn_with_no_changes_does_not_send_environment_context`  (lines 819–955)

```
async fn send_user_turn_with_no_changes_does_not_send_environment_context() -> anyhow::Result<()>
```

**Purpose**: Ensures that when per-turn overrides restate the thread's effective defaults, the second request does not emit a fresh environment-context update. Instead it should reuse the cached contextual prefix and append only the new user message after prior conversation history.

**Data flow**: Starts a mock server with two SSE responses, builds `TestCodex` with global instructions and collaboration modes enabled, records default cwd, approval policy, sandbox policy, model, reasoning effort, and summary from config/session state, submits a first turn whose `thread_settings` explicitly restate those defaults, waits for completion, submits a second turn with the same explicit defaults, waits again, then reconstructs the exact expected `input` arrays for both requests using `text_user_input` and `text_user_input_parts`. It asserts request one contains permissions + cached contextual user message + first user message, and request two contains that same prefix plus the second user message, with no extra environment-context update inserted.

**Call relations**: This direct test uses the JSON helpers heavily to compare full request bodies. It covers the subtle branch where explicit per-turn settings are present but semantically unchanged.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, assert_default_env_context, text_user_input, text_user_input_parts); 6 external calls (default, assert_eq!, wait_for_event, Array, skip_if_no_network!, vec!).


##### `send_user_turn_with_changes_sends_environment_context`  (lines 958–1124)

```
async fn send_user_turn_with_changes_sends_environment_context() -> anyhow::Result<()>
```

**Purpose**: Verifies that when per-turn overrides materially change permissions, model, and reasoning settings, the second request appends both a developer settings-update message and a fresh environment-context message. It is the changed-settings counterpart to the previous no-change test.

**Data flow**: Starts a mock server with two SSE responses, builds `TestCodex` with global instructions and collaboration modes enabled, submits a first turn with explicit default-equivalent settings, waits for completion, then derives disabled permission fields with `turn_permission_fields(PermissionProfile::Disabled, ...)` and submits a second turn overriding approval policy to `Never`, permission profile to disabled/unrestricted, summary to `Detailed`, and collaboration mode to model `o3` with high reasoning effort. After completion it reconstructs the expected first request body, then inspects the second request to assert a distinct appended developer settings-update message containing `<model_switch>`, an appended environment-context message whose text passes `assert_env_context_fragment` and contains the disabled unrestricted filesystem profile, and the final second user message.

**Call relations**: This direct test pairs with the previous one to show the diffing behavior around per-turn overrides: unchanged settings reuse the prefix only, changed settings append update/context messages.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, assert_default_env_context, assert_env_context_fragment, text_user_input, text_user_input_parts); 8 external calls (default, assert!, assert_eq!, assert_ne!, wait_for_event, Array, skip_if_no_network!, vec!).


### `core/tests/suite/prompt_debug_tests.rs`

`test` · `prompt construction regression coverage`

This small test module constructs a real `Config` with a temporary Codex home and working directory, writes `AGENTS.md` containing a fixed instruction string, and then calls `codex_core::build_prompt_input` directly. Unlike the larger prompt-caching suite, it does not stand up mock servers or submit turns through the runtime; instead it exercises the prompt builder in isolation with a `CodexHomeUserInstructionsProvider` wrapped in `Arc` and a single `UserInput::Text` item.

The test verifies two concrete properties of the returned `Vec<ResponseItem>`. First, the last item must be an exact `ResponseItem::Message` with role `user` and one `ContentItem::InputText` containing `hello from debug prompt`, proving the explicit user input is preserved at the tail of the prompt. Second, at least one earlier message item must contain the global instructions text from `AGENTS.md`, whether represented as `InputText` or `OutputText`, proving contextual instructions were injected into the prompt. This makes the file a narrow but valuable regression guard for prompt-debug tooling and direct prompt construction paths.

#### Function details

##### `build_prompt_input_includes_context_and_user_message`  (lines 17–70)

```
async fn build_prompt_input_includes_context_and_user_message() -> Result<()>
```

**Purpose**: Builds prompt input directly from config and user input, then verifies that contextual instructions are present and the final user message appears as the last response item. It is a compact integration test for `build_prompt_input`.

**Data flow**: Creates temporary Codex home and cwd directories, writes `AGENTS.md` with `TEST_INSTRUCTIONS`, builds a `Config` via `ConfigBuilder` and `ConfigOverrides`, constructs a `CodexHomeUserInstructionsProvider`, calls `build_prompt_input` with the config, one `UserInput::Text`, no state DB, and the provider, then asserts the last returned `ResponseItem` equals the expected user message and that some message content anywhere in the vector contains `TEST_INSTRUCTIONS`.

**Call relations**: This is the file's only test entrypoint, invoked directly by the test runner. It bypasses the full runtime and targets the prompt-building function itself.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, new, assert!, assert_eq!, build_prompt_input, default, default, current_exe, write, vec!).


### `core/tests/suite/token_budget.rs`

`test` · `request handling`

This suite focuses on how token-budget state is surfaced to the model. Two small helpers inspect captured requests: `token_budget_texts` extracts developer-role message fragments beginning with `<token_budget>`, and `tool_names` reads the request JSON's `tools` array to confirm feature-gated tool exposure.

The tests configure `Feature::TokenBudget` and either a fixed `model_context_window` or model-info overrides, then drive turns through a mock Responses server. The first group checks prompt injection rules: full-context budget text appears on initial full-context requests and remains stable across ordinary follow-up turns; threshold fragments are appended only when cumulative token usage first crosses 25%, 50%, and 75% boundaries; and when no context window is known, no prompt fragment is injected even though the tool remains available.

The second group validates tool semantics. `get_context_remaining` must be exposed when the feature is enabled and return either the current remaining-budget fragment or an `unknown` variant when no window is available. `new_context` must start a fresh context window before the next follow-up request, causing the subsequent request to carry a new full-context `<token_budget>` block for window 1 and to omit prior-window conversation history. Compaction is treated similarly: after `Op::Compact` completes, the next turn should report `Current context window 1` rather than continuing window 0. Several assertions compare exact serialized prompt fragments, making the tests sensitive to wording, window numbering, and threshold timing.

#### Function details

##### `token_budget_texts`  (lines 29–35)

```
fn token_budget_texts(request: &ResponsesRequest) -> Vec<String>
```

**Purpose**: Extracts all developer-role token-budget prompt fragments from a captured request. It filters specifically for message texts that begin with the `<token_budget>` marker.

**Data flow**: It reads developer message texts from a `ResponsesRequest`, filters the resulting iterator to strings starting with `<token_budget>`, collects them into `Vec<String>`, and returns that vector without mutating request state.

**Call relations**: All tests in this file use it to compare the exact token-budget fragments injected into outbound model requests.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `tool_names`  (lines 37–46)

```
fn tool_names(request: &ResponsesRequest) -> Vec<String>
```

**Purpose**: Returns the names of tools advertised in a captured request body. It is used to verify that token-budget tools are exposed when the feature is enabled.

**Data flow**: It reads the request JSON via `body_json()`, navigates to the `tools` array, iterates each tool object, extracts the `name` string when present, and returns the collected names as `Vec<String>`.

**Call relations**: The `get_context_remaining` and `new_context` tests use this helper to assert that the corresponding tools are present in the request sent to the model.

*Call graph*: calls 1 internal fn (body_json).


##### `token_budget_context_is_only_emitted_with_full_context`  (lines 49–98)

```
async fn token_budget_context_is_only_emitted_with_full_context() -> Result<()>
```

**Purpose**: Verifies that the full-context token-budget annotation is emitted on the initial request and remains unchanged on a later steady-state turn, rather than advancing the context window just because the environment selection changed.

**Data flow**: It starts a mock server with two completed SSE responses, builds a `TestCodex` with `model_context_window = 128000` and `Feature::TokenBudget` enabled, submits a first turn, creates a second working directory, submits a second turn with a local environment selection pointing there, then inspects both captured requests. It computes the expected full-context string using the session thread id and the 95%-effective window size, and asserts both requests contain exactly that one fragment.

**Call relations**: This test establishes the baseline semantics for full-context budget injection before the later threshold and rollover tests add more complex state transitions.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_eq!, skip_if_no_network!, create_dir_all, vec!).


##### `token_budget_remaining_context_emits_on_first_threshold_crossing`  (lines 101–183)

```
async fn token_budget_remaining_context_emits_on_first_threshold_crossing() -> Result<()>
```

**Purpose**: Checks that remaining-budget fragments are appended only when cumulative token usage first crosses configured thresholds, and are not duplicated on later turns that stay within the same threshold band.

**Data flow**: It mounts five SSE responses with total-token counts of 2500, 3000, 5000, 8000, and an unmetered completion, builds a token-budget-enabled `TestCodex` with a 10000-token context window, submits five sequential turns, then inspects all five requests. It constructs the expected full-context fragment plus threshold fragments for 7000, 4500, and 1500 tokens remaining, and asserts the exact fragment list present on each request as thresholds are crossed.

**Call relations**: This test exercises the feature's cumulative accounting logic and threshold edge behavior, complementing the simpler full-context-only case.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_eq!, format!, skip_if_no_network!, vec!).


##### `get_context_remaining_returns_token_budget_remaining_fragment`  (lines 186–252)

```
async fn get_context_remaining_returns_token_budget_remaining_fragment() -> Result<()>
```

**Purpose**: Verifies that the `get_context_remaining` tool is exposed and returns the same remaining-budget fragment that is injected into the request once some tokens have been spent.

**Data flow**: It mounts a three-response sequence: a first turn that spends 2500 tokens, a second turn where the model calls `get_context_remaining`, and a final assistant completion. It builds a token-budget-enabled `TestCodex` with a 10000-token window, submits the first and second turns, inspects the second request to confirm the tool is advertised and that both the full-context and remaining-context fragments are present, then inspects the third request's function-call output to assert the tool returned the remaining-context fragment as content.

**Call relations**: This test links prompt injection and tool output, proving both surfaces derive from the same remaining-budget state.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `get_context_remaining_returns_unknown_when_window_is_unavailable`  (lines 255–315)

```
async fn get_context_remaining_returns_unknown_when_window_is_unavailable() -> Result<()>
```

**Purpose**: Checks the fallback behavior when no context window can be determined from config or model metadata: the tool remains available, but prompt injection is omitted and the tool returns an `unknown tokens left` fragment.

**Data flow**: It mounts a two-response sequence where the first turn calls `get_context_remaining`, builds a `TestCodex` with model-info overrides clearing both `context_window` and `max_context_window`, leaves `config.model_context_window` unset, enables `Feature::TokenBudget`, submits one turn, then inspects the captured requests. It asserts the tool is advertised, `token_budget_texts` on the first request is empty, and the second request contains a function-call output with the exact unknown-budget fragment.

**Call relations**: This test covers the unavailable-window branch of the feature, contrasting with the known-window accounting exercised elsewhere in the file.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `token_budget_context_uses_new_window_after_compaction`  (lines 318–374)

```
async fn token_budget_context_uses_new_window_after_compaction() -> Result<()>
```

**Purpose**: Ensures that after an explicit `Op::Compact`, the next turn starts a new context window and the full-context token-budget annotation reports window index 1 instead of 0.

**Data flow**: It mounts three SSE responses for a normal turn, the compaction turn, and a post-compaction turn; clones the built-in OpenAI provider and rewires its `base_url` to the mock server with websockets disabled; builds a token-budget-enabled `TestCodex` using that provider and a 128000-token window; submits a normal turn; submits `Op::Compact` directly to `test.codex`; waits for a `TurnComplete`; submits another turn; then inspects the third request and asserts its token-budget fragment includes the session thread id, `Current context window 1`, and the effective remaining token count.

**Call relations**: This test validates that compaction resets token-budget window numbering in the same way a fresh context window should, using direct operation submission rather than a model-invoked tool.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 6 external calls (assert_eq!, built_in_model_providers, wait_for_event, format!, skip_if_no_network!, vec!).


##### `new_context_tool_starts_new_window_before_follow_up`  (lines 377–458)

```
async fn new_context_tool_starts_new_window_before_follow_up() -> Result<()>
```

**Purpose**: Verifies that the `new_context` tool starts a fresh context window mid-turn before the next follow-up request, dropping prior-window history and installing a new full-context token-budget annotation for window 1.

**Data flow**: It mounts a three-response sequence where the first response calls `new_context`, the second calls `update_plan` with a serialized plan payload, and the third completes the turn. It builds a token-budget-enabled `TestCodex` with a 128000-token window, submits one turn, inspects the three captured requests, confirms `new_context` is advertised in the first request, asserts the third request contains the expected full-context fragment for window 1, asserts the third request body no longer contains the original user prompt, checks that the `update_plan` call output text is `Plan updated`, then formats a labeled request snapshot with `context_snapshot::format_labeled_requests_snapshot`, normalizes the thread id, and snapshot-tests the final follow-up request.

**Call relations**: This is the most end-to-end token-budget test: it validates tool exposure, state transition, prompt reconstruction, history dropping, and downstream tool-call continuity after the new window is created.

*Call graph*: calls 5 internal fn (default, format_labeled_requests_snapshot, mount_sse_sequence, start_mock_server, test_codex); 6 external calls (assert!, assert_eq!, assert_snapshot!, json!, skip_if_no_network!, vec!).


### Provider request shaping
These tests focus on how assembled prompts and settings are translated into concrete provider-facing request payloads and tool definitions.

### `core/tests/suite/json_result.rs`

`test` · `request handling`

This file is a focused regression test around structured JSON output. It defines a concrete schema string requiring two string properties, `explanation` and `final_answer`, with `additionalProperties: false`. The two top-level tests are just wrappers that invoke the shared async helper with the same GPT-5 model slug.

The shared helper mounts a mock SSE response containing a single assistant message whose text is already valid JSON matching the schema. More importantly, it installs the mock with a request matcher closure that inspects the outbound HTTP body and verifies the exact nested shape under `text.format`: `name` must be `codex_output_schema`, `type` must be `json_schema`, `strict` must be `true`, and `schema` must equal the parsed `SCHEMA` value byte-for-byte as JSON. After building `TestCodex`, the test derives deterministic thread settings using `turn_permission_fields`, disables approvals, selects the local environment, and sets a collaboration mode whose `Settings.model` is the supplied model string. It then submits `Op::UserInput` with `final_output_json_schema: Some(parsed_schema)`.

On the event side, the test waits for an `EventMsg::AgentMessage`, parses the returned message text as JSON, and asserts that both required fields are present with the expected values. If some other event arrives instead, it explicitly fails with `anyhow::bail!`, making the contract clear: structured output still surfaces as an agent message whose body is valid JSON text.

#### Function details

##### `codex_returns_json_result_for_gpt5`  (lines 34–36)

```
async fn codex_returns_json_result_for_gpt5() -> anyhow::Result<()>
```

**Purpose**: Runs the shared structured-output test under the `gpt-5.4` model label. It exists as one named entry point in the test suite.

**Data flow**: Takes no arguments and asynchronously calls `codex_returns_json_result("gpt-5.4".to_string())`. It returns the helper’s `anyhow::Result<()>` unchanged.

**Call relations**: This wrapper delegates entirely to `codex_returns_json_result`. Its role is to provide a concrete test case name for one model variant.

*Call graph*: calls 1 internal fn (codex_returns_json_result).


##### `codex_returns_json_result_for_gpt5_codex`  (lines 39–41)

```
async fn codex_returns_json_result_for_gpt5_codex() -> anyhow::Result<()>
```

**Purpose**: Runs the same shared structured-output test under a second test name intended for the GPT-5 Codex path. In the current source it passes the same `gpt-5.4` model string as the other wrapper.

**Data flow**: Takes no arguments and asynchronously invokes `codex_returns_json_result("gpt-5.4".to_string())`, returning that result directly.

**Call relations**: Like the first wrapper, this function exists only to route into `codex_returns_json_result` with a chosen model string and expose a separately named test.

*Call graph*: calls 1 internal fn (codex_returns_json_result).


##### `codex_returns_json_result`  (lines 43–122)

```
async fn codex_returns_json_result(model: String) -> anyhow::Result<()>
```

**Purpose**: Verifies both halves of the JSON-result contract: the outbound request includes the exact JSON-schema formatting directive, and the inbound assistant message contains JSON matching that schema. It is the substantive test logic for the file.

**Data flow**: Accepts a model slug string. It skips without network, starts a mock server, builds an SSE response containing a JSON object string, parses `SCHEMA` into `serde_json::Value`, and defines a request-matcher closure that deserializes the outbound request body and checks `body["text"]["format"]` for the expected `name`, `type`, `strict`, and `schema` fields. After mounting that conditional mock, it builds `TestCodex`, derives sandbox and permission settings from the cwd, submits `Op::UserInput` with one text item, `final_output_json_schema: Some(parsed schema)`, local environment selection, approvals disabled, and a collaboration mode using the supplied model. It waits for an `EventMsg::AgentMessage`, parses `message.message` as JSON, asserts the two expected fields, and otherwise fails if a non-agent-message event is observed.

**Call relations**: Both top-level wrapper tests call this helper. It coordinates mock request matching, test instance setup, turn submission, and final event validation, making it the single place where the structured-output request/response contract is asserted.

*Call graph*: calls 6 internal fn (mount_sse_once_match, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); called by 2 (codex_returns_json_result_for_gpt5, codex_returns_json_result_for_gpt5_codex); 7 external calls (default, bail!, assert_eq!, wait_for_event, from_str, skip_if_no_network!, vec!).


### `core/tests/suite/web_search.rs`

`test` · `request construction during turn submission tests`

This file is a compact request-shape test suite for web search. It does not inspect event streams; instead, each test mounts a minimal SSE completion response, submits one or more turns, and inspects the captured request body's `tools` array. The helper `find_web_search_tool` locates the `{"type": "web_search"}` entry so the tests can assert on its fields.

The first three tests establish mode semantics: `WebSearchMode::Cached` forces `external_web_access: false`; that explicit mode wins over legacy `Feature::WebSearchRequest`; and when both legacy web-search features are disabled, the default still behaves as cached for read-only turns. Another test submits two turns with different permission profiles and shows that default behavior changes between turns: read-only defaults to cached (`false`) while `PermissionProfile::Disabled` defaults to live (`true`). The final test writes a real `config.toml` under a temporary home with `web_search = "live"` and a `[tools.web_search]` section, then asserts the request forwards `search_context_size`, `allowed_domains`, and approximate `user_location` exactly. Together these tests define the precedence order between config mode, legacy flags, and permission-profile-derived defaults.

#### Function details

##### `find_web_search_tool`  (lines 15–22)

```
fn find_web_search_tool(body: &Value) -> &Value
```

**Purpose**: Finds the `web_search` tool object inside a request body's `tools` array.

**Data flow**: It indexes `body["tools"]`, expects an array, iterates until it finds an element whose `type` field is `web_search`, and returns a reference to that JSON value.

**Call relations**: Every test in the file uses this helper after capturing a request body so assertions can focus on tool fields rather than array traversal.

*Call graph*: called by 5 (web_search_mode_cached_sets_external_web_access_false, web_search_mode_defaults_to_cached_when_features_disabled, web_search_mode_takes_precedence_over_legacy_flags, web_search_mode_updates_between_turns_with_permission_profile, web_search_tool_config_from_config_toml_is_forwarded_to_request).


##### `web_search_mode_cached_sets_external_web_access_false`  (lines 25–60)

```
async fn web_search_mode_cached_sets_external_web_access_false()
```

**Purpose**: Checks that explicitly configuring cached web search produces a `web_search` tool with `external_web_access: false`.

**Data flow**: It mounts a minimal SSE response, builds a test with model `gpt-5.4` and `web_search_mode = Cached`, submits a read-only turn, extracts the request body from the mock, finds the web-search tool, and asserts its `external_web_access` field is `Some(false)`.

**Call relations**: This is the baseline explicit-mode test for cached behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, find_web_search_tool, read_only); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `web_search_mode_takes_precedence_over_legacy_flags`  (lines 63–102)

```
async fn web_search_mode_takes_precedence_over_legacy_flags()
```

**Purpose**: Verifies that explicit `web_search_mode` overrides the older `WebSearchRequest` feature flag.

**Data flow**: It mounts a minimal SSE response, builds a test with `Feature::WebSearchRequest` enabled and `web_search_mode = Cached`, submits a read-only turn, inspects the request body, and asserts the web-search tool still has `external_web_access: false`.

**Call relations**: This test establishes precedence between the new mode setting and legacy feature toggles.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, find_web_search_tool, read_only); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `web_search_mode_defaults_to_cached_when_features_disabled`  (lines 105–148)

```
async fn web_search_mode_defaults_to_cached_when_features_disabled()
```

**Purpose**: Checks that when legacy web-search features are disabled, the default request still uses cached mode for a read-only turn.

**Data flow**: It mounts a minimal SSE response, builds a test with `web_search_mode = Cached` and both `WebSearchCached` and `WebSearchRequest` disabled, submits a read-only turn, inspects the request body, and asserts `external_web_access: false`.

**Call relations**: This test documents the default cached behavior in the absence of legacy feature support.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, find_web_search_tool, read_only); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `web_search_mode_updates_between_turns_with_permission_profile`  (lines 151–218)

```
async fn web_search_mode_updates_between_turns_with_permission_profile()
```

**Purpose**: Verifies that default web-search behavior is recomputed per turn from the permission profile, switching between cached and live access.

**Data flow**: It mounts two SSE responses, builds a test with cached mode configured and both legacy features disabled, submits a first turn with `PermissionProfile::read_only()` and a second with `PermissionProfile::Disabled`, then inspects both captured request bodies. It asserts the first tool has `external_web_access: false` and the second has `external_web_access: true`.

**Call relations**: This is the only multi-turn test in the file and proves that web-search defaults are not fixed for the whole session.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, find_web_search_tool, read_only); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `web_search_tool_config_from_config_toml_is_forwarded_to_request`  (lines 221–276)

```
async fn web_search_tool_config_from_config_toml_is_forwarded_to_request()
```

**Purpose**: Checks that detailed web-search tool configuration from `config.toml` is forwarded verbatim into the request tool object.

**Data flow**: It writes a temporary home `config.toml` setting `web_search = "live"` and `[tools.web_search]` fields for context size, allowed domains, and location, builds a test using that home and model `gpt-5.3-codex`, submits a turn with disabled permissions, extracts the request body, finds the web-search tool, and asserts it exactly equals the expected JSON object including `external_web_access: true`, `search_context_size`, `filters.allowed_domains`, and `user_location`.

**Call relations**: This test extends beyond mode booleans to verify full config forwarding into the provider request.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, find_web_search_tool); 6 external calls (new, assert_eq!, skip_if_no_network!, write, new, vec!).


### Remote metadata and runtime selection
These suites verify how remote model metadata influences runtime capabilities, selector behavior, and specialized review-model overrides.

### `core/tests/suite/remote_models.rs`

`test` · `integration test execution for model catalog refresh, selection, and turn startup`

This module exercises the models-manager path that combines bundled model presets with `/v1/models` data from a remote provider. Most tests stand up a `wiremock::MockServer`, mount a synthetic `ModelsResponse`, and either query a `SharedModelsManager` directly or build a `TestCodex` and inspect the resulting turn behavior. The helper constructors `test_remote_model` and `test_remote_model_with_policy` produce realistic `ModelInfo` values with configurable slug, visibility, priority, and truncation policy; `bundled_model_slug` and `bundled_default_model_slug` expose expectations derived from the bundled catalog.

Several tests focus on metadata lookup and runtime application. One verifies that `get_model_info` chooses the longest matching slug prefix, so `gpt-5.3-codex-test` inherits metadata from `gpt-5.3-codex` rather than `gpt-5.3`. Three context-window tests confirm that a configured `model_context_window` is clamped to `max_context_window` when present, while the no-override path preserves the model's advertised `context_window`. Another test checks that a long requested slug is sent unchanged to the API while still inheriting remote defaults such as custom reasoning effort and reasoning summary.

The remaining tests cover catalog merge semantics and runtime tool behavior. They verify that namespaced slugs avoid fallback warnings, a remote model with `shell_type = UnifiedExec` causes startup execs to be tagged as `ExecCommandSource::UnifiedExecStartup`, remote truncation policies survive unless overridden by `tool_output_token_limit`, remote base instructions do not overwrite the selected built-in model's instructions in the request, hidden models remain hidden in the picker, high-priority remote models sort first, overlapping remote models replace bundled metadata, empty remote responses preserve bundled models, and a delayed `/models` response times out after roughly five seconds while still returning the bundled default model.

#### Function details

##### `remote_models_get_model_info_uses_longest_matching_prefix`  (lines 57–116)

```
async fn remote_models_get_model_info_uses_longest_matching_prefix() -> Result<()>
```

**Purpose**: Checks that model metadata lookup prefers the longest matching remote slug prefix when the requested model name extends a known prefix. This prevents generic metadata from overriding a more specific remote entry.

**Data flow**: Builds two `ModelInfo` values for `gpt-5.3` and `gpt-5.3-codex`, customizes their display names and base instructions, mounts them as a `ModelsResponse`, constructs a models manager with dummy ChatGPT auth and an OpenAI provider pointing at the mock server, refreshes models online, calls `get_model_info("gpt-5.3-codex-test", ...)`, and asserts the returned slug is the requested slug while `base_instructions` come from the specific prefix model.

**Call relations**: This test talks directly to the models manager rather than the full turn pipeline, making it the focused proof for prefix-resolution behavior.

*Call graph*: calls 6 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, test_remote_model_with_policy, create_dummy_chatgpt_auth_for_testing, bytes); 9 external calls (start, new, assert_eq!, built_in_model_providers, load_default_config_for_test, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_config_context_window_override_clamps_to_max_context_window`  (lines 122–183)

```
async fn remote_models_config_context_window_override_clamps_to_max_context_window() -> Result<()>
```

**Purpose**: Verifies that an oversized configured context-window override is clamped down to the remote model's advertised `max_context_window` during turn startup.

**Data flow**: Creates a remote `ModelInfo` with `context_window = 273_000`, `max_context_window = 400_000`, and a requested slug `gpt-5.4-test`, mounts both `/models` and a trivial SSE completion, builds a `TestCodex` with dummy auth and config `model_context_window = Some(1_000_000)`, submits a simple `Op::UserInput`, waits for a `TurnStarted` event whose `model_context_window` is `Some(400_000)`, and asserts that value.

**Call relations**: This test uses the full request path so the assertion is made against emitted runtime events, not just static metadata.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_once, sse, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, skip_if_sandbox!, unreachable!, vec!).


##### `remote_models_config_override_above_max_uses_max_context_window`  (lines 189–250)

```
async fn remote_models_config_override_above_max_uses_max_context_window() -> Result<()>
```

**Purpose**: Checks the same clamping rule as the previous test, but with a smaller override that is still above the model's maximum. It confirms the clamp is based on `max_context_window`, not only on absurdly large values.

**Data flow**: Mounts a remote model with `context_window = 273_000` and `max_context_window = 400_000`, builds a `TestCodex` configured with `model_context_window = Some(500_000)`, submits a turn, waits for `TurnStarted(model_context_window = Some(400_000))`, and asserts the runtime value equals the max.

**Call relations**: Like the previous test, it validates runtime event emission after model selection rather than only manager lookup.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_once, sse, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, skip_if_sandbox!, unreachable!, vec!).


##### `remote_models_use_context_window_when_config_override_is_absent`  (lines 256–316)

```
async fn remote_models_use_context_window_when_config_override_is_absent() -> Result<()>
```

**Purpose**: Ensures that when the user does not configure a context-window override, the runtime uses the remote model's default `context_window` even if a larger `max_context_window` is also advertised.

**Data flow**: Creates and mounts a remote model with `context_window = 273_000` and `max_context_window = 400_000`, builds a `TestCodex` with only `config.model` set, submits a turn, waits for `TurnStarted` carrying `Some(273_000)`, and asserts that the default window was preserved.

**Call relations**: This is the no-override counterpart to the two clamping tests, establishing the baseline behavior.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_once, sse, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, skip_if_sandbox!, unreachable!, vec!).


##### `remote_models_long_model_slug_is_sent_with_custom_reasoning`  (lines 319–398)

```
async fn remote_models_long_model_slug_is_sent_with_custom_reasoning() -> Result<()>
```

**Purpose**: Verifies that a requested long slug is sent verbatim in the API request while inheriting remote reasoning defaults from its matching prefix metadata. It specifically covers custom reasoning effort strings and reasoning summaries.

**Data flow**: Builds a remote prefix model `gpt-5.3-codex` with `default_reasoning_level = ReasoningEffort::Custom("max")`, support for reasoning summaries, and `default_reasoning_summary = Detailed`, mounts it and a single SSE completion, builds a `TestCodex` configured with requested model `gpt-5.3-codex-test`, submits a turn, waits for completion, inspects the captured request JSON, and asserts `body["model"] == requested_model`, `reasoning.effort == "max"`, and `reasoning.summary == "detailed"`.

**Call relations**: This test bridges metadata lookup and outbound request serialization, proving that inherited defaults do not rewrite the requested slug.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_once, sse, test_codex, test_remote_model_with_policy, create_dummy_chatgpt_auth_for_testing, bytes); 8 external calls (default, start, assert_eq!, wait_for_event, Custom, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `namespaced_model_slug_uses_catalog_metadata_without_fallback_warning`  (lines 401–450)

```
async fn namespaced_model_slug_uses_catalog_metadata_without_fallback_warning() -> Result<()>
```

**Purpose**: Checks that a namespaced model slug such as `custom/gpt-5.2-codex` uses catalog metadata directly and does not trigger the warning path that falls back to generic metadata.

**Data flow**: Builds a `TestCodex` with the namespaced model slug, mounts a simple SSE completion, submits a turn, then drains events until `TurnComplete`, counting any `Warning` events whose message contains `Defaulting to fallback metadata`. It inspects the captured request body and asserts the model field matches the requested slug and the warning count is zero.

**Call relations**: This test observes both emitted warnings and the final request body to ensure the namespaced-slug path stays on the intended metadata branch.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 7 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_remote_model_uses_unified_exec`  (lines 453–607)

```
async fn remote_models_remote_model_uses_unified_exec() -> Result<()>
```

**Purpose**: Verifies that when a remote model advertises `shell_type = UnifiedExec`, selecting that model causes startup exec activity to be sourced from unified exec rather than the legacy shell path.

**Data flow**: Mounts a remote `ModelInfo` named `codex-test` with `shell_type: ConfigShellToolType::UnifiedExec`, builds a `TestCodex` initially configured for another model, waits for the remote model to appear in the shared models manager, asserts only one `/v1/models` refresh occurred, fetches the model info and checks its shell type, submits thread settings to switch the active model, mounts an SSE sequence containing an `exec_command` tool call, submits a user turn with local environment selections and disabled permissions, waits for `ExecCommandBegin` matching the call id, and asserts `begin_event.source == ExecCommandSource::UnifiedExecStartup` before waiting for turn completion.

**Call relations**: This test depends on `wait_for_model_available` to synchronize with asynchronous model refresh and then drives a full turn to inspect the emitted exec-source event.

*Call graph*: calls 9 internal fn (mount_models_once, mount_sse_sequence, local_selections, test_codex, turn_permission_fields, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 12 external calls (Limited, default, builder, new, assert_eq!, submit_thread_settings, wait_for_event, wait_for_event_match, json!, skip_if_no_network! (+2 more)).


##### `remote_models_truncation_policy_without_override_preserves_remote`  (lines 610–653)

```
async fn remote_models_truncation_policy_without_override_preserves_remote() -> Result<()>
```

**Purpose**: Checks that a remote model's truncation policy is preserved when the user has not configured a tool-output override.

**Data flow**: Mounts a remote model with a byte-limit truncation policy of 12,000, builds a `TestCodex`, waits for the model to become available in the shared manager, fetches its `ModelInfo` through `get_model_info`, and asserts the returned `truncation_policy` remains `TruncationPolicyConfig::bytes(12_000)`.

**Call relations**: This test uses `wait_for_model_available` because model refresh happens asynchronously during test setup.

*Call graph*: calls 6 internal fn (mount_models_once, test_codex, test_remote_model_with_policy, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes); 6 external calls (Limited, builder, assert_eq!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_truncation_policy_with_tool_output_override`  (lines 656–700)

```
async fn remote_models_truncation_policy_with_tool_output_override() -> Result<()>
```

**Purpose**: Verifies that a configured `tool_output_token_limit` rewrites the effective truncation policy derived from remote model metadata.

**Data flow**: Mounts a remote model whose truncation policy is 10,000 bytes, builds a `TestCodex` with `tool_output_token_limit = Some(50)`, waits for the model to appear, fetches model info from the manager, and asserts the effective truncation policy became `TruncationPolicyConfig::bytes(200)`.

**Call relations**: This is the override counterpart to the previous truncation-policy test and uses the same asynchronous model-availability helper.

*Call graph*: calls 6 internal fn (mount_models_once, test_codex, test_remote_model_with_policy, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes); 6 external calls (Limited, builder, assert_eq!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_apply_remote_base_instructions`  (lines 703–834)

```
async fn remote_models_apply_remote_base_instructions() -> Result<()>
```

**Purpose**: Ensures that selecting a remote model does not cause its remote `base_instructions` to replace the built-in base instructions used for the actual request when the active model remains the built-in slug. The test guards against accidental instruction mixing across catalog sources.

**Data flow**: Mounts a remote model with slug `test-gpt-5-remote` and custom `base_instructions`, builds a `TestCodex` initially configured for `gpt-5.2`, waits for the remote model to become available, submits thread settings selecting the remote model, then submits a user turn with local environment selections and disabled permissions. After completion it fetches the built-in `gpt-5.2` model info from the manager, inspects the captured request body, extracts `instructions`, and asserts they equal the built-in model's `base_instructions` rather than the remote model's custom string.

**Call relations**: This test combines asynchronous model refresh, thread-settings mutation, and request inspection to validate instruction selection at request-build time.

*Call graph*: calls 10 internal fn (mount_models_once, mount_sse_once, sse, local_selections, test_codex, turn_permission_fields, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 10 external calls (Limited, default, builder, new, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_do_not_append_removed_builtin_presets`  (lines 837–892)

```
async fn remote_models_do_not_append_removed_builtin_presets() -> Result<()>
```

**Purpose**: Checks that merging remote models into the available preset list does not resurrect removed bundled presets or create duplicate defaults. It validates the shape of the merged picker list.

**Data flow**: Mounts a single remote model `remote-alpha`, constructs a standalone models manager against the mock provider, calls `list_models(OnlineIfUncached)`, finds the remote preset, converts the original `ModelInfo` into an expected `ModelPreset` while preserving the runtime-assigned `is_default` flag, asserts equality, then finds the single picker-visible default model and asserts exactly one preset is marked default and only one `/models` request was made.

**Call relations**: This test stays at the models-manager layer and inspects the merged preset list directly.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, test_remote_model, create_dummy_chatgpt_auth_for_testing); 9 external calls (start, new, assert!, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_merge_adds_new_high_priority_first`  (lines 895–940)

```
async fn remote_models_merge_adds_new_high_priority_first() -> Result<()>
```

**Purpose**: Verifies that a newly introduced remote model with very high priority sorts to the front of the merged model list.

**Data flow**: Mounts a remote model `remote-top` with priority `-10_000`, builds a standalone models manager, lists models online, asserts the first preset's slug is `remote-top`, and checks that exactly one `/models` request hit the mock server.

**Call relations**: This is a focused ordering test for merge/sort behavior in the models manager.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (start, new, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_merge_replaces_overlapping_model`  (lines 943–994)

```
async fn remote_models_merge_replaces_overlapping_model() -> Result<()>
```

**Purpose**: Checks that when a remote model shares a slug with a bundled model, the remote metadata replaces the bundled entry in the merged list.

**Data flow**: Obtains a bundled slug via `bundled_model_slug`, creates a remote model with that slug but overridden display name and description, mounts it, builds a models manager, lists models, finds the overlapping preset, and asserts its display name and description match the remote values rather than the bundled ones. It also verifies only one `/models` request occurred.

**Call relations**: This test uses `bundled_model_slug` to anchor the overlap against a real bundled entry and then validates replacement semantics in the merged catalog.

*Call graph*: calls 6 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, bundled_model_slug, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (start, new, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_merge_preserves_bundled_models_on_empty_response`  (lines 997–1027)

```
async fn remote_models_merge_preserves_bundled_models_on_empty_response() -> Result<()>
```

**Purpose**: Ensures that an empty remote `/models` response does not wipe out bundled models. The bundled catalog must remain available as a fallback source of presets.

**Data flow**: Mounts an empty `ModelsResponse`, builds a standalone models manager, lists models online, computes a known bundled slug with `bundled_model_slug`, and asserts that some available preset still uses that slug.

**Call relations**: This is the empty-response fallback test for merge behavior and complements the overlap and insertion tests.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, bundled_model_slug, create_dummy_chatgpt_auth_for_testing); 8 external calls (start, new, new, assert!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!).


##### `remote_models_request_times_out_after_5s`  (lines 1030–1095)

```
async fn remote_models_request_times_out_after_5s() -> Result<()>
```

**Purpose**: Verifies that remote model refreshes time out after roughly five seconds and that the manager still returns the bundled default model instead of hanging or failing.

**Data flow**: Mounts a delayed `/models` response that waits six seconds, builds a standalone models manager, records `Instant::now()`, wraps `manager.get_default_model(..., OnlineIfUncached)` in a seven-second Tokio timeout, measures elapsed time, asserts the returned model equals `bundled_default_model_slug()`, checks the elapsed duration is near but below the delayed response time, and confirms exactly one `/models` request was issued.

**Call relations**: This test uses `bundled_default_model_slug` to define the expected fallback and validates timeout behavior at the manager boundary.

*Call graph*: calls 6 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once_with_delay, bundled_default_model_slug, test_remote_model, create_dummy_chatgpt_auth_for_testing); 12 external calls (from_secs, now, start, new, assert!, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox! (+2 more)).


##### `remote_models_hide_picker_only_models`  (lines 1098–1149)

```
async fn remote_models_hide_picker_only_models() -> Result<()>
```

**Purpose**: Checks that remote models marked with `ModelVisibility::Hide` remain available internally but are not shown in the picker and do not become the default selection.

**Data flow**: Mounts a hidden remote model `codex-auto-balanced`, builds a standalone models manager, asks for the default model and asserts it remains the bundled default, lists models, finds the hidden remote preset, asserts `show_in_picker` is false, and verifies only one `/models` request occurred.

**Call relations**: This test covers visibility semantics in the merged preset list and complements the priority/default-selection tests.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, test_remote_model, create_dummy_chatgpt_auth_for_testing); 9 external calls (start, new, assert!, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `wait_for_model_available`  (lines 1151–1165)

```
async fn wait_for_model_available(manager: &SharedModelsManager, slug: &str) -> ModelPreset
```

**Purpose**: Polls the shared models manager until a model with the requested slug appears or a short deadline expires. It hides the asynchronous refresh timing from tests that need a stable catalog before asserting.

**Data flow**: Takes a `&SharedModelsManager` and slug, computes a deadline two seconds in the future, repeatedly calls `list_models(OnlineIfUncached)`, clones and returns the first matching `ModelPreset` if found, otherwise sleeps 25 ms and retries until the deadline, then panics on timeout.

**Call relations**: Several runtime tests call this helper before fetching model info or switching thread settings so they do not race the background `/models` refresh.

*Call graph*: called by 4 (remote_models_apply_remote_base_instructions, remote_models_remote_model_uses_unified_exec, remote_models_truncation_policy_with_tool_output_override, remote_models_truncation_policy_without_override_preserves_remote); 6 external calls (from_millis, from_secs, now, list_models, panic!, sleep).


##### `bundled_model_slug`  (lines 1167–1175)

```
fn bundled_model_slug() -> String
```

**Purpose**: Returns the slug of the first bundled model from the parsed bundled models response. It gives merge tests a concrete bundled entry to compare against.

**Data flow**: Parses `bundled_models_response()`, takes the first model from `response.models`, clones its `slug`, and returns it, panicking if parsing fails or the list is empty.

**Call relations**: Used by overlap and empty-response tests to anchor assertions to a real bundled model rather than a hard-coded slug.

*Call graph*: called by 2 (remote_models_merge_preserves_bundled_models_on_empty_response, remote_models_merge_replaces_overlapping_model); 1 external calls (bundled_models_response).


##### `bundled_default_model_slug`  (lines 1177–1184)

```
fn bundled_default_model_slug() -> String
```

**Purpose**: Finds the bundled preset marked as default and returns its model slug. It is used as the expected fallback selection when remote refreshes fail or hidden models should not win.

**Data flow**: Calls `codex_core::test_support::all_model_presets()`, finds the preset with `is_default == true`, clones its `model` field, and returns it.

**Call relations**: Only the timeout test calls this helper to define the expected default model after a failed remote refresh.

*Call graph*: calls 1 internal fn (all_model_presets); called by 1 (remote_models_request_times_out_after_5s).


##### `test_remote_model`  (lines 1186–1193)

```
fn test_remote_model(slug: &str, visibility: ModelVisibility, priority: i32) -> ModelInfo
```

**Purpose**: Convenience constructor for a remote `ModelInfo` using the standard 10,000-byte truncation policy. It reduces boilerplate in tests that only vary slug, visibility, and priority.

**Data flow**: Accepts a slug, `ModelVisibility`, and priority, delegates to `test_remote_model_with_policy` with `TruncationPolicyConfig::bytes(10_000)`, and returns the resulting `ModelInfo`.

**Call relations**: Many tests use this wrapper when truncation policy is not the variable under test.

*Call graph*: calls 2 internal fn (test_remote_model_with_policy, bytes); called by 8 (remote_models_config_context_window_override_clamps_to_max_context_window, remote_models_config_override_above_max_uses_max_context_window, remote_models_do_not_append_removed_builtin_presets, remote_models_hide_picker_only_models, remote_models_merge_adds_new_high_priority_first, remote_models_merge_replaces_overlapping_model, remote_models_request_times_out_after_5s, remote_models_use_context_window_when_config_override_is_absent).


##### `test_remote_model_with_policy`  (lines 1195–1244)

```
fn test_remote_model_with_policy(
    slug: &str,
    visibility: ModelVisibility,
    priority: i32,
    truncation_policy: TruncationPolicyConfig,
) -> ModelInfo
```

**Purpose**: Builds a fully populated synthetic `ModelInfo` suitable for remote-model tests, with configurable slug, visibility, priority, and truncation policy. It standardizes all other fields so tests can focus on the metadata they care about.

**Data flow**: Consumes the slug, visibility, priority, and `TruncationPolicyConfig`, then returns a `ModelInfo` populated with generated display name/description, medium reasoning defaults, `ConfigShellToolType::ShellCommand`, default input modalities, disabled optional features, the supplied truncation policy, and a 272k context window with 95% effective window percent.

**Call relations**: This is the base fixture constructor for the file; more specialized tests either call it directly or go through `test_remote_model`.

*Call graph*: calls 1 internal fn (default_input_modalities); called by 5 (remote_models_get_model_info_uses_longest_matching_prefix, remote_models_long_model_slug_is_sent_with_custom_reasoning, remote_models_truncation_policy_with_tool_output_override, remote_models_truncation_policy_without_override_preserves_remote, test_remote_model); 4 external calls (default, new, format!, vec!).


### `core/tests/suite/model_runtime_selectors.rs`

`test` · `startup`

This file exercises the runtime path where Codex consults remotely advertised `ModelInfo` and uses its selectors to shape the tool list and multi-agent mode for a turn. The helper `remote_model` starts from `model_info_from_slug` and forces `ModelVisibility::List`, producing realistic remote entries. `tool_names` extracts the names or types of tools from a captured request body so tests can assert on the exact tool surface sent upstream. `wait_for_model_available` polls a `SharedModelsManager` online until a given slug appears, avoiding races between startup and model-list refresh.

The central helper, `response_body_for_remote_model`, mounts a one-shot `/models` response containing a supplied `ModelInfo`, mounts a trivial SSE completion, builds `TestCodex` with dummy ChatGPT auth and caller-provided config mutations, waits until the remote model is visible, submits thread settings selecting that model, sends a simple user turn, waits for `TurnComplete`, and returns the JSON body of the captured Responses API request. The tests then inspect that body’s tool list.

One test proves `ToolMode::Direct` suppresses code-mode tools even if `Feature::CodeModeOnly` is enabled locally, while `ToolMode::CodeModeOnly` yields exactly the code-mode entrypoints plus hosted `web_search` and `image_generation` for an image-capable model. Another proves `MultiAgentVersion::V2` enables `send_message` even if the local feature flag is disabled, while `MultiAgentVersion::Disabled` removes all multi-agent tools even if the local feature is enabled. The final test shows that selecting a different model via thread settings before the first turn leaves `codex.multi_agent_version()` unset until the turn runs, then resolves it from the selected model and sends the corresponding multi-agent tool surface.

#### Function details

##### `remote_model`  (lines 40–46)

```
fn remote_model(slug: &str) -> ModelInfo
```

**Purpose**: Constructs a realistic remote `ModelInfo` from a slug while forcing it to be list-visible and not marked as fallback metadata. It is the base fixture builder for all remote-selector tests.

**Data flow**: Takes a model slug `&str`, calls `model_info_from_slug(slug)`, and returns a `ModelInfo` with `visibility: ModelVisibility::List`, `used_fallback_model_metadata: false`, and all remaining fields copied from the slug-derived base model info.

**Call relations**: Called by all three top-level tests to create the remote model entries they then customize with `tool_mode` or `multi_agent_version`. It keeps those tests focused on the selector fields under examination.

*Call graph*: calls 1 internal fn (model_info_from_slug); called by 3 (remote_multi_agent_selector_overrides_feature_flags, remote_multi_agent_selector_uses_model_selected_before_first_turn, remote_tool_mode_selector_overrides_feature_flags).


##### `tool_names`  (lines 48–63)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: Extracts the effective tool names from a captured request body so tests can compare the runtime-selected tool surface. It tolerates tools represented either by `name` or by `type`.

**Data flow**: Accepts a `serde_json::Value` request body. It looks up `body["tools"]` as an array, iterates each tool object, reads `tool["name"]` or falls back to `tool["type"]`, converts any string values to owned `String`s, collects them into `Vec<String>`, and returns an empty vector if the field is absent or not an array.

**Call relations**: Used by the selector tests after `response_body_for_remote_model` or direct request capture. It is the final inspection helper that turns raw request JSON into a concise list suitable for assertions.

*Call graph*: called by 2 (remote_multi_agent_selector_overrides_feature_flags, remote_tool_mode_selector_overrides_feature_flags); 1 external calls (get).


##### `wait_for_model_available`  (lines 65–82)

```
async fn wait_for_model_available(manager: &SharedModelsManager, slug: &str) -> ModelPreset
```

**Purpose**: Polls the shared models manager until a specific remote model slug appears in the online model list, then returns that `ModelPreset`. It hides the asynchronous refresh timing from the tests.

**Data flow**: Receives a `&SharedModelsManager` and a target slug. It computes a deadline two seconds in the future, repeatedly calls `manager.list_models(RefreshStrategy::Online).await`, searches for a model whose `model` field equals the slug, and returns a clone when found. If the deadline passes first it panics; otherwise it sleeps 25 ms between polls.

**Call relations**: Called only by `response_body_for_remote_model` after the test instance is built. It ensures the subsequent thread-settings update selects a model that the runtime has already learned from the mocked remote models endpoint.

*Call graph*: called by 1 (response_body_for_remote_model); 6 external calls (from_millis, from_secs, now, list_models, panic!, sleep).


##### `response_body_for_remote_model`  (lines 84–142)

```
async fn response_body_for_remote_model(
    remote_model: ModelInfo,
    configure: impl FnOnce(&mut Config) + Send + 'static,
) -> Result<Value>
```

**Purpose**: Builds a test Codex instance against a mocked remote models endpoint, selects a supplied remote model via thread settings, runs one turn, and returns the captured Responses API request body. It is the shared harness for asserting how remote model selectors affect outbound tool configuration.

**Data flow**: Accepts a `ModelInfo` and a configuration closure. It starts a mock server, captures the model slug, mounts a one-shot models response containing that model, mounts a one-shot SSE assistant completion, builds `TestCodex` with dummy ChatGPT auth and the caller’s config mutations, obtains the shared models manager, waits for the target model to appear via `wait_for_model_available`, asserts the models endpoint was hit once, submits `ThreadSettingsOverrides { model: Some(model_slug), ..Default::default() }`, submits a simple text `Op::UserInput`, waits for `TurnComplete`, and returns `response_mock.single_request().body_json()` as `Result<Value>`.

**Call relations**: Both selector-override tests call this helper. It delegates model-availability synchronization to `wait_for_model_available` and packages all the setup needed to inspect the final request body under a chosen remote model.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_once, sse, start_mock_server, test_codex, wait_for_model_available, create_dummy_chatgpt_auth_for_testing); called by 2 (remote_multi_agent_selector_overrides_feature_flags, remote_tool_mode_selector_overrides_feature_flags); 5 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, vec!).


##### `remote_tool_mode_selector_overrides_feature_flags`  (lines 145–184)

```
async fn remote_tool_mode_selector_overrides_feature_flags() -> Result<()>
```

**Purpose**: Verifies that a remote model’s `tool_mode` selector wins over local feature flags when determining the outbound tool list. It checks both the `Direct` and `CodeModeOnly` cases.

**Data flow**: This async test skips without network, creates a remote model with slug `test-tool-mode-direct` and `tool_mode = Some(ToolMode::Direct)`, runs `response_body_for_remote_model` with local `Feature::CodeModeOnly` enabled, extracts tool names, and asserts code-mode public/wait tools are absent. It then creates another remote model with `tool_mode = Some(ToolMode::CodeModeOnly)` and image input modality, runs the shared helper with no extra config, extracts tool names, and asserts the exact ordered list is `[PUBLIC_TOOL_NAME, WAIT_TOOL_NAME, "request_user_input", "web_search", "image_generation"]`.

**Call relations**: This top-level test uses `remote_model` to build fixtures, `response_body_for_remote_model` to execute a turn under each remote model, and `tool_names` to inspect the resulting request body. It demonstrates remote selector precedence over local feature toggles.

*Call graph*: calls 3 internal fn (remote_model, response_body_for_remote_model, tool_names); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `remote_multi_agent_selector_overrides_feature_flags`  (lines 187–222)

```
async fn remote_multi_agent_selector_overrides_feature_flags() -> Result<()>
```

**Purpose**: Verifies that a remote model’s `multi_agent_version` selector overrides local multi-agent feature flags when constructing the tool list. It checks both enabling V2 and explicitly disabling multi-agent tools.

**Data flow**: The test skips without network, creates a remote model with `multi_agent_version = Some(MultiAgentVersion::V2)`, runs `response_body_for_remote_model` with `agent_max_threads = Some(3)`, `Feature::Collab` enabled, and `Feature::MultiAgentV2` disabled, then asserts the resulting tool names contain `send_message`. It then creates another remote model with `multi_agent_version = Some(MultiAgentVersion::Disabled)`, runs the shared helper with local `Feature::MultiAgentV2` enabled, extracts tool names, and asserts none of `multi_agent_v1`, `spawn_agent`, `send_message`, `wait_agent`, or `list_agents` are present.

**Call relations**: This test parallels the tool-mode selector test but for multi-agent behavior. It relies on `remote_model`, `response_body_for_remote_model`, and `tool_names` to prove remote metadata can both enable and suppress multi-agent tooling regardless of local flags.

*Call graph*: calls 3 internal fn (remote_model, response_body_for_remote_model, tool_names); 2 external calls (assert!, skip_if_no_network!).


##### `remote_multi_agent_selector_uses_model_selected_before_first_turn`  (lines 225–307)

```
async fn remote_multi_agent_selector_uses_model_selected_before_first_turn() -> Result<()>
```

**Purpose**: Verifies that if thread settings select a different model before the first turn, Codex defers multi-agent-version resolution until that turn and then uses the selected model’s remote selector. It guards against incorrectly locking in the startup model’s selector state.

**Data flow**: This async test skips without network, starts a mock server directly, creates two remote models: `ROOT_MODEL` with `multi_agent_version = V1` and `CHILD_MODEL` with `multi_agent_version = V2`, mounts them in one models response, mounts a trivial SSE completion, builds `TestCodex` with dummy auth and initial `config.model = Some(ROOT_MODEL)`, and asserts after startup that the models endpoint was hit once and `test.codex.multi_agent_version()` is `None`. It then submits thread settings selecting `CHILD_MODEL` and asserts the runtime multi-agent version is still `None` before any turn. After submitting a text turn and waiting for `TurnComplete`, it asserts the models endpoint was still hit only once, `test.codex.multi_agent_version()` is now `Some(MultiAgentVersion::V2)`, and the captured request body’s tool list contains `send_message`.

**Call relations**: This test does not use `response_body_for_remote_model` because it needs finer-grained assertions before and after the first turn. It still uses `remote_model` for fixture creation and follows the same overall pattern of selecting a remote model via thread settings, then inspecting the resulting runtime selector state and outbound tool list.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_once, sse, test_codex, remote_model, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!, start).


### `core/tests/suite/auto_review.rs`

`test` · `model catalog refresh and strict auto-review request handling during integration tests`

This small file contains one end-to-end test plus a helper that fabricates a `ModelInfo` entry with an auto-review override. The test mounts a models endpoint returning a synthetic remote parent model whose `auto_review_model_override` points at a separate reviewer model slug. It then mounts a sequence of SSE responses that drive a realistic strict-auto-review flow: the parent model first calls `request_permissions`, then emits an `apply_patch` tool call, then the reviewer/Guardian model returns a JSON assistant message authorizing the action, and finally the parent model completes.

The harness is built with dummy ChatGPT auth, `ExecPermissionApprovals`, and `RequestPermissionsTool` enabled. After forcing the models manager to refresh online metadata, the test confirms the override is visible in `model_info`, switches the thread’s active model to the synthetic remote model, and submits a read-only turn that triggers `request_permissions`. It responds with `strict_auto_review: true`, waits for completion, and then searches the captured requests for the reviewer request by matching both the patch filename and the reviewer-specific instructions prefix (`You are judging one planned coding-agent action.`). The key assertion is that this review request’s `model` field equals the override reviewer slug, proving the catalog override controls strict auto-review model selection.

#### Function details

##### `remote_model_override_uses_catalog_model_for_strict_auto_review`  (lines 44–215)

```
async fn remote_model_override_uses_catalog_model_for_strict_auto_review() -> Result<()>
```

**Purpose**: Verifies that strict auto-review uses the reviewer model specified by a remote catalog entry’s `auto_review_model_override`. It drives a full permissions-request plus patch-review flow and inspects the resulting Guardian request.

**Data flow**: Starts a mock server, mounts a models response containing one synthetic model built by `remote_model_with_auto_review_override`, mounts an SSE sequence for parent `request_permissions`, parent `apply_patch`, reviewer approval message, and parent completion, then builds a harness with dummy ChatGPT auth and the necessary features enabled. It refreshes the models manager online, fetches the model info for the synthetic parent model, and asserts the override reviewer slug is present. It updates thread settings to use the synthetic parent model, computes read-only turn permission fields, submits a user turn with `AskForApproval::OnRequest`, waits for `EventMsg::RequestPermissions`, responds with `RequestPermissionsResponse { scope: Turn, strict_auto_review: true, ... }`, waits for turn completion, then scans captured requests for the reviewer request matching the patch filename and reviewer instructions. Finally it asserts that request body’s `model` equals the reviewer slug.

**Call relations**: This is the file’s main integration test. It depends on the helper-generated `ModelInfo` and on the mocked SSE sequence to force Codex through the strict auto-review path before inspecting the outbound reviewer request.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_sequence, local_selections, test_codex, turn_permission_fields, create_dummy_chatgpt_auth_for_testing, read_only); 10 external calls (default, start, assert_eq!, submit_thread_settings, wait_for_event, json!, panic!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_model_with_auto_review_override`  (lines 217–261)

```
fn remote_model_with_auto_review_override(slug: &str, review_model: &str) -> ModelInfo
```

**Purpose**: Constructs a synthetic `ModelInfo` record representing a remotely listed coding model that delegates strict auto-review to another model slug. The rest of the fields are filled with plausible defaults needed by the models manager and request builder.

**Data flow**: Accepts a parent model slug and reviewer model slug, then returns a fully populated `ModelInfo` with display metadata, medium reasoning defaults, `ConfigShellToolType::ShellCommand`, list visibility, responses-compatible capabilities, `auto_review_model_override: Some(review_model.to_string())`, `apply_patch_tool_type: Some(ApplyPatchToolType::Freeform)`, a byte-based truncation policy, a 272k context window, and other default/empty capability fields.

**Call relations**: The strict auto-review test uses this helper to populate the mocked models endpoint with a catalog entry whose override behavior can then be observed through the models manager and outbound review request.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); 4 external calls (default, new, format!, vec!).


### Model switching behavior
This suite exercises how request history and outbound fields are rewritten when the active model or service tier changes during execution.

### `core/tests/suite/model_switching.rs`

`test` · `request handling and history replay during multi-turn sessions`

This test module builds realistic multi-turn sessions against a mock Responses API and, when needed, a mock /models catalog. Its helpers construct the exact `Op::UserInput` payloads used in read-only local turns, derive sandbox and permission settings from `PermissionProfile::read_only()`, and synthesize `ModelInfo` records with controllable modalities, service tiers, and context-window metadata. The tests then inspect captured HTTP requests rather than only emitted events, which makes the assertions about model-visible history very concrete.

Several scenarios verify model-switch behavior. When the model changes between turns, the next request must include a developer `<model_switch>` note; if personality changes in the same turn, the model-switch note wins and no separate `<personality_spec>` update is emitted. Image-capability transitions are tested in both directions: prior user-uploaded images are stripped and replaced with a placeholder text when switching to a text-only model, while generated-image history is replayed as `image_generation_call` items for image-capable models and preserved in redacted form for text-only models. Rollback tests ensure that generated-image artifacts, developer save-path notes, and image-generation calls disappear together with the rolled-back turn. Service-tier tests verify omission rules for unsupported tiers, explicit default overrides, and null overrides. The final test confirms that switching to a smaller model updates both `TurnStarted` and `TokenCount` context-window values using the model catalog’s `effective_context_window_percent`.

#### Function details

##### `read_only_user_turn`  (lines 44–68)

```
fn read_only_user_turn(test: &TestCodex, items: Vec<UserInput>, model: String) -> Op
```

**Purpose**: Builds a fully populated `Op::UserInput` for a local read-only turn using the test session’s cwd and a caller-specified model slug. It standardizes the thread overrides used across model-switch tests so each turn carries explicit environment, approval, sandbox, permission, and collaboration settings.

**Data flow**: Inputs are `&TestCodex`, a vector of `UserInput` items, and the model string to embed in collaboration settings. It reads the test cwd via `cwd_path()` and `test.config.cwd`, derives `(sandbox_policy, permission_profile)` from `turn_permission_fields(PermissionProfile::read_only(), ...)`, computes local environment selections, and returns an `Op::UserInput` with `final_output_json_schema`/metadata unset and `additional_context` defaulted.

**Call relations**: This helper is invoked by the model-switch, image-history, generated-image, rollback, and context-window tests whenever they need a concrete user turn. It does not delegate further business logic beyond assembling the protocol struct, but its explicit overrides are what make later request-body assertions deterministic.

*Call graph*: calls 4 internal fn (cwd_path, local_selections, turn_permission_fields, read_only); called by 7 (generated_image_is_replayed_for_image_capable_models, model_and_personality_change_only_appends_model_instructions, model_change_appends_model_instructions_developer_message, model_change_from_generated_image_to_text_preserves_prior_generated_image_call, model_change_from_image_to_text_strips_prior_image_content, model_switch_to_smaller_model_updates_token_context_window, thread_rollback_after_generated_image_drops_entire_image_turn_history); 1 external calls (default).


##### `image_generation_artifact_path`  (lines 70–92)

```
fn image_generation_artifact_path(codex_home: &Path, session_id: &str, call_id: &str) -> PathBuf
```

**Purpose**: Reconstructs the on-disk PNG path where a generated image artifact should be saved for a given session and image-generation call. It mirrors the production naming convention closely enough for tests to remove stale files and verify saved-path notes.

**Data flow**: Inputs are the Codex home directory, a session id string, and a call id string. It sanitizes both identifiers by replacing non-ASCII-alphanumeric/non-`-`/`_` characters with `_`, substitutes `generated_image` if sanitization yields an empty string, then joins `generated_images/<sanitized session>/<sanitized call>.png` and returns that `PathBuf`.

**Call relations**: Generated-image replay and rollback tests call this helper before and after turns to clean up artifacts and to know the exact path that should appear in model-visible history. It is purely local path construction and delegates only to path joining and formatting.

*Call graph*: called by 3 (generated_image_is_replayed_for_image_capable_models, model_change_from_generated_image_to_text_preserves_prior_generated_image_call, thread_rollback_after_generated_image_drops_entire_image_turn_history); 2 external calls (join, format!).


##### `test_model_info`  (lines 94–143)

```
fn test_model_info(
    slug: &str,
    display_name: &str,
    description: &str,
    input_modalities: Vec<InputModality>,
) -> ModelInfo
```

**Purpose**: Creates a baseline `ModelInfo` fixture with predictable defaults and caller-controlled slug, display name, description, and input modalities. Tests mutate the returned struct to add service tiers or alternate context windows without repeating the full catalog schema.

**Data flow**: Inputs are four strings/vectors describing the model identity and supported modalities. It returns a `ModelInfo` populated with medium reasoning defaults, list visibility, shell-command tool type, no search support, byte-based truncation policy, a 272k context window, 95% effective window percentage, empty tier/tool collections, and the provided modality list.

**Call relations**: Service-tier tests and image-capability tests use this fixture as the starting point for mock `ModelsResponse` catalogs. It centralizes catalog defaults so individual tests only override the fields relevant to the scenario.

*Call graph*: calls 1 internal fn (bytes); called by 8 (default_service_tier_override_is_omitted_from_http_turn, flex_service_tier_is_applied_to_http_turn, generated_image_is_replayed_for_image_capable_models, model_change_from_generated_image_to_text_preserves_prior_generated_image_call, model_change_from_image_to_text_strips_prior_image_content, null_service_tier_override_is_omitted_from_http_turn_with_catalog_default, thread_rollback_after_generated_image_drops_entire_image_turn_history, unsupported_service_tier_is_omitted_from_http_turn); 3 external calls (default, new, vec!).


##### `model_change_appends_model_instructions_developer_message`  (lines 146–208)

```
async fn model_change_appends_model_instructions_developer_message() -> Result<()>
```

**Purpose**: Verifies that changing the thread model between two turns causes the second `/responses` request to include a developer-visible `<model_switch>` message. The assertion checks for both the tag and the explanatory preamble text.

**Data flow**: The test starts a mock server, mounts two completed SSE responses, builds a session configured for `gpt-5.3-codex`, submits one read-only turn, applies a thread-settings model override to `gpt-5.4`, submits a second turn, then inspects the captured requests. It asserts there are exactly two requests and that the second request’s developer texts contain the expected model-switch note.

**Call relations**: It is a top-level async test. It drives `read_only_user_turn` for both turns, waits for `EventMsg::TurnComplete` after each submission, and uses `submit_thread_settings` to create the pre-turn model change that should alter the next request body.

*Call graph*: calls 3 internal fn (mount_sse_sequence, test_codex, read_only_user_turn); 8 external calls (default, start, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `model_and_personality_change_only_appends_model_instructions`  (lines 211–285)

```
async fn model_and_personality_change_only_appends_model_instructions() -> Result<()>
```

**Purpose**: Checks precedence when both model and personality change before the next turn: the request should include the model-switch developer message but omit a separate personality update message. This captures a subtle layout rule for model-visible developer context.

**Data flow**: The test enables the `Feature::Personality` flag, starts with `gpt-5.3-codex`, submits an initial turn, then updates thread settings with both `model = exp-codex-personality` and `personality = Pragmatic`. After the second turn completes, it inspects the second request’s developer texts and asserts presence of `<model_switch>` and absence of `<personality_spec>`.

**Call relations**: As with the previous test, it uses `read_only_user_turn` for deterministic turn payloads and `submit_thread_settings` to stage the override. Its role is to validate the interaction between two independent update mechanisms in the request-layout pipeline.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only_user_turn); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `service_tier_change_is_applied_on_next_http_turn`  (lines 288–315)

```
async fn service_tier_change_is_applied_on_next_http_turn() -> Result<()>
```

**Purpose**: Confirms that a per-turn service-tier override is serialized into the immediate next HTTP request and that omitting the override on a later turn removes the field entirely. It specifically checks the `priority` request value used for `ServiceTier::Fast`.

**Data flow**: The test mounts two SSE completions, builds a default test session, submits one turn with `Some(ServiceTier::Fast.request_value())`, then a second turn with `None`. It parses both request bodies as JSON and asserts the first has `service_tier = "priority"` while the second has no `service_tier` key.

**Call relations**: This is a direct top-level test using `TestCodex::submit_turn_with_service_tier`; it does not use the read-only helper because the focus is the serialized top-level request field rather than thread settings or history rewriting.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `flex_service_tier_is_applied_to_http_turn`  (lines 318–353)

```
async fn flex_service_tier_is_applied_to_http_turn() -> Result<()>
```

**Purpose**: Verifies that a model catalog advertising the `flex` tier allows a turn-level `ServiceTier::Flex` override to pass through to the `/responses` body. It ensures tier support is validated against model metadata rather than hard-coded assumptions.

**Data flow**: The test creates a `ModelInfo` fixture, mutates its `service_tiers` to include an id matching `ServiceTier::Flex.request_value()`, injects that catalog into config, submits one turn with the flex override, and inspects the single captured request. The assertion expects `body["service_tier"] == "flex"`.

**Call relations**: It depends on `test_model_info` and `default_input_modalities` to synthesize the catalog entry. The test is invoked directly by the harness and delegates request capture to `mount_sse_once`.

*Call graph*: calls 6 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, test_model_info, default_input_modalities); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `unsupported_service_tier_is_omitted_from_http_turn`  (lines 356–386)

```
async fn unsupported_service_tier_is_omitted_from_http_turn() -> Result<()>
```

**Purpose**: Ensures that if the selected model advertises no service tiers, an attempted service-tier override is silently omitted from the outgoing request. This prevents invalid tier values from being sent upstream.

**Data flow**: The test builds a catalog containing a model with empty `service_tiers`, configures the session to use that model, submits a turn with a `Fast` override, and inspects the request JSON. It asserts that the `service_tier` field is absent.

**Call relations**: Like the flex-tier test, it uses `test_model_info` to define the catalog fixture and a single mocked SSE completion to let the turn finish. Its role is the negative counterpart to supported-tier serialization.

*Call graph*: calls 6 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, test_model_info, default_input_modalities); 2 external calls (assert_eq!, skip_if_no_network!).


##### `default_service_tier_override_is_omitted_from_http_turn`  (lines 389–425)

```
async fn default_service_tier_override_is_omitted_from_http_turn() -> Result<()>
```

**Purpose**: Checks that explicitly requesting the sentinel default tier value does not serialize a `service_tier` field when the model catalog already defines that default. The request should rely on server-side defaulting instead of redundantly restating it.

**Data flow**: The test creates a model fixture with `service_tiers = [fast]` and `default_service_tier = Some("priority")`, injects it into the catalog, submits a turn with `Some(SERVICE_TIER_DEFAULT_REQUEST_VALUE)`, and inspects the request body. It asserts the field is omitted.

**Call relations**: This test extends the shared `test_model_info` fixture with catalog-default metadata. It validates a special-case omission rule distinct from both unsupported-tier and explicit-tier behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, test_model_info, default_input_modalities); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `null_service_tier_override_is_omitted_from_http_turn_with_catalog_default`  (lines 428–464)

```
async fn null_service_tier_override_is_omitted_from_http_turn_with_catalog_default() -> Result<()>
```

**Purpose**: Verifies that leaving the service-tier override unset also omits the field even when the model catalog has a default tier. The client should not materialize the catalog default into the request body.

**Data flow**: The test constructs the same kind of catalog fixture as the previous case, but submits a turn with `None` for the service tier. It captures the request JSON and asserts there is no `service_tier` key.

**Call relations**: It complements the explicit-default-override test by covering the null/absent override path. The mocked catalog and request capture are otherwise identical.

*Call graph*: calls 6 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, test_model_info, default_input_modalities); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `model_change_from_image_to_text_strips_prior_image_content`  (lines 467–564)

```
async fn model_change_from_image_to_text_strips_prior_image_content() -> Result<()>
```

**Purpose**: Tests history rewriting when a conversation moves from an image-capable model to a text-only model after the user previously uploaded an image. The second request must remove image inputs and replace them with a textual omission marker.

**Data flow**: The test mounts a two-model catalog, forces an online model-list refresh, submits a first turn containing `UserInput::Image` plus text under the image-capable model, then submits a second text-only turn under the text-only model. It inspects both captured requests, asserting the first contains user image URLs, while the second contains none and includes the exact placeholder text `image content omitted because you do not support image input` among user texts.

**Call relations**: It uses `test_model_info` to define modality differences, `read_only_user_turn` to submit both turns, and the models manager refresh to ensure the runtime knows each model’s capabilities before rewriting history.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_sequence, test_codex, read_only_user_turn, test_model_info, create_dummy_chatgpt_auth_for_testing, default_input_modalities); 6 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `generated_image_is_replayed_for_image_capable_models`  (lines 567–670)

```
async fn generated_image_is_replayed_for_image_capable_models() -> Result<()>
```

**Purpose**: Verifies that a prior generated image is replayed into later requests as an `image_generation_call` item when the current model still supports image input. It also checks that the developer-visible history includes the note about where generated images were saved on disk.

**Data flow**: The test mounts an image-capable catalog and an SSE sequence where the first response emits `ev_image_generation_call("ig_123", ..., "Zm9v")`. It computes and clears the expected artifact path, refreshes models, submits a generation turn and then a follow-up descriptive turn, and inspects the second request. Assertions require exactly one `image_generation_call`, preservation of the original id and base64 result payload, and a developer text mentioning `Generated images are saved to`.

**Call relations**: It relies on `image_generation_artifact_path` for cleanup and expected-path reconstruction, `read_only_user_turn` for both turns, and the mock SSE event stream to seed generated-image history into the session.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, image_generation_artifact_path, read_only_user_turn, test_model_info, create_dummy_chatgpt_auth_for_testing, default_input_modalities); 7 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, remove_file, vec!).


##### `model_change_from_generated_image_to_text_preserves_prior_generated_image_call`  (lines 673–794)

```
async fn model_change_from_generated_image_to_text_preserves_prior_generated_image_call() -> Result<()>
```

**Purpose**: Checks the text-only downgrade path for generated-image history: the prior `image_generation_call` should remain in history, but its binary result must be stripped rather than rewritten into user image inputs. The saved-path developer note must still remain visible.

**Data flow**: The setup mirrors the previous test but includes both an image-capable and a text-only model. After a generation turn under the image model and a follow-up turn under the text-only model, the second request is inspected. The test asserts there are no user image URLs, exactly one `image_generation_call` with the original id, an empty `result` string, no injected image-omitted placeholder text in user messages, and a developer note about the saved path.

**Call relations**: This test combines the generated-image replay path with model-switch capability filtering. It uses the same artifact-path helper and model refresh flow as the image-capable replay test.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, image_generation_artifact_path, read_only_user_turn, test_model_info, create_dummy_chatgpt_auth_for_testing, default_input_modalities); 7 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, remove_file, vec!).


##### `thread_rollback_after_generated_image_drops_entire_image_turn_history`  (lines 797–905)

```
async fn thread_rollback_after_generated_image_drops_entire_image_turn_history() -> Result<()>
```

**Purpose**: Ensures that rolling back the turn that created a generated image removes every trace of that turn from subsequent model-visible history. The cleanup includes the original user prompt, the developer save-path note, and the `image_generation_call` item.

**Data flow**: The test mounts an image-capable catalog and a first response that emits `ig_rollback`, computes the artifact path, refreshes models, submits the generation turn, then submits `Op::ThreadRollback { num_turns: 1 }` and waits for `EventMsg::ThreadRolledBack`. After a new post-rollback turn, it inspects the second request and asserts absence of the original prompt text, absence of any developer save-path note, and an empty list of `image_generation_call` inputs.

**Call relations**: It is the rollback counterpart to the generated-image replay tests. The test drives both normal turn completion and rollback event handling before validating that the next request is rebuilt from the truncated thread history.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, image_generation_artifact_path, read_only_user_turn, test_model_info, create_dummy_chatgpt_auth_for_testing, default_input_modalities); 7 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, remove_file, vec!).


##### `model_switch_to_smaller_model_updates_token_context_window`  (lines 908–1114)

```
async fn model_switch_to_smaller_model_updates_token_context_window() -> Result<()>
```

**Purpose**: Validates that switching to a model with a smaller catalog context window updates the effective context-window value surfaced in runtime events. Both `TurnStarted` and later `TokenCount` telemetry must reflect the smaller model’s effective window, not the previous model’s.

**Data flow**: The test constructs two `ModelInfo` entries differing only in slug, description, and `context_window`, mounts them in `/models`, and computes effective windows using `effective_context_window_percent`. After refreshing models and asserting catalog visibility, it submits a first turn under the large model, waits for a `TokenCount` event with total tokens 100, and checks `model_context_window == large_effective_window`. It then applies a thread-settings model override, submits a second turn, waits for `TurnStarted` and `TokenCount` events tied to the second response, and asserts both report `smaller_effective_window` and not the old value.

**Call relations**: This top-level test uses `read_only_user_turn` for both turns and `submit_thread_settings` to stage the model switch. It also directly queries the models manager before the turns to prove the runtime has loaded the remote catalog metadata that should drive the event fields.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, start_mock_server, test_codex, read_only_user_turn, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 10 external calls (default, new, assert!, assert_eq!, assert_ne!, submit_thread_settings, wait_for_event, skip_if_no_network!, unreachable!, vec!).
