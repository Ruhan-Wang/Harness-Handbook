# Transport, streaming, and provider protocol suites  `stage-23.2.4.1`

This stage tests the network edge of Codex: the place where a user turn becomes a request to a model service, and where streamed answers come back. It is mainly behind-the-scenes support for the main work loop. The large client suite checks the basic machinery: request shape, auth headers, history, reasoning options, token counts, and provider differences. Header-focused tests make sure turn, sub-agent, workspace, and proxy identity labels are carried correctly. Compression, model-list ETag refresh, quota errors, and safety-check downgrade tests protect specific provider rules and user-facing failures.

Several tests cover streaming paths. HTTP streaming recovery tests make sure Codex can retry if a stream ends early and can continue after a failed turn. WebSocket tests check long-lived connections for normal model replies, agent messages, warmups, retries, tracing, service tiers, and fallback to plain HTTP when WebSockets fail. Realtime conversation tests cover live audio/text sessions and handoffs back to the normal agent. Other tests cover remote compaction of long chats, the lighter Responses Lite request path, and temporary turn state that must be used for one turn only.

## Files in this stage

### HTTP request shaping
These tests cover how standard Responses API HTTP requests are constructed, annotated, compressed, and refreshed at the API boundary.

### `core/tests/suite/client.rs`

`test` · `test run`

Think of this file as a customs checkpoint for every request Codex sends to an AI model service. The tests start fake web servers, configure Codex in different ways, send user messages, and then inspect the exact HTTP request Codex produced. That matters because small mistakes here can break real conversations: the wrong token might be sent, resumed chats might lose history, model settings might be ignored, or rate-limit errors might not reach the user clearly.

The file covers several broad areas. It checks authentication, including API keys, ChatGPT tokens, environment-variable keys, and provider commands that print a bearer token. It checks conversation construction, including AGENTS.md instructions, developer messages, environment context, skills, app guidance, and resumed session files. It also checks model options such as reasoning effort, reasoning summaries, verbosity, Responses Lite behavior, and Azure-specific request requirements. Finally, it checks streamed response edge cases: token usage, rate-limit snapshots, context-window errors, incomplete responses, and duplicate streamed/final assistant messages.

Most tests follow the same pattern: set up a mock server, build a test Codex instance, submit a user turn, wait until Codex reports completion or an error, then assert that the captured request or emitted event matches the expected behavior.

#### Function details

##### `test_turn_responses_metadata`  (lines 98–113)

```
fn test_turn_responses_metadata(
    _client: &ModelClient,
    thread_id: ThreadId,
) -> codex_core::CodexResponsesMetadata
```

**Purpose**: Builds a standard block of fake metadata for one model request in tests. This lets lower-level client tests send requests with realistic Codex session, thread, installation, and turn information.

**Data flow**: It receives a model client reference and a thread id, converts the thread id to text, combines it with fixed test identifiers, and returns a Codex responses metadata object. It does not change the client.

**Call relations**: The direct client-streaming tests call this before starting a Responses API stream. It hands metadata to the model client so those tests can focus on provider behavior instead of rebuilding the same metadata each time.

*Call graph*: called by 2 (azure_responses_request_includes_store_and_reasoning_ids, send_provider_auth_request); 2 external calls (responses_metadata, to_string).


##### `assert_message_role`  (lines 116–118)

```
fn assert_message_role(request_body: &serde_json::Value, role: &str)
```

**Purpose**: Checks that a JSON request item has the expected message role, such as `user`, `developer`, or `assistant`. Tests use it to make request-shape assertions easier to read.

**Data flow**: It receives a JSON value and an expected role string, reads the value's `role` field, and fails the test if the field is missing or different.

**Call relations**: Instruction-related tests call this after capturing a request from the mock server. It provides a small, shared assertion before those tests inspect the message contents.

*Call graph*: called by 2 (includes_developer_instructions_message_in_request, includes_user_instructions_message_in_request); 1 external calls (assert_eq!).


##### `message_input_texts`  (lines 121–128)

```
fn message_input_texts(item: &serde_json::Value) -> Vec<&str>
```

**Purpose**: Extracts all plain text snippets from the `content` array of a message JSON item. This helps tests look for instructions or conversation text without repeating JSON-walking code.

**Data flow**: It receives one JSON message item, reads its `content` list, keeps entries that have a string `text` field, and returns those strings as a list of borrowed text slices.

**Call relations**: Resume and instruction tests call this when checking captured request bodies. Other helpers also build on it to search for particular phrases.

*Call graph*: called by 3 (includes_developer_instructions_message_in_request, includes_user_instructions_message_in_request, resume_includes_initial_messages_and_sends_prior_items).


##### `message_input_text_contains`  (lines 130–135)

```
fn message_input_text_contains(request: &ResponsesRequest, role: &str, needle: &str) -> bool
```

**Purpose**: Answers the question, `Does this captured request contain this text in messages with this role?` It is a convenience helper for tests that only care whether a guidance snippet is present or absent.

**Data flow**: It receives a captured Responses request, a role name, and a search phrase. It asks the request for text messages with that role, searches each text for the phrase, and returns true or false.

**Call relations**: Apps and environment-context tests use it after the mock server records a request. Internally it relies on message-text extraction so each test does not have to parse JSON by hand.

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

**Purpose**: Verifies that Codex placed the right session, thread, turn, window, and installation identifiers into the request body metadata. These fields help backend systems trace which local conversation a request came from.

**Data flow**: It receives a request JSON body and the expected ids. It reads `client_metadata`, parses the nested turn metadata JSON string, and fails the test if any id or paired field does not match.

**Call relations**: API-key and ChatGPT-auth request tests call this after checking headers. It confirms that request identity is consistent both in top-level client metadata and in the nested turn metadata.

*Call graph*: called by 2 (chatgpt_auth_sends_correct_request, includes_session_id_thread_id_and_model_headers_in_request); 1 external calls (assert_eq!).


##### `non_openai_responses_requests_omit_item_turn_metadata`  (lines 172–220)

```
async fn non_openai_responses_requests_omit_item_turn_metadata()
```

**Purpose**: Checks that request input items for a non-standard Responses provider do not include per-item turn metadata. This prevents Codex from sending OpenAI-specific decoration to providers that may not accept it.

**Data flow**: The test starts a mock server, points a copied provider configuration at it, submits `hello`, waits for the turn to finish, then inspects every input item in the captured JSON request. The expected result is that none of those items has a `metadata` field.

**Call relations**: The async test runner invokes this test. It uses the common test Codex builder, mock SSE response helpers, and event-waiting helper to drive one complete request.

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

**Purpose**: Creates a temporary `auth.json` file containing fake API-key and ChatGPT-token credentials. Tests use it to simulate a real saved login without contacting a real auth service.

**Data flow**: It receives a temporary Codex home directory plus optional API key, plan type, access token, and account id. It builds a fake unsigned JSON Web Token, writes all credentials to `auth.json`, and returns the fake id token string.

**Call relations**: The API-key-preference test calls this before loading authentication from disk. The loaded auth then flows into Codex startup exactly as if a user already had credentials saved.

*Call graph*: called by 1 (prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens); 6 external calls (path, format!, json!, to_string_pretty, to_vec, write).


##### `ProviderAuthCommandFixture::new`  (lines 281–345)

```
fn new(tokens: &[&str]) -> std::io::Result<Self>
```

**Purpose**: Creates a temporary command-line program that prints one bearer token at a time. This lets tests simulate providers whose authentication token is fetched by running an external command.

**Data flow**: It receives a list of token strings, writes them to a temporary file, writes a small shell or Windows command script that prints and removes the first token, and returns a fixture containing the command, arguments, and temporary directory.

**Call relations**: The provider-auth tests call this before sending requests. Its fixture feeds `ProviderAuthCommandFixture::auth`, which becomes the provider auth configuration used by the model client.

*Call graph*: called by 2 (provider_auth_command_refreshes_after_401, provider_auth_command_supplies_bearer_token); 7 external calls (new, new, metadata, set_permissions, write, tempdir, vec!).


##### `ProviderAuthCommandFixture::auth`  (lines 347–357)

```
fn auth(&self) -> ModelProviderAuthInfo
```

**Purpose**: Turns the temporary token-printing command into a `ModelProviderAuthInfo` configuration object. Codex can then run that command when it needs an Authorization bearer token.

**Data flow**: It reads the fixture's command, arguments, and temporary directory, adds timeout and refresh timing settings, and returns a provider-auth configuration. It does not run the command itself.

**Call relations**: The provider-auth tests call this and pass the result into `send_provider_auth_request`. It depends on `non_zero_u64` to build the non-zero timeout value required by the config type.

*Call graph*: calls 2 internal fn (non_zero_u64, try_from); 1 external calls (path).


##### `non_zero_u64`  (lines 360–362)

```
fn non_zero_u64(value: u64) -> NonZeroU64
```

**Purpose**: Converts a regular positive number into Rust's `NonZeroU64` type, which is a number type that cannot contain zero. It is used where configuration requires a timeout value that must be non-zero.

**Data flow**: It receives a `u64`, tries to wrap it as non-zero, and returns the wrapped value. If zero is passed, the test fails immediately.

**Call relations**: `ProviderAuthCommandFixture::auth` calls this while building command-backed auth settings. It keeps the fixture code readable and makes the non-zero requirement explicit.

*Call graph*: called by 1 (auth); 1 external calls (new).


##### `resume_includes_initial_messages_and_sends_prior_items`  (lines 365–571)

```
async fn resume_includes_initial_messages_and_sends_prior_items()
```

**Purpose**: Tests that resuming a saved conversation sends the right old conversation items to the model, while not incorrectly converting saved response items into initial UI messages. This protects chat continuity after restart.

**Data flow**: It writes a fake session file with prior user, system, and assistant items, resumes Codex from that file, submits a new `hello`, then inspects the request. Prior user and assistant messages must appear before new context and new input, while the prior system message is excluded from API history.

**Call relations**: The test runner invokes it. It uses the resume-capable test builder, mock SSE server, `message_input_texts`, and event waiting to verify both startup resume state and the next request body.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, test_codex, message_input_texts); 15 external calls (new, default, start, new, new_v4, new, assert!, assert_eq!, wait_for_event, json! (+5 more)).


##### `resume_replays_legacy_js_repl_image_rollout_shapes`  (lines 574–714)

```
async fn resume_replays_legacy_js_repl_image_rollout_shapes()
```

**Purpose**: Checks backward compatibility for old saved sessions where JavaScript REPL image results were stored in an older two-item shape. Without this, users could resume older chats and lose image-related context.

**Data flow**: It writes a rollout file containing a legacy custom tool call output and a separate user image message, resumes Codex, submits a new turn, and inspects the request input. The old tool output and image message must both be replayed before the new user text.

**Call relations**: The async test runner calls it. It uses rollout data structures directly, then relies on the test Codex resume path and mock server capture to prove the replay logic still understands legacy files.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 9 external calls (new, start, new, assert!, assert_eq!, skip_if_no_network!, create, vec!, writeln!).


##### `resume_replays_image_tool_outputs_with_detail`  (lines 717–842)

```
async fn resume_replays_image_tool_outputs_with_detail()
```

**Purpose**: Checks that resumed tool outputs containing images preserve the image `detail` setting. The detail tells the model how much image information to consider, so dropping it would change what the model sees.

**Data flow**: It creates a saved rollout with both normal function-call output and custom-tool output containing image content marked `original`, resumes the conversation, submits another turn, and checks the captured request. Both replayed outputs must include the image URL and `detail: original`.

**Call relations**: The test runner calls it. It uses the resume builder and mock SSE response, then request-inspection helpers on the captured request to check both function and custom tool output forms.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 8 external calls (new, start, new, assert_eq!, skip_if_no_network!, create, vec!, writeln!).


##### `includes_session_id_thread_id_and_model_headers_in_request`  (lines 845–911)

```
async fn includes_session_id_thread_id_and_model_headers_in_request()
```

**Purpose**: Verifies that a normal API-key request carries the session id, thread id, originator, authorization header, prompt cache key, and metadata. These values connect the backend request to the local Codex conversation.

**Data flow**: It starts a mock server, builds Codex with an API key, submits `hello`, waits for completion, then reads headers and JSON body from the captured request. The expected output is a set of matching ids and a bearer-token Authorization header.

**Call relations**: The test runner invokes it. It uses `assert_codex_client_metadata` for the detailed metadata check after the mock server records the outgoing request.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, test_codex, assert_codex_client_metadata, from_api_key); 7 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, read_to_string, vec!).


##### `provider_auth_command_supplies_bearer_token`  (lines 914–927)

```
async fn provider_auth_command_supplies_bearer_token()
```

**Purpose**: Tests that a provider-configured auth command can supply the bearer token used in the Authorization header. This supports enterprise or custom providers that issue tokens outside Codex.

**Data flow**: It creates a mock server expecting `Bearer command-token`, creates a command fixture that prints that token, and sends one provider-auth request. The test passes when the request reaches completion with the expected header.

**Call relations**: The test runner calls it. It creates the fixture with `ProviderAuthCommandFixture::new`, converts it with `auth`, and delegates the actual client streaming work to `send_provider_auth_request`.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, new, send_provider_auth_request); 4 external calls (start, skip_if_no_network!, vec!, header).


##### `provider_auth_command_refreshes_after_401`  (lines 930–959)

```
async fn provider_auth_command_refreshes_after_401()
```

**Purpose**: Tests that Codex retries authentication by rerunning the provider auth command after a 401 unauthorized response. This matters when a command returns an expired token first and a fresh token next.

**Data flow**: It sets up a server that rejects `first-token` with 401 and accepts `second-token`, creates a fixture that prints those tokens in order, then sends one request. The successful outcome is that Codex refreshes and completes using the second token.

**Call relations**: The test runner invokes it. Like the simple provider-auth test, it uses the fixture and then hands off to `send_provider_auth_request` to exercise the real model client path.

*Call graph*: calls 3 internal fn (sse, new, send_provider_auth_request); 8 external calls (given, start, new, skip_if_no_network!, vec!, header_regex, method, path).


##### `send_provider_auth_request`  (lines 966–1056)

```
async fn send_provider_auth_request(server: &MockServer, auth: ModelProviderAuthInfo)
```

**Purpose**: Runs one streamed Responses API request through a custom provider that uses command-backed authentication. It is a shared helper for tests that assert server-side auth behavior.

**Data flow**: It receives a mock server and provider auth settings, builds a provider configuration pointing at the server, constructs model info, telemetry, a model client, prompt input, and metadata, then starts a stream. It reads events until a completed response appears.

**Call relations**: The provider-auth tests call this after setting up server expectations. It calls `test_turn_responses_metadata` and lower-level model-client streaming code so the tests exercise the same path used by real requests.

*Call graph*: calls 10 internal fn (new, default, construct_model_info_offline, get_model_offline, test_turn_responses_metadata, from_auth_for_testing, from_api_key, new, new, disabled); called by 2 (provider_auth_command_refreshes_after_401, provider_auth_command_supplies_bearer_token); 5 external calls (new, new, load_default_config_for_test, format!, vec!).


##### `includes_base_instructions_override_in_request`  (lines 1059–1105)

```
async fn includes_base_instructions_override_in_request()
```

**Purpose**: Checks that configured base instructions are sent in the request's `instructions` field. These are the top-level instructions that guide model behavior.

**Data flow**: It builds Codex with `base_instructions` set to `test instructions`, submits `hello`, waits for completion, then reads the captured request body. The expected result is that the instructions string contains the configured text.

**Call relations**: The test runner calls it. It uses the standard mock SSE server and test Codex builder to drive a normal turn, then inspects the request.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, test_codex, from_api_key); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `chatgpt_auth_sends_correct_request`  (lines 1108–1188)

```
async fn chatgpt_auth_sends_correct_request()
```

**Purpose**: Verifies the request shape when Codex is authenticated with ChatGPT-style tokens instead of a plain API key. This includes a different base path, account header, and encrypted reasoning include setting.

**Data flow**: It points the OpenAI provider at a fake `/api/codex` server, builds Codex with dummy ChatGPT auth, submits `hello`, and inspects the captured request. It checks authorization, account id, session/thread headers, metadata, streaming, and included reasoning content.

**Call relations**: The test runner invokes it. It uses `create_dummy_codex_auth` for fake ChatGPT credentials and `assert_codex_client_metadata` for the shared metadata checks.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, test_codex, assert_codex_client_metadata, create_dummy_codex_auth); 10 external calls (default, start, assert!, assert_eq!, built_in_model_providers, wait_for_event, format!, skip_if_no_network!, read_to_string, vec!).


##### `prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens`  (lines 1191–1280)

```
async fn prefers_apikey_when_config_prefers_apikey_even_with_chatgpt_tokens()
```

**Purpose**: Tests that Codex can prefer an API key even when saved ChatGPT tokens are also present. This prevents the wrong credential type from being used when configuration says API-key auth should win.

**Data flow**: It writes an auth file containing both an API key and ChatGPT tokens, loads auth from disk, starts a thread manager with a mock provider, submits `hello`, and lets the mock server require the API-key bearer token. Completion proves the API key was used.

**Call relations**: The test runner calls it. It uses `write_auth_json` to create the mixed credential file, then exercises the fuller thread-manager startup path instead of only the lightweight test builder.

*Call graph*: calls 7 internal fn (default, auth_manager_from_auth, new, sse, write_auth_json, default_for_tests, from_auth_storage); 18 external calls (new, default, given, start, new, new, resolve_installation_id, thread_store_from_config, empty_extension_registry, built_in_model_providers (+8 more)).


##### `includes_user_instructions_message_in_request`  (lines 1283–1360)

```
async fn includes_user_instructions_message_in_request()
```

**Purpose**: Checks that AGENTS.md instructions are sent as contextual user content, not folded into the top-level instructions string. This keeps project guidance separate from base system instructions.

**Data flow**: It writes an `AGENTS.md` file, submits a turn, then inspects the request. The top-level instructions must not contain the AGENTS text; the input should start with a developer permissions message, followed by a user context message containing AGENTS.md instructions and environment context.

**Call relations**: The test runner invokes it. It uses `assert_message_role` and `message_input_texts` to make the request-body checks readable.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, test_codex, assert_message_role, message_input_texts, from_api_key); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `includes_apps_guidance_as_developer_message_for_chatgpt_auth`  (lines 1363–1423)

```
async fn includes_apps_guidance_as_developer_message_for_chatgpt_auth()
```

**Purpose**: Checks that Apps or Connectors guidance is added as a developer message when Apps are enabled and the user is authenticated through ChatGPT. This gives the model instructions for app-trigger syntax only when that feature is available.

**Data flow**: It mounts a fake Apps server, enables the Apps feature, builds Codex with dummy ChatGPT auth, submits `hello`, and searches the captured request. The Apps guidance must appear in developer messages and not in user messages.

**Call relations**: The test runner calls it. It uses `create_dummy_codex_auth`, the Apps test server, and `message_input_text_contains` to verify placement of the guidance text.

*Call graph*: calls 5 internal fn (mount, mount_sse_once, sse, test_codex, create_dummy_codex_auth); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `omits_apps_guidance_for_api_key_auth_even_when_feature_enabled`  (lines 1426–1481)

```
async fn omits_apps_guidance_for_api_key_auth_even_when_feature_enabled()
```

**Purpose**: Checks that Apps guidance is not sent for API-key authentication, even if the Apps feature flag is enabled. This prevents instructions for ChatGPT-only app behavior from leaking into unsupported sessions.

**Data flow**: It enables Apps, uses API-key auth, submits `hello`, and searches all developer and user message text in the captured request. The Apps guidance snippet must be absent.

**Call relations**: The test runner invokes it. It uses the same mock Apps setup as the ChatGPT-auth test, but changes the auth mode to prove the condition depends on credentials.

*Call graph*: calls 5 internal fn (mount, mount_sse_once, sse, test_codex, from_api_key); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `omits_apps_guidance_when_configured_off`  (lines 1484–1536)

```
async fn omits_apps_guidance_when_configured_off()
```

**Purpose**: Checks that Apps instructions are omitted when the explicit `include_apps_instructions` setting is false. This gives configuration a clear way to suppress that guidance.

**Data flow**: It enables Apps and ChatGPT auth but turns off app instructions in config, submits `hello`, then searches developer messages. The `<apps_instructions>` block must not be present.

**Call relations**: The test runner calls it. It uses `create_dummy_codex_auth`, the Apps test server, and text-search helper logic to check that the configuration override wins.

*Call graph*: calls 5 internal fn (mount, mount_sse_once, sse, test_codex, create_dummy_codex_auth); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `omits_environment_context_when_configured_off`  (lines 1539–1578)

```
async fn omits_environment_context_when_configured_off()
```

**Purpose**: Checks that Codex does not include environment context when configuration disables it. Environment context describes things like the current workspace, so users may want to suppress it.

**Data flow**: It builds Codex with `include_environment_context` set to false, submits `hello`, and examines user messages in the captured request. The `<environment_context>` block must be absent.

**Call relations**: The test runner invokes it. It uses the standard one-turn mock server flow and the text-search helper to verify the request content.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 5 external calls (default, start, assert!, wait_for_event, vec!).


##### `skills_append_to_developer_message`  (lines 1581–1647)

```
async fn skills_append_to_developer_message()
```

**Purpose**: Verifies that discovered skills are summarized in a developer message. Skills are local reusable instructions or capabilities, and the model needs to know their names, descriptions, and file locations.

**Data flow**: It creates a temporary `skills/demo/SKILL.md`, builds Codex with that directory as the working area, submits `hello`, and inspects developer messages. The message must include a Skills section, the demo skill summary, and the normalized path to the skill file.

**Call relations**: The test runner calls it. It uses file-system setup, the test Codex builder, and captured request inspection to prove skill discovery affects the outgoing prompt.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, test_codex, from_api_key); 11 external calls (new, default, start, new, assert!, wait_for_event, canonicalize, skip_if_no_network!, create_dir_all, write (+1 more)).


##### `skills_use_aliases_in_developer_message_under_budget_pressure`  (lines 1650–1737)

```
async fn skills_use_aliases_in_developer_message_under_budget_pressure()
```

**Purpose**: Checks that long skill paths are shortened with aliases when prompt space is tight. This keeps the skill list useful without wasting too much of the model's context window.

**Data flow**: It creates many skills under a long temporary path, disables bundled skills, lowers the context window, submits `hello`, and inspects developer messages. The expected result is a `Skill roots` alias section and skill entries using compact paths like `r0/s00/SKILL.md`.

**Call relations**: The test runner invokes it. It uses temporary files and configuration layering to create budget pressure, then checks the generated developer guidance in the captured request.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, test_codex, from_api_key); 13 external calls (new, default, start, new, new_in, assert!, wait_for_event, canonicalize, format!, skip_if_no_network! (+3 more)).


##### `includes_configured_effort_in_request`  (lines 1740–1785)

```
async fn includes_configured_effort_in_request() -> anyhow::Result<()>
```

**Purpose**: Checks that an explicitly configured reasoning effort is sent to models that support it. Reasoning effort tells the model how much thinking effort to spend.

**Data flow**: It configures model `gpt-5.4` with medium reasoning effort, submits `hello`, and reads the captured request body. The `reasoning.effort` field must be `medium`.

**Call relations**: The test runner calls it. It uses the standard mock server and test builder to confirm config values flow into the outgoing request.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `includes_no_effort_in_request`  (lines 1788–1827)

```
async fn includes_no_effort_in_request() -> anyhow::Result<()>
```

**Purpose**: Despite its name, this test currently verifies that the request contains the model's default reasoning effort when no explicit effort is configured. It protects the defaulting behavior for the chosen test model.

**Data flow**: It builds Codex with `gpt-5.4`, submits `hello`, and inspects the request body. The resulting `reasoning.effort` field is expected to be `medium`.

**Call relations**: The test runner invokes it. It shares the same one-turn request flow as other model-option tests and relies on model metadata for the default value.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `includes_default_reasoning_effort_in_request_when_defined_by_model_info`  (lines 1830–1870)

```
async fn includes_default_reasoning_effort_in_request_when_defined_by_model_info() -> anyhow::Result<()>
```

**Purpose**: Checks that model catalog information can provide a default reasoning effort. This means users do not need to configure effort manually for models with known defaults.

**Data flow**: It builds Codex for `gpt-5.4`, submits `hello`, and checks the captured JSON request. The request must include `reasoning.effort` set to `medium` from model information.

**Call relations**: The test runner calls it. It follows the same mock-request pattern as the other reasoning-effort tests and validates the model-info default path.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `user_turn_collaboration_mode_overrides_model_and_effort`  (lines 1873–1930)

```
async fn user_turn_collaboration_mode_overrides_model_and_effort() -> anyhow::Result<()>
```

**Purpose**: Tests that per-turn collaboration-mode settings can override the model and reasoning effort used for a single user turn. This supports UI modes that temporarily change how Codex should answer.

**Data flow**: It builds Codex, creates a collaboration mode with model `gpt-5.4` and high effort, submits `hello` with thread-setting overrides, and inspects the request. The outgoing body must use the overridden model and `reasoning.effort: high`.

**Call relations**: The test runner invokes it. It uses `local_selections` and normal config values to fill required thread settings, then verifies the override in the captured request.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, local_selections, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `configured_reasoning_summary_is_sent`  (lines 1933–1983)

```
async fn configured_reasoning_summary_is_sent() -> anyhow::Result<()>
```

**Purpose**: Checks that a configured reasoning-summary style is sent in the request. Reasoning summaries are concise or detailed descriptions of the model's hidden reasoning, when supported.

**Data flow**: It configures `ReasoningSummary::Concise`, submits `hello`, and reads the captured request body. The `reasoning.summary` field must be `concise`, and the `reasoning.context` field must be absent.

**Call relations**: The test runner calls it. It uses the common mock-server flow and request inspection to verify reasoning-summary configuration.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `responses_lite_sets_all_turns_context_and_disables_parallel_tool_calls`  (lines 1986–2031)

```
async fn responses_lite_sets_all_turns_context_and_disables_parallel_tool_calls() -> anyhow::Result<()>
```

**Purpose**: Checks special request settings for models marked as using Responses Lite. For that mode, Codex should send all-turns reasoning context and turn off parallel tool calls.

**Data flow**: It overrides model info to enable Responses Lite and parallel-tool-call support, submits `hello`, and inspects the request body. The request must contain `reasoning.context: all_turns` and `parallel_tool_calls: false`.

**Call relations**: The test runner invokes it. It uses model-info override support in the test builder to simulate this model capability combination.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `user_turn_explicit_reasoning_summary_overrides_model_catalog_default`  (lines 2034–2108)

```
async fn user_turn_explicit_reasoning_summary_overrides_model_catalog_default() -> anyhow::Result<()>
```

**Purpose**: Tests that a per-turn explicit reasoning summary setting beats the model catalog's default. This lets a user or UI choose a different summary style for one turn.

**Data flow**: It edits the bundled model catalog so `gpt-5.4` defaults to detailed summaries, then submits a turn with overrides requesting concise summary. The captured request must send `reasoning.summary: concise`.

