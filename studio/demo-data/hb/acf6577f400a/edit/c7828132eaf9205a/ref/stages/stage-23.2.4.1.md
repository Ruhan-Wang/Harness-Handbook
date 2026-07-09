# Transport, streaming, and provider protocol suites  `stage-23.2.4.1`

This stage checks the system’s “front door” to model providers: the network requests, streaming connections, and the small rules that make those conversations reliable. It sits in the main work path, where a user turn is turned into an API call and the streamed reply comes back.

Several tests focus on building the outgoing request correctly. client.rs, responses_headers.rs, responses_api_proxy_headers.rs, request_compression.rs, responses_lite.rs, and compact_remote.rs verify headers, metadata, compression, subagent identity, lite-mode differences, and remote compaction that trims or replaces history. models_etag_responses.rs checks the model list refresh rule when the server says its catalog changed.

Another group covers live streaming transports. agent_websocket.rs and client_websockets.rs test WebSocket behavior, including prewarming, reused connections, request shape, and events. realtime_conversation.rs extends that to realtime sessions over WebSocket and WebRTC. turn_state.rs checks that per-turn transport state stays consistent within one turn and resets for the next.

The remaining files test failure recovery at the boundary: retries for incomplete SSE streams, releasing the session after a stream error, falling back from WebSocket to plain HTTP, and clean handling of quota or safety-triggered server responses.

## Files in this stage

### HTTP request shaping
These tests cover how standard Responses API HTTP requests are constructed, annotated, compressed, and refreshed at the API boundary.

### `core/tests/suite/client.rs`

`test` · `request construction, streaming, resume replay, and error/event handling during client integration tests`

This file is a broad request-shaping and client-behavior suite. It defines small helpers for constructing deterministic Responses metadata, extracting message text from request JSON, asserting client metadata fields, writing synthetic `auth.json`, and creating a `ProviderAuthCommandFixture` whose script prints successive bearer tokens from a file. Many tests build a `test_codex` harness, submit a turn, wait for `TurnComplete`, and then inspect the captured request body sent to the mock Responses endpoint.

Coverage includes omission of per-item metadata for non-OpenAI providers, correct session/thread/install IDs and auth headers, preference of API keys over ChatGPT tokens when config says so, inclusion of AGENTS user instructions, developer instructions, apps guidance, environment context, and skill summaries or aliased skill roots under context-budget pressure. Resume tests verify that rollout history is replayed correctly, including legacy js_repl image-output shapes and modern image tool outputs with `detail: original`. Other tests validate reasoning effort, reasoning summary, responses-lite context settings, verbosity, collaboration-mode overrides, Azure Responses `store` plus preserved item IDs/call IDs, provider auth command refresh after 401, rate-limit snapshots in `TokenCount`, usage-limit and context-window error handling, incomplete-response content-filter errors, provider query/header/env-var overrides, and deduplication of streamed assistant deltas versus final assistant messages across turns. The file mixes high-level `CodexThread` tests with lower-level `ModelClient::stream` tests when direct control over provider configuration or prompt items is needed.

#### Function details

##### `test_turn_responses_metadata`  (lines 98–113)

```
fn test_turn_responses_metadata(
    _client: &ModelClient,
    thread_id: ThreadId,
) -> codex_core::CodexResponsesMetadata
```

**Purpose**: Builds deterministic Responses metadata for tests using fixed installation and window IDs. This makes outbound client metadata assertions stable across runs.

**Data flow**: Accepts a `ModelClient` reference and `ThreadId`, converts the thread ID to string, and calls `test_responses_metadata` with fixed installation ID, session/thread IDs derived from the thread ID, no turn ID, fixed window ID, `SessionSource::Exec`, no parent thread, and request kind `Turn`, returning the resulting metadata struct.

**Call relations**: Lower-level client-stream tests call this helper when they bypass the higher-level harness and need to supply explicit metadata into `ModelClient::stream`.

*Call graph*: called by 2 (azure_responses_request_includes_store_and_reasoning_ids, send_provider_auth_request); 2 external calls (responses_metadata, to_string).


##### `assert_message_role`  (lines 116–118)

```
fn assert_message_role(request_body: &serde_json::Value, role: &str)
```

**Purpose**: Asserts that a JSON request item has the expected `role` string. It is a tiny helper used in instruction-message tests.

**Data flow**: Reads `request_body["role"]` as a string, unwraps it, and compares it to the expected role with `assert_eq!`.

**Call relations**: Instruction-injection tests call this helper when checking the ordering and roles of developer and user contextual messages.

*Call graph*: called by 2 (includes_developer_instructions_message_in_request, includes_user_instructions_message_in_request); 1 external calls (assert_eq!).


##### `message_input_texts`  (lines 121–128)

```
fn message_input_texts(item: &serde_json::Value) -> Vec<&str>
```

**Purpose**: Extracts text strings from a message item’s `content` array in raw JSON request bodies. It ignores non-text entries.

**Data flow**: Reads `item["content"]` as an array, iterates entries, pulls `entry["text"]` string values when present, and returns them as `Vec<&str>`.

**Call relations**: Used by several tests that inspect raw request JSON rather than the higher-level `ResponsesRequest` helper.

*Call graph*: called by 3 (includes_developer_instructions_message_in_request, includes_user_instructions_message_in_request, resume_includes_initial_messages_and_sends_prior_items).


##### `message_input_text_contains`  (lines 130–135)

```
fn message_input_text_contains(request: &ResponsesRequest, role: &str, needle: &str) -> bool
```

**Purpose**: Checks whether any message text for a given role in a captured request contains a substring. It simplifies assertions about injected guidance text.

**Data flow**: Calls `request.message_input_texts(role)`, iterates the returned strings, and returns `true` if any contain `needle`.

**Call relations**: Apps-guidance and environment-context tests use this helper to assert presence or absence of specific snippets in developer or user messages.

*Call graph*: calls 1 internal fn (message_input_texts).


##### `assert_codex_client_metadata`  (lines 137–169)

```
fn assert_codex_client_metadata(
    request_body: &serde_json::Value,
    installation_id: &str,
    session_id: &str,
    thread_id: &str,
)
```

**Purpose**: Validates that a request body’s `client_metadata` and embedded `x-codex-turn-metadata` JSON agree on installation, session, thread, turn, and window identifiers. It checks both top-level and nested metadata consistency.

**Data flow**: Reads `request_body["client_metadata"]`, asserts `x-codex-installation-id`, `session_id`, and `thread_id` match the expected strings, parses `x-codex-turn-metadata` as JSON, asserts its installation/session/thread IDs match, and finally asserts `client_metadata.turn_id` equals the nested `turn_id` and `x-codex-window-id` equals the nested `window_id`.

**Call relations**: Header/auth tests call this helper after capturing a request body to verify the metadata emitted by the client layer.

*Call graph*: called by 2 (chatgpt_auth_sends_correct_request, includes_session_id_thread_id_and_model_headers_in_request); 1 external calls (assert_eq!).


##### `non_openai_responses_requests_omit_item_turn_metadata`  (lines 172–220)

```
async fn non_openai_responses_requests_omit_item_turn_metadata()
```

**Purpose**: Verifies that Responses requests sent through a non-OpenAI provider omit per-input-item metadata fields. This prevents OpenAI-specific item metadata from leaking to generic providers.

**Data flow**: Starts a mock server, mounts a one-shot completion SSE, clones the built-in OpenAI provider and mutates its name/base URL/websocket support to represent a generic Responses provider, builds a harness using that provider, submits a simple user turn, waits for completion, reads the captured request body, extracts the `input` array, and asserts every item lacks a `metadata` field.

**Call relations**: This top-level test focuses on request shaping for non-OpenAI providers and uses the standard harness path rather than low-level `ModelClient` streaming.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 7 external calls (default, start, assert!, built_in_model_providers, wait_for_event, format!, vec!).


##### `write_auth_json`  (lines 225–272)

```
fn write_auth_json(
    codex_home: &TempDir,
    openai_api_key: Option<&str>,
    chatgpt_plan_type: &str,
    access_token: &str,
    account_id: Option<&str>,
) -> String
```

**Purpose**: Writes a synthetic `auth.json` file containing optional API key plus ChatGPT-style tokens and returns the fake JWT used as `id_token`. It lets tests simulate mixed credential stores without real auth flows.

**Data flow**: Builds a JWT-like string by base64url-encoding a fixed header and payload containing email, plan type, and account ID, then constructs a `tokens` JSON object with `id_token`, `access_token`, `refresh_token`, and optional `account_id`. It wraps that in an `auth_json` object with optional `OPENAI_API_KEY` and `last_refresh`, pretty-serializes it, writes it to `codex_home/auth.json`, and returns the fake JWT string.

**Call relations**: The API-key-preference test uses this helper to seed a credential store containing both API-key and ChatGPT credentials.

*Call graph*: called by 1 (prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens); 6 external calls (path, format!, json!, to_string_pretty, to_vec, write).


##### `ProviderAuthCommandFixture::new`  (lines 281–345)

```
fn new(tokens: &[&str]) -> std::io::Result<Self>
```

**Purpose**: Creates a temporary command fixture that prints successive bearer tokens from a file, one per invocation. It supports testing command-backed provider auth and refresh behavior.

**Data flow**: Creates a temp directory and writes `tokens.txt` containing the supplied tokens one per line. On Unix it writes an executable `print-token.sh` that prints the first line and shifts the file; on Windows it writes `print-token.cmd` with equivalent behavior and returns `cmd.exe` plus `/D /Q /C .\print-token.cmd` args. It stores the tempdir, command string, and args in the fixture and returns it.

**Call relations**: Provider-auth tests construct this fixture before passing its `auth()` output into the lower-level request helper.

*Call graph*: called by 2 (provider_auth_command_refreshes_after_401, provider_auth_command_supplies_bearer_token); 7 external calls (new, new, metadata, set_permissions, write, tempdir, vec!).


##### `ProviderAuthCommandFixture::auth`  (lines 347–357)

```
fn auth(&self) -> ModelProviderAuthInfo
```

**Purpose**: Converts the fixture into a `ModelProviderAuthInfo` suitable for provider configuration. It points the auth command at the fixture tempdir and uses a stable timeout.

**Data flow**: Builds and returns `ModelProviderAuthInfo` with the fixture’s command and args, `timeout_ms` set via `non_zero_u64(5000)`, `refresh_interval_ms` 60000, and `cwd` set to the fixture tempdir converted to `AbsolutePathBuf`.

**Call relations**: Provider-auth tests call this after constructing the fixture, then pass the resulting auth config into `send_provider_auth_request`.

*Call graph*: calls 2 internal fn (non_zero_u64, try_from); 1 external calls (path).


##### `non_zero_u64`  (lines 360–362)

```
fn non_zero_u64(value: u64) -> NonZeroU64
```

**Purpose**: Creates a `NonZeroU64` from a plain integer and panics if zero is supplied. It is a tiny helper for auth-command timeout configuration.

**Data flow**: Calls `NonZeroU64::new(value)` and unwraps the result.

**Call relations**: Only `ProviderAuthCommandFixture::auth` uses this helper.

*Call graph*: called by 1 (auth); 1 external calls (new).


##### `resume_includes_initial_messages_and_sends_prior_items`  (lines 365–571)

```
async fn resume_includes_initial_messages_and_sends_prior_items()
```

**Purpose**: Verifies resume behavior for a rollout containing prior user, system, and assistant messages. It checks that `initial_messages` stays empty while prior response items are replayed into the next request in the correct order relative to contextual messages and the new user input.

**Data flow**: Writes a synthetic JSONL session file containing `session_meta`, a prior user message, a prior system message, and a prior assistant message with `phase: commentary`; starts a mock server and mounts a one-shot completion SSE; builds a resumed harness from that session file with a global `AGENTS.md`; inspects `session_configured.initial_messages` and asserts it serializes to `[]`; submits a new `hello` turn; waits for completion; then parses the captured request body’s `input` array into `(role, text)` pairs. It locates positions for the prior user message, prior assistant message, permissions developer message, AGENTS user instructions, environment context, and new user message, asserts the assistant item preserved `phase: commentary`, and checks the ordering `prior user < prior assistant < permissions < user instructions < environment < new user`.

**Call relations**: This resume test inspects both session configuration and outbound request replay, validating how persisted rollout items are merged with freshly generated contextual messages.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, test_codex, message_input_texts); 15 external calls (new, default, start, new, new_v4, new, assert!, assert_eq!, wait_for_event, json! (+5 more)).


##### `resume_replays_legacy_js_repl_image_rollout_shapes`  (lines 574–714)

```
async fn resume_replays_legacy_js_repl_image_rollout_shapes()
```

**Purpose**: Ensures resume remains compatible with an older rollout representation where js_repl image results were stored as a custom-tool-call output plus a separate user `input_image` message. Both legacy items must be replayed before the new user turn.

**Data flow**: Constructs a vector of `RolloutLine`s containing `SessionMeta`, a legacy `CustomToolCall`, a string-valued `CustomToolCallOutput`, and a standalone user `Message` with `ContentItem::InputImage`; writes them to a temp session file; starts a mock server with a one-shot completion SSE; resumes a harness from that file; submits `after resume`; then inspects the captured request `input` array. It finds the replayed `custom_tool_call_output` for `legacy-js-call`, asserts its `output` is the legacy stdout string, finds the replayed user image message containing the expected data URL, finds the new user message, and asserts both legacy items appear before the new user message.

**Call relations**: This targeted resume-compatibility test protects against regressions in rollout replay for historical js_repl image-output shapes.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 9 external calls (new, start, new, assert!, assert_eq!, skip_if_no_network!, create, vec!, writeln!).


##### `resume_replays_image_tool_outputs_with_detail`  (lines 717–842)

```
async fn resume_replays_image_tool_outputs_with_detail()
```

**Purpose**: Verifies that resumed function-call and custom-tool image outputs are replayed with structured `input_image` content including `detail: original`. It covers the modern structured image-output representation.

**Data flow**: Builds a rollout containing `SessionMeta`, a `FunctionCall` plus `FunctionCallOutput` whose payload is `FunctionCallOutputPayload::from_content_items([InputImage { ... detail: Original }])`, and a `CustomToolCall` plus matching `CustomToolCallOutput` with the same image payload; writes it to a temp session file; starts a mock server with a one-shot completion SSE; resumes a harness; submits `after resume`; then extracts the replayed function-call output and custom-tool output from the captured request and asserts each `output` equals a JSON array containing one `input_image` object with the expected URL and `detail: "original"`.

**Call relations**: This resume test complements the legacy-shape test by validating current structured image-output replay.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 8 external calls (new, start, new, assert_eq!, skip_if_no_network!, create, vec!, writeln!).


##### `includes_session_id_thread_id_and_model_headers_in_request`  (lines 845–911)

```
async fn includes_session_id_thread_id_and_model_headers_in_request()
```

**Purpose**: Checks that a normal request includes session/thread headers, authorization, originator, prompt-cache key, and consistent client metadata. It validates the standard authenticated request envelope.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness with API-key auth, captures expected session and thread IDs from `session_configured`, submits a turn, waits for completion, then inspects the captured request. It asserts path `/v1/responses`, reads `session-id`, `thread-id`, `authorization`, and `originator` headers, reads the installation ID from the codex home file, asserts the headers match expected values, checks `prompt_cache_key` equals the thread ID string, and delegates nested metadata checks to `assert_codex_client_metadata`.

**Call relations**: This top-level request-envelope test uses the standard harness path and the metadata assertion helper.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, test_codex, assert_codex_client_metadata, from_api_key); 7 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, read_to_string, vec!).


##### `provider_auth_command_supplies_bearer_token`  (lines 914–927)

```
async fn provider_auth_command_supplies_bearer_token()
```

**Purpose**: Verifies that a provider configured with command-backed auth uses the command’s output as a bearer token on the Responses request. It checks the simplest successful auth-command path.

**Data flow**: Starts a mock server, mounts a one-shot SSE response that only matches when `authorization: Bearer command-token` is present, constructs a `ProviderAuthCommandFixture` with one token, and calls `send_provider_auth_request(server, auth_fixture.auth()).await`.

**Call relations**: This test delegates the actual low-level request issuance to `send_provider_auth_request`; the server-side matcher is what enforces the expected auth behavior.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, new, send_provider_auth_request); 4 external calls (start, skip_if_no_network!, vec!, header).


##### `provider_auth_command_refreshes_after_401`  (lines 930–959)

```
async fn provider_auth_command_refreshes_after_401()
```

**Purpose**: Checks that command-backed provider auth refreshes after a 401 by rerunning the auth command and retrying with a new bearer token. It validates the retry path at the client layer.

**Data flow**: Starts a mock server, constructs a `ProviderAuthCommandFixture` with `first-token` then `second-token`, mounts one POST `/v1/responses` expectation returning 401 for `Bearer first-token` and one returning a successful SSE stream for `Bearer second-token`, then calls `send_provider_auth_request(server, auth_fixture.auth()).await`.

**Call relations**: Like the previous test, this one relies on `send_provider_auth_request` to drive the low-level stream while wiremock expectations verify the two-step auth refresh behavior.

*Call graph*: calls 3 internal fn (sse, new, send_provider_auth_request); 8 external calls (given, start, new, skip_if_no_network!, vec!, header_regex, method, path).


##### `send_provider_auth_request`  (lines 966–1056)

```
async fn send_provider_auth_request(server: &MockServer, auth: ModelProviderAuthInfo)
```

**Purpose**: Issues one low-level streamed Responses request through a provider configured with command-backed auth and waits until the stream reaches `Completed`. It is a reusable helper for provider-auth tests.

**Data flow**: Builds a `ModelProviderInfo` using the supplied `ModelProviderAuthInfo`, creates a temp codex home and default config, swaps in the provider, resolves an offline model and model info, creates a fresh `ThreadId`, `SessionTelemetry`, and `ModelClient`, builds deterministic responses metadata via `test_turn_responses_metadata`, creates a new client session and a `Prompt` containing one user `ResponseItem::Message`, then calls `client_session.stream(...)`. It consumes the stream until it sees `Ok(ResponseEvent::Completed { .. })`, ignoring intermediate events.

**Call relations**: Both provider-auth tests delegate to this helper so they can focus on server-side expectations while this function handles low-level client setup and streaming.

*Call graph*: calls 10 internal fn (new, default, construct_model_info_offline, get_model_offline, test_turn_responses_metadata, from_auth_for_testing, from_api_key, new, new, disabled); called by 2 (provider_auth_command_refreshes_after_401, provider_auth_command_supplies_bearer_token); 5 external calls (new, new, load_default_config_for_test, format!, vec!).


##### `includes_base_instructions_override_in_request`  (lines 1059–1105)

```
async fn includes_base_instructions_override_in_request()
```

**Purpose**: Verifies that `config.base_instructions` is inserted into the outbound `instructions` field. It checks direct base-instructions override propagation.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness with API-key auth and `config.base_instructions = Some("test instructions")`, submits a turn, waits for completion, reads the captured request body, and asserts `instructions` contains `test instructions`.

**Call relations**: This top-level request-shaping test focuses on the `instructions` field rather than contextual input messages.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, test_codex, from_api_key); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `chatgpt_auth_sends_correct_request`  (lines 1108–1188)

```
async fn chatgpt_auth_sends_correct_request()
```

**Purpose**: Checks the request envelope when using ChatGPT-style auth rather than API-key auth. It verifies path, bearer token, ChatGPT account header, streaming flags, include list, and client metadata.

**Data flow**: Starts a mock server with a one-shot completion SSE, clones the built-in OpenAI provider and points its base URL at `/api/codex`, builds a harness with dummy ChatGPT auth and that provider, captures expected session/thread IDs, submits a turn, waits for completion, then inspects the captured request. It asserts path `/api/codex/responses`, `authorization: Bearer Access Token`, `originator`, `chatgpt-account-id: account_id`, session/thread headers, consistent client metadata via `assert_codex_client_metadata`, `stream == true`, and `include[0] == "reasoning.encrypted_content"`.

**Call relations**: This is the ChatGPT-auth counterpart to the API-key request-envelope test.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, test_codex, assert_codex_client_metadata, create_dummy_codex_auth); 10 external calls (default, start, assert!, assert_eq!, built_in_model_providers, wait_for_event, format!, skip_if_no_network!, read_to_string, vec!).


##### `prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens`  (lines 1191–1280)

```
async fn prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens()
```

**Purpose**: Verifies that when config prefers API-key auth, the client uses the API key even if `auth.json` also contains ChatGPT tokens that would otherwise be eligible. It tests credential-selection precedence.

**Data flow**: Starts a mock server with a successful SSE response that expects `Authorization: Bearer sk-test-key`, writes an `auth.json` containing both API key and ChatGPT tokens via `write_auth_json`, loads default config from that home and swaps in the mock provider, loads `CodexAuth` from auth storage, builds a `ThreadManager` manually with that auth manager and config, starts a thread, submits a turn, and waits for completion. The wiremock expectation enforces that the API key was used.

**Call relations**: This test bypasses `test_codex` convenience auth setup and manually constructs the thread manager so it can exercise auth-storage loading and credential preference logic.

*Call graph*: calls 7 internal fn (default, auth_manager_from_auth, new, sse, write_auth_json, default_for_tests, from_auth_storage); 18 external calls (new, default, given, start, new, new, resolve_installation_id, thread_store_from_config, empty_extension_registry, built_in_model_providers (+8 more)).


##### `includes_user_instructions_message_in_request`  (lines 1283–1360)

```
async fn includes_user_instructions_message_in_request()
```

**Purpose**: Checks that AGENTS/user instructions are injected as a contextual user message rather than merged into the top-level `instructions` field. It also verifies the surrounding permissions and environment-context messages.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness with API-key auth and a pre-build hook writing `AGENTS.md` containing `be nice`, submits a turn, waits for completion, and inspects the captured request body. It asserts `instructions` does not contain `be nice`, checks the first input item is a developer permissions message mentioning ``sandbox_mode``, checks the second input item is a user message whose texts include a `# AGENTS.md instructions` fragment containing `<INSTRUCTIONS>` and `be nice`, and also include an `<environment_context>...</environment_context>` fragment.

**Call relations**: This test uses `assert_message_role` and `message_input_texts` to validate the exact placement of injected user instructions in the request input array.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, test_codex, assert_message_role, message_input_texts, from_api_key); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `includes_apps_guidance_as_developer_message_for_chatgpt_auth`  (lines 1363–1423)

```
async fn includes_apps_guidance_as_developer_message_for_chatgpt_auth()
```

**Purpose**: Verifies that Apps/Connectors guidance is injected as a developer message when the Apps feature is enabled and ChatGPT auth is in use. It must not appear in user messages.

**Data flow**: Starts a mock server and mounts an `AppsTestServer`, builds a harness with dummy ChatGPT auth, `Feature::Apps` enabled, and `chatgpt_base_url` pointed at the apps server, submits a turn, waits for completion, then inspects the captured request via `message_input_text_contains`. It asserts the apps guidance snippet appears in a developer message and does not appear in any user message.

**Call relations**: This test focuses on auth-sensitive guidance injection and uses the apps mock server only to make the feature path realistic.

*Call graph*: calls 5 internal fn (mount, mount_sse_once, sse, test_codex, create_dummy_codex_auth); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `omits_apps_guidance_for_api_key_auth_even_when_feature_enabled`  (lines 1426–1481)

```
async fn omits_apps_guidance_for_api_key_auth_even_when_feature_enabled()
```

**Purpose**: Checks that Apps guidance is not injected when using API-key auth, even if the Apps feature is enabled and an apps base URL is configured. It validates auth-mode gating.

**Data flow**: Starts a mock server and apps server, builds a harness with API-key auth, `Feature::Apps` enabled, and `chatgpt_base_url` set, submits a turn, waits for completion, and asserts the apps guidance snippet appears in neither developer nor user messages.

**Call relations**: This is the API-key counterpart to the previous ChatGPT-auth apps-guidance test.

*Call graph*: calls 5 internal fn (mount, mount_sse_once, sse, test_codex, from_api_key); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `omits_apps_guidance_when_configured_off`  (lines 1484–1536)

```
async fn omits_apps_guidance_when_configured_off()
```

**Purpose**: Verifies that Apps guidance is suppressed when `include_apps_instructions = false`, even under ChatGPT auth with the Apps feature enabled. It checks explicit config opt-out.

**Data flow**: Starts a mock server and apps server, builds a harness with dummy ChatGPT auth, `Feature::Apps` enabled, `chatgpt_base_url` set, and `include_apps_instructions = false`, submits a turn, waits for completion, and asserts no developer message contains `<apps_instructions>`.

**Call relations**: This test complements the auth-based apps-guidance tests by covering the explicit configuration switch.

*Call graph*: calls 5 internal fn (mount, mount_sse_once, sse, test_codex, create_dummy_codex_auth); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `omits_environment_context_when_configured_off`  (lines 1539–1578)

```
async fn omits_environment_context_when_configured_off()
```

**Purpose**: Checks that no `<environment_context>` user message is injected when `include_environment_context = false`. It validates another contextual-message toggle.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness with `config.include_environment_context = false`, submits a turn, waits for completion, and asserts no user message text contains `<environment_context>`.

**Call relations**: This test isolates the environment-context injection toggle from the broader instruction-message tests.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 5 external calls (default, start, assert!, wait_for_event, vec!).


##### `skills_append_to_developer_message`  (lines 1581–1647)

```
async fn skills_append_to_developer_message()
```

**Purpose**: Verifies that discovered skills are summarized in a developer message, including the skill name, description, and normalized path to `SKILL.md`. It checks the non-aliased path form.

**Data flow**: Creates a temp codex home with `skills/demo/SKILL.md`, builds a harness rooted at that home with API-key auth, submits a turn, waits for completion, then joins all developer message texts and asserts they contain `## Skills`, `demo: build charts`, and the normalized absolute path to the skill file.

**Call relations**: This test exercises skill discovery and developer-message augmentation under normal context-budget conditions.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, test_codex, from_api_key); 11 external calls (new, default, start, new, assert!, wait_for_event, canonicalize, skip_if_no_network!, create_dir_all, write (+1 more)).


##### `skills_use_aliases_in_developer_message_under_budget_pressure`  (lines 1650–1737)

```
async fn skills_use_aliases_in_developer_message_under_budget_pressure()
```

**Purpose**: Checks that when many skills and a small context window create budget pressure, skill paths are compressed using root aliases like `r0/...` and an explanatory `### Skill roots` section is included. It validates the aliasing fallback format.

**Data flow**: Creates a temp codex home under a long shared prefix, writes 12 skill directories each with a minimal `SKILL.md`, builds a harness rooted there with API-key auth, bundled skills disabled in the config layer stack, and `model_context_window = Some(12_000)`, submits a turn, waits for completion, joins developer message texts, and asserts they contain `### Skill roots`, a root alias mapping `r0` to the normalized skill root path, a skill summary line like `- s00: d (file: r0/s00/SKILL.md)`, and explanatory alias-expansion instructions.

**Call relations**: This test is the budget-pressure counterpart to the normal skills summary test and validates the path-aliasing representation.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, test_codex, from_api_key); 13 external calls (new, default, start, new, new_in, assert!, wait_for_event, canonicalize, format!, skip_if_no_network! (+3 more)).


##### `includes_configured_effort_in_request`  (lines 1740–1785)

```
async fn includes_configured_effort_in_request() -> anyhow::Result<()>
```

**Purpose**: Verifies that an explicitly configured reasoning effort is serialized into the request body. It checks the `reasoning.effort` field directly.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a `gpt-5.4` harness with `config.model_reasoning_effort = Some(ReasoningEffort::Medium)`, submits a turn, waits for completion, reads the captured request body, and asserts `reasoning.effort == "medium"`.

**Call relations**: This is one of several request-shaping tests for reasoning configuration.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `includes_no_effort_in_request`  (lines 1788–1827)

```
async fn includes_no_effort_in_request() -> anyhow::Result<()>
```

**Purpose**: Checks the default reasoning-effort behavior when no explicit effort is configured. For the default test model, the request still carries the model-defined default effort.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a default `gpt-5.4` harness, submits a turn, waits for completion, reads the request body, and asserts `reasoning.effort == "medium"`.

**Call relations**: This test documents that the absence of explicit config does not mean omission when the model info defines a default effort.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `includes_default_reasoning_effort_in_request_when_defined_by_model_info`  (lines 1830–1870)

```
async fn includes_default_reasoning_effort_in_request_when_defined_by_model_info() -> anyhow::Result<()>
```

**Purpose**: Verifies explicitly that model-info defaults populate `reasoning.effort` when present. It overlaps with the previous test but frames the behavior in terms of model metadata.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a default `gpt-5.4` harness, submits a turn, waits for completion, reads the request body, and asserts `reasoning.effort == "medium"`.

**Call relations**: This test reinforces the model-catalog default-effort behavior from a slightly different angle.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `user_turn_collaboration_mode_overrides_model_and_effort`  (lines 1873–1930)

```
async fn user_turn_collaboration_mode_overrides_model_and_effort() -> anyhow::Result<()>
```

**Purpose**: Checks that per-turn collaboration-mode settings override the model and reasoning effort used in the outbound request. It validates turn-level settings precedence over session defaults.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a default `gpt-5.4` harness, constructs a `CollaborationMode` whose settings specify model `gpt-5.4` and `ReasoningEffort::High`, submits a raw `Op::UserInput` with explicit local environments, approval/sandbox settings from config, summary from config, and that collaboration mode, waits for completion, reads the request body, and asserts `model == "gpt-5.4"` and `reasoning.effort == "high"`.

**Call relations**: This test bypasses the simple submit helper to inject explicit per-turn collaboration settings into `ThreadSettingsOverrides`.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, local_selections, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `configured_reasoning_summary_is_sent`  (lines 1933–1983)

```
async fn configured_reasoning_summary_is_sent() -> anyhow::Result<()>
```

**Purpose**: Verifies that a configured reasoning summary mode is serialized into `reasoning.summary` and that no `reasoning.context` field is added in this case. It checks concise-summary request shaping.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness with `config.model_reasoning_summary = Some(ReasoningSummary::Concise)`, submits a turn, waits for completion, reads the request body, and asserts `reasoning.summary == "concise"` and `reasoning.context` is absent.

**Call relations**: This is the baseline reasoning-summary serialization test.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `responses_lite_sets_all_turns_context_and_disables_parallel_tool_calls`  (lines 1986–2031)

```
async fn responses_lite_sets_all_turns_context_and_disables_parallel_tool_calls() -> anyhow::Result<()>
```

**Purpose**: Checks request shaping for models marked `use_responses_lite`: they should set `reasoning.context = "all_turns"` and force `parallel_tool_calls = false` even if the model otherwise supports parallel tools.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness whose model-info override sets `use_responses_lite = true` and `supports_parallel_tool_calls = true`, submits a turn, waits for completion, reads the request body, and asserts `reasoning.context == "all_turns"` and `parallel_tool_calls == false`.

**Call relations**: This test targets a model-info-driven request-shaping branch distinct from ordinary reasoning-summary behavior.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `user_turn_explicit_reasoning_summary_overrides_model_catalog_default`  (lines 2034–2108)

```
async fn user_turn_explicit_reasoning_summary_overrides_model_catalog_default() -> anyhow::Result<()>
```

