# Model request shaping, prompt assembly, and runtime model-selection suites  `stage-23.2.4.3`

This stage checks the “package” Codex sends to the AI model before each turn, and the model choices that shape that package. It is behind-the-scenes support for the main conversation loop: like packing a briefing folder, it must include the right notes, tools, limits, and rules without confusing them with the user’s own words. Tests cover added context from browsers or automation, saved project guidance from AGENTS.md, nested AGENTS.md rules, collaboration instructions, repository skills, prompt-debug basics, and snapshots of the model-visible layout. Other tests make sure permission messages, assistant personality, token-budget guidance, and cache-friendly prompt ordering appear once, change when settings change, and survive resumed or forked sessions. Request-shaping tests check strict JSON replies and web-search tool fields. The model-selection side verifies remote model catalogs, runtime selectors, automatic review models, and mid-conversation model switching, including service tier, image support, token limits, and special switch instructions. Together, these suites guard the boundary between Codex and the model so the model receives clear, current instructions tailored to the selected model.

## Files in this stage

### Context and instruction injection
These tests cover how supplemental instructions and repository-derived context are discovered, merged, and injected into model-visible prompts across turns and thread lifecycles.

### `core/tests/suite/additional_context.rs`

`test` · `test run`

This test file protects a subtle but important boundary: the difference between a user’s own message and background context supplied by the application. For example, if a browser tab says “tab one,” the model should be allowed to see that fact, but the conversation history should not pretend the user typed it. The tests set up a fake model server, send user input through a test Codex instance, and then inspect the exact request that would have gone to the model.

The file checks several rules. Untrusted context is wrapped in tags such as external_browser_info and sent as user-role input, while application-trusted context is wrapped without the external prefix and sent as developer-role input. This is like putting sticky notes in different trays: some notes are “outside observations,” while others are “instructions or facts from the app.”

The tests also verify history behavior across turns. Repeated context is not duplicated unnecessarily, removed context can later be reintroduced, and the real user message remains a normal user message even if it looks like one of the special context tags. Finally, very long context values are shortened before they reach the model, keeping requests bounded while preserving the beginning, end, and a clear truncation marker.

#### Function details

##### `additional_context_is_model_visible_but_not_a_user_message_item`  (lines 24–115)

```
async fn additional_context_is_model_visible_but_not_a_user_message_item() -> Result<()>
```

**Purpose**: This test checks that additional context is sent to the model, but is not recorded as part of the user’s actual message item. It also verifies that untrusted context and application context are placed in different message roles.

**Data flow**: The test starts a mock server, builds a Codex test instance, and submits one user message plus two context entries: browser information marked untrusted and automation information marked application-provided. It waits for the user-message event and confirms that the completed user item contains only the text the user typed. Then it inspects the outgoing model request and confirms that automation context appears as developer text, browser context appears as user-role external text, and the real user input appears after it.

**Call relations**: During the test, helper functions create the fake server response stream and the test Codex instance. The submitted operation drives Codex to emit events, which the test reads with wait_for_event_match. After the turn completes, the captured mock-server request is handed to snapshot and assertion helpers so the test can prove that the model input was built in the expected shape.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (from, default, assert_eq!, wait_for_event_match, assert_snapshot!, skip_if_no_network!, vec!).


##### `external_context_like_user_text_remains_a_user_message_item`  (lines 118–164)

```
async fn external_context_like_user_text_remains_a_user_message_item() -> Result<()>
```

**Purpose**: This test makes sure that ordinary user text is not misclassified just because it looks like a special external-context tag. A user who types something like “<external_api>” should still have that exact text treated as their message.

**Data flow**: The test creates a fake server and a Codex test instance, then submits one user text item with no additional context. It waits until Codex reports the completed user message and checks that the content is exactly the original text. It then inspects the captured model request and confirms the user-role input contains only that text.

**Call relations**: The mock server and response helpers provide a controlled model reply so the turn can finish. Codex receives the user input operation, emits an item-completed event, and later emits turn completion. The test uses those events and the captured request to confirm that tag-like user text stays in the normal user-message path rather than being treated as generated context.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (new, default, new, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `additional_context_trust_controls_message_role`  (lines 167–232)

```
async fn additional_context_trust_controls_message_role() -> Result<()>
```

**Purpose**: This test checks that the trust level on each additional context entry decides where it is placed in the model request. Application-provided context goes to the developer role, while untrusted outside context goes to the user role with an external marker.

**Data flow**: The test sends a user message with two context entries: browser information marked untrusted and automation information marked application-provided. After the turn completes, it reads the single request captured by the mock server. It filters developer-role texts to find the automation context, then checks that user-role texts contain the external browser context followed by the user’s real message.

**Call relations**: The setup helpers create the fake server, response stream, and Codex instance. The submitted user input makes Codex build a model request. Once wait_for_event_match sees the turn complete, the test inspects the request produced by that flow to verify that context trust is translated into the correct model-message role.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (from, default, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `additional_context_is_deduplicated_between_turns_while_retained`  (lines 235–312)

```
async fn additional_context_is_deduplicated_between_turns_while_retained() -> Result<()>
```

**Purpose**: This test checks that the same additional context is not inserted again and again across turns, while still remaining available in the conversation history. Repeating the same browser context on the second turn should not create a duplicate copy before the second message.

**Data flow**: The test prepares two mock model responses and submits two turns with the same untrusted browser context. After each turn completes, it inspects the captured request for that turn. The first request contains the external browser context and the first user message. The second request keeps that earlier context and first message, then adds only the second user message, without adding the same context a second time.

**Call relations**: The mock server captures one request per submitted turn. Codex receives the first operation, completes the turn, then receives the second operation and completes again. The test compares both captured requests to show that Codex retains previous context in history but avoids re-sending an identical context entry as a new item when nothing changed.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (from, default, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `additional_context_removes_one_value_while_adding_another`  (lines 315–474)

```
async fn additional_context_removes_one_value_while_adding_another() -> Result<()>
```

**Purpose**: This test checks how changing additional context over several turns affects what is added to the model request. It proves that newly added context is inserted, missing context is not repeated, and a context value can be inserted again later if it disappears and then returns.

**Data flow**: The test runs three turns against three captured mock requests. The first turn sends automation and browser context. The second turn sends automation again plus new terminal context, omitting browser context. The third turn sends automation, browser, and terminal context together. The assertions show that the first request includes automation and browser context, the second request adds only the new terminal context before the second message, and the third request re-adds browser context before the third message because it had been absent in the prior turn.

**Call relations**: Each submitted operation makes Codex build a new model request, and each mounted mock response lets that turn finish. The test waits for completion between turns so the conversation history advances in order. It then reads the three captured requests and checks the story Codex constructed across turns: what context was remembered, what was newly introduced, and what needed to be reintroduced.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (from, default, assert_eq!, wait_for_event_match, skip_if_no_network!, vec!).


##### `additional_context_values_are_truncated_before_model_input`  (lines 477–572)

```
async fn additional_context_values_are_truncated_before_model_input() -> Result<()>
```

**Purpose**: This test makes sure very large additional context values are shortened before being sent to the model. That keeps model requests from becoming too large while still preserving useful clues from the start and end of the context.

**Data flow**: The test builds two very long strings, one application context value and one untrusted browser context value, then submits them with a normal user message. After the turn completes, it inspects the captured request. It confirms that the application context appears in developer-role text and the browser context appears in user-role text, that both start with the expected beginning, contain a clear truncation notice, end with the expected tail, are shorter than the original full tagged text, and stay under the expected byte cap.

**Call relations**: The mock server lets Codex complete a turn without contacting a real model. Codex receives the oversized context entries and constructs the model request. The test then uses assertions on the captured request text to verify that the truncation step happened before the request left Codex, for both trusted application context and untrusted external context.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 9 external calls (from, default, assert!, assert_eq!, wait_for_event_match, format!, panic!, skip_if_no_network!, vec!).


### `core/tests/suite/agents_md.rs`

`test` · `test run`

Codex can read instruction files named AGENTS.md, plus a preferred AGENTS.override.md, from a user's home folder and from project folders. This test file checks the rules for that behavior. It makes temporary homes, fake project folders, mock remote environments, and a fake model server. Then it submits user turns and inspects the exact request that would have gone to the model.

The big idea is that instructions are like a briefing packet. Codex must choose the right pages, put them in the right order, and keep the same packet for a running conversation even if files change later. The tests cover many edge cases: override files winning over normal files, fallback filenames, parent-to-child project folder ordering, symbolic links, local plus remote environments, missing primary environments, invalid text, resuming old conversations, forking conversations, and spawning subagents.

A key behavior is snapshotting. When a thread starts, Codex records the instruction contents and source paths it selected. Later ordinary turns reuse that original rendering. Cold resume and fork tests show a more subtle split: the API may report newly configured sources, while the model history can replay the old instructions already saved in the conversation. Without these tests, Codex could silently send stale, duplicated, missing, or wrongly ordered guidance to the model.

#### Function details

##### `agents_instructions`  (lines 53–70)

```
async fn agents_instructions(mut builder: TestCodexBuilder) -> Result<String>
```

**Purpose**: Runs a small Codex conversation and returns the AGENTS.md instruction text that Codex sent to the mock model. It is a shared helper for tests that only care about the final rendered instruction message.

**Data flow**: It takes a test builder that already describes the desired setup. It starts a fake model server, builds Codex with a remote environment, submits the prompt "hello", then searches the captured model request for the user message that begins with the AGENTS.md instruction header. It returns that instruction text, or an error if none was sent.

**Call relations**: Several discovery tests call this helper after arranging files in the workspace. The helper hides the repeated server setup and request inspection so those tests can focus on whether the chosen instruction content is correct.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, build_with_remote_env); called by 3 (agents_docs_are_concatenated_from_project_root_to_cwd, agents_override_is_preferred_over_agents_md, configured_fallback_is_used_when_agents_candidate_is_directory); 1 external calls (vec!).


##### `write_global_file`  (lines 72–80)

```
fn write_global_file(
    home: &TempDir,
    filename: &str,
    contents: impl AsRef<[u8]>,
) -> Result<AbsolutePathBuf>
```

**Purpose**: Writes an instruction file into a temporary home directory and returns its absolute path. Tests use it to create global user instruction files such as AGENTS.md or AGENTS.override.md.

**Data flow**: It receives a temporary home folder, a filename, and bytes to write. It joins the filename onto the home path, writes the contents to disk, and returns the resulting absolute path for later comparison with Codex's reported instruction sources.

**Call relations**: Many tests use this before starting, resuming, forking, or spawning threads. The returned path becomes the expected source path when the test checks what Codex says it loaded.

*Call graph*: called by 7 (cold_resume_replays_rendered_instructions_but_reports_current_config_sources, fork_replays_rendered_instructions_from_shared_history, fresh_thread_composes_global_before_project_and_reports_sources, invalid_utf8_global_instructions_are_lossy, loads_user_instructions_without_a_primary_environment, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot, run_subagent_global_instruction_case); 2 external calls (path, write).


##### `instruction_fragments`  (lines 82–88)

```
fn instruction_fragments(request: &responses::ResponsesRequest) -> Vec<String>
```

**Purpose**: Pulls only the AGENTS.md instruction messages out of a captured model request. This helps tests ignore the rest of the conversation payload.

**Data flow**: It reads all user-text entries from a mock Responses API request, keeps only those that start with the AGENTS.md instruction header, and returns them as strings.

**Call relations**: Tests call this when they need to count or compare rendered instruction fragments. It is the filtering step used before assertions about duplication, ordering, or missing project text.

*Call graph*: calls 1 internal fn (message_input_texts); called by 2 (fresh_thread_composes_global_before_project_and_reports_sources, loads_user_instructions_without_a_primary_environment).


##### `expected_instruction_fragment`  (lines 90–93)

```
fn expected_instruction_fragment(cwd: &AbsolutePathBuf, contents: &str) -> String
```

**Purpose**: Builds the exact instruction message expected when instructions are tied to a project working directory. This avoids repeating the same formatting string in tests.

**Data flow**: It takes a working directory path and instruction contents. It formats them into the model-visible block with a heading that names the directory and wraps the contents in an INSTRUCTIONS tag.

**Call relations**: The fresh-thread snapshot test uses this to compare the model request against the exact structured prefix Codex should send.

*Call graph*: calls 1 internal fn (as_path); called by 1 (fresh_thread_composes_global_before_project_and_reports_sources); 1 external calls (format!).


##### `expected_provider_only_instruction_fragment`  (lines 95–97)

```
fn expected_provider_only_instruction_fragment(contents: &str) -> String
```

**Purpose**: Builds the exact instruction message expected when instructions come only from the user-instructions provider, without a project directory heading.

**Data flow**: It takes instruction text and wraps it in the standard AGENTS.md instruction header and INSTRUCTIONS tag. The result is the expected model-visible text.

**Call relations**: Resume, fork, invalid-text, and subagent tests use this when they expect only global instructions to appear in the request.

*Call graph*: called by 4 (cold_resume_replays_rendered_instructions_but_reports_current_config_sources, fork_replays_rendered_instructions_from_shared_history, invalid_utf8_global_instructions_are_lossy, run_subagent_global_instruction_case); 1 external calls (format!).


##### `assert_single_instruction_fragment`  (lines 99–101)

```
fn assert_single_instruction_fragment(request: &responses::ResponsesRequest, expected: &str)
```

**Purpose**: Checks that a model request contains exactly one AGENTS.md instruction message and that it matches the expected text. This catches both missing instructions and accidental duplicates.

**Data flow**: It receives a captured request and an expected string. It extracts instruction fragments from the request and compares the whole list with a one-item list containing the expected string.

**Call relations**: Many tests call this after a turn completes. It is the common final check that the model saw one clean instruction block.

*Call graph*: called by 6 (cold_resume_replays_rendered_instructions_but_reports_current_config_sources, fork_replays_rendered_instructions_from_shared_history, fresh_thread_composes_global_before_project_and_reports_sources, invalid_utf8_global_instructions_are_lossy, multi_environment_thread_loads_every_project_and_keeps_creation_snapshot, run_subagent_global_instruction_case); 1 external calls (assert_eq!).


##### `submit_thread_turn`  (lines 103–118)

```
async fn submit_thread_turn(thread: &Arc<codex_core::CodexThread>, prompt: &str) -> Result<()>
```

**Purpose**: Submits a text prompt to an existing Codex thread and waits until that turn is finished. It is a convenience helper for tests that work directly with threads.

**Data flow**: It receives a thread and prompt text. It wraps the prompt as a user input operation, sends it to the thread, waits for a TurnComplete event, and returns success or an error.

**Call relations**: The multi-environment test uses this after creating a custom thread. It bridges from test setup into the normal turn-processing flow and waits before assertions inspect the model request.

*Call graph*: called by 1 (multi_environment_thread_loads_every_project_and_keeps_creation_snapshot); 3 external calls (default, wait_for_event, vec!).


##### `request_body_contains`  (lines 120–137)

```
fn request_body_contains(request: &wiremock::Request, text: &str) -> bool
```

**Purpose**: Checks whether a raw mock-server request body contains a given piece of text. It understands both plain request bodies and bodies compressed with zstd, a compression format.

**Data flow**: It receives a wiremock request and a search string. It looks at the content-encoding header, decompresses the body if it is zstd-compressed, converts the bytes to text, and returns true if the text appears.

**Call relations**: This is used by subagent mock setup to route different fake model responses to the parent seed turn, spawn request, child request, and follow-up request.

*Call graph*: calls 1 internal fn (new); 1 external calls (decode_all).


##### `agents_override_is_preferred_over_agents_md`  (lines 140–171)

```
async fn agents_override_is_preferred_over_agents_md() -> Result<()>
```

**Purpose**: Tests that AGENTS.override.md wins when both it and AGENTS.md exist in the same workspace. This protects the override file's purpose: giving a stronger local instruction source.

**Data flow**: The test creates both files in the workspace, runs a Codex turn, and reads the instruction text sent to the model. It asserts that the override contents appear and the base AGENTS.md contents do not.

**Call relations**: It uses the shared agents_instructions helper to do the Codex run and request inspection. The test is skipped in a Wine execution environment because this path-handling case needs native cross-OS behavior.

*Call graph*: calls 2 internal fn (test_codex, agents_instructions); 2 external calls (assert!, skip_if_wine_exec!).


##### `configured_fallback_is_used_when_agents_candidate_is_directory`  (lines 174–210)

```
async fn configured_fallback_is_used_when_agents_candidate_is_directory() -> Result<()>
```

**Purpose**: Tests that Codex can fall back to another configured instruction filename when AGENTS.md exists but is a directory, not a readable file.

**Data flow**: The test configures WORKFLOW.md as a fallback name, creates AGENTS.md as a directory, writes WORKFLOW.md with instructions, runs a turn, and checks that the fallback text was sent to the model.

**Call relations**: It relies on agents_instructions for the actual turn. This checks the discovery path where the normal candidate is unusable, so Codex should continue searching instead of failing or ignoring all instructions.

*Call graph*: calls 2 internal fn (test_codex, agents_instructions); 2 external calls (assert!, skip_if_wine_exec!).


##### `agents_docs_are_concatenated_from_project_root_to_cwd`  (lines 213–274)

```
async fn agents_docs_are_concatenated_from_project_root_to_cwd() -> Result<()>
```

**Purpose**: Tests that project instruction files are combined from the repository root down to the current working directory. The broader instructions should come before the more specific ones.

**Data flow**: The test sets the current working directory to a nested folder, creates an AGENTS.md at the project root and another in the nested folder, then submits a turn. It checks that both texts appear and that the root text appears first.

**Call relations**: It uses agents_instructions to capture the rendered model instructions. The test verifies the ordering rule that makes nested instructions act like more specific additions rather than replacing the root guidance.

*Call graph*: calls 2 internal fn (test_codex, agents_instructions); 1 external calls (assert!).


##### `symlinked_cwd_uses_logical_parent_for_agents_discovery`  (lines 277–354)

```
async fn symlinked_cwd_uses_logical_parent_for_agents_discovery() -> Result<()>
```

**Purpose**: Tests how Codex discovers instructions when the configured working directory is a symbolic link, which is a folder path that points somewhere else. Codex should walk the logical path the user chose, not jump to the physical parent repository.

**Data flow**: The test builds a logical repository and a physical repository, with the workspace path in the logical repository symlinked into the physical one. It creates different AGENTS.md files in each parent and in the workspace, then checks both the reported source list and the actual model request. The expected result includes the logical parent and workspace docs, but not the physical parent doc.

**Call relations**: This test sets up its own mock server and Codex instance instead of using the small helper because it also checks instruction_sources directly. It protects a subtle path-walking rule that matters when users enter a symlinked workspace.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (assert!, assert_eq!, vec!).


##### `selected_environment_sources_match_model_visible_instructions`  (lines 357–401)

```
async fn selected_environment_sources_match_model_visible_instructions() -> Result<()>
```

**Purpose**: Tests that the instruction source paths reported by Codex match the instruction content actually visible to the model for a selected remote environment.

**Data flow**: The test writes a global AGENTS.md in the temporary home and a project AGENTS.md in the remote workspace. It starts Codex with that remote environment, checks that the source list contains the global path followed by the project path, submits a turn, and verifies the model saw global text followed by the project separator and project text.

**Call relations**: It directly uses mock-server setup and test_codex so it can compare both the API-facing source list and the model request. This ties the public reporting behavior to the hidden prompt construction behavior.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (new, new, assert!, assert_eq!, skip_if_wine_exec!, write, vec!).


##### `loads_user_instructions_without_a_primary_environment`  (lines 404–483)

```
async fn loads_user_instructions_without_a_primary_environment() -> Result<()>
```

**Purpose**: Tests that global user instructions still load when a thread is started without any primary execution environment. Project instructions should not be loaded because there is no project environment to read from.

**Data flow**: The test writes a global AGENTS.md, wraps the instruction provider so it can count loads, creates a normal test with a project file, and then starts a separate thread with an empty environment list. It verifies the provider was loaded again, the thread reports only the global source, and the model request contains global instructions but not project instructions.

**Call relations**: It uses write_global_file to create the home instruction file and instruction_fragments to inspect the mock request. This covers thread startup through the thread manager rather than the default test harness path.

*Call graph*: calls 9 internal fn (new, mount_sse_once, sse, start_mock_server, new, test_codex, instruction_fragments, write_global_file, try_from); 9 external calls (clone, new, default, new, new, assert!, assert_eq!, wait_for_event, vec!).


##### `fresh_thread_composes_global_before_project_and_reports_sources`  (lines 486–595)

```
async fn fresh_thread_composes_global_before_project_and_reports_sources() -> Result<()>
```

**Purpose**: Tests that a new thread combines global instructions before project instructions, reports those source paths, and keeps the original instruction snapshot across later ordinary turns.

**Data flow**: The test writes global and project instruction files, starts a thread, and confirms the source list. After the first turn, it rewrites both files with new contents and submits a second turn. It then checks that both model requests still contain the original global-plus-project text, in the original order, with the project separator, and that the second request starts with the same cached prefix as the first.

**Call relations**: It uses write_global_file for setup, expected_instruction_fragment to build the expected rendering, instruction_fragments and assert_single_instruction_fragment for request checks, and a mock response sequence for two turns. This is the main snapshotting test for ordinary thread continuation.

*Call graph*: calls 8 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_instruction_fragment, instruction_fragments, write_global_file, from_path); 8 external calls (clone, new, new, assert!, assert_eq!, format!, skip_if_wine_exec!, vec!).


##### `multi_environment_thread_loads_every_project_and_keeps_creation_snapshot`  (lines 598–717)

```
async fn multi_environment_thread_loads_every_project_and_keeps_creation_snapshot() -> Result<()>
```

**Purpose**: Tests that a thread with both remote and local environments loads instructions from each project, adds global instructions first, and keeps that creation-time snapshot even after override files are added later.

**Data flow**: The test creates global instructions, remote project instructions, and local project instructions. It starts a thread whose environment list includes both remote and local roots, verifies the source order, submits a turn, then writes new override files in all places and submits another turn. It checks that both requests still contain the original global, remote, and local instruction text, labeled by environment and root.

**Call relations**: It uses submit_thread_turn for the direct thread submissions and assert_single_instruction_fragment for exact request checks. It is skipped when network or remote test support is unavailable because it needs a real remote test environment.

*Call graph*: calls 10 internal fn (new, mount_sse_sequence, start_mock_server, new, test_codex, assert_single_instruction_fragment, submit_thread_turn, write_global_file, try_from, from_path); 12 external calls (clone, new, default, new, new, assert_eq!, get_remote_test_env, format!, skip_if_no_network!, skip_if_wine_exec! (+2 more)).


##### `invalid_utf8_global_instructions_are_lossy`  (lines 720–748)

```
async fn invalid_utf8_global_instructions_are_lossy() -> Result<()>
```

**Purpose**: Tests that a global instruction file containing invalid UTF-8 bytes is still read in a safe, lossy way. Invalid bytes should become the replacement character instead of crashing the thread.

**Data flow**: The test writes a global AGENTS.md with an invalid byte, starts Codex, submits a turn, and checks that the source path is reported. It then expects the model-visible instructions to contain the same text with the invalid byte replaced by U+FFFD, the standard replacement character.

**Call relations**: It uses write_global_file for the malformed file and expected_provider_only_instruction_fragment plus assert_single_instruction_fragment to verify the exact rendered request. This protects robustness around imperfect user files.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_single_instruction_fragment, expected_provider_only_instruction_fragment, write_global_file); 4 external calls (new, new, assert_eq!, vec!).