**Call relations**: The test runner calls it. It combines catalog editing, thread-setting overrides, and captured request assertions to prove per-turn settings take priority.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, local_selections, test_codex); 7 external calls (default, start, bundled_models_response, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `reasoning_summary_is_omitted_when_disabled`  (lines 2111–2154)

```
async fn reasoning_summary_is_omitted_when_disabled() -> anyhow::Result<()>
```

**Purpose**: Checks that setting reasoning summary to `None` really omits the summary field. This is important when users do not want reasoning summaries requested.

**Data flow**: It configures `ReasoningSummary::None`, submits `hello`, and inspects the request body. The `reasoning.summary` field must not exist.

**Call relations**: The test runner invokes it. It follows the same request-capture pattern as the other reasoning-summary tests.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `reasoning_summary_none_overrides_model_catalog_default`  (lines 2157–2210)

```
async fn reasoning_summary_none_overrides_model_catalog_default() -> anyhow::Result<()>
```

**Purpose**: Checks that an explicit `None` setting suppresses a model catalog default reasoning summary. User configuration must be able to turn off summaries even when the model metadata suggests one.

**Data flow**: It edits the model catalog to default to detailed summaries, configures `ReasoningSummary::None`, submits `hello`, and checks the request. No `reasoning.summary` field should be sent.

**Call relations**: The test runner calls it. It uses bundled model metadata plus config override to verify the priority order.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 7 external calls (default, start, bundled_models_response, wait_for_event, assert_eq!, skip_if_no_network!, vec!).


##### `includes_default_verbosity_in_request`  (lines 2213–2252)

```
async fn includes_default_verbosity_in_request() -> anyhow::Result<()>
```

**Purpose**: Checks that the default text verbosity is sent for a model that supports verbosity. Verbosity controls how terse or detailed the model's answer should be.

**Data flow**: It builds Codex with `gpt-5.4`, submits `hello`, and reads the captured request body. The request must include `text.verbosity: low`.

**Call relations**: The test runner invokes it. It uses the standard mock-server request capture used by the model-option tests.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `configured_verbosity_not_sent_for_models_without_support`  (lines 2255–2299)

```
async fn configured_verbosity_not_sent_for_models_without_support() -> anyhow::Result<()>
```

**Purpose**: Checks that Codex does not send a verbosity setting to models that do not support it. This prevents provider errors caused by unsupported request fields.

**Data flow**: It chooses a test model without verbosity support, configures high verbosity, submits `hello`, and inspects the request. The `text.verbosity` field must be absent.

**Call relations**: The test runner calls it. It verifies that model capability checks happen before request fields are added.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `configured_verbosity_is_sent`  (lines 2302–2347)

```
async fn configured_verbosity_is_sent() -> anyhow::Result<()>
```

**Purpose**: Checks that a configured verbosity value is sent for a supporting model. This confirms user preference is honored when the model can accept it.

**Data flow**: It configures high verbosity for `gpt-5.4`, submits `hello`, and checks the captured request body. The `text.verbosity` field must be `high`.

**Call relations**: The test runner invokes it. It complements the unsupported-model verbosity test by proving the positive path.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 6 external calls (default, start, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `includes_developer_instructions_message_in_request`  (lines 2350–2444)

```
async fn includes_developer_instructions_message_in_request()
```

**Purpose**: Checks that configured developer instructions are sent as a developer message, while AGENTS.md remains contextual user content. This keeps different instruction sources in their intended layers.

**Data flow**: It writes `AGENTS.md`, configures developer instructions as `be useful`, submits `hello`, and inspects the request. It expects a permissions developer message, another developer message containing `be useful`, and a user context message containing AGENTS.md plus environment context.

**Call relations**: The test runner calls it. It uses `assert_message_role` and `message_input_texts`, just like the user-instructions test, but also checks the additional developer-instructions path.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, test_codex, assert_message_role, message_input_texts, from_api_key); 6 external calls (default, start, assert!, wait_for_event, skip_if_no_network!, vec!).


##### `azure_responses_request_includes_store_and_reasoning_ids`  (lines 2447–2631)

```
async fn azure_responses_request_includes_store_and_reasoning_ids()
```

**Purpose**: Checks Azure Responses API request details, especially `store: true` and preservation of ids across reasoning, message, search, tool-call, and shell-call items. Azure needs these fields to maintain stored response state correctly.

**Data flow**: It builds a custom Azure-like provider and a prompt containing many different response item types with ids or call ids. It streams one request, then inspects the captured body to confirm the Azure path, store and stream flags, input length, and preserved ids.

**Call relations**: The test runner invokes it. It uses lower-level `ModelClient` streaming directly, along with `test_turn_responses_metadata`, to focus on request serialization rather than full Codex thread orchestration.

*Call graph*: calls 12 internal fn (new, default, auth_manager_from_auth, construct_model_info_offline, get_model_offline, mount_sse_once, test_turn_responses_metadata, from_api_key, new, from_text (+2 more)); 10 external calls (new, start, new, assert_eq!, concat!, load_default_config_for_test, format!, Exec, skip_if_no_network!, vec!).


##### `token_count_includes_rate_limits_snapshot`  (lines 2634–2765)

```
async fn token_count_includes_rate_limits_snapshot()
```

**Purpose**: Tests that final token-count events include both usage numbers and the latest rate-limit snapshot from response headers. This lets the UI show not only how many tokens were used but also how close the user is to limits.

**Data flow**: It makes the mock server return a streamed completion with token usage and rate-limit headers, submits `hello`, waits for a token-count event, and serializes that event to JSON. The event must include total and last token usage, model context window, and primary/secondary rate-limit windows.

**Call relations**: The test runner calls it. It uses normal Codex turn submission, then listens for `EventMsg::TokenCount` before waiting for final turn completion.

*Call graph*: calls 3 internal fn (sse, test_codex, from_api_key); 15 external calls (default, given, start, new, assert_eq!, built_in_model_providers, wait_for_event, format!, assert_eq!, to_value (+5 more)).


##### `usage_limit_error_emits_rate_limit_event`  (lines 2768–2856)

```
async fn usage_limit_error_emits_rate_limit_event() -> anyhow::Result<()>
```

**Purpose**: Checks that a 429 usage-limit error still produces a rate-limit event before the user-facing error. This gives clients enough information to explain limit status.

**Data flow**: It configures the mock server to return a 429 error with rate-limit headers and a usage-limit JSON body, submits `hello`, then waits for a token-count event and an error event. The token-count event should contain rate limits but no usage info, and the error should mention usage limit.

**Call relations**: The test runner invokes it. It uses request mocking, Codex submission, and event waiting to verify both backend error parsing and frontend event emission.

*Call graph*: calls 1 internal fn (test_codex); 14 external calls (default, given, start, new, assert!, wait_for_event, json!, assert_eq!, to_value, skip_if_no_network! (+4 more)).


##### `context_window_error_sets_total_tokens_to_model_window`  (lines 2859–2961)

```
async fn context_window_error_sets_total_tokens_to_model_window() -> anyhow::Result<()>
```

**Purpose**: Checks that when the model reports a context-window overflow, Codex emits token usage equal to the effective model window. This gives the UI a useful number even though the provider did not complete normally.

**Data flow**: It sets a known model context window, completes one seed turn, then sends a second turn that receives a context-length failure stream. The test waits for token-count info where total tokens equal the effective window, then checks that the error event is the standard context-window-exceeded message.

**Call relations**: The test runner calls it. It uses one successful mocked response and one failed mocked response to make sure the token accounting and error path work after conversation history exists.

*Call graph*: calls 4 internal fn (mount_sse_once_match, sse, sse_failed, test_codex); 9 external calls (default, start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, unreachable!, vec!, body_string_contains).


##### `incomplete_response_emits_content_filter_error_message`  (lines 2964–3022)

```
async fn incomplete_response_emits_content_filter_error_message() -> anyhow::Result<()>
```

**Purpose**: Checks that an incomplete streamed response caused by content filtering becomes a clear error message. This protects users from seeing only a vague disconnected-stream failure.

**Data flow**: It makes the mock server stream partial content followed by `response.incomplete` with reason `content_filter`, submits a turn, and waits for an error event. The expected message includes both the stream-disconnected framing and the content-filter reason, and the request should not be retried.

**Call relations**: The test runner invokes it. It uses the mock SSE helpers and event waiting to exercise the stream parser's incomplete-response branch.

*Call graph*: calls 3 internal fn (mount_sse_once, sse, test_codex); 7 external calls (default, start, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `azure_overrides_assign_properties_used_for_responses_url`  (lines 3034–3120)

```
async fn azure_overrides_assign_properties_used_for_responses_url()
```

**Purpose**: Checks that a custom Azure-like provider uses configured URL pieces, query parameters, headers, and environment-variable auth. This protects provider override support for non-default deployments.

**Data flow**: It configures a provider with base URL `/openai`, an `api-version` query parameter, a custom header, and an auth key read from an existing environment variable. After submitting `hello`, the mock server must receive exactly that path, query, header, and bearer token.

**Call relations**: The test runner calls it. It uses `create_dummy_codex_auth` for loaded auth but expects the provider environment key to supply the request authorization.

*Call graph*: calls 3 internal fn (sse, test_codex, create_dummy_codex_auth); 14 external calls (default, given, start, new, wait_for_event, format!, skip_if_no_network!, from, vec!, header (+4 more)).


##### `env_var_overrides_loaded_auth`  (lines 3123–3209)

```
async fn env_var_overrides_loaded_auth()
```

**Purpose**: Checks that a provider environment-variable key overrides already loaded ChatGPT auth for the outgoing request. This matters for custom providers that should use their own token source.

**Data flow**: It configures a provider whose auth token comes from an existing environment variable, while also building Codex with dummy ChatGPT auth. The submitted request must use the environment-variable bearer token, plus the configured path, query parameter, and custom header.

**Call relations**: The test runner invokes it. It mirrors the Azure override test and uses `create_dummy_codex_auth` to prove loaded auth does not take precedence over the provider's env key.

*Call graph*: calls 3 internal fn (sse, test_codex, create_dummy_codex_auth); 14 external calls (default, given, start, new, wait_for_event, format!, skip_if_no_network!, from, vec!, header (+4 more)).


##### `create_dummy_codex_auth`  (lines 3211–3213)

```
fn create_dummy_codex_auth() -> CodexAuth
```

**Purpose**: Creates fake ChatGPT-style authentication for tests. It avoids real login while still exercising code paths that depend on ChatGPT auth being present.

**Data flow**: It takes no input, calls the auth library's testing constructor, and returns a `CodexAuth` value containing dummy ChatGPT credentials.

**Call relations**: Several ChatGPT-auth and provider-override tests call this before building Codex. It centralizes the fake-auth setup so each test can focus on request behavior.

*Call graph*: calls 1 internal fn (create_dummy_chatgpt_auth_for_testing); called by 5 (azure_overrides_assign_properties_used_for_responses_url, chatgpt_auth_sends_correct_request, env_var_overrides_loaded_auth, includes_apps_guidance_as_developer_message_for_chatgpt_auth, omits_apps_guidance_when_configured_off).


##### `history_dedupes_streamed_and_final_messages_across_turns`  (lines 3222–3348)

```
async fn history_dedupes_streamed_and_final_messages_across_turns()
```

**Purpose**: Tests that Codex does not duplicate assistant messages when a response arrives first as streamed text deltas and then again as a final message item. Without this, conversation history sent on later turns could contain repeated assistant replies.

**Data flow**: It sets up three sequential mock streamed responses that each emit deltas and the same final assistant message, submits user turns `U1`, `U2`, and `U3`, then inspects the third request. The tail of the third request must contain each user turn and one assistant message per completed prior turn, with no duplicate from streaming.

**Call relations**: The test runner calls it. It uses `mount_sse_sequence` to capture all three requests and verifies the accumulated history after multiple complete Codex turns.

*Call graph*: calls 4 internal fn (mount_sse_sequence, sse, test_codex, from_api_key); 7 external calls (default, start, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


### `core/tests/responses_headers.rs`

`test` · `test run`

When Codex talks to a model provider, it does not only send the user’s prompt. It also sends small pieces of context in HTTP headers and request metadata. These details tell the service where the request came from, which conversation turn it belongs to, whether it was started by a sub-agent, and what workspace state Codex is working in. If these values are missing or wrong, server-side logging, routing, debugging, and product behavior can become confused even though the text prompt itself looks fine.

This test file uses a mock Responses API server, which is like a fake checkout counter that records exactly what Codex sends. Each test builds a small Codex client or test session, sends a simple prompt, waits for the fake streaming response to finish, and then inspects the recorded request.

The tests cover several real-world cases. They check that review sub-agents and named sub-agents add the expected `x-openai-subagent` header. They check that model settings from configuration can override default model information and cause reasoning summary data to be sent. The larger end-to-end test creates a temporary Git repository and verifies that turn metadata includes stable per-turn IDs, timestamps, sandbox status, and Git workspace facts such as the latest commit and remote URL. In short, this file makes sure the invisible envelope around a model request is correct.

#### Function details

##### `normalize_git_remote_url`  (lines 28–34)

```
fn normalize_git_remote_url(url: &str) -> String
```

**Purpose**: This helper makes two Git remote URLs easier to compare by removing harmless differences. It trims whitespace, removes a trailing slash, and ignores a final `.git` suffix.

**Data flow**: It receives a remote URL as text. It cleans the text in a few simple ways, then returns the cleaned version as a new string. It does not change anything outside itself.

**Call relations**: The Git workspace test uses this when comparing the remote URL found in request metadata with the URL reported by Git. This keeps the test focused on whether Codex found the right remote, not on minor formatting differences.


##### `test_turn_responses_metadata`  (lines 37–53)

```
fn test_turn_responses_metadata(
    _client: &ModelClient,
    thread_id: ThreadId,
    session_source: &SessionSource,
) -> codex_core::CodexResponsesMetadata
```

**Purpose**: This helper builds predictable Responses API metadata for a single test turn. It gives the tests stable values, such as a fixed installation ID and a window ID based on the thread ID, so assertions can be exact.

**Data flow**: It receives a model client, a thread ID, and the session source. It turns the thread ID into text, combines it with a fixed installation ID and turn-related values, and returns a `CodexResponsesMetadata` object used when sending a model request.

**Call relations**: The sub-agent and model-override tests call this before opening a response stream. The returned metadata is passed into the client’s streaming call, and the tests later confirm that the resulting HTTP request contains the expected headers and body metadata.

*Call graph*: called by 3 (responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review); 3 external calls (responses_metadata, format!, to_string).


##### `responses_stream_includes_subagent_header_on_review`  (lines 56–184)

```
async fn responses_stream_includes_subagent_header_on_review()
```

**Purpose**: This test proves that when a request comes from the built-in review sub-agent, Codex labels the outgoing model request with `x-openai-subagent: review`. It also checks related request metadata such as the Codex window ID and installation ID.

**Data flow**: The test starts a mock server that expects the review sub-agent header. It builds a temporary configuration, creates a model client for a review sub-agent session, sends a small user message, waits for the fake stream to complete, and then reads the recorded request. The final assertions compare the recorded headers and JSON body fields with the expected values.

**Call relations**: This is one of the direct test cases in the file. It uses the shared metadata helper to prepare turn metadata, then relies on the mock Responses server to capture what the lower-level streaming client actually sent.

*Call graph*: calls 11 internal fn (new, default, construct_model_info_offline, get_model_offline, mount_sse_once_match, sse, start_mock_server, test_turn_responses_metadata, new, new (+1 more)); 10 external calls (new, new, SubAgent, assert_eq!, load_default_config_for_test, skip_if_no_network!, format!, matches!, vec!, header).


##### `responses_stream_includes_subagent_header_on_other`  (lines 187–301)

```
async fn responses_stream_includes_subagent_header_on_other()
```

**Purpose**: This test proves that a custom-named sub-agent is also reported to the model service. In this case, the outgoing request should contain `x-openai-subagent: my-task`.

**Data flow**: The test starts a mock server that matches the custom sub-agent header. It creates a temporary model configuration and a client whose session source is a custom sub-agent named `my-task`. After sending a simple prompt and reading the streaming response to completion, it inspects the captured request and checks that the header value is exactly the custom name.

**Call relations**: This mirrors the review sub-agent test, but uses the more general custom sub-agent path. It calls the shared metadata builder, then exercises the same streaming request path that production code uses.

*Call graph*: calls 11 internal fn (new, default, construct_model_info_offline, get_model_offline, mount_sse_once_match, sse, start_mock_server, test_turn_responses_metadata, new, new (+1 more)); 11 external calls (new, new, SubAgent, assert_eq!, load_default_config_for_test, skip_if_no_network!, format!, matches!, Other, vec! (+1 more)).


##### `responses_respects_model_info_overrides_from_config`  (lines 304–432)

```
async fn responses_respects_model_info_overrides_from_config()
```

**Purpose**: This test checks that configuration can override the default model information used when building a Responses API request. In particular, it verifies that enabling reasoning summaries in config causes a detailed reasoning summary setting to appear in the request body.

**Data flow**: The test creates a mock server and a temporary configuration where the model is set to `gpt-3.5-turbo`, reasoning summaries are marked as supported, and the desired summary level is `Detailed`. It sends a prompt through a model client, captures the outgoing request, reads the JSON body, and checks that the `reasoning.summary` field is present and set to `detailed`.

**Call relations**: This test uses the same streaming machinery as the header tests, but focuses on the request body rather than only HTTP headers. It calls the shared metadata helper and the offline model-info constructor so it can confirm that configuration choices make it all the way into the API request.

*Call graph*: calls 12 internal fn (new, default, auth_manager_from_auth, construct_model_info_offline, mount_sse_once, sse, start_mock_server, test_turn_responses_metadata, from_api_key, new (+2 more)); 11 external calls (new, new, SubAgent, assert!, assert_eq!, load_default_config_for_test, skip_if_no_network!, format!, matches!, Other (+1 more)).


##### `responses_stream_includes_turn_metadata_header_for_git_workspace_e2e`  (lines 435–651)

```
async fn responses_stream_includes_turn_metadata_header_for_git_workspace_e2e()
```

**Purpose**: This end-to-end test checks that Codex attaches turn metadata to Responses API requests, including Git workspace details when the current folder is a Git repository. It confirms that every request in one user turn shares the same turn identity and timestamp.

**Data flow**: The test starts a mock server and a full test Codex session, then sends an initial prompt and checks that basic turn metadata is present. It then creates a real temporary Git repository, commits a file, adds an `origin` remote, and records the expected commit hash and remote URL. Next it sends another prompt that causes two model requests in the same turn, captures both requests, parses their `x-codex-turn-metadata` headers as JSON, and verifies shared turn fields, sandbox status, and workspace facts such as commit hash, remote URL, and whether there are uncommitted changes.

**Call relations**: Unlike the smaller client-level tests, this one drives a fuller Codex test harness. It uses mock response sequences to make one turn produce multiple requests, then checks that the orchestration around a real turn keeps metadata consistent across those requests and enriches it with Git information.

*Call graph*: calls 5 internal fn (mount_response_sequence, mount_sse_once, sse, start_mock_server, test_codex); 8 external calls (from_utf8, assert!, assert_eq!, assert_ne!, skip_if_no_network!, from_str, write, vec!).


### `core/tests/suite/request_compression.rs`

`test` · `test execution`

This is a test file, active only on non-Windows systems. It checks the exact HTTP request that Codex sends to a fake server. Think of the fake server like a mailroom camera: it lets the test inspect the package Codex mailed, including its label and contents.

Both tests start a mock server that replies with a short stream of server-sent events. Server-sent events are a simple way for a server to send progress messages over one open HTTP response. The tests then build a test Codex instance, point it at the mock server, submit a small user message, and wait until Codex reports that the turn is complete. Waiting matters because it proves the outgoing request has actually reached the mock server.

The first test enables the request-compression feature and uses dummy ChatGPT/Codex-backend authentication. It expects the outgoing request to include the `content-encoding: zstd` header, then decompresses the body and checks that it is valid Responses API JSON.

The second test also enables the feature, but leaves Codex using API-key style authentication. It expects no compression header and checks that the raw body is already readable JSON. Together, these tests make sure compression is applied only in the intended authentication path.

#### Function details

##### `request_body_is_zstd_compressed_for_codex_backend_when_enabled`  (lines 19–68)

```
async fn request_body_is_zstd_compressed_for_codex_backend_when_enabled() -> anyhow::Result<()>
```

**Purpose**: This test proves that when request compression is enabled and Codex is using ChatGPT-style backend authentication, the request body is sent with zstd compression. It also proves the compressed bytes still contain the expected Responses API JSON once decompressed.

**Data flow**: The test starts by skipping itself if network-style tests are unavailable. It creates a mock server, installs one fake streaming response, and records the request Codex sends. It builds a test Codex instance with dummy ChatGPT authentication, turns on the request-compression feature, and points Codex at the mock backend URL. After submitting the text `compress me`, it waits for the turn to finish, reads the single captured request, checks that the `content-encoding` header says `zstd`, decompresses the body, parses it as JSON, and confirms the JSON has an `input` field. The result is success if all checks pass, or a test failure/error if any step is wrong.

**Call relations**: The Tokio test runner calls this function as an asynchronous test. Inside, it relies on the test support helpers to start the mock server, mount a one-time streaming response, build a test Codex instance, and wait for the completion event. After Codex submits the user input and the mock server captures the outgoing request, this function performs the final inspection itself: it verifies the compression header, decodes the body with zstd, and checks the decoded JSON.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, create_dummy_chatgpt_auth_for_testing, new); 9 external calls (default, assert!, assert_eq!, wait_for_event, format!, from_slice, skip_if_no_network!, vec!, decode_all).


##### `request_body_is_not_compressed_for_api_key_auth_even_when_enabled`  (lines 71–119)

```
async fn request_body_is_not_compressed_for_api_key_auth_even_when_enabled() -> anyhow::Result<()>
```

**Purpose**: This test proves that simply enabling the compression feature is not enough to compress every request. When Codex is using API-key authentication, the request body should stay uncompressed.

**Data flow**: The test first skips itself if the environment cannot run the needed network-style test. It starts a mock server, attaches one fake streaming response, and keeps a log of the request. It builds a test Codex instance without ChatGPT-style auth, enables request compression in the config, and points Codex at the mock backend URL. After submitting the text `do not compress`, it waits until Codex reports the turn is complete. It then reads the captured request, checks that there is no `content-encoding` header, parses the raw request body directly as JSON, and confirms the JSON has an `input` field. The result is success only if the request remained plain JSON.

**Call relations**: The Tokio test runner calls this function as an asynchronous test. Like the compression test, it uses the shared test helpers to create the mock server, prepare the fake server-sent event response, build Codex, and wait for the turn-complete event. The important difference is that it does not add dummy ChatGPT backend authentication, so after Codex sends the request, this function verifies that the lower-level request-sending code chose not to hand the body through zstd compression.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 7 external calls (default, assert!, wait_for_event, format!, from_slice, skip_if_no_network!, vec!).


### `core/tests/suite/models_etag_responses.rs`

`test` · `automated test run`

This test protects a small but important piece of network behavior. Codex keeps a catalog of available models, fetched from the server’s `/v1/models` endpoint. The server labels that catalog with an ETag, which is like a version sticker on a document. Later, when Codex calls `/responses`, the server can send an `X-Models-Etag` header. If that header has a different sticker than the one Codex stored, Codex should know the model catalog changed and fetch `/v1/models` again.

The test starts a fake HTTP server, so it can control every response Codex sees. First it makes Codex start up and fetch the model list with one ETag. Then it sends a user request that produces a tool call, while the fake `/responses` reply includes a different model ETag. That mismatch should trigger exactly one refresh of `/v1/models`.

Next, the test simulates the follow-up response after the tool output. This response carries the same new ETag. Since Codex has already refreshed to that version, it should not fetch the model list again. The final checks make sure the refresh happened once, used the expected `/v1/models` path, included the normal client version query parameter, and did not repeat unnecessarily.

#### Function details

##### `refresh_models_on_models_etag_mismatch_and_avoid_duplicate_models_fetch`  (lines 32–165)

```
async fn refresh_models_on_models_etag_mismatch_and_avoid_duplicate_models_fetch() -> Result<()>
```

**Purpose**: This test verifies that Codex refreshes its model catalog when a `/responses` reply reports a newer model ETag, and that it avoids a duplicate refresh when later replies report that same ETag. It is used to catch regressions in the logic that keeps the local model list in sync with the server.

**Data flow**: The test starts with a fake server, dummy authentication, and a Codex test instance configured to avoid retries so the result is predictable. It feeds Codex an initial `/v1/models` response with one ETag, then a streamed `/responses` reply with a different ETag and a shell tool call, then another streamed `/responses` reply with the same new ETag and a final assistant message. After Codex finishes the turn, the test inspects the fake server’s recorded requests: the model list must have been fetched once at startup, refreshed once after the mismatch, and not fetched a third time.

**Call relations**: During the test setup, it calls helpers that create the fake Codex instance, dummy login, local working-directory selection, permission settings, model-list responses, and streamed response bodies. Once the user input is submitted to Codex, the normal Codex turn machinery runs against the fake server. The test then waits for the turn-complete event and uses the mock server’s recorded requests to confirm the expected network behavior.

*Call graph*: calls 8 internal fn (mount_models_once_with_etag, mount_response_once, sse, sse_response, local_selections, test_codex, turn_permission_fields, create_dummy_chatgpt_auth_for_testing); 10 external calls (clone, default, from_secs, start, new, assert!, assert_eq!, wait_for_event_with_timeout, skip_if_no_network!, vec!).


### WebSocket and realtime transports
These suites exercise websocket and realtime session behavior, from request framing and prewarm flows to conversation-level transport handling.

### `core/tests/suite/agent_websocket.rs`

`test` · `test run`

These tests act like a mock model service and watch what Codex sends to it. A WebSocket is like keeping a phone call open instead of making a new call for every message. That matters here because Codex may send an early “prewarm” request when it starts, then later send the user’s real prompt, tool results, and follow-up turns over the same connection.

The file uses test helpers to start a fake WebSocket server. The fake server is given scripted events to send back, such as “a response was created,” “run this shell command,” “assistant says done,” and “response completed.” Codex is then started in test mode and pointed at that server. Each test submits one or more user turns and then inspects the JSON requests Codex sent.

The tests cover two protocol styles. The older path sends turns without the newer v2 rules. The v2 path, enabled by a feature flag, adds a beta header, uses startup prewarming, and has different expectations around previous response IDs and service tiers. The service tier is the requested speed/priority level, such as a fast “priority” request.

Without these tests, small changes in WebSocket startup, request metadata, shell-command chaining, or service-tier overrides could silently break real conversations with the model service.

#### Function details

##### `websocket_test_codex_shell_chain`  (lines 20–67)

```
async fn websocket_test_codex_shell_chain() -> Result<()>
```

**Purpose**: This test checks the basic WebSocket flow where the model asks Codex to run a shell command, then Codex sends the command result back in a second request. It proves that one user turn can become a small chain of WebSocket requests when tools are involved.

**Data flow**: The test starts with a fake server scripted to first request an `echo websocket` shell command and then reply with a final assistant message. It builds a test Codex instance using a Windows-style command shell, submits the prompt “run the echo command,” and then reads the JSON requests captured by the server. The expected result is two `response.create` requests, with the second one carrying input items that continue the conversation after the shell command.

**Call relations**: At the start, the test asks the support code to start a WebSocket server and to build a Codex test instance. During the turn, Codex connects to that server, receives the scripted shell-command event, runs through its tool-call path, and sends another request back. The test then uses assertions to confirm that the server saw the expected two-step exchange before shutting the server down.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_first_turn_uses_startup_prewarm_and_create`  (lines 70–124)

```
async fn websocket_first_turn_uses_startup_prewarm_and_create() -> Result<()>
```

**Purpose**: This test checks that Codex sends a startup prewarm request before the first real user turn. A prewarm request is a “get ready” message that does not ask the model to generate text yet.

**Data flow**: The fake server is prepared to answer two requests: a warmup request and then a real turn. Codex is started and the user submits “hello.” The test reads both captured JSON requests. The first must be a `response.create` request with `generate` set to false and metadata marking it as `prewarm`; the second must be a normal `response.create` turn with tools included and metadata marking it as a real `turn`.

**Call relations**: The test relies on the fake server to record exactly what Codex sends during startup and first-turn handling. It also parses the metadata JSON embedded inside the request so it can check that Codex labels the warmup and real turn correctly. This guards the handoff between startup preparation and actual user work.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 5 external calls (assert!, assert_eq!, from_str, skip_if_no_network!, vec!).


##### `websocket_first_turn_handles_handshake_delay_with_startup_prewarm`  (lines 127–171)

```
async fn websocket_first_turn_handles_handshake_delay_with_startup_prewarm() -> Result<()>
```

**Purpose**: This test checks that Codex still behaves correctly if opening the WebSocket connection is slow. It makes sure a delayed network handshake does not stop the startup prewarm and first real turn from being sent in order.

**Data flow**: The fake server is configured to wait briefly before accepting the WebSocket connection. Codex is then started and asked to handle a “hello” turn. After Codex finishes, the test examines the captured requests. The output should still be two requests: a non-generating warmup request first, followed by a normal request with tools populated.

**Call relations**: The test uses the header-capable fake server setup because that helper can also simulate connection delay. Codex must tolerate that delay while its startup and turn-processing paths overlap. The assertions verify that the slow handshake did not cause Codex to skip prewarming, lose tools, or send the wrong request type.

*Call graph*: calls 2 internal fn (start_websocket_server_with_headers, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_v2_test_codex_shell_chain`  (lines 174–256)

```
async fn websocket_v2_test_codex_shell_chain() -> Result<()>
```

**Purpose**: This test checks the newer WebSocket v2 path for a shell-command conversation. It confirms that v2 uses a startup warmup, sends the required beta header, links requests with previous response IDs, and returns shell command output in the follow-up request.

**Data flow**: The test enables the WebSocket v2 feature flag, starts a fake server with three scripted stages, and submits a prompt that should cause a shell command. The server first receives a warmup request, then a request for the user’s turn, then a follow-up request after the command runs. The test checks that the warmup does not generate text, that later requests are `response.create`, that response IDs are linked as expected, that the command output includes the original call ID, and that the handshake includes the v2 beta header.

**Call relations**: This test sits on the feature-flagged v2 route. The test builder turns that route on before Codex connects to the fake server. The scripted server drives Codex through warmup, tool call, and tool-result submission, while the final assertions confirm both the message bodies and the WebSocket handshake header expected by the v2 protocol.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_v2_first_turn_uses_updated_fast_tier_after_startup_prewarm`  (lines 259–311)

```
async fn websocket_v2_first_turn_uses_updated_fast_tier_after_startup_prewarm() -> Result<()>
```

**Purpose**: This test checks that the first real WebSocket v2 turn can choose a fast service tier even after a startup warmup was already sent without one. It protects the rule that per-turn settings can override what happened during prewarm.

**Data flow**: Codex starts with WebSocket v2 enabled. The fake server waits for the warmup request, and the test confirms that this warmup has no `service_tier`. Then the test submits “hello” with the fast tier requested. The captured first real turn should include `service_tier` set to `priority`, should not be tied to the warmup through `previous_response_id`, and should include input items.

**Call relations**: The fake server lets the test inspect the warmup before the real prompt is submitted. Codex then receives a turn-specific service-tier choice through the test helper. The assertions show that Codex applies that updated choice to the actual user request rather than blindly reusing the startup warmup settings.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_v2_first_turn_drops_fast_tier_after_startup_prewarm`  (lines 314–367)

```
async fn websocket_v2_first_turn_drops_fast_tier_after_startup_prewarm() -> Result<()>
```

**Purpose**: This test checks the opposite service-tier case: if startup prewarm used the fast tier from configuration, the first real turn can still drop it. It makes sure a warmup preference does not accidentally stick to later user work.

**Data flow**: The test starts Codex with WebSocket v2 enabled and a configured fast service tier. The warmup request is captured first and should contain `service_tier` as `priority`. Then the user submits “hello” with no service tier for that turn. The first real turn should omit `service_tier`, should not include `previous_response_id`, and should still contain input items.

**Call relations**: The test builder sets the initial configuration that affects startup. After that, the submitted turn deliberately passes no tier. The fake server records both requests, and the assertions confirm that Codex separates startup configuration from the later per-turn choice.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `websocket_v2_next_turn_uses_updated_service_tier`  (lines 370–444)

```
async fn websocket_v2_next_turn_uses_updated_service_tier() -> Result<()>
```

**Purpose**: This test checks that service-tier choices can change from one WebSocket v2 turn to the next. It proves Codex does not keep using a fast tier after a later turn stops asking for it.

**Data flow**: The fake server is scripted for a warmup and two real turns. Codex starts with WebSocket v2 enabled, and the warmup is checked to have no service tier. The first submitted turn asks for the fast tier, so its request should contain `service_tier` as `priority`. The second submitted turn asks for no tier, so its request should omit `service_tier`. Both real turns should contain input items and should not carry `previous_response_id`.

**Call relations**: The test drives Codex through a longer sequence: startup warmup, first user turn, then second user turn. Each submitted turn passes its own service-tier setting through the test helper. The captured requests let the test confirm that Codex reads the current turn’s setting each time instead of reusing the previous turn’s value.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


### `core/tests/suite/client_websockets.rs`

`test` · `test run`

This is a test file, not production code. It builds a fake WebSocket server and then drives the real Codex model client against it. A WebSocket is like keeping a phone line open instead of making a new phone call for every message; these tests make sure Codex opens that line correctly, reuses it when it should, and sends the right information on each request.

The tests cover the ordinary streaming path, preconnects, prewarm requests, connection reuse across turns and dropped sessions, and the newer “v2” incremental request behavior. Incremental means that if a later prompt starts with the same conversation as an earlier one, the client can send only the new part plus a previous response id, instead of resending everything.

The file also checks observability details: trace context, runtime metrics, timing headers, reasoning-included signals, model etags, and rate-limit events. Several tests simulate server-side errors to confirm that user-facing events are emitted and that recoverable WebSocket connection-limit errors cause a reconnect.

Helper functions at the bottom create prompts, fake model provider settings, test harnesses, metadata, and small streaming loops. Without this suite, changes to WebSocket streaming could silently break request shape, connection reuse, telemetry, or error handling.

#### Function details

##### `assert_request_trace_matches`  (lines 75–99)

```
fn assert_request_trace_matches(body: &serde_json::Value, expected_trace: &W3cTraceContext)
```

**Purpose**: Checks that a WebSocket request carries the expected tracing information in its client metadata. Tracing information is the breadcrumb trail used to connect logs and timing data from one logical request.

**Data flow**: It receives a JSON request body and an expected W3C trace context. It reads the request's client metadata, compares the traceparent and tracestate values to the expected ones, and also confirms that trace data was not placed in the old top-level location. It returns nothing, but the test fails if anything is wrong.

**Call relations**: The trace-focused tests call this after sending WebSocket requests. It uses plain assertions to turn a mismatch into a clear test failure.

*Call graph*: called by 2 (responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_reuses_connection_with_per_turn_trace_payloads); 2 external calls (assert!, assert_eq!).


##### `responses_metadata`  (lines 112–127)

```
fn responses_metadata(
    harness: &WebsocketTestHarness,
    turn_id: Option<&str>,
    request_kind: TestCodexResponsesRequestKind,
) -> CodexResponsesMetadata
```

**Purpose**: Builds the standard Codex metadata block used on fake Responses API requests in these tests. This metadata identifies the installation, session, thread, window, request kind, and optional turn id.

**Data flow**: It takes the shared test harness, an optional turn id, and a request kind. It combines those with fixed test constants and returns a CodexResponsesMetadata value ready to attach to a request.

**Call relations**: The more specific metadata helpers call this so all tests use the same metadata format. It delegates the actual construction to the test support metadata builder.

*Call graph*: called by 3 (prewarm_metadata, turn_metadata, websocket_connection_metadata); 1 external calls (responses_metadata).


##### `turn_metadata`  (lines 129–131)

```
fn turn_metadata(harness: &WebsocketTestHarness, turn_id: Option<&str>) -> CodexResponsesMetadata
```

**Purpose**: Creates metadata for an ordinary user turn. Tests use it when they want the request to look like a normal model interaction.

**Data flow**: It receives the test harness and optional turn id, then asks the shared metadata helper to label the request as a turn. It returns that metadata object.

**Call relations**: Many request-shape, error, and event tests call this before streaming. It is a small wrapper around responses_metadata so the caller does not repeat the request-kind choice.

*Call graph*: calls 1 internal fn (responses_metadata); called by 12 (responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event, responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create, responses_websocket_preconnect_is_reused_even_with_header_changes, responses_websocket_request_prewarm_is_reused_even_with_header_changes, responses_websocket_request_prewarm_traces_logical_request, responses_websocket_request_prewarm_uses_caller_supplied_metadata, responses_websocket_sends_canonical_turn_metadata, responses_websocket_v2_after_error_uses_full_create_without_previous_response_id, responses_websocket_v2_surfaces_terminal_error_without_close_handshake (+2 more)).


##### `prewarm_metadata`  (lines 133–138)

```
fn prewarm_metadata(
    harness: &WebsocketTestHarness,
    turn_id: Option<&str>,
) -> CodexResponsesMetadata
```

**Purpose**: Creates metadata for a prewarm request. A prewarm request prepares the model path before the real response is needed.

**Data flow**: It receives the test harness and optional turn id, marks the request kind as prewarm, and returns the metadata.

**Call relations**: Prewarm-specific tests call this before invoking prewarm_websocket. It reuses responses_metadata to keep the common metadata fields consistent.

*Call graph*: calls 1 internal fn (responses_metadata); called by 4 (responses_websocket_prewarm_uses_v2_when_provider_supports_websockets, responses_websocket_request_prewarm_is_reused_even_with_header_changes, responses_websocket_request_prewarm_reuses_connection, responses_websocket_request_prewarm_traces_logical_request).


##### `websocket_connection_metadata`  (lines 140–146)

```
fn websocket_connection_metadata(harness: &WebsocketTestHarness) -> CodexResponsesMetadata
```

**Purpose**: Creates metadata for opening or preconnecting a WebSocket connection before any specific turn. This lets tests distinguish connection setup from an actual model request.

**Data flow**: It receives the test harness, uses no turn id, marks the request kind as WebSocket connection, and returns the metadata.

**Call relations**: Preconnect tests call this before asking the client session to open the WebSocket early. It is another focused wrapper around responses_metadata.

*Call graph*: calls 1 internal fn (responses_metadata); called by 4 (responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_preconnect_is_reused_even_with_header_changes, responses_websocket_preconnect_reuses_connection, responses_websocket_preconnect_runs_when_only_v2_feature_enabled).


##### `responses_websocket_streams_request`  (lines 149–206)

```
async fn responses_websocket_streams_request()
```

**Purpose**: Verifies the basic happy path: the client streams a request over WebSocket and sends the expected request body and handshake headers.

**Data flow**: The test starts a fake server, creates a harness and prompt, streams until completion, then inspects the single recorded request and handshake. It expects the model, stream flag, input, beta header, request id, session/thread ids, user agent, installation id, and start timestamp to be present.

**Call relations**: The async test runner invokes it. It uses the WebSocket server helper, harness builder, prompt builder, and stream helper, then shuts the fake server down.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_streams_without_feature_flag_when_provider_supports_websockets`  (lines 209–228)

```
async fn responses_websocket_streams_without_feature_flag_when_provider_supports_websockets()
```

**Purpose**: Confirms that WebSocket streaming works when the provider itself says it supports WebSockets, even without a separate runtime feature flag.

**Data flow**: It starts a fake server, builds a harness with runtime metrics disabled, sends a prompt, and then checks that exactly one handshake and one request were made.

**Call relations**: The test runner calls it as an independent scenario. It relies on the harness-with-options helper to build a provider that supports WebSockets.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_options); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_reuses_connection_with_per_turn_trace_payloads`  (lines 231–300)

```
async fn responses_websocket_reuses_connection_with_per_turn_trace_payloads()
```

**Purpose**: Checks that two separate turns reuse the same WebSocket connection while still sending different trace metadata for each turn.

**Data flow**: It starts tracing, sends two prompts under two different tracing spans, and records the expected trace context for each. It then inspects both request bodies and confirms each request has its own trace values, while only one WebSocket handshake happened.

**Call relations**: The test runner invokes it. It uses the trace assertion helper after streaming both turns through the same fake server connection.

*Call graph*: calls 6 internal fn (start_websocket_server, install_test_tracing, assert_request_trace_matches, prompt_with_input, stream_until_complete, websocket_harness); 6 external calls (assert_eq!, assert_ne!, current_span_w3c_trace_context, skip_if_no_network!, info_span!, vec!).


##### `responses_websocket_preconnect_does_not_replace_turn_trace_payload`  (lines 303–339)

```
async fn responses_websocket_preconnect_does_not_replace_turn_trace_payload()
```

**Purpose**: Ensures that opening a WebSocket early does not accidentally freeze or overwrite the trace information for the later real turn.

**Data flow**: It preconnects first, then streams a prompt inside a tracing span. It inspects the request body and confirms the trace metadata matches the turn span, not the earlier preconnect operation.

**Call relations**: The test runner invokes it. It combines preconnect metadata, tracing setup, the stream helper, and assert_request_trace_matches.

*Call graph*: calls 7 internal fn (start_websocket_server, install_test_tracing, assert_request_trace_matches, prompt_with_input, stream_until_complete, websocket_connection_metadata, websocket_harness); 5 external calls (assert_eq!, current_span_w3c_trace_context, skip_if_no_network!, info_span!, vec!).


##### `responses_websocket_preconnect_reuses_connection`  (lines 342–374)

```
async fn responses_websocket_preconnect_reuses_connection()
```

**Purpose**: Verifies that a preconnected WebSocket is reused for the later model request instead of opening a second connection.

**Data flow**: It opens the connection early, sends a prompt, and then checks that there was one handshake and one request. It also checks useful handshake metadata such as user agent and window id.

**Call relations**: The test runner calls it. It uses websocket_connection_metadata for setup and stream_until_complete for the later turn.

*Call graph*: calls 5 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_connection_metadata, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_request_prewarm_reuses_connection`  (lines 377–438)

```
async fn responses_websocket_request_prewarm_reuses_connection()
```

**Purpose**: Checks that a prewarm request and the later real request share the same WebSocket connection. It also verifies that the real request can refer back to the prewarm response.

**Data flow**: It sends a prewarm request, then streams the same prompt. It inspects the first request to ensure generation was disabled and tools were empty, and inspects the second request to ensure it uses previous_response_id and sends no duplicate input.

**Call relations**: The test runner invokes it. It uses prewarm_metadata for the warmup request and stream_until_complete for the follow-up.

*Call graph*: calls 5 internal fn (start_websocket_server, prewarm_metadata, prompt_with_input, stream_until_complete, websocket_harness_with_options); 4 external calls (assert_eq!, from_str, skip_if_no_network!, vec!).


##### `responses_websocket_request_prewarm_uses_caller_supplied_metadata`  (lines 441–481)

```
async fn responses_websocket_request_prewarm_uses_caller_supplied_metadata()
```

**Purpose**: Confirms that prewarm uses the metadata supplied by its caller, instead of always forcing the request kind to prewarm.

**Data flow**: It calls prewarm_websocket with metadata marked as a normal turn. It then reads the recorded request metadata and expects the request_kind field to remain turn.

**Call relations**: The test runner calls it. It uses turn_metadata deliberately in a prewarm call to catch unwanted metadata rewriting.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, turn_metadata, websocket_harness_with_options); 4 external calls (assert_eq!, from_str, skip_if_no_network!, vec!).


##### `responses_websocket_request_prewarm_traces_logical_request`  (lines 484–589)

```
async fn responses_websocket_request_prewarm_traces_logical_request()
```

**Purpose**: Ensures that a prewarmed request is still recorded in rollout tracing as the logical user input, even though the follow-up request sends only a previous response id.

**Data flow**: It prewarms a prompt, creates a trace writer, starts a fake conversation turn in the trace, streams the follow-up, and replays the trace bundle. It expects the trace to contain the original user text as the inference request item.

**Call relations**: The test runner invokes it. It ties together the prewarm path, normal turn metadata, the client stream, and rollout trace replay.

*Call graph*: calls 7 internal fn (start_websocket_server, prewarm_metadata, prompt_with_input, turn_metadata, websocket_harness_with_options, enabled, create); 7 external calls (new, new, assert_eq!, replay_bundle, matches!, skip_if_no_network!, vec!).


##### `responses_websocket_reuses_connection_after_session_drop`  (lines 592–617)

```
async fn responses_websocket_reuses_connection_after_session_drop()
```

**Purpose**: Checks that dropping one ModelClientSession does not make the underlying client throw away a reusable WebSocket connection.

**Data flow**: It sends one prompt using a short-lived session, lets that session go out of scope, creates a new session, and sends another prompt. It expects one handshake and two requests on the same connection.

**Call relations**: The test runner calls it. It uses the shared ModelClient from the harness to show reuse survives individual session objects.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_sends_responses_lite_metadata_per_request`  (lines 620–696)

```
async fn responses_websocket_sends_responses_lite_metadata_per_request()
```

**Purpose**: Verifies that the “responses lite” marker is sent only for requests using a model configuration that asks for it. This guards against sticky per-connection state leaking between turns.

**Data flow**: It sends three requests over one connection: normal, lite, normal. It inspects each body and expects the lite metadata and reasoning context only on the middle request.

**Call relations**: The test runner invokes it. It uses stream_until_complete_with_model_info so each request can use a different ModelInfo value.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete_with_model_info, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_preconnect_is_reused_even_with_header_changes`  (lines 699–741)

```
async fn responses_websocket_preconnect_is_reused_even_with_header_changes()
```

**Purpose**: Confirms that a preconnected WebSocket is reused even if later request-specific metadata would have changed headers in older designs.

**Data flow**: It preconnects, then streams a normal turn with turn metadata. It consumes the stream to completion and checks that only one handshake and one request occurred.

**Call relations**: The test runner calls it. It uses websocket_connection_metadata for the preconnect and turn_metadata for the stream, proving the connection stays usable across metadata differences.

*Call graph*: calls 6 internal fn (start_websocket_server, prompt_with_input, turn_metadata, websocket_connection_metadata, websocket_harness, disabled); 4 external calls (assert_eq!, matches!, skip_if_no_network!, vec!).


##### `responses_websocket_request_prewarm_is_reused_even_with_header_changes`  (lines 744–809)

```
async fn responses_websocket_request_prewarm_is_reused_even_with_header_changes()
```

**Purpose**: Checks that a prewarm request remains reusable for the later request even when the later call has different request metadata.

**Data flow**: It prewarms with prewarm metadata, then streams with turn metadata. It inspects the two recorded requests and expects the second to reference the prewarm response and send empty input.

**Call relations**: The test runner invokes it. It exercises the same prewarm-to-follow-up path as other tests but focuses on metadata/header changes.

*Call graph*: calls 6 internal fn (start_websocket_server, prewarm_metadata, prompt_with_input, turn_metadata, websocket_harness_with_options, disabled); 4 external calls (assert_eq!, matches!, skip_if_no_network!, vec!).


##### `responses_websocket_prewarm_uses_v2_when_provider_supports_websockets`  (lines 812–867)

```
async fn responses_websocket_prewarm_uses_v2_when_provider_supports_websockets()
```

**Purpose**: Verifies that prewarm uses the v2 WebSocket request style when the provider supports WebSockets.

**Data flow**: It sends a prewarm request, checks that it used a WebSocket request and included the v2 beta header, then streams the prompt and confirms no extra request was needed.

**Call relations**: The test runner calls it. It uses the prewarm helper path and then stream_until_complete to prove the warm request is the one reused.

*Call graph*: calls 5 internal fn (start_websocket_server, prewarm_metadata, prompt_with_input, stream_until_complete, websocket_harness_with_options); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_preconnect_runs_when_only_v2_feature_enabled`  (lines 870–911)

```
async fn responses_websocket_preconnect_runs_when_only_v2_feature_enabled()
```

**Purpose**: Checks that preconnect still opens the WebSocket when only the v2 WebSocket path is available.

**Data flow**: It preconnects and expects one handshake but no request body yet. Then it streams a prompt and expects the existing connection to carry one request with the v2 beta header.

**Call relations**: The test runner invokes it. It uses websocket_connection_metadata for the setup and the normal stream helper for the later request.

*Call graph*: calls 5 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_connection_metadata, websocket_harness_with_options); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_requests_use_v2_when_provider_supports_websockets`  (lines 914–960)

```
async fn responses_websocket_v2_requests_use_v2_when_provider_supports_websockets()
```

**Purpose**: Confirms that v2 WebSocket requests use incremental creation when a second prompt extends the first conversation.

**Data flow**: It sends a first prompt that receives a response id and assistant message, then sends a second prompt containing the earlier conversation plus one new user message. The second request should include previous_response_id and only the new input item.

**Call relations**: The test runner calls it. It uses the fake server’s scripted two-response sequence and then inspects the second recorded request.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_options); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_incremental_requests_are_reused_across_turns`  (lines 963–1004)

```
async fn responses_websocket_v2_incremental_requests_are_reused_across_turns()
```

**Purpose**: Checks that v2 incremental request state survives across separate ModelClientSession objects.

**Data flow**: It sends the first prompt in one session, drops that session, sends the extended prompt in a new session, and inspects the second request. It expects the client to still know the previous response id and send only the new input.

**Call relations**: The test runner invokes it. It uses the shared harness client to show reuse is tied to the client/connection, not only one session object.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_options); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_wins_when_both_features_enabled`  (lines 1007–1053)

```
async fn responses_websocket_v2_wins_when_both_features_enabled()
```

**Purpose**: Ensures the v2 WebSocket behavior is chosen when multiple WebSocket-related options could apply.

**Data flow**: It sends two related prompts and checks that the second request uses previous_response_id and only new input, which is the v2 incremental shape. It also checks the handshake beta header.

**Call relations**: The test runner calls it. It uses the same stream helper and request inspection pattern as the other v2 selection tests.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_options); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_emits_websocket_telemetry_events`  (lines 1057–1085)