**Purpose**: Verifies that a per-turn explicit reasoning summary overrides the model catalog’s default summary. It checks precedence between turn settings and model metadata.

**Data flow**: Starts a mock server with a one-shot completion SSE, loads the bundled model catalog and mutates `gpt-5.4` to support reasoning summaries with default `Detailed`, builds a harness using that catalog, submits a raw `Op::UserInput` whose `ThreadSettingsOverrides` set `summary: Some(ReasoningSummary::Concise)` and a collaboration mode using the session model, waits for completion, reads the request body, and asserts `reasoning.summary == "concise"`.

**Call relations**: This test complements the configured-summary tests by proving turn-level summary settings beat catalog defaults.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, local_selections, test_codex); 7 external calls (default, start, bundled_models_response, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `reasoning_summary_is_omitted_when_disabled`  (lines 2111–2154)

```
async fn reasoning_summary_is_omitted_when_disabled() -> anyhow::Result<()>
```

**Purpose**: Checks that setting `model_reasoning_summary = None`/`ReasoningSummary::None` suppresses the `reasoning.summary` field entirely. It validates explicit omission behavior.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness with `config.model_reasoning_summary = Some(ReasoningSummary::None)`, submits a turn, waits for completion, reads the request body, and asserts `reasoning.summary` is absent.

**Call relations**: This is the negative counterpart to the summary-inclusion tests.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `reasoning_summary_none_overrides_model_catalog_default`  (lines 2157–2210)

```
async fn reasoning_summary_none_overrides_model_catalog_default() -> anyhow::Result<()>
```

**Purpose**: Verifies that explicitly disabling reasoning summaries overrides a model catalog default that would otherwise request a summary. It checks omission precedence over metadata defaults.

**Data flow**: Starts a mock server with a one-shot completion SSE, mutates the bundled `gpt-5.4` model catalog entry to support summaries with default `Detailed`, builds a harness with `config.model_reasoning_summary = Some(ReasoningSummary::None)` and that catalog, submits a turn, waits for completion, reads the request body, and asserts `reasoning.summary` is absent.

**Call relations**: This test is the catalog-default counterpart to the previous omission test.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 7 external calls (default, start, bundled_models_response, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `includes_default_verbosity_in_request`  (lines 2213–2252)

```
async fn includes_default_verbosity_in_request() -> anyhow::Result<()>
```

**Purpose**: Checks that the default verbosity for the test model is serialized into `text.verbosity`. It validates model-default verbosity shaping.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a default `gpt-5.4` harness, submits a turn, waits for completion, reads the request body, and asserts `text.verbosity == "low"`.

**Call relations**: This is the baseline verbosity serialization test.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `configured_verbosity_not_sent_for_models_without_support`  (lines 2255–2299)

```
async fn configured_verbosity_not_sent_for_models_without_support() -> anyhow::Result<()>
```

**Purpose**: Verifies that configured verbosity is omitted for models that do not support verbosity controls. It checks capability gating rather than config parsing.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness using model `test-no-verbosity` and `config.model_verbosity = Some(Verbosity::High)`, submits a turn, waits for completion, reads the request body, and asserts `text.verbosity` is absent.

**Call relations**: This test complements the positive verbosity tests by covering unsupported-model behavior.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `configured_verbosity_is_sent`  (lines 2302–2347)

```
async fn configured_verbosity_is_sent() -> anyhow::Result<()>
```

**Purpose**: Checks that an explicitly configured verbosity is serialized for models that support it. It validates the positive override path.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a `gpt-5.4` harness with `config.model_verbosity = Some(Verbosity::High)`, submits a turn, waits for completion, reads the request body, and asserts `text.verbosity == "high"`.

**Call relations**: This is the positive counterpart to the unsupported-model verbosity test.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `includes_developer_instructions_message_in_request`  (lines 2350–2444)

```
async fn includes_developer_instructions_message_in_request()
```

**Purpose**: Verifies that configured developer instructions are injected as a developer message while AGENTS instructions remain in a separate contextual user message. It checks the coexistence and placement of both instruction sources.

**Data flow**: Starts a mock server with a one-shot completion SSE, builds a harness with API-key auth, a pre-build hook writing `AGENTS.md` containing `be nice`, and `config.developer_instructions = Some("be useful")`, submits a turn, waits for completion, and inspects the request body. It asserts the top-level `instructions` field does not contain `be nice`, checks the first input item is a developer permissions message mentioning ``sandbox_mode``, scans all developer messages to find one containing `be useful`, then checks the second input item is a user contextual message containing the AGENTS fragment with `be nice` and an environment-context fragment.

**Call relations**: This test extends the user-instructions test by adding configured developer instructions and verifying they are kept in developer-role messages.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, test_codex, assert_message_role, message_input_texts, from_api_key); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `azure_responses_request_includes_store_and_reasoning_ids`  (lines 2447–2631)

```
async fn azure_responses_request_includes_store_and_reasoning_ids()
```

**Purpose**: Checks low-level request shaping for an Azure-style Responses provider: requests must include `store: true`, preserve item IDs and call IDs across many response-item types, and target `/openai/responses`. It validates the raw `ModelClient::stream` serialization path.

**Data flow**: Starts a mock server with a minimal created/completed SSE body, constructs a `ModelProviderInfo` named `azure` with base URL ending in `/openai`, loads default config and offline model info, creates a `ThreadId`, auth manager, session telemetry, and `ModelClient`, builds deterministic responses metadata, and constructs a `Prompt` containing eight response items: reasoning, assistant message, web search call, function call, function-call output, local shell call, custom tool call, and custom-tool output, each with IDs/call IDs. It streams the prompt until completion, then inspects the captured request and asserts path `/openai/responses`, `store == true`, `stream == true`, input length 8, and that the expected IDs/call IDs appear in the corresponding serialized input items.

**Call relations**: This test bypasses the high-level harness because it needs precise control over the prompt item sequence and provider configuration.

*Call graph*: calls 12 internal fn (new, default, auth_manager_from_auth, construct_model_info_offline, get_model_offline, mount_sse_once, test_turn_responses_metadata, from_api_key, new, from_text (+2 more)); 10 external calls (new, start, new, assert_eq!, concat!, load_default_config_for_test, format!, Exec, skip_if_no_network!, vec!).


##### `token_count_includes_rate_limits_snapshot`  (lines 2634–2765)

```
async fn token_count_includes_rate_limits_snapshot()
```

**Purpose**: Verifies that a successful streamed response with token-usage completion and rate-limit headers produces a `TokenCount` event containing both usage info and the latest rate-limit snapshot. It checks the full serialized event payload.

**Data flow**: Starts a mock server whose POST `/v1/responses` response is an SSE completion with total tokens 123 plus several `x-codex-*` rate-limit headers, builds a harness using an API-key-auth OpenAI provider pointed at that server, submits a turn, waits for a `TokenCount` event whose `info` is present, serializes that event to JSON, and asserts it exactly matches the expected nested usage and rate-limit structure. It then extracts the usage and rate-limit snapshot from the event and asserts key fields like total tokens and primary used percent/reset time, before waiting for `TurnComplete`.

**Call relations**: This event-focused test validates how transport headers and completion usage are merged into the client’s token-count event stream.

*Call graph*: calls 3 internal fn (sse, test_codex, from_api_key); 15 external calls (default, given, start, new, assert_eq!, built_in_model_providers, wait_for_event, format!, assert_eq!, to_value (+5 more)).


##### `usage_limit_error_emits_rate_limit_event`  (lines 2768–2856)

```
async fn usage_limit_error_emits_rate_limit_event() -> anyhow::Result<()>
```

**Purpose**: Checks that a 429 `usage_limit_reached` error still emits a `TokenCount` event carrying rate-limit information before surfacing an error event. It validates error-path rate-limit reporting.

**Data flow**: Starts a mock server whose POST `/v1/responses` returns 429 with several rate-limit headers and a JSON error body of type `usage_limit_reached`, builds a default harness, submits a turn, waits for a `TokenCount` event, serializes it to JSON, and asserts it contains `info: null` plus the expected rate-limit snapshot. It then waits for an `Error` event and asserts the message mentions `usage limit`.

**Call relations**: This test complements the successful rate-limit snapshot test by covering the error path where no token-usage info is available.

*Call graph*: calls 1 internal fn (test_codex); 14 external calls (default, given, start, new, assert!, wait_for_event, json!, assert_eq!, to_value, skip_if_no_network! (+4 more)).


##### `context_window_error_sets_total_tokens_to_model_window`  (lines 2859–2961)

```
async fn context_window_error_sets_total_tokens_to_model_window() -> anyhow::Result<()>
```

**Purpose**: Verifies that a context-window-exceeded error emits a `TokenCount` event whose total tokens equal the effective model context window, followed by the canonical context-window error message. It checks synthetic token accounting on this failure path.

**Data flow**: Starts a mock server with one matcher-based failed SSE response for requests containing `trigger context window` and one successful seed-turn response, builds a harness configured with model `gpt-5.4` and `model_context_window = 272_000`, submits a seed turn and waits for completion, submits the triggering turn, waits for a `TokenCount` event whose `info.total_token_usage.total_tokens` equals `info.model_context_window`, extracts the info and asserts both equal the effective 95% window, then waits for an `Error` event and asserts its message equals `CodexErr::ContextWindowExceeded.to_string()`, and finally waits for `TurnComplete`.

**Call relations**: This test targets a specific error translation path where the client synthesizes token usage from model context-window metadata.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, sse_failed, test_codex); 9 external calls (default, start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, unreachable!, vec!, body_string_contains).


##### `incomplete_response_emits_content_filter_error_message`  (lines 2964–3022)

```
async fn incomplete_response_emits_content_filter_error_message() -> anyhow::Result<()>
```

**Purpose**: Checks that a streamed `response.incomplete` event with `reason: content_filter` surfaces a specific stream-disconnected error message and does not trigger retries when retries are disabled. It validates incomplete-response handling.

**Data flow**: Starts a mock server with an SSE body containing `response.created`, a partial message item plus text delta, and a final `response.incomplete` object with `incomplete_details.reason = content_filter`, builds a harness with `stream_max_retries = Some(0)`, submits a turn, waits for an `Error` event, asserts its message equals `stream disconnected before completion: Incomplete response returned, reason: content_filter`, asserts only one request hit the mock, then waits for `TurnComplete`.

**Call relations**: This test focuses on stream termination semantics and error messaging for incomplete Responses API streams.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 7 external calls (default, start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `azure_overrides_assign_properties_used_for_responses_url`  (lines 3034–3120)

```
async fn azure_overrides_assign_properties_used_for_responses_url()
```

**Purpose**: Verifies that provider query-parameter, header, and env-key overrides are all applied when constructing a Responses request URL and headers. It uses an Azure-like `/openai/responses` endpoint with `api-version` query param.

**Data flow**: Starts a mock server, mounts a POST `/openai/responses` expectation requiring query param `api-version=2025-04-01-preview`, header `Custom-Header: Value`, and `Authorization: Bearer <PATH env var>`, builds a harness with dummy ChatGPT auth but a custom provider whose `env_key` is `PATH`, `query_params` contains the API version, and `http_headers` contains the custom header, submits a turn, and waits for completion. The wiremock expectation enforces the correct request shape.

**Call relations**: This test validates provider override plumbing at the request-construction layer; it relies on server-side expectations rather than explicit post-hoc request inspection.

*Call graph*: calls 3 internal fn (sse, test_codex, create_dummy_codex_auth); 14 external calls (default, given, start, new, wait_for_event, format!, skip_if_no_network!, from, vec!, header (+4 more)).


##### `env_var_overrides_loaded_auth`  (lines 3123–3209)

```
async fn env_var_overrides_loaded_auth()
```

**Purpose**: Checks that a provider `env_key` bearer token overrides any loaded auth credentials when constructing the request. It uses the same Azure-like request shape as the previous test.

**Data flow**: Starts a mock server, mounts the same `/openai/responses` expectation requiring the `PATH`-derived bearer token plus query/header overrides, builds a harness with dummy ChatGPT auth and a custom provider specifying `env_key = PATH`, submits a turn, and waits for completion. Success of the wiremock expectation proves the env-var token was used instead of loaded auth.

**Call relations**: This test complements the previous provider-override test by emphasizing credential precedence rather than just URL/header shaping.

*Call graph*: calls 3 internal fn (sse, test_codex, create_dummy_codex_auth); 14 external calls (default, given, start, new, wait_for_event, format!, skip_if_no_network!, from, vec!, header (+4 more)).


##### `create_dummy_codex_auth`  (lines 3211–3213)

```
fn create_dummy_codex_auth() -> CodexAuth
```

**Purpose**: Creates a canned ChatGPT-style auth object for tests that need non-API-key auth without performing real login. It is a tiny wrapper around the testing constructor.

**Data flow**: Calls `CodexAuth::create_dummy_chatgpt_auth_for_testing()` and returns the resulting `CodexAuth`.

**Call relations**: Several ChatGPT-auth tests call this helper to keep setup concise and consistent.

*Call graph*: calls 1 internal fn (create_dummy_chatgpt_auth_for_testing); called by 5 (azure_overrides_assign_properties_used_for_responses_url, chatgpt_auth_sends_correct_request, env_var_overrides_loaded_auth, includes_apps_guidance_as_developer_message_for_chatgpt_auth, omits_apps_guidance_when_configured_off).


##### `history_dedupes_streamed_and_final_messages_across_turns`  (lines 3222–3348)

```
async fn history_dedupes_streamed_and_final_messages_across_turns()
```

**Purpose**: Verifies that conversation history sent on later turns contains one copy of each assistant message even when the original turn streamed deltas and then emitted a final assistant message with the same content. It checks deduplication across multiple turns.

**Data flow**: Starts a mock server with three identical SSE responses, each streaming an empty message item, several output-text deltas forming `Hey there!\n`, then a final assistant message with the same text and completion. It builds a harness with API-key auth, submits turns `U1`, `U2`, and `U3` sequentially, waiting for completion each time, then inspects the three captured requests. After asserting there are three `/v1/responses` requests, it takes the third request’s `input` array, slices off the tail equal in length to a hard-coded expected JSON array, and asserts that tail equals the expected sequence: user `U1`, assistant `Hey there!`, user `U2`, assistant `Hey there!`, user `U3`.

**Call relations**: This top-level history test uses repeated identical streamed responses to prove the client stores only the final assistant message in replayed history rather than both deltas and final content.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, test_codex, from_api_key); 7 external calls (default, start, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


### `core/tests/responses_headers.rs`

`test` · `integration test execution around outbound Responses API requests`

The tests build real `ModelClient` or `TestCodex` fixtures against a wiremock SSE server and then inspect the captured outbound requests. Two small helpers support this: `normalize_git_remote_url` trims whitespace, trailing slashes, and an optional `.git` suffix so remote URLs can be compared robustly, and `test_turn_responses_metadata` constructs deterministic `CodexResponsesMetadata` using a fixed installation ID and a window id of `{thread_id}:0`. The first two tests create a `ModelProviderInfo` configured for `WireApi::Responses`, load a default test config, derive offline model info, create `SessionTelemetry`, and stream a trivial prompt until `ResponseEvent::Completed`; they then assert that `x-openai-subagent`, `x-codex-window-id`, and client metadata fields reflect `SessionSource::SubAgent(SubAgentSource::Review)` or `Other("my-task")`. The override test follows the same path but sets `config.model_supports_reasoning_summaries = Some(true)` and `config.model_reasoning_summary = Some(ReasoningSummary::Detailed)`, then confirms the serialized request body contains `reasoning.summary = "detailed"`. The largest test uses `test_codex()` instead of raw `ModelClient` to verify `x-codex-turn-metadata` across turns. It first captures a baseline turn, then initializes a real git repository in the test cwd, commits a file, adds an `origin` remote, and submits another turn that triggers two model requests in one turn. It asserts that both requests share the same `turn_id` and `turn_started_at_unix_ms`, that the new turn id differs from the baseline turn, and that workspace metadata includes the latest commit hash, normalized remote URL, and `has_changes = false`.

#### Function details

##### `normalize_git_remote_url`  (lines 28–34)

```
fn normalize_git_remote_url(url: &str) -> String
```

**Purpose**: Normalizes git remote URLs for comparison in assertions by removing superficial formatting differences. It specifically strips surrounding whitespace, a trailing slash, and a terminal `.git` suffix if present.

**Data flow**: Accepts `url: &str` → computes `normalized = url.trim().trim_end_matches('/')`, then removes a `.git` suffix when available and converts the result to an owned `String` → returns the normalized string without mutating external state.

**Call relations**: This helper is used only inside the git workspace metadata test to compare the captured remote URL against the expected `origin` URL without failing on equivalent formatting variants.


##### `test_turn_responses_metadata`  (lines 37–53)

```
fn test_turn_responses_metadata(
    _client: &ModelClient,
    thread_id: ThreadId,
    session_source: &SessionSource,
) -> codex_core::CodexResponsesMetadata
```

**Purpose**: Builds deterministic turn-scoped Responses metadata for tests using a fixed installation id and a synthetic window id derived from the thread id. It keeps the metadata assertions stable across runs.

**Data flow**: Accepts a `&ModelClient` (unused except for signature parity), a `ThreadId`, and a `&SessionSource` → converts the thread id to string, derives `window_id = format!("{thread_id}:0")`, and passes those values plus `TEST_INSTALLATION_ID`, `turn_id = None`, `parent_thread_id = None`, and `TestCodexResponsesRequestKind::Turn` into `core_test_support::responses_metadata` → returns `codex_core::CodexResponsesMetadata`.

**Call relations**: The three `ModelClient`-based tests call this during setup before opening a stream. It acts as a stable metadata factory so those tests can focus on header/body assertions rather than reconstructing the metadata payload inline.

*Call graph*: called by 3 (responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review); 3 external calls (responses_metadata, format!, to_string).


##### `responses_stream_includes_subagent_header_on_review`  (lines 56–184)

```
async fn responses_stream_includes_subagent_header_on_review()
```

**Purpose**: Verifies that a Responses stream initiated from the review subagent sends the correct `x-openai-subagent` header and matching Codex metadata fields. It also checks that unrelated headers like sandbox and parent-thread id are absent in this scenario.

**Data flow**: Starts a mock SSE server, mounts a request matcher requiring `x-openai-subagent: review`, constructs a `ModelProviderInfo` for the mock `/v1` endpoint, loads and adjusts test config, derives offline model and model info, creates a fresh `ThreadId`, `SessionTelemetry`, `ModelClient`, deterministic responses metadata, and a simple user `Prompt`, then streams until a `ResponseEvent::Completed` arrives → inspects the single recorded request and asserts exact header and JSON body metadata values → returns `()` via test success.

**Call relations**: The Tokio test harness invokes this directly. It delegates metadata construction to `test_turn_responses_metadata` and uses the `ModelClient` streaming path rather than `TestCodex`, making it a focused transport-level assertion for review-subagent labeling.

*Call graph*: calls 11 internal fn (new, default, construct_model_info_offline, get_model_offline, mount_sse_once_match, sse, start_mock_server, test_turn_responses_metadata, new, new (+1 more)); 10 external calls (new, new, SubAgent, assert_eq!, load_default_config_for_test, skip_if_no_network!, format!, matches!, vec!, header).


##### `responses_stream_includes_subagent_header_on_other`  (lines 187–301)

```
async fn responses_stream_includes_subagent_header_on_other()
```

**Purpose**: Checks the same subagent-header behavior as the review test, but for `SessionSource::SubAgent(SubAgentSource::Other("my-task"))`. It ensures arbitrary subagent names are propagated verbatim into the outbound header.

**Data flow**: Builds the same mock Responses setup and offline client stack as the review test, but uses `SubAgentSource::Other("my-task".to_string())` for the session source and mounts a matcher for `x-openai-subagent: my-task` → streams a trivial prompt to completion and then asserts the captured request header equals `Some("my-task")` → no persistent state is modified.

**Call relations**: This test is a sibling of the review-subagent test and is invoked directly by the harness. It reuses `test_turn_responses_metadata` and the same `ModelClient` flow to cover the alternate subagent variant.

*Call graph*: calls 11 internal fn (new, default, construct_model_info_offline, get_model_offline, mount_sse_once_match, sse, start_mock_server, test_turn_responses_metadata, new, new (+1 more)); 11 external calls (new, new, SubAgent, assert_eq!, load_default_config_for_test, skip_if_no_network!, format!, matches!, Other, vec! (+1 more)).


##### `responses_respects_model_info_overrides_from_config`  (lines 304–432)

```
async fn responses_respects_model_info_overrides_from_config()
```

**Purpose**: Ensures that config-driven model-info overrides affect the serialized Responses request body, specifically the reasoning-summary settings. It proves that enabling summaries in config causes a `reasoning` object with `summary: detailed` to be sent.

**Data flow**: Creates a mock SSE server and recorder, builds a `ModelProviderInfo`, loads default config, overrides `model`, `model_provider`, `model_supports_reasoning_summaries`, and `model_reasoning_summary`, derives auth mode from a test API key, constructs offline model info and session telemetry, creates a `ModelClient`, deterministic responses metadata, and a simple prompt, then streams until completion → reads the captured request JSON, extracts the optional `reasoning` object, and asserts it exists and contains `summary == "detailed"` → returns `()` on success.

**Call relations**: The harness runs this as a focused serialization test. Like the subagent tests, it uses `test_turn_responses_metadata` and the raw `ModelClient` stream path, but its assertions target body fields derived from config/model-info interaction rather than headers.

*Call graph*: calls 12 internal fn (new, default, auth_manager_from_auth, construct_model_info_offline, mount_sse_once, sse, start_mock_server, test_turn_responses_metadata, from_api_key, new (+2 more)); 11 external calls (new, new, SubAgent, assert!, assert_eq!, load_default_config_for_test, skip_if_no_network!, format!, matches!, Other (+1 more)).


##### `responses_stream_includes_turn_metadata_header_for_git_workspace_e2e`  (lines 435–651)

```
async fn responses_stream_includes_turn_metadata_header_for_git_workspace_e2e()
```

**Purpose**: Exercises full-turn metadata generation in `TestCodex`, including stable per-turn identifiers and git workspace details once the cwd becomes a repository. It verifies both the baseline no-git case and the richer metadata emitted after repository initialization.

**Data flow**: Starts a mock SSE server, builds a `TestCodex` fixture, submits an initial turn against a one-shot SSE response, parses the `x-codex-turn-metadata` header from that request, and records the initial `turn_id` and `turn_started_at_unix_ms`. It then creates an isolated git config file, runs a sequence of `git` commands in the fixture cwd to initialize a repo, commit `README.md`, and add an `origin` remote, capturing expected HEAD and remote URL. Next it mounts a two-request response sequence for a single turn, submits another turn, collects both recorded requests, parses each `x-codex-turn-metadata` JSON header, and asserts shared turn id/timestamp within the turn, a new turn id relative to the baseline, sandbox/thread-source values, and workspace metadata including commit hash, normalized origin URL, and `has_changes = false` → returns `()` on success.

**Call relations**: This test is invoked directly by the harness and differs from the others by using the higher-level `test_codex` orchestration instead of a raw `ModelClient`. It relies on `normalize_git_remote_url` only for the remote URL comparison after the git repository has been created.

*Call graph*: calls 5 internal fn (mount_response_sequence, mount_sse_once, sse, start_mock_server, test_codex); 8 external calls (from_utf8, assert!, assert_eq!, assert_ne!, skip_if_no_network!, from_str, write, vec!).


### `core/tests/suite/request_compression.rs`

`test` · `integration test execution during outbound request serialization`

This small test module targets request-body compression behavior behind the `EnableRequestCompression` feature flag. Both tests stand up a mock SSE server, submit a trivial `Op::UserInput`, wait for `EventMsg::TurnComplete`, and then inspect the captured HTTP request body sent to the mock backend. The distinction under test is authentication mode: when the client is configured with dummy ChatGPT auth and a Codex backend-style base URL (`/backend-api/codex/v1`), the request should carry `content-encoding: zstd`; when the same feature is enabled but the client uses the default API-key-style path, the request should remain plain JSON.

The compressed-path test goes beyond header inspection by decoding the raw bytes with `zstd::stream::decode_all` and parsing the result as JSON, asserting that the decoded payload contains an `input` field consistent with a Responses API request. The uncompressed-path test similarly parses the raw body bytes directly as JSON and checks for the same field. Together, the pair ensures compression is gated not just by the feature flag but also by backend/auth selection, and that enabling compression does not corrupt the serialized request body.

#### Function details

##### `request_body_is_zstd_compressed_for_codex_backend_when_enabled`  (lines 19–68)

```
async fn request_body_is_zstd_compressed_for_codex_backend_when_enabled() -> anyhow::Result<()>
```

**Purpose**: Verifies that enabling request compression causes Responses API requests to the Codex backend to be sent with zstd compression when ChatGPT auth is in use.

**Data flow**: Starts a mock server, mounts a one-shot SSE completion, builds a `TestCodex` with dummy ChatGPT auth, enables `Feature::EnableRequestCompression`, points `config.model_provider.base_url` at the mock server's `/backend-api/codex/v1` path, submits a text-only `Op::UserInput`, waits for `TurnComplete`, inspects the captured request header `content-encoding`, decodes the compressed body with zstd, parses the decompressed bytes as JSON, and asserts the payload contains an `input` field.

**Call relations**: This is the positive compression-path test; it drives the full request pipeline and then validates both transport metadata and payload integrity from the captured mock request.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, create_dummy_chatgpt_auth_for_testing, new); 9 external calls (default, assert!, assert_eq!, wait_for_event, format!, from_slice, skip_if_no_network!, vec!, decode_all).


##### `request_body_is_not_compressed_for_api_key_auth_even_when_enabled`  (lines 71–119)

```
async fn request_body_is_not_compressed_for_api_key_auth_even_when_enabled() -> anyhow::Result<()>
```

**Purpose**: Checks that the compression feature does not apply to the API-key auth path, even when the feature flag is enabled and the backend URL resembles the Codex backend.

**Data flow**: Starts a mock server, mounts a one-shot SSE completion, builds a `TestCodex` without ChatGPT auth but with `Feature::EnableRequestCompression` enabled and the same `/backend-api/codex/v1` base URL, submits a text-only `Op::UserInput`, waits for `TurnComplete`, asserts the captured request has no `content-encoding` header, parses the raw body bytes directly as JSON, and checks for an `input` field.

**Call relations**: This is the negative counterpart to the compressed-path test and proves that auth mode, not just URL shape plus feature flag, controls compression.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (default, assert!, wait_for_event, format!, from_slice, skip_if_no_network!, vec!).


### `core/tests/suite/models_etag_responses.rs`

`test` · `startup catalog fetch and mid-turn request handling`

This single-test module sets up a full two-request tool-execution flow to prove that model-catalog refreshes are deduplicated across a turn. On startup, Codex fetches `/v1/models` and stores `ETAG_1`. The test then mounts a first `/responses` SSE stream that emits a shell-command tool call and includes `X-Models-Etag: ETAG_2`, which should trigger a catalog refresh because the response ETag differs from the cached one. A second `/responses` stream, representing the tool-output follow-up request, also carries `ETAG_2`; by that point the refresh should already have happened, so no second `/models` fetch should occur.

The test builds an authenticated session with retries minimized for determinism and disables the Apps feature to keep the tool path simple. It submits an explicit `Op::UserInput` with local environment selections and disabled permissions, waits for `TurnComplete`, then inspects the `/models` mocks and the tool-output request. Assertions verify the initial spawn fetch happened once, the mismatch-triggered refresh happened once at `/v1/models`, the refresh request included a `client_version` query parameter, and the tool-output request succeeded without causing another catalog fetch.

#### Function details

##### `refresh_models_on_models_etag_mismatch_and_avoid_duplicate_models_fetch`  (lines 32–165)

```
async fn refresh_models_on_models_etag_mismatch_and_avoid_duplicate_models_fetch() -> Result<()>
```

**Purpose**: Simulates a turn where the first `/responses` reply advertises a new models ETag and the second reply repeats that same ETag, then proves Codex refreshes `/models` only once. It also checks that the refresh uses the dedicated models client by requiring a `client_version` query parameter.

**Data flow**: The test defines two ETag constants and a shell-call id, mounts an initial `/models` response with `ETAG_1`, builds an authenticated session, and asserts the spawn-time `/v1/models` request occurred. It then mounts a second `/models` response with `ETAG_2`, a first `/responses` SSE stream that emits `ev_shell_command_call` plus header `X-Models-Etag: ETAG_2`, and a second `/responses` SSE stream for tool output with the same header. After submitting an explicit `Op::UserInput` and waiting for `TurnComplete`, it asserts the refresh `/models` mock saw exactly one request, that the request path is `/v1/models`, that its URL query contains `client_version`, and that the tool-output request exists while the refresh count remains one.

**Call relations**: This is the file’s only top-level test. It drives the full request chain itself using mock mounts and event waiting, with no local helper functions beyond the imported test support.

*Call graph*: calls 8 internal fn (mount_models_once_with_etag, mount_response_once, sse, sse_response, local_selections, test_codex, turn_permission_fields, create_dummy_chatgpt_auth_for_testing); 10 external calls (clone, default, from_secs, start, new, assert!, assert_eq!, wait_for_event_with_timeout, skip_if_no_network!, vec!).


### WebSocket and realtime transports
These suites exercise websocket and realtime session behavior, from request framing and prewarm flows to conversation-level transport handling.

### `core/tests/suite/agent_websocket.rs`

`test` · `request handling during websocket integration tests`

This file contains end-to-end websocket transport tests built around `start_websocket_server` fixtures that record each request body and handshake. The tests all skip when networked integration is unavailable. The basic shell-chain case verifies that a model-issued shell command over websocket causes Codex to send a second `response.create` containing tool output. The first-turn tests assert that websocket sessions begin with a non-generating startup prewarm request (`generate: false`) whose `x-codex-turn-metadata` marks `request_kind: prewarm`, followed by the actual turn request with populated tools and `request_kind: turn`. A delayed-handshake variant ensures the first user turn tolerates websocket startup latency.

The v2 tests enable `Feature::ResponsesWebsocketsV2` and check the protocol differences: the handshake must include `openai-beta: responses_websockets=2026-02-06`, the warmup response ID becomes the `previous_response_id` for the first real turn, and subsequent tool-output turns chain from the immediately prior response ID. Additional tests verify service-tier propagation across prewarm boundaries: a fast tier supplied only for the first turn appears as `service_tier: "priority"` on that turn but not on warmup, a configured fast tier can be dropped by an explicit `None`, and later turns can independently update or clear the service tier without inheriting stale values.

#### Function details

##### `websocket_test_codex_shell_chain`  (lines 20–67)

```
async fn websocket_test_codex_shell_chain() -> Result<()>
```

**Purpose**: Checks the basic websocket request/response chain for a shell-command tool call followed by a normal assistant reply. It ensures Codex emits two `response.create` requests on the same connection and includes non-empty input on the follow-up turn.

**Data flow**: Starts a websocket fixture server configured to first emit a shell-command call and then an assistant message, builds a test harness with Windows shell support, submits a turn under the legacy sandbox policy, then inspects the recorded single connection. It asserts there are exactly two requests, both have `type == "response.create"`, and the second request’s `input` array exists and is non-empty before shutting down the server.