##### `cold_resume_replays_rendered_instructions_but_reports_current_config_sources`  (lines 753–835)

```
async fn cold_resume_replays_rendered_instructions_but_reports_current_config_sources() -> Result<()>
```

**Purpose**: Tests the current cold-resume behavior: when an old conversation is resumed from disk, the model history replays the old rendered instructions, but the reported instruction source list comes from the newly loaded configuration.

**Data flow**: The test creates an initial thread with old global instructions, submits a turn so the instructions are persisted, shuts the thread down, then adds a preferred override file with new instructions. It resumes the saved rollout, checks that the API reports the new override source, submits another turn, and verifies that the model request still replays the old instruction fragment from history.

**Call relations**: It uses write_global_file to create old and new global sources, and assert_single_instruction_fragment with expected_provider_only_instruction_fragment to compare requests. The test documents a known mismatch noted by the TODO comment.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_provider_only_instruction_fragment, write_global_file); 7 external calls (clone, new, new, assert_eq!, assert_ne!, wait_for_event, vec!).


##### `fork_replays_rendered_instructions_from_shared_history`  (lines 838–941)

```
async fn fork_replays_rendered_instructions_from_shared_history() -> Result<()>
```

**Purpose**: Tests that a forked thread replays the parent's saved instruction history, even if the new fork configuration would now select a different instruction source.

**Data flow**: The test starts a parent with old global instructions, submits a turn, flushes the rollout to disk, then creates a new override file. It builds a fresh fork configuration, forks the thread, confirms the fork reports the new source, submits a fork turn, and verifies the forked model request begins with the parent's original input prefix and old instruction fragment.

**Call relations**: It uses write_global_file for source changes, loads a fresh default config for the fork, and uses expected_provider_only_instruction_fragment plus assert_single_instruction_fragment for request checks. It is the fork counterpart to the cold-resume snapshot test.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, test_codex, assert_single_instruction_fragment, expected_provider_only_instruction_fragment, write_global_file); 9 external calls (clone, new, default, new, assert_eq!, assert_ne!, load_default_config_for_test, wait_for_event, vec!).


##### `forked_subagent_replays_one_creation_time_global_instruction_fragment`  (lines 944–947)

```
async fn forked_subagent_replays_one_creation_time_global_instruction_fragment() -> Result<()>
```

**Purpose**: Tests the subagent case where the child is spawned with the parent's context. The child should inherit the parent's creation-time global instructions exactly once.

**Data flow**: The test skips if network support is unavailable, then calls the shared subagent scenario with fork_context set to true. That shared scenario creates the parent, changes instruction files later, spawns the child, and checks the child's request.

**Call relations**: This is a thin wrapper around run_subagent_global_instruction_case. It selects the branch where the subagent receives parent history, so the shared helper also checks that the child's request starts with the parent's original structured input prefix.

*Call graph*: calls 1 internal fn (run_subagent_global_instruction_case); 1 external calls (skip_if_no_network!).


##### `fresh_subagent_uses_creation_time_instructions_without_parent_history`  (lines 950–953)

```
async fn fresh_subagent_uses_creation_time_instructions_without_parent_history() -> Result<()>
```

**Purpose**: Tests the subagent case where the child starts fresh instead of inheriting the parent's full conversation. It should still use the parent's creation-time instructions, but not copy the parent's earlier user prompts.

**Data flow**: The test skips if network support is unavailable, then calls the shared subagent scenario with fork_context set to false. The shared scenario verifies the child sees one instruction fragment and its own prompt, without the parent's seed prompt.

**Call relations**: This is a thin wrapper around run_subagent_global_instruction_case. It chooses the fresh-context branch so the helper checks for absence of inherited user history.

*Call graph*: calls 1 internal fn (run_subagent_global_instruction_case); 1 external calls (skip_if_no_network!).


##### `run_subagent_global_instruction_case`  (lines 955–1114)

```
async fn run_subagent_global_instruction_case(fork_context: bool) -> Result<()>
```

**Purpose**: Runs the full parent-and-subagent instruction snapshot scenario for both forked-context and fresh-context children. It proves that subagents use the parent's creation-time global instructions, not newer override files written before spawning.

**Data flow**: It receives a boolean saying whether the child should inherit parent context. It starts a mock server with separate matched responses for the seed turn, spawn request, child turn, and follow-up. It writes old global instructions, enables collaboration features, seeds parent history, then writes a new override file before asking the parent to spawn a child. After the child request appears, it checks that parent, spawn, and child requests each contain exactly one old instruction fragment, and that the parent and child report the original source. Depending on the boolean, it also checks either inherited structured history or absence of parent user history.

**Call relations**: The two subagent test functions call this helper with different settings. Inside, it uses request_body_contains to match the right mock responses, write_global_file to create old and new sources, and assert_single_instruction_fragment with expected_provider_only_instruction_fragment to verify the rendered instructions.

*Call graph*: calls 7 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, assert_single_instruction_fragment, expected_provider_only_instruction_fragment, write_global_file); called by 2 (forked_subagent_replays_one_creation_time_global_instruction_fragment, fresh_subagent_uses_creation_time_instructions_without_parent_history); 12 external calls (clone, new, from_millis, from_secs, new, assert_eq!, assert_ne!, json!, to_string, sleep (+2 more)).


### `core/tests/suite/collaboration_instructions.rs`

`test` · `test run`

Collaboration mode is extra guidance for how the assistant should work with the user, such as planning before acting. These tests make sure that guidance is added to the request sent to the model only when it should be. The file uses a mock server, which is like a fake model service that records what the program sends, so the tests can inspect the outgoing request without relying on a real model response.

Each test sets up a Codex test session, optionally changes thread settings, sends user input, waits until the turn is complete, and then reads the recorded request. The important part of the request is the list of developer messages. A developer message is higher-priority instruction text sent alongside the user’s message. The tests check whether collaboration instructions appear inside special XML-like open and close tags.

The cases cover the default state, explicit overrides, per-turn overrides, disabled configuration, repeated updates, mode changes, empty instruction text, and resuming an old session. Without these tests, the system could quietly send the wrong guidance to the model: no guidance when the user selected a mode, duplicate guidance after a no-op update, or old guidance after a mode change.

#### Function details

##### `collab_mode_with_mode_and_instructions`  (lines 22–34)

```
fn collab_mode_with_mode_and_instructions(
    mode: ModeKind,
    instructions: Option<&str>,
) -> CollaborationMode
```

**Purpose**: Builds a small collaboration-mode setting for tests. It lets a test choose both the mode, such as default or plan, and the optional instruction text that should be sent to the model.

**Data flow**: It receives a mode and optional instruction text. It creates a CollaborationMode value with a fixed test model name, no reasoning-effort override, and the instruction text copied into the settings if present. The returned value is then ready to be placed into thread settings.

**Call relations**: This is the lower-level helper. collab_mode_with_instructions uses it when the mode does not matter, while the mode-change tests call it directly so they can compare what happens when the mode changes or stays the same.

*Call graph*: called by 3 (collab_mode_with_instructions, collaboration_mode_update_emits_new_instruction_message_when_mode_changes, collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged).


##### `collab_mode_with_instructions`  (lines 36–38)

```
fn collab_mode_with_instructions(instructions: Option<&str>) -> CollaborationMode
```

**Purpose**: Creates a default-mode collaboration setting with optional developer instructions. Tests use it when they only care about the instruction text, not the exact collaboration mode.

**Data flow**: It receives optional text. It passes that text together with the default mode into collab_mode_with_mode_and_instructions, then returns the resulting CollaborationMode.

**Call relations**: Most tests call this helper before submitting thread setting overrides or per-turn settings. It keeps the setup short so each test can focus on the behavior being checked.

*Call graph*: calls 1 internal fn (collab_mode_with_mode_and_instructions); called by 8 (collaboration_instructions_added_on_user_turn, collaboration_instructions_omitted_when_disabled, collaboration_mode_update_emits_new_instruction_message, collaboration_mode_update_noop_does_not_append, override_then_next_turn_uses_updated_collaboration_instructions, resume_replays_collaboration_instructions, user_input_includes_collaboration_instructions_after_override, user_turn_overrides_collaboration_instructions_after_override).


##### `developer_texts`  (lines 40–51)

```
fn developer_texts(input: &[Value]) -> Vec<String>
```

**Purpose**: Pulls out the plain text from developer messages inside a recorded model request. This lets tests check exactly which high-priority instructions were sent.

**Data flow**: It receives a JSON array representing the request input. It keeps only items whose role is developer, looks inside their content arrays, extracts each text field, and returns those strings in a list.

**Call relations**: After a test sends user input and reads the mock server’s captured request, it calls developer_texts to reduce the raw JSON to the messages that matter for these assertions.

*Call graph*: called by 12 (collaboration_instructions_added_on_user_turn, collaboration_instructions_omitted_when_disabled, collaboration_mode_update_emits_new_instruction_message, collaboration_mode_update_emits_new_instruction_message_when_mode_changes, collaboration_mode_update_noop_does_not_append, collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged, empty_collaboration_instructions_are_ignored, no_collaboration_instructions_by_default, override_then_next_turn_uses_updated_collaboration_instructions, resume_replays_collaboration_instructions (+2 more)); 1 external calls (iter).


##### `collab_xml`  (lines 53–55)

```
fn collab_xml(text: &str) -> String
```

**Purpose**: Wraps collaboration instruction text in the same open and close tags the protocol uses. Tests use this to compare against the exact text expected in developer messages.

**Data flow**: It receives raw instruction text. It places that text between COLLABORATION_MODE_OPEN_TAG and COLLABORATION_MODE_CLOSE_TAG, then returns the combined string.

**Call relations**: The tests call this after extracting developer messages, so their assertions match the protocol’s tagged format rather than only the inner instruction text.

*Call graph*: called by 10 (collaboration_instructions_added_on_user_turn, collaboration_mode_update_emits_new_instruction_message, collaboration_mode_update_emits_new_instruction_message_when_mode_changes, collaboration_mode_update_noop_does_not_append, collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged, empty_collaboration_instructions_are_ignored, override_then_next_turn_uses_updated_collaboration_instructions, resume_replays_collaboration_instructions, user_input_includes_collaboration_instructions_after_override, user_turn_overrides_collaboration_instructions_after_override); 1 external calls (format!).


##### `count_messages_containing`  (lines 57–59)

```
fn count_messages_containing(texts: &[String], target: &str) -> usize
```

**Purpose**: Counts how many extracted developer messages contain a target piece of text. Tests use it to prove instructions are absent, present once, or not duplicated.

**Data flow**: It receives a list of message strings and a target string. It scans the list, counts every message that includes the target, and returns that number.

**Call relations**: This is the final checking helper used by the test assertions after developer_texts and, often, collab_xml have prepared the values to compare.


##### `no_collaboration_instructions_by_default`  (lines 62–102)

```
async fn no_collaboration_instructions_by_default() -> Result<()>
```

**Purpose**: Verifies that a normal session does not send collaboration-mode instructions unless the user or settings explicitly enable them. It also confirms that ordinary permissions instructions are still present.

**Data flow**: The test starts a mock server, builds a default Codex session, sends a simple user message, and waits for completion. It then reads the captured request, extracts developer messages, checks that permissions instructions exist, and checks that no collaboration tag appears.

**Call relations**: This is the baseline test. It uses the mock response helpers to complete a turn, then uses developer_texts and count_messages_containing to inspect what was actually sent.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, developer_texts); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `user_input_includes_collaboration_instructions_after_override`  (lines 105–148)

```
async fn user_input_includes_collaboration_instructions_after_override() -> Result<()>
```

**Purpose**: Checks that setting collaboration mode before a user turn causes the next model request to include those instructions. This proves thread-level overrides affect later user input.

**Data flow**: The test creates a collaboration mode with instruction text, submits it as a thread settings override, then sends a user message. After the turn completes, it extracts developer messages and confirms the tagged instruction appears exactly once.

**Call relations**: It calls collab_mode_with_instructions to build the override and collab_xml to form the expected tagged text. The mock server captures the outgoing request for the assertion.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_instructions_added_on_user_turn`  (lines 151–196)

```
async fn collaboration_instructions_added_on_user_turn() -> Result<()>
```

**Purpose**: Checks that collaboration instructions supplied directly on a user turn are included in that same turn’s request. This covers the case where settings travel with the user input itself.

**Data flow**: The test builds a collaboration mode and includes it inside the thread_settings field of the user input operation, along with other normal turn settings such as environment and sandbox choices. It sends the operation, waits for completion, then verifies the tagged collaboration instructions appear once in developer messages.

**Call relations**: It uses local_selections and configuration values to make a realistic per-turn settings bundle. The assertion path again goes through developer_texts, collab_xml, and count_messages_containing.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_instructions_omitted_when_disabled`  (lines 199–248)

```
async fn collaboration_instructions_omitted_when_disabled() -> Result<()>
```

**Purpose**: Verifies that the global configuration switch can prevent collaboration instructions from being sent at all. This protects users or environments that intentionally disable this feature.

**Data flow**: The test changes the test configuration so include_collaboration_mode_instructions is false. It still sends a user turn with collaboration instructions, then inspects the captured request and confirms no collaboration open tag appears in developer messages.

**Call relations**: It follows the same mock-server turn flow as the positive tests, but the expected result is absence. collab_mode_with_instructions builds the would-be instructions, and developer_texts exposes whether they were actually sent.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, collab_mode_with_instructions, developer_texts); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `override_then_next_turn_uses_updated_collaboration_instructions`  (lines 251–294)

```
async fn override_then_next_turn_uses_updated_collaboration_instructions() -> Result<()>
```

**Purpose**: Checks that a collaboration-mode override submitted before a turn is remembered and used on the next user message. It is similar to the basic override test, emphasizing that the update applies to later turns.

**Data flow**: The test submits thread settings containing collaboration instructions, then sends a separate user input operation with no collaboration settings of its own. It reads the resulting model request and confirms the override text appears once inside collaboration tags.

**Call relations**: It relies on submit_thread_settings to update the session state before the user turn. The later assertion uses developer_texts and collab_xml to confirm that state was carried into the request.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `user_turn_overrides_collaboration_instructions_after_override`  (lines 297–355)

```
async fn user_turn_overrides_collaboration_instructions_after_override() -> Result<()>
```

**Purpose**: Verifies that per-turn collaboration instructions take priority over earlier thread-level instructions. This prevents an old setting from winning when a user turn explicitly supplies a new one.

**Data flow**: The test first sets base collaboration instructions on the thread. It then sends a user message with different collaboration instructions in that turn’s settings. After completion, it checks that the base text is absent and the turn-specific text appears once.

**Call relations**: It uses collab_mode_with_instructions twice: once for the stored base setting and once for the per-turn override. The captured request shows which one the main system chose.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_mode_update_emits_new_instruction_message`  (lines 358–431)

```
async fn collaboration_mode_update_emits_new_instruction_message() -> Result<()>
```

**Purpose**: Checks that changing collaboration instruction text across turns appends a new instruction message. This makes sure the model sees both the old history and the new updated guidance when appropriate.

**Data flow**: The test mounts two mock responses for two turns. It sets first instructions and sends the first message, then updates the collaboration instructions and sends a second message. It inspects the second request and confirms both the first and second tagged instruction texts are present once.

**Call relations**: This test exercises update history across multiple turns. The second mock request is the important one because it shows how the system carries prior instructions and adds the changed one.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_mode_update_noop_does_not_append`  (lines 434–504)

```
async fn collaboration_mode_update_noop_does_not_append() -> Result<()>
```

**Purpose**: Verifies that submitting the same collaboration instructions again does not create a duplicate developer message. This keeps the conversation history from being cluttered with repeated identical guidance.

**Data flow**: The test sets collaboration instructions, sends one turn, submits the same instructions again, and sends a second turn. It then checks the second request and confirms the tagged text appears only once.