```
async fn responses_websocket_emits_websocket_telemetry_events()
```

**Purpose**: Verifies that WebSocket calls and WebSocket events are counted in runtime telemetry, instead of being counted as ordinary HTTP streaming calls.

**Data flow**: It resets telemetry, streams one prompt, waits briefly for metrics to settle, and reads the runtime metrics summary. It expects one WebSocket call and two WebSocket events, with normal API and streaming counts left at zero.

**Call relations**: The test runner invokes it. It uses the harness telemetry object created by websocket_harness and the stream helper.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 5 external calls (from_millis, assert_eq!, skip_if_no_network!, sleep, vec!).


##### `responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled`  (lines 1088–1135)

```
async fn responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled()
```

**Purpose**: Checks that the client asks the server for timing metrics when runtime metrics are enabled, and records the timing event it receives.

**Data flow**: The fake server sends a websocket_timing event between response creation and completion. The test checks that the handshake includes the timing request header and that the telemetry summary contains the timing numbers.

**Call relations**: The test runner calls it. It builds a harness with runtime metrics enabled and uses stream_until_complete to trigger the event.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_runtime_metrics); 5 external calls (from_millis, assert_eq!, skip_if_no_network!, sleep, vec!).


##### `responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled`  (lines 1138–1161)

```
async fn responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled()
```

**Purpose**: Confirms that the timing metrics request header is not sent when runtime metrics are disabled.

**Data flow**: It streams one prompt through a harness with runtime metrics disabled, then reads the handshake headers. It expects no timing metrics header.

**Call relations**: The test runner invokes it. It uses the runtime-metrics harness wrapper with a false flag.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_runtime_metrics); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_emits_reasoning_included_event`  (lines 1164–1207)

```
async fn responses_websocket_emits_reasoning_included_event()
```

**Purpose**: Verifies that a server response header saying reasoning was included becomes a ResponseEvent visible to the client.

**Data flow**: It starts a fake server that adds the X-Reasoning-Included header, streams a prompt, and watches the event stream. It succeeds only if it sees ServerReasoningIncluded(true) before completion.

**Call relations**: The test runner calls it. It uses the server-with-headers helper and then reads events directly instead of only using stream_until_complete.

*Call graph*: calls 5 internal fn (start_websocket_server_with_headers, prompt_with_input, turn_metadata, websocket_harness, disabled); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `responses_websocket_emits_rate_limit_events`  (lines 1210–1303)

```
async fn responses_websocket_emits_rate_limit_events()
```

**Purpose**: Checks that rate-limit information sent over the WebSocket is turned into structured client events, along with related response headers.

**Data flow**: The fake server sends a codex.rate_limits event and headers for model etag and reasoning included. The test streams a prompt, captures the emitted events, and checks the parsed plan, usage percentage, reset time, credits, etag, and reasoning flag.

**Call relations**: The test runner invokes it. It builds custom server responses and consumes the stream manually to inspect non-completion events.

*Call graph*: calls 5 internal fn (start_websocket_server_with_headers, prompt_with_input, turn_metadata, websocket_harness, disabled); 5 external calls (assert!, assert_eq!, json!, skip_if_no_network!, vec!).


##### `responses_websocket_usage_limit_error_emits_rate_limit_event`  (lines 1306–1403)

```
async fn responses_websocket_usage_limit_error_emits_rate_limit_event()
```

**Purpose**: Ensures a WebSocket usage-limit error still produces a rate-limit token-count event before the user-facing error.

**Data flow**: It scripts a prewarm success followed by a 429 usage-limit error. Through the higher-level Codex test harness, it submits user input, waits for a TokenCount event containing rate-limit percentages, then waits for an Error event mentioning the usage limit.

**Call relations**: The test runner calls it. Unlike lower-level tests, it uses test_codex and wait_for_event to check the full application event path.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 9 external calls (default, assert!, wait_for_event, json!, assert_eq!, to_value, skip_if_no_network!, unreachable!, vec!).


##### `responses_websocket_invalid_request_error_with_status_is_forwarded`  (lines 1406–1464)

```
async fn responses_websocket_invalid_request_error_with_status_is_forwarded()
```

**Purpose**: Checks that an invalid request error received over WebSocket is forwarded to the normal Codex error event stream.

**Data flow**: It scripts a prewarm success followed by a 400 invalid_request_error. It submits user input through the high-level Codex harness and waits for an Error event whose message contains the server’s explanation.

**Call relations**: The test runner invokes it. It uses test_codex so the check covers the client-to-application event boundary.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 7 external calls (default, assert!, wait_for_event, json!, skip_if_no_network!, unreachable!, vec!).


##### `responses_websocket_connection_limit_error_reconnects_and_completes`  (lines 1467–1514)

```
async fn responses_websocket_connection_limit_error_reconnects_and_completes()
```

**Purpose**: Verifies that a specific WebSocket connection-limit error is treated as recoverable. The client should open a new WebSocket and retry.

**Data flow**: The first fake connection returns a connection-limit error; the second returns a successful response. The test submits a turn and then checks that two WebSocket requests happened across two handshakes, both with the expected user agent.

**Call relations**: The test runner calls it. It uses the higher-level Codex harness with one stream retry allowed to prove reconnect behavior works end to end.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 4 external calls (assert_eq!, json!, skip_if_no_network!, vec!).


##### `responses_websocket_uses_incremental_create_on_prefix`  (lines 1517–1559)

```
async fn responses_websocket_uses_incremental_create_on_prefix()
```

**Purpose**: Checks that when a later prompt begins with the same items as the previous completed exchange, the client sends only the new suffix plus previous_response_id.

**Data flow**: It sends an initial prompt and then a second prompt containing the first prompt, the assistant reply, and one new message. It inspects the requests and expects the first to be a full create and the second to be an incremental create.

**Call relations**: The test runner invokes it. It relies on the fake server returning a response id and assistant message so the client can recognize the prefix.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create`  (lines 1562–1636)

```
async fn responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create()
```

**Purpose**: Ensures both full and incremental WebSocket create requests carry the correct per-turn metadata.

**Data flow**: It sends two related prompts with different turn ids in their metadata. It reads both request bodies, parses the embedded metadata JSON, and confirms each request has the matching turn id in both canonical and convenience metadata fields.

**Call relations**: The test runner calls it. It uses stream_until_complete_with_metadata so each request can carry caller-selected metadata.

*Call graph*: calls 5 internal fn (start_websocket_server, prompt_with_input, stream_until_complete_with_metadata, turn_metadata, websocket_harness); 4 external calls (assert_eq!, from_str, skip_if_no_network!, vec!).


##### `responses_websocket_sends_canonical_turn_metadata`  (lines 1639–1682)

```
async fn responses_websocket_sends_canonical_turn_metadata()
```

**Purpose**: Verifies that the request includes the canonical serialized turn metadata and mirrors the turn id in client metadata.

**Data flow**: It streams one prompt with a specific turn id, reads the recorded request, parses the x-codex-turn-metadata JSON string, and checks that the turn id appears as expected.

**Call relations**: The test runner invokes it. It uses the metadata-aware stream helper to send the exact metadata under test.

*Call graph*: calls 5 internal fn (start_websocket_server, prompt_with_input, stream_until_complete_with_metadata, turn_metadata, websocket_harness); 4 external calls (assert_eq!, from_str, skip_if_no_network!, vec!).


##### `responses_websocket_uses_previous_response_id_when_prefix_after_completed`  (lines 1685–1722)

```
async fn responses_websocket_uses_previous_response_id_when_prefix_after_completed()
```

**Purpose**: Checks that a completed first response can be used as the base for a later incremental request.

**Data flow**: It sends a first prompt through completion, then sends an extended prompt. The second request should include previous_response_id and only the new input after the known prefix.

**Call relations**: The test runner calls it. It is a focused version of the incremental-prefix test centered on the completed response id.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_creates_on_non_prefix`  (lines 1725–1755)

```
async fn responses_websocket_creates_on_non_prefix()
```

**Purpose**: Ensures the client sends a full create request when the next prompt is not an extension of the previous conversation.

**Data flow**: It sends one prompt, then sends a different prompt that does not share the previous prefix. The second request should include the full new input and normal create fields, not previous_response_id.

**Call relations**: The test runner invokes it. It uses the ordinary stream helper and then inspects the second recorded request.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_creates_when_non_input_request_fields_change`  (lines 1758–1791)

```
async fn responses_websocket_creates_when_non_input_request_fields_change()
```