**Call relations**: This top-level test drives the websocket transport through one tool round-trip. The server fixture supplies the shell call on the first request, causing Codex to execute the tool and send the second request that the test inspects.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_first_turn_uses_startup_prewarm_and_create`  (lines 70–124)

```
async fn websocket_first_turn_uses_startup_prewarm_and_create() -> Result<()>
```

**Purpose**: Verifies that the first websocket-backed turn is preceded by a startup prewarm request and that both requests carry the expected metadata. It also confirms the actual turn request includes tools.

**Data flow**: Creates a websocket server that returns one warmup completion and one assistant response, builds a default test harness, submits a turn, and then inspects handshake and request logs. It asserts one handshake, two requests total, `warmup["type"] == "response.create"`, `warmup["generate"] == false`, parses `warmup["client_metadata"]["x-codex-turn-metadata"]` as JSON to verify `request_kind == "prewarm"` and matching `window_id`, checks the second request has a non-empty `tools` array and `type == "response.create"`, parses its turn metadata, and asserts `request_kind == "turn"`.

**Call relations**: This test exercises the startup path of websocket sessions. The fixture’s first response satisfies the prewarm request, after which Codex sends the real turn request that the test validates.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 5 external calls (assert!, assert_eq!, from_str, skip_if_no_network!, vec!).


##### `websocket_first_turn_handles_handshake_delay_with_startup_prewarm`  (lines 127–171)

```
async fn websocket_first_turn_handles_handshake_delay_with_startup_prewarm() -> Result<()>
```

**Purpose**: Ensures websocket startup prewarm still works when the server delays accepting the handshake. The key behavior is that turn submission waits correctly and still produces the expected warmup and turn requests.

**Data flow**: Starts a websocket server with explicit connection config including `accept_delay: 150ms`, then builds a harness and submits a turn. After completion it asserts one handshake, two requests, verifies the first request is a non-generating `response.create` warmup, and checks the second request is a `response.create` with a non-empty `tools` array before shutting down the server.

**Call relations**: This top-level test targets transport timing rather than payload semantics. The delayed handshake forces Codex’s websocket startup path to tolerate connection latency before issuing the actual turn.

*Call graph*: calls 2 internal fn (start_websocket_server_with_headers, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_v2_test_codex_shell_chain`  (lines 174–256)

```
async fn websocket_v2_test_codex_shell_chain() -> Result<()>
```

**Purpose**: Validates the websocket v2 protocol for a shell-command chain, including warmup, response-ID chaining, function-call-output replay, and the required beta handshake header.

**Data flow**: Starts a websocket server that emits a warmup completion, then a shell-command call, then a final assistant message. It builds a harness with Windows shell support and enables `ResponsesWebsocketsV2`, submits a turn, and inspects the recorded connection and handshake. The test asserts three requests total: warmup with `generate: false`, first real turn with `previous_response_id == "warm-1"` and non-empty input, and second turn with `previous_response_id == "resp-1"`. It then scans the second turn’s `input` array for a `function_call_output` item whose `call_id` matches the shell call, and finally asserts the handshake contains the exact `openai-beta` header value.

**Call relations**: This test covers the v2 websocket flow where each new `response.create` references the prior response. The fixture’s shell-command event forces Codex to send the chained follow-up request containing tool output.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_v2_first_turn_uses_updated_fast_tier_after_startup_prewarm`  (lines 259–311)

```
async fn websocket_v2_first_turn_uses_updated_fast_tier_after_startup_prewarm() -> Result<()>
```

**Purpose**: Checks that a fast service tier requested for the first real turn is applied there, but not retroactively to the startup prewarm request. It also verifies that the first turn does not chain from the warmup response in this case.

**Data flow**: Starts a websocket server with warmup and one assistant response, enables websocket v2 in the harness, and waits for the first recorded request to inspect the warmup before submitting the user turn. It asserts the warmup is a non-generating `response.create` with no `service_tier`, then submits a turn with `Some(ServiceTier::Fast.request_value())`. After completion it inspects the second request and asserts `type == "response.create"`, `service_tier == "priority"`, `previous_response_id` is absent, and `input` is non-empty.

**Call relations**: The test splits observation into pre-submit warmup inspection and post-submit turn inspection to prove that per-turn service-tier overrides are applied only to the actual user turn, not to the startup prewarm.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_v2_first_turn_drops_fast_tier_after_startup_prewarm`  (lines 314–367)

```
async fn websocket_v2_first_turn_drops_fast_tier_after_startup_prewarm() -> Result<()>
```

**Purpose**: Verifies that an explicit `None` service-tier override on the first real turn clears a fast tier inherited from configuration, even though the startup prewarm used that configured tier. It ensures stale tier state is not carried forward.

**Data flow**: Starts a warmup-plus-response websocket server, builds a harness with websocket v2 enabled and `config.service_tier` preset to fast, and inspects the warmup request before submitting the turn. It asserts the warmup has `generate: false` and `service_tier == "priority"`, then submits a turn with `service_tier` explicitly `None`. After completion it inspects the first real turn request and asserts `type == "response.create"`, `service_tier` is absent, `previous_response_id` is absent, and `input` is non-empty.

**Call relations**: This test complements the previous one by proving that turn-level overrides can remove a configured tier after prewarm, rather than inheriting the warmup’s setting.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_v2_next_turn_uses_updated_service_tier`  (lines 370–444)

```
async fn websocket_v2_next_turn_uses_updated_service_tier() -> Result<()>
```

**Purpose**: Checks that service-tier selection is evaluated independently on successive websocket v2 turns after startup prewarm. A fast first turn should not force the second turn to remain fast.

**Data flow**: Starts a websocket server with warmup and two assistant responses, enables websocket v2, inspects the warmup request to confirm no `service_tier`, then submits two turns: first with fast tier, second with `None`. It asserts one handshake and three requests total, then inspects the two real turn requests: the first must have `service_tier == "priority"`, no `previous_response_id`, and non-empty input; the second must omit `service_tier`, omit `previous_response_id`, and also have non-empty input.

**Call relations**: This top-level test extends the service-tier checks across multiple user turns on the same websocket connection, confirming that each turn’s tier is recomputed rather than inherited from the previous turn.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


### `core/tests/suite/client_websockets.rs`

`test` · `request handling`

This test file builds a reusable `WebsocketTestHarness` around a `ModelClient`, synthetic `SessionId`/`ThreadId`, offline `ModelInfo`, and `SessionTelemetry`, then drives `ModelClientSession::stream`, `preconnect_websocket`, and `prewarm_websocket` against `WebSocketTestServer`. The helpers construct canonical `CodexResponsesMetadata` for three request kinds—turn, prewarm, and websocket connection—so assertions can inspect the exact metadata and headers sent on the wire. The suite verifies handshake headers such as `OpenAI-Beta`, `x-client-request-id`, `session-id`, `thread-id`, `user-agent`, and optional timing-metrics headers; request bodies such as `response.create`, `previous_response_id`, `input`, `generate`, `tools`, reasoning context, and per-request client metadata; and event translation from websocket frames into `ResponseEvent` variants like `Completed`, `ServerReasoningIncluded`, `RateLimits`, and `ModelsEtag`.

A major theme is connection lifecycle: one websocket should be reused across turns, across dropped `ModelClientSession`s, after explicit preconnect, and after prewarm, even when request headers differ. Another is incremental create logic: when a prompt is a prefix extension of a completed response, the client should send only the suffix plus `previous_response_id`; if non-input fields change or a prior websocket turn failed, it must fall back to a full create. The file also checks trace propagation via W3C trace context in `client_metadata`, runtime metrics accounting, remote timing-metrics ingestion, and retry/reconnect behavior for websocket-specific terminal errors such as connection-limit failures.

#### Function details

##### `assert_request_trace_matches`  (lines 75–99)

```
fn assert_request_trace_matches(body: &serde_json::Value, expected_trace: &W3cTraceContext)
```

**Purpose**: Validates that a websocket request body carries W3C trace context only inside `client_metadata`, with the expected `traceparent` and optional `tracestate` values.

**Data flow**: It reads a JSON request body plus an expected `W3cTraceContext`, extracts `client_metadata`, pulls the traceparent/tracestate keys defined by the websocket client-metadata constants, compares them to the expected values, and asserts that no top-level `trace` field was emitted.

**Call relations**: This helper is used by trace-focused tests after a request has already been sent and captured by the mock websocket server. Those tests invoke it to prove that per-turn tracing survives connection reuse and is not overwritten by an earlier preconnect operation.

*Call graph*: called by 2 (responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_reuses_connection_with_per_turn_trace_payloads); 2 external calls (assert!, assert_eq!).


##### `responses_metadata`  (lines 112–127)

```
fn responses_metadata(
    harness: &WebsocketTestHarness,
    turn_id: Option<&str>,
    request_kind: TestCodexResponsesRequestKind,
) -> CodexResponsesMetadata
```

**Purpose**: Builds canonical `CodexResponsesMetadata` for this suite using the harness session/thread identifiers and a supplied request kind.

**Data flow**: It takes a `WebsocketTestHarness`, optional turn id, and `TestCodexResponsesRequestKind`; reads the harness `session_id` and `thread_id`; injects fixed installation/window/source values; and returns the metadata object produced by `core_test_support::responses_metadata`.

**Call relations**: This is the common constructor behind the narrower metadata helpers. Tests do not usually call it directly; instead they go through `turn_metadata`, `prewarm_metadata`, or `websocket_connection_metadata` depending on which websocket path they are exercising.

*Call graph*: called by 3 (prewarm_metadata, turn_metadata, websocket_connection_metadata); 1 external calls (responses_metadata).


##### `turn_metadata`  (lines 129–131)

```
fn turn_metadata(harness: &WebsocketTestHarness, turn_id: Option<&str>) -> CodexResponsesMetadata
```

**Purpose**: Produces request metadata for a normal turn request.

**Data flow**: It accepts the harness and optional turn id, forwards them to `responses_metadata` with request kind `Turn`, and returns the resulting `CodexResponsesMetadata`.

**Call relations**: Many stream-oriented tests call this helper before invoking `ModelClientSession::stream`, especially when they need to inspect serialized `x-codex-turn-metadata` or compare turn ids across initial and incremental creates.

*Call graph*: calls 1 internal fn (responses_metadata); called by 12 (responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event, responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create, responses_websocket_preconnect_is_reused_even_with_header_changes, responses_websocket_request_prewarm_is_reused_even_with_header_changes, responses_websocket_request_prewarm_traces_logical_request, responses_websocket_request_prewarm_uses_caller_supplied_metadata, responses_websocket_sends_canonical_turn_metadata, responses_websocket_v2_after_error_uses_full_create_without_previous_response_id, responses_websocket_v2_surfaces_terminal_error_without_close_handshake (+2 more)).


##### `prewarm_metadata`  (lines 133–138)

```
fn prewarm_metadata(
    harness: &WebsocketTestHarness,
    turn_id: Option<&str>,
) -> CodexResponsesMetadata
```

**Purpose**: Produces request metadata for a websocket prewarm request.

**Data flow**: It takes the harness and optional turn id, delegates to `responses_metadata` with request kind `Prewarm`, and returns the metadata object.

**Call relations**: Prewarm tests use this helper before calling `prewarm_websocket` so they can verify that the request is marked as a prewarm and that follow-up streaming reuses the warmed response/connection.

*Call graph*: calls 1 internal fn (responses_metadata); called by 4 (responses_websocket_prewarm_uses_v2_when_provider_supports_websockets, responses_websocket_request_prewarm_is_reused_even_with_header_changes, responses_websocket_request_prewarm_reuses_connection, responses_websocket_request_prewarm_traces_logical_request).


##### `websocket_connection_metadata`  (lines 140–146)

```
fn websocket_connection_metadata(harness: &WebsocketTestHarness) -> CodexResponsesMetadata
```

**Purpose**: Produces request metadata for a websocket connection establishment/preconnect operation.

**Data flow**: It reads the harness identifiers and returns `CodexResponsesMetadata` tagged with request kind `WebsocketConnection` via `responses_metadata`.

**Call relations**: Preconnect tests pass this metadata into `preconnect_websocket` to distinguish connection setup from later turn traffic and to verify that connection-level metadata does not leak into turn-level request payloads.

*Call graph*: calls 1 internal fn (responses_metadata); called by 4 (responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_preconnect_is_reused_even_with_header_changes, responses_websocket_preconnect_reuses_connection, responses_websocket_preconnect_runs_when_only_v2_feature_enabled).


##### `responses_websocket_streams_request`  (lines 149–206)

```
async fn responses_websocket_streams_request()
```

**Purpose**: Verifies the baseline websocket streaming path: one handshake, one `response.create` request, expected headers, and expected client metadata fields.

**Data flow**: It starts a websocket server scripted to emit `response.created` then `completed`, builds a harness and prompt, streams until completion, then inspects the captured handshake and request JSON for model name, `stream: true`, input length, installation id, and a positive websocket request-start timestamp.

**Call relations**: This is the foundational happy-path test. It drives the standard `websocket_harness` plus `stream_until_complete` flow and then inspects the server-side capture rather than intermediate client events.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_streams_without_feature_flag_when_provider_supports_websockets`  (lines 209–228)

```
async fn responses_websocket_streams_without_feature_flag_when_provider_supports_websockets()
```

**Purpose**: Checks that websocket streaming still occurs when runtime-metrics feature support is off, as long as the provider advertises websocket support.

**Data flow**: It creates a websocket-capable harness with runtime metrics disabled, streams a simple prompt to completion, and asserts that exactly one handshake and one request were observed.

**Call relations**: This test exercises the same stream path as the baseline test but changes harness configuration to prove provider capability alone is enough to select websockets.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_options); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_reuses_connection_with_per_turn_trace_payloads`  (lines 231–300)

```
async fn responses_websocket_reuses_connection_with_per_turn_trace_payloads()
```

**Purpose**: Ensures multiple turns reuse a single websocket connection while each request carries its own current tracing context.

**Data flow**: It installs test tracing, runs two instrumented turns in separate spans, captures the expected W3C trace context before each stream, then inspects the single connection's two request bodies and compares their metadata trace fields, also asserting the traceparents differ.

**Call relations**: The test is invoked as a two-turn scenario over one server connection. It relies on `assert_request_trace_matches` to validate payload shape and demonstrates that connection reuse does not imply trace reuse.

*Call graph*: calls 6 internal fn (start_websocket_server, install_test_tracing, assert_request_trace_matches, prompt_with_input, stream_until_complete, websocket_harness); 6 external calls (assert_eq!, assert_ne!, current_span_w3c_trace_context, skip_if_no_network!, info_span!, vec!).


##### `responses_websocket_preconnect_does_not_replace_turn_trace_payload`  (lines 303–339)

```
async fn responses_websocket_preconnect_does_not_replace_turn_trace_payload()
```

**Purpose**: Proves that an earlier websocket preconnect does not stamp its trace context onto the later streamed turn request.

**Data flow**: It preconnects using connection metadata, then runs a traced stream inside a span, captures the expected current trace context, and checks the sole request body against that turn trace rather than any preconnect-time trace.

**Call relations**: This test first exercises `preconnect_websocket`, then the normal stream path. It exists specifically to guard the handoff between connection setup and request emission.

*Call graph*: calls 7 internal fn (start_websocket_server, install_test_tracing, assert_request_trace_matches, prompt_with_input, stream_until_complete, websocket_connection_metadata, websocket_harness); 5 external calls (assert_eq!, current_span_w3c_trace_context, skip_if_no_network!, info_span!, vec!).


##### `responses_websocket_preconnect_reuses_connection`  (lines 342–374)

```
async fn responses_websocket_preconnect_reuses_connection()
```

**Purpose**: Checks that explicit preconnect opens the websocket once and the subsequent turn reuses that connection without another handshake.

**Data flow**: It preconnects, streams a prompt, then inspects the server for one handshake, one request, and the expected `user-agent` and `x-codex-window-id` handshake headers.

**Call relations**: The test is a direct preconnect-then-stream sequence. It validates the connection cache behavior rather than request-body semantics.

*Call graph*: calls 5 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_connection_metadata, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_request_prewarm_reuses_connection`  (lines 377–438)

```
async fn responses_websocket_request_prewarm_reuses_connection()
```

**Purpose**: Verifies that websocket prewarm sends a non-generating warmup request and that the later turn reuses the same connection and previous response id.

**Data flow**: It prewarms with a prompt and prewarm metadata, then streams the same prompt. Afterwards it inspects two requests on one connection: the first has `generate: false` and empty `tools`, and the second references `previous_response_id` from the warmup and sends empty `input`.

**Call relations**: This test drives `prewarm_websocket` followed by normal streaming. It demonstrates the warmup/follow-up protocol and the request-shape optimization that avoids resending input.

*Call graph*: calls 5 internal fn (start_websocket_server, prewarm_metadata, prompt_with_input, stream_until_complete, websocket_harness_with_options); 4 external calls (assert_eq!, from_str, skip_if_no_network!, vec!).


##### `responses_websocket_request_prewarm_uses_caller_supplied_metadata`  (lines 441–481)

```
async fn responses_websocket_request_prewarm_uses_caller_supplied_metadata()
```

**Purpose**: Confirms that prewarm honors the metadata object passed by the caller instead of forcing request kind `prewarm`.

**Data flow**: It calls `prewarm_websocket` with turn metadata, then parses the serialized `x-codex-turn-metadata` from the warmup request body and asserts the embedded `request_kind` is `turn`.

**Call relations**: This is a metadata-override regression test for the prewarm path. It uses the same prewarm machinery as the reuse test but focuses only on metadata serialization.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, turn_metadata, websocket_harness_with_options); 4 external calls (assert_eq!, from_str, skip_if_no_network!, vec!).


##### `responses_websocket_request_prewarm_traces_logical_request`  (lines 484–589)

```
async fn responses_websocket_request_prewarm_traces_logical_request()
```

**Purpose**: Checks that a prewarmed websocket request still records the original logical user input in rollout/inference tracing even when the follow-up request sends empty `input` plus `previous_response_id`.

**Data flow**: It prewarms, creates a temporary trace bundle with `TraceWriter` and `InferenceTraceContext`, streams to completion, verifies the follow-up request uses `previous_response_id` and empty input, then replays the trace bundle and asserts the inference call references one conversation item containing the original `hello` text.

**Call relations**: This test bridges websocket request optimization with rollout tracing. It first exercises prewarm, then a traced stream, then post-run trace replay to ensure logical request reconstruction remains correct.

*Call graph*: calls 7 internal fn (start_websocket_server, prewarm_metadata, prompt_with_input, turn_metadata, websocket_harness_with_options, enabled, create); 7 external calls (new, new, assert_eq!, replay_bundle, matches!, skip_if_no_network!, vec!).


##### `responses_websocket_reuses_connection_after_session_drop`  (lines 592–617)

```
async fn responses_websocket_reuses_connection_after_session_drop()
```

**Purpose**: Ensures the underlying websocket connection survives dropping one `ModelClientSession` and is reused by a later session from the same `ModelClient`.

**Data flow**: It streams one prompt in a scoped session, drops that session, creates a new session, streams another prompt, and then asserts the server saw one handshake and two requests on the same connection.

**Call relations**: This test targets client-level connection pooling rather than per-session state. It is invoked as two independent session lifetimes over one harness.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_sends_responses_lite_metadata_per_request`  (lines 620–696)

```
async fn responses_websocket_sends_responses_lite_metadata_per_request()
```

**Purpose**: Verifies that `use_responses_lite` affects only the requests made with a lite-enabled `ModelInfo`, not the whole connection.

**Data flow**: It clones and mutates `ModelInfo` values to create normal and lite variants, streams three turns through one session, then maps each captured request body to a reduced JSON view containing the lite metadata key, reasoning context, and `parallel_tool_calls`, and compares the sequence against the expected normal/lite/normal pattern.

**Call relations**: The test uses `stream_until_complete_with_model_info` repeatedly on one connection to prove request-local model flags are serialized per turn.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete_with_model_info, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_preconnect_is_reused_even_with_header_changes`  (lines 699–741)

```
async fn responses_websocket_preconnect_is_reused_even_with_header_changes()
```

**Purpose**: Checks that a preconnected websocket is still reused when the later stream request carries different turn metadata headers.

**Data flow**: It preconnects with connection metadata, then streams with turn metadata and a disabled inference trace, drains until `Completed`, and asserts the server observed one handshake and one request.

**Call relations**: This is a connection-cache stability test. It specifically covers the case where header differences should not force a reconnect after preconnect.

*Call graph*: calls 6 internal fn (start_websocket_server, prompt_with_input, turn_metadata, websocket_connection_metadata, websocket_harness, disabled); 4 external calls (assert_eq!, matches!, skip_if_no_network!, vec!).


##### `responses_websocket_request_prewarm_is_reused_even_with_header_changes`  (lines 744–809)

```
async fn responses_websocket_request_prewarm_is_reused_even_with_header_changes()
```

**Purpose**: Checks that a prewarmed websocket connection remains reusable even when the later stream request has different metadata headers.

**Data flow**: It prewarms with prewarm metadata, then streams with turn metadata, drains to completion, and inspects the two request bodies to confirm warmup semantics and follow-up reuse via `previous_response_id` and empty input.

**Call relations**: This mirrors the preconnect header-change test but for the prewarm path, ensuring metadata differences do not invalidate the warmed connection state.

*Call graph*: calls 6 internal fn (start_websocket_server, prewarm_metadata, prompt_with_input, turn_metadata, websocket_harness_with_options, disabled); 4 external calls (assert_eq!, matches!, skip_if_no_network!, vec!).


##### `responses_websocket_prewarm_uses_v2_when_provider_supports_websockets`  (lines 812–867)

```
async fn responses_websocket_prewarm_uses_v2_when_provider_supports_websockets()
```

**Purpose**: Verifies that prewarm uses the websocket v2 path when the provider supports websockets, including the beta header and websocket-carried prewarm request.

**Data flow**: It prewarms with runtime metrics disabled, asserts one handshake and one websocket request, checks the `OpenAI-Beta` header contains the v2 token, then streams a follow-up turn and confirms no extra request was needed because the prewarm request already carried the prompt input.

**Call relations**: This test covers the v2 prewarm selection logic and contrasts with legacy warmup behavior by asserting the prewarm itself is a websocket request.

*Call graph*: calls 5 internal fn (start_websocket_server, prewarm_metadata, prompt_with_input, stream_until_complete, websocket_harness_with_options); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_preconnect_runs_when_only_v2_feature_enabled`  (lines 870–911)

```
async fn responses_websocket_preconnect_runs_when_only_v2_feature_enabled()
```

**Purpose**: Ensures preconnect still opens the websocket when only the v2 path is relevant, without sending a request body until a real turn arrives.

**Data flow**: It preconnects, asserts one handshake and zero connection requests plus no turn metadata header on the handshake, then streams a prompt and confirms the same connection is used and the beta header advertises websocket v2.

**Call relations**: This test isolates the connection-establishment half of v2 behavior: handshake first, request later.

*Call graph*: calls 5 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_connection_metadata, websocket_harness_with_options); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_requests_use_v2_when_provider_supports_websockets`  (lines 914–960)

```
async fn responses_websocket_v2_requests_use_v2_when_provider_supports_websockets()
```

**Purpose**: Checks that websocket v2 incremental requests use `previous_response_id` and only the suffix input when the second prompt extends the first completed response.

**Data flow**: It streams an initial prompt that yields an assistant message id, then streams a second prompt containing the prior conversation plus a new user item, and inspects the second request body for `previous_response_id: resp-1`, suffix-only input, and the v2 beta header on the handshake.

**Call relations**: This is a core v2 incremental-create test. It depends on the first turn producing an assistant message that can anchor the prefix comparison for the second turn.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_options); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_incremental_requests_are_reused_across_turns`  (lines 963–1004)

```
async fn responses_websocket_v2_incremental_requests_are_reused_across_turns()
```

**Purpose**: Verifies that v2 incremental request state survives across dropped sessions and still reuses the same websocket connection.

**Data flow**: It runs one turn in one session, drops it, runs a prefix-extending second turn in a new session, and then checks one handshake, two requests, and a second request using `previous_response_id` plus suffix-only input.

**Call relations**: This combines v2 incremental logic with client-level connection reuse across session boundaries.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_options); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_wins_when_both_features_enabled`  (lines 1007–1053)

```
async fn responses_websocket_v2_wins_when_both_features_enabled()
```

**Purpose**: Confirms that when both older websocket behavior and v2-capable conditions are present, the client chooses the v2 incremental request form.

**Data flow**: It streams two prefix-related turns and inspects the second request for `previous_response_id`, suffix-only input, and the v2 beta header, demonstrating v2 selection.

**Call relations**: This is a precedence test: it uses the same two-turn shape as other incremental tests but asserts the chosen protocol variant.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_options); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_emits_websocket_telemetry_events`  (lines 1057–1085)

```
async fn responses_websocket_emits_websocket_telemetry_events()
```

**Purpose**: Checks that websocket activity increments websocket-specific runtime metrics rather than generic API/streaming counters.

**Data flow**: It resets runtime metrics, streams one prompt, waits briefly for async metric publication, then reads the telemetry summary and asserts zero API/streaming counts but one websocket call and two websocket events.

**Call relations**: This test runs the normal websocket stream path and then inspects `SessionTelemetry` state after the fact.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 5 external calls (from_millis, assert_eq!, skip_if_no_network!, sleep, vec!).


##### `responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled`  (lines 1088–1135)

```
async fn responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled()
```

**Purpose**: Verifies that enabling runtime metrics adds the timing-metrics request header and that timing frames update the telemetry summary fields.

**Data flow**: It uses a server that emits a `responsesapi.websocket_timing` event, streams a prompt, waits for metrics propagation, checks the handshake for `X-ResponsesAPI-Include-Timing-Metrics: true`, and asserts the telemetry summary fields match the timing payload values.

**Call relations**: This test couples request-header selection with downstream event ingestion. It uses the runtime-metrics-enabled harness variant.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_runtime_metrics); 5 external calls (from_millis, assert_eq!, skip_if_no_network!, sleep, vec!).


##### `responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled`  (lines 1138–1161)

```
async fn responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled()
```

**Purpose**: Checks that the timing-metrics opt-in header is absent when runtime metrics are disabled.

**Data flow**: It streams a prompt with a runtime-metrics-disabled harness and then inspects the handshake headers, expecting no timing-metrics header.

**Call relations**: This is the negative counterpart to the timing-metrics-enabled test and guards the feature flag boundary.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_runtime_metrics); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_emits_reasoning_included_event`  (lines 1164–1207)

```
async fn responses_websocket_emits_reasoning_included_event()
```

**Purpose**: Ensures a websocket response header `X-Reasoning-Included: true` is surfaced to callers as `ResponseEvent::ServerReasoningIncluded(true)`.

**Data flow**: It starts a websocket server configured with response headers, streams a prompt with turn metadata, iterates the event stream until completion, and records whether the reasoning-included event was seen.

**Call relations**: This test focuses on event translation from connection/response metadata into the stream of `ResponseEvent`s returned by `ModelClientSession::stream`.

*Call graph*: calls 5 internal fn (start_websocket_server_with_headers, prompt_with_input, turn_metadata, websocket_harness, disabled); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `responses_websocket_emits_rate_limit_events`  (lines 1210–1303)

```
async fn responses_websocket_emits_rate_limit_events()
```

**Purpose**: Checks that websocket rate-limit payloads and related headers are converted into `ResponseEvent::RateLimits`, `ModelsEtag`, and `ServerReasoningIncluded` events with parsed structured data.

**Data flow**: It injects a `codex.rate_limits` JSON event plus response headers, streams a prompt, collects the resulting events, and then asserts parsed plan type, primary window fields, credits, models etag, and reasoning-included state.

**Call relations**: This test exercises the event parser on non-token websocket messages before normal response completion.

*Call graph*: calls 5 internal fn (start_websocket_server_with_headers, prompt_with_input, turn_metadata, websocket_harness, disabled); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `responses_websocket_usage_limit_error_emits_rate_limit_event`  (lines 1306–1403)

```
async fn responses_websocket_usage_limit_error_emits_rate_limit_event()
```

**Purpose**: Verifies that a websocket 429 usage-limit error still yields a token-count/rate-limit event before surfacing an error event to the higher-level Codex thread.

**Data flow**: It builds a full `test_codex` with retries disabled, submits a user turn, waits for a `TokenCount` event and serializes it to JSON for exact comparison, then waits for an `Error` event whose message mentions usage limits.

**Call relations**: Unlike the lower-level `ModelClientSession` tests, this one drives the top-level `Codex` event loop to confirm websocket errors are translated into user-facing protocol events.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 9 external calls (default, assert!, wait_for_event, json!, assert_eq!, to_value, skip_if_no_network!, unreachable!, vec!).


##### `responses_websocket_invalid_request_error_with_status_is_forwarded`  (lines 1406–1464)

```
async fn responses_websocket_invalid_request_error_with_status_is_forwarded()
```

**Purpose**: Checks that a websocket error frame with HTTP status and invalid-request details is forwarded as a user-visible error event.

**Data flow**: It builds a `test_codex`, submits a user turn, waits for an `EventMsg::Error`, and asserts the message contains the server-provided invalid-request explanation.

**Call relations**: This is another top-level event propagation test, focused on non-rate-limit terminal errors.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 7 external calls (default, assert!, wait_for_event, json!, skip_if_no_network!, unreachable!, vec!).


##### `responses_websocket_connection_limit_error_reconnects_and_completes`  (lines 1467–1514)

```
async fn responses_websocket_connection_limit_error_reconnects_and_completes()
```

**Purpose**: Ensures a websocket connection-limit error triggers a reconnect and allows the turn to complete on a fresh websocket when stream retries permit it.

**Data flow**: It scripts one websocket connection to fail with `websocket_connection_limit_reached` and a second to succeed, configures stream retries to 1, submits a turn, then sums requests across all connections and checks that two handshakes occurred with the expected user-agent header.

**Call relations**: This test covers retry orchestration above the websocket transport, proving that a specific server error code is treated as recoverable by reconnecting.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `responses_websocket_uses_incremental_create_on_prefix`  (lines 1517–1559)

```
async fn responses_websocket_uses_incremental_create_on_prefix()
```

**Purpose**: Verifies the non-v2 websocket path also uses incremental `response.create` with `previous_response_id` when the second prompt extends the first response history.

**Data flow**: It streams two turns where the second prompt includes the first user message, the assistant reply, and a new user message, then inspects the second request body for `previous_response_id` and suffix-only input.