**Call relations**: It mirrors the previous update test but makes the second update a no-op, meaning it should change nothing. The final count confirms the system detected that nothing meaningful changed.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_mode_update_emits_new_instruction_message_when_mode_changes`  (lines 507–586)

```
async fn collaboration_mode_update_emits_new_instruction_message_when_mode_changes() -> Result<()>
```

**Purpose**: Checks that changing the collaboration mode itself, such as from default to plan, counts as a meaningful update. Even if the shape of the setting is similar, the model should receive the new mode’s instructions.

**Data flow**: The test sets default-mode instructions and completes one turn. It then changes to plan-mode instructions and completes another turn. In the second captured request, it verifies that both the default-mode tagged text and the plan-mode tagged text appear once.

**Call relations**: Unlike the simpler helper-based tests, this one calls collab_mode_with_mode_and_instructions directly so it can control ModeKind. The mock server’s second request proves whether the mode change produced a new instruction message.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_mode_and_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged`  (lines 589–665)

```
async fn collaboration_mode_update_noop_does_not_append_when_mode_is_unchanged() -> Result<()>
```

**Purpose**: Verifies that re-sending the same mode and the same instructions is treated as no change. This prevents duplicate messages when settings are refreshed but not actually modified.

**Data flow**: The test sets default-mode collaboration instructions, sends a turn, then submits the exact same default-mode instructions again and sends another turn. It inspects the second request and confirms the tagged text appears only once.

**Call relations**: It pairs with the mode-change test. Both use collab_mode_with_mode_and_instructions, but this one keeps ModeKind unchanged so the expected behavior is no new appended instruction.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_mode_and_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `resume_replays_collaboration_instructions`  (lines 668–739)

```
async fn resume_replays_collaboration_instructions() -> Result<()>
```

**Purpose**: Checks that collaboration instructions survive when a session is resumed from saved rollout data. A resumed conversation should not forget the guidance that shaped earlier turns.

**Data flow**: The test starts an initial session, records its rollout path and home directory, sets collaboration instructions, and completes a turn. It then resumes a new session from that saved data, sends another user message, and checks that the resumed request includes the tagged collaboration instructions once.

**Call relations**: This test uses the test builder’s resume path rather than only normal turn submission. It proves that saved conversation state feeds back into later model requests after restart-like behavior.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_mode_with_instructions, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `empty_collaboration_instructions_are_ignored`  (lines 742–791)

```
async fn empty_collaboration_instructions_are_ignored() -> Result<()>
```

**Purpose**: Verifies that an empty instruction string is not sent as a collaboration instruction message. Empty tags would add noise without giving the model useful guidance.

**Data flow**: The test submits a collaboration mode whose developer_instructions field is an empty string. It sends a user message, reads the captured request, and confirms that an empty tagged collaboration block does not appear in developer messages.

**Call relations**: This test builds the CollaborationMode directly because it needs the empty string case exactly. It still uses collab_xml to describe the forbidden empty tagged form and developer_texts to inspect the outgoing request.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, collab_xml, developer_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/hierarchical_agents.rs`

`test` · `test run`

AGENTS.md files are instruction files that tell Codex how to behave inside a project. This test file makes sure Codex builds the user-facing instruction message correctly when support for hierarchical, or nested, AGENTS.md files is enabled. In plain terms, it checks that Codex says: “Here are the project instructions, and also remember that more instruction files may exist deeper in the folder tree.”

The tests use a fake remote server instead of contacting a real model service. The fake server returns a short stream of events that looks like a normal model response, so the test can focus on what Codex sends out in the request. One test creates an AGENTS.md file containing “be nice” in the temporary workspace, submits a simple user message, then inspects the outgoing request. It verifies that the original project instruction text is present and that the hierarchical-AGENTS explanation is appended after it. The other test does not create any AGENTS.md file, and checks that Codex still emits the hierarchical guidance message.

This matters because instruction ordering affects model behavior. If the extra hierarchical guidance were missing, Codex might ignore important instructions in subfolders. If it appeared in the wrong place, it could make the assembled instructions harder to understand or override the intended project guidance.

#### Function details

##### `hierarchical_agents_appends_to_project_doc_in_user_instructions`  (lines 15–66)

```
async fn hierarchical_agents_appends_to_project_doc_in_user_instructions()
```

**Purpose**: This test proves that when a project AGENTS.md file exists, Codex includes its contents and then appends the extra hierarchical-AGENTS guidance after it. It protects the expected order of instruction text, which is important because later text can change how a model interprets earlier guidance.

**Data flow**: The test starts with a fake server and a temporary Codex workspace. It turns on the ChildAgentsMd feature, writes an AGENTS.md file containing “be nice,” submits the user message “hello,” and then reads the request Codex sent to the fake server. The output is not a returned value but a set of assertions: the outgoing user instruction message must contain “be nice,” must contain the hierarchical AGENTS.md snippet, and the snippet must appear after the base project instruction text.

**Call relations**: During the test, start_mock_server creates the pretend remote service, sse builds a small fake event stream, and mount_sse_once attaches that stream as the server response. test_codex builds a test Codex instance around that setup. The test then submits a turn and inspects the single captured request from the mock response, using assertions to confirm that the instruction assembly behaved correctly. It also calls skip_if_wine_exec before setup because this path-related test requires native operating-system path behavior.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 3 external calls (assert!, skip_if_wine_exec!, vec!).


##### `hierarchical_agents_emits_when_no_project_doc`  (lines 69–100)

```
async fn hierarchical_agents_emits_when_no_project_doc()
```

**Purpose**: This test proves that Codex still sends the hierarchical-AGENTS guidance even when there is no project AGENTS.md file. It ensures the feature is not dependent on a top-level instruction file already being present.

**Data flow**: The test starts with a fake server and a Codex test instance whose ChildAgentsMd feature is enabled. Unlike the first test, it does not write any AGENTS.md file into the workspace. After submitting “hello,” it reads the request sent to the fake server and checks that the generated user instruction message contains the standard hierarchical AGENTS.md snippet.

**Call relations**: The test uses start_mock_server, sse, and mount_sse_once to prepare a controlled fake model response, then uses test_codex to create the Codex instance under test. After the submitted turn causes Codex to send a request, the test examines that captured request and asserts that the hierarchical guidance was included even without any project instruction file.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 2 external calls (assert!, vec!).


### `core/tests/suite/skills.rs`

`test` · `test run`

This is a non-Windows integration test for the “skills” feature. A skill is a small instruction file stored in a repository, here under `.agents/skills/<name>/SKILL.md`, that can teach the assistant how to do a particular task. The test makes sure that if the user selects or mentions a skill, Codex includes that skill’s name, file path, and body text in the message it sends to the model. Without this, the user could ask for a skill and the assistant would have no actual instructions to follow.

The file first defines a helper that writes a fake skill into the test workspace. Then the main test starts a mock server, creates a Codex test instance with that skill in its workspace, and submits a user turn containing both plain text and a structured skill reference. The mock server returns a simple streamed response, like a pretend model saying “done.” After Codex finishes the turn, the test inspects the request that Codex sent to the mock server. It checks that the user input contains a `<skill>` block with the correct skill name, the skill path, and the skill body. In everyday terms, this test checks that the assistant does not just hear “use the cookbook”; it actually packs the cookbook into the message it sends onward.

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

**Purpose**: Creates a fake repository skill file for a test. It builds the expected `.agents/skills/<name>/SKILL.md` folder structure and writes a small markdown file with front matter and body text.

**Data flow**: It receives a workspace folder, a file-system object, a skill name, a description, and the skill body. It turns those into a skill directory path, creates that directory, formats the skill file contents, and writes `SKILL.md` there. The result is either success or an error if path conversion, directory creation, or file writing fails.

**Call relations**: The main test calls this during workspace setup so the test repository looks as if it already contains a real skill. Inside, it uses path joining to build the location, converts paths into URI form for the executor file system, and uses the provided file system to create the directory and write the file.

*Call graph*: calls 2 internal fn (join, from_path); 1 external calls (format!).


##### `user_turn_includes_skill_instructions`  (lines 50–135)

```
async fn user_turn_includes_skill_instructions() -> Result<()>
```

**Purpose**: Checks the full skill-inclusion behavior from the outside: when a user turn includes a skill, Codex sends the skill instructions to the model request. This protects the contract that selected skills become usable context, not just labels.

**Data flow**: It starts with a temporary Codex test setup and a mock model server. It writes a demo skill into the workspace, submits a user message that references that skill, waits until the turn is complete, then reads the single request received by the mock server. Finally, it searches the user-facing text in that request and asserts that it contains the skill name, the skill file path, and the skill body.

**Call relations**: This is the top-level test case. It calls the test harness to build a Codex instance, `start_mock_server` and `mount_sse_once` to provide a pretend streamed model response, `turn_permission_fields` and `local_selections` to shape the submitted turn settings, and the helper `write_repo_skill` indirectly through workspace setup. After Codex processes the submitted `Op::UserInput`, the test inspects the mock server’s captured request to verify the skill data was handed off correctly.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 6 external calls (default, assert!, wait_for_event, skip_if_no_network!, skip_if_wine_exec!, vec!).


### Prompt layout and request assembly
These files validate the exact structure of assembled model input, including visible layout, permissions and personality messaging, caching behavior, and token-budget annotations.

### `core/tests/suite/model_visible_layout.rs`

`test` · `test run`

This is a test file, not production code. Its job is to protect the shape of the messages sent to the model. In this project, each user turn is turned into a request that includes the user’s words plus surrounding context such as the current folder, approval policy, sandbox permissions, model choice, personality, and project instructions from AGENTS.md. If that request layout changes by accident, the model may receive stale, duplicated, missing, or misleading information.

The tests set up a fake Responses API server, run a small Codex session against it, then inspect the exact requests that Codex sent. They use snapshot testing, which is like taking a photograph of the expected request and comparing future runs against that photograph. Some tests simulate two turns in one session. Others create a session, save its history, resume it, and check how the first resumed request is written. There are also small snapshot checks for the environment context text when subagents are present.

A key detail is that the file intentionally documents current behavior, including a known limitation: changing the working directory does not refresh AGENTS.md instructions yet. That makes the limitation visible and prevents accidental changes from going unnoticed.

#### Function details

##### `context_snapshot_options`  (lines 33–36)

```
fn context_snapshot_options() -> ContextSnapshotOptions
```

**Purpose**: This helper builds the formatting settings used when turning model requests into readable snapshot text. It keeps the snapshots compact by showing each context item by kind and a short text prefix.

**Data flow**: It starts from the default snapshot options, changes the render mode to a shortened text style with a 96-character limit, and returns those options. It does not read or change any outside state.

**Call relations**: The two snapshot-formatting helpers call this before they print request or response items. In the larger test flow, it acts like a shared camera setting so all snapshots in this file are rendered consistently.

*Call graph*: calls 1 internal fn (default); called by 2 (format_environment_context_subagents_snapshot, format_labeled_requests_snapshot).


##### `format_labeled_requests_snapshot`  (lines 38–47)

```
fn format_labeled_requests_snapshot(
    scenario: &str,
    sections: &[(&str, &ResponsesRequest)],
) -> String
```

**Purpose**: This helper turns one or more captured model requests into a labeled snapshot string. The labels make it easy to compare, for example, a first request with a second request after settings changed.

**Data flow**: It receives a scenario description and a list of label-and-request pairs. It fetches the shared snapshot options, passes everything to the context snapshot formatter, and returns the finished human-readable text.

**Call relations**: The multi-turn and resume tests call this after the fake server has captured outgoing requests. It hands the formatted text to the snapshot assertion so the test can compare today’s request layout with the saved expected layout.

*Call graph*: calls 2 internal fn (format_labeled_requests_snapshot, context_snapshot_options).


##### `user_instructions_wrapper_count`  (lines 49–55)

```
fn user_instructions_wrapper_count(request: &ResponsesRequest) -> usize
```

**Purpose**: This helper counts how many user-visible text blocks in a request look like serialized AGENTS.md instruction wrappers. The tests use it to check that project instructions are not being inserted when current behavior says they should be absent.

**Data flow**: It takes one captured request, pulls out the text pieces sent as user messages, filters for text that starts with the AGENTS.md wrapper heading, and returns the count. It does not modify the request.

**Call relations**: The AGENTS.md working-directory-change test calls this on both captured requests. Its result supports explicit assertions before the broader snapshot comparison is made.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `format_environment_context_subagents_snapshot`  (lines 57–79)

```
fn format_environment_context_subagents_snapshot(subagents: &[&str]) -> String
```

**Purpose**: This helper builds a small model-visible environment context message that optionally includes subagents, then formats it as snapshot text. It lets the tests focus only on how the subagent section appears.

**Data flow**: It receives a list of subagent lines. If the list is empty it leaves out the subagent block; otherwise it indents the lines inside a subagents section. It wraps that text in a mock response item, formats it with the shared snapshot options, and returns the formatted string.

**Call relations**: The subagent snapshot tests use this helper to create the text they want to freeze in snapshots. It depends on the same snapshot option helper as the request snapshots, so the output style stays consistent.

*Call graph*: calls 2 internal fn (format_response_items_snapshot, context_snapshot_options); 3 external calls (new, format!, vec!).


##### `snapshot_model_visible_layout_turn_overrides`  (lines 82–201)

```
async fn snapshot_model_visible_layout_turn_overrides() -> Result<()>
```

**Purpose**: This test checks that per-turn overrides are reflected in what the model sees. It covers changes such as current folder, approval policy, sandbox permissions, and personality while keeping the model constant.

**Data flow**: It starts a fake server with two canned model responses, builds a test Codex session with a configured model and personality support, then submits two user turns with different thread settings. After each turn finishes, it reads the two requests captured by the fake server and snapshots them side by side.

**Call relations**: During the test, Codex sends requests to the mounted fake server sequence and receives completion events. After the turn-complete events arrive, this test hands the captured requests to the labeled snapshot formatter, which uses the shared formatting options before the snapshot assertion checks the result.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, read_only); 7 external calls (default, assert_eq!, wait_for_event, create_dir_all, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_model_visible_layout_cwd_change_does_not_refresh_agents`  (lines 206–334)

```
async fn snapshot_model_visible_layout_cwd_change_does_not_refresh_agents() -> Result<()>
```

**Purpose**: This test documents the current behavior when the working directory changes to a different folder with a different AGENTS.md file. Today, that change does not refresh the model-visible AGENTS.md instructions, and the test makes that explicit.

**Data flow**: It creates two temporary folders, writes different AGENTS.md files into them, and runs two user turns: one in the first folder and one in the second. It then reads the captured requests, checks that neither contains the serialized AGENTS.md instruction wrapper, and records a snapshot of both requests.

**Call relations**: The test uses the fake server sequence in the same way as the turn-override test. It also calls the AGENTS wrapper counter before formatting the labeled snapshot, so a clear assertion fails if those instructions begin appearing unexpectedly.