**Purpose**: Checks that the client does not use incremental creation when important non-input request fields, such as base instructions, change.

**Data flow**: It sends a prompt with one set of base instructions, then another prompt with changed instructions and extra input. The second request should be a full create with no previous_response_id.

**Call relations**: The test runner calls it. It uses prompt_with_input_and_instructions to create prompts whose input prefix overlaps but whose request settings differ.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input_and_instructions, stream_until_complete, websocket_harness); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_creates_with_previous_response_id_on_prefix`  (lines 1794–1833)

```
async fn responses_websocket_v2_creates_with_previous_response_id_on_prefix()
```

**Purpose**: Confirms the v2 harness path uses previous_response_id for a prompt that extends an earlier completed response.

**Data flow**: It sends two related prompts through a v2-configured harness. It expects the first request to be a normal create and the second to include previous_response_id with only the new input.

**Call relations**: The test runner invokes it. It uses websocket_harness_with_v2 and the normal stream helper.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_v2); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_creates_without_previous_response_id_when_non_input_fields_change`  (lines 1836–1870)

```
async fn responses_websocket_v2_creates_without_previous_response_id_when_non_input_fields_change()
```

**Purpose**: Ensures the v2 WebSocket path falls back to a full create when request fields outside the input change.

**Data flow**: It sends two prompts with overlapping input but different base instructions. It inspects the second request and expects no previous_response_id and a full input payload.

**Call relations**: The test runner calls it. It pairs the v2 harness with prompt_with_input_and_instructions.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input_and_instructions, stream_until_complete, websocket_harness_with_v2); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_after_error_uses_full_create_without_previous_response_id`  (lines 1873–1962)

```
async fn responses_websocket_v2_after_error_uses_full_create_without_previous_response_id()
```

**Purpose**: Checks that after a v2 WebSocket request fails, the next successful request starts fresh instead of building on possibly broken state.

**Data flow**: It sends a successful first prompt, then a second prompt that receives a terminal failure, then a third prompt. The test expects the third request to happen on a new connection and to be a full create without previous_response_id.

**Call relations**: The test runner invokes it. It consumes the second stream manually to observe the error, then returns to stream_until_complete for the recovery request.

*Call graph*: calls 6 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, turn_metadata, websocket_harness_with_v2, disabled); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_websocket_v2_surfaces_terminal_error_without_close_handshake`  (lines 1965–2023)

```
async fn responses_websocket_v2_surfaces_terminal_error_without_close_handshake()
```

**Purpose**: Ensures a terminal response.failed event is surfaced promptly even if the server keeps the WebSocket open instead of closing it.

**Data flow**: It sends a first successful prompt, then a second prompt whose response is a failure event while the connection remains open. It waits with a timeout and expects the client stream to produce an error rather than hanging.

**Call relations**: The test runner calls it. It uses the server-with-headers configuration to keep the connection open and a timeout to catch hangs.

*Call graph*: calls 6 internal fn (start_websocket_server_with_headers, prompt_with_input, stream_until_complete, turn_metadata, websocket_harness_with_v2, disabled); 5 external calls (from_secs, assert!, skip_if_no_network!, timeout, vec!).


##### `responses_websocket_v2_sets_openai_beta_header`  (lines 2026–2052)

```
async fn responses_websocket_v2_sets_openai_beta_header()
```

**Purpose**: Verifies that the v2 WebSocket path advertises the required OpenAI beta header during the handshake.

**Data flow**: It streams one prompt through the v2 harness, reads the recorded handshake, splits the beta header values, and expects the v2 WebSocket marker to be present.

**Call relations**: The test runner invokes it. It uses websocket_harness_with_v2 and stream_until_complete, then checks only the handshake detail.

*Call graph*: calls 4 internal fn (start_websocket_server, prompt_with_input, stream_until_complete, websocket_harness_with_v2); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `message_item`  (lines 2054–2062)

```
fn message_item(text: &str) -> ResponseItem
```

**Purpose**: Creates a user message item for test prompts. It keeps tests readable by hiding the nested response-item structure.

**Data flow**: It takes plain text and wraps it as a ResponseItem with role user and an input-text content item. It returns that ResponseItem.

**Call relations**: Most prompt-building tests call this before prompt_with_input. It does not call other project helpers; it just constructs the test data shape.

*Call graph*: 1 external calls (vec!).


##### `assistant_message_item`  (lines 2064–2072)

```
fn assistant_message_item(id: &str, text: &str) -> ResponseItem
```

**Purpose**: Creates an assistant message item with an id for tests that simulate an existing conversation history.

**Data flow**: It takes an assistant message id and text, wraps them as a ResponseItem with role assistant and output-text content, and returns it.

**Call relations**: Incremental-request tests call this to place a prior assistant reply into the second prompt, letting the client recognize a shared conversation prefix.

*Call graph*: 1 external calls (vec!).


##### `prompt_with_input`  (lines 2074–2078)

```
fn prompt_with_input(input: Vec<ResponseItem>) -> Prompt
```

**Purpose**: Builds a Prompt containing the supplied input items and default settings for everything else.

**Data flow**: It starts from Prompt::default, replaces the input field with the provided ResponseItem list, and returns the prompt.

**Call relations**: Nearly all tests use this to make a simple prompt. prompt_with_input_and_instructions builds on it when a test needs custom base instructions.

*Call graph*: calls 1 internal fn (default); called by 32 (prompt_with_input_and_instructions, responses_websocket_creates_on_non_prefix, responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event, responses_websocket_emits_websocket_telemetry_events, responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create, responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled, responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled, responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_preconnect_is_reused_even_with_header_changes (+15 more)).


##### `prompt_with_input_and_instructions`  (lines 2080–2086)

```
fn prompt_with_input_and_instructions(input: Vec<ResponseItem>, instructions: &str) -> Prompt
```

**Purpose**: Builds a Prompt with both input items and custom base instructions. Tests use it to prove instruction changes prevent incremental reuse.

**Data flow**: It first creates a normal prompt from the input, then sets the base_instructions text, and returns the modified prompt.

**Call relations**: The non-input-field-change tests call this. It delegates the common prompt setup to prompt_with_input.

*Call graph*: calls 1 internal fn (prompt_with_input); called by 2 (responses_websocket_creates_when_non_input_request_fields_change, responses_websocket_v2_creates_without_previous_response_id_when_non_input_fields_change).


##### `websocket_provider`  (lines 2088–2090)

```
fn websocket_provider(server: &WebSocketTestServer) -> ModelProviderInfo
```

**Purpose**: Creates a fake model provider configuration pointing at the test WebSocket server.

**Data flow**: It receives the fake server and asks the more detailed provider helper to build a provider with no special connect timeout. It returns a ModelProviderInfo.

**Call relations**: websocket_harness_with_options calls this when building the standard test harness. It keeps the common provider path short.

*Call graph*: calls 1 internal fn (websocket_provider_with_connect_timeout); called by 1 (websocket_harness_with_options).


##### `websocket_provider_with_connect_timeout`  (lines 2092–2115)

```
fn websocket_provider_with_connect_timeout(
    server: &WebSocketTestServer,
    websocket_connect_timeout_ms: Option<u64>,
) -> ModelProviderInfo
```

**Purpose**: Builds a ModelProviderInfo configured to use the fake server as a Responses API provider with WebSocket support.

**Data flow**: It takes the fake server and an optional WebSocket connect timeout. It fills in provider fields such as base URL, wire API, retry counts, idle timeout, auth requirements, and supports_websockets, then returns the provider info.

**Call relations**: websocket_provider calls this for the default provider setup. Tests could use it directly when they need timeout-specific provider behavior.

*Call graph*: called by 1 (websocket_provider); 1 external calls (format!).


##### `websocket_harness`  (lines 2117–2119)

```
async fn websocket_harness(server: &WebSocketTestServer) -> WebsocketTestHarness
```

**Purpose**: Creates the standard WebSocket test harness with runtime metrics disabled.

**Data flow**: It receives a fake server and forwards to the runtime-metrics harness helper with false. It returns a WebsocketTestHarness.

**Call relations**: Most tests call this when they do not need runtime metrics. It is a convenience wrapper over websocket_harness_with_runtime_metrics.

*Call graph*: calls 1 internal fn (websocket_harness_with_runtime_metrics); called by 16 (responses_websocket_creates_on_non_prefix, responses_websocket_creates_when_non_input_request_fields_change, responses_websocket_emits_rate_limit_events, responses_websocket_emits_reasoning_included_event, responses_websocket_emits_websocket_telemetry_events, responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create, responses_websocket_preconnect_does_not_replace_turn_trace_payload, responses_websocket_preconnect_is_reused_even_with_header_changes, responses_websocket_preconnect_reuses_connection, responses_websocket_reuses_connection_after_session_drop (+6 more)).


##### `websocket_harness_with_runtime_metrics`  (lines 2121–2126)

```
async fn websocket_harness_with_runtime_metrics(
    server: &WebSocketTestServer,
    runtime_metrics_enabled: bool,
) -> WebsocketTestHarness
```

**Purpose**: Creates a WebSocket test harness while letting the caller choose whether runtime metrics are enabled.

**Data flow**: It takes a fake server and a boolean flag, then forwards both to the general options helper. It returns the finished harness.

**Call relations**: Metric-specific tests call this directly. The default websocket_harness also routes through it.

*Call graph*: calls 1 internal fn (websocket_harness_with_options); called by 3 (responses_websocket_includes_timing_metrics_header_when_runtime_metrics_enabled, responses_websocket_omits_timing_metrics_header_when_runtime_metrics_disabled, websocket_harness).


##### `websocket_harness_with_v2`  (lines 2128–2133)

```
async fn websocket_harness_with_v2(
    server: &WebSocketTestServer,
    runtime_metrics_enabled: bool,
) -> WebsocketTestHarness
```

**Purpose**: Creates a harness for tests that explicitly describe the v2 WebSocket path.

**Data flow**: It receives the fake server and runtime metrics flag, then forwards to the same general options helper used by the other harness builders. It returns the harness.

**Call relations**: V2-focused tests call this. In this file it is mainly a naming wrapper that makes test intent clear.

*Call graph*: calls 1 internal fn (websocket_harness_with_options); called by 5 (responses_websocket_v2_after_error_uses_full_create_without_previous_response_id, responses_websocket_v2_creates_with_previous_response_id_on_prefix, responses_websocket_v2_creates_without_previous_response_id_when_non_input_fields_change, responses_websocket_v2_sets_openai_beta_header, responses_websocket_v2_surfaces_terminal_error_without_close_handshake).


##### `websocket_harness_with_options`  (lines 2135–2141)

```
async fn websocket_harness_with_options(
    server: &WebSocketTestServer,
    runtime_metrics_enabled: bool,
) -> WebsocketTestHarness
```

**Purpose**: Creates a WebSocket test harness from the standard fake provider plus a runtime metrics choice.

**Data flow**: It builds a provider from the fake server, then passes that provider and the metrics flag to the lower-level harness builder. It returns the resulting WebsocketTestHarness.

**Call relations**: Many tests and wrapper helpers call this. It connects provider creation to the full harness setup.

*Call graph*: calls 2 internal fn (websocket_harness_with_provider_options, websocket_provider); called by 12 (responses_websocket_preconnect_runs_when_only_v2_feature_enabled, responses_websocket_prewarm_uses_v2_when_provider_supports_websockets, responses_websocket_request_prewarm_is_reused_even_with_header_changes, responses_websocket_request_prewarm_reuses_connection, responses_websocket_request_prewarm_traces_logical_request, responses_websocket_request_prewarm_uses_caller_supplied_metadata, responses_websocket_streams_without_feature_flag_when_provider_supports_websockets, responses_websocket_v2_incremental_requests_are_reused_across_turns, responses_websocket_v2_requests_use_v2_when_provider_supports_websockets, responses_websocket_v2_wins_when_both_features_enabled (+2 more)).


##### `websocket_harness_with_provider_options`  (lines 2143–2205)

```
async fn websocket_harness_with_provider_options(
    provider: ModelProviderInfo,
    runtime_metrics_enabled: bool,
) -> WebsocketTestHarness
```

**Purpose**: Builds the full test environment: temporary config, fake auth, telemetry, model info, ids, and ModelClient.

**Data flow**: It receives a ModelProviderInfo and runtime metrics flag. It creates a temporary Codex home, loads test config, sets the model, optionally enables runtime metrics, constructs model and telemetry objects, creates a ModelClient, and returns all of that inside WebsocketTestHarness.

**Call relations**: websocket_harness_with_options calls this after choosing a provider. This is the central setup factory that all WebSocket tests depend on.

*Call graph*: calls 9 internal fn (new, auth_manager_from_auth, construct_model_info_offline, from_api_key, new, new, in_memory, new, new); called by 1 (websocket_harness_with_options); 6 external calls (new, default, new, load_default_config_for_test, env!, clone).


##### `stream_until_complete`  (lines 2207–2219)

```
async fn stream_until_complete(
    client_session: &mut ModelClientSession,
    harness: &WebsocketTestHarness,
    prompt: &Prompt,
)
```

**Purpose**: Streams a prompt using the standard harness settings and waits until the model response completes.

**Data flow**: It takes a mutable client session, the harness, and a prompt. It forwards to the service-tier-aware helper with no service tier and returns after completion.

**Call relations**: Most tests call this to avoid repeating the event-loop boilerplate. It delegates to stream_until_complete_with_service_tier.

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

**Purpose**: Streams a prompt with a caller-supplied ModelInfo and checks that the completed response id matches what the test expects.

**Data flow**: It builds normal turn metadata, starts the client stream with the supplied model info, reads events until a Completed event appears, checks the response id, and returns. If completion never arrives, it panics.

**Call relations**: The responses-lite metadata test calls this because it needs to vary model settings per request. It calls the client session’s stream method directly.

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

**Purpose**: Streams a prompt while allowing the caller to specify an optional service tier, then waits for completion.

**Data flow**: It creates ordinary turn metadata, passes the prompt and optional service tier to the metadata-aware stream helper, and returns after completion.

**Call relations**: stream_until_complete calls this with no service tier. It is the bridge between the simplest stream helper and the fully configurable one.

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

**Purpose**: Starts a WebSocket stream with explicit metadata and waits until a Completed event is seen.

**Data flow**: It takes a client session, harness, prompt, optional service tier, and metadata. It calls the client session’s stream method with disabled rollout tracing, then consumes events until completion or stream end.

**Call relations**: Metadata-focused tests call this directly, and the simpler stream helpers build on it. It is the core helper for driving a request through the client without inspecting every event.

*Call graph*: calls 2 internal fn (stream, disabled); called by 3 (responses_websocket_forwards_turn_metadata_on_initial_and_incremental_create, responses_websocket_sends_canonical_turn_metadata, stream_until_complete_with_service_tier); 1 external calls (matches!).


### `core/tests/suite/realtime_conversation.rs`

`test` · `test run`

This is a large end-to-end test file for Codex's realtime conversation mode. Realtime mode is the part of the system where a user can speak or type and receive live audio/text responses through a WebSocket, or start a WebRTC call where media flows separately and a sideband WebSocket carries control messages. The tests build fake HTTP, WebSocket, and streaming response servers so the feature can be checked without talking to real OpenAI services.

The file checks the whole journey: starting a realtime session, sending audio frames and text messages, receiving audio back, closing cleanly, and reporting errors when a user sends audio or text before a session exists. It also checks configuration choices, such as default model/version, voice selection, backend prompt overrides, and startup context. Startup context is extra background inserted into the realtime instructions, like recent thread summaries and a workspace map.

A major theme is handoff. In these tests, the realtime service can ask the normal Codex agent to take over a question, and the agent's answer is then mirrored back to realtime. The tests make sure this delegation does not block audio forwarding, does not accidentally loop on echoed user messages, and keeps the right transcript snippets. Without this file, regressions in live conversation behavior could ship unnoticed because many failures only appear when network events arrive in tricky orders.

#### Function details

##### `RealtimeCallRequestCapture::new`  (lines 76–80)

```
fn new() -> Self
```

**Purpose**: Creates a small request recorder used by WebRTC call tests. It lets a mock server accept any matching request while saving the request so the test can inspect it later.

**Data flow**: It starts with no inputs. It creates an empty shared list protected by a mutex, which is a lock that stops two tasks changing the list at the same time, and returns a capture object holding that list.

**Call relations**: The WebRTC tests create this capture before mounting a mock POST endpoint. Later, the mock endpoint calls its matcher method for incoming requests, and the test reads the saved request with `RealtimeCallRequestCapture::single_request`.

*Call graph*: 3 external calls (new, new, new).


##### `RealtimeCallRequestCapture::single_request`  (lines 82–89)

```
fn single_request(&self) -> WiremockRequest
```

**Purpose**: Returns the one recorded realtime call request and fails the test if there was not exactly one. This keeps WebRTC tests honest about how many call-creation HTTP requests Codex sent.

**Data flow**: It reads the shared recorded-request list, checks that the list length is one, clones that request, and returns it to the test. It does not change the saved list.

**Call relations**: WebRTC call tests use this after starting a conversation to inspect the outgoing URL, headers, and multipart body that were captured by `RealtimeCallRequestCapture::matches`.

*Call graph*: 1 external calls (assert_eq!).


##### `RealtimeCallRequestCapture::matches`  (lines 93–99)

```
fn matches(&self, request: &WiremockRequest) -> bool
```

**Purpose**: Implements the mock-server matcher interface by accepting every request and saving a copy. It acts like a security camera at the mock endpoint: it does not block traffic, it records what passed by.

**Data flow**: It receives a mock HTTP request, locks the shared request list, pushes a clone of the request into that list, and returns true so the mock server treats the request as matched.

**Call relations**: Wiremock calls this when Codex posts to the fake realtime call endpoint. The tests later use `RealtimeCallRequestCapture::single_request` to examine what this method recorded.

*Call graph*: 1 external calls (clone).


##### `normalized_json_string`  (lines 102–105)

```
fn normalized_json_string(raw: &str) -> Result<String>
```

**Purpose**: Parses a JSON string and writes it back in a stable compact form. Tests use it when comparing generated multipart bodies where JSON spacing should not matter.

**Data flow**: It takes raw text, parses it as JSON, serializes the parsed value back into a normalized string, and returns that string or an error if parsing or serialization fails.

**Call relations**: `conversation_webrtc_start_posts_generated_session` uses this helper before comparing the expected generated session JSON inside a multipart WebRTC call request.

*Call graph*: called by 1 (conversation_webrtc_start_posts_generated_session); 2 external calls (from_str, to_string).


##### `websocket_request_text`  (lines 107–113)

```
fn websocket_request_text(
    request: &core_test_support::responses::WebSocketRequest,
) -> Option<String>
```

**Purpose**: Pulls the text content out of a captured WebSocket request, if that request is a text conversation item. It saves tests from repeating the same nested JSON lookup.

**Data flow**: It receives a captured WebSocket request, reads its JSON body, looks under the item content text field, and returns that text as an optional string.

**Call relations**: Tests that wait for or inspect sent realtime text use this helper inside predicates or assertions, especially when checking that only explicit text messages are sent to realtime.

*Call graph*: calls 1 internal fn (body_json).


##### `websocket_request_instructions`  (lines 115–121)

```
fn websocket_request_instructions(
    request: &core_test_support::responses::WebSocketRequest,
) -> Option<String>
```

**Purpose**: Pulls the session instructions out of a captured WebSocket request. These instructions are the prompt and optional startup context sent when a realtime session is configured.

**Data flow**: It receives a captured WebSocket request, reads the JSON body, looks for `session.instructions`, and returns the value as an optional string.

**Call relations**: Many startup, prompt, and voice tests call this after Codex sends `session.update`, so they can verify exactly what instructions the realtime backend received.

*Call graph*: calls 1 internal fn (body_json); called by 11 (conversation_disables_realtime_startup_context_with_empty_override, conversation_second_start_replaces_runtime, conversation_start_audio_text_close_round_trip, conversation_start_injects_startup_context_from_thread_history, conversation_startup_context_current_thread_selects_many_turns_by_budget, conversation_startup_context_falls_back_to_workspace_map, conversation_startup_context_is_truncated_and_sent_once_per_start, conversation_uses_default_realtime_backend_prompt, conversation_uses_empty_instructions_for_null_or_empty_prompt, conversation_uses_experimental_realtime_ws_backend_prompt_override (+1 more)).


##### `wait_for_websocket_request`  (lines 123–136)

```
async fn wait_for_websocket_request(
    server: &core_test_support::responses::WebSocketTestServer,
    connection_index: usize,
    request_index: usize,
) -> Result<core_test_support::responses::We
```

**Purpose**: Waits briefly for a specific request on a specific WebSocket connection. It turns a missing request into a clear timeout error instead of letting a test hang.

**Data flow**: It takes a test WebSocket server plus connection and request indexes, waits up to two seconds for that captured request, and returns the request or an error with a helpful message.

**Call relations**: `conversation_webrtc_start_posts_generated_session` uses this when the sideband WebSocket is expected to receive a session update and a queued text message after a WebRTC call starts.

*Call graph*: calls 1 internal fn (wait_for_request); called by 1 (conversation_webrtc_start_posts_generated_session); 2 external calls (from_secs, timeout).


##### `expected_realtime_backend_prompt`  (lines 138–142)

```
fn expected_realtime_backend_prompt() -> String
```

**Purpose**: Builds the expected default realtime backend prompt for assertions. It fills the prompt's user-name placeholder the same way production code should.

**Data flow**: It starts from the built-in realtime backend prompt, trims trailing whitespace, replaces the user-first-name placeholder with `test_user_first_name`, and returns the final string.

**Call relations**: `conversation_uses_default_realtime_backend_prompt` compares Codex's outgoing session instructions against this helper so the test follows the same name-substitution rule.

*Call graph*: calls 1 internal fn (test_user_first_name).


##### `test_user_first_name`  (lines 144–150)

```
fn test_user_first_name() -> String
```

**Purpose**: Finds a reasonable first name for tests that check personalized prompts. If the machine cannot provide one, it falls back to the friendly word `there`.

**Data flow**: It reads the operating system's real name and username, takes the first non-empty first word it can find, and returns that word. If both are empty, it returns `there`.

**Call relations**: `expected_realtime_backend_prompt` calls this helper so tests can predict the prompt text produced on different developer or CI machines.

*Call graph*: called by 1 (expected_realtime_backend_prompt); 2 external calls (realname, username).


##### `wait_for_matching_websocket_request`  (lines 152–178)

```
async fn wait_for_matching_websocket_request(
    server: &core_test_support::responses::WebSocketTestServer,
    description: &str,
    predicate: F,
) -> core_test_support::responses::WebSocketReque
```

**Purpose**: Polls the fake WebSocket server until any captured request matches a condition. This is useful when the exact connection timing is not important but the content is.

**Data flow**: It receives a server, a human description, and a predicate function. It repeatedly scans all captured WebSocket requests until one passes the predicate, returns that request, or fails after ten seconds.

**Call relations**: Startup-context and noop-tool tests use this to wait for meaningful outbound realtime messages, such as a `session.update` with instructions or proof that no unexpected `response.create` appeared.

*Call graph*: calls 1 internal fn (connections); called by 7 (conversation_disables_realtime_startup_context_with_empty_override, conversation_start_injects_startup_context_from_thread_history, conversation_startup_context_current_thread_selects_many_turns_by_budget, conversation_startup_context_falls_back_to_workspace_map, conversation_startup_context_is_truncated_and_sent_once_per_start, conversation_uses_experimental_realtime_ws_startup_context_override, realtime_v2_noop_tool_call_returns_empty_function_output_without_response); 5 external calls (from_millis, from_secs, assert!, now, sleep).


##### `run_realtime_conversation_test_in_subprocess`  (lines 180–210)

```
fn run_realtime_conversation_test_in_subprocess(
    test_name: &str,
    openai_api_key: Option<&str>,
) -> Result<()>
```

**Purpose**: Runs a selected test again in a child process with controlled environment variables. This isolates tests that depend on whether an API key environment variable is present.

**Data flow**: It receives a test name and optional API key, starts the current test binary with that exact test selected, removes proxy variables, sets or clears the API key, waits for completion, and fails if the child process failed.

**Call relations**: Auth-sensitive tests call this first from the parent process. The child process then runs the same test body with a marker environment variable so it performs the real assertions.

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

**Purpose**: Creates fake recent-thread metadata so startup-context tests have realistic history to summarize. It avoids needing to run a full conversation just to create history.

**Data flow**: It receives a test Codex instance plus title, first user message, and slug. It creates a rollout placeholder file, builds thread metadata with workspace, provider, and branch information, writes it to the state database, and returns success or an error.

**Call relations**: Startup-context tests call this before starting realtime. The realtime startup code later reads that seeded history and includes it in the session instructions, which the tests inspect through WebSocket requests.

*Call graph*: calls 4 internal fn (codex_home_path, workspace_path, new, new); called by 4 (conversation_disables_realtime_startup_context_with_empty_override, conversation_start_injects_startup_context_from_thread_history, conversation_startup_context_is_truncated_and_sent_once_per_start, conversation_uses_experimental_realtime_ws_startup_context_override); 3 external calls (now, format!, write).


##### `conversation_start_audio_text_close_round_trip`  (lines 245–414)

```
async fn conversation_start_audio_text_close_round_trip() -> Result<()>
```

**Purpose**: Checks the basic realtime lifecycle: start a session, send audio and text, receive audio, and close. This is the simplest full round trip for the realtime WebSocket path.

**Data flow**: It creates a fake WebSocket server, starts Codex against it, sends a realtime start operation, then sends one audio frame and one text message. It checks Codex emits started/session/audio/closed events and that the fake server received the expected session update, headers, URI, audio request, and text request.

**Call relations**: This test drives the public Codex operation API and relies on helpers like `websocket_request_instructions`. It exercises the same start/send/close flow that user interfaces depend on.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 8 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationAudio, RealtimeConversationStart, RealtimeConversationText, skip_if_no_network!, vec!).


##### `conversation_start_defaults_to_v2_and_gpt_realtime_1_5`  (lines 417–480)

```
async fn conversation_start_defaults_to_v2_and_gpt_realtime_1_5() -> Result<()>
```

**Purpose**: Verifies the default realtime settings when the caller does not choose a version or model. It protects the expected move to version 2 and the `gpt-realtime-1.5` model.

**Data flow**: It configures a fake realtime base URL, starts a conversation with no model or version, waits for the start and handshake, then reads the first session update. It confirms the version, request URI, default voice, and instructions.

**Call relations**: This test sits near the start of the suite because many other tests pin version 1 or override values. It confirms the default path before the more specialized cases.