**Call relations**: This is the legacy/incremental counterpart to the v2 incremental tests and guards prefix-detection logic independent of protocol version selection.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create`  (lines 1562–1636)

```
async fn responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create()
```

**Purpose**: Checks that serialized turn metadata, including `turn_id`, is attached both to the initial create and to a later incremental create request.

**Data flow**: It streams two turns with distinct `CodexResponsesMetadata` values, parses `x-codex-turn-metadata` from both request bodies, and asserts the embedded and top-level `turn_id` values match the supplied metadata for each request.

**Call relations**: This test uses `stream_until_complete_with_metadata` to inject explicit metadata and then validates that incremental optimization does not drop or stale-cache it.

*Call graph*: calls 5 internal fn (start_websocket_server, prompt_with_input, stream_until_complete_with_metadata, turn_metadata, websocket_harness); 4 external calls (assert_eq!, from_str, skip_if_no_network!, vec!).


##### `responses_websocket_sends_canonical_turn_metadata`  (lines 1639–1682)

```
async fn responses_websocket_sends_canonical_turn_metadata()
```

**Purpose**: Verifies that a normal websocket request includes canonical serialized turn metadata and mirrors the `turn_id` at the top level of `client_metadata`.

**Data flow**: It streams one turn with explicit metadata, parses the `x-codex-turn-metadata` JSON string from the request body, and compares its `turn_id` to the top-level `client_metadata.turn_id` field.

**Call relations**: This is the single-request baseline for the more complex metadata-forwarding tests.

*Call graph*: calls 5 internal fn (start_websocket_server, prompt_with_input, stream_until_complete_with_metadata, turn_metadata, websocket_harness); 4 external calls (assert_eq!, from_str, skip_if_no_network!, vec!).


##### `responses_websocket_uses_previous_response_id_when_prefix_after_completed`  (lines 1685–1722)

```
async fn responses_websocket_uses_previous_response_id_when_prefix_after_completed()
```

**Purpose**: Confirms that once a prior response has completed, a prefix-extending next prompt uses `previous_response_id` and suffix-only input.

**Data flow**: It streams two turns and inspects the second request body for `type: response.create`, `previous_response_id: resp-1`, and serialized suffix input.

**Call relations**: This is another focused regression test around prefix detection after completion, overlapping with incremental-create coverage but emphasizing the completed-response precondition.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_creates_on_non_prefix`  (lines 1725–1755)

```
async fn responses_websocket_creates_on_non_prefix()
```

**Purpose**: Checks that when the next prompt is not a prefix extension of the previous one, the client sends a full create request instead of an incremental one.

**Data flow**: It streams two unrelated prompts and then inspects the second request body for a full `response.create` with model, `stream: true`, and the entire second prompt input.

**Call relations**: This is the negative case for prefix optimization and guards against over-aggressive reuse of `previous_response_id`.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_creates_when_non_input_request_fields_change`  (lines 1758–1791)

```
async fn responses_websocket_creates_when_non_input_request_fields_change()
```

**Purpose**: Ensures that even if the input shares a prefix, changing non-input request fields such as base instructions forces a full create without `previous_response_id`.

**Data flow**: It streams two prompts with different `BaseInstructions`, then inspects the second request body to confirm `previous_response_id` is absent and the full input is resent.

**Call relations**: This test protects the request-equivalence check used before incremental optimization, proving it considers more than just input items.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input_and_instructions, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_creates_with_previous_response_id_on_prefix`  (lines 1794–1833)

```
async fn responses_websocket_v2_creates_with_previous_response_id_on_prefix()
```

**Purpose**: Verifies the v2 path uses `previous_response_id` for prefix-extending prompts.

**Data flow**: It streams two turns through a v2-configured harness and inspects the second request body for `previous_response_id` and suffix-only input.

**Call relations**: This is the v2-specific positive case for incremental create, parallel to the legacy prefix tests.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_v2); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_creates_without_previous_response_id_when_non_input_fields_change`  (lines 1836–1870)

```
async fn responses_websocket_v2_creates_without_previous_response_id_when_non_input_fields_change()
```

**Purpose**: Checks that v2 also falls back to a full create when non-input request fields differ between turns.

**Data flow**: It streams two prompts with different base instructions through a v2 harness and asserts the second request omits `previous_response_id` and includes the full input.

**Call relations**: This is the v2-specific negative case for incremental optimization.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input_and_instructions, stream_until_complete, websocket_harness_with_v2); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_after_error_uses_full_create_without_previous_response_id`  (lines 1873–1962)

```
async fn responses_websocket_v2_after_error_uses_full_create_without_previous_response_id()
```

**Purpose**: Ensures that after a websocket v2 turn fails, the next turn reconnects and sends a full create rather than trying to continue from the failed response id.

**Data flow**: It streams a successful first turn, starts a second turn that emits `response.failed` and yields an error, then streams a third turn and inspects two server connections: the third request is on a new connection, has no `previous_response_id`, and carries the full third prompt input.

**Call relations**: This test spans success, terminal stream error, and recovery. It proves failed incremental state is discarded before the next attempt.