*Call graph*: calls 6 internal fn (mount_sse_sequence, start_mock_server, local_selections, test_codex, turn_permission_fields, read_only); 8 external calls (default, assert_eq!, wait_for_event, create_dir_all, write, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_model_visible_layout_resume_with_personality_change`  (lines 337–449)

```
async fn snapshot_model_visible_layout_resume_with_personality_change() -> Result<()>
```

**Purpose**: This test checks the first request after resuming a saved session when the resumed configuration changes the model and the turn changes personality. It protects the layout of resumed conversation history plus new context updates.

**Data flow**: It first creates an initial session with one model, sends a seed turn, and keeps the rollout path that records the session history. Then it builds a resumed session with a different configured model and personality support, sends a new turn with a changed working directory and personality, captures the resumed request, and snapshots it alongside the last pre-resume request.

**Call relations**: The initial half uses one fake server response to create saved history. The resumed half uses another fake response after calling the test builder’s resume path. Once Codex reports the resumed turn complete, the test sends both captured requests into the labeled snapshot formatter for comparison.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, read_only); 7 external calls (clone, default, wait_for_event, create_dir_all, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_model_visible_layout_resume_override_matches_rollout_model`  (lines 452–549)

```
async fn snapshot_model_visible_layout_resume_override_matches_rollout_model() -> Result<()>
```

**Purpose**: This test checks a resume case where the active configuration names a newer model, but a pre-turn override sets the model back to the one stored in the original rollout. It verifies that no unnecessary model-switch update appears in the model-visible request.

**Data flow**: It creates an initial session with one model, sends a seed turn, and saves the recorded session path. It then resumes with a different configured model, submits thread settings that override the model back to the original one and change the environment, sends the first resumed user turn, captures the request, and snapshots it against the pre-resume request.

**Call relations**: The test first uses a single mounted fake response to record initial history, then mounts another response for the resumed turn. It calls the external thread-settings submission helper before the user input so the resumed request is built under the override, then passes the captured requests to the labeled snapshot formatter.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex); 8 external calls (clone, default, submit_thread_settings, wait_for_event, create_dir_all, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_model_visible_layout_environment_context_includes_one_subagent`  (lines 552–559)

```
async fn snapshot_model_visible_layout_environment_context_includes_one_subagent() -> Result<()>
```

**Purpose**: This small snapshot test verifies how the environment context looks when exactly one subagent is listed. A subagent is another named helper agent that the model may need to know is available or active.

**Data flow**: It provides one subagent line, formats the environment context snapshot text, and compares the result with the saved snapshot. Nothing is sent to a server and no Codex session is started.

**Call relations**: This test is a focused snapshot check. Instead of running a full conversation, it relies on the environment-context formatting helper and then uses the snapshot assertion to freeze the expected text layout.

*Call graph*: 1 external calls (assert_snapshot!).


##### `snapshot_model_visible_layout_environment_context_includes_two_subagents`  (lines 562–569)

```
async fn snapshot_model_visible_layout_environment_context_includes_two_subagents() -> Result<()>
```

**Purpose**: This small snapshot test verifies how the environment context looks when two subagents are listed. It protects the formatting of multiple subagent entries, including their order and indentation.

**Data flow**: It provides two subagent lines, formats the environment context snapshot text, and compares the result with the saved snapshot. It only checks text formatting and does not interact with the fake Responses API server.

**Call relations**: Like the one-subagent test, this is a narrow snapshot check around environment-context output. The snapshot assertion records the formatted result so later formatting changes are reviewed deliberately.

*Call graph*: 1 external calls (assert_snapshot!).


### `core/tests/suite/permissions_messages.rs`

`test` · `test run`

Codex needs to tell the model what it is allowed to do: whether it may run commands, write files, use the network, or must ask the user first. These tests protect that behavior. Without them, Codex might silently forget to tell the model about safety limits, repeat stale instructions, or omit important workspace paths.

The tests use a mock Responses API server, which acts like a fake model service. Each test starts Codex, sends one or more user messages, waits until the turn finishes, then inspects the outgoing request that Codex sent to the fake server. The helper `permissions_texts` looks inside the developer messages and extracts only the parts that contain the permissions instructions.

The file checks several important stories. On a new conversation, the permissions message should be sent once. If thread settings change the approval policy, Codex should add a new permissions message so the model sees the new rules. If nothing changes, Codex should not add duplicates. If the feature is disabled, no permissions instructions should be sent at all. Resume and fork tests make sure old permission messages are replayed in the right order and that new ones are appended only when the active policy differs. The final test verifies that writable workspace roots are included in the rendered instructions.

#### Function details

##### `permissions_texts`  (lines 28–34)

```
fn permissions_texts(request: &ResponsesRequest) -> Vec<String>
```

**Purpose**: This small helper pulls permission-instruction text out of a recorded request to the mock model server. It lets the tests focus only on the safety instructions instead of searching through the whole request by hand.

**Data flow**: It receives a `ResponsesRequest`, reads the developer-message text entries from it, keeps only the strings that contain the marker `<permissions instructions>`, and returns those strings as a list. It does not change the request.

**Call relations**: The permission-message tests call this after Codex has sent a request to the mock server. It relies on `message_input_texts` to get the developer messages, then hands back a clean list that the tests compare against expected counts and contents.

*Call graph*: calls 1 internal fn (message_input_texts); called by 5 (permissions_message_added_on_override_change, permissions_message_includes_writable_roots, permissions_message_not_added_when_no_change, resume_and_fork_append_permissions_messages, resume_replays_permissions_messages).


##### `permissions_message_sent_once_on_start`  (lines 37–69)

```
async fn permissions_message_sent_once_on_start() -> Result<()>
```

**Purpose**: This test proves that a fresh Codex turn includes exactly one permissions-instructions message. That matters because the model needs the rules, but repeated copies would clutter the conversation and could cause confusion.

**Data flow**: It starts a mock server, configures Codex to ask for approval on request, sends one simple user message, waits for the turn to complete, then inspects the single outgoing request. The expected result is one permission-instruction text in that request.

**Call relations**: The asynchronous test runner calls this test. Inside it, the test-support helpers create the fake server response stream, build a test Codex instance, submit user input, wait for a `TurnComplete` event, and finally use an assertion to confirm the request contains one permissions message.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `permissions_message_added_on_override_change`  (lines 72–138)

```
async fn permissions_message_added_on_override_change() -> Result<()>
```

**Purpose**: This test checks that Codex adds a new permissions-instructions message when the thread's approval policy changes. In plain terms, if the house rules change mid-conversation, the model must be told the new rules.

**Data flow**: It creates two mocked model responses, sends an initial user message under an `OnRequest` approval policy, then submits thread settings that change the policy to `Never`. After a second user message, it reads both recorded requests: the first should contain one permissions message, and the second should contain two different permission messages.

**Call relations**: The test runner invokes this test. It uses the mock-server helpers and `test_codex` to run a controlled conversation, uses `submit_thread_settings` to change the active settings, then calls `permissions_texts` to extract the permission messages before checking that a genuinely new instruction was added.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, permissions_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `permissions_message_not_added_when_no_change`  (lines 141–197)

```
async fn permissions_message_not_added_when_no_change() -> Result<()>
```

**Purpose**: This test makes sure Codex does not add another permissions message when the permission settings have not changed. This keeps the conversation history tidy and avoids repeating the same rule sheet unnecessarily.

**Data flow**: It starts Codex with an approval policy, sends one user message, waits for completion, then sends a second user message without changing any permissions. It extracts permissions text from both requests and expects each request to contain the same single permissions message.

**Call relations**: The async test runner runs this scenario. The test uses the fake server to capture two model requests, uses `permissions_texts` to read the permission instructions from each, and then compares the results to prove no extra message was appended.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, permissions_texts); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `permissions_message_omitted_when_disabled`  (lines 200–268)

```
async fn permissions_message_omitted_when_disabled() -> Result<()>
```

**Purpose**: This test verifies the configuration switch that disables permissions instructions entirely. If a user or setup turns that feature off, Codex should respect it even when permissions change later.

**Data flow**: It configures Codex with `include_permissions_instructions` set to false, sends one user message, changes the thread approval policy, and sends another user message. It then checks both captured requests and expects no permissions-instruction text at all.

**Call relations**: The test runner starts this test, while the test-support code supplies the mock server, Codex instance, thread-settings override, and turn-completion waiting. Unlike most other tests in this file, it intentionally expects `permissions_texts` to find nothing in either recorded request.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `resume_replays_permissions_messages`  (lines 271–363)

```
async fn resume_replays_permissions_messages() -> Result<()>
```

**Purpose**: This test checks what happens when a conversation is resumed from saved history. It proves that Codex replays the earlier permissions messages so the model still has the safety context after a restart.

**Data flow**: It starts an initial session, sends a message under one approval policy, changes the policy, sends another message, then resumes the saved session and sends a third message. The resumed request should contain three permission-message entries total, with two unique versions because one policy was repeated from history.

**Call relations**: The test runner invokes this resume scenario. The test builds an initial Codex session, saves the rollout path and home directory needed to resume, uses `submit_thread_settings` to create a policy change, then calls the builder's resume path. After the resumed turn finishes, `permissions_texts` confirms the permission history was carried forward.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, permissions_texts); 6 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `resume_and_fork_append_permissions_messages`  (lines 366–510)

```
async fn resume_and_fork_append_permissions_messages() -> Result<()>
```

**Purpose**: This test compares two ways of continuing a conversation: resuming it and forking it into a new thread. It ensures both paths preserve the old permissions messages and append the same new message when the active approval policy changes.

**Data flow**: It runs an initial conversation with a permissions change and records the base permission messages. Then it resumes the saved conversation with a different approval policy and checks that one new permissions message was appended after the old ones. It also forks the original thread with the same changed policy and checks that the fork produces the same final permission-message list as the resume path.

**Call relations**: The test runner calls this larger scenario. It uses mock responses for each turn, `test_codex` for the original and resumed sessions, `permissions_texts` for request inspection, and the thread manager's fork operation to create a branch. The final assertions tie the two flows together by proving resume and fork append permission instructions consistently.

*Call graph*: calls 6 internal fn (allow_any, mount_sse_once, sse, start_mock_server, test_codex, permissions_texts); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `permissions_message_includes_writable_roots`  (lines 513–581)

```
async fn permissions_message_includes_writable_roots() -> Result<()>
```

**Purpose**: This test verifies that the rendered permissions instructions include the directories Codex is allowed to write to. That is important because the model needs to know not just that writing is allowed, but where it is allowed.

**Data flow**: It creates a temporary writable directory, builds a workspace-write permission profile that includes that directory, configures Codex with those workspace roots, and sends a user message. It then independently renders the expected permissions instructions from the same effective permission profile and compares that expected text with what Codex actually sent, normalizing line endings first so different operating systems do not affect the result.

**Call relations**: The test runner runs this as an end-to-end check of permission rendering. The test combines setup helpers such as the mock server and `test_codex` with permission-building functions like `workspace_write_with` and `from_permission_profile`. It then uses `permissions_texts` to extract the outgoing instructions and compares them to the instructions rendered directly from the active configuration.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, test_codex, permissions_texts, from_permission_profile, workspace_write_with, try_from); 8 external calls (default, new, assert_eq!, load_exec_policy, wait_for_event, skip_if_no_network!, from_ref, vec!).


### `core/tests/suite/personality.rs`

`test` · `test run`

Codex can change the assistant’s communication style by adding a personality template to the model instructions. This test file is the safety net for that behavior. Without these tests, a change could accidentally make Codex ignore a user’s requested style, send duplicate style instructions, leak placeholder text like `{{ personality }}`, or apply personality even when the feature is turned off.

The file uses a mock server, which is a fake model service used during tests. The tests submit simple read-only user turns, wait until Codex finishes the turn, then inspect the outgoing request that Codex would have sent to the model. This is like checking a sealed letter before it leaves the post office: the tests care less about the model’s answer and more about whether the instructions in the envelope are correct.

The cases cover several paths. Some check local built-in models and local personality text. Others create remote model metadata with its own personality templates and confirm Codex uses those remote templates. The tests also verify important boundaries: explicit base-instruction overrides stop personality templating, the disabled feature flag makes personality inert, `Personality::None` removes personality text, and changing personality mid-thread adds a developer message only when the value actually changes.

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

**Purpose**: This helper builds a simple user message for the tests, with read-only permissions and no per-turn personality override. Tests use it when they want to focus on the personality already set in configuration or thread settings.

**Data flow**: It takes the test harness, the user text, a model name, and an approval policy. It adds `None` as the personality value, then passes everything to `read_only_text_turn_with_personality`, which returns an operation that can be submitted to Codex.

**Call relations**: Most of the personality request tests call this helper before submitting a turn to Codex. It keeps those tests short, while the more detailed helper does the actual construction of the operation.

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

**Purpose**: This helper builds the full test operation for a user turn, including text, model choice, read-only permission settings, and an optional personality. It is used when a test needs precise control over the personality sent with the turn.

**Data flow**: It receives the test harness, message text, model name, approval policy, and optional personality. It reads the test working directory, builds read-only sandbox and permission fields, wraps the text as user input, adds thread setting overrides such as model and personality, and returns an `Op::UserInput` ready to submit.

**Call relations**: `read_only_text_turn` calls this with no personality override for ordinary cases. The remote-model friendly personality test calls it directly so the submitted turn explicitly carries `Personality::Friendly`.

*Call graph*: calls 4 internal fn (cwd_path, local_selections, turn_permission_fields, read_only); called by 2 (read_only_text_turn, remote_model_friendly_personality_instructions_with_feature); 2 external calls (default, vec!).


##### `personality_does_not_mutate_base_instructions_without_template`  (lines 92–106)

```
async fn personality_does_not_mutate_base_instructions_without_template()
```

**Purpose**: This test checks that choosing a personality does not secretly rewrite a model’s plain base instructions when that model has no personality template. It protects the rule that personality text is only inserted when there is a proper place for it.

**Data flow**: It creates a temporary test configuration, enables the personality feature, sets the personality to friendly, then constructs model information offline. It compares the generated instructions with the model’s original base instructions and expects them to be identical.

**Call relations**: This is an isolated configuration-level test. Instead of sending a request through the mock server, it directly asks the model information object what instructions it would use.

*Call graph*: calls 1 internal fn (construct_model_info_offline); 3 external calls (new, assert_eq!, load_default_config_for_test).


##### `base_instructions_override_disables_personality_template`  (lines 109–127)

```
async fn base_instructions_override_disables_personality_template()
```

**Purpose**: This test verifies that a user-supplied base-instructions override takes priority over personality templating. If someone explicitly writes their own instructions, Codex should not add style text on top of them.

**Data flow**: It creates a temporary configuration, enables personality, sets friendly personality, and also sets `base_instructions` to a custom string. It builds model information offline and checks that both the stored base instructions and the final model instructions equal the custom override.

**Call relations**: Like the nearby instruction tests, this works directly with offline model metadata. It confirms the instruction-building layer respects explicit overrides before the request-sending tests exercise full Codex turns.

*Call graph*: calls 1 internal fn (construct_model_info_offline); 3 external calls (new, assert_eq!, load_default_config_for_test).


##### `user_turn_personality_none_does_not_add_update_message`  (lines 130–166)

```
async fn user_turn_personality_none_does_not_add_update_message() -> anyhow::Result<()>
```

**Purpose**: This test makes sure a normal user turn with no personality override does not add a special personality-change message. It prevents Codex from sending unnecessary hidden instructions when nothing changed.

**Data flow**: It starts a mock server, prepares one fake successful model response, enables the personality feature, builds a Codex test instance, submits a read-only text turn, and waits for completion. It then inspects the request’s developer messages and confirms none contain the `<personality_spec>` marker.

**Call relations**: The test uses `read_only_text_turn` to create the submitted operation. After Codex sends the request to the mock server, the test reads the captured request to verify that no personality update message was injected.

*Call graph*: calls 5 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, read_only_text_turn); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `config_personality_some_sets_instructions_template`  (lines 169–213)

```
async fn config_personality_some_sets_instructions_template() -> anyhow::Result<()>
```

**Purpose**: This test confirms that a configured personality is folded into the main model instructions for a local model. In this case, friendly style text should appear in the instructions field, not as a separate developer message.

**Data flow**: It starts a mock server, enables the personality feature, sets the configuration personality to friendly, submits a simple user turn, and waits for the turn to finish. It reads the outgoing instructions text and checks that the friendly template is present, then checks developer messages to make sure no separate personality update was sent.

**Call relations**: It relies on `read_only_text_turn` to trigger a standard Codex request. The captured mock-server request is the evidence that initial configuration personality is applied through the model instructions path.

*Call graph*: calls 5 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, read_only_text_turn); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `config_personality_none_sends_no_personality`  (lines 216–267)

```
async fn config_personality_none_sends_no_personality() -> anyhow::Result<()>
```

**Purpose**: This test checks that explicitly choosing `Personality::None` really removes personality text. It protects users who want no communication-style shaping at all.

**Data flow**: It enables the personality feature, sets the configuration personality to none, submits a simple turn, and waits for completion. It then checks the outgoing instructions to ensure friendly text, pragmatic text, and the raw placeholder are all absent, and also checks developer messages for no personality update marker.

**Call relations**: The test follows the same mock-server request-inspection pattern as other configuration tests. `read_only_text_turn` creates the turn, and the mock request shows whether personality text was correctly omitted.

*Call graph*: calls 5 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, read_only_text_turn); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `default_personality_is_pragmatic_without_config_toml`  (lines 270–304)

```
async fn default_personality_is_pragmatic_without_config_toml() -> anyhow::Result<()>
```

**Purpose**: This test verifies the default behavior when the personality feature is enabled but no explicit personality is set in a config file. The expected default is the pragmatic style.

**Data flow**: It enables the personality feature without setting a personality value, submits a simple read-only turn, waits for the mock response to complete, and inspects the outgoing instructions. The test expects the local pragmatic template to be present.

**Call relations**: This test uses the same full Codex flow as the other request tests. It proves the default personality is applied during request construction, not just in lower-level configuration code.

*Call graph*: calls 5 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, read_only_text_turn); 3 external calls (assert!, wait_for_event, skip_if_no_network!).


##### `user_turn_personality_some_adds_update_message`  (lines 307–379)

```
async fn user_turn_personality_some_adds_update_message() -> anyhow::Result<()>
```

**Purpose**: This test confirms that changing the personality during an existing thread adds a clear developer message telling the model about the new communication style. This matters because a running conversation may need an explicit update, not just a changed initial instruction.

**Data flow**: It prepares two fake model responses, submits an initial turn, waits for it to finish, then submits thread settings that change the personality to friendly. After a second turn completes, it inspects the second outgoing request and looks for a developer message containing the personality marker, a preamble about the requested style change, and the friendly template.

**Call relations**: The test first uses `read_only_text_turn` to establish a prior turn, then uses the shared test support helper to submit changed thread settings. The second call to `read_only_text_turn` causes Codex to send a new request where the personality update message should appear.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only_text_turn); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `user_turn_personality_same_value_does_not_add_update_message`  (lines 382–449)

```
async fn user_turn_personality_same_value_does_not_add_update_message() -> anyhow::Result<()>
```

**Purpose**: This test makes sure Codex does not send a personality-change message when the requested personality is the same as the current one. It prevents repeated or noisy hidden instructions.

**Data flow**: It starts with pragmatic personality in configuration, submits one turn, then submits thread settings that again specify pragmatic. After a second turn, it inspects the second request and confirms there is no developer message containing the personality marker.

**Call relations**: This test mirrors the change-personality test, but the value stays the same. By comparing the second captured request, it verifies that Codex only sends an update when there is a real change.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only_text_turn); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `instructions_uses_base_if_feature_disabled`  (lines 452–469)

```
async fn instructions_uses_base_if_feature_disabled() -> anyhow::Result<()>
```

**Purpose**: This test checks that the personality feature flag fully disables personality instruction changes. Even if a personality value is present, final instructions should stay as the model’s base instructions.

**Data flow**: It creates a temporary config, disables the personality feature, sets personality to friendly, and constructs model information offline. It asks for the model instructions and expects them to match the base instructions exactly.

**Call relations**: This is a lower-level counterpart to the full request test for disabled personality. It checks the instruction-building behavior directly without involving the mock server.

*Call graph*: calls 1 internal fn (construct_model_info_offline); 3 external calls (new, assert_eq!, load_default_config_for_test).


##### `user_turn_personality_skips_if_feature_disabled`  (lines 472–537)

```
async fn user_turn_personality_skips_if_feature_disabled() -> anyhow::Result<()>
```

**Purpose**: This test verifies that thread-level personality changes are ignored when the personality feature is disabled. It ensures the feature flag is respected even during an active conversation.

**Data flow**: It prepares two mock responses, builds Codex with the personality feature disabled, submits an initial turn, then submits thread settings asking for pragmatic personality. After the second turn, it inspects the second request and confirms no personality update developer message was added.

**Call relations**: The test uses `read_only_text_turn` for both turns and a thread-settings helper between them. Its captured second request proves that disabled personality does not affect outgoing model messages.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only_text_turn); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `remote_model_friendly_personality_instructions_with_feature`  (lines 540–651)

```
async fn remote_model_friendly_personality_instructions_with_feature() -> anyhow::Result<()>
```

**Purpose**: This test checks that Codex can use personality templates supplied by remote model metadata, not only local built-in templates. For a remote model with both default and friendly text, friendly should win when requested.

**Data flow**: It starts a mock server with a large body-print limit, defines a fake remote model including an instructions template and personality variables, mounts that model response, and prepares one fake model completion. It builds an authenticated Codex test instance, waits until the remote model appears in the model list, submits a friendly turn for that model, then checks that the outgoing instructions contain the remote friendly text and not the remote default text.

**Call relations**: This test uses `wait_for_model_available` because remote model metadata is loaded through the models manager. Once the model is visible, it uses `read_only_text_turn_with_personality` to submit a turn that explicitly selects the remote model and friendly personality.

*Call graph*: calls 9 internal fn (mount_models_once, mount_sse_once, sse_completed, test_codex, read_only_text_turn_with_personality, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 8 external calls (Limited, default, builder, new, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `user_turn_personality_remote_model_template_includes_update_message`  (lines 654–796)

```
async fn user_turn_personality_remote_model_template_includes_update_message() -> anyhow::Result<()>
```

**Purpose**: This test verifies that a mid-thread personality change uses the remote model’s own personality template in the update message. It protects remote models from accidentally falling back to the local personality wording.

**Data flow**: It defines a fake remote model with remote friendly and pragmatic personality text, mounts that model list, and prepares two fake model completions. It builds Codex, waits for the remote model to be available, submits one turn with that model, changes thread settings to friendly personality, submits a second turn, and inspects the second request for a developer message containing the remote friendly text and the style-change preamble.

**Call relations**: Like the other remote-model test, it depends on `wait_for_model_available` before submitting turns. It uses `read_only_text_turn` for the two conversation turns and the thread-settings helper to trigger the personality change between them.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, read_only_text_turn, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 10 external calls (Limited, default, builder, new, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `wait_for_model_available`  (lines 798–810)

```
async fn wait_for_model_available(manager: &SharedModelsManager, slug: &str)
```

**Purpose**: This helper waits briefly until a named model appears in the shared models manager. It exists because remote model metadata may be fetched asynchronously, so a test must not submit work before the model is known.

**Data flow**: It takes a models manager and a model slug. Until a two-second deadline, it repeatedly asks the manager for the current model list, returns once it finds the requested slug, and sleeps for a short time between checks. If the deadline passes, it stops the test with a clear timeout failure.

**Call relations**: The two remote-model tests call this after mounting fake model metadata and before submitting turns. It bridges setup and execution by making sure Codex has loaded the mocked remote model before the request is tested.

*Call graph*: called by 2 (remote_model_friendly_personality_instructions_with_feature, user_turn_personality_remote_model_template_includes_update_message); 6 external calls (from_millis, from_secs, now, list_models, panic!, sleep).


### `core/tests/suite/prompt_caching.rs`

`test` · `test run`

This is a test file for prompt caching. Prompt caching means reusing the unchanged beginning of a model request, so later requests can be faster and cheaper. For that to work, Codex must keep the shared prefix of each request exactly the same unless something truly changed.

The tests start a mock server that pretends to be the model API. Then they create a test Codex session, send one or more user messages, and inspect the JSON request bodies that Codex sent to the mock server. This is like checking the envelopes before they leave the mailroom: the tests do not care what the model would answer, only whether Codex packed the request correctly.

The file focuses on a few important rules. The list of available tools must stay consistent. Base instructions should not grow or change between turns. User instructions and environment context, such as current working directory and shell, should appear once in the cached prefix. If settings change, such as the model, approval policy, sandbox permissions, or working directory, Codex should append an update message and fresh environment context without rewriting the old prefix. If a turn repeats the same settings, Codex should avoid sending redundant context. Without these tests, small accidental prompt changes could quietly break caching or give the model stale information.

#### Function details

##### `write_global_instructions`  (lines 37–40)

```
fn write_global_instructions(home: &Path)
```

**Purpose**: Creates a simple global instructions file for tests. Codex later reads this file as user guidance, so the tests can check whether those instructions are included in the prompt.

**Data flow**: It receives a home directory path, adds the file name AGENTS.md to it, and writes the text "be consistent and helpful" into that file. It does not return useful data; it changes the temporary test filesystem.

**Call relations**: The test builder calls this through its pre-build hook before a Codex test session is created. The later prompt-building tests rely on this file being present so they can verify that global instructions are included in the cached user-context message.

*Call graph*: 2 external calls (join, write).


##### `text_user_input`  (lines 42–44)

```
fn text_user_input(text: String) -> serde_json::Value
```

**Purpose**: Builds the expected JSON shape for a normal one-part user text message. Tests use it to compare what Codex sent to the model against what they expected.

**Data flow**: It takes one text string, wraps it in a one-item list, and passes that list to text_user_input_parts. The result is a JSON value representing a user message with one input_text item.

**Call relations**: The no-change and change tests call this when constructing the expected request input arrays. It delegates the actual JSON construction to text_user_input_parts so single-part and multi-part expected messages use the same format.

*Call graph*: calls 1 internal fn (text_user_input_parts); called by 2 (send_user_turn_with_changes_sends_environment_context, send_user_turn_with_no_changes_does_not_send_environment_context); 1 external calls (vec!).


##### `text_user_input_parts`  (lines 46–55)

```
fn text_user_input_parts(texts: Vec<String>) -> serde_json::Value
```

**Purpose**: Builds the expected JSON shape for a user message that may contain several text chunks. This is useful because some prompt messages bundle user instructions and environment context together.

**Data flow**: It takes a list of strings, turns each string into an input_text content item, and returns one JSON message with role "user" and that content list. It does not change any outside state.

**Call relations**: text_user_input calls it for the simple one-text case. The prompt-caching tests call it directly when they need to describe a bundled contextual message, such as global instructions plus environment context.

*Call graph*: called by 3 (send_user_turn_with_changes_sends_environment_context, send_user_turn_with_no_changes_does_not_send_environment_context, text_user_input); 1 external calls (json!).


##### `assert_default_env_context`  (lines 57–67)

```
fn assert_default_env_context(text: &str, cwd: &str)
```

**Purpose**: Checks that an environment context block contains the standard pieces Codex should tell the model: the current directory, the user's shell, date, timezone, and closing tag. This keeps the tests from accepting incomplete context.

**Data flow**: It receives the environment-context text and the expected current working directory. First it asks assert_env_context_fragment to check the common wrapper, then it verifies that the text includes the expected cwd and shell name. If anything is missing, the test fails.

**Call relations**: Several tests call this after extracting environment context from a model request. It builds on assert_env_context_fragment for the shared tag checks and adds the default-session checks for cwd and shell.

*Call graph*: calls 1 internal fn (assert_env_context_fragment); called by 4 (per_turn_overrides_keep_cached_prefix_and_key_constant, prefixes_context_and_instructions_once_and_consistently_across_requests, send_user_turn_with_changes_sends_environment_context, send_user_turn_with_no_changes_does_not_send_environment_context); 1 external calls (assert!).


##### `assert_env_context_fragment`  (lines 69–86)

```
fn assert_env_context_fragment(text: &str)
```

**Purpose**: Checks the basic shape of an environment context block. It makes sure the block starts and ends correctly and includes date and timezone fields.

**Data flow**: It takes a text string and runs assertions on its beginning, contents, and ending. It returns nothing; a failed check stops the test with a clear error message.

**Call relations**: assert_default_env_context uses it for the common environment checks. Tests that expect custom or changed permissions call it directly when cwd and shell are not the main concern.

*Call graph*: called by 3 (assert_default_env_context, overrides_turn_context_but_keeps_cached_prefix_and_key_constant, send_user_turn_with_changes_sends_environment_context); 1 external calls (assert!).


##### `assert_tool_names`  (lines 88–104)

```
fn assert_tool_names(body: &serde_json::Value, expected_names: &[&str])
```

**Purpose**: Compares the tools sent in a model request with the exact tool names the test expects. This catches accidental additions, removals, or reordering of tools that could change the cached prompt.

**Data flow**: It receives a JSON request body and an ordered list of expected names. It reads the request's tools array, extracts each tool's name or type field, and compares the resulting list to the expected list. It does not modify the request.

**Call relations**: prompt_tools_are_consistent_across_requests calls this for both captured model requests. The helper keeps that test focused on the bigger caching rule instead of repeating JSON extraction code.

*Call graph*: called by 1 (prompt_tools_are_consistent_across_requests); 1 external calls (assert_eq!).


##### `normalize_newlines`  (lines 106–108)

```
fn normalize_newlines(text: &str) -> String
```

**Purpose**: Makes text comparison insensitive to Windows-style line endings. This lets tests compare instructions reliably across platforms.

**Data flow**: It receives a string slice, replaces every carriage-return-plus-newline sequence with a plain newline, and returns the cleaned string.

**Call relations**: The GPT-5 apply-patch-instructions test uses it before comparing instruction strings from two requests. That way the test checks real content stability instead of failing because of newline style.


##### `prompt_tools_are_consistent_across_requests`  (lines 111–223)

```
async fn prompt_tools_are_consistent_across_requests() -> anyhow::Result<()>
```

**Purpose**: Verifies that two consecutive model requests use the same instructions and the same ordered tool list. This matters because changing either one can break prompt caching.

**Data flow**: It starts a mock server, prepares two fake model responses, builds a test Codex session with global instructions and selected features, then sends two user turns. After each turn completes, it reads the captured JSON requests and compares their instructions and tool names to the expected values.

**Call relations**: This is a top-level asynchronous test run by the Rust test framework. It uses the mock server helpers to capture outgoing requests, uses test_codex to create the session, and calls assert_tool_names to validate the request tool arrays.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_tool_names); 6 external calls (default, assert_eq!, cfg!, wait_for_event, skip_if_no_network!, vec!).


##### `gpt_5_tools_without_apply_patch_append_apply_patch_instructions`  (lines 226–302)

```
async fn gpt_5_tools_without_apply_patch_append_apply_patch_instructions() -> anyhow::Result<()>
```

**Purpose**: Checks that when a GPT-5-style setup does not expose apply_patch as a tool, Codex still includes the apply-patch guidance in the instructions, and that those instructions stay identical across turns.

**Data flow**: It starts a mock server, builds a GPT-5.2 test session, sends two user messages, waits for both turns to finish, and reads the instruction text from both captured requests. It confirms the instructions are non-empty and equal after newline normalization.

**Call relations**: This test is run directly by the test framework. It uses the same mock-response path as the other tests, and it relies on normalize_newlines to make the final comparison portable across operating systems.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `prefixes_context_and_instructions_once_and_consistently_across_requests`  (lines 305–399)

```
async fn prefixes_context_and_instructions_once_and_consistently_across_requests() -> anyhow::Result<()>
```

**Purpose**: Verifies that Codex puts permissions, user instructions, environment context, and the first user message into the cached prefix only once, then reuses that prefix for the next request.

**Data flow**: It creates a mock server and a test session with global instructions, sends two user turns, and inspects both request bodies. For the first request it checks the input contains a permissions message, a contextual user message, and the user's text. For the second request it checks the earlier prefix is byte-for-byte reused before adding the second user message.

**Call relations**: The test framework calls this as an asynchronous test. It calls assert_default_env_context to verify the environment block and uses the JSON helper expectations to confirm the exact request layout.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_default_env_context); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `overrides_turn_context_but_keeps_cached_prefix_and_key_constant`  (lines 402–529)

```
async fn overrides_turn_context_but_keeps_cached_prefix_and_key_constant() -> anyhow::Result<()>
```

**Purpose**: Checks what happens when thread settings are changed after the first turn. The important rule is that Codex should keep the old cached prefix and prompt cache key stable, then append an update describing the new permissions and environment.

**Data flow**: It sends an initial user turn, creates a new writable temporary directory and permission profile, submits thread-setting overrides, then sends a second user turn. It compares the two captured requests, making sure the prompt_cache_key is unchanged, the original prefix is reused, and the second request adds updated permissions, environment context, and the new user message.

**Call relations**: This test is run by the test framework. It uses mock server helpers to capture the two API calls, submit_thread_settings to change the session state between turns, and assert_env_context_fragment to check the newly appended environment block.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, assert_env_context_fragment, workspace_write_with); 10 external calls (default, new, assert!, assert_eq!, assert_ne!, submit_thread_settings, wait_for_event, json!, skip_if_no_network!, vec!).


##### `override_before_first_turn_emits_environment_context`  (lines 532–688)

```
async fn override_before_first_turn_emits_environment_context() -> anyhow::Result<()>
```

**Purpose**: Verifies that if settings are overridden before the first user message, Codex still sends environment context and updated permissions in that first request. This prevents the model from starting with missing or stale session information.

**Data flow**: It starts a test session, submits thread settings before any user turn, then sends the first message. It reads the captured request and checks the selected model and reasoning effort, confirms environment context is present, confirms permissions mention the overridden approval policy, and confirms the user text is included.

**Call relations**: The test framework runs it as an asynchronous test. It uses submit_thread_settings before sending user input, then inspects the single mock-server request to make sure the first real model call reflects those earlier overrides.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `per_turn_overrides_keep_cached_prefix_and_key_constant`  (lines 691–816)

```
async fn per_turn_overrides_keep_cached_prefix_and_key_constant() -> anyhow::Result<()>
```

**Purpose**: Checks that one-off settings attached to a single user turn do not destroy prompt caching. Codex should reuse the old prefix and key, then append just the update needed for that turn.

**Data flow**: It sends a first user turn, creates temporary directories and a permission profile for the second turn, and submits the second user input with per-turn overrides such as cwd, model, approval policy, sandbox permissions, reasoning effort, and summary. It then checks the second request keeps the original prompt_cache_key and prefix, adds a developer settings update, adds fresh environment context for the new cwd, and finally adds the second user message.

**Call relations**: This top-level async test uses local_selections and turn_permission_fields to build valid per-turn environment and permission data. It calls assert_default_env_context to confirm that the appended environment context matches the overridden working directory.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, assert_default_env_context, workspace_write_with); 9 external calls (default, new, assert!, assert_eq!, assert_ne!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `send_user_turn_with_no_changes_does_not_send_environment_context`  (lines 819–955)

```
async fn send_user_turn_with_no_changes_does_not_send_environment_context() -> anyhow::Result<()>
```

**Purpose**: Verifies that sending per-turn settings equal to the existing defaults does not cause Codex to resend environment context. This avoids unnecessary prompt growth and protects cache reuse.

**Data flow**: It records the session defaults, sends a first user turn with overrides that match those defaults, then sends a second turn with the same unchanged settings. It inspects both request bodies and expects the second request to contain the original cached prefix, the first user message, and the second user message, with no extra environment update in between.

**Call relations**: The test framework runs this function. It uses local_selections to express the default environment, assert_default_env_context to check the initial cached context, and text_user_input/text_user_input_parts to build the exact JSON shape expected from the two requests.

*Call graph*: calls 8 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, assert_default_env_context, text_user_input, text_user_input_parts); 6 external calls (default, assert_eq!, wait_for_event, Array, skip_if_no_network!, vec!).


##### `send_user_turn_with_changes_sends_environment_context`  (lines 958–1124)

```
async fn send_user_turn_with_changes_sends_environment_context() -> anyhow::Result<()>
```

**Purpose**: Verifies the opposite of the no-change case: when per-turn settings really do change, Codex must send updated settings and environment context before the new user message.

**Data flow**: It sends a first turn using settings that match the defaults, then sends a second turn with changed permission profile, approval policy, summary, model, and reasoning effort. It checks that the first request has the normal cached prefix, and that the second request reuses that prefix, appends a developer update with model-switch information, appends environment context showing the disabled unrestricted filesystem profile, and then appends the second user message.

**Call relations**: This asynchronous test uses the mock server to capture both requests, turn_permission_fields to translate the changed permission profile into request-ready fields, assert_default_env_context for the initial context, and assert_env_context_fragment for the appended changed-context block.

*Call graph*: calls 10 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields, assert_default_env_context, assert_env_context_fragment, text_user_input, text_user_input_parts); 8 external calls (default, assert!, assert_eq!, assert_ne!, wait_for_event, Array, skip_if_no_network!, vec!).


### `core/tests/suite/prompt_debug_tests.rs`

`test` · `test run`

This is a focused automated test for the part of the system that prepares input for the language model. Before the model can answer, the application gathers several pieces of context: the user's message, configuration such as the working folder, and any saved instructions from the user's Codex home directory. This test checks that those pieces actually make it into the final prompt.

The test creates two temporary folders, like a clean pretend computer environment. One folder acts as the Codex home directory, and the test writes an `AGENTS.md` file there containing global instructions. The other folder acts as the current working directory. It then builds a configuration that points at those folders and creates a user-instructions provider, which is the object responsible for reading the saved instruction file.

Next, the test calls `build_prompt_input` with a simple user message: “hello from debug prompt”. It then checks two important things. First, the final item in the prompt is exactly that user message, in the format expected by the rest of the system. Second, somewhere in the prompt there is text containing the saved instruction string. If either check fails, the system may be losing user context before sending the prompt to the model.

#### Function details

##### `build_prompt_input_includes_context_and_user_message`  (lines 17–70)

```
async fn build_prompt_input_includes_context_and_user_message() -> Result<()>
```

**Purpose**: This test verifies that prompt construction includes both the current user message and global instructions read from the Codex home directory. It is used to catch regressions where the model would receive only part of the needed context.

**Data flow**: The test starts with fresh temporary folders and writes a known instruction string into an `AGENTS.md` file. It builds a configuration from those folders, wraps a user-instructions reader in a shared pointer, and sends a simple text message into `build_prompt_input`. The result is a list of prompt items; the test confirms that the last item is the exact user message and that at least one prompt item contains the instruction text.

**Call relations**: During the test, this function calls setup helpers to create temporary directories, build configuration defaults, and create the user-instructions provider. Its central handoff is to `build_prompt_input`, which performs the real prompt assembly. After that, the test uses assertions to compare the returned prompt with the expected user message and to scan the prompt for the saved global instructions.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, new, assert!, assert_eq!, build_prompt_input, default, default, current_exe, write, vec!).


### `core/tests/suite/token_budget.rs`

`test` · `test suite`

Large language models can only “remember” a limited amount of text at once. That limit is called the context window. This test file makes sure Codex gives the model clear budget notices, like a fuel gauge, so the model knows how much space is left before old conversation history may need to be compressed or dropped.

The tests run Codex against a mock server instead of a real model service. The mock server sends back scripted events, such as “response completed” or “the model called a tool.” Each test then inspects the actual requests Codex sent to the server and checks whether the hidden developer messages contain the expected `<token_budget>` text.

The file covers several important cases. It verifies that the first request includes a full context report with the thread id and context-window number. It checks that smaller “remaining tokens” notices are only added when usage crosses certain thresholds. It confirms that the model can call a `get_context_remaining` tool and receive the same budget fragment back. It also checks the fallback text when Codex does not know the model’s context size.

Finally, it tests context-window changes. A manual compaction should move Codex to a new numbered window, and the `new_context` tool should drop the previous window’s history before continuing. Without these tests, Codex could give stale or misleading budget information, which would make long conversations harder for the model to steer safely.

#### Function details

##### `token_budget_texts`  (lines 29–35)

```
fn token_budget_texts(request: &ResponsesRequest) -> Vec<String>
```

**Purpose**: This helper pulls out only the token-budget developer messages from a recorded model request. Tests use it so they can compare the budget text directly without digging through the whole request body each time.

**Data flow**: It receives a recorded `ResponsesRequest`. It asks that request for all developer-message text, keeps only the strings that start with `<token_budget>`, and returns those strings as a list. It does not change the request.

**Call relations**: The individual tests call this helper after the mock server has collected Codex’s outbound requests. It relies on the request helper `message_input_texts` to extract developer text, then hands the filtered budget messages back to the test assertions.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `tool_names`  (lines 37–46)

```
fn tool_names(request: &ResponsesRequest) -> Vec<String>
```

**Purpose**: This helper reads a recorded request and returns the names of tools Codex exposed to the model. Tests use it to prove that token-budget tools such as `get_context_remaining` and `new_context` are actually available when the feature is enabled.

**Data flow**: It receives a `ResponsesRequest`, reads its JSON body, looks for the `tools` array, extracts each tool’s `name` field when present, and returns the names as plain strings. If there are no tools or no names, it returns an empty list.

**Call relations**: The tool-related tests call this helper before checking model tool calls. It uses `body_json` to view the raw request data, then supplies a simple list that the assertions can search.

*Call graph*: calls 1 internal fn (body_json).


##### `token_budget_context_is_only_emitted_with_full_context`  (lines 49–98)

```
async fn token_budget_context_is_only_emitted_with_full_context() -> Result<()>
```

**Purpose**: This test checks that the full token-budget context message is sent when Codex sends a full context, and that simply changing the working directory for a later turn does not incorrectly advance the context-window number.

**Data flow**: The test starts a mock server with two simple completed responses, builds a Codex test session with a configured context window and the token-budget feature enabled, then submits two turns. The second turn uses a different local directory. Afterward, it reads the two captured requests and expects both to contain the same full token-budget message: thread id, context window `0`, and the effective number of tokens left.

**Call relations**: This is a standalone asynchronous test. It uses the mock response mounting helpers to fake the model service, `test_codex` to create a Codex session, and `token_budget_texts` to inspect what Codex sent. Its assertions protect the broader flow where Codex updates environment context without mistakenly treating that as a new conversation window.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_eq!, skip_if_no_network!, create_dir_all, vec!).


##### `token_budget_remaining_context_emits_on_first_threshold_crossing`  (lines 101–183)

```
async fn token_budget_remaining_context_emits_on_first_threshold_crossing() -> Result<()>
```

**Purpose**: This test verifies that Codex adds smaller “tokens remaining” reminders only when token use first crosses important usage thresholds. It prevents repeated or premature budget warnings from cluttering every request.

**Data flow**: The test sets up five mock responses with increasing reported token totals. It configures a small context window, submits five turns, and then examines all five outgoing requests. It expects the first request to contain the full budget message, then expects additional remaining-token fragments to appear only after the conversation has crossed the 25%, 50%, and 75% usage points.

**Call relations**: This test drives Codex through repeated turns using the mock server and test harness. It depends on `token_budget_texts` to extract the budget messages from each request, then compares them to the expected progression. In the larger system, it checks that token-budget reminders behave like milestone alerts rather than noisy repeated warnings.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_eq!, format!, skip_if_no_network!, vec!).


##### `get_context_remaining_returns_token_budget_remaining_fragment`  (lines 186–252)

```
async fn get_context_remaining_returns_token_budget_remaining_fragment() -> Result<()>
```

**Purpose**: This test checks the `get_context_remaining` tool. When the model asks how much context is left, Codex should return the same token-budget fragment it would include in developer guidance.

**Data flow**: The test creates three scripted model responses. First, the mock model spends some tokens. Second, it calls `get_context_remaining`. Third, it receives the tool output and finishes. The test then confirms that the second request exposed the tool, included the expected full and remaining budget messages, and that the follow-up request contains a tool result with the expected remaining-token text.

**Call relations**: This test sits in the tool-call path. The mock server pretends the model asked for remaining context; Codex answers that tool call; the test inspects the next request to make sure the answer was sent back. It uses `tool_names` to check tool exposure and `token_budget_texts` to verify the budget text that feeds the tool result.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 5 external calls (assert!, assert_eq!, format!, skip_if_no_network!, vec!).


##### `get_context_remaining_returns_unknown_when_window_is_unavailable`  (lines 255–315)

```
async fn get_context_remaining_returns_unknown_when_window_is_unavailable() -> Result<()>
```

**Purpose**: This test checks the fallback behavior when Codex cannot know the model’s context-window size. The model should still be allowed to call `get_context_remaining`, but the answer should honestly say the remaining amount is unknown.

**Data flow**: The test builds a Codex session where the model information has no context-window values and the config also does not provide one. The mock model calls `get_context_remaining`, then completes after receiving the result. The test confirms that no normal token-budget message was inserted into the first request, and that the tool output says there are `unknown tokens left`.

**Call relations**: This test covers the same tool flow as the known-window case, but with missing size information. It uses `tool_names` to confirm the tool is still offered, then inspects the follow-up request to ensure Codex returns a clear unknown-value message instead of inventing a number.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `token_budget_context_uses_new_window_after_compaction`  (lines 318–374)

```
async fn token_budget_context_uses_new_window_after_compaction() -> Result<()>
```

**Purpose**: This test verifies that after Codex compacts conversation history, token-budget guidance reports a new context window. Compaction is like summarizing a long notebook into a fresh page, so the budget marker should move from window `0` to window `1`.

**Data flow**: The test starts a mock server with responses for an initial turn, a compaction turn, and a later turn. It configures an OpenAI-compatible test provider, enables token budgeting, submits one normal turn, sends a compaction operation, waits until that operation completes, then submits another turn. It inspects the third request and expects a full token-budget message for context window `1` with the effective token amount restored.

**Call relations**: This test connects the token-budget feature to Codex’s compaction flow. It uses the test harness to submit normal work, sends `Op::Compact` directly into Codex, waits for a turn-complete event, and then checks the next model request with `token_budget_texts`. It ensures compaction resets the budget story correctly for future requests.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 6 external calls (assert_eq!, built_in_model_providers, wait_for_event, format!, skip_if_no_network!, vec!).


##### `new_context_tool_starts_new_window_before_follow_up`  (lines 377–458)

```
async fn new_context_tool_starts_new_window_before_follow_up() -> Result<()>
```

**Purpose**: This test checks the `new_context` tool, which lets the model ask Codex to start a fresh context window before continuing. It makes sure the follow-up request uses the new window and does not carry over the old user message history.

**Data flow**: The test scripts the mock model to first call `new_context`, then call `update_plan`, then finish. Codex is configured with token budgeting enabled. After submitting one user turn, the test examines the captured requests. It confirms that `new_context` was offered, the final follow-up request contains a full budget message for context window `1`, the old user text is absent, and the `update_plan` tool result was still carried forward. It also records a snapshot of the final request shape.

**Call relations**: This test exercises a more complex tool-driven continuation. The model asks for a fresh context, Codex starts that new window, the model continues with another tool call, and the final request is inspected. It uses `tool_names`, `token_budget_texts`, request body checks, and a formatted snapshot to prove that the reset happened while preserving the necessary follow-up tool result.

*Call graph*: calls 5 internal fn (default, format_labeled_requests_snapshot, mount_sse_sequence, start_mock_server, test_codex); 6 external calls (assert!, assert_eq!, assert_snapshot!, json!, skip_if_no_network!, vec!).


### Provider request shaping
These tests focus on how assembled prompts and settings are translated into concrete provider-facing request payloads and tool definitions.

### `core/tests/suite/json_result.rs`

`test` · `test run`

This is a test file, not production code. It protects an important user-facing feature: when a user asks for a final answer in a particular JSON shape, Codex must tell the model about that shape and must preserve the model's JSON answer. Without this test, a change could silently stop sending the JSON schema to the model, loosen the strict format requirement, or garble the final JSON message.

The test sets up a small fake model server, like a practice cashier in a training store. The fake server only replies if Codex sends the right request: a text format named `codex_output_schema`, marked as a strict `json_schema`, with the exact schema defined in this file. That schema requires two string fields: `explanation` and `final_answer`, and allows no extra fields.

After the mock server is ready, the test starts a test Codex instance, submits normal user text, and includes the desired JSON schema as `final_output_json_schema`. It also turns off approval prompts and sandbox restrictions so the test focuses only on JSON output behavior. The mock server returns a streaming response containing a JSON string. The test waits for Codex to emit an agent message, parses that message as JSON, and checks that both expected fields survived with the expected values.

The file is disabled on Windows, likely because some supporting test environment behavior is Unix-specific.

#### Function details

##### `codex_returns_json_result_for_gpt5`  (lines 34–36)

```
async fn codex_returns_json_result_for_gpt5() -> anyhow::Result<()>
```

**Purpose**: This is a Tokio asynchronous test case for the GPT-5.4 model setting. It exists to prove that the shared JSON-result test passes when Codex is configured with that model name.

**Data flow**: The test starts with no custom input of its own. It passes the model name `gpt-5.4` into the shared helper, waits for that helper to run the full mock-server scenario, and returns success or the error produced by the helper.

**Call relations**: The test runner calls this function during the test suite. Its only real job is to call `codex_returns_json_result`, which performs the setup, request checking, Codex submission, and final assertion.

*Call graph*: calls 1 internal fn (codex_returns_json_result).


##### `codex_returns_json_result_for_gpt5_codex`  (lines 39–41)

```
async fn codex_returns_json_result_for_gpt5_codex() -> anyhow::Result<()>
```

**Purpose**: This is another asynchronous test entry point that reuses the same JSON-result check. Despite its name, it currently passes the same `gpt-5.4` model string into the shared helper.

**Data flow**: The function creates no server or Codex instance itself. It supplies a model string to `codex_returns_json_result`, then returns whatever success or failure that helper reports.

**Call relations**: The test runner calls this function as a separate test case. It delegates all meaningful work to `codex_returns_json_result`, so both public test functions exercise the same behavior through the same path.

*Call graph*: calls 1 internal fn (codex_returns_json_result).


##### `codex_returns_json_result`  (lines 43–122)

```
async fn codex_returns_json_result(model: String) -> anyhow::Result<()>
```

**Purpose**: This helper contains the full test scenario for JSON-formatted final output. It verifies both sides of the feature: Codex sends the requested JSON schema to the model API, and Codex later returns the model's JSON message unchanged enough to parse and inspect.

**Data flow**: It receives a model name. First it skips the test if network-dependent tests are not allowed, starts a mock server, and prepares a fake streaming model response containing JSON text. It builds a matcher that reads each outgoing request body and checks that the `text.format` field contains the exact strict JSON schema expected by the test. After mounting that mock response, it creates a test Codex instance, prepares permission and environment settings, and submits a user message with `final_output_json_schema` set. Finally, it waits for an agent message event, parses the message text as JSON, checks the `explanation` and `final_answer` fields, and returns success. If the expected agent message never appears in the right form, it returns an error.

**Call relations**: This helper is called by both test entry functions. Inside the scenario it relies on the response-test utilities to start the mock server, build a server-sent event stream, and mount a one-time response that only matches the expected request. It uses the Codex test builder to create a controlled Codex instance, sends an `Op::UserInput` operation into Codex, and then uses the event-waiting helper to observe Codex's reply before making the final assertions.

*Call graph*: calls 6 internal fn (mount_sse_once_match, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); called by 2 (codex_returns_json_result_for_gpt5, codex_returns_json_result_for_gpt5_codex); 7 external calls (default, bail!, assert_eq!, wait_for_event, from_str, skip_if_no_network!, vec!).


### `core/tests/suite/web_search.rs`

`test` · `test run`

These tests protect the rules that decide whether web search is “cached” or “live.” Cached search means the model may use already-available web information, while live search means it may reach out to the external web. That difference matters for safety and privacy: a read-only session should not silently gain live internet access.

Each test starts a fake model server instead of calling the real service. The fake server records the JSON request Codex sends and replies with a short simulated stream of events. The test then submits a user turn to a test Codex conversation, reads the recorded request, finds the web search tool inside its tools list, and checks the fields that were sent.

The file covers several important cases. It verifies that explicitly choosing cached search sets `external_web_access` to `false`. It checks that the newer `web_search_mode` setting wins over older feature flags. It confirms that cached behavior still appears when related feature flags are disabled. It also tests that changing the permission profile between turns changes whether search is cached or live. Finally, it writes a temporary `config.toml` file and confirms that detailed web search options, such as allowed domains and approximate user location, are forwarded into the model request.

#### Function details

##### `find_web_search_tool`  (lines 15–22)

```
fn find_web_search_tool(body: &Value) -> &Value
```

**Purpose**: This helper finds the web search tool inside a JSON request body. It keeps the tests focused on the behavior they care about instead of repeating the same JSON lookup code each time.

**Data flow**: It receives a JSON value representing the full outgoing request. It looks inside the `tools` array, searches for the entry whose `type` is `web_search`, and returns that JSON object. If the request is missing the tools list or the web search tool, it stops the test with a clear failure message.

**Call relations**: All the test functions call this helper after they have submitted a turn and retrieved the request recorded by the mock server. It is the small bridge between the full request body and the specific web search settings each test wants to assert.

*Call graph*: called by 5 (web_search_mode_cached_sets_external_web_access_false, web_search_mode_defaults_to_cached_when_features_disabled, web_search_mode_takes_precedence_over_legacy_flags, web_search_mode_updates_between_turns_with_permission_profile, web_search_tool_config_from_config_toml_is_forwarded_to_request).


##### `web_search_mode_cached_sets_external_web_access_false`  (lines 25–60)

```
async fn web_search_mode_cached_sets_external_web_access_false()
```

**Purpose**: This test proves that when web search mode is explicitly set to cached, Codex tells the model not to use live external web access. It guards against a cached setting accidentally becoming a live internet request.

**Data flow**: The test starts by skipping itself if the environment has no network support for the test setup. It creates a mock server with one fake streamed response, builds a test Codex conversation using model `gpt-5.4`, and sets `web_search_mode` to `Cached`. It submits a read-only user turn, reads the single outgoing request captured by the mock server, finds the web search tool, and checks that `external_web_access` is `false`.

**Call relations**: This test uses the mock-response helpers to stand in for the model service, uses `test_codex` to create a controlled Codex instance, and then calls `find_web_search_tool` to inspect the captured request. Its final assertion is the main safety check for the cached mode.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, find_web_search_tool, read_only); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `web_search_mode_takes_precedence_over_legacy_flags`  (lines 63–102)

```
async fn web_search_mode_takes_precedence_over_legacy_flags()
```

**Purpose**: This test checks that the newer `web_search_mode` setting overrides older web search feature flags. Without this, two settings could disagree and Codex might choose the less safe live behavior by mistake.

**Data flow**: The test creates a mock server and a test Codex conversation. In the configuration, it enables the older `WebSearchRequest` feature, which suggests live web search, but also sets `web_search_mode` to `Cached`. After submitting a read-only turn, it inspects the captured request and confirms that the web search tool still has `external_web_access` set to `false`.

**Call relations**: Like the other request-shape tests, it relies on the fake server to capture what Codex sends. It then uses `find_web_search_tool` to focus on the web search tool. The important story here is precedence: the test sets up conflicting signals and verifies that the modern mode setting is the one handed off to the request.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, find_web_search_tool, read_only); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `web_search_mode_defaults_to_cached_when_features_disabled`  (lines 105–148)

```
async fn web_search_mode_defaults_to_cached_when_features_disabled()
```

**Purpose**: This test confirms that cached web search is still the default behavior even when older web search feature flags are disabled. It protects the fallback behavior used when feature flags do not explicitly enable either path.

**Data flow**: The test builds a Codex conversation against a mock server. It sets `web_search_mode` to `Cached`, then disables both the cached and request-style web search feature flags. It submits a read-only turn, reads the JSON request sent to the fake server, extracts the web search tool, and checks that `external_web_access` is `false`.

**Call relations**: The test uses the same mock server and request inspection pattern as the surrounding tests. It calls `find_web_search_tool` after the request is recorded, then asserts that Codex’s default web search choice remains cached despite the disabled legacy feature flags.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, find_web_search_tool, read_only); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `web_search_mode_updates_between_turns_with_permission_profile`  (lines 151–218)

```
async fn web_search_mode_updates_between_turns_with_permission_profile()
```

**Purpose**: This test makes sure Codex recalculates web search access for each user turn based on that turn’s permission profile. It matters because a conversation can move from safer read-only behavior to a more permissive mode, and the outgoing requests need to reflect that change.

**Data flow**: The test prepares a mock server that can answer two model requests. It builds a Codex conversation with cached web search mode and disables the older web search feature flags. It submits one turn with a read-only permission profile, then a second turn with the disabled permission profile used here to represent full, unrestricted access. It reads both captured requests, finds the web search tool in each, and verifies that the first request has `external_web_access` as `false` while the second has it as `true`.

**Call relations**: This test uses a sequence of fake streamed responses because it expects two outgoing requests. After each turn has gone through Codex, it uses `find_web_search_tool` on each recorded body. The test shows that permission information is not fixed once at conversation startup; it is applied again when each turn is submitted.

*Call graph*: calls 5 internal fn (mount_sse_sequence, start_mock_server, test_codex, find_web_search_tool, read_only); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `web_search_tool_config_from_config_toml_is_forwarded_to_request`  (lines 221–276)

```
async fn web_search_tool_config_from_config_toml_is_forwarded_to_request()
```

**Purpose**: This test checks that detailed web search settings written in `config.toml` are copied into the request sent to the model. It ensures user configuration, such as allowed domains and location hints, is not ignored.

**Data flow**: The test creates a temporary Codex home directory and writes a `config.toml` file into it. That file asks for live web search and sets tool options: high search context size, an allowed domain, and an approximate location. The test builds Codex using that temporary home, submits a turn with a permissive profile, reads the captured request, finds the web search tool, and compares the entire tool JSON object to the expected structure.

**Call relations**: This test combines disk-backed configuration with the usual mock-server request capture. The temporary config file feeds into `test_codex` during setup, Codex turns it into tool settings during the submitted turn, and `find_web_search_tool` lets the test verify that those settings were forwarded exactly into the outgoing request.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, find_web_search_tool); 6 external calls (new, assert_eq!, skip_if_no_network!, write, new, vec!).


### Remote metadata and runtime selection
These suites verify how remote model metadata influences runtime capabilities, selector behavior, and specialized review-model overrides.

### `core/tests/suite/remote_models.rs`

`test` · `test execution`

Codex has a built-in list of models, but it can also ask a server for a fresher model catalog. This test file checks that the remote catalog behaves like a trustworthy add-on, not like a source of surprises. Think of the built-in models as a printed menu, and the remote models as today’s specials board: new items may appear, existing items may be updated, but the restaurant still needs a safe default if the board is empty or slow.

The tests start a fake HTTP server, publish model metadata through it, then build either a models manager or a full test Codex session. They check that remote model entries are merged with bundled ones, sorted by priority, hidden from the picker when requested, and used for details such as shell-tool style, reasoning settings, context-window size, and truncation limits. A context window is the amount of conversation the model can consider at once; several tests make sure user overrides cannot exceed the model’s advertised maximum.

The file also checks failure behavior. If the remote model request is too slow, Codex should fall back to a bundled default instead of hanging. Helper functions at the bottom create realistic test model records and wait for asynchronous refreshes to finish.

#### Function details

##### `remote_models_get_model_info_uses_longest_matching_prefix`  (lines 57–116)

```
async fn remote_models_get_model_info_uses_longest_matching_prefix() -> Result<()>
```

**Purpose**: This test makes sure that when a requested model name is longer than any exact catalog entry, Codex uses the most specific matching prefix. This matters because variants such as `gpt-5.3-codex-test` should inherit settings from `gpt-5.3-codex`, not from the more generic `gpt-5.3`.

**Data flow**: It creates two fake remote model records with similar prefixes, points a models manager at a mock server, refreshes the model list, and asks for metadata about a longer requested slug. The expected result is a model info object whose slug stays as requested but whose instructions come from the longest matching remote prefix.

**Call relations**: The test uses `test_remote_model_with_policy` to build the fake catalog records, `mount_models_once` to serve them, and the test support helpers to create an authenticated models manager. It then exercises the real `list_models` and `get_model_info` path that production code would use.

*Call graph*: calls 6 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, test_remote_model_with_policy, create_dummy_chatgpt_auth_for_testing, bytes); 9 external calls (start, new, assert_eq!, built_in_model_providers, load_default_config_for_test, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_config_context_window_override_clamps_to_max_context_window`  (lines 122–183)

```
async fn remote_models_config_context_window_override_clamps_to_max_context_window() -> Result<()>
```

**Purpose**: This test checks that a very large user-configured context window is reduced to the remote model’s advertised maximum. Without this, Codex could ask a model to accept more conversation than it supports.

**Data flow**: It serves a model whose normal context window is 273,000 and maximum is 400,000, then configures Codex to request 1,000,000. After submitting a user message, it watches the turn-start event and confirms the runtime value became 400,000.

**Call relations**: The test builds its fake model with `test_remote_model`, serves it with `mount_models_once`, serves a simple streamed response with `mount_sse_once`, and drives a real test Codex session through `test_codex`. It listens for the event emitted when a turn begins.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_once, sse, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, skip_if_sandbox!, unreachable!, vec!).