*Call graph*: calls 3 internal fn (start_mock_server, start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_webrtc_start_posts_generated_session`  (lines 483–666)

```
async fn conversation_webrtc_start_posts_generated_session() -> Result<()>
```

**Purpose**: Checks that starting a WebRTC realtime conversation posts both the SDP offer and generated session settings to the call-creation endpoint. SDP is the text format browsers use to negotiate a WebRTC connection.

**Data flow**: It sets up a fake HTTP call endpoint and delayed sideband WebSocket, starts a WebRTC conversation, captures the SDP answer event, queues text before the sideband joins, then inspects the captured multipart POST body and later sideband WebSocket messages.

**Call relations**: This test uses `RealtimeCallRequestCapture`, `normalized_json_string`, and `wait_for_websocket_request`. It proves the WebRTC media leg can begin before the control WebSocket is ready and that queued messages are delivered later.

*Call graph*: calls 6 internal fn (new, start_mock_server, start_websocket_server_with_headers, test_codex, normalized_json_string, wait_for_websocket_request); 13 external calls (from_millis, given, new, from_utf8, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, RealtimeConversationText, skip_if_no_network! (+3 more)).


##### `conversation_webrtc_start_uses_avas_architecture_query`  (lines 669–765)

```
async fn conversation_webrtc_start_uses_avas_architecture_query() -> Result<()>
```

**Purpose**: Checks that WebRTC call creation adds the AVAS architecture query parameter when requested. This matters because the backend may route AVAS calls differently.

**Data flow**: It starts fake HTTP and WebSocket servers, requests a WebRTC conversation with the AVAS architecture, waits for the SDP answer and session update, then checks the call POST URL query and sideband handshake URI.

**Call relations**: This test uses `RealtimeCallRequestCapture` to inspect the call-creation request. It complements the general WebRTC start test by focusing on one routing option.

*Call graph*: calls 4 internal fn (new, start_mock_server, start_websocket_server_with_headers, test_codex); 9 external calls (given, new, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!, method, path_regex).


##### `conversation_webrtc_start_uses_configured_call_base_url_for_avas`  (lines 768–866)

```
async fn conversation_webrtc_start_uses_configured_call_base_url_for_avas() -> Result<()>
```

**Purpose**: Verifies that the configured WebRTC call base URL is honored for AVAS calls. Without this, tests and local deployments could accidentally post call setup to the wrong endpoint.

**Data flow**: It configures a custom call base URL, starts an AVAS WebRTC conversation, waits for the SDP and session update, then checks the captured call POST path/query and the sideband WebSocket handshake.

**Call relations**: Like the AVAS query test, it uses `RealtimeCallRequestCapture`. It adds coverage for configuration-based routing rather than default routing.

*Call graph*: calls 4 internal fn (new, start_mock_server, start_websocket_server_with_headers, test_codex); 10 external calls (given, new, assert_eq!, wait_for_event_match, format!, RealtimeConversationStart, skip_if_no_network!, vec!, method, path_regex).


##### `conversation_webrtc_close_while_sideband_connecting_drops_pending_join`  (lines 869–962)

```
async fn conversation_webrtc_close_while_sideband_connecting_drops_pending_join() -> Result<()>
```

**Purpose**: Ensures closing a WebRTC conversation while the sideband WebSocket is still connecting cancels that pending join. This prevents stale background tasks from emitting late errors or close events.

**Data flow**: It starts a WebRTC session whose sideband accept is delayed, waits for the SDP answer, closes the conversation immediately, then watches for unwanted later realtime errors or close events and checks that no sideband handshake completed.

**Call relations**: This test stresses timing around WebRTC startup. It verifies that `RealtimeConversationClose` wins over a still-pending sideband connection attempt.

*Call graph*: calls 3 internal fn (start_mock_server, start_websocket_server_with_headers, test_codex); 12 external calls (from_millis, given, new, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, timeout, vec! (+2 more)).


##### `conversation_webrtc_sideband_connect_failure_closes_with_error`  (lines 965–1052)

```
async fn conversation_webrtc_sideband_connect_failure_closes_with_error() -> Result<()>
```

**Purpose**: Checks the failure path when WebRTC call creation succeeds but the sideband WebSocket cannot connect. The user should see a realtime error and the conversation should stop.

**Data flow**: It posts the WebRTC call successfully, points the sideband URL at a refused local port, waits for started and SDP events, then expects a realtime error followed by a closed event with reason `error`. It also checks later text submission is rejected because no conversation is running.

**Call relations**: This test follows the WebRTC startup flow but forces the sideband connection to fail. It confirms that subsequent operations see the runtime as closed.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 10 external calls (given, new, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, RealtimeConversationText, skip_if_no_network!, method, path_regex).


##### `conversation_start_uses_openai_env_key_fallback_with_chatgpt_auth`  (lines 1055–1134)

```
async fn conversation_start_uses_openai_env_key_fallback_with_chatgpt_auth() -> Result<()>
```

**Purpose**: Checks that realtime can use an OpenAI API key from the environment when the configured auth is ChatGPT-style auth. Realtime requires API-key auth, so this fallback is important.

**Data flow**: In the parent process it reruns itself with an environment API key. In the child, it starts a realtime conversation using dummy ChatGPT auth, waits for session setup, and verifies the WebSocket authorization header uses the environment key.

**Call relations**: It uses `run_realtime_conversation_test_in_subprocess` to control the environment. This pairs with the preflight-failure test where no fallback key exists.

*Call graph*: calls 4 internal fn (start_websocket_server, test_codex, run_realtime_conversation_test_in_subprocess, create_dummy_chatgpt_auth_for_testing); 7 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, var_os, vec!).


##### `conversation_transport_close_emits_closed_event`  (lines 1137–1201)

```
async fn conversation_transport_close_emits_closed_event() -> Result<()>
```

**Purpose**: Verifies that when the WebSocket transport closes by itself, Codex reports a closed realtime conversation. This gives clients a clear signal that the live session ended.

**Data flow**: It starts a fake server that sends a session update and then closes. The test starts realtime, waits for the session update, then waits for a closed event whose reason is `transport_closed`.

**Call relations**: This covers server-initiated shutdown, unlike tests where Codex explicitly sends `RealtimeConversationClose`.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_audio_before_start_emits_error`  (lines 1204–1233)

```
async fn conversation_audio_before_start_emits_error() -> Result<()>
```

**Purpose**: Checks that sending realtime audio before a conversation exists produces a clear bad-request error. This prevents silent dropping of user audio.

**Data flow**: It starts Codex without starting realtime, submits an audio frame, then waits for an error event saying the conversation is not running and marked as a bad request.

**Call relations**: This is one of the guardrail tests for operation ordering. It mirrors `conversation_text_before_start_emits_error` for text input.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 5 external calls (assert_eq!, wait_for_event_match, RealtimeConversationAudio, skip_if_no_network!, vec!).


##### `conversation_start_preflight_failure_emits_realtime_error_only`  (lines 1236–1287)

```
async fn conversation_start_preflight_failure_emits_realtime_error_only() -> Result<()>
```

**Purpose**: Ensures an auth preflight failure is reported as a realtime error, without also emitting a misleading closed event. Preflight means the start request is rejected before a transport is opened.

**Data flow**: It runs in a subprocess with no API key, starts realtime using ChatGPT auth, waits for a realtime error saying API-key auth is required, then confirms no closed event arrives shortly after.

**Call relations**: It uses `run_realtime_conversation_test_in_subprocess` to guarantee the API key is absent. It complements the environment-key fallback test.

*Call graph*: calls 4 internal fn (start_websocket_server, test_codex, run_realtime_conversation_test_in_subprocess, create_dummy_chatgpt_auth_for_testing); 9 external calls (from_millis, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, var_os, timeout, vec!).


##### `conversation_start_connect_failure_emits_realtime_error_only`  (lines 1290–1337)

```
async fn conversation_start_connect_failure_emits_realtime_error_only() -> Result<()>
```

**Purpose**: Checks that a connection failure during startup is reported as a realtime error and not as a normal close. This distinguishes 'never started' from 'started and later closed'.

**Data flow**: It points the realtime WebSocket base URL at a refused local port, submits a start operation, waits for a non-empty realtime error, and confirms no closed event follows within a short timeout.

**Call relations**: This covers the transport-connect failure path for WebSocket realtime starts, separate from WebRTC sideband failures that occur after call creation.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 7 external calls (from_millis, assert!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, timeout, vec!).


##### `conversation_text_before_start_emits_error`  (lines 1340–1364)

```
async fn conversation_text_before_start_emits_error() -> Result<()>
```

**Purpose**: Checks that sending realtime text before a conversation exists produces a clear bad-request error. This prevents user text from disappearing without feedback.

**Data flow**: It starts Codex without a realtime session, submits a realtime text operation, and waits for an error event saying the conversation is not running.

**Call relations**: This is the text counterpart to `conversation_audio_before_start_emits_error` and protects the same runtime-state check.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 5 external calls (assert_eq!, wait_for_event_match, RealtimeConversationText, skip_if_no_network!, vec!).


##### `conversation_second_start_replaces_runtime`  (lines 1367–1500)

```
async fn conversation_second_start_replaces_runtime() -> Result<()>
```

**Purpose**: Verifies that starting a second realtime conversation replaces the first runtime. After replacement, new audio should go to the new WebSocket connection, not the old one.

**Data flow**: It starts one realtime session with old instructions and session id, then starts another with new instructions and session id. It sends audio and checks the fake server saw only the new connection receive the audio append.

**Call relations**: This test drives two `RealtimeConversationStart` operations back to back and uses `websocket_request_instructions` to prove each connection received the right setup.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 7 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationAudio, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_experimental_realtime_ws_base_url_override`  (lines 1503–1569)

```
async fn conversation_uses_experimental_realtime_ws_base_url_override() -> Result<()>
```

**Purpose**: Checks that an experimental config value can redirect realtime WebSocket traffic to a custom base URL. This is useful for tests, local development, and alternate backends.

**Data flow**: It creates one startup server and one realtime server, configures the realtime override to point at the second server, starts realtime, and confirms only the realtime server receives the session update.

**Call relations**: This test verifies configuration wiring before later tests rely on custom realtime servers for startup-context and handoff scenarios.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_default_realtime_backend_prompt`  (lines 1572–1638)

```
async fn conversation_uses_default_realtime_backend_prompt() -> Result<()>
```

**Purpose**: Verifies that when no prompt is supplied, Codex uses its built-in realtime backend prompt plus startup context. This protects the default assistant instructions.

**Data flow**: It configures a controlled startup context, starts realtime with no prompt, waits for the session update, and compares the outgoing instructions against `expected_realtime_backend_prompt` plus the context.

**Call relations**: It calls `expected_realtime_backend_prompt`, which accounts for local user-name substitution, and `websocket_request_instructions` to inspect what was sent.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_empty_instructions_for_null_or_empty_prompt`  (lines 1641–1719)

```
async fn conversation_uses_empty_instructions_for_null_or_empty_prompt() -> Result<()>
```

**Purpose**: Checks the difference between no prompt and an explicitly empty prompt. If the caller says null or empty, Codex should send empty instructions rather than falling back to defaults.

**Data flow**: It starts two realtime sessions, one with an explicit null prompt and one with an empty string prompt. For each, it waits for the matching session id, closes it, then verifies both session updates contained empty instructions.

**Call relations**: This test uses the same prompt-inspection helper as the default-prompt test, but proves explicit emptiness is respected.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 7 external calls (new, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_explicit_start_voice`  (lines 1722–1777)

```
async fn conversation_uses_explicit_start_voice() -> Result<()>
```

**Purpose**: Verifies that a voice passed in the start operation is sent to realtime. Voice selection controls which spoken output voice the realtime backend should use.

**Data flow**: It starts a realtime session with the `Breeze` voice, waits for the session update, and checks the outgoing session JSON contains `breeze` as the output voice.

**Call relations**: This test covers per-request voice selection. The configured-voice test covers the config fallback when no start voice is supplied.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_configured_realtime_voice`  (lines 1780–1838)

```
async fn conversation_uses_configured_realtime_voice() -> Result<()>
```

**Purpose**: Checks that the configured realtime voice is used when the start operation does not specify one. This makes user or project settings affect realtime speech.

**Data flow**: It sets the config voice to `Cove`, starts realtime without an explicit voice, waits for session setup, and verifies the session update contains `cove`.

**Call relations**: This complements `conversation_uses_explicit_start_voice` by proving the config path works.

*Call graph*: calls 2 internal fn (start_websocket_server, test_codex); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_rejects_voice_for_wrong_realtime_version`  (lines 1841–1875)

```
async fn conversation_rejects_voice_for_wrong_realtime_version() -> Result<()>
```

**Purpose**: Ensures Codex rejects a voice option that is not supported by the selected realtime WebSocket version. This prevents sending invalid session settings to the backend.

**Data flow**: It configures realtime version 2, starts a conversation with a version-incompatible voice, and waits for a realtime error message explaining the voice is unsupported for v2.

**Call relations**: This test focuses on validation before transport setup. It protects version-specific behavior that the successful voice tests do not cover.

*Call graph*: calls 2 internal fn (start_mock_server, test_codex); 4 external calls (assert!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!).


##### `conversation_uses_experimental_realtime_ws_backend_prompt_override`  (lines 1878–1937)

```
async fn conversation_uses_experimental_realtime_ws_backend_prompt_override() -> Result<()>
```

**Purpose**: Checks that a configured backend prompt override wins over the prompt passed in the start operation. This lets experimental configuration force a known prompt.

**Data flow**: It sets the config backend prompt to `prompt from config`, starts realtime with a different operation prompt, waits for session setup, and verifies the sent instructions start with the configured prompt.

**Call relations**: This test uses `websocket_request_instructions` and is part of the group that checks how prompts and startup context are combined.

*Call graph*: calls 3 internal fn (start_websocket_server, test_codex, websocket_request_instructions); 6 external calls (assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_uses_experimental_realtime_ws_startup_context_override`  (lines 1940–2008)

```
async fn conversation_uses_experimental_realtime_ws_startup_context_override() -> Result<()>
```

**Purpose**: Verifies that a configured startup-context override is appended to instructions instead of generating automatic context. This gives tests or operators precise control over what realtime receives.

**Data flow**: It seeds recent-thread and workspace data, configures a custom startup context, starts realtime, waits for the session update with instructions, and checks those instructions contain only the configured prompt plus custom context.

**Call relations**: It calls `seed_recent_thread` to create data that automatic context would normally include, then proves the override bypasses that generated content.

*Call graph*: calls 5 internal fn (start_websocket_server, test_codex, seed_recent_thread, wait_for_matching_websocket_request, websocket_request_instructions); 7 external calls (assert!, assert_eq!, create_dir_all, write, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_disables_realtime_startup_context_with_empty_override`  (lines 2011–2078)

```
async fn conversation_disables_realtime_startup_context_with_empty_override() -> Result<()>
```

**Purpose**: Checks that setting the startup-context override to an empty string disables startup context entirely. This is different from using generated context.

**Data flow**: It seeds recent-thread and workspace data, configures an empty startup-context override, starts realtime, waits for instructions, and verifies only the prompt is sent with no generated context markers.

**Call relations**: This test uses the same setup helpers as the custom-context override test but proves the empty override means 'send none'.

*Call graph*: calls 5 internal fn (start_websocket_server, test_codex, seed_recent_thread, wait_for_matching_websocket_request, websocket_request_instructions); 7 external calls (assert!, assert_eq!, create_dir_all, write, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_start_injects_startup_context_from_thread_history`  (lines 2081–2150)

```
async fn conversation_start_injects_startup_context_from_thread_history() -> Result<()>
```

**Purpose**: Verifies that realtime startup instructions include generated context from recent thread history and workspace files. This helps a voice session begin with useful project background.

**Data flow**: It seeds a recent thread, creates a README in the workspace, starts realtime with startup context enabled, then reads the session instructions and checks for context tags, recent session details, branch info, user ask, and workspace map.

**Call relations**: It uses `seed_recent_thread` and `wait_for_matching_websocket_request`. It is the main test for automatic startup-context generation.

*Call graph*: calls 5 internal fn (start_websocket_server, test_codex, seed_recent_thread, wait_for_matching_websocket_request, websocket_request_instructions); 6 external calls (assert!, create_dir_all, write, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_startup_context_current_thread_selects_many_turns_by_budget`  (lines 2153–2313)

```
async fn conversation_startup_context_current_thread_selects_many_turns_by_budget() -> Result<()>
```

**Purpose**: Checks that startup context includes a budgeted summary of the current thread and truncates long turns safely. A budget keeps realtime instructions from becoming too large.

**Data flow**: It builds a resumed thread with many user/assistant turns, starts realtime, extracts the `Current Thread` section from the sent instructions, snapshots it, and verifies no rendered turn exceeds the per-turn size limit.

**Call relations**: This test resumes a thread through the thread manager instead of running many model turns. It uses `wait_for_matching_websocket_request` to inspect the generated startup context.

*Call graph*: calls 7 internal fn (auth_manager_from_auth, start_mock_server, start_websocket_server, test_codex, wait_for_matching_websocket_request, websocket_request_instructions, from_api_key); 7 external calls (assert_eq!, format!, assert_snapshot!, Forked, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_startup_context_falls_back_to_workspace_map`  (lines 2316–2372)

```
async fn conversation_startup_context_falls_back_to_workspace_map() -> Result<()>
```

**Purpose**: Checks that startup context still includes a workspace map even when there is no recent thread history. This gives realtime some orientation in a fresh workspace.

**Data flow**: It creates workspace files and directories, starts realtime, reads the outgoing instructions, and checks for startup context tags plus file and directory names from the workspace map.

**Call relations**: This is the no-history counterpart to the thread-history startup-context test.

*Call graph*: calls 4 internal fn (start_websocket_server, test_codex, wait_for_matching_websocket_request, websocket_request_instructions); 6 external calls (assert!, create_dir_all, write, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `conversation_startup_context_is_truncated_and_sent_once_per_start`  (lines 2375–2450)

```
async fn conversation_startup_context_is_truncated_and_sent_once_per_start() -> Result<()>
```

**Purpose**: Verifies that very large startup context is trimmed and only sent during session setup, not repeated with later user text. This prevents oversized or duplicate realtime messages.

**Data flow**: It seeds an oversized recent-thread summary, starts realtime, confirms the sent instructions contain context but stay under a length cap, then sends explicit realtime text and verifies that later text request contains only the user text.

**Call relations**: It combines `seed_recent_thread`, `wait_for_matching_websocket_request`, and `websocket_request_text` to check both startup and later message behavior.

*Call graph*: calls 5 internal fn (start_websocket_server, test_codex, seed_recent_thread, wait_for_matching_websocket_request, websocket_request_instructions); 7 external calls (assert!, assert_eq!, write, RealtimeConversationStart, RealtimeConversationText, skip_if_no_network!, vec!).


##### `conversation_user_text_turn_is_not_sent_to_realtime`  (lines 2453–2547)

```
async fn conversation_user_text_turn_is_not_sent_to_realtime() -> Result<()>
```

**Purpose**: Checks that normal Codex user input is sent to the model API, not duplicated into the realtime WebSocket. This keeps typed agent turns separate from explicit realtime text operations.

**Data flow**: It starts realtime, submits a normal `UserInput` turn, waits for the model turn to complete, verifies the model request contains the typed text, and checks the realtime WebSocket saw only the initial session update.

**Call relations**: This test separates the normal agent path from the realtime transport path. It uses a mounted mock SSE response for the regular model turn.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, start_websocket_server, test_codex); 7 external calls (default, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `realtime_v2_noop_tool_call_returns_empty_function_output_without_response`  (lines 2550–2639)

```
async fn realtime_v2_noop_tool_call_returns_empty_function_output_without_response() -> Result<()>
```

**Purpose**: Checks version 2 behavior for a realtime `remain_silent` tool call. Codex should answer the tool call with an empty output and not ask realtime to create another response.

**Data flow**: It starts realtime v2, has the fake server send a function call named `remain_silent`, waits for Codex to report a noop request, then checks the WebSocket request is a function-call output with an empty string and no `response.create` appears.

**Call relations**: This test uses `wait_for_matching_websocket_request` both to observe expected output and guard against an unwanted response request.

*Call graph*: calls 4 internal fn (start_mock_server, start_websocket_server, test_codex, wait_for_matching_websocket_request); 8 external calls (from_millis, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, timeout, vec!).


##### `conversation_mirrors_assistant_message_text_to_realtime_handoff`  (lines 2642–2759)

```
async fn conversation_mirrors_assistant_message_text_to_realtime_handoff() -> Result<()>
```

**Purpose**: Verifies that when realtime asks the normal agent for help, the assistant's final text is appended back to the realtime handoff. This is how the voice session receives the agent's answer.

**Data flow**: It starts realtime, has the fake realtime server request a handoff, serves a normal model response saying `assistant says hi`, waits for turn completion, and checks the realtime WebSocket received a `conversation.handoff.append` with the formatted assistant message.

**Call relations**: This is a core handoff test. It connects inbound realtime handoff events, the normal SSE model response, and outbound realtime handoff append messages.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, start_websocket_server, test_codex); 10 external calls (from_millis, from_secs, assert_eq!, wait_for_event, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, now, sleep, vec!).


##### `conversation_handoff_persists_across_item_done_until_turn_complete`  (lines 2762–2919)

```
async fn conversation_handoff_persists_across_item_done_until_turn_complete() -> Result<()>
```

**Purpose**: Ensures a handoff remains active even if realtime marks the source item done before the delegated model turn finishes. This lets later assistant text still be mirrored to the right handoff.

**Data flow**: It uses a gated streaming model response with two assistant messages, starts realtime, receives a handoff, checks the first append, receives `conversation.item.done`, releases the second message, and checks the second append still uses the same handoff id.

**Call relations**: This test uses `sse_event` to build streaming chunks and proves the handoff lifetime is tied to model turn completion, not only realtime item completion.

*Call graph*: calls 3 internal fn (start_websocket_server, start_streaming_sse_server, test_codex); 7 external calls (assert_eq!, wait_for_event, wait_for_event_match, channel, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `sse_event`  (lines 2921–2923)

```
fn sse_event(event: Value) -> String
```

**Purpose**: Wraps one JSON event as a server-sent event response chunk for streaming tests. Server-sent events are a simple HTTP streaming format where the server pushes events over one response.

**Data flow**: It receives one JSON value, places it in a one-item list, passes it to the shared SSE formatter, and returns the formatted string.

**Call relations**: Several streaming handoff tests call this when constructing fake model response chunks for `start_streaming_sse_server`.

*Call graph*: calls 1 internal fn (sse); 1 external calls (vec!).


##### `message_input_texts`  (lines 2925–2937)

```
fn message_input_texts(body: &Value, role: &str) -> Vec<String>
```

**Purpose**: Extracts text spans for a chosen role from a model request JSON body. It helps tests confirm exactly what user text was sent to the model API.

**Data flow**: It receives a JSON body and role name, walks the `input` array, keeps message items with that role, collects `input_text` content spans, and returns their text strings.

**Call relations**: `inbound_handoff_request_steers_active_turn` and `inbound_handoff_request_starts_turn_and_does_not_block_realtime_audio` use this helper after reading raw mock API requests.

*Call graph*: called by 2 (inbound_handoff_request_starts_turn_and_does_not_block_realtime_audio, inbound_handoff_request_steers_active_turn); 1 external calls (get).


##### `inbound_handoff_request_starts_turn`  (lines 2940–3034)

```
async fn inbound_handoff_request_starts_turn() -> Result<()>
```

**Purpose**: Checks that a handoff request from realtime starts a normal Codex model turn. The delegated realtime transcript should become user input for the agent.

**Data flow**: It starts realtime, has the fake server send transcript text and a handoff request, waits for model turn completion, then verifies the model request contains a `<realtime_delegation>` block with the input and transcript delta.

**Call relations**: This is the basic inbound-delegation test. Later handoff tests add transcript accumulation, repeated handoffs, and non-blocking audio behavior.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, start_websocket_server, test_codex); 7 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `inbound_handoff_request_uses_active_transcript`  (lines 3037–3126)

```
async fn inbound_handoff_request_uses_active_transcript() -> Result<()>
```

**Purpose**: Verifies that a handoff uses the active transcript built from recent realtime input and output deltas, not only the request's raw input field. This gives the agent better context.

**Data flow**: It sends assistant and user transcript deltas before the handoff request, waits for the delegated turn, then checks the model request includes the ordered assistant/user transcript plus the handoff input.

**Call relations**: This expands on the basic handoff-starts-turn test by checking transcript context construction.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, start_websocket_server, test_codex); 6 external calls (assert!, wait_for_event, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `inbound_handoff_request_sends_transcript_delta_after_each_handoff`  (lines 3129–3257)

```
async fn inbound_handoff_request_sends_transcript_delta_after_each_handoff() -> Result<()>
```

**Purpose**: Checks that transcript deltas are reset after each handoff. The second delegated turn should not include the first handoff's transcript as stale context.

**Data flow**: It serves two model responses and sends two realtime handoff requests separated by activity. After both turns complete, it inspects both model requests and confirms each contains only its own question's transcript delta.

**Call relations**: This protects repeated delegation sessions. It builds on the same handoff path as `inbound_handoff_request_starts_turn` but checks cleanup between handoffs.

*Call graph*: calls 4 internal fn (mount_sse_sequence, start_mock_server, start_websocket_server, test_codex); 8 external calls (assert!, assert_eq!, wait_for_event, wait_for_event_match, RealtimeConversationAudio, RealtimeConversationStart, skip_if_no_network!, vec!).


##### `inbound_conversation_item_does_not_start_turn_and_still_forwards_audio`  (lines 3260–3349)

```
async fn inbound_conversation_item_does_not_start_turn_and_still_forwards_audio() -> Result<()>
```

**Purpose**: Ensures an inbound realtime conversation item with role `user` does not itself start a Codex turn, while realtime audio still flows through. This avoids redelegating echoed local messages.

**Data flow**: It starts realtime, has the server send a user conversation item followed by an audio delta, waits for the audio event, and confirms no normal Codex turn starts.

**Call relations**: This guards against treating every inbound conversation item as a delegation trigger. Handoff requests, not user-role echoes, should start agent turns.

*Call graph*: calls 3 internal fn (start_mock_server, start_websocket_server, test_codex); 8 external calls (from_millis, assert!, assert_eq!, wait_for_event_match, RealtimeConversationStart, skip_if_no_network!, timeout, vec!).


##### `delegated_turn_user_role_echo_does_not_redelegate_and_still_forwards_audio`  (lines 3352–3526)

```
async fn delegated_turn_user_role_echo_does_not_redelegate_and_still_forwards_audio() -> Result<()>
```

**Purpose**: Checks that when a delegated assistant answer is echoed back as a user-role realtime item, Codex does not start a second delegation loop. Audio forwarding must continue during that situation.

**Data flow**: It starts a delegated turn, waits for the assistant answer to be mirrored to realtime, then has realtime echo that text as a user item and send audio. The test confirms audio is forwarded and only one model request was made.

**Call relations**: This is a loop-prevention test for the handoff system. It also demonstrates that realtime audio events are still processed while a delegated turn is completing.

*Call graph*: calls 3 internal fn (start_websocket_server, start_streaming_sse_server, test_codex); 9 external calls (assert_eq!, wait_for_event, wait_for_event_match, eprintln!, channel, RealtimeConversationStart, skip_if_no_network!, now, vec!).


##### `inbound_handoff_request_does_not_block_realtime_event_forwarding`  (lines 3529–3643)

```
async fn inbound_handoff_request_does_not_block_realtime_event_forwarding() -> Result<()>
```

**Purpose**: Ensures realtime events keep flowing while a delegated model turn is still pending. A voice session should not freeze just because the normal agent is thinking.

**Data flow**: It starts realtime, receives a handoff request that starts a gated model turn, then expects an audio delta from realtime before the model turn is allowed to finish.

**Call relations**: This test uses a streaming server with a gate to hold the model response open. It proves event forwarding and delegated model work run independently enough for audio to continue.

*Call graph*: calls 3 internal fn (start_websocket_server, start_streaming_sse_server, test_codex); 9 external calls (from_millis, assert_eq!, wait_for_event, wait_for_event_match, channel, RealtimeConversationStart, skip_if_no_network!, timeout, vec!).


##### `inbound_handoff_request_steers_active_turn`  (lines 3646–3826)

```
async fn inbound_handoff_request_steers_active_turn() -> Result<()>
```

**Purpose**: Checks that a realtime handoff arriving during an active user turn steers the next model request rather than being merged into the already-started request. This protects ordering when the user speaks while the agent is responding.

**Data flow**: It starts a normal user turn, waits until the model is streaming output, then sends realtime audio that triggers a handoff. After both model requests complete, it verifies the first request has only the original prompt and the second includes the realtime delegation.

**Call relations**: This test uses `message_input_texts` to inspect both raw API requests. It covers a race-prone path where realtime input arrives during an ongoing turn.

*Call graph*: calls 4 internal fn (start_websocket_server_with_headers, start_streaming_sse_server, test_codex, message_input_texts); 11 external calls (default, assert!, assert_eq!, wait_for_event, wait_for_event_match, channel, RealtimeConversationAudio, RealtimeConversationStart, from_slice, skip_if_no_network! (+1 more)).


##### `inbound_handoff_request_starts_turn_and_does_not_block_realtime_audio`  (lines 3829–3954)

```
async fn inbound_handoff_request_starts_turn_and_does_not_block_realtime_audio() -> Result<()>
```

**Purpose**: Checks that a realtime handoff starts a model turn and that audio arriving immediately afterward is still forwarded promptly. This combines delegation correctness with live-audio responsiveness.

**Data flow**: It starts realtime, receives a handoff request and then an audio delta while the delegated model turn is gated open. It confirms the audio event arrives, releases the model completion, and verifies the model request contains the expected realtime delegation text.

**Call relations**: This final handoff test uses `message_input_texts` for request inspection and a gated streaming server to prove the delegated turn does not block realtime audio delivery.

*Call graph*: calls 4 internal fn (start_websocket_server, start_streaming_sse_server, test_codex, message_input_texts); 12 external calls (from_millis, assert!, assert_eq!, wait_for_event, wait_for_event_match, format!, channel, RealtimeConversationStart, from_slice, skip_if_no_network! (+2 more)).


### Turn continuity and compaction
These tests focus on preserving and reshaping conversation state across follow-ups, including remote compaction, lite-mode variants, and per-turn transport state.

### `core/tests/suite/compact_remote.rs`

`test` · `test run`

Long agent conversations can grow too large for the model to read. Remote compaction is the safety valve: Codex sends the current conversation history to a remote endpoint, receives a compact replacement such as an encrypted summary, and then uses that smaller history for later model requests. Without this behavior, follow-up turns could overflow the model context window, lose important state, or send the wrong metadata to the service.

This test file acts like a controlled rehearsal stage. It builds fake Codex sessions, fake HTTP and WebSocket model servers, and scripted model responses. Then it drives the session through user turns, tool calls, realtime conversations, model switches, failures, retries, shutdown and resume. After each scenario, it inspects the exact outgoing requests and events to make sure compaction behaves correctly.

The tests verify practical details that matter in production: authentication headers, service tier rules, prompt cache keys, turn and window IDs, retry behavior, filtering hidden dynamic tools, trimming oversized tool output, preserving realtime start or end instructions, refreshing stale developer instructions, and carrying turn state across requests. Many tests also create snapshots of request shapes, like photos of the expected wire format, so future changes cannot accidentally rearrange history.

#### Function details

##### `approx_token_count`  (lines 53–55)

```
fn approx_token_count(text: &str) -> i64
```

**Purpose**: Gives a rough token estimate for a piece of text. Tests use it as a simple measuring tape when checking whether a compact request should fit inside a model's context window.

**Data flow**: It receives text, estimates one token for about every four characters, protects against overflow, and returns the estimate as a number.

**Call relations**: The trim-estimation tests call this directly and through the larger payload estimators to compare ordinary instructions with oversized custom instructions.

*Call graph*: called by 2 (estimate_compact_payload_tokens, remote_compact_trim_estimate_uses_session_base_instructions); 1 external calls (try_from).


##### `estimate_compact_input_tokens`  (lines 57–61)

```
fn estimate_compact_input_tokens(request: &responses::ResponsesRequest) -> i64
```

**Purpose**: Estimates how many tokens the input part of a compact request will use. This helps tests reason about whether history should be trimmed.

**Data flow**: It receives a captured compact request, reads each input item, turns each item into text, applies the rough token estimate, and returns the total.

**Call relations**: It is used by the full payload estimator and by the base-instructions trimming test to build a before-and-after size comparison.

*Call graph*: calls 1 internal fn (input); called by 2 (estimate_compact_payload_tokens, remote_compact_trim_estimate_uses_session_base_instructions).


##### `estimate_compact_payload_tokens`  (lines 63–66)

```
fn estimate_compact_payload_tokens(request: &responses::ResponsesRequest) -> i64
```

**Purpose**: Estimates the size of the full compact request payload, including both conversation input and instructions. This lets a test check that session instructions are included in trimming decisions.

**Data flow**: It receives a compact request, estimates the input size, estimates the instruction text size, adds them, and returns the combined total.

**Call relations**: The base-instructions trimming test calls this after capturing a baseline compact request, then uses the number to choose a context-window size for a second run.

*Call graph*: calls 3 internal fn (instructions_text, approx_token_count, estimate_compact_input_tokens); called by 1 (remote_compact_trim_estimate_uses_session_base_instructions).


##### `assert_tools_payload_does_not_defer`  (lines 68–75)

```
fn assert_tools_payload_does_not_defer(body: &Value)
```

**Purpose**: Checks that the tools sent to the model do not include hidden deferred-tool declarations. Deferred tools are tools that should stay invisible until discovered.

**Data flow**: It receives a JSON request body, looks for the tools section, searches inside it for any `defer_loading: true`, and fails the test if one is found.

**Call relations**: The dynamic-tool filtering test uses this on both normal model requests and compact requests to prove they expose the same safe tool list.

*Call graph*: called by 1 (remote_compact_filters_deferred_dynamic_tools); 2 external calls (get, assert!).


##### `namespace_child_tool_names`  (lines 77–102)

```
fn namespace_child_tool_names(body: &Value, namespace: &str) -> Vec<String>
```

**Purpose**: Extracts the visible child tool names from a named tool namespace in a JSON request body. It is a small inspection helper for dynamic tool tests.

**Data flow**: It receives a JSON body and a namespace name, finds the matching namespace tool entry, collects its child tool names, and returns them as strings.

**Call relations**: It supports the deferred dynamic tools test by confirming that only the visible tool appears under the expected namespace.

*Call graph*: 1 external calls (get).


##### `contains_defer_loading`  (lines 104–113)

```
fn contains_defer_loading(value: &Value) -> bool
```

**Purpose**: Searches any JSON value for the marker that says a tool should be deferred. It is used to detect hidden declarations anywhere in a nested tools payload.

**Data flow**: It receives a JSON value, recursively walks objects and arrays, and returns true if it finds `defer_loading` set to true; simple values return false.

**Call relations**: It is the recursive worker behind `assert_tools_payload_does_not_defer`, which is called by the dynamic-tool filtering test.


##### `canonical_json`  (lines 115–130)

```
fn canonical_json(value: &Value) -> Value
```

**Purpose**: Normalizes JSON object key order so two request bodies can be compared reliably. This avoids false test failures caused only by map ordering.

**Data flow**: It receives a JSON value, recursively sorts object keys, leaves arrays in order, clones simple values, and returns the normalized JSON.

**Call relations**: The request-parity helper uses it before comparing compact request fields with normal response request fields.

*Call graph*: called by 1 (assert_remote_manual_compact_request_parity); 3 external calls (Array, Object, clone).


##### `summary_with_prefix`  (lines 137–139)

```
fn summary_with_prefix(summary: &str) -> String
```

**Purpose**: Builds a compaction summary string in the format Codex expects, with the standard summary prefix at the top.

**Data flow**: It receives summary text, prepends the shared `SUMMARY_PREFIX` and a newline, and returns the combined string.

**Call relations**: Several snapshot tests use it when creating fake remote compaction responses, so the mocked summary looks like a real compacted summary.

*Call graph*: called by 3 (snapshot_request_shape_remote_mid_turn_continuation_compaction, snapshot_request_shape_remote_pre_turn_compaction_including_incoming_user_message, snapshot_request_shape_remote_pre_turn_compaction_strips_incoming_model_switch); 1 external calls (format!).


##### `context_snapshot_options`  (lines 141–145)

```
fn context_snapshot_options() -> ContextSnapshotOptions
```

**Purpose**: Defines how request snapshots should be simplified before being stored. It strips noisy capability instructions and keeps item text short.

**Data flow**: It starts with default snapshot options, turns on instruction stripping, chooses a compact render style, and returns the options.

**Call relations**: The labeled snapshot formatter calls this so many tests get consistent, readable snapshot output.

*Call graph*: calls 1 internal fn (default); called by 1 (format_labeled_requests_snapshot).


##### `format_labeled_requests_snapshot`  (lines 147–156)

```
fn format_labeled_requests_snapshot(
    scenario: &str,
    sections: &[(&str, &responses::ResponsesRequest)],
) -> String
```

**Purpose**: Creates a readable snapshot showing one or more labeled model requests for a scenario. Snapshots help reviewers see exactly how history was sent.

**Data flow**: It receives a scenario description and labeled captured requests, applies this file's snapshot options, and returns formatted text.

**Call relations**: Many tests call this inside snapshot assertions after they have driven Codex through compaction and captured the outgoing requests.

*Call graph*: calls 2 internal fn (format_labeled_requests_snapshot, context_snapshot_options).


##### `compacted_summary_only_output`  (lines 158–163)

```
fn compacted_summary_only_output(summary: &str) -> Vec<ResponseItem>
```

**Purpose**: Builds a fake remote compact response that contains only one compaction item. Tests use this to model the server replacing all old history with a summary.

**Data flow**: It receives summary text, wraps it with the compaction prefix, puts it into a `ResponseItem::Compaction`, and returns a one-item list.

**Call relations**: Realtime and turn-state tests use this helper when mounting mocked compact endpoints that should return a simple summary-only history.

*Call graph*: 1 external calls (vec!).


##### `test_codex`  (lines 165–169)

```
fn test_codex() -> TestCodexBuilder
```

**Purpose**: Creates the standard test Codex builder for this file. It intentionally disables RemoteCompactionV2 unless a test turns it back on, so v1 behavior is the default.

**Data flow**: It starts from the shared test builder, changes the configuration to disable the v2 compaction feature, and returns the builder.

**Call relations**: Almost every test starts here, then adds authentication, model choices, context limits, WebSocket settings, or feature flags for its specific scenario.

*Call graph*: calls 1 internal fn (test_codex); called by 31 (assert_remote_manual_compact_request_parity, auto_remote_compact_failure_stops_agent_loop, auto_remote_compact_trims_function_call_history_to_fit_context_window, remote_compact_and_resume_refresh_stale_developer_instructions, remote_compact_filters_deferred_dynamic_tools, remote_compact_persists_replacement_history_in_rollout, remote_compact_refreshes_stale_developer_instructions_without_resume, remote_compact_replaces_history_for_followups, remote_compact_rewrites_multiple_trailing_function_call_outputs, remote_compact_runs_automatically (+15 more)).


##### `remote_realtime_test_codex_builder`  (lines 171–180)

```
fn remote_realtime_test_codex_builder(
    realtime_server: &responses::WebSocketTestServer,
) -> TestCodexBuilder
```

**Purpose**: Creates a Codex test builder configured to talk to a fake realtime WebSocket server. It is used for tests where audio/realtime conversation state must survive compaction.

**Data flow**: It receives a WebSocket test server, reads its URL, starts from the standard builder, adds dummy API-key auth, stores the realtime URL in config, and returns the builder.

**Call relations**: Realtime snapshot tests call this after starting the fake realtime server and before building a Codex session.

*Call graph*: calls 3 internal fn (uri, test_codex, from_api_key); called by 6 (remote_request_uses_custom_experimental_realtime_start_instructions, snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start).


##### `start_remote_realtime_server`  (lines 182–200)

```
async fn start_remote_realtime_server() -> responses::WebSocketTestServer
```

**Purpose**: Starts a scripted fake realtime server for tests. The server sends a session-updated event and then stays open so later realtime transcript traffic does not end the session too early.

**Data flow**: It builds a list of WebSocket response batches, passes them to the test server helper, waits for the server to start, and returns it.

**Call relations**: All realtime compaction tests call this before creating their Codex builder, then shut the server down at the end.

*Call graph*: calls 1 internal fn (start_websocket_server); called by 6 (remote_request_uses_custom_experimental_realtime_start_instructions, snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start); 1 external calls (vec!).


##### `start_realtime_conversation`  (lines 202–240)

```
async fn start_realtime_conversation(codex: &codex_core::CodexThread) -> Result<()>
```

**Purpose**: Tells Codex to start a realtime conversation and waits until the session is actually established. This gives later compaction tests real realtime state to preserve or restate.

**Data flow**: It receives a Codex thread, submits a realtime-start operation, waits for a started event or error, then waits for the realtime session-updated event before returning success.

**Call relations**: Realtime tests call it before sending user input; it hands control back only after Codex and the fake realtime server agree that the realtime session exists.

*Call graph*: calls 1 internal fn (submit); called by 6 (remote_request_uses_custom_experimental_realtime_start_instructions, snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start); 2 external calls (wait_for_event_match, RealtimeConversationStart).


##### `close_realtime_conversation`  (lines 242–250)

```
async fn close_realtime_conversation(codex: &codex_core::CodexThread) -> Result<()>
```

**Purpose**: Closes a realtime conversation and waits for Codex to report that it closed. Tests use it to check how compaction records an inactive realtime session.

**Data flow**: It receives a Codex thread, submits a realtime-close operation, waits for the close event, and returns success.

**Call relations**: Realtime tests call it between user turns or during cleanup, then inspect later model requests for the expected realtime-end instructions.

*Call graph*: calls 1 internal fn (submit); called by 6 (remote_request_uses_custom_experimental_realtime_start_instructions, snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start); 1 external calls (wait_for_event_match).


##### `assert_request_contains_realtime_start`  (lines 252–262)

```
fn assert_request_contains_realtime_start(request: &responses::ResponsesRequest)
```

**Purpose**: Verifies that a model request restates the instructions for an active realtime conversation. This protects against compaction dropping realtime context.

**Data flow**: It receives a captured request, converts the JSON body to text, checks for the realtime wrapper, and checks that it does not contain the inactive-session reason.

**Call relations**: Tests for pre-turn and manual compaction call this on the post-compaction request when realtime is still active.

*Call graph*: calls 1 internal fn (body_json); called by 2 (snapshot_request_shape_remote_manual_compact_restates_realtime_start, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start); 1 external calls (assert!).


##### `assert_request_contains_custom_realtime_start`  (lines 264–281)

```
fn assert_request_contains_custom_realtime_start(
    request: &responses::ResponsesRequest,
    instructions: &str,
)
```

**Purpose**: Verifies that a request uses custom realtime-start instructions instead of the default wording. This tests an experimental configuration path.

**Data flow**: It receives a captured request and expected instruction text, converts the body to text, checks the realtime wrapper, checks for the custom text, and checks that default text is absent.

**Call relations**: The custom realtime instructions test calls this after starting realtime and sending one normal user turn.

*Call graph*: calls 1 internal fn (body_json); called by 1 (remote_request_uses_custom_experimental_realtime_start_instructions); 1 external calls (assert!).


##### `assert_request_contains_realtime_end`  (lines 283–293)

```
fn assert_request_contains_realtime_end(request: &responses::ResponsesRequest)
```

**Purpose**: Verifies that a model request restates that a realtime conversation became inactive. This matters because the model needs to know why realtime context stopped.

**Data flow**: It receives a captured request, turns its JSON body into text, checks for the realtime wrapper, and checks for the inactive reason.

**Call relations**: Realtime end and resume snapshot tests call this on requests that should carry closed-realtime instructions after compaction or resume.

*Call graph*: calls 1 internal fn (body_json); called by 3 (snapshot_request_shape_remote_compact_resume_restates_realtime_end, snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end, snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end); 1 external calls (assert!).


##### `wait_for_turn_complete`  (lines 295–302)

```
async fn wait_for_turn_complete(codex: &codex_core::CodexThread)
```

**Purpose**: Waits for Codex to finish a turn, with a longer timeout suitable for remote compaction tests. It keeps tests from racing ahead before the agent loop is done.

**Data flow**: It receives a Codex thread, waits until a `TurnComplete` event appears or the timeout expires, and returns after the event is observed.

**Call relations**: Many tests call this after submitting user input or a compact operation, before inspecting requests, events, or server call counts.

*Call graph*: called by 11 (assert_remote_manual_compact_request_parity, remote_compact_filters_deferred_dynamic_tools, remote_compact_replaces_history_for_followups, remote_compact_trims_tool_search_output_to_empty_tools_array, remote_compact_v2_accepts_additional_output_items_before_compaction, remote_compact_v2_retries_failures_with_stream_retry_budget, remote_compact_v2_reuses_compaction_trigger_for_followups, remote_mid_turn_compact_v1_sends_turn_state_over_http, remote_mid_turn_compact_v2_sends_turn_state_over_http, remote_mid_turn_compact_v2_sends_turn_state_over_websocket (+1 more)); 1 external calls (wait_for_event_with_timeout).


##### `remote_compact_replaces_history_for_followups`  (lines 305–530)

```
async fn remote_compact_replaces_history_for_followups() -> Result<()>
```

**Purpose**: Tests the core v1 manual compaction flow: old conversation history is sent to `/v1/responses/compact`, and later turns use the returned compacted history instead of the original messages.

**Data flow**: It builds an authenticated session, sends a user turn, triggers compact, sends a follow-up turn, then inspects headers, metadata, request body fields, and follow-up history contents.

**Call relations**: The test runner calls it directly. It relies on the standard builder, mocked SSE and compact endpoints, and `wait_for_turn_complete` to sequence the three phases.

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

**Purpose**: Shared helper that checks whether a manual compact request carries the same shared request settings as a normal model request. It also checks auth-specific service tier behavior.

**Data flow**: It receives auth, optional configured service tier, expected service tier, and snapshot labels; it runs five varied turns, compacts, removes fields that should differ, normalizes JSON, compares, and snapshots the diff.

**Call relations**: Two auth-focused tests call this: one for API-key auth and one for ChatGPT auth. It uses `canonical_json` and the standard turn-completion helper.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, canonical_json, test_codex, wait_for_turn_complete); called by 2 (remote_manual_compact_api_auth_omits_service_tier_and_reuses_prompt_cache_key, remote_manual_compact_chatgpt_auth_reuses_service_tier_and_prompt_cache_key); 4 external calls (default, assert_eq!, assert_snapshot!, vec!).


##### `remote_manual_compact_api_auth_omits_service_tier_and_reuses_prompt_cache_key`  (lines 768–782)

```
async fn remote_manual_compact_api_auth_omits_service_tier_and_reuses_prompt_cache_key() -> Result<()>
```

**Purpose**: Checks that API-key authenticated remote compaction reuses the prompt cache key but does not send a service tier. This prevents sending ChatGPT-only tier settings in API-key mode.

**Data flow**: It creates API-key auth, asks the shared parity helper to run the scenario, and expects no service tier in the compact request.

**Call relations**: The test runner calls it; most work is delegated to `assert_remote_manual_compact_request_parity`.

*Call graph*: calls 2 internal fn (assert_remote_manual_compact_request_parity, from_api_key); 1 external calls (skip_if_no_network!).


##### `remote_manual_compact_chatgpt_auth_reuses_service_tier_and_prompt_cache_key`  (lines 785–799)

```
async fn remote_manual_compact_chatgpt_auth_reuses_service_tier_and_prompt_cache_key() -> Result<()>
```

**Purpose**: Checks that ChatGPT-authenticated remote compaction reuses both the prompt cache key and the configured service tier. This confirms compact requests match normal ChatGPT request behavior.

**Data flow**: It creates dummy ChatGPT auth, calls the shared parity helper with the fast tier configured, and expects the outgoing service tier value used by the service.

**Call relations**: The test runner calls it; it delegates the full conversation and request comparison to `assert_remote_manual_compact_request_parity`.

*Call graph*: calls 2 internal fn (assert_remote_manual_compact_request_parity, create_dummy_chatgpt_auth_for_testing); 1 external calls (skip_if_no_network!).


##### `remote_compact_v2_reuses_compaction_trigger_for_followups`  (lines 802–937)

```
async fn remote_compact_v2_reuses_compaction_trigger_for_followups() -> Result<()>
```

**Purpose**: Tests RemoteCompactionV2, where compaction is sent as a normal `/v1/responses` request containing a compaction trigger item. It confirms the returned compaction item becomes part of follow-up history.

**Data flow**: It enables the v2 feature, sends an initial turn, triggers compact, sends a follow-up, then checks beta feature headers, compaction metadata, trigger shape, and retained history.

**Call relations**: The test runner calls it. It uses the standard builder with v2 enabled and waits between submitted operations before examining captured response requests.

*Call graph*: calls 5 internal fn (mount_sse_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, from_str, skip_if_no_network!, vec!).


##### `remote_compact_v2_retries_failures_with_stream_retry_budget`  (lines 940–1049)

```
async fn remote_compact_v2_retries_failures_with_stream_retry_budget() -> Result<()>
```

**Purpose**: Checks that v2 compaction retries failed streaming attempts using the stream retry budget. It also verifies that output from failed attempts is not kept.

**Data flow**: It scripts one normal turn, failed compact open, failed compact stream, successful compact retry, and follow-up turn; then it checks request count, trigger items, and final summary contents.

**Call relations**: The test runner calls it. It depends on response-sequence mocks and `wait_for_turn_complete` to exercise retry behavior inside the agent loop.

*Call graph*: calls 5 internal fn (mount_response_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 5 external calls (default, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `remote_compact_v2_accepts_additional_output_items_before_compaction`  (lines 1052–1139)

```
async fn remote_compact_v2_accepts_additional_output_items_before_compaction() -> Result<()>
```

**Purpose**: Ensures v2 compaction can ignore unrelated output items that appear before the actual compaction item. The final history should keep only the compaction result.

**Data flow**: It enables v2, scripts a noisy compact response containing an assistant message before the compaction item, runs initial, compact, and follow-up turns, then checks the follow-up body.

**Call relations**: The test runner calls it. It uses mocked SSE responses and the turn-completion helper to confirm the compact stream parser ignores noise.

*Call graph*: calls 5 internal fn (mount_sse_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 4 external calls (default, assert!, skip_if_no_network!, vec!).


##### `remote_compact_filters_deferred_dynamic_tools`  (lines 1142–1232)

```
async fn remote_compact_filters_deferred_dynamic_tools() -> Result<()>
```

**Purpose**: Tests that remote compact requests do not reveal deferred dynamic tools. Hidden tools should not become visible merely because Codex is compacting history.

**Data flow**: It starts a thread with one hidden and one visible dynamic tool, runs a user turn and compact, then compares the tools payloads and checks only the visible tool remains.

**Call relations**: The test runner calls it. It uses `assert_tools_payload_does_not_defer` and `namespace_child_tool_names` to inspect both normal and compact request bodies.

*Call graph*: calls 8 internal fn (mount_compact_json_once, mount_sse_once, sse, start_mock_server, assert_tools_payload_does_not_defer, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert_eq!, json!, json!, skip_if_no_network!, vec!).


##### `remote_compact_runs_automatically`  (lines 1235–1362)

```
async fn remote_compact_runs_automatically() -> Result<()>
```

**Purpose**: Checks that remote compaction runs automatically when token usage crosses the configured limit. It also verifies that mid-turn automatic compaction keeps the same turn ID but moves to a new context window afterward.

**Data flow**: It scripts an initial response with huge token usage, a compact response, and a continuation response; then it watches for compaction events and inspects request metadata and follow-up history.

**Call relations**: The test runner calls it. It uses the standard builder, mocked compact endpoint, and event waiting to observe automatic compaction inside one user turn.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 9 external calls (default, assert!, assert_eq!, assert_ne!, wait_for_event, wait_for_event_match, from_str, skip_if_no_network!, vec!).


##### `remote_compact_trims_function_call_history_to_fit_context_window`  (lines 1366–1487)

```
async fn remote_compact_trims_function_call_history_to_fit_context_window() -> Result<()>
```

**Purpose**: Tests that manual remote compaction preserves tool-call structure while trimming oversized trailing tool output. The call remains, but the huge output is replaced by a short truncation message.

**Data flow**: It runs two shell-call turns with a small context window, triggers compact, then inspects compact input for user messages, function calls, and rewritten output text.

**Call relations**: The test runner calls it on non-Windows platforms. It uses mocked shell command calls and a compact endpoint to verify history rewriting before remote compaction.

*Call graph*: calls 5 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `remote_compact_rewrites_multiple_trailing_function_call_outputs`  (lines 1491–1607)

```
async fn remote_compact_rewrites_multiple_trailing_function_call_outputs() -> Result<()>
```

**Purpose**: Tests the same trimming behavior when there are multiple trailing parallel tool calls. Every trailing oversized output should be rewritten, not just the first one.

**Data flow**: It creates one retained call and two later parallel calls, triggers compact, and checks that all calls remain while both later outputs become the truncation message.

**Call relations**: The test runner calls it on non-Windows platforms. It shares the same remote compact setup style as the single-call trimming test.

*Call graph*: calls 5 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `auto_remote_compact_trims_function_call_history_to_fit_context_window`  (lines 1611–1757)

```
async fn auto_remote_compact_trims_function_call_history_to_fit_context_window() -> Result<()>
```

**Purpose**: Checks that automatic remote compaction applies the same tool-output trimming rules as manual compaction. This prevents auto-compact requests from overflowing due to huge tool output.

**Data flow**: It runs prior turns with shell calls, triggers auto compaction through a later oversized turn, then inspects the compact request for retained calls and rewritten trailing output.

**Call relations**: The test runner calls it on non-Windows platforms. It combines response token thresholds with the same compact request assertions used in manual trimming tests.

*Call graph*: calls 5 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `remote_compact_trims_tool_search_output_to_empty_tools_array`  (lines 1760–1863)

```
async fn remote_compact_trims_tool_search_output_to_empty_tools_array() -> Result<()>
```

**Purpose**: Tests trimming for dynamic tool-search results. If a discovered tool description is too large, the compact request keeps the search-output item but empties its tools list.

**Data flow**: It creates an oversized deferred dynamic tool, scripts a tool-search call, runs a user turn, triggers compact, and checks that the compact request contains an empty tools array for that search output.

**Call relations**: The test runner calls it. It uses search-capable model configuration, dynamic tool setup, and the normal turn-completion helper.

*Call graph*: calls 7 internal fn (mount_compact_user_history_with_summary_once, mount_sse_once, sse, start_mock_server, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert!, format!, json!, Namespace, skip_if_no_network!, vec!).


##### `auto_remote_compact_failure_stops_agent_loop`  (lines 1866–1962)

```
async fn auto_remote_compact_failure_stops_agent_loop() -> Result<()>
```

**Purpose**: Ensures that if automatic remote compaction fails, Codex stops the current agent loop instead of continuing with unsafe or inconsistent history.

**Data flow**: It runs a turn that raises usage above the limit, scripts an invalid compact response for the next turn, waits for an error, and verifies no post-compact model request was made.

**Call relations**: The test runner calls it. It uses mocked SSE and compact endpoints, then snapshots the failed compact request shape.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 9 external calls (default, assert!, assert_eq!, wait_for_event, wait_for_event_match, assert_snapshot!, json!, skip_if_no_network!, vec!).


##### `remote_compact_trim_estimate_uses_session_base_instructions`  (lines 1966–2184)

```
async fn remote_compact_trim_estimate_uses_session_base_instructions() -> Result<()>
```

**Purpose**: Tests that compact-request size estimates include the session's base instructions. Large custom instructions should influence whether trailing tool output gets trimmed.

**Data flow**: It first captures a baseline compact request and estimates its size, then runs a second session with much larger base instructions and checks that trailing output is rewritten.

**Call relations**: The test runner calls it on non-Windows platforms. It uses `approx_token_count`, `estimate_compact_input_tokens`, and `estimate_compact_payload_tokens` to set up the comparison.

*Call graph*: calls 8 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, approx_token_count, estimate_compact_input_tokens, estimate_compact_payload_tokens, test_codex, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert!, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


##### `remote_manual_compact_emits_context_compaction_items`  (lines 2187–2265)

```
async fn remote_manual_compact_emits_context_compaction_items() -> Result<()>
```

**Purpose**: Checks that manual remote compaction emits structured start and completion events for a context-compaction item. These events let clients show compaction progress.

**Data flow**: It runs one user turn, submits compact, reads events until item-started, item-completed, legacy compaction, and turn-complete events arrive, then compares the item IDs.

**Call relations**: The test runner calls it. It combines a mocked compact response with direct event-loop inspection instead of only checking HTTP requests.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert!, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `remote_manual_compact_failure_emits_task_error_event`  (lines 2268–2327)

```
async fn remote_manual_compact_failure_emits_task_error_event() -> Result<()>
```

**Purpose**: Checks that a failed manual remote compact operation reports a useful task error. Users and clients should see that compaction failed and why.

**Data flow**: It runs a user turn, scripts an invalid compact payload, submits compact, waits for an error event, checks the error text, and confirms the compact endpoint was called once.

**Call relations**: The test runner calls it. It uses the same invalid-payload shape as some automatic-failure tests but focuses on manual compact event reporting.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, wait_for_event_match, json!, skip_if_no_network!, vec!).


##### `remote_compact_persists_replacement_history_in_rollout`  (lines 2333–2465)

```
async fn remote_compact_persists_replacement_history_in_rollout() -> Result<()>
```

**Purpose**: Intended to test that remote compaction replacement history is written to the rollout log, which is the saved record used for resume. It is currently ignored because the behavior is known to be changing.

**Data flow**: When enabled, it would run a turn, compact to a replacement history containing a summary and assistant note, shut down, read the rollout file, and look for the persisted compacted history.

**Call relations**: The test runner skips it because of the ignore annotation. It uses file reading and rollout parsing to validate persistence rather than only live request behavior.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, read_to_string, json!, skip_if_no_network!, vec!).


##### `remote_compact_and_resume_refresh_stale_developer_instructions`  (lines 2468–2618)

```
async fn remote_compact_and_resume_refresh_stale_developer_instructions() -> Result<()>
```

**Purpose**: Tests that stale developer instructions returned by remote compaction are removed both immediately and after session resume. Fresh developer instructions, such as permissions text, should be rebuilt.

**Data flow**: It runs a session, compacts to history containing stale developer text, sends another turn, shuts down, resumes from rollout, sends a resumed turn, and checks request bodies.

**Call relations**: The test runner calls it. It uses the standard builder before shutdown and another builder for resume, with mocked model responses covering before compact, after compact, and after resume.

*Call graph*: calls 4 internal fn (mount_compact_json_once, mount_sse_sequence, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!, start).


##### `remote_compact_refreshes_stale_developer_instructions_without_resume`  (lines 2621–2716)

```
async fn remote_compact_refreshes_stale_developer_instructions_without_resume() -> Result<()>
```

**Purpose**: Tests the immediate version of stale developer-instruction cleanup after remote compaction. It confirms Codex does not need a restart to refresh these instructions.

**Data flow**: It compacts to replacement history containing stale developer text, sends a follow-up turn in the same session, and checks that the stale text is absent while fresh permissions instructions and the compaction item are present.

**Call relations**: The test runner calls it. It is a shorter companion to the resume test and uses the same mocked compact output shape.

*Call graph*: calls 4 internal fn (mount_compact_json_once, mount_sse_sequence, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start`  (lines 2719–2808)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_start() -> Result<()>
```

**Purpose**: Snapshots the request shape when automatic pre-turn compaction happens while a realtime conversation is still active. The follow-up request should restate realtime-start instructions.

**Data flow**: It starts fake realtime, runs two user turns with a low compact threshold, captures the compact request and post-compact request, checks realtime-start text, and records a snapshot.

**Call relations**: The test runner calls it. It uses the realtime server helpers, start and close helpers, and the realtime-start assertion helper.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_start, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 8 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `remote_request_uses_custom_experimental_realtime_start_instructions`  (lines 2811–2858)

```
async fn remote_request_uses_custom_experimental_realtime_start_instructions() -> Result<()>
```

**Purpose**: Tests that configured experimental realtime-start instructions appear in ordinary model requests. This protects a customization path used by realtime integrations.

**Data flow**: It starts fake realtime with custom start text in config, sends one user turn, captures the request, and checks that custom text replaces the default text.

**Call relations**: The test runner calls it. It uses the realtime builder and `assert_request_contains_custom_realtime_start`.

*Call graph*: calls 7 internal fn (mount_sse_once, sse, assert_request_contains_custom_realtime_start, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 5 external calls (default, wait_for_event, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end`  (lines 2861–2951)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_restates_realtime_end() -> Result<()>
```

**Purpose**: Snapshots the request shape when pre-turn compaction happens after realtime has been closed between turns. The follow-up request should restate realtime-end instructions.

**Data flow**: It starts realtime, runs one turn, closes realtime, runs another turn that compacts first, then checks and snapshots the compact and post-compact requests.

**Call relations**: The test runner calls it. It uses realtime helpers and `assert_request_contains_realtime_end` to verify the closed-session marker.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_end, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 8 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_manual_compact_restates_realtime_start`  (lines 2954–3044)

```
async fn snapshot_request_shape_remote_manual_compact_restates_realtime_start() -> Result<()>
```

**Purpose**: Snapshots the request shape after a manual compact while realtime is active. The next normal turn should still tell the model that realtime is active.

**Data flow**: It starts realtime, sends a turn, manually compacts, sends another turn, then checks the post-compaction request for realtime-start instructions and snapshots both requests.

**Call relations**: The test runner calls it. It combines manual compaction with the shared realtime setup and assertion helpers.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_start, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 8 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end`  (lines 3047–3151)

```
async fn snapshot_request_shape_remote_mid_turn_compaction_does_not_restate_realtime_end() -> Result<()>
```

**Purpose**: Tests a subtle realtime case: if a turn already established that realtime is inactive before mid-turn compaction, the continuation after compaction should not restate the realtime-end message again.

**Data flow**: It starts and closes realtime, sends a turn that first includes realtime-end instructions, triggers mid-turn compaction through a tool call and high token count, then checks the continuation body.

**Call relations**: The test runner calls it. It uses realtime helpers, the realtime-end assertion on the pre-compaction request, and a snapshot of the compact and continuation layout.

*Call graph*: calls 7 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_end, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server); 9 external calls (default, assert!, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_compact_resume_restates_realtime_end`  (lines 3154–3260)

```
async fn snapshot_request_shape_remote_compact_resume_restates_realtime_end() -> Result<()>
```

**Purpose**: Snapshots behavior after manual compaction, shutdown, and resume when realtime had been closed. The resumed first turn should reconstruct and restate realtime-end instructions.

**Data flow**: It starts realtime, sends a turn, closes realtime, manually compacts, shuts down, resumes from rollout, sends another turn, and checks the resumed request body.

**Call relations**: The test runner calls it. It uses realtime helpers plus the standard resume path from the test builder.

*Call graph*: calls 9 internal fn (mount_compact_json_once, mount_sse_sequence, assert_request_contains_realtime_end, close_realtime_conversation, remote_realtime_test_codex_builder, start_realtime_conversation, start_remote_realtime_server, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!, start).


##### `snapshot_request_shape_remote_pre_turn_compaction_including_incoming_user_message`  (lines 3264–3361)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_including_incoming_user_message() -> Result<()>
```

**Purpose**: Documents current pre-turn compaction behavior with an incoming user message and context override. The compact request excludes the incoming user, while the follow-up request includes it once.

**Data flow**: It runs three user turns, adds a thread-settings context override before the third, lets pre-turn compaction happen, snapshots compact and follow-up requests, and counts the incoming user text in the follow-up.

**Call relations**: The test runner calls it. It uses `summary_with_prefix`, local environment selections, and request snapshots to pin down current behavior.

*Call graph*: calls 7 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, local_selections, summary_with_prefix, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert_eq!, submit_thread_settings, test_path_buf, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_pre_turn_compaction_strips_incoming_model_switch`  (lines 3364–3498)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_strips_incoming_model_switch() -> Result<()>
```

**Purpose**: Documents current behavior when pre-turn compaction happens during a model switch. The compact request strips the incoming model-switch marker, but the follow-up request restores it.

**Data flow**: It starts on one model, sends a turn, submits a model-switch setting, sends another turn that triggers compaction, then checks and snapshots initial, compact, and follow-up requests.

**Call relations**: The test runner calls it. It uses `summary_with_prefix`, thread-settings submission, and mocked requests for both models.

*Call graph*: calls 7 internal fn (mount_compact_user_history_with_summary_once, mount_sse_once, sse, with_builder, summary_with_prefix, test_codex, create_dummy_chatgpt_auth_for_testing); 8 external calls (default, assert!, assert_eq!, submit_thread_settings, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_pre_turn_compaction_context_window_exceeded`  (lines 3503–3606)

```
async fn snapshot_request_shape_remote_pre_turn_compaction_context_window_exceeded() -> Result<()>
```

**Purpose**: Tests that a context-window error from the remote compact endpoint stops the turn and surfaces an error. It also snapshots the compact request that caused the failure.

**Data flow**: It runs an initial high-token turn, scripts the compact endpoint to return a context-length error on the next turn, waits for the error, confirms no follow-up request ran, and snapshots the compact request.

**Call relations**: The test runner calls it. It uses a mocked HTTP error response and standard event waiting to confirm failure handling.

*Call graph*: calls 7 internal fn (mount_compact_response_once, mount_sse_once, mount_sse_sequence, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 10 external calls (default, new, assert!, assert_eq!, wait_for_event, wait_for_event_match, assert_snapshot!, json!, skip_if_no_network!, vec!).


##### `remote_pre_turn_compact_response_seeds_turn_state`  (lines 3609–3679)

```
async fn remote_pre_turn_compact_response_seeds_turn_state() -> Result<()>
```

**Purpose**: Checks that a pre-turn compact response can provide turn state, and that state is sent on the first model request after compaction. Turn state is a server-provided header that must travel with later requests in the same turn.

**Data flow**: It runs one turn to exceed the threshold, scripts compact to return a turn-state header, runs the next turn, and checks that the compact request starts without state while the post-compact sample sends the returned state.

**Call relations**: The test runner calls it. It uses response-sequence mocks and `wait_for_turn_complete` to observe header flow across compact and sampling requests.

*Call graph*: calls 6 internal fn (mount_compact_response_once, mount_response_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, new, assert_eq!, json!, skip_if_no_network!, vec!).


##### `remote_mid_turn_compact_v1_sends_turn_state_over_http`  (lines 3682–3762)

```
async fn remote_mid_turn_compact_v1_sends_turn_state_over_http() -> Result<()>
```

**Purpose**: Tests turn-state propagation for v1 mid-turn compaction over HTTP. The state created by the first sample should be replayed to compact and all later requests in that turn.

**Data flow**: It scripts an initial tool-call response that returns turn state, a compact response, and continuations; after the turn completes, it checks the turn-state header on compact and later model requests.

**Call relations**: The test runner calls it. It uses the v1 compact endpoint and verifies that later response headers do not replace the first established state.

*Call graph*: calls 6 internal fn (mount_compact_response_once, mount_response_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, new, assert_eq!, json!, skip_if_no_network!, vec!).


##### `remote_mid_turn_compact_v2_sends_turn_state_over_http`  (lines 3765–3857)

```
async fn remote_mid_turn_compact_v2_sends_turn_state_over_http() -> Result<()>
```

**Purpose**: Tests turn-state propagation for v2 mid-turn compaction over ordinary HTTP responses. The v2 compaction request should be a normal `/v1/responses` request carrying the existing state.

**Data flow**: It enables v2, scripts sampling, inline compaction, continuations, and final reply, then checks that every request after the first carries the original turn-state header.

**Call relations**: The test runner calls it. It uses `wait_for_turn_complete` and captured response requests rather than the separate v1 compact endpoint.

*Call graph*: calls 5 internal fn (mount_response_sequence, with_builder, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 5 external calls (default, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `remote_mid_turn_compact_v2_sends_turn_state_over_websocket`  (lines 3860–3955)

```
async fn remote_mid_turn_compact_v2_sends_turn_state_over_websocket() -> Result<()>
```

**Purpose**: Tests the same v2 turn-state propagation when model traffic goes over WebSocket. In WebSocket mode, the state is carried in client metadata instead of an HTTP header.

**Data flow**: It starts a scripted WebSocket server, enables v2, sends a user turn, then reads all WebSocket request bodies and checks the client metadata values before and after compaction.

**Call relations**: The test runner calls it. It uses `start_websocket_server`, the WebSocket-capable builder, and the normal turn-completion helper.

*Call graph*: calls 4 internal fn (start_websocket_server, test_codex, wait_for_turn_complete, create_dummy_chatgpt_auth_for_testing); 5 external calls (default, assert!, assert_eq!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_mid_turn_continuation_compaction`  (lines 3958–4027)

```
async fn snapshot_request_shape_remote_mid_turn_continuation_compaction() -> Result<()>
```

**Purpose**: Snapshots the normal v1 mid-turn compaction layout after a tool call. The compact request should include tool artifacts, and the continuation should include the returned compaction item.

**Data flow**: It sends one user turn that produces a function call and high token usage, lets remote compaction run before continuation, then snapshots the compact request and post-compaction request.

**Call relations**: The test runner calls it. It uses `summary_with_prefix`, a mocked compact endpoint, and request snapshots.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_once, mount_sse_sequence, with_builder, summary_with_prefix, test_codex, create_dummy_chatgpt_auth_for_testing); 6 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_mid_turn_compaction_summary_only_reinjects_context`  (lines 4030–4114)

```
async fn snapshot_request_shape_remote_mid_turn_compaction_summary_only_reinjects_context() -> Result<()>
```

**Purpose**: Tests that when remote compact returns only a summary item, Codex reinjects necessary context before continuing the same turn. This keeps the model oriented after history replacement.

**Data flow**: It scripts a tool-call turn that triggers compaction, returns a summary-only compact output, captures the continuation request, and snapshots compact plus continuation layouts.

**Call relations**: The test runner calls it. It uses mocked SSE endpoints and direct compact JSON output instead of the summary helper endpoint.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_mid_turn_compaction_multi_summary_reinjects_above_last_summary`  (lines 4117–4227)

```
async fn snapshot_request_shape_remote_mid_turn_compaction_multi_summary_reinjects_above_last_summary() -> Result<()>
```

**Purpose**: Tests history layout when there is already an older compaction summary and a later auto-compaction creates a new one. Context should be reinjected above the latest summary in the next request.

**Data flow**: It runs a setup turn, manually compacts to create an older summary, runs another turn that triggers auto-compaction, then checks that the compact request carries the older summary and snapshots the next request.

**Call relations**: The test runner calls it. It uses a compact-summary sequence and compares both compact request history and the second-turn request layout.

*Call graph*: calls 6 internal fn (mount_compact_user_history_with_summary_sequence, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert!, assert_eq!, wait_for_event, assert_snapshot!, skip_if_no_network!, vec!).


##### `snapshot_request_shape_remote_manual_compact_without_previous_user_messages`  (lines 4230–4285)

```
async fn snapshot_request_shape_remote_manual_compact_without_previous_user_messages() -> Result<()>
```

**Purpose**: Tests that manual compact does nothing remotely when there is no prior user turn to summarize. The next real user turn should proceed with normal context.

**Data flow**: It submits compact before any user message, waits for completion, sends the first user turn, confirms no compact request was made, and snapshots the normal follow-up request.

**Call relations**: The test runner calls it. It uses mocked compact and model endpoints to prove the compact endpoint remains unused in the empty-history case.

*Call graph*: calls 6 internal fn (mount_compact_json_once, mount_sse_once, sse, with_builder, test_codex, create_dummy_chatgpt_auth_for_testing); 7 external calls (default, assert_eq!, wait_for_event, assert_snapshot!, json!, skip_if_no_network!, vec!).


### `core/tests/suite/responses_lite.rs`

`test` · `test run`

These are integration-style tests: they start a fake Responses API server, run a small Codex instance against it, then inspect the HTTP request Codex sent. The goal is to protect the contract between Codex and the Responses API. If this file were missing, Codex could accidentally send the wrong request shape for Responses Lite and nobody would notice until real API calls failed or tools appeared in the wrong form.

Responses Lite is treated differently from the normal Responses transport. For example, it adds a special request header, uses standalone extension tools for web search and image generation instead of hosted API tools, and slightly changes compaction requests. The tests act like a customs checkpoint: they do not care how Codex internally packed the suitcase, but they open the outgoing request and verify that the right items are inside and the wrong ones are absent.

The helper functions build a test extension registry, turn on or off relevant feature flags, make a model accept image input, and search JSON tool lists. Each test then sets up a mock server response, configures a test Codex model, submits user input or a compact operation, waits for completion, and asserts on the captured request.

#### Function details

##### `responses_extensions`  (lines 27–33)

```
fn responses_extensions(auth: &CodexAuth) -> Arc<ExtensionRegistry<Config>>
```

**Purpose**: Builds the standalone web search and image generation extensions needed by some tests. This lets the tests check whether Responses Lite exposes those tools as local extension tools rather than as hosted API tools.

**Data flow**: It takes a test authentication object, turns it into an authentication manager, creates a new extension registry builder, installs the web search and image generation extensions into that builder, and returns the finished registry wrapped in shared ownership so the test Codex instance can use it.

**Call relations**: The two tool-related tests call this helper when they need real standalone extensions available. Inside, it hands authentication to the extension installers, so later request-building code can advertise those extensions as callable tools.

*Call graph*: calls 1 internal fn (auth_manager_from_auth); called by 2 (non_lite_uses_hosted_tools_when_standalone_features_are_disabled, responses_lite_uses_standalone_web_search_and_image_generation); 6 external calls (clone, new, new, install, install, clone).


##### `configure_responses_tools`  (lines 35–45)

```
fn configure_responses_tools(config: &mut Config)
```

**Purpose**: Sets the feature switches so the tests exercise the intended tool behavior. It enables live web search and image generation while disabling feature paths that would hide the behavior being tested.

**Data flow**: It receives a mutable Codex configuration, changes web search mode to live, disables the standalone web search feature flag, enables image generation, and disables the image generation extension flag. It does not return a value; the configuration is changed in place.

**Call relations**: Tests pass this function into the test Codex builder during setup. The builder applies it before running a turn, so the outgoing request reflects this carefully chosen mix of enabled and disabled tool features.

*Call graph*: 1 external calls (assert!).


##### `configure_image_capable_model`  (lines 47–49)

```
fn configure_image_capable_model(model_info: &mut codex_protocol::openai_models::ModelInfo)
```

**Purpose**: Marks a test model as able to accept both text and images. The image-related tests need this so Codex is allowed to send image input to the Responses API.

**Data flow**: It receives mutable model information and replaces the model’s input modality list with text and image. It returns nothing; the model description is updated in place.

**Call relations**: Several tests use this as a model override while building the test Codex instance. That setup step makes later image and image-generation request checks meaningful, because the model is declared image-capable.

*Call graph*: 1 external calls (vec!).


##### `has_hosted_tool`  (lines 51–55)

```
fn has_hosted_tool(tools: &[Value], tool_type: &str) -> bool
```

**Purpose**: Checks whether a JSON list of tools contains a hosted API tool of a given type. This is used to confirm that Responses Lite omits hosted tools, while the non-lite path includes them.

**Data flow**: It receives a slice of JSON tool objects and a tool type string. It scans each tool, reads its `type` field if present, and returns true if any tool’s type matches the requested value; otherwise it returns false.

**Call relations**: The tests call this after capturing an outgoing request body. It is the small inspection tool that turns a raw JSON array into a clear yes-or-no answer about whether hosted web search or hosted image generation was sent.

*Call graph*: 1 external calls (iter).


##### `responses_lite_strips_data_image_detail_without_resize_all_images`  (lines 58–111)

```
async fn responses_lite_strips_data_image_detail_without_resize_all_images() -> Result<()>
```

**Purpose**: Verifies that Responses Lite sends a data URL image without including the image `detail` field when no resizing is being done. This protects a subtle request-shape rule for inline images.

**Data flow**: The test skips itself if network-dependent tests are unavailable, starts a mock server, prepares a fake streaming response, and builds a test Codex model with Responses Lite and image input enabled. It submits an image-only user input with `Original` detail, waits for the turn to finish, then opens the captured request and checks that the image item contains only `type` and `image_url`, not the original detail setting.

**Call relations**: This test uses the mock Responses server and the `test_codex` builder to drive Codex through a real request path. After `wait_for_event` confirms the turn is complete, it inspects the request that the mock server recorded and uses an equality assertion to lock down the exact outgoing JSON shape.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


##### `responses_lite_uses_standalone_web_search_and_image_generation`  (lines 114–162)

```
async fn responses_lite_uses_standalone_web_search_and_image_generation() -> Result<()>
```

**Purpose**: Checks that Responses Lite advertises web search and image generation as standalone extension tools, not as hosted tools inside the Responses API request. It also verifies the special Responses Lite header is present.

**Data flow**: The test starts a mock server and fake streaming response, creates dummy ChatGPT authentication, builds the extension registry, and configures a Responses Lite, image-capable test model with the relevant tool settings. It submits a user turn, captures the outgoing request, checks the lite header, confirms the standalone `web/run` and `image_gen/imagegen` tools are present, then verifies the JSON tool list does not include hosted `web_search` or `image_generation` entries.

**Call relations**: This test calls `responses_extensions` to make standalone tools available and uses `configure_responses_tools` during Codex setup. After the request is captured, it relies on request helper methods and `has_hosted_tool` to prove that the lite path chose standalone tools over hosted ones.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, responses_extensions, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `responses_lite_compact_request_uses_lite_transport_contract`  (lines 165–217)

```
async fn responses_lite_compact_request_uses_lite_transport_contract() -> Result<()>
```

**Purpose**: Verifies that conversation compaction also follows the Responses Lite transport rules. Compaction means asking the model to shrink or summarize prior conversation context so later turns can continue efficiently.

**Data flow**: The test starts a mock server with one normal streaming response and one compact JSON response. It builds a Responses Lite model that supports parallel tool calls, disables a remote compaction feature flag, sends a normal turn, then submits a compact operation. After completion, it captures the compact request and checks that the lite header is set, the reasoning context is `all_turns`, and `parallel_tool_calls` is explicitly false.

**Call relations**: This test drives both the ordinary turn path and the compaction path through the test Codex instance. It uses the mock server’s separate compact endpoint capture to inspect the special compaction request rather than the earlier normal response request.

*Call graph*: calls 5 internal fn (mount_compact_json_once, mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `responses_lite_omits_hosted_tools_without_standalone_extensions`  (lines 220–252)

```
async fn responses_lite_omits_hosted_tools_without_standalone_extensions() -> Result<()>
```

**Purpose**: Checks that Responses Lite does not fall back to hosted web search or hosted image generation when standalone extensions are not installed. This prevents Codex from silently exposing the wrong kind of tools.

**Data flow**: The test starts a mock server, creates dummy authentication, configures a Responses Lite image-capable model, and applies the same tool feature settings as the other tool tests, but does not install standalone extensions. It submits a user turn, reads the captured request body, extracts the tools array, and confirms that hosted `web_search` and `image_generation` are both absent.

**Call relations**: This test is the companion to the standalone-extension test. Instead of calling `responses_extensions`, it leaves the extension registry out, then uses `has_hosted_tool` to verify that the request builder did not compensate by adding hosted tools.

*Call graph*: calls 5 internal fn (mount_sse_once, sse, start_mock_server, test_codex, create_dummy_chatgpt_auth_for_testing); 3 external calls (assert!, skip_if_no_network!, vec!).


##### `non_lite_uses_hosted_tools_when_standalone_features_are_disabled`  (lines 255–291)

```
async fn non_lite_uses_hosted_tools_when_standalone_features_are_disabled() -> Result<()>
```

**Purpose**: Confirms the normal, non-lite Responses path still uses hosted web search and hosted image generation when the standalone feature paths are disabled. This makes sure the special Responses Lite behavior does not leak into the regular transport.

**Data flow**: The test starts a mock server, creates dummy authentication, installs standalone extensions, configures an image-capable model without turning on Responses Lite, and applies the same tool settings. It submits a user turn, captures the request, verifies the lite header is missing, confirms standalone extension tool entries are absent, and checks that hosted `web_search` and `image_generation` entries are present in the JSON tools array.

**Call relations**: This test calls `responses_extensions`, but because the model is not marked as Responses Lite, the expected request shape is different. It acts as a control case for the lite-specific tests, proving that hosted tools are still used on the regular path.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, test_codex, responses_extensions, create_dummy_chatgpt_auth_for_testing); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


### `core/tests/suite/turn_state.rs`

`test` · `test execution`

A “turn” is one round of interaction with the assistant: the user asks something, the model may request a tool like a shell command, and Codex may need to call the model again with the tool result. This file makes sure a special value called turn state behaves like a sticky note for that one round only. If the server sends this value, Codex should attach it to later follow-up requests in the same turn, so the server can keep its place. But Codex must not accidentally carry it into the next user turn, because that would mix two separate conversations.

The tests use fake servers instead of the real model service. The fake server sends carefully chosen event streams: a response is created, sometimes a shell command is requested, and then the response completes. The tests then inspect what Codex sent back to the server. They check that the first request starts without turn state, follow-up requests in the same turn include it, and the next new turn starts clean again.

The file also checks WebSocket behavior, where several logical requests can share one long-lived network connection. That is important because reusing the same connection must not mean reusing stale turn state.

#### Function details

##### `responses_turn_state_persists_within_turn_and_resets_after`  (lines 24–89)

```
async fn responses_turn_state_persists_within_turn_and_resets_after() -> Result<()>
```

**Purpose**: This test checks turn state when Codex talks to the model through streamed responses. It proves that a turn state header sent by the server is reused for a follow-up request in the same turn, but is not sent on the first request of the next turn.

**Data flow**: The test starts a mock server and gives it three prepared responses. The first response includes the turn state header and asks Codex to run a shell command, which causes a same-turn follow-up request. The second response finishes that first turn, and the third response is for a new user turn. After submitting two user turns, the test reads the mock server’s request log and checks the headers: no turn state on the first request, the saved value on the follow-up, and no turn state on the new turn. It also reads each request’s turn metadata and checks that the first two requests share the same turn id while the third has a different one.

**Call relations**: The test builds its fake response sequence with the server-response helpers, mounts that sequence on a mock server, then creates a test Codex client with test_codex. When submit_turn is called, Codex drives the normal request flow against the mock server. The final assertions compare what the fake server received with the expected turn-state behavior.

*Call graph*: calls 4 internal fn (mount_response_sequence, sse, start_mock_server, test_codex); 4 external calls (assert_eq!, assert_ne!, skip_if_no_network!, vec!).


##### `websocket_turn_state_persists_within_turn_and_resets_after`  (lines 92–145)

```
async fn websocket_turn_state_persists_within_turn_and_resets_after() -> Result<()>
```

**Purpose**: This test checks the same turn-state rule over a WebSocket connection, which is a single reusable two-way connection. It makes sure state is carried across same-turn follow-ups but cleared for the next user turn, even though the physical connection stays open.

**Data flow**: The test starts a fake WebSocket server with three prepared request/response phases. In the first phase, the server sends metadata containing the turn state and asks for a shell command. In the second phase, Codex sends a follow-up request on the same turn and should include that turn state. In the third phase, Codex starts a new user turn and should send no turn state. The test then inspects the messages received on the single WebSocket connection and expects the client metadata values to be null, then "ts-1", then null.

**Call relations**: The WebSocket fake server supplies the scripted responses, and test_codex builds a Codex client pointed at that server. The two submit_turn calls make Codex produce three model requests: the original turn, the tool follow-up, and the next turn. The test then checks the server’s recorded connection and shuts it down.

*Call graph*: calls 2 internal fn (start_websocket_server_with_headers, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `websocket_turn_state_is_stable_within_turn`  (lines 148–203)

```
async fn websocket_turn_state_is_stable_within_turn() -> Result<()>
```

**Purpose**: This test checks that once Codex has chosen a turn state for a turn, it keeps using that original value for the rest of that turn. If a later same-turn response tries to provide a different value, Codex does not switch to it.

**Data flow**: The fake WebSocket server is scripted for one user turn that needs two shell-command follow-ups. The first response sends turn state "ts-1" and requests a shell command. The second response sends a different turn state, "ts-2", and requests another shell command. The third response completes the turn. After one submitted user turn, the test reads the recorded WebSocket requests and checks the client metadata: the first request has no turn state, the first follow-up has "ts-1", and the second follow-up still has "ts-1" rather than the later "ts-2".

**Call relations**: The test uses the WebSocket test server to imitate a model service that changes its metadata mid-turn. The Codex test client runs through the scripted turn with submit_turn. The assertions confirm that Codex treats the first turn-state value like the fixed label for that turn, rather than updating it whenever later metadata arrives.

*Call graph*: calls 2 internal fn (start_websocket_server_with_headers, test_codex); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


### Streaming resilience and fallback
These regression suites verify retry, recovery, and transport fallback behavior when streamed responses are incomplete or fail.

### `core/tests/suite/stream_error_allows_next_turn.rs`

`test` · `test run`

This file is a safety test for a frustrating failure case: the model service starts a turn, something goes wrong, and the app must still be ready for the next user request. Without this behavior, one bad network or server response could leave the conversation "busy" forever, like a door that never unlocks after someone fails to enter.

The test creates a fake HTTP server instead of talking to a real model provider. The first mocked model request, containing "first message", returns an HTTP 500 error with a JSON error body. That simulates the provider rejecting or failing the request. The provider configuration points Codex at this fake server and uses the Responses API, with retry limits set so the test stays predictable.

Codex then receives the first user message. The test waits until Codex reports an error, and then waits for a TurnComplete event. That second event is important: it means Codex has cleaned up the failed turn and released the session.

Next, the test sends a second user message, "follow up". This time the fake server returns a successful server-sent events stream, which is a standard way for servers to send response updates over one HTTP connection. The test passes only if Codex accepts this second turn and completes it. In short, the file guards against stream errors poisoning the whole conversation.

#### Function details

##### `continue_after_stream_error`  (lines 21–132)

```
async fn continue_after_stream_error()
```

**Purpose**: This asynchronous test verifies that after a model response stream fails, Codex still finishes the turn internally and allows a later user message to run normally. It is used to catch regressions where an error leaves the session locked or permanently busy.

**Data flow**: The test starts with a fake model server and two planned responses: one failing response for a prompt containing "first message", and one successful streaming response for a prompt containing "follow up". It builds a test Codex instance configured to use that fake server, submits the first message, and observes that Codex emits both an error and a turn-complete signal. Then it submits the second message and checks that this new turn completes successfully. The visible result is not a returned value, but proof through events and mock-server expectations that Codex recovered cleanly.

**Call relations**: This function is the whole test scenario. It calls test helpers to start the mock server, create fake HTTP responses, build a TestCodex instance, submit user input, and wait for Codex events. The first half drives Codex into a controlled stream failure; the second half asks Codex to continue, showing that the earlier failure did not block the normal turn flow.

*Call graph*: calls 2 internal fn (sse, test_codex); 12 external calls (default, given, start, new, wait_for_event, format!, json!, skip_if_no_network!, vec!, body_string_contains (+2 more)).


### `core/tests/suite/stream_no_completed.rs`

`test` · `test run`

This file tests a failure case in server-sent events, often called SSE: a way for a server to send a live stream of messages over one HTTP connection. The important rule here is that a model response is not truly finished until the stream includes a `response.completed` event. Without that final marker, Codex could wrongly treat a cut-off answer as complete, or fail instead of retrying.

The test builds a tiny fake streaming server. On the first request, the server sends an incomplete stream: it reports that one output item is done, but never sends the final completion event. On the second request, it sends a proper completed response. The test then configures a `TestCodex` instance to use this fake server and to allow one retry for streaming failures.

After submitting a simple user message, the test waits for Codex to announce that the turn is complete. That proves the retry worked: Codex noticed the first stream was incomplete, made another request, and accepted the completed second stream. Finally, the test checks that the fake server received exactly two requests, like checking a delivery log to confirm the first damaged package was replaced by a second good one.

#### Function details

##### `sse_incomplete`  (lines 17–21)

```
fn sse_incomplete() -> String
```

**Purpose**: Builds a fake SSE response that is intentionally missing the final completion event. The test uses it to simulate a server connection that ends too early.

**Data flow**: It takes no input. It creates a small JSON event saying an output item is done, wraps that event in the project’s SSE text format, and returns the resulting string. The returned stream looks plausible but is deliberately unfinished.

**Call relations**: The main test, `retries_on_early_close`, calls this helper while setting up the fake server. Its output becomes the body of the first server response, which is meant to trigger Codex’s retry path.

*Call graph*: calls 1 internal fn (sse); called by 1 (retries_on_early_close); 1 external calls (vec!).


##### `retries_on_early_close`  (lines 24–102)

```
async fn retries_on_early_close()
```

**Purpose**: Runs the full test scenario: first the fake server sends an incomplete stream, then it sends a completed one, and Codex should retry and finish the turn. This proves the streaming retry behavior works for early connection closes.

**Data flow**: It starts by skipping the test if networking is unavailable. It then creates two response bodies: one incomplete and one completed. It launches a fake streaming server that serves those responses in order. Next it builds a Codex test instance configured to talk to that server and to allow one stream retry. It submits a simple user message, waits until Codex reports the turn is complete, then reads the server’s request log and asserts that exactly two requests were made. At the end, it shuts the fake server down.

**Call relations**: This is the async test function run by the test framework. During setup it calls `sse_incomplete` for the broken first stream, `sse_completed` for the successful second stream, `start_streaming_sse_server` to create the fake server, and `test_codex` to build a Codex instance pointed at that server. During the test it submits user input to Codex, then uses `wait_for_event` to observe successful completion before checking the server request count.

*Call graph*: calls 4 internal fn (sse_completed, start_streaming_sse_server, test_codex, sse_incomplete); 6 external calls (default, assert_eq!, wait_for_event, format!, skip_if_no_network!, vec!).


### `core/tests/suite/websocket_fallback.rs`

`test` · `test run`

Codex can talk to the model provider in two ways: through WebSockets, which are long-lived connections for streaming messages, or through HTTP, the more ordinary request-and-response path. This test file checks the safety net between those two paths. If WebSockets fail, Codex should not get stuck retrying forever or show confusing errors. It should switch to HTTP and keep the conversation working.

Each test starts a fake model server. The fake server records what Codex tried to do and can return scripted streaming responses using SSE, short for Server-Sent Events, which is a simple HTTP streaming format. The tests configure Codex to believe the provider supports WebSockets, then deliberately make WebSocket attempts fail or run out of retries. After a user turn is submitted, the tests count whether Codex used GET requests for WebSocket attempts and POST requests for HTTP fallback.

The important behavior is that fallback is practical and user-friendly. A special “upgrade required” response should make Codex switch immediately. Ordinary WebSocket failures should be retried only up to the configured limit. The first retry error may be hidden in some builds to avoid noisy output. Once HTTP fallback is chosen, it should be “sticky,” like choosing a backup road after finding the main bridge closed: later turns should keep using the working route.

#### Function details

##### `websocket_fallback_switches_to_http_on_upgrade_required_connect`  (lines 30–79)

```
async fn websocket_fallback_switches_to_http_on_upgrade_required_connect() -> Result<()>
```

**Purpose**: This test checks the fastest fallback path. If the fake server answers a WebSocket connection attempt with HTTP 426, meaning “upgrade required,” Codex should treat that as a signal to stop trying WebSockets and use HTTP instead.

**Data flow**: The test starts a mock server, teaches it to reject WebSocket-style GET requests to the responses endpoint with status 426, and prepares one successful HTTP streaming response. It then builds a Codex test session configured for the Responses API with WebSockets enabled. After submitting the text “hello,” it reads the mock server’s recorded requests and counts WebSocket GET attempts and HTTP POST attempts. The expected result is one WebSocket attempt, one HTTP fallback request, and one consumed response.

**Call relations**: The async test runner calls this function as a standalone integration test. Inside it, the test support helpers create the fake server, mount the scripted SSE response, build a configured TestCodex instance, and submit a user turn. The final assertions connect the whole story: the mock server’s request log proves that Codex switched transport immediately instead of retrying the failed WebSocket handshake.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 8 external calls (given, new, assert_eq!, format!, skip_if_no_network!, vec!, method, path_regex).


##### `websocket_fallback_switches_to_http_after_retries_exhausted`  (lines 82–124)

```
async fn websocket_fallback_switches_to_http_after_retries_exhausted() -> Result<()>
```

**Purpose**: This test checks the normal failure path. When WebSocket streaming keeps failing, Codex should retry only the allowed number of times and then replay the same request over HTTP.

**Data flow**: The test starts a mock server and mounts a single successful SSE response for the eventual HTTP path. It configures Codex with WebSocket support enabled, two stream retries, and no extra HTTP request retries. After sending “hello,” it inspects the mock server’s recorded traffic. The before-and-after story is: Codex first tries WebSockets, fails enough times to exhaust its retry budget, then sends one HTTP POST that receives the prepared response.

**Call relations**: The test runner invokes this function, and the function uses the shared test harness to stand up the mock provider and Codex session. The mounted SSE response is handed to the HTTP fallback path after the WebSocket attempts fail. The assertions verify that the retry policy and fallback machinery worked together: startup made one prewarm WebSocket attempt, the turn made the configured stream attempts, and only then did HTTP take over.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 4 external calls (assert_eq!, format!, skip_if_no_network!, vec!).


##### `websocket_fallback_hides_first_websocket_retry_stream_error`  (lines 127–206)

```
async fn websocket_fallback_hides_first_websocket_retry_stream_error() -> Result<()>
```

**Purpose**: This test checks what the user sees while WebSocket fallback is happening. It makes sure Codex does not always expose every early retry failure as a stream error message, which would make a recoverable problem look scarier than it is.

**Data flow**: The test starts a mock server, prepares one successful HTTP SSE response, and builds a Codex session configured to try WebSockets first. Instead of using the higher-level helper for a turn, it submits a detailed user input operation with permission and environment settings, then listens to Codex events until the turn completes. It collects only StreamError messages, compares them with the expected reconnect messages for the build type, and confirms the HTTP fallback response was used once.

**Call relations**: The async test runner calls this function. The function relies on support helpers to create local environment selections, permission fields, the fake server, the SSE response, and the Codex test session. It then talks directly to the Codex event stream, which lets the test observe the user-facing messages produced during retries. The final comparison ties retry behavior to user experience: Codex may reconnect in the background, but the event stream should show only the intended retry notices before successful fallback.

*Call graph*: calls 6 internal fn (mount_sse_once, sse, start_mock_server, local_selections, test_codex, turn_permission_fields); 9 external calls (default, from_secs, new, assert_eq!, cfg!, format!, skip_if_no_network!, timeout, vec!).


##### `websocket_fallback_is_sticky_across_turns`  (lines 209–256)

```
async fn websocket_fallback_is_sticky_across_turns() -> Result<()>
```

**Purpose**: This test checks that once Codex has fallen back from WebSockets to HTTP, it keeps using HTTP for later turns in the same session. That avoids wasting time repeatedly trying a connection style that already failed.

**Data flow**: The test starts a mock server and mounts two scripted SSE responses, one for each HTTP turn. It builds a Codex session with WebSockets enabled and a limited WebSocket retry budget. It submits a first message and then a second message. After both finish, it counts the recorded WebSocket GET requests and HTTP POST requests. The expected result is that all WebSocket attempts happened during startup and the first turn, while both actual turns were completed through HTTP.

**Call relations**: The test runner invokes this function as an integration test. The mock server and response sequence provide two successful HTTP fallback replies, while the TestCodex helper drives two user turns. The assertions show how this test fits into the larger fallback story: earlier tests prove Codex can switch to HTTP, and this one proves that the switch becomes session state rather than a one-time workaround.

*Call graph*: calls 3 internal fn (mount_sse_sequence, start_mock_server, test_codex); 4 external calls (assert_eq!, format!, skip_if_no_network!, vec!).


### Provider protocol edge cases
These tests validate provider-facing protocol details around proxy identity, quota failures, and safety-triggered rerouting or downgrade signals.

### `core/tests/suite/responses_api_proxy_headers.rs`

`test` · `test run`

This file is a focused integration test for collaboration-style agent spawning. In plain terms, it starts a fake Responses API server, asks Codex to run a parent prompt, makes that parent prompt spawn a child agent, and then inspects the HTTP requests that Codex sent. The important question is: can the outside API tell which request came from the main agent and which came from the spawned subagent?

The test sets up three fake streamed responses: the first parent response tells Codex to call the subagent-spawning tool, the child response says it is done, and the final parent response reports completion. Then the test submits the parent prompt to a real test Codex session and waits until the turn finishes.

After that, it examines the captured requests. The parent request must not carry the subagent identity header. The child request must carry `x-openai-subagent: collab_spawn`, must have its own thread identifier, and must point back to the parent thread through `x-codex-parent-thread-id` and turn metadata. Think of it like checking envelopes in an office: the parent and child letters must have different sender IDs, and the child letter must say which parent office sent it. Without this test, a regression could make subagent calls look like ordinary parent calls, which would break tracing, routing, or billing decisions that depend on these headers.

#### Function details

##### `responses_api_parent_and_subagent_requests_include_identity_headers`  (lines 36–141)

```
async fn responses_api_parent_and_subagent_requests_include_identity_headers() -> Result<()>
```

**Purpose**: This is the main test. It proves that a parent Codex turn and the subagent it spawns send different, correct identity headers to the Responses API.

**Data flow**: It starts with fixed parent and child prompts, then creates a mock server that returns scripted streaming responses. It submits the parent prompt to a test Codex instance, waits for the parent and child HTTP requests to appear, reads their headers and bodies, splits the window IDs into thread IDs and generation numbers, and finally checks that the parent, child, and parent-link information are all correct. Its output is success if every assertion passes, or a test error if any expected request or header is missing or wrong.

**Call relations**: This function drives the whole test story. It calls the mock-server helpers to prepare fake API replies, uses `submit_turn_with_timeout` to make Codex run the prompt, uses `wait_for_matching_request` to find the captured parent and child requests, and uses `split_window_id` to understand the header format before making its final checks.

*Call graph*: calls 7 internal fn (mount_sse_once_match, sse, start_mock_server, test_codex, split_window_id, submit_turn_with_timeout, wait_for_matching_request); 7 external calls (assert!, assert_eq!, json!, from_str, to_string, skip_if_no_network!, vec!).


##### `submit_turn_with_timeout`  (lines 143–189)

```
async fn submit_turn_with_timeout(test: &TestCodex, prompt: &str) -> Result<()>
```

**Purpose**: This helper submits a user prompt into the test Codex session and waits until that turn starts and finishes. It keeps the main test from racing ahead before Codex has actually sent the requests being inspected.

**Data flow**: It receives a `TestCodex` session and a prompt string. It reads the test model and working directory, builds the permission and thread settings needed for a realistic local turn, submits the prompt as user input, then watches Codex events until it sees the matching turn start and complete. It returns success when the turn is done, or an error if submission or waiting fails.

**Call relations**: The main test calls this after the mock server is ready. Inside, it uses permission-selection helpers to shape the turn request and relies on `wait_for_event_result` twice: first to find the `TurnStarted` event, then to find the matching `TurnComplete` event.

*Call graph*: calls 4 internal fn (local_selections, turn_permission_fields, wait_for_event_result, workspace_write); called by 1 (responses_api_parent_and_subagent_requests_include_identity_headers); 3 external calls (default, unreachable!, vec!).


##### `wait_for_matching_request`  (lines 191–213)

```
async fn wait_for_matching_request(
    mock: &ResponseMock,
    label: &str,
    mut predicate: F,
) -> Result<ResponsesRequest>
```

**Purpose**: This helper waits for a mock API endpoint to receive a request that matches a condition chosen by the caller. It is used because the request may arrive asynchronously after Codex starts working.

**Data flow**: It receives a mock response recorder, a human-readable label for error messages, and a predicate function that says whether a request is the one wanted. It repeatedly looks through the recorded requests, sleeping briefly between checks, until one matches or the overall timeout expires. It returns the matching request, or an error saying which request it timed out waiting for.

**Call relations**: The main test calls this once for the parent request and once for the child request. It depends on the mock object’s recorded request list, and it gives the main test the concrete request data needed for header and body assertions.

*Call graph*: calls 1 internal fn (requests); called by 1 (responses_api_parent_and_subagent_requests_include_identity_headers); 2 external calls (sleep, timeout).


##### `wait_for_event_result`  (lines 215–240)

```
async fn wait_for_event_result(
    test: &TestCodex,
    stage: &str,
    mut predicate: F,
) -> Result<EventMsg>
```

**Purpose**: This helper waits for Codex to emit an event that matches a caller-provided condition. It also records short summaries of events it saw, so timeout errors are easier to understand.

**Data flow**: It receives a test Codex session, a stage name such as `turn started`, and a predicate function. It repeatedly asks Codex for the next event, stores a shortened text summary of each event, and returns the first event that satisfies the predicate. If no matching event arrives before the timeout, it returns an error that includes the events seen so far.

**Call relations**: `submit_turn_with_timeout` uses this helper to wait for the lifecycle events of a submitted turn. This function calls `event_summary` whenever it records an event for possible timeout diagnostics.

*Call graph*: calls 1 internal fn (event_summary); called by 1 (submit_turn_with_timeout); 2 external calls (new, timeout).


##### `event_summary`  (lines 242–246)

```
fn event_summary(event: &EventMsg) -> String
```

**Purpose**: This helper turns a Codex event into a short text snippet for error messages. It prevents timeout failures from dumping overly large event data.

**Data flow**: It receives an event, formats it as debug text, trims that text to 240 characters, and returns the shortened string. It does not change the event itself.

**Call relations**: `wait_for_event_result` calls this each time it sees an event while waiting. The summaries are only used if the wait times out, to help a developer understand what happened instead.

*Call graph*: called by 1 (wait_for_event_result); 1 external calls (format!).


##### `request_body_contains`  (lines 248–250)

```
fn request_body_contains(req: &wiremock::Request, text: &str) -> bool
```

**Purpose**: This small helper checks whether an incoming mock HTTP request body contains a given piece of text. It is used to recognize which fake server response should apply to which request.

**Data flow**: It receives a raw mock HTTP request and a search string. It tries to read the request body as UTF-8 text, which is the common text encoding used for JSON, then checks whether that text includes the search string. It returns `true` if the body is readable and contains the text, otherwise `false`.

**Call relations**: The mock-server matching closures use this helper when deciding whether a captured request is the parent prompt, the child prompt, or a follow-up parent request. It is a low-level check supporting the main test’s request routing.

*Call graph*: 1 external calls (from_utf8).


##### `request_header`  (lines 252–254)

```
fn request_header(req: &'a wiremock::Request, name: &str) -> Option<&'a str>
```

**Purpose**: This helper reads a named HTTP header from a mock request as plain text. It keeps the request-matching code simple and consistent.

**Data flow**: It receives a mock HTTP request and a header name. It looks up that header and tries to convert its value to a text string. It returns the header text if present and readable, or no value if the header is missing or cannot be read as text.

**Call relations**: The mock-server matching closures use this helper to distinguish parent requests from child subagent requests before returning the scripted fake responses. The main assertions later use a similar header-reading method on the recorded `ResponsesRequest` objects.


##### `split_window_id`  (lines 256–261)

```
fn split_window_id(window_id: &str) -> Result<(&str, u64)>
```

**Purpose**: This helper separates a `x-codex-window-id` header into its thread ID and generation number. The test needs that split to compare parent and child threads clearly.

**Data flow**: It receives a window ID string that is expected to look like `thread-id:generation`. It splits at the last colon, parses the part after the colon as a number, and returns the thread ID text plus the generation number. If the string is not in the expected shape or the generation is not a number, it returns an error.

**Call relations**: The main test calls this after it has captured the parent and child requests. The returned pieces let the test prove that both requests are generation zero, while also proving that the child has a different thread ID and correctly points back to the parent thread.

*Call graph*: called by 1 (responses_api_parent_and_subagent_requests_include_identity_headers).


### `core/tests/suite/quota_exceeded.rs`

`test` · `test run`

This is a focused automated test for a frustrating real-world case: the remote service says the account has run out of quota. Without this test, Codex might accidentally show the raw API wording, emit the same error more than once, or fail to finish the turn cleanly.

The test builds a fake server instead of calling the real API. That server sends a short stream of server-sent events, which are messages delivered over one open HTTP response, like updates arriving on a news ticker. First it says a response was created. Then it sends a failure with the API error code `insufficient_quota` and the billing-related message.

The test then starts a Codex instance connected to that fake server and submits a simple user prompt: “quota?”. It listens to the events Codex produces. Whenever Codex emits an error event, the test counts it and checks that the message has been rewritten into the friendlier text: “Quota exceeded. Check your plan and billing details.” The loop stops when Codex says the turn is complete.

The important behavior is the final check: exactly one error event must have appeared. This protects the user experience by making the quota problem clear, brief, and non-repetitive.

#### Function details

##### `quota_exceeded_emits_single_error_event`  (lines 16–77)

```
async fn quota_exceeded_emits_single_error_event() -> Result<()>
```

**Purpose**: This test proves that when the API reports `insufficient_quota`, Codex turns it into one user-facing error event with a clear billing message. It also checks that the turn still reaches completion afterward.

**Data flow**: The test starts by skipping itself if network-style testing is unavailable. It creates a mock server, programs that server to send a response-created event followed by a quota-failure event, then builds a Codex test instance pointed at that server. It sends a user input message into Codex, reads the events Codex emits, counts matching error events, checks the error text, and finally asserts that the count is exactly one.

**Call relations**: This function is the whole test scenario. It calls the test-support helpers to start the fake server, build the fake event stream, mount that stream as the server response, create a Codex test instance, and wait for outgoing Codex events. The assertions are the final judge: they confirm that the mocked API failure is translated into exactly one clean Codex error before the turn completes.

*Call graph*: calls 4 internal fn (mount_sse_once, sse, start_mock_server, test_codex); 5 external calls (default, assert_eq!, wait_for_event, skip_if_no_network!, vec!).


### `core/tests/suite/safety_check_downgrade.rs`

`test` · `test suite`

This is a test file. It checks a safety-sensitive path where Codex asks for one model, but the service may answer with a different model or extra safety metadata. In plain terms, it is making sure Codex notices when the server says, “I used a safer or different model because this looked risky,” and then reports that clearly to the rest of the app.

The tests use a mock server, which is a fake OpenAI-style server that returns carefully chosen responses. This lets the test control every detail: response headers, streamed response events, error bodies, tool calls, and model verification metadata. Each test sends a user turn with permissions disabled and approval set to never, so the focus stays on the model-safety behavior rather than sandbox or approval behavior.

The file checks several important cases. If the server returns a different model name, Codex should emit a model reroute event and a user-facing warning. If the server returns a cyber policy error, Codex should surface a typed cyber-policy error and not retry. If the only difference is letter casing, Codex should not warn. If the server sends structured model verification metadata, Codex should emit a structured verification event instead of turning that into a warning. Several tests also confirm these notices happen only once per user turn, even when the turn includes follow-up model calls.

#### Function details

##### `disabled_text_turn`  (lines 38–65)

```
fn disabled_text_turn(test: &TestCodex, text: &str) -> Op
```

**Purpose**: This helper builds a standard user message for these tests. It deliberately turns off sandbox permissions and automatic approval so each test can focus on model safety behavior, not tool permission behavior.

**Data flow**: It takes a test Codex instance and a text prompt. It reads the test working directory and config, builds the matching permission and environment settings, wraps the text as user input, and returns an operation that can be submitted to Codex.

**Call relations**: All the test cases call this helper before submitting input to Codex. It relies on support helpers to choose local environment settings and permission fields, so the individual tests do not have to repeat the same setup each time.

*Call graph*: calls 3 internal fn (cwd_path, local_selections, turn_permission_fields); called by 7 (cyber_policy_response_emits_typed_error_without_retry, model_verification_emits_structured_event_without_reroute_or_warning, model_verification_only_emits_once_per_turn, openai_model_header_casing_only_mismatch_does_not_warn, openai_model_header_mismatch_emits_warning_event, openai_model_header_mismatch_only_emits_one_warning_per_turn, response_model_field_mismatch_emits_warning_when_header_matches_requested); 2 external calls (default, vec!).


##### `openai_model_header_mismatch_emits_warning_event`  (lines 68–107)

```
async fn openai_model_header_mismatch_emits_warning_event() -> Result<()>
```

**Purpose**: This test checks that Codex warns when the server response header says a different model was used than the one the user requested. This matters because a model change due to safety routing should be visible, not silent.

**Data flow**: The test starts a mock server, configures it to return a completed response with an OpenAI-Model header naming the server model, then submits a user turn requesting another model. It waits for Codex events and confirms that a model reroute event names both models and that a warning message mentions both of them before the turn completes.

**Call relations**: It uses the shared user-turn helper to send the prompt. It depends on the mock response helpers to simulate the server-side model change, then uses event waiting to observe Codex’s public behavior.

*Call graph*: calls 6 internal fn (mount_response_once, sse_completed, sse_response, start_mock_server, test_codex, disabled_text_turn); 5 external calls (assert!, assert_eq!, wait_for_event, panic!, skip_if_no_network!).


##### `cyber_policy_response_emits_typed_error_without_retry`  (lines 110–141)

```
async fn cyber_policy_response_emits_typed_error_without_retry() -> Result<()>
```

**Purpose**: This test checks that a server-side cyber policy rejection becomes a specific cyber-policy error inside Codex. It also verifies Codex does not retry the same blocked request.

**Data flow**: The test creates a mock HTTP 400 response whose error code is cyber_policy and whose message is the cyber policy warning text. After submitting a user turn, it waits for an error event, checks that the message is preserved, checks that the structured error type is CyberPolicy, and confirms the mock server saw only one request.

**Call relations**: It uses the same test Codex setup and input helper as the other tests. Instead of a streamed successful response, it mounts a one-time error response and checks that Codex stops there rather than handing off to retry logic.

*Call graph*: calls 4 internal fn (mount_response_once, start_mock_server, test_codex, disabled_text_turn); 6 external calls (new, assert_eq!, wait_for_event, panic!, json!, skip_if_no_network!).


##### `response_model_field_mismatch_emits_warning_when_header_matches_requested`  (lines 144–203)

```
async fn response_model_field_mismatch_emits_warning_when_header_matches_requested() -> Result<()>
```

**Purpose**: This test checks a subtler downgrade signal: the outer HTTP header matches the requested model, but the streamed response metadata says a different model was used. Codex should still notice and warn.

**Data flow**: The test prepares a streamed response where the HTTP OpenAI-Model header says the requested model, but the response.created event contains a header naming the server model. After submitting the turn, it waits for a reroute event, verifies the old and new model names and safety reason, then waits for a warning that explains the high-risk cyber activity downgrade.

**Call relations**: It combines mock streaming helpers with the common input helper. It exercises the same event path as the plain header mismatch test, but proves Codex also inspects model information embedded inside the streamed response.

*Call graph*: calls 6 internal fn (mount_response_once, sse, sse_response, start_mock_server, test_codex, disabled_text_turn); 6 external calls (assert!, assert_eq!, wait_for_event, panic!, skip_if_no_network!, vec!).


##### `openai_model_header_mismatch_only_emits_one_warning_per_turn`  (lines 206–255)

```
async fn openai_model_header_mismatch_only_emits_one_warning_per_turn() -> Result<()>
```

**Purpose**: This test makes sure Codex does not spam duplicate downgrade warnings during one user turn. Even if the turn causes more than one model response, the user should only see one warning for the same safety downgrade.

**Data flow**: The test configures two server responses. The first response requests a shell command, causing Codex to make a follow-up model call; both responses carry the mismatched server model header. The test watches all events until the turn completes, counts warnings that mention the requested model, and expects exactly one.

**Call relations**: It uses a sequence of mock responses to mimic a multi-step turn. The first response hands off to tool-call behavior, which leads to the second response; the test then confirms the warning logic is remembered across those internal steps.

*Call graph*: calls 6 internal fn (mount_response_sequence, sse, sse_response, start_mock_server, test_codex, disabled_text_turn); 5 external calls (assert_eq!, wait_for_event, json!, skip_if_no_network!, vec!).


##### `openai_model_header_casing_only_mismatch_does_not_warn`  (lines 258–296)

```
async fn openai_model_header_casing_only_mismatch_does_not_warn() -> Result<()>
```

**Purpose**: This test checks that Codex treats model names as the same when they differ only by uppercase or lowercase letters. That prevents false safety warnings caused by harmless formatting differences.

**Data flow**: The test sends a response whose OpenAI-Model header is the requested model converted to uppercase. It submits a user turn, then counts model reroute and high-risk warning events until the turn completes. Both counts must stay at zero.

**Call relations**: It uses the same mock server and input helper as the mismatch tests, but changes only the casing of the model name. This protects the reroute detection code from being too strict about text formatting.

*Call graph*: calls 6 internal fn (mount_response_once, sse_completed, sse_response, start_mock_server, test_codex, disabled_text_turn); 3 external calls (assert_eq!, wait_for_event, skip_if_no_network!).


##### `model_verification_emits_structured_event_without_reroute_or_warning`  (lines 299–356)

```
async fn model_verification_emits_structured_event_without_reroute_or_warning() -> Result<()>
```

**Purpose**: This test checks that explicit model verification metadata is reported as a structured verification event, not as a downgrade warning. In other words, verified trusted access is treated as a positive signal, not a problem.

**Data flow**: The mock server streams a normal response plus model verification metadata saying trusted access for cyber is present. The test submits a user turn, watches events until completion, and confirms exactly one ModelVerification event with the expected value. It also confirms there are no reroute events, no warning events, and no hidden warning text inserted into raw response items.

**Call relations**: It uses mock streamed metadata to exercise Codex’s verification-event path. It checks that this path stays separate from the downgrade-warning path tested earlier in the file.

*Call graph*: calls 6 internal fn (mount_response_once, sse, sse_response, start_mock_server, test_codex, disabled_text_turn); 5 external calls (assert_eq!, wait_for_event, matches!, skip_if_no_network!, vec!).


##### `model_verification_only_emits_once_per_turn`  (lines 359–412)

```
async fn model_verification_only_emits_once_per_turn() -> Result<()>
```

**Purpose**: This test makes sure model verification is announced only once during a single user turn. If a tool call causes Codex to ask the model again, repeated verification metadata should not create repeated events.

**Data flow**: The test prepares two streamed responses, both containing the same trusted-access verification metadata. The first response also asks for a shell command, which causes a follow-up model response. The test counts ModelVerification events until the turn completes and expects one; it also fails immediately if a high-risk cyber warning appears.

**Call relations**: It mirrors the duplicate-warning test, but for structured verification metadata. The response sequence drives a multi-step turn, and the event loop confirms Codex remembers that it already reported verification for that turn.

*Call graph*: calls 6 internal fn (mount_response_sequence, sse, sse_response, start_mock_server, test_codex, disabled_text_turn); 6 external calls (assert_eq!, wait_for_event, panic!, json!, skip_if_no_network!, vec!).