*Call graph*: calls 6 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, turn_metadata, websocket_harness_with_v2, disabled); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_surfaces_terminal_error_without_close_handshake`  (lines 1965–2023)

```
async fn responses_websocket_v2_surfaces_terminal_error_without_close_handshake()
```

**Purpose**: Checks that a terminal v2 websocket error is surfaced promptly even if the server does not close the websocket afterward.

**Data flow**: It runs a successful first turn, then a second turn whose stream emits `response.failed` without a close handshake, and uses a timeout while polling the stream to assert an error item is still produced.

**Call relations**: This guards the stream reader against hanging forever waiting for socket closure after a terminal protocol-level failure.

*Call graph*: calls 6 internal fn (start_websocket_server_with_headers, prompt_with_input, stream_until_complete, turn_metadata, websocket_harness_with_v2, disabled); 5 external calls (from_secs, assert!, skip_if_no_network!, timeout, vec!).


##### `responses_websocket_v2_sets_openai_beta_header`  (lines 2026–2052)

```
async fn responses_websocket_v2_sets_openai_beta_header()
```

**Purpose**: Verifies that v2 websocket requests advertise the required beta feature token in the handshake.

**Data flow**: It streams one prompt through a v2 harness, reads the handshake `OpenAI-Beta` header, splits it on commas, and asserts the websocket-v2 token is present.

**Call relations**: This is a focused handshake-header test for the v2 path.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_v2); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `message_item`  (lines 2054–2062)

```
fn message_item(text: &str) -> ResponseItem
```

**Purpose**: Constructs a user `ResponseItem::Message` containing one `ContentItem::InputText` entry.

**Data flow**: It takes a text string and returns a `ResponseItem::Message` with `role: "user"`, no id/phase/metadata, and a one-element content vector containing the provided text.

**Call relations**: Many prompt-building tests use this helper to create concise user message items without repeating the enum construction boilerplate.

*Call graph*: 1 external calls (vec!).


##### `assistant_message_item`  (lines 2064–2072)

```
fn assistant_message_item(id: &str, text: &str) -> ResponseItem
```

**Purpose**: Constructs an assistant `ResponseItem::Message` with a fixed id and one `ContentItem::OutputText` entry.

**Data flow**: It takes an id and text, then returns a `ResponseItem::Message` with `role: "assistant"`, that id, and one output-text content item.

**Call relations**: Prefix/incremental tests use this helper to model prior assistant output inside a follow-up prompt so the client can detect shared history.

*Call graph*: 1 external calls (vec!).


##### `prompt_with_input`  (lines 2074–2078)

```
fn prompt_with_input(input: Vec<ResponseItem>) -> Prompt
```

**Purpose**: Creates a default `Prompt` and replaces its `input` field with the supplied response items.

**Data flow**: It starts from `Prompt::default()`, assigns the provided `Vec<ResponseItem>` to `prompt.input`, and returns the prompt.

**Call relations**: This is the base prompt constructor used by most tests and by `prompt_with_input_and_instructions`.

*Call graph*: calls 1 internal fn (default); called by 32 (prompt_with_input_and_instructions, responses_websocket_creates_on_non_prefix, responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event, responses_websocket_emits_websocket_telemetry_events, responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create, responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled, responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled, responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_preconnect_is_reused_even_with_header_changes (+15 more)).


##### `prompt_with_input_and_instructions`  (lines 2080–2086)

```
fn prompt_with_input_and_instructions(input: Vec<ResponseItem>, instructions: &str) -> Prompt
```

**Purpose**: Creates a prompt with both explicit input items and custom base instructions.

**Data flow**: It builds a prompt via `prompt_with_input`, then overwrites `prompt.base_instructions.text` with the supplied instruction string and returns the modified prompt.

**Call relations**: Tests that need to force a non-input request-field change use this helper to make two otherwise similar prompts differ in instructions.

*Call graph*: calls 1 internal fn (prompt_with_input); called by 2 (responses_websocket_creates_when_non_input_request_fields_change, responses_websocket_v2_creates_without_previous_response_id_when_non_input_fields_change).


##### `websocket_provider`  (lines 2088–2090)

```
fn websocket_provider(server: &WebSocketTestServer) -> ModelProviderInfo
```

**Purpose**: Builds the default websocket-capable `ModelProviderInfo` for a test server.

**Data flow**: It takes a `WebSocketTestServer` and delegates to `websocket_provider_with_connect_timeout` with no explicit connect-timeout override.

**Call relations**: This is the standard provider factory used by `websocket_harness_with_options`.

*Call graph*: calls 1 internal fn (websocket_provider_with_connect_timeout); called by 1 (websocket_harness_with_options).


##### `websocket_provider_with_connect_timeout`  (lines 2092–2115)

```
fn websocket_provider_with_connect_timeout(
    server: &WebSocketTestServer,
    websocket_connect_timeout_ms: Option<u64>,
) -> ModelProviderInfo
```

**Purpose**: Constructs a `ModelProviderInfo` configured for the mock websocket server and the Responses wire API.

**Data flow**: It reads the server URI, formats a `/v1` base URL, fills a `ModelProviderInfo` with websocket support enabled, retries disabled, idle timeout set, optional connect timeout, and `WireApi::Responses`, then returns it.

**Call relations**: Provider-building helpers and harness setup call this to control transport-level behavior without involving the rest of the test harness.

*Call graph*: called by 1 (websocket_provider); 1 external calls (format!).


##### `websocket_harness`  (lines 2117–2119)

```
async fn websocket_harness(server: &WebSocketTestServer) -> WebsocketTestHarness
```

**Purpose**: Creates the standard websocket test harness with runtime metrics disabled.

**Data flow**: It forwards the server to `websocket_harness_with_runtime_metrics(false)` and returns the resulting `WebsocketTestHarness`.

**Call relations**: Most tests use this convenience wrapper when they do not need special runtime-metrics or provider options.

*Call graph*: calls 1 internal fn (websocket_harness_with_runtime_metrics); called by 16 (responses_websocket_creates_on_non_prefix, responses_websocket_creates_when_non_input_request_fields_change, responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event, responses_websocket_emits_websocket_telemetry_events, responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create, responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_preconnect_is_reused_even_with_header_changes, responses_websocket_preconnect_reuses_connection, responses_websocket_reuses_connection_after_session_drop (+6 more)).


##### `websocket_harness_with_runtime_metrics`  (lines 2121–2126)

```
async fn websocket_harness_with_runtime_metrics(
    server: &WebSocketTestServer,
    runtime_metrics_enabled: bool,
) -> WebsocketTestHarness
```

**Purpose**: Creates a websocket harness while explicitly choosing whether runtime metrics are enabled.

**Data flow**: It forwards the server and boolean flag to `websocket_harness_with_options` and returns the harness.

**Call relations**: Timing-metrics and telemetry tests use this wrapper to toggle runtime-metrics behavior while keeping the rest of the harness standard.

*Call graph*: calls 1 internal fn (websocket_harness_with_options); called by 3 (responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled, responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled, websocket_harness).


##### `websocket_harness_with_v2`  (lines 2128–2133)

```
async fn websocket_harness_with_v2(
    server: &WebSocketTestServer,
    runtime_metrics_enabled: bool,
) -> WebsocketTestHarness
```

**Purpose**: Creates a websocket harness for tests that conceptually target the v2 path.

**Data flow**: It simply delegates to `websocket_harness_with_options` with the provided runtime-metrics flag and returns the harness.

**Call relations**: Although it currently shares implementation with the generic options helper, v2-specific tests call this wrapper to make their intent explicit.

*Call graph*: calls 1 internal fn (websocket_harness_with_options); called by 5 (responses_websocket_v2_after_error_uses_full_create_without_previous_response_id, responses_websocket_v2_creates_with_previous_response_id_on_prefix, responses_websocket_v2_creates_without_previous_response_id_when_non_input_fields_change, responses_websocket_v2_sets_openai_beta_header, responses_websocket_v2_surfaces_terminal_error_without_close_handshake).


##### `websocket_harness_with_options`  (lines 2135–2141)

```
async fn websocket_harness_with_options(
    server: &WebSocketTestServer,
    runtime_metrics_enabled: bool,
) -> WebsocketTestHarness
```

**Purpose**: Builds a websocket harness from the default websocket provider and a runtime-metrics toggle.

**Data flow**: It creates a provider via `websocket_provider(server)`, then passes that provider and the metrics flag into `websocket_harness_with_provider_options`.

**Call relations**: This is the main harness entry point for tests that need a standard provider but custom feature toggles.

*Call graph*: calls 2 internal fn (websocket_harness_with_provider_options, websocket_provider); called by 12 (responses_websocket_preconnect_runs_when_only_v2_feature_enabled, responses_websocket_prewarm_uses_v2_when_provider_supports_websockets, responses_websocket_request_prewarm_is_reused_even_with_header_changes, responses_websocket_request_prewarm_reuses_connection, responses_websocket_request_prewarm_traces_logical_request, responses_websocket_request_prewarm_uses_caller_supplied_metadata, responses_websocket_streams_without_feature_flag_when_provider_supports_websockets, responses_websocket_v2_incremental_requests_are_reused_across_turns, responses_websocket_v2_requests_use_v2_when_provider_supports_websockets, responses_websocket_v2_wins_when_both_features_enabled (+2 more)).


##### `websocket_harness_with_provider_options`  (lines 2143–2205)

```
async fn websocket_harness_with_provider_options(
    provider: ModelProviderInfo,
    runtime_metrics_enabled: bool,
) -> WebsocketTestHarness
```

**Purpose**: Assembles the full `WebsocketTestHarness`, including temp home, config, offline model info, telemetry, and `ModelClient`.

**Data flow**: It creates a temp codex home, loads default test config, sets the model slug, optionally enables `Feature::RuntimeMetrics`, constructs offline `ModelInfo`, fresh `ThreadId`/`SessionId`, an auth manager from a dummy API key, in-memory metrics exporter/client, `SessionTelemetry`, and finally a `ModelClient` configured with the supplied provider and runtime-metrics flag. It returns all of that packaged in `WebsocketTestHarness`.

**Call relations**: All harness constructors funnel into this function. It is the central setup point that wires together config, telemetry, and transport state for every websocket integration test.

*Call graph*: calls 9 internal fn (new, auth_manager_from_auth, construct_model_info_offline, from_api_key, new, new, in_memory, new, new); called by 1 (websocket_harness_with_options); 6 external calls (new, default, new, load_default_config_for_test, env!, clone).


##### `stream_until_complete`  (lines 2207–2219)

```
async fn stream_until_complete(
    client_session: &mut ModelClientSession,
    harness: &WebsocketTestHarness,
    prompt: &Prompt,
)
```

**Purpose**: Streams a prompt to completion using default service-tier behavior.

**Data flow**: It accepts a mutable `ModelClientSession`, harness, and prompt, then delegates to `stream_until_complete_with_service_tier` with `None` and returns once completion is observed.

**Call relations**: Most tests use this helper as the simplest way to drive a websocket turn and wait until the stream reaches `ResponseEvent::Completed`.

*Call graph*: calls 1 internal fn (stream_until_complete_with_service_tier); called by 24 (responses_websocket_creates_on_non_prefix, responses_websocket_creates_when_non_input_request_fields_change, responses_websocket_emits_websocket_telemetry_events, responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled, responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled, responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_preconnect_reuses_connection, responses_websocket_preconnect_runs_when_only_v2_feature_enabled, responses_websocket_prewarm_uses_v2_when_provider_supports_websockets, responses_websocket_request_prewarm_reuses_connection (+14 more)).


##### `stream_until_complete_with_model_info`  (lines 2221–2252)

```
async fn stream_until_complete_with_model_info(
    client_session: &mut ModelClientSession,
    harness: &WebsocketTestHarness,
    prompt: &Prompt,
    model_info: &ModelInfo,
    expected_response_
```

**Purpose**: Streams a prompt with an explicit `ModelInfo` and asserts the completed response id matches an expected value.

**Data flow**: It builds turn metadata, starts `client_session.stream` with the supplied model info and disabled inference trace, iterates events until a `Completed` event appears, compares its `response_id` to the expected string, and panics if the stream ends first.

**Call relations**: The responses-lite test uses this helper repeatedly to vary model flags per request while still asserting which mocked response completed.

*Call graph*: calls 3 internal fn (stream, turn_metadata, disabled); called by 1 (responses_websocket_sends_responses_lite_metadata_per_request); 2 external calls (assert_eq!, panic!).


##### `stream_until_complete_with_service_tier`  (lines 2254–2269)

```
async fn stream_until_complete_with_service_tier(
    client_session: &mut ModelClientSession,
    harness: &WebsocketTestHarness,
    prompt: &Prompt,
    service_tier: Option<ServiceTier>,
)
```

**Purpose**: Streams a prompt to completion while optionally overriding the service tier.

**Data flow**: It creates turn metadata, then delegates to `stream_until_complete_with_metadata` with the supplied optional `ServiceTier` and the generated metadata.

**Call relations**: This is the intermediate helper between the simplest stream wrapper and the fully parameterized metadata-aware version.

*Call graph*: calls 2 internal fn (stream_until_complete_with_metadata, turn_metadata); called by 1 (stream_until_complete).


##### `stream_until_complete_with_metadata`  (lines 2271–2297)

```
async fn stream_until_complete_with_metadata(
    client_session: &mut ModelClientSession,
    harness: &WebsocketTestHarness,
    prompt: &Prompt,
    service_tier: Option<ServiceTier>,
    responses
```

**Purpose**: Starts a websocket stream with explicit metadata and optional service tier, then drains it until completion.

**Data flow**: It calls `ModelClientSession::stream` with the harness model info, telemetry, effort, reasoning summary, optional service-tier request value, provided `CodexResponsesMetadata`, and a disabled inference trace; then it polls the stream until it sees `Ok(ResponseEvent::Completed { .. })`.

**Call relations**: Metadata-sensitive tests call this helper directly so they can control the serialized turn metadata while still using a common completion-draining loop.

*Call graph*: calls 2 internal fn (stream, disabled); called by 3 (responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create, responses_websocket_sends_canonical_turn_metadata, stream_until_complete_with_service_tier); 1 external calls (matches!).


### `core/tests/suite/realtime_conversation.rs`

`test` · `realtime session startup, streaming event handling, and delegation regression coverage`

This is the largest realtime integration suite in the tree. It stands up mock websocket servers, mock SSE/Responses servers, and wiremock HTTP endpoints to exercise the full `Op::RealtimeConversation*` surface. The local `RealtimeCallRequestCapture` matcher records POST bodies for WebRTC call creation so tests can inspect multipart SDP/session payloads. Utility helpers normalize JSON fixtures, extract text or instructions from captured websocket requests, poll for specific websocket requests, derive the expected backend prompt by substituting the current user's first name into `codex_prompts::BACKEND_PROMPT`, and seed recent-thread metadata directly into the state DB for startup-context tests.

The tests cover several major areas. Startup and transport tests verify websocket round trips, default version/model selection, explicit/configured voice handling, base URL and backend-prompt overrides, WebRTC call creation and sideband websocket joining, architecture-specific query parameters, and correct close/error semantics when startup, connect, or sideband join fails. Startup-context tests verify when context is injected, how config overrides can replace or disable it, how recent thread metadata and workspace maps are rendered, and how current-thread history is budgeted and truncated.

A second major cluster covers interaction between realtime and normal model turns. User text turns should still go to the Responses API rather than the realtime socket. Realtime tool/noop events, inbound handoff requests, transcript accumulation, assistant-message mirroring back to realtime handoff channels, and steering of active turns are all exercised with streaming SSE fixtures and websocket event sequences. Across these tests, the suite checks not just emitted events but exact request ordering, headers, URIs, prompt text, and persistence of handoff state until turn completion.

#### Function details

##### `RealtimeCallRequestCapture::new`  (lines 76–80)

```
fn new() -> Self
```

**Purpose**: Constructs a request-capture matcher that stores matched wiremock requests in shared mutable state. It is used to inspect WebRTC call-creation POSTs after the fact.

**Data flow**: Allocates an empty `Vec<WiremockRequest>` inside `Arc<Mutex<_>>` and returns a `RealtimeCallRequestCapture` containing it.

**Call relations**: Called by WebRTC tests before mounting a wiremock `Mock`. The returned value is cloned into the matcher chain and later queried with `single_request`.

*Call graph*: 3 external calls (new, new, new).


##### `RealtimeCallRequestCapture::single_request`  (lines 82–89)

```
fn single_request(&self) -> WiremockRequest
```

**Purpose**: Returns the only captured realtime call request and asserts that exactly one was recorded. It simplifies tests that expect a single POST to the call endpoint.

**Data flow**: Locks the internal mutex, recovers from poisoning if necessary, asserts `requests.len() == 1`, clones the sole `WiremockRequest`, and returns it.

**Call relations**: Used by the WebRTC call tests after the mocked endpoint has been hit. It depends on `matches` having recorded requests during wiremock matching.

*Call graph*: 1 external calls (assert_eq!).


##### `RealtimeCallRequestCapture::matches`  (lines 93–99)

```
fn matches(&self, request: &WiremockRequest) -> bool
```

**Purpose**: Implements the wiremock `Match` trait by recording every incoming request and always returning `true`. This lets the capture object both match and observe requests.

**Data flow**: Locks the internal request vector, clones the incoming `WiremockRequest`, pushes it into storage, and returns `true` so the enclosing mock still matches.

**Call relations**: Wiremock invokes this during request matching for the WebRTC call endpoint. Tests never call it directly; they observe its side effects through `single_request`.

*Call graph*: 1 external calls (clone).


##### `normalized_json_string`  (lines 102–105)

```
fn normalized_json_string(raw: &str) -> Result<String>
```

**Purpose**: Parses and reserializes a JSON string into canonical compact form for stable string comparison. It is used when asserting exact multipart session payloads.

**Data flow**: Accepts a raw JSON string, parses it into `serde_json::Value`, then serializes that value back to a compact JSON string and returns it as `Result<String>` with contextual error messages.

**Call relations**: Used by `conversation_webrtc_start_posts_generated_session` to normalize the expected session JSON before comparing it to the multipart request body.

*Call graph*: called by 1 (conversation_webrtc_start_posts_generated_session); 2 external calls (from_str, to_string).


##### `websocket_request_text`  (lines 107–113)

```
fn websocket_request_text(
    request: &core_test_support::responses::WebSocketRequest,
) -> Option<String>
```

**Purpose**: Extracts the first text content item from a captured websocket request's `item.content[0].text` field. It is a convenience accessor for conversation item requests.

**Data flow**: Reads `request.body_json()["item"]["content"][0]["text"]`, converts it to `Option<String>`, and returns it.

**Call relations**: Used within tests that need to identify or assert specific realtime text requests, often together with `wait_for_matching_websocket_request`.

*Call graph*: calls 1 internal fn (body_json).


##### `websocket_request_instructions`  (lines 115–121)

```
fn websocket_request_instructions(
    request: &core_test_support::responses::WebSocketRequest,
) -> Option<String>
```

**Purpose**: Extracts the session instructions string from a captured websocket request. It is the main helper for startup-context and backend-prompt assertions.

**Data flow**: Reads `request.body_json()["session"]["instructions"]`, converts it to `Option<String>`, and returns it.

**Call relations**: Many startup and configuration tests call this after capturing a `session.update` websocket request. It centralizes the JSON path for instruction inspection.

*Call graph*: calls 1 internal fn (body_json); called by 11 (conversation_disables_realtime_startup_context_with_empty_override, conversation_second_start_replaces_runtime, conversation_start_audio_text_close_round_trip, conversation_start_injects_startup_context_from_thread_history, conversation_startup_context_current_thread_selects_many_turns_by_budget, conversation_startup_context_falls_back_to_workspace_map, conversation_startup_context_is_truncated_and_sent_once_per_start, conversation_uses_default_realtime_backend_prompt, conversation_uses_empty_instructions_for_null_or_empty_prompt, conversation_uses_experimental_realtime_ws_backend_prompt_override (+1 more)).


##### `wait_for_websocket_request`  (lines 123–136)

```
async fn wait_for_websocket_request(
    server: &core_test_support::responses::WebSocketTestServer,
    connection_index: usize,
    request_index: usize,
) -> Result<core_test_support::responses::We
```

**Purpose**: Waits for a specific websocket request by connection and request index with a short timeout. It turns asynchronous server capture into a fallible helper with a descriptive timeout error.

**Data flow**: Accepts a websocket test server plus connection and request indices, awaits `server.wait_for_request(...)` under a two-second `timeout`, and returns the captured request or an `anyhow` error with contextual text if the timeout expires.

**Call relations**: Used by the WebRTC generated-session test to wait for the sideband `session.update` and queued text requests after the delayed websocket join.

*Call graph*: calls 1 internal fn (wait_for_request); called by 1 (conversation_webrtc_start_posts_generated_session); 2 external calls (from_secs, timeout).


##### `expected_realtime_backend_prompt`  (lines 138–142)

```
fn expected_realtime_backend_prompt() -> String
```

**Purpose**: Builds the expected default realtime backend prompt string with the user-first-name placeholder substituted. It lets tests compare against the runtime's default prompt generation.

**Data flow**: Takes the constant `REALTIME_BACKEND_PROMPT`, trims trailing whitespace, replaces `{{ user_first_name }}` with the result of `test_user_first_name()`, and returns the resulting `String`.

**Call relations**: Used by the default-backend-prompt test to compute the expected instructions text sent in `session.update`.

*Call graph*: calls 1 internal fn (test_user_first_name).


##### `test_user_first_name`  (lines 144–150)

```
fn test_user_first_name() -> String
```

**Purpose**: Derives a stable first-name-like string for tests from the current real name or username, falling back to `there`. It mirrors the placeholder substitution logic used in the realtime backend prompt.

**Data flow**: Reads `whoami::realname()` and `whoami::username()`, splits each on whitespace, takes the first non-empty token, and returns it; if none are usable, returns `"there"`.

**Call relations**: Only `expected_realtime_backend_prompt` calls this helper.

*Call graph*: called by 1 (expected_realtime_backend_prompt); 2 external calls (realname, username).


##### `wait_for_matching_websocket_request`  (lines 152–178)

```
async fn wait_for_matching_websocket_request(
    server: &core_test_support::responses::WebSocketTestServer,
    description: &str,
    predicate: F,
) -> core_test_support::responses::WebSocketReque
```

**Purpose**: Polls all captured websocket requests until one satisfies a caller-provided predicate or a deadline expires. It is the flexible request-synchronization primitive used throughout the startup-context and noop tests.

**Data flow**: Accepts a websocket test server, a human-readable description, and a predicate over `WebSocketRequest`. It repeatedly scans `server.connections()` for a cloned request matching the predicate, returning it when found; otherwise it sleeps 10 ms and retries until a 10-second deadline, after which it asserts and panics.

**Call relations**: Used by tests that cannot rely on fixed connection/request indices, such as startup-context assertions that search for the first request containing instructions or a specific request type.

*Call graph*: calls 1 internal fn (connections); called by 7 (conversation_disables_realtime_startup_context_with_empty_override, conversation_start_injects_startup_context_from_thread_history, conversation_startup_context_current_thread_selects_many_turns_by_budget, conversation_startup_context_falls_back_to_workspace_map, conversation_startup_context_is_truncated_and_sent_once_per_start, conversation_uses_experimental_realtime_ws_startup_context_override, realtime_v2_noop_tool_call_returns_empty_function_output_without_response); 5 external calls (from_millis, from_secs, assert!, now, sleep).


##### `run_realtime_conversation_test_in_subprocess`  (lines 180–210)

```
fn run_realtime_conversation_test_in_subprocess(
    test_name: &str,
    openai_api_key: Option<&str>,
) -> Result<()>
```

**Purpose**: Re-executes a specific realtime test in a subprocess with controlled environment variables. It isolates auth and proxy environment behavior that would otherwise be hard to test in-process.

**Data flow**: Builds a `Command` targeting the current test binary with `--exact <test_name>`, sets the subprocess marker env var, removes all proxy env vars listed in `codex_network_proxy::PROXY_ENV_KEYS`, conditionally sets or removes `OPENAI_API_KEY_ENV_VAR`, runs the command, and asserts the child exited successfully, including stdout/stderr in the failure message.

**Call relations**: Called by the tests that need to vary `OPENAI_API_KEY_ENV_VAR` or ensure preflight behavior under a clean environment. Those tests early-return to this helper when not already in the subprocess.

*Call graph*: called by 2 (conversation_start_preflight_failure_emits_realtime_error_only, conversation_start_uses_openai_env_key_fallback_with_chatgpt_auth); 3 external calls (assert!, new, current_exe).


##### `seed_recent_thread`  (lines 211–242)

```
async fn seed_recent_thread(
    test: &TestCodex,
    title: &str,
    first_user_message: &str,
    slug: &str,
) -> Result<()>
```

**Purpose**: Seeds thread metadata directly into the state DB and creates a placeholder rollout path so startup-context generation can discover recent work without paying for real model turns. It is a fixture helper for startup-context tests.

**Data flow**: Accepts a `TestCodex`, title, first user message, and slug; obtains the state DB from `test.codex`, creates a new `ThreadId`, computes `updated_at = Utc::now()`, writes an empty rollout file under the Codex home, builds `codex_state::ThreadMetadataBuilder` with session source `Cli`, fills cwd, model provider, git branch, title, and first user message, then upserts the metadata into the DB.

**Call relations**: Used by startup-context tests that need recent-session summaries. It bypasses rollout-writing logic and directly prepares the metadata that startup-context rendering consumes.

*Call graph*: calls 4 internal fn (codex_home_path, workspace_path, new, new); called by 4 (conversation_disables_realtime_startup_context_with_empty_override, conversation_start_injects_startup_context_from_thread_history, conversation_startup_context_is_truncated_and_sent_once_per_start, conversation_uses_experimental_realtime_ws_startup_context_override); 3 external calls (now, format!, write).


##### `conversation_start_audio_text_close_round_trip`  (lines 245–414)

```
async fn conversation_start_audio_text_close_round_trip() -> Result<()>
```

**Purpose**: Exercises the basic websocket realtime lifecycle: start a conversation, receive session update and audio output, send audio and text input, and close the conversation. It also verifies handshake headers, URI, default voice, and request ordering.

**Data flow**: Starts a websocket server with scripted responses across two connections, builds a websocket-backed `TestCodex`, submits `Op::RealtimeConversationStart` with audio output and explicit backend prompt, waits for `RealtimeConversationStarted` and `SessionUpdated`, submits `RealtimeConversationAudio` and `RealtimeConversationText`, waits for `AudioOut`, inspects captured websocket connections and handshakes for `session.update`, voice `cove`, instructions prefix, `x-session-id`, authorization header, and URI, then submits `RealtimeConversationClose` and waits for `RealtimeConversationClosed`.

**Call relations**: This direct test is the baseline realtime round-trip scenario. Many later tests vary one aspect of this flow—version, transport, prompt, voice, or failure mode.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 8 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationAudio, RealtimeConversationStart, RealtimeConversationText, skip_if_no_network!, vec!).


##### `conversation_start_defaults_to_v2_and_gpt_realtime_1_5`  (lines 417–480)

```
async fn conversation_start_defaults_to_v2_and_gpt_realtime_1_5() -> Result<()>
```

**Purpose**: Verifies the default realtime websocket version and model selection when no explicit version or model is supplied. It expects v2 and `gpt-realtime-1.5`.

**Data flow**: Starts a mock API server and websocket server, configures `experimental_realtime_ws_base_url` and empty startup context, builds `TestCodex`, submits `RealtimeConversationStart`, waits for `RealtimeConversationStarted`, then inspects the first realtime `session.update` request and handshake URI to assert started version `V2`, handshake URI `/v1/realtime?model=gpt-realtime-1.5`, default voice `marin`, and instructions `backend prompt`.

**Call relations**: Invoked directly by the test runner. It focuses on default configuration resolution rather than message exchange after startup.

*Call graph*: calls 3 internal fn (start_mock_server, start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_webrtc_start_posts_generated_session`  (lines 483–666)

```
async fn conversation_webrtc_start_posts_generated_session() -> Result<()>
```

**Purpose**: Tests WebRTC startup end to end: POSTing SDP plus generated session JSON to the call endpoint, emitting the SDP answer before sideband websocket join, queueing text until sideband connects, and then joining the call over websocket. It validates the multipart body and delayed sideband behavior.

**Data flow**: Starts a mock HTTP server with a captured POST `/realtime/calls` returning an SDP answer and `Location` header, plus a websocket server whose accept is delayed. Builds `TestCodex` with realtime backend prompt/model/startup context/base URL and version v1, submits `RealtimeConversationStart` with `ConversationStartTransport::Webrtc { sdp }`, waits for `RealtimeConversationSdp`, submits realtime text before sideband join, waits for `SessionUpdated`, inspects the captured HTTP request path, headers, multipart body, and normalized session JSON, then waits for sideband websocket requests to assert `session.update` includes startup context and the queued text is sent after join. Finally it closes the conversation and waits for `RealtimeConversationClosed`.

**Call relations**: This direct test combines `RealtimeCallRequestCapture`, `normalized_json_string`, and `wait_for_websocket_request`. It is the main positive-path WebRTC integration test.

*Call graph*: calls 6 internal fn (new, start_mock_server, start_websocket_server_with_headers, test_codex, normalized_json_string, wait_for_websocket_request); 13 external calls (from_millis, given, new, from_utf8, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, RealtimeConversationText, skip_if_no_network! (+3 more)).


##### `conversation_webrtc_start_uses_avas_architecture_query`  (lines 669–765)

```
async fn conversation_webrtc_start_uses_avas_architecture_query() -> Result<()>
```

**Purpose**: Verifies that starting a WebRTC realtime conversation with `RealtimeConversationArchitecture::Avas` adds `architecture=avas` to the call-creation query string and still joins the returned call id over websocket. It checks architecture-specific routing.

**Data flow**: Starts a mock HTTP call endpoint with request capture and a websocket sideband server, builds `TestCodex` with realtime backend prompt/base URL and version v1, submits `RealtimeConversationStart` using WebRTC transport and `architecture: Some(Avas)`, waits for the SDP answer and later `SessionUpdated`, then asserts the captured POST query is `intent=quicksilver&architecture=avas` and the websocket handshake URI uses the returned `call_id`.

**Call relations**: Called directly by the test runner. It is a focused variant of the generated-session WebRTC test that targets architecture query composition.

*Call graph*: calls 4 internal fn (new, start_mock_server, start_websocket_server_with_headers, test_codex); 9 external calls (given, new, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!, method, path_regex).


##### `conversation_webrtc_start_uses_configured_call_base_url_for_avas`  (lines 768–866)

```
async fn conversation_webrtc_start_uses_configured_call_base_url_for_avas() -> Result<()>
```

**Purpose**: Checks that WebRTC call creation for AVAS uses the configured call base URL while the sideband websocket still joins using the returned call id. It validates separation of HTTP call endpoint configuration from websocket base URL configuration.

**Data flow**: Starts a mock HTTP server with captured call endpoint and a websocket server, configures `experimental_realtime_webrtc_call_base_url` plus realtime websocket base URL and backend prompt, submits an AVAS WebRTC start, waits for SDP and `SessionUpdated`, then asserts the captured POST hit `/v1/realtime/calls` with `intent=quicksilver&architecture=avas` and the websocket handshake URI uses `/v1/realtime?intent=quicksilver&call_id=rtc_local_avas_test`.

**Call relations**: This direct test extends the previous AVAS query test by adding explicit call-base-url override coverage.

*Call graph*: calls 4 internal fn (new, start_mock_server, start_websocket_server_with_headers, test_codex); 10 external calls (given, new, assert_eq!, wait_for_event_match, format!, RealtimeConversationStart, skip_if_no_network!, vec!, method, path_regex).


##### `conversation_webrtc_close_while_sideband_connecting_drops_pending_join`  (lines 869–962)

```
async fn conversation_webrtc_close_while_sideband_connecting_drops_pending_join() -> Result<()>
```

**Purpose**: Verifies that closing a WebRTC conversation after receiving the SDP answer but before the delayed sideband websocket connects cancels the pending join task cleanly. No stale realtime error or close events should leak afterward.

**Data flow**: Starts a mock HTTP call endpoint and a websocket server with delayed accept, builds `TestCodex`, submits a WebRTC start, waits for the SDP answer, asserts no websocket handshake has occurred yet, submits `RealtimeConversationClose`, waits for a closed event with reason `requested`, then uses a short timeout to ensure no later realtime error or extra close event arrives and asserts the websocket server still saw no handshake.

**Call relations**: Invoked directly by the test runner. It targets cancellation behavior in the gap between media-leg setup and sideband websocket establishment.

*Call graph*: calls 3 internal fn (start_mock_server, start_websocket_server_with_headers, test_codex); 12 external calls (from_millis, given, new, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, timeout, vec! (+2 more)).


##### `conversation_webrtc_sideband_connect_failure_closes_with_error`  (lines 965–1052)

```
async fn conversation_webrtc_sideband_connect_failure_closes_with_error() -> Result<()>
```

**Purpose**: Checks that if the WebRTC sideband websocket cannot connect after call creation succeeds, the runtime emits a realtime error, closes the conversation with reason `error`, and rejects later realtime input as not running. It covers the post-SDP failure path.

**Data flow**: Starts a mock HTTP call endpoint returning SDP, configures realtime websocket base URL to an unreachable localhost port and retries to zero, builds `TestCodex`, submits a WebRTC start, waits for `RealtimeConversationStarted`, waits for the SDP answer, then waits for a realtime error event and a closed event with reason `error`. After closure it submits realtime text and asserts a normal `EventMsg::Error` reports `conversation is not running`.

**Call relations**: This direct test complements the pending-join cancellation test by covering actual sideband connection failure rather than user-requested close.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 10 external calls (given, new, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, RealtimeConversationText, skip_if_no_network!, method, path_regex).


##### `conversation_start_uses_openai_env_key_fallback_with_chatgpt_auth`  (lines 1055–1134)

```
async fn conversation_start_uses_openai_env_key_fallback_with_chatgpt_auth() -> Result<()>
```

**Purpose**: Verifies that realtime startup uses `OPENAI_API_KEY_ENV_VAR` as the authorization bearer token when the process has ChatGPT auth but realtime requires API-key auth. It tests auth fallback behavior in a subprocess-controlled environment.

**Data flow**: If not already in the subprocess, re-executes itself with `OPENAI_API_KEY_ENV_VAR=env-realtime-key`. In the subprocess it starts a websocket server, builds `TestCodex` with dummy ChatGPT auth, submits `RealtimeConversationStart`, waits for `RealtimeConversationStarted` and `SessionUpdated`, then asserts the second websocket handshake's `authorization` header is `Bearer env-realtime-key`. Finally it closes the conversation.

**Call relations**: This direct test delegates environment setup to `run_realtime_conversation_test_in_subprocess` on the first invocation. Inside the child it follows the normal websocket startup path and inspects handshake headers.

*Call graph*: calls 4 internal fn (start_websocket_server, test_codex, run_realtime_conversation_test_in_subprocess, create_dummy_chatgpt_auth_for_testing); 7 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, var_os, vec!).


##### `conversation_transport_close_emits_closed_event`  (lines 1137–1201)

```
async fn conversation_transport_close_emits_closed_event() -> Result<()>
```

**Purpose**: Ensures that when the websocket transport closes after startup, Codex emits `RealtimeConversationClosed` with reason `transport_closed`. It validates passive transport shutdown handling.

**Data flow**: Starts a websocket server that sends `session.updated` and then closes, builds `TestCodex`, submits `RealtimeConversationStart`, waits for `RealtimeConversationStarted` and `SessionUpdated`, then waits for `RealtimeConversationClosed` and asserts its reason is `transport_closed`.

**Call relations**: This direct test covers the transport-driven close path, distinct from explicit user close or startup failure.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_audio_before_start_emits_error`  (lines 1204–1233)

```
async fn conversation_audio_before_start_emits_error() -> Result<()>
```

**Purpose**: Checks that sending realtime audio before any conversation has started yields a bad-request error. It guards the runtime's precondition checks.

**Data flow**: Starts an empty websocket server, builds `TestCodex`, submits `Op::RealtimeConversationAudio` with one frame, waits for `EventMsg::Error`, and asserts `codex_error_info == Some(BadRequest)` and message `conversation is not running`.

**Call relations**: This direct test exercises the command-validation path without starting a realtime session.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 5 external calls (assert_eq!, wait_for_event_match, RealtimeConversationAudio, skip_if_no_network!, vec!).


##### `conversation_start_preflight_failure_emits_realtime_error_only`  (lines 1236–1287)

```
async fn conversation_start_preflight_failure_emits_realtime_error_only() -> Result<()>
```

**Purpose**: Verifies that a realtime start preflight failure emits only a realtime error event and does not emit a closed event. The tested preflight failure is missing API-key auth in a subprocess with no OpenAI env key.

**Data flow**: If not already in the subprocess, re-executes itself with `OPENAI_API_KEY_ENV_VAR` removed. In the subprocess it starts an empty websocket server, builds `TestCodex` with dummy ChatGPT auth, submits `RealtimeConversationStart`, waits for a `RealtimeEvent::Error` carrying `realtime conversation requires API key auth`, then uses a short timeout to assert no `RealtimeConversationClosed` event arrives.

**Call relations**: This direct test uses `run_realtime_conversation_test_in_subprocess` to control environment state. It targets the preflight validation branch before any transport connection is attempted.

*Call graph*: calls 4 internal fn (start_websocket_server, test_codex, run_realtime_conversation_test_in_subprocess, create_dummy_chatgpt_auth_for_testing); 9 external calls (from_millis, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, var_os, timeout, vec!).


##### `conversation_start_connect_failure_emits_realtime_error_only`  (lines 1290–1337)

```
async fn conversation_start_connect_failure_emits_realtime_error_only() -> Result<()>
```

**Purpose**: Checks that a websocket connection failure during realtime start emits a realtime error but no closed event. It distinguishes connect failure from a started-then-closed session.

**Data flow**: Starts an unused websocket server, builds `TestCodex` configured with an unreachable realtime websocket base URL and version v1, submits `RealtimeConversationStart`, waits for a non-empty realtime error message, then uses a short timeout to assert no `RealtimeConversationClosed` event is emitted.

**Call relations**: This direct test complements the preflight-failure test by covering failure after preflight but before a successful connection.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 7 external calls (from_millis, assert!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, timeout, vec!).


##### `conversation_text_before_start_emits_error`  (lines 1340–1364)

```
async fn conversation_text_before_start_emits_error() -> Result<()>
```

**Purpose**: Checks that sending realtime text before starting a conversation yields a bad-request error. It is the text-input counterpart to the audio-before-start test.

**Data flow**: Starts an empty websocket server, builds `TestCodex`, submits `Op::RealtimeConversationText` with user role and text `hello`, waits for `EventMsg::Error`, and asserts bad-request classification and message `conversation is not running`.

**Call relations**: This direct test exercises the same precondition guard as the audio-before-start test but for text input.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 5 external calls (assert_eq!, wait_for_event_match, RealtimeConversationText, skip_if_no_network!, vec!).


##### `conversation_second_start_replaces_runtime`  (lines 1367–1500)

```
async fn conversation_second_start_replaces_runtime() -> Result<()>
```

**Purpose**: Verifies that starting a second realtime conversation replaces the first runtime, so subsequent audio goes to the new websocket session and the old one is not reused. It checks runtime replacement semantics.

**Data flow**: Starts a websocket server scripted for three connections: startup, first conversation, and second conversation. Builds `TestCodex`, starts the first conversation with prompt `old` and session id `conv_old`, waits for `sess_old`, starts a second conversation with prompt `new` and session id `conv_new`, waits for `sess_new`, sends realtime audio, waits for `AudioOut`, then inspects captured connections and handshakes to assert the first session used `old` instructions and `x-session-id=conv_old`, the second used `new` instructions and `x-session-id=conv_new`, and the audio append went to the second connection.

**Call relations**: This direct test extends the baseline startup flow to cover replacement of an existing realtime runtime by a new start command.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 7 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationAudio, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_experimental_realtime_ws_base_url_override`  (lines 1503–1569)

```
async fn conversation_uses_experimental_realtime_ws_base_url_override() -> Result<()>
```

**Purpose**: Checks that realtime conversation traffic uses `experimental_realtime_ws_base_url` instead of the startup websocket server configured for the test harness. It validates explicit routing override.

**Data flow**: Starts separate startup and realtime websocket servers, builds `TestCodex` with the realtime base URL override and version v1, submits `RealtimeConversationStart`, waits for `SessionUpdated`, then asserts the startup server saw only its initial harness connection while the realtime server captured the actual `session.update` request.

**Call relations**: This direct test isolates base-URL override behavior by separating the harness websocket endpoint from the realtime endpoint.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_default_realtime_backend_prompt`  (lines 1572–1638)

```
async fn conversation_uses_default_realtime_backend_prompt() -> Result<()>
```

**Purpose**: Verifies that when no prompt is supplied in the start op, realtime startup uses the default backend prompt plus configured startup context. It checks default prompt synthesis.

**Data flow**: Starts a websocket server, builds `TestCodex` with `experimental_realtime_ws_startup_context = "controlled startup context"`, submits `RealtimeConversationStart` with `prompt: None`, waits for `SessionUpdated`, then extracts instructions from the captured `session.update` request and asserts they equal `expected_realtime_backend_prompt() + "\n\ncontrolled startup context"`.

**Call relations**: This direct test uses `expected_realtime_backend_prompt` and `websocket_request_instructions` to validate the default prompt path.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_empty_instructions_for_null_or_empty_prompt`  (lines 1641–1719)

```
async fn conversation_uses_empty_instructions_for_null_or_empty_prompt() -> Result<()>
```

**Purpose**: Checks that explicit null or empty prompt values produce empty realtime instructions rather than falling back to defaults. It distinguishes `prompt: None` from `prompt: Some(None)` and `prompt: Some(Some(""))`.

**Data flow**: Starts a websocket server scripted for two conversation starts, builds `TestCodex` with empty startup context, loops over `(Some(None), "sess_null")` and `(Some(Some(String::new())), "sess_empty")`, submits `RealtimeConversationStart` for each, waits for `SessionUpdated`, closes the conversation, then inspects the two captured `session.update` requests and asserts both instruction strings are empty.

**Call relations**: This direct test covers prompt-nullability semantics across two sequential starts on the same harness.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 7 external calls (new, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_explicit_start_voice`  (lines 1722–1777)

```
async fn conversation_uses_explicit_start_voice() -> Result<()>
```

**Purpose**: Verifies that an explicit `voice` in `ConversationStartParams` is sent in the realtime session update. It checks per-start voice override behavior.

**Data flow**: Starts a websocket server, builds `TestCodex`, submits `RealtimeConversationStart` with `voice: Some(RealtimeVoice::Breeze)`, waits for `SessionUpdated`, then asserts the captured `session.update` request contains `session.audio.output.voice == "breeze"`.

**Call relations**: This direct test focuses on start-op voice selection, contrasting with the configured-voice and wrong-version tests.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_configured_realtime_voice`  (lines 1780–1838)

```
async fn conversation_uses_configured_realtime_voice() -> Result<()>
```

**Purpose**: Checks that configured realtime voice in `config.realtime.voice` is used when the start op does not specify one. It validates config-default voice selection.

**Data flow**: Starts a websocket server, builds `TestCodex` with `config.realtime.voice = Some(Cove)`, submits `RealtimeConversationStart` without an explicit voice, waits for `SessionUpdated`, and asserts the captured `session.update` request uses `voice == "cove"`.

**Call relations**: This direct test complements the explicit-start-voice test by covering config-driven defaulting.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_rejects_voice_for_wrong_realtime_version`  (lines 1841–1875)

```
async fn conversation_rejects_voice_for_wrong_realtime_version() -> Result<()>
```

**Purpose**: Verifies that specifying a voice unsupported by the selected realtime version yields a realtime error. In this suite, v2 rejects `cove`.

**Data flow**: Starts a mock API server, builds `TestCodex` with `config.realtime.version = V2`, submits `RealtimeConversationStart` with `voice: Some(Cove)`, waits for a realtime error event, and asserts the message mentions that realtime voice `cove` is not supported for v2.

**Call relations**: This direct test targets version/voice validation before or during startup rather than transport behavior.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (assert!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!).


##### `conversation_uses_experimental_realtime_ws_backend_prompt_override`  (lines 1878–1937)

```
async fn conversation_uses_experimental_realtime_ws_backend_prompt_override() -> Result<()>
```

**Purpose**: Checks that configured `experimental_realtime_ws_backend_prompt` overrides the prompt supplied in the start op. It validates config precedence for backend prompt selection.

**Data flow**: Starts a websocket server, builds `TestCodex` with backend prompt override `prompt from config`, submits `RealtimeConversationStart` with `prompt from op`, waits for `SessionUpdated`, then extracts instructions from the captured `session.update` request and asserts they start with `prompt from config`.

**Call relations**: This direct test isolates backend-prompt precedence, using `websocket_request_instructions` for verification.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_experimental_realtime_ws_startup_context_override`  (lines 1940–2008)

```
async fn conversation_uses_experimental_realtime_ws_startup_context_override() -> Result<()>
```

**Purpose**: Verifies that configured startup context text replaces generated startup context content, even when recent thread metadata and workspace files exist. It ensures the override is literal and suppresses automatic sections.

**Data flow**: Starts separate startup and realtime websocket servers, builds `TestCodex` with realtime base URL, version v1, backend prompt override, and startup context override `custom startup context`, seeds recent thread metadata and workspace files, submits `RealtimeConversationStart`, waits for a websocket request containing instructions, extracts those instructions, and asserts they equal `prompt from config\n\ncustom startup context` and do not contain the startup-context header or workspace-map section.

**Call relations**: This direct test uses `seed_recent_thread`, `wait_for_matching_websocket_request`, and `websocket_request_instructions` to prove the override bypasses generated startup context.

*Call graph*: calls 5 internal fn (start_websocket_server, test_codex, seed_recent_thread, wait_for_matching_websocket_request, websocket_request_instructions); 7 external calls (assert!, assert_eq!, create_dir_all, write, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_disables_realtime_startup_context_with_empty_override`  (lines 2011–2078)

```
async fn conversation_disables_realtime_startup_context_with_empty_override() -> Result<()>
```

**Purpose**: Checks that setting the startup-context override to an empty string disables startup-context injection entirely. Only the backend prompt should remain in the session instructions.

**Data flow**: Starts startup and realtime websocket servers, builds `TestCodex` with realtime base URL, version v1, backend prompt override, and empty startup-context override, seeds recent thread metadata and workspace files, submits `RealtimeConversationStart`, waits for a websocket request containing instructions, and asserts the instructions equal `prompt from config` with no startup-context header or workspace-map content.

**Call relations**: This direct test is the empty-string counterpart to the custom-startup-context override test.

*Call graph*: calls 5 internal fn (start_websocket_server, test_codex, seed_recent_thread, wait_for_matching_websocket_request, websocket_request_instructions); 7 external calls (assert!, assert_eq!, create_dir_all, write, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_start_injects_startup_context_from_thread_history`  (lines 2081–2150)

```
async fn conversation_start_injects_startup_context_from_thread_history() -> Result<()>
```

**Purpose**: Verifies that generated startup context includes recent thread metadata and workspace map information when enabled. It checks the shape and content of the injected startup-context block.

**Data flow**: Starts startup and realtime websocket servers, builds `TestCodex` with realtime base URL and version v1, seeds one recent thread and workspace files, submits `RealtimeConversationStart`, waits for a websocket request containing instructions, extracts the startup-context text, and asserts it contains the startup-context open/close tags, header, recent-session summary, latest branch, user ask text, workspace map section, and README marker while excluding unrelated memory prompt text.

**Call relations**: This direct test exercises the generated startup-context path rather than config overrides.

*Call graph*: calls 5 internal fn (start_websocket_server, test_codex, seed_recent_thread, wait_for_matching_websocket_request, websocket_request_instructions); 6 external calls (assert!, create_dir_all, write, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_startup_context_current_thread_selects_many_turns_by_budget`  (lines 2153–2313)

```
async fn conversation_startup_context_current_thread_selects_many_turns_by_budget() -> Result<()>
```

**Purpose**: Tests how startup-context generation selects and truncates current-thread turns under a token budget when resuming from a seeded history. It snapshots the rendered section to review ordering, omission, and truncation together.

**Data flow**: Starts mock API and realtime websocket servers, constructs a sequence of long and short user/assistant turns as `RolloutItem::ResponseItem` history, builds `TestCodex`, shuts it down, resumes a thread with `InitialHistory::Forked(history)` and API-key auth, submits `RealtimeConversationStart`, waits for a websocket request containing instructions, isolates the `## Current Thread` section from the startup context, computes rendered-turn token counts, builds a snapshot string summarizing latest-source tokens, rendered turn count, over-budget turns, and the section body, asserts the snapshot with `insta`, and finally asserts that although the latest source exceeds 300 approximate tokens, no rendered turn exceeds the cap after truncation.

**Call relations**: This direct test is the most detailed startup-context budgeting check. It uses resumed-thread history rather than `seed_recent_thread` because it needs full turn content, not just metadata.

*Call graph*: calls 7 internal fn (auth_manager_from_auth, start_mock_server, start_websocket_server, test_codex, wait_for_matching_websocket_request, websocket_request_instructions, from_api_key); 7 external calls (assert_eq!, format!, assert_snapshot!, Forked, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_startup_context_falls_back_to_workspace_map`  (lines 2316–2372)

```
async fn conversation_startup_context_falls_back_to_workspace_map() -> Result<()>
```

**Purpose**: Verifies that when there is no recent thread history, startup-context generation still falls back to a workspace map. It ensures startup context remains useful in empty-history cases.

**Data flow**: Starts startup and realtime websocket servers, builds `TestCodex` with realtime base URL and version v1, creates workspace directories and files, submits `RealtimeConversationStart`, waits for a websocket request containing instructions, extracts the startup-context text, and asserts it contains startup-context framing plus the workspace-map section and the created file/directory names.

**Call relations**: This direct test covers the fallback branch of startup-context generation when only workspace structure is available.

*Call graph*: calls 4 internal fn (start_websocket_server, test_codex, wait_for_matching_websocket_request, websocket_request_instructions); 6 external calls (assert!, create_dir_all, write, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_startup_context_is_truncated_and_sent_once_per_start`  (lines 2375–2450)

```
async fn conversation_startup_context_is_truncated_and_sent_once_per_start() -> Result<()>
```

**Purpose**: Checks that oversized startup context is truncated to a bounded length and only included in the initial `session.update`, not repeated on later realtime text messages. It validates both size control and one-time emission.

**Data flow**: Starts startup and realtime websocket servers, seeds a recent thread with an oversized summary and a workspace marker file, builds `TestCodex`, submits `RealtimeConversationStart`, waits for a websocket request containing instructions, asserts the startup-context text contains framing and is at most about 20.5k characters, then submits realtime text `hello`, waits for a matching websocket request carrying that text, and asserts the text request is separate from the startup-context-bearing session update.

**Call relations**: This direct test uses `seed_recent_thread`, `wait_for_matching_websocket_request`, and `websocket_request_text` to prove startup context is bounded and not resent on subsequent realtime input.

*Call graph*: calls 5 internal fn (start_websocket_server, test_codex, seed_recent_thread, wait_for_matching_websocket_request, websocket_request_instructions); 7 external calls (assert!, assert_eq!, write, RealtimeConversationStart, RealtimeConversationText, skip_if_no_network!, vec!).


##### `conversation_user_text_turn_is_not_sent_to_realtime`  (lines 2453–2547)

```
async fn conversation_user_text_turn_is_not_sent_to_realtime() -> Result<()>
```

**Purpose**: Verifies that ordinary `Op::UserInput` turns continue to go through the Responses API even while a realtime conversation is running, and are not mirrored onto the realtime websocket. It checks separation between text-turn handling and realtime transport.

**Data flow**: Starts a mock API server with one SSE response and a realtime websocket server, builds `TestCodex` with realtime base URL and empty startup context, starts a realtime conversation and waits for `SessionUpdated`, submits a normal text `Op::UserInput`, waits for `TurnComplete`, asserts the Responses API request contains the user text, and inspects realtime connections to confirm only the initial `session.update` was sent there.

**Call relations**: This direct test bridges the normal turn pipeline and realtime runtime, proving they coexist without duplicating user text onto the realtime socket.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, start_websocket_server, test_codex); 7 external calls (default, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `realtime_v2_noop_tool_call_returns_empty_function_output_without_response`  (lines 2550–2639)

```
async fn realtime_v2_noop_tool_call_returns_empty_function_output_without_response() -> Result<()>
```

**Purpose**: Checks that a v2 realtime noop tool call results in an empty `function_call_output` item and does not trigger a `response.create` request. It validates the silent-tool-call path.

**Data flow**: Starts a mock API server and a realtime websocket server that emits `session.updated` followed by a `conversation.item.done` function call named `remain_silent`, builds `TestCodex` with realtime version v2, starts a realtime conversation, waits for `RealtimeEvent::NoopRequested` with the expected call id, then waits for the next websocket request and asserts it is a `conversation.item.create` carrying `function_call_output` with empty output. It then uses a short timeout around `wait_for_matching_websocket_request` to assert no `response.create` request appears.

**Call relations**: This direct test targets the v2 tool-call handling branch and uses the flexible websocket-request matcher to prove absence of a follow-up response request.

*Call graph*: calls 4 internal fn (start_mock_server, start_websocket_server, test_codex, wait_for_matching_websocket_request); 8 external calls (from_millis, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, timeout, vec!).


##### `conversation_mirrors_assistant_message_text_to_realtime_handoff`  (lines 2642–2759)

```
async fn conversation_mirrors_assistant_message_text_to_realtime_handoff() -> Result<()>
```

**Purpose**: Verifies that when realtime requests a handoff and the delegated Responses API turn produces an assistant message, that final assistant text is mirrored back to realtime via `conversation.handoff.append`. It checks the outbound handoff bridge.

**Data flow**: Starts a mock API server whose SSE stream yields one assistant message `assistant says hi`, plus a realtime websocket server that emits `session.updated`, transcript delta, and `conversation.handoff.requested`. Builds `TestCodex`, starts realtime, waits for `SessionUpdated` and `HandoffRequested`, waits for the delegated turn to complete, then polls realtime connections until a second request appears and asserts it is `conversation.handoff.append` with the expected `handoff_id` and output text prefixed by `"Agent Final Message":`.

**Call relations**: This direct test ties together inbound realtime handoff, delegated model turn execution, and outbound mirroring of the assistant result back to realtime.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, start_websocket_server, test_codex); 10 external calls (from_millis, from_secs, assert_eq!, wait_for_event, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, now, sleep, vec!).


##### `conversation_handoff_persists_across_item_done_until_turn_complete`  (lines 2762–2919)

```
async fn conversation_handoff_persists_across_item_done_until_turn_complete() -> Result<()>
```

**Purpose**: Checks that an active handoff remains in effect even after a realtime `conversation.item.done` event, until the delegated turn fully completes. Multiple assistant messages from the delegated turn should still be mirrored back under the same handoff id.

**Data flow**: Starts a streaming SSE server whose first delegated turn emits two assistant messages gated by a oneshot channel, and a realtime websocket server that emits `session.updated`, `handoff.requested`, then later `conversation.item.done`. Builds `TestCodex`, starts realtime, waits for `SessionUpdated` and `HandoffRequested`, asserts the first mirrored `conversation.handoff.append` contains `assistant message 1`, waits for `ConversationItemDone`, releases the gate so the second assistant message arrives, asserts a second mirrored append contains `assistant message 2`, then waits for delegated completion and `TurnComplete`.

**Call relations**: This direct test extends the handoff-mirroring path to cover persistence of handoff state across intermediate realtime item completion events.

*Call graph*: calls 3 internal fn (start_websocket_server, start_streaming_sse_server, test_codex); 7 external calls (assert_eq!, wait_for_event, wait_for_event_match, channel, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `sse_event`  (lines 2921–2923)

```
fn sse_event(event: Value) -> String
```

**Purpose**: Wraps a single JSON event into an SSE-formatted string using the shared response helper. It keeps the streaming SSE fixtures concise.

**Data flow**: Accepts a `serde_json::Value`, wraps it in a one-element vector, passes it to `responses::sse`, and returns the resulting `String`.

**Call relations**: Used by the streaming SSE handoff tests when constructing chunk bodies for `start_streaming_sse_server`.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `message_input_texts`  (lines 2925–2937)

```
fn message_input_texts(body: &Value, role: &str) -> Vec<String>
```

**Purpose**: Extracts all `input_text` strings for messages of a given role from a raw request JSON body. It is a local JSON-inspection helper for delegated-turn assertions.

**Data flow**: Reads `body["input"]` as an array, filters items of type `message` and the requested role, flattens their `content` arrays, keeps spans of type `input_text`, collects their `text` strings, and returns them as `Vec<String>`.

**Call relations**: Used by the tests that inspect delegated Responses API requests generated from realtime handoff events.

*Call graph*: called by 2 (inbound_handoff_request_starts_turn_and_does_not_block_realtime_audio, inbound_handoff_request_steers_active_turn); 1 external calls (get).


##### `inbound_handoff_request_starts_turn`  (lines 2940–3034)

```
async fn inbound_handoff_request_starts_turn() -> Result<()>
```

**Purpose**: Verifies that an inbound realtime `conversation.handoff.requested` event starts a delegated Responses API turn whose user input contains a `<realtime_delegation>` block. It checks the inbound handoff bridge into the normal turn pipeline.

**Data flow**: Starts a mock API server with one assistant response and a realtime websocket server that emits `session.updated`, transcript delta, and `handoff.requested`, builds `TestCodex`, starts realtime, waits for `SessionUpdated` and the matching `HandoffRequested`, waits for `TurnComplete`, then inspects the captured Responses API request and asserts one user text equals the expected `<realtime_delegation>` XML containing the input and transcript delta.

**Call relations**: This direct test is the baseline inbound-handoff-to-turn path. Later tests vary transcript accumulation and interaction with active turns.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, start_websocket_server, test_codex); 7 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `inbound_handoff_request_uses_active_transcript`  (lines 3037–3126)

```
async fn inbound_handoff_request_uses_active_transcript() -> Result<()>
```

**Purpose**: Checks that the delegated `<realtime_delegation>` block uses the accumulated active transcript, not just the handoff event's `input_transcript` field. It verifies transcript assembly across assistant and user deltas.

**Data flow**: Starts a mock API server and a realtime websocket server that emits `session.updated`, assistant transcript delta, user transcript delta, another assistant delta, and then `handoff.requested` with `input_transcript = "ignored"`, builds `TestCodex`, starts realtime, waits for startup and turn completion, then inspects the captured Responses API request and asserts the user text contains a `<realtime_delegation>` block whose `<transcript_delta>` concatenates all active transcript lines in order and ends with `user: ignored`.

**Call relations**: This direct test extends the inbound handoff path by validating transcript accumulation logic before delegation.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, start_websocket_server, test_codex); 6 external calls (assert!, wait_for_event, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `inbound_handoff_request_sends_transcript_delta_after_each_handoff`  (lines 3129–3257)

```
async fn inbound_handoff_request_sends_transcript_delta_after_each_handoff() -> Result<()>
```

**Purpose**: Verifies that transcript delta state is cleared between separate handoffs, so each delegated turn receives only the transcript accumulated since the previous handoff. It prevents transcript growth across unrelated delegated turns.

**Data flow**: Starts a mock API server with two sequential SSE responses and a realtime websocket server that emits one handoff sequence, then later another after an intervening audio submission. Builds `TestCodex`, starts realtime, waits for the first delegated turn to complete, submits realtime audio to keep the session active, waits for the second delegated turn to complete, then inspects both captured Responses API requests. It asserts the first contains only `user: first question` and the second contains only `user: second question`, not a concatenation of both.

**Call relations**: This direct test covers repeated inbound handoffs on one realtime session and validates transcript reset semantics between them.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, start_websocket_server, test_codex); 8 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, RealtimeConversationAudio, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `inbound_conversation_item_does_not_start_turn_and_still_forwards_audio`  (lines 3260–3349)

```
async fn inbound_conversation_item_does_not_start_turn_and_still_forwards_audio() -> Result<()>
```

**Purpose**: Checks that an inbound realtime `conversation.item.added` user message does not itself trigger a delegated turn, while unrelated realtime audio output continues to be forwarded. It distinguishes passive conversation items from explicit handoff requests.

**Data flow**: Starts a mock API server and a realtime websocket server that emits `session.updated`, a `conversation.item.added` user message, and an audio delta, builds `TestCodex`, starts realtime, waits for `SessionUpdated`, then waits under timeout for `AudioOut` and asserts its data. It also waits under a shorter timeout for `TurnStarted` and asserts that no such event occurs.

**Call relations**: This direct test guards against over-eager delegation logic by proving only handoff requests, not arbitrary conversation items, start turns.

*Call graph*: calls 3 internal fn (start_mock_server, start_websocket_server, test_codex); 8 external calls (from_millis, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, timeout, vec!).


##### `delegated_turn_user_role_echo_does_not_redelegate_and_still_forwards_audio`  (lines 3352–3526)

```
async fn delegated_turn_user_role_echo_does_not_redelegate_and_still_forwards_audio() -> Result<()>
```

**Purpose**: Verifies that when a delegated turn's assistant output is mirrored back to realtime and the realtime side echoes that text as a user-role conversation item, Codex does not start a second delegated turn. Audio forwarding must still continue normally.

**Data flow**: Starts a streaming SSE server whose delegated turn emits one assistant message and completes after a gate, plus a realtime websocket server that emits `session.updated`, `handoff.requested`, then later a user-role `conversation.item.added` echoing `assistant says hi` and an audio delta. Builds `TestCodex`, starts realtime, waits for the handoff request, asserts the mirrored `conversation.handoff.append` request contains the assistant text, waits for `AudioOut`, releases the completion gate, waits for `TurnComplete`, then asserts the API server saw exactly one request total.

**Call relations**: This direct test combines handoff mirroring, echo suppression, and audio forwarding. It protects against feedback loops between delegated turns and realtime conversation items.

*Call graph*: calls 3 internal fn (start_websocket_server, start_streaming_sse_server, test_codex); 9 external calls (assert_eq!, wait_for_event, wait_for_event_match, eprintln!, channel, RealtimeConversationStart, skip_if_no_network!, now, vec!).


##### `inbound_handoff_request_does_not_block_realtime_event_forwarding`  (lines 3529–3643)

```
async fn inbound_handoff_request_does_not_block_realtime_event_forwarding() -> Result<()>
```

**Purpose**: Checks that while a delegated turn triggered by an inbound handoff is still pending, unrelated realtime events such as audio output continue to be forwarded promptly. It validates concurrency between delegated turn execution and realtime event handling.

**Data flow**: Starts a streaming SSE server whose delegated turn completion is gated, plus a realtime websocket server that emits `session.updated`, transcript delta, `handoff.requested`, and an audio delta. Builds `TestCodex`, starts realtime, waits for `SessionUpdated` and `HandoffRequested`, then waits under timeout for `AudioOut` and asserts its data before releasing the delegated-turn completion gate. After completion it waits for `TurnComplete`.

**Call relations**: This direct test focuses on non-blocking behavior during delegated turn execution, complementing the handoff-start tests.

*Call graph*: calls 3 internal fn (start_websocket_server, start_streaming_sse_server, test_codex); 9 external calls (from_millis, assert_eq!, wait_for_event, wait_for_event_match, channel, RealtimeConversationStart, skip_if_no_network!, timeout, vec!).


##### `inbound_handoff_request_steers_active_turn`  (lines 3646–3826)

```
async fn inbound_handoff_request_steers_active_turn() -> Result<()>
```

**Purpose**: Verifies that an inbound handoff arriving while a normal user turn is already active does not retroactively alter the in-flight request, but instead steers the next turn by adding a `<realtime_delegation>` block there. It checks active-turn steering semantics.

**Data flow**: Starts a streaming SSE server with two sequential Responses API turns and a realtime websocket server that emits `session.updated` and later a handoff request on the same connection. Builds `TestCodex`, starts realtime, submits a normal `Op::UserInput` text turn, waits for an agent content delta to ensure the first turn is active, submits realtime audio to keep the session flowing, waits for the handoff request, releases the first turn completion gate, waits for both API requests and final `TurnComplete`, then parses both request bodies and extracts user texts with `message_input_texts`. It asserts the first request contains only `first prompt`, while the second contains both `first prompt` and the expected `<realtime_delegation>` block.

**Call relations**: This direct test is the main coverage for steering behavior when realtime delegation arrives during an already-running standard turn.

*Call graph*: calls 4 internal fn (start_websocket_server_with_headers, start_streaming_sse_server, test_codex, message_input_texts); 11 external calls (default, assert!, assert_eq!, wait_for_event, wait_for_event_match, channel, RealtimeConversationAudio, RealtimeConversationStart, from_slice, skip_if_no_network! (+1 more)).


##### `inbound_handoff_request_starts_turn_and_does_not_block_realtime_audio`  (lines 3829–3954)

```
async fn inbound_handoff_request_starts_turn_and_does_not_block_realtime_audio() -> Result<()>
```

**Purpose**: Combines inbound handoff delegation with concurrent realtime audio forwarding, verifying that the delegated turn starts correctly and audio output is still delivered before the delegated turn completes. It is a focused concurrency regression test.

**Data flow**: Starts a streaming SSE server whose delegated turn completion is gated and a realtime websocket server that emits `session.updated`, transcript delta, `handoff.requested`, and an audio delta. Builds `TestCodex`, starts realtime, waits for `SessionUpdated` and the matching `HandoffRequested`, waits under timeout for `AudioOut`, releases the delegated-turn completion gate, waits for `TurnComplete`, then parses the sole API request and asserts its user texts include the expected `<realtime_delegation>` block.

**Call relations**: This direct test overlaps with the non-blocking handoff test but also verifies the exact delegated request body, making it a combined correctness-and-concurrency check.

*Call graph*: calls 4 internal fn (start_websocket_server, start_streaming_sse_server, test_codex, message_input_texts); 12 external calls (from_millis, assert!, assert_eq!, wait_for_event, wait_for_event_match, format!, channel, RealtimeConversationStart, from_slice, skip_if_no_network! (+2 more)).


### Turn continuity and compaction
These tests focus on preserving and reshaping conversation state across follow-ups, including remote compaction, lite-mode variants, and per-turn transport state.

### `core/tests/suite/compact_remote.rs`

`test` · `request handling`

This file focuses on remote compaction paths, both legacy `/v1/responses/compact` and v2 inline compaction via a `compaction_trigger` item on `/v1/responses`. It defines helpers for approximate token estimation, canonical JSON normalization, compacted-summary output construction, realtime conversation setup/teardown, and request-shape snapshot formatting. Most tests use `TestCodexHarness` to build a full thread with ChatGPT or API-key auth, mount normal response streams plus either a remote compact endpoint or an inline v2 compaction response, then drive user turns and `Op::Compact` while inspecting captured requests and emitted events.

The suite covers several dimensions. Manual remote compaction should send the right auth/session/thread headers, compaction metadata, and request fields, then replace follow-up history with the returned compaction item(s). A parity helper compares the shared request fields between a normal `/responses` request and a remote compact request, including prompt-cache-key reuse and service-tier differences between auth modes. Automatic remote compaction is tested both pre-turn and mid-turn, including failure handling, context-compaction lifecycle events, trimming of oversized function-call and tool-search outputs to fit the context window, and use of session base instructions in trim estimation. Realtime-specific tests start a websocket realtime conversation and verify that after compaction the next request restates either realtime-start or realtime-end instructions depending on whether the conversation is still active, unless the current turn already established the inactive baseline. Finally, turn-state propagation is checked for legacy HTTP compact, v2 HTTP compact, and v2 websocket compact: once sampling establishes `x-codex-turn-state`, later compact and continuation requests must replay that first value rather than replacing it with newer headers.

#### Function details

##### `approx_token_count`  (lines 53–55)

```
fn approx_token_count(text: &str) -> i64
```

**Purpose**: Provides a rough token estimate for a text string by dividing character count by four.

**Data flow**: It computes `(len + 3) / 4`, converts to `i64`, and saturates to `i64::MAX` on conversion failure.

**Call relations**: Token-trimming tests use this helper indirectly through compact-payload estimators.

*Call graph*: called by 2 (estimate_compact_payload_tokens, remote_compact_trim_estimate_uses_session_base_instructions); 1 external calls (try_from).


##### `estimate_compact_input_tokens`  (lines 57–61)

```
fn estimate_compact_input_tokens(request: &responses::ResponsesRequest) -> i64
```

**Purpose**: Estimates the token count of a compact request’s `input` items by summing approximate token counts of each serialized item.

**Data flow**: It iterates over `request.input()`, converts each item to a string, estimates its token count with `approx_token_count`, and returns the saturating sum.

**Call relations**: The base-instructions trim-estimate test uses this helper to compare baseline and override compact payload sizes.

*Call graph*: calls 1 internal fn (input); called by 2 (estimate_compact_payload_tokens, remote_compact_trim_estimate_uses_session_base_instructions).


##### `estimate_compact_payload_tokens`  (lines 63–66)

```
fn estimate_compact_payload_tokens(request: &responses::ResponsesRequest) -> i64
```

**Purpose**: Estimates the total token count of a compact request payload, including both input items and instructions text.

**Data flow**: It calls `estimate_compact_input_tokens(request)`, estimates tokens for `request.instructions_text()`, and returns the saturating sum.

**Call relations**: This helper is used when proving that longer session base instructions can force trimming decisions.

*Call graph*: calls 3 internal fn (instructions_text, approx_token_count, estimate_compact_input_tokens); called by 1 (remote_compact_trim_estimate_uses_session_base_instructions).


##### `assert_tools_payload_does_not_defer`  (lines 68–75)

```
fn assert_tools_payload_does_not_defer(body: &Value)
```

**Purpose**: Asserts that a request’s model-visible `tools` payload contains no `defer_loading: true` declarations anywhere in the structure.

**Data flow**: It reads `body["tools"]` if present, recursively checks it with `contains_defer_loading`, and fails the test if any deferred declaration is found.

**Call relations**: The deferred-dynamic-tool filtering test uses this helper on both normal response and compact requests.

*Call graph*: called by 1 (remote_compact_filters_deferred_dynamic_tools); 2 external calls (get, assert!).


##### `namespace_child_tool_names`  (lines 77–102)

```
fn namespace_child_tool_names(body: &Value, namespace: &str) -> Vec<String>
```

**Purpose**: Extracts the child tool names from a namespace tool declaration in a request body.

**Data flow**: It scans `body["tools"]` for a namespace entry with the requested name, then collects the `name` field from each child tool in that namespace, defaulting to empty if absent.

**Call relations**: The deferred-dynamic-tool filtering test uses this helper to assert only visible child tools remain under a namespace.

*Call graph*: 1 external calls (get).


##### `contains_defer_loading`  (lines 104–113)

```
fn contains_defer_loading(value: &Value) -> bool
```

**Purpose**: Recursively checks whether a JSON value contains any `defer_loading: true` field.

**Data flow**: It pattern-matches on objects and arrays, recursively scanning nested values; scalars return false.

**Call relations**: This is the recursive worker behind `assert_tools_payload_does_not_defer`.


##### `canonical_json`  (lines 115–130)

```
fn canonical_json(value: &Value) -> Value
```

**Purpose**: Recursively sorts object keys to produce a canonicalized JSON value for stable equality comparisons.

**Data flow**: It clones scalars unchanged, maps arrays recursively, and for objects sorts key/value pairs by key before rebuilding the object.

**Call relations**: The remote compact request-parity helper uses this to compare request bodies independent of object key order.

*Call graph*: called by 1 (assert_remote_manual_compact_request_parity); 3 external calls (Array, Object, clone).


##### `summary_with_prefix`  (lines 137–139)

```
fn summary_with_prefix(summary: &str) -> String
```

**Purpose**: Formats a summary string as the canonical compaction payload by prepending `SUMMARY_PREFIX` and a newline.

**Data flow**: It returns `format!("{SUMMARY_PREFIX}\n{summary}")`.

**Call relations**: Several snapshot and compact-output helpers use this when constructing expected compaction items.

*Call graph*: called by 3 (snapshot_request_shape_remote_mid_turn_continuation_compaction, snapshot_request_shape_remote_pre_turn_compaction_including_incoming_user_message, snapshot_request_shape_remote_pre_turn_compaction_strips_incoming_model_switch); 1 external calls (format!).


##### `context_snapshot_options`  (lines 141–145)

```
fn context_snapshot_options() -> ContextSnapshotOptions
```

**Purpose**: Builds the standard request-snapshot rendering options for this file.

**Data flow**: It starts from default snapshot options, strips capability instructions, sets `KindWithTextPrefix { max_chars: 64 }`, and returns the result.

**Call relations**: Snapshot-formatting helpers call this to normalize all request-shape snapshots.

*Call graph*: calls 1 internal fn (default); called by 1 (format_labeled_requests_snapshot).


##### `format_labeled_requests_snapshot`  (lines 147–156)

```
fn format_labeled_requests_snapshot(
    scenario: &str,
    sections: &[(&str, &responses::ResponsesRequest)],
) -> String
```

**Purpose**: Formats a labeled multi-request snapshot string using the file’s standard snapshot options.

**Data flow**: It forwards the scenario label, request sections, and `context_snapshot_options()` into `context_snapshot::format_labeled_requests_snapshot`.

**Call relations**: Many snapshot tests use this helper when asserting remote compaction request shapes.

*Call graph*: calls 2 internal fn (format_labeled_requests_snapshot, context_snapshot_options).


##### `compacted_summary_only_output`  (lines 158–163)

```
fn compacted_summary_only_output(summary: &str) -> Vec<ResponseItem>
```

**Purpose**: Builds a remote compact output consisting of a single `ResponseItem::Compaction` with a prefixed summary.

**Data flow**: It takes a summary string, wraps it with `summary_with_prefix`, places it in a one-element `Vec<ResponseItem::Compaction>`, and returns it.

**Call relations**: Tests that need a summary-only remote compact response use this helper to avoid repeating the item construction.

*Call graph*: 1 external calls (vec!).


##### `test_codex`  (lines 165–169)

```
fn test_codex() -> TestCodexBuilder
```

**Purpose**: Returns a `TestCodexBuilder` preconfigured with `RemoteCompactionV2` disabled by default.

**Data flow**: It starts from the base `test_codex` builder and applies a config closure that disables `Feature::RemoteCompactionV2`.

**Call relations**: Nearly every test in this file starts from this builder so legacy remote compaction is the default unless a test explicitly enables v2.

*Call graph*: calls 1 internal fn (test_codex); called by 31 (assert_remote_manual_compact_request_parity, auto_remote_compact_failure_stops_agent_loop, auto_remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_and_resume_refresh_stale_developer_instructions, remote_compact_filters_deferred_dynamic_tools, remote_compact_persists_replacement_history_in_rollout, remote_compact_refreshes_stale_developer_instructions_without_resume, remote_compact_replaces_history_for_followups, remote_compact_rewrites_multiple_trailing_function_call_outputs, remote_compact_runs_automatically (+15 more)).


##### `remote_realtime_test_codex_builder`  (lines 171–180)

```
fn remote_realtime_test_codex_builder(
    realtime_server: &responses::WebSocketTestServer,
) -> TestCodexBuilder
```

**Purpose**: Builds a `TestCodexBuilder` configured to talk to a mock realtime websocket server.

**Data flow**: It reads the realtime server URI, starts from `test_codex()`, adds dummy API-key auth, and sets `experimental_realtime_ws_base_url` in config.

**Call relations**: Realtime-restatement tests use this helper to create a thread that can start and close realtime conversations.

*Call graph*: calls 3 internal fn (uri, test_codex, from_api_key); called by 6 (remote_request_uses_custom_experimental_realtime_start_instructions, snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start).


##### `start_remote_realtime_server`  (lines 182–200)

```
async fn start_remote_realtime_server() -> responses::WebSocketTestServer
```

**Purpose**: Starts a websocket server scripted to accept a realtime conversation and keep the socket open for later transcript routing.

**Data flow**: It calls `start_websocket_server` with a scripted connection whose first request returns a `session.updated` event and whose later request slots are empty vectors so the connection remains active.

**Call relations**: Realtime tests call this before building the codex harness so they can start a realtime conversation against a predictable backend.

*Call graph*: calls 1 internal fn (start_websocket_server); called by 6 (remote_request_uses_custom_experimental_realtime_start_instructions, snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start); 1 external calls (vec!).


##### `start_realtime_conversation`  (lines 202–240)

```
async fn start_realtime_conversation(codex: &codex_core::CodexThread) -> Result<()>
```

**Purpose**: Starts a realtime conversation on a `CodexThread` and waits until both the high-level start event and the low-level `SessionUpdated` realtime event arrive.

**Data flow**: It submits `Op::RealtimeConversationStart` with audio output and startup context enabled, waits for either `RealtimeConversationStarted` or `Error`, then waits for a `RealtimeConversationRealtime(SessionUpdated)` event carrying the realtime session id.

**Call relations**: Realtime restatement tests call this before sending user turns so the thread has active realtime state to preserve or restate after compaction.

*Call graph*: calls 1 internal fn (submit); called by 6 (remote_request_uses_custom_experimental_realtime_start_instructions, snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start); 2 external calls (wait_for_event_match, RealtimeConversationStart).


##### `close_realtime_conversation`  (lines 242–250)

```
async fn close_realtime_conversation(codex: &codex_core::CodexThread) -> Result<()>
```

**Purpose**: Closes an active realtime conversation and waits for the corresponding closed event.

**Data flow**: It submits `Op::RealtimeConversationClose`, waits for `EventMsg::RealtimeConversationClosed`, and returns success.

**Call relations**: Realtime tests call this to switch the thread from active to inactive realtime state before later compaction or follow-up turns.

*Call graph*: calls 1 internal fn (submit); called by 6 (remote_request_uses_custom_experimental_realtime_start_instructions, snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start); 1 external calls (wait_for_event_match).


##### `assert_request_contains_realtime_start`  (lines 252–262)

```
fn assert_request_contains_realtime_start(request: &responses::ResponsesRequest)
```

**Purpose**: Asserts that a request body restates active realtime-conversation instructions rather than inactive-end instructions.

**Data flow**: It serializes the request body to a string and asserts it contains `<realtime_conversation>` but not `Reason: inactive`.

**Call relations**: Realtime-start restatement tests use this helper on post-compaction or post-manual-compact follow-up requests.

*Call graph*: calls 1 internal fn (body_json); called by 2 (snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start); 1 external calls (assert!).


##### `assert_request_contains_custom_realtime_start`  (lines 264–281)

```
fn assert_request_contains_custom_realtime_start(
    request: &responses::ResponsesRequest,
    instructions: &str,
)
```

**Purpose**: Asserts that a request body contains a custom configured realtime-start instruction string inside the realtime wrapper.

**Data flow**: It serializes the request body, asserts it contains `<realtime_conversation>` and the supplied custom instructions, and asserts it does not contain the default `Realtime conversation started.` text.

**Call relations**: The custom experimental realtime-start-instructions test uses this helper on the first normal request after starting realtime.

*Call graph*: calls 1 internal fn (body_json); called by 1 (remote_request_uses_custom_experimental_realtime_start_instructions); 1 external calls (assert!).


##### `assert_request_contains_realtime_end`  (lines 283–293)

```
fn assert_request_contains_realtime_end(request: &responses::ResponsesRequest)
```

**Purpose**: Asserts that a request body restates inactive realtime-conversation instructions.

**Data flow**: It serializes the request body and asserts it contains both `<realtime_conversation>` and `Reason: inactive`.

**Call relations**: Realtime-end restatement tests use this helper on post-compaction or resumed follow-up requests.

*Call graph*: calls 1 internal fn (body_json); called by 3 (snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end); 1 external calls (assert!).


##### `wait_for_turn_complete`  (lines 295–302)

```
async fn wait_for_turn_complete(codex: &codex_core::CodexThread)
```

**Purpose**: Waits for `TurnComplete` with a longer timeout suitable for remote compaction tests.

**Data flow**: It calls `wait_for_event_with_timeout` on the codex thread, matching `EventMsg::TurnComplete(_)` and using `REMOTE_COMPACT_TURN_COMPLETE_TIMEOUT`.

**Call relations**: Most tests in this file use this helper instead of the shorter generic wait to avoid flakiness around remote compaction and realtime flows.

*Call graph*: called by 11 (assert_remote_manual_compact_request_parity, remote_compact_filters_deferred_dynamic_tools, remote_compact_replaces_history_for_followups, remote_compact_trims_tool_search_output_to_empty_tools_array, remote_compact_v2_accepts_additional_output_items_before_compaction, remote_compact_v2_retries_failures_with_stream_retry_budget, remote_compact_v2_reuses_compaction_trigger_for_followups, remote_mid_turn_compact_v1_sends_turn_state_over_http, remote_mid_turn_compact_v2_sends_turn_state_over_http, remote_mid_turn_compact_v2_sends_turn_state_over_websocket (+1 more)); 1 external calls (wait_for_event_with_timeout).


##### `remote_compact_replaces_history_for_followups`  (lines 305–530)

```
async fn remote_compact_replaces_history_for_followups() -> Result<()>
```

**Purpose**: Verifies the baseline legacy remote manual compaction flow: the compact request hits `/v1/responses/compact` with correct headers/metadata, and the next turn uses the returned compaction item as history.

**Data flow**: It builds a ChatGPT-auth harness, mounts one normal response, one follow-up response, and a compact endpoint returning a single compaction item, submits a user turn, `Op::Compact`, and another user turn, then inspects compact-request headers/body and the follow-up request body/metadata to assert compaction replacement semantics.

**Call relations**: This is the foundational remote manual compaction test and the main source of header/metadata assertions for the legacy endpoint.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 9 external calls (default, assert!, assert_eq!, assert_ne!, assert_snapshot!, from_str, json!, skip_if_no_network!, vec!).


##### `assert_remote_manual_compact_request_parity`  (lines 532–765)

```
async fn assert_remote_manual_compact_request_parity(
    auth: CodexAuth,
    configured_service_tier: Option<ServiceTier>,
    expected_service_tier: Option<&str>,
    snapshot_name: &str,
    scena
```

**Purpose**: Compares a remote manual compact request against a normal `/responses` request to ensure shared request fields match, while allowing auth-dependent service-tier differences.

**Data flow**: It builds a harness with chosen auth and optional configured service tier, runs five varied turns plus a manual compact, captures the last normal request and the compact request, removes response-only fields from the expected body, canonicalizes both JSON objects, asserts prompt-cache-key reuse and expected service-tier behavior, and snapshots the diff.

**Call relations**: The two service-tier/prompt-cache-key tests call this helper with different auth cases to validate parity rules without duplicating the long scenario setup.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, canonical_json, test_codex, wait_for_turn_complete); called by 2 (remote_manual_compact_api_auth_omits_service_tier_and_reuses_prompt_cache_key, remote_manual_compact_chatgpt_auth_reuses_service_tier_and_prompt_cache_key); 4 external calls (default, assert_eq!, assert_snapshot!, vec!).


##### `remote_manual_compact_api_auth_omits_service_tier_and_reuses_prompt_cache_key`  (lines 768–782)

```
async fn remote_manual_compact_api_auth_omits_service_tier_and_reuses_prompt_cache_key() -> Result<()>
```

**Purpose**: Checks that under API-key auth, legacy remote compact omits `service_tier` while still reusing the prompt-cache key.

**Data flow**: It calls `assert_remote_manual_compact_request_parity` with API-key auth, configured fast service tier, and an expectation that the compact request has no `service_tier` field.

**Call relations**: This is a thin auth-specific wrapper around the parity helper.

*Call graph*: calls 2 internal fn (assert_remote_manual_compact_request_parity, from_api_key); 1 external calls (skip_if_no_network!).


##### `remote_manual_compact_chatgpt_auth_reuses_service_tier_and_prompt_cache_key`  (lines 785–799)

```
async fn remote_manual_compact_chatgpt_auth_reuses_service_tier_and_prompt_cache_key() -> Result<()>
```

**Purpose**: Checks that under ChatGPT auth, remote compact reuses both the prompt-cache key and the translated `service_tier` value.

**Data flow**: It calls `assert_remote_manual_compact_request_parity` with ChatGPT auth, configured fast service tier, and an expectation that the compact request carries `priority`.

**Call relations**: This is the ChatGPT-auth counterpart to the API-key parity test.

*Call graph*: calls 2 internal fn (assert_remote_manual_compact_request_parity, create_dummy_chatgpt_auth_for_testing); 1 external calls (skip_if_no_network!).


##### `remote_compact_v2_reuses_compaction_trigger_for_followups`  (lines 802–937)

```
async fn remote_compact_v2_reuses_compaction_trigger_for_followups() -> Result<()>
```

**Purpose**: Verifies the v2 manual compaction flow where compaction is requested inline on `/v1/responses` using a `compaction_trigger` item and the follow-up request preserves the returned compaction item.

**Data flow**: It builds a v2-enabled harness, mounts a normal response, an inline compaction response containing a `compaction` output item, and a follow-up response, submits a user turn, `Op::Compact`, and another user turn, then inspects the compact request for beta-feature header, compaction metadata, and trigger item, and the follow-up request for the preserved compaction payload.

**Call relations**: This is the foundational manual v2 compaction test and the main contrast point with the legacy `/responses/compact` path.

*Call graph*: calls 5 internal fn (mount_sse_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, from_str, skip_if_no_network!, vec!).


##### `remote_compact_v2_retries_failures_with_stream_retry_budget`  (lines 940–1049)

```
async fn remote_compact_v2_retries_failures_with_stream_retry_budget() -> Result<()>
```

**Purpose**: Checks that v2 compaction retries both open failures and failed compaction streams using the normal stream retry budget, discarding failed compaction outputs.

**Data flow**: It builds a v2 harness with `stream_max_retries = 2`, mounts a normal response, a 500 open failure, a failed compaction stream, a successful retried compaction stream, and a follow-up response, then runs user turn, compact, and follow-up turn and asserts the three compact attempts all used `compaction_trigger` while only the retried summary appears in the final follow-up request.

**Call relations**: This test covers retry orchestration specific to inline v2 compaction.

*Call graph*: calls 5 internal fn (mount_response_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 5 external calls (default, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `remote_compact_v2_accepts_additional_output_items_before_compaction`  (lines 1052–1139)

```
async fn remote_compact_v2_accepts_additional_output_items_before_compaction() -> Result<()>
```

**Purpose**: Verifies that v2 compaction tolerates unrelated output items before the final compaction item and ignores them when building follow-up history.

**Data flow**: It mounts a compaction stream containing an assistant message plus a compaction item, runs user turn, compact, and follow-up turn, then asserts the follow-up request contains the compaction payload but not the unrelated assistant message.

**Call relations**: This is a parser-tolerance test for the v2 compaction stream.

*Call graph*: calls 5 internal fn (mount_sse_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 4 external calls (default, assert!, skip_if_no_network!, vec!).


##### `remote_compact_filters_deferred_dynamic_tools`  (lines 1142–1232)

```
async fn remote_compact_filters_deferred_dynamic_tools() -> Result<()>
```

**Purpose**: Checks that remote compact requests use the same model-visible tool payload as normal responses and that deferred dynamic tools are filtered out of both.

**Data flow**: It starts a thread with one deferred and one visible dynamic tool under a namespace, runs a user turn and manual compact, then compares the `tools` payloads of the normal response request and compact request, asserting no `defer_loading` fields remain and only the visible child tool is present.

**Call relations**: This test ties remote compaction request construction to the same tool-visibility filtering rules used for normal model requests.

*Call graph*: calls 8 internal fn (mount_compact_json_once, mount_sse_once, sse, start_mock_server, assert_tools_payload_does_not_defer, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert_eq!, json!, json!, skip_if_no_network!, vec!).


##### `remote_compact_runs_automatically`  (lines 1235–1362)

```
async fn remote_compact_runs_automatically() -> Result<()>
```

**Purpose**: Verifies automatic remote compaction after an over-limit turn, including compaction metadata and turn/window id behavior across the initial request, compact request, and continuation request.

**Data flow**: It mounts an initial over-limit turn that emits a shell command, a follow-up response, and a remote compact endpoint, submits one user turn, waits for `ContextCompacted` and `TurnComplete`, then inspects compact-request headers/metadata and the follow-up request body to assert summary insertion and turn/window id transitions.

**Call relations**: This is the baseline automatic remote compaction test for the legacy endpoint.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 9 external calls (default, assert!, assert_eq!, assert_ne!, wait_for_event, wait_for_event_match, from_str, skip_if_no_network!, vec!).


##### `remote_compact_trims_function_call_history_to_fit_context_window`  (lines 1366–1487)

```
async fn remote_compact_trims_function_call_history_to_fit_context_window() -> Result<()>
```

**Purpose**: Checks that remote manual compaction rewrites oversized trailing function-call output to a truncation marker while preserving earlier function-call/result pairs and user-boundary messages.

**Data flow**: It runs two turns with shell-command tool calls under a small context window, mounts a remote compact endpoint, triggers manual compact, then inspects the compact request to assert both user messages remain, the older function call/output pair is intact, and the trailing function-call output was replaced with `CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE`.

**Call relations**: This is the baseline function-call trimming test for remote compaction.

*Call graph*: calls 5 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `remote_compact_rewrites_multiple_trailing_function_call_outputs`  (lines 1491–1607)

```
async fn remote_compact_rewrites_multiple_trailing_function_call_outputs() -> Result<()>
```

**Purpose**: Verifies that when multiple trailing parallel function calls overflow the context window, remote compaction rewrites each trailing output to the truncation marker.

**Data flow**: It runs one retained shell-call turn and one turn with two parallel shell calls, triggers manual compact, and asserts the compact request preserves the older pair while rewriting both trailing outputs to the truncation message.

**Call relations**: This extends the trimming logic from one trailing function call to multiple parallel trailing calls.

*Call graph*: calls 5 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `auto_remote_compact_trims_function_call_history_to_fit_context_window`  (lines 1611–1757)

```
async fn auto_remote_compact_trims_function_call_history_to_fit_context_window() -> Result<()>
```

**Purpose**: Checks that the same trailing function-call output rewriting occurs during automatic remote compaction.

**Data flow**: It runs two turns that establish retained and trailing shell-call history, mounts a remote compact endpoint, submits a third turn that triggers auto compact, waits for completion, and then inspects the compact request for preserved user boundaries, intact older function-call output, and rewritten trailing output.

**Call relations**: This is the automatic-compaction counterpart to the manual trimming test.

*Call graph*: calls 5 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `remote_compact_trims_tool_search_output_to_empty_tools_array`  (lines 1760–1863)

```
async fn remote_compact_trims_tool_search_output_to_empty_tools_array() -> Result<()>
```

**Purpose**: Verifies that oversized trailing `tool_search_output` history is rewritten to an empty `tools` array during remote compaction.

**Data flow**: It starts a thread with an oversized deferred dynamic tool, runs a turn that triggers a tool search, mounts a remote compact endpoint, triggers manual compact, then inspects the compact request’s `tool_search_output` item and asserts its `tools` array is empty.

**Call relations**: This test covers trimming logic for tool-search artifacts rather than function-call outputs.

*Call graph*: calls 7 internal fn (mount_compact_user_history_with_summary_once, mount_sse_once, sse, start_mock_server, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert!, format!, json!, Namespace, skip_if_no_network!, vec!).


##### `auto_remote_compact_failure_stops_agent_loop`  (lines 1866–1962)

```
async fn auto_remote_compact_failure_stops_agent_loop() -> Result<()>
```

**Purpose**: Checks that if automatic remote compaction fails to parse its response, the current turn emits an error and stops instead of continuing to a post-compaction model request.

**Data flow**: It mounts an initial over-limit turn, a compact endpoint returning an invalid payload shape, and a would-be post-compact response, submits one setup turn and then a turn that triggers auto compact, waits for an `Error` and `TurnComplete`, and asserts the compact endpoint was called once while the post-compact response was never requested.

**Call relations**: This is the failure-path test for automatic remote pre-turn compaction.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 9 external calls (default, assert!, assert_eq!, wait_for_event, wait_for_event_match, assert_snapshot!, json!, skip_if_no_network!, vec!).


##### `remote_compact_trim_estimate_uses_session_base_instructions`  (lines 1966–2184)

```
async fn remote_compact_trim_estimate_uses_session_base_instructions() -> Result<()>
```

**Purpose**: Verifies that remote compaction’s trim estimate includes session base instructions, so longer base instructions can force trailing function-call output rewriting.

**Data flow**: It first runs a baseline harness to capture a compact request and estimate its input/payload tokens, then builds a second harness with much longer `base_instructions` and a context window just above the baseline payload size, reruns the same history, triggers compact, and asserts the override compact request still preserves both function calls but rewrites the trailing output to the truncation marker.

**Call relations**: This test compares two separate sessions to prove trim estimation depends on instructions text, not just input items.

*Call graph*: calls 8 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, approx_token_count, estimate_compact_input_tokens, estimate_compact_payload_tokens, test_codex, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert!, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


##### `remote_manual_compact_emits_context_compaction_items`  (lines 2187–2265)

```
async fn remote_manual_compact_emits_context_compaction_items() -> Result<()>
```

**Purpose**: Verifies that manual remote compaction emits context-compaction item lifecycle events and the legacy `ContextCompacted` event.

**Data flow**: It runs one normal turn, mounts a remote compact endpoint, submits `Op::Compact`, drains events until it has seen compaction item start/completion, legacy `ContextCompacted`, and `TurnComplete`, then asserts the item ids match and the compact endpoint was called once.

**Call relations**: This is the remote-manual counterpart to the local compaction lifecycle-event tests.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `remote_manual_compact_failure_emits_task_error_event`  (lines 2268–2327)

```
async fn remote_manual_compact_failure_emits_task_error_event() -> Result<()>
```

**Purpose**: Checks that a malformed remote compact response causes a user-visible task error event during manual compaction.

**Data flow**: It runs one normal turn, mounts a compact endpoint returning an invalid payload shape, submits `Op::Compact`, waits for an `Error` event, asserts the message mentions remote compact task failure and invalid payload details, then waits for turn completion.

**Call relations**: This is the manual remote failure-path test.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, vec!).


##### `remote_compact_persists_replacement_history_in_rollout`  (lines 2333–2465)

```
async fn remote_compact_persists_replacement_history_in_rollout() -> Result<()>
```

**Purpose**: Documents the intended behavior that remote compaction replacement history should be persisted in rollout, including compaction items and assistant notes but excluding injected permissions context.

**Data flow**: It runs one normal turn, mounts a compact endpoint returning a compaction item plus assistant note, triggers manual compact, shuts down, reads the rollout file, and scans `RolloutItem::Compacted` entries for a matching `replacement_history` shape.

**Call relations**: This ignored test captures a known-incorrect area around rollout persistence for remote compaction.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, read_to_string, json!, skip_if_no_network!, vec!).


##### `remote_compact_and_resume_refresh_stale_developer_instructions`  (lines 2468–2618)

```
async fn remote_compact_and_resume_refresh_stale_developer_instructions() -> Result<()>
```

**Purpose**: Verifies that if remote compact output contains stale developer instructions, they are removed immediately after compaction and remain removed after a later resume.

**Data flow**: It runs an initial turn, mounts a compact endpoint returning a stale developer message plus compaction item, runs manual compact and a same-session follow-up turn, shuts down, resumes from rollout, runs another turn, and asserts both the post-compact and post-resume request bodies contain fresh permissions instructions and the compaction item but not the stale developer text.

**Call relations**: This test spans same-session and resumed behavior for developer-instruction refresh after remote compaction.

*Call graph*: calls 4 internal fn (mount_compact_json_once, mount_sse_sequence, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!, start).


##### `remote_compact_refreshes_stale_developer_instructions_without_resume`  (lines 2621–2716)

```
async fn remote_compact_refreshes_stale_developer_instructions_without_resume() -> Result<()>
```

**Purpose**: Checks the same stale-developer-instruction refresh behavior within a single session, without involving resume.

**Data flow**: It runs an initial turn, mounts a compact endpoint returning stale developer instructions plus a compaction item, runs manual compact and a follow-up turn, then asserts the follow-up request body contains fresh permissions instructions and the compaction item but not the stale developer text.

**Call relations**: This is the same-session subset of the previous test.

*Call graph*: calls 4 internal fn (mount_compact_json_once, mount_sse_sequence, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start`  (lines 2719–2808)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start() -> Result<()>
```

**Purpose**: Captures request shapes when remote pre-turn auto-compaction occurs while realtime remains active, documenting that the post-compaction request restates realtime-start instructions.

**Data flow**: It starts a realtime server and conversation, runs one turn to exceed the threshold, mounts a remote compact endpoint returning a summary-only compaction item, runs a second turn that triggers pre-turn compaction, asserts the post-compaction request contains realtime-start instructions, snapshots the compact and follow-up requests, then closes realtime.

**Call relations**: This is the active-realtime pre-turn remote compaction snapshot test.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_start, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 8 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `remote_request_uses_custom_experimental_realtime_start_instructions`  (lines 2811–2858)

```
async fn remote_request_uses_custom_experimental_realtime_start_instructions() -> Result<()>
```

**Purpose**: Verifies that when custom experimental realtime-start instructions are configured, normal requests use them instead of the default realtime-start text.

**Data flow**: It starts a realtime server and conversation with custom config, runs one user turn, then asserts the captured request body contains the custom instructions inside the realtime wrapper and omits the default start text.

**Call relations**: This is a direct request-shape test for configurable realtime-start instructions.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, assert_request_contains_custom_realtime_start, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 5 external calls (default, wait_for_event, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end`  (lines 2861–2951)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end() -> Result<()>
```

**Purpose**: Captures request shapes when remote pre-turn auto-compaction occurs after realtime was closed between turns, documenting that the post-compaction request restates realtime-end instructions.

**Data flow**: It starts and then closes a realtime conversation between two turns, mounts a remote compact endpoint, runs the second turn that triggers pre-turn compaction, asserts the post-compaction request contains realtime-end instructions, snapshots the compact and follow-up requests, and shuts down the realtime server.

**Call relations**: This is the inactive-realtime counterpart to the active-realtime pre-turn snapshot test.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_end, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 8 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_manual_compact_restates_realtime_start`  (lines 2954–3044)

```
async fn snapshot_request_shape_remote_manual_compact_restates_realtime_start() -> Result<()>
```

**Purpose**: Captures request shapes when manual remote compaction occurs while realtime remains active, documenting that the next regular turn restates realtime-start instructions.

**Data flow**: It starts a realtime conversation, runs one turn, mounts a remote compact endpoint, runs `Op::Compact` and a follow-up turn, asserts the follow-up request contains realtime-start instructions, snapshots the compact and follow-up requests, then closes realtime.

**Call relations**: This is the manual-compaction analogue of the active-realtime pre-turn snapshot test.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_start, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 8 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end`  (lines 3047–3151)

```
async fn snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end() -> Result<()>
```

**Purpose**: Captures request shapes when remote mid-turn compaction occurs after realtime was already closed before the turn, documenting that the continuation request does not restate realtime-end instructions because the current turn already established that baseline.

**Data flow**: It starts and closes realtime before the second turn, scripts a second turn that triggers mid-turn compaction via a function call, mounts a remote compact endpoint, runs the turn, asserts the initial second-turn request contains realtime-end instructions while the post-compaction continuation does not, and snapshots all three requests.

**Call relations**: This test distinguishes pre-turn restatement from mid-turn continuation behavior once the inactive baseline is already in the current turn.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_end, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 9 external calls (default, assert!, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_compact_resume_restates_realtime_end`  (lines 3154–3260)

```
async fn snapshot_request_shape_remote_compact_resume_restates_realtime_end() -> Result<()>
```

**Purpose**: Captures request shapes after remote manual compaction, shutdown, and resume, documenting that the first resumed turn restates realtime-end instructions reconstructed from previous-turn settings.

**Data flow**: It starts and closes realtime, runs one turn, mounts a remote compact endpoint, runs manual compact, shuts down, resumes from rollout, runs another turn, asserts the resumed request contains realtime-end instructions, and snapshots the compact and resumed follow-up requests.

**Call relations**: This is the resume-aware realtime-end restatement test.

*Call graph*: calls 9 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_end, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_pre_turn_compaction_including_incoming_user_message`  (lines 3264–3361)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_including_incoming_user_message() -> Result<()>
```

**Purpose**: Documents current remote pre-turn auto-compaction behavior with a context override, showing that the compact request excludes the incoming user message while the post-compaction request includes it exactly once.

**Data flow**: It runs three turns, applying a thread-settings environment override before the third, mounts a remote compact endpoint returning a prefixed summary, then snapshots the compact and post-compaction requests and asserts the third user text appears exactly once in the follow-up request.

**Call relations**: This is the remote counterpart to the local snapshot documenting current exclusion of incoming user input from pre-turn compaction.

*Call graph*: calls 7 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, local_selections, summary_with_prefix, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert_eq!, submit_thread_settings, test_path_buf, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_pre_turn_compaction_strips_incoming_model_switch`  (lines 3364–3498)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_strips_incoming_model_switch() -> Result<()>
```

**Purpose**: Documents current remote pre-turn compaction behavior during a model switch, showing that the compact request excludes the incoming user and strips `<model_switch>`, while the follow-up restores both.

**Data flow**: It runs a first turn on one model, updates thread settings to a new model, runs a second turn under auto-compaction conditions, then asserts the compact request omits the incoming user and `<model_switch>`, the follow-up request includes both old and new user messages plus `<model_switch>`, and snapshots all three requests.

**Call relations**: This is the remote model-switch snapshot counterpart to the local pre-turn model-switch snapshot.

*Call graph*: calls 7 internal fn (mount_compact_user_history_with_summary_once, mount_sse_once, sse, with_builder, summary_with_prefix, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_pre_turn_compaction_context_window_exceeded`  (lines 3503–3606)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_context_window_exceeded() -> Result<()>
```

**Purpose**: Documents current behavior when remote pre-turn auto-compaction fails with a context-window error: the compact request excludes the incoming user and the turn stops without a post-compaction follow-up request.

**Data flow**: It runs one setup turn, mounts a compact endpoint returning a 400 `context_length_exceeded` error and a would-be post-compact response, submits a second turn, waits for an `Error` and `TurnComplete`, asserts the post-compact response was never requested, snapshots the compact request, and checks the error message mentions the context window.

**Call relations**: This is the remote failure-path snapshot test for pre-turn compaction.

*Call graph*: calls 7 internal fn (mount_compact_response_once, mount_sse_once, mount_sse_sequence, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 10 external calls (default, new, assert!, assert_eq!, wait_for_event, wait_for_event_match, assert_snapshot!, json!, skip_if_no_network!, vec!).


##### `remote_pre_turn_compact_response_seeds_turn_state`  (lines 3609–3679)

```
async fn remote_pre_turn_compact_response_seeds_turn_state() -> Result<()>
```

**Purpose**: Verifies that a remote pre-turn compact response can seed `x-codex-turn-state` for the first sampled request after compaction.

**Data flow**: It mounts a first over-limit turn, a second normal turn, and a compact endpoint that returns both a compaction output and `x-codex-turn-state: compact-state`, submits two turns, then asserts the compact request had no turn-state header while the second normal response request did carry `compact-state`.

**Call relations**: This test covers turn-state propagation from the compact response into the next sampled request in the pre-turn path.

*Call graph*: calls 6 internal fn (mount_compact_response_once, mount_response_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, new, assert_eq!, json!, skip_if_no_network!, vec!).


##### `remote_mid_turn_compact_v1_sends_turn_state_over_http`  (lines 3682–3762)

```
async fn remote_mid_turn_compact_v1_sends_turn_state_over_http() -> Result<()>
```

**Purpose**: Checks that legacy mid-turn remote compaction over `/responses/compact` replays the first sampled `x-codex-turn-state` value on the compact request and all later continuation requests.

**Data flow**: It mounts a first response that emits a function call and `sampling-state`, a continuation response with `continuation-state`, a final response, and a compact endpoint returning `compact-state`, submits one turn that triggers mid-turn compaction, then asserts the compact request and both later `/responses` requests all carry `sampling-state` while the initial request had none.

**Call relations**: This is the legacy HTTP turn-state propagation test for mid-turn compaction.

*Call graph*: calls 6 internal fn (mount_compact_response_once, mount_response_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, new, assert_eq!, json!, skip_if_no_network!, vec!).


##### `remote_mid_turn_compact_v2_sends_turn_state_over_http`  (lines 3765–3857)

```
async fn remote_mid_turn_compact_v2_sends_turn_state_over_http() -> Result<()>
```

**Purpose**: Checks that v2 mid-turn compaction over `/v1/responses` also replays the first sampled `x-codex-turn-state` value on the inline compaction request and all later continuation requests.

**Data flow**: It mounts a first response with `sampling-state`, an inline compaction response with `compact-state`, a continuation response with `continuation-state`, and a final response, submits one turn, then asserts all requests are `/v1/responses`, the second request contains `compaction_trigger`, and requests 1–3 all carry `sampling-state` after the first request established it.

**Call relations**: This is the v2 HTTP counterpart to the legacy turn-state propagation test.

*Call graph*: calls 5 internal fn (mount_response_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 5 external calls (default, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `remote_mid_turn_compact_v2_sends_turn_state_over_websocket`  (lines 3860–3955)

```
async fn remote_mid_turn_compact_v2_sends_turn_state_over_websocket() -> Result<()>
```

**Purpose**: Checks that websocket v2 mid-turn compaction replays the first sampled turn-state value in `client_metadata` on the inline compaction request and later continuation requests.

**Data flow**: It starts a scripted websocket server whose metadata frames set `sampling-state`, `compact-state`, and `continuation-state` across requests, builds a v2-enabled websocket codex, submits one turn, then inspects the five websocket requests and asserts the prewarm and first sampled request have null turn state while the compaction and both later requests all carry `sampling-state` in `client_metadata`.

**Call relations**: This is the websocket transport analogue of the v2 HTTP turn-state propagation test.

*Call graph*: calls 4 internal fn (start_websocket_server, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 5 external calls (default, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_mid_turn_continuation_compaction`  (lines 3958–4027)

```
async fn snapshot_request_shape_remote_mid_turn_continuation_compaction() -> Result<()>
```

**Purpose**: Captures request shapes for remote mid-turn continuation compaction after tool output, showing the compact request includes tool artifacts and the follow-up request includes the returned compaction item.

**Data flow**: It mounts an initial function-call response, a final response, and a remote compact endpoint returning a prefixed summary, submits one user turn, then snapshots the compact request and the post-compaction follow-up request.

**Call relations**: This is the remote mid-turn snapshot counterpart to the local continuation-compaction snapshot.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, summary_with_prefix, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_mid_turn_compaction_summary_only_reinjects_context`  (lines 4030–4114)

```
async fn snapshot_request_shape_remote_mid_turn_compaction_summary_only_reinjects_context() -> Result<()>
```

**Purpose**: Captures request shapes when remote mid-turn compaction returns only a compaction item, documenting that the continuation request reinjects context before that compaction item.

**Data flow**: It mounts an initial function-call response, a final response, and a compact endpoint returning only a compaction item, submits one user turn, then snapshots the compact request and post-compaction request.

**Call relations**: This test documents the continuation-layout rule for summary-only remote compact output.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_mid_turn_compaction_multi_summary_reinjects_above_last_summary`  (lines 4117–4227)

```
async fn snapshot_request_shape_remote_mid_turn_compaction_multi_summary_reinjects_above_last_summary() -> Result<()>
```

**Purpose**: Captures request shapes when a turn already contains an older remote compaction item and a later mid-turn remote compaction produces a newer one, documenting that context is reinjected above the latest summary.

**Data flow**: It runs a setup turn, a manual compact producing an older summary, then a second turn that triggers mid-turn auto-compaction and returns a newer summary, asserts the second compact request still carries the older summary, and snapshots that compact request plus the second-turn request after compaction.

**Call relations**: This is a nuanced history-layering test for multiple remote compaction summaries across turns.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_sequence, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert!, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_manual_compact_without_previous_user_messages`  (lines 4230–4285)

```
async fn snapshot_request_shape_remote_manual_compact_without_previous_user_messages() -> Result<()>
```

**Purpose**: Documents current remote manual `/compact` behavior when there is no prior user turn: the remote compact request is skipped and the next user turn proceeds with canonical context.

**Data flow**: It mounts a follow-up response and a compact endpoint returning an empty output, runs `Op::Compact` and then a user turn, asserts the compact endpoint was never called, and snapshots the follow-up request.

**Call relations**: This is the remote counterpart to the local edge-case snapshot for manual compaction without prior user history.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!).


### `core/tests/suite/responses_lite.rs`

`test` · `request handling`

This test file builds small Codex fixtures with targeted model/config overrides and inspects the exact HTTP requests emitted to the mock Responses server. The helpers at the top encode the important preconditions: `responses_extensions` installs standalone web-search and image-generation extensions into an `ExtensionRegistry<Config>`, `configure_responses_tools` forces live web search while disabling the standalone-web-search and image-gen-extension feature flags and enabling image generation, and `configure_image_capable_model` marks a model as accepting both text and image input. The tests then vary only one axis at a time.

The first image test proves that in lite mode a `UserInput::Image` carrying `ImageDetail::Original` is serialized as a bare `input_image` with only `image_url`, specifically for data URLs when resize-all-images is not enabled. The tooling tests compare lite and non-lite behavior: lite requests must carry the `x-openai-internal-codex-responses-lite: true` header, expose standalone tools (`web.run`, `image_gen.imagegen`) when extensions are installed, and omit hosted tool descriptors (`web_search`, `image_generation`) entirely. Without standalone extensions, lite still omits hosted tools rather than falling back. The compaction test verifies that `Op::Compact` uses the lite transport contract too, including the lite header, `reasoning.context = "all_turns"`, and forced `parallel_tool_calls = false` even when the model advertises parallel tool support.

#### Function details

##### `responses_extensions`  (lines 27–33)

```
fn responses_extensions(auth: &CodexAuth) -> Arc<ExtensionRegistry<Config>>
```

**Purpose**: Builds an extension registry containing the standalone web-search and image-generation extensions for tests that need Responses Lite to expose client-side tools.

**Data flow**: It takes a `&CodexAuth`, clones it into an auth manager via test support, creates an `ExtensionRegistryBuilder<Config>`, installs the web-search and image-generation extensions, builds the registry, and returns it wrapped in `Arc<ExtensionRegistry<Config>>`.

**Call relations**: This helper is used only by the tests that compare standalone-tool exposure in lite versus hosted-tool exposure in non-lite mode. Those tests call it before building the fixture so the resulting Codex instance advertises extension-backed tools during request construction.

*Call graph*: calls 1 internal fn (auth_manager_from_auth); called by 2 (non_lite_uses_hosted_tools_when_standalone_features_are_disabled, responses_lite_uses_standalone_web_search_and_image_generation); 6 external calls (clone, new, new, install, install, clone).


##### `configure_responses_tools`  (lines 35–45)

```
fn configure_responses_tools(config: &mut Config)
```

**Purpose**: Mutates a `Config` into the specific feature combination needed to test hosted-versus-standalone search and image-generation behavior.

**Data flow**: It receives `&mut Config`, sets `web_search_mode` to `WebSearchMode::Live`, disables `Feature::StandaloneWebSearch`, enables `Feature::ImageGeneration`, and disables `Feature::ImageGenExt`. Each mutation is asserted to succeed, so the helper fails fast if the config rejects the requested state.

**Call relations**: It is passed into fixture builders in tests that need deterministic tool selection rules. The tests rely on this helper to ensure any observed hosted or standalone tool exposure comes from transport mode and installed extensions, not from unrelated feature defaults.

*Call graph*: 1 external calls (assert!).


##### `configure_image_capable_model`  (lines 47–49)

```
fn configure_image_capable_model(model_info: &mut codex_protocol::openai_models::ModelInfo)
```

**Purpose**: Marks a model override as image-capable so image inputs and image-generation-related tool logic are eligible during the test.

**Data flow**: It takes a mutable `ModelInfo` and replaces `input_modalities` with a two-element vector containing `InputModality::Text` and `InputModality::Image`. It returns no value and writes directly into the supplied model metadata.

**Call relations**: Several tests pass this helper into `with_model_info_override` so the built fixture behaves like an image-capable model. In the image serialization and tool exposure cases, that prevents the request builder from stripping image-related capabilities for lack of model support.

*Call graph*: 1 external calls (vec!).


##### `has_hosted_tool`  (lines 51–55)

```
fn has_hosted_tool(tools: &[Value], tool_type: &str) -> bool
```

**Purpose**: Checks whether a serialized `tools` array contains a hosted tool entry of a given `type` string.

**Data flow**: It reads a slice of `serde_json::Value`, iterates through each tool object, extracts `tool["type"]` as a string, compares it to the requested `tool_type`, and returns `true` on the first match or `false` otherwise.

**Call relations**: The hosted-tool assertions in lite and non-lite tests use this helper after decoding the request body. It provides the concrete predicate for proving that hosted `web_search` and `image_generation` descriptors are either omitted or present.

*Call graph*: 1 external calls (iter).


##### `responses_lite_strips_data_image_detail_without_resize_all_images`  (lines 58–111)

```
async fn responses_lite_strips_data_image_detail_without_resize_all_images() -> Result<()>
```

**Purpose**: Verifies that Responses Lite removes `detail` metadata from a data-URL image input when resize-all-images is not active.

**Data flow**: The test starts a mock server, mounts a minimal SSE completion stream, builds a fixture whose `gpt-5.4` model override enables `use_responses_lite` and image input, submits `Op::UserInput` containing one `UserInput::Image` with a base64 PNG data URL and `Some(ImageDetail::Original)`, waits for `EventMsg::TurnComplete`, then inspects the captured request JSON. It locates the `input_image` content item and asserts exact equality with a JSON object containing only `type` and `image_url`.

**Call relations**: This is a top-level async test invoked by the test runner after the network guard passes. It delegates setup to `start_mock_server`, `mount_sse_once`, `test_codex`, and `wait_for_event`, then performs direct JSON inspection to validate the transport contract.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `responses_lite_uses_standalone_web_search_and_image_generation`  (lines 114–162)

```
async fn responses_lite_uses_standalone_web_search_and_image_generation() -> Result<()>
```

**Purpose**: Checks that lite mode advertises standalone extension tools and suppresses hosted tool descriptors when the relevant extensions are installed.

**Data flow**: It creates a mock server and completion SSE, constructs dummy ChatGPT auth plus an extension registry from `responses_extensions`, builds a fixture with `use_responses_lite = true`, image-capable model metadata, and the tool-focused config mutator, submits a normal turn, then inspects the single request. The assertions verify the lite header is `true`, `tool_by_name("web", "run")` and `tool_by_name("image_gen", "imagegen")` exist, and the decoded `tools` array contains neither hosted `web_search` nor hosted `image_generation` entries.

**Call relations**: This test is one half of the lite/non-lite comparison. It depends on `responses_extensions` to make standalone tools available and uses request inspection helpers on the captured mock request to prove the request builder chose extension-backed tools.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, responses_extensions, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_lite_compact_request_uses_lite_transport_contract`  (lines 165–217)

```
async fn responses_lite_compact_request_uses_lite_transport_contract() -> Result<()>
```

**Purpose**: Ensures that conversation compaction uses the Responses Lite compact endpoint contract rather than the normal transport shape.

**Data flow**: It mounts both a normal SSE response and a compact JSON response, builds a fixture with `use_responses_lite = true`, `supports_parallel_tool_calls = true`, and `Feature::RemoteCompactionV2` disabled, submits an initial user turn, then submits `Op::Compact`. After waiting for completion, it inspects the compact request and asserts the lite header is present, `reasoning.context` equals `all_turns`, and `parallel_tool_calls` is explicitly `false`.

**Call relations**: The test runner invokes this directly. It first consumes the ordinary response request generated by the initial turn, then validates the separate compaction request captured by `mount_compact_json_once`, proving that compacting follows the lite-specific transport rules.

*Call graph*: calls 5 internal fn (mount_compact_json_once, mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `responses_lite_omits_hosted_tools_without_standalone_extensions`  (lines 220–252)

```
async fn responses_lite_omits_hosted_tools_without_standalone_extensions() -> Result<()>
```

**Purpose**: Verifies that lite mode does not fall back to hosted search or image-generation tools when standalone extensions are absent.

**Data flow**: It starts a mock server, mounts a completion SSE, builds a fixture with dummy auth, `use_responses_lite = true`, image-capable model metadata, and the tool-focused config mutator but no installed extensions, submits a turn, decodes the request body, extracts the `tools` array, and asserts that neither hosted `web_search` nor hosted `image_generation` appears.

**Call relations**: This test complements the standalone-extension case by removing only the extension registry. The resulting assertions show that omission of hosted tools is a lite-mode invariant, not merely a consequence of standalone tools being present.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, create_dummy_chatgpt_auth_for_testing); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `non_lite_uses_hosted_tools_when_standalone_features_are_disabled`  (lines 255–291)

```
async fn non_lite_uses_hosted_tools_when_standalone_features_are_disabled() -> Result<()>
```

**Purpose**: Confirms that the normal Responses transport still exposes hosted search and image-generation tools under the same feature configuration where lite mode suppresses them.

**Data flow**: It creates a mock server and completion SSE, builds dummy auth and standalone extensions, constructs a fixture with an image-capable model but without enabling `use_responses_lite`, applies the same tool config mutator, submits a turn, and inspects the request. The assertions require that the lite header is absent, standalone tool names are absent, and the `tools` array contains hosted `web_search` and `image_generation` entries.

**Call relations**: This is the control case for the lite-mode tests. It reuses `responses_extensions` and `configure_responses_tools` so the only meaningful difference is transport mode, making the hosted-tool assertions a direct regression check against lite-specific behavior.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, responses_extensions, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


### `core/tests/suite/turn_state.rs`

`test` · `request handling`

This suite validates the `x-codex-turn-state` mechanism that lets the server mint opaque state during a turn and have the client replay it on same-turn follow-up requests. The constant `TURN_STATE_HEADER` names the header/key under test. All three tests build a `TestCodex`, trigger a turn that causes at least one tool follow-up request, and then inspect the captured outbound requests.

The first test uses the Responses HTTP path. It mounts a response sequence where the first SSE response includes a response header `x-codex-turn-state: ts-1`, emits reasoning plus a shell-command tool call, and completes; the second response completes the same logical turn; the third response is a separate later turn. The assertions check that the initial request has no turn-state header, the same-turn follow-up request replays `ts-1`, and the next turn clears it. It also parses `x-codex-turn-metadata` JSON to prove the first two requests share a `turn_id` while the third has a different one.

The websocket tests perform the same logical checks using `client_metadata` instead of HTTP headers. One verifies that state persists across requests on the same physical websocket connection but resets for the next logical turn. The other verifies stability within a single turn: if a later response metadata frame tries to change the turn state from `ts-1` to `ts-2`, subsequent same-turn follow-ups still send the original `ts-1`, showing that turn state is latched for the duration of the turn rather than updated mid-turn.

#### Function details

##### `responses_turn_state_persists_within_turn_and_resets_after`  (lines 24–89)

```
async fn responses_turn_state_persists_within_turn_and_resets_after() -> Result<()>
```

**Purpose**: Verifies HTTP/SSE turn-state behavior: no state on the initial request, replay on same-turn follow-up, and reset on the next turn. It also confirms the first two requests belong to the same logical turn via `x-codex-turn-metadata`.

**Data flow**: It starts a mock server, mounts three responses where the first includes `x-codex-turn-state: ts-1` and a shell-command tool call, builds a `TestCodex`, submits one turn that triggers the tool follow-up and then a second independent turn, reads the captured requests from the response log, asserts the first request has no turn-state header, the second has `ts-1`, and the third has none, then defines a local parser that deserializes the `x-codex-turn-metadata` header JSON and extracts `turn_id`. It asserts the first and second requests share a turn id and the third differs.

**Call relations**: This test establishes the baseline turn-state contract on the Responses transport, against which the websocket variants mirror behavior.

*Call graph*: calls 4 internal fn (mount_response_sequence, sse, start_mock_server, test_codex); 4 external calls (assert_eq!, assert_ne!, skip_if_no_network!, vec!).


##### `websocket_turn_state_persists_within_turn_and_resets_after`  (lines 92–145)

```
async fn websocket_turn_state_persists_within_turn_and_resets_after() -> Result<()>
```

**Purpose**: Checks that websocket client metadata carries turn state across same-turn follow-up requests on a reused connection, but resets to null for the next logical turn. It mirrors the HTTP test on the websocket transport.

**Data flow**: It starts a websocket test server configured with one connection whose first response emits a `response.metadata` frame containing `x-codex-turn-state: ts-1`, followed by a shell-command tool call and completion, then two more responses for the same-turn follow-up and a later turn. It builds a websocket-backed `TestCodex`, submits two turns, asserts only one websocket handshake occurred, reads the single connection's three requests, maps each request's `body_json()["client_metadata"][TURN_STATE_HEADER]`, and asserts the sequence is `[null, "ts-1", null]`. It then shuts the server down.

**Call relations**: This test proves that logical turn-state reset is independent of physical connection reuse: the same websocket stays open while the state still clears between turns.

*Call graph*: calls 2 internal fn (start_websocket_server_with_headers, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `websocket_turn_state_is_stable_within_turn`  (lines 148–203)

```
async fn websocket_turn_state_is_stable_within_turn() -> Result<()>
```

**Purpose**: Verifies that once websocket turn state is established for a turn, later metadata frames in the same turn do not replace it. Subsequent same-turn follow-ups must continue sending the original value.

**Data flow**: It starts a websocket server whose first response metadata sets `ts-1`, whose second response metadata attempts to set `ts-2`, and whose third response completes the turn after two shell-command follow-ups. It builds a websocket-backed `TestCodex`, submits one turn that triggers both follow-ups, asserts there was a single handshake, reads the three requests on that connection, extracts `client_metadata[TURN_STATE_HEADER]` from each, and asserts the sequence is `[null, "ts-1", "ts-1"]`. It then shuts the server down.

**Call relations**: This test covers the latching invariant within a single turn, complementing the previous websocket test that focused on reset across turns.

*Call graph*: calls 2 internal fn (start_websocket_server_with_headers, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


### Streaming resilience and fallback
These regression suites verify retry, recovery, and transport fallback behavior when streamed responses are incomplete or fail.

### `core/tests/suite/stream_error_allows_next_turn.rs`

`test` · `request handling and error recovery`

This file contains a single end-to-end test around stream error recovery. It uses a raw `wiremock::MockServer` rather than the higher-level response helpers for the failing request so it can return an HTTP 500 JSON error body from `/v1/responses`. A second mock on the same endpoint matches a different prompt and returns a minimal SSE stream containing `response.created` and `completed`. The comments note that the configured provider disables request retries and allows only stream retries, so the first failing request should not loop indefinitely.

The test constructs a custom `ModelProviderInfo` pointing at the mock server’s `/v1` base URL, using `WireApi::Responses`, no OpenAI auth requirement, and short stream timeouts. It then builds `TestCodex` with that provider and a simple base instruction. The first submitted `Op::UserInput` contains `first message`; the test waits for an `EventMsg::Error` and then for `TurnComplete`, which is the critical invariant: even on stream failure, the running turn must be cleaned up. It then submits a second turn with `follow up` and waits for `TurnComplete` again. If the first failure had left the session stuck in a running state, this second submission would be rejected or hang, so the test directly guards the session-release path after transport errors.

#### Function details

##### `continue_after_stream_error`  (lines 21–132)

```
async fn continue_after_stream_error()
```

**Purpose**: Simulates a streamed Responses API failure on one turn and verifies that a second turn can still be submitted and complete successfully afterward.

**Data flow**: Skips without network, starts a mock server, mounts one `/v1/responses` POST matcher for bodies containing `first message` that returns a 500 JSON error and another matcher for `follow up` that returns a minimal SSE success stream, constructs a custom `ModelProviderInfo` targeting that server, builds `TestCodex` with the provider and base instructions, submits a first `Op::UserInput` turn, waits for `Error` and then `TurnComplete`, submits a second `Op::UserInput` turn, and waits for its `TurnComplete`.

**Call relations**: This is a standalone regression test with no internal helpers. Its entire purpose is to validate the control-flow transition from stream failure back to an idle session capable of accepting the next turn.

*Call graph*: calls 2 internal fn (sse, test_codex); 12 external calls (default, given, start, new, wait_for_event, format!, json!, skip_if_no_network!, vec!, body_string_contains (+2 more)).


### `core/tests/suite/stream_no_completed.rs`

`test` · `request handling`

This test file builds a minimal failure/recovery scenario around the Responses SSE transport. It first synthesizes an intentionally incomplete SSE payload containing only a `response.output_item.done` event, then pairs it with a normal completed SSE response from the test support helpers. A streaming SSE server is started with two sequential responses: the first closes early, the second completes normally.

The test configures a `ModelProviderInfo` directly instead of mutating process environment, pointing `base_url` at the mock server and selecting `WireApi::Responses`. The retry knobs are the core of the scenario: `request_max_retries` is forced to `Some(0)` so only stream-level retry logic is exercised, while `stream_max_retries` is set to `Some(1)` to permit exactly one retry after the premature close. The test then constructs a `TestCodex`, submits a single `Op::UserInput` containing one `UserInput::Text`, and waits until an `EventMsg::TurnComplete` arrives.

The key invariant checked at the end is request count: the mock server must have observed two requests, proving the client retried after detecting that the first stream terminated before `response.completed`. This catches regressions where early EOF might be treated as success or as a fatal non-retriable error.

#### Function details

##### `sse_incomplete`  (lines 17–21)

```
fn sse_incomplete() -> String
```

**Purpose**: Constructs the exact malformed SSE transcript used to simulate a stream that ends before completion. The payload contains only a single `response.output_item.done` event and omits `response.completed`.

**Data flow**: It takes no arguments and creates a one-element JSON event vector inline, then passes that vector to the test helper that serializes SSE frames. It returns the resulting `String` body and does not mutate any external state.

**Call relations**: This helper is used only by `retries_on_early_close` to keep the incomplete-stream fixture explicit and reusable within the test setup.

*Call graph*: calls 1 internal fn (sse); called by 1 (retries_on_early_close); 1 external calls (vec!).


##### `retries_on_early_close`  (lines 24–102)

```
async fn retries_on_early_close()
```

**Purpose**: Exercises the full retry path for an SSE stream that closes too early, proving the agent retries once and still completes the turn. It also verifies that the retry is stream-specific rather than a broader request retry policy artifact.

**Data flow**: The test reads network availability via `skip_if_no_network!`, builds two SSE bodies (`sse_incomplete` and a completed response), and starts a streaming SSE server configured to serve them in order. It constructs a `ModelProviderInfo` with the server URI, `WireApi::Responses`, `stream_max_retries: Some(1)`, `request_max_retries: Some(0)`, and a short idle timeout, injects that into a `TestCodex` config, submits an `Op::UserInput` containing one text item, waits for `EventMsg::TurnComplete`, then reads the server request log and asserts that exactly two requests were made before shutting the server down.

**Call relations**: As the sole test entrypoint in the file, it orchestrates the entire scenario: fixture creation, codex construction, turn submission, completion wait, and final assertion. It delegates SSE body creation to `sse_incomplete`, server setup to the streaming SSE helper, and completion observation to `wait_for_event`.

*Call graph*: calls 4 internal fn (sse_completed, start_streaming_sse_server, test_codex, sse_incomplete); 6 external calls (default, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


### `core/tests/suite/websocket_fallback.rs`

`test` · `transport setup and request streaming during integration tests`

This file exercises transport-level resilience for providers configured with `WireApi::Responses` and `supports_websockets = true`. Each test points the model provider base URL at a mock server and configures retry counts so fallback behavior is deterministic. The first case mounts an explicit HTTP 426 response for `GET .../responses`, representing an upgrade-required failure during the startup prewarm connect; the expected behavior is immediate switch to HTTP, so the first real turn performs one POST and no extra WebSocket retries. The second case leaves the WebSocket path failing implicitly, allowing the startup prewarm plus the turn's initial attempt and two retries before the request is replayed over HTTP.

The third test submits a fully specified `Op::UserInput` turn and consumes the event stream, collecting `StreamError` messages until `TurnComplete`. It asserts that the first retry message is hidden in release builds, while debug builds expose both reconnect notices. The final test submits two turns and counts server requests to prove fallback is sticky: all WebSocket attempts happen on startup and the first turn, while the second turn goes straight to HTTP. These tests specify both transport switching and the user-visible event behavior around retries.

#### Function details

##### `websocket_fallback_switches_to_http_on_upgrade_required_connect`  (lines 30–79)

```
async fn websocket_fallback_switches_to_http_on_upgrade_required_connect() -> Result<()>
```

**Purpose**: Verifies that an HTTP 426 on the WebSocket connect path causes immediate fallback to HTTP responses transport.

**Data flow**: It starts a mock server, mounts a `GET .../responses` matcher returning 426, mounts one SSE completion response for HTTP POST, builds a test whose provider points at the mock server with websocket support and limited retries, submits a turn, then counts received GET and POST requests. It asserts one websocket attempt, one HTTP attempt, and one captured HTTP response request.

**Call relations**: This test covers the special-case fast fallback path triggered by upgrade-required responses during startup prewarm.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 8 external calls (given, new, assert_eq!, format!, skip_if_no_network!, vec!, method, path_regex).


##### `websocket_fallback_switches_to_http_after_retries_exhausted`  (lines 82–124)

```
async fn websocket_fallback_switches_to_http_after_retries_exhausted() -> Result<()>
```

**Purpose**: Checks that after the configured number of WebSocket stream retries is exhausted, the request is replayed over HTTP.

**Data flow**: It mounts one SSE completion response, builds the same websocket-capable provider config without the explicit 426 matcher, submits a turn, counts GET and POST requests on the mock server, and asserts four websocket attempts total (startup prewarm plus initial try plus two retries), one HTTP attempt, and one captured HTTP response request.

**Call relations**: This is the generic retry-exhaustion fallback case, contrasting with the immediate 426-triggered fallback.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert_eq!, format!, skip_if_no_network!, vec!).


##### `websocket_fallback_hides_first_websocket_retry_stream_error`  (lines 127–206)

```
async fn websocket_fallback_hides_first_websocket_retry_stream_error() -> Result<()>
```

**Purpose**: Verifies the sequence of `StreamError` messages shown to the user during websocket retry and fallback, with different expectations for debug and release builds.

**Data flow**: It mounts one SSE completion response, builds a websocket-capable test, manually submits `Op::UserInput` with local environment selections and disabled permissions, then loops over `codex.next_event()` under a timeout collecting `EventMsg::StreamError` messages until `TurnComplete`. It compares the collected messages against either `["Reconnecting... 1/2", "Reconnecting... 2/2"]` in debug builds or only `["Reconnecting... 2/2"]` otherwise, and asserts one HTTP response request was captured.

**Call relations**: This test is the only one in the file that inspects the event stream rather than just counting transport requests, documenting the user-facing retry messaging policy.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 9 external calls (default, from_secs, new, assert_eq!, cfg!, format!, skip_if_no_network!, timeout, vec!).


##### `websocket_fallback_is_sticky_across_turns`  (lines 209–256)

```
async fn websocket_fallback_is_sticky_across_turns() -> Result<()>
```

**Purpose**: Checks that once websocket fallback activates, later turns continue using HTTP without attempting websocket again.

**Data flow**: It mounts two SSE completion responses, builds the websocket-capable provider config, submits two turns, counts GET and POST requests on the mock server, and asserts four websocket attempts total across startup and the first turn, two HTTP attempts total, and two captured HTTP response requests.

**Call relations**: This test extends the retry-exhaustion scenario across multiple turns to prove fallback state persists for the session.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_eq!, format!, skip_if_no_network!, vec!).


### Provider protocol edge cases
These tests validate provider-facing protocol details around proxy identity, quota failures, and safety-triggered rerouting or downgrade signals.

### `core/tests/suite/responses_api_proxy_headers.rs`

`test` · `integration test execution for outbound proxy/header decoration during multi-agent request handling`

This module contains one end-to-end test for request-header propagation in multi-agent conversations. It mounts three SSE handlers on a mock server using body/header predicates: the first matches the parent request containing `PARENT_PROMPT` and no `x-openai-subagent` header, returning a `multi_agent_v1.spawn_agent` tool call; the second matches the spawned child request containing `CHILD_PROMPT`, excluding the spawn call id, and requiring `x-openai-subagent: collab_spawn`; the third matches the parent follow-up request that includes the spawn call id and again has no subagent header. Request compression is explicitly disabled so the body predicates can inspect plain text.

The helper `submit_turn_with_timeout` submits a local workspace-write turn with on-request approvals and waits for both `TurnStarted` and the matching `TurnComplete`, using `wait_for_event_result` to collect event summaries if a timeout occurs. `wait_for_matching_request` similarly polls a `ResponseMock` until a captured request satisfies a predicate or the global timeout expires. Once both parent and child requests are captured, the test extracts `x-codex-window-id` from each, parses it with `split_window_id`, and asserts both generations are zero while the child thread id differs from the parent thread id. It then checks that only the child carries `x-openai-subagent`, that the child's `x-codex-parent-thread-id` equals the parent's thread id, and that the JSON in `x-codex-turn-metadata` contains `parent_thread_id` but not `forked_from_thread_id`. The result is a precise contract for how spawned subagent requests should be labeled by the proxy layer.

#### Function details

##### `responses_api_parent_and_subagent_requests_include_identity_headers`  (lines 36–141)

```
async fn responses_api_parent_and_subagent_requests_include_identity_headers() -> Result<()>
```

**Purpose**: Exercises a parent turn that spawns a subagent and verifies the resulting parent and child Responses API requests carry the correct identity and lineage headers.

**Data flow**: Starts a mock server, serializes spawn arguments containing `CHILD_PROMPT`, mounts three SSE handlers keyed by request-body/header predicates for the parent request, child request, and parent follow-up, builds a `TestCodex` with request compression disabled, submits the parent prompt via `submit_turn_with_timeout`, waits for matching captured parent and child requests via `wait_for_matching_request`, extracts and parses `x-codex-window-id` headers with `split_window_id`, asserts generation values and thread-id relationships, checks `x-openai-subagent` and `x-codex-parent-thread-id`, parses `x-codex-turn-metadata` JSON from the child request, and asserts the expected parent-thread linkage fields.

**Call relations**: This is the sole top-level scenario in the file and orchestrates all local helpers to inspect both event completion and captured HTTP requests.

*Call graph*: calls 7 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, split_window_id, submit_turn_with_timeout, wait_for_matching_request); 7 external calls (assert!, assert_eq!, json!, from_str, to_string, skip_if_no_network!, vec!).


##### `submit_turn_with_timeout`  (lines 143–189)

```
async fn submit_turn_with_timeout(test: &TestCodex, prompt: &str) -> Result<()>
```

**Purpose**: Submits a local turn configured for workspace write and waits for both start and completion within the global timeout window. It provides deterministic synchronization for the header-inspection test.

**Data flow**: Takes a `TestCodex` and prompt, derives sandbox and permission fields from `PermissionProfile::workspace_write()` and the configured cwd, submits an `Op::UserInput` with local environment selections, `AskForApproval::OnRequest`, and default collaboration mode using the session model, waits for a `TurnStarted` event via `wait_for_event_result`, extracts its `turn_id`, then waits for a `TurnComplete` event whose `turn_id` matches, returning `Result<()>`.

**Call relations**: Called only by the top-level header test before it begins polling the mock server for parent and child requests.

*Call graph*: calls 4 internal fn (local_selections, turn_permission_fields, wait_for_event_result, workspace_write); called by 1 (responses_api_parent_and_subagent_requests_include_identity_headers); 3 external calls (default, unreachable!, vec!).


##### `wait_for_matching_request`  (lines 191–213)

```
async fn wait_for_matching_request(
    mock: &ResponseMock,
    label: &str,
    mut predicate: F,
) -> Result<ResponsesRequest>
```

**Purpose**: Polls a `ResponseMock` until one captured request satisfies a caller-provided predicate or the overall turn timeout expires. It turns asynchronous request arrival into a simple `Result<ResponsesRequest>`.

**Data flow**: Accepts a `ResponseMock`, label, and mutable predicate, repeatedly calls `mock.requests()`, searches for the first request matching the predicate, returns it if found, otherwise sleeps for `REQUEST_POLL_INTERVAL`, all wrapped in `tokio::time::timeout(TURN_TIMEOUT, ...)`; on timeout it returns an `anyhow!` error mentioning the label.

**Call relations**: The top-level test uses this helper twice, once for the parent request and once for the child request.

*Call graph*: calls 1 internal fn (requests); called by 1 (responses_api_parent_and_subagent_requests_include_identity_headers); 2 external calls (sleep, timeout).


##### `wait_for_event_result`  (lines 215–240)

```
async fn wait_for_event_result(
    test: &TestCodex,
    stage: &str,
    mut predicate: F,
) -> Result<EventMsg>
```

**Purpose**: Waits for an event satisfying a predicate while collecting short summaries of all seen events for timeout diagnostics. It improves failure messages in long-running asynchronous tests.

**Data flow**: Consumes a `TestCodex`, stage label, and predicate, initializes `seen_events`, repeatedly awaits `test.codex.next_event()`, pushes `event_summary(&event.msg)` into the log, returns the matching `EventMsg` when the predicate succeeds, and wraps the loop in `tokio::time::timeout(TURN_TIMEOUT, ...)`; on timeout it returns an error listing the summarized events.

**Call relations**: Used by `submit_turn_with_timeout` for both the `TurnStarted` and matching `TurnComplete` waits.

*Call graph*: calls 1 internal fn (event_summary); called by 1 (submit_turn_with_timeout); 2 external calls (new, timeout).


##### `event_summary`  (lines 242–246)

```
fn event_summary(event: &EventMsg) -> String
```

**Purpose**: Produces a truncated debug string for an event message so timeout errors remain readable. It is purely diagnostic.

**Data flow**: Formats the `EventMsg` with `Debug`, truncates the resulting string to 240 characters, and returns it.

**Call relations**: Only `wait_for_event_result` calls this helper while building timeout diagnostics.

*Call graph*: called by 1 (wait_for_event_result); 1 external calls (format!).


##### `request_body_contains`  (lines 248–250)

```
fn request_body_contains(req: &wiremock::Request, text: &str) -> bool
```

**Purpose**: Checks whether a raw wiremock request body contains a given text snippet. It is used in request-match predicates for parent and child requests.

**Data flow**: Attempts to decode `req.body` as UTF-8 and returns `true` only if decoding succeeds and the resulting string contains the target text.

**Call relations**: The top-level test uses this helper inside the mounted request predicates to distinguish parent, child, and follow-up requests.

*Call graph*: 1 external calls (from_utf8).


##### `request_header`  (lines 252–254)

```
fn request_header(req: &'a wiremock::Request, name: &str) -> Option<&'a str>
```

**Purpose**: Reads a named header from a raw wiremock request as a borrowed string slice if present and valid UTF-8.

**Data flow**: Looks up `req.headers[name]`, converts the header value to `&str` with `to_str().ok()`, and returns `Option<&str>`.

**Call relations**: Used in the request-match predicates to check for presence or absence of `x-openai-subagent`.


##### `split_window_id`  (lines 256–261)

```
fn split_window_id(window_id: &str) -> Result<(&str, u64)>
```

**Purpose**: Parses the `x-codex-window-id` header into its thread-id and generation components. It enforces the expected `<thread_id>:<generation>` format.

**Data flow**: Splits the input string at the last `:`, returns an error if the separator is missing, parses the suffix as `u64`, and returns `(&str, u64)`.

**Call relations**: The top-level test uses this helper on both parent and child window-id headers before asserting lineage and generation invariants.

*Call graph*: called by 1 (responses_api_parent_and_subagent_requests_include_identity_headers).


### `core/tests/suite/quota_exceeded.rs`

`test` · `request failure handling regression coverage`

This module contains a single end-to-end regression test for quota exhaustion. It mounts a mock SSE stream that first announces `response.created` and then sends a synthetic `response.failed` payload whose nested error has code `insufficient_quota` and the provider-style billing message. The test then builds a normal `TestCodex`, submits a simple text `Op::UserInput`, and listens to the event stream until `EventMsg::TurnComplete` arrives.

The key assertion is not just that an error occurs, but that exactly one `EventMsg::Error` is emitted and that its message is normalized to the user-facing string `Quota exceeded. Check your plan and billing details.`. The loop increments a counter for each error event, ignores unrelated events, and breaks only on turn completion. The final assertion on the counter guards against duplicate error propagation from multiple layers of the runtime. As a result, this file documents the expected translation from provider-specific quota failures into a single Codex error event during request handling.

#### Function details

##### `quota_exceeded_emits_single_error_event`  (lines 16–77)

```
async fn quota_exceeded_emits_single_error_event() -> Result<()>
```

**Purpose**: Simulates a quota-exceeded Responses API failure and verifies that Codex emits exactly one normalized error event before completing the turn. It protects against duplicate or unnormalized error reporting.

**Data flow**: Starts a mock server, mounts one SSE stream containing `ev_response_created("resp-1")` and a raw `response.failed` JSON event with `code = insufficient_quota`, builds `TestCodex`, submits a text user input, then repeatedly waits for any event. For each `EventMsg::Error`, it increments a counter and asserts the message equals the normalized quota text; on `EventMsg::TurnComplete` it exits the loop and finally asserts the counter is `1`.

**Call relations**: This is the file's sole test entrypoint. It drives the normal submit/wait flow but inspects the emitted event stream rather than the outbound request body.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/safety_check_downgrade.rs`

`test` · `request handling`

This file focuses on the safety-check path for high-risk cyber activity. The helper `disabled_text_turn` constructs a `UserInput` operation that disables approvals, selects local environments, derives sandbox and permission settings from `PermissionProfile::Disabled`, and explicitly requests `REQUESTED_MODEL` through `ThreadSettingsOverrides.collaboration_mode`. That ensures each test submits a turn under the same requested-model and permission conditions.

The tests then vary the server response. A mismatched `OpenAI-Model` response header should emit `EventMsg::ModelReroute` from `gpt-5.3-codex` to `gpt-5.2` with reason `HighRiskCyberActivity`, followed by a warning mentioning both models. A 400 JSON error with code `cyber_policy` should surface as `EventMsg::Error` with `CodexErrorInfo::CyberPolicy` and no retry. If the HTTP header matches the requested model but the SSE `response.created` payload embeds a different `OpenAI-Model`, Codex should still reroute and warn. Follow-up tool-call turns must emit at most one warning or one model-verification event per turn even if multiple responses in the turn repeat the metadata. Finally, model-verification metadata should produce a structured `EventMsg::ModelVerification` carrying `ModelVerification::TrustedAccessForCyber` without any reroute, warning event, or warning-like raw response item.

#### Function details

##### `disabled_text_turn`  (lines 38–65)

```
fn disabled_text_turn(test: &TestCodex, text: &str) -> Op
```

**Purpose**: Builds a user-input operation that requests the target model under disabled permissions and no approval prompts, matching the safety-check scenarios under test.

**Data flow**: It takes a `&TestCodex` and text, derives `(sandbox_policy, permission_profile)` from `turn_permission_fields(PermissionProfile::Disabled, test.cwd_path())`, and returns `Op::UserInput` with one `UserInput::Text`, default additional context, local environment selections rooted at `test.config.cwd`, `approval_policy = Never`, the derived sandbox and permission profile, and a collaboration-mode override whose model is `REQUESTED_MODEL` and whose reasoning effort comes from `test.config.model_reasoning_effort`.

**Call relations**: Every test in this file uses this helper to submit its turn. That keeps the requested-model and permission context identical so differences in observed events come only from the mocked server responses.

*Call graph*: calls 3 internal fn (cwd_path, local_selections, turn_permission_fields); called by 7 (cyber_policy_response_emits_typed_error_without_retry, model_verification_emits_structured_event_without_reroute_or_warning, model_verification_only_emits_once_per_turn, openai_model_header_casing_only_mismatch_does_not_warn, openai_model_header_mismatch_emits_warning_event, openai_model_header_mismatch_only_emits_one_warning_per_turn, response_model_field_mismatch_emits_warning_when_header_matches_requested); 2 external calls (default, vec!).


##### `openai_model_header_mismatch_emits_warning_event`  (lines 68–107)

```
async fn openai_model_header_mismatch_emits_warning_event() -> Result<()>
```

**Purpose**: Verifies that an `OpenAI-Model` response-header mismatch triggers both a model-reroute event and a warning event.

**Data flow**: It mounts a completed SSE response with HTTP header `OpenAI-Model: gpt-5.2`, builds a fixture requesting `gpt-5.3-codex`, submits the disabled text turn, waits for `EventMsg::ModelReroute`, asserts `from_model`, `to_model`, and `reason`, then waits for `EventMsg::Warning` and asserts the warning message mentions both requested and server models. Finally it waits for `TurnComplete`.

**Call relations**: This is the baseline safety-downgrade test. It drives the mocked mismatch through the normal turn flow and validates the event sequence emitted by Codex.

*Call graph*: calls 6 internal fn (mount_response_once, sse_completed, sse_response, start_mock_server, test_codex, disabled_text_turn); 5 external calls (assert!, assert_eq!, wait_for_event, panic!, skip_if_no_network!).


##### `cyber_policy_response_emits_typed_error_without_retry`  (lines 110–141)

```
async fn cyber_policy_response_emits_typed_error_without_retry() -> Result<()>
```

**Purpose**: Checks that a 400 `cyber_policy` API error is surfaced as a typed Codex error rather than retried or converted into a reroute warning.

**Data flow**: It mounts a single HTTP 400 response whose JSON body contains the cyber-policy message and code, builds a fixture requesting `REQUESTED_MODEL`, submits the disabled text turn, waits for `EventMsg::Error`, and asserts the error message equals `CYBER_POLICY_MESSAGE` and `codex_error_info` is `Some(CodexErrorInfo::CyberPolicy)`. It then confirms the mock saw exactly one request.

**Call relations**: This test covers the hard-error branch rather than the warning/reroute branch. It uses the same turn helper but validates direct error mapping from API response to emitted event.

*Call graph*: calls 4 internal fn (mount_response_once, start_mock_server, test_codex, disabled_text_turn); 6 external calls (new, assert_eq!, wait_for_event, panic!, json!, skip_if_no_network!).


##### `response_model_field_mismatch_emits_warning_when_header_matches_requested`  (lines 144–203)

```
async fn response_model_field_mismatch_emits_warning_when_header_matches_requested() -> Result<()>
```

**Purpose**: Verifies that Codex still detects a safety downgrade when the HTTP header matches the requested model but the SSE `response.created` payload reports a different model.

**Data flow**: It mounts an SSE response whose first event is a handcrafted `response.created` object containing `headers.OpenAI-Model = SERVER_MODEL`, while the outer HTTP response header is `OpenAI-Model: REQUESTED_MODEL`. After building the fixture and submitting the disabled text turn, it waits for `ModelReroute`, asserts the reroute fields, then waits for a warning whose message contains the high-risk-cyber phrase and asserts that warning mentions both models. It finally waits for `TurnComplete`.

**Call relations**: This test complements the plain header-mismatch case by proving Codex also inspects model metadata embedded in the streamed response body.

*Call graph*: calls 6 internal fn (mount_response_once, sse, sse_response, start_mock_server, test_codex, disabled_text_turn); 6 external calls (assert!, assert_eq!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `openai_model_header_mismatch_only_emits_one_warning_per_turn`  (lines 206–255)

```
async fn openai_model_header_mismatch_only_emits_one_warning_per_turn() -> Result<()>
```

**Purpose**: Checks that repeated model mismatches across multiple response phases in a single turn produce only one warning event.

**Data flow**: It mounts a response sequence: the first response requests a shell tool call and carries the mismatched `OpenAI-Model` header, and the second response completes the turn with the same mismatched header. After submitting the disabled text turn, it loops over all events until `TurnComplete`, counting warnings whose message mentions the requested model, and asserts the count is exactly one.

**Call relations**: This test exercises a multi-response turn to validate per-turn deduplication. It ensures warning emission is not repeated on the follow-up response after a tool call.

*Call graph*: calls 6 internal fn (mount_response_sequence, sse, sse_response, start_mock_server, test_codex, disabled_text_turn); 5 external calls (assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `openai_model_header_casing_only_mismatch_does_not_warn`  (lines 258–296)

```
async fn openai_model_header_casing_only_mismatch_does_not_warn() -> Result<()>
```

**Purpose**: Verifies that case-only differences in the `OpenAI-Model` header do not count as a safety downgrade.

**Data flow**: It mounts a completed SSE response whose `OpenAI-Model` header is the uppercase form of `REQUESTED_MODEL`, builds the fixture, submits the disabled text turn, then drains events until `TurnComplete` while counting `ModelReroute` events and high-risk-cyber warnings. It asserts both counts remain zero.

**Call relations**: This is a normalization edge-case test for the mismatch detector. It proves model comparison is case-insensitive enough to avoid false-positive reroutes and warnings.

*Call graph*: calls 6 internal fn (mount_response_once, sse_completed, sse_response, start_mock_server, test_codex, disabled_text_turn); 3 external calls (assert_eq!, wait_for_event, skip_if_no_network!).


##### `model_verification_emits_structured_event_without_reroute_or_warning`  (lines 299–356)

```
async fn model_verification_emits_structured_event_without_reroute_or_warning() -> Result<()>
```

**Purpose**: Checks that model-verification metadata produces a structured verification event and suppresses reroute or warning side effects.

**Data flow**: It mounts an SSE response containing `ev_model_verification_metadata("resp-1", [TRUSTED_ACCESS_FOR_CYBER_VERIFICATION])`, builds the fixture, submits the disabled text turn, then drains events until `TurnComplete`. During the drain it counts `ModelVerification`, `Warning`, `ModelReroute`, and warning-like `RawResponseItem` messages, asserting the verification payload equals `vec![ModelVerification::TrustedAccessForCyber]` and that only one verification event occurs while all warning/reroute counts stay zero.

**Call relations**: This test covers the structured-verification branch that should replace, not accompany, warning-based downgrade signaling.

*Call graph*: calls 6 internal fn (mount_response_once, sse, sse_response, start_mock_server, test_codex, disabled_text_turn); 5 external calls (assert_eq!, wait_for_event, matches!, skip_if_no_network!, vec!).


##### `model_verification_only_emits_once_per_turn`  (lines 359–412)

```
async fn model_verification_only_emits_once_per_turn() -> Result<()>
```

**Purpose**: Verifies that repeated model-verification metadata across multiple responses in one turn is deduplicated to a single `ModelVerification` event.

**Data flow**: It mounts a two-response sequence where both responses include the same verification metadata and the first also triggers a shell tool call. After submitting the disabled text turn, it drains events until `TurnComplete`, counting `ModelVerification` events and panicking if any high-risk-cyber warning appears. It asserts the verification count is exactly one.

**Call relations**: This is the deduplication counterpart to the single-response verification test. It proves verification metadata is emitted once per turn even when repeated across tool-call follow-up responses.

*Call graph*: calls 6 internal fn (mount_response_sequence, sse, sse_response, start_mock_server, test_codex, disabled_text_turn); 6 external calls (assert_eq!, wait_for_event, panic!, json!, skip_if_no_network!, vec!).