##### `remote_models_config_override_above_max_uses_max_context_window`  (lines 189–250)

```
async fn remote_models_config_override_above_max_uses_max_context_window() -> Result<()>
```

**Purpose**: This test covers the same safety rule with a smaller but still too-large override. It proves that any configured context window above the model’s maximum is capped at that maximum.

**Data flow**: It provides remote metadata with a 400,000 maximum context window, configures Codex to request 500,000, submits a user message, and reads the resulting turn-start event. The output is confirmation that Codex used 400,000, not the oversized configured value.

**Call relations**: Like the other runtime context-window tests, it combines a mock model catalog, a mock streamed model response, and a real `test_codex` session. It relies on the normal event stream to verify what setting reached the turn.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_once, sse, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, skip_if_sandbox!, unreachable!, vec!).


##### `remote_models_use_context_window_when_config_override_is_absent`  (lines 256–316)

```
async fn remote_models_use_context_window_when_config_override_is_absent() -> Result<()>
```

**Purpose**: This test makes sure Codex uses the model’s normal context window when the user has not configured an override. The maximum is only a ceiling, not the default size.

**Data flow**: It serves remote metadata with a default context window of 273,000 and a maximum of 400,000. Codex is configured with the model name only, then a turn is submitted; the observed turn-start event reports 273,000.

**Call relations**: The test uses `test_remote_model`, `mount_models_once`, `mount_sse_once`, and `test_codex` to run the same path a real user turn would take. It verifies that the context-window calculation distinguishes default metadata from override clamping.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_once, sse, test_codex, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, skip_if_sandbox!, unreachable!, vec!).


##### `remote_models_long_model_slug_is_sent_with_custom_reasoning`  (lines 319–398)

```
async fn remote_models_long_model_slug_is_sent_with_custom_reasoning() -> Result<()>
```

**Purpose**: This test checks that Codex sends the exact requested long model name to the API while still borrowing reasoning defaults from a matching remote model prefix. Reasoning settings describe how much internal problem-solving effort the model should use and whether to summarize that reasoning.

**Data flow**: It serves metadata for `gpt-5.3-codex` with a custom reasoning effort called `max` and detailed reasoning summaries. Codex requests `gpt-5.3-codex-test`, sends one user message, and the captured API request is inspected to confirm the model field is the long slug and the reasoning fields are `max` and `detailed`.

**Call relations**: The test builds the model with `test_remote_model_with_policy`, uses `mount_models_once` for catalog data and `mount_sse_once` for the turn response, then drives Codex with `test_codex`. It checks the outgoing request recorded by the mock server.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_once, sse, test_codex, test_remote_model_with_policy, create_dummy_chatgpt_auth_for_testing, bytes); 8 external calls (default, start, assert_eq!, wait_for_event, Custom, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `namespaced_model_slug_uses_catalog_metadata_without_fallback_warning`  (lines 401–450)

```
async fn namespaced_model_slug_uses_catalog_metadata_without_fallback_warning() -> Result<()>
```

**Purpose**: This test checks that a model name with a namespace, such as `custom/gpt-5.2-codex`, can use catalog metadata without triggering a warning that Codex had to guess. A namespace is the part before the slash, often used to group custom or provider-specific models.

**Data flow**: It starts a mock server, runs a test Codex session with a namespaced model slug, submits a message, and watches all events until the turn ends. It counts fallback-metadata warnings and confirms there were none, while also confirming the outgoing request used the exact namespaced slug.

**Call relations**: This test uses `test_codex` and `mount_sse_once` rather than building a custom model manager directly. It verifies behavior through the same warnings and request body a user-facing run would produce.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 7 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_remote_model_uses_unified_exec`  (lines 453–607)

```
async fn remote_models_remote_model_uses_unified_exec() -> Result<()>
```

**Purpose**: This test proves that a remote model can tell Codex which shell tool format to use, specifically the unified exec tool. The shell tool is how the model asks Codex to run commands; using the wrong format would break tool calls.

**Data flow**: It serves a remote model whose shell type is `UnifiedExec`, waits until that model appears in the model manager, switches the thread to it, and submits a prompt. The mock model then emits an `exec_command` tool call, and the test confirms the resulting command event says it came from unified exec startup.

**Call relations**: This is one of the fuller integration tests in the file. It uses `wait_for_model_available` to wait for catalog refresh, `submit_thread_settings` to switch models, `turn_permission_fields` and `local_selections` to allow local command execution, and `mount_sse_sequence` to simulate the model’s two-step tool-call conversation.

*Call graph*: calls 9 internal fn (mount_models_once, mount_sse_sequence, local_selections, test_codex, turn_permission_fields, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 12 external calls (Limited, default, builder, new, assert_eq!, submit_thread_settings, wait_for_event, wait_for_event_match, json!, skip_if_no_network! (+2 more)).


##### `remote_models_truncation_policy_without_override_preserves_remote`  (lines 610–653)

```
async fn remote_models_truncation_policy_without_override_preserves_remote() -> Result<()>
```

**Purpose**: This test checks that Codex keeps a remote model’s truncation policy when the user has not set a local override. A truncation policy is the rule for shortening large content before sending it to the model.

**Data flow**: It serves a remote model with a byte limit of 12,000, builds Codex without a tool-output limit override, waits for the model to appear, and reads the model info back. The resulting metadata still contains the 12,000-byte truncation policy.

**Call relations**: The test uses `test_remote_model_with_policy` to create the model, `mount_models_once` to provide it, and `wait_for_model_available` to wait for the asynchronous refresh. It then asks the real models manager for the final model info.

*Call graph*: calls 6 internal fn (mount_models_once, test_codex, test_remote_model_with_policy, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes); 6 external calls (Limited, builder, assert_eq!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_truncation_policy_with_tool_output_override`  (lines 656–700)

```
async fn remote_models_truncation_policy_with_tool_output_override() -> Result<()>
```

**Purpose**: This test checks that a user-configured tool-output token limit overrides the remote model’s truncation policy. Tool output can be large, so Codex needs a clear rule for how much to keep.

**Data flow**: It serves a remote model with a 10,000-byte truncation limit, configures Codex with a tool output token limit of 50, waits for the model, and reads back the final metadata. The final truncation policy becomes 200 bytes, showing the local override was applied.

**Call relations**: The test follows the same model-manager path as the no-override truncation test, but changes the Codex configuration before building the session. It uses `wait_for_model_available` before checking `get_model_info`.

*Call graph*: calls 6 internal fn (mount_models_once, test_codex, test_remote_model_with_policy, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes); 6 external calls (Limited, builder, assert_eq!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_apply_remote_base_instructions`  (lines 703–834)

```
async fn remote_models_apply_remote_base_instructions() -> Result<()>
```

**Purpose**: This test checks how instructions are chosen when switching to a remote model. Base instructions are the system-level guidance sent to the model before the user’s message.

**Data flow**: It serves a remote model with custom base instructions, switches a running Codex thread to that remote model, submits a message, then inspects the captured request body. The request’s instructions are compared with the built-in base model information for `gpt-5.2`.

**Call relations**: The test uses `wait_for_model_available` to wait for the remote model, then uses `submit_thread_settings`, `turn_permission_fields`, and `local_selections` to run a real turn. It relies on the mock streamed response and captured HTTP request to see what instructions Codex actually sent.

*Call graph*: calls 10 internal fn (mount_models_once, mount_sse_once, sse, local_selections, test_codex, turn_permission_fields, wait_for_model_available, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 10 external calls (Limited, default, builder, new, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_do_not_append_removed_builtin_presets`  (lines 837–892)

```
async fn remote_models_do_not_append_removed_builtin_presets() -> Result<()>
```

**Purpose**: This test makes sure the merged model list does not accidentally re-add old built-in presets that the remote catalog no longer wants to show. It also checks that exactly one model remains marked as the default.

**Data flow**: It serves one remote model, builds a models manager against the mock server, refreshes the list, and compares the remote entry to the expected preset form. It then checks that one visible model is default and that the remote catalog was requested only once.

**Call relations**: The test uses `test_remote_model` to create the remote entry and the lower-level `models_manager_with_provider` helper to exercise model-list merging directly. It verifies the result of `list_models` rather than running a Codex turn.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, test_remote_model, create_dummy_chatgpt_auth_for_testing); 9 external calls (start, new, assert!, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_merge_adds_new_high_priority_first`  (lines 895–940)

```
async fn remote_models_merge_adds_new_high_priority_first() -> Result<()>
```

**Purpose**: This test verifies that a new remote model with very high priority appears at the front of the available model list. Priority is the ordering hint used to decide what models users see first.

**Data flow**: It serves a remote model with a very low numeric priority value, refreshes the model list, and checks the first entry. The output should be a list whose first model is the remote `remote-top` entry.

**Call relations**: The test uses `test_remote_model`, `mount_models_once`, and a test models manager. It focuses on the merge-and-sort behavior inside `list_models`.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (start, new, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_merge_replaces_overlapping_model`  (lines 943–994)

```
async fn remote_models_merge_replaces_overlapping_model() -> Result<()>
```

**Purpose**: This test checks that if a remote model has the same slug as a bundled model, the remote version replaces the bundled details. This lets the service update display names and descriptions without shipping a new binary.

**Data flow**: It finds a bundled model slug, serves a remote model with that same slug but changed display text, refreshes the list, and searches for the overlapping entry. The resulting entry contains the remote display name and description.

**Call relations**: The test calls `bundled_model_slug` to pick a real bundled slug, then uses `test_remote_model` and `mount_models_once` to create the override. It exercises the real model-list merge through the test models manager.

*Call graph*: calls 6 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, bundled_model_slug, test_remote_model, create_dummy_chatgpt_auth_for_testing); 8 external calls (start, new, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_models_merge_preserves_bundled_models_on_empty_response`  (lines 997–1027)

```
async fn remote_models_merge_preserves_bundled_models_on_empty_response() -> Result<()>
```

**Purpose**: This test ensures Codex does not lose its built-in models if the remote catalog returns an empty list. That fallback is important because users still need a usable model menu.

**Data flow**: It serves an empty remote model response, refreshes the model list, and checks that a known bundled model slug is still present. The merged result keeps bundled models even though the remote response had none.

**Call relations**: The test uses `bundled_model_slug` to identify a bundled entry and `models_manager_with_provider` to run the real refresh path. It confirms that remote data augments the bundled list rather than replacing it wholesale.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, bundled_model_slug, create_dummy_chatgpt_auth_for_testing); 8 external calls (start, new, new, assert!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!).


##### `remote_models_request_times_out_after_5s`  (lines 1030–1095)

```
async fn remote_models_request_times_out_after_5s() -> Result<()>
```

**Purpose**: This test checks that a slow remote model catalog request times out after about five seconds and Codex still returns a bundled default model. This prevents startup or model selection from hanging on a slow server.

**Data flow**: It serves a remote model response delayed by six seconds, then asks the models manager for the default model with a seven-second outer timeout. The call returns before the delayed response arrives, takes roughly five seconds, and returns the bundled default slug.

**Call relations**: The test uses `mount_models_once_with_delay` to simulate a slow server and `bundled_default_model_slug` to know the correct fallback. It exercises `get_default_model`, the path used when Codex needs a model choice despite refresh problems.

*Call graph*: calls 6 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once_with_delay, bundled_default_model_slug, test_remote_model, create_dummy_chatgpt_auth_for_testing); 12 external calls (from_secs, now, start, new, assert!, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox! (+2 more)).


##### `remote_models_hide_picker_only_models`  (lines 1098–1149)

```
async fn remote_models_hide_picker_only_models() -> Result<()>
```

**Purpose**: This test verifies that remote models marked hidden are not shown in the user-facing picker and are not selected as the default. Hidden models can still exist for internal or explicit use.

**Data flow**: It serves a remote model whose visibility is `Hide`, asks for the default model, then lists all models. The default remains the bundled default, and the hidden remote model is present but has `show_in_picker` set to false.

**Call relations**: The test uses `test_remote_model`, `mount_models_once`, and a test models manager. It checks both default selection and picker visibility after `list_models` refreshes remote data.

*Call graph*: calls 5 internal fn (auth_manager_from_auth, models_manager_with_provider, mount_models_once, test_remote_model, create_dummy_chatgpt_auth_for_testing); 9 external calls (start, new, assert!, assert_eq!, built_in_model_providers, format!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `wait_for_model_available`  (lines 1151–1165)

```
async fn wait_for_model_available(manager: &SharedModelsManager, slug: &str) -> ModelPreset
```

**Purpose**: This helper waits briefly for a remote model to show up in the shared models manager. It is needed because model refresh can happen asynchronously, so a test may need to poll before making assertions.

**Data flow**: It receives a shared models manager and a model slug. It repeatedly asks for the model list, looks for a matching slug, returns the matching preset when found, and panics if two seconds pass without success.

**Call relations**: The longer integration tests call this helper after starting Codex or mounting a remote catalog. It hands back a `ModelPreset` so those tests can confirm the model is available before switching to it or inspecting its metadata.

*Call graph*: called by 4 (remote_models_apply_remote_base_instructions, remote_models_remote_model_uses_unified_exec, remote_models_truncation_policy_with_tool_output_override, remote_models_truncation_policy_without_override_preserves_remote); 6 external calls (from_millis, from_secs, now, list_models, panic!, sleep).


##### `bundled_model_slug`  (lines 1167–1175)

```
fn bundled_model_slug() -> String
```

**Purpose**: This helper returns the slug of the first model in the bundled `models.json` data. Tests use it when they need a real built-in model to compare with or override.

**Data flow**: It loads the bundled model response, checks that parsing succeeded and at least one model exists, then clones and returns the first model’s slug. It does not change any external state.

**Call relations**: The merge tests call this helper when they need a known bundled model slug. It depends on the same bundled model data that production code ships with.

*Call graph*: called by 2 (remote_models_merge_preserves_bundled_models_on_empty_response, remote_models_merge_replaces_overlapping_model); 1 external calls (bundled_models_response).


##### `bundled_default_model_slug`  (lines 1177–1184)

```
fn bundled_default_model_slug() -> String
```

**Purpose**: This helper returns the slug of the bundled model marked as the default. It gives timeout tests a stable expected fallback value.

**Data flow**: It reads all bundled model presets from test support, finds the one marked default, and returns its model slug. If no default exists, the helper fails the test.

**Call relations**: The slow-request test calls this helper before checking that Codex fell back correctly. It ties the assertion to the actual bundled presets instead of hard-coding a model name.

*Call graph*: calls 1 internal fn (all_model_presets); called by 1 (remote_models_request_times_out_after_5s).


##### `test_remote_model`  (lines 1186–1193)

```
fn test_remote_model(slug: &str, visibility: ModelVisibility, priority: i32) -> ModelInfo
```

**Purpose**: This helper creates a standard fake remote model for tests. It saves each test from repeating a long model metadata record when only the slug, visibility, or priority matters.

**Data flow**: It receives a slug, visibility setting, and priority, then calls `test_remote_model_with_policy` with a default 10,000-byte truncation policy. The output is a complete `ModelInfo` ready to be served by the mock `/models` endpoint.

**Call relations**: Many tests call this helper to create simple remote catalog entries. It delegates the detailed record construction to `test_remote_model_with_policy`.

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

**Purpose**: This helper builds a complete remote model metadata record with a caller-specified truncation policy. It gives tests a realistic model object while still letting them customize the few fields under test.

**Data flow**: It takes a slug, visibility, priority, and truncation policy, then fills in all required `ModelInfo` fields with safe test defaults such as medium reasoning, shell-command tooling, default input modalities, and a context window. The result is a full `ModelInfo` value.

**Call relations**: Tests call this directly when they need custom truncation or prefix behavior, and `test_remote_model` calls it for the common case. The resulting objects are passed to `mount_models_once` so the mock server can act like a real remote model catalog.

*Call graph*: calls 1 internal fn (default_input_modalities); called by 5 (remote_models_get_model_info_uses_longest_matching_prefix, remote_models_long_model_slug_is_sent_with_custom_reasoning, remote_models_truncation_policy_with_tool_output_override, remote_models_truncation_policy_without_override_preserves_remote, test_remote_model); 4 external calls (default, new, format!, vec!).


### `core/tests/suite/model_runtime_selectors.rs`

`test` · `test run`

This is a test file. It checks an important promise: when the server says a model should use a certain runtime style, Codex must respect that, even if local feature flags say something different. A feature flag is a switch in configuration that turns behavior on or off. The remote model metadata can also carry switches, such as “use code-mode tools” or “use multi-agent version 2.” These tests confirm that the remote model’s own settings win where they are supposed to.

The file builds small fake model records, starts a mock server, and has Codex talk to that server as if it were the real API. The mock server returns a controlled model list and a short fake streaming response. After Codex sends a request, the tests inspect the JSON body of that request and look at the tool names included. This is like checking a packing list before a trip: the test does not need the trip to happen for real; it only needs to see which tools Codex packed.

The tests cover two main areas. First, they verify tool-mode selection, especially whether code-mode tools appear or disappear correctly. Second, they verify multi-agent selection, including the case where the user changes the model before the first turn. Without these tests, Codex could silently send the wrong tools to a model, causing models to receive tools they cannot use or miss tools they require.

#### Function details

##### `remote_model`  (lines 40–46)

```
fn remote_model(slug: &str) -> ModelInfo
```

**Purpose**: Creates a simple remote model description for a given model name, with the visibility set so it appears in model lists. Tests use it as a clean starting point before adding special settings like tool mode or multi-agent version.

**Data flow**: It takes a model slug, which is the model’s string identifier. It asks the shared model-info helper to build the normal details for that slug, then adjusts the result so the model is listed and is not marked as using fallback metadata. It returns a ModelInfo object ready to be served by the mock model-list endpoint.

**Call relations**: The test cases call this helper whenever they need a fake remote model. It relies on model_info_from_slug for the baseline model details, then hands the finished model record to the mock server setup used by the tests.

*Call graph*: calls 1 internal fn (model_info_from_slug); called by 3 (remote_multi_agent_selector_overrides_feature_flags, remote_multi_agent_selector_uses_model_selected_before_first_turn, remote_tool_mode_selector_overrides_feature_flags).


##### `tool_names`  (lines 48–63)

```
fn tool_names(body: &Value) -> Vec<String>
```

**Purpose**: Pulls the names of tools out of a JSON request body so the tests can check what Codex sent to the model service. It understands both tool fields that use "name" and ones that use "type".

**Data flow**: It receives a JSON value, looks for its "tools" array, and walks through each tool entry. For each entry, it reads either the "name" field or, if that is missing, the "type" field. It returns a plain list of strings; if there are no tools, it returns an empty list.

**Call relations**: The test cases call this after a mock request has been captured. It is the bridge between the large JSON request body and the simple assertions that ask, for example, whether "send_message" or code-mode tool names were included.

*Call graph*: called by 2 (remote_multi_agent_selector_overrides_feature_flags, remote_tool_mode_selector_overrides_feature_flags); 1 external calls (get).


##### `wait_for_model_available`  (lines 65–82)

```
async fn wait_for_model_available(manager: &SharedModelsManager, slug: &str) -> ModelPreset
```

**Purpose**: Waits briefly until the models manager reports that a specific remote model is available. This prevents the tests from racing ahead before Codex has finished refreshing its model list.

**Data flow**: It receives the shared models manager and the model slug to look for. It repeatedly asks for the online model list, searches for a matching model, and returns that model as soon as it appears. If the model does not appear within about two seconds, it stops the test with a clear timeout failure.

**Call relations**: response_body_for_remote_model calls this after starting Codex and before submitting user input. It makes the setup reliable by ensuring that the model metadata from the mock server has actually reached Codex before the request under test is sent.

*Call graph*: called by 1 (response_body_for_remote_model); 6 external calls (from_millis, from_secs, now, list_models, panic!, sleep).


##### `response_body_for_remote_model`  (lines 84–142)

```
async fn response_body_for_remote_model(
    remote_model: ModelInfo,
    configure: impl FnOnce(&mut Config) + Send + 'static,
) -> Result<Value>
```

**Purpose**: Runs a compact end-to-end test setup for one remote model and returns the JSON body that Codex sent to the fake response endpoint. Other tests use it to avoid repeating the same mock-server and Codex setup steps.

**Data flow**: It receives a remote model description and a configuration-editing function. It starts a mock server, mounts a fake model-list response containing that model, and mounts a fake streaming response. Then it builds a test Codex instance with dummy authentication and the requested config changes. After confirming the model is available, it selects that model, sends a simple user message, waits for the turn to finish, and returns the captured request body as JSON.

**Call relations**: The tool-mode and multi-agent override tests call this helper to create the same basic scenario with different model metadata. Inside, it hands off to mock-response helpers, the test Codex builder, wait_for_model_available, submit_thread_settings, and wait_for_event so the test can focus only on the final request body.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_once, sse, start_mock_server, test_codex, wait_for_model_available, create_dummy_chatgpt_auth_for_testing); called by 2 (remote_multi_agent_selector_overrides_feature_flags, remote_tool_mode_selector_overrides_feature_flags); 5 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, vec!).


##### `remote_tool_mode_selector_overrides_feature_flags`  (lines 145–184)

```
async fn remote_tool_mode_selector_overrides_feature_flags() -> Result<()>
```

**Purpose**: Checks that a model’s remote tool-mode setting has priority over local feature flags. In plain terms, if the model listing says which tool style to use, Codex should follow that instruction even when local switches point another way.

**Data flow**: It first creates a model marked for direct tool mode while locally enabling code-mode-only behavior, then inspects the sent request and verifies code-mode tools are absent. It then creates a model marked for code-mode-only use, including text and image input support, sends another request, and verifies the exact expected set of tools is present.

**Call relations**: This is a test entry point run by the Tokio async test framework. It uses remote_model to make model records, response_body_for_remote_model to run Codex against a mock server, and tool_names to turn the captured JSON into a simple list that assertions can check.

*Call graph*: calls 3 internal fn (remote_model, response_body_for_remote_model, tool_names); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `remote_multi_agent_selector_overrides_feature_flags`  (lines 187–222)

```
async fn remote_multi_agent_selector_overrides_feature_flags() -> Result<()>
```

**Purpose**: Checks that a model’s remote multi-agent setting controls whether multi-agent tools are available, even if local feature flags disagree. Multi-agent here means Codex can coordinate child agents or worker threads through special tools.

**Data flow**: It first creates a model whose metadata asks for multi-agent version 2 while local config disables that feature, then verifies the request still includes the version 2 messaging tool. Next it creates a model whose metadata disables multi-agent while local config enables it, then verifies none of the multi-agent tool names are sent.

**Call relations**: This async test uses remote_model to prepare different remote model records, response_body_for_remote_model to exercise Codex with those records, and tool_names to inspect the outgoing request. Its assertions prove that remote model metadata wins over conflicting local feature switches.

*Call graph*: calls 3 internal fn (remote_model, response_body_for_remote_model, tool_names); 2 external calls (assert!, skip_if_no_network!).


##### `remote_multi_agent_selector_uses_model_selected_before_first_turn`  (lines 225–307)

```
async fn remote_multi_agent_selector_uses_model_selected_before_first_turn() -> Result<()>
```

**Purpose**: Checks that if the user changes models before sending the first message, Codex uses the newly selected model’s multi-agent setting for that first request. This protects against a subtle bug where startup defaults could be used too early.

**Data flow**: It starts a mock server with two models: an initial root model marked for one multi-agent version and a selected child model marked for another. It builds Codex with the root model configured, then changes thread settings to the child model before submitting any user input. After the first turn finishes, it checks that Codex recorded the child model’s multi-agent version and that the outgoing request included the expected version 2 tool.

**Call relations**: This is a fuller async test that performs its own mock-server setup instead of using response_body_for_remote_model, because it needs two models and a model switch before the first turn. It still uses remote_model for model records, mock-response helpers for fake API behavior, the test Codex builder for setup, and tool_names to inspect the captured request.

*Call graph*: calls 6 internal fn (mount_models_once, mount_sse_once, sse, test_codex, remote_model, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!, start).


### `core/tests/suite/auto_review.rs`

`test` · `test run`

This is an integration-style test for a safety feature. In Codex, the main model may ask to do something risky, such as change files or request wider permissions. When strict automatic review is enabled, a separate “reviewer” model, sometimes called Guardian in the test, judges whether the planned action should be allowed. This file checks that when a remote model listing says “use this other model for auto review,” Codex really follows that instruction.

The test builds a fake model server and a fake stream of model responses. The parent model first asks for network permission, then asks to apply a patch. The fake reviewer model then returns a low-risk, allow decision. Finally the parent model says it is done. The test configures Codex with permission approval features turned on, selects the remote parent model, grants the requested permission for the current turn, and waits for the run to finish.

The important final check looks at the recorded HTTP request for the reviewer call. It confirms that the request was sent with the catalog-provided review model name. Without this test, a regression could silently send strict safety reviews to the wrong model, weakening or changing the approval behavior.

#### Function details

##### `remote_model_override_uses_catalog_model_for_strict_auto_review`  (lines 44–215)

```
async fn remote_model_override_uses_catalog_model_for_strict_auto_review() -> Result<()>
```

**Purpose**: This test proves that strict auto review uses the reviewer model named in the remote model catalog. It simulates a full Codex turn where the assistant requests permissions, applies a patch, and triggers a Guardian-style review.

**Data flow**: The test starts with a fake HTTP server, a parent model name, and a reviewer model name. It publishes a fake model catalog entry that links the parent model to the reviewer model, then prepares fake server-sent events, which are streamed model responses. It builds a test Codex instance, loads the remote model information, selects the parent model, submits user input, receives a permission request, replies with a strict auto-review approval setting, and waits for completion. At the end, it inspects the captured request sent for the patch review and checks that its model field is the reviewer model, not the parent model.

**Call relations**: The async test runner starts this function as the whole scenario. It relies on support helpers to mount the fake model catalog, mount the fake response stream, create a test Codex instance, choose local environment settings, and translate a read-only permission profile into the fields Codex expects. It also uses the helper in this file to create the catalog model entry with the auto-review override. The final assertion ties the whole flow together by checking the outgoing review request recorded by the fake server.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_sequence, local_selections, test_codex, turn_permission_fields, create_dummy_chatgpt_auth_for_testing, read_only); 10 external calls (default, start, assert_eq!, submit_thread_settings, wait_for_event, json!, panic!, skip_if_no_network!, skip_if_sandbox!, vec!).


##### `remote_model_with_auto_review_override`  (lines 217–261)

```
fn remote_model_with_auto_review_override(slug: &str, review_model: &str) -> ModelInfo
```

**Purpose**: This helper builds a realistic model-catalog record for a remote model that declares a separate auto-review model. It keeps the main test focused on behavior instead of a long block of model metadata.

**Data flow**: It receives two strings: the model slug for the parent model and the model name that should be used for review. It fills out a ModelInfo record with ordinary supported settings, such as display name, reasoning level, shell tool support, patch tool support, and context-window limits. The key output is a complete ModelInfo value whose auto_review_model_override field contains the reviewer model name.

**Call relations**: The main test calls this helper before mounting the fake model catalog. The returned model record is handed to the mock server, so later Codex can load it through the normal model-manager path. That lets the test verify the real lookup behavior instead of manually injecting only the one field it cares about.

*Call graph*: calls 2 internal fn (bytes, default_input_modalities); 4 external calls (default, new, format!, vec!).


### Model switching behavior
This suite exercises how request history and outbound fields are rewritten when the active model or service tier changes during execution.

### `core/tests/suite/model_switching.rs`

`test` · `test run`

A conversation with an AI model is not just one request. Codex keeps history, settings, model capabilities, generated images, token counts, and service tier choices across many turns. This test file checks that all of that stays correct when the selected model changes.

The tests build a fake Codex session and a fake server that pretends to be the model API. That lets the test inspect the exact HTTP request Codex would have sent, without relying on a real model response. Think of it like a rehearsal stage: Codex acts normally, but the audience can pause and inspect every prop.

The file covers several important cases. It checks that switching models adds a special developer message explaining the switch, but that a simultaneous personality change does not add an extra personality message. It checks that service tiers, such as fast or flex processing, are sent only when the chosen model supports them. It also checks image history carefully: uploaded images are removed when moving to a text-only model, generated-image records are preserved in a safer form, and rollback removes image history from reverted turns. Finally, it verifies that switching to a smaller model updates the reported context window, which is the amount of conversation the model can consider.

#### Function details

##### `read_only_user_turn`  (lines 44–68)

```
fn read_only_user_turn(test: &TestCodex, items: Vec<UserInput>, model: String) -> Op
```

**Purpose**: Builds a standard test user turn that cannot modify files or run risky actions. The tests use it so each request has predictable safety settings while varying only the model or input content.

**Data flow**: It takes the test session, a list of user inputs such as text or images, and the model name to use. It reads the test working directory and current reasoning setting, creates read-only permission fields, then returns an operation that represents a user message with local environment selection, no approval prompts, and the requested model.

**Call relations**: Many model-switching tests call this helper before submitting work to Codex. It hides the repeated setup details so those tests can focus on whether model changes, image handling, rollback, and token-window updates behave correctly.

*Call graph*: calls 4 internal fn (cwd_path, local_selections, turn_permission_fields, read_only); called by 7 (generated_image_is_replayed_for_image_capable_models, model_and_personality_change_only_appends_model_instructions, model_change_appends_model_instructions_developer_message, model_change_from_generated_image_to_text_preserves_prior_generated_image_call, model_change_from_image_to_text_strips_prior_image_content, model_switch_to_smaller_model_updates_token_context_window, thread_rollback_after_generated_image_drops_entire_image_turn_history); 1 external calls (default).


##### `image_generation_artifact_path`  (lines 70–92)

```
fn image_generation_artifact_path(codex_home: &Path, session_id: &str, call_id: &str) -> PathBuf
```

**Purpose**: Predicts where Codex should save a generated image during a test. This lets tests clean up the file and check that model-visible history mentions the correct saved location.

**Data flow**: It takes the Codex home folder, a session id, and an image generation call id. It replaces unsafe filename characters with underscores, then builds a path under generated_images/session_id/call_id.png. The result is a filesystem path; it does not itself create the file.

**Call relations**: The generated-image tests call this before or after turns that produce images. Those tests use the path to remove leftover files and to verify that Codex records generated-image history in the expected place.

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

**Purpose**: Creates a realistic model description for tests without making each test fill in every catalog field by hand. A model description tells Codex what a model is called and what features it supports.

**Data flow**: It takes a model slug, display name, description, and supported input types. It returns a complete ModelInfo value with sensible defaults for reasoning, visibility, shell support, context size, truncation, and other metadata, while leaving the caller free to adjust fields such as service tiers.

**Call relations**: Tests that need fake model catalog entries call this helper, then sometimes edit the returned model to add flex service support, a default service tier, or text-only image capability. The fake catalog is then mounted on the mock server or placed into test configuration.

*Call graph*: calls 1 internal fn (bytes); called by 8 (default_service_tier_override_is_omitted_from_http_turn, flex_service_tier_is_applied_to_http_turn, generated_image_is_replayed_for_image_capable_models, model_change_from_generated_image_to_text_preserves_prior_generated_image_call, model_change_from_image_to_text_strips_prior_image_content, null_service_tier_override_is_omitted_from_http_turn_with_catalog_default, thread_rollback_after_generated_image_drops_entire_image_turn_history, unsupported_service_tier_is_omitted_from_http_turn); 3 external calls (default, new, vec!).


##### `model_change_appends_model_instructions_developer_message`  (lines 146–208)

```
async fn model_change_appends_model_instructions_developer_message() -> Result<()>
```

**Purpose**: Checks that when the conversation switches from one model to another, Codex tells the new model that a switch happened. This matters because the new model may need extra context about why instructions have changed.

**Data flow**: The test starts a fake server, prepares two completed model responses, and runs one turn on the original model. It then submits updated thread settings with a new model, runs another turn, and inspects the second outgoing request. The expected output is that the second request contains a developer message with a model-switch marker and explanatory text.

**Call relations**: This test uses read_only_user_turn to create both user turns and submit_thread_settings to change the model between them. The mock response collector receives the outgoing API requests, and the test asserts that the second request includes the model-switch instructions.

*Call graph*: calls 3 internal fn (mount_sse_sequence, test_codex, read_only_user_turn); 8 external calls (default, start, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `model_and_personality_change_only_appends_model_instructions`  (lines 211–285)

```
async fn model_and_personality_change_only_appends_model_instructions() -> Result<()>
```

**Purpose**: Checks that when model and personality change at the same time, Codex adds only the model-switch message. This prevents the new turn from being cluttered with a separate personality update message when the model switch already resets the instruction context.

**Data flow**: The test enables the personality feature, runs an initial turn, then submits new thread settings containing both a new model and a new personality. After a second turn, it reads the outgoing request and checks for a model-switch developer message while also checking that no personality-spec message was added.

**Call relations**: It follows the same two-turn pattern as the model-switch test, using read_only_user_turn for consistent input and submit_thread_settings for the settings change. The fake server records the requests so the test can inspect the developer messages sent to the model.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, test_codex, read_only_user_turn); 7 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, skip_if_no_network!, vec!).


##### `service_tier_change_is_applied_on_next_http_turn`  (lines 288–315)

```
async fn service_tier_change_is_applied_on_next_http_turn() -> Result<()>
```

**Purpose**: Checks that a requested service tier affects the next model request and does not accidentally stick around afterward. A service tier is a request option such as faster or priority processing.

**Data flow**: The test starts a fake server with two model responses, sends one turn requesting the fast tier, then sends another turn with no tier override. It inspects both request bodies: the first should include the priority service tier value, and the second should omit the service_tier field.

**Call relations**: This test uses the TestCodex helper that submits turns with service-tier overrides. The mock server captures the two HTTP requests, and the assertions confirm that tier choice is per-turn rather than silently reused.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `flex_service_tier_is_applied_to_http_turn`  (lines 318–353)

```
async fn flex_service_tier_is_applied_to_http_turn() -> Result<()>
```

**Purpose**: Checks that Codex sends the flex service tier when the selected model says it supports flex. This protects the link between model catalog capabilities and the actual request sent to the API.

**Data flow**: The test creates a fake model that lists flex as an available service tier, installs that model into the test catalog, and submits a turn requesting flex. It then reads the single outgoing request body and expects service_tier to be flex.

**Call relations**: It relies on test_model_info to build the fake model, then customizes its service tier list. The mounted mock response receives one request, which the test inspects to prove the supported tier was passed through.

*Call graph*: calls 6 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, test_model_info, default_input_modalities); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `unsupported_service_tier_is_omitted_from_http_turn`  (lines 356–386)

```
async fn unsupported_service_tier_is_omitted_from_http_turn() -> Result<()>
```

**Purpose**: Checks that Codex does not send a service tier that the chosen model does not advertise. This avoids asking the API for an option that may be invalid for that model.

**Data flow**: The test creates a fake model with no service tiers, configures Codex to use it, and submits a turn asking for the fast tier. When it inspects the outgoing request body, the service_tier field should be absent.

**Call relations**: It uses test_model_info to create the no-tier model and the fake server to capture the request. The test confirms that Codex filters the user's tier override through the model's known capabilities before sending HTTP.

*Call graph*: calls 6 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, test_model_info, default_input_modalities); 2 external calls (assert_eq!, skip_if_no_network!).


##### `default_service_tier_override_is_omitted_from_http_turn`  (lines 389–425)

```
async fn default_service_tier_override_is_omitted_from_http_turn() -> Result<()>
```

**Purpose**: Checks that explicitly choosing the default service tier does not add an unnecessary service_tier field to the request. The default can be left implicit, which keeps requests cleaner and avoids overriding catalog behavior.

**Data flow**: The test creates a fake model whose catalog says fast is supported and is also the default. It submits a turn using the special default-tier request value. The outgoing request body is expected to have no service_tier field.

**Call relations**: The test starts from test_model_info, edits the model to include a supported and default fast tier, and then sends one turn through TestCodex. The mock request shows whether Codex correctly translated an explicit default choice into no HTTP override.

*Call graph*: calls 6 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, test_model_info, default_input_modalities); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `null_service_tier_override_is_omitted_from_http_turn_with_catalog_default`  (lines 428–464)

```
async fn null_service_tier_override_is_omitted_from_http_turn_with_catalog_default() -> Result<()>
```

**Purpose**: Checks that sending no service-tier override stays as no HTTP service_tier field, even when the model catalog has a default tier. This confirms that Codex does not unnecessarily copy catalog defaults into each request.

**Data flow**: The test creates a fake model with fast as its catalog default, submits a normal turn with no tier override, and inspects the outgoing request body. The result should be that service_tier is missing rather than filled in with fast.

**Call relations**: Like the default-tier test, it builds a catalog model with test_model_info and custom tier metadata. The captured mock request proves that Codex leaves default behavior to the backend instead of spelling it out in the HTTP body.

*Call graph*: calls 6 internal fn (mount_sse_once, sse_completed, start_mock_server, test_codex, test_model_info, default_input_modalities); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `model_change_from_image_to_text_strips_prior_image_content`  (lines 467–564)

```
async fn model_change_from_image_to_text_strips_prior_image_content() -> Result<()>
```

**Purpose**: Checks that when a conversation moves from an image-capable model to a text-only model, earlier uploaded images are not resent. Instead, Codex inserts a plain text note saying the image content was omitted.

**Data flow**: The test creates two fake models: one that can accept images and one that only accepts text. It sends a first turn containing an image and text to the image model, then sends a second text turn using the text-only model. It confirms the first request included the image, while the second request contains no image URLs and includes the omission placeholder text.

**Call relations**: This test uses test_model_info to describe the two model capabilities and read_only_user_turn to submit both turns. The model catalog is loaded through the mock server, and the captured requests show whether Codex rewrites old conversation history safely for the new model.

*Call graph*: calls 7 internal fn (mount_models_once, mount_sse_sequence, test_codex, read_only_user_turn, test_model_info, create_dummy_chatgpt_auth_for_testing, default_input_modalities); 6 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `generated_image_is_replayed_for_image_capable_models`  (lines 567–670)

```
async fn generated_image_is_replayed_for_image_capable_models() -> Result<()>
```

**Purpose**: Checks that if a model generated an image earlier, a later turn with an image-capable model can see that generated-image history again. This keeps the conversation coherent when the user asks about an image the assistant just made.

**Data flow**: The test mounts a model that supports images and a fake response stream containing an image generation call with base64 image data. After the first turn completes, it sends a second turn asking about the generated image. The second request should include one image_generation_call with the original id and payload, and a developer note showing where the image was saved.

**Call relations**: It uses image_generation_artifact_path to locate the saved file, test_model_info for the fake model, and read_only_user_turn for both turns. The mock server's recorded second request proves that generated-image history is replayed for models that can use it.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, image_generation_artifact_path, read_only_user_turn, test_model_info, create_dummy_chatgpt_auth_for_testing, default_input_modalities); 7 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, remove_file, vec!).


##### `model_change_from_generated_image_to_text_preserves_prior_generated_image_call`  (lines 673–794)

```
async fn model_change_from_generated_image_to_text_preserves_prior_generated_image_call() -> Result<()>
```

**Purpose**: Checks that generated-image history is still represented after switching to a text-only model, but without sending raw image bytes. This preserves the fact that an image was generated while avoiding unsupported image input.

**Data flow**: The test starts on an image-capable model, receives a fake generated image, then sends the next turn using a text-only model. In the second request, it expects no user image URLs, one preserved image_generation_call with the same id, an empty image result payload, no uploaded-image omission placeholder, and a developer note about the saved image path.

**Call relations**: It combines the generated-image setup with a model capability switch. test_model_info defines the image and text-only models, image_generation_artifact_path tracks the saved artifact, and read_only_user_turn submits the turns that let the mock server capture the rewritten history.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, image_generation_artifact_path, read_only_user_turn, test_model_info, create_dummy_chatgpt_auth_for_testing, default_input_modalities); 7 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, remove_file, vec!).


##### `thread_rollback_after_generated_image_drops_entire_image_turn_history`  (lines 797–905)

```
async fn thread_rollback_after_generated_image_drops_entire_image_turn_history() -> Result<()>
```

**Purpose**: Checks that rolling back a turn removes not only the user's text, but also the generated image and its saved-path note from future model requests. Rollback should make the conversation behave as if that turn never happened.

**Data flow**: The test sends a turn that produces a generated image, waits for completion, then submits a rollback operation for one turn. It sends a new turn afterward and inspects the second model request. The expected result is that the rolled-back prompt, generated-image call, and generated-image save note are all absent.

**Call relations**: This test uses the same generated-image helpers as the replay tests, then adds an explicit ThreadRollback operation. The later request captured by the mock server verifies that rollback removes the whole turn's visible history, not just part of it.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, test_codex, image_generation_artifact_path, read_only_user_turn, test_model_info, create_dummy_chatgpt_auth_for_testing, default_input_modalities); 7 external calls (start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, remove_file, vec!).


##### `model_switch_to_smaller_model_updates_token_context_window`  (lines 908–1114)

```
async fn model_switch_to_smaller_model_updates_token_context_window() -> Result<()>
```

**Purpose**: Checks that switching from a large-context model to a smaller-context model updates the context-window information reported in events. The context window is the amount of conversation the model can consider, so showing the old larger limit would mislead users and other parts of the system.

**Data flow**: The test defines two fake models with different context sizes and loads them into the mock model catalog. It runs a turn on the larger model and checks that token-count events report the large effective window. Then it changes thread settings to the smaller model, runs another turn, and checks that both the turn-started event and later token-count event report the smaller effective window.

**Call relations**: This is the broadest test in the file. It uses the mock model catalog, read_only_user_turn for submissions, submit_thread_settings for the model switch, and event waiting to observe Codex's internal progress messages. The fake response streams provide token counts so the test can confirm the context-window value travels through the runtime events.

*Call graph*: calls 8 internal fn (mount_models_once, mount_sse_sequence, start_mock_server, test_codex, read_only_user_turn, create_dummy_chatgpt_auth_for_testing, bytes, default_input_modalities); 10 external calls (default, new, assert!, assert_eq!, assert_ne!, submit_thread_settings, wait_for_event, skip_if_no_network!, unreachable!, vec!).
